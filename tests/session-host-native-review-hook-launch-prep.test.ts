import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import { normalizeConfig } from "../src/config";
import { RUNTIME_ROLE_ENV } from "../src/session-host/launch";
import { NATIVE_HOOK_BOOTSTRAP_ENV, type NativeHookBootstrap } from "../src/session-host/native-hook-protocol";
import { createNativeCliLauncher, scanNativeArgPositions } from "../src/session-host/native-cli-launch";
import { isPrivatePosixArtifactRoot } from "../src/session-host/native-hook-launch-prep";
import { MAX_NATIVE_CLI_ARGS } from "../src/session-host/session-backend";
import { createPeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permissions";

/** The launcher's own helpers, so a Windows batch render can be exercised for real. */
const helperModule = require(resolve("scripts/pi-review-gate-launcher.cjs")) as {
  resolveTrustedWindowsCmd: (parentEnvironment?: NodeJS.ProcessEnv) => string | null;
};
import {
  NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV,
  NATIVE_REVIEW_HOOK_EVENTS,
  parseNativeReviewBootstrapEnv,
  type NativeReviewBootstrap,
} from "../src/session-host/native-review-hook-protocol";
import {
  CODEX_REVIEW_SHIM_NAME,
  NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS,
  codexReviewHookConfigArgs,
  codexReviewHookOverrideConflict,
  codexReviewShimContents,
  codexReviewShimPath,
  nativeReviewHookEventMap,
  prepareNativeReviewHookLaunch,
  resolveNativeReviewHookEntrypoints,
  type NativeReviewHookLaunchOutcome,
  type NativeReviewHookLaunchPreparationInput,
} from "../src/session-host/native-review-hook-launch-prep";

/**
 * Per-launch preparation of the BLOCKING native review hook (#736 slice 3b).
 * Everything here is synthetic: no provider CLI is ever executed, no provider
 * configuration, trust record, or credential is read or written, and no artifact
 * is created inside this repository — every fixture and every staged artifact
 * lives under the system temporary directory.
 */

const INSTANCE_ID = "3f2a1b90-7c6d-4e5f-8a9b-0c1d2e3f4a5b";
const GENERATION = "9a8b7c6d-5e4f-4321-8765-4321fedcba09";
const TOKEN = "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f";
const SOCKET = "/tmp/prg-synthetic-status-broker.sock";

function bootstrapFor(backend: "claude" | "codex", token = TOKEN): NativeReviewBootstrap {
  return { version: 1, socketPath: SOCKET, generation: GENERATION, instanceId: INSTANCE_ID, backend, token };
}

interface FixtureOptions {
  /**
   * Point the process's temp namespace at a directory inside this fixture. `os.tmpdir()`
   * re-reads `TMPDIR`/`TMP`/`TEMP` on every call on POSIX, so every artifact root this
   * test stages — this feature's or the observer lane's — lands somewhere only this test
   * writes to. "Did this call stage anything?" then becomes a fact about this test
   * instead of a count over a directory other suites are filling at the same time.
   */
  isolateTempNamespace?: boolean;
  /**
   * On Windows, `os.tmpdir()` consults `USERPROFILE` before `TMP`, so a namespace set
   * only through `TMP`/`TEMP`/`TMPDIR` never takes effect and a Windows fixture would
   * silently measure the real user temp directory. This opts in to moving `USERPROFILE`
   * as well, which is the only way the namespace actually moves on that platform.
   */
  tempNamespaceViaUserProfile?: boolean;
}

/** One hermetic temp tree, always outside the repository worktree. */
async function fixture(
  run: (root: string, bin: string) => Promise<void>,
  options: FixtureOptions = {},
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-review-prep-")));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const saved: Record<string, string | undefined> = {
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
  };
  if (options.isolateTempNamespace === true) {
    const namespace = join(root, "temp-namespace");
    await mkdir(namespace, { recursive: true });
    process.env.TMPDIR = namespace;
    process.env.TMP = namespace;
    process.env.TEMP = namespace;
    if (options.tempNamespaceViaUserProfile === true) process.env.USERPROFILE = namespace;
    // Isolation is only isolation if `os.tmpdir()` actually moved. Windows consults
    // `USERPROFILE` before `TMP`, so a namespace can be requested and still not take
    // effect; the census helpers then decline to compare a shared directory rather than
    // pretend they measured a private one.
    activeTempNamespace = tmpdir() === namespace ? namespace : undefined;
  }
  try {
    await run(root, bin);
  } finally {
    activeTempNamespace = undefined;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

/** The fixture's temp namespace while it is genuinely in force, otherwise undefined. */
let activeTempNamespace: string | undefined;

async function fakeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\necho never invoked\n");
  await chmod(path, 0o755);
}

/**
 * The fixture's fake operator CLI spelled as an explicit path.
 *
 * The launchers below simulate a POSIX platform, and that platform's rule is
 * that a bare command name carrying a separator or a shell metacharacter is a
 * shell command string, refused before any launch work. A host-native `join`
 * spells the same file with backslashes on Windows, which that simulated rule
 * reads as a bare shell string, so the target would be refused there for a
 * reason that has nothing to do with this lane. `/` separates a path on both
 * platforms and Node's filesystem accepts it on Windows, so this one spelling
 * is an explicit executable path wherever the suite runs.
 */
function explicitCliPath(bin: string, name: string): string {
  const path = join(bin, name);
  return process.platform === "win32" ? path.replace(/\\/gu, "/") : path;
}

function preparationInput(
  backend: "claude" | "codex",
  overrides: Partial<NativeReviewHookLaunchPreparationInput> = {},
): NativeReviewHookLaunchPreparationInput {
  return {
    backend,
    bootstrap: bootstrapFor(backend),
    platform: "darwin",
    env: { PATH: "/usr/bin" },
    ...overrides,
  };
}

/**
 * The artifact roots that currently exist in THIS test's temp namespace. Every caller
 * runs inside `fixture({ isolateTempNamespace: true })`, so this is a census of what
 * this test staged and never a race with another suite's roots.
 */
/**
 * The exact sorted list of this feature's staged artifact roots in the fixture's private
 * temp namespace, or `undefined` when no namespace is in force. Counting the shared temp
 * directory would race with every other concurrently running suite, so a census is only
 * ever reported where it actually measures this fixture's own directory.
 */
function stagedRoots(prefix: string): string[] | undefined {
  if (activeTempNamespace === undefined) return undefined;
  try {
    return readdirSync(activeTempNamespace).filter((name) => name.startsWith(prefix)).sort();
  } catch {
    return [];
  }
}

/** Assert an exact staged-root census, or state plainly that this platform gave none. */
function assertStagedRoots(
  t: TestContext,
  prefix: string,
  expected: string[],
  what: string,
): void {
  const observed = stagedRoots(prefix);
  if (observed === undefined) {
    t.diagnostic(`no temp namespace on ${process.platform}: ${what} checked by exact path instead`);
    return;
  }
  assert.deepEqual(observed, expected, what);
}

function prepared(outcome: NativeReviewHookLaunchOutcome | undefined) {
  assert.equal(outcome?.review, "prepared", `expected a prepared outcome, got ${String(outcome?.review)}`);
  if (outcome?.review !== "prepared") throw new Error("unreachable");
  return outcome;
}

function unavailable(outcome: NativeReviewHookLaunchOutcome | undefined) {
  assert.equal(outcome?.review, "unavailable", `expected an unavailable outcome, got ${String(outcome?.review)}`);
  if (outcome?.review !== "unavailable") throw new Error("unreachable");
  return outcome;
}

/** A usable relay entry, so an entrypoint rule never masks the assertion at hand. */
async function relayEntryIn(bin: string): Promise<string> {
  const relay = join(bin, "native-review-hook-relay.js");
  await writeFile(relay, "// never invoked\n");
  return relay;
}

// ---------------------------------------------------------------------------
// The fixed provider contract
// ---------------------------------------------------------------------------

test("the review hook's provider timeout is the one fixed hour-long constant this lane owns", () => {
  assert.equal(NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS, 3600);
  // The observer lane's short ceiling is a different number on purpose: an
  // observer must never stall a turn, while a review legitimately takes minutes.
  const map = nativeReviewHookEventMap({ nodeExecutable: "/synthetic/node", relayEntry: "/synthetic/relay.js" });
  for (const event of NATIVE_REVIEW_HOOK_EVENTS) {
    const handler = (map[event]![0] as { hooks: Record<string, unknown>[] }).hooks[0]!;
    assert.equal(handler.timeout, NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS);
  }
});

test("a Claude review launch stages one review-only plugin dir and adds exactly one --plugin-dir", async () => {
  await fixture(async (_root, bin) => {
    const node = join(bin, "node");
    await fakeExecutable(node);
    const relay = await relayEntryIn(bin);
    const outcome = prepared(await prepareNativeReviewHookLaunch(preparationInput("claude", {
      entrypoints: { nodeExecutable: node, relayEntry: relay },
    })));
    assert.equal(outcome.route, "claude-plugin-dir");
    assert.equal(outcome.backend, "claude");
    assert.deepEqual([...outcome.args].filter((arg) => arg === "--plugin-dir").length, 1, "exactly one --plugin-dir");
    assert.ok(!outcome.args.includes("--settings"), "a review launch NEVER adds a second --settings");
    assert.equal(outcome.args.length, 2, "one option and its operand, and nothing else");
    const root = outcome.lease.root;
    assert.ok(root !== null);
    const pluginRoot = outcome.args[1]!;
    assert.equal(pluginRoot, join(root as string, "claude-review-plugin"));

    const hooksFile = JSON.parse(readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(hooksFile), ["hooks"], "only the hooks key: a plugin carries nothing else");
    const events = hooksFile.hooks as Record<string, { hooks: Record<string, unknown>[] }[]>;
    assert.deepEqual(Object.keys(events), ["Stop", "UserPromptSubmit"], "exactly this lane's two events");
    for (const event of ["Stop", "UserPromptSubmit"]) {
      const groups = events[event]!;
      assert.equal(groups.length, 1, "one matcher group per event");
      assert.deepEqual(Object.keys(groups[0]!), ["hooks"], "no matcher: this lane answers every root turn");
      assert.equal(groups[0]!.hooks.length, 1, "one handler per event");
      const handler = groups[0]!.hooks[0]!;
      assert.deepEqual(Object.keys(handler).sort(), ["args", "command", "timeout", "type"]);
      assert.equal(handler.type, "command");
      assert.equal(handler.command, node);
      assert.deepEqual(handler.args, [relay, event], "the exec form names this event to the relay");
      assert.equal(handler.timeout, NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS);
      // No `onFailure`: the provider's own default is the correct reading of a
      // hook child that never answered, and this module adds no policy of its own.
      assert.equal(handler.onFailure, undefined);
      assert.equal(handler.matcher, undefined);
    }

    const manifest = JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")) as Record<string, string>;
    assert.equal(manifest.name, "pi-review-gate-native-review");
    assert.deepEqual(readdirSync(pluginRoot).sort(), [".claude-plugin", "hooks"], "nothing but hooks in this plugin");
    assert.deepEqual(readdirSync(join(pluginRoot, "hooks")), ["hooks.json"]);

    // No secret, no identity, no provider data inside any artifact.
    for (const file of [join(pluginRoot, "hooks", "hooks.json"), join(pluginRoot, ".claude-plugin", "plugin.json")]) {
      const text = readFileSync(file, "utf8");
      for (const secret of [TOKEN, INSTANCE_ID, GENERATION, SOCKET]) {
        assert.ok(!text.includes(secret), `${secret} never enters ${file}`);
      }
    }

    const cleanup = await outcome.lease.cleanup();
    assert.deepEqual(cleanup.preserved, []);
    assert.ok(!existsSync(join(pluginRoot, "hooks", "hooks.json")));
    assert.ok(!existsSync(pluginRoot));
    assert.ok(!existsSync(root as string));
    assert.deepEqual(await outcome.lease.cleanup(), cleanup, "cleanup is idempotent");
  });
});

test("staged review artifacts are private, and cleanup removes only its own inodes", {
  // POSIX permission bits do not exist in the Windows sense; the mode assertions
  // below have no Windows meaning, so the whole test is DECLARED skipped there.
  skip: process.platform === "win32" ? "POSIX permission bits" : false,
}, async () => {
  await fixture(async (_root, bin) => {
    const relay = await relayEntryIn(bin);
    const entrypoints = { nodeExecutable: process.execPath, relayEntry: relay };
    const outcome = prepared(await prepareNativeReviewHookLaunch(preparationInput("claude", { entrypoints })));
    const root = outcome.lease.root as string;
    const pluginRoot = outcome.args[1]!;
    try {
      assert.equal(statSync(root).mode & 0o777, 0o700, "the owned root is private");
      assert.equal(statSync(pluginRoot).mode & 0o777, 0o700, "the plugin directory is private");
      assert.equal(statSync(join(pluginRoot, "hooks", "hooks.json")).mode & 0o777, 0o600, "the staged hooks file is private");
      assert.equal(statSync(join(pluginRoot, ".claude-plugin", "plugin.json")).mode & 0o777, 0o600);

      // An entry this call never created is never deleted, and its presence keeps the
      // root itself in place. That preserved root is this test's own doing, so the
      // finally block below — not the lease — is what takes it out of the temp tree.
      const foreign = join(root, "someone-else-s-file");
      await writeFile(foreign, "not ours\n");
      const cleanup = await outcome.lease.cleanup();
      assert.ok(existsSync(foreign), "an unknown entry survives");
      assert.ok(existsSync(root), "a root that no longer holds only our entries survives");
      assert.ok(!existsSync(join(pluginRoot, "hooks", "hooks.json")), "our own file is still removed");
      assert.deepEqual(cleanup.preserved, [root], "the lease reports the one entry it refused to remove, and nothing else");
    } finally {
      // The exact root this test staged, whatever the assertions concluded.
      await rm(root, { recursive: true, force: true });
    }
    assert.ok(!existsSync(root), "the test leaves no root of its own behind");
  }, { isolateTempNamespace: true });
});

test("the POSIX artifact-root proof refuses a replaceable or ACL-exposed root and accepts sticky /tmp", {
  // The proof this exercises is the POSIX one: sticky-bit ancestry and mode
  // bits. Windows proves its artifact root with a DACL instead, which the
  // Windows ACL tests below cover.
  skip: process.platform === "win32" ? "POSIX artifact-root semantics" : false,
}, () => {
  // Described filesystem, so the rule is exercised whatever private directory the
  // test runner itself happens to sit in (a private ancestor legitimately shields).
  const uid = 1000n;
  const dir = (owner: bigint, mode: bigint) => ({ uid: owner, mode: 0o040000n | mode, isDirectory: () => true, isSocket: () => false });
  const tree = (tmpMode: bigint): Record<string, ReturnType<typeof dir>> => ({
    "/": dir(0n, 0o755n),
    "/tmp": dir(0n, tmpMode),
    "/tmp/prg-native-review-x": dir(uid, 0o700n),
  });
  const check = (entries: Record<string, ReturnType<typeof dir>>, acl: (path: string) => string = () => "no-acl") =>
    isPrivatePosixArtifactRoot("/tmp/prg-native-review-x", {
      uid,
      lstat: (path) => {
        const entry = entries[path];
        if (entry === undefined) throw new Error(`unexpected lstat ${path}`);
        return entry;
      },
      proveAcl: ((path: string) => acl(path)) as never,
    });
  assert.equal(check(tree(0o1777n)), true, "the ordinary sticky /tmp is accepted");
  assert.equal(check(tree(0o777n)), false, "a non-sticky world-writable parent lets another user replace the root");
  assert.equal(check({ ...tree(0o1777n), "/tmp/prg-native-review-x": dir(uid, 0o750n) }), false, "a root readable by others is not private");
  assert.equal(check({ ...tree(0o1777n), "/tmp/prg-native-review-x": dir(2000n, 0o700n) }), false, "a root owned by another user is refused");
  assert.equal(check(tree(0o1777n), (path) => (path === "/tmp/prg-native-review-x" ? "untrusted" : "no-acl")), false,
    "an inherited ACL grant on the root is refused even though the mode reads 0700");
  assert.equal(check(tree(0o1777n), (path) => (path === "/tmp" ? "unprovable" : "no-acl")), false,
    "an ACL on the temp parent that cannot be proven is refused");
});

test("a review root staged under an ordinary sticky temp parent is prepared and private", {
  skip: process.platform === "win32" ? "POSIX ancestry rule; Windows proves its DACL instead" : false,
}, async () => {
  await fixture(async (_root, bin) => {
    const relay = await relayEntryIn(bin);
    const namespace = join(_root, "temp-namespace");
    await chmod(namespace, 0o1777);
    const accepted = prepared(await prepareNativeReviewHookLaunch(preparationInput("claude", {
      entrypoints: { nodeExecutable: process.execPath, relayEntry: relay },
    })));
    try {
      assert.equal(statSync(accepted.lease.root as string).mode & 0o777, 0o700);
    } finally {
      await accepted.lease.cleanup();
    }
    await chmod(namespace, 0o700);
  }, { isolateTempNamespace: true });
});

test("the review lane stages under its OWN artifact prefix, never the observer's", async (t) => {
  await fixture(async (_root, bin) => {
    const relay = await relayEntryIn(bin);
    const before = stagedRoots("prg-native-review-");
    const beforeObserver = stagedRoots("prg-native-hook-");
    const outcome = prepared(await prepareNativeReviewHookLaunch(preparationInput("claude", {
      entrypoints: { nodeExecutable: process.execPath, relayEntry: relay },
    })));
    const root = outcome.lease.root as string;
    try {
      assert.ok(basename(root).startsWith("prg-native-review-"));
      assert.ok(existsSync(root), "the lease names the staged root");
      assert.ok(!outcome.args[1]!.includes("prg-native-hook-"), "a review artifact is never mistaken for an observer artifact");
      // The temp census can only be expected to grow when the selected parent IS
      // this fixture's temp namespace: on Windows a refused temp parent
      // legitimately stages the root under the host's proven LOCALAPPDATA
      // instead, and that root is never part of this census. Cleanup stays in
      // `finally` either way, so a failed assertion can never strand a root
      // outside the fixture's teardown tree.
      let expectedTempRoots = before ?? [];
      if (activeTempNamespace !== undefined) {
        if (dirname(root) === await realpath(activeTempNamespace)) {
          expectedTempRoots = [...expectedTempRoots, basename(root)].sort();
        } else {
          assert.equal(process.platform, "win32", "only Windows can stage outside temp");
          assert.equal(dirname(root), await realpath(hostLocalAppData()), "the root uses the host LOCALAPPDATA fallback");
        }
      }
      assertStagedRoots(t, "prg-native-review-", expectedTempRoots,
        "the temp census reflects the selected staging parent");
      assertStagedRoots(t, "prg-native-hook-", beforeObserver ?? [],
        "the observer lane's roots are untouched");
    } finally {
      await outcome.lease.cleanup();
    }
    assertStagedRoots(t, "prg-native-review-", before ?? [], "cleanup leaves no root behind");
    assert.ok(!existsSync(root));
  }, { isolateTempNamespace: true });
});

// ---------------------------------------------------------------------------
// The child-environment marker
// ---------------------------------------------------------------------------

test("the launch environment carries exactly this family's own marker, and it decodes back", async () => {
  await fixture(async (_root, bin) => {
    const relay = await relayEntryIn(bin);
    const outcome = prepared(await prepareNativeReviewHookLaunch(preparationInput("claude", {
      entrypoints: { nodeExecutable: process.execPath, relayEntry: relay },
    })));
    const names = Object.keys(outcome.environment);
    assert.deepEqual(names, [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], "exactly one entry, keyed by this family's name");
    assert.equal(
      Object.prototype.hasOwnProperty.call(outcome.environment, "PI_REVIEW_GATE_NATIVE_HOOK_BOOTSTRAP"),
      false,
      "the observer family's marker is NEVER written here",
    );
    assert.deepEqual(
      parseNativeReviewBootstrapEnv(outcome.environment[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]),
      bootstrapFor("claude"),
      "the marker round-trips to the exact bootstrap this launch was issued",
    );
    await outcome.lease.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Codex is a later slice
// ---------------------------------------------------------------------------

test("a non-owned Codex request is declined as unavailable without staging anything", async () => {
  await fixture(async () => {
    const before = stagedRoots("prg-native-review-");
    const outcome = unavailable(await prepareNativeReviewHookLaunch(preparationInput("codex")));
    assert.equal(outcome.backend, "codex");
    assert.equal(outcome.reason, "codex-backend-not-owned");
    assert.deepEqual(stagedRoots("prg-native-review-"), before, "a declined Codex lane stages no artifact at all");
  }, { isolateTempNamespace: true });
});

// ---------------------------------------------------------------------------
// Owned Codex: stable shim + backend-only `-c hooks.*`
// ---------------------------------------------------------------------------

const POSIX_SKIP = process.platform === "win32" ? "POSIX shim modes and ancestry" : false;

async function codexHookDir(root: string): Promise<string> {
  const dir = join(root, "state", "native-review", "codex-hook");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

function ownedCodexInput(dir: string, relay: string, args: string[] = []): NativeReviewHookLaunchPreparationInput {
  return preparationInput("codex", {
    platform: process.platform === "win32" ? "linux" : process.platform,
    ownedCodexBackend: true,
    scan: scanNativeArgPositions("codex", args, "codex"),
    codexHookDirectory: dir,
    entrypoints: { nodeExecutable: process.execPath, relayEntry: relay },
  });
}

test("owned Codex gets exactly two backend -c hook values naming only the stable shim", { skip: POSIX_SKIP }, async () => {
  await fixture(async (root, bin) => {
    const relay = await relayEntryIn(bin);
    const dir = await codexHookDir(root);
    const outcome = prepared(await prepareNativeReviewHookLaunch(ownedCodexInput(dir, relay)));
    const shim = join(dir, CODEX_REVIEW_SHIM_NAME);
    assert.equal(outcome.route, "codex-owned-backend-config");
    assert.equal(outcome.lease.root, null, "the stable shim is not a per-launch artifact");
    assert.deepEqual(outcome.args, [
      "-c", `hooks.UserPromptSubmit=[{hooks=[{type="command",command="'${shim}' UserPromptSubmit",timeout=${NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS}}]}]`,
      "-c", `hooks.Stop=[{hooks=[{type="command",command="'${shim}' Stop",timeout=${NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS}}]}]`,
    ]);
    assert.ok(!outcome.args.join(" ").includes(process.execPath), "Node's path never enters the trusted definition");
    assert.ok(!outcome.args.join(" ").includes(relay), "nor does the relay entry");
    assert.ok(!outcome.args.join(" ").includes(TOKEN), "nor the per-launch secret");
    const marker = parseNativeReviewBootstrapEnv(outcome.environment[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]);
    assert.equal(marker?.backend, "codex");
    assert.equal(statSync(shim).mode & 0o7777, 0o700, "the shim is private and executable by its owner only");
    assert.equal(readFileSync(shim, "utf8"), codexReviewShimContents({ nodeExecutable: process.execPath, relayEntry: relay }, "linux"));
    assert.deepEqual(await outcome.lease.cleanup(), { removed: [], preserved: [] }, "and cleanup leaves the stable shim in place");
    assert.ok(existsSync(shim));
  });
});

test("the Codex hook definition is byte-identical across launches, entrypoint upgrades, and tokens", { skip: POSIX_SKIP }, async () => {
  await fixture(async (root, bin) => {
    const relay = await relayEntryIn(bin);
    const dir = await codexHookDir(root);
    const first = prepared(await prepareNativeReviewHookLaunch(ownedCodexInput(dir, relay)));
    const shim = join(dir, CODEX_REVIEW_SHIM_NAME);
    const firstInode = statSync(shim).ino;
    const again = prepared(await prepareNativeReviewHookLaunch({ ...ownedCodexInput(dir, relay), bootstrap: bootstrapFor("codex", "b".repeat(64)) }));
    assert.deepEqual(again.args, first.args, "a new launch token never changes what Codex was asked to trust");
    assert.equal(statSync(shim).ino, firstInode, "an identical shim is left untouched");
    // An upgraded relay location rewrites the shim, never the trusted definition.
    const upgradedBin = join(root, "upgraded");
    await mkdir(upgradedBin);
    const upgradedRelay = await relayEntryIn(upgradedBin);
    const upgraded = prepared(await prepareNativeReviewHookLaunch(ownedCodexInput(dir, upgradedRelay)));
    assert.deepEqual(upgraded.args, first.args);
    assert.ok(readFileSync(shim, "utf8").includes(upgradedRelay), "the shim now names the upgraded relay");
    assert.equal(statSync(shim).mode & 0o7777, 0o700);
    assert.deepEqual(readdirSync(dir), [CODEX_REVIEW_SHIM_NAME], "no temporary file is left beside the shim");
  });
});

test("an operator Codex hook override of the same paths declines the lane without touching the shim", { skip: POSIX_SKIP }, async () => {
  await fixture(async (root, bin) => {
    const relay = await relayEntryIn(bin);
    const dir = await codexHookDir(root);
    for (const override of [
      "hooks.Stop=[]", "hooks.stop=[]", "hooks.UserPromptSubmit=[]", "hooks.user_prompt_submit=[]",
      "hooks={}", " hooks . Stop =[]", 'hooks."Stop"=[]',
    ]) {
      const outcome = unavailable(await prepareNativeReviewHookLaunch(ownedCodexInput(dir, relay, ["-c", override])));
      assert.equal(outcome.reason, "operator-hook-override", override);
    }
    const unrelated = prepared(await prepareNativeReviewHookLaunch(ownedCodexInput(dir, relay, ["-c", "hooks.SessionStart=[]", "-c", "model=\"x\""])));
    assert.equal(unrelated.args.length, 4, "a different hook path is not a conflict");
  });
});

test("the conflict reading treats an unreadable override as a collision", () => {
  const scan = { terminatorIndex: -1, insertionIndex: 0, options: [{ name: "-c", index: 0 }] } as never;
  assert.equal(codexReviewHookOverrideConflict(scan), true);
});

test("a shim directory that is not private declines the lane and writes nothing", { skip: POSIX_SKIP }, async () => {
  await fixture(async (root, bin) => {
    const relay = await relayEntryIn(bin);
    const dir = await codexHookDir(root);
    await chmod(dir, 0o755);
    const outcome = unavailable(await prepareNativeReviewHookLaunch(ownedCodexInput(dir, relay)));
    assert.equal(outcome.reason, "artifact-staging-failed");
    assert.deepEqual(readdirSync(dir), []);
    const missing = unavailable(await prepareNativeReviewHookLaunch({ ...ownedCodexInput(dir, relay), codexHookDirectory: undefined }));
    assert.equal(missing.reason, "artifact-staging-failed");
  });
});

test("a foreign or symlinked shim is replaced, never followed or reused", { skip: POSIX_SKIP }, async () => {
  await fixture(async (root, bin) => {
    const relay = await relayEntryIn(bin);
    const dir = await codexHookDir(root);
    const shim = join(dir, CODEX_REVIEW_SHIM_NAME);
    const target = join(root, "elsewhere");
    await writeFile(target, "keep me\n");
    execFileSync("ln", ["-s", target, shim]);
    prepared(await prepareNativeReviewHookLaunch(ownedCodexInput(dir, relay)));
    assert.equal(readFileSync(target, "utf8"), "keep me\n", "the link target is never written through");
    assert.ok(readFileSync(shim, "utf8").startsWith("#!/bin/sh\n"), "the link itself was replaced by the shim");
  });
});

test("Windows: the shim is a batch file and both commands are cmd-quoted; % or ! paths decline", () => {
  const quote = (token: string): string => (/[\s"&|<>^()]/u.test(token) ? `"${token}"` : token);
  const entry = { nodeExecutable: "C:\\Program Files\\nodejs\\node.exe", relayEntry: "C:\\pkg\\relay.js" };
  assert.equal(codexReviewShimContents(entry, "win32", quote), '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" C:\\pkg\\relay.js %*\r\n');
  assert.equal(codexReviewShimContents({ ...entry, relayEntry: "C:\\100%\\relay.js" }, "win32", quote), null);
  assert.equal(codexReviewShimContents({ ...entry, nodeExecutable: "C:\\bang!\\node.exe" }, "win32", quote), null);
  assert.equal(codexReviewShimContents(entry, "win32"), null, "no quoter, no Windows shim");
  const shim = codexReviewShimPath("C:\\Users\\me\\state\\native-review\\codex-hook", "win32");
  assert.ok(shim.endsWith(`${CODEX_REVIEW_SHIM_NAME}.cmd`));
  const args = codexReviewHookConfigArgs(shim, "win32", quote);
  assert.ok(args !== null && args.length === 4);
  assert.match(args![3]!, /commandWindows="C:\\\\Users.*codex-review-hook\.cmd Stop"/u);
  assert.equal(codexReviewHookConfigArgs("C:\\50%\\codex-review-hook.cmd", "win32", quote), null);
});

// ---------------------------------------------------------------------------
// Entry-point validation
// ---------------------------------------------------------------------------

test("an unusable Node or relay entry declines preparation without staging anything", async () => {
  await fixture(async (root, bin) => {
    const before = stagedRoots("prg-native-review-");
    const relay = await relayEntryIn(bin);
    const missing = join(root, "no-such-node");
    assert.equal(resolveNativeReviewHookEntrypoints({ nodeExecutable: missing, relayEntry: relay }), null);
    assert.equal(resolveNativeReviewHookEntrypoints({ nodeExecutable: bin, relayEntry: relay }), null, "a directory is not an executable");
    assert.equal(resolveNativeReviewHookEntrypoints({ nodeExecutable: "relative/node", relayEntry: relay }), null);
    assert.equal(resolveNativeReviewHookEntrypoints({ nodeExecutable: process.execPath, relayEntry: join(root, "no-such-relay.js") }), null);
    assert.equal(resolveNativeReviewHookEntrypoints({ nodeExecutable: "/synthetic\nnode", relayEntry: relay }), null, "a control character is never a path");
    const entrypoints = { nodeExecutable: missing, relayEntry: relay };
    const outcome = unavailable(await prepareNativeReviewHookLaunch(preparationInput("claude", { entrypoints })));
    assert.equal(outcome.reason, "hook-entry-unavailable");
    assert.deepEqual(stagedRoots("prg-native-review-"), before, "a refused entry point stages no artifact");
  }, { isolateTempNamespace: true });
});

test("the default relay entry resolves beside this module in the compiled layout", () => {
  // The shipped and compiled layouts both keep the relay beside this module, so
  // the production default is a real regular file here.
  const resolved = resolveNativeReviewHookEntrypoints(undefined);
  assert.ok(resolved !== null, "the compiled tree holds node and native-review-hook-relay.js beside this module");
  assert.ok(resolved!.relayEntry.endsWith("native-review-hook-relay.js"));
});

test("Windows exec-form paths travel as data: no shell quoting, no refusal, no second field", async () => {
  await fixture(async (_root, bin) => {
    // A Windows-shaped path that the POSIX shell route would have to refuse for
    // `%` and `!`: the exec form carries it as data, so nothing is quoted and
    // nothing is declined.
    const node = join(bin, "Program Files", "node %!exe");
    await mkdir(join(bin, "Program Files"), { recursive: true });
    await fakeExecutable(node);
    const relay = join(bin, "review relay %!.js");
    await writeFile(relay, "// never invoked\n");
    const outcome = prepared(await prepareNativeReviewHookLaunch(preparationInput("claude", {
      platform: "win32",
      entrypoints: { nodeExecutable: node, relayEntry: relay },
    })));
    const hooksFile = JSON.parse(readFileSync(join(outcome.args[1]!, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, { hooks: Record<string, unknown>[] }[]>;
    };
    for (const event of ["Stop", "UserPromptSubmit"]) {
      const handler = hooksFile.hooks[event]![0]!.hooks[0]!;
      assert.equal(handler.command, node, "the command is the path itself, unquoted");
      assert.deepEqual(handler.args, [relay, event], "the args are the paths themselves, unquoted");
      assert.equal(handler.commandWindows, undefined, "the exec form has no shell-command field");
      assert.equal(typeof handler.command, "string");
    }
    await outcome.lease.cleanup();
  });
});

// ---------------------------------------------------------------------------
// Refusals and fail-closed rules
// ---------------------------------------------------------------------------

test("a malformed or cross-backend bootstrap is a refusal, never a partial arming", async () => {
  await fixture(async (_root, bin) => {
    const relay = await relayEntryIn(bin);
    const entrypoints = { nodeExecutable: process.execPath, relayEntry: relay };
    const before = stagedRoots("prg-native-review-");
    await assert.rejects(
      () => prepareNativeReviewHookLaunch(preparationInput("claude", { bootstrap: undefined as never, entrypoints })),
      /refusing to prepare the native review hook/,
    );
    await assert.rejects(
      () => prepareNativeReviewHookLaunch(preparationInput("claude", { bootstrap: { ...bootstrapFor("codex") }, entrypoints })),
      /cannot arm a claude launch/,
    );
    await assert.rejects(
      () => prepareNativeReviewHookLaunch(preparationInput("claude", {
        bootstrap: { ...bootstrapFor("claude"), extra: 1 } as never,
        entrypoints,
      })),
      /unexpected field/,
    );
    await assert.rejects(
      () => prepareNativeReviewHookLaunch(preparationInput("claude", { platform: "freebsd" as NodeJS.Platform, entrypoints })),
      /unsupported/,
    );
    assert.deepEqual(stagedRoots("prg-native-review-"), before, "a refusal stages nothing");
  }, { isolateTempNamespace: true });
});

test("a genuine worker-role authorization in the request environment is rejected before any artifact", async () => {
  await fixture(async () => {
    const before = stagedRoots("prg-native-review-");
    await assert.rejects(
      () => prepareNativeReviewHookLaunch(preparationInput("claude", {
        env: { PATH: "/usr/bin", [RUNTIME_ROLE_ENV]: "executor" },
      })),
      /refusing to prepare a native launch/,
    );
    assert.deepEqual(stagedRoots("prg-native-review-"), before, "no artifact is staged for a delegated worker");
  }, { isolateTempNamespace: true });
});

// ---------------------------------------------------------------------------
// The launcher composes this lane's flags, marker, and ownership
// ---------------------------------------------------------------------------

function launcherConfig(externalAgents: Record<string, unknown> = {}) {
  return normalizeConfig({ enabled: true, externalAgents });
}

/** A prepared review outcome this test module invents; the launcher must not care. */
function syntheticReviewOutcome(
  backend: "claude" | "codex",
  pluginDir: string,
  onCleanup?: () => void,
): NativeReviewHookLaunchOutcome {
  return {
    review: "prepared",
    backend,
    route: "claude-plugin-dir",
    args: ["--plugin-dir", pluginDir],
    environment: { [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: "synthetic-review-marker" },
    lease: {
      root: pluginDir,
      cleanup: async () => { onCleanup?.(); return { removed: [pluginDir], preserved: [] }; },
    },
  };
}

function reviewHookBootstrapFor(backend: "claude" | "codex"): NativeHookBootstrap {
  return {
    version: 1,
    socketPath: SOCKET,
    generation: GENERATION,
    instanceId: INSTANCE_ID,
    backend,
    token: TOKEN,
  };
}

test("the launcher adds exactly one review --plugin-dir to the operator's argv and this family's own marker", async () => {
  await fixture(async (_root, bin) => {
    const cli = explicitCliPath(bin, "claude");
    await fakeExecutable(cli);
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    let cleanups = 0;
    const launcher = createNativeCliLauncher(launcherConfig({
      op: { adapter: "claude-cli", command: cli, args: ["--settings", "/operator/s.json", "--plugin-dir", "/operator/p"], review: {} },
    }), {
      platform: "darwin",
      nativeReviewPreparation: async () => syntheticReviewOutcome("claude", "/synthetic/review-plugin", () => { cleanups += 1; }),
    });
    const descriptor = await launcher("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      targetId: "external:op",
      nativeHook: { bootstrap: reviewHookBootstrapFor("claude") },
      nativeReview: { bootstrap: bootstrapFor("claude") },
    });
    // The same launch with this lane unarmed, so "exactly one extra" is measured
    // against this launch's own argv rather than a hand-counted constant.
    const without = await launcher("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      targetId: "external:op",
      nativeHook: { bootstrap: reviewHookBootstrapFor("claude") },
    });
    try {
      const argv = descriptor.args;
      assert.equal(argv.filter((arg) => arg === "--settings").length, 1, "NEVER a second --settings, whatever else this lane adds");
      assert.equal(without.args.filter((arg) => arg === "--settings").length, 1);
      const countPluginDir = (args: readonly string[]): number => args.filter((arg) => arg === "--plugin-dir").length;
      assert.equal(countPluginDir(argv), countPluginDir(without.args) + 1, "this lane adds exactly one --plugin-dir and no more");
      assert.ok(argv.includes("/synthetic/review-plugin"), "the review plugin directory rides the real argv");
      assert.equal(without.args.includes("/synthetic/review-plugin"), false);
      assert.deepEqual(argv.slice(-2), ["--plugin-dir", "/synthetic/review-plugin"], "this lane appends its own two tokens and nothing else");
      assert.equal(argv.length, without.args.length + 2, "so the rest of the argv is exactly the argv this launch would have had");
      assert.equal(argv.indexOf("/synthetic/review-plugin") > argv.indexOf("/operator/p"), true, "generated flags keep their real option position");
      assert.equal(descriptor.env[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], "synthetic-review-marker");
      assert.equal(without.env[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], undefined, "an unarmed launch marks nothing");
      assert.equal(descriptor.nativeReview?.review, "prepared");
      assert.equal("nativeReview" in without, false, "and gains no descriptor field");
      assert.equal(cleanups, 0, "the caller owns the lease while the descriptor lives");
    } finally {
      if (descriptor.nativeReview?.review === "prepared") await descriptor.nativeReview.lease.cleanup();
      if (descriptor.nativeHook?.observation === "prepared") await descriptor.nativeHook.lease.cleanup();
      if (without.nativeHook?.observation === "prepared") await without.nativeHook.lease.cleanup();
    }
    assert.equal(cleanups, 1, "the caller's cleanup is the one cleanup");
  });
});

test("a review preparation that declined composes no flag and no marker, and leaves observation intact", async () => {
  await fixture(async (_root, bin) => {
    const cli = explicitCliPath(bin, "claude");
    await fakeExecutable(cli);
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const launcher = createNativeCliLauncher(launcherConfig({
      op: { adapter: "claude-cli", command: cli, args: [], review: {} },
    }), {
      platform: "darwin",
      nativeReviewPreparation: async () => ({ review: "unavailable", backend: "claude", reason: "artifact-staging-failed" }),
    });
    const descriptor = await launcher("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      targetId: "external:op",
      nativeHook: { bootstrap: reviewHookBootstrapFor("claude") },
      nativeReview: { bootstrap: bootstrapFor("claude") },
    });
    try {
      assert.equal(descriptor.args.some((arg) => arg === "--plugin-dir"), false, "a declined lane adds nothing");
      assert.equal(descriptor.env[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], undefined, "and marks nothing");
      assert.equal(descriptor.nativeReview?.review, "unavailable", "the outcome is reported, not hidden");
      assert.equal(descriptor.nativeHook?.observation, "prepared", "the status lane is untouched by the declined review lane");
    } finally {
      if (descriptor.nativeHook?.observation === "prepared") await descriptor.nativeHook.lease.cleanup();
    }
  });
});

test("an explicit observer decline stages no review hook, flag, or marker", async () => {
  await fixture(async (_root, bin) => {
    const cli = explicitCliPath(bin, "claude");
    await fakeExecutable(cli);
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    let reviewPreparations = 0;
    const launcher = createNativeCliLauncher(launcherConfig({
      op: { adapter: "claude-cli", command: cli, args: [], review: {} },
    }), {
      platform: "darwin",
      // The manager retires the status run, and the review registration with it,
      // on this outcome before spawning: a review hook here would block on a lane
      // that no longer exists.
      nativeHookPreparation: async () => ({ observation: "unavailable", backend: "claude", reason: "operator-hook-override" }),
      nativeReviewPreparation: async () => {
        reviewPreparations += 1;
        return syntheticReviewOutcome("claude", "/synthetic/review-plugin");
      },
    });
    const descriptor = await launcher("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      targetId: "external:op",
      nativeHook: { bootstrap: reviewHookBootstrapFor("claude") },
      nativeReview: { bootstrap: bootstrapFor("claude") },
    });
    assert.equal(reviewPreparations, 0, "nothing is staged for a lane that will be retired before spawn");
    assert.equal(descriptor.args.includes("/synthetic/review-plugin"), false, "no review plugin directory");
    assert.equal(descriptor.args.some((arg) => arg === "--plugin-dir"), false, "no generated --plugin-dir");
    assert.equal(descriptor.env[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], undefined, "no review marker");
    assert.equal(descriptor.nativeReview?.review === "unavailable" ? descriptor.nativeReview.reason : "", "observer-unavailable");
    assert.equal(descriptor.nativeHook?.observation, "unavailable", "the observer's own decline is reported unchanged");
  });
});

test("a review preparation that throws degrades to no review lane and leaves the observer active", async (t) => {
  await fixture(async (_root, bin) => {
    const cli = explicitCliPath(bin, "claude");
    await fakeExecutable(cli);
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const before = stagedRoots("prg-native-review-");
    const observerBefore = stagedRoots("prg-native-hook-");
    // The observer's own staged root, asserted by PATH, which is exact on every platform;
    // the census below only compares where it measured a private namespace.
    let observerRoot = "";
    const launcher = createNativeCliLauncher(launcherConfig({
      op: { adapter: "claude-cli", command: cli, args: [], review: {} },
    }), {
      platform: "darwin",
      nativeReviewPreparation: async () => { throw new Error("synthetic review preparation failure"); },
    });
    // THE LAUNCH ITSELF SURVIVES. An optional lane that cannot prepare is a lane
    // outcome, never a launch outcome: the descriptor still comes back, the observer
    // channel is still armed and still owns its own staged artifacts.
    const descriptor = await launcher("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      targetId: "external:op",
      nativeHook: { bootstrap: reviewHookBootstrapFor("claude") },
      nativeReview: { bootstrap: bootstrapFor("claude") },
    });
    try {
      assert.equal(descriptor.nativeReview?.review, "unavailable", "the lane declined itself");
      assert.equal(descriptor.env[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], undefined, "and marked nothing");
      assert.equal(descriptor.args.some((arg) => arg === "--plugin-dir"), false, "and added no flag");
      assert.equal(descriptor.nativeHook?.observation, "prepared", "the observer lane is still armed");
      assert.equal(descriptor.env[NATIVE_HOOK_BOOTSTRAP_ENV] !== undefined, true, "with its own marker intact");
      assert.deepEqual(stagedRoots("prg-native-review-"), before, "the failed lane staged nothing");
      observerRoot = descriptor.nativeHook?.observation === "prepared"
        ? descriptor.nativeHook.lease.root as string
        : "";
      assert.ok(observerRoot.length > 0 && existsSync(observerRoot),
        "the observer's artifact is still there — this launch never rolled it back");
      assertStagedRoots(t, "prg-native-hook-",
        observerBefore === undefined ? [] : [...observerBefore, basename(observerRoot)].sort(),
        "exactly the observer's own root is staged, and nothing else");
    } finally {
      if (descriptor.nativeHook?.observation === "prepared") await descriptor.nativeHook.lease.cleanup();
    }
    assert.ok(observerRoot.length === 0 || !existsSync(observerRoot),
      "and the caller's own cleanup removes it");
    assertStagedRoots(t, "prg-native-hook-", observerBefore ?? [],
      "the census returns to exactly what it was before this launch");
  }, { isolateTempNamespace: true });
});

test("a review bootstrap the manager could not mean declines the lane instead of failing the launch", async () => {
  await fixture(async (_root, bin) => {
    const cli = explicitCliPath(bin, "claude");
    await fakeExecutable(cli);
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const launcher = createNativeCliLauncher(launcherConfig({
      op: { adapter: "claude-cli", command: cli, args: [], review: {} },
    }), { platform: "darwin" });
    const malformed = await launcher("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      targetId: "external:op",
      nativeHook: { bootstrap: reviewHookBootstrapFor("claude") },
      nativeReview: { bootstrap: { ...bootstrapFor("claude"), token: "not-a-token" } as never },
    });
    const crossBackend = await launcher("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      targetId: "external:op",
      nativeHook: { bootstrap: reviewHookBootstrapFor("claude") },
      nativeReview: { bootstrap: bootstrapFor("codex") },
    });
    try {
      for (const [name, descriptor] of [["malformed", malformed], ["cross-backend", crossBackend]] as const) {
        assert.equal(descriptor.nativeReview?.review, "unavailable", `${name}: declined`);
        assert.equal(descriptor.nativeReview?.review === "unavailable" ? descriptor.nativeReview.reason : "", "bootstrap-unusable");
        assert.equal(descriptor.env[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], undefined, `${name}: no marker`);
        assert.equal(descriptor.args.some((arg) => arg === "--plugin-dir"), false, `${name}: no flag`);
        assert.equal(descriptor.nativeHook?.observation, "prepared", `${name}: observation survives`);
      }
    } finally {
      for (const descriptor of [malformed, crossBackend]) {
        if (descriptor.nativeHook?.observation === "prepared") await descriptor.nativeHook.lease.cleanup();
      }
    }
  }, { isolateTempNamespace: true });
});

test("review flags that would cross the descriptor's argument bound decline the lane, not the launch", async () => {
  await fixture(async (_root, bin) => {
    const cli = explicitCliPath(bin, "claude");
    await fakeExecutable(cli);
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    // Fill the operator's argv to exactly MAX_NATIVE_CLI_ARGS - 1, so this lane's own
    // two tokens are precisely what would cross the shared bound.
    const filler: string[] = [];
    while (filler.length < MAX_NATIVE_CLI_ARGS - 1) filler.push("--model");
    const launcher = createNativeCliLauncher(launcherConfig({
      op: { adapter: "claude-cli", command: cli, args: filler, review: {} },
    }), {
      platform: "darwin",
      nativeReviewPreparation: async () => syntheticReviewOutcome("claude", "/synthetic/review-plugin"),
    });
    const withLane = await launcher("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      targetId: "external:op",
      nativeReview: { bootstrap: bootstrapFor("claude") },
    });
    assert.equal(withLane.nativeReview?.review, "unavailable", "the lane declined itself");
    assert.equal(withLane.nativeReview?.review === "unavailable" ? withLane.nativeReview.reason : "", "argument-budget");
    assert.ok(withLane.args.length <= MAX_NATIVE_CLI_ARGS, "and the descriptor is one the manager can validate");
    assert.equal(withLane.args.some((arg) => arg === "--plugin-dir"), false, "with none of the lane's flags");
    assert.equal(withLane.env[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], undefined, "and none of its marker");
    // A launch already past the bound WITHOUT this lane stays past it: declining the
    // lane never hides an operator's own over-long argv behind a lane outcome.
    const alreadyOver: string[] = [];
    while (alreadyOver.length < MAX_NATIVE_CLI_ARGS + 1) alreadyOver.push("--model");
    const overBudget = createNativeCliLauncher(launcherConfig({
      op: { adapter: "claude-cli", command: cli, args: alreadyOver, review: {} },
    }), {
      platform: "darwin",
      nativeReviewPreparation: async () => syntheticReviewOutcome("claude", "/synthetic/review-plugin"),
    });
    const overlong = await overBudget("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      targetId: "external:op",
      nativeReview: { bootstrap: bootstrapFor("claude") },
    });
    assert.ok(overlong.args.length > MAX_NATIVE_CLI_ARGS, "the operator's own over-long argv is never trimmed by this rule");
    assert.equal(overlong.nativeReview?.review, "prepared", "and the lane is not blamed for it");
    if (overlong.nativeReview?.review === "prepared") await overlong.nativeReview.lease.cleanup();
  }, { isolateTempNamespace: true });
});

test("a request that armed only the observer lane is byte-identical to the request it always was", async () => {
  await fixture(async (_root, bin) => {
    const cli = explicitCliPath(bin, "claude");
    await fakeExecutable(cli);
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const launcher = createNativeCliLauncher(launcherConfig({
      op: { adapter: "claude-cli", command: cli, args: [], review: {} },
    }), { platform: "darwin" });
    const without = await launcher("claude", {
      workspace, env: { PATH: bin, HOME: "/operator/home" }, targetId: "external:op",
      nativeHook: { bootstrap: reviewHookBootstrapFor("claude") },
    });
    try {
      assert.equal("nativeReview" in without, false, "an unarmed request gains no descriptor field");
      assert.equal(without.env[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], undefined);
    } finally {
      if (without.nativeHook?.observation === "prepared") await without.nativeHook.lease.cleanup();
    }
  });
});

test("a review-armed launch's version probe never sees either hook family's marker", async () => {
  await fixture(async (_root, bin) => {
    const cli = join(bin, "claude");
    await fakeExecutable(cli);
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    const probeEnvironments: NodeJS.ProcessEnv[] = [];
    const launcher = createNativeCliLauncher(launcherConfig(), {
      platform: "linux",
      claudeVersionCommandRunner: async (_file, _args, options) => {
        probeEnvironments.push({ ...options.env });
        return { kind: "completed", stdout: "1.0.123 (Claude Code)\n" };
      },
    });
    const descriptor = await launcher("claude", {
      workspace,
      env: { PATH: bin, HOME: "/operator/home" },
      nativeHook: { bootstrap: reviewHookBootstrapFor("claude") },
      nativeReview: { bootstrap: bootstrapFor("claude") },
      claudeInboxCompatibility: true,
    });
    try {
      assert.equal(descriptor.env[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV] !== undefined, true, "the CHILD does get this launch's marker");
      assert.equal(probeEnvironments.length, 1, "the probe ran once");
      for (const probeEnv of probeEnvironments) {
        assert.equal(probeEnv[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], undefined, "a --version probe authenticates nothing");
        assert.equal(probeEnv[NATIVE_HOOK_BOOTSTRAP_ENV], undefined, "nor does it get the observer family's marker");
      }
    } finally {
      if (descriptor.nativeReview?.review === "prepared") await descriptor.nativeReview.lease.cleanup();
      if (descriptor.nativeHook?.observation === "prepared") await descriptor.nativeHook.lease.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Rendering is not exempt from the rule that an optional lane never fails a launch
// ---------------------------------------------------------------------------

test("a Windows batch render that refuses this lane's operand drops the lane and renders the baseline", async () => {
  // A `.cmd` shim renders the whole argv as one batch command line, and that render
  // rejects any token that is not a printable string. A review-only plugin operand is
  // generated by this lane and never written by an operator, so it is the only token in
  // the invocation that can trip the render — and when it does, the lane that prepared it
  // cleans up after itself and the launch proceeds without it.
  await fixture(async (_root, bin) => {
    const shim = join(bin, "claude.cmd");
    await writeFile(shim, "@echo off\r\n");
    await chmod(shim, 0o755);
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    let reviewCleanupCount = 0;
    const launcher = createNativeCliLauncher(launcherConfig({
      op: { adapter: "claude-cli", command: shim, args: [], review: {} },
    }), {
      platform: "win32",
      parentEnvironment: { SystemRoot: "Z:\\Fixture Windows Root" },
      nativeReviewPreparation: async () => ({
        review: "prepared" as const,
        backend: "claude" as const,
        args: ["--plugin-dir", "/synthetic/review\u0007plugin"],
        route: "claude-plugin-dir" as const,
        environment: { [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: "synthetic-review-marker" },
        lease: {
          root: "/synthetic/review-root",
          async cleanup() {
            reviewCleanupCount += 1;
            return { removed: ["/synthetic/review-root"], preserved: [] };
          },
        },
      }),
    });
    const shipped = helperModule.resolveTrustedWindowsCmd;
    helperModule.resolveTrustedWindowsCmd = () => "Z:\\Fixture Windows Root\\System32\\cmd.exe";
    try {
      const descriptor = await launcher("claude", {
        workspace,
        env: { PATH: bin, HOME: "C:\\operator\\home" },
        targetId: "external:op",
        nativeReview: { bootstrap: bootstrapFor("claude") },
      });
      assert.equal(descriptor.nativeReview?.review, "unavailable",
        "the lane this module prepared declined itself instead of failing the launch");
      assert.equal(descriptor.nativeReview?.reason, "artifact-staging-failed");
      assert.equal(descriptor.commandLine !== undefined, true,
        "the baseline still rendered as a batch command line");
      assert.equal((descriptor.commandLine ?? "").includes("\u0007"), false,
        "the unrenderable review operand is gone from what the child receives");
      assert.equal(descriptor.env[NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV], undefined,
        "and its marker is gone from the child environment");
      assert.equal(reviewCleanupCount, 1, "the staged plugin directory was cleaned up by this module");
    } finally {
      helperModule.resolveTrustedWindowsCmd = shipped;
    }
  });
});

test("a baseline Windows render failure is not a lane outcome and still propagates", async () => {
  // With NO prepared review lane in the argv, the same render failure must reach the
  // caller unchanged: a lane fallback must never swallow a real launch failure.
  await fixture(async (_root, bin) => {
    const shim = join(bin, "claude.cmd");
    await writeFile(shim, "@echo off\r\n");
    await chmod(shim, 0o755);
    const workspace = join(_root, "workspace");
    await mkdir(workspace);
    let reviewCleanupCount = 0;
    const launcher = createNativeCliLauncher(launcherConfig({
      op: { adapter: "claude-cli", command: shim, args: [], review: {} },
    }), {
      platform: "win32",
      parentEnvironment: { SystemRoot: "Z:\\Fixture Windows Root" },
      nativeReviewPreparation: async () => ({
        review: "prepared" as const,
        backend: "claude" as const,
        args: ["--plugin-dir", "/synthetic/review-plugin"],
        route: "claude-plugin-dir" as const,
        environment: { [NATIVE_REVIEW_HOOK_BOOTSTRAP_ENV]: "synthetic-review-marker" },
        lease: {
          root: "/synthetic/review-root",
          async cleanup() {
            reviewCleanupCount += 1;
            return { removed: ["/synthetic/review-root"], preserved: [] };
          },
        },
      }),
    });
    const shipped = helperModule.resolveTrustedWindowsCmd;
    // No trusted cmd.exe at all: nothing about this launch involves a review lane's
    // operand, so the refusal is the launch's own and no fallback may hide it.
    helperModule.resolveTrustedWindowsCmd = () => null;
    try {
      await assert.rejects(
        launcher("claude", {
          workspace,
          env: { PATH: bin, HOME: "C:\\operator\\home" },
          targetId: "external:op",
          nativeReview: { bootstrap: bootstrapFor("claude") },
        }),
        /cmd\.exe/u,
      );
    } finally {
      helperModule.resolveTrustedWindowsCmd = shipped;
    }
  });
});

// ---------------------------------------------------------------------------
// Windows: the review plugin's root must be privately DACL'd, not chmod'd
// ---------------------------------------------------------------------------

const WINDOWS_ACL_SKIP = process.platform === "win32"
  ? false
  : "Windows DACL fixtures require a Windows host, the only platform with a DACL to read";

/** Grant an inheritable full-control entry to authenticated users on one directory. */
function grantInheritableWrite(target: string): void {
  execFileSync("icacls", [target, "/grant", "*S-1-5-11:(OI)(CI)F"], {
    timeout: 30_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * The skip for the cases that need a real LOCALAPPDATA fallback candidate: the
 * host's own value is what the shared Windows parent rule reads, so a host
 * without it cannot exercise the fallback at all.
 */
const LOCAL_APP_DATA_SKIP = process.platform === "win32" && process.env.LOCALAPPDATA === undefined
  ? "the fallback candidate is the host's own LOCALAPPDATA, which this host does not define"
  : WINDOWS_ACL_SKIP;

/** The host's own `LOCALAPPDATA`, the trusted source the shared parent rule reads. */
function hostLocalAppData(): string {
  const value = process.env.LOCALAPPDATA;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("the fallback candidate is the host's own LOCALAPPDATA");
  }
  return value;
}

/**
 * A private candidate fallback parent: one freshly created child of the host's
 * real `LOCALAPPDATA`, which is exactly where the production fallback stages.
 * It is deliberately NOT inside the fixture tree — the fixture sits under the
 * default temp directory these cases refuse, so a candidate inside it would
 * fail on that refused Temp's own ancestry instead of on its own grant. Only
 * the one directory created here is ever removed.
 */
async function localAppDataCandidate(): Promise<string> {
  return realpath(await mkdtemp(join(hostLocalAppData(), "native-review-prep-lad-")));
}

/**
 * The namespace `os.tmpdir()` must actually resolve to. The shared parent
 * rule's FIRST candidate is `os.tmpdir()` itself, so a fixture whose namespace
 * never moved would grant or refuse the real user temp directory and prove
 * nothing about this launch.
 */
function assertTempNamespace(namespace: string): void {
  assert.equal(tmpdir(), namespace, "os.tmpdir() resolves to this fixture's own temp namespace");
}

test("a staged Windows review root carries a real private DACL, not a synthesized mode bit", { skip: WINDOWS_ACL_SKIP }, async () => {
  // `os.tmpdir()` on Windows consults USERPROFILE before TMP, so the namespace is
  // moved by way of USERPROFILE here; otherwise the fixture would measure the real
  // user temp directory and prove nothing about this launch.
  await fixture(async (_root, bin) => {
    const relay = await relayEntryIn(bin);
    const outcome = prepared(await prepareNativeReviewHookLaunch(preparationInput("claude", {
      entrypoints: { nodeExecutable: process.execPath, relayEntry: relay },
    })));
    try {
      const root = outcome.lease.root as string;
      // The same assertion the host's own peer-state policy applies: a real private
      // DACL on the directory the launched provider will read as executable config.
      createPeerStatePermissionPolicy().assertPrivateDirectory(root);
    } finally {
      await outcome.lease.cleanup();
    }
  }, { isolateTempNamespace: true, tempNamespaceViaUserProfile: true });
});

test("a temp parent carrying an untrusted inheritable write grant falls back to the proven host LOCALAPPDATA", { skip: LOCAL_APP_DATA_SKIP }, async () => {
  const localAppData = await localAppDataCandidate();
  try {
    await fixture(async (_root, bin) => {
      const relay = await relayEntryIn(bin);
      const namespace = join(_root, "temp-namespace");
      assertTempNamespace(namespace);
      grantInheritableWrite(namespace);
      // The trusted host's own variable, pointed at the separately proven candidate.
      process.env.LOCALAPPDATA = localAppData;
      const outcome = prepared(await prepareNativeReviewHookLaunch(preparationInput("claude", {
        entrypoints: { nodeExecutable: process.execPath, relayEntry: relay },
      })));
      try {
        const root = outcome.lease.root as string;
        assert.equal(dirname(root), localAppData, "the root sits directly in the proven LOCALAPPDATA parent");
        assert.notEqual(dirname(root), await realpath(namespace), "the refused temp parent is not the root's parent");
        // The same assertion the host's own peer-state policy applies: a real private
        // DACL on the directory the launched provider will read as executable config.
        createPeerStatePermissionPolicy().assertPrivateDirectory(root);
      } finally {
        await outcome.lease.cleanup();
      }
      // With USERPROFILE relocated here, Windows tooling may create its own
      // profile folders (e.g. AppData) in the namespace; only a staged review
      // root would mean the refused parent was used.
      assert.deepEqual(readdirSync(namespace).filter((entry) => entry.startsWith("prg-native-review-")), [],
        "the refused temp namespace never received a staged review root");
      assert.deepEqual(readdirSync(localAppData), [], "owned, nonrecursive cleanup removed every staged entry");
    }, { isolateTempNamespace: true, tempNamespaceViaUserProfile: true });
  } finally {
    await rm(localAppData, { recursive: true, force: true });
  }
});

test("preparation declines when the LOCALAPPDATA fallback candidate itself carries an untrusted inheritable write grant", { skip: LOCAL_APP_DATA_SKIP }, async () => {
  // The SAME separately created fallback parent the success case proves: a
  // candidate inside the fixture tree would be refused by the fixture's own
  // ancestry under the default Temp before its own grant was ever consulted, so
  // a refusal there would not show that the fallback checks the candidate's DACL.
  const localAppData = await localAppDataCandidate();
  try {
    await fixture(async (_root, bin) => {
      const relay = await relayEntryIn(bin);
      const namespace = join(_root, "temp-namespace");
      assertTempNamespace(namespace);
      grantInheritableWrite(namespace);
      process.env.LOCALAPPDATA = localAppData;
      const entrypoints = { nodeExecutable: process.execPath, relayEntry: relay };
      // First the clean fallback: with ONLY the temp parent refused, the
      // candidate's own proof is what accepts it, and the root really lands there.
      const staged = prepared(await prepareNativeReviewHookLaunch(preparationInput("claude", { entrypoints })));
      try {
        assert.equal(dirname(staged.lease.root as string), localAppData,
          "the clean fallback stages directly in the proven LOCALAPPDATA parent");
      } finally {
        await staged.lease.cleanup();
      }
      assert.deepEqual(readdirSync(localAppData), [], "owned, nonrecursive cleanup removed every staged entry");
      // Then the very same parent, granted an inheritable write entry of its
      // own: with the temp parent still refused, only the fallback's own check
      // of this directory can produce the refusal now.
      grantInheritableWrite(localAppData);
      const outcome = await prepareNativeReviewHookLaunch(preparationInput("claude", { entrypoints }));
      assert.equal(outcome.review, "unavailable",
        "no parent this host can prove owner-controlled is refused before anything is staged");
      assert.equal(outcome.reason, "artifact-staging-failed");
      // With USERPROFILE relocated here, Windows tooling may create its own
      // profile folders (e.g. AppData) in the namespace; only a staged review
      // root would mean the refused parent was used.
      assert.deepEqual(readdirSync(namespace).filter((entry) => entry.startsWith("prg-native-review-")), [],
        "nothing was staged in the refused temp namespace");
      assert.deepEqual(readdirSync(localAppData), [], "nothing was staged in the refused LOCALAPPDATA candidate");
    }, { isolateTempNamespace: true, tempNamespaceViaUserProfile: true });
  } finally {
    await rm(localAppData, { recursive: true, force: true });
  }
});
