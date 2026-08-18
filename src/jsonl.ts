import { Buffer } from "node:buffer";

export const MEBIBYTE = 1024 * 1024;

/**
 * Maximum size of one structured JSONL record. This is deliberately separate
 * from retained stdout: protocol consumers should not depend on where display
 * capture happens to truncate.
 */
export const MAX_JSONL_RECORD_BYTES = 16 * MEBIBYTE;

export interface JsonlDecoderStats {
  oversizedRecords: number;
}

/** Bounded UTF-8 text accumulator with O(new-chunk) append accounting. */
export class BoundedTextAccumulator {
  private current = "";
  private currentBytes = 0;
  private receivedBytes = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("maxBytes must be a positive safe integer");
    }
  }

  get value(): string {
    return this.current;
  }

  get bytes(): number {
    return this.receivedBytes;
  }

  get truncated(): boolean {
    return this.receivedBytes > this.currentBytes;
  }

  clear(): void {
    this.current = "";
    this.currentBytes = 0;
    this.receivedBytes = 0;
  }

  set(value: string): void {
    this.clear();
    this.append(value);
  }

  append(value: string): void {
    this.receivedBytes += Buffer.byteLength(value);
    const remaining = this.maxBytes - this.currentBytes;
    if (remaining <= 0 || !value) return;
    const addition = utf8Prefix(value, remaining);
    this.current += addition;
    this.currentBytes += Buffer.byteLength(addition);
  }
}

export function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, midpoint)) <= maxBytes) low = midpoint;
    else high = midpoint - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1] ?? "") && /[\uDC00-\uDFFF]/.test(value[low] ?? "")) low -= 1;
  return value.slice(0, low);
}

/**
 * Incrementally splits decoded UTF-8 text into bounded JSONL records. Once a
 * record exceeds the limit, its remainder is discarded through the next
 * newline rather than retained in memory.
 */
export class BoundedJsonlDecoder {
  private pending = "";
  private pendingBytes = 0;
  private discardingOversizedRecord = false;
  private oversizedRecords = 0;

  constructor(
    private readonly onRecord: (record: string) => void,
    private readonly maxRecordBytes = MAX_JSONL_RECORD_BYTES,
  ) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) {
      throw new Error("maxRecordBytes must be a positive safe integer");
    }
  }

  push(chunk: string): void {
    let offset = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", offset);
      if (newline < 0) {
        this.append(chunk.slice(offset), false);
        return;
      }
      this.append(chunk.slice(offset, newline), true);
      offset = newline + 1;
    }
  }

  finish(): JsonlDecoderStats {
    if (!this.discardingOversizedRecord && this.pending.length > 0) {
      this.emitPending();
    }
    this.pending = "";
    this.pendingBytes = 0;
    this.discardingOversizedRecord = false;
    return this.stats();
  }

  stats(): JsonlDecoderStats {
    return { oversizedRecords: this.oversizedRecords };
  }

  private append(segment: string, terminated: boolean): void {
    if (this.discardingOversizedRecord) {
      if (terminated) this.discardingOversizedRecord = false;
      return;
    }

    const segmentBytes = Buffer.byteLength(segment);
    if (this.pendingBytes + segmentBytes > this.maxRecordBytes) {
      this.pending = "";
      this.pendingBytes = 0;
      this.oversizedRecords += 1;
      this.discardingOversizedRecord = !terminated;
      return;
    }

    this.pending += segment;
    this.pendingBytes += segmentBytes;
    if (terminated) this.emitPending();
  }

  private emitPending(): void {
    const record = this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending;
    this.pending = "";
    this.pendingBytes = 0;
    this.onRecord(record);
  }
}
