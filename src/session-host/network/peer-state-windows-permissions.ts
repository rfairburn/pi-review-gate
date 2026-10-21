/**
 * Native Windows half of the peer-state protection policy (Refs #480).
 *
 * NTFS protection is proven from the actual security descriptor: owner SID, the
 * DACL's ACE SIDs, and the numeric `FileSystemRights` masks read through
 * `System.Security.AccessControl` (`FileSystemInfo.GetAccessControl`) by a
 * fixed, trusted system PowerShell. Mode bits, `fs.access`, canonicalized paths
 * and localized `icacls` text prove nothing here, so none of them are consulted.
 *
 * Failure is always the caller's fixed error: no raw native output, exit code,
 * path, SID, or interpreter diagnostic is ever propagated.
 *
 * Rights are real `ACCESS_MASK` values: the helper normalizes each ACE mask to
 * an unsigned 32-bit integer (the .NET `FileSystemRights` enum is `Int32`, so
 * `GENERIC_READ` arrives as a negative `int64` unless it is re-masked), and
 * nothing wider than 32 bits or outside the documented bit set is accepted.
 * Untrusted principals are checked against an allow-list of known read,
 * traverse, synchronize and read-control rights, never against a deny-list:
 * any unknown, security, write, delete, ACL, or ownership right — inherit-only
 * included — is a refusal.
 *
 * Trust boundary, stated honestly:
 * - The current account and the OS-privileged set below (LocalSystem and the
 *   built-in Administrators alias) are trusted. Any other SID — Users,
 *   Authenticated Users, Everyone, other accounts, or unknown SIDs — is
 *   untrusted and may hold only the documented read-only mask below.
 * - An administrator, `SYSTEM`, or a process already running as the same
 *   account can always read these files. This policy proves protection against
 *   other accounts and untrusted authorities, not against the account itself or
 *   OS-privileged accounts.
 * - The interpreter path is derived from the inherited host process
 *   `SystemRoot`/`WINDIR`. That inherited value is a trusted *configuration*
 *   assumption inside the same-account boundary — the same launcher could point
 *   `SystemRoot` anywhere — and `statSync().isFile()` only proves that a regular
 *   file exists at a fixed absolute location. Neither is a cryptographic OS
 *   signature proof, and this module neither checks nor claims one.
 * - Editing a DACL does not revoke a handle another process already opened.
 *   That is why existing unsafe objects are refused and never repaired; only
 *   objects the caller has just created are given a private DACL, and the
 *   parent is checked first so no untrusted principal holds child write,
 *   delete-child, change-permissions, or take-ownership authority (including
 *   inherit-only ACEs) across the pre-protection window.
 * - Emptiness and type observations are *eligibility* checks, not a creation
 *   receipt: they keep a used object from being re-ACL'd, while the caller owns
 *   the exclusive-create/inode proof for the object it hands over.
 * - NTFS has no link-count analogue to the POSIX `nlink` check. Hard links
 *   share one security descriptor, so a second name cannot carry different
 *   protection; the residual exposure is deletion through another name's
 *   containing directory, which is availability, not disclosure.
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { peerError } from "./protocol";
import type { PeerStatePermissionPolicy } from "./peer-state-permission-policy";

/** Fixed helper protocol version carried in every request and response. */
const ACL_HELPER_PROTOCOL = 1;
/** Fixed wall-clock bound for one helper child. */
const ACL_HELPER_TIMEOUT_MS = 15_000;
/** Fixed bound on helper stdout; anything larger is a refusal. */
const ACL_HELPER_MAX_OUTPUT_BYTES = 64 * 1024;
/** Fixed bound on the request path handed to the helper. */
const ACL_HELPER_MAX_PATH_LENGTH = 2_000;
/** Fixed bound on ACEs accepted in one descriptor; a longer DACL is a refusal. */
const MAX_ACE_COUNT = 64;

/** Windows `FileSystemRights` bits read numerically out of the security descriptor. */
const RIGHT = {
	readData: 0x0000_0001,
	writeData: 0x0000_0002,
	appendData: 0x0000_0004,
	readExtendedAttributes: 0x0000_0008,
	writeExtendedAttributes: 0x0000_0010,
	execute: 0x0000_0020,
	deleteChild: 0x0000_0040,
	/** `FILE_READ_ATTRIBUTES`. */
	readAttributes: 0x0000_0080,
	/** `FILE_WRITE_ATTRIBUTES`. */
	writeAttributes: 0x0000_0100,
	delete: 0x0001_0000,
	readControl: 0x0002_0000,
	writeDa: 0x0004_0000,
	writeOwner: 0x0008_0000,
	synchronize: 0x0010_0000,
	/** `FileSystemRights.FullControl`, i.e. the `GENERIC_ALL` encoding. */
	fullControl: 0x1000_0000,
	/**
	 * The other encoding of "full control" seen on real hosts: every specific
	 * NTFS right (as `icacls` `(F)` ACEs and `Modify`-style grants carry it).
	 * Both forms must be understood, because a rule created through .NET reports
	 * `GENERIC_ALL` while a tool-created one reports the specific mask.
	 */
	specificFullControl: 0x001f_01ff,
	genericExecute: 0x2000_0000,
	genericWrite: 0x4000_0000,
	genericRead: 0x8000_0000,
	/** `ACCESS_SYSTEM_SECURITY`: read *and rewrite* the SACL. Never trust it. */
	accessSystemSecurity: 0x0100_0000,
	/** `MaximumAllowed`: expands to an unknown mask, so it is never relied upon. */
	maximumAllowed: 0x0200_0000,
} as const;

/**
 * Every documented `ACCESS_MASK` bit for file objects. A mask carrying any other
 * bit is not an access mask this module understands, so it is a refusal rather
 * than silently ignored authority. Everything is bounded to 32 bits: wider
 * values are rejected during evidence parsing.
 */
const KNOWN_ACCESS_MASK
	= RIGHT.readData
	| RIGHT.writeData
	| RIGHT.appendData
	| RIGHT.readExtendedAttributes
	| RIGHT.writeExtendedAttributes
	| RIGHT.execute
	| RIGHT.deleteChild
	| RIGHT.readAttributes
	| RIGHT.writeAttributes
	| RIGHT.delete
	| RIGHT.readControl
	| RIGHT.writeDa
	| RIGHT.writeOwner
	| RIGHT.synchronize
	| RIGHT.accessSystemSecurity
	| RIGHT.maximumAllowed
	| RIGHT.fullControl
	| RIGHT.genericExecute
	| RIGHT.genericWrite
	| RIGHT.genericRead;

/**
 * The only rights an untrusted principal may hold on a parent: reading and
 * traversing the directory itself, plus the two documented generic read-only
 * encodings (`GENERIC_READ`, `GENERIC_EXECUTE`). `FILE_READ_DATA`, `FILE_EXECUTE`,
 * `FILE_READ_ATTRIBUTES`, `FILE_READ_EA`, `READ_CONTROL` and `SYNCHRONIZE` are
 * exactly what those generics expand to. Write, append, delete, delete-child,
 * change-permissions, take-ownership, `ACCESS_SYSTEM_SECURITY`, `MaximumAllowed`
 * and every other — including unknown — bit is a refusal, whether the ACE
 * applies to this object or is inherit-only (an inherit-only grant lands on the
 * children created in the pre-protection window).
 */
const UNTRUSTED_PARENT_PERMITTED_RIGHTS
	= RIGHT.readData
	| RIGHT.readExtendedAttributes
	| RIGHT.execute
	| RIGHT.readAttributes
	| RIGHT.readControl
	| RIGHT.synchronize
	| RIGHT.genericRead
	| RIGHT.genericExecute;

/** Rights the current account must hold on an owner-controlled parent. */
const PARENT_REQUIRED_RIGHTS
	= RIGHT.readData
	| RIGHT.execute
	| RIGHT.readAttributes
	| RIGHT.writeData
	| RIGHT.appendData
	| RIGHT.deleteChild;

/** Rights the current account must hold on a private directory. */
const PRIVATE_DIRECTORY_REQUIRED_RIGHTS
	= RIGHT.readData
	| RIGHT.writeData
	| RIGHT.appendData
	| RIGHT.readExtendedAttributes
	| RIGHT.writeExtendedAttributes
	| RIGHT.execute
	| RIGHT.deleteChild
	| RIGHT.readAttributes
	| RIGHT.writeAttributes
	| RIGHT.delete
	| RIGHT.readControl;

/** Rights the current account must hold on a private file. */
const PRIVATE_FILE_REQUIRED_RIGHTS
	= RIGHT.readData
	| RIGHT.writeData
	| RIGHT.readExtendedAttributes
	| RIGHT.writeExtendedAttributes
	| RIGHT.readAttributes
	| RIGHT.writeAttributes
	| RIGHT.delete
	| RIGHT.readControl;

/**
 * Explicitly justified OS-privileged SIDs, in addition to the current account.
 * LocalSystem and the built-in Administrators alias are permitted because NTFS
 * backup, restore, and volume administration depend on them on every Windows
 * host; refusing them would make real hosts unusable rather than safer. No
 * other well-known group is trusted, and the allowance is fixed — never
 * configurable and never extended by display-name or localized-string lookup.
 */
const OS_PRIVILEGED_SIDS: readonly string[] = ["S-1-5-18", "S-1-5-32-544"];

const SID_PATTERN = /^S-\d(?:-\d{1,10}){1,16}$/u;

/**
 * `PropagationFlags.InheritOnly`. Such an ACE grants rights to descendants and
 * not to the inspected object, so it can never prove usable authority over that
 * object. It still counts when looking for untrusted authority, because an
 * inherit-only grant lands on the children created inside the object.
 */
const PROPAGATE_INHERIT_ONLY = 2;

/** One enumerated ACE, with numeric rights — never a rendered ACL string. */
export interface WindowsAclAceEvidence {
	sid: string;
	aceType: "allow" | "deny";
	rights: number;
	inherit: number;
	propagate: number;
	inherited: boolean;
}

/** One security-descriptor observation for the exact object at a path. */
export interface WindowsAclEvidence {
	isDirectory: boolean;
	isReparsePoint: boolean;
	/** Directory entry count, or -1 when the object is not a directory. */
	entryCount: number;
	/** Byte length, or 0 when the object is not a regular file. */
	fileLength: number;
	ownerSid: string;
	/** False for a missing or null (full-grant) DACL. */
	daclPresent: boolean;
	daclProtected: boolean;
	/**
	 * Raw DACL ACE counts read from the self-relative descriptor itself: total,
	 * plain allow (`AceType` 0), plain deny (1), and every other — object,
	 * callback/conditional, audit, or unknown — type. The enumerated `aces` array
	 * must account for exactly these entries, so an ACE that `GetAccessRules`
	 * omitted, invented, or could not model refuses the descriptor instead of
	 * being silently absent from the proof.
	 */
	daclAceCount: number;
	daclAllowCount: number;
	daclDenyCount: number;
	daclOtherCount: number;
	aces: WindowsAclAceEvidence[];
	parentExists: boolean;
	parentIsReparsePoint: boolean;
}

/** Bounded child observation used at the trusted-helper seam. */
export interface WindowsAclChildResult {
	status: number | null;
	stdout: string;
}

export interface WindowsAclSpawnOptions {
	input: string;
	timeoutMs: number;
	maxBufferBytes: number;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

/** Test seam at the single trusted-helper spawn point. */
export type WindowsAclExecutor = (
	file: string,
	args: readonly string[],
	options: WindowsAclSpawnOptions,
) => WindowsAclChildResult;

export interface WindowsPeerStatePermissionProbe {
	/** Test seam: substitute the bounded helper child (production: `spawnSync`). */
	execute?: WindowsAclExecutor;
	/** Test seam: substitute trusted system-binary resolution (production: system root lookup). */
	resolveExecutable?: () => string | null;
}

/**
 * The one fixed helper script. Its text is a constant: the operation and path
 * travel only as JSON on stdin, and the response is JSON on stdout. Nothing is
 * ever interpolated into the script, no profile is loaded, nothing is
 * interactive, and any unexpected condition exits without writing output.
 */
const ACL_HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
	# The request is pure ASCII (the caller escapes non-ASCII path data), and the
	# console/OEM input codepage is not a safe way to read it: pin UTF-8 so a
	# non-ASCII byte can never be silently reinterpreted as a different path. A
	# host without a usable console handle may refuse the assignment; the request
	# is ASCII, which every codepage decodes identically, so that is not fatal.
	try { [Console]::InputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch { }
	$raw = [Console]::In.ReadToEnd()
	if ($raw.Length -eq 0 -or $raw.Length -gt 8192) { exit 2 }
	$req = $raw | ConvertFrom-Json
	if ($req.v -ne ${ACL_HELPER_PROTOCOL}) { exit 2 }
	$op = [string]$req.op
	$path = [string]$req.path
	$kind = [string]$req.kind
	if ($path.Length -eq 0 -or $path.Length -gt ${ACL_HELPER_MAX_PATH_LENGTH}) { exit 2 }
	if (-not [System.IO.Path]::IsPathRooted($path)) { exit 2 }
	if ($op -ne 'inspect' -and $op -ne 'protect') { exit 2 }
	if ($op -eq 'protect' -and $kind -ne 'dir' -and $kind -ne 'file') { exit 2 }
	$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
	# Access alone does not load ownership, so Owner and Group are requested too.
	$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group
	function Read-Evidence([string]$targetPath) {
		$directory = New-Object System.IO.DirectoryInfo($targetPath)
		if ($directory.Exists) {
			$entry = $directory
			$isDirectory = $true
			$parent = $directory.Parent
		} else {
			$file = New-Object System.IO.FileInfo($targetPath)
			if (-not $file.Exists) { return $null }
			$entry = $file
			$isDirectory = $false
			# FileInfo exposes Directory, not Parent.
			$parent = $file.Directory
		}
		$attributes = $entry.Attributes
		$isReparse = ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
		$entryCount = -1
		$length = 0
		if ($isDirectory) { $entryCount = @([System.IO.Directory]::GetFileSystemEntries($targetPath)).Length } else { $length = $entry.Length }
		$parentExists = $false
		$parentReparse = $false
		if ($null -ne $parent) {
			$parentExists = $true
			$parentReparse = ($parent.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
		}
		$security = $entry.GetAccessControl($sections)
		$owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
		# DACL presence and protection come from the self-relative descriptor's control
		# flags (SE_DACL_PRESENT = 0x0004, SE_DACL_PROTECTED = 0x1000), which is the only
		# public way to tell "empty DACL" apart from "no DACL at all". 0x0010 is
		# SE_SACL_PRESENT and must never be mistaken for DACL protection.
		$descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($security.GetSecurityDescriptorBinaryForm(), 0)
		$daclPresent = (([int]$descriptor.ControlFlags -band 4) -ne 0) -and ($null -ne $descriptor.DiscretionaryAcl)
		$daclProtected = ([int]$descriptor.ControlFlags -band 4096) -ne 0
		$aces = @()
		foreach ($rule in $security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
			$grant = 'deny'
			if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) { $grant = 'allow' }
			# FileSystemRights is an Int32 enum, so a mask with bit 31 set (for example
			# GENERIC_READ, 0x80000000) casts to a negative int64. Re-mask to the low 32
			# bits so the caller receives a real unsigned ACCESS_MASK and never has to
			# guess at sign extension.
			$mask = ([int64]$rule.FileSystemRights) -band 4294967295
			$aces += [pscustomobject]@{
				sid = [string]$rule.IdentityReference.Value
				aceType = $grant
				rights = $mask
				inherit = [int]$rule.InheritanceFlags
				propagate = [int]$rule.PropagationFlags
				inherited = [bool]$rule.IsInherited
			}
		}
		# The raw DACL is the authority on what the descriptor contains. Counting the raw
		# entries by numeric AceType lets the caller prove the enumeration above was
		# complete: an object, callback, audit, or unknown ACE must never be dropped by
		# GetAccessRules and then blessed as a full proof. Scalars are used because a
		# one-element PowerShell array is not reliably distinct in JSON.
		$aceCount = 0
		$allowCount = 0
		$denyCount = 0
		$otherCount = 0
		if ($null -ne $descriptor.DiscretionaryAcl) {
			foreach ($rawAce in $descriptor.DiscretionaryAcl) {
				$aceCount += 1
				$rawType = [int]$rawAce.AceType
				if ($rawType -eq 0) { $allowCount += 1 } elseif ($rawType -eq 1) { $denyCount += 1 } else { $otherCount += 1 }
			}
		}
		return [pscustomobject]@{
			isDirectory = $isDirectory
			isReparsePoint = $isReparse
			entryCount = $entryCount
			fileLength = $length
			ownerSid = [string]$owner.Value
			daclPresent = [bool]$daclPresent
			daclProtected = [bool]$daclProtected
			daclAceCount = $aceCount
			daclAllowCount = $allowCount
			daclDenyCount = $denyCount
			daclOtherCount = $otherCount
			aces = [object[]]@($aces)
			parentExists = $parentExists
			parentIsReparsePoint = $parentReparse
		}
	}
	if ($op -eq 'protect') {
		$before = Read-Evidence $path
		if ($null -eq $before) { exit 4 }
		if ($before.isDirectory -ne ($kind -eq 'dir')) { exit 5 }
		if ($before.isReparsePoint) { exit 5 }
		if ($before.ownerSid -ne $current) { exit 5 }
		if ($kind -eq 'dir' -and $before.entryCount -ne 0) { exit 5 }
		if ($kind -eq 'file' -and $before.fileLength -ne 0) { exit 5 }
		$identity = New-Object System.Security.Principal.SecurityIdentifier($current)
		if ($kind -eq 'dir') {
			$target = New-Object System.IO.DirectoryInfo($path)
			$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
		} else {
			$target = New-Object System.IO.FileInfo($path)
			$inheritance = [System.Security.AccessControl.InheritanceFlags]::None
		}
		$security = $target.GetAccessControl($sections)
		$security.SetAccessRuleProtection($true, $false)
		foreach ($existing in @($security.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier]))) {
			[void]$security.RemoveAccessRuleSpecific($existing)
		}
		foreach ($trusted in @($current, 'S-1-5-18', 'S-1-5-32-544')) {
			$trustedIdentity = New-Object System.Security.Principal.SecurityIdentifier($trusted)
			$rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
				$trustedIdentity,
				[System.Security.AccessControl.FileSystemRights]::FullControl,
				$inheritance,
				[System.Security.AccessControl.PropagationFlags]::None,
				[System.Security.AccessControl.AccessControlType]::Allow)
			$security.AddAccessRule($rule)
		}
		$target.SetAccessControl($security)
	}
	$evidence = Read-Evidence $path
	if ($null -eq $evidence) { exit 4 }
	$response = [pscustomobject]@{ v = ${ACL_HELPER_PROTOCOL}; ok = $true; currentSid = $current; evidence = $evidence }
	[Console]::Out.Write(($response | ConvertTo-Json -Compress -Depth 6))
	[Console]::Out.Flush()
	exit 0
} catch {
	exit 3
}
`;

/** Base64 UTF-16LE form of the fixed script; computed once, with no IO. */
const ACL_HELPER_ENCODED_COMMAND = Buffer.from(ACL_HELPER_SCRIPT, "utf16le").toString("base64");

const productionExecutor: WindowsAclExecutor = (file, args, options) => {
	const result = spawnSync(file, [...args], {
		input: options.input,
		encoding: "utf8",
		timeout: options.timeoutMs,
		maxBuffer: options.maxBufferBytes,
		cwd: options.cwd,
		env: options.env,
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
};

/**
 * Resolve the interpreter from the inherited host process system root, at fixed
 * absolute system paths only — never from PATH and never relative to the
 * caller's working directory.
 *
 * This is a bounded trust *assumption*, not a proof: `SystemRoot`/`WINDIR` are
 * inherited environment values inside the same-account boundary, and
 * `statSync().isFile()` only shows a regular file exists at that fixed path. It
 * is not an OS signature, publisher, or owner check, and nothing here would
 * survive a compromised or deliberately repointed system root.
 */
export function resolveTrustedSystemPowerShell(): string | null {
	const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
	if (!systemRoot || !isAbsolute(systemRoot)) return null;
	const system32 = join(systemRoot, "System32");
	for (const candidate of [
		join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"),
		join(system32, "WindowsPowerShell", "v1.0", "pwsh.exe"),
	]) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// Try the next fixed system location.
		}
	}
	return null;
}

function isSid(value: unknown): value is string {
	return typeof value === "string" && SID_PATTERN.test(value);
}

function isBoolean(value: unknown): value is boolean {
	return value === true || value === false;
}

/** A real `ACCESS_MASK`: an unsigned 32-bit integer, never a wider 48-bit value. */
function isAccessMask(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

/** Small non-negative flags field (inheritance/propagation flags, AceType). */
function isBoundedCount(value: unknown, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/** A real byte/entry count, never a mask: any non-negative safe integer. */
function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Strict shape check for one helper ACE record; anything unknown fails closed. */
function parseAce(value: unknown): WindowsAclAceEvidence | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (!isSid(record.sid)) return null;
	if (record.aceType !== "allow" && record.aceType !== "deny") return null;
	if (!isAccessMask(record.rights) || record.rights === 0) return null;
	if (!isBoundedCount(record.inherit, 0xf) || !isBoundedCount(record.propagate, 0x3)) return null;
	if (!isBoolean(record.inherited)) return null;
	return {
		sid: record.sid.toUpperCase(),
		aceType: record.aceType,
		rights: record.rights,
		inherit: record.inherit,
		propagate: record.propagate,
		inherited: record.inherited,
	};
}

/** Strict shape check for one helper evidence record; anything unknown fails closed. */
function parseEvidence(value: unknown): WindowsAclEvidence | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (!isBoolean(record.isDirectory) || !isBoolean(record.isReparsePoint)) return null;
	if (record.entryCount !== -1 && !isNonNegativeInteger(record.entryCount)) return null;
	if (!isNonNegativeInteger(record.fileLength)) return null;
	if (!isSid(record.ownerSid)) return null;
	if (!isBoolean(record.daclPresent) || !isBoolean(record.daclProtected)) return null;
	if (!isBoolean(record.parentExists) || !isBoolean(record.parentIsReparsePoint)) return null;
	if (!isBoundedCount(record.daclAceCount, MAX_ACE_COUNT)) return null;
	if (!isBoundedCount(record.daclAllowCount, MAX_ACE_COUNT)) return null;
	if (!isBoundedCount(record.daclDenyCount, MAX_ACE_COUNT)) return null;
	if (!isBoundedCount(record.daclOtherCount, MAX_ACE_COUNT)) return null;
	const daclAceCount = record.daclAceCount;
	const daclAllowCount = record.daclAllowCount;
	const daclDenyCount = record.daclDenyCount;
	const daclOtherCount = record.daclOtherCount;
	if (daclAllowCount + daclDenyCount + daclOtherCount !== daclAceCount) return null;
	// A one-element PowerShell array is not reliably distinct from a scalar in JSON,
	// so a single ACE may arrive unwrapped. The raw count above still has to agree,
	// which keeps the reconciliation exact rather than lenient.
	const rawAces: unknown[] = Array.isArray(record.aces)
		? record.aces
		: record.aces === undefined || record.aces === null
			? []
			: [record.aces];
	if (rawAces.length === 0 || rawAces.length > MAX_ACE_COUNT || rawAces.length !== daclAceCount) return null;
	const aces: WindowsAclAceEvidence[] = [];
	for (const entry of rawAces) {
		const ace = parseAce(entry);
		if (ace === null) return null;
		aces.push(ace);
	}
	return {
		isDirectory: record.isDirectory,
		isReparsePoint: record.isReparsePoint,
		entryCount: record.entryCount as number,
		fileLength: record.fileLength as number,
		ownerSid: (record.ownerSid as string).toUpperCase(),
		daclPresent: record.daclPresent,
		daclProtected: record.daclProtected,
		daclAceCount,
		daclAllowCount,
		daclDenyCount,
		daclOtherCount,
		aces,
		parentExists: record.parentExists,
		parentIsReparsePoint: record.parentIsReparsePoint,
	};
}

function parseHelperResponse(stdout: string): { evidence: WindowsAclEvidence; currentSid: string } | null {
	if (stdout.length === 0 || stdout.length > ACL_HELPER_MAX_OUTPUT_BYTES) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	if (record.v !== ACL_HELPER_PROTOCOL || record.ok !== true) return null;
	if (!isSid(record.currentSid)) return null;
	const currentSid = (record.currentSid as string).toUpperCase();
	const evidence = parseEvidence(record.evidence);
	return evidence === null ? null : { evidence, currentSid };
}

/** Rights test: `FullControl`/`GENERIC_ALL` subsumes the required mask. */
function rightsSatisfy(rights: number, required: number): boolean {
	if ((rights & RIGHT.fullControl) !== 0) return true;
	return (rights & required) === required;
}

function trustedSid(sid: string, currentSid: string): boolean {
	return sid === currentSid || OS_PRIVILEGED_SIDS.includes(sid);
}

/** False when an ACE carries any bit outside the documented 32-bit access mask. */
function isKnownAccessMask(rights: number): boolean {
	return (rights & ~KNOWN_ACCESS_MASK) === 0;
}

/**
 * The allow-list test for an untrusted principal: every bit must be a known
 * read/traverse/synchronize/read-control right. A single unknown, security,
 * write, delete, ACL, or ownership bit refuses the whole descriptor.
 */
function untrustedRightsPermissible(rights: number): boolean {
	return (rights & ~UNTRUSTED_PARENT_PERMITTED_RIGHTS) === 0;
}

/**
 * Prove the descriptor enumeration is complete: every raw DACL ACE must be a
 * plain allow or deny entry that `GetAccessRules` reported. Object-specific,
 * callback/conditional, audit, or unknown ACE types could carry authority this
 * module cannot model, so their presence — or any count mismatch — is a
 * refusal rather than a silently omitted part of the proof.
 */
function aclEnumerationIsComplete(evidence: WindowsAclEvidence): boolean {
	// 0 = AccessAllowed and 1 = AccessDenied in a DACL; anything else is a type this
	// module cannot model, so no allow-listed remainder can make the descriptor safe.
	if (evidence.daclOtherCount !== 0) return false;
	if (evidence.daclAceCount !== evidence.aces.length) return false;
	const allow = evidence.aces.filter((ace) => ace.aceType === "allow").length;
	const deny = evidence.aces.length - allow;
	return evidence.daclAllowCount === allow && evidence.daclDenyCount === deny;
}

/**
 * Prove an owner-controlled parent from real descriptor evidence: a real
 * non-reparse directory, owned by the current account or an OS-privileged
 * account, with a present DACL whose untrusted ACEs — inherited or inherit-only
 * alike — stay inside the documented read-only allow-list. Public
 * read/traverse access is permissible here, so read-only ACEs for other
 * principals do not fail the check; any write, delete, ACL, ownership,
 * security, or unknown right does.
 *
 * A refusal is the whole response: an unsafe existing parent is never repaired,
 * because an ACL edit also would not revoke a handle an untrusted process
 * already holds open on it.
 */
export function verifyOwnerControlledAclEvidence(evidence: WindowsAclEvidence, currentSid: string): boolean {
	if (!evidence.isDirectory || evidence.isReparsePoint) return false;
	if (!evidence.daclPresent || evidence.aces.length === 0) return false;
	if (!aclEnumerationIsComplete(evidence)) return false;
	if (!trustedSid(evidence.ownerSid, currentSid)) return false;
	let ownerAuthority = false;
	for (const ace of evidence.aces) {
		// Unknown bits never pass, whichever principal holds them.
		if (!isKnownAccessMask(ace.rights)) return false;
		if (ace.aceType !== "allow") return false;
		if (!trustedSid(ace.sid, currentSid)) {
			// Inherit-only grants are evaluated too: they land on children.
			if (!untrustedRightsPermissible(ace.rights)) return false;
			continue;
		}
		if (ace.sid === currentSid
			&& (ace.propagate & PROPAGATE_INHERIT_ONLY) === 0
			&& rightsSatisfy(ace.rights, PARENT_REQUIRED_RIGHTS)) {
			ownerAuthority = true;
		}
	}
	// An OS-privileged owner, or an account grant that applies only to
	// descendants, is not proof that this account can manage this directory.
	return ownerAuthority;
}

/**
 * Prove genuine privacy for one exact object: real non-reparse type, owned by
 * the current account, a present (never null) DACL with at least one ACE, the
 * DACL protected against later inherited broadening, no deny ACE, and no
 * principal other than the current account or a justified OS-privileged SID.
 * Empty ACE enumeration is never a pass: the current account's own usable
 * rights must be positively present, and an inherit-only grant does not qualify
 * because it grants nothing to this object.
 */
export function verifyPrivateAclEvidence(
	evidence: WindowsAclEvidence,
	currentSid: string,
	kind: "dir" | "file",
): boolean {
	if (kind === "dir") {
		if (!evidence.isDirectory || evidence.entryCount < 0) return false;
	} else if (evidence.isDirectory || evidence.fileLength < 0) {
		return false;
	}
	if (evidence.isReparsePoint || evidence.parentIsReparsePoint || !evidence.parentExists) return false;
	if (!evidence.daclPresent || !evidence.daclProtected) return false;
	if (evidence.aces.length === 0 || evidence.ownerSid !== currentSid) return false;
	if (!aclEnumerationIsComplete(evidence)) return false;
	const required = kind === "dir" ? PRIVATE_DIRECTORY_REQUIRED_RIGHTS : PRIVATE_FILE_REQUIRED_RIGHTS;
	let accountRights = false;
	for (const ace of evidence.aces) {
		if (!isKnownAccessMask(ace.rights)) return false;
		if (ace.aceType !== "allow") return false;
		if (!trustedSid(ace.sid, currentSid)) return false;
		if (ace.sid === currentSid
			&& (ace.propagate & PROPAGATE_INHERIT_ONLY) === 0
			&& rightsSatisfy(ace.rights, required)) accountRights = true;
	}
	return accountRights;
}

/**
 * Eligibility of a *created* object for protection: it must still be the empty
 * object of the expected kind. This is not a creation receipt — the caller owns
 * the exclusive-create/inode proof — it only keeps a used, replaced, or
 * repurposed object from being re-ACL'd into looking newly protected.
 */
export function verifyCreatedObjectEligibility(
	evidence: WindowsAclEvidence,
	kind: "dir" | "file",
): boolean {
	if (evidence.isReparsePoint) return false;
	if (kind === "dir") return evidence.isDirectory && evidence.entryCount === 0;
	return !evidence.isDirectory && evidence.fileLength === 0;
}

/**
 * Encode a helper request as pure ASCII JSON. Path data stays structured JSON —
 * nothing is interpolated into the fixed script and nothing reaches argv — but
 * every non-ASCII *code unit* is escaped, so the request means the same bytes
 * whatever input codepage the Windows console host would otherwise assume.
 *
 * The substitution deliberately runs on UTF-16 code units (no `u` flag): in
 * Unicode mode a supplementary character such as an emoji is one code point
 * beyond `\uffff` and would stay unescaped, leaving non-ASCII bytes to be
 * decoded under the console codepage. Escaping each surrogate separately yields
 * pure ASCII and still round-trips through `JSON.parse` (and PowerShell's
 * `ConvertFrom-Json`) to the exact original string.
 */
function encodeHelperRequest(request: Record<string, unknown>): string | null {
	let plain: string;
	try {
		plain = JSON.stringify(request);
	} catch {
		return null;
	}
	if (plain.length === 0) return null;
	return plain.replace(/[\u007f-\uffff]/g, (character) =>
		`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** A request path must be an absolute Windows path, independent of the host running this code. */
function isWindowsAbsolutePath(value: unknown): value is string {
	return typeof value === "string" && win32.isAbsolute(value);
}

/** One fixed-failure helper round trip; every failure path yields `null`. */
function runAclHelper(
	request: { op: "inspect" | "protect"; path: string; kind?: "dir" | "file" },
	probe: WindowsPeerStatePermissionProbe,
): { evidence: WindowsAclEvidence; currentSid: string } | null {
	if (typeof request.path !== "string" || request.path.length === 0) return null;
	if (request.path.length > ACL_HELPER_MAX_PATH_LENGTH || !isWindowsAbsolutePath(request.path)) return null;
	const executable = (probe.resolveExecutable ?? resolveTrustedSystemPowerShell)();
	if (typeof executable !== "string" || executable.length === 0 || !isAbsolute(executable)) return null;
	const input = encodeHelperRequest({ v: ACL_HELPER_PROTOCOL, ...request });
	if (input === null || input.length > 8192) return null;
	try {
		const child = (probe.execute ?? productionExecutor)(
			executable,
			["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ACL_HELPER_ENCODED_COMMAND],
			{
				input,
				timeoutMs: ACL_HELPER_TIMEOUT_MS,
				maxBufferBytes: ACL_HELPER_MAX_OUTPUT_BYTES,
				// A trusted working directory: the interpreter's own system folder,
				// never the caller's (possibly account-writable) cwd.
				cwd: dirname(executable),
				env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: "1" },
			},
		);
		if (child === null || typeof child !== "object") return null;
		if (child.status !== 0) return null;
		return parseHelperResponse(child.stdout);
	} catch {
		// No spawn, no output, or an interpreter error: fixed refusal only.
		return null;
	}
}

/**
 * Read-only observation of one object's real security descriptor, for native
 * acceptance evidence. It never mutates anything and returns `null` whenever
 * nothing is provable; no raw native diagnostic is ever returned.
 */
export function inspectPeerStateAcl(
	target: string,
	probe: WindowsPeerStatePermissionProbe = {},
): { evidence: WindowsAclEvidence; currentSid: string } | null {
	return runAclHelper({ op: "inspect", path: target }, probe);
}

/**
 * Windows policy built on the fixed trusted helper. Every method performs its
 * own real descriptor inspection; nothing is cached, assumed, or inferred from
 * mode bits, and no failure ever repairs an existing object.
 */
export function createWindowsPeerStatePermissions(
	probe: WindowsPeerStatePermissionProbe = {},
): PeerStatePermissionPolicy {
	const inspect = (path: string): { evidence: WindowsAclEvidence; currentSid: string } | null =>
		runAclHelper({ op: "inspect", path }, probe);

	const assertFromEvidence = (
		path: string,
		check: (evidence: WindowsAclEvidence, currentSid: string) => boolean,
	): void => {
		const observed = inspect(path);
		if (observed === null || !check(observed.evidence, observed.currentSid)) throw peerError("TRUST_STORE_FAILED");
	};

	const protect = (path: string, kind: "dir" | "file"): void => {
		const observed = runAclHelper({ op: "protect", path, kind }, probe);
		if (observed === null
			|| !verifyPrivateAclEvidence(observed.evidence, observed.currentSid, kind)
			|| !verifyCreatedObjectEligibility(observed.evidence, kind)) {
			throw peerError("TRUST_STORE_FAILED");
		}
	};

	return {
		assertOwnerControlledDirectory(path) {
			assertFromEvidence(path, verifyOwnerControlledAclEvidence);
		},
		assertPrivateDirectory(path) {
			assertFromEvidence(path, (evidence, currentSid) => verifyPrivateAclEvidence(evidence, currentSid, "dir"));
		},
		assertPrivateFile(path) {
			assertFromEvidence(path, (evidence, currentSid) => verifyPrivateAclEvidence(evidence, currentSid, "file"));
		},
		protectCreatedDirectory(path) {
			// Parent first: an unsafe parent leaves an untrusted write, delete, or
			// change-permissions window across protection, so it is refused whole.
			// The child itself is never touched, and no secret may be written until
			// the verification below proves the private DACL was really established.
			const parent = parentPath(path);
			const observedParent = inspect(parent);
			if (observedParent === null || !verifyOwnerControlledAclEvidence(observedParent.evidence, observedParent.currentSid)) {
				throw peerError("TRUST_STORE_FAILED");
			}
			protect(path, "dir");
		},
		protectCreatedFile(path) {
			const parent = parentPath(path);
			const observedParent = inspect(parent);
			if (observedParent === null || !verifyPrivateAclEvidence(observedParent.evidence, observedParent.currentSid, "dir")) {
				throw peerError("TRUST_STORE_FAILED");
			}
			protect(path, "file");
		},
	};
}

/**
 * The real parent directory of an absolute Windows path, as a path the helper
 * resolves the same way.
 *
 * `C:\peers` belongs to `C:\`, not to `C:`: a bare drive letter is a
 * drive-*relative* path that `DirectoryInfo` resolves against the child's own
 * working directory, so deriving `C:` here would inspect (or re-ACL) a
 * different object than the caller's parent. A drive root, a UNC share root, and
 * a root-relative path have no parent this module can prove, so they refuse.
 */
function parentPath(target: string): string {
	if (!isWindowsAbsolutePath(target)) throw peerError("TRUST_STORE_FAILED");
	const trimmed = target.replace(/[\\/]+$/u, "");
	if (trimmed.replace(/^[\\/]+/u, "").length === 0) throw peerError("TRUST_STORE_FAILED");
	const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (index < 0) throw peerError("TRUST_STORE_FAILED");
	const candidate = trimmed.slice(0, index);
	// A bare drive letter is drive-relative; the real parent of `C:\peers` is `C:\`.
	if (/^[A-Za-z]:$/u.test(candidate)) return `${candidate}\\`;
	if (candidate.length === 0) throw peerError("TRUST_STORE_FAILED");
	// `\\server` on its own is not a share root, so nothing above it is provable.
	if (/^[\\/]{2}/u.test(candidate) && !/[\\/]/u.test(candidate.replace(/^[\\/]+/u, ""))) {
		throw peerError("TRUST_STORE_FAILED");
	}
	return candidate;
}
