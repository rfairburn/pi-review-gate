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
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
  type NativeHookArtifactLease,
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

/**
 * The descriptor platform the launch adapter is exercised under. A POSIX host
 * keeps the established macOS descriptor; a Windows host must use its own
 * platform, because a POSIX descriptor reads a backslash path as a bare
 * command string and Windows discovery selects only PATHEXT candidates.
 */
const LAUNCHER_PLATFORM: NodeJS.Platform = process.platform === "win32" ? "win32" : "darwin";

/** A provider CLI placeholder name the host-native discovery actually selects. */
function cliFileName(name: "claude" | "codex"): string {
  return LAUNCHER_PLATFORM === "win32" ? `${name}.exe` : name;
}

/** Path-aware containment: `path` lies strictly below `root` on this host. */
function assertStrictlyInside(root: string, path: string, message?: string): void {
  const below = relative(root, path);
  assert.ok(
    below.length > 0 && below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below),
    message ?? `${path} lies strictly inside ${root}`,
  );
}

type OwnedFixtureKind =
  /** A test-created file (a replacement, a renamed original, a foreign entry). */
  | "file"
  /** A directory emptied by the steps registered after it; removed non-recursively. */
  | "directory"
  /** A test-created symlink or Windows junction; unlinked without following it. */
  | "link"
  /** A tree the test moved out of an owned namespace; removed recursively, links never followed. */
  | "tree";

/**
 * Failure-safe teardown for one fixture. Every lease is released first (lease
 * cleanup is idempotent, so a test that already released it is unaffected),
 * then only the test-owned objects registered here are removed, newest first,
 * whether the test body passed or failed. Nothing unregistered outside the
 * fixture's own temp tree is ever touched.
 */
interface FixtureOwnership {
  /**
   * Record the lease of any prepared outcome and return the outcome unchanged.
   * Call it on every preparation result and every `descriptor.nativeHook`
   * BEFORE asserting what it should be, so an unexpected arming (a regression
   * the assertion then reports) is still released by teardown.
   */
  track<T extends NativeHookLaunchOutcome | undefined>(outcome: T): T;
  own(path: string, kind: OwnedFixtureKind): string;
}

async function removeOwned(path: string, kind: OwnedFixtureKind): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (kind === "link") {
    if (!stats.isSymbolicLink()) throw new Error(`refusing to unlink ${path}: it is no longer a link`);
    // A Windows junction is a directory reparse point; `unlink` removes the
    // link itself and never reaches its target.
    await unlink(path);
    return;
  }
  if (stats.isSymbolicLink()) throw new Error(`refusing to remove ${path} as a ${kind}: it is now a link`);
  if (kind === "file") await unlink(path);
  else if (kind === "directory") await rmdir(path);
  else await rm(path, { recursive: true, force: true });
}

/** One hermetic temp tree, always outside the repository worktree. */
async function fixture(run: (root: string, bin: string, owned: FixtureOwnership) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-hook-prep-")));
  const leases: NativeHookArtifactLease[] = [];
  const registered: { path: string; kind: OwnedFixtureKind }[] = [];
  const owned: FixtureOwnership = {
    track(outcome) {
      if (outcome?.observation === "prepared") leases.push(outcome.lease);
      return outcome;
    },
    own(path, kind) {
      registered.push({ path, kind });
      return path;
    },
  };
  let failure: { error: unknown } | undefined;
  try {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await run(root, bin, owned);
  } catch (error) {
    failure = { error };
  }
  const teardownErrors: unknown[] = [];
  for (const lease of leases) {
    try { await lease.cleanup(); } catch (error) { teardownErrors.push(error); }
  }
  for (const { path, kind } of [...registered].reverse()) {
    try { await removeOwned(path, kind); } catch (error) { teardownErrors.push(error); }
  }
  try { await rm(root, { recursive: true, force: true }); } catch (error) { teardownErrors.push(error); }
  if (failure !== undefined) {
    // The original failure stays the reported one; teardown problems are
    // still made visible rather than silently swallowed.
    for (const error of teardownErrors) console.error("native-hook-prep fixture teardown:", error);
    throw failure.error;
  }
  if (teardownErrors.length > 0) throw new AggregateError(teardownErrors, "native-hook-prep fixture teardown failed");
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
  await fixture(async (_root, bin, owned) => {
    const node = join(bin, "node");
    const relay = join(bin, "native-hook-relay.js");
    await fakeExecutable(node);
    await writeFile(relay, "// never invoked\n");
    const outcome = prepared(owned.track(await prepareNativeHookLaunch(preparationInput("claude", [], {
      entrypoints: { nodeExecutable: node, relayEntry: relay },
    }))));
    assert.equal(outcome.route, "claude-settings-file");
    assert.equal(outcome.backend, "claude");
    assert.equal(outcome.args.length, 2);
    assert.equal(outcome.args[0], "--settings");
    const root = outcome.lease.root;
    assert.ok(root !== null);
    assertStrictlyInside(root, outcome.args[1]!, "the staged settings file lies inside its own owned root");

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

test("staged artifacts are private", {
  // Only the mode bits are POSIX-specific; the ownership and replacement rules
  // below run on every platform.
  skip: process.platform === "win32" ? "POSIX permission bits; Windows chmod does not express private modes" : false,
}, async () => {
  await fixture(async (_root, bin, owned) => {
    const relay = join(bin, "native-hook-relay.js");
    await writeFile(relay, "// never invoked\n");
    const entrypoints = { nodeExecutable: process.execPath, relayEntry: relay };
    const outcome = prepared(owned.track(await prepareNativeHookLaunch(preparationInput("claude", [], { entrypoints }))));
    const root = outcome.lease.root as string;
    assert.equal(statSync(root).mode & 0o777, 0o700, "the owned root is private");
    assert.equal(statSync(outcome.args[1]!).mode & 0o777, 0o600, "the staged settings file is private");
    const cleanup = await outcome.lease.cleanup();
    assert.deepEqual(cleanup.preserved, []);
  });
});

test("cleanup removes only its own inodes and preserves a foreign or replaced entry", async () => {
  await fixture(async (_root, bin, owned) => {
    const relay = join(bin, "native-hook-relay.js");
    await writeFile(relay, "// never invoked\n");
    const entrypoints = { nodeExecutable: process.execPath, relayEntry: relay };
    const outcome = prepared(owned.track(await prepareNativeHookLaunch(preparationInput("claude", [], { entrypoints }))));
    const root = outcome.lease.root as string;

    // An entry this namespace never created is never deleted, and its presence
    // keeps the root itself in place.
    owned.own(root, "directory");
    const foreign = owned.own(join(root, "someone-else-s-file"), "file");
    await writeFile(foreign, "not ours\n", { flag: "wx" });
    const cleanup = await outcome.lease.cleanup();
    assert.ok(existsSync(foreign), "an unknown entry survives");
    assert.equal(readFileSync(foreign, "utf8"), "not ours\n", "the foreign entry is untouched");
    assert.ok(existsSync(root), "a root that no longer holds only our entries survives");
    assert.ok(!existsSync(outcome.args[1]!), "our own file is still removed");
    assert.deepEqual(cleanup.preserved, [root]);

    // A replaced entry is not ours any more: its path is preserved, not unlinked.
    const second = prepared(owned.track(await prepareNativeHookLaunch(preparationInput("claude", [], { entrypoints }))));
    const secondRoot = owned.own(second.lease.root as string, "directory");
    const secondFile = second.args[1]!;
    const ownedIdentity = await lstat(secondFile, { bigint: true });
    // Fixture precondition: a freed inode may be reused by the next create, so
    // the "replacement" could be the very object the lease owns. The owned
    // file is renamed to a test-owned sibling instead of unlinked, which keeps
    // it allocated on every platform, and only then is the replacement
    // created exclusively at the original path.
    const movedOriginal = owned.own(`${secondFile}.moved-original`, "file");
    await rename(secondFile, movedOriginal);
    const replacement = owned.own(secondFile, "file");
    await writeFile(replacement, "replaced by someone else\n", { flag: "wx" });
    const replacementIdentity = await lstat(replacement, { bigint: true });
    assert.ok(
      replacementIdentity.dev !== ownedIdentity.dev || replacementIdentity.ino !== ownedIdentity.ino,
      "the fixture really replaced the owned object before the lease is released",
    );
    const secondCleanup = await second.lease.cleanup();
    assert.ok(existsSync(secondFile), "a replaced entry is never unlinked");
    assert.equal(readFileSync(secondFile, "utf8"), "replaced by someone else\n", "the replacement survives intact");
    assert.ok(existsSync(movedOriginal), "an entry at a path the lease never recorded is never touched");
    assert.ok(existsSync(secondRoot), "the root survives its own preserved entry");
    assert.ok(secondCleanup.preserved.includes(secondFile));
    assert.ok(secondCleanup.preserved.includes(secondRoot));
    assert.ok(!secondCleanup.removed.includes(secondFile));
    // The registered replacement, renamed original, foreign file, and both
    // roots are removed by the fixture teardown, pass or fail.
  });
});

test("an operator --settings in real option position switches to the approved hooks-only plugin fallback", async () => {
  await fixture(async (_root, bin, owned) => {
    const node = join(bin, "node");
    const relay = join(bin, "native-hook-relay.js");
    const cli = join(bin, cliFileName("claude"));
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
    }), { platform: LAUNCHER_PLATFORM });
    const descriptor = await launcher("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      targetId: "external:op",
      nativeHook: { bootstrap: bootstrapFor("claude") },
    });
    const hook = prepared(owned.track(descriptor.nativeHook));
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
  await fixture(async (_root, bin, owned) => {
    const relay = join(bin, "native-hook-relay.js");
    await writeFile(relay, "// never invoked\n");
    const entrypoints = { nodeExecutable: process.execPath, relayEntry: relay };

    // The owned root is renamed out of the way and its original path becomes a
    // link to it — a symlink on POSIX, a directory junction on Windows (which
    // needs no symlink privilege and is equally a reparse point `lstat` sees as
    // a link). Every leaf inode still matches, so only an ancestry check can
    // stop cleanup from deleting through the replacement.
    const viaRoot = prepared(owned.track(await prepareNativeHookLaunch(preparationInput("claude", [], { entrypoints }))));
    const originalRoot = viaRoot.lease.root as string;
    const settingsPath = viaRoot.args[1]!;
    const movedRoot = owned.own(join(_root, "moved-root"), "tree");
    await rename(originalRoot, movedRoot);
    owned.own(originalRoot, "link");
    await symlink(movedRoot, originalRoot, process.platform === "win32" ? "junction" : "dir");
    assert.ok((await lstat(originalRoot)).isSymbolicLink(), "the replacement root really is a link");
    const rootCleanup = await viaRoot.lease.cleanup();
    assert.ok(existsSync(join(movedRoot, "claude-hook-settings.json")), "nothing is deleted through a replacement root");
    assert.ok((await lstat(originalRoot)).isSymbolicLink(), "the replacement link itself survives");
    assert.deepEqual(rootCleanup.removed, []);
    assert.deepEqual(rootCleanup.preserved, [settingsPath, originalRoot]);

    // The same rule one level down: the hooks directory is replaced by a fresh
    // directory holding a foreign file, so neither it nor its subtree is touched.
    const viaPlugin = prepared(owned.track(await prepareNativeHookLaunch(preparationInput("claude", ["--settings", "/op/s.json"], { entrypoints }))));
    const pluginLeaseRoot = viaPlugin.lease.root as string;
    const pluginRoot = viaPlugin.args[1]!;
    const hooksDir = join(pluginRoot, "hooks");
    const hooksFile = join(hooksDir, "hooks.json");
    const movedHooks = owned.own(join(_root, "moved-hooks"), "tree");
    // The owned directories left behind once the foreign subtree blocks their
    // removal: registered before the replacement so teardown empties them first.
    owned.own(pluginLeaseRoot, "directory");
    owned.own(pluginRoot, "directory");
    await rename(hooksDir, movedHooks);
    owned.own(hooksDir, "directory");
    await mkdir(hooksDir);
    const foreign = owned.own(join(hooksDir, "someone-else-s.json"), "file");
    await writeFile(foreign, "not ours\n", { flag: "wx" });
    const pluginCleanup = await viaPlugin.lease.cleanup();
    assert.ok(existsSync(join(movedHooks, "hooks.json")), "the real owned file is not reached through a replaced directory");
    assert.ok(existsSync(foreign), "the foreign entry survives");
    assert.ok(pluginCleanup.preserved.includes(hooksFile));
    assert.ok(pluginCleanup.preserved.includes(hooksDir));
    assert.ok(pluginCleanup.preserved.includes(pluginRoot), "the plugin root survives while a foreign subtree remains");
    assert.ok(existsSync(pluginRoot));
    // Teardown removes the link before the moved tree it points at, and the
    // foreign file before the directories it kept in place.
  });
});

test("an option-like operand or a --settings past the -- terminator is data, never a conflict", async () => {
  await fixture(async (_root, bin, owned) => {
    const relay = join(bin, "native-hook-relay.js");
    await writeFile(relay, "// never invoked\n");
    const entrypoints = { nodeExecutable: process.execPath, relayEntry: relay };
    // Here `--settings` is the VALUE of --append-system-prompt: the provider
    // reads it as prompt text, so our own --settings is still available.
    const asOperand = prepared(owned.track(await prepareNativeHookLaunch(preparationInput("claude", ["--append-system-prompt", "--settings"], { entrypoints }))));
    assert.equal(asOperand.route, "claude-settings-file");
    // Here it is literal prompt data past the terminator.
    const pastTerminator = prepared(owned.track(await prepareNativeHookLaunch(preparationInput("claude", ["--", "--settings", "hooks"], { entrypoints }))));
    assert.equal(pastTerminator.route, "claude-settings-file");
    await asOperand.lease.cleanup();
    await pastTerminator.lease.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Codex acquisition
// ---------------------------------------------------------------------------

test("Codex adds only a SessionStart override whose command content is stable across rows", async () => {
  await fixture(async (_root, bin, owned) => {
    const node = join(bin, "node with spaces");
    const relay = join(bin, "relay's 'odd' name.js");
    await writeFile(node, "x");
    await writeFile(relay, "// never invoked\n");
    const entrypoints = { nodeExecutable: node, relayEntry: relay };

    const first = prepared(owned.track(await prepareNativeHookLaunch(preparationInput("codex", [], {
      entrypoints,
      bootstrap: bootstrapFor("codex", TOKEN),
    }))));
    const second = prepared(owned.track(await prepareNativeHookLaunch(preparationInput("codex", [], {
      entrypoints,
      bootstrap: bootstrapFor("codex", "f".repeat(64)),
    }))));

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
  await fixture(async (_root, bin, owned) => {
    const relay = join(bin, "native-hook-relay.js");
    const cli = join(bin, cliFileName("codex"));
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
      const outcome = unavailable(owned.track(await prepareNativeHookLaunch(preparationInput("codex", args, { entrypoints }))));
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
      const outcome = prepared(owned.track(await prepareNativeHookLaunch(preparationInput("codex", args, { entrypoints }))));
      assert.equal(outcome.route, "codex-session-start", `${JSON.stringify(args)} stays acquirable`);
    }

    // A declined acquisition composes exactly the legacy argv with no marker.
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const conflict = ["-c", "hooks.SessionStart=[{type=\"command\",command=\"operator.sh\"}]"];
    const launcher = createNativeCliLauncher(configWith({
      op: { adapter: "codex-cli", command: cli, args: conflict, review: {} },
    }), { platform: LAUNCHER_PLATFORM });
    const descriptor = await launcher("codex", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      targetId: "external:op",
      nativeHook: { bootstrap: bootstrapFor("codex") },
    });
    const hook = owned.track(descriptor.nativeHook);
    assert.deepEqual(descriptor.args, [...conflict, "--no-daemon"]);
    assert.equal(unavailable(hook).reason, "operator-hook-override");
    assert.equal(descriptor.env[NATIVE_HOOK_BOOTSTRAP_ENV], undefined, "a declined row carries no marker");
    assert.equal(descriptor.env.HERDR_ENV, "1", "the existing clipboard marker is unaffected");
  });
});

// ---------------------------------------------------------------------------
// Environment marker, role, and identity rules
// ---------------------------------------------------------------------------

test("the fresh marker is the only bootstrap the child can see, and a worker role is rejected before any artifact", async () => {
  await fixture(async (_root, bin, owned) => {
    await fakeExecutable(join(bin, cliFileName("claude")));
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const stale = JSON.stringify(bootstrapFor("claude", "b".repeat(64)));
    const launcher = createNativeCliLauncher(configWith({}), { platform: LAUNCHER_PLATFORM });

    const armed = await launcher("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home", [NATIVE_HOOK_BOOTSTRAP_ENV]: stale },
      nativeHook: { bootstrap: bootstrapFor("claude") },
    });
    const hook = prepared(owned.track(armed.nativeHook));
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
    // itself before it could touch the filesystem. Each probe records any
    // outcome it unexpectedly returns, so a regression still fails the
    // rejection assertion and its lease is still released by teardown.
    await assert.rejects(
      async () => {
        owned.track((await launcher("claude", { workspace, env: { PATH: bin, [RUNTIME_ROLE_ENV]: "executor" }, nativeHook: { bootstrap: bootstrapFor("claude") } })).nativeHook);
      },
      new RegExp(RUNTIME_ROLE_ENV, "u"),
    );
    const before = hookArtifactRootCount();
    await assert.rejects(
      async () => {
        owned.track(await prepareNativeHookLaunch(preparationInput("claude", [], { env: { [RUNTIME_ROLE_ENV]: "executor" } })));
      },
      new RegExp(RUNTIME_ROLE_ENV, "u"),
    );
    assert.equal(hookArtifactRootCount(), before, "a rejected worker-role preparation stages nothing");

    // A cross-backend or malformed bootstrap is a refusal, never a partial arming.
    await assert.rejects(
      async () => {
        owned.track(await prepareNativeHookLaunch(preparationInput("claude", [], { bootstrap: bootstrapFor("codex") })));
      },
      /cannot arm a claude launch/u,
    );
    await assert.rejects(
      async () => {
        owned.track(await prepareNativeHookLaunch(preparationInput("claude", [], { bootstrap: { ...bootstrapFor("claude"), token: "nope" } as never })));
      },
      /malformed/u,
    );
    assert.equal(hookArtifactRootCount(), before, "a refused bootstrap stages nothing either");
  });
});

test("with no hook option the descriptor stays exactly what it was: no flag, no marker, no artifact", async () => {
  await fixture(async (_root, bin, owned) => {
    await fakeExecutable(join(bin, cliFileName("claude")));
    await fakeExecutable(join(bin, cliFileName("codex")));
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const configured = ["--model", "opus", "--", "--settings", "--plugin-dir", "-p", "100% & echo PWNED"];
    const launcher = createNativeCliLauncher(configWith({
      op: { adapter: "claude-cli", command: join(bin, cliFileName("claude")), args: configured, review: {} },
    }), { platform: LAUNCHER_PLATFORM });
    const before = hookArtifactRootCount();

    const plain = await launcher("claude", { workspace, env: { PATH: bin }, targetId: "external:op" });
    assert.equal(owned.track(plain.nativeHook), undefined);
    assert.deepEqual(plain.args, configured);
    assert.equal(plain.env[NATIVE_HOOK_BOOTSTRAP_ENV], undefined);

    const plainCodex = await createNativeCliLauncher(configWith({}), { platform: LAUNCHER_PLATFORM })("codex", { workspace, env: { PATH: bin } });
    assert.equal(owned.track(plainCodex.nativeHook), undefined);
    assert.deepEqual(plainCodex.args, ["--no-daemon"]);
    assert.equal(plainCodex.env.HERDR_ENV, "1");
    assert.equal(plainCodex.env[NATIVE_HOOK_BOOTSTRAP_ENV], undefined);
    assert.equal(hookArtifactRootCount(), before, "an unarmed launch creates nothing");
  });
});

test("generated flags land in real option position and every operator token after -- stays literal", async () => {
  await fixture(async (_root, bin, owned) => {
    await fakeExecutable(join(bin, cliFileName("claude")));
    await fakeExecutable(join(bin, cliFileName("codex")));
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const configured = ["--model", "opus", "--", "--settings", "--plugin-dir", "-p", "100% & echo PWNED"];
    const launcher = createNativeCliLauncher(configWith({
      op: { adapter: "claude-cli", command: join(bin, cliFileName("claude")), args: configured, review: {} },
    }), { platform: LAUNCHER_PLATFORM });
    const descriptor = await launcher("claude", {
      workspace,
      env: { PATH: bin },
      targetId: "external:op",
      nativeHook: { bootstrap: bootstrapFor("claude") },
    });
    const hook = prepared(owned.track(descriptor.nativeHook));
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
      op: { adapter: "codex-cli", command: join(bin, cliFileName("codex")), args: ["--profile"], review: {} },
    }), { platform: LAUNCHER_PLATFORM });
    const codex = await danglingLauncher("codex", {
      workspace,
      env: { PATH: bin },
      targetId: "external:op",
      nativeHook: { bootstrap: bootstrapFor("codex") },
    });
    const codexHook = prepared(owned.track(codex.nativeHook));
    assert.deepEqual(codex.args.slice(0, 4), ["--no-daemon", "-c", codexHook.args[1], "--profile"]);
    await codexHook.lease.cleanup();
  });
});

test("a Windows .cmd CLI carries the generated hook flags through the one batch escaping path", async () => {
  await fixture(async (_root, bin, owned) => {
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
      const hook = prepared(owned.track(descriptor.nativeHook));
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
  await fixture(async (_root, bin, owned) => {
    const relay = join(bin, "relay %PRG% name.js");
    await writeFile(relay, "// never invoked\n");
    const outcome = unavailable(owned.track(await prepareNativeHookLaunch(preparationInput("codex", [], {
      platform: "win32",
      windowsCommandQuoter: helperModule.cmdQuote,
      entrypoints: { nodeExecutable: process.execPath, relayEntry: relay },
    }))));
    assert.equal(outcome.reason, "unsafe-command-quoting");

    // The POSIX provider shell single-quotes everything, so the same path is
    // faithful there.
    const posix = prepared(owned.track(await prepareNativeHookLaunch(preparationInput("claude", [], {
      entrypoints: { nodeExecutable: process.execPath, relayEntry: relay },
    }))));
    const staged = JSON.parse(readFileSync(posix.args[1]!, "utf8")) as {
      hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]>;
    };
    assert.deepEqual(staged.hooks.Stop![0]!.hooks[0]!.args, [relay]);
    await posix.lease.cleanup();
  });
});

test("a Windows Claude launch keeps literal % and ! paths as exec-form data and needs no command quoter", async () => {
  await fixture(async (_root, bin, owned) => {
    // cmd would expand these in a shell command string; Claude's exec form
    // spawns the file directly with these exact argument bytes, so they are
    // ordinary data and must survive untouched on both routes.
    const node = join(bin, "node 100% & !PRG!.exe");
    const relay = join(bin, "native-hook-relay 100% & !PRG!.js");
    await writeFile(node, "x");
    await writeFile(relay, "// never invoked\n");
    const entrypoints = { nodeExecutable: node, relayEntry: relay };
    const settings = prepared(owned.track(await prepareNativeHookLaunch(preparationInput("claude", [], {
      platform: "win32",
      entrypoints,
    }))));
    const plugin = prepared(owned.track(await prepareNativeHookLaunch(preparationInput("claude", ["--settings", "/op/s.json"], {
      platform: "win32",
      entrypoints,
    }))));
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
  await fixture(async (_root, bin, owned) => {
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
        async () => {
          // An unexpectedly armed descriptor fails the rejection assertion,
          // and its recorded lease is still released by teardown.
          owned.track((await launcher("claude", {
            workspace,
            env: { PATH: bin },
            targetId: "external:op",
            nativeHook: { bootstrap: bootstrapFor("claude") },
          })).nativeHook);
        },
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
  await fixture(async (_root, bin, owned) => {
    await fakeExecutable(join(bin, cliFileName("claude")));
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const outcome = unavailable(owned.track(await prepareNativeHookLaunch(preparationInput("claude", [], {
      entrypoints: { nodeExecutable: process.execPath, relayEntry: join(bin, "not-compiled.js") },
    }))));
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
    const hook = prepared(owned.track(descriptor.nativeHook));
    assert.equal(hook.route, "claude-settings-file");
    await hook.lease.cleanup();
  });
});
