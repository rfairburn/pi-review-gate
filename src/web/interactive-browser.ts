import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Dialog,
  type Download,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "playwright";
import type { WebFetchConfig } from "../config";
import {
  CLEANUP_DEADLINE_MS,
  MAX_MAIN_DOCUMENT_REDIRECTS,
  assertChromiumAvailable,
  auditEgressLedger,
  chromiumEgressArgs,
} from "./browser";
import {
  EgressBroker,
  type BrokerDial,
  type EgressBrokerObserver,
  type EgressBudgets,
  type EgressSummary,
} from "./egress-broker";
import type { HostResolver } from "./network";
import { defaultHostResolver, validatePublicUrl } from "./network";
import {
  BrowserConfirmationPermits,
  BrowserConsequencePolicy,
  type BrowserConfirmationBinding,
  type BrowserConsequence,
  type BrowserTargetStructure,
} from "./browser-interaction-policy";

export const BROWSER_INTERACTION_SESSION_MAX_CHARS = 256;
export const BROWSER_INTERACTION_TAB_MAX_CHARS = 256;
export const BROWSER_INTERACTION_REF_MAX_CHARS = 512;

/** Hard limits for the initial, observational browser surface. */
export interface InteractiveBrowserLimits {
  maxSessions: number;
  maxTabsPerSession: number;
  maxNavigations: number;
  maxActions: number;
  maxMainDocumentRequests: number;
  maxHistoryEntries: number;
  maxScrollPages: number;
  maxWaitTextChars: number;
  maxWaitPatternChars: number;
  maxWaitMs: number;
  maxSnapshotChars: number;
  maxSnapshotDepth: number;
  maxScreenshotWidth: number;
  maxScreenshotHeight: number;
  maxScreenshotPixels: number;
  maxScreenshotBytes: number;
  maxScreenshotAllocationBytes: number;
  navigationMs: number;
  actionMs: number;
  confirmationMs: number;
  idleMs: number;
  lifetimeMs: number;
  cleanupMs: number;
  maxDistinctHosts: number;
  maxConnections: number;
  maxRequests: number;
  maxConnectionBytes: number;
  maxTotalBytes: number;
}

export const INTERACTIVE_BROWSER_LIMITS: Readonly<InteractiveBrowserLimits> = Object.freeze({
  maxSessions: 4,
  maxTabsPerSession: 4,
  maxNavigations: 12,
  maxActions: 64,
  maxMainDocumentRequests: 32,
  maxHistoryEntries: 32,
  maxScrollPages: 3,
  maxWaitTextChars: 512,
  maxWaitPatternChars: 512,
  maxWaitMs: 10_000,
  maxSnapshotChars: 24_000,
  maxSnapshotDepth: 16,
  maxScreenshotWidth: 2_000,
  maxScreenshotHeight: 2_000,
  maxScreenshotPixels: 4_000_000,
  maxScreenshotBytes: 4 * 1024 * 1024,
  maxScreenshotAllocationBytes: 32 * 1024 * 1024,
  navigationMs: 30_000,
  actionMs: 10_000,
  confirmationMs: 30_000,
  idleMs: 60_000,
  lifetimeMs: 5 * 60_000,
  cleanupMs: CLEANUP_DEADLINE_MS,
  maxDistinctHosts: 16,
  maxConnections: 96,
  maxRequests: 256,
  maxConnectionBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
});

export interface BrowserOpenResult {
  session: string;
  tab: string;
  generation: string;
  url: string;
  title: string;
  status: number;
  limits: Readonly<InteractiveBrowserLimits>;
}

export interface BrowserNavigateResult {
  session: string;
  tab: string;
  generation: string;
  url: string;
  title: string;
  status: number;
  navigationsRemaining: number;
}

export interface BrowserSnapshotResult {
  session: string;
  tab: string;
  generation: string;
  url: string;
  title: string;
  snapshot: string;
  refs: number;
  truncation: {
    truncated: boolean;
    originalChars: number;
    returnedChars: number;
    maxChars: number;
  };
}

export type BrowserScreenshotMode = "viewport" | "element";

export interface BrowserScreenshotMetadata {
  session: string;
  tab: string;
  generation: string;
  url: string;
  title: string;
  mode: BrowserScreenshotMode;
  ref?: string;
  mimeType: "image/png";
  width: number;
  height: number;
  encodedBytes: number;
  limits: {
    maxWidth: number;
    maxHeight: number;
    maxPixels: number;
    maxEncodedBytes: number;
    maxAllocationBytes: number;
  };
}

export interface BrowserScreenshotResult {
  image: Buffer;
  metadata: BrowserScreenshotMetadata;
}

export type BrowserScrollTarget = "page" | "ref_container" | "ref";
export type BrowserScrollDirection = "up" | "down";

export interface BrowserScrollResult {
  session: string;
  tab: string;
  generation: string;
  target: BrowserScrollTarget;
  direction?: BrowserScrollDirection;
  amount: number;
  ref?: string;
  url: string;
}

export type BrowserWaitRequest =
  | { condition: "ref"; ref: string; state: "attached" | "detached" | "visible" | "hidden" }
  | { condition: "text"; text: string; present: boolean }
  | { condition: "url"; url: string; match: "exact" | "prefix" | "pattern" }
  | { condition: "navigation"; state: "commit" | "domcontentloaded" | "load" }
  | { condition: "load"; state: "domcontentloaded" | "load" }
  | { condition: "network_quiet" }
  | { condition: "duration"; durationMs: number };

export interface BrowserWaitResult {
  session: string;
  tab: string;
  generation: string;
  condition: BrowserWaitRequest["condition"];
  satisfied: true;
  elapsedMs: number;
  url: string;
}

export type BrowserHistoryOperation = "list" | "back" | "forward" | "reload";
export interface BrowserHistoryResult {
  session: string;
  tab: string;
  generation: string;
  operation: BrowserHistoryOperation;
  url: string;
  title: string;
  entries: Array<{ index: number; url: string; generation: string; current: boolean }>;
  truncated: boolean;
  navigationsRemaining: number;
}

export type BrowserTabsOperation = "list" | "open" | "switch" | "close";
export interface BrowserTabsResult {
  session: string;
  operation: BrowserTabsOperation;
  activeTab: string | null;
  tabs: Array<{ tab: string; generation: string; url: string; active: boolean }>;
  openedTab?: string;
  closedTab?: string;
  sessionClosed: boolean;
  tabsRemaining: number;
  maxTabs: number;
}

export type BrowserInteractionEffectState = "not_started" | "started" | "completed" | "unknown";

export interface BrowserInteractionEffects {
  navigation: "observed" | "not_observed";
  observedPopupTabs: number;
  observedOverflowPopupsClosed: number;
  observedDialogsDismissed: number;
  download: "not_observed" | "canceled";
  accounting: "bounded_stable" | "bounded_uncertain";
}

export interface BrowserInteractionResult {
  session: string;
  tab: string;
  generation: string;
  operation: "hover" | "click";
  consequence: BrowserConsequence | "observational";
  confirmed: boolean;
  effect: BrowserInteractionEffectState;
  effects: BrowserInteractionEffects;
  url: string;
}

export interface BrowserClickConfirmationRequest {
  title: string;
  message: string;
}

export type BrowserClickConfirmation = (request: BrowserClickConfirmationRequest) => Promise<boolean>;

export interface BrowserCloseResult {
  session: string;
  closed: true;
  alreadyClosed: boolean;
  quiescent: true;
  broker: (Pick<EgressSummary, "budgetAborts" | "refusals"> & { connections: number }) | null;
  diagnosticsRetained: boolean;
}

interface InteractiveBrowserDependencies {
  resolveHostname?: HostResolver;
  brokerDial?: BrokerDial;
  launch?: BrowserType["launch"];
  now?: () => number;
  randomHandle?: (kind: "session" | "tab" | "generation" | "ref") => string;
  consequencePolicy?: BrowserConsequencePolicy;
  confirmationPermits?: BrowserConfirmationPermits;
  limits?: Partial<InteractiveBrowserLimits>;
}

interface OpeningOperation {
  controller: AbortController;
  settled: Promise<void>;
  settle(): void;
  teardownFailure?: Error;
}

interface BrowserTab {
  handle: string;
  generation: string;
  page: Page;
  semanticRefs: Map<string, { generation: string; playwrightRef: string }>;
  history: Array<{ url: string; identityUrl: string; generation: string }>;
  historyIndex: number;
  pendingHistoryIndex?: number;
  lastCommittedUrl: string;
  documentRequestPending: boolean;
  closing: boolean;
}

interface InteractionCapture {
  dialogs: number;
  downloads: number;
  popupTabs: Set<string>;
  overflowPopups: number;
  events: number;
  settlements: Promise<void>[];
}

interface Session {
  handle: string;
  activeTab: string;
  tabs: Map<string, BrowserTab>;
  pendingPageClosures: Map<Page, Promise<void>>;
  pendingPageCreations: Set<Promise<void>>;
  browser: Browser;
  context: BrowserContext;
  broker: EgressBroker;
  createdAt: number;
  lastUsedAt: number;
  navigations: number;
  actions: number;
  mainDocumentRequests: number;
  operationActive: boolean;
  interactionCapture?: InteractionCapture;
  fatalError?: Error;
  teardown?: Promise<BrowserCloseResult>;
  expiryTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
}

const MAX_TOMBSTONES = 32;
const SAFE_LOCAL_PROTOCOLS = new Set(["about:", "blob:", "data:"]);

/**
 * Process-local owner for isolated interactive browser sessions. Nothing is
 * persisted: opaque handles and all authenticated broker credentials die with
 * this extension process.
 */
export class InteractiveBrowserManager {
  private readonly sessions = new Map<string, Session>();
  private readonly closedTombstones = new Map<string, BrowserCloseResult>();
  private readonly failedTombstones = new Map<string, Error>();
  private readonly openings = new Set<OpeningOperation>();
  private readonly handleAuthenticationKey = randomBytes(32);
  private opening = 0;
  private shuttingDown = false;
  private shutdownFailure?: Error;
  private readonly resolveHostname: HostResolver;
  private readonly launch: BrowserType["launch"];
  private readonly now: () => number;
  private readonly randomHandle: NonNullable<InteractiveBrowserDependencies["randomHandle"]>;
  private readonly consequencePolicy: BrowserConsequencePolicy;
  private readonly confirmationPermits: BrowserConfirmationPermits;
  readonly limits: Readonly<InteractiveBrowserLimits>;

  constructor(
    private config: WebFetchConfig,
    private readonly dependencies: InteractiveBrowserDependencies = {},
  ) {
    this.resolveHostname = dependencies.resolveHostname ?? defaultHostResolver;
    this.launch = dependencies.launch ?? chromium.launch.bind(chromium);
    this.now = dependencies.now ?? Date.now;
    this.randomHandle = dependencies.randomHandle ?? ((kind) => `browser_${kind}_${randomBytes(24).toString("base64url")}`);
    this.consequencePolicy = dependencies.consequencePolicy ?? new BrowserConsequencePolicy();
    this.confirmationPermits = dependencies.confirmationPermits
      ?? new BrowserConfirmationPermits(this.now, () => randomBytes(24).toString("base64url"), dependencies.limits?.confirmationMs ?? INTERACTIVE_BROWSER_LIMITS.confirmationMs);
    const requestedLimits = { ...INTERACTIVE_BROWSER_LIMITS, ...(dependencies.limits ?? {}) };
    this.limits = Object.freeze({
      ...requestedLimits,
      maxTabsPerSession: clampedTestLimit(requestedLimits.maxTabsPerSession, INTERACTIVE_BROWSER_LIMITS.maxTabsPerSession),
      maxHistoryEntries: clampedTestLimit(requestedLimits.maxHistoryEntries, INTERACTIVE_BROWSER_LIMITS.maxHistoryEntries),
      maxScrollPages: clampedTestLimit(requestedLimits.maxScrollPages, INTERACTIVE_BROWSER_LIMITS.maxScrollPages),
      maxWaitTextChars: clampedTestLimit(requestedLimits.maxWaitTextChars, INTERACTIVE_BROWSER_LIMITS.maxWaitTextChars),
      maxWaitPatternChars: clampedTestLimit(requestedLimits.maxWaitPatternChars, INTERACTIVE_BROWSER_LIMITS.maxWaitPatternChars),
      maxWaitMs: clampedTestLimit(requestedLimits.maxWaitMs, INTERACTIVE_BROWSER_LIMITS.maxWaitMs),
    });
  }

  updateConfig(config: WebFetchConfig): void {
    this.config = config;
  }

  async open(url: string, signal?: AbortSignal): Promise<BrowserOpenResult> {
    if (this.shuttingDown) throw new Error("Interactive browser manager is shut down.");
    if (this.sessions.size + this.opening >= this.limits.maxSessions) {
      throw new Error(`Browser session limit (${this.limits.maxSessions}) reached; close a session before opening another.`);
    }
    // Reserve enough bounded failure-state capacity for every open session to
    // end in an unconfirmed teardown without evicting safety information.
    if (this.failedTombstones.size + this.sessions.size + this.opening >= MAX_TOMBSTONES) {
      throw new Error("Browser session creation is disabled because the bounded unconfirmed-teardown registry is full.");
    }
    this.opening += 1;
    const controller = new AbortController();
    let settleOpening!: () => void;
    const opening: OpeningOperation = {
      controller,
      settled: new Promise<void>((resolve) => { settleOpening = resolve; }),
      settle: () => settleOpening(),
    };
    this.openings.add(opening);
    const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const operation = new OperationDeadline("BrowserOpen", this.limits.navigationMs, operationSignal);
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let broker: EgressBroker | undefined;
    let launchPromise: Promise<Browser> | undefined;
    let contextPromise: Promise<BrowserContext> | undefined;
    let resourcesTransferredToSession = false;
    try {
      // This is a no-dial preflight. The broker independently validates and
      // pins the actual browser request before opening its destination socket.
      const requested = await operation.run(validatePublicUrl(url, this.resolveHostname), "URL validation");
      assertChromiumAvailable();
      const auth = {
        username: `pi-browser-${randomBytes(8).toString("hex")}`,
        password: randomBytes(32).toString("base64url"),
      };
      let pendingFatal: ((error: Error) => void) | undefined;
      const observer: EgressBrokerObserver = {
        policyFailure: (_reason, diagnostic) => pendingFatal?.(new Error(`Interactive browser egress policy failed: ${bounded(diagnostic, 500)}`)),
      };
      broker = new EgressBroker(
        this.resolveHostname,
        this.dependencies.brokerDial,
        this.brokerBudgets(),
        auth,
        observer,
      );
      const port = await operation.run(broker.start(), "egress broker startup");
      launchPromise = this.launch({
        headless: true,
        timeout: operation.remainingMs(),
        args: interactiveChromiumArgs(port),
        proxy: { server: `http://127.0.0.1:${port}`, username: auth.username, password: auth.password },
      });
      browser = await operation.run(launchPromise, "Chromium startup");
      contextPromise = browser.newContext({
        acceptDownloads: false,
        javaScriptEnabled: true,
        viewport: { width: 1_280, height: 720 },
        deviceScaleFactor: 1,
        serviceWorkers: "block",
        permissions: [],
        userAgent: this.config.userAgent,
      });
      context = await operation.run(contextPromise, "browser context creation");
      context.setDefaultTimeout(this.limits.actionMs);
      context.setDefaultNavigationTimeout(this.limits.navigationMs);
      await operation.run(context.clearPermissions(), "permission denial");
      await operation.run(installRoutePolicy(context, broker), "network route policy installation");

      const page = await operation.run(context.newPage(), "browser tab creation");
      const primaryTab: BrowserTab = {
        handle: this.uniqueHandle("tab"),
        generation: this.uniqueHandle("generation"),
        page,
        semanticRefs: new Map(),
        history: [],
        historyIndex: -1,
        lastCommittedUrl: page.url(),
        documentRequestPending: false,
        closing: false,
      };
      const session: Session = {
        handle: this.uniqueHandle("session"),
        activeTab: primaryTab.handle,
        tabs: new Map([[primaryTab.handle, primaryTab]]),
        pendingPageClosures: new Map(),
        pendingPageCreations: new Set(),
        browser,
        context,
        broker,
        createdAt: this.now(),
        lastUsedAt: this.now(),
        navigations: 0,
        actions: 0,
        mainDocumentRequests: 0,
        operationActive: true,
      };
      pendingFatal = (error) => this.failSession(session, error);
      this.installPageGuards(session, primaryTab);
      browser.on("disconnected", () => {
        if (!session.teardown) this.failSession(session, new Error("Browser process disconnected unexpectedly; teardown started."));
      });
      context.on("page", (candidate) => {
        if (this.tabForPage(session, candidate)) return;
        const adopted = this.adoptPopup(session, candidate);
        const capture = session.interactionCapture;
        if (!capture) return;
        capture.events += 1;
        if (adopted) {
          capture.popupTabs.add(adopted.handle);
        } else {
          capture.overflowPopups += 1;
          const closure = session.pendingPageClosures.get(candidate);
          if (closure) capture.settlements.push(closure);
        }
      });
      this.sessions.set(session.handle, session);
      resourcesTransferredToSession = true;
      this.armTimers(session);
      try {
        const navigation = await this.navigateSession(session, primaryTab, requested.href, operation, true);
        session.operationActive = false;
        this.touch(session);
        return { ...navigation, limits: this.limits };
      } catch (error) {
        session.operationActive = false;
        try {
          await this.failAndWait(session, asError(error));
        } catch (cleanupError) {
          this.recordOpeningTeardownFailure(opening, asError(cleanupError));
          throw cleanupError;
        }
        throw error;
      }
    } catch (error) {
      if (broker && !resourcesTransferredToSession) {
        // If cancellation won a race, retain and await cleanup of every late
        // startup result. The attached continuations remain active even when
        // the cleanup deadline expires, so no late browser is left unmanaged.
        const lateContextCleanup = contextPromise && !context
          ? contextPromise.then((lateContext) => lateContext.close(), () => undefined)
          : undefined;
        const lateBrowserCleanup = launchPromise && !browser
          ? launchPromise.then((lateBrowser) => lateBrowser.close(), () => undefined)
          : undefined;
        await cleanupPartial(
          browser,
          context,
          broker,
          this.limits.cleanupMs,
          lateBrowserCleanup,
          lateContextCleanup,
        ).catch((cleanupError) => {
          const failure = new AggregateError(
            [error, cleanupError],
            "BrowserOpen failed and teardown could not be confirmed.",
          );
          this.recordOpeningTeardownFailure(opening, failure);
          throw failure;
        });
      }
      throw error;
    } finally {
      operation.dispose();
      this.opening -= 1;
      this.openings.delete(opening);
      opening.settle();
    }
  }

  async navigate(sessionHandle: string, tabHandle: string, url: string, signal?: AbortSignal): Promise<BrowserNavigateResult> {
    const { session, tab } = this.requireTab(sessionHandle, tabHandle);
    return this.operate(session, signal, async () => {
      const operation = new OperationDeadline("BrowserNavigate", this.limits.navigationMs, signal);
      try {
        return await this.navigateSession(session, tab, url, operation, false);
      } finally {
        operation.dispose();
      }
    }, true);
  }

  async snapshot(sessionHandle: string, tabHandle: string, maxChars: number, signal?: AbortSignal): Promise<BrowserSnapshotResult> {
    const { session, tab } = this.requireTab(sessionHandle, tabHandle);
    return this.operate(session, signal, async () => {
      const operation = new OperationDeadline("BrowserSnapshot", this.limits.actionMs, signal);
      try {
        const capturedGeneration = tab.generation;
        const limit = Math.min(Math.max(1_000, maxChars), this.limits.maxSnapshotChars);
        const raw = await operation.run(tab.page.ariaSnapshot({
          mode: "ai",
          depth: this.limits.maxSnapshotDepth,
          boxes: false,
          timeout: operation.remainingMs(),
          signal: operation.signal,
        }), "ARIA snapshot acquisition");
        const capturedRefs = new Map<string, { generation: string; playwrightRef: string }>();
        let transformedDelta = 0;
        const semantic = raw.replace(/\[ref=([^\]\r\n]+)\]/g, (match, playwrightRef: string, rawOffset: number) => {
          const opaqueRef = `${capturedGeneration}_${this.uniqueHandle("ref")}`;
          const replacement = `[ref=${opaqueRef}]`;
          const transformedStart = rawOffset + transformedDelta;
          transformedDelta += replacement.length - match.length;
          // Never retain refs beyond the bounded model-visible output. This
          // keeps the per-session capability map bounded even if Playwright
          // produces a very large semantic tree.
          if (transformedStart + replacement.length <= limit && /^(?:f\d+)?e\d+$/.test(playwrightRef)) {
            capturedRefs.set(opaqueRef, { generation: capturedGeneration, playwrightRef });
          }
          return replacement;
        });
        const snapshot = semantic.slice(0, limit);
        const snapshotUrl = publicPageUrl(tab.page.url());
        const title = bounded(await operation.run(tab.page.title(), "browser title read"), 500);
        if (tab.generation !== capturedGeneration) {
          throw new Error("Browser document changed during semantic snapshot capture; snapshot rejected.");
        }
        // Only refs wholly present in the returned, bounded snapshot remain
        // current. A new snapshot replaces this map rather than accumulating
        // page-controlled references for the session lifetime.
        tab.semanticRefs.clear();
        for (const [opaqueRef, ref] of capturedRefs) tab.semanticRefs.set(opaqueRef, ref);
        return {
          session: session.handle,
          tab: tab.handle,
          generation: capturedGeneration,
          url: snapshotUrl,
          title,
          snapshot,
          refs: tab.semanticRefs.size,
          truncation: {
            truncated: semantic.length > snapshot.length,
            originalChars: semantic.length,
            returnedChars: snapshot.length,
            maxChars: limit,
          },
        };
      } finally {
        operation.dispose();
      }
    }, true);
  }

  async screenshot(
    sessionHandle: string,
    tabHandle: string,
    mode: BrowserScreenshotMode,
    ref: string | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserScreenshotResult> {
    if (mode !== "viewport" && mode !== "element") {
      throw new Error("BrowserScreenshot mode must be viewport or element.");
    }
    const { session, tab } = this.requireTab(sessionHandle, tabHandle);
    return this.operate(session, signal, async () => {
      const operation = new OperationDeadline("BrowserScreenshot", this.limits.actionMs, signal);
      try {
        const capturedGeneration = tab.generation;
        let image: Buffer;
        if (mode === "viewport") {
          if (ref !== undefined) throw new Error("BrowserScreenshot viewport mode does not accept ref.");
          const viewport = tab.page.viewportSize();
          if (!viewport) throw new Error("BrowserScreenshot could not determine the bounded browser viewport.");
          assertScreenshotDimensions(viewport.width, viewport.height, this.limits, "viewport");
          image = await operation.run(tab.page.screenshot({
            type: "png",
            fullPage: false,
            animations: "disabled",
            caret: "hide",
            scale: "css",
            timeout: operation.remainingMs(),
          }), "viewport screenshot acquisition");
        } else {
          if (!ref) throw new Error("BrowserScreenshot element mode requires a current ref from BrowserSnapshot.");
          const semanticRef = tab.semanticRefs.get(ref);
          if (!semanticRef || semanticRef.generation !== capturedGeneration) throw invalidRefError();
          const locator = tab.page.locator(`aria-ref=${semanticRef.playwrightRef}`);
          await operation.run(locator.scrollIntoViewIfNeeded({
            timeout: operation.remainingMs(),
            signal: operation.signal,
          }), "element positioning");
          const box = await operation.run(locator.boundingBox({ timeout: operation.remainingMs() }), "element bounds acquisition");
          if (!box) throw new Error("BrowserScreenshot element is not currently visible; take a fresh BrowserSnapshot and retry.");
          const viewport = tab.page.viewportSize();
          if (!viewport) throw new Error("BrowserScreenshot could not determine the bounded browser viewport.");
          const clip = boundedElementClip(box, viewport, this.limits);
          // Capture an immutable, already-validated clip rather than asking
          // Locator.screenshot to resolve the element again. The element may
          // resize or move after boundingBox (including animation changes),
          // but it cannot expand the encoded image or browser allocation
          // beyond these fixed dimensions. Leaving animations enabled also
          // avoids Playwright fast-forwarding a finite animation after the
          // preflight and changing the element's size.
          image = await operation.run(tab.page.screenshot({
            type: "png",
            fullPage: false,
            clip,
            animations: "allow",
            caret: "hide",
            scale: "css",
            timeout: operation.remainingMs(),
          }), "bounded element clip acquisition");
        }

        throwIfAborted(operation.signal);
        const dimensions = validatePngScreenshot(image, this.limits);
        const snapshotUrl = publicPageUrl(tab.page.url());
        const title = bounded(await operation.run(tab.page.title(), "browser title read"), 500);
        if (tab.generation !== capturedGeneration) {
          throw new Error("Browser document changed during screenshot capture; screenshot rejected.");
        }
        return {
          image,
          metadata: {
            session: session.handle,
            tab: tab.handle,
            generation: capturedGeneration,
            url: snapshotUrl,
            title,
            mode,
            ...(mode === "element" ? { ref } : {}),
            mimeType: "image/png",
            width: dimensions.width,
            height: dimensions.height,
            encodedBytes: image.byteLength,
            limits: {
              maxWidth: this.limits.maxScreenshotWidth,
              maxHeight: this.limits.maxScreenshotHeight,
              maxPixels: this.limits.maxScreenshotPixels,
              maxEncodedBytes: this.limits.maxScreenshotBytes,
              maxAllocationBytes: this.limits.maxScreenshotAllocationBytes,
            },
          },
        };
      } finally {
        operation.dispose();
      }
    }, true);
  }

  async scroll(
    sessionHandle: string,
    tabHandle: string,
    target: BrowserScrollTarget,
    direction: BrowserScrollDirection | undefined,
    amount: number,
    ref: string | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserScrollResult> {
    if (target !== "page" && target !== "ref_container" && target !== "ref") {
      throw new Error("BrowserScroll target must be page, ref_container, or ref.");
    }
    if (!Number.isInteger(amount) || amount < 1 || amount > this.limits.maxScrollPages) {
      throw new Error(`BrowserScroll amount must be an integer from 1-${this.limits.maxScrollPages}.`);
    }
    if (target === "ref") {
      if (!ref || direction !== undefined || amount !== 1) {
        throw new Error("BrowserScroll ref target requires only a current ref (amount must be 1 and direction omitted).");
      }
    } else if (direction !== "up" && direction !== "down") {
      throw new Error("BrowserScroll page and ref_container targets require direction up or down.");
    }
    if (target === "page" && ref !== undefined) throw new Error("BrowserScroll page target does not accept ref.");
    if (target === "ref_container" && !ref) throw new Error("BrowserScroll ref_container target requires a current ref.");

    const { session, tab } = this.requireTab(sessionHandle, tabHandle);
    return this.operate(session, signal, async () => {
      const operation = new OperationDeadline("BrowserScroll", this.limits.actionMs, signal);
      try {
        const generation = tab.generation;
        if (target === "ref") {
          const locator = this.currentRefLocator(tab, ref!);
          await operation.run(locator.scrollIntoViewIfNeeded({ timeout: operation.remainingMs(), signal: operation.signal }), "semantic ref positioning");
        } else {
          const viewport = tab.page.viewportSize();
          if (!viewport) throw new Error("BrowserScroll could not determine the bounded browser viewport.");
          const delta = Math.max(1, Math.floor(viewport.height * 0.8)) * amount * (direction === "up" ? -1 : 1);
          if (target === "page") {
            await operation.run(tab.page.evaluate((dy) => {
              globalThis.scrollBy({ top: dy, left: 0, behavior: "instant" });
            }, delta), "bounded page scroll");
          } else {
            const locator = this.currentRefLocator(tab, ref!);
            await operation.run(locator.evaluate((element, dy) => {
              let candidate: Element | null = element;
              while (candidate) {
                const style = globalThis.getComputedStyle(candidate);
                if (/(auto|scroll)/.test(style.overflowY) && candidate.scrollHeight > candidate.clientHeight) {
                  candidate.scrollBy({ top: dy, left: 0, behavior: "instant" });
                  return;
                }
                candidate = candidate.parentElement;
              }
              throw new Error("Current semantic ref has no scrollable container.");
            }, delta), "bounded ref-container scroll");
          }
        }
        throwIfAborted(operation.signal);
        if (tab.generation !== generation) throw new Error("Browser document changed during scroll; result rejected.");
        return {
          session: session.handle,
          tab: tab.handle,
          generation,
          target,
          ...(direction ? { direction } : {}),
          amount,
          ...(ref ? { ref } : {}),
          url: publicPageUrl(tab.page.url()),
        };
      } finally {
        operation.dispose();
      }
    }, true);
  }

  async hover(
    sessionHandle: string,
    tabHandle: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<BrowserInteractionResult> {
    try {
      return await this.interact(sessionHandle, tabHandle, ref, "hover", undefined, signal);
    } catch (error) {
      throw normalizedInteractionFailure("BrowserHover", error);
    }
  }

  async click(
    sessionHandle: string,
    tabHandle: string,
    ref: string,
    confirmation?: BrowserClickConfirmation,
    signal?: AbortSignal,
  ): Promise<BrowserInteractionResult> {
    try {
      return await this.interact(sessionHandle, tabHandle, ref, "click", confirmation, signal);
    } catch (error) {
      throw normalizedInteractionFailure("BrowserClick", error);
    }
  }

  private async interact(
    sessionHandle: string,
    tabHandle: string,
    ref: string,
    operationName: "hover" | "click",
    confirmation: BrowserClickConfirmation | undefined,
    signal: AbortSignal | undefined,
  ): Promise<BrowserInteractionResult> {
    assertBoundedInteractionCapability(sessionHandle, BROWSER_INTERACTION_SESSION_MAX_CHARS);
    assertBoundedInteractionCapability(tabHandle, BROWSER_INTERACTION_TAB_MAX_CHARS);
    assertBoundedInteractionCapability(ref, BROWSER_INTERACTION_REF_MAX_CHARS);
    const { session, tab } = this.requireTab(sessionHandle, tabHandle);
    return this.operate(session, signal, async () => {
      const name = operationName === "click" ? "BrowserClick" : "BrowserHover";
      const operation = new OperationDeadline(
        name,
        operationName === "click" ? this.limits.confirmationMs : this.limits.actionMs,
        signal,
      );
      const capturedGeneration = tab.generation;
      const capturedOrigin = interactionIdentityUrl(tab.page.url());
      let started = false;
      let capture: InteractionCapture | undefined;
      try {
        const locator = this.currentRefLocator(tab, ref);
        await operation.run(locator.waitFor({ state: "visible", timeout: operation.remainingMs() }), "semantic target validation");
        const structure = await operation.run(readTargetStructure(locator), "structural consequence inspection");
        const decision = this.consequencePolicy.classify(structure);
        let confirmed = false;

        if (operationName === "click" && decision.consequential) {
          if (!confirmation) {
            throw new Error("BrowserClick not_started: this structurally consequential or unknown action requires an interactive Pi confirmation; background or no-UI execution is rejected.");
          }
          const binding = this.confirmationBinding(session, tab, ref, capturedOrigin, structure, decision.consequence, decision.destination);
          const permit = this.confirmationPermits.issue(binding);
          let approved = false;
          try {
            approved = await operation.run(confirmation(confirmationPrompt(decision.consequence, capturedOrigin, decision.destination)), "interactive confirmation");
          } catch {
            this.confirmationPermits.revoke(permit);
            throw new Error("BrowserClick not_started: interactive confirmation was unavailable or cancelled.");
          }
          if (!approved) {
            this.confirmationPermits.revoke(permit);
            throw new Error("BrowserClick not_started: interactive confirmation was denied.");
          }

          throwIfAborted(operation.signal);
          if (session.teardown || session.fatalError || tab.page.isClosed()) {
            this.confirmationPermits.revoke(permit);
            throw new Error("BrowserClick not_started: the browser session changed or closed after confirmation.");
          }
          if (tab.generation !== capturedGeneration || interactionIdentityUrl(tab.page.url()) !== capturedOrigin) {
            this.invalidateInteractionRefs(tab, capturedGeneration);
            this.confirmationPermits.revoke(permit);
            throw new Error("BrowserClick not_started: the document or origin changed after confirmation; take a fresh BrowserSnapshot.");
          }
          const revalidatedStructure = await operation.run(readTargetStructure(this.currentRefLocator(tab, ref)), "post-confirmation target revalidation");
          const revalidatedDecision = this.consequencePolicy.classify(revalidatedStructure);
          const rebound = this.confirmationBinding(
            session,
            tab,
            ref,
            capturedOrigin,
            revalidatedStructure,
            revalidatedDecision.consequence,
            revalidatedDecision.destination,
          );
          if (!this.confirmationPermits.consume(permit, rebound)) {
            this.invalidateInteractionRefs(tab, capturedGeneration);
            throw new Error("BrowserClick not_started: the confirmed target or consequence changed; take a fresh BrowserSnapshot.");
          }
          confirmed = true;
        } else if (operationName === "click") {
          // Silent paths receive the same immediate structural revalidation as
          // confirmed paths. Any loss of proof converts to a no-action failure,
          // never to an implicit confirmation bypass.
          if (tab.generation !== capturedGeneration || interactionIdentityUrl(tab.page.url()) !== capturedOrigin) {
            this.invalidateInteractionRefs(tab, capturedGeneration);
            throw new Error("BrowserClick not_started: the document or origin changed before controlled activation; take a fresh BrowserSnapshot.");
          }
          const revalidatedStructure = await operation.run(readTargetStructure(this.currentRefLocator(tab, ref)), "safe-target revalidation");
          const revalidatedDecision = this.consequencePolicy.classify(revalidatedStructure);
          if (
            revalidatedDecision.consequential
            || revalidatedDecision.consequence !== decision.consequence
            || revalidatedDecision.destination !== decision.destination
            || this.consequencePolicy.fingerprint(revalidatedStructure) !== this.consequencePolicy.fingerprint(structure)
          ) {
            this.invalidateInteractionRefs(tab, capturedGeneration);
            throw new Error("BrowserClick not_started: the silent target or consequence changed; take a fresh BrowserSnapshot.");
          }
        }

        capture = {
          dialogs: 0,
          downloads: 0,
          popupTabs: new Set(),
          overflowPopups: 0,
          events: 0,
          settlements: [],
        };
        session.interactionCapture = capture;
        started = true;
        if (operationName === "hover") {
          await operation.run(locator.hover({ timeout: operation.remainingMs() }), "semantic hover dispatch");
        } else if (decision.consequence === "ordinary_navigation" && decision.destination) {
          // Do not dispatch page-controlled click listeners for a silent link.
          // Activate the freshly revalidated HTTP(S) destination through the
          // existing brokered navigation path instead.
          await this.navigateSession(session, tab, decision.destination, operation, false);
        } else if (decision.consequence === "local_disclosure") {
          // Toggle only the structurally proven native details state. Supplying
          // a second, fixed argument distinguishes this internal operation from
          // target-structure reads and exposes no caller-provided script.
          await operation.run(locator.evaluate((element, expectedTag) => {
            if (expectedTag !== "summary" || element.tagName.toLocaleLowerCase("en-US") !== expectedTag) {
              throw new Error("Disclosure target changed.");
            }
            const details = element.parentElement;
            if (!details || details.tagName.toLocaleLowerCase("en-US") !== "details") {
              throw new Error("Disclosure container changed.");
            }
            (details as HTMLDetailsElement).open = !(details as HTMLDetailsElement).open;
          }, "summary"), "controlled local disclosure");
        } else {
          await operation.run(locator.click({ timeout: operation.remainingMs() }), "confirmed semantic click dispatch");
        }
        const accounting = await accountInteractionEffects(capture, operation);
        if (session.fatalError) throw session.fatalError;

        const navigated = tab.generation !== capturedGeneration || interactionIdentityUrl(tab.page.url()) !== capturedOrigin;
        this.invalidateInteractionRefs(tab, capturedGeneration);
        return {
          session: session.handle,
          tab: tab.handle,
          generation: tab.generation,
          operation: operationName,
          consequence: operationName === "hover" ? "observational" : decision.consequence,
          confirmed,
          effect: "completed",
          effects: {
            navigation: navigated ? "observed" : "not_observed",
            observedPopupTabs: capture.popupTabs.size,
            observedOverflowPopupsClosed: capture.overflowPopups,
            observedDialogsDismissed: capture.dialogs,
            download: capture.downloads > 0 ? "canceled" : "not_observed",
            accounting,
          },
          url: redactedInteractionUrl(tab.page.url()),
        };
      } catch (error) {
        if (!started) throw error;
        this.invalidateInteractionRefs(tab, capturedGeneration);
        const failure = new Error(`${name} failed after dispatch; effect status is unknown and no rollback is claimed.`);
        let containment = "confirmed";
        try { await this.failAndWait(session, failure); }
        catch { containment = "unconfirmed"; }
        throw new Error(`${failure.message} Session teardown is ${containment}.`);
      } finally {
        if (session.interactionCapture === capture) session.interactionCapture = undefined;
        operation.dispose();
      }
    });
  }

  async wait(
    sessionHandle: string,
    tabHandle: string,
    request: BrowserWaitRequest,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BrowserWaitResult> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.limits.maxWaitMs) {
      throw new Error(`BrowserWait timeoutMs must be an integer from 1-${this.limits.maxWaitMs}.`);
    }
    const { session, tab } = this.requireTab(sessionHandle, tabHandle);
    return this.operate(session, signal, async () => {
      const operation = new OperationDeadline("BrowserWait", timeoutMs, signal);
      const started = this.now();
      const generation = tab.generation;
      try {
        switch (request.condition) {
          case "ref": {
            if (!request.ref || !["attached", "detached", "visible", "hidden"].includes(request.state)) {
              throw new Error("BrowserWait ref condition requires a current ref and an allowlisted state.");
            }
            await operation.run(this.currentRefLocator(tab, request.ref).waitFor({
              state: request.state,
              timeout: operation.remainingMs(),
            }), "semantic ref state wait");
            break;
          }
          case "text": {
            if (!request.text || request.text.length > this.limits.maxWaitTextChars) {
              throw new Error(`BrowserWait text must contain 1-${this.limits.maxWaitTextChars} characters.`);
            }
            const visibleMatches = tab.page.getByText(request.text, { exact: false }).filter({ visible: true });
            await operation.run(visibleMatches.first().waitFor({
              // Presence means at least one visible literal-text match;
              // absence means no visible match anywhere in the locator set.
              state: request.present ? "attached" : "hidden",
              timeout: operation.remainingMs(),
            }), "bounded text wait");
            break;
          }
          case "url": {
            if (!request.url || request.url.length > this.limits.maxWaitPatternChars) {
              throw new Error(`BrowserWait URL value must contain 1-${this.limits.maxWaitPatternChars} characters.`);
            }
            const matches = urlWaitMatcher(request.match, request.url);
            await operation.run(tab.page.waitForURL((url) => matches(url.href), {
              timeout: operation.remainingMs(),
              waitUntil: "commit",
            }), "URL wait");
            break;
          }
          case "navigation":
            if (request.state !== "commit" && request.state !== "domcontentloaded" && request.state !== "load") {
              throw new Error("BrowserWait navigation state must be commit, domcontentloaded, or load.");
            }
            await operation.run(tab.page.waitForNavigation({
              waitUntil: request.state,
              timeout: operation.remainingMs(),
            }), "navigation completion wait");
            break;
          case "load":
            if (request.state !== "domcontentloaded" && request.state !== "load") {
              throw new Error("BrowserWait load state must be domcontentloaded or load.");
            }
            await operation.run(tab.page.waitForLoadState(request.state, { timeout: operation.remainingMs() }), "load completion wait");
            break;
          case "network_quiet":
            await operation.run(tab.page.waitForLoadState("networkidle", { timeout: operation.remainingMs() }), "bounded network quiet wait");
            break;
          case "duration":
            if (!Number.isInteger(request.durationMs) || request.durationMs < 1 || request.durationMs > Math.min(2_000, timeoutMs)) {
              throw new Error(`BrowserWait durationMs must be an integer from 1-${Math.min(2_000, timeoutMs)}.`);
            }
            await operation.run(tab.page.waitForTimeout(request.durationMs), "short duration wait");
            break;
          default:
            throw new Error("BrowserWait condition is not allowlisted.");
        }
        throwIfAborted(operation.signal);
        if (tab.generation !== generation && request.condition !== "url" && request.condition !== "navigation" && request.condition !== "load" && request.condition !== "network_quiet") {
          throw new Error("Browser document changed while waiting; condition result rejected.");
        }
        return {
          session: session.handle,
          tab: tab.handle,
          generation: tab.generation,
          condition: request.condition,
          satisfied: true,
          elapsedMs: Math.max(0, this.now() - started),
          url: publicPageUrl(tab.page.url()),
        };
      } finally {
        operation.dispose();
      }
    });
  }

  async history(
    sessionHandle: string,
    tabHandle: string,
    operationName: BrowserHistoryOperation,
    maxEntries: number,
    signal?: AbortSignal,
  ): Promise<BrowserHistoryResult> {
    if (!["list", "back", "forward", "reload"].includes(operationName)) throw new Error("BrowserHistory operation is not allowlisted.");
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > this.limits.maxHistoryEntries) {
      throw new Error(`BrowserHistory maxEntries must be an integer from 1-${this.limits.maxHistoryEntries}.`);
    }
    const { session, tab } = this.requireTab(sessionHandle, tabHandle);
    const traversalTarget = operationName === "back"
      ? tab.historyIndex - 1
      : operationName === "forward" ? tab.historyIndex + 1 : undefined;
    if (traversalTarget !== undefined && (traversalTarget < 0 || traversalTarget >= tab.history.length)) {
      throw new Error(`BrowserHistory cannot go ${operationName}; no bounded session-local entry exists.`);
    }
    return this.operate(session, signal, async () => {
      const deadlineMs = operationName === "list" ? this.limits.actionMs : this.limits.navigationMs;
      const operation = new OperationDeadline("BrowserHistory", deadlineMs, signal);
      try {
        if (operationName !== "list") {
          this.consumeNavigation(session);
          const beforeUrl = tab.page.url();
          let response: Response | null;
          if (operationName === "reload") {
            tab.pendingHistoryIndex = tab.historyIndex;
            try {
              response = await operation.run(tab.page.reload({ waitUntil: "domcontentloaded", timeout: operation.remainingMs() }), "history reload");
            } finally {
              tab.pendingHistoryIndex = undefined;
            }
          } else {
            const target = traversalTarget!;
            tab.pendingHistoryIndex = target;
            try {
              response = await operation.run(
                operationName === "back"
                  ? tab.page.goBack({ waitUntil: "domcontentloaded", timeout: operation.remainingMs() })
                  : tab.page.goForward({ waitUntil: "domcontentloaded", timeout: operation.remainingMs() }),
                `history ${operationName}`,
              );
            } finally {
              tab.pendingHistoryIndex = undefined;
            }
            if (!response && tab.page.url() === beforeUrl) throw new Error(`BrowserHistory cannot go ${operationName}; browser did not change entries.`);
            tab.historyIndex = target;
            tab.history[target] = {
              url: publicPageUrl(tab.page.url()),
              identityUrl: bounded(tab.page.url(), 4_096),
              generation: tab.generation,
            };
          }
          if (operationName === "reload" && !response) throw new Error("BrowserHistory reload returned no HTTP response.");
          if (session.fatalError) throw session.fatalError;
        }
        const title = bounded(await operation.run(tab.page.title(), "browser title read"), 500);
        return this.historyResult(session, tab, operationName, maxEntries, title);
      } finally {
        operation.dispose();
      }
    }, operationName !== "list");
  }

  async tabs(
    sessionHandle: string,
    operationName: BrowserTabsOperation,
    tabHandle?: string,
    url?: string,
    signal?: AbortSignal,
  ): Promise<BrowserTabsResult> {
    if (!["list", "open", "switch", "close"].includes(operationName)) throw new Error("BrowserTabs operation is not allowlisted.");
    const session = this.requireOwnedSession(sessionHandle);
    return this.operate(session, signal, async () => {
      const operation = new OperationDeadline("BrowserTabs", operationName === "open" ? this.limits.navigationMs : this.limits.actionMs, signal);
      let openedTab: string | undefined;
      let closedTab: string | undefined;
      try {
        if (operationName === "list") {
          if (tabHandle !== undefined || url !== undefined) throw new Error("BrowserTabs list does not accept tab or url.");
        } else if (operationName === "open") {
          if (tabHandle !== undefined || !url) throw new Error("BrowserTabs open requires url and does not accept tab.");
          if (session.tabs.size >= this.limits.maxTabsPerSession) throw new Error(`Browser tab limit (${this.limits.maxTabsPerSession}) reached.`);
          const requested = await operation.run(validatePublicUrl(url, this.resolveHostname), "URL validation");
          const creation = session.context.newPage();
          let page: Page;
          try {
            page = await operation.run(creation, "browser tab creation");
          } catch (error) {
            this.trackLatePageCreation(session, creation, "late BrowserTabs page creation");
            return this.failUncertainTabClosure(
              session,
              "BrowserTabs open could not confirm whether a new page was created",
              asError(error),
            );
          }
          const tab = this.tabForPage(session, page) ?? this.adoptPage(session, page, false);
          if (!tab) {
            await this.containRefusedPage(session, page, "refused BrowserTabs page");
            throw new Error("Browser tab could not be owned within the session tab limit.");
          }
          const previousActiveTab = session.activeTab;
          openedTab = tab.handle;
          try {
            await this.navigateSession(session, tab, requested.href, operation, false);
            session.activeTab = tab.handle;
          } catch (error) {
            tab.closing = true;
            let rollbackFailure: Error | undefined;
            try {
              await boundedCleanup(
                page.close({ runBeforeUnload: false }),
                this.limits.cleanupMs,
                "failed browser tab open rollback",
              );
            } catch (closeError) {
              rollbackFailure = asError(closeError);
            }
            if (!page.isClosed()) {
              return this.failUncertainTabClosure(
                session,
                "BrowserTabs open failed and rollback could not confirm closure of the new tab",
                rollbackFailure ? new AggregateError([error, rollbackFailure]) : asError(error),
              );
            }
            session.tabs.delete(tab.handle);
            if (session.tabs.has(previousActiveTab)) session.activeTab = previousActiveTab;
            else if (session.tabs.size > 0) session.activeTab = session.tabs.keys().next().value!;
            else return this.failUncertainTabClosure(session, "BrowserTabs open rollback left no owned tab", asError(error));
            throw error;
          }
        } else {
          if (!tabHandle || url !== undefined) throw new Error(`BrowserTabs ${operationName} requires tab and does not accept url.`);
          const tab = session.tabs.get(tabHandle);
          if (!tab) throw invalidHandleError();
          if (operationName === "switch") {
            await operation.run(tab.page.bringToFront(), "tab switch");
            session.activeTab = tab.handle;
          } else {
            closedTab = tab.handle;
            tab.closing = true;
            let closeFailure: Error | undefined;
            try {
              await operation.run(tab.page.close({ runBeforeUnload: false }), "tab close");
            } catch (error) {
              closeFailure = asError(error);
            }
            if (!tab.page.isClosed()) {
              return this.failUncertainTabClosure(
                session,
                "BrowserTabs close could not confirm closure of the selected tab",
                closeFailure ?? new Error("Playwright returned without closing the selected tab."),
              );
            }
            session.tabs.delete(tab.handle);
            if (session.tabs.size === 0) {
              await this.beginTeardown(session);
              return {
                session: session.handle,
                operation: operationName,
                activeTab: null,
                tabs: [],
                closedTab,
                sessionClosed: true,
                tabsRemaining: 0,
                maxTabs: this.limits.maxTabsPerSession,
              };
            }
            if (session.activeTab === tab.handle) session.activeTab = session.tabs.keys().next().value!;
          }
        }
        return {
          session: session.handle,
          operation: operationName,
          activeTab: session.activeTab,
          tabs: this.tabInventory(session),
          ...(openedTab ? { openedTab } : {}),
          ...(closedTab ? { closedTab } : {}),
          sessionClosed: false,
          tabsRemaining: session.tabs.size,
          maxTabs: this.limits.maxTabsPerSession,
        };
      } finally {
        operation.dispose();
      }
    });
  }

  async close(sessionHandle: string): Promise<BrowserCloseResult> {
    const failed = this.failedTombstones.get(sessionHandle);
    if (failed) throw failed;
    const closed = this.closedTombstones.get(sessionHandle);
    if (closed) return { ...closed, alreadyClosed: true };
    const session = this.sessions.get(sessionHandle);
    if (session) return this.beginTeardown(session);
    // A valid self-authenticating handle was issued by this manager. If it is
    // no longer active and has no retained failure, its teardown was confirmed
    // even if bounded successful diagnostics have since been evicted.
    if (this.authenticatesSessionHandle(sessionHandle)) {
      return {
        session: sessionHandle,
        closed: true,
        alreadyClosed: true,
        quiescent: true,
        broker: null,
        diagnosticsRetained: false,
      };
    }
    throw invalidHandleError();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.confirmationPermits.clear();
    const openings = [...this.openings];
    for (const opening of openings) {
      opening.controller.abort(new Error("BrowserOpen cancelled by interactive browser shutdown."));
    }
    // Each opening settles only after its bounded startup cleanup has finished
    // or recorded an unconfirmed teardown. It may briefly transfer resources
    // into sessions before observing cancellation, so sweep sessions after.
    await Promise.all(openings.map((opening) => opening.settled));
    const outcomes = await Promise.allSettled([...this.sessions.values()].map((session) =>
      this.beginTeardown(session, new Error("Browser session shut down with the Pi session."))
    ));
    const failures = new Set<Error>();
    if (this.shutdownFailure) failures.add(this.shutdownFailure);
    for (const failure of this.failedTombstones.values()) failures.add(failure);
    for (const opening of openings) if (opening.teardownFailure) failures.add(opening.teardownFailure);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") failures.add(asError(outcome.reason));
    }
    if (failures.size > 0) {
      const aggregate = new AggregateError([...failures], "Interactive browser shutdown could not confirm quiescence.");
      this.shutdownFailure ??= aggregate;
      throw aggregate;
    }
  }

  activeSessionCount(): number {
    return this.sessions.size;
  }

  private async navigateSession(session: Session, tab: BrowserTab, rawUrl: string, operation: OperationDeadline, initial: boolean): Promise<BrowserNavigateResult> {
    if (!initial) this.consumeNavigation(session);
    else session.navigations += 1;
    const requested = await operation.run(validatePublicUrl(rawUrl, this.resolveHostname), "URL validation");
    let response: Response | null;
    try {
      response = await operation.run(
        tab.page.goto(requested.href, { waitUntil: "domcontentloaded", timeout: operation.remainingMs() }),
        "main-document navigation",
      );
    } catch (error) {
      throw session.fatalError ?? asError(error);
    }
    if (!response) throw new Error("Browser navigation returned no HTTP response.");
    const finalUrl = publicPageUrl(tab.page.url());
    await operation.run(
      tab.page.waitForLoadState("networkidle", { timeout: Math.min(2_000, operation.remainingMs()) }).catch(() => undefined),
      "browser rendering settle",
    );
    if (session.fatalError) throw session.fatalError;
    this.recordHistory(tab, finalUrl);
    const title = bounded(await operation.run(tab.page.title(), "browser title read"), 500);
    return {
      session: session.handle,
      tab: tab.handle,
      generation: tab.generation,
      url: finalUrl,
      title,
      status: response.status(),
      navigationsRemaining: Math.max(0, this.limits.maxNavigations - session.navigations),
    };
  }

  private installPageGuards(session: Session, tab: BrowserTab): void {
    tab.page.on("request", (request: Request) => {
      if (!request.isNavigationRequest() || request.frame() !== tab.page.mainFrame()) return;
      if (session.interactionCapture) session.interactionCapture.events += 1;
      session.mainDocumentRequests += 1;
      tab.generation = this.uniqueHandle("generation");
      tab.semanticRefs.clear();
      tab.documentRequestPending = true;
      let redirectHops = 0;
      let redirected = request.redirectedFrom();
      while (redirected && redirectHops <= MAX_MAIN_DOCUMENT_REDIRECTS) {
        redirectHops += 1;
        redirected = redirected.redirectedFrom();
      }
      if (redirectHops > MAX_MAIN_DOCUMENT_REDIRECTS) {
        this.failSession(session, new Error(`Browser navigation exceeded ${MAX_MAIN_DOCUMENT_REDIRECTS} redirect hops.`));
      }
      if (session.mainDocumentRequests > this.limits.maxMainDocumentRequests) {
        this.failSession(session, new Error(`Browser main-document request limit (${this.limits.maxMainDocumentRequests}) exhausted.`));
      }
    });
    tab.page.on("framenavigated", (frame) => {
      if (frame !== tab.page.mainFrame()) return;
      if (session.interactionCapture) session.interactionCapture.events += 1;
      const rawUrl = tab.page.url();
      if (!tab.documentRequestPending && !sameDocumentUrl(tab.lastCommittedUrl, rawUrl)) {
        tab.generation = this.uniqueHandle("generation");
        tab.semanticRefs.clear();
      } else if (!tab.documentRequestPending && tab.lastCommittedUrl === rawUrl) {
        // A commit at the identical URL is a reload/replacement, not a hash-only traversal.
        tab.generation = this.uniqueHandle("generation");
        tab.semanticRefs.clear();
      }
      tab.documentRequestPending = false;
      tab.lastCommittedUrl = rawUrl;
      try {
        const url = publicPageUrl(rawUrl);
        if (tab.pendingHistoryIndex !== undefined) {
          tab.historyIndex = tab.pendingHistoryIndex;
          if (tab.history[tab.historyIndex]) {
            tab.history[tab.historyIndex] = { url, identityUrl: bounded(rawUrl, 4_096), generation: tab.generation };
          }
        } else {
          this.recordHistory(tab, url);
        }
      } catch {
        // Initial about:blank and blocked protocols are not session history.
      }
    });
    tab.page.on("dialog", (dialog) => this.dismissDialog(session, dialog));
    tab.page.on("download", (download) => this.cancelDownload(session, download));
    tab.page.on("crash", () => this.failSession(session, new Error("Browser tab crashed; teardown started.")));
    tab.page.on("close", () => {
      session.tabs.delete(tab.handle);
      if (session.teardown || tab.closing) return;
      if (session.tabs.size === 0) {
        this.failSession(session, new Error("Last browser tab closed unexpectedly; teardown started."));
        return;
      }
      if (session.activeTab === tab.handle) session.activeTab = session.tabs.keys().next().value!;
    });
  }

  private async operate<T>(session: Session, signal: AbortSignal | undefined, body: () => Promise<T>, fatalOnError = false): Promise<T> {
    this.assertUsable(session);
    if (session.operationActive) throw new Error("Browser session is busy with another bounded operation.");
    if (session.actions >= this.limits.maxActions) {
      const error = new Error(`Browser action limit (${this.limits.maxActions}) exhausted.`);
      await this.failAndWait(session, error);
      throw error;
    }
    session.actions += 1;
    session.operationActive = true;
    this.touch(session);
    try {
      throwIfAborted(signal);
      const result = await body();
      if (session.fatalError) throw session.fatalError;
      if (!session.teardown) this.touch(session);
      return result;
    } catch (error) {
      const failure = asError(error);
      if (fatalOnError || signal?.aborted || session.fatalError) await this.failAndWait(session, session.fatalError ?? failure);
      throw failure;
    } finally {
      session.operationActive = false;
    }
  }

  private assertUsable(session: Session): void {
    if (session.fatalError) throw session.fatalError;
    if (session.teardown) throw new Error("Browser session teardown is in progress.");
    if (this.now() - session.createdAt >= this.limits.lifetimeMs) {
      const error = new Error(`Browser session lifetime limit (${this.limits.lifetimeMs}ms) expired; teardown started.`);
      this.failSession(session, error);
      throw error;
    }
  }

  private failSession(session: Session, error: Error): void {
    session.fatalError ??= error;
    void this.beginTeardown(session, session.fatalError).catch(() => undefined);
  }

  private async failAndWait(session: Session, error: Error): Promise<void> {
    session.fatalError ??= error;
    try {
      await this.beginTeardown(session, session.fatalError);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${error.message} Browser teardown could not be confirmed.`);
    }
  }

  private beginTeardown(session: Session, _cause?: Error): Promise<BrowserCloseResult> {
    if (session.teardown) return session.teardown;
    clearTimeout(session.expiryTimer);
    clearTimeout(session.idleTimer);
    // Publish the in-progress promise before invoking any Playwright close.
    // Browser/page close events may fire synchronously and must observe this
    // marker rather than recursively starting another teardown.
    let resolveTeardown!: (result: BrowserCloseResult) => void;
    let rejectTeardown!: (error: Error) => void;
    const teardown = new Promise<BrowserCloseResult>((resolve, reject) => {
      resolveTeardown = resolve;
      rejectTeardown = reject;
    });
    session.teardown = teardown;
    void (async () => {
      try {
        const summary = await cleanupSession(session, this.limits.cleanupMs);
        auditEgressLedger(summary.ledger);
        const result: BrowserCloseResult = {
          session: session.handle,
          closed: true,
          alreadyClosed: false,
          quiescent: true,
          broker: {
            connections: summary.ledger.length,
            budgetAborts: summary.budgetAborts,
            refusals: summary.refusals,
          },
          diagnosticsRetained: true,
        };
        this.rememberClosed(session.handle, result);
        resolveTeardown(result);
      } catch (error) {
        const failure = new Error(`Browser closure is unconfirmed: ${asError(error).message}`, { cause: error });
        this.rememberFailed(session.handle, failure);
        rejectTeardown(failure);
      } finally {
        this.sessions.delete(session.handle);
      }
    })();
    return teardown;
  }

  private touch(session: Session): void {
    session.lastUsedAt = this.now();
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      this.failSession(session, new Error(`Browser session idle limit (${this.limits.idleMs}ms) expired; teardown started.`));
    }, this.limits.idleMs);
    session.idleTimer.unref?.();
  }

  private armTimers(session: Session): void {
    session.expiryTimer = setTimeout(() => {
      this.failSession(session, new Error(`Browser session lifetime limit (${this.limits.lifetimeMs}ms) expired; teardown started.`));
    }, this.limits.lifetimeMs);
    session.expiryTimer.unref?.();
    this.touch(session);
  }

  private async failUncertainTabClosure(session: Session, message: string, cause: Error): Promise<never> {
    const failure = new Error(`${message}; session teardown started.`, { cause });
    await this.failAndWait(session, failure);
    throw failure;
  }

  private requireOwnedSession(sessionHandle: string): Session {
    const session = this.sessions.get(sessionHandle);
    if (!session) throw invalidHandleError();
    return session;
  }

  private requireTab(sessionHandle: string, tabHandle: string): { session: Session; tab: BrowserTab } {
    const session = this.sessions.get(sessionHandle);
    const tab = session?.tabs.get(tabHandle);
    // One deliberately indistinguishable error rejects forged, stale,
    // cross-session, and cross-tab handles without making handles enumerable.
    if (!session || !tab) throw invalidHandleError();
    return { session, tab };
  }

  private currentRefLocator(tab: BrowserTab, ref: string) {
    const semanticRef = tab.semanticRefs.get(ref);
    if (!semanticRef || semanticRef.generation !== tab.generation) throw invalidRefError();
    return tab.page.locator(`aria-ref=${semanticRef.playwrightRef}`);
  }

  private confirmationBinding(
    session: Session,
    tab: BrowserTab,
    ref: string,
    origin: string,
    structure: BrowserTargetStructure,
    consequence: BrowserConsequence,
    destination: string | null,
  ): BrowserConfirmationBinding {
    return {
      session: session.handle,
      tab: tab.handle,
      generation: tab.generation,
      operation: "click",
      ref,
      origin,
      destination,
      targetFingerprint: this.consequencePolicy.fingerprint(structure),
      consequence,
    };
  }

  private invalidateInteractionRefs(tab: BrowserTab, capturedGeneration: string): void {
    tab.semanticRefs.clear();
    if (tab.generation === capturedGeneration) tab.generation = this.uniqueHandle("generation");
  }

  private dismissDialog(session: Session, dialog: Dialog): void {
    const capture = session.interactionCapture;
    if (capture) {
      capture.dialogs += 1;
      capture.events += 1;
    }
    const settlement = dialog.dismiss().then(() => undefined, () => {
      const failure = new Error("Browser dialog could not be default-dismissed; teardown started.");
      this.failSession(session, failure);
      throw failure;
    });
    settlement.catch(() => undefined);
    if (capture) capture.settlements.push(settlement);
  }

  private cancelDownload(session: Session, download: Download): void {
    const capture = session.interactionCapture;
    if (capture) {
      capture.downloads += 1;
      capture.events += 1;
    }
    const settlement = download.cancel().then(() => undefined, () => {
      const failure = new Error("Unexpected browser download could not be canceled; teardown started.");
      this.failSession(session, failure);
      throw failure;
    });
    settlement.catch(() => undefined);
    if (capture) capture.settlements.push(settlement);
  }

  private consumeNavigation(session: Session): void {
    if (session.navigations >= this.limits.maxNavigations) {
      throw new Error(`Browser navigation limit (${this.limits.maxNavigations}) exhausted.`);
    }
    session.navigations += 1;
  }

  private recordHistory(tab: BrowserTab, url: string): void {
    const identityUrl = bounded(tab.page.url(), 4_096);
    const current = tab.history[tab.historyIndex];
    if (current?.identityUrl === identityUrl && current.generation === tab.generation) return;
    tab.history.splice(tab.historyIndex + 1);
    tab.history.push({ url, identityUrl, generation: tab.generation });
    if (tab.history.length > this.limits.maxHistoryEntries) tab.history.shift();
    tab.historyIndex = tab.history.length - 1;
  }

  private historyResult(
    session: Session,
    tab: BrowserTab,
    operation: BrowserHistoryOperation,
    maxEntries: number,
    title: string,
  ): BrowserHistoryResult {
    const start = Math.max(0, tab.history.length - maxEntries);
    return {
      session: session.handle,
      tab: tab.handle,
      generation: tab.generation,
      operation,
      url: publicPageUrl(tab.page.url()),
      title,
      entries: tab.history.slice(start).map((entry, offset) => ({
        index: start + offset,
        url: entry.url,
        generation: entry.generation,
        current: start + offset === tab.historyIndex,
      })),
      truncated: start > 0,
      navigationsRemaining: Math.max(0, this.limits.maxNavigations - session.navigations),
    };
  }

  private tabForPage(session: Session, page: Page): BrowserTab | undefined {
    for (const tab of session.tabs.values()) if (tab.page === page) return tab;
    return undefined;
  }

  private adoptPage(session: Session, page: Page, popup = true): BrowserTab | undefined {
    const existing = this.tabForPage(session, page);
    if (existing) return existing;
    if (page.isClosed()) {
      session.broker.note(`${popup ? "popup" : "additional tab"} closed before ownership could be established.`);
      return undefined;
    }
    if (session.teardown || session.tabs.size >= this.limits.maxTabsPerSession) {
      const label = `${popup ? "popup" : "additional tab"} refused at the ${this.limits.maxTabsPerSession}-tab session limit`;
      session.broker.note(`${label}.`);
      void this.containRefusedPage(session, page, label).catch(() => undefined);
      return undefined;
    }
    const tab: BrowserTab = {
      handle: this.uniqueHandle("tab"),
      generation: this.uniqueHandle("generation"),
      page,
      semanticRefs: new Map(),
      history: [],
      historyIndex: -1,
      lastCommittedUrl: page.url(),
      documentRequestPending: false,
      closing: false,
    };
    session.tabs.set(tab.handle, tab);
    this.installPageGuards(session, tab);
    try {
      const url = publicPageUrl(page.url());
      this.recordHistory(tab, url);
    } catch {
      // A popup commonly begins at about:blank before its brokered navigation.
    }
    return tab;
  }

  private adoptPopup(session: Session, page: Page): BrowserTab | undefined {
    return this.adoptPage(session, page, true);
  }

  private containRefusedPage(session: Session, page: Page, label: string): Promise<void> {
    const existing = session.pendingPageClosures.get(page);
    if (existing) return existing;
    const closure = (async () => {
      let closeFailure: Error | undefined;
      try {
        await boundedCleanup(page.close({ runBeforeUnload: false }), this.limits.cleanupMs, label);
      } catch (error) {
        closeFailure = asError(error);
      }
      if (!page.isClosed()) {
        const failure = new Error(`${label} could not be closed; session teardown started.`, { cause: closeFailure });
        this.failSession(session, failure);
        throw failure;
      }
      session.pendingPageClosures.delete(page);
    })();
    session.pendingPageClosures.set(page, closure);
    closure.catch(() => undefined);
    return closure;
  }

  private trackLatePageCreation(session: Session, creation: Promise<Page>, label: string): void {
    let tracked!: Promise<void>;
    tracked = creation.then(async (latePage) => {
      if (!this.tabForPage(session, latePage)) await this.containRefusedPage(session, latePage, label);
    }, () => undefined).finally(() => {
      session.pendingPageCreations.delete(tracked);
    });
    session.pendingPageCreations.add(tracked);
    tracked.catch(() => undefined);
  }

  private tabInventory(session: Session): BrowserTabsResult["tabs"] {
    return [...session.tabs.values()].map((tab) => ({
      tab: tab.handle,
      generation: tab.generation,
      url: safePublicPageUrl(tab.page.url()),
      active: tab.handle === session.activeTab,
    }));
  }

  private uniqueHandle(kind: "session" | "tab" | "generation" | "ref"): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (kind === "session") {
        const payload = Buffer.from(this.randomHandle(kind), "utf8").toString("base64url");
        const signature = this.signSessionPayload(payload);
        const value = `browser_session_${payload}.${signature}`;
        if (!this.sessions.has(value) && !this.closedTombstones.has(value) && !this.failedTombstones.has(value)) return value;
        continue;
      }
      return this.randomHandle(kind);
    }
    throw new Error("Unable to allocate an opaque browser handle.");
  }

  private signSessionPayload(payload: string): string {
    return createHmac("sha256", this.handleAuthenticationKey).update(payload, "utf8").digest("base64url");
  }

  private authenticatesSessionHandle(handle: string): boolean {
    const match = /^browser_session_([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(handle);
    if (!match) return false;
    const expected = Buffer.from(this.signSessionPayload(match[1]!), "utf8");
    const actual = Buffer.from(match[2]!, "utf8");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private recordOpeningTeardownFailure(opening: OpeningOperation, failure: Error): void {
    opening.teardownFailure ??= failure;
    this.shutdownFailure ??= failure;
  }

  private rememberClosed(handle: string, result: BrowserCloseResult): void {
    this.failedTombstones.delete(handle);
    this.closedTombstones.delete(handle);
    this.closedTombstones.set(handle, result);
    while (this.closedTombstones.size > MAX_TOMBSTONES) {
      this.closedTombstones.delete(this.closedTombstones.keys().next().value!);
    }
  }

  private rememberFailed(handle: string, failure: Error): void {
    this.closedTombstones.delete(handle);
    // Capacity is reserved before open, so this set never needs unsafe
    // eviction and can retain every unconfirmed teardown fail-closed.
    this.failedTombstones.set(handle, failure);
  }

  private brokerBudgets(): EgressBudgets {
    return {
      maxDistinctHosts: this.limits.maxDistinctHosts,
      maxConnections: this.limits.maxConnections,
      maxClientConnections: 64,
      preAuthSocketMs: 5_000,
      maxRequests: this.limits.maxRequests,
      maxTotalMs: this.limits.lifetimeMs,
      maxCleanupMs: this.limits.cleanupMs,
      maxConnectionBytes: this.limits.maxConnectionBytes,
      maxTotalBytes: this.limits.maxTotalBytes,
      maxAuthorityChars: 2_048,
      maxHeaderChars: 32_768,
      maxDiagnostics: 32,
      idleSocketMs: 20_000,
    };
  }
}

/** Additional browser-process defenses shared by every interactive session. */
export function interactiveChromiumArgs(brokerPort: number): string[] {
  return [
    ...chromiumEgressArgs(brokerPort),
    "--blink-settings=imagesEnabled=false",
    "--disable-remote-fonts",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-domain-reliability",
    "--disable-sync",
    "--no-pings",
    "--autoplay-policy=user-gesture-required",
    "--disable-features=MediaRouter,OptimizationHints,InterestFeedContentSuggestions",
  ];
}

async function installRoutePolicy(context: BrowserContext, broker: EgressBroker): Promise<void> {
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
    broker.note(`${decision.reason}: ${bounded(request.url(), 300)}`);
    await route.abort("blockedbyclient").catch(() => undefined);
  });
}

export function interactiveRouteDecision(resourceType: string, rawUrl: string): { allowed: boolean; reason?: string } {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { allowed: false, reason: "unparseable browser request blocked" }; }
  if (["image", "font", "media", "websocket", "eventsource", "ping"].includes(resourceType)) {
    return { allowed: false, reason: `${resourceType} resource blocked` };
  }
  if (SAFE_LOCAL_PROTOCOLS.has(url.protocol)) return { allowed: true };
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { allowed: false, reason: `external protocol ${url.protocol} blocked` };
  }
  return { allowed: true };
}

async function cleanupSession(session: Session, deadlineMs: number): Promise<EgressSummary> {
  // Start every shutdown path immediately and bound them concurrently. Hung
  // tab closes must not delay the broker kill or parent-resource close.
  const pages = [...new Set([
    ...[...session.tabs.values()].map((tab) => tab.page),
    ...session.pendingPageClosures.keys(),
  ])];
  const pendingContainments = [...session.pendingPageClosures.values()];
  const pendingCreations = [...session.pendingPageCreations];
  for (const tab of session.tabs.values()) tab.closing = true;
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
    boundedCleanup(session.browser.close(), deadlineMs, "browser process close"),
    boundedCleanup(session.broker.close(), deadlineMs, "egress broker close"),
  ]);
  const operationFailures = operations
    .filter((operation): operation is PromiseRejectedResult => operation.status === "rejected")
    .map((operation) => operation.reason);
  const brokerOutcome = operations[operations.length - 1];
  const summary = brokerOutcome?.status === "fulfilled" ? brokerOutcome.value as EgressSummary : undefined;
  const stateFailures: unknown[] = [];
  const allKnownPages = new Set([...pages, ...session.pendingPageClosures.keys()]);
  if ([...allKnownPages].some((page) => !page.isClosed())) stateFailures.push(new Error("browser tab remains open"));
  if (session.pendingPageCreations.size > 0) stateFailures.push(new Error("late browser page creation remains unsettled"));
  if (session.browser.isConnected()) stateFailures.push(new Error("browser process remains connected"));
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

async function cleanupPartial(
  browser: Browser | undefined,
  context: BrowserContext | undefined,
  broker: EgressBroker,
  deadlineMs: number,
  lateBrowserCleanup?: Promise<unknown>,
  lateContextCleanup?: Promise<unknown>,
): Promise<void> {
  const results = await Promise.allSettled([
    boundedCleanup(context?.close() ?? Promise.resolve(), deadlineMs, "partial browser context close"),
    boundedCleanup(browser?.close() ?? Promise.resolve(), deadlineMs, "partial browser process close"),
    boundedCleanup(broker.close(), deadlineMs, "partial egress broker close"),
    boundedCleanup(lateContextCleanup ?? Promise.resolve(), deadlineMs, "late browser context containment"),
    boundedCleanup(lateBrowserCleanup ?? Promise.resolve(), deadlineMs, "late browser process containment"),
  ]);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (browser?.isConnected()) failures.push({ status: "rejected", reason: new Error("partial browser remains connected") });
  if (!broker.isQuiescent()) failures.push({ status: "rejected", reason: new Error("partial broker is not quiescent") });
  if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), "partial BrowserOpen teardown failed");
}

async function boundedCleanup<T>(operation: Promise<T>, deadlineMs: number, label: string): Promise<T> {
  return within(operation, deadlineMs, label);
}

const INTERACTION_ACCOUNTING_MIN_MS = 200;
const INTERACTION_ACCOUNTING_MAX_MS = 250;
const INTERACTION_ACCOUNTING_QUIET_MS = 50;

/** Drain effects added while earlier containment promises are settling. */
async function accountInteractionEffects(
  capture: InteractionCapture,
  operation: OperationDeadline,
): Promise<"bounded_stable" | "bounded_uncertain"> {
  const startedAt = Date.now();
  const accountingDeadline = startedAt + Math.min(
    INTERACTION_ACCOUNTING_MAX_MS,
    Math.max(1, operation.remainingMs() - 1),
  );
  let cursor = 0;
  let observedEvents = capture.events;
  let stableSince = startedAt;

  while (true) {
    while (cursor < capture.settlements.length) {
      const batch = capture.settlements.slice(cursor);
      cursor = capture.settlements.length;
      const remaining = accountingDeadline - Date.now();
      if (remaining <= 0) throw new Error("Interaction side-effect containment exceeded its bounded accounting window.");
      await operation.run(within(
        Promise.all(batch).then(() => undefined),
        remaining,
        "interaction side-effect containment",
        operation.signal,
      ), "interaction side-effect containment");
    }

    const now = Date.now();
    if (capture.events !== observedEvents) {
      observedEvents = capture.events;
      stableSince = now;
    }
    const minimumObserved = now - startedAt >= INTERACTION_ACCOUNTING_MIN_MS;
    const stable = now - stableSince >= INTERACTION_ACCOUNTING_QUIET_MS;
    if (minimumObserved && stable && cursor === capture.settlements.length) return "bounded_stable";
    if (now >= accountingDeadline) return "bounded_uncertain";

    const delayMs = Math.max(1, Math.min(25, accountingDeadline - now));
    await operation.run(new Promise<void>((resolve) => setTimeout(resolve, delayMs)), "interaction effect observation");
  }
}

class OperationDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly deadlineAt: number;
  private readonly timer: NodeJS.Timeout;
  private readonly externalSignal?: AbortSignal;
  private readonly onExternalAbort?: () => void;

  constructor(private readonly name: string, private readonly durationMs: number, externalSignal?: AbortSignal) {
    this.signal = this.controller.signal;
    this.deadlineAt = Date.now() + durationMs;
    this.timer = setTimeout(() => {
      this.controller.abort(new Error(`${name} exceeded its ${durationMs}ms total deadline.`));
    }, durationMs);
    this.timer.unref?.();
    if (externalSignal) {
      this.externalSignal = externalSignal;
      this.onExternalAbort = () => this.controller.abort(externalSignal.reason ?? new Error(`${name} cancelled.`));
      if (externalSignal.aborted) this.onExternalAbort();
      else externalSignal.addEventListener("abort", this.onExternalAbort, { once: true });
    }
  }

  remainingMs(): number {
    if (this.signal.aborted) throw asError(this.signal.reason);
    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) {
      const error = new Error(`${this.name} exceeded its ${this.durationMs}ms total deadline.`);
      this.controller.abort(error);
      throw error;
    }
    return remaining;
  }

  run<T>(operation: Promise<T>, _phase: string): Promise<T> {
    this.remainingMs();
    return abortableOperation(operation, this.signal);
  }

  dispose(): void {
    clearTimeout(this.timer);
    if (this.externalSignal && this.onExternalAbort) {
      this.externalSignal.removeEventListener("abort", this.onExternalAbort);
    }
  }
}

async function abortableOperation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(asError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  operation.catch(() => undefined);
  aborted.catch(() => undefined);
  try { return await Promise.race([operation, aborted]); }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}

async function within<T>(operation: Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its ${timeoutMs}ms deadline.`)), timeoutMs);
    timer.unref?.();
    if (signal) {
      abortListener = () => reject(asError(signal.reason ?? new Error(`${label} cancelled.`)));
      signal.addEventListener("abort", abortListener, { once: true });
    }
  });
  operation.catch(() => undefined);
  deadline.catch(() => undefined);
  try { return await Promise.race([operation, deadline]); }
  finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

type Re2Matcher = { test(value: string): boolean };
type Re2Constructor = new (pattern: string, flags?: string) => Re2Matcher;
let SafeRE2: Re2Constructor | null = null;
try {
  SafeRE2 = (require("re2-wasm") as { RE2: Re2Constructor }).RE2;
} catch {
  SafeRE2 = null;
}

function urlWaitMatcher(kind: "exact" | "prefix" | "pattern", value: string): (url: string) => boolean {
  if (kind === "exact" || kind === "prefix") {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`BrowserWait URL ${kind} value must be an absolute HTTP(S) URL.`); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`BrowserWait URL ${kind} value must use HTTP(S).`);
    const expected = parsed.href;
    return kind === "exact" ? (url) => url === expected : (url) => url.startsWith(expected);
  }
  if (kind !== "pattern") throw new Error("BrowserWait URL match must be exact, prefix, or pattern.");
  if (!SafeRE2) throw new Error("BrowserWait safe RE2 matching is unavailable in this runtime.");
  let matcher: Re2Matcher;
  try {
    matcher = new SafeRE2(value, "u");
  } catch {
    throw new Error("BrowserWait URL pattern is invalid or unsupported by safe RE2.");
  }
  return (url) => {
    try { return matcher.test(url); }
    catch { throw new Error("BrowserWait URL pattern could not safely inspect the current URL."); }
  };
}

async function readTargetStructure(locator: Locator): Promise<BrowserTargetStructure> {
  const structure = await locator.evaluate((element) => {
    const html = element as HTMLElement;
    const tagName = html.tagName.toLocaleLowerCase("en-US").slice(0, 129);
    const control = html as HTMLInputElement & HTMLButtonElement;
    const form = "form" in control ? control.form : null;
    const cap = (value: string | null, max = 4_097) => value === null ? null : value.slice(0, max);
    const path: string[] = [];
    let current: Element | null = element;
    while (current && path.length < 12) {
      let position = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) position += 1;
        sibling = sibling.previousElementSibling;
      }
      path.push(`${current.tagName.toLocaleLowerCase("en-US")}:nth-of-type(${position})`);
      current = current.parentElement;
    }
    const href = "href" in html && typeof (html as HTMLAnchorElement).href === "string"
      ? (html as HTMLAnchorElement).href
      : null;
    const formAction = form
      ? (("formAction" in control && control.formAction) || form.action || null)
      : null;
    const inputType = (tagName === "input" || tagName === "button")
      ? cap(control.getAttribute("type")?.toLocaleLowerCase("en-US") ?? (tagName === "button" ? "submit" : "text"), 32)
      : null;
    return {
      tagName,
      role: cap(html.getAttribute("role")?.trim().toLocaleLowerCase("en-US") ?? null, 64),
      href: cap(href),
      target: cap(html.getAttribute("target")?.trim().toLocaleLowerCase("en-US") ?? null, 64),
      download: html.hasAttribute("download"),
      inputType,
      formAssociated: form !== null,
      formAction: cap(formAction),
      formMethod: cap(form?.method?.toLocaleLowerCase("en-US") ?? null, 16),
      ariaHasPopup: cap(html.getAttribute("aria-haspopup")?.trim().toLocaleLowerCase("en-US") ?? null, 32),
      contentEditable: html.isContentEditable,
      disabled: Boolean(("disabled" in control && control.disabled) || html.getAttribute("aria-disabled") === "true"),
      inlineEventHandler: [...html.attributes].some((attribute) => /^on/i.test(attribute.name)),
      summaryForDetails: tagName === "summary" && html.parentElement?.tagName.toLocaleLowerCase("en-US") === "details",
      domPath: path.reverse().join("> ").slice(0, 513),
    };
  });
  if (!isBrowserTargetStructure(structure) || !boundedTargetStructure(structure)) {
    throw new Error("Browser interaction target structure could not be safely inspected within policy bounds.");
  }
  return structure;
}

function isBrowserTargetStructure(value: unknown): value is BrowserTargetStructure {
  if (typeof value !== "object" || value === null) return false;
  const target = value as Record<string, unknown>;
  return typeof target.tagName === "string"
    && (typeof target.role === "string" || target.role === null)
    && (typeof target.href === "string" || target.href === null)
    && (typeof target.target === "string" || target.target === null)
    && typeof target.download === "boolean"
    && (typeof target.inputType === "string" || target.inputType === null)
    && typeof target.formAssociated === "boolean"
    && (typeof target.formAction === "string" || target.formAction === null)
    && (typeof target.formMethod === "string" || target.formMethod === null)
    && (typeof target.ariaHasPopup === "string" || target.ariaHasPopup === null)
    && typeof target.contentEditable === "boolean"
    && typeof target.disabled === "boolean"
    && typeof target.inlineEventHandler === "boolean"
    && typeof target.summaryForDetails === "boolean"
    && typeof target.domPath === "string";
}

function boundedTargetStructure(target: BrowserTargetStructure): boolean {
  return target.tagName.length <= 128
    && (target.role === null || target.role.length <= 64)
    && (target.href === null || target.href.length <= 4_096)
    && (target.target === null || target.target.length <= 64)
    && (target.inputType === null || target.inputType.length <= 32)
    && (target.formAction === null || target.formAction.length <= 4_096)
    && (target.formMethod === null || target.formMethod.length <= 16)
    && (target.ariaHasPopup === null || target.ariaHasPopup.length <= 32)
    && target.domPath.length <= 512;
}

function confirmationPrompt(
  consequence: BrowserConsequence,
  origin: string,
  destination: string | null,
): BrowserClickConfirmationRequest {
  return {
    title: "Confirm consequential browser click",
    message: [
      `The target is classified as ${consequence.replaceAll("_", " ")}.`,
      `Current site: ${redactedInteractionUrl(origin)}.`,
      ...(destination ? [`Destination site: ${redactedInteractionUrl(destination)}.`] : []),
      "Approve this one exact click? The page can have external effects; cancellation does not imply rollback.",
    ].join(" "),
  };
}

function assertBoundedInteractionCapability(value: string, maxChars: number): void {
  if (typeof value !== "string" || value.length < 1 || value.length > maxChars) {
    throw new Error("Browser interaction capability is absent or exceeds its bounded length.");
  }
}

function interactionIdentityUrl(rawUrl: string): string {
  if (rawUrl.length > 4_096) throw new Error("Browser interaction URL exceeds the bounded policy limit.");
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Browser interaction URL is not HTTP(S).");
  }
  return rawUrl;
}

function redactedInteractionUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "[redacted URL]";
    return bounded(parsed.origin, 300);
  } catch {
    return "[redacted URL]";
  }
}

function safePublicPageUrl(rawUrl: string): string {
  try { return publicPageUrl(rawUrl); }
  catch { return "[navigation pending]"; }
}

function sameDocumentUrl(left: string, right: string): boolean {
  try {
    const first = new URL(left);
    const second = new URL(right);
    first.hash = "";
    second.hash = "";
    return first.href === second.href && left !== right;
  } catch {
    return false;
  }
}

function publicPageUrl(rawUrl: string): string {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("Browser ended at an invalid URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Browser ended at blocked protocol ${url.protocol}.`);
  url.hash = "";
  return bounded(url.href, 2_048);
}

function invalidHandleError(): Error {
  return new Error("Invalid or stale browser session/tab handle.");
}

function invalidRefError(): Error {
  return new Error("Invalid or stale browser semantic ref; take a fresh BrowserSnapshot for the current session, tab, and document.");
}

function boundedElementClip(
  box: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  limits: Readonly<InteractiveBrowserLimits>,
): { x: number; y: number; width: number; height: number } {
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) {
    throw new Error("BrowserScreenshot element has invalid bounds.");
  }
  // Use an enclosing integer clip so fractional CSS pixels cannot increase the
  // decoded output beyond the preflight calculation.
  const x = Math.floor(box.x);
  const y = Math.floor(box.y);
  const right = Math.ceil(box.x + box.width);
  const bottom = Math.ceil(box.y + box.height);
  const width = right - x;
  const height = bottom - y;
  assertScreenshotDimensions(width, height, limits, "element clip");
  if (x < 0 || y < 0 || right > viewport.width || bottom > viewport.height) {
    throw new Error(
      "BrowserScreenshot element does not fit completely within the bounded viewport after positioning.",
    );
  }
  return { x, y, width, height };
}

function assertScreenshotDimensions(
  width: number,
  height: number,
  limits: Readonly<InteractiveBrowserLimits>,
  label: string,
): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`BrowserScreenshot ${label} has invalid dimensions.`);
  }
  const normalizedWidth = Math.ceil(width);
  const normalizedHeight = Math.ceil(height);
  const pixels = normalizedWidth * normalizedHeight;
  const rawAllocation = pixels * 4;
  if (
    normalizedWidth > limits.maxScreenshotWidth
    || normalizedHeight > limits.maxScreenshotHeight
    || !Number.isSafeInteger(pixels)
    || pixels > limits.maxScreenshotPixels
    || rawAllocation > limits.maxScreenshotAllocationBytes
  ) {
    throw new Error(
      `BrowserScreenshot ${label} exceeds the bounded image limits `
      + `(${normalizedWidth}x${normalizedHeight}, ${pixels} pixels; maximum `
      + `${limits.maxScreenshotWidth}x${limits.maxScreenshotHeight}, ${limits.maxScreenshotPixels} pixels, `
      + `${limits.maxScreenshotAllocationBytes} allocation bytes).`,
    );
  }
}

function validatePngScreenshot(
  image: Buffer,
  limits: Readonly<InteractiveBrowserLimits>,
): { width: number; height: number } {
  // PNG's fixed signature and IHDR put dimensions before any page-controlled
  // compressed payload. Playwright was explicitly asked for PNG; reject any
  // malformed or surprising result rather than forwarding opaque bytes.
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (image.byteLength < 24 || !image.subarray(0, 8).equals(signature) || image.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("BrowserScreenshot returned an invalid PNG image.");
  }
  if (image.byteLength > limits.maxScreenshotBytes) {
    throw new Error(`BrowserScreenshot final PNG exceeds the ${limits.maxScreenshotBytes}-byte encoded output limit.`);
  }
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  assertScreenshotDimensions(width, height, limits, "final PNG");
  const pixels = width * height;
  const base64Chars = Math.ceil(image.byteLength / 3) * 4;
  // Conservatively charge two bytes per JavaScript string character in
  // addition to decoded RGBA and encoded Buffer storage before allocating the
  // Pi ImageContent string.
  const allocationBytes = pixels * 4 + image.byteLength + base64Chars * 2;
  if (allocationBytes > limits.maxScreenshotAllocationBytes) {
    throw new Error(
      `BrowserScreenshot final image exceeds the ${limits.maxScreenshotAllocationBytes}-byte allocation limit.`,
    );
  }
  return { width, height };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw asError(signal.reason ?? new Error("Browser operation cancelled."));
}

function clampedTestLimit(value: number, hardMaximum: number): number {
  return Number.isFinite(value) ? Math.min(hardMaximum, Math.max(1, Math.floor(value))) : hardMaximum;
}

function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizedInteractionFailure(name: "BrowserHover" | "BrowserClick", error: unknown): Error {
  const message = error instanceof Error ? error.message : "";
  if (/\b(?:not_started|effect status is (?:started|completed|unknown))\b/.test(message)) return asError(error);
  if (/Invalid or stale browser (?:session\/tab handle|semantic ref)/.test(message)) {
    return new Error(`${name} not_started: invalid or stale owned semantic capability; take a fresh BrowserSnapshot.`);
  }
  return new Error(`${name} failed before dispatch; effect status is not_started.`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
