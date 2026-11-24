/**
 * #682 real Windows native MCP broker-to-relay bootstrap acceptance.
 *
 * What this proves on an actual Windows host, with no seam on the protection,
 * transport, or relay path:
 *
 *   - launch preparation stages the one-shot bootstrap through the PRODUCTION
 *     Windows permission policy (the existing trusted DACL helper, real NTFS
 *     ACLs), under an owned fixture directory that the same policy protected;
 *   - the generated Claude server definition's exact command and argv start the
 *     genuine compiled relay as a real Node subprocess speaking MCP over its own
 *     stdio;
 *   - that relay repeats the production proof chain, consumes the bootstrap
 *     exactly once, dials the existing broker's real authenticated local named
 *     pipe, and serves authenticated tool discovery plus one harmless call that
 *     only a test endpoint records;
 *   - the same argv replayed afterwards is refused before any dial, a bootstrap
 *     whose file the policy cannot prove private is refused unread, and owned
 *     lease cleanup leaves nothing behind.
 *
 * Scope, stated honestly: this is direct relay acceptance of the shared
 * transport. No provider CLI, model, interactive Claude or Codex session, live
 * configuration, approval, host lane, or callback is involved. The owning host
 * lane's Windows gate is a separate candidate (asserted below only as a fact);
 * nothing here arms it, and passing here is not provider-launch evidence. The portable policy-seam simulations
 * stay in ./session-host-native-mcp-windows-bootstrap.test.ts. A non-Windows
 * run skips with its reason and is never Windows evidence.
 *
 * Secret hygiene: the token lives only in the broker, the protected bootstrap
 * file, and the relay's hello. It is never placed in argv or the child
 * environment (both are asserted), never read back into an assertion message,
 * and never logged; diagnostics carry only fixed policy reasons and paths.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

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
import { encodeNativeMcpBootstrap, isNativeMcpLocalPipeAddress } from "../src/session-host/native-mcp-protocol";
import {
  NATIVE_MCP_RELAY_BOOTSTRAP_FLAG,
  proveWindowsNativeMcpAncestry,
  windowsNativeMcpClaimPath,
  type NativeMcpRelayStartupFailure,
} from "../src/session-host/native-mcp-relay";
import type {
  NativeMcpCallToolRequest,
  NativeMcpCallToolResult,
  NativeMcpListToolsRequest,
  NativeMcpStdioCloseReason,
  NativeMcpToolDescriptor,
  NativeMcpToolEndpoint,
} from "../src/session-host/native-mcp-stdio";
import type { PeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permission-policy";
import { createPeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permissions";
import { peerStorageRefusalDetail } from "../src/session-host/network/peer-storage-diagnostics";

type Json = Record<string, any>;

const IS_WINDOWS = process.platform === "win32";
/** Whole-test budget: every production proof runs the fixed system PowerShell (15 s cap each). */
const TEST_TIMEOUT_MS = 5 * 60_000;
/** The relay walks the whole ancestry through the real helper before it may dial. */
const RELAY_STARTUP_DEADLINE_MS = 2 * 60_000;
/** Bound for one MCP reply once the relay is serving, and for each owned exit. */
const REPLY_DEADLINE_MS = 30_000;
const EXIT_DEADLINE_MS = 30_000;
const BROKER_DISPOSE_DEADLINE_MS = 15_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;

const native = {
  skip: IS_WINDOWS
    ? false
    : "real Windows ACL, named-pipe, and subprocess relay acceptance requires a Windows host; a POSIX skip is not Windows evidence",
  timeout: TEST_TIMEOUT_MS,
};

/** A harmless test-only tool: the endpoint records the call and runs nothing. */
const TOOLS: NativeMcpToolDescriptor[] = [{
  name: "PrgNativeRelayProbe",
  description: "test-only probe; records the call and runs nothing",
  inputSchema: { type: "object", properties: { note: { type: "string" } } },
}];

class RecordingEndpoint implements NativeMcpToolEndpoint {
  listCalls = 0;
  readonly calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  async listTools(_request: NativeMcpListToolsRequest): Promise<readonly NativeMcpToolDescriptor[]> {
    this.listCalls += 1;
    return TOOLS;
  }

  async callTool(request: NativeMcpCallToolRequest): Promise<NativeMcpCallToolResult | undefined> {
    this.calls.push({ name: request.name, arguments: request.arguments });
    return { content: [{ type: "text", text: `probe recorded ${request.name}` }], isError: false };
  }
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Resolves on settlement or rejects at the bound; never leaves its timer behind. */
async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Owned relay child: the exact command/argv from the generated definition.

/** Every closed code the relay entry may write to stderr; anything else is withheld. */
const RELAY_CLOSED_CODES: ReadonlySet<string> = new Set<NativeMcpRelayStartupFailure | NativeMcpStdioCloseReason>([
  "worker_role", "usage", "bootstrap_invalid", "unprotected", "unreachable", "refused", "timeout", "protocol", "error",
  "input_error", "input_overflow", "output_closed", "output_error", "output_overflow", "oversized_frame", "invalid_encoding",
  "response_unsendable",
]);
const WITHHELD = "relay output withheld: it carried a bootstrap token";

/**
 * Parses one JSON text only after screening it twice: the raw text, and the
 * decoded value re-serialized, so a token hidden behind JSON escapes is still
 * caught before any assertion can print it. Never echoes the input.
 */
function parseScreenedJson(text: string, secrets: readonly string[], source: string): Json {
  if (secrets.some((secret) => text.includes(secret))) throw new Error(WITHHELD);
  let value: Json;
  try {
    value = JSON.parse(text) as Json;
  } catch {
    throw new Error(`${source} carried a non-JSON line (content withheld)`);
  }
  const decoded = JSON.stringify(value);
  if (secrets.some((secret) => decoded.includes(secret))) throw new Error(WITHHELD);
  return value;
}

/**
 * One owned relay child. Output is screened against the supplied secrets as it
 * arrives: once any secret appears, everything captured is discarded and every
 * accessor throws a fixed message, so no assertion, parse error, or diff can
 * ever print it. Stderr is only ever reported as an allowlisted closed code.
 */
class RelayChild {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  #stdout = "";
  #stderr = "";
  #overflow = false;
  #tainted = false;
  readonly #secrets: readonly string[];

  constructor(command: string, args: readonly string[], env: NodeJS.ProcessEnv, secrets: readonly string[]) {
    this.#secrets = secrets.filter((secret) => secret.length > 0);
    // POSIX: its own process group, so the existing tree teardown reaches every
    // descendant; Windows uses the same helper's taskkill /T.
    this.child = spawn(command, [...args], {
      env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, detached: process.platform !== "win32",
    });
    this.exited = new Promise((resolve) => this.child.once("close", (code, signal) => resolve({ code, signal })));
    // A spawn failure surfaces as `close` with no code; keep it from becoming an unhandled error.
    this.child.on("error", () => undefined);
    this.child.stdin!.on("error", () => undefined);
    this.child.stdout!.setEncoding("utf8");
    this.child.stderr!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => { this.#append("stdout", chunk); });
    this.child.stderr!.on("data", (chunk: string) => { this.#append("stderr", chunk); });
  }

  #append(stream: "stdout" | "stderr", chunk: string): void {
    if (this.#tainted) return;
    const current = stream === "stdout" ? this.#stdout : this.#stderr;
    if (current.length + chunk.length > MAX_CAPTURE_BYTES) {
      this.#overflow = true;
      return;
    }
    const next = current + chunk;
    // The whole accumulated stream is checked, so a secret split across chunks is still caught.
    if (this.#secrets.some((secret) => next.includes(secret))) {
      this.#tainted = true;
      this.#stdout = "";
      this.#stderr = "";
      return;
    }
    if (stream === "stdout") this.#stdout = next;
    else this.#stderr = next;
  }

  #clean(): void {
    if (this.#tainted) throw new Error(WITHHELD);
    if (this.#overflow) throw new Error("relay output exceeded the capture bound (content withheld)");
  }

  get settled(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  /** Screened stdout length; content is only exposed as parsed frames. */
  get stdoutLength(): number {
    this.#clean();
    return this.#stdout.length;
  }

  /**
   * The relay's single closed code, `""` for empty stderr, or a fixed
   * placeholder for anything that is not exactly one allowlisted code line.
   */
  closedCode(): string {
    this.#clean();
    if (this.#stderr.length === 0) return "";
    const match = /^pi-review-gate native MCP relay: ([a-z_]+)\n$/u.exec(this.#stderr);
    return match !== null && RELAY_CLOSED_CODES.has(match[1]!) ? match[1]! : "<unrecognized stderr withheld>";
  }

  /** Complete newline-terminated frames only; a trailing partial line waits for more bytes. */
  frames(): Json[] {
    this.#clean();
    return this.#stdout.split("\n").slice(0, -1).filter((line) => line.length > 0)
      .map((line) => parseScreenedJson(line, this.#secrets, "relay stdout"));
  }

  send(message: Json): void {
    this.child.stdin!.write(`${JSON.stringify(message)}\n`);
  }

  async response(id: number, timeoutMs: number): Promise<Json> {
    await waitFor(() => this.settled || this.frames().some((frame) => frame.id === id), `relay response ${id}`, timeoutMs);
    const frame = this.frames().find((candidate) => candidate.id === id);
    if (frame === undefined) throw new Error(`the relay exited before response ${id} (closed code: ${this.closedCode() || "none"})`);
    return frame;
  }

  /**
   * Bounded teardown that settles the relay AND any production ACL helper it
   * is blocked on. The relay only runs that helper through a synchronous
   * bounded child call, so a relay that exits on its own has already settled
   * it. A relay still running after a short input-end grace is terminated as
   * a tree by the existing owned process-tree mechanism (taskkill /T /F on
   * Windows, the owned process group on POSIX); a tree termination that cannot
   * be confirmed is reported as an error, never assumed.
   */
  async stop(graceMs = 5_000): Promise<void> {
    if (!this.settled) {
      try {
        this.child.stdin!.end();
      } catch {
        // Already closed.
      }
      const graceful = await waitForPromiseBounded(this.exited, graceMs);
      if (graceful.kind !== "fulfilled") {
        const failure = terminateProcessTree(this.child, "SIGKILL");
        // A root that exited on its own between the checks returned from its
        // synchronous helper call first; anything else is unconfirmed.
        if (failure !== undefined && !this.settled) throw new Error(`relay process-tree teardown unconfirmed: ${failure}`);
      }
    }
    const closed = await waitForPromiseBounded(this.exited, EXIT_DEADLINE_MS);
    if (closed.kind !== "fulfilled") throw new Error(`relay did not settle within ${EXIT_DEADLINE_MS}ms after tree teardown`);
  }
}

// ---------------------------------------------------------------------------
// Diagnostics: the production policy's verdict on every ancestry component.

function ancestryOf(directory: string): string[] {
  const out: string[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    out.push(current);
    if (path.dirname(current) === current) break;
  }
  return out.reverse();
}

/** Fixed policy reason only: no helper output, SID, or ACL text. */
function refusalReason(check: () => void): string | undefined {
  try {
    check();
    return undefined;
  } catch (error) {
    return peerStorageRefusalDetail(error)?.reason ?? "undiagnosed refusal";
  }
}

/**
 * Each component from the drive root down, with the unchanged production
 * `assertOwnerControlledDirectory` verdict: `ok` or the policy's fixed reason.
 * A refused component here is product evidence (the staging and reader walk
 * apply exactly this rule), not a test prerequisite to skip around.
 */
function ancestryDiagnostic(directory: string, policy: PeerStatePermissionPolicy): string {
  const verdicts = ancestryOf(directory).map((component) =>
    `${JSON.stringify(component)}=${refusalReason(() => policy.assertOwnerControlledDirectory(component)) ?? "ok"}`);
  const refused = verdicts.some((verdict) => !verdict.endsWith("=ok"));
  return `${refused ? "PRODUCT BLOCKER: the production ancestry rule refused" : "every component passed on re-check"}; ancestry verdicts: ${verdicts.join(", ")}`;
}

/** The explicit, minimal child environment: what the policy's fixed system PowerShell needs, nothing else. */
function relayEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "SystemDrive", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "ComSpec"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }
  return env;
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

// ---------------------------------------------------------------------------

test("real Windows: production ACL staging, the broker's named pipe, and a subprocess relay serve one authenticated list and call, once", native, async () => {
  // Shared transport only. The owning host lane's Windows gate is on as an
  // activation candidate; nothing in this test arms it, and this test is not
  // evidence of a real provider launch through it.
  assert.equal(NATIVE_MANAGED_HOST_LANE_SUPPORTED_PLATFORMS.includes("win32"), true);

  const policy = createPeerStatePermissionPolicy({ platform: "win32" });
  const children: RelayChild[] = [];
  let fixture: string | undefined;
  let broker: NativeMcpStatusBroker | undefined;
  let registration: NativeMcpRegistration | undefined;
  let lease: NativeMcpArtifactLease | undefined;
  let leaseCleaned = false;
  let passed = false;
  const ownedFiles: Array<{ file: string; identity: fs.BigIntStats }> = [];

  try {
    // Owned fixture parent. The runner's temporary root (long-name canonical
    // spelling, so Node and the helper agree) must first pass the production
    // ancestry walk from the drive root down — the same proof staging and the
    // relay repeat — BEFORE anything is created beneath it, so the exclusive
    // creation below cannot be redirected. A refusal here is product evidence
    // (the refused component and fixed reason), never a skip. The fresh child
    // keeps its exclusive-creation path (never re-resolved) and is then given
    // and proven a private DACL by the same policy.
    const base = fs.realpathSync.native(tmpdir());
    if (proveWindowsNativeMcpAncestry(base, policy) !== "proven") {
      assert.fail(`production Windows fixture ancestry could not be proven; ${ancestryDiagnostic(base, policy)}`);
    }
    fixture = fs.mkdtempSync(path.join(base, "prg-mcp-native-"));
    const fixtureRefusal = refusalReason(() => policy.protectCreatedDirectory(fixture!));
    if (fixtureRefusal !== undefined) {
      assert.fail(`the production policy could not protect the owned fixture (${fixtureRefusal}); ${ancestryDiagnostic(base, policy)}`);
    }

    // The existing broker on its real, freshly generated local named pipe.
    broker = await createStatusBroker();
    assert.equal(isNativeMcpLocalPipeAddress(broker.socketPath), true, "the Windows broker owns a generated local named pipe");
    const endpoint = new RecordingEndpoint();
    registration = broker.registerNativeMcpSource(randomUUID(), "claude", endpoint);
    const token = registration.bootstrap.token;
    assert.equal(registration.bootstrap.socketPath, broker.socketPath, "the bootstrap names the broker's own pipe");

    // Production staging: the default Windows policy and relay entry points.
    const minimalRelayEnv = relayEnvironment();
    const serverName = `${NATIVE_MCP_SERVER_NAME_PREFIX}${randomBytes(16).toString("hex")}`;
    const outcome = await prepareNativeMcpLaunch({
      backend: "claude",
      bootstrap: registration.bootstrap,
      platform: "win32",
      scan: scanNativeArgPositions("claude", [], "synthetic-target"),
      env: minimalRelayEnv,
      ownedCodexBackend: false,
      serverName,
      artifactParent: fixture,
    });
    if (outcome.mcp !== "prepared") {
      const detail = outcome.reason === "artifact-path-unprotected" ? `; ${ancestryDiagnostic(fixture, policy)}` : "";
      assert.fail(`production Windows staging was declined (${outcome.reason}${outcome.rollback === undefined ? "" : ", rollback preserved entries"})${detail}`);
    }
    lease = outcome.lease;
    const { root, bootstrapFile } = lease;
    assert.equal(JSON.stringify([root, bootstrapFile, outcome.args, minimalRelayEnv]).includes(token), false,
      "staged paths, launch arguments, and the child environment must not carry the token");
    assert.equal(path.dirname(root), fixture);
    assert.equal(path.dirname(bootstrapFile), root);
    assert.equal(refusalReason(() => policy.assertPrivateDirectory(root)), undefined, "the staged root carries a proven private DACL");
    assert.equal(refusalReason(() => policy.assertPrivateFile(bootstrapFile)), undefined, "the staged bootstrap carries a proven private DACL");

    // The generated Claude definition: exactly one stdio server whose command
    // and argv carry the bootstrap path, never the token.
    assert.equal(outcome.args.length, 1);
    const configPrefix = `${CLAUDE_MCP_CONFIG_OPTION}=`;
    assert.ok(outcome.args[0]!.startsWith(configPrefix));
    const configFile = outcome.args[0]!.slice(configPrefix.length);
    assert.equal(path.dirname(configFile), root);
    const configText = fs.readFileSync(configFile, "utf8");
    // Screened raw and decoded: the server definition never carries the token.
    const config = parseScreenedJson(configText, [token], "the server definition");
    assert.deepEqual(Object.keys(config.mcpServers), [serverName]);
    const server = config.mcpServers[serverName] as Json;
    const expectedPath = process.env.PSModulePath;
    assert.ok(expectedPath, "Windows acceptance needs an inherited PowerShell module path");
    assert.deepEqual(Object.keys(server).sort(), ["args", "command", "env", "type"]);
    assert.ok(server.env && Object.keys(server.env).length === 1 && server.env.PSModulePath === expectedPath,
      "only the inherited module path is passed to the relay");
    const childEnv = { ...minimalRelayEnv, PSModulePath: server.env.PSModulePath as string };
    assert.equal(server.type, "stdio");
    const command = server.command as string;
    const args = server.args as string[];
    assert.equal(command, process.execPath, "the definition runs this Node host");
    assert.equal(args.length, 3);
    assert.deepEqual(args.slice(1), [NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, bootstrapFile]);
    assert.ok(fs.statSync(args[0]!).isFile(), "the compiled relay entry exists");
    assert.equal(JSON.stringify([command, args, childEnv]).includes(token), false, "the token is in neither argv nor the child environment");

    // The genuine relay subprocess, started exactly as the definition says.
    const relay = new RelayChild(command, args, childEnv, [token]);
    children.push(relay);
    relay.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "prg-native-relay-acceptance", version: "1" } } });
    const initialized = await relay.response(0, RELAY_STARTUP_DEADLINE_MS);
    assert.equal(initialized.result?.serverInfo?.name, "pi-review-gate");
    relay.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // Consumed exactly once, before the lane could authenticate; no claim left.
    assert.equal(fs.existsSync(bootstrapFile), false, "the relay consumed its bootstrap");
    assert.equal(fs.existsSync(windowsNativeMcpClaimPath(bootstrapFile)), false, "the winning claim was removed");
    const connection = registration.liveConnection?.();
    assert.ok(connection !== undefined, "the broker holds exactly this registration's authenticated pipe connection");

    relay.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.deepEqual((await relay.response(1, REPLY_DEADLINE_MS)).result, { tools: TOOLS });
    relay.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "PrgNativeRelayProbe", arguments: { note: "harmless" } } });
    assert.deepEqual((await relay.response(2, REPLY_DEADLINE_MS)).result,
      { content: [{ type: "text", text: "probe recorded PrgNativeRelayProbe" }], isError: false });
    assert.equal(endpoint.listCalls, 1);
    assert.deepEqual(endpoint.calls, [{ name: "PrgNativeRelayProbe", arguments: { note: "harmless" } }]);
    assert.equal(registration.liveConnection?.(), connection, "one authenticated connection spanned discovery and the call");

    // Clean, bounded settlement: input end closes the lane and exits zero.
    relay.child.stdin!.end();
    const ended = await bounded(relay.exited, EXIT_DEADLINE_MS, "relay exit after input end");
    // closedCode() and frames() throw a fixed message if any output carried the token.
    const endedCode = relay.closedCode();
    assert.deepEqual(ended, { code: 0, signal: null }, `the relay exits cleanly (closed code: ${endedCode || "none"})`);
    assert.equal(endedCode, "");
    assert.ok(relay.frames().every((frame) => frame.jsonrpc === "2.0"), "stdout carries MCP messages only");
    await waitFor(() => registration!.liveConnection?.() === undefined, "the broker to observe the lane close", REPLY_DEADLINE_MS);

    // Replay: the same argv again finds nothing to consume and never dials.
    const replay = new RelayChild(command, args, childEnv, [token]);
    children.push(replay);
    replay.child.stdin!.end();
    const replayed = await bounded(replay.exited, RELAY_STARTUP_DEADLINE_MS, "replayed relay exit");
    assert.equal(replay.closedCode(), "bootstrap_invalid");
    assert.deepEqual(replayed, { code: 1, signal: null });
    assert.equal(replay.stdoutLength, 0, "a refused relay writes nothing to stdout");
    assert.equal(registration.liveConnection?.(), undefined, "no second connection was admitted");
    assert.equal(endpoint.listCalls, 1);
    assert.equal(endpoint.calls.length, 1);

    // An unprotected bootstrap: a valid record in an ordinary file whose DACL
    // the production policy cannot prove private (inherited, not protected).
    // Its token is a fresh unregistered value, never the broker's.
    const unprotected = path.join(root, "unprotected-bootstrap.json");
    const decoyToken = randomBytes(32).toString("hex");
    const decoy = encodeNativeMcpBootstrap({ ...registration.bootstrap, token: decoyToken });
    fs.writeFileSync(unprotected, decoy, { flag: "wx" });
    ownedFiles.push({ file: unprotected, identity: fs.lstatSync(unprotected, { bigint: true }) });
    const fileRefusal = refusalReason(() => policy.assertPrivateFile(unprotected));
    // Exactly the inherited-DACL verdict: an access, helper, or undiagnosed
    // failure never satisfies this negative case.
    assert.equal(fileRefusal, "unsafe-permissions", "the production policy refuses the decoy's unprotected DACL");
    const refused = new RelayChild(command, [args[0]!, NATIVE_MCP_RELAY_BOOTSTRAP_FLAG, unprotected], childEnv, [token, decoyToken]);
    children.push(refused);
    refused.child.stdin!.end();
    const refusedExit = await bounded(refused.exited, RELAY_STARTUP_DEADLINE_MS, "unprotected-bootstrap relay exit");
    assert.equal(refused.closedCode(), "bootstrap_invalid");
    assert.deepEqual(refusedExit, { code: 1, signal: null });
    assert.equal(refused.stdoutLength, 0, "a refused relay writes nothing to stdout");
    assert.ok(fs.readFileSync(unprotected, "utf8") === decoy, "refused unread: left in place, unconsumed");
    assert.equal(fs.existsSync(windowsNativeMcpClaimPath(unprotected)), false, "no claim was attempted");
    assert.equal(registration.liveConnection?.(), undefined);
    assert.equal(endpoint.calls.length, 1);
    const owned = ownedFiles.at(-1)!;
    assert.ok(sameIdentity(owned.identity, fs.lstatSync(owned.file, { bigint: true })));
    fs.unlinkSync(owned.file);
    ownedFiles.pop();

    // Owned lease cleanup: exactly the recorded entries, the consumed
    // bootstrap reported absent, nothing preserved.
    const cleanup = await lease.cleanup();
    leaseCleaned = true;
    assert.deepEqual(cleanup.absent, [bootstrapFile]);
    assert.deepEqual(cleanup.preserved, []);
    assert.deepEqual([...cleanup.removed].sort(), [configFile, root].sort());
    assert.equal(fs.existsSync(root), false);
    assert.deepEqual(fs.readdirSync(fixture), []);
    passed = true;
  } finally {
    // Bounded teardown of everything this test owns, whatever the outcome.
    const errors: unknown[] = [];
    let unsettledChild = false;
    for (const relay of children) {
      try {
        await relay.stop();
      } catch (error) {
        unsettledChild = true;
        errors.push(error);
      }
    }
    // Revoke the broker registration whatever happened to the children.
    registration?.release();
    if (broker !== undefined) {
      try {
        await bounded(broker.dispose(), BROKER_DISPOSE_DEADLINE_MS, "broker disposal");
      } catch (error) {
        errors.push(error);
      }
    }
    if (fixture !== undefined && unsettledChild) {
      // No file is touched under a relay tree whose settlement is unconfirmed:
      // not the decoy, not the lease (bootstrap, claim, root), not the fixture.
      errors.push(new Error(`the owned fixture and its contents were left in place for an unsettled relay tree: ${fixture}`));
    } else if (fixture !== undefined) {
      // Every child settled: remove exactly what this test owns, innermost first.
      for (const { file, identity } of ownedFiles) {
        try {
          const stats = fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
          if (stats !== undefined && sameIdentity(identity, stats)) fs.unlinkSync(file);
        } catch (error) {
          errors.push(error);
        }
      }
      if (lease !== undefined && !leaseCleaned) {
        try {
          const cleanup = await lease.cleanup();
          if (cleanup.preserved.length > 0) errors.push(new Error(`lease cleanup preserved ${cleanup.preserved.length} unverifiable entries`));
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        // Nonrecursive: anything the lease deliberately preserved stays and is reported.
        fs.rmdirSync(fixture);
      } catch (error) {
        errors.push(new Error(`the owned fixture could not be removed nonrecursively (${(error as NodeJS.ErrnoException).code ?? "unknown"}): ${fixture}`));
      }
    }
    if (errors.length > 0) {
      const summary = `native MCP relay acceptance teardown: ${errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ")}`;
      // Never hide an earlier assertion; never let an unsettled teardown pass.
      if (passed) throw new Error(summary);
      process.emitWarning(summary);
    }
  }
});

// ---------------------------------------------------------------------------
// Portable checks of the owned child wrapper above. They run on every host
// (on Windows the forced path is the real taskkill /T) and prove nothing about
// the relay, the broker, or Windows ACLs.

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

test("portable: the relay child wrapper withholds secret-bearing output and reports only allowlisted closed codes", { timeout: 60_000 }, async () => {
  const secret = randomBytes(32).toString("hex");
  // The secret reaches the stand-in through stdin, never argv or env, and is
  // written back split across two writes.
  const echo = new RelayChild(process.execPath, ["-e", `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const value = input.trim();
      process.stdout.write('{"jsonrpc":"2.0","id":0,"result":"' + value.slice(0, 7));
      setTimeout(() => { process.stdout.write(value.slice(7) + '"}\\n'); process.stderr.write("x " + value + "\\n"); }, 50);
    });
  `], { PATH: process.env.PATH ?? "" }, [secret]);
  try {
    echo.child.stdin!.end(`${secret}\n`);
    await bounded(echo.exited, 30_000, "echo stand-in exit");
    for (const read of [() => echo.frames(), () => echo.closedCode(), () => echo.stdoutLength]) {
      assert.throws(read, (error: unknown) => error instanceof Error && error.message === WITHHELD && !error.message.includes(secret));
    }
  } finally {
    await echo.stop();
  }

  // The same secret hidden behind JSON Unicode escapes: invisible in the raw
  // stream, caught once decoded, and never returned or printed.
  const escaped = new RelayChild(process.execPath, ["-e", `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const hidden = [...input.trim()].map((c) => "\\\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
      process.stdout.write('{"jsonrpc":"2.0","id":0,"result":{"text":"' + hidden + '"}}\\n');
    });
  `], { PATH: process.env.PATH ?? "" }, [secret]);
  try {
    escaped.child.stdin!.end(`${secret}\n`);
    await bounded(escaped.exited, 30_000, "escaped stand-in exit");
    assert.ok(escaped.stdoutLength > 0, "the raw stream itself did not contain the secret");
    assert.throws(() => escaped.frames(), (error: unknown) => error instanceof Error && error.message === WITHHELD && !error.message.includes(secret));
    assert.throws(() => parseScreenedJson(`{"t":"\\u${secret.charCodeAt(0).toString(16).padStart(4, "0")}${secret.slice(1)}"}`, [secret], "a definition"),
      (error: unknown) => error instanceof Error && error.message === WITHHELD);
  } finally {
    await escaped.stop();
  }

  const coded = new RelayChild(process.execPath, ["-e", `
    process.stderr.write(process.argv[1] === "known" ? "pi-review-gate native MCP relay: bootstrap_invalid\\n" : "free text\\n");
    process.stdout.write("not json\\n");
  `, "known"], { PATH: process.env.PATH ?? "" }, [secret]);
  const unknown = new RelayChild(process.execPath, ["-e", `process.stderr.write("pi-review-gate native MCP relay: made_up\\n");`],
    { PATH: process.env.PATH ?? "" }, [secret]);
  try {
    await bounded(Promise.all([coded.exited, unknown.exited]), 30_000, "coded stand-in exits");
    assert.equal(coded.closedCode(), "bootstrap_invalid");
    assert.throws(() => coded.frames(), /non-JSON line \(content withheld\)/u);
    assert.equal(unknown.closedCode(), "<unrecognized stderr withheld>");
  } finally {
    await coded.stop();
    await unknown.stop();
  }
});

test("portable: relay child teardown settles a graceful exit, and terminates a child blocked in a synchronous helper as a tree", { timeout: 120_000 }, async () => {
  // Graceful: input end lets the child exit on its own; no tree termination.
  const graceful = new RelayChild(process.execPath, ["-e", `process.stdin.resume(); process.stdin.on("end", () => process.exit(0));`],
    { PATH: process.env.PATH ?? "" }, []);
  await graceful.stop(10_000);
  assert.deepEqual(await graceful.exited, { code: 0, signal: null });

  // Forced: the stand-in blocks in spawnSync on a long-lived grandchild, the
  // same shape as a relay blocked on the production ACL helper. Its stdin end
  // is never observed, so only the owned tree teardown can settle both.
  const scratch = fs.mkdtempSync(path.join(tmpdir(), "prg-relay-tree-"));
  const pidFile = path.join(scratch, "grandchild.pid");
  let grandchild: number | undefined;
  const blocked = new RelayChild(process.execPath, ["-e", `
    const { spawnSync } = require("node:child_process");
    spawnSync(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);", process.argv[1]],
      { stdio: "ignore", timeout: 110000, windowsHide: true });
  `, pidFile], { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, []);
  const recordedPid = (): number | undefined => {
    const text = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : "";
    const pid = Number(text);
    return text.length > 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  };
  try {
    await waitFor(() => recordedPid() !== undefined, "the blocked grandchild to start", 30_000);
    grandchild = recordedPid()!;
    assert.equal(processAlive(grandchild), true);
  } finally {
    // The one bounded tree stop, on success and on startup failure alike. Only
    // after the stop is confirmed AND every recorded grandchild is observed
    // gone is anything removed; otherwise the fixture stays and is reported.
    try {
      await blocked.stop(grandchild === undefined ? 0 : 200);
      // A grandchild that recorded itself after the startup wait still counts.
      grandchild ??= recordedPid();
      if (grandchild !== undefined) {
        await waitFor(() => !processAlive(grandchild!), "the blocked helper stand-in to be terminated with its tree", 15_000);
      }
    } catch (cause) {
      throw new Error(`relay tree settlement unconfirmed; fixture left in place: ${scratch}`, { cause });
    }
    fs.rmSync(pidFile, { force: true });
    fs.rmdirSync(scratch);
  }
  assert.equal(blocked.settled, true, "the blocked relay stand-in settled");
});
