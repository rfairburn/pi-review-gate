import { mkdir } from "node:fs/promises";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

// ── artifact-path containment ────────────────────────────────────────────────

/**
 * #220 artifact containment: the task's artifact directory must live OUTSIDE
 * the workspace (task/review artifacts must never be written into the
 * user-selected workspace). Lexical check plus nearest-existing-ancestor
 * realpath, mirroring the worktree-artifact preflight.
 */
export async function assertInPlaceArtifactOutsideWorkspace(artifactDir: string, workspaceRoot: string): Promise<void> {
  const root = await fs.realpath(workspaceRoot);
  const lexical = relative(resolve(workspaceRoot), resolve(artifactDir));
  const outside = (): boolean => isAbsolute(lexical) || lexical === ".." || lexical.startsWith(`..${sep}`);
  if (!outside()) {
    throw new Error(`In-place artifact directory "${artifactDir}" must be outside the workspace "${workspaceRoot}".`);
  }
  // Preflight: resolve the nearest existing ancestor and forbid it from being
  // inside the workspace, so mkdir cannot be tricked into creating directories
  // inside the workspace through a symlink.
  let existing = resolve(artifactDir);
  for (;;) {
    let resolved: string;
    try {
      resolved = await fs.realpath(existing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
      continue;
    }
    const rel = relative(root, resolved);
    if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) {
      throw new Error(`In-place artifact directory "${artifactDir}" must be outside the workspace "${workspaceRoot}".`);
    }
    return;
  }
}

export async function ensureArtifactDir(artifactDir: string, workspaceRoot: string): Promise<string> {
  const resolved = resolve(artifactDir);
  await assertInPlaceArtifactOutsideWorkspace(resolved, workspaceRoot);
  await mkdir(resolved, { recursive: true });
  const real = await fs.realpath(resolved);
  const root = await fs.realpath(workspaceRoot);
  const rel = relative(root, real);
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) {
    throw new Error(`In-place artifact directory "${artifactDir}" must be outside the workspace "${workspaceRoot}".`);
  }
  return real;
}
