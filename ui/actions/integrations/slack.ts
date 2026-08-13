"use server";

import { revalidatePath } from "next/cache";

import { pollTaskUntilSettled } from "@/actions/task/poll";
import { apiBaseUrl, getAuthHeaders, parseStringify } from "@/lib";
import {
  readSlackFailure,
  slackErrorMessage,
  slackRateLimitMessage,
} from "@/lib/integrations/slack-errors";
import { handleApiError } from "@/lib/server-actions-helper";
import type {
  IntegrationProps,
  SlackChannelOption,
} from "@/types/integrations";

/**
 * The two OAuth calls the Slack install needs. Everything else — reading the
 * integration, testing the connection, deleting it — goes through the generic
 * integration actions, because Slack rows are plain `integrations` resources.
 *
 * The Slack app (`SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` /
 * `SLACK_REDIRECT_URI`) is a deployment-wide setting, so both endpoints answer
 * `503` until it is configured, and a deployment that serves no Slack API at
 * all answers `404`. Neither is an error the user can act on: both mean "Slack
 * isn't available in this environment yet", which is why they get their own
 * result shape rather than an error string.
 *
 * Rate limiting is a third answer again — Slack is there, the deployment is
 * configured, and the only thing to do is wait — so it gets its own outcome
 * rather than being folded into either of the other two.
 *
 * The OAuth `state` is minted and consumed by the API, bound to the tenant and
 * the user — the UI never inspects it, it only forwards what Slack sent back.
 */

interface SlackUnavailable {
  unavailable: true;
}

/**
 * Slack is rate limiting Prowler (`429`). Distinct from `SlackUnavailable`: the
 * Slack app exists and works, so the page keeps offering what it offers and
 * only says when to come back.
 */
interface SlackRateLimited {
  rateLimited: true;
  /** What `Retry-After` asked for, when the response carried one. */
  retryAfterSeconds: number | null;
  /** The wait, as copy — so every caller says the same thing about it. */
  message: string;
}

interface SlackActionError {
  error: string;
}

interface SlackAuthorizeUrl {
  authorizeUrl: string;
}

export type SlackAuthorizeUrlResult =
  | SlackAuthorizeUrl
  | SlackUnavailable
  | SlackRateLimited
  | SlackActionError;

interface SlackExchangeInput {
  code: string;
  state: string;
}

interface SlackExchangeSuccess {
  integration: IntegrationProps;
}

export type SlackExchangeResult =
  | SlackExchangeSuccess
  | SlackUnavailable
  | SlackRateLimited
  | SlackActionError;

/**
 * Whether the deployment answered "no Slack app here". Deliberately narrow:
 * widening it to a status that only means "not right now" (a `429`, an upstream
 * `502`) would tell the user Slack is unavailable in their environment when it
 * is Prowler's call that needs retrying.
 */
const isUnavailableStatus = (status: number): boolean =>
  status === 503 || status === 404;

const RATE_LIMITED_STATUS = 429;

/**
 * Classify a refusal into the outcome the UI acts on.
 *
 * The reason travels in the JSON:API error's `code`, which
 * `slackErrorMessage` maps to copy Prowler owns; `detail` is the API's own
 * human wording and is used only when the code is one this UI has nothing
 * better to say about. `fallback` covers a refusal that carries neither.
 */
const failureFrom = async (
  response: Response,
  fallback: string,
): Promise<SlackUnavailable | SlackRateLimited | SlackActionError> => {
  if (isUnavailableStatus(response.status)) return { unavailable: true };

  const failure = await readSlackFailure(response);

  if (failure.status === RATE_LIMITED_STATUS) {
    return {
      rateLimited: true,
      retryAfterSeconds: failure.retryAfterSeconds,
      message: slackRateLimitMessage(failure.retryAfterSeconds),
    };
  }

  return { error: slackErrorMessage(failure, fallback) };
};

/**
 * The same classification flattened to one line of copy, for the calls whose
 * only outcome is "it did not work": the code's own wording when Prowler has
 * one, the API's `detail` when it does not, and `fallback` when neither.
 */
const errorMessageFrom = async (
  response: Response,
  fallback: string,
): Promise<string> =>
  slackErrorMessage(await readSlackFailure(response), fallback);

/**
 * Mint an OAuth state and get the consent URL to send the user to. Creates no
 * integration: the install only exists once the exchange completes.
 */
export const getSlackAuthorizeUrl =
  async (): Promise<SlackAuthorizeUrlResult> => {
    const headers = await getAuthHeaders({ contentType: true });
    const url = new URL(`${apiBaseUrl}/integrations/slack/oauth/authorize-url`);

    try {
      const response = await fetch(url.toString(), { method: "POST", headers });

      if (!response.ok) {
        return failureFrom(
          response,
          `Unable to start the Slack install: ${response.statusText}`,
        );
      }

      // The URL travels in JSON:API `meta` — the call creates no resource.
      const body = await response.json();
      const authorizeUrl = body?.meta?.authorize_url;

      if (typeof authorizeUrl !== "string" || authorizeUrl.length === 0) {
        return { error: "Slack did not return an authorization URL." };
      }

      return { authorizeUrl };
    } catch (error) {
      return handleApiError(error);
    }
  };

/**
 * Complete the install with what Slack put in the callback URL. The API
 * validates and consumes the `state`, exchanges the single-use `code`, and
 * upserts the tenant's Slack integration.
 */
export const exchangeSlackOAuthCode = async ({
  code,
  state,
}: SlackExchangeInput): Promise<SlackExchangeResult> => {
  const headers = await getAuthHeaders({ contentType: true });
  const url = new URL(`${apiBaseUrl}/integrations/slack/oauth/exchange`);

  try {
    const response = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        data: {
          type: "slack-oauth-exchanges",
          attributes: { code, state },
        },
      }),
    });

    if (!response.ok) {
      // A refused state and a code Slack rejected arrive as a `400` whose
      // `detail` is the reason to show. "A different workspace is already
      // connected" is a `409` named by its `code`, which is what turns it into
      // copy that says how to get out of it.
      return failureFrom(
        response,
        `Unable to connect the Slack workspace: ${response.statusText}`,
      );
    }

    const body = await response.json();

    revalidatePath("/integrations");
    revalidatePath("/integrations/slack");

    return { integration: parseStringify(body.data) as IntegrationProps };
  } catch (error) {
    return handleApiError(error);
  }
};

interface SlackChannelsSuccess {
  channels: SlackChannelOption[];
}

export type SlackChannelsResult = SlackChannelsSuccess | SlackActionError;

/**
 * Cursor pages followed before giving up. `conversations.list` is a tier-2,
 * rate-limited Slack call (design.md, Risks), so the aggregation is bounded
 * rather than open-ended: a workspace larger than this shows the channels of
 * the pages that were read, which is a far better failure than hammering Slack
 * behind a picker the user is waiting on.
 */
const MAX_CHANNEL_PAGES = 20;

/**
 * Every channel Prowler can post to in the connected workspace — the picker's
 * options.
 *
 * This is the durable primitive, not the channel stored on the integration
 * (design D6): a consumer that needs a different channel per alert rule reads
 * the same endpoint. The list is cursor-paginated, and `links.next` is followed
 * opaquely — the contract deliberately does not pin the parameter naming, so
 * the UI never constructs a cursor of its own.
 */
export const getSlackChannels = async (
  integrationId: string,
): Promise<SlackChannelsResult> => {
  const headers = await getAuthHeaders({ contentType: false });
  const channels: SlackChannelOption[] = [];

  let next: string | null = new URL(
    `${apiBaseUrl}/integrations/${integrationId}/slack/channels`,
  ).toString();

  try {
    for (let page = 0; next && page < MAX_CHANNEL_PAGES; page += 1) {
      const response: Response = await fetch(next, { method: "GET", headers });

      if (!response.ok) {
        return {
          error: await errorMessageFrom(
            response,
            `Unable to read the workspace's channels: ${response.statusText}`,
          ),
        };
      }

      const body = await response.json();

      for (const resource of body?.data ?? []) {
        channels.push({
          id: resource?.id,
          name: resource?.attributes?.name ?? "",
          is_private: Boolean(resource?.attributes?.is_private),
        });
      }

      const rawNext = body?.links?.next;
      // Resolved against the API base so a relative `next` works too — the
      // link is opaque, not necessarily absolute.
      next =
        typeof rawNext === "string" && rawNext.length > 0
          ? new URL(rawNext, `${apiBaseUrl}/`).toString()
          : null;
    }

    return { channels };
  } catch (error) {
    return handleApiError(error);
  }
};

interface SlackTestMessageSuccess {
  sent: true;
}

export type SlackTestMessageResult = SlackTestMessageSuccess | SlackActionError;

/** What the test-message task carries once it settles. */
interface SlackTestMessageTaskResult {
  error?: string | null;
}

const TEST_MESSAGE_POLL = { maxAttempts: 20, delayMs: 3000 } as const;

/**
 * Post the test message to the integration's default channel.
 *
 * Async on the API's side — `202` plus a Task (design D9) — so this polls the
 * same task machinery the connection test uses instead of introducing a
 * synchronous path. A `400` means no default channel is recorded, which the UI
 * prevents by only offering the action once one is.
 */
export const sendSlackTestMessage = async (
  integrationId: string,
): Promise<SlackTestMessageResult> => {
  const headers = await getAuthHeaders({ contentType: true });
  const url = new URL(
    `${apiBaseUrl}/integrations/${integrationId}/slack/test-message`,
  );

  try {
    const response = await fetch(url.toString(), { method: "POST", headers });

    if (!response.ok) {
      return {
        error: await errorMessageFrom(
          response,
          `Unable to send the test message: ${response.statusText}`,
        ),
      };
    }

    const body = await response.json();
    const taskId = body?.data?.id;

    if (!taskId) {
      return { error: "Slack did not start the test message." };
    }

    const settled = await pollTaskUntilSettled<SlackTestMessageTaskResult>(
      taskId,
      TEST_MESSAGE_POLL,
    );

    if (!settled.ok) {
      return { error: settled.error };
    }

    // Slack's refusal travels in the task result; a task that did not complete
    // is a failure even when it carries no reason of its own.
    const reason = settled.result?.error;
    if (reason) {
      return { error: reason };
    }
    if (settled.state !== "completed") {
      return { error: "Slack did not accept the test message." };
    }

    return { sent: true };
  } catch (error) {
    return handleApiError(error);
  }
};
