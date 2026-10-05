import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applicationCommandAvailable, collectExternalAgentAvailabilityWarnings, validateSelection } from "../src/settings/validation";
import { normalizeConfig } from "../src/config";

async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "settings-cli-availability-"));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function executable(path: string): Promise<void> {
  // Only filesystem availability is inspected; no command is ever launched.
  await writeFile(path, "not invoked\n");
  await chmod(path, 0o755);
}

test("application availability rejects missing paths and directories, and accepts regular executables", async () => {
  await fixture(async (directory) => {
    const command = join(directory, "claude");
    assert.equal(await applicationCommandAvailable(command), false);
    await mkdir(command);
    assert.equal(await applicationCommandAvailable(command), false);
    await rm(command, { recursive: true });
    await executable(command);
    assert.equal(await applicationCommandAvailable(command), true);
    assert.equal(await applicationCommandAvailable("claude", { PATH: directory }, "darwin"), true);
    assert.equal(await applicationCommandAvailable("codex", { PATH: directory }, "darwin"), false);
    if (process.platform !== "win32") {
      await chmod(command, 0o644);
      assert.equal(await applicationCommandAvailable(command), false);
    }
  });
});

test("Windows application lookup recognizes installed cmd/exe names through PATH and PATHEXT", async () => {
  await fixture(async (directory) => {
    await executable(join(directory, "codex.cmd"));
    await executable(join(directory, "claude.exe"));
    const environment = { PATH: `${join(directory, "missing")};${directory}`, PATHEXT: ".EXE;.CMD" };
    assert.equal(await applicationCommandAvailable("codex", environment, "win32"), true);
    assert.equal(await applicationCommandAvailable("claude", environment, "win32"), true);
    assert.equal(await applicationCommandAvailable("codex.cmd", environment, "win32"), true);
    assert.equal(await applicationCommandAvailable("codex", { ...environment, PATHEXT: ".EXE" }, "win32"), false);
    assert.equal(await applicationCommandAvailable("codex", { PATH: directory }, "win32"), true);
    assert.equal(await applicationCommandAvailable("codex", { Path: directory, PathExt: ".CMD" }, "win32"), true);
    assert.equal(await applicationCommandAvailable("codex", { PATH: "", Path: directory, PATHEXT: ".CMD" }, "win32"), false);
    assert.equal(await applicationCommandAvailable(join(directory, "claude"), environment, "win32"), true);
    assert.equal(await applicationCommandAvailable("codex", { PATH: "" }, "win32"), false);
  });
});

test("application warnings honor shared and role-specific PATH overrides", async () => {
  await fixture(async (directory) => {
    await executable(join(directory, "codex"));
    // Windows uses an executable suffix for PATH lookup.
    await executable(join(directory, "codex.exe"));
    const config = normalizeConfig({ enabled: true, externalAgents: {
      worker: { adapter: "codex-cli", env: { PATH: directory }, execution: {}, review: { env: { PATH: directory } } },
    } });
    const policy = { allowMissingApplicationCli: true, warnings: new Set<string>() };
    await collectExternalAgentAvailabilityWarnings(config, policy);
    assert.equal(policy.warnings.size, 0);
    assert.equal(await validateSelection({ worker: { selection: { source: "external", id: "worker" }, maxConcurrent: 1 } },
      [{ source: "external", id: "worker" }], config, [], [], [], policy), undefined);
    assert.equal(policy.warnings.size, 0);
    config.externalAgents!.worker.review!.env = { PATH: "" };
    await collectExternalAgentAvailabilityWarnings(config, policy);
    assert.equal(policy.warnings.size, 1);
  });
});
