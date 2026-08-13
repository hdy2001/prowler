/**
 * MSW handlers for the Slack integration, derived from the API contract in
 * `openspec/changes/add-slack-integration/design.md`.
 *
 * The Slack API is implemented in the cloud repository, so these handlers are
 * the UI lane's only view of it: they are what the browser-mode tests run
 * against, and drift between them and the deployed backend is a contract
 * conversation, not a local fix.
 *
 * State is per-call: an exchange really does create the install the subsequent
 * `GET /integrations` returns, so a test can drive connect → read without
 * hand-seeding the result.
 *
 * Wire them per test via `worker.use(...handlersForSlack(fx))`.
 */

import { http, HttpResponse } from "msw";

import {
  SLACK_AUTHORIZE_URL,
  SLACK_DIFFERENT_WORKSPACE_DETAIL,
  SLACK_EXCHANGE_OUTCOME,
  SLACK_INTEGRATION_ID,
  SLACK_INVALID_CODE_DETAIL,
  SLACK_NO_CHANNEL_DETAIL,
  SLACK_NO_DEFAULT_CHANNEL_DETAIL,
  SLACK_RATE_LIMITED_REFUSAL,
  SLACK_REFUSED_STATE_DETAIL,
  SLACK_UNCONFIGURED_DETAIL,
  SLACK_UNKNOWN_CHANNEL_DETAIL,
  SLACK_WORKSPACE_CONFLICT_CODE,
} from "./slack.fixtures";
import type {
  SlackFixture,
  SlackInstallFixture,
  SlackRefusalFixture,
} from "./slack.fixtures";

const API = process.env.UI_API_BASE_URL;
const TS = "2026-08-10T09:00:00Z";

const CONNECTION_TASK_PREFIX = "slack-conn-task-";
const TEST_MESSAGE_TASK_PREFIX = "slack-test-message-task-";

/** Opaque to the UI, which only ever follows `links.next` (design D6). */
const CHANNEL_CURSOR_PARAM = "page[cursor]";

/**
 * A JSON:API error as the Slack endpoints raise it.
 *
 * `code` is the machine-readable reason the UI maps; `detail` is human copy.
 * `status` is a string, per the spec. `source.pointer` is `/data` even when the
 * API raised a field-shaped `ValidationError` — the errors are about the
 * request, not about one attribute of it.
 */
const errorBody = (detail: string, status: number, code?: string) => ({
  errors: [
    {
      status: String(status),
      ...(code ? { code } : {}),
      detail,
      source: { pointer: "/data" },
    },
  ],
});

/**
 * Answer a fixture's refusal exactly as the API would: its own status, its
 * `code` when it names one, and `Retry-After` only where the status carries a
 * wait. A consumer that reads any of the three gets the real thing.
 */
const refuse = (refusal: SlackRefusalFixture) =>
  HttpResponse.json(
    errorBody(refusal.detail, refusal.status, refusal.code ?? undefined),
    {
      status: refusal.status,
      ...(refusal.retryAfterSeconds === null
        ? {}
        : { headers: { "Retry-After": String(refusal.retryAfterSeconds) } }),
    },
  );

const configuration = (workspace: SlackInstallFixture["workspace"]) => ({
  team_id: workspace.teamId,
  team_name: workspace.teamName,
  bot_user_id: workspace.botUserId,
  // Absent until a channel is chosen — the API omits the keys rather than
  // serializing nulls, so a consumer that reads `null` as "not chosen" would
  // be reading a value that never arrives.
  ...(workspace.channelId ? { channel_id: workspace.channelId } : {}),
  ...(workspace.channelName ? { channel_name: workspace.channelName } : {}),
});

const integrationResource = (install: SlackInstallFixture) => ({
  id: install.id,
  type: "integrations",
  attributes: {
    inserted_at: TS,
    updated_at: TS,
    enabled: true,
    connected: install.connected,
    connection_last_checked_at: install.connectionLastCheckedAt,
    integration_type: "slack",
    // No credentials: the bot token is encrypted at rest and never serialized.
    // The configuration carries server-owned keys the UI does not send.
    configuration: configuration(install.workspace),
  },
  links: { self: `${API}/integrations/${install.id}` },
});

const collection = (install: SlackInstallFixture | null) => ({
  data: install ? [integrationResource(install)] : [],
  meta: {
    version: "v1",
    pagination: {
      page: 1,
      pages: 1,
      count: install ? 1 : 0,
    },
  },
});

const taskResource = (id: string, state: string, result: unknown) => ({
  data: { id, type: "tasks", attributes: { state, result } },
});

export const handlersForSlack = (fx: SlackFixture) => {
  // Mutable working copy: the exchange creates or updates the install the
  // integration reads see afterwards.
  let install: SlackInstallFixture | null = fx.install
    ? { ...fx.install, workspace: { ...fx.install.workspace } }
    : null;

  const unconfigured = () =>
    HttpResponse.json(errorBody(SLACK_UNCONFIGURED_DETAIL, 503), {
      status: 503,
    });

  /**
   * Slack's own rate limit, surfaced as a `429` carrying `Retry-After`. It is
   * neither a refusal the user can act on nor "no Slack app here", so it names
   * no `code`: the status is the whole reason.
   */
  const rateLimited = () => refuse(SLACK_RATE_LIMITED_REFUSAL);

  return [
    // --- OAuth ------------------------------------------------------------
    http.post(`${API}/integrations/slack/oauth/authorize-url`, () => {
      if (!fx.appConfigured) return unconfigured();
      if (fx.rateLimited) return rateLimited();
      // The URL travels in `meta`; the call creates nothing.
      return HttpResponse.json({
        meta: { authorize_url: SLACK_AUTHORIZE_URL },
      });
    }),

    http.post(`${API}/integrations/slack/oauth/exchange`, () => {
      if (!fx.appConfigured) return unconfigured();
      if (fx.rateLimited) return rateLimited();

      switch (fx.exchangeOutcome) {
        case SLACK_EXCHANGE_OUTCOME.REFUSED_STATE:
          return HttpResponse.json(errorBody(SLACK_REFUSED_STATE_DETAIL, 400), {
            status: 400,
          });
        case SLACK_EXCHANGE_OUTCOME.SLACK_REFUSED:
          return HttpResponse.json(errorBody(SLACK_INVALID_CODE_DETAIL, 400), {
            status: 400,
          });
        case SLACK_EXCHANGE_OUTCOME.DIFFERENT_WORKSPACE:
          // A conflict with what the tenant already has, not a bad request:
          // `409`, named by its `code` so the UI can say which conflict it is.
          return HttpResponse.json(
            errorBody(
              SLACK_DIFFERENT_WORKSPACE_DETAIL,
              409,
              SLACK_WORKSPACE_CONFLICT_CODE,
            ),
            { status: 409 },
          );
        case SLACK_EXCHANGE_OUTCOME.REINSTALLED:
          // Same workspace: the credential is replaced on the row that exists,
          // so the tenant still holds exactly one Slack integration.
          install = {
            id: install?.id ?? SLACK_INTEGRATION_ID,
            connected: null,
            connectionLastCheckedAt: null,
            workspace: { ...fx.exchangeWorkspace },
          };
          return HttpResponse.json({ data: integrationResource(install) });
        default:
          install = {
            id: SLACK_INTEGRATION_ID,
            connected: null,
            connectionLastCheckedAt: null,
            workspace: { ...fx.exchangeWorkspace },
          };
          return HttpResponse.json(
            { data: integrationResource(install) },
            { status: 201 },
          );
      }
    }),

    // --- Generic integration endpoints the Slack UI reuses -----------------
    http.get(`${API}/integrations`, ({ request }) => {
      const type = new URL(request.url).searchParams.get(
        "filter[integration_type]",
      );
      // An unfiltered read would pull every integration type into the Slack
      // page, so serve the install only for the filter it actually sends.
      return HttpResponse.json(collection(type === "slack" ? install : null));
    }),

    http.post<{ id: string }>(
      `${API}/integrations/:id/connection`,
      ({ params }) => {
        // The check posts to the integration's channel, so there is nothing to
        // check until one is recorded: the API refuses rather than reporting a
        // connection it never tested.
        if (!install?.workspace.channelId) {
          return HttpResponse.json(errorBody(SLACK_NO_CHANNEL_DETAIL, 400), {
            status: 400,
          });
        }

        return HttpResponse.json(
          taskResource(
            `${CONNECTION_TASK_PREFIX}${params.id}`,
            "executing",
            null,
          ),
          { status: 202 },
        );
      },
    ),

    http.get<{ taskId: string }>(`${API}/tasks/:taskId`, ({ params }) => {
      // The test message settles as its own task (design D9), reporting only
      // whether Slack accepted the post.
      if (params.taskId.startsWith(TEST_MESSAGE_TASK_PREFIX)) {
        const { accepted, error } = fx.testMessage;
        return HttpResponse.json(
          taskResource(params.taskId, accepted ? "completed" : "failed", {
            error,
          }),
        );
      }

      const { connected, error } = fx.connection;
      if (install && params.taskId.startsWith(CONNECTION_TASK_PREFIX)) {
        install.connected = connected;
        install.connectionLastCheckedAt = TS;
      }
      return HttpResponse.json(
        taskResource(params.taskId, "completed", { connected, error }),
      );
    }),

    // --- Channels ----------------------------------------------------------
    http.get<{ id: string }>(
      `${API}/integrations/:id/slack/channels`,
      ({ params, request }) => {
        // A refusal named for this endpoint wins over the fixture's blanket
        // rate limiting, which is the coarser switch of the two.
        if (fx.channelsRefusal) return refuse(fx.channelsRefusal);
        if (fx.rateLimited) return rateLimited();

        // Cursor pagination: the UI follows `links.next` opaquely, so the
        // cursor's shape is this fixture's business alone.
        const cursor = Number(
          new URL(request.url).searchParams.get(CHANNEL_CURSOR_PARAM) ?? "0",
        );
        const nextCursor = cursor + fx.channelsPageSize;
        const page = fx.channels.slice(cursor, nextCursor);
        const hasMore = nextCursor < fx.channels.length;

        return HttpResponse.json({
          data: page.map((channel) => ({
            type: "slack-channels",
            id: channel.id,
            attributes: { name: channel.name, is_private: channel.isPrivate },
          })),
          links: {
            next: hasMore
              ? `${API}/integrations/${params.id}/slack/channels` +
                `?${CHANNEL_CURSOR_PARAM}=${nextCursor}`
              : null,
          },
        });
      },
    ),

    /**
     * The generic PATCH, recording the default channel. The UI submits only
     * `channel_id`; the name here is derived from the channel the id resolves
     * to, exactly as the API derives it from Slack (design D6).
     */
    http.patch(`${API}/integrations/:id`, async ({ request }) => {
      const body = (await request.json().catch(() => null)) as {
        data?: { attributes?: { configuration?: { channel_id?: string } } };
      } | null;
      const channelId = body?.data?.attributes?.configuration?.channel_id;
      const channel = fx.channels.find((c) => c.id === channelId);

      if (!install) {
        return HttpResponse.json(errorBody("Not found.", 404), { status: 404 });
      }
      // Slack refused the channel while the API validated it: the id resolves
      // to a channel the picker offered, and Slack still says no.
      if (fx.channelSaveRefusal) return refuse(fx.channelSaveRefusal);
      if (!channel) {
        return HttpResponse.json(errorBody(SLACK_UNKNOWN_CHANNEL_DETAIL, 400), {
          status: 400,
        });
      }

      install.workspace.channelId = channel.id;
      install.workspace.channelName = channel.name;
      return HttpResponse.json({ data: integrationResource(install) });
    }),

    // --- Test message ------------------------------------------------------
    http.post<{ id: string }>(
      `${API}/integrations/:id/slack/test-message`,
      ({ params }) => {
        if (!install?.workspace.channelId) {
          return HttpResponse.json(
            errorBody(SLACK_NO_DEFAULT_CHANNEL_DETAIL, 400),
            { status: 400 },
          );
        }
        return HttpResponse.json(
          taskResource(
            `${TEST_MESSAGE_TASK_PREFIX}${params.id}`,
            "available",
            null,
          ),
          { status: 202 },
        );
      },
    ),

    // Disconnect. Revocation at Slack is best-effort: the row is removed either
    // way and the outcome is reported in `meta`, so the UI can tell the user
    // when access still has to be removed by hand in the workspace.
    //
    // `revoked` is the entire outcome. The API sends no reason for a revocation
    // that failed, and a handler that invented one would let the page grow copy
    // around a field the deployment never sends.
    http.delete(`${API}/integrations/:id`, () => {
      install = null;
      return HttpResponse.json({ meta: { revoked: fx.revocation.revoked } });
    }),
  ];
};
