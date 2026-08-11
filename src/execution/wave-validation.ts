/** Validate an identifier used as one Git-ref and filesystem-path segment. */
export function validateSafeId(id: string, label: string): void {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`Invalid ${label}: must be a non-empty string.`);
  }
  if (
    /[~^:?*[\\@{}\/]/.test(id) ||
    /[\x00-\x20\x7F]/.test(id) ||
    id === "." || id === ".." || id === "@" ||
    id.startsWith(".") || id.endsWith(".") ||
    id.endsWith(".lock") || id.includes("..") ||
    id.includes("@{")
  ) {
    throw new Error(`Invalid ${label}: "${id}". Must be a single safe ref/path segment.`);
  }
}

/** Prevent read-only Git probes from contending on optional repository locks. */
export const GIT_NO_LOCKS_ENV = Object.freeze({ GIT_OPTIONAL_LOCKS: "0" });

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return error.name === "AbortError" || code === "ABORT_ERR";
}
