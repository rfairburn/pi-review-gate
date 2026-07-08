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
