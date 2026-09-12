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
 * mocks a shell — the PATH manipulation below changes what `where` really
 * finds.
 */
import { afterEach, describe, it } from "node:test";
import { expect } from "./helpers/expect";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import registerBackgroundShell, { reapAll } from "../src/background-shell";
import { POWERSHELL_ARGS, wrapWithPowerShellWatchdog } from "../src/background-shell/jobs";
import { resolveWindowsPowerShell, spawnBackgroundJob } from "../src/background-shell/shell";
import { BackgroundProcessReadiness } from "../src/background-process-readiness";

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

/** The PATH entry that actually contains pwsh.exe (runner-layout independent). */
function pwshDir(): string | null {
  const result = spawnSync("where", ["pwsh.exe"], { encoding: "utf-8" });
  if (result.status !== 0 || !result.stdout) return null;
  const first = result.stdout.trim().split(/\r?\n/)[0];
  return first ? dirname(first) : null;
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
  it("prefers pwsh.exe when both PowerShell editions resolve", SKIP, async () => {
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
    expect(await until(async () => textOf(await call("ShellLog", { id })).includes("pwsh.exe"))).toBe(true);
  });

  it("falls back to powershell.exe when pwsh.exe is absent from PATH", SKIP, async () => {
    const dir = pwshDir();
    if (!dir) return; // nothing to strip: pwsh already absent, default path covered above
    const reduced = (process.env.PATH ?? "")
      .split(";")
      .filter((entry) => entry && entry.toLowerCase() !== dir.toLowerCase())
      .join(";");
    await withPath(reduced, async () => {
      const { call } = wire();
      const result = await call("ShellStart", {
        command: "Write-Output (Get-Process -Id $PID).Path; exit 0",
        label: "ps-fallback",
      });
      expectNoError(result);
      const id = textOf(result).match(/as (job\d+)/)![1];
      const log = await until(async () => {
        const text = textOf(await call("ShellLog", { id }));
        return text.includes("powershell.exe") && !text.includes("pwsh.exe");
      });
      expect(log, "resolved to Windows PowerShell").toBe(true);
    });
  });

  it("fails clearly without starting a job when no PowerShell is on PATH", SKIP, async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "pi-review-no-ps-"));
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
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("ShellStart on native Windows: invocation and encoding (#99)", () => {
  it("round-trips non-ASCII output through the UTF-8 console prefix", SKIP, async () => {
    const { call } = wire();
    const id = textOf(await call("ShellStart", {
      command: "Write-Output \"héllo wörld 世界\"; exit 0",
      label: "ps-utf8",
    })).match(/as (job\d+)/)![1];
    expect(await until(async () => textOf(await call("ShellLog", { id })).includes("héllo wörld 世界"))).toBe(true);
  });

  it("handles spaces and quoting in commands", SKIP, async () => {
    const { call } = wire();
    const command =
      "$p = 'C:\\Program Files\\PowerShell'\n" +
      "Write-Output \"path=$p\"\n" +
      "Write-Output 'a \"quoted\" word'; exit 0";
    const id = textOf(await call("ShellStart", { command, label: "ps-quote" })).match(/as (job\d+)/)![1];
    expect(await until(async () => {
      const log = textOf(await call("ShellLog", { id }));
      return log.includes("path=C:\\Program Files\\PowerShell") && log.includes('a "quoted" word');
    })).toBe(true);
  });

  // Exit-status contract, exercised on BOTH PowerShell editions: the default
  // PATH resolves pwsh (PowerShell 7), the reduced PATH resolves the built-in
  // Windows PowerShell 5.1 — proven by the discovery tests above.
  const EXIT_CASES: Array<{ name: string; command: string; code: number }> = [
    { name: "successful cmdlet", command: "Write-Output ok", code: 0 },
    { name: "failed cmdlet (no native status)", command: "Get-ChildItem C:\\definitely\\not\\a\\real\\path-pi-review", code: 1 },
    { name: "nonzero native exit", command: "cmd /c exit 7", code: 7 },
    { name: "explicit exit N", command: "exit 3", code: 3 },
  ];

  async function runExitMatrix(edition: string, pathValue: string | null): Promise<void> {
    await withPath(pathValue, async () => {
      for (const testCase of EXIT_CASES) {
        const { sent, call } = wire();
        await call("ShellStart", { command: testCase.command, label: `ps-exit-${testCase.code}` });
        expect(await until(() => sent.length > 0), `${edition}: ${testCase.name} exit wake`).toBe(true);
        expect(sent[0].content, `${edition}: ${testCase.name}`).toContain(`exited ${testCase.code}`);
      }
    });
  }
  it("maps exit status correctly on PowerShell 7 (pwsh)", SKIP, async () => {
    await runExitMatrix("pwsh", null);
  });

  it("maps exit status correctly on Windows PowerShell 5.1 (powershell.exe)", SKIP, async () => {
    const dir = pwshDir();
    if (!dir) return; // pwsh already absent: the 5.1 edition IS the default path here
    const reduced = (process.env.PATH ?? "")
      .split(";")
      .filter((entry) => entry && entry.toLowerCase() !== dir.toLowerCase())
      .join(";");
    await runExitMatrix("powershell.exe", reduced);
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
    expect(await until(async () => textOf(await call("ShellLog", { id })).includes("got:hello"))).toBe(true);
  });
});

describe("ShellStart on native Windows: lifecycle and cleanup (#99)", () => {
  // The one that matters most. A grandchild started under the shell must die
  // with ShellStop — taskkill /F /T walks the tree the way negative-pid group
  // signalling does on POSIX.
  it("ShellStop kills the whole process tree, not just the shell", SKIP, async () => {
    const { call } = wire();
    const id = textOf(await call("ShellStart", {
      command:
        "$p = Start-Process -FilePath \"$env:ComSpec\" -ArgumentList '/c','ping -n 600 127.0.0.1' -PassThru; " +
        "Write-Output \"GRANDCHILD=$($p.Id)\"; Wait-Process -Id $p.Id",
      label: "ps-tree",
    })).match(/as (job\d+)/)![1];

    expect(await until(async () => textOf(await call("ShellLog", { id })).includes("GRANDCHILD="))).toBe(true);
    const grandchild = Number(textOf(await call("ShellLog", { id })).match(/GRANDCHILD=(\d+)/)![1]);
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
    const dir = pwshDir();
    if (!dir) return; // pwsh already absent: the 5.1 edition IS the default path here
    const reduced = (process.env.PATH ?? "")
      .split(";")
      .filter((entry) => entry && entry.toLowerCase() !== dir.toLowerCase())
      .join(";");
    await withPath(reduced, runParentDeath);
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
    const dir = pwshDir();
    if (!dir) return; // pwsh already absent: the 5.1 edition IS the default path here
    const reduced = (process.env.PATH ?? "")
      .split(";")
      .filter((entry) => entry && entry.toLowerCase() !== dir.toLowerCase())
      .join(";");
    await withPath(reduced, runExplicitExitLeakCheck);
  });

  it("reapAll leaves nothing running", SKIP, async () => {
    const { call } = wire();
    const id = textOf(await call("ShellStart", {
      command:
        "$p = Start-Process -FilePath \"$env:ComSpec\" -ArgumentList '/c','ping -n 600 127.0.0.1' -PassThru; " +
        "Write-Output \"GRANDCHILD=$($p.Id)\"; Wait-Process -Id $p.Id",
      label: "ps-leak",
    })).match(/as (job\d+)/)![1];
    expect(await until(async () => textOf(await call("ShellLog", { id })).includes("GRANDCHILD="))).toBe(true);
    const grandchild = Number(textOf(await call("ShellLog", { id })).match(/GRANDCHILD=(\d+)/)![1]);

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
    try {
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

      expect(await until(async () => textOf(await call("ShellLog", { id })).includes("GRANDCHILD="), 30_000)).toBe(true);
      const grandchild = Number(textOf(await call("ShellLog", { id })).match(/GRANDCHILD=(\d+)/)![1]);

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
    } finally {
      rmSync(outFile, { force: true });
      rmSync(`${outFile}.err`, { force: true });
    }
  });

  // Host death AFTER the root has already exited: no signal handler runs, and
  // taskkill /T rooted at the (dead) root pid cannot reach the grandchild. Only
  // the surviving watchdog's parent-death path — TerminateJobObject on the job
  // it alone holds — can. Polls at 1 s here so both checks land quickly.
  async function runHostDeathAfterRootExit(): Promise<void> {
    const outFile = freshOutFile("pi-review-hostdeath");
    try {
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
    } finally {
      rmSync(outFile, { force: true });
      rmSync(`${outFile}.err`, { force: true });
    }
  }

  it("terminates descendants when the host dies after the root has exited (PowerShell 7)", SKIP, async () => {
    await runHostDeathAfterRootExit();
  });

  it("terminates descendants when the host dies after the root has exited (Windows PowerShell 5.1)", SKIP, async () => {
    const dir = pwshDir();
    if (!dir) return; // pwsh already absent: the 5.1 edition IS the default path here
    const reduced = (process.env.PATH ?? "")
      .split(";")
      .filter((entry) => entry && entry.toLowerCase() !== dir.toLowerCase())
      .join(";");
    await withPath(reduced, runHostDeathAfterRootExit);
  });

  // Fail-closed ownership establishment: a marker path that is an existing
  // directory can never receive the record, so the watchdog's handshake fails.
  // The wrapper must abort BEFORE the user command runs — no unprotected
  // execution, and no clean success. (When the watchdog dies after assigning
  // the root, KILL_ON_JOB_CLOSE may kill the wrapper itself; either way the
  // command never ran and the exit is not a clean 0.)
  it("fails closed before running the command when ownership cannot be established", SKIP, async () => {
    const markerDir = mkdtempSync(join(tmpdir(), "pi-review-owner-fail-"));
    try {
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
    } finally {
      rmSync(markerDir, { recursive: true, force: true });
    }
  });
  // Paths with spaces and apostrophes must survive BOTH quoting layers: the
  // .Replace argument inside the wrapper script, and the assignment in the
  // resulting watchdog script. Run a real job end-to-end (job object,
  // handshake, command, self-release) with such paths.
  it("establishes ownership through marker/stop paths containing spaces and apostrophes", SKIP, async () => {
    const dir = join(tmpdir(), "pi review owner", "it's here");
    mkdirSync(dir, { recursive: true });
    try {
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
    } finally {
      rmSync(join(tmpdir(), "pi review owner"), { recursive: true, force: true });
    }
  });

  // Natural descendant completion: the root exits immediately, the grandchild
  // survives across SEVERAL watchdog polls (so release cannot be a one-tick
  // artifact), then finishes on its own. Readiness must stay blocked while the
  // owned descendant lives and clear once the job is verified empty — without
  // anyone killing anything. Exercises the accounting-query release path.
  async function runNaturalCompletion(): Promise<void> {
    const outFile = freshOutFile("pi-review-natural");
    try {
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

      expect(await until(async () => textOf(await call("ShellLog", { id })).includes("GRANDCHILD="), 30_000)).toBe(true);
      const grandchild = Number(textOf(await call("ShellLog", { id })).match(/GRANDCHILD=(\d+)/)![1]);

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
    } finally {
      rmSync(outFile, { force: true });
      rmSync(`${outFile}.err`, { force: true });
    }
  }

  it("keeps readiness blocked across watchdog polls until a descendant finishes naturally (PowerShell 7)", SKIP, async () => {
    await runNaturalCompletion();
  });

  it("keeps readiness blocked across watchdog polls until a descendant finishes naturally (Windows PowerShell 5.1)", SKIP, async () => {
    const dir = pwshDir();
    if (!dir) return; // pwsh already absent: the 5.1 edition IS the default path here
    const reduced = (process.env.PATH ?? "")
      .split(";")
      .filter((entry) => entry && entry.toLowerCase() !== dir.toLowerCase())
      .join(";");
    await withPath(reduced, runNaturalCompletion);
  });
});


function expectNoError(result: any): void {
  if (result.isError) throw new Error(`ShellStart unexpectedly failed: ${textOf(result)}`);
}
