import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import {
  NATIVE_HOOK_BOOTSTRAP_ENV,
  type NativeHookBootstrap,
} from "../src/session-host/native-hook-protocol";
import { RUNTIME_ROLE_ENV } from "../src/session-host/launch";
import {
  createNativeCliLauncher,
  scanNativeArgPositions,
  type NativeCliLauncher,
} from "../src/session-host/native-cli-launch";
import {
  CLAUDE_NATIVE_HOOK_EVENTS,
  CODEX_NATIVE_HOOK_EVENTS,
  NATIVE_HOOK_TIMEOUT_SECONDS,
  prepareNativeHookLaunch,
  type NativeHookLaunchOutcome,
  type NativeHookLaunchPreparationInput,
} from "../src/session-host/native-hook-launch-prep";

/**
 * Per-launch native status hook preparation (issue #277, launch-preparation
 * slice). Everything here is synthetic: no provider CLI is ever executed, no
 * provider configuration, trust record, or credential is read or written, and
 * no artifact is created inside this repository — every fixture and every
 * staged artifact lives under the system temporary directory.
 */
const helperModule = require(resolve("scripts/pi-review-gate-launcher.cjs")) as {
  cmdQuote: (arg: string) => string;
  resolveTrustedWindowsCmd: (parentEnvironment?: NodeJS.ProcessEnv) => string | null;
};

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const GENERATION = "22222222-2222-4222-8222-222222222222";
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

function bootstrapFor(backend: "claude" | "codex", token = TOKEN): NativeHookBootstrap {
  return {
    version: 1,
    socketPath: "/tmp/prg-synthetic-status-broker.sock",
    generation: GENERATION,
    instanceId: INSTANCE_ID,
    backend,
    token,
  };
}

/** One hermetic temp tree, always outside the repository worktree. */
async function fixture(run: (root: string, bin: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-hook-prep-")));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  try { await run(root, bin); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function fakeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\necho never invoked\n");
  await chmod(path, 0o755);
}

function configWith(externalAgents: Record<string, unknown>): ReviewGateConfig {
  return normalizeConfig({ enabled: true, externalAgents });
}

/** The same scan the launch adapter itself uses; there is no second parser here. */
const scanFor = (backend: "claude" | "codex", args: readonly string[]) =>
  scanNativeArgPositions(backend, args, "synthetic-target");

function preparationInput(
  backend: "claude" | "codex",
  args: readonly string[],
  overrides: Partial<NativeHookLaunchPreparationInput> = {},
): NativeHookLaunchPreparationInput {
  return {
    backend,
    bootstrap: bootstrapFor(backend),
    platform: "darwin",
    args,
    scan: scanFor(backend, args),
    env: { PATH: "/usr/bin" },
    ...overrides,
  };
}

/** How many of this product's artifact roots currently exist in the system temp dir. */
function hookArtifactRootCount(): number {
  try {
    return readdirSync(tmpdir()).filter((name) => name.startsWith("prg-native-hook-")).length;
  } catch {
    return 0;
  }
}

function prepared(outcome: NativeHookLaunchOutcome | undefined) {
  assert.equal(outcome?.observation, "prepared", `expected a prepared outcome, got ${String(outcome?.observation)}`);
  if (outcome?.observation !== "prepared") throw new Error("unreachable");
  return outcome;
}

function unavailable(outcome: NativeHookLaunchOutcome | undefined) {
  assert.equal(outcome?.observation, "unavailable", `expected an unavailable outcome, got ${String(outcome?.observation)}`);
  if (outcome?.observation !== "unavailable") throw new Error("unreachable");
  return outcome;
}

/** Decode one `key="<basic string>"` field out of a generated TOML override value. */
function decodeTomlField(value: string, key: string): string {
  const marker = `${key}="`;
  const start = value.indexOf(marker);
  assert.notEqual(start, -1, `${key} is present in ${value}`);
  let out = "";
  for (let index = start + marker.length; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      const next = value[index + 1];
      if (next === '"') out += '"';
      else if (next === "\\") out += "\\";
      else if (next === "t") out += "\t";
      else if (next === "n") out += "\n";
      else throw new Error(`unsupported escape ${String(next)}`);
      index += 1;
      continue;
    }
    if (character === '"') return out;
    out += character;
  }
  throw new Error(`unterminated ${key} string`);
}

// ---------------------------------------------------------------------------
// Claude acquisition
// ---------------------------------------------------------------------------

test("a Claude launch with no operator --settings stages one hooks-only settings file and adds exactly one flag", async () => {
  await fixture(async (_root, bin) => {
    const node = join(bin, "node");
    const relay = join(bin, "native-hook-relay.js");
    await fakeExecutable(node);
    await writeFile(relay, "// never invoked\n");
    const outcome = prepared(await prepareNativeHookLaunch(preparationInput("claude", [], {
      entrypoints: { nodeExecutable: node, relayEntry: relay },
    })));
    assert.equal(outcome.route, "claude-settings-file");
    assert.equal(outcome.backend, "claude");
    assert.equal(outcome.args.length, 2);
    assert.equal(outcome.args[0], "--settings");
    const root = outcome.lease.root;
    assert.ok(root !== null);
    assert.ok(outcome.args[1]!.startsWith(`${root}/`));

    const staged = JSON.parse(readFileSync(outcome.args[1]!, "utf8")) as Record<string, unknown>;
    // Only the hooks key: every other settings layer and key the operator owns
    // keeps its own value, because nothing else is declared at all.
    assert.deepEqual(Object.keys(staged), ["hooks"]);
    const events = staged.hooks as Record<string, { hooks: Record<string, unknown>[] }[]>;
    assert.deepEqual(Object.keys(events), [...CLAUDE_NATIVE_HOOK_EVENTS]);
    for (const event of CLAUDE_NATIVE_HOOK_EVENTS) {
      const groups = events[event]!;
      assert.equal(groups.length, 1);
      assert.equal(groups[0]!.hooks.length, 1);
      const entry = groups[0]!.hooks[0]!;
      assert.equal(entry.type, "command");
      assert.equal(entry.command, node);
      assert.deepEqual(entry.args, [relay]);
      assert.equal(entry.timeout, NATIVE_HOOK_TIMEOUT_SECONDS);
      // An observer can never block, deny, or override the provider's own flow.
      assert.equal(entry.onFailure, "continue");
    }

    // No secret, no identity, no provider data inside the artifact.
    const text = readFileSync(outcome.args[1]!, "utf8");
    for (const secret of [TOKEN, INSTANCE_ID, GENERATION, "/tmp/prg-synthetic-status-broker.sock"]) {
      assert.ok(!text.includes(secret), `${secret} never enters the staged settings file`);
    }

    const cleanup = await outcome.lease.cleanup();
    assert.deepEqual(cleanup.preserved, []);
    assert.equal(cleanup.removed.length, 2, "the staged file and its own root");
    assert.ok(!existsSync(outcome.args[1]!));
    assert.ok(!existsSync(root));
    // Idempotent: a second release reports the same result and touches nothing.
    assert.deepEqual(await outcome.lease.cleanup(), cleanup);
  });
});

test("staged artifacts are private, and cleanup removes only its own inodes", async (t) => {
  if (process.platform === "win32") t.skip("POSIX permission bits");
  await fixture(async (_root, bin) => {
    const relay = join(bin, "native-hook-relay.js");
    await writeFile(relay, "// never invoked\n");
    const entrypoints = { nodeExecutable: process.execPath, relayEntry: relay };
    const outcome = prepared(await prepareNativeHookLaunch(preparationInput("claude", [], { entrypoints })));
    const root = outcome.lease.root as string;
    assert.equal(statSync(root).mode & 0o777, 0o700, "the owned root is private");
    assert.equal(statSync(outcome.args[1]!).mode & 0o777, 0o600, "the staged settings file is private");

    // An entry this namespace never created is never deleted, and its presence
    // keeps the root itself in place.
    const foreign = join(root, "someone-else-s-file");
    await writeFile(foreign, "not ours\n");
    const cleanup = await outcome.lease.cleanup();
    assert.ok(existsSync(foreign), "an unknown entry survives");
    assert.ok(existsSync(root), "a root that no longer holds only our entries survives");
    assert.ok(!existsSync(outcome.args[1]!), "our own file is still removed");
    assert.deepEqual(cleanup.preserved, [root]);
    await rm(foreign);

    // A replaced entry is not ours any more: its path is preserved, not unlinked.
    const second = prepared(await prepareNativeHookLaunch(preparationInput("claude", [], { entrypoints })));
    const secondRoot = second.lease.root as string;
    const secondFile = second.args[1]!;
    const ownedInode = (await lstat(secondFile)).ino;
    await unlink(secondFile);
    await writeFile(secondFile, "replaced by someone else\n");
    assert.notEqual((await lstat(secondFile)).ino, ownedInode, "the fixture really replaced the inode");
    const secondCleanup = await second.lease.cleanup();
    assert.ok(existsSync(secondFile), "a replaced entry is never unlinked");
    assert.ok(existsSync(secondRoot), "the root survives its own preserved entry");
    assert.ok(secondCleanup.preserved.includes(secondFile));
    // Test-owned fixtures (the replacement file) are the only things left here.
    await rm(secondRoot, { recursive: true, force: true });
  });
});

test("an operator --settings in real option position switches to the approved hooks-only plugin fallback", async () => {
  await fixture(async (_root, bin) => {
    const node = join(bin, "node");
    const relay = join(bin, "native-hook-relay.js");
    const cli = join(bin, "claude");
    await fakeExecutable(node);
    await fakeExecutable(cli);
    await writeFile(relay, "// never invoked\n");
    const operatorSettings = [
      "--settings", "/operator/my-settings.json",
      "--plugin-dir", "/operator/already-loaded",
    ];
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const launcher = createNativeCliLauncher(configWith({
      op: { adapter: "claude-cli", command: cli, args: operatorSettings, review: {} },
    }), { platform: "darwin" });
    const descriptor = await launcher("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      targetId: "external:op",
      nativeHook: { bootstrap: bootstrapFor("claude") },
    });
    const hook = prepared(descriptor.nativeHook);
    assert.equal(hook.route, "claude-plugin-dir");
    assert.deepEqual(hook.args.length, 2);
    assert.equal(hook.args[0], "--plugin-dir", "a second --settings is never added: it would replace the operator's flag settings");
    const pluginRoot = hook.args[1]!;
    assert.equal(pluginRoot, join(hook.lease.root as string, "claude-observer-plugin"));

    // Every operator token survives, in order, and the new one is additive.
    assert.deepEqual(descriptor.args, [...operatorSettings, ...hook.args]);

    // A minimal manifest plus its classic hooks file, and nothing else.
    const manifest = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")) as Record<string, string>;
    assert.match(manifest.name!, /^[a-z][a-z0-9-]*$/u);
    assert.deepEqual(Object.keys(manifest).sort(), ["description", "name", "version"]);
    const hooksFile = JSON.parse(readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8")) as Record<string, unknown>;
    // A plugin hooks file needs the top-level `hooks` wrapper; the bare event map fails to load.
    assert.deepEqual(Object.keys(hooksFile), ["hooks"]);
    assert.deepEqual(Object.keys(hooksFile.hooks as object), [...CLAUDE_NATIVE_HOOK_EVENTS]);
    assert.deepEqual(readdirSync(pluginRoot).sort(), [".claude-plugin", "hooks"], "no commands, agents, skills, MCP servers, or JavaScript");
    assert.deepEqual(readdirSync(join(pluginRoot, "hooks")), ["hooks.json"]);

    // Every created directory is owned, leaf included: a recorded-path leak
    // would leave the plugin tree behind forever.
    const cleanup = await hook.lease.cleanup();
    assert.deepEqual(cleanup.preserved, [], `nothing owned may survive: ${JSON.stringify(cleanup)}`);
    assert.equal(cleanup.removed.length, 6, "root, plugin root, manifest dir, hooks dir, and two files");
    assert.ok(!existsSync(pluginRoot));
    assert.ok(!existsSync(hook.lease.root as string));
  });
});

test("cleanup refuses to delete through a replaced root or a replaced intermediate directory", async () => {
  await fixture(async (_root, bin) => {
    const relay = join(bin, "native-hook-relay.js");
    await writeFile(relay, "// never invoked\n");
    const entrypoints = { nodeExecutable: process.execPath, relayEntry: relay };

    // The owned root is renamed out of the way and its original path becomes a
    // symlink to it. Every leaf inode still matches, so only an ancestry check
    // can stop cleanup from deleting through the replacement.
    const viaRoot = prepared(await prepareNativeHookLaunch(preparationInput("claude", [], { entrypoints })));
    const originalRoot = viaRoot.lease.root as string;
    const settingsPath = viaRoot.args[1]!;
    const movedRoot = join(_root, "moved-root");
    await rename(originalRoot, movedRoot);
    await symlink(movedRoot, originalRoot);
    const rootCleanup = await viaRoot.lease.cleanup();
    assert.ok(existsSync(join(movedRoot, "claude-hook-settings.json")), "nothing is deleted through a replacement root");
    assert.deepEqual(rootCleanup.removed, []);
    assert.deepEqual(rootCleanup.preserved, [settingsPath, originalRoot]);
    await rm(movedRoot, { recursive: true, force: true });
    await rm(originalRoot, { force: true });

    // The same rule one level down: the hooks directory is replaced by a fresh
    // directory holding a foreign file, so neither it nor its subtree is touched.
    const viaPlugin = prepared(await prepareNativeHookLaunch(preparationInput("claude", ["--settings", "/op/s.json"], { entrypoints })));
    const pluginRoot = viaPlugin.args[1]!;
    const hooksDir = join(pluginRoot, "hooks");
    const hooksFile = join(hooksDir, "hooks.json");
    const movedHooks = join(_root, "moved-hooks");
    await rename(hooksDir, movedHooks);
    await mkdir(hooksDir);
    await writeFile(join(hooksDir, "someone-else-s.json"), "not ours\n");
    const pluginCleanup = await viaPlugin.lease.cleanup();
    assert.ok(existsSync(join(movedHooks, "hooks.json")), "the real owned file is not reached through a replaced directory");
    assert.ok(existsSync(join(hooksDir, "someone-else-s.json")), "the foreign entry survives");
    assert.ok(pluginCleanup.preserved.includes(hooksFile));
    assert.ok(pluginCleanup.preserved.includes(hooksDir));
    assert.ok(pluginCleanup.preserved.includes(pluginRoot), "the plugin root survives while a foreign subtree remains");
    assert.ok(existsSync(pluginRoot));
    await rm(movedHooks, { recursive: true, force: true });
    await rm(viaPlugin.lease.root as string, { recursive: true, force: true });
  });
});

test("an option-like operand or a --settings past the -- terminator is data, never a conflict", async () => {
  await fixture(async (_root, bin) => {
    const relay = join(bin, "native-hook-relay.js");
    await writeFile(relay, "// never invoked\n");
    const entrypoints = { nodeExecutable: process.execPath, relayEntry: relay };
    // Here `--settings` is the VALUE of --append-system-prompt: the provider
    // reads it as prompt text, so our own --settings is still available.
    const asOperand = prepared(await prepareNativeHookLaunch(preparationInput("claude", ["--append-system-prompt", "--settings"], { entrypoints })));
    assert.equal(asOperand.route, "claude-settings-file");
    // Here it is literal prompt data past the terminator.
    const pastTerminator = prepared(await prepareNativeHookLaunch(preparationInput("claude", ["--", "--settings", "hooks"], { entrypoints })));
    assert.equal(pastTerminator.route, "claude-settings-file");
    await asOperand.lease.cleanup();
    await pastTerminator.lease.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Codex acquisition
// ---------------------------------------------------------------------------

test("Codex adds only a SessionStart override whose command content is stable across rows", async () => {
  await fixture(async (_root, bin) => {
    const node = join(bin, "node with spaces");
    const relay = join(bin, "relay's 'odd' name.js");
    await writeFile(node, "x");
    await writeFile(relay, "// never invoked\n");
    const entrypoints = { nodeExecutable: node, relayEntry: relay };

    const first = prepared(await prepareNativeHookLaunch(preparationInput("codex", [], {
      entrypoints,
      bootstrap: bootstrapFor("codex", TOKEN),
    })));
    const second = prepared(await prepareNativeHookLaunch(preparationInput("codex", [], {
      entrypoints,
      bootstrap: bootstrapFor("codex", "f".repeat(64)),
    })));

    assert.equal(first.route, "codex-session-start");
    assert.equal(first.lease.root, null, "this route stages no file at all");
    assert.equal(first.args.length, 2);
    assert.equal(first.args[0], "-c");
    const value = first.args[1]!;
    // The path's value is an array of matcher GROUPS whose `hooks` array holds
    // the handlers; a handler in the outer array would load as an empty group
    // and the observer would be a silent no-op.
    assert.ok(value.startsWith("hooks.SessionStart=[{hooks=[{type=\"command\",command=\""), value);
    assert.ok(value.endsWith(`",timeout=${NATIVE_HOOK_TIMEOUT_SECONDS}}]}]`), value);
    // The provider's own schema: a shell command string (Codex has no exec
    // form), POSIX-quoted with the single-quote idiom, so spaces and quotes in
    // real paths survive literally.
    assert.equal(
      decodeTomlField(value, "command"),
      `'${node.replace(/'/gu, `'\\''`)}' '${relay.replace(/'/gu, `'\\''`)}'`,
    );
    assert.ok(!value.includes("hooks.state") && !value.includes("state="), "the trust record is never written");
    assert.ok(!value.includes(TOKEN) && !value.includes(INSTANCE_ID), "the secret never enters provider command text");

    // One stable command for every row, so a normal native trust decision can
    // persist; only the child environment differs.
    assert.equal(second.args[1], first.args[1], "identical command content across rows");
    assert.notEqual(second.environment[NATIVE_HOOK_BOOTSTRAP_ENV], first.environment[NATIVE_HOOK_BOOTSTRAP_ENV]);
    assert.deepEqual(CODEX_NATIVE_HOOK_EVENTS, ["SessionStart"]);
  });
});

test("Codex declines to inject when the operator already writes the same-layer hooks, and preserves the launch", async () => {
  await fixture(async (_root, bin) => {
    const relay = join(bin, "native-hook-relay.js");
    const cli = join(bin, "codex");
    await fakeExecutable(cli);
    await writeFile(relay, "// never invoked\n");
    const entrypoints = { nodeExecutable: process.execPath, relayEntry: relay };
    const conflicting: readonly (readonly string[])[] = [
      ["-c", "hooks.SessionStart=[{type=\"command\",command=\"operator.sh\"}]"],
      ["--config", "hooks.SessionStart=[]"],
      ["--config=hooks.SessionStart=[]"],
      ["-chooks.SessionStart=[]"],
      ["-c", " hooks.SessionStart = [] "],
      ["-c", "hooks={SessionStart=[{type=\"command\",command=\"operator.sh\"}]}"],
      ["-c", "hooks.session_start=[]"],
      ["-c", "hooks.SessionStart.matcher=\"x\""],
    ];
    for (const args of conflicting) {
      const outcome = unavailable(await prepareNativeHookLaunch(preparationInput("codex", args, { entrypoints })));
      assert.equal(outcome.reason, "operator-hook-override", `${JSON.stringify(args)} must not be injected over`);
    }

    // Other hook events, other config paths, and hook-shaped DATA past the
    // terminator are not conflicts.
    const compatible: readonly (readonly string[])[] = [
      ["-c", "hooks.Stop=[{type=\"command\",command=\"operator.sh\"}]"],
      ["-c", "hooks.SessionEnd=[]"],
      ["-c", "model=\"o3\""],
      ["--", "-c", "hooks.SessionStart=[]"],
      ["--profile", "hooks.SessionStart=[]"],
    ];
    for (const args of compatible) {
      const outcome = prepared(await prepareNativeHookLaunch(preparationInput("codex", args, { entrypoints })));
      assert.equal(outcome.route, "codex-session-start", `${JSON.stringify(args)} stays acquirable`);
    }

    // A declined acquisition composes exactly the legacy argv with no marker.
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const conflict = ["-c", "hooks.SessionStart=[{type=\"command\",command=\"operator.sh\"}]"];
    const launcher = createNativeCliLauncher(configWith({
      op: { adapter: "codex-cli", command: cli, args: conflict, review: {} },
    }), { platform: "darwin" });
    const descriptor = await launcher("codex", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      targetId: "external:op",
      nativeHook: { bootstrap: bootstrapFor("codex") },
    });
    assert.deepEqual(descriptor.args, [...conflict, "--no-daemon"]);
    assert.equal(unavailable(descriptor.nativeHook).reason, "operator-hook-override");
    assert.equal(descriptor.env[NATIVE_HOOK_BOOTSTRAP_ENV], undefined, "a declined row carries no marker");
    assert.equal(descriptor.env.HERDR_ENV, "1", "the existing clipboard marker is unaffected");
  });
});

// ---------------------------------------------------------------------------
// Environment marker, role, and identity rules
// ---------------------------------------------------------------------------

test("the fresh marker is the only bootstrap the child can see, and a worker role is rejected before any artifact", async () => {
  await fixture(async (_root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const stale = JSON.stringify(bootstrapFor("claude", "b".repeat(64)));
    const launcher = createNativeCliLauncher(configWith({}), { platform: "darwin" });

    const armed = await launcher("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home", [NATIVE_HOOK_BOOTSTRAP_ENV]: stale },
      nativeHook: { bootstrap: bootstrapFor("claude") },
    });
    const hook = prepared(armed.nativeHook);
    // Exactly one spelling, holding THIS launch's fresh bootstrap.
    const markerNames = Object.keys(armed.env).filter((name) => /NATIVE_HOOK_BOOTSTRAP/i.test(name));
    assert.deepEqual(markerNames, [NATIVE_HOOK_BOOTSTRAP_ENV]);
    const carried = JSON.parse(armed.env[NATIVE_HOOK_BOOTSTRAP_ENV]!) as NativeHookBootstrap;
    assert.equal(carried.token, TOKEN);
    assert.notEqual(carried.token, "b".repeat(64), "an inherited marker never survives");
    assert.equal(carried.backend, "claude");
    assert.equal(carried.instanceId, INSTANCE_ID);
    // Native inheritance survives.
    assert.equal(armed.env.HOME, "/operator/home");
    await hook.lease.cleanup();

    // A worker role is refused by the launch adapter, and by the preparation
    // itself before it could touch the filesystem.
    await assert.rejects(
      launcher("claude", { workspace, env: { PATH: bin, [RUNTIME_ROLE_ENV]: "executor" }, nativeHook: { bootstrap: bootstrapFor("claude") } }),
      new RegExp(RUNTIME_ROLE_ENV, "u"),
    );
    const before = hookArtifactRootCount();
    await assert.rejects(
      prepareNativeHookLaunch(preparationInput("claude", [], { env: { [RUNTIME_ROLE_ENV]: "executor" } })),
      new RegExp(RUNTIME_ROLE_ENV, "u"),
    );
    assert.equal(hookArtifactRootCount(), before, "a rejected worker-role preparation stages nothing");

    // A cross-backend or malformed bootstrap is a refusal, never a partial arming.
    await assert.rejects(
      prepareNativeHookLaunch(preparationInput("claude", [], { bootstrap: bootstrapFor("codex") })),
      /cannot arm a claude launch/u,
    );
    await assert.rejects(
      prepareNativeHookLaunch(preparationInput("claude", [], { bootstrap: { ...bootstrapFor("claude"), token: "nope" } as never })),
      /malformed/u,
    );
    assert.equal(hookArtifactRootCount(), before, "a refused bootstrap stages nothing either");
  });
});

test("with no hook option the descriptor stays exactly what it was: no flag, no marker, no artifact", async () => {
  await fixture(async (_root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const configured = ["--model", "opus", "--", "--settings", "--plugin-dir", "-p", "100% & echo PWNED"];
    const launcher = createNativeCliLauncher(configWith({
      op: { adapter: "claude-cli", command: join(bin, "claude"), args: configured, review: {} },
    }), { platform: "darwin" });
    const before = hookArtifactRootCount();

    const plain = await launcher("claude", { workspace, env: { PATH: bin }, targetId: "external:op" });
    assert.equal(plain.nativeHook, undefined);
    assert.deepEqual(plain.args, configured);
    assert.equal(plain.env[NATIVE_HOOK_BOOTSTRAP_ENV], undefined);

    const plainCodex = await createNativeCliLauncher(configWith({}), { platform: "darwin" })("codex", { workspace, env: { PATH: bin } });
    assert.deepEqual(plainCodex.args, ["--no-daemon"]);
    assert.equal(plainCodex.env.HERDR_ENV, "1");
    assert.equal(plainCodex.env[NATIVE_HOOK_BOOTSTRAP_ENV], undefined);
    assert.equal(hookArtifactRootCount(), before, "an unarmed launch creates nothing");
  });
});

test("generated flags land in real option position and every operator token after -- stays literal", async () => {
  await fixture(async (_root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const configured = ["--model", "opus", "--", "--settings", "--plugin-dir", "-p", "100% & echo PWNED"];
    const launcher = createNativeCliLauncher(configWith({
      op: { adapter: "claude-cli", command: join(bin, "claude"), args: configured, review: {} },
    }), { platform: "darwin" });
    const descriptor = await launcher("claude", {
      workspace,
      env: { PATH: bin },
      targetId: "external:op",
      nativeHook: { bootstrap: bootstrapFor("claude") },
    });
    const hook = prepared(descriptor.nativeHook);
    // The operator carries `--settings`, but only past the terminator, so it is
    // prompt data and the settings-file route stays available.
    assert.equal(hook.route, "claude-settings-file");
    const terminator = descriptor.args.indexOf("--");
    assert.ok(terminator > 0);
    assert.deepEqual(descriptor.args.slice(terminator), configured.slice(2), "nothing past the terminator moved or changed");
    assert.deepEqual(descriptor.args.slice(terminator - 2, terminator), [...hook.args], "the generated flag sits in option position, before the terminator");
    await hook.lease.cleanup();

    // A value-taking option still missing its operand keeps the flag ahead of it.
    const danglingLauncher = createNativeCliLauncher(configWith({
      op: { adapter: "codex-cli", command: join(bin, "codex"), args: ["--profile"], review: {} },
    }), { platform: "darwin" });
    const codex = await danglingLauncher("codex", {
      workspace,
      env: { PATH: bin },
      targetId: "external:op",
      nativeHook: { bootstrap: bootstrapFor("codex") },
    });
    const codexHook = prepared(codex.nativeHook);
    assert.deepEqual(codex.args.slice(0, 4), ["--no-daemon", "-c", codexHook.args[1], "--profile"]);
    await codexHook.lease.cleanup();
  });
});

test("a Windows .cmd CLI carries the generated hook flags through the one batch escaping path", async () => {
  await fixture(async (_root, bin) => {
    const shim = join(bin, "codex.cmd");
    await writeFile(shim, "@echo off\r\n");
    await chmod(shim, 0o755);
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const node = join(bin, "node.exe");
    const relay = join(bin, "native-hook-relay.js");
    await writeFile(node, "x");
    await writeFile(relay, "// never invoked\n");
    const trusted = "Z:\\Fixture Windows Root\\System32\\cmd.exe";
    const shipped = helperModule.resolveTrustedWindowsCmd;
    helperModule.resolveTrustedWindowsCmd = () => trusted;
    try {
      const launcher = createNativeCliLauncher(configWith({
        op: { adapter: "codex-cli", command: shim, args: ["--profile", "100% & echo PWNED"], review: {} },
      }), {
        platform: "win32",
        parentEnvironment: { SystemRoot: "Z:\\Fixture Windows Root" },
      });
      const descriptor = await launcher("codex", {
        workspace,
        env: { PATH: bin },
        targetId: "external:op",
        nativeHook: { bootstrap: bootstrapFor("codex") },
      });
      const hook = prepared(descriptor.nativeHook);
      // The generated flag is part of argv before escaping, so the batch text
      // quotes it like every other token and the percent carrier still covers
      // the whole line.
      const argv = ["--profile", "100% & echo PWNED", "--no-daemon", ...hook.args];
      const carriers = Object.keys(descriptor.env).filter((name) => /^PRG_NATIVE_BATCH_PCT_\d+$/u.test(name));
      assert.equal(carriers.length, 1);
      const carrier = carriers[0]!;
      const quote = (token: string): string => helperModule.cmdQuote(token.replace(/%/gu, `%${carrier}%`));
      assert.equal(descriptor.commandLine,
        `/d /s /v:off /c "set "${carrier}=" & ${[shim, ...argv].map(quote).join(" ")}"`,
        "the hook flag is quoted by the shipped cmdQuote and never escapes the batch line");
      assert.equal(descriptor.env[carrier], "%");
      // The marker rides in the environment, never in the command text.
      assert.ok(!descriptor.commandLine.includes(TOKEN));
      assert.ok(descriptor.env[NATIVE_HOOK_BOOTSTRAP_ENV]!.includes(TOKEN));
      assert.deepEqual(Object.keys(descriptor.env).filter((name) => /NATIVE_HOOK_BOOTSTRAP/i.test(name)), [NATIVE_HOOK_BOOTSTRAP_ENV]);
      // A Windows Codex hook command carries the platform-specific form too.
      assert.ok(hook.args[1]!.includes("commandWindows="), "the provider's own Windows command field is used");
      await hook.lease.cleanup();
    } finally {
      helperModule.resolveTrustedWindowsCmd = shipped;
    }
  });
});

test("a Codex hook command that cannot be delivered faithfully by the provider shell is declined, not approximated", async () => {
  await fixture(async (_root, bin) => {
    const relay = join(bin, "relay %PRG% name.js");
    await writeFile(relay, "// never invoked\n");
    const outcome = unavailable(await prepareNativeHookLaunch(preparationInput("codex", [], {
      platform: "win32",
      windowsCommandQuoter: helperModule.cmdQuote,
      entrypoints: { nodeExecutable: process.execPath, relayEntry: relay },
    })));
    assert.equal(outcome.reason, "unsafe-command-quoting");

    // The POSIX provider shell single-quotes everything, so the same path is
    // faithful there.
    const posix = prepared(await prepareNativeHookLaunch(preparationInput("claude", [], {
      entrypoints: { nodeExecutable: process.execPath, relayEntry: relay },
    })));
    const staged = JSON.parse(readFileSync(posix.args[1]!, "utf8")) as {
      hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]>;
    };
    assert.deepEqual(staged.hooks.Stop![0]!.hooks[0]!.args, [relay]);
    await posix.lease.cleanup();
  });
});

test("a Windows Claude launch keeps literal % and ! paths as exec-form data and needs no command quoter", async () => {
  await fixture(async (_root, bin) => {
    // cmd would expand these in a shell command string; Claude's exec form
    // spawns the file directly with these exact argument bytes, so they are
    // ordinary data and must survive untouched on both routes.
    const node = join(bin, "node 100% & !PRG!.exe");
    const relay = join(bin, "native-hook-relay 100% & !PRG!.js");
    await writeFile(node, "x");
    await writeFile(relay, "// never invoked\n");
    const entrypoints = { nodeExecutable: node, relayEntry: relay };
    const settings = prepared(await prepareNativeHookLaunch(preparationInput("claude", [], {
      platform: "win32",
      entrypoints,
    })));
    const plugin = prepared(await prepareNativeHookLaunch(preparationInput("claude", ["--settings", "/op/s.json"], {
      platform: "win32",
      entrypoints,
    })));
    assert.equal(settings.route, "claude-settings-file");
    assert.equal(plugin.route, "claude-plugin-dir");
    for (const [outcome, file] of [
      [settings, settings.args[1]!] as const,
      [plugin, join(plugin.args[1]!, "hooks", "hooks.json")] as const,
    ]) {
      const staged = JSON.parse(readFileSync(file, "utf8")) as {
        hooks: Record<string, { hooks: { type: string; command: string; args: string[] }[] }[]>;
      };
      for (const event of CLAUDE_NATIVE_HOOK_EVENTS) {
        const entry = staged.hooks[event]![0]!.hooks[0]!;
        assert.equal(entry.type, "command");
        assert.equal(entry.command, node, "the executable path is exact data, not shell text");
        assert.deepEqual(entry.args, [relay], "the relay path is exact data, not shell text");
      }
      await outcome.lease.cleanup();
    }
  });
});

test("a Claude launch whose descriptor construction fails rolls its staged artifacts back", async () => {
  await fixture(async (_root, bin) => {
    const shim = join(bin, "claude.cmd");
    await writeFile(shim, "@echo off\r\n");
    await chmod(shim, 0o755);
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const shipped = helperModule.resolveTrustedWindowsCmd;
    // A .cmd child needs the one trusted cmd.exe; without it the launch is
    // refused AFTER a Claude preparation staged its artifacts.
    helperModule.resolveTrustedWindowsCmd = () => null;
    try {
      const launcher = createNativeCliLauncher(configWith({
        op: { adapter: "claude-cli", command: shim, args: [], review: {} },
      }), {
        platform: "win32",
        parentEnvironment: { SystemRoot: "Z:\\Fixture Windows Root" },
      });
      const before = hookArtifactRootCount();
      await assert.rejects(
        launcher("claude", {
          workspace,
          env: { PATH: bin },
          targetId: "external:op",
          nativeHook: { bootstrap: bootstrapFor("claude") },
        }),
        /cmd\.exe/u,
      );
      assert.equal(hookArtifactRootCount(), before,
        "the caller received no descriptor, so the prepared lease was released rather than orphaned");
    } finally {
      helperModule.resolveTrustedWindowsCmd = shipped;
    }
  });
});

test("a missing hook entrypoint leaves the row unknown instead of failing the operator's launch", async () => {
  await fixture(async (_root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const outcome = unavailable(await prepareNativeHookLaunch(preparationInput("claude", [], {
      entrypoints: { nodeExecutable: process.execPath, relayEntry: join(bin, "not-compiled.js") },
    })));
    assert.equal(outcome.reason, "hook-entry-unavailable");
    // In the real layout the compiled relay entry sits beside this module's own
    // directory, so production arming never depends on a fixture.
    const compiledRelay = join(__dirname, "..", "src", "session-host", "native-hook-relay.js");
    assert.ok(statSync(compiledRelay).isFile(), `${compiledRelay} must exist for production arming`);
    const launcher: NativeCliLauncher = createNativeCliLauncher(configWith({}), { platform: process.platform });
    const descriptor = await launcher("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      nativeHook: { bootstrap: bootstrapFor("claude") },
    });
    const hook = prepared(descriptor.nativeHook);
    assert.equal(hook.route, "claude-settings-file");
    await hook.lease.cleanup();
  });
});
