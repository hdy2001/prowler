/**
 * Browser-mode tests for the Slack integration pages (`/integrations/slack`
 * and its OAuth callback).
 *
 * Tests are grouped by what the user is doing — starting the install, coming
 * back from Slack, living with a connected workspace — and reach the pages only
 * through `SlackIntegrationHarness`. The API is the cloud lane's, so MSW
 * answers from handlers derived from `design.md`'s contract: a scenario that
 * cannot be expressed here is a contract conversation, not a local fix.
 */

import { describe, expect } from "vitest";

import { it } from "@/__tests__/fixtures";
import {
  configuredSlackFixture,
  connectedSlackFixture,
  revokedTokenSlackFixture,
  revokeFailureSlackFixture,
  SLACK_CHANNEL_NOT_FOUND_REFUSAL,
  SLACK_EXCHANGE_OUTCOME,
  SLACK_MISSING_SCOPE_CODE,
  SLACK_MISSING_SCOPE_REFUSAL,
  SLACK_NOT_IN_CHANNEL_CODE,
  SLACK_NOT_IN_CHANNEL_REFUSAL,
  SLACK_OAUTH_CODE,
  SLACK_OAUTH_STATE,
  SLACK_PRIVATE_CHANNEL,
  SLACK_PUBLIC_CHANNEL,
  SLACK_RATE_LIMITED_REFUSAL,
  SLACK_SECOND_PUBLIC_CHANNEL,
  SLACK_TEST_MESSAGE_REFUSED_DETAIL,
  SLACK_TOKEN_EXPIRED_CODE,
  SLACK_TOKEN_EXPIRED_REFUSAL,
  SLACK_TOKEN_REVOKED_CODE,
  SLACK_UNKNOWN_CHANNEL_DETAIL,
  SLACK_UPSTREAM_REFUSAL,
  slackFixture,
  slackFixtureWithDefaultChannel,
} from "@/__tests__/msw/handlers/slack.fixtures";

import {
  CONNECTION_OUTCOME,
  REVOCATION_OUTCOME,
  SlackIntegrationHarness,
  TEST_MESSAGE_OUTCOME,
} from "./slack-integration.harness";

/** The shape the channel save is asserted against — only the id travels. */
interface PatchIntegrationBody {
  data: { attributes: { configuration: { channel_id: string } } };
}

/** The workspace the fixtures connect. */
const WORKSPACE_NAME = "Prowler HQ";

/**
 * The access Prowler asks a workspace for, and nothing else (design D2): post
 * messages, post to a public channel without being invited, and read the
 * channel list — public, plus the private channels the app was invited to.
 */
const REQUIRED_SCOPES = [
  "chat:write",
  "chat:write.public",
  "channels:read",
  "groups:read",
];

describe("starting the install", () => {
  it("sends the user to Slack's consent screen for the access Prowler needs", async () => {
    // Given — a tenant with no workspace connected yet.
    const harness = new SlackIntegrationHarness(slackFixture());
    await harness.mount();

    // When
    const consentScreen = new URL(await harness.connect());

    // Then — Slack's own consent screen, carrying the scopes and the
    // server-minted state that binds this install to the session (design D5).
    expect(`${consentScreen.origin}${consentScreen.pathname}`).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect((consentScreen.searchParams.get("scope") ?? "").split(",")).toEqual(
      expect.arrayContaining(REQUIRED_SCOPES),
    );
    expect(consentScreen.searchParams.get("state")).toBeTruthy();
  }, 30000);

  it("says so when the deployment has no Slack app, instead of offering an install", async () => {
    // Given — a deployment without SLACK_CLIENT_ID/SECRET/REDIRECT_URI, which
    // the API answers with a 503 (contract, "API contract").
    const harness = new SlackIntegrationHarness(
      slackFixture({ appConfigured: false }),
    );

    // When
    await harness.mount();

    // Then — nothing to do and nothing to click, rather than an error.
    await harness.waitForUnavailable();
    expect(harness.offersInstall()).toBe(false);
  }, 30000);

  it("says Slack is busy, not that the deployment has no Slack app, when it is rate limiting", async () => {
    // Given — the app is configured and working; Slack is just rate limiting
    // the call that mints the consent URL.
    const harness = new SlackIntegrationHarness(
      slackFixture({ rateLimited: true }),
    );

    // When
    await harness.mount();

    // Then — the wait is named, and the page does not claim Slack is missing
    // from this environment: that answer would send the user to their admin
    // over something that fixes itself in half a minute.
    expect(await harness.rateLimitNotice()).toMatch(/about 30 seconds/);
    expect(harness.saysUnavailable()).toBe(false);
  }, 30000);
});

describe("returning from Slack", () => {
  it("completes the install and shows the connected workspace", async () => {
    // Given
    const harness = new SlackIntegrationHarness(slackFixture());

    // When — Slack sends the user back with the code it issued.
    await harness.mountCallback({
      code: SLACK_OAUTH_CODE,
      state: SLACK_OAUTH_STATE,
    });

    // Then
    expect(await harness.completedInstall()).toBe(true);
    expect(await harness.connectedWorkspaceName()).toBe(WORKSPACE_NAME);
    // The Slack code is single-use, and the exchange runs from a render
    // (design D4): a second call would burn the code and report a failure for
    // an install that actually succeeded. The once-guard is what prevents it.
    expect(harness.exchangeCallCount).toBe(1);
  }, 30000);

  it("connects nothing when the user declines in Slack, and offers to retry", async () => {
    // Given
    const harness = new SlackIntegrationHarness(slackFixture());

    // When — a declined consent comes back as an error, with no code.
    await harness.mountCallback({ error: "access_denied" });

    // Then
    expect(await harness.installFailureReason()).toMatch(
      /not approved in Slack/,
    );
    expect(harness.offersRetry()).toBe(true);
    // Nothing was created: there was nothing to exchange.
    expect(harness.exchangeCallCount).toBe(0);
  }, 30000);

  it("surfaces the reason when Slack refuses to complete the install", async () => {
    // Given — Slack rejects the code, and the API's own wording explains it.
    const harness = new SlackIntegrationHarness(
      slackFixture({ exchangeOutcome: SLACK_EXCHANGE_OUTCOME.SLACK_REFUSED }),
    );

    // When
    await harness.mountCallback({
      code: SLACK_OAUTH_CODE,
      state: SLACK_OAUTH_STATE,
    });

    // Then — a refusal Prowler has nothing better to say about falls back to
    // the API's `detail`, rather than to a generic failure.
    expect(await harness.installFailureReason()).toMatch(
      /OAuth code is invalid/,
    );
    expect(harness.offersRetry()).toBe(true);
  }, 30000);

  it("surfaces a completion the API refuses, and connects nothing", async () => {
    // Given — the state was minted for another session, or already consumed.
    const harness = new SlackIntegrationHarness(
      slackFixture({ exchangeOutcome: SLACK_EXCHANGE_OUTCOME.REFUSED_STATE }),
    );

    // When
    await harness.mountCallback({
      code: SLACK_OAUTH_CODE,
      state: "state-from-another-session",
    });

    // Then — the page reports no workspace connected, with the API's reason.
    expect(await harness.installFailureReason()).toMatch(
      /state is invalid, expired, or already consumed/,
    );
    expect(await harness.completedInstall()).toBe(false);
    expect(harness.offersRetry()).toBe(true);
    // Refused once, not retried into a second burnt code.
    expect(harness.exchangeCallCount).toBe(1);
  }, 30000);

  it("says how to resolve a workspace conflict, in Prowler's own words", async () => {
    // Given — this tenant already has a different workspace connected, which
    // the API refuses as a 409 naming the conflict in `code`.
    const harness = new SlackIntegrationHarness(
      slackFixture({
        exchangeOutcome: SLACK_EXCHANGE_OUTCOME.DIFFERENT_WORKSPACE,
      }),
    );

    // When
    await harness.mountCallback({
      code: SLACK_OAUTH_CODE,
      state: SLACK_OAUTH_STATE,
    });

    // Then — the copy comes from the code, so it says what to do next; the
    // API's own `detail` states the conflict but not the way out of it.
    const reason = await harness.installFailureReason();
    expect(reason).toMatch(/already connected to a different Slack workspace/);
    expect(reason).toMatch(/Disconnect it before connecting another/);
    expect(reason).not.toMatch(/tenant/);
    expect(await harness.completedInstall()).toBe(false);
    expect(harness.offersRetry()).toBe(true);
  }, 30000);

  it("tells the user when to come back if Slack is rate limiting the install", async () => {
    // Given — Slack answers 429 with a Retry-After.
    const harness = new SlackIntegrationHarness(
      slackFixture({ rateLimited: true }),
    );

    // When
    await harness.mountCallback({
      code: SLACK_OAUTH_CODE,
      state: SLACK_OAUTH_STATE,
    });

    // Then — the wait Slack asked for, not a generic failure, and not "Slack
    // isn't available in this environment": the app is there and working.
    const reason = await harness.installFailureReason();
    expect(reason).toMatch(/rate limiting/);
    expect(reason).toMatch(/about 30 seconds/);
    expect(reason).not.toMatch(/not available in this environment/);
    expect(harness.offersRetry()).toBe(true);
  }, 30000);

  it("does not attempt an exchange when the completion carries no state", async () => {
    // Given
    const harness = new SlackIntegrationHarness(slackFixture());

    // When — a return without the value the install started with.
    await harness.mountCallback({ code: SLACK_OAUTH_CODE });

    // Then — refused before the API is ever asked, so no code is spent.
    expect(await harness.installFailureReason()).toMatch(/incomplete response/);
    expect(harness.exchangeCallCount).toBe(0);
  }, 30000);
});

describe("a connected workspace", () => {
  it("identifies the workspace and reports the connection as healthy", async () => {
    // Given — a tenant whose setup is finished: workspace approved and a
    // destination channel recorded, which is what the API needs before it will
    // check a connection at all.
    const harness = new SlackIntegrationHarness(configuredSlackFixture());
    await harness.mount();

    // Then
    expect(await harness.connectedWorkspaceName()).toBe(WORKSPACE_NAME);
    expect(await harness.testConnection()).toBe(CONNECTION_OUTCOME.SUCCESS);
    // One workspace per tenant (design D10): a connected tenant is not invited
    // to install another, and no consent URL is minted for a page that would
    // never use it.
    expect(harness.offersInstall()).toBe(false);
    expect(harness.authorizeUrlCallCount).toBe(0);
  }, 30000);

  it("still identifies the workspace before a destination channel is chosen", async () => {
    // Given — the state the OAuth exchange leaves behind.
    const harness = new SlackIntegrationHarness(connectedSlackFixture());

    // When
    await harness.mount();

    // Then — the configuration carries no channel keys at all, and the page
    // reads that as an install with nothing chosen yet rather than as a broken
    // one.
    expect(await harness.connectedWorkspaceName()).toBe(WORKSPACE_NAME);
    expect(harness.offersInstall()).toBe(false);
  }, 30000);
});

describe("choosing a destination channel", () => {
  it("offers the workspace's channels and remembers the one chosen", async () => {
    // Given — a connected tenant, whose workspace exposes more channels than
    // fit on one cursor page.
    const harness = new SlackIntegrationHarness(connectedSlackFixture());
    await harness.mount();

    // Then — every channel is offered, so the picker followed `links.next`
    // rather than stopping at the first page (design D6, Slack's listing is
    // paginated and rate-limited).
    expect(await harness.channelOptions()).toEqual([
      SLACK_PUBLIC_CHANNEL.name,
      SLACK_SECOND_PUBLIC_CHANNEL.name,
      SLACK_PRIVATE_CHANNEL.name,
    ]);
    expect(harness.channelListCallCount).toBe(2);

    // When
    await harness.chooseChannel(SLACK_PUBLIC_CHANNEL.name);

    // Then — only the id is submitted: the API validates it against Slack and
    // derives the name, so a name sent from here could only ever drift.
    const saved = await harness.lastRequestBody<PatchIntegrationBody>(
      "PATCH",
      "/integrations/",
    );
    expect(saved?.data.attributes.configuration).toEqual({
      channel_id: SLACK_PUBLIC_CHANNEL.id,
    });

    // And — a later visit shows it as the destination, under the name the API
    // derived from the id rather than one the UI remembered locally.
    await harness.revisit();
    expect(await harness.defaultChannel()).toBe(SLACK_PUBLIC_CHANNEL.name);
  }, 60000);

  it("offers a private channel the app was invited to, marked as private, and saves it", async () => {
    // Given — `@Prowler` has been invited to one private channel, which is
    // what makes it visible at all (`groups:read` is membership-gated, D2).
    const harness = new SlackIntegrationHarness(connectedSlackFixture());
    await harness.mount();

    // Then — it is offered, and the user can tell it apart from a public one.
    expect(await harness.channelOptions()).toContain(
      SLACK_PRIVATE_CHANNEL.name,
    );
    expect(
      await harness.isChannelShownAsPrivate(SLACK_PRIVATE_CHANNEL.name),
    ).toBe(true);
    expect(
      await harness.isChannelShownAsPrivate(SLACK_PUBLIC_CHANNEL.name),
    ).toBe(false);

    // When
    await harness.chooseChannel(SLACK_PRIVATE_CHANNEL.name);

    // Then
    expect(await harness.defaultChannel()).toBe(SLACK_PRIVATE_CHANNEL.name);
  }, 60000);

  it("offers a private channel once @Prowler is invited to it and the list is refreshed", async () => {
    // Given — a workspace whose only channels are public. `groups:read` is
    // membership-gated (design D2), so a private channel the app has not been
    // invited to does not exist as far as Prowler is concerned.
    const harness = new SlackIntegrationHarness(
      connectedSlackFixture({
        channels: [
          { ...SLACK_PUBLIC_CHANNEL },
          { ...SLACK_SECOND_PUBLIC_CHANNEL },
        ],
      }),
    );
    await harness.mount();
    expect(await harness.channelOptions()).not.toContain(
      SLACK_PRIVATE_CHANNEL.name,
    );

    // When — someone invites `@Prowler` to a private channel in Slack, and the
    // user refreshes instead of reconnecting the workspace.
    harness.fixture.channels.push({ ...SLACK_PRIVATE_CHANNEL });
    await harness.refreshChannels();

    // Then — it joins the list, still marked as private.
    expect(await harness.channelOptions()).toContain(
      SLACK_PRIVATE_CHANNEL.name,
    );
    expect(
      await harness.isChannelShownAsPrivate(SLACK_PRIVATE_CHANNEL.name),
    ).toBe(true);
  }, 60000);

  it("says what to do when the workspace exposes no channel Prowler can post to", async () => {
    // Given — a freshly connected workspace the app has not been invited to
    // anywhere, with no public channel either.
    const harness = new SlackIntegrationHarness(
      connectedSlackFixture({ channels: [] }),
    );

    // When
    await harness.mount();

    // Then — the user is told what to do, not merely that the list is empty,
    // and nothing is recorded.
    const message = await harness.channelPickerMessage();
    expect(message).toMatch(/No channels available yet/);
    expect(message).toMatch(/invite @Prowler/);
    expect(await harness.defaultChannel()).toBeNull();
    expect(harness.offersTestMessage()).toBe(false);
  }, 30000);

  it("says which permission is missing when Slack refuses the channel listing, leaving the recorded channel alone", async () => {
    // Given — a tenant that already recorded a destination, whose install never
    // granted a scope the listing needs. The API names it in `code` (contract,
    // Errors) and words `detail` its own way.
    const harness = new SlackIntegrationHarness(
      slackFixtureWithDefaultChannel(SLACK_PUBLIC_CHANNEL, {
        channelsRefusal: SLACK_MISSING_SCOPE_REFUSAL,
      }),
    );

    // When
    await harness.mount();

    // Then — the reason Slack reported, in wording that says how to fix it, and
    // the invite copy stays next to the picker so the other fix is still one
    // sentence away.
    const message = await harness.channelPickerMessage();
    expect(message).toMatch(/missing a permission it needs in Slack/);
    expect(message).toMatch(/Connect the workspace again and approve/);
    // Slack's reason is a protocol token, not copy: it travels in `code` and is
    // never shown, however the API happened to word its own `detail`.
    expect(message).not.toMatch(new RegExp(SLACK_MISSING_SCOPE_CODE));
    expect(harness.channelInviteHint()).toMatch(/invites @Prowler/);

    // And — a listing Prowler could not read says nothing about the channel
    // already on the integration: it stays recorded, and still postable to.
    expect(await harness.defaultChannel()).toBe(SLACK_PUBLIC_CHANNEL.name);
    expect(harness.offersTestMessage()).toBe(true);
  }, 30000);

  it("names the wait Slack asked for when it rate limits the channel listing", async () => {
    // Given — the listing is the endpoint this happens on: `conversations.list`
    // is Slack tier 2 and paginated (contract, Errors), and the `429` carries
    // the wait in `Retry-After`.
    const harness = new SlackIntegrationHarness(
      slackFixtureWithDefaultChannel(SLACK_PUBLIC_CHANNEL, {
        channelsRefusal: SLACK_RATE_LIMITED_REFUSAL,
      }),
    );

    // When
    await harness.mount();

    // Then — when to come back, rather than a refusal with nothing to do about
    // it. Dropping the header would still read as a plausible failure, which is
    // exactly why the wait is asserted and not just the wording.
    const message = await harness.channelPickerMessage();
    expect(message).toMatch(/rate limiting/);
    expect(message).toMatch(/about 30 seconds/);

    // And — waiting is the fix, so nothing is said about permissions and the
    // recorded destination is untouched.
    expect(message).not.toMatch(/permission/);
    expect(await harness.defaultChannel()).toBe(SLACK_PUBLIC_CHANNEL.name);
  }, 30000);

  it("falls back to the API's wording when the listing fails upstream", async () => {
    // Given — a Slack-side or transport failure: a `502` that names no `code`,
    // because there is nothing for the user to act on (contract, Errors).
    const harness = new SlackIntegrationHarness(
      slackFixtureWithDefaultChannel(SLACK_PUBLIC_CHANNEL, {
        channelsRefusal: SLACK_UPSTREAM_REFUSAL,
      }),
    );

    // When
    await harness.mount();

    // Then — the API's own `detail`, which is the best thing anyone has to say
    // about it, and not a wait that was never promised.
    const message = await harness.channelPickerMessage();
    expect(message).toMatch(/Slack is temporarily unavailable/);
    expect(message).not.toMatch(/rate limiting/);
    expect(await harness.defaultChannel()).toBe(SLACK_PUBLIC_CHANNEL.name);
  }, 30000);

  it("says to invite @Prowler when Slack refuses the channel because the app is not in it", async () => {
    // Given — a connected tenant picking a private channel the Prowler app was
    // removed from. The API validates the channel against Slack on the way in
    // and refuses with `code` = "not_in_channel".
    const harness = new SlackIntegrationHarness(
      connectedSlackFixture({
        channelSaveRefusal: SLACK_NOT_IN_CHANNEL_REFUSAL,
      }),
    );
    await harness.mount();

    // When
    const refusal = await harness.refusedChannelSave(
      SLACK_PRIVATE_CHANNEL.name,
    );

    // Then — the one fix the user can carry out themselves, in Slack.
    expect(refusal).toMatch(/Prowler is not in that channel/);
    expect(refusal).toMatch(/Invite @Prowler to it in Slack/);
    expect(refusal).not.toMatch(new RegExp(SLACK_NOT_IN_CHANNEL_CODE));

    // And — nothing was recorded, so nothing is offered to post with.
    expect(await harness.defaultChannel()).toBeNull();
    expect(harness.offersTestMessage()).toBe(false);
  }, 60000);

  it("says the channel is gone, not that @Prowler needs inviting, when Slack no longer has it", async () => {
    // Given — the same refusal shape for a channel archived since the listing
    // was read. The API's `detail` is word-for-word the one it sends for a
    // channel the app is not in, so only `code` tells the two apart.
    const harness = new SlackIntegrationHarness(
      connectedSlackFixture({
        channelSaveRefusal: SLACK_CHANNEL_NOT_FOUND_REFUSAL,
      }),
    );
    await harness.mount();

    // When
    const refusal = await harness.refusedChannelSave(SLACK_PUBLIC_CHANNEL.name);

    // Then — a different problem, so different copy: there is no bot to invite
    // to a channel that no longer exists.
    expect(refusal).toMatch(/no longer exists in the workspace/);
    expect(refusal).toMatch(/Choose another one/);
    expect(refusal).not.toMatch(/Invite @Prowler/);
    expect(refusal).not.toMatch(new RegExp(SLACK_UNKNOWN_CHANNEL_DETAIL));
    expect(await harness.defaultChannel()).toBeNull();
  }, 60000);
});

describe("sending a test message", () => {
  it("is not offered until a destination channel is recorded", async () => {
    // Given — connected, but no channel chosen yet.
    const harness = new SlackIntegrationHarness(connectedSlackFixture());

    // When
    await harness.mount();

    // Then
    expect(await harness.defaultChannel()).toBeNull();
    expect(harness.offersTestMessage()).toBe(false);
  }, 30000);

  it("sends a test message to the recorded channel and reports it delivered", async () => {
    // Given — a tenant that has recorded where Prowler should post.
    const harness = new SlackIntegrationHarness(connectedSlackFixture());
    await harness.mount();
    await harness.chooseChannel(SLACK_PUBLIC_CHANNEL.name);

    // When
    const outcome = await harness.sendTestMessage();

    // Then — sent, and the user reads which channel it went to.
    expect(outcome).toBe(TEST_MESSAGE_OUTCOME.SENT);
    expect(await harness.lastTestMessageOutcome()).toMatch(
      new RegExp(`#${SLACK_PUBLIC_CHANNEL.name}`),
    );
  }, 60000);

  it("surfaces the reason when Slack refuses the test message", async () => {
    // Given — the post itself fails, which the API reports on the task it
    // handed back (design D9), not on the request that started it. The task
    // reports the same stable reason the synchronous endpoints put in `code`.
    const harness = new SlackIntegrationHarness(
      connectedSlackFixture({
        testMessage: { accepted: false, error: SLACK_NOT_IN_CHANNEL_CODE },
      }),
    );
    await harness.mount();
    await harness.chooseChannel(SLACK_PUBLIC_CHANNEL.name);

    // When
    const outcome = await harness.sendTestMessage();

    // Then — the reason Slack reported, turned into the same copy the
    // synchronous refusals get, rather than the raw token or a generic failure.
    expect(outcome).toBe(TEST_MESSAGE_OUTCOME.FAILED);
    const reported = await harness.lastTestMessageOutcome();
    expect(reported).toMatch(/Prowler is not in that channel/);
    expect(reported).toMatch(/Invite @Prowler to it in Slack/);
    expect(reported).not.toMatch(new RegExp(SLACK_NOT_IN_CHANNEL_CODE));
  }, 60000);

  it("reports a refusal the task words itself, rather than swallowing it", async () => {
    // Given — the task-result shape for a Slack refusal is the cloud lane's to
    // pin down (contract, test-message): the agreement is that it reports the
    // stable reason, not that it can only ever be one. A result that carries
    // prose instead is shown as the prose it is — the alternative would be
    // parsing it, which the error model exists to prevent.
    const harness = new SlackIntegrationHarness(
      connectedSlackFixture({
        testMessage: {
          accepted: false,
          error: SLACK_TEST_MESSAGE_REFUSED_DETAIL,
        },
      }),
    );
    await harness.mount();
    await harness.chooseChannel(SLACK_PUBLIC_CHANNEL.name);

    // When
    const outcome = await harness.sendTestMessage();

    // Then
    expect(outcome).toBe(TEST_MESSAGE_OUTCOME.FAILED);
    expect(await harness.lastTestMessageOutcome()).toMatch(
      new RegExp(SLACK_TEST_MESSAGE_REFUSED_DETAIL),
    );
  }, 60000);
});

describe("disconnecting a workspace", () => {
  it("removes the integration and returns the card to its unconnected state", async () => {
    // Given — a tenant with a workspace connected.
    const harness = new SlackIntegrationHarness(connectedSlackFixture());
    await harness.mount();

    // When — the user disconnects and confirms.
    // Then — Slack confirmed the revocation, so the user is told the access is
    // gone and nothing warns them to finish the job by hand.
    expect(await harness.disconnect()).toBe(REVOCATION_OUTCOME.REVOKED);

    // And the integration is gone, with the page offering a fresh install.
    expect(harness.disconnectCallCount).toBe(1);
    expect(await harness.returnedToUnconnectedState()).toBe(true);
  }, 30000);

  it("still removes the integration when the revocation fails, and says access may need removing by hand", async () => {
    // Given — Slack will not accept the revocation. Revocation is best-effort:
    // the row goes either way and the outcome travels in `meta` as the single
    // boolean the API sends — there is no reason alongside it.
    const harness = new SlackIntegrationHarness(revokeFailureSlackFixture());
    await harness.mount();

    // When
    expect(await harness.disconnect()).toBe(REVOCATION_OUTCOME.NOT_REVOKED);

    // Then — the user reads what is true of both sides: nothing is left in
    // Prowler to retry, and the app may still be installed at Slack. Saying
    // "there is nothing to retry here" is the point — the one thing a user
    // reaches for after a failure is the thing that cannot help.
    const notice = await harness.revocationNotice();
    expect(notice).toMatch(/gone from Prowler/);
    expect(notice).toMatch(/nothing to retry here/);
    expect(notice).toMatch(/may still be installed in Prowler HQ/);
    expect(notice).toMatch(
      /remove it from that workspace's Slack app settings/,
    );
    // The row is removed regardless, so the page does not keep offering a
    // workspace that no longer exists here.
    expect(await harness.returnedToUnconnectedState()).toBe(true);
  }, 30000);
});

describe("a credential Slack no longer accepts", () => {
  it("says the connection check found a dead credential, and offers to connect the workspace again", async () => {
    // Given — the token was revoked at Slack, so the row still reads connected
    // until a check runs (contract, Cross-cutting).
    const harness = new SlackIntegrationHarness(revokedTokenSlackFixture());
    await harness.mount();

    // When
    expect(await harness.testConnection()).toBe(CONNECTION_OUTCOME.FAILURE);

    // Then — what died, in Prowler's words, and a way forward rather than only
    // an error: a revoked token is fixed by approving Prowler again, not by
    // checking a second time.
    const notice = await harness.revokedCredentialNotice();
    expect(notice).toMatch(/no longer accepts Prowler's access to Prowler HQ/);
    expect(notice).toMatch(/Prowler's access to Slack was revoked/);
    expect(notice).toMatch(/Connect the workspace again to restore access/);
    // Slack's reason is a protocol token: it is what the UI switched on, never
    // what it showed.
    expect(notice).not.toMatch(new RegExp(SLACK_TOKEN_REVOKED_CODE));

    const consentScreen = new URL(await harness.reconnectUrl());
    expect(`${consentScreen.origin}${consentScreen.pathname}`).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(harness.offersReconnect()).toBe(true);
  }, 30000);

  it("offers the same recovery when the channel listing is what finds the credential dead", async () => {
    // Given — a finished setup whose credential expired. The listing runs on
    // arrival, so it, not the connection check, is what meets Slack first —
    // and the contract says any call can be the one that surfaces this.
    const harness = new SlackIntegrationHarness(
      configuredSlackFixture({ channelsRefusal: SLACK_TOKEN_EXPIRED_REFUSAL }),
    );

    // When — nothing but opening the page.
    await harness.mount();

    // Then — the same answer as the connection check gives, worded for the way
    // this credential died, and not left as a channel problem the user would
    // go looking for a channel fix for.
    const notice = await harness.revokedCredentialNotice();
    expect(notice).toMatch(/Prowler's Slack credential has expired/);
    expect(notice).toMatch(/Connect the workspace again to restore access/);
    expect(harness.offersReconnect()).toBe(true);

    // And the picker says the same thing, in the same words: the API's own
    // `detail` names the raw reason, and it is `code` the UI answered from.
    const message = await harness.channelPickerMessage();
    expect(message).toMatch(/Prowler's Slack credential has expired/);
    expect(message).not.toMatch(new RegExp(SLACK_TOKEN_EXPIRED_CODE));
  }, 30000);
});
