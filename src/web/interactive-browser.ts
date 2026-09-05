import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type BrowserType,
  type ConsoleMessage,
  type Dialog,
  type Download,
  type Locator,
  type Page,
  type Request,
  type Response,
  type WebSocketRoute,
} from "playwright";
import type { BrowserInteractionApproval, WebFetchConfig } from "../config";
import { redactSensitiveText } from "../redaction";
import { BrowserOutputPrivacy } from "./browser-output-privacy";
import { AsyncLocalStorage } from "node:async_hooks";
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
  type BrowserFormOperation,
  type BrowserTargetStructure,
} from "./browser-interaction-policy";

export const BROWSER_INTERACTION_SESSION_MAX_CHARS = 256;
export const BROWSER_INTERACTION_TAB_MAX_CHARS = 256;
export const BROWSER_INTERACTION_REF_MAX_CHARS = 512;
export const BROWSER_FILL_MAX_CHARS = 4_096;
export const BROWSER_TYPE_MAX_CHARS = 1_000;
export const BROWSER_TYPE_MAX_DELAY_MS = 5;
export const BROWSER_SELECT_MAX_OPTIONS = 32;
export const BROWSER_SELECT_OPTION_MAX_CHARS = 256;
export const BROWSER_PRESS_KEY_MAX_CHARS = 32;
export const BROWSER_DIAGNOSTIC_CURSOR_MAX = Number.MAX_SAFE_INTEGER;
export const BROWSER_DIAGNOSTIC_READ_MAX_EVENTS = 64;

// Manager-side admission bounds for page-created ws/wss routes, checked
// before Chromium's native stack is allowed to connect through the session
// broker. The broker independently re-validates and pins every destination.
const WS_MAX_URL_CHARS = 2_048;
const WS_MAX_PROTOCOLS = 8;
const WS_PROTOCOL_MAX_CHARS = 128;
/** Per-session cap on concurrent in-flight WebSocket admissions (pre-DNS). */
const WS_MAX_PENDING_ADMISSIONS = 8;
/** Hard deadline for one admission's destination validation. */
const WS_ADMISSION_MS = 5_000;

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
  maxConsoleEvents: number;
  maxConsoleTextChars: number;
  maxConsoleSourceChars: number;
  maxNetworkEvents: number;
  maxDiagnosticReadEvents: number;
  maxInspectTextChars: number;
  maxInspectNameChars: number;
  maxInspectDescriptionChars: number;
  navigationMs: number;
  actionMs: number;
  confirmationMs: number;
  idleSocketMs: number;
  cleanupMs: number;
  maxDistinctHosts: number;
  maxConnections: number;
  maxRequests: number;
  maxConnectionBytes: number;
  maxTotalBytes: number;
}

export const INTERACTIVE_BROWSER_LIMITS: Readonly<InteractiveBrowserLimits> = Object.freeze({
  maxSessions: 1,
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
  maxConsoleEvents: 128,
  maxConsoleTextChars: 1_000,
  maxConsoleSourceChars: 300,
  maxNetworkEvents: 256,
  maxDiagnosticReadEvents: BROWSER_DIAGNOSTIC_READ_MAX_EVENTS,
  maxInspectTextChars: 512,
  maxInspectNameChars: 256,
  maxInspectDescriptionChars: 512,
  navigationMs: 30_000,
  actionMs: 10_000,
  confirmationMs: 30_000,
  idleSocketMs: 20_000,
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

export interface BrowserConsoleEvent {
  sequence: number;
  elapsedMs: number;
  kind: "console" | "page_error";
  level: "debug" | "info" | "log" | "warning" | "error" | "other";
  text: string;
  textTruncated: boolean;
  source: { origin: string; line: number; column: number } | null;
  errorName?: string;
}

export interface BrowserNetworkEvent {
  sequence: number;
  elapsedMs: number;
  phase: "request" | "response" | "failure" | "policy";
  method: string;
  origin: string;
  resourceKind: string;
  status?: number;
  durationMs?: number;
  outcome: "observed" | "succeeded" | "failed" | "policy_blocked";
  failure?: string;
  /**
   * WebSocket lifecycle marker, present only for websocket-kind records.
   * Truthful by construction: "created" is the observed route admission,
   * "closed" is the terminal state reported by the browser's own WebSocket
   * stack (or the manager-issued refusal close). No connected state is ever
   * claimed; a working connection is proven by page/app state. Frame content
   * is never retained.
   */
  wsState?: "created" | "closed";
  /** Close code as exposed by the browser's WebSocket stack, when present. */
  closeCode?: number;
}

export interface BrowserDiagnosticResult<T> {
  session: string;
  tab: string;
  generation: string;
  events: T[];
  cursor: {
    requested: number;
    next: number;
    latest: number;
    oldestRetained: number;
  };
  counts: {
    returned: number;
    dropped: number;
    totalDropped: number;
    truncated: number;
    captureTruncated: number;
    totalCaptureTruncated: number;
  };
  capacity: number;
  untrusted: true;
}

export interface BrowserInspectResult {
  session: string;
  tab: string;
  generation: string;
  ref: string;
  semantic: {
    role: string | null;
    tag: string;
    type: string | null;
    accessibleName: string;
    accessibleDescription: string;
    states: {
      checked: boolean | "mixed" | null;
      disabled: boolean;
      expanded: boolean | null;
      selected: boolean | null;
      focused: boolean;
      editable: boolean;
    };
    hrefOrigin: string | null;
    visibleText: {
      text: string;
      returnedChars: number;
      truncated: boolean;
      suppressed: boolean;
    };
  };
  untrusted: true;
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
  omittedEntries: number;
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
  network: "not_observed" | "observed";
  accounting: "bounded_stable" | "bounded_uncertain";
}

export interface BrowserInteractionResult {
  session: string;
  tab: string;
  generation: string;
  operation: "hover" | "click" | BrowserFormOperation;
  consequence: BrowserConsequence | "observational";
  /** True only for interactive human confirmation, never automatic approval. */
  confirmed: boolean;
  approval: "not_required" | "human" | "automatic";
  effect: BrowserInteractionEffectState;
  effects: BrowserInteractionEffects;
  url: string;
}

export interface BrowserInteractionConfirmationRequest {
  title: string;
  message: string;
}

export type BrowserInteractionConfirmation = (request: BrowserInteractionConfirmationRequest) => Promise<boolean>;
/** Compatibility alias for the original click API. */
export type BrowserClickConfirmation = BrowserInteractionConfirmation;

export interface BrowserClosureReason {
  kind: "explicit_close" | "session_shutdown" | "fatal_error";
  message: string;
}

/** Only issued for a handle authenticated by this manager, never guesses. */
export class BrowserSessionClosedError extends Error {
  constructor(readonly closure: BrowserClosureReason | undefined) {
    super(`Browser session is closed${closure ? ` (${closure.kind}: ${closure.message})` : ""}. Use BrowserOpen to start a new browser; do not replay uncertain actions automatically.`);
    this.name = "BrowserSessionClosedError";
  }
}

export type BrowserRecoveryKind =
  | "duplicate_open"
  | "session_unknown"
  | "tabs"
  | "cancelled"
  | "unconfirmed_cleanup";

export interface BrowserRecoveryMetadata {
  kind: BrowserRecoveryKind;
  /** Dispatch phase at cancellation: no page effect, page effect possible, or unknowable. */
  phase?: "not_started" | "dispatched" | "unknown";
  /** Whether the manager proved resource cleanup; never claimed without proof. */
  cleanup?: "confirmed" | "unconfirmed";
  /** Authenticated live session revealed by a duplicate open after a lost result. */
  existingSession?: string;
  existingTab?: string;
  /** Authenticated session owning the listed tabs. */
  session?: string;
  /** Real owned tab handles, never generated placeholders. */
  ownedTabs?: readonly string[];
  /** Whether the caller may retry the same tool or must reopen via BrowserOpen. */
  recovery?: "retry" | "reopen";
}

/**
 * Structured, manager-authored recovery state for cancellation, stale-handle,
 * duplicate-open, and teardown outcomes. The message is fixed owned guidance;
 * public sanitization classifies from these fields instead of parsing
 * arbitrary exception text.
 */
export class BrowserRecoveryError extends Error {
  constructor(message: string, readonly recovery: BrowserRecoveryMetadata) {
    super(message);
    this.name = "BrowserRecoveryError";
  }
}

export interface BrowserCloseResult {
  session: string;
  closed: true;
  alreadyClosed: boolean;
  quiescent: true;
  broker: (Pick<EgressSummary, "budgetAborts" | "refusals"> & { connections: number }) | null;
  diagnosticsRetained: boolean;
  closure?: BrowserClosureReason;
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

interface ActiveBrowserOperation {
  session: Session;
  controller: AbortController;
  settled: Promise<void>;
  settle(): void;
}

interface CapturedAriaSemantic {
  role: string | null;
  name: string;
  checked: boolean | "mixed" | null;
  disabled: boolean;
  expanded: boolean | null;
  selected: boolean | null;
  focused: boolean;
}

interface BrowserTab {
  handle: string;
  generation: string;
  page: Page;
  semanticRefs: Map<string, { generation: string; playwrightRef: string; semantic: CapturedAriaSemantic }>;
  history: Array<{ id: number; index: number; url: string; generation: string }>;
  historyIndex: number;
  historyOmitted?: number;
  documentStatus?: number;
  documentRequestPending: boolean;
  closing: boolean;
  diagnosticsActive: boolean;
  consoleDiagnostics: DiagnosticRing<BrowserConsoleEvent>;
  networkDiagnostics: DiagnosticRing<BrowserNetworkEvent>;
  networkStartedAt: WeakMap<Request, number>;
  networkPolicy: WeakMap<Request, string>;
}

interface InteractionCapture {
  dialogs: number;
  downloads: number;
  popupTabs: Set<string>;
  overflowPopups: number;
  networkRequests: number;
  events: number;
  settlements: Promise<void>[];
}

interface Session {
  handle: string;
  activeTab: string;
  tabs: Map<string, BrowserTab>;
  pendingPageClosures: Map<Page, Promise<void>>;
  pendingPageCreations: Set<Promise<void>>;
  /** In-flight page-initiated WebSocket admissions; settled on teardown. */
  pendingWebSocketAdmissions: Set<Promise<void>>;
  /** Aborted when teardown begins so pending admissions stop waiting at once. */
  admissionAbort: AbortController;
  browser: Browser;
  context: BrowserContext;
  broker: EgressBroker;
  createdAt: number;
  navigations: number;
  actions: number;
  mainDocumentRequests: number;
  operationActive: boolean;
  interactionCapture?: InteractionCapture;
  fatalError?: Error;
  teardown?: Promise<BrowserCloseResult>;
}

const MAX_TOMBSTONES = 32;
const SAFE_LOCAL_PROTOCOLS = new Set(["about:", "blob:", "data:"]);

/** Fixed manager-owned cancellation reasons; never caller-controlled text. */
const BROWSER_CLOSE_CANCEL_REASON = "Browser operation cancelled by BrowserClose.";
const SESSION_SHUTDOWN_CANCEL_REASON = "Browser operation cancelled by Pi session shutdown/replacement/reload.";

type BrowserCancellationKind = "close" | "shutdown" | "caller";

type DiagnosticEvent = { sequence: number; textTruncated?: boolean };

/** A capture-time-bounded, memory-only ring with a never-reused tab-local cursor. */
class DiagnosticRing<T extends DiagnosticEvent> {
  private events: T[] = [];
  private nextSequence = 1;
  private dropped = 0;
  private captureTruncated = 0;

  constructor(readonly capacity: number) {}

  push(event: Omit<T, "sequence">): void {
    const captured = { ...event, sequence: this.nextSequence++ } as T;
    if (captured.textTruncated) this.captureTruncated += 1;
    if (this.events.length >= this.capacity) {
      this.events.shift();
      this.dropped += 1;
    }
    this.events.push(captured);
  }

  read(after: number, maximum: number): {
    events: T[];
    requested: number;
    next: number;
    latest: number;
    oldestRetained: number;
    dropped: number;
    totalDropped: number;
    truncated: number;
    captureTruncated: number;
    totalCaptureTruncated: number;
  } {
    const latest = this.nextSequence - 1;
    if (!Number.isSafeInteger(after) || after < 0 || after > latest) {
      throw new Error(`Browser diagnostic cursor must be an integer from 0 through ${latest}.`);
    }
    const oldestRetained = this.events[0]?.sequence ?? this.nextSequence;
    const dropped = Math.max(0, oldestRetained - 1 - after);
    const eligible = this.events.filter((event) => event.sequence > after);
    const events = eligible.slice(0, maximum).map((event) => ({ ...event }));
    const next = events.at(-1)?.sequence ?? Math.max(after, oldestRetained - 1);
    return {
      events,
      requested: after,
      next,
      latest,
      oldestRetained,
      dropped,
      totalDropped: this.dropped,
      truncated: eligible.length - events.length,
      captureTruncated: events.filter((event) => event.textTruncated).length,
      totalCaptureTruncated: this.captureTruncated,
    };
  }

  clear(): void {
    this.events = [];
    this.nextSequence = 1;
    this.dropped = 0;
    this.captureTruncated = 0;
  }
}

/**
 * Process-local owner for isolated interactive browser sessions. Nothing is
 * persisted: opaque handles and all authenticated broker credentials die with
 * this extension process.
 */
export class InteractiveBrowserManager {
  // One manager belongs to one Pi session. Retain across browser close/reopen
  // because later tabs can redisplay previously entered content.
  private readonly outputPrivacy = new BrowserOutputPrivacy();

  protectOutput<T>(value: T): T { return this.outputPrivacy.output(value); }

  private privateConfirmation(confirmation?: BrowserInteractionConfirmation): BrowserInteractionConfirmation | undefined {
    return confirmation ? request => confirmation({
      title: this.outputPrivacy.text(request.title),
      message: this.outputPrivacy.text(request.message),
    }) : undefined;
  }

  private readonly sessions = new Map<string, Session>();
  private readonly closedTombstones = new Map<string, BrowserCloseResult>();
  private readonly failedTombstones = new Map<string, Error>();
  private readonly openings = new Set<OpeningOperation>();
  private readonly activeOperations = new Set<ActiveBrowserOperation>();
  private readonly handleAuthenticationKey = randomBytes(32);
  private opening = 0;
  private shuttingDown = false;
  private quiescing = false;
  private quiescence?: Promise<void>;
  private shutdownFailure?: Error;
  private readonly resolveHostname: HostResolver;
  private readonly launch: BrowserType["launch"];
  private readonly now: () => number;
  private readonly randomHandle: NonNullable<InteractiveBrowserDependencies["randomHandle"]>;
  private readonly consequencePolicy: BrowserConsequencePolicy;
  private readonly confirmationPermits: BrowserConfirmationPermits;
  private interactionApproval: BrowserInteractionApproval = "ask";
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
      maxSessions: 1,
      maxTabsPerSession: clampedTestLimit(requestedLimits.maxTabsPerSession, INTERACTIVE_BROWSER_LIMITS.maxTabsPerSession),
      maxHistoryEntries: clampedTestLimit(requestedLimits.maxHistoryEntries, INTERACTIVE_BROWSER_LIMITS.maxHistoryEntries),
      maxScrollPages: clampedTestLimit(requestedLimits.maxScrollPages, INTERACTIVE_BROWSER_LIMITS.maxScrollPages),
      maxWaitTextChars: clampedTestLimit(requestedLimits.maxWaitTextChars, INTERACTIVE_BROWSER_LIMITS.maxWaitTextChars),
      maxWaitPatternChars: clampedTestLimit(requestedLimits.maxWaitPatternChars, INTERACTIVE_BROWSER_LIMITS.maxWaitPatternChars),
      maxWaitMs: clampedTestLimit(requestedLimits.maxWaitMs, INTERACTIVE_BROWSER_LIMITS.maxWaitMs),
      maxConsoleEvents: clampedTestLimit(requestedLimits.maxConsoleEvents, INTERACTIVE_BROWSER_LIMITS.maxConsoleEvents),
      maxConsoleTextChars: clampedTestLimit(requestedLimits.maxConsoleTextChars, INTERACTIVE_BROWSER_LIMITS.maxConsoleTextChars),
      maxConsoleSourceChars: clampedTestLimit(requestedLimits.maxConsoleSourceChars, INTERACTIVE_BROWSER_LIMITS.maxConsoleSourceChars),
      maxNetworkEvents: clampedTestLimit(requestedLimits.maxNetworkEvents, INTERACTIVE_BROWSER_LIMITS.maxNetworkEvents),
      maxDiagnosticReadEvents: clampedTestLimit(requestedLimits.maxDiagnosticReadEvents, INTERACTIVE_BROWSER_LIMITS.maxDiagnosticReadEvents),
      maxInspectTextChars: clampedTestLimit(requestedLimits.maxInspectTextChars, INTERACTIVE_BROWSER_LIMITS.maxInspectTextChars),
      maxInspectNameChars: clampedTestLimit(requestedLimits.maxInspectNameChars, INTERACTIVE_BROWSER_LIMITS.maxInspectNameChars),
      maxInspectDescriptionChars: clampedTestLimit(requestedLimits.maxInspectDescriptionChars, INTERACTIVE_BROWSER_LIMITS.maxInspectDescriptionChars),
    });
  }

  updateConfig(config: WebFetchConfig, interactionApproval: BrowserInteractionApproval = "ask"): void {
    this.config = config;
    this.interactionApproval = interactionApproval;
  }

  /** Select policy at the approval-required branch, after target restrictions.
   * Automatic approval still issues and consumes the ordinary one-use bound permit.
   */
  private interactionAuthorization(name: string, confirmation?: BrowserInteractionConfirmation): {
    confirm: BrowserInteractionConfirmation;
    source: "human" | "automatic";
  } {
    if (this.interactionApproval === "automatically-deny") {
      throw new Error(`${name} not_started: browser interaction approval policy automatically denied this approval-required action.`);
    }
    if (this.interactionApproval === "automatically-accept") {
      return { confirm: async () => true, source: "automatic" };
    }
    if (!confirmation) {
      throw new Error(`${name} not_started: this structurally consequential or unknown action requires an interactive Pi confirmation; background or no-UI execution is rejected.`);
    }
    return { confirm: confirmation, source: "human" };
  }

  async open(url: string, signal?: AbortSignal): Promise<BrowserOpenResult> {
    this.assertAcceptingOperations();
    const existing = this.sessions.values().next().value as Session | undefined;
    if (existing) {
      throw duplicateOpenError(existing);
    }
    if (this.opening > 0) {
      throw new Error("BrowserOpen is already in progress for this Pi session. Wait for its result and use its session/tab handles; no second browser was opened.");
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
    let navigationDispatched = false;
    try {
      // This is a no-dial preflight. The broker independently validates and
      // pins the actual browser request before opening its destination socket.
      const requested = await operation.run(validateNavigationUrl(url, this.resolveHostname), "URL validation");
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
        // Interactive sessions own the browser lifetime: quiet live ws/wss
        // connections must survive ordinary idle, turns, and reviews. Hard
        // byte/connection budgets and teardown still drain every socket.
        { enabled: true, liveIdleSocketMs: null },
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
      let pendingSession: Session | undefined;
      await operation.run(installRoutePolicy(context, broker, (request, reason) => {
        if (pendingSession) this.recordNetworkPolicy(pendingSession, request, reason);
      }), "network route policy installation");

      const page = await operation.run(context.newPage(), "browser tab creation");
      const primaryTab: BrowserTab = {
        handle: this.uniqueHandle("tab"),
        generation: this.uniqueHandle("generation"),
        page,
        semanticRefs: new Map(),
        history: [],
        historyIndex: -1,
        documentRequestPending: false,
        closing: false,
        diagnosticsActive: true,
        consoleDiagnostics: new DiagnosticRing(this.limits.maxConsoleEvents),
        networkDiagnostics: new DiagnosticRing(this.limits.maxNetworkEvents),
        networkStartedAt: new WeakMap(),
        networkPolicy: new WeakMap(),
      };
      const session: Session = {
        handle: this.uniqueHandle("session"),
        activeTab: primaryTab.handle,
        tabs: new Map([[primaryTab.handle, primaryTab]]),
        pendingPageClosures: new Map(),
        pendingPageCreations: new Set(),
        pendingWebSocketAdmissions: new Set(),
        admissionAbort: new AbortController(),
        browser,
        context,
        broker,
        createdAt: this.now(),
        navigations: 0,
        actions: 0,
        mainDocumentRequests: 0,
        operationActive: true,
      };
      pendingSession = session;
      pendingFatal = (error) => this.failSession(session, error);
      // Await tab-scoped WebSocket route activation before any page work so
      // the first navigation's sockets can never hit the context backstop.
      await operation.run(this.installPageGuards(session, primaryTab), "websocket route installation");
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
      try {
        const navigation = await this.navigateSession(session, primaryTab, requested.href, operation, true, () => {
          navigationDispatched = true;
        });
        session.operationActive = false;
        return this.protectOutput({ ...navigation, limits: this.limits });
      } catch (error) {
        session.operationActive = false;
        try {
          await this.failAndWait(session, asError(error));
        } catch (cleanupError) {
          this.recordOpeningTeardownFailure(opening, asError(cleanupError));
          throw unconfirmedOpenCleanupError();
        }
        const cancellation = cancellationKind(operationSignal);
        if (cancellation) throw openCancellationError(cancellation, navigationDispatched);
        throw error;
      }
    } catch (error) {
      if (error instanceof BrowserRecoveryError) throw error;
      const cancellation = resourcesTransferredToSession ? undefined : cancellationKind(operationSignal);
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
        try {
          await cleanupPartial(
            browser,
            context,
            broker,
            this.limits.cleanupMs,
            lateBrowserCleanup,
            lateContextCleanup,
          );
        } catch (cleanupError) {
          const failure = new AggregateError(
            [error, cleanupError],
            "BrowserOpen failed and teardown could not be confirmed.",
          );
          this.recordOpeningTeardownFailure(opening, failure);
          throw unconfirmedOpenCleanupError();
        }
      }
      if (cancellation) throw openCancellationError(cancellation, navigationDispatched);
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
    return this.operate(session, signal, async (operationSignal) => {
      const operation = new OperationDeadline("BrowserNavigate", this.limits.navigationMs, operationSignal);
      try {
        return await this.navigateSession(session, tab, url, operation, false);
      } finally {
        operation.dispose();
      }
    }, true);
  }

  async snapshot(sessionHandle: string, tabHandle: string, maxChars: number, signal?: AbortSignal): Promise<BrowserSnapshotResult> {
    const { session, tab } = this.requireTab(sessionHandle, tabHandle);
    return this.operate(session, signal, async (operationSignal) => {
      const operation = new OperationDeadline("BrowserSnapshot", this.limits.actionMs, operationSignal);
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
        const capturedRefs = new Map<string, { generation: string; playwrightRef: string; semantic: CapturedAriaSemantic }>();
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
            const lineStart = raw.lastIndexOf("\n", rawOffset) + 1;
            const nextLine = raw.indexOf("\n", rawOffset);
            const lineEnd = nextLine < 0 ? raw.length : nextLine;
            // Keep computed semantics, never the raw line or any value text
            // that may follow its structural metadata.
            const semantic = parseAriaRoot(raw.slice(lineStart, Math.min(lineEnd, lineStart + 2_048)));
            capturedRefs.set(opaqueRef, { generation: capturedGeneration, playwrightRef, semantic });
          }
          return replacement;
        });
        const snapshot = this.outputPrivacy.output({ snapshot: semantic }).snapshot.slice(0, limit);
        const snapshotUrl = publicPageUrl(tab.page.url());
        const title = bounded(this.outputPrivacy.text(await operation.run(tab.page.title(), "browser title read")), 500);
        if (tab.generation !== capturedGeneration) {
          throw new Error("Browser document changed during semantic snapshot capture; snapshot rejected.");
        }
        // Only refs wholly present in the returned, bounded snapshot remain
        // current. A new snapshot replaces this map rather than accumulating
        // page-controlled references for the session lifetime.
        tab.semanticRefs.clear();
        for (const [opaqueRef, ref] of capturedRefs) {
          if (snapshot.includes(`[ref=${opaqueRef}]`)) tab.semanticRefs.set(opaqueRef, ref);
        }
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

  async console(
    sessionHandle: string,
    tabHandle: string,
    cursor = 0,
    maxEvents = this.limits.maxDiagnosticReadEvents,
    signal?: AbortSignal,
  ): Promise<BrowserDiagnosticResult<BrowserConsoleEvent>> {
    return this.readDiagnostics("BrowserConsole", sessionHandle, tabHandle, cursor, maxEvents, signal, "consoleDiagnostics");
  }

  async network(
    sessionHandle: string,
    tabHandle: string,
    cursor = 0,
    maxEvents = this.limits.maxDiagnosticReadEvents,
    signal?: AbortSignal,
  ): Promise<BrowserDiagnosticResult<BrowserNetworkEvent>> {
    return this.readDiagnostics("BrowserNetwork", sessionHandle, tabHandle, cursor, maxEvents, signal, "networkDiagnostics");
  }

  async inspect(
    sessionHandle: string,
    tabHandle: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<BrowserInspectResult> {
    assertBoundedInteractionCapability(sessionHandle, BROWSER_INTERACTION_SESSION_MAX_CHARS);
    assertBoundedInteractionCapability(tabHandle, BROWSER_INTERACTION_TAB_MAX_CHARS);
    assertBoundedInteractionCapability(ref, BROWSER_INTERACTION_REF_MAX_CHARS);
    const { session, tab } = this.requireTab(sessionHandle, tabHandle);
    return this.operate(session, signal, async (operationSignal) => {
      const operation = new OperationDeadline("BrowserInspect", this.limits.actionMs, operationSignal);
      const generation = tab.generation;
      try {
        const semanticRef = tab.semanticRefs.get(ref);
        if (!semanticRef || semanticRef.generation !== generation) throw invalidRefError();
        const locator = tab.page.locator(`aria-ref=${semanticRef.playwrightRef}`);
        const raw = await operation.run(readSemanticDetail(locator, tab.page, semanticRef.semantic, {
          text: this.limits.maxInspectTextChars,
          name: this.limits.maxInspectNameChars,
          description: this.limits.maxInspectDescriptionChars,
        }, operation.remainingMs(), operation.signal), "bounded semantic detail read");
        throwIfAborted(operation.signal);
        if (tab.generation !== generation) {
          throw new Error("Browser document changed during semantic detail read; result rejected.");
        }
        return {
          session: session.handle,
          tab: tab.handle,
          generation,
          ref,
          semantic: sanitizeSemanticDetail(raw, this.limits),
          untrusted: true,
        };
      } catch (error) {
        if (operation.signal.aborted) await this.failAndWait(session, asError(error));
        throw error;
      } finally {
        operation.dispose();
      }
    });
  }

  private async readDiagnostics<K extends "consoleDiagnostics" | "networkDiagnostics">(
    name: "BrowserConsole" | "BrowserNetwork",
    sessionHandle: string,
    tabHandle: string,
    cursor: number,
    maxEvents: number,
    signal: AbortSignal | undefined,
    kind: K,
  ): Promise<BrowserDiagnosticResult<K extends "consoleDiagnostics" ? BrowserConsoleEvent : BrowserNetworkEvent>> {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > this.limits.maxDiagnosticReadEvents) {
      throw new Error(`${name} maxEvents must be an integer from 1-${this.limits.maxDiagnosticReadEvents}.`);
    }
    const { session, tab } = this.requireTab(sessionHandle, tabHandle);
    return this.operate(session, signal, async (operationSignal) => {
      throwIfAborted(operationSignal);
      const ring = tab[kind] as DiagnosticRing<BrowserConsoleEvent> | DiagnosticRing<BrowserNetworkEvent>;
      const read = ring.read(cursor, maxEvents);
      return {
        session: session.handle,
        tab: tab.handle,
        generation: tab.generation,
        events: read.events,
        cursor: {
          requested: read.requested,
          next: read.next,
          latest: read.latest,
          oldestRetained: read.oldestRetained,
        },
        counts: {
          returned: read.events.length,
          dropped: read.dropped,
          totalDropped: read.totalDropped,
          truncated: read.truncated,
          captureTruncated: read.captureTruncated,
          totalCaptureTruncated: read.totalCaptureTruncated,
        },
        capacity: ring.capacity,
        untrusted: true,
      } as BrowserDiagnosticResult<K extends "consoleDiagnostics" ? BrowserConsoleEvent : BrowserNetworkEvent>;
    });
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
    return this.operate(session, signal, async (operationSignal) => {
      const operation = new OperationDeadline("BrowserScreenshot", this.limits.actionMs, operationSignal);
      try {
        const capturedGeneration = tab.generation;
        let image: Buffer;
        if (mode === "viewport") {
          if (ref !== undefined) throw new BrowserValidationError("BrowserScreenshot viewport mode does not accept ref.");
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
          if (!ref) throw new BrowserValidationError("BrowserScreenshot element mode requires a current ref from BrowserSnapshot.");
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
        const title = bounded(this.outputPrivacy.text(await operation.run(tab.page.title(), "browser title read")), 500);
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
    return this.operate(session, signal, async (operationSignal) => {
      const operation = new OperationDeadline("BrowserScroll", this.limits.actionMs, operationSignal);
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
      return await this.interact(sessionHandle, tabHandle, ref, "click", this.privateConfirmation(confirmation), signal);
    } catch (error) {
      throw normalizedInteractionFailure("BrowserClick", error);
    }
  }

  async fill(
    sessionHandle: string,
    tabHandle: string,
    ref: string,
    value: string,
    confirmation?: BrowserInteractionConfirmation,
    signal?: AbortSignal,
  ): Promise<BrowserInteractionResult> {
    try {
      assertExactText(value, BROWSER_FILL_MAX_CHARS, true);
      return await this.formInteract(sessionHandle, tabHandle, ref, { operation: "fill", values: [value] }, confirmation, signal);
    } catch (error) {
      throw normalizedInteractionFailure("BrowserFill", error);
    }
  }

  async type(
    sessionHandle: string,
    tabHandle: string,
    ref: string,
    text: string,
    delayMs = 0,
    confirmation?: BrowserInteractionConfirmation,
    signal?: AbortSignal,
  ): Promise<BrowserInteractionResult> {
    try {
      assertExactText(text, BROWSER_TYPE_MAX_CHARS, false);
      if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > BROWSER_TYPE_MAX_DELAY_MS) throw new Error("invalid bounded delay");
      return await this.formInteract(sessionHandle, tabHandle, ref, { operation: "type", values: [text], delayMs }, confirmation, signal);
    } catch (error) {
      throw normalizedInteractionFailure("BrowserType", error);
    }
  }

  async select(
    sessionHandle: string,
    tabHandle: string,
    ref: string,
    options: readonly string[],
    confirmation?: BrowserInteractionConfirmation,
    signal?: AbortSignal,
  ): Promise<BrowserInteractionResult> {
    try {
      assertSelectValues(options);
      return await this.formInteract(sessionHandle, tabHandle, ref, { operation: "select", values: [...options] }, confirmation, signal);
    } catch (error) {
      throw normalizedInteractionFailure("BrowserSelect", error);
    }
  }

  async press(
    sessionHandle: string,
    tabHandle: string,
    ref: string,
    key: string,
    confirmation?: BrowserInteractionConfirmation,
    signal?: AbortSignal,
  ): Promise<BrowserInteractionResult> {
    try {
      const normalizedKey = normalizeBrowserPressKey(key);
      return await this.formInteract(sessionHandle, tabHandle, ref, { operation: "press", values: [], key: normalizedKey }, confirmation, signal);
    } catch (error) {
      throw normalizedInteractionFailure("BrowserPress", error);
    }
  }

  private async formInteract(
    sessionHandle: string,
    tabHandle: string,
    ref: string,
    action: { operation: BrowserFormOperation; values: string[]; delayMs?: number; key?: string },
    confirmation: BrowserInteractionConfirmation | undefined,
    signal: AbortSignal | undefined,
  ): Promise<BrowserInteractionResult> {
    const name = `Browser${action.operation[0]!.toUpperCase()}${action.operation.slice(1)}` as
      "BrowserFill" | "BrowserType" | "BrowserSelect" | "BrowserPress";
    confirmation = this.privateConfirmation(confirmation);
    try {
      assertBoundedInteractionCapability(sessionHandle, BROWSER_INTERACTION_SESSION_MAX_CHARS);
      assertBoundedInteractionCapability(tabHandle, BROWSER_INTERACTION_TAB_MAX_CHARS);
      assertBoundedInteractionCapability(ref, BROWSER_INTERACTION_REF_MAX_CHARS);
      const { session, tab } = this.requireTab(sessionHandle, tabHandle);
      return await this.operate(session, signal, async (operationSignal) => {
        const operation = new OperationDeadline(name, this.limits.confirmationMs, operationSignal);
        const capturedGeneration = tab.generation;
        const capturedOrigin = interactionIdentityUrl(tab.page.url());
        const valueDigest = action.values.length > 0 ? digestExactValues(action.values) : null;
        const valueLengths = action.values.map((value) => value.length);
        let started = false;
        let capture: InteractionCapture | undefined;
        try {
          // Retain even denied attempts: a page may already echo this literal
          // in an origin/label shown by the approval prompt.
          this.outputPrivacy.remember(action.values);
          let locator = this.currentRefLocator(tab, ref);
          await operation.run(locator.waitFor({ state: "visible", timeout: operation.remainingMs() }), "semantic target validation");
          const structure = await operation.run(readTargetStructure(locator, tab.page), "structural consequence inspection");
          assertSuitableFormTarget(structure, action.operation);
          let selectedKinds: Array<"value" | "label"> | undefined;
          const decision = this.consequencePolicy.classifyForm(structure, { operation: action.operation, key: action.key });
          let approval: BrowserInteractionResult["approval"] = "not_required";
          const originalFingerprint = this.consequencePolicy.fingerprint(structure);

          if (decision.consequential) {
            const authorization = this.interactionAuthorization(name, confirmation);
            const binding = this.formConfirmationBinding(
              session, tab, ref, capturedOrigin, structure, decision.consequence,
              decision.destination, action.operation, valueDigest, valueLengths, action.key ?? null,
            );
            const permit = this.confirmationPermits.issue(binding);
            let approved = false;
            try {
              approved = await operation.run(
                authorization.confirm(formConfirmationPrompt(action.operation, decision.consequence, capturedOrigin, decision.destination)),
                "interaction approval",
              );
            } catch {
              this.confirmationPermits.revoke(permit);
              throw new Error(`${name} not_started: interaction approval was unavailable or cancelled.`);
            }
            if (!approved) {
              this.confirmationPermits.revoke(permit);
              throw new Error(`${name} not_started: interactive confirmation was denied.`);
            }
            try {
              throwIfAborted(operation.signal);
              if (session.teardown || session.fatalError || tab.page.isClosed()) {
                throw new Error(`${name} not_started: the browser session changed or closed after approval.`);
              }
              if (tab.generation !== capturedGeneration || interactionIdentityUrl(tab.page.url()) !== capturedOrigin) {
                this.invalidateInteractionRefs(tab, capturedGeneration);
                throw new Error(`${name} not_started: the document or origin changed after approval; take a fresh BrowserSnapshot.`);
              }
              locator = this.currentRefLocator(tab, ref);
              const revalidatedStructure = await operation.run(readTargetStructure(locator, tab.page), "post-approval target revalidation");
              assertSuitableFormTarget(revalidatedStructure, action.operation);
              const revalidatedDecision = this.consequencePolicy.classifyForm(revalidatedStructure, { operation: action.operation, key: action.key });
              const rebound = this.formConfirmationBinding(
                session, tab, ref, capturedOrigin, revalidatedStructure, revalidatedDecision.consequence,
                revalidatedDecision.destination, action.operation, valueDigest, valueLengths, action.key ?? null,
              );
              if (!this.confirmationPermits.consume(permit, rebound)) {
                this.invalidateInteractionRefs(tab, capturedGeneration);
                throw new Error(`${name} not_started: the approved target or consequence changed; take a fresh BrowserSnapshot.`);
              }
              approval = authorization.source;
            } catch (error) {
              // Revocation is harmless after consume and guarantees every
              // approval path is single-use even when re-resolution itself fails.
              this.confirmationPermits.revoke(permit);
              throw error;
            }
          } else {
            if (tab.generation !== capturedGeneration || interactionIdentityUrl(tab.page.url()) !== capturedOrigin) {
              this.invalidateInteractionRefs(tab, capturedGeneration);
              throw new Error(`${name} not_started: the document or origin changed before dispatch; take a fresh BrowserSnapshot.`);
            }
            locator = this.currentRefLocator(tab, ref);
            const revalidatedStructure = await operation.run(readTargetStructure(locator, tab.page), "safe-target revalidation");
            assertSuitableFormTarget(revalidatedStructure, action.operation);
            const revalidatedDecision = this.consequencePolicy.classifyForm(revalidatedStructure, { operation: action.operation, key: action.key });
            if (
              revalidatedDecision.consequential
              || revalidatedDecision.consequence !== decision.consequence
              || revalidatedDecision.destination !== decision.destination
              || this.consequencePolicy.fingerprint(revalidatedStructure) !== originalFingerprint
            ) {
              this.invalidateInteractionRefs(tab, capturedGeneration);
              throw new Error(`${name} not_started: the local-editing proof changed; take a fresh BrowserSnapshot.`);
            }
          }

          if (action.operation === "select") {
            const selected = await operation.run(resolveExactSelectOptions(locator, action.values), "isolated exact option resolution");
            this.outputPrivacy.remember(selected.labels);
            selectedKinds = selected.kinds;
          }
          capture = newInteractionCapture();
          session.interactionCapture = capture;
          started = true;
          if (action.operation === "fill") {
            await operation.run(locator.fill(action.values[0]!, { timeout: operation.remainingMs() }), "bounded fill dispatch");
          } else if (action.operation === "type") {
            await operation.run(positionAppendCaret(locator), "bounded append positioning");
            await operation.run(locator.pressSequentially(action.values[0]!, {
              delay: action.delayMs ?? 0,
              timeout: operation.remainingMs(),
            }), "bounded type dispatch");
          } else if (action.operation === "select") {
            await operation.run(locator.selectOption(action.values.map((value, index) =>
              selectedKinds![index] === "value" ? { value } : { label: value }), {
              timeout: operation.remainingMs(),
            }), "bounded select dispatch");
          } else {
            await operation.run(locator.press(action.key!, { timeout: operation.remainingMs() }), "bounded key dispatch");
          }
          const accounting = await accountInteractionEffects(capture, operation);
          if (session.fatalError) throw session.fatalError;
          const navigated = tab.generation !== capturedGeneration || interactionIdentityUrl(tab.page.url()) !== capturedOrigin;
          this.invalidateInteractionRefs(tab, capturedGeneration);
          return interactionResult(session, tab, action.operation, decision.consequence, approval, capture, accounting, navigated);
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
    } catch (error) {
      throw normalizedInteractionFailure(name, error);
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
    return this.operate(session, signal, async (operationSignal) => {
      const name = operationName === "click" ? "BrowserClick" : "BrowserHover";
      const operation = new OperationDeadline(
        name,
        operationName === "click" ? this.limits.confirmationMs : this.limits.actionMs,
        operationSignal,
      );
      const capturedGeneration = tab.generation;
      const capturedOrigin = interactionIdentityUrl(tab.page.url());
      let started = false;
      let capture: InteractionCapture | undefined;
      try {
        const locator = this.currentRefLocator(tab, ref);
        await operation.run(locator.waitFor({ state: "visible", timeout: operation.remainingMs() }), "semantic target validation");
        const structure = await operation.run(readTargetStructure(locator, tab.page), "structural consequence inspection");
        const decision = this.consequencePolicy.classify(structure);
        let approval: BrowserInteractionResult["approval"] = "not_required";

        if (operationName === "click" && decision.consequential) {
          const authorization = this.interactionAuthorization(name, confirmation);
          const binding = this.confirmationBinding(session, tab, ref, capturedOrigin, structure, decision.consequence, decision.destination);
          const permit = this.confirmationPermits.issue(binding);
          let approved = false;
          try {
            approved = await operation.run(authorization.confirm(confirmationPrompt(decision.consequence, capturedOrigin, decision.destination)), "interaction approval");
          } catch {
            this.confirmationPermits.revoke(permit);
            throw new Error("BrowserClick not_started: interaction approval was unavailable or cancelled.");
          }
          if (!approved) {
            this.confirmationPermits.revoke(permit);
            throw new Error("BrowserClick not_started: interactive confirmation was denied.");
          }

          try {
            throwIfAborted(operation.signal);
            if (session.teardown || session.fatalError || tab.page.isClosed()) {
              throw new Error("BrowserClick not_started: the browser session changed or closed after approval.");
            }
            if (tab.generation !== capturedGeneration || interactionIdentityUrl(tab.page.url()) !== capturedOrigin) {
              this.invalidateInteractionRefs(tab, capturedGeneration);
              throw new Error("BrowserClick not_started: the document or origin changed after approval; take a fresh BrowserSnapshot.");
            }
            const revalidatedStructure = await operation.run(readTargetStructure(this.currentRefLocator(tab, ref), tab.page), "post-approval target revalidation");
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
              throw new Error("BrowserClick not_started: the approved target or consequence changed; take a fresh BrowserSnapshot.");
            }
            approval = authorization.source;
          } finally {
            // Also revoke on failed re-resolution or cancellation, as for form actions.
            this.confirmationPermits.revoke(permit);
          }
        } else if (operationName === "click") {
          // Silent paths receive the same immediate structural revalidation as
          // confirmed paths. Any loss of proof converts to a no-action failure,
          // never to an implicit confirmation bypass.
          if (tab.generation !== capturedGeneration || interactionIdentityUrl(tab.page.url()) !== capturedOrigin) {
            this.invalidateInteractionRefs(tab, capturedGeneration);
            throw new Error("BrowserClick not_started: the document or origin changed before controlled activation; take a fresh BrowserSnapshot.");
          }
          const revalidatedStructure = await operation.run(readTargetStructure(this.currentRefLocator(tab, ref), tab.page), "safe-target revalidation");
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

        if (operationName === "click" && decision.consequence === "ordinary_navigation") {
          await operation.run(assertControlledTopNavigation(locator, tab.page), "controlled browsing-context validation");
          if (tab.generation !== capturedGeneration) throw new Error("BrowserClick not_started: the document changed during frame validation.");
        }
        capture = newInteractionCapture();
        session.interactionCapture = capture;
        started = true;
        if (operationName === "hover") {
          await operation.run(locator.hover({ timeout: operation.remainingMs() }), "semantic hover dispatch");
        } else if (decision.consequence === "ordinary_navigation" && decision.destination) {
          // Do not dispatch page-controlled click listeners for a silent link.
          // Activate the freshly revalidated HTTP(S) destination through the
          // existing brokered navigation path instead.
          await this.navigateSession(session, tab, decision.destination, operation, false);

        } else {
          await operation.run(locator.click({ timeout: operation.remainingMs() }), "approved semantic click dispatch");
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
          confirmed: approval === "human",
          approval,
          effect: "completed",
          effects: {
            navigation: navigated ? "observed" : "not_observed",
            observedPopupTabs: capture.popupTabs.size,
            observedOverflowPopupsClosed: capture.overflowPopups,
            observedDialogsDismissed: capture.dialogs,
            download: capture.downloads > 0 ? "canceled" : "not_observed",
            network: capture.networkRequests > 0 ? "observed" : "not_observed",
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
    return this.operate(session, signal, async (operationSignal) => {
      const operation = new OperationDeadline("BrowserWait", timeoutMs, operationSignal);
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
    return this.operate(session, signal, async (operationSignal) => {
      const deadlineMs = operationName === "list" ? this.limits.actionMs : this.limits.navigationMs;
      const operation = new OperationDeadline("BrowserHistory", deadlineMs, operationSignal);
      let started = false;
      try {
        await operation.run(this.refreshHistory(session, tab), "browser history read");
        if (operationName !== "list") {
          const current = tab.history[tab.historyIndex];
          const target = operationName === "back" ? tab.history[tab.historyIndex - 1]
            : operationName === "forward" ? tab.history[tab.historyIndex + 1] : current;
          if (!current || !target || (operationName !== "reload" && Math.abs(target.index - current.index) !== 1)) {
            throw new Error(`BrowserHistory cannot go ${operationName}; no bounded session-local entry exists.`);
          }
          this.consumeNavigation(session);
          started = true;
          if (operationName === "reload") {
            await operation.run(tab.page.reload({ waitUntil: "domcontentloaded", timeout: operation.remainingMs() }), "history reload");
          } else {
            // Address the observed entry ID, not URL equality or Chromium's
            // user-activation-based back/forward skip heuristics.
            await operation.run(this.withHistoryProtocol(session, tab, async protocol => {
              await protocol.send("Page.navigateToHistoryEntry", { entryId: target.id });
            }), `history ${operationName}`);
          }
          await operation.run(this.waitForHistoryEntry(session, tab, target.id, operation), "history commit");
          await operation.run(tab.page.waitForLoadState("networkidle", {
            timeout: Math.min(2_000, operation.remainingMs()),
          }).catch(() => undefined), "history rendering settle");
          await operation.run(this.refreshHistory(session, tab), "settled browser history read");
          if (session.fatalError) throw session.fatalError;
        }
        const generation = tab.generation;
        const url = tab.page.url();
        const title = bounded(this.outputPrivacy.text(await operation.run(tab.page.title(), "browser title read")), 500);
        const current = tab.history[tab.historyIndex];
        if (tab.documentRequestPending || generation !== tab.generation || url !== tab.page.url()
          || current?.generation !== generation || current.url !== publicPageUrl(url)) {
          throw new Error("Browser document changed during history read; result rejected.");
        }
        return this.historyResult(session, tab, operationName, maxEntries, title);
      } catch (error) {
        if (started) await this.failAndWait(session, asError(error));
        throw error;
      } finally {
        operation.dispose();
      }
    });
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
    return this.operate(session, signal, async (operationSignal) => {
      const operation = new OperationDeadline("BrowserTabs", operationName === "open" ? this.limits.navigationMs : this.limits.actionMs, operationSignal);
      let openedTab: string | undefined;
      let closedTab: string | undefined;
      try {
        if (operationName === "list") {
          if (tabHandle !== undefined || url !== undefined) throw new Error("BrowserTabs list does not accept tab or url.");
        } else if (operationName === "open") {
          if (tabHandle !== undefined || !url) throw new Error("BrowserTabs open requires url and does not accept tab.");
          if (session.tabs.size >= this.limits.maxTabsPerSession) throw new Error(`Browser tab limit (${this.limits.maxTabsPerSession}) reached.`);
          const requested = await operation.run(validateNavigationUrl(url, this.resolveHostname), "URL validation");
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
          if (!tab) throw invalidTabHandleError(session);
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
    if (session) {
      const operations = [...this.activeOperations].filter((operation) => operation.session === session);
      // Publish explicit closure before abort observers can classify it as a
      // fatal action failure. Also retire pending permission/action deadlines.
      const teardown = this.beginTeardown(session);
      for (const operation of operations) operation.controller.abort(new Error(BROWSER_CLOSE_CANCEL_REASON));
      const result = await teardown;
      await Promise.all(operations.map((operation) => operation.settled));
      return result;
    }
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
    throw new BrowserRecoveryError(
      "Invalid or stale browser session handle for BrowserClose: it was not issued by this manager, or a different owner holds it; nothing was closed. Use BrowserOpen to start a browser for this Pi session, then close the session handle that result returns.",
      { kind: "session_unknown" },
    );
  }

  /**
   * Abort and drain every operation which could still acquire browser-owned
   * resources, then tear down and independently verify every known session.
   * Terminal cleanup only: never called at turn or review boundaries. Any
   * uncertain cleanup permanently closes this manager.
   */
  private drainForShutdown(): Promise<void> {
    if (this.quiescence) return this.quiescence;
    if (
      this.shutdownFailure
      && this.openings.size === 0
      && this.activeOperations.size === 0
      && this.sessions.size === 0
    ) return Promise.reject(this.shutdownFailure);
    this.quiescing = true;
    const barrier = (async () => {
      this.confirmationPermits.clear();
      const openings = [...this.openings];
      const operations = [...this.activeOperations];
      const reason = new Error(SESSION_SHUTDOWN_CANCEL_REASON);
      for (const opening of openings) opening.controller.abort(reason);
      for (const operation of operations) operation.controller.abort(reason);

      await Promise.all([
        ...openings.map((opening) => opening.settled),
        ...operations.map((operation) => operation.settled),
      ]);

      // An opening may have transferred ownership to a Session immediately
      // before observing cancellation. Snapshot only after all acquisitions
      // have drained, while quiescing still rejects new operations.
      const outcomes = await Promise.allSettled([...this.sessions.values()].map((session) =>
        this.beginTeardown(session, reason)
      ));
      const failures = new Set<Error>();
      if (this.shutdownFailure) failures.add(this.shutdownFailure);
      for (const failure of this.failedTombstones.values()) failures.add(failure);
      for (const opening of openings) if (opening.teardownFailure) failures.add(opening.teardownFailure);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") failures.add(asError(outcome.reason));
      }
      if (this.opening !== 0 || this.openings.size !== 0) failures.add(new Error("browser opening ownership remains"));
      if (this.activeOperations.size !== 0) failures.add(new Error("in-flight browser action ownership remains"));
      if (this.sessions.size !== 0) failures.add(new Error("browser session ownership remains"));
      if (failures.size > 0) {
        throw new AggregateError([...failures], "Interactive browser shutdown could not confirm quiescence.");
      }
    })().catch((error) => {
      const failure = asError(error);
      this.shutdownFailure ??= failure;
      this.shuttingDown = true;
      throw failure;
    }).finally(() => {
      if (!this.shutdownFailure) this.quiescing = false;
      if (this.quiescence === barrier) this.quiescence = undefined;
    });
    this.quiescence = barrier;
    return barrier;
  }

  async shutdown(): Promise<void> {
    const completion = this.drainForShutdown();
    this.shuttingDown = true;
    await completion;
  }

  activeSessionCount(): number {
    return this.sessions.size;
  }

  private async navigateSession(session: Session, tab: BrowserTab, rawUrl: string, operation: OperationDeadline, initial: boolean, onDispatch?: () => void): Promise<BrowserNavigateResult> {
    if (!initial) this.consumeNavigation(session);
    else session.navigations += 1;
    const requested = await operation.run(validateNavigationUrl(rawUrl, this.resolveHostname), "URL validation");
    let response: Response | null;
    try {
      // Invoking goto may dispatch the request; after this point cancellation
      // cannot claim "no page effects".
      const goto = tab.page.goto(requested.href, { waitUntil: "domcontentloaded", timeout: operation.remainingMs() });
      onDispatch?.();
      response = await operation.run(goto, "main-document navigation");
    } catch (error) {
      throw session.fatalError ?? asError(error);
    }
    // A successful same-document goto has no response; retain document status.
    tab.documentStatus ??= response?.status();
    await operation.run(
      tab.page.waitForLoadState("networkidle", { timeout: Math.min(2_000, operation.remainingMs()) }).catch(() => undefined),
      "browser rendering settle",
    );
    if (session.fatalError) throw session.fatalError;
    await operation.run(this.refreshHistory(session, tab), "browser history read");
    const generation = tab.generation;
    const finalUrl = publicPageUrl(tab.page.url());
    const title = bounded(this.outputPrivacy.text(await operation.run(tab.page.title(), "browser title read")), 500);
    if (tab.documentRequestPending || generation !== tab.generation || finalUrl !== publicPageUrl(tab.page.url())) {
      throw new Error("Browser document changed during navigation metadata read; result rejected.");
    }
    if (tab.documentStatus === undefined) throw new Error("Browser navigation has no committed HTTP document status.");
    return {
      session: session.handle,
      tab: tab.handle,
      generation: tab.generation,
      url: finalUrl,
      title,
      status: tab.documentStatus,
      navigationsRemaining: Math.max(0, this.limits.maxNavigations - session.navigations),
    };
  }

  /**
   * Install every per-tab guard. Returns the WebSocket route registration
   * promise so the caller can await it before dispatching page work; until it
   * resolves, this tab's WebSockets fall through to the context backstop
   * (fail closed), never to an unvalidated direct connection.
   */
  private installPageGuards(session: Session, tab: BrowserTab): Promise<void> {
    tab.page.on("request", (request: Request) => {
      this.recordNetworkRequest(session, tab, request);
      if (session.interactionCapture) {
        session.interactionCapture.networkRequests += 1;
        session.interactionCapture.events += 1;
      }
      if (!request.isNavigationRequest() || request.frame() !== tab.page.mainFrame()) return;
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
    tab.page.on("response", (response: Response) => {
      this.recordNetworkResponse(session, tab, response);
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === tab.page.mainFrame()) {
        tab.documentStatus = response.status();
      }
    });
    tab.page.on("requestfailed", (request: Request) => this.recordNetworkFailure(session, tab, request));
    tab.page.on("console", (message: ConsoleMessage) => this.recordConsoleMessage(session, tab, message));
    tab.page.on("pageerror", (error: Error) => this.recordPageError(session, tab, error));
    tab.page.on("framenavigated", (frame) => {
      if (frame !== tab.page.mainFrame()) {
        // Snapshot refs can belong to child documents too.
        tab.generation = this.uniqueHandle("generation");
        tab.semanticRefs.clear();
        return;
      }
      if (session.interactionCapture) session.interactionCapture.events += 1;
      if (!tab.documentRequestPending) {
        // A generation is a capability epoch, not a guess at history identity.
        // Conservatively stale refs on SPA commits, including identical URLs.
        tab.generation = this.uniqueHandle("generation");
        tab.semanticRefs.clear();
      }
      tab.documentRequestPending = false;
      // History identity is read from Chromium, not inferred from this event:
      // pushState, replaceState and same-URL traversal all emit it.
    });
    // Live ws/wss admission: every WebSocket this tab creates is validated
    // against the public-URL policy before Chromium's native stack connects
    // through the session's authenticated broker proxy (the context proxy
    // credentials carry the auth; no manager-side protocol code exists).
    // The page-scoped route wins over the context backstop for this tab.
    const webSocketRoute = tab.page.routeWebSocket("**/*", (route) => {
      return this.handleLiveWebSocket(session, tab, route).catch(() => undefined);
    });
    tab.page.on("dialog", (dialog) => this.dismissDialog(session, dialog));
    tab.page.on("download", (download) => this.cancelDownload(session, download));
    tab.page.on("crash", () => this.failSession(session, new Error("Browser tab crashed; teardown started.")));
    tab.page.on("close", () => {
      this.clearTabDiagnostics(tab);
      session.tabs.delete(tab.handle);
      if (session.teardown || tab.closing) return;
      if (session.tabs.size === 0) {
        this.failSession(session, new Error("Last browser tab closed unexpectedly; teardown started."));
        return;
      }
      if (session.activeTab === tab.handle) session.activeTab = session.tabs.keys().next().value!;
    });
    return webSocketRoute;
  }

  private recordConsoleMessage(session: Session, tab: BrowserTab, message: ConsoleMessage): void {
    if (!tab.diagnosticsActive || session.teardown) return;
    let rawText = "[console message unavailable]";
    let rawType = "other";
    let location: { url?: string; lineNumber?: number; columnNumber?: number } = {};
    try { rawText = message.text(); } catch { /* fixed fallback */ }
    try { rawType = message.type(); } catch { /* fixed fallback */ }
    try { location = message.location(); } catch { /* fixed fallback */ }
    const text = boundedUntrustedText(this.outputPrivacy.text(rawText), this.limits.maxConsoleTextChars);
    tab.consoleDiagnostics.push({
      elapsedMs: diagnosticElapsed(this.now(), session.createdAt),
      kind: "console",
      level: consoleLevel(rawType),
      text: text.value,
      textTruncated: text.truncated,
      source: location.url ? {
        origin: diagnosticOrigin(location.url, this.limits.maxConsoleSourceChars),
        line: boundedNonnegativeInteger(location.lineNumber),
        column: boundedNonnegativeInteger(location.columnNumber),
      } : null,
    });
  }

  private recordPageError(session: Session, tab: BrowserTab, error: Error): void {
    if (!tab.diagnosticsActive || session.teardown) return;
    const text = boundedUntrustedText(this.outputPrivacy.text(error?.message || "Uncaught page error"), this.limits.maxConsoleTextChars);
    const errorName = boundedUntrustedText(this.outputPrivacy.text(error?.name || "Error"), 64);
    tab.consoleDiagnostics.push({
      elapsedMs: diagnosticElapsed(this.now(), session.createdAt),
      kind: "page_error",
      level: "error",
      text: text.value,
      textTruncated: text.truncated || errorName.truncated,
      source: null,
      errorName: errorName.value,
    });
  }

  private recordNetworkRequest(session: Session, tab: BrowserTab, request: Request): void {
    if (!tab.diagnosticsActive || session.teardown) return;
    const elapsedMs = diagnosticElapsed(this.now(), session.createdAt);
    tab.networkStartedAt.set(request, elapsedMs);
    tab.networkDiagnostics.push({
      elapsedMs,
      phase: "request",
      method: diagnosticMethod(safely(() => request.method(), "OTHER")),
      origin: diagnosticOrigin(safely(() => request.url(), ""), 300),
      resourceKind: diagnosticResourceKind(safely(() => request.resourceType(), "other")),
      outcome: "observed",
    });
  }

  private recordNetworkResponse(session: Session, tab: BrowserTab, response: Response): void {
    if (!tab.diagnosticsActive || session.teardown) return;
    const request = response.request();
    const elapsedMs = diagnosticElapsed(this.now(), session.createdAt);
    const started = tab.networkStartedAt.get(request);
    tab.networkDiagnostics.push({
      elapsedMs,
      phase: "response",
      method: diagnosticMethod(safely(() => request.method(), "OTHER")),
      origin: diagnosticOrigin(safely(() => request.url(), ""), 300),
      resourceKind: diagnosticResourceKind(safely(() => request.resourceType(), "other")),
      status: boundedHttpStatus(safely(() => response.status(), 0)),
      ...(started === undefined ? {} : { durationMs: Math.max(0, elapsedMs - started) }),
      outcome: "succeeded",
    });
  }

  private recordNetworkFailure(session: Session, tab: BrowserTab, request: Request): void {
    if (!tab.diagnosticsActive || session.teardown) return;
    const elapsedMs = diagnosticElapsed(this.now(), session.createdAt);
    const started = tab.networkStartedAt.get(request);
    const policy = tab.networkPolicy.get(request);
    const rawFailure = safely(() => request.failure()?.errorText, "request failed") ?? "request failed";
    const failure = policy ?? diagnosticNetworkFailure(rawFailure);
    tab.networkDiagnostics.push({
      elapsedMs,
      phase: "failure",
      method: diagnosticMethod(safely(() => request.method(), "OTHER")),
      origin: diagnosticOrigin(safely(() => request.url(), ""), 300),
      resourceKind: diagnosticResourceKind(safely(() => request.resourceType(), "other")),
      ...(started === undefined ? {} : { durationMs: Math.max(0, elapsedMs - started) }),
      outcome: policy ? "policy_blocked" : "failed",
      failure,
    });
  }

  private recordNetworkPolicy(session: Session, request: Request, reason: string): void {
    const tab = safely(() => this.tabForPage(session, request.frame().page()), undefined);
    if (!tab || !tab.diagnosticsActive || session.teardown) return;
    tab.networkPolicy.set(request, reason);
    const elapsedMs = diagnosticElapsed(this.now(), session.createdAt);
    tab.networkDiagnostics.push({
      elapsedMs,
      phase: "policy",
      method: diagnosticMethod(safely(() => request.method(), "OTHER")),
      origin: diagnosticOrigin(safely(() => request.url(), ""), 300),
      resourceKind: diagnosticResourceKind(safely(() => request.resourceType(), "other")),
      outcome: "policy_blocked",
      failure: boundedUntrustedText(reason, 160).value,
    });
  }

  private clearTabDiagnostics(tab: BrowserTab): void {
    tab.diagnosticsActive = false;
    tab.consoleDiagnostics.clear();
    tab.networkDiagnostics.clear();
    tab.networkStartedAt = new WeakMap();
    tab.networkPolicy = new WeakMap();
  }

  /** Bounded per-tab WebSocket lifecycle metadata; never frame content. */
  private recordWebSocketEvent(
    session: Session,
    tab: BrowserTab,
    event: Omit<BrowserNetworkEvent, "sequence" | "elapsedMs">,
  ): void {
    if (!tab.diagnosticsActive || session.teardown) return;
    tab.networkDiagnostics.push({
      elapsedMs: diagnosticElapsed(this.now(), session.createdAt),
      ...event,
    });
  }

  /**
   * One page-created WebSocket. The manager's role is admission and metadata,
   * never protocol: validate the requested ws/wss destination against the
   * same public-URL policy as ordinary navigation, then hand the socket to
   * Chromium's native stack via connectToServer(). Frames relay transparently
   * between page and origin (Playwright passthrough) and never enter manager
   * memory. The terminal state is observed from the browser's own close
   * event; no connected state is ever claimed, and a working connection is
   * proven by page/app state, not by this metadata.
   */
  private async handleLiveWebSocket(session: Session, tab: BrowserTab, route: WebSocketRoute): Promise<void> {
    const createdAtMs = this.now();
    let rawUrl = "";
    try { rawUrl = route.url(); } catch { /* fixed fallback */ }
    const origin = diagnosticWsOrigin(rawUrl);
    this.recordWebSocketEvent(session, tab, {
      phase: "request",
      method: "GET",
      origin,
      resourceKind: "websocket",
      wsState: "created",
      outcome: "observed",
    });
    let requestedProtocols: readonly string[] = [];
    try { requestedProtocols = route.protocols(); } catch { /* fixed fallback */ }
    const decision = validateLiveWebSocket(rawUrl, requestedProtocols);
    if (!decision.allowed) {
      await this.refuseLiveWebSocket(session, tab, route, origin, createdAtMs, decision.reason, true);
      return;
    }
    // Bounded admission: excess concurrent requests are refused before any
    // DNS resolution, and every in-flight validation is tracked so teardown
    // can settle it. No unbounded validator fan-out survives the session.
    if (session.pendingWebSocketAdmissions.size >= WS_MAX_PENDING_ADMISSIONS) {
      await this.refuseLiveWebSocket(session, tab, route, origin, createdAtMs, "websocket admission limit exceeded", true);
      return;
    }
    let admission!: Promise<void>;
    admission = (async () => {
      const verdict = await this.validateWebSocketDestination(decision.url, session.admissionAbort.signal);
      // Teardown or tab closure during validation: contain without connecting.
      if (session.teardown || tab.closing) return;
      if (verdict === "refused") {
        await this.refuseLiveWebSocket(session, tab, route, origin, createdAtMs, "websocket destination failed public validation", true);
        return;
      }
      if (verdict === "timed_out") {
        await this.refuseLiveWebSocket(session, tab, route, origin, createdAtMs, "websocket admission timed out", false);
        return;
      }
      let server: WebSocketRoute;
      try {
        // Rechecked immediately before the native connect: a session that
        // began tearing down during validation never reaches this point.
        if (session.teardown || tab.closing) return;
        // Native browser networking from here on: the in-page socket connects
        // through the context proxy (authenticated) to the broker-pinned origin.
        server = route.connectToServer();
      } catch {
        if (!session.teardown && !tab.closing) {
          await this.refuseLiveWebSocket(session, tab, route, origin, createdAtMs, "browser websocket connect failed", false);
        }
        return;
      }
      let terminalRecorded = false;
      server.onClose((code, reason) => {
        if (terminalRecorded) return;
        terminalRecorded = true;
        const closeCode = boundedWsCloseCode(code);
        // Without a clean/abnormal flag from the API, only codes that attest
        // normal closure are recorded as success; everything else is failure.
        const normal = closeCode === 1000 || (closeCode !== undefined && closeCode >= 3000 && closeCode <= 4999);
        this.recordWebSocketEvent(session, tab, {
          phase: normal ? "response" : "failure",
          method: "GET",
          origin,
          resourceKind: "websocket",
          wsState: "closed",
          ...(closeCode === undefined ? {} : { closeCode }),
          durationMs: diagnosticElapsed(this.now(), createdAtMs),
          outcome: normal ? "succeeded" : "failed",
          ...(normal ? {} : { failure: "ws_closed_abnormal" }),
        });
        // Relay the terminal to the page side exactly as passthrough would.
        void route.close({ code: closeCode, reason: boundedWsCloseReason(reason) }).catch(() => undefined);
      });
    })().finally(() => { session.pendingWebSocketAdmissions.delete(admission); });
    session.pendingWebSocketAdmissions.add(admission);
    // Playwright synthesizes an open event when a route handler completes
    // without connecting. Keep it pending until admission connects or closes
    // the route; otherwise DNS-pending sockets would falsely appear open.
    await admission;
  }

  /** Manager-issued refusal: bounded record + truthful page-side close. */
  private async refuseLiveWebSocket(
    session: Session,
    tab: BrowserTab,
    route: WebSocketRoute,
    origin: string,
    createdAtMs: number,
    token: string,
    policy: boolean,
  ): Promise<void> {
    // 1008 = policy violation, 1006 = abnormal failure; the page observes
    // exactly the code issued here.
    const closeCode = policy ? 1008 : 1006;
    this.recordWebSocketEvent(session, tab, {
      phase: policy ? "policy" : "failure",
      method: "GET",
      origin,
      resourceKind: "websocket",
      wsState: "closed",
      closeCode,
      durationMs: diagnosticElapsed(this.now(), createdAtMs),
      outcome: policy ? "policy_blocked" : "failed",
      failure: token,
    });
    await route.close({ code: closeCode }).catch(() => undefined);
  }

  /**
   * Map the ws/wss authority onto the existing http/https public validator:
   * the hostname is resolved exactly once and every address must be public.
   * Bounded by a hard deadline and cancelable by session teardown, so no
   * admission can wait unboundedly or act after the session is gone.
   */
  private async validateWebSocketDestination(
    url: URL,
    signal: AbortSignal,
  ): Promise<"public" | "refused" | "timed_out"> {
    const mapped = new URL(`${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}/`);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        validatePublicUrl(mapped.href, this.resolveHostname).then(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { timedOut = true; reject(new Error("websocket admission deadline")); }, WS_ADMISSION_MS);
        }),
        new Promise<never>((_resolve, reject) => {
          if (signal.aborted) { reject(new Error("session teardown")); return; }
          onAbort = () => reject(new Error("session teardown"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
      return "public";
    } catch {
      return timedOut ? "timed_out" : "refused";
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private async operate<T>(
    session: Session,
    signal: AbortSignal | undefined,
    body: (operationSignal: AbortSignal) => Promise<T>,
    fatalOnError = false,
  ): Promise<T> {
    this.assertAcceptingOperations();
    this.assertUsable(session);
    if (session.operationActive) throw new Error("Browser session is busy with another bounded operation.");
    if (session.actions >= this.limits.maxActions) {
      const error = new Error(`Browser action limit (${this.limits.maxActions}) exhausted.`);
      await this.failAndWait(session, error);
      throw error;
    }
    session.actions += 1;
    session.operationActive = true;
    const controller = new AbortController();
    let settleOperation!: () => void;
    const active: ActiveBrowserOperation = {
      session,
      controller,
      settled: new Promise<void>((resolve) => { settleOperation = resolve; }),
      settle: () => settleOperation(),
    };
    this.activeOperations.add(active);
    const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let bodyStarted = false;
    const pending = new Set<Promise<unknown>>();
    try {
      throwIfAborted(operationSignal);
      const result = await operationWork.run(pending, () => {
        bodyStarted = true;
        return body(operationSignal);
      });
      if (pending.size > 0) throw new Error("Browser operation left work in flight.");
      if (session.fatalError) throw session.fatalError;
      return this.protectOutput(result);
    } catch (error) {
      const failure = asError(error);
      if (pending.size > 0) {
        // A deadline race is not cancellation. Keep serialization held until
        // browser/broker containment and pending command settlement complete.
        const deadline = failure.message.match(/\bBrowser[A-Za-z]+ exceeded its \d{1,8}ms total deadline\./)?.[0];
        const uncertain = new Error(`${deadline ? `${deadline} ` : ""}Browser operation left work in flight; effect status is unknown and no rollback is claimed.`);
        let teardownConfirmed = false;
        try {
          await this.failAndWait(session, uncertain);
          await boundedCleanup(Promise.allSettled([...pending]), this.limits.cleanupMs, "pending browser operation drain");
          teardownConfirmed = true;
        } catch {
          // Teardown or the bounded in-flight drain could not be confirmed.
        }
        if (!teardownConfirmed) throw new Error(`${uncertain.message} Session teardown is unconfirmed.`);
        const cancellation = cancellationKind(operationSignal);
        // In-flight work at abort time proves the command dispatched: report
        // structured post-dispatch cancellation, never parsed exception text.
        if (cancellation) throw operationCancellationError(cancellation, "dispatched");
        throw new Error(`${uncertain.message} Session teardown is confirmed.`);
      }
      if ((fatalOnError && !(failure instanceof BrowserValidationError)) || operationSignal.aborted || session.fatalError) {
        try {
          await this.failAndWait(session, session.fatalError ?? failure);
        } catch {
          throw operationTeardownUncertainError();
        }
        const cancellation = cancellationKind(operationSignal);
        if (cancellation) throw operationCancellationError(cancellation, bodyStarted ? "unknown" : "not_started");
      }
      throw failure;
    } finally {
      session.operationActive = false;
      this.activeOperations.delete(active);
      active.settle();
    }
  }

  private assertAcceptingOperations(): void {
    if (this.shutdownFailure) throw this.shutdownFailure;
    if (this.shuttingDown) throw new Error("Interactive browser manager is shut down.");
    if (this.quiescing) throw new Error("Interactive browser manager is closing for Pi session shutdown.");
  }

  private assertUsable(session: Session): void {
    if (session.fatalError) throw session.fatalError;
    if (session.teardown) throw new Error("Browser session teardown is in progress.");
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

  private beginTeardown(session: Session, cause?: Error): Promise<BrowserCloseResult> {
    if (session.teardown) return session.teardown;
    const closure: BrowserClosureReason = session.fatalError
      ? { kind: "fatal_error", message: bounded(session.fatalError.message, 500) }
      : cause
        ? { kind: "session_shutdown", message: "Pi session shutdown, replacement, or reload." }
        : { kind: "explicit_close", message: "BrowserClose was called." };
    for (const tab of session.tabs.values()) this.clearTabDiagnostics(tab);
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
    // Pending WebSocket admissions stop waiting immediately on teardown and
    // can never reach connectToServer after this point.
    session.admissionAbort.abort();
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
          closure,
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

  private async failUncertainTabClosure(session: Session, message: string, cause: Error): Promise<never> {
    const failure = new Error(`${message}; session teardown started.`, { cause });
    await this.failAndWait(session, failure);
    throw failure;
  }

  private requireOwnedSession(sessionHandle: string): Session {
    const session = this.sessions.get(sessionHandle);
    if (session) return session;
    const failed = this.failedTombstones.get(sessionHandle);
    if (failed) throw failed;
    if (this.authenticatesSessionHandle(sessionHandle)) {
      throw new BrowserSessionClosedError(this.closedTombstones.get(sessionHandle)?.closure);
    }
    throw invalidSessionHandleError();
  }

  private requireTab(sessionHandle: string, tabHandle: string): { session: Session; tab: BrowserTab } {
    const session = this.requireOwnedSession(sessionHandle);
    const tab = session.tabs.get(tabHandle);
    // Forged/cross-session tab handles stay indistinguishable. Authenticated
    // closed session handles above can safely receive actionable diagnostics.
    if (!tab) throw invalidTabHandleError(session);
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
      valueDigest: null,
      valueLengths: [],
      key: null,
    };
  }

  private formConfirmationBinding(
    session: Session,
    tab: BrowserTab,
    ref: string,
    origin: string,
    structure: BrowserTargetStructure,
    consequence: BrowserConsequence,
    destination: string | null,
    operation: BrowserFormOperation,
    valueDigest: string | null,
    valueLengths: readonly number[],
    key: string | null,
  ): BrowserConfirmationBinding {
    return {
      session: session.handle,
      tab: tab.handle,
      generation: tab.generation,
      operation,
      ref,
      origin,
      destination,
      targetFingerprint: this.consequencePolicy.fingerprint(structure),
      consequence,
      valueDigest,
      valueLengths,
      key,
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

  private async withHistoryProtocol<T>(session: Session, tab: BrowserTab, read: (protocol: CDPSession) => Promise<T>): Promise<T> {
    // Fixed internal commands only; no caller-supplied CDP or page-world hooks.
    const protocol = await session.context.newCDPSession(tab.page);
    try { return await read(protocol); }
    finally { await protocol.detach(); }
  }

  private async refreshHistory(session: Session, tab: BrowserTab): Promise<void> {
    const observed = await this.withHistoryProtocol(session, tab, protocol => protocol.send("Page.getNavigationHistory"));
    const previous = new Map(tab.history.map(entry => [entry.id, entry]));
    const publicEntries = observed.entries.flatMap((entry, index) => {
      try {
        return [{ id: entry.id, index, url: publicPageUrl(entry.url),
          generation: index === observed.currentIndex ? tab.generation
            : previous.get(entry.id)?.generation ?? this.uniqueHandle("generation") }];
      } catch { return []; }
    });
    const current = publicEntries.findIndex(entry => entry.index === observed.currentIndex);
    // Keep a bounded window containing the current entry and both neighbors
    // when capacity permits, including after page-initiated traversal.
    const start = Math.max(0, Math.min(current - Math.floor(this.limits.maxHistoryEntries / 2), publicEntries.length - this.limits.maxHistoryEntries));
    tab.history = publicEntries.slice(start, start + this.limits.maxHistoryEntries);
    tab.historyIndex = current < 0 ? -1 : current - start;
    tab.historyOmitted = publicEntries.length - tab.history.length;
  }

  private async waitForHistoryEntry(session: Session, tab: BrowserTab, id: number, operation: OperationDeadline): Promise<void> {
    do {
      await this.refreshHistory(session, tab);
      if (tab.history[tab.historyIndex]?.id === id) return;
      await operation.run(tab.page.waitForTimeout(10), "history entry wait");
    } while (operation.remainingMs() > 0);
    throw new Error("BrowserHistory did not commit the requested entry.");
  }

  private historyResult(
    session: Session,
    tab: BrowserTab,
    operation: BrowserHistoryOperation,
    maxEntries: number,
    title: string,
  ): BrowserHistoryResult {
    const start = Math.max(0, Math.min(tab.historyIndex - Math.floor(maxEntries / 2), tab.history.length - maxEntries));
    const entries = tab.history.slice(start, start + maxEntries);
    const omittedEntries = (tab.historyOmitted ?? 0) + tab.history.length - entries.length;
    return {
      session: session.handle,
      tab: tab.handle,
      generation: tab.generation,
      operation,
      url: publicPageUrl(tab.page.url()),
      title,
      entries: entries.map((entry, offset) => ({
        index: entry.index,
        url: entry.url,
        generation: entry.generation,
        current: start + offset === tab.historyIndex,
      })),
      truncated: omittedEntries > 0,
      omittedEntries,
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
      documentRequestPending: false,
      closing: false,
      diagnosticsActive: true,
      consoleDiagnostics: new DiagnosticRing(this.limits.maxConsoleEvents),
      networkDiagnostics: new DiagnosticRing(this.limits.maxNetworkEvents),
      networkStartedAt: new WeakMap(),
      networkPolicy: new WeakMap(),
    };
    session.tabs.set(tab.handle, tab);
    // The context backstop covers the registration gap; containment only.
    void this.installPageGuards(session, tab).catch(() => undefined);
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
    this.shutdownFailure ??= new Error(
      `Interactive browser shutdown could not confirm quiescence: ${failure.message}`,
      { cause: failure },
    );
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
    // Ownership is now uncertain. Reject new work immediately, but leave
    // shutdownFailure unset so shutdown can still drain every other owner
    // before publishing the permanent aggregate failure.
    this.shuttingDown = true;
  }

  private brokerBudgets(): EgressBudgets {
    return {
      maxDistinctHosts: this.limits.maxDistinctHosts,
      maxConnections: this.limits.maxConnections,
      maxClientConnections: 64,
      preAuthSocketMs: 5_000,
      maxRequests: this.limits.maxRequests,
      // The Pi session owns browser lifetime; action deadlines remain finite.
      maxTotalMs: null,
      maxCleanupMs: this.limits.cleanupMs,
      maxConnectionBytes: this.limits.maxConnectionBytes,
      maxTotalBytes: this.limits.maxTotalBytes,
      maxAuthorityChars: 2_048,
      maxHeaderChars: 32_768,
      maxDiagnostics: 32,
      idleSocketMs: this.limits.idleSocketMs,
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

async function installRoutePolicy(
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
        settleBrowserReads(batch).then(() => undefined),
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

// Async-local tracking keeps concurrent, separately owned sessions isolated.
const operationWork = new AsyncLocalStorage<Set<Promise<unknown>>>();

/** Do not let a rejected child hide still-running sibling browser commands
 * from OperationDeadline's composite-promise tracking. The outer deadline can
 * still contain the browser and drain this group if a sibling never settles.
 */
async function settleBrowserReads<const T extends readonly unknown[]>(operations: T): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const results = await Promise.allSettled(operations);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as { -readonly [P in keyof T]: Awaited<T[P]> };
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

  run<T>(operation: Promise<T>, phase: string): Promise<T> {
    // An expired approval prompt cannot dispatch: its permit is revoked by
    // the caller. It is not an in-flight browser command to drain.
    const pending = phase === "interactive confirmation" ? undefined : operationWork.getStore();
    pending?.add(operation);
    // Attach before checking the deadline: arguments are evaluated before run,
    // so a command may already have started even when remainingMs throws.
    void operation.then(() => pending?.delete(operation), () => pending?.delete(operation));
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

type IsolatedFormFacts = Pick<BrowserTargetStructure, "formAssociated" | "formAction" | "formMethod" | "autocomplete">;

async function readIsolatedFormFacts(locator: Locator): Promise<IsolatedFormFacts> {
  // Match the owning document through the selector engine, not elementHandle:
  // handle creation can generate a preview in the hostile main world. This
  // internal bridge is required; unsupported Playwright runtimes fail closed.
  const internal = locator as unknown as {
    _selector?: string;
    _frame?: { _connection?: { toImpl?: (frame: unknown) => {
      selectors?: { callOnSelector?: (
        selector: string,
        options: { strict: boolean; mainWorld: boolean },
        callback: (args: { elements: Element[] }) => IsolatedFormFacts,
        arg: Record<string, never>,
      ) => Promise<{ result: IsolatedFormFacts } | null> };
    } } };
  };
  const frame = internal._frame;
  const selectors = frame?._connection?.toImpl?.(frame)?.selectors;
  if (!selectors?.callOnSelector || !internal._selector || !/^aria-ref=(?:f\d+)?e\d+$/.test(internal._selector)) {
    throw new BrowserValidationError("Browser interaction owning-form facts require the isolated selector engine.");
  }
  const resolved = await selectors.callOnSelector(internal._selector, { strict: true, mainWorld: false }, ({ elements }) => {
    const element = elements[0];
    if (!element || elements.length !== 1) throw new Error("Form target unavailable.");
    const control = element as HTMLInputElement | HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement;
    const form = control.form;
    const autocomplete = Element.prototype.getAttribute.call(control, "autocomplete")
      ?? (form ? Element.prototype.getAttribute.call(form, "autocomplete") : null);
    if (!form) return { formAssociated: false, formAction: null, formMethod: null, autocomplete };
    // Native prototype getters also bypass DOM named-property shadowing, e.g.
    // an input named "action" or "method" on the owning form.
    const formAction = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "action")!.get!.call(form) as string;
    const formMethod = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, "method")!.get!.call(form) as string;
    const submitterPrototype = control instanceof HTMLInputElement ? HTMLInputElement.prototype
      : control instanceof HTMLButtonElement ? HTMLButtonElement.prototype : null;
    return {
      formAssociated: true,
      formAction: submitterPrototype && control.hasAttribute("formaction")
        ? Object.getOwnPropertyDescriptor(submitterPrototype, "formAction")!.get!.call(control) as string : formAction,
      formMethod: submitterPrototype && control.hasAttribute("formmethod")
        ? Object.getOwnPropertyDescriptor(submitterPrototype, "formMethod")!.get!.call(control) as string : formMethod,
      autocomplete,
    };
  }, {});
  if (!resolved?.result || typeof resolved.result.formAssociated !== "boolean") {
    throw new BrowserValidationError("Browser interaction owning-form facts were unavailable.");
  }
  return resolved.result;
}

async function readTargetStructure(locator: Locator, page: Page): Promise<BrowserTargetStructure> {
  // Only public Playwright utility-world reads. Even apparently innocuous
  // locator.evaluate getters execute hostile main-world code before approval.
  const names = ["type", "role", "href", "target", "download", "form",
    "aria-haspopup", "autocomplete", "readonly", "multiple", "id", "name"];
  const attributes = await settleBrowserReads(names.map(name => locator.getAttribute(name)));
  const attr = (name: string) => attributes[names.indexOf(name)] ?? null;
  const token = (name: string) => attr(name)?.trim().toLocaleLowerCase("en-US") ?? null;
  const matches = async (selector: string) => await locator.and(page.locator(selector)).count() === 1;
  const tagName = await identifySemanticTag(locator, page);
  const inputType = tagName === "input" || tagName === "button"
    ? token("type") || (tagName === "button" ? "submit" : "text") : null;
  if (inputType === "password" || inputType === "file") {
    throw new Error("Password and file controls are not supported by bounded browser form actions.");
  }
  const form = ["input", "button", "select", "textarea"].includes(tagName)
    ? await readIsolatedFormFacts(locator)
    : { formAssociated: false, formAction: null, formMethod: null, autocomplete: token("autocomplete") };
  // Preserve native relative/fragment semantics without entering the page realm.
  // The owning document's isolated base read accounts for CSP and inherited bases.
  const rawHref = attr("href");
  const href = (tagName === "a" || tagName === "area") && rawHref !== null
    ? new URL(rawHref, await ownerDocumentBaseUrl(locator)).href : null;
  const structure: BrowserTargetStructure = {
    tagName, inputType, role: token("role"), href, target: token("target"),
    download: attr("download") !== null,
    formAssociated: form.formAssociated,
    formAction: form.formAction, formMethod: form.formMethod,
    ariaHasPopup: token("aria-haspopup"),
    contentEditable: await matches('[contenteditable]:not([contenteditable="false"]), [contenteditable]:not([contenteditable="false"]) *'),
    disabled: await locator.isDisabled(),
    inlineEventHandler: await matches("[onclick], [onmousedown], [onmouseup], [onpointerdown], [onpointerup]"),
    summaryForDetails: tagName === "summary" && await matches("details > summary"),
    autocomplete: form.autocomplete?.trim().toLocaleLowerCase("en-US") ?? null, readOnly: attr("readonly") !== null,
    multiple: attr("multiple") !== null,
    // Absence of direct/delegated handlers is not provable. Form events always
    // route through the existing authorization/permit/revalidation branch.
    explicitChangeHandler: false, explicitSubmitHandler: false, pageControlledEventsAbsent: false,
    domPath: createHash("sha256").update(JSON.stringify([tagName, attr("id"), attr("name"), attr("form"), attr("href")])).digest("hex"),
  };
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
    && (target.autocomplete === undefined || typeof target.autocomplete === "string" || target.autocomplete === null)
    && (target.readOnly === undefined || typeof target.readOnly === "boolean")
    && (target.multiple === undefined || typeof target.multiple === "boolean")
    && (target.explicitChangeHandler === undefined || typeof target.explicitChangeHandler === "boolean")
    && (target.explicitSubmitHandler === undefined || typeof target.explicitSubmitHandler === "boolean")
    && (target.pageControlledEventsAbsent === undefined || typeof target.pageControlledEventsAbsent === "boolean")
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
    && (target.autocomplete === undefined || target.autocomplete === null || target.autocomplete.length <= 128)
    && target.domPath.length <= 512;
}

function confirmationPrompt(
  consequence: BrowserConsequence,
  origin: string,
  destination: string | null,
): BrowserInteractionConfirmationRequest {
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

function formConfirmationPrompt(
  operation: BrowserFormOperation,
  consequence: BrowserConsequence,
  origin: string,
  destination: string | null,
): BrowserInteractionConfirmationRequest {
  return {
    title: `Confirm consequential browser ${operation}`,
    message: [
      `The exact ${operation} action is classified as ${consequence.replaceAll("_", " ")}.`,
      `Current site: ${redactedInteractionUrl(origin)}.`,
      ...(destination ? [`Destination site: ${redactedInteractionUrl(destination)}.`] : []),
      "The entered or selected content is intentionally hidden.",
      `Approve this one exact ${operation}? The page can have external effects; cancellation does not imply rollback.`,
    ].join(" "),
  };
}

function newInteractionCapture(): InteractionCapture {
  return {
    dialogs: 0,
    downloads: 0,
    popupTabs: new Set(),
    overflowPopups: 0,
    networkRequests: 0,
    events: 0,
    settlements: [],
  };
}

function interactionResult(
  session: Session,
  tab: BrowserTab,
  operation: BrowserFormOperation,
  consequence: BrowserConsequence,
  approval: BrowserInteractionResult["approval"],
  capture: InteractionCapture,
  accounting: "bounded_stable" | "bounded_uncertain",
  navigated: boolean,
): BrowserInteractionResult {
  return {
    session: session.handle,
    tab: tab.handle,
    generation: tab.generation,
    operation,
    consequence,
    confirmed: approval === "human",
    approval,
    effect: "completed",
    effects: {
      navigation: navigated ? "observed" : "not_observed",
      observedPopupTabs: capture.popupTabs.size,
      observedOverflowPopupsClosed: capture.overflowPopups,
      observedDialogsDismissed: capture.dialogs,
      download: capture.downloads > 0 ? "canceled" : "not_observed",
      network: capture.networkRequests > 0 ? "observed" : "not_observed",
      accounting,
    },
    url: redactedInteractionUrl(tab.page.url()),
  };
}

function assertSuitableFormTarget(target: BrowserTargetStructure, operation: BrowserFormOperation): void {
  if (target.inputType === "password" || target.inputType === "file") {
    throw new Error("Password and file controls are not supported by bounded browser form actions.");
  }
  if (target.disabled || target.readOnly) throw new Error("The browser form target is not editable.");
  const role = target.role;
  const textInput = target.tagName === "input"
    && ["text", "search", "email", "url", "tel", "number"].includes(target.inputType ?? "")
    && (role === null || role === "textbox" || role === "searchbox");
  const textTarget = textInput
    || (target.tagName === "textarea" && (role === null || role === "textbox"))
    || (target.contentEditable && (role === null || role === "textbox"));
  if (operation === "fill" && !textTarget) {
    throw new Error("The semantic target is not a supported editable text control.");
  }
  const sequentialTextInput = textInput
    && ["text", "search", "url", "tel"].includes(target.inputType ?? "");
  const sequentialTextTarget = sequentialTextInput
    || (target.tagName === "textarea" && (role === null || role === "textbox"))
    || (target.contentEditable && (role === null || role === "textbox"));
  if (operation === "type" && !sequentialTextTarget) {
    throw new Error("The semantic target cannot safely establish bounded append positioning.");
  }
  const selectTarget = target.tagName === "select"
    && (role === null || role === "listbox" || role === "combobox");
  if (operation === "select" && !selectTarget) {
    throw new Error("The semantic target is not a supported native select control.");
  }
  const pressTarget = textTarget
    || selectTarget
    || (target.tagName === "button" && (role === null || role === "button"))
    || (target.tagName === "a" && target.href !== null && (role === null || role === "link" || role === "button"))
    || (target.summaryForDetails && (role === null || role === "button"));
  if (operation === "press" && !pressTarget) {
    throw new Error("The semantic target does not support bounded key interaction.");
  }
}

async function positionAppendCaret(locator: Locator): Promise<void> {
  const positioned = await locator.evaluate((element, expectedOperation) => {
    if (expectedOperation !== "append") return false;
    const html = element as HTMLElement;
    html.focus({ preventScroll: true });
    if (html instanceof HTMLInputElement || html instanceof HTMLTextAreaElement) {
      const end = html.value.length;
      try { html.setSelectionRange(end, end); }
      catch { return false; }
      return html.selectionStart === end && html.selectionEnd === end;
    }
    if (html.isContentEditable) {
      const selection = html.ownerDocument.getSelection();
      if (!selection) return false;
      const range = html.ownerDocument.createRange();
      range.selectNodeContents(html);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    }
    return false;
  }, "append");
  if (!positioned) throw new Error("BrowserType could not establish a bounded append position.");
}

async function resolveExactSelectOptions(locator: Locator, values: readonly string[]): Promise<{ kinds: Array<"value" | "label">; labels: string[] }> {
  const options = locator.locator("option");
  const count = await options.count();
  if (count > 512 || (values.length > 1 && await locator.getAttribute("multiple") === null)) {
    throw new Error("The requested option set exceeds bounded native selection limits.");
  }
  const facts = await settleBrowserReads(Array.from({ length: count }, async (_, index) => {
    const option = options.nth(index);
    const [value, label, text] = await settleBrowserReads([option.getAttribute("value"), option.getAttribute("label"), option.textContent()]);
    const normalizedText = (text ?? "").replace(/[\t\n\f\r ]+/g, " ").trim();
    return { value: value ?? normalizedText, label: label || normalizedText, text: text ?? "" };
  }));
  const kinds: Array<"value" | "label"> = [];
  const labels: string[] = [];
  const indexes = new Set<number>();
  for (const value of values) {
    const matches = facts.map((fact, index) => ({ fact, index })).filter(({ fact }) => fact.value === value || fact.label === value);
    if (matches.length !== 1 || indexes.has(matches[0]!.index)) {
      throw new Error("The requested exact option set was unavailable, ambiguous, or incompatible with this control.");
    }
    const { fact, index } = matches[0]!;
    indexes.add(index);
    kinds.push(fact.value === value ? "value" : "label");
    labels.push(fact.label, fact.text, fact.value);
  }
  return { kinds, labels };
}

function digestExactValues(values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(String(Buffer.byteLength(value)), "utf8");
    hash.update("\0");
    hash.update(value, "utf8");
    hash.update("\0");
  }
  return hash.digest("base64url");
}

function assertExactText(value: unknown, maxChars: number, emptyAllowed: boolean): asserts value is string {
  if (typeof value !== "string" || (!emptyAllowed && value.length === 0) || value.length > maxChars) {
    throw new Error("Browser form text is absent or exceeds its bounded length.");
  }
}

function assertSelectValues(values: unknown): asserts values is readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > BROWSER_SELECT_MAX_OPTIONS
    || values.some((value) => typeof value !== "string" || value.length < 1 || value.length > BROWSER_SELECT_OPTION_MAX_CHARS)) {
    throw new Error("Browser option set is absent or exceeds its bounded size.");
  }
  if (new Set(values).size !== values.length) throw new Error("Browser option set must not contain duplicates.");
}

export function normalizeBrowserPressKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > BROWSER_PRESS_KEY_MAX_CHARS || /\s/.test(value)) {
    throw new Error("BrowserPress key is not an allowed key or short chord.");
  }
  const parts = value.split("+");
  if (parts.some((part) => !part) || parts.length > 3) throw new Error("BrowserPress key is not an allowed key or short chord.");
  const base = parts.at(-1)!;
  const modifiers = parts.slice(0, -1);
  const modifierSet = new Set(modifiers);
  const modifierNames = new Set(["Alt", "Control", "Meta", "Shift"]);
  if (modifierSet.size !== modifiers.length || modifiers.some((part) => !modifierNames.has(part))) {
    throw new Error("BrowserPress key is not an allowed key or short chord.");
  }
  const named = new Set([
    "Enter", "Space", "Tab", "Escape", "Backspace", "Delete",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown",
  ]);
  const editingChord = ["A", "Y", "Z"].includes(base)
    && modifiers.some((modifier) => modifier === "Control" || modifier === "Meta")
    && modifiers.every((modifier) => modifier === "Control" || modifier === "Meta" || modifier === "Shift");
  if (!named.has(base) && !editingChord) throw new Error("BrowserPress key is not an allowed key or short chord.");
  // Alt/Meta/Control navigation chords are browser-global rather than bounded
  // target actions. Only Shift may modify named keys; activation stays risky.
  if (named.has(base) && modifiers.some((modifier) => modifier !== "Shift")) {
    throw new Error("BrowserPress key is not an allowed key or short chord.");
  }
  return value;
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

function publicPageUrl(rawUrl: string): string {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("Browser ended at an invalid URL."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Browser ended at blocked protocol ${url.protocol}.`);
  return bounded(url.href, 2_048);
}

async function validateNavigationUrl(rawUrl: string, resolveHostname: HostResolver): Promise<URL> {
  // Shared fetch/cache validation deliberately canonicalizes away fragments.
  // Restore only the hash; authority validation and broker egress are unchanged.
  const validated = await validatePublicUrl(rawUrl, resolveHostname);
  const navigation = new URL(validated.href);
  navigation.hash = new URL(rawUrl).hash;
  return navigation;
}

async function assertControlledTopNavigation(locator: Locator, _page: Page): Promise<void> {
  const facts = await readIsolatedNavigationFacts(locator);
  if (!facts.topLevel) {
    throw new Error("BrowserClick not_started: controlled navigation from a child frame is unsupported.");
  }
  if (facts.target && facts.target.toLowerCase() !== "_self") {
    throw new Error("BrowserClick not_started: controlled navigation requires the current frame as its effective target.");
  }
}

class BrowserValidationError extends Error {}

function invalidSessionHandleError(): BrowserRecoveryError {
  return new BrowserRecoveryError(
    "Invalid or stale browser session handle: it was not issued by this manager, or a different owner holds it. Use BrowserOpen to start a browser for this Pi session; BrowserSnapshot cannot recover an unknown session.",
    { kind: "session_unknown" },
  );
}

function invalidTabHandleError(session: Session): BrowserRecoveryError {
  const ownedTabs = [...session.tabs.keys()];
  const listing = ownedTabs.length > 0
    ? `Current owned tabs: ${ownedTabs.join(", ")}.`
    : "No other tabs are currently owned by this session.";
  return new BrowserRecoveryError(
    `Invalid or stale browser tab handle for this session. ${listing} Take a fresh BrowserSnapshot on an owned tab, or switch with BrowserTabs.`,
    { kind: "tabs", session: session.handle, ownedTabs },
  );
}

function duplicateOpenError(existing: Session): BrowserRecoveryError {
  return new BrowserRecoveryError(
    `A live browser is already open for this Pi session: session=${existing.handle} with active tab=${existing.activeTab}. An earlier successful BrowserOpen result may have been lost to a rewind or Escape. Use BrowserTabs operation=list on that session to recover its handles, then BrowserNavigate or BrowserClose; this BrowserOpen preserved the live session and opened no new browser.`,
    { kind: "duplicate_open", existingSession: existing.handle, existingTab: existing.activeTab },
  );
}

function openCancellationError(cancellation: BrowserCancellationKind, dispatched: boolean): BrowserRecoveryError {
  const by = cancellation === "shutdown"
    ? " by Pi session shutdown/replacement/reload"
    : cancellation === "close" ? " by BrowserClose" : "";
  if (!dispatched) {
    return new BrowserRecoveryError(
      `BrowserOpen was cancelled${by} before navigation dispatch; no page effects occurred and cleanup was confirmed. It is safe to retry BrowserOpen.`,
      { kind: "cancelled", phase: "not_started", cleanup: "confirmed", recovery: "retry" },
    );
  }
  return new BrowserRecoveryError(
    `BrowserOpen was cancelled${by} after navigation dispatch; network effects may have occurred, effect status is unknown, and no rollback is claimed. Cleanup was confirmed; use BrowserOpen to start a new browser session.`,
    { kind: "cancelled", phase: "dispatched", cleanup: "confirmed", recovery: "reopen" },
  );
}

function unconfirmedOpenCleanupError(): BrowserRecoveryError {
  return new BrowserRecoveryError(
    "BrowserOpen failed and teardown could not be confirmed; browser resources may remain. This browser manager is fail-closed: recover by restarting the Pi session (terminal restart or reload) before further browser use. Effect status is unknown; no rollback is claimed.",
    { kind: "unconfirmed_cleanup", phase: "unknown", cleanup: "unconfirmed" },
  );
}

function operationCancellationError(cancellation: BrowserCancellationKind, phase: "not_started" | "dispatched" | "unknown"): BrowserRecoveryError {
  const by = cancellation === "close"
    ? " by BrowserClose"
    : cancellation === "shutdown" ? " by Pi session shutdown/replacement/reload" : "";
  if (phase === "not_started") {
    return new BrowserRecoveryError(
      `Browser operation was cancelled${by} before dispatch; effect status is not_started and no page effects occurred. Session teardown was confirmed; use BrowserOpen to start a new browser session.`,
      { kind: "cancelled", phase: "not_started", cleanup: "confirmed", recovery: "reopen" },
    );
  }
  if (phase === "dispatched") {
    return new BrowserRecoveryError(
      `Browser operation was cancelled${by} after dispatch; page or network effects may have occurred, effect status is unknown, and no rollback is claimed. Cleanup was confirmed; use BrowserOpen to start a new browser session.`,
      { kind: "cancelled", phase: "dispatched", cleanup: "confirmed", recovery: "reopen" },
    );
  }
  return new BrowserRecoveryError(
    `Browser operation was cancelled${by}; effect status is unknown and no rollback is claimed. Session teardown was confirmed; use BrowserOpen to start a new browser session.`,
    { kind: "cancelled", phase: "unknown", cleanup: "confirmed", recovery: "reopen" },
  );
}

function operationTeardownUncertainError(): BrowserRecoveryError {
  return new BrowserRecoveryError(
    "Browser operation failed and teardown could not be confirmed; browser resources may remain. This browser manager is fail-closed: recover by restarting the Pi session (terminal restart or reload) before further browser use. Effect status is unknown; no rollback is claimed.",
    { kind: "unconfirmed_cleanup", phase: "unknown", cleanup: "unconfirmed" },
  );
}

function invalidRefError(): Error {
  return new BrowserValidationError("Invalid or stale browser semantic ref; take a fresh BrowserSnapshot for the current session, tab, and document.");
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

function boundedUntrustedText(raw: unknown, maxChars: number): { value: string; truncated: boolean } {
  const original = typeof raw === "string" ? raw : String(raw ?? "");
  // Strip terminal/control framing and bidi overrides before generic secret
  // redaction. The returned string is page-controlled evidence, never markup.
  const captured = original.slice(0, maxChars);
  const structural = captured
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "");
  const redacted = redactSensitiveText(structural);
  return {
    value: redacted.slice(0, maxChars),
    truncated: original.length > maxChars || redacted.length > maxChars,
  };
}

function consoleLevel(raw: string): BrowserConsoleEvent["level"] {
  const normalized = raw.toLocaleLowerCase("en-US");
  if (normalized === "debug" || normalized === "info" || normalized === "log" || normalized === "error") return normalized;
  if (normalized === "warning" || normalized === "warn") return "warning";
  return "other";
}

function diagnosticElapsed(now: number, createdAt: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(now - createdAt)));
}

function boundedNonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)))
    : 0;
}

function boundedHttpStatus(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 999 ? value : 0;
}

function diagnosticMethod(raw: string): string {
  const upper = raw.toLocaleUpperCase("en-US");
  return /^[A-Z]{1,16}$/.test(upper) ? upper : "OTHER";
}

function diagnosticResourceKind(raw: string): string {
  const normalized = raw.toLocaleLowerCase("en-US");
  const allowed = new Set([
    "document", "stylesheet", "script", "xhr", "fetch", "image", "font", "media",
    "websocket", "eventsource", "manifest", "texttrack", "other",
  ]);
  return allowed.has(normalized) ? normalized : "other";
}

function diagnosticNetworkFailure(raw: string): string {
  // Browser failure strings occasionally embed the complete request URL.
  // Retain only Chromium's fixed error token, never free-form failure text.
  const code = /\b(?:net::)?ERR_[A-Z0-9_]{1,64}\b/u.exec(raw)?.[0];
  return code ? code.slice(0, 64) : "request_failed";
}

function diagnosticOrigin(rawUrl: string, maxChars: number): string {
  const origin = diagnosticPublicOrigin(rawUrl);
  return bounded(origin ?? "[non-public or redacted origin]", maxChars);
}

function diagnosticPublicOrigin(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return bounded(parsed.origin, 300);
  } catch {
    return null;
  }
}

/** Bounded origin for WebSocket diagnostics: scheme+host+port only. */
function diagnosticWsOrigin(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return "[non-public or redacted origin]";
    return bounded(parsed.origin, 300);
  } catch {
    return "[non-public or redacted origin]";
  }
}

function boundedWsCloseCode(code: unknown): number | undefined {
  return typeof code === "number" && Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : undefined;
}

/** Close reasons are page-channel data; bound them before they re-enter a route. */
function boundedWsCloseReason(reason: unknown): string | undefined {
  return typeof reason === "string" && reason.length > 0 ? reason.slice(0, 123) : undefined;
}

/** Synchronous admission checks for one page-created WebSocket URL. */
function validateLiveWebSocket(
  rawUrl: string,
  protocols: readonly string[],
): { allowed: true; url: URL; protocols: string[] } | { allowed: false; reason: string } {
  if (rawUrl.length === 0 || rawUrl.length > WS_MAX_URL_CHARS) return { allowed: false, reason: "websocket URL exceeds bound" };
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { allowed: false, reason: "websocket URL is malformed" }; }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") return { allowed: false, reason: "websocket protocol not allowed" };
  if (url.username !== "" || url.password !== "") return { allowed: false, reason: "websocket credentials not allowed" };
  if (!url.hostname) return { allowed: false, reason: "websocket URL is malformed" };
  if (protocols.length > WS_MAX_PROTOCOLS) return { allowed: false, reason: "websocket subprotocol not allowed" };
  const cleanProtocols: string[] = [];
  for (const protocol of protocols) {
    // RFC 6455 token characters only; anything else is refused fail-closed.
    if (typeof protocol !== "string" || protocol.length === 0 || protocol.length > WS_PROTOCOL_MAX_CHARS
      || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(protocol)) {
      return { allowed: false, reason: "websocket subprotocol not allowed" };
    }
    cleanProtocols.push(protocol);
  }
  return { allowed: true, url, protocols: cleanProtocols };
}

function semanticToken(value: unknown, maxChars: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const token = value.trim().toLocaleLowerCase("en-US");
  return /^[a-z][a-z0-9_-]*$/.test(token) ? token.slice(0, maxChars) : fallback;
}

function nullableSemanticToken(value: unknown, maxChars: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  const token = semanticToken(value, maxChars, "");
  return token || null;
}

function implicitSemanticRole(tag: string, type: string | null): string | null {
  if (tag === "a" || tag === "area") return "link";
  if (tag === "button") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "img") return "img";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag !== "input") return null;
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  if (["button", "submit", "reset", "image"].includes(type ?? "")) return "button";
  if (type === "range") return "slider";
  return "textbox";
}

function safely<T>(operation: () => T, fallback: T): T {
  try { return operation(); }
  catch { return fallback; }
}

function normalizedInteractionFailure(
  name: "BrowserHover" | "BrowserClick" | "BrowserFill" | "BrowserType" | "BrowserSelect" | "BrowserPress",
  error: unknown,
): Error {
  const message = error instanceof Error ? error.message : "";
  if (/\b(?:not_started|effect status is (?:started|completed|unknown))\b/i.test(message)) return asError(error);
  if (/Invalid or stale browser session handle|Browser session is closed/.test(message)) {
    return new Error(`${name} not_started: browser session is closed or unknown; use BrowserOpen to start a browser for this Pi session (BrowserSnapshot cannot recover it).`);
  }
  if (/Invalid or stale browser tab handle/.test(message)) {
    return new Error(`${name} not_started: invalid or stale owned tab capability; list owned tabs with BrowserTabs and take a fresh BrowserSnapshot.`);
  }
  if (/Invalid or stale browser semantic ref/.test(message)) {
    return new Error(`${name} not_started: invalid or stale owned semantic capability; take a fresh BrowserSnapshot.`);
  }
  return new Error(`${name} failed before dispatch; effect status is not_started.`);
}

function cancellationKind(signal: AbortSignal): BrowserCancellationKind | undefined {
  if (!signal.aborted) return undefined;
  // Classify only against fixed manager-owned reason strings; arbitrary
  // caller or page exception text is never parsed for meaning.
  const reasonMessage = signal.reason instanceof Error ? signal.reason.message : "";
  if (reasonMessage === BROWSER_CLOSE_CANCEL_REASON) return "close";
  if (reasonMessage === SESSION_SHUTDOWN_CANCEL_REASON) return "shutdown";
  return "caller";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

interface RawSemanticDetail {
  role: string | null;
  tag: string;
  type: string | null;
  accessibleName: string;
  accessibleDescription: string;
  checked: boolean | "mixed" | null;
  disabled: boolean;
  expanded: boolean | null;
  selected: boolean | null;
  focused: boolean;
  editable: boolean;
  href: string | null;
  visibleText: string;
  visibleTextTruncated: boolean;
  textSuppressed: boolean;
}

const INSPECT_TAG_ALLOWLIST = [
  "a", "area", "button", "input", "textarea", "select", "option", "img", "summary", "details",
  "form", "fieldset", "legend", "label", "nav", "main", "header", "footer", "section", "article",
  "ul", "ol", "li", "table", "tr", "th", "td", "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "div", "span", "svg",
] as const;

const INSPECT_COMPUTED_ROLE_ALLOWLIST = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption", "cell",
  "checkbox", "code", "columnheader", "combobox", "complementary", "contentinfo", "definition", "deletion",
  "dialog", "directory", "document", "emphasis", "feed", "figure", "form", "generic", "grid", "gridcell",
  "group", "heading", "img", "insertion", "link", "list", "listbox", "listitem", "log", "main", "marquee",
  "math", "meter", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "navigation", "none",
  "note", "option", "paragraph", "progressbar", "radio", "radiogroup", "region", "row", "rowgroup",
  "rowheader", "scrollbar", "search", "searchbox", "separator", "slider", "spinbutton", "status", "strong",
  "subscript", "superscript", "switch", "tab", "table", "tablist", "tabpanel", "term", "textbox", "time",
  "timer", "toolbar", "tooltip", "tree", "treegrid", "treeitem",
]);

const INSPECT_CHECKED_ROLES = new Set(["checkbox", "menuitemcheckbox", "menuitemradio", "option", "radio", "switch", "treeitem"]);
const INSPECT_EXPANDED_ROLES = new Set([
  "application", "button", "checkbox", "columnheader", "combobox", "gridcell", "link", "listbox", "menuitem",
  "menuitemcheckbox", "menuitemradio", "row", "rowheader", "switch", "tab", "treeitem",
]);
const INSPECT_SELECTED_ROLES = new Set(["columnheader", "gridcell", "option", "row", "rowheader", "tab", "treeitem"]);

async function readSemanticDetail(
  locator: Locator,
  page: Page,
  computed: CapturedAriaSemantic,
  limits: { text: number; name: number; description: number },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<RawSemanticDetail> {
  const timeout = Math.max(1, timeoutMs);
  const attributesPromise = settleBrowserReads([
    locator.getAttribute("type", { timeout }),
    locator.getAttribute("href", { timeout }),
    locator.getAttribute("aria-checked", { timeout }),
    locator.getAttribute("aria-expanded", { timeout }),
    locator.getAttribute("aria-selected", { timeout }),
  ]);
  const tagPromise = identifySemanticTag(locator, page);
  const disabledPromise = locator.isDisabled({ timeout });
  const focusedPromise = locator.and(page.locator(":focus")).count().then((count) => count === 1);
  // A second ariaSnapshot call rewrites Playwright's aria-ref registry and
  // would silently stale sibling opaque refs. Revalidate the captured computed
  // role/name and read current computed states through fixed getByRole filters
  // instead; these use Playwright's isolated accessibility engine without
  // changing the ref registry or entering the page's main world.
  const semanticsCurrentPromise = verifyComputedSemantic(locator, page, computed);
  const [attributes, tag, disabled, focused] = await settleBrowserReads([
    attributesPromise, tagPromise, disabledPromise, focusedPromise, semanticsCurrentPromise,
  ]);
  throwIfAborted(signal);
  const [typeAttribute, hrefAttribute, ariaChecked, ariaExpanded, ariaSelected] = attributes;
  const type = tag === "input" || tag === "button" ? nullableSemanticToken(typeAttribute?.slice(0, 33), 32) : null;
  const editingHost = locator.locator('xpath=ancestor-or-self::*[@contenteditable][1]');
  const contentEditable = await editingHost.count() ? (await editingHost.getAttribute("contenteditable", { timeout }))?.toLowerCase() : null;
  const mayBeEditable = tag === "input" || tag === "textarea" || tag === "select"
    || contentEditable === "" || contentEditable === "true" || contentEditable === "plaintext-only"
    || computed.role === "textbox" || computed.role === "combobox" || computed.role === "searchbox";
  const editable = mayBeEditable ? await locator.isEditable({ timeout }) : false;
  const checkedState = await currentComputedBoolean(locator, page, computed, "checked", INSPECT_CHECKED_ROLES);
  const expandedState = tag === "summary"
    ? await currentDisclosureState(locator, page)
    : await currentComputedBoolean(locator, page, computed, "expanded", INSPECT_EXPANDED_ROLES);
  const selectedState = await currentComputedBoolean(locator, page, computed, "selected", INSPECT_SELECTED_ROLES);
  const textSuppressed = editable || tag === "input" || tag === "textarea" || tag === "select";
  const visibleText = textSuppressed ? "" : await locator.innerText({ timeout });
  throwIfAborted(signal);
  const description = await readComputedDescription(locator, limits.description);
  let href: string | null = null;
  if ((tag === "a" || tag === "area") && hrefAttribute !== null) {
    const documentBase = await ownerDocumentBaseUrl(locator);
    try { href = diagnosticPublicOrigin(new URL(hrefAttribute, documentBase).href); }
    catch { href = null; }
  }
  const normalizedVisibleText = visibleText.slice(0, limits.text + 1).replace(/\s+/gu, " ").trim();
  return {
    role: nullableSemanticToken(computed.role, 64),
    tag,
    type,
    accessibleName: computed.name.slice(0, limits.name + 1),
    accessibleDescription: description,
    checked: ariaBooleanOrMixed(ariaChecked) ?? checkedState,
    disabled,
    expanded: expandedState ?? ariaBoolean(ariaExpanded),
    selected: selectedState ?? ariaBoolean(ariaSelected),
    focused,
    editable,
    href,
    visibleText: normalizedVisibleText,
    visibleTextTruncated: normalizedVisibleText.length > limits.text,
    textSuppressed,
  };
}

async function identifySemanticTag(locator: Locator, page: Page): Promise<string> {
  const matches = await settleBrowserReads(INSPECT_TAG_ALLOWLIST.map(async (tag) =>
    (await locator.and(page.locator(tag)).count()) === 1));
  const index = matches.indexOf(true);
  return index < 0 ? "other" : INSPECT_TAG_ALLOWLIST[index]!;
}

async function currentComputedBoolean(
  locator: Locator,
  page: Page,
  semantic: CapturedAriaSemantic,
  state: "checked" | "expanded" | "selected",
  supportedRoles: ReadonlySet<string>,
): Promise<boolean | null> {
  if (!semantic.role || !supportedRoles.has(semantic.role)) return null;
  const role = semantic.role as Parameters<Page["getByRole"]>[0];
  const common = { name: semantic.name, exact: true };
  const [trueMatches, falseMatches] = await settleBrowserReads([
    locator.and(page.getByRole(role, { ...common, [state]: true })).count(),
    locator.and(page.getByRole(role, { ...common, [state]: false })).count(),
  ]);
  if (trueMatches === 1) return true;
  if (falseMatches === 1) return false;
  return null;
}

async function currentDisclosureState(locator: Locator, page: Page): Promise<boolean | null> {
  const [open, closed] = await settleBrowserReads([
    locator.and(page.locator("details[open] > summary")).count(),
    locator.and(page.locator("details:not([open]) > summary")).count(),
  ]);
  return open === 1 ? true : closed === 1 ? false : null;
}

async function ownerDocumentBaseUrl(locator: Locator): Promise<string> {
  return (await readIsolatedNavigationFacts(locator)).baseUrl;
}

type IsolatedNavigationFacts = { baseUrl: string; topLevel: boolean; target: string | null };

async function readIsolatedNavigationFacts(locator: Locator): Promise<IsolatedNavigationFacts> {
  // Use the in-process Playwright implementation's isolated selector evaluator.
  // Reading markup cannot account for CSP or frozen inherited document bases.
  // Do not use locator.evaluate / to.have.property, or acquire a main-world
  // ElementHandle: those can enter the page realm (including handle previews).
  const internal = locator as unknown as {
    _selector: string;
    _frame: { _connection?: { toImpl?(frame: unknown): {
      selectors?: { callOnSelector?(
        selector: string,
        options: { strict: true; mainWorld: false },
        read: (target: { elements: Element[] }) => IsolatedNavigationFacts | null,
        arg: undefined,
      ): Promise<{ result: unknown } | null> };
    } } };
  };
  // Only our generation-scoped aria-ref locator is accepted, never a caller
  // selector or a custom selector engine. Built-in aria-ref runs in utility.
  if (!/^aria-ref=(?:f\d+)?e\d+$/.test(internal._selector)) throw invalidRefError();
  const implementation = internal._frame?._connection?.toImpl?.(internal._frame);
  if (!implementation?.selectors?.callOnSelector) {
    throw new Error("BrowserInspect isolated document base reader is unavailable.");
  }
  const observed = await implementation.selectors.callOnSelector(
    internal._selector,
    { strict: true, mainWorld: false },
    ({ elements }) => {
      const element = elements[0];
      if (elements.length !== 1 || !element?.isConnected) return null;
      const document = element.ownerDocument;
      const view = document.defaultView;
      return {
        baseUrl: document.baseURI,
        topLevel: view !== null && view === view.top,
        target: element.getAttribute("target") ?? document.querySelector("base[target]")?.getAttribute("target") ?? null,
      };
    },
    undefined,
  );
  const facts = observed?.result as Partial<IsolatedNavigationFacts> | null;
  if (!facts || typeof facts.baseUrl !== "string" || typeof facts.topLevel !== "boolean"
    || (facts.target !== null && typeof facts.target !== "string")) throw invalidRefError();
  return facts as IsolatedNavigationFacts;
}

function parseAriaRoot(snapshot: string): {
  role: string | null;
  name: string;
  checked: boolean | "mixed" | null;
  disabled: boolean;
  expanded: boolean | null;
  selected: boolean | null;
  focused: boolean;
} {
  const first = snapshot.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  const role = /^-\s+([a-z][a-z0-9_-]*)\b/u.exec(first)?.[1] ?? null;
  const quoted = /^-\s+[a-z][a-z0-9_-]*\s+("(?:\\.|[^"\\])*")/u.exec(first)?.[1];
  let name = "";
  if (quoted) {
    try { name = JSON.parse(quoted) as string; }
    catch { name = ""; }
  }
  const checkedValue = /\[checked=(mixed|true|false)\]/u.exec(first)?.[1];
  const checked = checkedValue === "mixed" ? "mixed"
    : checkedValue === "true" ? true
      : checkedValue === "false" ? false
        : /\[checked\]/u.test(first) ? true : null;
  return {
    role,
    name,
    checked,
    disabled: /\[disabled\]/u.test(first),
    expanded: /\[expanded\]/u.test(first) ? true : /\[expanded=false\]/u.test(first) ? false : null,
    selected: /\[selected\]/u.test(first) ? true : /\[selected=false\]/u.test(first) ? false : null,
    focused: /\[active\]/u.test(first),
  };
}

function ariaBoolean(value: string | null): boolean | null {
  return value === "true" ? true : value === "false" ? false : null;
}

function ariaBooleanOrMixed(value: string | null): boolean | "mixed" | null {
  return value === "mixed" ? "mixed" : ariaBoolean(value);
}

function sanitizeSemanticDetail(raw: RawSemanticDetail, limits: Readonly<InteractiveBrowserLimits>): BrowserInspectResult["semantic"] {
  if (!raw || typeof raw !== "object") throw new Error("BrowserInspect could not safely read the semantic target.");
  const tag = semanticToken(raw.tag, 64, "other");
  const type = nullableSemanticToken(raw.type, 32);
  const editable = raw.editable;
  const suppressed = editable || tag === "input" || tag === "textarea" || tag === "select" || type === "password" || raw.textSuppressed;
  const name = boundedUntrustedText(raw.accessibleName, limits.maxInspectNameChars);
  const description = boundedUntrustedText(raw.accessibleDescription, limits.maxInspectDescriptionChars);
  const visible = boundedUntrustedText(suppressed ? "" : raw.visibleText, limits.maxInspectTextChars);
  return {
    role: raw.role ?? implicitSemanticRole(tag, type),
    tag,
    type,
    accessibleName: name.value,
    accessibleDescription: description.value,
    states: {
      checked: raw.checked,
      disabled: raw.disabled,
      expanded: raw.expanded,
      selected: raw.selected,
      focused: raw.focused,
      editable,
    },
    hrefOrigin: raw.href ? diagnosticPublicOrigin(raw.href) : null,
    visibleText: {
      text: suppressed ? "" : visible.value,
      returnedChars: suppressed ? 0 : visible.value.length,
      truncated: suppressed ? false : raw.visibleTextTruncated || visible.truncated,
      suppressed,
    },
  };
}

async function verifyComputedSemantic(locator: Locator, page: Page, computed: CapturedAriaSemantic): Promise<void> {
  if (!computed.role || !INSPECT_COMPUTED_ROLE_ALLOWLIST.has(computed.role)) return;
  const role = computed.role as Parameters<Page["getByRole"]>[0];
  const matches = await locator.and(page.getByRole(role, { name: computed.name, exact: true })).count();
  if (matches !== 1) {
    throw new Error("BrowserInspect semantic target changed since BrowserSnapshot; take a fresh BrowserSnapshot.");
  }
}

async function readComputedDescription(locator: Locator, maxChars: number): Promise<string> {
  // Playwright's fixed accessibility assertion runs in its isolated utility
  // world and returns the computed value without rewriting aria-ref identity.
  // Do not substitute to.have.property: that assertion uses the page world.
  const internal = locator as unknown as {
    _expect(expression: string, options: {
      expectedText: Array<{ regexSource: string }>;
      isNot: boolean;
      timeout: number;
    }): Promise<{ received?: unknown }>;
  };
  const result = await internal._expect("to.have.accessible.description", {
    expectedText: [{ regexSource: "(?!)" }],
    isNot: false,
    timeout: 1,
  });
  const received = result.received as { value?: unknown } | undefined;
  if (typeof received?.value !== "string") throw new Error("BrowserInspect computed description was unavailable.");
  // Bound only after computation, never before an exact-equality check.
  return received.value.slice(0, maxChars + 1);
}
