import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import {
	MAX_SPKI_DER_BYTES,
	createPeerHost,
	generatePeerIdentity,
	isPeerTransportError,
	isWellFormedPeerKey,
	loadOwnedPeerIdentity,
	peerKeyFromCertificate,
	peerKeyFromPeerCertificate,
	peerKeysEqual,
} from "../src/session-host/network/index";
import { newIdentity, startHost, tlsHandshakeOutcome } from "./session-host-network-helpers";

test("importing the inert adapter starts no listener, key generation, or process work", () => {
	const modulePath = path.join(__dirname, "..", "src", "session-host", "network", "index.js");
	const result = spawnSync(
		process.execPath,
		[
			"-e",
			`const m = require(${JSON.stringify(modulePath)});` +
				"process.stdout.write(typeof m.createPeerHost + ':' + typeof m.generatePeerIdentity);",
		],
		{ encoding: "utf8", timeout: 15_000 },
	);
	assert.equal(result.status, 0, `inert import failed: ${result.stderr}`);
	assert.equal(result.stdout.trim(), "function:function");

	assert.throws(
		() => createPeerHost({} as never),
		(error: unknown) => isPeerTransportError(error) && error.code === "INVALID_ARGUMENT",
	);
});

test("generated identity exposes one canonical exact key and a display-only digest", async () => {
	const identity = await newIdentity("A-phone");
	const spki = Buffer.from(identity.key.keyId, "base64");
	assert.ok(spki.length > 0 && spki.length <= MAX_SPKI_DER_BYTES);
	assert.equal(identity.key.fingerprint, createHash("sha256").update(spki).digest("base64url"));
	assert.ok(isWellFormedPeerKey(identity.key));
	assert.equal(identity.keyType, "ECDSA-P256");
	assert.ok(identity.notAfter.getTime() > identity.notBefore.getTime());

	const fromPem = peerKeyFromCertificate(identity.certificatePem);
	const fromDer = peerKeyFromCertificate(identity.certificateDer);
	const fromPeerCertificate = peerKeyFromPeerCertificate({ raw: identity.certificateDer });
	assert.ok(peerKeysEqual(identity.key, fromPem));
	assert.ok(peerKeysEqual(identity.key, fromDer));
	assert.ok(peerKeysEqual(identity.key, fromPeerCertificate));

	const reloaded = loadOwnedPeerIdentity({
		label: identity.label,
		certificatePem: identity.certificatePem,
		privateKeyPem: identity.privateKeyPem,
	});
	assert.ok(peerKeysEqual(identity.key, reloaded.key));
	assert.equal(reloaded.certificateDer.toString("base64"), identity.certificateDer.toString("base64"));

	assert.equal(
		isWellFormedPeerKey({ ...identity.key, fingerprint: "A".repeat(43) }),
		false,
		"a tampered display digest is not a well-formed identity",
	);
});

test("labels are never identity: same label with different keys stays distinct", async () => {
	const first = await newIdentity("A-phone");
	const second = await newIdentity("A-phone");
	assert.equal(first.label, second.label);
	assert.notEqual(first.key.keyId, second.key.keyId);
	assert.notEqual(first.key.fingerprint, second.key.fingerprint);
	assert.equal(peerKeysEqual(first.key, second.key), false);
});

test("certificate and private-key mismatch is refused and TLS cannot present that identity", async (t) => {
	const first = await newIdentity("A-phone");
	const second = await newIdentity("B-laptop");
	assert.throws(
		() =>
			loadOwnedPeerIdentity({
				label: first.label,
				certificatePem: first.certificatePem,
				privateKeyPem: second.privateKeyPem,
			}),
		(error: unknown) => isPeerTransportError(error) && error.code === "IDENTITY_KEY_MISMATCH",
	);
	assert.throws(
		() =>
			loadOwnedPeerIdentity({
				label: first.label,
				certificatePem: "not a certificate",
				privateKeyPem: first.privateKeyPem,
			}),
		(error: unknown) => isPeerTransportError(error) && error.code === "IDENTITY_ENCODING_INVALID",
	);

	const { host, port } = await startHost(t, {
		identity: first,
		onPairingRequest: () => {
			// Never reached by a failed handshake.
		},
	});
	const outcome = await tlsHandshakeOutcome({
		port,
		certificatePem: first.certificatePem,
		privateKeyPem: second.privateKeyPem,
	});
	assert.equal(outcome.ok, false);
	assert.match(outcome.errorCode ?? "", /KEY|MISMATCH|PRIVATE/i);
	assert.equal(host.stats.pairingRequests, 0);
	assert.equal(host.stats.tlsConnections, 0);
});

test("generation is explicit and bounded; import never creates keys", async () => {
	await assert.rejects(
		generatePeerIdentity("bad\nlabel"),
		(error: unknown) => isPeerTransportError(error) && error.code === "INVALID_ARGUMENT",
	);
	await assert.rejects(
		generatePeerIdentity("A-phone", {
			notBefore: new Date("2025-01-01T00:00:00Z"),
			notAfter: new Date("2024-01-01T00:00:00Z"),
		}),
		(error: unknown) => isPeerTransportError(error) && error.code === "INVALID_ARGUMENT",
	);
});
