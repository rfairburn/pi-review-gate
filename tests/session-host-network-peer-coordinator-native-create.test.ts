/**
 * Capability-gated remote native target discovery and creation through the
 * existing peer coordinator (issue #277 network slice).
 *
 * Every case uses the REAL TLS loopback pair, real pairing with its local
 * first-use key consent and the owner's remote directional grant, the real
 * protected trust/preference stores, and the real roster bridge on both sides.
 * Only the session manager (an in-memory read-only inventory) and the owner's
 * native provider plus target catalog (scripted stand-ins for the pair Main
 * injects) are synthetic: no provider CLI, process, filesystem path, or account
 * state outside this process is touched, and no local interactive create, select,
 * or focus path is exercised.
 *
 * What is pinned down here is the coordinator's own contract: the owner's
 * advertised catalog and typed backend rows reach the requester only over the
 * negotiated lane and only with the complete observation that published them; the
 * one create controller's optional native method forwards exactly one owner-
 * advertised backend and target id to the injected provider, once, with the
 * owner's final re-proof; and a legacy, provider-less, stale, unknown, cross-
 * backend, replayed, or concurrent request refuses without a provider call and
 * without ever falling back to a Pi create or a default target.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { NativeInstanceView } from "../src/session-host/instances";
import {
	createPeerCoordinator,
	type PeerCoordinatorOptions,
	type PeerCoordinatorTestHooks,
} from "../src/session-host/network/peer-coordinator";
import type {
	OwnerCreateFacts,
	OwnerNativeCreateRequest,
	RemoteNativeCliTarget,
} from "../src/session-host/network/peer-create";
import type {
	OwnerNativeRenameFacts,
	OwnerNativeRenameRequest,
	PeerNativeRenameTarget,
	PeerRenameController,
} from "../src/session-host/network/peer-rename";
import type { PeerUiHost, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import { createPosixTestPolicy } from "./session-host-network-peer-state-fixtures";
import {
	consentsOf,
	createFakeInventory,
	createOwnedAgentDir,
	createSnapshotLog,
	rowView,
	type FakeInventory,
	type SnapshotLog,
} from "./session-host-network-peer-coordinator-helpers";

function hooks(): PeerCoordinatorTestHooks {
	return {
		preferencesPermissions: createPosixTestPolicy(),
		peerStatePermissions: createPosixTestPolicy(),
	};
}

interface Started {
	readonly coordinator: ReturnType<typeof createPeerCoordinator>;
	readonly log: SnapshotLog;
	readonly inventory: FakeInventory;
}

/**
 * One coordinator with the SAME real stores, bridge, and transport the shared
 * helper builds, plus the optional native owner pair. Kept local so the native
 * lane is exercised without widening a helper other suites share.
 */
async function start(
	t: TestContext,
	options: {
		readonly agentDir: string;
		readonly inventory: FakeInventory;
		readonly nativeCreateOwnedSession?: PeerCoordinatorOptions["nativeCreateOwnedSession"];
		readonly nativeCliTargets?: PeerCoordinatorOptions["nativeCliTargets"];
		readonly renameNativeOwnedSession?: PeerCoordinatorOptions["renameNativeOwnedSession"];
		readonly renameOwnedSession?: PeerCoordinatorOptions["renameOwnedSession"];
		readonly createOwnedSession?: PeerCoordinatorOptions["createOwnedSession"];
	},
): Promise<Started> {
	const log = createSnapshotLog();
	const coordinator = createPeerCoordinator({
		agentDir: options.agentDir,
		inventory: options.inventory,
		onChange: log.onChange,
		onIncomingConsentArrival: log.onArrival,
		testHooks: hooks(),
		...(options.createOwnedSession === undefined ? {} : { createOwnedSession: options.createOwnedSession }),
		...(options.nativeCreateOwnedSession === undefined
			? {}
			: { nativeCreateOwnedSession: options.nativeCreateOwnedSession }),
		...(options.nativeCliTargets === undefined ? {} : { nativeCliTargets: options.nativeCliTargets }),
		...(options.renameNativeOwnedSession === undefined
			? {}
			: { renameNativeOwnedSession: options.renameNativeOwnedSession }),
		...(options.renameOwnedSession === undefined ? {} : { renameOwnedSession: options.renameOwnedSession }),
	});
	t.after(async () => {
		try {
			await coordinator.close();
		} catch {
			// A rejected close is the test's own observed outcome, never a hook failure.
		}
	});
	await coordinator.start();
	return { coordinator, log, inventory: options.inventory };
}

async function addDestination(side: Started, label: string, port: number): Promise<string> {
	await side.coordinator.perform({ type: "peer-add", label, host: "127.0.0.1", port: String(port) });
	const host = side.coordinator.read().hosts?.find((candidate) => candidate.label === label);
	assert.ok(host, "the destination was saved");
	return host.id;
}

async function connectWithApprovals(client: Started, owner: Started, hostId: string): Promise<void> {
	const connecting = client.coordinator.perform({ type: "peer-connect", hostId });
	const withKey = await client.log.waitFor(
		(snapshot) => consentsOf(snapshot, "server-key").length > 0,
		"the local first-use server-key consent",
	);
	const keyConsent = consentsOf(withKey, "server-key")[0];
	assert.ok(keyConsent);
	assert.equal(client.coordinator.decideConsent(keyConsent.id, "approve"), true);
	const withIncoming = await owner.log.waitFor(
		(snapshot) => consentsOf(snapshot, "incoming").length > 0,
		"the owner's receiving consent",
	);
	const incoming = consentsOf(withIncoming, "incoming")[0];
	assert.ok(incoming);
	assert.equal(owner.coordinator.decideConsent(incoming.id, "approve"), true);
	await connecting;
}

function waitCurrentRoster(side: Started, hostId: string, message: string): Promise<PeerUiSnapshot> {
	return side.log.waitFor(
		(snapshot) => {
			const host = snapshot.hosts?.find((candidate) => candidate.id === hostId);
			return host?.state === "connected"
				&& host.roster.state === "current"
				&& typeof host.roster.hostRunId === "string";
		},
		message,
	);
}

function hostOf(snapshot: PeerUiSnapshot, hostId: string): PeerUiHost {
	const host = snapshot.hosts?.find((candidate) => candidate.id === hostId);
	assert.ok(host, "the destination is in the snapshot");
	return host;
}

const CLAUDE_TARGET: RemoteNativeCliTarget = Object.freeze({ id: "claude", backend: "claude", label: "Claude Code (default)" });
const CODEX_TARGET: RemoteNativeCliTarget = Object.freeze({ id: "codex", backend: "codex", label: "Codex CLI (default)" });
const SHARED_TARGET: RemoteNativeCliTarget = Object.freeze({ id: "external:workhorse", backend: "claude", label: "workhorse (Claude)" });

interface Pair {
	readonly owner: Started;
	readonly requester: Started;
	readonly hostId: string;
	readonly hostRunId: string;
	readonly nativeCalls: OwnerNativeCreateRequest[];
	readonly renameCalls: OwnerNativeRenameRequest[];
	readonly piRenameCalls: unknown[];
	readonly piCalls: unknown[];
	readonly guards: boolean[];
}

/**
 * One owner hosting an empty roster plus one connected requester holding one
 * authoritative observation of the owner's run. The native pair is injected only
 * when `native` is true, which is exactly the legacy-owner control case.
 */
async function pair(
	t: TestContext,
	ownerRows: readonly NativeInstanceView[],
	ownerOptions: {
		readonly native?: boolean;
		/** With `native`, omit the host-name provider while keeping the create pair. */
		readonly nameLane?: boolean;
		readonly targets?: () => readonly RemoteNativeCliTarget[];
		readonly create?: (request: OwnerNativeCreateRequest, stillAuthorized: () => boolean) => Promise<OwnerCreateFacts>;
		readonly rename?: (request: OwnerNativeRenameRequest, stillAuthorized: () => boolean) => Promise<OwnerNativeRenameFacts>;
		readonly renamePi?: PeerCoordinatorOptions["renameOwnedSession"];
		readonly createPi?: PeerCoordinatorOptions["createOwnedSession"];
	} = {},
): Promise<Pair> {
	const ownerFixture = createOwnedAgentDir(t);
	const requesterFixture = createOwnedAgentDir(t);
	const nativeCalls: OwnerNativeCreateRequest[] = [];
	const renameCalls: OwnerNativeRenameRequest[] = [];
	const piRenameCalls: unknown[] = [];
	const piCalls: unknown[] = [];
	const guards: boolean[] = [];
	const ownerInventory = createFakeInventory(ownerRows);
	const owner = await start(t, {
		agentDir: ownerFixture.agentDir,
		inventory: ownerInventory,
		// The Pi provider is always present, so the Pi create lane stays live and
		// any native refusal can be shown NOT to fall through to it.
		createOwnedSession: ownerOptions.createPi ?? (async (request) => {
			piCalls.push(request);
			return { kind: "started", hostRunId: request.hostRunId, rowId: "pi-row-1" };
		}),
		// The Pi conversation rename stays live on the owner, so any native refusal
		// can be shown NOT to fall through to it.
		renameOwnedSession: ownerOptions.renamePi ?? (async (request) => {
			piRenameCalls.push(request);
			return { kind: "renamed", hostRunId: request.hostRunId, rowId: request.rowId };
		}),
		...(ownerOptions.native === true
			? {
				nativeCliTargets: ownerOptions.targets ?? (() => [CLAUDE_TARGET, CODEX_TARGET, SHARED_TARGET]),
				nativeCreateOwnedSession: ownerOptions.create ?? (async (request, stillAuthorized) => {
					nativeCalls.push(request);
					guards.push(stillAuthorized());
					return { kind: "started", hostRunId: request.hostRunId, rowId: `native-${request.targetId}` };
				}),
				...(ownerOptions.nameLane === false
					? {}
					: {
						renameNativeOwnedSession: ownerOptions.rename ?? (async (request, stillAuthorized) => {
							renameCalls.push(request);
							guards.push(stillAuthorized());
							return { kind: "renamed-durable" };
						}),
					}),
			}
			: {}),
	});
	await owner.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	const port = owner.coordinator.read().listener.port;
	assert.equal(typeof port, "number", "the owner listener published a loopback port");
	const requester = await start(t, {
		agentDir: requesterFixture.agentDir,
		inventory: createFakeInventory(),
	});
	const hostId = await addDestination(requester, "Owner host", port as number);
	await connectWithApprovals(requester, owner, hostId);
	const current = await waitCurrentRoster(requester, hostId, "the owner's current roster observation");
	const hostRunId = hostOf(current, hostId).roster.hostRunId;
	assert.equal(typeof hostRunId, "string");
	return { owner, requester, hostId, hostRunId: hostRunId as string, nativeCalls, renameCalls, piRenameCalls, piCalls, guards };
}

const STILL_CURRENT = Object.freeze({ stillCurrent: (): boolean => true });

/** The one native host-name method this coordinator's controller must expose. */
function nativeRename(
	side: Started,
): NonNullable<ReturnType<typeof renameSlot>> {
	const slot = side.coordinator.ownerRename.renameNativeSession;
	assert.equal(typeof slot, "function", "the rename controller exposes the native host-name lane");
	return slot as NonNullable<ReturnType<typeof renameSlot>>;
}

function renameSlot(side: Started): undefined | PeerRenameController["renameNativeSession"] {
	return side.coordinator.ownerRename.renameNativeSession;
}


test("a connected owner advertises its default and explicit shared targets, and types its native rows", async (t) => {
	const rows = [
		rowView("pi-row"),
		rowView("claude-row", { backend: "claude", label: "Claude Code" }),
		rowView("codex-row", { backend: "codex", label: "Codex CLI" }),
	];
	const p = await pair(t, rows, { native: true });
	const host = hostOf(p.requester.coordinator.read(), p.hostId);
	assert.deepEqual(host.nativeCli, {
		supported: true,
		targets: [CLAUDE_TARGET, CODEX_TARGET, SHARED_TARGET],
	}, "the two defaults plus the owner's explicit shared entry, in the owner's order");
	assert.deepEqual(host.roster.rows?.map((row) => [row.id, row.backend ?? "<absent>"]), [
		["pi-row", "<absent>"],
		["claude-row", "claude"],
		["codex-row", "codex"],
	], "a typed native row keeps its backend; an older row stays the legacy Pi row");
	// A descriptor is id/backend/label only: no command, environment, or path.
	for (const target of host.nativeCli?.targets ?? []) {
		assert.deepEqual(Object.keys(target).sort(), ["backend", "id", "label"]);
	}
	// Two configured entries with the SAME display name across requester and owner
	// stay distinct by identity, and a label is never a routing target.
	assert.notEqual(
		findTarget(host.nativeCli?.targets ?? [], "claude")?.label,
		findTarget(host.nativeCli?.targets ?? [], "external:workhorse")?.id,
	);
});

function findTarget(targets: readonly RemoteNativeCliTarget[], id: string): RemoteNativeCliTarget | undefined {
	return targets.find((target) => target.id === id);
}

test("a legacy owner with no native pair is described unsupported and offers no target", async (t) => {
	const p = await pair(t, [rowView("claude-row", { backend: "claude" })], { native: false });
	const host = hostOf(p.requester.coordinator.read(), p.hostId);
	assert.deepEqual(host.nativeCli, { supported: false, targets: [] });
	// The unnegotiated row keeps the pre-native shape: no backend key at all.
	assert.equal(Object.prototype.hasOwnProperty.call(host.roster.rows?.[0] ?? {}, "backend"), false);
	assert.deepEqual(await p.requester.coordinator.ownerCreate.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/owner/child", backend: "claude", targetId: "claude" },
		STILL_CURRENT,
	), { kind: "not-sent", reason: "capability-unsupported" });
	// The Pi create lane is untouched by any of it.
	assert.deepEqual(await p.requester.coordinator.ownerCreate.createSession(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/owner/child" },
		STILL_CURRENT,
	), { kind: "owner-result", facts: { kind: "started", hostRunId: p.hostRunId, rowId: "pi-row-1" } });
});

test("a native create invokes the injected provider once with the exact fields and final re-proof", async (t) => {
	const p = await pair(t, [], { native: true });
	const before = p.requester.coordinator.read();
	assert.equal(hostOf(before, p.hostId).roster.rows?.length, 0);
	assert.equal(p.requester.coordinator.content.readContent().state, "none");
	const result = await p.requester.coordinator.ownerCreate.createNativeSession?.(
		{
			hostId: p.hostId,
			hostRunId: p.hostRunId,
			workspace: "/srv/owner/a child with spaces",
			backend: "claude",
			targetId: "external:workhorse",
		},
		STILL_CURRENT,
	);
	assert.deepEqual(result, {
		kind: "owner-result",
		facts: { kind: "started", hostRunId: p.hostRunId, rowId: "native-external:workhorse" },
	});
	assert.deepEqual(p.nativeCalls, [{
		hostRunId: p.hostRunId,
		workspace: "/srv/owner/a child with spaces",
		backend: "claude",
		targetId: "external:workhorse",
	}], "the exact owner run, verbatim workspace, backend, and owner-advertised target reach the provider");
	assert.deepEqual(p.guards, [true], "the provider is handed the owner's live final re-proof");
	assert.deepEqual(p.piCalls, [], "a native create never falls through to the Pi provider");
	// Nothing was created, selected, or focused locally, and the owner UI is not
	// driven by this side: only the owner's own authoritative roster can add a row.
	const after = hostOf(p.requester.coordinator.read(), p.hostId);
	assert.deepEqual(after.roster.rows, []);
	assert.equal(p.requester.coordinator.content.readContent().target, null);
	// The owner's own inventory remains the only thing that can produce a row.
	await p.owner.inventory.setRows([rowView("native-row-1", { backend: "claude" })]);
	await p.requester.log.waitFor(
		(snapshot) => hostOf(snapshot, p.hostId).roster.rows?.length === 1,
		"the owner's own new row reaches the projection",
	);
	assert.deepEqual(hostOf(p.requester.coordinator.read(), p.hostId).roster.rows?.map((row) => [row.id, row.backend]), [
		["native-row-1", "claude"],
	]);
});

test("an unknown or cross-backend target is refused before submission, with no fallback", async (t) => {
	const p = await pair(t, [], { native: true });
	const controller = p.requester.coordinator.ownerCreate;
	// A requester-side configured target id is never addressable on the owner.
	assert.deepEqual(await controller.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/owner/child", backend: "claude", targetId: "my-local-claude" },
		STILL_CURRENT,
	), { kind: "not-sent", reason: "invalid-request" });
	// An id the owner advertised under the other backend never matches.
	assert.deepEqual(await controller.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/owner/child", backend: "codex", targetId: "external:workhorse" },
		STILL_CURRENT,
	), { kind: "not-sent", reason: "invalid-request" });
	// Pi is not a native backend, and a malformed request never reaches the wire.
	assert.deepEqual(await controller.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/owner/child", backend: "pi" as never, targetId: "claude" },
		STILL_CURRENT,
	), { kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await controller.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "", backend: "claude", targetId: "claude" },
		STILL_CURRENT,
	), { kind: "not-sent", reason: "invalid-request" });
	// Another run, a missing destination, and a caller without its own proof.
	assert.deepEqual(await controller.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: "other-run", workspace: "/srv/owner/child", backend: "claude", targetId: "claude" },
		STILL_CURRENT,
	), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await controller.createNativeSession?.(
		{ hostId: "not-a-host", hostRunId: p.hostRunId, workspace: "/srv/owner/child", backend: "claude", targetId: "claude" },
		STILL_CURRENT,
	), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await controller.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/owner/child", backend: "claude", targetId: "claude" },
		{} as never,
	), { kind: "not-sent", reason: "invalid-request" });
	// A proof that no longer holds refuses before submission.
	assert.deepEqual(await controller.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/owner/child", backend: "claude", targetId: "claude" },
		{ stillCurrent: () => false },
	), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(p.nativeCalls, [], "no unusable request is ever forwarded or retargeted");
	assert.deepEqual(p.piCalls, [], "and none of it becomes a Pi create");
});

test("a disconnected destination loses its catalog and cannot be addressed natively", async (t) => {
	const p = await pair(t, [], { native: true });
	assert.equal(hostOf(p.requester.coordinator.read(), p.hostId).nativeCli?.supported, true);
	await p.requester.coordinator.perform({ type: "peer-disconnect", hostId: p.hostId });
	const host = hostOf(p.requester.coordinator.read(), p.hostId);
	assert.equal(host.state, "disconnected");
	assert.deepEqual(host.nativeCli, { supported: false, targets: [] },
		"a lost run's target list never survives as a selectable choice");
	assert.deepEqual(await p.requester.coordinator.ownerCreate.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/owner/child", backend: "claude", targetId: "claude" },
		STILL_CURRENT,
	), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(p.nativeCalls, [], "a disconnected destination is never addressed");
});

test("one create is in flight per destination across both lanes", async (t) => {
	let releasePi: () => void = () => undefined;
	const piGate = new Promise<void>((resolve) => { releasePi = resolve; });
	const p = await pair(t, [], {
		native: true,
		createPi: async (request) => {
			p.piCalls.push(request);
			await piGate;
			return { kind: "started", hostRunId: request.hostRunId, rowId: "pi-row-1" };
		},
	});
	const controller = p.requester.coordinator.ownerCreate;
	const pendingPi = controller.createSession(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/owner/first" },
		STILL_CURRENT,
	);
	for (let attempt = 0; attempt < 2_000 && p.piCalls.length === 0; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.equal(p.piCalls.length, 1, "the Pi create reached the owner's provider");
	// A native create while the Pi create is live cannot bypass the ordering.
	assert.deepEqual(await controller.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/owner/second", backend: "claude", targetId: "claude" },
		STILL_CURRENT,
	), { kind: "not-sent", reason: "busy" });
	assert.deepEqual(p.nativeCalls, [], "the refused native create never reached the native provider");
	releasePi();
	assert.deepEqual(await pendingPi, {
		kind: "owner-result",
		facts: { kind: "started", hostRunId: p.hostRunId, rowId: "pi-row-1" },
	});
	// Once it settles, the next attempt is a fresh one on the same lane.
	assert.deepEqual(await controller.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/owner/second", backend: "claude", targetId: "claude" },
		STILL_CURRENT,
	), { kind: "owner-result", facts: { kind: "started", hostRunId: p.hostRunId, rowId: "native-claude" } });
});

test("a coordinator that is closing never submits a native create", async (t) => {
	const p = await pair(t, [], { native: true });
	await p.requester.coordinator.close();
	assert.deepEqual(await p.requester.coordinator.ownerCreate.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/owner/child", backend: "claude", targetId: "claude" },
		STILL_CURRENT,
	), { kind: "not-sent", reason: "not-ready" });
	assert.deepEqual(p.nativeCalls, []);
});

test("a native create never names a run the destination no longer observes", async (t) => {
	const p = await pair(t, [], { native: true });
	const oldRun = p.hostRunId;
	p.owner.inventory.setRun("owner-run-b");
	await p.requester.coordinator.perform({ type: "peer-disconnect", hostId: p.hostId });
	await p.requester.coordinator.perform({ type: "peer-connect", hostId: p.hostId });
	await waitCurrentRoster(p.requester, p.hostId, "the destination's adopted owner run");
	const adopted = hostOf(p.requester.coordinator.read(), p.hostId);
	assert.equal(adopted.roster.hostRunId, "owner-run-b");
	// A request built from the previous observation is refused before submission,
	// even though the caller's own proof still answers true.
	assert.deepEqual(await p.requester.coordinator.ownerCreate.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: oldRun, workspace: "/srv/owner/old-run", backend: "claude", targetId: "claude" },
		STILL_CURRENT,
	), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(p.nativeCalls, [], "no native frame is submitted for a run this side no longer observes");
	// The newly adopted run's own catalog is what the fresh observation carries.
	assert.deepEqual(adopted.nativeCli, { supported: true, targets: [CLAUDE_TARGET, CODEX_TARGET, SHARED_TARGET] });
});

test("a half native pair is refused at construction rather than defaulted", () => {
	// Validation is pure and happens before any store, listener, or callback is
	// created, so nothing here opens a directory or starts anything.
	const base = {
		agentDir: "/private/tmp/never-opened-by-this-test",
		inventory: createFakeInventory(),
		onChange: (): void => undefined,
		onIncomingConsentArrival: (): void => undefined,
	};
	assert.throws(
		() => createPeerCoordinator({
			...base,
			nativeCreateOwnedSession: async () => ({ kind: "refused" as const }),
		}),
		(error: unknown) => error instanceof TypeError,
	);
	assert.throws(
		() => createPeerCoordinator({
			...base,
			nativeCliTargets: () => [CLAUDE_TARGET],
		}),
		(error: unknown) => error instanceof TypeError,
	);
});

// ------------------------------------------------ requester-side HOST ROW NAME

/**
 * The requester's half of the separate native HOST ROW NAME lane: the one
 * controller's optional `renameNativeSession`, its fences, and what it refuses.
 */

function renameTarget(
  pairValue: Pair,
  rowId = "native-row",
  over: Partial<OwnerNativeRenameRequest> = {},
): PeerNativeRenameTarget {
  return {
    hostId: pairValue.hostId,
    hostRunId: pairValue.hostRunId,
    rowId,
    backend: "claude",
    name: "Renamed row",
    ...over,
  };
}

test("the owner's native name lane is described on the peer DTO, and a legacy owner is not", async (t) => {
  const withName = await pair(t, [rowView("native-row", { backend: "claude" })], { native: true });
  const described = hostOf(withName.requester.log.latest(), withName.hostId);
  assert.equal(described.nativeNameSupported, true,
    "an owner that negotiated the name lane is described as supporting it");
  assert.equal(described.nativeCli?.supported, true);

  const legacy = await pair(t, [rowView("native-row")], {});
  const legacyHost = hostOf(legacy.requester.log.latest(), legacy.hostId);
  assert.notEqual(legacyHost.nativeNameSupported, true,
    "a provider-less owner is never described as name-capable");
  assert.deepEqual(legacyHost.nativeCli, { supported: false, targets: [] });
});

test("a host name reaches the owner's provider once with the exact fields and re-proof", async (t) => {
  const p = await pair(t, [rowView("native-row", { backend: "claude" })], { native: true });
  const result = await nativeRename(p.requester)(renameTarget(p), STILL_CURRENT);
  assert.deepEqual(result, { kind: "owner-result", facts: { kind: "renamed-durable" } });
  assert.deepEqual(p.renameCalls, [{
    hostRunId: p.hostRunId,
    rowId: "native-row",
    backend: "claude",
    name: "Renamed row",
  }], "the exact run, row, observed backend, and verbatim caption reach the owner");
  assert.deepEqual(p.guards, [true], "the provider is handed the owner's live re-proof");
  assert.deepEqual(p.piRenameCalls, [], "the Pi conversation rename is never substituted");
});

test("the owner's four persistence truths reach the requester distinctly", async (t) => {
  for (const kind of ["renamed-durable", "renamed-in-memory", "refused", "unknown"] as const) {
    const p = await pair(t, [rowView("native-row", { backend: "claude" })], {
      native: true,
      rename: async () => ({ kind }),
    });
    const result = await nativeRename(p.requester)(renameTarget(p), STILL_CURRENT);
    assert.deepEqual(result, { kind: "owner-result", facts: { kind } }, `${kind} stays itself`);
  }
});

test("a host name is refused without a provider call when the row, backend, or run moved", async (t) => {
  const p = await pair(t, [rowView("native-row", { backend: "claude" })], { native: true });
  // A row this side never observed.
  assert.deepEqual(await nativeRename(p.requester)(renameTarget(p, "row-9"), STILL_CURRENT),
    { kind: "not-sent", reason: "target-unavailable" });
  // A backend the observed row does not report: never inferred from a caption.
  assert.deepEqual(await nativeRename(p.requester)(
    renameTarget(p, "native-row", { backend: "codex" }), STILL_CURRENT,
  ), { kind: "not-sent", reason: "target-unavailable" });
  // A Pi row is never a native host-name target.
  assert.deepEqual(await nativeRename(p.requester)(
    renameTarget(p, "pi-row", { backend: "claude" }), STILL_CURRENT,
  ), { kind: "not-sent", reason: "target-unavailable" });
  // The caller's own written-editor proof is required, not optional.
  assert.deepEqual(await nativeRename(p.requester)(renameTarget(p), {
    stillCurrent: (): boolean => false,
  }), { kind: "not-sent", reason: "target-unavailable" });
  assert.deepEqual(p.renameCalls, [], "none of these reached the owner's provider");
  assert.deepEqual(p.piRenameCalls, [], "and none of them became a Pi rename");
});

test("an owner with the create pair but no host-name provider is refused, never Pi-renamed", async (t) => {
  // The requester DOES observe a typed native row, so this refusal is the
  // capability itself and not a stale row: the owner never acknowledged the name
  // lane, so no host-name frame exists to send at all.
  const p = await pair(t, [rowView("native-row", { backend: "claude" })], {
    native: true,
    nameLane: false,
  });
  const described = hostOf(p.requester.log.latest(), p.hostId);
  assert.equal(described.nativeCli?.supported, true, "the create lane is live");
  assert.notEqual(described.nativeNameSupported, true, "the name lane is not claimed");
  const result = await nativeRename(p.requester)(renameTarget(p), STILL_CURRENT);
  assert.deepEqual(result, { kind: "not-sent", reason: "capability-unsupported" });
  assert.deepEqual(p.renameCalls, []);
  assert.deepEqual(p.piRenameCalls, [], "no Pi conversation rename is attempted instead");
});

test("a fully legacy owner's untyped row is never a native host-name target", async (t) => {
  const p = await pair(t, [rowView("native-row")], {});
  const result = await nativeRename(p.requester)(renameTarget(p), STILL_CURRENT);
  assert.deepEqual(result, { kind: "not-sent", reason: "target-unavailable" },
    "a row this side never observed as native is refused outright");
  assert.deepEqual(p.renameCalls, []);
  assert.deepEqual(p.piRenameCalls, [], "and no Pi conversation rename is attempted instead");
});

test("a host name whose caller proof or row moves mid-flight is never reported as renamed", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const p = await pair(t, [rowView("native-row", { backend: "claude" })], {
    native: true,
    rename: async (request, stillAuthorized) => {
      await gate;
      // The owner still applies its caption; this side's fence is what moved.
      assert.equal(stillAuthorized(), true);
      return { kind: "renamed-durable" };
    },
  });
  let holds = true;
  const pending = nativeRename(p.requester)(renameTarget(p), { stillCurrent: () => holds });
  // The owner's own row stops being the observed backend while the request waits.
  p.owner.inventory.setRows([rowView("native-row", { backend: "codex" })]);
  await new Promise((resolve) => setTimeout(resolve, 25));
  holds = false;
  release();
  const result = await pending;
  assert.ok(result.kind === "unknown" || result.kind === "not-sent",
    `a fence that moved never claims success, got ${result.kind}`);
  if (result.kind === "not-sent") {
    assert.equal(result.reason, "target-unavailable");
  }
});
