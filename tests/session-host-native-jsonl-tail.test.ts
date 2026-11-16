/**
 * Focused contract tests for the bounded single-file JSONL tail reader used by
 * native Claude status acquisition. Every file here is a synthetic file this test
 * created in its own temporary directory: no provider transcript, home directory,
 * session store, or process is involved.
 *
 * The assertions pin the bounds and the honesty of the surface: only complete
 * records inside one window come back, a partial trailing record stays unread, a
 * window that cannot cover the requested floor says so, an identity change or a
 * shrink is an explicit failure rather than an empty list, and nothing outside the
 * one bound path is ever opened.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test, { afterEach } from "node:test";

import {
  MAX_NATIVE_JSONL_LINE_BYTES,
  MAX_NATIVE_JSONL_WINDOW_BYTES,
  readNativeJsonlTail,
} from "../src/session-host/native-jsonl-tail";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempFile(contents: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prg-native-jsonl-tail-"));
  dirs.push(dir);
  const file = path.join(dir, "transcript.jsonl");
  await fs.writeFile(file, contents, "utf8");
  return file;
}

function line(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

test("defaults are bounded", () => {
  assert.ok(MAX_NATIVE_JSONL_WINDOW_BYTES > 0);
  assert.ok(MAX_NATIVE_JSONL_LINE_BYTES > 0);
  assert.ok(MAX_NATIVE_JSONL_LINE_BYTES <= MAX_NATIVE_JSONL_WINDOW_BYTES);
});

test("returns only complete records and reports the scanned offset", async () => {
  const body = line({ type: "user" }) + line({ type: "assistant" }) + line({ type: "system" });
  const file = await tempFile(body);
  const read = await readNativeJsonlTail({ path: file, from: 0 });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.records, [
    JSON.stringify({ type: "user" }),
    JSON.stringify({ type: "assistant" }),
    JSON.stringify({ type: "system" }),
  ]);
  assert.equal(read.boundaryAtWindowStart, true);
  assert.equal(read.scannedToIsRecordBoundary, true);
  assert.equal(read.scannedTo, Buffer.byteLength(body));
  assert.equal(read.fileSize, Buffer.byteLength(body));
  assert.equal(read.trailingPartial, false);
  assert.equal(read.droppedLeadingPartial, false);
  assert.equal(read.skippedBefore, false);
  assert.equal(read.oversizedLines, 0);
  assert.equal(typeof read.identity.ino, "number");
  assert.equal(typeof read.identity.dev, "number");
});

test("leaves a partial trailing record unread and resumable", async () => {
  const complete = line({ type: "user" });
  const partial = '{"type":"system","subtype":"stop_hook_summary"';
  const file = await tempFile(complete + partial);
  const read = await readNativeJsonlTail({ path: file, from: 0 });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.records, [JSON.stringify({ type: "user" })]);
  assert.equal(read.trailingPartial, true);
  assert.equal(read.scannedTo, Buffer.byteLength(complete));

  // The append makes it complete, and resuming from the reported offset reads it.
  await fs.appendFile(file, ',"preventedContinuation":true}\n', "utf8");
  const next = await readNativeJsonlTail({ path: file, from: read.scannedTo });
  assert.equal(next.ok, true);
  if (!next.ok) return;
  assert.equal(next.records.length, 1);
  assert.deepEqual(JSON.parse(next.records[0]), { type: "system", subtype: "stop_hook_summary", preventedContinuation: true });
});

test("drops a leading partial when the window starts inside a record", async () => {
  const body = line({ type: "user" }) + line({ type: "assistant" });
  const file = await tempFile(body);
  const inside = 3;
  const read = await readNativeJsonlTail({ path: file, from: inside });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.records, [JSON.stringify({ type: "assistant" })]);
  assert.equal(read.droppedLeadingPartial, true);
  assert.equal(read.boundaryAtWindowStart, false);
  assert.equal(read.scannedToIsRecordBoundary, true);
  assert.equal(read.skippedBefore, false);
});

test("a window that starts exactly on a verified boundary keeps the first record", async () => {
  const first = line({ type: "user" });
  const body = first + line({ type: "assistant" });
  const file = await tempFile(body);
  const read = await readNativeJsonlTail({ path: file, from: Buffer.byteLength(first) });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.records, [JSON.stringify({ type: "assistant" })]);
  assert.equal(read.boundaryAtWindowStart, true);
  assert.equal(read.droppedLeadingPartial, false);
  assert.equal(read.scannedToIsRecordBoundary, true);
});

test("an empty read at an unverified offset is never promoted to a boundary", async () => {
  // The file's last record is still mid-append, so the byte before the end of
  // file is not a separator: the reported offset must be flagged unverified.
  const body = line({ type: "user" }) + '{"type":"system","subtype":"stop_hook_summary"';
  const file = await tempFile(body);
  const read = await readNativeJsonlTail({ path: file, from: Buffer.byteLength(body) });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.records, []);
  assert.equal(read.boundaryAtWindowStart, false);
  assert.equal(read.scannedToIsRecordBoundary, false);
  assert.equal(read.scannedTo, Buffer.byteLength(body));
});

test("an empty read at a verified boundary reports that boundary", async () => {
  const body = line({ type: "user" });
  const file = await tempFile(body);
  const read = await readNativeJsonlTail({ path: file, from: Buffer.byteLength(body) });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.records, []);
  assert.equal(read.boundaryAtWindowStart, true);
  assert.equal(read.scannedToIsRecordBoundary, true);
});

test("reports a window that cannot cover the requested floor", async () => {
  const body = line({ type: "user", pad: "a".repeat(200) }) + line({ type: "system" });
  const file = await tempFile(body);
  const read = await readNativeJsonlTail({ path: file, from: 0, maxBytes: 64 });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.skippedBefore, true);
  assert.equal(read.records.length, 1);
});

test("counts an oversized record instead of returning it", async () => {
  const body = line({ type: "user", pad: "b".repeat(400) }) + line({ type: "system" });
  const file = await tempFile(body);
  const read = await readNativeJsonlTail({ path: file, from: 0, maxBytes: 4096, maxLineBytes: 256 });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.equal(read.oversizedLines, 1);
  assert.deepEqual(read.records, [JSON.stringify({ type: "system" })]);
  assert.equal(read.scannedTo, Buffer.byteLength(body));
});

test("a record with invalid UTF-8 bytes fails the read instead of decoding silently", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prg-native-jsonl-tail-"));
  dirs.push(dir);
  const file = path.join(dir, "transcript.jsonl");
  await fs.writeFile(file, Buffer.concat([
    Buffer.from(line({ type: "user" })),
    Buffer.from('{"type":"system","text":"bad'),
    // 0xc3 starts a two-byte sequence that 0x28 cannot continue: fatal decoding
    // rejects it, where a permissive decode would silently produce a replacement
    // character and leave a corrupt record parseable as JSON.
    Buffer.from([0xc3, 0x28, 0xe2, 0x82]),
    Buffer.from('plain"}\n'),
    Buffer.from(line({ type: "assistant" })),
  ]));
  const read = await readNativeJsonlTail({ path: file, from: 0 });
  assert.deepEqual(read, { ok: false, reason: "unreadable" });
});

test("refuses an identity change rather than reading a replacement file", async () => {
  const file = await tempFile(line({ type: "user" }));
  const read = await readNativeJsonlTail({ path: file, from: 0, expectIdentity: { dev: 999_999, ino: 888_888 } });
  assert.deepEqual(read, { ok: false, reason: "identity-changed" });
});

test("reports a shrink as truncation", async () => {
  const body = line({ type: "user" }) + line({ type: "assistant" });
  const file = await tempFile(body);
  await fs.truncate(file, 4);
  const read = await readNativeJsonlTail({ path: file, from: Buffer.byteLength(body) });
  assert.deepEqual(read, { ok: false, reason: "truncated" });
});

test("an empty window at the cursor is a clean no-op", async () => {
  const body = line({ type: "user" });
  const file = await tempFile(body);
  const read = await readNativeJsonlTail({ path: file, from: Buffer.byteLength(body) });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.records, []);
  assert.equal(read.trailingPartial, false);
  assert.equal(read.boundaryAtWindowStart, true);
  assert.equal(read.scannedTo, Buffer.byteLength(body));
});

test("refuses anything that is not one readable regular file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "prg-native-jsonl-tail-"));
  dirs.push(dir);

  assert.deepEqual(await readNativeJsonlTail({ path: "relative.jsonl", from: 0 }), {
    ok: false,
    reason: "path-not-absolute",
  });
  assert.deepEqual(await readNativeJsonlTail({ path: path.join(dir, "missing.jsonl"), from: 0 }), {
    ok: false,
    reason: "unavailable",
  });
  assert.deepEqual(await readNativeJsonlTail({ path: dir, from: 0 }), {
    ok: false,
    reason: "not-a-regular-file",
  });

  if (process.platform !== "win32") {
    const target = path.join(dir, "transcript.jsonl");
    await fs.writeFile(target, line({ type: "user" }), "utf8");
    const link = path.join(dir, "link.jsonl");
    await fs.symlink(target, link);
    assert.deepEqual(await readNativeJsonlTail({ path: link, from: 0 }), { ok: false, reason: "symlink" });
  }
});

test("rejects invalid bounds instead of reading without a limit", async () => {
  const file = await tempFile(line({ type: "user" }));
  await assert.rejects(() => readNativeJsonlTail({ path: file, from: 0, maxBytes: 0 }), RangeError);
  await assert.rejects(() => readNativeJsonlTail({ path: file, from: 0, maxLineBytes: -1 }), RangeError);
  await assert.rejects(() => readNativeJsonlTail({ path: file, from: -1 }), RangeError);
});

test("multibyte content survives a record-boundary window", async () => {
  const body = line({ type: "user", text: "héllo 🌍" }) + line({ type: "system" });
  const file = await tempFile(body);
  const from = Buffer.byteLength(line({ type: "user", text: "héllo 🌍" }));
  const read = await readNativeJsonlTail({ path: file, from });
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.records, [JSON.stringify({ type: "system" })]);
});
