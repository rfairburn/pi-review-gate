import assert from "node:assert/strict";
import { readdirSync, rmSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, win32 } from "node:path";
import test from "node:test";
import { isWindowsRootRelative, isWindowsUncPath, qualifyWindowsRootRelative, resolveApplicationCommand, windowsVolumeOf } from "../src/application-command";
import {
  CliLaunchError,
  isCliLaunchError,
  prepareProviderCliSpawn,
  type ProviderCliName,
} from "../src/cli-launch-preparation";
import { runPromptProcess } from "../src/adapters/process";
import { normalizeConfig, type ExternalAgentConfig, type ReviewGateConfig } from "../src/config";
import { createWorkspaceSnapshot } from "../src/capture";
import { runReview } from "../src/review";
import { createNativeCliLauncher } from "../src/session-host/native-cli-launch";
import { agentCatalog, fakeNeedsChangesConfig } from "./helpers";

/**
 * Shared Claude/Codex launch preparation (#682/#756).
 *
 * Windows cases are simulated by platform and environment injection, with the
 * shipped launcher's trusted cmd.exe resolver observed through the same module
 * instance the preparation requires; nothing claims Windows runtime coverage
 * except the conditional real-Windows test, which runs only on win32. POSIX
 * direct spawns run real `/bin/sh` fixtures. No real provider CLI runs.
 */
const helperModule = require(resolve("scripts/pi-review-gate-launcher.cjs")) as {
  cmdQuote: (arg: string) => string;
  resolveTrustedWindowsCmd: (parentEnvironment?: NodeJS.ProcessEnv) => string | null;
};

const PROVIDERS: readonly ProviderCliName[] = ["claude", "codex"];
const TRUSTED_CMD = "Z:\\Fixture Windows Root\\System32\\cmd.exe";
const PARENT_ENVIRONMENT: NodeJS.ProcessEnv = { SystemRoot: "Z:\\Fixture Windows Root" };

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cli-launch-prep-")));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function executable(path: string, content = "#!/bin/sh\necho never invoked\n"): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

/** The npm global-install layout: an extensionless POSIX shell shim beside the native shims. */
async function npmShimLayout(bin: string, provider: ProviderCliName, native: ".cmd" | ".exe"): Promise<void> {
  await executable(join(bin, provider), "#!/bin/sh\nexec node \"$basedir/node_modules/x/cli.js\" \"$@\"\n");
  await executable(join(bin, `${provider}${native}`), "@echo off\r\n");
  await executable(join(bin, `${provider}.ps1`), "# powershell shim\n");
}

async function withTrustedCmd<T>(resolved: string | null, run: (received: Array<NodeJS.ProcessEnv | undefined>) => Promise<T>): Promise<T> {
  const shipped = helperModule.resolveTrustedWindowsCmd;
  const received: Array<NodeJS.ProcessEnv | undefined> = [];
  helperModule.resolveTrustedWindowsCmd = (parentEnvironment?: NodeJS.ProcessEnv) => {
    received.push(parentEnvironment);
    return resolved;
  };
  try { return await run(received); } finally { helperModule.resolveTrustedWindowsCmd = shipped; }
}

test("Windows bare discovery selects the native PATHEXT shim, never the extensionless npm shell shim, for both providers", async () => {
  await fixture(async (root) => {
    const bin = join(root, "bin");
    await mkdir(bin);
    await npmShimLayout(bin, "codex", ".cmd");
    await npmShimLayout(bin, "claude", ".exe");
    for (const env of [{ PATH: bin }, { Path: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" }]) {
      assert.equal(await resolveApplicationCommand("codex", env, "win32"), join(bin, "codex.cmd"));
      assert.equal(await resolveApplicationCommand("claude", env, "win32"), join(bin, "claude.exe"));
      // The cwd-anchored launch spelling agrees.
      assert.equal(await resolveApplicationCommand("codex", env, "win32", root), join(bin, "codex.cmd"));
    }
    // Only the extensionless shim on PATH: nothing native is launchable.
    const onlyShim = join(root, "only-shim");
    await mkdir(onlyShim);
    await executable(join(onlyShim, "codex"));
    assert.equal(await resolveApplicationCommand("codex", { PATH: onlyShim }, "win32"), undefined);
    // An explicit path is honored exactly as given, even extensionless.
    assert.equal(await resolveApplicationCommand(join(bin, "codex"), { PATH: "" }, "win32"), join(bin, "codex"));
    // (Anchoring prefixes the run directory without collapsing components.)
    assert.equal(await resolveApplicationCommand("./bin/codex", {}, "win32", root), `${root}${sep}./bin/codex`);
    // An explicit extensionless spelling with no such file still tries PATHEXT.
    assert.equal(await resolveApplicationCommand(join(onlyShim, "claude"), {}, "win32"), undefined);
    // POSIX discovery is unchanged: the extensionless file is the executable.
    assert.equal(await resolveApplicationCommand("codex", { PATH: bin }, "linux"), join(bin, "codex"));
    assert.equal(await resolveApplicationCommand("claude", { PATH: bin }, "darwin"), join(bin, "claude"));
  });
});

test("Windows provider preparation renders a .cmd shim through the trusted cmd.exe and a native .exe directly, for both providers", async () => {
  await fixture(async (root) => {
    const bin = join(root, "bin");
    await mkdir(bin);
    for (const provider of PROVIDERS) {
      await npmShimLayout(bin, provider, ".cmd");
      await executable(join(root, `${provider}.exe`), "MZ");
    }
    await withTrustedCmd(TRUSTED_CMD, async (received) => {
      for (const provider of PROVIDERS) {
        const args = ["--print", "two words", "-c", "a\"b"];
        const env = { PATH: bin, ComSpec: join(bin, "evil-cmd.exe"), KEEP: "1" };
        const batch = await prepareProviderCliSpawn({
          provider, command: provider, args, env, cwd: root, platform: "win32", parentEnvironment: PARENT_ENVIRONMENT,
        });
        assert.equal(batch.kind, "windows-batch");
        if (batch.kind !== "windows-batch") continue;
        assert.equal(batch.file, TRUSTED_CMD);
        assert.deepEqual(batch.args, []);
        assert.equal(batch.commandLine,
          `/d /s /v:off /c "${[join(bin, `${provider}.cmd`), ...args].map(helperModule.cmdQuote).join(" ")}"`);
        assert.equal(batch.env, env, "a percent-free batch launch keeps the child environment exactly");
        // Only the parent environment decides the interpreter; ComSpec is ignored.
        assert.deepEqual(received.at(-1), PARENT_ENVIRONMENT);

        // An explicit native executable path is honored as a direct spawn.
        const direct = await prepareProviderCliSpawn({
          provider, command: join(root, `${provider}.exe`), args, env, cwd: root, platform: "win32", parentEnvironment: PARENT_ENVIRONMENT,
        });
        assert.deepEqual(direct, { kind: "direct", file: join(root, `${provider}.exe`), args, env });

        // An explicit .cmd path renders through the same trusted batch path.
        const explicitBatch = await prepareProviderCliSpawn({
          provider, command: join(bin, `${provider}.cmd`), args: [], env, cwd: root, platform: "win32", parentEnvironment: PARENT_ENVIRONMENT,
        });
        assert.equal(explicitBatch.kind, "windows-batch");
      }
    });
  });
});

test("Windows batch percent delivery uses a case-insensitively free carrier and is cleared before the shim runs", async () => {
  await fixture(async (root) => {
    const bin = join(root, "bin");
    await mkdir(bin);
    await npmShimLayout(bin, "codex", ".cmd");
    await withTrustedCmd(TRUSTED_CMD, async () => {
      const env = { PATH: bin, prg_native_batch_pct_0: "operator-owned" };
      const prepared = await prepareProviderCliSpawn({
        provider: "codex", command: "codex", args: ["100%"], env, cwd: root, platform: "win32", parentEnvironment: PARENT_ENVIRONMENT,
      });
      assert.equal(prepared.kind, "windows-batch");
      if (prepared.kind !== "windows-batch") return;
      assert.equal(prepared.env.PRG_NATIVE_BATCH_PCT_1, "%");
      assert.equal(prepared.env.prg_native_batch_pct_0, "operator-owned", "an operator variable in any case spelling is never overwritten");
      assert.equal(prepared.env.PRG_NATIVE_BATCH_PCT_0, undefined);
      assert.match(prepared.commandLine, /^\/d \/s \/v:off \/c "set "PRG_NATIVE_BATCH_PCT_1=" & /u);
      assert.ok(prepared.commandLine.includes("100%PRG_NATIVE_BATCH_PCT_1%"));
      assert.equal((env as NodeJS.ProcessEnv).PRG_NATIVE_BATCH_PCT_1, undefined, "the caller's environment object is not mutated");
    });
  });
});

test("POSIX provider preparation renders the configured command unchanged as a direct argv spawn for both providers", async () => {
  await fixture(async (root) => {
    const bin = join(root, "bin");
    await mkdir(bin);
    for (const provider of PROVIDERS) {
      await executable(join(bin, provider));
      const args = ["exec", "two words", "$HOME", "*", "a\nb"];
      const env = { PATH: bin, KEEP: "1" };
      for (const platform of ["linux", "darwin"] as const) {
        const prepared = await prepareProviderCliSpawn({ provider, command: provider, args, env, cwd: root, platform });
        assert.deepEqual(prepared, { kind: "direct", file: provider, args, env });
      }
      // Direct spawn, not preparation, interprets the PATH and the spelling.
      const relative = await prepareProviderCliSpawn({ provider, command: provider, args: [], env: { PATH: "bin" }, cwd: root, platform: "linux" });
      assert.equal(relative.file, provider);
      const explicitRelative = await prepareProviderCliSpawn({ provider, command: "./bin/wrapper", args: [], env: {}, cwd: "relative", platform: "darwin" });
      assert.equal(explicitRelative.file, "./bin/wrapper");
    }
  });
});

test("provider preparation refuses shell command strings, missing CLIs, an untrusted cmd.exe, and unprintable batch arguments", async () => {
  await fixture(async (root) => {
    const bin = join(root, "bin");
    await mkdir(bin);
    await npmShimLayout(bin, "codex", ".cmd");
    await npmShimLayout(bin, "claude", ".cmd");
    for (const provider of PROVIDERS) {
      for (const platform of ["linux", "win32"] as const) {
        for (const command of [`${provider} --yolo`, `${provider}&calc`, `${provider};id`, "$(id)", `"${provider}"`]) {
          await assert.rejects(
            prepareProviderCliSpawn({ provider, command, args: [], env: { PATH: bin }, cwd: root, platform, parentEnvironment: PARENT_ENVIRONMENT }),
            (error: unknown) => isCliLaunchError(error) && /shell command string/u.test((error as Error).message),
          );
        }
      }
      const missing = join(root, "secret-location", provider);
      await assert.rejects(
        prepareProviderCliSpawn({ provider, command: missing, args: [], env: { PATH: bin }, cwd: root, platform: "win32" }),
        (error: unknown) => error instanceof CliLaunchError && error.provider === provider
          && /was not found/u.test(error.message) && !error.message.includes("secret-location"),
      );
      await withTrustedCmd(null, async () => {
        await assert.rejects(
          prepareProviderCliSpawn({ provider, command: provider, args: [], env: { PATH: bin }, cwd: root, platform: "win32", parentEnvironment: {} }),
          (error: unknown) => isCliLaunchError(error) && /cmd\.exe was not found/u.test((error as Error).message),
        );
      });
      await withTrustedCmd(TRUSTED_CMD, async () => {
        await assert.rejects(
          prepareProviderCliSpawn({ provider, command: provider, args: ["line\r\nbreak"], env: { PATH: bin }, cwd: root, platform: "win32", parentEnvironment: PARENT_ENVIRONMENT }),
          (error: unknown) => isCliLaunchError(error) && /not a printable string/u.test((error as Error).message),
        );
      });
    }
  });
});

test("native sidebar launches select the native Windows shim, not the npm shell shim, for both providers", async () => {
  await fixture(async (root) => {
    const bin = join(root, "bin");
    await mkdir(bin);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await npmShimLayout(bin, "codex", ".cmd");
    await npmShimLayout(bin, "claude", ".exe");
    await withTrustedCmd(TRUSTED_CMD, async () => {
      const launcher = createNativeCliLauncher(normalizeConfig({ enabled: true }), { platform: "win32", parentEnvironment: PARENT_ENVIRONMENT });
      const codex = await launcher("codex", { workspace, env: { PATH: bin } });
      assert.equal(codex.file, TRUSTED_CMD);
      assert.equal(codex.commandLine, `/d /s /v:off /c "${[join(bin, "codex.cmd"), "--no-daemon"].map(helperModule.cmdQuote).join(" ")}"`);
      const claude = await launcher("claude", { workspace, env: { PATH: bin } });
      assert.equal(claude.file, join(bin, "claude.exe"));
      assert.deepEqual(claude.args, []);
      assert.equal(claude.commandLine, undefined);

      // The owned Codex render seam renders both children through the same path.
      const owned = createNativeCliLauncher(normalizeConfig({ enabled: true }), {
        platform: "win32", parentEnvironment: PARENT_ENVIRONMENT, ownedCodexBackend: true,
      });
      const plan = (await owned("codex", { workspace, env: { PATH: bin } })).ownedCodex;
      assert.ok(plan);
      const control = ["app-server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token", "--ws-token-sha256", "a".repeat(64)];
      const backend = plan.renderBackend(control, { ...plan.backendEnv });
      assert.equal(backend.file, TRUSTED_CMD);
      assert.equal(backend.commandLine, `/d /s /v:off /c "${[join(bin, "codex.cmd"), ...control].map(helperModule.cmdQuote).join(" ")}"`);
    });
  });
});

test("a POSIX reviewer provider launch spawns the located file directly with exact argv, cwd, and environment", { skip: process.platform === "win32" }, async () => {
  await fixture(async (root) => {
    const bin = join(root, "bin");
    const workspace = join(root, "work space");
    await mkdir(bin);
    await mkdir(workspace);
    for (const provider of PROVIDERS) {
      await executable(join(bin, provider), [
        "#!/bin/sh",
        "printf 'cwd=%s\\n' \"$(pwd)\"",
        "printf 'keep=%s\\n' \"$KEEP\"",
        "for arg in \"$@\"; do printf 'arg=[%s]\\n' \"$arg\"; done",
        "cat",
        "",
      ].join("\n"));
      const output = await runPromptProcess({
        command: provider,
        args: ["two words", "$HOME", "*", "\"q\""],
        cwd: workspace,
        prompt: "prompt-on-stdin",
        timeoutMs: 15_000,
        env: { PATH: `${bin}:/usr/bin:/bin`, KEEP: "kept" },
        providerLaunch: provider,
      });
      assert.equal(output.code, 0);
      assert.equal(output.processSettlement, "confirmed");
      assert.equal(output.stdout, [
        `cwd=${workspace}`,
        "keep=kept",
        "arg=[two words]",
        "arg=[$HOME]",
        "arg=[*]",
        "arg=[\"q\"]",
        "prompt-on-stdin",
      ].join("\n"));
    }
  });
});

test("a reviewer provider launch that never produces a process rejects with a launch error; other callers keep their raw error", async () => {
  await fixture(async (root) => {
    const bin = join(root, "bin");
    await mkdir(bin);
    for (const provider of PROVIDERS) {
      // Not found: the direct spawn's own refusal on POSIX, preparation's on Windows.
      await assert.rejects(
        runPromptProcess({ command: join(root, "missing", provider), args: [], cwd: root, prompt: "", timeoutMs: 5_000, env: { PATH: bin }, providerLaunch: provider }),
        (error: unknown) => error instanceof CliLaunchError && error.provider === provider,
      );
      // Prepared, then refused by the operating system (the run directory is gone).
      await executable(join(bin, provider));
      await assert.rejects(
        runPromptProcess({ command: join(bin, provider), args: [], cwd: join(root, "no-such-cwd"), prompt: "", timeoutMs: 5_000, env: { PATH: bin }, providerLaunch: provider }),
        (error: unknown) => error instanceof CliLaunchError && /operating system refused to start the configured command/u.test((error as Error).message),
      );
    }
    // A caller that did not opt in keeps the established raw spawn rejection.
    await assert.rejects(
      runPromptProcess({ command: join(root, "missing", "generic"), args: [], cwd: root, prompt: "", timeoutMs: 5_000, env: { PATH: bin } }),
      (error: unknown) => !isCliLaunchError(error) && /ENOENT/u.test((error as Error).message),
    );
    await assert.rejects(
      runPromptProcess({ command: "codex", args: [], cwd: root, prompt: "", timeoutMs: 5_000, providerLaunch: "codex", resolveDefaultPi: true }),
      /mutually exclusive/u,
    );
  });
});

test("a cancellation that wins during provider discovery returns a confirmed abort and never starts the child", { skip: process.platform === "win32" }, async () => {
  await fixture(async (root) => {
    const bin = join(root, "bin");
    await mkdir(bin);
    for (const provider of PROVIDERS) {
      const marker = join(root, `${provider}-started`);
      await executable(join(bin, provider), "#!/bin/sh\n: > \"$MARKER\"\ncat\n");
      const controller = new AbortController();
      const started: number[] = [];
      // The entry check sees a live signal; runPromptProcess then suspends on
      // its preparation, and the abort lands before any spawn. The existing
      // late-abort path would still terminate a child spawned anyway, so the
      // proof is that no process was ever created, not merely that it stopped.
      const pending = runPromptProcess({
        command: provider, args: [], cwd: root, prompt: "", timeoutMs: 15_000,
        env: { PATH: `${bin}:/usr/bin:/bin`, MARKER: marker }, signal: controller.signal, providerLaunch: provider,
        onProcessStart: ({ pid }) => { started.push(pid); },
      });
      controller.abort("escape");
      const output = await pending;
      assert.deepEqual(started, [], "no provider process was created");
      assert.equal(output.aborted, true);
      assert.equal(output.processSettlement, "confirmed");
      assert.equal(output.code, null);
      await new Promise((settle) => setTimeout(settle, 200));
      assert.deepEqual((await readdir(root)).filter((name) => name.endsWith("-started")), [], "the canceled CLI never ran");

      // A preparation that ends in refusal (here a shell command string):
      // cancellation won, and no process could exist, so the outcome is the
      // same confirmed abort — not a launch error.
      const missingController = new AbortController();
      const missingStarted: number[] = [];
      const missing = runPromptProcess({
        command: `${provider} --yolo`, args: [], cwd: root, prompt: "", timeoutMs: 15_000,
        env: { PATH: bin }, signal: missingController.signal, providerLaunch: provider,
        onProcessStart: ({ pid }) => { missingStarted.push(pid); },
      });
      missingController.abort("escape");
      const missingOutput = await missing;
      assert.deepEqual(missingStarted, []);
      assert.equal(missingOutput.aborted, true);
      assert.equal(missingOutput.processSettlement, "confirmed");
      assert.equal(missingOutput.code, null);
    }
  });
});

test("a relative reviewer cwd spawns the same file a direct spawn in that cwd would, for a relative command, a relative PATH entry, and an empty PATH entry", { skip: process.platform === "win32" }, async () => {
  await fixture(async (root) => {
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "bin"), { recursive: true });
    // Decoys sit where a parent-relative located path would land once the
    // child's cwd is applied a second time.
    await mkdir(join(workspace, "workspace", "bin"), { recursive: true });
    const script = (label: string) => `#!/bin/sh\nprintf '${label}'\n`;
    // The wrapper reports the spelling it was started as: a direct spawn keeps
    // the configured relative command as argv[0].
    await executable(join(workspace, "wrapper"), "#!/bin/sh\nprintf '%s' \"$0\"\n");
    await executable(join(workspace, "workspace", "wrapper"), script("decoy"));
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      for (const provider of PROVIDERS) {
        await executable(join(workspace, "bin", provider), script(`path-${provider}`));
        await executable(join(workspace, "workspace", "bin", provider), script("decoy"));
        const explicit = await runPromptProcess({
          command: "./wrapper", args: [], cwd: "workspace", prompt: "", timeoutMs: 15_000,
          env: { PATH: "/usr/bin:/bin" }, providerLaunch: provider,
        });
        assert.equal(explicit.stdout, "./wrapper");
        // An unset PATH keeps Node's default Unix search path for the spawn.
        const defaultPath = await runPromptProcess({
          command: "sh", args: ["-c", "printf default-path"], cwd: "workspace", prompt: "", timeoutMs: 15_000,
          env: {}, providerLaunch: provider,
        });
        assert.equal(defaultPath.stdout, "default-path");
        const searched = await runPromptProcess({
          command: provider, args: [], cwd: "workspace", prompt: "", timeoutMs: 15_000,
          env: { PATH: "bin:/usr/bin:/bin" }, providerLaunch: provider,
        });
        assert.equal(searched.stdout, `path-${provider}`);

        // An empty POSIX PATH entry means the child's cwd, at that position, for
        // a direct spawn. The reviewer keeps that meaning: the cwd wrapper wins
        // over the later `bin` entry and over a same-named file in the parent's cwd.
        await executable(join(workspace, provider), script(`cwd-${provider}`));
        await executable(join(root, provider), script("parent-decoy"));
        const emptyEntry = { PATH: ":bin:/usr/bin:/bin" };
        const viaReviewer = await runPromptProcess({
          command: provider, args: [], cwd: "workspace", prompt: "", timeoutMs: 15_000, env: emptyEntry, providerLaunch: provider,
        });
        assert.equal(viaReviewer.stdout, `cwd-${provider}`);
        // Parity with the established direct spawn of the bare name.
        const viaDirectSpawn = await runPromptProcess({
          command: provider, args: [], cwd: "workspace", prompt: "", timeoutMs: 15_000, env: emptyEntry,
        });
        assert.equal(viaDirectSpawn.stdout, viaReviewer.stdout);
        // The native sidebar and settings probe defaults never search an empty entry.
        assert.equal(await resolveApplicationCommand(provider, emptyEntry, "linux", join(root, "workspace")), `${join(root, "workspace")}${sep}bin${sep}${provider}`);
        assert.equal(await resolveApplicationCommand(provider, { PATH: ":" }, "linux", join(root, "workspace")), undefined);
        assert.equal(await resolveApplicationCommand(provider, { PATH: ";" }, "win32", join(root, "workspace")), undefined, "Windows never searches an empty entry");
      }
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("a Windows bare name skips PATHEXT entries no launch can run, keeping PATHEXT order among the rest, for both npm layouts", async () => {
  await fixture(async (root) => {
    const bin = join(root, "bin");
    await mkdir(bin);
    await npmShimLayout(bin, "codex", ".cmd");
    await npmShimLayout(bin, "claude", ".exe");
    await executable(join(bin, "claude.cmd"), "@echo off\r\n");
    const env = { PATH: bin, PATHEXT: ".PS1;.JS;.CMD;.EXE" };
    assert.equal(await resolveApplicationCommand("codex", env, "win32"), join(bin, "codex.cmd"));
    // PATHEXT order still decides between two launchable candidates.
    assert.equal(await resolveApplicationCommand("claude", env, "win32"), join(bin, "claude.cmd"));
    assert.equal(await resolveApplicationCommand("claude", { PATH: bin, PATHEXT: ".PS1;.EXE;.CMD" }, "win32"), join(bin, "claude.exe"));
    // Only a .ps1 shim: nothing launchable is found by a bare name.
    const onlyPs1 = join(root, "only-ps1");
    await mkdir(onlyPs1);
    await executable(join(onlyPs1, "codex.ps1"), "# powershell\n");
    assert.equal(await resolveApplicationCommand("codex", { PATH: onlyPs1, PATHEXT: ".PS1;.CMD" }, "win32"), undefined);
    // Explicit-path handling is unchanged: it still tries every PATHEXT suffix.
    assert.equal(await resolveApplicationCommand(join(onlyPs1, "codex"), { PATHEXT: ".PS1;.CMD" }, "win32"), join(onlyPs1, "codex.ps1"));
    await withTrustedCmd(TRUSTED_CMD, async () => {
      const prepared = await prepareProviderCliSpawn({
        provider: "codex", command: "codex", args: [], env, cwd: root, platform: "win32", parentEnvironment: PARENT_ENVIRONMENT,
      });
      assert.equal(prepared.kind, "windows-batch");
      const claude = await prepareProviderCliSpawn({
        provider: "claude", command: "claude", args: [], env: { PATH: bin, PATHEXT: ".PS1;.EXE;.CMD" }, cwd: root, platform: "win32", parentEnvironment: PARENT_ENVIRONMENT,
      });
      assert.deepEqual(claude, { kind: "direct", file: join(bin, "claude.exe"), args: [], env: { PATH: bin, PATHEXT: ".PS1;.EXE;.CMD" } });
    });
  });
});

test("real Windows: a bare reviewer provider runs its .cmd shim beside the npm shell shim through the trusted cmd.exe", { skip: process.platform !== "win32" }, async () => {
  await fixture(async (root) => {
    const bin = join(root, "bin");
    await mkdir(bin);
    for (const provider of PROVIDERS) {
      // The extensionless shim would make Node fail outright; the .cmd echoes its argv.
      await writeFile(join(bin, provider), "#!/bin/sh\necho wrong shim\n");
      await writeFile(join(bin, `${provider}.cmd`), "@echo off\r\necho shim=%~nx0 %*\r\n");
      const output = await runPromptProcess({
        command: provider,
        args: ["two words", "100%"],
        cwd: root,
        prompt: "",
        timeoutMs: 30_000,
        env: { ...process.env, PATH: `${bin};${process.env.PATH ?? ""}` },
        providerLaunch: provider,
      });
      assert.equal(output.code, 0, output.stderr);
      assert.match(output.stdout, new RegExp(`shim=${provider}\\.cmd "two words" 100%`, "u"));
    }
  });
});

test("a Windows root-relative location takes the launch directory's drive or UNC share; every other spelling is preserved", () => {
  assert.equal(isWindowsRootRelative("\\tools\\codex.cmd"), true);
  assert.equal(isWindowsRootRelative("/tools/codex.cmd"), true);
  for (const notRootRelative of ["C:\\tools\\codex.cmd", "C:tools\\codex.cmd", "\\\\server\\share\\codex.cmd", "//server/share/codex.cmd", "tools\\codex.cmd", ".\\codex.cmd", "codex"]) {
    assert.equal(isWindowsRootRelative(notRootRelative), false, notRootRelative);
  }
  // Qualified with the run directory's volume, the location text otherwise kept exactly.
  assert.equal(qualifyWindowsRootRelative("\\tools\\codex.cmd", "C:\\work"), "C:\\tools\\codex.cmd");
  assert.equal(qualifyWindowsRootRelative("\\tools\\codex.cmd", "d:\\"), "d:\\tools\\codex.cmd");
  assert.equal(qualifyWindowsRootRelative("/tools/claude.cmd", "E:/work/sub"), "E:/tools/claude.cmd");
  assert.equal(qualifyWindowsRootRelative("\\tools\\codex.cmd", "\\\\server\\share\\work"), "\\\\server\\share\\tools\\codex.cmd");
  assert.equal(qualifyWindowsRootRelative("\\tools\\codex.cmd", "\\\\server\\share"), "\\\\server\\share\\tools\\codex.cmd");
  // Fully qualified, UNC, drive-relative, and relative spellings are preserved.
  for (const preserved of ["C:\\tools\\codex.cmd", "\\\\other\\share\\codex.cmd", "C:tools\\codex.cmd", "tools\\codex.cmd", ".\\codex"]) {
    assert.equal(qualifyWindowsRootRelative(preserved, "D:\\work"), preserved, preserved);
  }
  // Namespaced volumes keep their real server and share (or drive), and receive
  // the location with `\` separators, since `/` is no separator after `\\?\`.
  assert.equal(qualifyWindowsRootRelative("\\tools\\codex.cmd", "\\\\?\\UNC\\server\\share\\work"), "\\\\?\\UNC\\server\\share\\tools\\codex.cmd");
  assert.equal(qualifyWindowsRootRelative("/tools/codex.cmd", "\\\\?\\unc\\server\\share"), "\\\\?\\unc\\server\\share\\tools\\codex.cmd");
  assert.equal(qualifyWindowsRootRelative("/tools/claude.cmd", "\\\\?\\C:\\work"), "\\\\?\\C:\\tools\\claude.cmd");
  assert.deepEqual(windowsVolumeOf("\\\\?\\UNC\\server\\share\\work"), { prefix: "\\\\?\\UNC\\server\\share", namespaced: true, unc: true });
  assert.deepEqual(windowsVolumeOf("\\\\server\\share\\work"), { prefix: "\\\\server\\share", namespaced: false, unc: true });
  assert.deepEqual(windowsVolumeOf("C:\\work"), { prefix: "C:", namespaced: false, unc: false });
  // A device or volume-GUID namespace is not a share and lends nothing.
  assert.equal(windowsVolumeOf("\\\\?\\Volume{0d8e2f4a-0000-0000-0000-100000000000}\\work"), undefined);
  assert.equal(qualifyWindowsRootRelative("\\tools\\codex.cmd", "\\\\.\\pipe\\x"), "\\tools\\codex.cmd");
  for (const unc of ["\\\\server\\share\\work", "//server/share", "\\\\?\\UNC\\server\\share\\work"]) assert.equal(isWindowsUncPath(unc), true, unc);
  // A run of separators between server and share names the same UNC location.
  assert.equal(win32.normalize("//server//share/work"), win32.normalize("//server/share/work"));
  for (const repeated of ["//server//share/work", "\\\\server\\\\\\share\\work"]) assert.equal(isWindowsUncPath(repeated), true, repeated);
  assert.equal(qualifyWindowsRootRelative("/tools/codex.cmd", "//server//share/work"), "//server//share/tools/codex.cmd");
  assert.equal(qualifyWindowsRootRelative("\\tools\\claude.cmd", "\\\\server\\\\\\share\\work"), "\\\\server\\\\\\share\\tools\\claude.cmd");
  for (const local of ["C:\\work", "\\\\?\\C:\\work", "\\work", "work"]) assert.equal(isWindowsUncPath(local), false, local);
  // A run directory naming no drive or share has no volume to lend.
  for (const volumeless of ["\\work", "/var/tmp/work", "work"]) {
    assert.equal(qualifyWindowsRootRelative("\\tools\\codex.cmd", volumeless), "\\tools\\codex.cmd", volumeless);
  }
});

test("simulated Windows discovery qualifies an explicit or PATH root-relative shim before stat and rendering, for both providers", { skip: process.platform === "win32" }, async () => {
  // On a POSIX host a backslash is an ordinary filename character, so a
  // Windows path such as `C:\tools\codex.cmd` is ONE relative filename in the
  // process cwd. Fixtures with those literal names make the qualified (and the
  // unqualified) spellings observable to the real stat/access checks.
  await fixture(async (root) => {
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      for (const provider of PROVIDERS) {
        await executable(join(root, `C:\\tools\\${provider}.cmd`), "@echo off\r\n");
        await executable(join(root, `\\\\server\\share\\tools\\${provider}.cmd`), "@echo off\r\n");
        await executable(join(root, `\\tools\\${provider}.cmd`), "@echo off\r\n");
        await mkdir(join(root, "C:\\tools"), { recursive: true });
        await executable(join(root, "C:\\tools", `${provider}.cmd`), "@echo off\r\n");
        const explicit = `\\tools\\${provider}.cmd`;
        // Explicit shim form: fully qualified with the launch cwd's drive or share.
        assert.equal(await resolveApplicationCommand(explicit, {}, "win32", "C:\\work"), `C:\\tools\\${provider}.cmd`);
        assert.equal(await resolveApplicationCommand(explicit, {}, "win32", "\\\\server\\share\\work"), `\\\\server\\share\\tools\\${provider}.cmd`);
        // A namespaced UNC cwd keeps its server and share, for the explicit form
        // and for a root-relative PATH entry (whose host-separator joint is
        // spelled `\` once it is under a namespaced volume).
        const namespacedCwd = "\\\\?\\UNC\\server\\share\\work";
        const namespacedShim = `\\\\?\\UNC\\server\\share\\tools\\${provider}.cmd`;
        await executable(join(root, namespacedShim), "@echo off\r\n");
        assert.equal(await resolveApplicationCommand(explicit, {}, "win32", namespacedCwd), namespacedShim);
        assert.equal(await resolveApplicationCommand(provider, { PATH: "\\tools" }, "win32", namespacedCwd), namespacedShim);
        // PATH form: the root-relative entry is qualified the same way (the
        // entry/name joint is this host's separator, as for every PATH entry).
        assert.equal(await resolveApplicationCommand(provider, { PATH: "\\tools" }, "win32", "C:\\work"), `C:\\tools${sep}${provider}.cmd`);
        // Preserved: the no-cwd settings probe tests the spelling as given, a
        // fully qualified path is never re-volumed, and a volumeless run
        // directory lends nothing.
        assert.equal(await resolveApplicationCommand(explicit, {}, "win32"), explicit);
        assert.equal(await resolveApplicationCommand(`C:\\tools\\${provider}.cmd`, {}, "win32", "D:\\work"), `C:\\tools\\${provider}.cmd`);
        assert.equal(await resolveApplicationCommand(explicit, {}, "win32", root), explicit);

        await withTrustedCmd(TRUSTED_CMD, async () => {
          for (const [command, env, located] of [
            [explicit, {}, `C:\\tools\\${provider}.cmd`],
            [provider, { PATH: "\\tools" }, `C:\\tools${sep}${provider}.cmd`],
          ] as const) {
            const prepared = await prepareProviderCliSpawn({
              provider, command, args: ["--x"], env, cwd: "C:\\work", platform: "win32", parentEnvironment: PARENT_ENVIRONMENT,
            });
            assert.equal(prepared.kind, "windows-batch");
            if (prepared.kind !== "windows-batch") continue;
            assert.equal(prepared.commandLine, `/d /s /v:off /c "${[located, "--x"].map(helperModule.cmdQuote).join(" ")}"`,
              "the rendered shim is the fully qualified located file");
          }
        });
        // POSIX reviewers render the configured spelling unchanged.
        const posix = await prepareProviderCliSpawn({ provider, command: `/tools/${provider}`, args: [], env: {}, cwd: "/work", platform: "linux" });
        assert.equal(posix.file, `/tools/${provider}`);
      }
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("a Windows reviewer batch shim is refused in a UNC working directory, while a native executable keeps it, for both providers", { skip: process.platform === "win32" }, async () => {
  // Literal POSIX filenames stand in for the UNC files (see the test above).
  await fixture(async (root) => {
    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      await withTrustedCmd(TRUSTED_CMD, async (received) => {
        for (const provider of PROVIDERS) {
          const shim = `\\\\server\\share\\tools\\${provider}.cmd`;
          const native = `\\\\server\\share\\tools\\${provider}.exe`;
          await executable(join(root, shim), "@echo off\r\n");
          await executable(join(root, native), "MZ");
          for (const cwd of ["\\\\server\\share\\work", "\\\\?\\UNC\\server\\share\\work", "//server/share/work", "//server//share/work", "\\\\server\\\\share\\work"]) {
            const before = received.length;
            await assert.rejects(
              prepareProviderCliSpawn({ provider, command: shim, args: [], env: {}, cwd, platform: "win32", parentEnvironment: PARENT_ENVIRONMENT }),
              (error: unknown) => error instanceof CliLaunchError && error.provider === provider && /UNC working directory/u.test(error.message),
              cwd,
            );
            assert.equal(received.length, before, "refused before any cmd.exe is even resolved");
            const direct = await prepareProviderCliSpawn({ provider, command: native, args: ["--x"], env: {}, cwd, platform: "win32", parentEnvironment: PARENT_ENVIRONMENT });
            assert.deepEqual(direct, { kind: "direct", file: native, args: ["--x"], env: {} });
          }
          // A drive-letter run directory (including a mapped drive) keeps the batch launch.
          const onDrive = await prepareProviderCliSpawn({ provider, command: shim, args: [], env: {}, cwd: "Z:\\work", platform: "win32", parentEnvironment: PARENT_ENVIRONMENT });
          assert.equal(onDrive.kind, "windows-batch");
        }
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("real Windows: a reviewer batch shim in a UNC working directory fails as a launch error before any process starts", { skip: process.platform !== "win32" }, async () => {
  await fixture(async (root) => {
    const bin = join(root, "bin");
    await mkdir(bin);
    const volume = win32.parse(root).root.replace(/[\\/]+$/u, "");
    // The administrative share of the fixture's own drive names the same directory over UNC.
    const uncRoot = /^[A-Za-z]:$/u.test(volume) ? `\\\\localhost\\${volume[0]}$${root.slice(volume.length)}` : root;
    for (const provider of PROVIDERS) {
      await writeFile(join(bin, `${provider}.cmd`), "@echo off\r\necho ran\r\n");
      const started: number[] = [];
      await assert.rejects(
        runPromptProcess({
          command: provider, args: [], cwd: uncRoot, prompt: "", timeoutMs: 15_000,
          env: { ...process.env, PATH: bin }, providerLaunch: provider, onProcessStart: ({ pid }) => { started.push(pid); },
        }),
        (error: unknown) => error instanceof CliLaunchError && /UNC working directory/u.test((error as Error).message),
      );
      assert.deepEqual(started, []);
    }
  });
});

test("real Windows: a root-relative shim or PATH entry resolves on the launch directory's own volume", { skip: process.platform !== "win32" }, async () => {
  await fixture(async (root) => {
    const volume = win32.parse(root).root.replace(/[\\/]+$/u, "");
    const rootRelative = root.slice(volume.length);
    assert.ok(rootRelative.startsWith("\\"), "the fixture lives on a drive or share");
    const bin = join(root, "bin");
    await mkdir(bin);
    for (const provider of PROVIDERS) {
      await writeFile(join(bin, `${provider}.cmd`), "@echo off\r\necho shim=%~nx0 %*\r\n");
      const expected = join(bin, `${provider}.cmd`);
      assert.equal(await resolveApplicationCommand(`${rootRelative}\\bin\\${provider}.cmd`, {}, "win32", root), expected);
      assert.equal(await resolveApplicationCommand(provider, { PATH: `${rootRelative}\\bin` }, "win32", root), expected);
      const prepared = await prepareProviderCliSpawn({ provider, command: provider, args: [], env: { PATH: `${rootRelative}\\bin` }, cwd: root });
      assert.equal(prepared.kind, "windows-batch");
      if (prepared.kind === "windows-batch") assert.ok(prepared.commandLine.includes(helperModule.cmdQuote(expected)));
      const descriptor = await createNativeCliLauncher(normalizeConfig({ enabled: true }))(provider, {
        workspace: root, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH")), PATH: `${rootRelative}\\bin` },
      });
      assert.ok(descriptor.commandLine?.includes(helperModule.cmdQuote(await realpath(expected))), "the native descriptor renders the qualified shim");
    }
  });
});

// ---------------------------------------------------------------------------
// #756: the review gate distinguishes a reviewer CLI that never started from an
// atomic publication failure, without weakening fail-closed aggregation.

const baseConfig = fakeNeedsChangesConfig({ maxCorrectionCycles: 1 });

function passingGenericReviewer(id: string): ExternalAgentConfig {
  return {
    id,
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'looks good',findings:[]})))"],
      timeoutMs: 15_000,
    },
  };
}

function providerReviewer(id: string, adapter: "claude-cli" | "codex-cli", command: string): ExternalAgentConfig {
  return { id, adapter, command, args: [], review: { timeoutMs: 15_000 } } as ExternalAgentConfig;
}

const REVIEWER_STAGING_PREFIX = "pi-review-gate-reviewer-";
const TEMP_ENVIRONMENT_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;

/**
 * Run one review with the host temporary directory redirected to a private
 * root this test owns, so reviewer staging (`pi-review-gate-reviewer-*`) can be
 * observed exactly and never confused with another invocation's files. The
 * whole root is removed afterwards; the staging directories still present at
 * the end of the review are reported.
 */
async function reviewWith(
  reviewers: ExternalAgentConfig[],
  onUpdate?: (message: string, privateTemp: string) => void | Promise<void>,
) {
  const privateTemp = await realpath(await mkdtemp(join(tmpdir(), "cli-launch-gate-tmp-")));
  const saved = TEMP_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of TEMP_ENVIRONMENT_KEYS) process.env[key] = privateTemp;
  try {
    assert.equal(tmpdir(), privateTemp);
    const dir = await mkdtemp(join(privateTemp, "workspace-"));
    const before = await createWorkspaceSnapshot(dir, { maxFileBytes: baseConfig.maxFileBytes, maxSnapshotBytes: baseConfig.maxSnapshotBytes });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    const config: ReviewGateConfig = {
      ...baseConfig,
      externalAgents: agentCatalog(...reviewers),
      review: { activeReviewers: reviewers.map((reviewer) => ({ source: "external" as const, id: reviewer.id })) },
    };
    const output = await runReview({
      cwd: dir,
      request: "change index",
      before,
      config,
      ...(onUpdate === undefined ? {} : { onUpdate: (message: string) => { void onUpdate(message, privateTemp); } }),
    });
    const leftoverStaging = (await readdir(privateTemp)).filter((name) => name.startsWith(REVIEWER_STAGING_PREFIX));
    return { output, leftoverStaging };
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(privateTemp, { recursive: true, force: true });
  }
}

test("a reviewer CLI that never starts is a launch failure, not a publication failure, for both providers", async () => {
  for (const [adapter, provider] of [["claude-cli", "claude"], ["codex-cli", "codex"]] as const) {
    const missing = join(tmpdir(), `cli-launch-missing-${process.pid}`, provider);
    const { output, leftoverStaging } = await reviewWith([providerReviewer("solo", adapter, missing)]);
    assert.equal(output.result?.verdict, "error");
    assert.equal(output.result?.error, "reviewer_launch_failed");
    assert.match(output.result?.summary ?? "", /could not be launched/u);
    assert.match(output.result?.diagnostic ?? "", new RegExp(`could not launch the ${provider} CLI`, "u"));
    // Fail-closed shape is unchanged: one gate result, no settlement claimed.
    assert.equal(output.reviewerResults?.length, 1);
    assert.equal(output.reviewerResults?.[0]?.reviewerId, "gate");
    assert.equal(output.result?.processSettlement, "unconfirmed");
    assert.deepEqual(leftoverStaging, [], "the unpublished staging set is removed");
  }
});

test("a launch-failed reviewer still fails the whole pass closed even when a sibling passes", async () => {
  const missing = join(tmpdir(), `cli-launch-missing-${process.pid}`, "claude");
  const { output, leftoverStaging } = await reviewWith([
    providerReviewer("broken", "claude-cli", missing),
    passingGenericReviewer("healthy"),
  ]);
  assert.equal(output.result?.verdict, "error", "a sibling pass never carries the gate past a launch failure");
  assert.equal(output.result?.error, "reviewer_launch_failed");
  assert.deepEqual(output.reviewerResults?.map((result) => result.verdict), ["error"]);
  assert.equal(output.result?.processSettlement, "unconfirmed");
  assert.match(output.result?.diagnostic ?? "", /broken: /u);
  assert.deepEqual(leftoverStaging, []);
});

test("a genuine reviewer artifact failure keeps the atomic publication classification", async () => {
  // A non-provider reviewer whose launch rejects is not a provider launch
  // failure: it stays the established publication failure, alone or mixed.
  const missingGeneric: ExternalAgentConfig = { ...passingGenericReviewer("generic"), command: join(tmpdir(), `cli-launch-missing-${process.pid}`, "generic") };
  for (const reviewers of [
    [missingGeneric],
    [providerReviewer("broken", "codex-cli", join(tmpdir(), `cli-launch-missing-${process.pid}`, "codex")), missingGeneric],
  ]) {
    const { output, leftoverStaging } = await reviewWith(reviewers);
    assert.equal(output.result?.verdict, "error");
    assert.equal(output.result?.error, "artifact_publication_failed");
    assert.equal(output.result?.summary, "Reviewer results could not be published atomically.");
    assert.deepEqual(leftoverStaging, []);
  }
});

test("a staging write failure after a provider launch refusal is an artifact failure, not a launch failure", async () => {
  // The Codex reviewer stages its output schema, announces the sandbox
  // preflight, and only then launches. Removing its private staging directory
  // at that announcement makes the launch refusal AND the reviewer's own
  // artifact writes fail for the same reviewer.
  const missing = join(tmpdir(), `cli-launch-missing-${process.pid}`, "codex");
  let removed: string[] = [];
  const { output, leftoverStaging } = await reviewWith(
    [providerReviewer("broken", "codex-cli", missing)],
    (message, privateTemp) => {
      if (!message.endsWith("sandbox preflight started")) return;
      // Synchronous: the removal completes before the adapter reaches its launch.
      removed = readdirSync(privateTemp).filter((name) => name.startsWith(REVIEWER_STAGING_PREFIX));
      for (const name of removed) rmSync(join(privateTemp, name), { recursive: true, force: true });
    },
  );
  assert.equal(removed.length, 1, "exactly this reviewer's staging directory was removed");
  assert.equal(output.result?.verdict, "error");
  assert.equal(output.result?.error, "artifact_publication_failed");
  assert.equal(output.result?.summary, "Reviewer results could not be published atomically.");
  assert.deepEqual(output.reviewerResults?.map((result) => result.reviewerId), ["gate"], "no reviewer set was published");
  assert.match(output.result?.diagnostic ?? "", /could not launch the codex CLI/u, "the launch refusal stays visible in the diagnostic");
  assert.deepEqual(leftoverStaging, []);
});
