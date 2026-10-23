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
		viewerNativeInputEnabled: true,
		remoteHistoryDeleteEnabled: true,
		destinations: [destination("alpha"), destination("beta", { reconnectSuppressed: true })],
	};
}

/**
 * A complete, valid version-1 document exactly as a build from before the two
 * optional default-on flags existed wrote it: neither flag key is present.
 */
function legacyDocumentText(): string {
	return `${JSON.stringify({
		version: 1,
		hosting: { enabled: false, bindHost: "127.0.0.1", bindPort: 40_000 },
		autoReconnect: true,
		bellEnabled: false,
		destinations: [destination("alpha")],
	})}\n`;
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

test("defaults are frozen: hosting and Auto off; bell, remote input/copy, and history deletion on", () => {
	assert.equal(Object.isFrozen(DEFAULT_PEER_PREFERENCES), true);
	assert.equal(Object.isFrozen(DEFAULT_PEER_PREFERENCES.hosting), true);
	assert.equal(DEFAULT_PEER_PREFERENCES.hosting.enabled, false);
	assert.equal(DEFAULT_PEER_PREFERENCES.autoReconnect, false);
	assert.equal(DEFAULT_PEER_PREFERENCES.bellEnabled, true);
	// A genuinely new installation is default ON for both deliberately changed flags.
	assert.equal(DEFAULT_PEER_PREFERENCES.viewerNativeInputEnabled, true);
	assert.equal(DEFAULT_PEER_PREFERENCES.remoteHistoryDeleteEnabled, true);
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
		viewerNativeInputEnabled: true,
		remoteHistoryDeleteEnabled: true,
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
		// A PRESENT optional default-on flag must be a real boolean: a malformed value
		// is never read as "absent" (on) and the document is never repaired.
		...([null, "false", "true", 0, 1, {}, []] as const).flatMap((value) => [
			{
				name: `viewerNativeInputEnabled ${JSON.stringify(value)}`,
				text: JSON.stringify({ ...samplePreferences(), version: 1, viewerNativeInputEnabled: value }),
			},
			{
				name: `remoteHistoryDeleteEnabled ${JSON.stringify(value)}`,
				text: JSON.stringify({ ...samplePreferences(), version: 1, remoteHistoryDeleteEnabled: value }),
			},
		]),
		{
			name: "a flag under an unknown spelling",
			text: JSON.stringify({ ...samplePreferences(), version: 1, viewerInputEnabled: false }),
		},
		{
			name: "valid flags but an unknown version",
			text: JSON.stringify({
				...samplePreferences(),
				version: 2,
				viewerNativeInputEnabled: false,
				remoteHistoryDeleteEnabled: false,
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

/**
 * Publish a protected document through the real store first, then replace only its
 * bytes in place (same inode and protection), exactly as an older build left it.
 */
function writeProtectedDocumentBytes(fixture: AgentDirFixture, text: string): string {
	const seed = openStore(fixture);
	seed.write(samplePreferences());
	seed.close();
	const path = preferencesPath(fixture);
	writeFileSync(path, text);
	return path;
}

test("an otherwise valid legacy document without the two flags reads both as on, untouched", (t) => {
	const fixture = createAgentDirFixture(t);
	const path = writeProtectedDocumentBytes(fixture, legacyDocumentText());
	const before = readFileSync(path);
	const store = openStore(fixture);
	const read = store.read();
	assert.ok(read);
	assert.equal(read.viewerNativeInputEnabled, true, "absent viewer input/copy is the default-on value");
	assert.equal(read.remoteHistoryDeleteEnabled, true, "absent history-deletion policy is the default-on value");
	assert.equal(read.bellEnabled, false, "every existing legacy field is preserved");
	assert.equal(read.autoReconnect, true);
	assert.deepEqual(read.destinations, [destination("alpha")]);
	assert.deepEqual(readFileSync(path), before, "reading never repairs or rewrites the legacy document");

	// An unrelated change keeps the sparse version-1 shape: still no flag keys.
	store.write({ ...read, bellEnabled: true });
	const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	assert.equal(raw.version, PEER_PREFERENCES_VERSION);
	assert.equal(Object.prototype.hasOwnProperty.call(raw, "viewerNativeInputEnabled"), false);
	assert.equal(Object.prototype.hasOwnProperty.call(raw, "remoteHistoryDeleteEnabled"), false);
	assert.equal(store.read()?.viewerNativeInputEnabled, true);
	assert.equal(store.read()?.remoteHistoryDeleteEnabled, true);
	store.close();
});

test("an explicit Off for each flag is written, independent, and survives a fresh handle", (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(fixture);
	store.write({ ...samplePreferences(), viewerNativeInputEnabled: false });
	let raw = JSON.parse(readFileSync(preferencesPath(fixture), "utf8")) as Record<string, unknown>;
	assert.equal(raw.viewerNativeInputEnabled, false, "only an explicit Off is persisted");
	assert.equal(Object.prototype.hasOwnProperty.call(raw, "remoteHistoryDeleteEnabled"), false,
		"the independent owner policy stays at its absent default-on shape");
	store.close();

	const reopened = openStore(fixture);
	const restarted = reopened.read();
	assert.equal(restarted?.viewerNativeInputEnabled, false, "explicit viewer Off is remembered across restarts");
	assert.equal(restarted?.remoteHistoryDeleteEnabled, true);
	assert.ok(restarted);
	reopened.write({ ...restarted, remoteHistoryDeleteEnabled: false });
	raw = JSON.parse(readFileSync(preferencesPath(fixture), "utf8")) as Record<string, unknown>;
	assert.equal(raw.viewerNativeInputEnabled, false, "an unrelated owner-policy change keeps the viewer Off");
	assert.equal(raw.remoteHistoryDeleteEnabled, false);
	reopened.close();

	const third = openStore(fixture);
	assert.equal(third.read()?.viewerNativeInputEnabled, false);
	assert.equal(third.read()?.remoteHistoryDeleteEnabled, false, "explicit owner Off is remembered across restarts");
	// Turning both back on returns to the sparse shape, still a valid document.
	const current = third.read();
	assert.ok(current);
	third.write({ ...current, viewerNativeInputEnabled: true, remoteHistoryDeleteEnabled: true });
	raw = JSON.parse(readFileSync(preferencesPath(fixture), "utf8")) as Record<string, unknown>;
	assert.equal(Object.prototype.hasOwnProperty.call(raw, "viewerNativeInputEnabled"), false);
	assert.equal(Object.prototype.hasOwnProperty.call(raw, "remoteHistoryDeleteEnabled"), false);
	third.close();
});

test("an explicitly written true flag is also valid and on", (t) => {
	const fixture = createAgentDirFixture(t);
	writeProtectedDocumentBytes(fixture, JSON.stringify({
		...samplePreferences(),
		version: 1,
		viewerNativeInputEnabled: true,
		remoteHistoryDeleteEnabled: true,
	}));
	const store = openStore(fixture);
	assert.equal(store.read()?.viewerNativeInputEnabled, true);
	assert.equal(store.read()?.remoteHistoryDeleteEnabled, true);
	store.close();
});

test("a failed replacement never claims an unsaved flag change in memory", (t) => {
	const fixture = createAgentDirFixture(t);
	const policy = createPosixTestPolicy();
	const store = openStore(fixture, policy);
	store.write(samplePreferences());
	const committed = readFileSync(preferencesPath(fixture));
	policy.fail = (call) => call.operation === "protectCreatedFile";
	assert.throws(() => store.write({ ...samplePreferences(), viewerNativeInputEnabled: false }), isPeerPreferencesError);
	assert.throws(() => store.write({ ...samplePreferences(), remoteHistoryDeleteEnabled: false }), isPeerPreferencesError);
	assert.deepEqual(readFileSync(preferencesPath(fixture)), committed);
	assert.equal(store.read()?.viewerNativeInputEnabled, true);
	assert.equal(store.read()?.remoteHistoryDeleteEnabled, true);
	store.close();
});

test("caller-built values must carry both flags as real booleans", (t) => {
	const fixture = createAgentDirFixture(t);
	const store = openStore(fixture);
	const withoutViewer: Record<string, unknown> = { ...samplePreferences() };
	delete withoutViewer.viewerNativeInputEnabled;
	const withoutHistory: Record<string, unknown> = { ...samplePreferences() };
	delete withoutHistory.remoteHistoryDeleteEnabled;
	// Absence is a programmer error for an in-memory value, never a silent default.
	assert.throws(() => validatePeerPreferences(withoutViewer), TypeError);
	assert.throws(() => validatePeerPreferences(withoutHistory), TypeError);
	assert.throws(() => validatePeerPreferences({ ...samplePreferences(), viewerNativeInputEnabled: "false" }), TypeError);
	assert.throws(() => validatePeerPreferences({ ...samplePreferences(), remoteHistoryDeleteEnabled: null }), TypeError);
	assert.throws(() => store.write(withoutViewer as unknown as PeerPreferences), TypeError);
	assert.equal(existsSync(preferencesPath(fixture)), false, "invalid input is never published");
	store.close();
});
