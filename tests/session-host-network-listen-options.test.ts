/**
 * Focused bind-mapping tests for the incoming paired peer transport.
 *
 * These tests observe the exact options the transport hands to the Node TLS
 * listener by intercepting only `https.createServer`: the real Node HTTPS
 * server is still created with the real TLS options, and only that owned,
 * still-unbound server's `listen`/`address` are replaced for the test. No
 * socket is bound, so the suite opens no wildcard listener. A mocked bind
 * proves the forwarded options and the error path; it does not prove that a
 * given operating system actually delivers IPv4 and IPv6 on one dual-stack
 * handle.
 */

import assert from "node:assert/strict";
import https from "node:https";
import test from "node:test";
import {
	createInMemoryAcceptedPeerStore,
	createInMemoryDirectionalGrantStore,
	createPeerHost,
	isPeerTransportError,
	type PeerHost,
} from "../src/session-host/network/index";
import { newIdentity } from "./session-host-network-helpers";

interface NodeListenOptions {
	readonly host?: string;
	readonly port?: number;
	readonly ipv6Only?: boolean;
}

interface HttpsServerCapture {
	readonly tlsOptions: ReadonlyArray<Record<string, unknown>>;
	readonly listenOptions: ReadonlyArray<NodeListenOptions>;
	restore(): void;
}

/**
 * Intercept `https.createServer` for one test. Every intercepted call still
 * creates a real, unbound Node HTTPS server with the caller's exact TLS
 * options; only that owned server's `listen` and `address` are replaced so the
 * test can record the forwarded bind options and settle the bind without any
 * socket. `outcome` decides the mocked bind result.
 */
function captureHttpsListen(outcome: (options: NodeListenOptions) => { port: number } | Error): HttpsServerCapture {
	const mutable = https as unknown as { createServer: (...args: unknown[]) => https.Server };
	const original = mutable.createServer;
	const tlsOptions: Array<Record<string, unknown>> = [];
	const listenOptions: NodeListenOptions[] = [];
	let boundPort: number | null = null;
	mutable.createServer = (...args: unknown[]): https.Server => {
		tlsOptions.push((args[0] ?? {}) as Record<string, unknown>);
		const server = original(...args);
		const owned = server as unknown as {
			listen: (...listenArgs: unknown[]) => https.Server;
			address: () => { address: string; family: string; port: number } | null;
		};
		owned.listen = (...listenArgs: unknown[]): https.Server => {
			const options = { ...((listenArgs[0] ?? {}) as NodeListenOptions) };
			listenOptions.push(options);
			const result = outcome(options);
			// Real binds settle asynchronously; keep the same ordering here.
			queueMicrotask(() => {
				if (result instanceof Error) {
					server.emit("error", result);
					return;
				}
				boundPort = result.port;
				server.emit("listening");
			});
			return server;
		};
		owned.address = () =>
			boundPort === null ? null : { address: "::", family: "IPv6", port: boundPort };
		return server;
	};
	return {
		tlsOptions,
		listenOptions,
		restore() {
			mutable.createServer = original;
		},
	};
}

function createHost(t: { after(fn: () => void | Promise<void>): void }): Promise<PeerHost> {
	return newIdentity("A-laptop").then((identity) => {
		const host = createPeerHost({
			identity,
			acceptedPeers: createInMemoryAcceptedPeerStore(),
			grants: createInMemoryDirectionalGrantStore(),
		});
		t.after(() => host.close());
		return host;
	});
}

test("explicit * requests one IPv6 unspecified dual-stack listener", async (t) => {
	const capture = captureHttpsListen(() => ({ port: 41_001 }));
	t.after(capture.restore);
	const host = await createHost(t);

	const bound = await host.listen({ host: "*", port: 8088 });

	assert.equal(capture.listenOptions.length, 1, "exactly one listener is requested");
	assert.deepEqual(capture.listenOptions[0], { host: "::", port: 8088, ipv6Only: false });
	assert.equal(bound.host, "::");
	assert.equal(bound.port, 41_001);
	assert.equal(host.port, 41_001);
	// The TLS listener contract itself is unchanged by the bind mapping.
	assert.equal(capture.tlsOptions[0]?.requestCert, true);
	assert.equal(capture.tlsOptions[0]?.rejectUnauthorized, false);
	assert.equal(typeof capture.tlsOptions[0]?.key, "string");
	assert.equal(typeof capture.tlsOptions[0]?.cert, "string");
});

test("non-star hosts and port 0 keep their exact bind options", async (t) => {
	let nextPort = 41_100;
	const capture = captureHttpsListen(() => ({ port: nextPort++ }));
	t.after(capture.restore);

	const host = await createHost(t);
	const ipv4Wildcard = await host.listen({ host: "0.0.0.0", port: 8443 });
	assert.deepEqual(capture.listenOptions[0], { host: "0.0.0.0", port: 8443 });
	assert.equal("ipv6Only" in (capture.listenOptions[0] ?? {}), false, "0.0.0.0 stays a plain IPv4 bind");
	assert.equal(ipv4Wildcard.host, "0.0.0.0");
	await host.close();

	const loopback = await createHost(t);
	const loopbackBound = await loopback.listen({ host: "127.0.0.1", port: 0 });
	assert.deepEqual(capture.listenOptions[1], { host: "127.0.0.1", port: 0 });
	assert.equal(loopbackBound.host, "127.0.0.1");
	assert.equal(loopbackBound.port, 41_101, "the bound port still comes from the listener, not the request");
	await loopback.close();

	const ipv6Loopback = await createHost(t);
	const ipv6Bound = await ipv6Loopback.listen({ host: "::1", port: 9000 });
	assert.deepEqual(capture.listenOptions[2], { host: "::1", port: 9000 });
	assert.equal(ipv6Bound.host, "::1");
	await ipv6Loopback.close();

	assert.equal(capture.listenOptions.length, 3);
});

test("invalid hosts and ports are rejected before any Node listen call", async (t) => {
	const capture = captureHttpsListen(() => ({ port: 41_200 }));
	t.after(capture.restore);
	const host = await createHost(t);

	const invalid = [
		{ host: undefined, port: 8088 },
		{ host: "", port: 8088 },
		{ host: "bad host", port: 8088 },
		{ host: "*", port: -1 },
		{ host: "*", port: 65_536 },
		{ host: "*", port: 1.5 },
		{ host: "*", port: "8088" },
	];
	for (const candidate of invalid) {
		await assert.rejects(
			host.listen(candidate as never),
			(error: unknown) => isPeerTransportError(error) && error.code === "INVALID_ARGUMENT",
		);
	}
	assert.equal(capture.listenOptions.length, 0);
	assert.equal(host.port, null);
});

test("a refused dual-stack bind reports the existing bind failure with no fallback", async (t) => {
	const capture = captureHttpsListen(() => new Error("simulated EADDRNOTAVAIL"));
	t.after(capture.restore);
	const host = await createHost(t);

	await assert.rejects(
		host.listen({ host: "*", port: 8088 }),
		(error: unknown) => isPeerTransportError(error) && error.code === "LISTENER_BIND_FAILED",
	);
	assert.deepEqual(capture.listenOptions, [{ host: "::", port: 8088, ipv6Only: false }]);
	assert.equal(host.port, null);
	assert.equal(host.listening, false);

	// The failure settles with no second bind on another address or family.
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(capture.listenOptions.length, 1, "no fallback address or retry is attempted");
	assert.equal(host.port, null);
});
