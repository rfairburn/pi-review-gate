/**
 * Platform protection policy for explicitly opened peer state (Refs #480).
 *
 * `createPeerStatePermissionPolicy()` is inert: importing this module or
 * building the policy touches no file, spawns nothing, and reads no credential.
 * Every check happens inside the five synchronous policy calls, and each
 * failure is the same fixed sanitized error — no path, errno, mode, SID, or
 * native output ever leaves this module.
 *
 * POSIX proof is real: `lstat` type and owner UID, then an `O_NOFOLLOW`
 * descriptor whose `fstat` identity must match the observed inode, then
 * `fchmod` on that descriptor only, then a fresh `lstat` re-verification that
 * the same inode now carries the exact private mode. On macOS, where extended
 * ACLs can grant authority apart from the mode bits, the ACL entries are
 * enumerated and must be provably non-granting; an ACL that cannot be
 * enumerated, an entry this module cannot parse, and a right token it does not
 * know are all refusals, never a benefit of the doubt. `fs.access` is never used
 * as proof.
 *
 * Verified platforms only: Linux (mode bits own all effective POSIX ACL
 * authority, so an exact `0700`/`0600` is complete), macOS/Darwin (mode bits
 * plus the ACL parser below), and Windows (see the native helper module). Every
 * other platform — AIX, SunOS/Solaris, the BSDs, Android, Haiku, and anything
 * unknown — is refused by this library with the same fixed error. Those hosts
 * print ACLs in formats this module does not implement, so claiming support
 * there would mean advertising protection that was never verified. This is
 * scoped to this explicitly constructed policy: the standalone application's
 * startup and platform behaviour are unchanged.
 *
 * Boundaries, stated honestly:
 * - Same-account processes and OS-privileged accounts (UID 0 / root, and on
 *   Windows LocalSystem and the built-in Administrators alias) can always read
 *   this state. Owner-only modes prove protection against every *other*
 *   account, not against the account itself or a privileged one.
 * - Ancestors are the caller's responsibility: the store opens a canonical,
 *   existing, non-symlink agent directory and fences descriptors. These methods
 *   refuse a symlink/reparse final component but do not scan the whole path.
 * - `assert*` never repairs anything. `protectCreated*` is only for the
 *   caller's positively owned, just-created object (empty directory, empty
 *   file), and refuses anything else untouched, so a pre-existing unsafe
 *   account file is never chmod'd or re-ACL'd into passing. The emptiness/type
 *   observations are eligibility checks, not a creation receipt: the caller
 *   owns the exclusive-create/inode proof. No secret byte may be written until
 *   the protection call has positively verified the new private mode.
 */
import { spawnSync } from "node:child_process";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	statSync,
	type Stats,
} from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute } from "node:path";
import type { PeerStatePermissionPolicy } from "./peer-state-permission-policy";
import { peerError } from "./protocol";
import { createWindowsPeerStatePermissions, type WindowsPeerStatePermissionProbe } from "./peer-state-windows-permissions";

/** The only directory mode accepted as genuinely private. */
const PRIVATE_DIRECTORY_MODE = 0o700;
/** The only file mode accepted as genuinely private. */
const PRIVATE_FILE_MODE = 0o600;
/** Permission and special bits, all of which must match exactly when private. */
const ALL_MODE_BITS = 0o7777;
/** A parent may be publicly readable, but never group/other writable, setuid or setgid. */
const PARENT_FORBIDDEN_MODE_BITS = 0o0022 | 0o6000;
/** Without owner search permission the state directory cannot be managed at all. */
const PARENT_REQUIRED_MODE_BITS = 0o0100;
/** Explicitly trusted OS-privileged owner for a parent directory only. */
const TRUSTED_OS_PRIVILEGED_UID = 0;
/** Fixed bound on accepted path arguments; longer input is a refusal, not a truncation. */
const MAX_PATH_LENGTH = 2_000;

/**
 * Platforms with owner/permission semantics this module actually verifies:
 * Linux (mode bits govern all effective POSIX ACL authority) and macOS (mode
 * bits plus the ACL parser below). Every other platform, including AIX, SunOS,
 * the BSDs, and anything unknown, is refused rather than assumed safe.
 */
const POSIX_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"];

/**
 * Optional seams for the focused cross-platform regressions. They change no
 * acceptance rule: the same checks run either way, and production callers pass
 * nothing. There is no permissive fallback and no injectable "assume safe".
 */
export interface PeerStatePermissionPolicyProbe {
	/** Test seam: platform selection so fixtures can exercise other platforms. */
	platform?: NodeJS.Platform;
	/** Test seam for the trusted Windows helper child (production: fixed system PowerShell). */
	windows?: WindowsPeerStatePermissionProbe;
	/** Test seam for the extended-ACL listing child on ACL-aware platforms. */
	acl?: ExtendedAclProbe;
}

/**
 * Platforms whose extended ACLs grant authority independently of the mode bits
 * *and* whose ACL spelling this module parses. macOS prints entries as
 * `N: principal [inherited] allow|deny right,right,…`. Linux is deliberately
 * absent: POSIX ACL effective rights are governed by the ACL mask surfaced in
 * the mode's group bits, so an exact `0700`/`0600` leaves a named entry with no
 * effective access. Other BSD-flavoured ACL dialects (FreeBSD's
 * `owner@:allow:…`, NFSv4 on AIX/SunOS) are not parsed here, so those hosts are
 * refused outright by `createPeerStatePermissionPolicy` instead of being
 * half-verified.
 */
const ACL_AWARE_PLATFORMS: readonly NodeJS.Platform[] = ["darwin"];
/** Fixed absolute listing tool; never a PATH lookup. */
const ACL_TOOL_CANDIDATES: readonly string[] = ["/bin/ls", "/usr/bin/ls"];
const ACL_CHILD_TIMEOUT_MS = 5_000;
const ACL_MAX_OUTPUT_BYTES = 64 * 1024;
/** macOS entry flags that are inheritance markers rather than rights. */
const ACL_INHERIT_FLAGS: ReadonlySet<string> = new Set([
	"file_inherit",
	"directory_inherit",
	"limit_inherit",
	"only_inherit",
]);
/**
 * The documented macOS `chmod(1)` ACL rights. Anything outside this set and the
 * inheritance flags above is an unknown token: it cannot be classified, so the
 * whole listing becomes unprovable rather than assumed harmless.
 */
const ACL_KNOWN_RIGHTS: ReadonlySet<string> = new Set([
	"add_file",
	"add_subdirectory",
	"append",
	"chown",
	"delete",
	"delete_child",
	"execute",
	"list",
	"read",
	"readattr",
	"readextattr",
	"readsecurity",
	"search",
	"write",
	"writeattr",
	"writeextattr",
	"writesecurity",
]);
/** Rights that cannot widen a parent beyond permissible public read/traverse. */
const ACL_READ_ONLY_RIGHTS: ReadonlySet<string> = new Set([
	"read",
	"readattr",
	"readextattr",
	"readsecurity",
	"execute",
	"search",
	"list",
]);

/** What one ACL proof was for. */
export type ExtendedAclPurpose = "parent" | "private-dir" | "private-file";

/**
 * `no-acl` carries no extended ACL; `owner-only` has entries but none that
 * grant authority beyond the object's own owner; `untrusted` found a grant this
 * policy cannot accept; `unprovable` means the ACL could not be enumerated, so
 * the caller must fail closed rather than trust the mode bits.
 */
export type ExtendedAclVerdict = "no-acl" | "owner-only" | "untrusted" | "unprovable";

export interface ExtendedAclChildResult {
	status: number | null;
	stdout: string;
}

export interface ExtendedAclProbe {
	/** Test seam at the single bounded listing-child seam. */
	execute?: (
		tool: string,
		args: readonly string[],
		options: { timeoutMs: number; maxBufferBytes: number; env: NodeJS.ProcessEnv },
	) => ExtendedAclChildResult;
	/** Test seam for the fixed listing-tool resolution. */
	resolveTool?: () => string | null;
	/** Test seam for the owning account name. */
	accountName?: () => string;
}

/** One parsed allow/deny ACL entry, before classification. */
interface AclEntry {
	principal: string;
	grant: "allow" | "deny";
	rights: string[];
}

function resolveAclTool(): string | null {
	for (const candidate of ACL_TOOL_CANDIDATES) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// Try the next fixed location.
		}
	}
	return null;
}

function currentAccountName(): string {
	try {
		return userInfo().username;
	} catch {
		return "";
	}
}

const productionAclExecutor: NonNullable<ExtendedAclProbe["execute"]> = (tool, args, options) => {
	const child = spawnSync(tool, [...args], {
		encoding: "utf8",
		timeout: options.timeoutMs,
		maxBuffer: options.maxBufferBytes,
		windowsHide: true,
		// Pinned so the mode column and ACL token spellings are stable.
		env: { ...process.env, LC_ALL: "C", LANG: "C" },
		stdio: ["ignore", "pipe", "ignore"],
	});
	return { status: child.status, stdout: typeof child.stdout === "string" ? child.stdout : "" };
};

/**
 * Optional owner metadata line that `chmod(1)` documents in `ls -le` examples.
 * It carries no rights, so it is the one non-entry line that may be skipped.
 * Anything else that is not a parsed ACL entry refuses the proof.
 */
function isOwnerMetadataLine(line: string): boolean {
	return /^\s*owner:\s*\S+$/u.test(line);
}

/**
 * Parse one ACL entry body. The documented macOS spelling is
 * `principal [inherited] allow|deny right,right,…`; the `inherited` marker sits
 * between the principal and the allow/deny token. A malformed entry — missing
 * grant token, no rights, extra tokens, or an empty principal — is `null`, not a
 * skipped line.
 *
 * The rights list is taken literally: an empty element from a leading, trailing,
 * or repeated comma (`read,,write`) is malformed evidence and refuses the whole
 * proof. Filtering empty tokens would silently repair a line this module did not
 * actually understand.
 */
function parseAclEntry(content: string): AclEntry | null {
	const tokens = content.trim().split(/\s+/u);
	const principal = tokens[0] ?? "";
	if (principal.length === 0) return null;
	let index = 1;
	if (tokens[index] === "inherited") index += 1;
	const grant = tokens[index];
	if (grant !== "allow" && grant !== "deny") return null;
	if (index + 2 !== tokens.length) return null;
	const rights = (tokens[index + 1] ?? "").split(",");
	if (rights.length === 0) return null;
	for (const right of rights) {
		if (right.length === 0) return null;
	}
	return { principal, grant, rights };
}

/**
 * Parse one `ls -lde` listing. `null` means the output is not the expected
 * shape, which the caller treats as unprovable. ACL entries are the primary
 * signal; the `+` marker after the mode column means an ACL exists. The
 * macOS `@` marker means extended attributes, which grant no access, so it is
 * deliberately not an ACL indicator.
 *
 * The parser is deliberately strict about everything after the listing line:
 * every non-empty line must be an ACL entry this module fully understands. An
 * entry index of any length is honored (a `\d{1,4}` bound would silently drop
 * entries past 9999 and could report a truncated enumeration as owner-only), and
 * a line that merely looks like an entry — a missing colon, an unsupported
 * dialect, a truncated record — refuses the whole proof instead of being
 * skipped.
 */
function parseAclListing(stdout: string): { aclMarker: boolean; entries: AclEntry[] } | null {
	if (stdout.length === 0 || Buffer.byteLength(stdout) > ACL_MAX_OUTPUT_BYTES) return null;
	const lines = stdout.split("\n");
	const listingIndex = lines.findIndex((line) => line.trim().length > 0);
	if (listingIndex < 0) return null;
	const listing = lines[listingIndex] ?? "";
	const modeColumn = listing.trim().split(/\s+/u)[0] ?? "";
	if (!/^[-dbcplsBDRr-][rwxsStT-]{9}[@+]?$/u.test(modeColumn)) return null;
	const entries: AclEntry[] = [];
	for (const line of lines.slice(listingIndex + 1)) {
		if (line.trim().length === 0) continue;
		if (isOwnerMetadataLine(line)) continue;
		const match = /^\s*(\d+):\s*(.*)$/u.exec(line);
		if (match === null) return null;
		const entry = parseAclEntry(match[2] ?? "");
		if (entry === null) return null;
		entries.push(entry);
	}
	return { aclMarker: /\+$/u.test(modeColumn), entries };
}

/**
 * Prove that no extended ACL entry grants authority this policy would not
 * accept. Deny entries are accepted because they can only remove rights (the
 * common macOS `group:everyone deny delete` must not make a safe object look
 * unsafe); every allow entry must belong to the object's owner, except on a
 * parent, where a provably read-only grant to others is permissible. A listing
 * this module cannot fully parse, or any right token it does not know, is
 * `unprovable` — never silently skipped.
 */
export function proveExtendedAcl(
	path: string,
	purpose: ExtendedAclPurpose,
	platform: NodeJS.Platform = process.platform,
	probe: ExtendedAclProbe = {},
): ExtendedAclVerdict {
	if (!ACL_AWARE_PLATFORMS.includes(platform)) return "no-acl";
	if (typeof path !== "string" || path.length === 0) return "unprovable";
	const tool = (probe.resolveTool ?? resolveAclTool)();
	if (typeof tool !== "string" || tool.length === 0) return "unprovable";
	let child: ExtendedAclChildResult;
	try {
		child = (probe.execute ?? productionAclExecutor)(tool, ["-lde", path], {
			timeoutMs: ACL_CHILD_TIMEOUT_MS,
			maxBufferBytes: ACL_MAX_OUTPUT_BYTES,
			env: { ...process.env, LC_ALL: "C", LANG: "C" },
		});
	} catch {
		return "unprovable";
	}
	if (child === null || typeof child !== "object" || child.status !== 0) return "unprovable";
	const parsed = parseAclListing(child.stdout);
	if (parsed === null) return "unprovable";
	if (parsed.entries.length === 0) {
		// An ACL that exists but lists no entries proves nothing either way; a
		// listing with no ACL at all is the clean case.
		return parsed.aclMarker ? "unprovable" : "no-acl";
	}
	const account = (probe.accountName ?? currentAccountName)();
	for (const entry of parsed.entries) {
		// A token this module does not know is unclassifiable, whoever holds it.
		for (const token of entry.rights) {
			if (!ACL_KNOWN_RIGHTS.has(token) && !ACL_INHERIT_FLAGS.has(token)) return "unprovable";
		}
		if (entry.grant === "deny") continue;
		const rights = entry.rights.filter((token) => ACL_KNOWN_RIGHTS.has(token));
		if (rights.length === 0) continue;
		const ownerEquivalent
			= entry.principal === "owner@"
			|| (account.length > 0 && entry.principal === `user:${account}`);
		if (ownerEquivalent) continue;
		if (purpose === "parent" && rights.every((token) => ACL_READ_ONLY_RIGHTS.has(token))) continue;
		return "untrusted";
	}
	return "owner-only";
}

/** One observed filesystem object; `undefined` means the observation failed. */
interface PosixObservation {
	uid: number;
	mode: number;
	nlink: number;
	size: number;
	dev: number;
	ino: number;
}

function refuse(): never {
	throw peerError("TRUST_STORE_FAILED");
}

function isUsablePath(path: string): boolean {
	return typeof path === "string" && path.length > 0 && path.length <= MAX_PATH_LENGTH && isAbsolute(path);
}

function currentAccountUid(): number {
	if (typeof process.getuid !== "function") refuse();
	return process.getuid();
}

/**
 * Observe the exact object at `path` without following a link. Anything that is
 * not the expected real type — symlink, fifo, socket, device, or a missing path
 * — is refused here, before any mode or ownership question is asked.
 */
function observe(path: string, kind: "dir" | "file"): PosixObservation {
	let stat: Stats | undefined;
	try {
		stat = lstatSync(path);
	} catch {
		refuse();
	}
	if (stat === undefined) refuse();
	const observed: Stats = stat;
	if (observed.isSymbolicLink()) refuse();
	if (kind === "dir" ? !observed.isDirectory() : !observed.isFile()) refuse();
	return {
		uid: observed.uid,
		mode: observed.mode & ALL_MODE_BITS,
		nlink: observed.nlink,
		size: observed.size,
		dev: observed.dev,
		ino: observed.ino,
	};
}

/** Re-observe and prove the same inode still carries the exact expected mode. */
function verifyUnchangedIdentity(path: string, kind: "dir" | "file", expected: PosixObservation, mode: number): void {
	const after = observe(path, kind);
	if (after.dev !== expected.dev || after.ino !== expected.ino) refuse();
	if (after.uid !== currentAccountUid()) refuse();
	if (after.mode !== mode) refuse();
	if (kind === "file" && (after.nlink !== 1 || after.size !== 0)) refuse();
}

/**
 * Establish the private mode on a positively owned object through a descriptor
 * only: `O_NOFOLLOW` open, `fstat` identity match against the observation,
 * `fchmod`, then full re-verification. There is no path-based chmod, so a
 * swapped or linked object cannot be chmod'd through this function.
 */
function establishMode(path: string, kind: "dir" | "file", expected: PosixObservation, mode: number): void {
	let fd = -1;
	try {
		const flags = constants.O_RDONLY | constants.O_NOFOLLOW | (kind === "dir" ? constants.O_DIRECTORY : 0);
		fd = openSync(path, flags);
		const opened = fstatSync(fd);
		if (opened.dev !== expected.dev || opened.ino !== expected.ino) refuse();
		if (opened.uid !== currentAccountUid()) refuse();
		if (kind === "file" && (opened.nlink !== 1 || opened.size !== 0)) refuse();
		fchmodSync(fd, mode);
	} catch {
		refuse();
	} finally {
		if (fd >= 0) {
			try {
				closeSync(fd);
			} catch {
				// The descriptor is ours and already chmod'd; a close failure adds nothing.
			}
		}
	}
	verifyUnchangedIdentity(path, kind, expected, mode);
}

/**
 * Eligibility of a created object: it must still be the empty directory or
 * empty file the caller says it is. This is not a creation receipt — the caller
 * owns the exclusive-create/inode proof — it only keeps an in-use or repurposed
 * object from being treated as newly created.
 */
function assertDirectoryIsEmpty(path: string): void {
	let entries: string[] | undefined;
	try {
		entries = readdirSync(path);
	} catch {
		refuse();
	}
	if (entries === undefined || entries.length !== 0) refuse();
}

function parentOf(path: string): string {
	const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
	const index = trimmed.lastIndexOf("/");
	if (index <= 0) refuse();
	return trimmed.slice(0, index);
}

function createPosixPeerStatePermissions(
	platform: NodeJS.Platform,
	aclProbe: ExtendedAclProbe = {},
): PeerStatePermissionPolicy {
	/**
	 * On ACL-aware platforms the mode bits are only half the proof: a foreign or
	 * unprovable allow entry is a refusal, and nothing is edited to make an
	 * existing object pass.
	 */
	const assertAclCannotGrantMore = (path: string, purpose: ExtendedAclPurpose): void => {
		const verdict = proveExtendedAcl(path, purpose, platform, aclProbe);
		if (verdict === "untrusted" || verdict === "unprovable") refuse();
	};

	const assertOwnerControlledDirectory = (path: string): void => {
		if (!isUsablePath(path)) refuse();
		const uid = currentAccountUid();
		const observed = observe(path, "dir");
		// The current account, or the OS-privileged account, must own the parent.
		if (observed.uid !== uid && observed.uid !== TRUSTED_OS_PRIVILEGED_UID) refuse();
		if ((observed.mode & PARENT_FORBIDDEN_MODE_BITS) !== 0) refuse();
		if ((observed.mode & PARENT_REQUIRED_MODE_BITS) === 0) refuse();
		assertAclCannotGrantMore(path, "parent");
	};

	const assertPrivateDirectory = (path: string): void => {
		if (!isUsablePath(path)) refuse();
		const uid = currentAccountUid();
		const observed = observe(path, "dir");
		if (observed.uid !== uid) refuse();
		if (observed.mode !== PRIVATE_DIRECTORY_MODE) refuse();
		assertAclCannotGrantMore(path, "private-dir");
	};

	const assertPrivateFile = (path: string): void => {
		if (!isUsablePath(path)) refuse();
		const uid = currentAccountUid();
		const observed = observe(path, "file");
		if (observed.uid !== uid) refuse();
		// A second link means another name can carry different protection.
		if (observed.nlink !== 1) refuse();
		if (observed.mode !== PRIVATE_FILE_MODE) refuse();
		assertAclCannotGrantMore(path, "private-file");
	};

	return {
		assertOwnerControlledDirectory,
		assertPrivateDirectory,
		assertPrivateFile,
		protectCreatedDirectory(path) {
			// Parent first: an unsafe parent keeps an untrusted write or
			// delete-child window open across the child's protection, so the
			// whole operation is refused before the new object is touched.
			assertOwnerControlledDirectory(parentOf(path));
			if (!isUsablePath(path)) refuse();
			const uid = currentAccountUid();
			const observed = observe(path, "dir");
			if (observed.uid !== uid) refuse();
			assertDirectoryIsEmpty(path);
			// Refuse a foreign ACL before touching anything: `chmod` does not remove
			// an extended ACL, so a fresh object carrying one is not protectable.
			assertAclCannotGrantMore(path, "private-dir");
			if (observed.mode !== PRIVATE_DIRECTORY_MODE) establishMode(path, "dir", observed, PRIVATE_DIRECTORY_MODE);
			else assertPrivateDirectory(path);
		},
		protectCreatedFile(path) {
			// The containing peers directory must already be private, otherwise
			// key bytes would sit in a broadly readable location regardless of
			// the file's own mode.
			assertPrivateDirectory(parentOf(path));
			if (!isUsablePath(path)) refuse();
			const uid = currentAccountUid();
			const observed = observe(path, "file");
			if (observed.uid !== uid) refuse();
			// A created-but-unused file is empty with exactly one link; anything
			// else is treated as a pre-existing object and left untouched.
			if (observed.nlink !== 1 || observed.size !== 0) refuse();
			assertAclCannotGrantMore(path, "private-file");
			if (observed.mode !== PRIVATE_FILE_MODE) establishMode(path, "file", observed, PRIVATE_FILE_MODE);
			else assertPrivateFile(path);
		},
	};
}

/** Every call fails: no platform without verified permission semantics succeeds. */
function createRefusingPeerStatePermissions(): PeerStatePermissionPolicy {
	return {
		assertOwnerControlledDirectory() {
			refuse();
		},
		assertPrivateDirectory() {
			refuse();
		},
		assertPrivateFile() {
			refuse();
		},
		protectCreatedDirectory() {
			refuse();
		},
		protectCreatedFile() {
			refuse();
		},
	};
}

/**
 * Build the real platform policy. Construction performs no IO; the returned
 * methods do all the work and fail closed on any unprovable protection.
 */
export function createPeerStatePermissionPolicy(
	probe: PeerStatePermissionPolicyProbe = {},
): PeerStatePermissionPolicy {
	const platform = probe.platform ?? process.platform;
	if (platform === "win32") return createWindowsPeerStatePermissions(probe.windows ?? {});
	if (!POSIX_PLATFORMS.includes(platform)) return createRefusingPeerStatePermissions();
	return createPosixPeerStatePermissions(platform, probe.acl ?? {});
}
