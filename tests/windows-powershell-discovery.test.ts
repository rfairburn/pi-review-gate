/*
 * Windows PowerShell discovery (#405): the background shell resolves its
 * interpreter exactly as Pi 1.6.0's `getPowerShellConfig` does — `where
 * pwsh.exe`, the `%ProgramFiles%\PowerShell\7\pwsh.exe` install location,
 * `where powershell.exe`, then the
 * `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` install
 * location — with `accessSync(path, F_OK)` existence checks, plus the one
 * intentional difference from Pi: a `where` lookup that timed out is retried
 * exactly once with a longer bound.
 *
 * Everything is driven through the injected dependencies (the `where` runner,
 * the existence check, and the environment record), so the order, the retry
 * count, the fallbacks, and the fail-closed error are proven deterministically
 * on any platform: no `where`, no installed PowerShell, and no Windows host.
 */
import { describe, it } from "node:test";
import { expect } from "./helpers/expect";
import {
  WINDOWS_WHERE_RETRY_TIMEOUT_MS,
  WINDOWS_WHERE_TIMEOUT_MS,
  findWindowsExecutable,
  findWindowsPowerShell,
  resolveWindowsPowerShell,
  type WindowsPowerShellDiscoveryDeps,
  type WindowsWhereProbe,
} from "../src/background-shell/shell";

/** The Pi install-location candidates these fixtures describe. */
const PWSH7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const WINDOWS_POWER_SHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function timeoutError(): NodeJS.ErrnoException {
  const error = new Error("spawnSync where ETIMEDOUT") as NodeJS.ErrnoException;
  error.code = "ETIMEDOUT";
  return error;
}

function notFound(): WindowsWhereProbe {
  return { status: 1, stdout: "" };
}

interface RecordedCall {
  executable: string;
  timeoutMs: number;
}

interface HarnessOptions {
  /** What `where <executable>` answers on its `attempt`-th run (1-based). */
  where?: (executable: string, attempt: number) => WindowsWhereProbe;
  /** Which reported or install-location paths the existence check accepts. */
  exists?: (path: string) => boolean;
  /** Environment record for the install-location fallbacks. */
  env?: Record<string, string | undefined>;
}

/** Discovery with every dependency injected, recording the `where` calls (with
 *  the bound each used) and the paths the existence check was asked about. */
function harness(options: HarnessOptions = {}) {
  const calls: RecordedCall[] = [];
  const checkedPaths: string[] = [];
  const attempts = new Map<string, number>();
  const deps: WindowsPowerShellDiscoveryDeps = {
    runWhere: (executable, timeoutMs) => {
      const attempt = (attempts.get(executable) ?? 0) + 1;
      attempts.set(executable, attempt);
      calls.push({ executable, timeoutMs });
      return options.where?.(executable, attempt) ?? notFound();
    },
    pathExists: (path) => {
      checkedPaths.push(path);
      return options.exists?.(path) ?? false;
    },
    env: options.env ?? {},
  };
  return { deps, calls, checkedPaths };
}

const notFoundWhere = () => notFound();

describe("findWindowsExecutable: one retry only for a timed-out where lookup (#405)", () => {
  it("exports the Pi lookup bound and a longer retry bound", () => {
    expect(WINDOWS_WHERE_TIMEOUT_MS, "Pi's 5000 ms lookup bound").toBe(5000);
    expect(WINDOWS_WHERE_RETRY_TIMEOUT_MS > WINDOWS_WHERE_TIMEOUT_MS, "the retry bound is longer").toBe(true);
  });

  it("returns the first reported line the existence check accepts", () => {
    const probe = harness({
      where: () => ({ status: 0, stdout: "C:\\tools\\pwsh.exe\r\nC:\\other\\pwsh.exe\r\n" }),
      exists: (path) => path === "C:\\tools\\pwsh.exe",
    });
    expect(findWindowsExecutable("pwsh.exe", probe.deps), "first reported path").toBe("C:\\tools\\pwsh.exe");
    expect(probe.calls, "one lookup at the Pi bound").toEqual([{ executable: "pwsh.exe", timeoutMs: 5000 }]);
  });

  it("retries a timed-out lookup exactly once with the longer bound", () => {
    const probe = harness({
      where: (_executable, attempt) => (attempt === 1
        ? { error: timeoutError(), status: null, stdout: "" }
        : { status: 0, stdout: "C:\\tools\\pwsh.exe\r\n" }),
      exists: () => true,
    });
    expect(findWindowsExecutable("pwsh.exe", probe.deps), "the retried lookup answers").toBe("C:\\tools\\pwsh.exe");
    expect(probe.calls, "one retry, at the longer bound").toEqual([
      { executable: "pwsh.exe", timeoutMs: WINDOWS_WHERE_TIMEOUT_MS },
      { executable: "pwsh.exe", timeoutMs: WINDOWS_WHERE_RETRY_TIMEOUT_MS },
    ]);
  });

  it("never retries a second time after the retry also timed out", () => {
    const probe = harness({
      where: (_executable, attempt) => (attempt === 1
        ? { error: timeoutError(), status: null, stdout: "" }
        : { error: timeoutError(), status: 0, stdout: "C:\\tools\\pwsh.exe\r\n" }),
      exists: () => true,
    });
    expect(findWindowsExecutable("pwsh.exe", probe.deps), "still not found").toBeNull();
    expect(probe.calls.length, "exactly two lookups, never a third").toBe(2);
    expect(probe.calls[1].timeoutMs, "the second lookup uses the retry bound").toBe(WINDOWS_WHERE_RETRY_TIMEOUT_MS);
  });

  it("does not retry a not-found exit status", () => {
    const probe = harness({ where: notFoundWhere });
    expect(findWindowsExecutable("powershell.exe", probe.deps), "where answered not found").toBeNull();
    expect(probe.calls, "one lookup only").toEqual([{ executable: "powershell.exe", timeoutMs: 5000 }]);
  });

  it("does not retry a non-timeout spawn error", () => {
    const probe = harness({
      where: () => ({ error: new Error("spawn where ENOENT") as NodeJS.ErrnoException, status: null, stdout: "" }),
    });
    expect(findWindowsExecutable("pwsh.exe", probe.deps), "spawn failure is not a timeout").toBeNull();
    expect(probe.calls.length, "one lookup only").toBe(1);
  });

  it("does not return a reported path the existence check rejects", () => {
    const probe = harness({
      where: () => ({ status: 0, stdout: "C:\\gone\\pwsh.exe\r\n" }),
      exists: () => false,
    });
    expect(findWindowsExecutable("pwsh.exe", probe.deps), "a stale where hit is refused").toBeNull();
    expect(probe.checkedPaths, "the reported path was checked").toEqual(["C:\\gone\\pwsh.exe"]);
    expect(probe.calls.length, "a refused path is an answer, not a timeout").toBe(1);
  });

  it("treats an unexpected throw from the lookup as not found, without retrying", () => {
    const probe = harness({
      where: () => {
        throw new Error("where blew up");
      },
    });
    expect(findWindowsExecutable("pwsh.exe", probe.deps), "a throw is not found").toBeNull();
    expect(probe.calls, "a throw is not a timeout, so it is never retried").toEqual([
      { executable: "pwsh.exe", timeoutMs: WINDOWS_WHERE_TIMEOUT_MS },
    ]);
  });

  it("refuses a candidate whose existence check throws, without escaping or retrying", () => {
    const probe = harness({
      where: () => ({ status: 0, stdout: "C:\\tools\\pwsh.exe\r\n" }),
      exists: () => {
        throw new Error("accessSync blew up");
      },
    });
    expect(findWindowsExecutable("pwsh.exe", probe.deps), "a throwing check refuses the candidate").toBeNull();
    expect(probe.calls, "a refused candidate is an answer, not a timeout").toEqual([
      { executable: "pwsh.exe", timeoutMs: WINDOWS_WHERE_TIMEOUT_MS },
    ]);
  });
});

describe("findWindowsPowerShell: Pi 1.6.0's discovery order (#405)", () => {
  it("prefers pwsh.exe on PATH and never looks up powershell.exe", () => {
    const probe = harness({
      where: () => ({ status: 0, stdout: "C:\\tools\\pwsh.exe\r\n" }),
      exists: () => true,
      env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
    });
    expect(findWindowsPowerShell(probe.deps), "pwsh.exe on PATH").toBe("C:\\tools\\pwsh.exe");
    expect(probe.calls, "no powershell.exe lookup").toEqual([{ executable: "pwsh.exe", timeoutMs: 5000 }]);
    expect(probe.checkedPaths.includes(PWSH7) || probe.checkedPaths.includes(WINDOWS_POWER_SHELL),
      "no install location consulted").toBe(false);
  });

  it("uses the ProgramFiles PowerShell 7 location when where pwsh.exe fails", () => {
    const probe = harness({
      where: notFoundWhere,
      exists: (path) => path === PWSH7,
      env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
    });
    expect(findWindowsPowerShell(probe.deps), "install-location fallback").toBe(PWSH7);
    expect(probe.calls, "the chain stops at the PowerShell 7 location").toEqual([
      { executable: "pwsh.exe", timeoutMs: 5000 },
    ]);
    expect(probe.checkedPaths, "the PowerShell 7 location was checked").toEqual([PWSH7]);
  });

  it("skips the ProgramFiles fallback when ProgramFiles is unset", () => {
    const probe = harness({ where: notFoundWhere, exists: (path) => path === PWSH7, env: {} });
    expect(findWindowsPowerShell(probe.deps), "nothing resolves").toBeNull();
    expect(probe.checkedPaths.includes(PWSH7), "the unreadable location was never consulted").toBe(false);
    expect(probe.calls.map((call) => call.executable), "both where lookups ran").toEqual([
      "pwsh.exe", "powershell.exe",
    ]);
  });

  it("skips the ProgramFiles fallback when that file does not exist", () => {
    const probe = harness({
      where: notFoundWhere,
      exists: (path) => path === WINDOWS_POWER_SHELL,
      env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
    });
    expect(findWindowsPowerShell(probe.deps), "falls through to the Windows PowerShell location").toBe(WINDOWS_POWER_SHELL);
    expect(probe.checkedPaths, "the missing pwsh 7 location was checked and refused").toEqual([
      PWSH7, WINDOWS_POWER_SHELL,
    ]);
  });

  it("resolves powershell.exe through where before the SystemRoot location", () => {
    const probe = harness({
      where: (executable) => (executable === "pwsh.exe"
        ? notFound()
        : { status: 0, stdout: "C:\\tools\\powershell.exe\r\n" }),
      exists: (path) => path === WINDOWS_POWER_SHELL || path === "C:\\tools\\powershell.exe",
      env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
    });
    expect(findWindowsPowerShell(probe.deps), "where hit wins").toBe("C:\\tools\\powershell.exe");
    expect(probe.calls, "pwsh.exe then powershell.exe").toEqual([
      { executable: "pwsh.exe", timeoutMs: 5000 },
      { executable: "powershell.exe", timeoutMs: 5000 },
    ]);
    expect(probe.checkedPaths.includes(WINDOWS_POWER_SHELL), "the SystemRoot location is never consulted").toBe(false);
  });

  it("uses the SystemRoot Windows PowerShell location last", () => {
    const probe = harness({
      where: notFoundWhere,
      exists: (path) => path === WINDOWS_POWER_SHELL,
      env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
    });
    expect(findWindowsPowerShell(probe.deps), "last resort").toBe(WINDOWS_POWER_SHELL);
    expect(probe.calls, "the full Pi order").toEqual([
      { executable: "pwsh.exe", timeoutMs: 5000 },
      { executable: "powershell.exe", timeoutMs: 5000 },
    ]);
  });

  it("continues the chain after two timeouts for the same executable", () => {
    const probe = harness({
      where: () => ({ error: timeoutError(), status: null, stdout: "" }),
      exists: (path) => path === WINDOWS_POWER_SHELL,
      env: { SystemRoot: "C:\\Windows" },
    });
    expect(findWindowsPowerShell(probe.deps), "the fallback still resolves").toBe(WINDOWS_POWER_SHELL);
    expect(probe.calls, "each executable is looked up twice at most").toEqual([
      { executable: "pwsh.exe", timeoutMs: WINDOWS_WHERE_TIMEOUT_MS },
      { executable: "pwsh.exe", timeoutMs: WINDOWS_WHERE_RETRY_TIMEOUT_MS },
      { executable: "powershell.exe", timeoutMs: WINDOWS_WHERE_TIMEOUT_MS },
      { executable: "powershell.exe", timeoutMs: WINDOWS_WHERE_RETRY_TIMEOUT_MS },
    ]);
  });

  it("continues the chain when the pwsh.exe lookup throws", () => {
    const probe = harness({
      where: (executable) => (executable === "pwsh.exe"
        ? (() => { throw new Error("where blew up"); })()
        : { status: 0, stdout: "C:\\tools\\powershell.exe\r\n" }),
      exists: () => true,
      env: { SystemRoot: "C:\\Windows" },
    });
    expect(findWindowsPowerShell(probe.deps), "the chain continues to powershell.exe").toBe("C:\\tools\\powershell.exe");
    expect(probe.calls, "one lookup per executable, no retry for the throw").toEqual([
      { executable: "pwsh.exe", timeoutMs: WINDOWS_WHERE_TIMEOUT_MS },
      { executable: "powershell.exe", timeoutMs: WINDOWS_WHERE_TIMEOUT_MS },
    ]);
  });

  it("continues the chain when a PATH candidate's existence check throws", () => {
    const probe = harness({
      where: (executable) => (executable === "pwsh.exe"
        ? { status: 0, stdout: "C:\\tools\\pwsh.exe\r\n" }
        : notFound()),
      exists: (path) => {
        if (path === "C:\\tools\\pwsh.exe") throw new Error("accessSync blew up on the PATH candidate");
        return path === WINDOWS_POWER_SHELL;
      },
      env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
    });
    expect(findWindowsPowerShell(probe.deps), "the later candidate still resolves").toBe(WINDOWS_POWER_SHELL);
    expect(probe.checkedPaths.includes("C:\\tools\\pwsh.exe"), "the PATH hit was the throwing candidate").toBe(true);
    expect(probe.calls, "the chain ran to powershell.exe").toEqual([
      { executable: "pwsh.exe", timeoutMs: 5000 },
      { executable: "powershell.exe", timeoutMs: 5000 },
    ]);
  });

  it("continues the chain when the first install-location existence check throws", () => {
    const probe = harness({
      where: (executable) => (executable === "pwsh.exe"
        ? notFound()
        : { status: 0, stdout: "C:\\tools\\powershell.exe\r\n" }),
      exists: (path) => {
        if (path === PWSH7) throw new Error("accessSync blew up on the PowerShell 7 location");
        return path === "C:\\tools\\powershell.exe";
      },
      env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
    });
    expect(findWindowsPowerShell(probe.deps), "the PATH hit resolves after the throw").toBe("C:\\tools\\powershell.exe");
    expect(probe.checkedPaths.includes(WINDOWS_POWER_SHELL), "the chain stopped at the PATH hit").toBe(false);
  });

  it("returns null when no executable and no install location resolves", () => {
    const probe = harness({
      where: notFoundWhere,
      exists: () => false,
      env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
    });
    expect(findWindowsPowerShell(probe.deps), "nothing found").toBeNull();
    expect(probe.checkedPaths, "both install locations were checked and refused").toEqual([
      PWSH7, WINDOWS_POWER_SHELL,
    ]);
  });

  it("builds the fallback locations with Windows separators", () => {
    const programFiles = harness({
      where: notFoundWhere,
      exists: (path) => path === PWSH7,
      env: { ProgramFiles: "C:\\Program Files" },
    });
    const pwsh7 = findWindowsPowerShell(programFiles.deps);
    expect(pwsh7, "ProgramFiles candidate").toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect((pwsh7 ?? "").includes("/"), "no POSIX separators").toBe(false);

    const systemRoot = harness({
      where: notFoundWhere,
      exists: (path) => path === WINDOWS_POWER_SHELL,
      env: { SystemRoot: "C:\\Windows" },
    });
    const wps = findWindowsPowerShell(systemRoot.deps);
    expect(wps, "SystemRoot candidate").toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect((wps ?? "").includes("/"), "no POSIX separators").toBe(false);
  });
});

describe("resolveWindowsPowerShell: fail closed before any job starts (#405)", () => {
  it("returns what the Pi-order chain resolved", () => {
    const probe = harness({
      where: () => ({ status: 0, stdout: "C:\\tools\\pwsh.exe\r\n" }),
      exists: () => true,
    });
    expect(resolveWindowsPowerShell(probe.deps), "resolved").toBe("C:\\tools\\pwsh.exe");
  });

  it("throws a clear prerequisite error naming PATH and the install locations", () => {
    const probe = harness({
      where: notFoundWhere,
      exists: () => false,
      env: { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" },
    });
    let message = "";
    try {
      resolveWindowsPowerShell(probe.deps);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message, "the error is the actionable prerequisite message").not.toBe("");
    expect(message.startsWith("No PowerShell executable"), "existing callers match this prefix").toBe(true);
    expect(message, "PATH is named").toContain("PATH");
    expect(message, "the PowerShell 7 install location is named").toContain("%ProgramFiles%\\PowerShell\\7\\pwsh.exe");
    expect(message, "the Windows PowerShell install location is named").toContain(
      "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });
});
