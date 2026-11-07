import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import type { PeerHost } from "../src/session-host/network/peer-host";
import type { SessionContentHost } from "../src/session-host/network/session-content-host";
import type { RosterBridgeHost } from "../src/session-host/network/roster-bridge-host";
import { parseRemoteSessionMetadata, toRemoteSessionMetadata } from "../src/session-host/network/roster-metadata";
import { canonicalSpki, fixtureRows, HOST_COUNT, LABEL, parseOptions, validateReady, type ReadyRecord } from "./android-peer-fixture/multi-host-contract";
import { bounded, ConvergenceBarriers, listenOwned, RESOURCE_KINDS, ResourceLedger, settleCleanup, type ResourceKind } from "./android-peer-fixture/multi-host-barriers";
import { MultiHostSource } from "./android-peer-fixture/multi-host-source";

const key = (): string => generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
const options = { nonce: "0123456789abcdef", clientKeyId: key(), clientLabel: LABEL };
function manifest(): ReadyRecord {
 return { event: "ready", version: 1, ...options, listenHost: "127.0.0.1", hosts: Array.from({ length: HOST_COUNT }, (_, i) => ({
  hostId: randomUUID(), hostRunId: randomUUID(), hostKeyId: key(), hostLabel: LABEL, port: 30000 + i,
 })) };
}
test("closed ready contract: 64 unique exact-key peers, no fingerprints or extra fields", () => {
 const ready = manifest(); validateReady(ready, options);
 assert.ok(Buffer.byteLength(JSON.stringify(ready)) < 65536);
 const invalid: ((record: ReadyRecord) => void)[] = [
  (r) => { r.hosts.pop(); }, (r) => { r.hosts[1].hostId = r.hosts[0].hostId; },
  (r) => { r.hosts[0].hostRunId = r.hosts[1].hostId; }, (r) => { r.hosts[1].hostKeyId = r.hosts[0].hostKeyId; },
  (r) => { r.hosts[0].hostKeyId = options.clientKeyId; }, (r) => { r.hosts[1].port = r.hosts[0].port; },
  (r) => { r.hosts[0].port = 0; }, (r) => { r.hosts[0].hostLabel = "other"; },
  (r) => { Object.assign(r, { fingerprint: "not an SPKI" }); }, (r) => { Object.assign(r.hosts[0], { fingerprint: "extra" }); },
  (r) => { r.hosts[0].hostKeyId = "a".repeat(70000); },
 ];
 for (const mutate of invalid) { const copy = structuredClone(ready); mutate(copy); assert.throws(() => validateReady(copy, options)); }
 assert.throws(() => validateReady(ready, { ...options, nonce: "ffffffffffffffff" }));
 assert.throws(() => validateReady(null, options));
});
test("CLI admits only exact canonical base64 DER SPKI and settled label/nonce", () => {
 const args = ["--nonce", options.nonce, "--client-key-id", options.clientKeyId, "--client-label", LABEL];
 assert.deepEqual(parseOptions(args), options);
 for (const nonce of ["ABCDEF0123456789", "short", "0".repeat(17)]) assert.throws(() => parseOptions(["--nonce", nonce, ...args.slice(2)]));
 assert.throws(() => parseOptions([...args, "--port", "0"]));
 assert.throws(() => parseOptions([...args, "--nonce", options.nonce]));
 assert.throws(() => parseOptions(args.slice(0, -1)));
 assert.throws(() => parseOptions([...args.slice(0, -1), "other"]));
 for (const invalid of [options.clientKeyId + "\n", options.clientKeyId.replace(/=+$/, ""), "sha256:123", Buffer.from("garbage").toString("base64")]) {
  assert.equal(canonicalSpki(invalid), false);
 }
});
test("all 64 row matrices survive the real metadata projection with null distinct from zero", () => {
 const hostId = randomUUID(); const runId = randomUUID();
 for (let i = 0; i < HOST_COUNT; i++) {
  const rows = fixtureRows(i, hostId, runId).map((row) => toRemoteSessionMetadata(row, { rosterSlotId: true }));
  for (const row of rows) assert.deepEqual(parseRemoteSessionMetadata(row), row);
  const [live, exited] = rows; const even = i % 2 === 0;
  assert.equal(live.id, "shared-live"); assert.equal(live.label, `fixture-live-${i + 1}`); assert.equal(live.workspace, `/synthetic/host-${i + 1}`);
  assert.equal(live.lifecycle, "alive"); assert.equal(live.hasLiveProcess, true); assert.equal(live.inputSurface, true);
  assert.equal(live.busy, [true, false, null][i % 3]); assert.equal(live.pendingInput, [false, null, true][i % 3]);
  assert.deepEqual(live.activity, [`synthetic activity ${i + 1}`, "synthetic detail"]);
  assert.equal(live.rosterSlotId, even ? hostId : undefined);
  assert.deepEqual(live.nativeSession, even ? { sessionId: runId, epoch: 1, name: `Native ${i + 1}`, persistence: "saved" } : null);
  assert.equal(live.backgroundTasks, even ? 0 : null); assert.equal(live.backgroundShells, even ? 3 : null);
  assert.equal(live.activeTasks, even ? 2 : null); assert.equal(live.activeShells, even ? 0 : null);
  assert.deepEqual(exited, { id: "shared-exited", label: `fixture-exited-${i + 1}`, workspace: `/synthetic/host-${i + 1}`,
   lifecycle: "exited", hasLiveProcess: false, inputSurface: false, nativeSession: null, busy: null, pendingInput: null,
   backgroundTasks: null, backgroundShells: null, activeTasks: null, activeShells: null, activity: [], exitCode: 0, error: "Synthetic exit" });
 }
});
const APP = RESOURCE_KINDS.filter((k) => k.startsWith("app") || k === "inventoryWatch");
const CONTENT = RESOURCE_KINDS.filter((k) => !APP.includes(k));
function acquire(ledger: ResourceLedger, kinds: readonly ResourceKind[], id: string): void { for (const kind of kinds) ledger.acquire(kind, `${id}:${kind}`, id); }
function release(ledger: ResourceLedger, kinds: readonly ResourceKind[], id: string): void { for (const kind of kinds) ledger.release(kind, `${id}:${kind}`); }
function graph() {
 const ids = Array.from({ length: HOST_COUNT }, () => randomUUID());
 let barrier: ConvergenceBarriers | undefined;
 const ledger = new ResourceLedger((event) => barrier?.resourceChanged(event));
 barrier = new ConvergenceBarriers(ids, ledger);
 return { ids, ledger, barrier };
}
test("revision 2 requires 64 actual APP channels, subscriptions, handlers and inventory watches", () => {
 const { ids, ledger, barrier } = graph();
 for (const id of ids.slice(0, -1)) acquire(ledger, APP, id);
 assert.deepEqual(barrier.advance(() => true), []);
 acquire(ledger, APP.filter((k) => k !== "inventoryWatch"), ids[63]);
 assert.deepEqual(barrier.advance(() => true), []);
 acquire(ledger, ["inventoryWatch"], ids[63]);
 assert.deepEqual(barrier.advance(() => true), [{ phase: "roster-2" }]);
 assert.deepEqual(barrier.advance(() => true), []);
});
test("all independent preceding CONTENT resources must positively retire; overlap is recorded, not hidden", () => {
 const { ids, ledger, barrier } = graph(); for (const id of ids) acquire(ledger, APP, id);
 barrier.advance(() => true); acquire(ledger, CONTENT, ids[0]);
 assert.deepEqual(barrier.advance(() => false), []);
 assert.deepEqual(barrier.advance(() => true), [{ phase: "stable", hostId: ids[0] }]);
 acquire(ledger, CONTENT, ids[1]);
 assert.deepEqual(barrier.advance(() => true), []);
 release(ledger, ["contentChannel", "contentSubscription", "contentWatch", "viewer", "contentHandler"], ids[0]);
 assert.deepEqual(barrier.advance(() => true), [], "channel closure alone never proves binding retirement");
 release(ledger, ["contentBinding"], ids[0]);
 assert.deepEqual(barrier.advance(() => true), [{ phase: "stable", hostId: ids[1] }]);
 assert.deepEqual(ledger.counters().contentBinding, { current: 1, acquired: 2, released: 1, peak: 2 });
});
test("each retained watch/viewer/handler/subscription independently blocks a stable successor", () => {
 for (const retained of CONTENT) {
  const { ids, ledger, barrier } = graph(); for (const id of ids) acquire(ledger, APP, id);
  barrier.advance(() => true); acquire(ledger, CONTENT, ids[0]); barrier.advance(() => true);
  acquire(ledger, CONTENT, ids[1]); release(ledger, CONTENT.filter((kind) => kind !== retained), ids[0]);
  assert.deepEqual(barrier.advance(() => true), [], retained);
  release(ledger, [retained], ids[0]); assert.deepEqual(barrier.advance(() => true), [{ phase: "stable", hostId: ids[1] }]);
 }
});
test("64 selections, final positive retirement, revision 3 and client-owned cleanup are separate gates", () => {
 const { ids, ledger, barrier } = graph(); for (const id of ids) acquire(ledger, APP, id); barrier.advance(() => true);
 for (const id of ids) {
  acquire(ledger, CONTENT, id); assert.deepEqual(barrier.advance(() => true), [{ phase: "stable", hostId: id }]);
  release(ledger, CONTENT, id);
  assert.deepEqual(barrier.advance(() => true), id === ids[63] ? [{ phase: "roster-3" }] : []);
 }
 assert.ok(barrier.clientCleanupProblems().some((p) => p.includes("remain before listener stop")));
 for (const id of ids) release(ledger, APP, id);
 assert.deepEqual(barrier.clientCleanupProblems(), []);
 assert.equal(ledger.empty, true);
 for (const count of Object.values(ledger.counters())) assert.equal(count.released, HOST_COUNT);
 assert.throws(() => release(ledger, ["viewer"], ids[0]));
});
test("APP loss and out-of-order targets fail closed instead of publishing a stable marker", () => {
 const a = graph(); for (const id of a.ids) acquire(a.ledger, APP, id); a.barrier.advance(() => true);
 release(a.ledger, ["inventoryWatch"], a.ids[0]); acquire(a.ledger, CONTENT, a.ids[0]);
 assert.deepEqual(a.barrier.advance(() => true), []); assert.ok(a.barrier.problems.size > 0);
 const b = graph(); for (const id of b.ids) acquire(b.ledger, APP, id); b.barrier.advance(() => true);
 acquire(b.ledger, CONTENT, b.ids[1]); assert.deepEqual(b.barrier.advance(() => true), []); assert.ok(b.barrier.problems.size > 0);
});
test("even a same-turn APP retirement/replacement cannot conceal broken continuity", () => {
 const { ids, ledger, barrier } = graph(); for (const id of ids) acquire(ledger, APP, id); barrier.advance(() => true);
 release(ledger, ["inventoryWatch"], ids[0]); acquire(ledger, ["inventoryWatch"], ids[0]);
 acquire(ledger, CONTENT, ids[0]); assert.deepEqual(barrier.advance(() => true), []);
 assert.ok(barrier.problems.has("APP resource retired before post-leave revision 3"));
});
test("source implements real viewer revisions, requested geometry and positively owned release", () => {
 const ledger = new ResourceLedger(); const source = new MultiHostSource(0, randomUUID(), randomUUID(), ledger, () => {});
 let inventoryNotifications = 0; const inventory = source.watchInventory(() => { inventoryNotifications++; });
 const snapshots: string[] = []; const watch = source.watchSessionContent("shared-live", (s) => { if (s) snapshots.push(s.frame.lines[0]); })!;
 assert.equal(source.watchSessionContent("shared-exited", () => {}), undefined);
 assert.equal(source.openViewer({}), undefined, "no clipboard or input authority");
 const viewer = source.openViewer()!;
 assert.equal(source.viewportReady(), false);
 assert.ok(!watch.snapshot.frame.lines[0].includes("stable:"));
 assert.equal(source.updateViewer(viewer.viewerId, { sessionId: "shared-live", cols: 79, rows: 24 }).applied, true);
 assert.equal(source.viewportReady(), false, "a source default never substitutes for the actual requested viewport");
 const prior = source.readViewer(viewer.viewerId)!;
 assert.deepEqual(source.updateViewer(viewer.viewerId, { sessionId: "shared-live", cols: 100, rows: 31, expectedRevision: 0 }), { applied: false, reason: "stale" });
 const updated = source.updateViewer(viewer.viewerId, { sessionId: "shared-live", cols: 100, rows: 31, expectedRevision: prior.revision });
 assert.equal(updated.applied, true); assert.equal(source.viewportReady(), true);
 const current = source.readViewer(viewer.viewerId)!; assert.equal(current.revision, prior.revision + 1);
 const measured = source.watchSessionContent("shared-live", () => {})!;
 assert.equal(measured.snapshot.geometry.cols, 100); assert.equal(measured.snapshot.geometry.rows, 31);
 assert.equal(measured.snapshot.frame.lines.length, 31); measured.unsubscribe();
 source.publishStable(options.nonce); assert.ok(snapshots.at(-1)!.includes(`stable:${options.nonce}:${source.hostId}`));
 assert.deepEqual(source.updateViewer(viewer.viewerId, { expectedRevision: current.revision, sessionId: "shared-exited" }), { applied: false, reason: "unknown-session" });
 assert.deepEqual(source.updateViewer(viewer.viewerId, { cols: -1 }), { applied: false, reason: "invalid-geometry" });
 assert.equal(source.closeViewer(viewer.viewerId), true); assert.equal(source.closeViewer(viewer.viewerId), false);
 assert.equal(source.readViewer(viewer.viewerId), undefined);
 assert.deepEqual(source.updateViewer(viewer.viewerId), { applied: false, reason: "unknown-viewer" });
 watch.unsubscribe(); watch.unsubscribe(); const before = snapshots.length; source.publishStable(options.nonce); assert.equal(snapshots.length, before);
 source.publishRoster(2); assert.equal(inventoryNotifications, 1); inventory.unsubscribe(); inventory.unsubscribe();
 source.publishRoster(3); assert.equal(inventoryNotifications, 1); assert.equal(ledger.empty, true);
 assert.equal(ledger.counters().contentWatch.acquired, 2); assert.equal(ledger.counters().contentWatch.released, 2);
});
test("partial bind failure retains the failing listener in ownership and attempts every normal close", async () => {
 const owned: { peer: Pick<PeerHost, "listen" | "close"> }[] = []; const closed: number[] = [];
 const peer = (index: number, fail: boolean): { peer: Pick<PeerHost, "listen" | "close"> } => ({ peer: {
  listen: async (address) => { assert.deepEqual(address, { host: "127.0.0.1", port: 0 }); if (fail) throw new Error("bind failed"); return { host: "127.0.0.1", port: 31000 + index }; },
  close: async () => { closed.push(index); },
 } });
 await listenOwned(owned, peer(0, false)); await assert.rejects(listenOwned(owned, peer(1, true)));
 assert.equal(owned.length, 2); assert.deepEqual(await settleCleanup(owned.map((h) => () => h.peer.close()), 50), []);
 assert.deepEqual(closed.sort(), [0, 1]);
});
test("rejected and nonsettling cleanup stay uncertain; all independent siblings are attempted", async () => {
 const attempted: number[] = [];
 const content: Pick<SessionContentHost, "stopAll"> = { stopAll: async () => { attempted.push(0); throw new Error("unconfirmed content retirement"); } };
 const roster: Pick<RosterBridgeHost, "stopAll"> = { stopAll: async () => { attempted.push(1); } };
 const listener: Pick<PeerHost, "close"> = { close: () => { attempted.push(2); return new Promise<void>(() => {}); } };
 const result = await settleCleanup([() => content.stopAll(), () => roster.stopAll(), () => listener.close()], 10);
 assert.deepEqual(attempted, [0, 1, 2]); assert.deepEqual(result, ["cleanup 0 failed or uncertain", "cleanup 2 failed or uncertain"]);
 await assert.rejects(bounded(new Promise<void>(() => {}), 5, "phase"), /phase deadline exceeded/);
});
