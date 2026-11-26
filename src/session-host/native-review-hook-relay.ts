/**
 * #736 slice 2: bounded relay entrypoint for the BLOCKING native review hook.
 *
 * The provider runs this compiled module as a short-lived command hook child on
 * its `Stop` and `UserPromptSubmit` events: `node <this entry> <Event>`. It
 * reads exactly one strict-UTF-8, size-bounded JSON document from stdin,
 * selects only the closed allowlist from ./native-review-hook-protocol,
 * authenticates with the fresh per-owned-launch bootstrap carried in
 * NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV, sends one request line to the host's ONE
 * existing local status broker (POSIX Unix socket or Windows named pipe — the
 * same address and the same `net` connect path on every platform, with no shell
 * feature, POSIX signal, or path-joining assumption), and waits for the host's
 * single answer frame.
 * That ONE line is the whole request, reviewed assistant text included: nothing
 * is half-sent, the complete line is size-checked against this family's own
 * request bound before it reaches the socket, and the broker validates the
 * complete line before it reserves anything.
 *
 * `argv[2]` is the provider event name and is only a CROSS-CHECK against stdin's
 * own `hook_event_name`: a disagreement is a closed failure, never a guess.
 *
 * Unlike the observe-only hook relay, this one's answer changes what the
 * provider does with the turn, so its output contract is the provider's own:
 *
 *   - allow, no notice      -> no stdout
 *   - allow with a notice   -> {"systemMessage":"…"}
 *   - block                 -> {"decision":"block","reason":"…"} (+ systemMessage)
 *   - any failure           -> {"systemMessage":"pi-review-gate: automatic
 *                              review unavailable for this turn (reason); this
 *                              turn was not reviewed."}
 *   - abandoned wait        -> no stdout at all (see the two guards below)
 *
 * Every path exits zero. A relay failure NEVER emits a decision: reporting an
 * unavailable review as a block would loop the same turn forever, so the
 * transport degrades to "this turn was not reviewed" and lets the provider
 * proceed. The token and the bootstrap are never printed, echoed, or included
 * in any diagnostic.
 *
 * Deadlines cover the stdin read and the connect separately, and there is
 * deliberately NO deadline on the wait for the verdict: the provider's own
 * command-hook timeout governs it, and it kills this child (closing the socket,
 * which aborts the host's review) when the user presses Esc or the wait runs
 * out. What that timeout CANNOT do is guarantee this child dies with the hook:
 * verified live on Windows, the provider runs a command hook through
 * `cmd.exe /C`, its timeout kills only `cmd.exe`, and this Node relay is left
 * ORPHANED — holding a broker connection the host believes it is answering,
 * forever. So the wait for the verdict is additionally watched two ways, both
 * of which abandon the wait rather than end it with a verdict: a parent-liveness
 * probe (the provider process that spawned this hook is gone), and a backstop
 * deadline a minute inside NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS. Either one
 * destroys the held socket — which is what tells the host to abort its review —
 * and exits zero WITHOUT writing anything, because a notice for a turn nobody is
 * waiting for has no reader left. There is still no retry, queue, replay, or
 * second request.
 */

import { createConnection, type Socket } from "node:net";
import type {
  NativeReviewServerFrame,
  NativeReviewUnavailableReason,
} from "./native-review-hook-protocol";
import {
  MAX_NATIVE_REVIEW_REQUEST_FRAME_BYTES,
  MAX_NATIVE_REVIEW_RESPONSE_FRAME_BYTES,
  MAX_NATIVE_REVIEW_STDIN_BYTES,
  NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV,
  NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS,
  decodeNativeReviewServerFrame,
  encodeNativeReviewRequestFrame,
  isNativeReviewHookEventName,
  parseNativeReviewBootstrapEnv,
  sanitizeNativeReviewProviderInput,
} from "./native-review-hook-protocol";

/** Upper bound for the provider's stdin document read, in milliseconds. */
export const NATIVE_REVIEW_HOOK_STDIN_TIMEOUT_MS = 1500;
/** Upper bound for establishing the local broker connection, in milliseconds. */
export const NATIVE_REVIEW_HOOK_CONNECT_TIMEOUT_MS = 1500;

/**
 * How often the held wait asks whether the provider process that ran this hook
 * is still there. It is a liveness check on a process that normally outlives
 * the whole wait, so it is cheap and coarse by design: the only thing it can
 * change is abandoning a wait that would otherwise never be answered.
 */
export const NATIVE_REVIEW_HOOK_PARENT_POLL_MS = 400;

/**
 * The relay's own backstop on the held wait: the provider's hook timeout minus a
 * minute. This is NOT a review timeout — a legitimate review is allowed to run
 * right up to the provider's ceiling — it is the orphan guard for the case the
 * provider's timeout cannot reach, where the hook's shell died and this child
 * was left holding the connection. It is strictly longer than any host-side
 * review deadline, so a review the host is still working on is never abandoned
 * by the relay.
 */
export const NATIVE_REVIEW_HOOK_RELAY_DEADLINE_MS = NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS * 1000 - 60_000;

/** The one notice shown to the user when no verdict could be obtained. */
export function nativeReviewUnavailableMessage(reason: NativeReviewUnavailableReason): string {
  return `pi-review-gate: automatic review unavailable for this turn (${reason}); this turn was not reviewed.`;
}

/**
 * Observed relay outcome. It carries the closed reason for a failure and, for a
 * delivered answer, that answer's own closed shape — never provider text, a
 * token, a path, or the block reason itself.
 *
 * The one outcome with NO `reason` is a wait this relay abandoned because its
 * provider parent died or its own backstop fired: nothing was written, so there
 * is no notice this value could account for.
 */
export interface NativeReviewHookRelayOutcome {
  readonly status: "allow" | "block" | "unavailable";
  /** The closed reason, when no verdict was obtained. */
  readonly reason?: NativeReviewUnavailableReason;
}

/** Narrow injectable seams for tests; production uses process stdin/stdout and net.connect. */
export interface NativeReviewHookRelayOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly connect?: (socketPath: string) => Socket;
  /** The provider event name from argv[2]; absence reads the real `process.argv`. */
  readonly event?: string;
  readonly timeouts?: {
    readonly stdinMs?: number;
    readonly connectMs?: number;
  };
  /**
   * Injectable seams for the two guards on the held wait. Production supplies
   * none of them and uses the real `process.ppid` probe and the constants above.
   */
  readonly watchdog?: {
    /**
     * True while the process that spawned this hook is still alive. It is called
     * on an interval, never on the response path, and a throw is read as
     * "alive": a guard that cannot prove the parent is gone must never abandon a
     * review the host is still working on.
     */
    readonly isParentAlive?: () => boolean;
    /** Poll interval in milliseconds; `0` or less never polls. */
    readonly pollMs?: number;
    /** Backstop in milliseconds; `0` or less never fires. */
    readonly deadlineMs?: number;
  };
}

/**
 * The real parent-liveness probe. `process.ppid` is captured once, at relay
 * start, and the parent is gone when either signal says so:
 *
 * - `process.kill(initialPpid, 0)` throws ESRCH — no such process. EPERM means
 *   the process exists and this one may not signal it, which is ALIVE, and any
 *   other errno proves nothing, so only ESRCH abandons the wait.
 * - `process.ppid` no longer equals that captured value — on POSIX a child whose
 *   parent died is reparented, which is exactly the orphan this guard exists for.
 */
function createParentLivenessProbe(): () => boolean {
  const initialPpid = process.ppid;
  return (): boolean => {
    if (process.ppid !== initialPpid) return false;
    try {
      process.kill(initialPpid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
}

type StdinReadResult =
  | { readonly kind: "bytes"; readonly bytes: Buffer }
  | { readonly kind: "too-large" }
  | { readonly kind: "timeout" }
  | { readonly kind: "unavailable" };

/**
 * What the held wait can end as: the host's answer, one closed transport
 * failure the user is told about, or `abandoned` — this relay's own guard fired,
 * so the wait is over, the host has been told by the hangup, and there is
 * nobody left to receive a notice.
 */
type ExchangeResult =
  | { readonly failure: NativeReviewUnavailableReason }
  | { readonly frame: NativeReviewServerFrame }
  | { readonly abandoned: true };

/**
 * The same bounded stdin reader the observer relay uses: read at most
 * `limitBytes`, never retain a caller-owned buffer through a subarray view, and
 * treat a close without `end` as truncation rather than as data.
 */
function readBoundedStdin(
  stream: NodeJS.ReadableStream,
  limitBytes: number,
  timeoutMs: number,
): Promise<StdinReadResult> {
  return new Promise<StdinReadResult>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let ended = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      stream.removeListener("close", onClose);
    };
    const finish = (result: StdinReadResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (result.kind !== "bytes") {
        try {
          (stream as { destroy?: () => void }).destroy?.();
        } catch {
          // The read is already over; a stream teardown error is not observable here.
        }
      }
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      total += bytes.length;
      if (total > limitBytes) {
        finish({ kind: "too-large" });
        return;
      }
      // Copy the bounded chunk so a larger caller-owned buffer cannot be
      // retained through a subarray view.
      chunks.push(Buffer.from(bytes));
    };
    const onEnd = (): void => {
      ended = true;
      finish({ kind: "bytes", bytes: Buffer.concat(chunks, total) });
    };
    const onError = (): void => finish({ kind: "unavailable" });
    const onClose = (): void => {
      // A close without a preceding end means the provider stdin was truncated.
      if (!ended) finish({ kind: "unavailable" });
    };

    timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    timer.unref?.();
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
    try {
      (stream as { resume?: () => void }).resume?.();
    } catch {
      finish({ kind: "unavailable" });
    }
  });
}

/**
 * The provider's decision-JSON stdout for one answer frame. An allow with a
 * notice is the only non-empty allow output; a block always carries its reason,
 * which is the text the provider feeds back to its model.
 */
function providerStdoutFor(frame: NativeReviewServerFrame): string {
  if (frame.type === "native_review_error") {
    return `${JSON.stringify({ systemMessage: nativeReviewUnavailableMessage(frame.code) })}\n`;
  }
  if (frame.action === "block") {
    return `${JSON.stringify({
      decision: "block",
      reason: frame.reason ?? "",
      ...(frame.userMessage === undefined ? {} : { systemMessage: frame.userMessage }),
    })}\n`;
  }
  if (frame.userMessage === undefined) return "";
  return `${JSON.stringify({ systemMessage: frame.userMessage })}\n`;
}

/** The unavailable notice, as the exact stdout line the provider receives. */
function unavailableStdoutFor(reason: NativeReviewUnavailableReason): string {
  return `${JSON.stringify({ systemMessage: nativeReviewUnavailableMessage(reason) })}\n`;
}

/**
 * Sends the one request line and waits for the one answer frame. There is no
 * response deadline: the provider's hook timeout governs the wait, and a closed
 * socket (killed hook, broker gone) resolves to `closed` so the caller prints
 * the "not reviewed" notice instead. `frame` is present only for a frame this
 * family's strict decoder accepted.
 *
 * The two guards of the held wait live here, because this is the only stretch
 * where the relay is waiting on somebody else: while the request is outstanding
 * an unref'd poll asks whether the provider parent still exists and an unref'd
 * backstop timer bounds the wait a minute inside the provider's own hook timeout.
 * Either one resolving is `abandoned` — the socket is destroyed first, so the
 * host sees the hang-up and aborts the review it was running — and the caller
 * writes NOTHING for it: the reader of this hook's stdout is gone.
 *
 * `isParentAlive` is built by the caller, at relay entry, so its parent identity
 * predates the stdin read this point is reached through.
 */
function exchange(
  line: string,
  socketPath: string,
  options: NativeReviewHookRelayOptions,
  isParentAlive: () => boolean,
): Promise<ExchangeResult> {
  let socket: Socket;
  try {
    socket = options.connect?.(socketPath) ?? createConnection({ path: socketPath });
  } catch {
    return Promise.resolve({ failure: "unreachable" });
  }
  return new Promise((resolve) => {
    let settled = false;
    let received = Buffer.alloc(0);
    let connectTimer: NodeJS.Timeout | undefined;
    let pollTimer: NodeJS.Timeout | undefined;
    let backstopTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      if (backstopTimer) {
        clearTimeout(backstopTimer);
        backstopTimer = undefined;
      }
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
      socket.removeListener("error", onError);
    };
    const finish = (
      result: ExchangeResult,
      destroy: boolean,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroy) {
        try {
          socket.destroy();
        } catch {
          // The observed outcome is already settled.
        }
      }
      resolve(result);
    };
    // The abandonment path: `finish` destroys the held connection before the wait
    // resolves, which is what tells the broker to abort the review it was running
    // — exactly the hangup a provider that killed its own hook produces.
    const abandon = (): void => finish({ abandoned: true }, true);
    const probeParent = (): void => {
      let alive = true;
      try {
        alive = isParentAlive();
      } catch {
        // A probe that cannot answer is not proof the parent is gone.
        alive = true;
      }
      if (!alive) abandon();
    };

    const onData = (chunk: Buffer): void => {
      // #736 review pass 2: the interval is not the only boundary. A broker that
      // answers quickly can put a verdict on this socket before the first poll
      // ever runs, and a verdict written for a provider that is already gone is a
      // decision nobody asked for. So the parent is checked at the boundary where
      // a verdict would be accepted, and an orphaned relay abandons instead.
      probeParent();
      if (settled) return;
      if (received.length + chunk.length > MAX_NATIVE_REVIEW_RESPONSE_FRAME_BYTES) {
        // An answer that cannot fit this family's own bound is not an answer.
        finish({ failure: "response-invalid" }, true);
        return;
      }
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline === -1) return;
      let text: string;
      try {
        // Strict UTF-8: a malformed answer frame is never decoded leniently.
        text = new TextDecoder("utf-8", { fatal: true }).decode(received.subarray(0, newline));
      } catch {
        finish({ failure: "response-invalid" }, true);
        return;
      }
      let frame: NativeReviewServerFrame | undefined;
      try {
        frame = decodeNativeReviewServerFrame(text);
      } catch {
        frame = undefined;
      }
      finish(frame === undefined ? { failure: "response-invalid" } : { frame }, true);
    };
    const onError = (): void => finish({ failure: "unreachable" }, true);
    const onClose = (): void => finish({ failure: "closed" }, false);

    try {
      socket.setNoDelay?.(true);
    } catch {
      // Optional transport tuning only.
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("connect", () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
      // #736 review pass 2: the other boundary. A connect and a reply can both
      // land between the stdin read finishing and the first poll, so nothing is
      // sent to the host until the parent this relay speaks for is known to be
      // there to receive the answer.
      probeParent();
      if (settled) return;
      try {
        socket.write(line);
      } catch {
        finish({ failure: "unreachable" }, true);
      }
    });
    connectTimer = setTimeout(
      () => finish({ failure: "unreachable" }, true),
      options.timeouts?.connectMs ?? NATIVE_REVIEW_HOOK_CONNECT_TIMEOUT_MS,
    );
    connectTimer.unref?.();

    const pollMs = options.watchdog?.pollMs ?? NATIVE_REVIEW_HOOK_PARENT_POLL_MS;
    if (pollMs > 0) {
      pollTimer = setInterval(probeParent, pollMs);
      // Neither guard may keep this short-lived child alive on its own.
      pollTimer.unref?.();
    }
    const backstopMs = options.watchdog?.deadlineMs ?? NATIVE_REVIEW_HOOK_RELAY_DEADLINE_MS;
    if (backstopMs > 0) {
      backstopTimer = setTimeout(abandon, backstopMs);
      backstopTimer.unref?.();
    }
  });
}

/**
 * Runs one relay attempt. Exported for focused tests; the genuine process
 * entrypoint below is the only automatic invocation. It writes the provider's
 * stdout itself and never throws, never blocks on its own failure, and never
 * prints a token or a path.
 */
export async function runNativeReviewHookRelay(
  options: NativeReviewHookRelayOptions = {},
): Promise<NativeReviewHookRelayOutcome> {
  // #736 review pass 1: the parent identity is captured HERE, as the first act
  // of this relay, before the first await. The stdin read is an await, and on
  // POSIX a parent that dies during it reparents this child — so a probe built
  // later would capture the REPLACEMENT parent as its baseline and never see the
  // orphaning, which is the exact case this guard exists for.
  const isParentAlive = options.watchdog?.isParentAlive ?? createParentLivenessProbe();
  const fail = (reason: NativeReviewUnavailableReason): NativeReviewHookRelayOutcome => {
    return emit(options, { status: "unavailable", reason }, unavailableStdoutFor(reason));
  };
  try {
    const env = options.env ?? process.env;
    const bootstrap = parseNativeReviewBootstrapEnv(env[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]);
    if (!bootstrap) return fail("unconfigured");
    const argvEvent = options.event ?? process.argv[2];
    if (!isNativeReviewHookEventName(argvEvent)) return fail("event-mismatch");

    const read = await readBoundedStdin(
      options.stdin ?? process.stdin,
      MAX_NATIVE_REVIEW_STDIN_BYTES,
      options.timeouts?.stdinMs ?? NATIVE_REVIEW_HOOK_STDIN_TIMEOUT_MS,
    );
    if (read.kind === "timeout") return fail("input-timeout");
    if (read.kind === "unavailable") return fail("input-unavailable");
    if (read.kind === "too-large") return fail("input-too-large");

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } catch {
      return fail("input-not-utf8");
    }
    let parsed: unknown;
    try {
      // `.trim()` tolerates only the trailing newline/CRLF a provider may append
      // after the JSON document; a malformed document is still a closed failure.
      parsed = JSON.parse(text.trim());
    } catch {
      return fail("input-malformed");
    }
    const selected = sanitizeNativeReviewProviderInput(parsed);
    if (!selected.ok) return fail(selected.reason);
    // The cross-check: the event the provider invoked this hook for must be the
    // event its own document names. Never one or the other alone.
    if (selected.selection.event !== argvEvent) return fail("event-mismatch");

    // ONE line is the whole request — reviewed assistant text included. Auth
    // fields are built last so no selected value can overwrite them, and the
    // whole line is size-checked before anything is sent.
    let line: string;
    try {
      line = encodeNativeReviewRequestFrame({
        ...selected.selection,
        version: 1,
        type: "native_review_request",
        instanceId: bootstrap.instanceId,
        generation: bootstrap.generation,
        backend: bootstrap.backend,
        token: bootstrap.token,
      });
    } catch {
      // An admitted selection that cannot fit the closed frame bound is a
      // bounded transport failure, never a partially sent frame.
      return fail("input-too-large");
    }
    if (Buffer.byteLength(line, "utf8") > MAX_NATIVE_REVIEW_REQUEST_FRAME_BYTES) {
      return fail("input-too-large");
    }

    const answered = await exchange(line, bootstrap.socketPath, options, isParentAlive);
    if ("abandoned" in answered) {
      // The provider that ran this hook is gone, or the wait outlived the hook
      // that spawned it. The held socket is already destroyed, so the host
      // aborts the review it was running; this child writes nothing at all —
      // there is no reader left for a notice — and exits zero.
      return { status: "unavailable" };
    }
    if ("failure" in answered) return fail(answered.failure);
    const frame = answered.frame;
    // The provider's stdout for a delivered answer comes from the answer itself,
    // so the mapping and the reported outcome can never disagree.
    if (frame.type === "native_review_error") {
      return emit(options, { status: "unavailable", reason: frame.code }, providerStdoutFor(frame));
    }
    return emit(options, { status: frame.action }, providerStdoutFor(frame));
  } catch {
    // No provider text, token, or path is ever included in an outcome, and a
    // relay's own unexpected failure is never a block.
    return fail("error");
  }
}

/** Streams this relay already guards against asynchronous write failures. */
const guardedStdout = new WeakSet<NodeJS.WritableStream>();

/**
 * Installs the asynchronous stdout error guard once, before anything is written.
 *
 * A provider that stops reading closes the pipe, and Node reports that as an
 * `error` event on the stream — asynchronously, so no surrounding `try/catch`
 * can see it. An unhandled `EPIPE` would end this hook child with a nonzero
 * exit, which is the one outcome its contract forbids. Swallowing it is the
 * correct reading: a verdict or notice the provider never read is a turn this
 * relay did not review, exactly like every other transport failure, and it is
 * never retried or turned into a decision.
 */
function guardStdout(stream: NodeJS.WritableStream): void {
  if (guardedStdout.has(stream)) return;
  guardedStdout.add(stream);
  // A test double may supply a bare writer, so the guard is installed only where
  // the stream can actually report an asynchronous error.
  if (typeof (stream as { on?: unknown }).on === "function") {
    (stream as { on(event: "error", listener: () => void): unknown }).on("error", () => undefined);
  }
}

function emit(
  options: NativeReviewHookRelayOptions,
  outcome: NativeReviewHookRelayOutcome,
  stdoutText: string,
): NativeReviewHookRelayOutcome {
  const stream = options.stdout ?? process.stdout;
  guardStdout(stream);
  try {
    if (stdoutText.length > 0) stream.write(stdoutText);
  } catch {
    // A provider stdout that fails synchronously is the same closed pipe: the
    // provider sees no decision, which is the same as an unavailable review.
  }
  return outcome;
}

/**
 * The provider command hook invokes this compiled module directly:
 * `node <this entry> <Stop|UserPromptSubmit>`. Always exit zero — including on
 * every failure — and never emit a decision the host did not give.
 *
 * Exit is never forced. A backpressured piped stdout keeps the loop alive until
 * its writes settle, so the complete decision line reaches the provider even
 * when it is slow to read; the provider's own hook timeout remains the outer
 * deadline. The asynchronous stdout error guard above is what makes a provider
 * that stops reading a clean exit rather than a crash.
 */
if (require.main === module) {
  const finish = (): void => {
    process.exitCode = 0;
  };
  void runNativeReviewHookRelay().then(finish, finish);
}
