/**
 * Bounded, confined reading of subtask evidence artifacts (#33).
 *
 * Every read is resolved against the task artifact root and refused when the
 * path escapes it, is a symlink target outside it, or is not a regular file.
 * Files are streamed in bounded chunks; JSONL records exceeding the decoder
 * limit are dropped (counted), and an unterminated final line is reported as a
 * torn tail instead of being emitted as a partial record.
 */
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { BoundedJsonlDecoder, MAX_JSONL_RECORD_BYTES, utf8Prefix } from "../../jsonl";
import { readBoundedTextFile } from "../../bounded-file";
import { EVIDENCE_RAW_RECORD_CONTENT_BYTES, EVIDENCE_SCAN_BYTES_PER_SOURCE, type SubtaskEvidenceUnavailableReason } from "./types";

/** Refusal of a path that violates artifact confinement (fail closed). */
export class EvidenceRefusalError extends Error {
  constructor(readonly reason: SubtaskEvidenceUnavailableReason, message: string) {
    super(message);
  }
}

export function evidenceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Caps raw record content before redaction (retention happens later). */
export function capRawContent(content: string): string {
  return utf8Prefix(content, EVIDENCE_RAW_RECORD_CONTENT_BYTES);
}

function escapesRoot(rootResolved: string, candidate: string): boolean {
  const rel = relative(rootResolved, resolve(candidate));
  return rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel);
}

/**
 * Resolve a file for reading. Returns undefined when the file is missing;
 * refuses (throws EvidenceRefusalError) non-regular files and paths whose
 * canonical location escapes the artifact root.
 */
export async function resolveReadableArtifact(root: string, candidate: string): Promise<string | undefined> {
  const rootResolved = resolve(root);
  if (escapesRoot(rootResolved, candidate)) {
    throw new EvidenceRefusalError("path_escape", `Evidence path "${candidate}" escapes its artifact root; refusing to read it.`);
  }
  const info = await lstat(candidate).catch(() => undefined); // missing is a normal unavailable state
  if (!info) return undefined;
  if (!info.isFile()) {
    throw new EvidenceRefusalError("non_regular_file", `Refusing to read non-regular file "${candidate}".`);
  }
  const real = await realpath(candidate).catch(() => undefined);
  if (real) {
    const rootReal = await realpath(rootResolved).catch(() => rootResolved);
    if (escapesRoot(rootReal, real)) {
      throw new EvidenceRefusalError("path_escape", `Refusing to read "${candidate}": canonical path escapes the artifact root.`);
    }
  }
  return resolve(candidate);
}

/** Resolve a directory for listing. Returns undefined when missing or not a directory. */
export async function resolveReadableDirectory(root: string, candidate: string): Promise<string | undefined> {
  const rootResolved = resolve(root);
  if (escapesRoot(rootResolved, candidate)) {
    throw new EvidenceRefusalError("path_escape", `Evidence path "${candidate}" escapes its artifact root; refusing to list it.`);
  }
  const info = await lstat(candidate).catch(() => undefined);
  if (!info || !info.isDirectory()) return undefined;
  const real = await realpath(candidate).catch(() => undefined);
  if (real) {
    const rootReal = await realpath(rootResolved).catch(() => rootResolved);
    if (escapesRoot(rootReal, real)) {
      throw new EvidenceRefusalError("path_escape", `Refusing to list "${candidate}": canonical path escapes the artifact root.`);
    }
  }
  return resolve(candidate);
}

export interface StreamedJsonl {
  lines: Array<{ text: string; digest: string }>;
  oversizedRecords: number;
  tornTail: boolean;
  bytesScanned: number;
  scanBudgetReached: boolean;
  /** Complete records seen but not retained (rolled out of the window or dropped by the shared budget). */
  recordsOmitted: number;
  /** Omissions caused specifically by the shared raw retention budget (sliding eviction). */
  budgetOmitted: number;
}

export interface StreamJsonlOptions {
  /** Shared pre-redaction raw retention budget charged with every retained line. */
  budget?: { remainingBytes: number; exhausted: boolean };
}

/**
 * Streams the bounded TAIL of a JSONL file in bounded chunks without
 * allocating its full size. Only the newest EVIDENCE_SCAN_BYTES_PER_SOURCE
 * bytes of the snapshot are scanned, so evidence appended beyond any fixed
 * offset stays reachable; when the window starts mid-file the initial partial
 * line is a boundary fragment and is discarded (disclosed via
 * `scanBudgetReached`). Retains the most recent `maxRecords` complete records
 * (a rolling tail window) and reports every omitted record count. Retained
 * lines are charged against the shared raw retention budget, which acts as a
 * sliding constraint: when a new line does not fit, the oldest retained lines
 * are evicted (returning their bytes and releasing their strings immediately)
 * until it does, so total discovery memory stays bounded across all sources.
 *
 * Line digests are salted with the opened descriptor's file generation
 * (dev:ino:birthtime), binding every cursor chain to the exact file that was
 * read: an atomic replacement (rename over) changes the generation even when
 * the covered bytes are identical, while ordinary appends preserve it.
 */
export async function streamJsonlBounded(path: string, maxRecords: number, options: StreamJsonlOptions = {}): Promise<StreamedJsonl> {
  const out: StreamedJsonl = { lines: [], oversizedRecords: 0, tornTail: false, bytesScanned: 0, scanBudgetReached: false, recordsOmitted: 0, budgetOmitted: 0 };
  const budget = options.budget;
  const handle = await open(path, "r");
  try {
    const identity = await handle.stat({ bigint: true });
    const generation = `${identity.dev}:${identity.ino}:${identity.birthtimeNs}`;
    const snapshotSize = Number(identity.size);
    const startOffset = Math.max(0, snapshotSize - EVIDENCE_SCAN_BYTES_PER_SOURCE);
    if (startOffset > 0) out.scanBudgetReached = true;
    let skipInitialFragment = startOffset > 0;
    let position = 0;
    let droppingTorn = false;
    let lastByte: number | undefined;
    const ring: Array<{ text: string; digest: string }> = [];
    let ringStart = 0;
    const evictOldest = (): void => {
      budget && (budget.remainingBytes += Buffer.byteLength(ring[ringStart]!.text, "utf8"));
      // Release the evicted string immediately; do not wait for compaction.
      ring[ringStart] = { text: "", digest: "" };
      ringStart += 1;
      out.recordsOmitted += 1;
    };
    const textDecoder = new TextDecoder("utf-8");
    const decoder = new BoundedJsonlDecoder((line) => {
      if (droppingTorn) {
        droppingTorn = false;
        out.tornTail = true;
        return;
      }
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (budget) {
        // Sliding shared budget: make room for the newest line by evicting
        // the oldest retained lines first (never stop retaining new evidence).
        let budgetConstrained = false;
        while (budget.remainingBytes < lineBytes && ring.length - ringStart > 0) {
          evictOldest();
          out.budgetOmitted += 1;
          budgetConstrained = true;
        }
        if (budget.remainingBytes < lineBytes) {
          // A single line larger than the entire shared budget is never retained.
          out.recordsOmitted += 1;
          out.budgetOmitted += 1;
          budget.exhausted = true;
          return;
        }
        if (budgetConstrained) budget.exhausted = true;
        budget.remainingBytes -= lineBytes;
      }
      ring.push({ text: line, digest: sha256Hex(`${generation}\n${line}`) });
      while (ring.length - ringStart > maxRecords) evictOldest(); // window eviction
      // Amortized compaction so the backing array never grows past ~2x retained.
      if (ringStart > 4096 && ringStart * 2 >= ring.length) {
        ring.splice(0, ringStart);
        ringStart = 0;
      }
    }, MAX_JSONL_RECORD_BYTES);
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const remaining = snapshotSize - startOffset - position;
      if (remaining <= 0) break;
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, remaining), startOffset + position);
      if (bytesRead === 0) break;
      position += bytesRead;
      out.bytesScanned += bytesRead;
      lastByte = chunk[bytesRead - 1];
      let bytes = chunk.subarray(0, bytesRead);
      if (skipInitialFragment) {
        // The window started mid-line: discard the boundary fragment up to
        // and including the first newline (it is never a complete record).
        const newline = bytes.indexOf(0x0a);
        if (newline < 0) continue; // the fragment spans this whole chunk
        bytes = bytes.subarray(newline + 1);
        skipInitialFragment = false;
      }
      if (bytes.length > 0) decoder.push(textDecoder.decode(bytes, { stream: true }));
    }
    const tail = textDecoder.decode();
    if (tail) decoder.push(tail);
    // A file whose final byte is not a newline ends in an unterminated line:
    // the decoder's pending record is torn, never a complete record.
    droppingTorn = lastByte !== undefined && lastByte !== 0x0a;
    out.oversizedRecords = decoder.finish().oversizedRecords;
    if (ringStart > 0) ring.splice(0, ringStart);
    out.lines = ring;
  } finally {
    await handle.close();
  }
  return out;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Reads and parses a small bounded JSON record; undefined when missing/invalid. */
export async function readBoundedJson(path: string, maxBytes: number): Promise<Record<string, unknown> | undefined> {
  const { text } = await readBoundedTextFile(path, maxBytes);
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}
