/**
 * Production Main/sidebar -> paired TLS coordinator -> owner Main rename ->
 * canonical roster metadata. Sessions/PTYS are synthetic FakeManagers; this is
 * not a native Pi-child, cross-machine, Windows, or operator acceptance test.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createPeerCoordinator } from "../src/session-host/network/peer-coordinator";
import { createPosixTestPolicy } from "./session-host-network-peer-state-fixtures";
import { createSnapshotLog, type SnapshotLog } from "./session-host-network-peer-coordinator-helpers";
import {
  ALT_LEFT, ENTER, closeWithSignal, createHarness, fillForm, nextTurn, plain, ready,
  selectedRosterHostLine, type Harness,
} from "./helpers/session-host-main-harness";

type Side = { harness: Harness; coordinator: ReturnType<typeof createPeerCoordinator>; log: SnapshotLog };

async function mainSide(t: TestContext, name: string, passed: () => boolean, supportsRename = true): Promise<Side> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `prg-rename-${name}-`)));
  chmodSync(root, 0o700);
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { mode: 0o700 });
  writeFileSync(join(agentDir, "keybindings.json"), "{}", { mode: 0o600 });
  const log = createSnapshotLog();
  let coordinator!: ReturnType<typeof createPeerCoordinator>;
  const harness = createHarness({}, {
    createSessionSetup: () => ({ nativeSetup: true, nativeAgentDir: agentDir,
      profileRegistry: { prepare: () => { throw new Error("synthetic manager does not prepare profiles"); } } }),
    openHostState: ({ hostId }) => ({ status: "opened", state: {
      agentDir, hostId, ownershipPath: join(agentDir, "synthetic-owner"), roster: undefined, problem: undefined,
      persist: () => true, release: () => true,
    } }),
    createPeerCoordinator: (options) => {
      coordinator = createPeerCoordinator({ ...options,
        ...(supportsRename ? {} : { renameOwnedSession: undefined }),
        testHooks: { preferencesPermissions: createPosixTestPolicy(), peerStatePermissions: createPosixTestPolicy() },
        onChange: (snapshot) => { options.onChange(snapshot); log.onChange(snapshot); },
      });
      return coordinator;
    },
  });
  t.after(async () => {
    const status = await closeWithSignal(harness);
    assert.equal(status, 0, "owned Main and network resources settled");
    if (passed()) rmSync(root, { recursive: true });
    else t.diagnostic(`rename fixture evidence retained at ${root}`);
  });
  await ready(harness);
  await log.waitFor((snapshot) => snapshot.status === "ready", `${name} coordinator startup`);
  return { harness, coordinator, log };
}

async function createRow(side: Side, name: string): Promise<void> {
  if (side.harness.sidebar!.focus === "main") side.harness.terminal.emitInput(ALT_LEFT);
  for (let step = 0; step < 16; step++) {
    if (plain(side.harness.writer.frames.at(-1)?.frame).split("\n").some((line) => line.startsWith("> New session"))) break;
    side.harness.terminal.emitInput("\x1b[A");
    await nextTurn();
  }
  assert.ok(plain(side.harness.writer.frames.at(-1)?.frame).includes("> New session"), "ordinary Up navigation highlighted New");
  const previousCount = side.harness.manager!.views.length;
  fillForm(side.harness.terminal, `/synthetic/workspace-${name.replace(/ /g, "-")}`);
  await nextTurn();
  const manager = side.harness.manager!;
  assert.equal(manager.views.length, previousCount + 1, "New created exactly one synthetic session");
  const index = manager.views.length - 1;
  const row = manager.views[index]!;
  assert.ok(row.nativeSession);
  manager.views[index] = { ...row, label: name, nativeSession: { ...row.nativeSession, name } };
  manager.onChange?.(row.id);
  await nextTurn();
}

async function listen(side: Side): Promise<number> {
  await side.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
  const state = side.coordinator.read().listener;
  assert.equal(state.state, "listening", state.message ?? "owned loopback listener unavailable");
  assert.ok(state.port);
  return state.port;
}

async function connect(viewer: Side, owner: Side, label: string, port: number): Promise<string> {
  await viewer.coordinator.perform({ type: "peer-add", label, host: "127.0.0.1", port: String(port) });
  const hostId = viewer.coordinator.read().hosts!.find((host) => host.label === label)!.id;
  const connecting = viewer.coordinator.perform({ type: "peer-connect", hostId });
  const key = await viewer.log.waitFor((snapshot) => snapshot.consents.some((consent) => consent.kind === "server-key"), "synthetic first-use key consent");
  assert.equal(viewer.coordinator.decideConsent(key.consents.find((consent) => consent.kind === "server-key")!.id, "approve"), true);
  const incoming = await owner.log.waitFor((snapshot) => snapshot.consents.some((consent) => consent.kind === "incoming"), "synthetic directional grant consent");
  assert.equal(owner.coordinator.decideConsent(incoming.consents.find((consent) => consent.kind === "incoming")!.id, "approve"), true);
  await connecting;
  await viewer.log.waitFor((snapshot) => snapshot.hosts?.some((host) => host.id === hostId && host.state === "connected" && host.roster.state === "current") === true,
    "current owner roster");
  await nextTurn();
  return hostId;
}

async function highlight(side: Side, label: string): Promise<void> {
  if (side.harness.sidebar!.focus === "main") side.harness.terminal.emitInput(ALT_LEFT);
  for (let index = 0; index < 24; index++) {
    if (selectedRosterHostLine(side.harness).includes(label)
      && side.harness.sidebar!.captureMousePresentation().remoteClose?.rowId === "native-1") return;
    side.harness.terminal.emitInput("\x1b[B");
    await nextTurn();
  }
  assert.fail(`no written highlighted card for ${label}`);
}

async function edit(side: Side, label: string, name: string): Promise<void> {
  await highlight(side, label);
  side.harness.terminal.emitInput("e");
  await nextTurn();
  assert.equal(side.harness.sidebar!.focus, "form", "E opened the production editor");
  side.harness.terminal.emitInput(name);
  await nextTurn(); // the exact replacement draft must actually be written
}

function waitForUncertainFrame(harness: Harness): Promise<void> {
  const writer = harness.writer;
  const submit = writer.submit;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      writer.submit = submit;
      reject(new Error(`no written uncertain result after the normal rename deadline:\n${plain(writer.frames.at(-1)?.frame)}`));
    }, 20_000);
    writer.submit = (frame, cols, rows, settled) => {
      submit.call(writer, frame, cols, rows, settled);
      if (!plain(frame).includes("UNCERTAIN")) return;
      writer.submit = submit;
      clearTimeout(timer);
      resolve();
    };
  });
}

function observedName(side: Side, hostId: string, rowId: string): string | undefined {
  return side.coordinator.read().hosts?.find((host) => host.id === hostId)?.roster.rows?.find((row) => row.id === rowId)?.nativeSession?.name;
}

// POSIX test policy inspects real synthetic UID/modes; it makes no Windows ACL claim.
test("remote E renames the exact owner over paired TLS and metadata, preserving cancel, local controls, collisions and late drafts", { skip: process.platform === "win32" }, async (t) => {
  let passed = false;
  const ownerA = await mainSide(t, "owner-a", () => passed);
  const ownerB = await mainSide(t, "owner-b", () => passed);
  const viewer = await mainSide(t, "viewer", () => passed);
  const observer = await mainSide(t, "observer", () => passed);
  await createRow(ownerA, "Owner A one");
  await createRow(ownerA, "Owner A two");
  await createRow(ownerB, "Owner B one");
  await createRow(viewer, "Local one");
  const a = ownerA.harness.manager!;
  const b = ownerB.harness.manager!;
  const local = viewer.harness.manager!;
  const rowA = a.views[0]!;
  const rowB = b.views[0]!;
  assert.equal(rowA.id, rowB.id);
  assert.equal(rowA.id, local.views[0]!.id, "opaque remote and local row ids collide deliberately");
  const workspace = rowA.workspace;
  const tuple = { sessionId: rowA.nativeSession!.sessionId, epoch: rowA.nativeSession!.epoch };
  const portA = await listen(ownerA);
  const portB = await listen(ownerB);
  const hostA = await connect(viewer, ownerA, "Owner A", portA);
  const hostB = await connect(viewer, ownerB, "Owner B", portB);
  const observedA = await connect(observer, ownerA, "Observed A", portA);
  assert.equal(viewer.coordinator.read().hosts!.find((host) => host.id === hostA)!.renameSupported, true);
  const activeFocus = ownerA.harness.sidebar!.focus;
  const creates = a.createOptions.length;
  await edit(viewer, "Owner A", "Renamed A");
  const editingText = plain(viewer.harness.writer.frames.at(-1)?.frame);
  assert.ok(editingText.includes("Owner A one"), `the exact selected row's existing name is shown for reference:\n${editingText}`);
  viewer.harness.terminal.emitInput(ENTER);
  await viewer.log.waitFor(() => observedName(viewer, hostA, rowA.id) === "Renamed A", "initiator authoritative metadata");
  await observer.log.waitFor(() => observedName(observer, observedA, rowA.id) === "Renamed A", "other current observer metadata");
  await nextTurn();
  assert.equal(a.views[0]!.nativeSession!.name, "Renamed A");
  assert.equal(a.views[0]!.workspace, workspace);
  assert.deepEqual({ sessionId: a.views[0]!.nativeSession!.sessionId, epoch: a.views[0]!.nativeSession!.epoch }, tuple);
  assert.equal(a.views[1]!.nativeSession!.name, "Owner A two");
  assert.equal(b.views[0]!.nativeSession!.name, "Owner B one");
  assert.equal(local.views[0]!.nativeSession!.name, "Local one");
  assert.equal(local.renameCalls.length, 0, "no remote opaque id entered the local rename seam");
  assert.equal(a.createOptions.length, creates);
  assert.deepEqual(a.writes, []);
  assert.deepEqual(local.writes, []);
  assert.equal(ownerA.harness.sidebar!.focus, activeFocus);
  assert.equal(viewer.harness.sidebar!.focus, "sidebar");
  assert.ok(plain(viewer.harness.writer.frames.at(-1)?.frame).includes("Renamed A"));

  await edit(viewer, "Owner A", "Cancelled name");
  viewer.harness.terminal.emitInput("\x1b");
  await nextTurn();
  assert.equal(viewer.harness.sidebar!.focus, "sidebar");
  assert.equal(a.renameCalls.length, 1);
  assert.equal(a.views[0]!.nativeSession!.name, "Renamed A");

  let release!: () => void;
  let entered!: () => void;
  const admitted = new Promise<void>((resolve) => { entered = resolve; });
  a.renameGate = new Promise<void>((resolve) => { release = resolve; });
  a.renameGateEntered = entered;
  await edit(viewer, "Owner A", "Delayed A");
  viewer.harness.terminal.emitInput(ENTER);
  await admitted;
  viewer.harness.terminal.emitInput("\x1b");
  await nextTurn();
  await edit(viewer, "Owner B", "Independent B draft");
  release();
  await observer.log.waitFor(() => observedName(observer, observedA, rowA.id) === "Delayed A", "late owner A metadata");
  await nextTurn();
  assert.equal(viewer.harness.sidebar!.focus, "form", "a late A reply cannot close B's editor");
  assert.ok(plain(viewer.harness.writer.frames.at(-1)?.frame).includes("Independent B draft"));
  assert.equal(b.renameCalls.length, 0);
  viewer.harness.terminal.emitInput(ENTER);
  await viewer.log.waitFor((snapshot) => snapshot.hosts?.some((host) => host.label === "Owner B" && host.roster.rows?.[0]?.nativeSession?.name === "Independent B draft") === true,
    "B owner metadata after deliberate submit");
  await nextTurn();
  assert.equal(b.views[0]!.nativeSession!.name, "Independent B draft");
  assert.equal(local.renameCalls.length, 0);

  await edit(viewer, "Owner A", "Must not retarget");
  a.views[0] = { ...a.views[0]!, nativeSession: { ...a.views[0]!.nativeSession!, epoch: tuple.epoch + 1 } };
  a.onChange?.(rowA.id);
  await viewer.log.waitFor((snapshot) => snapshot.hosts?.find((host) => host.id === hostA)?.roster.rows?.[0]?.nativeSession?.epoch === tuple.epoch + 1,
    "replaced native tuple");
  viewer.harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(a.renameCalls.length, 2, "a replaced native session never received another rename");
  assert.equal(a.views[0]!.nativeSession!.name, "Delayed A");
  viewer.harness.terminal.emitInput("\x1b");
  await nextTurn();

  // Existing local E remains the ordinary native-name path, despite both collisions.
  viewer.harness.sidebar!.select(local.views[0]!.id);
  viewer.harness.terminal.emitInput("e");
  await nextTurn();
  viewer.harness.terminal.emitInput("Local renamed");
  viewer.harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(local.views[0]!.nativeSession!.name, "Local renamed");
  assert.equal(local.renameCalls.length, 1);
  assert.equal(a.renameCalls.length, 2);
  assert.equal(b.renameCalls.length, 1);

  await edit(viewer, "Owner B", "Disconnected attempt");
  await viewer.coordinator.perform({ type: "peer-disconnect", hostId: hostB });
  viewer.harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.equal(b.renameCalls.length, 1, "disconnect before submit never reaches the owner");
  viewer.harness.terminal.emitInput("\x1b");
  await nextTurn();
  await viewer.coordinator.perform({ type: "peer-connect", hostId: hostB });
  await viewer.log.waitFor((snapshot) => snapshot.hosts?.some((host) => host.id === hostB && host.state === "connected" && host.roster.state === "current") === true,
    "deliberate reconnect with the existing pin and grant");
  await nextTurn();
  let releaseRevoked!: () => void;
  let admittedRevoked!: () => void;
  const revokedAdmission = new Promise<void>((resolve) => { admittedRevoked = resolve; });
  b.renameGate = new Promise<void>((resolve) => { releaseRevoked = resolve; });
  b.renameGateEntered = admittedRevoked;
  await edit(viewer, "Owner B", "Revoked late name");
  viewer.harness.terminal.emitInput(ENTER);
  await revokedAdmission;
  const receivingPeer = ownerB.coordinator.read().trustedPeers!.find((peer) => peer.hasInboundGrant)!;
  assert.ok(receivingPeer);
  const uncertainFrame = waitForUncertainFrame(viewer.harness);
  void uncertainFrame.catch(() => undefined); // owned even if a preceding fixture operation fails
  await ownerB.coordinator.perform({ type: "peer-revoke", peerId: receivingPeer.id });
  releaseRevoked();
  await viewer.log.waitFor((snapshot) => snapshot.hosts?.some((host) => host.id === hostB
    && (host.state !== "connected" || host.roster.state !== "current")) === true, "viewer observed revoked metadata channel");
  await uncertainFrame; // observe the actual result/deadline, not just metadata staleness
  await nextTurn();
  await nextTurn();
  assert.equal(b.views[0]!.nativeSession!.name, "Revoked late name", "accepted owner work is not rolled back on revoke");
  assert.equal(b.renameCalls.length, 2, "revoked/lost delivery never replays the rename");
  assert.equal(viewer.harness.sidebar!.focus, "form", "no success/focus claim without an authorized reply");
  const revokedText = plain(viewer.harness.writer.frames.at(-1)?.frame);
  assert.ok(revokedText.includes("UNCERTAIN"), `revoked accepted rename must be reported uncertain:\n${revokedText}`);
  assert.notEqual(observedName(viewer, hostB, rowB.id), "Revoked late name", "no local alias substitutes for unavailable owner metadata");
  assert.equal(local.renameCalls.length, 1);
  viewer.harness.terminal.emitInput("\x1b");
  await nextTurn();

  const legacy = await mainSide(t, "legacy", () => passed, false);
  await createRow(legacy, "Legacy one");
  const legacyId = await connect(viewer, legacy, "Legacy", await listen(legacy));
  assert.equal(viewer.coordinator.read().hosts!.find((host) => host.id === legacyId)!.renameSupported, false);
  await highlight(viewer, "Legacy");
  viewer.harness.terminal.emitInput("e");
  await nextTurn();
  assert.equal(viewer.harness.sidebar!.focus, "sidebar", "an unsupported peer offers no remote editor");
  assert.equal(legacy.harness.manager!.renameCalls.length, 0);
  assert.equal(local.renameCalls.length, 1);
  passed = true;
});
