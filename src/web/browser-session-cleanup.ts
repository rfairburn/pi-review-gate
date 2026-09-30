/**
 * Issue #46 browser responsibility decomposition: the single authoritative
 * home for teardown mechanics — the fixed Chromium hardening arguments, the
 * fail-closed route/WebSocket policy installation used at launch, the
 * bounded browser/context/tab/broker cleanup with its quiescence
 * postcondition list, and the partial-teardown used for late open failures.
 * The manager keeps when teardown happens; this module owns how it is
 * carried out and proven.
 */
import type {
  Browser,
  BrowserContext,
  CDPSession,
  Page,
  Request,
} from "playwright";
import { chromiumEgressArgs } from "./browser";
import { browserCleanupDeadline, ownedBrowserQuiescent } from "./browser-owned-process";
import { boundedCleanup } from "./browser-operations.js";
import type { EgressBroker, EgressSummary } from "./egress-broker";
import { interactiveRouteDecision } from "./browser-url-policy.js";
import { bounded } from "./browser-primitives.js";
import { safely } from "./browser-primitives.js";

/** Additional browser-process defenses shared by every interactive session. */
export function interactiveChromiumArgs(brokerPort: number): string[] {
  return [
    ...chromiumEgressArgs(brokerPort),
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    "--autoplay-policy=user-gesture-required",
    "--disable-features=MediaRouter,OptimizationHints,InterestFeedContentSuggestions",
  ];
}

export async function installRoutePolicy(
  context: BrowserContext,
  broker: EgressBroker,
  onPolicyBlocked?: (request: Request, reason: string) => void,
): Promise<void> {
  // Backstop for any page whose per-tab WebSocket route has not been
  // installed yet (the async registration window after a popup is adopted):
  // fail closed exactly as before. Registered tabs take precedence in the
  // Playwright dispatcher and are handled by their own tab-scoped route.
  await context.routeWebSocket("**/*", (socket) => {
    broker.note(`WebSocket blocked before destination connection: ${bounded(socket.url(), 300)}`);
    socket.close();
  });
  await context.route("**/*", async (route) => {
    const request = route.request();
    const decision = interactiveRouteDecision(request.resourceType(), request.url());
    if (decision.allowed) {
      await route.continue().catch(() => undefined);
      return;
    }
    const reason = decision.reason ?? "browser request blocked";
    onPolicyBlocked?.(request, reason);
    broker.note(`${reason}: ${bounded(request.url(), 300)}`);
    await route.abort("blockedbyclient").catch(() => undefined);
  });
}

export interface SessionCleanupTabView {
  page: Page;
  humanInputCdp?: CDPSession | undefined;
  closing: boolean;
}

/** Delegated lifecycle view of the session being torn down (the manager's real object). */
export interface SessionCleanupView {
  tabs: Map<string, SessionCleanupTabView>;
  pendingPageClosures: Map<Page, Promise<void>>;
  pendingPageCreations: Set<Promise<void>>;
  pendingWebSocketAdmissions: Set<Promise<void>>;
  context: BrowserContext;
  browser: Browser;
  broker: EgressBroker;
}

export async function cleanupSession(session: SessionCleanupView, deadlineMs: number): Promise<EgressSummary> {
  // Native page WebSockets die with the context close below; the broker
  // drains its own sockets on client disconnect. Diagnostics were already
  // cleared by beginTeardown. Pending WebSocket admissions were aborted by
  // beginTeardown and settle here so no validator continuation outlives
  // teardown.
  // Start every shutdown path immediately and bound them concurrently. Hung
  // tab closes must not delay the broker kill or parent-resource close.
  const pages = [...new Set([
    ...[...session.tabs.values()].map((tab) => tab.page),
    ...session.pendingPageClosures.keys(),
  ])];
  const pendingContainments = [...session.pendingPageClosures.values()];
  const pendingCreations = [...session.pendingPageCreations];
  for (const tab of session.tabs.values()) tab.closing = true;
  // Detach every per-tab human-input bridge session BEFORE the close batch: an
  // attached, Runtime-enabled DevTools session can delay Chromium's renderer
  // exit, so the detach must complete before the browser close is requested.
  // A hung detach is bounded and never fails the whole cleanup (the browser
  // close below still tears the connection down); this only ever fails toward
  // less renewal, never toward spoofing.
  for (const cdp of [...session.tabs.values()].map((tab) => tab.humanInputCdp)) {
    if (!cdp) continue;
    try {
      await boundedCleanup(cdp.detach().catch(() => undefined), deadlineMs, "human input bridge detach");
    } catch {
      // A bounded detach failure must not fail the whole session cleanup: the
      // browser close below still tears the underlying connection down, and
      // the only consequence is that this tab stops renewing from human input
      // (fail-closed toward less renewal, never toward spoofing).
    }
  }
  const pageCloses = pages.map((page) => boundedCleanup(
    page.isClosed() ? Promise.resolve() : page.close({ runBeforeUnload: false }),
    deadlineMs,
    "browser tab close",
  ));
  const operations = await Promise.allSettled([
    ...pageCloses,
    ...pendingContainments.map((closure) => boundedCleanup(closure, deadlineMs, "refused browser page containment")),
    ...pendingCreations.map((creation) => boundedCleanup(creation, deadlineMs, "late browser page creation containment")),
    boundedCleanup(session.context.close(), deadlineMs, "browser context close"),
    boundedCleanup(session.browser.close(), browserCleanupDeadline(session.browser, deadlineMs), "browser process close"),
    boundedCleanup(Promise.allSettled([...session.pendingWebSocketAdmissions]), deadlineMs, "pending websocket admission settlement"),
    boundedCleanup(session.broker.close(), deadlineMs, "egress broker close"),
  ]);
  const operationFailures = operations
    .filter((operation): operation is PromiseRejectedResult => operation.status === "rejected")
    .map((operation) => operation.reason);
  // Closing the context can synchronously discover/refuse a popup after the
  // first snapshot. Drain that bounded late-containment tail before checking
  // ownership so settlement cannot miss a close-event race.
  const lateContainments = [
    ...session.pendingPageClosures.values(),
    ...session.pendingPageCreations,
  ];
  const lateOutcomes = await Promise.allSettled(lateContainments.map((containment) =>
    boundedCleanup(containment, deadlineMs, "late settlement page containment")
  ));
  operationFailures.push(...lateOutcomes
    .filter((operation): operation is PromiseRejectedResult => operation.status === "rejected")
    .map((operation) => operation.reason));
  const brokerOutcome = operations[operations.length - 1];
  const summary = brokerOutcome?.status === "fulfilled" ? brokerOutcome.value as EgressSummary : undefined;
  const stateFailures: unknown[] = [];
  const allKnownPages = new Set([...pages, ...session.pendingPageClosures.keys()]);
  if ([...allKnownPages].some((page) => !page.isClosed())) stateFailures.push(new Error("browser tab remains open"));
  const contextPages = safely(() => session.context.pages(), [] as Page[]);
  if (contextPages.some((page) => !page.isClosed())) stateFailures.push(new Error("browser context still owns an open page"));
  if (session.tabs.size > 0) stateFailures.push(new Error("browser tab registry is not empty"));
  // A rejected/hung page.close promise is not residual ownership once the
  // page, context, and browser postconditions below independently prove it
  // closed. Late page *creation* can still acquire ownership and must drain.
  if (session.pendingPageCreations.size > 0) stateFailures.push(new Error("late browser page creation remains unsettled"));
  if (!ownedBrowserQuiescent(session.browser)) stateFailures.push(new Error("owned browser process disappearance is unconfirmed"));
  if (session.browser.contexts().includes(session.context)) stateFailures.push(new Error("browser context remains registered"));
  if (!session.broker.isQuiescent()) stateFailures.push(new Error("egress broker is not quiescent"));
  // Concurrent parent/child close calls can reject one Playwright command
  // because another already disposed the target. That rejection is harmless
  // only when all independent postconditions prove quiescence. Otherwise keep
  // every operation diagnostic and fail closed.
  if (stateFailures.length > 0 || !summary) {
    throw new AggregateError([...operationFailures, ...stateFailures], "browser/context/tab/broker quiescence was not proven");
  }
  return summary;
}

export async function cleanupPartial(
  browser: Browser | undefined,
  context: BrowserContext | undefined,
  broker: EgressBroker,
  deadlineMs: number,
  lateBrowserCleanup?: Promise<unknown>,
  lateContextCleanup?: Promise<unknown>,
): Promise<void> {
  const results = await Promise.allSettled([
    boundedCleanup(context?.close() ?? Promise.resolve(), deadlineMs, "partial browser context close"),
    boundedCleanup(browser?.close() ?? Promise.resolve(), browserCleanupDeadline(browser, deadlineMs), "partial browser process close"),
    boundedCleanup(broker.close(), deadlineMs, "partial egress broker close"),
    boundedCleanup(lateContextCleanup ?? Promise.resolve(), deadlineMs, "late browser context containment"),
    boundedCleanup(lateBrowserCleanup ?? Promise.resolve(), Math.max(deadlineMs, 10_100), "late browser process containment"),
  ]);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (browser && !ownedBrowserQuiescent(browser)) failures.push({ status: "rejected", reason: new Error("partial browser process disappearance is unconfirmed") });
  if (!broker.isQuiescent()) failures.push({ status: "rejected", reason: new Error("partial broker is not quiescent") });
  if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), "partial BrowserOpen teardown failed");
}
