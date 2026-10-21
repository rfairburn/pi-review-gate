/**
 * Focused tests for the protected peer state store (issue #480).
 *
 * Everything here is a synthetic, positively owned temporary fixture. The
 * permission policy is the real POSIX test policy from the shared fixtures; no
 * product state, real account key, public listener, or live configuration is
 * touched. Windows ACL protection is out of scope for this file and is never
 * claimed by it.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
	generatePeerIdentity,
	isPeerTransportError,
	createInMemoryRememberedPeerKeyStore,
	type AcceptedPeerRecord,
	type DirectionalGrantRecord,
	type OwnedPeerIdentity,
	type PeerKey,
} from "../src/session-host/network/index";
import {
	MAX_ACCEPTED_PEER_RECORDS,
	MAX_DIRECTIONAL_GRANT_RECORDS,
	MAX_PEER_STATE_FILE_BYTES,
	MAX_REMEMBERED_PEER_SLOTS,
	PEER_STATE_STORE_VERSION,
	openPeerStateStoreWithPermissions,
	type PeerStateStore,
} from "../src/session-host/network/peer-state-store";
import {
	createAgentDirFixture,
	createPosixTestPolicy,
	type AgentDirFixture,
	type PeerStateTestPolicy,
} from "./session-host-network-peer-state-fixtures";
import { startClient, startHost } from "./session-host-network-helpers";

/** This file's POSIX policy is real for POSIX fixtures; it proves nothing on Windows. */
const posix = process.platform !== "win32";

const FIXED_TRUST_MESSAGE = "injected peer trust store failed";

function assertFixedTrustError(fn: () => unknown, message: string): void {
	assert.throws(fn, (error: unknown) => {
		assert.ok(isPeerTransportError(error), `${message}: fixed peer error`);
		assert.equal((error as { code?: string }).code, "TRUST_STORE_FAILED", message);
		assert.equal((error as Error).message, FIXED_TRUST_MESSAGE, `${message}: fixed safe message`);
		assert.ok(!/PRIVATE KEY|BEGIN CERTIFICATE|state\.json|session-host/.test((error as Error).message), message);
		return true;
	}, message);
}

async function assertFixedTrustRejection(promise: Promise<unknown>, message: string): Promise<void> {
	await assert.rejects(promise, (error: unknown) => {
		assert.ok(isPeerTransportError(error), `${message}: fixed peer error`);
		assert.equal((error as { code?: string }).code, "TRUST_STORE_FAILED", message);
		assert.equal((error as Error).message, FIXED_TRUST_MESSAGE, `${message}: fixed safe message`);
		return true;
	}, message);
}

function openStore(
	t: TestContext,
	agentDir: string,
	permissions: PeerStateTestPolicy = createPosixTestPolicy(),
): PeerStateStore {
	const store = openPeerStateStoreWithPermissions({ agentDir, permissions });
	t.after(() => store.close());
	return store;
}

function acceptedFor(peer: OwnedPeerIdentity, receiver: OwnedPeerIdentity, at = 1_700_000_000_000): AcceptedPeerRecord {
	return { key: peer.key, label: peer.label, acceptedAt: at, receiverKeyId: receiver.key.keyId };
}

function grantFor(peer: OwnedPeerIdentity, receiver: OwnedPeerIdentity, at = 1_700_000_000_001): DirectionalGrantRecord {
	return {
		peerKeyId: peer.key.keyId,
		direction: "peer->host",
		capability: "app",
		grantedAt: at,
		receiverKeyId: receiver.key.keyId,
	};
}

/** Well-formed exact-key records for count bounds; not real peer identities. */
function boundedSyntheticPeerKey(seed: number): PeerKey {
	const spki = Buffer.alloc(64, 0x11);
	spki.writeUInt32BE(seed, 0);
	return { keyId: spki.toString("base64"), fingerprint: createHash("sha256").update(spki).digest("base64url") };
}

function readDocument(fixture: AgentDirFixture): Record<string, unknown> {
	return JSON.parse(readFileSync(fixture.statePath, "utf8")) as Record<string, unknown>;
}

function writeDocument(fixture: AgentDirFixture, document: unknown): void {
	if (Buffer.isBuffer(document)) writeFileSync(fixture.statePath, document);
	else writeFileSync(fixture.statePath, typeof document === "string" ? document : `${JSON.stringify(document)}\n`);
	chmodSync(fixture.statePath, 0o600);
}

function stateBytes(fixture: AgentDirFixture): Buffer {
	return readFileSync(fixture.statePath);
}

function peerDirEntries(fixture: AgentDirFixture): string[] {
	return readdirSync(fixture.peersDir).sort();
}

function modeOf(path: string): number {
	return lstatSync(path).mode & 0o777;
}

test("identity, accepted peers, grants and pinned keys survive reconstruction and a fresh process", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const initialIdentity = store.identity;
	assert.equal(initialIdentity, null, "a fresh directory is uninitialized, never a generated identity");
	const identity = await store.initializeIdentity("B-laptop");
	assert.equal(store.identity?.key.keyId, identity.key.keyId);

	const peerA = await generatePeerIdentity("A-phone");
	const peerC = await generatePeerIdentity("C-tablet");
	const acceptedAt = 1_700_000_000_000;
	const grantedAt = 1_700_000_000_500;
	store.acceptedPeers.set(acceptedFor(peerA, identity, acceptedAt));
	store.grants.set(grantFor(peerA, identity, grantedAt));
	store.rememberedFor("peer-C").write(peerC.key);

	assert.deepEqual(peerDirEntries(fixture), ["state.json"], "one document, no stray temporary");
	assert.equal(modeOf(fixture.peersDir), 0o700);
	assert.equal(modeOf(fixture.statePath), 0o600);
	const storedIdentity = readDocument(fixture).identity as Record<string, string>;
	assert.equal(storedIdentity.privateKeyPem, identity.privateKeyPem, "the owned identity material is persisted");
	assert.equal(storedIdentity.certificatePem, identity.certificatePem);
	store.close();

	const reopened = openStore(t, fixture.agentDir);
	assert.equal(reopened.identity?.key.keyId, identity.key.keyId, "same receiving SPKI");
	assert.equal(reopened.identity?.certificatePem, identity.certificatePem);
	assert.equal(reopened.acceptedPeers.get(peerA.key.keyId)?.label, "A-phone");
	assert.equal(reopened.acceptedPeers.get(peerA.key.keyId)?.acceptedAt, acceptedAt);
	assert.equal(reopened.acceptedPeers.get(peerA.key.keyId)?.receiverKeyId, identity.key.keyId);
	assert.equal(reopened.grants.get(peerA.key.keyId)?.grantedAt, grantedAt);
	assert.equal(reopened.grants.get(peerA.key.keyId)?.direction, "peer->host");
	assert.equal(reopened.rememberedFor("peer-C").read()?.keyId, peerC.key.keyId);
	assert.equal(reopened.rememberedFor("never-pinned").read(), null);
	reopened.close();

	// A genuinely separate Node process re-reads the same directory: no process cache
	// can account for these observations.
	const childPath = join(__dirname, "session-host-network-peer-state-reopen-child.js");
	const output = execFileSync(
		process.execPath,
		[childPath, fixture.agentDir, JSON.stringify({
			accepted: [peerA.key.keyId],
			grants: [peerA.key.keyId],
			targets: ["peer-C", "never-pinned"],
		})],
		{ encoding: "utf8", timeout: 120_000 },
	);
	const lines = output.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
	const probe = lines[0] as {
		label: string;
		keyId: string;
		certificateDerBytes: number;
		accepted: Array<Record<string, unknown>>;
		grants: Array<Record<string, unknown>>;
		remembered: Record<string, { keyId: string } | null>;
	};
	const modes = lines[1] as { agentDirMode: number; peersDirMode: number; stateFileMode: number };
	assert.equal(probe.label, "B-laptop");
	assert.equal(probe.keyId, identity.key.keyId);
	assert.equal(probe.certificateDerBytes, identity.certificateDer.length);
	assert.deepEqual(probe.accepted, [{
		keyId: peerA.key.keyId,
		present: true,
		label: "A-phone",
		acceptedAt,
		receiver: identity.key.keyId,
	}]);
	assert.deepEqual(probe.grants, [{
		peerKeyId: peerA.key.keyId,
		present: true,
		direction: "peer->host",
		capability: "app",
		grantedAt,
		receiver: identity.key.keyId,
	}]);
	assert.equal(probe.remembered["peer-C"]?.keyId, peerC.key.keyId);
	assert.equal(probe.remembered["never-pinned"], null);
	assert.equal(modes.peersDirMode, 0o700);
	assert.equal(modes.stateFileMode, 0o600);
});

test("observations are immutable defensive projections", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const identity = await store.initializeIdentity("owned");
	const peer = await generatePeerIdentity("peer");
	store.acceptedPeers.set(acceptedFor(peer, identity));
	store.grants.set(grantFor(peer, identity));
	store.rememberedFor("slot").write(peer.key);

	const record = store.acceptedPeers.get(peer.key.keyId);
	assert.ok(record !== undefined);
	assert.ok(Object.isFrozen(record));
	assert.ok(Object.isFrozen(record.key));
	assert.throws(() => {
		(record as unknown as { label: string }).label = "labels-are-not-authority";
	}, TypeError);

	const projected = store.identity;
	assert.ok(projected !== null);
	assert.ok(Object.isFrozen(projected) && Object.isFrozen(projected.key));
	const originalNotBefore = projected.notBefore.getTime();
	projected.certificateDer[0] ^= 0xff;
	projected.notBefore.setTime(0);
	assert.throws(() => {
		(projected.key as unknown as { keyId: string }).keyId = "mutated";
	}, TypeError);
	const fresh = store.identity;
	assert.ok(fresh !== null);
	assert.notEqual(fresh.certificateDer[0], projected.certificateDer[0], "certificate bytes are copied per observation");
	assert.equal(fresh.notBefore.getTime(), originalNotBefore, "validity dates are copied per observation");
	assert.equal(fresh.key.keyId, identity.key.keyId, "the canonical key is never mutated through a projection");

	const pin = store.rememberedFor("slot").read();
	assert.ok(pin !== null && Object.isFrozen(pin));
	assert.throws(() => {
		(pin as unknown as { keyId: string }).keyId = "other";
	}, TypeError);
	const grant = store.grants.get(peer.key.keyId);
	assert.ok(grant !== undefined && Object.isFrozen(grant));
});

test("remembered pins are per target: clearing B leaves C, identity and inbound facts alone", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const identity = await store.initializeIdentity("hub");
	const peerA = await generatePeerIdentity("A-phone");
	const peerB = await generatePeerIdentity("B-laptop");
	const peerC = await generatePeerIdentity("C-tablet");
	store.acceptedPeers.set(acceptedFor(peerA, identity));
	store.grants.set(grantFor(peerA, identity));
	store.rememberedFor("host-B").write(peerB.key);
	store.rememberedFor("host-C").write(peerC.key);
	// Slot ids are opaque data, never property keys or paths: prototype-looking
	// names stay ordinary independent slots.
	store.rememberedFor("__proto__").write(peerB.key);
	store.rememberedFor("constructor").write(peerC.key);

	store.rememberedFor("host-B").clear();
	assert.equal(store.rememberedFor("host-B").read(), null);
	assert.equal(store.rememberedFor("host-C").read()?.keyId, peerC.key.keyId);
	assert.equal(store.rememberedFor("__proto__").read()?.keyId, peerB.key.keyId);
	assert.equal(store.rememberedFor("constructor").read()?.keyId, peerC.key.keyId);
	assert.equal(({} as Record<string, unknown>).keyId, undefined, "no prototype pollution from slot ids");
	assert.ok(store.acceptedPeers.get(peerA.key.keyId));
	assert.ok(store.grants.get(peerA.key.keyId));
	assert.equal(store.identity?.key.keyId, identity.key.keyId);
	store.close();
	const persisted = openStore(t, fixture.agentDir);
	assert.equal(persisted.rememberedFor("host-B").read(), null, "the cleared slot is durably cleared");
	assert.equal(persisted.rememberedFor("host-C").read()?.keyId, peerC.key.keyId);
	assert.equal(persisted.rememberedFor("__proto__").read()?.keyId, peerB.key.keyId);
	assert.equal(persisted.rememberedFor("constructor").read()?.keyId, peerC.key.keyId);
});

test("inbound A->B acceptance and grant never manufacture the reverse direction", { skip: !posix }, async (t) => {
	const fixtureA = createAgentDirFixture(t);
	const fixtureB = createAgentDirFixture(t);
	const storeA = openStore(t, fixtureA.agentDir);
	const storeB = openStore(t, fixtureB.agentDir);
	const identityA = await storeA.initializeIdentity("A-phone");
	const identityB = await storeB.initializeIdentity("B-laptop");
	storeB.acceptedPeers.set(acceptedFor(identityA, identityB));
	storeB.grants.set(grantFor(identityA, identityB));

	assert.ok(storeB.acceptedPeers.get(identityA.key.keyId));
	assert.ok(storeB.grants.get(identityA.key.keyId));
	assert.equal(storeA.acceptedPeers.get(identityB.key.keyId), undefined, "A has not accepted B");
	assert.equal(storeA.grants.get(identityB.key.keyId), undefined, "A has not granted B");

	storeA.close();
	const reloadedA = openStore(t, fixtureA.agentDir);
	assert.equal(reloadedA.acceptedPeers.get(identityB.key.keyId), undefined);
	assert.equal(reloadedA.grants.get(identityB.key.keyId), undefined);
});

test("accepted identity and directional grant are independent facts across separate set/delete and reopen", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const identity = await store.initializeIdentity("hub");
	const peer = await generatePeerIdentity("peer");

	// Accepted-only partial state.
	store.acceptedPeers.set(acceptedFor(peer, identity));
	store.close();
	let current = openStore(t, fixture.agentDir);
	assert.ok(current.acceptedPeers.get(peer.key.keyId), "accepted-only state round-trips");
	assert.equal(current.grants.get(peer.key.keyId), undefined, "acceptance alone creates no grant");

	// The grant is an independent fact: set it, then remove only it.
	current.grants.set(grantFor(peer, identity));
	current.close();
	current = openStore(t, fixture.agentDir);
	assert.ok(current.grants.get(peer.key.keyId));
	assert.ok(current.acceptedPeers.get(peer.key.keyId));
	// The existing host revoke order is grants.delete then accepted.delete.
	assert.equal(current.grants.delete(peer.key.keyId), true);
	current.close();
	const afterGrantDelete = openStore(t, fixture.agentDir);
	assert.equal(afterGrantDelete.grants.get(peer.key.keyId), undefined);
	assert.ok(afterGrantDelete.acceptedPeers.get(peer.key.keyId), "accepted-only survives an independent grant delete");

	// Grant-only partial state, then remove only the acceptance.
	afterGrantDelete.grants.set(grantFor(peer, identity));
	afterGrantDelete.close();
	let grantOnly = openStore(t, fixture.agentDir);
	assert.ok(grantOnly.grants.get(peer.key.keyId), "grant-only state round-trips");
	assert.equal(grantOnly.acceptedPeers.delete(peer.key.keyId), true);
	grantOnly.close();
	grantOnly = openStore(t, fixture.agentDir);
	assert.ok(grantOnly.grants.get(peer.key.keyId), "an independent accepted delete leaves the grant alone");
	assert.equal(grantOnly.acceptedPeers.get(peer.key.keyId), undefined, "a grant without an accepted row is valid state");

	// Both facts absent is still a valid document; the identity is unaffected.
	assert.equal(grantOnly.grants.delete(peer.key.keyId), true);
	grantOnly.close();
	const empty = openStore(t, fixture.agentDir);
	assert.equal(empty.grants.get(peer.key.keyId), undefined);
	assert.equal(empty.acceptedPeers.get(peer.key.keyId), undefined);
	assert.equal(empty.identity?.key.keyId, identity.key.keyId, "the identity is independent of trust facts");
});

test("an unchanged receiving key keeps grants; a different receiving key inherits nothing", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const identity = await store.initializeIdentity("original");
	const peer = await generatePeerIdentity("peer");
	store.acceptedPeers.set(acceptedFor(peer, identity));
	store.grants.set(grantFor(peer, identity));
	store.close();

	const document = readDocument(fixture);
	const before = stateBytes(fixture);
	const replacement = await generatePeerIdentity("imposter");

	// Consistent new identity material, but the records stay bound to the old receiver.
	writeDocument(fixture, {
		...document,
		receiverKeyId: replacement.key.keyId,
		identity: {
			label: replacement.label,
			certificatePem: replacement.certificatePem,
			privateKeyPem: replacement.privateKeyPem,
		},
	});
	const boundToOldReceiver = stateBytes(fixture);
	assertFixedTrustError(() => openStore(t, fixture.agentDir), "records bound to another receiver key");
	assert.deepEqual(stateBytes(fixture), boundToOldReceiver, "refused state is left untouched");

	// A receiver id that no longer matches the persisted certificate.
	writeDocument(fixture, { ...document, receiverKeyId: replacement.key.keyId });
	assertFixedTrustError(() => openStore(t, fixture.agentDir), "receiver key id disagrees with the certificate");

	// Certificate and private key from different identities.
	writeDocument(fixture, {
		...document,
		identity: { ...(document.identity as Record<string, string>), privateKeyPem: replacement.privateKeyPem },
	});
	assertFixedTrustError(() => openStore(t, fixture.agentDir), "certificate/private-key mismatch");

	writeDocument(fixture, before);
	const restored = openStore(t, fixture.agentDir);
	assert.equal(restored.identity?.key.keyId, identity.key.keyId, "the original identity still loads");
	assert.ok(restored.grants.get(peer.key.keyId), "and still owns its grant");
});

test("unsupported, malformed, oversized, duplicate and inconsistent state is refused untouched", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const identity = await store.initializeIdentity("hub");
	const peer = await generatePeerIdentity("peer");
	store.acceptedPeers.set(acceptedFor(peer, identity));
	store.grants.set(grantFor(peer, identity));
	store.rememberedFor("slot").write(peer.key);
	store.close();
	const valid = readDocument(fixture);
	const accepted = (valid.accepted as Array<Record<string, unknown>>)[0];
	const grant = (valid.grants as Array<Record<string, unknown>>)[0];
	const remembered = (valid.remembered as Array<Record<string, unknown>>)[0];

	const tooManyAccepted = Array.from({ length: MAX_ACCEPTED_PEER_RECORDS + 1 }, (_unused, index) => ({
		key: boundedSyntheticPeerKey(index + 1),
		label: `peer-${index}`,
		acceptedAt: 1,
		receiverKeyId: identity.key.keyId,
	}));
	const tooManyGrants = Array.from({ length: MAX_DIRECTIONAL_GRANT_RECORDS + 1 }, (_unused, index) => ({
		peerKeyId: boundedSyntheticPeerKey(index + 1).keyId,
		direction: "peer->host",
		capability: "app",
		grantedAt: 1,
		receiverKeyId: identity.key.keyId,
	}));
	const tooManyRemembered = Array.from({ length: MAX_REMEMBERED_PEER_SLOTS + 1 }, (_unused, index) => ({
		targetId: `slot-${index}`,
		key: boundedSyntheticPeerKey(index + 1),
	}));

	const cases: Array<{ name: string; value: unknown }> = [
		{ name: "unknown version", value: { ...valid, version: PEER_STATE_STORE_VERSION + 1 } },
		{ name: "string version", value: { ...valid, version: "1" } },
		{ name: "missing identity", value: { ...valid, identity: undefined } },
		{ name: "extra top-level field", value: { ...valid, extra: true } },
		{ name: "missing remembered list", value: { ...valid, remembered: undefined } },
		{ name: "identity label is not display-safe", value: { ...valid, identity: { ...(valid.identity as Record<string, string>), label: "bad\nlabel" } } },
		{ name: "duplicate accepted identity", value: { ...valid, accepted: [accepted, accepted] } },
		{ name: "accepted record missing a field", value: { ...valid, accepted: [{ ...accepted, label: undefined }] } },
		{ name: "accepted record with an extra field", value: { ...valid, accepted: [{ ...accepted, extra: 1 }] } },
		{ name: "accepted record with a mismatched fingerprint", value: { ...valid, accepted: [{ ...accepted, key: { keyId: peer.key.keyId, fingerprint: `${peer.key.fingerprint.slice(0, -1)}${peer.key.fingerprint.endsWith("A") ? "B" : "A"}` } }] } },
		{ name: "accepted record bound to another receiver", value: { ...valid, accepted: [{ ...accepted, receiverKeyId: peer.key.keyId }] } },
		{ name: "accepted record with a negative time", value: { ...valid, accepted: [{ ...accepted, acceptedAt: -1 }] } },
		{ name: "accepted record with a fractional time", value: { ...valid, accepted: [{ ...accepted, acceptedAt: 1.5 }] } },
		{ name: "accepted record bound count exceeds the bound", value: { ...valid, accepted: tooManyAccepted } },
		{ name: "duplicate directional grant", value: { ...valid, grants: [grant, grant] } },
		{ name: "grant with the reverse direction", value: { ...valid, grants: [{ ...grant, direction: "host->peer" }] } },
		{ name: "grant with an unknown capability", value: { ...valid, grants: [{ ...grant, capability: "session" }] } },
		{ name: "grant bound to another receiver", value: { ...valid, grants: [{ ...grant, receiverKeyId: peer.key.keyId }] } },
		{ name: "grant count exceeds the bound", value: { ...valid, grants: tooManyGrants } },
		{ name: "duplicate remembered target", value: { ...valid, remembered: [remembered, remembered] } },
		{ name: "remembered target with control characters", value: { ...valid, remembered: [{ ...remembered, targetId: "a\u0000b" }] } },
		{ name: "remembered target is empty", value: { ...valid, remembered: [{ ...remembered, targetId: "" }] } },
		{ name: "remembered record with an extra field", value: { ...valid, remembered: [{ ...remembered, extra: 1 }] } },
		{ name: "remembered slot count exceeds the bound", value: { ...valid, remembered: tooManyRemembered } },
	];

	for (const testCase of cases) {
		writeDocument(fixture, testCase.value);
		const rejected = stateBytes(fixture);
		assertFixedTrustError(() => openStore(t, fixture.agentDir), `refuses ${testCase.name}`);
		assert.deepEqual(stateBytes(fixture), rejected, `${testCase.name}: refused state is untouched`);
		assert.deepEqual(peerDirEntries(fixture), ["state.json"], `${testCase.name}: no temporary artifact created`);
	}

	// Malformed and oversized raw bytes are refused too.
	const malformed = ["{not json", "", `{"version":1}`, "x".repeat(MAX_PEER_STATE_FILE_BYTES + 1)];
	for (const body of malformed) {
		writeDocument(fixture, body);
		const rejected = stateBytes(fixture);
		assertFixedTrustError(() => openStore(t, fixture.agentDir), "refuses malformed or oversized bytes");
		assert.deepEqual(stateBytes(fixture), rejected);
	}

	// The unmodified document still opens: every refusal above was about the change.
	writeDocument(fixture, valid);
	const loaded = openStore(t, fixture.agentDir);
	assert.equal(loaded.identity?.key.keyId, identity.key.keyId);
	loaded.close();

	// Intentional partial states are valid documents, not inconsistencies: the
	// accepted identity and the directional grant are independent facts.
	writeDocument(fixture, { ...valid, grants: [] });
	const acceptedOnly = openStore(t, fixture.agentDir);
	assert.ok(acceptedOnly.acceptedPeers.get(peer.key.keyId), "accepted-only document");
	assert.equal(acceptedOnly.grants.get(peer.key.keyId), undefined);
	acceptedOnly.close();

	writeDocument(fixture, { ...valid, accepted: [] });
	const grantOnly = openStore(t, fixture.agentDir);
	assert.ok(grantOnly.grants.get(peer.key.keyId), "grant-only document");
	assert.equal(grantOnly.acceptedPeers.get(peer.key.keyId), undefined);
});

test("the accepted/grant/remembered record bounds refuse new records instead of evicting", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const identity = await store.initializeIdentity("hub");
	for (let index = 0; index < MAX_REMEMBERED_PEER_SLOTS; index += 1) {
		store.rememberedFor(`slot-${index}`).write(boundedSyntheticPeerKey(index + 1));
	}
	assertFixedTrustError(
		() => store.rememberedFor("one-too-many").write(boundedSyntheticPeerKey(999)),
		"the remembered slot bound refuses instead of evicting",
	);
	assert.equal(store.rememberedFor("one-too-many").read(), null);
	assert.equal(store.rememberedFor("slot-0").read()?.keyId, boundedSyntheticPeerKey(1).keyId);
});

test("symlinked, non-regular and non-directory paths are refused", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	await store.initializeIdentity("hub");
	store.close();

	// state.json replaced by a symlink to a valid-looking document elsewhere.
	const movedDocument = join(fixture.root, "moved-state.json");
	renameSync(fixture.statePath, movedDocument);
	symlinkSync(movedDocument, fixture.statePath);
	assertFixedTrustError(() => openStore(t, fixture.agentDir), "symlinked state document");
	unlinkSync(fixture.statePath);

	// state.json replaced by a directory.
	mkdirSync(fixture.statePath, { mode: 0o700 });
	assertFixedTrustError(() => openStore(t, fixture.agentDir), "non-regular state document");
	rmdirSync(fixture.statePath);

	// Dedicated directory replaced by a symlink to a real private directory.
	renameSync(fixture.peersDir, join(fixture.root, "moved-peers"));
	symlinkSync(join(fixture.root, "moved-peers"), fixture.peersDir);
	assertFixedTrustError(() => openStore(t, fixture.agentDir), "symlinked dedicated directory");
	unlinkSync(fixture.peersDir);

	// Agent directory itself is a symlink.
	const linkedAgent = join(fixture.root, "linked-agent");
	symlinkSync(fixture.canonicalAgentDir, linkedAgent);
	assertFixedTrustError(() => openStore(t, linkedAgent), "symlinked agent directory");
});

test("unsafe permissions, ownership mismatch and an unprotected parent are refused untouched", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const identity = await store.initializeIdentity("hub");
	store.close();

	chmodSync(fixture.peersDir, 0o755);
	assertFixedTrustError(() => openStore(t, fixture.agentDir), "broad dedicated directory permissions");
	assert.equal(modeOf(fixture.peersDir), 0o755, "an existing object is never repaired");
	chmodSync(fixture.peersDir, 0o700);

	chmodSync(fixture.statePath, 0o644);
	assertFixedTrustError(() => openStore(t, fixture.agentDir), "broad state file permissions");
	assert.equal(modeOf(fixture.statePath), 0o644, "an existing object is never repaired");
	chmodSync(fixture.statePath, 0o600);

	chmodSync(fixture.sessionHostDir, 0o777);
	assertFixedTrustError(() => openStore(t, fixture.agentDir), "an untrusted parent is never repaired");
	chmodSync(fixture.sessionHostDir, 0o700);

	const otherOwner = createPosixTestPolicy({ ownerUid: process.getuid!() + 1 });
	assertFixedTrustError(() => openStore(t, fixture.agentDir, otherOwner), "ownership mismatch");

	// A well-formed document still loads once protection is genuine again.
	const restored = openStore(t, fixture.agentDir);
	assert.equal(restored.identity?.key.keyId, identity.key.keyId);
});

test("opening an uninitialized directory creates nothing, reads nothing trusted, and generates no key", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const before = readdirSync(fixture.agentDir).sort();
	const store = openStore(t, fixture.agentDir);

	const initialIdentity = store.identity;
	assert.equal(initialIdentity, null);
	assert.deepEqual(readdirSync(fixture.agentDir).sort(), before, "opening creates no state directory");
	assert.equal(existsSync(fixture.sessionHostDir), false);
	assert.equal(store.acceptedPeers.get(boundedSyntheticPeerKey(1).keyId), undefined);
	assert.equal(store.acceptedPeers.delete(boundedSyntheticPeerKey(1).keyId), false);
	assert.equal(store.grants.get(boundedSyntheticPeerKey(1).keyId), undefined);
	assert.equal(store.grants.delete(boundedSyntheticPeerKey(1).keyId), false);
	assert.equal(store.rememberedFor("slot").read(), null);

	// Mutations without an established identity refuse: nothing is inferred.
	const peer = await generatePeerIdentity("peer");
	const uninitializedReceiver = await generatePeerIdentity("receiver");
	assertFixedTrustError(() => store.rememberedFor("slot").write(boundedSyntheticPeerKey(1)), "uninitialized pin write");
	assertFixedTrustError(() => store.acceptedPeers.set(acceptedFor(peer, uninitializedReceiver)), "uninitialized accepted write");
	assertFixedTrustError(() => store.grants.set({
		peerKeyId: peer.key.keyId,
		direction: "peer->host",
		capability: "app",
		grantedAt: 1,
		receiverKeyId: peer.key.keyId,
	}), "uninitialized grant write");
	await assert.rejects(store.initializeIdentity("bad\nlabel"), (error: unknown) => {
		assert.ok(isPeerTransportError(error));
		assert.equal((error as { code?: string }).code, "INVALID_ARGUMENT");
		return true;
	});
	assert.equal(existsSync(fixture.sessionHostDir), false, "a refused label creates nothing");

	const identity = await store.initializeIdentity("ok");
	assert.equal(store.identity?.key.keyId, identity.key.keyId);
	assert.equal(modeOf(fixture.sessionHostDir), 0o700);
	assert.equal(modeOf(fixture.peersDir), 0o700);
	assert.equal(modeOf(fixture.statePath), 0o600);
});

test("an existing dedicated directory without state.json is unavailable, never a fresh identity", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	mkdirSync(fixture.sessionHostDir, { mode: 0o700 });
	mkdirSync(fixture.peersDir, { mode: 0o700 });

	assertFixedTrustError(() => openStore(t, fixture.agentDir), "existing directory without state");
	assert.deepEqual(readdirSync(fixture.peersDir), [], "nothing is created or regenerated");
	assertFixedTrustError(() => openStore(t, fixture.agentDir), "no automatic repair on a later open");
	assert.deepEqual(readdirSync(fixture.peersDir), []);

	// The same rule holds after a previously used identity document disappears.
	const usedFixture = createAgentDirFixture(t);
	const store = openStore(t, usedFixture.agentDir);
	const identity = await store.initializeIdentity("hub");
	store.close();
	unlinkSync(usedFixture.statePath);
	assertFixedTrustError(() => openStore(t, usedFixture.agentDir), "lost state is not re-initialized");
	assert.equal(existsSync(usedFixture.statePath), false, "past identity is never silently regenerated");
	assert.ok(identity.key.keyId.length > 0);
});

test("first publication wins; a losing initializer fails closed and preserves the winner", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const winner = openStore(t, fixture.agentDir);
	const loser = openStore(t, fixture.agentDir);
	const winning = winner.initializeIdentity("first");
	const losing = loser.initializeIdentity("second");

	await assertFixedTrustRejection(losing, "the losing initializer fails closed");
	const identity = await winning;
	assert.equal(winner.identity?.key.keyId, identity.key.keyId);
	const document = readDocument(fixture);
	assert.equal((document.identity as Record<string, string>).label, "first", "the winner is not overwritten");
	assert.equal(document.receiverKeyId, identity.key.keyId);
	assertFixedTrustError(() => loser.identity, "the losing handle has no authority");
	assert.deepEqual(peerDirEntries(fixture), ["state.json"], "no losing temporary is left behind");

	winner.close();
	const fresh = openStore(t, fixture.agentDir);
	assert.equal(fresh.identity?.key.keyId, identity.key.keyId);
});

test("a refused pre-write protection aborts initialization without writing key material", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const policy = createPosixTestPolicy();
	const store = openStore(t, fixture.agentDir, policy);
	policy.fail = (call) => call.operation === "protectCreatedDirectory" && call.path === fixture.peersDir;

	await assertFixedTrustRejection(store.initializeIdentity("hub"), "the dedicated directory is never left unverified");
	assert.equal(existsSync(fixture.statePath), false, "no document is published");
	assert.deepEqual(existsSync(fixture.peersDir) ? readdirSync(fixture.peersDir) : [], [], "no temporary is left behind");
	assertFixedTrustError(() => store.identity, "the abandoned initializer has no authority");
	// Inertness: no fixture file may hold key material. `createAgentDirFixture`
	// fixes this layout, so the check enumerates its KNOWN directories explicitly
	// instead of walking an arbitrary tree.
	for (const directory of [fixture.root, fixture.agentDir, fixture.canonicalAgentDir, fixture.sessionHostDir, fixture.peersDir]) {
		if (!existsSync(directory)) continue;
		for (const name of readdirSync(directory)) {
			const candidate = join(directory, name);
			const stats = lstatSync(candidate);
			if (!stats.isFile() || stats.isSymbolicLink()) continue;
			assert.ok(!readFileSync(candidate, "utf8").includes("PRIVATE KEY"), "no private key byte was written before protection");
		}
	}
	// Nothing is silently repaired: a later open reports the incomplete directory.
	assertFixedTrustError(() => openStore(t, fixture.agentDir), "the incomplete directory stays unavailable");
});

test("same-handle concurrent initialize calls share one outcome", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const first = store.initializeIdentity("shared");
	const second = store.initializeIdentity("shared");
	const [left, right] = await Promise.all([first, second]);
	assert.equal(left.key.keyId, right.key.keyId, "both callers observe the same shared outcome");
	assert.notEqual(left, right, "each caller receives its own projection");
	const expectedFirstByte = right.certificateDer[0];
	left.certificateDer[0] ^= 0xff;
	assert.equal(right.certificateDer[0], expectedFirstByte, "one caller's projection cannot change another's");
	const later = await store.initializeIdentity("shared");
	assert.equal(later.key.keyId, left.key.keyId);
	assert.deepEqual(peerDirEntries(fixture), ["state.json"], "one publication only");
});

test("the initialization result is a detached projection, never the stored identity", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const identity = await store.initializeIdentity("hub");
	const originalDer = Buffer.from(identity.certificateDer);
	const originalNotBefore = identity.notBefore.getTime();
	const originalNotAfter = identity.notAfter.getTime();

	// Mutating the returned object is a caller-local mutation only.
	identity.certificateDer[0] ^= 0xff;
	identity.notBefore.setTime(0);
	identity.notAfter.setTime(0);

	const observed = store.identity;
	assert.ok(observed !== null);
	assert.deepEqual(Buffer.from(observed.certificateDer), originalDer, "the store identity is unaliased");
	assert.equal(observed.notBefore.getTime(), originalNotBefore);
	assert.equal(observed.notAfter.getTime(), originalNotAfter);

	store.close();
	const reopened = openStore(t, fixture.agentDir);
	const reloaded = reopened.identity;
	assert.ok(reloaded !== null);
	assert.deepEqual(Buffer.from(reloaded.certificateDer), originalDer, "and the persisted identity is untouched");
	assert.equal(reloaded.notBefore.getTime(), originalNotBefore);
	assert.equal(reloaded.notAfter.getTime(), originalNotAfter);
});

test("a non-ENOENT filesystem failure is unavailable, never uninitialized", { skip: !posix || process.getuid?.() === 0 }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const identity = await store.initializeIdentity("hub");
	store.close();
	const before = readdirSync(fixture.agentDir).sort();

	// Removing search permission on the agent directory makes the store's own
	// stat of the session-host child fail with EACCES instead of ENOENT.
	chmodSync(fixture.canonicalAgentDir, 0o000);
	try {
		assert.doesNotThrow(() => lstatSync(fixture.agentDir), "the agent directory itself is still observable");
		assert.doesNotThrow(() => realpathSync(fixture.agentDir), "canonicalization still succeeds");
		assert.throws(
			() => lstatSync(fixture.sessionHostDir),
			(error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES",
			"the child observation genuinely fails with a non-ENOENT error",
		);
		assertFixedTrustError(() => openStore(t, fixture.agentDir), "a stat failure is unavailable storage, not fresh state");
	} finally {
		chmodSync(fixture.canonicalAgentDir, 0o700);
	}

	const restored = openStore(t, fixture.agentDir);
	assert.equal(restored.identity?.key.keyId, identity.key.keyId, "the committed state is intact and still loads");
	assert.deepEqual(readdirSync(fixture.agentDir).sort(), before);
});

test("a definite pre-commit publication failure keeps the previous document authoritative", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const policy = createPosixTestPolicy();
	const store = openStore(t, fixture.agentDir, policy);
	const identity = await store.initializeIdentity("hub");
	const before = stateBytes(fixture);

	// Protection of every newly created temporary must happen while it is empty.
	const protectCalls = policy.calls.filter((call) => call.operation === "protectCreatedFile");
	assert.ok(protectCalls.length > 0, "the store protects its created temporary");
	assert.ok(protectCalls.every((call) => call.size === 0), "no private-key byte exists before protection");
	const directoryProtection = policy.calls.findIndex(
		(call) => call.operation === "protectCreatedDirectory" && call.path === fixture.peersDir,
	);
	const fileProtection = policy.calls.findIndex((call) => call.operation === "protectCreatedFile");
	assert.ok(directoryProtection >= 0 && directoryProtection < fileProtection, "directory protection precedes the secret temp");

	const peer = await generatePeerIdentity("peer");
	policy.fail = (call) => call.operation === "protectCreatedFile";
	assertFixedTrustError(() => store.acceptedPeers.set(acceptedFor(peer, identity)), "a refused temporary protection");
	assert.equal(store.acceptedPeers.get(peer.key.keyId), undefined, "memory is never published before disk");
	assert.deepEqual(stateBytes(fixture), before, "the committed document is unchanged");
	assert.deepEqual(peerDirEntries(fixture), ["state.json"], "the owned temporary was removed");
	assert.equal(store.identity?.key.keyId, identity.key.keyId, "the handle stays authoritative");

	policy.fail = null;
	store.acceptedPeers.set(acceptedFor(peer, identity));
	assert.equal(store.acceptedPeers.get(peer.key.keyId)?.label, "peer");
	store.close();
	const reloaded = openStore(t, fixture.agentDir);
	assert.equal(reloaded.acceptedPeers.get(peer.key.keyId)?.label, "peer");
});

test("an unverifiable post-commit publication poisons the handle instead of claiming success", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const policy = createPosixTestPolicy();
	const store = openStore(t, fixture.agentDir, policy);
	const identity = await store.initializeIdentity("hub");

	const peer = await generatePeerIdentity("peer");
	// Refuse only the post-rename protection verification of the committed document.
	policy.fail = (call) => call.operation === "assertPrivateFile" && call.path === fixture.statePath;
	assertFixedTrustError(() => store.acceptedPeers.set(acceptedFor(peer, identity)), "unverifiable published document");

	assertFixedTrustError(() => store.identity, "poisoned identity getter");
	assertFixedTrustError(() => store.acceptedPeers.get(peer.key.keyId), "poisoned accepted getter");
	assertFixedTrustError(() => store.grants.get(peer.key.keyId), "poisoned grant getter");
	assertFixedTrustError(() => store.rememberedFor("slot").read(), "poisoned remembered read");
	assertFixedTrustError(() => store.acceptedPeers.set(acceptedFor(peer, identity)), "poisoned mutation");
	await assertFixedTrustRejection(store.initializeIdentity("again"), "poisoned initialization");
	store.close();
	store.close();

	// The committed bytes are what a new handle sees; this handle simply never
	// claimed that its memory matched them.
	const fresh = openStore(t, fixture.agentDir);
	assert.equal(fresh.acceptedPeers.get(peer.key.keyId)?.label, "peer");
});

test("a changed destination or path type is refused and poisons the stale handle", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const identity = await store.initializeIdentity("hub");
	const peer = await generatePeerIdentity("peer");
	store.acceptedPeers.set(acceptedFor(peer, identity));

	// An external writer replaced the document while this handle is open.
	const replacement = join(fixture.root, "replacement.json");
	writeFileSync(replacement, `${JSON.stringify(readDocument(fixture))}\n`);
	chmodSync(replacement, 0o600);
	renameSync(replacement, fixture.statePath);
	const foreign = stateBytes(fixture);
	assertFixedTrustError(() => store.acceptedPeers.set(acceptedFor(peer, identity)), "replaced destination");
	assert.deepEqual(stateBytes(fixture), foreign, "the replacement is never overwritten");
	assertFixedTrustError(() => store.identity, "the stale handle is poisoned");

	// A destination that is no longer a regular file is refused too.
	const reloaded = openStore(t, fixture.agentDir);
	assert.ok(reloaded.acceptedPeers.get(peer.key.keyId));
	unlinkSync(fixture.statePath);
	mkdirSync(fixture.statePath, { mode: 0o700 });
	assertFixedTrustError(() => reloaded.acceptedPeers.delete(peer.key.keyId), "destination type change");
	assertFixedTrustError(() => reloaded.acceptedPeers.get(peer.key.keyId), "poisoned after the type change");
	assert.ok(lstatSync(fixture.statePath).isDirectory(), "the unexpected entry is left untouched");
});

test("a replaced parent directory invalidates the open handle", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const identity = await store.initializeIdentity("hub");
	const peer = await generatePeerIdentity("peer");
	store.acceptedPeers.set(acceptedFor(peer, identity));
	const committed = stateBytes(fixture);

	const moved = `${fixture.sessionHostDir}-moved`;
	renameSync(fixture.sessionHostDir, moved);
	mkdirSync(fixture.sessionHostDir, { mode: 0o700 });
	assertFixedTrustError(() => store.acceptedPeers.delete(peer.key.keyId), "replaced parent directory");
	assertFixedTrustError(() => store.identity, "the handle is poisoned");
	assert.deepEqual(readFileSync(join(moved, "peers", "state.json")), committed, "no committed document is touched");
});

test("store errors never carry secrets, record contents or filesystem paths", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const identity = await store.initializeIdentity("hub");
	const peer = await generatePeerIdentity("peer");
	store.acceptedPeers.set(acceptedFor(peer, identity));
	store.close();

	const messages: string[] = [];
	const capture = (fn: () => unknown): void => {
		try {
			fn();
		} catch (error) {
			messages.push((error as Error).message);
		}
	};
	writeDocument(fixture, { version: PEER_STATE_STORE_VERSION + 1 });
	capture(() => openStore(t, fixture.agentDir));
	writeDocument(fixture, "{}");
	capture(() => openStore(t, fixture.agentDir));
	writeDocument(fixture, readDocument(fixture));
	chmodSync(fixture.statePath, 0o644);
	capture(() => openStore(t, fixture.agentDir));

	assert.ok(messages.length >= 3);
	for (const message of messages) {
		assert.equal(message, FIXED_TRUST_MESSAGE);
		assert.ok(!message.includes(identity.certificatePem));
		assert.ok(!message.includes(identity.privateKeyPem));
		assert.ok(!message.includes(fixture.root));
		assert.ok(!message.includes(peer.key.keyId));
	}
});

test("a closed handle fails closed for reads, mutations and initialization", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const identity = await store.initializeIdentity("hub");
	const peer = await generatePeerIdentity("peer");
	store.acceptedPeers.set(acceptedFor(peer, identity));
	store.rememberedFor("slot").write(peer.key);
	store.close();
	store.close();

	assertFixedTrustError(() => store.identity, "closed identity getter");
	assertFixedTrustError(() => store.acceptedPeers.get(peer.key.keyId), "closed accepted getter");
	assertFixedTrustError(() => store.grants.get(peer.key.keyId), "closed grant getter");
	assertFixedTrustError(() => store.rememberedFor("slot").read(), "closed remembered read");
	assertFixedTrustError(() => store.rememberedFor("slot").write(peer.key), "closed remembered write");
	assertFixedTrustError(() => store.acceptedPeers.delete(peer.key.keyId), "closed accepted delete");
	await assertFixedTrustRejection(store.initializeIdentity("again"), "closed initialization");

	// A new handle is the only way back to the committed facts.
	const reloaded = openStore(t, fixture.agentDir);
	assert.equal(reloaded.identity?.key.keyId, identity.key.keyId);
	assert.equal(reloaded.rememberedFor("slot").read()?.keyId, peer.key.keyId);
});

test("persisted identity and stores re-admit the remembered peer, and a different receiver inherits nothing", { skip: !posix }, async (t) => {
	const fixtureB = createAgentDirFixture(t);
	const fixtureA = createAgentDirFixture(t);
	const storeB = openStore(t, fixtureB.agentDir);
	const storeA = openStore(t, fixtureA.agentDir);
	const identityB = await storeB.initializeIdentity("B-laptop");
	const identityA = await storeA.initializeIdentity("A-phone");

	const openedChannels: string[] = [];
	const hostB = await startHost(t, {
		identity: identityB,
		acceptedPeers: storeB.acceptedPeers,
		grants: storeB.grants,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: (channel) => {
			openedChannels.push(channel.peerKey.keyId);
		},
	});
	const clientA = startClient(t, identityA, { remembered: storeA.rememberedFor("host-B") });
	const paired = await clientA.client.pair({ port: hostB.port, approveServerKey: () => "accept" });
	assert.equal(paired.ok, true);
	assert.equal(paired.serverKey?.keyId, identityB.key.keyId);
	assert.equal(storeA.rememberedFor("host-B").read()?.keyId, identityB.key.keyId, "the client pinned the exact server key");
	assert.ok(storeB.acceptedPeers.get(identityA.key.keyId), "the receiving side persisted the acceptance");
	assert.ok(storeB.grants.get(identityA.key.keyId), "the receiving side persisted its directional grant");

	// Reconstruct everything from disk: no in-memory store survives.
	clientA.client.dispose();
	await hostB.host.close();
	storeA.close();
	storeB.close();
	const reopenedA = openStore(t, fixtureA.agentDir);
	const reopenedB = openStore(t, fixtureB.agentDir);
	assert.equal(reopenedB.identity?.key.keyId, identityB.key.keyId);
	assert.equal(reopenedA.rememberedFor("host-B").read()?.keyId, identityB.key.keyId);

	const rebuiltHost = await startHost(t, {
		identity: reopenedB.identity as OwnedPeerIdentity,
		acceptedPeers: reopenedB.acceptedPeers,
		grants: reopenedB.grants,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: (channel) => {
			openedChannels.push(channel.peerKey.keyId);
		},
	});
	const rebuiltClient = startClient(t, identityA, { remembered: reopenedA.rememberedFor("host-B") });
	const channel = await rebuiltClient.client.connectApp({ port: rebuiltHost.port });
	assert.equal(channel.peerKey.keyId, identityB.key.keyId, "the remembered key is accepted without a new approval");
	assert.equal(openedChannels.at(-1), identityA.key.keyId);
	await channel.close();

	// A different local receiving key cannot use B's persisted grants or identities.
	const identityC = await generatePeerIdentity("C-imposter");
	const impostorHost = await startHost(t, {
		identity: identityC,
		acceptedPeers: reopenedB.acceptedPeers,
		grants: reopenedB.grants,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: (appChannel) => {
			openedChannels.push(appChannel.peerKey.keyId);
		},
	});
	const freshClient = startClient(t, identityA, { remembered: createInMemoryRememberedPeerKeyStore() });
	await assert.rejects(
		freshClient.client.connectApp({ port: impostorHost.port, approveServerKey: () => "accept" }),
		(error: unknown) => {
			assert.ok(isPeerTransportError(error), "a fixed transport error");
			assert.equal((error as { code?: string }).code, "APP_REFUSED", "records bound to B do not authorize C");
			return true;
		},
	);
});

test("a changed target key is refused by client continuity and the old pin is preserved", { skip: !posix }, async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(t, fixture.agentDir);
	const identityA = await store.initializeIdentity("A-phone");
	const original = await generatePeerIdentity("original-target");
	store.rememberedFor("host-B").write(original.key);

	const impostor = await generatePeerIdentity("impostor-target");
	const impostorHost = await startHost(t, {
		identity: impostor,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: () => {
			// A refused request never reaches this callback.
		},
	});
	const client = startClient(t, identityA, { remembered: store.rememberedFor("host-B") });
	await assert.rejects(
		client.client.connectApp({ port: impostorHost.port, approveServerKey: () => "accept" }),
		(error: unknown) => {
			assert.ok(isPeerTransportError(error));
			assert.equal((error as { code?: string }).code, "PEER_KEY_MISMATCH");
			return true;
		},
	);
	assert.equal(store.rememberedFor("host-B").read()?.keyId, original.key.keyId, "the pin is never overwritten by a mismatch");
	store.close();
	const reloaded = openStore(t, fixture.agentDir);
	assert.equal(reloaded.rememberedFor("host-B").read()?.keyId, original.key.keyId);
});
