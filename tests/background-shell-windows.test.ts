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
 * helpers/pwsh-prerequisite.ts). Test-owned
 * temp-file cleanup uses bounded retry (tests/helpers/temp-file-cleanup.ts):
 * a just-killed process can hold its redirected-output handles open briefly
 * on Windows, and a transient EPERM in cleanup must neither fail an
 * otherwise-passing lifecycle assertion nor mask a real body failure.
 */
import { afterEach, describe, it } from "node:test";
import { expect } from "./helpers/expect";
import { spawn, spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runWithTempCleanup } from "./helpers/temp-file-cleanup";
import registerBackgroundShell, { reapAll } from "../src/background-shell";
import { POWERSHELL_ARGS, wrapWithPowerShellWatchdog } from "../src/background-shell/jobs";
import { findWindowsExecutable, resolveWindowsPowerShell, spawnBackgroundJob } from "../src/background-shell/shell";
import { BackgroundProcessReadiness } from "../src/background-process-readiness";
import { probePwshPrerequisite } from "./helpers/pwsh-prerequisite";

const IS_WINDOWS = process.platform === "win32";
const SKIP = { skip: !IS_WINDOWS };

interface Sent {
  content: string;
  delivery: any;
}

function wire() {
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
  const call = (name: string, params: any) =>
    tools[name].execute("id", params, undefined, undefined, ctx);
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
 *  compare against it. */
async function withWindowsPowerShell51(fn: (powershellExe: string) => Promise<void>): Promise<void> {
  const original = process.env.PATH ?? "";
  const drop = pwshResolvingDirs(original);
  const kept: string[] = [];
  for (const entry of original.split(";")) {
    if (!entry.trim()) continue;
    if (drop.has(normalizePathEntry(entry))) continue;
    kept.push(entry);
  }
  const reduced = kept.join(";");
  process.env.PATH = reduced;
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

afterEach(() => {
  reapAll();
});

describe("ShellStart on native Windows: PowerShell discovery (#99)", () => {
  it("prefers pwsh.exe when both PowerShell editions resolve", SKIP, async (t) => {
    // Optional prerequisite: a verified absence skips with a truthful reason;
    // a failed, timed-out, or malformed lookup fails with diagnostics instead
    // of masquerading as absence.
    const prereq = probePwshPrerequisite();
    if (prereq.kind === "absent") {
      t.skip("PowerShell 7 (pwsh.exe) is not on PATH; optional prerequisite for pwsh-specific coverage");
      return;
    }
    if (prereq.kind === "error") throw new Error(`pwsh prerequisite lookup failed: ${prereq.reason}`);
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
    const { ok, log } = await untilLog(call, id, (t) => t.includes("pwsh.exe"));
    expect(ok, `expected the launched shell to be pwsh.exe; observed ShellLog:\n${log}`).toBe(true);
  });

  it("falls back to powershell.exe when pwsh.exe is absent from PATH", SKIP, async () => {
    await withWindowsPowerShell51(async (powershellExe) => {
      const { call } = wire();
      const result = await call("ShellStart", {
        command: "Write-Output (Get-Process -Id $PID).Path; exit 0",
        label: "ps-fallback",
      });
      expectNoError(result);
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
      await withPath(emptyDir, async () => {
        const { call, controller } = wire();
        const result = await call("ShellStart", { command: "Write-Output never", label: "no-ps" });
        expect(result.isError, "isError").toBe(true);
        expect(textOf(result)).toContain("No PowerShell executable");
        // No job was started: nothing running, nothing listed.
        expect(controller.snapshot().running).toEqual([]);
        expect(textOf(await call("ShellList", {}))).toContain("No background jobs");
      });
    });
  });
});

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

  async function runExitMatrix(edition: string): Promise<void> {
    for (const testCase of EXIT_CASES) {
      const { sent, call } = wire();
      await call("ShellStart", { command: testCase.command, label: `ps-exit-${testCase.name.replace(/\s+/g, "-")}` });
      expect(await until(() => sent.length > 0), `${edition}: ${testCase.name} exit wake`).toBe(true);
      expect(sent[0].content, `${edition}: ${testCase.name}`).toContain(`exited ${testCase.code}`);
    }
  }
  it("maps exit status correctly on PowerShell 7 (pwsh)", SKIP, async (t) => {
    // Optional prerequisite: a verified absence skips with a truthful reason;
    // a failed, timed-out, or malformed lookup fails with diagnostics instead
    // of masquerading as absence.
    const prereq = probePwshPrerequisite();
    if (prereq.kind === "absent") {
      t.skip("PowerShell 7 (pwsh.exe) is not on PATH; optional prerequisite for pwsh-specific coverage");
      return;
    }
    if (prereq.kind === "error") throw new Error(`pwsh prerequisite lookup failed: ${prereq.reason}`);
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
      "$p = Start-Process -FilePath \"$env:ComSpec\" " +
      "-ArgumentList '/c','ping -n 600 127.0.0.1' " +
      `-RedirectStandardOutput '${outFile}' -RedirectStandardError '${outFile}.err' -PassThru; ` +
      "Write-Output \"GRANDCHILD=$($p.Id)\"; exit 0"
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

      // The root exits on its own (the wrapper ran `exit 0`)...
      expect(await until(() => !pidAlive(rootPid), 30_000)).toBe(true);
      // ...while the detached grandchild lives on. Ownership evidence — a live
      // watchdog holding the job object — keeps the job accounted for and
      // readiness blocked instead of falsely clearing it.
      expect(pidAlive(grandchild), "grandchild alive after root exit").toBe(true);
      const listText = textOf(await call("ShellList", {}));
      expect(listText.includes(id) && listText.includes("running"), "job still listed as running after root exit").toBe(true);
      expect(controller.snapshot().running.length, "controller still reports the job").toBe(1);
      expect(readiness.snapshot().running.length, "readiness blocked while owned descendants remain").toBe(1);

      // ShellStop reaches the grandchild even though its root pid is gone: the
      // stop file makes the surviving watchdog TerminateJobObject.
      await call("ShellStop", { id });
      expect(await until(() => !pidAlive(grandchild), 30_000)).toBe(true);

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
  // execution, and no clean success. (When the watchdog dies after assigning
  // the root, KILL_ON_JOB_CLOSE may kill the wrapper itself; either way the
  // command never ran and the exit is not a clean 0.)
  it("fails closed before running the command when ownership cannot be established", SKIP, async () => {
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
      const child = spawn(executable, [...POWERSHELL_ARGS, wrapped], { windowsHide: true });
      let out = "";
      child.stdout!.on("data", (d) => { out += d.toString(); });
      child.stderr!.on("data", (d) => { out += d.toString(); });
      expect(await until(() => child.exitCode !== null || child.signalCode !== null, 30_000), "wrapper exited").toBe(true);
      expect(out).not.toContain("OWNERFAIL-CANARY");
      expect(child.exitCode === 0, "no clean exit without established ownership").toBe(false);
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
  const spawnError = new Promise<void>((resolve) => {
    child.once("error", () => { spawnFailed = child.pid === undefined; resolve(); });
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
    // carry paths or raw error text, so it is not echoed).
    const prereq = probePwshPrerequisite();
    if (prereq.kind === "absent") {
      t.skip("PowerShell 7 (pwsh.exe) is not on PATH; optional prerequisite for pwsh-specific coverage");
      return;
    }
    if (prereq.kind === "error") {
      throw new Error("pwsh prerequisite lookup failed (stage pwsh-lookup): presence was neither verified nor ruled out");
    }
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
});


function expectNoError(result: any): void {
  if (result.isError) throw new Error(`ShellStart unexpectedly failed: ${textOf(result)}`);
}
