/**
 * #682 slice 1b: TEST/DEVELOPMENT-ONLY smoke owner that serves the canonical
 * shared SubtasksStart and SubtasksInspect definitions over MCP stdio.
 *
 * This is not product wiring. It is never registered by the extension, never
 * shipped as a runnable product entry, and refuses to start without explicit
 * smoke arguments. It exists so a developer can drive the real
 * `ExecutionToolManager.sharedManagedTool("start" | "inspect")` handlers, and
 * the real `BackgroundExecutionController` behind them, from a native Claude
 * or Codex CLI. See `tests/managed-tool-mcp-smoke.ts` for the runner and the
 * operator steps.
 *
 * What is real:
 * - The manager, controller, normalization, parent-tool capture, admission,
 *   and result/failure shaping. Both definitions come from
 *   `sharedManagedTool`; nothing here parses or validates Subtasks params.
 *
 * What the smoke owner supplies, deliberately narrow:
 * - Owner: one fresh owner per process (per CLI launch). Its workspace, temp
 *   tree, and HOME live in a new directory inside a runner-owned scratch that
 *   must carry the runner's marker file. Separate launches never share an
 *   owner, a controller, or execution roots.
 * - Admission: the owner assigns every call id itself. The MCP caller supplies
 *   only the tool name and arguments; no caller-supplied call id, owner, or
 *   identity is read. The owner keeps its own snapshot of the parsed arguments
 *   and the raw, pre-coercion fingerprint of exactly that submission, and each
 *   admission is consumed by one invocation.
 * - Authority: research-only test authority. Start is admitted only for
 *   `kind: "research"` without a `workspace` override. Every other kind, a
 *   workspace override, every other tool, and every other MCP method fail
 *   closed before admission. The live call policy allows exactly the two
 *   bound names.
 * - Execution route: one synthetic research resource that is never
 *   dispatched (`maxWorkers = 0`). Admitted tasks stay `queued`, so no
 *   executor, provider, capture, or landing ever runs and results are
 *   deterministic.
 *
 * Transport: newline-delimited JSON-RPC over the process's own stdio only.
 * There is no listener, no inherited credential, and no saved configuration.
 * The process exits when stdin closes, on SIGTERM/SIGINT, or at a bounded
 * lifetime deadline, and removes its owner directory on exit.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { normalizeConfig } from "../src/config";
import {
  ExecutionToolManager,
  type ManagedToolAdmission,
  type ManagedToolAdmittedCall,
  type ManagedToolDefinition,
} from "../src/execution/tool";
import { redactSensitiveText } from "../src/redaction";
import { createState } from "../src/state";
import { toolCallFingerprint } from "../src/tool-call-fingerprint";

/** The runner writes this file at the root of the scratch it owns. */
export const SMOKE_SCRATCH_MARKER = ".prg-managed-tool-mcp-smoke-scratch";
/** Required literal flag: the smoke owner never starts implicitly. */
export const SMOKE_AUTHORITY_FLAG = "--research-only-test-authority";
export const SMOKE_SERVER_NAME = "prg-managed-tool-mcp-smoke";
/** MCP server key used in the child CLI configurations. */
export const SMOKE_MCP_KEY = "prg_smoke";
export const SMOKE_TOOL_NAMES = ["SubtasksStart", "SubtasksInspect"] as const;
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_MAX_LIFETIME_MS = 180_000;
export const EXECUTION_HANDLE_PATTERN = /^exec-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TASK_HANDLE_PATTERN = /^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVIDENCE_FILE_NAME = /^[A-Za-z0-9._-]{1,80}\.jsonl$/;

type JsonRpcId = string | number | null;
type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string } };

export interface SmokeEvidenceEvent {
  event: string;
  [key: string]: unknown;
}

export interface SmokeOwnerOptions {
  /** Runner-owned scratch containing SMOKE_SCRATCH_MARKER. The owner creates its own directory inside it. */
  scratch: string;
  /**
   * Sanitized JSONL evidence sink. It must be a new file directly under the
   * canonical scratch root; it is created exclusively without following
   * symlinks and written through the descriptor opened here. Omitted means
   * in-memory only.
   */
  evidencePath?: string;
  /** Label recorded in evidence (for example `claude-a`); never used for authority. */
  launchLabel?: string;
  /**
   * Point `TMPDIR`/`TMP`/`TEMP` and `HOME` into the owner directory, so
   * execution roots (created under `os.tmpdir()`) stay in the owned scratch.
   * Only the dedicated stdio process sets this; in-process tests leave the
   * test runner's environment alone.
   */
  isolateProcessEnvironment?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the scratch and returns its canonical path. Throws on anything not runner-owned. */
export function validateSmokeScratch(scratch: string): string {
  if (typeof scratch !== "string" || scratch.length === 0) throw new Error("--scratch is required");
  const absolute = resolve(scratch);
  const stats = lstatSync(absolute);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("scratch must be a real directory, not a symlink");
  let marker;
  try {
    marker = lstatSync(join(absolute, SMOKE_SCRATCH_MARKER));
  } catch {
    marker = undefined;
  }
  if (!marker?.isFile() || marker.isSymbolicLink()) throw new Error("scratch is not marked as runner-owned smoke scratch");
  return realpathSync(absolute);
}

/**
 * Opens the evidence file: a new regular file directly under the canonical
 * scratch root, created exclusively (an existing file or symlink is refused)
 * and never reopened by path afterwards.
 */
function openEvidence(scratch: string, evidencePath: string): number {
  const target = resolve(evidencePath);
  if (dirname(target) !== scratch || !EVIDENCE_FILE_NAME.test(basename(target))) {
    throw new Error("--evidence must name a new .jsonl file directly inside the smoke scratch");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  try {
    return openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`--evidence must be a new file (${code ?? "open failed"}); existing files and symlinks are refused`);
  }
}

/**
 * Sanitized evidence keeps a value only when it matches an allowlisted shape
 * and the repository's secret redaction leaves it unchanged.
 */
function allowlisted(value: unknown, pattern: RegExp): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && pattern.test(value) && redactSensitiveText(value) === value ? value : "<invalid>";
}

export type SmokeResultClass =
  | "start_accepted"
  | "inspect_ok"
  | "invalid_request"
  | "unknown_execution"
  | "smoke_refused"
  | "shared_failed_closed"
  | "error_other"
  | "ok_other";

/**
 * Classifies a result text for sanitized evidence. Raw result text can echo
 * caller-supplied values (for example an arbitrary executionId), so evidence
 * keeps only this class plus validated handles.
 */
export function classifyResult(text: string, isError: boolean | undefined): SmokeResultClass {
  if (/^Subtasks\w+ failed closed in smoke mode: /.test(text)) return "smoke_refused";
  if (/^Subtasks\w+ failed closed: /.test(text)) return "shared_failed_closed";
  if (/^Invalid Subtasks\w+ request: /.test(text)) return "invalid_request";
  if (/^SubtasksInspect failed: Unknown execution group /.test(text)) return "unknown_execution";
  if (/^SubtasksStart accepted: research group exec-/.test(text)) return "start_accepted";
  if (/^SubtasksInspect: research group exec-/.test(text) && isError !== true) return "inspect_ok";
  return isError === true || /^Subtasks\w+ failed/.test(text) ? "error_other" : "ok_other";
}

/**
 * Pulls exec-/task- handles out of a result envelope for sanitized evidence.
 * Only valid handle shapes are kept: error details can echo whatever the
 * caller supplied as an executionId.
 */
export function handlesOf(result: Record<string, unknown>): { executionId?: string; taskIds: string[] } {
  const details = isRecord(result.details) ? result.details : {};
  const executionId = typeof details.executionId === "string" && EXECUTION_HANDLE_PATTERN.test(details.executionId) ? details.executionId : undefined;
  const tasks = Array.isArray(details.tasks) ? details.tasks : [];
  const taskIds = tasks.flatMap((task) => isRecord(task) && typeof task.taskId === "string" && TASK_HANDLE_PATTERN.test(task.taskId) ? [task.taskId] : []);
  return { ...(executionId ? { executionId } : {}), taskIds };
}

/**
 * The owner's admission table: one snapshot per owner-assigned call id,
 * consumed by the single invocation it was issued for.
 */
class SmokeAdmission implements ManagedToolAdmission {
  private readonly records = new Map<string, { toolName: string; params: unknown; startCallFingerprint?: string }>();

  admit(toolCallId: string, toolName: string, snapshot: unknown, startCallFingerprint: string | undefined): void {
    this.records.set(toolCallId, {
      toolName,
      params: structuredClone(snapshot),
      ...(startCallFingerprint ? { startCallFingerprint } : {}),
    });
  }

  resolveCall(toolCallId: string, toolName: string): ManagedToolAdmittedCall | undefined {
    const record = this.records.get(toolCallId);
    if (!record || record.toolName !== toolName) return undefined;
    return { params: structuredClone(record.params), startCallFingerprint: record.startCallFingerprint };
  }

  consume(toolCallId: string): void {
    this.records.delete(toolCallId);
  }
}

type SmokeRefusalCode = "non_object_arguments" | "kind_not_research" | "workspace_override";

/** Smoke-mode authority check, applied by the owner before any admission. */
function smokePolicyRefusal(toolName: string, args: Record<string, unknown>): { code: SmokeRefusalCode; text: string } | undefined {
  if (toolName !== "SubtasksStart") return undefined;
  if (args.kind !== "research") {
    const kind = !("kind" in args) ? "execute (default)" : typeof args.kind === "string" && /^[a-z]{1,16}$/.test(args.kind) ? `"${args.kind}"` : "<non-research value>";
    return { code: "kind_not_research", text: `smoke owner grants research-only test authority; kind ${kind} is not admitted` };
  }
  if ("workspace" in args) return { code: "workspace_override", text: "smoke owner does not admit a workspace override" };
  return undefined;
}

export class SmokeOwner {
  readonly ownerId = `owner-${randomUUID()}`;
  readonly ownerRoot: string;
  readonly manager: ExecutionToolManager;
  readonly evidence: SmokeEvidenceEvent[] = [];
  private evidenceFd: number | undefined;
  private readonly admission = new SmokeAdmission();
  private readonly definitions = new Map<string, ManagedToolDefinition>();
  private callSequence = 0;
  private disposed = false;

  private constructor(ownerRoot: string, manager: ExecutionToolManager, evidenceFd: number | undefined) {
    this.ownerRoot = ownerRoot;
    this.manager = manager;
    this.evidenceFd = evidenceFd;
  }

  /**
   * Builds one owner in a fresh directory inside the scratch, restores empty
   * associations, syncs, and binds the two shared definitions — the same
   * session order index.ts uses.
   *
   * See `isolateProcessEnvironment` for the dedicated-process environment.
   */
  static async create(options: SmokeOwnerOptions): Promise<SmokeOwner> {
    const scratch = validateSmokeScratch(options.scratch);
    // Opened before anything else exists, so a refused sink creates nothing.
    const evidenceFd = options.evidencePath !== undefined ? openEvidence(scratch, options.evidencePath) : undefined;
    let ownerRoot: string;
    try {
      ownerRoot = mkdtempSync(join(scratch, "owner-"));
    } catch (error) {
      if (evidenceFd !== undefined) closeSync(evidenceFd);
      throw error;
    }
    const workspace = join(ownerRoot, "workspace");
    const tmp = join(ownerRoot, "tmp");
    const home = join(ownerRoot, "home");
    for (const dir of [workspace, tmp, home]) mkdirSync(dir, { recursive: true });
    if (options.isolateProcessEnvironment) {
      process.env.TMPDIR = tmp;
      process.env.TMP = tmp;
      process.env.TEMP = tmp;
      process.env.HOME = home;
    }
    const allowed = new Set<string>(SMOKE_TOOL_NAMES);
    const activeTools = ["read", ...SMOKE_TOOL_NAMES];
    // Recording host stub: Pi registration is what makes the manager's tools
    // registered and launch-allowed. Nothing is ever rendered or activated in a
    // real Pi session.
    const pi = {
      registerTool() {},
      registerCommand() {},
      setToolActive() {},
      getActiveTools: () => [...activeTools],
    };
    const config = normalizeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      execution: {
        workerResources: {
          smoke: { selection: { source: "pi", model: "prg-smoke/never-dispatched" }, maxConcurrent: 1 },
        },
        routes: { execute: [], research: [{ resourceId: "smoke" }] },
      },
    });
    // Admission only: queued tasks are never dispatched.
    config.execution!.maxWorkers = 0;
    const manager = new ExecutionToolManager({
      pi,
      config,
      state: createState(),
      cwd: () => workspace,
      authorizedTools: () => ["read"],
      liveToolCallAllowed: (name) => allowed.has(name),
    });
    await manager.restoreAssociations({ waveRoots: [], bundles: [], groupRoots: [] });
    manager.sync();
    const owner = new SmokeOwner(ownerRoot, manager, evidenceFd);
    owner.definitions.set("SubtasksStart", manager.sharedManagedTool("start", owner.admission));
    owner.definitions.set("SubtasksInspect", manager.sharedManagedTool("inspect", owner.admission));
    owner.record({
      event: "owner_ready",
      ownerId: owner.ownerId,
      launch: allowlisted(options.launchLabel, /^[A-Za-z0-9_-]{1,32}$/),
      tools: [...owner.definitions.keys()],
    });
    return owner;
  }

  /** The exact MCP tool list: the shared definitions' names, descriptions, and schemas. */
  toolList(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [...this.definitions.values()].map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.parameters,
    }));
  }

  /**
   * Owner-side handling of one MCP tools/call. Returns a CallToolResult, or
   * undefined for a tool this owner does not expose (the caller answers with a
   * JSON-RPC error).
   */
  async callTool(name: unknown, rawArguments: unknown): Promise<{ content: Array<{ type: "text"; text: string }>; isError: boolean } | undefined> {
    const definition = typeof name === "string" ? this.definitions.get(name) : undefined;
    if (!definition) {
      this.record({ event: "tools_call", tool: "<unknown>", outcome: "refused_unknown_tool" });
      return undefined;
    }
    // The owner's own snapshot of exactly what was submitted, before any coercion.
    const args = rawArguments === undefined ? {} : structuredClone(rawArguments);
    const ownerCallId = `${this.ownerId}:call-${++this.callSequence}`;
    if (!isRecord(args)) {
      return this.finishRefusal(definition.name, ownerCallId, { code: "non_object_arguments", text: "tool arguments must be a JSON object" });
    }
    const refusal = smokePolicyRefusal(definition.name, args);
    if (refusal) return this.finishRefusal(definition.name, ownerCallId, refusal);
    const fingerprint = toolCallFingerprint(definition.name, args);
    this.admission.admit(ownerCallId, definition.name, args, definition.name === "SubtasksStart" ? fingerprint : undefined);
    let envelope: Record<string, unknown>;
    try {
      envelope = await definition.invoke({ toolCallId: ownerCallId });
    } finally {
      this.admission.consume(ownerCallId);
    }
    const text = textOf(envelope);
    const isError = envelope.isError === true;
    const handles = handlesOf(envelope);
    const persistedIdentity = definition.name === "SubtasksStart" && !isError && fingerprint
      ? this.manager.startLiveness(fingerprint).state === "active"
      : undefined;
    this.record({
      event: "tools_call",
      tool: definition.name,
      ownerCallId,
      outcome: "admitted",
      rawFingerprint: fingerprint ? `${fingerprint.slice(0, 16)}…` : null,
      ...(persistedIdentity !== undefined ? { persistedIdentity } : {}),
      requestHandles: definition.name === "SubtasksInspect"
        ? { executionId: allowlisted(args.executionId, EXECUTION_HANDLE_PATTERN), taskId: allowlisted(args.taskId, TASK_HANDLE_PATTERN) }
        : undefined,
      isError,
      handles,
      resultClass: classifyResult(text, isError),
    });
    return { content: [{ type: "text", text }], isError };
  }

  private finishRefusal(toolName: string, ownerCallId: string, refusal: { code: SmokeRefusalCode; text: string }) {
    const text = `${toolName} failed closed in smoke mode: ${refusal.text}; nothing was admitted, started, or read.`;
    this.record({ event: "tools_call", tool: toolName, ownerCallId, outcome: "refused_policy", refusal: refusal.code, isError: true, resultClass: classifyResult(text, true) });
    return { content: [{ type: "text" as const, text }], isError: true };
  }

  /** One JSON-RPC message in, at most one response out. */
  async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    const { id, method, params } = message as JsonRpcMessage;
    const hasId = typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
    if ("id" in message && !hasId) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    const reply = (result: unknown): JsonRpcResponse | undefined => hasId ? { jsonrpc: "2.0", id: id as JsonRpcId, result } : undefined;
    const fail = (code: number, text: string): JsonRpcResponse | undefined => hasId ? { jsonrpc: "2.0", id: id as JsonRpcId, error: { code, message: text } } : undefined;
    switch (method) {
      case "initialize": {
        const requested = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
        const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];
        const client = isRecord(params) && isRecord(params.clientInfo) ? params.clientInfo : {};
        // Diagnostic only, never authority: evidence keeps a fixed client
        // family, not the caller-supplied name or version.
        const clientName = typeof client.name === "string" ? client.name.toLowerCase() : "";
        const family = clientName.includes("claude") ? "claude" : clientName.includes("codex") ? "codex" : "unknown";
        this.record({ event: "initialize", protocolVersion, client: { name: family } });
        return reply({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SMOKE_SERVER_NAME, version: "0.0.0-test" },
          instructions: "Test/development-only smoke owner for pi-review-gate shared SubtasksStart/SubtasksInspect handlers. Research-only test authority; tasks stay queued.",
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined;
      case "ping":
        return reply({});
      case "tools/list": {
        const tools = this.toolList();
        this.record({ event: "tools_list", names: tools.map((tool) => tool.name) });
        return reply({ tools });
      }
      case "tools/call": {
        // An MCP tool call is a request, not a notification: without a valid
        // id nothing is admitted, because the caller could never see handles.
        if (!hasId) return undefined;
        const call = isRecord(params) ? params : {};
        const outcome = await this.callTool(call.name, call.arguments);
        return outcome ? reply(outcome) : fail(-32602, "Unknown tool: this smoke owner exposes only SubtasksStart and SubtasksInspect");
      }
      default:
        if (!hasId) return undefined;
        this.record({ event: "method_refused" });
        return fail(-32601, "Method not found");
    }
  }

  record(event: SmokeEvidenceEvent): void {
    const stamped = { ...event, at: new Date().toISOString() };
    this.evidence.push(stamped);
    if (this.evidenceFd === undefined) return;
    try {
      writeSync(this.evidenceFd, `${JSON.stringify(stamped)}\n`);
    } catch {
      // Evidence is best-effort; the protocol result is authoritative.
    }
  }

  /** Closes the evidence descriptor; later records stay in memory only. */
  closeEvidence(): void {
    if (this.evidenceFd === undefined) return;
    const fd = this.evidenceFd;
    this.evidenceFd = undefined;
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
  }

  /**
   * Graceful teardown: controller shutdown and detach, then removal of every
   * root this owner created. Used when stdin closes or a lifetime deadline
   * fires.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const roots = this.manager.associations().groupRoots ?? [];
    try {
      await this.manager.shutdown();
      await this.manager.detach();
    } finally {
      this.removeOwnedTree(roots, "graceful");
      this.closeEvidence();
    }
  }

  /**
   * Synchronous teardown for termination signals. Some CLIs follow SIGTERM
   * with SIGKILL almost immediately, so the owned tree is removed before any
   * await. Nothing durable needs flushing: this owner never dispatches and
   * its whole state lives in the disposable scratch.
   */
  disposeNow(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeOwnedTree(this.manager.associations().groupRoots ?? [], "signal");
  }

  private removeOwnedTree(roots: readonly string[], mode: string): void {
    // This owner started from empty associations, so every root it lists is
    // its own; with process isolation they all sit inside ownerRoot anyway.
    try {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
      rmSync(this.ownerRoot, { recursive: true, force: true });
    } finally {
      this.record({ event: "owner_disposed", ownerId: this.ownerId, mode });
    }
  }
}

function textOf(envelope: Record<string, unknown>): string {
  const content = Array.isArray(envelope.content) ? envelope.content : [];
  return content.map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "").join("\n");
}

function parseArgs(argv: string[]): { scratch?: string; evidence?: string; label?: string; maxLifetimeMs: number; authority: boolean } {
  const out: { scratch?: string; evidence?: string; label?: string; maxLifetimeMs: number; authority: boolean } = {
    maxLifetimeMs: DEFAULT_MAX_LIFETIME_MS,
    authority: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === SMOKE_AUTHORITY_FLAG) out.authority = true;
    else if (arg === "--scratch") out.scratch = value();
    else if (arg === "--evidence") out.evidence = value();
    else if (arg === "--label") out.label = value();
    else if (arg === "--max-lifetime-ms") {
      const parsed = Number(value());
      if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 600_000) throw new Error("--max-lifetime-ms must be 1000..600000");
      out.maxLifetimeMs = parsed;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

/** Stdio entry point: `node dist-test/tests/managed-tool-mcp-smoke-owner.js --research-only-test-authority --scratch <dir> [...]`. */
export async function runStdioSmokeOwner(argv: string[]): Promise<void> {
  let options;
  try {
    options = parseArgs(argv);
    if (!options.authority) throw new Error(`refusing to start without ${SMOKE_AUTHORITY_FLAG}`);
    if (!options.scratch) throw new Error("--scratch is required");
  } catch (error) {
    process.stderr.write(`${SMOKE_SERVER_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  let owner: SmokeOwner;
  try {
    owner = await SmokeOwner.create({ scratch: options.scratch!, evidencePath: options.evidence, launchLabel: options.label, isolateProcessEnvironment: true });
  } catch (error) {
    process.stderr.write(`${SMOKE_SERVER_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  let exiting = false;
  const exit = async (reason: string) => {
    if (exiting) return;
    exiting = true;
    owner.record({ event: "owner_exit", reason });
    try {
      await owner.dispose();
    } finally {
      process.exit(0);
    }
  };
  const deadline = setTimeout(() => void exit("max_lifetime"), options.maxLifetimeMs);
  deadline.unref();
  // Signals tear down first and log afterwards: a CLI may follow SIGTERM
  // with SIGKILL within milliseconds (Codex does), so the owned tree is
  // removed before anything else. The runner removes the whole scratch
  // afterwards in every case.
  const exitNow = (reason: string) => {
    if (exiting) return;
    exiting = true;
    try {
      owner.disposeNow();
    } finally {
      owner.record({ event: "owner_exit", reason });
      owner.closeEvidence();
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => exitNow("SIGTERM"));
  process.on("SIGINT", () => exitNow("SIGINT"));
  // Sequential processing keeps responses ordered and Start admissions serial.
  let queue = Promise.resolve();
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      queue = queue.then(async () => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`);
          return;
        }
        const response = await owner.handle(message);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      }).catch(() => {
        // A failed handler must never wedge later messages.
      });
    }
  });
  process.stdin.on("end", () => void queue.then(() => exit("stdin_closed")));
}

if (require.main === module) void runStdioSmokeOwner(process.argv.slice(2));
