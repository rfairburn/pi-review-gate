/**
 * #682: ONE canonical managed outcome to ONE exact owned Codex root thread,
 * composed from the landed primitives only:
 *
 * - the trusted write transport ({@linkcode openNativeCodexCallbackTransport})
 *   to the exact owned app-server of the caller's retained lease;
 * - the callback route composer ({@linkcode createNativeCodexCallbackComposer})
 *   over the owner-private callback root facts of that same lease's TUI relay.
 *
 * Nothing here is new delivery semantics: busy steer, idle queue, the busy-race
 * switch, user-stop declines, and every write-edge fence are the composer's
 * and transport's. This module adds only the per-attempt lifecycle:
 *
 * 1. A synchronous pre-check (signal, the caller's ownership predicate, and a
 *    facts read that names the owned thread and run, with no user stop and a
 *    known activity). Failing it opens nothing and writes nothing.
 * 2. One transport open on the caller's signal. `unavailable` wrote no
 *    callback frame (only an `initialize` at most), so it is `not-delivered`.
 * 3. One composer over that transport, one `deliver` with the caller's id.
 * 4. The transport is closed at once, whatever happened; nothing is kept open
 *    between callbacks, retried, or replayed.
 *
 * The caller (the owning manager) proves the lease, the owned thread and run,
 * the predicate, and the version attestation. This module never chooses a
 * backend, never touches a PTY, never answers an approval, and never calls
 * `turn/start` (neither primitive can).
 */
import type { OwnedCodexBackendLease } from "./native-codex-backend";
import {
  createNativeCodexCallbackComposer,
  type NativeCodexCallbackComposedDelivery,
  type NativeCodexCallbackComposedOutcome,
  type NativeCodexCallbackOwnedRun,
  type NativeCodexCallbackRootFacts,
} from "./native-codex-callback-composition";
import {
  openNativeCodexCallbackTransport,
  type NativeCodexCallbackTransportUnavailableCode,
} from "./native-codex-callback-transport";

export interface NativeCodexManagedDeliveryInput {
  /** The owner's exact retained lease for the run. */
  readonly lease: Pick<OwnedCodexBackendLease, "identity" | "readiness" | "status">;
  /** The exact owned root thread and relay generation, from host state. */
  readonly owned: NativeCodexCallbackOwnedRun;
  /** Owner-private synchronous callback root facts of that same lease. */
  readonly readFacts: () => NativeCodexCallbackRootFacts | null;
  /** Synchronous pure re-proof that this lease generation still owns `owned`. */
  readonly isOwnedRunCurrent: () => boolean;
  /** The owner's version-backed expected-turn steer attestation. */
  readonly attestation: { readonly expectedTurnSteer: true };
  /** Revocation of the owning run (and the caller's own cancellation). */
  readonly signal: AbortSignal;
  readonly clientUserMessageId: string;
  readonly text: string;
}

export type NativeCodexManagedDeliveryResult =
  | {
      /** Nothing was opened: the run, facts, or stop state forbade it. */
      readonly route: "precheck-declined";
      readonly reason: "aborted" | "not-current" | "facts-unknown" | "facts-stale" | "user-stopped";
      readonly delivery: "not-delivered";
    }
  | {
      /** The transport never became ready; no callback frame was written. */
      readonly route: "transport-unavailable";
      readonly code: NativeCodexCallbackTransportUnavailableCode;
      readonly delivery: "not-delivered";
      readonly socketClosed: Promise<void>;
    }
  | {
      readonly route: "composed";
      readonly outcome: NativeCodexCallbackComposedOutcome;
      readonly delivery: NativeCodexCallbackComposedDelivery;
      /** Physical close proof of the per-attempt socket. Never rejects. */
      readonly socketClosed: Promise<void>;
    };

function precheck(input: NativeCodexManagedDeliveryInput): Extract<NativeCodexManagedDeliveryResult, { route: "precheck-declined" }> | null {
  const declined = (reason: Extract<NativeCodexManagedDeliveryResult, { route: "precheck-declined" }>["reason"]) =>
    Object.freeze({ route: "precheck-declined" as const, reason, delivery: "not-delivered" as const });
  if (input.signal.aborted) return declined("aborted");
  let current = false;
  try {
    current = input.isOwnedRunCurrent() === true;
  } catch {
    current = false;
  }
  if (!current) return declined("not-current");
  let facts: NativeCodexCallbackRootFacts | null;
  try {
    facts = input.readFacts();
  } catch {
    return declined("facts-unknown");
  }
  if (facts === null || typeof facts !== "object") return declined("facts-unknown");
  if (facts.threadId !== input.owned.threadId || facts.runId !== input.owned.runId) return declined("facts-stale");
  if (facts.userStop !== "none") return declined("user-stopped");
  if (facts.activity?.state !== "busy" && facts.activity?.state !== "idle") return declined("facts-unknown");
  return null;
}

/** One attempt. Never rejects; never retries; the socket is closed before it resolves. */
export async function deliverNativeCodexManagedCallback(
  input: NativeCodexManagedDeliveryInput,
): Promise<NativeCodexManagedDeliveryResult> {
  const early = precheck(input);
  if (early !== null) return early;
  const opened = await openNativeCodexCallbackTransport({
    lease: input.lease,
    owned: input.owned,
    isOwnedRunCurrent: input.isOwnedRunCurrent,
    attestation: input.attestation,
    signal: input.signal,
  });
  if (opened.status !== "ready") {
    return Object.freeze({
      route: "transport-unavailable" as const,
      code: opened.code,
      delivery: "not-delivered" as const,
      socketClosed: opened.socketClosed,
    });
  }
  const transport = opened.transport;
  try {
    const composer = createNativeCodexCallbackComposer({
      owned: input.owned,
      readFacts: input.readFacts,
      steerLane: transport.steerLane,
      queueLane: transport.queueLane,
    });
    const outcome = await composer.deliver({ clientUserMessageId: input.clientUserMessageId, text: input.text });
    return Object.freeze({ route: "composed" as const, outcome, delivery: outcome.delivery, socketClosed: transport.socketClosed });
  } catch {
    // The composer never rejects by contract; a fault after a possible write is unknown.
    return Object.freeze({
      route: "composed" as const,
      outcome: Object.freeze({ route: "fault" as const, delivery: "unknown" as const }),
      delivery: "unknown" as const,
      socketClosed: transport.socketClosed,
    });
  } finally {
    transport.close();
  }
}
