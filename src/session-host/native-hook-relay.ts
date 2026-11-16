/**
 * Bounded one-shot relay entrypoint for native provider command hooks.
 *
 * The provider runs this module as a short-lived child under its own documented
 * command hook. It reads exactly one strict-UTF-8, size-bounded JSON document
 * from stdin, selects only the closed metadata allowlist from
 * ./native-hook-protocol, authenticates with the fresh per-owned-launch
 * bootstrap carried in NATIVE_HOOK_BOOTSTRAP_ENV, sends one frame to the
 * existing local status broker, waits for one fixed-size acknowledgement, and
 * closes. There is no retry, queue, replay, adoption, stdout, permission-control
 * JSON, or diagnostic output: the observer never authorizes, denies, or blocks
 * the provider operation, and every failure exit is zero.
 *
 * Deadlines cover the stdin read, connect, and acknowledgement separately, so a
 * stuck provider/broker cannot leave a hook process alive indefinitely. If the
 * broker is unreachable the loss is silent: this lane has no heartbeat and no
 * way to report a delivery that never happened. Provider stdin text is selected
 * BEFORE any wire encoding, so question/answer/prompt text, tool arguments or
 * results, transcript lines, terminal output, and arbitrary hook fields never
 * enter a frame. For Stop/SubagentStop only, the whole `background_tasks`
 * array is validated once and projected to `background_counts` plus, when every
 * active entry was identifiable, `background_members`; for PostToolUse only, a
 * result that actually launched background work projects one
 * `background_started` id and kind. The raw array, its
 * descriptions/commands/IDs, and any `tool_response` body never cross the wire,
 * and an invalid or oversized snapshot becomes an explicit authenticated failure
 * rather than a partial/zero count.
 * When an active entry could not be keyed to an id, `background_members` is
 * omitted and the closed `background_unidentified_kinds` categories are projected
 * instead, so a consumer withdraws exactly the categories whose membership is
 * unkeyable rather than the whole census.
 */

import { createConnection, type Socket } from "node:net";
import type { NativeCliBackend } from "./session-backend";
import {
  MAX_NATIVE_HOOK_ACK_BYTES,
  MAX_NATIVE_HOOK_STDIN_BYTES,
  NATIVE_HOOK_BOOTSTRAP_ENV,
  decodeNativeHookAck,
  encodeNativeHookFrame,
  parseNativeHookBootstrapEnv,
  sanitizeNativeHookProviderInput,
  type NativeHookBootstrap,
  type NativeHookEventFrame,
  type NativeHookEventMetadata,
  type NativeHookFailureFrame,
  type NativeHookFailureReason,
  type NativeHookFrame,
} from "./native-hook-protocol";

/** Upper bound for the provider's stdin document read, in milliseconds. */
export const NATIVE_HOOK_STDIN_TIMEOUT_MS = 1500;
/** Upper bound for establishing the local broker connection, in milliseconds. */
export const NATIVE_HOOK_CONNECT_TIMEOUT_MS = 1500;
/** Upper bound for reading the one fixed-size acknowledgement, in milliseconds. */
export const NATIVE_HOOK_ACK_TIMEOUT_MS = 1500;

export type NativeHookRelayStatus =
  | "accepted"
  | "rejected"
  | "unconfigured"
  | "unreachable"
  | "ack-timeout"
  | "ack-invalid"
  | "closed"
  | "error";

/** Observed relay outcome; contains no provider text, token, or path. */
export interface NativeHookRelayOutcome {
  readonly status: NativeHookRelayStatus;
  /** Which closed frame family was sent, when a bootstrap authenticated the source. */
  readonly delivered?: "event" | "failure";
  /** Closed failure reason that was reported, when applicable. */
  readonly failure?: NativeHookFailureReason;
}

/** Narrow injectable seams for tests; production uses process stdin and net.connect. */
export interface NativeHookRelayOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: NodeJS.ReadableStream;
  readonly connect?: (socketPath: string) => Socket;
  readonly timeouts?: {
    readonly stdinMs?: number;
    readonly connectMs?: number;
    readonly ackMs?: number;
  };
}

type StdinReadResult =
  | { readonly kind: "bytes"; readonly bytes: Buffer }
  | { readonly kind: "too-large" }
  | { readonly kind: "timeout" }
  | { readonly kind: "unavailable" };

function readBoundedStdin(
  stream: NodeJS.ReadableStream,
  limitBytes: number,
  timeoutMs: number,
): Promise<StdinReadResult> {
  return new Promise<StdinReadResult>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
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
    const onEnd = (): void => finish({ kind: "bytes", bytes: Buffer.concat(chunks, total) });
    const onError = (): void => finish({ kind: "unavailable" });
    const onClose = (): void => {
      // A close without a preceding end means the provider stdin was truncated.
      if (!settled) finish({ kind: "unavailable" });
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

function eventFrame(
  bootstrap: NativeHookBootstrap,
  metadata: NativeHookEventMetadata,
): NativeHookEventFrame {
  return {
    version: 1,
    type: "native_hook_event",
    instanceId: bootstrap.instanceId,
    generation: bootstrap.generation,
    backend: bootstrap.backend,
    token: bootstrap.token,
    ...metadata,
  };
}

function failureFrame(bootstrap: NativeHookBootstrap, reason: NativeHookFailureReason): NativeHookFailureFrame {
  return {
    version: 1,
    type: "native_hook_failure",
    instanceId: bootstrap.instanceId,
    generation: bootstrap.generation,
    backend: bootstrap.backend,
    token: bootstrap.token,
    reason,
  };
}

/**
 * Drops the Claude-only background projections for a backend whose provider
 * issues no such ids. The Codex selection and wire shape stay exactly as they
 * were before this lane existed, and the broker's strict decoder never has to
 * refuse an otherwise valid Codex event because a Claude-shaped field rode
 * along.
 */
function projectSelectedMetadata(
  metadata: NativeHookEventMetadata,
  backend: NativeCliBackend,
): NativeHookEventMetadata {
  if (backend === "claude") return metadata;
  const {
    background_started: _claudeStarted,
    background_members: _claudeMembers,
    background_unidentified_kinds: _claudeKindGaps,
    ...rest
  } = metadata;
  return rest;
}

function exchange(
  line: string,
  socketPath: string,
  options: NativeHookRelayOptions,
  timeoutMs: { readonly connect: number; readonly ack: number },
): Promise<NativeHookRelayStatus> {
  let socket: Socket;
  try {
    socket = options.connect?.(socketPath) ?? createConnection({ path: socketPath });
  } catch {
    return Promise.resolve("unreachable");
  }
  return new Promise<NativeHookRelayStatus>((resolve) => {
    let settled = false;
    let received = Buffer.alloc(0);
    let connectTimer: NodeJS.Timeout | undefined;
    let ackTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
      if (ackTimer) {
        clearTimeout(ackTimer);
        ackTimer = undefined;
      }
      socket.removeListener("data", onData);
      socket.removeListener("close", onClose);
      socket.removeListener("error", onError);
    };
    const finish = (status: NativeHookRelayStatus, destroy: boolean): void => {
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
      resolve(status);
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      if (received.length + chunk.length > MAX_NATIVE_HOOK_ACK_BYTES) {
        finish("ack-invalid", true);
        return;
      }
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline === -1) return;
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(received.subarray(0, newline));
      } catch {
        finish("ack-invalid", true);
        return;
      }
      const ack = decodeNativeHookAck(text);
      finish(ack ? (ack.accepted ? "accepted" : "rejected") : "ack-invalid", true);
    };
    const onError = (): void => finish("unreachable", true);
    const onClose = (): void => {
      if (!settled) finish("closed", false);
    };

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
      if (settled) return;
      try {
        socket.write(line);
      } catch {
        finish("unreachable", true);
        return;
      }
      ackTimer = setTimeout(() => finish("ack-timeout", true), timeoutMs.ack);
      ackTimer.unref?.();
    });
    connectTimer = setTimeout(() => finish("unreachable", true), timeoutMs.connect);
    connectTimer.unref?.();
  });
}

async function deliver(
  bootstrap: NativeHookBootstrap,
  frame: NativeHookFrame,
  delivered: "event" | "failure",
  failure: NativeHookFailureReason | undefined,
  options: NativeHookRelayOptions,
): Promise<NativeHookRelayOutcome> {
  let line: string;
  try {
    line = encodeNativeHookFrame(frame);
  } catch {
    // An admitted metadata combination that cannot fit the closed frame bound
    // is still a bounded source failure, not a partial/truncated frame.
    if (delivered === "event") {
      return deliver(bootstrap, failureFrame(bootstrap, "input-too-large"), "failure", "input-too-large", options);
    }
    return { status: "error", delivered, ...(failure === undefined ? {} : { failure }) };
  }
  const status = await exchange(line, bootstrap.socketPath, options, {
    connect: options.timeouts?.connectMs ?? NATIVE_HOOK_CONNECT_TIMEOUT_MS,
    ack: options.timeouts?.ackMs ?? NATIVE_HOOK_ACK_TIMEOUT_MS,
  });
  return { status, delivered, ...(failure === undefined ? {} : { failure }) };
}

/**
 * Runs one relay attempt. Exported for focused tests; the genuine process
 * entrypoint below is the only automatic invocation.
 */
export async function runNativeHookRelay(options: NativeHookRelayOptions = {}): Promise<NativeHookRelayOutcome> {
  try {
    const env = options.env ?? process.env;
    const bootstrap = parseNativeHookBootstrapEnv(env[NATIVE_HOOK_BOOTSTRAP_ENV]);
    if (!bootstrap) return { status: "unconfigured" };

    const stdin = options.stdin ?? process.stdin;
    const read = await readBoundedStdin(
      stdin,
      MAX_NATIVE_HOOK_STDIN_BYTES,
      options.timeouts?.stdinMs ?? NATIVE_HOOK_STDIN_TIMEOUT_MS,
    );
    if (read.kind === "timeout") return deliver(bootstrap, failureFrame(bootstrap, "input-timeout"), "failure", "input-timeout", options);
    if (read.kind === "unavailable") return deliver(bootstrap, failureFrame(bootstrap, "input-unavailable"), "failure", "input-unavailable", options);
    if (read.kind === "too-large") return deliver(bootstrap, failureFrame(bootstrap, "input-too-large"), "failure", "input-too-large", options);

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
    } catch {
      return deliver(bootstrap, failureFrame(bootstrap, "input-not-utf8"), "failure", "input-not-utf8", options);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return deliver(bootstrap, failureFrame(bootstrap, "input-malformed"), "failure", "input-malformed", options);
    }
    const selected = sanitizeNativeHookProviderInput(parsed);
    if (!selected.ok) {
      return deliver(bootstrap, failureFrame(bootstrap, selected.reason), "failure", selected.reason, options);
    }
    // Selection already returned only closed metadata; build the auth fields
    // last so no selected value can overwrite them.
    return deliver(
      bootstrap,
      eventFrame(bootstrap, projectSelectedMetadata(selected.metadata, bootstrap.backend)),
      "event",
      undefined,
      options,
    );
  } catch {
    // No provider text, token, or path is ever included in an outcome.
    return { status: "error" };
  }
}

/**
 * The provider command hook invokes this compiled module directly. Always exit
 * zero and never write stdout/stderr: a hook observer must not authorize,
 * deny, or block the native operation even when its own delivery failed.
 */
if (require.main === module) {
  void runNativeHookRelay().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
