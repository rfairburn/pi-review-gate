/**
 * Minimal bounded JSONL TAIL reader for ONE positively bound file
 * (native Claude status acquisition phase).
 *
 * This is deliberately not an observer framework, a directory walker, a session
 * scanner, or a general file service. It opens exactly one absolute path the
 * caller already holds, never follows a symlink, never allocates from the file's
 * full size, and returns only the COMPLETE records inside one bounded window at
 * the end of the file. Everything it does not positively read stays unknown to
 * the caller: a partial trailing line is reported as partial (the caller waits
 * for the append), a window that could not cover the requested floor is reported
 * as skipped, and any read/identity/truncation failure is an explicit closed
 * reason instead of an empty record list.
 *
 * Record framing is verified, never assumed. The byte immediately before the
 * window is read through the same handle, so a window that starts exactly on a
 * boundary keeps the record that begins there, a window that starts inside a
 * record drops only that record, and an offset whose boundary could not be
 * verified is reported as unverified instead of being promoted into a cursor the
 * caller may trust.
 *
 * Privacy: the returned record texts are the host-internal parse surface only.
 * This module never logs, persists, broadcasts, or returns them anywhere else,
 * and it keeps no state between calls — there is nothing here to leak later.
 *
 * Generic safety practices preserved (no personal-directory exceptions and no
 * investigative search exclusions live in product code): explicit absolute-path
 * input, no-follow open, regular-file type check, device/inode identity, and
 * fixed byte bounds on both the window and each individual record.
 *
 * Encoding is verified too: a record is decoded fatally, so corrupt bytes are an
 * explicit read failure rather than a silently repaired string that would still
 * parse as JSON.
 */

import { constants as fsConstants, promises as fsPromises } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

/** Maximum window this module will read from one file in a single call. */
export const MAX_NATIVE_JSONL_WINDOW_BYTES = 1024 * 1024;

/** Maximum size of one record admitted from that window. */
export const MAX_NATIVE_JSONL_LINE_BYTES = 256 * 1024;

/** Stable file identity for one open: a replacement changes at least one field. */
export interface NativeJsonlFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

/**
 * Closed read-failure reasons. Each is a SOURCE fact about this one file, never a
 * provider value: none of them means "no records", and none of them may be read
 * by a caller as zero, idle, or an absent category.
 */
export type NativeJsonlTailFailureReason =
  | "path-not-absolute"
  | "unavailable"
  | "not-a-regular-file"
  | "symlink"
  | "unreadable"
  | "truncated"
  | "identity-changed";

export interface NativeJsonlTailOptions {
  /** Positively bound absolute path of the one file to read. */
  readonly path: string;
  /** Absolute byte offset the caller needs coverage from. */
  readonly from: number;
  /** Read window cap at the end of the file; defaults to {@link MAX_NATIVE_JSONL_WINDOW_BYTES}. */
  readonly maxBytes?: number;
  /** Per-record cap; oversized records are counted, never returned. */
  readonly maxLineBytes?: number;
  /** When supplied, a mismatch on the opened file's identity fails the read. */
  readonly expectIdentity?: NativeJsonlFileIdentity;
}

export interface NativeJsonlTailSuccess {
  readonly ok: true;
  /** Identity of the file actually read. */
  readonly identity: NativeJsonlFileIdentity;
  /** File size observed under that same handle. */
  readonly fileSize: number;
  /** Absolute offset the window started at. */
  readonly windowStart: number;
  /**
   * True only when the byte just before `windowStart` was verified to be a line
   * separator (or the window starts at the file start). A barrier taken from a
   * size stat may sit inside a record that was mid-appended, and that fact is
   * reported rather than assumed: an unverified offset is never promoted into a
   * boundary, and a verified one never loses the record that starts on it.
   */
  readonly boundaryAtWindowStart: boolean;
  /**
   * Absolute offset through the last byte this call consumed (complete records
   * plus any partial it had to drop). A caller advances its own cursor here.
   */
  readonly scannedTo: number;
  /**
   * True only when `scannedTo` is a positively verified record boundary. When it
   * is false the caller must not treat that offset as a proven boundary.
   */
  readonly scannedToIsRecordBoundary: boolean;
  /** True when `from` was behind the window: bytes between them were NOT read. */
  readonly skippedBefore: boolean;
  /** True when a partial first segment was dropped because the window cut it. */
  readonly droppedLeadingPartial: boolean;
  /** True when the window ended inside a record; it stays unread until appended. */
  readonly trailingPartial: boolean;
  /** Complete records inside the window, in file order. Never includes partials. */
  readonly records: readonly string[];
  /** Count of complete records over `maxLineBytes`; those are not returned. */
  readonly oversizedLines: number;
}

export type NativeJsonlTailRead =
  | NativeJsonlTailSuccess
  | { readonly ok: false; readonly reason: NativeJsonlTailFailureReason };

function mapOpenError(error: unknown): NativeJsonlTailFailureReason {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return "unavailable";
  if (code === "ELOOP") return "symlink";
  if (code === "EISDIR" || code === "ENOTDIR") return "not-a-regular-file";
  return "unreadable";
}

/**
 * Read one bounded JSONL tail window of exactly one file.
 *
 * No retry, no queue, no watcher, no directory listing, and no state: the caller
 * owns the path, the cursor, and what a gap means.
 */
export async function readNativeJsonlTail(options: NativeJsonlTailOptions): Promise<NativeJsonlTailRead> {
  const maxBytes = options.maxBytes ?? MAX_NATIVE_JSONL_WINDOW_BYTES;
  const maxLineBytes = options.maxLineBytes ?? MAX_NATIVE_JSONL_LINE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("native JSONL tail maxBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
    throw new RangeError("native JSONL tail maxLineBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.from) || options.from < 0) {
    throw new RangeError("native JSONL tail from must be a non-negative safe integer");
  }
  if (typeof options.path !== "string" || options.path.length === 0 || !isAbsolute(options.path)) {
    return { ok: false, reason: "path-not-absolute" };
  }

  let handle: FileHandle | undefined;
  try {
    // No-follow: a swapped symlink is refused at open (ELOOP), not read through.
    handle = await fsPromises.open(options.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stats = await handle.stat();
    if (!stats.isFile()) return { ok: false, reason: "not-a-regular-file" };
    const identity: NativeJsonlFileIdentity = { dev: stats.dev, ino: stats.ino };
    if (options.expectIdentity !== undefined
      && (options.expectIdentity.dev !== identity.dev || options.expectIdentity.ino !== identity.ino)) {
      return { ok: false, reason: "identity-changed" };
    }
    const fileSize = stats.size;
    if (fileSize < options.from) return { ok: false, reason: "truncated" };

    const windowStart = Math.max(options.from, fileSize - maxBytes);
    const length = fileSize - windowStart;
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const chunk = await handle.read(buffer, read, length - read, windowStart + read);
      if (chunk.bytesRead === 0) break;
      read += chunk.bytesRead;
    }
    if (read < length) return { ok: false, reason: "truncated" };

    // Boundary verification: read the single byte just before the window through
    // this same handle. Only a line separator there proves the window starts on a
    // record boundary; anything else (including an unreadable probe) stays false.
    let boundaryAtWindowStart = windowStart === 0;
    if (!boundaryAtWindowStart) {
      const probe = Buffer.allocUnsafe(1);
      const probed = await handle.read(probe, 0, 1, windowStart - 1);
      boundaryAtWindowStart = probed.bytesRead === 1 && probe[0] === 0x0a;
    }

    // Newline bytes only occur as JSONL separators: UTF-8 continuation bytes are
    // >= 0x80, so splitting on 0x0a can never cut a character in half.
    let cursor = 0;
    let droppedLeadingPartial = false;
    if (!boundaryAtWindowStart) {
      const firstSeparator = buffer.indexOf(0x0a);
      if (firstSeparator < 0) {
        return {
          ok: true,
          identity,
          fileSize,
          windowStart,
          boundaryAtWindowStart,
          scannedTo: windowStart,
          scannedToIsRecordBoundary: false,
          skippedBefore: windowStart > options.from,
          droppedLeadingPartial: false,
          trailingPartial: buffer.length > 0,
          records: [],
          oversizedLines: 0,
        };
      }
      droppedLeadingPartial = firstSeparator > 0;
      cursor = firstSeparator + 1;
    }

    const records: string[] = [];
    // Fatal decoding: invalid UTF-8 bytes are a source failure, not a silent
    // replacement character that would keep a corrupt record parseable. The
    // existing catch below maps that throw to a closed unreadable reason, so no
    // record content can escape either way.
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let oversizedLines = 0;
    // `consumed` is one past the last newline actually consumed, so a trailing
    // partial record is never counted as scanned: it stays unread until the
    // provider appends the rest, and a caller that resumed here cannot skip it.
    let consumed = cursor;
    for (let index = cursor; index < buffer.length; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      const line = buffer.subarray(cursor, index);
      if (line.length > maxLineBytes) oversizedLines += 1;
      else records.push(decoder.decode(line));
      cursor = index + 1;
      consumed = cursor;
    }
    const trailingPartial = consumed < buffer.length;
    // `consumed` is exactly the offset the caller may resume from.
    return {
      ok: true,
      identity,
      fileSize,
      windowStart,
      boundaryAtWindowStart,
      scannedTo: windowStart + consumed,
      scannedToIsRecordBoundary: boundaryAtWindowStart || consumed > 0,
      skippedBefore: windowStart > options.from,
      droppedLeadingPartial,
      trailingPartial,
      records,
      oversizedLines,
    };
  } catch (error) {
    return { ok: false, reason: mapOpenError(error) };
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // The descriptor is already gone or the close raced disposal: nothing here
        // retries, and no record text survives this call either way.
      }
    }
  }
}
