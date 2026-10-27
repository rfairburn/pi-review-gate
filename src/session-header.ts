/**
 * Bounded read of a native Pi session file's public first-line header.
 *
 * Moved unchanged from `src/session-host/saved-sessions.ts` so callers outside
 * the session-host catalog (canonical native session references,
 * `src/pi-session-reference.ts`) can verify a session file's identity without
 * pulling in the catalog module. Semantics are identical: bounded,
 * descriptor-based, regular-file-only, symlink-refusing, transcript-never-read.
 */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";

/** Upper bound for the bounded first-line session header read (never a whole transcript). */
export const MAX_SESSION_HEADER_BYTES = 64 * 1024;

/** Upper bound for a bounded session header field (id/cwd). */
export const MAX_SESSION_HEADER_FIELD_LENGTH = 4096;

/** True only for nonempty strings within the field bound and free of control characters. */
function isBoundedControlFreeString(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > MAX_SESSION_HEADER_FIELD_LENGTH) return false;
  return !/[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Bounded first-line read of a saved conversation's PUBLIC session header.
 *
 * The first line must be a complete bounded public SessionHeader: `type`
 * exactly "session" with nonempty bounded control-free `id` and `cwd`. A
 * first line that overflows the 64 KiB bound without a line break is refused
 * (a valid JSON prefix followed by unread garbage on the same line is never
 * accepted), as are symlinked or special files. The read is descriptor-based
 * and bounded; it never copies the transcript, and native appends or name
 * changes after the header remain admissible (no mtime lock).
 */
export function readSavedSessionHeader(file: string): { id: string; cwd: string } | undefined {
  let preStats;
  try {
    preStats = lstatSync(file, { bigint: true });
  } catch {
    return undefined;
  }
  // Non-symlink identity: a symlinked or special file is never probed.
  if (preStats.isSymbolicLink() || !preStats.isFile()) return undefined;
  let fd: number;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  try {
    const openStats = fstatSync(fd, { bigint: true });
    if (!openStats.isFile()) return undefined; // special file: never probe it
    // Descriptor identity: the opened file must be the SAME regular file that
    // was inspected. O_NOFOLLOW only protects against a final-component
    // symlink; a regular-file replacement between lstat and open is refused.
    if (openStats.dev !== preStats.dev || openStats.ino !== preStats.ino) return undefined;
    const buffer = Buffer.alloc(MAX_SESSION_HEADER_BYTES);
    let offset = 0;
    let lineEnd = -1;
    let eof = false;
    while (offset < buffer.length) {
      const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (bytesRead <= 0) {
        eof = true;
        break;
      }
      offset += bytesRead;
      lineEnd = buffer.subarray(0, offset).indexOf(0x0a);
      if (lineEnd !== -1) break;
    }
    // First-line overflow: no LF within the bound and not EOF. A complete
    // short final line without a trailing newline (EOF before the bound) is
    // still a bounded, fully-read line.
    if (lineEnd === -1 && !eof) return undefined;
    const firstLine = (lineEnd === -1 ? buffer.subarray(0, offset) : buffer.subarray(0, lineEnd)).toString("utf8");
    if (firstLine.trim().length === 0) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(firstLine);
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    // The PUBLIC SessionHeader type: never another entry kind.
    if (record.type !== "session") return undefined;
    if (!isBoundedControlFreeString(record.id) || !isBoundedControlFreeString(record.cwd)) return undefined;
    return { id: record.id, cwd: record.cwd };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A close failure must not mask the bounded header read result.
    }
  }
}
