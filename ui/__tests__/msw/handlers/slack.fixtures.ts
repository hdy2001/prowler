/**
 * Fixture data for the Slack integration handlers.
 *
 * A fixture describes a world — "this deployment has no Slack app", "this
 * tenant already connected Prowler HQ", "the exchange will be refused" — and
 * `handlersForSlack` serves it. The shapes are derived from the API contract in
 * `openspec/changes/add-slack-integration/design.md`; that contract, not this
 * file, is where a disagreement with the deployed backend gets settled.
 */

export interface SlackWorkspaceFixture {
  teamId: string;
  teamName: string;
  /** The bot the install created, which the API keeps on the configuration. */
  botUserId: string;
  /**
   * The integration's default destination. Both keys are *absent* from the
   * serialized configuration until a channel is chosen — the API omits them
   * rather than sending nulls — so they are optional here for the same reason.
   */
  channelId?: string;
  channelName?: string;
}

export interface SlackInstallFixture {
  id: string;
  /** `null` until the first connection check runs, as the API upserts it. */
  connected: boolean | null;
  connectionLastCheckedAt: string | null;
  workspace: SlackWorkspaceFixture;
}

export const SLACK_EXCHANGE_OUTCOME = {
  /** First install for the tenant: the exchange creates the integration. */
  CREATED: "created",
  /** The same workspace re-installed: the existing row keeps its id. */
  REINSTALLED: "reinstalled",
  /** The API could not match the `state` it minted, so it refuses. */
  REFUSED_STATE: "refused-state",
  /** Slack itself rejected the code, so the API refuses the completion. */
  SLACK_REFUSED: "slack-refused",
  /**
   * A different workspace is already connected — one per tenant. A `409`,
   * named by its `code`, not a plain refusal.
   */
  DIFFERENT_WORKSPACE: "different-workspace",
} as const;

export type SlackExchangeOutcome =
  (typeof SLACK_EXCHANGE_OUTCOME)[keyof typeof SLACK_EXCHANGE_OUTCOME];

export interface SlackConnectionFixture {
  connected: boolean;
  error: string | null;
}

/** A channel the listing endpoint offers for the picker. */
export interface SlackChannelFixture {
  id: string;
  name: string;
  /** Private channels are listed only where `@Prowler` has been invited. */
  isPrivate: boolean;
}

export interface SlackTestMessageFixture {
  /** Slack accepted the post. */
  accepted: boolean;
  /**
   * The reason the settled task carries when it did not. The contract asks the
   * task to report the same stable reason the synchronous endpoints put in
   * `code`, but leaves the result's shape to the cloud lane — so this models
   * both what it should carry (a reason token) and what it might (prose).
   */
  error: string | null;
}

/**
 * A refusal as the API sends one: the machine-readable reason in `code`, human
 * copy in `detail`, and — for a `429` — the wait in `Retry-After`.
 *
 * All three travel together because that is what makes a test honest: a client
 * that switched on `detail` would pass against a fixture carrying only `code`,
 * and one that ignored `Retry-After` would pass against a `429` without it.
 */
export interface SlackRefusalFixture {
  status: number;
  /** Slack's stable reason. `null` for the failures classified by status. */
  code: string | null;
  detail: string;
  /** Seconds `Retry-After` asked for; only a `429` carries one. */
  retryAfterSeconds: number | null;
}

export interface SlackFixture {
  /**
   * The deployment has `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` /
   * `SLACK_REDIRECT_URI`. Without them every Slack OAuth call answers 503.
   */
  appConfigured: boolean;
  /** The workspace this tenant has already connected, if any. */
  install: SlackInstallFixture | null;
  /** The workspace an exchange connects. */
  exchangeWorkspace: SlackWorkspaceFixture;
  exchangeOutcome: SlackExchangeOutcome;
  /** What a connection check reports. */
  connection: SlackConnectionFixture;
  /**
   * Slack is rate limiting Prowler: the Slack OAuth calls answer `429` with a
   * `Retry-After`, whatever else the fixture says. Handlers added for other
   * Slack-backed endpoints answer the same way.
   */
  rateLimited: boolean;
  /** Every channel the connected workspace exposes to Prowler. */
  channels: SlackChannelFixture[];
  /**
   * Channels per cursor page. Small on purpose: the default workspace spans
   * two pages, so a UI that stopped at `data` instead of following `links.next`
   * would visibly lose channels.
   */
  channelsPageSize: number;
  /** Slack refused the listing outright, with the reason named in `code`. */
  channelsRefusal: SlackRefusalFixture | null;
  /**
   * Slack refused the channel the user chose, when the `PATCH` validated it.
   * Distinct from a listing refusal: the workspace answered the picker fine and
   * it is the destination itself that cannot be used.
   */
  channelSaveRefusal: SlackRefusalFixture | null;
  /** What the test-message task settles as. */
  testMessage: SlackTestMessageFixture;
}

export const SLACK_INTEGRATION_ID = "slack-integration-1";

/** Exactly the scopes D2 justifies — the picker and the posting need no more. */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  "chat:write.public",
  "channels:read",
  "groups:read",
] as const;

export const SLACK_REDIRECT_URI =
  "https://cloud.prowler.com/integrations/slack/callback";

/** Server-minted, single-use, bound to the tenant and user (design D5). */
export const SLACK_OAUTH_STATE = "st-2f1c9d7a";
export const SLACK_OAUTH_CODE = "slack-code-1f4a";

/** The consent URL the API returns, with the state already inside it. */
export const SLACK_AUTHORIZE_URL =
  "https://slack.com/oauth/v2/authorize" +
  "?client_id=1234567890.0987654321" +
  `&scope=${encodeURIComponent(SLACK_BOT_SCOPES.join(","))}` +
  `&state=${SLACK_OAUTH_STATE}` +
  `&redirect_uri=${encodeURIComponent(SLACK_REDIRECT_URI)}`;

/**
 * The `detail` strings the implementation actually sends. They are human copy,
 * not the machine-readable reason: that travels in `code`, which is what the UI
 * maps. Keeping the real wording here is what makes a test that reads `detail`
 * (an unmapped refusal) honest.
 */
export const SLACK_UNCONFIGURED_DETAIL =
  "Slack integration is not configured or temporarily unavailable.";
export const SLACK_REFUSED_STATE_DETAIL =
  "OAuth state is invalid, expired, or already consumed.";
export const SLACK_INVALID_CODE_DETAIL = "The Slack OAuth code is invalid.";
export const SLACK_DIFFERENT_WORKSPACE_DETAIL =
  "This tenant is already connected to a different Slack workspace.";
export const SLACK_UPSTREAM_DETAIL = "Slack is temporarily unavailable.";
/**
 * Raised as a service-level `ValidationError({"channel_id": ...})`, which still
 * points at `/data` rather than at the attribute.
 */
export const SLACK_NO_CHANNEL_DETAIL =
  "This Slack integration has no channel configured.";
export const SLACK_RATE_LIMITED_DETAIL =
  "Slack is rate limiting requests from Prowler.";
export const SLACK_MISSING_SCOPE_DETAIL =
  "Slack refused the request: missing_scope.";
/**
 * Sent for a channel that cannot be used, whichever way it cannot: the same
 * sentence for "it is gone" and for "the app was removed from it". Only `code`
 * separates them, which is the whole reason a client must read `code`.
 */
export const SLACK_UNKNOWN_CHANNEL_DETAIL =
  "That channel is not one Prowler can post to.";
export const SLACK_NO_DEFAULT_CHANNEL_DETAIL =
  "No default channel is recorded on this integration.";
/** A task result that reports the refusal as prose instead of as a reason. */
export const SLACK_TEST_MESSAGE_REFUSED_DETAIL =
  "Slack rejected the message: the channel is archived.";

/**
 * The `code` values the refusals below are named by. Wire values, spelled out
 * rather than imported from the UI's own mapping: a rename on our side must
 * fail these tests, not quietly agree with itself.
 */
export const SLACK_WORKSPACE_CONFLICT_CODE = "slack_workspace_conflict";
export const SLACK_MISSING_SCOPE_CODE = "missing_scope";
export const SLACK_CHANNEL_NOT_FOUND_CODE = "channel_not_found";
export const SLACK_NOT_IN_CHANNEL_CODE = "not_in_channel";

/** What `Retry-After` carries on a rate-limited answer. */
export const SLACK_RETRY_AFTER_SECONDS = 30;

/** The install never granted a scope the call needs: actionable, so a `400`. */
export const SLACK_MISSING_SCOPE_REFUSAL: SlackRefusalFixture = {
  status: 400,
  code: SLACK_MISSING_SCOPE_CODE,
  detail: SLACK_MISSING_SCOPE_DETAIL,
  retryAfterSeconds: null,
};

/**
 * Slack rate limiting Prowler. The endpoint this actually happens on is the
 * channel listing: `conversations.list` is tier 2 and paginated.
 */
export const SLACK_RATE_LIMITED_REFUSAL: SlackRefusalFixture = {
  status: 429,
  code: null,
  detail: SLACK_RATE_LIMITED_DETAIL,
  retryAfterSeconds: SLACK_RETRY_AFTER_SECONDS,
};

/** Slack-side or transport failure — a `502` naming no reason at all. */
export const SLACK_UPSTREAM_REFUSAL: SlackRefusalFixture = {
  status: 502,
  code: null,
  detail: SLACK_UPSTREAM_DETAIL,
  retryAfterSeconds: null,
};

/** The chosen channel is archived, deleted, or was never in the workspace. */
export const SLACK_CHANNEL_NOT_FOUND_REFUSAL: SlackRefusalFixture = {
  status: 400,
  code: SLACK_CHANNEL_NOT_FOUND_CODE,
  detail: SLACK_UNKNOWN_CHANNEL_DETAIL,
  retryAfterSeconds: null,
};

/**
 * The chosen channel is fine — the Prowler app is simply not in it, which
 * someone in Slack fixes with `/invite @Prowler`. Identical `detail` to the
 * refusal above, deliberately.
 */
export const SLACK_NOT_IN_CHANNEL_REFUSAL: SlackRefusalFixture = {
  status: 400,
  code: SLACK_NOT_IN_CHANNEL_CODE,
  detail: SLACK_UNKNOWN_CHANNEL_DETAIL,
  retryAfterSeconds: null,
};

/**
 * The workspace's channels: two public, and one private the Prowler app has
 * been invited to. Ordered so the private one lands on the second cursor page
 * at the default page size — following `links.next` is what makes it visible.
 */
export const SLACK_PUBLIC_CHANNEL: SlackChannelFixture = {
  id: "C0123AB",
  name: "security",
  isPrivate: false,
};

export const SLACK_SECOND_PUBLIC_CHANNEL: SlackChannelFixture = {
  id: "C0789EF",
  name: "platform",
  isPrivate: false,
};

export const SLACK_PRIVATE_CHANNEL: SlackChannelFixture = {
  id: "C0456CD",
  name: "security-alerts",
  isPrivate: true,
};

export const SLACK_CHANNELS: SlackChannelFixture[] = [
  SLACK_PUBLIC_CHANNEL,
  SLACK_SECOND_PUBLIC_CHANNEL,
  SLACK_PRIVATE_CHANNEL,
];

/** Two channels per page, so `SLACK_CHANNELS` spans exactly two pages. */
export const SLACK_CHANNELS_PAGE_SIZE = 2;

/**
 * The channel a finished install posts to: the first one the picker offers, so
 * an install seeded with it always points at a channel the listing really has.
 */
export const SLACK_DEFAULT_CHANNEL = SLACK_PUBLIC_CHANNEL;

const PROWLER_HQ: SlackWorkspaceFixture = {
  teamId: "T01PROWLER",
  teamName: "Prowler HQ",
  botUserId: "U01PROWLERBOT",
};

export const slackFixture = (
  overrides: Partial<SlackFixture> = {},
): SlackFixture => ({
  appConfigured: true,
  install: null,
  exchangeWorkspace: { ...PROWLER_HQ },
  exchangeOutcome: SLACK_EXCHANGE_OUTCOME.CREATED,
  connection: { connected: true, error: null },
  rateLimited: false,
  channels: SLACK_CHANNELS.map((channel) => ({ ...channel })),
  channelsPageSize: SLACK_CHANNELS_PAGE_SIZE,
  channelsRefusal: null,
  channelSaveRefusal: null,
  testMessage: { accepted: true, error: null },
  ...overrides,
});

/**
 * A tenant that already approved Prowler in its workspace, and has chosen no
 * destination channel yet — the state the OAuth exchange leaves behind.
 */
export const connectedSlackFixture = (
  overrides: Partial<SlackFixture> = {},
): SlackFixture =>
  slackFixture({
    install: {
      id: SLACK_INTEGRATION_ID,
      connected: true,
      connectionLastCheckedAt: "2026-08-10T09:30:00Z",
      workspace: { ...PROWLER_HQ },
    },
    exchangeOutcome: SLACK_EXCHANGE_OUTCOME.REINSTALLED,
    ...overrides,
  });

/**
 * The same tenant, with a destination channel already on record — the state a
 * second visit starts from, and the one that shows whether a later failure
 * disturbs what was already saved.
 */
export const slackFixtureWithDefaultChannel = (
  channel: SlackChannelFixture = SLACK_PUBLIC_CHANNEL,
  overrides: Partial<SlackFixture> = {},
): SlackFixture =>
  connectedSlackFixture({
    install: {
      id: SLACK_INTEGRATION_ID,
      connected: true,
      connectionLastCheckedAt: "2026-08-10T09:30:00Z",
      workspace: {
        ...PROWLER_HQ,
        channelId: channel.id,
        channelName: channel.name,
      },
    },
    ...overrides,
  });

/**
 * The same tenant with its setup finished: a workspace connected *and* a
 * destination channel on record. Anything the API refuses until a channel
 * exists — the connection check among them — needs this fixture, not the bare
 * connected one.
 */
export const configuredSlackFixture = (
  overrides: Partial<SlackFixture> = {},
): SlackFixture =>
  slackFixtureWithDefaultChannel(SLACK_DEFAULT_CHANNEL, overrides);
