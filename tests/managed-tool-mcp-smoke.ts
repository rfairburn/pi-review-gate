/**
 * #682 slice 1b: TEST/DEVELOPMENT-ONLY real-CLI smoke for the shared
 * SubtasksStart and SubtasksInspect handlers over MCP.
 *
 * It drives a real native Claude Code or Codex CLI, in a throwaway child
 * configuration, against the smoke owner in ./managed-tool-mcp-smoke-owner.ts,
 * which binds the actual `ExecutionToolManager.sharedManagedTool("start" |
 * "inspect")` definitions and the real `BackgroundExecutionController`. The
 * model is the loopback mock in ./managed-tool-mcp-smoke-providers.ts, so a
 * run uses no provider account, credential, or live prompt.
 *
 * Prerequisites: a POSIX host (Linux or macOS) used for development, with
 * the chosen CLI on PATH and no machine-managed policy for that CLI (the
 * runner refuses to start when it finds one; see `managedPolicyBlockers`).
 * Managed policy cannot be suppressed from the command line and can run
 * helpers, hooks, or provider settings before the mock sees anything, so the
 * scratch HOME alone is not isolation from it. Use a disposable host or
 * account with no production credentials or policy. After installing
 * dependencies and building, run the smoke in a disposable environment where
 * the CLI cannot reach non-loopback network destinations. The runner binds the
 * mock to loopback but does not enforce outbound isolation.
 *
 * Operator steps (from a repository checkout; nothing is installed or saved;
 * `--ignore-scripts` skips the repository's optional Chromium download, which
 * this smoke does not need):
 *
 *   npm ci --ignore-scripts
 *   npm run build:test
 *   node dist-test/tests/managed-tool-mcp-smoke.js --cli claude
 *   node dist-test/tests/managed-tool-mcp-smoke.js --cli codex
 *
 * Pick either CLI on its own. Options: `--cli-bin <path>` (default: `claude`
 * or `codex` from PATH), `--timeout-ms <n>` per launch (default 120000),
 * `--scratch-parent <dir>` (default: the OS temp directory), `--keep` to
 * leave the scratch for inspection, `--json` for the full sanitized report.
 * The report and the journals kept with `--keep` hold only allowlisted
 * fields: outcome flags, result classes, and validated handle shapes. Raw CLI
 * streams are never part of the report; `--keep` stores them separately under
 * `local-diagnostics/` as unsanitized local-only files.
 *
 * Each run makes two separate CLI launches, each with exactly one prompt:
 * - Launch A: SubtasksStart kind execute is refused by smoke authority; Start
 *   kind research returns handles immediately (task `queued`); Inspect of
 *   those handles returns the same execution/task handles; Inspect without
 *   taskId is rejected by the canonical validator.
 * - Launch B: a new CLI process, hence a new MCP server and a new owner. It
 *   first tries to Inspect launch A's handles, which must be denied (another
 *   owner's execution), then repeats the A sequence with its own, different
 *   handles.
 * Expected tail of the output:
 *
 *   PASS <cli> launch a: owner owner-…, start exec-… / task-… -> inspect exec-… / task-…
 *   PASS <cli> launch b: wrong-owner inspect denied; owner owner-…, start exec-… / task-… -> inspect …
 *   managed-tool MCP smoke (<cli>): PASS
 *
 * Exit code 0 means every check passed; 1 lists the failed checks; 2 is a
 * usage or prerequisite error (for example, the CLI is not on PATH or managed
 * policy is present); 130/143 mean SIGINT/SIGTERM interrupted the run, after
 * the CLI process group was terminated and the scratch removed (even with
 * `--keep`).
 *
 * Isolation:
 * - Everything lives in one fresh scratch directory (synthetic HOME, XDG
 *   dirs, TMPDIR, CLAUDE_CONFIG_DIR / CODEX_HOME, workspace, evidence), which
 *   is removed afterwards unless `--keep` is given.
 * - The child environment is an allowlist: PATH and locale only, plus
 *   synthetic values. No provider key, auth file, user config, or
 *   `PI_REVIEW_GATE_*` variable is inherited.
 * - The model endpoint is a 127.0.0.1 mock that accepts one synthetic key.
 *   The MCP transport is the CLI's own stdio child. Nothing listens beyond
 *   loopback.
 * - Claude runs with `--setting-sources ""` (no user, project, or local
 *   settings) and `--strict-mcp-config`.
 * - Permissions: Claude gets an exact `--allowedTools` entry for the two smoke
 *   tools and keeps its default permission mode and native ToolSearch
 *   deferral; Codex keeps `approval_policy = "never"` and a read-only sandbox,
 *   and its MCP entry enables only the two smoke tools. No bypass flag is
 *   used.
 * - Each launch has a hard deadline. The CLI runs in its own process group,
 *   which is terminated (SIGTERM, then SIGKILL after a short grace) on
 *   timeout or when the runner receives SIGINT/SIGTERM; the owner also exits
 *   at its own lifetime deadline. Scratch creation, the mock, and every
 *   launch share one cleanup scope.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { SMOKE_AUTHORITY_FLAG, SMOKE_MCP_KEY, SMOKE_SCRATCH_MARKER, SMOKE_TOOL_NAMES } from "./managed-tool-mcp-smoke-owner";
import {
  SMOKE_DONE_TEXT,
  SMOKE_SYNTHETIC_API_KEY,
  startMockProvider,
  type JournalEntry,
  type MockProvider,
  type SmokeHandles,
} from "./managed-tool-mcp-smoke-providers";

export type SmokeCli = "claude" | "codex";

export interface SmokeRunOptions {
  cli: SmokeCli;
  /** CLI executable; default resolves `claude`/`codex` on PATH. */
  cliBin?: string;
  timeoutMs?: number;
  scratchParent?: string;
  keep?: boolean;
  /** Aborting terminates the active CLI process group, then cleans up. */
  signal?: AbortSignal;
}

export interface LaunchReport {
  label: string;
  exitCode: number | null;
  timedOut: boolean;
  prompts: 1;
  modelRequests: number;
  sideRequests: number;
  ownerId?: string;
  mcpClient?: string;
  usedToolSearch?: boolean;
  codexToolForm?: string;
  start?: SmokeHandles;
  inspect?: SmokeHandles;
  foreignDenied?: boolean;
  /**
   * How the owner process ended: "graceful" (stdin closed), "signal" (it
   * removed its tree on SIGTERM/SIGINT), or "killed" (the CLI killed it
   * before it could log teardown; Codex 0.171 sends SIGKILL right after
   * SIGTERM). The runner removes the whole scratch afterwards in every case.
   */
  ownerTeardown?: "graceful" | "signal" | "killed";
  calls: Array<Record<string, unknown>>;
  problems: string[];
}

export interface SmokeReport {
  cli: SmokeCli;
  cliVersion?: string;
  passed: boolean;
  launches: LaunchReport[];
  /** Set when the run was aborted (for example by SIGINT); the report is then incomplete. */
  interrupted?: string;
  /** Owner directories still present when the CLI launches ended; the runner removes them with the scratch. */
  ownerLeftovers: number;
  /** True once the scratch (or nothing, with --keep) is confirmed removed. */
  scratchRemoved: boolean;
  problems: string[];
  scratch?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const PROMPT = "Run the pi-review-gate shared Subtasks MCP smoke plan.";
const OWNER_SCRIPT = join(__dirname, "managed-tool-mcp-smoke-owner.js");
const KILL_GRACE_MS = 3_000;

/**
 * Known machine-managed policy locations. A CLI reads these regardless of
 * HOME or command-line flags, so their presence makes the host unsuitable.
 * This list cannot prove the absence of every host policy (for example
 * Windows registry policy, which is why the runner is POSIX-only).
 */
export function managedPolicyLocations(cli: SmokeCli, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "darwin") {
    return cli === "claude"
      ? ["/Library/Application Support/ClaudeCode", "/Library/Managed Preferences/com.anthropic.claudecode.plist"]
      : ["/etc/codex", "/Library/Managed Preferences/com.openai.codex.plist"];
  }
  return cli === "claude" ? ["/etc/claude-code"] : ["/etc/codex"];
}

/** Prerequisite problems that make this host unsuitable; empty means the run may start. */
export function managedPolicyBlockers(cli: SmokeCli, exists: (path: string) => boolean = existsSync, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === "win32") return ["the managed-tool MCP smoke is POSIX-only (Windows registry policy cannot be ruled out)"];
  return managedPolicyLocations(cli, platform)
    .filter((location) => exists(location))
    .map((location) => `${cli} managed policy is present at ${location}; run the smoke on a disposable host without managed policy`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves an executable on PATH without running a shell. */
export function resolveOnPath(name: string, pathValue = process.env.PATH ?? ""): string | undefined {
  if (isAbsolute(name)) return existsSync(name) ? name : undefined;
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

interface ScratchLayout {
  root: string;
  home: string;
  tmp: string;
  workspace: string;
  cliHome: string;
}

async function createScratch(parent: string | undefined): Promise<ScratchLayout> {
  const base = await realpath(parent ?? tmpdir());
  const root = await realpath(await mkdtemp(join(base, "prg-mcp-smoke-")));
  const layout = {
    root,
    home: join(root, "home"),
    tmp: join(root, "tmp"),
    workspace: join(root, "workspace"),
    cliHome: join(root, "cli-home"),
  };
  try {
    await writeFile(join(root, SMOKE_SCRATCH_MARKER), "pi-review-gate managed-tool MCP smoke scratch; safe to delete\n", { mode: 0o600, flag: "wx" });
    for (const dir of [layout.home, layout.tmp, layout.workspace, layout.cliHome]) await mkdir(dir, { recursive: true });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return layout;
}

/** Allowlisted child environment: nothing provider- or user-specific is inherited. */
function childEnvironment(cli: SmokeCli, scratch: ScratchLayout, provider: MockProvider): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: scratch.home,
    USERPROFILE: scratch.home,
    TMPDIR: scratch.tmp,
    TMP: scratch.tmp,
    TEMP: scratch.tmp,
    XDG_CONFIG_HOME: join(scratch.home, ".config"),
    XDG_CACHE_HOME: join(scratch.home, ".cache"),
    XDG_DATA_HOME: join(scratch.home, ".local", "share"),
    XDG_STATE_HOME: join(scratch.home, ".local", "state"),
    // Keep Git discovery from walking out of the scratch into a parent checkout.
    GIT_CEILING_DIRECTORIES: dirname(scratch.root),
    NO_COLOR: "1",
    TERM: "dumb",
  };
  for (const name of ["LANG", "LC_ALL", "SystemRoot", "ComSpec", "PATHEXT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (cli === "claude") {
    Object.assign(env, {
      CLAUDE_CONFIG_DIR: scratch.cliHome,
      ANTHROPIC_BASE_URL: provider.baseUrl,
      ANTHROPIC_API_KEY: SMOKE_SYNTHETIC_API_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    });
  } else {
    Object.assign(env, {
      CODEX_HOME: scratch.cliHome,
      PRG_SMOKE_MOCK_KEY: SMOKE_SYNTHETIC_API_KEY,
    });
  }
  return env;
}

function ownerArgs(scratch: ScratchLayout, label: string, timeoutMs: number): string[] {
  return [
    OWNER_SCRIPT,
    SMOKE_AUTHORITY_FLAG,
    "--scratch", scratch.root,
    "--evidence", evidencePath(scratch, label),
    "--label", label,
    "--max-lifetime-ms", String(Math.min(600_000, timeoutMs + 30_000)),
  ];
}

function evidencePath(scratch: ScratchLayout, label: string): string {
  return join(scratch.root, `owner-evidence-${label}.jsonl`);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Writes the per-launch child configuration and returns the CLI argv. */
async function prepareLaunch(cli: SmokeCli, scratch: ScratchLayout, provider: MockProvider, label: string, timeoutMs: number): Promise<string[]> {
  const args = ownerArgs(scratch, label, timeoutMs);
  if (cli === "claude") {
    const mcpConfig = join(scratch.root, `claude-mcp-${label}.json`);
    await writeFile(mcpConfig, JSON.stringify({
      mcpServers: { [SMOKE_MCP_KEY]: { type: "stdio", command: process.execPath, args, env: {} } },
    }, null, 2), { mode: 0o600 });
    return [
      "-p", PROMPT,
      "--output-format", "stream-json",
      "--verbose",
      // No user, project, or local settings; managed policy is a preflight blocker.
      "--setting-sources", "",
      "--mcp-config", mcpConfig,
      "--strict-mcp-config",
      "--allowedTools", SMOKE_TOOL_NAMES.map((name) => `mcp__${SMOKE_MCP_KEY}__${name}`).join(","),
      "--model", "claude-sonnet-4-5",
      "--max-turns", "16",
      "--no-session-persistence",
    ];
  }
  const toolSeconds = Math.max(10, Math.ceil(timeoutMs / 1000));
  const config = [
    `model = "prg-smoke-mock"`,
    `model_provider = "prg_smoke_mock"`,
    `approval_policy = "never"`,
    `sandbox_mode = "read-only"`,
    `check_for_update_on_startup = false`,
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[model_providers.prg_smoke_mock]",
    `name = "pi-review-gate smoke mock"`,
    `base_url = ${tomlString(`${provider.baseUrl}/v1`)}`,
    `wire_api = "responses"`,
    `env_key = "PRG_SMOKE_MOCK_KEY"`,
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "",
    `[mcp_servers.${SMOKE_MCP_KEY}]`,
    `command = ${tomlString(process.execPath)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    `enabled_tools = [${SMOKE_TOOL_NAMES.map(tomlString).join(", ")}]`,
    "startup_timeout_sec = 30",
    `tool_timeout_sec = ${toolSeconds}`,
    "",
    // Exact synthetic launch allow: only these two smoke tools are pre-approved
    // for this throwaway CODEX_HOME. approval_policy stays "never", so any
    // other approval request is rejected rather than prompted.
    ...SMOKE_TOOL_NAMES.flatMap((name) => [`[mcp_servers.${SMOKE_MCP_KEY}.tools.${name}]`, `approval_mode = "approve"`, ""]),
  ].join("\n");
  await writeFile(join(scratch.cliHome, "config.toml"), config, { mode: 0o600 });
  return ["exec", "--json", "--strict-config", "--skip-git-repo-check", "--ephemeral", "-C", scratch.workspace, PROMPT];
}

interface ChildRun {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Runs one CLI in its own process group. On timeout or abort the whole group
 * gets SIGTERM and, after a short grace, SIGKILL. On direct CLI exit the
 * remaining group members are killed without waiting for them to release
 * stdio. Output keeps draining until the pipes close, or until the deadline
 * plus grace forces them closed (a pipe held outside the group must not block
 * cleanup).
 */
function runChild(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ChildRun> {
  return new Promise((resolveRun) => {
    if (signal?.aborted) {
      resolveRun({ exitCode: null, timedOut: false, aborted: true, stdout: "", stderr: "" });
      return;
    }
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let escalation: NodeJS.Timeout | undefined;
    const limit = 4 * 1024 * 1024;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < limit) stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < limit) stderr += chunk; });
    const killGroup = (killSignal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, killSignal);
      } catch {
        // Already gone.
      }
    };
    let groupKilled = false;
    const killRemainingGroup = () => {
      if (groupKilled) return;
      groupKilled = true;
      killGroup("SIGKILL");
    };
    const terminate = () => {
      if (escalation) return;
      if (!groupKilled) killGroup("SIGTERM");
      escalation = setTimeout(() => {
        killRemainingGroup();
        // A pipe held outside this process group must not block cleanup.
        child.stdout.destroy();
        child.stderr.destroy();
      }, KILL_GRACE_MS);
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    let settled = false;
    const settle = (exitCode: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener("abort", onAbort);
      killRemainingGroup();
      resolveRun({ exitCode, timedOut, aborted, stdout, stderr: `${stderr}${extra}` });
    };
    child.on("error", (error) => settle(null, `\n${error.message}`));
    // The direct CLI exited: kill what is left of its group at once, then let
    // "close" drain buffered output.
    child.on("exit", killRemainingGroup);
    child.on("close", (code) => settle(code));
  });
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value: unknown = JSON.parse(line);
      return isRecord(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

async function waitForOwnerExit(path: string, deadlineMs: number, signal?: AbortSignal): Promise<Array<Record<string, unknown>>> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const events = readJsonl(path);
    if (events.some((event) => event.event === "owner_disposed") || Date.now() >= until || signal?.aborted) return events;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

function finalCliText(cli: SmokeCli, stdout: string): string | undefined {
  let last: string | undefined;
  for (const line of stdout.split("\n")) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (cli === "claude" && event.type === "result" && typeof event.result === "string") last = event.result;
    if (cli === "codex" && event.type === "item.completed" && isRecord(event.item) && event.item.type === "agent_message" && typeof event.item.text === "string") last = event.item.text;
  }
  return last;
}

function sameHandles(left: SmokeHandles | undefined, right: SmokeHandles | undefined): boolean {
  return left !== undefined && right !== undefined && left.executionId === right.executionId && left.taskId === right.taskId;
}

/** Checks one launch against the expected plan; returns the sanitized report. */
export function verifyLaunch(
  cli: SmokeCli,
  label: string,
  run: ChildRun,
  evidence: Array<Record<string, unknown>>,
  journal: JournalEntry[],
  foreign: SmokeHandles | undefined,
): LaunchReport {
  const problems: string[] = [];
  const check = (ok: boolean, message: string) => { if (!ok) problems.push(message); };
  const turns = journal.filter((entry) => entry.launch === label && (entry.event === "anthropic_turn" || entry.event === "responses_turn"));
  const sideRequests = journal.filter((entry) => entry.launch === label && /side_request|unhandled|unauthorized/.test(String(entry.event))).length;
  const report: LaunchReport = {
    label,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    prompts: 1,
    modelRequests: turns.length,
    sideRequests,
    calls: [],
    problems,
  };
  check(!run.timedOut, "CLI launch hit its deadline");
  check(run.exitCode === 0, `CLI exited with ${String(run.exitCode)}`);
  check(finalCliText(cli, run.stdout)?.includes(SMOKE_DONE_TEXT) === true, `CLI final message was not ${SMOKE_DONE_TEXT}`);
  check(!journal.some((entry) => entry.launch === label && entry.event === "request_unauthorized"), "CLI reached the mock without the synthetic key");

  const ready = evidence.filter((event) => event.event === "owner_ready");
  check(ready.length === 1, `expected exactly one owner for the launch, saw ${ready.length}`);
  report.ownerId = typeof ready[0]?.ownerId === "string" ? ready[0].ownerId : undefined;
  const init = evidence.find((event) => event.event === "initialize");
  const clientFamily = isRecord(init?.client) ? init.client.name : undefined;
  const client = clientFamily === "claude" || clientFamily === "codex" ? clientFamily : "unknown";
  report.mcpClient = client;
  check(client === cli, `MCP client should identify as ${cli}, saw ${client}`);
  const listed = evidence.find((event) => event.event === "tools_list");
  check(JSON.stringify(listed?.names) === JSON.stringify(SMOKE_TOOL_NAMES), "owner should list exactly SubtasksStart and SubtasksInspect");
  const disposed = evidence.find((event) => event.event === "owner_disposed");
  report.ownerTeardown = disposed?.mode === "graceful" ? "graceful" : disposed?.mode === "signal" ? "signal" : "killed";
  check(!evidence.some((event) => event.event === "tools_call" && event.outcome === "refused_unknown_tool"), "CLI called a tool the owner does not expose");

  const calls = evidence.filter((event) => event.event === "tools_call");
  report.calls = calls.map((event) => ({
    tool: event.tool,
    outcome: event.outcome,
    isError: event.isError,
    ...(event.persistedIdentity !== undefined ? { persistedIdentity: event.persistedIdentity } : {}),
    ...(isRecord(event.handles) && event.handles.executionId ? { handles: event.handles } : {}),
    ...(typeof event.refusal === "string" ? { refusal: event.refusal } : {}),
    resultClass: event.resultClass,
  }));
  let index = 0;
  const nextCall = () => calls[index++];
  if (foreign) {
    const denied = nextCall();
    const requested = isRecord(denied?.requestHandles) ? denied.requestHandles : {};
    report.foreignDenied = denied?.tool === "SubtasksInspect" && denied.outcome === "admitted" && denied.isError === true
      && denied.resultClass === "unknown_execution"
      && requested.executionId === foreign.executionId && requested.taskId === foreign.taskId;
    check(report.foreignDenied, "Inspect of another owner's handles was not denied");
    const leaked = isRecord(denied?.handles) && Array.isArray(denied.handles.taskIds) && denied.handles.taskIds.includes(foreign.taskId);
    check(!leaked, "wrong-owner Inspect returned the other owner's task");
  }
  const refused = nextCall();
  check(refused?.tool === "SubtasksStart" && refused.outcome === "refused_policy" && refused.refusal === "kind_not_research" && refused.isError === true,
    "Start kind execute was not refused by smoke authority");
  const started = nextCall();
  const startHandles = isRecord(started?.handles) && typeof started.handles.executionId === "string" && Array.isArray(started.handles.taskIds) && started.handles.taskIds.length === 1
    ? { executionId: started.handles.executionId, taskId: String(started.handles.taskIds[0]) }
    : undefined;
  check(started?.tool === "SubtasksStart" && started.outcome === "admitted" && started.isError === false && startHandles !== undefined, "Start kind research did not return handles");
  check(started?.persistedIdentity === true, "Start did not persist the owner's raw admitted identity");
  check(started?.resultClass === "start_accepted", "Start result was not the canonical acceptance");
  report.start = startHandles;
  const inspected = nextCall();
  const requested = isRecord(inspected?.requestHandles) ? inspected.requestHandles : {};
  const inspectHandles = isRecord(inspected?.handles) && typeof inspected.handles.executionId === "string" && Array.isArray(inspected.handles.taskIds)
    ? { executionId: inspected.handles.executionId, taskId: String(inspected.handles.taskIds[0]) }
    : undefined;
  report.inspect = inspectHandles;
  check(inspected?.tool === "SubtasksInspect" && inspected.outcome === "admitted" && inspected.isError === false && inspected.resultClass === "inspect_ok",
    "Inspect of the started task failed");
  check(requested.executionId === startHandles?.executionId && requested.taskId === startHandles?.taskId, "Inspect did not request the handles Start returned");
  check(sameHandles(inspectHandles, startHandles), "Inspect handles do not match the Start handles");
  const invalid = nextCall();
  check(invalid?.tool === "SubtasksInspect" && invalid.outcome === "admitted" && invalid.isError === true && invalid.resultClass === "invalid_request",
    "Inspect without taskId was not rejected by canonical validation");
  check(index === calls.length, `unexpected extra tool calls: ${calls.length - index}`);

  // What the CLI actually delivered back to the model.
  const finalTurn = turns.at(-1);
  const seen = Array.isArray(finalTurn?.resultsSeen) ? finalTurn.resultsSeen.filter(isRecord) : [];
  const seenClass = (step: string) => seen.find((result) => result.step === step)?.resultClass;
  const seenHandles = (step: string): SmokeHandles | undefined => {
    const handles = seen.find((result) => result.step === step)?.handles;
    return isRecord(handles) && typeof handles.executionId === "string" && typeof handles.taskId === "string"
      ? { executionId: handles.executionId, taskId: handles.taskId }
      : undefined;
  };
  check(sameHandles(seenHandles("start_research"), startHandles), "CLI-delivered Start result does not carry the owner's handles");
  check(sameHandles(seenHandles("inspect_own"), startHandles), "CLI-delivered Inspect result does not carry the same handles");
  check(seenClass("start_execute") === "smoke_refused", "CLI-delivered execute refusal is missing");
  check(seenClass("start_research") === "start_accepted", "CLI-delivered Start acceptance is missing");
  check(seenClass("inspect_own") === "inspect_ok", "CLI-delivered Inspect result is missing");
  check(seenClass("inspect_invalid") === "invalid_request", "CLI-delivered validation error is missing");
  if (foreign) check(seenClass("inspect_foreign") === "unknown_execution", "CLI-delivered wrong-owner denial is missing");
  if (cli === "claude") {
    const first = turns[0];
    report.usedToolSearch = turns.some((turn) => isRecord(turn.next) && turn.next.step === "tool_search");
    check(first?.toolSearchOffered === true, "Claude did not offer native ToolSearch");
    if (report.usedToolSearch) check(seenClass("tool_search") === "tool_search_loaded", "Claude ToolSearch did not load the smoke tools");
  } else {
    report.codexToolForm = typeof turns[0]?.toolForm === "string" ? turns[0].toolForm : undefined;
  }
  return report;
}

async function cliVersion(bin: string, env: NodeJS.ProcessEnv, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
  const run = await runChild(bin, ["--version"], env, cwd, 20_000, signal);
  const line = run.exitCode === 0 ? run.stdout.trim().split("\n")[0] : undefined;
  if (!line) return undefined;
  // Only the numeric version from recognized output reaches the report.
  const claude = /^(\d{1,6}\.\d{1,6}\.\d{1,6}) \(Claude Code\)$/.exec(line);
  const codex = /^codex(?:-cli)? (\d{1,6}\.\d{1,6}\.\d{1,6})$/.exec(line);
  return claude?.[1] ?? codex?.[1] ?? "<unrecognized version output>";
}

/** Local-only raw CLI streams kept with --keep; never part of the report. */
async function keepLocalDiagnostics(scratch: ScratchLayout, label: string, run: ChildRun): Promise<void> {
  const dir = join(scratch.root, "local-diagnostics");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, "README.txt"), "Raw, unsanitized CLI streams from a synthetic smoke session. Local diagnostics only; do not share.\n", { mode: 0o600 });
  await writeFile(join(dir, `cli-stdout-${label}.raw.jsonl`), run.stdout, { mode: 0o600 });
  await writeFile(join(dir, `cli-stderr-${label}.raw.txt`), run.stderr, { mode: 0o600 });
}

/** Runs both launches for one CLI and returns the sanitized report. Throws only for prerequisites. */
export async function runManagedToolMcpSmoke(options: SmokeRunOptions): Promise<SmokeReport> {
  const blockers = managedPolicyBlockers(options.cli);
  if (blockers.length > 0) throw new Error(blockers.join("; "));
  const bin = resolveOnPath(options.cliBin ?? options.cli);
  if (!bin) throw new Error(`${options.cliBin ?? options.cli} was not found on PATH`);
  if (!existsSync(OWNER_SCRIPT)) throw new Error("compiled smoke owner missing; run npm run build:test first");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { signal } = options;
  const report: SmokeReport = { cli: options.cli, passed: false, launches: [], problems: [], ownerLeftovers: 0, scratchRemoved: false };
  const interruption = () => {
    if (!signal?.aborted) return false;
    report.interrupted = typeof signal.reason === "string" && /^SIG[A-Z]+$/.test(signal.reason) ? signal.reason : "aborted";
    return true;
  };
  // One cleanup scope for the scratch, the mock, and every launch.
  let scratch: ScratchLayout | undefined;
  let provider: MockProvider | undefined;
  try {
    scratch = await createScratch(options.scratchParent);
    provider = await startMockProvider();
    const env = childEnvironment(options.cli, scratch, provider);
    report.cliVersion = await cliVersion(bin, env, scratch.workspace, signal);
    let foreign: SmokeHandles | undefined;
    for (const label of ["a", "b"] as const) {
      if (interruption()) break;
      provider.setLaunch(label, foreign);
      const args = await prepareLaunch(options.cli, scratch, provider, label, timeoutMs);
      const run = await runChild(bin, args, env, scratch.workspace, timeoutMs, signal);
      const evidence = await waitForOwnerExit(evidencePath(scratch, label), 5_000, signal);
      if (options.keep) await keepLocalDiagnostics(scratch, label, run);
      if (interruption()) break;
      const launch = verifyLaunch(options.cli, label, run, evidence, provider.journal, foreign);
      const stderrLines = run.stderr.split("\n").filter((line) => line.trim()).length;
      if (launch.problems.length > 0 && stderrLines > 0) {
        launch.problems.push(`CLI stderr: ${stderrLines} line(s) withheld from the sanitized report${options.keep ? " (raw copy under local-diagnostics/)" : "; rerun with --keep for a local raw copy"}`);
      }
      report.launches.push(launch);
      if (label === "a") {
        if (!launch.start) break;
        foreign = launch.start;
      }
    }
    if (!interruption()) {
      const [a, b] = report.launches;
      if (report.launches.length !== 2) report.problems.push("launch b did not run because launch a returned no handles");
      if (a && b) {
        if (!a.ownerId || a.ownerId === b.ownerId) report.problems.push("launches did not get separate owners");
        if (!a.start || !b.start || a.start.executionId === b.start.executionId || a.start.taskId === b.start.taskId) {
          report.problems.push("launches did not get separate handles");
        }
      }
    }
    report.ownerLeftovers = readdirOwners(scratch.root).length;
  } finally {
    // Interruption takes precedence over --keep, including a signal that
    // arrives during finalization.
    try {
      await provider?.close();
      if (scratch && options.keep && provider && !interruption()) {
        await writeFile(join(scratch.root, "mock-journal.sanitized.jsonl"), provider.journal.map((entry) => JSON.stringify(entry)).join("\n"), { mode: 0o600 });
        if (!interruption()) report.scratch = scratch.root;
      }
    } finally {
      if (scratch && !report.scratch) {
        await rm(scratch.root, { recursive: true, force: true, maxRetries: 3 });
        report.scratchRemoved = !existsSync(scratch.root);
        if (!report.scratchRemoved) report.problems.push("scratch could not be removed");
      }
    }
  }
  if (interruption()) report.problems.push(`run interrupted by ${report.interrupted}; the CLI process group was terminated`);
  report.passed = !report.interrupted && report.problems.length === 0 && report.launches.length === 2
    && report.launches.every((launch) => launch.problems.length === 0);
  return report;
}

function readdirOwners(root: string): string[] {
  try {
    return readdirSync(root).filter((name) => name.startsWith("owner-") && !name.endsWith(".jsonl"));
  } catch {
    return [];
  }
}

function formatLaunch(cli: SmokeCli, launch: LaunchReport): string {
  const status = launch.problems.length === 0 ? "PASS" : "FAIL";
  const handles = (value?: SmokeHandles) => value ? `${value.executionId} / ${value.taskId}` : "none";
  const foreign = launch.foreignDenied ? "wrong-owner inspect denied; " : "";
  const lines = [`${status} ${cli} launch ${launch.label}: ${foreign}owner ${launch.ownerId ?? "none"}, start ${handles(launch.start)} -> inspect ${handles(launch.inspect)}`];
  const extra = cli === "claude" ? `nativeToolSearch=${String(launch.usedToolSearch)}` : `toolForm=${String(launch.codexToolForm)}`;
  lines.push(`  mcpClient=${String(launch.mcpClient)} prompts=${launch.prompts} modelRequests=${launch.modelRequests} sideRequests=${launch.sideRequests} ownerTeardown=${String(launch.ownerTeardown)} ${extra}`);
  for (const call of launch.calls) {
    const refusal = call.refusal ? ` refusal=${String(call.refusal)}` : "";
    lines.push(`  ${String(call.tool)} ${String(call.outcome)} isError=${String(call.isError)} result=${String(call.resultClass)}${refusal}`);
  }
  for (const problem of launch.problems) lines.push(`  problem: ${problem}`);
  return lines.join("\n");
}

function usage(): string {
  return "usage: node dist-test/tests/managed-tool-mcp-smoke.js --cli claude|codex [--cli-bin <path>] [--timeout-ms <n>] [--scratch-parent <dir>] [--keep] [--json]";
}

async function main(argv: string[]): Promise<number> {
  const options: Partial<SmokeRunOptions> = {};
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--cli") {
      const cli = value();
      if (cli !== "claude" && cli !== "codex") throw new Error("--cli must be claude or codex");
      options.cli = cli;
    } else if (arg === "--cli-bin") options.cliBin = value();
    else if (arg === "--timeout-ms") {
      const parsed = Number(value());
      if (!Number.isInteger(parsed) || parsed < 5_000 || parsed > 600_000) throw new Error("--timeout-ms must be 5000..600000");
      options.timeoutMs = parsed;
    } else if (arg === "--scratch-parent") options.scratchParent = value();
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.cli) throw new Error("--cli is required");
  // SIGINT/SIGTERM go through the same bounded group termination and
  // cleanup as a timeout. Repeated signals do not skip cleanup.
  const controller = new AbortController();
  const onSignal = (name: NodeJS.Signals) => {
    if (!controller.signal.aborted) controller.abort(name);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let report: SmokeReport;
  try {
    report = await runManagedToolMcpSmoke({ ...(options as SmokeRunOptions), signal: controller.signal });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${options.cli} version: ${report.cliVersion ?? "unknown"}\n`);
  for (const launch of report.launches) process.stdout.write(`${formatLaunch(report.cli, launch)}\n`);
  for (const problem of report.problems) process.stdout.write(`problem: ${problem}\n`);
  process.stdout.write(report.scratch
    ? `scratch kept at ${report.scratch}\n`
    : `cleanup: owner dirs left by CLI termination=${report.ownerLeftovers}; scratch removed=${String(report.scratchRemoved)}\n`);
  if (report.interrupted) {
    process.stdout.write(`managed-tool MCP smoke (${report.cli}): INTERRUPTED by ${report.interrupted}\n`);
    return report.interrupted === "SIGINT" ? 130 : report.interrupted === "SIGTERM" ? 143 : 1;
  }
  process.stdout.write(`managed-tool MCP smoke (${report.cli}): ${report.passed ? "PASS" : "FAIL"}\n`);
  return report.passed ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usage()}\n`);
      process.exitCode = 2;
    },
  );
}
