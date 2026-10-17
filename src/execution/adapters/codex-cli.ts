import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { CodexExecutorConfig } from "../../config";
import { reviewerEnv, terminateProcessTree, waitForProcessCloseBounded, waitForPromiseBounded, type BoundedProcessClose, type ProcessRunResult } from "../../adapters/process";
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

type CodexTerminalReason = "abort" | "interrupt" | "timeout" | "completed" | "failure" | "exit";
const CODEX_TERMINAL_DRAIN_MS = 7_000;
const CODEX_LIFECYCLE_SETTLEMENT_MS = 5_000;
const CODEX_TERMINATION_ESCALATION_MS = 2_000;

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
    let threadId = request.session?.id;
    // The turn run() currently tracks. Turn-interrupt steering republishes it
    // to the replacement turn, and default steering plus terminal controls
    // always target this current id, never a frozen launch-time id (issue #63).
    let activeTurnId: string | undefined;
    let completedTurn: Record<string, unknown> | undefined;
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
    // The turn a steered delivery interrupted when its replacement failed to
    // start; lets run() report that specific loss instead of a plain stop.
    let steerInterruptedWithoutReplacement: string | undefined;
    let protocolIdentity: string | undefined;
    let failure: ExecutorTurn["failure"];
    let code: number | null = 0;

    const stop = (reason: "abort" | "interrupt" | "timeout"): Promise<unknown> | undefined =>
      rpc.terminate(reason, threadId && activeTurnId ? { threadId, turnId: activeTurnId } : undefined);
    const timeout = setTimeout(() => { stop("timeout"); }, this.config.timeoutMs ?? 1_800_000);
    timeout.unref?.();
    const onAbort = () => { stop("abort"); };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();
    // Identity persistence remains the prompt barrier. Install cancellation,
    // deadline and close observation first, so a stuck callback cannot keep
    // the owned child alive or allow a late prompt after terminal teardown.
    const lifecycleStart = (async () => { if (identity) await request.onProcessStart?.(identity); })();
    void lifecycleStart.catch(() => undefined);

    try {
      await Promise.race([lifecycleStart, rpc.terminal().then(() => { throw rpc.terminalError; })]);
      rpc.assertRunning();
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
        rpc.assertRunning();
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
      rpc.assertRunning();
      const activeThreadId = threadId;

      request.onLiveControl?.({
        adapter: this.kind,
        generation: request.turn,
        protocol: protocolIdentity,
        capabilities: { steer: true, interrupt: true },
        steer: async (instruction, instructionId, options) => {
          if (rpc.terminalError) {
            return { status: "failed", message: rpc.terminalError.message, turnId: activeTurnId };
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
              rpc.assertRunning();
              const terminal = await rpc.waitForTurn(activeThreadId, current);
              rpc.assertRunning();
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
          const currentTurnId = activeTurnId;
          const nativeReply = stop("interrupt");
          try {
            // Teardown already started; the native reply is diagnostic, not
            // permission to terminate. Always await actual bounded close too.
            await nativeReply;
            const exit = await rpc.closed();
            const terminal = currentTurnId ? rpc.completedTurn(activeThreadId, currentTurnId) : undefined;
            if (!nativeReply || !exit.closeObserved || rpc.terminationError || !terminal || !["interrupted", "completed"].includes(String(terminal.status))) {
              return { status: "failed", message: "Codex terminal stop completed without confirmed native turn interruption or child cleanup.", turnId: currentTurnId };
            }
            return { status: "acknowledged", message: "Codex app-server acknowledged turn interruption and its owned child closed.", turnId: currentTurnId };
          } catch (error) {
            await rpc.closed();
            return { status: "failed", message: error instanceof Error ? error.message : String(error), turnId: currentTurnId };
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
        if (steerHandoff.isPending()) await Promise.race([steerHandoff.wait(), rpc.terminal()]);
        if (rpc.terminalError) break;
        if (activeTurnId === trackedTurnId) break;
        trackedTurnId = activeTurnId!;
        completion = await rpc.waitForTurn(activeThreadId, trackedTurnId);
      }
      rpc.terminate("completed");
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
      if (!rpc.timedOut && !rpc.aborted) {
        failure = { category: "protocol", message: error instanceof Error ? error.message : String(error) };
      }
      code = 1;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      rpc.terminate("failure");
      request.onLiveControl?.(undefined);
      const exit = await rpc.closed();
      // Local pipe destruction or root disappearance is never exit evidence.
      // Keep start/exit publication ordered even if persistence settles late.
      const lifecycleCompletion = (async () => {
        const start = await lifecycleStart.then(
          () => ({ kind: "fulfilled" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        if (identity && exit.closeObserved && !rpc.terminationError) {
          await request.onProcessExit?.({ ...identity, code: exit.code, signal: exit.signal });
        }
        if (start.kind === "rejected") throw start.error;
      })();
      const persistence = await waitForPromiseBounded(lifecycleCompletion, CODEX_LIFECYCLE_SETTLEMENT_MS);
      if (persistence.kind !== "fulfilled") {
        code = 1;
        const message = persistence.kind === "timeout"
          ? "Codex lifecycle callbacks did not settle within 5000ms; process identity or exit persistence is unconfirmed."
          : `Codex lifecycle callback failed: ${String(persistence.error)}`;
        failure = { category: "process", message };
      }
      if (!exit.closeObserved) {
        code = 1;
        const message = "Codex app-server close/drain exceeded 7000ms; owned cleanup is unconfirmed; local stdio closure is not child-exit evidence.";
        failure = { category: "process", message: failure ? `${failure.message} ${message}` : message };
      }
    }

    // A replacement already in flight may have been accepted/completed
    // during drain. Prefer its cached final items without issuing new work.
    completedTurn = threadId && activeTurnId ? rpc.completedTurn(threadId, activeTurnId) ?? completedTurn : completedTurn;
    const timedOut = rpc.timedOut;
    const aborted = rpc.aborted;
    const terminationFailure = rpc.terminationError
      ? `Codex app-server termination attempts failed before child close: ${rpc.terminationError}`
      : undefined;
    if (terminationFailure) {
      code = 1;
      failure = { category: "process", message: failure ? `${failure.message} ${terminationFailure}` : terminationFailure };
    }

    const text = agentTexts.join("\n").trim() || finalAgentText(completedTurn);
    const output = rpc.output(code, timedOut, aborted);
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
      aborted,
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
  // JSON-RPC line framing (#239): the LF-free decoded fragments of the current
  // incomplete stdout line. Each data event searches only its own text for LF;
  // a completed line is assembled from its fragments once, when its LF
  // arrives, and the fragments are released. This removes repeated rescanning
  // and recopying of a long pending prefix; it is not a frame-size or memory
  // bound — an unterminated line is still retained in full, and a final line
  // without LF is still never parsed.
  private lineFragments: string[] = [];
  // Text not yet searched for LF because routing an earlier line in the same
  // event threw. It is searched again ahead of the next event, as the former
  // whole-buffer rescan did; always empty on the normal path.
  private unscannedText = "";
  private turnWaiters = new Map<string, Array<{ resolve: (turn: Record<string, unknown>) => void; reject: (error: Error) => void }>>();
  private completedTurns = new Map<string, Record<string, unknown>>();
  private forceKillTimer: NodeJS.Timeout | undefined;
  // One canonical lifecycle: terminal intent fences writes immediately; only
  // an observed close (never local drain destruction) can confirm cleanup.
  private lifecycle: { phase: "running" } | {
    phase: "terminal";
    reason: CodexTerminalReason;
    error: Error;
    close?: BoundedProcessClose;
  } = { phase: "running" };
  private resolveTerminal!: () => void;
  private readonly terminalPromise = new Promise<void>((resolve) => { this.resolveTerminal = resolve; });
  private resolveClose!: (close: BoundedProcessClose) => void;
  private terminationFailures = new Map<NodeJS.Signals, string>();
  private readonly exitPromise = new Promise<BoundedProcessClose>((resolve) => { this.resolveClose = resolve; });
  private readonly stdoutCapture = new BoundedTextAccumulator(100 * MEBIBYTE);
  private readonly stderrCapture = new BoundedTextAccumulator(16 * MEBIBYTE);
  // Incremental UTF-8 decoders: a valid multibyte sequence may straddle two
  // 'data' chunks, and per-chunk toString("utf8") would replace it with U+FFFD
  // in the retained captures and the JSON-RPC line buffer (#238). Each decoder
  // holds back a trailing partial sequence until the next chunk completes it.
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");

  constructor(private readonly proc: ChildProcess, private readonly onNotification: (method: string, params: unknown) => void) {
    proc.stdout?.on("data", (chunk: Buffer) => this.consume(this.stdoutDecoder.write(chunk)));
    proc.stderr?.on("data", (chunk: Buffer) => { this.stderrCapture.append(this.stderrDecoder.write(chunk)); });
    // Contain failures of the app-server's stdin transport (e.g. EPIPE when
    // the child closes its input channel while still alive) through the
    // existing failure path: outstanding protocol work settles as a failure
    // exactly like child close, instead of escaping as an uncaught stream
    // error that would crash the host (#268). The ChildProcess 'error' event
    // below covers spawn failures only, not stdio streams.
    proc.stdin?.on("error", (error) => this.failTransport(error));
    proc.once("exit", (code, signal) => {
      this.terminate("exit", undefined, new Error(`Codex app-server exited before completing pending protocol work (${code ?? signal ?? "unknown"}).`));
    });
    proc.once("close", (code, signal) => {
      // 'close' follows every delivered 'data' event; flush any torn
      // trailing sequence so retained captures match full-stream decoding
      // (a genuinely incomplete final sequence decodes to U+FFFD, as a
      // single-chunk decode always did).
      const stdoutTail = this.stdoutDecoder.end();
      if (stdoutTail) this.consume(stdoutTail);
      const stderrTail = this.stderrDecoder.end();
      if (stderrTail) this.stderrCapture.append(stderrTail);
      this.latchTerminal("exit", new Error(`Codex app-server exited before completing pending protocol work (${code ?? signal ?? "unknown"}).`));
      this.finishClose({ code, signal, closeObserved: true, exitObserved: proc.exitCode !== null || proc.signalCode !== null });
    });
    proc.once("error", (error) => { this.failTransport(error); });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    return this.sendRequest(method, params);
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
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
    if (this.terminalError) return;
    try {
      this.write({ jsonrpc: "2.0", method, params });
    } catch (error) {
      this.failTransport(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** A dead input channel enters the same terminal latch as cancellation. */
  private failTransport(error: Error): void {
    // Terminal teardown already fences all new work. A best-effort interrupt
    // can hit EPIPE while stdout still carries acceptance of earlier writes;
    // keep those requests routable until actual close or the drain deadline.
    if (this.lifecycle.phase === "terminal") return;
    this.terminate("failure", undefined, error);
    this.rejectPending(this.terminalError!);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiters of this.turnWaiters.values()) {
      for (const waiter of waiters) waiter.reject(error);
    }
    this.turnWaiters.clear();
  }

  get terminalError(): Error | undefined {
    return this.lifecycle.phase === "terminal" ? this.lifecycle.error : undefined;
  }

  get timedOut(): boolean {
    return this.lifecycle.phase === "terminal" && this.lifecycle.reason === "timeout";
  }

  get aborted(): boolean {
    return this.lifecycle.phase === "terminal" && ["abort", "interrupt"].includes(this.lifecycle.reason);
  }

  terminal(): Promise<void> { return this.terminalPromise; }

  assertRunning(): void {
    if (this.terminalError) throw this.terminalError;
  }

  completedTurn(threadId: string, turnId: string): Record<string, unknown> | undefined {
    return this.completedTurns.get(`${threadId}:${turnId}`);
  }

  private latchTerminal(reason: CodexTerminalReason, error?: Error): void {
    if (this.lifecycle.phase !== "running") return;
    this.lifecycle = { phase: "terminal", reason, error: error ?? new Error(`Codex app-server terminal teardown: ${reason}.`) };
    this.resolveTerminal();
  }

  private finishClose(close: BoundedProcessClose): void {
    if (this.lifecycle.phase !== "terminal" || this.lifecycle.close) return;
    this.lifecycle.close = close;
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
    this.forceKillTimer = undefined;
    this.rejectPending(this.lifecycle.error);
    this.resolveClose(close);
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
    if (this.terminalError) return Promise.reject(this.terminalError);
    return new Promise((resolvePromise, reject) => {
      const waiters = this.turnWaiters.get(key) ?? [];
      waiters.push({ resolve: resolvePromise, reject });
      this.turnWaiters.set(key, waiters);
    });
  }

  terminate(
    reason: CodexTerminalReason,
    interrupt?: { threadId: string; turnId: string },
    error?: Error,
  ): Promise<unknown> | undefined {
    if (this.lifecycle.phase !== "running") return undefined;
    // Latch intent first: even a synchronous failure of the best-effort
    // interrupt must not turn cancellation into an ordinary transport failure.
    this.latchTerminal(reason, error);
    // This is the sole permitted write after terminal intent. Ordinary calls
    // remain fenced; no reply is awaited before signaling the owned child.
    const nativeReply = interrupt && this.proc.stdin?.writable ? this.sendRequest("turn/interrupt", interrupt) : undefined;
    void nativeReply?.catch(() => undefined);
    // Attach before signaling or destroying local pipes. The bounded observer
    // latches uncertainty before local destruction can synthesize a close.
    void waitForProcessCloseBounded(this.proc, CODEX_TERMINAL_DRAIN_MS, (close) => this.finishClose(close))
      .then((close) => this.finishClose(close));
    this.forceKillTimer = setTimeout(() => {
      this.forceKillTimer = undefined;
      // POSIX groups remain owned even after leader exit. Native Windows
      // exited-root/undefined-PID safeguards remain in terminateProcessTree.
      this.recordTerminationFailure(terminateProcessTree(this.proc, "SIGKILL"));
    }, CODEX_TERMINATION_ESCALATION_MS);
    this.forceKillTimer.unref?.();
    this.recordTerminationFailure(terminateProcessTree(this.proc, "SIGTERM"));
    return nativeReply;
  }

  closed(): Promise<BoundedProcessClose> {
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
    const text = this.unscannedText ? this.unscannedText + chunk : chunk;
    this.unscannedText = "";
    let start = 0;
    try {
      for (let newline = text.indexOf("\n", start); newline >= 0; newline = text.indexOf("\n", start)) {
        const segment = text.slice(start, newline);
        start = newline + 1;
        let line = segment;
        if (this.lineFragments.length > 0) {
          this.lineFragments.push(segment);
          line = this.lineFragments.join("");
          this.lineFragments = [];
        }
        this.routeLine(line.trim());
      }
    } catch (error) {
      this.unscannedText = text.slice(start);
      throw error;
    }
    if (start < text.length) this.lineFragments.push(text.slice(start));
  }

  private routeLine(line: string): void {
    if (!line) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { return; }
    if (!isRecord(value)) return;
    if (typeof value.id === "number" && ("result" in value || "error" in value)) {
      const response = value as unknown as JsonRpcResponse;
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) pending.reject(new Error(`${response.error.message ?? "Codex app-server error"}: ${JSON.stringify(response.error.data ?? {})}`));
      else pending.resolve(response.result);
      return;
    }
    if (typeof value.id === "number" && typeof value.method === "string") {
      // A reply write can fail synchronously once the input channel is
      // dead; contain it through the same settlement path instead of letting
      // it escape the stdout callback as an uncaught exception (#268). No
      // further replies are attempted after the transport has failed.
      if (!this.terminalError) {
        try {
          this.write({ jsonrpc: "2.0", id: value.id, error: { code: -32601, message: `Client does not support server request ${value.method}.` } });
        } catch (error) {
          this.failTransport(error instanceof Error ? error : new Error(String(error)));
        }
      }
      return;
    }
    if (typeof value.method !== "string") return;
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
