/**
 * Owner-routed rename through the existing peer coordinator (issue #512).
 *
 * Every case uses the REAL TLS loopback pair, real pairing with its local
 * first-use key consent and remote directional grant, the real protected
 * trust/preference stores, the real roster bridge on both sides, and the real
 * coordinator. Only the session manager (an in-memory read-only inventory) and
 * the owner's rename provider (a scripted stand-in for Main's verified
 * manager.rename) are synthetic: no native conversation, saved session, process,
 * or account state outside this process is touched.
 *
 * These are protocol-routing witnesses, not native or cross-machine
 * certification. The assertions cover the coordinator's own contract: one exact
 * observed run/row/native tuple is forwarded to the owner's provider, the
 * owner's authoritative metadata is the only thing that changes an observed
 * name, two observers see that fan-out, and stale, reentered, delayed, replaced,
 * disconnected, revoked, or unsupported requests fail closed without retargeting
 * or replay.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { NativeInstanceView } from "../src/session-host/instances";
import type { PeerByteChannel } from "../src/session-host/network/channel";
import type {
	OwnerRenameAuthorizationGuard,
	OwnerRenameRequest,
	PeerRenameNotSentReason,
	PeerRenameTarget,
} from "../src/session-host/network/peer-rename";
import {
	createPeerCoordinator,
	type PeerCoordinatorOptions,
	type PeerCoordinatorTestHooks,
} from "../src/session-host/network/peer-coordinator";
import { decodeRosterBridgeFrame } from "../src/session-host/network/roster-bridge-protocol";
import type { PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import { createPosixTestPolicy } from "./session-host-network-peer-state-fixtures";
import {
	consentsOf,
	createFakeInventory,
	createOwnedAgentDir,
	rowView,
	startCoordinator,
	type FakeInventory,
	type StartedCoordinator,
} from "./session-host-network-peer-coordinator-helpers";

function hooks(): PeerCoordinatorTestHooks {
	return {
		preferencesPermissions: createPosixTestPolicy(),
		peerStatePermissions: createPosixTestPolicy(),
	};
}

/** One canonical row whose display label and native name are the same fact. */
function rowNamed(id: string, sessionId: string, epoch: number, name: string): NativeInstanceView {
	return rowView(id, {
		label: name,
		nativeSession: { sessionId, epoch, name },
	});
}

function listenerPort(owner: StartedCoordinator): number {
	const port = owner.coordinator.read().listener.port;
	assert.ok(typeof port === "number", "the owner listener did not publish a loopback port");
	return port;
}

async function addDestination(
	side: StartedCoordinator,
	label: string,
	port: number,
): Promise<string> {
	await side.coordinator.perform({ type: "peer-add", label, host: "127.0.0.1", port: String(port) });
	const host = side.coordinator.read().hosts?.find((candidate) => candidate.label === label);
	assert.ok(host, "the destination was saved");
	assert.equal(host.port, port);
	return host.id;
}

/** Connect and approve the local first-use key plus the owner's human window. */
async function connectWithApprovals(
	clientSide: StartedCoordinator,
	ownerSide: StartedCoordinator,
	hostId: string,
): Promise<void> {
	const connecting = clientSide.coordinator.perform({ type: "peer-connect", hostId });
	const withKey = await clientSide.log.waitFor(
		(snapshot) => consentsOf(snapshot, "server-key").length > 0,
		"the local first-use server-key consent",
	);
	const keyConsent = consentsOf(withKey, "server-key")[0];
	assert.ok(keyConsent);
	assert.equal(clientSide.coordinator.decideConsent(keyConsent.id, "approve"), true);

	const withIncoming = await ownerSide.log.waitFor(
		(snapshot) => consentsOf(snapshot, "incoming").length > 0,
		"the owner's receiving consent",
	);
	const incoming = consentsOf(withIncoming, "incoming")[0];
	assert.ok(incoming);
	assert.equal(ownerSide.coordinator.decideConsent(incoming.id, "approve"), true);
	await connecting;
}

function waitCurrentRoster(
	side: StartedCoordinator,
	hostId: string,
	message: string,
): Promise<PeerUiSnapshot> {
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

/** One owner hosting with a real TLS listener over a caller-owned inventory. */
async function startOwner(
	t: TestContext,
	options: {
		readonly inventory: FakeInventory;
		readonly renameOwnedSession?: PeerCoordinatorOptions["renameOwnedSession"];
	},
): Promise<StartedCoordinator> {
	const fixture = createOwnedAgentDir(t);
	const owner = await startCoordinator(t, {
		agentDir: fixture.agentDir,
		inventory: options.inventory,
		testHooks: hooks(),
		...(options.renameOwnedSession === undefined
			? {}
			: { renameOwnedSession: options.renameOwnedSession }),
	});
	await owner.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	assert.equal(owner.coordinator.read().listener.state, "listening");
	return owner;
}

/** One requester with its own owned agent directory and no proxy roster. */
async function startRequester(t: TestContext): Promise<StartedCoordinator> {
	const fixture = createOwnedAgentDir(t);
	return startCoordinator(t, {
		agentDir: fixture.agentDir,
		inventory: createFakeInventory(),
		testHooks: hooks(),
	});
}

interface Observer {
	readonly side: StartedCoordinator;
	readonly hostId: string;
}

/** Connect one requester to one owner and hold its first current observation. */
async function connectObserver(
	t: TestContext,
	owner: StartedCoordinator,
	label: string,
): Promise<Observer> {
	const side = await startRequester(t);
	const hostId = await addDestination(side, label, listenerPort(owner));
	await connectWithApprovals(side, owner, hostId);
	await waitCurrentRoster(side, hostId, "the requester's current roster observation");
	return { side, hostId };
}

function hostOf(side: StartedCoordinator, hostId: string) {
	const host = side.coordinator.read().hosts?.find((candidate) => candidate.id === hostId);
	assert.ok(host, "the destination is present in this side's snapshot");
	return host;
}

function observedRow(side: StartedCoordinator, hostId: string, rowId: string) {
	const row = hostOf(side, hostId).roster.rows?.find((candidate) => candidate.id === rowId);
	assert.ok(row, "the requested row is present in the current observation");
	return row;
}

/** Build a target strictly from this side's current observed metadata. */
function targetFrom(
	side: StartedCoordinator,
	hostId: string,
	rowId: string,
	name: string,
): PeerRenameTarget {
	const host = hostOf(side, hostId);
	const row = observedRow(side, hostId, rowId);
	assert.ok(host.roster.hostRunId, "the current observation names an owner run");
	assert.ok(row.nativeSession, "the requested row still names a native conversation");
	return {
		hostId,
		hostRunId: host.roster.hostRunId,
		rowId,
		expectedSessionId: row.nativeSession.sessionId,
		expectedSessionEpoch: row.nativeSession.epoch,
		name,
	};
}

const PROVEN = Object.freeze({ stillCurrent: (): boolean => true });

function renameSupported(side: StartedCoordinator, hostId: string): boolean | undefined {
	return hostOf(side, hostId).renameSupported;
}

function waitObservedName(
	side: StartedCoordinator,
	hostId: string,
	rowId: string,
	name: string,
	message: string,
): Promise<PeerUiSnapshot> {
	return side.log.waitFor(
		(snapshot) => {
			const row = snapshot.hosts?.find((host) => host.id === hostId)
				?.roster.rows?.find((candidate) => candidate.id === rowId);
			return row?.label === name && row.nativeSession?.name === name;
		},
		message,
	);
}

/** Count only the rename frames actually admitted to the wrapped channel. */
function countRenameFrames(): {
	readonly wrap: (channel: PeerByteChannel) => PeerByteChannel;
	readonly count: () => number;
} {
	let frames = 0;
	return {
		wrap: (channel) => ({
			get peerKey() { return channel.peerKey; },
			get lane() { return channel.lane; },
			get label() { return channel.label; },
			get bufferedAmount() { return channel.bufferedAmount; },
			get closed() { return channel.closed; },
			close: () => channel.close(),
			onMessage: (handler) => channel.onMessage(handler),
			send: (bytes) => {
				if (decodeRosterBridgeFrame(bytes).type === "rename_request") frames += 1;
				return channel.send(bytes);
			},
		}),
		count: () => frames,
	};
}

interface RecordedRename {
	readonly request: OwnerRenameRequest;
	readonly authorized: boolean;
}

test("constructor admission accepts only a real rename provider and stores no name", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const base = {
		agentDir: fixture.agentDir,
		inventory: createFakeInventory(),
		onChange: () => undefined,
		onIncomingConsentArrival: () => undefined,
		testHooks: hooks(),
	};
	assert.throws(
		() => createPeerCoordinator({ ...base, renameOwnedSession: 7 as never }),
		TypeError,
	);
	assert.throws(
		() => createPeerCoordinator({ ...base, renameOwnedSession: "rename" as never }),
		TypeError,
	);
	let called = 0;
	const coordinator = createPeerCoordinator({
		...base,
		renameOwnedSession: async () => {
			called += 1;
			return { kind: "refused" };
		},
	});
	assert.equal(called, 0, "construction never calls the provider");
	assert.equal(typeof coordinator.ownerRename.renameSession, "function");
	await coordinator.close();
});

test("one exact observed tuple reaches the owner provider and two observers see only owner metadata", async (t) => {
	const initial = [
		rowNamed("row-1", "session-alpha", 3, "Alpha"),
		rowNamed("row-2", "session-beta", 5, "Beta"),
	];
	let rows: readonly NativeInstanceView[] = initial;
	const calls: RecordedRename[] = [];
	const inventory = createFakeInventory(initial);
	const owner = await startOwner(t, {
		inventory,
		renameOwnedSession: async (request: OwnerRenameRequest, stillAuthorized: OwnerRenameAuthorizationGuard) => {
			calls.push({ request, authorized: stillAuthorized() });
			// This stands in for Main's verified manager.rename: it preserves the
			// exact native id/epoch and stores a canonical name chosen by the owner,
			// deliberately not the requester's spelling. Only owner metadata may
			// ever publish a name.
			rows = rows.map((row) => row.id === request.rowId
				? rowNamed(row.id, request.expectedSessionId, request.expectedSessionEpoch, "Canonical Alpha")
				: row);
			inventory.setRows(rows);
			return { kind: "renamed" };
		},
	});
	const first = await connectObserver(t, owner, "Owner host");
	const second = await connectObserver(t, owner, "Owner host");

	assert.equal(renameSupported(first.side, first.hostId), true, "the owner acknowledged rename");
	assert.equal(renameSupported(second.side, second.hostId), true);
	const hostRunId = hostOf(first.side, first.hostId).roster.hostRunId;
	assert.ok(hostRunId);

	const target = targetFrom(first.side, first.hostId, "row-1", "Requested Alpha");
	assert.deepEqual(target, {
		hostId: first.hostId,
		hostRunId,
		rowId: "row-1",
		expectedSessionId: "session-alpha",
		expectedSessionEpoch: 3,
		name: "Requested Alpha",
	});

	const result = await first.side.coordinator.ownerRename.renameSession(target, PROVEN);
	assert.deepEqual(result, { kind: "owner-result", facts: { kind: "renamed" } });
	assert.equal(calls.length, 1, "exactly one owner request was forwarded");
	assert.deepEqual(calls[0]?.request, {
		hostRunId,
		rowId: "row-1",
		expectedSessionId: "session-alpha",
		expectedSessionEpoch: 3,
		name: "Requested Alpha",
	}, "the exact observed run, row, native tuple, and requested name reached the owner");
	assert.equal(calls[0]?.authorized, true, "the provider was handed the live owner re-proof");

	// Both observers, including one that never called rename, learn the name only
	// from the owner's authoritative metadata, and never see the requested spelling.
	await Promise.all([
		waitObservedName(first.side, first.hostId, "row-1", "Canonical Alpha", "the calling viewer's metadata"),
		waitObservedName(second.side, second.hostId, "row-1", "Canonical Alpha", "the second observer's metadata"),
	]);
	for (const observer of [first, second]) {
		const row = observedRow(observer.side, observer.hostId, "row-1");
		assert.equal(row.nativeSession?.sessionId, "session-alpha", "the native id never moved");
		assert.equal(row.nativeSession?.epoch, 3, "the native epoch never moved");
		assert.equal(row.label, "Canonical Alpha");
		assert.equal(row.nativeSession?.name, "Canonical Alpha");
		assert.notEqual(row.label, "Requested Alpha", "no optimistic requester label is stored or published");
		assert.equal(
			observedRow(observer.side, observer.hostId, "row-2").nativeSession?.name,
			"Beta",
			"an unrelated row is unchanged",
		);
	}
	assert.equal(calls.length, 1, "the metadata fan-out never resubmits the rename");
});

test("stale run, row, and native tuple are refused without retargeting or forwarding", async (t) => {
	const initial = [rowNamed("row-1", "session-alpha", 3, "Alpha")];
	const calls: RecordedRename[] = [];
	const owner = await startOwner(t, {
		inventory: createFakeInventory(initial),
		renameOwnedSession: async (request, stillAuthorized) => {
			calls.push({ request, authorized: stillAuthorized() });
			return { kind: "refused" };
		},
	});
	const observer = await connectObserver(t, owner, "Owner host");
	const target = targetFrom(observer.side, observer.hostId, "row-1", "Renamed Alpha");
	const rename = observer.side.coordinator.ownerRename;

	const cases: readonly (readonly [PeerRenameTarget, PeerRenameNotSentReason])[] = [
		[{ ...target, hostId: "unknown-host" }, "target-unavailable"],
		[{ ...target, hostId: "" }, "invalid-request"],
		[{ ...target, hostRunId: "previous-run" }, "target-unavailable"],
		[{ ...target, rowId: "row-2" }, "target-unavailable"],
		[{ ...target, expectedSessionId: "session-other" }, "target-unavailable"],
		[{ ...target, expectedSessionEpoch: 4 }, "target-unavailable"],
		[{ ...target, expectedSessionEpoch: 0 }, "invalid-request"],
		[{ ...target, name: "" }, "invalid-request"],
		[{ ...target, name: "line\u2028break" }, "invalid-request"],
	];
	for (const [candidate, reason] of cases) {
		assert.deepEqual(
			await rename.renameSession(candidate as PeerRenameTarget, PROVEN),
			{ kind: "not-sent", reason },
			`a target this side cannot prove is refused as ${reason}`,
		);
	}
	// The caller's own written-editor proof is required and is re-proved.
	assert.deepEqual(
		await rename.renameSession(target, {} as never),
		{ kind: "not-sent", reason: "invalid-request" },
	);
	assert.deepEqual(
		await rename.renameSession(target, { stillCurrent: () => false }),
		{ kind: "not-sent", reason: "target-unavailable" },
	);
	assert.deepEqual(
		await rename.renameSession(target, { stillCurrent: () => { throw new Error("synthetic reentry"); } }),
		{ kind: "not-sent", reason: "target-unavailable" },
	);
	assert.deepEqual(calls, [], "no refused or unproved candidate reached the owner");
	assert.equal(observedRow(observer.side, observer.hostId, "row-1").nativeSession?.name, "Alpha");
});

test("a request built from a previous owner run is refused after the owner run is replaced", async (t) => {
	const calls: RecordedRename[] = [];
	const inventory = createFakeInventory([rowNamed("row-1", "session-alpha", 3, "Alpha")]);
	const owner = await startOwner(t, {
		inventory,
		renameOwnedSession: async (request, stillAuthorized) => {
			calls.push({ request, authorized: stillAuthorized() });
			return { kind: "refused" };
		},
	});
	const observer = await connectObserver(t, owner, "Owner host");
	const oldTarget = targetFrom(observer.side, observer.hostId, "row-1", "Renamed Alpha");
	const oldRun = oldTarget.hostRunId;

	inventory.setRun("owner-run-b");
	await observer.side.coordinator.perform({ type: "peer-disconnect", hostId: observer.hostId });
	await observer.side.coordinator.perform({ type: "peer-connect", hostId: observer.hostId });
	const adopted = await observer.side.log.waitFor(
		(snapshot) => snapshot.hosts?.find((host) => host.id === observer.hostId)?.roster.hostRunId
			=== "owner-run-b",
		"the destination's adopted owner run",
	);
	const host = adopted.hosts?.find((candidate) => candidate.id === observer.hostId);
	assert.equal(host?.roster.state, "current");
	assert.notEqual(host?.roster.hostRunId, oldRun);

	assert.deepEqual(
		await observer.side.coordinator.ownerRename.renameSession(oldTarget, PROVEN),
		{ kind: "not-sent", reason: "target-unavailable" },
		"the named run is request input and is never rewritten to the new one",
	);
	assert.deepEqual(calls, [], "no rename is submitted for the replaced run");
});

test("caller proof is re-proved at the queued write and reentry fails closed", async (t) => {
	const calls: RecordedRename[] = [];
	const frames = countRenameFrames();
	const owner = await startOwner(t, {
		inventory: createFakeInventory([rowNamed("row-1", "session-alpha", 3, "Alpha")]),
		renameOwnedSession: async (request, stillAuthorized) => {
			calls.push({ request, authorized: stillAuthorized() });
			return { kind: "renamed" };
		},
	});
	const fixture = createOwnedAgentDir(t);
	const requester = await startCoordinator(t, {
		agentDir: fixture.agentDir,
		inventory: createFakeInventory(),
		testHooks: { ...hooks(), wrapClientChannel: frames.wrap },
	});
	const hostId = await addDestination(requester, "Owner host", listenerPort(owner));
	await connectWithApprovals(requester, owner, hostId);
	await waitCurrentRoster(requester, hostId, "the requester's current roster observation");
	const target = targetFrom(requester, hostId, "row-1", "Renamed Alpha");

	// Admission evaluates the caller's proof once; the ordered write evaluates it
	// again. A proof that stops holding there refuses before any frame exists.
	let firstProofCalls = 0;
	assert.deepEqual(
		await requester.coordinator.ownerRename.renameSession(target, {
			stillCurrent: () => {
				firstProofCalls += 1;
				return firstProofCalls === 1;
			},
		}),
		{ kind: "not-sent", reason: "target-unavailable" },
	);
	assert.equal(firstProofCalls, 2, "the caller's proof was re-evaluated inside the queued write");
	assert.equal(frames.count(), 0, "no rename frame reached the transport");

	// Reentering the coordinator from that same last-instant proof must not
	// authorize a send either: the independent destination facts are re-proved
	// AFTER the callback returns. This teardown settles the queued attempt as
	// unobservable, and the frame counter proves it was never written.
	let secondProofCalls = 0;
	const reentered = await requester.coordinator.ownerRename.renameSession(target, {
		stillCurrent: () => {
			secondProofCalls += 1;
			if (secondProofCalls === 2) {
				void requester.coordinator.perform({ type: "peer-disconnect", hostId });
			}
			return true;
		},
	});
	assert.equal(secondProofCalls, 2, "the reentrant proof ran at the queued write");
	assert.deepEqual(reentered, { kind: "unknown" });
	assert.equal(frames.count(), 0, "the reentrant write was never submitted");
	assert.deepEqual(calls, [], "the owner provider was never invoked");
});

test("a delayed answer after the observed native tuple is replaced is unknown and never replayed", async (t) => {
	const initial = [rowNamed("row-1", "session-alpha", 3, "Alpha")];
	let rows: readonly NativeInstanceView[] = initial;
	const calls: RecordedRename[] = [];
	let releaseAnswer: () => void = () => undefined;
	const answerGate = new Promise<void>((resolve) => { releaseAnswer = resolve; });
	let started: () => void = () => undefined;
	const startedGate = new Promise<void>((resolve) => { started = resolve; });
	const frames = countRenameFrames();
	const inventory = createFakeInventory(initial);
	const owner = await startOwner(t, {
		inventory,
		renameOwnedSession: async (request, stillAuthorized) => {
			calls.push({ request, authorized: stillAuthorized() });
			started();
			await answerGate;
			return { kind: "renamed" };
		},
	});
	const fixture = createOwnedAgentDir(t);
	const requester = await startCoordinator(t, {
		agentDir: fixture.agentDir,
		inventory: createFakeInventory(),
		testHooks: { ...hooks(), wrapClientChannel: frames.wrap },
	});
	const hostId = await addDestination(requester, "Owner host", listenerPort(owner));
	await connectWithApprovals(requester, owner, hostId);
	await waitCurrentRoster(requester, hostId, "the requester's current roster observation");
	const target = targetFrom(requester, hostId, "row-1", "Requested Alpha");

	const pending = requester.coordinator.ownerRename.renameSession(target, PROVEN);
	await startedGate;
	assert.equal(calls.length, 1, "the first request reached the owner");

	// While the owner answer is delayed, the row's native conversation is replaced.
	rows = [rowNamed("row-1", "session-replaced", 4, "Replaced")];
	inventory.setRows(rows);
	await requester.log.waitFor(
		(snapshot) => snapshot.hosts?.find((host) => host.id === hostId)
			?.roster.rows?.find((row) => row.id === "row-1")?.nativeSession?.sessionId === "session-replaced",
		"the replaced native tuple reaches the requester",
	);

	releaseAnswer();
	assert.deepEqual(
		await pending,
		{ kind: "unknown" },
		"an answer for a superseded native tuple is never this request's success",
	);
	// Nothing is replayed against the replacement tuple, and the late answer did
	// not create a second owner request.
	await Promise.resolve();
	assert.equal(calls.length, 1);
	assert.equal(frames.count(), 1);
	const row = observedRow(requester, hostId, "row-1");
	assert.equal(row.nativeSession?.sessionId, "session-replaced");
	assert.equal(row.nativeSession?.name, "Replaced");
	assert.notEqual(row.label, "Requested Alpha", "no fallback or optimistic label is invented");
});

test("two owners with the same row id route only to the addressed owner and native tuple", async (t) => {
	const callsB: RecordedRename[] = [];
	const callsC: RecordedRename[] = [];
	let rowsB: readonly NativeInstanceView[] = [rowNamed("shared", "session-b", 7, "Owner B")];
	let rowsC: readonly NativeInstanceView[] = [rowNamed("shared", "session-c", 9, "Owner C")];
	const inventoryB = createFakeInventory(rowsB);
	const inventoryC = createFakeInventory(rowsC);
	const ownerB = await startOwner(t, {
		inventory: inventoryB,
		renameOwnedSession: async (request, stillAuthorized) => {
			callsB.push({ request, authorized: stillAuthorized() });
			rowsB = [rowNamed("shared", request.expectedSessionId, request.expectedSessionEpoch, request.name)];
			inventoryB.setRows(rowsB);
			return { kind: "renamed" };
		},
	});
	const ownerC = await startOwner(t, {
		inventory: inventoryC,
		renameOwnedSession: async (request, stillAuthorized) => {
			callsC.push({ request, authorized: stillAuthorized() });
			rowsC = [rowNamed("shared", request.expectedSessionId, request.expectedSessionEpoch, request.name)];
			inventoryC.setRows(rowsC);
			return { kind: "renamed" };
		},
	});

	const requester = await startRequester(t);
	const hostB = await addDestination(requester, "Owner B", listenerPort(ownerB));
	await connectWithApprovals(requester, ownerB, hostB);
	await waitCurrentRoster(requester, hostB, "Owner B's current roster");
	const hostC = await addDestination(requester, "Owner C", listenerPort(ownerC));
	await connectWithApprovals(requester, ownerC, hostC);
	await waitCurrentRoster(requester, hostC, "Owner C's current roster");

	const targetB = targetFrom(requester, hostB, "shared", "Renamed B");
	const targetC = targetFrom(requester, hostC, "shared", "Renamed C");
	assert.ok(targetB.hostRunId, "Owner B's observation names a run");
	assert.ok(targetC.hostRunId, "Owner C's observation names a run");
	assert.equal(targetB.expectedSessionId, "session-b");
	assert.equal(targetC.expectedSessionId, "session-c");

	assert.deepEqual(
		await requester.coordinator.ownerRename.renameSession(targetB, PROVEN),
		{ kind: "owner-result", facts: { kind: "renamed" } },
	);
	assert.deepEqual(callsB.map((call) => call.request), [{
		hostRunId: targetB.hostRunId,
		rowId: "shared",
		expectedSessionId: "session-b",
		expectedSessionEpoch: 7,
		name: "Renamed B",
	}]);
	assert.equal(callsC.length, 0, "the other owner with the same row id was never addressed");
	await waitObservedName(requester, hostB, "shared", "Renamed B", "Owner B's metadata name");
	assert.equal(observedRow(requester, hostC, "shared").nativeSession?.name, "Owner C");

	assert.deepEqual(
		await requester.coordinator.ownerRename.renameSession(targetC, PROVEN),
		{ kind: "owner-result", facts: { kind: "renamed" } },
	);
	assert.deepEqual(callsC.map((call) => call.request), [{
		hostRunId: targetC.hostRunId,
		rowId: "shared",
		expectedSessionId: "session-c",
		expectedSessionEpoch: 9,
		name: "Renamed C",
	}]);
	assert.equal(callsB.length, 1, "the first owner's request was not repeated");
	await waitObservedName(requester, hostC, "shared", "Renamed C", "Owner C's metadata name");
	assert.equal(observedRow(requester, hostB, "shared").nativeSession?.name, "Renamed B");
});

test("an owner without a rename provider advertises no support and never receives a request", async (t) => {
	const frames = countRenameFrames();
	const owner = await startOwner(t, {
		inventory: createFakeInventory([rowNamed("row-1", "session-alpha", 3, "Alpha")]),
	});
	const fixture = createOwnedAgentDir(t);
	const requester = await startCoordinator(t, {
		agentDir: fixture.agentDir,
		inventory: createFakeInventory(),
		testHooks: { ...hooks(), wrapClientChannel: frames.wrap },
	});
	const hostId = await addDestination(requester, "Legacy owner", listenerPort(owner));
	assert.equal(renameSupported(requester, hostId), false, "a disconnected destination never claims support");
	await connectWithApprovals(requester, owner, hostId);
	await waitCurrentRoster(requester, hostId, "the legacy owner's current roster");
	assert.equal(renameSupported(requester, hostId), false, "the legacy owner acknowledged no rename");

	const target = targetFrom(requester, hostId, "row-1", "Renamed Alpha");
	assert.deepEqual(
		await requester.coordinator.ownerRename.renameSession(target, PROVEN),
		{ kind: "not-sent", reason: "capability-unsupported" },
	);
	assert.equal(frames.count(), 0, "no frame exists for an unacknowledged capability");
	assert.equal(observedRow(requester, hostId, "row-1").nativeSession?.name, "Alpha");
});

test("disconnected and revoked destinations can no longer rename", async (t) => {
	const calls: RecordedRename[] = [];
	const owner = await startOwner(t, {
		inventory: createFakeInventory([rowNamed("row-1", "session-alpha", 3, "Alpha")]),
		renameOwnedSession: async (request, stillAuthorized) => {
			calls.push({ request, authorized: stillAuthorized() });
			return { kind: "refused" };
		},
	});
	const observer = await connectObserver(t, owner, "Owner host");
	const target = targetFrom(observer.side, observer.hostId, "row-1", "Renamed Alpha");
	assert.equal(renameSupported(observer.side, observer.hostId), true);

	await observer.side.coordinator.perform({ type: "peer-disconnect", hostId: observer.hostId });
	assert.equal(hostOf(observer.side, observer.hostId).state, "disconnected");
	assert.equal(renameSupported(observer.side, observer.hostId), false);
	assert.deepEqual(
		await observer.side.coordinator.ownerRename.renameSession(target, PROVEN),
		{ kind: "not-sent", reason: "target-unavailable" },
	);

	// Reconnect, then revoke this viewer's receiving grant on the owner. The
	// transport may remain connected, but no request can be authorized.
	await observer.side.coordinator.perform({ type: "peer-connect", hostId: observer.hostId });
	await waitCurrentRoster(observer.side, observer.hostId, "the reconnected roster");
	assert.equal(
		renameSupported(observer.side, observer.hostId),
		true,
		"support is derived live again from the replacement viewer",
	);
	const peerId = owner.coordinator.read().trustedPeers?.[0]?.id;
	assert.ok(peerId);
	await owner.coordinator.perform({ type: "peer-revoke", peerId });
	await observer.side.log.waitFor(
		(snapshot) => snapshot.hosts?.find((host) => host.id === observer.hostId)?.roster.state === "stale",
		"the revoked destination's stale observation",
	);
	const staleTarget = targetFrom(observer.side, observer.hostId, "row-1", "Renamed Alpha");
	assert.deepEqual(
		await observer.side.coordinator.ownerRename.renameSession(staleTarget, PROVEN),
		{ kind: "not-sent", reason: "target-unavailable" },
		"a stale observation is never retargeted or submitted",
	);
	assert.deepEqual(calls, [], "no disconnected or revoked destination reached the owner");
});
