/**
 * Pure admission and receipt identity for remote native input.
 *
 * This module owns the closed-shape validation of peer-published input modes and
 * host-written native IO sources, plus the semantic key of an actually-written
 * remote native input receipt. It holds no state and grants no authority: Main
 * keeps every selection, epoch, policy, receipt, writer, and lifecycle fact, and
 * re-proves them before any input, copy, or writer-invalidation decision.
 */
import type { HostPaneRect } from "./compositor";
import {
  DEFAULT_SESSION_CONTENT_BOUNDS,
  NATIVE_IO_MAX_SOURCE_TOKEN_BYTES,
  isNativeIoStartupSource,
  type NativeIoInputSource,
} from "./network/session-content-protocol";
import type { TerminalInputModes } from "./terminal-surface";

/** The canonical session size and revision a native frame was drawn from (#474). */
export interface CanonicalSessionGeometry {
  readonly cols: number;
  readonly rows: number;
  readonly revision: number;
}

/**
 * Immutable receipt of the ONE remote native IO source a frame ACTUALLY drew.
 *
 * Every fact is captured with the candidate the writer was handed and becomes a
 * receipt only when that exact candidate is reported `written`; a queued, held,
 * or superseded candidate never becomes one. The receipt is what later input and
 * copy attempts are measured against, so an old written source can never be
 * retargeted onto a newer owner source (or the reverse).
 *
 * It carries no permission by itself: every attempt re-proves the current Main
 * focus, actual coverage, drawn content rectangle, canonical geometry, the
 * coordinator's own current selection/endpoint, and (for input) the exact
 * observed modes before anything is submitted.
 */
export interface WrittenRemoteNativeInput {
  readonly hostId: string;
  readonly hostRunId: string;
  readonly rowId: string;
  readonly selectionGeneration: number;
  readonly subscriptionId: string;
  /**
   * Exact host-written source of the drawn viewport: a conversation source, or the
   * explicit tuple-less startup source of a publish that named no conversation. A
   * startup receipt is input-only: a copy (always conversation-sourced) never
   * matches it.
   */
  readonly source: NativeIoInputSource;
  /** Exact observed input modes of that same drawn publish. */
  readonly inputModes: TerminalInputModes;
  /** Canonical size/revision the drawn content came from. */
  readonly geometry: CanonicalSessionGeometry;
  /** The rectangle inside the native pane the written frame actually filled. */
  readonly nativeContent: HostPaneRect;
  /**
   * Remote native IO geometry epoch of the frame that was actually written. An
   * outer resize can reflow the physical screen and return to the same dimensions
   * before any replacement frame is written, so rectangle equality alone cannot
   * prove this receipt still belongs to what the operator sees; the current epoch
   * must equal this one. It gates remote input/copy only — never Close or any
   * other host UI.
   */
  readonly resizeEpoch: number;
  /**
   * Viewer remote input/copy preference generation this frame was composed under.
   * Every actual preference change (including Off -> On) advances the live
   * generation, so a receipt written before it never authorizes again: enabling
   * needs a fresh actually-written frame even when its pixels are identical.
   */
  readonly policyGeneration: number;
}

const NATIVE_IO_MOUSE_TRACKING: ReadonlySet<string> = new Set(["none", "x10", "vt200", "drag", "any"]);
const NATIVE_IO_MOUSE_ENCODING: ReadonlySet<string> = new Set(["default", "sgr", "sgr-pixels"]);
const NATIVE_IO_SOURCE_TOKEN = /^[\x21-\x7e]+$/;

/**
 * Validate and take an immutable copy of the input modes carried by one complete
 * publish. Only the closed shape the protocol reader admits is accepted; a
 * missing or malformed fact yields `undefined` (no input capability) instead of a
 * guess or an inferred default.
 */
export function readRemoteInputModes(value: unknown): TerminalInputModes | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const modes = value as Record<string, unknown>;
  const kittyFlags = modes.kittyFlags;
  if (typeof kittyFlags !== "number" || !Number.isSafeInteger(kittyFlags) || kittyFlags < 0 || kittyFlags > 7) {
    return undefined;
  }
  const modifyOtherKeys = modes.modifyOtherKeys;
  if (modifyOtherKeys !== 0 && modifyOtherKeys !== 1 && modifyOtherKeys !== 2) return undefined;
  const applicationCursorKeys = modes.applicationCursorKeys;
  const applicationKeypad = modes.applicationKeypad;
  const bracketedPaste = modes.bracketedPaste;
  if (typeof applicationCursorKeys !== "boolean"
    || typeof applicationKeypad !== "boolean"
    || typeof bracketedPaste !== "boolean") return undefined;
  const mouseTracking = modes.mouseTracking;
  if (typeof mouseTracking !== "string" || !NATIVE_IO_MOUSE_TRACKING.has(mouseTracking)) return undefined;
  const mouseEncoding = modes.mouseEncoding;
  if (typeof mouseEncoding !== "string" || !NATIVE_IO_MOUSE_ENCODING.has(mouseEncoding)) return undefined;
  return Object.freeze({
    kittyFlags,
    applicationCursorKeys,
    applicationKeypad,
    bracketedPaste,
    mouseTracking: mouseTracking as TerminalInputModes["mouseTracking"],
    modifyOtherKeys,
    mouseEncoding: mouseEncoding as TerminalInputModes["mouseEncoding"],
  });
}

/** Exact semantic equality of one observed mode set. */
export function sameTerminalInputModes(a: TerminalInputModes | undefined, b: TerminalInputModes | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.kittyFlags === b.kittyFlags
    && a.applicationCursorKeys === b.applicationCursorKeys
    && a.applicationKeypad === b.applicationKeypad
    && a.bracketedPaste === b.bracketedPaste
    && a.mouseTracking === b.mouseTracking
    && a.modifyOtherKeys === b.modifyOtherKeys
    && a.mouseEncoding === b.mouseEncoding;
}

/**
 * The geometry, viewer revision, and token facts of one remote source, validated
 * exactly as the conversation branch below validates them and required to match
 * the publish's own canonical geometry. Undefined when any fact is malformed.
 */
function readRemoteSourceFacts(
  record: Record<string, unknown>,
  expectedGeometry: CanonicalSessionGeometry,
): { readonly geometry: CanonicalSessionGeometry; readonly viewerRevision: number; readonly sourceToken: string } | undefined {
  const geometry = record.geometry;
  if (geometry === null || typeof geometry !== "object") return undefined;
  const geometryRecord = geometry as Record<string, unknown>;
  const cols = geometryRecord.cols;
  const rows = geometryRecord.rows;
  const revision = geometryRecord.revision;
  if (typeof cols !== "number" || !Number.isSafeInteger(cols) || cols < 1
    || typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 1
    || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return undefined;
  if (cols !== expectedGeometry.cols || rows !== expectedGeometry.rows
    || revision !== expectedGeometry.revision) return undefined;
  const viewerRevision = record.viewerRevision;
  if (typeof viewerRevision !== "number" || !Number.isSafeInteger(viewerRevision) || viewerRevision < 1) {
    return undefined;
  }
  const sourceToken = record.sourceToken;
  if (typeof sourceToken !== "string" || sourceToken.length === 0
    || sourceToken.length > NATIVE_IO_MAX_SOURCE_TOKEN_BYTES || !NATIVE_IO_SOURCE_TOKEN.test(sourceToken)) {
    return undefined;
  }
  return { geometry: Object.freeze({ cols, rows, revision }), viewerRevision, sourceToken };
}

/**
 * Validate and take an immutable copy of the host-written native IO source of one
 * complete accepted publish. It must be coherent with that publish's own owner
 * run, row, native conversation tuple, and canonical geometry; anything else is
 * not an input source. Every source field is copied, never retained by reference.
 */
export function readRemoteNativeIoSource(
  value: unknown,
  expected: {
    readonly hostRunId: string;
    readonly sessionId: string;
    readonly nativeSession: { readonly sessionId: string; readonly epoch: number } | null;
    readonly geometry: CanonicalSessionGeometry;
  },
): NativeIoInputSource | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const hostRunId = record.hostRunId;
  const sessionId = record.sessionId;
  const maxIdentifier = DEFAULT_SESSION_CONTENT_BOUNDS.maxIdentifierBytes;
  if (typeof hostRunId !== "string" || hostRunId.length === 0 || hostRunId.length > maxIdentifier) return undefined;
  if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > maxIdentifier) return undefined;
  if (hostRunId !== expected.hostRunId || sessionId !== expected.sessionId) return undefined;
  if (Object.prototype.hasOwnProperty.call(record, "phase")) {
    // The explicit startup source: coherent only with a publish that names NO
    // native conversation, and never carrying a tuple key of its own.
    if (record.phase !== "startup" || expected.nativeSession !== null
      || Object.prototype.hasOwnProperty.call(record, "nativeSession")) return undefined;
    const startupFacts = readRemoteSourceFacts(record, expected.geometry);
    if (startupFacts === undefined) return undefined;
    return Object.freeze({
      hostRunId,
      sessionId,
      phase: "startup" as const,
      geometry: startupFacts.geometry,
      viewerRevision: startupFacts.viewerRevision,
      sourceToken: startupFacts.sourceToken,
    });
  }
  if (expected.nativeSession === null) return undefined;
  const native = record.nativeSession;
  if (native === null || typeof native !== "object") return undefined;
  const nativeRecord = native as Record<string, unknown>;
  const nativeSessionId = nativeRecord.sessionId;
  const epoch = nativeRecord.epoch;
  if (typeof nativeSessionId !== "string" || nativeSessionId.length === 0 || nativeSessionId.length > maxIdentifier) {
    return undefined;
  }
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1) return undefined;
  if (nativeSessionId !== expected.nativeSession.sessionId || epoch !== expected.nativeSession.epoch) return undefined;
  const geometry = record.geometry;
  if (geometry === null || typeof geometry !== "object") return undefined;
  const geometryRecord = geometry as Record<string, unknown>;
  const cols = geometryRecord.cols;
  const rows = geometryRecord.rows;
  const revision = geometryRecord.revision;
  if (typeof cols !== "number" || !Number.isSafeInteger(cols) || cols < 1
    || typeof rows !== "number" || !Number.isSafeInteger(rows) || rows < 1
    || typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) return undefined;
  if (cols !== expected.geometry.cols || rows !== expected.geometry.rows
    || revision !== expected.geometry.revision) return undefined;
  const viewerRevision = record.viewerRevision;
  if (typeof viewerRevision !== "number" || !Number.isSafeInteger(viewerRevision) || viewerRevision < 1) {
    return undefined;
  }
  const sourceToken = record.sourceToken;
  if (typeof sourceToken !== "string" || sourceToken.length === 0
    || sourceToken.length > NATIVE_IO_MAX_SOURCE_TOKEN_BYTES || !NATIVE_IO_SOURCE_TOKEN.test(sourceToken)) {
    return undefined;
  }
  return Object.freeze({
    hostRunId,
    sessionId,
    nativeSession: Object.freeze({ sessionId: nativeSessionId, epoch }),
    geometry: Object.freeze({ cols, rows, revision }),
    viewerRevision,
    sourceToken,
  });
}

/**
 * Semantic identity of one actual-written remote native IO receipt.
 *
 * Two equal keys mean the same written source, native tuple and epoch, canonical
 * geometric revision, viewer revision, host commitment, observed modes, and drawn
 * content rectangle — so ordinary terminal text output (which mints fresh
 * snapshots, frames, and sequences without changing any of these) never forces a
 * writer boundary or stalls typing. Object identity and publish sequence are
 * deliberately absent. This key only decides writer-invalidation and the remote IO
 * proof; it is never part of the shared UI/mouse/Close authorization identity.
 */
function nativeIoReceiptKey(receipt: WrittenRemoteNativeInput | undefined): string {
  if (receipt === undefined) return "";
  const source = receipt.source;
  const modes = receipt.inputModes;
  const rect = receipt.nativeContent;
  // The phase and the tuple are explicit key facts: a startup receipt and a
  // conversation receipt can never share a key, so a phase/source-only change is a
  // genuine writer boundary even when the pixels are identical.
  const phase = isNativeIoStartupSource(source) ? "startup" : "conversation";
  const tupleId = isNativeIoStartupSource(source) ? null : source.nativeSession.sessionId;
  const tupleEpoch = isNativeIoStartupSource(source) ? null : source.nativeSession.epoch;
  return JSON.stringify([
    receipt.hostId, receipt.hostRunId, receipt.rowId, receipt.selectionGeneration, receipt.subscriptionId,
    phase, source.hostRunId, source.sessionId, tupleId, tupleEpoch,
    source.geometry.cols, source.geometry.rows, source.geometry.revision,
    source.viewerRevision, source.sourceToken,
    modes.kittyFlags, modes.applicationCursorKeys, modes.applicationKeypad, modes.bracketedPaste,
    modes.mouseTracking, modes.modifyOtherKeys, modes.mouseEncoding,
    rect.column, rect.row, rect.cols, rect.rows,
    receipt.resizeEpoch,
    receipt.policyGeneration,
  ]);
}

export function sameNativeIoReceipt(
  a: WrittenRemoteNativeInput | undefined,
  b: WrittenRemoteNativeInput | undefined,
): boolean {
  return a === b || nativeIoReceiptKey(a) === nativeIoReceiptKey(b);
}
