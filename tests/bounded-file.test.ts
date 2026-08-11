import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readBoundedTextFile } from "../src/bounded-file";

test("readBoundedTextFile never retains more than its byte limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-bounded-file-"));
  try {
    const path = join(dir, "large.txt");
    await writeFile(path, "a".repeat(1025));
    assert.deepEqual(await readBoundedTextFile(path, 1024), {
      text: "a".repeat(1024),
      truncated: true,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
