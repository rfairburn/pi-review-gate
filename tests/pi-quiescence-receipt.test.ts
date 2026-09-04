import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  awaitPiQuiescenceReceipt,
  capturePiQuiescenceBootstrap,
  createPiQuiescenceBootstrap,
  piQuiescenceEnvironment,
  publishPiQuiescenceReceipt,
} from "../src/execution/pi-quiescence-receipt";

test("Pi quiescence receipt is exact-generation bound, one-shot, and bootstrap secrets are erased", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-quiescence-receipt-"));
  try {
    const parent = createPiQuiescenceBootstrap(root, "session-exact");
    parent.pid = process.pid;
    const env = piQuiescenceEnvironment(parent);
    const child = capturePiQuiescenceBootstrap(env);
    assert.ok(child);
    assert.deepEqual(Object.keys(env), [], "the signing bootstrap is absent before model tools run");
    await publishPiQuiescenceReceipt(child, 1);
    assert.equal(await awaitPiQuiescenceReceipt(parent, 0, 100), 1);
    await assert.rejects(awaitPiQuiescenceReceipt(parent, 0, 20), /not received/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi quiescence receipt rejects stale, forged, malformed, and missing acknowledgements", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-quiescence-invalid-"));
  try {
    const parent = createPiQuiescenceBootstrap(root, "session-exact");
    parent.pid = process.pid;
    await publishPiQuiescenceReceipt(parent, 1);
    await assert.rejects(awaitPiQuiescenceReceipt(parent, 1, 100), /does not match/);

    await publishPiQuiescenceReceipt(parent, 2);
    const forged = JSON.parse(await readFile(parent.path, "utf8"));
    forged.mac = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await writeFile(parent.path, JSON.stringify(forged), "utf8");
    await assert.rejects(awaitPiQuiescenceReceipt(parent, 1, 100), /signature is invalid/);

    await writeFile(parent.path, "{not-json", "utf8");
    await assert.rejects(awaitPiQuiescenceReceipt(parent, 2, 100), /malformed/);
    await assert.rejects(awaitPiQuiescenceReceipt(parent, 2, 20), /not received/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});