/**
 * Focused permission-policy tests for issue #480 peer persistence.
 *
 * POSIX cases use real files, real UIDs and real modes under a freshly created
 * temporary root owned by this test. Windows cases are labelled fixtures: they
 * drive the real verifier code with recorded security-descriptor evidence and
 * prove nothing about a real NTFS host — the native proof lives in
 * `session-host-peer-state-permissions-windows-native.test.ts`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	chmodSync,
	readdirSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
	linkSync,
	existsSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import { isPeerTransportError } from "../src/session-host/network/index";
import { createPeerStatePermissionPolicy, proveExtendedAcl } from "../src/session-host/network/peer-state-permissions";
import {
	verifyOwnerControlledAclEvidence,
	verifyPrivateAclEvidence,
	type WindowsAclAceEvidence,
	type WindowsAclChildResult,
	type WindowsAclEvidence,
	type WindowsAclExecutor,
	type WindowsAclSpawnOptions,
} from "../src/session-host/network/peer-state-windows-permissions";

const FIXED_MESSAGE = "injected peer trust store failed";

/**
 * The real-mode cases need real POSIX semantics; on any other host they would
 * be asserting `chmod` behaviour against the native Windows policy or an
 * unparseable mode. The portable verifier fixtures and the dedicated native
 * Windows suite cover those hosts instead.
 */
const POSIX_HOST = process.platform !== "win32" && typeof process.getuid === "function";
const POSIX_SKIP = POSIX_HOST ? false : "real owner/mode proof requires a POSIX host";
/** Extended ACLs that grant authority apart from the mode bits are macOS-only here. */
const ACL_HOST = process.platform === "darwin";
const ACL_SKIP = ACL_HOST ? false : "extended-ACL fixtures require a macOS host, the one ACL dialect this policy parses";

/** Test-only ACL broadening of a fixture this test created, via a fixed binary. */
/**
 * Fixture root whose finalizer first clears the hostile ACLs this test applied
 * (on macOS an ACL, not the mode, governs access, so a fixture holding a
 * foreign grant can otherwise resist its own removal), then removes only the
 * directory this test created.
 */
function aclFixtureRoot(t: { after: (fn: () => void) => void }): string {
	const root = mkdtempSync(path.join(tmpdir(), "prg-peer-acl-posix-"));
	t.after(() => {
		const clear = (target: string): void => {
			let entries: string[] = [];
			try {
				entries = readdirSync(target);
			} catch {
				return;
			}
			for (const entry of entries) {
				const child = path.join(target, entry);
				try {
					execFileSync("/bin/chmod", ["-N", child], { timeout: 15_000, stdio: "ignore" });
				} catch {
					// Best effort on a fixture this test created.
				}
				try {
					if (lstatSync(child).isDirectory()) clear(child);
				} catch {
					// Unreadable fixture entry: removal below reports it.
				}
			}
		};
		clear(root);
		rmSync(root, { recursive: true, force: true });
	});
	return root;
}

function applyAclEntry(target: string, entry: string): void {
	execFileSync("/bin/chmod", ["+a", entry, target], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "ignore"] });
}

function aclListing(target: string): string {
	return execFileSync("/bin/ls", ["-lde", target], {
		encoding: "utf8",
		timeout: 15_000,
		stdio: ["ignore", "pipe", "ignore"],
		env: { ...process.env, LC_ALL: "C", LANG: "C" },
	});
}

function fixtureRoot(t: { after: (fn: () => void) => void }): string {
	const root = mkdtempSync(path.join(tmpdir(), "prg-peer-perms-"));
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
	});
	return root;
}

function isFixedFailure(error: unknown, fixtureRootPath?: string): boolean {
	assert.ok(error instanceof Error);
	assert.ok(isPeerTransportError(error), `expected a peer transport error, got ${String(error)}`);
	assert.equal(error.code, "TRUST_STORE_FAILED");
	assert.equal(error.message, FIXED_MESSAGE);
	assert.ok(!/EACCES|EPERM|ENOENT|ENOTDIR|Invalid argument/u.test(`${error.message} ${error.stack ?? ""}`), "raw filesystem diagnostic leaked");
	if (fixtureRootPath !== undefined) {
		assert.ok(!error.message.includes(fixtureRootPath), "path diagnostic leaked into the error");
		assert.ok(!String(error.stack ?? "").includes(fixtureRootPath), "path leaked into the stack");
	}
	return true;
}

function modeOf(target: string): number {
	return lstatSync(target).mode & 0o7777;
}

test("import and construction are inert: no filesystem or process work happens", () => {
	const modulePath = path.join(__dirname, "..", "src", "session-host", "network", "peer-state-permissions.js");
	const script = [
		"const fs = require('node:fs');",
		"const cp = require('node:child_process');",
		"// Node's own module loading legitimately reads module files; anything else is ambient IO.",
		"const MODULE_FILE = /\\.(?:js|cjs|mjs|json|node|map|wasm)$/u;",
		"for (const name of ['readFileSync','openSync','statSync','realpathSync']) {",
		"\tconst original = fs[name];",
		"\tif (typeof original !== 'function') throw new Error('missing-fs:' + name);",
		"\tfs[name] = function guarded(target, ...rest) {",
		"\t\tconst target0 = typeof target === 'string' || target instanceof URL ? String(target) : '';",
		"\t\tif (target0 && !MODULE_FILE.test(target0)) throw new Error('ambient-io:' + name + ':' + target0);",
		"\t\treturn original.call(fs, target, ...rest);",
		"\t};",
		"}",
		"for (const name of ['lstatSync','readdirSync','mkdirSync','chmodSync','writeFileSync','appendFileSync','unlinkSync','rmSync','symlinkSync','linkSync','fchmodSync','opendirSync']) {",
		"\tconst original = fs[name];",
		"\tif (typeof original !== 'function') throw new Error('missing-fs:' + name);",
		"\tfs[name] = function guarded() { throw new Error('ambient-io:' + name); };",
		"}",
		"for (const name of ['spawnSync','spawn','execFileSync','execFile','fork']) {",
		"\tcp[name] = function guarded() { throw new Error('ambient-spawn:' + name); };",
		"}",
		`const m = require(${JSON.stringify(modulePath)});`,
		"const posix = m.createPeerStatePermissionPolicy();",
		"// Building the Windows policy must not resolve or launch the interpreter either.",
		"const win32 = m.createPeerStatePermissionPolicy({ platform: 'win32' });",
		"const keys = Object.keys(posix).sort().join(',');",
		"const types = Object.values(posix).map((value) => typeof value).join(',');",
		"const winKeys = Object.keys(win32).length;",
		"process.stdout.write(keys + '|' + types + '|' + winKeys);",
	].join("\n");
	const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 20_000 });
	assert.equal(result.status, 0, `inert construction failed: ${result.stderr}`);
	assert.equal(
		result.stdout.trim(),
		"assertOwnerControlledDirectory,assertPrivateDirectory,assertPrivateFile,protectCreatedDirectory,protectCreatedFile"
			+ "|function,function,function,function,function|5",
	);
});

test("POSIX: owner-controlled parent accepts private or public-read modes and refuses broad ones", { skip: POSIX_SKIP }, (t) => {
	const root = fixtureRoot(t);
	const owner = path.join(root, "agent");
	mkdirSync(owner, { mode: 0o700 });
	const policy = createPeerStatePermissionPolicy();
	policy.assertOwnerControlledDirectory(owner);
	chmodSync(owner, 0o755);
	policy.assertOwnerControlledDirectory(owner); // public read is permissible here
	chmodSync(owner, 0o701);
	policy.assertOwnerControlledDirectory(owner);

	const broad = path.join(root, "world-writable");
	mkdirSync(broad);
	chmodSync(broad, 0o777);
	assert.throws(() => policy.assertOwnerControlledDirectory(broad), (error) => isFixedFailure(error, root));
	assert.equal(modeOf(broad), 0o777, "a refused parent must never be repaired");

	const groupWritable = path.join(root, "group-writable");
	mkdirSync(groupWritable);
	chmodSync(groupWritable, 0o775);
	assert.throws(() => policy.assertOwnerControlledDirectory(groupWritable), (error) => isFixedFailure(error, root));
	assert.equal(modeOf(groupWritable), 0o775);

	const setgid = path.join(root, "setgid");
	mkdirSync(setgid, { mode: 0o755 });
	chmodSync(setgid, 0o2755);
	assert.throws(() => policy.assertOwnerControlledDirectory(setgid), (error) => isFixedFailure(error, root));
	assert.equal(modeOf(setgid), 0o2755);

	const notSearchable = path.join(root, "no-search");
	mkdirSync(notSearchable);
	chmodSync(notSearchable, 0o644);
	assert.throws(() => policy.assertOwnerControlledDirectory(notSearchable), (error) => isFixedFailure(error, root));

	const file = path.join(root, "plain-file");
	writeFileSync(file, "x", { mode: 0o600 });
	assert.throws(() => policy.assertOwnerControlledDirectory(file), (error) => isFixedFailure(error, root));

	const linked = path.join(root, "link-to-agent");
	symlinkSync(owner, linked);
	assert.throws(() => policy.assertOwnerControlledDirectory(linked), (error) => isFixedFailure(error, root));

	assert.throws(() => policy.assertOwnerControlledDirectory(path.join(root, "absent")), (error) => isFixedFailure(error, root));
	assert.throws(() => policy.assertOwnerControlledDirectory("relative/agent"), (error) => isFixedFailure(error, root));
	assert.throws(() => policy.assertOwnerControlledDirectory(""), (error) => isFixedFailure(error, root));
});

test("POSIX: private directory requires exactly 0700 owned by this account, and is never repaired", { skip: POSIX_SKIP }, (t) => {
	const root = fixtureRoot(t);
	const policy = createPeerStatePermissionPolicy();
	const peers = path.join(root, "peers");
	mkdirSync(peers, { mode: 0o700 });
	policy.assertPrivateDirectory(peers);

	for (const [name, mode] of [["world", 0o755], ["group", 0o770], ["other-write", 0o702], ["no-search", 0o600], ["setgid", 0o2700]] as const) {
		const dir = path.join(root, `peers-${name}`);
		mkdirSync(dir, { mode: 0o700 });
		chmodSync(dir, mode);
		assert.throws(() => policy.assertPrivateDirectory(dir), (error) => isFixedFailure(error, root), name);
		assert.equal(modeOf(dir), mode, `${name}: refused directory must keep its mode`);
	}

	const file = path.join(root, "not-a-dir");
	writeFileSync(file, "x", { mode: 0o600 });
	assert.throws(() => policy.assertPrivateDirectory(file), (error) => isFixedFailure(error, root));
	const linked = path.join(root, "linked-dir");
	symlinkSync(peers, linked);
	assert.throws(() => policy.assertPrivateDirectory(linked), (error) => isFixedFailure(error, root));
	assert.throws(() => policy.assertPrivateDirectory(path.join(root, "absent-dir")), (error) => isFixedFailure(error, root));
});

test("POSIX: private file requires exactly 0600, one link, and refuses links and broad modes untouched", { skip: POSIX_SKIP }, (t) => {
	const root = fixtureRoot(t);
	const policy = createPeerStatePermissionPolicy();
	const good = path.join(root, "state.json");
	writeFileSync(good, "", { mode: 0o600 });
	policy.assertPrivateFile(good);

	const broad = path.join(root, "broad.json");
	const secret = "PEM-BYTES-MUST-STAY-PUT";
	writeFileSync(broad, secret, { mode: 0o644 });
	assert.throws(() => policy.assertPrivateFile(broad), (error) => isFixedFailure(error, root));
	assert.equal(modeOf(broad), 0o644, "a refused file must never be chmod'd into passing");
	assert.equal(readFileSync(broad, "utf8"), secret);

	const groupReadable = path.join(root, "group.json");
	writeFileSync(groupReadable, "", { mode: 0o660 });
	assert.throws(() => policy.assertPrivateFile(groupReadable), (error) => isFixedFailure(error, root));

	const extraLink = path.join(root, "extra-link.json");
	linkSync(good, extraLink);
	assert.equal(modeOf(good), 0o600);
	assert.throws(() => policy.assertPrivateFile(extraLink), (error) => isFixedFailure(error, root));
	assert.throws(() => policy.assertPrivateFile(good), (error) => isFixedFailure(error, root), "both names of a two-link inode are refused");

	const symlinked = path.join(root, "link.json");
	symlinkSync(good, symlinked);
	assert.throws(() => policy.assertPrivateFile(symlinked), (error) => isFixedFailure(error, root));

	const dir = path.join(root, "dir-as-file");
	mkdirSync(dir, { mode: 0o700 });
	assert.throws(() => policy.assertPrivateFile(dir), (error) => isFixedFailure(error, root));
	assert.throws(() => policy.assertPrivateFile(path.join(root, "absent.json")), (error) => isFixedFailure(error, root));
});

test("POSIX: protectCreatedDirectory establishes 0700 on a new empty owned directory only", { skip: POSIX_SKIP }, (t) => {
	const root = fixtureRoot(t);
	const policy = createPeerStatePermissionPolicy();
	const parent = path.join(root, "agent");
	mkdirSync(parent, { mode: 0o755 });

	const fresh = path.join(parent, "peers");
	mkdirSync(fresh, { mode: 0o755 }); // created with a broad inherited-style mode
	policy.protectCreatedDirectory(fresh);
	assert.equal(modeOf(fresh), 0o700);
	policy.assertPrivateDirectory(fresh);

	const alreadyPrivate = path.join(parent, "peers-b");
	mkdirSync(alreadyPrivate, { mode: 0o700 });
	policy.protectCreatedDirectory(alreadyPrivate);
	assert.equal(modeOf(alreadyPrivate), 0o700);

	// An in-use pre-existing directory is not a created object: refused, untouched.
	const inUse = path.join(parent, "peers-in-use");
	mkdirSync(inUse, { mode: 0o755 });
	writeFileSync(path.join(inUse, "state.json"), "existing", { mode: 0o644 });
	assert.throws(() => policy.protectCreatedDirectory(inUse), (error) => isFixedFailure(error, root));
	assert.equal(modeOf(inUse), 0o755, "an existing directory must never be repaired");
	assert.equal(readFileSync(path.join(inUse, "state.json"), "utf8"), "existing");
	assert.equal(modeOf(path.join(inUse, "state.json")), 0o644);

	// Unsafe parent: refused before the new child is touched at all.
	const unsafeParent = path.join(root, "world-agent");
	mkdirSync(unsafeParent);
	chmodSync(unsafeParent, 0o777);
	const child = path.join(unsafeParent, "peers");
	mkdirSync(child, { mode: 0o755 });
	assert.throws(() => policy.protectCreatedDirectory(child), (error) => isFixedFailure(error, root));
	assert.equal(modeOf(child), 0o755);
	assert.equal(modeOf(unsafeParent), 0o777);

	const linked = path.join(parent, "peers-link");
	symlinkSync(fresh, linked);
	assert.throws(() => policy.protectCreatedDirectory(linked), (error) => isFixedFailure(error, root));
});

test("POSIX: protectCreatedFile establishes 0600 on a new empty owned file only", { skip: POSIX_SKIP }, (t) => {
	const root = fixtureRoot(t);
	const policy = createPeerStatePermissionPolicy();
	const parent = path.join(root, "agent");
	mkdirSync(parent, { mode: 0o755 });
	const peers = path.join(parent, "peers");
	mkdirSync(peers, { mode: 0o700 });

	const state = path.join(peers, "state.json");
	writeFileSync(state, "", { mode: 0o644 });
	policy.protectCreatedFile(state);
	assert.equal(modeOf(state), 0o600);
	policy.assertPrivateFile(state);

	// A file that already holds bytes is not a created object.
	const existing = path.join(peers, "existing.json");
	writeFileSync(existing, "PRIOR", { mode: 0o644 });
	assert.throws(() => policy.protectCreatedFile(existing), (error) => isFixedFailure(error, root));
	assert.equal(modeOf(existing), 0o644, "an existing file must never be repaired");
	assert.equal(readFileSync(existing, "utf8"), "PRIOR");

	// A non-private parent is refused even though the file itself is private.
	const openParent = path.join(root, "open-agent");
	mkdirSync(openParent, { mode: 0o755 });
	const openState = path.join(openParent, "state.json");
	writeFileSync(openState, "", { mode: 0o600 });
	assert.throws(() => policy.protectCreatedFile(openState), (error) => isFixedFailure(error, root));
	assert.equal(modeOf(openState), 0o600);

	const linked = path.join(peers, "link.json");
	symlinkSync(state, linked);
	assert.throws(() => policy.protectCreatedFile(linked), (error) => isFixedFailure(error, root));
});

test("POSIX: protection is proven before any secret byte is written, and a refused file is never accepted later", { skip: POSIX_SKIP }, (t) => {
	const root = fixtureRoot(t);
	const policy = createPeerStatePermissionPolicy();
	const agentDir = path.join(root, "agent");
	mkdirSync(agentDir, { mode: 0o755 });
	policy.assertOwnerControlledDirectory(agentDir);
	const peers = path.join(agentDir, "peers");
	mkdirSync(peers, { mode: 0o700 });
	policy.protectCreatedDirectory(peers);

	const writes: Array<{ at: string; mode: number | null }> = [];
	const state = path.join(peers, "state.json");
	const writeSecret = (material: string): void => {
		// The caller's ordering rule: the file must already be private at the
		// moment bytes are written, and the mode observed here is the evidence.
		let mode: number | null = null;
		try {
			mode = lstatSync(state).mode & 0o7777;
		} catch {
			mode = null;
		}
		writes.push({ at: "pre-write-observation", mode });
		writeFileSync(state, material, { mode: 0o600, flag: "wx" });
		policy.assertPrivateFile(state);
		writes.push({ at: "post-write-assert", mode: modeOf(state) });
	};

	writeSecret("PRIVATE-KEY-MATERIAL");
	assert.deepEqual(writes, [
		{ at: "pre-write-observation", mode: null },
		{ at: "post-write-assert", mode: 0o600 },
	]);
	assert.equal(readFileSync(state, "utf8"), "PRIVATE-KEY-MATERIAL");

	// Reversed ordering (bytes first into a broad file) is refused and untouched.
	const sloppy = path.join(peers, "sloppy.json");
	writeFileSync(sloppy, "PRIVATE-KEY-MATERIAL", { mode: 0o644 });
	assert.throws(() => policy.assertPrivateFile(sloppy), (error) => isFixedFailure(error, root));
	assert.equal(modeOf(sloppy), 0o644);
	assert.equal(readFileSync(sloppy, "utf8"), "PRIVATE-KEY-MATERIAL");
});

test("an unsupported platform fails closed instead of reporting success", { skip: POSIX_SKIP }, (t) => {
	const root = fixtureRoot(t);
	const dir = path.join(root, "peers");
	mkdirSync(dir, { mode: 0o700 });
	const file = path.join(dir, "state.json");
	writeFileSync(file, "", { mode: 0o600 });
	// Only Linux, macOS and Windows are actually verified. Every other POSIX-ish
	// platform prints ACLs (or has permission semantics) this library does not
	// implement, so it refuses rather than advertising unverified protection.
	for (const platform of ["aix", "android", "freebsd", "haiku", "netbsd", "openbsd", "sunos", "unknown-os"]) {
		const policy = createPeerStatePermissionPolicy({ platform: platform as NodeJS.Platform });
		for (const call of [
			() => policy.assertOwnerControlledDirectory(dir),
			() => policy.assertPrivateDirectory(dir),
			() => policy.assertPrivateFile(file),
			() => policy.protectCreatedDirectory(dir),
			() => policy.protectCreatedFile(file),
		]) {
			assert.throws(call, (error) => isFixedFailure(error, root), platform);
		}
	}
	assert.equal(modeOf(dir), 0o700);
	assert.equal(modeOf(file), 0o600);
});

/* ------------------------------------------------------------------ *
 * Windows verifier fixtures. These are recorded security-descriptor
 * observations fed to the real verifier code on a non-Windows host; they are
 * not, and are not reported as, native NTFS protection evidence.
 * ------------------------------------------------------------------ */

const CURRENT = "S-1-5-21-1111-2222-3333-1001";
const SYSTEM = "S-1-5-18";
const ADMINISTRATORS = "S-1-5-32-544";
const FULL_CONTROL = 0x1000_0000;
const READ_EXECUTE = 0x0000_0020 | 0x0000_0001 | 0x0000_0080 | 0x0002_0000 | 0x0010_0000;
/** Real `ACCESS_MASK` values whose high bit makes .NET's signed enum negative. */
const GENERIC_READ = 0x8000_0000;
const GENERIC_EXECUTE = 0x2000_0000;
const SYNCHRONIZE = 0x0010_0000;
const READ_CONTROL = 0x0002_0000;
const ACCESS_SYSTEM_SECURITY = 0x0100_0000;
const MAXIMUM_ALLOWED = 0x0200_0000;
/** A bit that is not part of any documented ACCESS_MASK: never quietly accepted. */
const UNKNOWN_ACCESS_BIT = 0x0800_0000;
const PRIVATE_DIRECTORY_RIGHTS = 0x0000_0001 | 0x0000_0002 | 0x0000_0004 | 0x0000_0008 | 0x0000_0010
	| 0x0000_0020 | 0x0000_0040 | 0x0000_0080 | 0x0000_0100 | 0x0001_0000 | 0x0002_0000;
const PRIVATE_FILE_RIGHTS = 0x0000_0001 | 0x0000_0002 | 0x0000_0008 | 0x0000_0010 | 0x0000_0080
	| 0x0000_0100 | 0x0001_0000 | 0x0002_0000;
/**
 * "Full control" reaches the verifier in two encodings: the .NET `FullControl`
 * / `GENERIC_ALL` value, and the specific-NTFS-rights mask written by tools
 * such as `icacls`. Real hosts show both.
 */
const FULL_CONTROL_GENERIC = 0x1000_0000;
const FULL_CONTROL_SPECIFIC = 0x001f_01ff;

function ace(sid: string, rights: number, overrides: Partial<WindowsAclAceEvidence> = {}): WindowsAclAceEvidence {
	return { sid, aceType: "allow", rights, inherit: 3, propagate: 0, inherited: false, ...overrides };
}

function evidence(overrides: Partial<WindowsAclEvidence> = {}): WindowsAclEvidence {
	const base: WindowsAclEvidence = {
		isDirectory: true,
		isReparsePoint: false,
		entryCount: 0,
		fileLength: 0,
		ownerSid: CURRENT,
		daclPresent: true,
		daclProtected: true,
		daclAceCount: 0,
		daclAllowCount: 0,
		daclDenyCount: 0,
		daclOtherCount: 0,
		aces: [
			ace(CURRENT, FULL_CONTROL),
			ace(SYSTEM, FULL_CONTROL, { inherited: true }),
			ace(ADMINISTRATORS, FULL_CONTROL, { inherited: true }),
		],
		parentExists: true,
		parentIsReparsePoint: false,
		...overrides,
	};
	// By default the raw DACL counts match the reported rules exactly: every
	// enumerated ACE is one raw allow or deny entry.
	const deny = base.aces.filter((entry) => entry.aceType === "deny").length;
	return {
		...base,
		daclAceCount: overrides.daclAceCount ?? base.aces.length,
		daclAllowCount: overrides.daclAllowCount ?? base.aces.length - deny,
		daclDenyCount: overrides.daclDenyCount ?? deny,
		daclOtherCount: overrides.daclOtherCount ?? 0,
	};
}

test("Windows fixtures: inherit-only owner rights do not prove access to the directory", () => {
	const fixture = evidence({
		aces: [ace(CURRENT, FULL_CONTROL_SPECIFIC, { propagate: 2 })],
	});
	assert.equal(verifyOwnerControlledAclEvidence(fixture, CURRENT), false);
	assert.equal(verifyPrivateAclEvidence(fixture, CURRENT, "dir"), false);
	assert.equal(
		verifyPrivateAclEvidence(
			evidence({ isDirectory: false, entryCount: -1, aces: [ace(CURRENT, FULL_CONTROL_SPECIFIC, { propagate: 2 })] }),
			CURRENT,
			"file",
		),
		false,
	);
	// An inherit-only grant from an untrusted principal stays refused too.
	assert.equal(
		verifyOwnerControlledAclEvidence(
			evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", 0x0000_0002, { propagate: 2 })] }),
			CURRENT,
		),
		false,
	);
	// While a real applying grant alongside an inherit-only one still passes.
	assert.equal(
		verifyOwnerControlledAclEvidence(
			evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace(CURRENT, FULL_CONTROL_SPECIFIC, { propagate: 2 })] }),
			CURRENT,
		),
		true,
	);
	assert.equal(
		verifyPrivateAclEvidence(
			evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace(CURRENT, FULL_CONTROL_SPECIFIC, { propagate: 2 })] }),
			CURRENT,
			"dir",
		),
		true,
	);
});

test("Windows fixtures: a private owner-only protected DACL passes for directories and files", () => {
	assert.equal(verifyPrivateAclEvidence(evidence(), CURRENT, "dir"), true);
	assert.equal(verifyPrivateAclEvidence(evidence({ isDirectory: false, entryCount: -1, fileLength: 0 }), CURRENT, "file"), true);
	assert.equal(
		verifyPrivateAclEvidence(
			evidence({
				aces: [ace(CURRENT, PRIVATE_DIRECTORY_RIGHTS), ace(SYSTEM, FULL_CONTROL, { inherited: true })],
			}),
			CURRENT,
			"dir",
		),
		true,
		"explicit numeric rights must satisfy the requirement as well as FullControl",
	);
	assert.equal(
		verifyPrivateAclEvidence(
			evidence({ aces: [ace(CURRENT, FULL_CONTROL_SPECIFIC)] }),
			CURRENT,
			"dir",
		),
		true,
		"the specific-NTFS-rights form of full control must pass too",
	);
	assert.equal(
		verifyPrivateAclEvidence(
			evidence({ isDirectory: false, entryCount: -1, aces: [ace(CURRENT, PRIVATE_FILE_RIGHTS)] }),
			CURRENT,
			"file",
		),
		true,
	);
});

test("Windows fixtures: any other principal, deny entry, null or inherited DACL, or reparse is refused", () => {
	const refusals: Array<[string, WindowsAclEvidence, "dir" | "file"]> = [
		["everyone-read", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-1-0", READ_EXECUTE)] }), "dir"],
		["authenticated-users-inherit-only-write", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", 0x0000_0002, { inherit: 1, inherited: true })] }), "dir"],
		["users-file-write", evidence({ isDirectory: false, entryCount: -1, aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-32-545", 0x0000_0002)] }), "file"],
		["deny-entry", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", 0x0000_0002, { aceType: "deny" })] }), "dir"],
		["null-dacl", evidence({ daclPresent: false, aces: [ace(CURRENT, FULL_CONTROL)] }), "dir"],
		["inherited-dacl", evidence({ daclProtected: false }), "dir"],
		["inherited-dacl-file", evidence({ isDirectory: false, entryCount: -1, daclProtected: false }), "file"],
		["foreign-owner", evidence({ ownerSid: SYSTEM }), "dir"],
		["reparse-point", evidence({ isReparsePoint: true }), "dir"],
		["parent-reparse", evidence({ parentIsReparsePoint: true }), "file"],
		["missing-parent", evidence({ parentExists: false }), "dir"],
		["directory-checked-as-file", evidence({ fileLength: 0 }), "file"],
		["file-checked-as-directory", evidence({ isDirectory: false, entryCount: -1 }), "dir"],
		["account-lacks-required-rights", evidence({ aces: [ace(CURRENT, READ_EXECUTE)] }), "dir"],
		["account-write-only", evidence({ isDirectory: false, entryCount: -1, aces: [ace(CURRENT, 0x0000_0002 | 0x0000_0100)] }), "file"],
		["no-aces", evidence({ aces: [] }), "dir"],
	];
	for (const [name, fixture, kind] of refusals) {
		assert.equal(verifyPrivateAclEvidence(fixture, CURRENT, kind), false, name);
	}
});

test("Windows fixtures: parent proof refuses untrusted write, delete-child, and ACL/ownership authority", () => {
	assert.equal(verifyOwnerControlledAclEvidence(evidence(), CURRENT), true);
	assert.equal(
		verifyOwnerControlledAclEvidence(
			evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-1-0", READ_EXECUTE)] }),
			CURRENT,
		),
		true,
		"public read/traverse on the parent is permissible",
	);
	const refusals: Array<[string, WindowsAclEvidence]> = [
		["untrusted-add-file", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-32-545", 0x0000_0002)] })],
		["untrusted-inherit-only-add-subdirectory", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", 0x0000_0004, { inherit: 1, inherited: true })] })],
		["untrusted-append-data", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", 0x0000_0004)] })],
		["untrusted-delete-child", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", 0x0000_0040)] })],
		["untrusted-change-permissions", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", 0x0004_0000)] })],
		["untrusted-take-ownership", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", 0x0008_0000)] })],
		["untrusted-delete", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", 0x0001_0000)] })],
		["untrusted-generic-write", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", 0x4000_0000)] })],
		["untrusted-full-control", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", FULL_CONTROL)] })],
		["untrusted-specific-full-control", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", FULL_CONTROL_SPECIFIC)] })],
		["untrusted-maximum-allowed", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", 0x0200_0000)] })],
		["null-dacl-parent", evidence({ daclPresent: false })],
		["deny-entry-parent", evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-1-0", READ_EXECUTE, { aceType: "deny" })] })],
		["reparse-parent-dir", evidence({ isReparsePoint: true })],
		["not-a-directory", evidence({ isDirectory: false, entryCount: -1 })],
		["account-cannot-manage-children", evidence({ aces: [ace(CURRENT, READ_EXECUTE)] })],
		["no-aces-parent", evidence({ aces: [] })],
	];
	for (const [name, fixture] of refusals) {
		assert.equal(verifyOwnerControlledAclEvidence(fixture, CURRENT), false, name);
	}
});

interface RecordedCall {
	op: string;
	path: string;
	kind?: string;
	args: readonly string[];
	options: WindowsAclSpawnOptions;
	file: string;
}

function windowsFixturePolicy(responses: (call: { op: string; path: string; kind?: string }) => WindowsAclChildResult) {
	const calls: RecordedCall[] = [];
	const execute: WindowsAclExecutor = (file, args, options) => {
		const request = JSON.parse(options.input) as { op: string; path: string; kind?: string };
		calls.push({ op: request.op, path: request.path, kind: request.kind, args, options, file });
		return responses(request);
	};
	const policy = createPeerStatePermissionPolicy({
		platform: "win32",
		windows: { execute, resolveExecutable: () => "/opt/fake-system/powershell.exe" },
	});
	return { policy, calls };
}

function helperSuccess(request: { op: string; path: string; kind?: string }, fixture: WindowsAclEvidence): WindowsAclChildResult {
	void request;
	return { status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: CURRENT, evidence: fixture }) };
}

const WINDOWS_PRIVATE_DIR = evidence();
const WINDOWS_PRIVATE_FILE = evidence({ isDirectory: false, entryCount: -1, fileLength: 0 });
const WINDOWS_PARENT = evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-1-0", READ_EXECUTE)] });

test("Windows fixtures: helper execution is fixed, bounded, and carries no path or secret in the script arguments", () => {
	const { policy, calls } = windowsFixturePolicy((request) =>
		helperSuccess(request, request.path === "/agent/peers" ? WINDOWS_PRIVATE_DIR : WINDOWS_PRIVATE_FILE));
	policy.protectCreatedFile("/agent/peers/state.json");

	assert.equal(calls.length, 2);
	const [parentCall, protectCall] = calls;
	assert.deepEqual(
		parentCall.args.slice(0, 6),
		["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"],
	);
	assert.equal(parentCall.args.length, 7, "the fixed script is the only script content");
	for (const call of calls) {
		for (const arg of call.args) {
			assert.ok(!arg.includes("state.json"), "a path must never reach the script text");
			assert.ok(!arg.includes("/agent"), "a path must never reach the script text");
			assert.ok(!arg.includes("PRIVATE-KEY"), "secret material must never reach the helper");
		}
		const request = JSON.parse(call.options.input) as Record<string, unknown>;
		assert.equal(request.v, 1);
		assert.equal(typeof request.path, "string");
		assert.ok(call.options.input.length <= 8192);
		assert.ok(call.options.timeoutMs > 0 && call.options.timeoutMs <= 15_000);
		assert.ok(call.options.maxBufferBytes > 0 && call.options.maxBufferBytes <= 64 * 1024);
		assert.equal(call.options.cwd, "/opt/fake-system");
		assert.equal(call.file, "/opt/fake-system/powershell.exe");
	}
	assert.equal(parentCall.op, "inspect");
	assert.equal(parentCall.path, "/agent/peers");
	assert.equal(protectCall.op, "protect");
	assert.equal(protectCall.kind, "file");
	assert.equal(protectCall.path, "/agent/peers/state.json");
});

test("Windows fixtures: protection is verified after the change and an unverifiable result is refused", () => {
	const { policy, calls } = windowsFixturePolicy((request) =>
		helperSuccess(request, request.op === "protect" ? WINDOWS_PARENT : WINDOWS_PRIVATE_DIR));
	assert.throws(() => policy.protectCreatedDirectory("/agent/peers"), (error) => isFixedFailure(error));
	assert.equal(calls.map((call) => call.op).join(","), "inspect,protect");
});

test("Windows fixtures: an unsafe parent is refused before any protect call is issued", () => {
	const { policy, calls } = windowsFixturePolicy((request) => {
		if (request.path === "/agent/peers") {
			return helperSuccess(request, evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", 0x0000_0002, { inherit: 1, inherited: true })] }));
		}
		return helperSuccess(request, WINDOWS_PRIVATE_DIR);
	});
	assert.throws(() => policy.protectCreatedDirectory("/agent/peers/inner"), (error) => isFixedFailure(error));
	assert.deepEqual(calls.map((call) => call.op), ["inspect"], "no mutation may be requested for an unsafe parent");
});

test("Windows fixtures: file protection requires a private containing directory first", () => {
	const { policy, calls } = windowsFixturePolicy(() => ({ status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: CURRENT, evidence: WINDOWS_PARENT }) }));
	assert.throws(() => policy.protectCreatedFile("/agent/peers/state.json"), (error) => isFixedFailure(error));
	assert.deepEqual(calls.map((call) => call.op), ["inspect"]);
});

test("Windows fixtures: helper failures, malformed evidence, and oversized output all fail closed", () => {
	const cases: Array<[string, WindowsAclChildResult]> = [
		["nonzero-exit", { status: 3, stdout: "" }],
		["killed", { status: null, stdout: "" }],
		["empty-output", { status: 0, stdout: "" }],
		["not-json", { status: 0, stdout: "Access is denied" }],
		["wrong-protocol", { status: 0, stdout: JSON.stringify({ v: 2, ok: true, currentSid: CURRENT, evidence: WINDOWS_PRIVATE_DIR }) }],
		["not-ok", { status: 0, stdout: JSON.stringify({ v: 1, ok: false, currentSid: CURRENT, evidence: WINDOWS_PRIVATE_DIR }) }],
		["missing-current-sid", { status: 0, stdout: JSON.stringify({ v: 1, ok: true, evidence: WINDOWS_PRIVATE_DIR }) }],
		["zero-rights", { status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: CURRENT, evidence: evidence({ aces: [ace(CURRENT, 0)] }) }) }],
		["localized-sid-text", { status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: CURRENT, evidence: evidence({ aces: [{ sid: "NT AUTHORITY\\SYSTEM", aceType: "allow", rights: FULL_CONTROL, inherit: 3, propagate: 0, inherited: false }] }) }) }],
		["rendered-icacls-text", { status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: CURRENT, evidence: "BUILTIN\\Administrators:(OI)(CI)(F)" }) }],
		["null-dacl-empty-aces", { status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: CURRENT, evidence: evidence({ daclPresent: false, aces: [] }) }) }],
		["missing-raw-ace-counts", { status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: CURRENT, evidence: { ...WINDOWS_PRIVATE_DIR, daclAceCount: undefined } }) }],
		["raw-count-without-matching-aces", { status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: CURRENT, evidence: { ...WINDOWS_PRIVATE_DIR, daclAceCount: 4, daclAllowCount: 4 } }) }],
		["signed-int32-rights", { status: 0, stdout: JSON.stringify({ v: 1, ok: true, currentSid: CURRENT, evidence: evidence({ aces: [ace(CURRENT, -2_147_483_648)] }) }) }],
		["oversized-output", { status: 0, stdout: `${JSON.stringify({ v: 1, ok: true, currentSid: CURRENT, evidence: WINDOWS_PRIVATE_DIR })}${"x".repeat(70 * 1024)}` }],
	];
	for (const [name, response] of cases) {
		const { policy } = windowsFixturePolicy(() => response);
		assert.throws(
			() => policy.assertPrivateDirectory("/agent/peers"),
			(error) => isFixedFailure(error),
			name,
		);
		assert.throws(() => policy.assertOwnerControlledDirectory("/agent"), (error) => isFixedFailure(error), name);
		assert.throws(() => policy.assertPrivateFile("/agent/peers/state.json"), (error) => isFixedFailure(error), name);
	}
});

test("Windows fixtures: a missing trusted interpreter or a throwing helper is a fixed refusal", () => {
	const missing = createPeerStatePermissionPolicy({
		platform: "win32",
		windows: { resolveExecutable: () => null, execute: () => ({ status: 0, stdout: "{}" }) },
	});
	assert.throws(() => missing.assertPrivateDirectory("/agent/peers"), (error) => isFixedFailure(error));
	const throwing = createPeerStatePermissionPolicy({
		platform: "win32",
		windows: {
			resolveExecutable: () => "/opt/fake-system/powershell.exe",
			execute: () => {
				throw new Error("spawn EACCES /agent/peers");
			},
		},
	});
	assert.throws(
		() => throwing.assertPrivateDirectory("/agent/peers"),
		(error) => {
			isFixedFailure(error);
			const stack = error instanceof Error ? error.stack ?? "" : String(error);
			assert.ok(!stack.includes("spawn EACCES"), "raw helper diagnostic must not propagate");
			return true;
		},
	);
	const relative = createPeerStatePermissionPolicy({
		platform: "win32",
		windows: { resolveExecutable: () => "powershell.exe", execute: () => ({ status: 0, stdout: "{}" }) },
	});
	assert.throws(() => relative.assertPrivateDirectory("/agent/peers"), (error) => isFixedFailure(error));
});

test("Windows fixtures: paths are refused before any helper launch", () => {
	const { policy, calls } = windowsFixturePolicy((request) => helperSuccess(request, WINDOWS_PRIVATE_DIR));
	for (const bad of ["", "agent\\peers", `/agent/${"x".repeat(2_500)}`]) {
		assert.throws(() => policy.assertPrivateDirectory(bad), (error) => isFixedFailure(error));
	}
	assert.deepEqual(calls, []);
});

test("Windows fixtures: real ACCESS_MASK values are normalized and bounded to uint32", () => {
	// The helper re-masks .NET's signed FileSystemRights enum to the low 32 bits, so
	// GENERIC_READ arrives as 2147483648 and never as the sign-extended negative.
	assert.equal(
		verifyOwnerControlledAclEvidence(
			evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", GENERIC_READ)] }),
			CURRENT,
		),
		true,
		"a read-only generic mask must not be rejected because its high bit is set",
	);
	assert.equal(
		verifyOwnerControlledAclEvidence(
			evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", GENERIC_READ | GENERIC_EXECUTE)] }),
			CURRENT,
		),
		true,
	);
	// A 32-bit mask that carries bits outside the documented ACCESS_MASK is refused.
	assert.equal(verifyPrivateAclEvidence(evidence({ aces: [ace(CURRENT, 0xffff_ffff)] }), CURRENT, "dir"), false);
	assert.equal(verifyOwnerControlledAclEvidence(evidence({ aces: [ace(CURRENT, 0xffff_ffff)] }), CURRENT), false);
	// Nothing wider than 32 bits is an ACCESS_MASK, so parsing refuses it outright.
	for (const rights of [0x1_0000_0000, 0xffff_ffff_ffff]) {
		const { policy } = windowsFixturePolicy(() => ({
			status: 0,
			stdout: JSON.stringify({ v: 1, ok: true, currentSid: CURRENT, evidence: evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-1-0", rights)] }) }),
		}));
		assert.throws(() => policy.assertOwnerControlledDirectory("/agent"), (error) => isFixedFailure(error), `0x${rights.toString(16)}`);
	}
});

test("Windows fixtures: the untrusted parent allowance is a known read-only allow-list", () => {
	const parentAccepts = (rights: number): boolean =>
		verifyOwnerControlledAclEvidence(
			evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", rights)] }),
			CURRENT,
		);
	for (const permitted of [
		READ_EXECUTE,
		GENERIC_READ,
		GENERIC_EXECUTE,
		READ_EXECUTE | SYNCHRONIZE | READ_CONTROL,
		GENERIC_READ | GENERIC_EXECUTE,
	]) {
		assert.equal(parentAccepts(permitted), true, `0x${permitted.toString(16)} is documented read-only`);
	}
	for (const refused of [
		ACCESS_SYSTEM_SECURITY,
		ACCESS_SYSTEM_SECURITY | READ_EXECUTE,
		MAXIMUM_ALLOWED,
		UNKNOWN_ACCESS_BIT,
		0x0000_0002,
		0x0000_0040,
		0x0001_0000,
		0x0004_0000,
		0x0008_0000,
		0x0000_0100,
		FULL_CONTROL,
		FULL_CONTROL_SPECIFIC,
		0xffff_ffff,
	]) {
		assert.equal(parentAccepts(refused), false, `0x${refused.toString(16)} must be refused`);
	}
	// Inherit-only does not soften the allow-list: that grant lands on the child.
	assert.equal(
		verifyOwnerControlledAclEvidence(
			evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-5-11", ACCESS_SYSTEM_SECURITY, { inherit: 10, propagate: 2 })] }),
			CURRENT,
		),
		false,
	);
	// A trusted ACE carrying an unknown bit is not quietly ignored either.
	assert.equal(verifyOwnerControlledAclEvidence(evidence({ aces: [ace(CURRENT, FULL_CONTROL | UNKNOWN_ACCESS_BIT)] }), CURRENT), false);
	assert.equal(
		verifyPrivateAclEvidence(evidence({ aces: [ace(CURRENT, FULL_CONTROL | UNKNOWN_ACCESS_BIT)] }), CURRENT, "dir"),
		false,
	);
});

test("Windows fixtures: an omitted, unsupported, or conditional raw ACE never counts as complete proof", () => {
	// The raw DACL holds more (or fewer) entries than `GetAccessRules` reported.
	assert.equal(verifyOwnerControlledAclEvidence(evidence({ daclAceCount: 4, daclAllowCount: 4 }), CURRENT), false);
	assert.equal(verifyPrivateAclEvidence(evidence({ daclAceCount: 4, daclAllowCount: 4 }), CURRENT, "dir"), false);
	assert.equal(verifyOwnerControlledAclEvidence(evidence({ daclAceCount: 2, daclAllowCount: 2 }), CURRENT), false);
	// Audit (2/3), object (5/6), callback/conditional (9/10), and unknown raw types.
	assert.equal(verifyOwnerControlledAclEvidence(evidence({ daclAceCount: 4, daclAllowCount: 3, daclOtherCount: 1 }), CURRENT), false);
	assert.equal(verifyPrivateAclEvidence(evidence({ daclAceCount: 4, daclAllowCount: 3, daclOtherCount: 1 }), CURRENT, "dir"), false);
	// The enumerated allow/deny split must match the raw split too.
	assert.equal(verifyOwnerControlledAclEvidence(evidence({ daclAllowCount: 2, daclDenyCount: 1 }), CURRENT), false);
	// A deny ACE that is enumerated still refuses a private object.
	assert.equal(
		verifyPrivateAclEvidence(
			evidence({ aces: [ace(CURRENT, FULL_CONTROL), ace("S-1-1-0", READ_EXECUTE, { aceType: "deny" })] }),
			CURRENT,
			"dir",
		),
		false,
	);
	// A single-ACE DACL that PowerShell's JSON serializer emitted unwrapped is still
	// exactly one ACE, because the raw count agrees; a contradictory count refuses.
	const singleUnwrapped = { ...evidence({ aces: [ace(CURRENT, FULL_CONTROL)] }), aces: ace(CURRENT, FULL_CONTROL) };
	const unwrappedPolicy = windowsFixturePolicy(() => ({
		status: 0,
		stdout: JSON.stringify({ v: 1, ok: true, currentSid: CURRENT, evidence: singleUnwrapped }),
	}));
	unwrappedPolicy.policy.assertPrivateDirectory("/agent/peers");
	const inconsistent = windowsFixturePolicy(() => ({
		status: 0,
		stdout: JSON.stringify({ v: 1, ok: true, currentSid: CURRENT, evidence: { ...singleUnwrapped, daclAceCount: 2, daclAllowCount: 2 } }),
	}));
	assert.throws(() => inconsistent.policy.assertPrivateDirectory("/agent/peers"), (error) => isFixedFailure(error));
});

test("Windows fixtures: protection re-checks that the object is still the empty created object", () => {
	const populatedDirectory = windowsFixturePolicy((request) =>
		helperSuccess(request, request.op === "protect" ? evidence({ entryCount: 1 }) : WINDOWS_PRIVATE_DIR));
	assert.throws(() => populatedDirectory.policy.protectCreatedDirectory("/agent/peers"), (error) => isFixedFailure(error));

	const alreadyWrittenFile = windowsFixturePolicy((request) =>
		helperSuccess(
			request,
			request.op === "protect" ? evidence({ isDirectory: false, entryCount: -1, fileLength: 12 }) : WINDOWS_PRIVATE_DIR,
		));
	assert.throws(
		() => alreadyWrittenFile.policy.protectCreatedFile("/agent/peers/state.json"),
		(error) => isFixedFailure(error),
		"a file that already holds bytes is not a created object",
	);
});

test("Windows fixtures: a drive-root parent is C:\\, never the drive-relative C:", () => {
	const driveRoot = windowsFixturePolicy((request) => helperSuccess(request, WINDOWS_PRIVATE_DIR));
	driveRoot.policy.protectCreatedDirectory("C:\\peers");
	assert.deepEqual(driveRoot.calls.map((call) => [call.op, call.path]), [
		["inspect", "C:\\"],
		["protect", "C:\\peers"],
	]);

	const nested = windowsFixturePolicy((request) => helperSuccess(request, WINDOWS_PRIVATE_DIR));
	nested.policy.protectCreatedDirectory("C:\\agent\\peers");
	assert.equal(nested.calls[0]?.path, "C:\\agent");
	const trailing = windowsFixturePolicy((request) => helperSuccess(request, WINDOWS_PRIVATE_DIR));
	trailing.policy.protectCreatedDirectory("C:\\agent\\peers\\");
	assert.equal(trailing.calls[0]?.path, "C:\\agent");
	const unc = windowsFixturePolicy((request) => helperSuccess(request, WINDOWS_PRIVATE_DIR));
	unc.policy.protectCreatedDirectory("\\\\server\\share\\peers");
	assert.equal(unc.calls[0]?.path, "\\\\server\\share");

	// No provable parent: refused before the helper is launched at all.
	for (const rootless of ["C:\\", "\\peers", "C:peers", "peers", "\\\\server\\share"]) {
		const { policy, calls } = windowsFixturePolicy((request) => helperSuccess(request, WINDOWS_PRIVATE_DIR));
		assert.throws(() => policy.protectCreatedDirectory(rootless), (error) => isFixedFailure(error), rootless);
		assert.deepEqual(calls, [], `${rootless} must be refused before any helper launch`);
	}
});

test("Windows fixtures: non-ASCII path data travels as escaped ASCII JSON, never script text", () => {
	const unicodePath = "/agent/h\u00f4te-\u0394 ' $();/peers";
	const { policy, calls } = windowsFixturePolicy((request) => helperSuccess(request, WINDOWS_PRIVATE_DIR));
	policy.assertPrivateDirectory(unicodePath);
	assert.equal(calls.length, 1);
	const call = calls[0];
	assert.ok(call !== undefined);
	const input = call.options.input;
	assert.equal(/^[\x20-\x7e]*$/u.test(input), true, "the helper request must be pure ASCII");
	assert.equal((JSON.parse(input) as { path: string }).path, unicodePath, "the path survives as exact structured data");
	for (const arg of call.args) {
		assert.equal(arg.includes("h\u00f4te"), false, "a path must never reach the script or argv");
	}

	// Supplementary characters (one code point above U+FFFF, two UTF-16 surrogates)
	// must be escaped per code unit as well; otherwise the request keeps raw
	// non-ASCII bytes that a console codepage could decode into a different path.
	const astralPath = "/agent/\u{1f600}\u{1f389} \u00e9/peers";
	const astral = windowsFixturePolicy((request) => helperSuccess(request, WINDOWS_PRIVATE_DIR));
	astral.policy.assertPrivateDirectory(astralPath);
	assert.equal(astral.calls.length, 1);
	const astralInput = astral.calls[0]?.options.input ?? "";
	assert.equal(/^[\x20-\x7e]*$/u.test(astralInput), true, "a supplementary-character path request must be pure ASCII");
	assert.equal(
		(JSON.parse(astralInput) as { path: string }).path,
		astralPath,
		"escaping each surrogate must still restore the exact original path",
	);

	// The fixed 8 KiB request bound counts the escaped ASCII form: oversized input
	// is refused rather than truncated into a different path.
	const escaped = windowsFixturePolicy((request) => helperSuccess(request, WINDOWS_PRIVATE_DIR));
	assert.throws(
		() => escaped.policy.assertPrivateDirectory(`/agent/${"\u00e9".repeat(1_500)}`),
		(error) => isFixedFailure(error),
	);
	assert.deepEqual(escaped.calls, [], "an over-long escaped request is refused before launch");
});

test("POSIX fixtures stay POSIX: the win32 policy never consults mode bits", (t) => {
	const root = fixtureRoot(t);
	const dir = path.join(root, "peers");
	mkdirSync(dir, { mode: 0o700 });
	const { policy, calls } = windowsFixturePolicy((request) => helperSuccess(request, evidence({ ownerSid: "S-1-5-21-9999-1000" })));
	assert.throws(() => policy.assertPrivateDirectory(dir), (error) => isFixedFailure(error, root));
	assert.equal(calls.length, 1, "the Windows policy inspects the descriptor, not the local mode");
	assert.ok(!existsSync(path.join(root, "never-created")));
});

/* ------------------------------------------------------------------ *
 * Extended ACLs. On macOS an allow ACL entry grants authority while
 * `lstat` still reports a private mode, so the mode alone is not proof.
 * ------------------------------------------------------------------ */

test("POSIX (macOS): an ACL grant defeats a private-looking mode and is never repaired", { skip: ACL_SKIP }, (t) => {
	const root = aclFixtureRoot(t);
	const policy = createPeerStatePermissionPolicy();
	const account = userInfo().username;

	const peers = path.join(root, "peers");
	mkdirSync(peers, { mode: 0o700 });
	policy.assertPrivateDirectory(peers);
	applyAclEntry(peers, "group:everyone allow read,write,execute");
	assert.equal(modeOf(peers), 0o700, "the mode still looks private while the ACL grants access");
	assert.throws(() => policy.assertPrivateDirectory(peers), (error) => isFixedFailure(error, root));
	const listing = aclListing(peers);
	assert.ok(listing.includes("everyone"), "the refused ACL must be left in place, not repaired");
	assert.equal(modeOf(peers), 0o700);

	const state = path.join(peers, "state.json");
	writeFileSync(state, "", { mode: 0o600 });
	// The containing directory is no longer provable either.
	assert.throws(() => policy.assertPrivateDirectory(peers), (error) => isFixedFailure(error, root));

	const file = path.join(root, "state-2.json");
	writeFileSync(file, "", { mode: 0o600 });
	applyAclEntry(file, "group:everyone allow read");
	assert.equal(modeOf(file), 0o600);
	assert.throws(() => policy.assertPrivateFile(file), (error) => isFixedFailure(error, root));

	// A grant to this very account is the owner, so privacy is unchanged.
	const own = path.join(root, "own");
	mkdirSync(own, { mode: 0o700 });
	applyAclEntry(own, `user:${account} allow read,write,execute`);
	policy.assertPrivateDirectory(own);

	// A deny entry can only remove rights, so it must not fail a safe object.
	const denied = path.join(root, "denied");
	mkdirSync(denied, { mode: 0o700 });
	applyAclEntry(denied, "group:everyone deny delete");
	policy.assertPrivateDirectory(denied);
});

test("POSIX (macOS): parent proof refuses ACL-granted write authority but permits read-only grants", { skip: ACL_SKIP }, (t) => {
	const root = aclFixtureRoot(t);
	const policy = createPeerStatePermissionPolicy();

	const readOnly = path.join(root, "read-only-acl");
	mkdirSync(readOnly, { mode: 0o755 });
	applyAclEntry(readOnly, "group:everyone allow readattr,readextattr,readsecurity,execute");
	policy.assertOwnerControlledDirectory(readOnly);

	const writable = path.join(root, "write-acl");
	mkdirSync(writable, { mode: 0o755 });
	applyAclEntry(writable, "group:everyone allow write,delete_child");
	assert.throws(() => policy.assertOwnerControlledDirectory(writable), (error) => isFixedFailure(error, root));
	const before = aclListing(writable);
	assert.equal(modeOf(writable), 0o755);
	assert.equal(aclListing(writable), before, "an unsafe parent is refused, never edited");

	// The child of such a parent is refused before it is touched.
	const child = path.join(writable, "peers");
	mkdirSync(child, { mode: 0o755 });
	assert.throws(() => policy.protectCreatedDirectory(child), (error) => isFixedFailure(error, root));
	assert.equal(modeOf(child), 0o755);
});

test("POSIX (macOS): a real inherited read-only ACE is understood, and still refuses a private child", { skip: ACL_SKIP }, (t) => {
	const root = aclFixtureRoot(t);
	const policy = createPeerStatePermissionPolicy();
	const grandparent = path.join(root, "gp");
	mkdirSync(grandparent, { mode: 0o755 });
	applyAclEntry(grandparent, "group:everyone allow list,search,file_inherit,directory_inherit");
	const agent = path.join(grandparent, "agent");
	mkdirSync(agent, { mode: 0o755 });
	// This fixture really carries an inherited entry, in the documented position.
	assert.ok(aclListing(agent).includes("inherited"), "the fixture must exercise a genuinely inherited ACE");
	// A read-only inherited grant leaves the parent owner-controlled...
	policy.assertOwnerControlledDirectory(agent);
	// ...but the same grant still defeats private proof for a child that inherits it.
	const peers = path.join(agent, "peers");
	mkdirSync(peers, { mode: 0o700 });
	assert.throws(() => policy.assertPrivateDirectory(peers), (error) => isFixedFailure(error, root));
	assert.equal(modeOf(peers), 0o700, "a refused object keeps its mode");
});

test("POSIX (macOS): protectCreated* refuses a fresh object carrying a foreign ACL, untouched", { skip: ACL_SKIP }, (t) => {
	const root = aclFixtureRoot(t);
	const policy = createPeerStatePermissionPolicy();
	const agent = path.join(root, "agent");
	mkdirSync(agent, { mode: 0o755 });

	const peers = path.join(agent, "peers");
	mkdirSync(peers, { mode: 0o755 });
	applyAclEntry(peers, "group:everyone allow read,write,execute");
	assert.throws(() => policy.protectCreatedDirectory(peers), (error) => isFixedFailure(error, root));
	assert.equal(modeOf(peers), 0o755, "a refused object keeps its mode");
	assert.ok(aclListing(peers).includes("everyone"), "a refused object keeps its ACL");

	const privatePeers = path.join(agent, "private");
	mkdirSync(privatePeers, { mode: 0o700 });
	const state = path.join(privatePeers, "state.json");
	writeFileSync(state, "", { mode: 0o600 });
	applyAclEntry(state, "group:everyone allow read");
	assert.throws(() => policy.protectCreatedFile(state), (error) => isFixedFailure(error, root));
	assert.equal(modeOf(state), 0o600);
	assert.ok(aclListing(state).includes("everyone"));
});

function aclFixture(stdout: string, status = 0) {
	const calls: string[][] = [];
	const verdict = (purpose: "parent" | "private-dir" | "private-file", platform: NodeJS.Platform = "darwin") => {
		const value = proveExtendedAcl("/fixture/peers", purpose, platform, {
			resolveTool: () => "/bin/ls",
			accountName: () => "alice",
			execute: (tool, args) => {
				calls.push([tool, ...args]);
				return { status, stdout };
			},
		});
		return value;
	};
	return { verdict, calls };
}

function listing(modeColumn: string, entries: string[] = []): string {
	return [
		`${modeColumn} 2 alice staff 64 Jan  1 00:00 peers`,
		...entries.map((entry, index) => ` ${index}: ${entry}`),
	].join("\n");
}

test("ACL verdicts: enumeration, owner equivalence, deny entries, and unprovable output", () => {
	assert.equal(aclFixture(listing("drwx------")).verdict("private-dir"), "no-acl");
	assert.equal(aclFixture(listing("drwx------@", ["owner@ allow read,write"])).verdict("private-dir"), "owner-only");
	assert.equal(aclFixture(listing("drwx------@", ["user:alice allow read,write,execute"])).verdict("private-dir"), "owner-only");
	assert.equal(aclFixture(listing("drwx------@", ["group:everyone deny delete"])).verdict("private-dir"), "owner-only");
	assert.equal(aclFixture(listing("drwx------@", ["group:everyone allow file_inherit,directory_inherit"])).verdict("private-dir"), "owner-only", "a flag-only entry grants nothing");
	assert.equal(aclFixture(listing("drwx------@", ["group:everyone allow read,write,file_inherit"])).verdict("private-dir"), "untrusted");
	assert.equal(aclFixture(listing("-rw-------@", ["group:staff allow read"])).verdict("private-file"), "untrusted");
	assert.equal(aclFixture(listing("drwx------@", ["group:staff allow readattr,readextattr,readsecurity,execute"])).verdict("parent"), "owner-only");
	assert.equal(aclFixture(listing("drwx------@", ["group:staff allow readattr,readextattr,readsecurity,execute"])).verdict("private-dir"), "untrusted");
	assert.equal(aclFixture(listing("drwx------@", ["group:staff allow frobnicate"])).verdict("parent"), "unprovable", "an unknown right token is never assumed harmless");
	assert.equal(aclFixture(listing("drwx------@", ["group:staff permit read"])).verdict("parent"), "unprovable", "an unparseable entry is not a pass");
	assert.equal(aclFixture(listing("drwx------@", ["group:everyone allow read"])).verdict("private-dir"), "untrusted", "an extended attribute marker is not an ACL, but listed entries are");
	assert.equal(aclFixture(listing("drwx------@")).verdict("private-dir"), "no-acl", "extended attributes grant no access");
	assert.equal(aclFixture(listing("drwx------+", ["group:staff allow readattr,readextattr,readsecurity,execute"])).verdict("parent"), "owner-only");
	assert.equal(
		aclFixture(listing("drwx------@")).verdict("private-dir", "freebsd"),
		"no-acl",
		"an unparsed dialect is not ACL-aware here; the policy refuses that platform outright",
	);
	assert.equal(aclFixture(listing("drwx------+")).verdict("private-dir"), "unprovable", "an ACL with no enumerable entries proves nothing");
	assert.equal(aclFixture("total 0\n").verdict("private-dir"), "unprovable");
	assert.equal(aclFixture("", 0).verdict("private-dir"), "unprovable");
	assert.equal(aclFixture(listing("drwx------@", ["group:everyone allow read"]), 1).verdict("private-dir"), "unprovable");

	// A platform whose ACLs cannot widen access beyond the mask needs no extra proof.
	const linux = aclFixture(listing("drwx------@", ["group:everyone allow read,write"]));
	assert.equal(linux.verdict("private-dir", "linux"), "no-acl");
	assert.deepEqual(linux.calls, [], "no listing child is launched where it proves nothing");
	const darwinCalls = aclFixture(listing("drwx------@"));
	darwinCalls.verdict("private-dir");
	assert.deepEqual(darwinCalls.calls, [["/bin/ls", "-lde", "/fixture/peers"]], "one bounded listing per proof");
});

test("ACL verdicts: documented inherited placement, long indices, and malformed entries fail closed", () => {
	// The documented macOS spelling puts `inherited` between principal and grant.
	assert.equal(aclFixture(listing("drwx------@", ["owner@ inherited allow read,write"])).verdict("private-dir"), "owner-only");
	assert.equal(aclFixture(listing("drwx------@", ["group:everyone inherited deny delete"])).verdict("private-dir"), "owner-only");
	assert.equal(
		aclFixture(listing("drwx------+", ["group:staff inherited allow readattr,readextattr,readsecurity,execute"])).verdict("parent"),
		"owner-only",
		"an inherited read-only grant on a parent stays permissible",
	);
	assert.equal(aclFixture(listing("drwx------@", ["group:staff inherited allow write"])).verdict("parent"), "untrusted");
	assert.equal(
		aclFixture(listing("drwx------@", ["group:everyone inherited allow read"])).verdict("private-dir"),
		"untrusted",
		"an inherited grant to another principal still defeats private proof",
	);

	// An entry index of any length is still an entry: a bounded index pattern must
	// not drop entries past 9999 and report a truncated enumeration as clean.
	const longIndex = [
		"drwx------@ 2 alice staff 64 Jan  1 00:00 peers",
		" 12345: group:everyone allow read",
	].join("\n");
	assert.equal(aclFixture(longIndex).verdict("private-dir"), "untrusted");
	const longIndexParent = [
		"drwxr-xr-x+ 2 alice staff 64 Jan  1 00:00 peers",
		" 12345: group:everyone deny delete",
	].join("\n");
	assert.equal(aclFixture(longIndexParent).verdict("parent"), "owner-only");

	// Malformed or unsupported entry content is unprovable, never skipped.
	assert.equal(aclFixture(listing("drwx------@", ["group:staff allow"])).verdict("private-dir"), "unprovable", "an entry with no rights");
	assert.equal(aclFixture(listing("drwx------@", ["owner@ allow read", "not-an-entry"])).verdict("private-dir"), "unprovable");
	assert.equal(aclFixture(listing("drwx------@", ["group:staff inherited permit read"])).verdict("private-dir"), "unprovable");
	assert.equal(aclFixture(listing("drwx------@", ["owner@ allow frobnicate"])).verdict("private-dir"), "unprovable", "an unknown right is unclassifiable even for the owner");
	assert.equal(aclFixture(listing("drwx------@", ["owner@ allow read,write extra"])).verdict("private-dir"), "unprovable");
	// An empty comma-separated element is malformed evidence, never a repair: it must
	// not be filtered away and read as a clean `read` grant.
	for (const malformed of ["group:everyone allow read,", "group:everyone allow ,read", "group:everyone allow read,,write", "group:everyone allow ,"]) {
		assert.equal(aclFixture(listing("drwxr-xr-x@", [malformed])).verdict("parent"), "unprovable", malformed);
		assert.equal(aclFixture(listing("drwx------@", [malformed])).verdict("private-dir"), "unprovable", malformed);
	}
	const entryWithoutColon = [
		"drwx------@ 2 alice staff 64 Jan  1 00:00 peers",
		" 0 group:everyone allow read",
	].join("\n");
	assert.equal(aclFixture(entryWithoutColon).verdict("private-dir"), "unprovable");
	const unsupportedDialect = [
		"drwx------@ 2 alice staff 64 Jan  1 00:00 peers",
		"owner@:allow:read,write:fd:allow",
	].join("\n");
	assert.equal(aclFixture(unsupportedDialect).verdict("private-dir"), "unprovable");
});

test("ACL verdicts: the real macOS rights vocabulary and owner metadata line are understood", () => {
	// `chmod +a "… allow read,write,execute"` is printed by macOS as the
	// directory-specific spellings `list,add_file,search`, and inherited entries
	// are translated per object kind (`read,execute` on a file).
	assert.equal(aclFixture(listing("drwx------@", ["user:alice allow list,add_file,search"])).verdict("private-dir"), "owner-only");
	assert.equal(aclFixture(listing("drwxr-xr-x@", ["group:everyone allow list,search"])).verdict("parent"), "owner-only");
	assert.equal(aclFixture(listing("drwx------@", ["group:everyone inherited allow list,search"])).verdict("private-dir"), "untrusted");
	assert.equal(aclFixture(listing("-rw-------@", ["group:everyone inherited allow read,execute"])).verdict("private-file"), "untrusted");
	assert.equal(aclFixture(listing("drwx------@", ["group:everyone allow list,add_file"])).verdict("private-dir"), "untrusted");

	// The `owner:` line documented in `chmod(1)` output carries no rights; anything
	// else that is not a parsed entry still refuses the proof.
	const withOwnerLine = [
		"drwx------@ 2 alice staff 64 Jan  1 00:00 peers",
		"  owner: alice",
		" 0: user:alice allow read,write",
	].join("\n");
	assert.equal(aclFixture(withOwnerLine).verdict("private-dir"), "owner-only");
	const ownerLineWithGrant = [
		"drwx------@ 2 alice staff 64 Jan  1 00:00 peers",
		"  owner: alice allow read",
	].join("\n");
	assert.equal(aclFixture(ownerLineWithGrant).verdict("private-dir"), "unprovable");
});

test("POSIX: an ACL-aware policy that cannot enumerate ACLs fails closed on a safe-looking object", { skip: POSIX_SKIP }, (t) => {
	const root = aclFixtureRoot(t);
	const dir = path.join(root, "peers");
	mkdirSync(dir, { mode: 0o700 });
	const file = path.join(dir, "state.json");
	writeFileSync(file, "", { mode: 0o600 });
	for (const acl of [{ resolveTool: () => null }, { execute: () => ({ status: null, stdout: "" }) }]) {
		const policy = createPeerStatePermissionPolicy({ platform: "darwin", acl });
		for (const call of [
			() => policy.assertOwnerControlledDirectory(dir),
			() => policy.assertPrivateDirectory(dir),
			() => policy.assertPrivateFile(file),
			() => policy.protectCreatedDirectory(dir),
			() => policy.protectCreatedFile(file),
		]) {
			assert.throws(call, (error) => isFixedFailure(error, root));
		}
	}
	assert.equal(modeOf(dir), 0o700, "nothing is changed while protection stays unproven");
	assert.equal(modeOf(file), 0o600);
});
