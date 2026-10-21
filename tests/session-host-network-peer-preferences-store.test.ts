/**
 * Focused coverage for the protected sidebar preferences document (#482).
 *
 * The permission policy is the real POSIX test-only implementation shared with
 * the peer state tests: it inspects actual file types, owner and mode bits of the
 * synthetic fixture, and can inject a refusal. It proves nothing about native
 * Windows ACL enforcement; that remains CI/platform evidence elsewhere.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	DEFAULT_PEER_PREFERENCES,
	MAX_PEER_DESTINATIONS,
	PEER_PREFERENCES_VERSION,
	isPeerPreferencesError,
	openPeerPreferencesStoreWithPermissions,
	validatePeerPreferences,
	type PeerDestination,
	type PeerPreferences,
	type PeerPreferencesStore,
} from "../src/session-host/network/peer-preferences-store";
import { createAgentDirFixture, createPosixTestPolicy, type AgentDirFixture } from "./session-host-network-peer-state-fixtures";

function preferencesDir(fixture: AgentDirFixture): string {
	return join(fixture.sessionHostDir, "peer-preferences");
}

function preferencesPath(fixture: AgentDirFixture): string {
	return join(preferencesDir(fixture), "preferences.json");
}

function openStore(fixture: AgentDirFixture, storePolicy = createPosixTestPolicy()): PeerPreferencesStore {
	const store = openPeerPreferencesStoreWithPermissions({
		agentDir: fixture.agentDir,
		permissions: storePolicy,
	});
	return store;
}

function destination(id: string, overrides: Partial<PeerDestination> = {}): PeerDestination {
	return {
		id,
		label: `Host ${id}`,
		host: "127.0.0.1",
		port: 40_001,
		previouslyConnected: true,
		reconnectSuppressed: false,
		...overrides,
	};
}

function samplePreferences(): PeerPreferences {
	return {
		hosting: { enabled: true, bindHost: "127.0.0.1", bindPort: 40_000 },
		autoReconnect: true,
		bellEnabled: false,
		destinations: [destination("alpha"), destination("beta", { reconnectSuppressed: true })],
	};
}

function writeRawDocument(fixture: AgentDirFixture, text: string): string {
	mkdirSync(fixture.sessionHostDir, { mode: 0o700 });
	mkdirSync(preferencesDir(fixture), { mode: 0o700 });
	const path = preferencesPath(fixture);
	writeFileSync(path, text, { mode: 0o600 });
	return path;
}

function unavailableRefusal(error: unknown): boolean {
	return isPeerPreferencesError(error) && error.code === "PEER_PREFERENCES_UNAVAILABLE";
}

test("an absent document reads as null and creates no directory, file, key, or socket", (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(fixture);
	assert.equal(store.read(), null);
	assert.equal(existsSync(preferencesDir(fixture)), false);
	assert.equal(existsSync(fixture.sessionHostDir), false);
	store.close();
});

test("defaults are frozen and off except the bell", () => {
	assert.equal(Object.isFrozen(DEFAULT_PEER_PREFERENCES), true);
	assert.equal(Object.isFrozen(DEFAULT_PEER_PREFERENCES.hosting), true);
	assert.equal(DEFAULT_PEER_PREFERENCES.hosting.enabled, false);
	assert.equal(DEFAULT_PEER_PREFERENCES.autoReconnect, false);
	assert.equal(DEFAULT_PEER_PREFERENCES.bellEnabled, true);
	const validated = validatePeerPreferences(DEFAULT_PEER_PREFERENCES);
	assert.notEqual(validated, DEFAULT_PEER_PREFERENCES);
	assert.equal(Object.isFrozen(validated), true);
});

test("a saved document is protected before the first byte and survives a fresh handle", (t) => {
	const fixture = createAgentDirFixture(t);
	const policy = createPosixTestPolicy();
	const store = openStore(fixture, policy);
	store.write(samplePreferences());

	const protection = policy.calls.filter((call) => call.operation === "protectCreatedFile");
	assert.ok(protection.length > 0);
	assert.equal(protection[0]?.size, 0, "protection is established on the still-empty temporary");
	const fileStats = lstatSync(preferencesPath(fixture));
	assert.equal(fileStats.mode & 0o777, 0o600);
	const dirStats = lstatSync(preferencesDir(fixture));
	assert.equal(dirStats.mode & 0o777, 0o700);
	assert.equal(fileStats.nlink, 1, "the first publication retires its owned temporary link");
	assert.deepEqual(readdirSync(preferencesDir(fixture)), ["preferences.json"]);

	const read = store.read();
	assert.ok(read);
	assert.deepEqual(read, {
		hosting: { enabled: true, bindHost: "127.0.0.1", bindPort: 40_000 },
		autoReconnect: true,
		bellEnabled: false,
		destinations: [destination("alpha"), destination("beta", { reconnectSuppressed: true })],
	});
	assert.equal(Object.isFrozen(read), true);
	assert.equal(Object.isFrozen(read.destinations), true);
	assert.equal(Object.isFrozen(read.destinations[0]), true);
	assert.throws(() => {
		(read as { bellEnabled: boolean }).bellEnabled = true;
	}, TypeError);

	store.close();
	const reopened = openStore(fixture);
	assert.deepEqual(reopened.read(), read);
	reopened.close();
});

test("saving settings is independent of identity and the key/trust directory", (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(fixture);
	store.write({
		...DEFAULT_PEER_PREFERENCES,
		bellEnabled: false,
		autoReconnect: true,
	});
	assert.equal(existsSync(fixture.peersDir), false);
	assert.equal(existsSync(fixture.statePath), false);
	assert.equal(existsSync(preferencesPath(fixture)), true);
	const raw = JSON.parse(readFileSync(preferencesPath(fixture), "utf8")) as Record<string, unknown>;
	assert.equal(raw.version, PEER_PREFERENCES_VERSION);
	assert.equal(raw.bellEnabled, false);
	assert.equal(raw.autoReconnect, true);
	store.close();
});

test("unknown, malformed, or unsafe documents are refused untouched and never defaulted", (t) => {
	const cases: Array<{ name: string; text: string }> = [
		{ name: "invalid json", text: "{ not json" },
		{ name: "unknown version", text: JSON.stringify({ ...samplePreferences(), version: 2 }) },
		{ name: "unknown top-level field", text: JSON.stringify({ ...samplePreferences(), version: 1, extra: true }) },
		{
			name: "enabled hosting without an explicit endpoint",
			text: JSON.stringify({
				...samplePreferences(),
				version: 1,
				hosting: { enabled: true, bindHost: null, bindPort: null },
			}),
		},
		{
			name: "duplicate destination ids",
			text: JSON.stringify({
				...samplePreferences(),
				version: 1,
				destinations: [destination("same"), destination("same")],
			}),
		},
		{
			name: "destination port out of range",
			text: JSON.stringify({
				...samplePreferences(),
				version: 1,
				destinations: [destination("alpha", { port: 0 })],
			}),
		},
		{
			name: "destination label is not display-safe",
			text: JSON.stringify({
				...samplePreferences(),
				version: 1,
				destinations: [destination("alpha", { label: "bad\nlabel" })],
			}),
		},
		{
			name: "unknown destination field",
			text: JSON.stringify({
				...samplePreferences(),
				version: 1,
				destinations: [{ ...destination("alpha"), authority: "trusted" }],
			}),
		},
	];

	for (const testCase of cases) {
		const fixture = createAgentDirFixture(t);
		const path = writeRawDocument(fixture, testCase.text);
		const before = readFileSync(path);
		assert.throws(() => {
			const store = openStore(fixture);
			store.close();
		}, unavailableRefusal, testCase.name);
		assert.deepEqual(readFileSync(path), before, `${testCase.name}: the refused document is untouched`);
		assert.deepEqual(readdirSync(preferencesDir(fixture)), ["preferences.json"], testCase.name);
	}
});

test("a dedicated directory without its document, or a non-private one, is unavailable", (t) => {
	const missingDocument = createAgentDirFixture(t);
	mkdirSync(missingDocument.sessionHostDir, { mode: 0o700 });
	mkdirSync(preferencesDir(missingDocument), { mode: 0o700 });
	assert.throws(() => openStore(missingDocument), unavailableRefusal);
	assert.deepEqual(readdirSync(preferencesDir(missingDocument)), []);

	const publicDirectory = createAgentDirFixture(t);
	const policy = createPosixTestPolicy();
	const store = openStore(publicDirectory, policy);
	store.write(samplePreferences());
	store.close();
	// A second handle must refuse a directory that is no longer private.
	chmodSync(preferencesDir(publicDirectory), 0o755);
	assert.throws(() => openStore(publicDirectory), unavailableRefusal);
	chmodSync(preferencesDir(publicDirectory), 0o700);
});

test("a symlinked document is refused rather than followed", (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(fixture);
	store.write(samplePreferences());
	store.close();
	const path = preferencesPath(fixture);
	const target = join(fixture.root, "elsewhere.json");
	writeFileSync(target, JSON.stringify({ ...samplePreferences(), version: 1 }), { mode: 0o600 });
	unlinkSync(path);
	symlinkSync(target, path);
	assert.throws(() => openStore(fixture), unavailableRefusal);
});

test("a failed first write leaves no document and no protected temporary", (t) => {
	const fixture = createAgentDirFixture(t);
	const policy = createPosixTestPolicy();
	policy.fail = (call) => call.operation === "protectCreatedFile";
	const store = openStore(fixture, policy);
	assert.throws(() => store.write(samplePreferences()), (error) => (
		isPeerPreferencesError(error) && error.code === "PEER_PREFERENCES_WRITE_FAILED"
	));
	assert.equal(existsSync(preferencesPath(fixture)), false);
	assert.deepEqual(readdirSync(preferencesDir(fixture)), []);
	assert.equal(store.read(), null);
	store.close();
});

test("a failed replacement keeps the committed document and the handle usable", (t) => {
	const fixture = createAgentDirFixture(t);
	const policy = createPosixTestPolicy();
	const store = openStore(fixture, policy);
	store.write(samplePreferences());
	const committed = readFileSync(preferencesPath(fixture));

	policy.fail = (call) => call.operation === "protectCreatedFile";
	assert.throws(() => store.write({ ...samplePreferences(), bellEnabled: true }), isPeerPreferencesError);
	assert.deepEqual(readFileSync(preferencesPath(fixture)), committed, "the committed document is intact");
	assert.equal(store.read()?.bellEnabled, false, "memory never claims an unsaved value");

	policy.fail = null;
	store.write({ ...samplePreferences(), bellEnabled: true });
	assert.equal(store.read()?.bellEnabled, true);
	assert.equal((JSON.parse(readFileSync(preferencesPath(fixture), "utf8")) as { bellEnabled: boolean }).bellEnabled, true);
	store.close();
});

test("caller-built values are validated and bounded before any publication", (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(fixture);
	assert.throws(() => validatePeerPreferences(null), TypeError);
	assert.throws(() => validatePeerPreferences({ ...samplePreferences(), bellEnabled: "yes" }), TypeError);
	assert.throws(() => validatePeerPreferences({
		...samplePreferences(),
		destinations: [destination("alpha", { host: "bad host" })],
	}), TypeError);
	assert.throws(() => store.write({
		...DEFAULT_PEER_PREFERENCES,
		destinations: [destination("alpha", { port: 0 })],
	}), TypeError);
	assert.equal(existsSync(preferencesPath(fixture)), false, "invalid input is never published");

	const many: PeerDestination[] = [];
	for (let index = 0; index < MAX_PEER_DESTINATIONS; index += 1) many.push(destination(`host-${index}`));
	const bounded = validatePeerPreferences({ ...DEFAULT_PEER_PREFERENCES, destinations: many });
	assert.equal(bounded.destinations.length, MAX_PEER_DESTINATIONS);
	assert.throws(() => validatePeerPreferences({
		...DEFAULT_PEER_PREFERENCES,
		destinations: [...many, destination("one-too-many")],
	}), TypeError);

	// A detached immutable copy: later mutation of the caller's object is invisible.
	const source = samplePreferences();
	const validated = validatePeerPreferences(source);
	(source.destinations as PeerDestination[]).push(destination("late"));
	assert.equal(validated.destinations.length, 2);
	assert.equal(Object.isFrozen(validated.destinations[0]), true);
	store.close();
});
