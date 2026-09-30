/**
 * #233: repository resolution and fail-closed safety audit (extracted from
 * git-checkpoint.ts). Resolves the capture root to its git dir/live index,
 * probes the effective core.autocrlf with ordinary precedence, and audits
 * everything that could make Git diff/index output untrustworthy or execute
 * external programs, producing the in-window proof hash.
 */

import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { GitCheckpointError, messageOf, resultFromError, truncateDetail, type GitCheckpointResult } from "./errors";
import { isSafeRelativePath } from "./record";
import { runGit, runGitWithInput, type GitRunOutput, type GitRunSpec } from "./run-git";
import type { GitCheckpointOptions } from "./types";

// ── Repository resolution and safety audit ───────────────────────────────────

export interface ResolvedRepo {
  root: string;
  gitDir: string;
  liveIndexPath: string;
}

export async function resolveRepo(
  gitPath: string,
  root: string,
  spec: GitRunSpec,
): Promise<GitCheckpointResult<ResolvedRepo>> {
  const rootAbs = resolve(root);
  let out: GitRunOutput;
  try {
    out = await runGit(gitPath, rootAbs, ["rev-parse", "--show-toplevel"], spec);
  } catch (error) {
    return resultFromError(error);
  }
  if (out.code !== 0 || out.stdout.toString("utf8").trim().length === 0) {
    return {
      status: "unsupported",
      reason: "not_a_git_repository",
      detail: truncateDetail(out.stderr || `git rev-parse exit ${out.code}`),
    };
  }
  // Canonicalize both sides: tmp directories may sit behind symlinks
  // (e.g. /var → /private/var on macOS) while git reports resolved paths.
  const [rootReal, toplevelReal] = await Promise.all([
    realpath(rootAbs).catch(() => rootAbs),
    realpath(resolve(out.stdout.toString("utf8").trim())).catch((error: unknown) => {
      throw new GitCheckpointError(`cannot resolve repository top level: ${messageOf(error)}`, "git_failed");
    }),
  ]);
  if (toplevelReal !== rootReal) {
    return {
      status: "unsupported",
      reason: "not_repository_root",
      detail: `capture root ${rootAbs} is not the repository top level ${toplevelReal}`,
    };
  }
  let gitDirOut: GitRunOutput;
  let indexPathOut: GitRunOutput;
  try {
    [gitDirOut, indexPathOut] = await Promise.all([
      runGit(gitPath, rootAbs, ["rev-parse", "--absolute-git-dir"], spec),
      runGit(gitPath, rootAbs, ["rev-parse", "--git-path", "index"], spec),
    ]);
  } catch (error) {
    return resultFromError(error);
  }
  if (gitDirOut.code !== 0 || indexPathOut.code !== 0) {
    return { status: "failed", reason: "git_failed", detail: truncateDetail(gitDirOut.stderr || indexPathOut.stderr) };
  }
  const gitDir = resolve(gitDirOut.stdout.toString("utf8").trim());
  const liveIndexPath = resolve(rootAbs, indexPathOut.stdout.toString("utf8").trim());
  return { status: "ok", value: { root: rootAbs, gitDir, liveIndexPath } };
}

/** Canonical core.autocrlf values Git accepts (git_parse_maybe_bool). */
function normalizeAutocrlfValue(raw: string): "true" | "false" | "input" | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "yes" || value === "on" || value === "1") return "true";
  if (value === "false" || value === "no" || value === "off" || value === "0") return "false";
  if (value === "input") return "input";
  return undefined;
}

/**
 * Read the EFFECTIVE core.autocrlf with ordinary system/global/local
 * precedence — a shell-free, config-only Git probe that cannot execute
 * filters, hooks, or diff helpers. The value is frozen for the operation's
 * capture commands (GitRunSpec.frozenAutocrlf) and mixed into the audit
 * proof, so a mid-capture configuration change fails closed.
 */
async function probeEffectiveAutocrlf(
  gitPath: string,
  root: string,
  spec: GitRunSpec,
): Promise<GitCheckpointResult<"true" | "false" | "input">> {
  let out: GitRunOutput;
  try {
    out = await runGit(gitPath, root, ["config", "core.autocrlf"], { ...spec, maxBytes: 1024, probeConfig: true });
  } catch (error) {
    return resultFromError(error);
  }
  // `git config <key>` exits 1 with empty output when the key is unset at
  // every level; the built-in default is then "false" (no conversion).
  if (out.code === 1 && out.stdout.length === 0 && out.stderr.trim().length === 0) {
    return { status: "ok", value: "false" };
  }
  if (out.code !== 0 || out.stderr.trim().length > 0) {
    return { status: "failed", reason: "git_failed", detail: truncateDetail(out.stderr || `git config core.autocrlf exit ${out.code}`) };
  }
  const raw = out.stdout.toString("utf8");
  const normalized = normalizeAutocrlfValue(raw);
  if (normalized === undefined) {
    return {
      status: "unsupported",
      reason: "filter_or_eol_configured",
      detail: `core.autocrlf is set to an unrecognized value ${JSON.stringify(raw.trim())}; EOL semantics cannot be frozen safely`,
    };
  }
  return { status: "ok", value: normalized };
}

/** Read-only repository audit proof for one operation's capture window. */
export interface AuditProof {
  /** SHA-256 over the nulled-scope config listing, index flags/attributes, and the effective core.autocrlf. */
  proof: string;
  /** Effective core.autocrlf (system/global/local precedence) at audit time. */
  effectiveAutocrlf: "true" | "false" | "input";
}

/**
 * Fail-closed audit of everything that could make Git diff/index output
 * untrustworthy or execute external programs. Returns the first violation,
 * or the proof plus the effective core.autocrlf to freeze for capture.
 */
export async function auditRepository(
  gitPath: string,
  root: string,
  spec: GitRunSpec,
): Promise<GitCheckpointResult<AuditProof>> {
  // The audit observes pure ambient state: any frozen capture override is
  // stripped, because a `-c core.autocrlf=...` value would appear in the
  // `git config --list` output (origin "command line") and make the final
  // proof differ from the initial one on every arm.
  const auditSpec: GitRunSpec = { ...spec, frozenAutocrlf: undefined };
  // Probe the effective EOL semantics with ambient configuration BEFORE
  // anything else: every capture command below runs quarantined (system and
  // global config replaced with /dev/null), so without freezing this value a
  // native Windows checkout (system-level core.autocrlf=true) would diff its
  // CRLF worktree as fully modified.
  const autocrlf = await probeEffectiveAutocrlf(gitPath, root, auditSpec);
  if (autocrlf.status !== "ok") return autocrlf;
  let configOut: GitRunOutput;
  try {
    configOut = await runGit(gitPath, root, ["config", "--list", "--show-origin", "-z"], {
      ...auditSpec,
      maxBytes: 4 * 1024 * 1024,
    });
  } catch (error) {
    return resultFromError(error);
  }
  if (configOut.code !== 0) {
    return { status: "failed", reason: "git_failed", detail: truncateDetail(configOut.stderr || `git config exit ${configOut.code}`) };
  }
  // With --show-origin -z each entry is two NUL-separated records: an origin
  // record, then a "key\nvalue" record. Scan for keys that could execute
  // programs or perform unsupported conversions during diff/clean.
  const records = configOut.stdout.toString("utf8").split("\0");
  for (let i = 1; i < records.length; i += 2) {
    const record = records[i] ?? "";
    if (!record) continue;
    const nl = record.indexOf("\n");
    const key = (nl >= 0 ? record.slice(0, nl) : record).toLowerCase();
    // Driver names may contain dots: git splits the driver config key at the LAST dot.
    if (key === "diff.external" || /^diff\..+\.command$/.test(key) || /^diff\..+\.textconv$/.test(key)) {
      return {
        status: "unsupported",
        reason: "diff_program_configured",
        detail: `repository config defines ${key}; external diff helpers could run during capture`,
      };
    }
    if (key.startsWith("filter.")) {
      return {
        status: "unsupported",
        reason: "filter_or_eol_configured",
        detail: `repository config defines ${key}; external clean/smudge filters are unsupported`,
      };
    }
    if ((key === "core.sparsecheckout" || key === "core.sparsecheckoutcone") && record.slice(nl + 1) === "true") {
      return {
        status: "unsupported",
        reason: "skip_worktree_entry",
        detail: `sparse checkout is enabled (${key}); the worktree is a partial view`,
      };
    }
  }

  // Index entry flags, modes, and stages (not worktree EOL state).
  let listOut: GitRunOutput;
  try {
    listOut = await runGit(gitPath, root, ["ls-files", "-s", "-v", "-z"], {
      ...auditSpec,
      maxBytes: 32 * 1024 * 1024,
    });
  } catch (error) {
    return resultFromError(error);
  }
  if (listOut.code !== 0 || listOut.stderr.trim().length > 0) {
    return { status: "failed", reason: "git_warning", detail: truncateDetail(listOut.stderr || `git ls-files exit ${listOut.code}`) };
  }
  const trackedPaths: Array<{ path: string; mode: string }> = [];
  for (const record of listOut.stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    if (firstTab < 0) return { status: "failed", reason: "git_failed", detail: "unparseable ls-files record" };
    const meta = record.slice(0, firstTab);
    const path = record.slice(firstTab + 1);
    if (!isSafeRelativePath(path)) {
      return { status: "failed", reason: "git_warning", detail: `unsafe tracked path from ls-files: ${JSON.stringify(path)}` };
    }
    const fields = meta.split(" ");
    const flag = fields[0] ?? "";
    const mode = fields[1] ?? "";
    const stage = fields[3] ?? "";
    if (flag === "M" || stage !== "0") {
      return { status: "unsupported", reason: "unmerged_index_entry", detail: `path ${path} has unmerged index stages` };
    }
    if (flag === "S") {
      return { status: "unsupported", reason: "skip_worktree_entry", detail: `path ${path} has the skip-worktree bit set` };
    }
    if (flag === "h") {
      return { status: "unsupported", reason: "assume_unchanged_entry", detail: `path ${path} is marked assume-unchanged; its worktree state is invisible to Git` };
    }
    if (flag !== "H") {
      return { status: "failed", reason: "git_failed", detail: `unknown index flag '${flag}' for path ${path}` };
    }
    if (mode === "160000") {
      return { status: "unsupported", reason: "submodule_tracked", detail: `path ${path} is a tracked submodule (gitlink); subproject state cannot be captured in patches` };
    }
    trackedPaths.push({ path, mode });
  }

  // Only non-EOL conversions remain unsupported. Fingerprint effective
  // config too, so a mid-operation configuration change fails closed.
  const auditHash = createHash("sha256").update(configOut.stdout);
  // The effective value is part of the proof: a mid-capture change to
  // system/global/local core.autocrlf (invisible to the nulled-scope listing
  // above) must fail closed like any other audited change.
  auditHash.update(`\0autocrlf=${autocrlf.value}`);
  if (trackedPaths.length > 0) {
    const attrInput = Buffer.from(`${trackedPaths.map((entry) => entry.path).join("\0")}\0`, "utf8");
    let attrOut: GitRunOutput;
    try {
      attrOut = await runGitWithInput(
        gitPath,
        root,
        ["check-attr", "-z", "--stdin", "filter", "ident", "working-tree-encoding"],
        attrInput,
        // One NUL-terminated triple per attribute/path (path + attribute +
        // value), so this output scales with the tracked-path count and needs
        // the same order of cap as the ls-files enumeration above (32 MiB)
        // rather than the 1 MiB base spec cap, which would fail closed with
        // git_failed on repos of the ~20k-path size this module targets.
        { ...auditSpec, maxBytes: 32 * 1024 * 1024 },
        {},
      );
    } catch (error) {
      return resultFromError(error);
    }
    if (attrOut.code !== 0 || attrOut.stderr.trim().length > 0) {
      return { status: "failed", reason: "git_warning", detail: truncateDetail(attrOut.stderr || `git check-attr exit ${attrOut.code}`) };
    }
    // `-z --stdin` output is a flat run of NUL-terminated
    // <path> <attribute> <info> triples, in path/attribute argument order.
    const fields = attrOut.stdout.toString("utf8").split("\0");
    const attributeNames = ["filter", "ident", "working-tree-encoding"] as const;
    const expectedFields = trackedPaths.length * attributeNames.length * 3;
    if (fields.length !== expectedFields + 1 || fields[expectedFields] !== "") {
      return { status: "failed", reason: "git_failed", detail: "incomplete git check-attr output" };
    }
    for (let pathIndex = 0; pathIndex < trackedPaths.length; pathIndex += 1) {
      const tracked = trackedPaths[pathIndex]!;
      const values: Record<(typeof attributeNames)[number], string> = {
        filter: "",
        ident: "",
        "working-tree-encoding": "",
      };
      for (let attrIndex = 0; attrIndex < attributeNames.length; attrIndex += 1) {
        const offset = (pathIndex * attributeNames.length + attrIndex) * 3;
        const attribute = attributeNames[attrIndex]!;
        if (fields[offset] !== tracked.path || fields[offset + 1] !== attribute || fields[offset + 2] === undefined) {
          return { status: "failed", reason: "git_failed", detail: `unparseable git check-attr output for ${tracked.path}` };
        }
        values[attribute] = fields[offset + 2]!;
      }

      for (const attribute of ["filter", "ident", "working-tree-encoding"] as const) {
        const value = values[attribute];
        if (value !== "unspecified" && value !== "unset") {
          return {
            status: "unsupported",
            reason: "filter_or_eol_configured",
            detail: `path ${tracked.path} has unsupported non-EOL ${attribute} conversion (${value})`,
          };
        }
      }
      auditHash.update(JSON.stringify([tracked.path, tracked.mode, values]));
      auditHash.update("\0");
    }
  }
  return { status: "ok", value: { proof: auditHash.digest("hex"), effectiveAutocrlf: autocrlf.value } };
}

/** Fail closed if audited config, attributes, index flags, or the frozen EOL value changed in-window. */
export function assertAuditProofStable(before: AuditProof, after: GitCheckpointResult<AuditProof>): void {
  if (after.status !== "ok") {
    throw new GitCheckpointError(after.detail ?? `post-capture repository audit was ${after.status}`, after.reason);
  }
  if (after.value.proof !== before.proof || after.value.effectiveAutocrlf !== before.effectiveAutocrlf) {
    throw new GitCheckpointError("audited config, attributes, or index flags changed during capture", "capture_inconsistent");
  }
}

export async function runAfterInitialAuditHook(options: GitCheckpointOptions): Promise<void> {
  try {
    await options.faultHooks?.afterInitialAudit?.();
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new GitCheckpointError(`initial-audit hook failed: ${messageOf(error)}`, "git_failed");
  }
}
