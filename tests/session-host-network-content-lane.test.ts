/**
 * Focused regressions for the additive opt-in content lane on the existing
 * `/app` TLS listener. Every fixture is synthetic, in-memory, and bound to an
 * owned loopback port; no product state, keys, files, or listeners outside the
 * test process are touched.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	APP_SUBPROTOCOL,
	CONTENT_SUBPROTOCOL,
	isPeerTransportError,
	peerAppLaneForSubprotocol,
	peerSubprotocolForLane,
	type PeerAppChannel,
	type PeerClient,
} from "../src/session-host/network/index";
import {
	deferred,
	newIdentity,
	rawTlsExchange,
	startClient,
	startHost,
	upgradeRequestText,
	withTimeout,
} from "./session-host-network-helpers";

function echoHost(channels: PeerAppChannel[]): (channel: PeerAppChannel) => void {
	return (channel) => {
		channels.push(channel);
		channel.onMessage((bytes) => {
			void channel.send(bytes).catch(() => {
				// Close races are expected.
			});
		});
	};
}

async function pairClient(client: PeerClient, port: number): Promise<void> {
	const result = await client.pair({ port, approveServerKey: () => "accept" });
	assert.equal(result.ok, true);
}

/** The pinned remembered key must be used; a prompt here would be a regression. */
function pinnedServerKey(): never {
	throw new Error("remembered");
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
	await withTimeout(
		(async () => {
			while (!condition()) await new Promise<void>((resolve) => setTimeout(resolve, 10));
		})(),
		3000,
		message,
	);
}

test("lane helpers map only the two exact fixed subprotocols", () => {
	assert.equal(CONTENT_SUBPROTOCOL, "pi-peer-content-v1");
	assert.notEqual(CONTENT_SUBPROTOCOL, APP_SUBPROTOCOL);
	assert.equal(peerSubprotocolForLane("app"), APP_SUBPROTOCOL);
	assert.equal(peerSubprotocolForLane("content"), CONTENT_SUBPROTOCOL);
	assert.equal(peerAppLaneForSubprotocol(APP_SUBPROTOCOL), "app");
	assert.equal(peerAppLaneForSubprotocol(CONTENT_SUBPROTOCOL), "content");
	for (const value of [
		"",
		"pi-peer-app-v1 ",
		"PI-PEER-APP-V1",
		"pi-peer-app-v2",
		`${CONTENT_SUBPROTOCOL},`,
		"evil-proto",
		undefined,
		null,
		false,
		0,
	]) {
		assert.equal(peerAppLaneForSubprotocol(value), null, `no lane for ${JSON.stringify(value)}`);
	}
	assert.throws(
		() => peerSubprotocolForLane("roster" as unknown as "app"),
		(error: unknown) => isPeerTransportError(error) && error.code === "INVALID_ARGUMENT",
	);
});

test("the default lane keeps legacy delivery and never reaches the content receiver", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const contentChannels: PeerAppChannel[] = [];
	const hostApp = deferred<PeerAppChannel>();
	const { host, port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: (channel) => {
			echoHost([])(channel);
			hostApp.resolve(channel);
		},
		onContentChannel: (channel) => {
			contentChannels.push(channel);
		},
	});
	const client = startClient(t, clientIdentity);
	await pairClient(client.client, port);

	const channel = await client.client.connectApp({ port, approveServerKey: pinnedServerKey });
	assert.equal(channel.lane, "app");

	const serverSide = await withTimeout(hostApp.promise, 3000, "the legacy app channel never reached its receiver");
	assert.equal(serverSide.lane, "app");
	assert.equal(serverSide.peerKey.keyId, clientIdentity.key.keyId);
	assert.equal(contentChannels.length, 0, "the content receiver must not see a legacy app channel");
	assert.equal(host.activeChannelCount, 1);

	const echoed = deferred<string>();
	channel.onMessage((bytes) => echoed.resolve(bytes.toString("utf8")));
	await channel.send(Buffer.from("legacy"));
	assert.equal(await withTimeout(echoed.promise, 3000, "legacy bytes were not echoed"), "legacy");

	await channel.close();
	await withTimeout(serverSide.closed, 3000, "the legacy channel did not settle after close");
	assert.equal(host.activeChannelCount, 0);
});

test("an explicit content lane is authenticated, separated, and echoes on the same listener", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const appMessages: string[] = [];
	const contentMessages: string[] = [];
	const hostApp = deferred<PeerAppChannel>();
	const hostContent = deferred<PeerAppChannel>();
	const appBytes = deferred<void>();
	const contentBytes = deferred<void>();
	let appHandlerCalls = 0;
	let contentHandlerCalls = 0;
	const { host, port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: (channel) => {
			appHandlerCalls++;
			channel.onMessage((bytes) => {
				appMessages.push(bytes.toString("utf8"));
				appBytes.resolve();
			});
			hostApp.resolve(channel);
		},
		onContentChannel: (channel) => {
			contentHandlerCalls++;
			channel.onMessage((bytes) => {
				contentMessages.push(bytes.toString("utf8"));
				contentBytes.resolve();
			});
			hostContent.resolve(channel);
		},
	});
	const client = startClient(t, clientIdentity);
	await pairClient(client.client, port);

	const appChannel = await client.client.connectApp({ port, approveServerKey: pinnedServerKey });
	const contentChannel = await client.client.connectApp({
		port,
		lane: "content",
		approveServerKey: pinnedServerKey,
	});
	assert.equal(appChannel.lane, "app");
	assert.equal(contentChannel.lane, "content");
	assert.equal(
		contentChannel.peerKey.keyId,
		hostIdentity.key.keyId,
		"the content lane keeps the pinned exact server key",
	);

	const serverContent = await withTimeout(hostContent.promise, 3000, "the content channel never reached its receiver");
	const serverApp = await withTimeout(hostApp.promise, 3000, "the app channel never reached its receiver");
	assert.equal(serverContent.lane, "content");
	assert.equal(serverApp.lane, "app");
	assert.equal(serverContent.peerKey.keyId, clientIdentity.key.keyId);
	assert.equal(appHandlerCalls, 1);
	assert.equal(contentHandlerCalls, 1);
	assert.equal(host.activeChannelCount, 2, "both lanes share the existing connection accounting");
	assert.equal(host.stats.appChannelsOpened, 2);

	await appChannel.send(Buffer.from("metadata"));
	await contentChannel.send(Buffer.from("content"));
	await withTimeout(appBytes.promise, 3000, "the legacy lane did not deliver its bytes");
	await withTimeout(contentBytes.promise, 3000, "the content lane did not deliver its bytes");
	assert.deepEqual(appMessages, ["metadata"], "no content bytes may reach the metadata receiver");
	assert.deepEqual(contentMessages, ["content"], "no metadata bytes may reach the content receiver");

	await contentChannel.close();
	await withTimeout(serverContent.closed, 3000, "the content channel did not settle after close");
	await appChannel.close();
	await waitFor(() => host.activeChannelCount === 0, "both lanes did not release their connection slots");
});

test("content is refused when the host did not opt in and the legacy lane is unaffected", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const { host, port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: echoHost([]),
	});
	const client = startClient(t, clientIdentity);
	await pairClient(client.client, port);

	await assert.rejects(
		client.client.connectApp({ port, lane: "content", approveServerKey: pinnedServerKey }),
		(error: unknown) => isPeerTransportError(error) && error.code === "APP_REFUSED" && error.statusCode === 400,
	);
	assert.equal(host.activeChannelCount, 0);

	const contentUpgrade = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: upgradeRequestText({ protocol: CONTENT_SUBPROTOCOL }),
		timeoutMs: 500,
	});
	assert.match(contentUpgrade.text, /^HTTP\/1\.1 400/);
	assert.match(contentUpgrade.text, /unsupported_subprotocol/);
	assert.equal(host.activeChannelCount, 0);

	const legacy = await client.client.connectApp({ port, approveServerKey: pinnedServerKey });
	assert.equal(legacy.lane, "app");
	await legacy.close();
});

test("a content-enabled host still prefers the legacy lane and still fails closed", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const contentChannels: PeerAppChannel[] = [];
	const appSeen = deferred<PeerAppChannel>();
	let appChannels = 0;
	const { port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: (channel) => {
			appChannels++;
			appSeen.resolve(channel);
		},
		onContentChannel: (channel) => {
			contentChannels.push(channel);
		},
	});
	const client = startClient(t, clientIdentity);
	await pairClient(client.client, port);

	const legacyPreferred = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: upgradeRequestText({ protocol: `${CONTENT_SUBPROTOCOL}, ${APP_SUBPROTOCOL}` }),
		timeoutMs: 500,
	});
	assert.match(legacyPreferred.text, /^HTTP\/1\.1 101/);
	assert.match(legacyPreferred.text, new RegExp(`Sec-WebSocket-Protocol: ${APP_SUBPROTOCOL}`, "i"));
	assert.equal(
		(await withTimeout(appSeen.promise, 3000, "the legacy lane was not selected")).lane,
		"app",
	);

	const reversed = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: upgradeRequestText({ protocol: `${APP_SUBPROTOCOL}, ${CONTENT_SUBPROTOCOL}` }),
		timeoutMs: 500,
	});
	assert.match(reversed.text, /^HTTP\/1\.1 101/);
	assert.match(reversed.text, new RegExp(`Sec-WebSocket-Protocol: ${APP_SUBPROTOCOL}`, "i"));
	assert.equal(appChannels, 2);

	const unknown = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: upgradeRequestText({ protocol: "evil-proto" }),
		timeoutMs: 500,
	});
	assert.match(unknown.text, /^HTTP\/1\.1 400/);
	assert.match(unknown.text, /unsupported_subprotocol/);

	const missing = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: upgradeRequestText({ protocol: null }),
		timeoutMs: 500,
	});
	assert.match(missing.text, /^HTTP\/1\.1 400/);
	assert.match(missing.text, /unsupported_subprotocol/);

	assert.equal(contentChannels.length, 0, "no unoffered lane may reach the content receiver");
});

test("revocation and an unaccepted key block both lanes identically", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const { host, port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: echoHost([]),
		onContentChannel: echoHost([]),
	});
	const client = startClient(t, clientIdentity);
	await pairClient(client.client, port);
	assert.equal(host.revoke(clientIdentity.key), true);

	for (const lane of ["app", "content"] as const) {
		await assert.rejects(
			client.client.connectApp({ port, lane, approveServerKey: pinnedServerKey }),
			(error: unknown) =>
				isPeerTransportError(error) && error.code === "APP_REFUSED" && error.statusCode === 403,
			`a revoked key must not open the ${lane} lane`,
		);
	}
	assert.equal(host.activeChannelCount, 0);

	const stranger = startClient(t, await newIdentity("A-phone"));
	for (const lane of ["app", "content"] as const) {
		await assert.rejects(
			stranger.client.connectApp({ port, lane, approveServerKey: () => "accept" }),
			(error: unknown) =>
				isPeerTransportError(error) && error.code === "APP_REFUSED" && error.statusCode === 403,
			`a never-accepted key must not open the ${lane} lane`,
		);
	}
	assert.equal(host.activeChannelCount, 0);
});

test("existing per-peer connection capacity still covers both lanes", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const { host, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { maxConnectionsPerPeer: 1 },
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: echoHost([]),
		onContentChannel: echoHost([]),
	});
	const client = startClient(t, clientIdentity);
	await pairClient(client.client, port);

	const app = await client.client.connectApp({ port, approveServerKey: pinnedServerKey });
	await assert.rejects(
		client.client.connectApp({ port, lane: "content", approveServerKey: pinnedServerKey }),
		(error: unknown) => isPeerTransportError(error) && error.code === "APP_REFUSED" && error.statusCode === 503,
	);
	await app.close();
	await waitFor(() => host.activeChannelCount === 0, "the legacy channel did not finalize its slot");

	const content = await withTimeout(
		client.client.connectApp({ port, lane: "content", approveServerKey: pinnedServerKey }),
		3000,
		"the content lane did not open after the legacy slot settled",
	);
	assert.equal(content.lane, "content");
	await content.close();
});
