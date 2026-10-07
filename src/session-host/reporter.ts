/**
 * Session-host status companion (issue #323).
 *
 * Opt-in Pi extension. It reports bounded status and accepts authenticated
 * native rename requests. The session-host process spawns the
 * Node-based Pi CLI directly with this reporter extension loaded first and
 * the review gate after it (plus the early NODE_OPTIONS preload). It reports
 * top-level session status (busy/idle, pending input presence, modal input
 * surface, generic activity) to the parent session-host process over a local
 * stream socket described by the one-shot
 * PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP environment variable.
 *
 * Invariants:
 * - Without a valid bootstrap (explicit env or this process's sticky /reload
 *   copy) it registers nothing and performs no IO or UI mutation.
 * - The bootstrap env is consumed (deleted) before any async work so worker
 *   and shell descendants never inherit the socket path or token.
 * - Only interactive TUI sessions are observed; print/no-op UI contexts are
 *   never wrapped or mutated.
 * - Observation is local only: the known pending-question widget key and the
 *   presence/absence of its value. Question text, controllers, tool args,
 *   and transcripts never enter a frame. The native canonical conversation
 *   name is the sole intentionally allowed prompt-derived title.
 * - The setWidget decorator only observes FUTURE calls and no API queries an
 *   already-present panel, so pendingInput starts unknown (null) each session
 *   and resolves to true/false only on the first observed set/clear of the
 *   known key. A successfully installed hook is never equated with "no
 *   questions".
 * - Every failure path degrades to unknown (null) or silence; native
 *   operation, hook results, and UI forwarding are never changed.
 * - The setWidget wrapper is restored only when it is still this reporter's
 *   own wrapper; foreign decorators, `this`, arguments, return values, and
 *   errors pass through untouched.
 */

import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { extractContext, extractToolName, registerHook, type HookHandler } from "../pi";
import {
  HOST_BOOTSTRAP_ENV,
  MAX_NATIVE_SESSION_NAME_LENGTH,
  MAX_STATUS_FRAME_BYTES,
  decodeFrame,
  encodeFrame,
  isValidNativeSessionId,
  isValidRenameName,
  parseBootstrap,
  sanitizeActivityLine,
  type SessionHostBootstrap,
  type SessionHostHello,
  type SessionHostMessage,
  type SessionHostNativeSession,
  type SessionHostRenameAck,
  type SessionHostRenameRequest,
  type SessionHostStatus,
} from "./protocol";

declare const module: {
  exports: unknown;
};

/** Widget key the review gate uses for its pending-question panel. */
const PENDING_QUESTIONS_WIDGET_KEY = "review-gate-pending-questions";

/**
 * Process-local sticky state across /reload (same native process). The env
 * bootstrap is one-shot, so a reloaded extension incarnation recovers the
 * known instance identity, sequence, and native-session epoch from here
 * instead of attaching to anything else.
 */
export const SESSION_HOST_STICKY_STATE_KEY = Symbol.for("pi-review-gate.session-host.state.v1");

const EXIT_HANDLER_FLAG = Symbol.for("pi-review-gate.session-host.exit-handler");

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;
const CONNECT_TIMEOUT_MS = 3_000;
/** Encoded replies waiting outside Node's own bounded writable buffer. */
const MAX_QUEUED_RENAME_ACKS = 4;

export interface SessionHostReporterOptions {
  /** Test seam: reconnect delay. Production default is 1000ms. */
  reconnectDelayMs?: number;
  /** Test seam: bounded reconnect attempts before giving up until the next session_start. Production default is 3. */
  maxReconnectAttempts?: number;
  /** Test seam: observe the raw socket when a connection attempt is created. */
  onSocket?: (socket: net.Socket) => void;
  /** Test seam: supply an in-memory socket without touching the filesystem. */
  connectSocket?: (socketPath: string) => net.Socket;
}

interface StickyState {
  bootstrap: SessionHostBootstrap;
  sequence: number;
  sessionEpoch: number;
  nativeSessionId?: string;
  teardown?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface NativeSessionRead {
  sessionId: string;
  displayName: string;
  /** Native stored name, only retained locally for exact setter read-back. */
  storedName?: string;
}

/** Clips only display metadata; persisted rename commands are validated separately and never clipped. */
function displayNameFromPieces(pieces: readonly string[]): string {
  const chars: string[] = [];
  let started = false;
  for (const piece of pieces) {
    for (const codePoint of piece) {
      const safe = /[\x00-\x1f\x7f\u0080-\u009f\u2028\u2029]/.test(codePoint) ? " " : codePoint;
      if (!started && safe.trim() === "") continue;
      started = true;
      chars.push(safe);
      if (chars.length > MAX_NATIVE_SESSION_NAME_LENGTH) break;
    }
    if (chars.length > MAX_NATIVE_SESSION_NAME_LENGTH) break;
  }
  const clipped = chars.slice(0, MAX_NATIVE_SESSION_NAME_LENGTH).join("").trim();
  return clipped || "(no messages)";
}

/** Mirrors native SessionInfo's first user-text fallback without exporting message content beyond its clipped title. */
function firstUserMessageDisplayName(entries: unknown[]): string {
  for (const entry of entries) {
    try {
      if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") continue;
      const content = entry.message.content;
      if (typeof content === "string") {
        if (content) return displayNameFromPieces([content]);
        continue;
      }
      if (!Array.isArray(content)) continue;
      const pieces: string[] = [];
      for (const block of content) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") pieces.push(block.text);
      }
      if (pieces.length > 0 && (pieces.some((piece) => piece.length > 0) || pieces.length > 1)) {
        // The native selector joins text blocks with a single space.
        const joined: string[] = [];
        pieces.forEach((piece, index) => {
          if (index > 0) joined.push(" ");
          joined.push(piece);
        });
        return displayNameFromPieces(joined);
      }
    } catch {
      return "(no messages)";
    }
  }
  return "(no messages)";
}

/** Reads only public Pi context/session-manager APIs; any unavailable or throwing surface is unknown. */
function readNativeSession(context: unknown): NativeSessionRead | undefined {
  try {
    if (!isRecord(context)) return undefined;
    const manager = context.sessionManager;
    if (!isRecord(manager)) return undefined;
    const getSessionId = manager.getSessionId;
    const getSessionName = manager.getSessionName;
    const getEntries = manager.getEntries;
    if (typeof getSessionId !== "function" || typeof getSessionName !== "function" || typeof getEntries !== "function") return undefined;
    const sessionId: unknown = getSessionId.call(manager);
    if (!isValidNativeSessionId(sessionId)) return undefined;
    const storedName: unknown = getSessionName.call(manager);
    if (storedName !== undefined && storedName !== null && typeof storedName !== "string") return undefined;
    if (typeof storedName === "string" && storedName.trim()) {
      return { sessionId, displayName: displayNameFromPieces([storedName]), storedName };
    }
    const entries: unknown = getEntries.call(manager);
    if (!Array.isArray(entries)) return undefined;
    return { sessionId, displayName: firstUserMessageDisplayName(entries) };
  } catch {
    return undefined;
  }
}

function tokenMatches(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Pure fail-closed predicate used immediately before and after the public rename setter. */
function nativeSessionMatches(
  current: SessionHostNativeSession | null,
  expectedSessionId: string,
  expectedSessionEpoch: number,
): boolean {
  return current !== null
    && current.sessionId === expectedSessionId
    && current.epoch === expectedSessionEpoch;
}

export const __test = Object.freeze({ nativeSessionMatches, readNativeSession, MAX_QUEUED_RENAME_ACKS });

function readStickyState(): StickyState | undefined {
  const raw = (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY];
  if (!isRecord(raw)) return undefined;
  if (!Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 0) return undefined;
  const bootstrap = parseBootstrap(raw.bootstrap);
  if (!bootstrap) return undefined;
  const sessionEpoch = Number.isSafeInteger(raw.sessionEpoch) && (raw.sessionEpoch as number) >= 0
    ? raw.sessionEpoch as number
    : 0;
  const nativeSessionId = isValidNativeSessionId(raw.nativeSessionId) ? raw.nativeSessionId : undefined;
  return {
    bootstrap,
    sequence: raw.sequence as number,
    sessionEpoch,
    nativeSessionId,
    teardown: typeof raw.teardown === "function" ? (raw.teardown as () => void) : undefined,
  };
}

function writeStickyState(state: StickyState): void {
  try {
    (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_STICKY_STATE_KEY] = state;
  } catch {
    // Sticky retention is best-effort; /reload continuity degrades to no bootstrap.
  }
}

function parseBootstrapEnv(raw: string): SessionHostBootstrap | undefined {
  // The env is opaque input; bound it in UTF-8 bytes before parsing. Valid
  // fields fit the wire frame budget comfortably.
  if (Buffer.byteLength(raw, "utf8") > MAX_STATUS_FRAME_BYTES) return undefined;
  try {
    return parseBootstrap(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Guarded context extraction: the shared extractor reads arg.ui without
 * guarding its getter, so a stale/throwing context aborts the handler before
 * any cleanup. A throwing or missing ui surface is simply unavailable.
 */
function extractSafeContext(args: unknown[]): unknown {
  try {
    return extractContext(args);
  } catch {
    return undefined; // A stale/throwing context getter: context unavailable.
  }
}

/** True only for an interactive TUI session context (the sole observing host mode). */
function contextModeIsTui(ctx: unknown): boolean {
  if (!isRecord(ctx)) return false;
  try {
    return (ctx as { mode?: unknown }).mode === "tui";
  } catch {
    // A stale/invalidated runner throws; that reads as not interactive.
    return false;
  }
}

/** Native nested tool calls carry a parent marker on the event args. */
function hasNativeParentMarker(args: unknown[]): boolean {
  return args.some((arg) => isRecord(arg) && typeof arg.parentToolCallId === "string" && arg.parentToolCallId.length > 0);
}

/**
 * Consume the one-shot bootstrap env and prime this process's sticky state.
 * Used by BOTH the Node preload (src/session-host/bootstrap-preload.ts,
 * before native startup) and the default extension factory, so a preloaded
 * process and a directly-loaded extension converge on the same instance
 * identity. No IO, no hook registration, no UI: env consumption plus a
 * sticky write only. Returns the primed bootstrap, or undefined when nothing
 * was primed (absent/invalid env, or a foreign instance already known to
 * this process, whose sticky identity stays authoritative).
 */
export function primeReporterBootstrap(): SessionHostBootstrap | undefined {
  const raw = process.env[HOST_BOOTSTRAP_ENV];
  if (raw === undefined) return undefined;
  // Consume before any async work so worker and shell descendants never
  // inherit the socket path or token.
  delete process.env[HOST_BOOTSTRAP_ENV];
  const explicit = parseBootstrapEnv(raw);
  if (!explicit) return undefined;
  const sticky = readStickyState();
  if (sticky
    && (sticky.bootstrap.instanceId !== explicit.instanceId
      || sticky.bootstrap.generation !== explicit.generation
      || sticky.bootstrap.token !== explicit.token
      || sticky.bootstrap.socketPath !== explicit.socketPath)) {
    // The known sticky instance stays authoritative: a reappearing env with
    // any changed identity field is consumed and ignored, never attached.
    return undefined;
  }
  writeStickyState({
    bootstrap: explicit,
    sequence: sticky ? sticky.sequence : 0,
    sessionEpoch: sticky?.sessionEpoch ?? 0,
    nativeSessionId: sticky?.nativeSessionId,
    teardown: sticky?.teardown,
  });
  return explicit;
}

/**
 * Register the session-host status companion. This is the extension entry
 * point of the spawned CLI child: the session host loads this reporter
 * extension before the review gate extension.
 */
export async function activate(pi: unknown, options: SessionHostReporterOptions = {}): Promise<void> {
  // Prime (or recover the preloaded sticky copy of) the bootstrap before any
  // async work so descendants never inherit the socket path or token.
  primeReporterBootstrap();

  // The companion is a top-level CLI-child surface; executor runtimes
  // (orchestrated workers) never report session status.
  if (process.env.PI_REVIEW_GATE_RUNTIME_ROLE === "executor") return;

  const sticky = readStickyState();
  if (!sticky) return; // No valid bootstrap: register nothing, perform no IO.

  installExitCleanup();
  const reporter = createReporter(pi, sticky, options);
  writeStickyState({
    bootstrap: reporter.bootstrap,
    sequence: reporter.sequence,
    sessionEpoch: reporter.sessionEpoch,
    nativeSessionId: reporter.nativeSessionId,
    teardown: reporter.teardown,
  });
}

export default activate;

module.exports = activate;
Object.assign(module.exports as Record<string, unknown>, {
  activate,
  primeReporterBootstrap,
  SESSION_HOST_STICKY_STATE_KEY,
  __test,
});

function installExitCleanup(): void {
  const globalScope = globalThis as Record<PropertyKey, unknown>;
  if (globalScope[EXIT_HANDLER_FLAG]) return;
  globalScope[EXIT_HANDLER_FLAG] = true;
  process.on("exit", () => {
    try {
      readStickyState()?.teardown?.();
    } catch {
      // Best-effort cleanup at process exit.
    }
  });
}

interface ReporterHandle {
  bootstrap: SessionHostBootstrap;
  sequence: number;
  sessionEpoch: number;
  nativeSessionId?: string;
  teardown: () => void;
}

function createReporter(
  pi: unknown,
  sticky: StickyState,
  options: SessionHostReporterOptions,
): ReporterHandle {
  const bootstrap = sticky.bootstrap;
  const previousTeardown = sticky.teardown;
  // A new extension incarnation fences commands on the old socket before it
  // registers its own hooks or waits for session_start.
  try {
    previousTeardown?.();
  } catch {
    // A stale cleanup seam cannot prevent the new reporter from activating.
  }
  const reconnectDelayMs = Math.max(0, options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
  const maxReconnectAttempts = Math.max(0, options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS);

  let sequence = Math.max(0, sticky.sequence);
  let active = false;
  /** Process-wide monotonic guard: stale async callbacks never act. */
  let sessionGeneration = 0;
  let busy: boolean | null = null;
  let pendingInput: boolean | null = null;
  let inputSurface = false;
  let activity: string[] = [];
  let sessionEpoch = sticky.sessionEpoch;
  let nativeSessionId = sticky.nativeSessionId;
  let nativeSession: SessionHostNativeSession | null = null;
  let currentContext: unknown;
  let lastSnapshot: SessionHostStatus | undefined;

  let socket: net.Socket | undefined;
  let connecting = false;
  let drainPending = false;
  /** True when lastSnapshot is already queued in the socket buffer. */
  let snapshotQueued = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingStoredUserRefresh: NodeJS.Immediate | undefined;
  let inboundBuffer = Buffer.alloc(0);
  const pendingRenameRequestIds = new Set<string>();
  const recentRenameRequestIds = new Set<string>();
  const renameAckQueue: string[] = [];
  const MAX_CONCURRENT_RENAME_REQUESTS = 4;
  const MAX_RECENT_RENAME_REQUEST_IDS = 64;

  const cancelPendingStoredUserRefresh = (): void => {
    if (!pendingStoredUserRefresh) return;
    clearImmediate(pendingStoredUserRefresh);
    pendingStoredUserRefresh = undefined;
  };

  let wrappedUi: Record<string, unknown> | undefined;
  /** Original setWidget captured by the currently installed wrapper. */
  let originalSetWidget: ((...args: unknown[]) => unknown) | undefined;
  /** The wrapper currently installed on wrappedUi (if any). */
  let currentWrapper: ((...args: unknown[]) => unknown) | undefined;
  /** Disables observation on the current wrapper without touching forwarding. */
  let disableCurrentObservation: (() => void) | undefined;
  /** Bumped per installation; retained wrappers observe only their own generation. */
  let observerGeneration = 0;

  // ------------------------------------------------------------------
  // Widget observation (pending-input presence only)
  //
  // Each installation creates a fresh wrapper that permanently captures the
  // setWidget it replaced. Wrappers always forward to that captured original,
  // so foreign decorators installed around us and saved stale references keep
  // reaching the native UI even after cleanup; observation is disabled
  // per-wrapper on cleanup instead of breaking the forwarding chain.
  // ------------------------------------------------------------------

  const makeObserverWrapper = (
    original: (...args: unknown[]) => unknown,
    generation: number,
  ): ((...args: unknown[]) => unknown) => {
    let observing = true;
    disableCurrentObservation = () => {
      observing = false;
    };
    return function (this: unknown, ...args: unknown[]): unknown {
      // Local observation only: the known key and presence/absence of the
      // value. undefined clears; an array or factory marks pending. The
      // question text and controller are never inspected. Presence is
      // published only after native forwarding succeeds; a failed operation
      // downgrades to unknown.
      const observe = (value: boolean | null): void => {
        if (!observing || generation !== observerGeneration || !active
          || args[0] !== PENDING_QUESTIONS_WIDGET_KEY) return;
        try {
          pendingInput = value;
          emit();
        } catch {
          // Observation must never change the native call.
        }
      };
      let result: unknown;
      try {
        result = original.apply(this, args);
      } catch (error) {
        observe(null); // A failed native operation cannot verify presence.
        throw error;
      }
      observe(args[1] === undefined ? false : true);
      return result;
    };
  };

  const restoreObserver = (): void => {
    if (wrappedUi && currentWrapper) {
      let isOurs = false;
      try {
        isOurs = wrappedUi.setWidget === currentWrapper;
      } catch {
        isOurs = false; // A foreign throwing getter: ownership unverifiable.
      }
      if (isOurs) {
        try {
          wrappedUi.setWidget = originalSetWidget!;
        } catch {
          // Frozen UI: leave whatever is there; the host owns it from here.
        }
      }
      // Never replace a foreign property or decorator.
    }
    // Retained wrappers (foreign decorators, saved references) keep
    // forwarding to their captured original; only observation stops. This
    // runs even when the ownership check above was unverifiable.
    disableCurrentObservation?.();
    wrappedUi = undefined;
    originalSetWidget = undefined;
    currentWrapper = undefined;
    disableCurrentObservation = undefined;
  };

  const installObserver = (ctx: unknown): boolean => {
    let ui: unknown;
    try {
      ui = isRecord(ctx) ? (ctx as Record<string, unknown>).ui : undefined;
    } catch {
      restoreObserver(); // Replacement surface unavailable: the old observer is stale.
      return false; // A stale context getter may throw; observation unavailable.
    }
    if (!isRecord(ui)) {
      restoreObserver(); // Replacement surface unavailable: the old observer is stale.
      return false;
    }
    let candidate: unknown;
    try {
      candidate = (ui as Record<string, unknown>).setWidget;
    } catch {
      restoreObserver(); // A throwing getter: the surface is unavailable.
      return false;
    }
    if (typeof candidate !== "function") {
      restoreObserver(); // Replacement surface unavailable: the old observer is stale.
      return false;
    }
    if (ui === wrappedUi && currentWrapper) {
      if (candidate === currentWrapper) return true; // Still our wrapper: healthy.
      // Same object, but our wrapper was replaced by another callable
      // (including the original native): the confirmed state is no longer
      // verifiable. Disable/reset without overwriting the foreign property
      // (restoreObserver never writes when ownership is not ours).
      restoreObserver();
      pendingInput = null;
      return false;
    }
    restoreObserver(); // Release any prior object, only when still ours.
    // The observing surface changed: a new UI has not published the known key
    // yet, so confirmed presence from another surface is no longer verifiable.
    // Unknown until observed (or forever, if installation fails below).
    pendingInput = null;
    const original = candidate as (...args: unknown[]) => unknown;
    observerGeneration += 1;
    const wrapper = makeObserverWrapper(original, observerGeneration);
    try {
      ui.setWidget = wrapper;
    } catch {
      disableCurrentObservation?.(); // Not installed: must not observe.
      wrappedUi = undefined;
      originalSetWidget = undefined;
      currentWrapper = undefined;
      return false; // Frozen/hostile UI: pendingInput stays unknown (null).
    }
    // Confirm the assignment actually took: a hostile setter may ignore it or
    // a getter may return another callable without throwing. Unverifiable
    // means not installed; never overwrite the foreign property "restoring".
    let installed: unknown;
    try {
      installed = (ui as Record<string, unknown>).setWidget;
    } catch {
      installed = undefined; // A throwing readback: unverifiable.
    }
    if (installed !== wrapper) {
      disableCurrentObservation?.(); // Not installed: must not observe.
      wrappedUi = undefined;
      originalSetWidget = undefined;
      currentWrapper = undefined;
      return false; // Unverifiable install: pendingInput stays unknown (null).
    }
    wrappedUi = ui;
    originalSetWidget = original;
    currentWrapper = wrapper;
    return true;
  };

  // ------------------------------------------------------------------
  // Socket transport (bounded status snapshots plus bounded rename replies)
  // ------------------------------------------------------------------

  const nextSequence = (): number => {
    // Process-wide monotonic even across /reload incarnations sharing the
    // sticky state: never reuse or decrease a sequence another incarnation
    // already published.
    const sticky = readStickyState();
    if (sticky && sticky.bootstrap.instanceId === bootstrap.instanceId) {
      sequence = Math.max(sequence, sticky.sequence);
    }
    sequence += 1;
    return sequence;
  };

  const tryWriteFrame = (frame: string): boolean => {
    if (!socket) return false;
    let written: boolean;
    try {
      written = socket.write(frame);
    } catch {
      // A synchronous write failure means the connection is gone; close it
      // rather than waiting for a drain that may never happen.
      try {
        socket.destroy();
      } catch {
        // Already unavailable.
      }
      return false;
    }
    if (!written) drainPending = true; // The frame is accepted; queued replies and the latest snapshot flush on drain.
    return true; // Accepted, including when buffered pending drain.
  };

  const tryWriteMessage = (message: SessionHostMessage): boolean => {
    try {
      return tryWriteFrame(encodeFrame(message));
    } catch {
      // All protocol fields are bounded; a failed encode is contained.
      return false;
    }
  };

  const flushQueuedRenameAcks = (candidate: net.Socket, generation: number): boolean => {
    if (!active || generation !== sessionGeneration || candidate !== socket) return false;
    while (renameAckQueue.length > 0) {
      const frame = renameAckQueue.shift()!;
      if (!tryWriteFrame(frame)) {
        candidate.destroy();
        return false;
      }
      // write(false) accepts this frame but asks us to stop until another drain.
      if (drainPending) return false;
    }
    return true;
  };

  const teardownSocket = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    connecting = false;
    drainPending = false;
    snapshotQueued = false;
    renameAckQueue.length = 0;
    inboundBuffer = Buffer.alloc(0);
    if (socket) {
      const stale = socket;
      socket = undefined;
      stale.removeAllListeners();
      try {
        stale.destroy();
      } catch {
        // Already gone.
      }
    }
  };

  const scheduleReconnect = (): void => {
    if (!active || reconnectTimer || socket || connecting) return;
    if (reconnectAttempts >= maxReconnectAttempts) return; // Finite: give up until the next session_start.
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connectSocket();
    }, reconnectDelayMs);
    reconnectTimer.unref?.();
  };

  const connectSocket = (): void => {
    teardownSocket();
    if (!active) return;
    const generation = sessionGeneration;
    let candidate: net.Socket;
    try {
      candidate = options.connectSocket?.(bootstrap.socketPath) ?? net.connect(bootstrap.socketPath);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = candidate;
    connecting = true;
    try {
      options.onSocket?.(candidate);
    } catch {
      // A seam failure must not affect the transport.
    }
    candidate.unref?.();
    // Bound the connection attempt so a wedged listener cannot hold the
    // session open. Incoming bytes are parsed below under the shared cap.
    candidate.resume();
    candidate.setTimeout(CONNECT_TIMEOUT_MS);
    candidate.on("timeout", () => {
      candidate.destroy();
    });
    candidate.on("connect", () => {
      if (generation !== sessionGeneration || !active || candidate !== socket) return; // Stale callback.
      connecting = false;
      // The retry budget is NOT reset here: an accept-then-close broker must
      // not mint fresh attempts forever. installSession resets it instead.
      candidate.setTimeout(0);
      const hello: SessionHostHello = {
        version: 1,
        type: "hello",
        instanceId: bootstrap.instanceId,
        generation: bootstrap.generation,
        token: bootstrap.token,
      };
      if (tryWriteMessage(hello) && lastSnapshot && !drainPending) {
        snapshotQueued = tryWriteMessage(lastSnapshot);
      }
    });
    candidate.on("drain", () => {
      if (!drainPending || generation !== sessionGeneration || !active || candidate !== socket) return;
      drainPending = false;
      if (renameAckQueue.length > 0 && !flushQueuedRenameAcks(candidate, generation)) return;
      // Status backpressure retains only the latest snapshot; flush it once,
      // and never retransmit a snapshot already queued in the buffer.
      if (!lastSnapshot || snapshotQueued) return;
      snapshotQueued = tryWriteMessage(lastSnapshot);
    });
    candidate.on("data", (chunk: Buffer) => {
      processInbound(candidate, generation, chunk);
    });
    candidate.on("error", () => {
      // 'close' follows and drives the bounded reconnect decision.
    });
    candidate.on("close", () => {
      candidate.setTimeout(0);
      if (candidate !== socket) return;
      socket = undefined;
      connecting = false;
      drainPending = false;
      renameAckQueue.length = 0;
      inboundBuffer = Buffer.alloc(0);
      if (generation === sessionGeneration && active) scheduleReconnect();
    });
  };

  // ------------------------------------------------------------------
  // State and emission
  // ------------------------------------------------------------------

  const emit = (): void => {
    if (!active) return;
    if (lastSnapshot
      && lastSnapshot.busy === busy
      && lastSnapshot.pendingInput === pendingInput
      && lastSnapshot.inputSurface === inputSurface
      && lastSnapshot.activity.join("\u0000") === activity.join("\u0000")
      && JSON.stringify(lastSnapshot.nativeSession ?? null) === JSON.stringify(nativeSession)) {
      return; // Unchanged: no new frame.
    }
    const snapshot: SessionHostStatus = {
      version: 1,
      type: "status",
      instanceId: bootstrap.instanceId,
      generation: bootstrap.generation,
      sequence: nextSequence(),
      busy,
      pendingInput,
      inputSurface,
      activity: [...activity],
      nativeSession: nativeSession ? { ...nativeSession } : null,
    };
    lastSnapshot = snapshot;
    snapshotQueued = false;
    writeStickyState({ bootstrap, sequence, sessionEpoch, nativeSessionId, teardown });
    // While backpressured nothing more is queued: the latest snapshot is
    // retained in lastSnapshot and flushes once on drain.
    if (socket && !connecting && !drainPending) {
      snapshotQueued = tryWriteMessage(snapshot);
    }
  };

  const refreshNativeSession = (
    ctx: unknown,
    epochAlreadyAdvanced = false,
    emitUpdate = true,
  ): NativeSessionRead | undefined => {
    currentContext = ctx;
    const read = readNativeSession(ctx);
    if (!read) {
      nativeSession = null;
      if (emitUpdate) emit();
      return undefined;
    }
    if (nativeSessionId !== read.sessionId) {
      if (!epochAlreadyAdvanced) sessionEpoch += 1;
      nativeSessionId = read.sessionId;
    }
    nativeSession = {
      sessionId: read.sessionId,
      epoch: Math.max(1, sessionEpoch),
      name: read.displayName,
    };
    if (sessionEpoch < 1) sessionEpoch = nativeSession.epoch;
    writeStickyState({ bootstrap, sequence, sessionEpoch, nativeSessionId, teardown });
    if (emitUpdate) emit();
    return read;
  };

  const scheduleStoredUserRefresh = (): void => {
    if (pendingStoredUserRefresh) return; // Coalesce same-turn user messages.
    const generation = sessionGeneration;
    // Pi 1.0.4 dispatches message_end before appending the message entry. Defer
    // one turn so this reads the persisted native SessionManager entries, not
    // event payload text, while still updating during a long first response.
    pendingStoredUserRefresh = setImmediate(() => {
      pendingStoredUserRefresh = undefined;
      if (!active || generation !== sessionGeneration) return;
      try {
        if (contextModeIsTui(currentContext)) refreshNativeSession(currentContext);
      } catch {
        // A transient persistence/context failure leaves metadata unknown until the next public refresh.
      }
    });
  };

  const nativeTuple = (): { sessionId: string | null; sessionEpoch: number | null } => ({
    sessionId: nativeSession?.sessionId ?? null,
    sessionEpoch: nativeSession?.epoch ?? null,
  });

  const sendRenameAck = (
    candidate: net.Socket,
    generation: number,
    request: SessionHostRenameRequest,
    outcome: SessionHostRenameAck["outcome"],
    reason: SessionHostRenameAck["reason"],
  ): void => {
    if (!active || generation !== sessionGeneration || candidate !== socket) return;
    const tuple = nativeTuple();
    const ack: SessionHostRenameAck = {
      version: 1,
      type: "rename_result",
      instanceId: bootstrap.instanceId,
      generation: bootstrap.generation,
      requestId: request.requestId,
      expectedSessionId: request.expectedSessionId,
      expectedSessionEpoch: request.expectedSessionEpoch,
      ...tuple,
      outcome,
      reason,
    };
    let frame: string;
    try {
      frame = encodeFrame(ack);
    } catch {
      candidate.destroy();
      return;
    }
    if (drainPending) {
      if (renameAckQueue.length >= MAX_QUEUED_RENAME_ACKS) {
        candidate.destroy(); // Never grow an unbounded acknowledgement queue.
        return;
      }
      renameAckQueue.push(frame);
      return;
    }
    if (!tryWriteFrame(frame)) candidate.destroy();
  };

  const rememberRenameRequest = (requestId: string): boolean => {
    if (recentRenameRequestIds.has(requestId)) return false;
    recentRenameRequestIds.add(requestId);
    if (recentRenameRequestIds.size > MAX_RECENT_RENAME_REQUEST_IDS) {
      const oldest = recentRenameRequestIds.values().next().value as string | undefined;
      if (oldest) recentRenameRequestIds.delete(oldest);
    }
    return true;
  };

  const processRenameRequest = (candidate: net.Socket, generation: number, request: SessionHostRenameRequest): void => {
    if (!active || generation !== sessionGeneration || candidate !== socket) return;
    if (request.instanceId !== bootstrap.instanceId
      || request.generation !== bootstrap.generation
      || !tokenMatches(request.token, bootstrap.token)) {
      candidate.destroy(); // Wrong capability or identity is a protocol failure.
      return;
    }
    if (renameAckQueue.length >= MAX_QUEUED_RENAME_ACKS) {
      candidate.destroy(); // Do not mutate native state when no reply capacity remains.
      return;
    }
    if (pendingRenameRequestIds.size >= MAX_CONCURRENT_RENAME_REQUESTS) {
      candidate.destroy(); // Fail closed instead of silently dropping an authenticated command.
      return;
    }
    if (!rememberRenameRequest(request.requestId)) return; // Replay: never invoke the setter twice.
    pendingRenameRequestIds.add(request.requestId);
    try {
      if (!isValidRenameName(request.name)) {
        sendRenameAck(candidate, generation, request, "rejected", "invalid-name");
        return;
      }
      const before = refreshNativeSession(currentContext);
      if (!before || !nativeSession) {
        sendRenameAck(candidate, generation, request, "rejected", "unavailable");
        return;
      }
      if (!nativeSessionMatches(nativeSession, request.expectedSessionId, request.expectedSessionEpoch)) {
        sendRenameAck(candidate, generation, request, "rejected", "stale-session");
        return;
      }

      let setter: unknown;
      try {
        setter = isRecord(pi) ? (pi as Record<string, unknown>).setSessionName : undefined;
      } catch {
        setter = undefined;
      }
      if (typeof setter !== "function") {
        sendRenameAck(candidate, generation, request, "rejected", "unavailable");
        return;
      }
      try {
        // Public ExtensionAPI method; it synchronously appends native
        // session_info and emits session_info_changed in Pi 1.0.4.
        (setter as (name: string) => void).call(pi, request.name);
      } catch {
        sendRenameAck(candidate, generation, request, "rejected", "setter-failed");
        return;
      }
      if (!active || generation !== sessionGeneration || candidate !== socket) return;
      const after = refreshNativeSession(currentContext);
      if (!after || !nativeSession) {
        sendRenameAck(candidate, generation, request, "rejected", "unavailable");
        return;
      }
      if (!nativeSessionMatches(nativeSession, request.expectedSessionId, request.expectedSessionEpoch)) {
        sendRenameAck(candidate, generation, request, "rejected", "stale-session");
        return;
      }
      // Pi 1.0.4 stores the public setter value after trimming surrounding whitespace.
      if (after.storedName !== request.name.trim()) {
        sendRenameAck(candidate, generation, request, "rejected", "verification-failed");
        return;
      }
      sendRenameAck(candidate, generation, request, "renamed", "none");
    } finally {
      pendingRenameRequestIds.delete(request.requestId);
    }
  };

  const processInboundLine = (candidate: net.Socket, generation: number, lineBytes: Buffer): boolean => {
    let line: string;
    try {
      line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes);
    } catch {
      candidate.destroy();
      return false;
    }
    const message = decodeFrame(line);
    if (!message || message.type !== "rename_request") {
      candidate.destroy(); // Reporter accepts only authenticated host rename commands.
      return false;
    }
    processRenameRequest(candidate, generation, message);
    return !candidate.destroyed;
  };

  const processInbound = (candidate: net.Socket, generation: number, chunk: Buffer): void => {
    if (!active || generation !== sessionGeneration || candidate !== socket) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newlineIndex = chunk.indexOf(0x0a, offset);
      if (newlineIndex === -1) {
        const remainingLength = chunk.length - offset;
        const frameLength = inboundBuffer.length + remainingLength;
        if (frameLength + 1 > MAX_STATUS_FRAME_BYTES) {
          candidate.destroy();
          return;
        }
        const bounded = Buffer.allocUnsafe(frameLength);
        inboundBuffer.copy(bounded, 0);
        chunk.copy(bounded, inboundBuffer.length, offset);
        inboundBuffer = bounded;
        return;
      }
      const segmentLength = newlineIndex - offset;
      const frameLength = inboundBuffer.length + segmentLength;
      if (frameLength + 1 > MAX_STATUS_FRAME_BYTES) {
        candidate.destroy();
        return;
      }
      let lineBytes: Buffer;
      if (inboundBuffer.length === 0) lineBytes = chunk.subarray(offset, newlineIndex);
      else {
        lineBytes = Buffer.allocUnsafe(frameLength);
        inboundBuffer.copy(lineBytes, 0);
        chunk.copy(lineBytes, inboundBuffer.length, offset, newlineIndex);
        inboundBuffer = Buffer.alloc(0);
      }
      offset = newlineIndex + 1;
      if (!processInboundLine(candidate, generation, lineBytes)) return;
    }
  };

  // Shared exception-safe readiness probe (session_start + agent_settled).
  // A valid false isIdle result establishes busy; a missing or throwing
  // probe is unknown and must never establish idle.
  const probeReadiness = (ctx: unknown): "idle" | "busy" | "unknown" => {
    if (!isRecord(ctx)) return "unknown";
    let isIdle: unknown;
    try {
      isIdle = (ctx as { isIdle?: unknown }).isIdle;
    } catch {
      return "unknown"; // A stale context getter may throw.
    }
    if (typeof isIdle !== "function") return "unknown";
    try {
      // Only actual boolean probe results are interpreted, and the context
      // receiver is preserved for methods that use `this`.
      const idle = (isIdle as () => unknown).call(ctx);
      return idle === true ? "idle" : idle === false ? "busy" : "unknown";
    } catch {
      return "unknown"; // A throwing probe must not establish idle.
    }
  };

  const applyReadiness = (readiness: "idle" | "busy" | "unknown"): void => {
    if (readiness === "idle") {
      busy = false;
      activity = ["Ready"];
    } else if (readiness === "busy") {
      busy = true;
      activity = ["Working"];
    } else if (busy !== true) {
      // Unknown may retain an established busy state, but never an idle claim.
      busy = null;
      activity = [];
    }
  };

  const installSession = (ctx: unknown): void => {
    restoreObserver(); // Every session gets a fresh observation generation.
    cancelPendingStoredUserRefresh();
    sessionGeneration += 1;
    sessionEpoch += 1; // Every native session_start/reload invalidates older host commands.
    nativeSessionId = undefined;
    nativeSession = null;
    active = true;
    busy = null;
    // The decorator only observes future setWidget calls and nothing queries
    // an already-present panel: pending presence is unknown until the first
    // observed set/clear of the known key (or forever, if observation is
    // unavailable — no fabricated "clear").
    pendingInput = null;
    inputSurface = false;
    activity = [];
    lastSnapshot = undefined;
    snapshotQueued = false;
    reconnectAttempts = 0;
    installObserver(ctx);
    refreshNativeSession(ctx, true, false);
    connectSocket();
    // Probe live readiness instead of assuming it: a session that starts
    // mid-run reports busy, and an unavailable probe stays unknown (null).
    applyReadiness(probeReadiness(ctx));
    emit();
  };

  const deactivate = (): void => {
    sessionGeneration += 1;
    cancelPendingStoredUserRefresh();
    active = false;
    currentContext = undefined;
    nativeSession = null;
    restoreObserver();
    teardownSocket();
    busy = null;
    pendingInput = null;
    inputSurface = false;
    activity = [];
    lastSnapshot = undefined;
  };

  const teardown = (): void => {
    deactivate();
  };

  // ------------------------------------------------------------------
  // Native hooks (exception-safe: reporting never changes native operation)
  // ------------------------------------------------------------------

  const safe = (fn: (...args: unknown[]) => void): HookHandler => {
    return (...args: unknown[]): undefined => {
      try {
        fn(...args);
      } catch {
        // A reporting failure must never break a run or a hook chain.
      }
    };
  };

  registerHook(pi, "session_start", safe((...args) => {
    const ctx = extractSafeContext(args);
    if (!contextModeIsTui(ctx)) {
      deactivate(); // print/no-op/unreadable hosts: no observation, no reporting, no UI mutation
      return;
    }
    installSession(ctx);
  }));

  registerHook(pi, "session_shutdown", safe(() => {
    deactivate();
  }));

  // Public Pi notification emitted by native /name and setSessionName.
  // It refreshes only the bounded canonical title/identity, never session
  // entries or message text other than the clipped first-user fallback.
  registerHook(pi, "session_info_changed", safe((...args) => {
    if (!active) return;
    const eventContext = extractSafeContext(args);
    const ctx = contextModeIsTui(eventContext) ? eventContext : currentContext;
    if (!contextModeIsTui(ctx)) {
      nativeSession = null;
      emit();
      return;
    }
    refreshNativeSession(ctx);
  }));

  registerHook(pi, "message_end", safe((...args) => {
    if (!active) return;
    const event = args.find((arg) => isRecord(arg) && arg.type === "message_end");
    if (!isRecord(event) || !isRecord(event.message) || event.message.role !== "user") return;
    // The public event is dispatched before native persistence; the deferred
    // refresh reads only the subsequently stored SessionManager entries.
    scheduleStoredUserRefresh();
  }));

  registerHook(pi, "message_start", safe((...args) => {
    if (!active || nativeSession?.name !== "(no messages)") return;
    const event = args.find((arg) => isRecord(arg) && arg.type === "message_start");
    if (!isRecord(event) || !isRecord(event.message) || event.message.role !== "assistant") return;
    // In Pi's event order, the assistant message starts only after initial user
    // message_end handlers return and their SessionManager entries are appended.
    if (contextModeIsTui(currentContext)) refreshNativeSession(currentContext);
  }));

  registerHook(pi, "agent_start", safe(() => {
    if (!active) return;
    busy = true;
    activity = ["Working"];
    emit();
  }));

  // agent_settled is the only boundary where Pi guarantees no automatic
  // continuation remains; probe live idleness instead of assuming it, and
  // never treat agent_end as idle (Pi may still auto-continue after it).
  registerHook(pi, "agent_settled", safe((...args) => {
    if (!active) return;
    // Settled is the only boundary where Pi guarantees no automatic
    // continuation remains. A valid false probe establishes busy; an
    // unavailable or throwing probe (or context) cannot preserve an idle claim.
    const ctx = extractSafeContext(args);
    if (contextModeIsTui(ctx)) refreshNativeSession(ctx);
    applyReadiness(probeReadiness(ctx));
    emit();
  }));

  registerHook(pi, "tool_execution_start", safe((...args) => {
    if (!active) return;
    // Top-level executions only: native nested calls carry a parent marker,
    // and task children are never introspected.
    if (hasNativeParentMarker(args)) return;
    const line = sanitizeActivityLine(extractToolName(args));
    if (!line) return;
    activity = [line];
    emit();
  }));

  registerHook(pi, "ui_prompt_start", safe(() => {
    if (!active) return;
    inputSurface = true;
    emit();
  }));

  registerHook(pi, "ui_prompt_end", safe(() => {
    if (!active) return;
    inputSurface = false;
    emit();
  }));

  // Compaction may recreate the session context object; re-probe the widget
  // surface on the real public compaction completion events. No compaction
  // semantics are reported — readiness only.
  const reprobesReadiness = safe((...args) => {
    if (!active) return;
    const ctx = extractSafeContext(args);
    if (!contextModeIsTui(ctx)) {
      // Unavailable or non-interactive replacement surface: the old observer
      // is stale; unknown until a TUI surface is observed again.
      restoreObserver();
      pendingInput = null;
      emit();
      return;
    }
    if (installObserver(ctx)) {
      refreshNativeSession(ctx);
      emit();
    } else {
      pendingInput = null; // Observation no longer available: unknown.
      refreshNativeSession(ctx);
      emit();
    }
  });
  registerHook(pi, "session_compact", reprobesReadiness);
  registerHook(pi, "session_compact_failed", reprobesReadiness);

  return { bootstrap, sequence, sessionEpoch, nativeSessionId, teardown };
}
