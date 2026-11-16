import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import {
  createNativeCliLauncher,
  type NativeCliLaunchDescriptor,
  type NativeCliLaunchRequest,
  type NativeCodexOwnedLaunchPlan,
} from "../src/session-host/native-cli-launch";
import { NATIVE_HOOK_BOOTSTRAP_ENV, type NativeHookBootstrap } from "../src/session-host/native-hook-protocol";
import { RUNTIME_ROLE_ENV } from "../src/session-host/launch";

/**
 * Exact native CLI restoration argv (issue #277 auto-restoration, argument
 * composition slice).
 *
 * Hermetic: fixtures are never executed, platform injection drives the Windows
 * cases, and every assertion inspects the synthetic descriptor or the owned
 * plan's pure renders. No provider process, configuration, credential, or
 * conversation is touched.
 */
const helperModule = require(resolve("scripts/pi-review-gate-launcher.cjs")) as {
  cmdQuote: (arg: string) => string;
  resolveTrustedWindowsCmd: (parentEnvironment?: NodeJS.ProcessEnv) => string | null;
};

const UUID = "0f8e2a4c-6b1d-4c3e-9a7f-5d2b8c1e4a60";
const ENDPOINT = "ws://127.0.0.1:54321";
const AUTH_ENV = "PI_REVIEW_GATE_OWNED_CODEX_RPC_0";
const BEARER = "synthetic-bearer-never-a-real-token";
const DIGEST = "a".repeat(64);
const CONTROL = ["app-server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token", "--ws-token-sha256", DIGEST];
const CONNECTION_ARGS = ["--remote", ENDPOINT, "--remote-auth-token-env", AUTH_ENV];
const TRUSTED_CMD = "Z:\\Fixture Windows Root\\System32\\cmd.exe";
const PARENT_ENV: NodeJS.ProcessEnv = { SystemRoot: "Z:\\Fixture Windows Root" };

async function fixture(run: (root: string, bin: string, workspace: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-cli-resume-")));
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  await mkdir(bin, { recursive: true });
  await mkdir(workspace);
  // Wrapper scripts a restore can prove as program-prefix tokens: existing
  // regular files in the workspace the child is spawned in. Never executed.
  for (const script of ["wrapper.js", "script.js"]) await writeFile(join(workspace, script), "// never invoked\n");
  try { await run(root, bin, workspace); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function fakeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\necho never invoked\n");
  await chmod(path, 0o755);
}

function configWith(externalAgents: Record<string, unknown>): ReviewGateConfig {
  return normalizeConfig({ enabled: true, externalAgents });
}

function bootstrapFor(backend: "claude" | "codex"): NativeHookBootstrap {
  return {
    version: 1,
    socketPath: "/tmp/prg-synthetic-status-broker.sock",
    generation: "22222222-2222-4222-8222-222222222222",
    instanceId: "11111111-1111-4111-8111-111111111111",
    backend,
    token: "b".repeat(64),
  };
}

function planOf(descriptor: NativeCliLaunchDescriptor): NativeCodexOwnedLaunchPlan {
  assert.ok(descriptor.ownedCodex !== undefined, "an owned Codex launch carries a plan");
  return descriptor.ownedCodex!;
}

function connectionFor(plan: NativeCodexOwnedLaunchPlan, args: readonly string[] = CONNECTION_ARGS) {
  return { args: [...args], env: { ...plan.backendEnv, [AUTH_ENV]: BEARER } as NodeJS.ProcessEnv };
}

function batchLine(tokens: readonly string[]): string {
  return `/d /s /v:off /c "${tokens.map((token) => helperModule.cmdQuote(token)).join(" ")}"`;
}

async function withTrustedCmd(run: () => Promise<void>): Promise<void> {
  const shipped = helperModule.resolveTrustedWindowsCmd;
  helperModule.resolveTrustedWindowsCmd = () => TRUSTED_CMD;
  try { await run(); }
  finally { helperModule.resolveTrustedWindowsCmd = shipped; }
}

/** The refusal of one launch, which must never echo the private id. */
async function refusal(promise: Promise<unknown>, pattern: RegExp): Promise<Error> {
  try {
    await promise;
  } catch (caught) {
    assert.ok(caught instanceof Error);
    assert.match(caught.message, pattern);
    assert.ok(!caught.message.includes(UUID), "a refusal never carries the conversation id");
    return caught;
  }
  throw new Error(`expected a refusal matching ${String(pattern)}`);
}

// ---------------------------------------------------------------------------
// Fresh launches are unchanged
// ---------------------------------------------------------------------------

test("an absent resume id composes exactly the fresh descriptor, plan, and renders", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    await fakeExecutable(join(bin, "node"));
    const claudeArgs = ["wrapper.js", "--model", "opus", "prompt text"];
    const codexArgs = ["-c", 'model="x"', "-m", "gpt", "--", "a fresh prompt"];
    const config = configWith({
      cw: { adapter: "claude-cli", command: join(bin, "node"), args: claudeArgs, review: {} },
      xw: { adapter: "codex-cli", command: join(bin, "codex"), args: codexArgs, review: {} },
    });
    const plain = createNativeCliLauncher(config, { platform: "darwin" });
    const owned = createNativeCliLauncher(config, { platform: "darwin", ownedCodexBackend: true });

    // Literal fresh argv, prompts included: restoration never changes them.
    const claude = await plain("claude", { workspace, env: { PATH: bin }, targetId: "external:cw" });
    assert.deepEqual(claude.args, claudeArgs);
    const codex = await plain("codex", { workspace, env: { PATH: bin }, targetId: "external:xw" });
    assert.deepEqual(codex.args, ["-c", 'model="x"', "-m", "gpt", "--no-daemon", "--", "a fresh prompt"]);
    assert.deepEqual((await plain("codex", { workspace, env: { PATH: bin } })).args, ["--no-daemon"]);
    assert.deepEqual((await plain("claude", { workspace, env: { PATH: bin } })).args, []);

    // An explicitly undefined field is the same absence, byte for byte.
    const undefinedField: NativeCliLaunchRequest = { workspace, env: { PATH: bin }, targetId: "external:xw", resumeConversationId: undefined };
    const ownedFresh = await owned("codex", { workspace, env: { PATH: bin }, targetId: "external:xw" });
    const ownedUndefined = await owned("codex", undefinedField);
    assert.deepEqual(ownedUndefined.args, ownedFresh.args);
    assert.deepEqual(ownedUndefined.env, ownedFresh.env);
    const freshTui = planOf(ownedFresh).renderTui(connectionFor(planOf(ownedFresh)));
    assert.deepEqual(freshTui.args, ["-c", 'model="x"', "-m", "gpt", ...CONNECTION_ARGS, "--", "a fresh prompt"]);
    assert.deepEqual(planOf(ownedUndefined).renderTui(connectionFor(planOf(ownedUndefined))).args, freshTui.args);
    // A fresh owned TUI still accepts any non-empty connection list literally.
    assert.deepEqual(
      planOf(ownedFresh).renderTui(connectionFor(planOf(ownedFresh), ["--remote", ENDPOINT])).args,
      ["-c", 'model="x"', "-m", "gpt", "--remote", ENDPOINT, "--", "a fresh prompt"],
    );
  });
});

// ---------------------------------------------------------------------------
// Claude exact resume
// ---------------------------------------------------------------------------

test("Claude restores with --resume <uuid> in real option position, keeping wrapper prefix, option values, and --", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "node"));
    const wrapped = ["wrapper.js", "--model", "opus", "--append-system-prompt", "be terse", "--settings", "/op/s.json", "--"];
    const config = configWith({
      cw: { adapter: "claude-cli", command: join(bin, "node"), args: wrapped, review: {} },
    });
    const snapshot = structuredClone(wrapped);
    const launcher = createNativeCliLauncher(config, { platform: "darwin" });

    const byDefault = await launcher("claude", { workspace, env: { PATH: bin }, targetId: "claude", resumeConversationId: UUID });
    assert.deepEqual(byDefault.args, ["--resume", UUID]);

    const fresh = await launcher("claude", { workspace, env: { PATH: bin }, targetId: "external:cw" });
    const restored = await launcher("claude", { workspace, env: { PATH: bin }, targetId: "external:cw", resumeConversationId: UUID });
    assert.deepEqual(restored.args, [
      "wrapper.js", "--model", "opus", "--append-system-prompt", "be terse", "--settings", "/op/s.json",
      "--resume", UUID, "--",
    ]);
    assert.equal(restored.file, fresh.file);
    assert.equal(restored.cwd, fresh.cwd);
    assert.deepEqual(restored.env, fresh.env, "the child environment is the fresh one");
    assert.ok(!JSON.stringify(restored.env).includes(UUID));
    assert.equal(restored.nativeHook, undefined);
    assert.equal(restored.ownedCodex, undefined);
    assert.ok(!("resumeConversationId" in restored));
    assert.deepEqual(wrapped, snapshot, "configuration is never mutated");
  });
});

test("Claude restoration keeps the armed native hook flags and fresh marker, with --resume after them", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "claude"));
    const configured = ["--model", "opus"];
    const launcher = createNativeCliLauncher(configWith({
      op: { adapter: "claude-cli", command: join(bin, "claude"), args: configured, review: {} },
    }), { platform: "darwin" });
    const descriptor = await launcher("claude", {
      workspace,
      env: { PATH: bin },
      targetId: "external:op",
      nativeHook: { bootstrap: bootstrapFor("claude") },
      resumeConversationId: UUID,
    });
    const hook = descriptor.nativeHook;
    assert.equal(hook?.observation, "prepared");
    if (hook?.observation !== "prepared") throw new Error("unreachable");
    try {
      assert.ok(hook.args.length > 0);
      assert.deepEqual(descriptor.args, [...configured, ...hook.args, "--resume", UUID]);
      assert.equal(JSON.parse(descriptor.env[NATIVE_HOOK_BOOTSTRAP_ENV]!).token, "b".repeat(64));
      assert.ok(!descriptor.args.some((token) => /^(?:-p|--print|--continue|--session-id|--fork-session)$/u.test(token)));
    } finally {
      await hook.lease.cleanup();
    }
  });
});

test("Claude system-prompt settings and a proven wrapper script are configuration, preserved verbatim around --resume", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "node"));
    const split = ["--system-prompt", "be terse", "--model", "opus"];
    const attached = ["--system-prompt=be terse", "--"];
    const absoluteWrapper = [join(workspace, "wrapper.js"), "--system-prompt", "be terse"];
    const launcher = createNativeCliLauncher(configWith({
      split: { adapter: "claude-cli", command: join(bin, "claude"), args: split, review: {} },
      attached: { adapter: "claude-cli", command: join(bin, "claude"), args: attached, review: {} },
      abs: { adapter: "claude-cli", command: join(bin, "node"), args: absoluteWrapper, review: {} },
    }), { platform: "darwin" });
    const restore = (targetId: string) => launcher("claude", { workspace, env: { PATH: bin }, targetId, resumeConversationId: UUID });
    assert.deepEqual((await restore("external:split")).args, [...split, "--resume", UUID]);
    assert.deepEqual((await restore("external:attached")).args, ["--system-prompt=be terse", "--resume", UUID, "--"]);
    assert.deepEqual((await restore("external:abs")).args, [...absoluteWrapper, "--resume", UUID]);
    // The fresh composition of the same targets is untouched.
    assert.deepEqual((await launcher("claude", { workspace, env: { PATH: bin }, targetId: "external:split" })).args, split);
  });
});

test("a Windows Claude batch restore quotes --resume and the uuid through the one cmdQuote authority", async () => {
  await fixture(async (_root, bin, workspace) => {
    for (const name of ["claude.cmd", "node.exe"]) {
      await writeFile(join(bin, name), "@echo off\r\n");
      await chmod(join(bin, name), 0o755);
    }
    await withTrustedCmd(async () => {
      const launcher = createNativeCliLauncher(configWith({
        wrap: { adapter: "claude-cli", command: join(bin, "node.exe"), args: ["script.js", "--model", "opus"], review: {} },
      }), { platform: "win32", parentEnvironment: PARENT_ENV });
      const direct = await launcher("claude", { workspace, env: { PATH: bin }, targetId: "claude", resumeConversationId: UUID });
      assert.equal(direct.file, TRUSTED_CMD);
      assert.deepEqual(direct.args, []);
      assert.equal(direct.commandLine, batchLine([join(bin, "claude.cmd"), "--resume", UUID]));
      const prefixed = await launcher("claude", { workspace, env: { PATH: bin }, targetId: "external:wrap", resumeConversationId: UUID });
      assert.equal(prefixed.file, join(bin, "node.exe"));
      assert.equal(prefixed.commandLine, undefined);
      assert.deepEqual(prefixed.args, ["script.js", "--model", "opus", "--resume", UUID]);
    });
  });
});

// ---------------------------------------------------------------------------
// Owned Codex exact resume
// ---------------------------------------------------------------------------

test("owned Codex renders `[options] resume --remote <relay> --remote-auth-token-env <ENV> <uuid>` and an unchanged backend", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "codex"));
    await fakeExecutable(join(bin, "node"));
    const configured = ["wrapper.js", "-c", 'model="x"', "-m", "gpt", "--enable", "feature_x", "--"];
    const launcher = createNativeCliLauncher(configWith({
      xw: { adapter: "codex-cli", command: join(bin, "node"), args: configured, review: {} },
    }), { platform: "darwin", ownedCodexBackend: true });

    const byDefault = await launcher("codex", { workspace, env: { PATH: bin }, targetId: "codex", resumeConversationId: UUID });
    const defaultPlan = planOf(byDefault);
    assert.deepEqual(defaultPlan.renderTui(connectionFor(defaultPlan)).args, ["resume", ...CONNECTION_ARGS, UUID]);
    assert.deepEqual(byDefault.args, ["--no-daemon", "resume", UUID], "the never-spawned ordinary descriptor still names this conversation");

    const fresh = await launcher("codex", { workspace, env: { PATH: bin }, targetId: "external:xw" });
    const restored = await launcher("codex", {
      workspace,
      env: { PATH: bin },
      targetId: "external:xw",
      nativeHook: { bootstrap: bootstrapFor("codex") },
      resumeConversationId: UUID,
    });
    const plan = planOf(restored);
    const tui = plan.renderTui(connectionFor(plan));
    assert.deepEqual(tui.args, [
      "wrapper.js", "-c", 'model="x"', "-m", "gpt", "--enable", "feature_x",
      "resume", ...CONNECTION_ARGS, UUID, "--",
    ]);
    assert.equal(tui.args.filter((token) => token === "resume").length, 1);
    assert.ok(!tui.args.includes("--no-daemon"), "a remote resume never carries --no-daemon");
    assert.ok(!tui.args.includes("--fork") && !tui.args.includes("--last"));
    const freshTui = planOf(fresh).renderTui(connectionFor(planOf(fresh)));
    assert.deepEqual(tui.env, freshTui.env, "the TUI environment is the fresh owned one");
    assert.equal(tui.file, freshTui.file);
    assert.equal(tui.cwd, freshTui.cwd);

    // The backend knows nothing of the restoration.
    const backend = plan.renderBackend(CONTROL, { ...plan.backendEnv });
    const freshBackend = planOf(fresh).renderBackend(CONTROL, { ...planOf(fresh).backendEnv });
    assert.deepEqual(backend.args, freshBackend.args);
    assert.deepEqual(backend.env, freshBackend.env);
    assert.ok(!backend.args.includes(UUID));
    assert.deepEqual(plan.backendEnv, planOf(fresh).backendEnv);

    // Owned launches still stage no hook of ours, restored or not.
    assert.equal(restored.nativeHook, undefined);
    assert.equal(restored.env[NATIVE_HOOK_BOOTSTRAP_ENV], undefined);
    // The private id lives only in the renderer's closure.
    assert.deepEqual(Object.keys(plan).sort(), ["backendEnv", "renderBackend", "renderTui"]);
    assert.ok(!JSON.stringify(plan.backendEnv).includes(UUID));
    assert.ok(!JSON.stringify(restored.env).includes(UUID));
    // Re-rendering is pure.
    assert.deepEqual(plan.renderTui(connectionFor(plan)).args, tui.args);
  });
});

test("an owned Codex resume refuses any connection that is not exactly the two remote options", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "codex"));
    const launcher = createNativeCliLauncher(configWith({}), { platform: "darwin", ownedCodexBackend: true });
    const plan = planOf(await launcher("codex", { workspace, env: { PATH: bin }, targetId: "codex", resumeConversationId: UUID }));
    for (const args of [
      ["--remote", ENDPOINT],
      ["--remote-auth-token-env", AUTH_ENV, "--remote", ENDPOINT],
      [...CONNECTION_ARGS, "extra"],
      ["--remote", "--remote-auth-token-env", AUTH_ENV, ENDPOINT],
      ["--remote", "", "--remote-auth-token-env", AUTH_ENV],
    ]) {
      assert.throws(() => plan.renderTui(connectionFor(plan, args)), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /not exactly the resume subcommand's --remote and --remote-auth-token-env options/u);
        assert.ok(!error.message.includes(ENDPOINT) && !error.message.includes(UUID));
        return true;
      });
    }
  });
});

test("a Windows owned Codex restore renders the resume TUI through the trusted batch path", async () => {
  await fixture(async (_root, bin, workspace) => {
    const shim = join(bin, "codex.cmd");
    await writeFile(shim, "@echo off\r\n");
    await chmod(shim, 0o755);
    await withTrustedCmd(async () => {
      const launcher = createNativeCliLauncher(configWith({
        worker: { adapter: "codex-cli", command: join(bin, "codex"), args: ["-m", "gpt"], review: {} },
      }), { platform: "win32", parentEnvironment: PARENT_ENV, ownedCodexBackend: true });
      const plan = planOf(await launcher("codex", { workspace, env: { PATH: bin }, targetId: "external:worker", resumeConversationId: UUID }));
      const tui = plan.renderTui(connectionFor(plan));
      assert.equal(tui.file, TRUSTED_CMD);
      assert.deepEqual(tui.args, []);
      assert.equal(tui.commandLine, batchLine([shim, "-m", "gpt", "resume", ...CONNECTION_ARGS, UUID]));
    });
  });
});

// ---------------------------------------------------------------------------
// Closed refusals
// ---------------------------------------------------------------------------

test("an existing file does not prove a passthrough wrapper's positional is a script", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "passthrough"));
    for (const backend of ["claude", "codex"] as const) {
      for (const args of [["wrapper.js"], ["wrapper.js", "--model", "opus"]]) {
        const launcher = createNativeCliLauncher(configWith({
          t: {
            adapter: backend === "claude" ? "claude-cli" : "codex-cli",
            command: join(bin, "passthrough"), args, review: {},
          },
        }), { platform: "darwin", ownedCodexBackend: true });
        await refusal(launcher(backend, {
          workspace, env: { PATH: bin }, targetId: "external:t", resumeConversationId: UUID,
        }), /no proven script-consuming interpreter prefix/u);
        const fresh = await launcher(backend, {
          workspace, env: { PATH: bin }, targetId: "external:t",
        });
        assert.deepEqual(fresh.args, backend === "claude" ? args : [...args, "--no-daemon"]);
      }
    }
  });
});

test("a malformed resume id is refused before environment, hook, or artifact work, never as a fresh launch", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    const plain = createNativeCliLauncher(configWith({}), { platform: "darwin" });
    const owned = createNativeCliLauncher(configWith({}), { platform: "darwin", ownedCodexBackend: true });
    const malformed: unknown[] = [
      "", "latest", "last", "my session", `{${UUID}}`, `urn:uuid:${UUID}`, ` ${UUID}`, `${UUID}\n`,
      UUID.slice(0, 35), null, 42, ["x"],
    ];
    for (const value of malformed) {
      for (const [backend, launcher] of [["claude", plain], ["codex", owned]] as const) {
        await refusal(launcher(backend, {
          workspace,
          // A worker role would be refused at environment composition; the
          // restore refusal winning proves nothing past validation ran.
          env: { PATH: bin, [RUNTIME_ROLE_ENV]: "executor" },
          targetId: backend,
          nativeHook: { bootstrap: bootstrapFor(backend) },
          resumeConversationId: value as string,
        }), /restore id is not one exact provider conversation UUID/u);
      }
    }
  });
});

test("a restore never defaults a missing target and never accepts an unknown or cross-backend one", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    const config = configWith({
      xw: { adapter: "codex-cli", command: join(bin, "codex"), review: {} },
    });
    const plain = createNativeCliLauncher(config, { platform: "darwin" });
    const owned = createNativeCliLauncher(config, { platform: "darwin", ownedCodexBackend: true });
    await refusal(plain("claude", { workspace, env: { PATH: bin }, resumeConversationId: UUID }), /requires its exact remembered launch target/u);
    await refusal(owned("codex", { workspace, env: { PATH: bin }, resumeConversationId: UUID }), /requires its exact remembered launch target/u);
    await refusal(plain("claude", { workspace, env: { PATH: bin }, targetId: "external:gone", resumeConversationId: UUID }), /is not a configured native interactive CLI target/u);
    await refusal(plain("claude", { workspace, env: { PATH: bin }, targetId: "external:xw", resumeConversationId: UUID }), /cannot launch a Claude Code session/u);
    await refusal(owned("codex", { workspace, env: { PATH: bin }, targetId: "claude", resumeConversationId: UUID }), /cannot launch a Codex CLI session/u);
  });
});

test("an ordinary (non-owned) Codex restore is refused explicitly rather than started fresh", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "codex"));
    const plain = createNativeCliLauncher(configWith({}), { platform: "darwin" });
    await refusal(plain("codex", { workspace, env: { PATH: bin }, targetId: "codex", resumeConversationId: UUID }),
      /non-owned\) Codex launch has no proven exact resume form/u);
    // The fresh launch is unaffected.
    assert.deepEqual((await plain("codex", { workspace, env: { PATH: bin }, targetId: "codex" })).args, ["--no-daemon"]);
  });
});

test("configured startup input and restore-incompatible options refuse the restore without mutating configuration", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    await fakeExecutable(join(bin, "node"));
    const cases: { backend: "claude" | "codex"; command: string; args: string[]; pattern: RegExp }[] = [
      { backend: "claude", command: "claude", args: ["hello there"], pattern: /positional initial prompt/u },
      { backend: "claude", command: "claude", args: ["--model", "opus", "hello"], pattern: /positional initial prompt/u },
      { backend: "claude", command: "node", args: ["wrapper.js", "--model", "opus", "hello"], pattern: /positional initial prompt/u },
      // A wrapper may forward its arguments: only one proven script file is a prefix.
      { backend: "claude", command: "node", args: ["wrapper.js", "initial prompt", "--model", "opus"], pattern: /more than one leading positional/u },
      { backend: "claude", command: "node", args: ["wrapper.js", "initial prompt"], pattern: /more than one leading positional/u },
      { backend: "claude", command: "node", args: ["initial prompt", "--model", "opus"], pattern: /leading positional is not an existing script file/u },
      { backend: "claude", command: "node", args: ["initial prompt"], pattern: /leading positional is not an existing script file/u },
      { backend: "claude", command: "node", args: ["missing.js", "--model", "opus"], pattern: /leading positional is not an existing script file/u },
      { backend: "codex", command: "node", args: ["initial prompt", "-m", "gpt"], pattern: /leading positional is not an existing script file/u },
      { backend: "codex", command: "node", args: ["wrapper.js", "fix it", "-m", "gpt"], pattern: /more than one leading positional/u },
      // System-prompt configuration is an operand, but an extra positional is still a prompt.
      { backend: "claude", command: "claude", args: ["--system-prompt", "be terse", "hello"], pattern: /positional initial prompt/u },
      { backend: "claude", command: "claude", args: ["--model", "opus", "--system-prompt"], pattern: /spell --system-prompt without a value/u },
      { backend: "claude", command: "claude", args: ["--system-prompt", "--model", "opus"], pattern: /spell --system-prompt without a value/u },
      { backend: "claude", command: "claude", args: ["--system-prompt", "--"], pattern: /spell --system-prompt without a value/u },
      { backend: "claude", command: "claude", args: ["--", "hi"], pattern: /prompt data after the -- terminator/u },
      { backend: "claude", command: "claude", args: ["--model", "opus", "--", ""], pattern: /prompt data after the -- terminator/u },
      { backend: "claude", command: "claude", args: ["--file", "file_abc:doc.txt"], pattern: /startup input option --file/u },
      { backend: "claude", command: "claude", args: ["--file=file_abc:doc.txt"], pattern: /startup input option --file/u },
      { backend: "claude", command: "claude", args: ["--from-pr=12"], pattern: /conversation selection option --from-pr/u },
      { backend: "codex", command: "codex", args: ["fix the bug"], pattern: /positional initial prompt/u },
      { backend: "codex", command: "codex", args: ["-m", "gpt", "--", "fix"], pattern: /prompt data after the -- terminator/u },
      { backend: "codex", command: "codex", args: ["-i", "shot.png"], pattern: /startup input option -i/u },
      { backend: "codex", command: "codex", args: ["-ishot.png"], pattern: /startup input option -i/u },
      { backend: "codex", command: "codex", args: ["--image=shot.png"], pattern: /startup input option --image/u },
      { backend: "codex", command: "codex", args: ["--no-daemon"], pattern: /include --no-daemon, which a remote resume/u },
    ];
    for (const entry of cases) {
      const agentArgs = structuredClone(entry.args);
      const config = configWith({
        t: { adapter: entry.backend === "claude" ? "claude-cli" : "codex-cli", command: join(bin, entry.command), args: agentArgs, review: {} },
      });
      const launcher = createNativeCliLauncher(config, { platform: "darwin", ownedCodexBackend: true });
      await refusal(launcher(entry.backend, {
        workspace, env: { PATH: bin }, targetId: "external:t", resumeConversationId: UUID,
      }), entry.pattern);
      assert.deepEqual(agentArgs, entry.args, "the configured args are never stripped or rewritten");
      // Restore-only: the same target still launches fresh, exactly as configured.
      const fresh = await launcher(entry.backend, { workspace, env: { PATH: bin }, targetId: "external:t" });
      assert.ok(entry.args.every((token) => fresh.args.includes(token)), "fresh composition keeps every configured token");
    }
  });
});

test("configured resume, fork, bypass, and workspace flags stay refused even beside a trusted internal resume id", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    const cases: { backend: "claude" | "codex"; args: string[]; pattern: RegExp }[] = [
      { backend: "claude", args: ["--resume", UUID], pattern: /startup session\/resume selection option --resume/u },
      { backend: "claude", args: ["-r", UUID], pattern: /startup session\/resume selection option -r/u },
      { backend: "claude", args: ["--continue"], pattern: /startup session\/resume selection option --continue/u },
      { backend: "claude", args: ["--fork-session"], pattern: /startup session\/resume selection option --fork-session/u },
      { backend: "claude", args: [`--session-id=${UUID}`], pattern: /startup session\/resume selection option --session-id/u },
      { backend: "claude", args: ["--dangerously-skip-permissions"], pattern: /approval or sandbox bypass option/u },
      { backend: "claude", args: ["--add-dir", "/elsewhere"], pattern: /workspace scope switch option --add-dir/u },
      { backend: "codex", args: ["resume", UUID], pattern: /headless or service mode option resume/u },
      { backend: "codex", args: ["fork"], pattern: /headless or service mode option fork/u },
      { backend: "codex", args: ["--remote", ENDPOINT], pattern: /headless or service mode option --remote/u },
      { backend: "codex", args: ["--yolo"], pattern: /approval or sandbox bypass option --yolo/u },
      { backend: "codex", args: ["-c", 'approval_policy="never"'], pattern: /approval or sandbox bypass option -c/u },
      { backend: "codex", args: ["-C", "/elsewhere"], pattern: /workspace scope switch option -C/u },
    ];
    for (const entry of cases) {
      const config = configWith({
        t: { adapter: entry.backend === "claude" ? "claude-cli" : "codex-cli", command: join(bin, entry.backend), args: entry.args, review: {} },
      });
      const launcher = createNativeCliLauncher(config, { platform: "darwin", ownedCodexBackend: true });
      // Configured spellings get no authority from the internal id …
      const restoreError = await refusal(launcher(entry.backend, {
        workspace, env: { PATH: bin }, targetId: "external:t", resumeConversationId: UUID,
      }), entry.pattern);
      // … and fail exactly as they always did without it.
      const freshError = await refusal(launcher(entry.backend, { workspace, env: { PATH: bin }, targetId: "external:t" }), entry.pattern);
      assert.equal(restoreError.message, freshError.message);
    }
  });
});

test("the owned named-profile refusal is unchanged and still wins for a restore", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "codex"));
    const launcher = createNativeCliLauncher(configWith({
      p: { adapter: "codex-cli", command: join(bin, "codex"), args: ["--profile", "work", "hello"], review: {} },
    }), { platform: "darwin", ownedCodexBackend: true });
    await refusal(launcher("codex", { workspace, env: { PATH: bin }, targetId: "external:p", resumeConversationId: UUID }),
      /choose a named provider profile/u);
  });
});
