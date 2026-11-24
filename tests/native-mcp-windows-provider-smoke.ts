/**
 * #682: TEST/DEVELOPMENT-ONLY real-CLI smoke in which a genuine installed
 * Claude Code 2.1.330 or Codex 0.171.0 consumes the PRODUCTION-generated native
 * MCP server definition and starts the genuine relay, which dials the real
 * broker. Its target is a disposable Windows host. It also runs on Linux/macOS
 * as a rehearsal, which is never Windows evidence.
 *
 * Path under test, with no seam on preparation, transport, or relay:
 *   createStatusBroker() -> registerNativeMcpSource() -> prepareNativeMcpLaunch()
 *   (default Windows DACL policy, default artifact parent, default relay entry,
 *   the host's own PSModulePath) -> the provider reads the generated definition
 *   -> the provider starts the relay -> the relay consumes the bootstrap and
 *   authenticates to the broker -> tools/list and ONE harmless tools/call reach
 *   a recording test endpoint.
 *
 * - Claude: the generated `--mcp-config=<file>` goes to `claude -p` with
 *   `--strict-mcp-config` and stream-json input, so the session stays alive
 *   after its result until teardown. The model is a 127.0.0.1 mock of Anthropic
 *   Messages. It uses native ToolSearch to load the deferred probe, calls it
 *   once, then ends. The pinned version comes from the session's own init event.
 * - Codex: the generated `-c mcp_servers.<name>={…}` goes to `codex app-server`
 *   over stdio. The pinned version comes from its initialize reply. Before any
 *   MCP server starts, the CLI's own readback must give positive isolation
 *   evidence, or the run refuses. Malformed replies fail it:
 *   - `configRequirements/read` must explicitly report `requirements: null`;
 *   - `config/read` must list exactly the scratch user config as the user
 *     layer, and no layer that carries settings beyond packaged defaults and
 *     session flags;
 *   - the effective config must name the loopback sink as model provider and
 *     contain exactly the generated relay server.
 *   Then `thread/start`, `mcpServerStatus/list`, and `mcpServer/tool/call` run.
 *   No turn is started and no model request is made.
 *
 * Evidence tier, stated honestly: this shows that a provider CLI or app-server
 * accepts the generated definition and reaches the endpoint through the relay
 * and broker. It is NOT:
 * - a production sidebar or callback test;
 * - an interactive Claude TUI launch;
 * - an owned Codex backend launch (production listens on a capability-token
 *   websocket and renders through the launcher, including cmd.exe for `.cmd`
 *   shims; here a native .exe is required and the app-server talks over stdio);
 * - a model-initiated Codex tool call or approval path (`mcpServer/tool/call`
 *   is a direct client call).
 * The host lane's Windows gate is reported as a fact (`hostLaneWindows`) and
 * is not checked: this smoke never arms or exercises the host lane, so a pass
 * here is shared transport and definition evidence only, never evidence of a
 * real production provider launch through the lane.
 *
 * Permissions: Claude keeps its default permission mode. Non-interactive `-p`
 * cannot prompt, so the run passes one exact `--allowedTools` entry for the
 * probe, the same posture as ./managed-tool-mcp-smoke.ts. Codex keeps its
 * default approval and sandbox settings, and any approval or elicitation
 * request it sends is declined and fails the run. No bypass flag is used.
 *
 * Isolation (fail-closed prerequisites):
 * - Use a DISPOSABLE VM with no provider credentials and no
 *   managed policy, and block outbound network outside the runner (the
 *   runner cannot enforce it). `--disposable-host` records that you have done
 *   this; without it the run refuses to start.
 * - Preflight refuses on known managed-policy locations. On POSIX these are
 *   the existing smoke's list. On Windows, for Claude, they are
 *   `C:\Program Files\ClaudeCode` and the `HKLM`/`HKCU` keys
 *   `SOFTWARE\Policies\ClaudeCode`, both found in the 2.1.330 binary. The keys
 *   are opened read-only in both registry views through the system PowerShell's
 *   .NET registry API, which distinguishes a missing key from an access or
 *   query failure; anything but "absent everywhere" refuses. Codex is checked
 *   by its live readback (above).
 * - One fresh scratch directory provides HOME/USERPROFILE/APPDATA/LOCALAPPDATA,
 *   TEMP, CLAUDE_CONFIG_DIR or CODEX_HOME, and the workspace. The child
 *   environment is an allowlist of PATH, locale, Windows system variables, and
 *   synthetic values; no provider key, auth file, or `PI_REVIEW_GATE_*`
 *   variable is inherited. HTTP(S)_PROXY points at the loopback sink, which
 *   refuses and counts every non-loopback request, and any such attempt fails
 *   the run. Codex's model provider is the same sink, and any request to it
 *   also fails the run.
 * - The bootstrap token stays in the broker, the protected file, and the
 *   relay's hello. Argv, environment, and definition are checked to be free of
 *   it; CLI output that contains it is withheld.
 *
 * Operator steps (Windows, from a checkout; nothing is installed by the runner):
 *
 *   npm ci --ignore-scripts
 *   npm run build:test
 *   node dist-test\tests\native-mcp-windows-provider-smoke.js --cli claude --cli-bin <abs path>\claude.exe --disposable-host
 *   node dist-test\tests\native-mcp-windows-provider-smoke.js --cli codex --cli-bin <abs path>\codex.exe --disposable-host
 *
 * On Windows `--cli-bin` must be an absolute native `.exe`, never a
 * `.cmd`/`.bat` shim. For npm Codex, that is the vendored `codex.exe` inside the
 * package. Other options: `--timeout-ms <n>` (default 240000), `--scratch-parent <dir>`,
 * `--json` (full allowlisted report), `--diagnostics` (prints the screened,
 * unsanitized CLI stderr tail on failure; local console only). Exit 0 PASS, 1
 * FAIL, 2 usage or prerequisite, 130/143 interrupted.
 *
 * Teardown is judged independently of the root's own exit, and every wait is
 * bounded on `exit` rather than pipe closure. On POSIX the provider runs in its
 * own process group; after an optional graceful input end, the group is
 * killed and must be observed empty. On Windows the tree is killed with the
 * existing `taskkill /T` helper WHILE the root is still alive. A root that
 * exited first leaves its descendants unattributable, so settlement stays
 * unconfirmed (no job object is used; that would be a platform change). On
 * both, no process may still carry this run's unique random lease or scratch
 * path in its command line. That scan only observes: a path match does not
 * prove the smoke started the process, so nothing is killed on it, and any
 * remaining match or a failed scan counts as unconfirmed. Only a confirmed
 * settlement (with the broker having seen the relay lane close) makes the
 * local lease cleanup (which reports the consumed bootstrap as absent) and
 * scratch removal safe. The registration is released and the broker disposed
 * in either case. If settlement is unconfirmed, the lease and scratch paths
 * stay in place and are reported. Keep the VM offline and discard it.
 * Residual risk: a descendant that carries none of this run's paths cannot be
 * attributed if it left the tree after its parent exited (Windows), or left
 * the process group (POSIX).
 *
 * Claude Code on Windows also needs Git for Windows (Git Bash) installed in a
 * standard location; `CLAUDE_CODE_GIT_BASH_PATH` is passed through if set.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { isAbsolute, join, resolve } from "node:path";
import type { Duplex } from "node:stream";

import { terminateProcessTree, waitForPromiseBounded } from "../src/adapters/process";
import { createStatusBroker, type NativeMcpRegistration, type NativeMcpStatusBroker } from "../src/session-host/broker";
import { scanNativeArgPositions } from "../src/session-host/native-cli-launch";
import { NATIVE_MANAGED_HOST_LANE_SUPPORTED_PLATFORMS } from "../src/session-host/native-managed-host-lane";
import {
  CLAUDE_MCP_CONFIG_OPTION,
  NATIVE_MCP_SERVER_NAME_PREFIX,
  prepareNativeMcpLaunch,
  type NativeMcpArtifactLease,
} from "../src/session-host/native-mcp-launch-prep";
import { NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, windowsNativeMcpClaimPath } from "../src/session-host/native-mcp-relay";
import type {
  NativeMcpCallToolRequest,
  NativeMcpCallToolResult,
  NativeMcpListToolsRequest,
  NativeMcpToolDescriptor,
  NativeMcpToolEndpoint,
} from "../src/session-host/native-mcp-stdio";
import { managedPolicyLocations, resolveOnPath } from "./managed-tool-mcp-smoke";

type Cli = "claude" | "codex";
type Json = Record<string, unknown>;

const PINNED: Record<Cli, string> = { claude: "2.1.330", codex: "0.171.0" };
const PROBE_TOOL = "PrgNativeRelayProbe";
const PROBE_RESULT = `probe recorded ${PROBE_TOOL}`;
const DONE_TEXT = "PRG-NATIVE-MCP-SMOKE-DONE";
const SYNTHETIC_KEY = "prg-native-mcp-smoke-synthetic-key-not-a-credential";
const SCRATCH_MARKER = ".prg-native-mcp-provider-smoke-scratch";
const DEFAULT_TIMEOUT_MS = 240_000;
const TEARDOWN_MS = 15_000;
const MAX_CAPTURE = 4 * 1024 * 1024;
const IS_WINDOWS = process.platform === "win32";

const TOOLS: NativeMcpToolDescriptor[] = [{
  name: PROBE_TOOL,
  description: "test-only probe; records the call and runs nothing",
  inputSchema: { type: "object", properties: { note: { type: "string" } } },
}];

/** The trusted test endpoint: records discovery and calls, runs nothing. */
class RecordingEndpoint implements NativeMcpToolEndpoint {
  listCalls = 0;
  readonly calls: Array<{ name: string; note: unknown }> = [];

  async listTools(_request: NativeMcpListToolsRequest): Promise<readonly NativeMcpToolDescriptor[]> {
    this.listCalls += 1;
    return TOOLS;
  }

  async callTool(request: NativeMcpCallToolRequest): Promise<NativeMcpCallToolResult | undefined> {
    this.calls.push({ name: request.name, note: request.arguments.note });
    return { content: [{ type: "text", text: `probe recorded ${request.name}` }], isError: false };
  }
}

export interface ProviderSmokeReport {
  cli: Cli;
  platform: NodeJS.Platform;
  windowsEvidence: boolean;
  cliVersion?: string;
  hostLaneWindows: "off" | "ON";
  prep?: { outcome: string; route?: string; definitionEnvKeys?: string[] };
  provider: Json;
  relay: { endpointListCalls: number; endpointCalls: number; probeNote?: unknown; bootstrapConsumed?: boolean; claimLeft?: boolean; laneClosed?: boolean };
  isolation: { modelRequests: number; sideRequests: number; unauthorized: number; egressHosts: string[]; codexModelRequests: number };
  cleanup: { providerSettled: boolean; settlement: string; lease?: { removed: number; absent: number; preserved: number }; brokerDisposed: boolean; scratchRemoved: boolean };
  prerequisite: string[];
  problems: string[];
  passed: boolean;
  interrupted?: string;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------- preflight

/**
 * Read-only check of the Claude policy key in both hives and both registry
 * views. Absence is established by enumerating each parent's subkey names,
 * never inferred from a null `OpenSubKey` (the .NET Framework overload can
 * return null for native errors other than a missing key): a listed parent
 * that cannot be opened, an enumeration error, or a timeout refuses. Only exit
 * 10 (absent everywhere) passes.
 */
function windowsClaudePolicyRegistry(): "absent" | "present" | "unverifiable" {
  const powershell = windowsPowerShell();
  if (!powershell) return "unverifiable";
  const script = "$ErrorActionPreference='Stop'; try { foreach ($h in 'LocalMachine','CurrentUser') { foreach ($v in 'Registry64','Registry32') { "
    + "$b = [Microsoft.Win32.RegistryKey]::OpenBaseKey(([Microsoft.Win32.RegistryHive]$h), ([Microsoft.Win32.RegistryView]$v)); "
    + "foreach ($n in 'SOFTWARE','Policies','ClaudeCode') { "
    + "if ($b.GetSubKeyNames() -notcontains $n) { break }; if ($n -eq 'ClaudeCode') { exit 11 }; "
    + "$b = $b.OpenSubKey($n, $false); if ($null -eq $b) { exit 12 } } } }; exit 10 } catch { exit 12 }";
  const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true, timeout: 60_000 });
  return result.status === 10 ? "absent" : result.status === 11 ? "present" : "unverifiable";
}

/** Only ENOENT establishes that a managed-policy location is absent. */
function policyLocationState(location: string): "absent" | "present" | "unverifiable" {
  try {
    lstatSync(location);
    return "present";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unverifiable";
  }
}

/** Host-level reasons this run must not start; empty means it may. */
export function preflightBlockers(cli: Cli, platform: NodeJS.Platform, attested: boolean): string[] {
  const blockers: string[] = [];
  if (!attested) blockers.push("--disposable-host is required: use a disposable VM without credentials or managed policy, with outbound network blocked");
  if (platform !== "win32") {
    for (const location of managedPolicyLocations(cli, platform)) {
      const state = policyLocationState(location);
      if (state !== "absent") blockers.push(`${cli} managed policy location ${location} is ${state}`);
    }
    return blockers;
  }
  if (cli === "claude") {
    for (const location of new Set(["C:\\Program Files\\ClaudeCode", join(process.env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode")])) {
      const state = policyLocationState(location);
      if (state !== "absent") blockers.push(`claude managed policy directory ${location} is ${state}`);
    }
    const state = windowsClaudePolicyRegistry();
    if (state !== "absent") blockers.push(`claude registry policy HKLM/HKCU\\SOFTWARE\\Policies\\ClaudeCode is ${state}`);
  }
  return blockers;
}

function resolveCliBin(cli: Cli, cliBin: string | undefined): string {
  if (IS_WINDOWS) {
    if (!cliBin || !isAbsolute(cliBin) || !/\.exe$/iu.test(cliBin)) throw new Error("on Windows --cli-bin must be an absolute path to the native .exe (never a .cmd/.bat shim)");
    if (!existsSync(cliBin)) throw new Error(`${cliBin} does not exist`);
    return cliBin;
  }
  const bin = resolveOnPath(cliBin ?? cli);
  if (!bin) throw new Error(`${cliBin ?? cli} was not found`);
  return bin;
}

// ---------------------------------------------------------------- scratch / env

interface Scratch { root: string; home: string; tmp: string; workspace: string; cliHome: string }

/** Exclusive creation under the canonical parent; the caller owns the path before anything is written in it. */
async function allocateScratch(parent: string | undefined): Promise<Scratch> {
  const root = await mkdtemp(join(realpathSync.native(parent ?? tmpdir()), "prg-native-mcp-smoke-"));
  return { root, home: join(root, "home"), tmp: join(root, "tmp"), workspace: join(root, "workspace"), cliHome: join(root, "cli-home") };
}

async function initializeScratch(scratch: Scratch): Promise<void> {
  await writeFile(join(scratch.root, SCRATCH_MARKER), "pi-review-gate native MCP provider smoke scratch; safe to delete\n", { flag: "wx", mode: 0o600 });
  for (const dir of [scratch.home, scratch.tmp, scratch.workspace, scratch.cliHome, join(scratch.home, "AppData", "Roaming"), join(scratch.home, "AppData", "Local")]) {
    await mkdir(dir, { recursive: true });
  }
}

function childEnvironment(cli: Cli, scratch: Scratch, sinkUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? process.env.Path ?? "",
    HOME: scratch.home,
    USERPROFILE: scratch.home,
    APPDATA: join(scratch.home, "AppData", "Roaming"),
    LOCALAPPDATA: join(scratch.home, "AppData", "Local"),
    TMPDIR: scratch.tmp,
    TMP: scratch.tmp,
    TEMP: scratch.tmp,
    XDG_CONFIG_HOME: join(scratch.home, ".config"),
    XDG_CACHE_HOME: join(scratch.home, ".cache"),
    XDG_DATA_HOME: join(scratch.home, ".local", "share"),
    XDG_STATE_HOME: join(scratch.home, ".local", "state"),
    GIT_CEILING_DIRECTORIES: resolve(scratch.root, ".."),
    // Fail-closed egress: proxy-honoring clients reach only the refusing sink.
    HTTPS_PROXY: sinkUrl, HTTP_PROXY: sinkUrl, ALL_PROXY: sinkUrl,
    https_proxy: sinkUrl, http_proxy: sinkUrl, all_proxy: sinkUrl,
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    NO_COLOR: "1",
    TERM: "dumb",
  };
  // Windows system variables the CLIs and the relay's trusted DACL helper need;
  // Claude on Windows also needs Git Bash, whose location is not a credential.
  for (const name of ["LANG", "LC_ALL", "SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "CLAUDE_CODE_GIT_BASH_PATH"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  if (cli === "claude") {
    Object.assign(env, {
      CLAUDE_CONFIG_DIR: scratch.cliHome,
      ANTHROPIC_BASE_URL: sinkUrl,
      ANTHROPIC_API_KEY: SYNTHETIC_KEY,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    });
  } else {
    Object.assign(env, { CODEX_HOME: scratch.cliHome, PRG_SMOKE_SINK_KEY: SYNTHETIC_KEY });
  }
  return env;
}

// ---------------------------------------------------------------- loopback sink

interface Sink {
  url: string;
  isolation: ProviderSmokeReport["isolation"];
  claude: { toolSearchUsed: boolean; probeOffered: boolean; resultDelivered: boolean; finalSent: boolean };
  close(): Promise<void>;
}

function anthropicStream(res: ServerResponse, model: unknown, block: Json): void {
  const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
  const message = { id: `msg_prgnative_${Date.now()}`, type: "message", role: "assistant", model: typeof model === "string" ? model : "mock" };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (type: string, data: Json) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", { message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  if (block.type === "tool_use") {
    send("content_block_start", { index: 0, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
    send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
  } else {
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
  }
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  send("message_stop", {});
  res.end();
}

function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).join("\n");
  if (isRecord(value)) {
    if (typeof value.text === "string") return value.text;
    if (value.type === "tool_reference" && typeof value.tool_name === "string") return `tool_reference:${value.tool_name}`;
    return "content" in value ? flatten(value.content) : "";
  }
  return "";
}

function hostOf(target: string): string {
  let host = target;
  try {
    host = /^[a-z]+:\/\//iu.test(target) ? new URL(target).hostname : target.replace(/:\d+$/u, "");
  } catch {
    host = "<unparsed>";
  }
  return /^[A-Za-z0-9.\-[\]:]{1,253}$/u.test(host) ? host : "<invalid>";
}

/**
 * One 127.0.0.1 server: Anthropic Messages mock (Claude), refusing model
 * sink (Codex), and refusing egress proxy for every other destination.
 */
async function startSink(probeName: string): Promise<Sink> {
  const isolation: Sink["isolation"] = { modelRequests: 0, sideRequests: 0, unauthorized: 0, egressHosts: [], codexModelRequests: 0 };
  const claude = { toolSearchUsed: false, probeOffered: false, resultDelivered: false, finalSent: false };
  let port = 0;
  const handle = (req: IncomingMessage, res: ServerResponse, raw: string): void => {
    let path = req.url ?? "";
    if (/^[a-z]+:\/\//iu.test(path)) {
      const url = new URL(path);
      if (!(url.hostname === "127.0.0.1" && Number(url.port) === port)) {
        isolation.egressHosts.push(hostOf(path));
        res.writeHead(403);
        res.end();
        return;
      }
      path = url.pathname;
    }
    path = path.split("?", 1)[0] ?? "";
    if (req.headers["x-api-key"] !== SYNTHETIC_KEY && req.headers.authorization !== `Bearer ${SYNTHETIC_KEY}`) {
      isolation.unauthorized += 1;
      res.writeHead(401, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if (path !== "/v1/messages") {
      // Codex's provider base URL is this sink: any model request is a failure.
      if (path.startsWith("/v1/")) isolation.codexModelRequests += 1;
      else isolation.sideRequests += 1;
      res.writeHead(path.startsWith("/v1/") ? 503 : 404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    let body: Json;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) throw new Error("not an object");
      body = parsed;
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const tools = (Array.isArray(body.tools) ? body.tools : []).filter(isRecord);
    const toolSearch = tools.some((tool) => tool.name === "ToolSearch");
    const probe = tools.find((tool) => tool.name === probeName);
    if (!toolSearch && !probe) {
      isolation.sideRequests += 1;
      anthropicStream(res, body.model, { type: "text", text: "ok" });
      return;
    }
    isolation.modelRequests += 1;
    if (probe) claude.probeOffered = true;
    const results = new Map<string, string>();
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      if (!isRecord(message) || message.role !== "user" || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (isRecord(block) && block.type === "tool_result" && typeof block.tool_use_id === "string") results.set(block.tool_use_id, flatten(block.content));
      }
    }
    const called = results.get("prgnative_call");
    if (called !== undefined) {
      claude.resultDelivered = called.includes(PROBE_RESULT);
      claude.finalSent = true;
      anthropicStream(res, body.model, { type: "text", text: claude.resultDelivered ? DONE_TEXT : "PRG-NATIVE-MCP-SMOKE-BLOCKED" });
    } else if ((!probe || probe.defer_loading === true) && toolSearch && !results.has("prgnative_search")) {
      claude.toolSearchUsed = true;
      anthropicStream(res, body.model, { type: "tool_use", id: "prgnative_search", name: "ToolSearch", input: { query: `select:${probeName}`, max_results: 5 } });
    } else if (probe || results.has("prgnative_search")) {
      anthropicStream(res, body.model, { type: "tool_use", id: "prgnative_call", name: probeName, input: { note: "harmless" } });
    } else {
      anthropicStream(res, body.model, { type: "text", text: "PRG-NATIVE-MCP-SMOKE-BLOCKED" });
    }
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= 8 * MAX_CAPTURE) chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        handle(req, res, Buffer.concat(chunks).toString("utf8"));
      } catch {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
  });
  const tunnels = new Set<Duplex>();
  server.on("connect", (req: IncomingMessage, socket: Duplex) => {
    // closeAllConnections() does not cover upgraded CONNECT sockets.
    tunnels.add(socket);
    socket.once("close", () => tunnels.delete(socket));
    isolation.egressHosts.push(hostOf(req.url ?? ""));
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    isolation,
    claude,
    close: () => new Promise<void>((resolveClose) => {
      for (const tunnel of tunnels) tunnel.destroy();
      server.closeAllConnections();
      server.close(() => resolveClose());
    }),
  };
}

// ---------------------------------------------------------------- owned process tree

const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));

function windowsPowerShell(): string | undefined {
  const root = process.env.SystemRoot;
  return root && isAbsolute(root) ? join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : undefined;
}

/**
 * PIDs of processes whose command line carries one of this run's unique random
 * paths (the lease root and the scratch root): the provider root, the relay,
 * and anything else started with them. `undefined` means the scan failed.
 * Windows passes the markers through the environment, so the scanning
 * PowerShell never matches itself.
 */
function markedProcesses(markers: readonly string[]): number[] | undefined {
  if (IS_WINDOWS) {
    const powershell = windowsPowerShell();
    if (!powershell) return undefined;
    const script = "$ErrorActionPreference='Stop'; try { $m = $env:PRG_SMOKE_MARKERS -split \"`n\" | Where-Object { $_ }; "
      + "Get-CimInstance Win32_Process | ForEach-Object { $c = $_.CommandLine; if ($c) { foreach ($x in $m) { "
      + "if ($c.IndexOf($x, [StringComparison]::OrdinalIgnoreCase) -ge 0) { [Console]::Out.WriteLine($_.ProcessId); break } } } }; exit 0 } catch { exit 12 }";
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, PRG_SMOKE_MARKERS: markers.join("\n") }, encoding: "utf8", windowsHide: true, timeout: 60_000,
    });
    if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
    return result.stdout.split(/\r?\n/u).filter((line) => /^\d+$/u.test(line.trim())).map(Number).filter((pid) => pid !== process.pid);
  }
  const ps = ["/bin/ps", "/usr/bin/ps"].find((candidate) => existsSync(candidate));
  if (!ps) return undefined;
  const result = spawnSync(ps, ["-A", "-ww", "-o", "pid=", "-o", "args="], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
    return match && markers.some((marker) => match[2]!.includes(marker)) && Number(match[1]) !== process.pid ? [Number(match[1])] : [];
  });
}

/**
 * One owned provider child. Output is screened for the token as it arrives;
 * lines are handed to `onLine`. Lifecycle waits use `exit`, never pipe
 * closure, so a descendant that keeps a pipe open cannot block teardown.
 */
class ProviderChild {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  stderr = "";
  tainted = false;
  spawnFailed = false;
  onLine?: (line: string) => void;
  #pending = "";

  constructor(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string, readonly secret: string) {
    // POSIX: its own process group, so teardown reaches every descendant that stays in it.
    this.child = spawn(bin, [...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, detached: !IS_WINDOWS });
    this.exited = new Promise((resolveExit) => {
      this.child.once("exit", () => resolveExit());
      this.child.once("error", () => {
        if (this.child.pid === undefined) this.spawnFailed = true;
        resolveExit();
      });
    });
    this.child.stdin!.on("error", () => undefined);
    this.child.stdout!.setEncoding("utf8").on("data", (chunk: string) => this.#stdout(chunk));
    this.child.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
      if (this.tainted) return;
      const next = this.stderr + chunk;
      if (next.includes(this.secret)) this.#taint();
      else if (next.length <= MAX_CAPTURE) this.stderr = next;
    });
  }

  #taint(): void {
    this.tainted = true;
    this.stderr = "";
    this.#pending = "";
  }

  #stdout(chunk: string): void {
    if (this.tainted) return;
    const pending = this.#pending + chunk;
    // The whole unconsumed text is checked, so a token split across chunks is caught.
    if (pending.includes(this.secret)) return this.#taint();
    let rest = pending;
    let index: number;
    while ((index = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, index).trim();
      rest = rest.slice(index + 1);
      if (line) this.onLine?.(line);
    }
    this.#pending = rest.length <= MAX_CAPTURE ? rest : "";
  }

  write(message: Json): void {
    if (!this.settled) this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  get settled(): boolean {
    return this.spawnFailed || this.child.exitCode !== null || this.child.signalCode !== null;
  }

  /**
   * Bounded owned-tree teardown, judged independently of the root's own exit:
   * - POSIX: optional graceful input end, then the whole process group is
   *   killed and must be observed empty (ESRCH);
   * - Windows: the tree is killed with `taskkill /T` WHILE the root is alive;
   *   a root that exited first leaves its descendants unattributable, so
   *   settlement is unconfirmed;
   * - both: no process may still carry this run's unique paths in its command line.
   */
  async settle(markers: readonly string[], graceful: boolean): Promise<{ settled: boolean; detail: string }> {
    const pid = this.child.pid;
    if (pid === undefined) return { settled: true, detail: "never spawned" };
    const rootExitedFirst = this.settled;
    let detail = "";
    if (IS_WINDOWS) {
      if (rootExitedFirst) detail = "the root exited before teardown, so taskkill /T cannot attribute its descendants";
      else {
        const failure = terminateProcessTree(this.child, "SIGKILL");
        if (failure !== undefined) detail = `taskkill /T failed: ${failure}`;
      }
    } else {
      if (graceful && !rootExitedFirst) {
        this.child.stdin!.end();
        await waitForPromiseBounded(this.exited, 5_000);
      }
      const failure = terminateProcessTree(this.child, "SIGKILL");
      if (failure !== undefined) detail = `process-group termination failed: ${failure}`;
      let empty = false;
      for (const until = Date.now() + TEARDOWN_MS; !empty && Date.now() < until; await sleep(100)) {
        try {
          process.kill(-pid, 0);
        } catch (error) {
          empty = (error as NodeJS.ErrnoException).code === "ESRCH";
          if (!empty) break;
        }
      }
      if (!empty && !detail) detail = "the provider process group was not observed empty";
    }
    if ((await waitForPromiseBounded(this.exited, TEARDOWN_MS)).kind !== "fulfilled" && !detail) detail = "the provider root did not exit";
    // Observation only: a relay may need a moment to see its input end, so a
    // match is re-checked within a short bound, but nothing is killed on a
    // path match, which does not prove the smoke started that process.
    let marked = markedProcesses(markers);
    for (const until = Date.now() + 5_000; marked !== undefined && marked.length > 0 && Date.now() < until;) {
      await sleep(250);
      marked = markedProcesses(markers);
    }
    if (marked === undefined && !detail) detail = "the owned-process scan failed";
    else if (marked !== undefined && marked.length > 0 && !detail) detail = `${marked.length} process(es) carrying this run's paths are still running (left alone: a path match is not proof of ownership)`;
    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) stream?.destroy();
    // A failed kill must not keep this runner alive through the child handle.
    this.child.unref();
    return { settled: detail === "", detail: detail || "confirmed" };
  }
}

// ---------------------------------------------------------------- Claude

/** Drives one `claude -p` stream-json session; it stays alive after its result until teardown. */
async function runClaude(child: ProviderChild, serverName: string, probeName: string, deadline: Promise<void>, report: ProviderSmokeReport, sink: Sink): Promise<void> {
  const provider: Json = {};
  report.provider = provider;
  let resolveResult!: () => void;
  const resultSeen = new Promise<void>((resolveSeen) => { resolveResult = resolveSeen; });
  child.onLine = (line) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (event.type === "system" && event.subtype === "init") {
      report.cliVersion = typeof event.claude_code_version === "string" ? event.claude_code_version : "<unreported>";
      const server = (Array.isArray(event.mcp_servers) ? event.mcp_servers : []).filter(isRecord).find((entry) => entry.name === serverName);
      provider.mcpStatus = typeof server?.status === "string" ? server.status : "absent";
      provider.probeListed = Array.isArray(event.tools) && event.tools.includes(probeName);
      provider.permissionMode = typeof event.permissionMode === "string" ? event.permissionMode : undefined;
    } else if (event.type === "result") {
      provider.final = event.result === DONE_TEXT ? "done" : "other";
      provider.isError = event.is_error === true;
      provider.permissionDenials = Array.isArray(event.permission_denials) ? event.permission_denials.length : undefined;
      resolveResult();
    }
  };
  child.write({ type: "user", message: { role: "user", content: "Run the pi-review-gate native MCP provider smoke." } });
  await Promise.race([resultSeen, child.exited, deadline]);
  Object.assign(provider, sink.claude, provider.final === undefined ? {} : { aliveAtResult: !child.settled });
  if (report.cliVersion !== undefined && report.cliVersion !== PINNED.claude) {
    report.prerequisite.push(`claude ${PINNED.claude} is required; the session reported ${report.cliVersion}`);
    return;
  }
  const check = (ok: boolean, message: string) => { if (!ok) report.problems.push(message); };
  check(provider.final !== undefined, "claude produced no result before exit or deadline");
  check(provider.aliveAtResult === true, "claude exited on its own instead of waiting for teardown");
  check(provider.mcpStatus === "connected", `claude reported the generated server as ${String(provider.mcpStatus ?? "unreported")}`);
  check(provider.probeListed === true, "claude did not list the probe tool from the relay");
  check(provider.permissionMode === "default", "claude did not run in its default permission mode");
  check(sink.claude.resultDelivered, "claude did not deliver the probe result back to the model");
  check(provider.final === "done" && provider.isError === false && provider.permissionDenials === 0, "claude did not finish the plan cleanly");
}

// ---------------------------------------------------------------- Codex

class AppServerClient {
  #next = 0;
  readonly #pending = new Map<number, (message: Json) => void>();
  readonly startup: Json[] = [];
  readonly declined: string[] = [];

  constructor(readonly child: ProviderChild, readonly serverName: string, readonly assertActive: () => void) {
    child.onLine = (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (!isRecord(message)) return;
      if (message.id !== undefined && typeof message.method === "string") {
        // Approval or elicitation: decline (never approve) and fail the run.
        this.declined.push(message.method);
        child.write({ id: message.id, error: { code: -32601, message: "declined by the smoke" } });
      } else if (typeof message.id === "number" && this.#pending.has(message.id)) {
        this.#pending.get(message.id)!(message);
        this.#pending.delete(message.id);
      } else if (message.method === "mcpServer/startupStatus/updated" && isRecord(message.params) && message.params.name === serverName) {
        this.startup.push({ status: message.params.status, failureReason: message.params.failureReason ?? null });
      }
    };
  }

  /** One request; an error, a non-object result, exit, or the deadline throws. */
  async request(method: string, params: Json, deadline: Promise<void>): Promise<Json> {
    // No new work after the deadline or an abort: nothing is sent once it has passed.
    this.assertActive();
    const id = ++this.#next;
    const reply = new Promise<Json>((resolveReply) => this.#pending.set(id, resolveReply));
    this.child.write({ method, id, params });
    const outcome = await Promise.race([reply, deadline.then(() => undefined), this.child.exited.then(() => undefined)]);
    if (outcome === undefined) throw new Error(`codex app-server gave no ${method} reply before exit or deadline`);
    if (isRecord(outcome.error)) throw new Error(`codex app-server refused ${method} (code ${String(outcome.error.code)})`);
    if (!isRecord(outcome.result)) throw new Error(`codex app-server sent a malformed ${method} reply`);
    return outcome.result;
  }
}

const CODEX_ALLOWED_LAYERS = new Set(["packagedDefaults", "user", "sessionFlags"]);

/** Defaults Codex 0.171.0 materializes on every readback of a `{command,args[,env]}` server (observed). */
const CODEX_INERT_SERVER_DEFAULTS: Readonly<Record<string, unknown>> = { environment_id: "local", enabled: true, tool_timeout_sec: null };

interface CodexExpectations { serverName: string; userConfig: string; sinkBase: string; bootstrapFile: string }

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const plain = resolve(value.replace(/^\\\\\?\\/u, ""));
    return IS_WINDOWS ? plain.toLowerCase() : plain;
  };
  return normalize(left) === normalize(right);
}

/**
 * The exact production relay definition: this Node host, the ordered argv
 * [compiled relay entry, bootstrap flag, this lease's bootstrap file], and the
 * environment production preparation carries (exactly the host's own
 * PSModulePath on Windows, nothing on POSIX). Returns a problem or undefined.
 */
function relayDefinitionProblem(command: unknown, args: unknown, env: unknown, bootstrapFile: string): string | undefined {
  const relayEntry = require.resolve("../src/session-host/native-mcp-relay");
  // Literal comparison: a relative or re-spelled path could resolve differently in the provider's cwd.
  if (command !== process.execPath) return "its command is not this Node host";
  if (!Array.isArray(args) || args.length !== 3 || args[0] !== relayEntry
    || args[1] !== NATIVE_MCP_RELAY_BOOTSTRAP_FLAG || args[2] !== bootstrapFile) {
    return "its argv is not exactly [relay entry, bootstrap flag, bootstrap file]";
  }
  const actual = env ?? {};
  if (!isRecord(actual)) return "its environment is malformed";
  const modulePath = process.env.PSModulePath;
  if (IS_WINDOWS && !modulePath) return "this Windows host has no PSModulePath for the relay definition";
  const expected: Record<string, string> = IS_WINDOWS ? { PSModulePath: modulePath! } : {};
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected)) || Object.keys(expected).some((name) => actual[name] !== expected[name])) {
    return "its environment is not exactly the trusted PSModulePath (Windows) or empty (POSIX)";
  }
  return undefined;
}

/**
 * Positive isolation evidence from the CLI's own readback, required BEFORE any
 * MCP server starts. Returns a refusal, or undefined when isolation is proven.
 * Malformed replies throw.
 */
function codexIsolationRefusal(requirements: Json, config: Json, expected: CodexExpectations, provider: Json): string | undefined {
  if (!Object.hasOwn(requirements, "requirements")) throw new Error("codex configRequirements/read omitted requirements");
  provider.managedRequirements = requirements.requirements === null ? "none" : "present";
  if (requirements.requirements !== null) return "codex reported managed requirements";
  if (!Array.isArray(config.layers)) throw new Error("codex config/read returned no layer list");
  const layers = config.layers.map((layer) => {
    if (!isRecord(layer) || !isRecord(layer.name) || typeof layer.name.type !== "string" || !isRecord(layer.config)) throw new Error("codex config/read returned a malformed layer");
    return { type: layer.name.type, file: layer.name.file, settings: Object.keys(layer.config).length };
  });
  provider.layers = layers.map((layer) => layer.type);
  const users = layers.filter((layer) => layer.type === "user");
  const user = users.length === 1 ? users[0] : undefined;
  if (user === undefined || typeof user.file !== "string" || !isAbsolute(user.file) || !samePath(user.file, expected.userConfig)) return "codex did not load exactly the scratch user config";
  // Any other layer may exist only when it carries no settings (0.171.0 lists an absent system file).
  if (layers.some((layer) => !CODEX_ALLOWED_LAYERS.has(layer.type) && layer.settings > 0)) return "codex loaded settings from a layer outside the scratch";
  const effective = config.config;
  if (!isRecord(effective)) throw new Error("codex config/read returned no effective config");
  const providers = isRecord(effective.model_providers) ? effective.model_providers : {};
  const sink = isRecord(providers.prg_smoke_sink) ? providers.prg_smoke_sink : {};
  if (effective.model_provider !== "prg_smoke_sink" || sink.base_url !== expected.sinkBase) return "codex's effective model provider is not the loopback sink";
  const servers = isRecord(effective.mcp_servers) ? effective.mcp_servers : {};
  const server = servers[expected.serverName];
  if (Object.keys(servers).length !== 1 || !isRecord(server)) return "codex's effective MCP servers are not exactly the generated relay";
  // Only the generated fields plus the inert defaults pinned 0.171.0 materializes in
  // readback, each with its exact default value; anything else (for example
  // `env_vars` or `cwd`) is a launch setting production never emits.
  const extra = Object.keys(server).filter((key) => key !== "command" && key !== "args" && key !== "env"
    && !(Object.hasOwn(CODEX_INERT_SERVER_DEFAULTS, key) && server[key] === CODEX_INERT_SERVER_DEFAULTS[key]));
  if (extra.length > 0) return `codex's effective relay contains settings outside the generated definition: ${extra.sort().join(", ")}`;
  const definition = relayDefinitionProblem(server.command, server.args, server.env, expected.bootstrapFile);
  if (definition !== undefined) return `codex's effective relay definition differs from production preparation: ${definition}`;
  provider.relayEnvKeys = isRecord(server.env) ? Object.keys(server.env) : [];
  return undefined;
}

async function runCodex(child: ProviderChild, expected: CodexExpectations, workspace: string, deadline: Promise<void>, report: ProviderSmokeReport, assertActive: () => void): Promise<void> {
  const { serverName } = expected;
  const client = new AppServerClient(child, serverName, assertActive);
  const provider: Json = {};
  report.provider = provider;
  try {
    const init = await client.request("initialize", { clientInfo: { name: "prg-native-mcp-provider-smoke", title: null, version: "1" }, capabilities: { experimentalApi: true } }, deadline);
    report.cliVersion = typeof init.userAgent === "string" ? /^[^/\s]+\/(\d{1,6}\.\d{1,6}\.\d{1,6})(?:\s|$)/u.exec(init.userAgent)?.[1] ?? "<unrecognized>" : "<unreported>";
    if (report.cliVersion !== PINNED.codex) {
      report.prerequisite.push(`codex ${PINNED.codex} is required; the app-server reported ${report.cliVersion}`);
      return;
    }
    assertActive();
    child.write({ method: "initialized" });
    const requirements = await client.request("configRequirements/read", {}, deadline);
    const config = await client.request("config/read", { includeLayers: true, cwd: workspace }, deadline);
    const refusal = codexIsolationRefusal(requirements, config, expected, provider);
    if (refusal !== undefined) {
      report.prerequisite.push(`${refusal}; use a disposable VM without Codex policy`);
      return;
    }
    // The environment Codex will actually hand the relay, from its own readback.
    if (report.prep !== undefined && Array.isArray(provider.relayEnvKeys)) report.prep.definitionEnvKeys = provider.relayEnvKeys.map(String);
    const thread = await client.request("thread/start", { cwd: workspace, ephemeral: true }, deadline);
    const threadId = isRecord(thread.thread) && typeof thread.thread.id === "string" ? thread.thread.id : undefined;
    if (!threadId) throw new Error("codex thread/start returned no thread id");
    for (let ready = false; !ready;) {
      ready = client.startup.some((entry) => entry.status !== "starting") || child.settled;
      if (!ready && (await Promise.race([sleep(50).then(() => false), deadline.then(() => true)]))) break;
    }
    provider.startup = client.startup.map((entry) => entry.status);
    provider.startupFailure = client.startup.find((entry) => entry.failureReason !== null)?.failureReason ?? null;
    const listed = await client.request("mcpServerStatus/list", { threadId, serverName }, deadline);
    const status = (Array.isArray(listed.data) ? listed.data : []).filter(isRecord).find((entry) => entry.name === serverName);
    provider.runtimeStatus = status?.runtimeStatus ?? "absent";
    const tools = status?.tools;
    provider.tools = isRecord(tools) ? Object.keys(tools) : [];
    const called = await client.request("mcpServer/tool/call", { threadId, server: serverName, tool: PROBE_TOOL, arguments: { note: "harmless" } }, deadline);
    provider.callText = flatten(called.content) === PROBE_RESULT ? "probe-recorded" : "other";
    provider.callIsError = called.isError === true;
  } catch (error) {
    report.problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    provider.declinedServerRequests = client.declined;
  }
  if (report.prerequisite.length > 0) return;
  const check = (ok: boolean, message: string) => { if (!ok) report.problems.push(message); };
  check(Array.isArray(provider.startup) && provider.startup.includes("ready"), `codex did not report the generated server ready (${JSON.stringify(provider.startup)}, failure ${String(provider.startupFailure)})`);
  check(provider.runtimeStatus === "connected", `codex reported the generated server as ${String(provider.runtimeStatus)}`);
  check(JSON.stringify(provider.tools) === JSON.stringify([PROBE_TOOL]), "codex did not list exactly the probe tool from the relay");
  check(provider.callText === "probe-recorded" && provider.callIsError === false, "codex did not return the probe result");
  check(client.declined.length === 0, `codex sent ${client.declined.length} approval/elicitation request(s), which the smoke declined`);
}

// ---------------------------------------------------------------- run

export interface ProviderSmokeOptions {
  cli: Cli;
  cliBin?: string;
  timeoutMs?: number;
  scratchParent?: string;
  attested: boolean;
  signal?: AbortSignal;
}

export async function runNativeMcpProviderSmoke(options: ProviderSmokeOptions, diagnostics?: (stderr: string) => void): Promise<ProviderSmokeReport> {
  const { cli, signal } = options;
  const blockers = preflightBlockers(cli, process.platform, options.attested);
  if (blockers.length > 0) throw new Error(blockers.join("; "));
  const bin = resolveCliBin(cli, options.cliBin);
  const report: ProviderSmokeReport = {
    cli,
    platform: process.platform,
    windowsEvidence: IS_WINDOWS,
    hostLaneWindows: NATIVE_MANAGED_HOST_LANE_SUPPORTED_PLATFORMS.includes("win32") ? "ON" : "off",
    provider: {},
    relay: { endpointListCalls: 0, endpointCalls: 0 },
    isolation: { modelRequests: 0, sideRequests: 0, unauthorized: 0, egressHosts: [], codexModelRequests: 0 },
    cleanup: { providerSettled: true, settlement: "not started", brokerDisposed: false, scratchRemoved: false },
    prerequisite: [],
    problems: [],
    passed: false,
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Monotonic: synchronous Windows ACL work can hold the event loop past the
  // timer, so new work is gated on the clock, not only on the timer firing.
  const expiresAt = performance.now() + timeoutMs;
  const serverName = `${NATIVE_MCP_SERVER_NAME_PREFIX}${randomBytes(16).toString("hex")}`;
  const probeName = `mcp__${serverName}__${PROBE_TOOL}`;
  const endpoint = new RecordingEndpoint();
  let scratch: Scratch | undefined;
  let sink: Sink | undefined;
  let broker: NativeMcpStatusBroker | undefined;
  let registration: NativeMcpRegistration | undefined;
  let lease: NativeMcpArtifactLease | undefined;
  let child: ProviderChild | undefined;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  // Set when the deadline timer fires: timers can fire slightly before the
  // monotonic clock reaches expiresAt, and either one ends new work.
  let expired = false;
  // An already-aborted signal resolves at once; a later abort resolves it too.
  const deadline = new Promise<void>((resolveDeadline) => {
    timer = setTimeout(() => {
      expired = true;
      resolveDeadline();
    }, timeoutMs);
    onAbort = () => resolveDeadline();
    if (signal?.aborted) resolveDeadline();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  const aborted = () => signal?.aborted === true;
  /** Gates every start of new work; teardown never consults it. */
  const assertActive = () => {
    if (aborted()) throw new Error("provider smoke interrupted");
    if (expired || performance.now() >= expiresAt) throw new Error(`provider smoke deadline exceeded (${timeoutMs} ms) before new work could start`);
  };

  const execute = async (): Promise<void> => {
    scratch = await allocateScratch(options.scratchParent);
    if (aborted()) return;
    await initializeScratch(scratch);
    if (aborted()) return;
    sink = await startSink(probeName);
    const env = childEnvironment(cli, scratch, sink.url);
    if (cli === "codex") {
      await writeFile(join(scratch.cliHome, "config.toml"), [
        `model = "prg-smoke-sink"`,
        `model_provider = "prg_smoke_sink"`,
        `check_for_update_on_startup = false`,
        "",
        "[analytics]",
        "enabled = false",
        "",
        // Offline isolation only: 0.171.0 otherwise syncs its curated plugin
        // marketplace from GitHub at startup. No approval or sandbox setting moves.
        "[features]",
        "plugins = false",
        "",
        "[model_providers.prg_smoke_sink]",
        `name = "pi-review-gate refusing loopback sink"`,
        `base_url = ${JSON.stringify(`${sink.url}/v1`)}`,
        `wire_api = "responses"`,
        `env_key = "PRG_SMOKE_SINK_KEY"`,
        "request_max_retries = 0",
        "stream_max_retries = 0",
        "",
      ].join("\n"), { mode: 0o600 });
    }
    if (aborted()) return;

    broker = await createStatusBroker();
    assertActive();
    registration = broker.registerNativeMcpSource(randomUUID(), cli, endpoint);
    const token = registration.bootstrap.token;
    // Production preparation: default policy, artifact parent, relay entry,
    // and the host's own PSModulePath. The harness's non-interactive flags are
    // outside the interactive argv policy, so the scan sees an empty operator argv.
    const outcome = await prepareNativeMcpLaunch({
      backend: cli,
      bootstrap: registration.bootstrap,
      platform: process.platform,
      scan: scanNativeArgPositions(cli, [], "prg-native-mcp-provider-smoke"),
      env,
      ownedCodexBackend: cli === "codex",
      serverName,
    });
    if (outcome.mcp !== "prepared") {
      report.prep = { outcome: outcome.reason };
      report.problems.push(`production preparation declined: ${outcome.reason}`);
      // Production deliberately preserved entries it could not verify; never delete them here.
      if (outcome.rollback) {
        report.problems.push(`staging rollback left these paths in place: ${JSON.stringify(outcome.rollback.preserved)}; keep the VM offline and discard it`);
      }
      return;
    }
    lease = outcome.lease;
    let definitionEnvKeys: string[] = [];
    if (cli === "claude") {
      const configFile = outcome.args[0]!.slice(`${CLAUDE_MCP_CONFIG_OPTION}=`.length);
      const text = readFileSync(configFile, "utf8");
      if (text.includes(token)) throw new Error("the generated server definition carried the bootstrap token");
      const parsed: unknown = JSON.parse(text);
      const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
      const server = servers[serverName];
      if (Object.keys(servers).length !== 1 || !isRecord(server) || server.type !== "stdio") throw new Error("the generated Claude definition is not exactly one stdio server");
      const definition = relayDefinitionProblem(server.command, server.args, server.env, lease.bootstrapFile);
      if (definition !== undefined) throw new Error(`the generated Claude relay definition differs from production preparation: ${definition}`);
      definitionEnvKeys = isRecord(server.env) ? Object.keys(server.env) : [];
    }
    // Codex: filled from its own effective-config readback before thread/start.
    report.prep = { outcome: "prepared", route: outcome.route, ...(cli === "claude" ? { definitionEnvKeys } : {}) };

    // `--strict-mcp-config` limits Claude to the generated definition; managed
    // policy is still a preflight refusal, not something this flag replaces.
    const args = cli === "claude"
      ? ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--setting-sources", "", "--strict-mcp-config",
        "--allowedTools", probeName, "--model", "claude-sonnet-4-5", "--max-turns", "6", "--no-session-persistence", ...outcome.args]
      : [...outcome.args, "app-server"];
    if (JSON.stringify([args, env]).includes(token)) throw new Error("the provider argv or environment carried the bootstrap token");
    if (aborted()) return;
    assertActive();
    child = new ProviderChild(bin, args, env, scratch.workspace, token);
    if (cli === "claude") await runClaude(child, serverName, probeName, deadline, report, sink);
    else await runCodex(child, { serverName, userConfig: join(scratch.cliHome, "config.toml"), sinkBase: `${sink.url}/v1`, bootstrapFile: lease.bootstrapFile }, scratch.workspace, deadline, report, assertActive);
    if (child.tainted) report.problems.push("provider output carried the bootstrap token and was withheld");
    // A run that only completed after the deadline is not accepted.
    if (!aborted()) assertActive();
  };

  try {
    await execute();
  } catch (error) {
    report.problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    if (child) {
      const markers = [scratch?.root, lease?.root].filter((marker): marker is string => typeof marker === "string");
      const settlement = await child.settle(markers, true);
      report.cleanup.providerSettled = settlement.settled;
      report.cleanup.settlement = settlement.detail;
      if (!settlement.settled) report.problems.push(`provider settlement unconfirmed: ${settlement.detail}; keep the VM offline and discard it`);
    }
    if (lease) {
      report.relay.bootstrapConsumed = !existsSync(lease.bootstrapFile);
      if (IS_WINDOWS) report.relay.claimLeft = existsSync(windowsNativeMcpClaimPath(lease.bootstrapFile));
      const live = registration?.liveConnection;
      const closed = await waitForPromiseBounded((async () => {
        while (live?.() !== undefined) await sleep(50);
      })(), TEARDOWN_MS);
      report.relay.laneClosed = closed.kind === "fulfilled";
    }
    registration?.release();
    report.relay.endpointListCalls = endpoint.listCalls;
    report.relay.endpointCalls = endpoint.calls.length;
    report.relay.probeNote = endpoint.calls[0]?.note;
    // Nothing is removed under a provider tree or relay whose settlement is unconfirmed.
    const safeToClean = report.cleanup.providerSettled && report.relay.laneClosed !== false;
    if (lease && safeToClean) {
      try {
        const cleanup = await lease.cleanup();
        report.cleanup.lease = { removed: cleanup.removed.length, absent: cleanup.absent.length, preserved: cleanup.preserved.length };
        if (cleanup.preserved.length > 0) report.problems.push(`lease cleanup preserved entries under ${lease.root}`);
      } catch {
        report.problems.push(`lease cleanup failed; left in place: ${lease.root}`);
      }
    } else if (lease) {
      report.problems.push(`lease left in place: ${lease.root}`);
    }
    if (broker) report.cleanup.brokerDisposed = (await waitForPromiseBounded(broker.dispose(), TEARDOWN_MS)).kind === "fulfilled";
    if (sink) {
      report.isolation = sink.isolation;
      await sink.close();
    }
    if (scratch && safeToClean) {
      try {
        await rm(scratch.root, { recursive: true, force: true, maxRetries: 3 });
        report.cleanup.scratchRemoved = !existsSync(scratch.root);
      } catch (error) {
        report.problems.push(`scratch cleanup failed: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}`);
      }
    }
    if (scratch && !report.cleanup.scratchRemoved) report.problems.push(`scratch left in place: ${scratch.root}`);
  }
  if (aborted()) report.interrupted = typeof signal?.reason === "string" ? signal.reason : "aborted";
  const check = (ok: boolean, message: string) => { if (!ok) report.problems.push(message); };
  if (!report.interrupted && report.prerequisite.length === 0 && report.prep?.outcome === "prepared") {
    check(report.relay.endpointListCalls >= 1, "the endpoint never served tools/list through the relay");
    check(report.relay.endpointCalls === 1 && report.relay.probeNote === "harmless", `the endpoint recorded ${report.relay.endpointCalls} probe call(s), expected exactly one`);
    check(report.relay.bootstrapConsumed === true, "the relay did not consume its one-shot bootstrap");
    check(report.relay.claimLeft !== true, "a Windows bootstrap claim was left behind");
    check(report.relay.laneClosed === true, "the broker did not observe the relay lane close");
    check(IS_WINDOWS ? JSON.stringify(report.prep.definitionEnvKeys) === JSON.stringify(["PSModulePath"]) : report.prep.definitionEnvKeys?.length === 0,
      "the generated definition's environment is not the expected trusted PSModulePath-only (Windows) or empty (POSIX) set");
    check(report.isolation.egressHosts.length === 0, `non-loopback egress was attempted and refused: ${report.isolation.egressHosts.join(", ")}`);
    check(report.isolation.unauthorized === 0, "a request reached the sink without the synthetic key");
    check(report.isolation.codexModelRequests === 0, "codex made a model request");
    const leaseCleanup = report.cleanup.lease;
    check(leaseCleanup !== undefined && leaseCleanup.preserved === 0 && leaseCleanup.absent === 1, "lease cleanup preserved an entry or did not report the consumed bootstrap absent");
    check(report.cleanup.brokerDisposed, "broker disposal did not settle");
  }
  report.passed = !report.interrupted && report.prerequisite.length === 0 && report.problems.length === 0;
  if (!report.passed && child && !child.tainted && child.stderr.trim()) diagnostics?.(child.stderr);
  return report;
}

// ---------------------------------------------------------------- CLI

function usage(): string {
  return "usage: node dist-test/tests/native-mcp-windows-provider-smoke.js --cli claude|codex --disposable-host [--cli-bin <path>] [--timeout-ms <n>] [--scratch-parent <dir>] [--json] [--diagnostics]";
}

async function main(argv: string[]): Promise<number> {
  const options: Partial<ProviderSmokeOptions> & { attested: boolean } = { attested: false };
  let json = false;
  let showDiagnostics = false;
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
      if (!Number.isInteger(parsed) || parsed < 10_000 || parsed > 600_000) throw new Error("--timeout-ms must be 10000..600000");
      options.timeoutMs = parsed;
    } else if (arg === "--scratch-parent") options.scratchParent = value();
    else if (arg === "--disposable-host") options.attested = true;
    else if (arg === "--json") json = true;
    else if (arg === "--diagnostics") showDiagnostics = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      return 0;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.cli) throw new Error("--cli is required");
  const controller = new AbortController();
  const onSignal = (name: NodeJS.Signals) => { if (!controller.signal.aborted) controller.abort(name); };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  let report: ProviderSmokeReport;
  try {
    report = await runNativeMcpProviderSmoke({ ...(options as ProviderSmokeOptions), signal: controller.signal }, (stderr) => {
      if (!showDiagnostics) return;
      const tail = stderr.split(/\r?\n/u).filter((line) => line.trim()).slice(-20).map((line) => line.slice(0, 400));
      process.stdout.write(`local diagnostics (unsanitized CLI stderr tail, do not share):\n${tail.map((line) => `  | ${line}`).join("\n")}\n`);
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const out = (line: string) => process.stdout.write(`${line}\n`);
  out(`native MCP provider smoke: ${report.cli} ${report.cliVersion ?? "unknown"} on ${report.platform}${report.windowsEvidence ? "" : " (rehearsal; NOT Windows evidence)"}`);
  out("  tier: provider CLI/app-server acceptance of the production-generated definition via the real relay and broker; not a sidebar/callback, interactive TUI, or owned-backend test");
  out(`  prep: ${report.prep?.outcome ?? "not reached"} route=${report.prep?.route ?? "-"} definitionEnv=[${report.prep?.definitionEnvKeys?.join(",") ?? ""}] hostLaneWindows=${report.hostLaneWindows}`);
  out(`  provider: ${JSON.stringify(report.provider)}`);
  out(`  relay: endpointListCalls=${report.relay.endpointListCalls} endpointCalls=${report.relay.endpointCalls} bootstrapConsumed=${String(report.relay.bootstrapConsumed)} laneClosed=${String(report.relay.laneClosed)}${report.windowsEvidence ? ` claimLeft=${String(report.relay.claimLeft)}` : ""}`);
  out(`  isolation: modelRequests=${report.isolation.modelRequests} sideRequests=${report.isolation.sideRequests} codexModelRequests=${report.isolation.codexModelRequests} unauthorized=${report.isolation.unauthorized} egressRefused=${report.isolation.egressHosts.length}`);
  out(`  cleanup: providerSettled=${String(report.cleanup.providerSettled)} (${report.cleanup.settlement}) lease=${JSON.stringify(report.cleanup.lease ?? null)} brokerDisposed=${String(report.cleanup.brokerDisposed)} scratchRemoved=${String(report.cleanup.scratchRemoved)}`);
  for (const line of report.prerequisite) out(`prerequisite: ${line}`);
  for (const line of report.problems) out(`problem: ${line}`);
  if (report.interrupted) {
    out(`native MCP provider smoke (${report.cli}): INTERRUPTED by ${report.interrupted}`);
    return report.interrupted === "SIGINT" ? 130 : report.interrupted === "SIGTERM" ? 143 : 1;
  }
  out(`native MCP provider smoke (${report.cli}): ${report.passed ? "PASS" : report.prerequisite.length > 0 ? "PREREQUISITE" : "FAIL"}`);
  return report.passed ? 0 : report.prerequisite.length > 0 ? 2 : 1;
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
