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
  "hookActive", "sameOutputStream", "observationComplete", "activePane",
  ...CENSUS_COUNT_FIELDS,
].sort();

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
  if (validateMainActivePaneSnapshot(reply.activePane) === undefined) return undefined;
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
    "}",
  ].join(" ");
}
