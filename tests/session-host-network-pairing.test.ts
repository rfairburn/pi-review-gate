import assert from "node:assert/strict";
import tls from "node:tls";
import test from "node:test";
import {
	createInMemoryAcceptedPeerStore,
	createInMemoryDirectionalGrantStore,
	createInMemoryRememberedPeerKeyStore,
	isPeerTransportError,
	peerKeysEqual,
	type PeerAppChannel,
	type PeerDiagnostic,
	type PeerPairingRequest,
} from "../src/session-host/network/index";
import {
	deferred,
	newIdentity,
	pairRequestText,
	rawTlsExchange,
	startClient,
	startHost,
	upgradeRequestText,
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

function createChannelSink(echo = true): Sink<PeerAppChannel> {
	const queue: PeerAppChannel[] = [];
	const waiters: Array<(value: PeerAppChannel) => void> = [];
	const seen: PeerAppChannel[] = [];
	return {
		seen,
		handler(channel) {
			seen.push(channel);
			if (echo) {
				channel.onMessage((bytes) => {
					void channel.send(bytes).catch(() => {
						// Closing channels are expected; the send rejection is observed.
					});
				});
			}
			const waiter = waiters.shift();
			if (waiter) waiter(channel);
			else queue.push(channel);
		},
		next() {
			const queued = queue.shift();
			if (queued !== undefined) return Promise.resolve(queued);
			return new Promise<PeerAppChannel>((resolve) => waiters.push(resolve));
		},
	};
}

async function pairWithApproval(options: {
	hostPort: number;
	client: ReturnType<typeof startClient>["client"];
	pairingSink: Sink<PeerPairingRequest>;
	hostKey: PeerPairingRequest["peerKey"];
	clientLabel?: string;
}): Promise<void> {
	let prompts = 0;
	const result = options.client.pair({
		port: options.hostPort,
		label: options.clientLabel,
		approveServerKey: ({ key }) => {
			prompts++;
			assert.ok(peerKeysEqual(key, options.hostKey));
			return "accept";
		},
	});
	const request = await options.pairingSink.next();
	assert.equal(request.approve(), true);
	const paired = await result;
	assert.equal(paired.ok, true, `pairing failed: ${JSON.stringify(paired)}`);
	assert.equal(prompts, 1);
}

test("first contact is encrypted but untrusted until both actual keys are accepted, then exact bytes flow", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const channelSink = createChannelSink();
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: pairingSink.handler,
		onAppChannel: channelSink.handler,
	});
	const { client, remembered } = startClient(t, clientIdentity);

	const pairPromise = client.pair({
		port,
		approveServerKey: ({ key }) => {
			assert.ok(peerKeysEqual(key, hostIdentity.key));
			return "accept";
		},
	});
	const request = await pairingSink.next();
	assert.ok(peerKeysEqual(request.peerKey, clientIdentity.key), "identity comes from the live TLS certificate");
	assert.equal(request.label, "A-phone");
	assert.equal(request.isPending(), true);
	assert.equal(host.pendingPairingCount, 1);
	assert.equal(acceptedPeers.get(clientIdentity.key.keyId), undefined, "nothing is trusted before approval");
	assert.equal(grants.get(clientIdentity.key.keyId), undefined);
	assert.equal(host.activeChannelCount, 0);

	assert.equal(request.approve(), true);
	const paired = await pairPromise;
	assert.equal(paired.ok, true);
	assert.equal(paired.status, "accepted");
	assert.equal(paired.httpStatus, 200);
	assert.ok(paired.serverKey && peerKeysEqual(paired.serverKey, hostIdentity.key));
	const rememberedKey = remembered.read();
	assert.ok(rememberedKey && peerKeysEqual(rememberedKey, hostIdentity.key));

	const acceptedRecord = acceptedPeers.get(clientIdentity.key.keyId);
	assert.ok(acceptedRecord);
	assert.ok(peerKeysEqual(acceptedRecord.key, clientIdentity.key));
	assert.equal(acceptedRecord.receiverKeyId, hostIdentity.key.keyId);
	assert.equal(acceptedRecord.label, "A-phone");
	const grant = grants.get(clientIdentity.key.keyId);
	assert.ok(grant);
	assert.equal(grant.direction, "peer->host");
	assert.equal(grant.capability, "app");
	assert.equal(grant.receiverKeyId, hostIdentity.key.keyId);
	assert.equal(host.activeChannelCount, 0, "pairing itself created no application channel");

	const channel = await client.connectApp({
		port,
		approveServerKey: () => {
			throw new Error("a remembered key must not prompt");
		},
	});
	assert.ok(peerKeysEqual(channel.peerKey, hostIdentity.key));
	const hostChannel = await channelSink.next();
	assert.ok(peerKeysEqual(hostChannel.peerKey, clientIdentity.key));

	const payload = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x68, 0x69]);
	const received = deferred<Buffer>();
	const unsubscribe = channel.onMessage((bytes) => received.resolve(bytes));
	await channel.send(payload);
	assert.ok(Buffer.compare(await withTimeout(received.promise, 2000, "no echo"), payload) === 0);
	unsubscribe();

	assert.equal(host.stats.appChannelsOpened, 1);
	assert.equal(host.pendingPairingCount, 0);
	await channel.close();
});

test("receiving denial creates no identity, grant, or application channel", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: pairingSink.handler,
	});
	const { client, remembered } = startClient(t, clientIdentity);

	const pairPromise = client.pair({ port, approveServerKey: () => "accept" });
	const request = await pairingSink.next();
	assert.equal(request.deny(), true);
	const result = await pairPromise;
	assert.equal(result.ok, false);
	assert.equal(result.status, "denied");
	assert.equal(result.httpStatus, 403);
	assert.equal(result.serverKey, null);
	assert.equal(remembered.read(), null);
	assert.equal(acceptedPeers.get(clientIdentity.key.keyId), undefined);
	assert.equal(grants.get(clientIdentity.key.keyId), undefined);
	assert.equal(host.pendingPairingCount, 0);

	let prompts = 0;
	await assert.rejects(
		client.connectApp({
			port,
			approveServerKey: () => {
				prompts++;
				return "accept";
			},
		}),
		(error: unknown) =>
			isPeerTransportError(error) && error.code === "APP_REFUSED" && error.statusCode === 403,
	);
	assert.equal(prompts, 1, "local key approval alone cannot authorize the server side");
	assert.equal(host.stats.appChannelsOpened, 0);
	assert.equal(remembered.read(), null);
});

test("consent timeout and late approval cannot commit a grant", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { consentTimeoutMs: 100 },
		onPairingRequest: pairingSink.handler,
	});
	const { client, remembered } = startClient(t, clientIdentity);

	const pairPromise = client.pair({ port, approveServerKey: () => "accept" });
	const request = await pairingSink.next();
	const result = await pairPromise;
	assert.equal(result.ok, false);
	assert.equal(result.status, "timeout");
	assert.equal(result.httpStatus, 408);
	assert.equal(request.isPending(), false);
	assert.equal(request.approve(), false, "a late approval after timeout is refused");
	assert.equal(acceptedPeers.get(clientIdentity.key.keyId), undefined);
	assert.equal(grants.get(clientIdentity.key.keyId), undefined);
	assert.equal(host.pendingPairingCount, 0);
	assert.equal(remembered.read(), null);
});

test("client abort during pairing aborts the live consent and commits nothing", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const aborted = deferred<PeerDiagnostic>();
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { consentTimeoutMs: 5000 },
		onPairingRequest: pairingSink.handler,
		onDiagnostic: (event) => {
			if (event.code === "pairing_aborted") aborted.resolve(event);
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
	assert.equal(request.isPending(), true);
	controller.abort();
	await assert.rejects(
		pairPromise,
		(error: unknown) => isPeerTransportError(error) && error.code === "ABORTED",
	);
	await withTimeout(aborted.promise, 2000, "host did not observe the aborted pairing");
	assert.equal(request.isPending(), false);
	assert.equal(request.approve(), false);
	assert.equal(acceptedPeers.get(clientIdentity.key.keyId), undefined);
	assert.equal(grants.get(clientIdentity.key.keyId), undefined);
	assert.equal(host.pendingPairingCount, 0);
	assert.equal(remembered.read(), null);
});

test("approval in the destroyed-before-close interval commits nothing", async (t) => {
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
	const { client, remembered } = startClient(t, clientIdentity);

	const pairPromise = client.pair({ port, approveServerKey: () => "accept" });
	pairPromise.catch(() => {
		// Expected refusal after the socket disappears.
	});
	const request = await pairingSink.next();
	const connection = await withTimeout(testConnection.promise, 2000, "test fixture did not observe the connection");
	assert.equal(request.isPending(), true);
	assert.equal(host.pendingPairingCount, 1);

	// Destroy the live server-side socket synchronously. Its registered 'close'
	// handlers have not run yet, so this exercises the race between a destroyed
	// socket and an approval callback that arrives before the close event.
	connection.destroy();
	assert.equal(request.isPending(), true);
	assert.equal(request.approve(), false, "approval after synchronous destruction is refused");
	assert.equal(request.isPending(), false);
	assert.equal(acceptedPeers.get(clientIdentity.key.keyId), undefined);
	assert.equal(grants.get(clientIdentity.key.keyId), undefined);
	assert.equal(host.pendingPairingCount, 0);
	assert.equal(remembered.read(), null);
	await pairPromise.catch(() => undefined);
});

test("approval after the pairing socket is gone commits nothing", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const aborted = deferred<PeerDiagnostic>();
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { consentTimeoutMs: 5000 },
		onPairingRequest: pairingSink.handler,
		onDiagnostic: (event) => {
			if (event.code === "pairing_aborted") aborted.resolve(event);
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
	assert.equal(host.pendingPairingCount, 1);
	socket.destroy();
	assert.equal(socket.destroyed, true);
	await withTimeout(aborted.promise, 2000, "host did not abort the closed pairing socket");

	// Approval must be refused after the live connection is gone, and no
	// authority may be committed.
	assert.equal(request.isPending(), false);
	assert.equal(request.approve(), false);
	assert.equal(request.isPending(), false);
	assert.equal(acceptedPeers.get(clientIdentity.key.keyId), undefined);
	assert.equal(grants.get(clientIdentity.key.keyId), undefined);
	assert.equal(host.pendingPairingCount, 0);
});

test("a lost acceptance reply leaves the local side untrusted; an idempotent re-pair confirms it", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const accepted = deferred<void>();
	const pairingSink = createSink<PeerPairingRequest>();
	const channelSink = createChannelSink();
	const { host, acceptedPeers, port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: (request) => {
			pairingSink.handler(request);
			request.approve();
		},
		onAppChannel: channelSink.handler,
		onDiagnostic: (event) => {
			if (event.code === "pairing_accepted") accepted.resolve();
		},
	});
	const { client, remembered } = startClient(t, clientIdentity);

	// First attempt: the server accepts, but this raw socket never reads the reply.
	const socket = tls.connect({
		host: "127.0.0.1",
		port,
		cert: clientIdentity.certificatePem,
		key: clientIdentity.privateKeyPem,
		rejectUnauthorized: false,
	});
	socket.on("error", () => {
		// Deliberately discarded.
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("secureConnect", resolve);
		socket.once("error", reject);
	});
	socket.write(pairRequestText({ label: "A-phone", claimKey: clientIdentity.key }));
	await withTimeout(accepted.promise, 2000, "server did not accept the raw pairing");
	socket.destroy();

	// The receiving side remembers the key, but the client has no trustworthy
	// reply and therefore no local trust.
	assert.ok(acceptedPeers.get(clientIdentity.key.keyId));
	assert.equal(remembered.read(), null);

	let prompts = 0;
	const repaired = await client.pair({
		port,
		approveServerKey: () => {
			prompts++;
			return "accept";
		},
	});
	assert.equal(repaired.ok, true);
	assert.equal(repaired.status, "already_accepted");
	assert.equal(prompts, 1);
	const rememberedKey = remembered.read();
	assert.ok(rememberedKey && peerKeysEqual(rememberedKey, hostIdentity.key));
	assert.equal(host.stats.pairingAccepted, 1);

	const channel = await client.connectApp({
		port,
		approveServerKey: () => {
			throw new Error("remembered");
		},
	});
	assert.ok(peerKeysEqual(channel.peerKey, hostIdentity.key));
	await channelSink.next();
	await channel.close();
});

test("remembered reconnect needs no prompt and supports multiple independent channels", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const channelSink = createChannelSink();
	const { host, port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: pairingSink.handler,
		onAppChannel: channelSink.handler,
	});
	const { client } = startClient(t, clientIdentity);
	await pairWithApproval({
		hostPort: port,
		client,
		pairingSink,
		hostKey: hostIdentity.key,
	});
	const promptsAfterPairing = client.stats.pairAttempts;

	const first = await client.connectApp({
		port,
		approveServerKey: () => {
			throw new Error("must not prompt for a remembered key");
		},
	});
	const second = await client.connectApp({
		port,
		approveServerKey: () => {
			throw new Error("must not prompt for a remembered key");
		},
	});
	const firstHost = await channelSink.next();
	const secondHost = await channelSink.next();
	assert.ok(peerKeysEqual(firstHost.peerKey, clientIdentity.key));
	assert.ok(peerKeysEqual(secondHost.peerKey, clientIdentity.key));
	assert.equal(host.activeChannelCount, 2);
	assert.equal(host.stats.appChannelsOpened, 2);
	assert.equal(client.stats.pairAttempts, promptsAfterPairing);

	const replyOne = deferred<Buffer>();
	const replyTwo = deferred<Buffer>();
	first.onMessage((bytes) => replyOne.resolve(bytes));
	second.onMessage((bytes) => replyTwo.resolve(bytes));
	await first.send(Buffer.from("first"));
	await second.send(Buffer.from("second"));
	assert.equal((await withTimeout(replyOne.promise, 2000, "first channel echo")).toString(), "first");
	assert.equal((await withTimeout(replyTwo.promise, 2000, "second channel echo")).toString(), "second");

	const repaired = await client.pair({
		port,
		approveServerKey: () => {
			throw new Error("remembered");
		},
	});
	assert.equal(repaired.ok, true);
	assert.equal(repaired.status, "already_accepted");
	assert.equal(host.stats.pairingAccepted, 1);
	assert.equal(host.stats.pairingRequests, 2);
	await first.close();
	await second.close();
});

test("clearing a remembered server key during pending receiving approval is not undone", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { consentTimeoutMs: 5000 },
		onPairingRequest: pairingSink.handler,
	});
	const remembered = createInMemoryRememberedPeerKeyStore(hostIdentity.key);
	const { client } = startClient(t, clientIdentity, { remembered });

	const pairPromise = client.pair({
		port,
		approveServerKey: () => {
			throw new Error("a remembered handshake must not prompt");
		},
	});
	const request = await pairingSink.next();
	assert.equal(request.isPending(), true);

	// Locally revoke trust while the receiving side still owns the decision.
	remembered.clear();
	assert.equal(remembered.read(), null);
	assert.equal(request.approve(), true);
	await assert.rejects(
		pairPromise,
		(error: unknown) => isPeerTransportError(error) && error.code === "PEER_KEY_CHANGED",
	);
	assert.equal(remembered.read(), null, "the in-flight pairing must not restore cleared trust");
	assert.ok(acceptedPeers.get(clientIdentity.key.keyId), "the receiving side may have accepted before the reply");
	assert.ok(grants.get(clientIdentity.key.keyId));
	assert.equal(host.pendingPairingCount, 0);
});

test("same receiving identity and stores preserve remembered access across close/recreate", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const acceptedPeers = createInMemoryAcceptedPeerStore();
	const grants = createInMemoryDirectionalGrantStore();
	const pairingSink = createSink<PeerPairingRequest>();
	const channelSink = createChannelSink();
	const firstHost = await startHost(t, {
		identity: hostIdentity,
		acceptedPeers,
		grants,
		onPairingRequest: pairingSink.handler,
		onAppChannel: channelSink.handler,
	});
	const { client } = startClient(t, clientIdentity);
	await pairWithApproval({ hostPort: firstHost.port, client, pairingSink, hostKey: hostIdentity.key });
	await firstHost.host.close();

	let approvals = 0;
	const secondHost = await startHost(t, {
		identity: hostIdentity,
		acceptedPeers,
		grants,
		onPairingRequest: (request) => {
			approvals++;
			request.deny();
		},
		onAppChannel: channelSink.handler,
	});
	const confirmed = await client.pair({
		port: secondHost.port,
		approveServerKey: () => {
			throw new Error("the stable receiving identity is still remembered");
		},
	});
	assert.equal(confirmed.ok, true);
	assert.equal(confirmed.status, "already_accepted");
	assert.equal(approvals, 0, "recreating the same receiving identity must not re-prompt");

	const channel = await client.connectApp({
		port: secondHost.port,
		approveServerKey: () => {
			throw new Error("the stable receiving identity is still remembered");
		},
	});
	const hostChannel = await channelSink.next();
	assert.ok(peerKeysEqual(hostChannel.peerKey, clientIdentity.key));
	const received = deferred<Buffer>();
	channel.onMessage((bytes) => received.resolve(bytes));
	const payload = Buffer.from("recreated-listener");
	await channel.send(payload);
	assert.ok(Buffer.compare(await withTimeout(received.promise, 2000, "recreated listener echo"), payload) === 0);
	assert.equal(secondHost.stats.appChannelsOpened, 1);
	await channel.close();

	// Revoking the remembered peer and recreating the same receiving identity
	// must still refuse the next application connection.
	assert.equal(secondHost.host.revoke(clientIdentity.key), true);
	await secondHost.host.close();
	const thirdHost = await startHost(t, {
		identity: hostIdentity,
		acceptedPeers,
		grants,
		onPairingRequest: () => {
			approvals++;
		},
		onAppChannel: channelSink.handler,
	});
	await assert.rejects(
		client.connectApp({
			port: thirdHost.port,
			approveServerKey: () => {
				throw new Error("the receiving key is still remembered, but access was revoked");
			},
		}),
		(error: unknown) =>
			isPeerTransportError(error) && error.code === "APP_REFUSED" && error.statusCode === 403,
	);
	assert.equal(approvals, 0);
});

test("old pending approval after close cannot grant on a recreated listener", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const acceptedPeers = createInMemoryAcceptedPeerStore();
	const grants = createInMemoryDirectionalGrantStore();
	const pairingSink = createSink<PeerPairingRequest>();
	const firstHost = await startHost(t, {
		identity: hostIdentity,
		acceptedPeers,
		grants,
		onPairingRequest: pairingSink.handler,
	});
	const { client } = startClient(t, clientIdentity);
	const pairPromise = client.pair({ port: firstHost.port, approveServerKey: () => "accept" });
	pairPromise.catch(() => {
		// The old host is closed before the decision can complete.
	});
	const request = await pairingSink.next();
	await firstHost.host.close();
	assert.equal(request.isPending(), false);
	assert.equal(request.approve(), false);
	assert.equal(acceptedPeers.get(clientIdentity.key.keyId), undefined);
	assert.equal(grants.get(clientIdentity.key.keyId), undefined);

	let appChannels = 0;
	const secondHost = await startHost(t, {
		identity: hostIdentity,
		acceptedPeers,
		grants,
		onPairingRequest: () => {
			throw new Error("the old pending approval must not become a new request");
		},
		onAppChannel: () => {
			appChannels++;
		},
	});
	const denied = await rawTlsExchange({
		port: secondHost.port,
		identity: clientIdentity,
		request: upgradeRequestText(),
	});
	assert.match(denied.text, /^HTTP\/1\.1 403/);
	assert.equal(appChannels, 0);
	assert.equal(request.approve(), false);
	await pairPromise.catch(() => undefined);
});

test("same stores with a different receiving identity do not inherit grants", async (t) => {
	const firstHostIdentity = await newIdentity("B-laptop");
	const otherHostIdentity = await newIdentity("B-other");
	const clientIdentity = await newIdentity("A-phone");
	const acceptedPeers = createInMemoryAcceptedPeerStore();
	const grants = createInMemoryDirectionalGrantStore();
	const firstHost = await startHost(t, {
		identity: firstHostIdentity,
		acceptedPeers,
		grants,
		onPairingRequest: (request) => {
			request.approve();
		},
	});
	const paired = await startClient(t, clientIdentity);
	const firstPair = await paired.client.pair({ port: firstHost.port, approveServerKey: () => "accept" });
	assert.equal(firstPair.ok, true);
	await firstHost.host.close();

	let approvals = 0;
	let appChannels = 0;
	const otherHost = await startHost(t, {
		identity: otherHostIdentity,
		acceptedPeers,
		grants,
		onPairingRequest: () => {
			approvals++;
		},
		onAppChannel: () => {
			appChannels++;
		},
	});
	const clientPinnedToOtherHost = startClient(t, clientIdentity, {
		remembered: createInMemoryRememberedPeerKeyStore(otherHostIdentity.key),
	});
	await assert.rejects(
		clientPinnedToOtherHost.client.connectApp({
			port: otherHost.port,
			approveServerKey: () => {
				throw new Error("the other receiving key is already pinned locally");
			},
		}),
		(error: unknown) =>
			isPeerTransportError(error) && error.code === "APP_REFUSED" && error.statusCode === 403,
	);
	assert.equal(approvals, 0);
	assert.equal(appChannels, 0);
	const oldAccepted = acceptedPeers.get(clientIdentity.key.keyId);
	const oldGrant = grants.get(clientIdentity.key.keyId);
	assert.ok(oldAccepted);
	assert.ok(oldGrant);
	assert.equal(oldAccepted.receiverKeyId, firstHostIdentity.key.keyId);
	assert.equal(oldGrant.receiverKeyId, firstHostIdentity.key.keyId);
});

test("revocation and a changed client key refuse new channels while remembered server identity stays verified", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairingSink = createSink<PeerPairingRequest>();
	const channelSink = createChannelSink();
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: pairingSink.handler,
		onAppChannel: channelSink.handler,
	});
	const { client, remembered } = startClient(t, clientIdentity);
	await pairWithApproval({ hostPort: port, client, pairingSink, hostKey: hostIdentity.key });

	const active = await client.connectApp({
		port,
		approveServerKey: () => {
			throw new Error("remembered");
		},
	});
	const hostActive = await channelSink.next();
	assert.ok(peerKeysEqual(hostActive.peerKey, clientIdentity.key));

	assert.equal(host.revoke(clientIdentity.key), true);
	assert.equal(acceptedPeers.get(clientIdentity.key.keyId), undefined);
	assert.equal(grants.get(clientIdentity.key.keyId), undefined);
	// The adapter does not decide active-channel lifecycle on revocation.
	const stillThere = deferred<Buffer>();
	active.onMessage((bytes) => stillThere.resolve(bytes));
	await active.send(Buffer.from("active"));
	assert.equal((await withTimeout(stillThere.promise, 2000, "active channel remained usable")).toString(), "active");

	const promptsBefore = client.stats.pairAttempts;
	await assert.rejects(
		client.connectApp({
			port,
			approveServerKey: () => {
				throw new Error("server key is still remembered");
			},
		}),
		(error: unknown) =>
			isPeerTransportError(error) && error.code === "APP_REFUSED" && error.statusCode === 403,
	);
	assert.equal(client.stats.pairAttempts, promptsBefore);
	const rememberedKey = remembered.read();
	assert.ok(rememberedKey && peerKeysEqual(rememberedKey, hostIdentity.key));

	// Same label, different key: the label grants nothing, and fresh receiving
	// approval is required for the new key.
	const changedIdentity = await newIdentity("A-phone");
	const changed = startClient(t, changedIdentity);
	let changedPrompts = 0;
	await assert.rejects(
		changed.client.connectApp({
			port,
			approveServerKey: () => {
				changedPrompts++;
				return "accept";
			},
		}),
		(error: unknown) =>
			isPeerTransportError(error) && error.code === "APP_REFUSED" && error.statusCode === 403,
	);
	assert.equal(changedPrompts, 1);
	assert.equal(acceptedPeers.get(changedIdentity.key.keyId), undefined);

	await pairWithApproval({
		hostPort: port,
		client: changed.client,
		pairingSink,
		hostKey: hostIdentity.key,
	});
	const changedChannel = await changed.client.connectApp({
		port,
		approveServerKey: () => {
			throw new Error("remembered after pairing");
		},
	});
	await channelSink.next();
	assert.ok(peerKeysEqual(changedChannel.peerKey, hostIdentity.key));
	assert.ok(acceptedPeers.get(changedIdentity.key.keyId));
	assert.ok(grants.get(changedIdentity.key.keyId));

	await active.close();
	await changedChannel.close();
});
