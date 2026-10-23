import assert from "node:assert/strict";
import test from "node:test";
import {
	isPeerTransportError,
	peerKeysEqual,
	type PeerAppChannel,
} from "../src/session-host/network/index";
import {
	deferred,
	newIdentity,
	startClient,
	startHost,
	withTimeout,
} from "./session-host-network-helpers";

function echoHandler(channels: PeerAppChannel[]): (channel: PeerAppChannel) => void {
	return (channel) => {
		channels.push(channel);
		channel.onMessage((bytes) => {
			void channel.send(bytes).catch(() => {
				// Channel close races are expected.
			});
		});
	};
}

test("A->B acceptance never grants B->A; each direction needs its own acceptance and grant", async (t) => {
	const identityA = await newIdentity("A-phone");
	const identityB = await newIdentity("B-laptop");
	const channelsA: PeerAppChannel[] = [];
	const channelsB: PeerAppChannel[] = [];
	const hostA = await startHost(t, {
		identity: identityA,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: echoHandler(channelsA),
	});
	const hostB = await startHost(t, {
		identity: identityB,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: echoHandler(channelsB),
	});
	const clientA = startClient(t, identityA);
	const clientB = startClient(t, identityB);

	const pairedAToB = await clientA.client.pair({
		port: hostB.port,
		approveServerKey: () => "accept",
	});
	assert.equal(pairedAToB.ok, true);
	assert.ok(hostB.acceptedPeers.get(identityA.key.keyId));
	assert.ok(hostB.grants.get(identityA.key.keyId));
	assert.equal(hostA.acceptedPeers.get(identityB.key.keyId), undefined, "A has not accepted B");
	assert.equal(hostA.grants.get(identityB.key.keyId), undefined);

	const aToB = await clientA.client.connectApp({
		port: hostB.port,
		approveServerKey: () => {
			throw new Error("remembered");
		},
	});
	const aToBHost = channelsB[0];
	assert.ok(aToBHost);
	const aToBReply = deferred<Buffer>();
	aToB.onMessage((bytes) => aToBReply.resolve(bytes));
	await aToB.send(Buffer.from("a-to-b"));
	assert.equal((await withTimeout(aToBReply.promise, 2000, "A->B echo")).toString(), "a-to-b");

	// B can connect to A only after A independently accepts B and grants B->A.
	let bPrompts = 0;
	await assert.rejects(
		clientB.client.connectApp({
			port: hostA.port,
			approveServerKey: () => {
				bPrompts++;
				return "accept";
			},
		}),
		(error: unknown) =>
			isPeerTransportError(error) && error.code === "APP_REFUSED" && error.statusCode === 403,
	);
	assert.equal(bPrompts, 1);
	assert.equal(hostA.stats.appChannelsOpened, 0);
	assert.equal(hostA.acceptedPeers.get(identityB.key.keyId), undefined);
	assert.equal(hostA.grants.get(identityB.key.keyId), undefined);
	assert.equal(hostB.grants.get(identityB.key.keyId), undefined, "B never granted itself");

	const pairedBToA = await clientB.client.pair({
		port: hostA.port,
		approveServerKey: () => "accept",
	});
	assert.equal(pairedBToA.ok, true);
	const grantBToA = hostA.grants.get(identityB.key.keyId);
	assert.ok(grantBToA);
	assert.equal(grantBToA.direction, "peer->host");
	assert.equal(hostB.grants.get(identityB.key.keyId), undefined);

	const bToA = await clientB.client.connectApp({
		port: hostA.port,
		approveServerKey: () => {
			throw new Error("remembered");
		},
	});
	const bToAHost = channelsA[0];
	assert.ok(bToAHost);
	const bToAReply = deferred<Buffer>();
	bToA.onMessage((bytes) => bToAReply.resolve(bytes));
	await bToA.send(Buffer.from("b-to-a"));
	assert.equal((await withTimeout(bToAReply.promise, 2000, "B->A echo")).toString(), "b-to-a");

	assert.ok(hostA.acceptedPeers.get(identityB.key.keyId));
	assert.ok(hostB.acceptedPeers.get(identityA.key.keyId));
	await aToB.close();
	await bToA.close();
});

test("multiple accepted peers and channels keep independent authority without overwriting it", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const identityA = await newIdentity("A-phone");
	const identityC = await newIdentity("C-tablet");
	const channels: PeerAppChannel[] = [];
	const { host, acceptedPeers, grants, port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: echoHandler(channels),
	});
	const clientA = startClient(t, identityA);
	const clientC = startClient(t, identityC);

	const pairedA = await clientA.client.pair({ port, approveServerKey: () => "accept" });
	const pairedC = await clientC.client.pair({ port, approveServerKey: () => "accept" });
	assert.equal(pairedA.ok, true);
	assert.equal(pairedC.ok, true);
	const recordA = acceptedPeers.get(identityA.key.keyId);
	const recordC = acceptedPeers.get(identityC.key.keyId);
	assert.ok(recordA);
	assert.ok(recordC);
	assert.ok(peerKeysEqual(recordA.key, identityA.key));
	assert.ok(peerKeysEqual(recordC.key, identityC.key));
	assert.equal(recordA.label, "A-phone");
	assert.equal(recordC.label, "C-tablet");
	assert.ok(grants.get(identityA.key.keyId));
	assert.ok(grants.get(identityC.key.keyId));

	const channelA = await clientA.client.connectApp({
		port,
		approveServerKey: () => {
			throw new Error("remembered");
		},
	});
	const channelC = await clientC.client.connectApp({
		port,
		approveServerKey: () => {
			throw new Error("remembered");
		},
	});
	assert.equal(host.activeChannelCount, 2);
	assert.equal(channels.length, 2);

	// Revoking one peer does not overwrite the other peer's authority, and it
	// does not close an already-authorized channel.
	assert.equal(host.revoke(identityA.key), true);
	assert.equal(acceptedPeers.get(identityA.key.keyId), undefined);
	assert.equal(grants.get(identityA.key.keyId), undefined);
	assert.ok(acceptedPeers.get(identityC.key.keyId));
	assert.ok(grants.get(identityC.key.keyId));

	const replyC = deferred<Buffer>();
	channelC.onMessage((bytes) => replyC.resolve(bytes));
	await channelC.send(Buffer.from("still-authorized"));
	assert.equal((await withTimeout(replyC.promise, 2000, "C channel echo")).toString(), "still-authorized");

	await assert.rejects(
		clientA.client.connectApp({
			port,
			approveServerKey: () => {
				throw new Error("remembered");
			},
		}),
		(error: unknown) =>
			isPeerTransportError(error) && error.code === "APP_REFUSED" && error.statusCode === 403,
	);
	assert.equal(host.stats.appChannelsOpened, 2);
	await channelA.close();
	await channelC.close();
});
