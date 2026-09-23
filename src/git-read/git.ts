/**
 * Hardened Git execution core for the GitRead tool (#73).
 *
 * Every Git invocation made by GitRead goes through this module. The
 * hardening contract:
 *
 * - spawn with an argv array, never a shell; stdin is "ignore" so no command
 *   can ever become interactive or read untrusted input.
 * - Minimal fixed environment. Inherited GIT_*, XDG_*, and HOME variables are
 *   dropped (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, and friends could redirect git to another
 *   repository or index, and a hostile HOME/user config could re-enable
 *   programs), user and system config files are replaced with /dev/null,
 *   terminal prompts and pagers are disabled, optional lock/index-refresh
 *   writes are off (GIT_OPTIONAL_LOCKS=0), promisor lazy fetch is off
 *   (GIT_NO_LAZY_FETCH=1) so a partial clone can never trigger network I/O,
 *   and replace refs are disabled (GIT_NO_REPLACE_OBJECTS=1 plus the global
 *   --no-replace-objects flag) so pinned SHAs always name the raw objects.
 * - Fixed `-c` overrides that take precedence over hostile repository config:
 *   fsmonitor, untracked cache, pager, gpg signing, submodule recursion,
 *   diff.submodule=short (the parent never shells into submodule
 *   repositories, whose configs are unaudited), auto gc, and color.
 *   `--no-pager` and `--no-replace-objects` are added to every argv.
 * - Every command runs under a wall-clock timeout and a stdout byte cap; both
 *   kill the child and surface an explicit error. Non-zero exits are returned
 *   (not thrown) so callers can interpret them (e.g. `git grep` exit 1 means
 *   "no matches").
 * - Diff program prevention is layered. Every diff-producing invocation passes
 *   --no-ext-diff --no-textconv, so a configured external diff command or
 *   textconv program can never run regardless of what .gitattributes selects.
 *   Independently, before any action runs, the effective repository
 *   configuration is scanned and the repository is refused fail-closed when it
 *   defines diff programs (`diff.external`, `diff.<driver>.command`, or
 *   `diff.<driver>.textconv`, where <driver> may itself contain dots — git
 *   splits driver keys at the last dot). Refusing keeps results trustworthy
 *   even for consumers that do not pass the command-line flags. Clean/smudge
 *   filters are deliberately not refused: they run on checkout/add/commit, none
 *   of which GitRead performs; worktree-mutating actions (status / worktree
 *   diff) are unsupported for exactly this reason (see the `status` action
 *   rationale).
 *
 * POSIX only — the extension launcher and scripts already assume it.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";

/** Error with a stable machine-readable code for GitRead failures. */
export class GitReadError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "GitReadError";
  }
}

/** The well-known empty tree object id (diff base for root commits). */
export const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Minimal fixed environment for every git child. Nothing else is inherited:
 * PATH (to locate the git binary) plus the hardening switches. Values are all
 * constants — no caller or repository input can influence them.
 */
function hardenedEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LC_ALL: "C",
    // Replace user/system config entirely (also suppresses XDG discovery).
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    // Never prompt (credentials, overwrite confirmations) — fail instead.
    GIT_TERMINAL_PROMPT: "0",
    // No optional index refresh / mtime-cache writes from read commands.
    GIT_OPTIONAL_LOCKS: "0",
    // A partial clone must never lazily fetch missing objects over the network.
    GIT_NO_LAZY_FETCH: "1",
    // Never substitute replaced objects: pinned SHAs must name the raw object,
    // so refs/replace/* cannot rewrite what a result reports as authoritative.
    GIT_NO_REPLACE_OBJECTS: "1",
    // Pagers are impossible; belt-and-suspenders with --no-pager/core.pager.
    GIT_PAGER: "cat",
  };
}

/** -c overrides prepended to every command (command line beats repo config). */
const SAFE_CONFIG_OVERRIDES = [
  "core.fsmonitor=false",
  "core.untrackedCache=false",
  "core.pager=cat",
  "commit.gpgsign=false",
  "submodule.recurse=false",
  // Never descend into submodule repositories for diff display: their local
  // configs are outside this audit and could define diff programs.
  "diff.submodule=short",
  "gc.auto=0",
  "color.ui=false",
];

export interface GitRunOptions {
  /** Wall-clock cap for the whole command. */
  timeoutMs: number;
  /** Hard stdout byte cap; exceeding it kills the child and rejects. */
  maxBytes: number;
  signal?: AbortSignal;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
  durationMs: number;
}

const STDERR_CAP_BYTES = 8_192;

/**
 * Spawns `git --no-pager --no-replace-objects -c <safe overrides> ...args` in
 * `cwd` with the hardened environment. Resolves with the (capped) output and
 * exit code for any normal termination; rejects only on timeout, byte-cap
 * overflow, abort, or spawn failure — always with a GitReadError.
 */
export function runGit(
  gitPath: string,
  cwd: string,
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitRunResult> {
  const argv = ["--no-pager", "--no-replace-objects", ...configArgv(), ...args];
  return new Promise<GitRunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(gitPath, argv, {
        cwd,
        env: hardenedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new GitReadError(`failed to start git: ${messageOf(error)}`, "spawn_failed"));
      return;
    }

    const startedAt = Date.now();
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (error: GitReadError | null, result?: GitRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };

    const kill = (): void => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish(new GitReadError(
        `git ${args[0] ?? ""} timed out after ${options.timeoutMs}ms; narrow the query or raise the timeout`,
        "timeout",
      ));
    }, options.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      kill();
      finish(new GitReadError(`git ${args[0] ?? ""} was aborted`, "aborted"));
    };
    if (options.signal?.aborted) {
      finish(new GitReadError(`git ${args[0] ?? ""} was aborted`, "aborted"));
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (stdout.length + chunk.length > options.maxBytes) {
        kill();
        finish(new GitReadError(
          `git ${args[0] ?? ""} output exceeded the ${options.maxBytes}-byte cap; narrow the query (paths, limit, or date range)`,
          "output_too_large",
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
      finish(new GitReadError(`failed to run git: ${messageOf(error)}`, "spawn_failed"));
    });

    child.on("close", (code) => {
      if (settled || timedOut || aborted) return;
      if (code === null) {
        finish(new GitReadError(`git ${args[0] ?? ""} was killed by a signal`, "killed"));
        return;
      }
      finish(null, {
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        code,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export interface GitBytePrefixResult {
  /** Up to `maxBytes` raw stdout bytes (the exact buffered prefix). */
  bytes: Buffer;
  /** True when output exceeded maxBytes and the child was killed. */
  truncated: boolean;
}

/**
 * Bounded byte-prefix probe over a hardened git command. Streams stdout until
 * `maxBytes` bytes have arrived, then kills the child and resolves with the
 * buffered prefix — the remaining output is never buffered, so an arbitrarily
 * large object can be inspected at a fixed memory bound. Used for binary
 * detection on over-cap blobs (a NUL byte anywhere in the probed prefix marks
 * binary content). Rejects only on timeout, abort, or spawn failure (always
 * GitReadError); the child's exit code is deliberately not interpreted.
 */
export function runGitBytePrefix(
  gitPath: string,
  cwd: string,
  args: readonly string[],
  options: GitRunOptions,
): Promise<GitBytePrefixResult> {
  const argv = ["--no-pager", "--no-replace-objects", ...configArgv(), ...args];
  return new Promise<GitBytePrefixResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(gitPath, argv, {
        cwd,
        env: hardenedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new GitReadError(`failed to start git: ${messageOf(error)}`, "spawn_failed"));
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let bytes = Buffer.alloc(0);
    let truncated = false;

    const finish = (error: GitReadError | null, result?: GitBytePrefixResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };

    const kill = (): void => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish(new GitReadError(
        `git ${args[0] ?? ""} timed out after ${options.timeoutMs}ms; narrow the query or raise the timeout`,
        "timeout",
      ));
    }, options.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      kill();
      finish(new GitReadError(`git ${args[0] ?? ""} was aborted`, "aborted"));
    };
    if (options.signal?.aborted) {
      finish(new GitReadError(`git ${args[0] ?? ""} was aborted`, "aborted"));
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      if (bytes.length + chunk.length > options.maxBytes) {
        truncated = true;
        bytes = Buffer.concat([bytes, chunk]).subarray(0, options.maxBytes);
        kill();
        finish(null, { bytes, truncated });
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
    });
    child.stderr?.resume(); // drained and discarded: the probe never reads stderr
    child.on("error", (error) => {
      finish(new GitReadError(`failed to run git: ${messageOf(error)}`, "spawn_failed"));
    });
    child.on("close", () => {
      if (settled || timedOut || aborted) return;
      // Normal EOF under the cap: resolve whatever was buffered. Exit code is
      // not interpreted — a non-zero exit with a partial prefix still yields
      // the prefix for probing (callers decide whether that matters).
      finish(null, { bytes, truncated });
    });
  });
}

export interface GitPagedLinesOptions extends GitRunOptions {
  /** Zero-based count of leading lines to discard (server-side page offset). */
  skipLines: number;
  /** Stop accumulating once the kept text reaches this many characters. */
  maxChars: number;
}

export interface GitPagedLinesResult {
  /** Kept lines, in order, starting at `skipLines`. */
  lines: string[];
  /**
   * Absolute zero-based index of the next unread line, or null when EOF was
   * reached before the character budget filled. Callers pass this back as the
   * next `index` to continue; it is exact because lines are counted while
   * streaming, never re-derived from a moved revision.
   */
  nextLine: number | null;
}

/**
 * Streaming line pager over a hardened git command. Reads stdout line by
 * line, discards `skipLines` leading lines, and keeps whole lines until the
 * kept text reaches `maxChars`, then kills the child (the remaining output is
 * deliberately not buffered). The total byte cap still bounds work even while
 * skipping. Used for per-file patch pages and file-content reads so a single
 * huge diff can never produce an unbounded in-memory copy.
 */
export function runGitPagedLines(
  gitPath: string,
  cwd: string,
  args: readonly string[],
  options: GitPagedLinesOptions,
): Promise<GitPagedLinesResult> {
  const argv = ["--no-pager", "--no-replace-objects", ...configArgv(), ...args];
  return new Promise<GitPagedLinesResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(gitPath, argv, {
        cwd,
        env: hardenedEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new GitReadError(`failed to start git: ${messageOf(error)}`, "spawn_failed"));
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let lines = 0;
    let kept: string[] = [];
    let keptChars = 0;
    let pending = Buffer.alloc(0);
    let totalBytes = 0;
    let stderr = "";
    /** Absolute index of the first line not retained, or null when all lines were kept. */
    let stoppedAt: number | null = null;

    const finish = (error: GitReadError | null, result?: GitPagedLinesResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result!);
    };

    const kill = (): void => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish(new GitReadError(
        `git ${args[0] ?? ""} timed out after ${options.timeoutMs}ms; narrow the query or raise the timeout`,
        "timeout",
      ));
    }, options.timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      kill();
      finish(new GitReadError(`git ${args[0] ?? ""} was aborted`, "aborted"));
    };
    if (options.signal?.aborted) {
      finish(new GitReadError(`git ${args[0] ?? ""} was aborted`, "aborted"));
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const ingest = (chunk: Buffer): void => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > options.maxBytes) {
        kill();
        finish(new GitReadError(
          `git ${args[0] ?? ""} output exceeded the ${options.maxBytes}-byte cap; narrow the query (paths, limit, or date range)`,
          "output_too_large",
        ));
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const line = pending.subarray(0, newline).toString("utf8").replace(/\r$/, "");
        pending = pending.subarray(newline + 1);
        const absoluteIndex = lines;
        lines += 1;
        if (absoluteIndex >= options.skipLines) {
          const cost = line.length + 1;
          if (keptChars + cost > options.maxChars && kept.length > 0) {
            // Budget filled mid-stream: stop reading; the page is complete.
            stoppedAt = absoluteIndex;
            kill();
            finish(null, { lines: kept, nextLine: stoppedAt });
            return;
          }
          kept.push(line);
          keptChars += cost;
        }
        newline = pending.indexOf(0x0a);
      }
    };

    child.stdout?.on("data", ingest);
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP_BYTES) stderr += chunk.toString("utf8").slice(0, STDERR_CAP_BYTES - stderr.length);
    });
    child.on("error", (error) => {
      finish(new GitReadError(`failed to run git: ${messageOf(error)}`, "spawn_failed"));
    });
    child.on("close", (code) => {
      if (settled || timedOut || aborted) return;
      if (code === null) {
        finish(new GitReadError(`git ${args[0] ?? ""} was killed by a signal`, "killed"));
        return;
      }
      // Flush a final line without a trailing newline.
      if (pending.length > 0) {
        const line = pending.toString("utf8");
        pending = Buffer.alloc(0);
        const absoluteIndex = lines;
        lines += 1;
        if (absoluteIndex >= options.skipLines && stoppedAt === null
          && (kept.length === 0 || keptChars + line.length + 1 <= options.maxChars)) {
          kept.push(line);
          keptChars += line.length + 1;
        } else if (absoluteIndex >= options.skipLines) {
          stoppedAt = absoluteIndex;
        }
      }
      if (code !== 0) {
        finish(new GitReadError(
          `git ${args[0] ?? ""} failed (exit ${code}): ${firstStderrLine(stderr) ?? "no diagnostic"}`,
          "git_failed",
        ));
        return;
      }
      finish(null, { lines: kept, nextLine: stoppedAt });
    });
  });
}

function configArgv(): string[] {
  const argv: string[] = [];
  for (const override of SAFE_CONFIG_OVERRIDES) {
    argv.push("-c", override);
  }
  return argv;
}

/**
 * Resolves the non-bare work-tree root containing `cwd` using the hardened
 * runner. Fails closed with an actionable message when `cwd` is not inside a
 * repository work tree (including bare repositories, which have no work tree).
 */
export async function resolveRepoRoot(
  gitPath: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const out = await runGit(gitPath, cwd, ["rev-parse", "--show-toplevel"], {
    timeoutMs,
    maxBytes: 4_096,
    signal,
  });
  if (out.code !== 0) {
    const detail = firstStderrLine(out.stderr);
    const bare = /work ?tree|bare repository/i.test(out.stderr);
    throw new GitReadError(
      bare
        ? `GitRead needs a non-bare repository work tree; the directory ${cwd} is inside a bare repository or its work tree (${detail ?? "no work tree"})`
        : `no Git repository found at ${cwd}${detail ? ` (${detail})` : ""}; run from inside the repository you want to research`,
      "not_a_repository",
    );
  }
  const root = out.stdout.trim();
  if (!root) throw new GitReadError(`git could not resolve a repository root for ${cwd}`, "not_a_repository");
  return root;
}

/**
 * Fail-closed repository audit. Refuses repositories whose effective
 * configuration defines programs that attribute files could select during
 * diff display: `diff.external`, `diff.<name>.command`, `diff.<name>.textconv`.
 * See the module header for why this is sufficient and why clean/smudge
 * filters are not refused.
 */
export async function auditRepository(
  gitPath: string,
  root: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const out = await runGit(gitPath, root, ["config", "--list", "--show-origin", "-z"], {
    timeoutMs,
    maxBytes: 1_048_576,
    signal,
  });
  if (out.code !== 0) {
    throw new GitReadError(
      `could not audit repository configuration at ${root}: ${firstStderrLine(out.stderr) ?? `exit ${out.code}`}`,
      "audit_failed",
    );
  }
  const violations: string[] = [];
  // With --show-origin -z each entry is two NUL-separated records: an origin
  // record, then a "key[=value]" record (the value may itself contain
  // newlines). Extract the key from the first line of each record and scan
  // for dangerous key shapes (fail closed: a value that merely resembles a
  // key would only cause a refusal, never an execution).
  const records = out.stdout.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (!record) continue;
    const firstLine = record.split("\n")[0] ?? "";
    const eq = firstLine.indexOf("=");
    const key = (eq >= 0 ? firstLine.slice(0, eq) : firstLine).toLowerCase();
    // Driver names may themselves contain dots: git splits the driver config
    // key at the LAST dot, so diff.evil.x.textconv is driver "evil.x".
    if (key === "diff.external" || /^diff\..+\.command$/.test(key) || /^diff\..+\.textconv$/.test(key)) {
      violations.push(`${key} (${records[i - 1] ?? "unknown origin"})`);
    }
  }
  if (violations.length > 0) {
    throw new GitReadError(
      `refusing repository ${root}: its configuration defines diff programs that .gitattributes files could execute during history reads: ${[...new Set(violations)].join(", ")}. ` +
        "GitRead fails closed rather than risk running repository-defined commands; remove or rename those configuration keys to use GitRead on this repository",
      "unsafe_repository_config",
    );
  }
}

/**
 * Resolves a model-supplied revision spec to its full commit object id. The
 * raw spec is passed as a single argv element (no shell, no concatenation);
 * leading-dash specs are rejected by the caller before reaching git.
 */
export async function pinRevision(
  gitPath: string,
  root: string,
  spec: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const out = await runGit(gitPath, root, ["rev-parse", "--verify", "--quiet", `${spec}^{commit}`], {
    timeoutMs,
    maxBytes: 4_096,
    signal,
  });
  if (out.code === 0) {
    const sha = out.stdout.trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
    // A 64-hex object id can only resolve in a SHA-256 object-format
    // repository (a 64-hex name is never a valid SHA-1 object id). Name the
    // real limitation instead of a misleading "unknown revision".
    if (/^[0-9a-f]{64}$/.test(sha)) {
      throw new GitReadError(
        `repository at ${root} uses the SHA-256 object format, which GitRead does not support in this release (SHA-1 repositories only)`,
        "unsupported_object_format",
      );
    }
  }
  const unborn = /unknown revision|ambiguous argument|bad revision|does not have any ancestors/i.test(out.stderr);
  throw new GitReadError(
    `cannot resolve revision '${spec}' to a commit${unborn ? " (the repository may be empty or the ref may not exist; use action=refs to list available refs)" : ""}`,
    "unknown_revision",
  );
}

/** Stable hash used for snapshot identity tokens. */
export function snapshotToken(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

function firstStderrLine(stderr: string): string | undefined {
  const line = stderr.split("\n").map((value) => value.trim()).find((value) => value.length > 0);
  return line ? line.slice(0, 300) : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
