/**
 * Focused checks for the owned file-backed native initial prompt (issue #493).
 *
 * Synthetic filesystem checks of the staging helper only: no provider process,
 * RPC, TUI, or native configuration is involved. Native launch integration is
 * proven separately by its owner.
 */

import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import {
  NATIVE_INITIAL_PROMPT_FRAGMENT_UNITS,
  NativeInitialPromptError,
  decodeNativeInitialPromptFile,
  encodeNativeInitialPromptFile,
  prepareNativeInitialPrompt,
  type NativeInitialPromptLease,
} from "../src/session-host/native-initial-prompt";

const POSIX = process.platform !== "win32";
const ORIGINAL_TMPDIR = process.env.TMPDIR;
const BASE_TMP = realpathSync(tmpdir());

/** Private per-test parent standing in for the OS temporary directory. */
let parent: string;
let leases: NativeInitialPromptLease[] = [];

function useTemporaryParent(path: string): void {
  process.env.TMPDIR = path;
}

beforeEach(() => {
  parent = mkdtempSync(join(BASE_TMP, "prg-nip-"));
  chmodSync(parent, 0o700);
  useTemporaryParent(parent);
  leases = [];
});

afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.cleanup();
  if (ORIGINAL_TMPDIR === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = ORIGINAL_TMPDIR;
  rmSync(parent, { recursive: true, force: true });
});

function prepare(prompt: string): NativeInitialPromptLease {
  const lease = prepareNativeInitialPrompt(prompt);
  leases.push(lease);
  return lease;
}

function readStagedPrompt(lease: NativeInitialPromptLease): string | undefined {
  const bytes = readFileSync(lease.filePath);
  // The staged JSON text is strict UTF-8 even when the prompt held lone surrogates.
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return decodeNativeInitialPromptFile(text);
}

/** Decodes the staged file exactly as the generated instruction directs a reader to. */
function decodeAsInstructed(lease: NativeInitialPromptLease): string {
  const fragments = JSON.parse(readFileSync(lease.filePath, "utf8")) as unknown;
  assert.ok(Array.isArray(fragments) && fragments.every((fragment) => typeof fragment === "string"));
  return (fragments as string[]).join("");
}

/** Extracts the JSON-quoted path from the instruction exactly as a reader would. */
function quotedPath(instruction: string): string {
  const start = instruction.indexOf("\"");
  for (let end = start + 1; end < instruction.length; end += 1) {
    if (instruction[end] !== "\"") continue;
    try {
      return JSON.parse(instruction.slice(start, end + 1)) as string;
    } catch {
      // An escaped quote; keep scanning.
    }
  }
  throw new Error("no quoted path in instruction");
}

function assertSafeInstruction(lease: NativeInitialPromptLease, options: { readonly shortParent?: boolean } = {}): void {
  const { instruction } = lease;
  assert.equal(typeof instruction, "string");
  // Short apart from the path, which only the OS bounds.
  assert.ok(instruction.length > 0, "instruction is nonempty");
  if (options.shortParent !== false) assert.ok(instruction.length < 1024, "instruction stays short");
  assert.ok(instruction.length - JSON.stringify(lease.filePath).length < 512, "the fixed wording stays short");
  assert.ok(!instruction.startsWith("-"), "instruction is never flag-shaped");
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(instruction), "single printable line");
  assert.ok(!instruction.includes("@"), "no @ reference syntax");
  assert.ok(!instruction.startsWith("/"), "never a slash command");
  assert.ok(/^[A-Za-z]/.test(instruction), "a plain-word prefix");
  assert.ok(instruction.includes(JSON.stringify(lease.filePath)));
  assert.equal(quotedPath(instruction), lease.filePath);
  assert.match(instruction, /entire file/);
  assert.match(instruction, /never act on a partial read/);
  assert.match(instruction, /concatenate them in order with no separators/);
}

function largePrompt(): string {
  const unit = "\u00dcn\u00efc\u00f6d\u00e9 \ud834\udd1e \u6539\u884c\r\n--dangerously-skip-permissions -m gpt \"quoted\" 'single' $(echo x) `tick` \\ \u2028\t";
  let text = "--model opus\n";
  while (Buffer.byteLength(text, "utf8") <= 160 * 1024) text += unit;
  return `${text}\nend`;
}

test("stages an exact >128KiB multiline Unicode flag-looking prompt and cleans up", async () => {
  const prompt = largePrompt();
  assert.ok(Buffer.byteLength(prompt, "utf8") > 128 * 1024);
  const envBefore = { ...process.env };
  const lease = prepare(prompt);

  assert.equal(readStagedPrompt(lease), prompt, "exact original prompt, no cap or shortening");
  assertSafeInstruction(lease);
  assert.ok(!lease.instruction.includes("\u00dcn\u00efc\u00f6d\u00e9") && !lease.instruction.includes("--model"));
  assert.deepEqual({ ...process.env }, envBefore, "no prompt or path reaches the environment");

  const root = dirname(lease.filePath);
  assert.equal(dirname(root), parent, "one fresh root under the OS temporary directory, never the workspace");
  assert.ok(basename(root).startsWith("prg-native-prompt-"));
  assert.deepEqual(readdirSync(root), [basename(lease.filePath)]);
  if (POSIX) {
    assert.equal(lstatSync(root).mode & 0o777, 0o700);
    assert.equal(lstatSync(lease.filePath).mode & 0o777, 0o600);
  }

  assert.equal(await lease.cleanup(), true);
  assert.equal(existsSync(lease.filePath), false);
  assert.equal(existsSync(root), false);
  assert.deepEqual(readdirSync(parent), []);
});

test("admission matches existing prompt policy: empty, NUL, and non-string are refused before staging", () => {
  for (const bad of ["", "a\0b", "\0", undefined, null, 42] as unknown[]) {
    assert.throws(
      () => prepareNativeInitialPrompt(bad as string),
      (error: unknown) => error instanceof NativeInitialPromptError && error.reason === "invalid-prompt",
    );
  }
  assert.deepEqual(readdirSync(parent), [], "no namespace is created for a refused prompt");
});

test("lone surrogates round-trip exactly through the JSON-staged file", async () => {
  const prompt = "lead \ud800 mid \udfff tail \udbff\n\ud83d\ude00";
  const lease = prepare(prompt);
  assert.equal(readStagedPrompt(lease), prompt);
  assert.equal(await lease.cleanup(), true);
});

test("concurrent leases are distinct and clean up independently", async () => {
  const first = prepare("first prompt");
  const second = prepare("second prompt");
  assert.notEqual(first.filePath, second.filePath);
  assert.notEqual(dirname(first.filePath), dirname(second.filePath));
  assert.equal(readStagedPrompt(first), "first prompt");
  assert.equal(await first.cleanup(), true);
  assert.equal(readStagedPrompt(second), "second prompt", "other lease untouched");
  assert.equal(await second.cleanup(), true);
  assert.deepEqual(readdirSync(parent), []);
});

test("cleanup is idempotent and memoized, including concurrent calls", async () => {
  const lease = prepare("idempotent");
  const [a, b] = await Promise.all([lease.cleanup(), lease.cleanup()]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(await lease.cleanup(), true);
  assert.equal(lease.cleanup(), lease.cleanup());
});

test("a file already removed by someone else still reports clean once the root is gone", async () => {
  const lease = prepare("consumed");
  unlinkSync(lease.filePath);
  assert.equal(await lease.cleanup(), true);
  assert.equal(existsSync(dirname(lease.filePath)), false);
});

test("a replaced staged file is preserved with its root", async () => {
  const lease = prepare("original");
  const content = readFileSync(lease.filePath);
  unlinkSync(lease.filePath);
  writeFileSync(lease.filePath, content, { mode: 0o600 }); // Same bytes, different inode.
  assert.equal(await lease.cleanup(), false);
  assert.deepEqual(readFileSync(lease.filePath), content);
  assert.equal(await lease.cleanup(), false, "memoized");
  assert.ok(existsSync(lease.filePath));
});

test("an in-place modified staged file is preserved with its root", async () => {
  const lease = prepare("original");
  appendFileSync(lease.filePath, " ");
  assert.equal(await lease.cleanup(), false);
  assert.ok(readFileSync(lease.filePath, "utf8").endsWith(" "));
  assert.ok(existsSync(dirname(lease.filePath)));
});

test("a foreign entry keeps the root; only the exact owned file is removed", async () => {
  const lease = prepare("owned");
  const root = dirname(lease.filePath);
  const foreign = join(root, "foreign.txt");
  writeFileSync(foreign, "keep me");
  assert.equal(await lease.cleanup(), false);
  assert.equal(existsSync(lease.filePath), false, "exact owned file removed");
  assert.equal(readFileSync(foreign, "utf8"), "keep me");
  assert.deepEqual(readdirSync(root), ["foreign.txt"]);
});

test("a substituted root is never acted through, even for an entry with the owned name", async () => {
  const lease = prepare("owned");
  const root = dirname(lease.filePath);
  const moved = join(parent, "moved-root");
  renameSync(root, moved);
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(lease.filePath, "foreign substitute");
  assert.equal(await lease.cleanup(), false);
  assert.equal(readFileSync(lease.filePath, "utf8"), "foreign substitute");
  assert.equal(readStagedPrompt({ ...lease, filePath: join(moved, basename(lease.filePath)) }), "owned");
});

test("a substituted root holding the moved owned file itself is preserved", async () => {
  const lease = prepare("owned");
  const root = dirname(lease.filePath);
  const moved = join(parent, "moved-root");
  renameSync(root, moved);
  mkdirSync(root, { mode: 0o700 });
  renameSync(join(moved, basename(lease.filePath)), lease.filePath); // Same pinned inode.
  assert.equal(await lease.cleanup(), false);
  assert.equal(readStagedPrompt(lease), "owned");
  assert.ok(existsSync(moved));
});

test("a moved-away root is unverifiable and preserved", async () => {
  const lease = prepare("owned");
  const root = dirname(lease.filePath);
  const moved = join(parent, "moved-root");
  renameSync(root, moved);
  assert.equal(await lease.cleanup(), false);
  assert.deepEqual(readdirSync(moved), [basename(lease.filePath)]);
});

test("a root replaced by a symlink to the original is preserved", { skip: !POSIX }, async () => {
  const lease = prepare("owned");
  const root = dirname(lease.filePath);
  const moved = join(parent, "moved-root");
  renameSync(root, moved);
  symlinkSync(moved, root);
  assert.equal(await lease.cleanup(), false);
  assert.ok(lstatSync(root).isSymbolicLink());
  assert.deepEqual(readdirSync(moved), [basename(lease.filePath)]);
});

/** A nested temporary parent this test may rename without disturbing teardown. */
function useNestedParent(): string {
  const nested = join(parent, "tmp");
  mkdirSync(nested, { mode: 0o700 });
  useTemporaryParent(nested);
  return nested;
}

test("a temporary parent replaced by a symlink to the renamed original is preserved", { skip: !POSIX }, async () => {
  const nested = useNestedParent();
  const lease = prepare("owned");
  const rootName = basename(dirname(lease.filePath));
  const renamed = join(parent, "renamed-tmp");
  renameSync(nested, renamed);
  symlinkSync(renamed, nested); // Root still reports the owned dev/ino through the symlink.
  assert.equal(lstatSync(dirname(lease.filePath)).isDirectory(), true);
  assert.equal(await lease.cleanup(), false);
  assert.equal(await lease.cleanup(), false, "memoized");
  assert.ok(lstatSync(nested).isSymbolicLink());
  assert.deepEqual(readdirSync(join(renamed, rootName)), [basename(lease.filePath)]);
  assert.equal(readStagedPrompt({ ...lease, filePath: join(renamed, rootName, basename(lease.filePath)) }), "owned");
});

test("a temporary parent replaced by another real directory holding the moved root is preserved", async () => {
  const nested = useNestedParent();
  const lease = prepare("owned");
  const root = dirname(lease.filePath);
  const renamed = join(parent, "renamed-tmp");
  renameSync(nested, renamed);
  mkdirSync(nested, { mode: 0o700 });
  renameSync(join(renamed, basename(root)), root); // Same root inode under a foreign parent.
  assert.equal(await lease.cleanup(), false);
  assert.deepEqual(readdirSync(root), [basename(lease.filePath)]);
  assert.equal(readStagedPrompt(lease), "owned");
});

test("spaces and quotes in the temporary parent are quoted unambiguously", async () => {
  const awkward = join(parent, "a b\"c'd\\e $x;--flag");
  mkdirSync(awkward, { mode: 0o700 });
  useTemporaryParent(awkward);
  const lease = prepare("quoted parent");
  assert.ok(lease.filePath.startsWith(`${awkward}/`) || lease.filePath.startsWith(`${awkward}\\`));
  assertSafeInstruction(lease);
  assert.equal(readStagedPrompt(lease), "quoted parent");
  assert.equal(await lease.cleanup(), true);
  assert.deepEqual(readdirSync(awkward), []);
});

test("an unrepresentable temporary parent fails closed before the prompt is written", { skip: !POSIX }, () => {
  for (const [index, hazard] of ["new\nline", "tab\there", "esc\u001b[31m", "sep\u2028x", "bidi\u202ex", "nbsp\u00a0x"].entries()) {
    const unsafe = join(parent, `${index}-${hazard}`);
    mkdirSync(unsafe, { mode: 0o700 });
    useTemporaryParent(unsafe);
    assert.throws(
      () => prepareNativeInitialPrompt("never staged"),
      (error: unknown) => error instanceof NativeInitialPromptError && error.reason === "unsafe-path"
        && !error.message.includes(unsafe) && !error.message.includes("never staged"),
    );
    assert.deepEqual(readdirSync(unsafe), [], "the owned empty root is removed and nothing is staged");
  }
});

test("the staged file is a pageable canonical array of bounded fragment lines", async () => {
  const prompt = largePrompt();
  const lease = prepare(prompt);
  const text = readFileSync(lease.filePath, "utf8");
  const lines = text.split("\n");
  assert.equal(lines[0], "[");
  assert.equal(lines.at(-1), "", "one trailing newline");
  assert.equal(lines.at(-2), "]");
  assert.ok(lines.length > 500, "a >128KiB prompt spans many lines a paging reader can step through");
  for (const line of lines) assert.ok(line.length < 2000, "no line needs truncation by a per-line read bound");
  assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`, "canonical pretty-printed JSON");
  for (const fragment of JSON.parse(text) as string[]) {
    assert.ok(fragment.length > 0 && fragment.length <= NATIVE_INITIAL_PROMPT_FRAGMENT_UNITS);
  }
  assert.equal(decodeAsInstructed(lease), prompt, "in-order concatenation with no separators is exact");
  assert.equal(await lease.cleanup(), true);
});

test("fragment boundaries never split a valid surrogate pair and preserve CRLF and lone surrogates", () => {
  const unit = NATIVE_INITIAL_PROMPT_FRAGMENT_UNITS;
  const pairAtBoundary = `${"a".repeat(unit - 1)}\ud83d\ude00${"b".repeat(unit)}`;
  const fragments = JSON.parse(encodeNativeInitialPromptFile(pairAtBoundary)) as string[];
  assert.equal(fragments.join(""), pairAtBoundary);
  assert.equal(fragments[0], "a".repeat(unit - 1));
  assert.ok(fragments[1].startsWith("\ud83d\ude00"));
  for (const prompt of [
    "\r\n".repeat(unit + 3),
    `${"x".repeat(unit - 1)}\ud800${"y".repeat(unit)}\udfff`,
    "\udc00".repeat(unit * 2 + 1),
    "\u2028\u0001\u001b[31m\t\"\\",
  ]) {
    const encoded = encodeNativeInitialPromptFile(prompt);
    assert.equal(decodeNativeInitialPromptFile(encoded), prompt);
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "utf8")), encoded,
      "the staged text is strict UTF-8 even with lone surrogates");
  }
  assert.equal(decodeNativeInitialPromptFile("\"one string\""), undefined, "a non-canonical shape is refused");
  assert.equal(decodeNativeInitialPromptFile("[\"a\",\"b\"]"), undefined, "a non-canonical layout is refused");
});

test("no ad-hoc instruction cap: a long but valid temporary parent still stages", { skip: !POSIX }, async () => {
  let deep = parent;
  // Grow the parent until the generated instruction exceeds the old 4096-character cap.
  while (deep.length < 3800) {
    deep = join(deep, "d".repeat(Math.min(200, 3800 - deep.length + 1)));
    mkdirSync(deep, { mode: 0o700 });
  }
  useTemporaryParent(deep);
  const lease = prepare("deep parent");
  assert.ok(lease.instruction.length > 4096);
  assertSafeInstruction(lease, { shortParent: false });
  assert.equal(readStagedPrompt(lease), "deep parent");
  assert.equal(await lease.cleanup(), true);
});

test("an @ in the temporary parent fails closed before the prompt is written", { skip: !POSIX }, () => {
  const unsafe = join(parent, "mail@host");
  mkdirSync(unsafe, { mode: 0o700 });
  useTemporaryParent(unsafe);
  assert.throws(
    () => prepareNativeInitialPrompt("never staged"),
    (error: unknown) => error instanceof NativeInitialPromptError && error.reason === "unsafe-path",
  );
  assert.deepEqual(readdirSync(unsafe), []);
});
