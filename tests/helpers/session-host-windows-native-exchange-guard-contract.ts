/**
 * Pure contracts for the fresh original-Main-origin native exchange guard:
 * the strict request/reply schema between the acceptance harness and the
 * runner's armed guard, the exact correlation of one fresh reply against the
 * Main census's actual-owner native binding, and the fixed known root leaves.
 * No I/O, no process, no terminal dependencies.
 *
 * The guard is diagnosis-only provenance certification: it proves that the
 * genuine original Main process revalidated its armed private binding (owner,
 * current authenticated native session tuple, original native PTY PID/
 * incarnation, consumed bootstrap) and its current actual scope (focus, live
 * row, surface, module identity, self PID, geometry) at reply time. The
 * reply is accepted only for the exact fresh request nonce, the retained
 * admitted original Main PID, the initial arm nonce (the Main census nonce),
 * the armed original native PID, and the identical opaque expected proof
 * (which the parent already correlated against the native child's independent
 * fresh proof at census receipt). The raw session id, bootstrap tuple, token,
 * socket path, and instance identity never appear in a request or reply.
 */

import { type MainNativeBindingSnapshot } from "./session-host-windows-stdout-census-contract";

export const NATIVE_EXCHANGE_GUARD_SCHEMA_VERSION = 1;

/** Fixed known root leaves for the single fresh guard exchange. */
export const GUARD_REQUEST_FILENAME = "native-exchange-guard-request.json";
export const GUARD_REPLY_FILENAME = "native-exchange-guard-reply.json";

const GUARD_NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const GUARD_PROOF_PATTERN = /^[0-9a-f]{64}$/;

/** Exact request leaf payload the parent writes to `native-exchange-guard-request.json`. */
export interface NativeExchangeGuardRequest {
  readonly schemaVersion: typeof NATIVE_EXCHANGE_GUARD_SCHEMA_VERSION;
  /** Fresh one-shot nonce binding the single reply (replay protection). */
  readonly nonce: string;
  /** The retained admitted original Main PID. */
  readonly expectedMainPid: number;
  /** The initial arm nonce: the Main census nonce under which the guard armed and the proof was computed. */
  readonly proofNonce: string;
  /** The armed original native child PID (inner ConPTY original PID). */
  readonly expectedOriginalNativePID: number;
}

/**
 * Exact reply leaf payload the runner's armed guard writes, bound to its
 * genuine process.pid and the initial arm nonce. The numeric originals
 * (incarnation, session epoch) and the opaque proof are the armed binding's
 * values, freshly revalidated at serve time.
 */
export interface NativeExchangeGuardSnapshot {
  readonly schemaVersion: typeof NATIVE_EXCHANGE_GUARD_SCHEMA_VERSION;
  readonly nonce: string;
  /** The runner's genuine process.pid, equal to the retained admitted Main PID. */
  readonly mainPid: number;
  /** The initial arm nonce (the Main census nonce). */
  readonly proofNonce: string;
  /** The armed original native child PID. */
  readonly expectedOriginalNativePID: number;
  /** The armed original PTY incarnation (pending => positive ledger value). */
  readonly incarnation: number;
  /** The armed current authenticated native session epoch. */
  readonly sessionEpoch: number;
  /** The armed binding's expected fresh private proof (opaque 64-hex). */
  readonly proof: string;
}

const GUARD_REPLY_KEYS = [
  "schemaVersion", "nonce", "mainPid", "proofNonce", "expectedOriginalNativePID",
  "incarnation", "sessionEpoch", "proof",
].sort();

/**
 * Strict validation of one fresh guard reply: exact key set, schema version,
 * the exact fresh request nonce, the exact retained admitted Main PID, the
 * exact initial arm nonce, the exact armed original native PID, positive
 * numeric originals, and an opaque 64-hex proof. Returns undefined for any
 * malformed, partial, replayed, or wrong-PID/nonce value; it never borrows
 * stale success.
 */
export function validateNativeExchangeGuardReply(
  value: unknown,
  expected: {
    readonly nonce: string;
    readonly expectedMainPid: number;
    readonly proofNonce: string;
    readonly expectedOriginalNativePID: number;
  },
): NativeExchangeGuardSnapshot | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const reply = value as Record<string, unknown>;
  const keys = Object.keys(reply).sort();
  if (keys.length !== GUARD_REPLY_KEYS.length || keys.some((key, index) => key !== GUARD_REPLY_KEYS[index])) {
    return undefined;
  }
  if (reply.schemaVersion !== NATIVE_EXCHANGE_GUARD_SCHEMA_VERSION) return undefined;
  if (typeof reply.nonce !== "string" || !GUARD_NONCE.test(reply.nonce) || reply.nonce !== expected.nonce) {
    return undefined;
  }
  if (typeof reply.mainPid !== "number" || !Number.isSafeInteger(reply.mainPid)
    || reply.mainPid <= 1 || reply.mainPid !== expected.expectedMainPid) {
    return undefined;
  }
  if (typeof reply.proofNonce !== "string" || !GUARD_NONCE.test(reply.proofNonce)
    || reply.proofNonce !== expected.proofNonce) {
    return undefined;
  }
  if (typeof reply.expectedOriginalNativePID !== "number" || !Number.isSafeInteger(reply.expectedOriginalNativePID)
    || reply.expectedOriginalNativePID <= 1 || reply.expectedOriginalNativePID !== expected.expectedOriginalNativePID) {
    return undefined;
  }
  if (typeof reply.incarnation !== "number" || !Number.isSafeInteger(reply.incarnation) || reply.incarnation < 1) {
    return undefined;
  }
  if (typeof reply.sessionEpoch !== "number" || !Number.isSafeInteger(reply.sessionEpoch) || reply.sessionEpoch < 1) {
    return undefined;
  }
  if (typeof reply.proof !== "string" || !GUARD_PROOF_PATTERN.test(reply.proof)) return undefined;
  return reply as unknown as NativeExchangeGuardSnapshot;
}

/**
 * Exact correlation of one fresh guard reply against the Main census's
 * actual-owner native binding: the reply must bind the same armed original
 * native PID, the same incarnation and session epoch, and the identical
 * opaque expected proof (which binds the raw session id privately on both
 * sides). Returns undefined for any mismatch — never a zero-count or absence
 * fallback.
 */
export function validateNativeExchangeGuardCorrelation(
  value: unknown,
  expected: {
    readonly nonce: string;
    readonly expectedMainPid: number;
    readonly proofNonce: string;
    readonly expectedOriginalNativePID: number;
    readonly binding: MainNativeBindingSnapshot;
  },
): NativeExchangeGuardSnapshot | undefined {
  const reply = validateNativeExchangeGuardReply(value, expected);
  if (reply === undefined) return undefined;
  const { binding } = expected;
  if (binding.scope !== true || binding.complete !== true) return undefined;
  if (binding.ptyPid !== expected.expectedOriginalNativePID) return undefined;
  if (reply.expectedOriginalNativePID !== binding.ptyPid) return undefined;
  if (reply.incarnation !== binding.incarnation) return undefined;
  if (reply.sessionEpoch !== binding.sessionEpoch) return undefined;
  if (typeof binding.expectedProof !== "string" || !GUARD_PROOF_PATTERN.test(binding.expectedProof)) return undefined;
  if (reply.proof !== binding.expectedProof) return undefined; // stale/changed/corrupt: refusal
  return reply;
}
