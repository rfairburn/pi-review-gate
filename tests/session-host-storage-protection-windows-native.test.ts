/**
 * Native Windows proofs for Network storage creation protection and explicit
 * remediation (Refs #494).
 *
 * Every case runs the production code against synthetic directories under a
 * fresh temporary root this test creates, broadens with an inheritable
 * Authenticated Users Modify grant through the fixed system `icacls`, and
 * removes. Nothing outside that root is inspected or modified. Every case skips
 * on other platforms: a non-Windows run proves nothing about NTFS.
 *
 * Parent integration command (add to the existing Windows session-host job):
 *   node --test --test-concurrency=1 --test-timeout=120000 dist-test/tests/session-host-storage-protection-windows-native.test.js
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isPeerPreferencesError, openPeerPreferencesStoreWithPermissions, DEFAULT_PEER_PREFERENCES } from "../src/session-host/network/peer-preferences-store";
import { createPeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permissions";
import {
	inspectPeerStateAcl,
	productionWindowsAclExecutor,
	resolveTrustedSystemPowerShell,
	type WindowsAclExecutor,
	verifyOwnerControlledAclEvidence,
	verifyPrivateAclEvidence,
	type WindowsAclEvidence,
} from "../src/session-host/network/peer-state-windows-permissions";
import { peerStorageDiagnostic } from "../src/session-host/network/peer-storage-diagnostics";
import { assessPeerStorageProtection, repairPeerStorageProtection } from "../src/session-host/network/peer-storage-remediation";
import { ensureHostStateDir } from "../src/session-host/roster-store";

const creator = require(join(process.cwd(), "scripts", "session-host-state-directory.cjs")) as {
	createPrivateStateDirectory: (target: string) => { outcome: string; reason?: string };
};

const IS_WINDOWS = process.platform === "win32";
const SKIP = IS_WINDOWS ? false : "native NTFS proof requires a Windows host";
const AUTHENTICATED_USERS = "S-1-5-11";

function icacls(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (!systemRoot) throw new Error("SystemRoot is unavailable on this Windows host");
	return join(systemRoot, "System32", "icacls.exe");
}

/** A fresh root whose descendants inherit an ordinary-account Modify grant (the b193 shape). */
function broadRoot(t: { after: (fn: () => void) => void }): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "prg-storage-native-")));
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
	});
	execFileSync(icacls(), [root, "/grant", `*${AUTHENTICATED_USERS}:(OI)(CI)M`], { stdio: "ignore", timeout: 30_000, windowsHide: true });
	return root;
}

function observe(target: string): { evidence: WindowsAclEvidence; currentSid: string } {
	const observed = inspectPeerStateAcl(target);
	assert.ok(observed !== null, "the native helper must observe this test's own fixture");
	return observed;
}

function grantsAuthenticatedUsers(evidence: WindowsAclEvidence): boolean {
	return evidence.aces.some((ace) => ace.sid === AUTHENTICATED_USERS && ace.aceType === "allow");
}

function isPrivate(target: string, kind: "dir" | "file"): boolean {
	const { evidence, currentSid } = observe(target);
	return verifyPrivateAclEvidence(evidence, currentSid, kind);
}

test("native: an absent session-host under a broad parent is created private at creation", { skip: SKIP }, (t) => {
	const root = broadRoot(t);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	assert.ok(grantsAuthenticatedUsers(observe(agentDir).evidence), "fixture parent really is broad");
	const stateDir = join(agentDir, "session-host");
	assert.deepEqual(creator.createPrivateStateDirectory(stateDir), { outcome: "created-protected" });
	const { evidence, currentSid } = observe(stateDir);
	assert.equal(grantsAuthenticatedUsers(evidence), false, "no inherited broad grant");
	assert.equal(evidence.daclProtected, true);
	assert.equal(evidence.ownerSid, currentSid);
	assert.ok(verifyPrivateAclEvidence(evidence, currentSid, "dir"));
	assert.ok(verifyOwnerControlledAclEvidence(evidence, currentSid));

	// The compiled earliest creator uses the same rule.
	const second = join(root, "agent-two");
	mkdirSync(second);
	ensureHostStateDir(second);
	assert.ok(isPrivate(join(second, "session-host"), "dir"));
	// A child file created later inherits only the private grants.
	writeFileSync(join(second, "session-host", "roster.json"), "{}\n");
	assert.equal(grantsAuthenticatedUsers(observe(join(second, "session-host", "roster.json")).evidence), false);
});

test("native: an existing broad session-host is never altered automatically", { skip: SKIP }, (t) => {
	const root = broadRoot(t);
	const agentDir = join(root, "agent");
	const stateDir = join(agentDir, "session-host");
	mkdirSync(stateDir, { recursive: true });
	const before = observe(stateDir).evidence;
	assert.ok(grantsAuthenticatedUsers(before));
	assert.deepEqual(creator.createPrivateStateDirectory(stateDir), { outcome: "existing" });
	ensureHostStateDir(agentDir);
	assert.deepEqual(observe(stateDir).evidence, before, "descriptor unchanged");
	assert.throws(
		() => openPeerPreferencesStoreWithPermissions({ agentDir, permissions: createPeerStatePermissionPolicy() }),
		(error: unknown) => {
			assert.ok(isPeerPreferencesError(error));
			assert.deepEqual(peerStorageDiagnostic(error), { reason: "unsafe-permissions", object: "session-host" });
			return true;
		},
	);
});

test("native: a Network first save under a broad agent directory creates a private base", { skip: SKIP }, (t) => {
	const root = broadRoot(t);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const store = openPeerPreferencesStoreWithPermissions({ agentDir, permissions: createPeerStatePermissionPolicy() });
	store.write({ ...DEFAULT_PEER_PREFERENCES, bellEnabled: false });
	store.close();
	assert.ok(isPrivate(join(agentDir, "session-host"), "dir"));
	assert.ok(isPrivate(join(agentDir, "session-host", "peer-preferences"), "dir"));
	assert.ok(isPrivate(join(agentDir, "session-host", "peer-preferences", "preferences.json"), "file"));
	assert.ok(grantsAuthenticatedUsers(observe(agentDir).evidence), "the agent directory is never modified");
});

test("native: remediation repairs only fixed targets and does not propagate to other children", { skip: SKIP }, (t) => {
	const root = broadRoot(t);
	const agentDir = join(root, "agent");
	const stateDir = join(agentDir, "session-host");
	mkdirSync(join(stateDir, "peers"), { recursive: true });
	const stateBytes = Buffer.from("{\"opaque\":\"never decoded by remediation\"}\n");
	writeFileSync(join(stateDir, "peers", "state.json"), stateBytes);
	writeFileSync(join(stateDir, "roster.json"), "{\"version\":1,\"entries\":[]}\n");
	const rosterBefore = observe(join(stateDir, "roster.json")).evidence;
	assert.ok(grantsAuthenticatedUsers(rosterBefore));

	const assessment = assessPeerStorageProtection({ agentDir });
	assert.deepEqual(assessment.targets.map((target) => [target.target, target.status]), [
		["session-host", "repairable"],
		["peers", "repairable"],
		["peer-state", "repairable"],
		["peer-preferences", "absent"],
		["preferences-document", "absent"],
	]);
	const report = repairPeerStorageProtection({ agentDir });
	assert.equal(report.outcome, "repaired", JSON.stringify(report));
	assert.equal(report.restartRequired, true);
	assert.ok(isPrivate(stateDir, "dir"));
	assert.ok(isPrivate(join(stateDir, "peers"), "dir"));
	assert.ok(isPrivate(join(stateDir, "peers", "state.json"), "file"));
	assert.deepEqual(readFileSync(join(stateDir, "peers", "state.json")), stateBytes);
	assert.deepEqual(observe(join(stateDir, "roster.json")).evidence, rosterBefore, "MAXIMUM_ALLOWED suppressed propagation to an unrelated child");
	assert.equal(repairPeerStorageProtection({ agentDir }).outcome, "nothing-to-repair");
});

test("native: remediation refuses a hard-linked document and a junction base without changing anything", { skip: SKIP }, (t) => {
	const root = broadRoot(t);
	const agentDir = join(root, "agent");
	const stateDir = join(agentDir, "session-host");
	mkdirSync(join(stateDir, "peers"), { recursive: true });
	writeFileSync(join(stateDir, "peers", "state.json"), "{}\n");
	linkSync(join(stateDir, "peers", "state.json"), join(root, "second-name.json"));
	const before = observe(stateDir).evidence;
	const report = repairPeerStorageProtection({ agentDir });
	assert.equal(report.outcome, "refused");
	assert.deepEqual(report.targets.find((target) => target.outcome === "refused"), { target: "peer-state", outcome: "refused", reason: "unsafe-object" });
	assert.deepEqual(observe(stateDir).evidence, before);

	const junctionAgent = join(root, "junction-agent");
	const realBase = join(root, "real-base");
	mkdirSync(junctionAgent);
	mkdirSync(realBase);
	symlinkSync(realBase, join(junctionAgent, "session-host"), "junction");
	const realBefore = observe(realBase).evidence;
	const junction = repairPeerStorageProtection({ agentDir: junctionAgent });
	assert.equal(junction.outcome, "refused");
	assert.deepEqual(junction.targets[0], { target: "session-host", outcome: "refused", reason: "unsafe-object" });
	assert.deepEqual(observe(realBase).evidence, realBefore, "a junction is never followed");
});

test("native: the pre-Node wrapper creates an absent session-host private and leaves an existing one alone", { skip: SKIP }, (t) => {
	const powershell = resolveTrustedSystemPowerShell();
	assert.ok(powershell !== null);
	const source = readFileSync(join(process.cwd(), "scripts", "pi-review-sessions-node.ps1"), "utf8").replace(/\r\n/gu, "\n");
	const extract = (name: string): string => {
		const start = source.indexOf(`function ${name}`);
		assert.ok(start >= 0, `${name} exists`);
		const end = source.indexOf("\n}\n", start);
		return source.slice(start, end + 3);
	};
	const root = broadRoot(t);
	const fresh = join(root, "fresh-session-host");
	const existing = join(root, "existing-session-host");
	mkdirSync(existing);
	const existingBefore = observe(existing).evidence;
	const script = [
		"$ErrorActionPreference = 'Stop'",
		extract("Get-ExistingAttributes"),
		extract("Initialize-IdentityType"),
		extract("New-PrivateStateDirectory"),
		"Initialize-IdentityType",
		"New-PrivateStateDirectory $env:PRG_FRESH",
		"New-PrivateStateDirectory $env:PRG_EXISTING",
	].join("\n");
	const child = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
		encoding: "utf8",
		timeout: 60_000,
		windowsHide: true,
		env: { ...process.env, PRG_FRESH: fresh, PRG_EXISTING: existing },
	});
	assert.equal(child.status, 0, child.stderr);
	assert.ok(isPrivate(fresh, "dir"));
	assert.deepEqual(observe(existing).evidence, existingBefore);
});

/** Run one fixed PowerShell snippet against this test's own fixture (paths via environment). */
function powershellForTest(script: string, env: Record<string, string>): number | null {
	const powershell = resolveTrustedSystemPowerShell();
	assert.ok(powershell !== null);
	const child = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
		encoding: "utf8",
		timeout: 60_000,
		windowsHide: true,
		env: { ...process.env, ...env },
	});
	return child.status;
}

/** A broad layout whose base, peers, and state.json are all repairable. */
function broadTrustLayout(t: { after: (fn: () => void) => void }): { agentDir: string; statePath: string } {
	const root = broadRoot(t);
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "session-host", "peers"), { recursive: true });
	const statePath = join(agentDir, "session-host", "peers", "state.json");
	writeFileSync(statePath, "{\"opaque\":true}\n");
	return { agentDir, statePath };
}

/** The production executor, with one fixture change made just before the document's repair call. */
function changeBeforeDocumentRepair(change: () => void): { execute: WindowsAclExecutor; fired: () => boolean } {
	let fired = false;
	return {
		fired: () => fired,
		execute: (file, args, options) => {
			const request = JSON.parse(options.input) as Record<string, unknown>;
			if (!fired && request.op === "repair" && request.kind === "file") {
				fired = true;
				change();
			}
			return productionWindowsAclExecutor(file, args, options);
		},
	};
}

test("native: a document emptied between inspection and mutation is refused on the held handle, unchanged", { skip: SKIP }, (t) => {
	const { agentDir, statePath } = broadTrustLayout(t);
	const before = observe(statePath).evidence;
	const seam = changeBeforeDocumentRepair(() => writeFileSync(statePath, ""));
	const report = repairPeerStorageProtection({ agentDir }, { windows: { execute: seam.execute } });
	assert.ok(seam.fired());
	assert.deepEqual(report.targets.find((target) => target.target === "peer-state"), { target: "peer-state", outcome: "failed-unchanged", reason: "malformed" });
	assert.equal(report.outcome, "partial", "the base and peers were changed before the refusal");
	assert.deepEqual(observe(statePath).evidence.aces, before.aces, "the refused document's DACL was not written");
});

test("native: an unmodelled ACE added between inspection and mutation is refused on the held handle, unchanged", { skip: SKIP }, (t) => {
	// The fixture installs an allow ACE carrying an undocumented mask bit
	// through .NET. Whether NTFS stores that bit is established first; if the
	// host normalizes it away, this coverage is reported as unclaimed.
	const install = [
		"$ErrorActionPreference = 'Stop'",
		"$file = New-Object System.IO.FileInfo($env:PRG_TARGET)",
		"$security = $file.GetAccessControl()",
		"$sid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-11')",
		"$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, [System.Security.AccessControl.FileSystemRights]0x00400001, [System.Security.AccessControl.AccessControlType]::Allow)",
		"$security.AddAccessRule($rule)",
		"$file.SetAccessControl($security)",
	].join("\n");
	const probeRoot = broadRoot(t);
	const probeFile = join(probeRoot, "probe.json");
	writeFileSync(probeFile, "{}\n");
	const installed = powershellForTest(install, { PRG_TARGET: probeFile }) === 0
		&& observe(probeFile).evidence.aces.some((ace) => (ace.rights & 0x0040_0000) !== 0);
	if (!installed) {
		t.diagnostic("unclaimed native coverage: this host would not store an undocumented ACCESS_MASK bit");
		return;
	}
	const { agentDir, statePath } = broadTrustLayout(t);
	const seam = changeBeforeDocumentRepair(() => {
		assert.equal(powershellForTest(install, { PRG_TARGET: statePath }), 0);
	});
	const report = repairPeerStorageProtection({ agentDir }, { windows: { execute: seam.execute } });
	assert.ok(seam.fired());
	assert.deepEqual(report.targets.find((target) => target.target === "peer-state"), { target: "peer-state", outcome: "failed-unchanged", reason: "protection-unsupported" });
	assert.ok(observe(statePath).evidence.aces.some((ace) => (ace.rights & 0x0040_0000) !== 0), "the unmodelled DACL was never overwritten");
});

test("native: an unreadable security descriptor is reported unreadable, not unsupported", { skip: SKIP }, (t) => {
	const root = broadRoot(t);
	const agentDir = join(root, "agent");
	const stateDir = join(agentDir, "session-host");
	mkdirSync(stateDir, { recursive: true });
	const { currentSid } = observe(stateDir);
	// Deny READ_CONTROL to this account and to OWNER RIGHTS (which otherwise
	// grants the owner implicit READ_CONTROL), on this fixture only.
	execFileSync(icacls(), [stateDir, "/deny", `*${currentSid}:(RC)`, "/deny", "*S-1-3-4:(RC)"], { stdio: "ignore", timeout: 30_000, windowsHide: true });
	t.after(() => {
		try {
			execFileSync(icacls(), [stateDir, "/remove:d", `*${currentSid}`, "/remove:d", "*S-1-3-4"], { stdio: "ignore", timeout: 30_000, windowsHide: true });
		} catch {
			// Best effort before the root is removed.
		}
	});
	assert.throws(
		() => openPeerPreferencesStoreWithPermissions({ agentDir, permissions: createPeerStatePermissionPolicy() }),
		(error: unknown) => {
			assert.ok(isPeerPreferencesError(error));
			assert.deepEqual(peerStorageDiagnostic(error), { reason: "unreadable", object: "session-host" });
			return true;
		},
	);
	const unavailable = createPeerStatePermissionPolicy({ windows: { resolveExecutable: () => null } });
	assert.throws(() => unavailable.assertPrivateDirectory(stateDir), (error: unknown) => {
		assert.deepEqual(peerStorageDiagnostic(error), { reason: "protection-unsupported", object: null });
		return true;
	});
});
