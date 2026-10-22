/**
 * Real-loopback lifecycle coverage for the network sidebar coordinator (#482).
 *
 * Every test owns synthetic agent directories under the platform temp
 * directory, an in-memory authoritative inventory, and owned loopback ports. The
 * coordinator runs its real transport, real protected preference/trust stores,
 * and the real metadata bridge; only the session manager is a minimal read-only
 * inventory stand-in. No account key, saved preference, listener, or live
 * session outside the test process is touched.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import test, { type TestContext } from "node:test";

import type { PeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permission-policy";
import {
	PEER_UI_CONSENT_WINDOW_MS,
	PEER_UI_PAIRING_RESPONSE_TIMEOUT_MS,
	createPeerCoordinator,
	isPeerCoordinatorCloseError,
	type PeerCoordinatorOptions,
	type PeerCoordinatorTestHooks,
} from "../src/session-host/network/peer-coordinator";
import type { OwnerCloseRequest } from "../src/session-host/network/peer-close";
import type { PeerByteChannel } from "../src/session-host/network/channel";
import {
	DEFAULT_PEER_PREFERENCES,
	openPeerPreferencesStoreWithPermissions,
} from "../src/session-host/network/peer-preferences-store";
import { generatePeerIdentity } from "../src/session-host/network/identity";
import { openPeerStateStoreWithPermissions } from "../src/session-host/network/peer-state-store";
import type { PeerCoordinator } from "../src/session-host/peer-ui-protocol";
import { assertRefused } from "./session-host-network-helpers";
import { createPosixTestPolicy } from "./session-host-network-peer-state-fixtures";
import {
	SECRET_WORKSPACE,
	consentsOf,
	createFakeInventory,
	createOwnedAgentDir,
	createSnapshotLog,
	delay,
	reserveLoopbackPort,
	rowView,
	startCoordinator,
	type FakeInventory,
	type StartedCoordinator,
} from "./session-host-network-peer-coordinator-helpers";

const APPROVE_BOTH = Object.freeze({ approveServerKey: true, decideIncoming: "approve" as const });

function policies(): {
	preferencesPermissions: PeerStatePermissionPolicy;
	peerStatePermissions: PeerStatePermissionPolicy;
} {
	return {
		preferencesPermissions: createPosixTestPolicy(),
		peerStatePermissions: createPosixTestPolicy(),
	};
}

function hooks(extra: Partial<PeerCoordinatorTestHooks> = {}): PeerCoordinatorTestHooks {
	return { ...policies(), ...extra };
}

async function bindHost(t: TestContext, agentDir: string, port: number | 0, extra: Partial<PeerCoordinatorTestHooks> = {}): Promise<StartedCoordinator> {
	const side = await startCoordinator(t, { agentDir, testHooks: hooks(extra) });
	await side.coordinator.perform({
		type: "peer-listener",
		enabled: true,
		host: "127.0.0.1",
		port: String(port),
	});
	const state = side.coordinator.read().listener;
	assert.equal(state.state, "listening");
	return side;
}

async function addDestination(
	side: StartedCoordinator,
	label: string,
	port: number,
): Promise<string> {
	await side.coordinator.perform({ type: "peer-add", label, host: "127.0.0.1", port: String(port) });
	const snapshot = side.coordinator.read();
	const host = snapshot.hosts?.find((candidate) => candidate.port === port);
	assert.ok(host, "the destination was not saved");
	assert.equal(host.port, port);
	return host.id;
}

/** Connect and approve the local first-use key plus the remote human window. */
async function connectWithApprovals(
	clientSide: StartedCoordinator,
	hostSide: StartedCoordinator,
	hostId: string,
	options: { approveServerKey?: boolean; decideIncoming?: "approve" | "deny" } = APPROVE_BOTH,
): Promise<void> {
	const connecting = clientSide.coordinator.perform({ type: "peer-connect", hostId });
	if (options.approveServerKey !== false) {
		const withKey = await clientSide.log.waitFor(
			(snapshot) => consentsOf(snapshot, "server-key").length > 0,
			"the local first-use server-key consent",
		);
		const consent = consentsOf(withKey, "server-key")[0];
		assert.ok(consent);
		assert.equal(clientSide.coordinator.decideConsent(consent.id, "approve"), true);
	}
	if (options.decideIncoming !== undefined) {
		const withIncoming = await hostSide.log.waitFor(
			(snapshot) => consentsOf(snapshot, "incoming").length > 0,
			"the receiving pairing consent",
		);
		const consent = consentsOf(withIncoming, "incoming")[0];
		assert.ok(consent);
		assert.equal(hostSide.coordinator.decideConsent(consent.id, options.decideIncoming), true);
	}
	await connecting;
}

async function waitConnected(side: StartedCoordinator, message: string, timeoutMs = 10_000) {
	return side.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.state === "connected" && snapshot.hosts[0].roster.state === "current",
		message,
		timeoutMs,
	);
}

function expectNoConsentRecorded(side: StartedCoordinator, fromIndex = 0): void {
	assert.equal(
		side.log.snapshots.slice(fromIndex).some((snapshot) => snapshot.consents.length > 0),
		false,
		"no consent should have been requested",
	);
}

/** Proves the owner's inventory still serves a fresh read-only watch. */
function assertInventoryServes(inventory: FakeInventory, expectedRows: number): void {
	const watch = inventory.watchInventory(() => undefined);
	assert.ok(watch, "the owner inventory is still observable");
	assert.equal(watch.snapshot.rows.length, expectedRows);
	watch.unsubscribe();
}


interface ControlledChannel {
	readonly hook: (channel: PeerByteChannel) => PeerByteChannel;
	readonly closeStarted: Promise<void>;
	resolveClose(): void;
	rejectClose(): void;
	holdSends(): void;
	readonly heldSendCount: number;
}

/**
 * Fixture-only channel wrapper around one already-authenticated outgoing
 * connection. It forwards every fact and handler, and lets a test control or
 * fail the LOCAL close, and withhold outgoing control writes.
 */
function controlledChannel(): ControlledChannel {
	let inner: PeerByteChannel | null = null;
	let startClose: () => void = () => undefined;
	const closeStarted = new Promise<void>((resolve) => {
		startClose = resolve;
	});
	let settleClose: () => void = () => undefined;
	let failClose: (error: unknown) => void = () => undefined;
	let closePromise: Promise<void> | null = null;
	let holding = false;
	let heldSends = 0;
	const requireInner = (): PeerByteChannel => {
		if (inner === null) throw new Error("controlled channel was not wrapped");
		return inner;
	};
	const wrapper: PeerByteChannel = {
		get peerKey() {
			return requireInner().peerKey;
		},
		get lane() {
			return requireInner().lane;
		},
		get label() {
			return requireInner().label;
		},
		get bufferedAmount() {
			return requireInner().bufferedAmount;
		},
		get closed() {
			return requireInner().closed;
		},
		send(bytes: Uint8Array): Promise<void> {
			if (holding) {
				heldSends += 1;
				return new Promise<void>(() => undefined);
			}
			return requireInner().send(bytes);
		},
		close(): Promise<void> {
			if (closePromise !== null) return closePromise;
			closePromise = new Promise<void>((resolve, reject) => {
				settleClose = resolve;
				failClose = reject;
				startClose();
			});
			return closePromise;
		},
		onMessage(handler: (bytes: Buffer) => void): () => void {
			return requireInner().onMessage(handler);
		},
	};
	return {
		hook(channel) {
			inner = channel;
			return wrapper;
		},
		closeStarted,
		resolveClose() {
			void requireInner().close().catch(() => undefined).then(() => settleClose());
		},
		rejectClose() {
			void requireInner().close().catch(() => undefined).then(() => {
				failClose(new Error("synthetic local close failure"));
			});
		},
		holdSends() {
			holding = true;
		},
		get heldSendCount() {
			return heldSends;
		},
	};
}

function readPreferencesJson(fixture: ReturnType<typeof createOwnedAgentDir>): Record<string, unknown> {
	return JSON.parse(readFileSync(fixture.preferencesPath, "utf8")) as Record<string, unknown>;
}

interface ListenerCloseControl {
	/** Report a completed close callback while the listener is still bound. */
	arm(): void;
	/** Hold every close callback until `releaseAll()` is called. */
	hold(): void;
	/** Invoke every held close callback while the listener is still bound. */
	releaseAll(): void;
	/** Resolves when the first close callback is held. */
	readonly closeHeld: Promise<void>;
	/** How many HTTPS listeners the coordinator constructed. */
	readonly created: number;
	/** Restore the real factory and physically release every captured listener. */
	restore(): Promise<void>;
}

/**
 * Fixture-only mock of the EXACT owned HTTPS listener the coordinator
 * constructs. While armed, that server's own `close()` invokes the callback it
 * was given while the server is still listening; while holding, it defers the
 * callback until the test releases it. Both are teardown outcomes the
 * coordinator must never mistake for a settled release. Restoration puts the
 * real factory back and physically closes every captured listener (then settles
 * any still-held callback), so no test-owned socket or promise outlives the
 * fixture. No production transport code and no other server in the process is
 * affected.
 */
function controlledListenerClose(): ListenerCloseControl {
	const module = https as unknown as { createServer: typeof https.createServer };
	const originalCreateServer = module.createServer;
	const originalClose = net.Server.prototype.close;
	const captured: https.Server[] = [];
	const held: Array<() => void> = [];
	let mode: "pass" | "unconfirmed" | "hold" = "pass";
	let noteHeld: () => void = () => undefined;
	const closeHeld = new Promise<void>((resolve) => {
		noteHeld = resolve;
	});
	module.createServer = ((...args: unknown[]) => {
		const server = (originalCreateServer as (...rest: unknown[]) => https.Server)(...args);
		captured.push(server);
		Object.defineProperty(server, "close", {
			configurable: true,
			writable: true,
			value: (callback?: (error?: Error) => void): https.Server => {
				if (mode === "pass") return originalClose.call(server, callback) as https.Server;
				const settle = (): void => callback?.();
				if (mode === "unconfirmed") {
					settle();
					return server;
				}
				held.push(settle);
				noteHeld();
				return server;
			},
		});
		return server;
	}) as typeof https.createServer;
	return {
		arm() {
			mode = "unconfirmed";
		},
		hold() {
			mode = "hold";
		},
		releaseAll() {
			for (const settle of held.splice(0)) settle();
		},
		closeHeld,
		get created() {
			return captured.length;
		},
		async restore() {
			mode = "pass";
			module.createServer = originalCreateServer;
			for (const server of captured) {
				if (!server.listening) continue;
				server.closeAllConnections?.();
				await new Promise<void>((resolve) => {
					originalClose.call(server, () => resolve());
				});
			}
			// A callback still held reports completion only after its socket is
			// physically released, so the fixture leaves no dangling promise.
			this.releaseAll();
			captured.length = 0;
		},
	};
}

test("sidebar consent windows keep the real human window plus finite reply overhead", () => {
	assert.equal(PEER_UI_CONSENT_WINDOW_MS, 120_000);
	assert.equal(PEER_UI_PAIRING_RESPONSE_TIMEOUT_MS, 150_000);
	assert.ok(PEER_UI_PAIRING_RESPONSE_TIMEOUT_MS > PEER_UI_CONSENT_WINDOW_MS);
	assert.equal(DEFAULT_PEER_PREFERENCES.hosting.enabled, false);
	assert.equal(DEFAULT_PEER_PREFERENCES.autoReconnect, false);
	assert.equal(DEFAULT_PEER_PREFERENCES.bellEnabled, true);
});

test("a fresh sidebar reads honest defaults, creates nothing, and saves settings without an identity", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const side = await startCoordinator(t, { agentDir: fixture.agentDir, testHooks: hooks() });
	const snapshot = side.coordinator.read();
	assert.equal(snapshot.status, "ready");
	assert.deepEqual(snapshot.settings, {
		hostingEnabled: false,
		bindHost: "",
		bindPort: null,
		autoReconnect: false,
		bellEnabled: true,
	});
	assert.equal(snapshot.identityFingerprint, null);
	assert.deepEqual(snapshot.listener, { state: "off", host: null, port: null, message: null });
	assert.deepEqual(snapshot.hosts, []);
	assert.deepEqual(snapshot.trustedPeers, []);
	assert.deepEqual(snapshot.consents, []);
	assert.equal(existsSync(fixture.sessionHostDir), false, "starting reads state without creating anything");

	// A display preference is saved into its own private directory and never
	// requires an identity or the key/trust directory.
	await side.coordinator.perform({ type: "peer-bell", enabled: false });
	assert.equal(side.coordinator.read().settings?.bellEnabled, false);
	assert.equal(side.coordinator.read().identityFingerprint, null);
	assert.equal(existsSync(fixture.peersDir), false, "saving settings does not create the key directory");
	assert.equal(existsSync(fixture.statePath), false, "saving settings does not generate an identity");
	assert.equal(existsSync(fixture.preferencesPath), true);

	await side.coordinator.close();
	const reopened = await startCoordinator(t, { agentDir: fixture.agentDir, testHooks: hooks() });
	assert.equal(reopened.coordinator.read().settings?.bellEnabled, false);
	assert.equal(reopened.coordinator.read().identityFingerprint, null);
});

test("the product default platform policy supports saved settings and an explicit identity", async (t) => {
	// No injected policy: this uses the real `openPeerStateStore` entry point and
	// the real platform permission policy for both protected stores.
	const fixture = createOwnedAgentDir(t);
	const side = await startCoordinator(t, { agentDir: fixture.agentDir });
	await side.coordinator.perform({ type: "peer-bell", enabled: false });
	assert.equal(side.coordinator.read().settings?.bellEnabled, false);
	assert.equal(side.coordinator.read().identityFingerprint, null);
	await side.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	assert.equal(side.coordinator.read().listener.state, "listening");
	assert.ok(side.coordinator.read().identityFingerprint);
});

test("explicit Enable creates one identity and a fresh listener on the same stored state", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const side = await startCoordinator(t, { agentDir: fixture.agentDir, testHooks: hooks() });
	await side.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	const listening = side.coordinator.read();
	assert.equal(listening.listener.state, "listening");
	assert.equal(listening.listener.host, "127.0.0.1");
	assert.ok((listening.listener.port ?? 0) > 0, "the actual bound port is reported");
	assert.equal(listening.settings?.hostingEnabled, true);
	assert.equal(listening.settings?.bindHost, "127.0.0.1");
	assert.equal(listening.settings?.bindPort, 0, "the saved explicit value stays explicit");
	const fingerprint = listening.identityFingerprint;
	assert.ok(fingerprint, "explicit Enable initializes the identity");

	// Disabling keeps the saved bind intent; re-enabling constructs a fresh
	// transport on the same identity and stores.
	await side.coordinator.perform({ type: "peer-listener", enabled: false, host: "", port: "" });
	assert.equal(side.coordinator.read().listener.state, "off");
	assert.equal(side.coordinator.read().settings?.hostingEnabled, false);
	assert.equal(side.coordinator.read().settings?.bindHost, "127.0.0.1");
	assert.equal(side.coordinator.read().settings?.bindPort, 0);
	assert.equal(side.coordinator.read().identityFingerprint, fingerprint);

	await side.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	assert.equal(side.coordinator.read().listener.state, "listening");
	assert.equal(side.coordinator.read().identityFingerprint, fingerprint);
});

test("saved hosting never regenerates a missing identity at startup", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const port = await reserveLoopbackPort(t);
	const store = openPeerPreferencesStoreWithPermissions({
		agentDir: fixture.agentDir,
		permissions: createPosixTestPolicy(),
	});
	store.write({
		...DEFAULT_PEER_PREFERENCES,
		hosting: { enabled: true, bindHost: "127.0.0.1", bindPort: port },
	});
	store.close();
	assert.equal(existsSync(fixture.statePath), false);

	const side = await startCoordinator(t, { agentDir: fixture.agentDir, testHooks: hooks() });
	const snapshot = side.coordinator.read();
	assert.equal(snapshot.settings?.hostingEnabled, true);
	assert.equal(snapshot.listener.state, "error");
	assert.match(snapshot.listener.message ?? "", /identity that is no longer present/);
	assert.equal(snapshot.identityFingerprint, null);
	assert.equal(existsSync(fixture.statePath), false, "startup must not generate an identity");
	await assertRefused(port);
});

test("one-time pairing, independent directions, and current owner metadata survive reconstruction", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0);
	await b.inventory.setRows([rowView("one")]);
	const bPort = b.coordinator.read().listener.port as number;

	const a = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		inventory: createFakeInventory(),
		testHooks: hooks(),
	});
	const hostId = await addDestination(a, "B laptop", bPort);
	await connectWithApprovals(a, b, hostId);

	const connected = await waitConnected(a, "A's connected metadata roster");
	const host = connected.hosts?.[0];
	assert.ok(host);
	assert.equal(host.fingerprint, b.coordinator.read().identityFingerprint);
	assert.equal(host.previouslyConnected, true);
	assert.equal(host.reconnectSuppressed, false);
	assert.equal(host.roster.state, "current");
	const rows = host.roster.rows;
	assert.ok(rows);
	assert.equal(rows.length, 1);
	assert.equal(rows[0]?.id, "one");
	assert.equal(rows[0]?.workspace, SECRET_WORKSPACE);
	assert.equal((rows[0] as unknown as Record<string, unknown>).agentDir, undefined);
	assert.equal(a.inventory.activeWatches, 0, "metadata comes from the owner, never a local proxy");
	// `read()`/`onChange` hand out immutable display state end to end.
	assert.equal(Object.isFrozen(connected), true);
	assert.equal(Object.isFrozen(connected.settings), true);
	assert.equal(Object.isFrozen(host), true);
	assert.equal(Object.isFrozen(host.roster), true);
	assert.equal(Object.isFrozen(host.roster.rows), true);
	assert.equal(Object.isFrozen(rows[0]), true);
	assert.throws(() => {
		(rows[0] as { label: string }).label = "mutated";
	}, TypeError);
	assert.notEqual(host.roster.rows?.[0]?.label, "mutated");
	assert.equal(Object.isFrozen(a.coordinator.read().trustedPeers), true);

	// Directions are independent: A has authorized nothing inbound; B holds A's
	// exact key plus its own inbound grant.
	assert.deepEqual(a.coordinator.read().trustedPeers, []);
	const bTrust = b.coordinator.read().trustedPeers;
	assert.ok(bTrust);
	assert.equal(bTrust.length, 1);
	assert.equal(bTrust[0]?.hasInboundGrant, true);
	assert.equal(bTrust[0]?.fingerprint, a.coordinator.read().identityFingerprint);
	assert.equal(b.log.arrivals.length, 1, "one arrival signal for one new incoming handle");

	// Reconstruct A from the same protected stores: connecting again must not ask
	// for either consent again.
	const arrivalsBefore = b.log.arrivals.length;
	await a.coordinator.close();
	const reopened = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		inventory: createFakeInventory(),
		testHooks: hooks(),
	});
	const reopenedHost = reopened.coordinator.read().hosts?.[0];
	assert.ok(reopenedHost);
	assert.equal(reopenedHost.id, hostId);
	assert.equal(reopenedHost.previouslyConnected, true);
	assert.ok(reopenedHost.fingerprint, "the remembered key survived reconstruction");
	await reopened.coordinator.perform({ type: "peer-connect", hostId });
	expectNoConsentRecorded(reopened);
	assert.equal(b.log.arrivals.length, arrivalsBefore);
	const reconnected = await waitConnected(reopened, "the reconstructed connection's roster");
	assert.equal(reconnected.hosts?.[0]?.roster.rows?.length, 1);
});

test("a denied or expired receiving approval is terminal and creates no trust", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0, { consentWindowMs: 2_000 });
	const bPort = b.coordinator.read().listener.port as number;
	const a = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		testHooks: hooks({ consentWindowMs: 2_000 }),
	});
	const hostId = await addDestination(a, "B laptop", bPort);
	await connectWithApprovals(a, b, hostId, { approveServerKey: true, decideIncoming: "deny" });

	const failed = await a.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.state === "error",
		"the denied pairing's terminal state",
	);
	assert.match(failed.hosts?.[0]?.message ?? "", /denied/);
	assert.equal(failed.hosts?.[0]?.fingerprint, null);
	assert.equal(failed.hosts?.[0]?.previouslyConnected, false);
	assert.deepEqual(b.coordinator.read().trustedPeers, []);
	assert.deepEqual(b.coordinator.read().consents, []);
});

test("an expired remote human window is reported as expiry, not as a grant or a retry loop", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0, { consentWindowMs: 250 });
	const bPort = b.coordinator.read().listener.port as number;
	const a = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		testHooks: hooks({ consentWindowMs: 2_000 }),
	});
	const hostId = await addDestination(a, "B laptop", bPort);
	const connecting = a.coordinator.perform({ type: "peer-connect", hostId });
	const keySnapshot = await a.log.waitFor(
		(snapshot) => consentsOf(snapshot, "server-key").length > 0,
		"the local first-use consent",
	);
	const keyConsent = consentsOf(keySnapshot, "server-key")[0];
	assert.ok(keyConsent);
	assert.equal(a.coordinator.decideConsent(keyConsent.id, "approve"), true);
	// The receiving human window elapses with no decision; settlement is
	// event-wise, so the alert clears without any polling.
	await b.log.waitFor((snapshot) => snapshot.consents.length === 0, "the expired incoming consent", 5_000);
	await connecting;
	const failed = await a.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.state === "error",
		"the expired pairing's terminal state",
	);
	assert.match(failed.hosts?.[0]?.message ?? "", /expired/);
	assert.equal(failed.hosts?.[0]?.fingerprint, null);
});

test("explicit Disconnect suppresses Auto recovery across restart until an explicit Connect", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0);
	const bPort = b.coordinator.read().listener.port as number;
	const a = await startCoordinator(t, { agentDir: aFixture.agentDir, testHooks: hooks() });
	const hostId = await addDestination(a, "B laptop", bPort);
	await connectWithApprovals(a, b, hostId);
	await waitConnected(a, "the initial connection");

	await a.coordinator.perform({ type: "peer-auto-reconnect", enabled: true });
	await a.coordinator.perform({ type: "peer-disconnect", hostId });
	const disconnected = a.coordinator.read();
	assert.equal(disconnected.hosts?.[0]?.state, "disconnected");
	assert.equal(disconnected.hosts?.[0]?.reconnectSuppressed, true);
	assert.equal(disconnected.hosts?.[0]?.previouslyConnected, true);
	assert.ok(disconnected.hosts?.[0]?.fingerprint, "Disconnect preserves the remembered key");

	const arrivalsBefore = b.log.arrivals.length;
	await a.coordinator.close();
	const reopened = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		testHooks: hooks({ autoReconnectDelaysMs: [40, 40] }),
	});
	const reopenedHost = reopened.coordinator.read().hosts?.[0];
	assert.ok(reopenedHost);
	assert.equal(reopened.coordinator.read().settings?.autoReconnect, true);
	assert.equal(reopenedHost.reconnectSuppressed, true);
	await delay(200);
	assert.equal(reopened.coordinator.read().hosts?.[0]?.state, "disconnected");
	assert.equal(b.log.arrivals.length, arrivalsBefore, "suppressed recovery never pairs");

	// Explicit Connect re-arms without new consent (the association is intact).
	await reopened.coordinator.perform({ type: "peer-connect", hostId });
	expectNoConsentRecorded(reopened);
	await waitConnected(reopened, "the re-armed connection");
	assert.equal(reopened.coordinator.read().hosts?.[0]?.reconnectSuppressed, false);

	await reopened.coordinator.close();
	const again = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		testHooks: hooks({ autoReconnectDelaysMs: [40, 40] }),
	});
	assert.equal(again.coordinator.read().hosts?.[0]?.reconnectSuppressed, false);
});

test("Auto recovers a previously connected trusted host after loss, and Auto off keeps healthy sessions", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const port = await reserveLoopbackPort(t);
	const b = await bindHost(t, bFixture.agentDir, port);
	const a = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		testHooks: hooks({ autoReconnectDelaysMs: [400, 400, 400] }),
	});
	const hostId = await addDestination(a, "B laptop", port);
	await connectWithApprovals(a, b, hostId);
	await waitConnected(a, "the initial connection");
	await a.coordinator.perform({ type: "peer-auto-reconnect", enabled: true });

	const arrivalsBefore = b.log.arrivals.length;
	const consentMark = a.log.snapshots.length;
	await b.coordinator.perform({ type: "peer-listener", enabled: false, host: "", port: "" });
	await a.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.state === "retrying",
		"the automatic retry after an unexpected loss",
	);
	// The owner comes back on the same explicit port before the owned attempt.
	await b.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: String(port) });
	const recovered = await waitConnected(a, "automatic recovery without a new consent");
	assert.equal(recovered.hosts?.[0]?.reconnectSuppressed, false);
	expectNoConsentRecorded(a, consentMark);
	assert.equal(b.log.arrivals.length, arrivalsBefore, "known-pin recovery never prompts for approval");

	// A restart with the remembered Auto toggle reconnects the previously
	// connected, still-trusted destination at startup without any new consent.
	await a.coordinator.close();
	const restarted = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		testHooks: hooks({ autoReconnectDelaysMs: [40, 40, 40] }),
	});
	assert.equal(restarted.coordinator.read().settings?.autoReconnect, true);
	await waitConnected(restarted, "startup automatic recovery");
	expectNoConsentRecorded(restarted);

	// Auto off cancels retries but leaves the healthy connection alone.
	await restarted.coordinator.perform({ type: "peer-auto-reconnect", enabled: false });
	await delay(100);
	assert.equal(restarted.coordinator.read().hosts?.[0]?.state, "connected");
	assert.equal(restarted.coordinator.read().hosts?.[0]?.roster.state, "current");

	await b.coordinator.perform({ type: "peer-listener", enabled: false, host: "", port: "" });
	await restarted.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.state === "disconnected",
		"the loss state with Auto off",
	);
	await delay(200);
	assert.equal(restarted.coordinator.read().hosts?.[0]?.state, "disconnected", "Auto off never retries");
});

test("bounded automatic attempts stop instead of retrying hot", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const port = await reserveLoopbackPort(t);
	const b = await bindHost(t, bFixture.agentDir, port);
	const a = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		testHooks: hooks({ autoReconnectDelaysMs: [40, 40] }),
	});
	const hostId = await addDestination(a, "B laptop", port);
	await connectWithApprovals(a, b, hostId);
	await waitConnected(a, "the initial connection");
	await a.coordinator.perform({ type: "peer-auto-reconnect", enabled: true });
	await b.coordinator.close();
	await a.log.waitFor(
		(snapshot) => (snapshot.hosts?.[0]?.message ?? "").includes("Automatic reconnect stopped"),
		"the bounded automatic schedule to exhaust itself",
	);
	assert.equal(a.coordinator.read().hosts?.[0]?.state, "disconnected");
});

test("Remove forgets only this side's endpoint and key; the other host's grant and work stay", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0);
	await b.inventory.setRows([rowView("one")]);
	const bPort = b.coordinator.read().listener.port as number;
	const a = await startCoordinator(t, { agentDir: aFixture.agentDir, testHooks: hooks() });
	const hostId = await addDestination(a, "B laptop", bPort);
	await connectWithApprovals(a, b, hostId);
	await waitConnected(a, "the initial connection");

	await a.coordinator.perform({ type: "peer-remove", hostId });
	assert.deepEqual(a.coordinator.read().hosts, []);
	assert.equal(a.coordinator.read().settings?.hostingEnabled, false);
	assert.equal(b.coordinator.read().listener.state, "listening", "Remove never stops the other host");
	const bTrust = b.coordinator.read().trustedPeers;
	assert.ok(bTrust);
	assert.equal(bTrust.length, 1);
	assert.equal(bTrust[0]?.hasInboundGrant, true, "Remove never revokes the remote receiving grant");
	await b.inventory.setRows([rowView("one"), rowView("two")]);
	assert.equal(b.coordinator.read().listener.state, "listening");
	assertInventoryServes(b.inventory, 2);

	// Re-adding the same endpoint requires a fresh LOCAL key confirmation. The
	// other host's association was never revoked, so its own approval is not
	// asked for again: re-pairing is idempotent on the receiving side.
	const newHostId = await addDestination(a, "B laptop", bPort);
	assert.notEqual(newHostId, hostId);
	assert.equal(a.coordinator.read().hosts?.[0]?.fingerprint, null);
	const consentMark = a.log.snapshots.length;
	await connectWithApprovals(a, b, newHostId, { approveServerKey: true });
	await waitConnected(a, "the re-added destination");
	assert.equal(
		a.log.snapshots.slice(consentMark).some((snapshot) => consentsOf(snapshot, "server-key").length > 0),
		true,
		"re-adding requires the local first-use confirmation again",
	);
	assert.equal(b.log.arrivals.length, 1, "the surviving remote association is not asked to approve again");
});

test("local Revoke removes only the receiving permission and never stops owner work", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0);
	await b.inventory.setRows([rowView("one")]);
	const bPort = b.coordinator.read().listener.port as number;
	const a = await startCoordinator(t, { agentDir: aFixture.agentDir, testHooks: hooks() });
	const hostId = await addDestination(a, "B laptop", bPort);
	await connectWithApprovals(a, b, hostId);
	await waitConnected(a, "the initial connection");
	const peerId = b.coordinator.read().trustedPeers?.[0]?.id;
	assert.ok(peerId);

	await b.coordinator.perform({ type: "peer-revoke", peerId });
	assert.deepEqual(b.coordinator.read().trustedPeers, []);
	assert.equal(b.coordinator.read().listener.state, "listening", "Revoke never stops the listener");
	await b.inventory.setRows([rowView("one"), rowView("two")]);
	assertInventoryServes(b.inventory, 2);

	// A's observations become last-observed, not current and not empty.
	const stale = await a.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.roster.state === "stale",
		"A's stale projection after the revocation",
	);
	assert.equal(stale.hosts?.[0]?.roster.rows?.length, 1);
	assert.equal(stale.hosts?.[0]?.state, "connected", "metadata revocation is not a transport teardown");
	assert.deepEqual(a.coordinator.read().trustedPeers, [], "the opposite direction is unchanged");

	// Revoking an unknown handle changes nothing and reports a safe notice.
	await b.coordinator.perform({ type: "peer-revoke", peerId });
	assert.match(b.coordinator.read().notice ?? "", /no longer available/);
});

test("a changed host key is terminal, is never overwritten, and re-confirms only after Remove", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const port = await reserveLoopbackPort(t);
	const b = await bindHost(t, bFixture.agentDir, port);
	const a = await startCoordinator(t, { agentDir: aFixture.agentDir, testHooks: hooks() });
	const hostId = await addDestination(a, "B laptop", port);
	await connectWithApprovals(a, b, hostId);
	const connected = await waitConnected(a, "the initial connection");
	const originalFingerprint = connected.hosts?.[0]?.fingerprint;
	assert.ok(originalFingerprint);
	await a.coordinator.close();
	await b.coordinator.close();

	// A new owner identity on the same endpoint is exactly the changed-key case.
	const replacementFixture = createOwnedAgentDir(t);
	const replacement = await bindHost(t, replacementFixture.agentDir, port);
	const arrivalsBefore = replacement.log.arrivals.length;
	const reopened = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		testHooks: hooks({ autoReconnectDelaysMs: [40, 40] }),
	});
	const suppressed = reopened.coordinator.read().hosts?.[0];
	assert.ok(suppressed);
	assert.equal(suppressed.fingerprint, originalFingerprint);
	await reopened.coordinator.perform({ type: "peer-connect", hostId });
	const failed = await reopened.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.state === "error",
		"the changed-key terminal state",
	);
	assert.match(failed.hosts?.[0]?.message ?? "", /key changed/);
	assert.equal(failed.hosts?.[0]?.fingerprint, originalFingerprint, "the pin is never replaced");
	assert.equal(replacement.log.arrivals.length, arrivalsBefore, "no automatic re-pair or consent prompt");
	assert.deepEqual(replacement.coordinator.read().trustedPeers, []);

	// Only an explicit local Remove forgets the pin and allows a fresh approval.
	await reopened.coordinator.perform({ type: "peer-remove", hostId });
	const newHostId = await addDestination(reopened, "B laptop", port);
	await connectWithApprovals(reopened, replacement, newHostId);
	await waitConnected(reopened, "the deliberately re-confirmed destination");
});

test("pending consent handles are cancelled on close and never replaced in place", async (t) => {
	const a1Fixture = createOwnedAgentDir(t);
	const a2Fixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0);
	const bPort = b.coordinator.read().listener.port as number;

	const a1 = await startCoordinator(t, { agentDir: a1Fixture.agentDir, testHooks: hooks() });
	const firstHostId = await addDestination(a1, "B laptop", bPort);
	const firstConnecting = a1.coordinator.perform({ type: "peer-connect", hostId: firstHostId });
	const keySnapshot = await a1.log.waitFor(
		(snapshot) => consentsOf(snapshot, "server-key").length > 0,
		"the first local first-use consent",
	);
	const keyConsent = consentsOf(keySnapshot, "server-key")[0];
	assert.ok(keyConsent);
	assert.equal(a1.coordinator.decideConsent(keyConsent.id, "approve"), true);
	const withIncoming = await b.log.waitFor(
		(snapshot) => consentsOf(snapshot, "incoming").length > 0,
		"the first incoming consent",
	);
	const firstIncoming = consentsOf(withIncoming, "incoming")[0];
	assert.ok(firstIncoming);
	assert.equal(b.log.arrivals.length, 1);
	assert.equal(b.log.arrivals[0], firstIncoming.id);

	// Closing the requester abandons its pending request event-wise.
	await a1.coordinator.close();
	await firstConnecting;
	assert.deepEqual(a1.coordinator.read().consents, []);
	assert.equal(a1.coordinator.decideConsent(keyConsent.id, "approve"), false);
	await b.log.waitFor((snapshot) => snapshot.consents.length === 0, "the abandoned incoming consent");
	assert.equal(b.coordinator.decideConsent(firstIncoming.id, "approve"), false);

	const a2 = await startCoordinator(t, { agentDir: a2Fixture.agentDir, testHooks: hooks() });
	const secondHostId = await addDestination(a2, "B desktop", bPort);
	const secondConnecting = a2.coordinator.perform({ type: "peer-connect", hostId: secondHostId });
	const secondKey = await a2.log.waitFor(
		(snapshot) => consentsOf(snapshot, "server-key").length > 0,
		"the second local first-use consent",
	);
	assert.equal(a2.coordinator.decideConsent(consentsOf(secondKey, "server-key")[0]!.id, "approve"), true);
	const secondIncomingSnapshot = await b.log.waitFor(
		(snapshot) => consentsOf(snapshot, "incoming").length === 1,
		"the second incoming consent",
	);
	const secondIncoming = consentsOf(secondIncomingSnapshot, "incoming")[0];
	assert.ok(secondIncoming);
	assert.notEqual(secondIncoming.id, firstIncoming.id);
	assert.equal(b.log.arrivals.length, 2);
	assert.equal(b.coordinator.decideConsent(secondIncoming.id, "approve"), true);
	await secondConnecting;
	await waitConnected(a2, "the second requester's connection");
});

test("a receiving grant without an accepted identity is a valid partial fact, not fabricated trust", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const store = openPeerStateStoreWithPermissions({
		agentDir: fixture.agentDir,
		permissions: createPosixTestPolicy(),
	});
	const identity = await store.initializeIdentity("owner-main");
	const remote = await generatePeerIdentity("remote-peer");
	store.grants.set({
		peerKeyId: remote.key.keyId,
		direction: "peer->host",
		capability: "app",
		grantedAt: 5,
		receiverKeyId: identity.key.keyId,
	});
	store.close();

	const side = await startCoordinator(t, { agentDir: fixture.agentDir, testHooks: hooks() });
	const trust = side.coordinator.read().trustedPeers;
	assert.ok(trust);
	assert.equal(trust.length, 1);
	assert.equal(trust[0]?.hasInboundGrant, true);
	assert.equal(trust[0]?.label, "Unknown peer");
	assert.equal(trust[0]?.fingerprint, remote.key.fingerprint);
	assert.equal(side.coordinator.read().identityFingerprint, identity.key.fingerprint);
});

test("removing a destination during pairing fences its late consent handle", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0);
	const bPort = b.coordinator.read().listener.port as number;
	const a = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		testHooks: hooks({ consentWindowMs: 2_000 }),
	});
	const hostId = await addDestination(a, "B laptop", bPort);
	const connecting = a.coordinator.perform({ type: "peer-connect", hostId });
	const keySnapshot = await a.log.waitFor(
		(snapshot) => consentsOf(snapshot, "server-key").length > 0,
		"the local first-use consent",
	);
	const staleConsentId = consentsOf(keySnapshot, "server-key")[0]!.id;

	await a.coordinator.perform({ type: "peer-remove", hostId });
	await connecting;
	assert.deepEqual(a.coordinator.read().hosts, []);
	assert.deepEqual(a.coordinator.read().consents, []);
	assert.equal(a.coordinator.decideConsent(staleConsentId, "approve"), false);
	assert.equal(a.log.arrivals.length, 0);
	await delay(50);
	assert.equal(a.coordinator.read().hosts?.length ?? 0, 0, "a late completion cannot resurrect the removed destination");
	assert.equal(b.log.arrivals.length, 0, "the requester never reached the receiving approval");
});

test("a Disable that lands during Enable keeps saved intent and the listener off", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const port = await reserveLoopbackPort(t);
	const side = await startCoordinator(t, { agentDir: fixture.agentDir, testHooks: hooks() });

	// Enable suspends while it initializes the identity; Disable must invalidate
	// that older intent before it can bind anything.
	const enabling = side.coordinator.perform({
		type: "peer-listener",
		enabled: true,
		host: "127.0.0.1",
		port: String(port),
	});
	const disabling = side.coordinator.perform({
		type: "peer-listener",
		enabled: false,
		host: "",
		port: "",
	});
	await Promise.all([enabling, disabling]);

	const snapshot = side.coordinator.read();
	assert.equal(snapshot.listener.state, "off");
	assert.equal(snapshot.settings?.hostingEnabled, false);
	assert.equal((readPreferencesJson(fixture).hosting as { enabled: boolean }).enabled, false);
	await assertRefused(port);
	await delay(100);
	assert.equal(side.coordinator.read().listener.state, "off");
	await assertRefused(port);
});

test("an unconfirmed listener stop stays sticky, blocks a rebind, and rejects close", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const listenerClose = controlledListenerClose();
	try {
		const side = await startCoordinator(t, { agentDir: fixture.agentDir, testHooks: hooks() });
		await side.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
		const listening = side.coordinator.read().listener;
		assert.equal(listening.state, "listening");
		const port = listening.port as number;

		// The listener's own close reports completion while the port is still
		// bound, so the coordinator cannot confirm the release.
		listenerClose.arm();
		await side.coordinator.perform({ type: "peer-listener", enabled: false, host: "", port: "" });
		const stopped = side.coordinator.read();
		assert.equal(stopped.listener.state, "error", "an unconfirmed stop never claims a settled off");
		assert.match(stopped.listener.message ?? "", /could not be confirmed stopped/);
		assert.equal(stopped.listener.port, port, "the port that may still be owned stays visible");
		assert.equal(stopped.settings?.hostingEnabled, false, "the explicit Disable intent is still saved");
		assert.equal((readPreferencesJson(fixture).hosting as { enabled: boolean }).enabled, false);

		// A later Enable must not silently repair or rebind over the unknown
		// listener cleanup.
		const mark = side.log.snapshots.length;
		await side.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
		const rebind = side.coordinator.read();
		assert.equal(rebind.listener.state, "error");
		assert.equal(
			side.log.snapshots.slice(mark).some((snapshot) => (
				snapshot.listener.state === "starting" || snapshot.listener.state === "listening"
			)),
			false,
			"no second listener was constructed over the uncertain port",
		);
		assert.equal(rebind.listener.port, port, "the sticky uncertainty still names the owned port");

		// Shutdown keeps the caller's ownership instead of fabricating success.
		const error = await side.coordinator.close().then(() => null, (cause: unknown) => cause);
		assert.equal(isPeerCoordinatorCloseError(error), true);
		assert.equal(side.coordinator.read().listener.state, "error");
		assert.equal(side.coordinator.read().listener.port, port, "the possibly-owned port is never reported released");
	} finally {
		await listenerClose.restore();
	}
});

test("a superseded listener start retires its own transport as sticky owned work", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const listenerClose = controlledListenerClose();
	try {
		const log = createSnapshotLog();
		let superseded = false;
		let disabling: Promise<void> | null = null;
		const coordinator: PeerCoordinator = createPeerCoordinator({
			agentDir: fixture.agentDir,
			inventory: createFakeInventory(),
			onChange: (snapshot) => {
				log.onChange(snapshot);
				if (superseded || snapshot.listener.state !== "starting") return;
				superseded = true;
				// A newer listener intent lands while this Enable is still binding, so
				// the transport that binds is detached and must retire itself.
				disabling = coordinator.perform({ type: "peer-listener", enabled: false, host: "", port: "" });
			},
			onIncomingConsentArrival: log.onArrival,
			testHooks: hooks(),
		});
		t.after(async () => {
			try {
				await coordinator.close();
			} catch {
				// A rejected close is this test's own observed outcome.
			}
		});
		await coordinator.start();
		listenerClose.arm();
		await coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
		assert.equal(superseded, true, "the newer intent landed while the Enable was binding");
		assert.ok(disabling);
		await disabling;

		// The detached transport's retirement is tracked and its unconfirmed
		// outcome is sticky, so it is never a swallowed fire-and-forget close.
		await log.waitFor(
			(snapshot) => snapshot.listener.state === "error",
			"the sticky failure from the detached listener retirement",
			5_000,
		);
		assert.equal(coordinator.read().settings?.hostingEnabled, false);
		assert.equal((readPreferencesJson(fixture).hosting as { enabled: boolean }).enabled, false);

		const mark = log.snapshots.length;
		await coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
		assert.equal(coordinator.read().listener.state, "error");
		assert.equal(
			log.snapshots.slice(mark).some((snapshot) => (
				snapshot.listener.state === "starting" || snapshot.listener.state === "listening"
			)),
			false,
			"a later Enable never rebinds after the uncertain detached retirement",
		);

		const error = await coordinator.close().then(() => null, (cause: unknown) => cause);
		assert.equal(isPeerCoordinatorCloseError(error), true);
	} finally {
		await listenerClose.restore();
	}
});

test("a held superseded-start retirement starts its own deadline and never reports a settled off", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const listenerClose = controlledListenerClose();
	t.after(async () => {
		await listenerClose.restore();
	});
	// The bounded wait below is the existing ownership deadline; this referenced
	// witness keeps the event loop alive long enough for that timer to fire.
	const keepAlive = delay(12_000);
	try {
		const log = createSnapshotLog();
		let superseded = false;
		let disabling: Promise<void> | null = null;
		const coordinator: PeerCoordinator = createPeerCoordinator({
			agentDir: fixture.agentDir,
			inventory: createFakeInventory(),
			onChange: (snapshot) => {
				log.onChange(snapshot);
				if (superseded || snapshot.listener.state !== "starting") return;
				superseded = true;
				// Disable lands before the transport is assigned, so its first sweep sees
				// nothing and the transport appears only while its barrier is awaited.
				disabling = coordinator.perform({ type: "peer-listener", enabled: false, host: "", port: "" });
			},
			onIncomingConsentArrival: log.onArrival,
			testHooks: hooks(),
		});
		t.after(async () => {
			try {
				await coordinator.close();
			} catch {
				// A rejected close is this test's own observed outcome.
			}
		});
		await coordinator.start();
		listenerClose.hold();
		await coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
		assert.equal(superseded, true, "the newer intent landed while the Enable was binding");
		assert.ok(disabling);
		await listenerClose.closeHeld;
		assert.equal(listenerClose.created, 1, "the superseded start bound exactly one transport");

		// While that retirement is undecided, an unrelated redraw must not report a
		// settled off over a transport that is still bound.
		await coordinator.perform({ type: "peer-bell", enabled: false });
		assert.notEqual(coordinator.read().listener.state, "off");

		// No further listener command or close is issued: the detached retirement's
		// own bounded settlement must decide it as sticky unconfirmed cleanup.
		const failed = await log.waitFor(
			(snapshot) => snapshot.listener.state === "error",
			"the sticky deadline outcome of the held detached retirement",
			15_000,
		);
		assert.match(failed.listener.message ?? "", /could not be confirmed stopped/);

		await disabling;
		assert.equal(coordinator.read().settings?.hostingEnabled, false);
		assert.equal((readPreferencesJson(fixture).hosting as { enabled: boolean }).enabled, false);
		const error = await coordinator.close().then(() => null, (cause: unknown) => cause);
		assert.equal(isPeerCoordinatorCloseError(error), true);
		await keepAlive;
	} finally {
		await listenerClose.restore();
	}
});

test("a pending listener retirement is a barrier for a concurrent Enable and is never published as off", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const listenerClose = controlledListenerClose();
	// Safety net: a regression that hangs a teardown must still release the owned
	// listener, so this fixture never leaks a socket into later tests.
	t.after(async () => {
		await listenerClose.restore();
	});
	try {
		const side = await startCoordinator(t, { agentDir: fixture.agentDir, testHooks: hooks() });
		await side.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
		const listening = side.coordinator.read().listener;
		assert.equal(listening.state, "listening");
		const port = listening.port as number;
		assert.equal(listenerClose.created, 1);

		// Hold the listener's own close callback: its retirement is owned but has no
		// decided outcome yet.
		listenerClose.hold();
		const disabling = side.coordinator.perform({ type: "peer-listener", enabled: false, host: "", port: "" });
		await listenerClose.closeHeld;

		// An unrelated redraw while cleanup is still pending must not publish a
		// settled off.
		await side.coordinator.perform({ type: "peer-bell", enabled: false });
		assert.equal(side.coordinator.read().listener.state, "listening", "pending cleanup is never displayed as off");
		assert.equal(side.coordinator.read().listener.port, port);

		// A concurrent Enable must wait for the owned retirement instead of binding
		// a second listener over a port the original transport may still hold.
		const mark = side.log.snapshots.length;
		const enabling = side.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
		// The held close now reports completion while the server is still listening.
		listenerClose.releaseAll();
		await Promise.all([disabling, enabling]);

		assert.equal(listenerClose.created, 1, "the concurrent Enable constructed no second listener");
		assert.equal(
			side.log.snapshots.slice(mark).some((snapshot) => (
				snapshot.listener.state === "starting" || snapshot.listener.state === "listening"
			)),
			false,
			"no bind was attempted while the listener cleanup was undecided",
		);
		const stopped = side.coordinator.read();
		assert.equal(stopped.listener.state, "error", "an unconfirmed stop never claims a settled off");
		assert.match(stopped.listener.message ?? "", /could not be confirmed stopped/);
		assert.equal(stopped.listener.port, port, "the port that may still be owned stays visible");
		assert.equal(stopped.settings?.hostingEnabled, true, "the attempted Enable is saved as desired intent only");
		const error = await side.coordinator.close().then(() => null, (cause: unknown) => cause);
		assert.equal(isPeerCoordinatorCloseError(error), true);
	} finally {
		await listenerClose.restore();
	}
});

test("a listener close callback that never arrives is bounded, keeps the off intent, and rejects close", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const listenerClose = controlledListenerClose();
	t.after(async () => {
		await listenerClose.restore();
	});
	// The deadline under test is the existing owned-settlement deadline. This
	// explicitly referenced witness keeps the event loop alive long enough for
	// that production timer to fire; it widens nothing.
	const keepAlive = delay(12_000);
	try {
		const side = await startCoordinator(t, { agentDir: fixture.agentDir, testHooks: hooks() });
		await side.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
		const port = side.coordinator.read().listener.port as number;

		listenerClose.hold();
		const startedAt = Date.now();
		const disabling = side.coordinator.perform({ type: "peer-listener", enabled: false, host: "", port: "" });
		await listenerClose.closeHeld;
		await disabling;
		const elapsed = Date.now() - startedAt;
		assert.ok(elapsed >= 9_000, `the owned settlement deadline bounded the wait (observed ${elapsed}ms)`);
		assert.ok(elapsed < 20_000, `the bounded wait stayed finite (observed ${elapsed}ms)`);

		// The desired off intent is persisted even though the release is unknown.
		const stopped = side.coordinator.read();
		assert.equal(stopped.listener.state, "error");
		assert.match(stopped.listener.message ?? "", /could not be confirmed stopped/);
		assert.equal(stopped.listener.port, port);
		assert.equal(stopped.settings?.hostingEnabled, false);
		assert.equal((readPreferencesJson(fixture).hosting as { enabled: boolean }).enabled, false);

		const closingAt = Date.now();
		const error = await side.coordinator.close().then(() => null, (cause: unknown) => cause);
		assert.equal(isPeerCoordinatorCloseError(error), true);
		assert.ok(Date.now() - closingAt < 9_000, "shutdown rejects from the sticky record instead of waiting again");
		await keepAlive;
	} finally {
		await listenerClose.restore();
	}
});

test("a failed listener bind retires its own transport and still settles cleanly", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const occupied = net.createServer();
	await new Promise<void>((resolve, reject) => {
		occupied.once("error", reject);
		occupied.listen(0, "127.0.0.1", () => {
			occupied.off("error", reject);
			resolve();
		});
	});
	t.after(async () => {
		await new Promise<void>((resolve) => occupied.close(() => resolve()));
	});
	const address = occupied.address();
	assert.ok(address && typeof address !== "string");

	const side = await startCoordinator(t, { agentDir: fixture.agentDir, testHooks: hooks() });
	await side.coordinator.perform({
		type: "peer-listener",
		enabled: true,
		host: "127.0.0.1",
		port: String(address.port),
	});
	const snapshot = side.coordinator.read();
	assert.equal(snapshot.listener.state, "error");
	assert.match(snapshot.listener.message ?? "", /could not bind/);

	// The failed start's own transport retirement is owned and confirmed, so
	// shutdown settles instead of reporting a sticky uncertainty.
	await side.coordinator.close();
	assert.equal(side.coordinator.read().listener.state, "off");
	assert.equal(side.coordinator.read().settings?.hostingEnabled, true);
});

test("a Disable applies hosting to the latest preferences, preserving concurrent changes", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const port = await reserveLoopbackPort(t);
	const side = await startCoordinator(t, { agentDir: fixture.agentDir, testHooks: hooks() });
	await side.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: String(port) });
	assert.equal(side.coordinator.read().listener.state, "listening");

	const disabling = side.coordinator.perform({ type: "peer-listener", enabled: false, host: "", port: "" });
	// Both land while the listener teardown is still in flight.
	await side.coordinator.perform({ type: "peer-add", label: "Concurrent host", host: "127.0.0.1", port: "40050" });
	await side.coordinator.perform({ type: "peer-bell", enabled: false });
	await disabling;

	const snapshot = side.coordinator.read();
	assert.equal(snapshot.listener.state, "off");
	assert.equal(snapshot.settings?.hostingEnabled, false);
	assert.equal(snapshot.settings?.bellEnabled, false);
	assert.equal(snapshot.hosts?.length, 1);
	assert.equal(snapshot.hosts?.[0]?.label, "Concurrent host");
	const raw = readPreferencesJson(fixture);
	assert.equal((raw.hosting as { enabled: boolean }).enabled, false);
	assert.equal(raw.bellEnabled, false);
	assert.equal((raw.destinations as unknown[]).length, 1);

	// The concurrent changes survive reconstruction, not just the live snapshot.
	await side.coordinator.close();
	const reopened = await startCoordinator(t, { agentDir: fixture.agentDir, testHooks: hooks() });
	assert.equal(reopened.coordinator.read().settings?.hostingEnabled, false);
	assert.equal(reopened.coordinator.read().settings?.bellEnabled, false);
	assert.equal(reopened.coordinator.read().hosts?.[0]?.label, "Concurrent host");
});

test("a Revoke whose save fails is still restrictive for this lifecycle", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const peerStatePolicy = createPosixTestPolicy();
	const b = await startCoordinator(t, {
		agentDir: bFixture.agentDir,
		testHooks: {
			preferencesPermissions: createPosixTestPolicy(),
			peerStatePermissions: peerStatePolicy,
		},
	});
	await b.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	const bPort = b.coordinator.read().listener.port as number;
	const a = await startCoordinator(t, { agentDir: aFixture.agentDir, testHooks: hooks() });
	const hostId = await addDestination(a, "B laptop", bPort);
	await connectWithApprovals(a, b, hostId);
	await waitConnected(a, "the initial connection");
	const peerId = b.coordinator.read().trustedPeers?.[0]?.id;
	assert.ok(peerId);

	// The grant deletion fails before its commit: the persisted fact remains.
	peerStatePolicy.fail = (call) => call.operation === "protectCreatedFile";
	await b.coordinator.perform({ type: "peer-revoke", peerId });
	assert.match(b.coordinator.read().notice ?? "", /could not be revoked/);
	assert.equal(b.coordinator.read().trustedPeers?.length, 1, "the unsaved fact is reported truthfully");
	assert.equal(b.coordinator.read().listener.state, "listening");

	// The current session loses metadata authorization...
	await a.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.roster.state === "stale",
		"the fenced projection after the failed Revoke",
	);
	// ...and a fresh connection from the same peer is admitted by the transport
	// but denied metadata by the lifecycle-local receiving denial.
	await a.coordinator.perform({ type: "peer-disconnect", hostId });
	const mark = a.log.snapshots.length;
	await a.coordinator.perform({ type: "peer-connect", hostId });
	await delay(150);
	assert.equal(
		a.log.snapshots.slice(mark).some((snapshot) => snapshot.hosts?.[0]?.roster.state === "current"),
		false,
		"a failed Revoke never leaves current remote metadata",
	);
	assert.equal(b.inventory.activeWatches, 0, "no metadata subscription was admitted");

	// Persisting the removal later is still possible and does not touch sessions.
	peerStatePolicy.fail = null;
	await b.coordinator.perform({ type: "peer-revoke", peerId });
	assert.deepEqual(b.coordinator.read().trustedPeers, []);
	await b.inventory.setRows([rowView("still-running")]);
	assertInventoryServes(b.inventory, 1);
});

test("a refused metadata handshake stays unknown, while a completed empty snapshot is current empty", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0);
	await b.inventory.setUnobservable(true);
	const bPort = b.coordinator.read().listener.port as number;
	const a = await startCoordinator(t, { agentDir: aFixture.agentDir, testHooks: hooks() });
	const hostId = await addDestination(a, "B laptop", bPort);
	await connectWithApprovals(a, b, hostId);

	const connected = await a.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.state === "connected",
		"the connected host whose metadata handshake was refused",
	);
	assert.equal(connected.hosts?.[0]?.roster.state, "never");
	assert.equal(connected.hosts?.[0]?.roster.rows, null, "an unobserved roster is never a last-observed []");

	// A genuinely empty authoritative inventory is a complete observation.
	await a.coordinator.perform({ type: "peer-disconnect", hostId });
	await b.inventory.setUnobservable(false);
	await b.inventory.setRows([]);
	await a.coordinator.perform({ type: "peer-connect", hostId });
	const empty = await waitConnected(a, "the completed empty roster");
	assert.equal(empty.hosts?.[0]?.roster.state, "current");
	assert.deepEqual(empty.hosts?.[0]?.roster.rows, []);
});

test("the local first-use decision survives the receiving server's own timeout window", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	// No window or transport overrides: this uses the coordinator's production
	// bounds. The receiving server's header/request timers are interval-checked,
	// so the decision is held past one full default checking interval too.
	const b = await bindHost(t, bFixture.agentDir, 0);
	const bPort = b.coordinator.read().listener.port as number;
	const a = await startCoordinator(t, { agentDir: aFixture.agentDir, testHooks: hooks() });
	const hostId = await addDestination(a, "B laptop", bPort);
	const connecting = a.coordinator.perform({ type: "peer-connect", hostId });
	const keySnapshot = await a.log.waitFor(
		(snapshot) => consentsOf(snapshot, "server-key").length > 0,
		"the local first-use consent",
	);
	const consent = consentsOf(keySnapshot, "server-key")[0];
	assert.ok(consent);

	await delay(32_000);
	const during = a.coordinator.read();
	assert.equal(during.hosts?.[0]?.state, "pairing");
	assert.equal(
		during.consents.some((candidate) => candidate.id === consent.id),
		true,
		"the accepted-but-silent connection outlives the transport defaults",
	);

	assert.equal(a.coordinator.decideConsent(consent.id, "approve"), true);
	const incomingSnapshot = await b.log.waitFor(
		(snapshot) => consentsOf(snapshot, "incoming").length === 1,
		"the receiving consent after the held local decision",
		15_000,
	);
	assert.equal(b.coordinator.decideConsent(consentsOf(incomingSnapshot, "incoming")[0]!.id, "approve"), true);
	await connecting;
	await waitConnected(a, "the connection whose local decision was held");
});

test("construction and read are inert and loading before start", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const log = createSnapshotLog();
	const coordinator = createPeerCoordinator({
		agentDir: fixture.agentDir,
		inventory: createFakeInventory(),
		onChange: log.onChange,
		onIncomingConsentArrival: log.onArrival,
	});
	t.after(async () => {
		await coordinator.close();
	});
	const snapshot = coordinator.read();
	assert.equal(snapshot.revision, 0);
	assert.equal(snapshot.status, "loading");
	assert.equal(snapshot.settings, null);
	assert.equal(snapshot.hosts, null);
	assert.equal(snapshot.trustedPeers, null);
	assert.equal(snapshot.identityFingerprint, null);
	assert.equal(snapshot.notice, null, "loading is not reported as a configuration failure");
	assert.deepEqual(snapshot.consents, []);
	assert.deepEqual(snapshot.listener, { state: "off", host: null, port: null, message: null });
	assert.equal(log.snapshots.length, 0, "construction emits nothing");
	assert.equal(existsSync(fixture.sessionHostDir), false, "construction and read touch no storage");

	await coordinator.start();
	assert.equal(coordinator.read().status, "ready");
	assert.equal(existsSync(fixture.sessionHostDir), false, "start only reads; nothing is configured yet");
});

test("close latches admission synchronously and resolves only after local settlement", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0);
	const bPort = b.coordinator.read().listener.port as number;
	const a = await startCoordinator(t, { agentDir: aFixture.agentDir, testHooks: hooks() });
	const hostId = await addDestination(a, "B laptop", bPort);
	await connectWithApprovals(a, b, hostId);
	await waitConnected(a, "the initial connection");
	const committed = a.log.snapshots.length;

	const closing = a.coordinator.close();
	// Admission is already closed for actions and for another start, and the
	// last committed snapshot is still the display state.
	assert.equal(a.coordinator.read().hosts?.[0]?.state, "connected");
	await a.coordinator.perform({ type: "peer-connect", hostId });
	await a.coordinator.start();
	assert.equal(a.log.snapshots.length, committed, "an inert action after close emits nothing");

	await closing;
	const final = a.coordinator.read();
	assert.equal(a.log.snapshots.length, committed + 1, "shutdown publishes one settled display state");
	assert.equal(Object.isFrozen(final), true);
	assert.equal(final.listener.state, "off");
	assert.equal(final.hosts?.[0]?.state, "disconnected");
	assert.equal(final.hosts?.[0]?.roster.state, "stale");
	assert.equal(a.coordinator.decideConsent("anything", "approve"), false);
	// Idempotent: a second close returns the same settled outcome.
	await a.coordinator.close();
	// The owner's listener and inventory are untouched by the peer's shutdown.
	assert.equal(b.coordinator.read().listener.state, "listening");
	assertInventoryServes(b.inventory, 0);
});

test("close during startup cancels the configured listener restore without binding", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const port = await reserveLoopbackPort(t);
	const first = await startCoordinator(t, { agentDir: fixture.agentDir, testHooks: hooks() });
	await first.coordinator.perform({
		type: "peer-listener",
		enabled: true,
		host: "127.0.0.1",
		port: String(port),
	});
	assert.equal(first.coordinator.read().listener.state, "listening");
	await first.coordinator.close();

	const log = createSnapshotLog();
	const second = createPeerCoordinator({
		agentDir: fixture.agentDir,
		inventory: createFakeInventory(),
		onChange: log.onChange,
		onIncomingConsentArrival: log.onArrival,
		testHooks: hooks(),
	});
	t.after(async () => {
		await second.close();
	});
	const starting = second.start();
	const closing = second.close();
	await Promise.all([starting, closing]);
	const snapshot = second.read();
	assert.equal(snapshot.listener.state, "off");
	assert.equal(snapshot.settings?.hostingEnabled, true, "saved intent is not rewritten by a startup close");
	await assertRefused(port);
});

test("the arrival callback observes committed consent state once per new handle", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const bLog = createSnapshotLog();
	const observed: Array<{ id: string; present: boolean; kind: string | null }> = [];
	let b!: PeerCoordinator;
	b = createPeerCoordinator({
		agentDir: bFixture.agentDir,
		inventory: createFakeInventory(),
		onChange: bLog.onChange,
		onIncomingConsentArrival: (consentId) => {
			const snapshot = b.read();
			const consent = snapshot.consents.find((candidate) => candidate.id === consentId);
			observed.push({ id: consentId, present: consent !== undefined, kind: consent?.kind ?? null });
		},
		testHooks: hooks(),
	});
	t.after(async () => {
		await b.close();
	});
	await b.start();
	await b.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	const bPort = b.read().listener.port as number;

	const a = await startCoordinator(t, { agentDir: aFixture.agentDir, testHooks: hooks() });
	const hostId = await addDestination(a, "B laptop", bPort);
	const connecting = a.coordinator.perform({ type: "peer-connect", hostId });
	const keySnapshot = await a.log.waitFor(
		(snapshot) => consentsOf(snapshot, "server-key").length > 0,
		"the local first-use consent",
	);
	assert.equal(a.coordinator.decideConsent(consentsOf(keySnapshot, "server-key")[0]!.id, "approve"), true);
	await bLog.waitFor(
		(snapshot) => consentsOf(snapshot, "incoming").length === 1,
		"the incoming consent",
	);
	assert.equal(observed.length, 1);
	assert.equal(observed[0]?.present, true, "state is committed before the arrival callback runs");
	assert.equal(observed[0]?.kind, "incoming");
	// A settings redraw / snapshot replay never repeats the arrival signal.
	await b.perform({ type: "peer-bell", enabled: false });
	assert.equal(observed.length, 1);
	assert.equal(b.decideConsent(observed[0]!.id, "approve"), true);
	await connecting;
	await waitConnected(a, "the connection after the observed arrival");
});

test("Disconnect then close waits for the owned channel's local closure, not an unsubscribe ack", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0);
	const bPort = b.coordinator.read().listener.port as number;
	const control = controlledChannel();
	const a = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		testHooks: hooks({ wrapClientChannel: control.hook }),
	});
	const hostId = await addDestination(a, "B laptop", bPort);
	await connectWithApprovals(a, b, hostId);
	await waitConnected(a, "the initial connection");

	// The owner's unsubscribe acknowledgement never arrives; the local channel
	// closure is still pending when close() is called.
	control.holdSends();
	await a.coordinator.perform({ type: "peer-disconnect", hostId });
	const closing = a.coordinator.close();
	const early = await Promise.race([
		closing.then(() => "settled" as const, () => "rejected" as const),
		delay(150).then(() => "pending" as const),
	]);
	assert.equal(early, "pending", "close must not report success while the local channel is still open");
	await control.closeStarted;
	await delay(10);
	assert.ok(control.heldSendCount > 0, "the unsubscribe write is still outstanding");

	control.resolveClose();
	await closing;
	assert.ok(control.heldSendCount > 0, "close never depended on the unsubscribe acknowledgement");
	assert.equal(b.coordinator.read().listener.state, "listening", "the owner is untouched");
});

test("Remove then close also waits for the owned channel's local closure", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0);
	const bPort = b.coordinator.read().listener.port as number;
	const control = controlledChannel();
	const a = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		testHooks: hooks({ wrapClientChannel: control.hook }),
	});
	const hostId = await addDestination(a, "B laptop", bPort);
	await connectWithApprovals(a, b, hostId);
	await waitConnected(a, "the initial connection");

	await a.coordinator.perform({ type: "peer-remove", hostId });
	assert.deepEqual(a.coordinator.read().hosts, []);
	const closing = a.coordinator.close();
	const early = await Promise.race([
		closing.then(() => "settled" as const, () => "rejected" as const),
		delay(150).then(() => "pending" as const),
	]);
	assert.equal(early, "pending", "Remove retirement is still owned and must be awaited");
	control.resolveClose();
	await closing;
	assert.equal(b.coordinator.read().listener.state, "listening", "Remove never stops the other host");
});

test("close rejects with the fixed shutdown error when owned cleanup fails", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0);
	const bPort = b.coordinator.read().listener.port as number;
	const control = controlledChannel();
	const a = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		testHooks: hooks({ wrapClientChannel: control.hook }),
	});
	const hostId = await addDestination(a, "B laptop", bPort);
	await connectWithApprovals(a, b, hostId);
	await waitConnected(a, "the initial connection");

	await a.coordinator.perform({ type: "peer-disconnect", hostId });
	// Observe the outcome immediately so the rejection is never unhandled.
	const outcome = a.coordinator.close().then(
		() => null,
		(error: unknown) => error,
	);
	await control.closeStarted;
	control.rejectClose();
	const error = await outcome;
	assert.equal(
		isPeerCoordinatorCloseError(error),
		true,
		"a failed cleanup must reject with the fixed shutdown error, never report success",
	);
});

test("failed preference writes are reported, keep pre-write protection, and stop restictive actions now", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const policy = createPosixTestPolicy();
	const side = await startCoordinator(t, {
		agentDir: fixture.agentDir,
		testHooks: { preferencesPermissions: policy, peerStatePermissions: createPosixTestPolicy() },
	});
	await side.coordinator.perform({ type: "peer-add", label: "B laptop", host: "127.0.0.1", port: "40000" });
	const protection = policy.calls.filter((call) => call.operation === "protectCreatedFile");
	assert.ok(protection.length > 0);
	assert.equal(protection[0]?.size, 0, "protection is established before any preference byte is written");

	policy.fail = (call) => call.operation === "protectCreatedFile";
	await side.coordinator.perform({ type: "peer-bell", enabled: false });
	assert.equal(side.coordinator.read().settings?.bellEnabled, true, "an unsaved setting is not reported saved");
	assert.match(side.coordinator.read().notice ?? "", /could not be saved/);
	assert.equal((readPreferencesJson(fixture).bellEnabled as boolean), true);

	policy.fail = null;
	await side.coordinator.perform({ type: "peer-bell", enabled: false });
	assert.equal(side.coordinator.read().settings?.bellEnabled, false);
	assert.equal((readPreferencesJson(fixture).bellEnabled as boolean), false);

	await side.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	assert.equal(side.coordinator.read().listener.state, "listening");

	// A restrictive stop takes effect now even when the new intent cannot be
	// persisted; the notice keeps it honestly unsaved.
	policy.fail = (call) => call.operation === "protectCreatedFile";
	await side.coordinator.perform({ type: "peer-listener", enabled: false, host: "", port: "" });
	assert.equal(side.coordinator.read().listener.state, "off");
	assert.equal(side.coordinator.read().settings?.hostingEnabled, false);
	assert.match(side.coordinator.read().notice ?? "", /could not be saved/);
	assert.equal((readPreferencesJson(fixture).hosting as { enabled: boolean }).enabled, true);
});

test("a first-save protection failure leaves no document and creates no trust", async (t) => {
	const fixture = createOwnedAgentDir(t);
	const policy = createPosixTestPolicy();
	policy.fail = (call) => call.operation === "protectCreatedFile";
	const side = await startCoordinator(t, {
		agentDir: fixture.agentDir,
		testHooks: { preferencesPermissions: policy, peerStatePermissions: createPosixTestPolicy() },
	});
	await side.coordinator.perform({ type: "peer-bell", enabled: false });
	assert.equal(side.coordinator.read().settings?.bellEnabled, true);
	assert.match(side.coordinator.read().notice ?? "", /could not be saved/);
	assert.equal(existsSync(fixture.preferencesPath), false);
	assert.deepEqual(readdirSync(fixture.preferencesDir), [], "no unverified partial document or temporary is left");
	assert.equal(existsSync(fixture.peersDir), false);
});

test("a held human approval is not cut by the receiving server's request timeout", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	// The controlled short window proves the receiving request timeout bounds the
	// request body only; it must not decide a human approval.
	const b = await bindHost(t, bFixture.agentDir, 0, {
		consentWindowMs: 800,
		hostBounds: { requestTimeoutMs: 120, httpHeadersTimeoutMs: 120 },
	});
	const bPort = b.coordinator.read().listener.port as number;
	const a = await startCoordinator(t, {
		agentDir: aFixture.agentDir,
		testHooks: hooks({ consentWindowMs: 800 }),
	});
	const hostId = await addDestination(a, "B laptop", bPort);
	const connecting = a.coordinator.perform({ type: "peer-connect", hostId });
	const keySnapshot = await a.log.waitFor(
		(snapshot) => consentsOf(snapshot, "server-key").length > 0,
		"the local first-use consent",
	);
	assert.equal(a.coordinator.decideConsent(consentsOf(keySnapshot, "server-key")[0]!.id, "approve"), true);
	const incomingSnapshot = await b.log.waitFor(
		(snapshot) => consentsOf(snapshot, "incoming").length === 1,
		"the held receiving consent",
	);
	const incoming = consentsOf(incomingSnapshot, "incoming")[0];
	assert.ok(incoming);
	await delay(320);
	assert.equal(b.coordinator.decideConsent(incoming.id, "approve"), true);
	await connecting;
	await waitConnected(a, "the connection approved after the request timeout elapsed");
});

test("multiple destinations stay independent with current and last-observed rosters", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const cFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0);
	const c = await bindHost(t, cFixture.agentDir, 0);
	await b.inventory.setRows([rowView("b-one")]);
	await c.inventory.setRows([rowView("c-one"), rowView("c-two")]);
	const bPort = b.coordinator.read().listener.port as number;
	const cPort = c.coordinator.read().listener.port as number;

	const a = await startCoordinator(t, { agentDir: aFixture.agentDir, testHooks: hooks() });
	const bHostId = await addDestination(a, "B laptop", bPort);
	await connectWithApprovals(a, b, bHostId);
	await waitConnected(a, "the first destination");
	const cHostId = await addDestination(a, "C server", cPort);
	await connectWithApprovals(a, c, cHostId);
	await a.log.waitFor(
		(snapshot) => snapshot.hosts?.length === 2
			&& snapshot.hosts.every((host) => host.state === "connected" && host.roster.state === "current"),
		"both destinations connected with current rosters",
	);
	const hosts = a.coordinator.read().hosts;
	assert.ok(hosts);
	const byLabel = new Map(hosts.map((host) => [host.label, host]));
	assert.deepEqual(byLabel.get("B laptop")?.roster.rows?.map((row) => row.id), ["b-one"]);
	assert.deepEqual(byLabel.get("C server")?.roster.rows?.map((row) => row.id), ["c-one", "c-two"]);
	assert.equal(a.inventory.activeWatches, 0, "the local inventory is never used as a proxy roster");

	// Stopping one owner makes only that destination's rows last-observed.
	await c.coordinator.perform({ type: "peer-listener", enabled: false, host: "", port: "" });
	const stale = await a.log.waitFor(
		(snapshot) => snapshot.hosts?.find((host) => host.label === "C server")?.roster.state === "stale",
		"the stopped destination's stale roster",
	);
	assert.deepEqual(
		stale.hosts?.find((host) => host.label === "C server")?.roster.rows?.map((row) => row.id),
		["c-one", "c-two"],
	);
	assert.equal(stale.hosts?.find((host) => host.label === "B laptop")?.roster.state, "current");

	// Hosting and outgoing clients are independent roles.
	await a.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	assert.equal(a.coordinator.read().listener.state, "listening");
	await a.coordinator.perform({ type: "peer-listener", enabled: false, host: "", port: "" });
	assert.equal(a.coordinator.read().listener.state, "off");
	assert.equal(
		a.coordinator.read().hosts?.find((host) => host.label === "B laptop")?.state,
		"connected",
		"stopping local hosting never closes an outgoing client",
	);
});

test("muting the arrival bell keeps the prominent pending alert and its single arrival signal", async (t) => {
	const aFixture = createOwnedAgentDir(t);
	const bFixture = createOwnedAgentDir(t);
	const b = await bindHost(t, bFixture.agentDir, 0);
	const bPort = b.coordinator.read().listener.port as number;
	await b.coordinator.perform({ type: "peer-bell", enabled: false });
	assert.equal(b.coordinator.read().settings?.bellEnabled, false);

	const a = await startCoordinator(t, { agentDir: aFixture.agentDir, testHooks: hooks() });
	const hostId = await addDestination(a, "B laptop", bPort);
	const connecting = a.coordinator.perform({ type: "peer-connect", hostId });
	const keySnapshot = await a.log.waitFor(
		(snapshot) => consentsOf(snapshot, "server-key").length > 0,
		"the local first-use consent",
	);
	assert.equal(a.coordinator.decideConsent(consentsOf(keySnapshot, "server-key")[0]!.id, "approve"), true);
	const pending = await b.log.waitFor(
		(snapshot) => consentsOf(snapshot, "incoming").length === 1,
		"the pending incoming alert while muted",
	);
	assert.equal(b.coordinator.read().settings?.bellEnabled, false);
	assert.equal(b.log.arrivals.length, 1);
	assert.equal(consentsOf(pending, "incoming")[0]?.id, b.log.arrivals[0]);
	// Redraws and snapshot replays never repeat the arrival signal.
	const before = b.log.snapshots.length;
	await b.coordinator.perform({ type: "peer-bell", enabled: false });
	assert.ok(b.log.snapshots.length > before);
	assert.equal(b.log.arrivals.length, 1);
	assert.equal(b.coordinator.decideConsent(b.log.arrivals[0]!, "approve"), true);
	await connecting;
	await waitConnected(a, "the muted-but-approved connection");
});

// --- owner-routed Close over the existing roster channel ---------------------

/** The owner run the requester's last complete roster observation named. */
function observedRun(side: StartedCoordinator): string {
	const host = side.coordinator.read().hosts?.[0];
	const hostRunId = host?.roster.hostRunId;
	assert.ok(hostRunId, "the destination has a complete current roster observation");
	return hostRunId;
}

/**
 * A live owner destination plus a connected requester: the requester holds one
 * authoritative observation of the owner's run and rows, and the owner's close
 * provider is the only thing that can act on it. No content is ever selected.
 */
async function closePair(
	t: TestContext,
	options: { readonly closeOwnedSession?: PeerCoordinatorOptions["closeOwnedSession"] } = {},
): Promise<{
	host: StartedCoordinator;
	requester: StartedCoordinator;
	hostId: string;
}> {
	const hostFixture = createOwnedAgentDir(t);
	const requesterFixture = createOwnedAgentDir(t);
	const host = await startCoordinator(t, {
		agentDir: hostFixture.agentDir,
		inventory: createFakeInventory([rowView("row-1"), rowView("row-2")]),
		testHooks: hooks(),
		...(options.closeOwnedSession === undefined ? {} : { closeOwnedSession: options.closeOwnedSession }),
	});
	await host.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	const port = host.coordinator.read().listener.port as number;
	const requester = await startCoordinator(t, {
		agentDir: requesterFixture.agentDir,
		inventory: createFakeInventory(),
		testHooks: hooks(),
	});
	const hostId = await addDestination(requester, "Owner host", port);
	await connectWithApprovals(requester, host, hostId);
	await waitConnected(requester, "the owner roster observation");
	return { host, requester, hostId };
}

test("a close reaches the shared owner provider for the exact current run and row without a content selection", async (t) => {
	const calls: OwnerCloseRequest[] = [];
	const pair = await closePair(t, {
		closeOwnedSession: async (request) => {
			calls.push(request);
			return { kind: "removed" };
		},
	});
	const hostRunId = observedRun(pair.requester);
	// Nothing is selected and no content endpoint exists: a close never needs a
	// displayed row, a native tuple, a viewer, or a controller lease.
	assert.equal(pair.requester.coordinator.content.readContent().state, "none");
	const result = await pair.requester.coordinator.ownerClose.closeSession({
		hostId: pair.hostId,
		hostRunId,
		rowId: "row-2",
		confirmed: false,
	});
	assert.deepEqual(result, { kind: "owner-result", facts: { kind: "removed" } });
	assert.deepEqual(calls, [{ hostRunId, rowId: "row-2", confirmed: false }],
		"the exact owner run, row, and confirmation reach the shared provider");
	// The reply is never an optimistic removal: only the owner's own roster does that.
	assert.equal(pair.requester.coordinator.read().hosts?.[0]?.roster.rows?.length, 2);
	await pair.host.inventory.setRows([rowView("row-1")]);
	await pair.requester.log.waitFor(
		(snapshot) => snapshot.hosts?.[0]?.roster.rows?.length === 1,
		"the owner's own removal reaches the projection",
	);
	assert.equal(pair.requester.coordinator.content.readContent().target, null,
		"no selection is ever created by a close");
});

test("an owner without a provider refuses with a fixed not-sent capability result", async (t) => {
	const pair = await closePair(t);
	const hostRunId = observedRun(pair.requester);
	assert.deepEqual(await pair.requester.coordinator.ownerClose.closeSession({
		hostId: pair.hostId,
		hostRunId,
		rowId: "row-1",
		confirmed: true,
	}), { kind: "not-sent", reason: "capability-unsupported" });
});

test("a close names one exact run and row and refuses to retarget anything else", async (t) => {
	const calls: OwnerCloseRequest[] = [];
	const pair = await closePair(t, {
		closeOwnedSession: async (request) => {
			calls.push(request);
			return { kind: "refused" };
		},
	});
	const hostRunId = observedRun(pair.requester);
	const target = pair.requester.coordinator.ownerClose;
	assert.deepEqual(await target.closeSession({ hostId: "not-a-host", hostRunId, rowId: "row-1", confirmed: false }),
		{ kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await target.closeSession({ hostId: pair.hostId, hostRunId: "other-run", rowId: "row-1", confirmed: false }),
		{ kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await target.closeSession({ hostId: pair.hostId, hostRunId, rowId: "row-9", confirmed: false }),
		{ kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(await target.closeSession({ hostId: pair.hostId, hostRunId, rowId: "row-1", confirmed: "yes" as never }),
		{ kind: "not-sent", reason: "invalid-request" });
	assert.deepEqual(calls, [], "no unusable request is ever forwarded or retargeted");
});

test("a disconnected destination cannot be addressed by a close", async (t) => {
	const calls: OwnerCloseRequest[] = [];
	const pair = await closePair(t, {
		closeOwnedSession: async (request) => {
			calls.push(request);
			return { kind: "removed" };
		},
	});
	const hostRunId = observedRun(pair.requester);
	await pair.requester.coordinator.perform({ type: "peer-disconnect", hostId: pair.hostId });
	assert.equal(pair.requester.coordinator.read().hosts?.[0]?.state, "disconnected");
	assert.deepEqual(await pair.requester.coordinator.ownerClose.closeSession({
		hostId: pair.hostId,
		hostRunId,
		rowId: "row-1",
		confirmed: false,
	}), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(calls, [], "a disconnected destination is never addressed");
});

test("this side's own receiving Revoke never blocks an outbound close", async (t) => {
	const calls: OwnerCloseRequest[] = [];
	const pair = await closePair(t, {
		closeOwnedSession: async (request) => {
			calls.push(request);
			return { kind: "stopped-retained" };
		},
	});
	const hostRunId = observedRun(pair.requester);
	// This test needs the OTHER direction of trust: the requester must hold a real
	// receiving permission for the owner's key. The ordinary pair above only gave
	// the owner a receiving grant for the requester, so admit a second, reverse
	// connection with the existing public pairing fixtures: the requester listens,
	// the owner connects to it and is approved. The original outbound
	// requester -> owner connection, its pin, and the owner's grant stay untouched.
	await pair.requester.coordinator.perform({
		type: "peer-listener",
		enabled: true,
		host: "127.0.0.1",
		port: "0",
	});
	const requesterPort = pair.requester.coordinator.read().listener.port;
	assert.ok(requesterPort !== null);
	assert.ok(requesterPort > 0, "the requester's listener reported its bound port");
	const reverseHostId = await addDestination(pair.host, "Requester host", requesterPort);
	await connectWithApprovals(pair.host, pair.requester, reverseHostId);
	const received = await pair.requester.log.waitFor(
		(snapshot) => {
			const peers = snapshot.trustedPeers;
			return peers !== null && peers.length === 1 && peers[0]?.hasInboundGrant === true;
		},
		"the requester's own real receiving grant for the owner",
	);
	const trusted = received.trustedPeers;
	assert.ok(trusted !== null);
	assert.equal(trusted.length, 1);
	const peerId = trusted[0]?.id;
	assert.ok(peerId !== undefined);
	const outboundBefore = pair.requester.coordinator.read().hosts?.[0];
	assert.ok(outboundBefore);
	assert.equal(outboundBefore.state, "connected");
	const outboundPin = outboundBefore.fingerprint;
	assert.ok(outboundPin, "the original outbound destination stays pinned");
	// Now the requester revokes that RECEIVING permission. It covers the reverse
	// inbound direction only and must not gate the legitimate outbound request; the
	// owner's own receiving grant for this viewer is what authorizes the close.
	await pair.requester.coordinator.perform({ type: "peer-revoke", peerId });
	assert.deepEqual(pair.requester.coordinator.read().trustedPeers, []);
	const outboundAfter = pair.requester.coordinator.read().hosts?.[0];
	assert.ok(outboundAfter);
	assert.equal(outboundAfter.state, "connected", "the revoke never tears down the outbound transport");
	assert.equal(outboundAfter.roster.state, "current", "the owner's own observations keep flowing");
	assert.equal(outboundAfter.roster.rows?.length, 2, "the exact current owner roster survives the revoke");
	assert.equal(outboundAfter.fingerprint, outboundPin, "the outbound pin is unchanged by the revoke");
	assert.deepEqual(await pair.requester.coordinator.ownerClose.closeSession({
		hostId: pair.hostId,
		hostRunId,
		rowId: "row-1",
		confirmed: true,
	}), { kind: "owner-result", facts: { kind: "stopped-retained" } });
	assert.deepEqual(calls, [{ hostRunId, rowId: "row-1", confirmed: true }]);
});

test("a removed destination cannot be addressed and its cleared pin is never reused", async (t) => {
	const calls: OwnerCloseRequest[] = [];
	const pair = await closePair(t, {
		closeOwnedSession: async (request) => {
			calls.push(request);
			return { kind: "removed" };
		},
	});
	const hostRunId = observedRun(pair.requester);
	// Remove clears this side's remembered key and retires the destination runtime.
	await pair.requester.coordinator.perform({ type: "peer-remove", hostId: pair.hostId });
	assert.equal(pair.requester.coordinator.read().hosts?.length, 0);
	assert.deepEqual(await pair.requester.coordinator.ownerClose.closeSession({
		hostId: pair.hostId,
		hostRunId,
		rowId: "row-1",
		confirmed: false,
	}), { kind: "not-sent", reason: "target-unavailable" });
	assert.deepEqual(calls, [], "a removed destination is refused before submission");
});

test("a coordinator that is closing never submits a close", async (t) => {
	const calls: OwnerCloseRequest[] = [];
	const pair = await closePair(t, {
		closeOwnedSession: async (request) => {
			calls.push(request);
			return { kind: "removed" };
		},
	});
	const hostRunId = observedRun(pair.requester);
	await pair.requester.coordinator.close();
	assert.deepEqual(await pair.requester.coordinator.ownerClose.closeSession({
		hostId: pair.hostId,
		hostRunId,
		rowId: "row-1",
		confirmed: false,
	}), { kind: "not-sent", reason: "not-ready" });
	assert.deepEqual(calls, []);
});
