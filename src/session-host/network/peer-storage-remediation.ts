/**
 * Explicit permission remediation for existing fixed Network storage (Refs #494).
 *
 * This is a separate, explicitly called authority. Nothing here runs at import,
 * at startup, when a store opens, or when a store refuses: the protected stores
 * keep their no-repair semantics, and only a caller that deliberately invokes
 * {@link repairPeerStorageProtection} can tighten anything.
 *
 * Fixed targets, in parent-first order, and nothing else:
 *
 * 1. `<agentDir>/session-host` (directory)
 * 2. `session-host/peers` (directory) and `peers/state.json` (file), when present
 * 3. `session-host/peer-preferences` (directory) and
 *    `peer-preferences/preferences.json` (file), when present
 *
 * What a repair does: it replaces only the *protection* of a target that fails
 * the store's own requirement — POSIX `fchmod` to `0700`/`0600` on a held no-follow
 * descriptor; on macOS, when the object's extended ACL grants another principal
 * authority, removal of that whole ACL through the same held descriptor (see
 * {@link removeExtendedAclThroughDescriptor}); Windows a protected DACL granting full control to exactly this
 * account, LocalSystem, and built-in Administrators, written through
 * `SetSecurityInfo` on a handle opened with `MAXIMUM_ALLOWED` (which Microsoft
 * documents suppresses propagation of inheritable ACEs to existing children) and
 * opened on the reparse point itself, never followed. It never reads, decodes,
 * rewrites, copies, renames, or deletes any content; never creates a missing
 * directory, document, key, or identity; never changes an owner; never touches
 * the agent directory or any ancestor, the roster, ownership, coordination,
 * shortcut, diagnostics, or session files, or any other child; and never
 * recurses. A missing optional directory or document stays absent, and an
 * initialized directory without its document stays unavailable.
 *
 * Refusals, decided only from non-secret metadata (type, link count, size bounds,
 * owner, mode, ACL/DACL shape; private key bytes are never read): a
 * symlink/reparse point or unexpected type, an extra hard link on a document
 * (an NTFS or POSIX ACL/mode change would affect every name), another account's
 * ownership (never taken over, so another account's granting ACL is never
 * removed either), an ACL this module cannot model (an unparseable listing, an
 * unknown right, or an ACL marker without entries), an unreadable object, document sizes outside the stores'
 * bounds, or an unsupported platform. Any refused target refuses the whole
 * repair before anything is changed.
 *
 * Every mutation re-proves eligibility on the object it actually holds (the
 * descriptor/handle identity must equal the assessed object), then post-verifies
 * the real OS protection and that the same exact object is still at the path.
 * macOS ACL evidence is read through the held object's volfs file-ID name
 * (`/.vol/<fsid>/<file ID>`), never through the fixed pathname (a `/dev/fd/N`
 * listing is not faithful: it reports synthesized attributes and no ACL); every
 * entry must be understood before any grant is classified, the mode is
 * tightened and verified before an ACL is removed, and a removal is reported
 * repaired only when the file-ID listing afterwards shows no ACL at all.
 * A failure after a mutation was issued is reported as possibly changed; nothing
 * is rolled back, and later targets are not attempted.
 *
 * Limits, stated honestly: tightening protection does not revoke handles another
 * process already opened, and it cannot prove that state which was previously
 * exposed is still secret or unmodified. A caller should recommend separate
 * private-key rotation if exposure was possible, and must require a host restart
 * before the Network stores are reopened; this backend reopens nothing and starts
 * no listener, connection, or retry. Same-account and OS-privileged access stays
 * outside this boundary. Objects that inherited broad grants from an earlier
 * `session-host` DACL keep them (no propagation is performed by design); on
 * macOS, removing a directory's ACL likewise never touches existing children,
 * which carry their own inherited copies and are assessed (and, if fixed
 * targets, repaired) individually. Removal is whole-ACL: owner and deny entries
 * on that object go too, leaving the verified owner-only mode as its protection.
 * Remediation never creates anything, so a directory created later under an
 * ancestor with inheritable grants can inherit them again; the creators report
 * that as unverified and never modify it (no creation-bound receipt exists).
 *
 * Every result is a closed vocabulary: no path, errno, mode, SID, or native
 * output is ever returned.
 */
import { spawnSync } from "node:child_process";
import {
	closeSync,
	constants as fsConstants,
	fchmodSync,
	fstatSync,
	lstatSync,
	openSync,
	realpathSync,
	type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { sessionHostStateDir } from "../roster-store";
import { proveExtendedAcl, type ExtendedAclProbe, type ExtendedAclPurpose, type ExtendedAclVerdict } from "./peer-state-permissions";
import {
	MAX_PEER_PREFERENCES_FILE_BYTES,
	PEER_PREFERENCES_DIRNAME,
	PEER_PREFERENCES_FILENAME,
} from "./peer-preferences-store";
import { MAX_PEER_STATE_FILE_BYTES, PEER_STATE_DIRNAME, PEER_STATE_FILENAME } from "./peer-state-store";
import {
	classifyOwnerControlledAclEvidence,
	classifyPrivateAclEvidence,
	encodeWindowsHelperRequest,
	isModelledWindowsAcl,
	KNOWN_ACCESS_MASK,
	parseWindowsAclEvidence,
	productionWindowsAclExecutor,
	resolveTrustedSystemPowerShell,
	type WindowsAclEvidence,
	type WindowsPeerStatePermissionProbe,
} from "./peer-state-windows-permissions";
import type { PeerStorageObject, PeerStorageReason } from "./peer-storage-diagnostics";

/** Assessment of one fixed target. */
export type PeerStorageTargetStatus =
	/** Not present; nothing is created. */
	| "absent"
	/** Already meets the protection the Network store requires; left untouched. */
	| "protected"
	/** Fails only on permissions this backend can tighten. */
	| "repairable"
	/** Cannot be repaired safely; the whole repair is refused. */
	| "refused"
	/** Inside a directory that was absent, unsafe, or unreadable; not inspected. */
	| "not-assessed";

export interface PeerStorageTargetAssessment {
	readonly target: PeerStorageObject;
	readonly status: PeerStorageTargetStatus;
	/**
	 * Fixed reason: why it is repairable or refused, or `missing-initialized` for
	 * an absent document whose directory exists (it stays unavailable). `null`
	 * otherwise.
	 */
	readonly reason: PeerStorageReason | null;
}

export interface PeerStorageAssessment {
	/** False on a platform where this backend cannot establish protection at all. */
	readonly supported: boolean;
	readonly targets: readonly PeerStorageTargetAssessment[];
	/** At least one target is repairable and none is refused. */
	readonly repairable: boolean;
	/** The first refused target, or null. */
	readonly blocked: PeerStorageTargetAssessment | null;
}

/** Outcome of one fixed target in a repair call. */
export type PeerStorageRepairTargetOutcome =
	| "absent"
	| "already-protected"
	| "repaired"
	| "refused"
	| "not-assessed"
	/** A pre-mutation recheck failed; this target was not changed. */
	| "failed-unchanged"
	/** A mutation was issued and its result could not be proven; it may have changed. */
	| "failed-possibly-changed"
	/** Not attempted because an earlier target refused or failed. */
	| "not-attempted"
	/**
	 * The final re-proof after the repair found this target replaced, missing,
	 * or no longer protected; whatever it was assessed or repaired as, it is not
	 * reported as protected.
	 */
	| "unverified";

export interface PeerStorageRepairTargetResult {
	readonly target: PeerStorageObject;
	readonly outcome: PeerStorageRepairTargetOutcome;
	readonly reason: PeerStorageReason | null;
}

export type PeerStorageRepairOutcome =
	/** Every present target already met its protection; nothing was changed. */
	| "nothing-to-repair"
	/** Every repairable target was repaired and verified. */
	| "repaired"
	/** Nothing was changed: a target was refused or a recheck failed first. */
	| "refused"
	/** Some protection may have changed, but not every repairable target was verified. */
	| "partial";

export interface PeerStorageRepairReport {
	readonly outcome: PeerStorageRepairOutcome;
	readonly targets: readonly PeerStorageRepairTargetResult[];
	/** True when any target was (or may have been) changed by this call. */
	readonly changed: boolean;
	/**
	 * True when any target changed or may have changed: the host must be restarted
	 * before the Network stores are reopened. Nothing is reopened here.
	 */
	readonly restartRequired: boolean;
	/**
	 * True when at least one present target lacked the required protection before
	 * this call. Protection cannot revoke earlier handles or prove secrecy of
	 * previously exposed state, so a caller should recommend separate private-key
	 * rotation if exposure was possible.
	 */
	readonly priorExposurePossible: boolean;
}

export interface PeerStorageRemediationOptions {
	/** Existing canonical Pi agent directory; never created or modified. */
	readonly agentDir: string;
}

/** Test seams only; production passes nothing and no seam relaxes a check. */
export interface PeerStorageRemediationProbe {
	readonly platform?: NodeJS.Platform;
	readonly acl?: ExtendedAclProbe;
	readonly windows?: WindowsPeerStatePermissionProbe;
	/** Fault seam at the single POSIX mutation call. */
	readonly fchmod?: (fd: number, mode: number) => void;
	/**
	 * Fault seam at the single macOS ACL-removal call; it receives the held
	 * descriptor and must throw on failure. Production uses
	 * {@link removeExtendedAclThroughDescriptor}.
	 */
	readonly removeExtendedAcl?: (fd: number) => void;
}

type TargetKind = "dir" | "file";

/** What the store requires of a target before Network may use it. */
type Requirement = "owner-controlled" | "private";

interface TargetSpec {
	readonly target: PeerStorageObject;
	readonly kind: TargetKind;
	readonly path: string;
	readonly requirement: Requirement;
	/** Inclusive upper size bound for a document; 0 for directories. */
	readonly maxBytes: number;
	/** Index of the containing fixed directory target, or -1. */
	readonly parent: number;
}

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const ALL_MODE_BITS = 0o7777;
const PARENT_FORBIDDEN_MODE_BITS = 0o0022 | 0o6000;
const PARENT_REQUIRED_MODE_BITS = 0o0100;
const TRUSTED_OS_PRIVILEGED_UID = 0;
const POSIX_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"];

function targetsFor(canonicalAgentDir: string): TargetSpec[] {
	const stateDir = sessionHostStateDir(canonicalAgentDir);
	const peers = join(stateDir, PEER_STATE_DIRNAME);
	const preferences = join(stateDir, PEER_PREFERENCES_DIRNAME);
	return [
		{ target: "session-host", kind: "dir", path: stateDir, requirement: "owner-controlled", maxBytes: 0, parent: -1 },
		{ target: "peers", kind: "dir", path: peers, requirement: "private", maxBytes: 0, parent: 0 },
		{
			target: "peer-state",
			kind: "file",
			path: join(peers, PEER_STATE_FILENAME),
			requirement: "private",
			maxBytes: MAX_PEER_STATE_FILE_BYTES,
			parent: 1,
		},
		{ target: "peer-preferences", kind: "dir", path: preferences, requirement: "private", maxBytes: 0, parent: 0 },
		{
			target: "preferences-document",
			kind: "file",
			path: join(preferences, PEER_PREFERENCES_FILENAME),
			requirement: "private",
			maxBytes: MAX_PEER_PREFERENCES_FILE_BYTES,
			parent: 3,
		},
	];
}

/**
 * Canonical existing agent directory. `absent` means there is no agent
 * directory at all (so no Network storage exists); `unusable` covers a relative,
 * linked, non-directory, or unreadable one. The agent directory is never
 * created or modified.
 */
function canonicalAgentDirectory(agentDir: unknown): string | "absent" | "unusable" {
	if (typeof agentDir !== "string" || agentDir.length === 0 || !isAbsolute(agentDir)) return "unusable";
	try {
		const stats = lstatSync(agentDir);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return "unusable";
		return realpathSync(agentDir);
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unusable";
	}
}

// --------------------------------------------------------------------- POSIX

interface PosixObservation {
	readonly status: PeerStorageTargetStatus;
	readonly reason: PeerStorageReason | null;
	readonly dev?: bigint;
	readonly ino?: bigint;
}

function aclPurpose(spec: TargetSpec): ExtendedAclPurpose {
	if (spec.requirement === "owner-controlled") return "parent";
	return spec.kind === "dir" ? "private-dir" : "private-file";
}

function desiredMode(spec: TargetSpec): number {
	return spec.kind === "dir" ? PRIVATE_DIRECTORY_MODE : PRIVATE_FILE_MODE;
}

function modeMeetsRequirement(spec: TargetSpec, mode: number): boolean {
	if (spec.requirement === "owner-controlled") {
		return (mode & PARENT_FORBIDDEN_MODE_BITS) === 0 && (mode & PARENT_REQUIRED_MODE_BITS) !== 0;
	}
	return mode === desiredMode(spec);
}

function currentUid(): number | null {
	return typeof process.getuid === "function" ? process.getuid() : null;
}

/** Open the exact object without following a final-component link. */
function openNoFollow(spec: TargetSpec): number {
	const flags = fsConstants.O_RDONLY
		| (fsConstants.O_NOFOLLOW ?? 0)
		| (spec.kind === "dir" ? (fsConstants.O_DIRECTORY ?? 0) : (fsConstants.O_NONBLOCK ?? 0));
	return openSync(spec.path, flags);
}

function closeQuietly(fd: number): void {
	try {
		closeSync(fd);
	} catch {
		// The descriptor was only an identity fence.
	}
}

/**
 * The metadata checks shared by assessment and the pre-mutation recheck. `stats`
 * comes from the held descriptor; the caller has already proven it is the same
 * object as the no-follow `lstat` of the fixed path.
 */
function posixMetadataRefusal(spec: TargetSpec, stats: BigIntStats, uid: number): PeerStorageReason | null {
	if (spec.kind === "dir" ? !stats.isDirectory() : !stats.isFile()) return "unsafe-object";
	const owner = Number(stats.uid);
	if (owner !== uid) {
		// An OS-privileged owner may satisfy the base check; it is never re-owned
		// or modified here, so it is only acceptable when nothing needs repair.
		if (!(spec.requirement === "owner-controlled" && owner === TRUSTED_OS_PRIVILEGED_UID)) return "foreign-owner";
	}
	if (spec.kind === "file") {
		if (stats.nlink !== 1n) return "unsafe-object";
		if (stats.size <= 0n || stats.size > BigInt(spec.maxBytes)) return "malformed";
	}
	return null;
}

/** Fixed macOS ACL-removal tool on the sealed system volume; never a PATH lookup. */
const ACL_REMOVE_TOOL = "/bin/chmod";
/** The child descriptor slot that receives the held descriptor. */
const ACL_REMOVE_CHILD_FD = 3;
/**
 * `chmod -h -N` clears the ACL through `open(path, O_SYMLINK)` and then
 * `fchmodx_np` on that descriptor (no path-based ACL call). fd(4) documents
 * that opening `/dev/fd/N` is equivalent to duplicating descriptor N, and the
 * held descriptor is mapped explicitly into slot 3, so the removal can only
 * land on the exact object this module holds.
 */
const ACL_REMOVE_ARGS: readonly string[] = Object.freeze(["-h", "-N", `/dev/fd/${ACL_REMOVE_CHILD_FD}`]);
const ACL_REMOVE_TIMEOUT_MS = 5_000;

/**
 * Remove the whole extended ACL of the object behind `fd` (macOS only). The
 * descriptor is always mapped explicitly into the child's slot 3: if it were
 * not, `chmod`'s own first descriptor (its saved working directory) would sit
 * in that slot, so the mapping is the identity guarantee, and the child runs
 * from `/` (root-owned, never modifiable by this account) as a further fence.
 * The tool must be a root-owned regular file that no other account can write.
 * Throws on any failure; success is never taken from the exit status alone —
 * the caller re-proves the ACL afterwards.
 */
function removeExtendedAclThroughDescriptor(fd: number): void {
	if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("invalid descriptor");
	const tool = lstatSync(ACL_REMOVE_TOOL);
	if (!tool.isFile() || tool.uid !== TRUSTED_OS_PRIVILEGED_UID || (tool.mode & 0o022) !== 0) throw new Error("untrusted tool");
	const stdio: ("ignore" | number)[] = ["ignore", "ignore", "ignore"];
	stdio[ACL_REMOVE_CHILD_FD] = fd;
	const child = spawnSync(ACL_REMOVE_TOOL, [...ACL_REMOVE_ARGS], {
		stdio,
		cwd: "/",
		env: { LC_ALL: "C", LANG: "C" },
		timeout: ACL_REMOVE_TIMEOUT_MS,
		killSignal: "SIGKILL",
		shell: false,
		windowsHide: true,
	});
	if (child.error !== undefined || child.signal !== null || child.status !== 0) throw new Error("ACL removal failed");
}

type FencedAclVerdict = ExtendedAclVerdict | "changed";

/**
 * The macOS volfs name of the held object: `/.vol/<fsid>/<file ID>` is resolved
 * by volume and file ID, never through any directory entry, so no rename, swap,
 * or swap-and-restore of the fixed pathname can redirect it. While this module
 * holds the descriptor the file ID cannot be freed and reused; an unlinked or
 * unresolvable object yields no listing at all (fail closed).
 */
function fileIdPath(held: { readonly dev: bigint; readonly ino: bigint }): string | null {
	if (held.dev < 0n || held.ino <= 0n) return null;
	return `/.vol/${held.dev}/${held.ino}`;
}

/** Whether a no-follow observation of `target` is the held object. */
function namesHeldObject(target: string, held: { readonly dev: bigint; readonly ino: bigint }): boolean {
	try {
		const named = lstatSync(target, { bigint: true });
		return !named.isSymbolicLink() && named.dev === held.dev && named.ino === held.ino;
	} catch {
		return false;
	}
}

/**
 * The extended-ACL verdict for the held object. A `/dev/fd/N` listing is not
 * faithful on macOS (it reports synthesized attributes and no ACL), so the
 * listing names the held object by its volfs file ID instead, and that name must
 * resolve to the held object immediately before and after the listing;
 * otherwise the ACL is `unprovable`. Separately, the fixed path must still name
 * the held object around the listing, or the target is `changed`. Elsewhere the
 * shared proof needs no listing (Linux mode bits govern effective ACL rights).
 */
function fencedAclVerdict(
	spec: TargetSpec,
	held: { readonly dev: bigint; readonly ino: bigint },
	platform: NodeJS.Platform,
	probe: PeerStorageRemediationProbe,
): FencedAclVerdict {
	if (!namesHeldObject(spec.path, held)) return "changed";
	let verdict: ExtendedAclVerdict;
	if (platform === "darwin") {
		const byId = fileIdPath(held);
		if (byId === null || !namesHeldObject(byId, held)) return "unprovable";
		verdict = proveExtendedAcl(byId, aclPurpose(spec), platform, probe.acl ?? {});
		if (!namesHeldObject(byId, held)) return "unprovable";
	} else {
		verdict = proveExtendedAcl(spec.path, aclPurpose(spec), platform, probe.acl ?? {});
	}
	if (!namesHeldObject(spec.path, held)) return "changed";
	return verdict;
}

function assessPosixTarget(spec: TargetSpec, platform: NodeJS.Platform, probe: PeerStorageRemediationProbe): PosixObservation {
	let named: BigIntStats;
	try {
		named = lstatSync(spec.path, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "absent", reason: null };
		return { status: "refused", reason: "unreadable" };
	}
	if (named.isSymbolicLink()) return { status: "refused", reason: "unsafe-object" };
	if (spec.kind === "dir" ? !named.isDirectory() : !named.isFile()) return { status: "refused", reason: "unsafe-object" };
	const uid = currentUid();
	if (uid === null) return { status: "refused", reason: "protection-unsupported" };
	let fd = -1;
	try {
		try {
			fd = openNoFollow(spec);
		} catch (error) {
			return { status: "refused", reason: (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "changed" : "unreadable" };
		}
		const held = fstatSync(fd, { bigint: true });
		if (held.dev !== named.dev || held.ino !== named.ino) return { status: "refused", reason: "changed" };
		// From here every observation names the exact held object.
		const identity = { dev: held.dev, ino: held.ino };
		const metadata = posixMetadataRefusal(spec, held, uid);
		if (metadata !== null) return { status: "refused", reason: metadata, ...identity };
		const acl = fencedAclVerdict(spec, identity, platform, probe);
		if (acl === "changed") return { status: "refused", reason: "changed", ...identity };
		// An ACL this module cannot fully enumerate and classify is never removed.
		if (acl === "unprovable") return { status: "refused", reason: "protection-unsupported", ...identity };
		const mode = Number(held.mode) & ALL_MODE_BITS;
		const modeMeets = modeMeetsRequirement(spec, mode);
		if (modeMeets && acl !== "untrusted") return { status: "protected", reason: null, ...identity };
		// A repair would have to modify an object this account does not own.
		if (Number(held.uid) !== uid) return { status: "refused", reason: "foreign-owner", ...identity };
		// The reason follows the stores' own check order: mode first, then ACL.
		return { status: "repairable", reason: modeMeets ? "extended-acl" : "unsafe-permissions", ...identity };
	} catch {
		return { status: "refused", reason: "unreadable" };
	} finally {
		if (fd >= 0) closeQuietly(fd);
	}
}

/**
 * Repair one POSIX target: reopen it no-follow, prove the held descriptor is
 * the assessed object and still eligible (including a fresh, complete ACL
 * verdict read by file ID), `fchmod` that descriptor when the mode fails the
 * requirement and verify it, only then remove a granting macOS ACL through the
 * same descriptor and prove by file ID that it is gone, then prove the mode on
 * the descriptor and on the same object at the path, and re-prove the ACL once more.
 */
function repairPosixTarget(
	spec: TargetSpec,
	assessed: PosixObservation,
	platform: NodeJS.Platform,
	probe: PeerStorageRemediationProbe,
): PeerStorageRepairTargetResult {
	const uid = currentUid();
	if (uid === null) return { target: spec.target, outcome: "failed-unchanged", reason: "protection-unsupported" };
	let fd = -1;
	let mutated = false;
	const fail = (reason: PeerStorageReason): PeerStorageRepairTargetResult => ({
		target: spec.target,
		outcome: mutated ? "failed-possibly-changed" : "failed-unchanged",
		reason,
	});
	const aclFailure = (verdict: FencedAclVerdict): PeerStorageReason =>
		verdict === "changed" ? "changed" : verdict === "untrusted" ? "extended-acl" : "protection-unsupported";
	try {
		try {
			fd = openNoFollow(spec);
		} catch {
			return fail("changed");
		}
		const held = fstatSync(fd, { bigint: true });
		if (held.dev !== assessed.dev || held.ino !== assessed.ino) return fail("changed");
		const identity = { dev: held.dev, ino: held.ino };
		const metadata = posixMetadataRefusal(spec, held, uid);
		if (metadata !== null) return fail(metadata);
		if (Number(held.uid) !== uid) return fail("foreign-owner");
		// Eligibility of the ACL is re-proved for the held object at mutation time,
		// never taken from the assessment.
		const aclBefore = fencedAclVerdict(spec, identity, platform, probe);
		if (aclBefore === "changed" || aclBefore === "unprovable") return fail(aclFailure(aclBefore));
		const removeAcl = aclBefore === "untrusted";
		// Only macOS ACLs are classified here; anything else cannot be removed.
		if (removeAcl && platform !== "darwin") return fail("protection-unsupported");
		const modeBefore = Number(held.mode) & ALL_MODE_BITS;
		const chmodNeeded = !modeMeetsRequirement(spec, modeBefore);
		// Mode first: an ACL deny entry may be the only thing narrowing broad mode
		// bits, so the ACL is removed only once the owner-only mode is established
		// and verified on the held descriptor. A mode failure leaves the ACL as it was.
		if (chmodNeeded) {
			mutated = true;
			(probe.fchmod ?? fchmodSync)(fd, desiredMode(spec));
			const tightened = fstatSync(fd, { bigint: true });
			if (tightened.dev !== held.dev || tightened.ino !== held.ino) return fail("changed");
			if ((Number(tightened.mode) & ALL_MODE_BITS) !== desiredMode(spec)) return fail("unsafe-permissions");
		}
		if (removeAcl) {
			mutated = true;
			try {
				(probe.removeExtendedAcl ?? removeExtendedAclThroughDescriptor)(fd);
			} catch {
				return fail("extended-acl");
			}
			// The removal must actually have landed on the held object: its file-ID
			// listing must now show no ACL at all.
			const aclRemoved = fencedAclVerdict(spec, identity, platform, probe);
			if (aclRemoved !== "no-acl") return fail(aclFailure(aclRemoved));
		}
		const after = fstatSync(fd, { bigint: true });
		if (after.dev !== held.dev || after.ino !== held.ino) return fail("changed");
		const afterMetadata = posixMetadataRefusal(spec, after, uid);
		if (afterMetadata !== null) return fail(afterMetadata);
		const modeAfter = Number(after.mode) & ALL_MODE_BITS;
		if (chmodNeeded ? modeAfter !== desiredMode(spec) : !modeMeetsRequirement(spec, modeAfter)) return fail("unsafe-permissions");
		const named = lstatSync(spec.path, { bigint: true });
		if (named.isSymbolicLink() || named.dev !== held.dev || named.ino !== held.ino) return fail("changed");
		if ((Number(named.mode) & ALL_MODE_BITS) !== modeAfter) return fail("unsafe-permissions");
		const aclAfter = fencedAclVerdict(spec, identity, platform, probe);
		if (removeAcl ? aclAfter !== "no-acl" : aclAfter !== "no-acl" && aclAfter !== "owner-only") return fail(aclFailure(aclAfter));
		return { target: spec.target, outcome: "repaired", reason: null };
	} catch {
		return fail("unreadable");
	} finally {
		if (fd >= 0) closeQuietly(fd);
	}
}

// ------------------------------------------------------------------- Windows

/** Fixed helper protocol version for the remediation helper. */
const REMEDIATION_HELPER_PROTOCOL = 1;
const REMEDIATION_HELPER_TIMEOUT_MS = 20_000;
const REMEDIATION_HELPER_MAX_OUTPUT_BYTES = 64 * 1024;
const REMEDIATION_HELPER_MAX_PATH_LENGTH = 2_000;
/** Every ACCESS_MASK bit outside the documented set, as an unsigned 32-bit constant. */
const UNKNOWN_ACCESS_MASK_BITS = (~KNOWN_ACCESS_MASK) >>> 0;

/**
 * The fixed Windows remediation helper. Paths travel only as escaped-ASCII JSON
 * on stdin. Every object is opened by `CreateFileW` with
 * `FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS`, so a reparse point
 * is opened itself and never followed; identity, type, link count, and size come
 * from that handle, and the security descriptor is read with `GetSecurityInfo`
 * on that same handle. `repair` opens the handle with `MAXIMUM_ALLOWED`, re-proves
 * the expected identity, owner, type, and link count on it, writes only a
 * protected DACL with `SetSecurityInfo` on that handle (owner, group, and SACL are
 * never written), re-reads the descriptor on the handle, then reopens the path
 * and reports that object's identity and descriptor too. `SetKernelObjectSecurity`
 * is not used.
 */
const REMEDIATION_HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
	try { [Console]::InputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch { }
	$raw = [Console]::In.ReadToEnd()
	if ($raw.Length -eq 0 -or $raw.Length -gt 16384) { exit 2 }
	$req = $raw | ConvertFrom-Json
	if ($req.v -ne ${REMEDIATION_HELPER_PROTOCOL}) { exit 2 }
	$op = [string]$req.op
	if ($op -ne 'inspect' -and $op -ne 'repair') { exit 2 }
	$name = New-Object Reflection.AssemblyName 'PiReviewGateStorageRemediation'
	if ($PSVersionTable.PSEdition -eq 'Core') {
		$assembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($name, [Reflection.Emit.AssemblyBuilderAccess]::Run)
	} else {
		$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, [Reflection.Emit.AssemblyBuilderAccess]::Run)
	}
	$module = $assembly.DefineDynamicModule('Native')
	$builder = $module.DefineType('PiReviewGateStorageRemediationNative', [Reflection.TypeAttributes]'Public, Sealed, Abstract')
	$attributes = [Reflection.MethodAttributes]'Public, Static, PinvokeImpl'
	$ptrRef = [IntPtr].MakeByRefType()
	foreach ($definition in @(
		@('kernel32.dll', 'CreateFileW', [IntPtr], [Type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])),
		@('kernel32.dll', 'GetFileInformationByHandle', [bool], [Type[]]@([IntPtr], [IntPtr])),
		@('kernel32.dll', 'GetFileInformationByHandleEx', [bool], [Type[]]@([IntPtr], [uint32], [IntPtr], [uint32])),
		@('kernel32.dll', 'CloseHandle', [bool], [Type[]]@([IntPtr])),
		@('kernel32.dll', 'LocalFree', [IntPtr], [Type[]]@([IntPtr])),
		@('advapi32.dll', 'GetSecurityInfo', [uint32], [Type[]]@([IntPtr], [uint32], [uint32], $ptrRef, $ptrRef, $ptrRef, $ptrRef, $ptrRef)),
		@('advapi32.dll', 'SetSecurityInfo', [uint32], [Type[]]@([IntPtr], [uint32], [uint32], [IntPtr], [IntPtr], [IntPtr], [IntPtr])),
		@('advapi32.dll', 'GetSecurityDescriptorLength', [uint32], [Type[]]@([IntPtr]))
	)) {
		$method = $builder.DefinePInvokeMethod($definition[1], $definition[0], $attributes, [Reflection.CallingConventions]::Standard, $definition[2], $definition[3], [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
		$method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
	}
	$native = $builder.CreateType()
	$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
	$invalid = [IntPtr]::new(-1)
	function Open-Exact([string]$path, [uint32]$access) {
		# BACKUP_SEMANTICS | OPEN_REPARSE_POINT: the final component is opened itself.
		return $native::CreateFileW($path, $access, 7, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
	}
	function Read-Handle([IntPtr]$handle) {
		$info = [Runtime.InteropServices.Marshal]::AllocHGlobal(52)
		$idBuffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
		try {
			if (-not $native::GetFileInformationByHandle($handle, $info)) { return $null }
			if (-not $native::GetFileInformationByHandleEx($handle, 18, $idBuffer, 24)) { return $null }
			$attributesValue = [Runtime.InteropServices.Marshal]::ReadInt32($info, 0)
			$sizeHigh = [uint32]([int64][Runtime.InteropServices.Marshal]::ReadInt32($info, 32) -band 4294967295)
			$sizeLow = [uint32]([int64][Runtime.InteropServices.Marshal]::ReadInt32($info, 36) -band 4294967295)
			$links = [Runtime.InteropServices.Marshal]::ReadInt32($info, 40)
			$idBytes = New-Object byte[] 24
			[Runtime.InteropServices.Marshal]::Copy($idBuffer, $idBytes, 0, 24)
			$id = ([BitConverter]::ToString($idBytes)).Replace('-', '').ToLowerInvariant()
			if ($id.Substring(16) -eq ('0' * 32)) { return $null }
		} finally {
			[Runtime.InteropServices.Marshal]::FreeHGlobal($info)
			[Runtime.InteropServices.Marshal]::FreeHGlobal($idBuffer)
		}
		$owner = [IntPtr]::Zero; $group = [IntPtr]::Zero; $dacl = [IntPtr]::Zero; $sacl = [IntPtr]::Zero; $sd = [IntPtr]::Zero
		# OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, read on this handle.
		if ($native::GetSecurityInfo($handle, 1, 5, [ref]$owner, [ref]$group, [ref]$dacl, [ref]$sacl, [ref]$sd) -ne 0) { return $null }
		try {
			$length = [int]$native::GetSecurityDescriptorLength($sd)
			if ($length -le 0 -or $length -gt 65536) { return $null }
			$bytes = New-Object byte[] $length
			[Runtime.InteropServices.Marshal]::Copy($sd, $bytes, 0, $length)
		} finally {
			[void]$native::LocalFree($sd)
		}
		$descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($bytes, 0)
		$flags = [int]$descriptor.ControlFlags
		$aces = @()
		$aceCount = 0; $allowCount = 0; $denyCount = 0; $otherCount = 0
		if ($null -ne $descriptor.DiscretionaryAcl) {
			foreach ($ace in $descriptor.DiscretionaryAcl) {
				$aceCount += 1
				$rawType = [int]$ace.AceType
				if ($rawType -eq 0 -or $rawType -eq 1) {
					if ($rawType -eq 0) { $allowCount += 1; $grant = 'allow' } else { $denyCount += 1; $grant = 'deny' }
					$aceFlags = [int]$ace.AceFlags
					# AceFlags: OI=1, CI=2, NP=4, IO=8, INHERITED=0x10, mapped to the
					# .NET InheritanceFlags/PropagationFlags numbering the verifier uses.
					$inherit = 0
					if (($aceFlags -band 2) -ne 0) { $inherit = $inherit -bor 1 }
					if (($aceFlags -band 1) -ne 0) { $inherit = $inherit -bor 2 }
					$propagate = 0
					if (($aceFlags -band 4) -ne 0) { $propagate = $propagate -bor 1 }
					if (($aceFlags -band 8) -ne 0) { $propagate = $propagate -bor 2 }
					$aces += [pscustomobject]@{
						sid = [string]$ace.SecurityIdentifier.Value
						aceType = $grant
						rights = ([int64]$ace.AccessMask) -band 4294967295
						inherit = $inherit
						propagate = $propagate
						inherited = (($aceFlags -band 16) -ne 0)
					}
				} else { $otherCount += 1 }
			}
		}
		$isDirectory = ($attributesValue -band 0x10) -ne 0
		$length64 = 0
		if (-not $isDirectory) { $length64 = ([int64]$sizeHigh * 4294967296) + [int64]$sizeLow }
		return [pscustomobject]@{
			id = $id
			links = $links
			evidence = [pscustomobject]@{
				isDirectory = $isDirectory
				isReparsePoint = (($attributesValue -band 0x400) -ne 0)
				entryCount = -1
				fileLength = $length64
				ownerSid = [string]$descriptor.Owner.Value
				daclPresent = ((($flags -band 4) -ne 0) -and ($null -ne $descriptor.DiscretionaryAcl))
				daclProtected = (($flags -band 4096) -ne 0)
				daclAceCount = $aceCount
				daclAllowCount = $allowCount
				daclDenyCount = $denyCount
				daclOtherCount = $otherCount
				aces = [object[]]@($aces)
				parentExists = $true
				parentIsReparsePoint = $false
			}
		}
	}
	function Observe([string]$path) {
		try { [void][System.IO.File]::GetAttributes($path) }
		catch [System.IO.FileNotFoundException] { return [pscustomobject]@{ state = 'absent' } }
		catch [System.IO.DirectoryNotFoundException] { return [pscustomobject]@{ state = 'absent' } }
		catch [System.UnauthorizedAccessException] { return [pscustomobject]@{ state = 'denied' } }
		# READ_ATTRIBUTES | READ_CONTROL only: inspection never needs write access.
		$handle = Open-Exact $path 0x20080
		if ($handle -eq $invalid) { return [pscustomobject]@{ state = 'denied' } }
		try {
			$observed = Read-Handle $handle
			if ($null -eq $observed) { return [pscustomobject]@{ state = 'unprovable' } }
			return [pscustomobject]@{ state = 'present'; id = $observed.id; links = $observed.links; evidence = $observed.evidence }
		} finally { [void]$native::CloseHandle($handle) }
	}
	if ($op -eq 'inspect') {
		$results = @()
		foreach ($target in @($req.targets)) {
			$path = [string]$target
			if ($path.Length -eq 0 -or $path.Length -gt ${REMEDIATION_HELPER_MAX_PATH_LENGTH} -or -not [System.IO.Path]::IsPathRooted($path)) { exit 2 }
			$results += Observe $path
		}
		$response = [pscustomobject]@{ v = ${REMEDIATION_HELPER_PROTOCOL}; ok = $true; currentSid = $current; results = [object[]]@($results) }
		[Console]::Out.Write(($response | ConvertTo-Json -Compress -Depth 8))
		exit 0
	}
	$path = [string]$req.path
	$kind = [string]$req.kind
	$expected = [string]$req.expectedId
	if ($path.Length -eq 0 -or $path.Length -gt ${REMEDIATION_HELPER_MAX_PATH_LENGTH} -or -not [System.IO.Path]::IsPathRooted($path)) { exit 2 }
	if ($kind -ne 'dir' -and $kind -ne 'file') { exit 2 }
	if ($expected -notmatch '^[0-9a-f]{48}$') { exit 2 }
	$maxBytes = [int64]$req.maxBytes
	if ($maxBytes -lt 0 -or $maxBytes -gt 1048576) { exit 2 }
	function Refuse([string]$reason) {
		[Console]::Out.Write(([pscustomobject]@{ v = ${REMEDIATION_HELPER_PROTOCOL}; ok = $true; currentSid = $current; result = 'refused'; reason = $reason } | ConvertTo-Json -Compress))
		exit 0
	}
	# MAXIMUM_ALLOWED: SetSecurityInfo on such a handle does not propagate
	# inheritable ACEs to existing children, so only this exact object changes.
	$handle = Open-Exact $path 0x02000000
	if ($handle -eq $invalid) { Refuse 'unreadable' }
	$applied = $false
	try {
		$before = Read-Handle $handle
		if ($null -eq $before) { Refuse 'protection-unsupported' }
		if ($before.id -ne $expected) { Refuse 'changed' }
		if ($before.evidence.isReparsePoint) { Refuse 'unsafe-object' }
		if ($before.evidence.isDirectory -ne ($kind -eq 'dir')) { Refuse 'unsafe-object' }
		if ($kind -eq 'file' -and $before.links -ne 1) { Refuse 'unsafe-object' }
		if ($before.evidence.ownerSid -ne $current) { Refuse 'foreign-owner' }
		# The complete supported-ACL predicate is re-proved on this held handle, not
		# taken from the earlier inspection: a present DACL made only of plain
		# allow/deny ACEs, every one enumerated, each with a non-zero mask of
		# documented bits. Anything else is refused untouched, never overwritten.
		$evidenceBefore = $before.evidence
		if (-not $evidenceBefore.daclPresent -or $evidenceBefore.daclAceCount -eq 0 -or $evidenceBefore.daclOtherCount -ne 0) { Refuse 'protection-unsupported' }
		if (@($evidenceBefore.aces).Count -ne $evidenceBefore.daclAceCount) { Refuse 'protection-unsupported' }
		foreach ($aceBefore in @($evidenceBefore.aces)) {
			$maskBefore = [int64]$aceBefore.rights
			if ($maskBefore -eq 0 -or ($maskBefore -band [int64]${UNKNOWN_ACCESS_MASK_BITS}) -ne 0) { Refuse 'protection-unsupported' }
		}
		# Document size bounds are re-proved on the same handle too.
		if ($kind -eq 'file' -and ($evidenceBefore.fileLength -le 0 -or $evidenceBefore.fileLength -gt $maxBytes)) { Refuse 'malformed' }
		$aceFlags = ''
		if ($kind -eq 'dir') { $aceFlags = 'OICI' }
		$sddl = 'D:P(A;' + $aceFlags + ';FA;;;' + $current + ')(A;' + $aceFlags + ';FA;;;SY)(A;' + $aceFlags + ';FA;;;BA)'
		$template = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)
		$aclBytes = New-Object byte[] $template.DiscretionaryAcl.BinaryLength
		$template.DiscretionaryAcl.GetBinaryForm($aclBytes, 0)
		$acl = [Runtime.InteropServices.Marshal]::AllocHGlobal($aclBytes.Length)
		try {
			[Runtime.InteropServices.Marshal]::Copy($aclBytes, 0, $acl, $aclBytes.Length)
			$applied = $true
			# DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION only.
			$status = $native::SetSecurityInfo($handle, 1, [uint32]2147483652, [IntPtr]::Zero, [IntPtr]::Zero, $acl, [IntPtr]::Zero)
		} finally {
			[Runtime.InteropServices.Marshal]::FreeHGlobal($acl)
		}
		if ($status -ne 0) {
			[Console]::Out.Write(([pscustomobject]@{ v = ${REMEDIATION_HELPER_PROTOCOL}; ok = $true; currentSid = $current; result = 'write-failed' } | ConvertTo-Json -Compress))
			exit 0
		}
		$after = Read-Handle $handle
	} finally {
		[void]$native::CloseHandle($handle)
	}
	$reopened = Observe $path
	$response = [pscustomobject]@{
		v = ${REMEDIATION_HELPER_PROTOCOL}; ok = $true; currentSid = $current; result = 'applied'
		after = $after; reopened = $reopened
	}
	[Console]::Out.Write(($response | ConvertTo-Json -Compress -Depth 8))
	exit 0
} catch {
	exit 3
}
`;

/**
 * Windows caps one CreateProcess command line at 32,767 characters, and the
 * UTF-16LE/Base64 `-EncodedCommand` form of the fixed helper above would sit at
 * that limit. Only the fixed source is compressed behind a short constant
 * bootstrap; request data still travels separately as JSON on stdin, and
 * nothing is interpolated except this module's own compressed constant.
 */
const REMEDIATION_HELPER_COMPRESSED = deflateRawSync(Buffer.from(REMEDIATION_HELPER_SCRIPT, "utf8")).toString("base64");
const REMEDIATION_HELPER_BOOTSTRAP = `
$bytes = [Convert]::FromBase64String('${REMEDIATION_HELPER_COMPRESSED}')
$stream = New-Object System.IO.MemoryStream(,$bytes)
$inflate = New-Object System.IO.Compression.DeflateStream($stream, [System.IO.Compression.CompressionMode]::Decompress)
$reader = New-Object System.IO.StreamReader($inflate, [System.Text.Encoding]::UTF8)
try { $source = $reader.ReadToEnd() }
finally { $reader.Dispose(); $inflate.Dispose(); $stream.Dispose() }
& ([ScriptBlock]::Create($source))
`;
const REMEDIATION_HELPER_ENCODED_COMMAND = Buffer.from(REMEDIATION_HELPER_BOOTSTRAP, "utf16le").toString("base64");

/** Exposed for focused tests only: the fixed helper text (never interpolated with data). */
export const PEER_STORAGE_REMEDIATION_HELPER_SCRIPT = REMEDIATION_HELPER_SCRIPT;

/** Exposed for focused tests only: the constant bootstrap actually encoded into argv. */
export const PEER_STORAGE_REMEDIATION_HELPER_BOOTSTRAP = REMEDIATION_HELPER_BOOTSTRAP;

interface WindowsObservation {
	readonly state: "absent" | "denied" | "unprovable" | "present";
	readonly id?: string;
	readonly links?: number;
	readonly evidence?: WindowsAclEvidence;
}

const SID_PATTERN = /^S-\d(?:-\d{1,10}){1,16}$/u;
const NATIVE_ID_PATTERN = /^[0-9a-f]{48}$/u;

function parseObservation(value: unknown): WindowsObservation | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (record.state === "absent" || record.state === "denied" || record.state === "unprovable") return { state: record.state };
	if (record.state !== "present") return null;
	if (typeof record.id !== "string" || !NATIVE_ID_PATTERN.test(record.id)) return null;
	if (typeof record.links !== "number" || !Number.isSafeInteger(record.links) || record.links < 0) return null;
	const evidence = parseWindowsAclEvidence(record.evidence);
	if (evidence === null) return { state: "unprovable" };
	return { state: "present", id: record.id, links: record.links, evidence };
}

function runRemediationHelper(
	request: Record<string, unknown>,
	probe: WindowsPeerStatePermissionProbe,
): Record<string, unknown> | null {
	const executable = (probe.resolveExecutable ?? resolveTrustedSystemPowerShell)();
	if (typeof executable !== "string" || executable.length === 0 || !isAbsolute(executable)) return null;
	const input = encodeWindowsHelperRequest({ v: REMEDIATION_HELPER_PROTOCOL, ...request });
	if (input === null || input.length > 16_384) return null;
	try {
		const child = (probe.execute ?? productionWindowsAclExecutor)(
			executable,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", REMEDIATION_HELPER_ENCODED_COMMAND],
			{
				input,
				timeoutMs: REMEDIATION_HELPER_TIMEOUT_MS,
				maxBufferBytes: REMEDIATION_HELPER_MAX_OUTPUT_BYTES,
				cwd: dirname(executable),
				env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: "1" },
			},
		);
		if (child === null || typeof child !== "object" || child.status !== 0) return null;
		if (typeof child.stdout !== "string" || child.stdout.length === 0 || child.stdout.length > REMEDIATION_HELPER_MAX_OUTPUT_BYTES) {
			return null;
		}
		const parsed: unknown = JSON.parse(child.stdout);
		if (typeof parsed !== "object" || parsed === null) return null;
		const record = parsed as Record<string, unknown>;
		if (record.v !== REMEDIATION_HELPER_PROTOCOL || record.ok !== true) return null;
		if (typeof record.currentSid !== "string" || !SID_PATTERN.test(record.currentSid)) return null;
		return record;
	} catch {
		return null;
	}
}

/**
 * Compose the evidence the shared verifiers expect. Remediation never
 * enumerates directory entries (emptiness is irrelevant to protecting an
 * existing directory), and parents are fixed targets proven on their own
 * handles first, so these two fields are the remediation's documented inputs,
 * not observations.
 */
function verifierEvidence(spec: TargetSpec, evidence: WindowsAclEvidence): WindowsAclEvidence {
	return {
		...evidence,
		entryCount: spec.kind === "dir" ? 0 : -1,
		parentExists: true,
		parentIsReparsePoint: false,
	};
}

function windowsProtectionReason(spec: TargetSpec, evidence: WindowsAclEvidence, currentSid: string): PeerStorageReason | null {
	const composed = verifierEvidence(spec, evidence);
	return spec.requirement === "owner-controlled"
		? classifyOwnerControlledAclEvidence(composed, currentSid)
		: classifyPrivateAclEvidence(composed, currentSid, spec.kind);
}

interface WindowsAssessment {
	readonly status: PeerStorageTargetStatus;
	readonly reason: PeerStorageReason | null;
	readonly id?: string;
}

function assessWindowsObservation(spec: TargetSpec, observation: WindowsObservation, currentSid: string): WindowsAssessment {
	if (observation.state === "absent") return { status: "absent", reason: null };
	if (observation.state === "denied") return { status: "refused", reason: "unreadable" };
	if (observation.state === "unprovable" || observation.evidence === undefined || observation.id === undefined) {
		return { status: "refused", reason: "protection-unsupported" };
	}
	const evidence = observation.evidence;
	// Every later observation names the exact observed object.
	const id = observation.id;
	if (evidence.isReparsePoint) return { status: "refused", reason: "unsafe-object", id };
	if (evidence.isDirectory !== (spec.kind === "dir")) return { status: "refused", reason: "unsafe-object", id };
	if (spec.kind === "file") {
		// Every NTFS name of a file shares one descriptor: an extra link would make
		// a repair change objects outside the fixed target set.
		if (observation.links !== 1) return { status: "refused", reason: "unsafe-object", id };
		if (evidence.fileLength <= 0 || evidence.fileLength > spec.maxBytes) return { status: "refused", reason: "malformed", id };
	}
	if (!isModelledWindowsAcl(evidence)) return { status: "refused", reason: "protection-unsupported", id };
	const reason = windowsProtectionReason(spec, evidence, currentSid);
	if (reason === null) return { status: "protected", reason: null, id };
	if (evidence.ownerSid !== currentSid) return { status: "refused", reason: "foreign-owner", id };
	if (reason !== "unsafe-permissions") return { status: "refused", reason, id };
	return { status: "repairable", reason, id };
}

function repairWindowsTarget(
	spec: TargetSpec,
	assessed: WindowsAssessment,
	probe: WindowsPeerStatePermissionProbe,
): PeerStorageRepairTargetResult {
	const response = runRemediationHelper(
		{ op: "repair", path: spec.path, kind: spec.kind, expectedId: assessed.id, maxBytes: spec.maxBytes },
		probe,
	);
	// No response at all: the helper may have died at any point, including after
	// its descriptor write, so the change cannot be ruled out.
	if (response === null) return { target: spec.target, outcome: "failed-possibly-changed", reason: "protection-unsupported" };
	const currentSid = (response.currentSid as string).toUpperCase();
	if (response.result === "refused") {
		const reason = typeof response.reason === "string" ? response.reason : "";
		const fixed: PeerStorageReason = (["unreadable", "protection-unsupported", "changed", "unsafe-object", "foreign-owner", "malformed"] as const)
			.find((candidate) => candidate === reason) ?? "protection-unsupported";
		return { target: spec.target, outcome: "failed-unchanged", reason: fixed };
	}
	if (response.result === "write-failed") {
		return { target: spec.target, outcome: "failed-possibly-changed", reason: "unsafe-permissions" };
	}
	if (response.result !== "applied") return { target: spec.target, outcome: "failed-possibly-changed", reason: "protection-unsupported" };
	const after = parseObservation(typeof response.after === "object" && response.after !== null
		? { state: "present", ...(response.after as Record<string, unknown>) }
		: null);
	const reopened = parseObservation(response.reopened);
	const failed = (reason: PeerStorageReason): PeerStorageRepairTargetResult =>
		({ target: spec.target, outcome: "failed-possibly-changed", reason });
	for (const observed of [after, reopened]) {
		if (observed === null || observed.state !== "present" || observed.evidence === undefined) return failed("protection-unsupported");
		// The same exact object, by full native file identity, on both reads.
		if (observed.id !== assessed.id) return failed("changed");
		if (observed.evidence.isReparsePoint || observed.evidence.isDirectory !== (spec.kind === "dir")) return failed("unsafe-object");
		if (spec.kind === "file" && observed.links !== 1) return failed("unsafe-object");
		// The repair target is the private descriptor for every fixed object.
		const reason = classifyPrivateAclEvidence(verifierEvidence(spec, observed.evidence), currentSid, spec.kind);
		if (reason !== null) return failed(reason);
	}
	return { target: spec.target, outcome: "repaired", reason: null };
}

// -------------------------------------------------------------- orchestration

interface PlannedTarget {
	readonly spec: TargetSpec;
	readonly assessment: PeerStorageTargetAssessment;
	readonly posix?: PosixObservation;
	readonly windows?: WindowsAssessment;
}

/** Children of an absent directory are absent; of a refused or unassessed one, not assessed. */
function inheritedStatus(parent: PeerStorageTargetAssessment | undefined): PeerStorageTargetAssessment["status"] | null {
	if (parent === undefined) return null;
	if (parent.status === "absent") return "absent";
	if (parent.status === "refused" || parent.status === "not-assessed") return "not-assessed";
	return null;
}

function finishAssessment(spec: TargetSpec, status: PeerStorageTargetStatus, reason: PeerStorageReason | null, parent?: TargetSpec): PeerStorageTargetAssessment {
	// An absent document inside its existing initialized directory stays
	// unavailable; that fact is reported, never repaired by defaulting.
	if (status === "absent" && spec.kind === "file" && parent !== undefined) {
		return Object.freeze({ target: spec.target, status, reason: "missing-initialized" });
	}
	return Object.freeze({ target: spec.target, status, reason });
}

function plan(options: PeerStorageRemediationOptions, probe: PeerStorageRemediationProbe): { supported: boolean; targets: PlannedTarget[] } {
	const platform = probe.platform ?? process.platform;
	const canonical = canonicalAgentDirectory(options?.agentDir);
	if (canonical === "absent" || canonical === "unusable") {
		const absent = canonical === "absent";
		return {
			supported: true,
			targets: targetsFor("/").map((spec, index) => ({
				spec,
				assessment: Object.freeze({
					target: spec.target,
					status: absent ? "absent" : index === 0 ? "refused" : "not-assessed",
					reason: absent || index !== 0 ? null : "unsafe-object",
				}),
			})),
		};
	}
	const specs = targetsFor(canonical);
	const supported = platform === "win32" || POSIX_PLATFORMS.includes(platform);
	if (!supported) {
		return {
			supported: false,
			targets: specs.map((spec) => ({ spec, assessment: Object.freeze({ target: spec.target, status: "refused", reason: "protection-unsupported" }) })),
		};
	}
	const planned: PlannedTarget[] = [];
	if (platform === "win32") {
		const response = runRemediationHelper({ op: "inspect", targets: specs.map((spec) => spec.path) }, probe.windows ?? {});
		const results = response !== null && Array.isArray(response.results) ? response.results : null;
		const currentSid = response !== null ? (response.currentSid as string).toUpperCase() : "";
		specs.forEach((spec, index) => {
			const parentSpec = spec.parent >= 0 ? specs[spec.parent] : undefined;
			const inherited = inheritedStatus(spec.parent >= 0 ? planned[spec.parent]?.assessment : undefined);
			if (inherited !== null) {
				planned.push({ spec, assessment: finishAssessment(spec, inherited, null) });
				return;
			}
			const observation = results === null || results.length !== specs.length ? null : parseObservation(results[index]);
			if (observation === null) {
				planned.push({ spec, assessment: finishAssessment(spec, "refused", "protection-unsupported") });
				return;
			}
			const assessed = assessWindowsObservation(spec, observation, currentSid);
			planned.push({ spec, windows: assessed, assessment: finishAssessment(spec, assessed.status, assessed.reason, parentSpec) });
		});
		return { supported: true, targets: planned };
	}
	specs.forEach((spec) => {
		const parentSpec = spec.parent >= 0 ? specs[spec.parent] : undefined;
		const inherited = inheritedStatus(spec.parent >= 0 ? planned[spec.parent]?.assessment : undefined);
		if (inherited !== null) {
			planned.push({ spec, assessment: finishAssessment(spec, inherited, null) });
			return;
		}
		const observed = assessPosixTarget(spec, platform, probe);
		planned.push({ spec, posix: observed, assessment: finishAssessment(spec, observed.status, observed.reason, parentSpec) });
	});
	return { supported: true, targets: planned };
}

function summarize(supported: boolean, targets: readonly PeerStorageTargetAssessment[]): PeerStorageAssessment {
	const blocked = targets.find((target) => target.status === "refused") ?? null;
	const repairable = blocked === null && targets.some((target) => target.status === "repairable");
	return Object.freeze({ supported, targets: Object.freeze([...targets]), repairable, blocked });
}

/** Assessed object identity: POSIX device/inode or the full Windows file ID. */
function identityOf(target: PlannedTarget | undefined): string | undefined {
	if (target === undefined) return undefined;
	if (target.posix?.dev !== undefined && target.posix.ino !== undefined) return `${target.posix.dev}:${target.posix.ino}`;
	return target.windows?.id;
}

/**
 * Compare one target's assessment with its fresh re-observation after the
 * repair. A previously present object must be the same object and protected
 * now; a previously absent one must still be absent or, if something appeared,
 * already protected. Returns the fixed failure reason, or null.
 */
function reproofFailure(before: PlannedTarget, after: PlannedTarget | undefined): PeerStorageReason | null {
	if (after === undefined) return "changed";
	const wasPresent = before.assessment.status === "protected" || before.assessment.status === "repairable";
	if (wasPresent) {
		if (after.assessment.status !== "protected" && after.assessment.status !== "repairable" && after.assessment.status !== "refused") {
			return "changed";
		}
		const assessedIdentity = identityOf(before);
		if (assessedIdentity === undefined || identityOf(after) !== assessedIdentity) return "changed";
		if (after.assessment.status !== "protected") return after.assessment.reason ?? "unsafe-permissions";
		return null;
	}
	if (after.assessment.status === "absent" || after.assessment.status === "protected") return null;
	if (after.assessment.status === "not-assessed") return "changed";
	return after.assessment.reason ?? "changed";
}

/**
 * Read-only eligibility report for the fixed Network storage targets. It never
 * changes anything, reads no document bytes, and is only advisory: a repair
 * re-proves eligibility on the exact objects it modifies.
 */
export function assessPeerStorageProtection(
	options: PeerStorageRemediationOptions,
	probe: PeerStorageRemediationProbe = {},
): PeerStorageAssessment {
	const planned = plan(options, probe);
	return summarize(planned.supported, planned.targets.map((target) => target.assessment));
}

/**
 * Explicitly tighten the protection of the existing fixed Network storage
 * targets. See the module comment for the exact contract; the report is the
 * whole truth of what happened, including possible partial change.
 */
export function repairPeerStorageProtection(
	options: PeerStorageRemediationOptions,
	probe: PeerStorageRemediationProbe = {},
): PeerStorageRepairReport {
	const platform = probe.platform ?? process.platform;
	const planned = plan(options, probe);
	const assessments = planned.targets.map((target) => target.assessment);
	const priorExposurePossible = assessments.some((target) => target.status === "repairable");
	const blocked = assessments.some((target) => target.status === "refused");
	const passive = (target: PlannedTarget): PeerStorageRepairTargetResult => {
		const { status, reason } = target.assessment;
		const outcome: PeerStorageRepairTargetOutcome = status === "absent"
			? "absent"
			: status === "protected"
				? "already-protected"
				: status === "refused"
					? "refused"
					: status === "not-assessed"
						? "not-assessed"
						: "not-attempted";
		return Object.freeze({ target: target.spec.target, outcome, reason });
	};
	if (blocked || !priorExposurePossible) {
		return Object.freeze({
			outcome: blocked ? "refused" : "nothing-to-repair",
			targets: Object.freeze(planned.targets.map(passive)),
			changed: false,
			restartRequired: false,
			priorExposurePossible,
		});
	}
	const results: PeerStorageRepairTargetResult[] = [];
	let stopped = false;
	let changed = false;
	let allVerified = true;
	for (const target of planned.targets) {
		if (target.assessment.status !== "repairable") {
			results.push(passive(target));
			continue;
		}
		if (stopped) {
			results.push(Object.freeze({ target: target.spec.target, outcome: "not-attempted", reason: target.assessment.reason }));
			allVerified = false;
			continue;
		}
		const result = platform === "win32"
			? repairWindowsTarget(target.spec, target.windows ?? { status: "refused", reason: "protection-unsupported" }, probe.windows ?? {})
			: repairPosixTarget(target.spec, target.posix ?? { status: "refused", reason: "protection-unsupported" }, platform, probe);
		results.push(Object.freeze(result));
		if (result.outcome === "repaired" || result.outcome === "failed-possibly-changed") changed = true;
		if (result.outcome !== "repaired") {
			// A failed parent leaves its children's paths unproven; nothing further
			// is attempted and nothing is rolled back.
			stopped = true;
			allVerified = false;
		}
	}
	// Final re-proof of every fixed target, including ones assessed as already
	// protected: each present object must still be the assessed object (by
	// identity, with its containing fixed directories re-proved the same way)
	// and must now meet its protection. Success is never reported from the
	// earlier assessment alone.
	const reproved = plan(options, probe).targets;
	for (let index = 0; index < results.length; index += 1) {
		const result = results[index];
		const before = planned.targets[index];
		const after = reproved[index];
		if (result === undefined || before === undefined) continue;
		if (result.outcome !== "repaired" && result.outcome !== "already-protected" && result.outcome !== "absent") continue;
		const failure = reproofFailure(before, after);
		if (failure === null) continue;
		results[index] = Object.freeze({ target: result.target, outcome: "unverified", reason: failure });
		allVerified = false;
	}
	const outcome: PeerStorageRepairOutcome = allVerified ? "repaired" : changed ? "partial" : "refused";
	return Object.freeze({
		outcome,
		targets: Object.freeze(results),
		changed,
		restartRequired: changed,
		priorExposurePossible,
	});
}
