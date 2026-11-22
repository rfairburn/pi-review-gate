/**
 * #682: bounded Claude Code version evidence for one explicitly prepared
 * native launch.
 *
 * The native Claude inbox sender (./native-claude-inbox-delivery) speaks only
 * the wire format proven on the CLI versions in
 * `CLAUDE_INBOX_SUPPORTED_CLI_VERSIONS`. A trusted owner that wants callback
 * compatibility for a launch therefore needs evidence about the EXACT
 * executable that launch will spawn — never a guess from an environment
 * variable, a configured name, or the executable path. This module produces
 * that evidence and nothing else:
 *
 * - It runs the already-resolved, canonical executable once as
 *   `<file> --version`: no shell, stdin ignored, a hard wall-clock bound, and a
 *   hard combined stdout/stderr byte cap. The child runs in its own process
 *   group, which is SIGKILLed when either bound is crossed, and the result
 *   settles immediately, so a wedged or chatty executable (or a helper it
 *   started) can never hold the caller past the bound or outlive the decline.
 * - Only stdout is parsed, and only the exact official form
 *   `<major>.<minor>.<patch> (Claude Code)`; stderr bytes are counted against
 *   the cap and discarded. Neither stream's contents are ever logged, echoed in
 *   a reason, or returned: an outcome is a fixed code or one validated version
 *   string from the supported set.
 * - Every failure — spawn error, timeout, oversized output, nonzero exit,
 *   signal, unrecognized or unsupported version — is a `declined` outcome,
 *   never a thrown error, so the caller's ordinary launch is never failed by it.
 *
 * The caller owns eligibility (platform, target, prepared hooks) and must hand
 * in a probe environment that carries no per-launch hook bootstrap marker; this
 * module adds no argument beyond `--version` and no environment entry.
 */
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import { CLAUDE_INBOX_SUPPORTED_CLI_VERSIONS } from "./native-claude-inbox-delivery";

/**
 * Wall-clock bound for the Claude `--version` probe. Tighter than the native
 * Pi probe's window because this probe sits on an ordinary launch path that it
 * must never fail and should barely delay.
 */
export const CLAUDE_VERSION_PROBE_TIMEOUT_MS = 5_000;

/** Combined stdout+stderr byte cap; a real answer is one short line. */
export const CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES = 4 * 1024;

/** The single argument the probe ever passes. */
const VERSION_ARGS: readonly string[] = Object.freeze(["--version"]);

/**
 * Fixed system path of the optional direct-exec helper interpreter. It is never
 * searched on PATH (the launch PATH is target-controlled); if it is absent the
 * spawn fails and the probe declines.
 */
const SYSTEM_PYTHON = "/usr/bin/python3";

/**
 * Isolation flags for {@linkcode SYSTEM_PYTHON}: `-I` ignores every PYTHON*
 * variable, the user site directory, and the script/cwd path entry; `-S` skips
 * the `site` import; `-X utf8` fixes the payload and argv/env encoding.
 */
const SYSTEM_PYTHON_ARGS: readonly string[] = Object.freeze(["-I", "-S", "-X", "utf8", "-c"]);

/**
 * Direct-exec trampoline source, run by {@linkcode SYSTEM_PYTHON} with an EMPTY
 * startup environment and no argument beyond this fixed source. It reads one
 * JSON payload `{file, args, env}` from stdin — so the probe environment never
 * appears in any argv or in the helper's own startup environment — and replaces
 * itself with the target through `os.execve` (execve(2)).
 *
 * - Unlike the `execvp` path behind `child_process.spawn`, execve never retries
 *   a shebang-less executable text file through `/bin/sh` on ENOEXEC, so no
 *   shell can ever interpret the target.
 * - Unlike Node's `process.execve`, which aborts the process on any syscall
 *   failure (and could leave a core dump holding the payload), `os.execve`
 *   raises an ordinary `OSError`. Every failure — malformed payload, relative
 *   path, ENOEXEC, ENOENT (including a missing `#!` interpreter), EACCES, an
 *   unencodable or NUL-bearing value — exits normally with status 126 through
 *   `os._exit`, which the classifier reads as `version-unavailable`.
 * - The pid, and therefore the probe's own process group and pipes, carry over
 *   unchanged into the target.
 */
const DIRECT_EXEC_TRAMPOLINE = `import json, os, sys
try:
    request = json.load(sys.stdin)
    file = request["file"]
    args = request["args"]
    env = request["env"]
    if (not isinstance(file, str) or not os.path.isabs(file)
            or not isinstance(args, list) or not all(isinstance(a, str) for a in args)
            or not isinstance(env, dict)
            or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items())):
        os._exit(126)
    os.execve(file, [file, *args], env)
except BaseException:
    pass
os._exit(126)
`;

/** Exact official Claude Code `--version` stdout: one stable triple and the product tag. */
const CLAUDE_VERSION_STDOUT = /^(\d{1,6}\.\d{1,6}\.\d{1,6}) \(Claude Code\)\r?\n?$/u;

/** Bounds and context for one version command run. */
export interface NativeVersionCommandOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/**
 * The closed result of one bounded run. Only a `completed` run (exit status 0,
 * no signal) carries stdout, and only so the private classifier below can
 * parse it; it never leaves this module.
 */
export type NativeVersionCommandResult =
  | { readonly kind: "completed"; readonly stdout: string }
  | { readonly kind: "abnormal-exit" }
  | { readonly kind: "timeout" }
  | { readonly kind: "oversized" }
  | { readonly kind: "failed" };

/**
 * Runner seam for tests only: a synthetic runner supplies a result whose
 * stdout is test input. Production uses this module's private bounded runner,
 * which is deliberately not exported.
 */
export type NativeVersionCommandRunner = (
  file: string,
  args: readonly string[],
  options: NativeVersionCommandOptions,
) => Promise<NativeVersionCommandResult>;

/**
 * Run `file args` once with no shell and hard bounds. Never rejects, never
 * logs, never exposes output from an abnormal exit. The target is entered by
 * direct execve(2) through {@linkcode DIRECT_EXEC_TRAMPOLINE}, never by a
 * PATH search or an implicit `/bin/sh` retry.
 *
 * The child leads its own new process group (`detached`), so crossing
 * the time or byte bound — or a child error — SIGKILLs the WHOLE group: a
 * helper the executable started (and possibly waits on) is stopped with it
 * rather than left running beside the ordinary launch. The kill happens while
 * the leader is still unreaped or while a member still holds the group id, so
 * the group id cannot have been recycled. The result settles at once after the
 * kill and the pipes are released; it never waits for the group to exit. A
 * descendant that deliberately leaves the group (its own `setsid`) is outside
 * any process-group bound and is accepted residual risk.
 */
function runBoundedVersionCommand(
  file: string,
  args: readonly string[],
  options: NativeVersionCommandOptions,
): Promise<NativeVersionCommandResult> {
  // The direct-exec helper and the process-group bound are Linux facts; any
  // other platform is declined without spawning anything.
  if (process.platform !== "linux") return Promise.resolve({ kind: "failed" });
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn>;
    const killTree = (): void => {
      const pid = child.pid;
      if (pid !== undefined) {
        try { process.kill(-pid, "SIGKILL"); return; } catch { /* group already gone; fall through */ }
      }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    const finish = (result: NativeVersionCommandResult, kill: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (kill) {
        killTree();
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      resolve(result);
    };
    let payload: string;
    try {
      payload = JSON.stringify({ file, args: [...args], env: options.env });
      // The fixed-path helper runs only the fixed trampoline source; the target
      // file, its argv, and its environment travel privately on stdin.
      child = spawn(SYSTEM_PYTHON, [...SYSTEM_PYTHON_ARGS, DIRECT_EXEC_TRAMPOLINE], {
        env: {},
        cwd: options.cwd,
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      // Spawn validation errors can quote environment values; the result is a code only.
      resolve({ kind: "failed" });
      return;
    }
    // Monotonic deadline: a close observed at or after it is a timeout even if
    // the timer callback has not run yet (event-loop delay never extends the bound).
    const deadline = performance.now() + options.timeoutMs;
    const stdout: Buffer[] = [];
    let total = 0;
    const account = (chunk: Buffer, keep: boolean): void => {
      if (settled) return;
      total += chunk.length;
      if (total > options.maxOutputBytes) {
        finish({ kind: "oversized" }, true);
        return;
      }
      if (keep) stdout.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => account(chunk, true));
    child.stderr?.on("data", (chunk: Buffer) => account(chunk, false));
    // A read error before settlement means the captured output is incomplete:
    // never evidence. After a forced settle, `finish` ignores it.
    child.stdout?.on("error", () => finish({ kind: "failed" }, true));
    child.stderr?.on("error", () => finish({ kind: "failed" }, true));
    // A stdin failure before the payload is delivered means no exec happened.
    child.stdin?.on("error", () => finish({ kind: "failed" }, true));
    child.on("error", () => finish({ kind: "failed" }, true));
    child.on("close", (status: number | null, signal: NodeJS.Signals | null) => {
      if (performance.now() >= deadline) {
        finish({ kind: "timeout" }, false);
        return;
      }
      finish(status === 0 && signal === null
        ? { kind: "completed", stdout: Buffer.concat(stdout).toString("utf8") }
        : { kind: "abnormal-exit" }, false);
    });
    timer = setTimeout(() => finish({ kind: "timeout" }, true), options.timeoutMs);
    child.stdin?.end(payload);
  });
}

/** Closed reasons a requested Claude inbox compatibility was declined. */
export type NativeClaudeInboxCompatibilityDeclineReason =
  /** The launch is not a Claude launch. */
  | "not-claude-backend"
  /** The host platform is not one the inbox sender supports. */
  | "unsupported-platform"
  /** The launch is not the default Claude target (a configured command, wrapper, or profile). */
  | "not-default-target"
  /** This launch's Claude status hooks were not prepared, so no announcement can arrive. */
  | "status-hook-not-prepared"
  /** A lane-scoped request whose launch's native MCP option was not prepared (#682). */
  | "native-mcp-not-prepared"
  /** The version probe failed, timed out, overflowed its cap, or did not exit cleanly. */
  | "version-unavailable"
  /** The probe exited cleanly but its stdout is not the exact official version form. */
  | "version-unrecognized"
  /** The exact executable reports a version the inbox sender does not support. */
  | "version-unsupported";

/**
 * Outcome of an explicitly requested Claude inbox compatibility check. Only
 * `verified` is evidence: its `version` is one exact entry of
 * `CLAUDE_INBOX_SUPPORTED_CLI_VERSIONS`, observed from the exact canonical
 * executable this launch spawns. Anything else means callback compatibility
 * must be declined.
 */
export type NativeClaudeInboxCompatibilityOutcome =
  | { readonly compatibility: "verified"; readonly version: string }
  | { readonly compatibility: "declined"; readonly reason: NativeClaudeInboxCompatibilityDeclineReason };

/** Frozen decline outcome; reasons are fixed codes only. */
export function declineClaudeInboxCompatibility(
  reason: NativeClaudeInboxCompatibilityDeclineReason,
): NativeClaudeInboxCompatibilityOutcome {
  return Object.freeze({ compatibility: "declined", reason });
}

/**
 * Probe the exact canonical Claude executable and classify the result. Never
 * rejects: an unexpected runner failure is `version-unavailable`.
 */
export async function probeClaudeInboxCompatibility(input: {
  readonly file: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly runner?: NativeVersionCommandRunner;
}): Promise<NativeClaudeInboxCompatibilityOutcome> {
  const runner = input.runner ?? runBoundedVersionCommand;
  let result: NativeVersionCommandResult;
  try {
    result = await runner(input.file, VERSION_ARGS, {
      env: input.env,
      cwd: input.cwd,
      timeoutMs: CLAUDE_VERSION_PROBE_TIMEOUT_MS,
      maxOutputBytes: CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES,
    });
  } catch {
    return declineClaudeInboxCompatibility("version-unavailable");
  }
  if (result === null || typeof result !== "object" || result.kind !== "completed") {
    return declineClaudeInboxCompatibility("version-unavailable");
  }
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  const match = CLAUDE_VERSION_STDOUT.exec(stdout);
  if (match === null) return declineClaudeInboxCompatibility("version-unrecognized");
  const version = match[1];
  if (!CLAUDE_INBOX_SUPPORTED_CLI_VERSIONS.includes(version)) {
    return declineClaudeInboxCompatibility("version-unsupported");
  }
  return Object.freeze({ compatibility: "verified", version });
}
