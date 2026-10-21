import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import test from "node:test";
import WebSocket from "ws";
import {
	createInMemoryAcceptedPeerStore,
	createInMemoryDirectionalGrantStore,
	createPeerByteChannel,
	createPeerHost,
	isPeerTransportError,
	peerKeysEqual,
	resolvePeerTransportBounds,
	type AcceptedPeerStore,
	type PeerAppChannel,
	type PeerClient,
	type PeerDiagnostic,
	type PeerPairingRequest,
} from "../src/session-host/network/index";
import {
	assertRefused,
	deferred,
	maskedBinaryFrame,
	maskedTextFrame,
	newIdentity,
	openRawWebSocket,
	pairRequestText,
	rawTlsExchange,
	startClient,
	startHost,
	startTlsProbe,
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

async function pairClient(
	client: PeerClient,
	port: number,
): Promise<void> {
	const result = await client.pair({ port, approveServerKey: () => "accept" });
	assert.equal(result.ok, true);
}

class FakeControlSocket extends EventEmitter {
	readyState: number = WebSocket.OPEN;
	bufferedAmount = 0;
	pongCalls = 0;
	terminateCalls = 0;
	withholdPongCallbacks = false;
	private readonly withheldCallbacks: Array<(error?: Error) => void> = [];

	pong(_data?: unknown, _mask?: boolean, callback?: (error?: Error) => void): void {
		this.pongCalls++;
		if (!callback) return;
		if (this.withholdPongCallbacks) this.withheldCallbacks.push(callback);
		else callback();
	}

	send(): void {
		// Data sends are not exercised by these control-frame regressions.
	}

	close(): void {
		this.readyState = WebSocket.CLOSED;
		this.emit("close", 1000, "");
	}

	terminate(): void {
		this.terminateCalls++;
		this.readyState = WebSocket.CLOSED;
		this.emit("close", 1006, "terminated");
	}
}

test("substituted server with the same label receives zero HTTP headers, tokens, or application bytes", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const { port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: echoHost([]),
	});
	const clientFixture = startClient(t, clientIdentity);
	const { client, remembered } = clientFixture;
	await pairClient(client, port);

	const substitute = await startTlsProbe(t, await newIdentity("B-laptop"));
	let prompts = 0;
	await assert.rejects(
		client.pair({
			port: substitute.port,
			approveServerKey: () => {
				prompts++;
				return "accept";
			},
		}),
		(error: unknown) => isPeerTransportError(error) && error.code === "PEER_KEY_MISMATCH",
	);
	await assert.rejects(
		client.connectApp({
			port: substitute.port,
			headers: { authorization: "Bearer fixture-secret-token", cookie: "fixture_session=secret" },
			approveServerKey: () => {
				prompts++;
				return "accept";
			},
		}),
		(error: unknown) => isPeerTransportError(error) && error.code === "PEER_KEY_MISMATCH",
	);
	assert.equal(prompts, 0, "a remembered mismatch never prompts or falls back to unknown-peer");
	assert.equal(substitute.stats.decryptedBytes, 0, "the substitute received zero decrypted bytes");
	assert.equal(substitute.stats.dataEvents, 0);
	assert.equal(substitute.stats.captured.length, 0);
	const rememberedKey = remembered.read();
	assert.ok(rememberedKey && peerKeysEqual(rememberedKey, hostIdentity.key), "remembered pin is not overwritten");

	// Control: the same probe records a first-use request, proving the zero above
	// is a measurement and not an inability to observe bytes.
	const controlIdentity = await newIdentity("C-control");
	const control = startClient(t, controlIdentity);
	const controller = new AbortController();
	const controlPair = control.client.pair({
		port: substitute.port,
		approveServerKey: () => "accept",
		signal: controller.signal,
	});
	await withTimeout(substitute.firstData, 2000, "control request bytes were not observed");
	const captured = substitute.stats.captured.toString("utf8");
	assert.match(captured, /^POST \/pair HTTP\/1\.1\r\n/);
	assert.match(captured, /x-peer-label: C-control/);
	controller.abort();
	await assert.rejects(
		controlPair,
		(error: unknown) => isPeerTransportError(error) && error.code === "ABORTED",
	);
});

test("pairing response deadline destroys a silent or stalled server before headers/body complete", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const silent = await startTlsProbe(t, hostIdentity);
	const silentClient = startClient(t, await newIdentity("A-phone"), {
		bounds: { pairingResponseTimeoutMs: 150 },
	});
	const silentStarted = Date.now();
	await assert.rejects(
		silentClient.client.pair({ port: silent.port, approveServerKey: () => "accept" }),
		(error: unknown) => isPeerTransportError(error) && error.code === "PAIRING_TIMEOUT",
	);
	assert.ok(Date.now() - silentStarted < 2000, "silent pairing response was not bounded");
	assert.ok(silent.stats.dataEvents > 0, "request headers reached the silent server");
	assert.equal(silentClient.remembered.read(), null);

	const stalledIdentity = await newIdentity("B-stall");
	const stalled = https.createServer(
		{
			key: stalledIdentity.privateKeyPem,
			cert: stalledIdentity.certificatePem,
			requestCert: true,
			rejectUnauthorized: false,
		},
		(_request, response) => {
			response.writeHead(200, { "content-type": "application/json", "content-length": "999" });
			response.write('{"status":"accepted"');
			// Never end the body.
		},
	);
	stalled.on("tlsClientError", () => {
		// The client deadline destroys the socket.
	});
	stalled.on("clientError", () => {
		// Sanitized parser failures are irrelevant here.
	});
	await new Promise<void>((resolve, reject) => {
		stalled.once("error", reject);
		stalled.listen(0, "127.0.0.1", () => resolve());
	});
	t.after(async () => {
		stalled.closeAllConnections?.();
		await new Promise<void>((resolve) => stalled.close(() => resolve()));
	});
	const stalledAddress = stalled.address();
	assert.ok(stalledAddress && typeof stalledAddress !== "string");
	const stalledClient = startClient(t, await newIdentity("C-stall"), {
		bounds: { pairingResponseTimeoutMs: 150 },
	});
	await assert.rejects(
		stalledClient.client.pair({ port: stalledAddress.port, approveServerKey: () => "accept" }),
		(error: unknown) => isPeerTransportError(error) && error.code === "PAIRING_TIMEOUT",
	);
	assert.equal(stalledClient.remembered.read(), null);
});

test("raw transport socket admission is bounded before TLS or application work", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const admitted = deferred<void>();
	const disconnected = deferred<void>();
	let admittedCount = 0;
	const { host, acceptedPeers, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { maxTransportSockets: 2 },
		onPairingRequest: (request) => {
			request.approve();
		},
		onDiagnostic: (event) => {
			if (event.code === "host_connected") {
				admittedCount++;
				if (admittedCount === 2) admitted.resolve();
			} else if (event.code === "host_disconnected") {
				disconnected.resolve();
			}
		},
	});
	const connectRaw = (): Promise<net.Socket> =>
		new Promise<net.Socket>((resolve, reject) => {
			const socket = net.connect({ host: "127.0.0.1", port });
			socket.on("error", () => {
				// Disposable raw probe.
			});
			socket.once("connect", () => resolve(socket));
			socket.once("error", reject);
		});

	const first = await connectRaw();
	const second = await connectRaw();
	await withTimeout(admitted.promise, 2000, "raw sockets were not admitted");
	assert.equal(host.transportSocketCount, 2);

	// The third raw socket is destroyed before a TLS handshake can start.
	const overflow = net.connect({ host: "127.0.0.1", port });
	overflow.on("error", () => {
		// The host destroys the overflow socket.
	});
	await withTimeout(
		new Promise<void>((resolve) => {
			overflow.once("close", resolve);
			overflow.once("error", resolve);
		}),
		2000,
		"overflow raw socket was not refused",
	);
	assert.equal(host.transportSocketCount, 2, "overflow socket was never admitted");

	const firstClosed = new Promise<void>((resolve) => first.once("close", resolve));
	first.destroy();
	await withTimeout(firstClosed, 2000, "released raw socket did not close");
	await withTimeout(disconnected.promise, 2000, "host did not release the raw socket");
	assert.equal(host.transportSocketCount, 1);

	// Releasing a slot admits a real TLS pairing connection again.
	const client = startClient(t, await newIdentity("A-phone"));
	await pairClient(client.client, port);
	assert.ok(acceptedPeers.get(client.identity.key.keyId));
	second.destroy();
});

test("unknown paths, methods, subprotocols, and oversized metadata fail closed", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const channels: PeerAppChannel[] = [];
	const { host, port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: echoHost(channels),
	});
	const client = startClient(t, clientIdentity);
	await pairClient(client.client, port);
	const appChannelsBefore = host.stats.appChannelsOpened;

	const unknownPairPath = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: pairRequestText({ label: "A-phone", path: "/nope" }),
	});
	assert.match(unknownPairPath.text, /^HTTP\/1\.1 404/);
	assert.match(unknownPairPath.text, /unknown_path/);

	const wrongMethod = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: pairRequestText({ label: "A-phone", method: "GET" }),
	});
	assert.match(wrongMethod.text, /^HTTP\/1\.1 405/);
	assert.match(wrongMethod.text, /method_not_allowed/);

	const queryPath = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: pairRequestText({ label: "A-phone", path: "/pair?x=1" }),
	});
	assert.match(queryPath.text, /^HTTP\/1\.1 404/);

	const invalidLabel = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: pairRequestText({ label: "x".repeat(65) }),
	});
	assert.match(invalidLabel.text, /^HTTP\/1\.1 400/);
	assert.match(invalidLabel.text, /invalid_label/);

	const otherIdentity = await newIdentity("A-phone");
	const claimMismatch = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: pairRequestText({ label: "A-phone", claimKey: otherIdentity.key }),
	});
	assert.match(claimMismatch.text, /^HTTP\/1\.1 400/);
	assert.match(claimMismatch.text, /claim_mismatch/);

	const withBody = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request:
			"POST /pair HTTP/1.1\r\nHost: peer.invalid\r\nx-peer-label: A-phone\r\ncontent-length: 3\r\n\r\nabc",
	});
	assert.match(withBody.text, /^HTTP\/1\.1 400/);
	assert.match(withBody.text, /unexpected_body/);

	const oversizedHeader = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: pairRequestText({ label: "A-phone", extraHeaders: `x-large: ${"a".repeat(6000)}\r\n` }),
	});
	assert.match(oversizedHeader.text, /^HTTP\/1\.1 431/);
	assert.match(oversizedHeader.text, /header_too_large/);

	const tooManyHeaders = "A-phone";
	const manyHeaders = Array.from({ length: 25 }, (_, index) => `x-h${index}: v\r\n`).join("");
	const headerCount = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: pairRequestText({ label: tooManyHeaders, extraHeaders: manyHeaders }),
	});
	assert.match(headerCount.text, /^HTTP\/1\.1 431/);

	const plainAppGet = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: "GET /app HTTP/1.1\r\nHost: peer.invalid\r\n\r\n",
	});
	assert.match(plainAppGet.text, /^HTTP\/1\.1 404/);

	const unknownUpgradePath = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: upgradeRequestText({ path: "/nope" }),
	});
	assert.match(unknownUpgradePath.text, /^HTTP\/1\.1 404/);

	const badProtocol = await rawTlsExchange({
		port,
		identity: clientIdentity,
		request: upgradeRequestText({ protocol: "evil-proto" }),
	});
	assert.match(badProtocol.text, /^HTTP\/1\.1 400/);
	assert.match(badProtocol.text, /unsupported_subprotocol/);

	const noCertificate = await rawTlsExchange({
		port,
		request: upgradeRequestText(),
	});
	assert.match(noCertificate.text, /^HTTP\/1\.1 401/);
	assert.match(noCertificate.text, /no_client_certificate/);

	const noCertificatePair = await rawTlsExchange({
		port,
		request: pairRequestText({ label: "no-cert" }),
	});
	assert.match(noCertificatePair.text, /^HTTP\/1\.1 401/);

	const stranger = await newIdentity("stranger");
	const messagesBefore = channels.length;
	const pipelined = await rawTlsExchange({
		port,
		identity: stranger,
		request: upgradeRequestText(),
		payloadAfterRequest: maskedTextFrame("pipelined-payload"),
	});
	assert.match(pipelined.text, /^HTTP\/1\.1 403/);
	assert.equal(host.stats.appChannelsOpened, appChannelsBefore);
	assert.equal(channels.length, messagesBefore);
	assert.equal(host.activeChannelCount, 0);
	assert.ok(host.stats.appGateDenied >= 1);
	assert.equal(host.pendingPairingCount, 0);
});

test("oversized WebSocket messages close before the application handler", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	let hostMessages = 0;
	const hostClosed = deferred<PeerDiagnostic>();
	const { host, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { maxWebSocketMessageBytes: 64 },
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: (channel) => {
			channel.onMessage(() => {
				hostMessages++;
			});
		},
		onDiagnostic: (event) => {
			if (event.code === "app_channel_closed") hostClosed.resolve(event);
		},
	});
	const client = startClient(t, clientIdentity);
	await pairClient(client.client, port);

	const channel = await client.client.connectApp({
		port,
		approveServerKey: () => {
			throw new Error("remembered");
		},
	});
	await channel.send(Buffer.alloc(128)).catch(() => {
		// The peer may close before the local write callback completes.
	});
	const closed = await withTimeout(channel.closed, 3000, "oversized message did not close the channel");
	assert.equal(closed.code, 1009);
	await withTimeout(hostClosed.promise, 3000, "host did not finalize the rejected channel");
	assert.equal(hostMessages, 0, "oversized payload never reached the application handler");
	assert.equal(host.activeChannelCount, 0);
});

test("outbound queue bounds are deterministic and distinguish queueing from delivery", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const hostChannel = deferred<PeerAppChannel>();
	const { host, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { maxOutboundQueueBytes: 32, maxWebSocketMessageBytes: 1024 },
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: (channel) => hostChannel.resolve(channel),
	});
	const client = startClient(t, clientIdentity, { bounds: { maxOutboundQueueBytes: 32 } });
	await pairClient(client.client, port);
	const channel = await client.client.connectApp({
		port,
		approveServerKey: () => {
			throw new Error("remembered");
		},
	});
	const serverSide = await hostChannel.promise;

	await assert.rejects(
		serverSide.send(Buffer.alloc(64)),
		(error: unknown) => isPeerTransportError(error) && error.code === "OUTBOUND_QUEUE_FULL",
	);
	await assert.rejects(
		channel.send(Buffer.alloc(64)),
		(error: unknown) => isPeerTransportError(error) && error.code === "OUTBOUND_QUEUE_FULL",
	);

	const received = deferred<Buffer>();
	channel.onMessage((bytes) => received.resolve(bytes));
	await serverSide.send(Buffer.from("four"));
	assert.equal((await withTimeout(received.promise, 2000, "bounded send")).toString(), "four");
	assert.ok(serverSide.bufferedAmount >= 0);
	await channel.close();
});

test("client operation and consent reservations bound pending approvals", async (t) => {
	const probe = await startTlsProbe(t);
	const identity = await newIdentity("A-phone");

	const operationClient = startClient(t, identity, {
		bounds: { maxClientOperations: 1, maxPendingConsents: 2, consentTimeoutMs: 400 },
	});
	const prompt = deferred<void>();
	const decision = deferred<"cancel">();
	const first = operationClient.client.pair({
		port: probe.port,
		approveServerKey: () => {
			prompt.resolve();
			return decision.promise;
		},
	});
	await withTimeout(prompt.promise, 2000, "first consent did not start");
	assert.equal(operationClient.client.activeOperationCount, 1);
	assert.equal(operationClient.client.pendingConsentCount, 1);
	await assert.rejects(
		operationClient.client.pair({ port: probe.port, approveServerKey: () => "accept" }),
		(error: unknown) => isPeerTransportError(error) && error.code === "CLIENT_LIMIT_REACHED",
	);
	assert.equal(operationClient.client.activeOperationCount, 1, "rejected operation reserved nothing");
	decision.resolve("cancel");
	await assert.rejects(
		first,
		(error: unknown) => isPeerTransportError(error) && error.code === "PEER_KEY_CANCELLED",
	);
	assert.equal(operationClient.client.activeOperationCount, 0);
	assert.equal(operationClient.client.pendingConsentCount, 0);

	const consentClient = startClient(t, identity, {
		bounds: { maxClientOperations: 2, maxPendingConsents: 1, consentTimeoutMs: 400 },
	});
	const consentPrompt = deferred<void>();
	const consentDecision = deferred<"cancel">();
	const consentFirst = consentClient.client.pair({
		port: probe.port,
		approveServerKey: () => {
			consentPrompt.resolve();
			return consentDecision.promise;
		},
	});
	await withTimeout(consentPrompt.promise, 2000, "consent slot was not occupied");
	assert.equal(consentClient.client.pendingConsentCount, 1);
	await assert.rejects(
		consentClient.client.connectApp({ port: probe.port, approveServerKey: () => "accept" }),
		(error: unknown) => isPeerTransportError(error) && error.code === "CONSENT_LIMIT_REACHED",
	);
	assert.equal(consentClient.client.pendingConsentCount, 1);
	assert.equal(consentClient.client.activeOperationCount, 1, "failed application attempt released its slot");
	consentDecision.resolve("cancel");
	await assert.rejects(
		consentFirst,
		(error: unknown) => isPeerTransportError(error) && error.code === "PEER_KEY_CANCELLED",
	);
	assert.equal(consentClient.client.activeOperationCount, 0);
	assert.equal(consentClient.client.pendingConsentCount, 0);
});

test("client operation slots bound active application channels", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const { host, port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: echoHost([]),
	});
	const client = startClient(t, clientIdentity, { bounds: { maxClientOperations: 2 } });
	await pairClient(client.client, port);
	const openApp = (): Promise<PeerAppChannel> =>
		client.client.connectApp({
			port,
			approveServerKey: () => {
				throw new Error("remembered");
			},
		});
	const first = await openApp();
	const second = await openApp();
	assert.equal(client.client.activeOperationCount, 2);
	await assert.rejects(
		openApp(),
		(error: unknown) => isPeerTransportError(error) && error.code === "CLIENT_LIMIT_REACHED",
	);
	await first.close();
	assert.equal(client.client.activeOperationCount, 1);
	const third = await openApp();
	assert.equal(client.client.activeOperationCount, 2);
	await second.close();
	await third.close();
	assert.equal(client.client.activeOperationCount, 0);
});

test("automatic pong writes are disabled and control responses stay within the outbound bound", async () => {
	const identity = await newIdentity("A-phone");
	const bounds = resolvePeerTransportBounds({ maxOutboundQueueBytes: 64, closeTimeoutMs: 100 });
	const makeChannel = (fake: FakeControlSocket): PeerAppChannel =>
		createPeerByteChannel({
			ws: fake as unknown as InstanceType<typeof WebSocket>,
			peerKey: identity.key,
			label: null,
			bounds,
			isServer: true,
			onFinalized: () => undefined,
			diagnostic: () => undefined,
		});

	const normal = new FakeControlSocket();
	const normalChannel = makeChannel(normal);
	normal.emit("ping", Buffer.alloc(10));
	assert.equal(normal.pongCalls, 1, "a ping gets one bounded explicit pong");
	assert.equal(normal.terminateCalls, 0);
	assert.ok(normalChannel);

	const overflow = new FakeControlSocket();
	overflow.bufferedAmount = 64;
	const overflowChannel = makeChannel(overflow);
	overflow.emit("ping", Buffer.alloc(10));
	assert.equal(overflow.pongCalls, 0);
	assert.equal(overflow.terminateCalls, 1);
	const overflowClose = await overflowChannel.closed;
	assert.equal(overflowClose.code, 1006);

	const sameTick = new FakeControlSocket();
	sameTick.withholdPongCallbacks = true;
	const sameTickChannel = makeChannel(sameTick);
	sameTick.emit("ping", Buffer.alloc(10));
	sameTick.emit("ping", Buffer.alloc(10));
	assert.equal(sameTick.pongCalls, 1);
	assert.equal(sameTick.terminateCalls, 1, "in-flight control overhead counts toward the bound");
	const sameTickClose = await sameTickChannel.closed;
	assert.equal(sameTickClose.code, 1006);
});

test("configured close deadline finalizes protocol-error channels without a peer close reply", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	let hostChannels = 0;
	let closedCount = 0;
	const firstClosed = deferred<void>();
	const secondClosed = deferred<void>();
	const { host, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { maxWebSocketMessageBytes: 64, closeTimeoutMs: 100 },
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: () => {
			hostChannels++;
		},
		onDiagnostic: (event) => {
			if (event.code !== "app_channel_closed") return;
			closedCount++;
			if (closedCount === 1) firstClosed.resolve();
			else if (closedCount === 2) secondClosed.resolve();
		},
	});
	const client = startClient(t, clientIdentity);
	await pairClient(client.client, port);

	const oversized = await openRawWebSocket({ port, identity: clientIdentity });
	assert.match(oversized.responseHead, /^HTTP\/1\.1 101/);
	const oversizedStarted = Date.now();
	oversized.socket.write(maskedBinaryFrame(Buffer.alloc(128)));
	await withTimeout(firstClosed.promise, 2000, "oversized protocol error did not finalize");
	assert.ok(Date.now() - oversizedStarted < 1500, "channel retained its slot past the configured close deadline");
	assert.equal(host.activeChannelCount, 0);
	oversized.socket.destroy();

	const unsupported = await openRawWebSocket({ port, identity: clientIdentity });
	assert.match(unsupported.responseHead, /^HTTP\/1\.1 101/);
	unsupported.socket.write(maskedTextFrame("unsupported"));
	await withTimeout(secondClosed.promise, 2000, "unsupported-data protocol error did not finalize");
	assert.equal(host.activeChannelCount, 0);
	assert.equal(hostChannels, 2);
	unsupported.socket.destroy();
});

test("resumed TLS sessions and absent client certificates are refused", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const resumptionRejected = deferred<PeerDiagnostic>();
	const { host, port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: echoHost([]),
		onDiagnostic: (event) => {
			if (event.code === "host_resumption_rejected") resumptionRejected.resolve(event);
		},
	});
	const client = startClient(t, clientIdentity);
	await pairClient(client.client, port);
	const requestsBefore = host.stats.pairingRequests;
	const upgradesBefore = host.stats.upgrades;

	const first = tls.connect({
		host: "127.0.0.1",
		port,
		cert: clientIdentity.certificatePem,
		key: clientIdentity.privateKeyPem,
		rejectUnauthorized: false,
		maxVersion: "TLSv1.2",
	});
	first.on("error", () => {
		// Deliberately disposable session seed.
	});
	await new Promise<void>((resolve, reject) => {
		first.once("secureConnect", resolve);
		first.once("error", reject);
	});
	const session = first.getSession() ?? Buffer.alloc(0);
	assert.ok(session.length > 0);
	first.destroy();
	await new Promise<void>((resolve) => first.once("close", resolve));

	const resumed = tls.connect({
		host: "127.0.0.1",
		port,
		cert: clientIdentity.certificatePem,
		key: clientIdentity.privateKeyPem,
		rejectUnauthorized: false,
		maxVersion: "TLSv1.2",
		session,
	});
	resumed.on("error", () => {
		// The host destroys the resumed session deliberately.
	});
	await new Promise<void>((resolve) => {
		resumed.once("secureConnect", resolve);
		resumed.once("error", resolve);
		resumed.once("close", resolve);
	});
	await withTimeout(resumptionRejected.promise, 2000, "host did not reject the resumed session");
	resumed.destroy();
	assert.equal(host.stats.resumptionsRejected, 1);
	assert.equal(host.stats.pairingRequests, requestsBefore, "no HTTP request on a resumed session");
	assert.equal(host.stats.upgrades, upgradesBefore, "no upgrade on a resumed session");

	const missingPair = await rawTlsExchange({
		port,
		request: pairRequestText({ label: "no-cert" }),
	});
	assert.match(missingPair.text, /^HTTP\/1\.1 401/);
	const missingApp = await rawTlsExchange({
		port,
		request: upgradeRequestText(),
	});
	assert.match(missingApp.text, /^HTTP\/1\.1 401/);

	// A normal reconnect after the resumption probe is still a full handshake.
	const normal = await client.client.connectApp({
		port,
		approveServerKey: () => {
			throw new Error("remembered");
		},
	});
	assert.equal(host.stats.resumptionsRejected, 1);
	await normal.close();
});

test("teardown destroys raw TCP, pending consent, and upgraded channels with positive settlement", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const pairing = deferred<PeerPairingRequest>();
	let pairingCount = 0;
	const channels: PeerAppChannel[] = [];
	const { host, port } = await startHost(t, {
		identity: hostIdentity,
		bounds: { consentTimeoutMs: 5000 },
		onPairingRequest: (request) => {
			pairingCount++;
			if (pairingCount === 1) request.approve();
			else pairing.resolve(request);
		},
		onAppChannel: echoHost(channels),
	});
	const client = startClient(t, clientIdentity);
	await pairClient(client.client, port);
	const channel = await client.client.connectApp({
		port,
		approveServerKey: () => {
			throw new Error("remembered");
		},
	});
	const hostChannel = channels[0];
	assert.ok(hostChannel);

	const pendingClient = startClient(t, await newIdentity("C-pending"));
	const pendingPair = pendingClient.client.pair({
		port,
		approveServerKey: () => "accept",
	});
	const pendingRequest = await withTimeout(pairing.promise, 2000, "pending consent was not observed");
	assert.equal(pendingRequest.isPending(), true);
	assert.equal(host.pendingPairingCount, 1);

	const rawSocket = net.connect({ host: "127.0.0.1", port });
	rawSocket.on("error", () => {
		// Destroyed by teardown.
	});
	await new Promise<void>((resolve, reject) => {
		rawSocket.once("connect", resolve);
		rawSocket.once("error", reject);
	});
	const rawClosed = new Promise<void>((resolve) => rawSocket.once("close", resolve));
	const channelClosed = withTimeout(channel.closed, 3000, "client channel did not close");
	pendingPair.catch(() => {
		// Expected refusal during teardown.
	});

	const firstClose = host.close();
	const secondClose = host.close();
	assert.equal(firstClose, secondClose, "repeated close returns the same settlement");
	assert.equal(pendingRequest.approve(), false, "approval after synchronous local close is refused");
	const started = Date.now();
	await withTimeout(firstClose, 3000, "host close was not bounded");
	assert.ok(Date.now() - started < 3000);
	await withTimeout(rawClosed, 2000, "raw pre-handshake socket was not closed");
	await channelClosed;
	assert.equal(host.pendingPairingCount, 0);
	assert.equal(host.activeChannelCount, 0);
	assert.equal(host.listening, false);
	assert.equal(host.port, null);
	await assertRefused(port);
	assert.equal(pendingRequest.isPending(), false);
	await pendingPair.catch(() => undefined);
	await host.close();
});

test("close coordinates with an in-flight listen and leaves no late listener", async (t) => {
	const identity = await newIdentity("B-laptop");
	const reservation = net.createServer();
	const reservedPort = await new Promise<number>((resolve, reject) => {
		reservation.once("error", reject);
		reservation.listen(0, "127.0.0.1", () => {
			const address = reservation.address();
			if (!address || typeof address === "string") reject(new Error("reservation did not bind a TCP port"));
			else resolve(address.port);
		});
	});
	await new Promise<void>((resolve) => reservation.close(() => resolve()));

	const host = createPeerHost({
		identity,
		acceptedPeers: createInMemoryAcceptedPeerStore(),
		grants: createInMemoryDirectionalGrantStore(),
	});
	const listenPromise = host.listen({ host: "127.0.0.1", port: reservedPort });
	const closePromise = host.close();
	await assert.rejects(
		listenPromise,
		(error: unknown) => isPeerTransportError(error) && error.code === "HOST_CLOSED",
	);
	await withTimeout(closePromise, 3000, "close did not settle with a pending listen");
	assert.equal(host.listening, false);
	assert.equal(host.port, null);
	// No late bind may appear after close reports settlement.
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(host.listening, false);
	await assertRefused(reservedPort);
});

test("client consent cancellation, socket close, and trust changes cannot write bytes or commit trust", async (t) => {
	const probe = await startTlsProbe(t);
	const identity = await newIdentity("A-phone");
	const baseline = probe.stats.decryptedBytes;

	const cancelled = startClient(t, identity);
	await assert.rejects(
		cancelled.client.pair({ port: probe.port, approveServerKey: () => "cancel" }),
		(error: unknown) => isPeerTransportError(error) && error.code === "PEER_KEY_CANCELLED",
	);
	assert.equal(probe.stats.decryptedBytes, baseline);

	const rejected = startClient(t, identity);
	await assert.rejects(
		rejected.client.pair({ port: probe.port, approveServerKey: () => "reject" }),
		(error: unknown) => isPeerTransportError(error) && error.code === "PEER_KEY_REJECTED",
	);
	assert.equal(probe.stats.decryptedBytes, baseline);

	const timedOut = startClient(t, identity, { bounds: { consentTimeoutMs: 50 } });
	await assert.rejects(
		timedOut.client.pair({ port: probe.port, approveServerKey: () => new Promise(() => undefined) }),
		(error: unknown) => isPeerTransportError(error) && error.code === "PEER_KEY_PROMPT_TIMEOUT",
	);
	assert.equal(probe.stats.decryptedBytes, baseline);

	const thrown = startClient(t, identity);
	await assert.rejects(
		thrown.client.pair({
			port: probe.port,
			approveServerKey: () => {
				throw new Error("caller failure");
			},
		}),
		(error: unknown) => isPeerTransportError(error) && error.code === "PEER_KEY_APPROVER_FAILED",
	);
	assert.equal(probe.stats.decryptedBytes, baseline);

	const promptStarted = deferred<void>();
	const decision = deferred<"accept">();
	const socketClosed = startClient(t, identity);
	const socketPair = socketClosed.client.pair({
		port: probe.port,
		approveServerKey: () => {
			promptStarted.resolve();
			return decision.promise;
		},
	});
	await withTimeout(promptStarted.promise, 2000, "consent did not start");
	probe.destroyConnections();
	await assert.rejects(
		socketPair,
		(error: unknown) => isPeerTransportError(error) && error.code === "TLS_CONNECTION_CLOSED",
	);
	decision.resolve("accept");
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(probe.stats.decryptedBytes, baseline);
	assert.equal(socketClosed.remembered.read(), null);

	// Destroyed-before-close on the client: dispose destroys the pending socket
	// synchronously and a late acceptance must not hand it to HTTP or commit trust.
	const disposed = startClient(t, identity);
	const disposePrompt = deferred<void>();
	const disposeDecision = deferred<"accept">();
	const disposePair = disposed.client.pair({
		port: probe.port,
		approveServerKey: () => {
			disposePrompt.resolve();
			return disposeDecision.promise;
		},
	});
	await withTimeout(disposePrompt.promise, 2000, "dispose consent did not start");
	disposed.client.dispose();
	disposeDecision.resolve("accept");
	await assert.rejects(
		disposePair,
		(error: unknown) =>
			isPeerTransportError(error) &&
			(error.code === "TLS_CONNECTION_CLOSED" || error.code === "HOST_CLOSED"),
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(probe.stats.decryptedBytes, baseline);
	assert.equal(disposed.remembered.read(), null);

	const trustChanged = startClient(t, identity);
	const trustPrompt = deferred<void>();
	const trustDecision = deferred<"accept">();
	const otherIdentity = await newIdentity("other");
	const trustPair = trustChanged.client.pair({
		port: probe.port,
		approveServerKey: () => {
			trustPrompt.resolve();
			return trustDecision.promise;
		},
	});
	await withTimeout(trustPrompt.promise, 2000, "trust-change consent did not start");
	trustChanged.remembered.write(otherIdentity.key);
	trustDecision.resolve("accept");
	await assert.rejects(
		trustPair,
		(error: unknown) => isPeerTransportError(error) && error.code === "PEER_KEY_CHANGED",
	);
	assert.equal(probe.stats.decryptedBytes, baseline);
	const unchanged = trustChanged.remembered.read();
	assert.ok(unchanged && peerKeysEqual(unchanged, otherIdentity.key), "the adapter does not overwrite local trust");
});

test("caller exceptions and injected store failures fail closed", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");

	const throwingPairingHost = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: () => {
			throw new Error("pairing handler failure");
		},
	});
	const pairingClient = startClient(t, clientIdentity);
	const denied = await pairingClient.client.pair({
		port: throwingPairingHost.port,
		approveServerKey: () => "accept",
	});
	assert.equal(denied.ok, false);
	assert.equal(denied.status, "denied");
	assert.equal(denied.httpStatus, 403);
	assert.equal(
		throwingPairingHost.acceptedPeers.get(clientIdentity.key.keyId),
		undefined,
	);

	const throwingAppHost = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: () => {
			throw new Error("app handler failure");
		},
	});
	const appClient = startClient(t, clientIdentity);
	await pairClient(appClient.client, throwingAppHost.port);
	const appChannel = await appClient.client.connectApp({
		port: throwingAppHost.port,
		approveServerKey: () => {
			throw new Error("remembered");
		},
	});
	const appClosed = await withTimeout(appChannel.closed, 3000, "caller exception did not close the channel");
	assert.ok([1000, 1006, 1011].includes(appClosed.code), `unexpected close code ${appClosed.code}`);
	await withTimeout(
		new Promise<void>((resolve) => setImmediate(resolve)),
		1000,
		"host channel did not settle",
	);

	const innerAccepted = createInMemoryAcceptedPeerStore();
	let failReads = false;
	const guardedAccepted: AcceptedPeerStore = {
		get(keyId) {
			if (failReads) throw new Error("store read failure");
			return innerAccepted.get(keyId);
		},
		set(record) {
			innerAccepted.set(record);
		},
		delete(keyId) {
			return innerAccepted.delete(keyId);
		},
	};
	const guardedHost = await startHost(t, {
		identity: hostIdentity,
		acceptedPeers: guardedAccepted,
		grants: createInMemoryDirectionalGrantStore(),
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: echoHost([]),
	});
	const guardedClient = startClient(t, clientIdentity);
	await pairClient(guardedClient.client, guardedHost.port);
	failReads = true;
	await assert.rejects(
		guardedClient.client.connectApp({
			port: guardedHost.port,
			approveServerKey: () => {
				throw new Error("remembered");
			},
		}),
		(error: unknown) =>
			isPeerTransportError(error) && error.code === "APP_REFUSED" && error.statusCode === 403,
	);
	assert.equal(guardedHost.stats.appChannelsOpened, 0);

	const throwingStore: AcceptedPeerStore = {
		get() {
			return undefined;
		},
		set() {
			throw new Error("store write failure");
		},
		delete() {
			return false;
		},
	};
	const failingHost = await startHost(t, {
		identity: hostIdentity,
		acceptedPeers: throwingStore,
		grants: createInMemoryDirectionalGrantStore(),
		onPairingRequest: (request) => {
			request.approve();
		},
	});
	const failingClient = startClient(t, clientIdentity);
	const failed = await failingClient.client.pair({
		port: failingHost.port,
		approveServerKey: () => "accept",
	});
	assert.equal(failed.ok, false);
	assert.equal(failed.httpStatus, 500);
	assert.equal(failingHost.pendingPairingCount, 0);

	const messageHost = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: echoHost([]),
	});
	const messageClient = startClient(t, await newIdentity("A-message"));
	await pairClient(messageClient.client, messageHost.port);
	const messageChannel = await messageClient.client.connectApp({
		port: messageHost.port,
		approveServerKey: () => {
			throw new Error("remembered");
		},
	});
	messageChannel.onMessage(() => {
		throw new Error("caller message handler failure");
	});
	await messageChannel.send(Buffer.from("trigger")).catch(() => undefined);
	const observedClose = await withTimeout(messageChannel.closed, 3000, "caller message handler did not close");
	assert.equal(observedClose.code, 1011);
});

test("diagnostics contain only fixed sanitized codes and counts", async (t) => {
	const hostIdentity = await newIdentity("B-laptop");
	const clientIdentity = await newIdentity("A-phone");
	const events: PeerDiagnostic[] = [];
	const { port } = await startHost(t, {
		identity: hostIdentity,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: echoHost([]),
		onDiagnostic: (event) => events.push(event),
	});
	const client = startClient(t, clientIdentity, {
		onDiagnostic: (event) => events.push(event),
	});
	await pairClient(client.client, port);
	const channel = await client.client.connectApp({
		port,
		approveServerKey: () => {
			throw new Error("remembered");
		},
	});
	await channel.close();
	assert.ok(events.length > 0);
	const allowed = new Set(["code", "role", "statusCode", "count", "bytes"]);
	for (const event of events) {
		for (const key of Object.keys(event)) assert.ok(allowed.has(key), `unexpected diagnostic field ${key}`);
	}
	const serialized = JSON.stringify(events);
	assert.equal(serialized.includes(clientIdentity.label), false);
	assert.equal(serialized.includes(hostIdentity.label), false);
	assert.equal(serialized.includes(clientIdentity.key.keyId), false);
	assert.equal(serialized.includes(hostIdentity.key.keyId), false);
	assert.equal(serialized.includes("PRIVATE KEY"), false);
	assert.equal(serialized.includes("fixture-secret"), false);
});
