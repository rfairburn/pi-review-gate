import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { BROWSER_HUMAN_INPUT_WORLD, createHumanInputInitScript, HumanInputVerifier } from "./browser-human-input.js";
import { BrowserIdleLease, validateIdleExpiryMinutes } from "./browser-idle-lifecycle.js";
import { BrowserOwnershipError, prepareOwnedBrowser } from "./browser-owned-process";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type BrowserType,
  type ConsoleMessage,
  type Dialog,
  type Download,
  type Page,
  type Request,
  type Response,
} from "playwright";
import { DEFAULT_BROWSER_PERMISSIONS, type BrowserInteractionApproval, type WebBrowserPermissions, type WebFetchConfig } from "../config";
import { effectiveBrowserPolicy, type EffectiveBrowserPolicy } from "./browser-capabilities.js";
import { BrowserOutputPrivacy } from "./browser-output-privacy";
import {
  MAX_MAIN_DOCUMENT_REDIRECTS,
  assertChromiumAvailable,
  auditEgressLedger,
} from "./browser";
import {
  DEFAULT_EGRESS_BUDGETS,
  EgressBroker,
  type BrokerDial,
  type EgressBrokerObserver,
  type EgressBudgets,
  type EgressSummary,
} from "./egress-broker";
import type { HostResolver } from "./network";
import { classifyPublicUrlError, defaultHostResolver, PublicUrlValidationError } from "./network";
import {
  BrowserConfirmationPermits,
  BrowserConsequencePolicy,
  modelActionRequiresCredentialEntry,
  modelActionSubmitsCredentialForm,
  type BrowserClickButton,
  type BrowserConsequence,
  type BrowserConsequenceDecision,
  type BrowserFormOperation,
  type BrowserTargetStructure,
} from "./browser-interaction-policy";
import {
  BROWSER_CLOSE_CANCEL_REASON,
  SESSION_SHUTDOWN_CANCEL_REASON,
  VISIBILITY_CANCEL_REASON,
  BrowserCapabilityDeniedError,
  BrowserCaptureInvalidatedError,
  BrowserClipboardOutcomeError,
  BrowserFailureError,
  BrowserIdleExpiredError,
  BrowserRecoveryError,
  BrowserSessionClosedError,
  BrowserValidationError,
  DEADLINE_ERROR_PATTERN,
  browserFailure,
  cancellationKind,
  classifyFatalSessionError,
  classifyNavigationError,
  classifySetupFailure,
  duplicateOpenError,
  invalidRefError,
  invalidSessionHandleError,
  invalidTabHandleError,
  normalizedInteractionFailure,
  operationCancellationError,
  operationTeardownUncertainError,
  openCancellationError,
  unconfirmedOpenCleanupError,
  type BrowserClosureReason,
  type BrowserFailureCategory,
  type BrowserFailurePhase,
} from "./browser-errors.js";
import { BrowserDiagnosticQuota, DiagnosticRing } from "./browser-diagnostics.js";
import { OperationDeadline, boundedCleanup, operationWork } from "./browser-operations.js";
import {
  interactionIdentityUrl,
  publicPageUrl,
  redactedInteractionUrl,
  safePublicPageUrl,
  urlWaitMatcher,
  validateNavigationUrl,
} from "./browser-url-policy.js";
// Issue #46 browser responsibility decomposition: cohesive browser modules now
// hold the authoritative definitions; the manager keeps session/tab lifecycle,
// operation serialization, and per-operation approval orchestration behind the
// same public facade.
import {
  assertBoundedInteractionCapability,
  assertCoordinateClickInput,
  assertExactText,
  assertSelectValues,
  assertViewportScreenshotDimensions,
  boundedElementClip,
  BROWSER_CLIPBOARD_READ_MAX_CHARS,
  BROWSER_CLIPBOARD_WRITE_MAX_CHARS,
  BROWSER_FILL_MAX_CHARS,
  BROWSER_INTERACTION_REF_MAX_CHARS,
  BROWSER_INTERACTION_SESSION_MAX_CHARS,
  BROWSER_INTERACTION_TAB_MAX_CHARS,
  BROWSER_TYPE_MAX_CHARS,
  BROWSER_TYPE_MAX_DELAY_MS,
  clampedTestLimit,
  DEFAULT_BROWSER_DOWNLOAD_RETENTION,
  DEFAULT_VIEWPORT_HEIGHT,
  DEFAULT_VIEWPORT_WIDTH,
  INTERACTIVE_BROWSER_LIMITS,
  InteractiveBrowserLimits,
  normalizeBrowserPressKey,
  validatePngScreenshot,
} from "./browser-limits.js";
import {
  readTargetStructure,
  readPointTargetStructure,
  assertUploadTarget,
  assertSuitableFormTarget,
  positionAppendCaret,
  resolveExactSelectOptions,
  assertControlledTopNavigation,
  assertCoordinatePointGate,
} from "./browser-target-structure.js";
import { CapturedAriaSemantic, parseAriaRoot, readSemanticDetail, sanitizeSemanticDetail } from "./browser-inspect.js";
import type { BrowserInspectResult } from "./browser-inspect.js";
import {
  createTabDiagnosticRecorder,
  type TabDiagnosticRecorder,
  BrowserConsoleEvent,
  BrowserNetworkEvent,
} from "./browser-tab-diagnostics.js";
import { handleLiveWebSocket, type WebSocketAdmissionDeps } from "./browser-websocket-admission.js";
import {
  accountInteractionEffects,
  newInteractionCapture,
  interactionEffects,
  interactionResult,
  type InteractionCapture,
  type BrowserInteractionResult,
} from "./browser-interaction-effects.js";
import {
  confirmationBinding,
  coordinateClickPrompt,
  coordinateConfirmationBinding,
  confirmationPrompt,
  formConfirmationBinding,
  formConfirmationPrompt,
  clipboardConfirmationBinding,
  clipboardConfirmationPrompt,
  uploadConfirmationBinding,
  uploadConfirmationPrompt,
  downloadSaveBinding,
  downloadSaveConfirmationPrompt,
  digestExactValues,
  type ViewportScreenshotReference,
  type BrowserInteractionConfirmation,
  type BrowserClickConfirmation,
} from "./browser-approval-binding.js";
import {
  CLIPBOARD_PERMISSION_GROUPS,
  DEVICE_PERMISSION_GROUPS,
  ensureClipboardGrant,
  grantDevicePermissionsForPage,
  reapplyCarriedPermissionGrants,
  revokePermissionGrants,
  enforceClipboardCapability,
  type BrowserPermissionGroup,
  type BrowserPermissionRevocationOutcome,
  type BrowserPermissionRevocationEntry,
  type BrowserPermissionRevocationReport,
} from "./browser-permissions.js";
import {
  enforceFileTransferCapability,
  invalidDownloadHandleError,
  releasePendingDownload,
  releaseTabDownloads,
  resolveSaveDestination,
  retainPendingDownload,
  revalidateUploadSources,
  revokePendingDownloads,
  stageSaveArtifact,
  commitSaveTarget,
  validateDownloadRetention,
  validateUploadSources,
  waitForDownloadCompletion,
  type PendingDownloadRecord,
  type BrowserDownloadListResult,
} from "./browser-file-transfer.js";
import {
  CLIPBOARD_READ_SCRIPT,
  CLIPBOARD_WRITE_SCRIPT,
  clipboardUnavailableError,
  type BrowserClipboardOperation,
  type BrowserClipboardScope,
  type BrowserClipboardResult,
} from "./browser-clipboard.js";
import { cleanupSession, cleanupPartial, installRoutePolicy, interactiveChromiumArgs } from "./browser-session-cleanup.js"
import {
  captureVisibilityPlan,
  restoreVisibilityTabs,
  type VisibilityCapturePlan,
  type VisibilityRestorePlan,
  type BrowserVisibilityResult,
} from "./browser-visibility-replacement.js";
import { asError, bounded, throwIfAborted } from "./browser-primitives.js";

// Issue #153: cohesive helper families extracted from this manager module.
// These re-exports preserve the historical public surface and error
// identities; the authoritative definitions live in the sibling modules.
export {
  BrowserCaptureInvalidatedError,
  BrowserCapabilityDeniedError,
  BrowserFailureError,
  BrowserRecoveryError,
  BrowserSessionClosedError,
} from "./browser-errors.js";
export type {
  BrowserClipboardCapability,
  BrowserClosureReason,
  BrowserCredentialCapability,
  BrowserFailureCategory,
  BrowserFailurePhase,
  BrowserFileTransferCapability,
  BrowserRecoveryKind,
  BrowserRecoveryMetadata,
} from "./browser-errors.js";
export { BrowserDiagnosticQuota, DiagnosticRing } from "./browser-diagnostics.js";
export { interactiveRouteDecision } from "./browser-url-policy.js";
// Issue #46: the decomposed browser modules' historical public surface keeps
// one import path through this facade with identical value/type identities.
export {
  BROWSER_INTERACTION_SESSION_MAX_CHARS,
  BROWSER_INTERACTION_TAB_MAX_CHARS,
  BROWSER_INTERACTION_REF_MAX_CHARS,
  BROWSER_FILL_MAX_CHARS,
  BROWSER_TYPE_MAX_CHARS,
  BROWSER_TYPE_MAX_DELAY_MS,
  BROWSER_SELECT_MAX_OPTIONS,
  BROWSER_SELECT_OPTION_MAX_CHARS,
  BROWSER_PRESS_KEY_MAX_CHARS,
  BROWSER_UPLOAD_MAX_FILES,
  BROWSER_UPLOAD_PATH_MAX_CHARS,
  BROWSER_CLIPBOARD_WRITE_MAX_CHARS,
  BROWSER_CLIPBOARD_READ_MAX_CHARS,
  DEFAULT_BROWSER_DOWNLOAD_RETENTION,
  BROWSER_DOWNLOAD_FILENAME_MAX_CHARS,
  BROWSER_DOWNLOAD_DESTINATION_MAX_CHARS,
  BROWSER_DIAGNOSTIC_CURSOR_MAX,
  BROWSER_DIAGNOSTIC_READ_MAX_EVENTS,
  INTERACTIVE_BROWSER_LIMITS,
  DEFAULT_VIEWPORT_WIDTH,
  DEFAULT_VIEWPORT_HEIGHT,
  normalizeBrowserPressKey,
} from "./browser-limits.js";
export type { InteractiveBrowserLimits } from "./browser-limits.js";
export type { BrowserConsoleEvent, BrowserNetworkEvent } from "./browser-tab-diagnostics.js";
export type { BrowserInspectResult } from "./browser-inspect.js";
export type {
  BrowserInteractionEffectState,
  BrowserInteractionEffects,
  BrowserInteractionResult,
} from "./browser-interaction-effects.js";
export type {
  ViewportScreenshotReference,
  BrowserInteractionConfirmationRequest,
  BrowserInteractionConfirmation,
  BrowserClickConfirmation,
} from "./browser-approval-binding.js";
export type {
  BrowserPermissionRevocationOutcome,
  BrowserPermissionRevocationEntry,
  BrowserPermissionRevocationReport,
} from "./browser-permissions.js";
export type {
  BrowserDownloadState,
  BrowserPendingDownload,
  BrowserDownloadListResult,
} from "./browser-file-transfer.js";
export type {
  BrowserClipboardOperation,
  BrowserClipboardScope,
  BrowserClipboardResult,
} from "./browser-clipboard.js";
export { interactiveChromiumArgs } from "./browser-session-cleanup.js";
export type {
  BrowserVisibilityTabOutcome,
  BrowserVisibilityResult,
} from "./browser-visibility-replacement.js";


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
  navigationsRemaining: number | null;
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


export interface BrowserDiagnosticResult<T> {
  /** Session-wide broker overload count, not attributed to an individual tab. */
  brokerCapacityRefusals: number;
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
  navigationsRemaining: number | null;
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


export interface BrowserCloseResult {
  session: string;
  closed: true;
  alreadyClosed: boolean;
  quiescent: true;
  broker: (Pick<EgressSummary, "budgetAborts" | "refusals"> & { connections: number; ledgerDropped: number; capacityRefusals: number }) | null;
  diagnosticsRetained: boolean;
  closure?: BrowserClosureReason;
}

interface InteractiveBrowserDependencies {
  resolveHostname?: HostResolver;
  brokerDial?: BrokerDial;
  launch?: BrowserType["launch"];
  now?: () => number;
  randomHandle?: (kind: "session" | "tab" | "generation" | "ref" | "download") => string;
  consequencePolicy?: BrowserConsequencePolicy;
  confirmationPermits?: BrowserConfirmationPermits;
  limits?: Partial<InteractiveBrowserLimits>;
  /**
   * Session working directory: resolution root for relative upload sources and
   * download-save destinations (issue #27). Absolute destinations are not
   * fenced. Defaults to the process working directory at construction.
   */
  workspaceRoot?: string;
}

interface OpeningOperation {
  controller: AbortController;
  settled: Promise<void>;
  settle(): void;
  teardownFailure?: Error;
}

/** Internal launch plan: a plain BrowserOpen or a settings-driven visibility replacement. */
type SessionLaunchPlan =
  | { kind: "open"; url: string; headless: boolean }
  | { kind: "visibility"; headless: boolean; restore: VisibilityRestorePlan };


interface ActiveBrowserOperation {
  session: Session;
  controller: AbortController;
  settled: Promise<void>;
  settle(): void;
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
  /** Per-tab CDP session carrying the isolated-world human-input detector. */
  humanInputCdp?: CDPSession;
  consoleDiagnostics: DiagnosticRing<BrowserConsoleEvent>;
  networkDiagnostics: DiagnosticRing<BrowserNetworkEvent>;
  networkStartedAt: WeakMap<Request, number>;
  networkPolicy: WeakMap<Request, string>;
  /**
   * Issue #141 coordinate-click reference, established only by the last
   * successful viewport-mode BrowserScreenshot of this exact tab (element-mode
   * captures never replace it and failed captures never overwrite a valid
   * one; a new tab starts without one). Memory-only: it dies with the process
   * like every other browser state, and there is no expiry, age, or retake
   * policy — later interactions and navigation on the same tab leave the
   * reference in place, because it contributes only the recorded viewport
   * dimensions. It never attests that the page still matches the capture:
   * each coordinate click revalidates the live document generation, origin,
   * viewport, and hit-tested target exactly like ref clicks do.
   */
  viewportScreenshot?: ViewportScreenshotReference;
}


interface Session {
  handle: string;
  activeTab: string;
  tabs: Map<string, BrowserTab>;
  pendingPageClosures: Map<Page, Promise<void>>;
  pendingPageCreations: Set<Promise<void>>;
  /** Issue #27 integration: true only while a visibility-restore page
   * creation is in flight. Unowned pages arriving during that window are
   * deferred (never adopted, never refused) so an unrelated page-created
   * popup cannot steal the identity-scoped restore admission; they are
   * re-evaluated under the ordinary popup policy when the window closes
   * (settleDeferredRestorePages). */
  restoreCreationArmed: boolean;
  /** Unowned pages deferred while restoreCreationArmed was set. */
  deferredRestorePages: Page[];
  /** In-flight page-initiated WebSocket admissions; settled on teardown. */
  pendingWebSocketAdmissions: Set<Promise<void>>;
  /** Aborted when teardown begins so pending admissions stop waiting at once. */
  admissionAbort: AbortController;
  browser: Browser;
  context: BrowserContext;
  broker: EgressBroker;
  capacityRefusals: number;
  createdAt: number;
  navigations: number;
  actions: number;
  mainDocumentRequests: number;
  operationActive: boolean;
  interactionCapture?: InteractionCapture;
  fatalError?: Error;
  teardown?: Promise<BrowserCloseResult>;
  /** Window mode this session was launched with; drives visibility idempotence. */
  visible: boolean;
  /** Service-worker policy pinned at context creation (issue #27); changing
   * it requires the same controlled replacement as a visibility change. */
  serviceWorkers: "allow" | "block";
  /** Authenticates human-input renewal signals from the isolated world. */
  humanInputVerifier?: HumanInputVerifier;
  /** Retained pending downloads keyed by opaque handle (issue #27). */
  pendingDownloads: Map<string, PendingDownloadRecord>;
  /** Manager-issued browser permission grants per exact origin (issue #27).
   * Grants are per-origin context permissions, never context-wide; the map
   * exists so a live capability revocation can clear exactly what was issued. */
  permissionGrants: Map<string, Set<BrowserPermissionGroup>>;
  /** Serialization tail for every permission mutation (grant/revoke) on this
   * session. Concurrent mutations for one origin — a navigation commit's
   * device chain and an approved clipboard operation at the same moment —
   * must not snapshot overlapping unions, or the bookkeeping could forget a
   * group the engine still holds and strand it past a later revocation. */
  permissionGrantTail: Promise<void>;
}

const MAX_TOMBSTONES = 32;

/**
 * Process-local owner for isolated interactive browser sessions. Nothing is
 * persisted: opaque handles and all authenticated broker credentials die with
 * this extension process.
 */
export class InteractiveBrowserManager {
  private readonly consoleQuota = new BrowserDiagnosticQuota();
  private readonly networkQuota = new BrowserDiagnosticQuota();
  private idleExpiryMinutes = 15;
  private readonly idleLeases = new Map<Session, BrowserIdleLease>();

  private renewIdleLease(session: Session): void {
    if (session.teardown || session.fatalError) return;
    this.idleLeases.get(session)?.renew();
  }

  private noteToolActivity(sessionHandle: string): void {
    const session = this.sessions.get(sessionHandle);
    if (session) this.renewIdleLease(session);
  }

  private startIdleLease(session: Session): void {
    this.idleLeases.set(session, new BrowserIdleLease(
      this.idleExpiryMinutes,
      () => session.operationActive || this.openings.size > 0,
      () => {
        if (session.teardown || session.fatalError) return;
        session.fatalError = new BrowserIdleExpiredError();
        void this.beginTeardown(session).catch(() => undefined);
      },
      this.now,
    ));
  }
  // One manager belongs to one Pi session. Retain across browser close/reopen
  // because later tabs can redisplay previously entered content.
  private readonly outputPrivacy = new BrowserOutputPrivacy();

  /** Delegated per-tab diagnostic recording (browser-tab-diagnostics.ts). */
  private readonly tabDiagnostics: TabDiagnosticRecorder = createTabDiagnosticRecorder({
    now: () => this.now(),
    text: (value) => this.outputPrivacy.text(value),
    limits: () => ({
      maxConsoleTextChars: this.limits.maxConsoleTextChars,
      maxConsoleSourceChars: this.limits.maxConsoleSourceChars,
    }),
  });
  /** Delegated live WebSocket admission (browser-websocket-admission.ts). */
  private readonly webSocketAdmissionDeps: WebSocketAdmissionDeps = {
    now: () => this.now(),
    resolveHostname: (hostname) => this.resolveHostname(hostname),
    allowLocalNetworks: () => this.effectivePolicy.localNetworks,
    recorder: this.tabDiagnostics,
  };

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
  /** Session working directory: resolution root for relative upload sources and download-save destinations (issue #27). */
  private readonly workspaceRoot: string;
  /** Configured retained-unsaved-download cap per session (web.browserDownloadRetention); 0 disables count-based eviction. */
  private downloadRetention: number = DEFAULT_BROWSER_DOWNLOAD_RETENTION;
  private readonly consequencePolicy: BrowserConsequencePolicy;
  private readonly confirmationPermits: BrowserConfirmationPermits;
  /**
   * Issue #27 effective capability/approval policy, computed by the shared
   * helper from the stored a-la-carte permissions and interaction approval.
   * YOLO is resolved here (all capabilities on, automatic approval) so no call
   * site duplicates the truth table. Re-read at every gate check, never cached
   * per action, so a settings change cannot leave a stale permit in force.
   */
  private effectivePolicy: EffectiveBrowserPolicy = effectiveBrowserPolicy(DEFAULT_BROWSER_PERMISSIONS, "ask");
  /** Window mode for the next launch; the running session records its own mode. */
  private browserVisible = false;
  readonly limits: Readonly<InteractiveBrowserLimits>;

  constructor(
    private config: WebFetchConfig,
    private readonly dependencies: InteractiveBrowserDependencies = {},
  ) {
    this.resolveHostname = dependencies.resolveHostname ?? defaultHostResolver;
    this.launch = dependencies.launch ?? (async (options) => prepareOwnedBrowser(await chromium.launch(options)));
    this.now = dependencies.now ?? Date.now;
    this.randomHandle = dependencies.randomHandle ?? ((kind) => `browser_${kind}_${randomBytes(24).toString("base64url")}`);
    this.workspaceRoot = resolve(dependencies.workspaceRoot ?? process.cwd());
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

  /**
   * Rebind the live policy. The synchronous part (policy, caps, broker local-
   * network switches, pending-download revocation) applies immediately; the
   * engine-side permission revocations run against each live context and are
   * reported through the returned promise instead of being voided, so a clear
   * that cannot be confirmed — which fails the affected session to contain
   * the retained grants — surfaces to the settings channel with its closure
   * status rather than as a successful apply. The promise never rejects.
   */
  updateConfig(
    config: WebFetchConfig,
    interactionApproval: BrowserInteractionApproval = "ask",
    idleExpiryMinutes: number = 15,
    browserPermissions: WebBrowserPermissions = DEFAULT_BROWSER_PERMISSIONS,
    browserVisible: boolean = false,
    downloadRetention: number = DEFAULT_BROWSER_DOWNLOAD_RETENTION,
  ): Promise<BrowserPermissionRevocationReport> {
    validateIdleExpiryMinutes(idleExpiryMinutes);
    validateDownloadRetention(downloadRetention);
    this.config = config;
    this.effectivePolicy = effectiveBrowserPolicy(browserPermissions, interactionApproval);
    this.browserVisible = browserVisible;
    // A live change only rebinds the cap for the next retention decision; it
    // never cancels or deletes already-retained pending downloads by itself.
    this.downloadRetention = downloadRetention;
    // Issue #27 live network policy: every existing session's broker switches
    // to the current effective local-network permission immediately. Turning
    // it off narrowly closes established connections to now-disallowed local
    // destinations (the broker does that); public connections, ledger history,
    // and the browser process itself are untouched — no restart, no reset.
    const allowLocal = this.effectivePolicy.localNetworks;
    for (const session of this.sessions.values()) {
      if (!session.teardown) session.broker.setLocalNetworksAllowed(allowLocal);
    }
    // Issue #27 live file-transfer policy: revoking model download saving
    // cancels and drops every retained pending download immediately (fail
    // closed). The upload gate is checked at each operation, so no retention
    // exists to revoke there.
    if (!this.effectivePolicy.modelDownloadSaving) {
      for (const session of this.sessions.values()) {
        if (!session.teardown) revokePendingDownloads(session);
      }
    }
    // Issue #27 live permission policy: revoking model clipboard read/write or
    // a device capability (camera/microphone/geolocation, including via YOLO
    // off) removes exactly those manager-issued groups from every live context
    // (fail closed). The composable group map clears only the revoked groups;
    // every other enabled grant stays in force. Session close and controlled
    // replacement discard grants together with their context.
    const revokedGroups: BrowserPermissionGroup[] = [
      ...(this.effectivePolicy.modelClipboard ? [] : [...CLIPBOARD_PERMISSION_GROUPS]),
      ...DEVICE_PERMISSION_GROUPS.filter((entry) => !entry.enabled(this.effectivePolicy)).map((entry) => entry.group),
    ];
    this.idleExpiryMinutes = idleExpiryMinutes;
    for (const lease of this.idleLeases.values()) lease.update(idleExpiryMinutes);
    if (revokedGroups.length === 0) return Promise.resolve({ entries: [] });
    const affected = [...this.sessions.values()];
    return Promise.all(affected.map(async (session): Promise<BrowserPermissionRevocationEntry> => {
      // The mutation tail has no driver-visible timeout of its own (Playwright's
      // permission calls expose none), so bound the wait with the cleanup
      // deadline: a wedged-but-connected browser must delay this save at most
      // that long, and is then reported explicitly — never awaited forever.
      let outcome: BrowserPermissionRevocationOutcome;
      try {
        outcome = await boundedCleanup(
          revokePermissionGrants(session, (error) => this.failSession(session, error), revokedGroups),
          this.limits.cleanupMs,
          "permission revocation",
        );
      } catch (error) {
        // The bounded wait expired while the clear was still in flight: the
        // engine may still hold the revoked groups, so contain them exactly
        // like an unconfirmed clear — fail the owned session through the
        // ordinary teardown machinery instead of leaving a live context with
        // retained authority awaiting manual BrowserClose. The wedged
        // mutation tail itself is never awaited (it could never settle); the
        // bounded closure await below confirms or reports the containment
        // truthfully.
        const reason = bounded(asError(error).message, 200);
        if (!session.teardown && !session.fatalError) {
          this.failSession(session, new Error(`Browser permission revocation did not settle within its deadline (${reason}); the browser session was closed to contain any retained grants.`));
        }
        outcome = { status: "in_flight", reason };
      }
      // An unconfirmed clear or a timed-out wait started its own containment
      // teardown; a superseded revocation observes an in-progress one. Await
      // that bounded confirmation so the save reports the closure status
      // truthfully instead of standing silent over a possibly-unconfirmed
      // cleanup.
      const teardown = session.teardown;
      if (!teardown) return { session: session.handle, outcome };
      let closure: "confirmed" | "unconfirmed";
      try { await teardown; closure = "confirmed"; }
      catch { closure = "unconfirmed"; }
      return { session: session.handle, outcome, closure };
    })).then((entries) => ({ entries }));
  }

  /** Select policy at the approval-required branch, after target restrictions.
   * Automatic approval still issues and consumes the ordinary one-use bound permit.
   * The mode is the effective one: under YOLO it is always automatically-accept,
   * so a stored Ask or Automatically Deny cannot survive the master override.
   */
  private interactionAuthorization(name: string, confirmation?: BrowserInteractionConfirmation): {
    confirm: BrowserInteractionConfirmation;
    source: "human" | "automatic";
  } {
    if (this.effectivePolicy.interactionApproval === "automatically-deny") {
      throw new Error(`${name} not_started: browser interaction approval policy automatically denied this approval-required action.`);
    }
    if (this.effectivePolicy.interactionApproval === "automatically-accept") {
      return { confirm: async () => true, source: "automatic" };
    }
    if (!confirmation) {
      throw new Error(`${name} not_started: this structurally consequential or unknown action requires an interactive Pi confirmation; background or no-UI execution is rejected.`);
    }
    return { confirm: confirmation, source: "human" };
  }

  /**
   * Issue #27 credential capability gates. Checked against the current
   * effective policy at every call site (initial classification and again
   * after post-approval revalidation), so a settings change between them
   * cannot leave a stale permission in force. Detection is structural only:
   * password/credential field presence comes from DOM structure, never from
   * reading or echoing field values.
   */
  private enforceCredentialCapabilities(
    operation: "click" | BrowserFormOperation,
    key: string | undefined,
    structure: BrowserTargetStructure,
  ): void {
    const policy = this.effectivePolicy;
    if (modelActionRequiresCredentialEntry(operation, key, structure) && !policy.modelCredentialEntry) {
      throw new BrowserCapabilityDeniedError("model_credential_entry");
    }
    if (modelActionSubmitsCredentialForm(operation, key, structure) && !policy.modelCredentialSubmission) {
      throw new BrowserCapabilityDeniedError("model_credential_submission");
    }
  }

  async open(url: string, signal?: AbortSignal): Promise<BrowserOpenResult> {
    const result = await this.launchSession({ kind: "open", url, headless: !this.browserVisible }, signal);
    // launchSession returns only BrowserOpenResult for an open plan.
    return result as BrowserOpenResult;
  }

  async launchSession(plan: SessionLaunchPlan, signal?: AbortSignal): Promise<BrowserOpenResult | BrowserVisibilityResult> {
    this.assertAcceptingOperations();
    const existing = this.sessions.values().next().value as Session | undefined;
    if (existing) {
      this.renewIdleLease(existing);
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
    const operation = new OperationDeadline(plan.kind === "open" ? "BrowserOpen" : "BrowserVisibility", this.limits.navigationMs, operationSignal);
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let broker: EgressBroker | undefined;
    let launchPromise: Promise<Browser> | undefined;
    let contextPromise: Promise<BrowserContext> | undefined;
    let resourcesTransferredToSession = false;
    let navigationDispatched = false;
    // Startup stage for structured failure classification; the outcome and
    // every cleanup behavior are unchanged by the classification.
    let stage: BrowserFailurePhase = "url_validation";
    try {
      // This is a no-dial preflight. The broker independently validates and
      // pins the actual browser request before opening its destination socket.
      // Issue #27: local-network destinations are admitted only under the
      // current effective policy (localNetworks or YOLO); default stays public-only.
      // A visibility replacement was already validated per tab against that same
      // effective policy before the old browser closed, so no upfront URL
      // validation happens here for it.
      const requested = plan.kind === "open"
        ? await operation.run(
            validateNavigationUrl(plan.url, this.resolveHostname, { allowLocalNetworks: this.effectivePolicy.localNetworks }),
            "URL validation",
          )
        : undefined;
      stage = "chromium_startup";
      assertChromiumAvailable();
      const auth = {
        username: `pi-browser-${randomBytes(8).toString("hex")}`,
        password: randomBytes(32).toString("base64url"),
      };
      let pendingFatal: ((error: Error) => void) | undefined;
      let pendingSession: Session | undefined;
      let pendingCapacityRefusals = 0;
      // Hard broker refusals remain session-fatal (fail closed). The error is
      // structured so the tool boundary reports the phase and a safe category
      // instead of a generic message that misclassifies the refusal.
      const observer: EgressBrokerObserver = {
        capacityRefusal: () => {
          if (pendingSession) pendingSession.capacityRefusals = Math.min(Number.MAX_SAFE_INTEGER, pendingSession.capacityRefusals + 1);
          else pendingCapacityRefusals = Math.min(Number.MAX_SAFE_INTEGER, pendingCapacityRefusals + 1);
        },
        policyFailure: (_reason, diagnostic, context) => pendingFatal?.(new BrowserFailureError(
          `Interactive browser egress policy failed: ${bounded(diagnostic, 500)}`,
          "broker_admission",
          context?.category ?? "policy_refused",
        )),
      };
      broker = new EgressBroker(
        this.resolveHostname,
        this.dependencies.brokerDial,
        this.brokerBudgets(),
        auth,
        observer,
        // Interactive sessions own the browser lifetime: quiet live ws/wss
        // connections must survive ordinary idle, turns, and reviews. Hard
        // concurrent capacity and teardown still bound owned sockets.
        { enabled: true, liveIdleSocketMs: null },
      );
      stage = "broker_startup";
      const port = await operation.run(broker.start(), "egress broker startup");
      stage = "chromium_startup";
      launchPromise = this.launch({
        headless: plan.headless,
        timeout: operation.remainingMs(),
        args: interactiveChromiumArgs(port),
        proxy: { server: `http://127.0.0.1:${port}`, username: auth.username, password: auth.password },
      });
      browser = await operation.run(launchPromise, "Chromium startup");
      stage = "context_creation";
      // Capture the launch-pinned service-worker mode ONCE: the mode the
      // context is created with is also what the session records, so a
      // settings save landing anywhere in this startup window stays a
      // detectable mismatch for applyVisibility instead of being masked by a
      // re-read of the newer effective policy.
      const pinnedServiceWorkers: "allow" | "block" = this.effectivePolicy.modelServiceWorkers ? "allow" : "block";
      contextPromise = browser.newContext({
        // Issue #27: downloads are staged in Playwright's private temporary
        // storage so the manager can decide per download. The default policy
        // is still denial: while modelDownloadSaving is off, the listener
        // below cancels every download before any bytes persist to a path the
        // model or page could influence.
        acceptDownloads: true,
        javaScriptEnabled: true,
        viewport: { width: 1_280, height: 720 },
        deviceScaleFactor: 1,
        // Issue #27: the service-worker policy is pinned at context creation
        // by Playwright/Chromium; modelServiceWorkers (or YOLO) allows them.
        // A live transition cannot flip this in place — applyVisibility
        // performs the controlled replacement instead. Default stays blocked.
        serviceWorkers: pinnedServiceWorkers,
        permissions: [],
        userAgent: this.config.userAgent,
        // Memory-only session state replay for a visibility replacement: the
        // captured object never touches disk and dies with this process.
        ...(plan.kind === "visibility" && plan.restore.storageState ? { storageState: plan.restore.storageState } : {}),
      });
      context = await operation.run(contextPromise, "browser context creation");
      context.setDefaultTimeout(this.limits.actionMs);
      context.setDefaultNavigationTimeout(this.limits.navigationMs);
      await operation.run(context.clearPermissions(), "permission denial");
      await operation.run(installRoutePolicy(context, broker, (request, reason) => {
        if (pendingSession) {
          const session = pendingSession;
          this.tabDiagnostics.policyBlocked(session, (page) => this.tabForPage(session, page), request, reason);
        }
      }), "network route policy installation");

      // Detectable genuine human input renews the idle lease (issue #22):
      // each tab gets a browser-owned isolated-world detector whose trusted
      // pointer/key/wheel signals are HMAC-authenticated manager-side. See
      // browser-human-input.ts.
      const humanInputVerifier = new HumanInputVerifier(randomBytes(32).toString("hex"));

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
        consoleDiagnostics: new DiagnosticRing(this.limits.maxConsoleEvents, this.consoleQuota),
        networkDiagnostics: new DiagnosticRing(this.limits.maxNetworkEvents, this.networkQuota),
        networkStartedAt: new WeakMap(),
        networkPolicy: new WeakMap(),
      };
      const session: Session = {
        handle: this.uniqueHandle("session"),
        activeTab: primaryTab.handle,
        tabs: new Map([[primaryTab.handle, primaryTab]]),
        pendingPageClosures: new Map(),
        pendingPageCreations: new Set(),
        restoreCreationArmed: false,
        deferredRestorePages: [],
        pendingWebSocketAdmissions: new Set(),
        admissionAbort: new AbortController(),
        browser,
        context,
        broker,
        capacityRefusals: pendingCapacityRefusals,
        createdAt: this.now(),
        navigations: 0,
        actions: 0,
        mainDocumentRequests: 0,
        operationActive: true,
        visible: !plan.headless,
        serviceWorkers: pinnedServiceWorkers,
        humanInputVerifier,
        pendingDownloads: new Map(),
        permissionGrants: new Map(),
        permissionGrantTail: Promise.resolve(),
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
        // Issue #27 integration: while a visibility-restore page creation is
        // in flight, an arriving unowned page cannot yet be identity-checked
        // against the manager's own creation. Defer it instead of adopting or
        // refusing it so a page-created popup racing the restore creation can
        // never steal the scoped restore admission; settleDeferredRestorePages
        // re-evaluates it under the ordinary popup policy when the window
        // closes.
        if (session.restoreCreationArmed) {
          session.deferredRestorePages.push(candidate);
          return;
        }
        this.evaluateUnownedPage(session, candidate);
      });
      this.sessions.set(session.handle, session);
      // A settings save can land while Chromium is starting (before this
      // session was visible to updateConfig): re-apply the current effective
      // policy so this broker can never run a stale local-network opt-in.
      broker.setLocalNetworksAllowed(this.effectivePolicy.localNetworks);
      this.startIdleLease(session);
      resourcesTransferredToSession = true;
      try {
        if (plan.kind === "open") {
          const navigation = await this.navigateSession(session, primaryTab, requested!.href, operation, true, () => {
            navigationDispatched = true;
          });
          session.operationActive = false;
          this.renewIdleLease(session);
          return this.protectOutput({ ...navigation, limits: this.limits });
        }
        const restoreResult = await restoreVisibilityTabs(session, primaryTab, plan.restore, {
          limits: this.limits,
          navigate: (restoreSession, restoreTab, href, deadline, isPrimaryTab, onDispatch) =>
            this.navigateSession(restoreSession as Session, restoreTab as BrowserTab, href, deadline, isPrimaryTab, onDispatch),
          tabForPage: (restoreSession, page) => this.tabForPage(restoreSession as Session, page),
          adoptPage: (restoreSession, page, popup, restoringOwnedTab) => this.adoptPage(restoreSession as Session, page, popup, restoringOwnedTab),
          settleDeferredRestorePages: (restoreSession) => this.settleDeferredRestorePages(restoreSession as Session),
          containRefusedPage: (restoreSession, page, label) => this.containRefusedPage(restoreSession as Session, page, label),
          trackLatePageCreation: (restoreSession, creation, label) => this.trackLatePageCreation(restoreSession as Session, creation, label),
          reapplyCarriedPermissionGrants: (restoreSession, restore) => reapplyCarriedPermissionGrants(
            restoreSession as Session,
            () => this.effectivePolicy,
            restore,
            (error) => this.failSession(restoreSession as Session, error),
          ),
          foregroundRestoredTab: (_restoreSession, handle) => boundedCleanup(
            session.tabs.get(handle)!.page.bringToFront(),
            this.limits.actionMs,
            "active tab foreground",
          ),
        }, operationSignal, () => {
          navigationDispatched = true;
        });
        session.operationActive = false;
        this.renewIdleLease(session);
        return this.protectOutput(restoreResult);
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
      if (error instanceof BrowserOwnershipError) {
        this.recordOpeningTeardownFailure(opening, error);
        throw unconfirmedOpenCleanupError();
      }
      if (cancellation) throw openCancellationError(cancellation, navigationDispatched);
      // After resource transfer the inner catch already confirmed teardown and
      // rethrew the typed navigation failure; classify startup-stage failures
      // only, preserving every cleanup outcome above.
      if (resourcesTransferredToSession) throw error;
      throw classifySetupFailure(asError(error), stage);
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
          throw new BrowserCaptureInvalidatedError("Browser document changed during semantic snapshot capture; snapshot rejected.");
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
    this.noteToolActivity(sessionHandle);
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
          throw new BrowserCaptureInvalidatedError("Browser document changed during semantic detail read; result rejected.");
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
    this.noteToolActivity(sessionHandle);
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
        brokerCapacityRefusals: session.capacityRefusals,
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
    options?: { viewport?: { width: number; height: number } },
  ): Promise<BrowserScreenshotResult> {
    this.noteToolActivity(sessionHandle);
    if (mode !== "viewport" && mode !== "element") {
      throw new Error("BrowserScreenshot mode must be viewport or element.");
    }
    if (mode === "element" && options?.viewport) {
      throw new BrowserValidationError("BrowserScreenshot viewport dimensions apply only to viewport mode.");
    }
    const { session, tab } = this.requireTab(sessionHandle, tabHandle);
    return this.operate(session, signal, async (operationSignal) => {
      const operation = new OperationDeadline("BrowserScreenshot", this.limits.actionMs, operationSignal);
      let resized = false;
      let restored = false;
      let priorViewport: { width: number; height: number } | null | undefined;
      try {
        const capturedGeneration = tab.generation;
        let image: Buffer;
        let requestedViewport: { width: number; height: number } | undefined;
        if (mode === "viewport") {
          if (ref !== undefined) throw new BrowserValidationError("BrowserScreenshot viewport mode does not accept ref.");
          requestedViewport = options?.viewport ?? { width: DEFAULT_VIEWPORT_WIDTH, height: DEFAULT_VIEWPORT_HEIGHT };
          assertViewportScreenshotDimensions(requestedViewport, this.limits);
          priorViewport = tab.page.viewportSize();
          if (!priorViewport) throw new Error("BrowserScreenshot could not determine the bounded browser viewport.");
          if (priorViewport.width !== requestedViewport.width || priorViewport.height !== requestedViewport.height) {
            // Issue #141: the requested dimensions are applied only for this
            // capture. Responsive elements really render at this size, and
            // the prior viewport is restored in every path below, including
            // validation failures and cancellation.
            await operation.run(
              tab.page.setViewportSize({ width: requestedViewport.width, height: requestedViewport.height }),
              "viewport resize for capture",
            );
            resized = true;
          }
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
          throw new BrowserCaptureInvalidatedError("Browser document changed during screenshot capture; screenshot rejected.");
        }
        if (mode === "viewport" && requestedViewport) {
          // Establish/replace the coordinate-click reference only after the
          // capture, validation, and generation recheck all succeeded, and
          // only after the prior viewport has been truthfully restored. The
          // restore itself failing rejects the whole capture fail-closed.
          if (resized) {
            try {
              await operation.run(
                tab.page.setViewportSize({ width: priorViewport!.width, height: priorViewport!.height }),
                "viewport restore after capture",
              );
            } catch {
              throw new Error("BrowserScreenshot captured the viewport but could not restore the prior viewport; the capture is rejected and the session is contained.");
            }
            restored = true;
          }
          tab.viewportScreenshot = {
            generation: capturedGeneration,
            origin: interactionIdentityUrl(tab.page.url()),
            width: requestedViewport.width,
            height: requestedViewport.height,
          };
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
        // Failure/cancellation path: best-effort restore of the prior viewport.
        // Cancellation and fatal containment close the page anyway, so a
        // skipped restore there leaves no live state behind; a live failure
        // still attempts the restore without claiming any rollback of the
        // failed operation itself.
        if (resized && !restored) {
          try {
            if (priorViewport && !operation.signal.aborted && !tab.page.isClosed()) {
              await boundedCleanup(
                tab.page.setViewportSize({ width: priorViewport.width, height: priorViewport.height }),
                this.limits.cleanupMs,
                "viewport restore after failed capture",
              );
            }
          } catch {
            // Restore failure after an already-failed capture cannot be acted
            // on without claiming rollback; the operation's own error above
            // remains authoritative.
          }
        }
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
    this.noteToolActivity(sessionHandle);
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
    ref: string | undefined,
    confirmation?: BrowserClickConfirmation,
    signal?: AbortSignal,
    options?: { button?: BrowserClickButton; x?: number; y?: number },
  ): Promise<BrowserInteractionResult> {
    try {
      this.noteToolActivity(sessionHandle);
      const button = normalizeBrowserClickButton(options?.button);
      if (options?.x !== undefined || options?.y !== undefined) {
        if (ref !== undefined) {
          throw new BrowserValidationError("not_started: BrowserClick accepts either a current ref or screenshot coordinates, not both.");
        }
        const x = options.x;
        const y = options.y;
        if ((x === undefined) !== (y === undefined)) {
          throw new BrowserValidationError("not_started: BrowserClick coordinates require both x and y.");
        }
        assertCoordinateClickInput(x!, y!);
        return await this.clickCoordinates(sessionHandle, tabHandle, x!, y!, this.privateConfirmation(confirmation), signal, button);
      }
      if (ref === undefined) {
        throw new BrowserValidationError("not_started: BrowserClick requires ref, or x and y screenshot coordinates.");
      }
      return await this.interact(sessionHandle, tabHandle, ref, "click", this.privateConfirmation(confirmation), signal, button);
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
      this.noteToolActivity(sessionHandle);
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
      this.noteToolActivity(sessionHandle);
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
      this.noteToolActivity(sessionHandle);
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
      this.noteToolActivity(sessionHandle);
      const normalizedKey = normalizeBrowserPressKey(key);
      return await this.formInteract(sessionHandle, tabHandle, ref, { operation: "press", values: [], key: normalizedKey }, confirmation, signal);
    } catch (error) {
      throw normalizedInteractionFailure("BrowserPress", error);
    }
  }

  /**
   * Issue #27 model file upload. The model explicitly selects the source
   * paths; the page only supplies the file-input target and never sees or
   * chooses the sources. Sources are verified to regular files (real path,
   * size, mtime) before any approval, bound into the single-use permit digest,
   * and re-verified after approval. Dispatch is one bounded setInputFiles call;
   * file bytes never enter tool results, logs, or snapshots.
   */
  async upload(
    sessionHandle: string,
    tabHandle: string,
    ref: string,
    files: readonly string[],
    confirmation?: BrowserInteractionConfirmation,
    signal?: AbortSignal,
  ): Promise<BrowserInteractionResult> {
    const name = "BrowserUpload";
    confirmation = this.privateConfirmation(confirmation);
    try {
      this.noteToolActivity(sessionHandle);
      assertBoundedInteractionCapability(sessionHandle, BROWSER_INTERACTION_SESSION_MAX_CHARS);
      assertBoundedInteractionCapability(tabHandle, BROWSER_INTERACTION_TAB_MAX_CHARS);
      assertBoundedInteractionCapability(ref, BROWSER_INTERACTION_REF_MAX_CHARS);
      const { session, tab } = this.requireTab(sessionHandle, tabHandle);
      return await this.operate(session, signal, async (operationSignal) => {
        const operation = new OperationDeadline(name, this.limits.confirmationMs, operationSignal);
        const capturedGeneration = tab.generation;
        const capturedOrigin = interactionIdentityUrl(tab.page.url());
        let started = false;
        let capture: InteractionCapture | undefined;
        try {
          // Issue #27 capability gate fails fast before any approval prompt:
          // a disabled model upload permission is not an approval question.
          enforceFileTransferCapability(this.effectivePolicy, "model_uploads");
          const sources = await validateUploadSources(files, this.workspaceRoot);
          let locator = this.currentRefLocator(tab, ref);
          await operation.run(locator.waitFor({ state: "visible", timeout: operation.remainingMs() }), "semantic target validation");
          const structure = await operation.run(readTargetStructure(locator, tab.page, { includeFileInputs: true }), "structural consequence inspection");
          assertUploadTarget(structure, sources.files.length);
          // Uploads are always consequential: host file bytes leave the machine.
          const authorization = this.interactionAuthorization(name, confirmation);
          const binding = uploadConfirmationBinding(
            { session: session.handle, tab: tab.handle, generation: tab.generation },
            ref, capturedOrigin, sources.realPaths, this.consequencePolicy.fingerprint(structure),
          );
          const permit = this.confirmationPermits.issue(binding);
          let approved = false;
          try {
            approved = await operation.run(
              authorization.confirm(uploadConfirmationPrompt(capturedOrigin, sources)),
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
          let approval: BrowserInteractionResult["approval"];
          try {
            throwIfAborted(operation.signal);
            if (session.teardown || session.fatalError || tab.page.isClosed()) {
              throw new Error(`${name} not_started: the browser session changed or closed after approval.`);
            }
            if (tab.generation !== capturedGeneration || interactionIdentityUrl(tab.page.url()) !== capturedOrigin) {
              this.invalidateInteractionRefs(tab, capturedGeneration);
              throw new Error(`${name} not_started: the document or origin changed after approval; take a fresh BrowserSnapshot.`);
            }
            // Re-check the capability against the current effective policy:
            // a settings change during the approval prompt must not leave a
            // stale permission in force for the pending permit.
            enforceFileTransferCapability(this.effectivePolicy, "model_uploads");
            locator = this.currentRefLocator(tab, ref);
            const revalidatedStructure = await operation.run(readTargetStructure(locator, tab.page, { includeFileInputs: true }), "post-approval target revalidation");
            assertUploadTarget(revalidatedStructure, sources.files.length);
            const revalidatedSources = await revalidateUploadSources(sources);
            const rebound = uploadConfirmationBinding(
              { session: session.handle, tab: tab.handle, generation: tab.generation },
              ref, capturedOrigin, revalidatedSources.realPaths, this.consequencePolicy.fingerprint(revalidatedStructure),
            );
            if (!this.confirmationPermits.consume(permit, rebound)) {
              this.invalidateInteractionRefs(tab, capturedGeneration);
              throw new Error(`${name} not_started: the approved target or source files changed; take a fresh BrowserSnapshot.`);
            }
            approval = authorization.source;
          } catch (error) {
            // Revocation is harmless after consume and guarantees every
            // approval path is single-use even when re-resolution fails.
            this.confirmationPermits.revoke(permit);
            throw error;
          }
          capture = newInteractionCapture();
          session.interactionCapture = capture;
          started = true;
          await operation.run(locator.setInputFiles(sources.realPaths, { timeout: operation.remainingMs() }), "bounded upload dispatch");
          const accounting = await accountInteractionEffects(capture, operation);
          if (session.fatalError) throw session.fatalError;
          const navigated = tab.generation !== capturedGeneration || interactionIdentityUrl(tab.page.url()) !== capturedOrigin;
          this.invalidateInteractionRefs(tab, capturedGeneration);
          return {
            ...interactionResult(
              { session: session.handle, tab: tab.handle, generation: tab.generation, url: redactedInteractionUrl(tab.page.url()) },
              "upload", "file_upload", approval, capture, accounting, navigated,
            ),
            uploadedFiles: sources.files.length,
            uploadedBytes: sources.totalBytes,
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
    } catch (error) {
      throw normalizedInteractionFailure(name, error);
    }
  }

  /**
   * Issue #27 model clipboard read/write (text only). The capability gate is
   * checked before any approval prompt and re-checked against the current
   * effective policy after approval, so a settings change between them cannot
   * leave a stale permission in force. The manager then issues a real
   * per-origin Playwright permission grant for the exact origin of the
   * approved operation — never a context-wide or cross-session capability —
   * and dispatches one fixed internal navigator.clipboard text call. The page
   * never sees or chooses the written value, and untrusted page content can
   * neither grant nor toggle this capability. Headless Chromium operates on
   * its per-instance virtual clipboard; headed desktop Chromium reaches the
   * host system clipboard — the result reports which scope was used.
   */
  async clipboard(
    sessionHandle: string,
    tabHandle: string,
    operation: BrowserClipboardOperation,
    text: string | undefined,
    confirmation?: BrowserInteractionConfirmation,
    signal?: AbortSignal,
  ): Promise<BrowserClipboardResult> {
    const name = "BrowserClipboard";
    confirmation = this.privateConfirmation(confirmation);
    try {
      this.noteToolActivity(sessionHandle);
      assertBoundedInteractionCapability(sessionHandle, BROWSER_INTERACTION_SESSION_MAX_CHARS);
      assertBoundedInteractionCapability(tabHandle, BROWSER_INTERACTION_TAB_MAX_CHARS);
      if (operation === "clipboard_write") assertExactText(text, BROWSER_CLIPBOARD_WRITE_MAX_CHARS, false);
      const { session, tab } = this.requireTab(sessionHandle, tabHandle);
      return await this.operate(session, signal, async (operationSignal) => {
        const op = new OperationDeadline(name, this.limits.confirmationMs, operationSignal);
        const capturedGeneration = tab.generation;
        let capturedUrl: string;
        try {
          capturedUrl = interactionIdentityUrl(tab.page.url());
        } catch {
          throw new Error(`${name} not_started: the browser clipboard requires an HTTP(S) page origin; this tab is not on one, so no clipboard operation was attempted.`);
        }
        // Permission grants and approval bindings are per-origin; the full
        // document URL stays the identity that must survive until dispatch.
        const capturedOrigin = new URL(capturedUrl).origin;
        let started = false;
        try {
          // Issue #27 capability gate fails fast before any approval prompt:
          // a disabled model clipboard permission is not an approval question.
          enforceClipboardCapability(this.effectivePolicy);
          const valueDigest = operation === "clipboard_write" ? digestExactValues([text!]) : null;
          const valueLengths = operation === "clipboard_write" ? [text!.length] : [];
          // Clipboard operations are always consequential: the clipboard can
          // carry credentials or other secrets between applications.
          const authorization = this.interactionAuthorization(name, confirmation);
          const binding = clipboardConfirmationBinding(
            { session: session.handle, tab: tab.handle, generation: tab.generation },
            capturedOrigin, operation, valueDigest, valueLengths,
          );
          const permit = this.confirmationPermits.issue(binding);
          let approved = false;
          try {
            approved = await op.run(
              authorization.confirm(clipboardConfirmationPrompt(operation, capturedOrigin, text === undefined ? null : text.length)),
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
          let approval: "human" | "automatic";
          try {
            throwIfAborted(op.signal);
            if (session.teardown || session.fatalError || tab.page.isClosed()) {
              throw new Error(`${name} not_started: the browser session changed or closed after approval.`);
            }
            if (tab.generation !== capturedGeneration || interactionIdentityUrl(tab.page.url()) !== capturedUrl) {
              throw new Error(`${name} not_started: the document or origin changed after approval; take a fresh BrowserSnapshot and retry.`);
            }
            // Re-check the capability against the current effective policy:
            // a settings change during the approval prompt must not leave a
            // stale permission in force for the pending permit.
            enforceClipboardCapability(this.effectivePolicy);
            const rebound = clipboardConfirmationBinding(
              { session: session.handle, tab: tab.handle, generation: tab.generation },
              capturedOrigin, operation, valueDigest, valueLengths,
            );
            if (!this.confirmationPermits.consume(permit, rebound)) {
              throw new Error(`${name} not_started: the approved clipboard target or content changed.`);
            }
            approval = authorization.source;
          } catch (error) {
            // Revocation is harmless after consume and guarantees every
            // approval path is single-use even when re-resolution fails.
            this.confirmationPermits.revoke(permit);
            throw error;
          }
          const group = operation === "clipboard_read" ? "clipboard_read" : "clipboard_write";
          await op.run(ensureClipboardGrant(session, capturedOrigin, group), "clipboard permission grant");
          // A settings revocation can land during the grant round-trip, after
          // updateConfig's own revoke already snapshotted the map (and no-oped
          // if this grant was the session's first). Re-check against the live
          // policy; on denial drop every clipboard group and reconcile so the
          // engine matches the bookkeeping exactly. started stays false, so
          // this remains a precise not_started denial without teardown.
          try {
            enforceClipboardCapability(this.effectivePolicy);
          } catch (error) {
            const outcome = await revokePermissionGrants(session, (error) => this.failSession(session, error), CLIPBOARD_PERMISSION_GROUPS);
            // A failed engine clear fails the session to contain the retained
            // grants; whether this call's revocation or a queued one hit it,
            // the denial must carry the containment status instead of looking
            // like an ordinary capability denial on a live session.
            if (outcome.status === "unconfirmed" || session.fatalError) {
              let containment = "confirmed";
              try { await this.failAndWait(session, session.fatalError!); }
              catch { containment = "unconfirmed"; }
              const detail = outcome.status === "unconfirmed"
                ? `Browser permission revocation could not be confirmed on the live context (${outcome.reason}), so the session was closed to contain the retained grants.`
                : `The browser session failed while its permission revocation was being applied (${bounded(asError(session.fatalError!).message, 300)}).`;
              throw new Error(`${name} not_started: ${asError(error).message} ${detail} Session teardown is ${containment}.`);
            }
            throw error;
          }
          started = true;
          const base = {
            session: session.handle,
            tab: tab.handle,
            generation: tab.generation,
            operation,
            consequence: (operation === "clipboard_read" ? "clipboard_read" : "clipboard_write") as BrowserConsequence,
            confirmed: approval === "human",
            approval,
            clipboardScope: (session.visible ? "host-system" : "browser-internal") as BrowserClipboardScope,
            url: redactedInteractionUrl(capturedOrigin),
          };
          if (operation === "clipboard_read") {
            const outcome = await op.run(tab.page.evaluate(CLIPBOARD_READ_SCRIPT), "bounded clipboard read");
            if (session.fatalError) throw session.fatalError;
            if (!outcome.ok) throw new BrowserClipboardOutcomeError(clipboardUnavailableError("read", outcome.reason));
            // The page is untrusted: a shadowed navigator.clipboard can
            // resolve with anything. A non-string result is an effect-free
            // protocol failure, not an uncertain dispatch — report it
            // precisely and keep the session alive.
            if (typeof outcome.text !== "string") throw new BrowserClipboardOutcomeError(clipboardUnavailableError("read", "failed"));
            const raw = outcome.text;
            const truncated = raw.length > BROWSER_CLIPBOARD_READ_MAX_CHARS;
            return { ...base, text: truncated ? raw.slice(0, BROWSER_CLIPBOARD_READ_MAX_CHARS) : raw, truncated, originalChars: raw.length };
          }
          const outcome = await op.run(tab.page.evaluate(CLIPBOARD_WRITE_SCRIPT, text!), "bounded clipboard write dispatch");
          if (session.fatalError) throw session.fatalError;
          if (!outcome.ok) throw new BrowserClipboardOutcomeError(clipboardUnavailableError("write", outcome.reason));
          return { ...base, writtenChars: text!.length };
        } catch (error) {
          // A completed page-reported outcome proved the effect-free result
          // and is rethrown precisely; only a dispatch that never reported
          // back is uncertain and contained.
          if (!started || error instanceof BrowserClipboardOutcomeError) throw error;
          const failure = new Error(`${name} failed after dispatch; effect status is unknown and no rollback is claimed.`);
          let containment = "confirmed";
          try { await this.failAndWait(session, failure); }
          catch { containment = "unconfirmed"; }
          throw new Error(`${failure.message} Session teardown is ${containment}.`);
        } finally {
          op.dispose();
        }
      });
    } catch (error) {
      throw normalizedInteractionFailure(name, error);
    }
  }

  /**
   * Issue #27 observation-only listing of the pending downloads retained for
   * one owned tab. No capability gate and no approval: it reports handles and
   * bounded untrusted metadata only, never bytes. Handles are scoped to the
   * owning session and tab; other tabs' downloads are invisible.
   */
  async listDownloads(sessionHandle: string, tabHandle: string): Promise<BrowserDownloadListResult> {
    const name = "BrowserDownloadSave";
    try {
      this.noteToolActivity(sessionHandle);
      assertBoundedInteractionCapability(sessionHandle, BROWSER_INTERACTION_SESSION_MAX_CHARS);
      assertBoundedInteractionCapability(tabHandle, BROWSER_INTERACTION_TAB_MAX_CHARS);
      const { session, tab } = this.requireTab(sessionHandle, tabHandle);
      return {
        session: session.handle,
        tab: tab.handle,
        generation: tab.generation,
        downloads: [...session.pendingDownloads.values()]
          .filter((record) => record.tab === tab.handle)
          .map((record) => ({
            handle: record.handle,
            suggestedFilename: record.suggestedFilename,
            url: record.url,
            state: record.state,
          })),
      };
    } catch (error) {
      throw normalizedInteractionFailure(name, error);
    }
  }

  /**
   * Issue #27 model download saving. The pending download was retained by the
   * manager (capability on at event time); saving it still requires the
   * current capability gate plus the interaction-approval policy. The
   * destination is explicitly chosen by the model and eligible wherever the
   * model's existing host write authority reaches (relative paths resolve to
   * the session working directory; absolute paths are not fenced by the
   * browser). It is verified (real path, existence) before approval and
   * re-verified after approval, so the exact real destination is what the
   * approval binds to; page-suggested filenames never choose it. Actual
   * platform/role write restrictions are enforced by the filesystem at stage
   * and commit time and reported honestly.
   */
  async saveDownload(
    sessionHandle: string,
    tabHandle: string,
    downloadHandle: string,
    destination: string,
    confirmation?: BrowserInteractionConfirmation,
    signal?: AbortSignal,
  ): Promise<BrowserInteractionResult> {
    const name = "BrowserDownloadSave";
    confirmation = this.privateConfirmation(confirmation);
    try {
      this.noteToolActivity(sessionHandle);
      assertBoundedInteractionCapability(sessionHandle, BROWSER_INTERACTION_SESSION_MAX_CHARS);
      assertBoundedInteractionCapability(tabHandle, BROWSER_INTERACTION_TAB_MAX_CHARS);
      assertBoundedInteractionCapability(downloadHandle, BROWSER_INTERACTION_REF_MAX_CHARS);
      const { session, tab } = this.requireTab(sessionHandle, tabHandle);
      // Session and tab ownership: a handle only resolves in the session that
      // retained it, on the exact tab whose download event created it.
      const record = session.pendingDownloads.get(downloadHandle);
      if (!record || record.tab !== tab.handle) throw invalidDownloadHandleError();
      const destinationFacts = await resolveSaveDestination(destination, this.workspaceRoot);
      return await this.operate(session, signal, async (operationSignal) => {
        const operation = new OperationDeadline(name, this.limits.confirmationMs, operationSignal);
        let started = false;
        try {
          // Issue #27 capability gate fails fast before any approval prompt.
          enforceFileTransferCapability(this.effectivePolicy, "model_download_saving");
          // A save is only meaningful for a completed download: wait (bounded)
          // for completion before the approval prompt so the human approves
          // the exact artifact that will be written.
          await waitForDownloadCompletion(record, operation);
          const authorization = this.interactionAuthorization(name, confirmation);
          const binding = downloadSaveBinding(
            { session: session.handle, tab: tab.handle, generation: tab.generation },
            record, destinationFacts,
          );
          const permit = this.confirmationPermits.issue(binding);
          let approved = false;
          try {
            approved = await operation.run(
              authorization.confirm(downloadSaveConfirmationPrompt(record, destinationFacts)),
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
          let approval: BrowserInteractionResult["approval"];
          try {
            throwIfAborted(operation.signal);
            if (session.teardown || session.fatalError || tab.page.isClosed()) {
              throw new Error(`${name} not_started: the browser session changed or closed after approval.`);
            }
            // Re-check the capability against the current effective policy.
            enforceFileTransferCapability(this.effectivePolicy, "model_download_saving");
            if (session.pendingDownloads.get(record.handle) !== record || record.state !== "completed") {
              throw new Error(`${name} not_started: the approved download is no longer retained or completed.`);
            }
            const revalidatedDestination = await resolveSaveDestination(destination, this.workspaceRoot);
            if (revalidatedDestination.real !== destinationFacts.real || revalidatedDestination.existed !== destinationFacts.existed) {
              throw new Error(`${name} not_started: the approved destination changed after approval.`);
            }
            const rebound = downloadSaveBinding(
              { session: session.handle, tab: tab.handle, generation: tab.generation },
              record, destinationFacts,
            );
            if (!this.confirmationPermits.consume(permit, rebound)) {
              throw new Error(`${name} not_started: the approved download or destination changed.`);
            }
            approval = authorization.source;
          } catch (error) {
            this.confirmationPermits.revoke(permit);
            throw error;
          }
          // Stage into a private same-directory temp file first: every failure
          // here wrote nothing to the destination and is reported not_started.
          const staged = await operation.run(stageSaveArtifact(record, destinationFacts), "save artifact staging");
          if (destinationFacts.existed) {
            // An approved replacement commits with rename(2); a failed rename
            // can be indeterminate on exotic filesystems, so from here a
            // failure is treated as a possible post-dispatch effect. A new
            // file commits with link(2), which creates nothing when it fails.
            started = true;
          }
          const savedBytes = await operation.run(commitSaveTarget(staged, destinationFacts), "atomic save commit");
          // The artifact is now persisted where the model asked: release the
          // private staged copy so no duplicate bytes remain.
          session.pendingDownloads.delete(record.handle);
          await operation.run(Promise.resolve().then(() => releasePendingDownload(record)), "staged artifact release");
          if (session.fatalError) throw session.fatalError;
          // No page dispatch occurred for the local copy, so there are no
          // pending page effects to observe; the bounded-stable accounting is
          // truthful without an observation window.
          const result = interactionResult(
            { session: session.handle, tab: tab.handle, generation: tab.generation, url: redactedInteractionUrl(tab.page.url()) },
            "download_save", "file_download_save", approval, newInteractionCapture(), "bounded_stable", false,
          );
          return { ...result, savedDestination: destinationFacts.real, savedBytes };
        } catch (error) {
          if (!started) throw error;
          const failure = new Error(`${name} failed after dispatch; effect status is unknown and no rollback is claimed.`);
          let containment = "confirmed";
          try { await this.failAndWait(session, failure); }
          catch { containment = "unconfirmed"; }
          throw new Error(`${failure.message} Session teardown is ${containment}.`);
        } finally {
          operation.dispose();
        }
      });
    } catch (error) {
      throw normalizedInteractionFailure(name, error);
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
          const structure = await operation.run(readTargetStructure(locator, tab.page, { includeCredentialTargets: true }), "structural consequence inspection");
          assertSuitableFormTarget(structure, action.operation);
          // Issue #27 capability gates fail fast before any approval prompt: a
          // disabled model credential permission is not an approval question.
          this.enforceCredentialCapabilities(action.operation, action.key, structure);
          let selectedKinds: Array<"value" | "label"> | undefined;
          const decision = this.consequencePolicy.classifyForm(structure, { operation: action.operation, key: action.key });
          let approval: BrowserInteractionResult["approval"] = "not_required";
          const originalFingerprint = this.consequencePolicy.fingerprint(structure);

          if (decision.consequential) {
            const authorization = this.interactionAuthorization(name, confirmation);
            const binding = formConfirmationBinding(
              { session: session.handle, tab: tab.handle, generation: tab.generation },
              ref, capturedOrigin, decision.consequence, decision.destination, action.operation,
              valueDigest, valueLengths, action.key ?? null,
              this.consequencePolicy.fingerprint(structure),
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
              const revalidatedStructure = await operation.run(readTargetStructure(locator, tab.page, { includeCredentialTargets: true }), "post-approval target revalidation");
              assertSuitableFormTarget(revalidatedStructure, action.operation);
              const revalidatedDecision = this.consequencePolicy.classifyForm(revalidatedStructure, { operation: action.operation, key: action.key });
              // Re-check the capability gates against the current effective
              // policy: a settings change during the approval prompt must not
              // leave a stale permission in force for the pending permit.
              this.enforceCredentialCapabilities(action.operation, action.key, revalidatedStructure);
              const rebound = formConfirmationBinding(
                { session: session.handle, tab: tab.handle, generation: tab.generation },
                ref, capturedOrigin, revalidatedDecision.consequence, revalidatedDecision.destination, action.operation,
                valueDigest, valueLengths, action.key ?? null,
                this.consequencePolicy.fingerprint(revalidatedStructure),
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
            const revalidatedStructure = await operation.run(readTargetStructure(locator, tab.page, { includeCredentialTargets: true }), "safe-target revalidation");
            assertSuitableFormTarget(revalidatedStructure, action.operation);
            const revalidatedDecision = this.consequencePolicy.classifyForm(revalidatedStructure, { operation: action.operation, key: action.key });
            // Gated actions classify consequential today; keep the check here
            // too so a future classification change cannot dispatch around it.
            this.enforceCredentialCapabilities(action.operation, action.key, revalidatedStructure);
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
          return interactionResult(
            { session: session.handle, tab: tab.handle, generation: tab.generation, url: redactedInteractionUrl(tab.page.url()) },
            action.operation, decision.consequence, approval, capture, accounting, navigated,
          );
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
    button: BrowserClickButton = "left",
  ): Promise<BrowserInteractionResult> {
    this.noteToolActivity(sessionHandle);
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
        const decision = this.consequencePolicy.classify(structure, button);
        let approval: BrowserInteractionResult["approval"] = "not_required";

        if (operationName === "click") {
          // Issue #27 capability gate fails fast before any approval prompt:
          // a disabled model credential permission is not an approval question.
          this.enforceCredentialCapabilities("click", undefined, structure);
        }

        if (operationName === "click" && decision.consequential) {
          const authorization = this.interactionAuthorization(name, confirmation);
          const binding = confirmationBinding(
            { session: session.handle, tab: tab.handle, generation: tab.generation },
            ref, capturedOrigin, decision.consequence, decision.destination, button,
            this.consequencePolicy.fingerprint(structure),
          );
          const permit = this.confirmationPermits.issue(binding);
          let approved = false;
          try {
            approved = await operation.run(authorization.confirm(confirmationPrompt(decision.consequence, capturedOrigin, decision.destination, button)), "interaction approval");
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
            const revalidatedDecision = this.consequencePolicy.classify(revalidatedStructure, button);
            // Re-check the capability gates against the current effective
            // policy: a settings change during the approval prompt must not
            // leave a stale permission in force for the pending permit.
            this.enforceCredentialCapabilities("click", undefined, revalidatedStructure);
            const rebound = confirmationBinding(
              { session: session.handle, tab: tab.handle, generation: tab.generation },
              ref,
              capturedOrigin,
              revalidatedDecision.consequence,
              revalidatedDecision.destination,
              button,
              this.consequencePolicy.fingerprint(revalidatedStructure),
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
          const revalidatedDecision = this.consequencePolicy.classify(revalidatedStructure, button);
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
        } else if (decision.consequence === "ordinary_navigation" && decision.destination && button !== "right") {
          // Do not dispatch page-controlled click listeners for a silent link.
          // Activate the freshly revalidated HTTP(S) destination through the
          // existing brokered navigation path instead. A right-click never takes
          // this shortcut: it is always consequential and dispatched as a real
          // Playwright right-click so page contextmenu handlers can run.
          await this.navigateSession(session, tab, decision.destination, operation, false);

        } else if (button === "right") {
          await operation.run(locator.click({ button: "right", timeout: operation.remainingMs() }), "approved semantic right-click dispatch");
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
          ...(operationName === "click" ? { button } : {}),
          consequence: operationName === "hover" ? "observational" : decision.consequence,
          confirmed: approval === "human",
          approval,
          effect: "completed",
          effects: interactionEffects(capture, navigated, accounting),
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

  /**
   * Issue #141 coordinate-click path for BrowserClick. The point targets the
   * exact viewport-image (CSS) pixel of the viewport dimensions recorded by
   * this tab's last successful viewport-mode screenshot; the page may have
   * changed since that capture, so nothing about the reference attests the
   * current document. The recorded dimensions are temporarily re-applied for
   * the whole classify/approve/dispatch window and restored afterwards, even
   * on failure or cancellation. A fresh hit-test read in Playwright's utility
   * world applies the same hard credential/file gates as ref clicks; the
   * coordinate target itself is always consequential (unknown or mixed), so
   * it always follows the existing Ask/AutoAccept/Deny approval policy with
   * the single-use permit binding coordinates, button, viewport, the current
   * generation and origin, and the target fingerprint.
   */
  private async clickCoordinates(
    sessionHandle: string,
    tabHandle: string,
    x: number,
    y: number,
    confirmation: BrowserClickConfirmation | undefined,
    signal: AbortSignal | undefined,
    button: BrowserClickButton = "left",
  ): Promise<BrowserInteractionResult> {
    const name = "BrowserClick";
    this.noteToolActivity(sessionHandle);
    assertBoundedInteractionCapability(sessionHandle, BROWSER_INTERACTION_SESSION_MAX_CHARS);
    assertBoundedInteractionCapability(tabHandle, BROWSER_INTERACTION_TAB_MAX_CHARS);
    const { session, tab } = this.requireTab(sessionHandle, tabHandle);
    const reference = this.requireCoordinateReference(tab, x, y);
    return this.operate(session, signal, async (operationSignal) => {
      const operation = new OperationDeadline(name, this.limits.confirmationMs, operationSignal);
      const capturedGeneration = tab.generation;
      const capturedOrigin = interactionIdentityUrl(tab.page.url());
      let started = false;
      let capture: InteractionCapture | undefined;
      let resized = false;
      let restored = false;
      const prior = tab.page.viewportSize();
      if (!prior) throw new Error("BrowserClick could not determine the bounded browser viewport.");
      try {
        if (prior.width !== reference.width || prior.height !== reference.height) {
          // The recorded dimensions are re-applied before classification so
          // the approved view is the view that receives the click; they are
          // restored in every path below, before any result is returned.
          await operation.run(
            tab.page.setViewportSize({ width: reference.width, height: reference.height }),
            "viewport match for coordinate click",
          );
          resized = true;
        }
        const structure = await operation.run(readPointTargetStructure(tab.page, x, y), "point structural read");
        assertCoordinatePointGate(structure);
        // Coordinate targets are always consequential: a real mouse event can
        // reach page-controlled handlers at or above the point, and absence
        // of effects is not provable. Canvas and every other semantically
        // unknown target therefore follow the existing approval policy.
        const decision: BrowserConsequenceDecision = { consequence: "unknown_or_mixed", consequential: true, destination: null };
        this.enforceCredentialCapabilities("click", undefined, structure);
        const authorization = this.interactionAuthorization(name, confirmation);
        const binding = coordinateConfirmationBinding(
          { session: session.handle, tab: tab.handle, generation: tab.generation },
          capturedOrigin, decision.consequence, button, x, y, reference,
          this.consequencePolicy.fingerprint(structure),
        );
        const permit = this.confirmationPermits.issue(binding);
        let approved = false;
        try {
          approved = await operation.run(
            authorization.confirm(coordinateClickPrompt(capturedOrigin, button, x, y, reference)),
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
        let approval: BrowserInteractionResult["approval"];
        try {
          throwIfAborted(operation.signal);
          if (session.teardown || session.fatalError || tab.page.isClosed()) {
            throw new Error(`${name} not_started: the browser session changed or closed after approval.`);
          }
          if (tab.generation !== capturedGeneration || interactionIdentityUrl(tab.page.url()) !== capturedOrigin) {
            this.invalidateInteractionRefs(tab, capturedGeneration);
            throw new Error(`${name} not_started: the document or origin changed after approval; retry the coordinate click. Retaking a viewport screenshot is optional.`);
          }
          const currentViewport = tab.page.viewportSize();
          if (!currentViewport || currentViewport.width !== reference.width || currentViewport.height !== reference.height) {
            throw new Error(`${name} not_started: the browser viewport changed after approval; the coordinate click was not dispatched.`);
          }
          const revalidatedStructure = await operation.run(readPointTargetStructure(tab.page, x, y), "post-approval point revalidation");
          assertCoordinatePointGate(revalidatedStructure);
          this.enforceCredentialCapabilities("click", undefined, revalidatedStructure);
          const rebound = coordinateConfirmationBinding(
            { session: session.handle, tab: tab.handle, generation: tab.generation },
            capturedOrigin, decision.consequence, button, x, y, reference,
            this.consequencePolicy.fingerprint(revalidatedStructure),
          );
          if (!this.confirmationPermits.consume(permit, rebound)) {
            this.invalidateInteractionRefs(tab, capturedGeneration);
            throw new Error(`${name} not_started: the approved target or consequence changed; retry the coordinate click. Retaking a viewport screenshot is optional.`);
          }
          approval = authorization.source;
        } finally {
          // Also revoke on failed re-resolution or cancellation: every
          // approval path stays single-use exactly as for ref clicks.
          this.confirmationPermits.revoke(permit);
        }
        capture = newInteractionCapture();
        session.interactionCapture = capture;
        started = true;
        await operation.run(tab.page.mouse.click(x, y, { button }), "approved coordinate click dispatch");
        const accounting = await accountInteractionEffects(capture, operation);
        if (session.fatalError) throw session.fatalError;
        if (resized) {
          try {
            await operation.run(tab.page.setViewportSize({ width: prior.width, height: prior.height }), "viewport restore after coordinate click");
          } catch {
            throw new Error(`${name} dispatched the approved coordinate click but could not restore the prior viewport; no rollback is claimed and the session is contained.`);
          }
          restored = true;
        }
        const navigated = tab.generation !== capturedGeneration || interactionIdentityUrl(tab.page.url()) !== capturedOrigin;
        this.invalidateInteractionRefs(tab, capturedGeneration);
        return {
          session: session.handle,
          tab: tab.handle,
          generation: tab.generation,
          operation: "click",
          button,
          coordinate: { x, y },
          consequence: decision.consequence,
          confirmed: approval === "human",
          approval,
          effect: "completed",
          effects: interactionEffects(capture, navigated, accounting),
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
        if (resized && !restored) {
          // Failure/cancellation path: best-effort restore. Cancellation and
          // post-dispatch containment close the page anyway; a live failure
          // still attempts the restore without claiming any rollback.
          try {
            if (!operation.signal.aborted && !tab.page.isClosed()) {
              await boundedCleanup(
                tab.page.setViewportSize({ width: prior.width, height: prior.height }),
                this.limits.cleanupMs,
                "viewport restore after failed coordinate click",
              );
            }
          } catch {
            // The already-propagating failure remains authoritative.
          }
        }
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
    this.noteToolActivity(sessionHandle);
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
    this.noteToolActivity(sessionHandle);
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
    this.noteToolActivity(sessionHandle);
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
          const requested = await operation.run(
            validateNavigationUrl(url, this.resolveHostname, { allowLocalNetworks: this.effectivePolicy.localNetworks }),
            "URL validation",
          );
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
            // The tab's retained downloads are unusable once the tab is gone;
            // release them so they cannot evict live tabs' pending downloads.
            releaseTabDownloads(session, tab.handle);
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
   * Settings-driven immediate application of the launch-pinned context
   * settings (issue #22 visibility; issue #27 service-worker policy).
   * Playwright pins both at launch — the window mode selects separate
   * headless-shell and headed binaries, and `serviceWorkers` is a fixed
   * context option — so applying a saved change to a live browser means a
   * controlled close/reopen through the ordinary ownership path: ordered
   * intended tabs, the active page, the memory-only session state, and the
   * manager-issued per-origin permission grants are restored best-effort and
   * every loss or redirect is reported. Returns null when no live browser
   * exists (the preference applies at the next open) or when both pinned
   * settings already match (idempotent, no restart).
   */
  async applyVisibility(visible: boolean): Promise<BrowserVisibilityResult | null> {
    this.assertAcceptingOperations();
    if (this.opening > 0 || this.openings.size > 0) {
      // Serialize behind an in-flight BrowserOpen instead of replacing it;
      // a bounded wait that does not settle is reported, never silently queued.
      try {
        await boundedCleanup(
          Promise.all([...this.openings].map((opening) => opening.settled)),
          this.limits.navigationMs + this.limits.cleanupMs,
          "browser visibility change waiting for in-flight BrowserOpen",
        );
      } catch (error) {
        throw new Error(`Browser visibility change not applied: BrowserOpen is still in flight (${bounded(asError(error).message, 200)}); retry after it completes.`);
      }
    }
    const existing = this.sessions.values().next().value as Session | undefined;
    if (!existing) return null; // No live browser: the preference applies at the next open.
    // Issue #27: the service-worker policy is pinned at context creation, so
    // a saved modelServiceWorkers/YOLO transition is immutable in place too.
    // Compare BOTH launch-pinned settings; a difference in either one requires
    // the controlled replacement below. This is what makes a live disable (or
    // YOLO off) revoke the SW-controlled state by destroying the context that
    // allows it, instead of leaving a stale "allow" behind.
    const desiredServiceWorkers: "allow" | "block" = this.effectivePolicy.modelServiceWorkers ? "allow" : "block";
    if (existing.visible === visible && existing.serviceWorkers === desiredServiceWorkers) return null; // Idempotent, no restart.

    // Serialize behind in-flight browser operations: wait for them to settle
    // (bounded) instead of tearing the session down underneath them. Only if
    // they overrun the bound are they cancelled, and a cancellation that
    // closed the browser is reported truthfully instead of replaced blindly.
    const operations = [...this.activeOperations].filter((operation) => operation.session === existing);
    if (operations.length > 0) {
      try {
        await boundedCleanup(
          Promise.all(operations.map((operation) => operation.settled)),
          this.limits.navigationMs + this.limits.actionMs + this.limits.cleanupMs,
          "browser visibility change waiting for in-flight browser operations",
        );
      } catch (waitError) {
        for (const operation of operations) operation.controller.abort(new Error(VISIBILITY_CANCEL_REASON));
        await Promise.allSettled(operations.map((operation) => operation.settled));
        this.assertAcceptingOperations();
        if (!this.sessions.has(existing.handle) || existing.teardown || existing.fatalError) {
          throw new Error("Browser visibility change not applied: in-flight browser operations could not settle in bounded time and their cancellation closed the browser; the saved preference applies at the next BrowserOpen.");
        }
        throw new Error(`Browser visibility change not applied: in-flight browser operations did not settle in bounded time (${bounded(asError(waitError).message, 200)}).`);
      }
    }
    this.assertAcceptingOperations();
    this.assertUsable(existing);

    // The delegated capture/validation window of the controlled replacement
    // (browser-visibility-replacement.ts): the manager holds the session busy
    // lock across it so in-flight browser operations are still rejected up
    // front, and beginTeardown below publishes teardown either way.
    existing.operationActive = true;
    let plan: VisibilityCapturePlan;
    try {
      plan = await captureVisibilityPlan(existing, {
        limits: this.limits,
        resolveHostname: this.resolveHostname,
        allowLocalNetworks: () => this.effectivePolicy.localNetworks,
        tabForPage: (page) => this.tabForPage(existing, page),
        tabs: existing.tabs.values(),
      });
    } finally {
      existing.operationActive = false;
    }
    // Disclose a session that ended during the capture/validation window instead
    // of reporting a clean in-place replacement: its teardown was started under
    // its own reason (fatal error, explicit close, idle expiry), and the
    // beginTeardown below returns that in-flight teardown, ignoring the
    // visibility closure override.
    if (existing.fatalError || existing.teardown) {
      plan.notes.push(`The previous browser session had already ended during the visibility change (${bounded((existing.fatalError ?? new Error("teardown in progress")).message, 200)}); its handles are stale and its closure was not caused by this change.`);
    }

    if (plan.restoreOrder.length === 0) {
      plan.notes.push("No recorded tab URL passes the public-URL egress policy, so the browser was left unchanged in its current mode; use BrowserTabs/BrowserNavigate to reach restorable pages, or BrowserClose and BrowserOpen.");
      return {
        previousSession: existing.handle,
        session: existing.handle,
        activeTab: existing.activeTab,
        headless: !existing.visible,
        serviceWorkers: existing.serviceWorkers,
        relaunched: false,
        tabs: plan.outcomes,
        restoredTabs: 0,
        unrestoredTabs: plan.outcomes.length,
        urlMismatches: 0,
        stateReapplied: false,
        stateCookies: plan.stateCookies,
        stateOrigins: plan.stateOrigins,
        overflowPopups: plan.overflowPopups,
        notes: plan.notes,
      };
    }

    // Close the old browser with a truthful closure reason, then relaunch
    // through the ordinary ownership path: fresh per-session broker
    // credentials, no persistent profile, no remote-control port. The new
    // session's broker inherits the current effective local-network permission
    // at construction (see launchSession), so an opt-in local tab is admitted
    // by the replacement exactly as it was by the browser it replaces.
    const visibilityChanged = existing.visible !== visible;
    const serviceWorkersChanged = existing.serviceWorkers !== desiredServiceWorkers;
    const closureMessage = visibilityChanged && serviceWorkersChanged
      ? `Browser visibility and service-worker settings change: replaced with a ${visible ? "headed" : "headless"} browser that ${desiredServiceWorkers === "allow" ? "allows" : "blocks"} service workers.`
      : visibilityChanged
        ? `Browser visibility settings change: replaced with a ${visible ? "headed" : "headless"} browser.`
        : `Browser service-worker settings change: replaced with a browser that ${desiredServiceWorkers === "allow" ? "allows" : "blocks"} service workers.`;
    if (serviceWorkersChanged) {
      plan.notes.push(`Service-worker policy changed from ${existing.serviceWorkers} to ${desiredServiceWorkers}; the replacement context enforces the new policy and the previous session's registered service workers are gone with its context.`);
    }
    await this.beginTeardown(existing, undefined, {
      kind: "visibility_reconfigure",
      message: closureMessage,
    });

    const restore: VisibilityRestorePlan = {
      previousSession: existing.handle,
      storageState: plan.storageState,
      outcomes: plan.outcomes,
      restoreOrder: plan.restoreOrder,
      intendedActiveIndex: plan.intendedActiveIndex,
      overflowPopups: plan.overflowPopups,
      stateReapplied: plan.storageState !== undefined,
      stateCookies: plan.stateCookies,
      stateOrigins: plan.stateOrigins,
      permissionGrants: plan.carriedPermissionGrants,
      notes: plan.notes,
    };
    return await this.launchSession({ kind: "visibility", headless: !visible, restore }) as BrowserVisibilityResult;
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

  // Only settled goto connection failures qualify; never infer causality from
  // a session-wide capacity counter (another request may have been refused).
  private readonly settledNavigationFailures = new WeakSet<Error>();

  private async navigateSession(session: Session, tab: BrowserTab, rawUrl: string, operation: OperationDeadline, initial: boolean, onDispatch?: () => void): Promise<BrowserNavigateResult> {
    if (!initial) this.consumeNavigation(session);
    else session.navigations += 1;
    let requested: URL;
    try {
      // Issue #27: read the CURRENT effective policy at every navigation so a
      // settings save applies to subsequent admissions without a restart.
      requested = await operation.run(
        validateNavigationUrl(rawUrl, this.resolveHostname, { allowLocalNetworks: this.effectivePolicy.localNetworks }),
        "URL validation",
      );
    } catch (error) {
      const failure = asError(error);
      // Site-assigned typed categories are authoritative; a deadline that
      // expired during validation is a timeout, not an invalid URL.
      let category: BrowserFailureCategory;
      if (failure instanceof PublicUrlValidationError) category = failure.category;
      else if (DEADLINE_ERROR_PATTERN.test(failure.message)) category = "timeout";
      else category = classifyPublicUrlError(failure);
      throw browserFailure(failure, "url_validation", category);
    }
    let response: Response | null;
    try {
      // Invoking goto may dispatch the request; after this point cancellation
      // cannot claim "no page effects".
      const goto = tab.page.goto(requested.href, { waitUntil: "domcontentloaded", timeout: operation.remainingMs() });
      onDispatch?.();
      response = await operation.run(goto, "main-document navigation");
    } catch (error) {
      // A session-fatal broker refusal or process failure takes precedence:
      // it is the root cause and is already structured where manager-owned.
      if (session.fatalError) throw session.fatalError;
      const failure = browserFailure(asError(error), "navigation", classifyNavigationError(asError(error)));
      if (!initial && /\bnet::ERR_(?:PROXY_CONNECTION_FAILED|CONNECTION_CLOSED|CONNECTION_RESET|CONNECTION_REFUSED|CONNECTION_ABORTED|SOCKET_NOT_CONNECTED|EMPTY_RESPONSE|TOO_MANY_RETRIES)\b/u.test(asError(error).message)) {
        // Include transport abort/disconnected-socket and Chromium's exhausted
        // connection retry result, not generic ERR_FAILED or ERR_ABORTED.
        // These describe a failed request, not a failed browser. This exemption
        // never overrides broker policy, pending work, or operation cancellation.
        // A rejected, settled connection command is not in-flight uncertainty.
        // It also does not prove no effects or that the old document survived.
        // Revoke all old capabilities even when Chromium emits no commit event.
        tab.generation = this.uniqueHandle("generation");
        tab.semanticRefs.clear();
        tab.documentStatus = undefined;
        failure.message += " Navigation failed after dispatch; page effects are not rolled back. Previous refs were invalidated; retry navigation or take a fresh snapshot.";
        this.settledNavigationFailures.add(failure);
      }
      throw failure;
    }
    try {
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
        navigationsRemaining: this.limits.maxNavigations === null ? null : Math.max(0, this.limits.maxNavigations - session.navigations),
      };
    } catch (error) {
      if (error instanceof BrowserFailureError || error instanceof BrowserRecoveryError) throw error;
      const failure = asError(error);
      throw browserFailure(failure, "navigation", DEADLINE_ERROR_PATTERN.test(failure.message) ? "timeout" : "internal_error");
    }
  }

  /**
   * Install every per-tab guard. Returns the WebSocket route registration
   * promise so the caller can await it before dispatching page work; until it
   * resolves, this tab's WebSockets fall through to the context backstop
   * (fail closed), never to an unvalidated direct connection.
   */
  private async installPageGuards(session: Session, tab: BrowserTab): Promise<void> {
    // Detectable genuine human input renewal (issue #22), best-effort: a
    // browser-owned isolated world reports browser-trusted pointer/key/wheel
    // input as HMAC-authenticated console debug signals that only this
    // manager's verifier accepts. Page script cannot reach that world, patch
    // isTrusted/Date/typed arrays there, or mint tokens. If installation
    // fails the lease simply expires normally (fail-closed); out-of-process
    // iframes are separate CDP targets and are not covered.
    try {
      await this.installHumanInputBridge(session, tab);
    } catch (error) {
      this.recordBridgeInstallNote(session, error);
    }
    tab.page.on("request", (request: Request) => {
      this.tabDiagnostics.networkRequest(session, tab, request);
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
      if (this.limits.maxMainDocumentRequests !== null && session.mainDocumentRequests > this.limits.maxMainDocumentRequests) {
        this.failSession(session, new Error(`Browser main-document request limit (${this.limits.maxMainDocumentRequests}) exhausted.`));
      }
    });
    tab.page.on("response", (response: Response) => {
      this.tabDiagnostics.networkResponse(session, tab, response);
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === tab.page.mainFrame()) {
        tab.documentStatus = response.status();
      }
    });
    tab.page.on("requestfailed", (request: Request) => this.tabDiagnostics.networkFailure(session, tab, request));
    tab.page.on("console", (message: ConsoleMessage) => this.tabDiagnostics.consoleMessage(session, tab, message));
    tab.page.on("pageerror", (error: Error) => this.tabDiagnostics.pageError(session, tab, error));
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
      // Issue #27 device permissions: every top-level document commit
      // (model navigation, page-initiated navigation, or an adopted popup)
      // re-evaluates the CURRENT effective policy for this origin. Grants are
      // per-origin and composable with clipboard grants; a live revocation
      // clears them through updateConfig before any further effect.
      void grantDevicePermissionsForPage(session, () => this.effectivePolicy, () => tab.page.url(), (error) => this.failSession(session, error)).catch(() => undefined);
    });
    // Live ws/wss admission: every WebSocket this tab creates is validated
    // against the public-URL policy before Chromium's native stack connects
    // through the session's authenticated broker proxy (the context proxy
    // credentials carry the auth; no manager-side protocol code exists).
    // The page-scoped route wins over the context backstop for this tab.
    const webSocketRoute = tab.page.routeWebSocket("**/*", (route) => {
      return handleLiveWebSocket(session, tab, route, this.webSocketAdmissionDeps).catch(() => undefined);
    });
    tab.page.on("dialog", (dialog) => this.dismissDialog(session, dialog));
    tab.page.on("download", (download) => this.handleModelDownload(session, tab, download));
    tab.page.on("crash", () => this.failSession(session, new Error("Browser tab crashed; teardown started.")));
    tab.page.on("close", () => {
      this.tabDiagnostics.clear(tab);
      session.tabs.delete(tab.handle);
      // Release this tab's retained downloads with the tab (see above).
      releaseTabDownloads(session, tab.handle);
      if (session.teardown || tab.closing) return;
      if (session.tabs.size === 0) {
        this.failSession(session, new Error("Last browser tab closed unexpectedly; teardown started."));
        return;
      }
      if (session.activeTab === tab.handle) session.activeTab = session.tabs.keys().next().value!;
    });
    return webSocketRoute;
  }

  /** Per-tab human-input renewal bridge: a browser-owned isolated world
   * (inaccessible to page script) reports browser-trusted input as console
   * debug payloads on this tab's own CDP session; the session verifier alone
   * decides renewal. */
  private async installHumanInputBridge(session: Session, tab: BrowserTab): Promise<void> {
    const verifier = session.humanInputVerifier;
    if (!verifier || tab.humanInputCdp) return;
    const cdp = await session.context.newCDPSession(tab.page);
    tab.humanInputCdp = cdp;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      worldName: BROWSER_HUMAN_INPUT_WORLD,
      source: createHumanInputInitScript(verifier.secret),
    });
    cdp.on("Runtime.consoleAPICalled", (payload: { type?: string; args?: Array<{ value?: unknown }> }) => {
      if (session.teardown || session.fatalError) return;
      if (payload?.type !== "debug" || payload.args?.length !== 1) return;
      if (!verifier.accept(payload.args[0]?.value)) return;
      this.renewIdleLease(session);
    });
  }

  private recordBridgeInstallNote(session: Session, error: unknown): void {
    session.broker.note(`human input renewal bridge unavailable: ${bounded(asError(error).message, 200)}`);
  }


  private async operate<T>(
    session: Session,
    signal: AbortSignal | undefined,
    body: (operationSignal: AbortSignal) => Promise<T>,
    fatalOnError = false,
  ): Promise<T> {
    this.assertAcceptingOperations();
    this.assertUsable(session);
    this.renewIdleLease(session);
    if (session.operationActive) throw new Error("Browser session is busy with another bounded operation.");
    if (this.limits.maxActions !== null && session.actions >= this.limits.maxActions) {
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
      if ((fatalOnError && !(failure instanceof BrowserValidationError) && !this.settledNavigationFailures.has(failure)) || operationSignal.aborted || session.fatalError) {
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
      this.renewIdleLease(session);
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
    // Structured where manager-owned; the fatal outcome and teardown are
    // exactly as before. The original message text is preserved.
    session.fatalError ??= classifyFatalSessionError(error);
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

  private beginTeardown(session: Session, cause?: Error, closureOverride?: BrowserClosureReason): Promise<BrowserCloseResult> {
    if (session.teardown) return session.teardown;
    this.idleLeases.get(session)?.stop();
    this.idleLeases.delete(session);
    const closure: BrowserClosureReason = closureOverride
      ? closureOverride
      : session.fatalError
        ? { kind: session.fatalError instanceof BrowserIdleExpiredError ? "idle_expiry" : "fatal_error", message: bounded(session.fatalError.message, 500) }
        : cause
          ? { kind: "session_shutdown", message: "Pi session shutdown, replacement, or reload." }
          : { kind: "explicit_close", message: "BrowserClose was called." };
    for (const tab of session.tabs.values()) this.tabDiagnostics.clear(tab);
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
    // Issue #27: release every retained pending download so staged artifacts
    // never outlive their owning session (Playwright's own temporary storage
    // cleanup at context close is the backstop).
    revokePendingDownloads(session);
    void (async () => {
      try {
        const summary = await cleanupSession(session, this.limits.cleanupMs);
        // Audit against the admission this broker actually used at any point:
        // entries validly dialed while local networks were permitted stay
        // truthful after a later revocation; public-only entries pass either way.
        auditEgressLedger(summary.ledger, { allowLocalNetworks: session.broker.localNetworksEverAllowed });
        const result: BrowserCloseResult = {
          session: session.handle,
          closed: true,
          alreadyClosed: false,
          quiescent: true,
          broker: {
            connections: summary.ledger.length + (summary.ledgerDropped ?? 0),
            ledgerDropped: summary.ledgerDropped ?? 0,
            capacityRefusals: session.capacityRefusals,
            budgetAborts: summary.budgetAborts,
            refusals: summary.refusals,
          },
          diagnosticsRetained: true,
          closure,
        };
        this.rememberClosed(session.handle, result);
        resolveTeardown(result);
      } catch (error) {
        const failure = new Error(`Browser closure is unconfirmed: ${asError(error).message} Closure reason: ${closure.message}`, { cause: error });
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
    if (session) {
      this.renewIdleLease(session);
      return session;
    }
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

  /**
   * Issue #141: validate that this exact tab holds a coordinate-click reference
   * established by a successful viewport-mode screenshot (the last successful
   * one) and that the requested point falls within the recorded image
   * dimensions. Out-of-bounds coordinates are rejected, never clamped. The
   * reference supplies viewport dimensions only — it is not an attestation
   * that the page still matches the capture — so no generation or origin
   * comparison happens here and no interaction or navigation invalidates the
   * reference; the click itself revalidates the live document, origin,
   * viewport, and hit-tested target before dispatch.
   */
  private requireCoordinateReference(tab: BrowserTab, x: number, y: number): ViewportScreenshotReference {
    const reference = tab.viewportScreenshot;
    if (!reference) {
      throw new BrowserValidationError(
        'not_started: BrowserClick coordinates require a successful BrowserScreenshot with mode="viewport" of this exact session and tab; no current viewport reference exists. Take a fresh BrowserScreenshot with mode="viewport" of this tab and retry.',
      );
    }
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || y < 0 || x >= reference.width || y >= reference.height) {
      throw new BrowserValidationError(
        `not_started: BrowserClick coordinates must be non-negative integers within the recorded viewport screenshot dimensions ${reference.width}x${reference.height}.`,
      );
    }
    return reference;
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
    // The caller (handleModelDownload) already accounted the observed
    // download; only the settlement is tracked here.
    const capture = session.interactionCapture;
    const settlement = download.cancel().then(() => undefined, () => {
      const failure = new Error("Unexpected browser download could not be canceled; teardown started.");
      this.failSession(session, failure);
      throw failure;
    });
    settlement.catch(() => undefined);
    if (capture) capture.settlements.push(settlement);
  }

  /**
   * Issue #27 download policy at the single point where Chromium reports a
   * download. While modelDownloadSaving is off (the default) every download is
   * canceled exactly as before this capability existed: no bytes are staged to
   * a path the model or page could influence, and nothing is retained. With
   * the capability on, the download is retained under an opaque handle bound
   * to this session and tab; saving it still requires the approval policy.
   */
  private handleModelDownload(session: Session, tab: BrowserTab, download: Download): void {
    const capture = session.interactionCapture;
    if (capture) {
      capture.downloads += 1;
      capture.events += 1;
    }
    if (!this.effectivePolicy.modelDownloadSaving || session.teardown) {
      this.cancelDownload(session, download);
      return;
    }
    const record = retainPendingDownload(session, tab.handle, download, { cap: this.downloadRetention, newHandle: () => this.uniqueHandle("download") });
    if (record && capture) capture.retainedDownloads.push(record.handle);
  }


  private consumeNavigation(session: Session): void {
    if (this.limits.maxNavigations !== null && session.navigations >= this.limits.maxNavigations) {
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
      navigationsRemaining: this.limits.maxNavigations === null ? null : Math.max(0, this.limits.maxNavigations - session.navigations),
    };
  }

  private tabForPage(session: Session, page: Page): BrowserTab | undefined {
    for (const tab of session.tabs.values()) if (tab.page === page) return tab;
    return undefined;
  }

  private adoptPage(session: Session, page: Page, popup = true, restoringOwnedTab = false): BrowserTab | undefined {
    const existing = this.tabForPage(session, page);
    if (existing) return existing;
    if (page.isClosed()) {
      session.broker.note(`${popup ? "popup" : "additional tab"} closed before ownership could be established.`);
      return undefined;
    }
    // Issue #27 popup restriction override: while enabled (directly or via
    // YOLO), page-created popups are adopted as owned explicit tab handles
    // even beyond the ordinary session tab limit — the current popup limit is
    // lifted, and no separate popup cap is invented. Every adopted popup still
    // gets the full guard set (context route backstop plus per-tab routes,
    // WebSocket admission, and diagnostics) before any untrusted request can
    // flow, and its destination follows the effective local-network policy at
    // the broker exactly like every other page. Model-initiated BrowserTabs
    // opens keep their own cap check, and any page that arrives as a popup
    // during a replacement (including one deferred by the restore-creation
    // window) is judged by this same override check.
    // restoringOwnedTab is narrower: it admits only the exact pages the
    // visibility restore loop creates to re-adopt tabs the replaced session
    // already owned — one per validated snapshot tab, identity-scoped, never a
    // standing over-limit allowance, and unreachable from page-created or
    // model-created tabs. A replacement must not refuse previously admitted
    // popup tabs at the ordinary cap while granting no new popup creation
    // authority.
    // The decision reads the CURRENT effective policy at adoption time, so an
    // off transition stops admitting new over-limit popups immediately while
    // already-adopted popup tabs remain ordinary owned tabs (no silent
    // destruction).
    const overLimit = session.tabs.size >= this.limits.maxTabsPerSession;
    if (session.teardown || (overLimit && !(popup && this.effectivePolicy.modelPopupRestrictionOverride) && !restoringOwnedTab)) {
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
      consoleDiagnostics: new DiagnosticRing(this.limits.maxConsoleEvents, this.consoleQuota),
      networkDiagnostics: new DiagnosticRing(this.limits.maxNetworkEvents, this.networkQuota),
      networkStartedAt: new WeakMap(),
      networkPolicy: new WeakMap(),
    };
    session.tabs.set(tab.handle, tab);
    // The context backstop covers the registration gap; containment only.
    // Issue #27: after the guards attach, issue the device grants for the URL
    // already committed while the listeners were not yet attached (idempotent;
    // a no-op while the page is still on about:blank).
    void this.installPageGuards(session, tab)
      .then(() => grantDevicePermissionsForPage(session, () => this.effectivePolicy, () => tab.page.url(), (error) => this.failSession(session, error)))
      .catch(() => undefined);
    return tab;
  }

  private adoptPopup(session: Session, page: Page): BrowserTab | undefined {
    return this.adoptPage(session, page, true);
  }

  /** Adopt an unowned page under the ordinary popup policy and record it in
   * the active interaction capture. Shared by the context "page" event and
   * the restore-creation window settle so a deferred page is judged by
   * exactly the same rules as one arriving outside the window. */
  private evaluateUnownedPage(session: Session, candidate: Page): void {
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
  }

  /** Close a visibility-restore creation window: clear the armed flag and
   * re-evaluate every page deferred during the window under the ordinary
   * popup policy. Pages already owned by identity (the restore page itself)
   * are skipped; refused pages are contained as usual, so no unowned page is
   * stranded and no unrelated page rides the restore admission. */
  private settleDeferredRestorePages(session: Session): void {
    session.restoreCreationArmed = false;
    for (const page of session.deferredRestorePages.splice(0)) {
      if (this.tabForPage(session, page)) continue;
      this.evaluateUnownedPage(session, page);
    }
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

  private uniqueHandle(kind: "session" | "tab" | "generation" | "ref" | "download"): string {
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
      ...DEFAULT_EGRESS_BUDGETS,
      mode: "interactive",
      // Issue #27: the session broker admits local-network destinations only
      // under the effective policy at construction; live changes are applied
      // to the running broker by updateConfig (setLocalNetworksAllowed).
      allowLocalNetworks: this.effectivePolicy.localNetworks,
      maxClientConnections: 64,
      preAuthSocketMs: 5_000,
      // The Pi session owns browser lifetime; action deadlines remain finite.
      maxTotalMs: null,
      maxCleanupMs: this.limits.cleanupMs,
      maxAuthorityChars: 2_048,
      maxHeaderChars: 32_768,
      maxDiagnostics: 32,
      idleSocketMs: this.limits.idleSocketMs,
    };
  }
}


function normalizeBrowserClickButton(value: unknown): BrowserClickButton {
  if (value === undefined) return "left";
  if (value !== "left" && value !== "right") {
    throw new Error("BrowserClick not_started: button must be exactly left or right.");
  }
  return value;
}
