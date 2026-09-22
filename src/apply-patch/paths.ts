/// Path resolution shared by the ApplyPatch tool, its canonical envelope
/// parser, and the sequential request engine.
///
/// Path access intentionally matches Pi's native edit/write tools: paths are
/// resolved lexically against the current working directory (absolute paths,
/// `..` components, a leading `~`/`~/...` home prefix, and a single leading
/// `@` convention marker are honored), and destinations outside the workspace
/// — including authorized scratch paths such as /tmp — are supported wherever
/// the host filesystem allows. The
/// current working directory is a path-resolution context, not a promised
/// filesystem sandbox: host permissions, tool authorization, review gates, and
/// any external execution-environment boundary remain authoritative (see
/// docs/security-model.md).

import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";

/**
 * Strips surrounding whitespace and the single leading `@` convention marker
 * used by built-in file tools. Exported so evidence extraction normalizes
 * operation paths identically to the tool's own path handling.
 */
export function normalizeApplyPatchPathMarker(value: string): string {
  let candidate = value.trim();
  if (candidate.startsWith("@")) candidate = candidate.slice(1).trim();
  return candidate;
}

/**
 * Expands a leading `~` or `~/...` (plus `~\...` on Windows) against the
 * process home directory, mirroring Pi's native edit/write path normalization
 * (the expandTilde rule in dist/utils/paths.js). Any other spelling —
 * including `~user` — is returned unchanged and resolves relative to the cwd.
 */
export function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

export interface ResolvedPath {
  /** Absolute path resolved lexically against the cwd; a leading `~`/`~/...` is expanded first (native edit/write semantics). */
  absolute: string;
  /** Real (symlink-resolved) path of the nearest existing ancestor plus remainder. */
  real: string;
}

/**
 * Resolves a normalized operation path against the tool's working directory.
 * A leading `~`/`~/...` expands to the home directory first (native edit/write
 * rule); relative paths then resolve against `cwd`, and absolute paths are
 * used as given.
 * No workspace confinement is applied: outside-workspace destinations are
 * intentional, and refusals come only from host filesystem permissions or
 * later per-operation correctness checks.
 */
export async function resolveTargetPath(cwd: string, rawPath: string, field: string): Promise<ResolvedPath> {
  // Tilde expansion runs before the absolute-path check, exactly like Pi's
  // native normalization: `~/x` is not absolute until it expands to a home path.
  const expanded = expandHomePath(rawPath);
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  try {
    const real = await nearestRealPath(absolute);
    return { absolute, real };
  } catch (error) {
    throw new Error(`${field} ${rawPath} could not be resolved: ${messageOf(error)}`);
  }
}

/** Realpath of the nearest existing ancestor with the remainder re-joined; resolves symlinked components. */
export async function nearestRealPath(absolute: string): Promise<string> {
  let prefix = absolute;
  const suffixes: string[] = [];
  for (;;) {
    try {
      const real = await realpath(prefix);
      return suffixes.length > 0 ? join(real, ...suffixes) : real;
    } catch {
      const parent = dirname(prefix);
      if (parent === prefix) throw new Error(`could not resolve path: ${absolute}`);
      suffixes.unshift(basename(prefix));
      prefix = parent;
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}