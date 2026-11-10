import { createPublicKey } from "node:crypto";
import { isBoundedPeerKeyId } from "../../src/session-host/network/protocol";
import type { OwningHostInventoryRow } from "../../src/session-host/owning-host-service";

export const HOST_COUNT = 64;
export const LABEL = "Pi Review Gate";
export const MAX_RECORD_BYTES = 64 * 1024;
export interface MultiHostOptions { nonce: string; clientKeyId: string; clientLabel: string }
export interface HostDescriptor { hostId: string; hostRunId: string; hostKeyId: string; hostLabel: string; port: number }
export interface ReadyRecord extends MultiHostOptions {
 event: "ready"; version: 1; listenHost: "127.0.0.1"; hosts: HostDescriptor[];
}
export function canonicalSpki(value: unknown): value is string {
 if (!isBoundedPeerKeyId(value) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
 try {
  const der = Buffer.from(value, "base64");
  return der.toString("base64") === value && createPublicKey({ key: der, format: "der", type: "spki" })
   .export({ format: "der", type: "spki" }).toString("base64") === value;
 } catch { return false; }
}
export function validateOptions(options: MultiHostOptions): void {
 if (!/^[0-9a-f]{16}$/.test(options.nonce)) throw new Error("nonce must be exactly 16 lowercase hex digits");
 if (!canonicalSpki(options.clientKeyId)) throw new Error("client key must be canonical base64 DER SPKI");
 if (options.clientLabel !== LABEL) throw new Error("client label must be Pi Review Gate");
}
export function parseOptions(args: readonly string[]): MultiHostOptions {
 const values = new Map<string, string>();
 for (let i = 0; i < args.length; i += 2) {
  const name = args[i]; const value = args[i + 1];
  if (!["--nonce", "--client-key-id", "--client-label"].includes(name) || value === undefined || values.has(name)) {
   throw new Error("expected exactly --nonce, --client-key-id and --client-label");
  }
  values.set(name, value);
 }
 const result = { nonce: values.get("--nonce") ?? "", clientKeyId: values.get("--client-key-id") ?? "", clientLabel: values.get("--client-label") ?? "" };
 validateOptions(result); return result;
}
function exactKeys(value: object, keys: string[]): boolean {
 return Object.keys(value).sort().join(",") === keys.sort().join(",");
}
export function validateReady(value: unknown, expected: MultiHostOptions): asserts value is ReadyRecord {
 validateOptions(expected);
 if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid ready object");
 const record = value as ReadyRecord;
 if (Buffer.byteLength(JSON.stringify(value), "utf8") + 1 > MAX_RECORD_BYTES ||
  !exactKeys(value, ["event", "version", "nonce", "clientKeyId", "clientLabel", "listenHost", "hosts"]) ||
  record.event !== "ready" || record.version !== 1 || record.listenHost !== "127.0.0.1" ||
  record.nonce !== expected.nonce || record.clientKeyId !== expected.clientKeyId || record.clientLabel !== expected.clientLabel ||
  !Array.isArray(record.hosts) || record.hosts.length !== HOST_COUNT) throw new Error("invalid ready contract");
 const uuids = new Set<string>(); const keys = new Set<string>([expected.clientKeyId]); const ports = new Set<number>();
 for (const host of record.hosts) {
  if (typeof host !== "object" || host === null || !exactKeys(host, ["hostId", "hostRunId", "hostKeyId", "hostLabel", "port"]) ||
   host.hostLabel !== LABEL || !canonicalSpki(host.hostKeyId) || keys.has(host.hostKeyId) ||
   !Number.isInteger(host.port) || host.port < 1 || host.port > 65535 || ports.has(host.port)) throw new Error("invalid host descriptor");
  for (const id of [host.hostId, host.hostRunId]) {
   if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) || uuids.has(id)) throw new Error("invalid or duplicate UUID");
   uuids.add(id);
  }
  keys.add(host.hostKeyId); ports.add(host.port);
 }
}
export function fixtureRows(index: number, hostId: string, hostRunId: string): readonly OwningHostInventoryRow[] {
 if (!Number.isInteger(index) || index < 0 || index >= HOST_COUNT) throw new Error("invalid host index");
 const k = index + 1; const even = index % 2 === 0;
 return [
  { id: "shared-live", label: `fixture-live-${k}`, workspace: `/synthetic/host-${k}`, agentDir: "", lifecycle: "alive",
   hasLiveProcess: true, inputSurface: true, busy: [true, false, null][index % 3], pendingInput: [false, null, true][index % 3],
   ...(even ? { rosterSlotId: hostId } : {}),
   nativeSession: even ? { sessionId: hostRunId, epoch: 1, name: `Native ${k}`, persistence: "saved" } : null,
   activity: [`synthetic activity ${k}`, "synthetic detail"], backgroundTasks: even ? 0 : null, backgroundShells: even ? 3 : null,
   activeTasks: even ? 2 : null, activeShells: even ? 0 : null },
  { id: "shared-exited", label: `fixture-exited-${k}`, workspace: `/synthetic/host-${k}`, agentDir: "", lifecycle: "exited",
   hasLiveProcess: false, inputSurface: false, exitCode: 0, error: "Synthetic exit", nativeSession: null,
   busy: null, pendingInput: null, backgroundTasks: null, backgroundShells: null, activeTasks: null, activeShells: null, activity: [] },
 ];
}
