import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import test from "node:test";

import { CLAUDE_INBOX_MIN_CLI_VERSION } from "../src/session-host/native-claude-inbox-delivery";
import {
  WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS,
  WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES,
  buildWindowsClaudeVersionEnvironment,
  probeWindowsClaudeVersion,
  windowsClaudeTargetAncestors,
  type WindowsDirectVersionRunBounds,
  type WindowsExactImageRunSpec,
  type WindowsFileFacts,
  type WindowsFileHandle,
  type WindowsProbeFileSystem,
} from "../src/session-host/native-windows-claude-version-probe";
import {
  WINDOWS_CLAUDE_VERSION_RUNNER_BOOTSTRAP_TEMPLATE,
  WINDOWS_CLAUDE_VERSION_RUNNER_BOOT_FAIL_MIN,
  WINDOWS_CLAUDE_VERSION_RUNNER_EXIT,
  WINDOWS_CLAUDE_VERSION_RUNNER_MAX_COMMAND_LINE,
  WINDOWS_CLAUDE_VERSION_RUNNER_MAX_STDOUT_BYTES,
  WINDOWS_CLAUDE_VERSION_RUNNER_SOURCE_TEMPLATE,
  buildWindowsClaudeVersionRunnerHelperEnvironment,
  buildWindowsClaudeVersionRunnerLaunch,
  classifyWindowsClaudeVersionRunnerExit,
  createWindowsClaudeVersionRunner,
  type WindowsClaudeVersionRunnerExit,
} from "../src/session-host/native-windows-claude-version-runner";

/**
 * #682: INACTIVE Windows exact-image version runner.
 *
 * Portable checks only: the rendered PowerShell is inspected, never run, and
 * every runner process is a fake injected through the spawn seam. Nothing here
 * proves the script's behavior on real Windows, which remains required before
 * any wiring.
 */

const PROJECT_ROOT = join(__dirname, "..", "..");
const RUNNER_SOURCE_PATH = join(PROJECT_ROOT, "src", "session-host", "native-windows-claude-version-runner.ts");

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const NONCE = "0123456789abcdef0123456789abcdef";
const DIR = "C:\\Users\\dev\\AppData\\Local\\Programs\\Claude";
const FILE = `${DIR}\\claude.exe`;
const ANCESTORS = windowsClaudeTargetAncestors(FILE)!;
const EPOCH_TICKS = 116_444_736_000_000_000n;
const SECRETS = ["sk-ant-secret-value", "oauth-secret-value", "settlement-secret-value"];
const SOURCE_ENV: NodeJS.ProcessEnv = Object.freeze({
  SystemRoot: "C:\\Windows",
  SystemDrive: "C:",
  windir: "C:\\Windows",
  TEMP: "C:\\Users\\dev\\AppData\\Local\\Temp",
  TMP: "C:\\Users\\dev\\AppData\\Local\\Temp",
  PATH: "C:\\Windows\\System32;C:\\Users\\dev\\evil",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
  ANTHROPIC_API_KEY: SECRETS[0],
  CLAUDE_CODE_OAUTH_TOKEN: SECRETS[1],
  PI_REVIEW_GATE_SETTLEMENT_SECRET: SECRETS[2],
});
const ENV = buildWindowsClaudeVersionEnvironment(SOURCE_ENV)!;
/** Trusted same-user host USERPROFILE handed to the PowerShell helper process only. */
const PROFILE = "C:\\Users\\dev";
const OUT = `${CLAUDE_INBOX_MIN_CLI_VERSION} (Claude Code)\r\n`;

const IMAGE = Object.freeze({
  dev: 3_221_225_473n, ino: 0x0001_0000_0000_2345n, size: 8192n,
  mtimeNs: 1_700_000_000_123_456_700n, ctimeNs: 1_700_000_100_000_000_000n, birthtimeNs: 1_600_000_000_000_000_000n,
});
function dirIdentity(index: number) {
  return Object.freeze({ dev: 3_221_225_473n, ino: BigInt(100 + index), birthtimeNs: 1_500_000_000_000_000_000n + BigInt(index) * 100n });
}
const CHAIN = Object.freeze(ANCESTORS.map((_path, index) => dirIdentity(index)));

function spec(overrides: Partial<Record<keyof WindowsExactImageRunSpec, unknown>> = {}): WindowsExactImageRunSpec {
  return Object.freeze({
    file: FILE,
    args: Object.freeze(["--version"]),
    cwd: DIR,
    env: ENV,
    image: IMAGE,
    cwdIdentity: CHAIN[CHAIN.length - 1]!,
    ancestorIdentities: CHAIN,
    ...overrides,
  }) as WindowsExactImageRunSpec;
}

const BOUNDS: WindowsDirectVersionRunBounds = Object.freeze({
  deadline: 5_000, cleanupMs: WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS, maxOutputBytes: WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES,
});

function launch(overrides: Partial<Parameters<typeof buildWindowsClaudeVersionRunnerLaunch>[0]> = {}) {
  return buildWindowsClaudeVersionRunnerLaunch({
    powershellPath: POWERSHELL, spec: spec(), bounds: BOUNDS, counterDeadlineMs: 123_456.5, nonce: NONCE, ...overrides,
  });
}

function decodeUtf16(source: string, name: string): string {
  const match = new RegExp(`\\$${name}=VrS '([A-Za-z0-9+/=]*)'`, "u").exec(source);
  assert.ok(match, `${name} literal present`);
  return Buffer.from(match[1]!, "base64").toString("utf16le");
}

function literal(source: string, name: string): string {
  const match = new RegExp(`\\$${name}='([^']*)'`, "u").exec(source);
  assert.ok(match, `${name} literal present`);
  return match[1]!;
}

function list(source: string, name: string): string[] {
  const match = new RegExp(`\\$${name}=@\\(([^)]*)\\)`, "u").exec(source);
  assert.ok(match, `${name} list present`);
  return match[1]!.split(",").map((entry) => /^'([^']*)'$/u.exec(entry)![1]!);
}

function ticks(ns: bigint): string {
  return (ns / 100n + EPOCH_TICKS).toString();
}

/** The exact CreateProcessW target environment decoded from the rendered Unicode block. */
function targetEnvOf(source: string): Record<string, string> {
  const envBase64 = /\$EnvB=\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(source)![1]!;
  const block = Buffer.from(envBase64, "base64").toString("utf16le");
  assert.ok(block.endsWith("\u0000\u0000"));
  const entries = block.slice(0, -2).split("\u0000");
  return Object.fromEntries(entries.map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
}

/** The runner body with comments and data literals removed, for structural assertions. */
function code(text: string): string {
  return text.replace(/'[^'\n]*'/gu, "''");
}

/* ------------------------------------------------------------- rendering */

test("render: exact application, fixed --version, executable-parent cwd, allowlisted sorted environment", () => {
  const rendered = launch();
  assert.equal(rendered.file, POWERSHELL);
  assert.deepEqual(rendered.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  assert.equal(rendered.args.length, 5);
  assert.equal(Buffer.from(rendered.args[4]!, "base64").toString("utf16le"), rendered.bootstrap);
  assert.ok(rendered.commandLineLength <= WINDOWS_CLAUDE_VERSION_RUNNER_MAX_COMMAND_LINE);
  // The body travels only in the startup frame, pinned by length and SHA-256 in the bootstrap.
  assert.ok(!rendered.bootstrap.includes("CreateProcessW"));
  const sha = createHash("sha256").update(rendered.source, "ascii").digest("hex");
  assert.equal(rendered.sourceSha256, sha);
  assert.ok(rendered.bootstrap.includes(`-cne '${sha}'`));
  assert.ok(rendered.bootstrap.includes(`-ne ${rendered.source.length})`));
  assert.equal(rendered.startupFrame.toString("ascii"), `PRG-WVR1 ${String(rendered.source.length).padStart(8, "0")}\n${rendered.source}`);
  assert.match(rendered.source, /^[\t\n\r\u0020-\u007e]+$/u);
  assert.doesNotMatch(rendered.source + rendered.bootstrap, /__[A-Z0-9_]+__/u, "every placeholder substituted");

  assert.equal(decodeUtf16(rendered.source, "File"), FILE);
  assert.equal(decodeUtf16(rendered.source, "Cwd"), DIR);
  assert.equal(decodeUtf16(rendered.source, "Tail"), FILE.slice(2));
  assert.equal(decodeUtf16(rendered.source, "CmdLine"), `"${FILE}" --version`);
  assert.deepEqual(list(rendered.source, "AncP").map((entry) => Buffer.from(entry, "base64").toString("utf16le")), ANCESTORS);
  const envBase64 = /\$EnvB=\[Convert\]::FromBase64String\('([A-Za-z0-9+/=]+)'\)/u.exec(rendered.source)![1]!;
  const block = Buffer.from(envBase64, "base64").toString("utf16le");
  assert.ok(block.endsWith("\u0000\u0000"));
  const entries = block.slice(0, -2).split("\u0000");
  const names = entries.map((entry) => entry.slice(0, entry.indexOf("=")));
  assert.deepEqual(names, [...names].sort((a, b) => (a.toUpperCase() < b.toUpperCase() ? -1 : 1)), "case-insensitively sorted");
  assert.deepEqual(Object.fromEntries(entries.map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)])), { ...ENV });
  for (const secret of SECRETS) {
    assert.ok(!block.includes(secret));
    assert.ok(!rendered.source.includes(Buffer.from(secret, "utf16le").toString("base64")));
  }
  assert.ok(!block.includes("evil") && !block.includes("ComSpec"));
  assert.deepEqual({ ...rendered.env }, { ...ENV });
});

test("render: held-handle identities are the probe's, converted exactly to FILETIME and decimal", () => {
  const { source } = launch();
  assert.equal(literal(source, "ImgV"), IMAGE.dev.toString());
  assert.equal(literal(source, "ImgI"), IMAGE.ino.toString());
  assert.equal(literal(source, "ImgS"), IMAGE.size.toString());
  assert.equal(literal(source, "ImgM"), ticks(IMAGE.mtimeNs));
  assert.equal(literal(source, "ImgC"), ticks(IMAGE.ctimeNs));
  assert.equal(literal(source, "ImgB"), ticks(IMAGE.birthtimeNs));
  assert.deepEqual(list(source, "AncV"), CHAIN.map((entry) => entry.dev.toString()));
  assert.deepEqual(list(source, "AncI"), CHAIN.map((entry) => entry.ino.toString()));
  assert.deepEqual(list(source, "AncB"), CHAIN.map((entry) => ticks(entry.birthtimeNs)));
  assert.ok(source.includes("$RunEnd=[double]'123456.500'"));
  // The cleanup bound is `min(settle, deadline) + cleanupMs`, computed when teardown starts; no fixed global bound.
  assert.ok(source.includes(`function VrTeardown([double]$settledAt=(VrNow)){$CleanEnd=[Math]::Min($settledAt,$RunEnd)+${WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS};`));
  assert.ok(!source.includes("$CleanEnd=$RunEnd"));
  assert.ok(source.includes(`$Max=${WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES}`));
  assert.ok(source.includes(`$Nonce='${NONCE}'`));
});

test("render: anything but the probe's exact run is refused before anything is rendered", () => {
  const bad: Array<[string, () => unknown]> = [
    ["pwsh, not stock 5.1", () => launch({ powershellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" })],
    ["relative powershell", () => launch({ powershellPath: "powershell.exe" })],
    ["nonce", () => launch({ nonce: "ABC" })],
    ["batch target", () => launch({ spec: spec({ file: `${DIR}\\claude.cmd` }) })],
    ["UNC target", () => launch({ spec: spec({ file: "\\\\server\\share\\claude.exe" }) })],
    ["other args", () => launch({ spec: spec({ args: ["--help"] }) })],
    ["extra args", () => launch({ spec: spec({ args: ["--version", "--debug"] }) })],
    ["other cwd", () => launch({ spec: spec({ cwd: "C:\\Users\\dev" }) })],
    ["extra env", () => launch({ spec: spec({ env: { ...ENV, ANTHROPIC_API_KEY: SECRETS[0] } }) })],
    ["missing env", () => launch({ spec: spec({ env: { SystemRoot: "C:\\Windows" } }) })],
    ["changed env", () => launch({ spec: spec({ env: { ...ENV, PATH: "C:\\evil" } }) })],
    ["short chain", () => launch({ spec: spec({ ancestorIdentities: CHAIN.slice(1) }) })],
    ["cwd not last", () => launch({ spec: spec({ cwdIdentity: dirIdentity(0) }) })],
    ["inexact time", () => launch({ spec: spec({ image: { ...IMAGE, mtimeNs: IMAGE.mtimeNs + 1n } }) })],
    ["zero ino", () => launch({ spec: spec({ image: { ...IMAGE, ino: 0n } }) })],
    ["number identity", () => launch({ spec: spec({ image: { ...IMAGE, dev: 1 } }) })],
    ["cleanup above probe bound", () => launch({ bounds: { ...BOUNDS, cleanupMs: WINDOWS_CLAUDE_VERSION_PROBE_CLEANUP_MS + 1 } })],
    ["cap above probe cap", () => launch({ bounds: { ...BOUNDS, maxOutputBytes: WINDOWS_CLAUDE_VERSION_PROBE_MAX_OUTPUT_BYTES + 1 } })],
    ["counter deadline", () => launch({ counterDeadlineMs: Number.NaN })],
  ];
  for (const [name, attempt] of bad) assert.throws(attempt, Error, name);
});

/* ----------------------------------------------------- proof before resume */

test("proof before resume: suspended explicit creation, job membership, native image name, recheck, then resume", () => {
  const body = code(WINDOWS_CLAUDE_VERSION_RUNNER_SOURCE_TEMPLATE);
  const at = (needle: string): number => {
    const index = body.indexOf(needle);
    assert.ok(index >= 0, `missing ${needle}`);
    assert.equal(body.indexOf(needle, index + 1), -1, `${needle} appears once`);
    return index;
  };
  const order = [
    "$ImgH=$K::CreateFileW($FileW,0x100081,1,$Z,3,0x00200000,$Z)",
    "$ImgNt=VrFinal $ImgH",
    "$Job=$K::CreateJobObjectW($Z,$Z)",
    "SetInformationJobObject($Job,9,$Lim,144)",
    "UpdateProcThreadAttribute($AttrList,0,[IntPtr]0x20002,$HList,[IntPtr]24,$Z,$Z)",
    "WriteIntPtr($JList,0,$Job)",
    "UpdateProcThreadAttribute($AttrList,0,[IntPtr]0x2000D,$JList,[IntPtr]8,$Z,$Z)",
    "$Made=$K::CreateProcessW($FileW,$CmdW,$Z,$Z,$true,0x08080404,$EnvB,$CwdW,$Si,$Pi)",
    "IsProcessInJob($HProc,$Job,$InJob)",
    "QueryFullProcessImageNameW($HProc,1,$Nb,$Nn)",
    "[string]::Equals($ChildNt,$ImgNt,[StringComparison]::Ordinal)",
    "VrPreResume ''",
    "$Prev=$K::ResumeThread($HThread)",
    "if($Prev -ne 1){VrUnsettled ''}",
  ];
  let previous = -1;
  for (const needle of order) {
    const index = needle === "VrPreResume ''" ? body.lastIndexOf(needle, body.indexOf("$Prev=")) : at(needle);
    assert.ok(index > previous, `${needle} in order`);
    previous = index;
  }
  // The job is assigned AT creation (PROC_THREAD_ATTRIBUTE_JOB_LIST, two attributes in the list, Windows 10+):
  // there is no post-creation assignment window in which a dying runner could orphan the suspended child.
  assert.doesNotMatch(WINDOWS_CLAUDE_VERSION_RUNNER_SOURCE_TEMPLATE, /AssignProcessToJobObject/u);
  assert.ok(body.includes("[void]$K::InitializeProcThreadAttributeList($Z,2,0,$AlSize)"));
  assert.ok(body.includes("if(-not $K::InitializeProcThreadAttributeList($AttrList,2,0,$AlSize)){VrNotCreated ''}"));
  assert.ok(body.includes("[IntPtr]0x2000D,$JList,[IntPtr]8,$Z,$Z)){$K::DeleteProcThreadAttributeList($AttrList);VrNotCreated ''}"), "no atomic assignment: nothing is created");
  assert.ok(body.includes("if([Environment]::OSVersion.Version -lt [Version]''){VrNotCreated ''}"));
  assert.ok(WINDOWS_CLAUDE_VERSION_RUNNER_SOURCE_TEMPLATE.includes("-lt [Version]'10.0'"));
  // Creation flags: CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW; never breakaway.
  const flags = 0x08080404;
  assert.equal(flags & 0x4, 0x4);
  assert.equal(flags & 0x400, 0x400);
  assert.equal(flags & 0x80000, 0x80000);
  assert.equal(flags & 0x0100_0000, 0, "no CREATE_BREAKAWAY_FROM_JOB");
  assert.equal(flags & 0x10, 0, "no CREATE_NEW_CONSOLE");
  assert.equal(flags & 0x8, 0, "no DETACHED_PROCESS");
  // Job: KILL_ON_JOB_CLOSE only (no BREAKAWAY_OK 0x800, no SILENT_BREAKAWAY_OK 0x1000).
  assert.ok(body.includes("[BitConverter]::GetBytes([int]0x2000).CopyTo($Lim,16)"));
  assert.deepEqual(body.match(/GetBytes\(\[int\]0x[0-9a-f]+\)\.CopyTo\(\$Lim,\d+\)/giu), ["GetBytes([int]0x2000).CopyTo($Lim,16)"]);
  // Exactly the three child ends are inheritable and listed; the runner's own stdio never is.
  assert.ok(body.includes("foreach($h in @($InR,$OutW,$ErrW)){if(-not $K::SetHandleInformation($h,1,1))"));
  assert.ok(body.includes("WriteIntPtr($HList,0,$InR)") && body.includes("WriteIntPtr($HList,8,$OutW)") && body.includes("WriteIntPtr($HList,16,$ErrW)"));
  assert.ok(body.includes("if(-not (VrClose $PipeH[1])){VrNotCreated ''}"), "stdin write end closed before creation");
  assert.ok(body.includes("$SideOk=$true;foreach($h in @($InR,$OutW,$ErrW)){if(-not (VrClose $h)){$SideOk=$false}}"));
  assert.ok(body.includes("[BitConverter]::GetBytes([int]0x100).CopyTo($Si,60)"), "STARTF_USESTDHANDLES");
  // Ancestors are held without delete sharing and without following reparse points; the target with read-only sharing.
  assert.ok(body.includes("$K::CreateFileW($PathW,0x100081,3,$Z,3,0x02200000,$Z)"));
  // Local volumes only: the drive type of the admitted root is checked before the first ancestor open,
  // admitting removable (2), fixed (3), optical (5), and RAM (6) disks only.
  const drive = body.indexOf("$DriveType=$K::GetDriveTypeW((VrW (VrS $AncP[0])))");
  assert.ok(drive > 0 && drive < body.indexOf("$K::CreateFileW($PathW,"));
  assert.ok(body.indexOf("if($DriveType -notin @(2,3,5,6)){VrNotCreated ''}") === drive + "$DriveType=$K::GetDriveTypeW((VrW (VrS $AncP[0])))\n".length);
  assert.ok(WINDOWS_CLAUDE_VERSION_RUNNER_SOURCE_TEMPLATE.includes("VrNotCreated 'nonlocal-volume'"));
  // Every held handle is rechecked before resume.
  const resume = body.indexOf("$Prev=$K::ResumeThread");
  assert.ok(body.lastIndexOf("VrPreResume ''", resume) > body.indexOf("VrImgOk (VrFacts $ImgH))){VrPreResume"));
  assert.ok(body.indexOf("VrDirOk (VrFacts $AncH[$ix])") < resume);
  assert.ok(body.indexOf("if((VrNow) -ge $RunEnd){VrPreResume") < resume);
});

test("no PID authority or fallback: handles only, kernel32 only, no shell, search, compiler, or helper binary", () => {
  const script = WINDOWS_CLAUDE_VERSION_RUNNER_SOURCE_TEMPLATE + WINDOWS_CLAUDE_VERSION_RUNNER_BOOTSTRAP_TEMPLATE;
  assert.doesNotMatch(script, /OpenProcess|GetProcessId|\$PID\b|\.Id\b|taskkill|Stop-Process|Start-Process|Diagnostics\.Process\]|UseShellExecute|ShellExecute|SearchPath|cmd\.exe|Invoke-Expression|\biex\b|Add-Type|ntdll|csc\.exe|LoadLibrary|Write-Host|Write-Output|\becho\b/iu);
  // The only native library is kernel32, defined in memory.
  assert.deepEqual([...new Set(script.match(/'[a-z0-9]+\.dll'/giu))], ["'kernel32.dll'"]);
  assert.ok(script.includes("[Reflection.Emit.AssemblyBuilderAccess]::Run"));
  assert.ok(!script.includes("`"), "no backticks");
  assert.ok(!script.includes("${"), "no braced variables");
  // No PowerShell automatic variable is reused as script state.
  const variables = new Set((script.match(/\$[A-Za-z_][A-Za-z0-9_]*/gu) ?? []).map((name) => name.slice(1).toLowerCase()));
  for (const automatic of ["input", "args", "pid", "host", "error", "matches", "foreach", "switch", "this", "event", "home", "pwd", "ofs", "sender", "profile", "lastexitcode", "psitem"]) {
    assert.ok(!variables.has(automatic), `$${automatic} unused`);
  }
  // Every kernel32 call's value is consumed, so stdout carries only the one record.
  for (const match of WINDOWS_CLAUDE_VERSION_RUNNER_SOURCE_TEMPLATE.matchAll(/\$K::([A-Za-z]+)\(/gu)) {
    const before = WINDOWS_CLAUDE_VERSION_RUNNER_SOURCE_TEMPLATE.slice(Math.max(0, match.index! - 8), match.index!);
    const consumed = /(?:=|\(|\[void\]|-not |-and |-or |return )$/u.test(before) || match[1] === "DeleteProcThreadAttributeList";
    assert.ok(consumed, `${match[1]} value consumed (…${before})`);
  }
  // The Node side never signals a numeric PID: only the exact ChildProcess handle's kill().
  const runnerCode = readFileSync(RUNNER_SOURCE_PATH, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  assert.doesNotMatch(runnerCode, /process\.kill\(|\.pid\b|execFile|execSync|(?<![.\w])exec\(|shell:\s*true|detached:\s*true/u);
  assert.ok(runnerCode.includes("shell: false as const") && runnerCode.includes("detached: false as const") && runnerCode.includes("windowsHide: true as const"));
});

test("teardown: always terminate the owned job, observe the exact exit, witness the job empty, drain, and check every close", () => {
  const body = code(WINDOWS_CLAUDE_VERSION_RUNNER_SOURCE_TEMPLATE);
  const teardown = body.slice(body.indexOf("function VrTeardown"), body.indexOf("function VrUnsettled"));
  for (const needle of [
    "[void]$K::TerminateProcess($HProc,",
    "[void]$K::TerminateJobObject($Job,",
    "$K::WaitForSingleObject($HProc,(VrLeft $CleanEnd)) -ne 0){$ok=$false}",
    "QueryInformationJobObject($Job,1,$acct,48,$Z)",
    "QueryInformationJobObject($Job,3,$ids,8200,$Z)",
    "[BitConverter]::ToInt32($acct,40) -eq 0 -and [BitConverter]::ToInt32($ids,0) -eq 0 -and [BitConverter]::ToInt32($ids,4) -eq 0",
    "if(-not $empty){$ok=$false}",
    "if(-not (VrDrain $OutSt $CleanEnd)){$ok=$false}",
    "if(-not (VrDrain $ErrSt $CleanEnd)){$ok=$false}",
    "foreach($h in @($Owned.ToArray())){if(-not $K::CloseHandle($h)){$ok=$false}}",
    // A teardown that finishes at or past its bound is never clean.
    "}catch{$ok=$false};$ok -and -not $CloseFail -and (VrNow) -lt $CleanEnd}",
  ]) assert.ok(teardown.includes(needle), needle);
  // Draining needs a successful EOF inside the bound: a faulted or canceled read is a failure, not EOF.
  const drain = body.slice(body.indexOf("function VrDrain"), body.indexOf("function VrTeardown"));
  for (const needle of [
    "function VrDrain($st,[double]$end){",
    "if((VrLeft $end) -le 0){return $false}",
    "if(-not $st.Task.IsCompleted){[void]$st.Task.Wait((VrLeft $end))}",
    "if($st.Task.Status -ne ''){return $false}",
    "if($st.Task.Result -eq 0){$st.Eof=$true}else{$st.Task=$null}",
    "}catch{return $false};$true}",
  ]) assert.ok(drain.includes(needle), needle);
  assert.doesNotMatch(drain, /-or \$st\.Task\.Result -eq 0/u);
  // The settle instant is taken when the run loop ends (before the exit-code read) and bounds the teardown.
  assert.ok(body.indexOf("$SettleAt=VrNow\nif($Kind -eq ''){$Ec=") > body.indexOf("while($null -eq $Kind){"));
  assert.ok(body.includes("if($null -eq $SettleAt){$SettleAt=VrNow}\nif(-not (VrTeardown $SettleAt)){VrEmit '' ($FailBase+3)}"));
  // EXITED is written only after a successful teardown; a failed teardown is UNSETTLED.
  const exited = body.indexOf("VrEmit (''+$Kind");
  assert.ok(exited > body.indexOf("if(-not (VrTeardown $SettleAt)){VrEmit '' ($FailBase+3)}"));
  // Output cap and deadline in the run loop; completion needs the exact child's exit and EOF on both pipes.
  assert.ok(body.includes("if($Total -gt $Max){$Kind='';$st.Task=$null;break}"));
  assert.ok(body.includes("if($Exited -and $OutSt.Eof -and $ErrSt.Eof){if($Left -le 0){$Kind=''}else{$Kind='';$CaptureMs=$Clock.ElapsedMilliseconds};break}"));
  assert.ok(body.includes("if($Left -le 0){$Kind='';break}"));
});

/* -------------------------------------------------------------- receipts */

function exitOf(record: string, code: number | null, overrides: Partial<WindowsClaudeVersionRunnerExit> = {}): WindowsClaudeVersionRunnerExit {
  return { stdout: Buffer.from(record, "ascii"), code, signal: null, receivedAt: 1_000, nonce: NONCE, maxOutputBytes: 4096, ...overrides };
}

function exitedRecord(options: { kind?: string; bytes?: number; capture?: string; total?: number; out?: string } = {}): string {
  const out = options.out ?? Buffer.from(OUT).toString("base64");
  return `PRG-WVR1 ${NONCE} EXITED ${options.kind ?? "completed"} BYTES=${options.bytes ?? Buffer.byteLength(OUT)} CAPTURE=${options.capture ?? "40"} TOTAL=${options.total ?? 60} ACTIVE=0 LISTED=0 OUT=${out}\n`;
}

test("receipts: only the exact record, nonce, and exit code count; everything else fails closed", () => {
  const ok = classifyWindowsClaudeVersionRunnerExit(exitOf(exitedRecord(), 0));
  assert.deepEqual(ok, {
    exactChild: "exited", launch: "suspended-image-name-matched", ownedHandles: "closed", kind: "completed",
    stdout: OUT, outputBytes: Buffer.byteLength(OUT), captureCompletedAt: 1_000 - 19, descendants: "witnessed-empty",
  });
  assert.ok(Object.isFrozen(ok));
  const base = `PRG-WVR1 ${NONCE}`;
  const cases: Array<[string, WindowsClaudeVersionRunnerExit, string]> = [
    ["not created", exitOf(`${base} NOTCREATED image-identity\n`, WINDOWS_CLAUDE_VERSION_RUNNER_EXIT["not-created"]!), "not-created"],
    ["not created, wrong code", exitOf(`${base} NOTCREATED image-identity\n`, 0), "unsettled"],
    ["pre-resume", exitOf(`${base} PRERESUME image-mismatch ACTIVE=0 LISTED=0\n`, WINDOWS_CLAUDE_VERSION_RUNNER_EXIT["terminated-before-resume"]!), "terminated-before-resume"],
    ["pre-resume, wrong code", exitOf(`${base} PRERESUME image-mismatch ACTIVE=0 LISTED=0\n`, 0), "unsettled"],
    ["pre-resume, job not empty", exitOf(`${base} PRERESUME image-mismatch ACTIVE=1 LISTED=1\n`, WINDOWS_CLAUDE_VERSION_RUNNER_EXIT["terminated-before-resume"]!), "unsettled"],
    ["unsettled", exitOf(`${base} UNSETTLED teardown\n`, WINDOWS_CLAUDE_VERSION_RUNNER_EXIT.unsettled!), "unsettled"],
    ["create uncertain", exitOf(`${base} UNSETTLED create-uncertain\n`, WINDOWS_CLAUDE_VERSION_RUNNER_EXIT.unsettled!), "spawn-uncertain"],
    ["bootstrap refusal", exitOf("", WINDOWS_CLAUDE_VERSION_RUNNER_BOOT_FAIL_MIN + 7), "not-created"],
    ["silent clean exit", exitOf("", 0), "spawn-uncertain"],
    ["silent crash", exitOf("", null, { signal: "SIGTERM" }), "spawn-uncertain"],
    ["wrong nonce", exitOf(exitedRecord().replace(NONCE, "f".repeat(32)), 0), "unsettled"],
    ["exited, nonzero runner exit", exitOf(exitedRecord(), 1), "unsettled"],
    ["exited, signal", exitOf(exitedRecord(), 0, { signal: "SIGKILL" }), "unsettled"],
    ["extra line", exitOf(`${base} NOTCREATED x\n${exitedRecord()}`, 0), "unsettled"],
    ["CRLF", exitOf(exitedRecord().replace("\n", "\r\n"), 0), "unsettled"],
    ["no terminator", exitOf(exitedRecord().trimEnd(), 0), "unsettled"],
    ["non-ASCII", exitOf(exitedRecord().replace("ACTIVE", "ÀCTIVE"), 0), "unsettled"],
    ["job not empty", exitOf(exitedRecord().replace("ACTIVE=0", "ACTIVE=1"), 0), "unsettled"],
    ["non-canonical base64", exitOf(exitedRecord({ out: "QQ" }), 0), "unsettled"],
    ["completed without capture", exitOf(exitedRecord({ capture: "-" }), 0), "unsettled"],
    ["capture after total", exitOf(exitedRecord({ capture: "61" }), 0), "unsettled"],
    ["stdout above byte count", exitOf(exitedRecord({ bytes: 2 }), 0), "unsettled"],
    ["byte count above cap", exitOf(exitedRecord({ bytes: 4097 }), 0), "unsettled"],
    ["timeout carrying output", exitOf(exitedRecord({ kind: "timeout", capture: "-" }), 0), "unsettled"],
    ["unknown kind", exitOf(exitedRecord({ kind: "done" }), 0), "unsettled"],
    ["leading zero", exitOf(exitedRecord().replace("TOTAL=60", "TOTAL=060"), 0), "unsettled"],
  ];
  for (const [name, exit, expected] of cases) {
    const receipt = classifyWindowsClaudeVersionRunnerExit(exit);
    assert.equal(receipt.exactChild, expected, name);
  }
  const timeout = classifyWindowsClaudeVersionRunnerExit(exitOf(exitedRecord({ kind: "timeout", capture: "-", out: "", bytes: 9 }), 0));
  assert.deepEqual(timeout, {
    exactChild: "exited", launch: "suspended-image-name-matched", ownedHandles: "closed", kind: "timeout",
    stdout: "", outputBytes: 9, captureCompletedAt: 1_000, descendants: "witnessed-empty",
  });
  // A leading UTF-8 BOM is kept in the decoded text (never silently stripped into an exact match).
  const bomOut = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(OUT)]);
  const bom = classifyWindowsClaudeVersionRunnerExit(exitOf(exitedRecord({ out: bomOut.toString("base64"), bytes: bomOut.length }), 0));
  assert.equal(bom.exactChild === "exited" && bom.stdout, `\ufeff${OUT}`);
  // Invalid UTF-8 is never decoded into evidence.
  const invalid = classifyWindowsClaudeVersionRunnerExit(exitOf(exitedRecord({ out: Buffer.from([0xff, 0xfe]).toString("base64"), bytes: 2 }), 0));
  assert.equal(invalid.exactChild === "exited" && invalid.kind, "output-failed");
  assert.equal(invalid.exactChild === "exited" && invalid.stdout, "");
  // A throwing exit description is unsettled, never a throw.
  assert.equal(classifyWindowsClaudeVersionRunnerExit({ get stdout(): Buffer { throw new Error("x"); } } as never).exactChild, "unsettled");
});

/* ---------------------------------------------------------------- runner */

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kills = 0;
  frame: Buffer = Buffer.alloc(0);
  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => { this.frame = Buffer.concat([this.frame, chunk]); });
  }
  kill(): boolean {
    this.kills += 1;
    return true;
  }
  /** Write the runner's stdout, then exit and close. */
  finish(stdout: string, code: number | null, signal: string | null = null): void {
    this.stdout.end(stdout);
    this.stderr.end("diagnostic noise C:\\secret\n");
    setImmediate(() => {
      this.emit("exit", code, signal);
      this.emit("close", code, signal);
    });
  }
}

interface SpawnCall { file: string; args: readonly string[]; options: SpawnOptions }

type Behavior = (child: FakeChild) => void;

function fakeSpawn(behavior: Behavior) {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const spawn = (file: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    calls.push({ file, args, options });
    const child = new FakeChild();
    children.push(child);
    setImmediate(() => behavior(child));
    return child as unknown as ChildProcess;
  };
  return { spawn, calls, children };
}

/** Report `spawn`, then act once the whole startup frame has been written and ended. */
const spawned = (then: Behavior): Behavior => (child) => {
  child.emit("spawn");
  if (child.stdin.writableFinished) then(child);
  else child.stdin.once("finish", () => then(child));
};

function runner(behavior: Behavior) {
  const fake = fakeSpawn(behavior);
  const instance = createWindowsClaudeVersionRunner({
    powershellPath: POWERSHELL, spawn: fake.spawn, counterNs: () => 9_000_000_000n, nonce: () => NONCE, userProfile: () => PROFILE,
  });
  return { ...fake, instance };
}

test("runner: one direct hidden PowerShell spawn with allowlisted env and the pinned frame; record becomes the receipt", async () => {
  const { instance, calls, children } = runner(spawned((child) => child.finish(exitedRecord(), 0)));
  assert.equal(instance.binding, "exact-image-no-fallback");
  assert.ok(Object.isFrozen(instance));
  const clock = 0;
  const receipt = await instance.run(spec(), { ...BOUNDS, deadline: 5_000 }, () => clock);
  assert.equal(receipt.exactChild, "exited");
  assert.equal(receipt.exactChild === "exited" && receipt.stdout, OUT);
  assert.equal(calls.length, 1);
  const [{ file, args, options }] = calls;
  assert.equal(file, POWERSHELL);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.detached, false);
  assert.deepEqual(options.env, { ...ENV, USERPROFILE: PROFILE },
    "the PowerShell helper receives only the allowlisted environment plus the trusted USERPROFILE");
  assert.ok(args.includes("-NoProfile"), "the helper still runs without a profile");
  // The exact target block written in the frame is unchanged: USERPROFILE and every home name stay empty.
  const target = targetEnvOf(children[0]!.frame.toString("ascii"));
  assert.deepEqual(target, { ...ENV });
  assert.equal(target.USERPROFILE, "");
  // The frame written to stdin is exactly the pinned source, with the counter deadline synchronized to the probe's.
  const expected = buildWindowsClaudeVersionRunnerLaunch({
    powershellPath: POWERSHELL, spec: spec(), bounds: { ...BOUNDS, deadline: 5_000 }, counterDeadlineMs: 9_000 + 5_000, nonce: NONCE,
  });
  assert.deepEqual([...args], [...expected.args]);
  assert.ok(children[0]!.frame.equals(expected.startupFrame));
  assert.equal(children[0]!.kills, 0);
});

test("runner: the native deadline is never extended by a pause, and the run deadline is rechecked right before the spawn", async () => {
  // A pause after the counter sample (simulated by the counter advancing the probe clock) shortens the
  // translated deadline: 9000 ms counter + (5000 - 100) ms remaining, never 9000 + 5000.
  let clock = 0;
  const paused = fakeSpawn(spawned((child) => child.finish(exitedRecord(), 0)));
  const pausedRunner = createWindowsClaudeVersionRunner({
    powershellPath: POWERSHELL, spawn: paused.spawn, nonce: () => NONCE, userProfile: () => PROFILE,
    counterNs: () => { clock += 100; return 9_000_000_000n; },
  });
  assert.equal((await pausedRunner.run(spec(), BOUNDS, () => clock)).exactChild, "exited");
  assert.ok(paused.children[0]!.frame.toString("ascii").includes("$RunEnd=[double]'13900.000'"));

  // Preparation that crosses the run deadline starts nothing.
  clock = 0;
  const late = fakeSpawn(spawned((child) => child.finish(exitedRecord(), 0)));
  const lateRunner = createWindowsClaudeVersionRunner({
    powershellPath: POWERSHELL, spawn: late.spawn, counterNs: () => 9_000_000_000n, userProfile: () => PROFILE,
    nonce: () => { clock = BOUNDS.deadline; return NONCE; },
  });
  assert.deepEqual(await lateRunner.run(spec(), BOUNDS, () => clock), { exactChild: "not-created" });
  assert.equal(late.calls.length, 0, "nothing spawned after the deadline");
});

test("runner: nothing starts for an invalid run or a passed deadline; a failed spawn is not-created, a throwing one uncertain", async () => {
  for (const [name, badSpec, bounds, now] of [
    ["bad args", spec({ args: ["--help"] }), BOUNDS, 0],
    ["bad env", spec({ env: { ...ENV, ANTHROPIC_API_KEY: SECRETS[0] } }), BOUNDS, 0],
    ["deadline passed", spec(), BOUNDS, 5_000],
    ["cleanup widened", spec(), { ...BOUNDS, cleanupMs: 60_000 }, 0],
  ] as const) {
    const { instance, calls } = runner(spawned((child) => child.finish(exitedRecord(), 0)));
    assert.deepEqual(await instance.run(badSpec, bounds, () => now), { exactChild: "not-created" }, name);
    assert.equal(calls.length, 0, `${name}: nothing spawned`);
  }
  const failed = runner((child) => {
    child.emit("error", Object.assign(new Error("spawn ENOENT C:\\secret"), { code: "ENOENT" }));
    child.emit("close", -4058, null);
  });
  assert.deepEqual(await failed.instance.run(spec(), BOUNDS, () => 0), { exactChild: "not-created" });
  const throwing = createWindowsClaudeVersionRunner({
    powershellPath: POWERSHELL, nonce: () => NONCE, counterNs: () => 1n, userProfile: () => PROFILE,
    spawn: () => { throw new Error("EPERM"); },
  });
  assert.deepEqual(await throwing.run(spec(), BOUNDS, () => 0), { exactChild: "spawn-uncertain" });
});

test("runner: helper USERPROFILE is separate from the target block; a missing or malformed value starts nothing", async () => {
  // Helper env: the exact allowlist with only USERPROFILE set; the target pins it empty, and only it.
  const helper = buildWindowsClaudeVersionRunnerHelperEnvironment(ENV, PROFILE);
  // A declared-type view: `deepEqual` below narrows `helper` itself.
  const helperByName: Readonly<Record<string, string>> = helper;
  assert.ok(Object.isFrozen(helper));
  assert.deepEqual(Object.keys(helper), Object.keys(ENV));
  assert.deepEqual(helper, { ...ENV, USERPROFILE: PROFILE });
  for (const name of ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "USERDOMAIN", "USERNAME"]) assert.equal(helperByName[name], "", name);
  assert.equal(ENV.USERPROFILE, "", "the shared target allowlist is not mutated");
  assert.throws(() => buildWindowsClaudeVersionRunnerHelperEnvironment({ ...ENV, USERPROFILE: "C:\\x" }, PROFILE));
  assert.throws(() => buildWindowsClaudeVersionRunnerHelperEnvironment(null as never, PROFILE));
  for (const ok of ["C:\\Users\\dev", "d:\\Profiles\\J\u00f6rg Smith", "C:\\Users\\\u{1F600}", "C:\\Users\\console", "C:\\Users\\com10", "C:\\Users\\nul-user.dev"]) {
    assert.equal(buildWindowsClaudeVersionRunnerHelperEnvironment(ENV, ok).USERPROFILE, ok);
  }

  const invalid: ReadonlyArray<readonly [string, () => string | undefined]> = [
    ["missing", () => undefined],
    ["empty", () => ""],
    ["relative", () => "Users\\dev"],
    ["drive-relative", () => "C:Users\\dev"],
    ["drive root only", () => "C:\\"],
    ["trailing separator", () => "C:\\Users\\dev\\"],
    ["UNC", () => "\\\\server\\share\\dev"],
    ["device namespace", () => "\\\\?\\C:\\Users\\dev"],
    ["forward slash", () => "C:/Users/dev"],
    ["dot-dot", () => "C:\\Users\\..\\Windows"],
    ["dot", () => "C:\\Users\\.\\dev"],
    ["trailing period", () => "C:\\Users\\dev."],
    ["trailing space", () => "C:\\Users\\dev "],
    ["trailing period and space", () => "C:\\Users\\dev. "],
    ["space-only component", () => "C:\\Users\\ "],
    ["trailing-space ancestor", () => "C:\\Users \\dev"],
    ["device name", () => "C:\\Users\\NUL"],
    ["device name with extension", () => "C:\\Users\\COM1.txt"],
    ["device name lowercase", () => "C:\\Users\\con"],
    ["device name trailing space stem", () => "C:\\Users\\aux .log"],
    ["device ancestor", () => "C:\\LPT\u00b9\\dev"],
    ["device console", () => "C:\\Users\\CONIN$"],
    ["NUL", () => "C:\\Users\\dev\u0000X=1"],
    ["newline", () => "C:\\Users\\dev\nPATH=C:\\evil"],
    ["quote", () => "C:\\Users\\\"dev"],
    ["wildcard", () => "C:\\Users\\*"],
    ["stream", () => "C:\\Users\\dev:ads"],
    ["lone surrogate", () => "C:\\Users\\\uD800"],
    ["too long", () => `C:\\${"a".repeat(257)}`],
    ["non-string", () => 42 as unknown as string],
    ["throwing reader", () => { throw new Error("no env C:\\secret"); }],
  ];
  for (const [name, userProfile] of invalid) {
    const fake = fakeSpawn(spawned((child) => child.finish(exitedRecord(), 0)));
    const instance = createWindowsClaudeVersionRunner({
      powershellPath: POWERSHELL, spawn: fake.spawn, counterNs: () => 9_000_000_000n, nonce: () => NONCE, userProfile,
    });
    assert.deepEqual(await instance.run(spec(), BOUNDS, () => 0), { exactChild: "not-created" }, name);
    assert.equal(fake.calls.length, 0, `${name}: nothing spawned`);
  }
});

test("runner: by default only the host USERPROFILE reaches the helper; no ambient credential or other name does", async () => {
  const ambient: Record<string, string> = {
    USERPROFILE: "C:\\Users\\host",
    ANTHROPIC_API_KEY: SECRETS[0]!,
    CLAUDE_CODE_OAUTH_TOKEN: SECRETS[1]!,
    PI_REVIEW_GATE_SETTLEMENT_SECRET: SECRETS[2]!,
    HOMEDRIVE: "Z:",
    HOMEPATH: "\\Users\\host",
    APPDATA: "C:\\Users\\host\\AppData\\Roaming",
    PSModulePath: "C:\\Users\\host\\evil-modules",
  };
  const saved = new Map(Object.keys(ambient).map((name) => [name, process.env[name]] as const));
  const restore = (): void => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    Object.assign(process.env, ambient);
    const fake = fakeSpawn(spawned((child) => child.finish(exitedRecord(), 0)));
    const instance = createWindowsClaudeVersionRunner({
      powershellPath: POWERSHELL, spawn: fake.spawn, counterNs: () => 9_000_000_000n, nonce: () => NONCE,
    });
    assert.equal((await instance.run(spec(), BOUNDS, () => 0)).exactChild, "exited");
    assert.equal(fake.calls.length, 1);
    const helperEnv = fake.calls[0]!.options.env!;
    const helperByName: Readonly<Record<string, string | undefined>> = helperEnv;
    assert.deepEqual(helperEnv, { ...ENV, USERPROFILE: ambient.USERPROFILE });
    const frame = fake.children[0]!.frame.toString("ascii");
    const target = targetEnvOf(frame);
    assert.deepEqual(target, { ...ENV }, "the encoded target environment is exactly the unchanged allowlist");
    for (const [name, value] of Object.entries(ambient)) {
      if (name !== "USERPROFILE") assert.notEqual(helperByName[name], value, `${name} not propagated to the helper`);
      assert.ok(!Object.values(target).includes(value), `${name} value absent from the target`);
      assert.ok(!frame.includes(Buffer.from(value, "utf16le").toString("base64")), `${name} value not rendered`);
      assert.ok(!frame.includes(value), `${name} value not in the frame`);
      assert.ok(!fake.calls[0]!.args.join(" ").includes(value), `${name} value not on the command line`);
    }

    // The host value missing: the run is refused before any spawn, exactly as before any change.
    delete process.env.USERPROFILE;
    const missing = fakeSpawn(spawned((child) => child.finish(exitedRecord(), 0)));
    const refusing = createWindowsClaudeVersionRunner({
      powershellPath: POWERSHELL, spawn: missing.spawn, counterNs: () => 9_000_000_000n, nonce: () => NONCE,
    });
    assert.deepEqual(await refusing.run(spec(), BOUNDS, () => 0), { exactChild: "not-created" });
    assert.equal(missing.calls.length, 0);
  } finally {
    restore();
  }
});

test("runner: a hung or flooding runner is killed by its exact handle and never settles cleanly", async () => {
  const realNow = (): number => performance.now();
  const hung = runner((child) => child.emit("spawn"));
  const start = realNow();
  const hungReceipt = await hung.instance.run(spec(), { deadline: start + 30, cleanupMs: 20, maxOutputBytes: 4096 }, realNow);
  assert.deepEqual(hungReceipt, { exactChild: "unsettled" });
  assert.equal(hung.children[0]!.kills, 1);
  assert.ok(realNow() - start < 1_000);

  const silent = runner(() => { /* neither spawn nor error */ });
  const silentStart = realNow();
  assert.deepEqual(await silent.instance.run(spec(), { deadline: silentStart + 20, cleanupMs: 10, maxOutputBytes: 4096 }, realNow), { exactChild: "spawn-uncertain" });
  assert.equal(silent.children[0]!.kills, 1);

  const flood = runner(spawned((child) => { child.stdout.write(Buffer.alloc(WINDOWS_CLAUDE_VERSION_RUNNER_MAX_STDOUT_BYTES + 1, 0x41)); }));
  const floodStart = realNow();
  assert.deepEqual(await flood.instance.run(spec(), { deadline: floodStart + 2_000, cleanupMs: 500, maxOutputBytes: 4096 }, realNow), { exactChild: "unsettled" });
  assert.equal(flood.children[0]!.kills, 1);
  assert.ok(realNow() - floodStart < 1_000, "killed on overflow, not by the watchdog");

  // A runner that exits without releasing its stdio (no `close`) is not settled either.
  const lingering = runner(spawned((child) => { child.stdout.write(exitedRecord()); child.emit("exit", 0, null); }));
  const lingerStart = realNow();
  assert.deepEqual(await lingering.instance.run(spec(), { deadline: lingerStart + 30, cleanupMs: 20, maxOutputBytes: 4096 }, realNow), { exactChild: "unsettled" });
  assert.equal(lingering.children[0]!.kills, 1);
});

test("runner: a valid record is unsettled unless stdout reached EOF without error and close came before the final deadline", async () => {
  // A valid-looking record followed by a stdout failure before EOF.
  const broken = runner(spawned((child) => {
    child.stdout.write(exitedRecord());
    setImmediate(() => {
      child.stdout.destroy(new Error("pipe broke C:\\secret"));
      setImmediate(() => child.emit("close", 0, null));
    });
  }));
  assert.deepEqual(await broken.instance.run(spec(), BOUNDS, () => 0), { exactChild: "unsettled" });

  // A valid record whose close is observed at the final deadline, before the watchdog callback ran.
  let clock = 0;
  const late = runner(spawned((child) => {
    clock = BOUNDS.deadline + BOUNDS.cleanupMs;
    child.finish(exitedRecord(), 0);
  }));
  assert.deepEqual(await late.instance.run(spec(), BOUNDS, () => clock), { exactChild: "unsettled" });
  assert.equal(late.children[0]!.kills, 0, "decided by the close-time check, not the watchdog");

  // Control: the same record, intact and on time, is the exited receipt.
  const intact = runner(spawned((child) => child.finish(exitedRecord(), 0)));
  assert.equal((await intact.instance.run(spec(), BOUNDS, () => 0)).exactChild, "exited");
});

/* ----------------------------------------------------- composed with the probe */

function dirFacts(index: number): WindowsFileFacts {
  const identity = dirIdentity(index);
  return { kind: "directory", dev: identity.dev, ino: identity.ino, size: 0n, mtimeNs: 100n, ctimeNs: 100n, birthtimeNs: identity.birthtimeNs };
}

function peImage(): Buffer {
  const bytes = Buffer.alloc(Number(IMAGE.size));
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(5, 0x86);
  bytes.writeUInt16LE(240, 0x80 + 20);
  bytes.writeUInt16LE(0x0022, 0x80 + 22);
  bytes.writeUInt16LE(0x20b, 0x80 + 24);
  bytes.writeUInt16LE(3, 0x80 + 24 + 68);
  return bytes;
}

class FakeFs implements WindowsProbeFileSystem {
  readonly entries = new Map<string, WindowsFileFacts>();
  readonly bytes = peImage();
  constructor() {
    ANCESTORS.forEach((path, index) => this.entries.set(path, dirFacts(index)));
    this.entries.set(FILE, { kind: "file", ...IMAGE });
  }
  async lstat(path: string): Promise<WindowsFileFacts> {
    const facts = this.entries.get(path);
    if (facts === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" });
    return facts;
  }
  async open(path: string): Promise<WindowsFileHandle> {
    const facts = this.entries.get(path)!;
    return {
      stat: async () => facts,
      read: async (position, length) => this.bytes.subarray(position, position + length),
      close: async () => { /* nothing held */ },
    };
  }
}

function probeWith(behavior: Behavior, env: NodeJS.ProcessEnv = SOURCE_ENV) {
  const fake = runner(behavior);
  const outcome = probeWindowsClaudeVersion({
    target: { route: "direct-native-exe", rowId: "row-1", file: FILE, identity: { dev: IMAGE.dev, ino: IMAGE.ino, size: IMAGE.size, mtimeNs: IMAGE.mtimeNs, ctimeNs: IMAGE.ctimeNs } },
    isCurrent: () => true,
    env,
    deps: { platform: "win32", fs: new FakeFs(), runner: fake.instance },
  });
  return { ...fake, outcome };
}

test("composed: a SystemRoot-only source environment runs with its canonical empty placeholders", async () => {
  const minimal = probeWith(spawned((child) => child.finish(exitedRecord({ capture: "1", total: 2 }), 0)), { SystemRoot: "C:\\Windows" });
  assert.equal((await minimal.outcome).evidence, "version");
  assert.equal(minimal.calls.length, 1);
  const canonicalTarget = {
    SystemRoot: "C:\\Windows", SystemDrive: "", windir: "", TEMP: "", TMP: "",
    HOMEDRIVE: "", HOMEPATH: "", LOGONSERVER: "", PATH: "", USERDOMAIN: "", USERNAME: "", USERPROFILE: "",
  };
  // The helper gets only the trusted USERPROFILE beyond the placeholders; the target block keeps them all empty.
  assert.deepEqual(minimal.calls[0]!.options.env, { ...canonicalTarget, USERPROFILE: PROFILE });
  assert.deepEqual(targetEnvOf(minimal.children[0]!.frame.toString("ascii")), canonicalTarget);
  // A canonical shape is still exact: an empty SystemRoot or an extra name is refused before any spawn.
  const canonical = buildWindowsClaudeVersionEnvironment({ SystemRoot: "C:\\Windows" })!;
  for (const env of [{ ...canonical, SystemRoot: "" }, { ...canonical, ComSpec: "" }, { ...canonical, TEMP: "relative" }]) {
    const { instance, calls } = runner(spawned((child) => child.finish(exitedRecord(), 0)));
    assert.deepEqual(await instance.run(spec({ env }), BOUNDS, () => 0), { exactChild: "not-created" });
    assert.equal(calls.length, 0);
  }
});

test("composed: BOM-prefixed stdout never yields version evidence", async () => {
  const bomOut = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(OUT)]);
  const bom = probeWith(spawned((child) => child.finish(exitedRecord({ capture: "1", total: 2, out: bomOut.toString("base64"), bytes: bomOut.length }), 0)));
  assert.deepEqual(await bom.outcome, { evidence: "refused", reason: "version-unrecognized", process: "exact-child-exited", descendants: "witnessed-empty" });
});

test("composed: a verified record yields version evidence; a before-resume refusal or unsettled run never does", async () => {
  const good = probeWith(spawned((child) => child.finish(exitedRecord({ capture: "1", total: 2 }), 0)));
  const outcome = await good.outcome;
  assert.deepEqual(outcome, {
    evidence: "version",
    version: CLAUDE_INBOX_MIN_CLI_VERSION,
    rowId: "row-1",
    file: FILE,
    identity: { dev: IMAGE.dev, ino: IMAGE.ino, size: IMAGE.size, mtimeNs: IMAGE.mtimeNs, ctimeNs: IMAGE.ctimeNs },
    lifecycle: { launch: "suspended-image-name-matched", exactChild: "exited-clean", descendants: "witnessed-empty" },
  });
  // The runner rendered the probe's own held-handle identities.
  const frame = good.children[0]!.frame.toString("ascii");
  assert.deepEqual(list(frame, "AncI"), CHAIN.map((entry) => entry.ino.toString()));
  assert.equal(literal(frame, "ImgC"), ticks(IMAGE.ctimeNs));

  const preResume = probeWith(spawned((child) => child.finish(`PRG-WVR1 ${NONCE} PRERESUME image-mismatch ACTIVE=0 LISTED=0\n`, WINDOWS_CLAUDE_VERSION_RUNNER_EXIT["terminated-before-resume"]!)));
  assert.deepEqual(await preResume.outcome, { evidence: "refused", reason: "launch-unverified", process: "exact-child-exited", descendants: "witnessed-empty" });

  const notCreated = probeWith(spawned((child) => child.finish(`PRG-WVR1 ${NONCE} NOTCREATED ancestor-identity\n`, WINDOWS_CLAUDE_VERSION_RUNNER_EXIT["not-created"]!)));
  assert.deepEqual(await notCreated.outcome, { evidence: "refused", reason: "spawn-failed", process: "none" });

  const unsettled = probeWith(spawned((child) => child.finish(`PRG-WVR1 ${NONCE} UNSETTLED teardown\n`, WINDOWS_CLAUDE_VERSION_RUNNER_EXIT.unsettled!)));
  assert.deepEqual(await unsettled.outcome, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" });

  const stale = probeWith(spawned((child) => child.finish(exitedRecord().replace(NONCE, "e".repeat(32)), 0)));
  assert.deepEqual(await stale.outcome, { evidence: "unsettled", reason: "cleanup-unconfirmed", descendants: "unproven" });

  const oversized = probeWith(spawned((child) => child.finish(exitedRecord({ kind: "oversized", capture: "-", out: "", bytes: 5000 }), 0)));
  assert.deepEqual(await oversized.outcome, { evidence: "refused", reason: "oversized", process: "exact-child-exited", descendants: "witnessed-empty" });
});

test("composition: the runner states its trust boundary, accepted limitation, and its real Windows observation", () => {
  const text = readFileSync(RUNNER_SOURCE_PATH, "utf8");
  assert.ok(text.includes("## Trust boundary (approved) and accepted limitation"));
  assert.ok(text.includes("does NOT\n * independently verify the child's working directory"));
  assert.ok(text.includes("NOT sandbox or defend against an attacker running as the same user"));
  assert.ok(text.includes("This exact script was observed on real Windows (stock\n * PowerShell 5.1, helper-only `USERPROFILE`) before wiring"));
  assert.doesNotMatch(text, /INACTIVE|no product path/u);
  assert.doesNotMatch(text, /bound-to-expected/u);
});
