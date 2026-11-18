/**
 * Main's routed SessionSpawn wiring (issue #493): the requester's local and
 * paired routes and the owner's prompted spawn provider.
 *
 * The coordinator and manager are fakes, so nothing here proves a real provider
 * CLI, a real network channel, or a real PTY. What is pinned down is Main's OWN
 * routing: which manager create or paired controller call each request reaches,
 * with exactly which fields, which outcome each result maps to, and that no
 * route falls back, retries, connects, or changes focus or selection.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { hasSessionHostsDiscoveryHandlers, type StatusBroker, type StatusBrokerStatusHandlers } from "../src/session-host/broker";
import { __test as mainTest } from "../src/session-host/main";

import type { CreateInstanceOptions, InstanceManagerOptions } from "../src/session-host/instances";
import type {
  OwnerSessionSpawnHandler,
  PeerNativeTargetsRefreshResult,
  PeerCreateController,
  PeerCreateOptions,
  PeerCreateResult,
  PeerSpawnTarget,
} from "../src/session-host/network/peer-create";
import type { OwningHostService } from "../src/session-host/owning-host-service";
import type { PeerUiHost, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import type { SessionHostsSnapshot, SessionSpawnInput, SessionSpawnOutcome } from "../src/session-host/protocol";
import type { SidebarNativeCliTarget } from "../src/session-host/sidebar";
import {
  FakePeerContentPort,
  FakePeerCoordinatorWithContent,
  activateRemoteRosterRow,
  harnessManager,
  remotePeerHost,
  remoteRosterRow,
} from "./helpers/session-host-main-remote";
import {
  closeWithSignal, fillForm, nextTurn, peerMainHarness,
  type FakeManager, type Harness, type MainTestDependencies,
} from "./helpers/session-host-main-harness";

const ALT_LEFT = "\x1b[1;3D";

/** The exact prompt shape the tool admits: large, multiline, Unicode, flag-looking. */
function bigPrompt(): string {
  let text = "--model opus -- /slash @file\n";
  while (Buffer.byteLength(text, "utf8") <= 130 * 1024) text += "ünïcödé 😀 改行\r\n";
  return `${text}end`;
}

const TITLE = "  Spawned title with ünicode and a long tail ".padEnd(300, "x");

/** The paired-create controller a production coordinator exposes, recording every lane it reaches. */
class SpawnPeer extends FakePeerCoordinatorWithContent {
  readonly spawns: PeerSpawnTarget[] = [];
  readonly spawnOptions: PeerCreateOptions[] = [];
  readonly blankCreates: unknown[] = [];
  supported = new Set<string>(["lab-b"]);
  result: PeerCreateResult | (() => Promise<PeerCreateResult>) = {
    kind: "owner-result", facts: { kind: "started", hostRunId: "run-b", rowId: "owner-row-1" },
  };
  readonly ownerCreate: PeerCreateController = {
    createSession: async (request) => { this.blankCreates.push(request); return { kind: "unknown" }; },
    createNativeSession: async (request) => { this.blankCreates.push(request); return { kind: "unknown" }; },
    supportsSessionSpawn: (hostId: string) => this.supported.has(hostId),
    spawnSession: async (target: PeerSpawnTarget, options: PeerCreateOptions) => {
      this.spawns.push({ ...target });
      this.spawnOptions.push(options);
      const result = this.result;
      return typeof result === "function" ? result() : result;
    },
  };
}

const HOSTS = [
  remotePeerHost({
    id: "lab-b",
    label: "Lab Beta",
    hostRunId: "run-b",
    rows: [remoteRosterRow({ id: "row-b", label: "Beta remote" })],
  }),
  remotePeerHost({ id: "lab-c", label: "Lab Gamma", hostRunId: null, rows: null, rosterState: "never" }),
];

const TARGETS: readonly SidebarNativeCliTarget[] = [
  { id: "claude", backend: "claude", label: "Claude Code (default)" },
  { id: "codex", backend: "codex", label: "Codex CLI (default)" },
];

function hosting(targets: readonly SidebarNativeCliTarget[] = TARGETS): MainTestDependencies {
  return {
    nativeCliHosting: () => ({
      targets,
      launch: async (backend: "claude" | "codex", request: { workspace: string; env: NodeJS.ProcessEnv }) => ({
        file: `/synthetic/${backend}`, args: [], env: { ...request.env, PWD: request.workspace }, cwd: request.workspace,
      }),
    }),
  };
}

async function spawnHarness(
  t: { after(callback: () => void): void },
  dependencies: MainTestDependencies = hosting(),
): Promise<{ harness: Harness; peer: SpawnPeer; manager: FakeManager }> {
  const content = new FakePeerContentPort();
  const peer = new SpawnPeer(content);
  const started = await peerMainHarness(t, undefined, dependencies, peer);
  content.attach(started.peer.options?.onContentChange);
  content.attachNativeIo(started.peer.options?.nativeIo);
  started.peer.publish({ hosts: HOSTS as unknown as PeerUiSnapshot["hosts"] });
  await nextTurn();
  return { harness: started.harness, peer, manager: harnessManager(started.harness) };
}

/** One live local parent row created through the ordinary New form. */
async function localParent(harness: Harness, manager: FakeManager): Promise<string> {
  fillForm(harness.terminal, "/local/parent");
  await nextTurn();
  await nextTurn();
  const parent = manager.views.at(-1);
  assert.ok(parent && parent.lifecycle === "alive" && parent.hasLiveProcess, "a live local parent exists");
  return parent.id;
}

function routed(manager: FakeManager): NonNullable<InstanceManagerOptions["onRoutedSpawnRequest"]> {
  const handler = manager.options.onRoutedSpawnRequest;
  assert.equal(typeof handler, "function", "Main installs the routed SessionSpawn handler");
  return handler!;
}

function legacy(manager: FakeManager): NonNullable<InstanceManagerOptions["onSpawnRequest"]> {
  const handler = manager.options.onSpawnRequest;
  assert.equal(typeof handler, "function");
  return handler!;
}

test("an unchanged three-argument SessionSpawn creates a Pi child on this host even while viewing B", async (t) => {
  const { harness, peer, manager } = await spawnHarness(t);
  try {
    const parent = await localParent(harness, manager);
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    await activateRemoteRosterRow(harness, "Lab Beta");
    const viewing = harness.sidebar!.activeMainOwnerKey;
    assert.deepEqual(viewing, { kind: "remote", hostId: "lab-b", hostRunId: "run-b", rowId: "row-b" },
      "the viewer is displaying host B");
    const focus = harness.sidebar!.focus;
    const selected = harness.sidebar!.selectedId;
    const createsBefore = manager.createOptions.length;
    const prompt = bigPrompt();

    const outcome = await legacy(manager)(parent, { workspace: "/local/child", title: TITLE, prompt });
    assert.equal(outcome, "started");
    assert.equal(manager.createOptions.length, createsBefore + 1);
    assert.deepEqual(manager.createOptions.at(-1), {
      workspace: "/local/child",
      initialRequest: { title: TITLE, prompt },
    } as CreateInstanceOptions, "the legacy request is exactly the old own-host Pi create");

    // A routed request that omits the host is still the caller's own host.
    const piRouted = await routed(manager)(parent, { workspace: "/local/child2", title: TITLE, prompt, kind: "pi" }, () => true);
    assert.equal(piRouted, "started");
    assert.deepEqual(manager.createOptions.at(-1), {
      workspace: "/local/child2",
      initialRequest: { title: TITLE, prompt },
    } as CreateInstanceOptions, "an explicit pi kind with no host is the same own-host Pi create");

    assert.deepEqual(peer.spawns, [], "nothing was routed to the viewed host");
    assert.deepEqual(peer.blankCreates, []);
    assert.deepEqual(harness.sidebar!.activeMainOwnerKey, viewing, "the displayed owner is unchanged");
    assert.equal(harness.sidebar!.focus, focus, "focus is unchanged");
    assert.equal(harness.sidebar!.selectedId, selected, "selection is unchanged");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a host-omitted native kind launches that backend's default target on this host only", async (t) => {
  const { harness, peer, manager } = await spawnHarness(t);
  try {
    const parent = await localParent(harness, manager);
    const prompt = bigPrompt();
    for (const kind of ["claude", "codex"] as const) {
      const outcome = await routed(manager)(parent, { workspace: "/local/native", title: TITLE, prompt, kind }, () => true);
      assert.equal(outcome, "started");
      assert.deepEqual(manager.createOptions.at(-1), {
        workspace: "/local/native",
        initialRequest: { title: TITLE, prompt },
        backend: kind,
        nativeCliTarget: kind,
      } as CreateInstanceOptions, `${kind} maps only to its default target, with the exact title and prompt`);
    }
    assert.deepEqual(peer.spawns, []);
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("an explicit host routes Pi, Claude, and Codex exactly to that paired owner and creates nothing locally", async (t) => {
  const { harness, peer, manager } = await spawnHarness(t);
  try {
    const parent = await localParent(harness, manager);
    const createsBefore = manager.createOptions.length;
    const focus = harness.sidebar!.focus;
    const selected = harness.sidebar!.selectedId;
    const prompt = bigPrompt();
    // Interpreted on the destination: nothing about the requester's filesystem is consulted.
    const workspace = "/only/exists/on/the/destination host";
    for (const kind of [undefined, "pi", "claude", "codex"] as const) {
      const request: SessionSpawnInput = {
        workspace, title: TITLE, prompt, host: "lab-b", ...(kind === undefined ? {} : { kind }),
      };
      const outcome = await routed(manager)(parent, request, () => true);
      assert.equal(outcome, "started", `${kind ?? "omitted"} kind is reported started from the owner's own fact`);
      assert.deepEqual(peer.spawns.at(-1), {
        hostId: "lab-b",
        hostRunId: "run-b",
        kind: kind ?? "pi",
        workspace,
        title: TITLE,
        prompt,
      }, "the exact supplied fields reach the owner, with the destination's current run");
    }
    assert.equal(peer.spawns.length, 4, "one submission per request, never a retry");
    assert.equal(manager.createOptions.length, createsBefore, "no local child was created for a remote request");
    assert.deepEqual(peer.blankCreates, [], "the blank create lanes are never used");
    assert.equal(harness.sidebar!.focus, focus);
    assert.equal(harness.sidebar!.selectedId, selected);
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("paired outcomes are classified truthfully, once, with no fallback or retry", async (t) => {
  const { harness, peer, manager } = await spawnHarness(t);
  try {
    const parent = await localParent(harness, manager);
    const createsBefore = manager.createOptions.length;
    const cases: Array<[PeerCreateResult | (() => Promise<PeerCreateResult>), SessionSpawnOutcome]> = [
      [{ kind: "owner-result", facts: { kind: "started", hostRunId: "run-b", rowId: "r" } }, "started"],
      [{ kind: "owner-result", facts: { kind: "refused" } }, "failed"],
      [{ kind: "owner-result", facts: { kind: "unconfirmed" } }, "unknown"],
      [{ kind: "owner-result", facts: { kind: "unknown" } }, "unknown"],
      [{ kind: "owner-result", facts: { kind: "bogus" } as never }, "unknown"],
      [{ kind: "not-sent", reason: "target-unavailable" }, "failed"],
      [{ kind: "not-sent", reason: "capability-unsupported" }, "failed"],
      [{ kind: "unknown" }, "unknown"],
      [async () => { throw new Error("synthetic transport failure after handoff"); }, "unknown"],
    ];
    for (const [result, expected] of cases) {
      peer.result = result;
      const before = peer.spawns.length;
      const outcome = await routed(manager)(parent, {
        workspace: "/w", title: "t", prompt: "p", host: "lab-b", kind: "codex",
      }, () => true);
      assert.equal(outcome, expected);
      assert.equal(peer.spawns.length, before + 1, "exactly one submission");
    }
    assert.equal(manager.createOptions.length, createsBefore, "no outcome ever falls back to a local launch");
    assert.deepEqual(peer.commands, [], "no connect, pair, or grant command is ever issued");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("an unknown, label-named, unobserved, or unsupported destination is refused before anything is sent", async (t) => {
  const { harness, peer, manager } = await spawnHarness(t);
  try {
    const parent = await localParent(harness, manager);
    const createsBefore = manager.createOptions.length;
    peer.supported.add("lab-c");
    for (const host of ["nope", "Lab Beta", "LAB-B", "lab-c"]) {
      const outcome = await routed(manager)(parent, { workspace: "/w", title: "t", prompt: "p", host }, () => true);
      assert.equal(outcome, "failed", `${host} is not an existing observed paired destination id`);
    }
    peer.supported.delete("lab-b");
    assert.equal(await routed(manager)(parent, { workspace: "/w", title: "t", prompt: "p", host: "lab-b" }, () => true),
      "failed", "a destination without negotiated SessionSpawn support is never asked");
    assert.deepEqual(peer.spawns, []);
    assert.equal(manager.createOptions.length, createsBefore, "and nothing is launched locally instead");
    assert.deepEqual(peer.commands, [], "no automatic connection or pairing is attempted");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a stale parent never submits, and the write-boundary proof follows the parent registration", async (t) => {
  const { harness, peer, manager } = await spawnHarness(t);
  try {
    const parent = await localParent(harness, manager);
    assert.equal(await routed(manager)(parent, { workspace: "/w", title: "t", prompt: "p", host: "lab-b" }, () => false),
      "failed");
    assert.deepEqual(peer.spawns, [], "a parent that is no longer current sends nothing");

    let parentCurrent = true;
    const outcome = await routed(manager)(parent, { workspace: "/w", title: "t", prompt: "p", host: "lab-b" },
      () => parentCurrent);
    assert.equal(outcome, "started");
    const proof = peer.spawnOptions.at(-1);
    assert.ok(proof && typeof proof.stillCurrent === "function");
    assert.equal(proof.stillCurrent(), true);
    parentCurrent = false;
    assert.equal(proof.stillCurrent(), false, "the transport's last-instant proof re-reads the parent registration");
    parentCurrent = true;
    assert.equal(proof.stillCurrent(), true);
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

function ownerRun(peer: SpawnPeer): string {
  const inventory = peer.options?.inventory as unknown as OwningHostService | undefined;
  const snapshot = inventory?.readInventorySnapshot();
  assert.ok(snapshot);
  return snapshot.hostRunId;
}

function ownerSpawn(peer: SpawnPeer): OwnerSessionSpawnHandler {
  const value = (peer.options as unknown as Record<string, unknown>)["spawnOwnedSession"];
  assert.equal(typeof value, "function", "Main hands the coordinator its prompted spawn provider");
  return value as OwnerSessionSpawnHandler;
}

test("the owner's prompted spawn launches each kind through the one manager seam, focus-free", async (t) => {
  const { harness, peer, manager } = await spawnHarness(t);
  try {
    const spawn = ownerSpawn(peer);
    const runId = ownerRun(peer);
    const focus = harness.sidebar!.focus;
    const selected = harness.sidebar!.selectedId;
    const prompt = bigPrompt();
    const pi = await spawn({ hostRunId: runId, kind: "pi", workspace: "/owner/ws", title: TITLE, prompt }, () => true);
    assert.equal(pi.kind, "started");
    assert.deepEqual(manager.createOptions.at(-1), {
      workspace: "/owner/ws", initialRequest: { title: TITLE, prompt },
    } as CreateInstanceOptions);
    for (const kind of ["claude", "codex"] as const) {
      const facts = await spawn({ hostRunId: runId, kind, workspace: "/owner/ws", title: TITLE, prompt }, () => true);
      assert.equal(facts.kind, "started");
      assert.deepEqual(manager.createOptions.at(-1), {
        workspace: "/owner/ws",
        backend: kind,
        nativeCliTarget: kind,
        initialRequest: { title: TITLE, prompt },
      } as CreateInstanceOptions, `${kind} uses this owner's own default target and the exact request`);
    }
    assert.equal(harness.sidebar!.focus, focus, "an owner-side spawn never changes the owner's focus");
    assert.equal(harness.sidebar!.selectedId, selected, "and it selects nothing");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("the owner refuses another run, a withdrawn re-proof, or an unadvertised native kind before any create", async (t) => {
  const { harness, peer, manager } = await spawnHarness(t, hosting([TARGETS[0]!]));
  try {
    const spawn = ownerSpawn(peer);
    const runId = ownerRun(peer);
    const base = { workspace: "/owner/ws", title: "t", prompt: "p" };
    assert.deepEqual(await spawn({ ...base, hostRunId: "other-run", kind: "pi" }, () => true), { kind: "refused" });
    assert.deepEqual(await spawn({ ...base, hostRunId: runId, kind: "pi" }, () => false), { kind: "refused" });
    assert.deepEqual(await spawn({ ...base, hostRunId: runId, kind: "codex" }, () => true), { kind: "refused" },
      "a kind this owner does not advertise is refused, never served by another backend or Pi");
    assert.deepEqual(manager.createOptions, [], "nothing was started for any of them");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a host without native launch support still serves Pi but refuses a native kind", async (t) => {
  const { harness, peer, manager } = await spawnHarness(t, {});
  try {
    const spawn = ownerSpawn(peer);
    const runId = ownerRun(peer);
    const base = { workspace: "/owner/ws", title: "t", prompt: "p", hostRunId: runId };
    assert.deepEqual(await spawn({ ...base, kind: "claude" }, () => true), { kind: "refused" });
    assert.deepEqual(manager.createOptions, []);
    assert.equal((await spawn({ ...base, kind: "pi" }, () => true)).kind, "started");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

// --- Read-only SessionHosts discovery and fresh native availability (issue #493). ---

const SHIFT_TAB = "\x1b[Z";
const DOWN = "\x1b[B";
const ESC = "\x1b";

/** A coordinator whose create controller also offers the bounded owner refresh. */
class DiscoveryPeer extends SpawnPeer {
  readonly refreshes: string[] = [];
  refreshResults = new Map<string, PeerNativeTargetsRefreshResult | (() => Promise<PeerNativeTargetsRefreshResult>)>();
  constructor(content: FakePeerContentPort) {
    super(content);
    (this.ownerCreate as { refreshNativeTargets?: PeerCreateController["refreshNativeTargets"] }).refreshNativeTargets =
      async (hostId: string) => {
        this.refreshes.push(hostId);
        const result = this.refreshResults.get(hostId) ?? { kind: "not-sent", reason: "capability-unsupported" };
        return typeof result === "function" ? result() : result;
      };
  }
}

const OWNER_TARGETS = [
  { id: "claude", backend: "claude" as const, label: "Claude (owner)" },
  { id: "codex", backend: "codex" as const, label: "Codex (owner)" },
];

function probedHost(id: string, label: string, hostRunId: string, targets = OWNER_TARGETS): PeerUiHost {
  return {
    ...remotePeerHost({ id, label, hostRunId, rows: [] }),
    nativeCli: { supported: true, targets, availability: "probed" },
    createSupported: true,
  } as PeerUiHost;
}

/** A launcher whose executables can be "installed" and "removed" between probes. */
function switchableHosting(installed: Set<string>, calls: Array<{ backend: string; workspace: string; request: Record<string, unknown> }>): MainTestDependencies {
  return {
    nativeCliHosting: () => ({
      targets: TARGETS,
      launch: async (backend: "claude" | "codex", request: { workspace: string; env: NodeJS.ProcessEnv }) => {
        calls.push({ backend, workspace: request.workspace, request: { ...request } });
        if (!installed.has(backend)) throw new Error(`synthetic: the ${backend} executable was not found`);
        return { file: `/synthetic/${backend}`, args: [], env: { ...request.env, PWD: request.workspace }, cwd: request.workspace };
      },
    }),
  };
}

async function discoveryHarness(
  t: { after(callback: () => void): void },
  hosts: PeerUiSnapshot["hosts"],
  dependencies: MainTestDependencies = hosting(),
): Promise<{ harness: Harness; peer: DiscoveryPeer; manager: FakeManager }> {
  const content = new FakePeerContentPort();
  const peer = new DiscoveryPeer(content);
  const started = await peerMainHarness(t, undefined, dependencies, peer);
  content.attach(started.peer.options?.onContentChange);
  started.peer.publish({ hosts });
  await nextTurn();
  return { harness: started.harness, peer, manager: harnessManager(started.harness) };
}

function inspector(manager: FakeManager): NonNullable<InstanceManagerOptions["onSessionHostsRequest"]> {
  const handler = manager.options.onSessionHostsRequest;
  assert.equal(typeof handler, "function", "Main installs the SessionHosts discovery handler beside routed spawn");
  return handler!;
}

function inspect(manager: FakeManager, parent: string, current: () => boolean = () => true, signal = new AbortController().signal): Promise<SessionHostsSnapshot> {
  return inspector(manager)(parent, { signal }, current);
}

/** Every provider choice the open New form offers, by cycling its drawn Provider line once around. */
async function offeredProviders(harness: Harness): Promise<string[]> {
  const providerLine = (): string => {
    const lines = harness.writer.frames.at(-1)?.frame.lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")) ?? [];
    for (const line of lines) for (const part of line.split("│")) if (part.includes("Provider:")) return part.trim();
    return "";
  };
  if (providerLine() === "") return [];
  harness.terminal.emitInput(SHIFT_TAB);
  await nextTurn();
  const seen: string[] = [];
  for (let step = 0; step < 6; step += 1) {
    const label = /\[ (.*) \]/.exec(providerLine())?.[1] ?? "";
    if (seen.includes(label)) break;
    seen.push(label);
    harness.terminal.emitInput(DOWN);
    await nextTurn();
  }
  harness.terminal.emitInput("\t");
  await nextTurn();
  return seen;
}

/** Open the drawn New session row and let its fresh probe settle. */
async function openNew(harness: Harness): Promise<void> {
  if (harness.sidebar!.focus === "main") harness.terminal.emitInput(ALT_LEFT);
  await nextTurn();
  const marked = (): string => (harness.writer.frames.at(-1)?.frame.lines
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")) ?? []).find((line) => line.startsWith("> ")) ?? "";
  for (let step = 0; step < 24 && !marked().includes("New session"); step += 1) {
    harness.terminal.emitInput("\x1b[A");
    await nextTurn();
  }
  assert.match(marked(), /New session/);
  harness.terminal.emitInput(ENTER_KEY);
  await nextTurn();
  await nextTurn();
}

const ENTER_KEY = "\r";

test("Main forwards SessionHosts discovery through its registrar exactly when the broker may advertise it", () => {
  const forwarded: StatusBrokerStatusHandlers[] = [];
  const registration = { bootstrap: { version: 1 } } as unknown as ReturnType<StatusBroker["register"]>;
  // A pass-through recorder: the real broker advertises `sessionHosts` exactly
  // when `hasSessionHostsDiscoveryHandlers` holds for the handlers it receives.
  const registrar = mainTest.statusRegistrar({
    socketPath: "/synthetic/socket",
    generation: "synthetic-generation",
    register(_instanceId, handlers) {
      forwarded.push(handlers);
      return registration;
    },
    dispose: async () => undefined,
  } as StatusBroker);
  const onSessionHostsRequest = async () => ({ ownKinds: ["pi" as const], hosts: [] });
  const onRoutedSpawnRequest = async () => "failed" as const;
  const returned = registrar.register("22222222-2222-4222-8222-222222222222", {
    onStatus: () => undefined, onDisconnect: () => undefined, onRoutedSpawnRequest, onSessionHostsRequest,
  });
  assert.equal(returned, registration, "the broker's exact registration is returned");
  assert.equal(forwarded.at(-1)!.onSessionHostsRequest, onSessionHostsRequest, "the manager's exact closure reaches the broker");
  assert.equal(forwarded.at(-1)!.onRoutedSpawnRequest, onRoutedSpawnRequest);
  assert.equal(hasSessionHostsDiscoveryHandlers(forwarded.at(-1)!), true, "so the actual broker advertises discovery");

  registrar.register("33333333-3333-4333-8333-333333333333", {
    onStatus: () => undefined, onDisconnect: () => undefined, onSessionHostsRequest,
  });
  assert.equal(forwarded.at(-1)!.onSessionHostsRequest, undefined, "discovery is never forwarded without routed spawn");
  assert.equal(hasSessionHostsDiscoveryHandlers(forwarded.at(-1)!), false, "and is then never advertised");
});

test("SessionHosts reports this host and each probing paired owner with all three kinds, raw ids, and no side effects", async (t) => {
  const exactId = "  Lab B (2) — 日本 ";
  const hosts = [
    probedHost(exactId, "Lab Beta", "run-b"),
    remotePeerHost({ id: "lab-c", label: "Lab Gamma", hostRunId: null, rows: null, rosterState: "never" }),
  ] as unknown as PeerUiSnapshot["hosts"];
  const { harness, peer, manager } = await discoveryHarness(t, hosts);
  try {
    peer.supported = new Set([exactId, "lab-c"]);
    peer.refreshResults.set(exactId, { kind: "refreshed", hostRunId: "run-b" });
    const parent = await localParent(harness, manager);
    const createsBefore = manager.createOptions.length;
    const focus = harness.sidebar!.focus;
    const selected = harness.sidebar!.selectedId;
    const snapshot = await inspect(manager, parent);
    assert.deepEqual(snapshot, {
      ownKinds: ["pi", "claude", "codex"],
      hosts: [{ id: exactId, kinds: ["pi", "claude", "codex"] }],
    }, "own kinds come from the fresh probe; the paired id is exact and its kinds come from a fresh owner refresh");
    assert.deepEqual(peer.refreshes, [exactId], "only the addressable probing owner is refreshed, by its exact id");
    assert.equal(manager.createOptions.length, createsBefore, "discovery never spawns");
    assert.deepEqual(peer.spawns, []);
    assert.deepEqual(peer.blankCreates, []);
    assert.deepEqual(peer.commands, [], "discovery never connects, pairs, or retries");
    assert.equal(harness.sidebar!.focus, focus);
    assert.equal(harness.sidebar!.selectedId, selected);
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("SessionHosts keeps the caller's own Pi while viewing B and lists a legacy owner without unverified native kinds", async (t) => {
  const legacy = {
    ...remotePeerHost({ id: "lab-b", label: "Lab Beta", hostRunId: "run-b", rows: [remoteRosterRow({ id: "row-b", label: "Beta remote" })] }),
    nativeCli: { supported: true, targets: OWNER_TARGETS },
  } as unknown as PeerUiHost;
  const { harness, peer, manager } = await discoveryHarness(t, [legacy], {});
  try {
    const parent = await localParent(harness, manager);
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    await activateRemoteRosterRow(harness, "Lab Beta");
    assert.equal(harness.sidebar!.activeMainOwnerKey?.kind, "remote", "the viewer is displaying host B");
    const snapshot = await inspect(manager, parent);
    assert.deepEqual(snapshot, { ownKinds: ["pi"], hosts: [{ id: "lab-b", kinds: ["pi"] }] },
      "a host without native launch support owns Pi only; the legacy owner's configuration-only catalog is not availability");
    assert.deepEqual(peer.refreshes, [], "a non-probing owner is never refreshed as though it were probed");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("SessionHosts is unavailable for a busy or failed owner refresh, a stale parent, or an aborted wait, and omits a gone host", async (t) => {
  const { harness, peer, manager } = await discoveryHarness(t, [probedHost("lab-b", "Lab Beta", "run-b")]);
  try {
    const parent = await localParent(harness, manager);
    for (const result of [
      { kind: "not-sent", reason: "busy" },
      { kind: "not-sent", reason: "not-ready" },
      { kind: "failed" },
      { kind: "refreshed", hostRunId: "another-run" },
    ] as PeerNativeTargetsRefreshResult[]) {
      peer.refreshResults.set("lab-b", result);
      await assert.rejects(() => inspect(manager, parent), `${JSON.stringify(result)} is never fresh availability or absence`);
    }
    peer.refreshResults.set("lab-b", { kind: "not-sent", reason: "target-unavailable" });
    assert.deepEqual((await inspect(manager, parent)).hosts, [], "a destination that is positively gone is simply not listed");
    peer.supported.delete("lab-b");
    peer.refreshes.length = 0;
    assert.deepEqual((await inspect(manager, parent)).hosts, [], "a destination without negotiated SessionSpawn is not selectable");
    assert.deepEqual(peer.refreshes, []);

    await assert.rejects(() => inspect(manager, parent, () => false), "a stale parent learns nothing");
    peer.supported.add("lab-b");
    let release!: () => void;
    peer.refreshResults.set("lab-b", () => new Promise((resolve) => { release = () => resolve({ kind: "refreshed", hostRunId: "run-b" }); }));
    const controller = new AbortController();
    const pending = inspect(manager, parent, () => true, controller.signal);
    await nextTurn();
    controller.abort();
    await assert.rejects(() => pending, "the broker's deadline or disconnect ends the wait as unavailable");
    release();
    assert.deepEqual(peer.spawns, []);
    assert.deepEqual(peer.commands, []);
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a missing native executable is not offered by New, discovery, or spawn, and an install is seen on the next refresh", async (t) => {
  const installed = new Set<string>(["codex"]);
  const calls: Array<{ backend: string; workspace: string; request: Record<string, unknown> }> = [];
  const { harness, peer, manager } = await discoveryHarness(t, [], switchableHosting(installed, calls));
  try {
    await openNew(harness);
    assert.deepEqual(await offeredProviders(harness), ["Pi", "Codex CLI (default)"],
      "New offers only the native target the fresh probe found, with Pi first");
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.equal(call.workspace, process.cwd(), "the local probe uses the host startup cwd, not the workspace field");
      assert.deepEqual(Object.keys(call.request).sort(), ["env", "targetId", "workspace"],
        "a pure descriptor probe: no hook, startup request, or restoration");
    }
    harness.terminal.emitInput(ESC);
    await nextTurn();

    const parent = await localParent(harness, manager);
    const createsBefore = manager.createOptions.length;
    assert.deepEqual((await inspect(manager, parent)).ownKinds, ["pi", "codex"]);
    assert.equal(await routed(manager)(parent, { workspace: "/w", title: "t", prompt: "p", kind: "claude" }, () => true), "failed",
      "an own-host native spawn of an unavailable kind creates nothing");
    assert.equal(manager.createOptions.length, createsBefore);
    const runId = ownerRun(peer);
    assert.deepEqual(await ownerSpawn(peer)({ hostRunId: runId, kind: "claude", workspace: "/w", title: "t", prompt: "p" }, () => true),
      { kind: "refused" }, "the owner's prompted native spawn re-checks availability before any create");
    assert.equal(manager.createOptions.length, createsBefore);
    const catalog = (peer.options as unknown as { nativeCliTargets: () => Promise<readonly { id: string }[]> }).nativeCliTargets;
    assert.deepEqual((await catalog()).map((target) => target.id), ["codex"], "the advertised catalog is the same fresh probe");

    installed.add("claude");
    assert.deepEqual((await inspect(manager, parent)).ownKinds, ["pi", "claude", "codex"], "an install is seen by the next probe");
    await openNew(harness);
    assert.deepEqual(await offeredProviders(harness), ["Pi", "Claude Code (default)", "Codex CLI (default)"]);
    harness.terminal.emitInput(ESC);
    await nextTurn();
    installed.delete("codex");
    assert.deepEqual((await inspect(manager, parent)).ownKinds, ["pi", "claude"], "and a removal too");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

test("a late New-form probe for a closed form changes nothing and never retargets focus or falls back", async (t) => {
  let gate: (() => void) | undefined;
  const hold = new Promise<void>((resolve) => { gate = resolve; });
  const dependencies: MainTestDependencies = {
    nativeCliHosting: () => ({
      targets: TARGETS,
      launch: async (backend: "claude" | "codex", request: { workspace: string; env: NodeJS.ProcessEnv }) => {
        await hold;
        return { file: `/synthetic/${backend}`, args: [], env: { ...request.env }, cwd: request.workspace };
      },
    }),
  };
  const { harness, manager } = await discoveryHarness(t, [], dependencies);
  try {
    await openNew(harness);
    assert.deepEqual(await offeredProviders(harness), [], "no unprobed native choice is drawn while the probe is pending");
    harness.terminal.emitInput(ESC);
    await nextTurn();
    const focus = harness.sidebar!.focus;
    const selected = harness.sidebar!.selectedId;
    gate!();
    for (let step = 0; step < 4; step += 1) await nextTurn();
    assert.equal(harness.sidebar!.focus, focus, "the late probe moves no focus");
    assert.equal(harness.sidebar!.selectedId, selected, "and selects nothing");
    assert.doesNotMatch(plainText(harness), /Provider:/, "and opens or draws nothing");
    assert.deepEqual(manager.createOptions, [], "and creates nothing");
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});

function plainText(harness: Harness): string {
  return (harness.writer.frames.at(-1)?.frame.lines ?? []).map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
}

test("SessionHosts re-proves every paired observation at its final boundary, after other waits finish", async (t) => {
  const hostA = probedHost("lab-a", "Lab Alpha", "run-a");
  const hostB = probedHost("lab-b", "Lab Beta", "run-b");
  const { harness, peer, manager } = await discoveryHarness(t, [hostA, hostB]);
  try {
    peer.supported = new Set(["lab-a", "lab-b"]);
    const parent = await localParent(harness, manager);
    const holdA = (): { release: () => void } => {
      let release!: () => void;
      peer.refreshResults.set("lab-a", () => new Promise((resolve) => {
        release = () => resolve({ kind: "refreshed", hostRunId: "run-a" });
      }));
      return { release: () => release() };
    };
    peer.refreshResults.set("lab-b", { kind: "refreshed", hostRunId: "run-b" });

    // B completes, then changes run while A is still pending: never reported with B's old kinds.
    let held = holdA();
    let pending = inspect(manager, parent);
    for (let step = 0; step < 3; step += 1) await nextTurn();
    peer.publish({ hosts: [hostA, probedHost("lab-b", "Lab Beta", "run-b2")] });
    held.release();
    await assert.rejects(() => pending, "a completed observation invalidated during another wait is unavailable, not stale");

    // B completes, then withdraws a native target while A is pending.
    peer.publish({ hosts: [hostA, hostB] });
    held = holdA();
    pending = inspect(manager, parent);
    for (let step = 0; step < 3; step += 1) await nextTurn();
    peer.publish({ hosts: [hostA, probedHost("lab-b", "Lab Beta", "run-b", [OWNER_TARGETS[1]!])] });
    held.release();
    await assert.rejects(() => pending, "a changed native description is never reported with the earlier kinds");

    // B completes, then disconnects while A is pending: it is positively gone, so it is omitted.
    peer.publish({ hosts: [hostA, hostB] });
    held = holdA();
    pending = inspect(manager, parent);
    for (let step = 0; step < 3; step += 1) await nextTurn();
    peer.publish({ hosts: [hostA, { ...hostB, state: "disconnected" } as PeerUiHost] });
    held.release();
    assert.deepEqual((await pending).hosts, [{ id: "lab-a", kinds: ["pi", "claude", "codex"] }],
      "a destination that disconnected meanwhile is not listed");
    assert.deepEqual(peer.spawns, []);
    assert.deepEqual(peer.commands, []);
  } finally {
    assert.equal(await closeWithSignal(harness), 0);
  }
});
