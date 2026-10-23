/** Real-policy integration; Windows execution proves ACL/storage, not native UI. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { generatePeerIdentity, isPeerTransportError } from "../src/session-host/network/index";
import { openPeerStateStore, type PeerStateStore } from "../src/session-host/network/peer-state";
import { createPeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permissions";
import { DEFAULT_PEER_PREFERENCES, isPeerPreferencesError, openPeerPreferencesStoreWithPermissions } from "../src/session-host/network/peer-preferences-store";
import { createAgentDirFixture } from "./session-host-network-peer-state-fixtures";
import { startClient, startHost } from "./session-host-network-helpers";

function trackStore(t: TestContext, agentDir: string): PeerStateStore {
	const store = openPeerStateStore({ agentDir });
	t.after(() => store.close());
	return store;
}

function fixedFailure(error: unknown): boolean {
	return isPeerTransportError(error) && error.code === "TRUST_STORE_FAILED";
}

test("real policy: opening fresh state is inert; initialization publishes a single private file", async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = trackStore(t, fixture.agentDir);
	const initialIdentity = store.identity;
	assert.equal(initialIdentity, null);
	assert.equal(existsSync(fixture.sessionHostDir), false, "read does not initialize directories or identity");
	const identity = await store.initializeIdentity("owner-main");
	assert.equal(store.identity?.key.keyId, identity.key.keyId);
	assert.equal(lstatSync(fixture.statePath).nlink, 1, "exclusive publication retires its owned temporary link");
	assert.deepEqual(readdirSync(fixture.peersDir), ["state.json"]);
	store.close();
	const restored = trackStore(t, fixture.agentDir);
	assert.equal(restored.identity?.key.keyId, identity.key.keyId);
});

test("real policy: sidebar preferences publish privately and reopen without creating identity", (t) => {
	const fixture = createAgentDirFixture(t);
	const permissions = createPeerStatePermissionPolicy();
	const open = () => {
		const store = openPeerPreferencesStoreWithPermissions({ agentDir: fixture.agentDir, permissions });
		t.after(() => store.close());
		return store;
	};
	const preferences = open();
	assert.equal(preferences.read(), null);
	assert.equal(existsSync(fixture.sessionHostDir), false, "default read creates no preferences or keys");
	const expected = { ...DEFAULT_PEER_PREFERENCES, bellEnabled: false, autoReconnect: true };
	preferences.write(expected);
	const directory = join(fixture.sessionHostDir, "peer-preferences");
	const file = join(directory, "preferences.json");
	permissions.assertPrivateDirectory(directory);
	permissions.assertPrivateFile(file);
	assert.equal(lstatSync(file).nlink, 1, "exclusive publication retires only its owned temporary link");
	assert.deepEqual(readdirSync(directory), ["preferences.json"]);
	assert.equal(existsSync(fixture.peersDir), false, "saving display/reconnect settings never creates identity/trust");
	preferences.close();
	const reopened = open();
	assert.deepEqual(reopened.read(), expected);
	reopened.close();
	assert.equal(trackStore(t, fixture.agentDir).identity, null);
	assert.equal(existsSync(fixture.peersDir), false);
	unlinkSync(file);
	assert.throws(open, (error: unknown) => isPeerPreferencesError(error) && error.code === "PEER_PREFERENCES_UNAVAILABLE",
		"missing initialized preferences are refused, never silently replaced with defaults");
});

test("real policy: independent host pins and old directional grants survive a fresh process", async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = trackStore(t, fixture.agentDir);
	const identity = await store.initializeIdentity("owner-main");
	const linux = await generatePeerIdentity("linux-host");
	const windows = await generatePeerIdentity("windows-host");
	store.rememberedFor("linux").write(linux.key);
	store.rememberedFor("windows").write(windows.key);
	store.acceptedPeers.set({ key: linux.key, label: linux.label, acceptedAt: 1, receiverKeyId: identity.key.keyId });
	store.grants.set({
		peerKeyId: linux.key.keyId, direction: "peer->host", capability: "app",
		grantedAt: 1, receiverKeyId: identity.key.keyId,
	});
	store.close();
	const child = join(__dirname, "session-host-network-peer-state-reopen-child.js");
	const stdout = execFileSync(process.execPath, [child, fixture.agentDir, JSON.stringify({
		accepted: [linux.key.keyId], grants: [linux.key.keyId], targets: ["linux", "windows"],
	}), "--default-policy"], { encoding: "utf8", timeout: 120_000 });
	const observations = JSON.parse(stdout.trim().split("\n")[0]!);
	assert.equal(observations.keyId, identity.key.keyId);
	assert.equal(observations.grants[0].grantedAt, 1, "approval age is not a permission expiry");
	assert.equal(observations.remembered.linux.keyId, linux.key.keyId);
	assert.equal(observations.remembered.windows.keyId, windows.key.keyId);
	const restored = trackStore(t, fixture.agentDir);
	restored.rememberedFor("linux").clear();
	assert.equal(restored.rememberedFor("linux").read(), null);
	assert.equal(restored.rememberedFor("windows").read()?.keyId, windows.key.keyId);
	assert.ok(restored.grants.get(linux.key.keyId), "clearing an outgoing pin does not revoke an inbound grant");
});

test("real policy: one-time pairing reconnects after reconstruction without consent, until explicit revocation", async (t) => {
	const aFixture = createAgentDirFixture(t);
	const bFixture = createAgentDirFixture(t);
	const a = trackStore(t, aFixture.agentDir);
	const b = trackStore(t, bFixture.agentDir);
	const aIdentity = await a.initializeIdentity("A-client");
	const bIdentity = await b.initializeIdentity("B-owner");
	let consents = 0;
	const firstHost = await startHost(t, {
		identity: bIdentity, acceptedPeers: b.acceptedPeers, grants: b.grants,
		bounds: { consentTimeoutMs: 120_000 },
		onPairingRequest: (request) => { consents++; assert.equal(request.approve(), true); },
		onAppChannel: () => undefined,
	});
	const firstClient = startClient(t, aIdentity, {
		remembered: a.rememberedFor("B"), bounds: { consentTimeoutMs: 120_000 },
	});
	assert.equal((await firstClient.client.pair({ port: firstHost.port, approveServerKey: () => "accept" })).ok, true);
	assert.equal(consents, 1);
	const granted = b.grants.get(aIdentity.key.keyId)!;
	b.grants.set({ ...granted, grantedAt: 1 });
	firstClient.client.dispose();
	await firstHost.host.close();
	a.close(); b.close();

	const restoredA = trackStore(t, aFixture.agentDir);
	const restoredB = trackStore(t, bFixture.agentDir);
	assert.equal(restoredA.grants.get(bIdentity.key.keyId), undefined, "A->B never grants B->A");
	const secondHost = await startHost(t, {
		identity: restoredB.identity!, acceptedPeers: restoredB.acceptedPeers, grants: restoredB.grants,
		bounds: { consentTimeoutMs: 120_000 },
		onPairingRequest: () => { consents++; assert.fail("reconnect must not ask for consent"); },
		onAppChannel: () => undefined,
	});
	const secondClient = startClient(t, restoredA.identity!, {
		remembered: restoredA.rememberedFor("B"),
		onServerKey: () => { assert.fail("a known exact server key must not need approval again"); },
	});
	const channel = await secondClient.client.connectApp({ port: secondHost.port });
	assert.equal(consents, 1);
	assert.equal(secondHost.host.stats.appChannelsOpened, 1);
	channel.close();
	assert.equal(secondHost.host.revoke(aIdentity.key), true);
	await assert.rejects(secondClient.client.connectApp({ port: secondHost.port }),
		(error: unknown) => isPeerTransportError(error) && error.code === "APP_REFUSED");
	assert.equal(secondHost.host.stats.appGateDenied, 1);
	assert.equal(restoredA.rememberedFor("B").read()?.keyId, bIdentity.key.keyId, "revocation does not replace the pin");
	secondClient.client.dispose();
	await secondHost.host.close();
});

test("real policy: Unicode and shell metacharacters in an agent path remain path data", async (t) => {
	const fixture = createAgentDirFixture(t);
	const agentDir = join(fixture.agentDir, "hôte-Δ ' $();");
	mkdirSync(agentDir, { mode: 0o700 });
	const store = trackStore(t, agentDir);
	const identity = await store.initializeIdentity("unicode-path");
	store.close();
	const restored = trackStore(t, agentDir);
	assert.equal(restored.identity?.key.keyId, identity.key.keyId);
});

test("owner UI trust snapshot is immutable, contains no private material and never becomes authorization", async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = trackStore(t, fixture.agentDir);
	assert.equal(store.readTrustSnapshot(), null, "uninitialized is distinct from initialized empty trust");
	const identity = await store.initializeIdentity("owner-ui");
	const peer = await generatePeerIdentity("remembered-peer");
	store.acceptedPeers.set({ key: peer.key, label: peer.label, acceptedAt: 1, receiverKeyId: identity.key.keyId });
	store.grants.set({ peerKeyId: peer.key.keyId, direction: "peer->host", capability: "app", grantedAt: 1, receiverKeyId: identity.key.keyId });
	store.rememberedFor("desktop").write(peer.key);
	const shown = store.readTrustSnapshot()!;
	assert.deepEqual(Object.keys(shown).sort(), ["acceptedPeers", "grants", "receiverKey", "remembered"]);
	assert.equal(shown.receiverKey.keyId, identity.key.keyId);
	assert.equal(shown.remembered[0]?.targetId, "desktop");
	assert.ok(!JSON.stringify(shown).includes("PRIVATE KEY"));
	assert.ok(Object.isFrozen(shown) && Object.isFrozen(shown.acceptedPeers) && Object.isFrozen(shown.grants) && Object.isFrozen(shown.remembered));
	assert.equal(Reflect.set(shown.acceptedPeers[0]!, "label", "forged"), false);
	assert.equal(Reflect.set(shown.remembered[0]!.key, "keyId", "forged"), false);
	assert.equal(store.acceptedPeers.get(peer.key.keyId)?.label, peer.label);
	store.grants.delete(peer.key.keyId);
	store.rememberedFor("desktop").clear();
	assert.equal(shown.grants.length, 1, "an old observation stays an old observation");
	assert.equal(store.grants.get(peer.key.keyId), undefined, "only current stores decide authorization");
	assert.deepEqual(store.readTrustSnapshot()?.grants, []);
	assert.deepEqual(store.readTrustSnapshot()?.remembered, []);
	store.close();
	assert.throws(() => store.readTrustSnapshot(), fixedFailure, "closed is not uninitialized or empty trust");
});

test("real policy: loss of an initialized identity file refuses instead of generating a new key", async (t) => {
	const fixture = createAgentDirFixture(t);
	const store = trackStore(t, fixture.agentDir);
	await store.initializeIdentity("owner-main");
	store.close();
	unlinkSync(fixture.statePath); // Deliberate loss inside this newly owned test fixture.
	assert.throws(() => openPeerStateStore({ agentDir: fixture.agentDir }), fixedFailure);
	assert.equal(existsSync(fixture.statePath), false, "refusal leaves lost state missing rather than silently resetting it");
});
