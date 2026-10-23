/**
 * Focused lifecycle coverage for the truthful pairing deadline and settlement
 * metadata handed to the receiving approval callback (issue #475, host-owned
 * pairing UI seam).
 *
 * Every fixture is synthetic and in-memory on an owned loopback port. The tests
 * observe only what the existing decision path really did: the displayed
 * deadline, and the exactly-once settlement produced by approval, denial,
 * expiry, client loss, host close, and injected-store failure. No storage, UI,
 * listener default, or approval authority is involved.
 */

import assert from "node:assert/strict";
import test from "node:test";
import tls from "node:tls";
import {
	createInMemoryDirectionalGrantStore,
	isPeerTransportError,
	type DirectionalGrantStore,
	type PeerPairingRequest,
	type PeerPairingSettlement,
} from "../src/session-host/network/index";
import {
	deferred,
	newIdentity,
	pairRequestText,
	startClient,
	startHost,
	withTimeout,
} from "./session-host-network-helpers";

interface Sink<T> {
	readonly handler: (value: T) => void;
	next(): Promise<T>;
	readonly seen: T[];
}

function createSink<T>(): Sink<T> {
	const queue: T[] = [];
	const waiters: Array<(value: T) => void> = [];
	const seen: T[] = [];
	return {
		seen,
		handler(value) {
			seen.push(value);
			const waiter = waiters.shift();
			if (waiter) waiter(value);
			else queue.push(value);
		},
		next() {
			const queued = queue.shift();
			if (queued !== undefined) return Promise.resolve(queued);
			return new Promise<T>((resolve) => waiters.push(resolve));
		},
	};
}

/** Observes the settlement a request reports, recording every delivery. */
interface SettlementWatch {
	readonly promise: Promise<PeerPairingSettlement>;
	readonly seen: PeerPairingSettlement[];
}

function watchSettlement(request: PeerPairingRequest): SettlementWatch {
	const seen: PeerPairingSettlement[] = [];
	const promise = request.settled.then((settlement) => {
		seen.push(settlement);
		return settlement;
	});
	return { promise, seen };
}

/** Yield one event-loop turn for queued follow-up work; not an elapsed-time witness. */
async function tick(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A pair promise that must never be left unobserved when its transport dies. */
function trackPairOutcome(promise: Promise<{ ok: boolean }>): Promise<boolean> {
	return promise.then(
		(result) => result.ok,
		() => false,
	);
}

test("a pairing request reports its configured deadline and settles accepted once after the local commit", async (t) => {
	const consentTimeoutMs = 5000;
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { consentTimeoutMs },
		onPairingRequest: pairingSink.handler,
	});
	const { client } = startClient(t, clientIdentity);

	const requestedBefore = Date.now();
	const pairPromise = client.pair({ port, approveServerKey: () => "accept" });
	const request = await pairingSink.next();
	const settlement = watchSettlement(request);

	assert.equal(request.label, "A-phone");
	assert.ok(Number.isSafeInteger(request.requestedAt));
	assert.ok(request.requestedAt >= requestedBefore && request.requestedAt <= Date.now());
	assert.ok(Number.isSafeInteger(request.expiresAt));
	assert.equal(request.expiresAt - request.requestedAt, consentTimeoutMs, "deadline comes from the configured timeout");
	assert.ok(Object.isFrozen(request));
	assert.equal(request.isPending(), true);
	assert.equal(host.pendingPairingCount, 1);
	assert.equal(settlement.seen.length, 0, "nothing settles before the receiving decision");

	assert.equal(request.approve(), true);
	const paired = await pairPromise;
	assert.equal(paired.ok, true);

	const first = await withTimeout(settlement.promise, 2000, "approval did not settle the consent");
	assert.equal(first.outcome, "accepted");
	assert.ok(first.settledAt >= request.requestedAt && first.settledAt <= Date.now());
	assert.deepEqual(Object.keys(first).sort(), ["outcome", "settledAt"], "fixed settlement shape only");
	assert.ok(!JSON.stringify(first).includes(clientIdentity.key.keyId), "no key material in the settlement");
	assert.equal(Object.isFrozen(first), true);
	assert.ok(acceptedPeers.get(clientIdentity.key.keyId));
	assert.ok(grants.get(clientIdentity.key.keyId));
	assert.equal(host.stats.pairingAccepted, 1);
	assert.equal(host.stats.pairingFailed, 0);

	// Duplicate and late decisions cannot change what was already observed.
	assert.equal(request.isPending(), false);
	assert.equal(request.approve(), false);
	assert.equal(request.deny(), false);
	assert.equal(host.pendingPairingCount, 0);
	await tick();
	assert.equal(settlement.seen.length, 1, "the settlement is delivered once");
	assert.equal(await request.settled, first, "the same fixed result is the only result");
});

test("a denial settles denied, commits nothing, and cannot be rewritten by a later approval", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { consentTimeoutMs: 5000 },
		onPairingRequest: pairingSink.handler,
	});
	const { client } = startClient(t, clientIdentity);

	const pairPromise = client.pair({ port, approveServerKey: () => "accept" });
	const request = await pairingSink.next();
	const settlement = watchSettlement(request);

	assert.equal(request.deny(), true);
	const result = await pairPromise;
	assert.equal(result.ok, false);
	assert.equal(result.status, "denied");
	assert.equal(result.httpStatus, 403);

	const first = await withTimeout(settlement.promise, 2000, "denial did not settle the consent");
	assert.equal(first.outcome, "denied");
	assert.equal(request.approve(), false, "a settled denial is not reopenable");
	assert.equal(acceptedPeers.get(clientIdentity.key.keyId), undefined);
	assert.equal(grants.get(clientIdentity.key.keyId), undefined);
	assert.equal(host.stats.pairingDenied, 1);
	assert.equal(host.pendingPairingCount, 0);
	await tick();
	assert.equal(settlement.seen.length, 1);
	assert.equal(await request.settled, first);
});

test("consent expiry settles timeout and a late approval cannot commit anything", async (t) => {
	const consentTimeoutMs = 60;
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { consentTimeoutMs },
		onPairingRequest: pairingSink.handler,
	});
	const { client, remembered } = startClient(t, clientIdentity);

	const pairPromise = client.pair({ port, approveServerKey: () => "accept" });
	const request = await pairingSink.next();
	const settlement = watchSettlement(request);
	assert.equal(request.expiresAt - request.requestedAt, consentTimeoutMs);

	const result = await withTimeout(pairPromise, 2000, "the client never received the timeout reply");
	assert.equal(result.ok, false);
	assert.equal(result.status, "timeout");
	assert.equal(result.httpStatus, 408);

	const first = await withTimeout(settlement.promise, 2000, "expiry did not settle the consent");
	assert.equal(first.outcome, "timeout");
	// No wall-clock relationship between `settledAt` and `expiresAt` is asserted:
	// the displayed deadline is display-only metadata, and `Date.now()` can move in
	// ways a timer does not follow. The real timer's authority is covered by the
	// 408 reply above and the refused late approval below.
	assert.equal(request.isPending(), false);
	assert.equal(request.approve(), false, "a late approval after expiry is refused");
	assert.equal(acceptedPeers.get(clientIdentity.key.keyId), undefined);
	assert.equal(grants.get(clientIdentity.key.keyId), undefined);
	assert.equal(remembered.read(), null);
	assert.equal(host.stats.pairingTimeouts, 1);
	assert.equal(host.pendingPairingCount, 0);
	await tick();
	assert.equal(settlement.seen.length, 1);
	assert.equal(await request.settled, first);
});

test("a client abort settles aborted with no grant and no application channel", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	let appChannels = 0;
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { consentTimeoutMs: 5000 },
		onPairingRequest: pairingSink.handler,
		onAppChannel: () => {
			appChannels++;
		},
	});
	const { client, remembered } = startClient(t, clientIdentity);

	const controller = new AbortController();
	const pairPromise = client.pair({
		port,
		approveServerKey: () => "accept",
		signal: controller.signal,
	});
	const request = await pairingSink.next();
	const settlement = watchSettlement(request);
	assert.equal(request.isPending(), true);

	controller.abort();
	await assert.rejects(
		pairPromise,
		(error: unknown) => isPeerTransportError(error) && error.code === "ABORTED",
	);

	const first = await withTimeout(settlement.promise, 2000, "the abort did not settle the consent");
	assert.equal(first.outcome, "aborted");
	assert.equal(request.isPending(), false);
	assert.equal(request.approve(), false, "an aborted consent cannot be approved afterwards");
	assert.equal(acceptedPeers.get(clientIdentity.key.keyId), undefined);
	assert.equal(grants.get(clientIdentity.key.keyId), undefined);
	assert.equal(remembered.read(), null);
	assert.equal(appChannels, 0);
	assert.equal(host.activeChannelCount, 0);
	assert.equal(host.pendingPairingCount, 0);
	await tick();
	assert.equal(settlement.seen.length, 1);
});

test("closing the host with a pending consent settles aborted and leaves no approval authority", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { consentTimeoutMs: 5000 },
		onPairingRequest: pairingSink.handler,
	});
	const { client } = startClient(t, clientIdentity);

	const pairPromise = trackPairOutcome(client.pair({ port, approveServerKey: () => "accept" }));
	const request = await pairingSink.next();
	const settlement = watchSettlement(request);

	await host.close();

	const first = await withTimeout(settlement.promise, 2000, "host close did not settle the pending consent");
	assert.equal(first.outcome, "aborted");
	assert.equal(request.isPending(), false);
	assert.equal(request.approve(), false);
	assert.equal(acceptedPeers.get(clientIdentity.key.keyId), undefined);
	assert.equal(grants.get(clientIdentity.key.keyId), undefined);
	assert.equal(host.pendingPairingCount, 0);
	assert.equal(
		await withTimeout(pairPromise, 2000, "the client pairing never finished after close"),
		false,
		"a closed host never reports a successful pair",
	);
	await tick();
	assert.equal(settlement.seen.length, 1);
});

test("approval in the destroyed-before-close interval settles aborted, never accepted", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const testConnection = deferred<{ destroy(): void }>();
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { consentTimeoutMs: 5000 },
		onPairingRequest: pairingSink.handler,
		testHooks: {
			onPairingConnection: (connection) => testConnection.resolve(connection),
		},
	});
	const { client } = startClient(t, clientIdentity);

	const pairPromise = trackPairOutcome(client.pair({ port, approveServerKey: () => "accept" }));
	const request = await pairingSink.next();
	const settlement = watchSettlement(request);
	const connection = await withTimeout(testConnection.promise, 2000, "test fixture did not observe the connection");

	// Destroy the live socket synchronously: its close handlers have not run yet,
	// so this is the interval in which a settlement handle must not bypass the
	// live-connection guard.
	connection.destroy();
	assert.equal(request.isPending(), true);
	assert.equal(request.approve(), false, "approval after synchronous destruction is refused");

	const first = await withTimeout(settlement.promise, 2000, "the destroyed connection did not settle the consent");
	assert.equal(first.outcome, "aborted");
	assert.equal(acceptedPeers.get(clientIdentity.key.keyId), undefined);
	assert.equal(grants.get(clientIdentity.key.keyId), undefined);
	assert.equal(host.pendingPairingCount, 0);
	assert.equal(await pairPromise, false);
	await tick();
	assert.equal(settlement.seen.length, 1);
});

test("a client that disappears before a late approval settles aborted without grants", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	let appChannels = 0;
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { consentTimeoutMs: 5000 },
		onPairingRequest: pairingSink.handler,
		onAppChannel: () => {
			appChannels++;
		},
	});

	const socket = tls.connect({
		host: "127.0.0.1",
		port,
		cert: clientIdentity.certificatePem,
		key: clientIdentity.privateKeyPem,
		rejectUnauthorized: false,
	});
	socket.on("error", () => {
		// The socket is destroyed deliberately below.
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("secureConnect", resolve);
		socket.once("error", reject);
	});
	socket.write(pairRequestText({ label: "A-phone", claimKey: clientIdentity.key }));
	const request = await pairingSink.next();
	const settlement = watchSettlement(request);
	assert.equal(host.pendingPairingCount, 1);

	socket.destroy();
	const first = await withTimeout(settlement.promise, 2000, "the closed socket did not settle the consent");
	assert.equal(first.outcome, "aborted");
	assert.equal(request.isPending(), false);
	assert.equal(request.approve(), false, "the settlement field grants no late approval authority");
	assert.equal(acceptedPeers.get(clientIdentity.key.keyId), undefined);
	assert.equal(grants.get(clientIdentity.key.keyId), undefined);
	assert.equal(appChannels, 0);
	assert.equal(host.pendingPairingCount, 0);
	await tick();
	assert.equal(settlement.seen.length, 1);
});

test("a directional-grant commit failure settles failed and is never reported as accepted", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const rememberedGrants = createInMemoryDirectionalGrantStore();
	const failingGrants: DirectionalGrantStore = {
		get: (keyId) => rememberedGrants.get(keyId),
		set: () => {
			throw new Error("fixture grant store failure");
		},
		delete: (keyId) => rememberedGrants.delete(keyId),
	};
	const pairingSink = createSink<PeerPairingRequest>();
	const { host, acceptedPeers, port } = await startHost(t, {
		identity: hostIdentity,
		grants: failingGrants,
		bounds: { consentTimeoutMs: 5000 },
		onPairingRequest: pairingSink.handler,
	});
	const { client } = startClient(t, clientIdentity);

	const pairPromise = client.pair({ port, approveServerKey: () => "accept" });
	const request = await pairingSink.next();
	const settlement = watchSettlement(request);

	assert.equal(request.approve(), false, "a commit failure is not an approval");
	const result = await pairPromise;
	assert.equal(result.ok, false);
	assert.equal(result.httpStatus, 500);
	assert.equal(result.wireError, "pairing_failed");

	const first = await withTimeout(settlement.promise, 2000, "the commit failure did not settle the consent");
	assert.equal(first.outcome, "failed");
	assert.equal(
		acceptedPeers.get(clientIdentity.key.keyId),
		undefined,
		"the accepted record is rolled back when the grant commit fails",
	);
	assert.equal(rememberedGrants.get(clientIdentity.key.keyId), undefined);
	assert.equal(host.stats.pairingAccepted, 0);
	assert.equal(host.stats.pairingFailed, 1);
	assert.equal(request.isPending(), false);
	assert.equal(request.approve(), false);
	assert.equal(host.pendingPairingCount, 0);
	await tick();
	assert.equal(settlement.seen.length, 1);
});

test("an accepted-identity commit failure settles failed and writes no grant", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const grants = createInMemoryDirectionalGrantStore();
	const failingAccepted = {
		get: () => undefined,
		set: () => {
			throw new Error("fixture accepted store failure");
		},
		delete: () => false,
	};
	const { host, port } = await startHost(t, {
		identity: hostIdentity,
		acceptedPeers: failingAccepted,
		grants,
		bounds: { consentTimeoutMs: 5000 },
		onPairingRequest: pairingSink.handler,
	});
	const { client } = startClient(t, clientIdentity);

	const pairPromise = client.pair({ port, approveServerKey: () => "accept" });
	const request = await pairingSink.next();
	const settlement = watchSettlement(request);

	assert.equal(request.approve(), false);
	const result = await pairPromise;
	assert.equal(result.ok, false);
	assert.equal(result.httpStatus, 500);

	const first = await withTimeout(settlement.promise, 2000, "the commit failure did not settle the consent");
	assert.equal(first.outcome, "failed");
	assert.equal(grants.get(clientIdentity.key.keyId), undefined, "no grant without an accepted identity");
	assert.equal(host.stats.pairingAccepted, 0);
	assert.equal(host.stats.pairingFailed, 1);
	await tick();
	assert.equal(settlement.seen.length, 1);
});

test("the displayed deadline is display-only: an approval before it stays accepted past it", async (t) => {
	const consentTimeoutMs = 40;
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { consentTimeoutMs },
		onPairingRequest: pairingSink.handler,
	});
	const { client } = startClient(t, clientIdentity);

	const pairPromise = client.pair({ port, approveServerKey: () => "accept" });
	const request = await pairingSink.next();
	const settlement = watchSettlement(request);
	assert.equal(request.expiresAt - request.requestedAt, consentTimeoutMs);

	assert.equal(request.approve(), true);
	assert.equal((await pairPromise).ok, true);
	const first = await withTimeout(settlement.promise, 2000, "approval did not settle the consent");
	assert.equal(first.outcome, "accepted");

	// Pass the displayed deadline and the original timer window entirely.
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, consentTimeoutMs * 3);
		timer.unref?.();
	});

	assert.equal(settlement.seen.length, 1, "a cleared consent timer cannot settle twice");
	assert.equal(await request.settled, first, "the displayed deadline cannot retroactively expire a commit");
	assert.equal((await request.settled).outcome, "accepted");
	assert.ok(acceptedPeers.get(clientIdentity.key.keyId));
	assert.ok(grants.get(clientIdentity.key.keyId));
	assert.equal(host.stats.pairingTimeouts, 0);
	assert.equal(host.pendingPairingCount, 0, "no consent state survives the settlement");
});
