/**
 * Coordinator-side Review-settings exchange over the real peer lanes (#716 slice).
 *
 * Every case uses the REAL TLS loopback pair, real pairing with its local
 * first-use key consent and remote directional grant, the real protected
 * preference/trust stores, the real roster bridge on both sides, and the real
 * coordinator. Only the session manager (an in-memory read-only inventory) and
 * the owner's Review-settings provider (a scripted in-memory handler holding
 * SYNTHETIC bytes) are stand-ins: no persisted Review configuration, file, or
 * account state outside the test is touched, and nothing here interprets an
 * envelope — it is opaque UTF-8 JSON bytes end to end.
 *
 * The owner starts with an EMPTY roster on purpose: like Saved, the exchange
 * needs no row, selection, native tuple, focus, or geometry.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import {
	createPeerCoordinator,
	PEER_REMOTE_REVIEW_SETTINGS_WAIT_MAX_MS,
	type PeerCoordinatorOptions,
	type PeerCoordinatorTestHooks,
} from "../src/session-host/network/peer-coordinator";
import { decodeRosterBridgeFrame } from "../src/session-host/network/roster-bridge-protocol";
import type { RosterBridgeFrame } from "../src/session-host/network/roster-bridge-protocol";
import {
	REVIEW_SETTINGS_MAX_BYTES,
	type OwnerReviewSettingsFacts,
	type OwnerReviewSettingsGuard,
	type OwnerReviewSettingsHandler,
	type OwnerReviewSettingsRequest,
} from "../src/session-host/network/peer-review-settings";
import type { PeerUiHostReviewSettings, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import { createPosixTestPolicy, type PeerStateTestPolicy } from "./session-host-network-peer-state-fixtures";
import {
	consentsOf,
	createFakeInventory,
	createOwnedAgentDir,
	createSnapshotLog,
	delay,
	reserveLoopbackPort,
	type FakeInventory,
	type SnapshotLog,
} from "./session-host-network-peer-coordinator-helpers";

function hooks(
	preferencesPermissions: PeerStateTestPolicy = createPosixTestPolicy(),
	extra: PeerCoordinatorTestHooks = {},
): PeerCoordinatorTestHooks {
	return { preferencesPermissions, peerStatePermissions: createPosixTestPolicy(), ...extra };
}

/** One synthetic owner Review configuration envelope. Nothing here reads its fields. */
const OWNER_ENVELOPE = new TextEncoder().encode(JSON.stringify({
	owner: { model: "owner-model", commands: ["a", "b"], note: "日本語 ünïcödé" },
}));

/** One synthetic viewer-authored envelope to save. */
const VIEWER_ENVELOPE = new TextEncoder().encode(JSON.stringify({
	viewer: { model: "chosen-model", gate: { enabled: true }, note: "ünïcödé 日本語" },
}));

interface ReviewProviderOptions {
	readonly load?: (request: OwnerReviewSettingsRequest, guard: OwnerReviewSettingsGuard) =>
		OwnerReviewSettingsFacts | Promise<OwnerReviewSettingsFacts>;
	readonly save?: (request: OwnerReviewSettingsRequest, guard: OwnerReviewSettingsGuard) =>
		OwnerReviewSettingsFacts | Promise<OwnerReviewSettingsFacts>;
}

interface ReviewProvider {
	readonly handler: OwnerReviewSettingsHandler;
	readonly calls: OwnerReviewSettingsRequest[];
	readonly guards: boolean[];
}

/**
 * A scripted owner provider. It records every closed request it is handed and
 * whether the reusable live proof held at that moment; it never sees a settings
 * key, a path, or any interpretation, and it is the only place the synthetic
 * bytes exist on the owner side.
 */
function reviewProvider(options: ReviewProviderOptions = {}): ReviewProvider {
	const calls: OwnerReviewSettingsRequest[] = [];
	const guards: boolean[] = [];
	const handler: OwnerReviewSettingsHandler = (request, stillAuthorized) => {
		calls.push(request);
		guards.push(stillAuthorized());
		if (request.kind === "load") {
			if (options.load !== undefined) return options.load(request, stillAuthorized);
			return { kind: "accepted", payload: OWNER_ENVELOPE };
		}
		if (options.save !== undefined) return options.save(request, stillAuthorized);
		return { kind: "accepted" };
	};
	return { handler, calls, guards };
}

interface Side {
	readonly coordinator: ReturnType<typeof createPeerCoordinator>;
	readonly log: SnapshotLog;
	readonly inventory: FakeInventory;
}

/** The helper's start, widened only by the owner-side Review-settings provider. */
async function startSide(
	t: TestContext,
	options: {
		readonly agentDir: string;
		readonly inventory?: FakeInventory;
		readonly testHooks?: PeerCoordinatorTestHooks;
		readonly reviewSettingsProvider?: OwnerReviewSettingsHandler;
	},
): Promise<Side> {
	const log = createSnapshotLog();
	const inventory = options.inventory ?? createFakeInventory();
	const coordinator = createPeerCoordinator({
		agentDir: options.agentDir,
		inventory,
		onChange: log.onChange,
		onIncomingConsentArrival: log.onArrival,
		...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
		...(options.reviewSettingsProvider === undefined
			? {}
			: { reviewSettingsProvider: options.reviewSettingsProvider }),
	} as PeerCoordinatorOptions);
	t.after(async () => {
		try {
			await coordinator.close();
		} catch {
			// A rejected close is the test's own observed outcome, never a hook failure.
		}
	});
	await coordinator.start();
	return { coordinator, log, inventory };
}

interface ReviewPair {
	readonly owner: Side;
	readonly requester: Side;
	readonly hostId: string;
	readonly hostRunId: string;
	readonly port: number;
}

/**
 * Wrap a client channel with a per-frame send gate: `gate` sees each OUTGOING frame
 * and, by returning a promise, can hold that frame at the transport boundary — the
 * coordinator's last-instant write gate has already passed, but the bytes have not
 * gone out, so a state change can be interleaved between the two.
 */
const withSendGate = (
	gate: (frame: RosterBridgeFrame) => Promise<void> | undefined,
): NonNullable<PeerCoordinatorTestHooks["wrapClientChannel"]> => (channel) => {
	return {
		get peerKey() { return channel.peerKey; },
		get lane() { return channel.lane; },
		get label() { return channel.label; },
		get bufferedAmount() { return channel.bufferedAmount; },
		get closed() { return channel.closed; },
		close: () => channel.close(),
		onMessage: (handler) => channel.onMessage(handler),
		send: async (bytes) => {
			const wait = gate(decodeRosterBridgeFrame(bytes));
			if (wait === undefined) return channel.send(bytes);
			await wait;
			return channel.send(bytes);
		},
	};
};

/**
 * One owner with an EMPTY current roster and a connected requester, paired over
 * real TLS with both human consents. `port` is fixed when a test must re-bind the
 * same address later (the automatic-reconnect case).
 */
async function reviewPair(
	t: TestContext,
	options: {
		readonly provider?: OwnerReviewSettingsHandler;
		readonly ownerPreferencesPolicy?: PeerStateTestPolicy;
		readonly wrapRequesterChannel?: PeerCoordinatorTestHooks["wrapClientChannel"];
		/**
		 * Hold one requester frame inside `channel.send`, AFTER the coordinator's
		 * last-instant write gate passed, so a state change can be interleaved with a
		 * frame already committed to going out. Return `undefined` to let it through.
		 */
		readonly requesterGate?: (frame: RosterBridgeFrame) => Promise<void> | undefined;
		readonly autoReconnect?: boolean;
		readonly autoReconnectDelaysMs?: readonly number[];
		readonly port?: number;
		/** The owner's saved remote Review-settings opt-in, applied after pairing. */
		readonly ownerOptIn?: boolean;
	},
): Promise<ReviewPair> {
	const ownerFixture = createOwnedAgentDir(t);
	const requesterFixture = createOwnedAgentDir(t);
	const owner = await startSide(t, {
		agentDir: ownerFixture.agentDir,
		inventory: createFakeInventory([]),
		testHooks: hooks(options.ownerPreferencesPolicy),
		...(options.provider === undefined ? {} : { reviewSettingsProvider: options.provider }),
	});
	await owner.coordinator.perform({
		type: "peer-listener",
		enabled: true,
		host: "127.0.0.1",
		port: String(options.port ?? 0),
	});
	assert.equal(owner.coordinator.read().listener.state, "listening");
	const port = owner.coordinator.read().listener.port as number;
	const gate = options.requesterGate;
	// A gate composes ON TOP of a caller's own wrapper; neither replaces the other.
	const requesterWrapper: PeerCoordinatorTestHooks["wrapClientChannel"] = gate === undefined
		? options.wrapRequesterChannel
		: (inner) => withSendGate(gate)(
			options.wrapRequesterChannel === undefined ? inner : options.wrapRequesterChannel(inner),
		);
	const requester = await startSide(t, {
		agentDir: requesterFixture.agentDir,
		inventory: createFakeInventory(),
		testHooks: hooks(
			createPosixTestPolicy(),
			{
				...(requesterWrapper === undefined ? {} : { wrapClientChannel: requesterWrapper }),
				...(options.autoReconnectDelaysMs === undefined ? {} : { autoReconnectDelaysMs: options.autoReconnectDelaysMs }),
			},
		),
	});
	await requester.coordinator.perform({ type: "peer-add", label: "Owner host", host: "127.0.0.1", port: String(port) });
	const hostId = requester.coordinator.read().hosts?.[0]?.id;
	assert.ok(hostId, "the destination was saved");
	if (options.autoReconnect === true) {
		// Auto is a saved preference; turning it on changes nothing else here.
		await requester.coordinator.perform({ type: "peer-auto-reconnect", enabled: true });
	}
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
	if (options.provider !== undefined && options.ownerOptIn !== false) {
		// The owner opt-in is a saved preference that defaults Off; a test that wants
		// an opted-in owner says so explicitly, exactly as an operator would.
		await owner.coordinator.perform({ type: "peer-remote-review-settings", enabled: true });
	}
	return { owner, requester, hostId, hostRunId, port };
}

function reviewOf(snapshot: PeerUiSnapshot): PeerUiHostReviewSettings | undefined {
	return snapshot.hosts?.[0]?.reviewSettings;
}

function waitReview(side: Side, enabled: boolean | null, message: string): Promise<PeerUiSnapshot> {
	return side.log.waitFor(
		(snapshot) => reviewOf(snapshot)?.supported === true && reviewOf(snapshot)?.enabled === enabled,
		message,
	);
}

const PROVEN = Object.freeze({ stillCurrent: (): boolean => true });

test("constructor admission refuses a malformed Review-settings provider and never calls a real one", (t) => {
	const fixture = createOwnedAgentDir(t);
	const base = {
		agentDir: fixture.agentDir,
		inventory: createFakeInventory(),
		onChange: () => undefined,
		onIncomingConsentArrival: () => undefined,
		testHooks: hooks(),
	};
	assert.throws(() => createPeerCoordinator({ ...base, reviewSettingsProvider: 7 as never }), TypeError);
	assert.throws(() => createPeerCoordinator({ ...base, reviewSettingsProvider: {} as never }), TypeError);
	assert.throws(() => createPeerCoordinator({ ...base, reviewSettingsProvider: "" as never }), TypeError);
	// A real provider is accepted and never called by construction alone.
	const provider = reviewProvider();
	const coordinator = createPeerCoordinator({ ...base, reviewSettingsProvider: provider.handler });
	assert.equal(provider.calls.length, 0, "construction reaches no owner provider");
	assert.equal(typeof coordinator.loadRemoteReviewSettings, "function");
	assert.equal(typeof coordinator.saveRemoteReviewSettings, "function");
	void coordinator.close().catch(() => undefined);
});

test("an owner without a provider is described unsupported and is never asked anything", async (t) => {
	const pair = await reviewPair(t, {});
	const host = pair.requester.coordinator.read().hosts?.[0];
	assert.ok(host);
	assert.deepEqual(host.reviewSettings, { supported: false, enabled: null }, "an unacknowledged lane is absent support");
	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId },
		PROVEN,
	), { kind: "not-sent", reason: "capability-unsupported" });
	assert.deepEqual(await pair.requester.coordinator.saveRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, payload: VIEWER_ENVELOPE },
		PROVEN,
	), { kind: "not-sent", reason: "capability-unsupported" });
});

test("an opted-out owner is described Off on its current run and is never eligible", async (t) => {
	const provider = reviewProvider();
	const pair = await reviewPair(t, { provider: provider.handler, ownerOptIn: false });
	const off = await waitReview(pair.requester, false, "the owner's described Off");
	assert.deepEqual(reviewOf(off), { supported: true, enabled: false });
	assert.equal(pair.owner.coordinator.readRemoteReviewSettingsEnabled(), false);
	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId }, PROVEN,
	), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await pair.requester.coordinator.saveRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, payload: VIEWER_ENVELOPE }, PROVEN,
	), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(provider.calls, [], "an opted-out owner is asked nothing");
});

test("an opted-in owner is described on the current run, and its opt-out reaches the connected viewer without a reconnection", async (t) => {
	const provider = reviewProvider();
	const pair = await reviewPair(t, { provider: provider.handler });
	const on = await waitReview(pair.requester, true, "the owner's described On");
	assert.deepEqual(reviewOf(on), { supported: true, enabled: true });
	const revisions = pair.owner.inventory.revisions;
	const watches = pair.owner.inventory.activeWatches;

	await pair.owner.coordinator.perform({ type: "peer-remote-review-settings", enabled: false });
	const off = await waitReview(pair.requester, false, "the owner's live Off description");
	assert.equal(off.hosts?.[0]?.state, "connected", "the opt-out needs no reconnection");
	assert.equal(off.hosts?.[0]?.roster.hostRunId, pair.hostRunId);
	assert.equal(off.hosts?.[0]?.roster.state, "current");
	assert.equal(pair.owner.inventory.revisions, revisions, "no resubscription or roster refresh");
	assert.equal(pair.owner.inventory.activeWatches, watches);
	// The description is the OWNER's policy, never this viewer's own setting.
	// This side is a pure viewer here: its own owner-side opt-in is a separate saved
	// setting (default Off) that the owner's change never moved.
	assert.equal(off.settings?.remoteReviewSettingsEnabled, false, "the viewer's own opt-in is untouched");
	assert.equal(pair.requester.coordinator.readRemoteReviewSettingsEnabled(), false);
	assert.equal(pair.owner.coordinator.readRemoteReviewSettingsEnabled(), false);

	// Off is never eligible: nothing is submitted, so the owner provider is untouched.
	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId }, PROVEN,
	), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await pair.requester.coordinator.saveRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, payload: VIEWER_ENVELOPE }, PROVEN,
	), { kind: "not-sent", reason: "target-unavailable" });
	assert.equal(provider.calls.length, 0);

	// The opt-in returning is described live too, on the same viewer and run.
	await pair.owner.coordinator.perform({ type: "peer-remote-review-settings", enabled: true });
	await waitReview(pair.requester, true, "the owner's live On description again");
	assert.equal(pair.owner.inventory.revisions, revisions);
	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId }, PROVEN,
	), { kind: "owner-result", outcome: { kind: "loaded", payload: OWNER_ENVELOPE } });
});

test("an owner whose protected settings lose authority fails the description closed, live", async (t) => {
	const provider = reviewProvider();
	const ownerPreferencesPolicy = createPosixTestPolicy();
	const pair = await reviewPair(t, { provider: provider.handler, ownerPreferencesPolicy });
	await waitReview(pair.requester, true, "the owner's initial On description");
	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId }, PROVEN,
	), { kind: "owner-result", outcome: { kind: "loaded", payload: OWNER_ENVELOPE } });
	assert.equal(pair.owner.coordinator.readRemoteReviewSettingsEnabled(), true);
	const revisions = pair.owner.inventory.revisions;
	const watches = pair.owner.inventory.activeWatches;

	// An UNRELATED owner save fails its protection check after the write: the store's
	// handle is poisoned, so the protected settings are no longer authority for the
	// opt-in — and the existing viewer is told live, with no roster refresh.
	ownerPreferencesPolicy.fail = (call) => call.operation === "assertPrivateFile";
	await pair.owner.coordinator.perform({ type: "peer-bell", enabled: false });
	ownerPreferencesPolicy.fail = null;
	assert.match(pair.owner.coordinator.read().notice ?? "", /could not be saved/);
	assert.equal(pair.owner.coordinator.readRemoteReviewSettingsEnabled(), false, "never a cached enabled value");

	const off = await waitReview(pair.requester, false, "the owner's fail-closed description");
	assert.equal(off.hosts?.[0]?.state, "connected");
	assert.equal(pair.owner.inventory.revisions, revisions);
	assert.equal(pair.owner.inventory.activeWatches, watches);

	// A later load is refused at this side's current preflight, and an attempted
	// re-enable on the unusable handle cannot restore the opt-in or its description.
	await pair.owner.coordinator.perform({ type: "peer-remote-review-settings", enabled: true });
	assert.equal(pair.owner.coordinator.readRemoteReviewSettingsEnabled(), false);
	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId }, PROVEN,
	), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(reviewOf(pair.requester.coordinator.read()), { supported: true, enabled: false });
	assert.equal(provider.calls.filter((call) => call.kind === "load").length, 1);
});

test("load and save route the exact opaque bytes to the exact TLS owner and select nothing locally", async (t) => {
	const provider = reviewProvider();
	const pair = await reviewPair(t, { provider: provider.handler });
	await waitReview(pair.requester, true, "the owner's described On");

	const loaded = await pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId }, PROVEN,
	);
	assert.deepEqual(loaded, { kind: "owner-result", outcome: { kind: "loaded", payload: OWNER_ENVELOPE } },
		"the owner's exact synthetic bytes, unchanged and complete");
	assert.equal(provider.calls.length, 1);
	const loadCall = provider.calls[0];
	assert.ok(loadCall);
	assert.equal(loadCall.kind, "load");
	assert.equal(loadCall.hostRunId, pair.hostRunId, "the exact run the requester named");
	assert.equal(loadCall.payload, undefined, "a load reaches the owner with no payload at all");
	// The peer identity is the authenticated channel's, never a frame field.
	assert.equal(loadCall.peerKey.fingerprint, pair.requester.coordinator.read().identityFingerprint);
	assert.equal(provider.guards[0], true, "the reusable live proof holds at the provider");

	const saved = await pair.requester.coordinator.saveRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, payload: VIEWER_ENVELOPE }, PROVEN,
	);
	assert.deepEqual(saved, { kind: "owner-result", outcome: { kind: "accepted" } });
	const saveCall = provider.calls.find((call) => call.kind === "save");
	assert.ok(saveCall, "the save reached the owner provider");
	assert.equal(saveCall.hostRunId, pair.hostRunId);
	assert.deepEqual(saveCall.payload, VIEWER_ENVELOPE, "exactly the caller's bytes, in order, unduplicated");
	assert.equal(saveCall.peerKey.fingerprint, pair.requester.coordinator.read().identityFingerprint);

	// Nothing local was created, selected, focused, or displayed by either request.
	assert.equal(pair.requester.coordinator.content.readContent().target, null);
	assert.deepEqual(pair.requester.coordinator.read().hosts?.[0]?.roster.rows, []);
	assert.equal(pair.requester.coordinator.read().consents.length, 0);
});

test("a disabled owner policy denies both paths even when this side still holds a stale positive description", async (t) => {
	// The owner's opt-in is a DESCRIPTION to this side, never authority. Dropping a
	// policy frame keeps the requester's description stale-positive, so the OWNER's
	// own live re-read is what must deny both load and save before its provider.
	let dropPolicy = false;
	const provider = reviewProvider();
	const pair = await reviewPair(t, {
		provider: provider.handler,
		wrapRequesterChannel: (channel) => ({
			get peerKey() { return channel.peerKey; },
			get lane() { return channel.lane; },
			get label() { return channel.label; },
			get bufferedAmount() { return channel.bufferedAmount; },
			get closed() { return channel.closed; },
			close: () => channel.close(),
			onMessage: (handler) => channel.onMessage((bytes) => {
				const frame = decodeRosterBridgeFrame(bytes);
				if (dropPolicy && frame.type === "review_settings_policy") return;
				handler(bytes);
			}),
			send: (bytes) => channel.send(bytes),
		}),
	});
	await waitReview(pair.requester, true, "the owner's initial On description");
	dropPolicy = true;

	await pair.owner.coordinator.perform({ type: "peer-remote-review-settings", enabled: false });
	await delay(200);
	// This side is still describing On, and its live policy read is still On too.
	assert.deepEqual(reviewOf(pair.requester.coordinator.read()), { supported: true, enabled: true });
	assert.equal(pair.owner.coordinator.readRemoteReviewSettingsEnabled(), false);

	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId }, PROVEN,
	), { kind: "owner-result", outcome: { kind: "refused", reason: "policy" } });
	assert.deepEqual(await pair.requester.coordinator.saveRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, payload: VIEWER_ENVELOPE }, PROVEN,
	), { kind: "owner-result", outcome: { kind: "refused", reason: "policy" } });
	assert.equal(provider.calls.length, 0, "the owner denies both operations before its provider is reached");
});

test("disconnect, re-address, remove, a stale run, and close never retarget or replay a request", async (t) => {
	const provider = reviewProvider();
	const pair = await reviewPair(t, { provider: provider.handler });
	await waitReview(pair.requester, true, "the owner's described On");
	const target = { hostId: pair.hostId, hostRunId: pair.hostRunId };

	// The exact run is required input, never rewritten to a newer one.
	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: "some-other-run" }, PROVEN,
	), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: "not-a-destination", hostRunId: pair.hostRunId }, PROVEN,
	), { kind: "not-sent", reason: "target-unavailable" });

	// One accepted load, as the baseline the later refusals must not duplicate.
	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(target, PROVEN),
		{ kind: "owner-result", outcome: { kind: "loaded", payload: OWNER_ENVELOPE } });
	const loads = (): number => provider.calls.filter((call) => call.kind === "load").length;
	assert.equal(loads(), 1);

	await pair.requester.coordinator.perform({ type: "peer-disconnect", hostId: pair.hostId });
	const lost = pair.requester.coordinator.read();
	assert.equal(lost.hosts?.[0]?.state, "disconnected");
	assert.deepEqual(reviewOf(lost), { supported: false, enabled: null }, "a disconnected destination is not eligible");
	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(target, PROVEN),
		{ kind: "not-sent", reason: "target-unavailable" });

	// Re-addressing the destination cannot inherit the old channel's authority.
	await pair.requester.coordinator.perform({
		type: "peer-edit-host",
		hostId: pair.hostId,
		expectedHost: "127.0.0.1",
		expectedPort: pair.port,
		host: "127.0.0.2",
	});
	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(target, PROVEN),
		{ kind: "not-sent", reason: "target-unavailable" });

	await pair.requester.coordinator.perform({ type: "peer-remove", hostId: pair.hostId });
	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(target, PROVEN),
		{ kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await pair.requester.coordinator.saveRemoteReviewSettings(
		{ ...target, payload: VIEWER_ENVELOPE }, PROVEN,
	), { kind: "not-sent", reason: "target-unavailable" });

	await pair.requester.coordinator.close();
	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(target, PROVEN),
		{ kind: "not-sent", reason: "not-ready" });
	assert.equal(loads(), 1, "no refused request ever reached the owner provider");
});

test("required proof, malformed requests and waits, and an aborted signal refuse before any byte is written", async (t) => {
	const provider = reviewProvider();
	const pair = await reviewPair(t, { provider: provider.handler });
	await waitReview(pair.requester, true, "the owner's described On");
	const coordinator = pair.requester.coordinator;
	const valid = { hostId: pair.hostId, hostRunId: pair.hostRunId };
	const saveValid = { ...valid, payload: VIEWER_ENVELOPE };

	// The caller's proof is required, real, and true.
	assert.deepEqual(await coordinator.loadRemoteReviewSettings(valid, {} as never),
		{ kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await coordinator.loadRemoteReviewSettings(valid, undefined as never),
		{ kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await coordinator.loadRemoteReviewSettings(valid, { stillCurrent: () => false }),
		{ kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await coordinator.loadRemoteReviewSettings(valid, {
		stillCurrent: () => { throw new Error("synthetic proof failure"); },
	}), { kind: "not-sent", reason: "target-unavailable" });

	// A save's envelope is one bounded well-formed UTF-8 JSON value or nothing; a
	// load carries no envelope at all.
	assert.deepEqual(await coordinator.saveRemoteReviewSettings({ ...valid, payload: new Uint8Array(0) }, PROVEN),
		{ kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await coordinator.saveRemoteReviewSettings(
		{ ...valid, payload: new TextEncoder().encode("{not json") }, PROVEN,
	), { kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await coordinator.saveRemoteReviewSettings(
		{ ...valid, payload: new TextEncoder().encode("plain text") }, PROVEN,
	), { kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await coordinator.saveRemoteReviewSettings(
		{ ...valid, payload: "not bytes" as never }, PROVEN,
	), { kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await coordinator.saveRemoteReviewSettings(
		{ ...valid, payload: new Uint8Array(REVIEW_SETTINGS_MAX_BYTES + 1) }, PROVEN,
	), { kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(await coordinator.loadRemoteReviewSettings(
		{ ...valid, payload: VIEWER_ENVELOPE } as never, PROVEN,
	), { kind: "not-sent", reason: "invalid-request" });
	// A hostile getter is a malformed request, never a rejection.
	const hostile = {
		get hostId(): string {
			throw new Error("hostile accessor");
		},
	};
	assert.deepEqual(await coordinator.loadRemoteReviewSettings(hostile as never, PROVEN),
		{ kind: "not-sent", reason: "invalid-request" });

	// The optional reconnect wait is a real bounded interval or absent.
	for (const bad of [0, -1, 1.5, "500", PEER_REMOTE_REVIEW_SETTINGS_WAIT_MAX_MS + 1, Number.NaN]) {
		assert.deepEqual(await coordinator.loadRemoteReviewSettings(valid, {
			stillCurrent: () => true,
			waitForReconnectMs: bad as never,
		}), { kind: "not-sent", reason: "invalid-request" }, `wait ${String(bad)}`);
	}
	assert.deepEqual(await coordinator.loadRemoteReviewSettings(valid, {
		stillCurrent: () => true,
		signal: { aborted: false } as never,
	}), { kind: "not-sent", reason: "invalid-request" }, "a lookalike signal is refused");
	// A signal whose own accessors throw is refused as a malformed request. The API
	// documents a result for every call, so nothing may reject out of it.
	const hostileSignal = {
		get aborted(): boolean {
			throw new Error("hostile accessor");
		},
		addEventListener: (): void => undefined,
		removeEventListener: (): void => undefined,
	};
	assert.deepEqual(await coordinator.loadRemoteReviewSettings(valid, {
		stillCurrent: () => true,
		signal: hostileSignal as never,
	}), { kind: "not-sent", reason: "invalid-request" }, "an unprobeable signal is refused, not thrown");

	// A signal the caller already abandoned never reaches the transport.
	const abandoned = new AbortController();
	abandoned.abort();
	assert.deepEqual(await coordinator.loadRemoteReviewSettings(valid, {
		stillCurrent: () => true,
		signal: abandoned.signal,
	}), { kind: "not-sent", reason: "not-ready" });

	// Caller code that replaces the destination while proving still cannot
	// authorize the request: every fence is re-proved after it returns.
	assert.deepEqual(await coordinator.loadRemoteReviewSettings(valid, {
		stillCurrent: () => {
			void coordinator.perform({ type: "peer-disconnect", hostId: pair.hostId });
			return true;
		},
	}), { kind: "not-sent", reason: "target-unavailable" });
	assert.equal(pair.requester.coordinator.read().hosts?.[0]?.state, "disconnected");
	assert.deepEqual(provider.calls, [], "no refused request ever reached the owner");
});

test("a save whose write failed mid-transfer is unknown and is never replayed", async (t) => {
	let begins = 0;
	let ends = 0;
	let failNextEnd = false;
	const provider = reviewProvider();
	const pair = await reviewPair(t, {
		provider: provider.handler,
		wrapRequesterChannel: (channel) => ({
			get peerKey() { return channel.peerKey; },
			get lane() { return channel.lane; },
			get label() { return channel.label; },
			get bufferedAmount() { return channel.bufferedAmount; },
			get closed() { return channel.closed; },
			close: () => channel.close(),
			onMessage: (handler) => channel.onMessage(handler),
			send: (bytes) => {
				const frame = decodeRosterBridgeFrame(bytes);
				if (frame.type === "review_settings_begin") begins += 1;
				if (frame.type === "review_settings_end") {
					ends += 1;
					if (failNextEnd) {
						failNextEnd = false;
						// The write WAS invoked and refused: the bytes may have reached the
						// owner, so nothing may claim not-sent or try again.
						return Promise.reject(new Error("synthetic write failure"));
					}
				}
				return channel.send(bytes);
			},
		}),
	});
	await waitReview(pair.requester, true, "the owner's described On");

	failNextEnd = true;
	assert.deepEqual(await pair.requester.coordinator.saveRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, payload: VIEWER_ENVELOPE }, PROVEN,
	), { kind: "unknown" });
	assert.equal(begins, 1);
	assert.equal(ends, 1);
	assert.equal(provider.calls.length, 0, "an incomplete transfer never becomes a save");

	// Nothing re-sends on its own: no new attempt appears without a new caller request.
	await delay(250);
	assert.equal(begins, 1, "the coordinator never replays a save that may have reached the owner");
	assert.equal(ends, 1);
	assert.equal(provider.calls.length, 0);

	// A NEW deliberate request is a NEW attempt (a fresh request number), not a
	// replay: the owner still holds the incomplete transfer of the first one and
	// honestly refuses a second concurrent operation, and its provider was never
	// reached by either.
	assert.deepEqual(await pair.requester.coordinator.saveRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId, payload: VIEWER_ENVELOPE }, PROVEN,
	), { kind: "owner-result", outcome: { kind: "refused", reason: "busy" } });
	assert.equal(begins, 2);
	assert.deepEqual(provider.calls, [], "neither the lost save nor its follow-up became owner work");
});

test("a connected destination is never held open: a later Off-to-On opt-in does not release a saved wait", async (t) => {
	// The optional wait exists ONLY for an automatic reconnect that is already
	// running. Here the binding is live and complete and only the owner's opt-in is
	// missing, so a request is answered immediately and can never be revived by the
	// owner turning its opt-in back On.
	const provider = reviewProvider();
	const pair = await reviewPair(t, { provider: provider.handler, autoReconnect: true });
	await waitReview(pair.requester, true, "the owner's described On");
	const target = { hostId: pair.hostId, hostRunId: pair.hostRunId };

	await pair.owner.coordinator.perform({ type: "peer-remote-review-settings", enabled: false });
	await waitReview(pair.requester, false, "the owner's Off description on the SAME live binding");

	const started = Date.now();
	assert.deepEqual(await pair.requester.coordinator.saveRemoteReviewSettings(
		{ ...target, payload: VIEWER_ENVELOPE },
		{ stillCurrent: () => true, waitForReconnectMs: PEER_REMOTE_REVIEW_SETTINGS_WAIT_MAX_MS },
	), { kind: "not-sent", reason: "target-unavailable" }, "a live binding with an Off owner never waits");
	assert.ok(Date.now() - started < 2_000, "the request was refused, not queued");

	// The owner opts back In on the same connection. The already-answered save must
	// not wake up and send on its own.
	await pair.owner.coordinator.perform({ type: "peer-remote-review-settings", enabled: true });
	await waitReview(pair.requester, true, "the owner's On description again");
	await delay(250);
	assert.deepEqual(provider.calls, [], "no save was attempted, then or later");

	// A NEW deliberate request on the restored opt-in is a normal send.
	assert.deepEqual(await pair.requester.coordinator.saveRemoteReviewSettings(
		{ ...target, payload: VIEWER_ENVELOPE }, PROVEN,
	), { kind: "owner-result", outcome: { kind: "accepted" } });
	assert.equal(provider.calls.length, 1);
});

test("a load already past the write boundary keeps the owner's definite refusal even when Off lands first", async (t) => {
	// The owner's opt-in is a description, and a description can race ahead of the
	// answer it does not change. The frame is held inside the transport AFTER the
	// last-instant write gate passed; the owner then opts Out, and its Off description
	// reaches this side before its own definite `refused/policy` for the SAME live
	// binding and run. That refusal is the answer — never `unknown`.
	const provider = reviewProvider();
	let held = 0;
	const releases: (() => void)[] = [];
	const pair = await reviewPair(t, {
		provider: provider.handler,
		requesterGate: (frame) => {
			if (frame.type !== "review_settings_begin") return undefined;
			held += 1;
			return new Promise<void>((resolve) => {
				releases.push(resolve);
			});
		},
	});
	await waitReview(pair.requester, true, "the owner's described On");

	const loading = pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId }, PROVEN,
	);
	const committed = Date.now();
	while (held === 0 && Date.now() - committed < 5_000) await delay(10);
	assert.equal(held, 1, "the load's frame committed to the transport");

	// The owner opts Out on the same live binding, and this side sees Off first.
	await pair.owner.coordinator.perform({ type: "peer-remote-review-settings", enabled: false });
	await waitReview(pair.requester, false, "the Off description this side receives before the answer");
	assert.equal(pair.requester.coordinator.read().hosts?.[0]?.state, "connected");

	for (const release of releases) release();
	assert.deepEqual(await loading,
		{ kind: "owner-result", outcome: { kind: "refused", reason: "policy" } },
		"the still-current binding's definite refusal survives a newer Off description");
	assert.deepEqual(provider.calls, [], "the owner's live policy denied it before its provider was reached");
});

test("the optional bounded wait rides an already running Auto reconnect and aborts on an explicit mutation", async (t) => {
	const port = await reserveLoopbackPort(t);
	const provider = reviewProvider();
	const pair = await reviewPair(t, {
		provider: provider.handler,
		port,
		autoReconnect: true,
		autoReconnectDelaysMs: [500, 1_000, 2_000],
	});
	await waitReview(pair.requester, true, "the owner's described On");

	// The owner stops hosting: the connection is lost and the destination's OWN
	// automatic schedule takes over.
	await pair.owner.coordinator.perform({ type: "peer-listener", enabled: false, host: "127.0.0.1", port: String(port) });
	await pair.requester.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.state === "retrying",
		"the destination's automatic reconnect schedule",
	);
	// The same destination and run are still named, but nothing is sendable yet.
	assert.deepEqual(reviewOf(pair.requester.coordinator.read()), { supported: false, enabled: null });

	// Re-bind the SAME address, then let one request wait for the attempt that is
	// already scheduled. No Connect, pair, retry, or re-dial is asked of anyone.
	await pair.owner.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: String(port) });
	assert.equal(pair.owner.coordinator.read().listener.state, "listening");
	const loaded = await pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId },
		{ stillCurrent: () => true, waitForReconnectMs: 10_000 },
	);
	assert.deepEqual(loaded, { kind: "owner-result", outcome: { kind: "loaded", payload: OWNER_ENVELOPE } },
		"the same pin, destination, and owner run came back on the existing schedule");
	assert.equal(pair.requester.coordinator.read().hosts?.[0]?.state, "connected");
	assert.deepEqual(reviewOf(pair.requester.coordinator.read()), { supported: true, enabled: true });
	assert.equal(provider.calls.filter((call) => call.kind === "load").length, 1);

	// An explicit mutation during a wait aborts it instead of letting it land.
	await pair.owner.coordinator.perform({ type: "peer-listener", enabled: false, host: "127.0.0.1", port: String(port) });
	await pair.requester.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.state === "retrying",
		"the second automatic reconnect schedule",
	);
	const pending = pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId },
		{ stillCurrent: () => true, waitForReconnectMs: 10_000 },
	);
	await delay(50);
	await pair.requester.coordinator.perform({ type: "peer-disconnect", hostId: pair.hostId });
	assert.deepEqual(await pending, { kind: "not-sent", reason: "target-unavailable" },
		"an explicit Disconnect ends the wait; it never lands later");
});

test("a wait is bound to its own Auto attempt and is never adopted by the next schedule", async (t) => {
	// The destination's endpoint, pin, and owner run are IDENTICAL across these two
	// automatic attempts — only the attempt itself differs. A request admitted against
	// the first one must not survive into the second.
	const port = await reserveLoopbackPort(t);
	const provider = reviewProvider();
	let withholdPolicy = false;
	const pair = await reviewPair(t, {
		provider: provider.handler,
		port,
		autoReconnect: true,
		autoReconnectDelaysMs: [400, 400, 400],
		wrapRequesterChannel: (channel) => ({
			get peerKey() { return channel.peerKey; },
			get lane() { return channel.lane; },
			get label() { return channel.label; },
			get bufferedAmount() { return channel.bufferedAmount; },
			get closed() { return channel.closed; },
			close: () => channel.close(),
			onMessage: (handler) => channel.onMessage((bytes) => {
				if (withholdPolicy && decodeRosterBridgeFrame(bytes).type === "review_settings_policy") return;
				handler(bytes);
			}),
			send: (bytes) => channel.send(bytes),
		}),
	});
	await waitReview(pair.requester, true, "the owner's described On");
	const target = { hostId: pair.hostId, hostRunId: pair.hostRunId };

	// The owner stops hosting and the destination's OWN automatic schedule takes over.
	await pair.owner.coordinator.perform({ type: "peer-listener", enabled: false, host: "127.0.0.1", port: String(port) });
	await pair.requester.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.state === "retrying",
		"the first automatic reconnect schedule",
	);

	// One save is admitted against THAT attempt. Its policy publication is withheld,
	// so the attempt restores everything except its last description.
	withholdPolicy = true;
	await pair.owner.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: String(port) });
	const saving = pair.requester.coordinator.saveRemoteReviewSettings(
		{ ...target, payload: VIEWER_ENVELOPE },
		{ stillCurrent: () => true, waitForReconnectMs: PEER_REMOTE_REVIEW_SETTINGS_WAIT_MAX_MS },
	);
	await pair.requester.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.state === "connected" && snapshot.hosts[0].roster.state === "current",
		"the waited-for attempt restored with its roster current",
	);
	assert.deepEqual(reviewOf(pair.requester.coordinator.read()), { supported: true, enabled: null },
		"the restored attempt has not yet described its opt-in");

	// That attempt's channel is lost BEFORE its policy arrives. The next schedule is a
	// DIFFERENT attempt with the same endpoint, pin, and run, so only the captured
	// attempt identity can keep the old save from riding it.
	withholdPolicy = false;
	const lost = Date.now();
	await pair.owner.coordinator.perform({ type: "peer-listener", enabled: false, host: "127.0.0.1", port: String(port) });
	// The request ends with the attempt it was admitted against. Sitting open to its
	// own deadline (or landing later) would mean it survived into the next schedule.
	const settled = await Promise.race([
		saving.then(() => "settled" as const),
		delay(2_000).then(() => "still-waiting" as const),
	]);
	assert.equal(settled, "settled", "the request ends when its own attempt is lost");
	assert.ok(Date.now() - lost < 2_000, "it ends on the loss, not on its deadline");
	assert.deepEqual(await saving, { kind: "not-sent", reason: "target-unavailable" },
		"a request is never adopted by a later automatic schedule");
	assert.deepEqual(provider.calls, [], "the save never became owner work");

	// The next schedule reconnects on its own; a NEW deliberate save succeeds.
	await pair.owner.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: String(port) });
	await waitReview(pair.requester, true, "the next attempt's policy description");
	assert.deepEqual(await pair.requester.coordinator.saveRemoteReviewSettings(
		{ ...target, payload: VIEWER_ENVELOPE }, PROVEN,
	), { kind: "owner-result", outcome: { kind: "accepted" } });
	assert.equal(provider.calls.length, 1, "only the new deliberate save became owner work");
});

test("with Auto off the optional wait never connects, pairs, or retries on its own", async (t) => {
	const provider = reviewProvider();
	const pair = await reviewPair(t, { provider: provider.handler });
	await waitReview(pair.requester, true, "the owner's described On");

	await pair.owner.coordinator.perform({ type: "peer-listener", enabled: false, host: "127.0.0.1", port: String(pair.port) });
	await pair.requester.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.state === "disconnected",
		"the requester to observe the loss without any automatic schedule",
	);
	const started = Date.now();
	assert.deepEqual(await pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId },
		{ stillCurrent: () => true, waitForReconnectMs: 10_000 },
	), { kind: "not-sent", reason: "target-unavailable" });
	assert.ok(Date.now() - started < 2_000, "no automatic attempt existed, so the wait ended immediately");
	assert.equal(pair.requester.coordinator.read().hosts?.[0]?.state, "disconnected", "nothing connected");
	assert.equal(pair.requester.coordinator.read().consents.length, 0, "nothing paired");
	assert.equal(provider.calls.length, 0);
});

test("shutdown releases an in-flight bounded wait instead of holding it to its deadline", async (t) => {
	const port = await reserveLoopbackPort(t);
	const provider = reviewProvider();
	const pair = await reviewPair(t, {
		provider: provider.handler,
		port,
		autoReconnect: true,
		autoReconnectDelaysMs: [500, 1_000, 2_000],
	});
	await waitReview(pair.requester, true, "the owner's described On");
	await pair.owner.coordinator.perform({ type: "peer-listener", enabled: false, host: "127.0.0.1", port: String(port) });
	await pair.requester.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.state === "retrying",
		"the destination's automatic reconnect schedule",
	);
	const pending = pair.requester.coordinator.loadRemoteReviewSettings(
		{ hostId: pair.hostId, hostRunId: pair.hostRunId },
		{ stillCurrent: () => true, waitForReconnectMs: PEER_REMOTE_REVIEW_SETTINGS_WAIT_MAX_MS },
	);
	await delay(50);
	await pair.requester.coordinator.close();
	assert.deepEqual(await pending, { kind: "not-sent", reason: "not-ready" });
	assert.equal(provider.calls.length, 0);
});
