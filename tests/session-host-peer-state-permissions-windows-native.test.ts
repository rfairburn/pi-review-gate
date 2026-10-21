/**
 * Native Windows acceptance cases for peer-state protection (Refs #480).
 *
 * These are the real-NTFS proofs: they run the production policy, which drives
 * the fixed trusted system PowerShell, against synthetic directories and files
 * that this test created under a freshly made temporary root it owns. Nothing
 * outside that root is inspected or modified, and no account-wide permission
 * inventory is taken. Every case skips on other platforms — a non-Windows run
 * proves nothing about NTFS ACLs and never claims otherwise.
 *
 * Parent integration command (add to the existing Windows CI job):
 *   node --test --test-concurrency=1 dist-test/tests/session-host-peer-state-permissions-windows-native.test.js
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isPeerTransportError } from "../src/session-host/network/index";
import { createPeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permissions";
import { inspectPeerStateAcl } from "../src/session-host/network/peer-state-windows-permissions";

const IS_WINDOWS = process.platform === "win32";
const SKIP = IS_WINDOWS ? false : "native Windows ACL proof requires a Windows host";
const FIXED_MESSAGE = "injected peer trust store failed";
const LOCAL_SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
const AUTHENTICATED_USERS = "S-1-5-11";
const EVERYONE = "S-1-1-0";
/**
 * "Full control" appears in two encodings on real hosts: the .NET
 * `FullControl`/`GENERIC_ALL` value and the specific-NTFS-rights mask used by
 * tool-written ACEs. Accepting only one of them would reject a valid ACL.
 */
const FULL_CONTROL_GENERIC = 0x1000_0000;
const FULL_CONTROL_SPECIFIC = 0x001f_01ff;

function holdsFullControl(rights: number): boolean {
	return (rights & FULL_CONTROL_GENERIC) !== 0 || (rights & FULL_CONTROL_SPECIFIC) === FULL_CONTROL_SPECIFIC;
}

function icacls(): string {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (!systemRoot) throw new Error("SystemRoot is unavailable on this Windows host");
	return join(systemRoot, "System32", "icacls.exe");
}

/** Test-only broadening of a fixture this test created, through the fixed system tool. */
function grantForTest(target: string, sid: string, rights: string): void {
	execFileSync(icacls(), [target, "/grant", `*${sid}:${rights}`], {
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
}

/**
 * Best-effort broadening for rights the host may refuse to grant without
 * elevation (for example `ACCESS_SYSTEM_SECURITY`). `false` means the operating
 * system would not create the ACE at all, which is reported as a diagnostic
 * rather than claimed as coverage.
 */
function tryGrantForTest(target: string, sid: string, rights: string): boolean {
	try {
		grantForTest(target, sid, rights);
		return true;
	} catch {
		return false;
	}
}

function ownedRoot(t: { after: (fn: () => void) => void }): string {
	const root = mkdtempSync(join(tmpdir(), "prg-peer-acl-"));
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
	});
	return root;
}

function realAcl(target: string) {
	const observed = inspectPeerStateAcl(target);
	assert.ok(observed !== null, "the native helper must be able to observe its own fixture");
	return observed;
}

function assertFixedFailure(error: unknown, fixtureRoot: string): boolean {
	assert.ok(error instanceof Error);
	assert.ok(isPeerTransportError(error), `expected a peer transport error, got ${String(error)}`);
	assert.equal(error.code, "TRUST_STORE_FAILED");
	assert.equal(error.message, FIXED_MESSAGE);
	const stack = error.stack ?? "";
	assert.ok(!stack.includes(fixtureRoot), "the fixture path leaked into the error");
	assert.ok(!/S-1-|Access is denied|icacls|powershell/iu.test(`${error.message} ${stack}`), "native ACL detail leaked");
	return true;
}

function describeAcl(target: string): string {
	const observed = realAcl(target);
	return JSON.stringify({
		owner: observed.evidence.ownerSid,
		current: observed.currentSid,
		protected: observed.evidence.daclProtected,
		aces: observed.evidence.aces.map((ace) => [ace.sid, ace.aceType, ace.rights, ace.inherit]),
	});
}

test("native: a real owner-controlled parent and a protected private peers directory", { skip: SKIP }, (t) => {
	const root = ownedRoot(t);
	const policy = createPeerStatePermissionPolicy();
	policy.assertOwnerControlledDirectory(root);

	const peers = join(root, "peers");
	mkdirSync(peers);
	policy.protectCreatedDirectory(peers);
	policy.assertPrivateDirectory(peers);

	const observed = realAcl(peers);
	assert.equal(observed.evidence.isDirectory, true);
	assert.equal(observed.evidence.isReparsePoint, false);
	assert.equal(observed.evidence.daclPresent, true);
	assert.equal(observed.evidence.daclProtected, true, "the private DACL must not keep inheriting");
	assert.equal(observed.evidence.ownerSid, observed.currentSid, "the fixture must be owned by this account");
	const sids = new Set(observed.evidence.aces.map((ace) => ace.sid.toUpperCase()));
	for (const sid of sids) {
		assert.ok(
			sid === observed.currentSid.toUpperCase() || sid === LOCAL_SYSTEM || sid === ADMINISTRATORS,
			`unexpected principal in the protected DACL: ${sid}`,
		);
	}
	assert.ok(
		observed.evidence.aces.some((ace) => ace.sid.toUpperCase() === observed.currentSid.toUpperCase()
			&& ace.aceType === "allow"
			&& holdsFullControl(ace.rights)),
		"the owning account must positively hold full control",
	);
});

test("native: a single-ACE DACL is still observed as a complete enumeration", { skip: SKIP }, (t) => {
	const root = ownedRoot(t);
	const policy = createPeerStatePermissionPolicy();
	const current = realAcl(root).currentSid;
	const agent = join(root, "agent");
	mkdirSync(agent);
	// Remove inherited ACEs and leave the owning account's own explicit ACE: the
	// small DACL shape most likely to be serialized as a bare object rather than a
	// one-element array. The raw ACE counts must still reconcile, so the proof of
	// completeness does not depend on that JSON shape.
	execFileSync(icacls(), [agent, "/inheritance:r", "/grant", `*${current}:(OI)(CI)F`], {
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const observed = realAcl(agent);
	assert.equal(observed.evidence.isDirectory, true);
	assert.ok(observed.evidence.daclAceCount >= 1 && observed.evidence.daclAceCount <= 4);
	assert.equal(observed.evidence.daclAceCount, observed.evidence.aces.length);
	assert.equal(observed.evidence.daclOtherCount, 0);
	policy.assertOwnerControlledDirectory(agent);
});

test("native: a real read-only generic parent ACE is accepted with an unsigned ACCESS_MASK", { skip: SKIP }, (t) => {
	const root = ownedRoot(t);
	const policy = createPeerStatePermissionPolicy();
	// `(GR)` is a grantable read-only advanced right. .NET reports its mask as a
	// signed Int32 (GENERIC_READ, 0x80000000), so normalization must not turn a
	// legitimate public-read parent into a permanent refusal.
	const granted = ["(OI)(CI)(GR)", "(OI)(CI)(RX)"].filter((rights) => tryGrantForTest(root, AUTHENTICATED_USERS, rights));
	assert.ok(granted.length > 0, "this host must accept at least one documented read-only ACE");
	policy.assertOwnerControlledDirectory(root);
	const observed = realAcl(root);
	assert.ok(
		observed.evidence.aces.every((ace) => ace.rights >= 0 && ace.rights <= 0xffff_ffff),
		"every reported mask must be a normalized unsigned 32-bit ACCESS_MASK",
	);
	assert.ok(observed.evidence.aces.some((ace) => ace.sid.toUpperCase() === AUTHENTICATED_USERS));
});

test("native: an untrusted security or unknown parent right is refused where the OS accepts it", { skip: SKIP }, (t) => {
	const root = ownedRoot(t);
	const policy = createPeerStatePermissionPolicy();
	// `(AS)` is ACCESS_SYSTEM_SECURITY: read *and rewrite* the SACL. If the host
	// allows the ACE to be created at all, the parent must be refused; otherwise the
	// pure fixtures remain the coverage and this case states that honestly.
	if (!tryGrantForTest(root, AUTHENTICATED_USERS, "(AS)")) {
		t.diagnostic("this host refused to create an ACCESS_SYSTEM_SECURITY ACE; native coverage of that bit is unavailable");
		return;
	}
	const before = describeAcl(root);
	assert.throws(() => policy.assertOwnerControlledDirectory(root), (error) => assertFixedFailure(error, root));
	assert.equal(describeAcl(root), before, "an unknown-right parent is refused, never edited");
});

test("native: an existing broad DACL is refused and never repaired", { skip: SKIP }, (t) => {
	const root = ownedRoot(t);
	const policy = createPeerStatePermissionPolicy();
	const peers = join(root, "peers");
	mkdirSync(peers);
	policy.protectCreatedDirectory(peers);
	grantForTest(peers, AUTHENTICATED_USERS, "(OI)(CI)(RX)");

	const before = describeAcl(peers);
	assert.ok(before.includes(AUTHENTICATED_USERS));
	assert.throws(() => policy.assertPrivateDirectory(peers), (error) => assertFixedFailure(error, root));
	assert.equal(describeAcl(peers), before, "a refused object must be left exactly as found");

	// The protect path must refuse a pre-existing object too, and it does so on
	// eligibility grounds: it is only ever for a newly created empty object, so
	// the broadened object that already holds state is refused outright.
	writeFileSync(join(peers, "state.json"), "PRIOR-STATE");
	const inUse = describeAcl(peers);
	assert.throws(() => policy.protectCreatedDirectory(peers), (error) => assertFixedFailure(error, root));
	assert.equal(describeAcl(peers), inUse, "protect must never rewrite a pre-existing object");
	assert.equal(readFileSync(join(peers, "state.json"), "utf8"), "PRIOR-STATE");
});

test("native: a parent with untrusted write or delete-child authority is refused, not fixed", { skip: SKIP }, (t) => {
	const root = ownedRoot(t);
	const policy = createPeerStatePermissionPolicy();
	// Advanced icacls rights must be comma-separated tokens: write-data/add-file,
	// append-data/add-subdirectory, and delete-child on this folder and children.
	grantForTest(root, EVERYONE, "(OI)(CI)(WD,AD,DC)");
	const before = describeAcl(root);
	assert.ok(before.includes(EVERYONE));
	assert.throws(() => policy.assertOwnerControlledDirectory(root), (error) => assertFixedFailure(error, root));
	assert.equal(describeAcl(root), before, "an unsafe parent is refused whole, never edited");

	const peers = join(root, "peers");
	mkdirSync(peers);
	const childBefore = describeAcl(peers);
	assert.throws(() => policy.protectCreatedDirectory(peers), (error) => assertFixedFailure(error, root));
	assert.equal(describeAcl(peers), childBefore, "the child must be untouched when its parent is unsafe");
});

test("native: protect refuses objects that are not newly created and leaves their bytes intact", { skip: SKIP }, (t) => {
	const root = ownedRoot(t);
	const policy = createPeerStatePermissionPolicy();
	const peers = join(root, "peers");
	mkdirSync(peers);
	policy.protectCreatedDirectory(peers);

	const inUse = join(peers, "in-use");
	mkdirSync(inUse);
	const inner = join(inUse, "state.json");
	writeFileSync(inner, "PRIOR-STATE");
	const before = describeAcl(inUse);
	assert.throws(() => policy.protectCreatedDirectory(inUse), (error) => assertFixedFailure(error, root));
	assert.equal(describeAcl(inUse), before);
	assert.equal(readFileSync(inner, "utf8"), "PRIOR-STATE");

	const nonEmpty = join(peers, "non-empty.json");
	writeFileSync(nonEmpty, "PRIVATE-BYTES");
	const fileBefore = describeAcl(nonEmpty);
	assert.throws(() => policy.protectCreatedFile(nonEmpty), (error) => assertFixedFailure(error, root));
	assert.equal(describeAcl(nonEmpty), fileBefore);
	assert.equal(readFileSync(nonEmpty, "utf8"), "PRIVATE-BYTES");
});

test("native: protection is proven before secret bytes are written, then holds after the write", { skip: SKIP }, (t) => {
	const root = ownedRoot(t);
	const policy = createPeerStatePermissionPolicy();
	policy.assertOwnerControlledDirectory(root);
	const peers = join(root, "peers");
	mkdirSync(peers);
	policy.protectCreatedDirectory(peers);

	const state = join(peers, "state.json");
	writeFileSync(state, "");
	policy.protectCreatedFile(state);
	policy.assertPrivateFile(state); // proven before any key material exists
	writeFileSync(state, "PRIVATE-KEY-MATERIAL");
	policy.assertPrivateFile(state);
	assert.equal(readFileSync(state, "utf8"), "PRIVATE-KEY-MATERIAL");

	const observed = realAcl(state);
	assert.equal(observed.evidence.isDirectory, false);
	assert.equal(observed.evidence.daclProtected, true);
	assert.equal(observed.evidence.ownerSid, observed.currentSid);
	assert.equal(
		observed.evidence.aces.every((ace) => {
			const sid = ace.sid.toUpperCase();
			return ace.aceType === "allow" && (sid === observed.currentSid.toUpperCase() || sid === LOCAL_SYSTEM || sid === ADMINISTRATORS);
		}),
		true,
		"only the owning account and justified OS-privileged SIDs may hold rights",
	);
});

test("native: a reparse point is refused for every assertion", { skip: SKIP }, (t) => {
	const root = ownedRoot(t);
	const policy = createPeerStatePermissionPolicy();
	const target = join(root, "peers");
	mkdirSync(target);
	policy.protectCreatedDirectory(target);

	const link = join(root, "linked");
	try {
		symlinkSync(target, link, "junction");
	} catch {
		t.skip("creating a directory junction requires elevated permission on this host");
		return;
	}
	assert.throws(() => policy.assertPrivateDirectory(link), (error) => assertFixedFailure(error, root));
	assert.throws(() => policy.assertOwnerControlledDirectory(link), (error) => assertFixedFailure(error, root));
	assert.throws(() => policy.protectCreatedDirectory(link), (error) => assertFixedFailure(error, root));
});

test("native: a Unicode and shell-metacharacter path stays exact path data for the helper", { skip: SKIP }, (t) => {
	const root = ownedRoot(t);
	const policy = createPeerStatePermissionPolicy();
	policy.assertOwnerControlledDirectory(root);
	const peers = join(root, "h\u00f4te-\u0394 ' $();");
	mkdirSync(peers);
	// The helper request is pure ASCII JSON, so a non-ASCII path must still reach the
	// real object rather than a console-codepage reinterpretation of it.
	policy.protectCreatedDirectory(peers);
	policy.assertPrivateDirectory(peers);
	const observed = realAcl(peers);
	assert.equal(observed.evidence.daclProtected, true);
	assert.equal(observed.evidence.isDirectory, true);
});

test("native: missing and relative paths fail with the same fixed error", { skip: SKIP }, (t) => {
	const root = ownedRoot(t);
	const policy = createPeerStatePermissionPolicy();
	for (const call of [
		() => policy.assertOwnerControlledDirectory(join(root, "absent")),
		() => policy.assertPrivateDirectory(join(root, "absent")),
		() => policy.assertPrivateFile(join(root, "absent.json")),
		() => policy.assertPrivateDirectory("peers"),
		() => policy.protectCreatedFile("peers/state.json"),
	]) {
		assert.throws(call, (error) => assertFixedFailure(error, root));
	}
});
