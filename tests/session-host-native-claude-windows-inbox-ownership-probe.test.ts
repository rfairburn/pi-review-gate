/**
 * #682 probe: Windows Claude inbox named-pipe ownership BEFORE any token byte.
 * This is diagnosis evidence. It does not wire anything into the product and
 * does not claim acceptance.
 *
 * Primary provider evidence (public Claude Code cross-session messaging docs,
 * code.claude.com/docs/en/cross-session-messaging):
 * - On native Windows (Claude Code v2.1.234 or later) the per-session inbox is
 *   a named pipe, not a Unix socket.
 * - Every connection must authenticate first with an auth line. Claude Code
 *   closes a connection whose first line is not a valid auth line and delivers
 *   nothing from it.
 * - `CLAUDE_CODE_MESSAGING_SOCKET` is exported before any hook runs, including
 *   `SessionStart`. `CLAUDE_CODE_MESSAGING_TOKEN` is exported alongside it.
 * - The docs say nothing about how a SENDER can verify who serves the pipe. So
 *   before a hook token is written, a sender must prove that the server end of
 *   the ACTUAL connection belongs to the launch it owns. A same-user process
 *   could otherwise serve the announced name, either first or after Claude
 *   exits, and receive the token.
 *
 * Mechanism under test. The process that holds the connection calls kernel32
 * `GetNamedPipeServerProcessId` on its own connected client handle. The client
 * connects with identification-only impersonation, so the server cannot
 * impersonate it. Node cannot read the server PID of its own `net` pipe handle.
 * The connection is therefore held by one bounded Windows PowerShell 5.1
 * helper. It reports the server PID, then writes nothing until this process
 * explicitly answers `SEND`.
 *
 * Proof rule ("pinned target"). The sampled server PID must equal the PID of
 * the target that the job host created, and whose creation handle it still
 * holds. After the sample, the job host must answer a live acknowledgement
 * (`PRG_JOB_PIN_LIVE`, from `WaitForSingleObject(handle, 0) == WAIT_TIMEOUT`).
 * Windows does not reuse a PID while any handle to its process is open. Since
 * that handle was held from creation through the acknowledgement, the sampled
 * PID named that exact process instance. Any other server PID is refused as
 * `server-not-pinned-target`. It is not certified later. A CIM ancestry
 * snapshot (`verifyWindowsProcessLineage`) cannot bind an earlier numeric
 * sample to the process instance it later finds, so lineage appears here only
 * as DIAGNOSTIC evidence in the descendant and orphan fixtures, never as a
 * proof.
 *
 * Containment. Every probed target (fixture servers and Claude) runs inside a
 * job object owned by a PowerShell "job host". The job host is a direct Node
 * child, so Node holds its process handle. It creates the job with
 * KILL_ON_JOB_CLOSE. It then creates the target SUSPENDED and already IN that
 * job, with no inherited handles and a hidden console. It does this atomically
 * through `PROC_THREAD_ATTRIBUTE_JOB_LIST` (Windows 10 or later):
 * `CreateProcessW` either creates the process inside the job or creates
 * nothing, so there is no uncontained interval. Only then does it resume the
 * target. Stopping terminates the job through its handle only, never by PID, so
 * descendants that outlived the target are still reached. The job host then
 * reports `SETTLED` only when the job's ActiveProcesses count is zero, and
 * Node waits for that line under a deadline. If the job host dies, the kernel's
 * kill-on-close terminates every member.
 *
 * Interop compilation. Neither PowerShell process compiles anything. Before
 * each test body, Node runs the inbox .NET Framework compiler
 * (`%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe`) once, as a
 * directly registered child with a deadline. It compiles both kernel32 interop
 * types into one DLL inside the test's owned scratch, with TEMP/TMP pointed at
 * that scratch. The job host and the pipe helper only `LoadFrom` that DLL, so
 * they have no compiler child. A compiler that overruns its deadline is killed
 * through Node's process handle like every other owned process. A test deletes
 * its scratch only after every process and tree it owns has confirmed
 * settlement. Otherwise it keeps the scratch, names it, and fails. The kernel32
 * interop and job-object patterns follow `src/background-shell/jobs.ts`.
 *
 * Legs and what each one proves:
 * - Portable (any OS): only this file's own strict parsers, quoting, and
 *   ownership decision, using fake roots. This is NOT Windows evidence.
 * - Native Windows fixture (win32 only, no provider), on real named pipes:
 *   (a) The job's target serves the pipe. It is proven by the pinned-target
 *   rule, then receives one inert marker. (b) DIAGNOSTIC: the target's child
 *   serves. The pinned rule refuses it, and lineage is recorded only as an
 *   experiment, with no byte sent. (c) An impostor, namely this test process,
 *   is refused and receives zero bytes. (d) DIAGNOSTIC: a target exits while
 *   its detached child keeps serving. The orphan is refused, and stopping the
 *   job still removes it. (e) A target that never becomes ready still settles
 *   through the job. This proves the mechanism and its cleanup. It is not
 *   evidence about Claude.
 * - Genuine Claude (win32 only, double opt-in, disposable offline VM ONLY):
 *   launches an already installed `claude.exe` once, inside the job, in `-p`
 *   mode with an owned `--settings` file. That file's root `SessionStart` hook
 *   records the announced pipe path and whether a token is present. It never
 *   records the token. The hook holds `SessionStart` open while this test
 *   applies the pinned-target rule to the pipe server, then closes WITHOUT
 *   writing a byte, whatever the verdict. No token or message is ever sent. A
 *   server that is not the pinned `claude.exe` (for example, a Claude child
 *   process) is reported as the precise blocker `server-not-pinned-target`.
 *   Every outcome prints as a fixed stage name.
 *
 * Why a disposable offline VM. A scratch home, `CLAUDE_CONFIG_DIR`, an
 * allowlisted environment, and a loopback `ANTHROPIC_BASE_URL` cannot isolate a
 * launch from machine-managed Claude policy, account credential stores, or
 * other network destinations on a real workstation. The genuine leg therefore
 * runs only when BOTH are set:
 *   PRG_CLAUDE_WINDOWS_INBOX_PROBE_CLI=<absolute path to an installed claude.exe>
 *   PRG_CLAUDE_WINDOWS_INBOX_PROBE_DISPOSABLE_VM=offline-no-credentials-no-managed-settings
 * The second value is the operator's attestation. The leg also fails closed
 * before launching if it can detect a violation: a known managed-settings
 * file or policy key, an ambient provider/credential variable, a known
 * user-level credential file, or a reachable external network (a DNS lookup or
 * a bare TCP connect that sends no data). These preflights are best-effort.
 * The attestation is what carries the isolation claim.
 *
 * Runnable VM procedure (operator-run; not executed by this repository):
 *  1. Create a fresh, disposable Windows 10/11 VM or Windows Sandbox (Windows 10+
 *     is needed for the job-list attribute and for nested jobs). Use a local account that never
 *     signs in to Claude. Apply no MDM/GPO or managed Claude settings.
 *  2. Confirm the inbox .NET Framework 4.x compiler exists at
 *     `%SystemRoot%\Microsoft.NET\Framework\v4.0.30319\csc.exe` (it is part of
 *     Windows 10/11). While the VM still has network, place in it: Node 22 or
 *     24, Git for Windows (Claude's hook shell), a copy of this repository at the commit
 *     under test with `npm ci` done, and a Claude Code native build >= 2.1.234
 *     installed by the operator. This repository installs nothing.
 *  3. Disable every network adapter in the VM, then confirm that
 *     `Resolve-DnsName api.anthropic.com` fails.
 *  4. `npm run build:test`
 *  5. Fixture legs only: `node --test dist-test/tests/session-host-native-claude-windows-inbox-ownership-probe.test.js`.
 *     Also exercise one forced compiler deadline (for example by temporarily
 *     lowering HELPER_DEADLINE_MS in a scratch copy). It must leave no `csc.exe`
 *     process and no files outside the owned scratch. Likewise force one
 *     registry-preflight deadline (an inert child that stays alive in place of
 *     the registry helper, in a scratch copy). The genuine leg must refuse with
 *     `vm-preflight:managed-claude-policy-query-unavailable`, the child must
 *     exit, and the scratch must be removed. Also force a loopback bind error
 *     for the provider sink. It must refuse and remove the scratch. Neither
 *     check needs a provider launch.
 *  6. Genuine leg: set both variables above in the same shell, then rerun step 5.
 *     Record the single `claude-windows-inbox-probe {...}` line. It carries
 *     only a fixed stage, the version, PIDs, and the decision.
 *  7. Discard the VM. A run on a non-disposable host is out of contract.
 *
 * Neither win32 leg runs in CI: the Windows workflows list their test files
 * explicitly, and this probe adds no CI wiring. On Linux/macOS every win32 leg
 * is an honest skip.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  MAX_WINDOWS_PROCESS_ID,
  verifyWindowsProcessLineage,
  type WindowsLineageVerification,
} from "../src/execution/windows-process-lineage";
import { isNativeConversationId } from "../src/session-host/native-conversation";

const CLI_ENV = "PRG_CLAUDE_WINDOWS_INBOX_PROBE_CLI";
const VM_ENV = "PRG_CLAUDE_WINDOWS_INBOX_PROBE_DISPOSABLE_VM";
const VM_ATTESTATION = "offline-no-credentials-no-managed-settings";
/** Documented native Windows minimum for cross-session messaging. */
const WINDOWS_MESSAGING_MIN_VERSION: readonly [number, number, number] = [2, 1, 234];
const HELPER_DEADLINE_MS = 30_000;
const SESSION_START_DEADLINE_MS = 120_000;
const EXIT_DEADLINE_MS = 20_000;
/** Bound for each managed-policy registry query in the VM preflight. */
const REG_QUERY_DEADLINE_MS = 5_000;
/** Job host: terminate + prove empty within this bound (seconds, in its script). */
const JOB_SETTLE_SECONDS = 15;
const MARKER = "prg-claude-inbox-probe-marker\n";
const CREDENTIAL_NAME = /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|OAUTH|PASSWORD|SECRET|CREDENTIAL|BEARER)/i;
const PROVIDER_NAME = /^(?:ANTHROPIC_|CLAUDE_|AWS_BEARER|CLOUD_ML_|VERTEX_|GOOGLE_APPLICATION_CREDENTIALS$)/i;
/** Inherited names the Claude leg may keep. Everything else, including proxies, is dropped. */
const ENV_ALLOWLIST = [
  "SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "PATH", "PATHEXT",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS", "CLAUDE_CODE_GIT_BASH_PATH",
] as const;
/** Non-credential variables the VM contract allows despite a provider-like prefix. */
const AMBIENT_ALLOWED = new Set<string>([CLI_ENV, VM_ENV, "CLAUDE_CODE_GIT_BASH_PATH"]);

const onWindows = process.platform === "win32";
const nativeOnly = { skip: onWindows ? false : "native Windows named-pipe probe; this host is not win32", timeout: 180_000 };

// ---------------------------------------------------------------------------
// Pure, portable pieces (tested below on every OS; not Windows evidence).

/** Local named-pipe path in the only accepted spelling, or `undefined`. */
function localPipeName(path: unknown): string | undefined {
  if (typeof path !== "string") return undefined;
  const match = /^\\\\\.\\pipe\\([\x21-\x7e]{1,240})$/.exec(path);
  // A single quote would end the helper's PowerShell literal; `"` is never a valid pipe character.
  if (!match || /['"]/.test(match[1]!)) return undefined;
  // The helper's .NET client normalizes the path it builds: a separator or a trailing dot could
  // make it open a different pipe than the one announced, which a later PID match cannot detect.
  const name = match[1]!;
  if (name.includes("/") || name.includes("\\") || name.endsWith(".")) return undefined;
  return name;
}

type HelperLine =
  | { kind: "server"; serverPid: number; serverSession: number }
  | { kind: "refused"; stage: string }
  | { kind: "sent"; bytes: number }
  | { kind: "closed" };

const HELPER_STAGES = ["interop-load", "connect-timeout", "connect-failed", "server-pid", "server-session", "write-failed"] as const;

/** Strictly parse one pipe-helper stdout line; anything else is `undefined`. */
function parseHelperLine(line: string): HelperLine | undefined {
  let match = /^PRG_PROBE_SERVER pid=(\d{1,10}) session=(\d{1,10})$/.exec(line);
  if (match) {
    const serverPid = Number(match[1]);
    const serverSession = Number(match[2]);
    if (serverPid <= 0 || serverPid > MAX_WINDOWS_PROCESS_ID || serverSession > MAX_WINDOWS_PROCESS_ID) return undefined;
    return { kind: "server", serverPid, serverSession };
  }
  match = /^PRG_PROBE_NO ([a-z-]+)$/.exec(line);
  if (match) return (HELPER_STAGES as readonly string[]).includes(match[1]!) ? { kind: "refused", stage: match[1]! } : undefined;
  match = /^PRG_PROBE_SENT (\d{1,6})$/.exec(line);
  if (match) return { kind: "sent", bytes: Number(match[1]) };
  return line === "PRG_PROBE_CLOSED" ? { kind: "closed" } : undefined;
}

type JobLine =
  | { kind: "started"; targetPid: number }
  | { kind: "pin-live" }
  | { kind: "pin-dead" }
  | { kind: "refused"; stage: string }
  | { kind: "target-exited" }
  | { kind: "settled" }
  | { kind: "unsettled" };

const JOB_STAGES = ["interop-load", "job-create", "job-limit", "job-attributes", "create-process", "resume"] as const;

/** Strictly parse one job-host stdout line; anything else is `undefined`. */
function parseJobLine(line: string): JobLine | undefined {
  const started = /^PRG_JOB_STARTED pid=(\d{1,10})$/.exec(line);
  if (started) {
    const targetPid = Number(started[1]);
    return targetPid > 0 && targetPid <= MAX_WINDOWS_PROCESS_ID ? { kind: "started", targetPid } : undefined;
  }
  const refused = /^PRG_JOB_NO ([a-z-]+)$/.exec(line);
  if (refused) return (JOB_STAGES as readonly string[]).includes(refused[1]!) ? { kind: "refused", stage: refused[1]! } : undefined;
  if (line === "PRG_JOB_TARGET_EXITED") return { kind: "target-exited" };
  if (line === "PRG_JOB_PIN_LIVE") return { kind: "pin-live" };
  if (line === "PRG_JOB_PIN_DEAD") return { kind: "pin-dead" };
  if (line === "PRG_JOB_SETTLED") return { kind: "settled" };
  return line === "PRG_JOB_UNSETTLED" ? { kind: "unsettled" } : undefined;
}

/** MSVCRT/CommandLineToArgvW quoting for one argument. */
function quoteWindowsArg(arg: string): string {
  if (arg !== "" && !/[\s"]/.test(arg)) return arg;
  let out = "\"";
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    out += ch === "\"" ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${ch}`;
    backslashes = 0;
  }
  return `${out}${"\\".repeat(backslashes * 2)}"`;
}

/** Single-quoted PowerShell literal. PowerShell treats ' and the typographic quotes U+2018-U+201B alike as delimiters. */
function psLiteral(value: string): string {
  return `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;
}

type OwnershipDecision =
  | { owned: true; via: "launched-root" | "verified-descendant" }
  | { owned: false; reason: string };

type LineageVerifier = (root: ChildProcess, candidatePid: number) => Promise<WindowsLineageVerification>;
type RootLike = Pick<ChildProcess, "pid" | "exitCode" | "signalCode">;

function isLive(root: RootLike): boolean {
  return Number.isSafeInteger(root.pid) && (root.pid ?? 0) > 0 && root.exitCode === null && root.signalCode === null;
}

/**
 * DIAGNOSTIC ONLY: what CIM ancestry says about a sampled server PID. It is
 * never a proof here, because a later ancestry snapshot cannot bind an earlier
 * numeric pipe sample to the process instance it finds. The proof rule is
 * {@link decidePinnedOwnership}.
 */
async function decidePipeOwnership(
  root: RootLike,
  serverPid: number,
  verifyLineage: LineageVerifier = verifyWindowsProcessLineage,
): Promise<OwnershipDecision> {
  if (!Number.isSafeInteger(serverPid) || serverPid <= 0 || serverPid > MAX_WINDOWS_PROCESS_ID) {
    return { owned: false, reason: "server-pid-invalid" };
  }
  if (!isLive(root)) return { owned: false, reason: "launched-root-not-live" };
  if (serverPid === root.pid) return { owned: true, via: "launched-root" };
  const lineage = await verifyLineage(root as ChildProcess, serverPid);
  if (!lineage.verified) return { owned: false, reason: `lineage:${lineage.reason}` };
  // Lineage itself rechecks the root after its query; recheck once more at binding.
  return isLive(root) ? { owned: true, via: "verified-descendant" } : { owned: false, reason: "launched-root-not-live" };
}

/** `x.y.z (Claude Code)` at or above the documented Windows minimum, else `undefined`. */
function supportedWindowsClaudeVersion(stdout: string): string | undefined {
  const match = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6}) \(Claude Code\)\r?\n?$/.exec(stdout);
  if (!match) return undefined;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let index = 0; index < 3; index += 1) {
    if (parts[index]! > WINDOWS_MESSAGING_MIN_VERSION[index]!) break;
    if (parts[index]! < WINDOWS_MESSAGING_MIN_VERSION[index]!) return undefined;
  }
  return parts.join(".");
}

interface HookRecord {
  readonly event: unknown;
  readonly agentIdAbsent: unknown;
  readonly sessionId: unknown;
  readonly socketPath: unknown;
  readonly tokenPresent: unknown;
  readonly hookPid: unknown;
}

/** The hook record's fixed-stage verdict (never echoes the record). */
function classifyHookRecord(record: HookRecord): { ok: true; pipeName: string } | { ok: false; stage: string } {
  if (record.event !== "SessionStart") return { ok: false, stage: "hook-not-session-start" };
  if (record.agentIdAbsent !== true) return { ok: false, stage: "hook-not-root-scope" };
  if (!isNativeConversationId(record.sessionId)) return { ok: false, stage: "hook-session-id-invalid" };
  if (record.socketPath === null || record.socketPath === undefined) return { ok: false, stage: "socket-not-announced" };
  const pipeName = localPipeName(record.socketPath);
  if (pipeName === undefined) return { ok: false, stage: "socket-not-local-named-pipe" };
  if (record.tokenPresent !== true) return { ok: false, stage: "token-not-announced" };
  return { ok: true, pipeName };
}

/** Ambient variables the disposable-VM contract forbids (names only). */
function forbiddenAmbientNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((key) => !AMBIENT_ALLOWED.has(key))
    .filter((key) => CREDENTIAL_NAME.test(key) || PROVIDER_NAME.test(key))
    .sort();
}

// ---------------------------------------------------------------------------
// Generated scripts.

/** C# 5 pipe interop, compiled once per test by the owned compiler child. */
const PIPE_TYPE = "using System; using System.Runtime.InteropServices; public static class PrgClaudeInboxProbePipe { "
  + "[DllImport(\"kernel32.dll\",SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(IntPtr h,out uint p); "
  + "[DllImport(\"kernel32.dll\",SetLastError=true)] public static extern bool GetNamedPipeServerSessionId(IntPtr h,out uint s); }";

/** The bounded connection-holding helper script for one validated pipe name; it loads, never compiles. */
function helperScript(pipeName: string, interop: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `try { [void][System.Reflection.Assembly]::LoadFrom(${psLiteral(interop)}) } `
      + "catch { [Console]::Out.WriteLine('PRG_PROBE_NO interop-load'); exit 3 }",
    // Identification-only impersonation: the server can identify, never impersonate, this client.
    `$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', ${psLiteral(pipeName)}, [System.IO.Pipes.PipeDirection]::InOut, `
      + "[System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::Identification)",
    "try { $client.Connect(10000) } catch [System.TimeoutException] { [Console]::Out.WriteLine('PRG_PROBE_NO connect-timeout'); exit 4 } "
      + "catch { [Console]::Out.WriteLine('PRG_PROBE_NO connect-failed'); exit 4 }",
    "$handle = $client.SafePipeHandle.DangerousGetHandle()",
    "$serverPid = [uint32]0; $serverSession = [uint32]0",
    "if (-not [PrgClaudeInboxProbePipe]::GetNamedPipeServerProcessId($handle, [ref]$serverPid)) { [Console]::Out.WriteLine('PRG_PROBE_NO server-pid'); $client.Dispose(); exit 5 }",
    "if (-not [PrgClaudeInboxProbePipe]::GetNamedPipeServerSessionId($handle, [ref]$serverSession)) { [Console]::Out.WriteLine('PRG_PROBE_NO server-session'); $client.Dispose(); exit 5 }",
    "[Console]::Out.WriteLine(\"PRG_PROBE_SERVER pid=$serverPid session=$serverSession\"); [Console]::Out.Flush()",
    // Nothing is written until the owner explicitly answers SEND after its own verification.
    "$decision = [Console]::In.ReadLine()",
    "if ($decision -ceq 'SEND') {",
    `  try { $bytes = [System.Text.Encoding]::UTF8.GetBytes(${psLiteral(MARKER.slice(0, -1))} + [char]10); `
      + "$client.Write($bytes, 0, $bytes.Length); $client.Flush(); [Console]::Out.WriteLine(\"PRG_PROBE_SENT $($bytes.Length)\") } "
      + "catch { [Console]::Out.WriteLine('PRG_PROBE_NO write-failed'); $client.Dispose(); exit 6 }",
    "} else { [Console]::Out.WriteLine('PRG_PROBE_CLOSED') }",
    "$client.Dispose()",
    "exit 0",
  ].join("\n");
}

/** C# 5 job interop, compiled once per test by the owned compiler child. */
const JOB_TYPE = [
  "using System; using System.Runtime.InteropServices; using System.Text;",
  "public static class PrgClaudeInboxProbeJob {",
  "[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;",
  " public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;",
  " public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }",
  "[StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }",
  "[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr AttributeList; }",
  "[DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool CreateProcessW(string a,StringBuilder c,IntPtr pa,IntPtr ta,bool inh,uint f,IntPtr e,string d,ref STARTUPINFOEX si,out PROCESS_INFORMATION pi);",
  "[DllImport(\"kernel32.dll\",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);",
  "[DllImport(\"kernel32.dll\",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returnedSize);",
  "[DllImport(\"kernel32.dll\")] static extern void DeleteProcThreadAttributeList(IntPtr list);",
  "[DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr a,string n);",
  "[DllImport(\"kernel32.dll\",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr i,uint l);",
  "[DllImport(\"kernel32.dll\",SetLastError=true)] static extern bool TerminateJobObject(IntPtr j,uint e);",
  "[DllImport(\"kernel32.dll\",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,IntPtr b,uint n,IntPtr r);",
  "[DllImport(\"kernel32.dll\",SetLastError=true)] static extern uint ResumeThread(IntPtr t);",
  "[DllImport(\"kernel32.dll\",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint ms);",
  "[DllImport(\"kernel32.dll\")] static extern bool CloseHandle(IntPtr h);",
  "[DllImport(\"advapi32.dll\",CharSet=CharSet.Unicode,ExactSpelling=true)] static extern int RegOpenKeyExW(IntPtr root,string name,uint options,int access,out IntPtr key);",
  "[DllImport(\"advapi32.dll\")] static extern int RegCloseKey(IntPtr key);",
  // Native status of the managed-policy key in both registry views (KEY_QUERY_VALUE | KEY_WOW64_64KEY / _32KEY):
  // 0 = present, 2 = ERROR_FILE_NOT_FOUND in both views, 3 = anything else (for example access denied).
  "public static int PolicyKeyStatus(bool machine) {",
  " IntPtr root = new IntPtr(machine ? unchecked((int)0x80000002) : unchecked((int)0x80000001));",
  " foreach (int access in new int[] { 0x101, 0x201 }) {",
  "  IntPtr key;",
  "  int status = RegOpenKeyExW(root,@\"SOFTWARE\\Policies\\ClaudeCode\",0,access,out key);",
  "  if (status == 0) { RegCloseKey(key); return 0; }",
  "  if (status != 2) { return 3; }",
  " }",
  " return 2; }",
  "static IntPtr job = IntPtr.Zero; static IntPtr proc = IntPtr.Zero; public static int Pid;",
  "public static string Start(string app,string cmd,string cwd) {",
  " job = CreateJobObjectW(IntPtr.Zero,null); if (job == IntPtr.Zero) { return \"job-create\"; }",
  // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000) via JobObjectExtendedLimitInformation (class 9); no breakaway flag.
  " int size = IntPtr.Size == 8 ? 144 : 112; IntPtr lim = Marshal.AllocHGlobal(size);",
  " try { for (int i = 0; i < size; i++) { Marshal.WriteByte(lim,i,0); } Marshal.WriteInt32(lim,16,0x2000); if (!SetInformationJobObject(job,9,lim,(uint)size)) { return \"job-limit\"; } } finally { Marshal.FreeHGlobal(lim); }",
  // PROC_THREAD_ATTRIBUTE_JOB_LIST (0x0002000D): the process is created inside the job, or not at all.
  " IntPtr bytes = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);",
  " if (bytes == IntPtr.Zero) { return \"job-attributes\"; }",
  " IntPtr attrs = Marshal.AllocHGlobal(bytes); IntPtr jobs = IntPtr.Zero; bool initialized = false; PROCESS_INFORMATION pi;",
  " try {",
  "  initialized = InitializeProcThreadAttributeList(attrs,1,0,ref bytes); if (!initialized) { return \"job-attributes\"; }",
  "  jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs,job);",
  "  if (!UpdateProcThreadAttribute(attrs,0,new IntPtr(0x0002000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) { return \"job-attributes\"; }",
  "  STARTUPINFOEX si = new STARTUPINFOEX(); si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); si.AttributeList = attrs;",
  // CREATE_NO_WINDOW (0x08000000) | EXTENDED_STARTUPINFO_PRESENT (0x00080000) | CREATE_SUSPENDED (0x4); no inherited handles.
  "  if (!CreateProcessW(app,new StringBuilder(cmd),IntPtr.Zero,IntPtr.Zero,false,0x08080004,IntPtr.Zero,cwd,ref si,out pi)) { return \"create-process\"; }",
  " } finally { if (initialized) { DeleteProcThreadAttributeList(attrs); } if (jobs != IntPtr.Zero) { Marshal.FreeHGlobal(jobs); } Marshal.FreeHGlobal(attrs); }",
  " proc = pi.hProcess; Pid = pi.dwProcessId;",
  " uint resumed = ResumeThread(pi.hThread); CloseHandle(pi.hThread); if (resumed == 0xFFFFFFFF) { return \"resume\"; }",
  " return \"ok\"; }",
  "public static bool TargetExited() { return proc != IntPtr.Zero && WaitForSingleObject(proc,0) == 0; }",
  // WAIT_TIMEOUT (258) through the creation handle: the pinned instance is still running.
  "public static bool TargetLive() { return proc != IntPtr.Zero && WaitForSingleObject(proc,0) == 258; }",
  "public static void TerminateAll() { if (job != IntPtr.Zero) { TerminateJobObject(job,1); } }",
  // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (class 1): ActiveProcesses at offset 40 of 48 bytes.
  "public static int ActiveProcesses() { if (job == IntPtr.Zero) { return 0; } IntPtr b = Marshal.AllocHGlobal(48); try { if (!QueryInformationJobObject(job,1,b,48,IntPtr.Zero)) { return -1; } return Marshal.ReadInt32(b,40); } finally { Marshal.FreeHGlobal(b); } }",
  "}",
].join(" ");

/**
 * Job host: contain one target and report it. Answer `V` pin queries. On any
 * other stdin input, a fault, or EOF, terminate the job through its handle and
 * prove it empty.
 */
function jobHostScript(app: string, commandLine: string, cwd: string, interop: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "function Say($m) { [Console]::Out.WriteLine($m); [Console]::Out.Flush() }",
    // No job and no target exist yet, so nothing can be left behind.
    `try { [void][System.Reflection.Assembly]::LoadFrom(${psLiteral(interop)}) } catch { Say 'PRG_JOB_NO interop-load'; Say 'PRG_JOB_SETTLED'; exit 3 }`,
    // A thrown marshalling error still falls through to job termination and the emptiness proof.
    `try { $started = [PrgClaudeInboxProbeJob]::Start(${psLiteral(app)}, ${psLiteral(commandLine)}, ${psLiteral(cwd)}) } catch { $started = 'create-process' }`,
    "$exitCode = 0",
    "if ($started -ne 'ok') { Say \"PRG_JOB_NO $started\"; $exitCode = 3 } else {",
    "  Say \"PRG_JOB_STARTED pid=$([PrgClaudeInboxProbeJob]::Pid)\"",
    // A single byte V asks whether the pinned target is live; any other input, a fault, or EOF means stop.
    "  $stdin = [Console]::OpenStandardInput(); $buffer = New-Object byte[] 16; $read = $stdin.ReadAsync($buffer, 0, 16)",
    "  $exitedSaid = $false",
    "  function ReadCompleted { try { return $read.Wait(200) } catch { return $true } }",
    "  while ($true) {",
    "    while (-not (ReadCompleted)) { if (-not $exitedSaid -and [PrgClaudeInboxProbeJob]::TargetExited()) { Say 'PRG_JOB_TARGET_EXITED'; $exitedSaid = $true } }",
    "    if ($read.Status -ne [System.Threading.Tasks.TaskStatus]::RanToCompletion -or $read.Result -ne 1 -or $buffer[0] -ne 86) { break }",
    "    if ([PrgClaudeInboxProbeJob]::TargetLive()) { Say 'PRG_JOB_PIN_LIVE' } else { Say 'PRG_JOB_PIN_DEAD' }",
    "    $read = $stdin.ReadAsync($buffer, 0, 16)",
    "  }",
    "}",
    // Through the job handle only: reaches descendants that outlived the target; never a PID.
    "[PrgClaudeInboxProbeJob]::TerminateAll()",
    `$deadline = [DateTime]::UtcNow.AddSeconds(${JOB_SETTLE_SECONDS}); $active = -1`,
    "do { $active = [PrgClaudeInboxProbeJob]::ActiveProcesses(); if ($active -eq 0) { break }; Start-Sleep -Milliseconds 100 } while ([DateTime]::UtcNow -lt $deadline)",
    "if ($active -eq 0) { Say 'PRG_JOB_SETTLED'; exit $exitCode } else { Say 'PRG_JOB_UNSETTLED'; exit 7 }",
  ].join("\n");
}

/** Fixture target: events go to a file (the target has a hidden console, no pipes). */
const SERVER_SCRIPT = `"use strict";
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
const [mode, pipeName, events] = process.argv.slice(2);
const log = (line) => fs.appendFileSync(events, line + "\\n");
if (mode === "idle") {
  setInterval(() => {}, 1 << 30);
} else if (mode === "parent" || mode === "orphan") {
  const child = spawn(process.execPath, [__filename, "server", pipeName, events], { stdio: "ignore", windowsHide: true, detached: mode === "orphan" });
  log("CHILD " + child.pid);
  if (mode === "orphan") {
    child.unref();
    const poll = setInterval(() => {
      if (fs.readFileSync(events, "utf8").includes("LISTENING ")) { clearInterval(poll); process.exit(0); }
    }, 50);
  } else {
    setInterval(() => {}, 1 << 30);
  }
} else {
  const server = net.createServer((socket) => {
    let total = 0;
    log("ACCEPT");
    socket.on("data", (chunk) => { total += chunk.length; log("DATA " + chunk.length + " " + (chunk.toString("utf8") === ${JSON.stringify(MARKER)} ? "marker" : "other")); });
    socket.on("error", () => {});
    socket.on("close", () => log("END " + total));
  });
  server.listen("\\\\\\\\.\\\\pipe\\\\" + pipeName, () => log("LISTENING " + process.pid));
}
`;

const HOOK_SCRIPT = `"use strict";
const fs = require("node:fs");
const [recordPath, releasePath] = process.argv.slice(2);
let input = "";
let done = false;
function finish() {
  if (done) return;
  done = true;
  let payload = {};
  try { payload = JSON.parse(input); } catch {}
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  // The token itself is never written: only whether one is present.
  const record = {
    event: typeof payload.hook_event_name === "string" ? payload.hook_event_name : null,
    agentIdAbsent: payload !== null && typeof payload === "object" && !Object.prototype.hasOwnProperty.call(payload, "agent_id"),
    sessionId: typeof payload.session_id === "string" ? payload.session_id : null,
    socketPath: typeof socket === "string" ? socket : null,
    tokenPresent: typeof token === "string" && token.length > 0,
    hookPid: process.pid,
  };
  fs.writeFileSync(recordPath + ".tmp", JSON.stringify(record), { flag: "wx", mode: 0o600 });
  fs.renameSync(recordPath + ".tmp", recordPath);
  // Hold SessionStart open (bounded) while the owner proves the pipe server.
  const deadline = Date.now() + 90000;
  const poll = setInterval(() => {
    if (fs.existsSync(releasePath) || Date.now() > deadline) { clearInterval(poll); process.exit(0); }
  }, 100);
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { if (input.length < 65536) input += chunk; });
process.stdin.on("end", finish);
setTimeout(finish, 5000);
`;

// ---------------------------------------------------------------------------
// Native process plumbing (exercised only on win32).

function systemPath(...parts: string[]): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("SystemRoot is not an absolute path");
  return join(systemRoot, "System32", ...parts);
}

function windowsRootPath(...parts: string[]): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("SystemRoot is not an absolute path");
  return join(systemRoot, ...parts);
}

function powershellEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
}

function encoded(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

/** Line reader over one child stream, with bounded waits. */
class Lines {
  private readonly lines: string[] = [];
  private buffered = "";
  private ended = false;
  private wake: (() => void) | undefined;
  constructor(stream: NodeJS.ReadableStream) {
    stream.setEncoding?.("utf8");
    stream.on("data", (chunk: string) => {
      this.buffered += chunk;
      if (this.buffered.length > 64 * 1024) this.buffered = this.buffered.slice(-64 * 1024);
      let index: number;
      while ((index = this.buffered.indexOf("\n")) >= 0) {
        this.lines.push(this.buffered.slice(0, index).replace(/\r$/, ""));
        this.buffered = this.buffered.slice(index + 1);
      }
      this.wake?.();
    });
    stream.on("end", () => {
      this.ended = true;
      this.wake?.();
    });
    stream.on("error", () => {
      this.ended = true;
      this.wake?.();
    });
  }
  seen(): string[] {
    return [...this.lines];
  }
  /** Number of complete lines seen so far (a start index for {@link next}). */
  count(): number {
    return this.lines.length;
  }
  async next(predicate: (line: string) => boolean, deadlineMs: number, from = 0): Promise<string | undefined> {
    const deadline = Date.now() + deadlineMs;
    for (let cursor = from; ;) {
      while (cursor < this.lines.length) {
        const line = this.lines[cursor++]!;
        if (predicate(line)) return line;
      }
      if (this.ended || Date.now() >= deadline) return undefined;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
  }
}

function waitForExit(child: ChildProcess, deadlineMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), deadlineMs);
    const done = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", done);
    // A spawn failure emits `error` and may never emit `exit`: nothing is running.
    child.once("error", () => {
      if (child.pid === undefined) done();
    });
  });
}

/** One contained target and the job host (a direct Node child) that owns its job. */
interface ContainedTree {
  readonly host: ChildProcess;
  readonly lines: Lines;
  spawnFailed: boolean;
}

/** A direct Node child with no long-lived descendants (the pipe helper). */
interface OwnedProcess {
  readonly child: ChildProcess;
  spawnFailed: boolean;
}

/** Per-test ownership: everything is registered at spawn, and scratch is removed only after settlement. */
class Ownership {
  readonly scratch: string;
  readonly interop: string;
  private readonly trees: ContainedTree[] = [];
  private readonly processes: OwnedProcess[] = [];
  constructor() {
    this.scratch = realpathSync(mkdtempSync(join(tmpdir(), "prg-claude-win-inbox-")));
    this.interop = join(this.scratch, "inbox-interop.dll");
  }

  private trackProcess(child: ChildProcess): OwnedProcess {
    const owned: OwnedProcess = { child, spawnFailed: false };
    this.processes.push(owned);
    child.on("error", () => {
      if (child.pid === undefined) owned.spawnFailed = true;
    });
    child.stdin?.on("error", () => undefined);
    return owned;
  }

  /**
   * One registered, deadline-bound registry helper that exits with the native
   * key status from `PolicyKeyStatus`. Returns its exit code, or `null` on
   * spawn failure, signal, or timeout. A timed-out query is left to the
   * handle-backed settlement in {@link release}.
   */
  async queryManagedPolicy(machine: boolean): Promise<number | null> {
    const script = `$ErrorActionPreference = 'Stop'; [void][System.Reflection.Assembly]::LoadFrom(${psLiteral(this.interop)}); `
      + `exit ([PrgClaudeInboxProbeJob]::PolicyKeyStatus($${machine ? "true" : "false"}))`;
    const { child } = this.trackProcess(spawn(
      systemPath("WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(script)],
      { stdio: "ignore", windowsHide: true, env: powershellEnv(process.env) },
    ));
    if (!(await waitForExit(child, REG_QUERY_DEADLINE_MS))) return null;
    return child.exitCode;
  }

  /** Compile both interop types once, as a registered compiler child confined to owned scratch. */
  async prepareInterop(): Promise<void> {
    const pipe = join(this.scratch, "pipe.cs");
    const job = join(this.scratch, "job.cs");
    writeFileSync(pipe, PIPE_TYPE, { mode: 0o600 });
    writeFileSync(job, JOB_TYPE, { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(TEMP|TMP)$/i.test(key)));
    const compiler = this.trackProcess(spawn(
      windowsRootPath("Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
      ["/nologo", "/noconfig", "/target:library", `/out:${this.interop}`, pipe, job],
      { cwd: this.scratch, env: { ...env, TEMP: this.scratch, TMP: this.scratch }, stdio: "ignore", windowsHide: true },
    ));
    assert.ok(await waitForExit(compiler.child, HELPER_DEADLINE_MS), "interop compiler timed out");
    assert.equal(compiler.child.exitCode, 0, "interop compiler failed");
  }

  /** Start `app` (argv `args`) suspended inside a fresh kill-on-close job, then resume it. */
  contain(app: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, rawCommandLine?: string): ContainedTree {
    const commandLine = rawCommandLine ?? [app, ...args].map(quoteWindowsArg).join(" ");
    const host = spawn(
      systemPath("WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(jobHostScript(app, commandLine, cwd, this.interop))],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: powershellEnv(env) },
    );
    const tree: ContainedTree = { host, lines: new Lines(host.stdout!), spawnFailed: false };
    this.trees.push(tree);
    host.on("error", () => {
      if (host.pid === undefined) tree.spawnFailed = true;
    });
    host.stdin!.on("error", () => undefined);
    return tree;
  }

  async started(tree: ContainedTree): Promise<number> {
    const line = await tree.lines.next((candidate) => {
      const parsed = parseJobLine(candidate);
      return parsed?.kind === "started" || parsed?.kind === "refused";
    }, HELPER_DEADLINE_MS);
    const parsed = line === undefined ? undefined : parseJobLine(line);
    if (parsed?.kind !== "started") throw new Error(`job host did not start its target (${parsed?.kind === "refused" ? parsed.stage : "no answer"})`);
    return parsed.targetPid;
  }

  spawnHelper(pipeName: string): OwnedProcess {
    return this.trackProcess(spawn(
      systemPath("WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(helperScript(pipeName, this.interop))],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: powershellEnv(process.env) },
    ));
  }

  /** Settle one tree: STOP, then require SETTLED and a clean host exit. */
  async settleTree(tree: ContainedTree): Promise<boolean> {
    if (tree.spawnFailed || tree.host.pid === undefined) return true;
    if (tree.host.exitCode === null && tree.host.signalCode === null) tree.host.stdin!.end("STOP\n");
    const exited = await waitForExit(tree.host, (JOB_SETTLE_SECONDS + 10) * 1000);
    if (!exited) {
      // Handle-backed TerminateProcess on the host; kill-on-close then terminates every member,
      // but emptiness is no longer witnessed, so this path never counts as settled.
      tree.host.kill();
      await waitForExit(tree.host, EXIT_DEADLINE_MS);
      return false;
    }
    // Stdout may still be draining after `exit`: wait for the sentinel itself, under a deadline.
    const line = await tree.lines.next((candidate) => candidate === "PRG_JOB_SETTLED" || candidate === "PRG_JOB_UNSETTLED", EXIT_DEADLINE_MS);
    return line === "PRG_JOB_SETTLED";
  }

  async settleProcess(owned: OwnedProcess): Promise<boolean> {
    if (owned.spawnFailed || owned.child.pid === undefined) return true;
    if (await waitForExit(owned.child, 0)) return true;
    owned.child.kill();
    return waitForExit(owned.child, EXIT_DEADLINE_MS);
  }

  /** Settle everything; remove scratch only if every owned process settled. */
  async release(): Promise<{ ok: true } | { ok: false; retained: string }> {
    let ok = true;
    for (const owned of this.processes) ok = (await this.settleProcess(owned)) && ok;
    for (const tree of this.trees) ok = (await this.settleTree(tree)) && ok;
    if (!ok) return { ok: false, retained: this.scratch };
    rmSync(this.scratch, { recursive: true, force: true });
    return { ok: true };
  }
}

/** Run `body` with owned scratch and processes; cleanup failure is reported, never hidden. */
async function withOwnership(body: (own: Ownership) => Promise<void>): Promise<void> {
  const own = new Ownership();
  let failure: unknown;
  try {
    await own.prepareInterop();
    await body(own);
  } catch (error) {
    failure = error;
  }
  const released = await own.release();
  if (!released.ok) {
    const message = `cleanup unconfirmed: an owned process tree did not report settlement; scratch retained at ${released.retained}`;
    throw failure === undefined ? new Error(message) : new AggregateError([failure], message);
  }
  if (failure !== undefined) throw failure;
}

type PinnedDecision = { owned: true; via: "pinned-target" } | { owned: false; reason: string };

/**
 * The proof rule: the sampled server PID is the job host's pinned target, and
 * the host acknowledges, AFTER the sample, that its creation handle still
 * shows that instance running. Any other PID is refused, never certified later.
 */
async function decidePinnedOwnership(tree: ContainedTree, targetPid: number, serverPid: number): Promise<PinnedDecision> {
  if (serverPid !== targetPid) return { owned: false, reason: "server-not-pinned-target" };
  if (tree.host.exitCode !== null || tree.host.signalCode !== null) return { owned: false, reason: "job-host-not-live" };
  const from = tree.lines.count();
  tree.host.stdin!.write("V");
  const pin = await tree.lines.next((line) => line === "PRG_JOB_PIN_LIVE" || line === "PRG_JOB_PIN_DEAD", EXIT_DEADLINE_MS, from);
  return pin === "PRG_JOB_PIN_LIVE" ? { owned: true, via: "pinned-target" } : { owned: false, reason: "target-pin-not-confirmed" };
}

interface ProbeSession {
  readonly owned: OwnedProcess;
  readonly lines: Lines;
  readonly first: HelperLine | undefined;
}

async function connectHelper(own: Ownership, pipeName: string): Promise<ProbeSession> {
  const owned = own.spawnHelper(pipeName);
  const lines = new Lines(owned.child.stdout!);
  const line = await lines.next((candidate) => parseHelperLine(candidate) !== undefined, HELPER_DEADLINE_MS);
  return { owned, lines, first: line === undefined ? undefined : parseHelperLine(line) };
}

async function finishHelper(session: ProbeSession, decision: "SEND" | "CLOSE"): Promise<HelperLine | undefined> {
  session.owned.child.stdin!.end(`${decision}\n`);
  const line = await session.lines.next((candidate) => {
    const parsed = parseHelperLine(candidate);
    return parsed !== undefined && parsed.kind !== "server";
  }, HELPER_DEADLINE_MS);
  assert.ok(await waitForExit(session.owned.child, EXIT_DEADLINE_MS), "helper exited on its own after its decision");
  return line === undefined ? undefined : parseHelperLine(line);
}

function uniquePipeName(label: string): string {
  return `prg-claude-inbox-probe-${label}-${process.pid}-${randomBytes(8).toString("hex")}`;
}

function readEvents(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

async function waitForEvent(path: string, predicate: (line: string) => boolean, deadlineMs: number): Promise<string | undefined> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const found = readEvents(path).find(predicate);
    if (found !== undefined || Date.now() >= deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function startFixture(own: Ownership, mode: "server" | "parent" | "orphan" | "idle", pipeName: string): { tree: ContainedTree; events: string } {
  const script = join(own.scratch, "pipe-server.cjs");
  if (!existsSync(script)) writeFileSync(script, SERVER_SCRIPT, { mode: 0o600 });
  const events = join(own.scratch, `events-${mode}.log`);
  writeFileSync(events, "", { mode: 0o600 });
  const tree = own.contain(process.execPath, [script, mode, pipeName, events], own.scratch, process.env);
  return { tree, events };
}

function pipeAccepts(pipeName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(`\\\\.\\pipe\\${pipeName}`);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

// ---------------------------------------------------------------------------
// Portable tests: this file's own parsing, quoting, and decision only.

test("portable: only a local \\\\.\\pipe\\ name is accepted, never UNC or quote-bearing spellings", () => {
  assert.equal(localPipeName("\\\\.\\pipe\\claude-abc_1.2"), "claude-abc_1.2");
  assert.equal(localPipeName("\\\\.\\pipe\\cc\\nested"), undefined);
  assert.equal(localPipeName("\\\\.\\pipe\\cc/../claude-abc_1.2"), undefined);
  assert.equal(localPipeName("\\\\.\\pipe\\claude-abc_1.2."), undefined);
  assert.equal(localPipeName("\\\\.\\pipe\\.."), undefined);
  assert.equal(classifyHookRecord({
    event: "SessionStart", agentIdAbsent: true, sessionId: "0b1c2d3e-4f50-4617-8899-aabbccddeeff",
    socketPath: "\\\\.\\pipe\\cc\\..\\claude-abc", tokenPresent: true, hookPid: 1,
  }).ok, false, "a normalization-prone announcement is refused before any helper connects");
  for (const value of ["\\\\server\\pipe\\x", "\\\\?\\pipe\\x", "\\\\.\\PIPE\\x", "/tmp/cc-socks/1.sock", "\\\\.\\pipe\\", "\\\\.\\pipe\\a'b", "\\\\.\\pipe\\a b", 7, undefined]) {
    assert.equal(localPipeName(value), undefined, String(value));
  }
});

test("portable: helper and job-host output is parsed strictly", () => {
  assert.deepEqual(parseHelperLine("PRG_PROBE_SERVER pid=4242 session=1"), { kind: "server", serverPid: 4242, serverSession: 1 });
  assert.deepEqual(parseHelperLine("PRG_PROBE_NO connect-timeout"), { kind: "refused", stage: "connect-timeout" });
  assert.deepEqual(parseHelperLine("PRG_PROBE_SENT 30"), { kind: "sent", bytes: 30 });
  assert.deepEqual(parseHelperLine("PRG_PROBE_CLOSED"), { kind: "closed" });
  for (const line of ["PRG_PROBE_SERVER pid=0 session=1", "PRG_PROBE_SERVER pid=99999999999 session=1", "PRG_PROBE_NO other", " PRG_PROBE_CLOSED", "PRG_PROBE_SERVER pid=1"]) {
    assert.equal(parseHelperLine(line), undefined, line);
  }
  assert.deepEqual(parseJobLine("PRG_JOB_STARTED pid=77"), { kind: "started", targetPid: 77 });
  assert.deepEqual(parseJobLine("PRG_JOB_NO job-attributes"), { kind: "refused", stage: "job-attributes" });
  assert.deepEqual(parseJobLine("PRG_JOB_PIN_LIVE"), { kind: "pin-live" });
  assert.deepEqual(parseJobLine("PRG_JOB_PIN_DEAD"), { kind: "pin-dead" });
  assert.equal(parseJobLine("PRG_JOB_NO job-assign"), undefined);
  assert.deepEqual(parseJobLine("PRG_JOB_SETTLED"), { kind: "settled" });
  assert.deepEqual(parseJobLine("PRG_JOB_UNSETTLED"), { kind: "unsettled" });
  assert.deepEqual(parseJobLine("PRG_JOB_TARGET_EXITED"), { kind: "target-exited" });
  for (const line of ["PRG_JOB_STARTED pid=0", "PRG_JOB_NO whatever", "PRG_JOB_SETTLED ", "prg_job_settled"]) {
    assert.equal(parseJobLine(line), undefined, line);
  }
});

test("portable: Windows argument quoting and PowerShell literals", () => {
  assert.equal(quoteWindowsArg("plain"), "plain");
  assert.equal(quoteWindowsArg(""), "\"\"");
  assert.equal(quoteWindowsArg("C:\\Program Files\\node.exe"), "\"C:\\Program Files\\node.exe\"");
  assert.equal(quoteWindowsArg("a\"b"), "\"a\\\"b\"");
  assert.equal(quoteWindowsArg("trail\\ dir\\"), "\"trail\\ dir\\\\\"");
  assert.equal(psLiteral("it's"), "'it''s'");
  assert.equal(psLiteral("a‘b’c‚d‛e"), "'a‘‘b’’c‚‚d‛‛e'");
  assert.ok(JOB_TYPE.includes("RegOpenKeyExW(root,@\"SOFTWARE\\Policies\\ClaudeCode\",0,access,out key)"), "C# receives single backslashes");
  assert.equal(quoteGitBashPath("C:\\Users\\o'neil$qa\\`probe`.cjs"), "'C:/Users/o'\\''neil$qa/`probe`.cjs'");
  assert.equal(quoteGitBashPath("C:\\plain\\node.exe"), "'C:/plain/node.exe'");
});

test("portable: the diagnostic lineage decision fails closed", async () => {
  const live = { pid: 100, exitCode: null, signalCode: null } as RootLike;
  const neverCalled: LineageVerifier = async () => assert.fail("lineage must not be queried");
  assert.deepEqual(await decidePipeOwnership(live, 100, neverCalled), { owned: true, via: "launched-root" });
  assert.deepEqual(await decidePipeOwnership({ ...live, exitCode: 0 }, 100, neverCalled), { owned: false, reason: "launched-root-not-live" });
  assert.deepEqual(await decidePipeOwnership(live, 0, neverCalled), { owned: false, reason: "server-pid-invalid" });
  assert.deepEqual(await decidePipeOwnership(live, 200, async () => ({ verified: true })), { owned: true, via: "verified-descendant" });
  assert.deepEqual(
    await decidePipeOwnership(live, 200, async () => ({ verified: false, reason: "chain-parent-absent" })),
    { owned: false, reason: "lineage:chain-parent-absent" },
  );
  const exitsDuringLineage = { ...live } as { pid: number; exitCode: number | null; signalCode: null };
  assert.deepEqual(
    await decidePipeOwnership(exitsDuringLineage, 200, async () => {
      exitsDuringLineage.exitCode = 1;
      return { verified: true };
    }),
    { owned: false, reason: "launched-root-not-live" },
  );
});

test("portable: the pinned-target rule refuses other PIDs and requires a post-sample live acknowledgement", async () => {
  function fakeTree(answer: string | undefined): { tree: ContainedTree; writes: string[] } {
    const stdout = new PassThrough();
    const writes: string[] = [];
    const host = {
      exitCode: null,
      signalCode: null,
      stdin: {
        write: (chunk: string) => {
          writes.push(chunk);
          if (answer !== undefined) setImmediate(() => stdout.write(`${answer}\n`));
          return true;
        },
      },
    } as unknown as ChildProcess;
    const tree: ContainedTree = { host, lines: new Lines(stdout), spawnFailed: false };
    // A stale answer from before the sample must never satisfy the query.
    stdout.write("PRG_JOB_STARTED pid=10\nPRG_JOB_PIN_LIVE\n");
    return { tree, writes };
  }
  const other = fakeTree("PRG_JOB_PIN_LIVE");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await decidePinnedOwnership(other.tree, 10, 11), { owned: false, reason: "server-not-pinned-target" });
  assert.deepEqual(other.writes, [], "no pin query for an unpinned PID");
  const live = fakeTree("PRG_JOB_PIN_LIVE");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await decidePinnedOwnership(live.tree, 10, 10), { owned: true, via: "pinned-target" });
  assert.deepEqual(live.writes, ["V"]);
  const dead = fakeTree("PRG_JOB_PIN_DEAD");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await decidePinnedOwnership(dead.tree, 10, 10), { owned: false, reason: "target-pin-not-confirmed" });
  const exited = fakeTree(undefined);
  (exited.tree.host as { exitCode: number | null }).exitCode = 0;
  assert.deepEqual(await decidePinnedOwnership(exited.tree, 10, 10), { owned: false, reason: "job-host-not-live" });
});

test("portable: Claude version, hook record, and ambient-credential screening use fixed stages", () => {
  assert.equal(supportedWindowsClaudeVersion("2.1.234 (Claude Code)\n"), "2.1.234");
  assert.equal(supportedWindowsClaudeVersion("2.1.330 (Claude Code)\r\n"), "2.1.330");
  assert.equal(supportedWindowsClaudeVersion("3.0.0 (Claude Code)"), "3.0.0");
  assert.equal(supportedWindowsClaudeVersion("2.1.233 (Claude Code)"), undefined);
  assert.equal(supportedWindowsClaudeVersion("2.1.330"), undefined);
  const good = {
    event: "SessionStart", agentIdAbsent: true, sessionId: "0b1c2d3e-4f50-4617-8899-aabbccddeeff",
    socketPath: "\\\\.\\pipe\\claude-probe", tokenPresent: true, hookPid: 1,
  };
  assert.deepEqual(classifyHookRecord(good), { ok: true, pipeName: "claude-probe" });
  assert.deepEqual(classifyHookRecord({ ...good, agentIdAbsent: false }), { ok: false, stage: "hook-not-root-scope" });
  assert.deepEqual(classifyHookRecord({ ...good, socketPath: null }), { ok: false, stage: "socket-not-announced" });
  assert.deepEqual(classifyHookRecord({ ...good, socketPath: "/tmp/cc-socks/1.sock" }), { ok: false, stage: "socket-not-local-named-pipe" });
  assert.deepEqual(classifyHookRecord({ ...good, tokenPresent: false }), { ok: false, stage: "token-not-announced" });
  assert.deepEqual(
    forbiddenAmbientNames({ PATH: "x", ANTHROPIC_API_KEY: "x", CLAUDE_CODE_OAUTH_TOKEN: "x", GITHUB_TOKEN_PASSWORD: "x", CLAUDE_CODE_GIT_BASH_PATH: "x", [CLI_ENV]: "x", [VM_ENV]: "x" }),
    ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN_PASSWORD"],
  );
});

test("portable: the helper writes nothing before SEND; the job host starts suspended and stops by job handle", () => {
  const interop = "C:\\probe\\inbox-interop.dll";
  const script = helperScript("prg-claude-inbox-probe-x", interop);
  assert.match(script, /'prg-claude-inbox-probe-x'/);
  assert.match(script, /TokenImpersonationLevel\]::Identification/);
  const readIndex = script.indexOf("[Console]::In.ReadLine()");
  assert.ok(readIndex > script.indexOf("GetNamedPipeServerProcessId($handle"));
  assert.equal(script.indexOf("$client.Write("), script.lastIndexOf("$client.Write("));
  assert.ok(script.indexOf("$client.Write(") > readIndex);
  const host = jobHostScript("C:\\x\\node.exe", "\"C:\\x\\node.exe\" a", "C:\\x", interop);
  for (const generated of [script, host]) {
    assert.ok(generated.includes(`::LoadFrom(${psLiteral(interop)})`), "loads the precompiled interop");
    assert.doesNotMatch(generated, /Add-Type|-TypeDefinition/, "no compiler runs inside PowerShell");
  }
  assert.match(PIPE_TYPE, /GetNamedPipeServerProcessId/);
  assert.match(JOB_TYPE, /UpdateProcThreadAttribute\(attrs,0,new IntPtr\(0x0002000D\)/);
  assert.match(JOB_TYPE, /0x08080004/);
  assert.doesNotMatch(JOB_TYPE, /AssignProcessToJobObject|TerminateProcess/);
  assert.ok(JOB_TYPE.indexOf("CreateProcessW(app") < JOB_TYPE.indexOf("ResumeThread(pi.hThread)"));
  assert.match(JOB_TYPE, /WaitForSingleObject\(proc,0\) == 258/);
  assert.ok(host.indexOf("$buffer[0] -ne 86") < host.indexOf("PRG_JOB_PIN_LIVE"), "only a lone V byte is a pin query");
  assert.ok(host.lastIndexOf("[PrgClaudeInboxProbeJob]::TerminateAll()") > host.lastIndexOf("PRG_JOB_PIN_LIVE"), "every other input ends in job termination");
  assert.match(JOB_TYPE, /WriteInt32\(lim,16,0x2000\)/);
  assert.doesNotMatch(host + JOB_TYPE, /taskkill|Stop-Process|\.Kill\(/i);
});

// ---------------------------------------------------------------------------
// Native Windows fixture: real named pipes and job containment, no provider.

test("native Windows: pipe served by the contained target is proven by the pinned-target rule before one inert byte", nativeOnly, async () => {
  await withOwnership(async (own) => {
    const pipeName = uniquePipeName("server");
    const { tree, events } = startFixture(own, "server", pipeName);
    const targetPid = await own.started(tree);
    const listening = await waitForEvent(events, (line) => line.startsWith("LISTENING "), HELPER_DEADLINE_MS);
    assert.ok(listening, "contained pipe server is listening");
    assert.equal(Number(listening.slice("LISTENING ".length)), targetPid);
    const session = await connectHelper(own, pipeName);
    assert.equal(session.first?.kind, "server", `helper reported ${JSON.stringify(session.first)}`);
    const serverPid = (session.first as { serverPid: number }).serverPid;
    assert.equal(serverPid, targetPid, "kernel-reported server PID is the pinned target");
    assert.ok(await waitForEvent(events, (line) => line === "ACCEPT", HELPER_DEADLINE_MS), "server accepted the connection");
    assert.equal(readEvents(events).some((line) => line.startsWith("DATA ")), false, "zero bytes before verification");
    assert.deepEqual(await decidePinnedOwnership(tree, targetPid, serverPid), { owned: true, via: "pinned-target" });
    assert.deepEqual(await finishHelper(session, "SEND"), { kind: "sent", bytes: Buffer.byteLength(MARKER) });
    assert.ok(await waitForEvent(events, (line) => line === `END ${Buffer.byteLength(MARKER)}`, HELPER_DEADLINE_MS), "server received exactly the marker");
    assert.ok(readEvents(events).includes(`DATA ${Buffer.byteLength(MARKER)} marker`));
    assert.equal(await own.settleTree(tree), true, "job emptied through its handle");
    assert.equal(await pipeAccepts(pipeName), false, "no contained server survives settlement");
  });
});

test("native Windows (diagnostic): a pipe served by the target's child is refused by the pinned rule; lineage is recorded only", nativeOnly, async () => {
  await withOwnership(async (own) => {
    const pipeName = uniquePipeName("parent");
    const { tree, events } = startFixture(own, "parent", pipeName);
    const targetPid = await own.started(tree);
    const listening = await waitForEvent(events, (line) => line.startsWith("LISTENING "), HELPER_DEADLINE_MS);
    assert.ok(listening, "contained child server is listening");
    const session = await connectHelper(own, pipeName);
    assert.equal(session.first?.kind, "server", `helper reported ${JSON.stringify(session.first)}`);
    const serverPid = (session.first as { serverPid: number }).serverPid;
    assert.equal(serverPid, Number(listening.slice("LISTENING ".length)));
    assert.notEqual(serverPid, targetPid);
    assert.deepEqual(await decidePinnedOwnership(tree, targetPid, serverPid), { owned: false, reason: "server-not-pinned-target" });
    // Experiment only: what CIM ancestry says about the child. Never a proof, so no byte is sent either way.
    const lineage = await decidePipeOwnership(tree.host, serverPid);
    console.log(`claude-windows-inbox-probe-diagnostic ${JSON.stringify({ case: "child-server", lineage })}`);
    assert.deepEqual(await finishHelper(session, "CLOSE"), { kind: "closed" });
    assert.ok(await waitForEvent(events, (line) => line === "END 0", HELPER_DEADLINE_MS), "the child server received no byte");
    assert.equal(await own.settleTree(tree), true, "job emptied through its handle");
    assert.equal(await pipeAccepts(pipeName), false, "no contained server survives settlement");
  });
});

test("native Windows: an impostor pipe server outside the owned launch is refused with zero bytes", nativeOnly, async () => {
  await withOwnership(async (own) => {
    const pipeName = uniquePipeName("impostor");
    let received = 0;
    let accepted = 0;
    let closed: Promise<void> | undefined;
    const sockets = new Set<net.Socket>();
    const impostor = net.createServer((socket) => {
      accepted += 1;
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      closed = new Promise((resolve) => socket.once("close", () => resolve()));
      socket.on("data", (chunk) => {
        received += chunk.length;
      });
      socket.on("error", () => undefined);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        impostor.once("error", reject);
        impostor.listen(`\\\\.\\pipe\\${pipeName}`, () => resolve());
      });
      // The owned launch is a contained idle target; the impostor is this test process, its ancestor.
      const { tree } = startFixture(own, "idle", uniquePipeName("unused"));
      const targetPid = await own.started(tree);
      const session = await connectHelper(own, pipeName);
      assert.equal(session.first?.kind, "server", `helper reported ${JSON.stringify(session.first)}`);
      const serverPid = (session.first as { serverPid: number }).serverPid;
      assert.equal(serverPid, process.pid, "kernel reports the impostor (this process) as the server");
      assert.deepEqual(await decidePinnedOwnership(tree, targetPid, serverPid), { owned: false, reason: "server-not-pinned-target" });
      assert.deepEqual(await finishHelper(session, "CLOSE"), { kind: "closed" });
      assert.equal(accepted, 1);
      assert.ok(closed, "the impostor saw the connection");
      const settledInTime = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), HELPER_DEADLINE_MS).unref()),
      ]);
      assert.equal(settledInTime, true, "the impostor's socket closed");
      assert.equal(received, 0, "the impostor received no byte");
    } finally {
      // Destroy any still-open accepted socket so the listener can close even when the body failed early.
      await new Promise<void>((resolve) => {
        impostor.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    }
  });
});

test("native Windows (diagnostic): a server orphaned by its exited target is refused, and job settlement still removes it", nativeOnly, async () => {
  await withOwnership(async (own) => {
    const pipeName = uniquePipeName("orphan");
    const { tree, events } = startFixture(own, "orphan", pipeName);
    const targetPid = await own.started(tree);
    const listening = await waitForEvent(events, (line) => line.startsWith("LISTENING "), HELPER_DEADLINE_MS);
    assert.ok(listening, "the orphan-to-be is listening");
    assert.ok(await tree.lines.next((line) => line === "PRG_JOB_TARGET_EXITED", HELPER_DEADLINE_MS), "the target exited first");
    assert.equal(await pipeAccepts(pipeName), true, "its detached child still serves after the target exited");
    const session = await connectHelper(own, pipeName);
    assert.equal(session.first?.kind, "server");
    const serverPid = (session.first as { serverPid: number }).serverPid;
    assert.deepEqual(await decidePinnedOwnership(tree, targetPid, serverPid), { owned: false, reason: "server-not-pinned-target" });
    const lineage = await decidePipeOwnership(tree.host, serverPid);
    console.log(`claude-windows-inbox-probe-diagnostic ${JSON.stringify({ case: "orphan-server", lineage })}`);
    assert.equal(lineage.owned, false, "lineage cannot vouch for an orphan either");
    assert.deepEqual(await finishHelper(session, "CLOSE"), { kind: "closed" });
    assert.equal(await own.settleTree(tree), true, "terminating the job reached the orphan");
    assert.equal(await pipeAccepts(pipeName), false, "the orphan is gone");
  });
});

test("native Windows: a target that never becomes ready still settles through its job", nativeOnly, async () => {
  await withOwnership(async (own) => {
    const pipeName = uniquePipeName("never-ready");
    const { tree, events } = startFixture(own, "idle", pipeName);
    await own.started(tree);
    assert.equal(await waitForEvent(events, (line) => line.startsWith("LISTENING "), 2_000), undefined, "readiness timed out as intended");
    assert.equal(tree.host.exitCode, null, "the target is still contained and live");
    assert.equal(await own.settleTree(tree), true, "readiness failure path settles the live target");
  });
});

// ---------------------------------------------------------------------------
// Genuine Claude: double opt-in, disposable offline VM only, never sends a token or message.

const cliPin = process.env[CLI_ENV];
const vmAttested = process.env[VM_ENV] === VM_ATTESTATION;
const claudeLeg = {
  skip: !onWindows
    ? "genuine Claude Windows inbox probe needs native Windows"
    : !cliPin || !vmAttested
      ? `opt-in, disposable offline VM only: set ${CLI_ENV} and ${VM_ENV}=${VM_ATTESTATION} (see this file's VM procedure)`
      : false,
  timeout: 300_000,
};

/** Fail-closed preflights for the disposable-VM contract. Returns a fixed stage or `undefined`. */
async function disposableVmViolation(own: Ownership): Promise<string | undefined> {
  if (forbiddenAmbientNames(process.env).length > 0) return "ambient-provider-or-credential-variable";
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programData = process.env.ProgramData ?? "C:\\ProgramData";
  const managed = [
    join(programFiles, "ClaudeCode", "managed-settings.json"),
    join(programFiles, "ClaudeCode", "managed-mcp.json"),
    join(programData, "ClaudeCode", "managed-settings.json"),
  ];
  if (managed.some((path) => existsSync(path))) return "managed-claude-settings-present";
  for (const machine of [true, false]) {
    // 2 means ERROR_FILE_NOT_FOUND in both registry views; anything else cannot establish absence.
    const code = await own.queryManagedPolicy(machine);
    if (code === 0) return "managed-claude-policy-key-present";
    if (code !== 2) return "managed-claude-policy-query-unavailable";
  }
  const profile = process.env.USERPROFILE;
  if (profile && (existsSync(join(profile, ".claude", ".credentials.json")) || existsSync(join(profile, ".claude.json")))) {
    return "user-claude-credentials-or-config-present";
  }
  const resolved = await Promise.race([
    lookup("api.anthropic.com").then(() => true, () => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (resolved) return "external-dns-resolves";
  const reachable = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "1.1.1.1", port: 443, timeout: 3_000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
  return reachable ? "external-network-reachable" : undefined;
}

/** One Git Bash word: single-quoted (no expansion of `$`, backticks, or globs), apostrophes escaped. */
function quoteGitBashPath(path: string): string {
  return `'${path.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
}

function cmdSafePath(path: string): string {
  if (/["%!^\r\n]/.test(path)) throw new Error("probe path contains a cmd metacharacter");
  return path;
}

test("genuine Claude (opt-in, disposable offline VM): root SessionStart pipe is served by the contained launch; no byte is sent", claudeLeg, async () => {
  let stage = "not-started";
  const observed: Record<string, unknown> = {};
  let sinkConnections = 0;
  const sink = net.createServer((socket) => {
    sinkConnections += 1;
    socket.destroy();
  });
  try {
    await withOwnership(async (own) => {
      const violation = await disposableVmViolation(own);
      if (violation) {
        stage = `vm-preflight:${violation}`;
        assert.fail(stage);
      }
      assert.ok(cliPin && isAbsolute(cliPin) && /\.exe$/i.test(cliPin), `${CLI_ENV} must be an absolute path to claude.exe`);
      const cli = cmdSafePath(realpathSync(cliPin));
      const scratch = own.scratch;
      const home = join(scratch, "home");
      const config = join(scratch, "config");
      const work = join(scratch, "work");
      const temporary = join(scratch, "tmp");
      for (const directory of [home, config, work, temporary, join(home, "AppData", "Roaming"), join(home, "AppData", "Local")]) {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
      }
      const recordPath = join(scratch, "session-start.json");
      const releasePath = join(scratch, "release");
      const hookPath = join(scratch, "session-start-hook.cjs");
      writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o600 });
      const settingsPath = join(scratch, "settings.json");
      const hookCommand = [process.execPath, hookPath, recordPath, releasePath].map(quoteGitBashPath).join(" ");
      writeFileSync(settingsPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hookCommand, timeout: 120 }] }] } }), { mode: 0o600 });

      // A bind failure rejects, so withOwnership still settles and removes the staged scratch.
      await new Promise<void>((resolve, reject) => {
        sink.once("error", reject);
        sink.listen(0, "127.0.0.1", () => {
          sink.off("error", reject);
          resolve();
        });
      });
      const sinkPort = (sink.address() as net.AddressInfo).port;
      const env: NodeJS.ProcessEnv = {};
      for (const key of ENV_ALLOWLIST) if (process.env[key] !== undefined) env[key] = process.env[key];
      Object.assign(env, {
        HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
        TEMP: temporary, TMP: temporary, CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${sinkPort}`,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
      });
      assert.deepEqual(Object.keys(env).filter((key) => CREDENTIAL_NAME.test(key)), [], "no credential-named variable reaches Claude");

      // Version, contained: cmd redirects stdout to an owned file (the target has no pipes).
      const versionFile = join(scratch, "version.txt");
      const cmd = systemPath("cmd.exe");
      const versionTree = own.contain(cmd, [], work, env, `"${cmd}" /d /s /c ""${cli}" --version 1>"${cmdSafePath(versionFile)}" 2>NUL"`);
      await own.started(versionTree);
      if (!(await versionTree.lines.next((line) => line === "PRG_JOB_TARGET_EXITED", EXIT_DEADLINE_MS))) {
        stage = "version-timeout";
        assert.fail(stage);
      }
      assert.equal(await own.settleTree(versionTree), true, "version job settled");
      const versionText = existsSync(versionFile) && statSync(versionFile).size <= 256 ? readFileSync(versionFile, "utf8") : "";
      const version = supportedWindowsClaudeVersion(versionText);
      observed.version = version ?? "unsupported";
      if (!version) {
        stage = "version-below-documented-windows-minimum-or-unrecognized";
        assert.fail(stage);
      }

      const claudeTree = own.contain(cli, ["-p", "--settings", settingsPath, "inbox ownership probe"], work, env);
      try {
        const targetPid = await own.started(claudeTree);
        observed.claudePid = targetPid;
        const deadline = Date.now() + SESSION_START_DEADLINE_MS;
        while (!existsSync(recordPath) && Date.now() < deadline) {
          if (claudeTree.lines.seen().includes("PRG_JOB_TARGET_EXITED")) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!existsSync(recordPath)) {
          stage = claudeTree.lines.seen().includes("PRG_JOB_TARGET_EXITED") ? "claude-exited-before-session-start" : "session-start-not-observed";
          assert.fail(stage);
        }
        const record = JSON.parse(readFileSync(recordPath, "utf8")) as HookRecord;
        const verdict = classifyHookRecord(record);
        if (!verdict.ok) {
          stage = verdict.stage;
          assert.fail(stage);
        }
        observed.hookPid = record.hookPid;
        const session = await connectHelper(own, verdict.pipeName);
        if (session.first?.kind !== "server") {
          stage = session.first?.kind === "refused" ? `helper:${session.first.stage}` : "helper-no-answer";
          assert.fail(stage);
        }
        observed.serverPid = session.first.serverPid;
        const decision = await decidePinnedOwnership(claudeTree, targetPid, session.first.serverPid);
        observed.decision = decision;
        // Probe only: never send the token, even when ownership is proven.
        assert.deepEqual(await finishHelper(session, "CLOSE"), { kind: "closed" });
        if (!decision.owned) {
          stage = `ownership-refused:${decision.reason}`;
          assert.fail(stage);
        }
        stage = "proven";
      } finally {
        writeFileSync(releasePath, "");
      }
    });
  } catch (error) {
    if (stage === "proven" || stage === "not-started") stage = "cleanup-or-harness-failure";
    throw error;
  } finally {
    await new Promise<void>((resolve) => (sink.listening ? sink.close(() => resolve()) : resolve()));
    // Fixed fields only: stage, version, PIDs, decision. No paths, tokens, or output text.
    console.log(`claude-windows-inbox-probe ${JSON.stringify({ stage, sinkConnections, ...observed })}`);
  }
});
