import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  awaitPiSettlementReceipt,
  capturePiSettlementBootstrap,
  createPiSettlementBootstrap,
  piSettlementEnvironment,
  publishPiSettlementReceipt,
} from "../src/execution/pi-settlement-receipt";
import { isVerifiedWindowsAncestryEvidence } from "../src/execution/windows-process-lineage";

function windowsAncestryEvidence(records: Array<{
  pid: number;
  parentPid: number;
  creationTicks: number;
  observedTicks?: number;
}>): string {
  const ticks = (value: number): string => String(value).padStart(19, "0");
  return records.map((record) => [
    record.pid,
    record.parentPid,
    ticks(record.creationTicks),
    ticks(record.observedTicks ?? record.creationTicks),
  ].join(",")).join(";");
}

async function writeSignedReceipt(
  bootstrap: ReturnType<typeof createPiSettlementBootstrap>,
  pid: number,
  settlement: number,
  corruptMac = false,
): Promise<void> {
  const unsigned = {
    version: 2,
    sessionId: bootstrap.sessionId,
    childId: bootstrap.childId,
    settlement,
    pid,
  };
  const oneShot = createHmac("sha256", bootstrap.secret)
    .update(`pi-review-gate-live-browser-settlement-key:v2:${settlement}`)
    .digest();
  const mac = createHmac("sha256", oneShot)
    .update(JSON.stringify([unsigned.version, unsigned.sessionId, unsigned.childId, unsigned.settlement, unsigned.pid]))
    .digest("base64url");
  const corruptedMac = `${mac.startsWith("A") ? "B" : "A"}${mac.slice(1)}`;
  await mkdir(dirname(bootstrap.path), { recursive: true });
  await writeFile(bootstrap.path, `${JSON.stringify({ ...unsigned, mac: corruptMac ? corruptedMac : mac })}\n`);
}

test("Windows ancestry evidence accepts nested descendants only when parent creation predates the child", () => {
  const nested = windowsAncestryEvidence([
    { pid: 67890, parentPid: 54321, creationTicks: 300 },
    { pid: 54321, parentPid: 43210, creationTicks: 200 },
    { pid: 43210, parentPid: 10000, creationTicks: 100 },
    { pid: 10000, parentPid: 4, creationTicks: 50 },
  ]);
  assert.equal(isVerifiedWindowsAncestryEvidence(nested, 67890, 10000), true,
    "a Pi process several managed-launcher levels below cmd.exe remains an owned descendant");

  const unrelated = windowsAncestryEvidence([
    { pid: 67890, parentPid: 54321, creationTicks: 300 },
    { pid: 54321, parentPid: 10001, creationTicks: 200 },
    { pid: 10001, parentPid: 4, creationTicks: 50 },
  ]);
  assert.equal(isVerifiedWindowsAncestryEvidence(unrelated, 67890, 10000), false,
    "an unrelated process chain cannot satisfy the owned root");

  const recycledParent = windowsAncestryEvidence([
    { pid: 67890, parentPid: 54321, creationTicks: 100 },
    { pid: 54321, parentPid: 10000, creationTicks: 200 },
    { pid: 10000, parentPid: 4, creationTicks: 50 },
  ]);
  assert.equal(isVerifiedWindowsAncestryEvidence(recycledParent, 67890, 10000), false,
    "a stable PID/parent snapshot is rejected when a recycled parent was created after its child");

  const unstableSnapshot = windowsAncestryEvidence([
    { pid: 67890, parentPid: 10000, creationTicks: 100, observedTicks: 101 },
    { pid: 10000, parentPid: 4, creationTicks: 50 },
  ]);
  assert.equal(isVerifiedWindowsAncestryEvidence(unstableSnapshot, 67890, 10000), false,
    "creation-time snapshot changes are rejected");

  const cycle = windowsAncestryEvidence([
    { pid: 67890, parentPid: 54321, creationTicks: 300 },
    { pid: 54321, parentPid: 54321, creationTicks: 200 },
    { pid: 10000, parentPid: 4, creationTicks: 50 },
  ]);
  assert.equal(isVerifiedWindowsAncestryEvidence(cycle, 67890, 10000), false,
    "cyclic ancestry evidence is rejected");

  const tooDeep = windowsAncestryEvidence([
    { pid: 67890, parentPid: 70000, creationTicks: 1000 },
    ...Array.from({ length: 64 }, (_, index) => ({
      pid: 70000 + index,
      parentPid: index === 63 ? 10000 : 70001 + index,
      creationTicks: 999 - index,
    })),
    { pid: 10000, parentPid: 4, creationTicks: 900 },
  ]);
  assert.equal(isVerifiedWindowsAncestryEvidence(tooDeep, 67890, 10000), false,
    "ancestry evidence beyond the bounded parent walk is rejected");

  assert.equal(isVerifiedWindowsAncestryEvidence(nested, 10000, 10000), false,
    "the cmd root itself is not the actual Pi PID");
});

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

test("cmd-root receipt authenticates before nested descendant proof and binds the actual Pi PID once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-settlement-lineage-"));
  try {
    const parent = createPiSettlementBootstrap(root, "cmd-root-session");
    const verified: number[] = [];
    const nestedEvidence = windowsAncestryEvidence([
      { pid: 67890, parentPid: 54321, creationTicks: 300 },
      { pid: 54321, parentPid: 43210, creationTicks: 200 },
      { pid: 43210, parentPid: 10000, creationTicks: 100 },
      { pid: 10000, parentPid: 4, creationTicks: 50 },
    ]);
    parent.verifySpawnedPid = async (pid) => {
      // Represents native ancestry evidence for cmd -> managed Node launcher
      // -> Pi Node: intermediate shims are permitted, but this is the one
      // actual process PID returned by the authenticated child receipt.
      verified.push(pid);
      return isVerifiedWindowsAncestryEvidence(nestedEvidence, pid, 10000);
    };

    await writeSignedReceipt(parent, 67890, 1, true);
    await assert.rejects(awaitPiSettlementReceipt(parent, 0, 100), /signature is invalid/);
    assert.deepEqual(verified, [], "an unauthenticated PID must never reach the lineage validator");
    assert.equal(parent.pid, undefined, "bad HMAC must not bind a child PID");

    await writeSignedReceipt(parent, 67890, 1);
    assert.equal(await awaitPiSettlementReceipt(parent, 0, 100), 1);
    assert.deepEqual(verified, [67890]);
    assert.equal(parent.pid, 67890, "the verified actual Pi PID is bound after lineage proof");

    await writeSignedReceipt(parent, 67891, 2);
    await assert.rejects(awaitPiSettlementReceipt(parent, 1, 100), /does not match/);
    assert.deepEqual(verified, [67890], "later receipt PIDs use exact equality, not another lineage search");
    assert.equal(parent.pid, 67890);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cmd-root receipt rejects unrelated PIDs and lineage after the owned shell is no longer live", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-settlement-lineage-fail-"));
  try {
    for (const scenario of [
      { pid: 99887, liveRoot: true, name: "unrelated process" },
      { pid: 67890, liveRoot: false, name: "dead owned cmd root" },
    ]) {
      const parent = createPiSettlementBootstrap(root, `cmd-root-${scenario.name}`);
      parent.verifySpawnedPid = (pid) => scenario.liveRoot && pid === 67890;
      await writeSignedReceipt(parent, scenario.pid, 1);
      await assert.rejects(awaitPiSettlementReceipt(parent, 0, 100), /not a verified live descendant/,
        `${scenario.name} must fail closed`);
      assert.equal(parent.pid, undefined, `${scenario.name} must not bind a PID`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cmd-root receipt does not bind a PID whose stable parent was recycled after the child started", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-settlement-recycled-parent-"));
  try {
    const parent = createPiSettlementBootstrap(root, "cmd-root-recycled-parent");
    const recycledParentEvidence = windowsAncestryEvidence([
      { pid: 67890, parentPid: 54321, creationTicks: 100 },
      { pid: 54321, parentPid: 10000, creationTicks: 200 },
      { pid: 10000, parentPid: 4, creationTicks: 50 },
    ]);
    parent.verifySpawnedPid = (pid) => isVerifiedWindowsAncestryEvidence(recycledParentEvidence, pid, 10000);
    await writeSignedReceipt(parent, 67890, 1);

    await assert.rejects(awaitPiSettlementReceipt(parent, 0, 100), /not a verified live descendant/);
    assert.equal(parent.pid, undefined, "a recycled, newer parent must never bind the authenticated child's PID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});