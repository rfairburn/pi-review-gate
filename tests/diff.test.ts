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
