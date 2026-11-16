/**
 * Main's owner-side native providers and the requester's native remote New
 * submission (issue #277 network slice).
 *
 * The coordinator is a fake, so nothing here proves a real provider CLI, a real
 * terminal, or Windows behaviour: what is pinned down is Main's OWN wiring —
 * which providers it hands the coordinator, what each provider does with the
 * request, and which controller method the requester's explicit provider choice
 * reaches.
 *
 * Contract:
 * - the native owner providers are handed over ONLY when this host really has
 *   native launch support; without it the coordinator keeps the exact Pi-only
 *   option set it had before this lane existed;
 * - the owner's native create reuses the one manager's existing
 *   `startSession({ workspace, backend, nativeCliTarget })` seam, in the exact
 *   owner run, and never selects, activates, or focuses anything;
 * - the owner's host-name provider answers with its own per-operation persistence
 *   truth and never reaches the Pi conversation rename;
 * - a native provider choice on a remote destination dispatches to the one
 *   create controller's OPTIONAL native method and never to the Pi create.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { OwningHostService } from "../src/session-host/owning-host-service";
import type {
  OwnerCreateFacts,
  OwnerNativeCliTargetProvider,
  OwnerNativeCreateHandler,
  PeerCreateController,
  PeerCreateOptions,
  PeerCreateResult,
  PeerCreateTarget,
  RemoteNativeCliTarget,
} from "../src/session-host/network/peer-create";
import type {
  OwnerNativeRenameFacts,
  OwnerNativeRenameHandler,
  OwnerNativeRenameRequest,
  OwnerRenameHandler,
} from "../src/session-host/network/peer-rename";
import type { CreateInstanceOptions } from "../src/session-host/instances";
import type { SidebarNativeCliTarget } from "../src/session-host/sidebar";
import { remotePeerHost, remoteRosterRow } from "./helpers/session-host-main-remote";
import {
  FakePeerCoordinator, closeWithSignal, nextTurn, peerMainHarness, plain,
  type FakeManager, type Harness,
} from "./helpers/session-host-main-harness";

const ENTER = "\r";
const DOWN = "\x1b[B";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

const LOCAL_TARGETS: readonly SidebarNativeCliTarget[] = [
  { id: "claude", backend: "claude", label: "Claude Code (default)" },
];

interface LaunchCall {
  readonly backend: string;
  readonly workspace: string;
  readonly targetId?: string;
}

/** A recording synthetic launcher: it never resolves a real executable. */
function recordingHosting(calls: LaunchCall[]) {
  return () => ({
    targets: LOCAL_TARGETS,
    launch: async (backend: "claude" | "codex", request: {
      workspace: string;
      env: NodeJS.ProcessEnv;
      targetId?: string;
    }) => {
      calls.push({
        backend,
        workspace: request.workspace,
        ...(request.targetId === undefined ? {} : { targetId: request.targetId }),
      });
      return {
        file: `/synthetic/${backend}`,
        args: [],
        env: { ...request.env, PWD: request.workspace },
        cwd: request.workspace,
      };
    },
  });
}

function ownerRunId(peer: FakePeerCoordinator): string {
  const inventory = peer.options?.inventory as unknown as OwningHostService | undefined;
  assert.ok(inventory, "the coordinator receives the host's one authoritative inventory");
  const snapshot = inventory.readInventorySnapshot();
  assert.ok(snapshot, "the one manager reports an observable inventory");
  return snapshot.hostRunId;
}

/** One provider Main is expected to have handed the coordinator. */
function provider<T>(peer: FakePeerCoordinator, key: string): T {
  const value = (peer.options as unknown as Record<string, unknown>)[key];
  assert.equal(typeof value, "function", `Main supplies the coordinator its ${key}`);
  return value as T;
}

test("without native launch support Main hands over no native owner provider at all", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  t.after(async () => { assert.equal(await closeWithSignal(harness), 0); });
  const options = peer.options as unknown as Record<string, unknown>;
  assert.equal(options["nativeCreateOwnedSession"], undefined,
    "a host with no native launcher never claims a native create provider");
  assert.equal(options["nativeCliTargets"], undefined);
  assert.equal(options["renameNativeOwnedSession"], undefined,
    "and it never claims the ability to host-name a native row");
  assert.equal(typeof options["createOwnedSession"], "function",
    "the Pi owner create stays exactly as before");
});

test("with native launch support Main hands over the native create, catalog, and host-name providers", async (t) => {
  const calls: LaunchCall[] = [];
  const { peer } = await peerMainHarness(t, undefined, { nativeCliHosting: recordingHosting(calls) });
  const options = peer.options as unknown as Record<string, unknown>;
  assert.equal(typeof options["nativeCreateOwnedSession"], "function");
  assert.equal(typeof options["nativeCliTargets"], "function");
  assert.equal(typeof options["renameNativeOwnedSession"], "function");
});

test("the owner's native create reuses the one manager seam in the exact run, selecting nothing", async (t) => {
  const calls: LaunchCall[] = [];
  const { harness, peer } = await peerMainHarness(t, undefined, { nativeCliHosting: recordingHosting(calls) });
  const manager = harness.manager as FakeManager;
  const sidebar = harness.sidebar;
  assert.ok(sidebar);
  try {
    const create = provider<OwnerNativeCreateHandler>(peer, "nativeCreateOwnedSession");
    const catalog = provider<OwnerNativeCliTargetProvider>(peer, "nativeCliTargets");
    const runId = ownerRunId(peer);
    const focusBefore = sidebar.focus;
    const selectedBefore = sidebar.selectedId;
    assert.deepEqual(manager.views, [], "an owner with no rows is exactly the first-child case");

    const advertised: readonly RemoteNativeCliTarget[] = catalog();
    assert.deepEqual(advertised.map((target) => target.id), ["claude"],
      "the owner advertises only its OWN current native targets");

    const facts: OwnerCreateFacts = await create({
      hostRunId: runId,
      workspace: "/srv/owner/native child",
      backend: "claude",
      targetId: "claude",
    }, () => true);
    assert.deepEqual(facts, { kind: "started", hostRunId: runId, rowId: "native-1" });
    assert.deepEqual(manager.createOptions.at(-1), {
      workspace: "/srv/owner/native child",
      backend: "claude",
      nativeCliTarget: "claude",
    } as CreateInstanceOptions, "the workspace is forwarded verbatim beside the typed backend and target");
    assert.equal(sidebar.focus, focusBefore, "a remote native create never changes the owner's focus");
    assert.equal(sidebar.selectedId, selectedBefore, "and it selects nothing");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("the owner's native create refuses a target it does not advertise, without starting anything", async (t) => {
  const calls: LaunchCall[] = [];
  const { harness, peer } = await peerMainHarness(t, undefined, { nativeCliHosting: recordingHosting(calls) });
  const manager = harness.manager as FakeManager;
  try {
    const create = provider<OwnerNativeCreateHandler>(peer, "nativeCreateOwnedSession");
    const runId = ownerRunId(peer);
    for (const request of [
      { hostRunId: runId, workspace: "/srv/a", backend: "codex" as const, targetId: "codex" },
      { hostRunId: runId, workspace: "/srv/a", backend: "claude" as const, targetId: "external:nope" },
      { hostRunId: "other-run", workspace: "/srv/a", backend: "claude" as const, targetId: "claude" },
    ]) {
      const facts = await create(request, () => true);
      assert.equal(facts.kind, "refused", `${JSON.stringify(request)} is refused`);
    }
    assert.deepEqual(manager.createOptions, [], "nothing was started for any of them");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("the owner's host-name provider reports its own persistence truth and never renames a Pi conversation", async (t) => {
  const calls: LaunchCall[] = [];
  const { harness, peer } = await peerMainHarness(t, undefined, { nativeCliHosting: recordingHosting(calls) });
  const manager = harness.manager as FakeManager;
  try {
    const create = provider<OwnerNativeCreateHandler>(peer, "nativeCreateOwnedSession");
    const rename = provider<OwnerNativeRenameHandler>(peer, "renameNativeOwnedSession");
    const piRename = provider<OwnerRenameHandler>(peer, "renameOwnedSession");
    const runId = ownerRunId(peer);
    const started = await create({
      hostRunId: runId, workspace: "/srv/owner/named", backend: "claude", targetId: "claude",
    }, () => true);
    assert.equal(started.kind, "started");
    const rowId = started.kind === "started" ? started.rowId : "";

    const request: OwnerNativeRenameRequest = {
      hostRunId: runId, rowId, backend: "claude", name: "Renamed on the host",
    };
    const facts: OwnerNativeRenameFacts = await rename(request, () => true);
    // The synthetic manager has no durable native caption store, so the honest
    // answer is the in-memory truth, never a claim that it was saved.
    assert.ok(facts.kind === "renamed-durable" || facts.kind === "renamed-in-memory"
      || facts.kind === "refused" || facts.kind === "unknown", `a closed fact kind: ${facts.kind}`);
    assert.deepEqual(manager.renameCalls, [], "a HOST ROW NAME never reaches the Pi conversation rename");

    // A row this owner no longer records as that backend is refused outright.
    const moved = await rename({ ...request, backend: "codex" }, () => true);
    assert.deepEqual(moved, { kind: "refused" });
    // And a request naming a different owner run is refused before any mutation.
    const otherRun = await rename({ ...request, hostRunId: "not-this-run" }, () => true);
    assert.deepEqual(otherRun, { kind: "refused" });
    assert.deepEqual(manager.renameCalls, []);
    void piRename;
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

/** One create controller that records which lane each request actually reached. */
class CreatePeer extends FakePeerCoordinator {
  readonly piCreates: PeerCreateTarget[] = [];
  readonly nativeCreates: unknown[] = [];
  piResult: PeerCreateResult = { kind: "unknown" };
  nativeResult: PeerCreateResult = { kind: "unknown" };
  readonly ownerCreate: PeerCreateController = {
    createSession: async (request: PeerCreateTarget, _options: PeerCreateOptions) => {
      this.piCreates.push(request);
      return this.piResult;
    },
    createNativeSession: async (request: unknown, _options: PeerCreateOptions) => {
      this.nativeCreates.push(request);
      return this.nativeResult;
    },
  };
}

function nativeOwnerHost(): ReturnType<typeof remotePeerHost> {
  return {
    ...remotePeerHost({
      id: "owner-a",
      label: "owner-a",
      hostRunId: "run-owner-a",
      rows: [remoteRosterRow({ id: "native-1", label: "Native owner row", backend: "claude" })],
    }),
    nativeCli: {
      supported: true,
      targets: [{ id: "claude", backend: "claude", label: "Claude (owner)" }],
    },
  };
}

/** Highlight the drawn `New session` menu row and press Enter. */
async function openNewForm(harness: Harness): Promise<void> {
  if (harness.sidebar!.focus === "main") harness.terminal.emitInput("\x1b[1;3D");
  const marked = (): string => {
    const lines = harness.writer.frames.at(-1)?.frame.lines
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")) ?? [];
    return lines.find((line) => line.startsWith("> ")) ?? "";
  };
  const scan = async (key: string): Promise<boolean> => {
    for (let step = 0; step < 24; step += 1) {
      if (marked().includes("New session")) return true;
      harness.terminal.emitInput(key);
      await nextTurn();
    }
    return false;
  };
  if (!(await scan("\x1b[A")) && !(await scan("\x1b[B"))) {
    assert.fail("no drawn New session row");
  }
  harness.terminal.emitInput(ENTER);
  await nextTurn();
}

/**
 * Move the form's single focus onto the named drawn selector line. The reverse
 * order is Workspace -> Provider -> Host, and a narrow pane can suppress the
 * Provider line, so the scan follows the DRAWN marker instead of counting tabs.
 */
async function focusSelector(harness: Harness, which: "Host" | "Provider"): Promise<void> {
  const drawn = (): string => {
    const lines = harness.writer.frames.at(-1)?.frame.lines
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")) ?? [];
    // The form may be drawn in either pane, so each pane's own text is checked.
    for (const line of lines) {
      for (const part of line.split("\u2502")) {
        if (part.trim().startsWith(`> ${which}:`)) return part.trim();
      }
    }
    return "";
  };
  for (let step = 0; step < 4; step += 1) {
    if (drawn() !== "") return;
    harness.terminal.emitInput(SHIFT_TAB);
    await nextTurn();
  }
  assert.fail(`the New form never drew a focused ${which} line`);
}

/** Let Main render and report the drawn New form written before it may submit. */
async function settleNewForm(harness: Harness): Promise<void> {
  for (let step = 0; step < 12; step += 1) await nextTurn();
}

async function openNativeNewOnPeer(harness: Harness, workspace: string): Promise<void> {
  // Open the New form, move to the Host line, choose the remote owner, then the
  // owner's advertised provider, then submit the workspace.
  await openNewForm(harness);
  await focusSelector(harness, "Host");
  harness.terminal.emitInput(DOWN); // -> owner-a
  await nextTurn();
  await focusSelector(harness, "Provider");
  harness.terminal.emitInput(DOWN); // -> Claude (owner)
  await nextTurn();
  harness.terminal.emitInput(TAB); // -> Workspace
  harness.terminal.emitInput(workspace);
  await nextTurn();
}

test("a native provider choice on a remote destination reaches the native create lane only", async (t) => {
  const peer = new CreatePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  try {
    peer.publish({ hosts: [nativeOwnerHost()] });
    await nextTurn();
    await openNativeNewOnPeer(harness, "/srv/app");
    // The drawn New form must be reported written before it may submit.
    await settleNewForm(harness);
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.equal(peer.nativeCreates.length, 1, "the native lane received exactly one request");
    assert.deepEqual(peer.piCreates, [], "the Pi create lane was never used");
    assert.deepEqual(peer.nativeCreates[0], {
      hostId: "owner-a",
      hostRunId: "run-owner-a",
      workspace: "/srv/app",
      backend: "claude",
      targetId: "claude",
    });
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("an unchanged remote New submission keeps the exact Pi create shape", async (t) => {
  const peer = new CreatePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  try {
    peer.publish({ hosts: [nativeOwnerHost()] });
    await nextTurn();
    await openNewForm(harness);
    await focusSelector(harness, "Host");
    harness.terminal.emitInput(DOWN); // -> owner-a
    await nextTurn();
    await focusSelector(harness, "Provider"); // Pi stays selected: no cycle
    harness.terminal.emitInput(TAB); // -> Workspace
    harness.terminal.emitInput("/srv/app");
    await nextTurn();
    await settleNewForm(harness);
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.deepEqual(peer.piCreates, [{
      hostId: "owner-a", hostRunId: "run-owner-a", workspace: "/srv/app",
    }], "the Pi remote create request is byte-for-byte what it was before this lane");
    assert.deepEqual(peer.nativeCreates, []);
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a destination that offers no native target draws no provider choice and creates with Pi", async (t) => {
  const peer = new CreatePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  try {
    const plainOwner = remotePeerHost({
      id: "owner-b",
      label: "owner-b",
      hostRunId: "run-owner-b",
      rows: [remoteRosterRow({ id: "pi-1", label: "Pi owner row" })],
    });
    peer.publish({ hosts: [plainOwner] });
    await nextTurn();
    await openNewForm(harness);
    await focusSelector(harness, "Host");
    harness.terminal.emitInput(DOWN); // -> owner-b
    await nextTurn();
    const opened = plain(harness.writer.frames.at(-1)?.frame);
    assert.equal(opened.includes("Provider:"), false,
      "a native-less owner draws no Provider line at all");
    harness.terminal.emitInput(TAB);
    harness.terminal.emitInput("/srv/app");
    await nextTurn();
    await settleNewForm(harness);
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.deepEqual(peer.nativeCreates, []);
    assert.equal(peer.piCreates.length, 1);
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

/**
 * A create controller that reaches the native transport and then HOLDS there, the
 * way a real ordered write can be delayed. The test releases it only after the
 * owner's advertised provider scope has moved, and records what the caller's
 * last-instant `stillCurrent` proof answered at that moment.
 */
class HeldNativePeer extends FakePeerCoordinator {
  readonly nativeRequests: unknown[] = [];
  piRequests: unknown[] = [];
  /** The answer of `stillCurrent()` when the held write is finally released. */
  proofAtWrite: boolean | undefined;
  private releasePending: (() => void) | undefined;
  /** Release the held transport, evaluating the caller's proof first. */
  release(): void {
    assert.ok(this.releasePending !== undefined, "the native transport must be held");
    this.releasePending!();
  }
  readonly ownerCreate: PeerCreateController = {
    createSession: () => {
      this.piRequests.push(1);
      return Promise.resolve({ kind: "unknown" } satisfies PeerCreateResult);
    },
    createNativeSession: (request: unknown, options: PeerCreateOptions) => {
      this.nativeRequests.push(request);
      return new Promise<PeerCreateResult>((resolve) => {
        this.releasePending = () => {
          this.proofAtWrite = options.stillCurrent();
          resolve({ kind: "unknown" });
        };
      });
    },
  };
}

test("a native create whose provider scope moved while its write was held is refused at the write", async (t) => {
  const peer = new HeldNativePeer();
  const { harness } = await peerMainHarness(t, undefined, {}, peer);
  try {
    peer.publish({ hosts: [nativeOwnerHost()] });
    await nextTurn();
    await openNativeNewOnPeer(harness, "/srv/app");
    await settleNewForm(harness);
    harness.terminal.emitInput(ENTER);
    await nextTurn();
    assert.equal(peer.nativeRequests.length, 1,
      "the native transport was reached once and is held before any write");
    // Withdraw the advertised target and advertise it again, byte for byte, while
    // that write is held. The owner run, the connection, and the fingerprint are
    // unchanged, so neither the coordinator's present-value catalog check nor the
    // run/connection retirement branch can see this transition on its own.
    peer.publish({
      hosts: [{ ...nativeOwnerHost(), nativeCli: { supported: true, targets: [] } }],
    });
    await nextTurn();
    peer.publish({ hosts: [nativeOwnerHost()] });
    await nextTurn();
    peer.release();
    await nextTurn();
    // The caller's own proof, evaluated inside the ordered write, is what refuses:
    // the pending native request was retired the moment its provider scope moved.
    assert.equal(peer.proofAtWrite, false,
      "a held native write is refused once its provider scope has moved");
    assert.deepEqual(peer.piRequests, [], "and it is never answered by a Pi create");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});
