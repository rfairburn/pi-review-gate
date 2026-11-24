/**
 * Codex-only callback route composition (#682): choose between the two
 * existing host-owned delivery primitives for ONE exact owned thread and run,
 * from host-trusted current root-turn facts.
 *
 * - busy root turn → the existing expected-turn `turn/steer` sender
 *   ({@linkcode createNativeCodexCallbackSteerSender});
 * - idle root → the existing atomic idle queue primitive
 *   ({@linkcode wakeIdleNativeCodexThread});
 * - anything else (unknown, stale, revoked, or a user stop) → declined, and
 *   nothing is written.
 *
 * ## Scope
 *
 * This is a pure composition over injected seams. It opens no connection,
 * subscribes to nothing, retains no callback text, and adds no inbox, queue,
 * engine, timer, retry, or backend wiring. It never calls `turn/start`,
 * `thread/resume`, or an interrupt, and it never answers a provider request
 * (approval, question, elicitation): neither primitive can, and this module
 * adds no reply path. The primitives are reused unchanged and their results are
 * returned verbatim alongside a closed summary.
 *
 * ## Trust inputs
 *
 * - `owned` is the exact thread and run the HOST owns, fixed at construction
 *   from its own state, never from a callback payload.
 * - `readFacts` is the host's synchronous current root-turn view for that run.
 *   Facts that are missing, unreadable, for another thread, or for another run
 *   decline delivery. Activity `unknown` and a user stop that is not positively
 *   `none` also decline: the composition never wakes a root after the user
 *   stopped it and never infers that they did not.
 *
 * ## Revocation fences
 *
 * - Busy: the steer sender's `readCurrentTarget` is derived from the same facts,
 *   so its pre-write check and the lane's write-edge guard both refuse once the
 *   run, thread, turn, or stop state no longer matches.
 * - Idle: the queue primitive has no write-edge guard of its own, and its
 *   generic caller may defer a write. So this composition does NOT accept that
 *   generic caller: it requires a branded host-owned queue lane
 *   ({@linkcode NativeCodexCallbackQueueLane}) that either writes synchronously
 *   inside `request` or calls the supplied `writeEdge.mayWrite()` immediately
 *   before its socket write and returns `not-sent` when it is false. The
 *   composition adapts that lane to the unchanged primitive. The same predicate
 *   is checked on entry and at the write edge:
 *   - `add`: the facts still name the owned thread and run, no user stop, and
 *     root activity is still idle with the same last turn as the idle decision.
 *     A turn that became busy before `add` declines with nothing written and no
 *     steer: `add` is itself a mutation that can dispatch before `start`;
 *   - `start`: owned thread and run, no user stop (a start after a user stop
 *     would be a wake); Codex repeats the idle check atomically;
 *   - `delete` (only after an explicit busy refusal, of our exact row): the
 *     facts still name the owned thread and run, whatever the activity or stop
 *     state, so a race with a user stop cannot strand our row in the queue.
 *   An edge is false from the primitive's own per-request deadline onward
 *   (checked on the same monotonic clock, before its timer even runs) and
 *   permanently once its request settled or the attempt ended, so a late
 *   write is refused.
 *   A refused `add` is positively not delivered; a refused `start` or `delete`
 *   leaves our row possibly queued, which the primitive reports as uncertain.
 *
 * ## The idle busy-race fence (the only route switch)
 *
 * `thread/queue/start` repeats Codex's idle check atomically. When a turn won
 * the race, the queue primitive deletes only our exact row and reports
 * `busy-removed`. Only then may this composition switch to steering, and only
 * if a FRESH facts read after that result shows: the same owned thread and
 * run, a busy root turn whose id differs from the turn known at the idle
 * decision, and no user stop. The steer reuses the same `clientUserMessageId`
 * and text, and its own target checks still apply at the write. Every other
 * idle outcome ends the attempt: `uncertain` (including `row-absent` and
 * `not-deleted`) is never replayed, retried, or steered.
 *
 * ## Delivery summary (sent is not placed)
 *
 * - `not-delivered`: positively nothing is pending or started from this
 *   callback (declined, refused, provider-rejected, unsupported, or our row
 *   deleted without a steer).
 * - `sent-unconfirmed`: the provider ACCEPTED a steer for the exact turn.
 *   Placement is not observed; classify it separately with
 *   {@linkcode classifyNativeCodexCallbackPlacement}.
 * - `turn-started`: the provider reported that our exact queued row started a
 *   turn. That is the provider's placement report for the turn input, not model
 *   acknowledgement, a read receipt, or completion.
 * - `unknown`: the callback may or may not be pending, queued, or started. It
 *   must not be resent; the attempted id stays burned in this composer.
 *
 * A repeated id is not a new delivery verdict: it returns route `duplicate`
 * carrying the earlier attempt's delivery (`unknown` while it is in flight),
 * never `not-delivered`, and writes nothing. Only a positively not-delivered
 * attempt releases its id.
 *
 * Privacy: outcomes carry only closed codes, the caller's own id, and the
 * provider's opaque ids already carried by the primitive results. The callback
 * text crosses only into the primitives.
 */

import { isRecord } from "../record-guard";
import {
  NATIVE_CODEX_CALLBACK_MAX_CLIENT_MESSAGE_ID_CHARS,
  NATIVE_CODEX_CALLBACK_MAX_REMEMBERED_SUBMISSIONS,
  NATIVE_CODEX_CALLBACK_MAX_TEXT_BYTES,
  createNativeCodexCallbackSteerSender,
  type NativeCodexCallbackSteerLane,
  type NativeCodexCallbackSteerOutcome,
  type NativeCodexCallbackSteerTarget,
} from "./native-codex-callback-delivery";
import {
  wakeIdleNativeCodexThread,
  type NativeCodexIdleWakeCaller,
  type NativeCodexIdleWakeOutcome,
  type NativeCodexIdleWakeQueueMethod,
  type NativeCodexIdleWakeReply,
  type NativeCodexIdleWakeTimers,
} from "./native-codex-idle-wake";

/* -------------------------------------------------------------- queue lane */

/** Brand a host-constructed queue lane must carry; anything else is not trusted. */
export const NATIVE_CODEX_CALLBACK_QUEUE_LANE_OWNERSHIP = "host-owned-dedicated-queue-lane";

/** Handed to the queue lane with each request; see the WRITE EDGE rule on the lane. */
export interface NativeCodexCallbackQueueWriteEdge {
  /** True only while this request may still be written under current host facts. */
  mayWrite(): boolean;
}

/**
 * A lane reply: the primitive's own reply shapes, plus `not-sent` when the
 * lane positively wrote nothing (not ready, or its write edge said no).
 */
export type NativeCodexCallbackQueueLaneReply = NativeCodexIdleWakeReply | { readonly kind: "not-sent" };

/**
 * Composition contract for the host-owned queue lane (not provided here). It
 * sits on the host-owned, `experimentalApi`-initialized app-server connection,
 * writes exactly the one request it is given, never answers a server request,
 * and never retries.
 *
 * WRITE EDGE: a ready lane hands the frame to its socket synchronously inside
 * `request`, before returning or awaiting anything. A lane that is not ready
 * returns `not-sent` instead of waiting. Any implementation that nonetheless
 * defers the write MUST call `writeEdge.mayWrite()` immediately before the
 * socket write and return `not-sent` when it is false.
 */
export interface NativeCodexCallbackQueueLane {
  readonly ownership: typeof NATIVE_CODEX_CALLBACK_QUEUE_LANE_OWNERSHIP;
  request(
    method: NativeCodexIdleWakeQueueMethod,
    params: Readonly<Record<string, unknown>>,
    timeoutMs: number,
    writeEdge: NativeCodexCallbackQueueWriteEdge,
  ): Promise<NativeCodexCallbackQueueLaneReply>;
}

/* ------------------------------------------------------------------ inputs */

/** Strictest bound both primitives accept for a provider opaque id. */
const MAX_OPAQUE_ID_CHARS = 256;
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** The exact thread and run the host owns for this composer. */
export interface NativeCodexCallbackOwnedRun {
  readonly threadId: string;
  /** Host-minted fence for the current owned run (e.g. connection generation). */
  readonly runId: string;
}

/** Host-trusted current root-turn activity for the owned thread. */
export type NativeCodexCallbackRootActivity =
  /** One exact active root turn. */
  | { readonly state: "busy"; readonly turnId: string }
  /** No active root turn. `lastTurnId` is the most recent ended root turn, if any. */
  | { readonly state: "idle"; readonly lastTurnId: string | null }
  | { readonly state: "unknown" };

/**
 * One synchronous read of the host's current root facts. `userStop` is
 * `"none"` only when the host positively knows the user has not stopped the
 * root since its latest own work began; `"unknown"` is treated as stopped.
 */
export interface NativeCodexCallbackRootFacts {
  readonly threadId: string;
  readonly runId: string;
  readonly activity: NativeCodexCallbackRootActivity;
  readonly userStop: "none" | "stopped" | "unknown";
}

export interface NativeCodexCallbackComposerOptions {
  readonly owned: NativeCodexCallbackOwnedRun;
  /** Synchronous, nonblocking; `null` means not known. Never from a payload. */
  readonly readFacts: () => NativeCodexCallbackRootFacts | null;
  /** The existing busy-steer primitive's host-owned lane, passed through unchanged. */
  readonly steerLane: NativeCodexCallbackSteerLane;
  /** Branded queue lane, adapted to the unchanged idle-queue primitive behind the write-edge fence. */
  readonly queueLane: NativeCodexCallbackQueueLane;
  readonly idleCallTimeoutMs?: number;
  readonly idleTimers?: NativeCodexIdleWakeTimers;
}

export interface NativeCodexCallbackComposedRequest {
  /** Caller's stable callback id; reused unchanged by every step of one attempt. */
  readonly clientUserMessageId: string;
  readonly text: string;
}

/* ----------------------------------------------------------------- results */

export type NativeCodexCallbackDeclineReason =
  /** Composer options are not a usable owned run, facts reader, lane, and caller. */
  | "composer-invalid"
  /** The request id or text is not accepted by both primitives. */
  | "input-invalid"
  /** Another attempt (for a different id) on this composer has not settled. */
  | "in-flight"
  /** This composer remembers its maximum number of attempted ids. */
  | "submission-capacity"
  /** No readable facts, or root activity is unknown. */
  | "facts-unknown"
  /** Facts name a different thread or run than the owned one (revoked or rebound). */
  | "facts-stale"
  /** The user stopped the root, or whether they did is unknown. */
  | "user-stopped"
  /**
   * `add` was positively not written: the write edge refused it (facts revoked,
   * user-stopped, no longer idle with the same last turn, or past its deadline)
   * or the lane confirmed it did not write it (e.g. not ready). Nothing was written.
   */
  | "queue-add-not-sent";

/** Why an idle busy-race did not switch to steering. Our row was deleted either way. */
export type NativeCodexCallbackRaceDeclineReason =
  | "facts-unknown"
  | "facts-stale"
  | "user-stopped"
  /** Fresh facts do not show a busy root turn. */
  | "not-busy"
  /** Fresh facts still name the turn known at the idle decision. */
  | "turn-not-fresh";

export type NativeCodexCallbackComposedDelivery = "not-delivered" | "sent-unconfirmed" | "turn-started" | "unknown";

export type NativeCodexCallbackComposedOutcome =
  | {
      readonly route: "declined";
      readonly reason: NativeCodexCallbackDeclineReason;
      readonly delivery: "not-delivered";
    }
  | {
      readonly route: "busy-steer";
      readonly delivery: NativeCodexCallbackComposedDelivery;
      readonly steer: NativeCodexCallbackSteerOutcome;
    }
  | {
      readonly route: "idle-queue";
      readonly delivery: NativeCodexCallbackComposedDelivery;
      readonly idle: NativeCodexIdleWakeOutcome;
      /** Present only when the queue reported `busy-removed` and steering was not authorized. */
      readonly raceDeclined?: NativeCodexCallbackRaceDeclineReason;
    }
  | {
      readonly route: "idle-race-steer";
      readonly delivery: NativeCodexCallbackComposedDelivery;
      readonly idle: Extract<NativeCodexIdleWakeOutcome, { readonly kind: "busy-removed" }>;
      readonly steer: NativeCodexCallbackSteerOutcome;
    }
  /**
   * This composer already attempted this id. Nothing was written now; the
   * delivery is the earlier attempt's (`unknown` while it is still in flight).
   */
  | { readonly route: "duplicate"; readonly delivery: Exclude<NativeCodexCallbackComposedDelivery, "not-delivered"> }
  /** The composition itself faulted after a possible write. Never resend. */
  | { readonly route: "fault"; readonly delivery: "unknown" };

export interface NativeCodexCallbackComposer {
  /** At most one route per call; never retries or replays, never rejects. */
  deliver(request: NativeCodexCallbackComposedRequest): Promise<NativeCodexCallbackComposedOutcome>;
}

/* -------------------------------------------------------------- validation */

function exactId(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maxChars) return null;
  if (/[\s\u0000-\u001F\u007F]/.test(value)) return null;
  return value;
}

function readOwned(value: unknown): NativeCodexCallbackOwnedRun | null {
  if (!isRecord(value)) return null;
  const threadId = exactId(value.threadId, MAX_OPAQUE_ID_CHARS);
  const runId = exactId(value.runId, MAX_OPAQUE_ID_CHARS);
  return threadId === null || runId === null ? null : { threadId, runId };
}

function readClientMessageId(value: unknown): string | null {
  const id = exactId(value, NATIVE_CODEX_CALLBACK_MAX_CLIENT_MESSAGE_ID_CHARS);
  return id !== null && CLIENT_MESSAGE_ID_PATTERN.test(id) ? id : null;
}

function readText(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) return null;
  return Buffer.byteLength(value, "utf8") > NATIVE_CODEX_CALLBACK_MAX_TEXT_BYTES ? null : value;
}

type KnownActivity = Exclude<NativeCodexCallbackRootActivity, { readonly state: "unknown" }>;

type FactsRead =
  | { readonly ok: true; readonly activity: KnownActivity }
  | {
      readonly ok: false;
      readonly reason: "facts-unknown" | "facts-stale" | "user-stopped";
      /** True when the facts positively named the owned thread and run. */
      readonly owned: boolean;
    };

function notOk(reason: "facts-unknown" | "facts-stale" | "user-stopped", owned: boolean): FactsRead {
  return { ok: false, reason, owned };
}

/** Closed read of one facts snapshot against the owned run. Unknown shapes decline. */
function readFactsFor(owned: NativeCodexCallbackOwnedRun, read: () => unknown): FactsRead {
  let raw: unknown;
  try {
    raw = read();
  } catch {
    return notOk("facts-unknown", false);
  }
  if (!isRecord(raw)) return notOk("facts-unknown", false);
  const threadId = exactId(raw.threadId, MAX_OPAQUE_ID_CHARS);
  const runId = exactId(raw.runId, MAX_OPAQUE_ID_CHARS);
  if (threadId === null || runId === null) return notOk("facts-unknown", false);
  if (threadId !== owned.threadId || runId !== owned.runId) return notOk("facts-stale", false);
  if (raw.userStop !== "none") {
    return notOk(raw.userStop === "stopped" || raw.userStop === "unknown" ? "user-stopped" : "facts-unknown", true);
  }
  const activity = isRecord(raw.activity) ? raw.activity : null;
  if (activity?.state === "busy") {
    const turnId = exactId(activity.turnId, MAX_OPAQUE_ID_CHARS);
    return turnId === null ? notOk("facts-unknown", true) : { ok: true, activity: { state: "busy", turnId } };
  }
  if (activity?.state === "idle") {
    if (activity.lastTurnId === null) return { ok: true, activity: { state: "idle", lastTurnId: null } };
    const lastTurnId = exactId(activity.lastTurnId, MAX_OPAQUE_ID_CHARS);
    return lastTurnId === null ? notOk("facts-unknown", true) : { ok: true, activity: { state: "idle", lastTurnId } };
  }
  return notOk("facts-unknown", true);
}

/* ----------------------------------------------------------------- summary */

function steerDelivery(outcome: NativeCodexCallbackSteerOutcome): NativeCodexCallbackComposedDelivery {
  switch (outcome.status) {
    case "accepted":
      return "sent-unconfirmed";
    case "refused":
    case "rejected":
      return "not-delivered";
    default:
      return "unknown";
  }
}

function idleDelivery(outcome: NativeCodexIdleWakeOutcome): NativeCodexCallbackComposedDelivery {
  switch (outcome.kind) {
    case "started":
      return "turn-started";
    case "rejected-input":
    case "unsupported":
    case "busy-removed":
      return "not-delivered";
    default:
      return "unknown";
  }
}

function declined(reason: NativeCodexCallbackDeclineReason): NativeCodexCallbackComposedOutcome {
  return Object.freeze({ route: "declined", reason, delivery: "not-delivered" });
}

/* ---------------------------------------------------------------- composer */

/**
 * Build one composer over one owned run. Invalid options yield a composer that
 * declines every delivery without touching either seam.
 */
export function createNativeCodexCallbackComposer(
  options: NativeCodexCallbackComposerOptions,
): NativeCodexCallbackComposer {
  const owned = isRecord(options) ? readOwned(options.owned) : null;
  const readFacts = isRecord(options) && typeof options.readFacts === "function" ? options.readFacts : null;
  const queueLane = isRecord(options)
    && isRecord(options.queueLane)
    && options.queueLane.ownership === NATIVE_CODEX_CALLBACK_QUEUE_LANE_OWNERSHIP
    && typeof options.queueLane.request === "function"
    ? options.queueLane
    : null;
  if (owned === null || readFacts === null || queueLane === null || !isRecord(options.steerLane)) {
    return Object.freeze({ deliver: async () => declined("composer-invalid") });
  }
  const facts = (): FactsRead => readFactsFor(owned, readFacts);

  // The steer primitive validates the lane itself and re-reads this target
  // immediately before (and, through the lane's write edge, at) the write.
  const steerSender = createNativeCodexCallbackSteerSender({
    lane: options.steerLane,
    readCurrentTarget: (): NativeCodexCallbackSteerTarget | null => {
      const now = facts();
      return now.ok && now.activity.state === "busy" ? { threadId: owned.threadId, turnId: now.activity.turnId } : null;
    },
  });

  /** Attempted ids and their delivery so far; `in-flight` until settled. */
  const attempted = new Map<string, NativeCodexCallbackComposedDelivery | "in-flight">();
  let inFlight = false;

  /** The write predicate for one queue method, against the idle decision. */
  const mayWriteQueue = (method: NativeCodexIdleWakeQueueMethod, idleLastTurnId: string | null): boolean => {
    const now = facts();
    switch (method) {
      case "thread/queue/add":
        return now.ok && now.activity.state === "idle" && now.activity.lastTurnId === idleLastTurnId;
      case "thread/queue/start":
        return now.ok;
      case "thread/queue/delete":
        return now.ok || now.owned;
      default:
        return false;
    }
  };

  const wakeIdle = async (clientUserMessageId: string, text: string, idleLastTurnId: string | null) => {
    let attemptOpen = true;
    let addNotSent = false;
    // Share the primitive's own per-request monotonic deadline with the write
    // edge. The primitive samples `now()` and then calls `set()` immediately
    // before each request, so `deadline` is that request's exact deadline. The
    // edge closes at that instant even if the timer callback or the promise
    // continuation has not run yet, and the whole attempt closes synchronously
    // when the timer fires. The primitive's timeout outcome is unchanged.
    const clock: NativeCodexIdleWakeTimers = options.idleTimers ?? {
      now: () => performance.now(),
      set: (callback, ms) => setTimeout(callback, ms),
      clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    let sampledAt = Number.NaN;
    let deadline = Number.NaN;
    const timers: NativeCodexIdleWakeTimers = {
      now: () => (sampledAt = clock.now()),
      set(callback, ms) {
        deadline = sampledAt + ms;
        return clock.set(() => {
          attemptOpen = false;
          callback();
        }, ms);
      },
      clear: (handle) => clock.clear(handle),
    };
    // Adapter from the branded lane to the unchanged primitive's caller. The
    // async body runs synchronously up to the lane call, so the entry check,
    // the lane call, and a ready lane's write are adjacent.
    const fenced: NativeCodexIdleWakeCaller = {
      async request(method, params, timeoutMs): Promise<NativeCodexIdleWakeReply> {
        const notSent = (): NativeCodexIdleWakeReply => {
          if (method === "thread/queue/add") addNotSent = true;
          return { kind: "failed", failure: "write" };
        };
        const requestDeadline = deadline;
        let settled = false;
        const writeEdge: NativeCodexCallbackQueueWriteEdge = Object.freeze({
          mayWrite: (): boolean => {
            if (settled || !attemptOpen) return false;
            try {
              // NaN (no deadline sampled) compares false: fail closed.
              return mayWriteQueue(method, idleLastTurnId) && clock.now() < requestDeadline;
            } catch {
              return false;
            }
          },
        });
        if (!writeEdge.mayWrite()) return notSent();
        let reply: NativeCodexCallbackQueueLaneReply;
        try {
          reply = await queueLane.request.call(queueLane, method, params, timeoutMs, writeEdge);
        } finally {
          settled = true;
        }
        // Anything else is handed to the primitive, which validates it.
        return isRecord(reply) && reply.kind === "not-sent" ? notSent() : (reply as NativeCodexIdleWakeReply);
      },
    };
    try {
      const outcome = await wakeIdleNativeCodexThread(
        { threadId: owned.threadId, clientUserMessageId, text },
        {
          caller: fenced,
          ...(options.idleCallTimeoutMs === undefined ? {} : { callTimeoutMs: options.idleCallTimeoutMs }),
          timers,
        },
      );
      return { outcome, addNotSent };
    } finally {
      // A lane request still pending after the primitive moved on (its own
      // deadline) can never write afterwards.
      attemptOpen = false;
    }
  };

  const route = async (clientUserMessageId: string, text: string): Promise<NativeCodexCallbackComposedOutcome> => {
    const decision = facts();
    if (!decision.ok) return declined(decision.reason);

    if (decision.activity.state === "busy") {
      const steer = await steerSender.send({
        target: { threadId: owned.threadId, turnId: decision.activity.turnId },
        clientUserMessageId,
        text,
      });
      return Object.freeze({ route: "busy-steer", delivery: steerDelivery(steer), steer });
    }

    const knownTurnId = decision.activity.lastTurnId;
    const { outcome: idle, addNotSent } = await wakeIdle(clientUserMessageId, text, knownTurnId);
    // `add` is the first request; when it was positively not written the
    // primitive stopped there, so nothing was written at all.
    if (addNotSent && idle.kind === "uncertain" && idle.stage === "add" && idle.reason === "write") {
      return declined("queue-add-not-sent");
    }
    if (idle.kind !== "busy-removed") {
      return Object.freeze({ route: "idle-queue", delivery: idleDelivery(idle), idle });
    }

    // Busy race: the primitive confirmed deletion of our exact row. Switch to
    // the expected-turn steer only on a fresh, current-run, new-turn proof.
    const fresh = facts();
    const freshTurnId = fresh.ok && fresh.activity.state === "busy" ? fresh.activity.turnId : null;
    const raceDeclined: NativeCodexCallbackRaceDeclineReason | null = !fresh.ok
      ? fresh.reason
      : freshTurnId === null
        ? "not-busy"
        : freshTurnId === knownTurnId
          ? "turn-not-fresh"
          : null;
    if (raceDeclined !== null || freshTurnId === null) {
      return Object.freeze({ route: "idle-queue", delivery: "not-delivered", idle, raceDeclined: raceDeclined ?? "not-busy" });
    }
    const steer = await steerSender.send({
      target: { threadId: owned.threadId, turnId: freshTurnId },
      clientUserMessageId,
      text,
    });
    return Object.freeze({ route: "idle-race-steer", delivery: steerDelivery(steer), idle, steer });
  };

  const deliver = async (request: NativeCodexCallbackComposedRequest): Promise<NativeCodexCallbackComposedOutcome> => {
    if (!isRecord(request)) return declined("input-invalid");
    const clientUserMessageId = readClientMessageId(request.clientUserMessageId);
    if (clientUserMessageId === null) return declined("input-invalid");
    // A valid stable id identifies the earlier attempt whatever the new payload
    // is, so the remembered state is reported before the text is validated.
    const prior = attempted.get(clientUserMessageId);
    if (prior !== undefined) {
      // Never a fresh verdict: report what the earlier attempt established.
      const delivery = prior === "in-flight" || prior === "not-delivered" ? "unknown" : prior;
      return Object.freeze({ route: "duplicate", delivery });
    }
    const text = readText(request.text);
    if (text === null) return declined("input-invalid");
    if (inFlight) return declined("in-flight");
    if (attempted.size >= NATIVE_CODEX_CALLBACK_MAX_REMEMBERED_SUBMISSIONS) return declined("submission-capacity");

    inFlight = true;
    attempted.set(clientUserMessageId, "in-flight");
    let outcome: NativeCodexCallbackComposedOutcome;
    try {
      outcome = await route(clientUserMessageId, text);
    } catch {
      // Neither primitive rejects; a throw here is a composition fault after a
      // possible write, so it is unknown and the id stays burned.
      outcome = Object.freeze({ route: "fault", delivery: "unknown" });
    } finally {
      inFlight = false;
    }
    // Only a positively not-delivered attempt releases the id for the caller's
    // own retry policy. Anything sent, started, or unknown is never replayed.
    if (outcome.delivery === "not-delivered") attempted.delete(clientUserMessageId);
    else attempted.set(clientUserMessageId, outcome.delivery);
    return outcome;
  };

  return Object.freeze({ deliver });
}
