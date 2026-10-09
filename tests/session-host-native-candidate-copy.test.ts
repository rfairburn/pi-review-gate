/**
 * Synthetic, inert proof of the native candidate copier's bounded staging
 * semantics (see `stageCandidateTreeForTest` and `readCandidateManifestForTest`
 * in tests/helpers/session-host-native-main-harness.ts).
 *
 * Scope: this file drives the SAME copier the native candidate uses against
 * caller-owned real directories. It never runs tsc, never spawns the native
 * runtime, and makes no claim about the native runtime, a real candidate, or
 * an atomic filesystem guarantee. It is evidence about the copier's file
 * identity, exclusive creation, source/destination ancestor validation, bounds,
 * pruning, and fail-closed behavior only.
 *
 * Fixtures are inert and small (well under 64 files / 64 KiB) and are RETAINED
 * on success and failure: every root is logged and never recursively removed.
 * No role or environment marker is deleted, stripped, or mutated — an inherited
 * delegated role/catalog marker (any case alias) makes the test refuse BEFORE
 * the first filesystem write, honoring the parent permission ceiling.
 */
import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readCandidateManifestForTest,
  stageCandidateTreeForTest,
  type CandidateCopyFileIo,
} from "./helpers/session-host-native-main-harness";

const ROLE_MARKER_NAMES = new Set([
  "PI_REVIEW_GATE_RUNTIME_ROLE",
  "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG",
]);

/**
 * Refuse BEFORE any filesystem write when the caller inherited a delegated
 * runtime role/catalog marker under any case alias. The markers are preserved,
 * never stripped or mutated: the ceiling is honored by refusal, not removal.
 */
function assertNoInheritedRoleMarkers(): void {
  const inherited = Object.keys(process.env).filter((name) =>
    ROLE_MARKER_NAMES.has(name.toUpperCase()));
  if (inherited.length > 0) {
    throw new Error("synthetic candidate-copy fixtures are unavailable in an inherited delegated runtime role");
  }
}

/**
 * Create one exclusive, inert, retained fixture root under the canonical public
 * temporary parent. Nothing created here is ever removed; the root is logged so
 * a success or failure witness can be inspected.
 */
function retainedFixtureRoot(label: string): string {
  assertNoInheritedRoleMarkers();
  const parent = realpathSync(tmpdir());
  const parentStats = lstatSync(parent, { bigint: true });
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new Error("the candidate-copy fixture parent is not a real directory");
  }
  const root = mkdtempSync(join(parent, `prg-candidate-copy-${label}-`));
  chmodSync(root, 0o700);
  console.info(`candidate-copy fixture retained: ${root}`);
  return root;
}

test("candidate copy preserves regular bytes, Unicode names, and permissions", () => {
  const root = retainedFixtureRoot("bytes");
  const source = join(root, "source");
  const destination = join(root, "destination");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });

  // Every byte value plus a filename with non-ASCII code points.
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  const unicodeName = "h\u00e9llo-\u03c0-\u2603.txt";
  writeFileSync(join(source, unicodeName), bytes);
  chmodSync(join(source, unicodeName), 0o751);
  mkdirSync(join(source, "nested"), { mode: 0o700 });
  writeFileSync(join(source, "nested", "small.txt"), "nested-bytes", "utf8");

  stageCandidateTreeForTest(source, destination);

  assert.deepEqual(readFileSync(join(destination, unicodeName)), bytes,
    "the copied leaf carries the exact source bytes");
  assert.equal(statSync(join(destination, unicodeName)).mode & 0o777, 0o751,
    "the copied leaf carries the source permissions, applied through its descriptor");
  assert.equal(readFileSync(join(destination, "nested", "small.txt"), "utf8"), "nested-bytes",
    "a nested regular leaf is copied through an owned destination directory");
});

test("candidate copy refuses linked and special source entries and a linked source root", () => {
  const root = retainedFixtureRoot("source-refusal");
  const outside = join(root, "outside");
  mkdirSync(outside, { mode: 0o700 });
  writeFileSync(join(outside, "secret.txt"), "outside-secret", "utf8");

  const source = join(root, "source");
  const destination = join(root, "destination");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  symlinkSync(join(outside, "secret.txt"), join(source, "linked.txt"));
  symlinkSync(outside, join(source, "linked-dir"));

  assert.throws(() => stageCandidateTreeForTest(source, destination),
    /linked source entry/,
    "a linked source leaf or ancestor fails closed instead of following the link");

  const linkedRoot = join(root, "linked-root");
  symlinkSync(source, linkedRoot);
  assert.throws(() => stageCandidateTreeForTest(linkedRoot, destination),
    /real, non-linked source directory/,
    "a linked source root is refused without realpath-following it");

  assert.equal(lstatSync(join(source, "linked.txt")).isSymbolicLink(), true,
    "the refused source link is retained unchanged, never removed");
  assert.equal(existsSync(join(destination, "linked.txt")), false,
    "no destination leaf was produced for the refused source link");
});

test("candidate copy refuses a symlinked intermediate source ancestor above a real final directory", () => {
  const root = retainedFixtureRoot("source-ancestor");
  const outside = join(root, "outside");
  mkdirSync(join(outside, "real-child"), { recursive: true, mode: 0o700 });
  writeFileSync(join(outside, "real-child", "payload.txt"), "payload", "utf8");
  const trusted = join(root, "trusted");
  mkdirSync(trusted, { mode: 0o700 });
  symlinkSync(outside, join(trusted, "linked-parent"));
  // The final selected component is a real directory; only its intermediate
  // parent is a link, so an lstat of the selection alone would be fooled.
  const selected = join(trusted, "linked-parent", "real-child");
  const destination = join(root, "destination");
  mkdirSync(destination, { mode: 0o700 });

  assert.throws(() => stageCandidateTreeForTest(selected, destination, { sourceTrustedBase: trusted }),
    /linked or non-directory source ancestor/,
    "a symlinked intermediate source ancestor is refused even when the final directory is real");
  assert.equal(existsSync(join(destination, "payload.txt")), false,
    "nothing was staged through the linked source ancestor");
  assert.equal(lstatSync(join(trusted, "linked-parent")).isSymbolicLink(), true,
    "the refused intermediate source link is retained, never removed");
});

test("candidate copy refuses a linked destination root or ancestor without following it", () => {
  const root = retainedFixtureRoot("destination-refusal");
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  writeFileSync(join(source, "payload.txt"), "payload", "utf8");
  mkdirSync(join(source, "sub"), { mode: 0o700 });
  writeFileSync(join(source, "sub", "child.txt"), "child", "utf8");

  const real = join(root, "real-destination");
  mkdirSync(real, { mode: 0o700 });
  const linkedRoot = join(root, "linked-destination");
  symlinkSync(real, linkedRoot);
  assert.throws(() => stageCandidateTreeForTest(source, linkedRoot),
    /linked or non-directory destination/,
    "a linked destination root is refused");

  const destination = join(root, "destination");
  mkdirSync(destination, { mode: 0o700 });
  const outside = join(root, "outside");
  mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, join(destination, "sub"));
  assert.throws(() => stageCandidateTreeForTest(source, destination),
    /linked or non-directory destination/,
    "a linked destination ancestor is refused before descending through it");
  assert.equal(existsSync(join(outside, "child.txt")), false,
    "the refused copy never wrote through the destination link");
});

test("candidate copy refuses a destination directory it did not establish and retains it", () => {
  const root = retainedFixtureRoot("destination-established");
  const source = join(root, "source");
  mkdirSync(join(source, "sub"), { recursive: true, mode: 0o700 });
  writeFileSync(join(source, "sub", "new.txt"), "new", "utf8");
  const destination = join(root, "destination");
  mkdirSync(join(destination, "sub"), { recursive: true, mode: 0o700 });
  writeFileSync(join(destination, "sub", "original.txt"), "original", "utf8");

  assert.throws(() => stageCandidateTreeForTest(source, destination),
    /pre-existing destination directory it did not establish/,
    "a pre-existing destination directory is never adopted as a verified ancestor");
  assert.equal(readFileSync(join(destination, "sub", "original.txt"), "utf8"), "original",
    "the pre-existing destination directory and its entries are retained");
  assert.equal(existsSync(join(destination, "sub", "new.txt")), false,
    "nothing was staged into the unestablished destination directory");
});

test("candidate copy detects a replaced destination ancestor mid-copy and retains partial output", () => {
  const root = retainedFixtureRoot("destination-swap");
  const source = join(root, "source");
  mkdirSync(join(source, "sub"), { recursive: true, mode: 0o700 });
  writeFileSync(join(source, "sub", "payload.txt"), "payload", "utf8");
  const destination = join(root, "destination");
  mkdirSync(destination, { mode: 0o700 });
  const retainedSub = join(root, "retained-sub");

  let swapped = false;
  const fileIo: Partial<CandidateCopyFileIo> = {
    write: (fd, buffer, offset, length, position) => {
      const delta = writeSync(fd, buffer, offset, length, position);
      if (!swapped) {
        swapped = true;
        // Replace the established destination ancestor mid-copy: move it aside
        // (retained) and put a different real directory at the same path.
        renameSync(join(destination, "sub"), retainedSub);
        mkdirSync(join(destination, "sub"), { mode: 0o700 });
      }
      return delta;
    },
  };

  assert.throws(() => stageCandidateTreeForTest(source, destination, { fileIo }),
    /replaced or linked destination ancestor/,
    "a replaced destination ancestor is detected and fails closed");
  assert.equal(swapped, true, "the injected seam actually performed the swap");
  assert.equal(readFileSync(join(retainedSub, "payload.txt"), "utf8"), "payload",
    "bytes written before the ancestor swap are retained at the original directory");
  assert.equal(existsSync(join(destination, "sub", "payload.txt")), false,
    "no output was published into the replacement directory");
});

test("candidate copy refuses to overwrite an existing destination leaf and preserves it", () => {
  const root = retainedFixtureRoot("collision");
  const source = join(root, "source");
  const destination = join(root, "destination");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  writeFileSync(join(source, "keep.txt"), "new-content", "utf8");
  writeFileSync(join(destination, "keep.txt"), "original-content", "utf8");
  chmodSync(join(destination, "keep.txt"), 0o600);

  assert.throws(() => stageCandidateTreeForTest(source, destination),
    /EEXIST|already exists/,
    "exclusive destination creation refuses a pre-existing leaf");

  assert.equal(readFileSync(join(destination, "keep.txt"), "utf8"), "original-content",
    "the pre-existing destination leaf is preserved, never overwritten");
  assert.equal(statSync(join(destination, "keep.txt")).mode & 0o777, 0o600,
    "the pre-existing destination leaf permissions are preserved");
});

test("candidate copy prunes every .terraform subtree before inspecting it", () => {
  const root = retainedFixtureRoot("terraform");
  const source = join(root, "source");
  const destination = join(root, "destination");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  writeFileSync(join(source, "kept.txt"), "kept", "utf8");

  const terraform = join(source, ".terraform");
  mkdirSync(terraform, { mode: 0o700 });
  // A linked entry inside .terraform would fail the copy if it were inspected
  // or descended into; pruning happens by name first.
  symlinkSync(join(root, "missing-target"), join(terraform, "linked-entry"));
  writeFileSync(join(terraform, "provider.bin"), "terraform-state", "utf8");
  mkdirSync(join(source, "nested", ".terraform"), { recursive: true, mode: 0o700 });
  writeFileSync(join(source, "nested", ".terraform", "inner.bin"), "inner", "utf8");

  stageCandidateTreeForTest(source, destination);

  assert.equal(readFileSync(join(destination, "kept.txt"), "utf8"), "kept");
  assert.equal(existsSync(join(destination, ".terraform")), false,
    "the top-level .terraform subtree is pruned before inspection");
  assert.equal(existsSync(join(destination, "nested", ".terraform")), false,
    "a nested .terraform subtree is pruned at its own depth");
  assert.equal(existsSync(join(destination, "nested")), true,
    "the ordinary sibling directory is still copied");
});

test("candidate copy enforces its leaf, file, byte, directory, and depth bounds", () => {
  const root = retainedFixtureRoot("bounds");
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  writeFileSync(join(source, "leaf.bin"), Buffer.alloc(64, 7));

  const leafDestination = join(root, "leaf-destination");
  mkdirSync(leafDestination, { mode: 0o700 });
  assert.throws(() => stageCandidateTreeForTest(source, leafDestination, { bounds: { maxLeafBytes: 16 } }),
    /oversized source file/,
    "a leaf above the per-file bound is refused without an oversized fixture");

  writeFileSync(join(source, "second.bin"), "second", "utf8");
  const fileDestination = join(root, "file-destination");
  mkdirSync(fileDestination, { mode: 0o700 });
  assert.throws(() => stageCandidateTreeForTest(source, fileDestination, { bounds: { maxFiles: 1 } }),
    /aggregate file bound/,
    "a tree above the file-count bound is refused");

  const byteDestination = join(root, "byte-destination");
  mkdirSync(byteDestination, { mode: 0o700 });
  assert.throws(() => stageCandidateTreeForTest(source, byteDestination, { bounds: { maxTotalBytes: 8 } }),
    /aggregate file bound/,
    "a tree above the aggregate byte bound is refused");

  // A deep tree: the over-depth destination directory must never be created.
  const depthSource = join(root, "depth-source");
  mkdirSync(join(depthSource, "one", "two"), { recursive: true, mode: 0o700 });
  writeFileSync(join(depthSource, "one", "two", "deep.txt"), "deep", "utf8");
  const depthDestination = join(root, "depth-destination");
  mkdirSync(depthDestination, { mode: 0o700 });
  assert.throws(() => stageCandidateTreeForTest(depthSource, depthDestination, { bounds: { maxDepth: 1 } }),
    /destination-depth bound/,
    "a tree deeper than the depth bound is refused");
  assert.equal(existsSync(join(depthDestination, "one")), true,
    "the in-budget destination directory is created");
  assert.equal(existsSync(join(depthDestination, "one", "two")), false,
    "the over-depth destination directory is never created");

  // A nested tree: the over-count destination directory must never be created.
  const countSource = join(root, "count-source");
  mkdirSync(join(countSource, "a", "b"), { recursive: true, mode: 0o700 });
  writeFileSync(join(countSource, "a", "one.txt"), "one", "utf8");
  writeFileSync(join(countSource, "a", "b", "two.txt"), "two", "utf8");
  const countDestination = join(root, "count-destination");
  mkdirSync(countDestination, { mode: 0o700 });
  assert.throws(() => stageCandidateTreeForTest(countSource, countDestination, { bounds: { maxDirectories: 1 } }),
    /directory bound/,
    "a tree above the directory-count bound is refused");
  assert.equal(existsSync(join(countDestination, "a")), true,
    "the in-budget destination directory is created");
  assert.equal(existsSync(join(countDestination, "a", "b")), false,
    "the over-count destination directory is never created");
});

test("candidate copy test bounds may only lower finite ceilings", () => {
  // These predicates are refused before any filesystem work, so no fixture is
  // created and the nonexistent paths are never touched.
  const overrides: Array<Record<string, number>> = [
    { maxLeafBytes: Infinity },
    { maxLeafBytes: NaN },
    { maxLeafBytes: 1.5 },
    { maxDepth: -1 },
    { maxFiles: 1_000_000 },
    { maxTotalBytes: 129 * 1024 * 1024 },
  ];
  for (const bounds of overrides) {
    assert.throws(() => stageCandidateTreeForTest("unused-source", "unused-destination", { bounds }),
      /may only lower/,
      "a raised, nonfinite, fractional, or negative ceiling override is refused");
  }
});

test("candidate copy detects a mid-copy source path swap and retains both source fixtures", () => {
  const root = retainedFixtureRoot("swap");
  const source = join(root, "source");
  const destination = join(root, "destination");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  const target = join(source, "payload.txt");
  writeFileSync(target, "original-payload", "utf8");
  const replacement = join(root, "replacement.txt");
  writeFileSync(replacement, "replacement-payload-with-different-length", "utf8");
  const retainedOriginal = join(root, "retained-original.txt");

  let swapped = false;
  const fileIo: Partial<CandidateCopyFileIo> = {
    read: (fd, buffer, offset, length, position) => {
      const count = readSync(fd, buffer, offset, length, position);
      if (!swapped) {
        swapped = true;
        // Retain the original inode under a new name, then move the replacement
        // into the selected source path (a scenario swap, never a cleanup).
        renameSync(target, retainedOriginal);
        renameSync(replacement, target);
      }
      return count;
    },
  };

  assert.throws(() => stageCandidateTreeForTest(source, destination, { fileIo }),
    /source mutation during the copy|source path swap/,
    "the source stability check rejects the swap");

  assert.equal(swapped, true, "the injected seam actually performed the swap");
  assert.equal(readFileSync(retainedOriginal, "utf8"), "original-payload",
    "the original source bytes remain available at a retained path");
  assert.equal(readFileSync(target, "utf8"), "replacement-payload-with-different-length",
    "the replacement source bytes remain available at the selected path");
  assert.equal(lstatSync(join(destination, "payload.txt")).isFile(), true,
    "the destination leaf written before the swap is retained, never unlinked");
});

test("candidate manifest read rejects a mutation during the read and retains the manifest", () => {
  const root = retainedFixtureRoot("manifest");
  const manifestPath = join(root, "package.json");
  writeFileSync(manifestPath, JSON.stringify({ files: ["docs"] }), "utf8");

  let mutated = false;
  const fileIo: Partial<CandidateCopyFileIo> = {
    read: (fd, buffer, offset, length, position) => {
      const count = readSync(fd, buffer, offset, length, position);
      if (!mutated) {
        mutated = true;
        appendFileSync(manifestPath, " ", "utf8");
      }
      return count;
    },
  };

  assert.throws(() => readCandidateManifestForTest(manifestPath, { fileIo }),
    /manifest mutation during the read|manifest path swap during the read/,
    "the manifest read revalidates descriptor and path stability after the read");
  assert.equal(mutated, true, "the injected seam actually mutated the manifest");
  assert.equal(existsSync(manifestPath), true, "the manifest fixture is retained");
  assert.ok(readFileSync(manifestPath, "utf8").startsWith('{"files":["docs"]}'),
    "the mutated manifest bytes remain available at the retained path");
});

test("candidate copy rejects a same-size mutation between inspection and open", () => {
  const root = retainedFixtureRoot("inspect-open");
  const source = join(root, "source");
  const destination = join(root, "destination");
  mkdirSync(source, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  const target = join(source, "payload.txt");
  writeFileSync(target, "original", { flag: "wx" });
  writeFileSync(join(root, "retained-original.txt"), "original", { flag: "wx" });
  const before = statSync(target);

  let mutated = false;
  const fileIo: Partial<CandidateCopyFileIo> = {
    openSource: (path) => {
      // Same inode, same size, different content and timestamps: the change is
      // only observable through the descriptor's retained mtime/ctime.
      writeFileSync(path, "modified", { flag: "r+" });
      utimesSync(path, before.atime, new Date(before.mtimeMs + 60_000));
      mutated = true;
      return openSync(path, constants.O_RDONLY
        | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    },
  };

  assert.throws(() => stageCandidateTreeForTest(source, destination, { fileIo }),
    /changed source file between inspect and open/,
    "a same-size mutation during the inspect/open gap is rejected");
  assert.equal(mutated, true, "the injected seam actually mutated the source");
  assert.equal(readFileSync(target, "utf8"), "modified",
    "the mutated source remains available at the selected path");
  assert.equal(readFileSync(join(root, "retained-original.txt"), "utf8"), "original",
    "the retained original copy is untouched");
  assert.equal(existsSync(join(destination, "payload.txt")), false,
    "no destination leaf is created once the descriptor is rejected");
});

test("candidate manifest read rejects a same-size mutation between inspection and open", () => {
  const root = retainedFixtureRoot("manifest-inspect-open");
  const manifestPath = join(root, "package.json");
  writeFileSync(manifestPath, '{"files":["docs"]}', { flag: "wx" });
  const before = statSync(manifestPath);

  let mutated = false;
  const fileIo: Partial<CandidateCopyFileIo> = {
    openSource: (path) => {
      // Same inode, same size, different content; only mtime/ctime reveal it.
      writeFileSync(path, '{"files":["code"]}', { flag: "r+" });
      utimesSync(path, before.atime, new Date(before.mtimeMs + 60_000));
      mutated = true;
      return openSync(path, constants.O_RDONLY
        | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    },
  };

  assert.throws(() => readCandidateManifestForTest(manifestPath, { fileIo }),
    /changed package manifest between inspect and open/,
    "a same-size manifest mutation during the inspect/open gap is rejected");
  assert.equal(mutated, true, "the injected seam actually mutated the manifest");
  assert.equal(existsSync(manifestPath), true, "the manifest fixture is retained");
  assert.equal(readFileSync(manifestPath, "utf8"), '{"files":["code"]}',
    "the mutated manifest bytes remain at the retained path");
});

test("candidate copy makes bounded progress on short writes and fails a stalled write", () => {
  const root = retainedFixtureRoot("writes");
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  const payload = Buffer.from("short-write-payload");
  writeFileSync(join(source, "payload.bin"), payload);

  const shortDestination = join(root, "short-destination");
  mkdirSync(shortDestination, { mode: 0o700 });
  const shortIo: Partial<CandidateCopyFileIo> = {
    write: (fd, buffer, offset, length, position) => writeSync(fd, buffer, offset, Math.min(length, 1), position),
  };
  stageCandidateTreeForTest(source, shortDestination, { fileIo: shortIo });
  assert.deepEqual(readFileSync(join(shortDestination, "payload.bin")), payload,
    "a one-byte-at-a-time descriptor still completes the exact bytes through bounded progress");

  const stallDestination = join(root, "stall-destination");
  mkdirSync(stallDestination, { mode: 0o700 });
  const stallIo: Partial<CandidateCopyFileIo> = {
    write: () => 0,
  };
  assert.throws(() => stageCandidateTreeForTest(source, stallDestination, { fileIo: stallIo }),
    /no bounded progress/,
    "a write that makes no bounded progress fails closed");
  assert.equal(lstatSync(join(stallDestination, "payload.bin")).isFile(), true,
    "the partial destination created before the stalled write is retained, never unlinked");
});
