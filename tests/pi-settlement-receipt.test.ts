import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  awaitPiSettlementReceipt,
  capturePiSettlementBootstrap,
  createPiSettlementBootstrap,
  piSettlementEnvironment,
  publishPiSettlementReceipt,
} from "../src/execution/pi-settlement-receipt";

test("Pi live-browser settlement receipt is generation bound, one-shot, and bootstrap secrets are erased", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-settlement-receipt-"));
  try {
    const parent = createPiSettlementBootstrap(root, "session-exact");
    parent.pid = process.pid;
    const env = piSettlementEnvironment(parent);
    const child = capturePiSettlementBootstrap(env);
    assert.ok(child);
    assert.deepEqual(Object.keys(env), [], "the signing bootstrap is absent before model tools run");
    assert.equal(capturePiSettlementBootstrap(env), undefined, "reload cannot bootstrap a new generation from erased credentials");
    await publishPiSettlementReceipt(child, 1);
    assert.equal(await awaitPiSettlementReceipt(parent, 0, 100), 1);
    await assert.rejects(awaitPiSettlementReceipt(parent, 0, 20), /not received/);
    await publishPiSettlementReceipt(child, 2);
    assert.equal(await awaitPiSettlementReceipt(parent, 1, 100), 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi settlement receipt rejects legacy, stale, forged, mismatched, malformed, and missing acknowledgements", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-settlement-invalid-"));
  try {
    const parent = createPiSettlementBootstrap(root, "session-exact");
    parent.pid = process.pid;
    await publishPiSettlementReceipt(parent, 1);
    await assert.rejects(awaitPiSettlementReceipt(parent, 1, 100), /does not match/);

    await publishPiSettlementReceipt(parent, 2);
    const forged = JSON.parse(await readFile(parent.path, "utf8"));
    forged.mac = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    await writeFile(parent.path, JSON.stringify(forged), "utf8");
    await assert.rejects(awaitPiSettlementReceipt(parent, 1, 100), /signature is invalid/);

    for (const field of ["version", "sessionId", "childId", "pid"]) {
      await publishPiSettlementReceipt(parent, 3);
      const mismatched = JSON.parse(await readFile(parent.path, "utf8"));
      mismatched[field] = field === "version" ? 1 : field === "pid" ? process.pid + 1 : "wrong-identity";
      await writeFile(parent.path, JSON.stringify(mismatched));
      await assert.rejects(awaitPiSettlementReceipt(parent, 2, 100), /malformed|does not match/);
    }

    await writeFile(parent.path, "{not-json", "utf8");
    await assert.rejects(awaitPiSettlementReceipt(parent, 2, 100), /malformed/);
    await assert.rejects(awaitPiSettlementReceipt(parent, 2, 20), /not received/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});