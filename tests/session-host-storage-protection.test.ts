/**
 * Focused tests for Network storage creation protection, sanitized storage
 * diagnostics, and the explicit remediation backend (Refs #494).
 *
 * POSIX cases use real directories, files, UIDs and modes under a temporary
 * root this test creates and removes; macOS ACL cases use real ACLs on that
 * fixture only. Windows cases are labelled fixtures: they drive the real TS
 * classification/orchestration with recorded helper responses and prove
 * nothing about NTFS — the native proofs live in
 * `session-host-storage-protection-windows-native.test.ts`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	fchmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inflateRawSync } from "node:zlib";

import { isPeerTransportError } from "../src/session-host/network/index";
import { isPeerPreferencesError, openPeerPreferencesStoreWithPermissions, DEFAULT_PEER_PREFERENCES } from "../src/session-host/network/peer-preferences-store";
import { createPeerStatePermissionPolicy, proveExtendedAcl } from "../src/session-host/network/peer-state-permissions";
import { openPeerStateStoreWithPermissions } from "../src/session-host/network/peer-state-store";
import {
	classifyOwnerControlledAclEvidence,
	KNOWN_ACCESS_MASK,
	type WindowsAclAceEvidence,
	type WindowsAclEvidence,
	type WindowsAclExecutor,
} from "../src/session-host/network/peer-state-windows-permissions";
import { peerStorageDiagnostic } from "../src/session-host/network/peer-storage-diagnostics";
import {
	assessPeerStorageProtection,
	PEER_STORAGE_REMEDIATION_HELPER_BOOTSTRAP,
	PEER_STORAGE_REMEDIATION_HELPER_SCRIPT,
	repairPeerStorageProtection,
	type PeerStorageRepairReport,
} from "../src/session-host/network/peer-storage-remediation";
import { createSessionHostStateDirectory, ensureHostStateDir } from "../src/session-host/roster-store";

const creator = require(path.join(process.cwd(), "scripts", "session-host-state-directory.cjs")) as {
	createPrivateStateDirectory: (target: string, probe?: Record<string, unknown>) => { outcome: string; reason?: string };
	stateDirectoryInternals: { WINDOWS_CREATE_SCRIPT: string };
};
const generations = require(path.join(process.cwd(), "scripts", "managed-generations.cjs")) as {
	holdAgentDirectory: (agentDir: string) => { release(): void } | undefined;
};

/** A host-absolute stand-in for the fixed system PowerShell; it is never spawned. */
const FAKE_EXECUTABLE = path.resolve(tmpdir(), "fixture-powershell.exe");

const POSIX_HOST = process.platform !== "win32" && typeof process.getuid === "function";
const POSIX_SKIP = POSIX_HOST ? false : "real owner/mode proof requires a POSIX host";
const ACL_SKIP = process.platform === "darwin" ? false : "real extended-ACL fixtures require macOS";

function root(t: { after: (fn: () => void) => void }): string {
	const dir = mkdtempSync(path.join(tmpdir(), "prg-storage-protection-"));
	t.after(() => {
		if (process.platform === "darwin") {
			const clear = (target: string): void => {
				try {
					execFileSync("/bin/chmod", ["-N", target], { stdio: "ignore", timeout: 15_000 });
				} catch {
					// Best effort on this test's own fixture.
				}
				let entries: string[] = [];
				try {
					if (lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink()) entries = readdirSync(target);
				} catch {
					entries = [];
				}
				for (const entry of entries) clear(path.join(target, entry));
			};
			clear(dir);
		}
		rmSync(dir, { recursive: true, force: true });
	});
	return realpathSync(dir);
}

function modeOf(target: string): number {
	return lstatSync(target).mode & 0o7777;
}

function agentFixture(t: { after: (fn: () => void) => void }): { agentDir: string; stateDir: string } {
	const base = root(t);
	const agentDir = path.join(base, "agent");
	mkdirSync(agentDir, { mode: 0o700 });
	return { agentDir, stateDir: path.join(agentDir, "session-host") };
}

/** A synthetic, structurally valid-looking existing Network layout (bytes are opaque here). */
function existingLayout(stateDir: string): Record<string, Buffer> {
	mkdirSync(stateDir, { mode: 0o700 });
	mkdirSync(path.join(stateDir, "peers"), { mode: 0o700 });
	mkdirSync(path.join(stateDir, "peer-preferences"), { mode: 0o700 });
	const files: Record<string, Buffer> = {
		"peers/state.json": Buffer.from("{\"opaque\":\"trust bytes are never decoded here\"}\n"),
		"peer-preferences/preferences.json": Buffer.from("{\"opaque\":\"preferences\",\"bellEnabled\":false}\n"),
		"roster.json": Buffer.from("{\"version\":1,\"entries\":[]}\n"),
		"host-shortcuts.json": Buffer.from("{}\n"),
		"unknown.bin": Buffer.from([0, 1, 2, 3]),
	};
	for (const [relative, bytes] of Object.entries(files)) {
		writeFileSync(path.join(stateDir, relative), bytes, { mode: 0o600 });
	}
	return files;
}

function inode(target: string): string {
	const stats = lstatSync(target, { bigint: true });
	return `${stats.dev}:${stats.ino}`;
}

function outcomes(report: PeerStorageRepairReport): Record<string, string> {
	return Object.fromEntries(report.targets.map((target) => [target.target, target.outcome]));
}

// ------------------------------------------------------------ creation

test("creator: an absent session-host is created exclusively, 0700, and verified", { skip: POSIX_SKIP }, (t) => {
	const { stateDir } = agentFixture(t);
	const created = creator.createPrivateStateDirectory(stateDir);
	if (process.platform === "linux" || process.platform === "darwin") {
		assert.deepEqual(created, { outcome: "created-protected" });
	}
	assert.equal(modeOf(stateDir), 0o700);
	assert.equal(lstatSync(stateDir).uid, process.getuid?.());
	assert.deepEqual(readdirSync(stateDir), []);
});

test("creator: an existing object is reported and never modified", { skip: POSIX_SKIP }, (t) => {
	const { agentDir, stateDir } = agentFixture(t);
	mkdirSync(stateDir);
	chmodSync(stateDir, 0o755);
	writeFileSync(path.join(stateDir, "roster.json"), "{}\n", { mode: 0o644 });
	const before = inode(stateDir);
	assert.deepEqual(creator.createPrivateStateDirectory(stateDir), { outcome: "existing" });
	assert.equal(modeOf(stateDir), 0o755, "existing storage keeps its permissions");
	assert.equal(modeOf(path.join(stateDir, "roster.json")), 0o644);
	assert.equal(inode(stateDir), before);

	// A symlink at the fixed name is existing, never followed, never repaired.
	const other = path.join(agentDir, "elsewhere");
	mkdirSync(other, { mode: 0o755 });
	const linked = path.join(agentDir, "linked-session-host");
	symlinkSync(other, linked);
	assert.deepEqual(creator.createPrivateStateDirectory(linked), { outcome: "existing" });
	assert.equal(modeOf(other), 0o755);
});

test("creator: a missing parent or relative path creates nothing", { skip: POSIX_SKIP }, (t) => {
	const { agentDir } = agentFixture(t);
	const missingParent = path.join(agentDir, "missing", "session-host");
	assert.equal(creator.createPrivateStateDirectory(missingParent).outcome, "failed");
	assert.throws(() => lstatSync(path.join(agentDir, "missing")));
	assert.equal(creator.createPrivateStateDirectory("relative/session-host").outcome, "failed");
});

test("creator: a setgid parent's inherited bit is reported unverified, never chmod'd", { skip: process.platform === "linux" ? false : "setgid directory inheritance is Linux-specific" }, (t) => {
	const { agentDir, stateDir } = agentFixture(t);
	chmodSync(agentDir, 0o2700);
	assert.deepEqual(creator.createPrivateStateDirectory(stateDir), { outcome: "created-unverified", reason: "unsafe-permissions" });
	assert.equal(modeOf(stateDir), 0o2700, "the created directory is left exactly as created");
	assert.equal(modeOf(agentDir), 0o2700, "the agent directory is never modified");
});

test("creator: a same-owner directory swapped in after mkdir is never modified", { skip: POSIX_SKIP }, (t) => {
	const { agentDir, stateDir } = agentFixture(t);
	const preExisting = path.join(agentDir, "pre-existing-empty");
	mkdirSync(preExisting);
	chmodSync(preExisting, 0o755);
	const preIdentity = inode(preExisting);
	let swapped = false;
	const created = creator.createPrivateStateDirectory(stateDir, {
		afterCreate: (target: string) => {
			swapped = true;
			execFileSync("/bin/mv", [target, path.join(agentDir, "moved-away")]);
			execFileSync("/bin/mv", [preExisting, target]);
		},
	});
	assert.ok(swapped);
	assert.deepEqual(created, { outcome: "created-unverified", reason: "unsafe-permissions" });
	assert.equal(inode(stateDir), preIdentity, "the swapped-in object is at the path");
	assert.equal(modeOf(stateDir), 0o755, "a pre-existing object is never chmod'd");
	assert.equal(modeOf(path.join(agentDir, "moved-away")), 0o700, "the created directory is untouched as well");
});

test("creator (macOS): an inherited extended ACL is never claimed protected", { skip: ACL_SKIP }, (t) => {
	const { agentDir, stateDir } = agentFixture(t);
	execFileSync("/bin/chmod", ["+a", "group:everyone allow list,add_file,search,directory_inherit", agentDir]);
	const created = creator.createPrivateStateDirectory(stateDir);
	assert.deepEqual(created, { outcome: "created-unverified", reason: "extended-acl" });
	assert.ok(lstatSync(stateDir).isDirectory(), "local use keeps the created directory");
	// The Network store refuses it with a fixed, sanitized reason.
	assert.throws(
		() => openPeerPreferencesStoreWithPermissions({ agentDir, permissions: createPeerStatePermissionPolicy() }),
		(error: unknown) => {
			assert.ok(isPeerPreferencesError(error));
			assert.deepEqual(peerStorageDiagnostic(error), { reason: "extended-acl", object: "session-host" });
			return true;
		},
	);
});

test("creator (Windows fixtures): fixed secure-at-creation script; outcomes are mapped strictly", (t) => {
	const script = creator.stateDirectoryInternals.WINDOWS_CREATE_SCRIPT;
	assert.match(script, /CreateDirectoryW/u, "exclusive native creation");
	assert.match(script, /D:P\(A;OICI;FA;;;' \+ \$current \+ '\)\(A;OICI;FA;;;SY\)\(A;OICI;FA;;;BA\)/u, "protected DACL for exactly three principals");
	assert.match(script, /0x02200000/u, "verification opens the reparse point itself");
	assert.doesNotMatch(script, /SetKernelObjectSecurity|SetAccessControl|SetSecurityInfo/u, "creation never edits an existing descriptor");
	const base = root(t);
	const target = path.join(base, "never-created");
	const calls: { args: readonly string[]; input: string }[] = [];
	const respond = (stdout: string, status = 0) => (file: string, args: readonly string[], options: { input: string }) => {
		calls.push({ args, input: options.input });
		return { status, stdout };
	};
	const probe = (spawn: unknown) => ({ platform: "win32", resolvePowerShell: () => "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", spawn });
	const win = "C:\\Users\\someone\\.pi\\agent\\session-host";
	assert.deepEqual(creator.createPrivateStateDirectory(win, probe(respond("{\"v\":1,\"outcome\":\"created-protected\"}"))), { outcome: "created-protected" });
	assert.ok(calls.every((call) => !call.args.join(" ").includes("session-host")), "the path never reaches argv");
	assert.ok(calls.every((call) => call.args.join(" ").length < 30_000), "the creator command stays well below Windows' command-line limit");
	assert.ok(calls.every((call) => /^[\x20-\x7e]*$/u.test(call.input)), "stdin is pure ASCII JSON");
	assert.deepEqual(creator.createPrivateStateDirectory(win, probe(respond("{\"v\":1,\"outcome\":\"existing\"}"))), { outcome: "existing" });
	assert.deepEqual(
		creator.createPrivateStateDirectory(win, probe(respond("{\"v\":1,\"outcome\":\"created-unverified\"}"))),
		{ outcome: "created-unverified", reason: "unsafe-permissions" },
	);
	assert.equal(creator.createPrivateStateDirectory(win, probe(respond("{\"v\":2,\"outcome\":\"created-protected\"}"))).outcome, "failed");
	assert.equal(creator.createPrivateStateDirectory(win, probe(respond("", 3))).outcome, "failed");
	assert.equal(creator.createPrivateStateDirectory(win, { platform: "win32", resolvePowerShell: () => null }).outcome, "failed");
	assert.throws(() => lstatSync(target));
});

test("earliest creators: roster, shortcut, and launcher coordination create private; existing is untouched", { skip: POSIX_SKIP }, (t) => {
	const loaded = agentFixture(t);
	// The compiled wrapper really reaches the shared creator (a plain mkdir
	// fallback would also give 0700, so the outcome itself is asserted).
	assert.deepEqual(createSessionHostStateDirectory(loaded.stateDir), { outcome: "created-protected" });

	const fresh = agentFixture(t);
	assert.equal(ensureHostStateDir(fresh.agentDir), fresh.stateDir);
	assert.equal(modeOf(fresh.stateDir), 0o700);

	const launcher = agentFixture(t);
	const held = generations.holdAgentDirectory(launcher.agentDir);
	assert.ok(held !== undefined, "coordination still works exactly as before");
	held.release();
	assert.equal(modeOf(launcher.stateDir), 0o700);

	const existing = agentFixture(t);
	mkdirSync(existing.stateDir);
	chmodSync(existing.stateDir, 0o755);
	ensureHostStateDir(existing.agentDir);
	const again = generations.holdAgentDirectory(existing.agentDir);
	again?.release();
	assert.equal(modeOf(existing.stateDir), 0o755, "pre-existing storage is never altered automatically");
	assert.deepEqual(createSessionHostStateDirectory(existing.stateDir), { outcome: "existing" });
});

test("Network base creation is private at creation even under a broadly writable agent directory", { skip: POSIX_SKIP }, (t) => {
	const { agentDir, stateDir } = agentFixture(t);
	chmodSync(agentDir, 0o777);
	const store = openPeerPreferencesStoreWithPermissions({ agentDir, permissions: createPeerStatePermissionPolicy() });
	assert.equal(store.read(), null);
	assert.throws(() => lstatSync(stateDir), "opening creates nothing");
	store.write({ ...DEFAULT_PEER_PREFERENCES, bellEnabled: false });
	store.close();
	assert.equal(modeOf(stateDir), 0o700);
	assert.equal(modeOf(path.join(stateDir, "peer-preferences")), 0o700);
	assert.equal(modeOf(path.join(stateDir, "peer-preferences", "preferences.json")), 0o600);
	assert.equal(modeOf(agentDir), 0o777, "the agent directory is never modified");
	assert.throws(() => lstatSync(path.join(stateDir, "peers")), "no trust directory or key is created");
	const reopened = openPeerPreferencesStoreWithPermissions({ agentDir, permissions: createPeerStatePermissionPolicy() });
	assert.equal(reopened.read()?.bellEnabled, false);
	reopened.close();
});

// --------------------------------------------------------- diagnostics

function trustDiagnostic(agentDir: string): unknown {
	try {
		openPeerStateStoreWithPermissions({ agentDir, permissions: createPeerStatePermissionPolicy() }).close();
	} catch (error) {
		assert.ok(isPeerTransportError(error));
		assert.equal(error.code, "TRUST_STORE_FAILED");
		assert.equal(error.message, "injected peer trust store failed");
		return peerStorageDiagnostic(error);
	}
	return "opened";
}

function preferencesDiagnostic(agentDir: string): unknown {
	try {
		openPeerPreferencesStoreWithPermissions({ agentDir, permissions: createPeerStatePermissionPolicy() }).close();
	} catch (error) {
		assert.ok(isPeerPreferencesError(error));
		assert.equal(error.code, "PEER_PREFERENCES_UNAVAILABLE");
		return peerStorageDiagnostic(error);
	}
	return "opened";
}

test("diagnostics: store refusals keep their public codes and add a fixed reason and object", { skip: POSIX_SKIP }, (t) => {
	const broad = agentFixture(t);
	mkdirSync(broad.stateDir);
	chmodSync(broad.stateDir, 0o777);
	assert.deepEqual(trustDiagnostic(broad.agentDir), { reason: "unsafe-permissions", object: "session-host" });
	assert.deepEqual(preferencesDiagnostic(broad.agentDir), { reason: "unsafe-permissions", object: "session-host" });

	const missing = agentFixture(t);
	mkdirSync(path.join(missing.stateDir, "peers"), { recursive: true, mode: 0o700 });
	chmodSync(missing.stateDir, 0o700);
	assert.deepEqual(trustDiagnostic(missing.agentDir), { reason: "missing-initialized", object: "peer-state" });

	const malformed = agentFixture(t);
	mkdirSync(path.join(malformed.stateDir, "peer-preferences"), { recursive: true, mode: 0o700 });
	writeFileSync(path.join(malformed.stateDir, "peer-preferences", "preferences.json"), "{not json", { mode: 0o600 });
	assert.deepEqual(preferencesDiagnostic(malformed.agentDir), { reason: "malformed", object: "preferences-document" });

	const broadFile = agentFixture(t);
	mkdirSync(path.join(broadFile.stateDir, "peers"), { recursive: true, mode: 0o700 });
	writeFileSync(path.join(broadFile.stateDir, "peers", "state.json"), "{}", { mode: 0o644 });
	chmodSync(path.join(broadFile.stateDir, "peers", "state.json"), 0o644);
	assert.deepEqual(trustDiagnostic(broadFile.agentDir), { reason: "unsafe-permissions", object: "peer-state" });

	const linked = agentFixture(t);
	mkdirSync(linked.stateDir, { mode: 0o700 });
	const elsewhere = path.join(linked.agentDir, "elsewhere");
	mkdirSync(elsewhere, { mode: 0o700 });
	symlinkSync(elsewhere, path.join(linked.stateDir, "peers"));
	assert.deepEqual(trustDiagnostic(linked.agentDir), { reason: "unsafe-object", object: "peers" });

	const hardlinked = agentFixture(t);
	mkdirSync(path.join(hardlinked.stateDir, "peer-preferences"), { recursive: true, mode: 0o700 });
	const document = path.join(hardlinked.stateDir, "peer-preferences", "preferences.json");
	writeFileSync(document, "{}", { mode: 0o600 });
	linkSync(document, path.join(hardlinked.agentDir, "second-name"));
	assert.deepEqual(preferencesDiagnostic(hardlinked.agentDir), { reason: "unsafe-object", object: "preferences-document" });
});

test("diagnostics: a creation refusal on an unsafe base names the base, not the child", { skip: POSIX_SKIP }, async (t) => {
	const fixture = agentFixture(t);
	mkdirSync(fixture.stateDir);
	chmodSync(fixture.stateDir, 0o775);
	const real = createPeerStatePermissionPolicy();
	// Admit the base at open and at the store's own base check so the real
	// policy's protectCreatedDirectory is the check that refuses — on its parent.
	const policy = { ...real, assertOwnerControlledDirectory: () => undefined };
	const store = openPeerStateStoreWithPermissions({ agentDir: fixture.agentDir, permissions: policy });
	await assert.rejects(store.initializeIdentity("host"), (error: unknown) => {
		assert.ok(isPeerTransportError(error));
		assert.equal(error.code, "TRUST_STORE_FAILED");
		assert.deepEqual(peerStorageDiagnostic(error), { reason: "unsafe-permissions", object: "session-host" });
		return true;
	});
	store.close();
	assert.equal(modeOf(fixture.stateDir), 0o775, "a refusal never repairs the base");
	assert.deepEqual(readdirSync(path.join(fixture.stateDir, "peers")), [], "no key material was written");

	assert.deepEqual(trustDiagnostic(fixture.agentDir), { reason: "unsafe-permissions", object: "session-host" }, "the real open names the base too");
});

test("diagnostics (Windows fixtures): inherited ordinary-account Modify on the base is unsafe-permissions", () => {
	const current = "S-1-5-21-1-2-3-1001";
	const ace = (sid: string, rights: number, inherited = true): WindowsAclAceEvidence =>
		({ sid, aceType: "allow", rights, inherit: 3, propagate: 0, inherited });
	const aces = [ace(current, 0x001f01ff), ace("S-1-5-18", 0x001f01ff), ace("S-1-5-32-544", 0x001f01ff), ace("S-1-5-11", 0x001301bf)];
	const evidence: WindowsAclEvidence = {
		isDirectory: true,
		isReparsePoint: false,
		entryCount: 2,
		fileLength: 0,
		ownerSid: current,
		daclPresent: true,
		daclProtected: false,
		daclAceCount: aces.length,
		daclAllowCount: aces.length,
		daclDenyCount: 0,
		daclOtherCount: 0,
		aces,
		parentExists: true,
		parentIsReparsePoint: false,
	};
	assert.equal(classifyOwnerControlledAclEvidence(evidence, current), "unsafe-permissions");
	assert.equal(classifyOwnerControlledAclEvidence({ ...evidence, aces: aces.slice(0, 3), daclAceCount: 3, daclAllowCount: 3 }, current), null);
	assert.equal(classifyOwnerControlledAclEvidence({ ...evidence, isReparsePoint: true }, current), "unsafe-object");
	assert.equal(classifyOwnerControlledAclEvidence({ ...evidence, ownerSid: "S-1-5-21-9-9-9-1002" }, current), "foreign-owner");
	assert.equal(classifyOwnerControlledAclEvidence({ ...evidence, daclOtherCount: 1, daclAceCount: 5 }, current), "protection-unsupported");

	const policy = createPeerStatePermissionPolicy({
		platform: "win32",
		windows: {
			resolveExecutable: () => FAKE_EXECUTABLE,
			execute: () => ({ status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: current, evidence }) }),
		},
	});
	assert.throws(() => policy.assertOwnerControlledDirectory("C:\\Users\\someone\\.pi\\agent\\session-host"), (error: unknown) => {
		assert.ok(isPeerTransportError(error));
		assert.equal(error.code, "TRUST_STORE_FAILED");
		assert.deepEqual(peerStorageDiagnostic(error), { reason: "unsafe-permissions", object: null });
		assert.ok(!String(error.stack).includes("S-1-5"), "no SID leaks");
		return true;
	});
	const unavailable = createPeerStatePermissionPolicy({ platform: "win32", windows: { resolveExecutable: () => null } });
	assert.throws(() => unavailable.assertPrivateDirectory("C:\\x\\peers"), (error: unknown) => {
		assert.deepEqual(peerStorageDiagnostic(error), { reason: "protection-unsupported", object: null });
		return true;
	});
});

// --------------------------------------------------- POSIX remediation

test("remediation (POSIX): tightens only the fixed targets, preserving bytes, identity, and unrelated files", { skip: POSIX_SKIP }, (t) => {
	const { agentDir, stateDir } = agentFixture(t);
	const files = existingLayout(stateDir);
	chmodSync(stateDir, 0o777);
	chmodSync(path.join(stateDir, "peers"), 0o750);
	chmodSync(path.join(stateDir, "peers", "state.json"), 0o644);
	chmodSync(path.join(stateDir, "peer-preferences"), 0o755);
	chmodSync(path.join(stateDir, "peer-preferences", "preferences.json"), 0o640);
	chmodSync(path.join(stateDir, "roster.json"), 0o644);
	chmodSync(path.join(stateDir, "unknown.bin"), 0o666);
	const identities = Object.fromEntries(Object.keys(files).map((relative) => [relative, inode(path.join(stateDir, relative))]));
	const stateIdentity = inode(stateDir);
	const agentMode = modeOf(agentDir);

	const assessment = assessPeerStorageProtection({ agentDir });
	assert.equal(assessment.repairable, true);
	assert.equal(assessment.blocked, null);
	assert.deepEqual(assessment.targets.map((target) => [target.target, target.status, target.reason]), [
		["session-host", "repairable", "unsafe-permissions"],
		["peers", "repairable", "unsafe-permissions"],
		["peer-state", "repairable", "unsafe-permissions"],
		["peer-preferences", "repairable", "unsafe-permissions"],
		["preferences-document", "repairable", "unsafe-permissions"],
	]);
	assert.equal(modeOf(stateDir), 0o777, "assessment changes nothing");

	const report = repairPeerStorageProtection({ agentDir });
	assert.equal(report.outcome, "repaired");
	assert.equal(report.changed, true);
	assert.equal(report.restartRequired, true);
	assert.equal(report.priorExposurePossible, true);
	assert.ok(Object.values(outcomes(report)).every((outcome) => outcome === "repaired"));
	assert.equal(modeOf(stateDir), 0o700);
	assert.equal(modeOf(path.join(stateDir, "peers")), 0o700);
	assert.equal(modeOf(path.join(stateDir, "peers", "state.json")), 0o600);
	assert.equal(modeOf(path.join(stateDir, "peer-preferences")), 0o700);
	assert.equal(modeOf(path.join(stateDir, "peer-preferences", "preferences.json")), 0o600);
	assert.equal(modeOf(path.join(stateDir, "roster.json")), 0o644, "unrelated children are never touched");
	assert.equal(modeOf(path.join(stateDir, "unknown.bin")), 0o666, "unknown files are never touched");
	assert.equal(modeOf(agentDir), agentMode, "the agent directory is never touched");
	assert.equal(inode(stateDir), stateIdentity);
	for (const [relative, bytes] of Object.entries(files)) {
		assert.deepEqual(readFileSync(path.join(stateDir, relative)), bytes, `${relative} bytes are preserved`);
		assert.equal(inode(path.join(stateDir, relative)), identities[relative], `${relative} identity is preserved`);
	}
	assert.deepEqual(readdirSync(stateDir).sort(), ["host-shortcuts.json", "peer-preferences", "peers", "roster.json", "unknown.bin"]);

	const again = repairPeerStorageProtection({ agentDir });
	assert.equal(again.outcome, "nothing-to-repair");
	assert.equal(again.changed, false);
	assert.equal(again.restartRequired, false);
});

test("remediation (POSIX): absent storage stays absent; a missing initialized document stays unavailable", { skip: POSIX_SKIP }, (t) => {
	const empty = agentFixture(t);
	const none = repairPeerStorageProtection({ agentDir: empty.agentDir });
	assert.equal(none.outcome, "nothing-to-repair");
	assert.ok(Object.values(outcomes(none)).every((outcome) => outcome === "absent"));
	assert.throws(() => lstatSync(empty.stateDir), "nothing is created");
	assert.equal(repairPeerStorageProtection({ agentDir: path.join(empty.agentDir, "nope") }).outcome, "nothing-to-repair");

	const partial = agentFixture(t);
	mkdirSync(path.join(partial.stateDir, "peers"), { recursive: true });
	chmodSync(partial.stateDir, 0o755);
	chmodSync(path.join(partial.stateDir, "peers"), 0o755);
	const report = repairPeerStorageProtection({ agentDir: partial.agentDir });
	assert.equal(report.outcome, "repaired");
	assert.deepEqual(report.targets.map((target) => [target.target, target.outcome, target.reason]), [
		["session-host", "already-protected", null],
		["peers", "repaired", null],
		["peer-state", "absent", "missing-initialized"],
		["peer-preferences", "absent", null],
		["preferences-document", "absent", null],
	]);
	assert.equal(modeOf(partial.stateDir), 0o755, "a base that already meets the store requirement is left alone");
	assert.deepEqual(readdirSync(path.join(partial.stateDir, "peers")), [], "no document or key is created");
	assert.throws(() => lstatSync(path.join(partial.stateDir, "peer-preferences")));
	assert.deepEqual(trustDiagnostic(partial.agentDir), { reason: "missing-initialized", object: "peer-state" });
});

test("remediation (POSIX): any refused target refuses the whole repair before anything changes", { skip: POSIX_SKIP }, (t) => {
	const cases: { name: string; arrange: (stateDir: string, agentDir: string) => void; target: string; reason: string }[] = [
		{
			name: "symlinked document",
			arrange: (stateDir, agentDir) => {
				rmSync(path.join(stateDir, "peers", "state.json"));
				writeFileSync(path.join(agentDir, "outside.json"), "{}", { mode: 0o644 });
				symlinkSync(path.join(agentDir, "outside.json"), path.join(stateDir, "peers", "state.json"));
			},
			target: "peer-state",
			reason: "unsafe-object",
		},
		{
			name: "hard-linked document",
			arrange: (stateDir, agentDir) => linkSync(path.join(stateDir, "peer-preferences", "preferences.json"), path.join(agentDir, "second-name")),
			target: "preferences-document",
			reason: "unsafe-object",
		},
		{
			name: "empty document",
			arrange: (stateDir) => writeFileSync(path.join(stateDir, "peers", "state.json"), ""),
			target: "peer-state",
			reason: "malformed",
		},
		{
			name: "oversized document",
			arrange: (stateDir) => writeFileSync(path.join(stateDir, "peer-preferences", "preferences.json"), Buffer.alloc(64 * 1024 + 1, 0x20)),
			target: "preferences-document",
			reason: "malformed",
		},
		{
			name: "directory where a document belongs",
			arrange: (stateDir) => {
				rmSync(path.join(stateDir, "peers", "state.json"));
				mkdirSync(path.join(stateDir, "peers", "state.json"));
			},
			target: "peer-state",
			reason: "unsafe-object",
		},
		{
			name: "unreadable document",
			arrange: (stateDir) => chmodSync(path.join(stateDir, "peers", "state.json"), 0o000),
			target: "peer-state",
			reason: "unreadable",
		},
	];
	for (const entry of cases) {
		if (entry.reason === "unreadable" && process.getuid?.() === 0) continue;
		const { agentDir, stateDir } = agentFixture(t);
		existingLayout(stateDir);
		chmodSync(stateDir, 0o777);
		entry.arrange(stateDir, agentDir);
		const report = repairPeerStorageProtection({ agentDir });
		assert.equal(report.outcome, "refused", entry.name);
		assert.equal(report.changed, false, entry.name);
		assert.equal(report.restartRequired, false, entry.name);
		const refused = report.targets.find((target) => target.outcome === "refused");
		assert.deepEqual(refused && [refused.target, refused.reason], [entry.target, entry.reason], entry.name);
		assert.equal(modeOf(stateDir), 0o777, `${entry.name}: nothing was repaired`);
		if (entry.reason === "unreadable") chmodSync(path.join(stateDir, "peers", "state.json"), 0o600);
	}

	const linkedBase = agentFixture(t);
	const real = path.join(linkedBase.agentDir, "real-session-host");
	mkdirSync(real, { mode: 0o777 });
	chmodSync(real, 0o777);
	symlinkSync(real, linkedBase.stateDir);
	const linkedReport = repairPeerStorageProtection({ agentDir: linkedBase.agentDir });
	assert.equal(linkedReport.outcome, "refused");
	assert.deepEqual(linkedReport.targets.map((target) => target.outcome), ["refused", "not-assessed", "not-assessed", "not-assessed", "not-assessed"]);
	assert.equal(modeOf(real), 0o777, "a linked base is never followed");
});

test("remediation (POSIX): a failure after a mutation reports a possible partial change and stops", { skip: POSIX_SKIP }, (t) => {
	const { agentDir, stateDir } = agentFixture(t);
	existingLayout(stateDir);
	chmodSync(stateDir, 0o777);
	chmodSync(path.join(stateDir, "peers"), 0o755);
	chmodSync(path.join(stateDir, "peer-preferences"), 0o755);
	let calls = 0;
	const report = repairPeerStorageProtection({ agentDir }, {
		fchmod: (fd, mode) => {
			calls += 1;
			// The second mutation "fails" after being issued: the OS reports success
			// for a different mode, so post-verification cannot prove protection.
			execFileSync("/bin/chmod", [calls === 2 ? "0750" : mode.toString(8), calls === 1 ? stateDir : path.join(stateDir, "peers")]);
			void fd;
		},
	});
	assert.equal(report.outcome, "partial");
	assert.equal(report.changed, true);
	assert.equal(report.restartRequired, true);
	assert.deepEqual(report.targets.map((target) => [target.target, target.outcome]), [
		["session-host", "repaired"],
		["peers", "failed-possibly-changed"],
		["peer-state", "already-protected"],
		["peer-preferences", "not-attempted"],
		["preferences-document", "already-protected"],
	]);
	assert.equal(report.targets[1]?.reason, "unsafe-permissions");
	assert.equal(modeOf(stateDir), 0o700, "nothing is rolled back");
	assert.equal(modeOf(path.join(stateDir, "peer-preferences")), 0o755, "later targets are not attempted");
});

test("remediation (macOS): an object replaced between assessment and mutation is never modified", { skip: ACL_SKIP }, (t) => {
	const { agentDir, stateDir } = agentFixture(t);
	existingLayout(stateDir);
	const preferencesId = inode(path.join(stateDir, "peer-preferences", "preferences.json"));
	const peers = path.join(stateDir, "peers");
	chmodSync(peers, 0o755);
	let swapped = false;
	const report = repairPeerStorageProtection({ agentDir }, {
		// The ACL listing seam runs once per target during assessment (by file ID);
		// the last assessment read swaps `peers` for a different directory before repair.
		platform: "darwin",
		acl: {
			resolveTool: () => "/bin/ls",
			execute: (_tool, args) => {
				const target = args[args.length - 1] ?? "";
				if (!swapped && inode(target) === preferencesId) {
					swapped = true;
					execFileSync("/bin/mv", [peers, path.join(stateDir, "peers-assessed")]);
					mkdirSync(peers);
					chmodSync(peers, 0o755);
				}
				return { status: 0, stdout: "drwx------  2 user  staff  64 Jan  1 00:00 x\n" };
			},
		},
		fchmod: () => {
			throw new Error("a replaced object must never reach the mutation");
		},
	});
	assert.ok(swapped);
	assert.equal(report.outcome, "refused");
	assert.equal(report.changed, false);
	assert.deepEqual(report.targets.map((target) => [target.target, target.outcome, target.reason]), [
		["session-host", "already-protected", null],
		["peers", "failed-unchanged", "changed"],
		// The assessed document left its fixed path with the swapped directory, so
		// the final re-proof never reports it protected.
		["peer-state", "unverified", "changed"],
		["peer-preferences", "already-protected", null],
		["preferences-document", "already-protected", null],
	]);
	assert.equal(modeOf(peers), 0o755, "the replacement is never modified");
	assert.equal(modeOf(path.join(stateDir, "peers-assessed")), 0o755, "the moved original is never modified");
});

// ------------------------------------------- macOS ACL remediation (real)

/** The entry lines of a real `ls -lde` listing (empty when the object has no ACL). */
function aclEntries(target: string): string[] {
	const listing = execFileSync("/bin/ls", ["-lde", target], { encoding: "utf8", env: { LC_ALL: "C", LANG: "C" } });
	const lines = listing.split("\n").filter((line) => line.trim().length > 0);
	assert.ok(!/\+$/u.test(lines[0]?.trim().split(/\s+/u)[0] ?? "") || lines.length > 1, "an ACL marker always lists entries");
	return lines.slice(1).map((line) => line.trim());
}

function addAcl(target: string, entry: string): void {
	execFileSync("/bin/chmod", ["+a", entry, target]);
}

/** The real descriptor-bound removal, run by a test seam on the descriptor it was handed. */
function removeThroughDescriptor(fd: number): void {
	execFileSync("/bin/chmod", ["-h", "-N", "/dev/fd/3"], { stdio: ["ignore", "ignore", "ignore", fd], cwd: "/", timeout: 15_000 });
}

/**
 * Real macOS layout whose five fixed targets all carry granting ACLs: plain
 * entries, inheritable entries, and entries inherited at creation. Unrelated
 * children created under the inheritable ACLs carry inherited copies too.
 */
function grantingAclLayout(t: { after: (fn: () => void) => void }): { agentDir: string; stateDir: string; files: Record<string, Buffer> } {
	const { agentDir, stateDir } = agentFixture(t);
	const files = existingLayout(stateDir);
	const preferencesDir = path.join(stateDir, "peer-preferences");
	chmodSync(stateDir, 0o755);
	addAcl(stateDir, "group:everyone allow list,add_file,search,file_inherit,directory_inherit");
	addAcl(path.join(stateDir, "peers"), "group:everyone allow list,search");
	addAcl(path.join(stateDir, "peers", "state.json"), "group:staff allow read,write");
	addAcl(preferencesDir, "group:everyone allow read,write,file_inherit");
	// Recreated under the inheritable ACLs, so each holds `inherited` entries.
	const preferencesDocument = path.join(preferencesDir, "preferences.json");
	rmSync(preferencesDocument);
	writeFileSync(preferencesDocument, files["peer-preferences/preferences.json"] as Buffer, { mode: 0o644 });
	chmodSync(preferencesDocument, 0o644);
	rmSync(path.join(stateDir, "roster.json"));
	writeFileSync(path.join(stateDir, "roster.json"), files["roster.json"] as Buffer, { mode: 0o600 });
	return { agentDir, stateDir, files };
}

test("remediation (macOS): granting ACLs are removed through the held descriptor; bytes, identity, and other objects are preserved", { skip: ACL_SKIP }, (t) => {
	const { agentDir, stateDir, files } = grantingAclLayout(t);
	const fixed = ["", "peers", "peers/state.json", "peer-preferences", "peer-preferences/preferences.json"].map((relative) => path.join(stateDir, relative));
	assert.ok(aclEntries(path.join(stateDir, "peer-preferences", "preferences.json")).some((entry) => / inherited allow /u.test(entry)), "fixture has an inherited grant");
	const rosterAcl = aclEntries(path.join(stateDir, "roster.json"));
	assert.ok(rosterAcl.some((entry) => / inherited allow /u.test(entry)), "an unrelated child inherited the base grant");
	const agentAcl = aclEntries(agentDir);
	const identities = Object.fromEntries(Object.keys(files).map((relative) => [relative, inode(path.join(stateDir, relative))]));
	const stateIdentity = inode(stateDir);
	const policy = createPeerStatePermissionPolicy();
	assert.throws(() => policy.assertOwnerControlledDirectory(stateDir), (error: unknown) => peerStorageDiagnostic(error)?.reason === "extended-acl");

	const assessment = assessPeerStorageProtection({ agentDir });
	assert.deepEqual(assessment.targets.map((target) => [target.target, target.status, target.reason]), [
		["session-host", "repairable", "extended-acl"],
		["peers", "repairable", "extended-acl"],
		["peer-state", "repairable", "extended-acl"],
		["peer-preferences", "repairable", "extended-acl"],
		["preferences-document", "repairable", "unsafe-permissions"],
	]);
	assert.equal(assessment.repairable, true);
	assert.ok(aclEntries(stateDir).length > 0, "assessment changes nothing");

	const report = repairPeerStorageProtection({ agentDir });
	assert.equal(report.outcome, "repaired");
	assert.equal(report.changed, true);
	assert.equal(report.restartRequired, true);
	assert.equal(report.priorExposurePossible, true);
	assert.ok(Object.values(outcomes(report)).every((outcome) => outcome === "repaired"), JSON.stringify(report.targets));
	for (const target of fixed) assert.deepEqual(aclEntries(target), [], `${target}: the ACL was removed`);
	assert.equal(modeOf(stateDir), 0o755, "an acceptable base mode is not changed");
	assert.equal(modeOf(path.join(stateDir, "peers")), 0o700);
	assert.equal(modeOf(path.join(stateDir, "peers", "state.json")), 0o600);
	assert.equal(modeOf(path.join(stateDir, "peer-preferences", "preferences.json")), 0o600);
	assert.deepEqual(aclEntries(path.join(stateDir, "roster.json")), rosterAcl, "an unrelated child keeps its inherited copy");
	assert.deepEqual(aclEntries(agentDir), agentAcl, "the agent directory is never touched");
	assert.equal(inode(stateDir), stateIdentity);
	for (const [relative, bytes] of Object.entries(files)) {
		assert.deepEqual(readFileSync(path.join(stateDir, relative)), bytes, `${relative} bytes are preserved`);
		assert.equal(inode(path.join(stateDir, relative)), identities[relative], `${relative} identity is preserved`);
	}
	// The ordinary, no-repair policy now admits every fixed object as it is.
	policy.assertOwnerControlledDirectory(stateDir);
	policy.assertPrivateDirectory(path.join(stateDir, "peers"));
	policy.assertPrivateFile(path.join(stateDir, "peers", "state.json"));
	policy.assertPrivateDirectory(path.join(stateDir, "peer-preferences"));
	policy.assertPrivateFile(path.join(stateDir, "peer-preferences", "preferences.json"));
	assert.equal(repairPeerStorageProtection({ agentDir }).outcome, "nothing-to-repair");
});

test("remediation (macOS): a removal runs on the held object only; a replacement at the path is never modified", { skip: ACL_SKIP }, (t) => {
	const { agentDir, stateDir } = agentFixture(t);
	const files = existingLayout(stateDir);
	const peers = path.join(stateDir, "peers");
	const held = path.join(stateDir, "peers-held");
	const heldIdentity = inode(peers);
	addAcl(peers, "group:everyone allow list,search");
	let calls = 0;
	const report = repairPeerStorageProtection({ agentDir }, {
		removeExtendedAcl: (fd) => {
			calls += 1;
			// The assessed object moves away and a decoy with a granting ACL takes its
			// name before the descriptor-bound removal runs.
			execFileSync("/bin/mv", [peers, held]);
			mkdirSync(peers, { mode: 0o700 });
			addAcl(peers, "group:everyone allow list,search");
			removeThroughDescriptor(fd);
		},
	});
	assert.equal(calls, 1);
	assert.deepEqual(aclEntries(held), [], "the held object's ACL was removed");
	assert.deepEqual(aclEntries(peers), ["0: group:everyone allow list,search"], "the decoy at the path is untouched");
	assert.equal(inode(held), heldIdentity);
	assert.deepEqual(readFileSync(path.join(held, "state.json")), files["peers/state.json"], "held bytes are preserved");
	assert.deepEqual(readdirSync(peers), [], "nothing is created in the decoy");
	assert.equal(report.outcome, "partial");
	assert.equal(report.changed, true);
	assert.deepEqual(report.targets.map((target) => [target.target, target.outcome, target.reason]), [
		["session-host", "already-protected", null],
		["peers", "failed-possibly-changed", "changed"],
		["peer-state", "unverified", "changed"],
		["peer-preferences", "already-protected", null],
		["preferences-document", "already-protected", null],
	]);
});

test("remediation (macOS): a removal that does not land or fails is possibly changed, stops, and is never reported protected", { skip: ACL_SKIP }, (t) => {
	for (const mode of ["no-op", "throws"] as const) {
		const { agentDir, stateDir } = agentFixture(t);
		existingLayout(stateDir);
		chmodSync(stateDir, 0o755);
		addAcl(stateDir, "group:everyone allow add_file");
		addAcl(path.join(stateDir, "peers"), "group:everyone allow list");
		addAcl(path.join(stateDir, "peer-preferences"), "group:everyone allow list");
		let calls = 0;
		const report = repairPeerStorageProtection({ agentDir }, {
			removeExtendedAcl: (fd) => {
				calls += 1;
				if (calls === 1) return removeThroughDescriptor(fd);
				if (mode === "throws") throw new Error("injected tool failure");
				// "no-op": the tool claims success without removing anything.
			},
		});
		assert.equal(report.outcome, "partial", mode);
		assert.equal(report.changed, true, mode);
		assert.equal(report.restartRequired, true, mode);
		assert.deepEqual(report.targets.map((target) => [target.target, target.outcome, target.reason]), [
			["session-host", "repaired", null],
			["peers", "failed-possibly-changed", "extended-acl"],
			["peer-state", "already-protected", null],
			["peer-preferences", "not-attempted", "extended-acl"],
			["preferences-document", "already-protected", null],
		], mode);
		assert.equal(calls, 2, `${mode}: nothing further is attempted`);
		assert.deepEqual(aclEntries(stateDir), [], `${mode}: nothing is rolled back`);
		assert.equal(aclEntries(path.join(stateDir, "peer-preferences")).length, 1, `${mode}: later targets are untouched`);
	}
});

test("remediation (macOS): unsupported ACLs, links, and replaced objects refuse the whole repair untouched", { skip: ACL_SKIP }, (t) => {
	const forbidden = (): void => {
		throw new Error("a refused repair must never reach a mutation");
	};
	// An ACL whose listing carries a right this module does not know.
	const unknown = agentFixture(t);
	existingLayout(unknown.stateDir);
	addAcl(path.join(unknown.stateDir, "peers"), "group:everyone allow list");
	addAcl(path.join(unknown.stateDir, "peer-preferences"), "group:everyone allow list");
	const unknownPreferencesId = inode(path.join(unknown.stateDir, "peer-preferences"));
	const realList = (_tool: string, args: readonly string[]): { status: number; stdout: string } => {
		const target = args[args.length - 1] ?? "";
		const stdout = execFileSync("/bin/ls", ["-lde", target], { encoding: "utf8", env: { LC_ALL: "C", LANG: "C" } });
		return { status: 0, stdout: inode(target) === unknownPreferencesId ? stdout.replace("allow list", "allow list,frobnicate") : stdout };
	};
	const unknownReport = repairPeerStorageProtection({ agentDir: unknown.agentDir }, {
		acl: { execute: realList },
		removeExtendedAcl: forbidden,
		fchmod: forbidden,
	});
	assert.equal(unknownReport.outcome, "refused");
	assert.equal(unknownReport.changed, false);
	assert.deepEqual(unknownReport.targets.find((target) => target.outcome === "refused"), { target: "peer-preferences", outcome: "refused", reason: "protection-unsupported" });
	assert.equal(aclEntries(path.join(unknown.stateDir, "peers")).length, 1, "a repairable sibling is not changed either");

	// A granting ACL on a hard-linked document: removal would change another name.
	const linked = agentFixture(t);
	existingLayout(linked.stateDir);
	const document = path.join(linked.stateDir, "peers", "state.json");
	addAcl(document, "group:everyone allow read");
	linkSync(document, path.join(linked.agentDir, "second-name"));
	const linkedReport = repairPeerStorageProtection({ agentDir: linked.agentDir }, { removeExtendedAcl: forbidden, fchmod: forbidden });
	assert.equal(linkedReport.outcome, "refused");
	assert.deepEqual(linkedReport.targets.find((target) => target.outcome === "refused"), { target: "peer-state", outcome: "refused", reason: "unsafe-object" });
	assert.equal(aclEntries(document).length, 1);

	// A symlinked directory with a granting ACL on its target is never followed.
	const symlinked = agentFixture(t);
	existingLayout(symlinked.stateDir);
	const outside = path.join(symlinked.agentDir, "outside");
	mkdirSync(outside, { mode: 0o700 });
	addAcl(outside, "group:everyone allow list");
	rmSync(path.join(symlinked.stateDir, "peer-preferences"), { recursive: true });
	symlinkSync(outside, path.join(symlinked.stateDir, "peer-preferences"));
	const symlinkReport = repairPeerStorageProtection({ agentDir: symlinked.agentDir }, { removeExtendedAcl: forbidden, fchmod: forbidden });
	assert.equal(symlinkReport.outcome, "refused");
	assert.deepEqual(symlinkReport.targets.find((target) => target.outcome === "refused"), { target: "peer-preferences", outcome: "refused", reason: "unsafe-object" });
	assert.equal(aclEntries(outside).length, 1, "the link target is untouched");

	// The object at the path is replaced during the pre-mutation ACL recheck:
	// the fenced listing names a different object, so nothing is removed.
	const raced = agentFixture(t);
	existingLayout(raced.stateDir);
	const peers = path.join(raced.stateDir, "peers");
	addAcl(peers, "group:everyone allow list");
	const racedPeersId = inode(peers);
	const racedPreferencesId = inode(path.join(raced.stateDir, "peer-preferences", "preferences.json"));
	let assessed = false;
	const racedReport = repairPeerStorageProtection({ agentDir: raced.agentDir }, {
		acl: {
			execute: (tool, args) => {
				const target = args[args.length - 1] ?? "";
				if (assessed && inode(target) === racedPeersId && !lstatSync(path.join(raced.stateDir, "peers-held"), { throwIfNoEntry: false })) {
					execFileSync("/bin/mv", [peers, path.join(raced.stateDir, "peers-held")]);
					mkdirSync(peers, { mode: 0o700 });
				}
				if (inode(target) === racedPreferencesId) assessed = true;
				return realList(tool, args);
			},
		},
		removeExtendedAcl: forbidden,
		fchmod: forbidden,
	});
	assert.equal(racedReport.changed, false);
	assert.deepEqual(racedReport.targets.find((target) => target.target === "peers"), { target: "peers", outcome: "failed-unchanged", reason: "changed" });
	assert.equal(aclEntries(path.join(raced.stateDir, "peers-held")).length, 1, "the moved original keeps its ACL");
});

test("remediation (macOS): a created-unverified base with an inherited grant is repaired only explicitly", { skip: ACL_SKIP }, (t) => {
	const { agentDir, stateDir } = agentFixture(t);
	addAcl(agentDir, "group:everyone allow list,add_file,search,directory_inherit");
	const agentAcl = aclEntries(agentDir);
	assert.deepEqual(creator.createPrivateStateDirectory(stateDir), { outcome: "created-unverified", reason: "extended-acl" });
	const inherited = aclEntries(stateDir);
	assert.ok(inherited.some((entry) => / inherited allow /u.test(entry)));
	// Opening a store changes nothing: it still refuses with the same reason.
	assert.deepEqual(preferencesDiagnostic(agentDir), { reason: "extended-acl", object: "session-host" });
	assert.deepEqual(aclEntries(stateDir), inherited, "an ordinary open never repairs");

	const report = repairPeerStorageProtection({ agentDir });
	assert.equal(report.outcome, "repaired");
	assert.deepEqual(report.targets.map((target) => [target.target, target.outcome]), [
		["session-host", "repaired"],
		["peers", "absent"],
		["peer-state", "absent"],
		["peer-preferences", "absent"],
		["preferences-document", "absent"],
	]);
	assert.deepEqual(aclEntries(stateDir), []);
	assert.equal(modeOf(stateDir), 0o700);
	assert.deepEqual(aclEntries(agentDir), agentAcl, "the inheritable ancestor grant is never touched");
	assert.deepEqual(readdirSync(stateDir), [], "nothing is created");
	assert.equal(preferencesDiagnostic(agentDir), "opened");
});

test("remediation (macOS): ACL evidence names the held object by file ID; a swap-list-restore cannot supply another object's ACL", { skip: ACL_SKIP }, (t) => {
	const { agentDir, stateDir } = agentFixture(t);
	existingLayout(stateDir);
	const peers = path.join(stateDir, "peers");
	const decoy = path.join(stateDir, "decoy");
	const parked = path.join(stateDir, "peers-parked");
	mkdirSync(decoy, { mode: 0o700 });
	addAcl(peers, "group:everyone allow list,search");
	const peersId = inode(peers);
	const listed: string[] = [];
	let swaps = 0;
	const swapListRestore = {
		execute: (_tool: string, args: readonly string[]): { status: number; stdout: string } => {
			const target = args[args.length - 1] ?? "";
			listed.push(target);
			const swap = inode(target) === peersId;
			if (swap) {
				// The pathname shows a clean decoy for exactly the listing's duration.
				execFileSync("/bin/mv", [peers, parked]);
				execFileSync("/bin/mv", [decoy, peers]);
				swaps += 1;
			}
			try {
				return { status: 0, stdout: execFileSync("/bin/ls", ["-lde", target], { encoding: "utf8", env: { LC_ALL: "C", LANG: "C" } }) };
			} finally {
				if (swap) {
					execFileSync("/bin/mv", [peers, decoy]);
					execFileSync("/bin/mv", [parked, peers]);
				}
			}
		},
	};
	const assessment = assessPeerStorageProtection({ agentDir }, { acl: swapListRestore });
	assert.ok(swaps > 0);
	assert.ok(listed.every((target) => target.startsWith("/.vol/")), "no listing names the fixed pathname");
	assert.deepEqual(assessment.targets.find((target) => target.target === "peers"), { target: "peers", status: "repairable", reason: "extended-acl" });
	const report = repairPeerStorageProtection({ agentDir }, { acl: swapListRestore });
	assert.equal(report.outcome, "repaired", JSON.stringify(report.targets));
	assert.equal(inode(peers), peersId);
	assert.deepEqual(aclEntries(peers), [], "the held object's own ACL was proven and removed");
	assert.deepEqual(aclEntries(decoy), [], "the decoy is untouched");
});

test("remediation (macOS): an unknown right anywhere in the ACL refuses removal, at assessment or at the mutation recheck", { skip: ACL_SKIP }, (t) => {
	// The shared proof reads every entry before classifying any grant.
	const mixed = "drwx------+ 3 user  staff  96 Jan  1 00:00 x\n 0: group:everyone allow list\n 1: group:staff allow frobnicate\n";
	assert.equal(proveExtendedAcl("/x", "private-dir", "darwin", { resolveTool: () => "/bin/ls", execute: () => ({ status: 0, stdout: mixed }) }), "unprovable");
	const forbidden = (): void => {
		throw new Error("an unsupported ACL must never reach a mutation");
	};
	for (const when of ["assessment", "recheck"] as const) {
		const { agentDir, stateDir } = agentFixture(t);
		existingLayout(stateDir);
		const peers = path.join(stateDir, "peers");
		addAcl(peers, "group:everyone allow list");
		const peersId = inode(peers);
		const preferencesId = inode(path.join(stateDir, "peer-preferences", "preferences.json"));
		let assessed = false;
		const report = repairPeerStorageProtection({ agentDir }, {
			acl: {
				execute: (_tool, args) => {
					const target = args[args.length - 1] ?? "";
					let stdout = execFileSync("/bin/ls", ["-lde", target], { encoding: "utf8", env: { LC_ALL: "C", LANG: "C" } });
					// A supported grant first, then an entry with an unknown right.
					if (inode(target) === peersId && (when === "assessment" || assessed)) stdout += " 1: group:staff allow frobnicate\n";
					if (inode(target) === preferencesId) assessed = true;
					return { status: 0, stdout };
				},
			},
			removeExtendedAcl: forbidden,
			fchmod: forbidden,
		});
		assert.equal(report.outcome, "refused", when);
		assert.equal(report.changed, false, when);
		assert.deepEqual(report.targets.find((target) => target.target === "peers"), {
			target: "peers",
			outcome: when === "assessment" ? "refused" : "failed-unchanged",
			reason: "protection-unsupported",
		}, when);
		assert.deepEqual(aclEntries(peers), ["0: group:everyone allow list"], `${when}: the ACL is untouched`);
	}
});

test("remediation (macOS): broad mode bits are tightened and verified before an ACL with a deny entry is removed", { skip: ACL_SKIP }, (t) => {
	const arrange = (): { agentDir: string; document: string } => {
		const { agentDir, stateDir } = agentFixture(t);
		existingLayout(stateDir);
		const document = path.join(stateDir, "peers", "state.json");
		chmodSync(document, 0o666);
		addAcl(document, "group:everyone deny write");
		addAcl(document, "group:staff allow read");
		return { agentDir, document };
	};
	// The mode repair fails: the ACL (and its deny entry) is never removed.
	const failing = arrange();
	const entries = aclEntries(failing.document);
	assert.equal(entries.length, 2);
	let removals = 0;
	const failed = repairPeerStorageProtection({ agentDir: failing.agentDir }, {
		fchmod: () => {
			throw new Error("injected mode failure");
		},
		removeExtendedAcl: () => {
			removals += 1;
		},
	});
	assert.equal(removals, 0, "no ACL removal before the mode is established");
	assert.equal(failed.outcome, "partial");
	assert.deepEqual(failed.targets.find((target) => target.target === "peer-state"), { target: "peer-state", outcome: "failed-possibly-changed", reason: "unreadable" });
	assert.deepEqual(aclEntries(failing.document), entries, "the deny entry still narrows the broad mode");
	assert.equal(modeOf(failing.document), 0o666);

	// The real repair runs mode first, then the descriptor-bound ACL removal.
	const working = arrange();
	const order: string[] = [];
	const repaired = repairPeerStorageProtection({ agentDir: working.agentDir }, {
		fchmod: (fd, mode) => {
			order.push(`mode:${modeOf(working.document).toString(8)}`);
			fchmodSync(fd, mode);
		},
		removeExtendedAcl: (fd) => {
			order.push(`acl:${modeOf(working.document).toString(8)}`);
			removeThroughDescriptor(fd);
		},
	});
	assert.equal(repaired.outcome, "repaired", JSON.stringify(repaired.targets));
	assert.deepEqual(order, ["mode:666", "acl:600"]);
	assert.deepEqual(aclEntries(working.document), []);
	assert.equal(modeOf(working.document), 0o600);
});

// ------------------------------------------------- Windows remediation

const WIN_CURRENT = "S-1-5-21-11-22-33-1001";
const WIN_AGENT = "C:\\Users\\someone\\.pi\\agent";

interface FakeObject {
	kind: "dir" | "file";
	id: string;
	links: number;
	size: number;
	reparse: boolean;
	owner: string;
	protectedDacl: boolean;
	aces: WindowsAclAceEvidence[];
	otherAces: number;
}

function winAce(sid: string, rights: number, inherited: boolean, kind: "dir" | "file"): WindowsAclAceEvidence {
	return { sid, aceType: "allow", rights, inherit: kind === "dir" ? 3 : 0, propagate: 0, inherited };
}

function privateAces(kind: "dir" | "file"): WindowsAclAceEvidence[] {
	return [WIN_CURRENT, "S-1-5-18", "S-1-5-32-544"].map((sid) => winAce(sid, 0x001f01ff, false, kind));
}

/** The b193 shape: inherited account/SYSTEM/Administrators plus an inherited ordinary-account Modify. */
function broadAces(kind: "dir" | "file"): WindowsAclAceEvidence[] {
	return [
		...[WIN_CURRENT, "S-1-5-18", "S-1-5-32-544"].map((sid) => winAce(sid, 0x001f01ff, true, kind)),
		winAce("S-1-5-11", 0x001301bf, true, kind),
	];
}

function fakeObject(kind: "dir" | "file", index: number, broad: boolean): FakeObject {
	return {
		kind,
		id: `${"ab".repeat(8)}${index.toString(16).padStart(32, "0")}`,
		links: 1,
		size: kind === "file" ? 40 : 0,
		reparse: false,
		owner: WIN_CURRENT,
		protectedDacl: !broad,
		aces: broad ? broadAces(kind) : privateAces(kind),
		otherAces: 0,
	};
}

function evidenceOf(object: FakeObject): Record<string, unknown> {
	const allow = object.aces.filter((ace) => ace.aceType === "allow").length;
	return {
		isDirectory: object.kind === "dir",
		isReparsePoint: object.reparse,
		entryCount: -1,
		fileLength: object.kind === "file" ? object.size : 0,
		ownerSid: object.owner,
		daclPresent: true,
		daclProtected: object.protectedDacl,
		daclAceCount: object.aces.length + object.otherAces,
		daclAllowCount: allow,
		daclDenyCount: object.aces.length - allow,
		daclOtherCount: object.otherAces,
		aces: object.aces,
		parentExists: true,
		parentIsReparsePoint: false,
	};
}

interface FakeHost {
	objects: Map<string, FakeObject>;
	requests: Record<string, unknown>[];
	argv: (readonly string[])[];
	/** Optional per-repair behaviour override. */
	onRepair?: (path: string, object: FakeObject) => Record<string, unknown> | "crash" | undefined;
	executor: WindowsAclExecutor;
}

function fakeWindowsHost(layout: Record<string, FakeObject | undefined>): FakeHost {
	const host: FakeHost = {
		objects: new Map(Object.entries(layout).filter((entry): entry is [string, FakeObject] => entry[1] !== undefined)),
		requests: [],
		argv: [],
		executor: (_file, args, options) => {
			host.argv.push(args);
			const request = JSON.parse(options.input) as Record<string, unknown>;
			host.requests.push(request);
			const observe = (target: string): Record<string, unknown> => {
				const object = host.objects.get(target);
				return object === undefined ? { state: "absent" } : { state: "present", id: object.id, links: object.links, evidence: evidenceOf(object) };
			};
			if (request.op === "inspect") {
				const results = (request.targets as string[]).map(observe);
				return { status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: WIN_CURRENT, results }) };
			}
			const target = request.path as string;
			const object = host.objects.get(target);
			assert.ok(object !== undefined, "repair is only requested for an observed object");
			const override = host.onRepair?.(target, object);
			if (override === "crash") return { status: 3, stdout: "" };
			if (override !== undefined) return { status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: WIN_CURRENT, ...override }) };
			if (object.id !== request.expectedId) return { status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: WIN_CURRENT, result: "refused", reason: "changed" }) };
			object.protectedDacl = true;
			object.aces = privateAces(object.kind);
			const after = { id: object.id, links: object.links, evidence: evidenceOf(object) };
			return { status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: WIN_CURRENT, result: "applied", after, reopened: observe(target) }) };
		},
	};
	return host;
}

const WIN_PATHS = {
	base: `${WIN_AGENT}\\session-host`,
	peers: `${WIN_AGENT}\\session-host\\peers`,
	state: `${WIN_AGENT}\\session-host\\peers\\state.json`,
	prefsDir: `${WIN_AGENT}\\session-host\\peer-preferences`,
	prefs: `${WIN_AGENT}\\session-host\\peer-preferences\\preferences.json`,
};

function winProbe(host: FakeHost) {
	return {
		platform: "win32" as NodeJS.Platform,
		windows: {
			resolveExecutable: () => FAKE_EXECUTABLE,
			execute: host.executor,
		},
	};
}

/**
 * The agent directory is canonicalized on the real test host, so a real
 * stand-in is used; its fixed target paths are mapped onto the fake Windows
 * objects the recorded helper responses describe.
 */
function mappedHost(agentDir: string, layout: Record<string, FakeObject | undefined>): FakeHost {
	const base = path.join(agentDir, "session-host");
	const translate: Record<string, string> = {
		[base]: WIN_PATHS.base,
		[path.join(base, "peers")]: WIN_PATHS.peers,
		[path.join(base, "peers", "state.json")]: WIN_PATHS.state,
		[path.join(base, "peer-preferences")]: WIN_PATHS.prefsDir,
		[path.join(base, "peer-preferences", "preferences.json")]: WIN_PATHS.prefs,
	};
	const host = fakeWindowsHost(Object.fromEntries(Object.entries(translate).map(([real, win]) => [real, layout[win]])));
	return host;
}

function standardWindowsLayout(): Record<string, FakeObject | undefined> {
	return {
		[WIN_PATHS.base]: fakeObject("dir", 1, true),
		[WIN_PATHS.peers]: fakeObject("dir", 2, false),
		[WIN_PATHS.state]: fakeObject("file", 3, false),
		[WIN_PATHS.prefsDir]: fakeObject("dir", 4, true),
		[WIN_PATHS.prefs]: fakeObject("file", 5, true),
	};
}

test("remediation (Windows fixtures): the fixed helper is handle-based, no-follow, and propagation-suppressed", () => {
	const script = PEER_STORAGE_REMEDIATION_HELPER_SCRIPT;
	assert.match(script, /Open-Exact \$path 0x02000000/u, "repair handle is opened with MAXIMUM_ALLOWED");
	assert.match(script, /0x02200000/u, "every open uses BACKUP_SEMANTICS | OPEN_REPARSE_POINT");
	assert.match(script, /SetSecurityInfo\(\$handle, 1, \[uint32\]2147483652/u, "only DACL | PROTECTED_DACL is written, on the handle");
	assert.match(script, /GetSecurityInfo\(\$handle/u, "descriptors are read on the same handle");
	assert.match(script, /if \(\$before\.id -ne \$expected\) \{ Refuse 'changed' \}/u, "identity is re-proved on the held handle");
	assert.match(script, /if \(\$kind -eq 'file' -and \$before\.links -ne 1\) \{ Refuse 'unsafe-object' \}/u);
	assert.match(script, /if \(\$before\.evidence\.ownerSid -ne \$current\) \{ Refuse 'foreign-owner' \}/u, "no ownership takeover");
	assert.match(script, /\$reopened = Observe \$path/u, "the path is reopened after the write");
	assert.doesNotMatch(script, /SetKernelObjectSecurity|SetNamedSecurityInfo|SetAccessControl|SetOwner|icacls|GetFileSystemEntries/u);
});

test("remediation (Windows fixtures): the b193 inherited broad base and broad preferences are repaired only", (t) => {
	const { agentDir } = agentFixture(t);
	const host = mappedHost(agentDir, standardWindowsLayout());
	const probe = winProbe(host);
	const assessment = assessPeerStorageProtection({ agentDir }, probe);
	assert.deepEqual(assessment.targets.map((target) => [target.target, target.status]), [
		["session-host", "repairable"],
		["peers", "protected"],
		["peer-state", "protected"],
		["peer-preferences", "repairable"],
		["preferences-document", "repairable"],
	]);
	host.requests.length = 0;
	const report = repairPeerStorageProtection({ agentDir }, probe);
	assert.equal(report.outcome, "repaired");
	assert.equal(report.restartRequired, true);
	assert.deepEqual(outcomes(report), {
		"session-host": "repaired",
		peers: "already-protected",
		"peer-state": "already-protected",
		"peer-preferences": "repaired",
		"preferences-document": "repaired",
	});
	const repairs = host.requests.filter((request) => request.op === "repair");
	assert.deepEqual(repairs.map((request) => request.kind), ["dir", "dir", "file"]);
	assert.ok(repairs.every((request) => typeof request.expectedId === "string"), "every mutation carries the assessed identity");
	assert.ok(host.argv.every((args) => !args.join(" ").includes("session-host")), "no path reaches argv");
	assert.ok(
		host.argv.every((args) => [FAKE_EXECUTABLE, ...args].join(" ").length < 30_000),
		"the complete helper command leaves headroom below Windows' 32,767-character limit",
	);
	// The encoded bootstrap really carries the exact fixed helper source.
	const encoded = host.argv[0]?.[host.argv[0].length - 1] ?? "";
	const bootstrap = Buffer.from(encoded, "base64").toString("utf16le");
	assert.equal(bootstrap, PEER_STORAGE_REMEDIATION_HELPER_BOOTSTRAP);
	const compressed = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(bootstrap)?.[1] ?? "";
	assert.equal(inflateRawSync(Buffer.from(compressed, "base64")).toString("utf8"), PEER_STORAGE_REMEDIATION_HELPER_SCRIPT);
	assert.match(bootstrap, /& \(\[ScriptBlock\]::Create\(\$source\)\)/u);
	assert.doesNotMatch(bootstrap, /ReadToEnd\(\)[^\n]*Console|\$req/u, "the bootstrap never reads or embeds request data");
});

test("remediation (Windows fixtures): reparse, extra hard link, foreign owner, unmodelled ACL, and denial refuse untouched", (t) => {
	const cases: { name: string; mutate: (layout: Record<string, FakeObject | undefined>) => void; target: string; reason: string }[] = [
		{ name: "reparse base", mutate: (layout) => { layout[WIN_PATHS.base]!.reparse = true; }, target: "session-host", reason: "unsafe-object" },
		{ name: "hard-linked document", mutate: (layout) => { layout[WIN_PATHS.prefs]!.links = 2; }, target: "preferences-document", reason: "unsafe-object" },
		{ name: "foreign owner", mutate: (layout) => { layout[WIN_PATHS.prefsDir]!.owner = "S-1-5-21-99-99-99-1002"; }, target: "peer-preferences", reason: "foreign-owner" },
		{ name: "Administrators-owned broad base", mutate: (layout) => { layout[WIN_PATHS.base]!.owner = "S-1-5-32-544"; }, target: "session-host", reason: "foreign-owner" },
		{ name: "object ACE", mutate: (layout) => { layout[WIN_PATHS.peers]!.otherAces = 1; }, target: "peers", reason: "protection-unsupported" },
		{ name: "unknown mask bit", mutate: (layout) => { layout[WIN_PATHS.state]!.aces[0] = winAce(WIN_CURRENT, 0x0040_0000, false, "file"); }, target: "peer-state", reason: "protection-unsupported" },
		{ name: "empty document", mutate: (layout) => { layout[WIN_PATHS.state]!.size = 0; }, target: "peer-state", reason: "malformed" },
		{ name: "directory as document", mutate: (layout) => { layout[WIN_PATHS.state]!.kind = "dir"; }, target: "peer-state", reason: "unsafe-object" },
	];
	for (const entry of cases) {
		const { agentDir } = agentFixture(t);
		const layout = standardWindowsLayout();
		entry.mutate(layout);
		const host = mappedHost(agentDir, layout);
		const report = repairPeerStorageProtection({ agentDir }, winProbe(host));
		assert.equal(report.outcome, "refused", entry.name);
		assert.equal(report.changed, false, entry.name);
		const refused = report.targets.find((target) => target.outcome === "refused");
		assert.deepEqual(refused && [refused.target, refused.reason], [entry.target, entry.reason], entry.name);
		assert.ok(host.requests.every((request) => request.op === "inspect"), `${entry.name}: no repair was requested`);
	}
	const { agentDir } = agentFixture(t);
	const unavailable = repairPeerStorageProtection({ agentDir }, { platform: "win32", windows: { resolveExecutable: () => null } });
	assert.equal(unavailable.outcome, "refused");
	assert.equal(unavailable.targets[0]?.reason, "protection-unsupported");
});

test("remediation (Windows fixtures): failures after the write are possibly changed; nothing further is attempted", (t) => {
	const scenarios: { name: string; onRepair: FakeHost["onRepair"]; outcome: string; reason: string }[] = [
		{ name: "write failed", onRepair: () => ({ result: "write-failed" }), outcome: "failed-possibly-changed", reason: "unsafe-permissions" },
		{ name: "helper crashed", onRepair: () => "crash", outcome: "failed-possibly-changed", reason: "protection-unsupported" },
		{
			name: "identity changed on reopen",
			onRepair: (_path, object) => {
				object.protectedDacl = true;
				object.aces = privateAces(object.kind);
				const evidence = evidenceOf(object);
				return { result: "applied", after: { id: object.id, links: 1, evidence }, reopened: { state: "present", id: "f".repeat(48), links: 1, evidence } };
			},
			outcome: "failed-possibly-changed",
			reason: "changed",
		},
		{
			name: "descriptor still broad",
			onRepair: (_path, object) => {
				const evidence = evidenceOf(object);
				return { result: "applied", after: { id: object.id, links: 1, evidence }, reopened: { state: "present", id: object.id, links: 1, evidence } };
			},
			outcome: "failed-possibly-changed",
			reason: "unsafe-permissions",
		},
		{ name: "helper refused before writing", onRepair: () => ({ result: "refused", reason: "changed" }), outcome: "failed-unchanged", reason: "changed" },
	];
	for (const scenario of scenarios) {
		const { agentDir } = agentFixture(t);
		const host = mappedHost(agentDir, standardWindowsLayout());
		let repairs = 0;
		host.onRepair = (target, object) => {
			repairs += 1;
			// The first (base) repair succeeds normally; the second misbehaves.
			return repairs === 1 ? undefined : scenario.onRepair?.(target, object);
		};
		const report = repairPeerStorageProtection({ agentDir }, winProbe(host));
		assert.deepEqual(outcomes(report), {
			"session-host": "repaired",
			peers: "already-protected",
			"peer-state": "already-protected",
			"peer-preferences": scenario.outcome,
			"preferences-document": "not-attempted",
		}, scenario.name);
		assert.equal(report.targets[3]?.reason, scenario.reason, scenario.name);
		assert.equal(report.outcome, "partial", scenario.name);
		assert.equal(report.changed, true, scenario.name);
		assert.equal(report.restartRequired, true, scenario.name);
		assert.equal(repairs, 2, `${scenario.name}: no later repair is attempted`);
	}
});

// ------------------------------------------------- review pass 1 regressions

test("remediation (POSIX): an initially protected child replaced during the base repair is never reported protected", { skip: POSIX_SKIP }, (t) => {
	const { agentDir, stateDir } = agentFixture(t);
	existingLayout(stateDir);
	chmodSync(stateDir, 0o777);
	const peers = path.join(stateDir, "peers");
	const report = repairPeerStorageProtection({ agentDir }, {
		fchmod: (fd, mode) => {
			// The real descriptor mutation runs, then the protected `peers` is
			// replaced by a different (still private-looking) directory.
			fchmodSync(fd, mode);
			execFileSync("/bin/mv", [peers, path.join(stateDir, "peers-assessed")]);
			mkdirSync(peers, { mode: 0o700 });
		},
	});
	assert.equal(report.outcome, "partial");
	assert.equal(report.changed, true);
	assert.equal(report.restartRequired, true);
	assert.deepEqual(report.targets.map((target) => [target.target, target.outcome, target.reason]), [
		["session-host", "repaired", null],
		["peers", "unverified", "changed"],
		["peer-state", "unverified", "changed"],
		["peer-preferences", "already-protected", null],
		["preferences-document", "already-protected", null],
	]);
	assert.equal(modeOf(path.join(stateDir, "peers-assessed")), 0o700, "the moved original is untouched");
});

test("remediation (Windows fixtures): a protected child replaced during the base repair is unverified", (t) => {
	const { agentDir } = agentFixture(t);
	const layout = standardWindowsLayout();
	const host = mappedHost(agentDir, layout);
	let repairs = 0;
	host.onRepair = () => {
		repairs += 1;
		if (repairs === 1) {
			// After the base write, `peers` is replaced by another object.
			const peersKey = [...host.objects.keys()].find((key) => key.endsWith(`${path.sep}peers`));
			assert.ok(peersKey !== undefined);
			host.objects.set(peersKey, fakeObject("dir", 9, false));
		}
		return undefined;
	};
	const report = repairPeerStorageProtection({ agentDir }, winProbe(host));
	assert.equal(report.outcome, "partial");
	assert.equal(outcomes(report).peers, "unverified");
	assert.equal(report.targets[1]?.reason, "changed");
	assert.equal(outcomes(report)["session-host"], "repaired");
});

test("remediation (Windows fixtures): the mutation handle re-proves ACL shape and document size before writing", (t) => {
	const script = PEER_STORAGE_REMEDIATION_HELPER_SCRIPT;
	assert.match(script, /if \(-not \$evidenceBefore\.daclPresent -or \$evidenceBefore\.daclAceCount -eq 0 -or \$evidenceBefore\.daclOtherCount -ne 0\) \{ Refuse 'protection-unsupported' \}/u);
	assert.ok(script.includes(`$maskBefore -band [int64]${(~KNOWN_ACCESS_MASK) >>> 0}`), "unknown ACCESS_MASK bits are rechecked on the held handle");
	assert.match(script, /\$evidenceBefore\.fileLength -gt \$maxBytes\)\) \{ Refuse 'malformed' \}/u);
	const recheck = script.indexOf("Refuse 'malformed'");
	assert.ok(recheck > 0 && recheck < script.indexOf("SetSecurityInfo($handle"), "every recheck precedes the write");

	const { agentDir } = agentFixture(t);
	const host = mappedHost(agentDir, standardWindowsLayout());
	host.onRepair = (_target, object) => (object.kind === "file" ? { result: "refused", reason: "malformed" } : undefined);
	const report = repairPeerStorageProtection({ agentDir }, winProbe(host));
	assert.equal(outcomes(report)["preferences-document"], "failed-unchanged");
	assert.equal(report.targets[4]?.reason, "malformed");
	assert.ok(host.requests.filter((request) => request.op === "repair").every((request) => request.maxBytes === (request.kind === "file" ? 64 * 1024 : 0)));
});

test("diagnostics (Windows fixtures): unreadable storage is distinct from an unavailable helper", () => {
	const launched: (readonly string[])[] = [];
	const helperStatus = (status: number | null) => createPeerStatePermissionPolicy({
		platform: "win32",
		windows: {
			resolveExecutable: () => FAKE_EXECUTABLE,
			execute: (_file, args) => {
				launched.push(args);
				return { status, stdout: "" };
			},
		},
	});
	const reasonOf = (operation: () => void): unknown => {
		try {
			operation();
		} catch (error) {
			assert.ok(isPeerTransportError(error));
			assert.equal(error.code, "TRUST_STORE_FAILED");
			assert.equal(error.message, "injected peer trust store failed");
			return peerStorageDiagnostic(error)?.reason;
		}
		return "passed";
	};
	const target = "C:\\Users\\someone\\.pi\\agent\\session-host";
	assert.equal(reasonOf(() => helperStatus(6).assertOwnerControlledDirectory(target)), "unreadable");
	assert.equal(reasonOf(() => helperStatus(4).assertPrivateDirectory(target)), "changed");
	assert.equal(reasonOf(() => helperStatus(3).assertPrivateFile(target)), "protection-unsupported");
	assert.equal(reasonOf(() => helperStatus(null).assertPrivateFile(target)), "protection-unsupported");
	const noHelper = createPeerStatePermissionPolicy({ platform: "win32", windows: { resolveExecutable: () => null } });
	assert.equal(reasonOf(() => noHelper.assertOwnerControlledDirectory(target)), "protection-unsupported");
	assert.equal(reasonOf(() => helperStatus(6).protectCreatedDirectory(`${target}\\peers`)), "unreadable");
	assert.ok(launched.length > 0 && launched.every((args) => [FAKE_EXECUTABLE, ...args].join(" ").length < 30_000),
		"the policy helper command stays below Windows' command-line limit");
});
