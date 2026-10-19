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
  statSync,
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
  encodeSessionHostPayloadDirectoryIdentity,
  parseSessionHostPayloadDirectoryIdentity,
  readSessionHostPayload,
  readSessionHostPayloadSync,
  stageSessionHostPayload,
  type StagedSessionHostPayload,
} from "../src/session-host/payload";
import { parseSessionHostPayloadRef, type SessionHostPayloadRef } from "../src/session-host/protocol";

let root: string | undefined;
/** Every handle this test staged, so teardown releases pins before removing the tree. */
let stagedHandles: StagedSessionHostPayload[] = [];

beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "prg-payload-test-"));
  chmodSync(root, 0o700);
  stagedHandles = [];
});

afterEach(() => {
  for (const handle of stagedHandles.splice(0)) {
    try {
      handle.discard(); // Releases the continuity pin even when the entry is preserved.
    } catch {
      // A preserved/replaced entry is expected; teardown never asserts here.
    }
  }
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function payloadDir(): string {
  assert.ok(root);
  return root;
}

/** Stages through the production helper and tracks the handle for teardown. */
function stage(jsonText: string, directory: string = payloadDir()): StagedSessionHostPayload {
  const staged = stageSessionHostPayload(directory, jsonText);
  stagedHandles.push(staged);
  return staged;
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

  const first = stage(JSON.stringify(prompt));
  const firstPath = fileFor(first.descriptor);
  if (process.platform !== "win32") {
    assert.equal(lstatSync(payloadDir()).mode & 0o777, 0o700, "the namespace is private");
    assert.equal(lstatSync(firstPath).mode & 0o777, 0o600, "the staged file is owner-only");
  }
  const firstText = await readSessionHostPayload(payloadDir(), first.descriptor);
  assert.equal(decodeSessionHostPayloadJsonString(firstText), prompt, "the exact prompt round-trips with no truncation");
  assert.equal(lstatSync(firstPath, { throwIfNoEntry: false }), undefined, "a verified successful read consumes its exact file");

  const second = stage(JSON.stringify(prompt));
  const secondText = readSessionHostPayloadSync(payloadDir(), second.descriptor);
  assert.equal(decodeSessionHostPayloadJsonString(secondText), prompt, "the synchronous startup reader preserves the same exact text");
  assert.equal(lstatSync(fileFor(second.descriptor), { throwIfNoEntry: false }), undefined);
});

test("JSON staging preserves lone surrogates, newlines, quotes, and flag-like strings exactly", async () => {
  const exact = ` lone:\uD800:mid:\uDFFF:\n--session "quoted"\n--flag=value\n`;
  const staged = stage(JSON.stringify(exact));
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

  const truncated = stage(JSON.stringify("exact prompt"));
  writeFileSync(fileFor(truncated.descriptor), "exact", "utf8");
  await expectPayloadFailure(readSessionHostPayload(payloadDir(), truncated.descriptor), "size-mismatch");
  assert.ok(lstatSync(fileFor(truncated.descriptor)).isFile(), "a rejected size mismatch is preserved");

  const suffixed = stage(JSON.stringify("exact prompt"));
  appendFileSync(fileFor(suffixed.descriptor), "suffix");
  await expectPayloadFailure(readSessionHostPayload(payloadDir(), suffixed.descriptor), "size-mismatch");
  expectSyncPayloadFailure(
    () => readSessionHostPayloadSync(payloadDir(), suffixed.descriptor),
    "size-mismatch",
  );

  const tampered = stage(JSON.stringify("original prompt"));
  const tamperedPath = fileFor(tampered.descriptor);
  const originalBytes = readFileSync(tamperedPath);
  const replacementBytes = Buffer.from(originalBytes);
  replacementBytes[replacementBytes.length - 3] = replacementBytes[replacementBytes.length - 3]! ^ 0x01;
  writeFileSync(tamperedPath, replacementBytes);
  await expectPayloadFailure(readSessionHostPayload(payloadDir(), tampered.descriptor), "digest-mismatch");
  assert.deepEqual(readFileSync(tamperedPath), replacementBytes, "tampered content is preserved for its owner");

  const replaced = stage(JSON.stringify("owned original"));
  const replacedBytes = readFileSync(fileFor(replaced.descriptor));
  const foreign = Buffer.from("F".repeat(replacedBytes.length));
  unlinkSync(fileFor(replaced.descriptor));
  writeFileSync(fileFor(replaced.descriptor), foreign);
  await expectPayloadFailure(readSessionHostPayload(payloadDir(), replaced.descriptor), "digest-mismatch");
  replaced.discard();
  assert.deepEqual(readFileSync(fileFor(replaced.descriptor)), foreign, "a replaced/unknown entry is never deleted");

  const discarded = stage(JSON.stringify("discard me"));
  assert.ok(lstatSync(fileFor(discarded.descriptor)).isFile());
  discarded.discard();
  assert.equal(lstatSync(fileFor(discarded.descriptor), { throwIfNoEntry: false }), undefined);
  discarded.discard(); // Idempotent, and never touches a later replacement.
});

test("pins the owned inode so a recreated entry can never alias it", {
  skip: process.platform === "win32"
    ? "Windows keeps a removed name replaceable while a producer handle exists; ownership there is proven by unchanged content"
    : false,
}, () => {
  const pinned = stage(JSON.stringify("pinned original"));
  const pinnedPath = fileFor(pinned.descriptor);
  const original = statSync(pinnedPath, { bigint: true });
  const pinnedBytes = readFileSync(pinnedPath);

  // The Linux failure this pins: remove the staged name, then create the entry
  // a filesystem with immediate inode reuse would hand the just-freed number.
  unlinkSync(pinnedPath);
  const foreign = Buffer.from("F".repeat(pinnedBytes.length));
  writeFileSync(pinnedPath, foreign);
  const foreignStats = statSync(pinnedPath, { bigint: true });
  assert.equal(foreignStats.dev, original.dev);
  assert.notEqual(foreignStats.ino, original.ino,
    "the retained ownership descriptor keeps the owned inode allocated for its staging lifetime");
  pinned.discard();
  assert.deepEqual(readFileSync(pinnedPath), foreign,
    "a different-object replacement survives ownership release");

  // Identical bytes are still a different object: only the pinned identity can
  // prove ownership, so metadata/content alone must never authorize deletion.
  const identical = stage(JSON.stringify("identical replacement"));
  const identicalPath = fileFor(identical.descriptor);
  const identicalBytes = readFileSync(identicalPath);
  const identicalOriginal = statSync(identicalPath, { bigint: true });
  unlinkSync(identicalPath);
  writeFileSync(identicalPath, identicalBytes);
  const identicalReplacement = statSync(identicalPath, { bigint: true });
  assert.notEqual(identicalReplacement.ino, identicalOriginal.ino,
    "a recreated entry is a different inode even when its bytes are identical");
  identical.discard();
  assert.deepEqual(readFileSync(identicalPath), identicalBytes,
    "an identical-content replacement is preserved rather than deleted by metadata alone");
});

test("preserves in-place-modified owned content instead of deleting it", () => {
  const modified = stage(JSON.stringify("mutate me in place"));
  const modifiedPath = fileFor(modified.descriptor);
  const before = statSync(modifiedPath, { bigint: true });
  const mutated = Buffer.from(readFileSync(modifiedPath));
  mutated[mutated.length - 3] = mutated[mutated.length - 3]! ^ 0x01;
  writeFileSync(modifiedPath, mutated);
  const after = statSync(modifiedPath, { bigint: true });
  assert.equal(after.ino, before.ino, "the mutation rewrote the same object in place");
  modified.discard();
  assert.deepEqual(readFileSync(modifiedPath), mutated,
    "ownership release never deletes content that no longer matches its declared size and digest");
});

test("releases staged ownership exactly once, including after a consumer consumed the file", async () => {
  const consumed = stage(JSON.stringify("consumed before release"));
  const consumedPath = fileFor(consumed.descriptor);
  const text = await readSessionHostPayload(payloadDir(), consumed.descriptor);
  assert.equal(decodeSessionHostPayloadJsonString(text), "consumed before release");
  assert.equal(lstatSync(consumedPath, { throwIfNoEntry: false }), undefined,
    "the consumer removed the verified file before the producer released ownership");
  consumed.discard();
  consumed.discard();

  const retired = stage(JSON.stringify("retired ownership"));
  const retiredPath = fileFor(retired.descriptor);
  retired.discard();
  assert.equal(lstatSync(retiredPath, { throwIfNoEntry: false }), undefined);
  writeFileSync(retiredPath, "later owner");
  retired.discard();
  assert.equal(readFileSync(retiredPath, "utf8"), "later owner",
    "a repeated discard after release never deletes a later entry at the same path");
});

test("closes every pinned ownership descriptor exactly once", {
  skip: process.platform === "linux"
    ? false
    : "/proc/self/fd enumeration is Linux-only; no equivalent public descriptor list exists on this platform",
}, () => {
  const openDescriptors = (): number => readdirSync("/proc/self/fd").length;
  const baseline = openDescriptors();
  const staged = Array.from({ length: 16 }, (_, index) =>
    stage(JSON.stringify(`pinned ${index}`)));
  assert.equal(openDescriptors(), baseline + staged.length,
    "each staged handle pins exactly one owned descriptor");
  for (const handle of staged.slice(0, -1)) handle.discard();
  assert.equal(openDescriptors(), baseline + 1, "each release closes only its own pinned descriptor");
  const last = staged[staged.length - 1]!;
  unlinkSync(fileFor(last.descriptor));
  last.discard();
  assert.equal(openDescriptors(), baseline,
    "an already-consumed entry still releases its pinned descriptor exactly once");
});

test("linked continuity pin preserves an identical-content replacement with a recycled path", () => {
  // Exercises the Windows continuity mechanism (a private hard link instead of
  // a retained descriptor) through a bounded seam. This is not native Windows
  // evidence, but it is deterministic on any POSIX filesystem.
  payloadTest.setOwnershipPinForTests(false);
  try {
    const owned = stage(JSON.stringify("linked owned"));
    assert.ok(lstatSync(fileFor(owned.descriptor)).isFile());
    const ownedStats = statSync(fileFor(owned.descriptor), { bigint: true });
    const entries = readdirSync(payloadDir()).sort();
    assert.equal(entries.length, 2, "the continuity pin is the only extra namespace entry");
    const pinName = entries.find((entry) => entry !== owned.descriptor.name);
    assert.match(String(pinName), /^pin-[0-9a-f]{32}\.pin$/,
      "the continuity pin is never a parseable payload reference");
    assert.equal(parseSessionHostPayloadRef({ name: pinName, size: 1, sha256: "a".repeat(64) }), undefined);
    const pinStats = statSync(join(payloadDir(), String(pinName)), { bigint: true });
    assert.equal(pinStats.ino, ownedStats.ino, "the pin link references the staged inode");
    owned.discard();
    assert.equal(lstatSync(fileFor(owned.descriptor), { throwIfNoEntry: false }), undefined,
      "unchanged owned content is discarded");
    assert.deepEqual(readdirSync(payloadDir()), [], "releasing the handle removes the pin entry too");

    // The finding this pins: a recycled identity plus identical content must not
    // authorize deletion. The link keeps the inode allocated, so the recreated
    // entry necessarily gets a different identity.
    const identical = stage(JSON.stringify("linked identical"));
    const identicalPath = fileFor(identical.descriptor);
    const identicalStats = statSync(identicalPath, { bigint: true });
    const identicalBytes = readFileSync(identicalPath);
    unlinkSync(identicalPath);
    writeFileSync(identicalPath, identicalBytes);
    const recreated = statSync(identicalPath, { bigint: true });
    assert.equal(recreated.dev, identicalStats.dev);
    assert.notEqual(recreated.ino, identicalStats.ino,
      "the continuity pin keeps the owned inode allocated, so a recreated entry cannot alias it");
    identical.discard();
    assert.deepEqual(readFileSync(identicalPath), identicalBytes,
      "an identical-content replacement is a different object and is preserved");
    assert.ok(lstatSync(identicalPath).isFile(), "the preserved replacement still exists");

    const modified = stage(JSON.stringify("linked modified"));
    const modifiedPath = fileFor(modified.descriptor);
    const mutated = Buffer.from(readFileSync(modifiedPath));
    mutated[mutated.length - 3] = mutated[mutated.length - 3]! ^ 0x01;
    writeFileSync(modifiedPath, mutated);
    modified.discard();
    assert.deepEqual(readFileSync(modifiedPath), mutated,
      "the linked pin still re-verifies the declared size and digest before any unlink");

    const replaced = stage(JSON.stringify("linked replaced"));
    const replacedPath = fileFor(replaced.descriptor);
    unlinkSync(replacedPath);
    writeFileSync(replacedPath, "foreign replacement");
    replaced.discard();
    assert.equal(readFileSync(replacedPath, "utf8"), "foreign replacement",
      "a replaced entry is preserved under the linked pin");
    assert.deepEqual(readdirSync(payloadDir()).filter((entry) => entry.endsWith(".pin")), [],
      "released or foreign paths never leave an owned pin entry behind");
  } finally {
    payloadTest.setOwnershipPinForTests(undefined);
  }
});

test("rejects unsafe namespaces and non-regular replacements before reading", async () => {
  const staged = stage(JSON.stringify("confined value"));
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

  const staged = stage(JSON.stringify("owned value"), target);
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
  const staged = stage(JSON.stringify("preserve across replacement"), namespace);
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
  const staged = stage(JSON.stringify("verify then replace"), namespace);
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
  const stats = lstatSync(namespace, { bigint: true });
  const expected = encodeSessionHostPayloadDirectoryIdentity(stats);
  const staged = stage(JSON.stringify("identity-bound value"), namespace);
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

test("directory identities preserve large NTFS identifiers exactly through JSON", () => {
  const first = encodeSessionHostPayloadDirectoryIdentity({ dev: 18446744073709551615n, ino: 9007199254740992n });
  const second = encodeSessionHostPayloadDirectoryIdentity({ dev: 18446744073709551615n, ino: 9007199254740993n });
  assert.notDeepEqual(first, second, "adjacent native identifiers must never collapse through Number rounding");
  assert.deepEqual(parseSessionHostPayloadDirectoryIdentity(JSON.parse(JSON.stringify(second))), {
    dev: "18446744073709551615", ino: "9007199254740993",
  });
  for (const value of [1, -1, "-1", "+1", "01", "1.0", "1e3", "1\n", "", null]) {
    assert.equal(parseSessionHostPayloadDirectoryIdentity({ ...second, ino: value }), undefined);
  }
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
