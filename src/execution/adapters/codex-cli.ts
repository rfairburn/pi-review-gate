import { spawn, type ChildProcess } from "node:child_process";
import type { CodexExecutorConfig } from "../../config";
import { reviewerEnv, terminateProcessTree, type ProcessRunResult } from "../../adapters/process";
import { BoundedTextAccumulator, MEBIBYTE } from "../../jsonl";
import { writeExecutorArtifacts } from "../artifacts";
import type {
  ExecutorAdapter,
  ExecutorInteractionAcknowledgement,
  ExecutorRequest,
  ExecutorToolObservation,
  ExecutorTurn,
} from "../types";
import { createExecutorToolCatalog, rejectPreCutoverRequestFields } from "../tool-catalog";

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const CODEX_RESEARCH_CONFIG_KEYS = new Set([
  "model_auto_compact_token_limit",
  "model_context_window",
  "model_reasoning_effort",
  "model_reasoning_summary",
  "model_verbosity",
  "service_tier",
]);

/** Codex executor backed by the official long-lived app-server protocol. */
export class CodexExecutorAdapter implements ExecutorAdapter {
  readonly kind = "codex-cli";
  readonly toolEventObservability = {
    mode: "structured",
    description: "Codex app-server item/started and item/completed events expose command_execution, file_change, and mcp_tool_call data; delivery may race the child mutation, so prior state is not verified.",
  } as const;
  readonly model?: string;

  constructor(private readonly config: CodexExecutorConfig) {
    this.model = config.model;
  }

  async run(request: ExecutorRequest): Promise<ExecutorTurn> {
    rejectPreCutoverRequestFields(request);
    const startedAt = Date.now();
    const sandbox = request.workspaceAccess === "read-only" ? "read-only" : "workspace-write";
    if (sandbox === "read-only") assertCodexResearchArgsSafe(this.config.args);
    const toolCatalog = request.executorToolCatalog
      ? createExecutorToolCatalog(
          request.executorToolCatalog.allowedToolCatalog,
          request.executorToolCatalog.initialActiveTools,
        )
      : undefined;
    // Codex has no adapter-specific deferred activation channel. Until it
    // does, preserve the full role-authorized research catalog.
    const researchConfig = sandbox === "read-only" ? codexResearchThreadConfig(toolCatalog?.allowedToolCatalog) : undefined;
    const proc = spawn(this.config.command ?? "codex", [
      ...(this.config.args ?? []),
      "app-server",
      "--listen", "stdio://",
    ], {
      cwd: request.cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: reviewerEnv({ ...process.env, ...this.config.env, PWD: request.cwd }),
    });
    const identity = proc.pid === undefined ? undefined : {
      pid: proc.pid,
      processGroupId: process.platform === "win32" ? undefined : proc.pid,
    };
    // The close observer must exist before the PID-persistence await: a real
    // child can exit while onProcessStart is still pending, and a late-attached
    // 'close' listener would miss the event and hang run() in finally (#234).
    // The PID/prompt barrier is preserved — initialize/prompt are still issued
    // only after the await below.
    const agentTexts: string[] = [];
    const rpc = new AppServerRpc(proc, (method, params) => {
      request.onUpdate?.(summarizeNotification(method, params));
      for (const observation of codexToolObservations(method, params)) request.onToolObservation?.(observation);
      if (method === "item/completed" && isRecord(params) && isRecord(params.item)
        && params.item.type === "agentMessage" && typeof params.item.text === "string") {
        agentTexts.push(params.item.text);
      }
    });
    if (identity) await request.onProcessStart?.(identity);
    let threadId = request.session?.id;
    // The turn run() currently tracks. Turn-interrupt steering republishes it
    // to the replacement turn, and default steering plus terminal controls
    // always target this current id, never a frozen launch-time id (issue #63).
    let activeTurnId: string | undefined;
    let completedTurn: Record<string, unknown> | undefined;
    let timedOut = false;
    let aborted = false;
    let interruptedByControl = false;
    // Turn-interrupt steering handoff (issue #63): held from the moment a
    // delivery interrupts the active turn until its replacement turn/start is
    // accepted and published, so run() cannot settle on the interrupted
    // turn's terminal status while the replacement id is not yet known.
    const steerHandoff = (() => {
      let pending = false;
      let waiter: (() => void) | undefined;
      return {
        begin: (): void => { pending = true; },
        end: (): void => { pending = false; waiter?.(); waiter = undefined; },
        isPending: (): boolean => pending,
        wait: async (): Promise<void> => {
          while (pending) await new Promise<void>((resolvePromise) => { waiter = resolvePromise; });
        },
      };
    })();
    // Set synchronously with run()'s completion break so a steer starting
    // after it fails truthfully instead of acknowledging into a finishing
    // turn (issue #63).
    let completing = false;
    // The turn a steered delivery interrupted when its replacement failed to
    // start; lets run() report that specific loss instead of a plain stop.
    let steerInterruptedWithoutReplacement: string | undefined;
    let protocolIdentity: string | undefined;
    let failure: ExecutorTurn["failure"];
    let code: number | null = 0;

    const timeout = setTimeout(() => {
      timedOut = true;
      rpc.terminate();
    }, this.config.timeoutMs ?? 1_800_000);
    timeout.unref?.();
    const onAbort = () => {
      aborted = true;
      if (interruptedByControl) return;
      void (threadId && activeTurnId
        ? rpc.request("turn/interrupt", { threadId, turnId: activeTurnId }).catch(() => undefined)
        : Promise.resolve()).finally(() => rpc.terminate());
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const initializeResponse = await rpc.request("initialize", {
        clientInfo: { name: "pi-review-gate", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      protocolIdentity = stringAt(initializeResponse, "userAgent") ?? "codex app-server v2";
      rpc.notify("initialized", {});

      const threadResponse = request.session
        ? await rpc.request("thread/resume", {
            threadId: request.session.id,
            cwd: request.cwd,
            model: this.config.model,
            sandbox,
            approvalPolicy: "never",
            config: researchConfig,
          })
        : await rpc.request("thread/start", {
            cwd: request.cwd,
            model: this.config.model,
            sandbox,
            approvalPolicy: "never",
            ephemeral: false,
            ...(researchConfig ? {
              config: researchConfig,
              environments: [],
              dynamicTools: [],
              selectedCapabilityRoots: [],
            } : {}),
          });
      threadId = stringAt(threadResponse, "thread", "id") ?? threadId;
      if (!threadId) throw new Error("Codex app-server did not return a thread id.");

      // One canonical turn-start path so steered replacement turns preserve
      // the launch turn's model, approval policy, and research configuration
      // instead of drifting copies (issue #63).
      const startTurn = async (text: string): Promise<string> => {
        const response = await rpc.request("turn/start", {
          threadId,
          cwd: request.cwd,
          model: this.config.model,
          approvalPolicy: "never",
          ...(researchConfig ? { environments: [] } : {}),
          input: [{ type: "text", text }],
        });
        const started = stringAt(response, "turn", "id");
        if (!started) throw new Error("Codex app-server did not return an active turn id.");
        return started;
      };
      activeTurnId = await startTurn(request.prompt);
      // #93: the app-server accepted the turn carrying the prompt text — the
      // actual delivery boundary for this prompt.
      request.onPromptDelivery?.({ prompt: request.prompt });
      const activeThreadId = threadId;

      request.onLiveControl?.({
        adapter: this.kind,
        generation: request.turn,
        protocol: protocolIdentity,
        capabilities: { steer: true, interrupt: true },
        steer: async (instruction, instructionId, options) => {
          if (completing) {
            return { status: "failed", message: "Codex turn completion is already in progress; steering was not delivered.", turnId: activeTurnId };
          }
          if (!options?.interrupt) {
            try {
              const response = await rpc.request("turn/steer", {
                threadId: activeThreadId,
                expectedTurnId: activeTurnId,
                clientUserMessageId: instructionId,
                input: [{ type: "text", text: instruction }],
              });
              return {
                status: "acknowledged",
                message: "Codex app-server accepted steering for the active turn.",
                turnId: stringAt(response, "turnId") ?? activeTurnId,
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return {
                status: message.includes("activeTurnNotSteerable") ? "blocked" : "failed",
                message,
                turnId: activeTurnId,
              };
            }
          }
          // Turn-interrupt steering (issue #63): interrupt the current turn
          // when one is still running, then start a replacement turn with the
          // instruction on the same thread. The handoff is held until the
          // replacement id is published so run() cannot settle on the
          // interrupted turn's terminal status; the acknowledgement covers
          // transport acceptance only, and run() follows the replacement
          // turn's own completion before completing.
          let interruptedTurnId: string | undefined;
          steerHandoff.begin();
          try {
            if (activeTurnId && !rpc.isTurnCompleted(activeThreadId, activeTurnId)) {
              const current = activeTurnId;
              await rpc.request("turn/interrupt", { threadId: activeThreadId, turnId: current });
              const terminal = await rpc.waitForTurn(activeThreadId, current);
              if (terminal.status !== "interrupted" && terminal.status !== "completed") {
                return { status: "failed", message: `Codex turn interruption ended in ${String(terminal.status)}.`, turnId: current };
              }
              interruptedTurnId = current;
            }
            const steeredTurnId = await startTurn(instruction);
            activeTurnId = steeredTurnId;
            return {
              status: "acknowledged",
              message: interruptedTurnId
                ? "Codex app-server interrupted the active turn and delivered steering as a new turn on the same thread."
                : "No active Codex turn was running; steering was delivered as a new turn on the same thread without interruption.",
              turnId: steeredTurnId,
            };
          } catch (error) {
            if (interruptedTurnId) steerInterruptedWithoutReplacement = interruptedTurnId;
            return { status: "failed", message: error instanceof Error ? error.message : String(error), turnId: activeTurnId };
          } finally {
            steerHandoff.end();
          }
        },
        interrupt: async (): Promise<ExecutorInteractionAcknowledgement> => {
          try {
            interruptedByControl = true;
            const currentTurnId = activeTurnId;
            if (!currentTurnId) return { status: "failed", message: "Codex turn has not started; nothing to interrupt." };
            await rpc.request("turn/interrupt", { threadId: activeThreadId, turnId: currentTurnId });
            const terminal = await rpc.waitForTurn(activeThreadId, currentTurnId);
            if (terminal.status !== "interrupted" && terminal.status !== "completed") {
              return { status: "failed", message: `Codex interrupt ended in ${String(terminal.status)}.`, turnId: currentTurnId };
            }
            return { status: "acknowledged", message: "Codex app-server acknowledged turn interruption.", turnId: currentTurnId };
          } catch (error) {
            return { status: "failed", message: error instanceof Error ? error.message : String(error), turnId: activeTurnId };
          }
        },
      });

      let trackedTurnId = activeTurnId!;
      let completion = await rpc.waitForTurn(activeThreadId, trackedTurnId);
      // Follow replacement turns published by turn-interrupt steering (issue
      // #63): a terminal status for the tracked id is only final when no
      // newer steered turn supersedes it. The handoff ends after publishing
      // the replacement id, so waiting on it closes the interrupt-to-start gap.
      for (;;) {
        if (steerHandoff.isPending()) await steerHandoff.wait();
        if (activeTurnId === trackedTurnId) break;
        trackedTurnId = activeTurnId!;
        completion = await rpc.waitForTurn(activeThreadId, trackedTurnId);
      }
      completing = true;
      completedTurn = completion;
      const status = typeof completion.status === "string" ? completion.status : "failed";
      if (status === "interrupted") {
        failure = trackedTurnId === steerInterruptedWithoutReplacement
          ? { category: "interruption", message: "Codex turn was interrupted for steering, but the replacement turn did not complete." }
          : { category: "interruption", message: "Codex turn was interrupted." };
      } else if (status !== "completed") {
        failure = { category: "provider", message: stringAt(completion, "error", "message") ?? `Codex turn ended in ${status}.` };
      }
    } catch (error) {
      if (!timedOut && !aborted) {
        failure = { category: "protocol", message: error instanceof Error ? error.message : String(error) };
      }
      code = 1;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      request.onLiveControl?.(undefined);
      rpc.terminate();
      const exit = await rpc.closed();
      if (identity) await request.onProcessExit?.({ ...identity, code: exit.code, signal: exit.signal });
    }

    const terminationFailure = rpc.terminationError
      ? `Codex app-server termination attempts failed before child close: ${rpc.terminationError}`
      : undefined;
    if (terminationFailure) {
      failure = failure
        ? { ...failure, message: `${failure.message} ${terminationFailure}` }
        : { category: "process", message: terminationFailure };
    }

    const text = agentTexts.join("\n").trim() || finalAgentText(completedTurn);
    const output = rpc.output(code, timedOut, aborted || interruptedByControl);
    const artifacts = await writeExecutorArtifacts({
      artifactDir: request.artifactDir,
      turn: request.turn,
      output,
      text,
      sessionId: threadId,
      adapter: this.kind,
    });
    request.onUpdate?.(`codex turn finished in ${Math.max(0, Date.now() - startedAt)}ms`);
    return {
      text,
      session: { adapter: this.kind, id: threadId ?? request.session?.id ?? "missing" },
      ...artifacts,
      code,
      timedOut,
      aborted: aborted || interruptedByControl,
      failure,
    };
  }
}

function assertCodexResearchArgsSafe(args: readonly string[] | undefined): void {
  for (let index = 0; index < (args?.length ?? 0); index += 1) {
    const arg = args![index]!;
    if (arg === "--strict-config") continue;
    if (arg === "-c" || arg === "--config") {
      const value = args![index + 1];
      if (!value || !isSafeCodexResearchConfig(value)) {
        throw new Error(`Codex research launch rejects configuration ${value ?? arg}; the read-only profile is authoritative.`);
      }
      index += 1;
      continue;
    }
    const inline = arg.startsWith("-c=")
      ? arg.slice(3)
      : arg.startsWith("--config=")
        ? arg.slice("--config=".length)
        : undefined;
    if (inline !== undefined && isSafeCodexResearchConfig(inline)) continue;
    throw new Error(`Codex research launch rejects CLI argument ${arg}; the read-only profile is authoritative.`);
  }
}

function isSafeCodexResearchConfig(value: string): boolean {
  const separator = value.indexOf("=");
  return separator > 0 && CODEX_RESEARCH_CONFIG_KEYS.has(value.slice(0, separator).trim());
}

function codexResearchThreadConfig(allowedTools: readonly string[] | undefined): Record<string, unknown> {
  if (!allowedTools) {
    throw new Error("Codex research launch requires an authoritative parent tool allowlist.");
  }
  return {
    web_search: allowedTools.includes("WebSearch") ? "live" : "disabled",
    mcp_servers: {},
    apps: {
      _default: {
        enabled: false,
        approvals_reviewer: null,
        destructive_enabled: false,
        open_world_enabled: false,
        default_tools_approval_mode: null,
        default_tools_enabled: false,
      },
    },
  };
}

class AppServerRpc {
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private turnWaiters = new Map<string, Array<{ resolve: (turn: Record<string, unknown>) => void; reject: (error: Error) => void }>>();
  private completedTurns = new Map<string, Record<string, unknown>>();
  private forceKillTimer: NodeJS.Timeout | undefined;
  private terminationRequested = false;
  private terminationFailures = new Map<NodeJS.Signals, string>();
  // Latched stdin transport failure (#268): once the input channel fails, the
  // error is remembered so work registered after the failure (e.g. a turn
  // wait installed by a continuation that ran after the error event) also
  // settles with it, and no further writes are attempted against the dead
  // channel.
  private stdinFailure: Error | undefined;
  private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly stdoutCapture = new BoundedTextAccumulator(100 * MEBIBYTE);
  private readonly stderrCapture = new BoundedTextAccumulator(16 * MEBIBYTE);

  constructor(private readonly proc: ChildProcess, private readonly onNotification: (method: string, params: unknown) => void) {
    proc.stdout?.on("data", (chunk: Buffer) => this.consume(chunk.toString("utf8")));
    proc.stderr?.on("data", (chunk: Buffer) => { this.stderrCapture.append(chunk.toString("utf8")); });
    // Contain failures of the app-server's stdin transport (e.g. EPIPE when
    // the child closes its input channel while still alive) through the
    // existing failure path: outstanding protocol work settles as a failure
    // exactly like child close, instead of escaping as an uncaught stream
    // error that would crash the host (#268). The ChildProcess 'error' event
    // below covers spawn failures only, not stdio streams.
    proc.stdin?.on("error", (error) => this.failTransport(error));
    this.exitPromise = new Promise((resolvePromise) => {
      proc.once("close", (code, signal) => {
        if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
        this.forceKillTimer = undefined;
        const error = new Error(`Codex app-server exited before completing pending protocol work (${code ?? signal ?? "unknown"}).`);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        for (const waiters of this.turnWaiters.values()) {
          for (const waiter of waiters) waiter.reject(error);
        }
        this.turnWaiters.clear();
        resolvePromise({ code, signal });
      });
      proc.once("error", (error) => {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
      });
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    if (this.stdinFailure) return Promise.reject(this.stdinFailure);
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        // A synchronous transport refusal settles like the async one.
        const failure = error instanceof Error ? error : new Error(String(error));
        this.pending.delete(id);
        reject(failure);
        this.failTransport(failure);
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.stdinFailure) return;
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch (error) {
      this.failTransport(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Latch a stdin transport failure and settle all outstanding protocol work with it. */
  private failTransport(error: Error): void {
    this.stdinFailure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.stdinFailure);
    this.pending.clear();
    for (const waiters of this.turnWaiters.values()) {
      for (const waiter of waiters) waiter.reject(this.stdinFailure);
    }
    this.turnWaiters.clear();
  }

  /** True once the app-server reported a terminal status for this turn. */
  isTurnCompleted(threadId: string, turnId: string): boolean {
    return this.completedTurns.has(`${threadId}:${turnId}`);
  }

  get terminationError(): string | undefined {
    return this.terminationFailures.size > 0 ? [...this.terminationFailures.values()].join("\n") : undefined;
  }

  waitForTurn(threadId: string, turnId: string): Promise<Record<string, unknown>> {
    const key = `${threadId}:${turnId}`;
    // Already-completed results stay authoritative even after a transport
    // failure; only unfinished waits settle with the latched error (#268).
    const completed = this.completedTurns.get(key);
    if (completed) return Promise.resolve(completed);
    if (this.stdinFailure) return Promise.reject(this.stdinFailure);
    return new Promise((resolvePromise, reject) => {
      const waiters = this.turnWaiters.get(key) ?? [];
      waiters.push({ resolve: resolvePromise, reject });
      this.turnWaiters.set(key, waiters);
    });
  }

  terminate(): void {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null || this.terminationRequested) return;
    this.terminationRequested = true;
    this.recordTerminationFailure(terminateProcessTree(this.proc, "SIGTERM"));
    this.forceKillTimer = setTimeout(() => {
      this.forceKillTimer = undefined;
      if (this.proc.exitCode === null && this.proc.signalCode === null) {
        this.recordTerminationFailure(terminateProcessTree(this.proc, "SIGKILL"));
      }
    }, 2_000);
    this.forceKillTimer.unref?.();
  }

  closed(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.exitPromise;
  }

  output(code: number | null, timedOut: boolean, aborted: boolean): ProcessRunResult {
    return {
      stdout: this.stdoutCapture.value,
      stderr: this.stderrCapture.value,
      stdoutTruncated: this.stdoutCapture.truncated,
      stderrTruncated: this.stderrCapture.truncated,
      stdoutBytes: this.stdoutCapture.bytes,
      stderrBytes: this.stderrCapture.bytes,
      streamEvents: this.stdoutCapture.value.split("\n").filter(Boolean).length,
      toolCalls: 0,
      toolResultBytes: 0,
      compactions: 0,
      code,
      timedOut,
      aborted,
      terminationError: this.terminationError,
    };
  }

  private recordTerminationFailure(failure: string | undefined): void {
    if (!failure) return;
    const signal = failure.startsWith("SIGKILL ") ? "SIGKILL" : "SIGTERM";
    this.terminationFailures.set(signal, failure);
  }

  private write(value: unknown): void {
    if (!this.proc.stdin?.writable) throw new Error("Codex app-server stdin is not writable.");
    this.proc.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private consume(chunk: string): void {
    this.stdoutCapture.append(chunk);
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { continue; }
      if (!isRecord(value)) continue;
      if (typeof value.id === "number" && ("result" in value || "error" in value)) {
        const response = value as unknown as JsonRpcResponse;
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        if (response.error) pending.reject(new Error(`${response.error.message ?? "Codex app-server error"}: ${JSON.stringify(response.error.data ?? {})}`));
        else pending.resolve(response.result);
        continue;
      }
      if (typeof value.id === "number" && typeof value.method === "string") {
        // A reply write can fail synchronously once the input channel is
        // dead; contain it through the same settlement path instead of letting
        // it escape the stdout callback as an uncaught exception (#268). No
        // further replies are attempted after the transport has failed.
        if (!this.stdinFailure) {
          try {
            this.write({ jsonrpc: "2.0", id: value.id, error: { code: -32601, message: `Client does not support server request ${value.method}.` } });
          } catch (error) {
            this.failTransport(error instanceof Error ? error : new Error(String(error)));
          }
        }
        continue;
      }
      if (typeof value.method !== "string") continue;
      this.onNotification(value.method, value.params);
      if (value.method === "turn/completed" && isRecord(value.params) && isRecord(value.params.turn)) {
        const threadId = typeof value.params.threadId === "string" ? value.params.threadId : "";
        const turnId = typeof value.params.turn.id === "string" ? value.params.turn.id : "";
        const key = `${threadId}:${turnId}`;
        this.completedTurns.set(key, value.params.turn);
        const waiters = this.turnWaiters.get(key);
        if (waiters) {
          this.turnWaiters.delete(key);
          for (const waiter of waiters) waiter.resolve(value.params.turn);
        }
      }
    }
  }
}

function finalAgentText(turn: Record<string, unknown> | undefined): string {
  if (!turn || !Array.isArray(turn.items)) return "";
  return turn.items
    .filter((item): item is Record<string, unknown> => isRecord(item) && item.type === "agentMessage" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function summarizeNotification(method: string, params: unknown): string {
  if (method === "item/started" || method === "item/completed") {
    const type = isRecord(params) && isRecord(params.item) && typeof params.item.type === "string" ? params.item.type : "item";
    return `codex ${method === "item/started" ? "started" : "completed"} ${type}`;
  }
  if (method === "turn/completed") return "codex turn completed";
  if (method === "context/compacted") return "codex context compacted";
  if (method.includes("error") || method.includes("warning")) return `codex ${method}`;
  return `codex ${method}`;
}

function codexToolObservations(method: string, params: unknown): ExecutorToolObservation[] {
  if (method !== "item/started" && method !== "item/completed") return [];
  if (!isRecord(params) || !isRecord(params.item)) return [];
  const item = params.item;
  if (typeof item.type !== "string") return [];
  const stage = method === "item/started" ? "start" as const : "end" as const;
  const type = item.type.toLowerCase().replace(/[_-]/g, "");
  if (type === "commandexecution") {
    const toolInput = typeof item.command === "string" ? { command: item.command } : undefined;
    return [{
      stage,
      toolName: "bash",
      ...(toolInput ? { toolInput } : {}),
      ...(typeof item.id === "string" ? { observationId: item.id } : {}),
      ...(stage === "end" ? { result: { output: item.aggregated_output ?? item.aggregatedOutput, exitCode: item.exit_code ?? item.exitCode, status: item.status }, isError: item.status === "failed" || typeof (item.exit_code ?? item.exitCode) === "number" && (item.exit_code ?? item.exitCode) !== 0 } : {}),
    }];
  }
  if (type === "filechange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = changes.flatMap((change) => isRecord(change) && typeof change.path === "string" ? [change.path] : []);
    const toolInput = paths.length > 0 ? { files: paths } : undefined;
    return [{
      stage,
      toolName: "write",
      ...(toolInput ? { toolInput } : {}),
      ...(typeof item.id === "string" ? { observationId: item.id } : {}),
      ...(stage === "end" ? { result: item, isError: item.status === "failed" } : {}),
    }];
  }
  if (type === "mcptoolcall") {
    const toolName = typeof item.tool === "string" ? item.tool : "mcp_tool_call";
    const toolInput = isRecord(item.arguments) ? item.arguments : isRecord(item.input) ? item.input : undefined;
    return [{
      stage,
      toolName,
      ...(toolInput ? { toolInput } : {}),
      ...(stage === "end" ? { result: item.result ?? item.error, isError: item.status === "failed" || item.error !== undefined } : {}),
      ...(typeof item.id === "string" ? { observationId: item.id } : {}),
    }];
  }
  return [];
}

function stringAt(value: unknown, ...path: string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
