/**
 * Native Windows acceptance cases for peer-state protection (Refs #480).
 *
 * These are the real-NTFS proofs: they run the production policy, which drives
 * the fixed trusted system PowerShell, against synthetic directories and files
 * that this test created under a freshly made temporary root it owns. Nothing
 * outside that root is inspected or modified, and no account-wide permission
 * inventory is taken. Every native case skips on other platforms — a
 * non-Windows run proves nothing about NTFS ACLs and never claims otherwise.
 *
 * The native run at head aa6eae0 could not say *why* protection refused, so two
 * bounded, sanitized, test-only diagnostics report helper exit statuses, the
 * pre/post descriptor shape, and an independent numeric read of the raw DACL.
 * They change no assertion, skip, deadline, or production error, and the
 * `portable diagnostics:` cases at the end check that formatting layer on every
 * host — they prove nothing about NTFS ACLs either.
 *
 * Parent integration command (add to the existing Windows CI job):
 *   node --test --test-concurrency=1 dist-test/tests/session-host-peer-state-permissions-windows-native.test.js
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { isPeerTransportError } from "../src/session-host/network/index";
import { createPeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permissions";
import {
	inspectPeerStateAcl,
	resolveTrustedSystemPowerShell,
	verifyCreatedObjectEligibility,
	verifyOwnerControlledAclEvidence,
	verifyPrivateAclEvidence,
	type WindowsAclAceEvidence,
	type WindowsAclEvidence,
	type WindowsAclExecutor,
} from "../src/session-host/network/peer-state-windows-permissions";

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

/* ------------------------------------------------------------------------- *
 * Test-only native diagnostics (CI run 39601527285 at head aa6eae0).
 *
 * The native Windows job showed two failures the production module cannot
 * tell apart: `protectCreatedDirectory` refusing with the fixed error, and the
 * `(AS)` parent case being accepted when it must refuse. A helper that exits
 * non-zero, a helper that exits 0 with an unusable response, and a helper
 * response the verifier rejects all collapse into the same `TRUST_STORE_FAILED`,
 * and `icacls` exiting 0 does not prove the security ACE ever reached the
 * descriptor. This instrumentation is what separates those cases.
 *
 * Boundaries, unchanged from the rest of this file:
 * - It changes no production module, error, assertion, skip, deadline, or
 *   precondition, and it never turns a failing case into a passing one. The
 *   native cases stay red until the real defect is fixed.
 * - It reads only objects this file created inside its own `mkdtemp` root, and
 *   only through read-only security-descriptor reads. Nothing is written or
 *   mutated, no account-wide ACL inventory is taken, and no file bytes are read.
 * - Every line is bounded in size and in ACE count, and is refused outright if
 *   it would carry a SID, a path, a backslash, or any native output; the
 *   fallback is one fixed marker line. A diagnostic never masks the original
 *   error and never changes a test result.
 * ------------------------------------------------------------------------- */

/** `ACCESS_SYSTEM_SECURITY`: the right the negative parent case installs. */
const ACCESS_SYSTEM_SECURITY = 0x0100_0000;
const DIAGNOSTIC_PREFIX = "prg-native-acl-diagnostic";
/** The one line printed whenever a diagnostic could not be produced safely. */
const DIAGNOSTIC_UNAVAILABLE = `${DIAGNOSTIC_PREFIX} unavailable`;
const DIAGNOSTIC_MAX_LINE_CHARS = 1_600;
const DIAGNOSTIC_MAX_ACE_RECORDS = 8;
const DIAGNOSTIC_MAX_CALL_RECORDS = 12;
/** The production helper output ceiling; a response is only inspected for "did it parse". */
const DIAGNOSTIC_MAX_RESPONSE_CHARS = 64 * 1024;
/** The fixed diagnostic labels only. */
const DIAGNOSTIC_SAFE_LABEL = /^[A-Za-z][0-9A-Za-z-]*$/u;
/** JSON structure, numbers, and short identifiers: never a space, path, SID, or native text. */
const DIAGNOSTIC_SAFE_PAYLOAD = /^[0-9A-Za-z.,:=[\]{}_"-]*$/u;
const SID_TEXT = /^S-\d(?:-\d{1,10}){1,16}$/u;
/** Defense in depth: no security identifier of any shape, even though summaries classify principals. */
const SID_LEAK = /S-\d(?:-\d{1,10}){1,}/iu;

/** Bounds for the independent raw-DACL read; all at or under the production ceilings. */
const RAW_DACL_PROTOCOL = 1;
const RAW_DACL_TIMEOUT_MS = 10_000;
const RAW_DACL_MAX_INPUT_CHARS = 4_096;
const RAW_DACL_MAX_OUTPUT_BYTES = 16 * 1024;
const RAW_DACL_MAX_ACES = 64;
const RAW_DACL_MAX_PATH_CHARS = 2_000;

type PrincipalClass = "current" | "system" | "admin" | "authenticated-users" | "other";

interface AceSummary {
	principal: PrincipalClass;
	type: "allow" | "deny";
	rights: string;
	inherit: number;
	propagate: number;
	inherited: boolean;
	securityRight: boolean;
}

interface HelperAclSummary {
	available: boolean;
	ownerMatchesCurrent?: boolean;
	ownerPrincipal?: PrincipalClass;
	isDirectory?: boolean;
	isReparsePoint?: boolean;
	daclPresent?: boolean;
	daclProtected?: boolean;
	aceCount?: number;
	allowCount?: number;
	denyCount?: number;
	otherCount?: number;
	enumerationComplete?: boolean;
	securityRightAces?: number;
	privateDirOk?: boolean;
	ownerControlledOk?: boolean;
	createdEligibleOk?: boolean;
	aces?: AceSummary[];
	acesTruncated?: boolean;
}

interface RawAceSummary {
	kind: string;
	aceType: number;
	flags: number;
	inherited: boolean;
	mask: string;
	principal: PrincipalClass;
	securityRight: boolean;
}

interface RawAclSummary {
	available: boolean;
	reason?: string;
	ownerMatchesCurrent?: boolean;
	ownerPrincipal?: PrincipalClass;
	daclPresent?: boolean;
	daclProtected?: boolean;
	controlFlags?: number;
	aceCount?: number;
	securityRightPresent?: boolean;
	opaqueAcePresent?: boolean;
	aces?: RawAceSummary[];
	acesTruncated?: boolean;
}

interface HelperCallRecord {
	op: string;
	status: number | null;
	responseOk: boolean;
}

/** Fixed read-only raw-DACL reader. Its text is a constant: the path travels only as JSON on stdin. */
const RAW_DACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
	# The request is pure ASCII, but pin UTF-8 so a byte can never be reinterpreted
	# under the console codepage. A host without a usable console handle may refuse
	# the assignment, which is not fatal for an ASCII request.
	try { [Console]::InputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch { }
	$raw = [Console]::In.ReadToEnd()
	if ($raw.Length -eq 0 -or $raw.Length -gt 4096) { exit 2 }
	$req = $raw | ConvertFrom-Json
	if ($req.v -ne 1) { exit 2 }
	$path = [string]$req.path
	if ($path.Length -eq 0 -or $path.Length -gt 2000) { exit 2 }
	if (-not [System.IO.Path]::IsPathRooted($path)) { exit 2 }
	$directory = New-Object System.IO.DirectoryInfo($path)
	if ($directory.Exists) {
		$entry = $directory
	} else {
		$file = New-Object System.IO.FileInfo($path)
		if (-not $file.Exists) { exit 4 }
		$entry = $file
	}
	$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group
	$security = $entry.GetAccessControl($sections)
	$owner = $security.GetOwner([System.Security.Principal.SecurityIdentifier])
	$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
	# The self-relative descriptor is read directly, and each raw ACE's numeric
	# AccessMask is taken from CommonAce. This deliberately does not use the typed
	# FileSystemRights projection, so a right the typed view drops is still visible.
	$descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($security.GetSecurityDescriptorBinaryForm(), 0)
	$dacl = $descriptor.DiscretionaryAcl
	$control = [int]$descriptor.ControlFlags
	$aces = @()
	$count = 0
	if ($null -ne $dacl) {
		foreach ($ace in $dacl) {
			if ($count -lt 64) {
				$mask = $null
				$sid = ''
				if ($ace -is [System.Security.AccessControl.CommonAce]) {
					$mask = ([int64]$ace.AccessMask) -band 4294967295
					$sid = [string]$ace.SecurityIdentifier.Value
				}
				$aces += [pscustomobject]@{ t = [int]$ace.AceType; f = [int]$ace.AceFlags; i = [bool]$ace.IsInherited; m = $mask; s = $sid }
			}
			$count += 1
		}
	}
	$response = [pscustomobject]@{
		v = 1
		ok = $true
		c = [string]$current
		o = [string]$owner.Value
		k = $control
		p = ($null -ne $dacl)
		n = $count
		a = [object[]]@($aces)
	}
	[Console]::Out.Write(($response | ConvertTo-Json -Compress -Depth 6))
	[Console]::Out.Flush()
	exit 0
} catch {
	exit 3
}
`;

/** Built once from the constant script; no IO, and nothing is ever interpolated into the script. */
const RAW_DACL_ARGS: readonly string[] = [
	"-NoLogo",
	"-NoProfile",
	"-NonInteractive",
	"-ExecutionPolicy",
	"Bypass",
	"-EncodedCommand",
	Buffer.from(RAW_DACL_SCRIPT, "utf16le").toString("base64"),
];

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isSidText(value: unknown): value is string {
	return typeof value === "string" && SID_TEXT.test(value);
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

/** A numeric mask rendered as fixed-width hexadecimal; never a signed or wide value. */
function maskToHex(mask: unknown): string {
	return isBoundedInteger(mask, 0, 0xffff_ffff) ? `0x${mask.toString(16).padStart(8, "0")}` : "invalid";
}

/** Principals are reported as classes only; a raw SID never reaches a diagnostic. */
function classifyPrincipal(sid: unknown, currentSid: string): PrincipalClass {
	if (typeof sid !== "string" || sid.length === 0) return "other";
	if (!isSidText(sid)) return "other";
	const value = sid.toUpperCase();
	if (currentSid.length > 0 && value === currentSid.toUpperCase()) return "current";
	if (value === LOCAL_SYSTEM) return "system";
	if (value === ADMINISTRATORS) return "admin";
	if (value === AUTHENTICATED_USERS) return "authenticated-users";
	return "other";
}

function aceKind(aceType: number): string {
	if (aceType === 0) return "allow";
	if (aceType === 1) return "deny";
	if (aceType === 2) return "audit";
	if (aceType === 3) return "alarm";
	return "other";
}

function summarizeAce(ace: WindowsAclAceEvidence, currentSid: string): AceSummary {
	return {
		principal: classifyPrincipal(ace.sid, currentSid),
		type: ace.aceType,
		rights: maskToHex(ace.rights),
		inherit: ace.inherit,
		propagate: ace.propagate,
		inherited: ace.inherited,
		securityRight: (ace.rights & ACCESS_SYSTEM_SECURITY) !== 0,
	};
}

/** Pure so the portable cases can exercise it without a Windows host. */
function summarizeHelperEvidence(
	observed: { evidence: WindowsAclEvidence; currentSid: string } | null,
	aceLimit = DIAGNOSTIC_MAX_ACE_RECORDS,
): HelperAclSummary {
	if (observed === null || typeof observed.currentSid !== "string" || !isSidText(observed.currentSid)) {
		return { available: false };
	}
	const { evidence, currentSid } = observed;
	const aces = evidence.aces;
	const limit = Math.max(0, aceLimit);
	return {
		available: true,
		ownerMatchesCurrent: evidence.ownerSid.toUpperCase() === currentSid.toUpperCase(),
		ownerPrincipal: classifyPrincipal(evidence.ownerSid, currentSid),
		isDirectory: evidence.isDirectory,
		isReparsePoint: evidence.isReparsePoint,
		daclPresent: evidence.daclPresent,
		daclProtected: evidence.daclProtected,
		aceCount: evidence.daclAceCount,
		allowCount: evidence.daclAllowCount,
		denyCount: evidence.daclDenyCount,
		otherCount: evidence.daclOtherCount,
		enumerationComplete: evidence.daclOtherCount === 0 && evidence.daclAceCount === aces.length,
		securityRightAces: aces.filter((ace) => (ace.rights & ACCESS_SYSTEM_SECURITY) !== 0).length,
		privateDirOk: verifyPrivateAclEvidence(evidence, currentSid, "dir"),
		ownerControlledOk: verifyOwnerControlledAclEvidence(evidence, currentSid),
		createdEligibleOk: verifyCreatedObjectEligibility(evidence, "dir"),
		aces: aces.slice(0, limit).map((ace) => summarizeAce(ace, currentSid)),
		acesTruncated: aces.length > limit,
	};
}

function summarizeHelperAcl(target: string, aceLimit = DIAGNOSTIC_MAX_ACE_RECORDS): HelperAclSummary {
	try {
		return summarizeHelperEvidence(inspectPeerStateAcl(target), aceLimit);
	} catch {
		return { available: false };
	}
}

function reduceHelperSummary(summary: HelperAclSummary, limit: number): HelperAclSummary {
	const aces = summary.aces ?? [];
	if (summary.available === false) return summary;
	return {
		...summary,
		aces: aces.slice(0, Math.max(0, limit)),
		acesTruncated: summary.acesTruncated === true || aces.length > limit,
	};
}

function unavailableRaw(reason: string): RawAclSummary {
	return { available: false, reason };
}

function parseRawAce(value: unknown, currentSid: string): RawAceSummary | null {
	if (typeof value !== "object" || value === null) return null;
	const ace = value as Record<string, unknown>;
	const aceType = ace.t;
	const flags = ace.f;
	const inherited = ace.i;
	const sid = ace.s;
	const maskValue = ace.m;
	if (!isBoundedInteger(aceType, 0, 255) || !isBoundedInteger(flags, 0, 255)) return null;
	if (typeof inherited !== "boolean") return null;
	if (typeof sid !== "string") return null;
	if (sid.length !== 0 && !isSidText(sid)) return null;
	let mask = "none";
	let securityRight = false;
	if (maskValue !== null) {
		if (!isBoundedInteger(maskValue, 0, 0xffff_ffff)) return null;
		mask = maskToHex(maskValue);
		securityRight = (maskValue & ACCESS_SYSTEM_SECURITY) !== 0;
	}
	return {
		kind: aceKind(aceType),
		aceType,
		flags,
		inherited,
		mask,
		principal: classifyPrincipal(sid, currentSid),
		securityRight,
	};
}

/** Pure strict parse of the raw reader's response; anything unprovable is an unavailable marker. */
function summarizeRawEvidence(parsed: unknown, aceLimit = DIAGNOSTIC_MAX_ACE_RECORDS): RawAclSummary {
	if (typeof parsed !== "object" || parsed === null) return unavailableRaw("unavailable");
	const record = parsed as Record<string, unknown>;
	if (record.v !== RAW_DACL_PROTOCOL || record.ok !== true) return unavailableRaw("unavailable");
	if (!isSidText(record.c) || !isSidText(record.o)) return unavailableRaw("unavailable");
	const control = record.k;
	if (!isBoundedInteger(control, 0, 0xffff)) return unavailableRaw("unavailable");
	const count = record.n;
	if (!isBoundedInteger(count, 0, RAW_DACL_MAX_ACES)) return unavailableRaw("unavailable");
	const entries = record.a;
	// A short or long enumeration is incomplete: an omitted ACE could be the very
	// security right this diagnostic is looking for, so nothing is reported.
	if (!Array.isArray(entries) || entries.length !== count) return unavailableRaw("unavailable");
	const currentSid = (record.c as string).toUpperCase();
	const aces: RawAceSummary[] = [];
	let securityRightPresent = false;
	for (const entry of entries) {
		const ace = parseRawAce(entry, currentSid);
		if (ace === null) return unavailableRaw("unavailable");
		if (ace.securityRight) securityRightPresent = true;
		aces.push(ace);
	}
	return {
		available: true,
		ownerMatchesCurrent: (record.o as string).toUpperCase() === currentSid,
		ownerPrincipal: classifyPrincipal(record.o, currentSid),
		// SE_DACL_PRESENT is 0x0004 and SE_DACL_PROTECTED is 0x1000 in the control flags.
		daclPresent: (control & 4) !== 0 && record.p === true,
		daclProtected: (control & 4_096) !== 0,
		controlFlags: control,
		aceCount: count,
		securityRightPresent,
		opaqueAcePresent: aces.some((ace) => ace.mask === "none" || ace.mask === "invalid"),
		aces: aces.slice(0, Math.max(0, aceLimit)),
		acesTruncated: aces.length > aceLimit,
	};
}

function reduceRawSummary(summary: RawAclSummary, limit: number): RawAclSummary {
	const aces = summary.aces ?? [];
	if (summary.available === false) return summary;
	return {
		...summary,
		aces: aces.slice(0, Math.max(0, limit)),
		acesTruncated: summary.acesTruncated === true || aces.length > limit,
	};
}

/** Only this file's own freshly created root and the objects inside it may be inspected. */
function isInsideOwnedRoot(target: string, ownedRootPath: string): boolean {
	if (typeof target !== "string" || typeof ownedRootPath !== "string") return false;
	if (target.length === 0 || target.length > RAW_DACL_MAX_PATH_CHARS) return false;
	if (target.includes("\0") || ownedRootPath.length === 0) return false;
	// A diagnostic never follows a traversal segment out of the fixture root.
	if (/(^|[\\/])\.\.([\\/]|$)/u.test(target)) return false;
	if (!/^[A-Za-z]:[\\/]/u.test(target) && !/^[\\/]{2}/u.test(target)) return false;
	const scope = ownedRootPath.replace(/[\\/]+$/u, "");
	const candidate = target.replace(/[\\/]+$/u, "");
	if (scope.length === 0 || candidate.length < scope.length) return false;
	if (candidate.length === scope.length) return candidate.toUpperCase() === scope.toUpperCase();
	const separator = candidate[scope.length];
	if (separator !== "\\" && separator !== "/") return false;
	return candidate.slice(0, scope.length).toUpperCase() === scope.toUpperCase();
}

/** Pure ASCII request JSON; the path is data on stdin and is never interpolated into the script. */
function encodeRawRequest(path: string): string | null {
	let plain: string;
	try {
		plain = JSON.stringify({ v: RAW_DACL_PROTOCOL, path });
	} catch {
		return null;
	}
	if (plain.length === 0 || plain.length > RAW_DACL_MAX_INPUT_CHARS) return null;
	return plain.replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Independent numeric read of the same fixture's raw DACL, through the fixed
 * system PowerShell and `RawSecurityDescriptor.DiscretionaryAcl`. It does not
 * use the production helper or the typed `GetAccessRules` projection, which is
 * what lets a missing ACE be told apart from a right the helper dropped.
 */
function readRawDaclNumeric(target: string, ownedRootPath: string): RawAclSummary {
	try {
		if (!IS_WINDOWS) return unavailableRaw("platform");
		if (!isInsideOwnedRoot(target, ownedRootPath)) return unavailableRaw("scope");
		const executable = resolveTrustedSystemPowerShell();
		if (typeof executable !== "string" || executable.length === 0) return unavailableRaw("unavailable");
		const input = encodeRawRequest(target);
		if (input === null) return unavailableRaw("scope");
		const child = spawnSync(executable, [...RAW_DACL_ARGS], {
			input,
			encoding: "utf8",
			timeout: RAW_DACL_TIMEOUT_MS,
			maxBuffer: RAW_DACL_MAX_OUTPUT_BYTES,
			cwd: dirname(executable),
			env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: "1" },
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		if (child.status !== 0) return unavailableRaw("unavailable");
		const stdout = typeof child.stdout === "string" ? child.stdout : "";
		if (stdout.length === 0 || stdout.length > RAW_DACL_MAX_OUTPUT_BYTES) return unavailableRaw("unavailable");
		return summarizeRawEvidence(parseJson(stdout));
	} catch {
		return unavailableRaw("unavailable");
	}
}

type SecurityRightVerdict
	= "as-in-helper-and-raw"
	| "as-lost-by-helper"
	| "as-absent-from-descriptor"
	| "as-only-in-helper"
	| "unknown";

/** The classification the `(AS)` case needs: was the ACE absent, or was its bit lost? */
function securityRightVerdict(helper: HelperAclSummary, raw: RawAclSummary): SecurityRightVerdict {
	// Unavailable helper evidence or an unclassified raw ACE cannot establish
	// absence or a lost bit. Report uncertainty rather than inventing a cause.
	if (raw.available === false || helper.available === false || raw.opaqueAcePresent === true
		|| raw.aces?.some((ace) => ace.mask === "none" || ace.mask === "invalid")) return "unknown";
	const rawHas = raw.securityRightPresent === true;
	const helperHas = helper.available === true && (helper.securityRightAces ?? 0) > 0;
	if (rawHas && helperHas) return "as-in-helper-and-raw";
	if (rawHas) return "as-lost-by-helper";
	if (helperHas) return "as-only-in-helper";
	return "as-absent-from-descriptor";
}

/**
 * The production helper seam, recorded without being changed: the same
 * executable, arguments, stdin request, cwd, environment, timeout, and output
 * bound are handed to `spawnSync`, and only the operation, exit status, and
 * whether the response parsed are remembered. No path, request, or response
 * text is retained.
 */
function createRecordingHelperProbe(): {
	probe: { windows: { execute: WindowsAclExecutor } };
	calls: HelperCallRecord[];
	total: () => number;
} {
	const calls: HelperCallRecord[] = [];
	let total = 0;
	const execute: WindowsAclExecutor = (file, args, options) => {
		const child = spawnSync(file, [...args], {
			input: options.input,
			encoding: "utf8",
			timeout: options.timeoutMs,
			maxBuffer: options.maxBufferBytes,
			cwd: options.cwd,
			env: options.env,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout = typeof child.stdout === "string" ? child.stdout : "";
		total += 1;
		if (calls.length >= DIAGNOSTIC_MAX_CALL_RECORDS) calls.shift();
		if (calls.length < DIAGNOSTIC_MAX_CALL_RECORDS) {
			calls.push({ op: helperRequestOp(options.input), status: child.status, responseOk: isHelperResponseText(stdout) });
		}
		return { status: child.status, stdout };
	};
	return { probe: { windows: { execute } }, calls, total: () => total };
}

function helperRequestOp(input: string): string {
	const parsed = parseJson(input);
	if (typeof parsed !== "object" || parsed === null) return "unknown";
	const op = (parsed as Record<string, unknown>).op;
	return op === "inspect" || op === "protect" ? op : "unknown";
}

function isHelperResponseText(stdout: string): boolean {
	if (stdout.length === 0 || stdout.length > DIAGNOSTIC_MAX_RESPONSE_CHARS) return false;
	const parsed = parseJson(stdout);
	if (typeof parsed !== "object" || parsed === null) return false;
	const record = parsed as Record<string, unknown>;
	return record.v === 1 && record.ok === true;
}

type ProtectFailureClass
	= "helper-nonzero-exit"
	| "helper-exit-zero-without-usable-response"
	| "post-protect-verification-rejected"
	| "no-protect-call-issued"
	| "unclassified";

/** Pure so the portable cases can pin the classification without a Windows host. */
function classifyProtectFailure(calls: readonly HelperCallRecord[], after: HelperAclSummary): ProtectFailureClass {
	let protect: HelperCallRecord | undefined;
	for (const call of calls) {
		if (call.op === "protect") protect = call;
	}
	if (protect === undefined) return "no-protect-call-issued";
	if (protect.status !== 0) return "helper-nonzero-exit";
	if (!protect.responseOk) return "helper-exit-zero-without-usable-response";
	if (after.available === true && after.privateDirOk === false) return "post-protect-verification-rejected";
	return "unclassified";
}

/** A line is emitted only if it is short and carries nothing but safe characters. */
function diagnosticIsSafe(label: string, json: string, forbidden: readonly string[]): boolean {
	const line = `${DIAGNOSTIC_PREFIX} ${label} ${json}`;
	if (line.length === 0 || line.length > DIAGNOSTIC_MAX_LINE_CHARS) return false;
	if (!DIAGNOSTIC_SAFE_LABEL.test(label)) return false;
	if (!DIAGNOSTIC_SAFE_PAYLOAD.test(json)) return false;
	if (SID_LEAK.test(line)) return false;
	for (const value of forbidden) {
		if (value.length > 0 && line.includes(value)) return false;
	}
	return true;
}

/** Candidates are tried in order, so a long ACE list costs detail, never the classification. */
function renderDiagnosticLine(label: string, payloads: readonly unknown[], forbidden: readonly string[]): string {
	for (const payload of payloads) {
		let json: unknown;
		try {
			json = JSON.stringify(payload);
		} catch {
			continue;
		}
		if (typeof json !== "string") continue;
		if (diagnosticIsSafe(label, json, forbidden)) return `${DIAGNOSTIC_PREFIX} ${label} ${json}`;
	}
	return DIAGNOSTIC_UNAVAILABLE;
}

function emitDiagnostic(
	t: { diagnostic(message: string): void },
	label: string,
	payloads: readonly unknown[],
	forbidden: readonly string[],
): void {
	let line = DIAGNOSTIC_UNAVAILABLE;
	try {
		line = renderDiagnosticLine(label, payloads, [tmpdir(), process.cwd(), ...forbidden]);
	} catch {
		line = DIAGNOSTIC_UNAVAILABLE;
	}
	try {
		t.diagnostic(line);
	} catch {
		// A diagnostic that cannot be delivered never changes the test result.
	}
}

/**
 * Emitted only from the `catch` of the first positive protect case, immediately
 * before the original error is rethrown unchanged.
 */
function reportProtectFailure(
	t: { diagnostic(message: string): void },
	fixture: { peers: string; root: string; before: HelperAclSummary; helper: ReturnType<typeof createRecordingHelperProbe> },
): void {
	try {
		const after = summarizeHelperAcl(fixture.peers);
		const classification = classifyProtectFailure(fixture.helper.calls, after);
		const calls = { total: fixture.helper.total(), recent: fixture.helper.calls };
		emitDiagnostic(t, "protect-calls", [calls, { total: fixture.helper.total() }, { available: false }], [
			fixture.root,
			fixture.peers,
		]);
		const evidence = {
			classification,
			before: fixture.before,
			after,
			helperReachedDescriptor: after.available === true && after.daclProtected === true,
		};
		emitDiagnostic(
			t,
			"protect-acl",
			[
				evidence,
				{
					classification,
					before: reduceHelperSummary(fixture.before, 2),
					after: reduceHelperSummary(after, 2),
					helperReachedDescriptor: evidence.helperReachedDescriptor,
				},
				{ classification, available: false },
			],
			[fixture.root, fixture.peers],
		);
	} catch {
		emitDiagnostic(t, "protect-failure", [{ available: false }], []);
	}
}

/**
 * Emitted after the `(AS)` grant and before the existing assertions: the
 * helper's numeric view, an independent numeric view of the same raw DACL, and
 * the verdict that separates "the OS never created the ACE" from "the helper
 * lost the bit".
 */
function reportSecurityRightEvidence(
	t: { diagnostic(message: string): void },
	fixture: { target: string; root: string },
): void {
	try {
		const helper = summarizeHelperAcl(fixture.target);
		const raw = readRawDaclNumeric(fixture.target, fixture.root);
		const verdict = securityRightVerdict(helper, raw);
		emitDiagnostic(
			t,
			"as-evidence",
			[
				{ verdict, helper, raw },
				{ verdict, helper: reduceHelperSummary(helper, 2), raw: reduceRawSummary(raw, 2) },
				{ verdict, available: false },
			],
			[fixture.root, fixture.target],
		);
	} catch {
		emitDiagnostic(t, "as-evidence", [{ available: false }], []);
	}
}

test("native: a real owner-controlled parent and a protected private peers directory", { skip: SKIP }, (t) => {
	const root = ownedRoot(t);
	// The production helper seam is recorded, never altered: the real trusted
	// helper still runs with production resolution and semantics, and only the
	// operation and exit status are remembered for the failure diagnostic.
	const helper = createRecordingHelperProbe();
	const policy = createPeerStatePermissionPolicy(helper.probe);
	policy.assertOwnerControlledDirectory(root);

	const peers = join(root, "peers");
	mkdirSync(peers);
	const before = summarizeHelperAcl(peers);
	try {
		policy.protectCreatedDirectory(peers);
	} catch (error) {
		// Bounded evidence of what the helper actually did, then the original
		// fixed error continues unchanged.
		reportProtectFailure(t, { peers, root, before, helper });
		throw error;
	}
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
	// Bounded numeric evidence first: the helper's view, an independent raw-DACL
	// view of the same fixture, and whether the security bit is really there.
	// Nothing below changes the assertions that follow.
	reportSecurityRightEvidence(t, { target: root, root });
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

/* ------------------------------------------------------------------------- *
 * Portable checks for the diagnostic layer. The native proofs above still run
 * only on Windows; these cases exercise the pure formatting, bounding,
 * sanitizing, and classification rules everywhere, so a broken diagnostic is
 * caught on the host that writes it rather than on the one that needs it.
 * ------------------------------------------------------------------------- */

/** A synthetic account SID that must never appear in a rendered diagnostic. */
const FAKE_CURRENT = "S-1-5-21-1111222233-4444555566-7778899";

function syntheticAce(sid: string, rights: number, overrides: Partial<WindowsAclAceEvidence> = {}): WindowsAclAceEvidence {
	return { sid, aceType: "allow", rights, inherit: 3, propagate: 0, inherited: false, ...overrides };
}

function syntheticEvidence(aces: WindowsAclAceEvidence[], overrides: Partial<WindowsAclEvidence> = {}): WindowsAclEvidence {
	return {
		isDirectory: true,
		isReparsePoint: false,
		entryCount: 0,
		fileLength: 0,
		ownerSid: FAKE_CURRENT,
		daclPresent: true,
		daclProtected: true,
		daclAceCount: aces.length,
		daclAllowCount: aces.filter((ace) => ace.aceType === "allow").length,
		daclDenyCount: aces.filter((ace) => ace.aceType === "deny").length,
		daclOtherCount: 0,
		aces,
		parentExists: true,
		parentIsReparsePoint: false,
		...overrides,
	};
}

test("portable diagnostics: helper summaries are numeric, classified, and free of SIDs and paths", () => {
	const summary = summarizeHelperEvidence({
		currentSid: FAKE_CURRENT,
		evidence: syntheticEvidence([
			syntheticAce(FAKE_CURRENT, 0x1000_0000),
			syntheticAce(LOCAL_SYSTEM, 0x001f_01ff),
			syntheticAce(AUTHENTICATED_USERS, 0x0100_0020, { inherit: 3, inherited: true }),
			syntheticAce(EVERYONE, 0x0002_0000, { aceType: "deny" }),
		]),
	});
	assert.equal(summary.available, true);
	assert.equal(summary.ownerMatchesCurrent, true);
	assert.equal(summary.ownerPrincipal, "current");
	assert.equal(summarizeHelperEvidence({
		currentSid: FAKE_CURRENT,
		evidence: syntheticEvidence([], { ownerSid: ADMINISTRATORS }),
	}).ownerPrincipal, "admin");
	assert.equal(summary.securityRightAces, 1);
	assert.equal(summary.enumerationComplete, true);
	assert.deepEqual((summary.aces ?? []).map((ace) => ace.principal), ["current", "system", "authenticated-users", "other"]);
	assert.equal(summary.aces?.[0].rights, "0x10000000");
	assert.equal(summary.aces?.[2].securityRight, true);
	assert.equal(summary.aces?.[2].inherited, true);
	assert.equal(summary.aces?.[3].type, "deny");
	// The production verifier predicates run against the same evidence, so the
	// diagnostic says which proof the descriptor failed.
	assert.equal(summary.ownerControlledOk, false, "an untrusted ACE holding WRITE_DAC refuses the parent");
	const rendered = JSON.stringify(summary);
	assert.ok(!rendered.includes("S-1-"), "a SID must never reach a diagnostic");
	assert.ok(!rendered.includes("/") && !rendered.includes("\\"), "a path must never reach a diagnostic");
});

test("portable diagnostics: an unreadable descriptor is one bounded unavailable marker", () => {
	assert.deepEqual(summarizeHelperEvidence(null), { available: false });
	assert.deepEqual(summarizeRawEvidence(undefined), { available: false, reason: "unavailable" });
});

test("portable diagnostics: ACE detail is bounded and says when it was truncated", () => {
	const many = Array.from({ length: DIAGNOSTIC_MAX_ACE_RECORDS + 4 }, (_unused, index) =>
		syntheticAce(FAKE_CURRENT, 0x001f_01ff, { inherit: index % 4 }),
	);
	const summary = summarizeHelperEvidence({ currentSid: FAKE_CURRENT, evidence: syntheticEvidence(many) });
	assert.equal(summary.aces?.length, DIAGNOSTIC_MAX_ACE_RECORDS);
	assert.equal(summary.acesTruncated, true);
	assert.equal(summary.aceCount, many.length);
	const reduced = reduceHelperSummary(summary, 0);
	assert.equal(reduced.aces?.length, 0);
	assert.equal(reduced.acesTruncated, true);
	assert.equal(reduced.aceCount, summary.aceCount, "reducing detail never loses the counts");
});

test("portable diagnostics: the raw DACL reader is strict, numeric, and never carries native text", () => {
	const summary = summarizeRawEvidence({
		v: 1,
		ok: true,
		c: FAKE_CURRENT,
		o: FAKE_CURRENT,
		k: 4 | 4_096,
		p: true,
		n: 3,
		a: [
			{ t: 0, f: 0, i: false, m: 0x1000_0000, s: FAKE_CURRENT },
			{ t: 0, f: 3, i: true, m: 0x0100_0020, s: AUTHENTICATED_USERS },
			{ t: 9, f: 0, i: false, m: null, s: "" },
		],
	});
	assert.equal(summary.available, true);
	assert.equal(summary.ownerMatchesCurrent, true);
	assert.equal(summary.ownerPrincipal, "current");
	assert.equal(summary.daclPresent, true);
	assert.equal(summary.daclProtected, true);
	assert.equal(summary.securityRightPresent, true);
	assert.equal(summary.aces?.[1].mask, "0x01000020");
	assert.equal(summary.aces?.[1].principal, "authenticated-users");
	assert.equal(summary.aces?.[2].kind, "other");
	assert.equal(summary.aces?.[2].mask, "none");
	assert.equal(JSON.stringify(summary).includes("S-1-"), false);

	for (const malformed of [
		undefined,
		{ v: 2, ok: true },
		{ v: 1, ok: false, c: FAKE_CURRENT, o: FAKE_CURRENT, k: 4, p: true, n: 0, a: [] },
		{ v: 1, ok: true, c: "not-a-sid", o: FAKE_CURRENT, k: 4, p: true, n: 0, a: [] },
		// A DACL enumeration that is short or long by even one ACE is incomplete: an
		// omitted ACE could be the security ACE, so nothing is reported in that case.
		{ v: 1, ok: true, c: FAKE_CURRENT, o: FAKE_CURRENT, k: 4, p: true, n: 2, a: [{ t: 0, f: 0, i: false, m: 1, s: FAKE_CURRENT }] },
		{
			v: 1,
			ok: true,
			c: FAKE_CURRENT,
			o: FAKE_CURRENT,
			k: 4,
			p: true,
			n: 1,
			a: [
				{ t: 0, f: 0, i: false, m: 1, s: FAKE_CURRENT },
				{ t: 0, f: 0, i: false, m: ACCESS_SYSTEM_SECURITY, s: AUTHENTICATED_USERS },
			],
		},
		{ v: 1, ok: true, c: FAKE_CURRENT, o: FAKE_CURRENT, k: 4, p: true, n: 1, a: "not-an-array" },
		{ v: 1, ok: true, c: FAKE_CURRENT, o: FAKE_CURRENT, k: 4, p: true, n: 65, a: [] },
		{ v: 1, ok: true, c: FAKE_CURRENT, o: FAKE_CURRENT, k: 4, p: true, n: 1, a: [{ t: 0, f: 0, i: false, m: 2 ** 32, s: FAKE_CURRENT }] },
		{ v: 1, ok: true, c: FAKE_CURRENT, o: FAKE_CURRENT, k: 4, p: true, n: 1, a: [{ t: 0, f: 0, i: "no", m: 1, s: FAKE_CURRENT }] },
	]) {
		assert.equal(summarizeRawEvidence(malformed).available, false);
	}
});

test("portable diagnostics: the ACCESS_SYSTEM_SECURITY verdict separates a missing ACE from a lost bit", () => {
	const helperWithAs = summarizeHelperEvidence({
		currentSid: FAKE_CURRENT,
		evidence: syntheticEvidence([
			syntheticAce(FAKE_CURRENT, 0x1000_0000),
			syntheticAce(AUTHENTICATED_USERS, ACCESS_SYSTEM_SECURITY, { inherit: 3, inherited: true }),
		]),
	});
	const helperWithoutAs = summarizeHelperEvidence({
		currentSid: FAKE_CURRENT,
		evidence: syntheticEvidence([
			syntheticAce(FAKE_CURRENT, 0x1000_0000),
			syntheticAce(AUTHENTICATED_USERS, 0x0000_0020, { inherit: 3, inherited: true }),
		]),
	});
	const rawWithAs: RawAclSummary = { available: true, securityRightPresent: true };
	const rawWithoutAs: RawAclSummary = { available: true, securityRightPresent: false };
	assert.equal(securityRightVerdict(helperWithAs, rawWithAs), "as-in-helper-and-raw");
	assert.equal(securityRightVerdict(helperWithoutAs, rawWithAs), "as-lost-by-helper");
	assert.equal(securityRightVerdict(helperWithoutAs, rawWithoutAs), "as-absent-from-descriptor");
	assert.equal(securityRightVerdict(helperWithAs, rawWithoutAs), "as-only-in-helper");
	assert.equal(securityRightVerdict(helperWithAs, { available: false, reason: "unavailable" }), "unknown");
	assert.equal(securityRightVerdict({ available: false }, rawWithAs), "unknown");
	assert.equal(securityRightVerdict(helperWithoutAs, {
		available: true,
		securityRightPresent: false,
		aces: [{ kind: "other", aceType: 9, flags: 0, inherited: false, mask: "none", principal: "other", securityRight: false }],
	}), "unknown", "an opaque raw ACE cannot establish absence of the security bit");
	const beyondDisplay = summarizeRawEvidence({
		v: 1, ok: true, c: FAKE_CURRENT, o: ADMINISTRATORS, k: 4, p: true,
		n: DIAGNOSTIC_MAX_ACE_RECORDS + 1,
		a: [
			...Array.from({ length: DIAGNOSTIC_MAX_ACE_RECORDS }, () => ({ t: 0, f: 0, i: false, m: 1, s: FAKE_CURRENT })),
			{ t: 9, f: 0, i: false, m: null, s: "" },
		],
	});
	assert.equal(beyondDisplay.ownerPrincipal, "admin");
	assert.equal(beyondDisplay.aces?.length, DIAGNOSTIC_MAX_ACE_RECORDS);
	assert.equal(beyondDisplay.opaqueAcePresent, true, "uncertainty includes ACEs beyond the displayed slice");
	assert.equal(securityRightVerdict(helperWithoutAs, beyondDisplay), "unknown");
});

test("portable diagnostics: protect failure classification separates helper exit from verifier rejection", () => {
	assert.equal(classifyProtectFailure([], { available: true }), "no-protect-call-issued");
	assert.equal(classifyProtectFailure([{ op: "inspect", status: 0, responseOk: true }], { available: true }), "no-protect-call-issued");
	assert.equal(
		classifyProtectFailure([{ op: "protect", status: 5, responseOk: false }], { available: false }),
		"helper-nonzero-exit",
	);
	assert.equal(
		classifyProtectFailure(
			[{ op: "inspect", status: 0, responseOk: true }, { op: "protect", status: 0, responseOk: false }],
			{ available: false },
		),
		"helper-exit-zero-without-usable-response",
	);
	assert.equal(
		classifyProtectFailure([{ op: "protect", status: null, responseOk: false }], { available: false }),
		"helper-nonzero-exit",
	);
	assert.equal(
		classifyProtectFailure([{ op: "protect", status: 0, responseOk: true }], { available: true, privateDirOk: false }),
		"post-protect-verification-rejected",
	);
	assert.equal(
		classifyProtectFailure([{ op: "protect", status: 0, responseOk: true }], { available: true, privateDirOk: true }),
		"unclassified",
	);
});

test("portable diagnostics: rendered lines are bounded, sanitized, and fall back to the fixed marker", () => {
	const safe = renderDiagnosticLine("protect-calls", [{ total: 3, recent: [{ op: "protect", status: 5, responseOk: false }] }], []);
	const header = `${DIAGNOSTIC_PREFIX} protect-calls `;
	assert.ok(safe.startsWith(header));
	assert.match(safe.slice(header.length), DIAGNOSTIC_SAFE_PAYLOAD);

	// A payload that would carry a SID, a path, or native text is refused whole.
	assert.equal(renderDiagnosticLine("protect-calls", [{ note: `S-1-5-21-4-4-4 at C:\\fixture` }], []), DIAGNOSTIC_UNAVAILABLE);
	assert.equal(renderDiagnosticLine("protect-calls", [{ note: LOCAL_SYSTEM }], []), DIAGNOSTIC_UNAVAILABLE);
	assert.equal(renderDiagnosticLine("protect-calls", [{ note: ADMINISTRATORS }], []), DIAGNOSTIC_UNAVAILABLE);
	assert.equal(renderDiagnosticLine("S-1-5-18", [{ total: 1 }], []), DIAGNOSTIC_UNAVAILABLE);
	assert.equal(renderDiagnosticLine("protect-calls", [{ note: "Access is denied" }], []), DIAGNOSTIC_UNAVAILABLE);
	assert.equal(renderDiagnosticLine("protect-calls", [{ note: "/var/tmp/fixture" }], []), DIAGNOSTIC_UNAVAILABLE);
	assert.equal(renderDiagnosticLine("protect-calls", [{ note: "inside-the-owned-root" }], ["inside-the-owned-root"]), DIAGNOSTIC_UNAVAILABLE);
	assert.equal(renderDiagnosticLine("protect-calls", [{ blob: "x".repeat(DIAGNOSTIC_MAX_LINE_CHARS) }], []), DIAGNOSTIC_UNAVAILABLE);
	assert.equal(renderDiagnosticLine("protect-calls", [undefined], []), DIAGNOSTIC_UNAVAILABLE);

	// Reduced payloads are tried in order, so a long ACE list costs detail and
	// never the classification the parent needs.
	assert.equal(
		renderDiagnosticLine("protect-acl", [{ classification: "helper-nonzero-exit", aces: "x".repeat(2_000) }, { classification: "helper-nonzero-exit" }], []),
		`${DIAGNOSTIC_PREFIX} protect-acl {"classification":"helper-nonzero-exit"}`,
	);

	// A diagnostic that cannot be produced still reaches the reporter as the one
	// fixed marker line, and never throws into the test body.
	const lines: string[] = [];
	emitDiagnostic({ diagnostic: (message) => lines.push(message) }, "as-evidence", [{ note: "C:\\leak" }], []);
	assert.deepEqual(lines, [DIAGNOSTIC_UNAVAILABLE]);
	const exploding = { diagnostic: () => { throw new Error("reporter failed"); } };
	emitDiagnostic(exploding, "as-evidence", [{ verdict: "unknown" }], []);
});

test("portable diagnostics: the raw reader is confined to this file's own fixture root", () => {
	const root = "C:\\Users\\test\\AppData\\Local\\Temp\\prg-peer-acl-AA";
	assert.equal(isInsideOwnedRoot(`${root}\\peers`, root), true);
	assert.equal(isInsideOwnedRoot(root, root), true, "the freshly created root itself is this test's object");
	assert.equal(isInsideOwnedRoot(`${root}\\peers`, `${root}B`), false);
	assert.equal(isInsideOwnedRoot("C:\\Windows\\System32\\config\\SAM", root), false);
	assert.equal(isInsideOwnedRoot(`${root}\\..\\elsewhere`, root), false);
	assert.equal(isInsideOwnedRoot("peers", root), false);
	assert.equal(isInsideOwnedRoot("", root), false);
	assert.equal(isInsideOwnedRoot(`${root}\\x\0y`, root), false);
	assert.equal(isInsideOwnedRoot(`${root}\\${"p".repeat(RAW_DACL_MAX_PATH_CHARS)}`, root), false);
	// The reader is Windows-only: on any other host it reports the platform reason
	// without spawning anything, so a non-Windows run never claims native evidence.
	if (process.platform !== "win32") {
		assert.deepEqual(readRawDaclNumeric(`${root}\\peers`, root), { available: false, reason: "platform" });
	}
	const encoded = encodeRawRequest(`${root}\\h\u00f4te\\peers`) ?? "";
	assert.ok(encoded.length > 0, "a bounded fixture request must encode");
	assert.match(encoded, /^[\u0020-\u007e]*$/u);
	assert.ok(encoded.includes("\\u00f4"), "a non-ASCII code unit must be escaped, never passed through");
	assert.deepEqual(JSON.parse(encoded), { v: RAW_DACL_PROTOCOL, path: `${root}\\h\u00f4te\\peers` });
	assert.equal(encodeRawRequest("p".repeat(RAW_DACL_MAX_INPUT_CHARS)), null);
});

test("portable diagnostics: the recorded helper seam keeps production request semantics", () => {
	assert.equal(helperRequestOp('{"v":1,"op":"protect","path":"C:\\\\peers","kind":"dir"}'), "protect");
	assert.equal(helperRequestOp('{"v":1,"op":"inspect","path":"C:\\\\peers"}'), "inspect");
	assert.equal(helperRequestOp("not json"), "unknown");
	assert.equal(helperRequestOp('{"v":1,"op":"format","path":"C:\\\\peers"}'), "unknown");
	assert.equal(isHelperResponseText('{"v":1,"ok":true}'), true);
	assert.equal(isHelperResponseText("Access is denied"), false);
	assert.equal(isHelperResponseText(""), false);
	assert.equal(isHelperResponseText('{"v":1,"ok":false}'), false);
	assert.equal(isHelperResponseText("x".repeat(DIAGNOSTIC_MAX_RESPONSE_CHARS + 1)), false);
});
