import type { PeerHost } from "../../src/session-host/network/peer-host";
import { HOST_COUNT } from "./multi-host-contract";

export const RESOURCE_KINDS = ["appChannel", "appBinding", "appSubscription", "inventoryWatch", "contentChannel", "contentBinding", "contentSubscription", "contentWatch", "viewer", "appHandler", "contentHandler"] as const;
export type ResourceKind = typeof RESOURCE_KINDS[number];
interface Counter { current: number; acquired: number; released: number; peak: number }
/** Each acquisition has a distinct token; releases are recorded only by the owner that confirms them. */
export class ResourceLedger {
 private readonly live = new Map<ResourceKind, Map<string, string>>();
 private readonly totals = new Map<ResourceKind, Counter>();
 constructor(private readonly changed: (event: { kind: ResourceKind; acquired: boolean }) => void = () => {}) {
  for (const kind of RESOURCE_KINDS) { this.live.set(kind, new Map()); this.totals.set(kind, { current: 0, acquired: 0, released: 0, peak: 0 }); }
 }
 acquire(kind: ResourceKind, token: string, hostId: string): void {
  const entries = this.live.get(kind)!; if (entries.has(token)) throw new Error("duplicate resource acquisition");
  entries.set(token, hostId); const count = this.totals.get(kind)!;
  count.current++; count.acquired++; count.peak = Math.max(count.peak, count.current); this.changed({ kind, acquired: true });
 }
 release(kind: ResourceKind, token: string): void {
  if (!this.live.get(kind)!.delete(token)) throw new Error("unconfirmed or duplicate resource release");
  const count = this.totals.get(kind)!; count.current--; count.released++; this.changed({ kind, acquired: false });
 }
 count(kind: ResourceKind): number { return this.live.get(kind)!.size; }
 hosts(kind: ResourceKind): string[] { return [...this.live.get(kind)!.values()]; }
 counters(): Record<ResourceKind, Counter> { return Object.fromEntries([...this.totals].map(([k, v]) => [k, { ...v }])) as Record<ResourceKind, Counter>; }
 get empty(): boolean { return RESOURCE_KINDS.every((kind) => this.count(kind) === 0); }
}
export type BarrierAction = { phase: "roster-2" | "roster-3" } | { phase: "stable"; hostId: string };
const APP = ["appChannel", "appBinding", "appSubscription", "inventoryWatch", "appHandler"] as const;
const CONTENT = ["contentChannel", "contentBinding", "contentSubscription", "contentWatch", "viewer", "contentHandler"] as const;
/** Invoked after protocol/source events, never from a timer or polling loop. */
export class ConvergenceBarriers {
 revision: 1 | 2 | 3 = 1;
 readonly selected: string[] = [];
 readonly problems = new Set<string>();
 constructor(readonly hostIds: readonly string[], readonly ledger: ResourceLedger) {
  if (hostIds.length !== HOST_COUNT || new Set(hostIds).size !== HOST_COUNT) throw new Error("expected 64 distinct hosts");
 }
 fail(problem: string): void { this.problems.add(problem); }
 resourceChanged(event: { kind: ResourceKind; acquired: boolean }): void {
  if (this.revision === 2 && !event.acquired && (APP as readonly ResourceKind[]).includes(event.kind)) {
   this.fail("APP resource retired before post-leave revision 3");
  }
 }
 private appContinuous(): boolean {
  return APP.every((kind) => {
   const ids = this.ledger.hosts(kind);
   return ids.length === HOST_COUNT && new Set(ids).size === HOST_COUNT && this.hostIds.every((id) => ids.includes(id));
  });
 }
 advance(viewportReady: (hostId: string) => boolean): BarrierAction[] {
  const actions: BarrierAction[] = [];
  const app = this.appContinuous();
  if (this.revision === 2 && !app) this.fail("APP continuity lost before post-leave revision 3");
  if (this.problems.size > 0) return actions;
  if (this.revision === 1 && app) { this.revision = 2; actions.push({ phase: "roster-2" }); }
  if (this.revision !== 2) return actions;
  const counters = this.ledger.counters();
  if (CONTENT.every((kind) => counters[kind].current === 0) && this.selected.length === HOST_COUNT) {
   if (CONTENT.every((kind) => counters[kind].acquired === HOST_COUNT && counters[kind].released === HOST_COUNT)) {
    this.revision = 3; actions.push({ phase: "roster-3" });
   } else this.fail("CONTENT lifetime totals differ from traversal");
   return actions;
  }
  if (!CONTENT.every((kind) => counters[kind].current === 1)) return actions;
  const hostId = this.ledger.hosts("contentChannel")[0];
  if (!CONTENT.every((kind) => this.ledger.hosts(kind)[0] === hostId)) return actions;
  if (this.selected.includes(hostId)) return actions;
  if (hostId !== this.hostIds[this.selected.length]) { this.fail("CONTENT traversal is not manifest order"); return actions; }
  if (!CONTENT.every((kind) => counters[kind].acquired === this.selected.length + 1 && counters[kind].released === this.selected.length)) return actions;
  if (!viewportReady(hostId)) return actions;
  this.selected.push(hostId); actions.push({ phase: "stable", hostId }); return actions;
 }
 clientCleanupProblems(): string[] {
  const issues = [...this.problems];
  if (this.revision !== 3 || this.selected.length !== HOST_COUNT) issues.push("64 selections and post-leave revision 3 not completed");
  if (!this.ledger.empty) issues.push("client-owned resources remain before listener stop");
  for (const [kind, count] of Object.entries(this.ledger.counters())) {
   if (count.acquired !== HOST_COUNT || count.released !== HOST_COUNT) issues.push(`${kind} did not acquire and positively retire exactly 64 resources`);
  }
  return issues;
 }
}
/** Deadline races do not cancel operations or pretend their ownership disappeared. */
export async function bounded<T>(operation: Promise<T>, milliseconds: number, name: string): Promise<T> {
 let timer: ReturnType<typeof setTimeout> | undefined;
 try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${name} deadline exceeded`)), milliseconds); })]); }
 finally { clearTimeout(timer); }
}
/** Register ownership BEFORE binding, including the listener whose partial bind may reject. */
export async function listenOwned<T extends { peer: Pick<PeerHost, "listen"> }>(owned: T[], host: T): Promise<{ host: string; port: number }> {
 owned.push(host);
 return host.peer.listen({ host: "127.0.0.1", port: 0 });
}
/** Attempt every independently owned cleanup even if another rejects. */
export async function settleCleanup(operations: readonly (() => Promise<void>)[], milliseconds: number): Promise<string[]> {
 return Promise.all(operations.map(async (operation, index) => {
  try { await bounded(Promise.resolve().then(operation), milliseconds, "cleanup"); return ""; }
  catch { return `cleanup ${index} failed or uncertain`; }
 })).then((results) => results.filter(Boolean));
}
