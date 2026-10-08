import type { NativePersistenceReceipt } from "./native-persistence";
import { isValidNativeSessionId } from "./protocol";
import type { SavedSessionCatalog, SavedSessionRow } from "./saved-sessions";

export type ExitedRestartChoice =
  | { readonly kind: "saved"; readonly row: SavedSessionRow }
  | { readonly kind: "fresh"; readonly cwd: string }
  | { readonly kind: "refused"; readonly reason: "unknown-binding" | "ambiguous-binding" | "unsafe-absence" | "missing-saved" };

/**
 * Choose only the last observed CURRENT native binding, not launch metadata
 * or the newest conversation in the workspace. This does not mint an
 * admission: callers must still use the branded catalog admission and launch
 * revalidation before starting a new independently owned child.
 */
export function chooseExitedRestart(
  binding: NativePersistenceReceipt | undefined,
  cwd: string,
  catalog: Pick<SavedSessionCatalog, "rows" | "issues" | "issueCount">,
): ExitedRestartChoice {
  if (!binding || !isValidNativeSessionId(binding.sessionId)) return { kind: "refused", reason: "unknown-binding" };
  const matching = catalog.rows.filter((row) => row.id === binding.sessionId);
  if (matching.length > 1) return { kind: "refused", reason: "ambiguous-binding" };
  if (matching.length === 1) return { kind: "saved", row: matching[0]! };
  if (catalog.issueCount !== 0 || catalog.issues.length !== 0) return { kind: "refused", reason: "unsafe-absence" };
  if (binding.persistence === "saved") return { kind: "refused", reason: "missing-saved" };
  if (binding.persistence !== "unsaved") return { kind: "refused", reason: "unknown-binding" };
  return { kind: "fresh", cwd };
}
