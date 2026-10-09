/**
 * Pure contracts for the fresh numeric-only Main stdout mode-request census:
 * the strict request/reply schema between the Windows Main runner and the
 * acceptance harness, the original Main PID binding, and the bounded
 * metadata-only diagnostic line. No I/O, no process, no terminal dependencies.
 *
 * The census is diagnosis only: it reports mode requests offered through the
 * retained Main stdout before the outer ConPTY, never negotiated, delivered,
 * or settled terminal state.
 */

export const MAIN_CENSUS_SCHEMA_VERSION = 1;

/** Upper bound every census counter may report; beyond it the census is unknown. */
export const MAIN_CENSUS_COUNT_LIMIT = 2 ** 31 - 1;

/**
 * Upper bound for an optional numeric pane geometry value. This terminal
 * surface exposes no public geometry getter, so the observation always
 * reports explicit nulls and never issues an extra frame read for it.
 */
export const MAIN_PANE_GEOMETRY_LIMIT = 100_000;

/** Known bounded mouse tracking enum: 0 none, 1 x10, 2 vt200, 3 drag, 4 any. */
export type MainActivePaneMouseTracking = 0 | 1 | 2 | 3 | 4 | null;
/** Known bounded mouse encoding enum: 0 default, 1 sgr, 2 sgr-pixels. */
export type MainActivePaneMouseEncoding = 0 | 1 | 2 | null;

/**
 * Independent bounded diagnostic group for the ACTUAL active Main pane at
 * census time: the host's real active-owner id presence, host focus, the
 * matching live roster row, and that pane surface's current parsed input
 * modes (current getter inputs of the pane's own terminal surface). It is
 * diagnosis only — it never claims a mirror decision, a terminal write, byte
 * delivery, an outer-terminal state, host start/shutdown, or a native SDK
 * emission, and it carries no id, PID, path, cwd, label, name, environment,
 * transcript, frame, or argument data. Unknown, ambiguous, replaced,
 * unsupported, or throwing observations report null instead of a guessed
 * value.
 */
export interface MainActivePaneSnapshot {
  /** True only when every field below is positively known within an intact scope. */
  readonly complete: boolean | null;
  /** True only when both owned hooks were installed and never disturbed; null when the scope was never established. */
  readonly scope: boolean | null;
  /** True only for a positively known actual host owner id. */
  readonly ownerPresent: boolean | null;
  /** True only when the host's actual focus is the Main pane. */
  readonly focusMain: boolean | null;
  /** True only when the actual owner id matches exactly one current roster view. */
  readonly viewMatched: boolean | null;
  /** The matched owner row's actual live-process flag. */
  readonly hasLiveProcess: boolean | null;
  /** True only when the matched owner row's lifecycle is `alive`. */
  readonly lifecycleAlive: boolean | null;
  /** True only when the matched, live owner row has a readable pane surface object. */
  readonly surfacePresent: boolean | null;
  /** True only when one pure current getter read of that pane's input modes succeeded. */
  readonly modesReadSucceeded: boolean | null;
  /**
   * Known bounded mouse tracking enum taken from the declared
   * `TerminalInputModes` union: 0 none, 1 x10, 2 vt200, 3 drag, 4 any; null
   * for unknown or unsupported values.
   */
  readonly mouseTracking: MainActivePaneMouseTracking;
  /**
   * Known bounded mouse encoding enum taken from the declared
   * `TerminalInputModes` union: 0 default, 1 sgr, 2 sgr-pixels; null for
   * unknown or unsupported values.
   */
  readonly mouseEncoding: MainActivePaneMouseEncoding;
  readonly geometryColumns: number | null;
  readonly geometryRows: number | null;
}

/** Exact bounded active-pane field names, sorted as the validator expects. */
const ACTIVE_PANE_KEYS = [
  "complete", "focusMain", "geometryColumns", "geometryRows", "hasLiveProcess",
  "lifecycleAlive", "modesReadSucceeded", "mouseEncoding", "mouseTracking",
  "ownerPresent", "scope", "surfacePresent", "viewMatched",
].sort();

/** The observed boolean fields, excluding the independent complete/scope flags. */
const ACTIVE_PANE_DATA_BOOLEAN_FIELDS = [
  "focusMain", "hasLiveProcess", "lifecycleAlive", "modesReadSucceeded",
  "ownerPresent", "surfacePresent", "viewMatched",
] as const;

const ACTIVE_PANE_FLAG_FIELDS = ["complete", "scope"] as const;

/**
 * Strict validation of one bounded active-pane group: exact key set, boolean
 * or null flags/fields, known bounded enums, bounded optional geometry, and
 * coherent independent complete/scope implications (an unestablished or
 * disturbed scope carries no pane data). Downstream owner/view/live/surface
 * evidence must be backed by its upstream guards, so a missing or unknown
 * owner never carries a matched live pane or known modes. Returns undefined
 * for any malformed, missing, out-of-cap, or impossible combination; a
 * partial but honest unknown group is accepted and stays partial.
 */
export function validateMainActivePaneSnapshot(value: unknown): MainActivePaneSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const pane = value as Record<string, unknown>;
  const keys = Object.keys(pane).sort();
  if (keys.length !== ACTIVE_PANE_KEYS.length || keys.some((key, index) => key !== ACTIVE_PANE_KEYS[index])) {
    return undefined;
  }
  for (const field of ACTIVE_PANE_FLAG_FIELDS) {
    if (typeof pane[field] !== "boolean" && pane[field] !== null) return undefined;
  }
  for (const field of ACTIVE_PANE_DATA_BOOLEAN_FIELDS) {
    if (typeof pane[field] !== "boolean" && pane[field] !== null) return undefined;
  }
  const tracking = pane.mouseTracking;
  if (tracking !== null && (!Number.isSafeInteger(tracking) || (tracking as number) < 0 || (tracking as number) > 4)) {
    return undefined;
  }
  const encoding = pane.mouseEncoding;
  if (encoding !== null && (!Number.isSafeInteger(encoding) || (encoding as number) < 0 || (encoding as number) > 2)) {
    return undefined;
  }
  for (const field of ["geometryColumns", "geometryRows"] as const) {
    const geometry = pane[field];
    if (geometry !== null && (!Number.isSafeInteger(geometry) || (geometry as number) < 0
      || (geometry as number) > MAIN_PANE_GEOMETRY_LIMIT)) {
      return undefined;
    }
  }
  const { complete, scope, ownerPresent, viewMatched, hasLiveProcess, lifecycleAlive, surfacePresent, modesReadSucceeded } = pane;
  const hasGeometry = pane.geometryColumns !== null || pane.geometryRows !== null;
  const allDataNull = ACTIVE_PANE_DATA_BOOLEAN_FIELDS.every((field) => pane[field] === null)
    && tracking === null && encoding === null && !hasGeometry;
  const allKnown = ACTIVE_PANE_DATA_BOOLEAN_FIELDS.every((field) => typeof pane[field] === "boolean")
    && tracking !== null && encoding !== null;

  // Scope/complete coherence: an unestablished (null) or disturbed (false)
  // scope carries no pane data at all, and an intact (true) scope is complete
  // exactly when every observed field is positively known.
  if (scope === null) {
    if (complete !== null || !allDataNull) return undefined;
  } else if (scope === false) {
    if (complete !== false || !allDataNull) return undefined;
  } else if (scope === true) {
    if (complete !== allKnown) return undefined;
  } else {
    return undefined;
  }

  // Owner/view coherence: a matched view requires a positively known owner; an
  // absent or unknown owner never carries a matched view; and any positive
  // pane evidence (surface, mode read, or mode value) requires the full
  // upstream owner/view/live/alive guard chain. Unknown views carry no
  // downstream claims at all, and unmatched views never carry positive ones.
  if (ownerPresent === null && viewMatched !== null) return undefined;
  if (ownerPresent === false && viewMatched !== false) return undefined;
  if (viewMatched === true && ownerPresent !== true) return undefined;
  // Numeric geometry is pane evidence too: it requires a positively known
  // owner, a matched live row, and a present pane surface, exactly like the
  // other supported pane observations.
  if (hasGeometry && (ownerPresent !== true || viewMatched !== true
    || hasLiveProcess !== true || lifecycleAlive !== true || surfacePresent !== true)) return undefined;
  const hasDownstream = hasLiveProcess !== null || lifecycleAlive !== null
    || surfacePresent !== null || modesReadSucceeded !== null || tracking !== null || encoding !== null;
  const claimsPaneEvidence = surfacePresent === true || modesReadSucceeded === true
    || tracking !== null || encoding !== null;
  if (viewMatched === null) {
    if (hasDownstream) return undefined; // an unknown view carries no downstream data
  } else if (viewMatched === false) {
    if (hasLiveProcess === true || lifecycleAlive === true || claimsPaneEvidence) return undefined;
  } else {
    if (typeof hasLiveProcess !== "boolean" || typeof lifecycleAlive !== "boolean") return undefined;
    if (hasLiveProcess !== true || lifecycleAlive !== true) {
      if (claimsPaneEvidence) return undefined; // the actual pane gate is unsatisfied: no positive pane evidence
    } else if (surfacePresent !== true) {
      if (modesReadSucceeded === true || tracking !== null || encoding !== null) return undefined;
    } else if (modesReadSucceeded !== true && (tracking !== null || encoding !== null)) {
      return undefined; // no successful mode read never carries a fabricated mode
    }
  }
  return pane as unknown as MainActivePaneSnapshot;
}

/**
 * Independent bounded diagnostic group for the ACTUAL owner's native child at
 * census time: the exact matched live owner row's current authenticated
 * native session epoch, the inner ConPTY original PID and incarnation from
 * the exact original PTY registry, and Main's expected fresh private proof
 * (which binds the raw session id privately on both sides — it never crosses
 * the wire). It is diagnosis only — it never claims transport delivery,
 * parser state, or readiness, and it carries no token, socket path, instance
 * identity, raw session id, or raw tuple. scope true means the binding
 * observation ran inside an intact matched live owner view (fields report
 * what was positively resolved); scope null means it was never established.
 * Unknown, ambiguous, replaced, unsupported, or throwing observations report
 * null instead of a guessed value; a proof without its full tuple is never
 * published.
 */
export interface MainNativeBindingSnapshot {
  /** True only when the binding observation ran inside an intact matched live owner view. */
  readonly scope: boolean | null;
  /** True only when every field below is positively known within scope true. */
  readonly complete: boolean | null;
  /** The inner ConPTY original PID from the exact original PTY registry. */
  readonly ptyPid: number | null;
  /** The current incarnation of that owned public PTY (pending => positive). */
  readonly incarnation: number | null;
  /** The matched owner row's current authenticated native session epoch. */
  readonly sessionEpoch: number | null;
  /** Main's expected fresh private proof (opaque 64-hex), never formatted elsewhere. */
  readonly expectedProof: string | null;
}

/** Exact bounded native-binding field names, sorted as the validator expects. */
const NATIVE_BINDING_KEYS = [
  "complete", "expectedProof", "incarnation", "ptyPid", "scope", "sessionEpoch",
].sort();

const NATIVE_PROOF_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Strict validation of one bounded native-binding group: exact key set,
 * boolean or null scope/complete, bounded positive numerics, opaque 64-hex
 * proof, and coherent pair implications (ptyPid/incarnation and
 * sessionEpoch/expectedProof travel together; a proof requires its full
 * tuple; complete is exactly all-known). The raw session id is never on the
 * wire: the opaque proof binds it. Returns undefined for any malformed or
 * impossible combination.
 */
export function validateMainNativeBindingSnapshot(value: unknown): MainNativeBindingSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const group = value as Record<string, unknown>;
  const keys = Object.keys(group).sort();
  if (keys.length !== NATIVE_BINDING_KEYS.length || keys.some((key, index) => key !== NATIVE_BINDING_KEYS[index])) {
    return undefined;
  }
  const { scope, complete } = group;
  if (typeof scope !== "boolean" && scope !== null) return undefined;
  if (typeof complete !== "boolean" && complete !== null) return undefined;
  const ptyPid = group.ptyPid;
  if (ptyPid !== null && (!Number.isSafeInteger(ptyPid) || (ptyPid as number) <= 1)) return undefined;
  const incarnation = group.incarnation;
  if (incarnation !== null && (!Number.isSafeInteger(incarnation) || (incarnation as number) < 1)) return undefined;
  const sessionEpoch = group.sessionEpoch;
  if (sessionEpoch !== null && (!Number.isSafeInteger(sessionEpoch) || (sessionEpoch as number) < 1)) {
    return undefined;
  }
  const expectedProof = group.expectedProof;
  if (expectedProof !== null && (typeof expectedProof !== "string" || !NATIVE_PROOF_PATTERN.test(expectedProof))) {
    return undefined;
  }
  // Pair coherence: the PID/incarnation pair and the epoch/proof pair travel
  // together or not at all; a proof requires its full tuple. The raw session
  // id is never on the wire: the opaque proof binds it.
  if ((ptyPid === null) !== (incarnation === null)) return undefined;
  if ((sessionEpoch === null) !== (expectedProof === null)) return undefined;
  if (expectedProof !== null && (ptyPid === null || incarnation === null)) return undefined;
  if (scope === null) {
    if (complete !== null || ptyPid !== null || incarnation !== null
      || sessionEpoch !== null || expectedProof !== null) return undefined;
  } else if (scope === false) {
    if (complete !== false || ptyPid !== null || incarnation !== null
      || sessionEpoch !== null || expectedProof !== null) return undefined;
  } else {
    const allKnown = ptyPid !== null && incarnation !== null && sessionEpoch !== null
      && expectedProof !== null;
    if (complete !== allKnown) return undefined;
  }
  return group as unknown as MainNativeBindingSnapshot;
}

/**
 * Independent bounded diagnostic group for the actual owner's inner ConPTY
 * original public onData deliveries at census time: the bounded numeric mode
 * requests observed on the exact owned original-handle public data events
 * (cumulative, not per-session-epoch), cross-bound to the same original PID /
 * incarnation. Diagnosis only — it never claims byte delivery to Main's
 * parser, negotiated terminal state, or a mirror decision, and it carries no
 * raw payload, id, token, socket path, frame, environment, or proof. scope
 * true means the received observation ran inside an intact matched live owner
 * view with the original binding revalidated; scope null means it was never
 * established; scope false is a sticky supported-scope disturbance.
 */
export interface MainInnerReceivedSnapshot {
  /** True only when the received observation ran inside an intact matched live owner view. */
  readonly scope: boolean | null;
  /** True only when every counter below is positively known with the original PID/incarnation. */
  readonly complete: boolean | null;
  /** The once-positive original public ConPTY PID; null only when scope is not true. */
  readonly ptyPid: number | null;
  /** The current owned-handle incarnation, paired exactly with ptyPid. */
  readonly incarnation: number | null;
  /** Public string data events delivered on the exact owned original handle. */
  readonly dataEvents: number | null;
  readonly mouseX10Set: number | null;
  readonly mouseX10Reset: number | null;
  readonly mouseVt200Set: number | null;
  readonly mouseVt200Reset: number | null;
  readonly mouseDragSet: number | null;
  readonly mouseDragReset: number | null;
  readonly mouseAnySet: number | null;
  readonly mouseAnyReset: number | null;
  readonly mouseSgrSet: number | null;
  readonly mouseSgrReset: number | null;
  readonly alternateBufferSet: number | null;
  readonly alternateBufferReset: number | null;
  readonly bracketedPasteSet: number | null;
  readonly bracketedPasteReset: number | null;
}

/** Exact request leaf payload the parent writes to `main-census-request.json` in the owned fixture root. */
export interface MainModeCensusRequest {
  readonly schemaVersion: typeof MAIN_CENSUS_SCHEMA_VERSION;
  readonly nonce: string;
  /** The positively admitted original Main (outer ConPTY) PID. */
  readonly expectedMainPid: number;
}

/**
 * Binds the positively admitted original Main PID exactly once, at first
 * welcome-frame admission, and refuses any census request whose current outer
 * PTY identity differs from the retained value or whose original exit has
 * been observed. A later re-read of the handle's PID is never trusted on its
 * own.
 */
export class OriginalMainPidBinding {
  private retained?: number;

  /** Admits the exact owned outer ConPTY PID once; refuses repeats, exits, and non-numeric PIDs. */
  admit(currentPid: number | string, exitObserved: boolean): number {
    if (this.retained !== undefined) throw new Error("original Main PID was already admitted");
    if (exitObserved) throw new Error("original Main PID admission requires a live outer ConPTY");
    if (typeof currentPid !== "number" || !Number.isSafeInteger(currentPid) || currentPid <= 1) {
      throw new Error("the exact owned outer ConPTY has no positively admitted public PID");
    }
    this.retained = currentPid;
    return currentPid;
  }

  /** Returns the retained PID, refusing identity drift or an observed original exit. */
  request(currentPid: number | string, exitObserved: boolean): number {
    if (this.retained === undefined) throw new Error("original Main PID was never admitted");
    if (exitObserved) throw new Error("the original Main ConPTY exit was observed before the census request");
    if (currentPid !== this.retained) throw new Error("the outer ConPTY identity differs from the admitted original Main PID");
    return this.retained;
  }
}

/** Exact reply leaf payload the runner writes, bound to its genuine process.pid. */
export interface MainModeCensusSnapshot {
  readonly schemaVersion: typeof MAIN_CENSUS_SCHEMA_VERSION;
  readonly nonce: string;
  /** The runner's genuine process.pid, equal to the positively admitted PID. */
  readonly mainPid: number;
  /** process.stdout at snapshot time is still the retained hooked stream. */
  readonly sameOutputStream: boolean;
  /** The owned observation hook still occupies the stream's write slot. */
  readonly hookActive: boolean;
  /** True only when the complete supported scope was observed without unknown state. */
  readonly observationComplete: boolean;
  /** Original non-throwing write calls offered through the retained stream. */
  readonly writeCalls: number | null;
  readonly mouseX10Set: number | null;
  readonly mouseX10Reset: number | null;
  readonly mouseVt200Set: number | null;
  readonly mouseVt200Reset: number | null;
  readonly mouseDragSet: number | null;
  readonly mouseDragReset: number | null;
  readonly mouseAnySet: number | null;
  readonly mouseAnyReset: number | null;
  readonly mouseSgrSet: number | null;
  readonly mouseSgrReset: number | null;
  readonly alternateBufferSet: number | null;
  readonly alternateBufferReset: number | null;
  readonly bracketedPasteSet: number | null;
  readonly bracketedPasteReset: number | null;
  /** Independent bounded diagnostic group for the actual active pane. */
  readonly activePane: MainActivePaneSnapshot;
  /** Independent bounded native-binding group for the actual owner's native child. */
  readonly nativeBinding: MainNativeBindingSnapshot;
  /** Independent bounded inner-received group for the actual owner's original handle. */
  readonly innerReceived: MainInnerReceivedSnapshot;
}

const CENSUS_COUNT_FIELDS = [
  "writeCalls",
  "mouseX10Set", "mouseX10Reset",
  "mouseVt200Set", "mouseVt200Reset",
  "mouseDragSet", "mouseDragReset",
  "mouseAnySet", "mouseAnyReset",
  "mouseSgrSet", "mouseSgrReset",
  "alternateBufferSet", "alternateBufferReset",
  "bracketedPasteSet", "bracketedPasteReset",
] as const;

const CENSUS_REPLY_KEYS = [
  "schemaVersion", "nonce", "mainPid",
  "hookActive", "sameOutputStream", "observationComplete", "activePane", "nativeBinding", "innerReceived",
  ...CENSUS_COUNT_FIELDS,
].sort();

/** Exact bounded inner-received field names, sorted as the validator expects. */
const INNER_RECEIVED_KEYS = [
  "complete", "dataEvents", "incarnation", "ptyPid", "scope",
  ...CENSUS_COUNT_FIELDS.filter((field) => field !== "writeCalls"),
].sort();

/** The bounded inner-received counter fields, in diagnostic order. */
const INNER_RECEIVED_COUNT_FIELDS = [
  "dataEvents",
  ...CENSUS_COUNT_FIELDS.filter((field) => field !== "writeCalls"),
];

/**
 * Strict validation of the independent inner-received group: exact key set,
 * real scope/complete values, safe-integer bounded non-negative counters, and
 * the PID/incarnation pair coherence. scope null keeps everything null;
 * scope false is a sticky disturbance with complete false and all null;
 * scope true always requires the paired positive original PID/incarnation
 * (a pending PID never establishes it) — an incomplete positive scope keeps
 * the known PID/incarnation but ALL counters stay null (never partial). Returns undefined for any malformed or
 * incoherent group; it never borrows zeros or stale success.
 */
export function validateMainInnerReceivedSnapshot(value: unknown): MainInnerReceivedSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const group = value as Record<string, unknown>;
  const keys = Object.keys(group).sort();
  if (keys.length !== INNER_RECEIVED_KEYS.length || keys.some((key, index) => key !== INNER_RECEIVED_KEYS[index])) {
    return undefined;
  }
  const { scope, complete } = group;
  if (typeof scope !== "boolean" && scope !== null) return undefined;
  if (typeof complete !== "boolean" && complete !== null) return undefined;
  const ptyPid = group.ptyPid;
  if (ptyPid !== null && (!Number.isSafeInteger(ptyPid) || (ptyPid as number) <= 1)) return undefined;
  const incarnation = group.incarnation;
  if (incarnation !== null && (!Number.isSafeInteger(incarnation) || (incarnation as number) < 1)) return undefined;
  // Pair coherence: the PID/incarnation pair travels together or not at all.
  if ((ptyPid === null) !== (incarnation === null)) return undefined;
  for (const field of INNER_RECEIVED_COUNT_FIELDS) {
    const count = group[field];
    if (count !== null && (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > MAIN_CENSUS_COUNT_LIMIT)) {
      return undefined;
    }
  }
  const allCountsNull = INNER_RECEIVED_COUNT_FIELDS.every((field) => group[field] === null);
  const allCountsKnown = INNER_RECEIVED_COUNT_FIELDS.every((field) => typeof group[field] === "number");
  if (scope === null) {
    if (complete !== null || ptyPid !== null || !allCountsNull) return undefined;
  } else if (scope === false) {
    if (complete !== false || ptyPid !== null || !allCountsNull) return undefined;
  } else {
    // A positive scope always requires the original positive PID/incarnation;
    // a still-pending PID never establishes the received scope.
    if (ptyPid === null) return undefined;
    if (complete === true) {
      if (!allCountsKnown) return undefined;
    } else if (complete !== false || !allCountsNull) {
      return undefined; // incomplete keeps the known PID/incarnation but never partial counters
    }
  }
  return group as unknown as MainInnerReceivedSnapshot;
}

/**
 * Strict validation of one fresh census reply: exact key set, schema version,
 * nonce, exact positively admitted Main PID, real booleans — a complete
 * observation requires both the active hook and the retained stream — and
 * either all bounded non-negative integer counts (complete) or all null
 * (unknown). Returns undefined for any malformed, partial, replayed,
 * wrong-PID, impossible-flag, or out-of-cap value; it never borrows zeros or
 * stale success.
 */
export function validateMainModeCensusReply(
  value: unknown,
  expected: { readonly nonce: string; readonly expectedMainPid: number },
): MainModeCensusSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reply = value as Record<string, unknown>;
  const keys = Object.keys(reply).sort();
  if (keys.length !== CENSUS_REPLY_KEYS.length || keys.some((key, index) => key !== CENSUS_REPLY_KEYS[index])) {
    return undefined;
  }
  if (reply.schemaVersion !== MAIN_CENSUS_SCHEMA_VERSION) return undefined;
  if (typeof reply.nonce !== "string" || reply.nonce !== expected.nonce) return undefined;
  if (typeof reply.mainPid !== "number" || !Number.isSafeInteger(reply.mainPid)
    || reply.mainPid <= 1 || reply.mainPid !== expected.expectedMainPid) {
    return undefined;
  }
  if (typeof reply.hookActive !== "boolean" || typeof reply.sameOutputStream !== "boolean"
    || typeof reply.observationComplete !== "boolean") {
    return undefined;
  }
  if (reply.observationComplete === true && (!reply.hookActive || !reply.sameOutputStream)) {
    return undefined; // a complete observation requires the active hook and the retained stream
  }
  for (const field of CENSUS_COUNT_FIELDS) {
    const count = reply[field];
    if (reply.observationComplete === true) {
      if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > MAIN_CENSUS_COUNT_LIMIT) {
        return undefined;
      }
    } else if (count !== null) {
      return undefined;
    }
  }
  // The active-pane group is validated independently: an unknown producer
  // scope never erases honest pane data, and an unknown pane never erases
  // honest producer counts.
  const activePane = validateMainActivePaneSnapshot(reply.activePane);
  if (activePane === undefined) return undefined;
  // The native-binding group is validated independently of the producer
  // scope, but a positively established binding requires the full upstream
  // actual-owner guard chain in the pane group: owner present, matched live
  // row, and alive lifecycle. An unknown pane never carries a known binding.
  const nativeBinding = validateMainNativeBindingSnapshot(reply.nativeBinding);
  if (nativeBinding === undefined) return undefined;
  if (nativeBinding.scope === true
    && !(activePane.ownerPresent === true && activePane.viewMatched === true
      && activePane.hasLiveProcess === true && activePane.lifecycleAlive === true)) {
    return undefined;
  }
  // The inner-received group is validated independently of the producer and
  // pane scopes — an unknown received scope never erases honest other groups
  // and vice versa — but a positively established received scope requires the
  // full upstream actual-owner guard chain and the identical original binding
  // PID/incarnation: an unknown pane or binding never carries a known
  // received scope, and a mismatched original identity is refused.
  const innerReceived = validateMainInnerReceivedSnapshot(reply.innerReceived);
  if (innerReceived === undefined) return undefined;
  if (innerReceived.scope === true) {
    if (!(activePane.scope === true && activePane.complete === true
      && activePane.ownerPresent === true && activePane.focusMain === true && activePane.viewMatched === true
      && activePane.hasLiveProcess === true && activePane.lifecycleAlive === true
      && activePane.surfacePresent === true && activePane.modesReadSucceeded === true)) {
      return undefined;
    }
    if (nativeBinding.scope !== true || nativeBinding.complete !== true
      || nativeBinding.ptyPid === null || nativeBinding.incarnation === null) {
      return undefined;
    }
    if (nativeBinding.ptyPid !== innerReceived.ptyPid || nativeBinding.incarnation !== innerReceived.incarnation) {
      return undefined;
    }
  }
  return reply as unknown as MainModeCensusSnapshot;
}

/**
 * Bounded metadata-only diagnostic line for a failed pre-Quit mode assertion.
 * Emits only the census booleans and bounded integer/null counts: no raw
 * stream data, frame, transcript, prompt, path, environment, or user string,
 * and no negotiated-mode or causal claim.
 */
export function formatMainCensusDiagnostic(snapshot: MainModeCensusSnapshot | undefined): string {
  if (snapshot === undefined) return "mainCensusDiag{absent}";
  const count = (value: number | null): string =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "null";
  const flag = (value: boolean | null): string => value === true ? "true" : value === false ? "false" : "null";
  const pane = snapshot.activePane;
  const binding = snapshot.nativeBinding;
  const received = snapshot.innerReceived;
  return [
    "mainCensusDiag{",
    `complete=${snapshot.observationComplete}`,
    `hookActive=${snapshot.hookActive}`,
    `sameStream=${snapshot.sameOutputStream}`,
    `pid=${Number.isSafeInteger(snapshot.mainPid) && snapshot.mainPid > 0 ? snapshot.mainPid : -1}`,
    `calls=${count(snapshot.writeCalls)}`,
    `x10Set=${count(snapshot.mouseX10Set)} x10Reset=${count(snapshot.mouseX10Reset)}`,
    `vt200Set=${count(snapshot.mouseVt200Set)} vt200Reset=${count(snapshot.mouseVt200Reset)}`,
    `dragSet=${count(snapshot.mouseDragSet)} dragReset=${count(snapshot.mouseDragReset)}`,
    `anySet=${count(snapshot.mouseAnySet)} anyReset=${count(snapshot.mouseAnyReset)}`,
    `sgrSet=${count(snapshot.mouseSgrSet)} sgrReset=${count(snapshot.mouseSgrReset)}`,
    `altSet=${count(snapshot.alternateBufferSet)} altReset=${count(snapshot.alternateBufferReset)}`,
    `pasteSet=${count(snapshot.bracketedPasteSet)} pasteReset=${count(snapshot.bracketedPasteReset)}`,
    `activePane{complete=${flag(pane.complete)} scope=${flag(pane.scope)} owner=${flag(pane.ownerPresent)}`,
    `focusMain=${flag(pane.focusMain)} viewMatched=${flag(pane.viewMatched)} live=${flag(pane.hasLiveProcess)}`,
    `alive=${flag(pane.lifecycleAlive)} surface=${flag(pane.surfacePresent)} modesRead=${flag(pane.modesReadSucceeded)}`,
    `tracking=${count(pane.mouseTracking)} encoding=${count(pane.mouseEncoding)}`,
    `geomCols=${count(pane.geometryColumns)} geomRows=${count(pane.geometryRows)}}`,
    `nativeBinding{scope=${flag(binding.scope)} complete=${flag(binding.complete)}`,
    `pid=${count(binding.ptyPid)} inc=${count(binding.incarnation)}`,
    `epoch=${count(binding.sessionEpoch)} proof=${binding.expectedProof !== null ? "ok" : "none"}}`,
    `innerReceived{scope=${flag(received.scope)} complete=${flag(received.complete)}`,
    `pid=${count(received.ptyPid)} inc=${count(received.incarnation)} events=${count(received.dataEvents)}`,
    `x10Set=${count(received.mouseX10Set)} x10Reset=${count(received.mouseX10Reset)}`,
    `vt200Set=${count(received.mouseVt200Set)} vt200Reset=${count(received.mouseVt200Reset)}`,
    `dragSet=${count(received.mouseDragSet)} dragReset=${count(received.mouseDragReset)}`,
    `anySet=${count(received.mouseAnySet)} anyReset=${count(received.mouseAnyReset)}`,
    `sgrSet=${count(received.mouseSgrSet)} sgrReset=${count(received.mouseSgrReset)}`,
    `altSet=${count(received.alternateBufferSet)} altReset=${count(received.alternateBufferReset)}`,
    `pasteSet=${count(received.bracketedPasteSet)} pasteReset=${count(received.bracketedPasteReset)}}}`,
  ].join(" ");
}
