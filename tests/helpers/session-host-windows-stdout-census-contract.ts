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
  "hookActive", "sameOutputStream", "observationComplete",
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
    "}",
  ].join(" ");
}
