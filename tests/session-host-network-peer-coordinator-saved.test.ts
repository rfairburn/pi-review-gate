/**
 * Optional Saved catalog exchange through the existing peer coordinator.
 *
 * Every case uses the REAL TLS loopback pair, real pairing with its local
 * first-use key consent and remote directional grant, the real protected
 * preference/trust stores, the real roster bridge on both sides, and the real
 * coordinator. Only the session manager (an in-memory read-only inventory) and
 * the owner's Saved catalog view (a scripted in-memory provider) are stand-ins:
 * no saved conversation, file, or account state outside the test is touched.
 * The owner starts with an EMPTY roster on purpose: Saved needs no row,
 * selection, native tuple, focus, or geometry.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { createPeerCoordinator, type PeerCoordinatorTestHooks } from "../src/session-host/network/peer-coordinator";
import type {
	OwnerSavedAuthorizationGuard,
	OwnerSavedCatalogView,
	OwnerSavedCatalogViewFactory,
	OwnerSavedDeleteFacts,
	OwnerSavedDeleteRequest,
	OwnerSavedEntry,
	OwnerSavedListRequest,
	OwnerSavedResumeFacts,
	OwnerSavedResumeRequest,
	OwnerSavedSearchRequest,
	OwnerSavedWindowFacts,
	OwnerSavedWindowRequest,
	PeerSavedListTarget,
} from "../src/session-host/network/peer-saved";
import type { PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import { createPosixTestPolicy, type PeerStateTestPolicy } from "./session-host-network-peer-state-fixtures";
import {
	consentsOf,
	createFakeInventory,
	createOwnedAgentDir,
	startCoordinator,
	type StartedCoordinator,
} from "./session-host-network-peer-coordinator-helpers";

function hooks(preferencesPermissions: PeerStateTestPolicy = createPosixTestPolicy()): PeerCoordinatorTestHooks {
	return {
		preferencesPermissions,
		peerStatePermissions: createPosixTestPolicy(),
	};
}

/** The full result is deliberately larger than any single per-transfer bound. */
const CATALOG_TOTAL = 5_000;

/** Exact owner display data, including a Windows path with spaces and Unicode. */
function entry(index: number): OwnerSavedEntry {
	return {
		entryId: `entry-${index}`,
		sessionId: `session-${index}`,
		file: `C:\\Users\\Owner Name\\.pi\\agent\\sessions\\--C--work dir--\\2026-10-22 ${index} 日本語.jsonl`,
		caption: `Caption ${index} — ünïcödé`,
		cwd: "C:\\work dir\\Ünï",
	};
}

function entries(offset: number, count: number, total: number): OwnerSavedEntry[] {
	const rows: OwnerSavedEntry[] = [];
	for (let index = offset; index < Math.min(total, offset + count); index += 1) rows.push(entry(index));
	return rows;
}

function plainEntries(value: readonly OwnerSavedEntry[]): OwnerSavedEntry[] {
	return value.map((item) => ({ ...item }));
}

interface SavedCall {
	readonly op: "list" | "search" | "window" | "resume" | "remove";
	readonly request: unknown;
	readonly guard: OwnerSavedAuthorizationGuard;
}

interface SavedHandlers {
	readonly resume?: (request: OwnerSavedResumeRequest) => Promise<OwnerSavedResumeFacts>;
	readonly remove?: (request: OwnerSavedDeleteRequest) => Promise<OwnerSavedDeleteFacts>;
}

interface SavedProvider {
	readonly factory: OwnerSavedCatalogViewFactory;
	readonly calls: SavedCall[];
	readonly created: number;
	readonly disposed: number;
}

/**
 * A scripted owner catalog. `list` mints catalog `cat-1`/result `res-1` over
 * {@link CATALOG_TOTAL} entries; `search` mints `res-search` holding the last
 * entry; `window` slices the same immutable result. Every call is recorded.
 */
function savedProvider(handlers: SavedHandlers = {}): SavedProvider {
	const calls: SavedCall[] = [];
	let created = 0;
	let disposed = 0;
	const factory: OwnerSavedCatalogViewFactory = (): OwnerSavedCatalogView => {
		created += 1;
		return {
			list: async (request: OwnerSavedListRequest, _signal, guard): Promise<OwnerSavedWindowFacts> => {
				calls.push({ op: "list", request, guard });
				return {
					kind: "window",
					hostRunId: request.hostRunId,
					catalogId: "cat-1",
					resultId: "res-1",
					total: CATALOG_TOTAL,
					issueCount: 1,
					offset: request.offset,
					entries: entries(request.offset, request.count, CATALOG_TOTAL),
				};
			},
			search: async (request: OwnerSavedSearchRequest, _signal, guard): Promise<OwnerSavedWindowFacts> => {
				calls.push({ op: "search", request, guard });
				return {
					kind: "window",
					hostRunId: request.hostRunId,
					catalogId: request.catalogId,
					resultId: "res-search",
					total: 1,
					issueCount: 0,
					offset: request.offset,
					entries: request.offset === 0 ? [entry(CATALOG_TOTAL - 1)] : [],
				};
			},
			window: async (request: OwnerSavedWindowRequest, _signal, guard): Promise<OwnerSavedWindowFacts> => {
				calls.push({ op: "window", request, guard });
				return {
					kind: "window",
					hostRunId: request.hostRunId,
					catalogId: request.catalogId,
					resultId: request.resultId,
					total: CATALOG_TOTAL,
					issueCount: 1,
					offset: request.offset,
					entries: entries(request.offset, request.count, CATALOG_TOTAL),
				};
			},
			resume: async (request: OwnerSavedResumeRequest, guard): Promise<OwnerSavedResumeFacts> => {
				calls.push({ op: "resume", request, guard });
				if (handlers.resume !== undefined) return handlers.resume(request);
				return { kind: "started", hostRunId: request.hostRunId, rowId: "resumed-1" };
			},
			remove: async (request: OwnerSavedDeleteRequest, guard): Promise<OwnerSavedDeleteFacts> => {
				calls.push({ op: "remove", request, guard });
				if (handlers.remove !== undefined) return handlers.remove(request);
				return request.confirmed ? { kind: "deleted", method: "trash" } : { kind: "confirmation-required" };
			},
			dispose: (): void => {
				disposed += 1;
			},
		};
	};
	return {
		factory,
		calls,
		get created() {
			return created;
		},
		get disposed() {
			return disposed;
		},
	};
}

interface SavedPair {
	readonly owner: StartedCoordinator;
	readonly requester: StartedCoordinator;
	readonly hostId: string;
	readonly hostRunId: string;
}

/**
 * One owner with an EMPTY current roster and a connected requester. The owner
 * serves Saved only with a factory; the requester asks only with the opt-in.
 */
async function savedPair(
	t: TestContext,
	options: {
		readonly factory?: OwnerSavedCatalogViewFactory;
		readonly savedViewer?: boolean;
		/** Fixture-only: the owner's preferences protection policy, to inject failures. */
		readonly ownerPreferencesPolicy?: PeerStateTestPolicy;
	},
): Promise<SavedPair> {
	const ownerFixture = createOwnedAgentDir(t);
	const requesterFixture = createOwnedAgentDir(t);
	const owner = await startCoordinator(t, {
		agentDir: ownerFixture.agentDir,
		inventory: createFakeInventory([]),
		testHooks: hooks(options.ownerPreferencesPolicy),
		...(options.factory === undefined ? {} : { savedCatalogViewFactory: options.factory }),
	});
	await owner.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	assert.equal(owner.coordinator.read().listener.state, "listening");
	const port = owner.coordinator.read().listener.port as number;
	const requester = await startCoordinator(t, {
		agentDir: requesterFixture.agentDir,
		inventory: createFakeInventory(),
		testHooks: hooks(),
		...(options.savedViewer === undefined ? {} : { savedViewer: options.savedViewer }),
	});
	await requester.coordinator.perform({ type: "peer-add", label: "Owner host", host: "127.0.0.1", port: String(port) });
	const hostId = requester.coordinator.read().hosts?.[0]?.id;
	assert.ok(hostId, "the destination was saved");
	const connecting = requester.coordinator.perform({ type: "peer-connect", hostId });
	const withKey = await requester.log.waitFor(
		(snapshot) => consentsOf(snapshot, "server-key").length > 0,
		"the local first-use server-key consent",
	);
	const keyConsent = consentsOf(withKey, "server-key")[0];
	assert.ok(keyConsent);
	assert.equal(requester.coordinator.decideConsent(keyConsent.id, "approve"), true);
	const withIncoming = await owner.log.waitFor(
		(snapshot) => consentsOf(snapshot, "incoming").length > 0,
		"the owner's receiving consent",
	);
	const incoming = consentsOf(withIncoming, "incoming")[0];
	assert.ok(incoming);
	assert.equal(owner.coordinator.decideConsent(incoming.id, "approve"), true);
	await connecting;
	const connected = await requester.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.state === "connected"
			&& snapshot.hosts[0].roster.state === "current"
			&& typeof snapshot.hosts[0].roster.hostRunId === "string",
		"the owner's empty current roster observation",
	);
	assert.deepEqual(connected.hosts?.[0]?.roster.rows, [], "the owner roster is empty on purpose");
	const hostRunId = connected.hosts?.[0]?.roster.hostRunId;
	assert.ok(typeof hostRunId === "string");
	return { owner, requester, hostId, hostRunId };
}

function savedOf(snapshot: PeerUiSnapshot) {
	return snapshot.hosts?.[0]?.saved;
}

function waitSaved(
	side: StartedCoordinator,
	deleteExposed: boolean | null,
	message: string,
): Promise<PeerUiSnapshot> {
	return side.log.waitFor(
		(snapshot) => savedOf(snapshot)?.supported === true && savedOf(snapshot)?.deleteExposed === deleteExposed,
		message,
	);
}

const PROVEN = Object.freeze({ stillCurrent: (): boolean => true });

test("constructor admission refuses a malformed Saved factory or requester opt-in without touching anything", (t) => {
	const fixture = createOwnedAgentDir(t);
	const base = {
		agentDir: fixture.agentDir,
		inventory: createFakeInventory(),
		onChange: () => undefined,
		onIncomingConsentArrival: () => undefined,
		testHooks: hooks(),
	};
	assert.throws(() => createPeerCoordinator({ ...base, savedCatalogViewFactory: 7 as never }), TypeError);
	assert.throws(() => createPeerCoordinator({ ...base, savedViewer: "true" as never }), TypeError);
	assert.throws(() => createPeerCoordinator({ ...base, savedViewer: 1 as never }), TypeError);
	// A real factory is accepted and never called by construction alone.
	const provider = savedProvider();
	const coordinator = createPeerCoordinator({ ...base, savedCatalogViewFactory: provider.factory, savedViewer: true });
	assert.equal(provider.created, 0);
	assert.equal(typeof coordinator.ownerSaved.list, "function");
	void coordinator.close().catch(() => undefined);
});

test("without the requester opt-in nothing is offered or described, and the controller is inert", async (t) => {
	const provider = savedProvider();
	const pair = await savedPair(t, { factory: provider.factory });
	const host = pair.requester.coordinator.read().hosts?.[0];
	assert.ok(host);
	assert.equal(Object.prototype.hasOwnProperty.call(host, "saved"), false, "the legacy DTO is unchanged");
	assert.deepEqual(await pair.requester.coordinator.ownerSaved.list(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, query: "", offset: 0, count: 2 },
		PROVEN,
	), { kind: "not-sent", reason: "capability-unsupported" });
	assert.equal(provider.created, 0, "an owner factory serves nothing nobody asked for");
	assert.deepEqual(provider.calls, []);
});

test("a legacy owner without a factory is described unsupported and is never asked", async (t) => {
	const pair = await savedPair(t, { savedViewer: true });
	assert.deepEqual(savedOf(pair.requester.coordinator.read()), { supported: false, deleteExposed: null });
	assert.deepEqual(await pair.requester.coordinator.ownerSaved.list(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, query: "", offset: 0, count: 2 },
		PROVEN,
	), { kind: "not-sent", reason: "capability-unsupported" });
});

test("an empty owner roster lists and windows a full catalog with exact query and owner file data", async (t) => {
	const provider = savedProvider();
	const pair = await savedPair(t, { factory: provider.factory, savedViewer: true });
	await waitSaved(pair.requester, true, "the owner's described delete exposure");
	assert.equal(provider.created, 0, "the owner view is created lazily, only after a request");

	// This viewer's own native input/copy and its own owner-side history setting
	// never gate Saved and never change what the OWNER exposes.
	await pair.requester.coordinator.perform({ type: "peer-viewer-native-input", enabled: false });
	await pair.requester.coordinator.perform({ type: "peer-remote-history-delete", enabled: false });
	assert.deepEqual(savedOf(pair.requester.coordinator.read()), { supported: true, deleteExposed: true });

	const query = "  Spaced  ünïcödé 日本語 .*(regex)|fuzzy~ ";
	// A UI intent with extra fields: only the owner request fields may cross.
	const intent = {
		type: "saved-remote-list",
		pickerId: 4,
		requestId: 9,
		revision: 2,
		file: "/etc/passwd",
		hostId: pair.hostId,
		hostRunId: pair.hostRunId,
		query,
		offset: 0,
		count: 2,
	};
	const listed = await pair.requester.coordinator.ownerSaved.list(intent as PeerSavedListTarget, PROVEN);
	assert.equal(listed.kind, "owner-result");
	assert.ok(listed.kind === "owner-result" && listed.outcome.kind === "window");
	assert.equal(listed.outcome.hostRunId, pair.hostRunId);
	assert.equal(listed.outcome.catalogId, "cat-1");
	assert.equal(listed.outcome.resultId, "res-1");
	assert.equal(listed.outcome.total, CATALOG_TOTAL, "the full total, never a per-transfer cutoff");
	assert.equal(listed.outcome.offset, 0);
	assert.deepEqual(plainEntries(listed.outcome.entries), entries(0, 2, CATALOG_TOTAL),
		"exact owner session/file/caption/cwd data");
	assert.deepEqual(provider.calls.map((call) => call.op), ["list"]);
	assert.deepEqual(provider.calls[0]?.request, { hostRunId: pair.hostRunId, query, offset: 0, count: 2 },
		"the query is verbatim and no UI intent field reached the owner");

	// The tail of the SAME result is reached by a bounded window: no relist.
	const tail = await pair.requester.coordinator.ownerSaved.window(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, catalogId: "cat-1", resultId: "res-1", offset: CATALOG_TOTAL - 2, count: 2 },
		PROVEN,
	);
	assert.ok(tail.kind === "owner-result" && tail.outcome.kind === "window");
	assert.equal(tail.outcome.offset, CATALOG_TOTAL - 2);
	assert.equal(tail.outcome.total, CATALOG_TOTAL);
	assert.deepEqual(plainEntries(tail.outcome.entries), entries(CATALOG_TOTAL - 2, 2, CATALOG_TOTAL));

	const found = await pair.requester.coordinator.ownerSaved.search(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, catalogId: "cat-1", query: "Caption 4999", offset: 0, count: 5 },
		PROVEN,
	);
	assert.ok(found.kind === "owner-result" && found.outcome.kind === "window");
	assert.equal(found.outcome.catalogId, "cat-1");
	assert.equal(found.outcome.resultId, "res-search");
	assert.deepEqual(plainEntries(found.outcome.entries), [entry(CATALOG_TOTAL - 1)]);
	assert.deepEqual(provider.calls.map((call) => call.op), ["list", "window", "search"]);
	assert.equal(provider.created, 1, "one view per channel binding");
	// Nothing was selected, focused, or projected locally.
	assert.equal(pair.requester.coordinator.content.readContent().target, null);
	assert.deepEqual(pair.requester.coordinator.read().hosts?.[0]?.roster.rows, []);
});

test("the owner delete policy is described live without a roster refresh and Off refuses before any provider mutation", async (t) => {
	const provider = savedProvider();
	const pair = await savedPair(t, { factory: provider.factory, savedViewer: true });
	await waitSaved(pair.requester, true, "the owner's initial delete exposure");
	const listed = await pair.requester.coordinator.ownerSaved.list(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, query: "", offset: 0, count: 1 },
		PROVEN,
	);
	assert.equal(listed.kind, "owner-result");
	const revisions = pair.owner.inventory.revisions;
	const watches = pair.owner.inventory.activeWatches;

	await pair.owner.coordinator.perform({ type: "peer-remote-history-delete", enabled: false });
	const off = await waitSaved(pair.requester, false, "the owner's live Off description");
	assert.equal(pair.owner.inventory.revisions, revisions, "no resubscription or roster refresh");
	assert.equal(pair.owner.inventory.activeWatches, watches);
	assert.equal(off.hosts?.[0]?.state, "connected");
	assert.equal(off.hosts?.[0]?.roster.hostRunId, pair.hostRunId);
	// The description is the OWNER's policy, never this viewer's own setting.
	assert.equal(off.settings?.remoteHistoryDeleteEnabled, true);

	const target = {
		hostId: pair.hostId,
		hostRunId: pair.hostRunId,
		catalogId: "cat-1",
		resultId: "res-1",
		entryId: "entry-0",
		confirmed: true,
	};
	assert.deepEqual(await pair.requester.coordinator.ownerSaved.remove(target, PROVEN), {
		kind: "owner-result",
		outcome: { kind: "refused", reason: "policy" },
	});
	assert.equal(provider.calls.some((call) => call.op === "remove"), false, "Off never reaches the provider");

	await pair.owner.coordinator.perform({ type: "peer-remote-history-delete", enabled: true });
	await waitSaved(pair.requester, true, "the owner's live On description");
	assert.equal(pair.owner.inventory.revisions, revisions);
	assert.deepEqual(await pair.requester.coordinator.ownerSaved.remove(target, PROVEN), {
		kind: "owner-result",
		outcome: { kind: "deleted", method: "trash" },
	});
	assert.deepEqual(provider.calls.filter((call) => call.op === "remove").map((call) => call.request), [{
		hostRunId: pair.hostRunId,
		catalogId: "cat-1",
		resultId: "res-1",
		entryId: "entry-0",
		confirmed: true,
	}]);
});

test("owner protected settings that become unavailable after publication fail delete exposure closed, live", async (t) => {
	const provider = savedProvider();
	const ownerPreferencesPolicy = createPosixTestPolicy();
	const pair = await savedPair(t, { factory: provider.factory, savedViewer: true, ownerPreferencesPolicy });
	await waitSaved(pair.requester, true, "the owner's initial delete exposure");
	await pair.requester.coordinator.ownerSaved.list(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, query: "", offset: 0, count: 1 },
		PROVEN,
	);
	assert.equal(pair.owner.coordinator.readRemoteHistoryDeleteEnabled(), true);
	const revisions = pair.owner.inventory.revisions;
	const watches = pair.owner.inventory.activeWatches;

	// An UNRELATED owner save fails its protection check after the rename: the
	// store's handle is poisoned, so the protected settings are now unavailable.
	ownerPreferencesPolicy.fail = (call) => call.operation === "assertPrivateFile";
	await pair.owner.coordinator.perform({ type: "peer-bell", enabled: false });
	ownerPreferencesPolicy.fail = null;
	assert.match(pair.owner.coordinator.read().notice ?? "", /could not be saved/);
	assert.equal(pair.owner.coordinator.readRemoteHistoryDeleteEnabled(), false, "never a cached enabled value");

	// The existing viewer is told live, with no roster refresh or resubscription.
	const off = await waitSaved(pair.requester, false, "the owner's fail-closed description");
	assert.equal(off.hosts?.[0]?.state, "connected");
	assert.equal(pair.owner.inventory.revisions, revisions);
	assert.equal(pair.owner.inventory.activeWatches, watches);

	// A later delete is refused by the owner before any provider mutation, and an
	// attempted re-enable on the unusable handle cannot restore exposure.
	await pair.owner.coordinator.perform({ type: "peer-remote-history-delete", enabled: true });
	assert.equal(pair.owner.coordinator.readRemoteHistoryDeleteEnabled(), false);
	assert.deepEqual(await pair.requester.coordinator.ownerSaved.remove(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, catalogId: "cat-1", resultId: "res-1", entryId: "entry-0", confirmed: true },
		PROVEN,
	), { kind: "owner-result", outcome: { kind: "refused", reason: "policy" } });
	assert.equal(provider.calls.some((call) => call.op === "remove"), false);
	assert.equal(savedOf(pair.requester.coordinator.read())?.deleteExposed, false);
});

test("accepted resume and delete completions are reported as observed, even after the owner policy turns Off", async (t) => {
	let releaseDelete: (facts: OwnerSavedDeleteFacts) => void = () => undefined;
	let deleteInvoked: () => void = () => undefined;
	const invoked = new Promise<void>((resolve) => {
		deleteInvoked = resolve;
	});
	const provider = savedProvider({
		remove: () => new Promise<OwnerSavedDeleteFacts>((resolve) => {
			releaseDelete = resolve;
			deleteInvoked();
		}),
	});
	const pair = await savedPair(t, { factory: provider.factory, savedViewer: true });
	await waitSaved(pair.requester, true, "the owner's initial delete exposure");
	await pair.requester.coordinator.ownerSaved.list(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, query: "", offset: 0, count: 2 },
		PROVEN,
	);

	assert.deepEqual(await pair.requester.coordinator.ownerSaved.resume(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, catalogId: "cat-1", resultId: "res-1", entryId: "entry-1" },
		PROVEN,
	), { kind: "owner-result", outcome: { kind: "started", hostRunId: pair.hostRunId, rowId: "resumed-1" } });
	assert.equal(pair.requester.coordinator.content.readContent().target, null, "a resume selects nothing locally");

	const removing = pair.requester.coordinator.ownerSaved.remove(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, catalogId: "cat-1", resultId: "res-1", entryId: "entry-0", confirmed: true },
		PROVEN,
	);
	await invoked;
	// The owner turns its policy Off while the accepted delete is still running.
	await pair.owner.coordinator.perform({ type: "peer-remote-history-delete", enabled: false });
	await waitSaved(pair.requester, false, "the owner's Off description during the delete");
	releaseDelete({ kind: "deleted", method: "unlink" });
	assert.deepEqual(await removing, { kind: "owner-result", outcome: { kind: "deleted", method: "unlink" } },
		"a completed delete is never rewritten into a refusal or a not-sent");
});

test("required proof, exact run, destination, and admission reentry fences refuse before any byte is written", async (t) => {
	const provider = savedProvider();
	const pair = await savedPair(t, { factory: provider.factory, savedViewer: true });
	await waitSaved(pair.requester, true, "the owner's described delete exposure");
	const saved = pair.requester.coordinator.ownerSaved;
	const valid = { hostId: pair.hostId, hostRunId: pair.hostRunId, query: "", offset: 0, count: 2 };

	// The caller's proof is required, real, and true.
	assert.deepEqual(await saved.list(valid, {} as never), { kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await saved.list(valid, undefined as never), { kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await saved.list(valid, { stillCurrent: () => false }),
		{ kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await saved.list(valid, { stillCurrent: () => { throw new Error("synthetic proof failure"); } }),
		{ kind: "not-sent", reason: "target-unavailable" });
	// An exact run and destination, never rewritten or retargeted.
	assert.deepEqual(await saved.list({ ...valid, hostRunId: "other-run" }, PROVEN),
		{ kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await saved.list({ ...valid, hostId: "not-a-host" }, PROVEN),
		{ kind: "not-sent", reason: "target-unavailable" });
	// Unrepresentable requests are refused, never repaired.
	assert.deepEqual(await saved.list({ ...valid, query: "\ud800" }, PROVEN), { kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await saved.list({ ...valid, count: 0 }, PROVEN), { kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await saved.list({ ...valid, count: 1.5 }, PROVEN), { kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await saved.list({ ...valid, offset: -1 }, PROVEN), { kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await saved.search({ ...valid, catalogId: "../cat" }, PROVEN),
		{ kind: "not-sent", reason: "invalid-request" });
	const hostile = {
		get hostId(): string {
			throw new Error("hostile accessor");
		},
	};
	assert.deepEqual(await saved.list(hostile as never, PROVEN), { kind: "not-sent", reason: "invalid-request" });

	// The SAME proof is re-proved at the raw queued write: true at admission and
	// false at the write boundary is refused there, before the transport.
	let proofCalls = 0;
	assert.deepEqual(await saved.list(valid, {
		stillCurrent: () => {
			proofCalls += 1;
			return proofCalls === 1;
		},
	}), { kind: "not-sent", reason: "target-unavailable" });
	assert.ok(proofCalls >= 2, "the proof ran at admission and at the write boundary");

	// Caller code that replaces the destination while proving still cannot
	// authorize the request: every fence is re-proved after it returns.
	assert.deepEqual(await saved.list(valid, {
		stillCurrent: () => {
			void pair.requester.coordinator.perform({ type: "peer-disconnect", hostId: pair.hostId });
			return true;
		},
	}), { kind: "not-sent", reason: "target-unavailable" });
	assert.equal(provider.created, 0, "no refused request ever reached the owner");
	assert.deepEqual(provider.calls, []);

	// A disconnected destination is unknown/unsupported and cannot be addressed.
	const disconnected = pair.requester.coordinator.read();
	assert.equal(disconnected.hosts?.[0]?.state, "disconnected");
	assert.deepEqual(savedOf(disconnected), { supported: false, deleteExposed: null });
	assert.deepEqual(await saved.list(valid, PROVEN), { kind: "not-sent", reason: "target-unavailable" });

	await pair.requester.coordinator.close();
	assert.deepEqual(await saved.list(valid, PROVEN), { kind: "not-sent", reason: "not-ready" });
	assert.deepEqual(provider.calls, []);
});
