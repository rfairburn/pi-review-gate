import assert from "node:assert/strict";
import test from "node:test";
import { SerialWriter } from "../src/execution/serial-writer";

test("SerialWriter preserves publication order when an older write is delayed", async () => {
  const published: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const writer = new SerialWriter<string>(async (value) => {
    if (value === "working") await firstBlocked;
    published.push(value);
  });

  const working = writer.write("working");
  const completed = writer.write("completed");
  await Promise.resolve();
  assert.deepEqual(published, []);
  releaseFirst?.();
  await Promise.all([working, completed]);
  assert.deepEqual(published, ["working", "completed"]);
});

test("SerialWriter reports a failed write but continues with terminal state", async () => {
  const published: string[] = [];
  const writer = new SerialWriter<string>(async (value) => {
    if (value === "progress") throw new Error("disk busy");
    published.push(value);
  });

  await assert.rejects(writer.write("progress"), /disk busy/);
  await writer.write("completed");
  await writer.drain();
  assert.deepEqual(published, ["completed"]);
});
