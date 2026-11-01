/** Main's owner provider with a synthetic manager; no native child or network. */
import assert from "node:assert/strict";
import test from "node:test";
import type { OwnerRenameRequest } from "../src/session-host/network/peer-rename";
import {
  closeWithSignal, fillForm, nextTurn, peerMainHarness,
} from "./helpers/session-host-main-harness";

test("Main owner rename uses the existing manager seam without activation or recreation", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  t.after(async () => { await closeWithSignal(harness); });
  fillForm(harness.terminal, "/synthetic/rename-workspace");
  await nextTurn();
  const manager = harness.manager!;
  const original = manager.views[0]!;
  const provider = peer.options?.renameOwnedSession;
  assert.ok(provider);
  const watch = peer.options!.inventory.watchInventory(() => undefined)!;
  const hostRunId = watch.snapshot.hostRunId;
  watch.unsubscribe();
  const request: OwnerRenameRequest = {
    hostRunId, rowId: original.id,
    expectedSessionId: original.nativeSession!.sessionId,
    expectedSessionEpoch: original.nativeSession!.epoch,
    name: "Owner confirmed name",
  };
  const focus = harness.sidebar!.focus;
  const creates = manager.createOptions.length;
  assert.deepEqual(await provider(request, () => true), { kind: "renamed" });
  assert.equal(manager.views[0]!.nativeSession!.name, request.name);
  assert.equal(manager.views[0]!.workspace, original.workspace);
  assert.equal(manager.views[0]!.nativeSession!.sessionId, request.expectedSessionId);
  assert.equal(manager.views[0]!.nativeSession!.epoch, request.expectedSessionEpoch);
  assert.equal(manager.createOptions.length, creates);
  assert.deepEqual(manager.writes, []);
  assert.equal(harness.sidebar!.focus, focus);
  assert.equal(manager.renameCalls.length, 1);

  for (const refused of [
    { ...request, hostRunId: "another-run" },
    { ...request, rowId: "another-row" },
  ]) assert.deepEqual(await provider(refused, () => true), { kind: "refused" });
  assert.deepEqual(await provider(request, () => false), { kind: "refused" });
  assert.deepEqual(await provider(request, () => { throw new Error("synthetic unavailable grant"); }), { kind: "refused" });
  assert.deepEqual(await provider({ ...request, expectedSessionEpoch: request.expectedSessionEpoch + 1 }, () => true),
    { kind: "stale-session" });
  assert.deepEqual(await provider({ ...request, expectedSessionId: "replaced-conversation" }, () => true),
    { kind: "stale-session" });
  assert.equal(manager.renameCalls.length, 1, "preflight refusals never enter the manager");
  assert.equal(manager.views[0]!.nativeSession!.name, request.name);
});

test("Main owner rename reports uncertainty after an invoked failure or replaced native identity", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  t.after(async () => { await closeWithSignal(harness); });
  fillForm(harness.terminal, "/synthetic/rename-workspace");
  await nextTurn();
  const manager = harness.manager!;
  const original = manager.views[0]!;
  const provider = peer.options!.renameOwnedSession!;
  const watch = peer.options!.inventory.watchInventory(() => undefined)!;
  const request: OwnerRenameRequest = {
    hostRunId: watch.snapshot.hostRunId, rowId: original.id,
    expectedSessionId: original.nativeSession!.sessionId,
    expectedSessionEpoch: original.nativeSession!.epoch,
    name: "Unconfirmed name",
  };
  watch.unsubscribe();
  manager.renameError = true;
  assert.deepEqual(await provider(request, () => true), { kind: "unknown" });
  manager.renameError = false;
  let release!: () => void;
  let entered!: () => void;
  const admission = new Promise<void>((resolve) => { entered = resolve; });
  manager.renameGate = new Promise<void>((resolve) => { release = resolve; });
  manager.renameGateEntered = entered;
  const pending = provider(request, () => true);
  await admission;
  manager.views[0] = { ...original, nativeSession: { ...original.nativeSession!, epoch: request.expectedSessionEpoch + 1 } };
  manager.onChange?.(original.id);
  release();
  assert.deepEqual(await pending, { kind: "unknown" }, "post-invocation stale is not a no-op claim");
  assert.equal(manager.views[0]!.nativeSession!.name, original.nativeSession!.name);
  assert.equal(manager.renameCalls.length, 2, "no automatic replay after uncertainty");
});
