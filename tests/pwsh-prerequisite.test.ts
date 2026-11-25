/*
 * Focused regression for the optional PowerShell 7 (pwsh.exe) prerequisite
 * probe (#406, #405). The two pwsh-specific native Windows ShellStart cases
 * run only when production would really launch PowerShell 7: a verified
 * absence must skip them with a truthful reason, while a failed, timed-out,
 * or malformed lookup must fail with diagnostics instead of masquerading as
 * absence. On the CI Windows shell job PowerShell 7 is part of the runner
 * image, so PI_REVIEW_GATE_REQUIRE_PWSH=1 turns a verified absence into a
 * failure instead of a silent loss of coverage (#405).
 *
 * The probe's lookup runner and existence check are injectable, so these
 * cases exercise every outcome deterministically on any platform — no real
 * `where` and no installed PowerShell required. The probe mirrors production
 * discovery (findWindowsPowerShell) where the prerequisite depends on it: the
 * single `where` timeout retry and the `%ProgramFiles%\PowerShell\7\pwsh.exe`
 * install-location fallback.
 */
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "./helpers/expect";
import {
  classifyPwshLookup,
  probePwshPrerequisite,
  pwsh7ProgramFilesPath,
  resolvePwshPrerequisite,
  runPwshWhereWithRetry,
  type PwshWhereProbe,
} from "./helpers/pwsh-prerequisite";
import {
  WINDOWS_WHERE_RETRY_TIMEOUT_MS,
  WINDOWS_WHERE_TIMEOUT_MS,
} from "../src/background-shell/shell";

const ALWAYS_EXISTS = () => true;
const NEVER_EXISTS = () => false;

describe("classifyPwshLookup: present outcomes (#406)", () => {
  it("classifies a clean where hit as present with the first reported path", () => {
    const probe: PwshWhereProbe = { status: 0, stdout: "C:\\Program Files\\PowerShell\\7\\pwsh.exe\r\n" };
    expect(classifyPwshLookup(probe, ALWAYS_EXISTS), "present").toEqual({
      kind: "present",
      path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    });
  });

  it("takes the first of several reported paths", () => {
    const probe: PwshWhereProbe = {
      status: 0,
      stdout: "C:\\first\\pwsh.exe\nC:\\second\\pwsh.exe\n",
    };
    expect(classifyPwshLookup(probe, ALWAYS_EXISTS), "first path wins").toEqual({
      kind: "present",
      path: "C:\\first\\pwsh.exe",
    });
  });

  it("rejects a reported path that does not exist", () => {
    const probe: PwshWhereProbe = { status: 0, stdout: "C:\\gone\\pwsh.exe\n" };
    const result = classifyPwshLookup(probe, NEVER_EXISTS);
    expect(result.kind, "kind").toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toContain("does not exist");
    }
  });
});

describe("classifyPwshLookup: verified absence (#406)", () => {
  it("classifies where's not-found exit as verified absent", () => {
    expect(classifyPwshLookup({ status: 1, stdout: "" }, ALWAYS_EXISTS), "absent").toEqual({ kind: "absent" });
  });

  it("treats a not-found exit that still reports paths as malformed", () => {
    const result = classifyPwshLookup(
      { status: 1, stdout: "C:\\odd\\pwsh.exe\n" },
      ALWAYS_EXISTS,
    );
    expect(result.kind, "kind").toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toContain("exited 1 but reported paths");
    }
  });
});

describe("classifyPwshLookup: failed, timed-out, and malformed lookups never skip (#406)", () => {
  it("classifies a spawn failure as an error", () => {
    const result = classifyPwshLookup(
      { error: new Error("spawn where ENOENT"), status: null, stdout: "" },
      ALWAYS_EXISTS,
    );
    expect(result.kind, "kind").toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toContain("failed to run");
    }
  });

  it("classifies a timeout as an error", () => {
    const err = new Error("spawnSync where ETIMEDOUT") as NodeJS.ErrnoException;
    err.code = "ETIMEDOUT";
    const result = classifyPwshLookup({ error: err, status: null, stdout: "" }, ALWAYS_EXISTS);
    expect(result.kind, "kind").toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toContain("timed out");
    }
  });

  it("classifies a missing exit status as an error", () => {
    const result = classifyPwshLookup({ status: null, stdout: "" }, ALWAYS_EXISTS);
    expect(result.kind, "kind").toBe("error");
  });

  it("classifies a success exit with no reported path as malformed", () => {
    const result = classifyPwshLookup({ status: 0, stdout: "   \n" }, ALWAYS_EXISTS);
    expect(result.kind, "kind").toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toContain("reported no path");
    }
  });

  it("classifies a reported non-pwsh.exe path as malformed", () => {
    const result = classifyPwshLookup(
      { status: 0, stdout: "C:\\odd\\powershell.exe\n" },
      ALWAYS_EXISTS,
    );
    expect(result.kind, "kind").toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toContain("non-pwsh.exe path");
    }
  });

  it("classifies an unexpected exit status as an error", () => {
    const result = classifyPwshLookup({ status: 2, stdout: "" }, ALWAYS_EXISTS);
    expect(result.kind, "kind").toBe("error");
    if (result.kind === "error") {
      expect(result.reason).toContain("unexpected status 2");
    }
  });
});

describe("probePwshPrerequisite: injectable runner (#406)", () => {
  it("delegates to the injected runner", () => {
    // The probe's default existence check stays real (accessSync F_OK), so the
    // present case reports a file that genuinely exists. The environment is
    // isolated so a host's own %ProgramFiles%\PowerShell\7\pwsh.exe cannot turn
    // the simulated absence or error into present (#405).
    const deps = { env: {} };
    const dir = mkdtempSync(join(tmpdir(), "pi-review-pwsh-probe-"));
    try {
      const fakePwsh = join(dir, "pwsh.exe");
      writeFileSync(fakePwsh, "");
      const present = probePwshPrerequisite(() => ({ status: 0, stdout: `${fakePwsh}\n` }), deps);
      expect(present.kind, "present").toBe("present");

      const absent = probePwshPrerequisite(() => ({ status: 1, stdout: "" }), deps);
      expect(absent, "absent").toEqual({ kind: "absent" });

      const failed = probePwshPrerequisite(() => ({
        error: new Error("spawn where ENOENT"),
        status: null,
        stdout: "",
      }), deps);
      expect(failed.kind, "error").toBe("error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const PWSH7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

function etimedout(): NodeJS.ErrnoException {
  const error = new Error("spawnSync where ETIMEDOUT") as NodeJS.ErrnoException;
  error.code = "ETIMEDOUT";
  return error;
}

describe("runPwshWhereWithRetry: production's single where timeout retry (#405)", () => {
  it("retries a timed-out lookup once with the longer bound", () => {
    const bounds: number[] = [];
    const probe = runPwshWhereWithRetry((timeoutMs) => {
      bounds.push(timeoutMs);
      return bounds.length === 1
        ? { error: etimedout(), status: null, stdout: "" }
        : { status: 0, stdout: `${PWSH7}\r\n` };
    });
    expect(bounds, "the Pi bound then the longer retry bound").toEqual([
      WINDOWS_WHERE_TIMEOUT_MS, WINDOWS_WHERE_RETRY_TIMEOUT_MS,
    ]);
    expect(probe.status, "the retry answered").toBe(0);
  });

  it("never retries a third time", () => {
    const bounds: number[] = [];
    const probe = runPwshWhereWithRetry((timeoutMs) => {
      bounds.push(timeoutMs);
      return { error: etimedout(), status: null, stdout: "" };
    });
    expect(bounds.length, "exactly two lookups").toBe(2);
    expect(probe.error?.code, "the observed timeout is reported, not swallowed").toBe("ETIMEDOUT");
  });

  it("does not retry a verified absence or a non-timeout spawn error", () => {
    const absence: number[] = [];
    runPwshWhereWithRetry((timeoutMs) => {
      absence.push(timeoutMs);
      return { status: 1, stdout: "" };
    });
    expect(absence, "one lookup").toEqual([WINDOWS_WHERE_TIMEOUT_MS]);

    const spawnFailure: number[] = [];
    runPwshWhereWithRetry((timeoutMs) => {
      spawnFailure.push(timeoutMs);
      return { error: new Error("spawn where ENOENT") as NodeJS.ErrnoException, status: null, stdout: "" };
    });
    expect(spawnFailure, "one lookup").toEqual([WINDOWS_WHERE_TIMEOUT_MS]);
  });
});

describe("probePwshPrerequisite: the PowerShell 7 install-location fallback (#405)", () => {
  it("builds the candidate from ProgramFiles with Windows separators, or none", () => {
    expect(pwsh7ProgramFilesPath({ ProgramFiles: "C:\\Program Files" }), "Windows separators").toBe(PWSH7);
    expect(pwsh7ProgramFilesPath({}), "unset ProgramFiles has no candidate").toBeNull();
  });

  it("reports present when where missed but the install location exists", () => {
    const result = probePwshPrerequisite(
      () => ({ status: 1, stdout: "" }),
      { env: { ProgramFiles: "C:\\Program Files" }, pathExists: (path) => path === PWSH7 },
    );
    expect(result, "production would launch this PowerShell 7").toEqual({ kind: "present", path: PWSH7 });
  });

  it("also reports present when the lookup errored but the install location exists", () => {
    const result = probePwshPrerequisite(
      () => ({ error: etimedout(), status: null, stdout: "" }),
      { env: { ProgramFiles: "C:\\Program Files" }, pathExists: (path) => path === PWSH7 },
    );
    expect(result, "the prerequisite is genuinely met").toEqual({ kind: "present", path: PWSH7 });
  });

  it("keeps verified absence when ProgramFiles is unset or the file does not exist", () => {
    const unset = probePwshPrerequisite(() => ({ status: 1, stdout: "" }), {
      env: {},
      pathExists: (path) => path === PWSH7,
    });
    expect(unset, "no candidate to check").toEqual({ kind: "absent" });

    const missing = probePwshPrerequisite(() => ({ status: 1, stdout: "" }), {
      env: { ProgramFiles: "C:\\Program Files" },
      pathExists: () => false,
    });
    expect(missing, "candidate does not exist").toEqual({ kind: "absent" });
  });

  it("keeps the classifier's own verdict when the lookup errored and no fallback exists", () => {
    const result = probePwshPrerequisite(() => ({ error: etimedout(), status: null, stdout: "" }), { env: {} });
    expect(result.kind, "a failed lookup is never a skip").toBe("error");
  });

  it("rejects an install-location candidate that does not exist under the default rule", () => {
    // No injected existence check: the default accessSync rule must refuse a
    // %ProgramFiles% tree that holds no pwsh.exe, keeping verified absence.
    const dir = mkdtempSync(join(tmpdir(), "pi-review-pwsh-prereq-fb-"));
    try {
      const result = probePwshPrerequisite(() => ({ status: 1, stdout: "" }), { env: { ProgramFiles: dir } });
      expect(result, "nothing exists under that root").toEqual({ kind: "absent" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolvePwshPrerequisite: PI_REVIEW_GATE_REQUIRE_PWSH (#405)", () => {
  it("lets a present prerequisite continue without skipping", () => {
    let skips = 0;
    expect(resolvePwshPrerequisite({ kind: "present", path: PWSH7 }, () => { skips += 1; }, {}), "continue").toBe(true);
    expect(skips, "no skip").toBe(0);
  });

  it("skips a verified absence when the requirement is not set", () => {
    const reasons: Array<string | undefined> = [];
    expect(resolvePwshPrerequisite({ kind: "absent" }, (message) => { reasons.push(message); }, {}), "stop the test").toBe(false);
    expect(reasons.length, "the optional skip was taken").toBe(1);
    expect(String(reasons[0]), "truthful reason").toContain("PowerShell 7");
  });

  it("fails a verified absence when PI_REVIEW_GATE_REQUIRE_PWSH is exactly 1", () => {
    let skips = 0;
    let message = "";
    try {
      resolvePwshPrerequisite({ kind: "absent" }, () => { skips += 1; }, { PI_REVIEW_GATE_REQUIRE_PWSH: "1" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message, "the required prerequisite fails rather than skipping").toContain("PI_REVIEW_GATE_REQUIRE_PWSH=1");
    expect(message).toContain("PowerShell 7");
    expect(skips, "no skip is taken").toBe(0);
  });

  for (const value of ["0", "true", ""]) {
    it(`treats PI_REVIEW_GATE_REQUIRE_PWSH="${value}" as optional`, () => {
      let skips = 0;
      expect(
        resolvePwshPrerequisite({ kind: "absent" }, () => { skips += 1; }, { PI_REVIEW_GATE_REQUIRE_PWSH: value }),
        "optional skip stays available",
      ).toBe(false);
      expect(skips, "the skip was taken").toBe(1);
    });
  }

  it("always fails an error outcome, required or optional", () => {
    for (const env of [{}, { PI_REVIEW_GATE_REQUIRE_PWSH: "1" }]) {
      let message = "";
      try {
        resolvePwshPrerequisite(
          { kind: "error", reason: "where pwsh.exe timed out" },
          () => { throw new Error("must not skip an error"); },
          env,
        );
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, "lookup diagnostics are reported").toContain("where pwsh.exe timed out");
    }
  });
});
