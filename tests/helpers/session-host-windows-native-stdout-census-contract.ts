/**
 * Pure contracts for the fresh native-child original-stdout census: the
 * strict request/reply schema between the acceptance harness and the native
 * child's test preload, the exact correlation of one fresh reply against the
 * Main reply's actual-owner native binding, and the bounded metadata-only
 * diagnostic line. No I/O, no process, no terminal dependencies.
 *
 * The census is diagnosis only: it reports mode requests offered through the
 * retained native child stdout upstream of Main's inner pane parsing, never
 * negotiated, delivered, or settled terminal state. Correlation is essential:
 * a fresh reply is accepted only for the exact request nonce, the expected
 * native PID, and the current actual-owner binding (session epoch and the
 * opaque expected proof, which binds the raw session id privately on both
 * sides). Ambiguous, stale, changed, or partial observations
 * are refusals — never zero counts, known absence, or positive scope. The
 * original Main PTY incarnation is NOT carried by the reply; the parent
 * cross-binds originalPID => incarnation from its own pending=>positive pty
 * journal ledger independently. No token, socket path, instance identity, or
 * raw tuple ever appears in a request, reply, or diagnostic.
 */

import { type MainNativeBindingSnapshot } from "./session-host-windows-stdout-census-contract";

export const NATIVE_CENSUS_SCHEMA_VERSION = 1;

/** Upper bound every native census counter may report; beyond it the census is unknown. */
export const NATIVE_CENSUS_COUNT_LIMIT = 2 ** 31 - 1;

/** Fixed known child leaves under the per-native-PID directory. */
export const NATIVE_CENSUS_REQUEST_FILENAME = "native-census-request.json";
export const NATIVE_CENSUS_REPLY_FILENAME = "native-census-reply.json";

const NATIVE_CENSUS_NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const NATIVE_PROOF_PATTERN = /^[0-9a-f]{64}$/;
/** Bounded native session id, mirroring the repo protocol bound (the raw id itself never crosses the wire). */
export const NATIVE_SESSION_ID_MAX_BYTES = 256;

export function isValidNativeProof(value: unknown): value is string {
  return typeof value === "string" && NATIVE_PROOF_PATTERN.test(value);
}

/** Exact request leaf payload the parent writes to `native-census-request.json`. */
export interface NativeStdoutCensusRequest {
  readonly schemaVersion: typeof NATIVE_CENSUS_SCHEMA_VERSION;
  /** Fresh one-shot nonce binding the single reply (replay protection). */
  readonly nonce: string;
  /** The Main census nonce under which Main computed the expected private proof. */
  readonly proofNonce: string;
  /** The positively cross-admitted native child PID (inner ConPTY original PID). */
  readonly expectedNativePid: number;
}

/**
 * Exact reply leaf payload the native child writes, bound to its genuine
 * process.pid. The count fields are independent of the metadata scope: an
 * unknown binding never erases honest counts, and unknown counts never erase
 * a known binding.
 */
export interface NativeStdoutCensusSnapshot {
  readonly schemaVersion: typeof NATIVE_CENSUS_SCHEMA_VERSION;
  readonly nonce: string;
  /** The native child's genuine process.pid, equal to the expected PID. */
  readonly nativePid: number;
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
  /** True only when the current sticky state was positively validated at snapshot time. */
  readonly bindingScope: boolean;
  /** Current sticky native session epoch, only when >= 1 (the raw session id stays private). */
  readonly sessionEpoch: number | null;
  /** Fresh private proof (opaque 64-hex), only for a positively known binding. */
  readonly proof: string | null;
}

const NATIVE_COUNT_FIELDS = [
  "writeCalls",
  "mouseX10Set", "mouseX10Reset",
  "mouseVt200Set", "mouseVt200Reset",
  "mouseDragSet", "mouseDragReset",
  "mouseAnySet", "mouseAnyReset",
  "mouseSgrSet", "mouseSgrReset",
  "alternateBufferSet", "alternateBufferReset",
  "bracketedPasteSet", "bracketedPasteReset",
] as const;

const NATIVE_REPLY_KEYS = [
  "schemaVersion", "nonce", "nativePid",
  "hookActive", "sameOutputStream", "observationComplete",
  "bindingScope", "sessionEpoch", "proof",
  ...NATIVE_COUNT_FIELDS,
].sort();

/**
 * Strict validation of one fresh native census reply: exact key set, schema
 * version, nonce, exact expected native PID, real booleans — a complete
 * observation requires both the active hook and the retained stream — and
 * either all bounded non-negative integer counts (complete) or all null
 * (unknown). The binding fields are coherent: a proof requires its full
 * tuple, and an unknown binding scope carries no session data. Returns
 * undefined for any malformed, partial, replayed, wrong-PID, impossible-flag,
 * or out-of-cap value; it never borrows zeros or stale success.
 */
export function validateNativeCensusReply(
  value: unknown,
  expected: { readonly nonce: string; readonly expectedNativePid: number },
): NativeStdoutCensusSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reply = value as Record<string, unknown>;
  const keys = Object.keys(reply).sort();
  if (keys.length !== NATIVE_REPLY_KEYS.length || keys.some((key, index) => key !== NATIVE_REPLY_KEYS[index])) {
    return undefined;
  }
  if (reply.schemaVersion !== NATIVE_CENSUS_SCHEMA_VERSION) return undefined;
  if (typeof reply.nonce !== "string" || !NATIVE_CENSUS_NONCE.test(reply.nonce) || reply.nonce !== expected.nonce) {
    return undefined;
  }
  if (typeof reply.nativePid !== "number" || !Number.isSafeInteger(reply.nativePid)
    || reply.nativePid <= 1 || reply.nativePid !== expected.expectedNativePid) {
    return undefined;
  }
  if (typeof reply.hookActive !== "boolean" || typeof reply.sameOutputStream !== "boolean"
    || typeof reply.observationComplete !== "boolean") {
    return undefined;
  }
  if (reply.observationComplete === true && (!reply.hookActive || !reply.sameOutputStream)) {
    return undefined; // a complete observation requires the active hook and the retained stream
  }
  for (const field of NATIVE_COUNT_FIELDS) {
    const count = reply[field];
    if (reply.observationComplete === true) {
      if (!Number.isSafeInteger(count) || (count as number) < 0 || (count as number) > NATIVE_CENSUS_COUNT_LIMIT) {
        return undefined;
      }
    } else if (count !== null) {
      return undefined;
    }
  }
  if (typeof reply.bindingScope !== "boolean") return undefined;
  const sessionEpoch = reply.sessionEpoch;
  if (sessionEpoch !== null && (!Number.isSafeInteger(sessionEpoch) || (sessionEpoch as number) < 1)) {
    return undefined;
  }
  const proof = reply.proof;
  if (proof !== null && (typeof proof !== "string" || !NATIVE_PROOF_PATTERN.test(proof))) return undefined;
  // Coherence: the epoch and the proof travel together with a positively known
  // binding; an unknown binding scope carries no session data at all. The raw
  // native session id is never on the wire: the opaque proof binds it.
  if ((sessionEpoch === null) !== (proof === null)) return undefined;
  if (proof !== null && reply.bindingScope !== true) return undefined;
  return reply as unknown as NativeStdoutCensusSnapshot;
}

/**
 * Exact correlation of one fresh native reply against the Main reply's
 * actual-owner native binding: the reply must bind the same nonce, the same
 * expected native PID as the binding's inner ConPTY original PID, the same
 * current session epoch, and the identical opaque expected proof (which binds
 * the raw session id privately on both sides). The parent additionally
 * cross-binds the incarnation from its own pty journal ledger (not carried by
 * the reply). Returns undefined for any mismatch — never a zero-count or
 * absence fallback.
 */
export function validateNativeCensusCorrelation(
  value: unknown,
  expected: {
    readonly nonce: string;
    readonly expectedNativePid: number;
    readonly binding: MainNativeBindingSnapshot;
  },
): NativeStdoutCensusSnapshot | undefined {
  const reply = validateNativeCensusReply(value, {
    nonce: expected.nonce,
    expectedNativePid: expected.expectedNativePid,
  });
  if (reply === undefined) return undefined;
  const { binding } = expected;
  if (binding.scope !== true || binding.complete !== true) return undefined;
  if (binding.ptyPid !== expected.expectedNativePid) return undefined;
  if (reply.nativePid !== binding.ptyPid) return undefined;
  if (reply.sessionEpoch !== binding.sessionEpoch) return undefined;
  if (!isValidNativeProof(binding.expectedProof)) return undefined;
  if (reply.proof !== binding.expectedProof) return undefined; // stale/changed/corrupt: refusal
  return reply;
}

/**
 * Bounded metadata-only diagnostic line for a failed pre-Quit mode assertion.
 * Emits only the census booleans and bounded integer/null counts plus the
 * binding scope/epoch and a proof present/absent flag: no raw stream data,
 * frame, transcript, prompt, path, environment, user string, session id, or
 * proof value, and no negotiated-mode or causal claim.
 */
export function formatNativeCensusDiagnostic(snapshot: NativeStdoutCensusSnapshot | undefined): string {
  if (snapshot === undefined) return "nativeCensusDiag{absent}";
  const count = (value: number | null): string =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : "null";
  const flag = (value: boolean | null): string => value === true ? "true" : value === false ? "false" : "null";
  return [
    "nativeCensusDiag{",
    `complete=${snapshot.observationComplete}`,
    `hookActive=${snapshot.hookActive}`,
    `sameStream=${snapshot.sameOutputStream}`,
    `pid=${Number.isSafeInteger(snapshot.nativePid) && snapshot.nativePid > 0 ? snapshot.nativePid : -1}`,
    `calls=${count(snapshot.writeCalls)}`,
    `x10Set=${count(snapshot.mouseX10Set)} x10Reset=${count(snapshot.mouseX10Reset)}`,
    `vt200Set=${count(snapshot.mouseVt200Set)} vt200Reset=${count(snapshot.mouseVt200Reset)}`,
    `dragSet=${count(snapshot.mouseDragSet)} dragReset=${count(snapshot.mouseDragReset)}`,
    `anySet=${count(snapshot.mouseAnySet)} anyReset=${count(snapshot.mouseAnyReset)}`,
    `sgrSet=${count(snapshot.mouseSgrSet)} sgrReset=${count(snapshot.mouseSgrReset)}`,
    `altSet=${count(snapshot.alternateBufferSet)} altReset=${count(snapshot.alternateBufferReset)}`,
    `pasteSet=${count(snapshot.bracketedPasteSet)} pasteReset=${count(snapshot.bracketedPasteReset)}`,
    `scope=${flag(snapshot.bindingScope)}`,
    `epoch=${count(snapshot.sessionEpoch)}`,
    `proof=${snapshot.proof !== null ? "ok" : "none"}}`,
  ].join(" ");
}
