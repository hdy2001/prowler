/**
 * Page-level test harness for the Slack integration (Vitest Browser Mode).
 *
 * Owns mounting and MSW wiring for the real pages the flow touches — the
 * integrations catalogue Slack is listed on, the management page and the OAuth
 * callback — and exposes Slack vocabulary ("connect", "the connected
 * workspace", "test the connection") so the tests never reach for a selector.
 * The DOM and wait primitives stay `protected` in `BrowserHarness`.
 *
 * Every mount renders production's own components: the async server component
 * that loads the install, and the client components the callback and the
 * catalogue pages render. A client renderer cannot render an async component,
 * so it is called and its returned element is what gets rendered — the same
 * trick the providers harness uses.
 */

import { createElement } from "react";

import { BrowserHarness } from "@/__tests__/browser-harness";
import { handlersForSlack } from "@/__tests__/msw/handlers/slack";
import type { SlackFixture } from "@/__tests__/msw/handlers/slack.fixtures";
import { worker } from "@/__tests__/msw/worker";
import { render } from "@/__tests__/render-browser";
import { SlackCallback } from "@/components/integrations/slack/slack-callback";

import { IntegrationsContent } from "../integrations-content";

import { SlackIntegrationContent } from "./slack-integration-content";

export const CONNECTION_OUTCOME = {
  SUCCESS: "success",
  FAILURE: "failure",
} as const;

export type ConnectionOutcome =
  (typeof CONNECTION_OUTCOME)[keyof typeof CONNECTION_OUTCOME];

export const TEST_MESSAGE_OUTCOME = {
  SENT: "sent",
  FAILED: "failed",
} as const;

export type TestMessageOutcome =
  (typeof TEST_MESSAGE_OUTCOME)[keyof typeof TEST_MESSAGE_OUTCOME];

/** Sentinel: the page settled on "no channel recorded", rather than not yet. */
const NO_DEFAULT_CHANNEL = "<no channel recorded>";

/** What Slack put on the callback URL when it sent the user back. */
interface CallbackParams {
  code?: string;
  state?: string;
  /** Slack's own refusal, e.g. `access_denied` when the user declined. */
  error?: string;
}

export class SlackIntegrationHarness extends BrowserHarness<SlackFixture> {
  /** Exchanges issued — the callback's once-guard is what keeps this at 1. */
  get exchangeCallCount(): number {
    return this.countRequests("POST", "/slack/oauth/exchange");
  }

  get authorizeUrlCallCount(): number {
    return this.countRequests("POST", "/slack/oauth/authorize-url");
  }

  // --- Mounting -----------------------------------------------------------

  private wireHandlers(): void {
    worker.use(...handlersForSlack(this.fixture));
    this.trackRequests(worker);
  }

  /** Mount the Slack management page at `/integrations/slack`. */
  async mount(): Promise<void> {
    window.history.replaceState(null, "", "/integrations/slack");
    this.wireHandlers();

    const readsBefore = this.channelListCallCount;
    this.mounted = render(await SlackIntegrationContent());
    if (this.fixture.install) await this.waitForChannelsRead(readsBefore);
  }

  private mounted: ReturnType<typeof render> | null = null;

  /**
   * Open the management page again, the way a later visit does — the handlers
   * already in place keep serving whatever the previous visit left behind, so
   * this reads the API's state rather than a re-seeded fixture. The previous
   * render is unmounted first: two live copies of the page would make every
   * assertion ambiguous.
   */
  async revisit(): Promise<void> {
    (await this.mounted)?.unmount();
    const readsBefore = this.channelListCallCount;
    this.mounted = render(await SlackIntegrationContent());
    await this.mounted;
    if (this.fixture.install) await this.waitForChannelsRead(readsBefore);
  }

  /** Mount the OAuth callback with the query string Slack redirected to. */
  async mountCallback({ code, state, error }: CallbackParams): Promise<void> {
    const params = new URLSearchParams();
    if (code) params.set("code", code);
    if (state) params.set("state", state);
    if (error) params.set("error", error);
    window.history.replaceState(
      null,
      "",
      `/integrations/slack/callback?${params.toString()}`,
    );
    this.wireHandlers();

    render(createElement(SlackCallback));
  }

  /**
   * Mount the integrations catalogue at `/integrations` — the page Slack is
   * listed on. No handlers are wired: every card there is static.
   */
  mountCatalogue(): void {
    window.history.replaceState(null, "", "/integrations");

    render(createElement(IntegrationsContent));
  }

  // --- The integrations catalogue ------------------------------------------

  /** The integrations the catalogue offers, by the name shown on each card. */
  async listedIntegrations(): Promise<string[]> {
    const headings = await this.waitFor(
      () => {
        const found = Array.from(
          this.container.querySelectorAll<HTMLElement>("h4"),
        );
        return found.length > 0 ? found : null;
      },
      5000,
      "the integrations catalogue",
    );
    return headings.map((heading) => (heading.textContent ?? "").trim());
  }

  /** Whether the catalogue offers a way into the Slack management page. */
  offersSlackManagement(): boolean {
    return this.q('a[href="/integrations/slack"]') !== null;
  }

  // --- Starting the install -----------------------------------------------

  private connectLink(): HTMLAnchorElement | null {
    return (
      Array.from(this.container.querySelectorAll("a")).find((anchor) =>
        /Add to Slack/.test(anchor.textContent ?? ""),
      ) ?? null
    );
  }

  /** The consent URL the install affordance points at, once it is offered. */
  async authorizeUrl(): Promise<string> {
    const link = await this.waitFor(
      () => this.connectLink(),
      5000,
      "the Add to Slack link",
    );
    return link.href;
  }

  /**
   * Start the install the way a user does, and report where Slack's consent
   * screen would have been reached at.
   *
   * The click is real — it goes through user-event, so a disabled or
   * unclickable affordance still fails the test — but its default action is
   * cancelled: following the link would navigate the test frame off the app.
   */
  async connect(): Promise<string> {
    const link = await this.waitFor(
      () => this.connectLink(),
      5000,
      "the Add to Slack link",
    );

    let destination = "";
    const intercept = (event: MouseEvent) => {
      event.preventDefault();
      destination = link.href;
    };
    link.addEventListener("click", intercept);
    try {
      await this.clickElement(link, { fallbackToDomClick: true });
    } finally {
      link.removeEventListener("click", intercept);
    }

    return destination;
  }

  /** Whether the install is offered at all (it is not without a Slack app). */
  offersInstall(): boolean {
    return this.connectLink() !== null;
  }

  async waitForUnavailable(): Promise<void> {
    await this.waitForText(/Slack is not available in this environment yet/);
  }

  /** Whether the page claims this deployment has no Slack app. */
  saysUnavailable(): boolean {
    return this.containsText(/Slack is not available in this environment yet/);
  }

  /** What the page says about Slack rate limiting Prowler, once it says it. */
  async rateLimitNotice(): Promise<string> {
    await this.waitForText(/Slack is busy right now/, 10000);
    const description = await this.waitFor(
      () => this.q('[data-slot="alert-description"]'),
      5000,
      "the rate limit notice",
    );
    return (description.textContent ?? "").trim();
  }

  // --- Connected state ----------------------------------------------------

  /**
   * The workspace the page reports as connected — on the management page and
   * on the callback alike.
   *
   * Read from the element that carries the heading, not from the page's text:
   * "Connected to <workspace>" runs straight into the copy that follows it in
   * `textContent`, so matching the whole page would report that copy as part of
   * the workspace's name.
   */
  async connectedWorkspaceName(): Promise<string> {
    const heading = await this.waitFor(
      () => this.deepestElementMatching(/^Connected to \S/),
      5000,
      "the connected workspace name",
    );
    return (heading.textContent ?? "").trim().replace(/^Connected to /, "");
  }

  /**
   * The most specific element whose own text matches: the last one in document
   * order, since every ancestor of a match matches too.
   */
  private deepestElementMatching(pattern: RegExp): HTMLElement | null {
    return (
      Array.from(this.container.querySelectorAll<HTMLElement>("*"))
        .reverse()
        .find((element) => pattern.test((element.textContent ?? "").trim())) ??
      null
    );
  }

  async testConnection(): Promise<ConnectionOutcome> {
    await this.clickButton(/Test connection/);

    return this.waitFor(
      () => {
        if (this.containsText(/Connection test successful/)) {
          return CONNECTION_OUTCOME.SUCCESS;
        }
        if (this.containsText(/Connection test failed/)) {
          return CONNECTION_OUTCOME.FAILURE;
        }
        return null;
      },
      15000,
      "the connection test outcome",
    );
  }

  // --- Returning from Slack -----------------------------------------------

  /** Whether the callback settled on a connected workspace. */
  async completedInstall(): Promise<boolean> {
    const outcome = await this.waitFor(
      () =>
        this.containsText(/Connected to /) ||
        this.containsText(/Slack workspace not connected/),
      10000,
      "the callback outcome",
    );
    return outcome && this.containsText(/Connected to /);
  }

  /** What the user is told when the install did not complete. */
  async installFailureReason(): Promise<string> {
    await this.waitForText(/Slack workspace not connected/, 10000);
    const description = await this.waitFor(
      () => this.q('[data-slot="alert-description"]'),
      5000,
      "the failure reason",
    );
    return (description.textContent ?? "").trim();
  }

  /** Whether the page offers a way back to try the install again. */
  offersRetry(): boolean {
    return (
      Array.from(this.container.querySelectorAll("a")).some(
        (anchor) =>
          anchor.getAttribute("href") === "/integrations/slack" &&
          /Back to Slack integration/.test(anchor.textContent ?? ""),
      ) || this.offersInstall()
    );
  }

  // --- Choosing a destination channel --------------------------------------

  /** Channel reads issued — one per cursor page the UI followed. */
  get channelListCallCount(): number {
    return this.countRequests("GET", "/slack/channels");
  }

  /**
   * Wait for the read of the workspace's channels a connected page starts on
   * arrival, counting from the reads already issued.
   *
   * Every mount of a connected page starts one, and a test that asserts
   * something else settles long before the read does — a read still in flight
   * when the test ends lands in the middle of the next one, against a harness
   * that never asked for it. Waiting here keeps each test's reads its own.
   */
  private async waitForChannelsRead(readsBefore: number): Promise<void> {
    await this.waitFor(
      () => {
        const refresh = this.buttonByText(/Refresh channels/);
        return this.channelListCallCount > readsBefore &&
          refresh !== null &&
          !refresh.disabled
          ? true
          : null;
      },
      15000,
      "the workspace's channels to be read",
    );
  }

  /**
   * Open the picker and hand back its options.
   *
   * Radix mounts the listbox in a portal, and a re-render landing mid-gesture
   * makes it drop the open state — so re-open from the keyboard when nothing
   * mounted at all, the same recovery the attack-paths harness needs.
   */
  private async openChannelPicker(): Promise<HTMLElement[]> {
    const mounted = (): HTMLElement[] | null => {
      const options = Array.from(
        document.querySelectorAll<HTMLElement>('[role="option"]'),
      );
      return options.length > 0 ? options : null;
    };

    const alreadyOpen = mounted();
    if (alreadyOpen) return alreadyOpen;

    const trigger = await this.waitFor<HTMLElement>(
      () => this.q("#slack-channel"),
      10000,
      "the channel picker",
    );

    await this.clickElement(trigger, { fallbackToDomClick: true });

    let options = await this.waitForOrNull(
      mounted,
      2000,
      "the channel options",
    );
    if (!options) {
      await this.user.keyboard("{Enter}");
      options = await this.waitForOrNull(mounted, 8000, "the channel options");
    }

    if (!options) {
      throw new Error("openChannelPicker: the channel picker offered nothing");
    }
    return options;
  }

  private async closeChannelPicker(): Promise<void> {
    await this.user.keyboard("{Escape}");
    await this.waitForTransition();
  }

  /**
   * Re-read the workspace's channels, the way a user does after inviting
   * `@Prowler` to a channel in Slack: the picker only learns about it on a
   * fresh read, so this waits for the read to have happened and settled rather
   * than for the click alone.
   */
  async refreshChannels(): Promise<void> {
    const readsBefore = this.channelListCallCount;
    await this.clickButton(/Refresh channels/);

    await this.waitFor(
      () => {
        const button = this.buttonByText(/Refresh channels/);
        return (
          this.channelListCallCount > readsBefore &&
          button !== null &&
          !button.disabled
        );
      },
      15000,
      "the workspace's channels to be read again",
    );
  }

  /** The channels the workspace offers, in the order the picker lists them. */
  async channelOptions(): Promise<string[]> {
    const options = await this.openChannelPicker();
    const names = options.map(
      (option) => option.getAttribute("data-channel") ?? "",
    );

    await this.closeChannelPicker();

    return names;
  }

  /**
   * Whether the channel offered under `name` is presented as private — read
   * from the marker the user sees, not from how the option is wired up.
   */
  async isChannelShownAsPrivate(name: string): Promise<boolean> {
    const options = await this.openChannelPicker();
    const option = options.find(
      (element) => element.getAttribute("data-channel") === name,
    );

    await this.closeChannelPicker();

    return /Private/.test(option?.textContent ?? "");
  }

  /** Pick a channel out of the picker and ask for it to be saved. */
  private async pickAndSave(name: string): Promise<void> {
    const options = await this.openChannelPicker();
    const option = options.find(
      (element) => element.getAttribute("data-channel") === name,
    );

    if (!option) {
      throw new Error(`pickAndSave: no channel named "${name}" is offered`);
    }

    await this.user.click(option);
    await this.waitForTransition();
    await this.clickButton(/Save channel/);
  }

  /** Pick a channel by name and save it as the integration's destination. */
  async chooseChannel(name: string): Promise<void> {
    await this.pickAndSave(name);
    await this.waitFor(
      () => this.defaultChannelName() === name,
      15000,
      `#${name} to be recorded as the destination`,
    );
  }

  /**
   * Try to save a channel the API refuses, and hand back what the user is told
   * about it. A save that succeeds fails the test rather than timing out.
   */
  async refusedChannelSave(name: string): Promise<string> {
    await this.pickAndSave(name);

    return this.waitFor(
      () => {
        if (this.defaultChannelName() === name) {
          throw new Error(
            `refusedChannelSave: #${name} was recorded, not refused`,
          );
        }
        return this.toastText(/Could not save the destination channel/);
      },
      15000,
      "the refused channel save",
    );
  }

  /**
   * The text of the toast matching `pattern` — title and message together.
   *
   * Radix portals each toast into its viewport as an `<li>`, so the toasts are
   * the list items outside the page's own markup; matching on the text picks
   * the one being asked about.
   */
  private toastText(pattern: RegExp): string | null {
    const toast = Array.from(
      document.querySelectorAll<HTMLElement>("ol li"),
    ).find((element) => pattern.test(element.textContent ?? ""));
    return toast ? (toast.textContent ?? "").replace(/\s+/g, " ").trim() : null;
  }

  private defaultChannelName(): string | null {
    return (
      /Prowler posts to #(\S+?)\./.exec(
        this.container.textContent ?? "",
      )?.[1] ?? null
    );
  }

  /** The channel recorded as the integration's destination, if any. */
  async defaultChannel(): Promise<string | null> {
    const settled = await this.waitFor(
      () =>
        this.defaultChannelName() ??
        (this.containsText(/No destination channel recorded yet/)
          ? NO_DEFAULT_CHANNEL
          : null),
      10000,
      "the recorded destination channel",
    );
    return settled === NO_DEFAULT_CHANNEL ? null : settled;
  }

  /** What the user is told when the workspace exposes no channel at all. */
  async channelPickerMessage(): Promise<string> {
    const alert = await this.waitFor(
      () =>
        Array.from(
          this.container.querySelectorAll<HTMLElement>('[data-slot="alert"]'),
        ).find((element) =>
          /No channels available yet|Could not read the workspace/.test(
            element.textContent ?? "",
          ),
        ),
      10000,
      "the channel picker's message",
    );
    return (alert.textContent ?? "").replace(/\s+/g, " ").trim();
  }

  /** The invite copy that says how to make a private channel appear. */
  channelInviteHint(): string | null {
    const hint = Array.from(
      this.container.querySelectorAll<HTMLElement>("p"),
    ).find((element) => /invites? @Prowler/.test(element.textContent ?? ""));
    return hint ? (hint.textContent ?? "").trim() : null;
  }

  // --- The test message ----------------------------------------------------

  /** Whether sending a test message is offered at all. */
  offersTestMessage(): boolean {
    return this.buttonByText(/Send test message/) !== null;
  }

  private testMessageAlert(): HTMLElement | null {
    return (
      Array.from(
        this.container.querySelectorAll<HTMLElement>('[data-slot="alert"]'),
      ).find((element) =>
        /Test message (sent|failed)/.test(element.textContent ?? ""),
      ) ?? null
    );
  }

  /** Send the test message and report how it went. */
  async sendTestMessage(): Promise<TestMessageOutcome> {
    await this.clickButton(/Send test message/);

    return this.waitFor(
      () => {
        const alert = this.testMessageAlert();
        if (!alert) return null;
        return /Test message sent/.test(alert.textContent ?? "")
          ? TEST_MESSAGE_OUTCOME.SENT
          : TEST_MESSAGE_OUTCOME.FAILED;
      },
      15000,
      "the test message outcome",
    );
  }

  /** What the user was told about the last test message. */
  async lastTestMessageOutcome(): Promise<string> {
    const alert = await this.waitFor(
      () => this.testMessageAlert(),
      10000,
      "the test message outcome",
    );
    const description = alert.querySelector<HTMLElement>(
      '[data-slot="alert-description"]',
    );
    return (description?.textContent ?? "").trim();
  }
}
