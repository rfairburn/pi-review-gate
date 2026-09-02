import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, atomicWriteExclusive } from "./durable-write";

export interface WaveOwnerLease {
  version: 1;
  waveId: string;
  instanceId: string;
  hostPid: number;
  acquiredAt: string;
  heartbeatAt: string;
  status: "active" | "released";
  releasedAt?: string;
}

export interface WaveOwnershipStatus {
  status: "live" | "dead" | "released" | "uncertain";
  processAlive: boolean;
  lease?: WaveOwnerLease;
  message: string;
}

export function waveOwnerPath(waveRoot: string): string {
  return join(waveRoot, "wave-owner.json");
}

export async function acquireWaveOwner(waveRoot: string, waveId: string): Promise<WaveOwnerLease> {
  const now = new Date().toISOString();
  const lease: WaveOwnerLease = {
    version: 1,
    waveId,
    instanceId: randomUUID(),
    hostPid: process.pid,
    acquiredAt: now,
    heartbeatAt: now,
    status: "active",
  };
  const path = waveOwnerPath(waveRoot);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      // Durable exclusive publication: EEXIST preserves the atomic claim
      // semantics; readers never see a partially written lease, and a failure
      // before publication leaves no final record behind so a later claim
      // attempt is not blocked by a corrupt one.
      await atomicWriteExclusive(path, `${JSON.stringify(lease, null, 2)}\n`);
      return lease;
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      const current = await inspectWaveOwner(waveRoot);
      if (current.processAlive) throw new Error(`Cannot acquire wave ownership: ${current.message}`);
      await unlink(path).catch((unlinkError) => {
        const unlinkCode = typeof unlinkError === "object" && unlinkError !== null && "code" in unlinkError ? String(unlinkError.code) : "";
        if (unlinkCode !== "ENOENT") throw unlinkError;
      });
    }
  }
  throw new Error("Cannot acquire wave ownership after concurrent claim attempts.");
}

export async function heartbeatWaveOwner(waveRoot: string, lease: WaveOwnerLease): Promise<void> {
  if (lease.status !== "active") return;
  lease.heartbeatAt = new Date().toISOString();
  await writeWaveOwner(waveRoot, lease);
}

export async function releaseWaveOwner(waveRoot: string, lease: WaveOwnerLease): Promise<void> {
  lease.status = "released";
  lease.releasedAt = new Date().toISOString();
  lease.heartbeatAt = lease.releasedAt;
  await writeWaveOwner(waveRoot, lease);
}

export async function inspectWaveOwner(waveRoot: string): Promise<WaveOwnershipStatus> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(waveOwnerPath(waveRoot), "utf8"));
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    return code === "ENOENT"
      ? { status: "uncertain", processAlive: true, message: "No durable wave ownership lease exists; concurrent mutation cannot be excluded." }
      : { status: "uncertain", processAlive: true, message: `Wave ownership could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isWaveOwnerLease(parsed)) {
    return { status: "uncertain", processAlive: true, message: "The durable wave ownership lease is invalid." };
  }
  if (parsed.status === "released") {
    return { status: "released", processAlive: false, lease: parsed, message: "The wave controller released ownership." };
  }
  const processStatus = pidStatus(parsed.hostPid);
  return processStatus === "live"
    ? { status: "live", processAlive: true, lease: parsed, message: `Wave controller process ${parsed.hostPid} may still be mutating wave state.` }
    : processStatus === "dead"
      ? { status: "dead", processAlive: false, lease: parsed, message: "The recorded wave controller process is no longer alive." }
      : { status: "uncertain", processAlive: true, lease: parsed, message: "Wave controller liveness could not be proven; mutation remains blocked." };
}

async function writeWaveOwner(waveRoot: string, lease: WaveOwnerLease): Promise<void> {
  await atomicWrite(waveOwnerPath(waveRoot), `${JSON.stringify(lease, null, 2)}\n`);
}

function isWaveOwnerLease(value: unknown): value is WaveOwnerLease {
  if (!value || typeof value !== "object") return false;
  const lease = value as Partial<WaveOwnerLease>;
  return lease.version === 1
    && typeof lease.waveId === "string"
    && typeof lease.instanceId === "string"
    && typeof lease.hostPid === "number"
    && typeof lease.acquiredAt === "string"
    && typeof lease.heartbeatAt === "string"
    && (lease.status === "active" || lease.status === "released");
}

function pidStatus(pid: number): "live" | "dead" | "uncertain" {
  if (!Number.isInteger(pid) || pid <= 0) return "uncertain";
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "live";
    return "uncertain";
  }
}
