import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test, { after } from "node:test";

import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import {
  createNativeCliLauncher,
} from "../src/session-host/native-cli-launch";
import {
  InstanceManager,
  createDefaultPtyFactory,
  DEFAULT_SHUTDOWN_GRACE_MS,
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
import type { TerminalSurface } from "../src/session-host/terminal-surface";

/**
 * REAL Windows ConPTY coverage for the native interactive CLI launch path
 * (issue #277, native Windows slice).
 *
 * This is the Windows counterpart of `session-host-native-cli-pty.test.ts`, and
 * it wires the same production pair with no substitute in between:
 * `createNativeCliLauncher` (shared PATH/PATHEXT resolver, argv composition,
 * environment sanitizer, and the shipped launcher's one trusted `cmd.exe`
 * resolver) feeds `InstanceManager`'s `nativeCliLaunch` provider, and the
 * manager spawns the returned descriptor through its DEFAULT PTY factory — the
 * pinned real `@lydell/node-pty` with `useConptyDll: true`. Nothing here injects
 * a platform, a fake spawn, or a second resolver.
 *
 * What only a real Windows host can decide — and what these cases exist to
 * observe — is the batch delivery. A `.cmd`/`.bat` CLI shim (the shape npm
 * installs for a Node-based CLI) runs as `cmd.exe /d /s /v:off /c "<quoted
 * command line>"`. The pinned implementation's public Windows spawn either
 * MSDN-escapes an argv array or appends one pre-escaped command-line string
 * verbatim after the program path, so the descriptor carries the batch
 * invocation in that string form and never as argv. Every argument here is
 * therefore verified from the child's OWN reported argv after cmd.exe and the
 * batch shim have both parsed it, not from a descriptor or a string match.
 *
 * A literal `%` is exactly what only a real host can settle: cmd.exe expands
 * percent references while it reads a line and offers no escape, so each percent
 * is delivered as one expansion of an internal carrier variable that the same
 * line clears. These cases are the proof that the expansion is single pass in
 * the `/c` line and again in the shim's own `%*`, and that the clearance removes
 * the carrier before the CLI process inherits the environment.
 *
 * EVIDENCE SCOPE — read before drawing any conclusion:
 * - Every child is a SYNTHETIC Node program behind a synthetic batch shim. It
 *   is NOT Claude Code and NOT the Codex CLI; nothing here proves a real
 *   provider TUI's rendering, prompts, or telemetry, and nothing reads or writes
 *   any provider's real configuration, credentials, keychain, or conversations.
 * - The wrapper distinction is real and stays visible: the owned PTY handle's
 *   own process is the `cmd.exe` wrapper, while the reported `pid`/`ppid` pair
 *   shows the actual CLI process the shim started underneath it. The owned
 *   identity is observed from the pinned handle itself, which reports 0 until
 *   its ConPTY output worker has connected and the real pid afterwards.
 * - Windows lifecycle semantics are asserted as Windows semantics. The manager
 *   requests no POSIX signal on Windows — proven from the calls actually made on
 *   the real handle — and a confirmed Stop settles on the owned handle's forced
 *   kill and its observed exit event, never on a SIGTERM assumption. A console
 *   child can still be notified by the operating system that its own terminal
 *   closed (Node reports that notification to the child as SIGHUP); that is
 *   distinguished here from a signal the manager requested.
 *
 * Resource ownership: every spawned handle is recorded, and the harness refuses
 * to delete its fixture tree until every handle has an observed exit event of
 * its own. A failed case retains its fixture directory under the system temp
 * directory (never inside the repository) and prints the path. Because a real
 * Windows run of this file once printed every case result and then never
 * settled, the file also prints one active-resource witness after its last case
 * (see the `after` hook at the end of this file): it reports what this file's own
 * handles were asked to do and what Node still had outstanding, without forcing
 * any process, listener, or timer closed.
 */

const isWindows = process.platform === "win32";

/** Non-Windows hosts skip; on Windows NO prerequisite may ever become a skip. */
const WINDOWS_SKIP = isWindows
  ? false
  : "native Windows ConPTY acceptance requires a win32 host; the real cmd.exe batch delivery cannot be observed elsewhere";

const HOST_TOKEN_KEYS = [
  SESSION_HOST_BOOTSTRAP_ENV,
  SESSION_HOST_STARTUP_REQUEST_ENV,
  SESSION_HOST_TITLE_COLUMNS_ENV,
  NODE_OPTIONS_RESTORE_ENV,
] as const;

// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
const launcherHelper = require(resolve("scripts/pi-review-gate-launcher.cjs")) as {
  cmdQuote: (arg: string) => string;
  resolveTrustedWindowsCmd: (parentEnvironment?: NodeJS.ProcessEnv) => string | null;
};

/**
 * The Windows prerequisites, asserted rather than skipped: the pinned native
 * addon, the OS root the production launcher's trusted resolver reads, and a
 * real `System32\cmd.exe` under it. A missing piece fails the case on a Windows
 * host instead of turning native evidence into a silent green.
 */
function requireWindowsPrerequisites(): { systemRoot: string; cmdExe: string } {
  assert.equal(process.platform, "win32", "this file is the native Windows acceptance tier");
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  let nodePty: { spawn?: unknown };
  try {
    nodePty = require("@lydell/node-pty");
  } catch (error) {
    assert.fail(`the pinned @lydell/node-pty addon failed to load on this Windows host: ${error instanceof Error ? error.message : String(error)}`);
  }
  assert.equal(typeof nodePty.spawn, "function", "the pinned @lydell/node-pty exposes its public spawn");
  // Exactly what the production launcher reads: the parent process environment.
  const cmdExe = launcherHelper.resolveTrustedWindowsCmd(process.env);
  assert.ok(cmdExe, "the parent environment has no fully qualified SystemRoot with a regular System32\\cmd.exe for the trusted resolver");
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  assert.ok(systemRoot, "the Windows runner exposes no SystemRoot");
  return { systemRoot: systemRoot!, cmdExe };
}

/**
 * The synthetic interactive CLI every native row here runs, behind its own
 * batch shim. Never a provider binary. It reports its own pid/ppid pair, argv,
 * cwd, environment, TTY state, and geometry, echoes addressed input, and exits
 * on request so exits, codes, and settlement are observed from the child.
 */
function synthBody(tag: string): string {
  return `
"use strict";
const tag = process.env.PRG_SYNTH_TAG || ${JSON.stringify(tag)};
const say = (line) => { try { process.stdout.write(line + "\\r\\n"); } catch (error) { void error; } };
// A genuine query of the terminal's own size. The cached stdout.columns/rows
// only refresh when a resize notification reaches this process, and on Windows
// that notification depends on console input records reaching the reader; the
// refresh call below asks the console directly (GetConsoleScreenBufferInfo) and
// updates the properties. So a reported geometry is never a stale value and
// never waits for an extra keystroke. If the terminal is gone the stream emits
// 'error', which the listener below absorbs instead of crashing the child.
function refreshGeometry() {
  if (typeof process.stdout._refreshSize === "function") {
    try { process.stdout._refreshSize(); } catch (error) { void error; }
  }
}
function currentGeometry() {
  refreshGeometry();
  return process.stdout.columns + "x" + process.stdout.rows;
}
process.stdout.on("error", () => undefined);
say("HELLO tag=" + tag + " pid=" + process.pid + " ppid=" + (process.ppid || 0)
  + " tty=" + (process.stdout.isTTY ? 1 : 0)
  + " geo=" + currentGeometry());
// Base64 with an explicit terminator keeps the report wrap-safe: a long argv or
// cwd line soft-wraps in the real terminal, the joined frame carries no row
// breaks, and a semicolon is outside the base64 alphabet.
say("ARGV64 " + Buffer.from(JSON.stringify(process.argv.slice(1)), "utf8").toString("base64") + ";");
say("WS " + require("node:path").basename(process.cwd()));
say("CWD64 " + Buffer.from(process.cwd(), "utf8").toString("base64") + ";");
say("ENV PROBE=" + (process.env.PRG_SYNTH_PROBE || "-")
  + " INHERITED=" + (process.env.PRG_SYNTH_INHERITED || "-")
  // Internal argument-transport metadata must never survive into the CLI child:
  // an empty CARRIER= is the only correct report for any real child.
  + " CARRIER=" + Object.keys(process.env).filter((k) => /^PRG_NATIVE_BATCH_PCT_/i.test(k)).join(",")
  + " NODEOPT=" + (process.env.NODE_OPTIONS === undefined ? "-" : process.env.NODE_OPTIONS)
  + " BOOT=" + (process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ? "present" : "absent")
  + " ROLE=" + (process.env.PI_REVIEW_GATE_RUNTIME_ROLE || "-")
  + " USERPROFILE=" + (process.env.USERPROFILE || "-")
  + " CODEX_HOME=" + (process.env.CODEX_HOME || "-")
  + " CLAUDE_CONFIG_DIR=" + (process.env.CLAUDE_CONFIG_DIR || "-"));
// Windows has no SIGWINCH. Two independent paths make a geometry change
// observable here: stdin is taken into raw mode (as a real interactive TUI
// child does) so the console delivers its window-size records to this reader,
// and the timer re-queries the console directly. Neither path depends on an
// extra keystroke, neither trusts a value that was never refreshed, and only
// this child's own terminal ever produces a RESIZE line.
let lastGeometry = currentGeometry();
function reportGeometry() {
  const geometry = currentGeometry();
  if (geometry === lastGeometry) return;
  lastGeometry = geometry;
  say("RESIZE " + geometry);
}
const geometryPoll = setInterval(reportGeometry, 200);
geometryPoll.unref();
process.stdout.on("resize", () => reportGeometry());
// A POSIX signal never reaches a Windows console child. If one ever did, this
// line makes it visible: the Windows stop ladder must settle without it.
for (const name of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(name, () => say("SIGNAL " + name + " " + tag));
}
say("QUESTION " + tag + ": type YES to confirm");
// The optional parent-death watcher is OFF unless a case asks for it: a stop
// must be proven to settle the CLI process itself, never hidden by the child
// noticing that its batch wrapper vanished. What the child does react to is its
// OWN terminal dying: that is its genuine exit path, and the case still has to
// observe the reported pid disappear.
if (process.env.PRG_SYNTH_WATCH_PPID === "1" && process.ppid > 0) {
  const parent = process.ppid;
  const timer = setInterval(() => {
    try { process.kill(parent, 0); } catch { process.exit(0); }
  }, 150);
  timer.unref();
}
if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.setEncoding("utf8");
process.stdin.resume();
// The terminal this child owns went away: stop, exactly as an interactive
// program does, so a forced owned-handle kill is followed by the CLI's own
// exit rather than by a watcher covering for it.
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
// Raw mode means bytes arrive as the user types them, so the line accumulator
// stays: a line is complete at CR or LF, exactly as before.
let pending = "";
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let index;
  while ((index = pending.search(/[\\r\\n]/)) >= 0) {
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    if (line.length > 0) say("GOT " + tag + " " + JSON.stringify(line));
    if (line === "YES") say("CONFIRMED " + tag);
    if (line === "BYE") { say("FAREWELL " + tag); setTimeout(() => process.exit(0), 60).unref(); }
    if (line.indexOf("EXIT ") === 0) {
      const code = Number(line.slice(5)) || 0;
      say("LEAVING " + tag + " " + code);
      setTimeout(() => process.exit(code), 60).unref();
    }
  }
});
`;
}

/**
 * One npm-shaped batch shim: a quoted interpreter, a shim-relative quoted
 * target, and every forwarded argument passed through verbatim by `%*`. This is
 * the delivery the production descriptor must survive.
 */
function writeBatchShim(shimPath: string, bodyPath: string): void {
  const target = `%~dp0${relative(join(shimPath, ".."), bodyPath).replace(/\//g, "\\")}`;
  writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`, "utf8");
}

/**
 * Test-owned observation installed on the REAL handle the production default
 * factory returned, and removed again in `withHarness` cleanup.
 *
 * This is not a transport substitute and never becomes one: the factory hands
 * the manager the pinned `@lydell/node-pty` object itself, unchanged, so the
 * exact handle the default factory captured its owned ConPTY reader against is
 * the handle the manager registers, stops, and confirms (#666). Observation uses
 * that object's public surface only: output is witnessed by registering this
 * file's own `onData` listener, and `kill` is the single slot shadowed with an
 * own, configurable property that forwards to the pinned method with the same
 * receiver and the same arity. `restore()` releases the listener and puts the
 * handle's own `kill` descriptor back exactly as it was.
 *
 * Why `onData` is never replaced: the pinned `Terminal.prototype` defines it as
 * a getter-only accessor (`get: () => this._onData.event`), so assigning to it
 * throws `TypeError: Cannot set property onData of #<Terminal> which has only a
 * getter` in the strict mode every compiled module runs in. A helper that threw
 * there would fail the spawn before the handle was ever recorded or handed to the
 * manager, which is the opposite of owning a child. So nothing here assigns to a
 * pinned accessor, and an observation that cannot be installed is reported on
 * `installFault` instead of throwing — the handle always reaches the manager.
 *
 * It exists because "the manager requests no POSIX kill signal on Windows" is a
 * claim about what the real handle was ASKED to do, and the only honest witness
 * for that is the argument list it actually received. It also records whether any
 * output arrived after a kill, which is the pinned implementation's own
 * precondition for shutting its ConPTY output worker down on the `useConptyDll`
 * path (see the file-level resource witness at the end).
 */
interface HandleObservation {
  /** One entry per `kill()` call on the real handle, preserving its arity. */
  readonly killCalls: unknown[][];
  /** True once the real handle reported output after its first kill. */
  dataAfterKill: boolean;
  /** Why this file could not observe the handle; nothing is then claimed about it. */
  readonly installFault: string | undefined;
  /** Release this file's listener and restore the pinned handle's own slots. */
  restore(): void;
}

function observeRealHandle(pty: InstancePty): HandleObservation {
  const killCalls: unknown[][] = [];
  let killed = false;
  let installFault: string | undefined;
  let dataDisposable: { dispose(): void } | undefined;
  let restoreKill: () => void = () => undefined;
  const observation: HandleObservation = {
    killCalls,
    dataAfterKill: false,
    get installFault(): string | undefined {
      return installFault;
    },
    restore(): void {
      try {
        dataDisposable?.dispose();
      } catch {
        // A settled handle has nothing left to release; the waits decided already.
      }
      dataDisposable = undefined;
      restoreKill();
    },
  };
  // Output is witnessed through the handle's own public event API, never by
  // replacing the pinned getter-only `onData` accessor.
  try {
    dataDisposable = pty.onData(() => {
      if (killed) observation.dataAfterKill = true;
    });
  } catch (error) {
    installFault = `the real handle's own onData event could not be observed: ${error instanceof Error ? error.message : String(error)}`;
  }
  // `kill` is the one slot this file shadows, and it shadows it with an own
  // configurable property so restoring means restoring the handle's own
  // descriptor (or removing the shadow when the slot was inherited).
  const target = pty as unknown as Record<string, unknown>;
  const originalDescriptor = Object.getOwnPropertyDescriptor(target, "kill");
  const originalKill = target.kill;
  if (typeof originalKill !== "function") {
    installFault ??= "the real handle exposed no kill() to observe";
  } else {
    try {
      Object.defineProperty(target, "kill", {
        configurable: true,
        enumerable: originalDescriptor?.enumerable ?? false,
        value: function recordedKill(this: unknown, ...args: (string | undefined)[]): void {
          // Arity is the witness: the manager's Windows escalation is the pinned
          // no-argument kill, while a POSIX signal request would carry one.
          killCalls.push(args.length === 0 ? [] : [args[0]]);
          killed = true;
          (originalKill as (...callArgs: (string | undefined)[]) => void).apply(this, args);
        },
      });
      restoreKill = (): void => {
        if (originalDescriptor !== undefined) Object.defineProperty(target, "kill", originalDescriptor);
        else Reflect.deleteProperty(target, "kill");
      };
    } catch (error) {
      installFault ??= `the real handle's own kill() could not be observed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return observation;
}

/** Every real ConPTY handle this file created, for the file-level resource witness. */
const nativeHandleWitness: { label: string; handle: RealHandle }[] = [];

/** One fixture's outcome for the manager's owned-reader confirmation during cleanup. */
const readerSettlementWitness: { label: string; outcome: string }[] = [];

/** One real owned handle plus the exit event this file witnessed for it. */
interface RealHandle {
  readonly descriptor: InstanceSpawnDescriptor;
  /**
   * The opaque owned ConPTY handle exactly as the production default factory
   * returned it — the same object the factory captured its owned ConPTY reader
   * against, and the object the manager owns, stops, and confirms.
   */
  readonly pty: InstancePty;
  /** This file's kill-arity and post-kill-output witness on that same handle. */
  readonly observation: HandleObservation;
  /**
   * The owned handle's ORIGINAL process identity, bound from the pinned public
   * `pid` getter once it reports one (see {@link observeOwnedPid}). It is
   * deliberately NOT snapshotted at spawn time: the pinned Windows
   * implementation initializes that getter to 0 and only assigns the pid its
   * native `connect()` reported once the ConPTY output worker has connected, so
   * a 0 at spawn means "identity not reported yet", never "no process".
   */
  handlePid?: number;
  /**
   * True once a case sampled this handle's own process identity through
   * {@link observeOwnedPid}. Together with `handlePid` this keeps three states
   * apart in the resource witness: an identity this file bound, a pinned handle
   * it sampled that never reported one, and a handle no case ever sampled — the
   * last of which says nothing about the pinned implementation.
   */
  identitySampled?: boolean;
  /**
   * The CLI process the fixture reported starting underneath this handle. For a
   * batch child that is NOT `handlePid`: the owned handle is the cmd.exe
   * wrapper, and settlement of the wrapper alone proves nothing about the CLI
   * process.
   */
  childPid?: number;
  /** Whether this fixture's own child reported the console-close notification. */
  consoleCloseNotice?: boolean;
  exit?: { exitCode: number; signal?: number };
}

/** A registrar that records every request, so a native row's silence is provable. */
class RecordingRegistrar implements StatusRegistrar {
  readonly requests: string[] = [];

  register(
    instanceId: string,
    _handlers: InstanceStatusHandlers,
    _options?: { inputOriginFraming?: boolean },
  ): InstanceStatusRegistration {
    this.requests.push(instanceId);
    return {
      bootstrap: {
        version: 1,
        socketPath: join(tmpdir(), `prg-native-cli-win-unused-${instanceId}.sock`),
        token: randomBytes(32).toString("hex"),
        instanceId,
        generation: randomUUID(),
      },
      release: () => undefined,
    };
  }
}

interface HarnessOptions {
  /** Either a fixed configuration, or a factory given the harness's owned root. */
  config?: ReviewGateConfig | ((root: string) => ReviewGateConfig);
  envExtras?: NodeJS.ProcessEnv;
}

interface Harness {
  readonly root: string;
  readonly bin: string;
  readonly synth: string;
  readonly workspaceAlpha: string;
  readonly workspaceBeta: string;
  readonly cmdExe: string;
  readonly manager: InstanceManager;
  readonly registrar: RecordingRegistrar;
  readonly handles: RealHandle[];
  /** This file's own `onExit` registrations on the real handles, for its own cleanup. */
  readonly exitRegistrations: { dispose(): void }[];
}

/**
 * The canonical identity production gives an owned path.
 *
 * `createNativeCliLauncher` canonicalizes the executable it located with the
 * async `node:fs/promises` `realpath`. That overload is the native (libuv)
 * resolution, so on Windows it also expands an 8.3 short component: a runner's
 * `os.tmpdir()` spells its own profile directory `C:\Users\RUNNER~1`, and the
 * shim the launcher located comes back as `C:\Users\runneradmin\...`, while
 * `fs.realpathSync` is Node's JavaScript walk that follows only reparse points
 * and keeps each component's given spelling. The same directory therefore
 * legitimately appears in both forms in one real run. Every path this fixture
 * owns — and every path it expects the launcher to report for it — is
 * canonicalized with the SAME resolution production applies, so each comparison
 * is one identity against itself and never a spelling accident, while still
 * comparing whole paths rather than basenames.
 */
async function canonicalNativePath(path: string): Promise<string> {
  return await realpath(path);
}

/**
 * A real InstanceManager over an owned Windows fixture: the production native
 * CLI launcher (no platform injection), the manager's DEFAULT real ConPTY
 * factory wrapped only to record the exact descriptor and witness each handle's
 * own exit, and a fixture PATH/PATHEXT/HOME so no user configuration,
 * credential, or real provider install is reachable.
 */
async function makeHarness(label: string, options: HarnessOptions = {}): Promise<Harness> {
  const { systemRoot, cmdExe } = requireWindowsPrerequisites();
  // Canonicalized with the same resolution the launcher applies to the file it
  // spawns, so every expectation built from this root names that identity.
  const root = await canonicalNativePath(mkdtempSync(join(tmpdir(), `prg-native-cli-win-${label}-`)));
  const harnessConfig = typeof options.config === "function" ? options.config(root) : options.config;

  const packageRoot = join(root, "package");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic gate-extension fixture; never imported or executed.\n", "utf8");
  writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic reporter fixture; never imported or executed.\n", "utf8");

  const bin = join(root, "bin");
  const synth = join(root, "synth");
  const home = join(root, "home");
  const agentDir = join(root, "pi-agent");
  const temporary = join(root, "tmp");
  // The selected workspaces deliberately contain spaces: cmd.exe quoting must
  // survive the operator's own paths, not just the arguments.
  const workspaceAlpha = join(root, "workspace alpha");
  const workspaceBeta = join(root, "workspace beta");
  for (const directory of [bin, synth, home, agentDir, temporary, workspaceAlpha, workspaceBeta]) {
    mkdirSync(directory, { recursive: true });
  }

  // One owned synthetic CLI per target, so a row's own report identifies which
  // shim the resolver selected.
  const bodyFor = (name: string): string => {
    const body = join(synth, `${name}.cjs`);
    writeFileSync(body, synthBody(name), "utf8");
    return body;
  };
  writeBatchShim(join(bin, "claude.cmd"), bodyFor("claude"));
  writeBatchShim(join(bin, "codex.cmd"), bodyFor("codex"));
  writeBatchShim(join(bin, "codex-configured.cmd"), bodyFor("codex-configured"));
  writeBatchShim(join(bin, "claude-batch.bat"), bodyFor("claude-batch"));
  writeBatchShim(join(bin, "codex-daemon.cmd"), bodyFor("codex-daemon"));
  writeBatchShim(join(bin, "codex-percent.cmd"), bodyFor("codex-percent"));
  // A `node wrapper.js` prefix target: a direct .exe, no cmd.exe at all. The
  // wrapper filename carries a space, so it is one argv element, never a shell
  // command line.
  const wrapper = join(synth, "codex wrapper.js");
  writeFileSync(wrapper, synthBody("wrapper"), "utf8");

  const env: NodeJS.ProcessEnv = {
    // Only this fixture's bin directory is searchable for CLI names, so a
    // default `claude`/`codex` resolution can never land on a real install.
    PATH: `${bin};${join(systemRoot, "System32")}`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: cmdExe,
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    HOME: home,
    USERPROFILE: home,
    TERM: "xterm-256color",
    PI_CODING_AGENT_DIR: agentDir,
    // Provider configuration and a user NODE_OPTIONS value survive untouched.
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    NODE_OPTIONS: "--no-warnings",
    // A stale host token must never reach a provider child.
    [SESSION_HOST_BOOTSTRAP_ENV]: "stale-token-that-must-be-stripped",
    PRG_SYNTH_INHERITED: "host-inherited",
    // The fixture's optional parent-death watcher stays OFF: settlement is
    // proven by observing the CLI process itself disappear, never by the child
    // noticing its wrapper vanish. A case that wants it opts in explicitly.
    ...options.envExtras,
  };

  const launcher = createNativeCliLauncher(harnessConfig ?? normalizeConfig({ enabled: true }));
  const registrar = new RecordingRegistrar();
  const handles: RealHandle[] = [];
  const exitRegistrations: { dispose(): void }[] = [];
  const defaultFactory = createDefaultPtyFactory();
  const manager = new InstanceManager({
    packageRoot,
    piExecutable: join(bin, "synthetic-pi.cmd"),
    statusRegistrar: registrar,
    env,
    args: [],
    nativeCliLaunch: (backend, request) => launcher(backend, request),
    ptyFactory: (descriptor) => {
      // The production default factory: the pinned real @lydell/node-pty ConPTY.
      // Its handle is handed to the manager unchanged, because that exact object
      // is the key the factory's owned-reader capture (#666) is stored under; a
      // wrapper here would hide that ownership from the manager. The handle's own
      // public methods are observed instead, and restored during cleanup.
      const pty = defaultFactory(descriptor);
      const observation = observeRealHandle(pty);
      const handle: RealHandle = { descriptor, pty, observation };
      handles.push(handle);
      nativeHandleWitness.push({ label, handle });
      exitRegistrations.push(pty.onExit((event) => {
        handle.exit = { exitCode: event.exitCode, ...(event.signal === undefined ? {} : { signal: event.signal }) };
      }));
      return pty;
    },
  });
  return { root, bin, synth, workspaceAlpha, workspaceBeta, cmdExe, manager, registrar, handles, exitRegistrations };
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\u0007\u001b]*(?:\u0007|\x1b\\)|\x1b[@-Z\\-_]/g;

function flatFrame(surface: TerminalSurface): string {
  return surface.frame().lines.map((line) => line.replace(ANSI_PATTERN, "").replace(/\s+$/, "")).join("");
}

function surfaceOf(manager: InstanceManager, id: string): TerminalSurface {
  const surface = manager.surface(id);
  assert.ok(surface, "the row owns a terminal surface");
  return surface;
}

/** Wait a bounded time for one real child to put an exact substring on its row. */
async function untilFlat(manager: InstanceManager, id: string, literal: string, what: string, timeoutMs = 30_000): Promise<string> {
  const surface = surfaceOf(manager, id);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = flatFrame(surface);
    if (text.includes(literal)) return text;
    assert.ok(Date.now() < deadline, `timed out after ${timeoutMs}ms waiting for ${what}; frame was:\n${text}`);
    await sleep(25);
  }
}

/** Wait a bounded time for one real child to put a pattern on its own row. */
async function untilFrame(manager: InstanceManager, id: string, pattern: RegExp, what: string, timeoutMs = 30_000): Promise<string> {
  const surface = surfaceOf(manager, id);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = flatFrame(surface);
    if (pattern.test(text)) return text;
    assert.ok(Date.now() < deadline, `timed out after ${timeoutMs}ms waiting for ${what}; frame was:\n${text}`);
    await sleep(25);
  }
}

/**
 * Observe one sibling's real frame for a bounded window and require the pattern
 * to stay absent the whole time (never a single racy glance).
 */
async function frameStaysWithout(manager: InstanceManager, id: string, pattern: RegExp, what: string, windowMs = 900): Promise<void> {
  const surface = surfaceOf(manager, id);
  const deadline = Date.now() + windowMs;
  for (;;) {
    const text = flatFrame(surface);
    assert.ok(!pattern.test(text), `${what}; sibling frame was:\n${text}`);
    if (Date.now() >= deadline) return;
    await sleep(25);
  }
}

/**
 * Observe, without requiring it, the console-close notification a Windows
 * console child reports after its own terminal goes away.
 *
 * Whether the child gets that notification is the platform's choice, so it is
 * only recorded for the resource witness. What a case decides is the opposite
 * half: that the notification is never one of the POSIX stop signals, and that
 * the manager requested no signal of any kind (see the real-handle kill witness).
 */
async function observeConsoleClosure(manager: InstanceManager, id: string, timeoutMs = 1500): Promise<boolean> {
  const surface = surfaceOf(manager, id);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (/SIGNAL SIGHUP/.test(flatFrame(surface))) return true;
    if (Date.now() >= deadline) return false;
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

/** Windows path comparison: case-insensitive, with `..` segments normalized. */
function sameWindowsPath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

/** The child's own reported argv, decoded from its base64 report line. */
function reportedArgv(frame: string): string[] {
  const match = /ARGV64 ([A-Za-z0-9+/=]+);/.exec(frame);
  assert.ok(match, `the child never reported its argv; frame was:\n${frame}`);
  return JSON.parse(Buffer.from(match[1], "base64").toString("utf8")) as string[];
}

/** The child's own reported working directory, decoded from its report line. */
function reportedCwd(frame: string): string {
  const match = /CWD64 ([A-Za-z0-9+/=]+);/.exec(frame);
  assert.ok(match, `the child never reported its cwd; frame was:\n${frame}`);
  return Buffer.from(match[1], "base64").toString("utf8");
}

/** The batch command line the pinned spawn must receive verbatim after cmd.exe. */
function expectedBatchCommandLine(shim: string, args: readonly string[]): string {
  return `/d /s /v:off /c "${[shim, ...args].map(launcherHelper.cmdQuote).join(" ")}"`;
}

/**
 * The one internal percent carrier the descriptor handed cmd.exe, validated as
 * the product's own transport metadata: exactly one, in its canonical spelling,
 * carrying exactly the percent sign it exists to deliver.
 */
function percentCarrierOf(env: NodeJS.ProcessEnv): string {
  const names = Object.keys(env).filter((name) => /^PRG_NATIVE_BATCH_PCT_\d+$/u.test(name));
  assert.equal(names.length, 1, "exactly one internal percent carrier is handed to cmd.exe");
  const carrier = names[0];
  assert.equal(env[carrier], "%", "the carrier's whole value is the percent sign it delivers");
  return carrier;
}

/**
 * The batch command line a percent-bearing delivery must carry: every percent
 * replaced by one reference to the carrier, and the carrier cleared in the same
 * line before the shim runs.
 */
function expectedBatchCommandLineWithCarrier(carrier: string, shim: string, args: readonly string[]): string {
  const quote = (token: string): string => launcherHelper.cmdQuote(token.replace(/%/gu, `%${carrier}%`));
  return `/d /s /v:off /c "set "${carrier}=" & ${[shim, ...args].map(quote).join(" ")}"`;
}

/**
 * The CLI process the fixture reported starting underneath its wrapper. It is
 * retained on the handle so cleanup can prove that process, not only the
 * wrapper, settled.
 */
function noteChildPid(handle: RealHandle, frame: string): number {
  const pid = Number(/HELLO tag=\S+ pid=(\d+)/.exec(frame)?.[1]);
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "the fixture reported its own pid");
  handle.childPid = pid;
  return pid;
}

/**
 * Bind the owned handle's ORIGINAL process identity by observing the pinned
 * public getter, before the case touches the row.
 *
 * In the pinned `@lydell/node-pty@1.2.0-beta.15` Windows implementation the
 * `Terminal` base initializes `_pid` to 0 and exposes it as a live getter;
 * `WindowsPtyAgent` starts with `innerPid = 0` and only assigns the pid its
 * native `connect()` returned once the ConPTY output worker has connected, and
 * `WindowsTerminal` re-reads `agent.innerPid` at that point (its
 * `ready_datapipe` handler is commented "Update pid now that the agent has
 * connected"). So a `pid` of 0 immediately after `spawn()` is the pinned
 * implementation's initial unready state — not an unavailable identity and not a
 * process. This harness therefore waits for the real handle to report its own
 * identity and fails truthfully if it never does; it never adopts 0 as a pid,
 * never probes pid 0, and keeps the owned handle's identity separate from the
 * `pid`/`ppid` pair the fixture reports for the CLI process underneath it.
 */
async function observeOwnedPid(handle: RealHandle, what: string, timeoutMs = 10_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  handle.identitySampled = true;
  for (;;) {
    const reported = handle.pty.pid;
    if (Number.isSafeInteger(reported) && reported > 0) {
      handle.handlePid = reported;
      return reported;
    }
    assert.ok(Date.now() < deadline, `${what}: the pinned ConPTY handle never reported a process identity within ${timeoutMs}ms (its public pid getter stayed ${reported})`);
    await sleep(25);
  }
}

/** How an owned handle's identity is named in a diagnostic: never a bare 0, and never a claim about a handle this file never sampled. */
function ownedIdentity(handle: RealHandle): string {
  if (handle.handlePid !== undefined) return String(handle.handlePid);
  return handle.identitySampled === true ? "sampled but never reported an identity" : "identity never sampled";
}

/** True while a process with this pid still exists on this host. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one case against a fresh owned fixture, then settle everything this file
 * started before removing anything. Two separate facts must settle: every owned
 * PTY handle must have an observed exit event of its own, and every CLI process
 * a fixture reported starting underneath a batch wrapper must actually stop
 * existing. A wrapper-only kill is a shutdown integration seam, so it fails the
 * case with the fixture retained instead of being concealed. Windows escalation
 * is the owned handle's no-argument kill: the pinned implementation rejects a
 * signal argument on that platform. A failed case, an unsettled process, or a
 * cleanup fault keeps its fixture under the system temp directory and prints the
 * retained path. The case's own failure is always the one reported.
 *
 * The manager's own `dispose()` is part of that settlement and is never swallowed:
 * it is the only place the #666 owned Windows ConPTY reader confirmation runs, so a
 * disposal it rejects is a required cleanup this file must report, not a detail a
 * fixture may ignore. It runs only AFTER every owned handle's own exit has been
 * witnessed, because disposal owes nothing for a handle that never exited: a
 * disposal run first would resolve clean, a fallback kill would then produce that
 * exit, and the reader release that came due afterwards would go unconfirmed while
 * this file reported success. Anything still unexited when the wait ends is itself
 * a failure, and the settlement witness says NOT CONFIRMED rather than confirmed.
 * The file's thin observation of each real handle is removed here too, so no
 * test-owned listener or property outlives the case, and an observation this file
 * could not install fails the case instead of quietly weakening its witnesses.
 */
async function withHarness(label: string, options: HarnessOptions, body: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await makeHarness(label, options);
  let caseFailed = false;
  let bodyError: unknown;
  const failFirst = (error: Error): void => {
    if (caseFailed) return;
    caseFailed = true;
    bodyError = error;
  };
  try {
    await body(harness);
  } catch (error) {
    failFirst(error instanceof Error ? error : new Error(String(error)));
  }
  try {
    await harness.manager.shutdown({ graceMs: 4000, killMs: 4000 }).catch(() => undefined);
    // Failure handling only: a handle this file created that still has no exit
    // event is asked to stop through its own owned handle.
    for (const handle of harness.handles) {
      if (handle.exit) continue;
      try {
        // Public node-pty on Windows takes no signal argument.
        handle.pty.kill();
      } catch {
        // Already gone; the wait below still decides whether exit was witnessed.
      }
    }
    // Every owned exit is observed BEFORE the manager is asked to confirm anything.
    // Disposal deliberately owes nothing for a handle whose exit never came, so a
    // disposal that ran first could resolve clean and then watch a fallback kill
    // produce that exit — a reader release that came due afterwards and was never
    // confirmed, which no later disposal can retroactively settle either, because
    // the tracked disposal promise is cached. Waiting first is what lets a clean
    // disposal mean what this file needs it to mean.
    const deadline = Date.now() + 15_000;
    while (harness.handles.some((handle) => handle.exit === undefined) && Date.now() < deadline) await sleep(50);
    const unsettled = harness.handles.filter((handle) => handle.exit === undefined);
    if (unsettled.length > 0) {
      failFirst(new Error(`session-host native CLI Windows fixture: owned child exits were never observed for handle(s) ${unsettled.map((handle) => ownedIdentity(handle)).join(", ")}`));
    }
    // The CLI processes underneath the wrappers, observed within the same bound.
    const reportedChildren = harness.handles.filter((handle) => handle.childPid !== undefined);
    const surviving = () => reportedChildren.filter((handle) => processAlive(handle.childPid!));
    while (surviving().length > 0 && Date.now() < deadline) await sleep(50);
    const survivingNow = surviving();
    if (survivingNow.length > 0) {
      failFirst(new Error(`session-host native CLI Windows fixture: SHUTDOWN INTEGRATION SEAM — the owned PTY wrapper handles settled, but the CLI processes they started are still running: ${survivingNow.map((handle) => `cli pid ${handle.childPid} under wrapper ${ownedIdentity(handle)}`).join("; ")}. A forced kill that reaches only the batch wrapper leaves the hosted CLI alive; this is reported as an unresolved shutdown seam for the generic stop ladder rather than being masked here.`));
    }
    // Only now is disposal the real confirmation: every owned handle this file
    // created has had its own exit witnessed, so each captured reader release came
    // due, and a disposal this file rejects is a required cleanup it must report.
    let disposeFailure: Error | undefined;
    try {
      await harness.manager.dispose();
    } catch (error) {
      disposeFailure = error instanceof Error ? error : new Error(String(error));
    }
    readerSettlementWitness.push({
      label,
      outcome: unsettled.length > 0
        // Truthful, never a pass: those handles' releases never came due, so
        // nothing was confirmed for them however this disposal resolved.
        ? `NOT CONFIRMED: ${unsettled.length} owned handle(s) never exited, so their readers' release never came due before disposal${disposeFailure === undefined ? "" : `; disposal also REJECTED: ${disposeFailure.message}`}`
        : disposeFailure === undefined
          ? "manager disposal confirmed every owned reader"
          : `manager disposal REJECTED: ${disposeFailure.message}`,
    });
    if (disposeFailure !== undefined) {
      failFirst(new Error(`session-host native CLI Windows fixture: the instance manager's disposal — the only confirmation of its owned Windows ConPTY reader settlement (#666) — rejected: ${disposeFailure.message}`));
    }
    // An observation this file could not install is not a free pass: the kill-arity
    // and post-kill-output claims for that handle cannot be made, and the handle
    // still reached the manager, so the case reports it rather than passing silently.
    const observationFaults = harness.handles.filter((handle) => handle.observation.installFault !== undefined);
    if (observationFaults.length > 0) {
      failFirst(new Error(`session-host native CLI Windows fixture: this file could not observe the real handle(s) it was given, so its kill-arity and post-kill-output witnesses are unavailable: ${observationFaults.map((handle) => `${ownedIdentity(handle)}: ${handle.observation.installFault}`).join("; ")}`));
    }
    // Test-owned observation cleanup: each real handle gets its own pinned methods
    // back, so nothing this file installed stays on a production handle.
    for (const handle of harness.handles) {
      try {
        handle.observation.restore();
      } catch {
        // A handle whose own slot could not be restored says nothing about the case.
      }
    }
    // Test-owned listener cleanup: every exit witness this file registered on a
    // real handle is recorded above, so its own registration is released here.
    // Nothing in the pinned public handle is force-closed from the test: the
    // settlement of the implementation's own ConPTY resources is reported by the
    // file-level resource witness instead of being assumed here.
    for (const registration of harness.exitRegistrations) {
      try {
        registration.dispose();
      } catch {
        // A settled handle has nothing left to release; the wait above decided.
      }
    }
    if (caseFailed || unsettled.length > 0) {
      console.error(`prg-native-cli-windows: retained fixture evidence at ${harness.root}`
        + (unsettled.length > 0 ? ` with UNSETTLED owned handles ${unsettled.map((handle) => ownedIdentity(handle)).join(",")}` : ""));
    } else {
      rmSync(harness.root, { recursive: true, force: true });
    }
  } catch (cleanupError) {
    console.error(`prg-native-cli-windows: fixture cleanup fault: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    failFirst(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
  }
  if (caseFailed) throw bodyError;
}

test("built-in claude and codex targets run their owned PATH/PATHEXT .cmd shims on a real ConPTY with exact argv, cwd, environment, TTY, and wrapper pid", { skip: WINDOWS_SKIP, timeout: 150_000 }, async () => {
  await withHarness("default-shims", {}, async (harness) => {
    const claudeId = await harness.manager.create({ workspace: harness.workspaceAlpha, backend: "claude" });
    const codexId = await harness.manager.create({ workspace: harness.workspaceBeta, backend: "codex" });

    const claudeFrame = await untilFlat(harness.manager, claudeId, "QUESTION claude: type YES to confirm", "the claude child's full self-report");
    const codexFrame = await untilFlat(harness.manager, codexId, "QUESTION codex: type YES to confirm", "the codex child's full self-report");

    // The descriptors the manager handed the real pinned ConPTY factory.
    assert.equal(harness.handles.length, 2);
    const [claudeHandle, codexHandle] = harness.handles;
    assert.ok(claudeHandle && codexHandle);
    const claudeShim = join(harness.bin, "claude.cmd");
    const codexShim = join(harness.bin, "codex.cmd");
    assert.equal(claudeHandle.descriptor.file, harness.cmdExe, "the batch child is the trusted parent System32 cmd.exe");
    assert.deepEqual(claudeHandle.descriptor.args, [], "a batch child carries no argv for the pinned spawn to re-escape");
    assert.equal(claudeHandle.descriptor.commandLine, expectedBatchCommandLine(claudeShim, []),
      "the bare-name Claude shim resolves through PATH/PATHEXT and is delivered as one verbatim cmd.exe command line");
    assert.equal(codexHandle.descriptor.commandLine, expectedBatchCommandLine(codexShim, ["--no-daemon"]),
      "the Codex shim's command line carries the one deliberate option");
    assert.equal(claudeHandle.descriptor.cwd, harness.workspaceAlpha);
    assert.equal(codexHandle.descriptor.cwd, harness.workspaceBeta);

    // A real terminal at the row geometry, reported by the child's own stdout.
    assert.match(claudeFrame, /HELLO tag=claude pid=\d+ ppid=\d+ tty=1 geo=80x24/, "the real child runs on a ConPTY terminal at the row geometry");
    assert.match(codexFrame, /HELLO tag=codex pid=\d+ ppid=\d+ tty=1 geo=80x24/, "the sibling row's child has its own ConPTY terminal");

    // The child's own argv, after cmd.exe and the batch shim both parsed it.
    // Element zero is the shim's own target spelling (`%~dp0..` stays as cmd
    // expanded it), so the body path is compared as a path, not as text.
    const claudeArgv = reportedArgv(claudeFrame);
    const codexArgv = reportedArgv(codexFrame);
    assert.deepEqual(claudeArgv.slice(1), [], "the real Claude child sees exactly the arguments the production launcher composed, with no shell re-tokenization");
    assert.deepEqual(codexArgv.slice(1), ["--no-daemon"],
      "the one deliberate Codex option survives cmd.exe delivery in argv order");
    assert.ok(sameWindowsPath(claudeArgv[0] ?? "", join(harness.synth, "claude.cjs")),
      "the child's own script is the owned fixture body behind the owned claude.cmd shim");
    assert.ok(sameWindowsPath(codexArgv[0] ?? "", join(harness.synth, "codex.cjs")),
      "the sibling's own script is the owned fixture body behind the owned codex.cmd shim");

    // The selected workspace, spaces and all, is the child's own cwd.
    assert.ok(claudeFrame.includes("WS workspace alpha"), "the real child's cwd basename is this row's spaced workspace");
    assert.ok(codexFrame.includes("WS workspace beta"), "the sibling row's child runs in its own spaced workspace");
    assert.ok(sameWindowsPath(reportedCwd(claudeFrame), harness.workspaceAlpha),
      "the child's full reported cwd is the canonical spaced workspace the launcher composed");
    assert.ok(sameWindowsPath(reportedCwd(codexFrame), harness.workspaceBeta),
      "the sibling's reported cwd is its own canonical spaced workspace");

    for (const frame of [claudeFrame, codexFrame]) {
      assert.ok(frame.includes("BOOT=absent"), "the host's stale bootstrap token never reaches a provider child");
      assert.ok(frame.includes("ROLE=-"), "no worker role authorization is inherited");
      assert.ok(frame.includes("NODEOPT=--no-warnings"), "the operator's NODE_OPTIONS survives with no staged preload");
      assert.ok(frame.includes("PROBE=-"), "a default target adds no shared environment overlay");
      assert.ok(frame.includes("INHERITED=host-inherited"), "ordinary environment inheritance is preserved");
    }
    assert.ok(claudeFrame.includes("CLAUDE_CONFIG_DIR="), "provider configuration inheritance stays untouched");
    assert.ok(codexFrame.includes("CODEX_HOME="), "provider configuration inheritance stays untouched");

    for (const handle of [claudeHandle, codexHandle]) {
      for (const key of HOST_TOKEN_KEYS) {
        assert.equal(Object.hasOwn(handle.descriptor.env, key), false, `${key} never reaches the real provider child`);
      }
    }

    // The wrapper distinction: the owned handle is cmd.exe, the CLI process is
    // the child the shim started underneath it, and that child is retained so
    // cleanup must see it settle too. Each owned identity is read from the pinned
    // handle itself, which reports it once its ConPTY output worker connects.
    const claudeWrapperPid = await observeOwnedPid(claudeHandle, "the claude row's owned ConPTY handle");
    const codexWrapperPid = await observeOwnedPid(codexHandle, "the codex row's owned ConPTY handle");
    const claudeChildPid = noteChildPid(claudeHandle, claudeFrame);
    const claudeParentPid = Number(/HELLO tag=claude pid=\d+ ppid=(\d+)/.exec(claudeFrame)?.[1]);
    noteChildPid(codexHandle, codexFrame);
    assert.ok(Number.isSafeInteger(claudeParentPid) && claudeParentPid > 0, "the child reports its parent pid");
    assert.equal(claudeParentPid, claudeWrapperPid, "the owned PTY handle is the cmd.exe wrapper that started the CLI process");
    assert.notEqual(claudeChildPid, claudeWrapperPid, "the CLI process is not the owned wrapper process");
    assert.notEqual(codexWrapperPid, claudeWrapperPid, "each row owns a distinct ConPTY wrapper process");

    // No status registration exists for a provider row, so no census exists to ask.
    assert.deepEqual(harness.registrar.requests, []);
    assert.equal(await harness.manager.refreshActivity(claudeId), "disconnected");
    assertNativeTelemetryUnknown(viewOf(harness.manager, claudeId));
    assertNativeTelemetryUnknown(viewOf(harness.manager, codexId));
    assert.equal(harness.manager.hasLiveProcesses(), true);
  });
});

test("configured .cmd and .bat targets keep shared arguments, shared environment, and the spaced workspace through real cmd.exe argument delivery", { skip: WINDOWS_SKIP, timeout: 150_000 }, async () => {
  await withHarness("configured-batch", {
    config: () => normalizeConfig({
      enabled: true,
      externalAgents: {
        "host-cmd": {
          adapter: "codex-cli",
          command: "codex-configured",
          args: ["--profile", "host profile", '--message=hello "world" & echo PWNED'],
          env: { PRG_SYNTH_PROBE: "host-cmd" },
          review: { args: ["--print"], env: { REVIEW_ONLY: "1" } },
          execution: { args: ["app-server"], env: { EXEC_ONLY: "1" } },
        },
        "host-bat": {
          adapter: "claude-cli",
          command: "claude-batch",
          args: ["--settings", "operator settings.json"],
          env: { PRG_SYNTH_PROBE: "host-bat" },
          review: {},
        },
      },
    }),
  }, async (harness) => {
    const cmdId = await harness.manager.create({
      workspace: harness.workspaceAlpha,
      backend: "codex",
      nativeCliTarget: "external:host-cmd",
    });
    const batId = await harness.manager.create({
      workspace: harness.workspaceBeta,
      backend: "claude",
      nativeCliTarget: "external:host-bat",
    });

    const cmdFrame = await untilFlat(harness.manager, cmdId, "QUESTION codex-configured: type YES to confirm", "the .cmd child's full self-report");
    const batFrame = await untilFlat(harness.manager, batId, "QUESTION claude-batch: type YES to confirm", "the .bat child's full self-report");

    assert.equal(harness.handles.length, 2);
    const [cmdHandle, batHandle] = harness.handles;
    assert.ok(cmdHandle && batHandle);
    // PATHEXT selected the `.cmd` for one target and the `.bat` for the other.
    assert.equal(cmdHandle.descriptor.file, harness.cmdExe);
    assert.equal(cmdHandle.descriptor.commandLine,
      expectedBatchCommandLine(join(harness.bin, "codex-configured.cmd"), ["--profile", "host profile", '--message=hello "world" & echo PWNED', "--no-daemon"]));
    assert.equal(batHandle.descriptor.commandLine,
      expectedBatchCommandLine(join(harness.bin, "claude-batch.bat"), ["--settings", "operator settings.json"]));

    // The decisive observation: exactly what the real child received after
    // cmd.exe parsed the quoted command line and the shim forwarded `%*`.
    const cmdArgv = reportedArgv(cmdFrame);
    const batArgv = reportedArgv(batFrame);
    assert.deepEqual(cmdArgv.slice(1), [
      "--profile", "host profile", '--message=hello "world" & echo PWNED', "--no-daemon",
    ], "spaces, quotes, and a redirection operator inside one argument arrive as one argument each");
    assert.deepEqual(batArgv.slice(1), [
      "--settings", "operator settings.json",
    ], "the .bat target's shared arguments arrive intact with no injected Codex option");
    assert.ok(sameWindowsPath(cmdArgv[0] ?? "", join(harness.synth, "codex-configured.cjs")),
      "PATHEXT selected the configured .cmd for this row");
    assert.ok(sameWindowsPath(batArgv[0] ?? "", join(harness.synth, "claude-batch.cjs")),
      "PATHEXT selected the configured .bat for the other row");
    noteChildPid(cmdHandle, cmdFrame);
    noteChildPid(batHandle, batFrame);
    // Bound each row's owned identity from the pinned handle, so the resource
    // witness names real processes rather than the spawn-time placeholder.
    const cmdWrapperPid = await observeOwnedPid(cmdHandle, "the configured .cmd row's owned ConPTY handle");
    const batWrapperPid = await observeOwnedPid(batHandle, "the configured .bat row's owned ConPTY handle");
    assert.notEqual(cmdWrapperPid, batWrapperPid, "each configured row owns its own ConPTY wrapper process");

    // Nothing the operator did not choose executed: the redirection operator
    // stayed data, so its command never ran.
    assert.ok(!cmdFrame.includes("PWNED"), "a redirection operator inside one argument never becomes a cmd.exe command");
    assert.ok(cmdFrame.includes("PROBE=host-cmd"), "the shared env overlay reaches the real child");
    assert.ok(batFrame.includes("PROBE=host-bat"), "the second target's own shared overlay reaches its own child");
    assert.ok(cmdFrame.includes("WS workspace alpha") && batFrame.includes("WS workspace beta"),
      "each configured target runs in the workspace its row selected");

    // Role overlays are never consulted for an interactive hosted session.
    for (const handle of [cmdHandle, batHandle]) {
      assert.equal(handle.descriptor.env.REVIEW_ONLY, undefined);
      assert.equal(handle.descriptor.env.EXEC_ONLY, undefined);
      assert.notEqual(handle.descriptor.env.PRG_SYNTH_PROBE, undefined);
      assert.equal(handle.descriptor.commandLine !== undefined, true, "a batch child's descriptor carries the command line");
    }
    assert.deepEqual(harness.registrar.requests, []);
    assertNativeTelemetryUnknown(viewOf(harness.manager, cmdId));
  });
});

test("an operator argument that spells a cmd.exe environment-variable reference reaches the real ConPTY child as the operator's literal text", { skip: WINDOWS_SKIP, timeout: 150_000 }, async () => {
  await withHarness("percent-argument", {
    config: () => normalizeConfig({
      enabled: true,
      externalAgents: {
        "percent-codex": {
          adapter: "codex-cli",
          command: "codex-percent",
          // Every shape the changed delivery path must keep literal, one token
          // each, so the child's own argv shows whether any of it expanded: a
          // defined name and an undefined one, a redirection operator sharing a
          // token with a percent, the parameter/dynamic percent forms that also
          // fire inside a batch context, the delayed-expansion forms `/v:off`
          // exists for, embedded quotes around a percent, a spaced path ending
          // in a backslash, and an empty operand of a value-taking option.
          args: [
            "--profile", "%PRG_SYNTH_INHERITED%",
            "--label", "100%PI% & echo PWNED",
            "--params", "%1 %~dp0 %* %ERRORLEVEL%",
            "--bangs", "!PRG_SYNTH_INHERITED! a!b!c",
            "--path", "C:\\operator dir\\",
            "--quote", 'say "%PRG_SYNTH_INHERITED%" & hi',
            "--model", "",
          ],
          env: {},
          review: {},
        },
      },
    }),
  }, async (harness) => {
    const rowId = await harness.manager.create({
      workspace: harness.workspaceAlpha,
      backend: "codex",
      nativeCliTarget: "external:percent-codex",
    });
    const frame = await untilFlat(harness.manager, rowId, "QUESTION codex-percent: type YES to confirm", "the percent-bearing child's self-report");
    const handle = harness.handles[0];
    assert.ok(handle);
    noteChildPid(handle, frame);
    // Bound the owned identity from the pinned handle while the row is still
    // untouched, so the resource witness names a real process for this fixture.
    await observeOwnedPid(handle, "the percent-bearing row's owned ConPTY handle");

    // A percent cannot be typed into a cmd.exe /c command line: cmd expands
    // %NAME% while it READS the line, before quoting or tokenization, and no
    // quoting or caret suppresses that. Each percent in the batch text is
    // therefore delivered as one expansion of a single internal carrier variable
    // whose value is exactly `%`, and the same line clears that carrier before
    // the shim runs. Pi's own layer still performs no percent escaping or
    // translation: the shipped quoting authority quotes the placeholder-bearing
    // token exactly as it quotes the operator's own text.
    const carrier = percentCarrierOf(handle.descriptor.env);
    // The Codex backend's one isolation option is part of the same composed
    // argv, so it appears in the batch command line after the configured empty
    // operand exactly as the strict child-argv expectation below requires it.
    assert.equal(handle.descriptor.commandLine,
      expectedBatchCommandLineWithCarrier(carrier, join(harness.bin, "codex-percent.cmd"), [
        "--profile", "%PRG_SYNTH_INHERITED%",
        "--label", "100%PI% & echo PWNED",
        "--params", "%1 %~dp0 %* %ERRORLEVEL%",
        "--bangs", "!PRG_SYNTH_INHERITED! a!b!c",
        "--path", "C:\\operator dir\\",
        "--quote", 'say "%PRG_SYNTH_INHERITED%" & hi',
        "--model", "",
        "--no-daemon",
      ]),
      "every percent is carried by one reference, and the carrier is cleared before the shim runs");

    // What the real child received is the contract, and this is the concrete
    // fidelity test: percent references (defined, undefined, parameter and
    // dynamic), the bang forms `/v:off` guards, embedded quotes, a spaced path
    // ending in a backslash, and an empty operand are compared as exact argv
    // equality. A failure here is not flakiness: it is a batch-delivery defect
    // in this adapter, and it is fixed as one — never by refusing, expanding, or
    // reclassifying the operator's argument.
    const argv = reportedArgv(frame);
    assert.deepEqual(argv.slice(1),
      [
        "--profile", "%PRG_SYNTH_INHERITED%",
        "--label", "100%PI% & echo PWNED",
        "--params", "%1 %~dp0 %* %ERRORLEVEL%",
        "--bangs", "!PRG_SYNTH_INHERITED! a!b!c",
        "--path", "C:\\operator dir\\",
        "--quote", 'say "%PRG_SYNTH_INHERITED%" & hi',
        "--model", "",
        "--no-daemon",
      ],
      "every percent-, bang-, quote-, backslash-, and empty-shaped operator argument survived cmd.exe and the batch shim unchanged");
    // Percent expansion runs once per line: a reintroduced percent must not be
    // re-read when the shim expands its own `%*`, and a `&` that shares a token
    // with a carried percent is still data, so its command never runs.
    assert.ok(!frame.includes("PWNED"), "a redirection operator beside a carried percent never becomes a cmd.exe command");
    assert.ok(sameWindowsPath(argv[0] ?? "", join(harness.synth, "codex-percent.cjs")),
      "element zero is the owned fixture body the configured .cmd shim forwarded to, not an argument");
    // The transport metadata stayed inside cmd.exe: the line that expanded the
    // carrier also cleared it, so the CLI process inherits no argument carrier.
    // The name is what is absent, so a wrapped report line cannot hide a leak.
    assert.match(frame, /CARRIER=/u, "the real child reports its internal carrier keys");
    assert.ok(!frame.includes("PRG_NATIVE_BATCH_PCT"),
      "no internal percent carrier survives into the real CLI child's environment");
    assert.ok(frame.includes("INHERITED=host-inherited"),
      "clearing the carrier leaves the inherited environment the operator owns intact");
    assert.deepEqual(harness.registrar.requests, []);
  });
});

test("a direct .exe with a node wrapper.js prefix stays off cmd.exe and reaches the real child with the operator's arguments intact", { skip: WINDOWS_SKIP, timeout: 150_000 }, async () => {
  const wrapper = (root: string): string => join(root, "synth", "codex wrapper.js");
  await withHarness("direct-exe-wrapper", {
    config: (root) => normalizeConfig({
      enabled: true,
      externalAgents: {
        "node-wrapper": {
          adapter: "codex-cli",
          command: process.execPath,
          args: [wrapper(root), "--profile", "host profile"],
          env: { PRG_SYNTH_PROBE: "node-wrapper" },
          review: {},
        },
      },
    }),
  }, async (harness) => {
    const wrapperPath = wrapper(harness.root);
    const wrapperId = await harness.manager.create({
      workspace: harness.workspaceAlpha,
      backend: "codex",
      nativeCliTarget: "external:node-wrapper",
    });
    const frame = await untilFlat(harness.manager, wrapperId, "QUESTION wrapper: type YES to confirm", "the wrapper child's full self-report");

    assert.equal(harness.handles.length, 1);
    const handle = harness.handles[0];
    assert.ok(handle);
    assert.equal(handle.descriptor.file, await canonicalNativePath(process.execPath), "the direct executable is the configured .exe, canonically identified the way the launcher identifies it");
    assert.equal(handle.descriptor.commandLine, undefined, "a direct executable is never delivered as a cmd.exe command line");
    assert.deepEqual(handle.descriptor.args, [wrapperPath, "--profile", "host profile", "--no-daemon"]);
    assert.match(frame, /HELLO tag=wrapper pid=\d+ ppid=\d+ tty=1 geo=80x24/, "the wrapper child runs on its own ConPTY terminal at the row geometry");
    assert.deepEqual(reportedArgv(frame), [wrapperPath, "--profile", "host profile", "--no-daemon"],
      "the wrapper prefix stays exactly as configured, in front, with the daemon-isolating option in real option position after it");
    assert.ok(frame.includes("PROBE=node-wrapper"), "the shared env overlay reaches the real child");
    assert.ok(frame.includes("WS workspace alpha"), "the wrapper child runs in this row's spaced workspace");
    const childPid = Number(/HELLO tag=wrapper pid=(\d+)/.exec(frame)?.[1]);
    assert.ok(Number.isSafeInteger(childPid) && childPid > 0, "the direct child reported its own pid");
    // The owned handle's identity comes from the pinned handle itself, observed
    // before anything is asked of the row; for a direct executable it is the same
    // process the fixture reported, with no batch wrapper in between.
    const ownedPid = await observeOwnedPid(handle, "the direct-executable row's owned ConPTY handle");
    assert.equal(childPid, ownedPid, "for a direct executable the owned handle IS the CLI process, with no batch wrapper between them");
    noteChildPid(handle, frame);
    assert.deepEqual(harness.registrar.requests, []);
  });
});

test("native Codex receives exactly one --no-daemon in real option position and Claude receives no injected flag, as the ConPTY child reports them", { skip: WINDOWS_SKIP, timeout: 150_000 }, async () => {
  await withHarness("daemon-option", {
    config: () => normalizeConfig({
      enabled: true,
      externalAgents: {
        "codex-prompt": {
          adapter: "codex-cli",
          command: "codex-daemon",
          args: ["--profile", "host", "--", "hello --no-daemon"],
          env: {},
          review: {},
        },
      },
    }),
  }, async (harness) => {
    const plainId = await harness.manager.create({ workspace: harness.workspaceAlpha, backend: "codex" });
    const promptId = await harness.manager.create({
      workspace: harness.workspaceBeta,
      backend: "codex",
      nativeCliTarget: "external:codex-prompt",
    });
    const plainClaudeId = await harness.manager.create({ workspace: harness.workspaceAlpha, backend: "claude" });

    const plainFrame = await untilFlat(harness.manager, plainId, "QUESTION codex: type YES to confirm", "the default Codex child's self-report");
    const promptFrame = await untilFlat(harness.manager, promptId, "QUESTION codex-daemon: type YES to confirm", "the terminator Codex child's self-report");
    const claudeFrame = await untilFlat(harness.manager, plainClaudeId, "QUESTION claude: type YES to confirm", "the Claude child's self-report");

    const plainArgv = reportedArgv(plainFrame);
    const promptArgv = reportedArgv(promptFrame);
    const claudeArgv = reportedArgv(claudeFrame);

    // Exactly one isolation flag per Codex child, in a real option position.
    assert.equal(plainArgv.filter((arg) => arg === "--no-daemon").length, 1, "the default Codex child receives one --no-daemon");
    assert.deepEqual(plainArgv.slice(1), ["--no-daemon"]);
    // Before the `--` terminator, so the provider still reads it as an option,
    // and after the configured value-taking option's operand.
    assert.deepEqual(promptArgv.slice(1), ["--profile", "host", "--no-daemon", "--", "hello --no-daemon"],
      "the flag lands in option position while everything past the terminator stays the provider's own prompt data");
    const terminatorIndex = promptArgv.indexOf("--");
    assert.ok(terminatorIndex > 0);
    assert.equal(promptArgv.filter((arg, index) => arg === "--no-daemon" && index < terminatorIndex).length, 1,
      "the single flag sits before the terminator, never inside the prompt data");
    // Claude gets nothing injected.
    assert.deepEqual(claudeArgv.slice(1), [], "a Claude child receives no injected provider flag");
    assert.equal(claudeArgv.filter((arg) => arg.includes("no-daemon")).length, 0);

    assert.equal(harness.handles.length, 3);
    const [plainHandle, promptHandle, claudeHandle2] = harness.handles;
    assert.ok(plainHandle && promptHandle && claudeHandle2);
    noteChildPid(plainHandle, plainFrame);
    noteChildPid(promptHandle, promptFrame);
    noteChildPid(claudeHandle2, claudeFrame);
    // Bound each owned identity from the pinned handle, so a settled run leaves
    // no handle whose identity the harness simply never looked at.
    const plainWrapperPid = await observeOwnedPid(plainHandle, "the default Codex row's owned ConPTY handle");
    const promptWrapperPid = await observeOwnedPid(promptHandle, "the terminator Codex row's owned ConPTY handle");
    const claudeWrapperPid = await observeOwnedPid(claudeHandle2, "the Claude row's owned ConPTY handle");
    assert.equal(new Set([plainWrapperPid, promptWrapperPid, claudeWrapperPid]).size, 3,
      "each of the three rows owns its own ConPTY wrapper process");
    assert.deepEqual(harness.registrar.requests, []);
  });
});

test("addressed input, a prompt answer, and resize reach only the owning ConPTY child; sibling rows share nothing", { skip: WINDOWS_SKIP, timeout: 150_000 }, async () => {
  await withHarness("addressed-io", {}, async (harness) => {
    const claudeId = await harness.manager.create({ workspace: harness.workspaceAlpha, backend: "claude" });
    const codexId = await harness.manager.create({ workspace: harness.workspaceBeta, backend: "codex" });
    const claudeReport = await untilFlat(harness.manager, claudeId, "QUESTION claude: type YES to confirm", "the claude child's own question");
    const codexReport = await untilFlat(harness.manager, codexId, "QUESTION codex: type YES to confirm", "the codex child's own question");

    // Process identity is taken from the INITIAL self-report and from the pinned
    // handles themselves, before any input or resize below can scroll a row: each
    // row owns its own ConPTY wrapper process, and each fixture's CLI process is
    // retained so settlement is proven for both.
    assert.equal(harness.handles.length, 2);
    const [claudeHandle, codexHandle] = harness.handles;
    assert.ok(claudeHandle && codexHandle);
    const claudeWrapperPid = await observeOwnedPid(claudeHandle, "the addressed claude row's owned ConPTY handle");
    const codexWrapperPid = await observeOwnedPid(codexHandle, "the addressed codex row's owned ConPTY handle");
    assert.notEqual(claudeWrapperPid, codexWrapperPid, "each row owns a distinct ConPTY wrapper process");
    const claudeChildPid = noteChildPid(claudeHandle, claudeReport);
    const codexChildPid = noteChildPid(codexHandle, codexReport);
    assert.notEqual(claudeChildPid, claudeWrapperPid, "the claude row's CLI process is not its own wrapper process");
    assert.notEqual(codexChildPid, codexWrapperPid, "the codex row's CLI process is not its own wrapper process");

    // Both children asked their own question; only one row is answered.
    harness.manager.write(claudeId, "YES\r");
    await untilFlat(harness.manager, claudeId, "CONFIRMED claude", "the answer arrives at the owning process");
    await frameStaysWithout(harness.manager, codexId, /CONFIRMED/, "the sibling's real child never sees the answer");

    // A unique token proves input isolation, not just prompt isolation.
    const token = `ping-${randomUUID()}`;
    harness.manager.write(codexId, `${token}\r`);
    await untilFrame(harness.manager, codexId, new RegExp(`GOT codex "${token}"`), "the addressed child echoes its own input");
    await frameStaysWithout(harness.manager, claudeId, new RegExp(token), "the sibling row never receives the byte");

    // Addressed resize reaches one real child's ConPTY only.
    assert.equal(harness.manager.resizeInstance(claudeId, 100, 30), true);
    await untilFlat(harness.manager, claudeId, "RESIZE 100x30", "the addressed child's own terminal reports the new size");
    await frameStaysWithout(harness.manager, codexId, /RESIZE/, "a sibling provider row is never resized");
    assert.deepEqual(harness.manager.instanceGeometry(claudeId), { cols: 100, rows: 30, revision: 1 });
    assert.deepEqual(harness.manager.instanceGeometry(codexId), { cols: 80, rows: 24, revision: 0 });

    // The host-wide rule still sizes both live rows.
    harness.manager.resize(90, 20);
    await untilFlat(harness.manager, claudeId, "RESIZE 90x20", "the addressed child follows the host-wide size");
    await untilFlat(harness.manager, codexId, "RESIZE 90x20", "the sibling follows the host-wide size");
  });
});

test("a deliberate fixture exit and a confirmed owned Stop settle truthfully with Windows lifecycle semantics, never a POSIX signal", { skip: WINDOWS_SKIP, timeout: 150_000 }, async () => {
  await withHarness("windows-settlement", {}, async (harness) => {
    const exitId = await harness.manager.create({ workspace: harness.workspaceAlpha, backend: "claude" });
    const stopId = await harness.manager.create({ workspace: harness.workspaceBeta, backend: "codex" });
    const exitReport = await untilFlat(harness.manager, exitId, "QUESTION claude: type YES to confirm", "the first child is up and asking");
    const stopReport = await untilFlat(harness.manager, stopId, "QUESTION codex: type YES to confirm", "the second child is up and asking");

    assert.equal(harness.handles.length, 2, "both rows own a real handle");
    const exitHandle = harness.handles[0];
    const stopHandle = harness.handles[1];
    assert.ok(exitHandle && stopHandle, "both rows own a real handle");
    // Each CLI identity is captured from its own initial self-report, and each
    // owned identity is bound from the pinned handle, before any lifecycle action.
    noteChildPid(exitHandle, exitReport);
    const stopChildPid = noteChildPid(stopHandle, stopReport);
    await observeOwnedPid(exitHandle, "the deliberate-exit row's owned ConPTY handle");
    const stopWrapperPid = await observeOwnedPid(stopHandle, "the stopped row's owned ConPTY handle");
    assert.notEqual(stopChildPid, stopWrapperPid, "the asserted settlement is about the CLI process, not the cmd.exe wrapper process");

    // 1. A deliberate child exit is reported with the child's own code.
    harness.manager.write(exitId, "EXIT 3\r");
    await untilFlat(harness.manager, exitId, "LEAVING claude 3", "the child reports its own planned departure");
    const exitDeadline = Date.now() + 15_000;
    while (viewOf(harness.manager, exitId).lifecycle !== "exited" && Date.now() < exitDeadline) await sleep(25);
    const exited = viewOf(harness.manager, exitId);
    assert.equal(exited.lifecycle, "exited", "the manager settled the row on the real child's exit event");
    assert.equal(exited.exitCode, 3, "the child's exit code propagates through the batch shim to the row");
    assert.equal(exited.hasLiveProcess, false);
    assert.equal(exitHandle.exit?.exitCode, 3, "this file witnessed the same exit on its own handle");
    assert.equal(harness.manager.resizeInstance(exitId, 90, 20), false, "a settled row is never resized");

    // 2. An unconfirmed Stop signals nothing and changes nothing: it makes no
    // request at all of the real handle, and the child reports no signal.
    const refused = await harness.manager.stop(stopId, { confirmed: false });
    assert.deepEqual(refused, { status: "confirmation-required", forced: false });
    assert.equal(viewOf(harness.manager, stopId).lifecycle, "alive");
    assert.equal(harness.manager.hasLiveProcesses(), true);
    assert.equal(stopHandle.observation.killCalls.length, 0, "an unconfirmed Stop made no kill request of any kind on the real handle");
    await frameStaysWithout(harness.manager, stopId, /SIGNAL /, "nothing reached the Windows child while its Stop stayed unconfirmed");

    // 3. The operator's confirmation runs the owned stop ladder, with the
    // fixture's optional parent-death watcher OFF (asserted below, from the
    // spawn environment this file observed). On Windows the manager sends no
    // POSIX signal at all: it waits out the grace window on the real handle,
    // then escalates with the pinned no-argument kill, and reports that
    // escalation truthfully.
    assert.equal(stopHandle.descriptor.env.PRG_SYNTH_WATCH_PPID, undefined,
      "the fixture's parent-death watcher is disabled for this assertion, so nothing can mask a surviving CLI process");
    const killRequestsBeforeStop = stopHandle.observation.killCalls.length;
    const startedAt = Date.now();
    const stopped = await harness.manager.stop(stopId, { confirmed: true });
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(stopped, { status: "exited", forced: true },
      "a Windows confirmed Stop settles on the owned handle's forced kill, not on a signal the platform never delivers");
    assert.ok(elapsed >= DEFAULT_SHUTDOWN_GRACE_MS - 500,
      `the manager waited out its full grace window (${elapsed}ms >= ${DEFAULT_SHUTDOWN_GRACE_MS}ms grace): no early POSIX-signal exit happened on Windows`);
    // The decisive lifecycle witness: what the manager actually asked the REAL
    // handle. On Windows the only escalation is the pinned no-argument kill, and
    // a SIGTERM or SIGKILL request would show up here as a kill call carrying an
    // argument.
    const killRequests = stopHandle.observation.killCalls.slice(killRequestsBeforeStop);
    assert.deepEqual(killRequests.filter((request) => request.length > 0), [],
      "the manager requested no POSIX signal on Windows: every kill it made of the real handle was the pinned no-argument owned kill");
    assert.equal(killRequests.length, 1, "the confirmed Stop escalated exactly once, through the owned handle");
    const stoppedView = viewOf(harness.manager, stopId);
    assert.equal(stoppedView.lifecycle, "exited");
    assert.equal(stoppedView.hasLiveProcess, false);
    assert.ok(stopHandle.exit, "this file witnessed the owned handle's exit event");
    assert.equal(typeof stopHandle.exit?.exitCode, "number", "the settled handle carries an observed exit code");
    // A Windows console child IS notified by the operating system when its own
    // terminal goes away, and Node surfaces that notification to the child as
    // SIGHUP. That is the console closing after the forced kill — not a signal
    // the manager requested, and not the POSIX escalation this platform must
    // never take, so SIGTERM and SIGINT stay absent from the child's own report.
    await frameStaysWithout(harness.manager, stopId, /SIGNAL (?:SIGTERM|SIGINT)/, "no POSIX stop signal ever reached the Windows child");
    stopHandle.consoleCloseNotice = await observeConsoleClosure(harness.manager, stopId);

    // 4. Settlement is proven for the CLI process the shim started, not just for
    // the wrapper handle the manager owns. If the forced kill reaches only the
    // batch wrapper, this fails as a shutdown integration seam and the fixture is
    // retained by the harness instead of being deleted around a live process.
    const childDeadline = Date.now() + 15_000;
    while (processAlive(stopChildPid) && Date.now() < childDeadline) await sleep(100);
    assert.ok(!processAlive(stopChildPid),
      `SHUTDOWN INTEGRATION SEAM: the owned PTY wrapper (${stopWrapperPid}) settled, but the CLI process it started (pid ${stopChildPid}) is still running after a confirmed Stop. A forced kill that reaches only cmd.exe leaves the hosted CLI alive; that is unresolved generic shutdown behavior and must not be masked by a fixture-side parent watcher.`);

    // 5. Nothing is left owned by this file.
    const shutdown = await harness.manager.shutdown({ graceMs: 2000, killMs: 2000 });
    assert.deepEqual(shutdown.remainingIds, []);
    assert.equal(harness.manager.hasLiveProcesses(), false);
  });
});

/**
 * The pinned implementation's real property shapes, with no ConPTY and no child
 * process: `onData` is an inherited getter-only accessor and `kill` is an
 * inherited writable prototype method. Only the two host-independent controls
 * below use it.
 */
class SyntheticPinnedShapePty {
  readonly pid = 424243;
  cols = 80;
  rows = 24;
  /** What the pinned `kill` this file forwards to actually received. */
  readonly forwardedKills: { readonly receiver: unknown; readonly args: readonly (string | undefined)[] }[] = [];
  #dataListeners: ((data: string) => void)[] = [];

  /** The pinned accessor resolves to this on each read, as `this._onData.event` does. */
  registerDataListener(listener: (data: string) => void): { dispose(): void } {
    this.#dataListeners.push(listener);
    return {
      dispose: () => {
        const index = this.#dataListeners.indexOf(listener);
        if (index >= 0) this.#dataListeners.splice(index, 1);
      },
    };
  }

  get dataListenerTotal(): number {
    return this.#dataListeners.length;
  }

  emitData(data: string): void {
    for (const listener of [...this.#dataListeners]) listener(data);
  }

  /** Inherited, writable, configurable — the shape the pinned terminal's kill has. */
  kill(...args: (string | undefined)[]): void {
    this.forwardedKills.push({ receiver: this, args });
  }
}

// Exactly the pinned accessor: a getter with no setter, so assigning to `onData`
// throws `TypeError: Cannot set property onData ... which has only a getter` in
// the strict mode every compiled module runs in.
Object.defineProperty(SyntheticPinnedShapePty.prototype, "onData", {
  get(this: SyntheticPinnedShapePty) {
    return (listener: (data: string) => void): { dispose(): void } => this.registerDataListener(listener);
  },
  configurable: true,
  enumerable: false,
});

/**
 * Host-independent on purpose: this exercises this file's own observation helper
 * against the property shapes the pinned implementation really has. It spawns
 * nothing, because the failure it prevents is a Windows spawn dying inside the
 * fixture before the created handle is ever recorded or handed to the manager.
 */
test("this file's handle observation shadows only kill and never assigns to the pinned getter-only onData accessor", async () => {
  const handle = new SyntheticPinnedShapePty();
  const pty = handle as unknown as InstancePty;
  const protoDescriptor = Object.getOwnPropertyDescriptor(SyntheticPinnedShapePty.prototype, "onData");
  assert.ok(protoDescriptor?.get, "the shape under test really is an accessor");
  assert.equal(protoDescriptor.set, undefined, "the shape under test really has no setter");
  // The premise: replacing `onData` by assignment is not available to any code
  // in this file, so an observer that tried would break every real spawn.
  assert.throws(() => {
    (handle as unknown as { onData: unknown }).onData = (): void => undefined;
  }, TypeError, "assignment to the pinned getter-only onData must throw in strict mode");

  let observation: HandleObservation | undefined;
  assert.doesNotThrow(() => {
    observation = observeRealHandle(pty);
  }, "installing the observation must never throw while a created handle is on its way to the manager");
  assert.ok(observation);
  assert.equal(observation.installFault, undefined, "a normal handle is observable without qualification");
  assert.equal(Object.prototype.hasOwnProperty.call(handle, "onData"), false,
    "the pinned accessor is never shadowed on the handle itself");
  assert.equal(handle.dataListenerTotal, 1, "output is witnessed by one added public listener, not a replaced accessor");

  // The handle's own public onData still works for everyone else, including the
  // manager's own data and error wiring.
  const seen: string[] = [];
  const other = pty.onData((data) => { seen.push(data); });
  handle.emitData("before");
  assert.deepEqual(seen, ["before"], "the pinned accessor still registers listeners normally");
  assert.equal(observation.dataAfterKill, false, "no post-kill output is claimed before any kill");

  pty.kill();
  pty.kill("SIGTERM");
  assert.deepEqual(observation.killCalls, [[], ["SIGTERM"]],
    "the kill-arity witness survives: the manager's Windows escalation carries no argument");
  assert.equal(handle.forwardedKills.length, 2, "every recorded kill is forwarded to the pinned method");
  assert.equal(handle.forwardedKills[0]?.receiver, handle, "the pinned method is called with the handle itself as receiver");
  assert.deepEqual(handle.forwardedKills[1]?.args, ["SIGTERM"], "the pinned method receives the caller's argument unchanged");
  handle.emitData("after");
  assert.equal(observation.dataAfterKill, true, "post-kill output is still witnessed");

  observation.restore();
  assert.equal(Object.prototype.hasOwnProperty.call(handle, "kill"), false,
    "restore removes the shadow and leaves the inherited pinned method in place");
  pty.kill("SIGHUP");
  assert.deepEqual(handle.forwardedKills[2]?.args, ["SIGHUP"], "the handle's own kill still works after restore");
  assert.equal(handle.dataListenerTotal, 1, "this file's own data listener was released, leaving only the other one");
  const witnessed = observation.dataAfterKill;
  handle.emitData("late");
  assert.equal(observation.dataAfterKill, witnessed, "a released observation witnesses nothing further");
  other.dispose();
});

/**
 * The other half of the same guarantee: an observation this file cannot install
 * is reported, never thrown. A handle whose own slot refuses to be shadowed must
 * still reach the harness registry and the manager, because a fixture that dies
 * mid-spawn is how a created child ends up unowned.
 */
test("an observation this file cannot install is reported as a fault instead of throwing before the handle is owned", async () => {
  const handle = new SyntheticPinnedShapePty();
  // A `kill` slot that cannot be shadowed at all: neither assignment nor
  // defineProperty can install anything over it.
  Object.defineProperty(handle, "kill", {
    value: (): void => undefined,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  let observation: HandleObservation | undefined;
  assert.doesNotThrow(() => {
    observation = observeRealHandle(handle as unknown as InstancePty);
  }, "an unshadowable slot must never break the spawn path");
  assert.ok(observation);
  assert.notEqual(observation.installFault, undefined, "the missing witness is reported, not silently accepted");
  assert.match(observation.installFault ?? "", /kill/u);
  assert.equal(Object.prototype.hasOwnProperty.call(handle, "onData"), false, "the pinned accessor is still untouched");
  assert.equal(handle.dataListenerTotal, 1, "output observation still works on its own public listener");
  observation.restore();
});

/**
 * One active-resource witness for the whole file, printed after its last case.
 *
 * A real Windows run of this file printed every case result and then never
 * settled, which no per-case assertion can show. This reports the facts that
 * separate the candidate causes instead of leaving them to inference: how many
 * owned ConPTY handles settled on an observed exit event, how many were killed
 * with a signal argument (the manager must never ask for one on Windows), how
 * many were killed with no output afterwards — the pinned `useConptyDll` path
 * disposes its ConPTY output worker only when post-kill output arrives, and that
 * worker owns a pipe server nothing in the pinned public API closes — and how
 * each handle's own process identity ended up: bound, sampled but never
 * reported, or never sampled by a case at all, which is stated separately
 * because an unsampled handle says nothing about the pinned implementation. Node's
 * own active handle and request counts complete the picture. Nothing here waits,
 * retries, forces an exit, or changes any lifecycle.
 *
 * The per-fixture reader-settlement line states what each fixture's manager
 * `dispose()` concluded. That confirmation — not post-kill output reaching the
 * pinned drain — is what releases the owned ConPTY reader now (#666), so it is the
 * fact that shows whether a fixture's host process could settle.
 */
after(() => {
  if (!isWindows) return;
  const handles = nativeHandleWitness.map((entry) => entry.handle);
  const count = (predicate: (handle: RealHandle) => boolean): number => handles.filter(predicate).length;
  const diagnosticProcess = process as NodeJS.Process & {
    _getActiveHandles?: () => unknown[];
    _getActiveRequests?: () => unknown[];
  };
  const summarize = (values: unknown[] | undefined): string => {
    if (values === undefined) return "unavailable";
    const totals = new Map<string, number>();
    for (const value of values) {
      const kind = (value as { constructor?: { name?: string } })?.constructor?.name ?? typeof value;
      totals.set(kind, (totals.get(kind) ?? 0) + 1);
    }
    return [...totals].map(([kind, total]) => `${kind}=${total}`).join(",") || "none";
  };
  // Which fixtures were killed with no output afterwards, by label: that is the
  // pinned condition under which the ConPTY output worker is never disposed.
  const unflushed = [...new Set(nativeHandleWitness
    .filter((entry) => entry.handle.observation.killCalls.length > 0 && !entry.handle.observation.dataAfterKill)
    .map((entry) => entry.label))];
  console.error(`prg-native-cli-windows: resource witness for ${handles.length} owned ConPTY handle(s): `
    + `${count((handle) => handle.exit !== undefined)} with an observed exit, `
    + `${count((handle) => handle.exit === undefined)} without one, `
    + `${count((handle) => handle.observation.killCalls.some((request) => request.length > 0))} killed with a signal argument (expected 0), `
    + `${unflushed.length} fixture(s) killed with no output after the kill `
    + `[${unflushed.join(", ") || "none"}] (the pinned useConptyDll path disposes its ConPTY output worker only on post-kill output, so each listed fixture can leave that worker thread and its pipe server alive), `
    + `${count((handle) => handle.handlePid !== undefined)} had a bound owned identity, `
    + `${count((handle) => handle.handlePid === undefined && handle.identitySampled === true)}/`
    + `${count((handle) => handle.identitySampled === true)} sampled handles never reported one, `
    + `${count((handle) => handle.identitySampled !== true)} were never sampled by a case, `
    + `${count((handle) => handle.consoleCloseNotice === true)} reported the console-close notification; `
    + `active libuv handles: ${summarize(diagnosticProcess._getActiveHandles?.())}; `
    + `active libuv requests: ${summarize(diagnosticProcess._getActiveRequests?.())}`);
  console.error(`prg-native-cli-windows: owned-reader settlement witness: `
    + (readerSettlementWitness.length === 0
      ? "no fixture reached manager disposal"
      : readerSettlementWitness.map((entry) => `${entry.label}=${entry.outcome}`).join("; ")));
});
