import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserType,
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

/** Hard limits for the initial, observational browser surface. */
export interface InteractiveBrowserLimits {
  maxSessions: number;
  maxTabsPerSession: number;
  maxNavigations: number;
  maxActions: number;
  maxMainDocumentRequests: number;
  maxSnapshotChars: number;
  maxSnapshotDepth: number;
  maxScreenshotWidth: number;
  maxScreenshotHeight: number;
  maxScreenshotPixels: number;
  maxScreenshotBytes: number;
  maxScreenshotAllocationBytes: number;
  navigationMs: number;
  actionMs: number;
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
  maxTabsPerSession: 1,
  maxNavigations: 12,
  maxActions: 64,
  maxMainDocumentRequests: 32,
  maxSnapshotChars: 24_000,
  maxSnapshotDepth: 16,
  maxScreenshotWidth: 2_000,
  maxScreenshotHeight: 2_000,
  maxScreenshotPixels: 4_000_000,
  maxScreenshotBytes: 4 * 1024 * 1024,
  maxScreenshotAllocationBytes: 32 * 1024 * 1024,
  navigationMs: 30_000,
  actionMs: 10_000,
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
  limits?: Partial<InteractiveBrowserLimits>;
}

interface OpeningOperation {
  controller: AbortController;
  settled: Promise<void>;
  settle(): void;
  teardownFailure?: Error;
}

interface Session {
  handle: string;
  tab: string;
  generation: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  broker: EgressBroker;
  createdAt: number;
  lastUsedAt: number;
  navigations: number;
  actions: number;
  mainDocumentRequests: number;
  operationRedirects: number;
  operationActive: boolean;
  fatalError?: Error;
  semanticRefs: Map<string, { generation: string; playwrightRef: string }>;
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
  readonly limits: Readonly<InteractiveBrowserLimits>;

  constructor(
    private config: WebFetchConfig,
    private readonly dependencies: InteractiveBrowserDependencies = {},
  ) {
    this.resolveHostname = dependencies.resolveHostname ?? defaultHostResolver;
    this.launch = dependencies.launch ?? chromium.launch.bind(chromium);
    this.now = dependencies.now ?? Date.now;
    this.randomHandle = dependencies.randomHandle ?? ((kind) => `browser_${kind}_${randomBytes(24).toString("base64url")}`);
    this.limits = Object.freeze({ ...INTERACTIVE_BROWSER_LIMITS, ...(dependencies.limits ?? {}) });
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

      let creatingPrimary = true;
      const page = await operation.run(context.newPage(), "browser tab creation");
      creatingPrimary = false;
      const session: Session = {
        handle: this.uniqueHandle("session"),
        tab: this.uniqueHandle("tab"),
        generation: this.uniqueHandle("generation"),
        browser,
        context,
        page,
        broker,
        createdAt: this.now(),
        lastUsedAt: this.now(),
        navigations: 0,
        actions: 0,
        mainDocumentRequests: 0,
        operationRedirects: 0,
        operationActive: true,
        semanticRefs: new Map(),
      };
      pendingFatal = (error) => this.failSession(session, error);
      context.on("page", (candidate) => {
        if (creatingPrimary || candidate === session.page) return;
        broker?.note(`additional tab refused at the ${this.limits.maxTabsPerSession}-tab session limit.`);
        void candidate.close().catch(() => undefined);
      });
      this.installPageGuards(session);
      this.sessions.set(session.handle, session);
      resourcesTransferredToSession = true;
      this.armTimers(session);
      try {
        const navigation = await this.navigateSession(session, requested.href, operation, true);
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
    const session = this.requireSession(sessionHandle, tabHandle);
    return this.operate(session, signal, async () => {
      const operation = new OperationDeadline("BrowserNavigate", this.limits.navigationMs, signal);
      try {
        return await this.navigateSession(session, url, operation, false);
      } finally {
        operation.dispose();
      }
    }, true);
  }

  async snapshot(sessionHandle: string, tabHandle: string, maxChars: number, signal?: AbortSignal): Promise<BrowserSnapshotResult> {
    const session = this.requireSession(sessionHandle, tabHandle);
    return this.operate(session, signal, async () => {
      const operation = new OperationDeadline("BrowserSnapshot", this.limits.actionMs, signal);
      try {
        const capturedGeneration = session.generation;
        const limit = Math.min(Math.max(1_000, maxChars), this.limits.maxSnapshotChars);
        const raw = await operation.run(session.page.ariaSnapshot({
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
        const snapshotUrl = publicPageUrl(session.page.url());
        const title = bounded(await operation.run(session.page.title(), "browser title read"), 500);
        if (session.generation !== capturedGeneration) {
          throw new Error("Browser document changed during semantic snapshot capture; snapshot rejected.");
        }
        // Only refs wholly present in the returned, bounded snapshot remain
        // current. A new snapshot replaces this map rather than accumulating
        // page-controlled references for the session lifetime.
        session.semanticRefs.clear();
        for (const [opaqueRef, ref] of capturedRefs) session.semanticRefs.set(opaqueRef, ref);
        return {
          session: session.handle,
          tab: session.tab,
          generation: capturedGeneration,
          url: snapshotUrl,
          title,
          snapshot,
          refs: session.semanticRefs.size,
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
    const session = this.requireSession(sessionHandle, tabHandle);
    return this.operate(session, signal, async () => {
      const operation = new OperationDeadline("BrowserScreenshot", this.limits.actionMs, signal);
      try {
        const capturedGeneration = session.generation;
        let image: Buffer;
        if (mode === "viewport") {
          if (ref !== undefined) throw new Error("BrowserScreenshot viewport mode does not accept ref.");
          const viewport = session.page.viewportSize();
          if (!viewport) throw new Error("BrowserScreenshot could not determine the bounded browser viewport.");
          assertScreenshotDimensions(viewport.width, viewport.height, this.limits, "viewport");
          image = await operation.run(session.page.screenshot({
            type: "png",
            fullPage: false,
            animations: "disabled",
            caret: "hide",
            scale: "css",
            timeout: operation.remainingMs(),
          }), "viewport screenshot acquisition");
        } else {
          if (!ref) throw new Error("BrowserScreenshot element mode requires a current ref from BrowserSnapshot.");
          const semanticRef = session.semanticRefs.get(ref);
          if (!semanticRef || semanticRef.generation !== capturedGeneration) throw invalidRefError();
          const locator = session.page.locator(`aria-ref=${semanticRef.playwrightRef}`);
          await operation.run(locator.scrollIntoViewIfNeeded({
            timeout: operation.remainingMs(),
            signal: operation.signal,
          }), "element positioning");
          const box = await operation.run(locator.boundingBox({ timeout: operation.remainingMs() }), "element bounds acquisition");
          if (!box) throw new Error("BrowserScreenshot element is not currently visible; take a fresh BrowserSnapshot and retry.");
          const viewport = session.page.viewportSize();
          if (!viewport) throw new Error("BrowserScreenshot could not determine the bounded browser viewport.");
          const clip = boundedElementClip(box, viewport, this.limits);
          // Capture an immutable, already-validated clip rather than asking
          // Locator.screenshot to resolve the element again. The element may
          // resize or move after boundingBox (including animation changes),
          // but it cannot expand the encoded image or browser allocation
          // beyond these fixed dimensions. Leaving animations enabled also
          // avoids Playwright fast-forwarding a finite animation after the
          // preflight and changing the element's size.
          image = await operation.run(session.page.screenshot({
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
        const snapshotUrl = publicPageUrl(session.page.url());
        const title = bounded(await operation.run(session.page.title(), "browser title read"), 500);
        if (session.generation !== capturedGeneration) {
          throw new Error("Browser document changed during screenshot capture; screenshot rejected.");
        }
        return {
          image,
          metadata: {
            session: session.handle,
            tab: session.tab,
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

  private async navigateSession(session: Session, rawUrl: string, operation: OperationDeadline, initial: boolean): Promise<BrowserNavigateResult> {
    if (!initial && session.navigations >= this.limits.maxNavigations) {
      throw new Error(`Browser navigation limit (${this.limits.maxNavigations}) exhausted.`);
    }
    const requested = await operation.run(validatePublicUrl(rawUrl, this.resolveHostname), "URL validation");
    session.navigations += 1;
    session.operationRedirects = 0;
    // Invalidate every prior semantic reference before navigation starts,
    // including failed navigation attempts that may replace the document.
    session.generation = this.uniqueHandle("generation");
    session.semanticRefs.clear();
    let response: Response | null;
    try {
      response = await operation.run(
        session.page.goto(requested.href, { waitUntil: "domcontentloaded", timeout: operation.remainingMs() }),
        "main-document navigation",
      );
    } catch (error) {
      throw session.fatalError ?? asError(error);
    }
    if (!response) throw new Error("Browser navigation returned no HTTP response.");
    const finalUrl = publicPageUrl(session.page.url());
    // Wait briefly for ordinary rendering, but never require a page to become
    // network-idle (streaming public pages are still inspectable).
    await operation.run(
      session.page.waitForLoadState("networkidle", { timeout: Math.min(2_000, operation.remainingMs()) }).catch(() => undefined),
      "browser rendering settle",
    );
    if (session.fatalError) throw session.fatalError;
    const title = bounded(await operation.run(session.page.title(), "browser title read"), 500);
    return {
      session: session.handle,
      tab: session.tab,
      generation: session.generation,
      url: finalUrl,
      title,
      status: response.status(),
      navigationsRemaining: Math.max(0, this.limits.maxNavigations - session.navigations),
    };
  }

  private installPageGuards(session: Session): void {
    session.page.on("request", (request: Request) => {
      if (!request.isNavigationRequest() || request.frame() !== session.page.mainFrame()) return;
      session.mainDocumentRequests += 1;
      session.operationRedirects += 1;
      if (session.operationRedirects > MAX_MAIN_DOCUMENT_REDIRECTS + 1) {
        this.failSession(session, new Error(`Browser navigation exceeded ${MAX_MAIN_DOCUMENT_REDIRECTS} redirect hops.`));
      }
      if (session.mainDocumentRequests > this.limits.maxMainDocumentRequests) {
        this.failSession(session, new Error(`Browser main-document request limit (${this.limits.maxMainDocumentRequests}) exhausted.`));
      }
    });
    session.page.on("framenavigated", (frame) => {
      if (frame !== session.page.mainFrame()) return;
      session.generation = this.uniqueHandle("generation");
      session.semanticRefs.clear();
    });
    session.page.on("dialog", (dialog) => void dialog.dismiss());
    session.page.on("download", (download) => void download.cancel());
    session.page.on("crash", () => this.failSession(session, new Error("Browser tab crashed; teardown started.")));
    session.page.on("close", () => {
      if (!session.teardown) this.failSession(session, new Error("Browser tab closed unexpectedly; teardown started."));
    });
    session.browser.on("disconnected", () => {
      if (!session.teardown) this.failSession(session, new Error("Browser process disconnected unexpectedly; teardown started."));
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
      this.touch(session);
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

  private requireSession(sessionHandle: string, tabHandle: string): Session {
    const session = this.sessions.get(sessionHandle);
    // One deliberately indistinguishable error rejects forged, stale,
    // cross-session, and cross-tab handles without making handles enumerable.
    if (!session || session.tab !== tabHandle) throw invalidHandleError();
    return session;
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
  // Start every shutdown path immediately and bound them concurrently. A hung
  // page close must not delay the broker kill or prevent context/process close
  // from being attempted within the same cleanup window.
  const operations = await Promise.allSettled([
    boundedCleanup(
      session.page.isClosed() ? Promise.resolve() : session.page.close({ runBeforeUnload: false }),
      deadlineMs,
      "browser tab close",
    ),
    boundedCleanup(session.context.close(), deadlineMs, "browser context close"),
    boundedCleanup(session.browser.close(), deadlineMs, "browser process close"),
    boundedCleanup(session.broker.close(), deadlineMs, "egress broker close"),
  ]);
  const operationFailures = operations
    .filter((operation): operation is PromiseRejectedResult => operation.status === "rejected")
    .map((operation) => operation.reason);
  const brokerOutcome = operations[3];
  const summary = brokerOutcome?.status === "fulfilled" ? brokerOutcome.value as EgressSummary : undefined;
  const stateFailures: unknown[] = [];
  if (!session.page.isClosed()) stateFailures.push(new Error("browser tab remains open"));
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

function bounded(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
