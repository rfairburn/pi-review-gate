import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  BINARY_SAMPLE_BYTES,
  compareSnapshots,
  createPathSnapshot,
  createWorkspaceSnapshot,
  fsFaultCode,
  fsFaultReason,
  gitWarningPathRelativeToCwd,
  MAX_SNAPSHOT_OMISSIONS,
  parseGitDirectoryWarnings,
  recordSnapshotOmission,
  type FileSnapshot,
  type SnapshotOmission,
  type WorkspaceSnapshot,
} from "../src/capture";

const execFileAsync = promisify(execFile);

const snapshotOptions = {
  maxFileBytes: 1024 * 1024,
  maxSnapshotBytes: 10 * 1024 * 1024,
};

test("snapshot comparison detects added, modified, and deleted files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-capture-"));
  try {
    await writeFile(join(dir, "modified.txt"), "before\n", "utf8");
    await writeFile(join(dir, "deleted.txt"), "remove me\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);

    await writeFile(join(dir, "modified.txt"), "after\n", "utf8");
    await rm(join(dir, "deleted.txt"));
    await writeFile(join(dir, "added.txt"), "new\n", "utf8");

    const after = await createWorkspaceSnapshot(dir, snapshotOptions);
    const changes = compareSnapshots(before, after);

    assert.deepEqual(
      changes.map((change) => [change.path, change.status]),
      [
        ["added.txt", "added"],
        ["deleted.txt", "deleted"],
        ["modified.txt", "modified"],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot omits binary content but still detects changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-binary-"));
  try {
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "blob.bin"), Buffer.from([0, 1, 2, 3]));
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);

    await writeFile(join(dir, "nested", "blob.bin"), Buffer.from([0, 1, 2, 4]));
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);
    const [change] = compareSnapshots(before, after);

    assert.equal(change.path, "nested/blob.bin");
    assert.equal(change.binary, true);
    assert.equal(change.diffOmittedReason, "binary");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot recognizes text-safe binary magic, retains exact hashes, and ignores filename extensions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-binary-magic-"));
  try {
    const binaryFixtures = new Map<string, Buffer>([
      ["archive.data", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("ASCII ZIP payload")])],
      ["document.data", Buffer.from("%PDF-1.7\nASCII-only fixture\n", "ascii")],
      ["image.data", Buffer.from("GIF89aASCII-only fixture", "ascii")],
      ["audio.data", Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05, ...Buffer.from("audio", "ascii")])],
    ]);
    for (const [name, content] of binaryFixtures) await writeFile(join(dir, name), content);
    await writeFile(join(dir, "plain.zip"), "ordinary UTF-8 text despite its extension\n", "utf8");
    const magicLikeText = new Map([
      ["initials.txt", "MZ is a pair of initials, not an executable.\n"],
      ["bitmap-notes.txt", "BM can also begin an ordinary text sentence.\n"],
      ["metadata-notes.txt", "ID3 metadata is described here as text.\n"],
      ["compression-notes.txt", "BZh9 is only a header fragment here.\n"],
    ]);
    for (const [name, content] of magicLikeText) await writeFile(join(dir, name), content, "utf8");

    const snapshot = await createWorkspaceSnapshot(dir, snapshotOptions);
    for (const [name, content] of binaryFixtures) {
      const file = snapshot.files.get(name);
      assert.equal(file?.isBinary, true, `${name} should be classified from magic bytes`);
      assert.equal(file?.omittedReason, "binary");
      assert.equal(file?.content, undefined);
      assert.equal(file?.sha256, createHash("sha256").update(content).digest("hex"));
    }
    assert.equal(snapshot.files.get("plain.zip")?.isBinary, false);
    assert.equal(snapshot.files.get("plain.zip")?.content, "ordinary UTF-8 text despite its extension\n");
    for (const [name, content] of magicLikeText) {
      assert.equal(snapshot.files.get(name)?.isBinary, false, `${name} should not match a partial signature`);
      assert.equal(snapshot.files.get(name)?.content, content);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("oversized magic-identified binaries remain binary and hash-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-binary-oversized-"));
  try {
    const content = Buffer.concat([
      Buffer.from("%PDF-1.7\n", "ascii"),
      Buffer.alloc(128, 0x41),
    ]);
    await writeFile(join(dir, "large.pdf"), content);
    const snapshot = await createWorkspaceSnapshot(dir, {
      maxFileBytes: 32,
      maxSnapshotBytes: 1024,
    });
    const file = snapshot.files.get("large.pdf");
    assert.equal(file?.isBinary, true);
    assert.equal(file?.omittedReason, "binary");
    assert.equal(file?.content, undefined);
    assert.equal(file?.sha256, createHash("sha256").update(content).digest("hex"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("valid multibyte UTF-8 crossing the sample boundary stays text through real capture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-utf8-boundary-"));
  try {
    // Each fixture places one multibyte character so its byte sequence
    // straddles the binary-sample bound at every possible split point; the
    // rest is plain ASCII well past the bound.
    const cases: Array<{ char: string; splits: number[] }> = [
      { char: "\u00E9", splits: [1] },
      { char: "\u20AC", splits: [1, 2] },
      // U+0800 = E0 A0 80: the E0 second-byte floor (A0) is legal, so this
      // completable tail must be trimmed like any other valid lead.
      { char: "\u0800", splits: [1, 2] },
      { char: "\u{1D11E}", splits: [1, 2, 3] },
      // U+D000 = ED 80 80: the ED surrogate ceiling (9F) needs an accept-side
      // fixture; ED 80-9F covers U+D000-D7FF (Hangul syllables).
      { char: "\uD000", splits: [2] },
      { char: "\uD7FF", splits: [2] }, // ED 9F BF: pins the ED accept-side ceiling
      { char: "\u{10000}", splits: [2] }, // F0 90 80 80: pins the F0 accept-side floor
      // U+40000 = F1 80 80 80: F1-F3 accept second bytes 80-BF, so these
      // completable tails must be trimmed like any other valid lead.
      { char: "\u{40000}", splits: [2, 3] },
      // U+10FFFF = F4 8F BF BF: the F4 upper bound (8F) accept side.
      { char: "\u{10FFFF}", splits: [2] },
    ];
    const expected = new Map<string, string>();
    for (const { char, splits } of cases) {
      const width = Buffer.byteLength(char, "utf8");
      const codePoint = char.codePointAt(0)!.toString(16);
      for (const split of splits) {
        const name = `cross-${width}b-${codePoint}-split-${split}.txt`;
        expected.set(name, "a".repeat(BINARY_SAMPLE_BYTES - split) + char + "b".repeat(120));
      }
    }
    // A duplicate fixture name would silently drop a boundary case from both
    // the on-disk fixtures and the expectations below.
    assert.equal(
      expected.size,
      cases.reduce((count, entry) => count + entry.splits.length, 0),
      "fixture names must be unique across cases",
    );
    for (const [name, content] of expected) await writeFile(join(dir, name), content, "utf8");

    const snapshot = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.equal(snapshot.files.size, expected.size);
    for (const [name, content] of expected) {
      const file = snapshot.files.get(name);
      assert.equal(file?.isBinary, false, `${name} must stay text`);
      assert.equal(file?.omittedReason, undefined, `${name} must not be omitted`);
      assert.equal(file?.content, content, `${name} content must be intact past the bound`);
      assert.equal(file?.sha256, createHash("sha256").update(content, "utf8").digest("hex"));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ordinary text controls around the sample boundary stay text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-utf8-controls-"));
  try {
    const asciiLarge = "a".repeat(BINARY_SAMPLE_BYTES + 500);
    // Exactly the sample bound, ending on a complete multibyte character:
    // the buffer is complete (EOF), not cut, and must decode cleanly.
    const exactBound = "c".repeat(BINARY_SAMPLE_BYTES - 4) + "\u{1D11E}";
    assert.equal(Buffer.byteLength(exactBound, "utf8"), BINARY_SAMPLE_BYTES);
    const smallMultibyte = "h\u00E9llo w\u00F6rld \uD83C\uDF0D\n".repeat(200); // ~5KB with multibyte
    const fixtures = new Map<string, string>([
      ["ascii-large.txt", asciiLarge],
      ["exact-bound.txt", exactBound],
      ["small-multibyte.txt", smallMultibyte],
    ]);
    for (const [name, content] of fixtures) await writeFile(join(dir, name), content, "utf8");

    const snapshot = await createWorkspaceSnapshot(dir, snapshotOptions);
    for (const [name, content] of fixtures) {
      const file = snapshot.files.get(name);
      assert.equal(file?.isBinary, false, `${name} must stay text`);
      assert.equal(file?.omittedReason, undefined);
      assert.equal(file?.content, content);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid UTF-8 at or below the sample boundary stays binary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-utf8-invalid-"));
  try {
    // True truncated EOF below the bound: the file itself ends mid-sequence.
    const truncatedEof = Buffer.concat([Buffer.from("abc", "ascii"), Buffer.from([0xe2, 0x82])]);
    // Exactly the sample bound, ending mid-sequence: a complete buffer must
    // not be treated as a harmless sample cut.
    const exactBoundTruncated = Buffer.concat([
      Buffer.alloc(BINARY_SAMPLE_BYTES - 2, 0x61),
      Buffer.from([0xf0, 0x9f]),
    ]);
    assert.equal(exactBoundTruncated.length, BINARY_SAMPLE_BYTES);
    // Invalid byte well inside the sample of a file that continues past it.
    const invalidInside = Buffer.alloc(BINARY_SAMPLE_BYTES + 200, 0x61);
    invalidInside[100] = 0xff;
    // A malformed (overlong) lead exactly at the cut point of a continuing
    // file: not a completable partial character, so it must not be trimmed.
    const malformedAtCut = Buffer.alloc(BINARY_SAMPLE_BYTES + 200, 0x61);
    malformedAtCut[BINARY_SAMPLE_BYTES - 1] = 0xc0;
    // An orphan continuation byte just before the cut point of a continuing
    // file: invalid content that tail trimming must not swallow.
    const orphanBeforeCut = Buffer.alloc(BINARY_SAMPLE_BYTES + 200, 0x61);
    orphanBeforeCut[BINARY_SAMPLE_BYTES - 1] = 0x80;

    const fixtures = new Map<string, Buffer>([
      ["truncated-eof.bin", truncatedEof],
      ["exact-bound-truncated.bin", exactBoundTruncated],
      ["invalid-inside.bin", invalidInside],
      ["malformed-at-cut.bin", malformedAtCut],
      ["orphan-before-cut.bin", orphanBeforeCut],
    ]);
    // A lead whose visible second byte is outside its sub-range (E0 A0-BF,
    // ED 80-9F, F0 90-BF, F4 80-8F) can never be completed by later file
    // bytes, so it must not be trimmed as sampling noise.
    const subRangeSecondBytes: Array<[string, number, number]> = [
      ["e0", 0xe0, 0x80],
      ["ed", 0xed, 0xa0],
      ["f0", 0xf0, 0x8f],
      ["f4", 0xf4, 0x90],
    ];
    for (const [suffix, leadByte, secondByte] of subRangeSecondBytes) {
      const buf = Buffer.alloc(BINARY_SAMPLE_BYTES + 200, 0x61);
      buf[BINARY_SAMPLE_BYTES - 2] = leadByte;
      buf[BINARY_SAMPLE_BYTES - 1] = secondByte;
      fixtures.set(`subrange-${suffix}.bin`, buf);
    }
    for (const [name, content] of fixtures) await writeFile(join(dir, name), content);

    const snapshot = await createWorkspaceSnapshot(dir, snapshotOptions);
    for (const name of fixtures.keys()) {
      const file = snapshot.files.get(name);
      assert.equal(file?.isBinary, true, `${name} must stay binary`);
      assert.equal(file?.omittedReason, "binary");
      assert.equal(file?.content, undefined, `${name} content must not be retained`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("NUL and magic-byte detection still apply across the sample boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-binary-boundary-"));
  try {
    const nulLarge = Buffer.alloc(BINARY_SAMPLE_BYTES + 200, 0x61);
    nulLarge[5000] = 0;
    const gzipLarge = Buffer.concat([
      Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
      Buffer.alloc(BINARY_SAMPLE_BYTES + 200 - 4, 0x61),
    ]);
    await writeFile(join(dir, "nul-large.bin"), nulLarge);
    await writeFile(join(dir, "gzip-large.bin"), gzipLarge);

    const snapshot = await createWorkspaceSnapshot(dir, snapshotOptions);
    for (const name of ["nul-large.bin", "gzip-large.bin"]) {
      const file = snapshot.files.get(name);
      assert.equal(file?.isBinary, true, `${name} must stay binary`);
      assert.equal(file?.omittedReason, "binary");
      assert.equal(file?.content, undefined, `${name} content must not be retained`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot reuses unchanged file hashes and content from a prior snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-"));
  try {
    await writeFile(join(dir, "unchanged.txt"), "unchanged\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);
    const after = await createWorkspaceSnapshot(dir, {
      ...snapshotOptions,
      reuseUnchangedFrom: before,
    });

    assert.equal(after.files.get("unchanged.txt"), before.files.get("unchanged.txt"));
    assert.deepEqual(compareSnapshots(before, after), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuseUnchangedFrom never reuses an unreadable presence record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-unreadable-"));
  try {
    await writeFile(join(dir, "a.txt"), "hello\n", "utf8");
    const first = await createWorkspaceSnapshot(dir, snapshotOptions);
    const real = first.files.get("a.txt")!;
    // Simulate a transient read failure persisted into a prior snapshot: full
    // stat identity but no hash. A chained capture must re-inspect the file.
    const poisoned: WorkspaceSnapshot = {
      ...first,
      files: new Map([[
        "a.txt",
        { ...real, sha256: null, content: undefined, omittedReason: "unreadable" },
      ]]),
    };
    const second = await createWorkspaceSnapshot(dir, { ...snapshotOptions, reuseUnchangedFrom: poisoned });
    assert.equal(second.files.get("a.txt")?.content, "hello\n");
    assert.equal(second.files.get("a.txt")?.omittedReason, undefined);
    assert.equal(second.files.get("a.txt")?.sha256, real.sha256);
    assert.deepEqual(second.omissions, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot cache does not miss a same-size rewrite with restored mtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-identity-"));
  try {
    const path = join(dir, "value.txt");
    await writeFile(path, "before\n", "utf8");
    const beforeStat = await stat(path);
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);
    await writeFile(path, "after!\n", "utf8");
    await utimes(path, beforeStat.atime, beforeStat.mtime);
    const after = await createWorkspaceSnapshot(dir, {
      ...snapshotOptions,
      reuseUnchangedFrom: before,
    });
    assert.deepEqual(compareSnapshots(before, after).map((change) => change.path), ["value.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// reuseUnchangedFrom: fresh-snapshot equality oracle.
// The strongest guarantee is that a reuse capture makes exactly the same
// content/hash/omission decisions a fresh capture makes on the same state,
// across unchanged, edited, deleted, grown, and re-limited workspaces.
// ---------------------------------------------------------------------------

/** Decision-relevant fields of a record — what a review consumer observes. */
function decisionFields(file: FileSnapshot | undefined) {
  if (!file) return undefined;
  return {
    exists: file.exists,
    size: file.size,
    entryType: file.entryType,
    sha256: file.sha256,
    isBinary: file.isBinary,
    content: file.content,
    omittedReason: file.omittedReason,
    linkTarget: file.linkTarget,
    gitObjectId: file.gitObjectId,
  };
}

function omissionKey(omission: SnapshotOmission): string {
  return [omission.kind, omission.path, omission.reason, omission.errorCode ?? ""].join("|");
}

/** Assert the reuse capture is decision-equivalent to the fresh capture. */
function assertSnapshotsEquivalent(fresh: WorkspaceSnapshot, reused: WorkspaceSnapshot): void {
  const freshPaths = [...fresh.files.keys()].sort();
  assert.deepEqual([...reused.files.keys()].sort(), freshPaths, "reuse must cover exactly the fresh path set");
  for (const path of freshPaths) {
    assert.deepEqual(
      decisionFields(reused.files.get(path)),
      decisionFields(fresh.files.get(path)),
      `path ${path} must match the fresh capture`,
    );
  }
  assert.deepEqual(
    reused.omissions.map(omissionKey).sort(),
    fresh.omissions.map(omissionKey).sort(),
    "reuse must record exactly the fresh omissions",
  );
  assert.equal(reused.omissionsTruncated, fresh.omissionsTruncated);
}

for (const race of ["same-size rewrite", "chmod"] as const) {
  test(`reuse rejects a ${race} between opened-file stat checks`, async (t) => {
    if (race === "chmod" && process.platform === "win32") {
      t.skip("Unix mode bits are required for deterministic chmod mutation");
      return;
    }
    const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-final-stat-"));
    try {
      const path = join(dir, "value.txt");
      await writeFile(path, "before\n", "utf8");
      await chmod(path, 0o644);
      await writeFile(join(dir, "sibling.txt"), "sibling\n", "utf8");
      const originalStat = await stat(path);
      const prior = await createWorkspaceSnapshot(dir, snapshotOptions);
      let mutationCount = 0;

      const reused = await createWorkspaceSnapshot(dir, {
        ...snapshotOptions,
        reuseUnchangedFrom: prior,
        captureFaults: {
          afterReusableEntryOpenStat: async ({ relativePath }) => {
            if (relativePath !== "value.txt") return;
            mutationCount++;
            if (race === "same-size rewrite") {
              await writeFile(path, "after!\n", "utf8");
              await utimes(path, originalStat.atime, new Date(originalStat.mtimeMs + 1000));
            } else {
              await chmod(path, 0o600);
            }
          },
        },
      });

      assert.equal(mutationCount, 1, "mutation must occur after the first opened-file stat");
      const raced = reused.files.get("value.txt");
      assert.equal(raced?.exists, true, "the raced path remains represented as present");
      assert.equal(raced?.sha256, null, "the prior hash must not be trusted after the final stat changes");
      assert.equal(raced?.content, undefined, "the prior content must not be trusted after the final stat changes");
      assert.equal(raced?.omittedReason, "unreadable");
      assert.deepEqual(reused.omissions.map(omissionKey), ["file|value.txt|unreadable|"]);
      assert.equal(reused.files.get("sibling.txt")?.content, "sibling\n");
      assert.equal(reused.files.get("sibling.txt"), prior.files.get("sibling.txt"), "unraced siblings still reuse");

      if (race === "same-size rewrite") {
        assert.equal((await readFile(path, "utf8")), "after!\n");
        assert.equal(raced?.size, prior.files.get("value.txt")?.size, "the rewrite preserves file size");
      } else {
        assert.notEqual((await stat(path)).mode & 0o777, originalStat.mode & 0o777);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("reuse yields fresh-equivalent decisions for an unchanged workspace and actually reuses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-oracle-"));
  try {
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "f001.txt"), "one\n", "utf8");
    await writeFile(join(dir, "f002.txt"), "two\n", "utf8");
    await writeFile(join(dir, "nested", "f003.txt"), "three\n", "utf8");
    await writeFile(join(dir, "blob.bin"), Buffer.from([0x1f, 0x8b, 0x08, 0x00, 1, 2]));

    const prior = await createWorkspaceSnapshot(dir, snapshotOptions);
    const fresh = await createWorkspaceSnapshot(dir, snapshotOptions);
    const reused = await createWorkspaceSnapshot(dir, { ...snapshotOptions, reuseUnchangedFrom: prior });

    assertSnapshotsEquivalent(fresh, reused);
    // The fast path must actually have run: a retained unchanged record is
    // reused by reference and the comparison stays empty.
    assert.equal(reused.files.get("f001.txt"), prior.files.get("f001.txt"));
    assert.deepEqual(compareSnapshots(prior, reused), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuse re-evaluates the budget walk when an earlier file is deleted (f003 regression)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-freed-budget-"));
  try {
    // Tight global budget: with all five files present, f003 onward are
    // budget-omitted in the prior capture.
    const options = { maxFileBytes: 1024, maxSnapshotBytes: 13 };
    await writeFile(join(dir, "f001.txt"), "aaaa", "utf8");
    await writeFile(join(dir, "f002.txt"), "bbbb", "utf8");
    await writeFile(join(dir, "f003.txt"), "cccccc", "utf8");
    await writeFile(join(dir, "f004.txt"), "dddddd", "utf8");
    await writeFile(join(dir, "f005.txt"), "eeeeee", "utf8");
    const prior = await createWorkspaceSnapshot(dir, options);
    assert.equal(prior.files.get("f002.txt")?.content, "bbbb");
    assert.equal(prior.files.get("f003.txt")?.omittedReason, "snapshot_limit");
    assert.equal(prior.files.get("f003.txt")?.content, undefined);

    // Deleting an earlier file frees budget: fresh retains f003.
    await rm(join(dir, "f001.txt"));

    const fresh = await createWorkspaceSnapshot(dir, options);
    const reused = await createWorkspaceSnapshot(dir, { ...options, reuseUnchangedFrom: prior });

    assert.equal(fresh.files.get("f003.txt")?.content, "cccccc");
    assertSnapshotsEquivalent(fresh, reused);
    // The measured regression: the stale snapshot_limit must not persist.
    assert.equal(reused.files.get("f003.txt")?.omittedReason, undefined);
    assert.equal(reused.files.get("f003.txt")?.content, "cccccc");
    assert.equal(reused.files.get("f004.txt")?.omittedReason, "snapshot_limit");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuse re-evaluates the budget walk when an earlier file grows (demotion)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-consumed-budget-"));
  try {
    const options = { maxFileBytes: 1024, maxSnapshotBytes: 13 };
    await writeFile(join(dir, "f001.txt"), "aaaa", "utf8");
    await writeFile(join(dir, "f002.txt"), "bbbb", "utf8");
    await writeFile(join(dir, "f003.txt"), "cccccc", "utf8");
    const prior = await createWorkspaceSnapshot(dir, options);
    assert.equal(prior.files.get("f002.txt")?.content, "bbbb");
    assert.equal(prior.files.get("f003.txt")?.omittedReason, "snapshot_limit");

    // Grow f001 to 10 bytes: fresh retains f001 (cumulative 10) and must
    // demote both f002 (10+4=14 > 13) and f003.
    await writeFile(join(dir, "f001.txt"), "a".repeat(10), "utf8");

    const fresh = await createWorkspaceSnapshot(dir, options);
    const reused = await createWorkspaceSnapshot(dir, { ...options, reuseUnchangedFrom: prior });

    assertSnapshotsEquivalent(fresh, reused);
    assert.equal(reused.files.get("f002.txt")?.omittedReason, "snapshot_limit");
    assert.equal(reused.files.get("f002.txt")?.content, undefined, "over-retained content must be dropped");
    assert.equal(
      reused.files.get("f002.txt")?.sha256,
      createHash("sha256").update("bbbb", "utf8").digest("hex"),
      "the proven hash survives demotion",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuse detects in-place edits and shrinks instead of masking them with prior content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-edit-"));
  try {
    await writeFile(join(dir, "value.txt"), "before\n", "utf8");
    await writeFile(join(dir, "kept.txt"), "kept\n", "utf8");
    const prior = await createWorkspaceSnapshot(dir, snapshotOptions);

    // Same-size rewrite: only mtime/ctime break the identity tuple.
    await writeFile(join(dir, "value.txt"), "after!\n", "utf8");

    const fresh = await createWorkspaceSnapshot(dir, snapshotOptions);
    const reused = await createWorkspaceSnapshot(dir, { ...snapshotOptions, reuseUnchangedFrom: prior });

    assertSnapshotsEquivalent(fresh, reused);
    assert.equal(reused.files.get("value.txt")?.content, "after!\n");
    assert.deepEqual(
      compareSnapshots(prior, reused).map((change) => [change.path, change.status]),
      [["value.txt", "modified"]],
    );

    // Shrink: a size change breaks identity the same way; the oracle must
    // hold against the original prior as well.
    await writeFile(join(dir, "value.txt"), "af\n", "utf8");

    const freshShrunk = await createWorkspaceSnapshot(dir, snapshotOptions);
    const reusedShrunk = await createWorkspaceSnapshot(dir, { ...snapshotOptions, reuseUnchangedFrom: prior });

    assertSnapshotsEquivalent(freshShrunk, reusedShrunk);
    assert.equal(reusedShrunk.files.get("value.txt")?.content, "af\n");
    assert.deepEqual(
      compareSnapshots(prior, reusedShrunk).map((change) => [change.path, change.status]),
      [["value.txt", "modified"]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuse re-reads when a raised maxFileBytes makes an oversized file eligible", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-limit-up-"));
  try {
    await writeFile(join(dir, "doc.txt"), "x".repeat(100), "utf8");
    const tight = { maxFileBytes: 32, maxSnapshotBytes: 4096 };
    const prior = await createWorkspaceSnapshot(dir, tight);
    assert.equal(prior.files.get("doc.txt")?.omittedReason, "oversized");
    assert.equal(prior.files.get("doc.txt")?.content, undefined);

    const generous = { maxFileBytes: 1024, maxSnapshotBytes: 4096 };
    const fresh = await createWorkspaceSnapshot(dir, generous);
    const reused = await createWorkspaceSnapshot(dir, { ...generous, reuseUnchangedFrom: prior });

    assertSnapshotsEquivalent(fresh, reused);
    assert.equal(reused.files.get("doc.txt")?.content, "x".repeat(100));
    assert.equal(reused.files.get("doc.txt")?.omittedReason, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuse demotes retained content when maxFileBytes is lowered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-limit-down-"));
  try {
    await writeFile(join(dir, "doc.txt"), "x".repeat(100), "utf8");
    const generous = { maxFileBytes: 1024, maxSnapshotBytes: 4096 };
    const prior = await createWorkspaceSnapshot(dir, generous);
    assert.equal(prior.files.get("doc.txt")?.content, "x".repeat(100));

    const tight = { maxFileBytes: 32, maxSnapshotBytes: 4096 };
    const fresh = await createWorkspaceSnapshot(dir, tight);
    const reused = await createWorkspaceSnapshot(dir, { ...tight, reuseUnchangedFrom: prior });

    assertSnapshotsEquivalent(fresh, reused);
    assert.equal(reused.files.get("doc.txt")?.omittedReason, "oversized");
    assert.equal(reused.files.get("doc.txt")?.content, undefined, "content must be dropped when the limit no longer allows it");
    assert.ok(reused.files.get("doc.txt")?.sha256, "the proven hash survives demotion");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuse re-reads when a raised maxSnapshotBytes frees budget for an omitted file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-budget-up-"));
  try {
    await writeFile(join(dir, "a.txt"), "aaaaaaaaaa", "utf8");
    await writeFile(join(dir, "b.txt"), "bbbbbbbbbb", "utf8");
    const tight = { maxFileBytes: 1024, maxSnapshotBytes: 10 };
    const prior = await createWorkspaceSnapshot(dir, tight);
    assert.equal(prior.files.get("a.txt")?.content, "aaaaaaaaaa");
    assert.equal(prior.files.get("b.txt")?.omittedReason, "snapshot_limit");

    const generous = { maxFileBytes: 1024, maxSnapshotBytes: 64 };
    const fresh = await createWorkspaceSnapshot(dir, generous);
    const reused = await createWorkspaceSnapshot(dir, { ...generous, reuseUnchangedFrom: prior });

    assertSnapshotsEquivalent(fresh, reused);
    assert.equal(reused.files.get("b.txt")?.content, "bbbbbbbbbb");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuse demotes retained content when maxSnapshotBytes is lowered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-budget-down-"));
  try {
    await writeFile(join(dir, "a.txt"), "aaaaaaaaaa", "utf8");
    await writeFile(join(dir, "b.txt"), "bbbbbbbbbb", "utf8");
    const generous = { maxFileBytes: 1024, maxSnapshotBytes: 64 };
    const prior = await createWorkspaceSnapshot(dir, generous);
    assert.equal(prior.files.get("b.txt")?.content, "bbbbbbbbbb");

    const tight = { maxFileBytes: 1024, maxSnapshotBytes: 10 };
    const fresh = await createWorkspaceSnapshot(dir, tight);
    const reused = await createWorkspaceSnapshot(dir, { ...tight, reuseUnchangedFrom: prior });

    assertSnapshotsEquivalent(fresh, reused);
    assert.equal(reused.files.get("b.txt")?.omittedReason, "snapshot_limit");
    assert.equal(reused.files.get("b.txt")?.content, undefined, "over-retained content must be dropped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuse never reuses symlink records and detects retargeting", async (t) => {
  if (process.platform === "win32") t.skip("symlink creation varies on Windows");
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-symlink-"));
  try {
    await writeFile(join(dir, "a"), "target-a\n", "utf8");
    await writeFile(join(dir, "b"), "target-b\n", "utf8");
    await symlink("a", join(dir, "link"));
    const prior = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.equal(prior.files.get("link")?.linkTarget, "a");

    await rm(join(dir, "link"));
    await symlink("b", join(dir, "link"));

    const fresh = await createWorkspaceSnapshot(dir, snapshotOptions);
    const reused = await createWorkspaceSnapshot(dir, { ...snapshotOptions, reuseUnchangedFrom: prior });

    assertSnapshotsEquivalent(fresh, reused);
    assert.equal(reused.files.get("link")?.linkTarget, "b");
    assert.deepEqual(
      compareSnapshots(prior, reused).map((change) => [change.path, change.status]),
      [["link", "modified"]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuse cannot leak retained content through a newly symlinked parent directory", async (t) => {
  if (process.platform === "win32") t.skip("symlink creation varies on Windows");
  const base = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-escape-"));
  const dir = join(base, "ws");
  const outside = join(base, "outside");
  try {
    await mkdir(dir);
    await mkdir(outside);
    await mkdir(join(dir, "a"));
    await writeFile(join(dir, "a", "b.txt"), "retained content\n", "utf8");
    await initGit(dir);
    await gitAddCommit(dir, "seed");

    const prior = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.equal(prior.files.get("a/b.txt")?.content, "retained content\n");

    // Move the parent directory outside the workspace and re-point the old
    // name at it: rename touches none of b.txt's timestamps, so every lstat
    // identity field still matches the prior record — only canonical path
    // safety can tell the entry has escaped. (An unlink/recreate fixture
    // would not work: removing a hardlink updates ctime and the identity
    // gate alone would reject the candidate before the preflight runs.)
    await rename(join(dir, "a"), join(outside, "a"));
    await symlink("../outside/a", join(dir, "a"));

    // Prove the premise: identity is genuinely unchanged, so this candidate
    // reaches the no-read preflight instead of being rejected by the gate.
    const before = prior.files.get("a/b.txt")!;
    const afterStat = await stat(join(dir, "a", "b.txt"));
    assert.equal(afterStat.dev, before.dev);
    assert.equal(afterStat.ino, before.ino);
    assert.equal(afterStat.size, before.size);
    assert.equal(afterStat.mtimeMs, before.mtimeMs);
    assert.equal(afterStat.ctimeMs, before.ctimeMs);
    assert.equal(afterStat.mode, before.mode);

    const fresh = await createWorkspaceSnapshot(dir, snapshotOptions);
    const reused = await createWorkspaceSnapshot(dir, { ...snapshotOptions, reuseUnchangedFrom: prior });

    assertSnapshotsEquivalent(fresh, reused);
    const escaped = reused.files.get("a/b.txt");
    assert.equal(escaped?.content, undefined, "previously retained content must not escape the workspace");
    assert.equal(escaped?.omittedReason, "unreadable", "an escaped entry is unreadable, never deleted and never trusted");
    assert.ok(reused.omissions.some((entry) => entry.path === "a/b.txt" && entry.reason === "unreadable"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("reuse re-inspects an identity-broken unreadable file instead of silently reusing", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-unreadable-2-"));
  try {
    await writeFile(join(dir, "protected.txt"), "secret\n", "utf8");
    await writeFile(join(dir, "sibling.txt"), "open\n", "utf8");
    const prior = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.equal(prior.files.get("protected.txt")?.content, "secret\n");

    // chmod breaks mode and ctime identity, forcing re-inspection.
    await chmod(join(dir, "protected.txt"), 0o000);

    const fresh = await createWorkspaceSnapshot(dir, snapshotOptions);
    const reused = await createWorkspaceSnapshot(dir, { ...snapshotOptions, reuseUnchangedFrom: prior });

    assertSnapshotsEquivalent(fresh, reused);
    assert.equal(reused.files.get("protected.txt")?.omittedReason, "unreadable");
    assert.equal(reused.files.get("protected.txt")?.content, undefined, "prior content must not be served for an unreadable entry");
    assert.ok(reused.omissions.some((entry) => entry.path === "protected.txt" && entry.reason === "unreadable"));
    assert.equal(reused.files.get("sibling.txt")?.content, "open\n", "siblings stay captured");
  } finally {
    await chmod(join(dir, "protected.txt"), 0o644).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuse falls back to safe inspection when the entry races during verification", async (t) => {
  if (process.platform === "win32") t.skip("symlink creation varies on Windows");
  const base = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-race-"));
  const dir = join(base, "ws");
  const outside = join(base, "outside-secret.txt");
  try {
    await mkdir(dir);
    await writeFile(outside, "outside secret\n", "utf8");
    await writeFile(join(dir, "victim.txt"), "x", "utf8");
    await writeFile(join(dir, "sibling.txt"), "sibling\n", "utf8");
    const options = { maxFileBytes: 1024, maxSnapshotBytes: 1024 * 10 };
    const prior = await createWorkspaceSnapshot(dir, options);

    // The seam swaps the victim to an outside symlink after lstat but before
    // any open; the reuse path must catch it during its no-read verification
    // and fall back to the full race-checked inspection exactly like fresh.
    const runWithRace = (reuseFrom?: WorkspaceSnapshot) => createWorkspaceSnapshot(dir, {
      ...options,
      ...(reuseFrom ? { reuseUnchangedFrom: reuseFrom } : {}),
      captureFaults: {
        beforeInspectFile: async ({ relativePath, absolutePath }) => {
          if (relativePath !== "victim.txt") return;
          await rm(absolutePath);
          await symlink(outside, absolutePath);
        },
      },
    });

    const reused = await runWithRace(prior);
    // Restore the pre-race state so the fresh run observes identical conditions.
    await rm(join(dir, "victim.txt"));
    await writeFile(join(dir, "victim.txt"), "x", "utf8");
    const fresh = await runWithRace();

    assertSnapshotsEquivalent(fresh, reused);
    assert.equal(reused.files.get("victim.txt")?.omittedReason, "unreadable");
    assert.equal(reused.files.get("victim.txt")?.content, undefined);
    assert.ok(reused.omissions.some((entry) => entry.path === "victim.txt" && entry.reason === "unreadable"));
    assert.equal(reused.files.get("sibling.txt")?.content, "sibling\n");
    assert.doesNotMatch(JSON.stringify([...reused.files.values()]), /outside secret/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("reuse honors an aborted signal mid-walk and never returns a partial snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-abort-mid-"));
  try {
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
      await writeFile(join(dir, name), `${name}\n`, "utf8");
    }
    const prior = await createWorkspaceSnapshot(dir, snapshotOptions);
    const controller = new AbortController();
    let fired = 0;
    await assert.rejects(
      createWorkspaceSnapshot(dir, {
        ...snapshotOptions,
        signal: controller.signal,
        reuseUnchangedFrom: prior,
        captureFaults: {
          beforeInspectFile: async () => {
            fired += 1;
            if (fired === 2) controller.abort();
          },
        },
      }),
      /abort|cancel/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuse honors an already-aborted signal before discovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-abort-pre-"));
  try {
    await writeFile(join(dir, "a.txt"), "a\n", "utf8");
    const prior = await createWorkspaceSnapshot(dir, snapshotOptions);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      createWorkspaceSnapshot(dir, { ...snapshotOptions, signal: controller.signal, reuseUnchangedFrom: prior }),
      /abort|cancel/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reuse never reuses across a capture-root mismatch", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-root-"));
  const dirA = join(base, "a");
  const dirB = join(base, "b");
  try {
    await mkdir(dirA);
    await mkdir(dirB);
    await writeFile(join(dirA, "x.txt"), "from-a\n", "utf8");
    await writeFile(join(dirB, "x.txt"), "from-b\n", "utf8");
    const prior = await createWorkspaceSnapshot(dirA, snapshotOptions);

    const fresh = await createWorkspaceSnapshot(dirB, snapshotOptions);
    const reused = await createWorkspaceSnapshot(dirB, { ...snapshotOptions, reuseUnchangedFrom: prior });

    assertSnapshotsEquivalent(fresh, reused);
    assert.equal(reused.files.get("x.txt")?.content, "from-b\n");
    assert.ok(!JSON.stringify([...reused.files.values()]).includes("from-a"), "no record may leak across roots");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("reuse re-evaluates the budget walk under git discovery after a deletion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reuse-git-"));
  await initGit(dir);
  try {
    const options = { maxFileBytes: 1024, maxSnapshotBytes: 13 };
    for (const [name, content] of [["f001.txt", "aaaa"], ["f002.txt", "bbbb"], ["f003.txt", "cccccc"]]) {
      await writeFile(join(dir, name), content, "utf8");
    }
    await gitAddCommit(dir, "seed");
    const prior = await createWorkspaceSnapshot(dir, options);
    assert.equal(prior.files.get("f002.txt")?.content, "bbbb");
    assert.equal(prior.files.get("f003.txt")?.omittedReason, "snapshot_limit");

    // Delete an earlier tracked file: git discovery still lists it (index),
    // so both captures record the missing omission while the freed budget
    // must let f003 be retained.
    await rm(join(dir, "f001.txt"));

    const fresh = await createWorkspaceSnapshot(dir, options);
    const reused = await createWorkspaceSnapshot(dir, { ...options, reuseUnchangedFrom: prior });

    assertSnapshotsEquivalent(fresh, reused);
    assert.equal(reused.files.get("f003.txt")?.content, "cccccc");
    assert.ok(reused.omissions.some((entry) => entry.path === "f001.txt" && entry.reason === "missing"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot honors an already-aborted signal before discovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-abort-"));
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      createWorkspaceSnapshot(dir, { ...snapshotOptions, signal: controller.signal }),
      /abort|cancel/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot records a tracked symlink target without reading the external file", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions vary on Windows");
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-symlink-"));
  const outside = join(dir, "..", `outside-${Date.now()}.txt`);
  try {
    await writeFile(outside, "outside secret\n", "utf8");
    await symlink(outside, join(dir, "link"));
    const snapshot = await createWorkspaceSnapshot(dir, snapshotOptions);
    const link = snapshot.files.get("link");
    assert.equal(link?.entryType, "symlink");
    assert.equal(link?.linkTarget, outside);
    assert.equal(link?.content, undefined);
    assert.ok(!JSON.stringify(link).includes("outside secret"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("snapshot comparison detects symlink retargeting and executable-mode changes", async (t) => {
  if (process.platform === "win32") t.skip("Unix modes and symlinks are required");
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-entry-metadata-"));
  try {
    await writeFile(join(dir, "a"), "a", "utf8");
    await writeFile(join(dir, "b"), "b", "utf8");
    await writeFile(join(dir, "script.sh"), "#!/bin/sh\n", "utf8");
    await chmod(join(dir, "script.sh"), 0o644);
    await symlink("a", join(dir, "link"));
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);

    await rm(join(dir, "link"));
    await symlink("b", join(dir, "link"));
    await chmod(join(dir, "script.sh"), 0o755);
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);
    const changes = compareSnapshots(before, after);

    assert.deepEqual(changes.map((change) => change.path), ["link", "script.sh"]);
    assert.equal(changes[0]?.oldContent, "a");
    assert.equal(changes[0]?.newContent, "b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed gitlink inspection keeps a presence record instead of reporting deletion", async (t) => {
  if (process.platform === "win32") t.skip("requires a POSIX sh shim on PATH");
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-gitlink-fault-"));
  const shimDir = await mkdtemp(join(tmpdir(), "pi-review-gate-git-shim-"));
  try {
    const git = (args: string[], cwd = dir) => execFileAsync("git", args, { cwd, env: gitEnv() });
    await git(["init", "--quiet"]);
    await writeFile(join(dir, "keep.txt"), "keep\n", "utf8");
    await execFileAsync("git", ["add", "keep.txt"], { cwd: dir, env: gitEnv() });
    await execFileAsync("git", ["commit", "--quiet", "-m", "seed"], { cwd: dir, env: gitEnv() });
    const head = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: dir, env: gitEnv() })).stdout.trim();
    await mkdir(join(dir, "submodule"));
    await execFileAsync("git", ["update-index", "--add", "--cacheinfo", `160000,${head},submodule`],
      { cwd: dir, env: gitEnv() });

    const before = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.equal(before.files.get("submodule")?.entryType, "gitlink");

    // A PATH shim makes only `git ls-files --stage` fail (exit 128) with the
    // message historically treated as a benign non-repository signal; every
    // other command (including discovery) reaches the real git. This forces
    // the gitlink metadata inspection to fail while the directory is still
    // verifiably present.
    const realGit = (await execFileAsync("sh", ["-c", "command -v git"])).stdout.trim();
    const shim = join(shimDir, "git");
    await writeFile(shim,
      `#!/bin/sh\n`
      + `if [ "$1" = "ls-files" ] && [ "$2" = "--stage" ]; then\n`
      + `  echo "fatal: not a git repository (simulated concurrent metadata loss)" >&2\n`
      + `  exit 128\n`
      + `fi\n`
      + `exec '${realGit}' "$@"\n`,
      { mode: 0o755 });
    const previousPath = process.env.PATH;
    let after: WorkspaceSnapshot;
    try {
      process.env.PATH = `${shimDir}:${previousPath}`;
      after = await createWorkspaceSnapshot(dir, snapshotOptions);
    } finally {
      process.env.PATH = previousPath;
    }

    const entry = after.files.get("submodule");
    assert.equal(entry?.exists, true, "the gitlink directory was verified present");
    assert.equal(entry?.omittedReason, "unreadable");
    assert.equal(entry?.entryType, "gitlink");
    const omission = after.omissions.find((record) => record.path === "submodule");
    assert.equal(omission?.kind, "directory");
    assert.equal(omission?.reason, "unreadable");
    const statuses = compareSnapshots(before, after).map((change) => [change.path, change.status]);
    assert.ok(!statuses.some(([path, status]) => path === "submodule" && status === "deleted"),
      "a failed gitlink inspection must never be reported as deleted");
    assert.deepEqual(statuses, [["submodule", "modified"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(shimDir, { recursive: true, force: true });
  }
});

test("snapshot represents tracked gitlinks without traversing their directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-gitlink-"));
  const git = (args: string[]) => execFileAsync("git", args, {
    cwd: dir,
    env: gitEnv(),
  });
  try {
    await git(["init", "--quiet"]);
    await writeFile(join(dir, "base.txt"), "one\n", "utf8");
    await git(["add", "base.txt"]);
    await git(["commit", "--quiet", "-m", "one"]);
    const first = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await mkdir(join(dir, "submodule"));
    await writeFile(join(dir, "submodule", "secret.txt"), "must not be traversed\n", "utf8");
    await git(["update-index", "--add", "--cacheinfo", `160000,${first},submodule`]);

    const before = await createWorkspaceSnapshot(dir, snapshotOptions);
    const gitlink = before.files.get("submodule");
    assert.equal(gitlink?.entryType, "gitlink");
    assert.equal(gitlink?.gitObjectId, first);
    assert.equal(before.files.has("submodule/secret.txt"), false);

    await writeFile(join(dir, "base.txt"), "two\n", "utf8");
    await git(["add", "base.txt"]);
    await git(["commit", "--quiet", "-m", "two"]);
    const second = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["update-index", "--cacheinfo", `160000,${second},submodule`]);
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.deepEqual(compareSnapshots(before, after).map((change) => change.path), ["base.txt", "submodule"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a deterministic inspection race cannot capture a replacement symlink target", async (t) => {
  if (process.platform === "win32") t.skip("symlink creation varies on Windows");
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-symlink-race-"));
  const outside = join(tmpdir(), `pi-review-gate-secret-${Date.now()}.txt`);
  try {
    await writeFile(join(dir, "victim.txt"), "inside\n", "utf8");
    await writeFile(join(dir, "sibling.txt"), "sibling\n", "utf8");
    await writeFile(outside, "outside secret\n", "utf8");
    let swapped = false;
    const snapshot = await createWorkspaceSnapshot(dir, {
      ...snapshotOptions,
      captureFaults: {
        beforeInspectFile: async ({ relativePath, absolutePath }) => {
          if (relativePath !== "victim.txt" || swapped) return;
          swapped = true;
          await rm(absolutePath);
          await symlink(outside, absolutePath);
        },
      },
    });
    assert.equal(snapshot.files.get("sibling.txt")?.content, "sibling\n");
    assert.equal(snapshot.files.get("victim.txt")?.omittedReason, "unreadable");
    assert.equal(snapshot.files.get("victim.txt")?.content, undefined);
    assert.equal(snapshot.omissions.find((entry) => entry.path === "victim.txt")?.reason, "unreadable");
    assert.doesNotMatch(JSON.stringify([...snapshot.files.values()]), /outside secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});

test("in-place growth during inspection cannot bypass snapshot bounds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-growth-race-"));
  try {
    await writeFile(join(dir, "victim.txt"), "x", "utf8");
    await writeFile(join(dir, "sibling.txt"), "sibling\n", "utf8");
    const snapshot = await createWorkspaceSnapshot(dir, {
      maxFileBytes: 8,
      maxSnapshotBytes: 32,
      captureFaults: {
        beforeInspectFile: async ({ relativePath, absolutePath }) => {
          if (relativePath === "victim.txt") await writeFile(absolutePath, "a".repeat(64), "utf8");
        },
      },
    });
    assert.equal(snapshot.files.get("victim.txt")?.omittedReason, "unreadable");
    assert.equal(snapshot.files.get("victim.txt")?.content, undefined);
    assert.equal(snapshot.files.get("sibling.txt")?.content, "sibling\n");
    assert.doesNotMatch(JSON.stringify([...snapshot.files.values()]), /aaaa/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeFileSnapshot(relativePath: string, content: string): FileSnapshot {
  return {
    relativePath,
    absolutePath: `/workspace/${relativePath}`,
    exists: true,
    size: Buffer.byteLength(content),
    mtimeMs: 1,
    sha256: createHash("sha256").update(content).digest("hex"),
    isBinary: false,
    content,
  };
}

test("fault classifier maps errno codes deterministically to missing vs unreadable", () => {
  // Only ENOENT/ENOTDIR mean the entry vanished during capture.
  assert.equal(fsFaultReason(enoent()), "missing");
  assert.equal(fsFaultReason(enotdir()), "missing");
  // EACCES/EPERM/ELOOP and unknown/transient conditions are unreadable.
  for (const code of ["EACCES", "EPERM", "ELOOP", "EIO", "EBUSY", "ETXTBSY", "EMFILE", "UNKNOWN"]) {
    assert.equal(fsFaultReason({ code }), "unreadable", code);
  }
  assert.equal(fsFaultReason(new Error("plain")), "unreadable");
  assert.equal(fsFaultReason("not an object"), "unreadable");
  assert.equal(fsFaultCode(enoent()), "ENOENT");
  assert.equal(fsFaultCode({ code: "" }), undefined);
  assert.equal(fsFaultCode(new Error("plain")), undefined);
});

function enoent(): Error {
  const error = new Error("no such file or directory");
  (error as Error & { code?: string }).code = "ENOENT";
  return error;
}

function enotdir(): Error {
  const error = new Error("not a directory");
  (error as Error & { code?: string }).code = "ENOTDIR";
  return error;
}

test("snapshot survives an unreadable file, captures siblings, and keeps the file present", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-unreadable-file-"));
  try {
    await writeFile(join(dir, "protected.txt"), "protected content\n", "utf8");
    await writeFile(join(dir, "sibling.txt"), "keep me\n", "utf8");
    await chmod(join(dir, "protected.txt"), 0o000);

    const snapshot = await createWorkspaceSnapshot(dir, snapshotOptions);
    const protectedFile = snapshot.files.get("protected.txt");
    assert.equal(protectedFile?.exists, true, "unreadable file must keep existence");
    assert.equal(protectedFile?.omittedReason, "unreadable");
    assert.equal(protectedFile?.content, undefined);
    assert.equal(snapshot.files.get("sibling.txt")?.content, "keep me\n", "siblings stay captured");
    assert.deepEqual(snapshot.omissions.filter((entry) => entry.path === "protected.txt"), [{
      path: "protected.txt",
      kind: "file",
      reason: "unreadable",
      errorCode: "EACCES",
    }]);
    assert.equal(snapshot.omissionsTruncated, false);
  } finally {
    await chmod(join(dir, "protected.txt"), 0o644).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an existing-but-unreadable file is reported as modified, never as deleted", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-unreadable-compare-"));
  try {
    await writeFile(join(dir, "protected.txt"), "before\n", "utf8");
    await writeFile(join(dir, "sibling.txt"), "same\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);

    await chmod(join(dir, "protected.txt"), 0o000);
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);

    const changes = compareSnapshots(before, after);
    assert.deepEqual(changes.filter((change) => change.status === "deleted"), [],
      "unreadable existing files must not be reported as deleted");
    const protectedChange = changes.find((change) => change.path === "protected.txt");
    assert.equal(protectedChange?.status, "modified");
    assert.equal(protectedChange?.diffOmittedReason, "unreadable");
    assert.equal(changes.some((change) => change.path === "sibling.txt"), false);
  } finally {
    await chmod(join(dir, "protected.txt"), 0o644).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot survives an unreadable directory with a typed directory omission", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-unreadable-dir-"));
  try {
    await mkdir(join(dir, "protected"));
    await writeFile(join(dir, "protected", "inside.txt"), "hidden\n", "utf8");
    await writeFile(join(dir, "root.txt"), "visible\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);

    await chmod(join(dir, "protected"), 0o000);
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);

    assert.equal(after.files.get("root.txt")?.content, "visible\n", "siblings stay captured");
    assert.equal(after.files.has("protected/inside.txt"), false);
    const omission = after.omissions.find((entry) => entry.path === "protected");
    assert.equal(omission?.kind, "directory");
    assert.equal(omission?.reason, "unreadable");
    assert.equal(omission?.errorCode, "EACCES");

    // Children of the unreadable directory must not be misreported as deleted.
    assert.deepEqual(compareSnapshots(before, after).filter((change) => change.status === "deleted"),
      [], "children under an unreadable directory must not be reported deleted");
  } finally {
    await chmod(join(dir, "protected"), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("compareSnapshots never reports children of an unreadable directory as deleted", () => {
  const before: WorkspaceSnapshot = {
    cwd: "/workspace",
    capturedAt: "2026-01-01T00:00:00.000Z",
    files: new Map([
      ["dir/a.txt", makeFileSnapshot("dir/a.txt", "a")],
      ["kept.txt", makeFileSnapshot("kept.txt", "k")],
    ]),
    omissions: [],
    omissionsTruncated: false,
  };
  const after: WorkspaceSnapshot = {
    cwd: "/workspace",
    capturedAt: "2026-01-01T00:00:01.000Z",
    files: new Map([["kept.txt", makeFileSnapshot("kept.txt", "k")]]),
    omissions: [{ path: "dir", kind: "directory", reason: "unreadable", errorCode: "EACCES" }],
    omissionsTruncated: false,
  };
  assert.deepEqual(compareSnapshots(before, after), [],
    "missing children under an unreadable directory must not be reported deleted");
});

test("a tracked file deleted before capture is a missing omission and still compares as deleted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-missing-"));
  await initGit(dir);
  try {
    await writeFile(join(dir, "tracked.txt"), "tracked\n", "utf8");
    await writeFile(join(dir, "kept.txt"), "kept\n", "utf8");
    await gitAddCommit(dir, "seed");

    const before = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.equal(before.files.get("tracked.txt")?.content, "tracked\n");
    assert.deepEqual(before.omissions, []);

    // git ls-files -co still lists the cached tracked file, so capture sees the
    // file vanish between discovery and lstat: a deterministic missing omission.
    await rm(join(dir, "tracked.txt"));
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);

    assert.equal(after.files.has("tracked.txt"), false);
    assert.equal(after.files.get("kept.txt")?.content, "kept\n", "siblings stay captured");
    assert.deepEqual(after.omissions.filter((entry) => entry.path === "tracked.txt"), [{
      path: "tracked.txt",
      kind: "file",
      reason: "missing",
      errorCode: "ENOENT",
    }]);
    assert.deepEqual(compareSnapshots(before, after).map((change) => [change.path, change.status]),
      [["tracked.txt", "deleted"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshot omission ledger is bounded and flags truncation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-omission-bound-"));
  await initGit(dir);
  try {
    const count = MAX_SNAPSHOT_OMISSIONS + 5;
    await Promise.all(Array.from({ length: count }, (_, index) =>
      writeFile(join(dir, `gone-${String(index).padStart(4, "0")}.txt`), `${index}\n`, "utf8")));
    await gitAddCommit(dir, "seed");
    await Promise.all(Array.from({ length: count }, (_, index) =>
      rm(join(dir, `gone-${String(index).padStart(4, "0")}.txt`))));

    const snapshot = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.equal(snapshot.omissions.length, MAX_SNAPSHOT_OMISSIONS);
    assert.equal(snapshot.omissionsTruncated, true);
    assert.ok(snapshot.omissions.every((entry) => entry.reason === "missing"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fixture git helpers leave no detached maintenance racing teardown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-fixture-quiesce-"));
  try {
    await initGit(dir);
    await writeFile(join(dir, "seed.txt"), "seed\n", "utf8");
    // GIT_TRACE2_EVENT records every spawned child with its argv, including
    // the detached `git maintenance run --auto --quiet --detach` that plain
    // `git commit` forks. The fixture env must suppress that spawn: the
    // detached child creates `.git/objects/maintenance.lock` before it
    // evaluates any gc threshold, so on a loaded CI runner that file can
    // appear inside `.git/objects` while the fixture's recursive teardown
    // rm is already deleting it, producing a spurious ENOTEMPTY (the
    // observed flake in the bounded omission ledger fixture).
    const traceEvents = join(dir, "trace2-events.jsonl");
    await execFileAsync("git", ["add", "seed.txt"], { cwd: dir, env: gitEnv() });
    await execFileAsync("git", ["commit", "--quiet", "-m", "seed"], {
      cwd: dir,
      env: { ...gitEnv(), GIT_TRACE2_EVENT: traceEvents },
    });
    const trace = await readFile(traceEvents, "utf8");
    assert.equal(
      trace.includes("maintenance"),
      false,
      "git commit must not spawn detached auto-maintenance in fixture repos",
    );

    // Bounded quiescence: once the awaited git calls settle, the object
    // store must gain no new entries before the teardown rm runs.
    const objectsDir = join(dir, ".git", "objects");
    const before = (await readdir(objectsDir)).sort();
    await delay(250);
    assert.deepEqual((await readdir(objectsDir)).sort(), before,
      "no late object-store writes after fixture git calls settle");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("git discovery warnings yield unreadable-directory omissions even when git succeeds", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-git-unreadable-"));
  await initGit(dir);
  try {
    await mkdir(join(dir, "protected"), { recursive: true });
    await writeFile(join(dir, "protected", "inside.txt"), "hidden\n", "utf8");
    await writeFile(join(dir, "keep.txt"), "keep\n", "utf8");
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.equal(before.files.get("protected/inside.txt")?.content, "hidden\n");

    await chmod(join(dir, "protected"), 0o000);
    // git ls-files -co exits successfully while warning that it could not
    // open the directory; capture must still record the omission so the
    // child is never misreported as deleted.
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);

    assert.equal(after.files.get("keep.txt")?.content, "keep\n", "siblings stay captured");
    assert.equal(after.files.has("protected/inside.txt"), false);
    const omission = after.omissions.find((entry) => entry.path === "protected");
    assert.equal(omission?.kind, "directory");
    assert.equal(omission?.reason, "unreadable");
    assert.deepEqual(
      compareSnapshots(before, after).filter((change) => change.status === "deleted"),
      [],
      "git-discovered unreadable directories must not surface as child deletions",
    );
  } finally {
    await chmod(join(dir, "protected"), 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("git discovery warnings are captured cwd-relative when cwd is a repository subdirectory", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const repo = await mkdtemp(join(tmpdir(), "pi-review-gate-git-subdir-"));
  await initGit(repo);
  try {
    // cwd will be repo/sub, but Git's warning path for the unreadable
    // directory is repo-relative ("sub/protected"), so the snapshot must
    // still record a cwd-relative omission covering "protected/inside.txt".
    await mkdir(join(repo, "sub", "protected"), { recursive: true });
    await writeFile(join(repo, "sub", "protected", "inside.txt"), "hidden\n", "utf8");
    await writeFile(join(repo, "sub", "keep.txt"), "keep\n", "utf8");
    // A different directory that collides with the repository-relative form of
    // the unreadable path: cwd-relative "sub/protected/..." (repo/sub/sub/...).
    await mkdir(join(repo, "sub", "sub", "protected"), { recursive: true });
    await writeFile(join(repo, "sub", "sub", "protected", "really-gone.txt"), "gone\n", "utf8");
    const sub = join(repo, "sub");
    const before = await createWorkspaceSnapshot(sub, snapshotOptions);
    assert.equal(before.files.get("protected/inside.txt")?.content, "hidden\n");
    assert.equal(before.files.get("sub/protected/really-gone.txt")?.content, "gone\n");

    await chmod(join(repo, "sub", "protected"), 0o000);
    await rm(join(repo, "sub", "sub", "protected", "really-gone.txt"));
    const after = await createWorkspaceSnapshot(sub, snapshotOptions);

    assert.equal(after.files.get("keep.txt")?.content, "keep\n", "siblings stay captured");
    assert.equal(after.omissions.some((omission) =>
      omission.path === "protected" && omission.kind === "directory" && omission.reason === "unreadable"),
      true, "the audit must record the unreadable directory in cwd-relative form");
    // The repo-relative warning path must not leak into the cwd namespace:
    // a genuine deletion at cwd-relative sub/protected/really-gone.txt stays
    // reported while children of the unreadable repo/sub/protected stay
    // suppressed.
    assert.deepEqual(
      compareSnapshots(before, after)
        .filter((change) => change.status === "deleted")
        .map((change) => change.path),
      ["sub/protected/really-gone.txt"],
      "only the genuine sibling deletion is reported; unreadable children are not",
    );
  } finally {
    await chmod(join(repo, "sub", "protected"), 0o755).catch(() => undefined);
    await rm(repo, { recursive: true, force: true });
  }
});

test("parseGitDirectoryWarnings extracts unreadable entries from git stderr", () => {
  assert.deepEqual(parseGitDirectoryWarnings(
    "warning: could not open directory 'protected/': Permission denied\n",
  ), [{ path: "protected", kind: "directory" }]);
  assert.deepEqual(parseGitDirectoryWarnings(
    "warning: unable to access 'nested/dir': Permission denied\n"
    + "warning: unable to access 'other': Not a directory\n",
  ), [{ path: "nested/dir", kind: "file" }, { path: "other", kind: "file" }]);
  assert.deepEqual(parseGitDirectoryWarnings("warning: something else entirely\n"), []);
  assert.deepEqual(parseGitDirectoryWarnings(""), []);
  // Duplicates collapse and a root-level warning becomes ".".
  assert.deepEqual(parseGitDirectoryWarnings(
    "warning: could not open directory 'a': EACCES\n"
    + "warning: could not open directory 'a': EACCES\n"
    + "warning: could not open directory '/': EACCES\n",
  ), [{ path: "a", kind: "directory" }, { path: ".", kind: "directory" }]);
});

test("git warning paths are normalized to the capture cwd", () => {
  assert.equal(gitWarningPathRelativeToCwd("sub/protected", "sub/"), "protected");
  assert.equal(gitWarningPathRelativeToCwd("sub/protected/", "sub/"), "protected");
  assert.equal(gitWarningPathRelativeToCwd("sub/sub/protected", "sub/"), "sub/protected");
  assert.equal(gitWarningPathRelativeToCwd("other/protected", "sub/"), undefined);
  assert.equal(gitWarningPathRelativeToCwd("../outside", "sub/"), undefined);
  assert.equal(gitWarningPathRelativeToCwd("/outside/excludes", "sub/"), undefined);
  // At the repository root the prefix is empty and paths pass through.
  assert.equal(gitWarningPathRelativeToCwd("protected", ""), "protected");
  assert.equal(gitWarningPathRelativeToCwd("./", ""), ".");
  // The capture root itself becoming unreadable maps to ".".
  assert.equal(gitWarningPathRelativeToCwd("sub/", "sub/"), ".");
});

test("an unreadable directory is recorded after missing-entry overflow", () => {
  const omissions: SnapshotOmission[] = [];
  let truncated = false;
  for (let index = 0; index <= MAX_SNAPSHOT_OMISSIONS; index += 1) {
    truncated = recordSnapshotOmission(omissions, truncated, "file", `gone-${index}.txt`, enoent());
  }
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  truncated = recordSnapshotOmission(omissions, truncated, "directory", "protected", denied);

  assert.equal(truncated, true);
  assert.equal(omissions.length, MAX_SNAPSHOT_OMISSIONS);
  assert.ok(omissions.some((entry) =>
    entry.path === "." && entry.kind === "directory" && entry.reason === "unreadable"),
    "an unreadable directory after overflow must install the root-level sentinel");
});

test("compareSnapshots suppresses all deletions when a root-level unreadable-directory sentinel is present", () => {
  const before: WorkspaceSnapshot = {
    cwd: "/workspace",
    capturedAt: "2026-01-01T00:00:00.000Z",
    files: new Map([
      ["somewhere/deep/a.txt", makeFileSnapshot("somewhere/deep/a.txt", "a")],
      ["kept.txt", makeFileSnapshot("kept.txt", "k")],
    ]),
    omissions: [],
    omissionsTruncated: false,
  };
  const after: WorkspaceSnapshot = {
    cwd: "/workspace",
    capturedAt: "2026-01-01T00:00:01.000Z",
    files: new Map([["kept.txt", makeFileSnapshot("kept.txt", "k")]]),
    // Root-level sentinel: at least one unreadable directory could not be
    // recorded, so its scope is unknown and every deletion is unverified.
    omissions: [{ path: ".", kind: "directory", reason: "unreadable" }],
    omissionsTruncated: true,
  };
  assert.deepEqual(
    compareSnapshots(before, after).filter((change) => change.status === "deleted"),
    [],
    "an overflowed ledger must not let unreadable paths surface as deletions",
  );
});

test("an unreadable directory met after the omission ledger overflows installs a root-level sentinel", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-omission-sentinel-"));
  const unreadable: string[] = [];
  try {
    // Fill the ledger with unreadable-directory omissions (one per directory)
    // and leave one extra directory to overflow past MAX_SNAPSHOT_OMISSIONS.
    const dirCount = MAX_SNAPSHOT_OMISSIONS + 1;
    for (let index = 0; index < dirCount; index += 1) {
      const name = `d${String(index).padStart(4, "0")}`;
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, "inside.txt"), `${index}\n`, "utf8");
      unreadable.push(name);
    }
    const before = await createWorkspaceSnapshot(dir, snapshotOptions);
    assert.equal(before.omissions.length, 0);

    await Promise.all(unreadable.map((name) => chmod(join(dir, name), 0o000)));
    const after = await createWorkspaceSnapshot(dir, snapshotOptions);

    assert.equal(after.omissions.length, MAX_SNAPSHOT_OMISSIONS, "ledger stays bounded");
    assert.equal(after.omissionsTruncated, true);
    const sentinel = after.omissions.find((omission) =>
      omission.path === "." && omission.kind === "directory" && omission.reason === "unreadable");
    assert.ok(sentinel, "overflow must install a conservative root-level sentinel");
    assert.deepEqual(
      compareSnapshots(before, after).filter((change) => change.status === "deleted"),
      [],
      "children of overflowed unreadable directories must not be reported deleted",
    );
  } finally {
    await Promise.all(unreadable.map((name) => chmod(join(dir, name), 0o755).catch(() => undefined)));
    await rm(dir, { recursive: true, force: true });
  }
});

test("createPathSnapshot classifies unreadable existing paths as unreadable, not missing", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
  }
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-path-unreadable-"));
  try {
    await writeFile(join(dir, "protected.txt"), "protected\n", "utf8");
    await chmod(join(dir, "protected.txt"), 0o000);
    const snapshot = await createPathSnapshot(dir, "protected.txt", snapshotOptions);
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.omittedReason, "unreadable");
    assert.equal(snapshot.content, undefined);
  } finally {
    await chmod(join(dir, "protected.txt"), 0o644).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("createPathSnapshot classifies a deleted path as missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-path-missing-"));
  try {
    const snapshot = await createPathSnapshot(dir, "absent.txt", snapshotOptions);
    assert.equal(snapshot.exists, false);
    assert.equal(snapshot.omittedReason, "missing");
    assert.equal(snapshot.sha256, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function gitEnv(): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    // `git commit` spawns a detached `git maintenance run --auto --quiet
    // --detach` child that outlives the awaited execFile call. That child
    // creates `.git/objects/maintenance.lock` (its lock lives at the object
    // database path) before it even evaluates the gc thresholds, so on a
    // loaded runner it can appear while a fixture's recursive teardown rm is
    // already deleting `.git/objects`, producing a spurious ENOTEMPTY. Every
    // fixture git invocation disables auto-maintenance and auto-gc so the
    // object store is quiescent once the awaited git calls settle.
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "maintenance.auto",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "gc.auto",
    GIT_CONFIG_VALUE_1: "0",
  };
}

async function initGit(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet"], { cwd: dir, env: gitEnv() });
}

async function gitAddCommit(dir: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "-A"], { cwd: dir, env: gitEnv() });
  await execFileAsync("git", ["commit", "--quiet", "-m", message], { cwd: dir, env: gitEnv() });
}
