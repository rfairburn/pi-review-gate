/**
 * #682 native Windows Claude custody — the inactive launch lifecycle adapter.
 *
 * ## What this module is
 *
 * One thin composition layer between the already-validated PowerShell renderer
 * ({@linkcode buildWindowsClaudeCustodySupervisorLaunch} /
 * {@linkcode buildWindowsClaudeCustodyWrapperLaunch}), the already-validated
 * supervisor transport (`attachNativeWindowsClaudeCustodyTransport`), and the
 * caller's two synchronous spawn ports. It is deliberately standalone: no host
 * imports it, it registers nothing, and it is not activated by any product path.
 *
 * What it does NOT do: resolve PowerShell, inspect the target, choose a
 * provider, set up ConPTY, read settings, consult PE/ACL facts, gate launch
 * eligibility, configure an inbox/auth channel, derive or issue a hook
 * pipe/key/marker, or compose a fallback route (the dormant opt-in hook
 * composition is described below). The caller supplies the already-trusted PowerShell path, the already
 * validated direct target, the exact run, and the two spawn functions.
 *
 * ## The lifecycle
 *
 * `launch()` is single-use and runs exactly this sequence:
 *
 * 1. Re-render the supervisor launch, then synchronously spawn the exact owned
 *    supervisor `ChildProcess`; attach the real transport to precisely that
 *    handle and start its boot.
 * 2. After `SUP_READY`, re-render and synchronously spawn the wrapper through
 *    the caller's PTY port. The exact handle's live `pid` getter is polled under
 *    a bounded monotonic deadline until it is a positive integer. Node-pty may
 *    report `0` for a short time; `0` is never written in a `CONFIRM`.
 * 3. Hand the transport a thunk that re-reads that same live getter at the write
 *    fence and re-checks cancellation and run currency before and after the
 *    read. A missing/mismatched/deferred PID is never retried through some
 *    other route.
 * 4. `SUP_GO` is followed by `awaitChild()`. Only after the full handshake
 *    (boot, provisional peer, confirm, GO, child) AND a final current/uncanceled
 *    fence does `launch()` report the child as established.
 *
 * `stop()` is single-flight and idempotent. Exactly one stop operation can run,
 * and every caller receives the same promise/result.
 *
 * - Once a real `awaitChild()` established custody, stop uses exactly ONE
 *   `settle()` call, with no AbortSignal and its own internal deadline. Caller
 *   cancellation or shutdown while settlement is running is deliberately
 *   ignored: it cannot poison or preempt the only witness.
 * - Before custody is established, stop never sends `SETTLE` (an in-flight
 *   `SUP_CHILD` could poison it). It waits for the bounded child-step handoff so
 *   a successful `awaitChild()` is recorded before it chooses the teardown path,
 *   then disposes the transport, stops the exact wrapper handle (never a numeric
 *   PID), and waits bounded for the supervisor close and the PTY exit receipts.
 * - If `awaitChild()` fails after custody was established, or settlement
 *   fails, both exact handles are stopped and the stop outcome stays unproven.
 *
 * ## Receipts and uncertainty
 *
 * The supervisor's `close` event and the wrapper's `onExit` event are observed
 * from the exact returned handles, starting immediately after each spawn. Spawn
 * and pipe `error` events on that exact supervisor are consumed immediately,
 * including when the transport refuses the handle before arming its own
 * listeners; `close` remains the only closure receipt. The supervisor closure
 * fact and the PTY exit fact are always reported separately. A synthetic PID,
 * PTY output, a settlement witness, or a process merely being absent never
 * substitutes for those receipts.
 *
 * `CONFIRM` is conservatively treated as "may have been written" as soon as the
 * write-fence thunk is entered, even if the fence then rejects before writing:
 * the adapter never claims byte-level receipt. If the thunk was never entered,
 * no target can exist (the rendered wrapper starts its child only after GO).
 *
 * A synchronous spawn that throws may still have produced a process. Such a
 * launch is reported as uncertain and its stop outcome remains `unproven`; it is
 * never rewritten as "no child".
 *
 * ## Outcomes (closed codes only)
 *
 * The launch result is separate from the eventual stop result. Stop outcomes are
 * `witnessed-empty` (the transport's complete settlement witness),
 * `no-child-possible` (the thunk was never entered, both owned handles were
 * observed closed/exited, and no uncertainty remains), or `unproven`.
 *
 * ## Dormant opt-in protected hook channel (`hookChannel`)
 *
 * Omitting `hookChannel` (the default, and every current product caller) keeps
 * every render, attach, write, fence, and result above exactly as before. When
 * the owner supplies it, it must already have derived/validated the exact
 * nonsecret `prg682-hook-<32 hex>` pipe name and the per-run 64-lowercase-hex
 * key; the adapter re-validates both ONCE at construction (each property read
 * exactly once) and pins them. Anything other than an omitted value — `null`, a
 * malformed pipe or key — makes the adapter unusable: `launch()` reports
 * `options-invalid` before any spawn, and nothing falls back to the default
 * supervisor. Supplying it issues no marker and activates nothing by itself.
 *
 * The one launch then composes exactly the existing opt-in pieces: the renderer
 * receives `hookPipe` (the key never enters the descriptor, source, argv, or
 * environment; the wrapper/PTY render is unchanged), the real transport is
 * attached with `hookCandidates: true` (its settle deadline floored at the
 * shipped default so one in-flight hook turn plus the supervisor's job-settle
 * window fit before teardown), and the key is handed once, privately,
 * to `start(source, { hookKey })`, which writes it in the same single write
 * immediately after the boot frame and scrubs its buffer. The adapter holds
 * the key only in a one-shot closure that is emptied as the start call is
 * made, or on any stop/refusal before that, and the short-lived start options
 * object drops it synchronously once the transport has submitted its write.
 * The holder and the handoff are ECMAScript-private. The key never appears in
 * a result, error, log, or emitted metadata.
 *
 * {@linkcode NativeWindowsClaudeCustodyHookAdapter.observeHookCandidate}
 * returns the transport's latest credited candidate as a fresh closed
 * `{ sequence, sessionId }` copy, only for the exact bound run, only after this
 * adapter published its established launch, and only while nothing was
 * cancelled, stopped, settled, exited, or poisoned. It is correlation
 * metadata: it never names an accepted root, sender, binding, or authority,
 * and it never writes, waits, or changes custody state.
 *
 * ## Opt-in hook control (`hookChannel.control: true`)
 *
 * Omitting `control` (or `false`) keeps the candidate-only hook composition
 * above exactly. `true` composes the already-landed control mode on top of
 * it and nothing else: the renderer additionally receives `hookControl`, the
 * transport is attached with `hookControl: true` and its stop deadline is
 * floored at the paired control default
 * ({@linkcode NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEFAULT_SETTLE_MS}), and
 * the returned {@linkcode NativeWindowsClaudeCustodyControlAdapter} forwards
 * exactly the transport's own `BIND`/`DROP`/binding observation and its
 * two-phase send commit, each only for the exact bound run under the same
 * adapter-owned liveness that gates candidate publication (`DROP` excepted:
 * the transport's local revocation must stay reachable while stopping). The
 * adapter adds no correlation, retry, queue, fallback, or authority of its
 * own: the caller supplies the candidate it ALREADY correlated and its own
 * fences, a refusal writes nothing, and a dispatched attempt keeps the
 * transport's closed `sent-unconfirmed`/`not-sent`/`unknown` outcome (a
 * commit that faults after its prepare is reported `unknown`, never
 * `not-sent`). The callback text is the only payload that crosses; the
 * per-run key is still handed over once at startup and never retained.
 */

import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { addAbortListener } from "node:events";

import {
  DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_DEADLINES,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEFAULT_SETTLE_MS,
  NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_DEADLINE_MS,
  attachNativeWindowsClaudeCustodyTransport,
  type NativeWindowsClaudeCustodyAttachRefusal,
  type NativeWindowsClaudeCustodyBindResult,
  type NativeWindowsClaudeCustodyDropResult,
  type NativeWindowsClaudeCustodyHookBindingFence,
  type NativeWindowsClaudeCustodyHookBindingObservation,
  type NativeWindowsClaudeCustodySendCommit,
  type NativeWindowsClaudeCustodySendFence,
  type NativeWindowsClaudeCustodySendPayloadSource,
  type NativeWindowsClaudeCustodyChildResult,
  type NativeWindowsClaudeCustodyHookCandidate,
  type NativeWindowsClaudeCustodyHookCandidateCredit,
  type NativeWindowsClaudeCustodyMisuseCode,
  type NativeWindowsClaudeCustodyPoisonCode,
  type NativeWindowsClaudeCustodyRun,
  type NativeWindowsClaudeCustodySettlementWitness,
  type NativeWindowsClaudeCustodyStartResult,
  type NativeWindowsClaudeCustodyTransport,
} from "./native-windows-claude-custody-protocol";
import {
  WINDOWS_CLAUDE_CUSTODY_CONTROL_PIPE_PATTERN,
  WINDOWS_CLAUDE_CUSTODY_HOOK_PIPE_PATTERN,
  WINDOWS_CLAUDE_CUSTODY_NONCE_PATTERN,
  buildWindowsClaudeCustodySupervisorLaunch,
  buildWindowsClaudeCustodyWrapperLaunch,
  type WindowsClaudeCustodySupervisorLaunch,
  type WindowsClaudeCustodyWrapperLaunch,
} from "./native-windows-claude-custody-scripts";

/* --------------------------------------------------------------- deadlines */

/**
 * Every adapter wait is bounded. The transport deadlines mirror the transport's
 * own staged defaults; the two lifecycle waits add a bounded PTY-PID window and
 * a bounded close/exit receipt window. All values stay within the transport's
 * existing per-step cap.
 */
export interface NativeWindowsClaudeCustodyAdapterDeadlines {
  /** Bootstrap written -> `SUP_READY`. */
  readonly readyMs: number;
  /** Provisional wrapper/GO exchange and CONFIRM -> GO. */
  readonly peerMs: number;
  /** `awaitChild()` -> `SUP_CHILD`. */
  readonly childMs: number;
  /** The one `SETTLE` -> complete witness. */
  readonly settleMs: number;
  /** Positive live node-pty PID required before `confirmPeer()`. */
  readonly wrapperPidMs: number;
  /** Bounded supervisor-close and PTY-exit receipt window. */
  readonly closeMs: number;
}

export const DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_ADAPTER_DEADLINES: Readonly<NativeWindowsClaudeCustodyAdapterDeadlines> =
  Object.freeze({
    ...DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_DEADLINES,
    wrapperPidMs: 10_000,
    closeMs: 5_000,
  });

const DEFAULT_WRAPPER_PID_POLL_MS = 10;
const MAX_RUN_ID_CHARS = 128;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_PID = 0xffff_ffff;
const HOOK_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const HOOK_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/* ------------------------------------------------------------ caller ports */

/**
 * The exact PTY handle the caller's synchronous `spawnWrapper` returned.
 * `pid` is intentionally a live getter: the adapter re-reads it and never
 * caches or trusts an earlier value.
 */
export interface NativeWindowsClaudeCustodyWrapperHandle {
  readonly pid: number;
  onExit(listener: (event: { readonly exitCode: number; readonly signal?: number }) => void): { dispose(): void } | void;
  kill(): void;
}

export interface NativeWindowsClaudeCustodyAdapterOptions {
  /** Already-trusted absolute System32 Windows PowerShell 5.1 path. */
  readonly powershellPath: string;
  /** Already-validated absolute direct `.exe` target. */
  readonly target: string;
  /** Exact target argv; rendered and quoted by the existing renderer. */
  readonly args?: readonly string[];
  /** The exact host run this custody belongs to; pinned by the adapter. */
  readonly run: NativeWindowsClaudeCustodyRun;
  /** Synchronous host predicate; consulted at every effect/async fence. */
  readonly isRunCurrent: () => boolean;
  /** Cancels launch steps only; it never cancels an already-started settlement. */
  readonly signal?: AbortSignal;
  /** The caller's one synchronous supervisor spawn call. */
  readonly spawnSupervisor: (launch: WindowsClaudeCustodySupervisorLaunch) => ChildProcess;
  /** The caller's one synchronous wrapper/PTY spawn call. */
  readonly spawnWrapper: (launch: WindowsClaudeCustodyWrapperLaunch) => NativeWindowsClaudeCustodyWrapperHandle;
  /**
   * Bounded overrides; absent keeps the shipped staged defaults. In hook mode
   * the transport settle deadline is floored at the shipped default.
   */
  readonly deadlines?: Partial<NativeWindowsClaudeCustodyAdapterDeadlines>;
  /**
   * DORMANT opt-in protected hook channel. Omitted keeps the default launch
   * exactly. Present, both values must already be owner-derived and valid; any
   * other present value refuses the launch before a spawn (no fallback).
   */
  readonly hookChannel?: NativeWindowsClaudeCustodyAdapterHookChannel;
}

/**
 * The owner-derived inputs of the opt-in hook channel. Read once and pinned at
 * construction; the caller's object is never retained.
 */
export interface NativeWindowsClaudeCustodyAdapterHookChannel {
  /** Nonsecret exact `prg682-hook-<32 lowercase hex>` pipe name. */
  readonly pipe: string;
  /** Per-run 64-lowercase-hex key; handed once to the transport's startup write. */
  readonly key: string;
  /**
   * Opt-in hook CONTROL on top of the candidate channel. Omitted or `false`
   * keeps the candidate-only composition exactly; `true` composes the landed
   * `BIND`/`DROP`/`SEND` mode. Any other value refuses the launch.
   */
  readonly control?: boolean;
}

export type NativeWindowsClaudeCustodyAdapterOptionsWithHookChannel = NativeWindowsClaudeCustodyAdapterOptions & {
  readonly hookChannel: NativeWindowsClaudeCustodyAdapterHookChannel;
};

export type NativeWindowsClaudeCustodyAdapterOptionsWithHookControl = NativeWindowsClaudeCustodyAdapterOptions & {
  readonly hookChannel: NativeWindowsClaudeCustodyAdapterHookChannel & { readonly control: true };
};

/* ---------------------------------------------------------------- outcomes */

export type NativeWindowsClaudeCustodyLaunchFailureCode =
  /** The adapter options cannot be used. */
  | "options-invalid"
  /** `launch()` was already called (or stop was requested first). */
  | "already-used"
  /** The existing renderer refused the trusted inputs before a spawn. */
  | "rendering-failed"
  /** The pinned run is stale, or the predicate threw/failed a fence. */
  | "run-not-current"
  /** Caller cancellation or a stop request interrupted a launch step. */
  | "cancelled"
  /** The supervisor spawn call threw; creation may still have happened. */
  | "supervisor-spawn-uncertain"
  /** The real transport refused the exact supervisor handle. */
  | "supervisor-attach-refused"
  /** Boot/`SUP_READY` failed inside the bounded transport step. */
  | "supervisor-boot-failed"
  /** The wrapper spawn call threw; creation may still have happened. */
  | "wrapper-spawn-uncertain"
  /** The returned wrapper had no live PID/exit/kill surface to observe. */
  | "wrapper-unobservable"
  /** The live PTY PID never became a positive integer before the deadline. */
  | "wrapper-pid-unavailable"
  /** The exact PTY handle reported exit before the child was established. */
  | "wrapper-exited"
  /** `confirmPeer` (provisional peer, CONFIRM fence, or GO) failed closed. */
  | "confirm-failed"
  /** Custody was not established or was lost before launch publication. */
  | "child-not-established"
  /** An unexpected internal fault was contained and reported closed. */
  | "unexpected";

export type NativeWindowsClaudeCustodyAdapterFailureDetail =
  | NativeWindowsClaudeCustodyAttachRefusal
  | NativeWindowsClaudeCustodyPoisonCode
  | NativeWindowsClaudeCustodyMisuseCode
  | "supervisor"
  | "wrapper";

export interface NativeWindowsClaudeCustodyLaunchFailure {
  readonly status: "failed";
  readonly code: NativeWindowsClaudeCustodyLaunchFailureCode;
  /** Closed sub-code only; never a message, path, PID, or rendered text. */
  readonly detail?: NativeWindowsClaudeCustodyAdapterFailureDetail;
}

export interface NativeWindowsClaudeCustodyLaunchSuccess {
  readonly status: "launched";
  readonly supervisorPid: number;
  readonly wrapperPid: number;
  readonly childPid: number;
}

export type NativeWindowsClaudeCustodyLaunchResult =
  | NativeWindowsClaudeCustodyLaunchSuccess
  | NativeWindowsClaudeCustodyLaunchFailure;

export type NativeWindowsClaudeCustodyStopUnprovenReason =
  /** Custody was established, but the one settlement attempt did not witness it. */
  | "settlement-failed"
  /** Custody was established but no settlement was possible (defensive only). */
  | "settlement-not-attempted"
  /** The CONFIRM write-fence thunk was entered, so a target may exist. */
  | "confirmation-may-have-been-written"
  /** A synchronous spawn threw after it may have created something. */
  | "spawn-uncertain"
  /** An owned handle never produced its close/exit receipt. */
  | "handle-unobserved";

export interface NativeWindowsClaudeCustodyStopResult {
  readonly status: "witnessed-empty" | "no-child-possible" | "unproven";
  /** Present only for `unproven`. */
  readonly reason?: NativeWindowsClaudeCustodyStopUnprovenReason;
  /** The complete transport witness, or null. */
  readonly witness: NativeWindowsClaudeCustodySettlementWitness | null;
  /** Supervisor lifecycle facts, observed from the exact child handle. */
  readonly supervisorSpawned: boolean;
  readonly supervisorClosed: boolean;
  /** PTY lifecycle facts, observed from the exact wrapper handle. */
  readonly wrapperSpawned: boolean;
  readonly wrapperExited: boolean;
  readonly childEstablished: boolean;
  readonly confirmMayHaveBeenWritten: boolean;
  readonly settleAttempted: boolean;
}

export interface NativeWindowsClaudeCustodyAdapter {
  /** Run the one permitted launch. A second call reports `already-used`. */
  launch(): Promise<NativeWindowsClaudeCustodyLaunchResult>;
  /** The one idempotent, single-flight stop; every call returns the same promise. */
  stop(): Promise<NativeWindowsClaudeCustodyStopResult>;
}

/** Closed, nonsecret correlation metadata only: never a root, sender, binding, or authority. */
export type NativeWindowsClaudeCustodyAdapterHookCandidate = NativeWindowsClaudeCustodyHookCandidate;

export type NativeWindowsClaudeCustodyAdapterHookRefusal =
  /** This adapter was not created with the opt-in hook channel. */
  | "hook-disabled"
  /** No established launch was published by this adapter (yet, or ever). */
  | "not-established"
  /** The context is not the exact bound run, or the host says it is no longer current. */
  | "run-not-current"
  /** Cancelled, stopping, settled, exited, closed, or poisoned: custody is no longer live. */
  | "custody-not-current";

export type NativeWindowsClaudeCustodyAdapterHookObservation =
  | { readonly status: "candidate"; readonly candidate: NativeWindowsClaudeCustodyAdapterHookCandidate }
  | { readonly status: "none" }
  | { readonly status: "refused"; readonly code: NativeWindowsClaudeCustodyAdapterHookRefusal };

/** The adapter created with the opt-in hook channel. */
export interface NativeWindowsClaudeCustodyHookAdapter extends NativeWindowsClaudeCustodyAdapter {
  /**
   * The transport's latest credited candidate for the exact bound run, under
   * this adapter's established, current, unstopped launch. Synchronous and
   * read-only; it never writes, waits, or consumes the candidate.
   */
  observeHookCandidate(context: NativeWindowsClaudeCustodyRun): NativeWindowsClaudeCustodyAdapterHookObservation;
}

/** Closed refusal of a control call the adapter declined before reaching the transport. */
export interface NativeWindowsClaudeCustodyAdapterControlRefusal {
  readonly status: "refused";
  readonly code: "control-disabled" | "run-not-current" | "custody-not-current";
}

/**
 * The adapter created with `hookChannel.control: true`. Every call is for the
 * exact bound run only and forwards to the exact attached transport unchanged.
 */
export interface NativeWindowsClaudeCustodyControlAdapter extends NativeWindowsClaudeCustodyHookAdapter {
  /** The transport's `BIND` of the caller's ALREADY correlated latest candidate. */
  bindHookCandidate(
    context: NativeWindowsClaudeCustodyRun,
    candidate: NativeWindowsClaudeCustodyAdapterHookCandidate,
    fence: NativeWindowsClaudeCustodyHookBindingFence,
  ): Promise<NativeWindowsClaudeCustodyBindResult | NativeWindowsClaudeCustodyAdapterControlRefusal>;
  /** The transport's immediate local revocation, then its `DROP`. */
  dropHookCandidate(
    context: NativeWindowsClaudeCustodyRun,
    sequence: number,
  ): Promise<NativeWindowsClaudeCustodyDropResult | NativeWindowsClaudeCustodyAdapterControlRefusal>;
  /** The transport's current local binding, read-only. */
  observeHookBinding(context: NativeWindowsClaudeCustodyRun): NativeWindowsClaudeCustodyHookBindingObservation;
  /**
   * The same publication as `observeHookCandidate`, plus the transport's local
   * monotonic credit time of that candidate (host metadata, never wire data).
   */
  observeHookCandidateCredit(
    context: NativeWindowsClaudeCustodyRun,
  ): NativeWindowsClaudeCustodyHookCandidateCredit | NativeWindowsClaudeCustodyAdapterControlRefusal;
  /**
   * One two-phase send: the transport's `prepareSend` for the exact run, then
   * its `commit(payload, fence)` synchronously. Never throws.
   */
  commitHookSend(
    context: NativeWindowsClaudeCustodyRun,
    payload: NativeWindowsClaudeCustodySendPayloadSource,
    fence: NativeWindowsClaudeCustodySendFence,
  ): NativeWindowsClaudeCustodySendCommit;
}

/* -------------------------------------------------------------- validation */

function isPositivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_PID;
}

function copyRun(input: unknown): NativeWindowsClaudeCustodyRun | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { runId, generation } = input as Record<string, unknown>;
  if (
    typeof runId !== "string"
    || runId.length < 1
    || runId.length > MAX_RUN_ID_CHARS
    || !RUN_ID_PATTERN.test(runId)
    || typeof generation !== "number"
    || !Number.isSafeInteger(generation)
    || generation <= 0
  ) {
    return undefined;
  }
  return Object.freeze({ runId, generation });
}

/**
 * Read the opt-in hook channel from the options exactly once, every read
 * guarded. `undefined` = omitted; `null` = requested but unusable (including a
 * throwing read), refused and never coerced into "no hook". The key is
 * returned only to be sealed into the one-shot holder.
 */
function readHookChannel(
  options: object,
): { readonly pipe: string; readonly key: string; readonly control: boolean } | null | undefined {
  try {
    const input: unknown = (options as { readonly hookChannel?: unknown }).hookChannel;
    if (input === undefined) return undefined;
    if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
    const pipe: unknown = (input as Record<string, unknown>).pipe;
    const key: unknown = (input as Record<string, unknown>).key;
    const control: unknown = (input as Record<string, unknown>).control;
    if (typeof pipe !== "string" || !WINDOWS_CLAUDE_CUSTODY_HOOK_PIPE_PATTERN.test(pipe)) return null;
    if (typeof key !== "string" || !HOOK_KEY_PATTERN.test(key)) return null;
    // Only an omitted (or explicit false) control keeps the candidate-only composition.
    if (control !== undefined && typeof control !== "boolean") return null;
    return { pipe, key, control: control === true };
  } catch {
    return null;
  }
}

/** True only for exactly the pinned run; a throwing context is never current. */
function isExactRun(context: unknown, run: NativeWindowsClaudeCustodyRun): boolean {
  try {
    const copy = copyRun(context);
    return copy !== undefined && copy.runId === run.runId && copy.generation === run.generation;
  } catch {
    return false;
  }
}

function controlRefused(
  code: NativeWindowsClaudeCustodyAdapterControlRefusal["code"],
): NativeWindowsClaudeCustodyAdapterControlRefusal {
  return Object.freeze({ status: "refused", code } as const);
}

function hookRefused(code: NativeWindowsClaudeCustodyAdapterHookRefusal): NativeWindowsClaudeCustodyAdapterHookObservation {
  return Object.freeze({ status: "refused", code } as const);
}

function resolveDeadlines(input: unknown): NativeWindowsClaudeCustodyAdapterDeadlines | undefined {
  if (input === undefined) return DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_ADAPTER_DEADLINES;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const out: Record<string, number> = { ...DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_ADAPTER_DEADLINES };
  for (const key of Object.keys(DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_ADAPTER_DEADLINES)) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (
      typeof value !== "number"
      || !Number.isSafeInteger(value)
      || value < 1
      || value > NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_DEADLINE_MS
    ) {
      return undefined;
    }
    out[key] = value;
  }
  return Object.freeze(out as unknown as NativeWindowsClaudeCustodyAdapterDeadlines);
}

/* ------------------------------------------------------------------ helpers */

interface ActiveStep {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  release(): void;
}

function failed(
  code: NativeWindowsClaudeCustodyLaunchFailureCode,
  detail?: NativeWindowsClaudeCustodyAdapterFailureDetail,
): NativeWindowsClaudeCustodyLaunchFailure {
  return Object.freeze(detail === undefined ? { status: "failed", code } as const : { status: "failed", code, detail } as const);
}

function launched(
  supervisorPid: number,
  wrapperPid: number,
  childPid: number,
): NativeWindowsClaudeCustodyLaunchSuccess {
  return Object.freeze({ status: "launched", supervisorPid, wrapperPid, childPid } as const);
}

/** Abortable bounded sleep used only inside a launch step. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("step aborted"));
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    let subscription: Disposable | undefined;
    const finish = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      subscription?.[Symbol.dispose]();
      resolve();
    };
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      subscription?.[Symbol.dispose]();
      reject(new Error("step aborted"));
    };
    subscription = addAbortListener(signal, onAbort);
    timer = setTimeout(finish, Math.max(1, Math.min(ms, NATIVE_WINDOWS_CLAUDE_CUSTODY_MAX_DEADLINE_MS)));
  });
}

/* --------------------------------------------------------------- the class */

class Adapter implements NativeWindowsClaudeCustodyControlAdapter {
  private readonly optionsValid: boolean;
  private readonly powershellPath: string;
  private readonly target: string;
  private readonly args: readonly string[];
  private readonly run: NativeWindowsClaudeCustodyRun | undefined;
  private readonly isRunCurrent: () => boolean;
  private readonly callerSignal: AbortSignal | undefined;
  private readonly spawnSupervisor: (launch: WindowsClaudeCustodySupervisorLaunch) => ChildProcess;
  private readonly spawnWrapper: (launch: WindowsClaudeCustodyWrapperLaunch) => NativeWindowsClaudeCustodyWrapperHandle;
  private readonly deadlines: NativeWindowsClaudeCustodyAdapterDeadlines;
  private readonly controlPipe: string;
  private readonly controlNonce: string;
  private readonly controlReady: boolean;
  /** The opt-in hook channel was supplied at all (valid or not). */
  private readonly hookRequested: boolean;
  /** The opt-in hook channel was supplied AND valid; only then is anything composed. */
  private readonly hookMode: boolean;
  private readonly hookPipe: string;
  /** The opt-in hook CONTROL mode was supplied on a valid hook channel. */
  private readonly hookControl: boolean;
  /**
   * One-shot key holder: returns the key at most once and then (or on drop)
   * forgets it. ECMAScript-private (not erasable like TypeScript `private`)
   * and a closure, so no caller can reach, call, or inspect it.
   */
  readonly #takeHookKey: () => string | undefined;

  private launchStarted = false;
  /** Set only when runLaunch() publishes an established launch. */
  private launchPublished = false;
  private stopRequested = false;
  private stopPromise: Promise<NativeWindowsClaudeCustodyStopResult> | null = null;
  private activeStep: ActiveStep | null = null;

  private supervisor: ChildProcess | null = null;
  private supervisorSpawned = false;
  private supervisorSpawnUncertain = false;
  private supervisorClosed = false;
  private supervisorKilled = false;
  private readonly supervisorCloseWaiters = new Set<() => void>();

  private wrapper: NativeWindowsClaudeCustodyWrapperHandle | null = null;
  private wrapperSpawned = false;
  private wrapperSpawnUncertain = false;
  private wrapperExited = false;
  private wrapperExitObservable = false;
  private wrapperKilled = false;
  private wrapperExitDisposable: { dispose(): void } | null = null;
  private readonly wrapperExitWaiters = new Set<(exited: boolean) => void>();

  private transport: NativeWindowsClaudeCustodyTransport | null = null;
  private confirmMayHaveBeenWritten = false;
  private thunkRefusal: NativeWindowsClaudeCustodyLaunchFailureCode | null = null;
  private childEstablished = false;
  private childHandoff: Promise<void> | null = null;
  private childHandoffResolve: (() => void) | null = null;
  private childHandoffDone = true;
  private settleAttempted = false;
  private witness: NativeWindowsClaudeCustodySettlementWitness | null = null;

  constructor(options: NativeWindowsClaudeCustodyAdapterOptions) {
    const input = (typeof options === "object" && options !== null ? options : {}) as Partial<NativeWindowsClaudeCustodyAdapterOptions>;
    this.powershellPath = typeof input.powershellPath === "string" ? input.powershellPath : "";
    this.target = typeof input.target === "string" ? input.target : "";
    this.args = Array.isArray(input.args) && input.args.every((arg) => typeof arg === "string")
      ? Object.freeze([...input.args])
      : Object.freeze([]);
    this.run = copyRun(input.run);
    this.isRunCurrent = typeof input.isRunCurrent === "function" ? input.isRunCurrent : () => false;
    this.callerSignal = input.signal instanceof AbortSignal ? input.signal : undefined;
    this.spawnSupervisor = typeof input.spawnSupervisor === "function"
      ? input.spawnSupervisor
      : () => { throw new Error("missing spawn supervisor"); };
    this.spawnWrapper = typeof input.spawnWrapper === "function"
      ? input.spawnWrapper
      : () => { throw new Error("missing spawn wrapper"); };
    const deadlines = resolveDeadlines(input.deadlines);
    this.deadlines = deadlines ?? DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_ADAPTER_DEADLINES;

    let control: { pipe: string; nonce: string } | undefined;
    try {
      const pipe = `prg682-ctl-${randomBytes(16).toString("hex")}`;
      const nonce = randomBytes(16).toString("hex");
      if (WINDOWS_CLAUDE_CUSTODY_CONTROL_PIPE_PATTERN.test(pipe) && WINDOWS_CLAUDE_CUSTODY_NONCE_PATTERN.test(nonce)) {
        control = { pipe, nonce };
      }
    } catch {
      control = undefined;
    }
    this.controlPipe = control?.pipe ?? "";
    this.controlNonce = control?.nonce ?? "";
    this.controlReady = control !== undefined;

    const hook = readHookChannel(input);
    this.hookRequested = hook !== undefined;
    this.hookMode = hook !== undefined && hook !== null;
    this.hookPipe = hook?.pipe ?? "";
    this.hookControl = this.hookMode && hook?.control === true;
    let heldKey: string | undefined = hook?.key;
    this.#takeHookKey = () => {
      const key = heldKey;
      heldKey = undefined;
      return key;
    };

    this.optionsValid = this.run !== undefined
      && hook !== null
      && deadlines !== undefined
      && this.controlReady
      && typeof input.powershellPath === "string"
      && typeof input.target === "string"
      && (input.args === undefined || (Array.isArray(input.args) && input.args.every((arg) => typeof arg === "string")))
      && typeof input.isRunCurrent === "function"
      && (input.signal === undefined || input.signal instanceof AbortSignal)
      && typeof input.spawnSupervisor === "function"
      && typeof input.spawnWrapper === "function";
  }

  /* --------------------------------------------------------------- public */

  launch(): Promise<NativeWindowsClaudeCustodyLaunchResult> {
    if (this.launchStarted) return Promise.resolve(failed("already-used"));
    this.launchStarted = true;
    if (this.stopRequested) return Promise.resolve(failed("cancelled"));
    if (!this.optionsValid || this.run === undefined) {
      this.#takeHookKey();
      return Promise.resolve(failed("options-invalid"));
    }
    return this.runLaunch();
  }

  stop(): Promise<NativeWindowsClaudeCustodyStopResult> {
    if (this.stopPromise === null) {
      // Store the single-flight promise BEFORE aborting: poisoning can invoke
      // the exact supervisor's kill synchronously, and that path may reenter
      // stop() from caller code. The gate lets the assignment land first.
      this.stopRequested = true;
      // Nothing may hand the key out after a stop request.
      this.#takeHookKey();
      let resume: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      this.stopPromise = gate.then(() => this.stopInternal());
      this.abortActiveStep();
      resume?.();
    }
    return this.stopPromise;
  }

  observeHookCandidate(context: NativeWindowsClaudeCustodyRun): NativeWindowsClaudeCustodyAdapterHookObservation {
    try {
      if (!this.hookRequested) return hookRefused("hook-disabled");
      const run = this.run;
      if (run === undefined || !isExactRun(context, run)) return hookRefused("run-not-current");
      if (!this.hookMode || !this.launchPublished) return hookRefused("not-established");
      if (!this.hookCustodyLive()) return hookRefused("custody-not-current");
      if (!this.runIsCurrent()) return hookRefused("run-not-current");
      // The predicate is caller code: it may have stopped/cancelled us.
      if (!this.hookCustodyLive()) return hookRefused("custody-not-current");
      const transport = this.transport;
      if (transport === null) return hookRefused("custody-not-current");
      // Always the pinned run object, never the caller's context.
      const observed = transport.observeHookCandidate(run);
      // The transport ran the host predicate again: re-check our own fences.
      if (!this.hookCustodyLive()) return hookRefused("custody-not-current");
      if (observed.status === "none") return Object.freeze({ status: "none" } as const);
      if (observed.status === "refused") {
        return hookRefused(observed.code === "run-not-current" ? "run-not-current" : "custody-not-current");
      }
      if (observed.status !== "candidate") return hookRefused("custody-not-current");
      const sequence: unknown = observed.candidate.sequence;
      const sessionId: unknown = observed.candidate.sessionId;
      if (
        typeof sequence !== "number"
        || !Number.isSafeInteger(sequence)
        || sequence < 1
        || typeof sessionId !== "string"
        || !HOOK_SESSION_ID_PATTERN.test(sessionId)
      ) {
        return hookRefused("custody-not-current");
      }
      // A fresh closed copy: no reference to transport state escapes.
      return Object.freeze({ status: "candidate", candidate: Object.freeze({ sequence, sessionId }) } as const);
    } catch {
      return hookRefused("custody-not-current");
    }
  }

  /* ------------------------------------------------------- opt-in control */

  /**
   * The gate shared by the control calls: control mode, the exact pinned run,
   * an established live launch, and the host's current-run predicate
   * (re-checked around it, because it is caller code). Returns the exact
   * transport, or the closed refusal.
   */
  private controlTransport(
    context: unknown,
  ): NativeWindowsClaudeCustodyTransport | NativeWindowsClaudeCustodyAdapterControlRefusal {
    if (!this.hookControl) return controlRefused("control-disabled");
    const run = this.run;
    if (run === undefined || !isExactRun(context, run)) return controlRefused("run-not-current");
    if (!this.hookCustodyLive()) return controlRefused("custody-not-current");
    if (!this.runIsCurrent()) return controlRefused("run-not-current");
    if (!this.hookCustodyLive()) return controlRefused("custody-not-current");
    return this.transport ?? controlRefused("custody-not-current");
  }

  async bindHookCandidate(
    context: NativeWindowsClaudeCustodyRun,
    candidate: NativeWindowsClaudeCustodyAdapterHookCandidate,
    fence: NativeWindowsClaudeCustodyHookBindingFence,
  ): Promise<NativeWindowsClaudeCustodyBindResult | NativeWindowsClaudeCustodyAdapterControlRefusal> {
    try {
      const transport = this.controlTransport(context);
      if (!isTransport(transport)) return transport;
      // Always the pinned run object; the transport re-proves everything else.
      return await transport.bindHookCandidate(this.run!, candidate, fence);
    } catch {
      return controlRefused("custody-not-current");
    }
  }

  async dropHookCandidate(
    context: NativeWindowsClaudeCustodyRun,
    sequence: number,
  ): Promise<NativeWindowsClaudeCustodyDropResult | NativeWindowsClaudeCustodyAdapterControlRefusal> {
    try {
      if (!this.hookControl) return controlRefused("control-disabled");
      const run = this.run;
      if (run === undefined || !isExactRun(context, run)) return controlRefused("run-not-current");
      const transport = this.transport;
      if (transport === null) return controlRefused("custody-not-current");
      // Deliberately NOT gated on liveness: for the exact run the transport
      // revokes local authority first, on every path, even when it then
      // refuses to write (stopping, poisoned, busy).
      return await transport.dropHookCandidate(run, sequence);
    } catch {
      return controlRefused("custody-not-current");
    }
  }

  observeHookBinding(context: NativeWindowsClaudeCustodyRun): NativeWindowsClaudeCustodyHookBindingObservation {
    try {
      const transport = this.controlTransport(context);
      if (!isTransport(transport)) return transport;
      const observed = transport.observeHookBinding(this.run!);
      // The transport ran the host predicate again: re-check our own fences.
      if (!this.hookCustodyLive()) return controlRefused("custody-not-current");
      if (observed.status !== "bound") return observed;
      const sequence: unknown = observed.binding.sequence;
      const sessionId: unknown = observed.binding.sessionId;
      if (
        typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1
        || typeof sessionId !== "string" || !HOOK_SESSION_ID_PATTERN.test(sessionId)
      ) {
        return controlRefused("custody-not-current");
      }
      return Object.freeze({ status: "bound", binding: Object.freeze({ sequence, sessionId }) } as const);
    } catch {
      return controlRefused("custody-not-current");
    }
  }

  observeHookCandidateCredit(
    context: NativeWindowsClaudeCustodyRun,
  ): NativeWindowsClaudeCustodyHookCandidateCredit | NativeWindowsClaudeCustodyAdapterControlRefusal {
    try {
      const transport = this.controlTransport(context);
      if (!isTransport(transport)) return transport;
      const observed = transport.observeHookCandidateCredit(this.run!);
      // The transport ran the host predicate again: re-check our own fences.
      if (!this.hookCustodyLive()) return controlRefused("custody-not-current");
      if (observed.status !== "candidate") return observed;
      const sequence: unknown = observed.candidate.sequence;
      const sessionId: unknown = observed.candidate.sessionId;
      const creditedAt: unknown = observed.creditedAt;
      if (
        typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1
        || typeof sessionId !== "string" || !HOOK_SESSION_ID_PATTERN.test(sessionId)
        || typeof creditedAt !== "number" || !Number.isFinite(creditedAt)
      ) {
        return controlRefused("custody-not-current");
      }
      return Object.freeze({ status: "candidate", candidate: Object.freeze({ sequence, sessionId }), creditedAt } as const);
    } catch {
      return controlRefused("custody-not-current");
    }
  }

  commitHookSend(
    context: NativeWindowsClaudeCustodyRun,
    payload: NativeWindowsClaudeCustodySendPayloadSource,
    fence: NativeWindowsClaudeCustodySendFence,
  ): NativeWindowsClaudeCustodySendCommit {
    const notSent = (code: "run-not-current" | "custody-not-current" | "lane-unavailable") =>
      Object.freeze({ status: "not-sent", code } as const);
    let prepared: ReturnType<NativeWindowsClaudeCustodyTransport["prepareSend"]>;
    try {
      const transport = this.controlTransport(context);
      if (!isTransport(transport)) return notSent(transport.code === "control-disabled" ? "lane-unavailable" : transport.code);
      prepared = transport.prepareSend(this.run!);
    } catch {
      return notSent("custody-not-current");
    }
    if (prepared.status !== "prepared") return Object.freeze({ status: "not-sent", code: prepared.code } as const);
    const attempt = prepared.attempt;
    try {
      // The prepare ran the host predicate: re-check our own fences first.
      if (!this.hookCustodyLive()) {
        attempt.abandon();
        return notSent("custody-not-current");
      }
      return attempt.commit(payload, fence);
    } catch {
      // A commit that faults after its prepare may already have handed a frame
      // over: never claim `not-sent`, and never retry.
      try {
        attempt.abandon();
      } catch {
        // Spent either way.
      }
      return Object.freeze({
        status: "dispatched",
        attemptId: attempt.attemptId,
        outcome: Promise.resolve(Object.freeze({ status: "unknown", attemptId: attempt.attemptId, code: "transport-failed" } as const)),
      } as const);
    }
  }

  /** Adapter-owned liveness for candidate publication; every fact fails closed. */
  private hookCustodyLive(): boolean {
    return this.launchPublished
      && this.childEstablished
      && !this.cancelled()
      && !this.wrapperExited
      && !this.supervisorClosed
      && !this.settleAttempted
      && this.transport !== null
      && this.transportPoison() === null;
  }

  /* --------------------------------------------------------------- launch */

  private async runLaunch(): Promise<NativeWindowsClaudeCustodyLaunchResult> {
    let result: NativeWindowsClaudeCustodyLaunchResult;
    try {
      result = await this.attemptLaunch();
      if (result.status === "launched") {
        // Publish only after the final await. A queued stop, PTY exit, run
        // change, or transport poison can land between attemptLaunch()'s return
        // and this continuation. Custody remains recorded, so a late refusal
        // still takes the one-settlement cleanup path below.
        const live = this.preChildFailure();
        if (live !== undefined) {
          result = failed(live);
        } else {
          const poison = this.transportPoison();
          if (poison !== null) result = failed("child-not-established", poison);
        }
      }
      // Publication is the only gate that opens candidate observation.
      if (result.status === "launched") this.launchPublished = true;
    } catch {
      result = failed("unexpected");
    }
    if (result.status === "failed") {
      // The same single-flight stop performs every owned cleanup before the
      // failure is reported; a later stop() observes that same result.
      await this.stop();
    }
    return result;
  }

  private async attemptLaunch(): Promise<NativeWindowsClaudeCustodyLaunchResult> {
    const run = this.run;
    if (run === undefined) return failed("options-invalid");
    const beforeSpawn = this.preChildFailure();
    if (beforeSpawn !== undefined) return failed(beforeSpawn);

    const supervisorLaunch = this.renderSupervisorLaunch();
    if (supervisorLaunch === undefined) return failed("rendering-failed", "supervisor");

    let supervisor: ChildProcess;
    try {
      supervisor = this.spawnSupervisor(supervisorLaunch);
    } catch {
      this.supervisorSpawnUncertain = true;
      return failed("supervisor-spawn-uncertain");
    }
    if (typeof supervisor !== "object" || supervisor === null) {
      this.supervisorSpawnUncertain = true;
      return failed("supervisor-spawn-uncertain");
    }
    this.supervisor = supervisor;
    this.supervisorSpawned = true;
    this.observeSupervisorClose(supervisor);

    const attach = attachNativeWindowsClaudeCustodyTransport({
      child: supervisor,
      run,
      isRunCurrent: this.isRunCurrent,
      deadlines: {
        readyMs: this.deadlines.readyMs,
        peerMs: this.deadlines.peerMs,
        childMs: this.deadlines.childMs,
        // Hook mode: SETTLE may wait behind one in-flight protected hook turn
        // before the supervisor starts its own job-empty wait, so a shorter
        // override is floored at the shipped default (which covers both). The
        // ordinary path forwards the override unchanged.
        // Control mode: SETTLE may also wait behind one SEND, so the floor is
        // the transport's paired control default instead.
        settleMs: this.hookControl
          ? Math.max(this.deadlines.settleMs, NATIVE_WINDOWS_CLAUDE_CUSTODY_CONTROL_DEFAULT_SETTLE_MS)
          : this.hookMode
            ? Math.max(this.deadlines.settleMs, DEFAULT_NATIVE_WINDOWS_CLAUDE_CUSTODY_DEADLINES.settleMs)
            : this.deadlines.settleMs,
      },
      // Opt-in only; the default attach options stay exactly as before.
      ...(this.hookMode ? { hookCandidates: true } : {}),
      ...(this.hookControl ? { hookControl: true } : {}),
    });
    if (attach.status !== "attached") return failed("supervisor-attach-refused", attach.code);
    this.transport = attach.transport;

    const afterAttach = this.preChildFailure();
    if (afterAttach !== undefined) return failed(afterAttach);

    const bootStep = this.beginStep();
    let booted: NativeWindowsClaudeCustodyStartResult | undefined;
    try {
      booted = await this.#startTransport(attach.transport, supervisorLaunch.source, bootStep.signal);
    } finally {
      bootStep.release();
    }
    if (booted === undefined) return failed(this.preChildFailure() ?? "unexpected");
    if (booted.status !== "ready-for-pty-spawn") return this.mapTransportFailure("supervisor-boot-failed", booted.code);

    const beforeWrapper = this.preChildFailure();
    if (beforeWrapper !== undefined) return failed(beforeWrapper);

    const wrapperLaunch = this.renderWrapperLaunch(booted.supervisorPid);
    if (wrapperLaunch === undefined) return failed("rendering-failed", "wrapper");

    // The wrapper render is pure, but the spawn is the effect: re-check the
    // pinned run and cancellation immediately before it.
    const beforeWrapperSpawn = this.preChildFailure();
    if (beforeWrapperSpawn !== undefined) return failed(beforeWrapperSpawn);
    // A successful SUP_READY does not make an already-poisoned transport
    // usable. Check AFTER the host predicate, then spawn synchronously.
    const bootPoison = this.transportPoison();
    if (bootPoison !== null) return failed("supervisor-boot-failed", bootPoison);

    let wrapper: NativeWindowsClaudeCustodyWrapperHandle;
    try {
      wrapper = this.spawnWrapper(wrapperLaunch);
    } catch {
      this.wrapperSpawnUncertain = true;
      return failed("wrapper-spawn-uncertain");
    }
    if (typeof wrapper !== "object" || wrapper === null) {
      this.wrapperSpawnUncertain = true;
      return failed("wrapper-spawn-uncertain");
    }
    this.wrapperSpawned = true;
    this.wrapper = wrapper;

    const observable = this.bindWrapperExit(wrapper);
    if (!observable) return failed("wrapper-unobservable");

    const pidFailure = await this.awaitWrapperPid();
    if (pidFailure !== undefined) return failed(pidFailure);

    const beforeConfirm = this.preChildFailure();
    if (beforeConfirm !== undefined) return failed(beforeConfirm);

    const confirmStep = this.beginStep();
    let confirmed;
    try {
      confirmed = await attach.transport.confirmPeer(
        () => this.readPtyPidAtFence(confirmStep.signal),
        { signal: confirmStep.signal },
      );
    } finally {
      confirmStep.release();
    }
    if (confirmed.status !== "peer-confirmed") return this.mapTransportFailure("confirm-failed", confirmed.code);
    const wrapperPid = confirmed.wrapperPid;

    const afterGo = this.preChildFailure();
    if (afterGo !== undefined) return failed(afterGo);

    const childStep = this.beginStep();
    this.beginChildHandoff();
    let child: NativeWindowsClaudeCustodyChildResult;
    try {
      child = await attach.transport.awaitChild({ signal: childStep.signal });
      // Record the successful handoff BEFORE publishing the handoff promise, so
      // stop() can never dispose the transport before it knows custody exists.
      if (child.status === "child-established") this.childEstablished = true;
    } finally {
      childStep.release();
      this.completeChildHandoff();
    }
    if (child.status !== "child-established") return this.mapTransportFailure("child-not-established", child.code);

    // Candidate success only. runLaunch() owns the final live/current/PTY-exit
    // and transport-poison checks after its last await, then publishes.
    return launched(booted.supervisorPid, wrapperPid, child.childPid);
  }

  /**
   * The one transport start. Default: exactly `{ signal }`. Opt-in: the key is
   * taken from the one-shot holder (emptying it) straight into a short-lived
   * mutable start options object, and deleted from that object in a
   * synchronous `finally` as soon as the `start` call returns its promise. The
   * transport reads the key and submits its one (scrubbed) write before its
   * first await, while its boot wait keeps only the now key-less object.
   * Undefined means the held key was already dropped (a stop raced in).
   * ECMAScript-private: no caller can hand the key to another transport.
   */
  #startTransport(
    transport: NativeWindowsClaudeCustodyTransport,
    source: string,
    signal: AbortSignal,
  ): Promise<NativeWindowsClaudeCustodyStartResult> | Promise<undefined> {
    if (!this.hookMode) return transport.start(source, { signal });
    const startOptions: { signal: AbortSignal; hookKey?: string } = { signal, hookKey: this.#takeHookKey() };
    if (startOptions.hookKey === undefined) return Promise.resolve(undefined);
    try {
      return transport.start(source, startOptions);
    } finally {
      // Synchronous, never awaited: nothing retains the key after the handoff.
      delete startOptions.hookKey;
    }
  }

  /* -------------------------------------------------------------- rendering */

  private renderSupervisorLaunch(): WindowsClaudeCustodySupervisorLaunch | undefined {
    try {
      return buildWindowsClaudeCustodySupervisorLaunch({
        powershellPath: this.powershellPath,
        ctlPipe: this.controlPipe,
        ctlNonce: this.controlNonce,
        // Opt-in only: an omitted hookPipe renders the default supervisor byte for byte,
        // and an omitted control keeps the candidate-only hook body byte for byte.
        ...(this.hookMode ? { hookPipe: this.hookPipe } : {}),
        ...(this.hookControl ? { hookControl: true } : {}),
      });
    } catch {
      return undefined;
    }
  }

  private renderWrapperLaunch(supervisorPid: number): WindowsClaudeCustodyWrapperLaunch | undefined {
    try {
      return buildWindowsClaudeCustodyWrapperLaunch({
        powershellPath: this.powershellPath,
        target: this.target,
        args: this.args,
        ctlPipe: this.controlPipe,
        ctlNonce: this.controlNonce,
        supervisorPid,
      });
    } catch {
      return undefined;
    }
  }

  /* --------------------------------------------------------- PTY lifecycle */

  /** Bind exit receipt immediately; false means this handle cannot be observed. */
  private bindWrapperExit(wrapper: NativeWindowsClaudeCustodyWrapperHandle): boolean {
    try {
      if (typeof wrapper.kill !== "function" || typeof wrapper.onExit !== "function") return false;
      const disposable = wrapper.onExit(() => this.noteWrapperExit());
      if (disposable !== undefined && disposable !== null && typeof disposable.dispose === "function") {
        this.wrapperExitDisposable = disposable;
      }
      this.wrapperExitObservable = true;
      return true;
    } catch {
      return false;
    }
  }

  private noteWrapperExit(): void {
    if (this.wrapperExited) return;
    this.wrapperExited = true;
    for (const waiter of [...this.wrapperExitWaiters]) waiter(true);
    this.wrapperExitWaiters.clear();
    this.abortActiveStep();
    // A PTY exit after custody was established must trigger the same bounded
    // stop/settle path. Before that point the launch itself fails and owns
    // cleanup; the exit is never used as target/job proof.
    if (this.childEstablished) void this.stop().catch(() => undefined);
  }

  /** Poll the SAME live handle under a monotonic bounded step; never cache. */
  private async awaitWrapperPid(): Promise<NativeWindowsClaudeCustodyLaunchFailureCode | undefined> {
    const step = this.beginStep();
    const deadline = performance.now() + this.deadlines.wrapperPidMs;
    try {
      for (;;) {
        if (this.cancelled()) return "cancelled";
        if (this.wrapperExited) return "wrapper-exited";
        if (!this.runIsCurrent()) return "run-not-current";
        // Check BEFORE polling: a positive value at or after the deadline was
        // not observed within wrapperPidMs and must never advance to CONFIRM.
        if (performance.now() >= deadline) return "wrapper-pid-unavailable";

        let pid: unknown;
        try {
          pid = this.wrapper?.pid;
        } catch {
          return "wrapper-unobservable";
        }
        if (isPositivePid(pid)) {
          // Check AGAIN before accepting: the live getter is caller/native code
          // and may itself have crossed the monotonic deadline.
          if (performance.now() >= deadline) return "wrapper-pid-unavailable";
          return undefined;
        }

        const now = performance.now();
        if (now >= deadline) return "wrapper-pid-unavailable";
        try {
          await sleep(Math.min(DEFAULT_WRAPPER_PID_POLL_MS, deadline - now), step.signal);
        } catch {
          if (this.cancelled()) return "cancelled";
          if (this.wrapperExited) return "wrapper-exited";
          if (!this.runIsCurrent()) return "run-not-current";
          return "wrapper-pid-unavailable";
        }
      }
    } finally {
      step.release();
    }
  }

  /**
   * The transport's synchronous write fence. It is entered only after a
   * positive PID was observed, but it re-reads the SAME live getter and
   * re-checks cancellation and run currency on both sides of that read.
   */
  private readPtyPidAtFence(signal: AbortSignal): number {
    // Conservative: entering this thunk is already enough to say a CONFIRM may
    // have reached the supervisor. No byte-level receipt is ever claimed.
    this.confirmMayHaveBeenWritten = true;

    const refuse = (code: NativeWindowsClaudeCustodyLaunchFailureCode): never => {
      this.thunkRefusal = code;
      throw new Error("pty pid fence refused");
    };

    if (signal.aborted || this.cancelled()) return refuse("cancelled");
    if (!this.runIsCurrent()) return refuse("run-not-current");
    if (this.wrapperExited) return refuse("wrapper-exited");

    let pid: unknown;
    try {
      pid = this.wrapper?.pid;
    } catch {
      return refuse("wrapper-unobservable");
    }

    // The live read above is caller/native code: re-check every fence before
    // handing the value to the transport's write path.
    if (signal.aborted || this.cancelled()) return refuse("cancelled");
    if (!this.runIsCurrent()) return refuse("run-not-current");
    if (this.wrapperExited) return refuse("wrapper-exited");
    if (!isPositivePid(pid)) return refuse("wrapper-pid-unavailable");
    return pid;
  }

  /* ------------------------------------------------------ supervisor facts */

  private observeSupervisorClose(supervisor: ChildProcess): void {
    const onClose = (): void => {
      this.supervisorClosed = true;
      for (const waiter of [...this.supervisorCloseWaiters]) waiter();
      this.supervisorCloseWaiters.clear();
    };
    // Consume spawn/pipe errors on the exact handle as soon as it is received.
    // The transport arms its own error listener only after a successful attach;
    // when it refuses (for example a missing PID followed by an asynchronous
    // error) this listener is what keeps Node from treating it as unhandled.
    // `close` remains the only closure receipt.
    const onError = (): void => {
      /* consumed; never a closure or custody witness */
    };
    try {
      supervisor.on("error", onError);
    } catch {
      // A handle without an error surface is refused by attach below.
    }
    // The transport registers its stdio error listeners only after a successful
    // attach. Before that (and when attach refuses) an asynchronous stream error
    // must still be consumed on each exact handle; no data/read/resume listener
    // is installed and none of these is a closure receipt.
    for (const stream of [supervisor.stdin, supervisor.stdout, supervisor.stderr]) {
      if (stream === null) continue;
      try {
        stream.on("error", onError);
      } catch {
        // Per-stream guard: a broken stream surface cannot block the others.
      }
    }
    try {
      if (typeof supervisor.once === "function") supervisor.once("close", onClose);
      else supervisor.on("close", onClose);
    } catch {
      // The transport still owns its own lifecycle observation; the adapter's
      // separate closure fact simply stays false and stop() reports unproven.
    }
  }

  /* --------------------------------------------------------------- fences */

  private cancelled(): boolean {
    return this.stopRequested || this.callerSignal?.aborted === true;
  }

  private runIsCurrent(): boolean {
    try {
      return this.isRunCurrent() === true;
    } catch {
      return false;
    }
  }

  /** The exact transport's poison state; diagnostics faults stay fail-closed. */
  private transportPoison(): NativeWindowsClaudeCustodyPoisonCode | null {
    try {
      return this.transport?.diagnostics().poisonCode ?? null;
    } catch {
      return "process-error";
    }
  }

  private preChildFailure(): NativeWindowsClaudeCustodyLaunchFailureCode | undefined {
    if (this.cancelled()) return "cancelled";
    if (!this.runIsCurrent()) return "run-not-current";
    // The predicate is caller code; it may have cancelled or stopped us.
    if (this.cancelled()) return "cancelled";
    if (this.wrapperSpawned && this.wrapperExited) return "wrapper-exited";
    return undefined;
  }

  private mapTransportFailure(
    fallback: NativeWindowsClaudeCustodyLaunchFailureCode,
    detail: NativeWindowsClaudeCustodyPoisonCode | NativeWindowsClaudeCustodyMisuseCode,
  ): NativeWindowsClaudeCustodyLaunchFailure {
    if (this.thunkRefusal !== null) {
      const refusal = this.thunkRefusal;
      this.thunkRefusal = null;
      return failed(refusal);
    }
    const live = this.preChildFailure();
    if (live !== undefined) return failed(live);
    return failed(fallback, detail);
  }

  /* ---------------------------------------------------------- step control */

  private beginStep(): ActiveStep {
    const controller = new AbortController();
    const caller = this.callerSignal;
    const onCallerAbort = (): void => controller.abort();
    let subscription: Disposable | undefined;
    if (caller !== undefined) {
      if (caller.aborted) controller.abort();
      // addAbortListener still runs after an earlier consumer of a shared
      // signal calls stopImmediatePropagation().
      else subscription = addAbortListener(caller, onCallerAbort);
    }
    let released = false;
    const step: ActiveStep = {
      controller,
      signal: controller.signal,
      release: (): void => {
        if (released) return;
        released = true;
        subscription?.[Symbol.dispose]();
        if (this.activeStep === step) this.activeStep = null;
      },
    };
    this.activeStep = step;
    return step;
  }

  private abortActiveStep(): void {
    this.activeStep?.controller.abort();
  }

  private beginChildHandoff(): void {
    this.childHandoffDone = false;
    this.childHandoff = new Promise<void>((resolve) => {
      this.childHandoffResolve = resolve;
    });
  }

  private completeChildHandoff(): void {
    if (this.childHandoffDone) return;
    this.childHandoffDone = true;
    const resolve = this.childHandoffResolve;
    this.childHandoffResolve = null;
    resolve?.();
  }

  /**
   * Bounded internal handoff: stop() must not choose "no child" while the
   * transport's successful SUP_CHILD step is between its own resolution and the
   * adapter recording it. This never waits on the public launch promise.
   */
  private async waitChildHandoff(): Promise<void> {
    const handoff = this.childHandoff;
    if (handoff === null || this.childHandoffDone) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        handoff,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(1, this.deadlines.childMs));
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /* --------------------------------------------------------------- stop */

  private async stopInternal(): Promise<NativeWindowsClaudeCustodyStopResult> {
    try {
      await this.finishStop();
    } catch {
      // Fail closed on any unexpected internal fault: stop the exact handles
      // again (idempotent) and wait only inside the same bounded window.
      this.disposeTransport();
      this.killWrapper();
      this.killSupervisorDirectly();
      try {
        await this.waitForClosure();
      } catch {
        // The result below already reports whatever receipts were observed.
      }
    } finally {
      this.releaseWrapperObserver();
    }
    return this.buildStopResult();
  }

  private async finishStop(): Promise<void> {
    // The stop request aborted the in-flight child step. Wait (bounded) for the
    // adapter to record whether awaitChild() actually succeeded before choosing
    // settlement; this is an internal handoff, never the public launch promise.
    await this.waitChildHandoff();

    // Settle exactly once, and only after real awaitChild() custody. No signal:
    // caller cancellation/shutdown cannot poison or preempt this one witness.
    if (this.childEstablished && this.transport !== null && !this.settleAttempted) {
      this.settleAttempted = true;
      try {
        const settled = await this.transport.settle();
        if (settled.status === "settled") this.witness = settled.witness;
      } catch {
        this.witness = null;
      }
    }

    if (this.witness === null) {
      // No witness: dispose the transport (which poisons/kills its exact owned
      // supervisor), then stop the exact wrapper handle. Never a numeric PID.
      this.disposeTransport();
      this.killWrapper();
      this.killSupervisorDirectly();
    }

    await this.waitForClosure();
  }

  private async waitForClosure(): Promise<void> {
    await Promise.all([
      this.waitSupervisorClosed(this.deadlines.closeMs),
      this.waitWrapperExited(this.deadlines.closeMs),
      this.drainTransport(this.deadlines.closeMs),
    ]);
  }

  private waitSupervisorClosed(timeoutMs: number): Promise<void> {
    if (!this.supervisorSpawned || this.supervisorClosed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.supervisorCloseWaiters.delete(finish);
        resolve();
      };
      this.supervisorCloseWaiters.add(finish);
      timer = setTimeout(finish, Math.max(1, timeoutMs));
    });
  }

  private waitWrapperExited(timeoutMs: number): Promise<boolean> {
    if (!this.wrapperSpawned) return Promise.resolve(false);
    if (this.wrapperExited) return Promise.resolve(true);
    if (!this.wrapperExitObservable) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (exited: boolean): void => {
        if (timer !== undefined) clearTimeout(timer);
        this.wrapperExitWaiters.delete(finish);
        resolve(exited);
      };
      this.wrapperExitWaiters.add(finish);
      timer = setTimeout(() => finish(false), Math.max(1, timeoutMs));
    });
  }

  private async drainTransport(timeoutMs: number): Promise<void> {
    if (this.transport === null) return;
    try {
      await this.transport.drain({ timeoutMs });
    } catch {
      // Bounded drain is a cleanup receipt, not a witness.
    }
  }

  private disposeTransport(): void {
    if (this.transport === null) return;
    try {
      this.transport.dispose();
    } catch {
      // The transport marks itself poisoned before destroying stdin and before
      // signaling the supervisor. If that destroy throws, drain will not retry
      // cleanup (the transport is already poisoned), so the exact owned handle
      // must be signaled directly. The transport reference is kept for drain.
      this.killSupervisorDirectly(true);
    }
  }

  private killWrapper(): void {
    if (this.wrapper === null || this.wrapperKilled || this.wrapperExited) return;
    this.wrapperKilled = true;
    try {
      this.wrapper.kill();
    } catch {
      // The exit observer (if any) still owns what can be observed.
    }
  }

  private killSupervisorDirectly(disposalThrew = false): void {
    // On the normal path the transport owns that exact kill. Only a disposal
    // exception permits this exact-handle fallback.
    if (this.transport !== null && !disposalThrew) return;
    if (this.supervisor === null || this.supervisorKilled || this.supervisorClosed) return;
    this.supervisorKilled = true;
    try {
      this.supervisor.kill();
    } catch {
      // The close receipt remains the only closure authority.
    }
  }

  private releaseWrapperObserver(): void {
    const disposable = this.wrapperExitDisposable;
    this.wrapperExitDisposable = null;
    try {
      disposable?.dispose();
    } catch {
      // A disposed exit observer cannot affect the recorded receipt.
    }
  }

  /* -------------------------------------------------------------- results */

  private buildStopResult(): NativeWindowsClaudeCustodyStopResult {
    const base = {
      witness: this.witness,
      supervisorSpawned: this.supervisorSpawned,
      supervisorClosed: this.supervisorClosed,
      wrapperSpawned: this.wrapperSpawned,
      wrapperExited: this.wrapperExited,
      childEstablished: this.childEstablished,
      confirmMayHaveBeenWritten: this.confirmMayHaveBeenWritten,
      settleAttempted: this.settleAttempted,
    } as const;

    if (this.witness !== null) {
      return Object.freeze({ ...base, status: "witnessed-empty" as const });
    }

    if (this.childEstablished) {
      return Object.freeze({
        ...base,
        status: "unproven" as const,
        reason: this.settleAttempted ? "settlement-failed" as const : "settlement-not-attempted" as const,
      });
    }

    if (this.supervisorSpawnUncertain || this.wrapperSpawnUncertain) {
      return Object.freeze({ ...base, status: "unproven" as const, reason: "spawn-uncertain" as const });
    }

    if (this.confirmMayHaveBeenWritten) {
      // Entering the fence means a CONFIRM may have reached the supervisor and
      // a target may now exist. Never downgrade this to "no child".
      return Object.freeze({
        ...base,
        status: "unproven" as const,
        reason: "confirmation-may-have-been-written" as const,
      });
    }

    if (
      (this.supervisorSpawned && !this.supervisorClosed)
      || (this.wrapperSpawned && (!this.wrapperExitObservable || !this.wrapperExited))
    ) {
      return Object.freeze({ ...base, status: "unproven" as const, reason: "handle-unobserved" as const });
    }

    // The thunk was never entered: the rendered wrapper starts its target only
    // after GO, which follows CONFIRM. With every owned handle observed closed
    // and no spawn uncertainty, no target child can exist.
    return Object.freeze({ ...base, status: "no-child-possible" as const });
  }
}

function isTransport(
  value: NativeWindowsClaudeCustodyTransport | NativeWindowsClaudeCustodyAdapterControlRefusal,
): value is NativeWindowsClaudeCustodyTransport {
  return (value as { readonly status?: unknown }).status !== "refused";
}

/* ---------------------------------------------------------------- factory */

export function createNativeWindowsClaudeCustodyAdapter(
  options: NativeWindowsClaudeCustodyAdapterOptionsWithHookControl,
): NativeWindowsClaudeCustodyControlAdapter;
export function createNativeWindowsClaudeCustodyAdapter(
  options: NativeWindowsClaudeCustodyAdapterOptionsWithHookChannel,
): NativeWindowsClaudeCustodyHookAdapter;
export function createNativeWindowsClaudeCustodyAdapter(
  options: NativeWindowsClaudeCustodyAdapterOptions,
): NativeWindowsClaudeCustodyAdapter;
export function createNativeWindowsClaudeCustodyAdapter(
  options: NativeWindowsClaudeCustodyAdapterOptions,
): NativeWindowsClaudeCustodyAdapter | NativeWindowsClaudeCustodyHookAdapter | NativeWindowsClaudeCustodyControlAdapter {
  return new Adapter(options);
}
