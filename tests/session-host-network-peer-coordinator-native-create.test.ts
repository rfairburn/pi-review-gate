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
	OwnerSessionSpawnRequest,
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
import type { PeerByteChannel } from "../src/session-host/network/channel";
import { decodeRosterBridgeFrame } from "../src/session-host/network/roster-bridge-protocol";
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
		readonly nativeCliAvailability?: boolean;
		readonly renameNativeOwnedSession?: PeerCoordinatorOptions["renameNativeOwnedSession"];
		readonly renameOwnedSession?: PeerCoordinatorOptions["renameOwnedSession"];
		readonly createOwnedSession?: PeerCoordinatorOptions["createOwnedSession"];
		readonly spawnOwnedSession?: PeerCoordinatorOptions["spawnOwnedSession"];
		readonly createWorkspaceSupported?: boolean;
		readonly wrapClientChannel?: PeerCoordinatorTestHooks["wrapClientChannel"];
	},
): Promise<Started> {
	const log = createSnapshotLog();
	const coordinator = createPeerCoordinator({
		agentDir: options.agentDir,
		inventory: options.inventory,
		onChange: log.onChange,
		onIncomingConsentArrival: log.onArrival,
		testHooks: options.wrapClientChannel === undefined
			? hooks()
			: { ...hooks(), wrapClientChannel: options.wrapClientChannel },
		...(options.createOwnedSession === undefined ? {} : { createOwnedSession: options.createOwnedSession }),
		...(options.spawnOwnedSession === undefined ? {} : { spawnOwnedSession: options.spawnOwnedSession }),
		...(options.nativeCreateOwnedSession === undefined
			? {}
			: { nativeCreateOwnedSession: options.nativeCreateOwnedSession }),
		...(options.nativeCliTargets === undefined ? {} : { nativeCliTargets: options.nativeCliTargets }),
		...(options.nativeCliAvailability === undefined ? {} : { nativeCliAvailability: options.nativeCliAvailability }),
		...(options.renameNativeOwnedSession === undefined
			? {}
			: { renameNativeOwnedSession: options.renameNativeOwnedSession }),
		...(options.renameOwnedSession === undefined ? {} : { renameOwnedSession: options.renameOwnedSession }),
		...(options.createWorkspaceSupported === undefined ? {} : { createWorkspaceSupported: options.createWorkspaceSupported }),
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
		readonly targets?: PeerCoordinatorOptions["nativeCliTargets"];
		/** With `native`, the owner's explicit fresh-probe declaration. */
		readonly availability?: boolean;
		readonly create?: (request: OwnerNativeCreateRequest, stillAuthorized: () => boolean) => Promise<OwnerCreateFacts>;
		readonly rename?: (request: OwnerNativeRenameRequest, stillAuthorized: () => boolean) => Promise<OwnerNativeRenameFacts>;
		readonly renamePi?: PeerCoordinatorOptions["renameOwnedSession"];
		readonly createPi?: PeerCoordinatorOptions["createOwnedSession"];
		readonly spawn?: PeerCoordinatorOptions["spawnOwnedSession"];
		/** The owner's explicit workspace-creation declaration (#493). */
		readonly createWorkspace?: boolean;
		/** Fixture-only wrapper for the REQUESTER's outgoing metadata channel. */
		readonly requesterWrap?: PeerCoordinatorTestHooks["wrapClientChannel"];
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
		...(ownerOptions.spawn === undefined ? {} : { spawnOwnedSession: ownerOptions.spawn }),
		...(ownerOptions.createWorkspace === undefined ? {} : { createWorkspaceSupported: ownerOptions.createWorkspace }),
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
				...(ownerOptions.availability === undefined ? {} : { nativeCliAvailability: ownerOptions.availability }),
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
		...(ownerOptions.requesterWrap === undefined ? {} : { wrapClientChannel: ownerOptions.requesterWrap }),
	});
	const hostId = await addDestination(requester, "Owner host", port as number);
	await connectWithApprovals(requester, owner, hostId);
	const current = await waitCurrentRoster(requester, hostId, "the owner's current roster observation");
	const hostRunId = hostOf(current, hostId).roster.hostRunId;
	assert.equal(typeof hostRunId, "string");
	return { owner, requester, hostId, hostRunId: hostRunId as string, nativeCalls, renameCalls, piRenameCalls, piCalls, guards };
}

const STILL_CURRENT = Object.freeze({ stillCurrent: (): boolean => true });

test("prompted launch reuses the paired coordinator with exact kind/payload and required fences", async t => {
	const calls: OwnerSessionSpawnRequest[] = [];
	const p = await pair(t, [], { spawn: async (request, guard) => {
		assert.equal(guard(), true); calls.push(request);
		return { kind: "started", hostRunId: request.hostRunId, rowId: "spawned" };
	} });
	const controller = p.requester.coordinator.ownerCreate;
	assert.equal(controller.supportsSessionSpawn?.(p.hostId), true);
	const base = { hostId: p.hostId, hostRunId: p.hostRunId, workspace: " /destination/only/宇宙 ",
		title: "Exact title", prompt: "/literal\n@file\n--flag\n😀".repeat(10000) };
	for (const kind of ["pi", "claude", "codex"] as const) {
		assert.deepEqual(await controller.spawnSession?.({ ...base, kind }, STILL_CURRENT), {
			kind: "owner-result", facts: { kind: "started", hostRunId: p.hostRunId, rowId: "spawned" },
		});
	}
	assert.deepEqual(calls, ["pi", "claude", "codex"].map(kind => ({ ...base, kind, hostId: undefined }))
		.map(({ hostId: _hostId, ...request }) => request));
	assert.equal(p.piCalls.length, 0);
	assert.equal(p.nativeCalls.length, 0);
	assert.equal(p.requester.coordinator.content.readContent().state, "none");
	assert.deepEqual(hostOf(p.requester.coordinator.read(), p.hostId).roster.rows, []);
	assert.deepEqual(await controller.spawnSession?.({ ...base, kind: "pi", hostRunId: "replaced-run" }, STILL_CURRENT),
		{ kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await controller.spawnSession?.({ ...base, kind: "pi" }, { stillCurrent: () => false }),
		{ kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await controller.spawnSession?.({ ...base, kind: "pi" }, {} as never),
		{ kind: "not-sent", reason: "invalid-request" });
	assert.equal(calls.length, 3);
});

test("prompted launch never uses blank create on an old paired owner", async t => {
	const p = await pair(t, []);
	const controller = p.requester.coordinator.ownerCreate;
	assert.equal(controller.supportsSessionSpawn?.(p.hostId), false);
	assert.deepEqual(await controller.spawnSession?.({ hostId: p.hostId, hostRunId: p.hostRunId,
		kind: "codex", workspace: "/destination", title: "Title", prompt: "Exact prompt" }, STILL_CURRENT),
		{ kind: "not-sent", reason: "capability-unsupported" });
	assert.equal(p.piCalls.length, 0);
});

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
		// A synchronous, configuration-only owner never claims probed availability.
		availability: "unknown",
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
	assert.deepEqual(host.nativeCli, { supported: false, targets: [], availability: "unknown" });
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
	assert.deepEqual(host.nativeCli, { supported: false, targets: [], availability: "unknown" },
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
	assert.deepEqual(adopted.nativeCli, { supported: true, targets: [CLAUDE_TARGET, CODEX_TARGET, SHARED_TARGET], availability: "unknown" });
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
  assert.deepEqual(legacyHost.nativeCli, { supported: false, targets: [], availability: "unknown" });
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

// ------------------------------------------------- native availability (#493)

async function pollUntil(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 2000 && !predicate(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(predicate(), `timed out waiting for ${message}`);
}

/** The one refresh method this coordinator's controller must expose. */
function refresh(side: Started): (hostId: string) => ReturnType<NonNullable<Started["coordinator"]["ownerCreate"]["refreshNativeTargets"]>> {
	const slot = side.coordinator.ownerCreate.refreshNativeTargets;
	assert.equal(typeof slot, "function", "the create controller exposes the native catalog refresh");
	return slot as (hostId: string) => ReturnType<NonNullable<Started["coordinator"]["ownerCreate"]["refreshNativeTargets"]>>;
}

test("a probing owner is described as probed and an explicit refresh lands only in the roster observation", async (t) => {
	let catalog: readonly RemoteNativeCliTarget[] = [CLAUDE_TARGET, CODEX_TARGET];
	let reads = 0;
	const spawned: OwnerSessionSpawnRequest[] = [];
	const p = await pair(t, [], {
		native: true,
		availability: true,
		targets: async () => {
			reads += 1;
			return catalog;
		},
		spawn: async (request) => {
			spawned.push(request);
			return { kind: "started", hostRunId: request.hostRunId, rowId: "spawned" };
		},
	});
	const before = hostOf(p.requester.coordinator.read(), p.hostId);
	assert.deepEqual(before.nativeCli, { supported: true, targets: [CLAUDE_TARGET, CODEX_TARGET], availability: "probed" });
	const readsBefore = reads;
	catalog = [CODEX_TARGET];
	const refreshed = await refresh(p.requester)(p.hostId);
	assert.deepEqual(refreshed, { kind: "refreshed", hostRunId: p.hostRunId });
	assert.equal(reads, readsBefore + 1, "one fresh probe for the one resubscription; nothing polls");
	const after = hostOf(p.requester.coordinator.read(), p.hostId);
	assert.deepEqual(after.nativeCli, { supported: true, targets: [CODEX_TARGET], availability: "probed" },
		"the refreshed catalog is read from the ordinary roster observation");
	assert.equal(after.state, "connected");
	// The shared create/spawn lane is unaffected once the refresh settled.
	assert.deepEqual(await p.requester.coordinator.ownerCreate.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/owner/child", backend: "codex", targetId: "codex" },
		STILL_CURRENT,
	), { kind: "owner-result", facts: { kind: "started", hostRunId: p.hostRunId, rowId: "native-codex" } });
	// A target the owner's fresh probe withdrew is refused before submission.
	assert.deepEqual(await p.requester.coordinator.ownerCreate.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/owner/child", backend: "claude", targetId: "claude" },
		STILL_CURRENT,
	), { kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await p.requester.coordinator.ownerCreate.spawnSession?.({
		hostId: p.hostId, hostRunId: p.hostRunId, kind: "pi", workspace: "/srv/owner", title: "Title", prompt: "Exact prompt",
	}, STILL_CURRENT), { kind: "owner-result", facts: { kind: "started", hostRunId: p.hostRunId, rowId: "spawned" } });
	assert.equal(spawned.length, 1);
	assert.equal(p.nativeCalls.length, 1);
	assert.deepEqual(p.piCalls, []);
});

test("a configuration-only owner stays unknown and is never refreshed as if probed", async (t) => {
	const p = await pair(t, [], { native: true });
	assert.equal(hostOf(p.requester.coordinator.read(), p.hostId).nativeCli?.availability, "unknown");
	assert.deepEqual(await refresh(p.requester)(p.hostId), { kind: "not-sent", reason: "capability-unsupported" });
	const legacy = await pair(t, []);
	assert.deepEqual(await refresh(legacy.requester)(legacy.hostId), { kind: "not-sent", reason: "capability-unsupported" });
	assert.deepEqual(hostOf(legacy.requester.coordinator.read(), legacy.hostId).nativeCli,
		{ supported: false, targets: [], availability: "unknown" });
});

test("a refresh refuses while a create is in flight, and creates refuse while a refresh is", async (t) => {
	let releaseCreate: ((facts: OwnerCreateFacts) => void) | null = null;
	let holdProbe: ((targets: readonly RemoteNativeCliTarget[]) => void) | null = null;
	let reads = 0;
	const p = await pair(t, [], {
		native: true,
		availability: true,
		targets: () => {
			reads += 1;
			// The create's own probe answers at once; a later publication probe is held.
			if (reads === 3) return new Promise((resolve) => { holdProbe = resolve; });
			return [CLAUDE_TARGET];
		},
		create: (request) => new Promise((resolve) => {
			p.nativeCalls.push(request);
			releaseCreate = resolve;
		}),
	});
	assert.equal(reads, 1);
	const controller = p.requester.coordinator.ownerCreate;
	const creating = controller.createNativeSession!(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/a", backend: "claude", targetId: "claude" },
		STILL_CURRENT,
	);
	await pollUntil(() => releaseCreate !== null, "the owner provider holds the create");
	assert.deepEqual(await refresh(p.requester)(p.hostId), { kind: "not-sent", reason: "busy" },
		"a refresh never retires the subscription a create is answered on");
	(releaseCreate as unknown as (facts: OwnerCreateFacts) => void)(
		{ kind: "started", hostRunId: p.hostRunId, rowId: "native-1" });
	assert.deepEqual(await creating,
		{ kind: "owner-result", facts: { kind: "started", hostRunId: p.hostRunId, rowId: "native-1" } });
	assert.equal(reads, 2);
	const refreshing = refresh(p.requester)(p.hostId);
	await pollUntil(() => holdProbe !== null, "the refresh's publication probe is outstanding");
	assert.deepEqual(await refresh(p.requester)(p.hostId), { kind: "not-sent", reason: "busy" }, "one refresh at a time");
	const target = { hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/b" };
	assert.deepEqual(await controller.createSession(target, STILL_CURRENT), { kind: "not-sent", reason: "busy" });
	assert.deepEqual(await controller.createNativeSession!({ ...target, backend: "claude", targetId: "claude" }, STILL_CURRENT),
		{ kind: "not-sent", reason: "busy" });
	assert.deepEqual(await controller.spawnSession!({ ...target, kind: "pi", title: "T", prompt: "P" }, STILL_CURRENT),
		{ kind: "not-sent", reason: "busy" });
	(holdProbe as unknown as (targets: readonly RemoteNativeCliTarget[]) => void)([CLAUDE_TARGET]);
	assert.deepEqual(await refreshing, { kind: "refreshed", hostRunId: p.hostRunId });
	assert.equal(p.nativeCalls.length, 1, "nothing was queued or replayed behind the refresh");
	assert.deepEqual(p.piCalls, []);
});

test("a refresh never connects, pairs, retries, or falls back for a destination without a live channel", async (t) => {
	const p = await pair(t, [], { native: true, availability: true });
	const ask = refresh(p.requester);
	assert.deepEqual(await ask("no-such-destination"), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await ask("" as string), { kind: "not-sent", reason: "invalid-request" });
	await p.requester.coordinator.perform({ type: "peer-disconnect", hostId: p.hostId });
	assert.deepEqual(await ask(p.hostId), { kind: "not-sent", reason: "target-unavailable" });
	await new Promise((resolve) => setTimeout(resolve, 50));
	const host = hostOf(p.requester.coordinator.read(), p.hostId);
	assert.equal(host.state, "disconnected", "no connection attempt was started on its behalf");
	assert.deepEqual(host.nativeCli, { supported: false, targets: [], availability: "unknown" });
});

test("a failed refresh probe is reported truthfully and leaves no usable catalog", async (t) => {
	let reads = 0;
	const p = await pair(t, [], {
		native: true,
		availability: true,
		targets: async () => {
			reads += 1;
			if (reads > 1) throw new Error("probe unavailable");
			return [CLAUDE_TARGET];
		},
	});
	assert.deepEqual(await refresh(p.requester)(p.hostId), { kind: "failed" });
	const host = hostOf(p.requester.coordinator.read(), p.hostId);
	assert.equal(host.state, "connected", "the channel stays; nothing reconnects or retries");
	assert.notEqual(host.roster.state, "current");
	assert.deepEqual(host.nativeCli, { supported: false, targets: [], availability: "unknown" });
	assert.deepEqual(await p.requester.coordinator.ownerCreate.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/a", backend: "claude", targetId: "claude" },
		STILL_CURRENT,
	), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(p.nativeCalls, []);
});

test("a probing declaration without the native pair, or a non-boolean one, is refused at construction", (t) => {
	const fixture = createOwnedAgentDir(t);
	const base = {
		agentDir: fixture.agentDir,
		inventory: createFakeInventory(),
		onChange: () => undefined,
		onIncomingConsentArrival: () => undefined,
		testHooks: hooks(),
	};
	assert.throws(() => createPeerCoordinator({ ...base, nativeCliAvailability: true }),
		(error: unknown) => error instanceof TypeError);
	assert.throws(() => createPeerCoordinator({
		...base,
		nativeCreateOwnedSession: async () => ({ kind: "refused" }),
		nativeCliTargets: () => [],
		nativeCliAvailability: 1 as never,
	}), (error: unknown) => error instanceof TypeError);
});

/**
 * Fixture-only requester channel that, once armed, withholds incoming roster
 * transfer frames and owner errors and then delivers them ALL synchronously in one
 * batch — exactly what one received socket chunk can do — so a refresh's first
 * fresh snapshot and whatever superseded it are both handled before the refresh's
 * own continuation resumes. Control frames (acks) always pass, so no retirement
 * waits on a held frame.
 */
function batchingWrap(): {
	readonly wrap: (channel: PeerByteChannel) => PeerByteChannel;
	arm(onFirstEnd: () => void, ready: (types: readonly string[]) => boolean): void;
} {
	let armed: { onFirstEnd: () => void; ready: (types: readonly string[]) => boolean; sawEnd: boolean } | null = null;
	const held: Array<{ handler: (bytes: Buffer) => void; bytes: Buffer; type: string }> = [];
	const HELD = new Set(["snapshot_begin", "snapshot_page", "snapshot_end", "error"]);
	return {
		arm(onFirstEnd, ready) {
			armed = { onFirstEnd, ready, sawEnd: false };
		},
		wrap(inner) {
			return {
				get peerKey() { return inner.peerKey; },
				get lane() { return inner.lane; },
				get label() { return inner.label; },
				get bufferedAmount() { return inner.bufferedAmount; },
				get closed() { return inner.closed; },
				send: (bytes) => inner.send(bytes),
				close: () => inner.close(),
				onMessage(handler) {
					return inner.onMessage((bytes) => {
						let type = "";
						try {
							type = decodeRosterBridgeFrame(bytes).type;
						} catch {
							type = "";
						}
						const current = armed;
						if (current === null || !HELD.has(type)) {
							handler(bytes);
							return;
						}
						held.push({ handler, bytes, type });
						if (type === "snapshot_end" && !current.sawEnd) {
							current.sawEnd = true;
							current.onFirstEnd();
						}
						if (!current.ready(held.map((entry) => entry.type))) return;
						armed = null;
						// One synchronous batch: no microtask runs between these deliveries.
						for (const entry of held.splice(0)) entry.handler(entry.bytes);
					});
				},
			};
		},
	};
}

test("a refresh whose first fresh snapshot is superseded in the same batch reports the newer observation", async (t) => {
	let catalog: readonly RemoteNativeCliTarget[] = [CLAUDE_TARGET];
	const batch = batchingWrap();
	const p = await pair(t, [], {
		native: true,
		availability: true,
		targets: async () => catalog,
		requesterWrap: batch.wrap,
	});
	batch.arm(() => {
		// The owner publishes a NEWER snapshot with a newer probed catalog right after
		// the refresh's first one, before the requester has handled either.
		catalog = [CODEX_TARGET];
		p.owner.inventory.setRows([rowView("later-row")]);
	}, (types) => types.filter((type) => type === "snapshot_end").length === 2);
	assert.deepEqual(await refresh(p.requester)(p.hostId), { kind: "refreshed", hostRunId: p.hostRunId });
	const host = hostOf(p.requester.coordinator.read(), p.hostId);
	assert.deepEqual(host.nativeCli, { supported: true, targets: [CODEX_TARGET], availability: "probed" },
		"the refresh never replays its older first snapshot over the newer observation");
	assert.deepEqual(host.roster.rows?.map((row) => row.id), ["later-row"]);
});

test("a refresh whose first fresh snapshot is followed by a terminal owner error reports failure and stays not current", async (t) => {
	const batch = batchingWrap();
	const p = await pair(t, [], {
		native: true,
		availability: true,
		targets: async () => [CLAUDE_TARGET],
		requesterWrap: batch.wrap,
	});
	batch.arm(() => {
		// The owner run is replaced right after the first fresh snapshot: the owner
		// ends that subscription with a terminal error in the same batch.
		p.owner.inventory.setRun("replacement-run");
		p.owner.inventory.setRows([]);
	}, (types) => types.includes("snapshot_end") && types.includes("error"));
	assert.deepEqual(await refresh(p.requester)(p.hostId), { kind: "failed" });
	const host = hostOf(p.requester.coordinator.read(), p.hostId);
	assert.notEqual(host.roster.state, "current", "the old first snapshot is never republished as current");
	assert.deepEqual(host.nativeCli, { supported: false, targets: [], availability: "unknown" });
	assert.deepEqual(await p.requester.coordinator.ownerCreate.createNativeSession?.(
		{ hostId: p.hostId, hostRunId: p.hostRunId, workspace: "/srv/a", backend: "claude", targetId: "claude" },
		STILL_CURRENT,
	), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(p.nativeCalls, []);
});

// --- Opt-in destination workspace creation over the real paired coordinator (#493). ---

test("a declaring owner negotiates workspace creation on every lane and receives the exact intent; false stays legacy", async t => {
	const spawnCalls: OwnerSessionSpawnRequest[] = [];
	const p = await pair(t, [], {
		native: true,
		createWorkspace: true,
		spawn: async (request) => {
			spawnCalls.push(request);
			return { kind: "started", hostRunId: request.hostRunId, rowId: "spawned" };
		},
	});
	const controller = p.requester.coordinator.ownerCreate;
	assert.equal(hostOf(p.requester.coordinator.read(), p.hostId).createWorkspaceSupported, true,
		"the canonical PeerUiHost support field is true for a negotiated owner");
	assert.equal(controller.supportsCreateWorkspace?.(p.hostId), true);
	const workspace = "/only/on/the/owner/new/nested";
	const started = (rowId: string) => ({ kind: "owner-result", facts: { kind: "started", hostRunId: p.hostRunId, rowId } });

	assert.deepEqual(await controller.createSession({ hostId: p.hostId, hostRunId: p.hostRunId, workspace, createWorkspace: true }, STILL_CURRENT), started("pi-row-1"));
	assert.deepEqual(p.piCalls.at(-1), { hostRunId: p.hostRunId, workspace, createWorkspace: true });
	assert.deepEqual(await controller.createSession({ hostId: p.hostId, hostRunId: p.hostRunId, workspace, createWorkspace: false }, STILL_CURRENT), started("pi-row-1"));
	assert.deepEqual(p.piCalls.at(-1), { hostRunId: p.hostRunId, workspace }, "false is the exact legacy owner request");

	assert.deepEqual(await controller.createNativeSession?.({
		hostId: p.hostId, hostRunId: p.hostRunId, workspace, backend: "codex", targetId: "codex", createWorkspace: true,
	}, STILL_CURRENT), started("native-codex"));
	assert.deepEqual(p.nativeCalls.at(-1), { hostRunId: p.hostRunId, workspace, backend: "codex", targetId: "codex", createWorkspace: true });

	for (const kind of ["pi", "claude", "codex"] as const) {
		assert.deepEqual(await controller.spawnSession?.({
			hostId: p.hostId, hostRunId: p.hostRunId, kind, workspace, title: "T", prompt: "P", createWorkspace: true,
		}, STILL_CURRENT), started("spawned"));
		assert.deepEqual(spawnCalls.at(-1), { hostRunId: p.hostRunId, kind, workspace, title: "T", prompt: "P", createWorkspace: true });
	}
	assert.deepEqual(await controller.spawnSession?.({
		hostId: p.hostId, hostRunId: p.hostRunId, kind: "pi", workspace, title: "T", prompt: "P", createWorkspace: false,
	}, STILL_CURRENT), started("spawned"));
	assert.equal(Object.hasOwn(spawnCalls.at(-1)!, "createWorkspace"), false, "false never reaches the owner");
	// Requester-side validation never coerces a non-boolean.
	assert.deepEqual(await controller.createSession({
		hostId: p.hostId, hostRunId: p.hostRunId, workspace, createWorkspace: "yes" as unknown as boolean,
	}, STILL_CURRENT), { kind: "not-sent", reason: "invalid-request" });
});

test("a non-declaring owner never receives creation intent: true is not sent, and default requests are unchanged", async t => {
	const spawnCalls: OwnerSessionSpawnRequest[] = [];
	const p = await pair(t, [], {
		native: true,
		spawn: async (request) => {
			spawnCalls.push(request);
			return { kind: "started", hostRunId: request.hostRunId, rowId: "spawned" };
		},
	});
	const controller = p.requester.coordinator.ownerCreate;
	assert.equal(hostOf(p.requester.coordinator.read(), p.hostId).createWorkspaceSupported, false);
	assert.equal(controller.supportsCreateWorkspace?.(p.hostId), false);
	const workspace = "/owner/new";
	const unsupported = { kind: "not-sent", reason: "capability-unsupported" };
	assert.deepEqual(await controller.createSession({ hostId: p.hostId, hostRunId: p.hostRunId, workspace, createWorkspace: true }, STILL_CURRENT), unsupported);
	assert.deepEqual(await controller.createNativeSession?.({
		hostId: p.hostId, hostRunId: p.hostRunId, workspace, backend: "claude", targetId: "claude", createWorkspace: true,
	}, STILL_CURRENT), unsupported);
	assert.deepEqual(await controller.spawnSession?.({
		hostId: p.hostId, hostRunId: p.hostRunId, kind: "codex", workspace, title: "T", prompt: "P", createWorkspace: true,
	}, STILL_CURRENT), unsupported);
	assert.equal(p.piCalls.length + p.nativeCalls.length + spawnCalls.length, 0, "no owner provider was reached");
	// Default-off requests keep working exactly as before.
	assert.equal((await controller.createSession({ hostId: p.hostId, hostRunId: p.hostRunId, workspace }, STILL_CURRENT)).kind, "owner-result");
	assert.deepEqual(p.piCalls, [{ hostRunId: p.hostRunId, workspace }]);
});
