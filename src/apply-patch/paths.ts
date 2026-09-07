/// Path normalization and workspace confinement shared by the ApplyPatch tool,
/// its canonical envelope parser, and the sequential request engine.

import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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

/** Validates and normalizes a raw path argument without workspace confinement. */
export function normalizeApplyPatchPath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  const candidate = normalizeApplyPatchPathMarker(value);
  if (!candidate) throw new Error(`${field} is empty after removing the leading '@'`);
  if (candidate.includes("\0")) throw new Error(`${field} contains a NUL byte`);
  return candidate;
}

export interface ConfinedPath {
  /** Lexical absolute path inside the workspace root. */
  absolute: string;
  /** Real (symlink-resolved) path of the nearest existing ancestor plus remainder. */
  real: string;
}

/**
 * Confines a normalized path to the workspace: lexically under `rootLexical` and,
 * through the nearest-existing-ancestor realpath, under `rootReal`, so symlinked
 * components cannot escape the workspace.
 */
export async function confinePath(
  rootLexical: string,
  rootReal: string,
  rawPath: string,
  field: string,
): Promise<ConfinedPath> {
  const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(rootLexical, rawPath);
  assertWithinRoot(rootLexical, absolute, field, rawPath);
  let real: string;
  try {
    real = await nearestRealPath(absolute);
  } catch (error) {
    throw new Error(`${field} ${rawPath} could not be resolved within the current workspace: ${messageOf(error)}`);
  }
  assertWithinRoot(rootReal, real, field, rawPath);
  return { absolute, real };
}

function assertWithinRoot(root: string, candidate: string, field: string, rawPath: string): void {
  const rel = relative(root, candidate);
  if (rel === "") {
    throw new Error(`${field} ${rawPath} must reference a file inside the current workspace, not the workspace root`);
  }
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${field} ${rawPath} resolves outside the current workspace (${root}); traversal is rejected`);
  }
}

/** Realpath of the nearest existing ancestor with the remainder re-joined; detects symlink escapes. */
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