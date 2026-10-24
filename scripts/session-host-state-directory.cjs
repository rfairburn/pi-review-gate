"use strict";

/**
 * Exclusive private creation of the per-agent `session-host` state directory
 * (Refs #494).
 *
 * This is the one dependency-free creator shared by every earliest Node-side
 * creator of `<agentDir>/session-host`: the launcher's coordination entry
 * (`managed-generations.cjs`), the compiled host's state-directory helper
 * (`roster-store.ts`, which the shortcut and diagnostics stores reuse), and the
 * protected Network stores. The native Windows pre-Node wrapper
 * (`pi-review-sessions-node.ps1`) carries the same creation rule inline because
 * it runs before any Node exists.
 *
 * Contract, stated narrowly:
 *
 * - Only a path that is genuinely absent is created, and only by an exclusive
 *   create (`mkdir`, or native `CreateDirectoryW`). Anything already present —
 *   whoever made it, whatever its permissions — is reported as `existing` and is
 *   never inspected for repair, chmod'd, re-ACL'd, re-owned, or deleted here.
 * - The new directory is private at creation: POSIX `mkdir(0700)` (umask can
 *   only narrow it), and on Windows a self-relative descriptor passed to
 *   `CreateDirectoryW` that installs a protected DACL granting only this account,
 *   LocalSystem, and the built-in Administrators alias, owned by this account.
 *   There is no window in which it carries broad inherited grants.
 * - `created-protected` is claimed only after real evidence from the created
 *   object: POSIX no-follow descriptor identity, this account as owner, the exact
 *   `0700` mode, and on macOS an ACL listing with no entries at all; Windows a
 *   handle opened on the reparse point itself (never followed), a non-reparse
 *   directory, this account as owner, and a protected DACL with exactly the three
 *   trusted full-control grants. Anything less is `created-unverified`: the
 *   directory exists and stays as created, but no protection is claimed. The
 *   creator never modifies an object after creating it: `mkdir` yields no object
 *   receipt, so a corrective chmod could land on a swapped-in pre-existing
 *   directory.
 * - `failed` means nothing was created by this call; callers that must keep their
 *   local behaviour unchanged fall back to their previous plain creation.
 * - Ancestors are out of scope and never modified. A broadly writable parent can
 *   still rename or delete the new directory (availability), which identity
 *   fences in the stores detect; it cannot read or write inside it.
 *
 * Outcomes and reasons are fixed strings: no path, errno, SID, or native output
 * ever leaves this module.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_PATH_LENGTH = 2000;
const HELPER_PROTOCOL = 1;
const HELPER_TIMEOUT_MS = 15000;
const HELPER_MAX_OUTPUT_BYTES = 16 * 1024;
const ACL_TIMEOUT_MS = 5000;
const ACL_MAX_OUTPUT_BYTES = 64 * 1024;
const ACL_TOOL_CANDIDATES = ["/bin/ls", "/usr/bin/ls"];

/** Fixed outcome vocabulary. */
const OUTCOME = Object.freeze({
  existing: "existing",
  protected: "created-protected",
  unverified: "created-unverified",
  failed: "failed",
});

function result(outcome, reason) {
  return Object.freeze(reason === undefined ? { outcome } : { outcome, reason });
}

/**
 * The one fixed Windows helper script. The path travels only as escaped-ASCII
 * JSON on stdin; nothing is interpolated into the script text. It creates the
 * directory with a secure-at-creation descriptor, then proves the result through
 * a handle opened with FILE_FLAG_OPEN_REPARSE_POINT so a reparse point is never
 * followed. It never edits an existing object's security.
 */
const WINDOWS_CREATE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  try { [Console]::InputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false } catch { }
  $raw = [Console]::In.ReadToEnd()
  if ($raw.Length -eq 0 -or $raw.Length -gt 8192) { exit 2 }
  $req = $raw | ConvertFrom-Json
  if ($req.v -ne ${HELPER_PROTOCOL}) { exit 2 }
  $path = [string]$req.path
  if ($path.Length -eq 0 -or $path.Length -gt ${MAX_PATH_LENGTH} -or -not [System.IO.Path]::IsPathRooted($path)) { exit 2 }
  $name = New-Object Reflection.AssemblyName 'PiReviewGateStateDirectory'
  if ($PSVersionTable.PSEdition -eq 'Core') {
    $assembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($name, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  } else {
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  }
  $module = $assembly.DefineDynamicModule('Native')
  $builder = $module.DefineType('PiReviewGateStateDirectoryNative', [Reflection.TypeAttributes]'Public, Sealed, Abstract')
  $attributes = [Reflection.MethodAttributes]'Public, Static, PinvokeImpl'
  foreach ($definition in @(
    @('CreateDirectoryW', [bool], [Type[]]@([string], [IntPtr])),
    @('CreateFileW', [IntPtr], [Type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr])),
    @('GetFileInformationByHandle', [bool], [Type[]]@([IntPtr], [IntPtr])),
    @('CloseHandle', [bool], [Type[]]@([IntPtr]))
  )) {
    $method = $builder.DefinePInvokeMethod($definition[0], 'kernel32.dll', $attributes, [Reflection.CallingConventions]::Standard, $definition[1], $definition[2], [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  }
  $native = $builder.CreateType()
  $current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  # Owner is this account; the DACL is protected (no inherited broadening) and
  # grants full control, inheritable to new children, to exactly this account,
  # LocalSystem, and the built-in Administrators alias.
  $sddl = 'O:' + $current + 'D:P(A;OICI;FA;;;' + $current + ')(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'
  $descriptor = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl)
  $bytes = New-Object byte[] $descriptor.BinaryLength
  $descriptor.GetBinaryForm($bytes, 0)
  $sd = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  $saSize = 12
  if ([IntPtr]::Size -eq 8) { $saSize = 24 }
  $sa = [Runtime.InteropServices.Marshal]::AllocHGlobal($saSize)
  $created = $false
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $sd, $bytes.Length)
    # SECURITY_ATTRIBUTES { DWORD nLength; LPVOID lpSecurityDescriptor; BOOL bInheritHandle; }
    [Runtime.InteropServices.Marshal]::WriteInt32($sa, 0, $saSize)
    [Runtime.InteropServices.Marshal]::WriteIntPtr($sa, [IntPtr]::Size, $sd)
    [Runtime.InteropServices.Marshal]::WriteInt32($sa, 2 * [IntPtr]::Size, 0)
    # CreateDirectoryW is exclusive: it fails for any existing name, which is then
    # reported as existing and left untouched.
    $created = $native::CreateDirectoryW($path, $sa)
  } finally {
    [Runtime.InteropServices.Marshal]::FreeHGlobal($sa)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($sd)
  }
  if (-not $created) {
    $exists = $false
    try { [void][System.IO.File]::GetAttributes($path); $exists = $true } catch { $exists = $false }
    if ($exists) { [Console]::Out.Write('{"v":${HELPER_PROTOCOL},"outcome":"existing"}'); exit 0 }
    exit 3
  }
  $verdict = 'unverified'
  # READ_ATTRIBUTES | READ_CONTROL; BACKUP_SEMANTICS | OPEN_REPARSE_POINT.
  $handle = $native::CreateFileW($path, 0x20080, 7, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
  if ($handle -ne [IntPtr]::new(-1)) {
    $info = [Runtime.InteropServices.Marshal]::AllocHGlobal(52)
    try {
      if ($native::GetFileInformationByHandle($handle, $info)) {
        $nativeAttributes = [Runtime.InteropServices.Marshal]::ReadInt32($info, 0)
        if (($nativeAttributes -band 0x400) -eq 0 -and ($nativeAttributes -band 0x10) -ne 0) {
          $security = (New-Object System.IO.DirectoryInfo($path)).GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner)
          $observed = New-Object System.Security.AccessControl.RawSecurityDescriptor($security.GetSecurityDescriptorBinaryForm(), 0)
          $flags = [int]$observed.ControlFlags
          $ok = ($observed.Owner.Value -eq $current) -and (($flags -band 4) -ne 0) -and (($flags -band 4096) -ne 0) -and ($null -ne $observed.DiscretionaryAcl)
          $seen = @{}
          if ($ok) {
            foreach ($ace in $observed.DiscretionaryAcl) {
              if ([int]$ace.AceType -ne 0) { $ok = $false; break }
              $sid = $ace.SecurityIdentifier.Value
              if (($sid -ne $current -and $sid -ne 'S-1-5-18' -and $sid -ne 'S-1-5-32-544') -or ($ace.AccessMask -band 0x1F01FF) -ne 0x1F01FF) { $ok = $false; break }
              $seen[$sid] = $true
            }
          }
          if ($ok -and $seen.Count -eq 3 -and $observed.DiscretionaryAcl.Count -eq 3) { $verdict = 'protected' }
        }
      }
    } finally {
      [Runtime.InteropServices.Marshal]::FreeHGlobal($info)
      [void]$native::CloseHandle($handle)
    }
  }
  if ($verdict -eq 'protected') { [Console]::Out.Write('{"v":${HELPER_PROTOCOL},"outcome":"created-protected"}') }
  else { [Console]::Out.Write('{"v":${HELPER_PROTOCOL},"outcome":"created-unverified"}') }
  exit 0
} catch {
  exit 3
}
`;

const WINDOWS_CREATE_ENCODED = Buffer.from(WINDOWS_CREATE_SCRIPT, "utf16le").toString("base64");

/** Fixed system PowerShell from the inherited system root; never a PATH lookup. */
function resolveSystemPowerShell() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return null;
  const candidate = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function productionSpawn(file, args, options) {
  const child = spawnSync(file, args, {
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxBufferBytes,
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });
  return { status: child.status, stdout: typeof child.stdout === "string" ? child.stdout : "" };
}

/** Escape every non-ASCII code unit so the console codepage can never alter the path. */
function encodeRequest(request) {
  return JSON.stringify(request).replace(/[\u007f-\uffff]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function pathIsPresent(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function createWindows(target, probe) {
  const executable = (probe.resolvePowerShell || resolveSystemPowerShell)();
  if (typeof executable !== "string" || executable.length === 0) return result(OUTCOME.failed, "protection-unsupported");
  const spawn = probe.spawn || productionSpawn;
  let child;
  try {
    child = spawn(
      executable,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", WINDOWS_CREATE_ENCODED],
      {
        input: encodeRequest({ v: HELPER_PROTOCOL, path: target }),
        timeoutMs: HELPER_TIMEOUT_MS,
        maxBufferBytes: HELPER_MAX_OUTPUT_BYTES,
        cwd: path.win32.dirname(executable),
        env: { ...process.env, POWERSHELL_TELEMETRY_OPTOUT: "1" },
      },
    );
  } catch {
    child = null;
  }
  let parsed = null;
  if (child && child.status === 0 && typeof child.stdout === "string" && child.stdout.length <= HELPER_MAX_OUTPUT_BYTES) {
    try {
      parsed = JSON.parse(child.stdout);
    } catch {
      parsed = null;
    }
  }
  if (parsed && parsed.v === HELPER_PROTOCOL) {
    if (parsed.outcome === OUTCOME.existing) return result(OUTCOME.existing);
    if (parsed.outcome === OUTCOME.protected) return result(OUTCOME.protected);
    if (parsed.outcome === OUTCOME.unverified) return result(OUTCOME.unverified, "unsafe-permissions");
  }
  // The helper did not report: whatever now exists is not claimed protected.
  // An object that appeared may be ours or a concurrent creator's; either way it
  // is left untouched and no protection is claimed for it.
  if (pathIsPresent(target)) return result(OUTCOME.unverified, "protection-unsupported");
  return result(OUTCOME.failed, "protection-unsupported");
}

function resolveAclTool() {
  for (const candidate of ACL_TOOL_CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next fixed location.
    }
  }
  return null;
}

function productionAclList(tool, target) {
  const child = spawnSync(tool, ["-lde", target], {
    encoding: "utf8",
    timeout: ACL_TIMEOUT_MS,
    maxBuffer: ACL_MAX_OUTPUT_BYTES,
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { status: child.status, stdout: typeof child.stdout === "string" ? child.stdout : "" };
}

/**
 * macOS can attach inherited extended ACL entries to a fresh directory, and
 * `fchmod` never removes them. The creator claims protection only for a listing
 * that shows no ACL at all; any entry, marker, or unreadable listing is
 * `extended-acl`/unverified. The full ACL classification belongs to the
 * permission policy that the Network stores consult on every open.
 */
function darwinHasNoAcl(target, probe) {
  const tool = (probe.resolveAclTool || resolveAclTool)();
  if (typeof tool !== "string" || tool.length === 0) return false;
  let child;
  try {
    child = (probe.aclList || productionAclList)(tool, target);
  } catch {
    return false;
  }
  if (!child || child.status !== 0 || typeof child.stdout !== "string") return false;
  const lines = child.stdout.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length !== 1) return false;
  const mode = lines[0].trim().split(/\s+/u)[0] || "";
  return /^d[rwxsStT-]{9}@?$/u.test(mode);
}

function createPosix(target, platform, probe) {
  try {
    fs.mkdirSync(target, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error && error.code === "EEXIST") return result(OUTCOME.existing);
    return result(OUTCOME.failed, error && (error.code === "EACCES" || error.code === "EPERM") ? "unreadable" : "unsafe-object");
  }
  // Test seam only: runs between the exclusive create and the first observation,
  // where a pathname swap would land in production.
  if (typeof probe.afterCreate === "function") probe.afterCreate(target);
  if (typeof process.getuid !== "function") return result(OUTCOME.unverified, "protection-unsupported");
  let fd = -1;
  try {
    const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    fd = fs.openSync(target, flags);
    const opened = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(target, { bigint: true });
    if (!opened.isDirectory() || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino) {
      return result(OUTCOME.unverified, "changed");
    }
    // Only this account can have made an object it owns; anything else was
    // swapped in and is left untouched.
    if (Number(opened.uid) !== process.getuid()) return result(OUTCOME.unverified, "foreign-owner");
    if (fs.readdirSync(target).length !== 0) return result(OUTCOME.unverified, "changed");
    // `mkdir` returns no object receipt, so these observations cannot prove that
    // the object now at the path is the one this call created: under a broadly
    // writable parent another account could have swapped in an existing empty
    // directory this account owns. Nothing is ever modified on that basis. An
    // unexpected mode (for example a setgid parent's inherited bit, or an
    // unusual umask) is reported as unverified and left exactly as it is.
    if ((Number(opened.mode) & 0o7777) !== PRIVATE_DIRECTORY_MODE) return result(OUTCOME.unverified, "unsafe-permissions");
  } catch {
    return result(OUTCOME.unverified, "changed");
  } finally {
    if (fd >= 0) {
      try {
        fs.closeSync(fd);
      } catch {
        // The descriptor was only an identity fence.
      }
    }
  }
  if (platform === "darwin") {
    if (!darwinHasNoAcl(target, probe)) return result(OUTCOME.unverified, "extended-acl");
  } else if (platform !== "linux") {
    // Linux POSIX ACL effective rights are capped by the mode's group (mask)
    // bits, so an exact 0700 is owner-only. Other systems' ACL dialects are not
    // verified here and protection is not claimed.
    return result(OUTCOME.unverified, "protection-unsupported");
  }
  return result(OUTCOME.protected);
}

/**
 * Create `stateDir` exclusively and privately when it is absent.
 *
 * @param {string} stateDir absolute path of `<agentDir>/session-host`
 * @param {object} [probe] test seams only: `platform`, `spawn`,
 *   `resolvePowerShell`, `resolveAclTool`, `aclList`. Production passes nothing.
 * @returns {{ outcome: "existing" | "created-protected" | "created-unverified" | "failed", reason?: string }}
 */
function createPrivateStateDirectory(stateDir, probe = {}) {
  const platform = probe.platform || process.platform;
  const isAbsolute = platform === "win32" ? path.win32.isAbsolute : path.posix.isAbsolute;
  if (typeof stateDir !== "string" || stateDir.length === 0 || stateDir.length > MAX_PATH_LENGTH || !isAbsolute(stateDir)) {
    return result(OUTCOME.failed, "unsafe-object");
  }
  try {
    fs.lstatSync(stateDir);
    return result(OUTCOME.existing);
  } catch (error) {
    if (!error || error.code !== "ENOENT") return result(OUTCOME.failed, "unreadable");
  }
  if (platform === "win32") return createWindows(stateDir, probe);
  return createPosix(stateDir, platform, probe);
}

module.exports = {
  createPrivateStateDirectory,
  STATE_DIRECTORY_OUTCOME: OUTCOME,
  stateDirectoryInternals: { WINDOWS_CREATE_SCRIPT, WINDOWS_CREATE_ENCODED, darwinHasNoAcl },
};
