import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import {
  createNativeCliLauncher,
} from "../src/session-host/native-cli-launch";
import {
  InstanceManager,
  createDefaultPtyFactory,
  type InstancePty,
  type InstanceSpawnDescriptor,
  type InstanceStatusHandlers,
  type InstanceStatusRegistration,
  type NativeInstanceView,
  type StatusRegistrar,
} from "../src/session-host/instances";
import {
  NODE_OPTIONS_RESTORE_ENV,
  SESSION_HOST_BOOTSTRAP_ENV,
} from "../src/session-host/launch";
import { SESSION_HOST_STARTUP_REQUEST_ENV, SESSION_HOST_TITLE_COLUMNS_ENV } from "../src/session-host/startup-request";
import { sessionBackendDisplayLabel } from "../src/session-host/session-backend";
import type { TerminalSurface } from "../src/session-host/terminal-surface";

/**
 * REAL pinned `@lydell/node-pty` coverage for the native interactive CLI launch
 * path (issue #277 runtime-validation slice).
 *
 * What is wired together here is the PRODUCTION pair with no substitute in
 * between: `createNativeCliLauncher` (the shared application-command resolver,
 * argv composition, and environment sanitizer) feeds `InstanceManager`'s
 * `nativeCliLaunch` provider, and the manager spawns the returned descriptor
 * through its DEFAULT PTY factory — the pinned real `@lydell/node-pty`. Every
 * child is an OS process this file created, in a directory this file created,
 * under a fixture HOME/agent directory this file created, and every child
 * reports its own pid, tty state, geometry, argv, and environment back through
 * its own terminal, so input, resize, prompt answers, signals, and exits are
 * observed from the real child rather than from a double.
 *
 * EVIDENCE SCOPE — read before drawing any conclusion:
 * - Every child is a SYNTHETIC Node program with a synthetic question. It is
 *   NOT Claude Code and NOT the Codex CLI. Nothing here proves a real provider
 *   TUI's rendering, prompts, key handling, or telemetry, and nothing here
 *   reads or writes any provider's real configuration, credentials, keychain,
 *   clipboard, or conversations.
 * - The Pi rows run an inert synthetic Pi shim, so this is not real-Pi,
 *   reporter/protocol, broker-socket, or preload behavior either; it proves the
 *   Pi launch path and the native CLI path coexist in one manager without
 *   sharing a PTY, a registration, or a byte of input.
 * - POSIX only. Windows real ConPTY launching is NOT exercised here and stays a
 *   reported gap; the descriptor-level Windows cases live in the launch-adapter
 *   suite.
 *
 * Resource ownership: every spawned handle is recorded, and the harness refuses
 * to delete its fixture tree until every handle has an observed exit event of
 * its own. A failed case retains its fixture directory under the system temp
 * directory (never inside the repository) and prints the path.
 */

const HOST_TOKEN_KEYS = [
  SESSION_HOST_BOOTSTRAP_ENV,
  SESSION_HOST_STARTUP_REQUEST_ENV,
  SESSION_HOST_TITLE_COLUMNS_ENV,
  NODE_OPTIONS_RESTORE_ENV,
] as const;

/** True only when the pinned native addon loads on a POSIX host this file can own. */
const realPtyAvailable = ((): boolean => {
  if (process.platform !== "darwin" && process.platform !== "linux") return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    require("@lydell/node-pty");
    return true;
  } catch {
    return false;
  }
})();

const REAL_PTY_SKIP = realPtyAvailable
  ? false
  : "the pinned @lydell/node-pty addon or a POSIX host is unavailable; Windows ConPTY launching is not exercised by this file";

/** The synthetic interactive CLI every native row here runs. Never a provider binary. */
const SYNTHETIC_CLI_SOURCE = `
"use strict";
const path = require("node:path");
const tag = process.env.PRG_SYNTH_TAG || path.basename(process.argv[1] || "child");
const say = (line) => { try { process.stdout.write(line + "\\r\\n"); } catch (error) { void error; } };
say("HELLO tag=" + tag + " pid=" + process.pid + " tty=" + (process.stdout.isTTY ? 1 : 0)
  + " geo=" + process.stdout.columns + "x" + process.stdout.rows);
say("ARGV " + JSON.stringify(process.argv.slice(1)));
say("ENV cwd=" + path.basename(process.cwd())
  + " HOME=" + (process.env.HOME || "-")
  + " CODEX_HOME=" + (process.env.CODEX_HOME || "-")
  + " CLAUDE_CONFIG_DIR=" + (process.env.CLAUDE_CONFIG_DIR || "-")
  + " PROBE=" + (process.env.PRG_SYNTH_PROBE || "-")
  + " INHERITED=" + (process.env.PRG_SYNTH_INHERITED || "-")
  + " NODEOPT=" + (process.env.NODE_OPTIONS === undefined ? "-" : process.env.NODE_OPTIONS)
  + " BOOT=" + (process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ? "present" : "absent")
  + " ROLE=" + (process.env.PI_REVIEW_GATE_RUNTIME_ROLE || "-"));
process.stdout.on("resize", () => say("RESIZE " + process.stdout.columns + "x" + process.stdout.rows));
say("QUESTION " + tag + ": type YES to confirm");
if (process.env.PRG_SYNTH_IGNORE_TERM === "1") {
  process.on("SIGTERM", () => say("IGNORED-TERM " + tag));
} else {
  process.on("SIGTERM", () => { say("SIGTERM " + tag); setTimeout(() => process.exit(0), 120).unref(); });
}
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let index;
  while ((index = pending.search(/[\\r\\n]/)) >= 0) {
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    if (line.length > 0) say("GOT " + tag + " " + JSON.stringify(line));
    if (line === "YES") say("CONFIRMED " + tag);
    if (line === "BYE") { say("FAREWELL " + tag); setTimeout(() => process.exit(0), 80).unref(); }
  }
});
`;

/** The inert synthetic Pi child used only to prove the unchanged Pi path coexists. */
const SYNTHETIC_PI_SOURCE = `
"use strict";
const path = require("node:path");
const say = (line) => { try { process.stdout.write(line + "\\r\\n"); } catch (error) { void error; } };
say("PIRUN tag=pi pid=" + process.pid + " tty=" + (process.stdout.isTTY ? 1 : 0)
  + " geo=" + process.stdout.columns + "x" + process.stdout.rows
  + " boot=" + (process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ? "present" : "absent")
  + " cwd=" + path.basename(process.cwd()));
process.stdout.on("resize", () => say("PIRESIZE " + process.stdout.columns + "x" + process.stdout.rows));
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let index;
  while ((index = pending.search(/[\\r\\n]/)) >= 0) {
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    if (line.length > 0) say("PIGOT pi " + JSON.stringify(line));
  }
});
process.on("SIGTERM", () => { say("PIEXIT pi"); setTimeout(() => process.exit(0), 120).unref(); });
`;

function writeExecutable(path: string, bodyPath: string): void {
  writeFileSync(path, `#!${process.execPath}\nrequire(${JSON.stringify(bodyPath)});\n`, "utf8");
  chmodSync(path, 0o755);
}

/** One real owned handle plus the exit event this file witnessed for it. */
interface RealHandle {
  readonly descriptor: InstanceSpawnDescriptor;
  readonly pty: InstancePty;
  readonly pid: number;
  exit?: { exitCode: number; signal?: number };
}

/** A registrar that records every request, so a native row's silence is provable. */
class RecordingRegistrar implements StatusRegistrar {
  readonly requests: { instanceId: string; framing?: boolean }[] = [];
  readonly releases: string[] = [];

  register(
    instanceId: string,
    _handlers: InstanceStatusHandlers,
    options?: { inputOriginFraming?: boolean },
  ): InstanceStatusRegistration {
    this.requests.push({ instanceId, ...(options?.inputOriginFraming === true ? { framing: true } : {}) });
    return {
      bootstrap: {
        version: 1,
        socketPath: join(tmpdir(), `prg-native-cli-pty-unused-${instanceId}.sock`),
        token: randomBytes(32).toString("hex"),
        instanceId,
        generation: randomUUID(),
        ...(options?.inputOriginFraming === true ? { inputOriginFraming: 1 as const } : {}),
      },
      release: () => { this.releases.push(instanceId); },
    };
  }
}

interface HarnessOptions {
  /**
   * Either a fixed configuration, or a factory given the harness's owned
   * fixture root. A factory lets a case stage extra fixture files INSIDE the
   * harness tree, so every fixture file shares one retention/cleanup policy —
   * no case may keep a second directory that outlives (or is deleted despite)
   * the harness's own evidence decision.
   */
  config?: ReviewGateConfig | ((root: string) => ReviewGateConfig);
  framing?: boolean;
  envExtras?: NodeJS.ProcessEnv;
}

interface Harness {
  readonly root: string;
  readonly bin: string;
  readonly workspaceAlpha: string;
  readonly workspaceBeta: string;
  readonly manager: InstanceManager;
  readonly registrar: RecordingRegistrar;
  readonly handles: RealHandle[];
}

/**
 * A real InstanceManager over an owned fixture: the production native CLI
 * launcher for the requested configuration, the manager's DEFAULT (real
 * `@lydell/node-pty`) factory wrapped only to record the exact descriptor and
 * witness each handle's own exit, and a fixture HOME / Pi agent directory / PATH
 * so no user configuration, credential, or live session is reachable.
 */
function makeHarness(label: string, options: HarnessOptions = {}): Harness {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `prg-native-cli-pty-${label}-`)));
  // Resolved against the owned root BEFORE anything else, so a case-supplied
  // fixture file lives in this tree and is retained or removed with it.
  const harnessConfig = typeof options.config === "function" ? options.config(root) : options.config;
  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic gate-extension fixture; never imported or executed.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic reporter fixture; never imported or executed.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// Synthetic inert preload fixture; not the production preload.\n", "utf8");

  const bin = join(root, "bin");
  const synth = join(root, "synth");
  mkdirSync(bin, { recursive: true });
  mkdirSync(synth, { recursive: true });
  const cliBody = join(synth, "synthetic-cli.cjs");
  writeFileSync(cliBody, SYNTHETIC_CLI_SOURCE, "utf8");
  // The default targets are bare names found through the fixture PATH.
  writeExecutable(join(bin, "claude"), cliBody);
  writeExecutable(join(bin, "codex"), cliBody);
  // A configured target found through PATH under a different filename.
  writeExecutable(join(bin, "claude-configured"), cliBody);
  // A `node wrapper.js` prefix target: the wrapper is run BY the resolver's file.
  const wrapper = join(synth, "wrapper.js");
  writeFileSync(wrapper, SYNTHETIC_CLI_SOURCE, "utf8");
  const piExecutable = join(bin, "synthetic-pi");
  writeFileSync(piExecutable, `#!${process.execPath}\n${SYNTHETIC_PI_SOURCE}`, "utf8");
  chmodSync(piExecutable, 0o755);

  const home = join(root, "home");
  const agentDir = join(root, "pi-agent");
  const workspaceAlpha = join(root, "workspace-alpha");
  const workspaceBeta = join(root, "workspace-beta");
  for (const directory of [home, agentDir, workspaceAlpha, workspaceBeta]) mkdirSync(directory, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    // Only this fixture's bin directory is searchable, so a default `claude` or
    // `codex` resolution can never land on a real provider install.
    PATH: bin,
    HOME: home,
    TERM: "xterm-256color",
    // The Pi row's shared root stays inside the fixture: nothing outside it is read.
    PI_CODING_AGENT_DIR: agentDir,
    // Provider configuration and a user NODE_OPTIONS value survive untouched.
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    NODE_OPTIONS: "--no-warnings",
    // A stale host token must never reach a provider child.
    [SESSION_HOST_BOOTSTRAP_ENV]: "stale-token-that-must-be-stripped",
    PRG_SYNTH_INHERITED: "host-inherited",
    ...options.envExtras,
  };
  assert.equal(realpathSync(agentDir).startsWith(root + "/"), true, "the Pi agent root stays inside the owned fixture");

  const launcher = createNativeCliLauncher(harnessConfig ?? normalizeConfig({ enabled: true }));
  const registrar = new RecordingRegistrar();
  const handles: RealHandle[] = [];
  const defaultFactory = createDefaultPtyFactory();
  const manager = new InstanceManager({
    packageRoot,
    piExecutable,
    statusRegistrar: registrar,
    env,
    args: [],
    nativeCliLaunch: (backend, request) => launcher(backend, request),
    ...(options.framing === undefined ? {} : { nativeInputOriginFraming: options.framing }),
    ptyFactory: (descriptor) => {
      // The production default factory: the pinned real @lydell/node-pty.
      const pty = defaultFactory(descriptor);
      const handle: RealHandle = { descriptor, pty, pid: pty.pid };
      handles.push(handle);
      pty.onExit((event) => {
        handle.exit = { exitCode: event.exitCode, ...(event.signal === undefined ? {} : { signal: event.signal }) };
      });
      return pty;
    },
  });
  return { root, bin, workspaceAlpha, workspaceBeta, manager, registrar, handles };
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\u0007\u001b]*(?:\u0007|\x1b\\)|\x1b[@-Z\\-_]/g;

function frameText(surface: TerminalSurface): string {
  return surface.frame().lines.map((line) => line.replace(ANSI_PATTERN, "").replace(/\s+$/, "")).join("\n");
}

function surfaceOf(manager: InstanceManager, id: string): TerminalSurface {
  const surface = manager.surface(id);
  assert.ok(surface, "the row owns a terminal surface");
  return surface;
}

/**
 * The same rows joined with their xterm padding removed, so one assertion can
 * name a complete child line even where the real 80-column terminal
 * soft-wrapped it across rows (the wrap is a viewport fact, not lost data).
 */
function flatFrame(surface: TerminalSurface): string {
  return surface.frame().lines.map((line) => line.replace(ANSI_PATTERN, "").replace(/\s+$/, "")).join("");
}

/** Wait a bounded time for one real child to put a pattern on its own row. */
async function untilFrame(manager: InstanceManager, id: string, pattern: RegExp, what: string, timeoutMs = 20_000): Promise<string> {
  const surface = surfaceOf(manager, id);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = frameText(surface);
    if (pattern.test(text)) return text;
    assert.ok(Date.now() < deadline, `timed out after ${timeoutMs}ms waiting for ${what}; frame was:\n${text}`);
    await sleep(25);
  }
}

/** Wait a bounded time for one real child to put an exact substring on its row. */
async function untilFlat(manager: InstanceManager, id: string, literal: string, what: string, timeoutMs = 20_000): Promise<string> {
  const surface = surfaceOf(manager, id);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = flatFrame(surface);
    if (text.includes(literal)) return text;
    assert.ok(Date.now() < deadline, `timed out after ${timeoutMs}ms waiting for ${what}; frame was:\n${text}`);
    await sleep(25);
  }
}

/**
 * Observe one sibling's real frame for a bounded window and require the pattern
 * to stay absent the whole time (never a single racy glance). The joined frame
 * is compared, so a viewport soft-wrap can never hide a match.
 */
async function frameStaysWithout(manager: InstanceManager, id: string, pattern: RegExp, what: string, windowMs = 750): Promise<void> {
  const surface = surfaceOf(manager, id);
  const deadline = Date.now() + windowMs;
  for (;;) {
    const text = flatFrame(surface);
    assert.ok(!pattern.test(text), `${what}; sibling frame was:\n${text}`);
    if (Date.now() >= deadline) return;
    await sleep(25);
  }
}

function viewOf(manager: InstanceManager, id: string): NativeInstanceView {
  const view = manager.list().find((row) => row.id === id);
  assert.ok(view, "the row exists");
  return view;
}

/** Every provider field stays truthfully unknown: no invented zero, count, or session. */
function assertNativeTelemetryUnknown(view: NativeInstanceView): void {
  assert.equal(view.nativeSession, null, "a native CLI row never claims a Pi native conversation");
  assert.equal(view.busy, null, "busy stays unknown, never guessed false");
  assert.equal(view.pendingInput, null, "pending input stays unknown, never guessed");
  assert.equal(view.inputSurface, false, "no Pi input surface is claimed for a provider child");
  assert.equal(view.backgroundTasks, null, "background tasks stay unknown, never 0");
  assert.equal(view.backgroundShells, null, "background shells stay unknown, never 0");
  assert.equal(view.activeTasks, null, "active tasks stay unknown, never 0");
  assert.equal(view.activeShells, null, "active shells stay unknown, never 0");
  assert.deepEqual(view.activity, [], "no activity line is invented for a provider child");
}

/**
 * Run one case against a fresh owned fixture, then settle every real child this
 * file created before removing anything. A case passes only when its own
 * assertions held AND every owned handle's exit was actually witnessed; a failed
 * case, an unobserved exit, or a cleanup fault keeps its fixture under the
 * system temp directory and prints the retained path instead of deleting
 * evidence. The case's original failure is always the one reported.
 */
async function withHarness(label: string, options: HarnessOptions, body: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = makeHarness(label, options);
  // The case's own failure is carried through cleanup and rethrown after it:
  // settling every owned real child always runs, and no cleanup path may ever
  // swallow (or be mistaken for) the assertion that failed.
  let caseFailed = false;
  let bodyError: unknown;
  try {
    await body(harness);
  } catch (error) {
    caseFailed = true;
    bodyError = error;
  }
  try {
    await harness.manager.shutdown({ graceMs: 4000, killMs: 2000 }).catch(() => undefined);
    await harness.manager.dispose().catch(() => undefined);
    // Anything still owned by this file after the manager's own ladder gets one
    // final bounded escalation, so nothing outlives the case.
    for (const handle of harness.handles) {
      if (handle.exit) continue;
      try {
        handle.pty.kill("SIGKILL");
      } catch {
        // Already gone; the wait below still decides whether exit was witnessed.
      }
    }
    const deadline = Date.now() + 8000;
    while (harness.handles.some((handle) => handle.exit === undefined) && Date.now() < deadline) await sleep(50);
    const unsettled = harness.handles.filter((handle) => handle.exit === undefined);
    if (unsettled.length > 0 && !caseFailed) {
      // An unobserved owned exit is a resource-ownership failure in its own
      // right: a case may never pass while a child it spawned is still
      // unconfirmed. It never overwrites the case's own earlier failure.
      caseFailed = true;
      bodyError = new Error(`session-host native CLI PTY fixture: owned child exits were never observed for pid(s) ${unsettled.map((handle) => handle.pid).join(", ")}`);
    }
    if (caseFailed || unsettled.length > 0) {
      console.error(`prg-native-cli-pty: retained fixture evidence at ${harness.root}`
        + (unsettled.length > 0 ? ` with UNSETTLED owned pids ${unsettled.map((handle) => handle.pid).join(",")}` : ""));
    } else {
      rmSync(harness.root, { recursive: true, force: true });
    }
  } catch (cleanupError) {
    // A cleanup fault is reported too, but never over the case's own failure.
    console.error(`prg-native-cli-pty: fixture cleanup fault: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    if (!caseFailed) {
      caseFailed = true;
      bodyError = cleanupError;
    }
  }
  if (caseFailed) throw bodyError;
}

test("default claude and codex targets resolve through the production resolver and run as real interactive children", { skip: REAL_PTY_SKIP, timeout: 90_000 }, async () => {
  await withHarness("default-targets", {}, async (harness) => {
    const claudeId = await harness.manager.create({ workspace: harness.workspaceAlpha, backend: "claude" });
    const codexId = await harness.manager.create({ workspace: harness.workspaceBeta, backend: "codex" });

    const claudeFrame = await untilFrame(harness.manager, claudeId, /HELLO tag=claude pid=\d+ tty=1 geo=80x24/, "the claude child's own identity line");
    const codexFrame = await untilFrame(harness.manager, codexId, /HELLO tag=codex pid=\d+ tty=1 geo=80x24/, "the codex child's own identity line");
    assert.match(claudeFrame, /tty=1/, "the real child reports a real terminal");
    assert.match(codexFrame, /tty=1/, "the real child reports a real terminal");

    // The descriptors the manager handed the real PTY factory.
    assert.equal(harness.handles.length, 2);
    const [claudeHandle, codexHandle] = harness.handles;
    assert.ok(claudeHandle && codexHandle);
    assert.equal(claudeHandle.descriptor.file, join(harness.bin, "claude"));
    assert.deepEqual(claudeHandle.descriptor.args, []);
    assert.equal(codexHandle.descriptor.file, join(harness.bin, "codex"));
    assert.deepEqual(codexHandle.descriptor.args, ["--no-daemon"]);
    assert.equal(claudeHandle.descriptor.cwd, harness.workspaceAlpha);
    assert.equal(codexHandle.descriptor.cwd, harness.workspaceBeta);
    assert.deepEqual(claudeHandle.descriptor.args.join(" "), "", "no Pi extension or session argument was composed");

    // The child's own report of its argv, cwd, and environment. Its ENV line
    // precedes its QUESTION, so waiting for the question means the whole report
    // arrived. Long report lines soft-wrap in the real 80-column terminal, so
    // the joined frame is compared, never a single viewport row.
    const claudeFlat = await untilFlat(harness.manager, claudeId, "QUESTION claude: type YES to confirm", "the claude child's full self-report");
    const codexFlat = await untilFlat(harness.manager, codexId, "QUESTION codex: type YES to confirm", "the codex child's full self-report");
    assert.ok(claudeFlat.includes(`ARGV ${JSON.stringify([claudeHandle.descriptor.file])}`),
      "the real child sees exactly the argv the production launcher composed");
    assert.ok(codexFlat.includes(`ARGV ${JSON.stringify([codexHandle.descriptor.file, "--no-daemon"])}`),
      "the one deliberate Codex argument reaches the real child in argv order");
    assert.ok(claudeFlat.includes("ENV cwd=workspace-alpha"), "the real child's cwd is this row's workspace");
    assert.ok(codexFlat.includes("ENV cwd=workspace-beta"), "the sibling row's child runs in its own workspace");
    for (const flat of [claudeFlat, codexFlat]) {
      assert.ok(flat.includes("BOOT=absent"), "the host's stale bootstrap token never reaches a provider child");
      assert.ok(flat.includes("ROLE=-"), "no worker role authorization is inherited");
      assert.ok(flat.includes("NODEOPT=--no-warnings"), "the operator's NODE_OPTIONS survives with no staged preload");
      assert.ok(flat.includes("PROBE=-"), "a default target adds no shared environment overlay");
      assert.ok(flat.includes("INHERITED=host-inherited"), "ordinary environment inheritance is preserved");
    }
    assert.ok(claudeFlat.includes("CLAUDE_CONFIG_DIR="), "provider configuration inheritance stays untouched");
    assert.ok(codexFlat.includes("CODEX_HOME="), "provider configuration inheritance stays untouched");

    for (const handle of [claudeHandle, codexHandle]) {
      for (const key of HOST_TOKEN_KEYS) {
        assert.equal(Object.hasOwn(handle.descriptor.env, key), false, `${key} never reaches the real provider child`);
      }
    }
    assert.notEqual(claudeHandle.pid, codexHandle.pid, "each row owns a distinct OS process");

    // No status registration exists for a provider row, so no census exists to ask.
    assert.deepEqual(harness.registrar.requests, []);
    assert.equal(await harness.manager.refreshActivity(claudeId), "disconnected");

    assertNativeTelemetryUnknown(viewOf(harness.manager, claudeId));
    assertNativeTelemetryUnknown(viewOf(harness.manager, codexId));
    assert.equal(viewOf(harness.manager, codexId).backend, "codex");
    assert.equal(viewOf(harness.manager, codexId).label, sessionBackendDisplayLabel("codex"));
    assert.equal(harness.manager.hasLiveProcesses(), true);
  });
});

test("a configured shared CLI target keeps its node wrapper.js prefix, shared env, and PATH-resolved command in the real child", { skip: REAL_PTY_SKIP, timeout: 90_000 }, async () => {
  // Every fixture file — including the wrapper and the second target's own
  // executable — is staged inside the harness root by the config factory, so one
  // retention/cleanup policy governs the whole tree.
  await withHarness("wrapper-target", {
    config: (root) => {
      const wrapper = join(root, "synth", "codex wrapper.js");
      mkdirSync(join(root, "synth"), { recursive: true });
      writeFileSync(wrapper, SYNTHETIC_CLI_SOURCE, "utf8");
      return normalizeConfig({
        enabled: true,
        externalAgents: {
          "host-codex": {
            adapter: "codex-cli",
            command: process.execPath,
            args: [wrapper, "--profile", "host"],
            env: { PRG_SYNTH_PROBE: "host-codex" },
            review: { args: ["--print"], env: { REVIEW_ONLY: "1" } },
            execution: { args: ["app-server"], env: { EXEC_ONLY: "1" } },
          },
          "path-claude": {
            adapter: "claude-cli",
            command: "claude-configured",
            env: { PRG_SYNTH_PROBE: "path-claude" },
            review: {},
          },
        },
      });
    },
  }, async (harness) => {
    const wrapper = join(harness.root, "synth", "codex wrapper.js");
    const wrapperId = await harness.manager.create({
      workspace: harness.workspaceAlpha,
      backend: "codex",
      nativeCliTarget: "external:host-codex",
    });
    const configuredId = await harness.manager.create({
      workspace: harness.workspaceBeta,
      backend: "claude",
      nativeCliTarget: "external:path-claude",
    });

    assert.equal(harness.handles.length, 2);
    const [wrapperHandle, configuredHandle] = harness.handles;
    assert.ok(wrapperHandle && configuredHandle);

    // The wrapper filename deliberately contains a space: it is one argv
    // element, never a shell command line. As above, the child's own report is
    // compared on the joined frame because the real terminal soft-wraps it.
    const wrapperFlat = await untilFlat(harness.manager, wrapperId, "QUESTION codex wrapper.js: type YES to confirm", "the wrapper child's full self-report");
    assert.match(wrapperFlat, /HELLO tag=codex wrapper\.js pid=\d+ tty=1 geo=80x24/, "the wrapper child runs on a real terminal of the row's geometry");
    assert.ok(wrapperFlat.includes(`ARGV ${JSON.stringify(wrapperHandle.descriptor.args)}`),
      "the wrapper prefix stays exactly as configured, in front, with the daemon-isolating option in real option position after it");
    assert.ok(wrapperFlat.includes("PROBE=host-codex"), "the shared env overlay reaches the real child");

    const configuredFlat = await untilFlat(harness.manager, configuredId, "QUESTION claude-configured: type YES to confirm", "the PATH-resolved configured child's full self-report");
    assert.match(configuredFlat, /HELLO tag=claude-configured pid=\d+ tty=1 geo=80x24/, "the PATH-resolved target runs on a real terminal of the row's geometry");
    assert.ok(configuredFlat.includes(`ARGV ${JSON.stringify([configuredHandle.descriptor.file])}`),
      "a configured Claude target adds nothing and the child is the PATH-resolved file");
    assert.ok(configuredFlat.includes("PROBE=path-claude"), "the second target's own shared overlay reaches its own child");

    assert.equal(wrapperHandle.descriptor.file, realpathSync(process.execPath));
    assert.deepEqual(wrapperHandle.descriptor.args, [wrapper, "--profile", "host", "--no-daemon"]);
    assert.equal(configuredHandle.descriptor.file, join(harness.bin, "claude-configured"));
    assert.deepEqual(configuredHandle.descriptor.args, []);
    // Role overlays are never consulted for an interactive hosted session.
    for (const handle of [wrapperHandle, configuredHandle]) {
      assert.equal(handle.descriptor.env.REVIEW_ONLY, undefined);
      assert.equal(handle.descriptor.env.EXEC_ONLY, undefined);
      assert.equal(handle.descriptor.env.PRG_SYNTH_PROBE !== undefined, true);
    }
    assert.deepEqual(harness.registrar.requests, []);
    assertNativeTelemetryUnknown(viewOf(harness.manager, wrapperId));
  });
});

test("an unknown target or unresolvable command is refused before any child exists and reports a truthful error row", { skip: REAL_PTY_SKIP, timeout: 60_000 }, async () => {
  const config = normalizeConfig({
    enabled: true,
    externalAgents: {
      "missing-claude": { adapter: "claude-cli", command: "absent-claude-binary", review: {} },
    },
  });
  await withHarness("refusals", { config }, async (harness) => {
    const unknownTarget = await harness.manager.create({
      workspace: harness.workspaceAlpha,
      backend: "codex",
      nativeCliTarget: "external:absent",
    });
    const unresolvable = await harness.manager.create({
      workspace: harness.workspaceAlpha,
      backend: "claude",
      nativeCliTarget: "external:missing-claude",
    });

    for (const id of [unknownTarget, unresolvable]) {
      const view = viewOf(harness.manager, id);
      assert.equal(view.lifecycle, "error", "the failed launch is reported, never left pending");
      assert.equal(view.hasLiveProcess, false, "a refused launch owns no process");
      assert.ok(view.error, "the row carries a bounded public failure");
      assert.equal(harness.manager.surface(id), undefined, "no terminal surface exists for a child that never spawned");
      assert.equal(harness.manager.resizeInstance(id, 100, 30), false, "an error row is never resized");
      assert.throws(() => harness.manager.write(id, "ls\r"), /not accepting input/);
    }
    assert.equal(harness.handles.length, 0, "no real process was ever spawned");
    assert.deepEqual(harness.registrar.requests, []);

    // A Pi row never receives a native CLI target either.
    await assert.rejects(harness.manager.create({ workspace: harness.workspaceAlpha, nativeCliTarget: "external:host-codex" }),
      /only valid for a native CLI backend/);
    assert.equal(harness.handles.length, 0);
  });
});

test("Claude, Codex, and Pi rows in one real manager keep independent PTYs, output, input, and registrations", { skip: REAL_PTY_SKIP, timeout: 120_000 }, async () => {
  await withHarness("three-backends", {}, async (harness) => {
    const piId = await harness.manager.create({ workspace: harness.workspaceAlpha });
    const claudeId = await harness.manager.create({ workspace: harness.workspaceAlpha, backend: "claude" });
    const codexId = await harness.manager.create({ workspace: harness.workspaceBeta, backend: "codex" });

    await untilFrame(harness.manager, piId, /PIRUN tag=pi pid=\d+ tty=1 geo=80x24 boot=present/, "the synthetic Pi child's identity line");
    await untilFrame(harness.manager, claudeId, /HELLO tag=claude pid=\d+ tty=1 geo=80x24/, "the claude child's identity line");
    await untilFrame(harness.manager, codexId, /HELLO tag=codex pid=\d+ tty=1 geo=80x24/, "the codex child's identity line");

    // Only the Pi row is registered, and only the Pi child sees the bootstrap.
    // (Both provider rows are compared on the joined frame: their long ENV report
    // lines soft-wrap, and the wrap column moves with the child's pid digits.)
    assert.equal(harness.registrar.requests.length, 1, "a provider row is never registered with the status broker");
    assert.equal(harness.registrar.requests[0]?.instanceId, piId);
    assert.ok(flatFrame(surfaceOf(harness.manager, claudeId)).includes("BOOT=absent"));
    assert.ok(flatFrame(surfaceOf(harness.manager, codexId)).includes("BOOT=absent"));

    assert.equal(harness.handles.length, 3);
    const [piHandle, claudeHandle, codexHandle] = harness.handles;
    assert.ok(piHandle && claudeHandle && codexHandle);
    assert.deepEqual(new Set([piHandle.pid, claudeHandle.pid, codexHandle.pid]).size, 3, "three distinct OS processes");
    assert.deepEqual(piHandle.descriptor.args.slice(0, 4), [
      "--extension", join(harness.root, "package", "dist", "src", "session-host", "reporter.js"),
      "--extension", join(harness.root, "package", "dist", "src", "index.js"),
    ], "the Pi launch path is unchanged");
    assert.deepEqual(claudeHandle.descriptor.args, []);
    assert.deepEqual(codexHandle.descriptor.args, ["--no-daemon"]);
    assert.ok(piHandle.descriptor.env[SESSION_HOST_BOOTSTRAP_ENV], "the Pi child still receives its one-shot bootstrap");

    // Input addressed to one real child is answered by that child alone.
    harness.manager.write(claudeId, "ping-claude\r");
    await untilFrame(harness.manager, claudeId, /GOT claude "ping-claude"/, "the addressed child echoes its own input");
    await frameStaysWithout(harness.manager, codexId, /ping-claude/, "a sibling provider row never receives the byte");
    await frameStaysWithout(harness.manager, piId, /ping-claude/, "the Pi row never receives the provider byte");

    harness.manager.write(piId, "ping-pi\r");
    await untilFrame(harness.manager, piId, /PIGOT pi "ping-pi"/, "the Pi child echoes its own input");
    await frameStaysWithout(harness.manager, claudeId, /PIGOT|ping-pi/, "a provider row never receives the Pi byte");

    // Rows stay independently identified.
    const views = harness.manager.list();
    assert.equal(views.length, 3);
    assert.equal(Object.hasOwn(views.find((row) => row.id === piId) ?? {}, "backend"), false, "an unrecorded Pi row keeps the compatible view shape");
    assert.equal(viewOf(harness.manager, claudeId).backend, "claude");
    assert.equal(viewOf(harness.manager, codexId).backend, "codex");
    assertNativeTelemetryUnknown(viewOf(harness.manager, claudeId));
  });
});

test("with host input framing ON, a native row still receives raw bytes while the framing Pi row refuses every byte", { skip: REAL_PTY_SKIP, timeout: 120_000 }, async () => {
  await withHarness("framing-on", { framing: true }, async (harness) => {
    const claudeId = await harness.manager.create({ workspace: harness.workspaceAlpha, backend: "claude" });
    await untilFrame(harness.manager, claudeId, /HELLO tag=claude pid=\d+ tty=1/, "the claude child's identity line");

    // Raw local input, exactly as a legacy unframed row: string and Buffer both.
    harness.manager.write(claudeId, "ls -la\r");
    harness.manager.write(claudeId, Buffer.from([0x1b, 0x5b, 0x41, 0x0d]));
    harness.manager.write(claudeId, "YES\r");
    await untilFrame(harness.manager, claudeId, /GOT claude "ls -la"/, "the first raw line");
    await untilFrame(harness.manager, claudeId, /GOT claude "\\u001b\[A"/, "the raw escape sequence arrives byte-for-byte");
    await untilFrame(harness.manager, claudeId, /CONFIRMED claude/, "the answer reaches the owning child");
    assert.equal(viewOf(harness.manager, claudeId).lifecycle, "alive");
    assert.deepEqual(harness.registrar.requests, [], "a provider row never requests or receives a framing registration");

    // The Pi row in the SAME manager still refuses every byte before readiness.
    const piId = await harness.manager.create({ workspace: harness.workspaceAlpha });
    assert.deepEqual(harness.registrar.requests, [{ instanceId: piId, framing: true }], "only the Pi row requested framing, and only once");
    assert.throws(() => harness.manager.write(piId, "ls\r"), /refusing unframed input/);
    await frameStaysWithout(harness.manager, piId, /PIGOT/, "no unframed byte reaches a framing Pi child");

    // The strict viewer seam has nothing to fence a native row against.
    const viewer = harness.manager.openViewer({ hostRunId: "run-1", nativeClipboardSink: () => undefined });
    assert.ok(viewer);
    assert.equal(harness.manager.updateViewer(viewer.viewerId, { sessionId: claudeId, cols: 80, rows: 24 }).applied, true);
    assert.equal(harness.manager.readViewerInputSource(viewer.viewerId), undefined, "a native row mints no viewer input scope");
  });
});

test("addressed input, resize, and a prompt answer reach only the owning real child", { skip: REAL_PTY_SKIP, timeout: 120_000 }, async () => {
  await withHarness("addressed-io", {}, async (harness) => {
    const claudeId = await harness.manager.create({ workspace: harness.workspaceAlpha, backend: "claude" });
    const codexId = await harness.manager.create({ workspace: harness.workspaceBeta, backend: "codex" });
    await untilFrame(harness.manager, claudeId, /QUESTION claude/, "the claude child's own question");
    await untilFrame(harness.manager, codexId, /QUESTION codex/, "the codex child's own question");

    // Both children asked their own question; only one row is answered.
    harness.manager.write(claudeId, "YES\r");
    await untilFrame(harness.manager, claudeId, /CONFIRMED claude/, "the answer arrives at the owning process");
    await frameStaysWithout(harness.manager, codexId, /CONFIRMED/, "the sibling's real child never sees the answer");
    await frameStaysWithout(harness.manager, codexId, /GOT claude/, "the sibling's real child never sees the input");

    // Addressed resize reaches one real child's terminal only.
    assert.equal(harness.manager.resizeInstance(claudeId, 100, 30), true);
    await untilFrame(harness.manager, claudeId, /RESIZE 100x30/, "the addressed child's own terminal reports the new size");
    await frameStaysWithout(harness.manager, codexId, /RESIZE/, "a sibling provider row is never resized");
    assert.deepEqual(harness.manager.instanceGeometry(claudeId), { cols: 100, rows: 30, revision: 1 });
    assert.deepEqual(harness.manager.instanceGeometry(codexId), { cols: 80, rows: 24, revision: 0 });

    // The host-wide rule still sizes both live rows.
    harness.manager.resize(90, 20);
    await untilFrame(harness.manager, claudeId, /RESIZE 90x20/, "the addressed child follows the host-wide size");
    await untilFrame(harness.manager, codexId, /RESIZE 90x20/, "the sibling follows the host-wide size");

    // A natural child exit is observed on that row alone.
    harness.manager.write(claudeId, "BYE\r");
    await untilFrame(harness.manager, claudeId, /FAREWELL claude/, "the child reports its own farewell");
    const deadline = Date.now() + 10_000;
    while (viewOf(harness.manager, claudeId).lifecycle !== "exited" && Date.now() < deadline) await sleep(25);
    const exited = viewOf(harness.manager, claudeId);
    assert.equal(exited.lifecycle, "exited", "the manager settled the row on the real child's exit event");
    assert.equal(exited.exitCode, 0);
    assert.equal(exited.hasLiveProcess, false);
    assert.equal(viewOf(harness.manager, codexId).lifecycle, "alive", "the sibling keeps running");
    assert.equal(harness.handles[0]?.exit?.exitCode, 0, "this file witnessed the same exit on its own handle");
    assert.equal(harness.handles[1]?.exit, undefined);
  });
});

test("confirmed Stop settles the owned real child on its actual exit, and an unconfirmed Stop signals nothing", { skip: REAL_PTY_SKIP, timeout: 120_000 }, async () => {
  await withHarness("stop-confirmation", {}, async (harness) => {
    const claudeId = await harness.manager.create({ workspace: harness.workspaceAlpha, backend: "claude" });
    await untilFrame(harness.manager, claudeId, /QUESTION claude/, "the child is up and asking");

    // No status registration and no complete idle means no signal is sent.
    const refused = await harness.manager.stop(claudeId, { confirmed: false });
    assert.deepEqual(refused, { status: "confirmation-required", forced: false });
    await frameStaysWithout(harness.manager, claudeId, /SIGTERM/, "an unconfirmed Stop signals nothing to the real child");
    assert.equal(viewOf(harness.manager, claudeId).lifecycle, "alive");
    assert.equal(harness.manager.hasLiveProcesses(), true);

    // The operator's explicit confirmation runs the owned stop ladder.
    const stopped = await harness.manager.stop(claudeId, { confirmed: true });
    assert.deepEqual(stopped, { status: "exited", forced: false });
    await untilFrame(harness.manager, claudeId, /SIGTERM claude/, "the real child received and reported its own SIGTERM");
    const view = viewOf(harness.manager, claudeId);
    assert.equal(view.lifecycle, "exited");
    assert.equal(view.exitCode, 0, "the child exited of its own accord on the stop signal");
    assert.equal(view.hasLiveProcess, false);
    assert.equal(harness.handles[0]?.exit?.exitCode, 0, "this file witnessed the same exit on its own handle");
    assert.deepEqual(harness.registrar.releases, [], "there was no registration to release");

    // A settled row is reported, never guessed at.
    assert.equal(harness.manager.resizeInstance(claudeId, 90, 20), false);
    await harness.manager.shutdown({ graceMs: 2000, killMs: 1000 }).then((result) => {
      assert.deepEqual(result.remainingIds, []);
    });
    assert.equal(harness.manager.hasLiveProcesses(), false);
  });
});

test("manager shutdown escalates an owned real child that ignores SIGTERM and confirms its actual exit", { skip: REAL_PTY_SKIP, timeout: 120_000 }, async () => {
  await withHarness("shutdown-escalation", { envExtras: { PRG_SYNTH_IGNORE_TERM: "1" } }, async (harness) => {
    const codexId = await harness.manager.create({ workspace: harness.workspaceAlpha, backend: "codex" });
    await untilFrame(harness.manager, codexId, /QUESTION codex/, "the stubborn child is up");

    const result = await harness.manager.shutdown({ graceMs: 1200, killMs: 3000 });
    assert.deepEqual(result.forcedIds, [codexId], "the owned handle was force-escalated after the grace window");
    assert.deepEqual(result.remainingIds, [], "the owned child's actual exit was confirmed");
    assert.equal(viewOf(harness.manager, codexId).lifecycle, "exited");
    assert.equal(viewOf(harness.manager, codexId).hasLiveProcess, false);
    assert.equal(harness.manager.hasLiveProcesses(), false);

    const handle = harness.handles[0];
    assert.ok(handle);
    assert.match(flatFrame(surfaceOf(harness.manager, codexId)), /IGNORED-TERM codex/, "the real child survived SIGTERM, so escalation was necessary");
    assert.ok(handle.exit, "this file witnessed the owned handle's exit event");
    assert.notEqual(handle.descriptor.args.length, 0);
  });
});
