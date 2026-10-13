/*
 * Focused regression for the optional PowerShell 7 (pwsh.exe) prerequisite
 * probe (#406). The two pwsh-specific native Windows ShellStart cases run
 * only when pwsh.exe is genuinely on PATH: a verified absence must skip them
 * with a truthful reason, while a failed, timed-out, or malformed lookup must
 * fail with diagnostics instead of masquerading as absence.
 *
 * The probe's lookup runner and existence check are injectable, so these
 * cases exercise every outcome deterministically on any platform — no real
 * `where` and no installed PowerShell required. Production discovery
 * (findWindowsExecutable) is unchanged; the probe only decides whether the
 * optional prerequisite is met.
 */
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect } from "./helpers/expect";
import { classifyPwshLookup, probePwshPrerequisite, type PwshWhereProbe } from "./helpers/pwsh-prerequisite";

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
    // The probe's default existence check is the real existsSync, so the
    // present case reports a file that genuinely exists.
    const dir = mkdtempSync(join(tmpdir(), "pi-review-pwsh-probe-"));
    try {
      const fakePwsh = join(dir, "pwsh.exe");
      writeFileSync(fakePwsh, "");
      const present = probePwshPrerequisite(() => ({ status: 0, stdout: `${fakePwsh}\n` }));
      expect(present.kind, "present").toBe("present");

      const absent = probePwshPrerequisite(() => ({ status: 1, stdout: "" }));
      expect(absent, "absent").toEqual({ kind: "absent" });

      const failed = probePwshPrerequisite(() => ({
        error: new Error("spawn where ENOENT"),
        status: null,
        stdout: "",
      }));
      expect(failed.kind, "error").toBe("error");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
