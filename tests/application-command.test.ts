import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveApplicationCommand } from "../src/application-command";
import { applicationCommandAvailable } from "../src/settings/validation";

/**
 * The single shared application-command resolver (issue #277) behind both the
 * settings availability probe and the native interactive CLI launch
 * descriptors. These tests pin the discovery semantics the probe already had
 * (explicit path, PATH order, empty entries, PATHEXT, Windows case handling,
 * regular-file + execute evidence) and prove the two entry points agree.
 * Nothing here launches a command: only filesystem evidence is inspected.
 */
async function fixture(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "application-command-")));
  try { await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function executable(path: string): Promise<void> {
  await writeFile(path, "not invoked\n");
  await chmod(path, 0o755);
}

/**
 * What the resolver actually selected, canonicalized: an anchored hit keeps the
 * caller's spelling with the base prefixed, so identity is compared through the
 * filesystem rather than the string.
 */
async function selected(
  command: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cwd?: string,
): Promise<string | undefined> {
  const located = await resolveApplicationCommand(command, environment, platform, cwd);
  return located === undefined ? undefined : await realpath(located);
}

test("resolveApplicationCommand returns the exact located file, or nothing at all", async () => {
  await fixture(async (directory) => {
    const command = join(directory, "claude");
    assert.equal(await resolveApplicationCommand(command), undefined);
    await mkdir(command);
    assert.equal(await resolveApplicationCommand(command), undefined);
    await rm(command, { recursive: true });
    await executable(command);
    assert.equal(await resolveApplicationCommand(command), command);
    if (process.platform !== "win32") {
      await chmod(command, 0o644);
      assert.equal(await resolveApplicationCommand(command), undefined);
    }
  });
});

test("PATH discovery keeps first-match order, skips empty entries, and never re-searches for an explicit path", async () => {
  await fixture(async (directory) => {
    const first = join(directory, "bin1");
    const second = join(directory, "bin2");
    await mkdir(first);
    await mkdir(second);
    await executable(join(first, "codex"));
    await executable(join(second, "codex"));
    assert.equal(await resolveApplicationCommand("codex", { PATH: `${first}:${second}` }, "linux"), join(first, "codex"));
    assert.equal(await resolveApplicationCommand("codex", { PATH: `${second}:${first}` }, "linux"), join(second, "codex"));
    // An empty PATH entry would mean the current directory: never searched.
    assert.equal(await resolveApplicationCommand("codex", { PATH: "" }, "linux"), undefined);
    // An explicit path is tested exactly as given; PATH is never consulted.
    assert.equal(await resolveApplicationCommand(join(directory, "missing", "codex"), { PATH: first }, "linux"), undefined);
    assert.equal(await resolveApplicationCommand("./codex", { PATH: first }, "linux"), undefined);
  });
});

test("Windows discovery keeps PATHEXT and case-insensitive environment semantics", async () => {
  await fixture(async (directory) => {
    await executable(join(directory, "codex.cmd"));
    await executable(join(directory, "claude.exe"));
    const environment = { PATH: `${join(directory, "missing")};${directory}`, PATHEXT: ".EXE;.CMD" };
    assert.equal(await resolveApplicationCommand("codex", environment, "win32"), join(directory, "codex.cmd"));
    assert.equal(await resolveApplicationCommand("claude", environment, "win32"), join(directory, "claude.exe"));
    assert.equal(await resolveApplicationCommand("codex.cmd", environment, "win32"), join(directory, "codex.cmd"));
    assert.equal(await resolveApplicationCommand("codex", { ...environment, PATHEXT: ".EXE" }, "win32"), undefined);
    assert.equal(await resolveApplicationCommand("codex", { PATH: directory }, "win32"), join(directory, "codex.cmd"));
    assert.equal(await resolveApplicationCommand("codex", { Path: directory, PathExt: ".CMD" }, "win32"), join(directory, "codex.cmd"));
    assert.equal(await resolveApplicationCommand("codex", { PATH: "", Path: directory, PATHEXT: ".CMD" }, "win32"), undefined);
    assert.equal(await resolveApplicationCommand(join(directory, "claude"), environment, "win32"), join(directory, "claude.exe"));
    assert.equal(await resolveApplicationCommand("codex", { PATH: "" }, "win32"), undefined);
  });
});

test("a supplied base directory anchors relative discovery to the run directory", async () => {
  await fixture(async (directory) => {
    // Two workspaces carry the SAME relative spellings. Neither exists beside
    // the calling process, so an anchored hit can only come from the base.
    const first = join(directory, "workspace one");
    const second = join(directory, "workspace two");
    await mkdir(join(first, "bin"), { recursive: true });
    await mkdir(join(second, "bin"), { recursive: true });
    await executable(join(first, "wrapper"));
    await executable(join(second, "wrapper"));
    await executable(join(first, "bin", "claude"));
    await executable(join(second, "bin", "claude"));
    // Unanchored (the settings availability probe) stays exactly as it was.
    assert.equal(await resolveApplicationCommand("./wrapper", {}, "linux"), undefined);
    assert.equal(await resolveApplicationCommand("claude", { PATH: "bin" }, "linux"), undefined);
    // Anchored: each base resolves its own file, exactly as
    // `spawn(command, args, { cwd })` resolves it.
    assert.equal(await selected("./wrapper", {}, "linux", first), join(first, "wrapper"));
    assert.equal(await selected("./wrapper", {}, "linux", second), join(second, "wrapper"));
    assert.equal(await selected("claude", { PATH: "bin" }, "linux", first), join(first, "bin", "claude"));
    assert.equal(await selected("claude", { PATH: "bin" }, "linux", second), join(second, "bin", "claude"));
    // A relative entry keeps its PATH precedence against an absolute one, and
    // anchoring never reorders the search.
    assert.equal(await selected("claude", { PATH: `bin:${join(second, "bin")}` }, "linux", first), join(first, "bin", "claude"));
    assert.equal(await selected("claude", { PATH: `${join(second, "bin")}:bin` }, "linux", first), join(second, "bin", "claude"));
    // An absolute spelling is never rewritten by the base, and stays exact.
    assert.equal(await resolveApplicationCommand(join(second, "wrapper"), {}, "linux", first), join(second, "wrapper"));
    assert.equal(await resolveApplicationCommand(join(first, "bin", "claude"), { PATH: "bin" }, "linux", second), join(first, "bin", "claude"));
  });
});

test("anchoring keeps a '..' that belongs to a symlinked directory for the filesystem", async () => {
  await fixture(async (directory) => {
    // workspace/link -> other/subdir, and only `other/` carries a wrapper.
    // `spawn("./link/../wrapper", { cwd: workspace })` therefore reads
    // other/wrapper, because that `..` is subdir's parent, not workspace's.
    const other = join(directory, "other");
    await mkdir(join(other, "subdir"), { recursive: true });
    await executable(join(other, "wrapper"));
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    await symlink(join(other, "subdir"), join(workspace, "link"));
    assert.equal(await selected("./link/../wrapper", {}, "linux", workspace), join(other, "wrapper"),
      "a lexical collapse would look for workspace/wrapper instead of the file the spawn runs");
    // The same spelling resolves exactly as before with no base supplied.
    assert.equal(await resolveApplicationCommand("./link/../wrapper", {}, "linux"), undefined);
    // PATH construction preserves the symlink-dependent parent too. The decoy
    // below would be selected if the relative PATH entry were joined (and its
    // `..` collapsed) before the base was applied.
    await executable(join(workspace, "wrapper"));
    assert.equal(await selected("wrapper", { PATH: "link/.." }, "linux", workspace), join(other, "wrapper"));
    // Without a base the historical joined construction stays in force.
    assert.equal(await resolveApplicationCommand("wrapper", { PATH: "link/.." }, "linux"), undefined);
    // A relative PATH entry is prefixed the same component-preserving way, and a
    // base with a trailing separator still contributes exactly one separator.
    await mkdir(join(workspace, "bin"));
    await executable(join(workspace, "bin", "claude"));
    assert.equal(await selected("claude", { PATH: "bin" }, "linux", workspace), join(workspace, "bin", "claude"));
    assert.equal(await selected("claude", { PATH: "bin" }, "linux", `${workspace}/`), join(workspace, "bin", "claude"));
  });
});

test("the base directory anchors Windows relative discovery without rewriting absolute spellings", async () => {
  await fixture(async (directory) => {
    const workspace = join(directory, "workspace");
    await mkdir(join(workspace, "bin"), { recursive: true });
    await executable(join(workspace, "codex.cmd"));
    await executable(join(workspace, "bin", "claude.cmd"));
    assert.equal(await selected("./codex", {}, "win32", workspace), join(workspace, "codex.cmd"));
    assert.equal(await selected("claude", { PATH: "bin", PATHEXT: ".CMD" }, "win32", workspace), join(workspace, "bin", "claude.cmd"));
    // A drive-qualified command is absolute in the Windows convention, so the
    // base never prefixes it: the decoy file whose literal POSIX name is that
    // drive spelling stays unreachable.
    await executable(join(workspace, "C:\\codex"));
    assert.equal(await resolveApplicationCommand("C:\\codex", {}, "win32", workspace), undefined);
  });
});

test("the settings availability probe and the shared resolver never disagree", async () => {
  await fixture(async (directory) => {
    const bin = join(directory, "bin");
    await mkdir(bin);
    await executable(join(bin, "claude"));
    await writeFile(join(bin, "codex"), "not executable\n");
    await chmod(join(bin, "codex"), 0o644);
    const cases: Array<[string, NodeJS.ProcessEnv, NodeJS.Platform]> = [
      ["claude", { PATH: bin }, "darwin"],
      ["codex", { PATH: bin }, "darwin"],
      ["nothing", { PATH: bin }, "darwin"],
      ["codex", { PATH: bin }, "win32"],
      ["claude", { PATH: `${join(directory, "missing")};${bin}`, PATHEXT: ".EXE;.CMD" }, "win32"],
      [join(bin, "claude"), {}, "linux"],
      [join(bin, "codex"), {}, "linux"],
    ];
    for (const [command, environment, platform] of cases) {
      const located = await resolveApplicationCommand(command, environment, platform);
      assert.equal(await applicationCommandAvailable(command, environment, platform), located !== undefined, `disagreement for ${command}`);
    }
  });
});
