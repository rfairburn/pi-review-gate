/*
 * Native Windows coverage for the fixed-platform ShellStart contract (#99).
 *
 * These tests run ONLY on native Windows (they skip everywhere else) and drive
 * the production entrypoints — registerBackgroundShell's real tools and the
 * same spawnBackgroundJob call ShellStart makes — against REAL PowerShell
 * processes. They are the only native evidence for: both discovery outcomes
 * (pwsh preferred, powershell.exe fallback), the missing-both error before any
 * job starts, the UTF-8 console prefix, spaces/quoting in commands,
 * exit-status mapping on BOTH editions, stdin delivery, ShellStop tree kill,
 * parent-death watchdog cleanup, and reapAll. Descendant ownership across the
 * shell root's exit (job object + surviving watchdog): a root that exits with
 * live Start-Process descendants keeps the job accounted for and readiness
 * blocked until verified complete; stop and host death terminate the whole
 * job; a failure to establish ownership aborts before any unprotected run.
 * The POSIX Bash path (process groups, negative-pid signalling) is covered by
 * background-shell-integration.test.ts on Linux/macOS; nothing in this file
 * mocks a shell — the PATH fixture below changes what `where` really finds,
 * and every fallback case proves its preconditions (pwsh.exe genuinely
 * absent, real 5.x powershell.exe retained) before it runs. The two
 * pwsh-specific cases treat PowerShell 7 as an optional prerequisite: a
 * verified absence skips them with a truthful reason, while a failed,
 * timed-out, or malformed lookup fails with diagnostics instead (tests/
 * helpers/pwsh-prerequisite.ts); on the CI Windows shell job, where the runner
 * image provides PowerShell 7, PI_REVIEW_GATE_REQUIRE_PWSH=1 makes that
 * absence a failure instead of a skip (#405). Because discovery also consults
 * the standard install locations (#405), every fixture that removes a shell
 * from PATH neutralises those locations too. Test-owned
 * temp-file cleanup uses bounded retry (tests/helpers/temp-file-cleanup.ts):
 * a just-killed process can hold its redirected-output handles open briefly
 * on Windows, and a transient EPERM in cleanup must neither fail an
 * otherwise-passing lifecycle assertion nor mask a real body failure.
 */
import { afterEach, describe, it } from "node:test";
import { expect } from "./helpers/expect";
import childProcess, { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { rmWithRetry, runWithTempCleanup } from "./helpers/temp-file-cleanup";
import registerBackgroundShell, { __test as backgroundShellTest, reapAll } from "../src/background-shell";
import {
  POWERSHELL_ARGS,
  msixWorkloadScript,
  msixWorkloadVariableName,
  wrapWithMsixPowerShellLauncher,
  wrapWithPowerShellWatchdog,
} from "../src/background-shell/jobs";
import { ownershipAcknowledgement, ownershipVerdict } from "../src/background-shell/ownership";
import {
  findWindowsExecutable,
  isWindowsAppsPackagePath,
  resolveWindowsPowerShell,
  selectWindowsPowerShellForJobs,
  spawnBackgroundJob,
} from "../src/background-shell/shell";
import { BackgroundProcessReadiness } from "../src/background-process-readiness";
import { probePwshPrerequisite, resolvePwshPrerequisite } from "./helpers/pwsh-prerequisite";

const IS_WINDOWS = process.platform === "win32";
const SKIP = { skip: !IS_WINDOWS };

interface Sent {
  content: string;
  delivery: any;
}

/** Store-route ShellStart jobs this file started (job id -> ownership record
 *  path), recorded the moment ShellStart returns so teardown can require their
 *  terminal evidence before removing exactly those files (#800). */
const storeToolRuns = new Map<string, string>();

function wire(trackStore = false) {
  const sent: Sent[] = [];
  const tools: Record<string, any> = {};
  const handlers: Record<string, any> = {};
  const pi: any = {
    registerTool: (t: any) => { tools[t.name] = t; },
    on: (n: string, h: any) => { handlers[n] = h; },
    sendMessage: (msg: any, delivery: any) => { sent.push({ content: msg.content, delivery }); },
  };
  const controller = registerBackgroundShell(pi);
  const ctx = { hasUI: false, ui: {} };
  const call = async (name: string, params: any) => {
    const result = await tools[name].execute("id", params, undefined, undefined, ctx);
    if (trackStore && name === "ShellStart" && !result.isError && typeof result.details?.ownershipMarker === "string") {
      storeToolRuns.set(result.details.id, result.details.ownershipMarker);
    }
    return result;
  };
  return { sent, tools, handlers, call, controller };
}

const textOf = (r: any) => r.content[0].text as string;

async function until(fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    return await fn();
  } catch {
    return false;
  }
}

/** Poll ShellLog until `pred` matches, retaining the last observed log so a
 *  timeout fails with the actual output instead of a bare `false`. */
async function untilLog(
  call: (name: string, params: any) => Promise<any>,
  id: string,
  pred: (text: string) => boolean,
  ms = 20_000,
): Promise<{ ok: boolean; log: string }> {
  let log = "";
  const ok = await until(async () => {
    log = textOf(await call("ShellLog", { id }));
    return pred(log);
  }, ms);
  return { ok, log };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The creation-time ticks of a process, read through the production PowerShell
 *  edition. `null` means the process is gone or its identity is unreadable, so
 *  absence is reported as absence and never as a matching identity. */
function windowsCreationTicks(pid: number): string | null {
  const result = spawnSync(
    resolveWindowsPowerShell(),
    [
      "-NoProfile", "-NonInteractive", "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -ne $p) { $p.StartTime.Ticks }`,
    ],
    { encoding: "utf-8", windowsHide: true, timeout: 20_000 },
  );
  const ticks = (result.stdout ?? "").trim();
  return /^[0-9]{1,20}$/.test(ticks) ? ticks : null;
}

/** Count running PowerShell processes of either edition. The probe runs in
 * Node (tasklist), so it never counts itself or its own shell. Only CSV rows
 * naming the requested image are counted — tasklist's no-match informational
 * line is not a process, and counting it would make one leaked watchdog
 * indistinguishable from zero — and a probe failure throws rather than
 * returning a misleading zero. */
function countShellProcesses(): number {
  let total = 0;
  for (const image of ["pwsh.exe", "powershell.exe"]) {
    const result = spawnSync(
      "tasklist", ["/fi", `imagename eq ${image}`, "/fo", "csv", "/nh"],
      { encoding: "utf-8" },
    );
    if (result.error || result.status !== 0) {
      throw new Error(`tasklist failed for ${image}: ${result.error?.message ?? result.stderr}`);
    }
    const prefix = `"${image.toLowerCase()}",`;
    total += result.stdout.split(/\r?\n/)
      .filter((line) => line.toLowerCase().startsWith(prefix)).length;
  }
  return total;
}

/** Normalize a Windows PATH entry for comparison: trim, drop trailing
 *  separators (a root like C:\ keeps its), lowercase. */
function normalizePathEntry(entry: string): string {
  let e = entry.trim();
  while (e.length > 3 && e.endsWith("\\")) e = e.slice(0, -1);
  return e.toLowerCase();
}

/** Every directory that can still resolve pwsh.exe under `pathValue`: the
 *  directories of ALL lines `where pwsh.exe` reports (not just the first — a
 *  second copy on PATH defeats the fallback just as well) plus any PATH entry
 *  that actually contains a pwsh.exe file. */
function pwshResolvingDirs(pathValue: string): Set<string> {
  const dirs = new Set<string>();
  const result = spawnSync("where", ["pwsh.exe"], { encoding: "utf-8" });
  if (!result.error && result.stdout) {
    for (const line of result.stdout.trim().split(/\r?\n/)) {
      const d = dirname(line.trim());
      if (d) dirs.add(normalizePathEntry(d));
    }
  }
  for (const entry of pathValue.split(";")) {
    if (!entry.trim()) continue;
    try {
      if (existsSync(join(entry, "pwsh.exe"))) dirs.add(normalizePathEntry(entry));
    } catch {
      /* unreadable entry: `where` already covered it */
    }
  }
  return dirs;
}

/** A test-owned directory path that is never created: pointing an
 *  install-location variable (`ProgramFiles` / `SystemRoot`) here makes
 *  production's #405 fallback checks fail, so a fixture that removes a shell
 *  from PATH really tests the outcome it claims. Nothing is created, so there
 *  is nothing to clean up. */
function nonexistentInstallDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}-missing`);
}

/** The single fixture every Windows-PowerShell-5.1 case shares: run `fn` with
 *  a PATH that genuinely resolves NO pwsh.exe while retaining real Windows
 *  PowerShell 5.1 and the executables this suite needs (where/tasklist for
 *  the probes, powershell.exe itself, node's own directory). The preconditions
 *  are PROVEN under the reduced PATH with the production discovery before
 *  `fn` runs — a missing prerequisite fails with an actionable error, never
 *  an early-return no-op pass:
 *   1. findWindowsExecutable("pwsh.exe") is null (what ShellStart itself runs);
 *   2. resolveWindowsPowerShell() resolves to basename powershell.exe;
 *   3. that executable reports a 5.x $PSVersionTable.PSVersion (edition probe);
 *   4. where.exe/tasklist.exe still resolve, and node's directory survives.
 *  `fn` receives the verified powershell.exe path so identity assertions can
 *  compare against it. Because discovery resolves a PowerShell 7 in
 *  `%ProgramFiles%\PowerShell\7\pwsh.exe` even when PATH no longer carries it
 *  (#405), `ProgramFiles` is redirected to a nonexistent test-owned directory
 *  for the whole fixture and restored in `finally` — otherwise this fixture
 *  would launch the very edition it claims is absent. */
async function withWindowsPowerShell51(fn: (powershellExe: string) => Promise<void>): Promise<void> {
  const original = process.env.PATH ?? "";
  const originalProgramFiles = process.env.ProgramFiles;
  const drop = pwshResolvingDirs(original);
  const kept: string[] = [];
  for (const entry of original.split(";")) {
    if (!entry.trim()) continue;
    if (drop.has(normalizePathEntry(entry))) continue;
    kept.push(entry);
  }
  const reduced = kept.join(";");
  process.env.PATH = reduced;
  // Child PowerShell processes started inside this fixture inherit the
  // redirected ProgramFiles; no assertion here may depend on its real value.
  process.env.ProgramFiles = nonexistentInstallDir("pi-review-no-pwsh7");
  try {
    // 1. pwsh.exe is genuinely gone, per the production discovery itself.
    const leftover = findWindowsExecutable("pwsh.exe");
    if (leftover !== null) {
      throw new Error(
        `5.1 fallback fixture failed: pwsh.exe still resolves after removing ${[...drop].join(", ")} — ` +
          `found at ${leftover}. Reduced PATH: ${reduced}`,
      );
    }
    // 2. Windows PowerShell itself must still resolve, and be the built-in
    //    edition by basename (pwsh.exe is excluded by check 1).
    let powershellExe: string;
    try {
      powershellExe = resolveWindowsPowerShell();
    } catch (err) {
      throw new Error(
        `5.1 fallback fixture failed: no PowerShell left on the reduced PATH after removing ${[...drop].join(", ")} — ` +
          `${(err as Error).message} Reduced PATH: ${reduced}`,
      );
    }
    if (basename(powershellExe).toLowerCase() !== "powershell.exe") {
      throw new Error(
        `5.1 fallback fixture failed: expected powershell.exe, resolved ${powershellExe}. Reduced PATH: ${reduced}`,
      );
    }
    // 3. Edition probe: the retained shell must report Windows PowerShell 5.x.
    const probe = spawnSync(
      powershellExe,
      [...POWERSHELL_ARGS, "Write-Output \"$($PSVersionTable.PSVersion)\""],
      { encoding: "utf-8", timeout: 20_000, windowsHide: true },
    );
    const version = (probe.stdout ?? "").trim();
    if (probe.error || probe.status !== 0 || !/^5\.\d/.test(version)) {
      throw new Error(
        `5.1 fallback fixture failed: ${powershellExe} did not report a 5.x PowerShell version ` +
          `(status ${probe.status}, output ${JSON.stringify(version)}, stderr ${JSON.stringify((probe.stderr ?? "").trim())}).`,
      );
    }
    // 4. The probes and the suite itself still work under the reduced PATH.
    for (const tool of ["where.exe", "tasklist.exe"]) {
      if (findWindowsExecutable(tool) === null) {
        throw new Error(
          `5.1 fallback fixture failed: ${tool} no longer resolves after removing pwsh directories. Reduced PATH: ${reduced}`,
        );
      }
    }
    const nodeDir = normalizePathEntry(dirname(process.execPath));
    const hadNodeDir = original.split(";").some((e) => e.trim() !== "" && normalizePathEntry(e) === nodeDir);
    if (hadNodeDir && !kept.some((e) => normalizePathEntry(e) === nodeDir)) {
      throw new Error(
        `5.1 fallback fixture failed: node's directory (${dirname(process.execPath)}) was removed together with the pwsh directories. Reduced PATH: ${reduced}`,
      );
    }
    await fn(powershellExe);
  } finally {
    process.env.PATH = original;
    if (originalProgramFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = originalProgramFiles;
  }
}

/** Run `fn` with process.env.PATH replaced, restoring it afterwards. */
async function withPath(pathValue: string | null, fn: () => Promise<void>): Promise<void> {
  const original = process.env.PATH ?? "";
  if (pathValue !== null) process.env.PATH = pathValue;
  try {
    await fn();
  } finally {
    process.env.PATH = original;
  }
}

// ---------------------------------------------------------------------------
// Bounded #404 diagnostics. Test-only and diagnosis only: these helpers never
// print captured output, error text, environment, commands, pids, or paths —
// only fixed labels, allowlisted names, and clamped integers — and they never
// decide an assertion.

/** Keep at most `limit` leading bytes of a stream for scanning, noting truncation. */
function boundedCapture(limit = 16_384) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    push: (data: Buffer | string): void => {
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      const take = bytes.subarray(0, Math.max(0, limit - size));
      if (take.length < bytes.length) truncated = true;
      if (take.length > 0) {
        chunks.push(Buffer.from(take));
        size += take.length;
      }
    },
    text: (): string => Buffer.concat(chunks).toString("utf8"),
    truncated: (): boolean => truncated,
  };
}

type BoundedCapture = ReturnType<typeof boundedCapture>;

const clampCount = (n: number): number => Math.min(Math.max(0, n), 99);

function diagnosticExitCode(code: number | null): string {
  if (code === null) return "null";
  return Number.isSafeInteger(code) ? String(code) : "other";
}

function diagnosticSignal(signal: NodeJS.Signals | null): string {
  if (signal === null) return "null";
  return /^SIG[A-Z0-9]{1,12}$/.test(signal) ? signal : "other";
}

/** The abort stage names the generated wrapper can report, read from the
 *  wrapper text itself so this allowlist cannot drift from production. */
function wrapperFailureStages(wrapped: string): Set<string> {
  const stages = new Set<string>();
  for (const match of wrapped.matchAll(/__pi_review_fail '([a-z][a-z-]{0,39})'/g)) stages.add(match[1]);
  return stages;
}

/** One fixed-label line for the ownership-failure case: exit status, which
 *  allowlisted abort stages the wrapper reported on stderr (an unknown stage
 *  is counted, never printed), whether stdio had closed — the line is taken at
 *  exit, so with `stdioClosed=false` an empty stage list is not proof that no
 *  abort line was written — and when the exit was observed. */
function formatOwnershipFailureDiagnostic(
  exited: boolean,
  exitCode: number | null,
  signalCode: NodeJS.Signals | null,
  wrapped: string,
  stderr: BoundedCapture,
  stdioClosed: boolean,
  exitObservedMs: number | null,
): string {
  const allowlist = wrapperFailureStages(wrapped);
  const stages: string[] = [];
  let abortLines = 0;
  let unrecognized = 0;
  for (const match of stderr.text().matchAll(/\(stage '([^'\r\n]{0,64})'\)/g)) {
    abortLines += 1;
    if (!allowlist.has(match[1])) unrecognized += 1;
    else if (!stages.includes(match[1])) stages.push(match[1]);
  }
  return [
    "issue404 ownership-failure:",
    `exited=${exited}`,
    `exitCode=${diagnosticExitCode(exitCode)}`,
    `signalCode=${diagnosticSignal(signalCode)}`,
    `stages=${stages.length > 0 ? stages.join(",") : "none"}`,
    `abortLines=${clampCount(abortLines)}`,
    `unrecognizedStages=${clampCount(unrecognized)}`,
    `stderrTruncated=${stderr.truncated()}`,
    `stdioClosed=${stdioClosed}`,
    `stageAllowlist=${clampCount(allowlist.size)}`,
    `exitObservedMs=${exitObservedMs === null ? "null" : Math.min(Math.max(0, Math.round(exitObservedMs)), 999_999)}`,
  ].join(" ");
}

// ---------------------------------------------------------------------------
// #404 Job Object close experiment (test-only diagnosis, not product code).
// Node directly spawns a synthetic child that does not exit on its own (stdin
// stays open) and a tiny PowerShell owner. Retaining the ChildProcess object
// does NOT pin the child's pid (an unexpected exit lets the OS reuse it), so
// the owner's OpenProcess(pid) is only trusted through a post-open liveness
// handshake: the owner opens and RETAINS a process handle, reports OPENED, and
// waits; only then does Node send a fresh one-shot challenge over the ORIGINAL
// child's private stdin, and only that child's matching reply on its private
// stdout — proof it was still alive after the handle was opened, so the handle
// is its incarnation — lets Node send ASSIGN. The owner keeps that handle
// through AssignProcessToJobObject and the IsProcessInJob proof, holds the ONLY
// handle to a KILL_ON_JOB_CLOSE job, and on an explicit CLOSE command closes
// it. The test records the kernel's actual exit status for the child without
// assuming it. Nothing is ever killed by pid; cleanup goes only through the two
// directly spawned ChildProcess objects and requires observed exit + close.

const JOB_CLOSE_OWNER_STAGES = new Set([
  "add-type", "create-job", "set-limit", "open-child", "assign-command", "assign", "in-job", "close-command", "close-job",
]);

/** The owner script. Win32 surface is limited to the approved fixture calls. */
function jobCloseOwnerScript(childPid: number): string {
  if (!Number.isSafeInteger(childPid) || childPid <= 0) throw new Error("job-close fixture: invalid child pid");
  const api = "[Pi404JobCloseFixture]";
  return [
    "$ErrorActionPreference = 'Stop'",
    "function Fail($stage) { try { [Console]::Out.WriteLine('JOBCLOSE-OWNER-FAIL ' + $stage); [Console]::Out.Flush() } catch {}; exit 2 }",
    "try { Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class Pi404JobCloseFixture { " +
      "[DllImport(\"kernel32.dll\",CharSet=CharSet.Unicode,SetLastError=true)] public static extern IntPtr CreateJobObjectW(IntPtr a,string n); " +
      "[DllImport(\"kernel32.dll\",SetLastError=true)] public static extern bool SetInformationJobObject(IntPtr j,int c,IntPtr i,uint l); " +
      "[DllImport(\"kernel32.dll\",SetLastError=true)] public static extern IntPtr OpenProcess(uint a,bool i,int p); " +
      "[DllImport(\"kernel32.dll\",SetLastError=true)] public static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p); " +
      "[DllImport(\"kernel32.dll\",SetLastError=true)] public static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool r); " +
      "[DllImport(\"kernel32.dll\",SetLastError=true)] public static extern bool CloseHandle(IntPtr h); }' } catch { Fail 'add-type' }",
    `$job = ${api}::CreateJobObjectW([IntPtr]::Zero, $null); if ($job -eq [IntPtr]::Zero) { Fail 'create-job' }`,
    // JobObjectExtendedLimitInformation (9): LimitFlags at offset 16 =
    // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000); struct 144 bytes (112 on 32-bit).
    "$size = 144; if ([IntPtr]::Size -eq 4) { $size = 112 }",
    "$pin = [Runtime.InteropServices.GCHandle]::Alloc((New-Object byte[] $size), [Runtime.InteropServices.GCHandleType]::Pinned)",
    `try { [Runtime.InteropServices.Marshal]::WriteInt32($pin.AddrOfPinnedObject(), 16, 0x2000); $limited = ${api}::SetInformationJobObject($job, 9, $pin.AddrOfPinnedObject(), $size) } finally { $pin.Free() }`,
    "if (-not $limited) { Fail 'set-limit' }",
    // PROCESS_SET_QUOTA | PROCESS_TERMINATE (assign) | PROCESS_QUERY_LIMITED_INFORMATION (IsProcessInJob).
    `$child = ${api}::OpenProcess(0x1101, $false, ${childPid}); if ($child -eq [IntPtr]::Zero) { Fail 'open-child' }`,
    // Retain $child; assignment waits for Node's post-open child liveness proof.
    "[Console]::Out.WriteLine('JOBCLOSE-OWNER-OPENED'); [Console]::Out.Flush()",
    "if ([Console]::In.ReadLine() -ne 'ASSIGN') { Fail 'assign-command' }",
    `if (-not ${api}::AssignProcessToJobObject($job, $child)) { Fail 'assign' }`,
    "$inJob = $false",
    `if (-not ${api}::IsProcessInJob($child, $job, [ref]$inJob)) { Fail 'in-job' }`,
    "if (-not $inJob) { Fail 'in-job' }",
    `[void]${api}::CloseHandle($child)`,
    "[Console]::Out.WriteLine('JOBCLOSE-OWNER-ASSIGNED'); [Console]::Out.Flush()",
    "if ([Console]::In.ReadLine() -ne 'CLOSE') { Fail 'close-command' }",
    `if (-not ${api}::CloseHandle($job)) { Fail 'close-job' }`,
    "[Console]::Out.WriteLine('JOBCLOSE-OWNER-CLOSED'); [Console]::Out.Flush()",
    "exit 0",
  ].join("\n");
}

/** One directly spawned process with its observed lifecycle. Settled means
 *  positive evidence: `close` observed AND either `exit` observed or the spawn
 *  failed without ever creating a process. */
interface OwnedProcess {
  proc: ChildProcess;
  stdout: BoundedCapture;
  exit: { code: number | null; signal: NodeJS.Signals | null; afterClose: boolean } | null;
  closed: boolean;
  spawnFailed: boolean;
}

const ownedSettled = (p: OwnedProcess): boolean => p.closed && (p.exit !== null || (p.spawnFailed && p.proc.pid === undefined));

/** Event-driven bounded wait: re-checks `pred` on every lifecycle/output change
 *  and resolves false when the bound elapses (never treated as settlement). */
function changeNotifier() {
  let waiters: Array<() => void> = [];
  return {
    notify(): void {
      const current = waiters;
      waiters = [];
      for (const w of current) w();
    },
    wait(pred: () => boolean, ms: number): Promise<boolean> {
      return new Promise((resolve) => {
        if (pred()) { resolve(true); return; }
        const check = (): void => { if (pred()) finish(true); else waiters.push(check); };
        const timer = setTimeout(() => finish(false), ms);
        function finish(value: boolean): void {
          clearTimeout(timer);
          waiters = waiters.filter((w) => w !== check);
          resolve(value);
        }
        waiters.push(check);
      });
    },
  };
}

type ChangeNotifier = ReturnType<typeof changeNotifier>;

function observeOwned(proc: ChildProcess, notifier: ChangeNotifier, closeSent: () => boolean): OwnedProcess {
  const owned: OwnedProcess = { proc, stdout: boundedCapture(), exit: null, closed: false, spawnFailed: false };
  proc.once("exit", (code, signal) => { owned.exit = { code, signal, afterClose: closeSent() }; notifier.notify(); });
  proc.once("close", () => { owned.closed = true; notifier.notify(); });
  proc.on("error", () => { if (proc.pid === undefined) owned.spawnFailed = true; notifier.notify(); });
  proc.stdin?.on("error", () => { /* a dead peer's pipe; lifecycle is judged by exit/close */ });
  proc.stdout?.on("data", (d) => { owned.stdout.push(d); notifier.notify(); });
  proc.stderr?.resume();
  return owned;
}

const hasWitness = (p: OwnedProcess | undefined, token: string): boolean =>
  p !== undefined && new RegExp(`^${token}\\r?$`, "m").test(p.stdout.text());

const isLive = (p: OwnedProcess | undefined): p is OwnedProcess => p !== undefined && p.exit === null && !p.closed;

/** The synthetic child: stays alive on its open stdin and answers exactly one
 *  `JOBCLOSE-CHALLENGE <hex>` line on its private stdout. */
const JOB_CLOSE_CHILD_SOURCE =
  "let b='',r=0;process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{b+=d;" +
  "const m=/^JOBCLOSE-CHALLENGE ([0-9a-f]{32})\\r?$/m.exec(b);" +
  "if(m&&!r){r=1;process.stdout.write('JOBCLOSE-CHILD-ALIVE '+m[1]+'\\n')}});" +
  "process.stdout.write('JOBCLOSE-CHILD-READY\\n')";

/** Ordered fixed phase labels plus the one-shot challenge (never printed). */
interface JobCloseHandshake {
  phases: string[];
  challenge: string | null;
  settledAfterClose: boolean;
}

/** Send the fresh one-shot challenge to the ORIGINAL child's stdin, but only
 *  once the owner has reported OPENED (its process handle is already held) and
 *  both processes are still live. Refuses otherwise. */
function sendChildChallenge(h: JobCloseHandshake, child: OwnedProcess | undefined, owner: OwnedProcess | undefined): boolean {
  if (h.challenge !== null || !hasWitness(owner, "JOBCLOSE-OWNER-OPENED") || !isLive(child) || !isLive(owner)) return false;
  h.challenge = randomBytes(16).toString("hex");
  h.phases.push("challenge-sent");
  child.proc.stdin!.write(`JOBCLOSE-CHALLENGE ${h.challenge}\n`);
  return true;
}

/** Assignment gate: the owner reported OPENED before the challenge went out,
 *  the original child answered THIS challenge, and neither process has exited.
 *  Any missing or mismatched step forbids ASSIGN. */
function jobCloseAssignmentAllowed(h: JobCloseHandshake, child: OwnedProcess | undefined, owner: OwnedProcess | undefined): boolean {
  const opened = h.phases.indexOf("owner-opened");
  const challenged = h.phases.indexOf("challenge-sent");
  return h.challenge !== null && opened >= 0 && challenged > opened && !h.phases.includes("assign-sent")
    && hasWitness(child, `JOBCLOSE-CHILD-ALIVE ${h.challenge}`) && isLive(child) && isLive(owner);
}

/** Request termination of every unsettled process through its own directly
 *  spawned ChildProcess object (never a pid lookup), then require positive
 *  exit + close evidence within a finite bound. Returns the fixed labels whose
 *  settlement could NOT be confirmed. */
async function settleOwnedProcesses(
  owned: Array<[label: string, process: OwnedProcess]>,
  notifier: ChangeNotifier,
  ms: number,
): Promise<string[]> {
  for (const [, p] of owned) {
    if (ownedSettled(p)) continue;
    try { p.proc.stdin?.destroy(); } catch { /* judged by exit/close below */ }
    try { p.proc.kill(); } catch { /* judged by exit/close below */ }
  }
  await notifier.wait(() => owned.every(([, p]) => ownedSettled(p)), ms);
  return owned.filter(([, p]) => !ownedSettled(p)).map(([label]) => label);
}

const JOB_CLOSE_PHASES = [
  "child-ready", "owner-opened", "challenge-sent", "child-alive", "assign-sent", "owner-assigned", "close-sent",
];

/** One fixed-label line: allowlisted phases, an allowlisted owner failure
 *  stage (an unknown one prints as `other`), and clamped numeric exit
 *  outcomes. The challenge value and raw output are never printed. */
function formatJobCloseDiagnostic(
  child: OwnedProcess | undefined,
  owner: OwnedProcess | undefined,
  h: JobCloseHandshake,
): string {
  const stageMatch = owner?.stdout.text().match(/^JOBCLOSE-OWNER-FAIL ([^\r\n]{0,32})\r?$/m);
  const stage = stageMatch ? (JOB_CLOSE_OWNER_STAGES.has(stageMatch[1]) ? stageMatch[1] : "other") : "none";
  const phases = h.phases.slice(0, 16).map((phase) => (JOB_CLOSE_PHASES.includes(phase) ? phase : "other"));
  const outcome = (label: string, p: OwnedProcess | undefined): string[] => [
    `${label}Exited=${p?.exit != null}`,
    `${label}ExitCode=${p?.exit ? diagnosticExitCode(p.exit.code) : "null"}`,
    `${label}Signal=${p?.exit ? diagnosticSignal(p.exit.signal) : "null"}`,
    `${label}ExitAfterClose=${p?.exit ? p.exit.afterClose : "null"}`,
    `${label}Closed=${p?.closed ?? false}`,
  ];
  return [
    "issue404 job-close:",
    `phases=${phases.length > 0 ? phases.join(",") : "none"}`,
    `ownerFailStage=${stage}`,
    `ownerCloseWitness=${hasWitness(owner, "JOBCLOSE-OWNER-CLOSED")}`,
    `settledAfterClose=${h.settledAfterClose}`,
    ...outcome("child", child),
    ...outcome("owner", owner),
  ].join(" ");
}

afterEach(() => {
  reapAll();
});

describe("ShellStart on native Windows: PowerShell discovery (#99)", () => {
  it("prefers pwsh.exe for discovery (Pi finder) and hosts jobs on the selected route", SKIP, async (t) => {
    // Optional prerequisite: a verified absence skips with a truthful reason;
    // a failed, timed-out, or malformed lookup fails with diagnostics instead
    // of masquerading as absence. On the CI Windows shell job the runner image
    // provides PowerShell 7, so PI_REVIEW_GATE_REQUIRE_PWSH=1 makes a verified
    // absence a failure rather than a silent loss of coverage (#405).
    if (!resolvePwshPrerequisite(probePwshPrerequisite(), (message) => t.skip(message))) return;
    // Pi parity is about DISCOVERY, and discovery is unchanged: with both
    // editions resolvable, pwsh.exe is the resolved shell.
    expect(basename(resolveWindowsPowerShell()).toLowerCase(), "discovered shell").toBe("pwsh.exe");
    // Which shell HOSTS a job is the selection ShellStart itself makes (#800):
    // the first ordinary (unpackaged) PowerShell 7, else the Store/MSIX
    // PowerShell 7 on its dedicated launch route, else Windows PowerShell 5.1.
    // The selection is synchronous and uncached, so this reads the same
    // decision the ShellStart call below makes on this host.
    const selection = selectWindowsPowerShellForJobs();
    expect(basename(selection.executable).toLowerCase(), "a PowerShell 7 is selected when one exists").toBe("pwsh.exe");
    expect(selection.route, "route matches the selected image's class").toBe(
      isWindowsAppsPackagePath(selection.executable) ? "msix" : "ordinary",
    );
    const { call } = wire();
    const result = await call("ShellStart", {
      command: "Write-Output (Get-Process -Id $PID).Path; exit 0",
      label: "ps-pref",
    });
    expectNoError(result);
    // Windows details carry the root pid but no process group (none exists).
    expect(typeof result.details.pid, "pid").toBe("number");
    expect(result.details.processGroupId, "processGroupId").toBeUndefined();
    // The card contract survives: the complete submitted command is retained.
    expect(result.details.command, "command").toBe("Write-Output (Get-Process -Id $PID).Path; exit 0");

    const id = textOf(result).match(/as (job\d+)/)![1];
    // An ordinary route runs the selected file itself; the Store route reports
    // the package image (the alias redirects into it), so only the image name
    // is common to both.
    const { ok, log } = await untilLog(call, id, (t) => t.toLowerCase().includes("pwsh.exe"));
    expect(ok, `expected the job to run on pwsh.exe (route ${selection.route}); observed ShellLog:\n${log}`).toBe(true);
    if (selection.route === "ordinary") {
      expect(log.toLowerCase(), "the ordinary route runs the selected executable").toContain(selection.executable.toLowerCase());
    }
    // The Store note appears only on the Store route; an ordinary host sees no
    // change in the tool result.
    const started = textOf(result);
    expect(started.includes("Shell: Store (MSIX) PowerShell 7"), `Store note on route ${selection.route}:\n${started}`).toBe(
      selection.route === "msix",
    );
  });

  it("falls back to powershell.exe when pwsh.exe is absent from PATH", SKIP, async () => {
    await withWindowsPowerShell51(async (powershellExe) => {
      const { call } = wire();
      const result = await call("ShellStart", {
        command: "Write-Output (Get-Process -Id $PID).Path; exit 0",
        label: "ps-fallback",
      });
      expectNoError(result);
      // Fallback control (#800): 5.1 is an ordinary route — no Store launch
      // workaround and no Store note.
      expect(selectWindowsPowerShellForJobs().route, "5.1 is the ordinary route").toBe("ordinary");
      expect(textOf(result).includes("Shell: Store (MSIX)"), "no Store note on 5.1").toBe(false);
      const id = textOf(result).match(/as (job\d+)/)![1];
      // Identity, not mere absence of the other name: the launched shell's own
      // reported path must equal the powershell.exe the fixture verified.
      const { ok, log } = await untilLog(
        call, id,
        (t) => t.toLowerCase().includes(powershellExe.toLowerCase()),
      );
      expect(ok, `expected the launched shell to be ${powershellExe}; observed ShellLog:\n${log}`).toBe(true);
    });
  });

  it("fails clearly without starting a job when no PowerShell is on PATH", SKIP, async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "pi-review-no-ps-"));
    await runWithTempCleanup([emptyDir], { recursive: true }, async () => {
      // Discovery also consults the two standard install locations (#405), so
      // an empty PATH alone would still resolve a PowerShell. Both variables
      // point at nonexistent test-owned directories for the duration of the
      // call (nothing is created, and no child process is spawned here), and
      // both are restored in `finally`.
      const originalProgramFiles = process.env.ProgramFiles;
      const originalSystemRoot = process.env.SystemRoot;
      process.env.ProgramFiles = nonexistentInstallDir("pi-review-no-pwsh7");
      process.env.SystemRoot = nonexistentInstallDir("pi-review-no-systemroot");
      try {
        await withPath(emptyDir, async () => {
          const { call, controller } = wire();
          const result = await call("ShellStart", { command: "Write-Output never", label: "no-ps" });
          expect(result.isError, "isError").toBe(true);
          expect(textOf(result)).toContain("No PowerShell executable");
          // No job was started: nothing running, nothing listed.
          expect(controller.snapshot().running).toEqual([]);
          expect(textOf(await call("ShellList", {}))).toContain("No background jobs");
        });
      } finally {
        if (originalProgramFiles === undefined) delete process.env.ProgramFiles;
        else process.env.ProgramFiles = originalProgramFiles;
        if (originalSystemRoot === undefined) delete process.env.SystemRoot;
        else process.env.SystemRoot = originalSystemRoot;
      }
    });
  });
});

// Exit-status contract, exercised on BOTH explicitly proven editions: the
// pwsh case asserts the default PATH resolves pwsh.exe before it runs, and
// withWindowsPowerShell51 proves pwsh absence + a real 5.x powershell.exe
// for the fallback run — each matrix verifies its own precondition.
const EXIT_CASES: Array<{ name: string; command: string; code: number }> = [
  { name: "successful cmdlet", command: "Write-Output ok", code: 0 },
  { name: "failed cmdlet (no native status)", command: "Get-ChildItem C:\\definitely\\not\\a\\real\\path-pi-review", code: 1 },
  { name: "nonzero native exit", command: "cmd /c exit 7", code: 7 },
  { name: "explicit exit N", command: "exit 3", code: 3 },
  // Status edges from the independent review: a plain `return` leaves the
  // child scope before any tail status capture, so a successful return must
  // still map to 0 — and a native status set BEFORE the return must survive
  // it ($LASTEXITCODE propagation), on both editions.
  { name: "successful return", command: "Write-Output returned; return", code: 0 },
  { name: "terminating throw", command: "throw 'native-test-failure'", code: 1 },
  { name: "nonzero native exit then return", command: "cmd /c exit 7; return", code: 7 },
];

async function runExitMatrix(edition: string, trackStore = false): Promise<void> {
  for (const testCase of EXIT_CASES) {
    const { sent, call } = wire(trackStore);
    await call("ShellStart", { command: testCase.command, label: `ps-exit-${testCase.name.replace(/\s+/g, "-")}` });
    expect(await until(() => sent.length > 0), `${edition}: ${testCase.name} exit wake`).toBe(true);
    expect(sent[0].content, `${edition}: ${testCase.name}`).toContain(`exited ${testCase.code}`);
  }
}

describe("ShellStart on native Windows: invocation and encoding (#99)", () => {
  it("round-trips non-ASCII output through the UTF-8 console prefix", SKIP, async () => {
    const { call } = wire();
    const id = textOf(await call("ShellStart", {
      command: "Write-Output \"héllo wörld 世界\"; exit 0",
      label: "ps-utf8",
    })).match(/as (job\d+)/)![1];
    const { ok, log } = await untilLog(call, id, (t) => t.includes("héllo wörld 世界"));
    expect(ok, `expected UTF-8 round-trip; observed ShellLog:\n${log}`).toBe(true);
  });

  it("handles spaces and quoting in commands", SKIP, async () => {
    const { call } = wire();
    const command =
      "$p = 'C:\\Program Files\\PowerShell'\n" +
      "Write-Output \"path=$p\"\n" +
      "Write-Output 'a \"quoted\" word'; exit 0";
    const id = textOf(await call("ShellStart", { command, label: "ps-quote" })).match(/as (job\d+)/)![1];
    const { ok, log } = await untilLog(
      call, id,
      (t) => t.includes("path=C:\\Program Files\\PowerShell") && t.includes('a "quoted" word'),
    );
    expect(ok, `expected quoted path output; observed ShellLog:\n${log}`).toBe(true);
  });

  it("maps exit status correctly on PowerShell 7 (pwsh)", SKIP, async (t) => {
    // Optional prerequisite: a verified absence skips with a truthful reason;
    // a failed, timed-out, or malformed lookup fails with diagnostics instead
    // of masquerading as absence. On the CI Windows shell job the runner image
    // provides PowerShell 7, so PI_REVIEW_GATE_REQUIRE_PWSH=1 makes a verified
    // absence a failure rather than a silent loss of coverage (#405).
    if (!resolvePwshPrerequisite(probePwshPrerequisite(), (message) => t.skip(message))) return;
    // Prove the edition before trusting the label: production resolution
    // itself must pick pwsh.exe — the probe alone does not subsume this,
    // since production performs its own separate lookups.
    const exe = resolveWindowsPowerShell();
    expect(basename(exe).toLowerCase(), "default PATH resolves pwsh.exe").toBe("pwsh.exe");
    await runExitMatrix("pwsh");
  });

  it("maps exit status correctly on Windows PowerShell 5.1 (powershell.exe)", SKIP, async () => {
    await withWindowsPowerShell51(() => runExitMatrix("powershell.exe"));
  });

  it("delivers ShellSend text to the job's stdin", SKIP, async () => {
    const { call } = wire();
    const id = textOf(await call("ShellStart", {
      command: "$x = [Console]::In.ReadLine(); Write-Output \"got:$x\"; exit 0",
      label: "ps-stdin",
    })).match(/as (job\d+)/)![1];
    await new Promise((r) => setTimeout(r, 800)); // let the shell reach ReadLine
    const sent = await call("ShellSend", { id, text: "hello" });
    expect(sent.isError, "send").toBe(false);
    const { ok, log } = await untilLog(call, id, (t) => t.includes("got:hello"));
    expect(ok, `expected stdin delivery; observed ShellLog:\n${log}`).toBe(true);
  });
});

describe("ShellStart on native Windows: lifecycle and cleanup (#99)", () => {
  // The one that matters most. A grandchild started under the shell must die
  // with ShellStop: the stop file makes the surviving watchdog call
  // TerminateJobObject on the job object — the Windows counterpart of
  // negative-pid group signalling on POSIX (no taskkill, no pid targeting).
  it("ShellStop kills the whole process tree, not just the shell", SKIP, async () => {
    const { call } = wire();
    const id = textOf(await call("ShellStart", {
      command:
        "$p = Start-Process -FilePath \"$env:ComSpec\" -ArgumentList '/c','ping -n 600 127.0.0.1' -PassThru; " +
        "Write-Output \"GRANDCHILD=$($p.Id)\"; Wait-Process -Id $p.Id",
      label: "ps-tree",
    })).match(/as (job\d+)/)![1];

    const { ok, log } = await untilLog(call, id, (t) => t.includes("GRANDCHILD="));
    expect(ok, `expected GRANDCHILD= in ShellLog; observed:\n${log}`).toBe(true);
    const grandchild = Number(log.match(/GRANDCHILD=(\d+)/)![1]);
    expect(pidAlive(grandchild), "grandchild alive before stop").toBe(true);

    await call("ShellStop", { id });
    expect(await until(() => !pidAlive(grandchild), 20_000)).toBe(true);
  });

  // Verified termination on the stop path: `terminated` is written only after
  // TerminateJobObject reported success AND the job's own accounting reported it
  // empty — a kernel observation, not an inference from the watchdog's death.
  // This job has no descendants, so the assertion is about the stop contract
  // itself rather than about which created processes Windows enrolled.
  it("records a verified termination when a stopped job has no surviving members", SKIP, async () => {
    const { sent, call } = wire();
    const result = await call("ShellStart", { command: "Start-Sleep -Seconds 300", label: "ps-stop-verified" });
    expectNoError(result);
    const id = textOf(result).match(/as (job\d+)/)![1];
    const markerPath = result.details.ownershipMarker as string;
    expect(typeof markerPath, "ownershipMarker").toBe("string");

    // The running handshake happened: a live watchdog owns this job.
    expect(await until(() => {
      try { return /^\d+ running$/.test(readFileSync(markerPath, "utf8").trim()); } catch { return false; }
    }, 30_000), "running record before stop").toBe(true);

    const stopped = await call("ShellStop", { id });
    expect(stopped.isError, "stop accepted").toBe(false);

    // The terminal record is the watchdog's verified-empty acknowledgement.
    expect(await until(() => {
      try { return /^\d+ terminated$/.test(readFileSync(markerPath, "utf8").trim()); } catch { return false; }
    }, 30_000), "verified termination recorded").toBe(true);
    // ...and the job settles with it, instead of waiting on a killed pid alone.
    expect(await until(() => sent.length > 0, 30_000), "exit wake after verified stop").toBe(true);
  });

  // The backstop for a host death no signal handler can catch. A job must die
  // — together with its descendants — when pi-review-gate dies by ANY means.
  // Simulated with a throwaway parent so the test can hard-kill it safely,
  // through the same production spawn path ShellStart uses (poll at 1s). The
  // watchdog's cleanup line must be REACHED on parent death — this is the
  // regression review pass 2 caught, validated natively on both editions.
  async function runParentDeath(): Promise<void> {
    const parent = spawn(process.execPath, ["-e", "setTimeout(()=>{},120_000)"], { stdio: "ignore" });
    const maybeParentPid = parent.pid;
    if (!maybeParentPid) throw new Error("test parent did not start");
    const parentPid = maybeParentPid;
    try {
      const { proc } = spawnBackgroundJob(
        "$p = Start-Process -FilePath \"$env:ComSpec\" -ArgumentList '/c','ping -n 600 127.0.0.1' -PassThru; " +
        "Write-Output \"GRANDCHILD=$($p.Id)\"; Wait-Process -Id $p.Id",
        parentPid,
        1,
      );
      let out = "";
      proc.stdout!.on("data", (d) => { out += d.toString(); });
      expect(await until(() => /GRANDCHILD=\d+/.test(out), 30_000)).toBe(true);
      const grandchild = Number(out.match(/GRANDCHILD=(\d+)/)![1]);
      expect(pidAlive(grandchild), "grandchild alive before parent death").toBe(true);

      // Hard-kill the parent: no handler runs, nothing gets a chance to clean up.
      process.kill(parentPid, "SIGKILL");

      // The watchdog polls at 1s here, so both die quickly.
      expect(await until(() => !pidAlive(grandchild), 30_000)).toBe(true);
      expect(await until(async () => proc.exitCode !== null || proc.signalCode !== null, 15_000)).toBe(true);
    } finally {
      try { parent.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }

  it("kills the job and its descendants when its parent disappears (PowerShell 7)", SKIP, async () => {
    await runParentDeath();
  });

  it("kills the job and its descendants when its parent disappears (Windows PowerShell 5.1)", SKIP, async () => {
    await withWindowsPowerShell51(runParentDeath);
  });

  // An explicit `exit N` terminates the shell before any trailing cleanup; the
  // watchdog is deliberately NOT killed by the wrapper — it verifies the job
  // empty on its next poll (default 5 s) and releases itself, keeping code N
  // and leaving no polling process behind. The probe counts PowerShell
  // processes from Node via tasklist, so it never counts itself.
  async function runExplicitExitLeakCheck(): Promise<void> {
    const baseline = countShellProcesses();
    const { sent, call } = wire();
    await call("ShellStart", { command: "exit 3", label: "ps-exit-leak" });
    expect(await until(() => sent.length > 0), "exit wake").toBe(true);
    expect(sent[0].content).toContain("exited 3");
    // The watchdog self-releases within one poll after verifying the job
    // empty; wait on a deadline rather than a fixed sleep.
    expect(
      await until(() => countShellProcesses() <= baseline, 25_000),
      "no leftover PowerShell processes after explicit exit",
    ).toBe(true);
  }

  it("explicit exit N disposes the watchdog and keeps code N (PowerShell 7)", SKIP, async () => {
    await runExplicitExitLeakCheck();
  });

  it("explicit exit N disposes the watchdog and keeps code N (Windows PowerShell 5.1)", SKIP, async () => {
    await withWindowsPowerShell51(runExplicitExitLeakCheck);
  });

  it("reapAll leaves nothing running", SKIP, async () => {
    const { call } = wire();
    const id = textOf(await call("ShellStart", {
      command:
        "$p = Start-Process -FilePath \"$env:ComSpec\" -ArgumentList '/c','ping -n 600 127.0.0.1' -PassThru; " +
        "Write-Output \"GRANDCHILD=$($p.Id)\"; Wait-Process -Id $p.Id",
      label: "ps-leak",
    })).match(/as (job\d+)/)![1];
    const { ok, log } = await untilLog(call, id, (t) => t.includes("GRANDCHILD="));
    expect(ok, `expected GRANDCHILD= in ShellLog; observed:\n${log}`).toBe(true);
    const grandchild = Number(log.match(/GRANDCHILD=(\d+)/)![1]);

    reapAll();
    expect(await until(() => !pidAlive(grandchild), 20_000)).toBe(true);
  });
});

describe("ShellStart on native Windows: descendant ownership after root exit (#99 follow-up)", () => {
  // The command starts a long-lived grandchild fully detached from the shell's
  // stdio (Start-Process with redirected output — exactly the shape that used
  // to escape both taskkill /T and readiness once the root exited), then exits
  // immediately, leaving the job object as the only thing holding the tree.
  function detachedGrandchildCommand(outFile: string): string {
    return (
      // The witness is launched DIRECTLY, so the recorded pid belongs to the
      // process doing the work. A `cmd /c ping` wrapper would leave the tracked
      // identity on cmd.exe and the actual descendant unobserved, which can pass
      // while that descendant is still alive.
      "$p = Start-Process -FilePath (Join-Path ([Environment]::SystemDirectory) 'PING.EXE') " +
      "-ArgumentList '-n','120','127.0.0.1' " +
      `-RedirectStandardOutput '${outFile}' -RedirectStandardError '${outFile}.err' -PassThru; ` +
      // The creation ticks travel with the pid, so a regression can hold the
      // SAME identity across the stop instead of a possibly reused pid.
      "Write-Output \"GRANDCHILD=$($p.Id) $($p.StartTime.Ticks)\"; exit 0"
    );
  }

  function freshOutFile(prefix: string): string {
    return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  }

  it("keeps a root-exited job accounted for and blocks readiness until the tree is verified gone", SKIP, async () => {
    const outFile = freshOutFile("pi-review-descendant");
    await runWithTempCleanup([outFile, `${outFile}.err`], {}, async () => {
      const { sent, call, controller } = wire();
      const result = await call("ShellStart", {
        command: detachedGrandchildCommand(outFile),
        label: "ps-descendant",
      });
      expectNoError(result);
      // The production wiring surfaces the ownership record path in details.
      expect(typeof result.details.ownershipMarker, "ownershipMarker").toBe("string");
      const rootPid = result.details.pid as number;
      const id = textOf(result).match(/as (job\d+)/)![1];

      // Feed the REAL ShellStart result into the harness-side readiness tracker.
      const readiness = new BackgroundProcessReadiness();
      expect(readiness.observeToolResult("ShellStart", result) !== undefined, "tracked").toBe(true);

      const { ok, log } = await untilLog(call, id, (t) => t.includes("GRANDCHILD="), 30_000);
      expect(ok, `expected GRANDCHILD= in ShellLog; observed:\n${log}`).toBe(true);
      const grandchild = Number(log.match(/GRANDCHILD=(\d+)/)![1]);
      const grandchildTicks = log.match(/GRANDCHILD=\d+ ([0-9]{1,20})/)![1];

      // The root exits on its own (the wrapper ran `exit 0`)...
      expect(await until(() => !pidAlive(rootPid), 30_000)).toBe(true);
      // ...while the detached grandchild lives on. Ownership evidence — a live
      // watchdog holding the job object — keeps the job accounted for and
      // readiness blocked instead of falsely clearing it.
      expect(pidAlive(grandchild), "grandchild alive after root exit").toBe(true);
      // Identity, not just a pid: the process still alive after the root exit is
      // the one the fixture created, so the settlement check below cannot be
      // satisfied by a recycled pid.
      expect(windowsCreationTicks(grandchild), "same grandchild identity after root exit").toBe(grandchildTicks);
      const listText = textOf(await call("ShellList", {}));
      expect(listText.includes(id) && listText.includes("running"), "job still listed as running after root exit").toBe(true);
      expect(controller.snapshot().running.length, "controller still reports the job").toBe(1);
      expect(readiness.snapshot().running.length, "readiness blocked while owned descendants remain").toBe(1);

      // ShellStop reaches the grandchild even though its root pid is gone: the
      // stop file makes the surviving watchdog TerminateJobObject.
      const stopped = await call("ShellStop", { id });
      expectNoError(stopped);
      // The witness runs for ~2 minutes, so settling inside this 30 s bound is
      // the stop's doing, not the fixture's self-expiry.
      expect(await until(() => !pidAlive(grandchild), 30_000)).toBe(true);
      expect(windowsCreationTicks(grandchild), "the grandchild identity is gone, not replaced").toBeNull();
      // Disappearance alone could be the witness expiring; the watchdog's own
      // verified-empty acknowledgement is what proves the stop terminated it.
      const markerPath = result.details.ownershipMarker as string;
      expect(
        await until(() => /^\d+ terminated$/.test(readFileSync(markerPath, "utf8").trim()), 30_000),
        "watchdog explicitly confirmed the stop",
      ).toBe(true);

      // The job settles only once ownership is verified complete (the record
      // carries an explicit terminal state), and readiness clears with it.
      expect(await until(() => sent.length > 0, 30_000), "exit wake after verified release").toBe(true);
      expect(sent[0].content).toContain("exited 0");
      expect(readiness.snapshot().running.length, "readiness clear once verified").toBe(0);
    });
  });

  // Host death AFTER the root has already exited: no signal handler runs, and
  // taskkill /T rooted at the (dead) root pid cannot reach the grandchild. Only
  // the surviving watchdog's parent-death path — TerminateJobObject on the job
  // it alone holds — can. Polls at 1 s here so both checks land quickly.
  async function runHostDeathAfterRootExit(): Promise<void> {
    const outFile = freshOutFile("pi-review-hostdeath");
    await runWithTempCleanup([outFile, `${outFile}.err`], {}, async () => {
      const parent = spawn(process.execPath, ["-e", "setTimeout(()=>{},120_000)"], { stdio: "ignore" });
      const maybeParentPid = parent.pid;
      if (!maybeParentPid) throw new Error("test parent did not start");
      const parentPid = maybeParentPid;
      try {
        const { proc } = spawnBackgroundJob(detachedGrandchildCommand(outFile), parentPid, 1);
        let out = "";
        proc.stdout!.on("data", (d) => { out += d.toString(); });
        expect(await until(() => /GRANDCHILD=\d+/.test(out), 30_000)).toBe(true);
        const grandchild = Number(out.match(/GRANDCHILD=(\d+)/)![1]);

        // The root exits on its own; the watchdog now holds the job alone.
        expect(await until(() => proc.exitCode !== null || proc.signalCode !== null, 30_000)).toBe(true);
        expect(pidAlive(grandchild), "grandchild alive after root exit").toBe(true);

        // Hard-kill the host: no handler runs, nothing gets a chance to clean up.
        process.kill(parentPid, "SIGKILL");
        expect(await until(() => !pidAlive(grandchild), 30_000)).toBe(true);
      } finally {
        try { parent.kill("SIGKILL"); } catch { /* already gone */ }
      }
    });
  }

  it("terminates descendants when the host dies after the root has exited (PowerShell 7)", SKIP, async () => {
    await runHostDeathAfterRootExit();
  });

  it("terminates descendants when the host dies after the root has exited (Windows PowerShell 5.1)", SKIP, async () => {
    await withWindowsPowerShell51(runHostDeathAfterRootExit);
  });

  // Fail-closed ownership establishment: a marker path that is an existing
  // directory can never receive the record, so the watchdog's handshake fails.
  // The wrapper must abort BEFORE the user command runs — no unprotected
  // execution — and the job must never read as complete: with the root gone
  // and the marker still an unreadable directory, the production verdict is
  // `unverifiable` and readiness stays blocked.
  //
  // The wrapper's exit status alone is NOT the success signal, so it is not
  // asserted as "nonzero". Two outcomes are evidenced natively (Refs #404) and
  // are the only ones accepted: 1 is the wrapper's own `__pi_review_fail` exit
  // (native run printed stage=record-unreadable); 0 is a TERMINATION outcome,
  // not clean completion — when the watchdog dies after assigning the root, the
  // kernel's KILL_ON_JOB_CLOSE ends the wrapper, and the controlled native
  // Job Object probe below observed exactly that exit status 0 after closing
  // the only kill-on-close handle. That probe shows 0 is a possible
  // termination outcome; it does not establish the exact cause of the
  // historical exit-0 run here. Either way, the guards below — canary absent,
  // marker unreadable, verdict `unverifiable`, readiness blocked — must hold;
  // any other exit status or signal fails.
  //
  // Diagnosis only: before the assertions, one fixed-label line records the
  // wrapper's exit status and the allowlisted abort stage names it reached. It
  // never prints output, errors, environment, or paths, and decides nothing.
  it("fails closed before running the command when ownership cannot be established", SKIP, async (t) => {
    const markerDir = mkdtempSync(join(tmpdir(), "pi-review-owner-fail-"));
    await runWithTempCleanup([markerDir], { recursive: true }, async () => {
      const wrapped = wrapWithPowerShellWatchdog(
        "Write-Output OWNERFAIL-CANARY; exit 0",
        process.pid,
        1,
        { markerPath: markerDir, stopPath: join(tmpdir(), "pi-review-owner-fail.stop") },
        5_000,
      );
      const executable = resolveWindowsPowerShell();
      const spawnedAt = Date.now();
      const child = spawn(executable, [...POWERSHELL_ARGS, wrapped], { windowsHide: true });
      // The exact owned root: the directly spawned wrapper's own pid.
      const rootPid = child.pid;
      let out = "";
      const stderrCapture = boundedCapture();
      let exitObservedMs: number | null = null;
      let stdioClosed = false;
      child.once("exit", () => { exitObservedMs = Date.now() - spawnedAt; });
      child.once("close", () => { stdioClosed = true; });
      child.stdout!.on("data", (d) => { out += d.toString(); });
      child.stderr!.on("data", (d) => { out += d.toString(); });
      child.stderr!.on("data", stderrCapture.push);
      const exited = await until(() => child.exitCode !== null || child.signalCode !== null, 30_000);
      t.diagnostic(formatOwnershipFailureDiagnostic(
        exited, child.exitCode, child.signalCode, wrapped, stderrCapture, stdioClosed, exitObservedMs,
      ));
      expect(exited, "wrapper exited").toBe(true);
      expect(out).not.toContain("OWNERFAIL-CANARY");
      expect(typeof rootPid === "number" && rootPid > 0, "owned root pid").toBe(true);
      // Only the natively evidenced outcomes: 1 (wrapper fail-closed exit) or
      // 0 (kill-on-close termination), never a signal or any other status.
      expect(child.signalCode, "no signal termination").toBe(null);
      expect(
        child.exitCode === 1 || child.exitCode === 0,
        `exit status ${diagnosticExitCode(child.exitCode)} is an evidenced ownership-failure outcome (1 or 0)`,
      ).toBe(true);

      // Whatever the exit status, ownership evidence stays unreadable: the
      // marker is still a directory, so no record (not even `0 failed`) exists.
      let markerIsDirectory = false;
      try { markerIsDirectory = statSync(markerDir).isDirectory(); } catch {
        // Fail the fixed-label assertion below without exposing a filesystem path.
      }
      expect(markerIsDirectory, "marker path is still an unreadable directory").toBe(true);
      // Root exit observed on the exact ChildProcess -> rootAlive=false. The
      // production verdict for missing evidence is `unverifiable`, never `clear`.
      expect(ownershipVerdict(markerDir, false, pidAlive), "production ownership verdict").toBe("unverifiable");

      // The production readiness tracker, fed fixture metadata for THIS wrapper
      // (its real pid and the real marker path) through its public structured
      // input — this fixture is a directly spawned wrapper, not a registered
      // ShellStart job. On Windows the snapshot must keep it in `running`.
      const readiness = new BackgroundProcessReadiness();
      const tracked = readiness.observeToolResult("ShellStart", {
        details: {
          kind: "pi-review-bg-shell",
          event: "started",
          id: "owner-fail-fixture",
          label: "owner-fail-fixture",
          pid: rootPid,
          ownershipMarker: markerDir,
        },
      });
      expect(tracked?.pid === rootPid && tracked?.ownershipMarker === markerDir, "tracks the fixture's own pid and marker").toBe(true);
      const snapshot = readiness.snapshot();
      const retained = snapshot.running[0];
      expect(
        snapshot.running.length === 1 && retained?.pid === rootPid && retained?.ownershipMarker === markerDir,
        "readiness stays blocked on unverifiable ownership even after the root exited",
      ).toBe(true);
      expect(snapshot.unverifiable.length, "tracked as a structured job, not as unparseable output").toBe(0);
    });
  });
  // Paths with spaces and apostrophes must survive BOTH quoting layers: the
  // .Replace argument inside the wrapper script, and the assignment in the
  // resulting watchdog script. Run a real job end-to-end (job object,
  // handshake, command, self-release) with such paths.
  it("establishes ownership through marker/stop paths containing spaces and apostrophes", SKIP, async () => {
    const dir = join(tmpdir(), "pi review owner", "it's here");
    mkdirSync(dir, { recursive: true });
    await runWithTempCleanup([join(tmpdir(), "pi review owner")], { recursive: true }, async () => {
      const markerPath = join(dir, "job file.job");
      const wrapped = wrapWithPowerShellWatchdog(
        "Write-Output HOSTILEPATH-OK; exit 0",
        process.pid,
        1,
        { markerPath, stopPath: join(dir, "stop file.stop") },
        30_000,
      );
      const executable = resolveWindowsPowerShell();
      const child = spawn(executable, [...POWERSHELL_ARGS, wrapped], { windowsHide: true });
      let out = "";
      child.stdout!.on("data", (d) => { out += d.toString(); });
      expect(await until(() => child.exitCode !== null || child.signalCode !== null, 30_000), "wrapper exited").toBe(true);
      expect(child.exitCode, "clean exit").toBe(0);
      expect(out).toContain("HOSTILEPATH-OK");
      // The record was written AT the quoted path (handshake + heartbeat worked)...
      expect(await until(() => {
        try { return readFileSync(markerPath, "utf8").trim().length > 0; } catch { return false; }
      }, 30_000), "record written at the quoted path").toBe(true);
      const marker = readFileSync(markerPath, "utf8").trim();
      expect(/^\d+ (running|released)$/.test(marker), `well-formed record: ${marker}`).toBe(true);
      // ...and the watchdog self-released after verifying the job empty.
      expect(await until(() => {
        try { return readFileSync(markerPath, "utf8").includes("released"); } catch { return false; }
      }, 30_000), "watchdog released itself").toBe(true);
    });
  });

  // Natural descendant completion: the root exits immediately, the grandchild
  // survives across SEVERAL watchdog polls (so release cannot be a one-tick
  // artifact), then finishes on its own. Readiness must stay blocked while the
  // owned descendant lives and clear once the job is verified empty — without
  // anyone killing anything. Exercises the accounting-query release path.
  async function runNaturalCompletion(): Promise<void> {
    const outFile = freshOutFile("pi-review-natural");
    await runWithTempCleanup([outFile, `${outFile}.err`], {}, async () => {
      const { sent, call } = wire();
      const result = await call("ShellStart", {
        command: (
          "$p = Start-Process -FilePath \"$env:ComSpec\" " +
          "-ArgumentList '/c','ping -n 12 127.0.0.1' " +
          `-RedirectStandardOutput '${outFile}' -RedirectStandardError '${outFile}.err' -PassThru; ` +
          "Write-Output \"GRANDCHILD=$($p.Id)\"; exit 0"
        ),
        label: "ps-natural",
      });
      expectNoError(result);
      const readiness = new BackgroundProcessReadiness();
      expect(readiness.observeToolResult("ShellStart", result) !== undefined, "tracked").toBe(true);
      const id = textOf(result).match(/as (job\d+)/)![1];
      const rootPid = result.details.pid as number;

      const { ok, log } = await untilLog(call, id, (t) => t.includes("GRANDCHILD="), 30_000);
      expect(ok, `expected GRANDCHILD= in ShellLog; observed:\n${log}`).toBe(true);
      const grandchild = Number(log.match(/GRANDCHILD=(\d+)/)![1]);

      // The root exits on its own; the owned descendant keeps readiness blocked...
      expect(await until(() => !pidAlive(rootPid), 30_000)).toBe(true);
      expect(pidAlive(grandchild), "grandchild alive after root exit").toBe(true);
      expect(readiness.snapshot().running.length, "blocked while the descendant lives").toBe(1);

      // ...across several watchdog polls (default 5 s; ping -n 12 is about 11 s).
      await new Promise((r) => setTimeout(r, 7_000));
      expect(readiness.snapshot().running.length, "still blocked across polls").toBe(1);

      // ...until the descendant finishes naturally and the job is verified empty.
      expect(await until(() => !pidAlive(grandchild), 30_000)).toBe(true);
      expect(await until(() => sent.length > 0, 30_000), "exit wake after natural completion").toBe(true);
      expect(sent[0].content).toContain("exited 0");
      expect(readiness.snapshot().running.length, "clear once verified empty").toBe(0);
    });
  }

  it("keeps readiness blocked across watchdog polls until a descendant finishes naturally (PowerShell 7)", SKIP, async () => {
    await runNaturalCompletion();
  });

  it("keeps readiness blocked across watchdog polls until a descendant finishes naturally (Windows PowerShell 5.1)", SKIP, async () => {
    await withWindowsPowerShell51(runNaturalCompletion);
  });
});
// ── Root identity guard before job assignment (#705) ─────────────────────
//
// The watchdog assigns the shell root to its job only after the root's
// captured creation identity matches through the SAME opened handle. These
// controls drive the producer's actual Add-Type class (extracted verbatim from
// wrapWithPowerShellWatchdog — the guard algorithm is never copied here) in a
// directly owned PowerShell process that targets ONLY ITSELF while it runs, so
// no foreign or reusable pid is ever opened, assigned, or killed. Every job is
// a fresh plain job object WITHOUT kill limits: membership is observable with
// IsProcessInJob and closing the handles never terminates anything. Output is
// fixed witness names with booleans/edition only — no paths, pids, ticks, raw
// stderr, environment, or command text.

/** The producer's one-line kernel32 class text, exactly as embedded in the
 *  watchdog's single-quoted Add-Type string (apostrophe-free by construction). */
function producerJobApiClass(): string {
  const script = wrapWithPowerShellWatchdog("Write-Output unused", process.pid, 1, {
    markerPath: "unused.job",
    stopPath: "unused.stop",
  });
  const match = script.match(/Add-Type -TypeDefinition '([^']*public static class PiReviewBgJobApi \{[^']*)'/);
  if (!match) throw new Error("producer PiReviewBgJobApi class text not found in wrapWithPowerShellWatchdog output");
  return match[1];
}

/** Ordered witness names and the exact value each control must produce.
 *  Order matters: both stale negatives and the unreadable-identity control
 *  run BEFORE the matching positive, and the raw assignment that proves the
 *  query-denied handle was assignable runs after it. */
const GUARD_EXPECTED: ReadonlyArray<readonly [string, string]> = [
  ["stale-plus.guard", "False"],
  ["stale-plus.member", "False"],
  ["stale-minus.guard", "False"],
  ["stale-minus.member", "False"],
  ["denied.times", "False"],
  ["denied.guard", "False"],
  ["denied.member", "False"],
  ["zero.guard", "False"],
  ["zero.member", "False"],
  ["match.guard", "True"],
  ["match.member", "True"],
  ["denied.raw-assign", "True"],
  ["denied.raw-member", "True"],
  ["stale-plus.member-after", "False"],
  ["stale-minus.member-after", "False"],
  ["denied.member-after", "False"],
  ["zero.member-after", "False"],
  ["done", "True"],
];
const GUARD_BOOL_KEYS = new Set<string>(GUARD_EXPECTED.map(([k]) => k));
const GUARD_WITNESS_KEYS = new Set<string>([...GUARD_BOOL_KEYS, "edition", "major", "failed-stage"]);
/** stdout cap in BYTES (16 KiB). Exceeding it fails native verification. */
const GUARD_STDOUT_CAP = 16 * 1024;
/** The value every unrecognized input normalizes to. It never equals an
 *  expected control value, so it can only fail an assertion. */
const GUARD_OTHER = "other";

/** Byte-bounded stdout capture: keeps at most `cap` bytes and records
 *  whether anything beyond the cap arrived. */
function createBoundedByteSink(cap: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk: Buffer): void {
      const room = cap - bytes;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        bytes = cap;
        truncated = true;
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    },
    get bytes(): number { return bytes; },
    get truncated(): boolean { return truncated; },
    text(): string { return Buffer.concat(chunks).toString("utf8"); },
  };
}

/** Helper stage names, derived from the generated script itself (its
 *  `$stage = '...'` assignments): the single stage vocabulary definition. */
function guardStageVocabulary(): ReadonlySet<string> {
  const script = guardSelfTestScript(producerJobApiClass());
  return new Set([...script.matchAll(/\$stage = '([a-z-]+)'/g)].map((m) => m[1]));
}

/** The ONE canonical normalizer for a recognized witness: a closed value
 *  set per key (True/False controls, Desktop/Core edition, a bounded major
 *  version, known stage names). Everything else becomes GUARD_OTHER — never
 *  a valid expected value. */
function normalizeGuardWitness(key: string, raw: string, stages: ReadonlySet<string>): string {
  if (GUARD_BOOL_KEYS.has(key)) return raw === "True" || raw === "False" ? raw : GUARD_OTHER;
  if (key === "edition") return raw === "Desktop" || raw === "Core" ? raw : GUARD_OTHER;
  if (key === "major") return /^[1-9][0-9]?$/.test(raw) ? raw : GUARD_OTHER;
  if (key === "failed-stage") return stages.has(raw) ? raw : GUARD_OTHER;
  return GUARD_OTHER;
}

function guardSelfTestScript(cls: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$stage = 'setup'",
    "function Witness($name, $value) { Write-Output ('PIW ' + $name + '=' + [string][bool]$value) }",
    "try {",
    `Add-Type -TypeDefinition '${cls}'`,
    // Test-only observation surface (membership + pseudo-handle); the guard
    // itself comes exclusively from the producer class above.
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PiReviewBgJobGuardProbe { [DllImport(\"kernel32.dll\")] public static extern IntPtr GetCurrentProcess(); [DllImport(\"kernel32.dll\",SetLastError=true)] public static extern bool IsProcessInJob(IntPtr p,IntPtr j,out bool r); }'",
    "Write-Output ('PIW edition=' + $PSVersionTable.PSEdition)",
    "Write-Output ('PIW major=' + $PSVersionTable.PSVersion.Major)",
    "$self = [PiReviewBgJobGuardProbe]::GetCurrentProcess()",
    // The exact identity format production captures for the root.
    "$ticks = [System.Diagnostics.Process]::GetCurrentProcess().StartTime.Ticks",
    "function New-FreshJob { $j = [PiReviewBgJobApi]::CreateJobObjectW([IntPtr]::Zero, $null); if ($j -eq [IntPtr]::Zero) { throw 'fresh-job' }; return $j }",
    "function Test-Member($j) { $r = $false; if (-not [PiReviewBgJobGuardProbe]::IsProcessInJob($self, $j, [ref]$r)) { throw 'membership' }; return $r }",
    "$stage = 'stale-plus'",
    "$jPlus = New-FreshJob",
    "Witness 'stale-plus.guard' ([PiReviewBgJobApi]::AssignOwnedRoot($jPlus, $PID, $ticks + 1))",
    "Witness 'stale-plus.member' (Test-Member $jPlus)",
    "$stage = 'stale-minus'",
    "$jMinus = New-FreshJob",
    "Witness 'stale-minus.guard' ([PiReviewBgJobApi]::AssignOwnedRoot($jMinus, $PID, $ticks - 1))",
    "Witness 'stale-minus.member' (Test-Member $jMinus)",
    // Unreadable identity: TERMINATE|SET_QUOTA (0x0101) is enough to assign
    // but grants no query right, so GetProcessTimes must fail on it.
    "$stage = 'denied'",
    "$denied = [PiReviewBgJobApi]::OpenProcess(0x0101, $false, $PID)",
    "if ($denied -eq [IntPtr]::Zero) { throw 'denied-open' }",
    "$c = [long]0; $x = [long]0; $k = [long]0; $u = [long]0",
    "Witness 'denied.times' ([PiReviewBgJobApi]::GetProcessTimes($denied, [ref]$c, [ref]$x, [ref]$k, [ref]$u))",
    "$jDenied = New-FreshJob",
    "Witness 'denied.guard' ([PiReviewBgJobApi]::AssignRootIfIdentity($jDenied, $denied, $ticks))",
    "Witness 'denied.member' (Test-Member $jDenied)",
    "$stage = 'zero'",
    "$jZero = New-FreshJob",
    "Witness 'zero.guard' ([PiReviewBgJobApi]::AssignRootIfIdentity($jZero, [IntPtr]::Zero, $ticks))",
    "Witness 'zero.member' (Test-Member $jZero)",
    "$stage = 'match'",
    "$jMatch = New-FreshJob",
    "Witness 'match.guard' ([PiReviewBgJobApi]::AssignOwnedRoot($jMatch, $PID, $ticks))",
    "Witness 'match.member' (Test-Member $jMatch)",
    "$stage = 'raw-assign'",
    "$jRaw = New-FreshJob",
    "Witness 'denied.raw-assign' ([PiReviewBgJobApi]::AssignProcessToJobObject($jRaw, $denied))",
    "Witness 'denied.raw-member' (Test-Member $jRaw)",
    "$stage = 'after'",
    "Witness 'stale-plus.member-after' (Test-Member $jPlus)",
    "Witness 'stale-minus.member-after' (Test-Member $jMinus)",
    "Witness 'denied.member-after' (Test-Member $jDenied)",
    "Witness 'zero.member-after' (Test-Member $jZero)",
    "$stage = 'release'",
    "foreach ($h in @($denied, $jPlus, $jMinus, $jDenied, $jZero, $jMatch, $jRaw)) { [void][PiReviewBgJobApi]::CloseHandle($h) }",
    "Witness 'done' $true",
    "exit 0",
    "} catch {",
    "Write-Output ('PIW failed-stage=' + $stage)",
    "exit 3",
    "}",
  ].join("\n");
}

/** What the owned process produced, before normalization. Never printed or
 *  asserted on directly. */
interface GuardSelfTestRaw {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stdoutTruncated: boolean;
  stderrBytes: number;
}

/** Normalized outcome: every field comes from a closed vocabulary, so both
 *  assertions and diagnostics only ever see allowlisted names and values. */
interface GuardSelfTestOutcome {
  exit: string;
  signal: string;
  witnesses: Array<[string, string]>;
  stdoutTruncated: boolean;
  stderrBytes: string;
}

const GUARD_STDERR_REPORT_CAP = 65_536;
/** Closed signal vocabulary: the signals Node can report for a Windows child
 *  (ChildProcess.kill and console control events). Anything else is 'other'. */
const GUARD_KNOWN_SIGNALS = new Set<string>(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGBREAK"]);

function normalizeGuardOutcome(raw: GuardSelfTestRaw, stages: ReadonlySet<string>): GuardSelfTestOutcome {
  const witnesses: Array<[string, string]> = [];
  for (const line of raw.stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^PIW ([a-z.-]{1,40})=(.*)$/);
    // Only allowlisted names are kept; their values are normalized at once
    // and the raw value is never retained.
    if (m && GUARD_WITNESS_KEYS.has(m[1])) witnesses.push([m[1], normalizeGuardWitness(m[1], m[2], stages)]);
  }
  const code = raw.exitCode;
  const exit = code === null
    ? "none"
    : Number.isInteger(code) && code >= -2_147_483_648 && code <= 4_294_967_295 ? String(code) : GUARD_OTHER;
  const signal = raw.signal === null ? "none" : GUARD_KNOWN_SIGNALS.has(raw.signal) ? raw.signal : GUARD_OTHER;
  const n = raw.stderrBytes;
  const stderrBytes = !Number.isInteger(n) || n < 0
    ? GUARD_OTHER
    : n > GUARD_STDERR_REPORT_CAP ? `${GUARD_STDERR_REPORT_CAP}+` : String(n);
  return { exit, signal, witnesses, stdoutTruncated: raw.stdoutTruncated === true, stderrBytes };
}

/** Fixed-vocabulary summary for assertion messages: normalized fields only —
 *  never raw output, paths, pids, ticks, error or signal text. */
function describeGuardOutcome(outcome: GuardSelfTestOutcome): string {
  const witnesses = outcome.witnesses.map(([k, v]) => `${k}=${v}`).join(", ");
  return `exit=${outcome.exit} signal=${outcome.signal} stdoutTruncated=${outcome.stdoutTruncated} ` +
    `stderrBytes=${outcome.stderrBytes} witnesses=[${witnesses}]`;
}

/** Race `work` against a deadline whose timer is always cleared once the
 *  race finishes, so a settled control never keeps the test process alive
 *  until the unused deadline would have fired. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), ms); });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run the self-targeting guard controls in ONE directly owned PowerShell
 *  process and return only after that exact ChildProcess has positively
 *  emitted BOTH `exit` and `close`. On timeout or any setup failure the
 *  process is stopped through its own ChildProcess handle (never a bare pid)
 *  and settlement is still awaited; failing to observe it fails the test. */
async function runGuardSelfTest(executable: string): Promise<GuardSelfTestOutcome> {
  const encoded = Buffer.from(guardSelfTestScript(producerJobApiClass()), "utf16le").toString("base64");
  const child = spawn(
    executable,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let exited = false;
  let closed = false;
  let spawnFailed = false;
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  const stdout = createBoundedByteSink(GUARD_STDOUT_CAP);
  let stderrBytes = 0;
  const exitSeen = new Promise<void>((resolve) => {
    child.once("exit", (code, sig) => { exited = true; exitCode = code; signal = sig; resolve(); });
  });
  const closeSeen = new Promise<void>((resolve) => {
    child.once("close", () => { closed = true; resolve(); });
  });
  // The error listener stays attached for the child's whole lifetime: a
  // started process can report more than one runtime error (including one
  // from child.kill below), and a consumed one-shot listener would let the
  // next become an unhandled 'error' that skips the awaited settlement.
  // Only the FIRST error classifies the outcome and settles this race.
  let errorSeen = false;
  const spawnError = new Promise<void>((resolve) => {
    child.on("error", () => {
      if (errorSeen) return;
      errorSeen = true;
      spawnFailed = child.pid === undefined;
      resolve();
    });
  });
  child.stdout!.on("data", (d: Buffer) => { stdout.push(d); });
  child.stderr!.on("data", (d: Buffer) => { stderrBytes += d.length; });
  const settled = Promise.all([exitSeen, closeSeen]).then(() => "settled" as const);
  let timedOut = false;
  try {
    const first = await withDeadline(Promise.race([settled, spawnError.then(() => "error" as const)]), 120_000);
    if (first === "error" && !spawnFailed) {
      // A runtime error on a started process: it still must settle.
      timedOut = (await withDeadline(settled, 60_000)) === "timeout";
    } else {
      timedOut = first === "timeout";
    }
  } finally {
    if (spawnFailed) {
      // No process was ever created (no pid), so no `exit` is expected — but
      // the ChildProcess still emits `close` once its stdio is torn down.
      // Await that positive close within a finite bound.
      if ((await withDeadline(closeSeen, 30_000)) === "timeout") {
        throw new Error("guard self-test PowerShell could not be started, and its stdio did not close");
      }
    } else if (!(exited && closed)) {
      child.kill();
      if ((await withDeadline(settled, 30_000)) === "timeout") {
        throw new Error(`guard self-test process did not settle (exit=${exited} close=${closed}) after being stopped`);
      }
    }
  }
  if (spawnFailed) throw new Error("guard self-test PowerShell could not be started");
  const outcome = normalizeGuardOutcome(
    { exitCode, signal, stdout: stdout.text(), stdoutTruncated: stdout.truncated, stderrBytes },
    guardStageVocabulary(),
  );
  if (timedOut) throw new Error(`guard self-test timed out before settling: ${describeGuardOutcome(outcome)}`);
  return outcome;
}

/** Every native control must hold; there is no fallback or partial pass.
 *  Assertions see normalized values only, so no raw value can reach an
 *  assertion message or its actual/expected fields. */
function checkGuardControls(outcome: GuardSelfTestOutcome, edition: "Desktop" | "Core"): void {
  const summary = describeGuardOutcome(outcome);
  // Truncated output fails even when every required record is in the prefix.
  expect(outcome.stdoutTruncated, `stdout within the byte cap; ${summary}`).toBe(false);
  const editionWitness = outcome.witnesses.find(([k]) => k === "edition")?.[1];
  const major = Number(outcome.witnesses.find(([k]) => k === "major")?.[1]);
  expect(editionWitness, `edition witness; ${summary}`).toBe(edition);
  expect(edition === "Desktop" ? major === 5 : major >= 7, `edition major version; ${summary}`).toBe(true);
  expect(outcome.witnesses.some(([k]) => k === "failed-stage"), `no failed stage; ${summary}`).toBe(false);
  expect(outcome.exit, `self-test exit; ${summary}`).toBe("0");
  const controls = outcome.witnesses.filter(([k]) => k !== "edition" && k !== "major");
  expect(controls, `ordered native guard controls; ${summary}`).toEqual(GUARD_EXPECTED.map(([k, v]) => [k, v]));
}

async function expectGuardControls(executable: string, edition: "Desktop" | "Core"): Promise<void> {
  checkGuardControls(await runGuardSelfTest(executable), edition);
}

describe("ShellStart on native Windows: watchdog root identity guard (#705)", () => {
  it("assigns only a root whose creation identity matches through the same handle (Windows PowerShell 5.1)", SKIP, async () => {
    await withWindowsPowerShell51((powershellExe) => expectGuardControls(powershellExe, "Desktop"));
  });

  it("assigns only a root whose creation identity matches through the same handle (PowerShell 7)", SKIP, async (t) => {
    // Optional prerequisite, resolved by ONE lookup whose verified path is
    // the executable used: absence skips truthfully; a failed, timed-out, or
    // malformed lookup fails with a fixed message instead (its reason can
    // carry paths or raw error text, so it is not echoed). On the CI Windows
    // shell job PI_REVIEW_GATE_REQUIRE_PWSH=1 makes absence a failure (#405).
    const prereq = probePwshPrerequisite();
    if (prereq.kind === "error") {
      throw new Error("pwsh prerequisite lookup failed (stage pwsh-lookup): presence was neither verified nor ruled out");
    }
    if (!resolvePwshPrerequisite(prereq, (message) => t.skip(message)) || prereq.kind !== "present") return;
    await expectGuardControls(prereq.path, "Core");
  });
});

// Cross-platform controls for the native guard fixture's privacy and
// lifetime handling (no PowerShell needed; these run on every platform).
describe("watchdog root identity guard fixture: diagnostics privacy and lifetime (#705)", () => {
  const stages = guardStageVocabulary();
  const SECRETS = ["SECRET", "C:\\Users", "sk-", "123456", "TTTTTTTTTT", "1000000000000", "/tmp/"];

  function expectedRecords(): string[] {
    return ["PIW edition=Desktop", "PIW major=5", ...GUARD_EXPECTED.map(([k, v]) => `PIW ${k}=${v}`)];
  }

  function messageOf(fn: () => void): string {
    try {
      fn();
    } catch (err) {
      return String((err as Error).message);
    }
    throw new Error("expected the guard controls check to fail");
  }

  it("derives the stage vocabulary from the generated helper script", () => {
    for (const stage of ["setup", "stale-plus", "denied", "match", "raw-assign", "after", "release"]) {
      expect(stages.has(stage), stage).toBe(true);
    }
  });

  it("passes only the exact closed vocabulary and fails once stdout was truncated", () => {
    const raw = { exitCode: 0, signal: null, stdout: expectedRecords().join("\r\n"), stdoutTruncated: false, stderrBytes: 0 };
    expect(() => checkGuardControls(normalizeGuardOutcome(raw, stages), "Desktop")).not.toThrow();
    // Every required record is present in the kept prefix, yet truncation fails.
    expect(() => checkGuardControls(normalizeGuardOutcome({ ...raw, stdoutTruncated: true }, stages), "Desktop")).toThrow();
  });

  it("normalizes path-, token-bearing, oversized, and unknown values to 'other' without printing them", () => {
    const hostile = [
      "C:\\Users\\SECRET-USER\\AppData\\x",
      "True; sk-SECRETTOKEN",
      "true",
      "TRUE",
      "False/tmp/SECRET",
      "T".repeat(5_000),
      "1",
      "",
    ];
    const lines = [
      "PIW edition=Desktop\\SECRET",
      "PIW major=123456",
      "PIW failed-stage=SECRET-STAGE",
      "PIW secret-key=SECRET",
      "raw SECRET output line C:\\Users\\SECRET",
      ...GUARD_EXPECTED.map(([k], i) => `PIW ${k}=${hostile[i % hostile.length]}`),
    ];
    const outcome = normalizeGuardOutcome(
      { exitCode: 1e13, signal: "SIGSECRET/tmp/x", stdout: lines.join("\n"), stdoutTruncated: false, stderrBytes: 1e12 },
      stages,
    );
    // Every recognized value collapsed to 'other'; the unknown key is dropped.
    expect(outcome.witnesses.length, "only allowlisted names kept").toBe(GUARD_EXPECTED.length + 3);
    for (const [key, value] of outcome.witnesses) expect(value, key).toBe(GUARD_OTHER);
    expect(outcome.exit).toBe(GUARD_OTHER);
    expect(outcome.signal).toBe(GUARD_OTHER);
    expect(outcome.stderrBytes).toBe(`${GUARD_STDERR_REPORT_CAP}+`);
    const summary = describeGuardOutcome(outcome);
    for (const secret of SECRETS) expect(summary, `summary omits ${secret}`).not.toContain(secret);
    expect(summary.length < 2_000, "summary stays bounded").toBe(true);
    // Hostile values can never satisfy the expected controls, and the
    // failure message is equally free of them.
    const failure = messageOf(() => checkGuardControls(outcome, "Desktop"));
    for (const secret of SECRETS) expect(failure, `failure omits ${secret}`).not.toContain(secret);
  });

  it("reports only allowlisted signal names, never unknown well-formed ones", () => {
    const records = expectedRecords().join("\n");
    const unknown = normalizeGuardOutcome({ exitCode: null, signal: "SIGSECRET", stdout: records, stdoutTruncated: false, stderrBytes: 0 }, stages);
    expect(unknown.signal).toBe(GUARD_OTHER);
    expect(describeGuardOutcome(unknown)).not.toContain("SIGSECRET");
    const failure = messageOf(() => checkGuardControls(unknown, "Desktop"));
    expect(failure).not.toContain("SIGSECRET");
    const known = normalizeGuardOutcome({ exitCode: null, signal: "SIGTERM", stdout: "", stdoutTruncated: false, stderrBytes: 0 }, stages);
    expect(known.signal).toBe("SIGTERM");
  });

  it("keeps known stage names and reports unknown ones as 'other'", () => {
    const known = normalizeGuardOutcome({ exitCode: 3, signal: null, stdout: "PIW failed-stage=denied", stdoutTruncated: false, stderrBytes: 0 }, stages);
    expect(known.witnesses).toEqual([["failed-stage", "denied"]]);
    const unknown = normalizeGuardOutcome({ exitCode: 3, signal: null, stdout: "PIW failed-stage=den1ed", stdoutTruncated: false, stderrBytes: 0 }, stages);
    expect(unknown.witnesses).toEqual([["failed-stage", GUARD_OTHER]]);
  });

  it("caps stdout by bytes, not UTF-16 code units", () => {
    const sink = createBoundedByteSink(GUARD_STDOUT_CAP);
    sink.push(Buffer.alloc(GUARD_STDOUT_CAP, 0x41));
    expect(sink.truncated, "exactly the cap is not truncated").toBe(false);
    sink.push(Buffer.from([0x41]));
    expect(sink.truncated, "one byte past the cap truncates").toBe(true);
    expect(sink.bytes).toBe(GUARD_STDOUT_CAP);
    // Two-byte characters: well under the cap in code units, over it in bytes.
    const wide = createBoundedByteSink(GUARD_STDOUT_CAP);
    wide.push(Buffer.from("é".repeat(GUARD_STDOUT_CAP / 2 + 1), "utf8"));
    expect(wide.truncated, "multi-byte overflow truncates").toBe(true);
    expect(Buffer.byteLength(wide.text(), "utf8") <= GUARD_STDOUT_CAP, "kept prefix within the byte cap").toBe(true);
  });

  it("awaits close and fails with a fixed message when the helper cannot be started", async () => {
    const missing = join(tmpdir(), `pi-review-705-missing-${process.pid}-${Date.now()}`, "SECRET-pwsh.exe");
    let message = "";
    try {
      await runGuardSelfTest(missing);
    } catch (err) {
      message = String((err as Error).message);
    }
    expect(message).toBe("guard self-test PowerShell could not be started");
  });

  it("handles repeated runtime errors and still returns only after positive exit and close", async (t) => {
    // The helper's own spawn call is redirected to a REAL Node child that
    // exits at once (no PowerShell needed). Node emits 'spawn' before 'exit'
    // and 'close', so the two runtime errors (carrying hostile text) raised
    // synchronously in the spawn callback always precede settlement.
    const realSpawn = childProcess.spawn;
    let child: ChildProcess | undefined;
    let unhandled = false;
    let exitObserved = false;
    let closeObserved = false;
    t.mock.method(childProcess, "spawn", ((_file: string, _args: readonly string[], options: childProcess.SpawnOptions) => {
      const spawned = realSpawn(process.execPath, ["-e", "void 0"], options);
      child = spawned;
      spawned.once("exit", () => { exitObserved = true; });
      spawned.once("close", () => { closeObserved = true; });
      spawned.once("spawn", () => {
        for (const n of [1, 2]) {
          try {
            spawned.emit("error", new Error(`SECRET runtime error ${n} C:\\Users\\SECRET`));
          } catch {
            unhandled = true; // an 'error' with no listener throws from emit
          }
        }
      });
      return spawned;
    }) as unknown as typeof childProcess.spawn);

    const outcome = await runGuardSelfTest("SECRET-pwsh.exe");
    expect(child !== undefined, "the helper spawned through the redirected spawn").toBe(true);
    expect(unhandled, "every runtime error reached a listener").toBe(false);
    expect(exitObserved && closeObserved, "returned only after positive exit and close").toBe(true);
    expect(child!.listenerCount("error") > 0, "error listener retained after settlement").toBe(true);
    expect(outcome.exit).toBe("0");
    expect(outcome.signal).toBe("none");
    const summary = describeGuardOutcome(outcome);
    for (const secret of [...SECRETS, String(child!.pid)]) expect(summary, "summary stays closed").not.toContain(secret);
  });
});

describe("native Windows Job Object kill-on-close outcome (Refs #404)", () => {
  const fakeOwned = (stdout: string, exit: OwnedProcess["exit"] = null, closed = exit !== null): OwnedProcess => {
    const capture = boundedCapture();
    capture.push(stdout);
    const writes: string[] = [];
    const proc = { stdin: { write: (text: string) => { writes.push(text); return true; } }, writes } as unknown as ChildProcess;
    return { proc, stdout: capture, exit, closed, spawnFailed: false };
  };

  // Cross-platform controls for the experiment's own pieces: the diagnostic
  // line stays fixed-label/allowlisted, and the owner script carries only the
  // approved Win32 surface (no pid-targeted or job-terminate kill path).
  it("keeps the job-close diagnostic allowlisted and the owner fixture kill-free", () => {
    const hostile = fakeOwned("JOBCLOSE-OWNER-FAIL C:\\Users\\secret token=abc\r\nraw error text\n", {
      code: Number.NaN, signal: "not-a-signal" as NodeJS.Signals, afterClose: false,
    });
    const handshake: JobCloseHandshake = { phases: ["child-ready", "C:\\Users\\secret"], challenge: "f".repeat(32), settledAfterClose: false };
    const line = formatJobCloseDiagnostic(fakeOwned("noise\n", { code: 1, signal: null, afterClose: true }), hostile, handshake);
    expect(/^issue404 job-close:( [A-Za-z]+=[A-Za-z0-9,-]+)+$/.test(line), line).toBe(true);
    expect(line).toContain("phases=child-ready,other");
    expect(line).toContain("ownerFailStage=other");
    expect(line).toContain("ownerExitCode=other");
    expect(line).toContain("ownerSignal=other");
    expect(line).toContain("childExitCode=1");
    expect(/secret|token|raw|Users|ffff/.test(line), "no raw output or challenge").toBe(false);
    const known = formatJobCloseDiagnostic(undefined, fakeOwned("JOBCLOSE-OWNER-FAIL in-job\r\n"), { phases: [], challenge: null, settledAfterClose: false });
    expect(known).toContain("ownerFailStage=in-job");
    expect(known).toContain("phases=none");
    expect(known).toContain("childExited=false");

    const script = jobCloseOwnerScript(4242);
    for (const api of ["CreateJobObjectW", "SetInformationJobObject", "OpenProcess", "AssignProcessToJobObject", "IsProcessInJob", "CloseHandle", "0x2000"]) {
      expect(script, api).toContain(api);
    }
    expect(/TerminateJobObject|TerminateProcess|Stop-Process|taskkill|\.Kill\(/i.test(script), "no kill path").toBe(false);
    for (const stage of script.matchAll(/Fail '([a-z-]+)'/g)) {
      expect(JOB_CLOSE_OWNER_STAGES.has(stage[1]), `stage ${stage[1]} allowlisted`).toBe(true);
    }
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => jobCloseOwnerScript(bad), `pid ${bad}`).toThrow();
    }
  });

  // No assignment before post-open child proof, structurally and in the gate.
  it("forbids assignment until the original child answers a challenge sent after the owner opened its handle", () => {
    // Owner script order: open + retain handle -> OPENED -> wait for ASSIGN ->
    // assign -> IsProcessInJob -> only then release the process handle.
    const script = jobCloseOwnerScript(4242);
    const at = (needle: string): number => {
      const index = script.indexOf(needle);
      expect(index >= 0, `owner script contains ${needle}`).toBe(true);
      return index;
    };
    const order = [
      at("::OpenProcess("), at("JOBCLOSE-OWNER-OPENED"), at("-ne 'ASSIGN'"), at("::AssignProcessToJobObject("),
      at("::IsProcessInJob("), at("::CloseHandle($child)"), at("JOBCLOSE-OWNER-ASSIGNED"),
    ];
    expect(order.every((index, i) => i === 0 || index > order[i - 1]), "owner handshake order").toBe(true);
    expect(script.split("::AssignProcessToJobObject(").length - 1, "single assignment site").toBe(1);
    expect(script.split("::CloseHandle($child)").length - 1, "single process-handle release").toBe(1);

    const exited = { code: 1, signal: null, afterClose: false };
    const fresh = (): JobCloseHandshake => ({ phases: ["child-ready"], challenge: null, settledAfterClose: false });
    // Challenge refused before OPENED, and while either process is not live.
    const early = fresh();
    expect(sendChildChallenge(early, fakeOwned("JOBCLOSE-CHILD-READY\n"), fakeOwned("")), "no challenge before OPENED").toBe(false);
    expect(early.challenge, "no challenge recorded").toBe(null);
    expect(sendChildChallenge(fresh(), fakeOwned("", exited), fakeOwned("JOBCLOSE-OWNER-OPENED\n")), "dead child").toBe(false);
    expect(sendChildChallenge(fresh(), fakeOwned(""), fakeOwned("JOBCLOSE-OWNER-OPENED\n", exited)), "dead owner").toBe(false);

    // Proper order: OPENED, then one fresh challenge over the child's stdin.
    const h = fresh();
    const child = fakeOwned("JOBCLOSE-CHILD-READY\n");
    const owner = fakeOwned("JOBCLOSE-OWNER-OPENED\n");
    h.phases.push("owner-opened");
    expect(jobCloseAssignmentAllowed(h, child, owner), "no assignment before the challenge").toBe(false);
    expect(sendChildChallenge(h, child, owner), "challenge sent after OPENED").toBe(true);
    expect(sendChildChallenge(h, child, owner), "challenge is one-shot").toBe(false);
    expect(/^[0-9a-f]{32}$/.test(h.challenge ?? ""), "fresh hex challenge").toBe(true);
    expect((child.proc as unknown as { writes: string[] }).writes).toEqual([`JOBCLOSE-CHALLENGE ${h.challenge}\n`]);
    expect(jobCloseAssignmentAllowed(h, child, owner), "no assignment without the child's reply").toBe(false);
    child.stdout.push(`JOBCLOSE-CHILD-ALIVE ${"0".repeat(32)}\n`);
    expect(jobCloseAssignmentAllowed(h, child, owner), "a reply to another challenge does not count").toBe(false);
    child.stdout.push(`JOBCLOSE-CHILD-ALIVE ${h.challenge}\n`);
    expect(jobCloseAssignmentAllowed(h, child, owner), "assignment allowed after post-open proof").toBe(true);
    // ...but never once either process has exited or closed, never twice, and
    // never when the challenge was not ordered after OPENED.
    expect(jobCloseAssignmentAllowed(h, { ...child, exit: exited }, owner), "child exited").toBe(false);
    expect(jobCloseAssignmentAllowed(h, { ...child, closed: true }, owner), "child closed").toBe(false);
    expect(jobCloseAssignmentAllowed(h, child, { ...owner, exit: exited }), "owner exited").toBe(false);
    expect(jobCloseAssignmentAllowed({ ...h, phases: [...h.phases, "assign-sent"] }, child, owner), "one-shot assign").toBe(false);
    expect(jobCloseAssignmentAllowed({ ...h, phases: ["child-ready", "challenge-sent", "owner-opened"] }, child, owner), "challenge before OPENED").toBe(false);
  });

  // The kernel outcome itself. Assertions cover the handshake and that both
  // processes actually exit and close after the controlled closure; the
  // child's exit status is RECORDED (diagnostic), never assumed.
  it("records the child's actual exit status when the owner closes the only kill-on-close job handle", SKIP, async (t) => {
    const notifier = changeNotifier();
    const h: JobCloseHandshake = { phases: [], challenge: null, settledAfterClose: false };
    const closeSent = (): boolean => h.phases.includes("close-sent");
    let child: OwnedProcess | undefined;
    let owner: OwnedProcess | undefined;
    let bodyError: unknown;
    try {
      child = observeOwned(spawn(process.execPath, ["-e", JOB_CLOSE_CHILD_SOURCE], { windowsHide: true }), notifier, closeSent);
      const c = child;
      await notifier.wait(() => hasWitness(c, "JOBCLOSE-CHILD-READY") || !isLive(c), 30_000);
      if (hasWitness(c, "JOBCLOSE-CHILD-READY") && isLive(c)) {
        h.phases.push("child-ready");
        const script = jobCloseOwnerScript(c.proc.pid!);
        owner = observeOwned(
          spawn(resolveWindowsPowerShell(), [
            "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
          ], { windowsHide: true }),
          notifier, closeSent,
        );
        const o = owner;
        await notifier.wait(() => hasWitness(o, "JOBCLOSE-OWNER-OPENED") || !isLive(o) || !isLive(c), 90_000);
        if (hasWitness(o, "JOBCLOSE-OWNER-OPENED")) h.phases.push("owner-opened");
        if (sendChildChallenge(h, c, o)) {
          const reply = `JOBCLOSE-CHILD-ALIVE ${h.challenge}`;
          await notifier.wait(() => hasWitness(c, reply) || !isLive(c) || !isLive(o), 30_000);
          if (hasWitness(c, reply)) h.phases.push("child-alive");
        }
        if (jobCloseAssignmentAllowed(h, c, o)) {
          h.phases.push("assign-sent");
          o.proc.stdin!.write("ASSIGN\n");
          await notifier.wait(() => hasWitness(o, "JOBCLOSE-OWNER-ASSIGNED") || !isLive(o) || !isLive(c), 30_000);
          if (hasWitness(o, "JOBCLOSE-OWNER-ASSIGNED")) h.phases.push("owner-assigned");
          if (hasWitness(o, "JOBCLOSE-OWNER-ASSIGNED") && isLive(o) && isLive(c)) {
            h.phases.push("close-sent");
            o.proc.stdin!.write("CLOSE\n");
            h.settledAfterClose = await notifier.wait(() => ownedSettled(c) && ownedSettled(o), 30_000);
          }
        }
      }
      t.diagnostic(formatJobCloseDiagnostic(child, owner, h));
      expect(h.phases, "assignment only after post-open child proof, then controlled closure").toEqual(JOB_CLOSE_PHASES);
      expect(child.exit !== null && !child.exit.afterClose, "no child exit before the controlled job closure").toBe(false);
      expect(h.settledAfterClose, "child and owner exit + close observed after closure (a timeout is not settlement)").toBe(true);
      expect(hasWitness(owner, "JOBCLOSE-OWNER-CLOSED"), "owner closed its only job handle").toBe(true);
      expect(owner!.exit?.code === 0 && owner!.exit.signal === null, "owner exited normally").toBe(true);
      expect(child.exit?.afterClose === true && typeof child.exit.code === "number", "child exit status recorded").toBe(true);
    } catch (err) {
      bodyError = err;
    }
    const owned: Array<[string, OwnedProcess]> = [];
    if (owner) owned.push(["owner", owner]);
    if (child) owned.push(["child", child]);
    const unconfirmed = await settleOwnedProcesses(owned, notifier, 30_000);
    if (unconfirmed.length > 0) {
      const message = `issue404 job-close cleanup unconfirmed: ${unconfirmed.join(",")} bodyFailed=${bodyError !== undefined}`;
      t.diagnostic(message);
      throw new Error(message, { cause: bodyError });
    }
    if (bodyError !== undefined) throw bodyError;
  });
});


function expectNoError(result: any): void {
  if (result.isError) throw new Error(`ShellStart unexpectedly failed: ${textOf(result)}`);
}

// ---------------------------------------------------------------------------
// Store (MSIX) PowerShell 7 route (#800) — NATIVE evidence.
//
// Distinct from the injected-fixture selection tests in
// background-shell-jobs.test.ts: every case below launches the ACTUAL installed
// Microsoft.PowerShell Store package — through its App Execution Alias and
// through the direct WindowsApps package image — and observes real processes
// and a real job object. A host without the package skips with a truthful
// reason; a failed package lookup fails with diagnostics instead.
//
// Fixture hygiene: every process a fixture creates has a bounded lifetime
// (Start-Sleep / PING -n with fixed counts), the job's own stop path or the
// parent-death watchdog ends it, and the only process this suite ever
// terminates directly is its own observer — through the exact ChildProcess
// handle it spawned. Identity is checked through exact handles verified by
// creation time, never by pid or image name alone.

interface StorePowerShell {
  packageFullName: string;
  /** The package image under %ProgramFiles%\WindowsApps. */
  direct: string;
  /** %LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe, when present. */
  alias: string | null;
}

let storeLookup: { found: StorePowerShell } | { absent: string } | undefined;

function systemWindowsPowerShell(): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** Look up the installed Store PowerShell 7 package. Absence is a verified
 *  result; a failed lookup throws rather than masquerading as absence. */
function lookupStorePowerShell(): { found: StorePowerShell } | { absent: string } {
  if (storeLookup) return storeLookup;
  const probe = spawnSync(
    systemWindowsPowerShell(),
    [
      "-NoProfile", "-NonInteractive", "-Command",
      "$p = Get-AppxPackage -Name Microsoft.PowerShell -ErrorAction Stop | Sort-Object Version -Descending | Select-Object -First 1; " +
        "if ($p) { Write-Output $p.PackageFullName; Write-Output $p.InstallLocation }",
    ],
    { encoding: "utf-8", timeout: 60_000, windowsHide: true },
  );
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `Store PowerShell lookup failed (status ${probe.status}): ${probe.error?.message ?? (probe.stderr ?? "").trim()}`,
    );
  }
  const [packageFullName, location] = (probe.stdout ?? "").trim().split(/\r?\n/).map((line) => line.trim());
  if (!packageFullName) {
    storeLookup = { absent: "the Store PowerShell 7 package (Microsoft.PowerShell) is not installed on this host" };
    return storeLookup;
  }
  const direct = join(location ?? "", "pwsh.exe");
  if (!location || !windowsPathAccessible(direct)) {
    throw new Error(`Store PowerShell package ${packageFullName} reports no pwsh.exe at ${direct}`);
  }
  const aliasPath = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe") : null;
  storeLookup = { found: { packageFullName, direct, alias: aliasPath && windowsPathAccessible(aliasPath) ? aliasPath : null } };
  return storeLookup;
}

/** accessSync(F_OK), as production discovery uses: existsSync's extra stat
 *  rejects runnable App Execution Aliases and WindowsApps package images. */
function windowsPathAccessible(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

type StoreForm = "alias" | "direct";

/** The executable for one Store form, or null after a truthful skip. */
function storeExecutable(t: { skip: (message: string) => void }, form: StoreForm): { exe: string; store: StorePowerShell } | null {
  const lookup = lookupStorePowerShell();
  if ("absent" in lookup) {
    t.skip(lookup.absent);
    return null;
  }
  const exe = form === "alias" ? lookup.found.alias : lookup.found.direct;
  if (!exe) {
    t.skip("the Store PowerShell App Execution Alias (%LOCALAPPDATA%\\Microsoft\\WindowsApps\\pwsh.exe) is not present");
    return null;
  }
  // Both forms are recognised as the package route by production detection.
  expect(isWindowsAppsPackagePath(exe), `${form} is a WindowsApps path`).toBe(true);
  return { exe, store: lookup.found };
}

/** In-job probe compiled by each fixture process: the calling process's package
 *  identity, its IMMEDIATE job's limit flags, and that job's member pid list
 *  (QueryInformationJobObject with a null handle queries the caller's job).
 *  One line of C# with no apostrophes, inside a single-quoted PowerShell string. */
const JOB_PROBE_CLASS =
  "using System; using System.Text; using System.Runtime.InteropServices; public static class PiReviewTestJobProbe { " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, byte[] info, int length, IntPtr returned); " +
  "[DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode)] static extern int GetCurrentPackageFullName(ref uint length, StringBuilder name); " +
  "public static string Package() { uint n = 0; if (GetCurrentPackageFullName(ref n, null) != 122 || n == 0 || n > 4096) { return \"none\"; } StringBuilder s = new StringBuilder((int)n); return GetCurrentPackageFullName(ref n, s) == 0 ? s.ToString() : \"none\"; } " +
  "public static string Flags() { byte[] b = new byte[IntPtr.Size == 8 ? 144 : 112]; return QueryInformationJobObject(IntPtr.Zero, 9, b, b.Length, IntPtr.Zero) ? BitConverter.ToUInt32(b, 16).ToString(\"x\") : \"none\"; } " +
  "public static string Pids() { int size = IntPtr.Size; byte[] b = new byte[8 + size * 512]; if (!QueryInformationJobObject(IntPtr.Zero, 3, b, b.Length, IntPtr.Zero)) { return \"none\"; } int count = BitConverter.ToInt32(b, 4); StringBuilder s = new StringBuilder(); for (int i = 0; i < count; i++) { long pid = size == 8 ? BitConverter.ToInt64(b, 8 + 8 * i) : BitConverter.ToInt32(b, 8 + 4 * i); s.Append(i == 0 ? \"\" : \",\").Append(pid); } return s.Length > 0 ? s.ToString() : \"none\"; } }";

/** PowerShell that prints `<TAG>=<pid> <creation ticks> <flags> <package> <pids>`. */
function jobProbeReport(tag: string): string {
  return (
    `Add-Type -TypeDefinition '${JOB_PROBE_CLASS}'; ` +
    `[Console]::WriteLine('${tag}=' + $PID + ' ' + (Get-Process -Id $PID).StartTime.Ticks + ' ' + [PiReviewTestJobProbe]::Flags() + ' ' + [PiReviewTestJobProbe]::Package() + ' ' + [PiReviewTestJobProbe]::Pids())`
  );
}

interface ProbeReport { pid: number; ticks: string; flags: number | null; packageFullName: string; pids: number[] }

function parseProbeReport(text: string, tag: string): ProbeReport | null {
  const m = new RegExp(`^${tag}=(\\d+) ([0-9]{1,20}) ([0-9a-f]+|none) (\\S+) ([0-9,]+|none)\\r?$`, "m").exec(text);
  if (!m) return null;
  return {
    pid: Number(m[1]),
    ticks: m[2],
    flags: m[3] === "none" ? null : parseInt(m[3], 16),
    packageFullName: m[4],
    pids: m[5] === "none" ? [] : m[5].split(",").map(Number),
  };
}

/** A bounded process start that inherits the caller's std handles. */
function psStartInherited(file: string, args: string, redirectOutput = false): string {
  return (
    `[Diagnostics.Process]::Start((New-Object Diagnostics.ProcessStartInfo -Property @{ FileName = ${file}; ` +
    `Arguments = '${args}'; UseShellExecute = $false; CreateNoWindow = $true` +
    (redirectOutput ? "; RedirectStandardOutput = $true" : "") +
    ` }))`
  );
}

const PING = "(Join-Path ([Environment]::SystemDirectory) 'PING.EXE')";

/** The child fixture: a PowerShell started from the package image ($PSHOME),
 *  which starts a PING grandchild (output redirected so its lines stay out of
 *  the job log), then reports both identities and its job membership. Bounded:
 *  PING -n 90, Start-Sleep 90. */
function childFixtureCommand(): string {
  const child =
    `$g = ${psStartInherited(PING, "-n 90 127.0.0.1", true)}; ` +
    `[Console]::WriteLine('GRAND=' + $g.Id + ' ' + $g.StartTime.Ticks); ` +
    `${jobProbeReport("CHILD")}; Start-Sleep -Seconds 90`;
  const encoded = Buffer.from(child, "utf16le").toString("base64");
  return `$c = ${psStartInherited("(Join-Path $PSHOME 'pwsh.exe')", `-NoProfile -NonInteractive -EncodedCommand ${encoded}`)}; ` +
    "[Console]::WriteLine('CHILDSTART=' + $c.Id)";
}

/** Test-only exact-handle observer: opens each target ONCE with SYNCHRONIZE |
 *  QUERY_LIMITED_INFORMATION, accepts the handle only when its creation time
 *  equals the identity the fixture reported, and later waits on those same
 *  handles. A held handle keeps the pid from being reused, so "exited" is the
 *  exact process exiting. It terminates nothing. */
const OBSERVER_CLASS =
  "using System; using System.Runtime.InteropServices; public static class PiReviewTestObserver { " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid); " +
  "[DllImport(\"kernel32.dll\")] public static extern uint WaitForSingleObject(IntPtr handle, uint ms); " +
  "[DllImport(\"kernel32.dll\", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user); }";

interface ObservedTarget { label: string; pid: number; ticks: string }

const ownedObservers = new Set<ChildProcess>();

/** `rounds` bounded waits run on the SAME opened handles, one per
 *  waitForExit call. Each reports `exited` (WAIT_OBJECT_0), `alive`
 *  (WAIT_TIMEOUT), or `failed` (WAIT_FAILED or anything else — never read as
 *  alive). */
async function openExactHandleObserver(targets: ObservedTarget[], rounds = 1): Promise<{
  opened: Record<string, string>;
  waitForExit: (ms: number) => Promise<Record<string, string>>;
}> {
  const script =
    `Add-Type -TypeDefinition '${OBSERVER_CLASS}'; $h = @{}; ` +
    targets.map(({ label, pid, ticks }) =>
      `$x = [PiReviewTestObserver]::OpenProcess(0x00101000, $false, ${pid}); $s = 'missing'; ` +
      `if ($x -ne [IntPtr]::Zero) { [long]$created = 0; [long]$exited = 0; [long]$kernel = 0; [long]$user = 0; ` +
      `if ([PiReviewTestObserver]::GetProcessTimes($x, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user) -and [DateTime]::FromFileTime($created).Ticks -eq ${ticks}) { $s = 'ok'; $h['${label}'] = $x } else { $s = 'mismatch' } }; ` +
      `[Console]::WriteLine('OPEN ${label} ' + $s); `,
    ).join("") +
    `[Console]::WriteLine('OPENED'); for ($round = 1; $round -le ${rounds}; $round++) { ` +
    `$ms = [Console]::In.ReadLine(); if ($null -eq $ms) { exit 0 }; ` +
    `$end = [DateTime]::UtcNow.AddMilliseconds([int]$ms); ` +
    `foreach ($name in @($h.Keys)) { $left = [uint32][Math]::Max(0, [int]($end - [DateTime]::UtcNow).TotalMilliseconds); ` +
    `$w = [PiReviewTestObserver]::WaitForSingleObject($h[$name], $left); $r = 'failed'; if ($w -eq 0) { $r = 'exited' } elseif ($w -eq 258) { $r = 'alive' }; ` +
    `[Console]::WriteLine('WAIT' + $round + ' ' + $name + ' ' + $r) }; ` +
    `[Console]::WriteLine('WAITED' + $round) }; exit 0`;
  const observer = spawn(systemWindowsPowerShell(), ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  ownedObservers.add(observer);
  let out = "";
  observer.stdout!.on("data", (d) => { out += String(d); });
  observer.stderr!.on("data", () => {});
  observer.on("exit", () => ownedObservers.delete(observer));
  const lines = (prefix: string): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const m of out.matchAll(new RegExp(`^${prefix} (\\S+) (\\S+)\\r?$`, "gm"))) result[m[1]] = m[2];
    return result;
  };
  expect(await until(() => /^OPENED\r?$/m.test(out), 60_000), `observer opened its handles; output:\n${out}`).toBe(true);
  let round = 0;
  return {
    opened: lines("OPEN"),
    waitForExit: async (ms: number) => {
      round += 1;
      expect(round <= rounds, `observer wait round ${round} of ${rounds}`).toBe(true);
      const current = round;
      observer.stdin!.write(`${ms}\n`);
      expect(await until(() => new RegExp(`^WAITED${current}\\r?$`, "m").test(out), ms + 20_000), `observer finished waiting; output:\n${out}`).toBe(true);
      return lines(`WAIT${current}`);
    },
  };
}

interface StoreRun {
  proc: ChildProcess;
  markerPath: string;
  stopPath: string;
  out: () => string;
  err: () => string;
  exit: { code: number | null; at: number } | null;
  closed: { code: number | null; at: number } | null;
}

const storeRuns: StoreRun[] = [];

/** Start one job on the Store route through the production spawn, with a
 *  1-second watchdog poll so stop and release are observed quickly. */
function startStoreJob(command: string, executable: string): StoreRun {
  const { proc, ownership, shellSelection } = spawnBackgroundJob(command, process.pid, 1, { executable, route: "msix" });
  expect(shellSelection?.route, "the explicit Store selection is the one used").toBe("msix");
  expect(ownership !== undefined, "Store jobs carry ownership").toBe(true);
  let out = "";
  let err = "";
  const run: StoreRun = {
    proc,
    markerPath: ownership!.markerPath,
    stopPath: ownership!.stopPath,
    out: () => out,
    err: () => err,
    exit: null,
    closed: null,
  };
  proc.stdout!.on("data", (d) => { if (out.length < 262_144) out += String(d); });
  proc.stderr!.on("data", (d) => { if (err.length < 65_536) err += String(d); });
  proc.on("exit", (code) => { run.exit = { code, at: Date.now() }; });
  proc.on("close", (code) => { run.closed = { code, at: Date.now() }; });
  storeRuns.push(run);
  return run;
}

function readRecord(markerPath: string): string {
  try {
    return readFileSync(markerPath, "utf8").trim();
  } catch (err) {
    return `<${(err as NodeJS.ErrnoException).code}>`;
  }
}

/** Remove only the exact files this suite's runs own. */
/**
 * Finish one test-owned Store job before removing its exact files. Settled
 * means BOTH the host side is done (`hostSettled`) AND the watchdog or
 * launcher wrote a valid terminal Store record — a stop request or a pipe
 * close alone is not proof that the watchdog stopped writing. An unsettled
 * job is ended through its own stop path (never a pid kill); a bounded
 * teardown that still cannot verify settlement fails the test instead of
 * silently dropping the fixture.
 */
async function finishStoreFixture(markerPath: string, stopPath: string, hostSettled: () => boolean): Promise<void> {
  const settled = () => hostSettled() && ownershipAcknowledgement(markerPath, "msix") !== undefined;
  if (!settled()) writeFileSync(stopPath, "stop\n");
  expect(await until(settled, 30_000), `Store fixture settled before teardown: ${markerPath} (${readRecord(markerPath)})`).toBe(true);
  for (const path of [markerPath, stopPath]) await rmWithRetry(path);
}

async function settleStoreFixtures(): Promise<void> {
  for (const run of storeRuns.splice(0)) {
    await finishStoreFixture(run.markerPath, run.stopPath, () => run.closed !== null);
  }
  for (const [id, markerPath] of [...storeToolRuns]) {
    storeToolRuns.delete(id);
    await finishStoreFixture(markerPath, markerPath.replace(/\.job$/, ".stop"), () => !backgroundShellTest.ownershipHeldForTests(id));
  }
  for (const observer of [...ownedObservers]) {
    observer.kill(); // the test's own observer, through its exact handle
    await until(() => !ownedObservers.has(observer), 10_000);
  }
}

/** A PATH that resolves ONLY the Store PowerShell 7 (every directory with an
 *  ordinary pwsh.exe removed, the alias directory kept or added) and a
 *  redirected ProgramFiles, so production selection itself takes the Store
 *  route. The precondition is proven with the production selector. */
async function withStorePowerShellOnly(alias: string, fn: () => Promise<void>): Promise<void> {
  const original = process.env.PATH ?? "";
  const originalProgramFiles = process.env.ProgramFiles;
  const drop = new Set([...pwshResolvingDirs(original)].filter((dir) => !isWindowsAppsPackagePath(join(dir, "pwsh.exe"))));
  const kept = original.split(";").filter((entry) => entry.trim() && !drop.has(normalizePathEntry(entry)));
  const aliasDir = dirname(alias);
  if (!kept.some((entry) => normalizePathEntry(entry) === normalizePathEntry(aliasDir))) kept.push(aliasDir);
  process.env.PATH = kept.join(";");
  process.env.ProgramFiles = nonexistentInstallDir("pi-review-no-pwsh7");
  try {
    const selection = selectWindowsPowerShellForJobs();
    if (selection.route !== "msix") {
      throw new Error(
        `Store-only fixture failed: selection is ${selection.route} (${selection.executable}) after removing ${[...drop].join(", ")}`,
      );
    }
    await fn();
  } finally {
    process.env.PATH = original;
    if (originalProgramFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = originalProgramFiles;
  }
}

const KILL_ON_JOB_CLOSE = 0x2000;
const ANY_BREAKAWAY = 0x800 | 0x1000;

describe("Store (MSIX) PowerShell 7 route: native launch, membership, and stop (#800)", () => {
  afterEach(settleStoreFixtures);

  for (const form of ["alias", "direct"] as const) {
    it(`[${form}] policy launch: root, child, and grandchild join one kill-on-close job; stop ends each exact process`, SKIP, async (t) => {
      const target = storeExecutable(t, form);
      if (!target) return;
      const run = startStoreJob(`${jobProbeReport("ROOT")}; ${childFixtureCommand()}; Start-Sleep -Seconds 90`, target.exe);
      expect(await until(() => /^CHILD=/m.test(run.out()), 60_000), `fixture reports; stdout:\n${run.out()}\nstderr:\n${run.err()}`).toBe(true);
      const root = parseProbeReport(run.out(), "ROOT")!;
      const child = parseProbeReport(run.out(), "CHILD")!;
      const grand = /^GRAND=(\d+) ([0-9]{1,20})\r?$/m.exec(run.out())!;
      expect(Boolean(root && child && grand), `parseable reports:\n${run.out()}`).toBe(true);
      const grandPid = Number(grand[1]);

      // The workload root is the actual Store package (alias and direct image
      // alike) and sits in a kill-on-close job that allows no breakaway.
      expect(root.packageFullName, "root package identity").toBe(target.store.packageFullName);
      expect(root.flags !== null && (root.flags & (KILL_ON_JOB_CLOSE | ANY_BREAKAWAY)) === KILL_ON_JOB_CLOSE, `root job flags ${root.flags}`).toBe(true);
      expect(root.pids, "root is a member of its immediate job").toContain(root.pid);
      // Inherited membership: the child's immediate job is the same
      // kill-on-close job and lists root, child, and grandchild.
      expect(child.flags !== null && (child.flags & (KILL_ON_JOB_CLOSE | ANY_BREAKAWAY)) === KILL_ON_JOB_CLOSE, `child job flags ${child.flags}`).toBe(true);
      for (const [label, pid] of [["root", root.pid], ["child", child.pid], ["grandchild", grandPid]] as const) {
        expect(child.pids, `${label} is in the job`).toContain(pid);
      }
      // The Node-facing launcher and the per-job watchdog stay OUTSIDE the job.
      const record = readRecord(run.markerPath);
      const watchdogPid = Number(/^(\d+) running msix$/.exec(record)?.[1]);
      expect(Number.isInteger(watchdogPid) && watchdogPid > 0, `running msix record: ${record}`).toBe(true);
      expect(child.pids.includes(run.proc.pid!) || child.pids.includes(watchdogPid), "launcher/watchdog not in the job").toBe(false);
      expect(run.exit, "the launcher mirrors a live root").toBeNull();

      const observer = await openExactHandleObserver([
        { label: "root", pid: root.pid, ticks: root.ticks },
        { label: "child", pid: child.pid, ticks: child.ticks },
        { label: "grandchild", pid: grandPid, ticks: grand[2] },
      ]);
      expect(observer.opened, "exact handles with matching creation times").toEqual({ root: "ok", child: "ok", grandchild: "ok" });

      writeFileSync(run.stopPath, "stop\n");
      // The fixtures live ~90 s; exiting inside this bound is the stop's doing.
      expect(await observer.waitForExit(20_000), "each exact process exited after stop").toEqual({
        root: "exited", child: "exited", grandchild: "exited",
      });
      expect(await until(() => readRecord(run.markerPath) === `${watchdogPid} terminated msix`, 20_000), `terminated msix: ${readRecord(run.markerPath)}`).toBe(true);
      expect(await until(() => run.closed !== null, 20_000), "the job's pipes close once the job is empty").toBe(true);
      // TerminateJobObject(job, 1): the Node-facing process reports the root's status.
      expect(run.exit?.code, "launcher exit mirrors the terminated root").toBe(1);
    });
  }

  it("[alias] root exits before stop: descendants keep the job owned until stop ends them", SKIP, async (t) => {
    const target = storeExecutable(t, "alias");
    if (!target) return;
    const run = startStoreJob(`${childFixtureCommand()}; exit 5`, target.exe);
    expect(await until(() => /^CHILD=/m.test(run.out()), 60_000), `child reports; stdout:\n${run.out()}\nstderr:\n${run.err()}`).toBe(true);
    const child = parseProbeReport(run.out(), "CHILD")!;
    const grand = /^GRAND=(\d+) ([0-9]{1,20})\r?$/m.exec(run.out())!;
    expect(child.packageFullName, "child inherits the package identity").toBe(target.store.packageFullName);
    expect(child.pids).toContain(child.pid);
    expect(child.pids).toContain(Number(grand[1]));

    // The Node-facing process exits with the ROOT's own status...
    expect(await until(() => run.exit !== null, 30_000), "root exit is mirrored").toBe(true);
    expect(run.exit!.code, "root status").toBe(5);
    // ...while the job is still populated: ownership stays `running`, and the
    // pipes the descendants inherited stay open (no premature settlement).
    await new Promise((r) => setTimeout(r, 2_500));
    const heldRecord = readRecord(run.markerPath);
    expect(/^\d+ running msix$/.test(heldRecord), `record stays running while members remain: ${heldRecord}`).toBe(true);
    expect(run.closed, "no close while job members hold the pipe").toBeNull();

    const observer = await openExactHandleObserver([
      { label: "child", pid: child.pid, ticks: child.ticks },
      { label: "grandchild", pid: Number(grand[1]), ticks: grand[2] },
    ]);
    expect(observer.opened).toEqual({ child: "ok", grandchild: "ok" });
    writeFileSync(run.stopPath, "stop\n");
    expect(await observer.waitForExit(20_000)).toEqual({ child: "exited", grandchild: "exited" });
    expect(await until(() => /^\d+ terminated msix$/.test(readRecord(run.markerPath)), 20_000), readRecord(run.markerPath)).toBe(true);
    expect(await until(() => run.closed !== null, 20_000), "close after the verified stop").toBe(true);
  });

  it("[direct] stdin, stdout, stderr, and the exit status; a natural end is recorded as released", SKIP, async (t) => {
    const target = storeExecutable(t, "direct");
    if (!target) return;
    const run = startStoreJob(
      "Write-Output 'store-out'; [Console]::Error.WriteLine('store-err'); $x = [Console]::In.ReadLine(); Write-Output \"got:$x\"; exit 7",
      target.exe,
    );
    expect(await until(() => run.out().includes("store-out"), 60_000), `stdout before stdin; stderr:\n${run.err()}`).toBe(true);
    run.proc.stdin!.write("hello\n");
    expect(await until(() => run.closed !== null, 30_000), "close").toBe(true);
    expect(run.out()).toContain("got:hello");
    expect(run.err()).toContain("store-err");
    expect(run.exit?.code, "exit status").toBe(7);
    expect(run.closed?.code).toBe(7);
    expect(await until(() => /^\d+ released msix$/.test(readRecord(run.markerPath)), 15_000), readRecord(run.markerPath)).toBe(true);
  });
});

interface LauncherFixtureOutcome {
  code: number | null;
  stderr: string;
  /** The record shortly after the launcher exited. */
  record: string;
  /** The record again after `stableMs` more: several watchdog polls later. */
  recordLater: string;
  acknowledgement: string | undefined;
  canaryRan: boolean;
  /** Temporary record files left in the fixture directory. */
  partFiles: string[];
  ms: number;
}

/** Run the MSIX launcher text directly (no production spawn), so a startup
 *  failure can be staged before it starts (`stage`) or while it runs
 *  (`afterSpawn`, which returns its own teardown). The workload would write a
 *  canary; its absence proves nothing ran. */
async function runStoreLauncherFixture(
  executable: string,
  stage: (paths: { dir: string; markerPath: string; stopPath: string }) => void,
  options: {
    withWorkload?: boolean;
    afterSpawn?: (paths: { markerPath: string; stopPath: string }) => () => void;
    stableMs?: number;
  } = {},
): Promise<LauncherFixtureOutcome> {
  const withWorkload = options.withWorkload ?? true;
  const dir = mkdtempSync(join(tmpdir(), "pi-review-msix-start-"));
  let outcome: Awaited<ReturnType<typeof runStoreLauncherFixture>> | undefined;
  await runWithTempCleanup([dir], { recursive: true }, async () => {
    const markerPath = join(dir, "record.job");
    const stopPath = join(dir, "record.stop");
    const canary = join(dir, "canary.txt");
    stage({ dir, markerPath, stopPath });
    const workloadVariable = msixWorkloadVariableName(randomBytes(8).toString("hex"));
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (withWorkload) env[workloadVariable] = msixWorkloadScript(`Set-Content -LiteralPath '${canary}' -Value ran; exit 0`);
    const started = Date.now();
    const proc = spawn(
      executable,
      [...POWERSHELL_ARGS, wrapWithMsixPowerShellLauncher(process.pid, 1, { markerPath, stopPath, workloadVariable }, 10_000)],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env },
    );
    let stderr = "";
    let closed: number | null | undefined;
    proc.stdout!.on("data", () => {});
    proc.stderr!.on("data", (d) => { stderr += String(d); });
    proc.on("close", (code) => { closed = code; });
    const stopDuring = options.afterSpawn?.({ markerPath, stopPath });
    const finished = await until(() => closed !== undefined, 60_000);
    stopDuring?.();
    if (!finished) proc.kill(); // this fixture's own launcher, by exact handle
    expect(finished, `the launcher ends within its bound; stderr:\n${stderr}`).toBe(true);
    const ms = Date.now() - started;
    await new Promise((r) => setTimeout(r, 1_500)); // a resumed workload would have written by now
    const record = readRecord(markerPath);
    // A watchdog that survived the abort would rewrite the record on its next
    // poll (1 s here); several polls later the record must be unchanged.
    await new Promise((r) => setTimeout(r, options.stableMs ?? 0));
    outcome = {
      code: closed ?? null,
      stderr,
      record,
      recordLater: readRecord(markerPath),
      acknowledgement: ownershipAcknowledgement(markerPath),
      canaryRan: existsSync(canary),
      partFiles: readdirSync(dir).filter((name) => name.endsWith(".part")),
      ms,
    };
  });
  return outcome!;
}

describe("Store (MSIX) PowerShell 7 route: fail-closed startup (#800)", () => {
  it("a stop pending before launch aborts with 'stop-during-startup', records failed, runs nothing", SKIP, async (t) => {
    const target = storeExecutable(t, "alias");
    if (!target) return;
    const r = await runStoreLauncherFixture(target.exe, ({ stopPath }) => writeFileSync(stopPath, "stop\n"));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stage 'stop-during-startup'");
    expect(r.stderr).toContain("not retried on another shell");
    expect(r.record, "nothing can still run").toBe("0 failed");
    expect(r.canaryRan, "the command never ran").toBe(false);
  });

  it("an unreadable record after the suspended launch aborts and leaves the evidence unverifiable", SKIP, async (t) => {
    const target = storeExecutable(t, "direct");
    if (!target) return;
    // A directory at the record path: the watchdog cannot write it and the
    // launcher cannot read it, so the suspended workload is terminated through
    // its exact handle and never resumed.
    const r = await runStoreLauncherFixture(target.exe, ({ markerPath }) => mkdirSync(markerPath));
    expect(r.code).toBe(1);
    expect(/stage '(record-unreadable|record-mismatch|ownership-handshake)'/.test(r.stderr), r.stderr).toBe(true);
    expect(r.canaryRan, "the suspended workload never resumed").toBe(false);
    // No acknowledgement of any kind: missing evidence stays unverifiable.
    expect(r.acknowledgement, "no terminal acknowledgement").toBeUndefined();
    expect(r.record.startsWith("<"), `no record could be read: ${r.record}`).toBe(true);
  });

  it("a failure after the watchdog started ends that watchdog first: '0 failed' stays the record, nothing ran", SKIP, async (t) => {
    const target = storeExecutable(t, "direct");
    if (!target) return;
    // Deterministic staging: a record that is NOT this watchdog's exists before
    // launch, so the launcher's handshake sees it at once, after the watchdog
    // was started but before that watchdog could write — 'record-mismatch'.
    // Without mutual exclusion the still-live watchdog would later overwrite
    // '0 failed' with its own 'running msix' / 'released msix'.
    const r = await runStoreLauncherFixture(
      target.exe,
      ({ markerPath }) => writeFileSync(markerPath, "2147483000 running msix\n"),
      { stableMs: 4_000 },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stage 'record-mismatch'");
    expect(r.record, "the launcher's failure record").toBe("0 failed");
    expect(r.recordLater, "unchanged several watchdog polls later").toBe("0 failed");
    expect(r.canaryRan, "the suspended workload never resumed").toBe(false);
    expect(r.partFiles, "no temporary record left behind").toEqual([]);
  });

  it("a stop requested after the watchdog started but before resume runs nothing and keeps '0 failed'", SKIP, async (t) => {
    const target = storeExecutable(t, "direct");
    if (!target) return;
    // The stop is written the moment the watchdog's own record appears — after
    // the launcher's first stop check and before its pre-resume check. The
    // launcher polls for that record every 250 ms, so the stop normally wins;
    // when the launcher resumes first, this case is reported as not exercised.
    const r = await runStoreLauncherFixture(target.exe, () => {}, {
      stableMs: 4_000,
      afterSpawn: ({ markerPath, stopPath }) => {
        const timer = setInterval(() => {
          if (/^\d+ running msix$/.test(readRecord(markerPath))) {
            writeFileSync(stopPath, "stop\n");
            clearInterval(timer);
          }
        }, 5);
        return () => clearInterval(timer);
      },
    });
    if (!r.stderr.includes("stage 'stop-during-startup'")) {
      t.skip(`the launcher resumed before the stop landed (stderr: ${JSON.stringify(r.stderr.trim().slice(0, 200))}); stop-before-resume not exercised`);
      return;
    }
    expect(r.code).toBe(1);
    expect(r.record).toBe("0 failed");
    expect(r.recordLater, "the stopped watchdog never overwrote the failure").toBe("0 failed");
    expect(r.canaryRan, "nothing ran").toBe(false);
    expect(r.partFiles).toEqual([]);
  });

  it("missing workload text aborts at 'workload-text' before any job exists", SKIP, async (t) => {
    const target = storeExecutable(t, "alias");
    if (!target) return;
    const r = await runStoreLauncherFixture(target.exe, () => {}, { withWorkload: false });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stage 'workload-text'");
    expect(r.record).toBe("0 failed");
    expect(r.canaryRan).toBe(false);
  });

  it("an ordinary PowerShell 7 never receives the Store workaround: it stops at 'package-identity'", SKIP, async (t) => {
    if (!storeExecutable(t, "direct")) return;
    const selection = selectWindowsPowerShellForJobs();
    if (selection.route !== "ordinary" || basename(selection.executable).toLowerCase() !== "pwsh.exe") {
      t.skip("no ordinary (unpackaged) PowerShell 7 is installed on this host");
      return;
    }
    const r = await runStoreLauncherFixture(selection.executable, () => {});
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stage 'package-identity'");
    expect(r.canaryRan).toBe(false);
  });
});

describe("Store (MSIX) PowerShell 7 route through ShellStart (#800)", () => {
  afterEach(settleStoreFixtures);

  it("selects the Store route, says so, and delivers stdin, stdout, stderr, and the exit status", SKIP, async (t) => {
    const target = storeExecutable(t, "alias");
    if (!target) return;
    await withStorePowerShellOnly(target.exe, async () => {
      const { sent, call } = wire(true);
      const result = await call("ShellStart", {
        command: "Write-Output 'store-out'; [Console]::Error.WriteLine('store-err'); $x = [Console]::In.ReadLine(); Write-Output \"got:$x\"; exit 7",
        label: "store-stdio",
      });
      expectNoError(result);
      const started = textOf(result);
      expect(started).toContain("Shell: Store (MSIX) PowerShell 7");
      expect(started).toContain("not tracked, stopped, or reported");
      expect(started).toContain("not retried on another shell");
      const id = started.match(/as (job\d+)/)![1];
      const ready = await untilLog(call, id, (log) => log.includes("store-out"), 60_000);
      expect(ready.ok, `stdout; log:\n${ready.log}`).toBe(true);
      expect((await call("ShellSend", { id, text: "hello" })).isError).toBe(false);
      expect(await until(() => sent.length > 0, 30_000), "exit wake").toBe(true);
      expect(sent[0].content).toContain("exited 7");
      const log = textOf(await call("ShellLog", { id }));
      expect(log).toContain("got:hello");
      expect(log).toContain("store-err");
      const finalRecord = readRecord(result.details.ownershipMarker);
      expect(/^\d+ released msix$/.test(finalRecord), finalRecord).toBe(true);
    });
  });

  it("runs the Store workload without a visible console window, inside a job, on Node's stdio", SKIP, async (t) => {
    const target = storeExecutable(t, "alias");
    if (!target) return;
    await withStorePowerShellOnly(target.exe, async () => {
      // The workload is a second process the launcher creates itself, so
      // Node's windowsHide does not reach it: CREATE_NO_WINDOW must (#800).
      const { sent, call } = wire(true);
      const result = await call("ShellStart", {
        command:
          "Add-Type -Namespace PiReviewTest -Name ConsoleProbe -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); [DllImport(\"user32.dll\")] public static extern bool IsWindowVisible(IntPtr window); [DllImport(\"kernel32.dll\")] public static extern IntPtr GetCurrentProcess(); [DllImport(\"kernel32.dll\")] public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);'; " +
          "$hwnd = [PiReviewTest.ConsoleProbe]::GetConsoleWindow(); $visible = ($hwnd -ne [IntPtr]::Zero) -and [PiReviewTest.ConsoleProbe]::IsWindowVisible($hwnd); " +
          "$inJob = $false; $queried = [PiReviewTest.ConsoleProbe]::IsProcessInJob([PiReviewTest.ConsoleProbe]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob); " +
          "[Console]::WriteLine('CONSOLE hwnd=' + $hwnd + ' visible=' + $visible + ' injob=' + ($queried -and $inJob)); " +
          "$x = [Console]::In.ReadLine(); [Console]::WriteLine('got:' + $x); [Console]::Error.WriteLine('probe-err'); exit 0",
        label: "store-console",
      });
      expectNoError(result);
      const id = textOf(result).match(/as (job\d+)/)![1];
      const probed = await untilLog(call, id, (log) => /CONSOLE hwnd=\S+ visible=\S+ injob=\S+/.test(log), 60_000);
      expect(probed.ok, `console probe; log:\n${probed.log}`).toBe(true);
      const [, hwnd, visible, inJob] = /CONSOLE hwnd=(\S+) visible=(\S+) injob=(\S+)/.exec(probed.log)!;
      expect(visible, "the Store workload has no visible console window").toBe("False");
      expect(inJob, "the Store workload runs inside a job").toBe("True");
      t.diagnostic(`Store workload console window handle ${hwnd}, visible=${visible}`);
      expect((await call("ShellSend", { id, text: "probe-in" })).isError, "stdin still reaches the workload").toBe(false);
      expect(await until(() => sent.length > 0, 30_000), "exit wake").toBe(true);
      expect(sent[0].content).toContain("exited 0");
      const log = textOf(await call("ShellLog", { id }));
      expect(log).toContain("got:probe-in");
      expect(log).toContain("probe-err");
      expect(/^\d+ released msix$/.test(readRecord(result.details.ownershipMarker)), "released").toBe(true);
    });
  });

  it("maps exit status correctly on the Store route", SKIP, async (t) => {
    const target = storeExecutable(t, "alias");
    if (!target) return;
    await withStorePowerShellOnly(target.exe, () => runExitMatrix("Store pwsh", true));
  });

  it("ShellStop on a root-exited Store job states its scope, ends the descendant, and clears readiness", SKIP, async (t) => {
    const target = storeExecutable(t, "alias");
    if (!target) return;
    await withStorePowerShellOnly(target.exe, async () => {
      const { sent, call } = wire(true);
      const result = await call("ShellStart", {
        command: `$g = ${psStartInherited(PING, "-n 90 127.0.0.1", true)}; Write-Output ("GRANDCHILD=" + $g.Id + " " + $g.StartTime.Ticks); exit 0`,
        label: "store-stop",
      });
      expectNoError(result);
      const id = textOf(result).match(/as (job\d+)/)![1];
      const readiness = new BackgroundProcessReadiness();
      expect(readiness.observeToolResult("ShellStart", result) !== undefined, "tracked").toBe(true);
      const seen = await untilLog(call, id, (log) => /GRANDCHILD=\d+ \d+/.test(log), 60_000);
      expect(seen.ok, seen.log).toBe(true);
      const [, pid, ticks] = /GRANDCHILD=(\d+) ([0-9]{1,20})/.exec(seen.log)!;
      // The Node-facing process exits with the root; the job stays accounted for.
      expect(await until(() => !pidAlive(result.details.pid), 30_000), "root exited").toBe(true);
      expect(readiness.snapshot().running.length, "readiness blocked while the job has members").toBe(1);
      const observer = await openExactHandleObserver([{ label: "grandchild", pid: Number(pid), ticks }]);
      expect(observer.opened).toEqual({ grandchild: "ok" });
      const stopped = await call("ShellStop", { id });
      expectNoError(stopped);
      expect(textOf(stopped)).toContain("Store PowerShell route: the stop terminates every process in the job object");
      expect(textOf(stopped)).toContain("not reached or claimed");
      expect(await observer.waitForExit(20_000)).toEqual({ grandchild: "exited" });
      expect(await until(() => /^\d+ terminated msix$/.test(readRecord(result.details.ownershipMarker)), 20_000)).toBe(true);
      expect(await until(() => sent.length > 0, 30_000), "exit wake after verified stop").toBe(true);
      expect(sent[0].content).toContain("exited 0");
      expect(readiness.snapshot().running.length, "readiness clear once verified").toBe(0);
    });
  });

  it("settles on the verified acknowledgement while an escaped nested-activation process holds the pipe", SKIP, async (t) => {
    const target = storeExecutable(t, "alias");
    if (!target) return;
    await withStorePowerShellOnly(target.exe, async () => {
      // A NESTED Store app activation (the alias, from inside the job) — the
      // documented gap: what it starts can land outside the job object. Its
      // PING inherits the job's stdout pipe and lives at most ~30 s.
      const inner =
        `$p = ${psStartInherited(PING, "-n 40 127.0.0.1")}; ` +
        "[Console]::WriteLine('NESTED-SHELL=' + $PID + ' ' + (Get-Process -Id $PID).StartTime.Ticks + ' NESTED-CHILD=' + $p.Id + ' ' + $p.StartTime.Ticks); Start-Sleep -Seconds 60";
      const encoded = Buffer.from(inner, "utf16le").toString("base64");
      const { sent, call, controller } = wire(true);
      const result = await call("ShellStart", {
        command: `& "$env:LOCALAPPDATA\\Microsoft\\WindowsApps\\pwsh.exe" -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
        label: "store-nested",
      });
      expectNoError(result);
      const id = textOf(result).match(/as (job\d+)/)![1];
      const seen = await untilLog(call, id, (log) => /NESTED-CHILD=\d+ \d+/.test(log), 60_000);
      expect(seen.ok, seen.log).toBe(true);
      const [, shellPid, shellTicks, escapedPid, escapedTicks] =
        /NESTED-SHELL=(\d+) ([0-9]{1,20}) NESTED-CHILD=(\d+) ([0-9]{1,20})/.exec(seen.log)!;
      // Exact handles to BOTH the nested shell (inside the job) and its child
      // (outside it), verified by creation time before the stop. Two rounds:
      // one bounded look at settlement, and one bounded wait in `finally` on
      // the same handles for the escaped fixture's own end.
      const observer = await openExactHandleObserver([
        { label: "nestedShell", pid: Number(shellPid), ticks: shellTicks },
        { label: "escaped", pid: Number(escapedPid), ticks: escapedTicks },
      ], 2);
      try {
        expect(observer.opened).toEqual({ nestedShell: "ok", escaped: "ok" });
        const stopAt = Date.now();
        expectNoError(await call("ShellStop", { id }));
        expect(await until(() => sent.length > 0, 15_000), "exit wake after the verified stop").toBe(true);
        const settledMs = Date.now() - stopAt;
        expect(controller.snapshot().running, "no job left running: the MAX_JOBS slot is free").toEqual([]);
        expect(/^\d+ terminated msix$/.test(readRecord(result.details.ownershipMarker)), "verified terminated acknowledgement").toBe(true);
        const log = textOf(await call("ShellLog", { id }));
        // One bounded look through the held handles, right after settlement.
        const states = await observer.waitForExit(1_500);
        expect(states.nestedShell, "the stop ended the nested Store shell itself (a job member)").toBe("exited");
        if (states.escaped === "exited") {
          t.skip(`nested-activation escape not reproduced on this host: the nested child was already gone at settlement (${settledMs} ms after stop), so acknowledgement-based settlement was not exercised`);
          return;
        }
        // WAIT_FAILED is never read as alive.
        expect(states.escaped, "the escaped child's exact handle reported a timeout, not a failed wait").toBe("alive");
        // The escaped process was alive and holding the pipe at settlement, so
        // the settlement came from the acknowledgement, not a pipe close.
        expect(log).toContain("settled on the job object's verified acknowledgement (terminated)");
        expect(log).toContain("not tracked, stopped, or reported");
        t.diagnostic(`nested child escaped and was alive at settlement; settled ${settledMs} ms after stop`);
      } finally {
        if (observer.opened.escaped === "ok") {
          // Nothing here signals the escaped process: wait out its bounded
          // lifetime (PING -n 40) on the exact held handle, so this suite
          // leaves nothing running — and require that handle to be signaled.
          const final = await observer.waitForExit(65_000);
          expect(final.escaped, "the escaped bounded fixture's exact handle signaled its own exit").toBe("exited");
        }
      }
    });
  });

  it("reports closed stdin while the Store workload is still live", SKIP, async (t) => {
    const target = storeExecutable(t, "alias");
    if (!target) return;
    await withStorePowerShellOnly(target.exe, async () => {
      // The workload closes its own (sole) stdin handle and keeps running. The
      // launcher released its copy before resume, so no other process holds
      // the read end and the next write must fail (#800).
      const { sent, call } = wire(true);
      const result = await call("ShellStart", {
        command:
          "Add-Type -Namespace PiReviewTest -Name CloseTestInput -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetStdHandle(int which); [DllImport(\"kernel32.dll\")] public static extern bool CloseHandle(IntPtr handle);'; " +
          "$closed = [PiReviewTest.CloseTestInput]::CloseHandle([PiReviewTest.CloseTestInput]::GetStdHandle(-10)); " +
          "[Console]::WriteLine('STDIN-CLOSED ' + $closed); Start-Sleep -Seconds 30; exit 0",
        label: "store-stdin-closed",
      });
      expectNoError(result);
      const id = textOf(result).match(/as (job\d+)/)![1];
      const ready = await untilLog(call, id, (log) => log.includes("STDIN-CLOSED True"), 60_000);
      expect(ready.ok, `workload closed its stdin; log:\n${ready.log}`).toBe(true);
      const send = await call("ShellSend", { id, text: "after-close" });
      expect(send.isError, `ShellSend reports the closed input; result:\n${textOf(send)}`).toBe(true);
      expect(textOf(send)).toContain("stdin");
      expect(sent.length, "the workload is still live (no exit wake yet)").toBe(0);
      t.diagnostic(`closed-stdin ShellSend: ${textOf(send).split("\n")[0]}`);
      expectNoError(await call("ShellStop", { id }));
      expect(await until(() => /^\d+ terminated msix$/.test(readRecord(result.details.ownershipMarker)), 20_000), "verified stop").toBe(true);
      expect(await until(() => sent.length > 0, 30_000), "exit wake after the verified stop").toBe(true);
    });
  });
});
