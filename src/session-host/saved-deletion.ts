import { spawnSync as nodeSpawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";

export interface SavedSessionDeletionResult {
  readonly ok: boolean;
  readonly method: "trash" | "unlink";
  readonly error?: string;
  /** Validation refused before the fallback mutation could begin. */
  readonly refusal?: string;
}

export interface SavedSessionDeletionOptions {
  /** Re-checks both UI/catalog authority and current filesystem/live identity. */
  readonly validate: () => string | undefined;
  /** Narrow test seams; production uses spawnSync("trash") and unlinkSync. */
  readonly spawnSync?: typeof nodeSpawnSync;
  readonly exists?: (path: string) => boolean;
  readonly unlink?: (path: string) => void;
}

/**
 * Match Pi 1.1.0's `/resume` trash-first deletion semantics exactly: one
 * shell-free `trash` invocation, status-zero or gone-file success, then a
 * permanent unlink fallback. Validation is repeated immediately before each
 * mutation stage so a replacement observed after trash is never unlinked.
 */
export function deleteSavedSessionFile(
  file: string,
  options: SavedSessionDeletionOptions,
): SavedSessionDeletionResult {
  const validate = (): string | undefined => {
    try {
      return options.validate();
    } catch {
      return "saved conversation could not be revalidated";
    }
  };

  const initialRefusal = validate();
  if (initialRefusal !== undefined) {
    return { ok: false, method: "unlink", refusal: initialRefusal };
  }

  const spawnSync = options.spawnSync ?? nodeSpawnSync;
  let status: number | null = null;
  let trashError: string | undefined;
  let stderr: string | undefined;
  try {
    // Catalog files are absolute, so the native CLI receives exactly one
    // admitted path argument (and no shell or option-like relative path).
    const result = spawnSync("trash", [file], { encoding: "utf-8" });
    status = result.status;
    if (result.error) trashError = result.error.message;
    stderr = typeof result.stderr === "string" ? result.stderr : undefined;
  } catch (error) {
    trashError = error instanceof Error ? error.message : String(error);
  }

  const exists = options.exists ?? existsSync;
  // This intentionally preserves native Pi's status/gone rule without
  // requiring any stronger post-trash absence proof.
  if (status === 0 || !exists(file)) return { ok: true, method: "trash" };

  const fallbackRefusal = validate();
  if (fallbackRefusal !== undefined) {
    const trashHint = trashErrorHint(trashError, stderr);
    return {
      ok: false,
      method: "unlink",
      refusal: fallbackRefusal,
      ...(trashHint !== undefined ? { error: trashHint } : {}),
    };
  }

  try {
    (options.unlink ?? unlinkSync)(file);
    return { ok: true, method: "unlink" };
  } catch (error) {
    const unlinkError = error instanceof Error ? error.message : String(error);
    const trashHint = trashErrorHint(trashError, stderr);
    return {
      ok: false,
      method: "unlink",
      error: trashHint === undefined ? unlinkError : `${unlinkError} (${trashHint})`,
    };
  }
}

function trashErrorHint(error: string | undefined, stderr: string | undefined): string | undefined {
  const parts: string[] = [];
  if (error) parts.push(error);
  const firstLine = stderr?.trim().split("\n")[0];
  if (firstLine) parts.push(firstLine);
  if (parts.length === 0) return undefined;
  return `trash: ${parts.join(" · ").slice(0, 200)}`;
}
