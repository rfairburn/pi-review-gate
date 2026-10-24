/**
 * Network storage refusal reasons and the explicit, confirmed permission
 * repair through the REAL production coordinator and backend (Refs #494).
 *
 * POSIX cases use real directories, files, modes, and the real platform
 * permission policy under a synthetic agent directory each test creates and
 * removes; no account state is touched. The only listener or connection is an
 * invocation-owned loopback one, opened by an explicit command after restart.
 * Fixture-seam cases (named as such) drive outcomes the filesystem cannot
 * produce deterministically: they prove the coordinator's handling, not a
 * platform's protection.
 */
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { openPeerPreferencesStoreWithPermissions, DEFAULT_PEER_PREFERENCES, type PeerPreferences } from "../src/session-host/network/peer-preferences-store";
import { generatePeerIdentity } from "../src/session-host/network/identity";
import { openPeerStateStore } from "../src/session-host/network/peer-state";
import { createPeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permissions";
import type { PeerByteChannel } from "../src/session-host/network/channel";
import type { PeerStorageAssessment, PeerStorageRepairReport } from "../src/session-host/network/peer-storage-remediation";
import { describePeerUiStorage, type PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import {
	assert,
	consentsOf,
	createOwnedAgentDir,
	startCoordinator,
	type AgentFixture,
} from "./session-host-network-peer-coordinator-helpers";

const POSIX = process.platform !== "win32" && typeof process.getuid === "function";
const POSIX_SKIP = POSIX ? false : "real owner/mode fixtures require a POSIX host";

const DEFAULT_SETTINGS = {
	hostingEnabled: false,
	bindHost: "",
	bindPort: null,
	autoReconnect: false,
	bellEnabled: true,
	viewerNativeInputEnabled: true,
	remoteHistoryDeleteEnabled: true,
};

function modeOf(target: string): number {
	return lstatSync(target).mode & 0o7777;
}

function inode(target: string): string {
	const stats = lstatSync(target, { bigint: true });
	return `${stats.dev}:${stats.ino}`;
}

/** Recursive listing of the fixture's own session-host tree (never followed). */
function tree(dir: string, prefix = ""): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const name of readdirSync(dir).sort()) {
		const relative = `${prefix}${name}`;
		out.push(relative);
		const stats = lstatSync(join(dir, name));
		if (stats.isDirectory() && !stats.isSymbolicLink()) out.push(...tree(join(dir, name), `${relative}/`));
	}
	return out;
}

function writePreferences(agentDir: string, preferences: PeerPreferences): void {
	const store = openPeerPreferencesStoreWithPermissions({ agentDir, permissions: createPeerStatePermissionPolicy() });
	store.write(preferences);
	store.close();
}

interface SeededProfile {
	readonly fingerprint: string;
	readonly pinFingerprint: string;
	readonly grantedLabel: string;
}

/**
 * A valid upgraded profile: an existing pre-network roster/keybindings base,
 * then a real identity, one outgoing pin, one accepted peer with a receiving
 * grant, and saved preferences with explicit Off values, all published by the
 * production stores.
 */
async function seedProfile(fixture: AgentFixture, preferences: PeerPreferences): Promise<SeededProfile> {
	writeFileSync(join(fixture.agentDir, "keybindings.json"), "{}\n", { mode: 0o600 });
	mkdirSync(fixture.sessionHostDir, { mode: 0o700 });
	writeFileSync(join(fixture.sessionHostDir, "roster.json"), "{\"version\":1,\"entries\":[]}\n", { mode: 0o600 });
	const store = openPeerStateStore({ agentDir: fixture.agentDir });
	const identity = await store.initializeIdentity("owner-main");
	const pinned = await generatePeerIdentity("pinned-host");
	const accepted = await generatePeerIdentity("accepted-peer");
	store.rememberedFor("dest-1").write(pinned.key);
	store.acceptedPeers.set({ key: accepted.key, label: "accepted-peer", acceptedAt: 1, receiverKeyId: identity.key.keyId });
	store.grants.set({
		peerKeyId: accepted.key.keyId, direction: "peer->host", capability: "app",
		grantedAt: 1, receiverKeyId: identity.key.keyId,
	});
	store.close();
	writePreferences(fixture.agentDir, preferences);
	return { fingerprint: identity.key.fingerprint, pinFingerprint: pinned.key.fingerprint, grantedLabel: "accepted-peer" };
}

const SAVED: PeerPreferences = {
	...DEFAULT_PEER_PREFERENCES,
	bellEnabled: false,
	viewerNativeInputEnabled: false,
	remoteHistoryDeleteEnabled: false,
	destinations: [{
		id: "dest-1", label: "studio", host: "127.0.0.1", port: 9, previouslyConnected: true, reconnectSuppressed: true,
	}],
};

function storageLines(snapshot: PeerUiSnapshot): string {
	assert.ok(snapshot.storage, "a storage fact is attached");
	return describePeerUiStorage(snapshot.storage).join("\n");
}

function assertNoPrivateText(snapshot: PeerUiSnapshot, fixture: AgentFixture): void {
	const text = JSON.stringify(snapshot) + (snapshot.storage ? storageLines(snapshot) : "");
	assert.equal(text.includes(fixture.root), false, "no private path is displayed");
	assert.equal(/errno|EACCES|EPERM|S-1-5/u.test(text), false, "no raw error, errno, or SID is displayed");
}

test("a fresh profile keeps the unchanged defaults, attaches no storage fact, and creates nothing", { skip: POSIX_SKIP }, async (t) => {
	const fixture = createOwnedAgentDir(t);
	const side = await startCoordinator(t, { agentDir: fixture.agentDir });
	const snapshot = side.coordinator.read();
	assert.equal(snapshot.status, "ready");
	assert.deepEqual(snapshot.settings, DEFAULT_SETTINGS);
	assert.equal(snapshot.storage, undefined, "no storage problem means no storage fact at all");
	assert.equal(snapshot.identityFingerprint, null);
	assert.deepEqual(snapshot.listener, { state: "off", host: null, port: null, message: null });
	assert.equal(await side.coordinator.repairStorageProtection(1), "stale", "no repair is offered on a healthy profile");
	assert.equal(existsSync(fixture.sessionHostDir), false, "start and a refused repair create nothing");
});

test("a valid pre-network roster/keybindings base opens with defaults and gains no Network state", { skip: POSIX_SKIP }, async (t) => {
	const fixture = createOwnedAgentDir(t);
	writeFileSync(join(fixture.agentDir, "keybindings.json"), "{}\n", { mode: 0o600 });
	mkdirSync(fixture.sessionHostDir, { mode: 0o700 });
	writeFileSync(join(fixture.sessionHostDir, "roster.json"), "{\"version\":1,\"entries\":[]}\n", { mode: 0o600 });
	const before = tree(fixture.sessionHostDir);
	const side = await startCoordinator(t, { agentDir: fixture.agentDir });
	assert.equal(side.coordinator.read().status, "ready");
	assert.deepEqual(side.coordinator.read().settings, DEFAULT_SETTINGS);
	assert.equal(side.coordinator.read().storage, undefined);
	assert.deepEqual(tree(fixture.sessionHostDir), before, "no peers, preferences, or key appear");
});

test("an older document without the optional flags, explicit Off, trust, and pins survive restarts", { skip: POSIX_SKIP }, async (t) => {
	const fixture = createOwnedAgentDir(t);
	const seeded = await seedProfile(fixture, SAVED);
	// Rewrite the document in the exact older version-1 field set (no optional flags).
	const older = { version: 1, hosting: { enabled: false, bindHost: null, bindPort: null }, autoReconnect: false, bellEnabled: false,
		destinations: SAVED.destinations };
	writeFileSync(fixture.preferencesPath, `${JSON.stringify(older)}\n`, { mode: 0o600 });
	for (let run = 0; run < 2; run += 1) {
		const side = await startCoordinator(t, { agentDir: fixture.agentDir });
		const snapshot = side.coordinator.read();
		assert.equal(snapshot.status, "ready");
		assert.equal(snapshot.storage, undefined);
		assert.equal(snapshot.settings?.bellEnabled, false, "explicit Off is kept");
		assert.equal(snapshot.settings?.viewerNativeInputEnabled, true, "an absent optional flag is on");
		assert.equal(snapshot.identityFingerprint, seeded.fingerprint);
		assert.equal(snapshot.hosts?.[0]?.fingerprint, seeded.pinFingerprint);
		assert.equal(snapshot.hosts?.[0]?.reconnectSuppressed, true);
		assert.ok(snapshot.trustedPeers?.some((peer) => peer.label === seeded.grantedLabel && peer.hasInboundGrant));
		await side.coordinator.close();
	}
	assert.equal(readFileSync(fixture.preferencesPath, "utf8"), `${JSON.stringify(older)}\n`, "reading never rewrites the document");
});

test("broad storage is truthfully unavailable; a confirmed repair preserves every byte and requires a restart", { skip: POSIX_SKIP }, async (t) => {
	const fixture = createOwnedAgentDir(t);
	const seeded = await seedProfile(fixture, SAVED);
	chmodSync(fixture.sessionHostDir, 0o777);
	chmodSync(fixture.peersDir, 0o755);
	chmodSync(fixture.statePath, 0o644);
	chmodSync(fixture.preferencesDir, 0o755);
	chmodSync(fixture.preferencesPath, 0o644);
	chmodSync(join(fixture.sessionHostDir, "roster.json"), 0o644);
	const agentMode = modeOf(fixture.agentDir);
	const files = ["peers/state.json", "peer-preferences/preferences.json", "roster.json"];
	const bytes = Object.fromEntries(files.map((name) => [name, readFileSync(join(fixture.sessionHostDir, name))]));
	const identities = Object.fromEntries(files.map((name) => [name, inode(join(fixture.sessionHostDir, name))]));
	const listing = tree(fixture.sessionHostDir);

	const side = await startCoordinator(t, { agentDir: fixture.agentDir });
	const refused = side.coordinator.read();
	assert.equal(refused.status, "unavailable");
	assert.equal(refused.settings, null, "unsafe settings are never shown as defaults");
	assert.equal(refused.hosts, null);
	assert.deepEqual(refused.storage?.problems, [
		{ store: "settings", reason: "unsafe-permissions", object: "session-host" },
		{ store: "trust", reason: "unsafe-permissions", object: "session-host" },
	]);
	const offered = refused.storage?.repair;
	assert.ok(offered?.state === "offered", "an eligible repair is offered");
	assert.deepEqual(offered.targets.map((target) => [target.target, target.status]), [
		["session-host", "repairable"], ["peers", "repairable"], ["peer-state", "repairable"],
		["peer-preferences", "repairable"], ["preferences-document", "repairable"],
	]);
	const text = storageLines(refused);
	assert.ok(text.includes("session-host does not meet the required access permissions."));
	assert.ok(text.includes("owner-only"), "the POSIX mitigation names the protection rule");
	assertNoPrivateText(refused, fixture);
	assert.equal(modeOf(fixture.sessionHostDir), 0o777, "refusal and assessment change nothing");

	assert.equal(await side.coordinator.repairStorageProtection(offered.generation + 1), "stale");
	assert.equal(modeOf(fixture.sessionHostDir), 0o777, "a stale generation changes nothing");

	assert.equal(await side.coordinator.repairStorageProtection(offered.generation), "ran");
	const repaired = side.coordinator.read();
	assert.equal(repaired.status, "unavailable", "Network stays unavailable until a restart");
	assert.deepEqual(repaired.storage?.repair, { state: "restart-required", outcome: "repaired", priorExposurePossible: true });
	assert.ok(storageLines(repaired).includes("replace the identity key separately"), "the private-key warning is shown");
	assert.equal(modeOf(fixture.sessionHostDir), 0o700);
	assert.equal(modeOf(fixture.peersDir), 0o700);
	assert.equal(modeOf(fixture.statePath), 0o600);
	assert.equal(modeOf(fixture.preferencesDir), 0o700);
	assert.equal(modeOf(fixture.preferencesPath), 0o600);
	assert.equal(modeOf(join(fixture.sessionHostDir, "roster.json")), 0o644, "unrelated files are untouched");
	assert.equal(modeOf(fixture.agentDir), agentMode, "the agent directory is untouched");
	for (const name of files) {
		assert.deepEqual(readFileSync(join(fixture.sessionHostDir, name)), bytes[name], `${name} bytes are preserved`);
		assert.equal(inode(join(fixture.sessionHostDir, name)), identities[name], `${name} is the same object`);
	}
	assert.deepEqual(tree(fixture.sessionHostDir), listing, "nothing is created or removed");

	// Latched: no command runs, nothing hosts, and a second repair does not run.
	await side.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	await side.coordinator.perform({ type: "peer-bell", enabled: true });
	assert.equal(side.coordinator.read().listener.state, "off");
	assert.match(side.coordinator.read().notice ?? "", /Restart Pi/u);
	assert.equal(await side.coordinator.repairStorageProtection(offered.generation), "not-run");
	assert.equal(side.coordinator.readRemoteHistoryDeleteEnabled(), false);
	assert.deepEqual(readFileSync(fixture.preferencesPath), bytes["peer-preferences/preferences.json"]);
	await side.coordinator.close();

	// A deliberate restart reopens the same identity, pins, grants, and explicit Off values.
	const restarted = await startCoordinator(t, { agentDir: fixture.agentDir });
	const reopened = restarted.coordinator.read();
	assert.equal(reopened.status, "ready");
	assert.equal(reopened.storage, undefined);
	assert.equal(reopened.identityFingerprint, seeded.fingerprint, "the key is unchanged");
	assert.equal(reopened.hosts?.[0]?.fingerprint, seeded.pinFingerprint, "the pin is unchanged");
	assert.equal(reopened.hosts?.[0]?.reconnectSuppressed, true);
	assert.deepEqual([reopened.settings?.bellEnabled, reopened.settings?.viewerNativeInputEnabled,
		reopened.settings?.remoteHistoryDeleteEnabled, reopened.settings?.hostingEnabled], [false, false, false, false]);
	assert.ok(reopened.trustedPeers?.some((peer) => peer.label === seeded.grantedLabel && peer.hasInboundGrant));
	assert.equal(reopened.listener.state, "off", "restart restores no hosting that was never saved");

	// Explicit Hosting and Connect are admitted again (invocation-owned loopback only).
	await restarted.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	const listening = restarted.coordinator.read().listener;
	assert.equal(listening.state, "listening");
	assert.equal(restarted.coordinator.read().identityFingerprint, seeded.fingerprint, "hosting reuses the kept key");
	await restarted.coordinator.perform({ type: "peer-add", label: "self", host: "127.0.0.1", port: String(listening.port) });
	const selfId = restarted.coordinator.read().hosts?.find((host) => host.label === "self")?.id;
	assert.ok(selfId);
	void restarted.coordinator.perform({ type: "peer-connect", hostId: selfId });
	await restarted.log.waitFor((snapshot) => consentsOf(snapshot, "server-key").length > 0,
		"an explicit Connect reaches the first-use key confirmation");
	await restarted.coordinator.close();
});

test("non-permission refusals keep specific reasons and are never offered a repair", { skip: POSIX_SKIP }, async (t) => {
	const malformed = createOwnedAgentDir(t);
	mkdirSync(malformed.preferencesDir, { recursive: true, mode: 0o700 });
	chmodSync(malformed.sessionHostDir, 0o700);
	writeFileSync(malformed.preferencesPath, "{not json", { mode: 0o600 });
	const one = await startCoordinator(t, { agentDir: malformed.agentDir });
	assert.equal(one.coordinator.read().settings, null, "a damaged document is never defaults");
	assert.deepEqual(one.coordinator.read().storage?.problems, [{ store: "settings", reason: "malformed", object: "preferences-document" }]);
	assert.deepEqual(one.coordinator.read().storage?.repair, { state: "none" });
	assert.ok(storageLines(one.coordinator.read()).includes("never reset or overwritten"));
	assert.equal(readFileSync(malformed.preferencesPath, "utf8"), "{not json");

	const missing = createOwnedAgentDir(t);
	mkdirSync(missing.peersDir, { recursive: true, mode: 0o700 });
	chmodSync(missing.sessionHostDir, 0o700);
	const two = await startCoordinator(t, { agentDir: missing.agentDir });
	assert.deepEqual(two.coordinator.read().storage?.problems, [{ store: "trust", reason: "missing-initialized", object: "peer-state" }]);
	assert.deepEqual(two.coordinator.read().storage?.repair, { state: "none" });
	await two.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	assert.deepEqual(readdirSync(missing.peersDir), [], "no key is generated for a missing initialized document");
	const missingText = storageLines(two.coordinator.read());
	assert.ok(missingText.includes("session-host/peers/state.json is missing from an already initialized storage directory."),
		"the missing document is named as missing, never as a directory without itself");
	assert.equal(missingText.includes("without its document"), false);

	const linked = createOwnedAgentDir(t);
	mkdirSync(linked.sessionHostDir, { mode: 0o700 });
	mkdirSync(join(linked.root, "elsewhere"), { mode: 0o700 });
	symlinkSync(join(linked.root, "elsewhere"), linked.peersDir);
	const three = await startCoordinator(t, { agentDir: linked.agentDir });
	assert.deepEqual(three.coordinator.read().storage?.problems, [{ store: "trust", reason: "unsafe-object", object: "peers" }]);
	assert.deepEqual(three.coordinator.read().storage?.repair, { state: "none" });
	assertNoPrivateText(three.coordinator.read(), linked);
});

test("a too-restrictive owner mode is explained truthfully, never as access beyond the account", { skip: POSIX_SKIP }, async (t) => {
	const fixture = createOwnedAgentDir(t);
	await seedProfile(fixture, SAVED);
	// Owner read-only: nothing beyond the account can access it, yet the exact
	// private mode the store requires is not met.
	chmodSync(fixture.statePath, 0o400);
	const side = await startCoordinator(t, { agentDir: fixture.agentDir });
	const refused = side.coordinator.read();
	assert.equal(refused.status, "unavailable");
	assert.deepEqual(refused.storage?.problems.find((problem) => problem.store === "trust"),
		{ store: "trust", reason: "unsafe-permissions", object: "peer-state" });
	const text = storageLines(refused);
	assert.ok(text.includes("session-host/peers/state.json does not meet the required access permissions."));
	assert.ok(text.includes("(directories 0700, files 0600)"), "the exact POSIX owner-only mitigation is kept");
	assert.equal(/beyond your account|another account/u.test(text), false, "no broader access is claimed for an owner-only mode");
	assertNoPrivateText(refused, fixture);
	assert.equal(modeOf(fixture.statePath), 0o400, "showing the refusal changes nothing");
});

test("a broad base with an unsafe child is blocked, explained, and changed by nothing", { skip: POSIX_SKIP }, async (t) => {
	const fixture = createOwnedAgentDir(t);
	mkdirSync(fixture.preferencesDir, { recursive: true, mode: 0o700 });
	writeFileSync(fixture.preferencesPath, "{}\n", { mode: 0o600 });
	linkSync(fixture.preferencesPath, join(fixture.root, "second-name"));
	chmodSync(fixture.sessionHostDir, 0o777);
	const side = await startCoordinator(t, { agentDir: fixture.agentDir });
	const repair = side.coordinator.read().storage?.repair;
	assert.deepEqual(repair, { state: "blocked", target: "preferences-document", reason: "unsafe-object" });
	assert.ok(storageLines(side.coordinator.read()).includes("Repair is not possible"));
	assert.equal(await side.coordinator.repairStorageProtection(1), "stale");
	assert.equal(modeOf(fixture.sessionHostDir), 0o777);
});

test("a write refusal during active hosting is busy until hosting stops, then repairable", { skip: POSIX_SKIP }, async (t) => {
	const fixture = createOwnedAgentDir(t);
	const side = await startCoordinator(t, { agentDir: fixture.agentDir });
	await side.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	assert.equal(side.coordinator.read().listener.state, "listening");
	chmodSync(fixture.sessionHostDir, 0o777);
	await side.coordinator.perform({ type: "peer-bell", enabled: false });
	const busy = side.coordinator.read().storage;
	assert.deepEqual(busy?.problems, [{ store: "settings", reason: "unsafe-permissions", object: "session-host" }],
		"the original write refusal keeps its own sanitized diagnostic");
	assert.deepEqual(busy?.repair, { state: "busy" });
	assert.equal(await side.coordinator.repairStorageProtection(1), "busy");
	assert.equal(modeOf(fixture.sessionHostDir), 0o777, "a busy Network is never raced");
	assert.equal(side.coordinator.read().listener.state, "listening", "a refused repair stops nothing");

	await side.coordinator.perform({ type: "peer-listener", enabled: false, host: "127.0.0.1", port: "0" });
	const offered = side.coordinator.read().storage?.repair;
	assert.ok(offered?.state === "offered", "the same assessment is offered once Network is inactive");
	assert.equal(await side.coordinator.repairStorageProtection(offered.generation), "ran");
	assert.equal(modeOf(fixture.sessionHostDir), 0o700);
	assert.equal(side.coordinator.read().storage?.repair.state, "restart-required");
});

test("fixture seam: changed eligibility, a partial result, and a throwing backend are handled fail closed", { skip: POSIX_SKIP }, async (t) => {
	const target = (status: "repairable" | "absent") => (name: PeerStorageAssessment["targets"][number]["target"]) =>
		({ target: name, status: name === "session-host" ? status : "absent", reason: name === "session-host" && status === "repairable" ? "unsafe-permissions" : null } as const);
	const objects = ["session-host", "peers", "peer-state", "peer-preferences", "preferences-document"] as const;
	const assessment = (status: "repairable" | "absent"): PeerStorageAssessment => ({
		supported: true,
		targets: objects.map(target(status)),
		repairable: status === "repairable",
		blocked: null,
	});
	const broad = (fixture: AgentFixture): void => {
		mkdirSync(fixture.sessionHostDir, { mode: 0o700 });
		chmodSync(fixture.sessionHostDir, 0o777);
	};

	// Eligibility changes between the written confirmation and the mutation.
	const changed = createOwnedAgentDir(t);
	broad(changed);
	let assessments = 0;
	let repairs = 0;
	const first = await startCoordinator(t, { agentDir: changed.agentDir, testHooks: { storageRemediation: {
		assess: () => assessment(++assessments === 1 ? "repairable" : "absent"),
		repair: () => { repairs += 1; throw new Error("must not run"); },
	} } });
	const offered = first.coordinator.read().storage?.repair;
	assert.ok(offered?.state === "offered");
	assert.equal(await first.coordinator.repairStorageProtection(offered.generation), "stale");
	assert.equal(repairs, 0, "a changed recheck never mutates");

	// A partial report latches restart-required as possibly changed.
	const partial = createOwnedAgentDir(t);
	broad(partial);
	const report: PeerStorageRepairReport = {
		outcome: "partial", targets: [], changed: true, restartRequired: true, priorExposurePossible: true,
	};
	const second = await startCoordinator(t, { agentDir: partial.agentDir, testHooks: { storageRemediation: {
		assess: () => assessment("repairable"), repair: () => report,
	} } });
	const secondOffer = second.coordinator.read().storage?.repair;
	assert.ok(secondOffer?.state === "offered");
	assert.equal(await second.coordinator.repairStorageProtection(secondOffer.generation), "ran");
	assert.deepEqual(second.coordinator.read().storage?.repair, { state: "restart-required", outcome: "partial", priorExposurePossible: true });
	assert.ok(storageLines(second.coordinator.read()).includes("only partly repaired"));

	// A throwing backend cannot prove nothing changed: also latched as partial.
	const thrown = createOwnedAgentDir(t);
	broad(thrown);
	const third = await startCoordinator(t, { agentDir: thrown.agentDir, testHooks: { storageRemediation: {
		assess: () => assessment("repairable"), repair: () => { throw new Error("synthetic backend failure"); },
	} } });
	const thirdOffer = third.coordinator.read().storage?.repair;
	assert.ok(thirdOffer?.state === "offered");
	assert.equal(await third.coordinator.repairStorageProtection(thirdOffer.generation), "ran");
	assert.equal(third.coordinator.read().storage?.repair.state, "restart-required");
	assert.equal(JSON.stringify(third.coordinator.read()).includes("synthetic backend failure"), false, "no raw error is shown");
});

test("fixed why/mitigation text is OS-appropriate, offers repair only when offered, and stays path-free", () => {
	const targets = (["session-host", "peers", "peer-state", "peer-preferences", "preferences-document"] as const)
		.map((name) => ({ target: name, status: name === "session-host" ? "repairable" as const : "absent" as const,
			reason: name === "session-host" ? "extended-acl" as const : null }));
	const acl = describePeerUiStorage({
		platform: "posix",
		problems: [{ store: "trust", reason: "extended-acl", object: "session-host" }],
		repair: { state: "offered", generation: 3, targets },
	}).join("\n");
	assert.ok(acl.includes("session-host has an extended ACL entry"));
	assert.ok(acl.includes("Use Repair permissions below, or remove that ACL entry yourself"),
		"a supported granting ACL is offered the confirmed repair");
	const manual = describePeerUiStorage({
		platform: "posix",
		problems: [{ store: "trust", reason: "extended-acl", object: "session-host" }],
		repair: { state: "blocked", target: "session-host", reason: "protection-unsupported" },
	}).join("\n");
	assert.equal(manual.includes("Use Repair permissions"), false, "an unprovable ACL is never offered a repair");
	assert.ok(manual.includes("Repair is not possible"));
	const windows = describePeerUiStorage({
		platform: "windows",
		problems: [{ store: "settings", reason: "unsafe-permissions", object: "preferences-document" }],
		repair: { state: "none" },
	}).join("\n");
	assert.ok(windows.includes("session-host/peer-preferences/preferences.json does not meet the required access permissions."));
	assert.ok(windows.includes("your account, SYSTEM, and Administrators"));
	assert.equal(/0700|0600/u.test(windows), false, "no POSIX mode advice on Windows");
	for (const text of [acl, manual, windows]) assert.equal(/[A-Za-z]:\\|\/Users\/|\/home\//u.test(text), false);
});

test("trust mutations refused by unsafe permissions keep their sanitized reason and offer the repair", { skip: POSIX_SKIP }, async (t) => {
	const revoke = createOwnedAgentDir(t);
	await seedProfile(revoke, SAVED);
	const first = await startCoordinator(t, { agentDir: revoke.agentDir });
	assert.equal(first.coordinator.read().status, "ready");
	const peer = first.coordinator.read().trustedPeers?.[0];
	assert.ok(peer?.hasInboundGrant);
	chmodSync(revoke.peersDir, 0o755);
	await first.coordinator.perform({ type: "peer-revoke", peerId: peer.id });
	const revoked = first.coordinator.read();
	assert.deepEqual(revoked.storage?.problems, [{ store: "trust", reason: "unsafe-permissions", object: "peers" }],
		"the original grant-removal refusal keeps its own reason and object");
	assert.equal(revoked.storage?.repair.state, "offered");
	assert.ok(storageLines(revoked).includes("session-host/peers does not meet the required access permissions."));
	assertNoPrivateText(revoked, revoke);

	const remove = createOwnedAgentDir(t);
	await seedProfile(remove, SAVED);
	const second = await startCoordinator(t, { agentDir: remove.agentDir });
	chmodSync(remove.peersDir, 0o750);
	await second.coordinator.perform({ type: "peer-remove", hostId: "dest-1" });
	const removed = second.coordinator.read();
	assert.deepEqual(removed.storage?.problems, [{ store: "trust", reason: "unsafe-permissions", object: "peers" }],
		"the original pin-clear refusal keeps its own reason and object");
	assert.equal(removed.storage?.repair.state, "offered");
	assertNoPrivateText(removed, remove);
});

/** A fixture wrapper that holds this side's LOCAL channel close until released. */
function heldCloseChannel(): { hook: (channel: PeerByteChannel) => PeerByteChannel; readonly closeStarted: Promise<void>; release(): void } {
	let inner: PeerByteChannel | null = null;
	let started: () => void = () => undefined;
	const closeStarted = new Promise<void>((resolve) => { started = resolve; });
	let settle: () => void = () => undefined;
	let closing: Promise<void> | null = null;
	const live = (): PeerByteChannel => {
		if (inner === null) throw new Error("channel was not wrapped");
		return inner;
	};
	const wrapper: PeerByteChannel = {
		get peerKey() { return live().peerKey; },
		get lane() { return live().lane; },
		get label() { return live().label; },
		get bufferedAmount() { return live().bufferedAmount; },
		get closed() { return live().closed; },
		send: (bytes) => live().send(bytes),
		close(): Promise<void> {
			if (closing !== null) return closing;
			closing = new Promise<void>((resolve) => { settle = resolve; started(); });
			return closing;
		},
		onMessage: (handler) => live().onMessage(handler),
	};
	return {
		hook(channel) { inner = channel; return wrapper; },
		closeStarted,
		release() { void live().close().catch(() => undefined).then(() => settle()); },
	};
}

test("a connection still retiring after Disconnect keeps the repair busy until it settles", { skip: POSIX_SKIP }, async (t) => {
	const ownerFixture = createOwnedAgentDir(t);
	const owner = await startCoordinator(t, { agentDir: ownerFixture.agentDir });
	await owner.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	const port = owner.coordinator.read().listener.port;
	assert.ok(typeof port === "number" && port > 0);

	const fixture = createOwnedAgentDir(t);
	const held = heldCloseChannel();
	const viewer = await startCoordinator(t, { agentDir: fixture.agentDir, testHooks: { wrapClientChannel: held.hook } });
	await viewer.coordinator.perform({ type: "peer-add", label: "owner", host: "127.0.0.1", port: String(port) });
	const hostId = viewer.coordinator.read().hosts?.[0]?.id;
	assert.ok(hostId);
	const connecting = viewer.coordinator.perform({ type: "peer-connect", hostId });
	const keyed = await viewer.log.waitFor((snapshot) => consentsOf(snapshot, "server-key").length > 0, "first-use key");
	assert.equal(viewer.coordinator.decideConsent(consentsOf(keyed, "server-key")[0]!.id, "approve"), true);
	const incoming = await owner.log.waitFor((snapshot) => consentsOf(snapshot, "incoming").length > 0, "incoming request");
	assert.equal(owner.coordinator.decideConsent(consentsOf(incoming, "incoming")[0]!.id, "approve"), true);
	await connecting;
	await viewer.log.waitFor((snapshot) => snapshot.hosts?.[0]?.state === "connected", "the viewer is connected");

	chmodSync(fixture.sessionHostDir, 0o777);
	await viewer.coordinator.perform({ type: "peer-bell", enabled: false });
	assert.deepEqual(viewer.coordinator.read().storage?.repair, { state: "busy" }, "a live connection owns state");

	await viewer.coordinator.perform({ type: "peer-disconnect", hostId });
	await held.closeStarted;
	assert.equal(viewer.coordinator.read().hosts?.[0]?.state, "disconnected", "the destination already reads disconnected");
	assert.deepEqual(viewer.coordinator.read().storage?.repair, { state: "busy" },
		"a connection whose local close has not settled still owns state");
	assert.equal(await viewer.coordinator.repairStorageProtection(1_000_000), "busy");
	assert.equal(modeOf(fixture.sessionHostDir), 0o777, "nothing is changed while the retirement is pending");

	held.release();
	const offered = await viewer.log.waitFor((snapshot) => snapshot.storage?.repair.state === "offered",
		"the repair is offered once the retirement settles");
	const repair = offered.storage?.repair;
	assert.ok(repair?.state === "offered");
	assert.equal(await viewer.coordinator.repairStorageProtection(repair.generation), "ran");
	assert.equal(modeOf(fixture.sessionHostDir), 0o700);
	assert.equal(owner.coordinator.read().listener.state, "listening", "the other host is untouched");
});

test("a first-use pin write refused by unsafe permissions keeps its sanitized reason and offers the repair", { skip: POSIX_SKIP }, async (t) => {
	const ownerFixture = createOwnedAgentDir(t);
	const owner = await startCoordinator(t, { agentDir: ownerFixture.agentDir });
	await owner.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	const port = owner.coordinator.read().listener.port;
	assert.ok(typeof port === "number" && port > 0);

	const fixture = createOwnedAgentDir(t);
	const viewer = await startCoordinator(t, { agentDir: fixture.agentDir });
	await viewer.coordinator.perform({ type: "peer-add", label: "owner", host: "127.0.0.1", port: String(port) });
	const hostId = viewer.coordinator.read().hosts?.[0]?.id;
	assert.ok(hostId);
	const connecting = viewer.coordinator.perform({ type: "peer-connect", hostId });
	const keyed = await viewer.log.waitFor((snapshot) => consentsOf(snapshot, "server-key").length > 0, "first-use key");
	assert.equal(viewer.coordinator.decideConsent(consentsOf(keyed, "server-key")[0]!.id, "approve"), true);
	const incoming = await owner.log.waitFor((snapshot) => consentsOf(snapshot, "incoming").length > 0, "incoming request");
	// The viewer's key directory becomes broad while the owner's approval is pending.
	chmodSync(fixture.peersDir, 0o755);
	assert.equal(owner.coordinator.decideConsent(consentsOf(incoming, "incoming")[0]!.id, "approve"), true);
	await connecting;

	const failed = await viewer.log.waitFor((snapshot) => snapshot.storage?.repair.state === "offered",
		"the refused pin write is explained and the repair is offered after the attempt settles");
	assert.deepEqual(failed.storage?.problems, [{ store: "trust", reason: "unsafe-permissions", object: "peers" }],
		"the original pin-write refusal keeps its own reason and object");
	assert.notEqual(failed.hosts?.[0]?.state, "connected", "no connection is established over unsafe storage");
	assert.ok(storageLines(failed).includes("session-host/peers does not meet the required access permissions."));
	assertNoPrivateText(failed, fixture);
	assert.equal(modeOf(fixture.peersDir), 0o755, "nothing is repaired without the confirmed request");
});

test("a receiving pairing write refused by unsafe permissions keeps its reason, is busy while listening, then offered", { skip: POSIX_SKIP }, async (t) => {
	const ownerFixture = createOwnedAgentDir(t);
	const owner = await startCoordinator(t, { agentDir: ownerFixture.agentDir });
	await owner.coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port: "0" });
	const port = owner.coordinator.read().listener.port;
	assert.ok(typeof port === "number" && port > 0);

	const viewerFixture = createOwnedAgentDir(t);
	const viewer = await startCoordinator(t, { agentDir: viewerFixture.agentDir });
	await viewer.coordinator.perform({ type: "peer-add", label: "owner", host: "127.0.0.1", port: String(port) });
	const hostId = viewer.coordinator.read().hosts?.[0]?.id;
	assert.ok(hostId);
	const connecting = viewer.coordinator.perform({ type: "peer-connect", hostId });
	const keyed = await viewer.log.waitFor((snapshot) => consentsOf(snapshot, "server-key").length > 0, "first-use key");
	assert.equal(viewer.coordinator.decideConsent(consentsOf(keyed, "server-key")[0]!.id, "approve"), true);
	const incoming = await owner.log.waitFor((snapshot) => consentsOf(snapshot, "incoming").length > 0, "incoming request");
	// The OWNER's key directory becomes broad while its own approval is pending.
	chmodSync(ownerFixture.peersDir, 0o755);
	owner.coordinator.decideConsent(consentsOf(incoming, "incoming")[0]!.id, "approve");
	await connecting;
	assert.notEqual(viewer.coordinator.read().hosts?.[0]?.state, "connected", "no pairing completes over unsafe storage");

	const refused = await owner.log.waitFor((snapshot) => (snapshot.storage?.problems.length ?? 0) > 0,
		"the owner records the receiving write refusal");
	assert.deepEqual(refused.storage?.problems, [{ store: "trust", reason: "unsafe-permissions", object: "peers" }],
		"the original receiving-write refusal keeps its own reason and object");
	assert.ok(storageLines(refused).includes("session-host/peers does not meet the required access permissions."));
	assertNoPrivateText(refused, ownerFixture);
	assert.equal(owner.coordinator.read().listener.state, "listening");
	assert.deepEqual(owner.coordinator.read().storage?.repair, { state: "busy" }, "a listening owner is never repaired");

	await owner.coordinator.perform({ type: "peer-listener", enabled: false, host: "127.0.0.1", port: String(port) });
	const offered = await owner.log.waitFor((snapshot) => snapshot.storage?.repair.state === "offered",
		"the repair is offered once hosting is disabled");
	assert.equal(offered.listener.state, "off");
	assert.equal(modeOf(ownerFixture.peersDir), 0o755, "nothing is repaired without the confirmed request");
});
