import assert from "node:assert/strict";
import childProcess = require("node:child_process");
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { CLAUDE_INBOX_SUPPORTED_CLI_VERSIONS } from "../src/session-host/native-claude-inbox-delivery";
import {
  CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES,
  CLAUDE_VERSION_PROBE_TIMEOUT_MS,
  probeClaudeInboxCompatibility,
  type NativeClaudeInboxCompatibilityOutcome,
  type NativeVersionCommandOptions,
  type NativeVersionCommandResult,
  type NativeVersionCommandRunner,
} from "../src/session-host/native-claude-version-probe";
import {
  createNativeCliLauncher,
  type NativeCliLauncherOptions,
} from "../src/session-host/native-cli-launch";
import { NATIVE_HOOK_BOOTSTRAP_ENV, type NativeHookBootstrap } from "../src/session-host/native-hook-protocol";
import { type NativeHookLaunchOutcome } from "../src/session-host/native-hook-launch-prep";

/**
 * #682: explicitly requested Claude inbox compatibility evidence.
 *
 * Launcher cases inject a synthetic version runner, so no Claude process ever
 * runs and no provider prompt, configuration, or credential is touched. The
 * real bounded runner is exercised only against tiny `/bin/sh` fixtures under
 * the system temporary directory (Linux-only), never a provider CLI. Every
 * fixture and staged hook artifact is removed in `finally`.
 */

const SUPPORTED = CLAUDE_INBOX_SUPPORTED_CLI_VERSIONS[0]!;
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

function bootstrapFor(backend: "claude" | "codex"): NativeHookBootstrap {
  return {
    version: 1,
    socketPath: "/tmp/prg-synthetic-status-broker.sock",
    generation: "22222222-2222-4222-8222-222222222222",
    instanceId: "11111111-1111-4111-8111-111111111111",
    backend,
    token: TOKEN,
  };
}

async function fixture(run: (root: string, bin: string, workspace: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-claude-version-probe-")));
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  await mkdir(bin, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try { await run(root, bin, workspace); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function script(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

/** A never-invoked executable: resolution only inspects filesystem evidence. */
const fakeExecutable = (path: string): Promise<void> => script(path, "echo never invoked; exit 3");

function configWith(externalAgents: Record<string, unknown>): ReviewGateConfig {
  return normalizeConfig({ enabled: true, externalAgents });
}

interface RecordedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: NativeVersionCommandOptions;
}

/** A synthetic runner that records every call and answers with a fixed result. */
function syntheticRunner(answer: NativeVersionCommandResult | (() => Promise<NativeVersionCommandResult>)): {
  runner: NativeVersionCommandRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: NativeVersionCommandRunner = async (file, args, options) => {
    calls.push({ file, args: [...args], options: { ...options, env: { ...options.env } } });
    return typeof answer === "function" ? answer() : answer;
  };
  return { runner, calls };
}

/** Synthetic runner answers: stdout here is test INPUT only. */
const completed = (stdout: string): NativeVersionCommandResult => ({ kind: "completed", stdout });

async function releaseHook(outcome: NativeHookLaunchOutcome | undefined): Promise<void> {
  if (outcome?.observation === "prepared") await outcome.lease.cleanup();
}

function declined(outcome: NativeClaudeInboxCompatibilityOutcome | undefined): string {
  assert.equal(outcome?.compatibility, "declined", `expected a declined outcome, got ${JSON.stringify(outcome)}`);
  if (outcome?.compatibility !== "declined") throw new Error("unreachable");
  return outcome.reason;
}

function launcherFor(runner: NativeVersionCommandRunner, extra: NativeCliLauncherOptions = {}, config = configWith({})) {
  return createNativeCliLauncher(config, { platform: "linux", claudeVersionCommandRunner: runner, ...extra });
}

test("an ordinary or false request runs no probe and composes the exact unrequested descriptor", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "claude"));
    const { runner, calls } = syntheticRunner(completed(`${SUPPORTED} (Claude Code)\n`));
    const launcher = launcherFor(runner);
    const plain = await launcher("claude", { workspace, env: { PATH: bin } });
    const off = await launcher("claude", { workspace, env: { PATH: bin }, claudeInboxCompatibility: false });
    assert.equal("claudeInboxCompatibility" in plain, false);
    assert.equal("claudeInboxCompatibility" in off, false);
    assert.deepEqual(off, plain);

    // An armed hook alone never implies a probe either.
    const hooked = await launcher("claude", { workspace, env: { PATH: bin }, nativeHook: { bootstrap: bootstrapFor("claude") } });
    try {
      assert.equal(hooked.nativeHook?.observation, "prepared");
      assert.equal("claudeInboxCompatibility" in hooked, false);
    } finally {
      await releaseHook(hooked.nativeHook);
    }
    assert.equal(calls.length, 0, "no request, no probe");
  });
});

test("a prepared Linux default Claude launch probes its exact canonical file once and verifies the supported version", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "claude"));
    const { runner, calls } = syntheticRunner(completed(`${SUPPORTED} (Claude Code)\n`));
    const launcher = launcherFor(runner);
    const env = { PATH: bin, HOME: "/operator/home" };
    const baseline = await launcher("claude", { workspace, env, nativeHook: { bootstrap: bootstrapFor("claude") } });
    try {
      const requested = await launcher("claude", {
        workspace, env, nativeHook: { bootstrap: bootstrapFor("claude") }, claudeInboxCompatibility: true,
      });
      try {
        assert.deepEqual(requested.claudeInboxCompatibility, { compatibility: "verified", version: SUPPORTED });
        assert.ok(Object.isFrozen(requested.claudeInboxCompatibility));

        assert.equal(calls.length, 1);
        const [call] = calls;
        assert.equal(call!.file, requested.file, "the probe runs the descriptor's own canonical file");
        assert.equal(call!.file, await realpath(join(bin, "claude")));
        assert.deepEqual(call!.args, ["--version"]);
        assert.equal(call!.options.cwd, requested.cwd);
        assert.equal(call!.options.timeoutMs, CLAUDE_VERSION_PROBE_TIMEOUT_MS);
        assert.equal(call!.options.maxOutputBytes, CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES);
        // No hook bootstrap marker or token reaches the probe in any form.
        assert.equal(Object.keys(call!.options.env).some((name) => /NATIVE_HOOK_BOOTSTRAP/iu.test(name)), false);
        assert.equal(Object.values(call!.options.env).some((value) => typeof value === "string" && value.includes(TOKEN)), false);
        assert.equal(call!.options.env.HOME, "/operator/home");

        // The launch itself is unchanged: same env (fresh marker included), same
        // argv shape (only the per-launch artifact path differs), same file/cwd.
        assert.equal(requested.file, baseline.file);
        assert.equal(requested.cwd, baseline.cwd);
        assert.deepEqual(requested.env, baseline.env);
        assert.ok(requested.env[NATIVE_HOOK_BOOTSTRAP_ENV]?.includes(TOKEN), "the child still receives its own marker");
        assert.equal(requested.nativeHook?.observation, "prepared");
        if (requested.nativeHook?.observation === "prepared") {
          assert.deepEqual(requested.args, [...requested.nativeHook.args]);
        }
        assert.equal(requested.args.length, baseline.args.length);
      } finally {
        await releaseHook(requested.nativeHook);
      }
    } finally {
      await releaseHook(baseline.nativeHook);
    }
  });
});

test("ineligible requests are declined without running anything", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    const { runner, calls } = syntheticRunner(completed(`${SUPPORTED} (Claude Code)\n`));
    const config = configWith({ wrapper: { adapter: "claude-cli", command: join(bin, "claude"), review: {} } });

    // Codex never probes.
    const codex = await launcherFor(runner, {}, config)("codex", { workspace, env: { PATH: bin }, claudeInboxCompatibility: true });
    assert.equal(declined(codex.claudeInboxCompatibility), "not-claude-backend");

    // Other platforms never probe, even with prepared hooks.
    const mac = await launcherFor(runner, { platform: "darwin" })("claude", {
      workspace, env: { PATH: bin }, nativeHook: { bootstrap: bootstrapFor("claude") }, claudeInboxCompatibility: true,
    });
    try {
      assert.equal(mac.nativeHook?.observation, "prepared");
      assert.equal(declined(mac.claudeInboxCompatibility), "unsupported-platform");
    } finally {
      await releaseHook(mac.nativeHook);
    }

    // A configured command/wrapper target never probes, even for the very same file.
    const external = await launcherFor(runner, {}, config)("claude", {
      workspace, env: { PATH: bin }, targetId: "external:wrapper", nativeHook: { bootstrap: bootstrapFor("claude") }, claudeInboxCompatibility: true,
    });
    try {
      assert.equal(declined(external.claudeInboxCompatibility), "not-default-target");
    } finally {
      await releaseHook(external.nativeHook);
    }

    // No prepared status hook, no probe.
    const unhooked = await launcherFor(runner)("claude", { workspace, env: { PATH: bin }, claudeInboxCompatibility: true });
    assert.equal(declined(unhooked.claudeInboxCompatibility), "status-hook-not-prepared");
    const plain = await launcherFor(runner)("claude", { workspace, env: { PATH: bin } });
    const { claudeInboxCompatibility: _ignored, ...rest } = unhooked;
    assert.deepEqual(rest, plain, "a declined request changes nothing else");

    assert.equal(calls.length, 0);
  });
});

test("unsupported, unrecognized, and failed probes decline compatibility without failing the launch", async () => {
  const cases: Array<{ label: string; answer: NativeVersionCommandResult | (() => Promise<NativeVersionCommandResult>); reason: string }> = [
    { label: "older version", answer: completed("2.1.329 (Claude Code)\n"), reason: "version-unsupported" },
    { label: "newer version", answer: completed("2.1.331 (Claude Code)\n"), reason: "version-unsupported" },
    { label: "bare triple", answer: completed(`${SUPPORTED}\n`), reason: "version-unrecognized" },
    { label: "prerelease", answer: completed(`${SUPPORTED}-beta (Claude Code)\n`), reason: "version-unrecognized" },
    { label: "noise before", answer: completed(`node 24.1.0\n${SUPPORTED} (Claude Code)\n`), reason: "version-unrecognized" },
    { label: "empty", answer: completed(""), reason: "version-unrecognized" },
    { label: "abnormal exit", answer: { kind: "abnormal-exit" }, reason: "version-unavailable" },
    { label: "timeout", answer: { kind: "timeout" }, reason: "version-unavailable" },
    { label: "oversized", answer: { kind: "oversized" }, reason: "version-unavailable" },
    { label: "spawn failure", answer: { kind: "failed" }, reason: "version-unavailable" },
    { label: "runner rejects", answer: () => Promise.reject(new Error(`leaked ${TOKEN}`)), reason: "version-unavailable" },
  ];
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "claude"));
    for (const { label, answer, reason } of cases) {
      const { runner, calls } = syntheticRunner(answer);
      const descriptor = await launcherFor(runner)("claude", {
        workspace, env: { PATH: bin }, nativeHook: { bootstrap: bootstrapFor("claude") }, claudeInboxCompatibility: true,
      });
      try {
        assert.equal(calls.length, 1, label);
        assert.equal(declined(descriptor.claudeInboxCompatibility), reason, label);
        assert.deepEqual(Object.keys(descriptor.claudeInboxCompatibility!).sort(), ["compatibility", "reason"], `${label}: no output is carried`);
        assert.equal(descriptor.nativeHook?.observation, "prepared", `${label}: the launch still succeeds`);
      } finally {
        await releaseHook(descriptor.nativeHook);
      }
    }
  });
});

test("malformed requests and runner options are refused before any work", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "claude"));
    const { runner, calls } = syntheticRunner(completed(`${SUPPORTED} (Claude Code)\n`));
    await assert.rejects(
      launcherFor(runner)("claude", { workspace, env: { PATH: bin }, claudeInboxCompatibility: "yes" as unknown as boolean }),
      /Claude inbox compatibility request must be a boolean or absent/u,
    );
    assert.throws(
      () => createNativeCliLauncher(configWith({}), { claudeVersionCommandRunner: "probe" as unknown as NativeVersionCommandRunner }),
      /Claude version command runner launcher option must be a function or absent/u,
    );
    assert.equal(calls.length, 0);
  });
});

const linuxOnly = {
  skip: process.platform !== "linux"
    ? "the real bounded runner is exercised on Linux only"
    : !existsSync("/usr/bin/python3")
      ? "the optional fixed-path direct-exec helper is unavailable"
      : false,
};

/** True once `pid` no longer exists or is only an unreaped zombie. */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}

async function waitUntilGone(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (processGone(pid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return processGone(pid);
}

async function helperPid(pidFile: string): Promise<number> {
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(pid) && pid > 1, "the fixture recorded its helper pid");
  return pid;
}

test("the real bounded probe passes only --version without a shell and classifies every exit", linuxOnly, async () => {
  await fixture(async (root, bin) => {
    const probe = (file: string) => probeClaudeInboxCompatibility({ file, env: { PATH: "/usr/bin:/bin" }, cwd: root });

    // Verified only when argv is exactly `--version`; stderr noise is ignored.
    const exact = join(bin, "exact");
    await script(exact, [
      `if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then echo "${SUPPORTED} (Claude Code)"; echo diagnostic >&2; exit 0; fi`,
      "exit 9",
    ].join("\n"));
    assert.deepEqual(await probe(exact), { compatibility: "verified", version: SUPPORTED });

    // Executable text WITHOUT a shebang would print the supported version if a
    // shell interpreted it (glibc execvp's ENOEXEC retry); the direct execve
    // probe never lets a shell run it, so it must decline.
    const noShebang = join(bin, "no-shebang");
    await writeFile(noShebang, `echo "${SUPPORTED} (Claude Code)"\n`);
    await chmod(noShebang, 0o755);
    assert.deepEqual(await probe(noShebang), { compatibility: "declined", reason: "version-unavailable" });

    // A non-executable file is never run either.
    const notExecutable = join(bin, "not-executable");
    await writeFile(notExecutable, `#!/bin/sh\necho "${SUPPORTED} (Claude Code)"\n`);
    await chmod(notExecutable, 0o644);
    assert.deepEqual(await probe(notExecutable), { compatibility: "declined", reason: "version-unavailable" });

    // The probe environment reaches the target exactly (via the private stdin payload).
    const envCheck = join(bin, "env-check");
    await script(envCheck, `if [ "\${PRG_PROBE_FIXTURE:-}" = "exact value" ]; then echo "${SUPPORTED} (Claude Code)"; exit 0; fi; exit 8`);
    assert.deepEqual(
      await probeClaudeInboxCompatibility({ file: envCheck, env: { PATH: "/usr/bin:/bin", PRG_PROBE_FIXTURE: "exact value" }, cwd: root }),
      { compatibility: "verified", version: SUPPORTED },
    );
    assert.deepEqual(await probe(envCheck), { compatibility: "declined", reason: "version-unavailable" });

    // A valid-looking answer with a nonzero status is never evidence.
    const failing = join(bin, "failing");
    await script(failing, `echo "${SUPPORTED} (Claude Code)"; exit 7`);
    assert.deepEqual(await probe(failing), { compatibility: "declined", reason: "version-unavailable" });

    const noisy = join(bin, "noisy");
    await script(noisy, `echo "launcher banner"; echo "${SUPPORTED} (Claude Code)"`);
    assert.deepEqual(await probe(noisy), { compatibility: "declined", reason: "version-unrecognized" });

    assert.deepEqual(await probe(join(bin, "missing")), { compatibility: "declined", reason: "version-unavailable" });
  });
});

test("exec failures decline through a normal helper exit, never an abort", linuxOnly, async (t) => {
  const tracedSpawn = t.mock.method(childProcess, "spawn");
  await fixture(async (root, bin) => {
    // A shebang naming a missing interpreter passes any header check, then
    // execve fails with ENOENT; the helper must exit normally (no SIGABRT, so
    // no core dump can hold the payload it read).
    const broken = join(bin, "broken-interpreter");
    await writeFile(broken, `#!${join(bin, "missing")}\necho "${SUPPORTED} (Claude Code)"\n`);
    await chmod(broken, 0o755);
    const noShebang = join(bin, "no-shebang");
    await writeFile(noShebang, `echo "${SUPPORTED} (Claude Code)"\n`);
    await chmod(noShebang, 0o755);
    for (const file of [broken, noShebang, join(bin, "absent")]) {
      assert.deepEqual(
        await probeClaudeInboxCompatibility({ file, env: { PRG_SECRET_LIKE: "never in argv" }, cwd: root }),
        { compatibility: "declined", reason: "version-unavailable" },
      );
    }
  });
  assert.equal(tracedSpawn.mock.calls.length, 3);
  for (const call of tracedSpawn.mock.calls) {
    const [command, argv, spawnOptions] = call.arguments as unknown as [string, string[], childProcess.SpawnOptions];
    assert.equal(command, "/usr/bin/python3", "the helper is a fixed path, never a PATH search");
    assert.equal(argv.some((arg) => arg.includes("never in argv")), false, "the probe env never reaches the helper argv");
    assert.deepEqual(spawnOptions.env, {}, "the helper starts with an empty environment");
    const child = call.result as childProcess.ChildProcess;
    assert.equal(child.signalCode, null, "no abort or other signal");
    assert.equal(child.exitCode, 126);
  }
});

/** A synthetic child for the mocked spawn: no process, helper, or provider ever runs. */
function syntheticChild() {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const { PassThrough } = require("node:stream") as typeof import("node:stream");
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kills: 0,
    kill(): boolean { child.kills += 1; return true; },
    unref(): void { /* nothing to release */ },
  });
  return child;
}

const nextTurn = (): Promise<void> => new Promise((resolveTurn) => setImmediate(resolveTurn));

test("a stdout/stderr read error or a clean close past the monotonic deadline is never evidence", { skip: process.platform !== "linux" ? "the bounded runner is Linux-only" : false }, async (t) => {
  const answer = Buffer.from(`${SUPPORTED} (Claude Code)\n`);
  const children: Array<ReturnType<typeof syntheticChild>> = [];
  t.mock.method(childProcess, "spawn", () => {
    const child = syntheticChild();
    children.push(child);
    return child;
  });
  const now = t.mock.method(performance, "now");
  let clock = 1_000;
  now.mock.mockImplementation(() => clock);
  const probe = () => probeClaudeInboxCompatibility({ file: "/synthetic/claude", env: {}, cwd: "/" });

  // Control: a clean close inside the deadline verifies, so the harness is live.
  const control = probe();
  const controlChild = children.at(-1)!;
  controlChild.stdout.write(answer);
  await nextTurn();
  clock += CLAUDE_VERSION_PROBE_TIMEOUT_MS - 1;
  controlChild.emit("close", 0, null);
  assert.deepEqual(await control, { compatibility: "verified", version: SUPPORTED });

  // A clean-looking close observed after the deadline, before the timer fired.
  const late = probe();
  const lateChild = children.at(-1)!;
  lateChild.stdout.write(answer);
  await nextTurn();
  clock += CLAUDE_VERSION_PROBE_TIMEOUT_MS;
  lateChild.emit("close", 0, null);
  assert.deepEqual(await late, { compatibility: "declined", reason: "version-unavailable" });

  // A read error on either stream before settlement fails the probe and kills the child.
  for (const stream of ["stdout", "stderr"] as const) {
    const errored = probe();
    const erroredChild = children.at(-1)!;
    erroredChild.stdout.write(answer);
    await nextTurn();
    erroredChild[stream].emit("error", new Error("synthetic read failure"));
    erroredChild.emit("close", 0, null);
    assert.deepEqual(await errored, { compatibility: "declined", reason: "version-unavailable" }, stream);
    assert.equal(erroredChild.kills, 1, `${stream}: the child is killed`);
  }
});

test("an oversized probe stops its whole process group, including a helper it started", linuxOnly, async () => {
  await fixture(async (root, bin) => {
    const pidFile = join(root, "helper.pid");
    const chatty = join(bin, "chatty");
    // The helper is NOT the direct child: it is a background sibling left in the group.
    await script(chatty, `sleep 30 & echo $! > '${pidFile}'; exec yes`);
    const outcome = await probeClaudeInboxCompatibility({ file: chatty, env: { PATH: "/usr/bin:/bin" }, cwd: root });
    assert.deepEqual(outcome, { compatibility: "declined", reason: "version-unavailable" });
    const pid = await helperPid(pidFile);
    try {
      assert.ok(await waitUntilGone(pid, 3_000), "the helper does not outlive the decline");
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }

    // stderr counts against the same cap.
    const chattyErr = join(bin, "chatty-stderr");
    await script(chattyErr, "exec yes >&2");
    assert.deepEqual(
      await probeClaudeInboxCompatibility({ file: chattyErr, env: { PATH: "/usr/bin:/bin" }, cwd: root }),
      { compatibility: "declined", reason: "version-unavailable" },
    );
  });
});

test("a timed-out probe settles at its bound and stops the helper the direct child waits on", linuxOnly, async () => {
  await fixture(async (root, bin) => {
    const pidFile = join(root, "helper.pid");
    const waiter = join(bin, "waiter");
    // No `exec`: the shell stays the direct child and waits on its helper.
    await script(waiter, `sleep 30 & echo $! > '${pidFile}'; wait`);
    const started = Date.now();
    const outcome = await probeClaudeInboxCompatibility({ file: waiter, env: { PATH: "/usr/bin:/bin" }, cwd: root });
    const elapsed = Date.now() - started;
    assert.deepEqual(outcome, { compatibility: "declined", reason: "version-unavailable" });
    assert.ok(elapsed >= CLAUDE_VERSION_PROBE_TIMEOUT_MS - 100, "it waited for the bound");
    assert.ok(elapsed < CLAUDE_VERSION_PROBE_TIMEOUT_MS + 2_000, "and settled promptly after it");
    const pid = await helperPid(pidFile);
    try {
      assert.ok(await waitUntilGone(pid, 3_000), "the waited-on helper is stopped with the group");
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  });
});

test("an end-to-end prepared launch with the real runner verifies only from the exact file, never the marker", linuxOnly, async () => {
  await fixture(async (_root, bin, workspace) => {
    // The fixture answers like the supported CLI unless it can see a hook marker.
    await script(join(bin, "claude"), [
      `if [ -n "\${${NATIVE_HOOK_BOOTSTRAP_ENV}:-}" ]; then echo leaked; exit 0; fi`,
      `if [ "$1" = "--version" ] && [ "$#" -eq 1 ]; then echo "${SUPPORTED} (Claude Code)"; exit 0; fi`,
      "exit 9",
    ].join("\n"));
    const launcher = createNativeCliLauncher(configWith({}), { platform: "linux" });
    const descriptor = await launcher("claude", {
      workspace, env: { PATH: bin }, nativeHook: { bootstrap: bootstrapFor("claude") }, claudeInboxCompatibility: true,
    });
    try {
      assert.deepEqual(descriptor.claudeInboxCompatibility, { compatibility: "verified", version: SUPPORTED });
    } finally {
      await releaseHook(descriptor.nativeHook);
    }

    // The same probe against an unsupported answer declines.
    const other = join(bin, "other-claude");
    await script(other, `echo "0.0.1 (Claude Code)"`);
    assert.deepEqual(
      await probeClaudeInboxCompatibility({ file: other, env: { PATH: bin }, cwd: workspace }),
      { compatibility: "declined", reason: "version-unsupported" },
    );
  });
});
