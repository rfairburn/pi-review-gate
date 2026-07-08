import assert from "node:assert/strict";
import test from "node:test";
import { buildUnifiedPatch } from "../src/diff";

test("buildUnifiedPatch includes added, modified, and deleted text files", () => {
  const result = buildUnifiedPatch(
    [
      {
        path: "a.txt",
        status: "added",
        binary: false,
        oversized: false,
        oldContent: undefined,
        newContent: "hello\n",
      },
      {
        path: "b.txt",
        status: "modified",
        binary: false,
        oversized: false,
        oldContent: "old\n",
        newContent: "new\n",
      },
      {
        path: "c.txt",
        status: "deleted",
        binary: false,
        oversized: false,
        oldContent: "bye\n",
        newContent: undefined,
      },
    ],
    10_000,
  );

  assert.match(result.patch, /--- \/dev\/null\n\+\+\+ b\/a\.txt/);
  assert.match(result.patch, /-old\n\+new/);
  assert.match(result.patch, /--- a\/c\.txt\n\+\+\+ \/dev\/null/);
  assert.equal(result.truncated, false);
});

test("buildUnifiedPatch emits context hunks instead of whole-file replacement", () => {
  const oldContent = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
  const newContent = oldContent.replace("line 10\n", "line ten\n");

  const result = buildUnifiedPatch(
    [{
      path: "large.txt",
      status: "modified",
      binary: false,
      oversized: false,
      oldContent,
      newContent,
    }],
    10_000,
  );

  assert.match(result.patch, /@@ -7,7 \+7,7 @@/);
  assert.match(result.patch, / line 9\n-line 10\n\+line ten\n line 11/);
  assert.doesNotMatch(result.patch, /^ line 1$/m);
  assert.doesNotMatch(result.patch, /^ line 20$/m);
});

test("buildUnifiedPatch merges edits separated by a short gap into one hunk", () => {
  const oldContent = "a\ng1\ng2\ng3\ng4\nb\n";
  const newContent = "A\ng1\ng2\ng3\ng4\nB\n";

  const result = buildUnifiedPatch(
    [{
      path: "gap.txt",
      status: "modified",
      binary: false,
      oversized: false,
      oldContent,
      newContent,
    }],
    10_000,
  );

  assert.equal(result.patch.match(/^@@ /gm)?.length, 1);
  assert.match(result.patch, /@@ -1,6 \+1,6 @@/);
  assert.match(result.patch, /-a\n\+A\n g1\n g2\n g3\n g4\n-b\n\+B/);
});

test("buildUnifiedPatch splits distant edits into non-overlapping hunks", () => {
  const gap = Array.from({ length: 9 }, (_, index) => `g${index + 1}`);
  const oldContent = ["a", ...gap, "b"].join("\n") + "\n";
  const newContent = ["A", ...gap, "B"].join("\n") + "\n";

  const result = buildUnifiedPatch(
    [{
      path: "split.txt",
      status: "modified",
      binary: false,
      oversized: false,
      oldContent,
      newContent,
    }],
    10_000,
  );

  const headers = [...result.patch.matchAll(/^@@ -(\d+),(\d+) \+\d+,\d+ @@$/gm)]
    .map((match) => ({ start: Number(match[1]), count: Number(match[2]) }));
  assert.equal(headers.length, 2);
  const firstEnd = headers[0].start + headers[0].count - 1;
  assert.equal(firstEnd < headers[1].start, true);
  for (const line of ["g1", "g2", "g3", "g7", "g8", "g9"]) {
    assert.equal(result.patch.match(new RegExp(`^ ${line}$`, "gm"))?.length, 1);
  }
});

test("buildUnifiedPatch omits binary changes", () => {
  const result = buildUnifiedPatch(
    [
      {
        path: "image.png",
        status: "modified",
        binary: true,
        oversized: false,
        diffOmittedReason: "binary",
      },
    ],
    10_000,
  );

  assert.match(result.patch, /Diff omitted for image\.png: binary/);
  assert.deepEqual(result.omitted, [{ path: "image.png", reason: "binary" }]);
});
