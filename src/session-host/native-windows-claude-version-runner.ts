/**
 * #682: Windows exact-image `--version` runner for the Windows Claude version
 * probe (./native-windows-claude-version-probe).
 *
 * ## What this module is
 *
 * The one {@linkcode WindowsExactImageVersionRunner} implementation the probe's
 * seam describes. Its one product composition is
 * ./native-windows-claude-host-composition, which builds it over the trusted
 * System32 Windows PowerShell 5.1 resolver for the native CLI launcher's
 * explicitly requested, otherwise eligible Windows Claude version probe; with
 * no trusted PowerShell no runner exists and nothing is started. It changes no
 * manager, custody, hook, inbox, callback, endpoint, settings, or other
 * platform behavior. This exact script was observed on real Windows (stock
 * PowerShell 5.1, helper-only `USERPROFILE`) before wiring; the portable tests
 * below do not run it.
 *
 * ## Mechanism (documented stock components only)
 *
 * Node spawns the caller-supplied, shape-validated System32 Windows PowerShell
 * 5.1 executable directly (no shell, hidden, not detached, private pipes,
 * allowlisted environment plus the helper-only `USERPROFILE` below) with a
 * short fixed `-NoProfile` `-EncodedCommand` bootstrap. The
 * bootstrap refuses anything but FullLanguage, reads exactly one framed source
 * from its private stdin, pins its length and SHA-256 against values compiled
 * into the bootstrap, and dot-sources it (the reviewed custody-supervisor
 * framing). The source defines its kernel32 P/Invoke table IN MEMORY
 * (Reflection.Emit: no Add-Type, no compiler, no file, no ntdll, no installed
 * helper binary) and then, inside one monotonic window synchronized to the
 * probe's deadline:
 *
 * 1. Refuses unless the admitted drive root is a local volume (`GetDriveTypeW`:
 *    removable, fixed, optical, or RAM disk; never remote, unknown, or
 *    invalid), so the handle protections below apply to a local file system.
 *    Then opens every ancestor directory of the target without following reparse
 *    points and WITHOUT delete sharing (so none can be renamed or removed while
 *    held), and opens the target itself the same way with read-only sharing
 *    (so it cannot be written, renamed, or removed while held). Each held
 *    handle must be a non-reparse directory/file whose volume serial, file id,
 *    creation time and (for the target) size, last-write and change time equal
 *    the identities the probe observed. The target's NT path is taken from the
 *    held handle (`GetFinalPathNameByHandleW`, opened name, NT volume form).
 * 2. Creates an owned job with `KILL_ON_JOB_CLOSE` and no breakaway limit, three
 *    private anonymous pipes (stdin's write end closed at once, so the child
 *    sees EOF), and marks only the three child ends inheritable.
 * 3. Calls `CreateProcessW` with the explicit application name (no search, no
 *    extension or shell fallback), the fixed command line `"<file>" --version`,
 *    the fixed cwd, the allowlisted Unicode environment block,
 *    `CREATE_SUSPENDED | CREATE_NO_WINDOW`, `STARTF_USESTDHANDLES`, a
 *    `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` naming exactly those three child ends
 *    (so no other inheritable handle, in particular the runner's own stdio,
 *    reaches the child), and a `PROC_THREAD_ATTRIBUTE_JOB_LIST` naming the
 *    owned job, so the child is a job member from creation: if the runner dies
 *    at any later point, closing its last job handle kills the child. Without
 *    atomic assignment (before Windows 10, or the attribute refused) nothing
 *    is created.
 * 4. BEFORE `ResumeThread`, using only the exact process handle that call
 *    returned (never a PID): confirms job membership with `IsProcessInJob`;
 *    requires the native image name
 *    from that handle (`QueryFullProcessImageNameW`, `PROCESS_NAME_NATIVE`) to
 *    equal the protected file's NT path exactly; rechecks every held handle's
 *    identity and the target's NT path; rechecks the deadline. Any failure
 *    terminates the never-resumed child and reports it as such. Only a
 *    previous suspend count of exactly 1 counts as a resume.
 * 5. Captures stdout and stderr under one combined byte cap and the run
 *    deadline, then always terminates the job, observes the exact process
 *    handle's exit, witnesses the job empty from the kernel's own accounting
 *    and process-list queries on the owned job handle, drains both pipes to a
 *    successful EOF (a failed read is not EOF), and closes every handle it
 *    owns, checking each close, all within `min(settle, deadline) + cleanupMs`;
 *    a teardown that finishes late is unsettled.
 *
 * The runner reports ONE closed stdout record; Node accepts it only with the
 * matching per-run nonce, the matching runner exit code, nothing else on
 * stdout, a closed runner process (`close`: exited and stdio released) whose
 * stdout reached EOF without error, and a `close` observed strictly before
 * the final deadline.
 * Anything else is `not-created` only when nothing can have been started
 * (spawn error before `spawn`, a refusal before `CreateProcessW` succeeded, or
 * a bootstrap refusal), and otherwise `unsettled` or `spawn-uncertain`.
 *
 * ## Helper environment versus target environment
 *
 * Observed on Windows PowerShell 5.1: with `USERPROFILE` blank, PowerShell
 * itself exits `0xFFFF0000` before running even a one-line fixed command;
 * restoring only `USERPROFILE` from the host environment lets it start
 * (`HOMEDRIVE`, `HOMEPATH`, a stock module path, or the standard AppData
 * directories alone do not). The PowerShell HELPER process therefore receives
 * the exact allowlisted environment with just `USERPROFILE` set to the
 * caller's own same-user host value (Node: `process.env.USERPROFILE`, read per
 * run, shape-validated as a drive-absolute path, never read from disk
 * or profile data); it still runs `-NoProfile`. A missing or malformed value
 * refuses the run before anything is spawned (`not-created`). The exact
 * `CreateProcessW` TARGET environment is unchanged: the rendered Unicode
 * block is still exactly the probe's allowlist, with `USERPROFILE` and every
 * other home/profile name empty.
 *
 * ## Trust boundary (approved) and accepted limitation
 *
 * The check is the documented suspended-image check at the existing same-user
 * trust boundary. It protects and rechecks the exact local executable and its
 * cwd/ancestor handles and requires the suspended child's native image name to
 * match the protected file's NT path before the child runs. It does NOT
 * independently verify the child's working directory (it passes the held
 * directory's path; the held handles only keep that path bound), and it does
 * NOT sandbox or defend against an attacker running as the same user, who can
 * open, inspect, or manipulate the runner and the child directly. No stronger
 * same-user guarantee is claimed.
 *
 * Residual facts the portable tests do NOT prove (stated, not claimed): that
 * this exact script parses and runs on stock Windows PowerShell 5.1; that the
 * opened-name NT path and the native process image name agree for the target
 * volumes; that libuv's `dev`/`ino`/time fields equal the handle-derived values
 * compared here; and that Node's monotonic clock and PowerShell's `Stopwatch`
 * read the same performance counter. Each mismatch fails closed.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

import { validatePowerShellPath } from "./native-windows-claude-custody-scripts";
import {
  WINDOWS_CLAUDE_VERSION_ARGS,
  WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS,
  WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES,
  WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS,
  buildWindowsClaudeVersionEnvironment,
  windowsClaudeTargetAncestors,
  type WindowsDirectVersionRunBounds,
  type WindowsDirectVersionRunKind,
  type WindowsDirectVersionRunReceipt,
  type WindowsExactImageRunSpec,
  type WindowsExactImageVersionRunner,
  type WindowsExpectedDirectory,
} from "./native-windows-claude-version-probe";

/* --------------------------------------------------------------- constants */

/** Exit-code base of the runner's reserved range ("PRJ\0"). */
export const WINDOWS_CLAUDE_VERSION_RUNNER_FAIL_BASE = 0x5052_4a00;

/** Runner exit codes paired with each closed record. */
export const WINDOWS_CLAUDE_VERSION_RUNNER_EXIT: Readonly<Record<string, number>> = Object.freeze({
  exited: 0,
  "not-created": WINDOWS_CLAUDE_VERSION_RUNNER_FAIL_BASE + 1,
  "terminated-before-resume": WINDOWS_CLAUDE_VERSION_RUNNER_FAIL_BASE + 2,
  unsettled: WINDOWS_CLAUDE_VERSION_RUNNER_FAIL_BASE + 3,
});

/** Bootstrap refusals (no source ran, so no child exists): BASE + 50..59. */
export const WINDOWS_CLAUDE_VERSION_RUNNER_BOOT_FAIL_MIN = WINDOWS_CLAUDE_VERSION_RUNNER_FAIL_BASE + 50;
export const WINDOWS_CLAUDE_VERSION_RUNNER_BOOT_FAIL_MAX = WINDOWS_CLAUDE_VERSION_RUNNER_FAIL_BASE + 59;

/** Exit code the runner gives job members it terminates. */
export const WINDOWS_CLAUDE_VERSION_RUNNER_TERMINATE_CODE = WINDOWS_CLAUDE_VERSION_RUNNER_FAIL_BASE + 0x30;

/** Largest accepted runner stdout (one record carrying at most the probe's byte cap in base64). */
export const WINDOWS_CLAUDE_VERSION_RUNNER_MAX_STDOUT_BYTES = 16 * 1024;

/** Startup frame magic, followed by 8 decimal digits and `\n`. */
export const WINDOWS_CLAUDE_VERSION_RUNNER_BOOT_MAGIC = "PRG-WVR1 ";
const BOOT_LENGTH_DIGITS = 8;
const BOOT_HEADER_BYTES = WINDOWS_CLAUDE_VERSION_RUNNER_BOOT_MAGIC.length + BOOT_LENGTH_DIGITS + 1;
const MAX_SOURCE_BYTES = 64 * 1024;
/** Bootstrap written → startup frame read (runner-side). */
const STARTUP_FRAME_MS = WINDOWS_CLAUDE_VERSION_PROBE_TIMEOUT_MS;
/** Measured supervisor bound for `-EncodedCommand` command lines (see the custody renderer). */
export const WINDOWS_CLAUDE_VERSION_RUNNER_MAX_COMMAND_LINE = 8_192;

/** FILETIME of the Unix epoch, in 100 ns ticks. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const I64_MAX = 0x7fff_ffff_ffff_ffffn;
const NONCE_PATTERN = /^[0-9a-f]{32}$/u;
/** Longest admitted helper `USERPROFILE` (below `MAX_PATH`, as the probe's allowlisted paths). */
const MAX_HELPER_PROFILE_CHARS = 259;
/** One path component: no control, wildcard, separator, quote, or stream characters. */
const PROFILE_COMPONENT = String.raw`[^\u0000-\u001f"<>|?*\\/:]+`;
const HELPER_PROFILE_PATTERN = new RegExp(String.raw`^[A-Za-z]:(?:\\${PROFILE_COMPONENT})+$`, "u");
const HELPER_PROFILE_LONE_SURROGATE = /[\uD800-\uDFFF]/u;
/** Windows reserved device names (with or without an extension), as the probe's component check. */
const HELPER_PROFILE_RESERVED_DEVICE_STEM = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|(?:com|lpt)[0-9\u00b9\u00b2\u00b3])$/iu;

/**
 * True for a component Win32 would silently normalize (a trailing period or
 * space, which also covers `.` and `..`) or whose stem is a reserved device name.
 */
function invalidHelperProfileComponent(part: string): boolean {
  if (part.endsWith(".") || part.endsWith(" ")) return true;
  return HELPER_PROFILE_RESERVED_DEVICE_STEM.test(part.split(".")[0]!.replace(/ +$/u, ""));
}

/**
 * How Node spawns the runner: private anonymous pipes, hidden, NOT detached
 * (a detached PowerShell was measured to exit silently), never through a shell.
 */
export const WINDOWS_CLAUDE_VERSION_RUNNER_SPAWN_OPTIONS = Object.freeze({
  stdio: Object.freeze(["pipe", "pipe", "pipe"] as const),
  windowsHide: true as const,
  detached: false as const,
  shell: false as const,
});

/* ------------------------------------------------------------------ scripts */

/**
 * Fixed command-line bootstrap. Placeholders are decimal integers and the
 * source SHA-256. ConstrainedLanguage exits before any .NET call; no byte is
 * ever written to stdout here.
 */
export const WINDOWS_CLAUDE_VERSION_RUNNER_BOOTSTRAP_TEMPLATE = String.raw`
$ErrorActionPreference='Stop'
if($ExecutionContext.SessionState.LanguageMode -cne 'FullLanguage'){exit __LANG_EXIT__}
function VrBootFail([int]$code){exit (__FAIL_BASE__+$code)}
$VrBlock=$null
try{
$BootEnc=[Text.UTF8Encoding]::new($false)
$BootIn=[IO.StreamReader]::new([Console]::OpenStandardInput(),$BootEnc,$false,4096)
$BootClock=[Diagnostics.Stopwatch]::StartNew()
$BootHead=[char[]]::new(__HEAD_LEN__);$BootTask=$BootIn.ReadBlockAsync($BootHead,0,__HEAD_LEN__)
if(-not $BootTask.Wait(__FRAME_MS__)){VrBootFail 51}
if($BootTask.Result -ne __HEAD_LEN__){VrBootFail 52}
$BootM=[regex]::Match([string]::new($BootHead),'^PRG-WVR1 ([0-9]{8})\n$')
if(-not $BootM.Success){VrBootFail 53}
$BootLen=[int]$BootM.Groups[1].Value
if($BootLen -gt __MAX_SRC__){VrBootFail 54}
if($BootLen -ne __SRC_LEN__){VrBootFail 55}
$BootLeft=[int](__FRAME_MS__-$BootClock.ElapsedMilliseconds)
if($BootLeft -le 0){VrBootFail 51}
$BootSrc=[char[]]::new($BootLen);$BootTask=$BootIn.ReadBlockAsync($BootSrc,0,$BootLen)
if(-not $BootTask.Wait($BootLeft)){VrBootFail 51}
if($BootTask.Result -ne $BootLen){VrBootFail 56}
$BootText=[string]::new($BootSrc)
$BootSha=[Security.Cryptography.SHA256]::Create()
if((-join($BootSha.ComputeHash($BootEnc.GetBytes($BootText))|%{$_.ToString('x2')})) -cne '__SRC_SHA__'){VrBootFail 57}
try{$VrBlock=[ScriptBlock]::Create($BootText)}catch{VrBootFail 58}
}catch{VrBootFail 59}
if($null -eq $VrBlock){VrBootFail 59}
$BootText=$null;$BootSrc=$null
. $VrBlock
`;

/**
 * The runner body; travels only as the startup frame. Every string datum is
 * base64 UTF-16LE (so the source stays ASCII and nothing is quoted); identity
 * values are decimal strings compared ordinally. PowerShell 5.1 syntax only;
 * no backticks, no `${...}`, no cmdlets, every statement value is consumed, and
 * stdout carries only the one record written by `VrEmit`.
 */
export const WINDOWS_CLAUDE_VERSION_RUNNER_SOURCE_TEMPLATE = String.raw`
$ErrorActionPreference='Stop'
$Nonce='__NONCE__';$FailBase=__FAIL_BASE__;$Z=[IntPtr]::Zero
$Maybe=$false;$Created=$false;$Trapped=$false;$CloseFail=$false;$Job=$Z;$HProc=$Z;$HThread=$Z;$OutSt=$null;$ErrSt=$null
$Owned=[Collections.Generic.List[IntPtr]]::new();$Mem=[Collections.Generic.List[IntPtr]]::new()
$Clock=[Diagnostics.Stopwatch]::StartNew();$Freq=[double][Diagnostics.Stopwatch]::Frequency
$RunEnd=[double]'__DEADLINE_MS__'
$VrOut=[Console]::OpenStandardOutput()
function VrNow{[double][Diagnostics.Stopwatch]::GetTimestamp()/$Freq*1000.0}
function VrLeft([double]$end){$ms=[Math]::Floor($end-(VrNow));if($ms -le 0){return 0};[int][Math]::Min($ms,600000)}
function VrEmit([string]$line,[int]$code){$b=[Text.Encoding]::ASCII.GetBytes('PRG-WVR1 '+$Nonce+' '+$line+[char]10);try{$VrOut.Write($b,0,$b.Length);$VrOut.Flush()}catch{};exit $code}
function VrNotCreated([string]$stage){VrEmit ('NOTCREATED '+$stage) ($FailBase+1)}
function VrS([string]$b){[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($b))}
function VrW([string]$s){,([Text.Encoding]::Unicode.GetBytes($s+[char]0))}
function VrClose([IntPtr]$h){[void]$Owned.Remove($h);return $K::CloseHandle($h)}
function VrFacts([IntPtr]$h){try{$b=[byte[]]::new(52);if(-not $K::GetFileInformationByHandle($h,$b)){return $null};$x=[byte[]]::new(40);if(-not $K::GetFileInformationByHandleEx($h,0,$x,40)){return $null};$y=[byte[]]::new(24);$w=$null;if($K::GetFileInformationByHandleEx($h,18,$y,24)){$w=[string][BitConverter]::ToUInt64($y,0)};@{A=[BitConverter]::ToUInt32($b,0);V=[string][BitConverter]::ToUInt32($b,28);W=$w;S=[string](([uint64][BitConverter]::ToUInt32($b,32) -shl 32) -bor [uint64][BitConverter]::ToUInt32($b,36));I=[string](([uint64][BitConverter]::ToUInt32($b,44) -shl 32) -bor [uint64][BitConverter]::ToUInt32($b,48));B=[string][BitConverter]::ToInt64($b,4);M=[string][BitConverter]::ToInt64($b,20);C=[string][BitConverter]::ToInt64($x,24)}}catch{return $null}}
function VrDirOk($f,[string]$v,[string]$i,[string]$c){$null -ne $f -and ($f.A -band 0x10) -ne 0 -and ($f.A -band 0x400) -eq 0 -and ($f.V -ceq $v -or $f.W -ceq $v) -and $f.I -ceq $i -and $f.B -ceq $c}
function VrImgOk($f){$null -ne $f -and ($f.A -band 0x410) -eq 0 -and ($f.V -ceq $ImgV -or $f.W -ceq $ImgV) -and $f.I -ceq $ImgI -and $f.S -ceq $ImgS -and $f.M -ceq $ImgM -and $f.C -ceq $ImgC -and $f.B -ceq $ImgB}
function VrFinal([IntPtr]$h){try{$nb=[byte[]]::new(2048);$n=$K::GetFinalPathNameByHandleW($h,$nb,1024,0xA);if($n -le 0 -or $n -ge 1024){return $null};[Text.Encoding]::Unicode.GetString($nb,0,$n*2)}catch{return $null}}
function VrDrain($st,[double]$end){
if($null -eq $st){return $true}
try{
while(-not $st.Eof){
if((VrLeft $end) -le 0){return $false}
if($null -eq $st.Task){$st.Task=$st.Fs.ReadAsync($st.Buf,0,$st.Buf.Length)}
if(-not $st.Task.IsCompleted){[void]$st.Task.Wait((VrLeft $end))}
if($st.Task.Status -ne 'RanToCompletion'){return $false}
if($st.Task.Result -eq 0){$st.Eof=$true}else{$st.Task=$null}
}
$st.Fs.Dispose()
}catch{return $false};$true}
function VrTeardown([double]$settledAt=(VrNow)){$CleanEnd=[Math]::Min($settledAt,$RunEnd)+__CLEANUP_MS__;$ok=$true;try{
if($HProc -ne $Z){[void]$K::TerminateProcess($HProc,__TERM_CODE__)}
if($Job -ne $Z){[void]$K::TerminateJobObject($Job,__TERM_CODE__)}
if($HProc -eq $Z -or $K::WaitForSingleObject($HProc,(VrLeft $CleanEnd)) -ne 0){$ok=$false}
$acct=[byte[]]::new(48);$ids=[byte[]]::new(8200);$empty=$false
while($Job -ne $Z){if($K::QueryInformationJobObject($Job,1,$acct,48,$Z) -and $K::QueryInformationJobObject($Job,3,$ids,8200,$Z)){if([BitConverter]::ToInt32($acct,40) -eq 0 -and [BitConverter]::ToInt32($ids,0) -eq 0 -and [BitConverter]::ToInt32($ids,4) -eq 0){$empty=$true;break}};if((VrLeft $CleanEnd) -le 0){break};[Threading.Thread]::Sleep(10)}
if(-not $empty){$ok=$false}
if(-not (VrDrain $OutSt $CleanEnd)){$ok=$false}
if(-not (VrDrain $ErrSt $CleanEnd)){$ok=$false}
foreach($h in @($Owned.ToArray())){if(-not $K::CloseHandle($h)){$ok=$false}};$Owned.Clear()
foreach($m in @($Mem.ToArray())){[Runtime.InteropServices.Marshal]::FreeHGlobal($m)};$Mem.Clear()
}catch{$ok=$false};$ok -and -not $CloseFail -and (VrNow) -lt $CleanEnd}
function VrUnsettled([string]$stage){[void](VrTeardown);VrEmit ('UNSETTLED '+$stage) ($FailBase+3)}
function VrPreResume([string]$stage){if(VrTeardown){VrEmit ('PRERESUME '+$stage+' ACTIVE=0 LISTED=0') ($FailBase+2)};VrEmit ('UNSETTLED '+$stage) ($FailBase+3)}
trap{if($Trapped){VrEmit 'UNSETTLED unexpected' ($FailBase+3)};$script:Trapped=$true;if($Created){VrUnsettled 'unexpected'};if($Maybe){VrEmit 'UNSETTLED create-uncertain' ($FailBase+3)};VrNotCreated 'unexpected'}
if($PSVersionTable.PSVersion.Major -ne 5){VrNotCreated 'ps-version'}
if([IntPtr]::Size -ne 8){VrNotCreated 'bitness'}
if([Environment]::OSVersion.Version -lt [Version]'10.0'){VrNotCreated 'os-version'}
try{
$Asm=[AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('PrgVer'),[Reflection.Emit.AssemblyBuilderAccess]::Run)
$TB=$Asm.DefineDynamicModule('PrgVer').DefineType('PrgVerK',[Reflection.TypeAttributes]'Public,Abstract,Sealed')
$DI=[Runtime.InteropServices.DllImportAttribute]
$DC=$DI.GetConstructor([Type[]]@([string]))
$DF=[Reflection.FieldInfo[]]@($DI.GetField('SetLastError'),$DI.GetField('EntryPoint'))
function VrDef([string]$name,[Type]$ret,[Type[]]$parms){$mb=$TB.DefineMethod($name,[Reflection.MethodAttributes]'Public,Static,PinvokeImpl',$ret,$parms);$mb.SetCustomAttribute([Reflection.Emit.CustomAttributeBuilder]::new($DC,[object[]]@('kernel32.dll'),$DF,[object[]]@($true,$name)))}
$TI=[IntPtr];$TN=[int];$TF=[bool];$TY=[byte[]];$TA=[IntPtr[]];$TJ=[int[]];$TV=[Type]::GetType('System.Void')
VrDef 'CreateFileW' $TI @($TY,$TN,$TN,$TI,$TN,$TN,$TI)
VrDef 'GetDriveTypeW' $TN @($TY)
VrDef 'GetFileInformationByHandle' $TF @($TI,$TY)
VrDef 'GetFileInformationByHandleEx' $TF @($TI,$TN,$TY,$TN)
VrDef 'GetFinalPathNameByHandleW' $TN @($TI,$TY,$TN,$TN)
VrDef 'CreatePipe' $TF @($TA,$TA,$TI,$TN)
VrDef 'SetHandleInformation' $TF @($TI,$TN,$TN)
VrDef 'InitializeProcThreadAttributeList' $TF @($TI,$TN,$TN,$TA)
VrDef 'UpdateProcThreadAttribute' $TF @($TI,$TN,$TI,$TI,$TI,$TI,$TI)
VrDef 'DeleteProcThreadAttributeList' $TV @($TI)
VrDef 'CreateProcessW' $TF @($TY,$TY,$TI,$TI,$TF,$TN,$TY,$TY,$TY,$TY)
VrDef 'CreateJobObjectW' $TI @($TI,$TI)
VrDef 'SetInformationJobObject' $TF @($TI,$TN,$TY,$TN)
VrDef 'QueryInformationJobObject' $TF @($TI,$TN,$TY,$TN,$TI)
VrDef 'IsProcessInJob' $TF @($TI,$TI,$TJ)
VrDef 'QueryFullProcessImageNameW' $TF @($TI,$TN,$TY,$TJ)
VrDef 'ResumeThread' $TN @($TI)
VrDef 'TerminateProcess' $TF @($TI,$TN)
VrDef 'TerminateJobObject' $TF @($TI,$TN)
VrDef 'WaitForSingleObject' $TN @($TI,$TN)
VrDef 'GetExitCodeProcess' $TF @($TI,$TJ)
VrDef 'CloseHandle' $TF @($TI)
$K=$TB.CreateType()
}catch{VrNotCreated 'interop-define'}
$File=VrS '__FILE__';$Cwd=VrS '__CWD__';$Tail=VrS '__TAIL__';$CmdLine=VrS '__CMDLINE__'
$EnvB=[Convert]::FromBase64String('__ENV__')
$AncP=@(__ANC_P__);$AncV=@(__ANC_V__);$AncI=@(__ANC_I__);$AncB=@(__ANC_B__)
$ImgV='__IMG_V__';$ImgI='__IMG_I__';$ImgS='__IMG_S__';$ImgM='__IMG_M__';$ImgC='__IMG_C__';$ImgB='__IMG_B__'
if((VrNow) -ge $RunEnd){VrNotCreated 'deadline'}
$DriveType=$K::GetDriveTypeW((VrW (VrS $AncP[0])))
if($DriveType -notin @(2,3,5,6)){VrNotCreated 'nonlocal-volume'}
$AncH=[Collections.Generic.List[IntPtr]]::new()
for($ix=0;$ix -lt $AncP.Count;$ix++){$PathW=VrW (VrS $AncP[$ix]);$h=$K::CreateFileW($PathW,0x100081,3,$Z,3,0x02200000,$Z);if($h.ToInt64() -eq -1 -or $h -eq $Z){VrNotCreated 'ancestor-open'};$Owned.Add($h);$AncH.Add($h);if(-not (VrDirOk (VrFacts $h) $AncV[$ix] $AncI[$ix] $AncB[$ix])){VrNotCreated 'ancestor-identity'}}
$FileW=VrW $File
$ImgH=$K::CreateFileW($FileW,0x100081,1,$Z,3,0x00200000,$Z)
if($ImgH.ToInt64() -eq -1 -or $ImgH -eq $Z){VrNotCreated 'image-open'};$Owned.Add($ImgH)
if(-not (VrImgOk (VrFacts $ImgH))){VrNotCreated 'image-identity'}
$ImgNt=VrFinal $ImgH
if($null -eq $ImgNt -or -not $ImgNt.StartsWith('\Device\',[StringComparison]::Ordinal) -or -not $ImgNt.EndsWith($Tail,[StringComparison]::Ordinal)){VrNotCreated 'image-name'}
$Job=$K::CreateJobObjectW($Z,$Z)
if($Job -eq $Z){VrNotCreated 'job-create'};$Owned.Add($Job)
$Lim=[byte[]]::new(144);[BitConverter]::GetBytes([int]0x2000).CopyTo($Lim,16)
if(-not $K::SetInformationJobObject($Job,9,$Lim,144)){VrNotCreated 'job-limit'}
$PipeH=[IntPtr[]]::new(6)
for($ix=0;$ix -lt 3;$ix++){$PipeR=[IntPtr[]]::new(1);$PipeW=[IntPtr[]]::new(1);if(-not $K::CreatePipe($PipeR,$PipeW,$Z,0)){VrNotCreated 'pipe'};$Owned.Add($PipeR[0]);$Owned.Add($PipeW[0]);$PipeH[2*$ix]=$PipeR[0];$PipeH[2*$ix+1]=$PipeW[0]}
$InR=$PipeH[0];$OutR=$PipeH[2];$OutW=$PipeH[3];$ErrR=$PipeH[4];$ErrW=$PipeH[5]
if(-not (VrClose $PipeH[1])){VrNotCreated 'pipe'}
foreach($h in @($InR,$OutW,$ErrW)){if(-not $K::SetHandleInformation($h,1,1)){VrNotCreated 'inherit'}}
$AlSize=[IntPtr[]]::new(1)
[void]$K::InitializeProcThreadAttributeList($Z,2,0,$AlSize)
if($AlSize[0] -eq $Z){VrNotCreated 'attr'}
$AttrList=[Runtime.InteropServices.Marshal]::AllocHGlobal($AlSize[0]);$Mem.Add($AttrList)
if(-not $K::InitializeProcThreadAttributeList($AttrList,2,0,$AlSize)){VrNotCreated 'attr'}
$HList=[Runtime.InteropServices.Marshal]::AllocHGlobal(24);$Mem.Add($HList)
[Runtime.InteropServices.Marshal]::WriteIntPtr($HList,0,$InR);[Runtime.InteropServices.Marshal]::WriteIntPtr($HList,8,$OutW);[Runtime.InteropServices.Marshal]::WriteIntPtr($HList,16,$ErrW)
if(-not $K::UpdateProcThreadAttribute($AttrList,0,[IntPtr]0x20002,$HList,[IntPtr]24,$Z,$Z)){$K::DeleteProcThreadAttributeList($AttrList);VrNotCreated 'attr'}
$JList=[Runtime.InteropServices.Marshal]::AllocHGlobal(8);$Mem.Add($JList);[Runtime.InteropServices.Marshal]::WriteIntPtr($JList,0,$Job)
if(-not $K::UpdateProcThreadAttribute($AttrList,0,[IntPtr]0x2000D,$JList,[IntPtr]8,$Z,$Z)){$K::DeleteProcThreadAttributeList($AttrList);VrNotCreated 'job-list'}
$Si=[byte[]]::new(112);[BitConverter]::GetBytes([int]112).CopyTo($Si,0);[BitConverter]::GetBytes([int]0x100).CopyTo($Si,60)
[BitConverter]::GetBytes($InR.ToInt64()).CopyTo($Si,80);[BitConverter]::GetBytes($OutW.ToInt64()).CopyTo($Si,88);[BitConverter]::GetBytes($ErrW.ToInt64()).CopyTo($Si,96);[BitConverter]::GetBytes($AttrList.ToInt64()).CopyTo($Si,104)
$CmdW=VrW $CmdLine;$CwdW=VrW $Cwd;$Pi=[byte[]]::new(24)
if((VrNow) -ge $RunEnd){$K::DeleteProcThreadAttributeList($AttrList);VrNotCreated 'deadline'}
$Maybe=$true
$Made=$K::CreateProcessW($FileW,$CmdW,$Z,$Z,$true,0x08080404,$EnvB,$CwdW,$Si,$Pi)
if($Made){$HProc=[IntPtr][BitConverter]::ToInt64($Pi,0);$HThread=[IntPtr][BitConverter]::ToInt64($Pi,8);$Owned.Add($HProc);$Owned.Add($HThread);$Created=$true}
$Maybe=$false
$K::DeleteProcThreadAttributeList($AttrList)
$SideOk=$true;foreach($h in @($InR,$OutW,$ErrW)){if(-not (VrClose $h)){$SideOk=$false}}
if(-not $Made){VrNotCreated 'create'}
if(-not $SideOk){VrUnsettled 'pipe-close'}
$InJob=[int[]]::new(1)
if(-not ($K::IsProcessInJob($HProc,$Job,$InJob) -and $InJob[0] -ne 0)){VrPreResume 'job-member'}
$Nb=[byte[]]::new(2048);$Nn=[int[]]::new(1);$Nn[0]=1024
if(-not $K::QueryFullProcessImageNameW($HProc,1,$Nb,$Nn) -or $Nn[0] -le 0 -or $Nn[0] -ge 1024){VrPreResume 'image-query'}
$ChildNt=[Text.Encoding]::Unicode.GetString($Nb,0,$Nn[0]*2)
if(-not [string]::Equals($ChildNt,$ImgNt,[StringComparison]::Ordinal)){VrPreResume 'image-mismatch'}
for($ix=0;$ix -lt $AncH.Count;$ix++){if(-not (VrDirOk (VrFacts $AncH[$ix]) $AncV[$ix] $AncI[$ix] $AncB[$ix])){VrPreResume 'ancestor-changed'}}
if(-not (VrImgOk (VrFacts $ImgH))){VrPreResume 'image-changed'}
if(-not [string]::Equals((VrFinal $ImgH),$ImgNt,[StringComparison]::Ordinal)){VrPreResume 'image-changed'}
try{
$OutSt=@{Fs=[IO.FileStream]::new([Microsoft.Win32.SafeHandles.SafeFileHandle]::new($OutR,$false),[IO.FileAccess]::Read,4096,$false);Buf=[byte[]]::new(4096);Task=$null;Eof=$false;Keep=$true}
$ErrSt=@{Fs=[IO.FileStream]::new([Microsoft.Win32.SafeHandles.SafeFileHandle]::new($ErrR,$false),[IO.FileAccess]::Read,4096,$false);Buf=[byte[]]::new(4096);Task=$null;Eof=$false;Keep=$false}
}catch{VrPreResume 'stream'}
if((VrNow) -ge $RunEnd){VrPreResume 'deadline'}
$Prev=$K::ResumeThread($HThread)
if($Prev -ne 1){VrUnsettled 'resume'}
if(-not (VrClose $HThread)){$CloseFail=$true};$HThread=$Z
$Total=0;$Kind=$null;$Exited=$false;$CaptureMs=-1;$Kept=[IO.MemoryStream]::new();$Max=__MAX_OUT__;$SettleAt=$null
try{
$OutSt.Task=$OutSt.Fs.ReadAsync($OutSt.Buf,0,4096);$ErrSt.Task=$ErrSt.Fs.ReadAsync($ErrSt.Buf,0,4096)
while($null -eq $Kind){
foreach($st in @($OutSt,$ErrSt)){
if($null -ne $Kind){break}
if($st.Eof -or -not $st.Task.IsCompleted){continue}
if($st.Task.Status -ne 'RanToCompletion'){$Kind='output-failed';break}
$n=$st.Task.Result
if($n -eq 0){$st.Eof=$true;$st.Task=$null;continue}
$Total+=$n
if($Total -gt $Max){$Kind='oversized';$st.Task=$null;break}
if($st.Keep){$Kept.Write($st.Buf,0,$n)}
$st.Task=$st.Fs.ReadAsync($st.Buf,0,4096)
}
if($null -ne $Kind){break}
if(-not $Exited -and $K::WaitForSingleObject($HProc,0) -eq 0){$Exited=$true}
$Left=VrLeft $RunEnd
if($Exited -and $OutSt.Eof -and $ErrSt.Eof){if($Left -le 0){$Kind='timeout'}else{$Kind='completed';$CaptureMs=$Clock.ElapsedMilliseconds};break}
if($Left -le 0){$Kind='timeout';break}
$Pend=@();foreach($st in @($OutSt,$ErrSt)){if(-not $st.Eof){$Pend+=$st.Task}}
if($Pend.Count -gt 0){try{[void][Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]$Pend,[int][Math]::Min($Left,20))}catch{}}else{[void]$K::WaitForSingleObject($HProc,[int][Math]::Min($Left,20))}
}
$SettleAt=VrNow
if($Kind -eq 'completed'){$Ec=[int[]]::new(1);if(-not $K::GetExitCodeProcess($HProc,$Ec)){$Kind='output-failed'}elseif($Ec[0] -ne 0){$Kind='abnormal-exit'}}
}catch{$Kind='output-failed'}
if($null -eq $SettleAt){$SettleAt=VrNow}
if(-not (VrTeardown $SettleAt)){VrEmit 'UNSETTLED teardown' ($FailBase+3)}
$Cap=if($Kind -eq 'completed'){[string]$CaptureMs}else{'-'}
$B64=if($Kind -eq 'completed'){[Convert]::ToBase64String($Kept.ToArray())}else{''}
VrEmit ('EXITED '+$Kind+' BYTES='+$Total+' CAPTURE='+$Cap+' TOTAL='+$Clock.ElapsedMilliseconds+' ACTIVE=0 LISTED=0 OUT='+$B64) 0
`;

/* -------------------------------------------------------------- rendering */

/** Single-pass placeholder substitution; an unknown or unused placeholder is a bug. */
function render(template: string, values: Readonly<Record<string, string>>): string {
  const used = new Set<string>();
  const out = template.replace(/__([A-Z0-9_]+)__/gu, (match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`unbound placeholder ${match}`);
    used.add(key);
    return value;
  });
  for (const key of Object.keys(values)) {
    if (!used.has(key)) throw new Error(`unused placeholder value ${key}`);
  }
  return out.trim();
}

function utf16Base64(text: string): string {
  return Buffer.from(text, "utf16le").toString("base64");
}

function decimal(value: bigint, max: bigint): string {
  if (typeof value !== "bigint" || value < 0n || value > max) throw new Error("identity value out of range");
  return value.toString(10);
}

/** Unix-epoch nanoseconds (libuv's conversion) → exact FILETIME ticks, or a throw. */
function filetimeTicks(ns: bigint): string {
  if (typeof ns !== "bigint" || ns % 100n !== 0n) throw new Error("time is not FILETIME-exact");
  return decimal(ns / 100n + FILETIME_UNIX_EPOCH, I64_MAX);
}

function directoryIdentity(value: unknown): WindowsExpectedDirectory {
  if (value === null || typeof value !== "object") throw new Error("directory identity missing");
  const { dev, ino, birthtimeNs } = value as WindowsExpectedDirectory;
  if (typeof dev !== "bigint" || typeof ino !== "bigint" || typeof birthtimeNs !== "bigint" || ino <= 0n) {
    throw new Error("directory identity malformed");
  }
  return { dev, ino, birthtimeNs };
}

/** One validated runner launch: what Node spawns and the one startup frame it writes. */
export interface WindowsClaudeVersionRunnerLaunch {
  readonly file: string;
  readonly args: readonly string[];
  readonly bootstrap: string;
  readonly source: string;
  readonly sourceSha256: string;
  readonly startupFrame: Buffer;
  readonly commandLineLength: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface WindowsClaudeVersionRunnerLaunchInput {
  readonly powershellPath: string;
  readonly spec: WindowsExactImageRunSpec;
  readonly bounds: WindowsDirectVersionRunBounds;
  /** Absolute run deadline on the shared performance counter, in milliseconds. */
  readonly counterDeadlineMs: number;
  readonly nonce: string;
}

/**
 * Validate one exact run independently of the probe and render the runner.
 * Throws (rendering nothing) for anything but the probe's exact direct
 * `.exe`, `--version`, executable-parent cwd, allowlisted environment, and
 * well-formed identities and bounds.
 */
export function buildWindowsClaudeVersionRunnerLaunch(input: WindowsClaudeVersionRunnerLaunchInput): WindowsClaudeVersionRunnerLaunch {
  const powershellPath = validatePowerShellPath(input.powershellPath);
  const { spec, bounds, counterDeadlineMs, nonce } = input;
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) throw new Error("nonce must be 32 lowercase hex");
  if (spec === null || typeof spec !== "object") throw new Error("spec missing");
  const file = spec.file;
  const ancestors = windowsClaudeTargetAncestors(file);
  if (ancestors === null || typeof file !== "string") throw new Error("file is not an admitted direct .exe");
  const cwd = ancestors[ancestors.length - 1]!;
  if (spec.cwd !== cwd) throw new Error("cwd must be the executable's parent");
  const args = spec.args;
  if (!Array.isArray(args) || args.length !== WINDOWS_CLAUDE_VERSION_ARGS.length
    || args.some((arg, index) => arg !== WINDOWS_CLAUDE_VERSION_ARGS[index])) {
    throw new Error("args must be exactly --version");
  }
  // The probe's canonical environment fills absent optional names with "": rebuild it from
  // its nonempty entries only, then require the result to equal the given object exactly.
  const given = spec.env as Readonly<Record<string, unknown>> | null;
  const env = given !== null && typeof given === "object" && !Array.isArray(given)
    ? buildWindowsClaudeVersionEnvironment(Object.fromEntries(Object.entries(given).filter(([, value]) => value !== "")))
    : null;
  if (env === null || given === null || typeof given !== "object"
    || Object.keys(given).length !== Object.keys(env).length
    || Object.entries(env).some(([name, value]) => given[name] !== value)) {
    throw new Error("env must be the exact allowlisted environment");
  }
  const image = spec.image;
  if (image === null || typeof image !== "object" || typeof image.size !== "bigint" || image.size <= 0n
    || typeof image.ino !== "bigint" || image.ino <= 0n) {
    throw new Error("image identity malformed");
  }
  const cwdIdentity = directoryIdentity(spec.cwdIdentity);
  const ancestorIdentities = spec.ancestorIdentities;
  if (!Array.isArray(ancestorIdentities) || ancestorIdentities.length !== ancestors.length) {
    throw new Error("ancestor identities must cover every ancestor");
  }
  const chain = ancestorIdentities.map(directoryIdentity);
  const last = chain[chain.length - 1]!;
  if (last.dev !== cwdIdentity.dev || last.ino !== cwdIdentity.ino || last.birthtimeNs !== cwdIdentity.birthtimeNs) {
    throw new Error("cwd identity must be the last ancestor identity");
  }
  if (bounds === null || typeof bounds !== "object") throw new Error("bounds missing");
  const { cleanupMs, maxOutputBytes } = bounds;
  if (!Number.isInteger(cleanupMs) || cleanupMs <= 0 || cleanupMs > WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS) {
    throw new Error("cleanupMs out of range");
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES) {
    throw new Error("maxOutputBytes out of range");
  }
  if (typeof counterDeadlineMs !== "number" || !Number.isFinite(counterDeadlineMs) || counterDeadlineMs <= 0) {
    throw new Error("counter deadline malformed");
  }

  // Windows requires a case-insensitively sorted Unicode block, double-NUL terminated.
  const entries = Object.entries(env).sort(([a], [b]) => {
    const left = a.toUpperCase();
    const right = b.toUpperCase();
    return left < right ? -1 : left > right ? 1 : 0;
  });
  for (const [name, value] of entries) {
    if (/[\u0000=]/u.test(name) || value.includes("\u0000")) throw new Error("environment entry malformed");
  }
  const envBlock = `${entries.map(([name, value]) => `${name}=${value}`).join("\u0000")}\u0000\u0000`;
  const quotedList = (values: readonly string[]): string => values.map((value) => `'${value}'`).join(",");
  const source = render(WINDOWS_CLAUDE_VERSION_RUNNER_SOURCE_TEMPLATE, {
    NONCE: nonce,
    FAIL_BASE: String(WINDOWS_CLAUDE_VERSION_RUNNER_FAIL_BASE),
    DEADLINE_MS: counterDeadlineMs.toFixed(3),
    CLEANUP_MS: String(cleanupMs),
    MAX_OUT: String(maxOutputBytes),
    TERM_CODE: String(WINDOWS_CLAUDE_VERSION_RUNNER_TERMINATE_CODE),
    FILE: utf16Base64(file),
    CWD: utf16Base64(cwd),
    TAIL: utf16Base64(file.slice(2)),
    CMDLINE: utf16Base64(`"${file}" ${WINDOWS_CLAUDE_VERSION_ARGS.join(" ")}`),
    ENV: Buffer.from(envBlock, "utf16le").toString("base64"),
    ANC_P: quotedList(ancestors.map(utf16Base64)),
    ANC_V: quotedList(chain.map((entry) => decimal(entry.dev, U64_MAX))),
    ANC_I: quotedList(chain.map((entry) => decimal(entry.ino, U64_MAX))),
    ANC_B: quotedList(chain.map((entry) => filetimeTicks(entry.birthtimeNs))),
    IMG_V: decimal(image.dev, U64_MAX),
    IMG_I: decimal(image.ino, U64_MAX),
    IMG_S: decimal(image.size, U64_MAX),
    IMG_M: filetimeTicks(image.mtimeNs),
    IMG_C: filetimeTicks(image.ctimeNs),
    IMG_B: filetimeTicks(image.birthtimeNs),
  });
  if (!/^[\t\n\r -~]+$/u.test(source) || source.length > MAX_SOURCE_BYTES) throw new Error("runner source malformed");
  const sourceSha256 = createHash("sha256").update(source, "ascii").digest("hex");
  const header = `${WINDOWS_CLAUDE_VERSION_RUNNER_BOOT_MAGIC}${String(source.length).padStart(BOOT_LENGTH_DIGITS, "0")}\n`;
  if (header.length !== BOOT_HEADER_BYTES) throw new Error("startup header length");
  const startupFrame = Buffer.concat([Buffer.from(header, "ascii"), Buffer.from(source, "ascii")]);
  const bootstrap = render(WINDOWS_CLAUDE_VERSION_RUNNER_BOOTSTRAP_TEMPLATE, {
    LANG_EXIT: String(WINDOWS_CLAUDE_VERSION_RUNNER_BOOT_FAIL_MIN),
    FAIL_BASE: String(WINDOWS_CLAUDE_VERSION_RUNNER_FAIL_BASE),
    HEAD_LEN: String(BOOT_HEADER_BYTES),
    FRAME_MS: String(STARTUP_FRAME_MS),
    MAX_SRC: String(MAX_SOURCE_BYTES),
    SRC_LEN: String(source.length),
    SRC_SHA: sourceSha256,
  });
  const encoded = Buffer.from(bootstrap, "utf16le").toString("base64");
  const runnerArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
  const commandLineLength = `"${powershellPath}" `.length + runnerArgs.join(" ").length;
  if (commandLineLength > WINDOWS_CLAUDE_VERSION_RUNNER_MAX_COMMAND_LINE) throw new Error("runner command line too long");
  return Object.freeze({
    file: powershellPath,
    args: Object.freeze(runnerArgs),
    bootstrap,
    source,
    sourceSha256,
    startupFrame,
    commandLineLength,
    env,
  });
}

/**
 * The PowerShell HELPER process's spawn environment: the exact target
 * allowlist with only `USERPROFILE` set to the trusted same-user host value.
 * Throws for a missing or malformed value (including a component with a
 * trailing period or space, or a reserved device name), or a target environment
 * that does not pin `USERPROFILE` empty. Never used for the `CreateProcessW` target,
 * whose block is rendered from the unmodified allowlist.
 */
export function buildWindowsClaudeVersionRunnerHelperEnvironment(
  targetEnv: Readonly<Record<string, string>>,
  userProfile: unknown,
): Readonly<Record<string, string>> {
  if (typeof userProfile !== "string" || userProfile.length > MAX_HELPER_PROFILE_CHARS
    || HELPER_PROFILE_LONE_SURROGATE.test(userProfile) || !HELPER_PROFILE_PATTERN.test(userProfile)
    || userProfile.slice(3).split("\\").some(invalidHelperProfileComponent)) {
    throw new Error("helper USERPROFILE must be a drive-absolute path");
  }
  if (targetEnv === null || typeof targetEnv !== "object" || targetEnv.USERPROFILE !== "") {
    throw new Error("target environment must pin USERPROFILE empty");
  }
  return Object.freeze({ ...targetEnv, USERPROFILE: userProfile });
}

/* ------------------------------------------------------------ classification */

const NOT_CREATED: WindowsDirectVersionRunReceipt = Object.freeze({ exactChild: "not-created" });
const UNSETTLED: WindowsDirectVersionRunReceipt = Object.freeze({ exactChild: "unsettled" });
const SPAWN_UNCERTAIN: WindowsDirectVersionRunReceipt = Object.freeze({ exactChild: "spawn-uncertain" });

const RECORD = /^PRG-WVR1 ([0-9a-f]{32}) (.*)\n$/u;
const STAGE = "([a-z][a-z-]{0,31})";
const NOT_CREATED_RECORD = new RegExp(`^NOTCREATED ${STAGE}$`, "u");
const PRE_RESUME_RECORD = new RegExp(`^PRERESUME ${STAGE} ACTIVE=0 LISTED=0$`, "u");
const UNSETTLED_RECORD = new RegExp(`^UNSETTLED ${STAGE}$`, "u");
const EXITED_RECORD =
  /^EXITED (completed|timeout|oversized|abnormal-exit|output-failed) BYTES=(0|[1-9][0-9]{0,9}) CAPTURE=(-|0|[1-9][0-9]{0,9}) TOTAL=(0|[1-9][0-9]{0,9}) ACTIVE=0 LISTED=0 OUT=([A-Za-z0-9+/]*={0,2})$/u;

/** Facts Node observed about one finished runner process. */
export interface WindowsClaudeVersionRunnerExit {
  /** Every stdout byte the runner wrote (bounded by the caller). */
  readonly stdout: Buffer;
  readonly code: number | null;
  readonly signal: string | null;
  /** Monotonic time (the probe's clock) at which `close` was observed. */
  readonly receivedAt: number;
  readonly nonce: string;
  readonly maxOutputBytes: number;
}

/**
 * Map one closed runner process into a receipt. Only the exact record with the
 * matching nonce and exit code counts; an `exited` receipt additionally needs
 * the kernel empty-job witness in the record. Never throws.
 */
export function classifyWindowsClaudeVersionRunnerExit(exit: WindowsClaudeVersionRunnerExit): WindowsDirectVersionRunReceipt {
  try {
    const { stdout, code, signal, receivedAt, nonce, maxOutputBytes } = exit;
    if (!Buffer.isBuffer(stdout) || !Number.isFinite(receivedAt)) return UNSETTLED;
    if (stdout.length === 0) {
      // Only an explicit bootstrap refusal proves the body (and so any child) never ran.
      return signal === null && typeof code === "number"
        && code >= WINDOWS_CLAUDE_VERSION_RUNNER_BOOT_FAIL_MIN && code <= WINDOWS_CLAUDE_VERSION_RUNNER_BOOT_FAIL_MAX
        ? NOT_CREATED
        : SPAWN_UNCERTAIN;
    }
    if (stdout.some((byte) => byte > 0x7e || (byte < 0x20 && byte !== 0x0a))) return UNSETTLED;
    const text = stdout.toString("ascii");
    const record = RECORD.exec(text);
    if (record === null || record[1] !== nonce || record[2]!.includes("\n") || signal !== null) return UNSETTLED;
    const body = record[2]!;
    if (NOT_CREATED_RECORD.test(body)) {
      return code === WINDOWS_CLAUDE_VERSION_RUNNER_EXIT["not-created"] ? NOT_CREATED : UNSETTLED;
    }
    if (PRE_RESUME_RECORD.test(body)) {
      return code === WINDOWS_CLAUDE_VERSION_RUNNER_EXIT["terminated-before-resume"]
        ? Object.freeze({ exactChild: "terminated-before-resume", ownedHandles: "closed", descendants: "witnessed-empty" })
        : UNSETTLED;
    }
    const unsettled = UNSETTLED_RECORD.exec(body);
    if (unsettled !== null) {
      if (code !== WINDOWS_CLAUDE_VERSION_RUNNER_EXIT.unsettled) return UNSETTLED;
      return unsettled[1] === "create-uncertain" ? SPAWN_UNCERTAIN : UNSETTLED;
    }
    const exited = EXITED_RECORD.exec(body);
    if (exited === null || code !== WINDOWS_CLAUDE_VERSION_RUNNER_EXIT.exited) return UNSETTLED;
    let kind = exited[1] as WindowsDirectVersionRunKind;
    const outputBytes = Number(exited[2]);
    const captureMs = exited[3] === "-" ? null : Number(exited[3]);
    const totalMs = Number(exited[4]);
    const out = Buffer.from(exited[5]!, "base64");
    if (out.toString("base64") !== exited[5]) return UNSETTLED;
    if ((kind === "completed") !== (captureMs !== null)) return UNSETTLED;
    if (kind !== "completed" && out.length !== 0) return UNSETTLED;
    let stdoutText = "";
    let captureCompletedAt = receivedAt;
    if (kind === "completed") {
      if (captureMs! > totalMs || out.length > outputBytes || outputBytes > maxOutputBytes) return UNSETTLED;
      // `ignoreBOM` keeps a leading BOM in the text, so the exact grammar refuses it.
      // Upper bound for the capture instant on Node's clock: the record was
      // written (TOTAL) no later than `close`, and the runner's Stopwatch
      // truncates to whole milliseconds.
      captureCompletedAt = receivedAt - Math.max(0, totalMs - captureMs! - 1);
      try {
        stdoutText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(out);
      } catch {
        kind = "output-failed";
      }
    }
    return Object.freeze({
      exactChild: "exited",
      launch: "suspended-image-name-matched",
      ownedHandles: "closed",
      kind,
      stdout: kind === "completed" ? stdoutText : "",
      outputBytes,
      captureCompletedAt,
      descendants: "witnessed-empty",
    });
  } catch {
    return UNSETTLED;
  }
}

/* ------------------------------------------------------------------ runner */

/** Spawn seam: the one direct spawn of the trusted PowerShell executable. */
export type WindowsClaudeVersionRunnerSpawn = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface WindowsClaudeVersionRunnerOptions {
  /** Trusted absolute System32 Windows PowerShell 5.1 path from the caller's resolver. */
  readonly powershellPath: string;
  readonly spawn?: WindowsClaudeVersionRunnerSpawn;
  /** Shared performance counter in nanoseconds (Node: `process.hrtime.bigint`). */
  readonly counterNs?: () => bigint;
  /** 32 lowercase hex per run. */
  readonly nonce?: () => string;
  /**
   * Trusted same-user host `USERPROFILE` for the PowerShell helper process
   * only (Node: `process.env.USERPROFILE`); never reaches the target.
   */
  readonly userProfile?: () => string | undefined;
}

const productionSpawn: WindowsClaudeVersionRunnerSpawn = (file, args, options) => nodeSpawn(file, [...args], options);
const productionUserProfile = (): string | undefined => process.env.USERPROFILE;

/**
 * Create the exact-image runner. Nothing is spawned until the probe invokes
 * `run`; the product constructs it only through the host composition.
 */
export function createWindowsClaudeVersionRunner(options: WindowsClaudeVersionRunnerOptions): WindowsExactImageVersionRunner {
  const powershellPath = options.powershellPath;
  const spawnRunner = options.spawn ?? productionSpawn;
  const counterNs = options.counterNs ?? (() => process.hrtime.bigint());
  const makeNonce = options.nonce ?? (() => randomBytes(16).toString("hex"));
  const readUserProfile = options.userProfile ?? productionUserProfile;
  return Object.freeze({
    binding: "exact-image-no-fallback" as const,
    run: (spec: WindowsExactImageRunSpec, bounds: WindowsDirectVersionRunBounds, now: () => number) =>
      runOnce(powershellPath, spawnRunner, counterNs, makeNonce, readUserProfile, spec, bounds, now),
  });
}

function runOnce(
  powershellPath: string,
  spawnRunner: WindowsClaudeVersionRunnerSpawn,
  counterNs: () => bigint,
  makeNonce: () => string,
  readUserProfile: () => string | undefined,
  spec: WindowsExactImageRunSpec,
  bounds: WindowsDirectVersionRunBounds,
  now: () => number,
): Promise<WindowsDirectVersionRunReceipt> {
  let launch: WindowsClaudeVersionRunnerLaunch;
  let helperEnv: Readonly<Record<string, string>>;
  let nonce: string;
  let finalDeadline: number;
  try {
    // The counter is sampled BEFORE the probe clock, so any pause between the two
    // shortens (never extends) the translated native deadline.
    const counterMs = Number(counterNs()) / 1e6;
    const startedAt = now();
    const deadline = bounds.deadline;
    if (typeof deadline !== "number" || !Number.isFinite(deadline) || !Number.isFinite(startedAt)
      || !Number.isFinite(counterMs) || startedAt >= deadline) {
      return Promise.resolve(NOT_CREATED);
    }
    const counterDeadlineMs = counterMs + (deadline - startedAt);
    nonce = makeNonce();
    launch = buildWindowsClaudeVersionRunnerLaunch({ powershellPath, spec, bounds, counterDeadlineMs, nonce });
    // Helper process only: the rendered target block above keeps USERPROFILE empty.
    helperEnv = buildWindowsClaudeVersionRunnerHelperEnvironment(launch.env, readUserProfile());
    finalDeadline = deadline + bounds.cleanupMs;
    // Preparation takes time: the original run deadline is rechecked immediately before the spawn.
    const spawnAt = now();
    if (!Number.isFinite(spawnAt) || spawnAt >= deadline) return Promise.resolve(NOT_CREATED);
  } catch {
    return Promise.resolve(NOT_CREATED);
  }

  return new Promise((resolve) => {
    let settled = false;
    let spawned = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess;
    const finish = (receipt: WindowsDirectVersionRunReceipt): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(receipt);
    };
    try {
      child = spawnRunner(launch.file, launch.args, {
        ...WINDOWS_CLAUDE_VERSION_RUNNER_SPAWN_OPTIONS,
        stdio: [...WINDOWS_CLAUDE_VERSION_RUNNER_SPAWN_OPTIONS.stdio],
        env: { ...helperEnv },
      });
    } catch {
      // A synchronous spawn failure may still have produced a process.
      finish(SPAWN_UNCERTAIN);
      return;
    }
    const kill = (): void => {
      // The exact owned ChildProcess handle only; never a numeric PID.
      try { child.kill(); } catch { /* the receipt is already unsettled */ }
    };
    if (child === null || typeof child !== "object" || child.stdin == null || child.stdout == null || child.stderr == null) {
      try { kill(); } catch { /* nothing more can be done */ }
      finish(SPAWN_UNCERTAIN);
      return;
    }
    timer = setTimeout(() => {
      kill();
      finish(spawned ? UNSETTLED : SPAWN_UNCERTAIN);
    }, Math.max(0, finalDeadline - now()));

    const receiptStream = child.stdout;
    let receiptStreamFailed = false;
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    child.on("spawn", () => { spawned = true; });
    child.on("error", () => {
      // Before `spawn`, Node reports that no process was created; later errors
      // (for example a failed kill) leave the watchdog and `close` to decide.
      if (!spawned) finish(NOT_CREATED);
    });
    child.stdin.on("error", () => { /* the runner's own record decides */ });
    receiptStream.on("error", () => { receiptStreamFailed = true; });
    child.stderr.on("error", () => { /* `close` decides */ });
    child.stderr.on("data", () => { /* drained and discarded: diagnostics only */ });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > WINDOWS_CLAUDE_VERSION_RUNNER_MAX_STDOUT_BYTES) {
        kill();
        finish(UNSETTLED);
        return;
      }
      chunks.push(chunk);
    });
    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled || !spawned) return;
      // `close` proves the streams closed, not that the record arrived whole or in time.
      const receivedAt = now();
      if (receiptStreamFailed || !receiptStream.readableEnded
        || !Number.isFinite(receivedAt) || receivedAt >= finalDeadline) {
        finish(UNSETTLED);
        return;
      }
      finish(classifyWindowsClaudeVersionRunnerExit({
        stdout: Buffer.concat(chunks),
        code,
        signal,
        receivedAt,
        nonce,
        maxOutputBytes: bounds.maxOutputBytes,
      }));
    });
    try {
      child.stdin.end(launch.startupFrame);
    } catch {
      /* the bootstrap refuses a missing frame; the record decides */
    }
  });
}
