/**
 * #233: hardened Git execution for checkpoints (extract from
 * git-checkpoint.ts). Argv-array spawn with no shell, minimal fixed
 * environment, fixed -c safety overrides, the config-only effective-autocrlf
 * probe mode, wall-clock timeout plus stdout byte caps, and the stdin
 * variant. No command here can execute an externally configured helper.
 */

import { spawn, type ChildProcess } from "node:child_process";

import { GitCheckpointError, messageOf, type GitCheckpointFailureReason } from "./errors";

// ── Hardened Git execution ───────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_PATCH_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_UNTRACKED_BYTES = 512 * 1024 * 1024;

/** Zero object ids by format — "the ref must not exist" for update-ref CAS. */
export const ZERO_OID_SHA1 = "0".repeat(40);
export const ZERO_OID_SHA256 = "0".repeat(64);

function hardenedEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LC_ALL: "C",
    // Replace user/system config entirely (also suppresses XDG discovery).
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    // Never prompt — fail instead.
    GIT_TERMINAL_PROMPT: "0",
    // Read commands must never write the index (stat cache, optional locks).
    GIT_OPTIONAL_LOCKS: "0",
    // A partial clone must never lazily fetch missing objects over the network.
    GIT_NO_LAZY_FETCH: "1",
    // Pinned SHAs must name raw objects; replace refs cannot rewrite them.
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_PAGER: "cat",
  };
}

/** Discover a parent review's Git root under the same isolated Git environment.
 * Retain the caller's explicit discovery ceiling for non-Git workspaces and tests,
 * but never inherit a repository/worktree redirect or ambient Git configuration.
 */
export function gitCheckpointDiscoveryEnv(): NodeJS.ProcessEnv {
  return {
    ...hardenedEnv(),
    ...(process.env.GIT_CEILING_DIRECTORIES === undefined ? {} : { GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES }),
  };
}

/**
 * core.filemode is platform-conditional. On NTFS the worktree permission
 * bits carry no Git-meaningful state, so `true` turns routine filesystem
 * noise into spurious mode-only diffs; `false` keeps the unstaged capture
 * clean while STAGED (index) mode changes remain fully captured in the
 * base→index patch — core.filemode only affects worktree↔index comparison.
 * POSIX keeps the repo convention of true (see src/execution/wave-repository.ts).
 */
export function coreFilemodeOverrideFor(platform: NodeJS.Platform): string {
  return platform === "win32" ? "core.filemode=false" : "core.filemode=true";
}

/** -c overrides prepended to every command (command line beats repo config). */
const SAFE_CONFIG_OVERRIDES = [
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.pager=cat",
  coreFilemodeOverrideFor(process.platform),
  // Tracked text uses Git-normalized bytes; expected CRLF normalization must
  // not emit safecrlf warnings that otherwise abort a valid diff capture.
  "core.safecrlf=false",
  "commit.gpgsign=false",
  "submodule.recurse=false",
  // Never descend into submodule repositories for diff display.
  "diff.submodule=short",
  // Capture and reconstruction must be independent of ambient diff config:
  // rename detection, coloring, and prefix rewriting would change the
  // captured patches or drop paths from changed-set computation.
  "diff.renames=false",
  "color.diff=never",
  "diff.noprefix=false",
  "diff.mnemonicPrefix=false",
  "diff.relative=false",
  // git apply must never rewrite patched bytes while writing the index.
  "apply.whitespace=nowarn",
  "gc.auto=0",
  "color.ui=false",
  // Every pin update must carry a reflog entry naming its arm generation:
  // release proves ownership of the CURRENT generation (see release docs),
  // and "always" extends automatic reflog creation beyond refs/heads.
  "core.logAllRefUpdates=always",
];

/**
 * Environment for the config-only effective-autocrlf probe. It inherits the
 * caller's environment so the probe sees the SAME configuration ordinary Git
 * in this process would (system, global, local — including
 * GIT_CONFIG_SYSTEM/GIT_CONFIG_GLOBAL overrides), but drops every variable
 * that could redirect it to a different repository, index, or object store.
 * `git config <key>` reads and prints one value; it cannot execute filters,
 * hooks, or diff helpers.
 */
function probeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete env[key];
  }
  env.LC_ALL = "C";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export interface GitRunSpec {
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  /** Reason reported when stdout exceeds maxBytes (default git_failed). */
  overflowReason?: GitCheckpointFailureReason;
  /** Extra environment entries layered over the hardened base environment. */
  extraEnv?: NodeJS.ProcessEnv;
  /**
   * Config-only probe mode: run WITHOUT the -c safety overrides and with an
   * environment that still sees ambient system/global/local configuration,
   * so the effective core.autocrlf can be read with ordinary precedence.
   * Only `git config <key>` ever runs in this mode (nothing it invokes can
   * execute filters, hooks, or diff helpers); every other hardening — no
   * shell, timeout, byte caps, abort — still applies.
   */
  probeConfig?: boolean;
  /**
   * Effective core.autocrlf frozen for this operation's capture commands:
   * passed as a final -c override so the quarantined (system/global =
   * /dev/null) environment keeps the live checkout's EOL semantics.
   */
  frozenAutocrlf?: string;
}

export interface GitRunOutput {
  stdout: Buffer;
  stderr: string;
  code: number;
}

const STDERR_CAP_BYTES = 8_192;

/**
 * Spawns `git --no-pager --no-replace-objects -c <safe overrides> ...args` in
 * `cwd` with the hardened environment. Resolves with capped raw output and
 * the exit code for any normal termination; rejects with GitCheckpointError
 * only on spawn failure, timeout, byte-cap overflow, or abort.
 */
export function runGit(
  gitPath: string,
  cwd: string,
  args: readonly string[],
  spec: GitRunSpec,
): Promise<GitRunOutput> {
  const hasAlternateIndex = typeof spec.extraEnv?.GIT_INDEX_FILE === "string" && spec.extraEnv.GIT_INDEX_FILE.length > 0;
  // Probe mode reads ambient config with ordinary precedence and applies no
  // -c overrides (they would change the very value being probed).
  const argv = ["--no-pager", "--no-replace-objects", ...(spec.probeConfig ? [] : configArgv(hasAlternateIndex, spec.frozenAutocrlf)), ...args];
  return new Promise<GitRunOutput>((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(gitPath, argv, {
        cwd,
        env: { ...(spec.probeConfig ? probeEnv() : hardenedEnv()), ...spec.extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new GitCheckpointError(`failed to start git: ${messageOf(error)}`, "git_failed"));
      return;
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (error: GitCheckpointError | null, output?: GitRunOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolvePromise(output!);
    };

    const kill = (): void => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish(new GitCheckpointError(`git ${args[0] ?? ""} timed out after ${spec.timeoutMs}ms`, "git_failed"));
    }, spec.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      kill();
      finish(new GitCheckpointError(`git ${args[0] ?? ""} was aborted`, "aborted"));
    };
    if (spec.signal?.aborted) {
      finish(new GitCheckpointError(`git ${args[0] ?? ""} was aborted`, "aborted"));
      return;
    }
    spec.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (stdout.length + chunk.length > spec.maxBytes) {
        kill();
        finish(new GitCheckpointError(
          `git ${args[0] ?? ""} output exceeded the ${spec.maxBytes}-byte cap`,
          spec.overflowReason ?? "git_failed",
        ));
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP_BYTES) {
        stderr = Buffer.concat([stderr, chunk]).subarray(0, STDERR_CAP_BYTES);
      }
    });

    child.on("error", (error) => {
      finish(new GitCheckpointError(`failed to run git: ${messageOf(error)}`, "git_failed"));
    });

    child.on("close", (code) => {
      if (settled || timedOut || aborted) return;
      if (code === null) {
        finish(new GitCheckpointError(`git ${args[0] ?? ""} was killed by a signal`, "git_failed"));
        return;
      }
      finish(null, { stdout, stderr: stderr.toString("utf8"), code });
    });
  });
}

function configArgv(disableSplitIndex = false, frozenAutocrlf?: string): string[] {
  const argv: string[] = [];
  for (const override of SAFE_CONFIG_OVERRIDES) {
    argv.push("-c", override);
  }
  // Last -c wins: the frozen effective value must beat any repo-local
  // core.autocrlf, because it IS that value computed with full precedence.
  if (frozenAutocrlf !== undefined) argv.push("-c", `core.autocrlf=${frozenAutocrlf}`);
  // Disposable alternate indexes must not publish sharedindex.* files outside
  // their owned scratch directory.
  if (disableSplitIndex) argv.push("-c", "core.splitIndex=false");
  return argv;
}

/**
 * runGit variant that feeds `input` to the child's stdin and closes it.
 * Used for `git apply`, which reads patches from standard input.
 */
export async function runGitWithInput(
  gitPath: string,
  cwd: string,
  args: readonly string[],
  input: Buffer,
  spec: GitRunSpec,
  extraEnv: NodeJS.ProcessEnv,
): Promise<GitRunOutput> {
  const hasAlternateIndex = (typeof spec.extraEnv?.GIT_INDEX_FILE === "string" && spec.extraEnv.GIT_INDEX_FILE.length > 0)
    || (typeof extraEnv.GIT_INDEX_FILE === "string" && extraEnv.GIT_INDEX_FILE.length > 0);
  const argv = ["--no-pager", "--no-replace-objects", ...configArgv(hasAlternateIndex, spec.frozenAutocrlf), ...args];
  return new Promise<GitRunOutput>((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(gitPath, argv, { cwd, env: { ...hardenedEnv(), ...spec.extraEnv, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(new GitCheckpointError(`failed to start git: ${messageOf(error)}`, "git_failed"));
      return;
    }
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (error: GitCheckpointError | null, output?: GitRunOutput): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      spec.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolvePromise(output!);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      finish(new GitCheckpointError(`git ${args[0] ?? ""} timed out after ${spec.timeoutMs}ms`, "git_failed"));
    }, spec.timeoutMs);
    const onAbort = (): void => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      finish(new GitCheckpointError(`git ${args[0] ?? ""} was aborted`, "aborted"));
    };
    if (spec.signal?.aborted) {
      finish(new GitCheckpointError(`git ${args[0] ?? ""} was aborted`, "aborted"));
      return;
    }
    spec.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (stdout.length + chunk.length > spec.maxBytes) {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
        finish(new GitCheckpointError(
          `git ${args[0] ?? ""} output exceeded the ${spec.maxBytes}-byte cap`,
          spec.overflowReason ?? "git_failed",
        ));
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP_BYTES) stderr = Buffer.concat([stderr, chunk]).subarray(0, STDERR_CAP_BYTES);
    });
    child.on("error", (error) => finish(new GitCheckpointError(`failed to run git: ${messageOf(error)}`, "git_failed")));
    child.on("close", (code) => {
      if (settled) return;
      if (code === null) { finish(new GitCheckpointError(`git ${args[0] ?? ""} was killed by a signal`, "git_failed")); return; }
      finish(null, { stdout, stderr: stderr.toString("utf8"), code });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input);
  });
}
