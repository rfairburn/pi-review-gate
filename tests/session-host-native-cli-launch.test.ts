import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { externalAgentCatalog, normalizeConfig, type ReviewGateConfig } from "../src/config";
import {
  isNativeCliNewSessionTarget,
  nativeCliRestoreTargetId,
  projectNativeCliNewSessionTargets,
} from "../src/session-host/session-backend";
import {
  NATIVE_CLI_DEFAULT_TARGET_IDS,
  NATIVE_CODEX_OWNED_PROFILE_UNSUPPORTED_CODE,
  NativeCodexOwnedProfileUnsupportedError,
  createNativeCliLauncher,
  listNativeCliNewSessionTargets,
  listNativeCliTargets,
  type NativeCliLaunchDescriptor,
  type NativeCodexOwnedLaunchPlan,
  type NativeCodexOwnedTuiConnection,
} from "../src/session-host/native-cli-launch";
import {
  NATIVE_HOOK_BOOTSTRAP_ENV,
  type NativeHookBootstrap,
} from "../src/session-host/native-hook-protocol";
import { type NativeHookLaunchOutcome } from "../src/session-host/native-hook-launch-prep";
import { NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV } from "../src/session-host/native-review-hook-protocol";
import {
  EXECUTOR_TOOL_CATALOG_ENV,
  NODE_OPTIONS_RESTORE_ENV,
  RUNTIME_ROLE_ENV,
  SESSION_HOST_BOOTSTRAP_ENV,
} from "../src/session-host/launch";
import { SESSION_HOST_STARTUP_REQUEST_ENV, SESSION_HOST_TITLE_COLUMNS_ENV } from "../src/session-host/startup-request";

/**
 * Native interactive CLI launch descriptors (issue #277, launch-adapter slice).
 *
 * These tests are hermetic: fixtures are ordinary files that are never
 * executed, and platform/environment injection drives the Windows cases. No
 * real Claude or Codex process runs, no provider configuration or credential
 * is read, and nothing here claims Windows runtime coverage.
 */
const helperModule = require(resolve("scripts/pi-review-gate-launcher.cjs")) as {
  cmdQuote: (arg: string) => string;
  /** The one trusted Windows cmd.exe authority the adapter must reuse. */
  resolveTrustedWindowsCmd: (parentEnvironment?: NodeJS.ProcessEnv) => string | null;
};

async function fixture(run: (root: string, bin: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-cli-launch-")));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  try { await run(root, bin); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function fakeExecutable(path: string): Promise<void> {
  // Resolution inspects filesystem evidence only; no fixture is ever invoked.
  await writeFile(path, "#!/bin/sh\necho never invoked\n");
  await chmod(path, 0o755);
}

/** A minimal normalized config carrying the given external-agent catalog. */
function configWith(externalAgents: Record<string, unknown>): ReviewGateConfig {
  return normalizeConfig({ enabled: true, externalAgents });
}

test("the default targets are exactly claude and codex, and configured shared CLI entries join them by prefixed id", async () => {
  await fixture(async (_root, bin) => {
    const config = configWith({
      "zeta-codex": { adapter: "codex-cli", command: join(bin, "codex"), review: {} },
      claude: { adapter: "claude-cli", command: join(bin, "claude"), review: {} },
      "plain-generic": { adapter: "generic-cli", command: join(bin, "reviewer"), review: {} },
      "binary-worker": { adapter: "run-as-binary", command: join(bin, "worker"), execution: { protocol: "pi-review-executor-jsonl-v1" } },
    });
    assert.deepEqual(listNativeCliTargets(config).map((target) => target.id), [
      NATIVE_CLI_DEFAULT_TARGET_IDS.claude,
      NATIVE_CLI_DEFAULT_TARGET_IDS.codex,
      "external:claude",
      "external:zeta-codex",
    ]);
    assert.deepEqual(listNativeCliTargets(config).map((target) => target.backend), ["claude", "codex", "claude", "codex"]);
    // Labels are operator-facing names only: never a command, path, or argument.
    for (const target of listNativeCliTargets(config)) {
      assert.ok(!target.label.includes(bin));
      assert.ok(target.label.includes(target.backend === "claude" ? "Claude Code" : "Codex CLI"));
    }
    // Prototype-style ids stay data, never property names.
    const prototypeConfig = configWith({ ["__proto__"]: { adapter: "codex-cli", review: {} }, ["constructor"]: { adapter: "claude-cli", review: {} } });
    assert.deepEqual(listNativeCliTargets(prototypeConfig).map((target) => target.id), [
      "claude", "codex", "external:__proto__", "external:constructor",
    ]);
    assert.deepEqual(listNativeCliTargets({} as ReviewGateConfig).map((target) => target.id), ["claude", "codex"]);
  });
});

test("NEW-session choices are only the backend defaults while the configured worker catalog stays intact (#493)", async () => {
  await fixture(async (_root, bin) => {
    const config = configWith({
      "review-codex": {
        adapter: "codex-cli",
        command: join(bin, "codex"),
        args: ["--profile", "work"],
        env: { CODEX_HOME: "/operator/.codex-work" },
        reasoningEffort: "high",
        review: { model: "gpt-review", reasoningEffort: "xhigh", args: ["--search"] },
        execution: { model: "gpt-exec", reasoningEffort: "low", protocol: "pi-review-executor-jsonl-v1" },
      },
      "worker-claude": {
        adapter: "claude-cli",
        command: join(bin, "claude"),
        model: "claude-shared",
        review: { model: "claude-review", reasoningEffort: "max" },
      },
    });
    const catalogBefore = JSON.stringify(externalAgentCatalog(config));
    const configBefore = JSON.stringify(config);

    const choices = listNativeCliNewSessionTargets(config);
    assert.deepEqual(choices, [
      { id: "claude", backend: "claude", label: "Claude Code (default)" },
      { id: "codex", backend: "codex", label: "Codex CLI (default)" },
    ], "a NEW session offers exactly the two backend defaults with their unchanged labels");
    assert.ok(Object.isFrozen(choices));
    // The launcher's full configured identity list is unchanged.
    assert.deepEqual(listNativeCliTargets(config).map((target) => target.id), [
      "claude", "codex", "external:review-codex", "external:worker-claude",
    ]);
    // The NEW choice list is the projection of that same list, not a registry.
    assert.deepEqual(projectNativeCliNewSessionTargets(listNativeCliTargets(config)), choices);
    // Deriving choices never touches the review/execution catalog, models,
    // reasoning, args, or env.
    assert.equal(JSON.stringify(externalAgentCatalog(config)), catalogBefore);
    assert.equal(JSON.stringify(config), configBefore);
    const reviewCodex = externalAgentCatalog(config).find((agent) => agent.id === "review-codex");
    assert.equal(reviewCodex?.reasoningEffort, "high");
    assert.equal(reviewCodex?.review?.model, "gpt-review");
    assert.equal(reviewCodex?.review?.reasoningEffort, "xhigh");
    assert.equal(reviewCodex?.execution?.model, "gpt-exec");
    assert.equal(reviewCodex?.execution?.reasoningEffort, "low");
    assert.deepEqual(reviewCodex?.args, ["--profile", "work"]);

    assert.equal(isNativeCliNewSessionTarget("claude", "claude"), true);
    assert.equal(isNativeCliNewSessionTarget("codex", "codex"), true);
    assert.equal(isNativeCliNewSessionTarget("codex", "claude"), false, "a default id under the other backend is not a choice");
    assert.equal(isNativeCliNewSessionTarget("claude", "external:worker-claude"), false);
    assert.equal(isNativeCliNewSessionTarget("pi", "claude"), false);
    assert.equal(isNativeCliNewSessionTarget("codex", undefined), false);
    // Restoration maps a remembered id to its backend default (#493): the default
    // itself, or any legacy `external:<id>` — configured or not — and nothing else.
    assert.equal(nativeCliRestoreTargetId("claude", "claude"), "claude");
    assert.equal(nativeCliRestoreTargetId("codex", "codex"), "codex");
    assert.equal(nativeCliRestoreTargetId("claude", "external:worker-claude"), "claude");
    assert.equal(nativeCliRestoreTargetId("codex", "external:review-codex"), "codex");
    assert.equal(nativeCliRestoreTargetId("codex", "external:never-configured"), "codex");
    assert.equal(nativeCliRestoreTargetId("codex", "claude"), undefined, "another backend's default is not mapped");
    assert.equal(nativeCliRestoreTargetId("codex", "external:"), undefined, "a bare prefix names no worker");
    assert.equal(nativeCliRestoreTargetId("claude", "retired-target"), undefined);
    assert.equal(nativeCliRestoreTargetId("claude", "external:bad\nid"), undefined, "a malformed id is never mapped");
    assert.equal(nativeCliRestoreTargetId("pi", "external:worker-claude"), undefined);
    assert.equal(nativeCliRestoreTargetId("claude", undefined), undefined);
    assert.equal(JSON.stringify(externalAgentCatalog(config)), catalogBefore, "mapping reads no configuration");
    // An empty configuration still offers both defaults.
    assert.deepEqual(listNativeCliNewSessionTargets({} as ReviewGateConfig).map((target) => target.id), ["claude", "codex"]);
  });
});

test("default launches are bare native startup: claude adds nothing, codex keeps its TUI off the shared daemon", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    const launcher = createNativeCliLauncher(configWith({}), { platform: "darwin" });
    const workspace = join(root, "work space");
    await mkdir(workspace);
    const environment: NodeJS.ProcessEnv = { PATH: bin, HOME: "/operator/home", CLAUDE_CONFIG_DIR: "/operator/home/.claude", CODEX_HOME: "/operator/home/.codex" };

    const claude = await launcher("claude", { workspace, env: environment });
    assert.equal(claude.file, join(bin, "claude"));
    assert.deepEqual(claude.args, []);
    assert.equal(claude.cwd, workspace);
    assert.equal(claude.env.PWD, workspace);
    // Native configuration and authentication inheritance stays intact.
    assert.equal(claude.env.CLAUDE_CONFIG_DIR, "/operator/home/.claude");
    assert.equal(claude.env.HOME, "/operator/home");

    const codex = await launcher("codex", { workspace, env: environment });
    assert.equal(codex.file, join(bin, "codex"));
    // The one deliberate addition; no alt-screen, approval, sandbox, or model flag.
    assert.deepEqual(codex.args, ["--no-daemon"]);
    assert.equal(codex.env.CODEX_HOME, "/operator/home/.codex");
    // The caller's environment object is never mutated.
    assert.equal(environment.PWD, undefined);
    assert.deepEqual(Object.keys(environment).sort(), ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME", "PATH"]);
  });
});

test("explicit shared CLI targets resolve faithfully; identity and backend never fall back", async () => {
  await fixture(async (root, bin) => {
    // A wrapper keeps its prefix arguments exactly: `node wrapper.js <args>`.
    await fakeExecutable(join(bin, "node"));
    await fakeExecutable(join(bin, "codex"));
    const wrapper = join(root, "codex wrapper.js");
    await writeFile(wrapper, "// never invoked\n");
    const config = configWith({
      "host-codex": {
        adapter: "codex-cli",
        command: join(bin, "node"),
        args: [wrapper, "--profile", "host"],
        env: { CODEX_HOME: "/operator/worker-codex-home" },
        review: { args: ["--print", "--output-format", "json"], model: "gpt-review", reasoningEffort: "low", env: { REVIEW_ONLY: "1" } },
        execution: { args: ["app-server", "--listen", "stdio://"], env: { EXEC_ONLY: "1" } },
      },
      "second-codex": { adapter: "codex-cli", command: join(bin, "codex"), review: {} },
    });
    const launcher = createNativeCliLauncher(config, { platform: "linux" });
    const workspace = join(root, "workspace");
    await mkdir(workspace);

    const resolved = await launcher("codex", { workspace, env: { PATH: bin, CODEX_HOME: "/operator/home" }, targetId: "external:host-codex" });
    assert.equal(resolved.file, join(bin, "node"));
    // Shared command/base args only: the wrapper prefix survives, role overlays do not.
    assert.deepEqual(resolved.args, [wrapper, "--profile", "host", "--no-daemon"]);
    assert.equal(resolved.env.CODEX_HOME, "/operator/worker-codex-home");
    assert.equal(resolved.env.REVIEW_ONLY, undefined);
    assert.equal(resolved.env.EXEC_ONLY, undefined);

    // A missing or mismatched identity is refused, never substituted.
    await assert.rejects(launcher("codex", { workspace, env: { PATH: bin }, targetId: "external:absent" }), /is not a configured native interactive CLI target/);
    await assert.rejects(launcher("claude", { workspace, env: { PATH: bin }, targetId: "external:host-codex" }), /is a Codex CLI target and cannot launch a Claude Code session/);
    await assert.rejects(launcher("codex", { workspace, env: { PATH: bin }, targetId: "claude" }), /is a Claude Code target and cannot launch a Codex CLI session/);
    await assert.rejects(launcher("codex", { workspace, env: { PATH: bin }, targetId: "toString" }), /is not a configured native interactive CLI target/);
    await assert.rejects(launcher("gemini" as unknown as "claude", { workspace, env: { PATH: bin } }), /is not a native interactive CLI backend/);
  });
});

test("shared args that replace the TUI, bypass native approvals, or switch session/workspace are refused, not dropped", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const shared = (adapter: string, args: string[], env: Record<string, string> = {}): ReviewGateConfig =>
      configWith({ worker: { adapter, command: join(bin, adapter === "claude-cli" ? "claude" : "codex"), args, env, review: {} } });

    const cases: Array<{ label: string; config: ReviewGateConfig; backend: "claude" | "codex"; pattern: RegExp }> = [
      { label: "claude print", config: shared("claude-cli", ["--print"]), backend: "claude", pattern: /headless or service mode option --print/ },
      { label: "claude print short", config: shared("claude-cli", ["-p"]), backend: "claude", pattern: /headless or service mode option -p/ },
      { label: "claude output format alias", config: shared("claude-cli", ["--output-format=json"]), backend: "claude", pattern: /headless or service mode option --output-format/ },
      { label: "claude background supervisor", config: shared("claude-cli", ["--bg"]), backend: "claude", pattern: /headless or service mode option --bg/ },
      { label: "claude subcommand", config: shared("claude-cli", ["agents"]), backend: "claude", pattern: /headless or service mode option agents/ },
      { label: "claude bypass", config: shared("claude-cli", ["--dangerously-skip-permissions"]), backend: "claude", pattern: /approval or sandbox bypass option --dangerously-skip-permissions/ },
      { label: "claude permission mode alias", config: shared("claude-cli", ["--permission-mode=bypassPermissions"]), backend: "claude", pattern: /approval or sandbox bypass option --permission-mode/ },
      { label: "claude resume", config: shared("claude-cli", ["--resume=abc123"]), backend: "claude", pattern: /startup session\/resume selection option --resume/ },
      { label: "claude continue", config: shared("claude-cli", ["-c"]), backend: "claude", pattern: /startup session\/resume selection option -c/ },
      { label: "claude worktree", config: shared("claude-cli", ["-w", "issue-277"]), backend: "claude", pattern: /workspace scope switch option -w/ },
      { label: "claude permission prompt tool", config: shared("claude-cli", ["--permission-prompt-tool", "mcp__gate__ask"]), backend: "claude", pattern: /headless or service mode option --permission-prompt-tool/ },
      { label: "claude allow bypass", config: shared("claude-cli", ["--allow-dangerously-skip-permissions"]), backend: "claude", pattern: /approval or sandbox bypass option --allow-dangerously-skip-permissions/ },
      { label: "codex app-server subcommand", config: shared("codex-cli", ["app-server", "--listen", "stdio://"]), backend: "codex", pattern: /headless or service mode option app-server/ },
      { label: "codex exec subcommand", config: shared("codex-cli", ["exec", "task"]), backend: "codex", pattern: /headless or service mode option exec/ },
      { label: "codex remote attach", config: shared("codex-cli", ["--remote", "ws://host:1234"]), backend: "codex", pattern: /headless or service mode option --remote/ },
      { label: "codex sandbox bypass", config: shared("codex-cli", ["--sandbox=danger-full-access"]), backend: "codex", pattern: /approval or sandbox bypass option --sandbox/ },
      { label: "codex approval bypass", config: shared("codex-cli", ["--dangerously-bypass-approvals-and-sandbox"]), backend: "codex", pattern: /approval or sandbox bypass option --dangerously-bypass-approvals-and-sandbox/ },
      { label: "codex approval config key", config: shared("codex-cli", ["-c", 'approval_policy="never"']), backend: "codex", pattern: /approval or sandbox bypass option -c/ },
      { label: "codex resume subcommand", config: shared("codex-cli", ["resume", "--last"]), backend: "codex", pattern: /headless or service mode option resume/ },
      { label: "codex cd switch", config: shared("codex-cli", ["--cd", "/operator/elsewhere"]), backend: "codex", pattern: /workspace scope switch option --cd/ },
      // Compact attached forms name the same option as their split spellings.
      { label: "codex compact approval", config: shared("codex-cli", ["-anever"]), backend: "codex", pattern: /approval or sandbox bypass option -a$/ },
      { label: "codex compact sandbox", config: shared("codex-cli", ["-sdanger-full-access"]), backend: "codex", pattern: /approval or sandbox bypass option -s$/ },
      { label: "codex compact config key", config: shared("codex-cli", ['-capproval_policy="never"']), backend: "codex", pattern: /approval or sandbox bypass option -c$/ },
      { label: "codex short equals approval key", config: shared("codex-cli", ['-c=approval_policy="never"']), backend: "codex", pattern: /approval or sandbox bypass option -c$/ },
      { label: "codex short equals sandbox key", config: shared("codex-cli", ['-c=sandbox_mode="danger-full-access"']), backend: "codex", pattern: /approval or sandbox bypass option -c$/ },
      { label: "codex compact long sandbox", config: shared("codex-cli", ["--ask-for-approval=never"]), backend: "codex", pattern: /approval or sandbox bypass option --ask-for-approval$/ },
      { label: "claude compact resume", config: shared("claude-cli", ["-rsession-42"]), backend: "claude", pattern: /startup session\/resume selection option -r$/ },
    ];
    for (const item of cases) {
      const launcher = createNativeCliLauncher(item.config, { platform: "darwin" });
      await assert.rejects(
        launcher(item.backend, { workspace, env: { PATH: bin }, targetId: "external:worker" }),
        item.pattern,
        item.label,
      );
    }

    // The refusal is sanitized: no argument value, no environment value, no path.
    const leaking = createNativeCliLauncher(shared("claude-cli", ["--permission-mode=bypassPermissions"], { CLAUDE_AUTH_TOKEN: "super-secret-value" }), { platform: "darwin" });
    const error = await leaking("claude", { workspace, env: { PATH: bin, HOME: "/operator/home" }, targetId: "external:worker" }).then(() => undefined, (caught: unknown) => caught as Error);
    assert.ok(error instanceof Error);
    for (const secret of ["bypassPermissions", "super-secret-value", "/operator/home", bin]) {
      assert.ok(!error.message.includes(secret), `refusal leaked ${secret}: ${error.message}`);
    }
    assert.ok(error.message.includes("external:worker"));

    // A compact form's attached value is never echoed either.
    const compactError = await createNativeCliLauncher(shared("codex-cli", ["-sdanger-full-access"]), { platform: "darwin" })
      ("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" }).then(() => undefined, (caught: unknown) => caught as Error);
    assert.ok(compactError instanceof Error);
    assert.ok(!compactError.message.includes("danger-full-access"), compactError.message);

    // A documented option's operand is data: `--profile review` stays a profile
    // selection, while a bare `review` still replaces the interactive TUI.
    const codexArgv = async (args: string[]): Promise<string[]> =>
      (await createNativeCliLauncher(shared("codex-cli", args), { platform: "darwin" })("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" })).args;
    const claudeArgv = async (args: string[]): Promise<string[]> =>
      (await createNativeCliLauncher(shared("claude-cli", args), { platform: "darwin" })("claude", { workspace, env: { PATH: bin }, targetId: "external:worker" })).args;
    assert.deepEqual(await codexArgv(["--profile", "review"]), ["--profile", "review", "--no-daemon"]);
    assert.deepEqual(await codexArgv(["--profile=review"]), ["--profile=review", "--no-daemon"]);
    assert.deepEqual(await codexArgv(['-c=model_reasoning_effort="high"']), ['-c=model_reasoning_effort="high"', "--no-daemon"]);
    assert.deepEqual(await codexArgv(["-p", "review"]), ["-p", "review", "--no-daemon"]);
    assert.deepEqual(await claudeArgv(["--name", "agents"]), ["--name", "agents"]);
    await assert.rejects(codexArgv(["review"]), /headless or service mode option review/);
    await assert.rejects(claudeArgv(["agents"]), /headless or service mode option agents/);

    // `--` is the provider's own option boundary: the isolation flag occupies a
    // real option position before it, and a post-terminator `--no-daemon` is
    // prompt text that never substitutes for the option.
    assert.deepEqual(await codexArgv(["--"]), ["--no-daemon", "--"]);
    assert.deepEqual(await codexArgv(["--", "--no-daemon"]), ["--no-daemon", "--", "--no-daemon"]);
    assert.deepEqual(await codexArgv(["--profile", "host", "--", "fix the bug"]), ["--profile", "host", "--no-daemon", "--", "fix the bug"]);
    assert.deepEqual(await codexArgv(["--no-daemon", "--"]), ["--no-daemon", "--"]);
    // Past the terminator the provider never parses options at all, so a token
    // that only happens to spell an option or a subcommand is literal prompt
    // data: it is forwarded exactly, never refused and never dropped.
    assert.deepEqual(await claudeArgv(["--", "--print"]), ["--", "--print"]);
    assert.deepEqual(await claudeArgv(["--", "--dangerously-skip-permissions", "agents"]), ["--", "--dangerously-skip-permissions", "agents"]);
    assert.deepEqual(await codexArgv(["--", "app-server"]), ["--no-daemon", "--", "app-server"]);
    assert.deepEqual(await codexArgv(["--", "-c", 'approval_policy="never"']), ["--no-daemon", "--", "-c", 'approval_policy="never"']);
    // The boundary is the first `--` only; a later one is data too, while real
    // option position before the boundary still refuses.
    assert.deepEqual(await codexArgv(["--", "--", "review"]), ["--no-daemon", "--", "--", "review"]);
    // An empty prompt token past the boundary is data like any other.
    assert.deepEqual(await claudeArgv(["--", ""]), ["--", ""]);
    assert.deepEqual(await codexArgv(["--", ""]), ["--no-daemon", "--", ""]);
    assert.deepEqual(await codexArgv(["--", "", "review"]), ["--no-daemon", "--", "", "review"]);
    // A dangling value option never swallows the isolation flag as its operand,
    // whether it ends the shared args or faces the terminator.
    assert.deepEqual(await codexArgv(["--profile"]), ["--no-daemon", "--profile"]);
    assert.deepEqual(await codexArgv(["--profile", "--"]), ["--no-daemon", "--profile", "--"]);
    assert.deepEqual(await codexArgv(["--model", "gpt", "--profile", "--"]), ["--model", "gpt", "--no-daemon", "--profile", "--"]);
    await assert.rejects(codexArgv(["app-server", "--", "review"]), /headless or service mode option app-server/);
    await assert.rejects(claudeArgv(["--permission-mode", "plan", "--", "review"]), /approval or sandbox bypass option --permission-mode/);

    // Narrowness: an ordinary shared preference is inherited unchanged, and a
    // Codex `-c` assignment that names no approval or sandbox policy stays.
    const permissive = createNativeCliLauncher(shared("codex-cli", ["-c", 'model_reasoning_effort="high"']), { platform: "darwin" });
    const allowed = await permissive("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" });
    assert.deepEqual(allowed.args, ["-c", 'model_reasoning_effort="high"', "--no-daemon"]);

    // A configured `--no-daemon` is honored once, never duplicated.
    const already = createNativeCliLauncher(shared("codex-cli", ["--no-daemon"]), { platform: "darwin" });
    assert.deepEqual((await already("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" })).args, ["--no-daemon"]);

    // A shell command string is refused; a real path with spaces is not.
    const commandString = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: "codex --print", review: {} },
    }), { platform: "darwin" });
    await assert.rejects(commandString("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" }), /shell command string rather than a single executable filename/);
    const spaced = join(root, "bin", "claude native");
    await fakeExecutable(spaced);
    const spacedLauncher = createNativeCliLauncher(configWith({
      worker: { adapter: "claude-cli", command: spaced, review: {} },
    }), { platform: "darwin" });
    assert.equal((await spacedLauncher("claude", { workspace, env: { PATH: bin }, targetId: "external:worker" })).file, spaced);
  });
});

test("explicitly selected shared settings, MCP, plugin, and agent arguments are the operator's configuration and are forwarded unchanged", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const launcherFor = (adapter: "claude-cli" | "codex-cli", args: string[]) =>
      createNativeCliLauncher(configWith({
        worker: {
          adapter,
          command: join(bin, adapter === "claude-cli" ? "claude" : "codex"),
          args,
          review: {},
        },
      }), { platform: "darwin" });
    const claudeArgv = async (args: string[]): Promise<string[]> =>
      (await launcherFor("claude-cli", args)("claude", { workspace, env: { PATH: bin }, targetId: "external:worker" })).args;
    const codexArgv = async (args: string[]): Promise<string[]> =>
      (await launcherFor("codex-cli", args)("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" })).args;

    // Selecting a settings layer, an MCP configuration, a plugin directory, an
    // agent definition, or an appended prompt is the operator configuring the
    // very target they picked: every token survives in order.
    const configured = [
      "--settings", "/operator/claude settings.json",
      "--setting-sources", "user,project",
      "--mcp-config", "/operator/mcp.json",
      "--strict-mcp-config",
      "--plugin-dir", "/operator/plugins",
      "--agents", '{"reviewer":{"model":"sonnet"}}',
      "--append-system-prompt", "Reply in British English",
      "--bare", "--restricted", "--safe-mode",
    ];
    assert.deepEqual(await claudeArgv(configured), configured);
    // An attached spelling works, and a configuration value that happens to
    // spell a subcommand stays data because its option takes a value.
    assert.deepEqual(await claudeArgv(["--mcp-config=/operator/mcp.json", "--agents", "plugin"]), ["--mcp-config=/operator/mcp.json", "--agents", "plugin"]);
    // An empty operand is data the provider itself defines: `--setting-sources ""`
    // selects no settings layer, exactly like the attached `--setting-sources=`.
    assert.deepEqual(await claudeArgv(["--setting-sources", ""]), ["--setting-sources", ""]);
    assert.deepEqual(await claudeArgv(["--setting-sources="]), ["--setting-sources="]);
    assert.deepEqual(await claudeArgv(["--mcp-config", "", "--settings", "/operator/s.json"]), ["--mcp-config", "", "--settings", "/operator/s.json"]);
    // An empty token that names neither an option nor an operand stays refused.
    await assert.rejects(claudeArgv([""]), /not a printable non-empty string/);
    await assert.rejects(claudeArgv(["--settings", "/operator/s.json", ""]), /not a printable non-empty string/);
    // The genuine refusals next to them are untouched.
    await assert.rejects(claudeArgv(["--settings", "/operator/s.json", "--dangerously-skip-permissions"]), /approval or sandbox bypass option --dangerously-skip-permissions/);
    await assert.rejects(claudeArgv(["--mcp-config", "/operator/mcp.json", "--resume", "abc"]), /startup session\/resume selection option --resume/);
    await assert.rejects(claudeArgv(["--plugin-dir", "/operator/plugins", "-p"]), /headless or service mode option -p/);
    await assert.rejects(claudeArgv(["--add-dir", "/elsewhere"]), /workspace scope switch option --add-dir/);
    // Codex keeps the same posture: its `-c` configuration channel stays open
    // for everything except an approval or sandbox policy.
    assert.deepEqual(await codexArgv(["-c", 'model_provider="corp"']), ["-c", 'model_provider="corp"', "--no-daemon"]);
    await assert.rejects(codexArgv(["-c", 'approval_policy="never"']), /approval or sandbox bypass option -c/);
    await assert.rejects(codexArgv(["--dangerously-bypass-hook-trust"]), /approval or sandbox bypass option --dangerously-bypass-hook-trust/);
  });
});

test("a relative configured command resolves in the selected workspace, never the host process cwd", async () => {
  await fixture(async (root, bin) => {
    // Two workspaces carry the SAME relative spellings. Neither name exists
    // beside the host process cwd, so a successful resolution is proof of the
    // anchor — the directory the host spawns the child in.
    const first = join(root, "workspace one");
    const second = join(root, "workspace two");
    await mkdir(join(first, "tools"), { recursive: true });
    await mkdir(join(second, "tools"), { recursive: true });
    await fakeExecutable(join(first, "wrapper"));
    await fakeExecutable(join(second, "wrapper"));
    await fakeExecutable(join(first, "tools", "relcodex"));
    await fakeExecutable(join(second, "tools", "relcodex"));

    const launcher = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: "./wrapper", review: {} },
    }), { platform: "linux" });
    const launchedFirst = await launcher("codex", { workspace: first, env: { PATH: bin }, targetId: "external:worker" });
    assert.equal(launchedFirst.file, join(first, "wrapper"));
    assert.equal(launchedFirst.cwd, first);
    // The same explicitly selected target in another workspace sees that
    // workspace's own wrapper: no confusion between the two.
    const launchedSecond = await launcher("codex", { workspace: second, env: { PATH: bin }, targetId: "external:worker" });
    assert.equal(launchedSecond.file, join(second, "wrapper"));
    assert.equal(launchedSecond.cwd, second);

    // A relative PATH entry is anchored the same way.
    const relativePathLauncher = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: "relcodex", review: {} },
    }), { platform: "linux" });
    const viaRelativePath = await relativePathLauncher("codex", { workspace: second, env: { PATH: "tools" }, targetId: "external:worker" });
    assert.equal(viaRelativePath.file, join(second, "tools", "relcodex"));

    // A workspace without the spelling refuses; the host process cwd is never
    // searched as a fallback, and no substitution happens.
    const empty = join(root, "empty workspace");
    await mkdir(empty);
    await assert.rejects(launcher("codex", { workspace: empty, env: { PATH: bin }, targetId: "external:worker" }), /executable for target "external:worker" was not found/);

    // A `..` written after a symlinked directory is a filesystem question, not a
    // lexical one: workspace/link -> other/subdir, and only other/ carries a
    // wrapper — the exact file the spawn in that workspace runs.
    const other = join(root, "other");
    await mkdir(join(other, "subdir"), { recursive: true });
    await fakeExecutable(join(other, "wrapper"));
    const linkedWorkspace = join(root, "linked workspace");
    await mkdir(linkedWorkspace);
    await symlink(join(other, "subdir"), join(linkedWorkspace, "link"));
    const throughLink = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: "./link/../wrapper", review: {} },
    }), { platform: "linux" });
    const resolvedThroughLink = await throughLink("codex", { workspace: linkedWorkspace, env: { PATH: bin }, targetId: "external:worker" });
    assert.equal(resolvedThroughLink.file, join(other, "wrapper"));
    assert.equal(resolvedThroughLink.cwd, linkedWorkspace);
  });
});

test("the Windows batch descriptor delegates interpreter trust to the shipped launcher's one resolver", async () => {
  await fixture(async (root, bin) => {
    await writeFile(join(bin, "codex.cmd"), "@echo off\r\n");
    await chmod(join(bin, "codex.cmd"), 0o755);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const trusted = "Z:\\Fixture Windows Root\\System32\\cmd.exe";
    const shipped = helperModule.resolveTrustedWindowsCmd;
    assert.equal(typeof shipped, "function", "the shipped launcher exports the one trusted resolver");
    const received: Array<NodeJS.ProcessEnv | undefined> = [];
    // Same module instance the adapter requires, so this observes the adapter's
    // own call. Nothing is spawned and no Windows path is touched.
    helperModule.resolveTrustedWindowsCmd = (parentEnvironment?: NodeJS.ProcessEnv) => {
      received.push(parentEnvironment);
      return trusted;
    };
    try {
      const launcher = createNativeCliLauncher(configWith({}), {
        platform: "win32",
        parentEnvironment: { SystemRoot: "Z:\\Fixture Windows Root" },
      });
      const descriptor = await launcher("codex", { workspace, env: { PATH: bin, ComSpec: join(bin, "cmd.exe") } });
      assert.equal(descriptor.file, trusted);
      assert.equal(received.length, 1, "the adapter asks the shipped resolver instead of resolving an interpreter itself");
      // Exactly the PARENT environment is handed over — never the child's.
      assert.deepEqual(received[0], { SystemRoot: "Z:\\Fixture Windows Root" });
      // Quoting also stays the shipped helper's single implementation, and the
      // batch invocation goes out in the pinned spawn's public pre-escaped
      // command-line form: cmd.exe needs those outer quotes verbatim, so the
      // argv array stays empty instead of being re-escaped by the PTY.
      assert.deepEqual(descriptor.args, [], "a batch child is never delivered as argv");
      assert.equal(descriptor.commandLine,
        `/d /s /v:off /c "${helperModule.cmdQuote(join(bin, "codex.cmd"))} ${helperModule.cmdQuote("--no-daemon")}"`);
      assert.equal(descriptor.cwd, workspace);
    } finally {
      helperModule.resolveTrustedWindowsCmd = shipped;
    }
  });
});

test("a percent-bearing Windows batch argument is delivered as one carrier expansion cmd.exe clears before the shim runs", async () => {
  await fixture(async (root, bin) => {
    const shim = join(bin, "codex.cmd");
    await writeFile(shim, "@echo off\r\n");
    await chmod(shim, 0o755);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const trusted = "Z:\\Fixture Windows Root\\System32\\cmd.exe";
    const shipped = helperModule.resolveTrustedWindowsCmd;
    helperModule.resolveTrustedWindowsCmd = () => trusted;
    // Spaces, quotes, a redirection operator, a trailing backslash, and every
    // percent shape that fires in a cmd or batch context (a defined-looking
    // reference, a stray pair, and the parameter/dynamic forms) ride the same
    // delivery, alongside the delayed-expansion forms `/v:off` keeps literal.
    const configured = [
      "--profile", "%PRG_SYNTH_INHERITED%",
      "--label", '100%PI% & echo PWNED',
      "--params", "%1 %~dp0 %* %ERRORLEVEL%",
      "--dir", "C:\\operator\\",
      "--quote", 'say "%HOME%" & hi',
      "--bangs", "!PRG_SYNTH_INHERITED! a!b!c",
    ];
    try {
      const launcher = createNativeCliLauncher(configWith({
        worker: { adapter: "codex-cli", command: "codex", args: configured, review: {} },
      }), { platform: "win32", parentEnvironment: { SystemRoot: "Z:\\Fixture Windows Root" } });
      const descriptor = await launcher("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" });

      // cmd.exe expands %NAME% while it reads the /c command line and offers no
      // escape, so a percent is never typed there: it is carried by one internal
      // variable whose whole value is the percent sign it delivers.
      const carrier = "PRG_NATIVE_BATCH_PCT_0";
      const carriers = Object.keys(descriptor.env).filter((name) => /^PRG_NATIVE_BATCH_PCT_\d+$/u.test(name));
      assert.deepEqual(carriers, [carrier], "one canonical carrier spelling, and no other transport metadata");
      assert.equal(descriptor.env[carrier], "%", "the carrier's whole value is the percent sign it delivers");

      const quoteWith = (name: string) => (token: string): string => helperModule.cmdQuote(token.replace(/%/gu, `%${name}%`));
      assert.equal(descriptor.commandLine,
        `/d /s /v:off /c "set "${carrier}=" & ${[shim, ...configured, "--no-daemon"].map(quoteWith(carrier)).join(" ")}"`,
        "every percent becomes one carrier reference and the same line clears it before the shim runs");

      // The carrier belongs to the product only while cmd.exe needs it, and it
      // never costs a valid launch a refusal: with every low-numbered slot
      // already owned by the environment, the carrier takes the next free name
      // and leaves all 64 operator values exactly as they were.
      const owned = Object.fromEntries(
        Array.from({ length: 64 }, (_unused, index) => [`PRG_NATIVE_BATCH_PCT_${index}`, `operator-owned-${index}`]),
      );
      const occupied = await launcher("codex", { workspace, env: { PATH: bin, ...owned }, targetId: "external:worker" });
      assert.deepEqual(Object.keys(occupied.env).filter((name) => /^PRG_NATIVE_BATCH_PCT_\d+$/u.test(name)),
        [...Object.keys(owned), "PRG_NATIVE_BATCH_PCT_64"], "the carrier takes the first free name past every occupied slot");
      for (const [name, value] of Object.entries(owned)) {
        assert.equal(occupied.env[name], value, `${name} survives untouched`);
      }
      assert.equal(occupied.commandLine,
        `/d /s /v:off /c "set "PRG_NATIVE_BATCH_PCT_64=" & ${[shim, ...configured, "--no-daemon"].map(quoteWith("PRG_NATIVE_BATCH_PCT_64")).join(" ")}"`,
        "only the product's own carrier is referenced and cleared");

      // Percent-free batch delivery stays exactly what it was: byte-identical
      // text, no carrier variable, no clearance.
      const plainLauncher = createNativeCliLauncher(configWith({}), {
        platform: "win32",
        parentEnvironment: { SystemRoot: "Z:\\Fixture Windows Root" },
      });
      const plain = await plainLauncher("codex", { workspace, env: { PATH: bin } });
      assert.deepEqual(Object.keys(plain.env).filter((name) => /^PRG_NATIVE_BATCH_PCT_/u.test(name)), []);
      assert.equal(plain.commandLine,
        `/d /s /v:off /c "${helperModule.cmdQuote(shim)} ${helperModule.cmdQuote("--no-daemon")}"`,
        "a percent-free batch child carries no transport metadata at all");
    } finally {
      helperModule.resolveTrustedWindowsCmd = shipped;
    }
  });
});

test("the adapter keeps no second Windows cmd detector or interpreter validator", () => {
  // The batch rendering lives in the shared Claude/Codex launch preparation
  // (#682/#756); neither file may grow a detector of its own.
  const source = readFileSync(resolve("src/session-host/native-cli-launch.ts"), "utf8");
  const shared = readFileSync(resolve("src/cli-launch-preparation.ts"), "utf8");
  for (const text of [source, shared]) {
    assert.doesNotMatch(text, /isFullyQualifiedWindowsPath/u, "no duplicated fully-qualified-path detector");
    assert.doesNotMatch(text, /win32Path|path\.win32|win32 as /u, "no Windows path handling of its own: the launcher owns it");
  }
  assert.match(source, /from "\.\.\/cli-launch-preparation"/u, "the native adapter renders through the shared preparation");
  assert.doesNotMatch(source, /resolveTrustedWindowsCmd\(|commandLine: `\/d/u, "no batch rendering of its own");
  assert.match(shared, /helpers\.resolveTrustedWindowsCmd\(parentEnvironment\)/u, "the shipped launcher's trusted resolver is the authority");
  assert.match(shared, /require\(launcherHelperPath\(refuse\)\)/u, "quoting and interpreter trust load from the one shipped helper module");
});

test("the descriptor environment is a sanitized clone: role authorization rejects, stale host capabilities strip, native inheritance survives", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const settlement = ["SECRET", "PATH", "SESSION", "CHILD"] as const;
    const inherited: NodeJS.ProcessEnv = {
      PATH: bin,
      HOME: "/operator/home",
      SHELL: "/bin/zsh",
      NODE_OPTIONS: "--enable-source-maps --require /operator/own-preload.js",
      PI_REVIEW_GATE_DISABLED: "1",
      PI_IMAGE_PROTOCOL: "kitty",
      ANTHROPIC_API_KEY: "inherited-native-credential",
      [SESSION_HOST_BOOTSTRAP_ENV]: "stale-bootstrap-token",
      [NODE_OPTIONS_RESTORE_ENV]: "stale-restore-frame",
      [SESSION_HOST_STARTUP_REQUEST_ENV]: "stale-startup-request",
      [SESSION_HOST_TITLE_COLUMNS_ENV]: "120",
      PI_REVIEW_GATE_BUNDLE_DIR: "/operator/bundle",
      PI_EXTRA_EXTENSIONS: "/operator/extra",
    };
    for (const suffix of settlement) {
      inherited[`PI_REVIEW_GATE_SETTLEMENT_${suffix}`] = `stale-settlement-${suffix}`;
      inherited[`PI_REVIEW_GATE_QUIESCENCE_${suffix}`] = `stale-quiescence-${suffix}`;
    }

    const launcher = createNativeCliLauncher(configWith({}), { platform: "darwin" });
    const descriptor = await launcher("claude", { workspace, env: inherited });

    // Stripped host-only capabilities.
    for (const name of [
      SESSION_HOST_BOOTSTRAP_ENV, NODE_OPTIONS_RESTORE_ENV, SESSION_HOST_STARTUP_REQUEST_ENV, SESSION_HOST_TITLE_COLUMNS_ENV,
    ]) assert.equal(descriptor.env[name], undefined, name);
    for (const suffix of settlement) {
      assert.equal(descriptor.env[`PI_REVIEW_GATE_SETTLEMENT_${suffix}`], undefined);
      assert.equal(descriptor.env[`PI_REVIEW_GATE_QUIESCENCE_${suffix}`], undefined);
    }
    // Preserved: the user's own NODE_OPTIONS exactly, native config/auth, and
    // the deliberate kill switch. No Pi preload, bootstrap, title, or worker
    // capability is added, and no Pi configuration is initialized.
    assert.equal(descriptor.env.NODE_OPTIONS, "--enable-source-maps --require /operator/own-preload.js");
    assert.equal(descriptor.env.PI_REVIEW_GATE_DISABLED, "1");
    assert.equal(descriptor.env.PI_IMAGE_PROTOCOL, "kitty");
    assert.equal(descriptor.env.ANTHROPIC_API_KEY, "inherited-native-credential");
    assert.equal(descriptor.env.HOME, "/operator/home");
    assert.equal(descriptor.env.PWD, workspace);
    // The caller's object is untouched.
    assert.equal(inherited[SESSION_HOST_BOOTSTRAP_ENV], "stale-bootstrap-token");

    // Worker role authorization rejects fail-closed, and a configured overlay
    // can never reintroduce a stripped capability.
    await assert.rejects(launcher("claude", { workspace, env: { ...inherited, [RUNTIME_ROLE_ENV]: "executor" } }), new RegExp(RUNTIME_ROLE_ENV));
    await assert.rejects(launcher("claude", { workspace, env: { ...inherited, [EXECUTOR_TOOL_CATALOG_ENV]: "catalog" } }), new RegExp(EXECUTOR_TOOL_CATALOG_ENV));
    const laundering = createNativeCliLauncher(configWith({
      worker: { adapter: "claude-cli", command: join(bin, "claude"), env: { [RUNTIME_ROLE_ENV]: "executor" }, review: {} },
    }), { platform: "darwin" });
    await assert.rejects(laundering("claude", { workspace, env: { PATH: bin }, targetId: "external:worker" }), new RegExp(RUNTIME_ROLE_ENV));
    const staleOverlay = createNativeCliLauncher(configWith({
      worker: { adapter: "claude-cli", command: join(bin, "claude"), env: { [SESSION_HOST_BOOTSTRAP_ENV]: "x", PI_WORKER_HINT: "kept" }, review: {} },
    }), { platform: "darwin" });
    const overlaid = await staleOverlay("claude", { workspace, env: { PATH: bin }, targetId: "external:worker" });
    assert.equal(overlaid.env[SESSION_HOST_BOOTSTRAP_ENV], undefined);
    assert.equal(overlaid.env.PI_WORKER_HINT, "kept");
  });
});

test("a hosted Codex child gets the HERDR_ENV=1 terminal clipboard compatibility marker, Claude gets none, and nothing above the descriptor mutates", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const hostValueBefore = process.env.HERDR_ENV;
    const parentEnvironment: NodeJS.ProcessEnv = { SystemRoot: "Z:\\Fixture Windows Root" };
    const launcher = createNativeCliLauncher(configWith({
      "host-codex": {
        adapter: "codex-cli",
        command: join(bin, "codex"),
        args: ["--profile", "host"],
        // A configured value for this one key loses to the host-owned mode on
        // purpose; every other configured entry survives unchanged.
        env: { HERDR_ENV: "0", CODEX_HOME: "/operator/worker-codex-home" },
        review: {},
      },
      "host-claude": {
        adapter: "claude-cli",
        command: join(bin, "claude"),
        // Claude gets no injected marker and no scrubbing either: an operator's
        // own value passes through verbatim.
        env: { HERDR_ENV: "operator-own-value" },
        review: {},
      },
    }), { platform: "darwin", parentEnvironment });
    const requestEnvironment: NodeJS.ProcessEnv = {
      PATH: bin,
      HOME: "/operator/home",
      CODEX_HOME: "/operator/home/.codex",
      CLAUDE_CONFIG_DIR: "/operator/home/.claude",
      // A preexisting inherited value for the same key loses; the differently
      // cased spelling is an unrelated POSIX variable of the operator's.
      HERDR_ENV: "0",
      herdr_env: "operator-own-posix-variable",
      // No spoofing and no scrubbing: multiplexer and SSH inheritance stays
      // exactly as the operator's environment has it.
      SSH_TTY: "/dev/ttys004",
      SSH_CONNECTION: "192.0.2.1 5000 198.51.100.2 22",
      TMUX: "/private/tmp/tmux-501/default,1234,0",
      STY: "777.pts-0.host",
    };
    const requestSnapshot = { ...requestEnvironment };

    const codex = await launcher("codex", { workspace, env: requestEnvironment });
    assert.equal(codex.env.HERDR_ENV, "1", "the built-in Codex child gets the host-owned clipboard mode");
    // POSIX environment names stay case-sensitive: only the exact canonical key
    // is the mode, and the operator's other spelling is untouched.
    assert.equal(codex.env.herdr_env, "operator-own-posix-variable");
    // Everything else about the launch is exactly what it was before.
    assert.deepEqual(codex.args, ["--no-daemon"]);
    assert.equal(codex.env.CODEX_HOME, "/operator/home/.codex");
    assert.equal(codex.env.PWD, workspace);
    assert.equal(codex.env.SSH_TTY, "/dev/ttys004");
    assert.equal(codex.env.SSH_CONNECTION, "192.0.2.1 5000 198.51.100.2 22");
    assert.equal(codex.env.TMUX, "/private/tmp/tmux-501/default,1234,0");
    assert.equal(codex.env.STY, "777.pts-0.host");

    // An explicitly configured Codex target gets the marker too, overriding only
    // that target's own conflicting value for this one key.
    const configured = await launcher("codex", { workspace, env: { PATH: bin }, targetId: "external:host-codex" });
    assert.equal(configured.env.HERDR_ENV, "1", "a configured Codex target's conflicting value loses");
    assert.equal(configured.env.CODEX_HOME, "/operator/worker-codex-home");
    assert.deepEqual(configured.args, ["--profile", "host", "--no-daemon"]);

    // Claude receives no marker on either the default or a configured target: the
    // inherited value survives untouched, and a configured one survives verbatim.
    const claude = await launcher("claude", { workspace, env: requestEnvironment });
    assert.equal(claude.env.HERDR_ENV, "0", "no marker is injected into a Claude child");
    assert.equal(claude.env.herdr_env, "operator-own-posix-variable");
    assert.equal(claude.env.PWD, workspace);
    const configuredClaude = await launcher("claude", { workspace, env: { PATH: bin }, targetId: "external:host-claude" });
    assert.equal(configuredClaude.env.HERDR_ENV, "operator-own-value", "a configured Claude value is neither injected nor scrubbed");

    // Parent isolation: the caller's request object, the launcher options, and the
    // host process environment all come back unchanged.
    assert.deepEqual(requestEnvironment, requestSnapshot);
    assert.deepEqual(parentEnvironment, { SystemRoot: "Z:\\Fixture Windows Root" });
    if (hostValueBefore === undefined) assert.equal(process.env.HERDR_ENV, undefined);
    else assert.equal(process.env.HERDR_ENV, hostValueBefore);
  });
});

test("the Windows Codex descriptor carries one canonical HERDR_ENV spelling while its batch delivery stays byte-identical", async () => {
  await fixture(async (root, bin) => {
    for (const shim of ["codex.cmd", "claude.cmd"]) {
      await writeFile(join(bin, shim), "@echo off\r\n");
      await chmod(join(bin, shim), 0o755);
    }
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const trusted = "Z:\\Fixture Windows Root\\System32\\cmd.exe";
    const shipped = helperModule.resolveTrustedWindowsCmd;
    helperModule.resolveTrustedWindowsCmd = () => trusted;
    try {
      const parentEnvironment: NodeJS.ProcessEnv = { SystemRoot: "Z:\\Fixture Windows Root" };
      const launcher = createNativeCliLauncher(configWith({
        "win-codex": {
          adapter: "codex-cli",
          command: "codex",
          args: ["--profile", "host profile"],
          env: { HERDR_ENV: "0", CODEX_HOME: "C:\\operator\\worker-home" },
          review: {},
        },
      }), { platform: "win32", parentEnvironment });

      const requestEnvironment: NodeJS.ProcessEnv = { PATH: bin, herdr_env: "inherited-lowercase", TMUX: "/tmp/tmux-501/default,1,0" };
      const requestSnapshot = { ...requestEnvironment };
      const descriptor = await launcher("codex", { workspace, env: requestEnvironment, targetId: "external:win-codex" });

      assert.equal(descriptor.env.HERDR_ENV, "1");
      // Exactly one canonical Windows spelling for this key: the child can never
      // resolve a second case variant either way.
      assert.deepEqual(Object.keys(descriptor.env).filter((name) => name.toUpperCase() === "HERDR_ENV"), ["HERDR_ENV"]);
      assert.equal(descriptor.env.herdr_env, undefined, "the inherited alias spelling is not carried alongside the canonical key");
      // The rest of the Windows composition is unchanged.
      assert.equal(descriptor.env.CODEX_HOME, "C:\\operator\\worker-home");
      assert.equal(descriptor.env.PATH, bin);
      assert.equal(descriptor.env.PWD, workspace);
      assert.equal(descriptor.env.TMUX, "/tmp/tmux-501/default,1,0");
      // Batch delivery stays exactly as before: the trusted parent cmd.exe, no
      // argv, and one pre-escaped command line with the one deliberate option.
      assert.equal(descriptor.file, trusted);
      assert.deepEqual(descriptor.args, []);
      assert.equal(descriptor.commandLine,
        `/d /s /v:off /c "${helperModule.cmdQuote(join(bin, "codex.cmd"))} ${helperModule.cmdQuote("--profile")} ${helperModule.cmdQuote("host profile")} ${helperModule.cmdQuote("--no-daemon")}"`);
      assert.equal(descriptor.cwd, workspace);
      assert.deepEqual(requestEnvironment, requestSnapshot);
      assert.deepEqual(parentEnvironment, { SystemRoot: "Z:\\Fixture Windows Root" });

      // A built-in Windows Claude child gets no marker at all, and its delivery
      // is unchanged.
      const claude = await launcher("claude", { workspace, env: { PATH: bin } });
      assert.deepEqual(Object.keys(claude.env).filter((name) => name.toUpperCase() === "HERDR_ENV"), []);
      assert.equal(claude.commandLine, `/d /s /v:off /c "${helperModule.cmdQuote(join(bin, "claude.cmd"))}"`);
    } finally {
      helperModule.resolveTrustedWindowsCmd = shipped;
    }
  });
});

test("the workspace is absolute, existing, and canonical; a missing executable refuses with no substitution", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const linked = join(root, "workspace-link");
    await symlink(workspace, linked);
    const launcher = createNativeCliLauncher(configWith({}), { platform: "linux" });

    await assert.rejects(launcher("codex", { workspace: "relative/workspace", env: { PATH: bin } }), /must be an absolute path/);
    await assert.rejects(launcher("codex", { workspace: join(root, "missing"), env: { PATH: bin } }), /does not exist as a readable directory/);
    await assert.rejects(launcher("codex", { workspace: join(bin, "codex"), env: { PATH: bin } }), /is not a directory/);
    assert.equal((await launcher("codex", { workspace: linked, env: { PATH: bin } })).cwd, workspace);

    const emptyPath = createNativeCliLauncher(configWith({}), { platform: "linux" });
    await assert.rejects(emptyPath("codex", { workspace, env: { PATH: "" } }), /the codex executable for target "codex" was not found/);
    // An explicit configured path is honored exactly as given: PATH is never
    // consulted for it, so a bogus PATH still launches the configured file.
    const configured = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: join(bin, "codex"), review: {} },
    }), { platform: "linux" });
    assert.equal((await configured("codex", { workspace, env: { PATH: join(root, "nowhere") }, targetId: "external:worker" })).file, join(bin, "codex"));
    // A bare configured name that is absent refuses without dumping the
    // searched PATH or any other path.
    const missing = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: "codex-not-installed", review: {} },
    }), { platform: "linux" });
    const notFound = await missing("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" }).then(() => undefined, (caught: unknown) => caught as Error);
    assert.ok(notFound instanceof Error);
    assert.match(notFound.message, /the codex-not-installed executable for target "external:worker" was not found/);
    assert.ok(!notFound.message.includes(bin));
  });
});

test("Windows descriptors use PATHEXT discovery, one canonical environment spelling, and the trusted parent cmd.exe for .cmd shims", async () => {
  await fixture(async (root, bin) => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(bin, "codex.cmd"), "@echo off\r\n");
    await chmod(join(bin, "codex.cmd"), 0o755);
    // A cmd.exe the CHILD could point at through ComSpec or PATH: never used.
    await writeFile(join(bin, "cmd.exe"), "not the trusted interpreter\n");
    await chmod(join(bin, "cmd.exe"), 0o755);

    const launcher = createNativeCliLauncher(configWith({}), { platform: "win32", parentEnvironment: {} });
    const notFound = await launcher("codex", {
      workspace,
      env: { Path: bin, ComSpec: join(bin, "cmd.exe"), PATH: bin },
    }).then(() => undefined, (caught: unknown) => caught as Error);
    assert.ok(notFound instanceof Error);
    // The shim is found by PATHEXT, but no trusted interpreter exists, so the
    // launch refuses instead of selecting the child's ComSpec or a PATH cmd.
    assert.match(notFound.message, /cmd\.exe was not found under the parent process's absolute Windows SystemRoot/);

    // A fully qualified but non-existent SystemRoot is refused the same way.
    const badRoot = createNativeCliLauncher(configWith({}), { platform: "win32", parentEnvironment: { SystemRoot: "C:\\definitely-not-here" } });
    await assert.rejects(badRoot("codex", { workspace, env: { PATH: bin } }), /SystemRoot/);
    // A relative SystemRoot spelling is never trusted.
    const relativeRoot = createNativeCliLauncher(configWith({}), { platform: "win32", parentEnvironment: { systemroot: join(root, "sysroot") } });
    await assert.rejects(relativeRoot("codex", { workspace, env: { PATH: bin } }), /SystemRoot/);
  });
});

test("a Windows shared-environment overlay cannot launder role authorization through case aliases", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const launcherFor = (env: Record<string, string>) => createNativeCliLauncher(configWith({
      worker: { adapter: "claude-cli", command: join(bin, "claude"), env, review: {} },
    }), { platform: "win32" });
    const attempt = (env: Record<string, string>) => launcherFor(env)("claude", { workspace, env: { PATH: bin }, targetId: "external:worker" });
    const roleAliases: Array<[string, Record<string, string>]> = [
      ["marker then empty alias", { [RUNTIME_ROLE_ENV]: "executor", [RUNTIME_ROLE_ENV.toLowerCase()]: "" }],
      ["empty alias then marker", { [RUNTIME_ROLE_ENV.toLowerCase()]: "", [RUNTIME_ROLE_ENV]: "executor" }],
      ["marker then empty alias (catalog)", { [EXECUTOR_TOOL_CATALOG_ENV]: "catalog", [EXECUTOR_TOOL_CATALOG_ENV.toLowerCase()]: "" }],
      ["empty alias then marker (catalog)", { [EXECUTOR_TOOL_CATALOG_ENV.toLowerCase()]: "", [EXECUTOR_TOOL_CATALOG_ENV]: "catalog" }],
      ["empty alias plus marker in mixed spellings", { [RUNTIME_ROLE_ENV.toLowerCase()]: "", [EXECUTOR_TOOL_CATALOG_ENV]: "catalog", [EXECUTOR_TOOL_CATALOG_ENV.toLowerCase()]: "" }],
    ];
    for (const [label, env] of roleAliases) {
      await assert.rejects(attempt(env), /PI_REVIEW_GATE_(RUNTIME_ROLE|EXECUTOR_TOOL_CATALOG)/, label);
    }
    // Conflicting non-empty variants refuse instead of silently selecting one.
    await assert.rejects(attempt({ PI_WORKER_HINT: "one", pi_worker_hint: "two" }), /conflicting case variants/);
    // A single unambiguous overlay still merges into the canonical spelling.
    const merged = await attempt({ pi_worker_hint: "kept", Codex_Home: "C:\\operator\\worker-home" });
    assert.equal(merged.env.PI_WORKER_HINT, "kept");
    assert.equal(merged.env.CODEX_HOME, "C:\\operator\\worker-home");
    assert.equal(merged.env.pi_worker_hint, undefined);
    assert.equal(merged.env.Codex_Home, undefined);
  });
});

test("a Windows .cmd shim runs as a batch command through the trusted parent SystemRoot cmd.exe only", async () => {
  await fixture(async (root, bin) => {
    const shimDirectory = join(bin, "npm shims");
    await mkdir(shimDirectory);
    await writeFile(join(shimDirectory, "codex.cmd"), "@echo off\r\n");
    await chmod(join(shimDirectory, "codex.cmd"), 0o755);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const compiledModule = resolve(__dirname, "../src/session-host/native-cli-launch.js");
    const configModule = resolve(__dirname, "../src/config.js");
    // In-process Windows simulation (same approach as tests/launcher-cmd.test.ts):
    // only the trusted cmd.exe existence is faked, and nothing is spawned.
    const source = `
      const fs = require("node:fs");
      const normalizeConfig = require(${JSON.stringify(configModule)}).normalizeConfig;
      const realStatSync = fs.statSync;
      const expected = ${JSON.stringify("C:\\Windows\\System32\\cmd.exe")};
      fs.statSync = function (candidate, ...rest) {
        if (typeof candidate === "string" && /(?:^|[\\\\/])System32[\\\\/]cmd\\.exe$/i.test(candidate)) {
          if (candidate === expected) return { isFile: () => true };
          return { isFile: () => false };
        }
        return realStatSync.call(this, candidate, ...rest);
      };
      const launcherModule = require(${JSON.stringify(compiledModule)});
      const config = normalizeConfig({ enabled: true, externalAgents: {
        worker: { adapter: "codex-cli", command: "codex", env: { NPM_CONFIG_PROFILECACHE: "C:\\\\profiles" }, review: {} },
      } });
      const launcher = launcherModule.createNativeCliLauncher(config, {
        platform: "win32",
        parentEnvironment: { SystemRoot: "C:\\\\Windows" },
      });
      launcher("codex", {
        workspace: ${JSON.stringify(workspace)},
        env: { PATH: ${JSON.stringify(shimDirectory)} + ";C:\\\\untrusted", ComSpec: ${JSON.stringify(join(bin, "cmd.exe"))} },
        targetId: "external:worker",
      }).then(
        (descriptor) => process.stdout.write(JSON.stringify(descriptor)),
        (error) => { process.stderr.write(String(error && error.message)); process.exitCode = 1; },
      );
    `;
    const result = spawnSync(process.execPath, ["-e", source], { encoding: "utf8", env: process.env });
    assert.equal(result.status, 0, `simulated Windows launcher failed: ${result.stderr}`);
    const descriptor = JSON.parse(result.stdout) as { file: string; args: string[]; commandLine?: string; env: NodeJS.ProcessEnv; cwd: string };
    assert.equal(descriptor.file, "C:\\Windows\\System32\\cmd.exe");
    const shim = join(shimDirectory, "codex.cmd");
    assert.deepEqual(descriptor.args, [], "the .cmd shim launch carries no argv the pinned spawn could re-escape");
    assert.equal(descriptor.commandLine, `/d /s /v:off /c "${helperModule.cmdQuote(shim)} ${helperModule.cmdQuote("--no-daemon")}"`);
    assert.equal(descriptor.cwd, workspace);
    // One canonical Windows environment spelling, with the shared overlay applied.
    assert.equal(descriptor.env.PATH, `${shimDirectory};C:\\untrusted`);
    assert.equal(descriptor.env.NPM_CONFIG_PROFILECACHE, "C:\\profiles");
    assert.equal(descriptor.env.COMSPEC, join(bin, "cmd.exe"));
    assert.equal(descriptor.env.PWD, workspace);
  });
});

// ---------------------------------------------------------------------------
// Owned Codex backend plan (preparation only)
//
// The owned backend itself is another slice's process owner: nothing here
// spawns a provider, generates real capability material, or claims that a host
// activated the mode. These tests only pin what this launcher may and must not
// do while preparing: attach a plan to nothing it was not asked to, re-render
// both children from literal tokens, and refuse one named profile.
// ---------------------------------------------------------------------------

const OWNED_CODEX_DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OWNED_CODEX_ENDPOINT = "ws://127.0.0.1:54321";
/** A synthetic reserved-name bearer: the shape the lease uses, never real material. */
const OWNED_TUI_AUTH_ENV = "PI_REVIEW_GATE_OWNED_CODEX_RPC_0";
const OWNED_TUI_BEARER = "synthetic-bearer-never-a-real-token";

/** The CLOSED control argv the owned backend lease generates. */
const ownedControlArgs = (digest = OWNED_CODEX_DIGEST): string[] => [
  "app-server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token", "--ws-token-sha256", digest,
];

/** The private TUI connection arguments the lease's readiness accessor returns. */
const ownedConnectionArgs = (endpoint = OWNED_CODEX_ENDPOINT): string[] => [
  "--remote", endpoint, "--remote-auth-token-env", OWNED_TUI_AUTH_ENV,
];

const HOOK_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const HOOK_GENERATION = "22222222-2222-4222-8222-222222222222";
const HOOK_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

function bootstrapFor(backend: "claude" | "codex"): NativeHookBootstrap {
  return {
    version: 1,
    socketPath: "/tmp/prg-synthetic-status-broker.sock",
    generation: HOOK_GENERATION,
    instanceId: HOOK_INSTANCE_ID,
    backend,
    token: HOOK_TOKEN,
  };
}

function preparedHook(outcome: NativeHookLaunchOutcome | undefined) {
  assert.equal(outcome?.observation, "prepared", `expected a prepared outcome, got ${String(outcome?.observation)}`);
  if (outcome?.observation !== "prepared") throw new Error("unreachable");
  return outcome;
}

function unavailableHook(outcome: NativeHookLaunchOutcome | undefined) {
  assert.equal(outcome?.observation, "unavailable", `expected an unavailable outcome, got ${String(outcome?.observation)}`);
  if (outcome?.observation !== "unavailable") throw new Error("unreachable");
  return outcome;
}

/** The Error one closed renderer threw, so its message can be inspected too. */
function throwFrom(operation: () => unknown): Error {
  try { operation(); } catch (caught) {
    assert.ok(caught instanceof Error);
    return caught;
  }
  throw new Error("expected the closed renderer to refuse");
}

function ownedPlanOf(descriptor: NativeCliLaunchDescriptor): NativeCodexOwnedLaunchPlan {
  assert.ok(descriptor.ownedCodex !== undefined, "an owned Codex launch carries a plan");
  return descriptor.ownedCodex!;
}

function ownedConnection(env: Readonly<NodeJS.ProcessEnv>) {
  return { args: ownedConnectionArgs(), env: { ...env, [OWNED_TUI_AUTH_ENV]: OWNED_TUI_BEARER } as NodeJS.ProcessEnv };
}

test("the owned Codex plan is construction-time only: nothing without the option, nothing for Claude, and the ordinary descriptor is untouched", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const config = configWith({});
    const plain = createNativeCliLauncher(config, { platform: "darwin" });
    const owned = createNativeCliLauncher(config, { platform: "darwin", ownedCodexBackend: true });
    const off = createNativeCliLauncher(config, { platform: "darwin", ownedCodexBackend: false });

    // Without the mode — every existing call site — the descriptor is exactly
    // what it was, plan absent.
    const plainCodex = await plain("codex", { workspace, env: { PATH: bin } });
    assert.equal(plainCodex.ownedCodex, undefined);
    assert.equal((await off("codex", { workspace, env: { PATH: bin } })).ownedCodex, undefined);

    const ownedCodex = await owned("codex", { workspace, env: { PATH: bin } });
    assert.ok(ownedCodex.ownedCodex !== undefined);
    // The plan is additive: the ordinary descriptor the manager consumes is
    // byte-identical, so a manager that ignores it launches exactly what it
    // launched before the mode existed.
    assert.equal(ownedCodex.file, plainCodex.file);
    assert.equal(ownedCodex.cwd, plainCodex.cwd);
    assert.deepEqual(ownedCodex.args, plainCodex.args);
    assert.deepEqual(ownedCodex.env, plainCodex.env);
    assert.equal(ownedCodex.nativeHook, undefined);

    // Claude is never part of owned Codex mode: no plan, and nothing else about
    // the launch changes either.
    const plainClaude = await plain("claude", { workspace, env: { PATH: bin } });
    const ownedClaude = await owned("claude", { workspace, env: { PATH: bin } });
    assert.equal(ownedClaude.ownedCodex, undefined, "owned Codex mode attaches no plan to a Claude launch");
    assert.deepEqual(ownedClaude.args, plainClaude.args);
    assert.deepEqual(ownedClaude.env, plainClaude.env);

    // The mode is a construction-time boolean, never a per-request field: a
    // request carries no way to ask for it, and a non-boolean option is a
    // programming error refused when the launcher is built.
    assert.throws(
      () => createNativeCliLauncher(config, { platform: "darwin", ownedCodexBackend: "yes" as unknown as boolean }),
      /owned Codex backend launcher option must be a boolean or absent/u,
    );
    const perRequest = { workspace, env: { PATH: bin }, ownedCodexBackend: true };
    assert.equal((await plain("codex", perRequest)).ownedCodex, undefined, "a per-request ownedCodexBackend claim is inert data");

    // The plan's backend environment is its own object, never the descriptor's,
    // and it carries no capability material of any kind.
    const plan = ownedPlanOf(ownedCodex);
    assert.notEqual(plan.backendEnv, ownedCodex.env);
    assert.deepEqual(Object.keys(plan.backendEnv).filter((name) => /^PI_REVIEW_GATE_OWNED_CODEX_RPC/u.test(name)), []);
    assert.equal(plan.backendEnv[NATIVE_HOOK_BOOTSTRAP_ENV], undefined);
  });
});

test("owned Codex mode refuses every named-profile spelling with one closed typed code, before any environment, hook, artifact, or process work", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const spellings: string[][] = [
      ["--profile", "host"], ["--profile=host"], ["-p", "host"], ["-phost"], ["-p=host"],
    ];
    for (const args of spellings) {
      const config = configWith({ worker: { adapter: "codex-cli", command: join(bin, "codex"), args, review: {} } });
      // Outside the mode the operator's profile selection stays exactly as it was.
      const accepted = await createNativeCliLauncher(config, { platform: "darwin" })("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" });
      assert.deepEqual(accepted.args, [...args, "--no-daemon"], `${JSON.stringify(args)} stays accepted outside owned mode`);

      const error = await createNativeCliLauncher(config, { platform: "darwin", ownedCodexBackend: true })(
        "codex", { workspace, env: { PATH: bin }, targetId: "external:worker" },
      ).then(() => undefined, (caught: unknown) => caught);
      assert.ok(error instanceof NativeCodexOwnedProfileUnsupportedError, `${JSON.stringify(args)} refused by type`);
      assert.equal((error as NativeCodexOwnedProfileUnsupportedError).code, NATIVE_CODEX_OWNED_PROFILE_UNSUPPORTED_CODE);
      // The fixed message carries no profile name, value, path, or argument.
      for (const leak of ["host", bin, workspace, "--profile"]) {
        assert.ok(!error!.message.includes(leak), `the refusal leaked ${JSON.stringify(leak)}: ${error!.message}`);
      }
    }

    // Ordering is the whole resource claim: a missing executable and a
    // malformed hook bootstrap both fail later, so surfacing the profile code
    // instead proves the refusal happened before the environment clone, the
    // hook preparation, any artifact, and any process.
    const ordering = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: join(bin, "codex"), args: ["--profile", "host"], review: {} },
    }), { platform: "darwin", ownedCodexBackend: true });
    const early = await ordering("codex", {
      workspace,
      env: { PATH: join(root, "nowhere") },
      targetId: "external:worker",
      nativeHook: { bootstrap: { version: 1 } as unknown as NativeHookBootstrap },
    }).then(() => undefined, (caught: unknown) => caught);
    assert.ok(early instanceof NativeCodexOwnedProfileUnsupportedError, "the profile refusal wins over every later failure");

    // Narrowness: `-c profile=x` is an ordinary configuration override and a
    // `--profile` past the `--` terminator is prompt data. Neither names the
    // profile option, so neither is newly banned, and the configuration override
    // is routed to the backend like any other `-c`.
    const ownedNear = (args: string[]) => createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: join(bin, "codex"), args, review: {} },
    }), { platform: "darwin", ownedCodexBackend: true })("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" });
    const configValue = await ownedNear(["-c", "profile=x"]);
    assert.deepEqual(configValue.args, ["-c", "profile=x", "--no-daemon"]);
    assert.deepEqual(
      ownedPlanOf(configValue).renderBackend(ownedControlArgs(), { ...ownedPlanOf(configValue).backendEnv }).args.slice(0, 2),
      ["-c", "profile=x"],
    );
    const promptData = await ownedNear(["--", "--profile"]);
    assert.deepEqual(promptData.args, ["--no-daemon", "--", "--profile"]);
    assert.ok(!ownedPlanOf(promptData).renderBackend(ownedControlArgs(), { ...ownedPlanOf(promptData).backendEnv }).args.includes("--profile"));
    // A configuration VALUE that merely spells the flag is data, not an option.
    const spelledValue = await ownedNear(["-c", 'label="--profile host"']);
    assert.deepEqual(
      ownedPlanOf(spelledValue).renderBackend(ownedControlArgs(), { ...ownedPlanOf(spelledValue).backendEnv }).args.slice(0, 2),
      ["-c", 'label="--profile host"'],
    );
  });
});

test("the owned TUI render keeps every operator argument, inserts the lease connection in real option position, and drops only the host-added --no-daemon", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const configured = [
      "-c", 'model_reasoning_effort="high"', "--enable", "feature_x",
      "--model", "gpt-5.1-codex", "--", "fix the bug",
    ];
    const launcher = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: join(bin, "codex"), args: configured, review: {} },
    }), { platform: "darwin", ownedCodexBackend: true });
    const descriptor = await launcher("codex", { workspace, env: { PATH: bin, CODEX_HOME: "/operator/.codex" }, targetId: "external:worker" });
    const plan = ownedPlanOf(descriptor);
    const backendSnapshot = { ...plan.backendEnv };
    const connection = ownedConnection(plan.backendEnv);
    const connectionSnapshot = { ...connection.env };

    const tui = plan.renderTui(connection);
    assert.deepEqual(tui.args, [
      "-c", 'model_reasoning_effort="high"', "--enable", "feature_x", "--model", "gpt-5.1-codex",
      ...ownedConnectionArgs(),
      "--", "fix the bug",
    ], "operator tokens keep their order, the connection lands in option position before the terminator");
    assert.ok(!tui.args.includes("--no-daemon"), "only the host-added daemon isolation flag disappears");
    assert.ok(!tui.args.some((token) => token.startsWith("hooks.")), "no generated SessionStart override on the TUI");
    assert.equal(tui.file, descriptor.file);
    assert.equal(tui.cwd, workspace);
    assert.equal(tui.commandLine, undefined);
    // The hosted TUI keeps the clipboard marker and the bearer variable, and
    // never the backend's hook marker.
    assert.equal(tui.env.HERDR_ENV, "1");
    assert.equal(tui.env[OWNED_TUI_AUTH_ENV], OWNED_TUI_BEARER);
    assert.equal(tui.env.CODEX_HOME, "/operator/.codex");
    assert.equal(tui.env[NATIVE_HOOK_BOOTSTRAP_ENV], undefined);
    // No input mutated, and a second render repeats identically on fresh objects.
    assert.deepEqual(plan.backendEnv, backendSnapshot);
    assert.deepEqual(connection.env, connectionSnapshot);
    const again = plan.renderTui(connection);
    assert.deepEqual(again.args, tui.args);
    assert.deepEqual(again.env, tui.env);
    assert.notEqual(again.env, tui.env);

    // A value-taking option still missing its operand keeps the connection ahead
    // of it, exactly as the isolation flag always was.
    const danglingLauncher = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: join(bin, "codex"), args: ["--model"], review: {} },
    }), { platform: "darwin", ownedCodexBackend: true });
    const dangling = ownedPlanOf(await danglingLauncher("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" }));
    assert.deepEqual(dangling.renderTui(ownedConnection(dangling.backendEnv)).args, [...ownedConnectionArgs(), "--model"]);

    // An operator who configured the isolation flag themselves keeps it: only the
    // host-added one is removed.
    const operatorLauncher = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: join(bin, "codex"), args: ["--no-daemon"], review: {} },
    }), { platform: "darwin", ownedCodexBackend: true });
    const operatorPlan = ownedPlanOf(await operatorLauncher("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" }));
    assert.deepEqual(operatorPlan.renderTui(ownedConnection(operatorPlan.backendEnv)).args, ["--no-daemon", ...ownedConnectionArgs()]);

    // A connection this launcher did not prepare is refused, never guessed at.
    assert.throws(() => plan.renderTui({ args: [], env: { ...plan.backendEnv } }), /carries no printable connection arguments/u);
    assert.throws(
      () => plan.renderTui({ args: ownedConnectionArgs(), env: undefined } as unknown as NativeCodexOwnedTuiConnection),
      /carries no environment/u,
    );
    assert.throws(
      () => plan.renderTui({ args: ["--remote", "ws://127.0.0.1:1\nrm"], env: { ...plan.backendEnv } }),
      /carries no printable connection arguments/u,
    );
  });
});

test("#736: an owned Codex review lane reaches the backend render only, after the operator's -c, with its marker on the backend alone", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const reviewArgs = ["-c", "hooks.UserPromptSubmit=[synthetic]", "-c", "hooks.Stop=[synthetic]"];
    const marker = "synthetic-codex-review-marker";
    const seen: { ownedCodexBackend?: boolean; codexHookDirectory?: string; scanned?: number }[] = [];
    const launcher = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: join(bin, "codex"), args: ["-c", 'model="x"'], review: {} },
    }), {
      platform: "darwin",
      ownedCodexBackend: true,
      nativeReviewPreparation: async (input) => {
        seen.push({
          ...(input.ownedCodexBackend === undefined ? {} : { ownedCodexBackend: input.ownedCodexBackend }),
          ...(input.codexHookDirectory === undefined ? {} : { codexHookDirectory: input.codexHookDirectory }),
          ...(input.scan === undefined ? {} : { scanned: input.scan.options.length }),
        });
        return {
          review: "prepared",
          backend: "codex",
          route: "codex-owned-backend-config",
          args: reviewArgs,
          environment: { [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: marker },
          lease: { root: null, cleanup: async () => ({ removed: [], preserved: [] }) },
        };
      },
    });
    const descriptor = await launcher("codex", {
      workspace,
      env: { PATH: bin },
      targetId: "external:worker",
      nativeReview: {
        bootstrap: {
          version: 1,
          socketPath: "/tmp/prg-synthetic-status-broker.sock",
          generation: "9a8b7c6d-5e4f-4321-8765-4321fedcba09",
          instanceId: "3f2a1b90-7c6d-4e5f-8a9b-0c1d2e3f4a5b",
          backend: "codex",
          token: "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f",
        },
        codexHookDirectory: "/synthetic/state/native-review/codex-hook",
      },
    });
    assert.deepEqual(seen, [{ ownedCodexBackend: true, codexHookDirectory: "/synthetic/state/native-review/codex-hook", scanned: 1 }],
      "the preparation learns it is owned, gets the stable directory, and reads the one scan");
    assert.equal(descriptor.nativeReview?.review, "prepared");
    const plan = ownedPlanOf(descriptor);
    const backend = plan.renderBackend(ownedControlArgs(), { ...plan.backendEnv });
    assert.deepEqual(backend.args, ["-c", 'model="x"', ...reviewArgs, ...ownedControlArgs()],
      "operator -c first, then the review hooks, then the closed control argv");
    assert.equal(backend.env[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], marker, "the backend child carries the marker");
    assert.equal(plan.backendEnv[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], undefined, "never the shared base");
    assert.equal(descriptor.env[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], undefined, "never the descriptor");
    assert.ok(!descriptor.args.some((token) => token.startsWith("hooks.")), "never the descriptor argv");
    const tui = plan.renderTui(ownedConnection(plan.backendEnv));
    assert.equal(tui.env[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], undefined, "never the TUI environment");
    assert.ok(!tui.args.some((token) => token.startsWith("hooks.")), "never the TUI argv");
  });
});

test("the owned backend render routes the operator's global config and features, carries no status hook of ours even when armed, and keeps the closed control argv", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const configured = [
      "-c", 'model_reasoning_effort="high"', "--config", 'model_provider="corp"',
      "--enable", "feature_x", "--disable", "feature_y",
      "--model", "gpt-5.1-codex", "--", "app-server", "-c", 'approval_policy="never"',
    ];
    const launcher = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: join(bin, "codex"), args: configured, review: {} },
    }), { platform: "darwin", ownedCodexBackend: true });
    const descriptor = await launcher("codex", {
      workspace,
      env: { PATH: bin, CODEX_HOME: "/operator/.codex" },
      targetId: "external:worker",
      nativeHook: { bootstrap: bootstrapFor("codex") },
    });
    // An owned Codex launch declines THIS HOST's own status hook, even though the
    // request armed one: no outcome, so no lease, nothing to clean up, and nothing for
    // the manager to own.
    assert.equal(descriptor.nativeHook, undefined, "an owned launch says nothing about a hook of ours");
    const plan = ownedPlanOf(descriptor);
    const backendSnapshot = { ...plan.backendEnv };

    const backend = plan.renderBackend(ownedControlArgs(), { ...plan.backendEnv });
    assert.deepEqual(backend.args, [
      // The operator's global configuration and feature tokens, in configured order
      // and exact spelling, then the closed control argv. Nothing of ours is inserted:
      // the approved relay and its read-only RPC are this owned row's metadata channel,
      // so the real argv stays exactly what the operator configured plus the control.
      "-c", 'model_reasoning_effort="high"', "--config", 'model_provider="corp"',
      "--enable", "feature_x", "--disable", "feature_y",
      ...ownedControlArgs(),
    ]);
    assert.equal(backend.file, descriptor.file);
    assert.equal(backend.cwd, workspace);
    // Runtime UI options are not app-server arguments: they stay on the TUI,
    // whose native protocol projects them. Post-terminator prompt data is never
    // read as an option either.
    for (const absent of ["--model", "gpt-5.1-codex", "--no-daemon", "--", 'approval_policy="never"']) {
      assert.ok(!backend.args.includes(absent), `${absent} never reaches the backend argv`);
    }
    // Only the digest crosses to the backend, exactly once, and no bearer or
    // endpoint ever does.
    assert.equal(backend.args.filter((token) => token === OWNED_CODEX_DIGEST).length, 1);
    assert.ok(!backend.args.some((token) => token.includes(OWNED_CODEX_ENDPOINT) || token.includes(OWNED_TUI_BEARER)));
    // The backend keeps the operator's environment and the hook marker, and gains
    // neither the host-imposed clipboard marker nor the TUI's bearer variable.
    assert.equal(backend.env.CODEX_HOME, "/operator/.codex");
    assert.equal(backend.env.PWD, workspace);
    assert.deepEqual(Object.keys(backend.env).filter((name) => name.toUpperCase() === "HERDR_ENV"), []);
    assert.equal(backend.env[OWNED_TUI_AUTH_ENV], undefined);
    // No bootstrap marker anywhere: not on the backend, not on the descriptor the
    // manager would spawn from, and not in the plan's reusable base.
    assert.equal(backend.env[NATIVE_HOOK_BOOTSTRAP_ENV], undefined);
    assert.equal(descriptor.env[NATIVE_HOOK_BOOTSTRAP_ENV], undefined);
    assert.equal(plan.backendEnv[NATIVE_HOOK_BOOTSTRAP_ENV], undefined);
    assert.ok(!JSON.stringify([backend.env, descriptor.env]).includes(HOOK_TOKEN), "no broker token leaks");
    assert.ok(!JSON.stringify([backend.env, descriptor.env]).includes("/prg-synthetic-status-broker.sock"));
    // Rendering is pure and repeatable: the same argv from an unchanged base,
    // with no second preparation and no marker duplication.
    const second = plan.renderBackend(ownedControlArgs(), { ...plan.backendEnv });
    assert.deepEqual(second.args, backend.args);
    assert.deepEqual(second.env, backend.env);
    assert.deepEqual(plan.backendEnv, backendSnapshot);
    assert.deepEqual(Object.keys(plan.backendEnv).filter((name) => name === NATIVE_HOOK_BOOTSTRAP_ENV), []);
    // The TUI is rendered from the same hook-free base: no marker, and no generated
    // hook flag in its argv either.
    const tui = plan.renderTui(ownedConnection(plan.backendEnv));
    assert.equal(tui.env[NATIVE_HOOK_BOOTSTRAP_ENV], undefined);
    assert.ok(!tui.args.some((token) => token.includes("session-start") || token.includes("hooks.")),
      "no hook instruction reaches the interactive child either");

    // An attached spelling is routed as the single literal token it is, and the
    // TUI keeps it exactly as configured too.
    const attachedLauncher = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: join(bin, "codex"), args: ['-c=model_reasoning_effort="high"', "--enable=feature_z"], review: {} },
    }), { platform: "darwin", ownedCodexBackend: true });
    const attached = ownedPlanOf(await attachedLauncher("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" }));
    assert.deepEqual(
      attached.renderBackend(ownedControlArgs(), { ...attached.backendEnv }).args.slice(0, 2),
      ['-c=model_reasoning_effort="high"', "--enable=feature_z"],
    );
    assert.deepEqual(
      attached.renderTui(ownedConnection(attached.backendEnv)).args.slice(0, 2),
      ['-c=model_reasoning_effort="high"', "--enable=feature_z"],
    );

    // The operator's own clipboard value is theirs, not host-imposed: it survives
    // on the backend while the hosted TUI keeps the host mode.
    const operatorClipboard = ownedPlanOf(await launcher("codex", {
      workspace, env: { PATH: bin, HERDR_ENV: "operator-value" }, targetId: "external:worker",
    }));
    assert.equal(operatorClipboard.backendEnv.HERDR_ENV, "operator-value");
    assert.equal(operatorClipboard.renderBackend(ownedControlArgs(), { ...operatorClipboard.backendEnv }).env.HERDR_ENV, "operator-value");
    assert.equal(operatorClipboard.renderTui(ownedConnection(operatorClipboard.backendEnv)).env.HERDR_ENV, "1");

    // An operator who writes their own SessionStart override keeps it, in owned mode
    // too: their own `-c` token is still routed to the core exactly once, and this host
    // adds no second one and no marker.
    const operatorHooks = ["-c", 'hooks.SessionStart=[{type="command",command="operator.sh"}]'];
    const preserved = await createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: join(bin, "codex"), args: operatorHooks, review: {} },
    }), { platform: "darwin", ownedCodexBackend: true })("codex", {
      workspace, env: { PATH: bin }, targetId: "external:worker", nativeHook: { bootstrap: bootstrapFor("codex") },
    });
    assert.equal(preserved.nativeHook, undefined, "an owned launch never arms a hook of ours");
    const preservedPlan = ownedPlanOf(preserved);
    const preservedBackend = preservedPlan.renderBackend(ownedControlArgs(), { ...preservedPlan.backendEnv });
    assert.deepEqual(preservedBackend.args.slice(0, 2), operatorHooks);
    assert.equal(preservedBackend.args.filter((token) => token.startsWith("hooks.")).length, 1, "exactly the operator's own hook override");
    assert.equal(preservedBackend.env[NATIVE_HOOK_BOOTSTRAP_ENV], undefined, "a declined acquisition arms no marker anywhere");

    // The control that makes this a scope claim and not a regression: the SAME targets,
    // the SAME armed bootstrap, outside owned Codex mode. A normal Codex launch still
    // prepares our one hook channel — flags in real option position, marker in the child
    // environment, lease handed to the caller — and an operator who already wrote their
    // own SessionStart override still gets the existing explicit refusal outcome, so
    // every non-owned Codex, Claude, and Pi launch is byte-identical to before.
    const nonOwned = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: join(bin, "codex"), args: configured, review: {} },
    }), { platform: "darwin" });
    const armed = await nonOwned("codex", {
      workspace, env: { PATH: bin, CODEX_HOME: "/operator/.codex" }, targetId: "external:worker",
      nativeHook: { bootstrap: bootstrapFor("codex") },
    });
    assert.equal(armed.ownedCodex, undefined, "the control launch is not an owned plan");
    const armedHook = preparedHook(armed.nativeHook);
    assert.equal(armedHook.route, "codex-session-start");
    assert.ok(armed.args.some((token) => armedHook.args.includes(token)), "the generated flags stay in real option position");
    assert.equal(JSON.parse(armed.env[NATIVE_HOOK_BOOTSTRAP_ENV]!)["token"], HOOK_TOKEN);
    const armedOperator = await createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: join(bin, "codex"), args: operatorHooks, review: {} },
    }), { platform: "darwin" })("codex", {
      workspace, env: { PATH: bin }, targetId: "external:worker", nativeHook: { bootstrap: bootstrapFor("codex") },
    });
    assert.equal(unavailableHook(armedOperator.nativeHook).reason, "operator-hook-override");
    assert.equal(armedOperator.env[NATIVE_HOOK_BOOTSTRAP_ENV], undefined, "a declined acquisition still arms nothing");
  });
});

test("an owned Codex launch keeps a wrapper target's command prefix on both children and never forwards the prompt", async () => {
  await fixture(async (root, bin) => {
    // The documented wrapper shape: the configured command is an interpreter and
    // the first configured argument is the script it runs. The backend executes
    // the SAME resolved program, so it must keep that prefix.
    await fakeExecutable(join(bin, "node"));
    const wrapper = join(root, "codex wrapper.js");
    await writeFile(wrapper, "// never invoked\n");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const configured = [wrapper, "-c", 'model_provider="corp"', "--model", "gpt-5.1-codex", "--", "fix the bug"];
    const launcher = createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: join(bin, "node"), args: configured, review: {} },
    }), { platform: "darwin", ownedCodexBackend: true });
    const descriptor = await launcher("codex", {
      workspace, env: { PATH: bin }, targetId: "external:worker", nativeHook: { bootstrap: bootstrapFor("codex") },
    });
    // Armed, and still declined: an owned launch composes no hook of ours on a wrapper
    // target either, so the wrapper's real argv is configured tokens plus the control.
    assert.equal(descriptor.nativeHook, undefined);
    assert.equal(descriptor.file, join(bin, "node"));
    // The ordinary (non-plan) composition keeps the terminator and the prompt exactly
    // where they belong, with no generated flag inserted before the terminator.
    assert.deepEqual(descriptor.args, [
      wrapper, "-c", 'model_provider="corp"', "--model", "gpt-5.1-codex",
      "--no-daemon",
      "--", "fix the bug",
    ]);

    const plan = ownedPlanOf(descriptor);
    const backend = plan.renderBackend(ownedControlArgs(), { ...plan.backendEnv });
    assert.deepEqual(backend.args, [
      wrapper, "-c", 'model_provider="corp"', ...ownedControlArgs(),
    ], "the backend runs the configured wrapper with its prefix, plus only backend-routed configuration");
    assert.equal(backend.file, descriptor.file);
    assert.equal(backend.cwd, workspace);
    // Runtime-only options, the terminator, and the prompt stay on the TUI.
    for (const absent of ["--model", "gpt-5.1-codex", "--", "fix the bug", "--no-daemon"]) {
      assert.ok(!backend.args.includes(absent), `${absent} never reaches the backend argv`);
    }

    const tui = plan.renderTui(ownedConnection(plan.backendEnv));
    assert.deepEqual(tui.args, [
      wrapper, "-c", 'model_provider="corp"', "--model", "gpt-5.1-codex",
      ...ownedConnectionArgs(), "--", "fix the bug",
    ]);
    assert.equal(tui.file, descriptor.file);

    // A wrapper whose configured argv is only its script keeps it too: there is
    // nothing after it that could be provider option data.
    const bareWrapper = join(root, "bare wrapper.js");
    await writeFile(bareWrapper, "// never invoked\n");
    const barePlan = ownedPlanOf(await createNativeCliLauncher(configWith({
      worker: { adapter: "codex-cli", command: join(bin, "node"), args: [bareWrapper], review: {} },
    }), { platform: "darwin", ownedCodexBackend: true })("codex", {
      workspace, env: { PATH: bin }, targetId: "external:worker",
    }));
    assert.deepEqual(
      barePlan.renderBackend(ownedControlArgs(), { ...barePlan.backendEnv }).args,
      [bareWrapper, ...ownedControlArgs()],
    );
  });
});

test("a direct Codex command owns no program prefix, so its prompt stays TUI-only and the backend stays the closed app-server argv", async () => {
  await fixture(async (root, bin) => {
    // A command that spells the provider's own executable has no argv of its own
    // ahead of the provider's options, so a leading positional is the provider's
    // prompt: interactive data that belongs to the TUI alone, whether or not
    // configuration options follow it. The wrapper regression above covers the
    // opposite shape, where the configured program does own a prefix.
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const cases: Array<{ readonly command: string; readonly args: readonly string[] }> = [
      { command: join(bin, "codex"), args: ["fix the bug"] },
      { command: join(bin, "codex"), args: ["fix the bug", "-c", 'model_provider="corp"'] },
      { command: join(bin, "codex"), args: ["fix the bug", "--", "and keep this literal"] },
      { command: "codex", args: ["fix the bug", "-c", 'model_provider="corp"'] },
    ];
    for (const item of cases) {
      const launcher = createNativeCliLauncher(configWith({
        worker: { adapter: "codex-cli", command: item.command, args: [...item.args], review: {} },
      }), { platform: "darwin", ownedCodexBackend: true });
      const descriptor = await launcher("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" });
      // The ordinary launch still receives the prompt exactly as before, with the
      // host flag in real option position — before a terminator, otherwise last.
      const terminator = item.args.indexOf("--");
      const insertAt = terminator === -1 ? item.args.length : terminator;
      assert.deepEqual(descriptor.args, [...item.args.slice(0, insertAt), "--no-daemon", ...item.args.slice(insertAt)]);
      const plan = ownedPlanOf(descriptor);
      // The backend never gains prompt data: only the operator's routed
      // configuration, then the closed control argv.
      const routed = plan.renderBackend(ownedControlArgs(), { ...plan.backendEnv }).args;
      assert.ok(!routed.includes("fix the bug"), `prompt reached the backend: ${JSON.stringify(routed)}`);
      assert.ok(!routed.includes("and keep this literal"));
      assert.deepEqual(routed.slice(routed.length - ownedControlArgs().length), ownedControlArgs());
      assert.deepEqual(routed.slice(0, routed.length - ownedControlArgs().length), item.args.filter((token) => token !== "fix the bug" && token !== "and keep this literal" && token !== "--"));
      // The TUI keeps everything, in order, with the connection in option position.
      assert.deepEqual(
        plan.renderTui(ownedConnection(plan.backendEnv)).args,
        [...item.args.slice(0, insertAt), ...ownedConnectionArgs(), ...item.args.slice(insertAt)],
      );
    }
  });
});

test("the owned renderers refuse a control argv they did not generate without echoing its digest", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const plan = ownedPlanOf(await createNativeCliLauncher(configWith({}), { platform: "darwin", ownedCodexBackend: true })("codex", {
      workspace, env: { PATH: bin },
    }));
    const malformed: unknown[] = [
      ["exec", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token", "--ws-token-sha256", OWNED_CODEX_DIGEST],
      ["app-server", "--listen", "ws://127.0.0.1:9", "--ws-auth", "capability-token", "--ws-token-sha256", OWNED_CODEX_DIGEST],
      ["app-server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "bearer", "--ws-token-sha256", OWNED_CODEX_DIGEST],
      ["app-server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token", OWNED_CODEX_DIGEST],
      [...ownedControlArgs(), "--extra"],
      [...ownedControlArgs(OWNED_CODEX_DIGEST.toUpperCase())],
      [...ownedControlArgs(`${OWNED_CODEX_DIGEST}zz`)],
      "not-an-array",
    ];
    for (const controlArgs of malformed) {
      const error = throwFrom(() => plan.renderBackend(controlArgs as unknown as readonly string[], { ...plan.backendEnv }));
      assert.match(error.message, /closed app-server capability-token argv|lowercase SHA-256 token digest/u);
      assert.ok(!error.message.includes(OWNED_CODEX_DIGEST), `the refusal leaked the digest: ${error.message}`);
      assert.ok(!error.message.includes("127.0.0.1"), `the refusal leaked the endpoint: ${error.message}`);
    }
    assert.throws(() => plan.renderBackend(ownedControlArgs(), null as unknown as NodeJS.ProcessEnv), /backend environment is required/u);
  });
});

test("the owned Windows renders re-compose both children from literal tokens through the one trusted batch path", async () => {
  await fixture(async (root, bin) => {
    const shim = join(bin, "codex.cmd");
    await writeFile(shim, "@echo off\r\n");
    await chmod(shim, 0o755);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const trusted = "Z:\\Fixture Windows Root\\System32\\cmd.exe";
    const shipped = helperModule.resolveTrustedWindowsCmd;
    helperModule.resolveTrustedWindowsCmd = () => trusted;
    const configured = [
      "-c", 'model_provider="corp"', "--enable", "feature_x",
      "--label", "100%PI% & echo PWNED", "--bangs", "!PRG_SYNTH_INHERITED! a!b!c",
    ];
    try {
      const launcher = createNativeCliLauncher(configWith({
        worker: { adapter: "codex-cli", command: join(bin, "codex"), args: configured, review: {} },
      }), { platform: "win32", parentEnvironment: { SystemRoot: "Z:\\Fixture Windows Root" }, ownedCodexBackend: true });
      const descriptor = await launcher("codex", { workspace, env: { PATH: bin }, targetId: "external:worker" });
      const plan = ownedPlanOf(descriptor);
      const carrier = "PRG_NATIVE_BATCH_PCT_0";
      // The one established batch convention, applied to whichever tokens this
      // child actually receives: percent-free argv keeps the plain delivery, and
      // a percent anywhere brings the single carrier and its clearance.
      const batch = (tokens: readonly string[]): string => {
        const percent = tokens.some((token) => token.includes("%"));
        const quote = (token: string): string => helperModule.cmdQuote(percent ? token.replace(/%/gu, `%${carrier}%`) : token);
        return `/d /s /v:off /c "${percent ? `set "${carrier}=" & ` : ""}${tokens.map(quote).join(" ")}"`;
      };

      const backend = plan.renderBackend(ownedControlArgs(), { ...plan.backendEnv });
      assert.equal(backend.file, trusted);
      assert.deepEqual(backend.args, [], "a batch child is never delivered as argv");
      assert.equal(backend.commandLine, batch([
        shim, "-c", 'model_provider="corp"', "--enable", "feature_x", ...ownedControlArgs(),
      ]));
      assert.ok(!backend.commandLine!.includes("--no-daemon"), "the batch text is re-composed, not spliced onto the ordinary descriptor");
      // The operator's percent-bearing `--label` is not backend configuration, so
      // the backend line stays percent-free and carries no transport metadata.
      assert.deepEqual(Object.keys(backend.env).filter((name) => /^PRG_NATIVE_BATCH_PCT_/u.test(name)), []);
      assert.ok(!backend.commandLine!.includes("PWNED"));

      const tui = plan.renderTui(ownedConnection(plan.backendEnv));
      assert.equal(tui.file, trusted);
      assert.deepEqual(tui.args, []);
      assert.equal(tui.commandLine, batch([
        shim, ...configured, ...ownedConnectionArgs(),
      ]));
      assert.ok(!tui.commandLine!.includes("--no-daemon"));
      assert.equal(tui.env[carrier], "%");
      assert.equal(tui.env.HERDR_ENV, "1");
      assert.equal(tui.env[OWNED_TUI_AUTH_ENV], OWNED_TUI_BEARER);
      assert.deepEqual(Object.keys(tui.env).filter((name) => /^PRG_NATIVE_BATCH_PCT_/u.test(name)), [carrier]);

      // Re-rendering delivers the identical batch text and never restages or
      // re-quotes anything: the plan's base environment stays carrier-free.
      assert.equal(plan.renderBackend(ownedControlArgs(), { ...plan.backendEnv }).commandLine, backend.commandLine);
      assert.equal(plan.renderTui(ownedConnection(plan.backendEnv)).commandLine, tui.commandLine);
      assert.deepEqual(Object.keys(plan.backendEnv).filter((name) => /^PRG_NATIVE_BATCH_PCT_/u.test(name)), []);
      // The ordinary descriptor of the same launch still delivers what it always
      // did, including the host-added isolation flag and its own carrier.
      assert.equal(descriptor.commandLine, batch([shim, ...configured, "--no-daemon"]));
    } finally {
      helperModule.resolveTrustedWindowsCmd = shipped;
    }
  });
});

// --- SessionSpawn startup request composition (issue #493). ---

const STARTUP_INSTRUCTION = "Please read the entire file at the JSON-quoted path \"/tmp/prg-native-prompt-x/p-1.json\", then do it.";

test("a Claude startup request adds the exact attached --name title and the instruction after a terminator", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const title = "--dangerous looking  title with ünicode, \"quotes\" and a long tail ".padEnd(900, "t");
    const environment: NodeJS.ProcessEnv = { PATH: bin, HOME: "/operator/home" };
    const descriptor = await createNativeCliLauncher(configWith({}), { platform: "darwin" })("claude", {
      workspace, env: environment, targetId: "claude",
      initialPrompt: { instruction: STARTUP_INSTRUCTION, title },
    });
    assert.deepEqual(descriptor.args, [`--name=${title}`, "--", STARTUP_INSTRUCTION],
      "the exact title rides one attached option; the instruction is the single prompt operand");
    assert.equal(descriptor.cwd, workspace);
    assert.ok(!Object.values(descriptor.env).some((value) => value?.includes(STARTUP_INSTRUCTION) || value?.includes(title)),
      "neither the instruction nor the title reaches the child environment");
    assert.equal(environment.PWD, undefined, "the caller's environment is never mutated");
    // Without a startup request the descriptor is byte-identical to the bare launch.
    const bare = await createNativeCliLauncher(configWith({}), { platform: "darwin" })("claude", { workspace, env: environment });
    assert.deepEqual(bare.args, []);
  });
});

test("a Codex startup request keeps --no-daemon, appends the terminated instruction, and refuses a title argument", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const launcher = createNativeCliLauncher(configWith({}), { platform: "darwin" });
    const codex = await launcher("codex", { workspace, env: { PATH: bin }, initialPrompt: { instruction: STARTUP_INSTRUCTION } });
    assert.deepEqual(codex.args, ["--no-daemon", "--", STARTUP_INSTRUCTION]);
    await assert.rejects(
      () => launcher("codex", { workspace, env: { PATH: bin }, initialPrompt: { instruction: STARTUP_INSTRUCTION, title: "T" } }),
      /no native title option/u,
      "Codex has no title flag: the title is never silently dropped or invented as an argument",
    );
  });
});

test("an owned Codex startup request reaches the TUI render only, after the remote connection and a terminator", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const descriptor = await createNativeCliLauncher(configWith({}), { platform: "darwin", ownedCodexBackend: true })("codex", {
      workspace, env: { PATH: bin }, targetId: "codex", initialPrompt: { instruction: STARTUP_INSTRUCTION },
    });
    const plan = ownedPlanOf(descriptor);
    const tui = plan.renderTui(ownedConnection(plan.backendEnv));
    assert.deepEqual(tui.args, [...ownedConnectionArgs(), "--", STARTUP_INSTRUCTION],
      "the owned TUI keeps its existing relay connection and gains only the terminated instruction");
    assert.deepEqual(plan.renderTui(ownedConnection(plan.backendEnv)).args, tui.args, "rendering is repeatable");
    const backend = plan.renderBackend(ownedControlArgs(), { ...plan.backendEnv });
    assert.ok(!backend.args.includes(STARTUP_INSTRUCTION) && !backend.args.includes("--"),
      "the app-server backend never receives the startup operand");
  });
});

test("a startup request is refused for a configured worker profile, a restore, or an unsafe instruction", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const launcher = createNativeCliLauncher(configWith({
      worker: { adapter: "claude-cli", command: join(bin, "claude"), review: {} },
    }), { platform: "darwin" });
    await assert.rejects(
      () => launcher("claude", { workspace, env: { PATH: bin }, targetId: "external:worker", initialPrompt: { instruction: STARTUP_INSTRUCTION } }),
      /not its backend's default target/u,
      "a SessionSpawn startup never selects an external worker target",
    );
    await assert.rejects(
      () => launcher("claude", {
        workspace, env: { PATH: bin }, targetId: "claude",
        resumeConversationId: "0190a5c8-2b4e-7f00-8a00-000000000001",
        initialPrompt: { instruction: STARTUP_INSTRUCTION },
      }),
      /cannot be combined with a conversation restore/u,
    );
    for (const instruction of ["", "-p evil", "/slash command", "@/etc/passwd", "line\nbreak", " x"]) {
      const error = await launcher("claude", { workspace, env: { PATH: bin }, initialPrompt: { instruction } }).then(
        () => undefined, (caught: unknown) => caught as Error);
      assert.ok(error instanceof Error, `${JSON.stringify(instruction)} is refused`);
      assert.ok(instruction === "" || !error.message.includes(instruction), "a refusal never echoes the instruction");
    }
    const titled = await launcher("claude", { workspace, env: { PATH: bin }, initialPrompt: { instruction: STARTUP_INSTRUCTION, title: "bad\ntitle" } })
      .then(() => undefined, (caught: unknown) => caught as Error);
    assert.ok(titled instanceof Error && !titled.message.includes("bad"), "a control-bearing title is refused without echo");
  });
});
