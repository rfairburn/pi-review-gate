import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireWaveOwner,
  heartbeatWaveOwner,
  inspectWaveOwner,
  releaseWaveOwner,
} from "../src/execution/wave-owner";

test("wave ownership distinguishes a live controller, release, and confirmed host death", async () => {
  const waveRoot = await mkdtemp(join(tmpdir(), "wave-owner-"));
  try {
    const lease = await acquireWaveOwner(waveRoot, "wave-owner-test");
    assert.equal((await inspectWaveOwner(waveRoot)).status, "live");

    await releaseWaveOwner(waveRoot, lease);
    assert.equal((await inspectWaveOwner(waveRoot)).status, "released");

    lease.status = "active";
    lease.releasedAt = undefined;
    lease.hostPid = 2_147_483_647;
    await heartbeatWaveOwner(waveRoot, lease);
    assert.equal((await inspectWaveOwner(waveRoot)).status, "dead");
  } finally {
    await rm(waveRoot, { recursive: true, force: true });
  }
});
