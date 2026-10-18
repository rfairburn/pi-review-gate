/**
 * Focused private staged-payload transport checks (issue #447).
 *
 * These are synthetic filesystem checks of the exact helper used by the
 * production reporter, broker, manager, and child startup handshake. They do
 * not claim native SessionSpawn integration; that proof belongs to the
 * native-backend fixture.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
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
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import {
  SessionHostPayloadError,
  __test as payloadTest,
  decodeSessionHostPayloadJsonString,
  readSessionHostPayload,
  readSessionHostPayloadSync,
  stageSessionHostPayload,
} from "../src/session-host/payload";
import { parseSessionHostPayloadRef, type SessionHostPayloadRef } from "../src/session-host/protocol";

let root: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "prg-payload-test-"));
  chmodSync(root, 0o700);
});

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function payloadDir(): string {
  assert.ok(root);
  return root;
}

function fileFor(descriptor: SessionHostPayloadRef): string {
  return join(payloadDir(), descriptor.name);
}

function replacementDescriptor(name: string, bytes: Buffer): SessionHostPayloadRef {
  return { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function expectPayloadFailure(
  promise: Promise<unknown>,
  reason: SessionHostPayloadError["reason"],
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SessionHostPayloadError);
    assert.equal(error.reason, reason);
    assert.equal(error.message.includes(payloadDir()), false, "failure text never discloses a path");
    return true;
  });
}

function expectSyncPayloadFailure(
  action: () => unknown,
  reason: SessionHostPayloadError["reason"],
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof SessionHostPayloadError);
    assert.equal(error.reason, reason);
    return true;
  });
}

test("stages and consumes one exact >8 KiB structured prompt through async and sync reads", async () => {
  const prompt = [
    "BEGIN exact long prompt",
    "ASCII quote-heavy line: \"double\" and 'single' and `backtick`.",
    "Multibyte: 日本語 — café — 🚀 — \u{1F642}",
    "Flag-looking data: --session /tmp/not-a-session @literal.md /prompt-template literal",
    "MIDDLE",
    "x".repeat(12_000),
    "END exact long prompt",
    "Trailing newline is preserved.\n",
  ].join("\n");
  assert.ok(Buffer.byteLength(prompt, "utf8") > 8192);

  const first = stageSessionHostPayload(payloadDir(), JSON.stringify(prompt));
  const firstPath = fileFor(first.descriptor);
  if (process.platform !== "win32") {
    assert.equal(lstatSync(payloadDir()).mode & 0o777, 0o700, "the namespace is private");
    assert.equal(lstatSync(firstPath).mode & 0o777, 0o600, "the staged file is owner-only");
  }
  const firstText = await readSessionHostPayload(payloadDir(), first.descriptor);
  assert.equal(decodeSessionHostPayloadJsonString(firstText), prompt, "the exact prompt round-trips with no truncation");
  assert.equal(lstatSync(firstPath, { throwIfNoEntry: false }), undefined, "a verified successful read consumes its exact file");

  const second = stageSessionHostPayload(payloadDir(), JSON.stringify(prompt));
  const secondText = readSessionHostPayloadSync(payloadDir(), second.descriptor);
  assert.equal(decodeSessionHostPayloadJsonString(secondText), prompt, "the synchronous startup reader preserves the same exact text");
  assert.equal(lstatSync(fileFor(second.descriptor), { throwIfNoEntry: false }), undefined);
});

test("JSON staging preserves lone surrogates, newlines, quotes, and flag-like strings exactly", async () => {
  const exact = ` lone:\uD800:mid:\uDFFF:\n--session "quoted"\n--flag=value\n`;
  const staged = stageSessionHostPayload(payloadDir(), JSON.stringify(exact));
  const text = await readSessionHostPayload(payloadDir(), staged.descriptor);
  const decoded = decodeSessionHostPayloadJsonString(text);
  assert.equal(decoded, exact);
  assert.equal(decoded?.charCodeAt(decoded.indexOf("lone:") + 5), 0xd800);
  assert.equal(decodeSessionHostPayloadJsonString(JSON.stringify("")), undefined, "an empty prompt remains invalid");
  assert.equal(decodeSessionHostPayloadJsonString(JSON.stringify("a\0b")), undefined, "NUL policy is unchanged");
  assert.equal(decodeSessionHostPayloadJsonString(JSON.stringify({ prompt: exact })), undefined, "only a string value is admitted");
  assert.equal(decodeSessionHostPayloadJsonString("{not json"), undefined);
});

test("rejects missing, truncated, suffixed, tampered, and replaced payload files without deleting them", async () => {
  const missingName = `p-${"1".repeat(32)}.json`;
  await expectPayloadFailure(
    readSessionHostPayload(payloadDir(), { name: missingName, size: 1, sha256: "2".repeat(64) }),
    "unavailable",
  );
  assert.equal(lstatSync(join(payloadDir(), missingName), { throwIfNoEntry: false }), undefined);

  const truncated = stageSessionHostPayload(payloadDir(), JSON.stringify("exact prompt"));
  writeFileSync(fileFor(truncated.descriptor), "exact", "utf8");
  await expectPayloadFailure(readSessionHostPayload(payloadDir(), truncated.descriptor), "size-mismatch");
  assert.ok(lstatSync(fileFor(truncated.descriptor)).isFile(), "a rejected size mismatch is preserved");

  const suffixed = stageSessionHostPayload(payloadDir(), JSON.stringify("exact prompt"));
  appendFileSync(fileFor(suffixed.descriptor), "suffix");
  await expectPayloadFailure(readSessionHostPayload(payloadDir(), suffixed.descriptor), "size-mismatch");
  expectSyncPayloadFailure(
    () => readSessionHostPayloadSync(payloadDir(), suffixed.descriptor),
    "size-mismatch",
  );

  const tampered = stageSessionHostPayload(payloadDir(), JSON.stringify("original prompt"));
  const tamperedPath = fileFor(tampered.descriptor);
  const originalBytes = readFileSync(tamperedPath);
  const replacementBytes = Buffer.from(originalBytes);
  replacementBytes[replacementBytes.length - 3] = replacementBytes[replacementBytes.length - 3]! ^ 0x01;
  writeFileSync(tamperedPath, replacementBytes);
  await expectPayloadFailure(readSessionHostPayload(payloadDir(), tampered.descriptor), "digest-mismatch");
  assert.deepEqual(readFileSync(tamperedPath), replacementBytes, "tampered content is preserved for its owner");

  const replaced = stageSessionHostPayload(payloadDir(), JSON.stringify("owned original"));
  const replacedBytes = readFileSync(fileFor(replaced.descriptor));
  const foreign = Buffer.from("F".repeat(replacedBytes.length));
  unlinkSync(fileFor(replaced.descriptor));
  writeFileSync(fileFor(replaced.descriptor), foreign);
  await expectPayloadFailure(readSessionHostPayload(payloadDir(), replaced.descriptor), "digest-mismatch");
  replaced.discard();
  assert.deepEqual(readFileSync(fileFor(replaced.descriptor)), foreign, "a replaced/unknown entry is never deleted");

  const discarded = stageSessionHostPayload(payloadDir(), JSON.stringify("discard me"));
  assert.ok(lstatSync(fileFor(discarded.descriptor)).isFile());
  discarded.discard();
  assert.equal(lstatSync(fileFor(discarded.descriptor), { throwIfNoEntry: false }), undefined);
  discarded.discard(); // Idempotent, and never touches a later replacement.
});

test("rejects unsafe namespaces and non-regular replacements before reading", async () => {
  const staged = stageSessionHostPayload(payloadDir(), JSON.stringify("confined value"));
  const stagedPath = fileFor(staged.descriptor);

  expectSyncPayloadFailure(
    () => stageSessionHostPayload(join(payloadDir(), "missing"), "{}"),
    "unavailable",
  );
  expectSyncPayloadFailure(() => stageSessionHostPayload("relative/dir", "{}"), "unsafe-directory");

  if (process.platform !== "win32") {
    chmodSync(payloadDir(), 0o755);
    expectSyncPayloadFailure(() => stageSessionHostPayload(payloadDir(), "{}"), "unsafe-directory");
    await expectPayloadFailure(readSessionHostPayload(payloadDir(), staged.descriptor), "unsafe-directory");
    chmodSync(payloadDir(), 0o700);
  }

  const target = join(payloadDir(), "target-value");
  const targetBytes = Buffer.from(JSON.stringify("symlink target"));
  writeFileSync(target, targetBytes, { mode: 0o600 });
  const linkName = `p-${"3".repeat(32)}.json`;
  const linkPath = join(payloadDir(), linkName);
  unlinkSync(stagedPath);
  try {
    symlinkSync(target, linkPath);
  } catch {
    return; // A platform without symlink support keeps the remaining checks.
  }
  await expectPayloadFailure(
    readSessionHostPayload(payloadDir(), replacementDescriptor(linkName, targetBytes)),
    process.platform === "win32" ? "replaced" : "unavailable",
  );
  assert.deepEqual(readFileSync(target), targetBytes, "the symlink target is never read or removed");
  unlinkSync(linkPath);

  // A non-regular entry at an otherwise valid payload name is rejected.
  const directoryName = `p-${"4".repeat(32)}.json`;
  mkdirSync(join(payloadDir(), directoryName), { mode: 0o700 });
  await assert.rejects(
    readSessionHostPayload(payloadDir(), { name: directoryName, size: 1, sha256: "5".repeat(64) }),
    (error: unknown) => {
      assert.ok(error instanceof SessionHostPayloadError);
      // POSIX opens the directory and rejects its type; a platform that
      // refuses directory opens rejects it as unavailable. Either way it is
      // never admitted as a regular payload file.
      assert.ok(error.reason === "not-regular-file" || error.reason === "unavailable");
      return true;
    },
  );
  assert.ok(lstatSync(join(payloadDir(), directoryName)).isDirectory(), "an unknown directory entry is preserved");

  // A zero-length regular file is a size mismatch, never a successful empty payload.
  const emptyName = `p-${"6".repeat(32)}.json`;
  writeFileSync(join(payloadDir(), emptyName), "", { mode: 0o600 });
  await expectPayloadFailure(
    readSessionHostPayload(payloadDir(), { name: emptyName, size: 1, sha256: "7".repeat(64) }),
    "size-mismatch",
  );
});

test("rejects a supplied symlinked namespace without reading or writing its target", async () => {
  const target = join(payloadDir(), "private-target");
  mkdirSync(target, { mode: 0o700 });
  chmodSync(target, 0o700);
  const link = join(payloadDir(), "private-link");
  try {
    symlinkSync(target, link);
  } catch {
    return; // A platform without symlink support keeps the remaining checks.
  }

  expectSyncPayloadFailure(
    () => stageSessionHostPayload(link, JSON.stringify("must not be written through a link")),
    "unsafe-directory",
  );
  assert.deepEqual(readdirSync(target), [], "a symlinked namespace never receives a staged file");

  const staged = stageSessionHostPayload(target, JSON.stringify("owned value"));
  await expectPayloadFailure(readSessionHostPayload(link, staged.descriptor), "unsafe-directory");
  assert.ok(lstatSync(join(target, staged.descriptor.name)).isFile(), "the target payload is preserved");
  expectSyncPayloadFailure(
    () => readSessionHostPayloadSync(link, staged.descriptor),
    "unsafe-directory",
  );
});

test("rejects a namespace replaced after the pre-canonical observation", async () => {
  const namespace = join(payloadDir(), "observed-namespace");
  mkdirSync(namespace, { mode: 0o700 });
  chmodSync(namespace, 0o700);
  const staged = stageSessionHostPayload(namespace, JSON.stringify("preserve across replacement"));
  const moved = join(payloadDir(), "moved-original");
  let replaced = false;
  payloadTest.setDirectoryObservationHookForTests((phase) => {
    if (replaced || phase !== "canonical") return;
    replaced = true;
    renameSync(namespace, moved);
    mkdirSync(namespace, { mode: 0o700 });
    chmodSync(namespace, 0o700);
  });
  try {
    await expectPayloadFailure(readSessionHostPayload(namespace, staged.descriptor), "replaced");
  } finally {
    payloadTest.setDirectoryObservationHookForTests(undefined);
  }
  assert.equal(replaced, true);
  assert.ok(lstatSync(join(moved, staged.descriptor.name)).isFile(),
    "the old namespace's payload is preserved, never guessed at or deleted");
});

test("rejects a namespace replaced after payload verification and preserves its payload", async () => {
  if (process.platform === "win32") return; // Renaming a directory with an open file is not portable.
  const namespace = join(payloadDir(), "verified-namespace");
  mkdirSync(namespace, { mode: 0o700 });
  chmodSync(namespace, 0o700);
  const staged = stageSessionHostPayload(namespace, JSON.stringify("verify then replace"));
  const moved = join(payloadDir(), "moved-after-verify");
  let replaced = false;
  payloadTest.setDirectoryObservationHookForTests((phase) => {
    if (replaced || phase !== "before-commit") return;
    replaced = true;
    renameSync(namespace, moved);
    mkdirSync(namespace, { mode: 0o700 });
    chmodSync(namespace, 0o700);
  });
  try {
    await expectPayloadFailure(readSessionHostPayload(namespace, staged.descriptor), "replaced");
  } finally {
    payloadTest.setDirectoryObservationHookForTests(undefined);
  }
  assert.equal(replaced, true);
  assert.ok(lstatSync(join(moved, staged.descriptor.name)).isFile(),
    "the verified payload remains in the old namespace rather than being deleted by path");
});

test("expected directory identity rejects a namespace replaced before any read", async () => {
  const namespace = join(payloadDir(), "identity-namespace");
  mkdirSync(namespace, { mode: 0o700 });
  chmodSync(namespace, 0o700);
  const stats = lstatSync(namespace);
  const expected = { dev: stats.dev, ino: stats.ino };
  const staged = stageSessionHostPayload(namespace, JSON.stringify("identity-bound value"));
  const moved = join(payloadDir(), "identity-moved");
  renameSync(namespace, moved);
  mkdirSync(namespace, { mode: 0o700 });
  chmodSync(namespace, 0o700);
  const replacementPath = join(namespace, staged.descriptor.name);
  writeFileSync(replacementPath, readFileSync(join(moved, staged.descriptor.name)), { mode: 0o600 });

  await expectPayloadFailure(
    readSessionHostPayload(namespace, staged.descriptor, expected),
    "replaced",
  );
  assert.ok(lstatSync(replacementPath).isFile(), "the replacement entry is preserved");
  assert.ok(lstatSync(join(moved, staged.descriptor.name)).isFile(), "the original payload is preserved");
});

test("descriptor parsing rejects unsafe or unbounded references before any filesystem access", async () => {
  for (const invalid of [
    undefined,
    { name: "../p-00000000000000000000000000000000.json", size: 1, sha256: "a".repeat(64) },
    { name: "/tmp/p-00000000000000000000000000000000.json", size: 1, sha256: "a".repeat(64) },
    { name: `p-${"0".repeat(32)}.json`, size: -1, sha256: "a".repeat(64) },
    { name: `p-${"0".repeat(32)}.json`, size: 1, sha256: "not-a-digest" },
  ]) {
    assert.equal(parseSessionHostPayloadRef(invalid), undefined);
  }
  await expectPayloadFailure(
    readSessionHostPayload(payloadDir(), { name: "bad", size: 1, sha256: "a".repeat(64) }),
    "invalid-descriptor",
  );
  expectSyncPayloadFailure(() => stageSessionHostPayload(payloadDir(), ""), "invalid-descriptor");
});
