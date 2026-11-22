import assert from "node:assert/strict";
import { lstatSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { RUNTIME_ROLE_ENV } from "../src/session-host/launch";
import {
  createNativeCliLauncher,
  scanNativeArgPositions,
  type NativeCliLaunchDescriptor,
  type NativeCodexOwnedLaunchPlan,
} from "../src/session-host/native-cli-launch";
import { NATIVE_HOOK_BOOTSTRAP_ENV, type NativeHookBootstrap } from "../src/session-host/native-hook-protocol";
import {
  NATIVE_MCP_ARTIFACT_ROOT_PREFIX,
  NATIVE_MCP_SERVER_NAME_PREFIX,
  NATIVE_MCP_SERVER_NAME_SUFFIX_LENGTH,
  isValidNativeMcpServerName,
  prepareNativeMcpLaunch,
  type NativeMcpLaunchOutcome,
  type NativeMcpLaunchPreparationInput,
  type NativeMcpStagingStage,
} from "../src/session-host/native-mcp-launch-prep";
import { encodeNativeMcpBootstrap, type NativeMcpBootstrap } from "../src/session-host/native-mcp-protocol";
import { readNativeMcpBootstrapFile } from "../src/session-host/native-mcp-relay";
import { retainedFixtureBase } from "./helpers/scratch-fixture-base";

/**
 * #682 native MCP relay launch preparation. Everything here is synthetic: no
 * provider CLI or relay process runs, no broker is started, no live session is
 * created, and no provider configuration, approval, or credential is read or
 * written. Fixtures and staged artifacts live under the system temporary
 * directory only.
 *
 * Conflict evidence is split deliberately: the tests below prove the refusals
 * this module can actually observe (operator argv in real option position,
 * including an entry naming the selected host server). A same-name server
 * configured only in another provider layer is accepted residual risk, never
 * read here, and therefore never asserted as detected.
 */

/**
 * The stable host-wide server name a trusted owner supplies: generated once per
 * host and persisted by the host (synthetic value here). Never per launch.
 */
const HOST_SERVER_NAME = `${NATIVE_MCP_SERVER_NAME_PREFIX}${"0123456789abcdef".repeat(2)}`;

const INSTANCE_ID = "33333333-3333-4333-8333-333333333333";
const GENERATION = "44444444-4444-4444-8444-444444444444";
const MCP_TOKEN = "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f";
const HOOK_TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const DIGEST = "b".repeat(64);
const OWNED_CONTROL = ["app-server", "--listen", "ws://127.0.0.1:0", "--ws-auth", "capability-token", "--ws-token-sha256", DIGEST];
const OWNED_TUI_CONNECTION = {
  args: ["--remote", "ws://127.0.0.1:4567", "--remote-auth-token-env", "PRG_SYNTHETIC_REMOTE_TOKEN"],
  env: { PATH: "/usr/bin", PRG_SYNTHETIC_REMOTE_TOKEN: "synthetic" },
};

function mcpBootstrapFor(backend: "claude" | "codex"): NativeMcpBootstrap {
  return {
    version: 1,
    type: "native_mcp_bootstrap",
    socketPath: "/tmp/prg-synthetic-status-broker.sock",
    generation: GENERATION,
    instanceId: INSTANCE_ID,
    backend,
    token: MCP_TOKEN,
  };
}

function hookBootstrapFor(backend: "claude" | "codex"): NativeHookBootstrap {
  return {
    version: 1,
    socketPath: "/tmp/prg-synthetic-status-broker.sock",
    generation: GENERATION,
    instanceId: INSTANCE_ID,
    backend,
    token: HOOK_TOKEN,
  };
}

// The full runner shares its TMPDIR across test-file processes. Count only
// this file's default launch artifacts, never another file's live leases.
const hostTemp = tmpdir();
const tempVariables = ["TMPDIR", "TEMP", "TMP"] as const;
const savedTemp = tempVariables.map((key) => process.env[key]);
let fileTemp: string | undefined;

test.before(async () => {
  fileTemp = await mkdtemp(join(hostTemp, "native-mcp-prep-file-"));
  for (const key of tempVariables) process.env[key] = fileTemp;
});

test.after(async () => {
  for (const [index, key] of tempVariables.entries()) {
    const previous = savedTemp[index];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  if (fileTemp !== undefined) await rm(fileTemp, { recursive: true, force: true });
});

async function fixture(run: (root: string, bin: string) => Promise<void>, mode = 0o700): Promise<void> {
  // The unprotected-parent checks deliberately need no private ancestor. The
  // runner's private invocation root would correctly shield those paths.
  const base = mode === 0o755 ? retainedFixtureBase(process.env.PI_TEST_SCRATCH_ROOT ? undefined : hostTemp) : tmpdir();
  const allocatedRoot = await mkdtemp(join(base, "native-mcp-prep-"));
  try {
    const root = await realpath(allocatedRoot);
    await chmod(root, mode);
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await run(root, bin);
  } finally {
    await chmod(allocatedRoot, 0o700).catch(() => undefined);
    await rm(allocatedRoot, { recursive: true, force: true });
  }
}

async function fakeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\necho never invoked\n");
  await chmod(path, 0o755);
}

function configWith(externalAgents: Record<string, unknown>): ReviewGateConfig {
  return normalizeConfig({ enabled: true, externalAgents });
}

/** The owner-supplied MCP option for one launch. */
function mcpOption(backend: "claude" | "codex", serverName: string = HOST_SERVER_NAME) {
  return { bootstrap: mcpBootstrapFor(backend), serverName };
}

function input(
  backend: "claude" | "codex",
  args: readonly string[],
  overrides: Partial<NativeMcpLaunchPreparationInput> = {},
): NativeMcpLaunchPreparationInput {
  return {
    backend,
    bootstrap: mcpBootstrapFor(backend),
    platform: "linux",
    scan: scanNativeArgPositions(backend, args, "synthetic-target"),
    env: { PATH: "/usr/bin" },
    ownedCodexBackend: backend === "codex",
    serverName: HOST_SERVER_NAME,
    ...overrides,
  };
}

/** Every file under `dir`, recursively, with its contents. */
function filesUnder(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stats = lstatSync(path);
    if (stats.isDirectory()) out.push(...filesUnder(path));
    else if (stats.isFile()) out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

function artifactRootCount(): number {
  try {
    return readdirSync(tmpdir()).filter((name) => name.startsWith(NATIVE_MCP_ARTIFACT_ROOT_PREFIX)).length;
  } catch {
    return 0;
  }
}

function prepared(outcome: NativeMcpLaunchOutcome | undefined) {
  assert.equal(outcome?.mcp, "prepared", `expected prepared, got ${JSON.stringify(outcome)}`);
  if (outcome?.mcp !== "prepared") throw new Error("unreachable");
  return outcome;
}

function unavailable(outcome: NativeMcpLaunchOutcome | undefined, reason: string): void {
  assert.equal(outcome?.mcp, "unavailable", `expected unavailable, got ${JSON.stringify(outcome)}`);
  if (outcome?.mcp !== "unavailable") throw new Error("unreachable");
  assert.equal(outcome.reason, reason);
}

function ownedPlanOf(descriptor: NativeCliLaunchDescriptor): NativeCodexOwnedLaunchPlan {
  assert.ok(descriptor.ownedCodex !== undefined, "an owned Codex plan is attached");
  return descriptor.ownedCodex!;
}

function assertNoToken(value: unknown, label: string): void {
  const text = JSON.stringify(value);
  assert.ok(!text.includes(MCP_TOKEN), `${label} carries the MCP token`);
}

const relayEntry = join(__dirname, "..", "src", "session-host", "native-mcp-relay.js");

test("Claude preparation stages one private bootstrap and one single-server --mcp-config, with exact modes and no secret outside the bootstrap", async () => {
  const before = artifactRootCount();
  const outcome = prepared(await prepareNativeMcpLaunch(input("claude", ["--model", "opus"])));
  try {
    assert.equal(outcome.route, "claude-mcp-config");
    assert.equal(outcome.placement, "claude-tui");
    assert.equal(outcome.serverName, HOST_SERVER_NAME);
    const root = outcome.lease.root;
    assert.equal(root, await realpath(root), "the root is canonical");
    assert.ok(root.startsWith(join(await realpath(tmpdir()), NATIVE_MCP_ARTIFACT_ROOT_PREFIX)));
    assert.equal(statSync(root).mode & 0o777, 0o700);
    const configFile = join(root, "claude-mcp-config.json");
    // One attached flag only: no strict mode, permissions, tools, or prompts.
    assert.deepEqual(outcome.args, [`--mcp-config=${configFile}`]);
    assert.deepEqual(readdirSync(root).sort(), ["claude-mcp-config.json", "native-mcp-bootstrap.json"]);
    for (const name of readdirSync(root)) {
      const stats = lstatSync(join(root, name));
      assert.ok(stats.isFile());
      assert.equal(stats.mode & 0o777, 0o600, `${name} is 0600`);
    }
    assert.equal(outcome.lease.bootstrapFile, join(root, "native-mcp-bootstrap.json"));
    assert.equal(readFileSync(outcome.lease.bootstrapFile, "utf8"), encodeNativeMcpBootstrap(mcpBootstrapFor("claude")));
    const configText = readFileSync(configFile, "utf8");
    assert.ok(!configText.includes(MCP_TOKEN));
    assert.deepEqual(JSON.parse(configText), {
      mcpServers: {
        [HOST_SERVER_NAME]: {
          type: "stdio",
          command: process.execPath,
          args: [relayEntry, "--bootstrap-file", outcome.lease.bootstrapFile],
        },
      },
    });
    assertNoToken({ ...outcome, lease: { root: outcome.lease.root, bootstrapFile: outcome.lease.bootstrapFile } }, "the outcome");
  } finally {
    const cleanup = await outcome.lease.cleanup();
    assert.deepEqual(cleanup.preserved, []);
    assert.deepEqual(cleanup.absent, []);
    assert.equal(cleanup.removed.length, 3);
    assert.deepEqual(await outcome.lease.cleanup(), cleanup, "cleanup is idempotent");
  }
  assert.equal(artifactRootCount(), before, "no artifact root is left behind");
});

test("the staged bootstrap satisfies the landed relay reader contract, and its consumption is reported as absent at cleanup", async () => {
  for (const backend of ["claude", "codex"] as const) {
    const outcome = prepared(await prepareNativeMcpLaunch(input(backend, [])));
    const read = readNativeMcpBootstrapFile(outcome.lease.bootstrapFile);
    assert.deepEqual(read, { ok: true, bootstrap: mcpBootstrapFor(backend) }, `${backend} bootstrap is accepted by the relay reader`);
    // Read once: a second read finds nothing.
    assert.equal(readNativeMcpBootstrapFile(outcome.lease.bootstrapFile).ok, false);
    const cleanup = await outcome.lease.cleanup();
    assert.deepEqual(cleanup.absent, [outcome.lease.bootstrapFile]);
    assert.deepEqual(cleanup.preserved, []);
    assert.ok(cleanup.removed.includes(outcome.lease.root));
  }
});

test("owned Codex preparation emits one -c mcp_servers override for the backend only; a non-owned Codex launch is declined with nothing staged", async () => {
  const before = artifactRootCount();
  const outcome = prepared(await prepareNativeMcpLaunch(input("codex", ["-c", "model=\"o3\""])));
  try {
    assert.equal(outcome.route, "codex-owned-backend-config");
    assert.equal(outcome.placement, "codex-owned-backend");
    const file = outcome.lease.bootstrapFile;
    assert.deepEqual(outcome.args, [
      "-c",
      `mcp_servers.${HOST_SERVER_NAME}={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(relayEntry)},"--bootstrap-file",${JSON.stringify(file)}]}`,
    ]);
    assert.deepEqual(readdirSync(outcome.lease.root), ["native-mcp-bootstrap.json"], "Codex stages the bootstrap only");
    assertNoToken(outcome.args, "the Codex override");
  } finally {
    await outcome.lease.cleanup();
  }
  unavailable(await prepareNativeMcpLaunch(input("codex", [], { ownedCodexBackend: false })), "codex-backend-not-owned");
  assert.equal(artifactRootCount(), before);
});

test("operator MCP flags in real option position decline instead of overriding; the same spellings past -- are prompt data", async () => {
  const before = artifactRootCount();
  // Claude: a strict scope, a separated --mcp-config without a readable operand,
  // or a visible selected-name entry. A plain --mcp-config is joined (below).
  const claudeConflicts: string[][] = [
    ["--strict-mcp-config"],
    ["--strict-mcp-config=true"],
    ["--model", "opus", "--strict-mcp-config", "--mcp-config", "{}"],
    ["--mcp-config", "/etc/operator.json", "--strict-mcp-config"],
    // Claude hands `--name` the `--` as its value and still parses the strict flag.
    ["--mcp-config=/etc/operator.json", "--name", "--", "--strict-mcp-config"],
    ["--mcp-config"],
    ["--mcp-config", "--", "prompt"],
    ["--model", "opus", "--mcp-config", "--", "--mcp-config", "/etc/operator.json"],
  ];
  for (const args of claudeConflicts) {
    unavailable(await prepareNativeMcpLaunch(input("claude", args)), "operator-mcp-override");
  }
  const codexConflicts: string[][] = [
    ["-c", "mcp_servers={}"],
    ["-c", `mcp_servers.${HOST_SERVER_NAME}.command="x"`],
    [`-cmcp_servers.${HOST_SERVER_NAME}.enabled=false`],
    [`--config= mcp_servers . ${HOST_SERVER_NAME} .args=[]`],
    ["--config", `mcp_servers."${HOST_SERVER_NAME}"={}`],
  ];
  for (const args of codexConflicts) {
    unavailable(await prepareNativeMcpLaunch(input("codex", args)), "operator-mcp-override");
  }
  assert.equal(artifactRootCount(), before, "a declined request stages nothing");

  // Unrelated servers and prompt data are not conflicts; neither is a plain
  // operator --mcp-config, nor a strict spelling that is another option's operand.
  for (const [backend, args] of [
    ["claude", ["--", "--mcp-config", "--strict-mcp-config"]],
    ["claude", ["--settings", "/etc/operator-settings.json"]],
    ["claude", ["--mcp-config", "/etc/operator.json"]],
    ["claude", ["--mcp-config=/etc/operator.json"]],
    ["claude", ["--append-system-prompt", "--strict-mcp-config"]],
    // Past a genuine terminator the strict spelling is prompt data.
    ["claude", ["--mcp-config=/etc/operator.json", "--", "--strict-mcp-config"]],
    ["claude", ["--system-prompt", "--strict-mcp-config", "--mcp-config", "/etc/operator.json"]],
    ["codex", ["-c", "mcp_servers.other.command=\"x\"", "-c", "mcp_servers_note=1"]],
  ] as const) {
    const outcome = prepared(await prepareNativeMcpLaunch(input(backend, args)));
    await outcome.lease.cleanup();
  }
});

test("Windows is declined before any entry, path, or artifact work; contract violations are refusals", async () => {
  const before = artifactRootCount();
  for (const backend of ["claude", "codex"] as const) {
    unavailable(await prepareNativeMcpLaunch(input(backend, [], {
      platform: "win32",
      entrypoints: { nodeExecutable: "C:\\missing\\node.exe", relayEntry: "C:\\missing\\relay.js" },
      artifactParent: "C:\\nowhere",
    })), "platform-unsupported");
  }
  assert.equal(artifactRootCount(), before);

  await assert.rejects(prepareNativeMcpLaunch(input("claude", [], { platform: "freebsd" })), /freebsd is unsupported/u);
  await assert.rejects(
    prepareNativeMcpLaunch(input("claude", [], { bootstrap: mcpBootstrapFor("codex") })),
    /registered for codex and cannot arm a claude launch/u,
  );
  // An observer hook bootstrap never authenticates the MCP lane.
  await assert.rejects(
    prepareNativeMcpLaunch(input("claude", [], { bootstrap: hookBootstrapFor("claude") as unknown as NativeMcpBootstrap })),
    /missing, malformed, or carries an unexpected field/u,
  );
  await assert.rejects(
    prepareNativeMcpLaunch(input("claude", [], { bootstrap: { ...mcpBootstrapFor("claude"), extra: 1 } as unknown as NativeMcpBootstrap })),
    /unexpected field/u,
  );
  await assert.rejects(
    prepareNativeMcpLaunch(input("claude", [], { env: { [RUNTIME_ROLE_ENV]: "executor" } })),
    new RegExp(RUNTIME_ROLE_ENV, "u"),
  );
  assert.equal(artifactRootCount(), before, "no refusal staged an artifact");
});

test("missing or relative relay entry points and unusable or unprotected artifact parents are declined with nothing left behind", async () => {
  await fixture(async (root, bin) => {
    const relay = join(bin, "native-mcp-relay.js");
    await writeFile(relay, "// never invoked\n");
    for (const entrypoints of [
      { nodeExecutable: process.execPath, relayEntry: join(bin, "missing.js") },
      { nodeExecutable: "node", relayEntry: relay },
      { nodeExecutable: process.execPath, relayEntry: bin },
    ]) {
      unavailable(await prepareNativeMcpLaunch(input("claude", [], { entrypoints, artifactParent: root })), "relay-entry-unavailable");
    }
    unavailable(await prepareNativeMcpLaunch(input("claude", [], { artifactParent: "relative/dir" })), "artifact-path-unprotected");
    // A parent that cannot be canonicalized is rejected before anything is created.
    unavailable(await prepareNativeMcpLaunch(input("claude", [], { artifactParent: join(root, "missing") })), "artifact-path-unprotected");

    // A symlinked parent is canonicalized: the paths handed to the provider are real.
    const real = join(root, "real");
    await mkdir(real, { mode: 0o700 });
    await symlink(real, join(root, "link"));
    const viaLink = prepared(await prepareNativeMcpLaunch(input("claude", [], { artifactParent: join(root, "link") })));
    assert.ok(viaLink.lease.root.startsWith(`${real}/`));
    assert.equal(readNativeMcpBootstrapFile(viaLink.lease.bootstrapFile).ok, true);
    await viaLink.lease.cleanup();
    assert.deepEqual(readdirSync(real), []);
    assert.deepEqual(readdirSync(root).sort(), ["bin", "link", "real"], "nothing was left in the parent");
  });

  // A parent another local user could rename entries in (group/other-writable,
  // not sticky, not shielded by a private ancestor) is refused before the token
  // is ever written, exactly as the relay would refuse it.
  await fixture(async (root) => {
    const open = join(root, "world-writable");
    await mkdir(open);
    await chmod(open, 0o777);
    unavailable(await prepareNativeMcpLaunch(input("claude", [], { artifactParent: open })), "artifact-path-unprotected");
    assert.deepEqual(readdirSync(open), [], "the rejected root was removed");
  }, 0o755);
});

test("cleanup removes only the exact inodes it created and preserves a replaced file or a foreign entry", async () => {
  await fixture(async (root) => {
    const replaced = prepared(await prepareNativeMcpLaunch(input("claude", [], { artifactParent: root })));
    const configFile = join(replaced.lease.root, "claude-mcp-config.json");
    // Unlink, then recreate at the same path: the lease's pinned descriptor
    // keeps the original inode allocated, so the replacement can never reuse
    // its identity and is preserved.
    await unlink(configFile);
    await writeFile(configFile, "{}\n", { mode: 0o600 });
    const first = await replaced.lease.cleanup();
    assert.deepEqual(first.removed, [replaced.lease.bootstrapFile]);
    assert.deepEqual([...first.preserved].sort(), [configFile, replaced.lease.root].sort());
    await rm(replaced.lease.root, { recursive: true, force: true });

    const foreign = prepared(await prepareNativeMcpLaunch(input("codex", [], { artifactParent: root })));
    const intruder = join(foreign.lease.root, "foreign.txt");
    await writeFile(intruder, "not ours\n");
    const second = await foreign.lease.cleanup();
    assert.deepEqual(second.removed, [foreign.lease.bootstrapFile]);
    assert.deepEqual(second.preserved, [foreign.lease.root]);
    assert.equal(readFileSync(intruder, "utf8"), "not ours\n", "the foreign entry survives");
  });
});

test("an omitted MCP option preserves every launch exactly; an armed Claude launch adds only the attached flag in real option position", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const before = artifactRootCount();
    const config = configWith({
      op: { adapter: "claude-cli", command: join(bin, "claude"), args: ["--model", "opus", "--", "literal prompt"], review: {} },
    });
    const launcher = createNativeCliLauncher(config, { platform: "linux" });
    const owned = createNativeCliLauncher(config, { platform: "linux", ownedCodexBackend: true });
    const base = { workspace, env: { PATH: bin } };

    for (const [run, backend] of [[launcher, "claude"], [launcher, "codex"], [owned, "codex"]] as const) {
      const plain = await run(backend, base);
      const absent = await run(backend, { ...base, nativeMcp: undefined });
      assert.ok(!("nativeMcp" in plain) && !("nativeMcp" in absent), "no outcome without the option");
      assert.deepEqual(absent.args, plain.args);
      assert.deepEqual(absent.env, plain.env);
      if (plain.ownedCodex !== undefined) {
        assert.deepEqual(ownedPlanOf(absent).renderBackend(OWNED_CONTROL, {}).args, plain.ownedCodex.renderBackend(OWNED_CONTROL, {}).args);
      }
    }
    assert.equal(artifactRootCount(), before, "no option, no artifact");

    const unarmed = await launcher("claude", { ...base, targetId: "external:op" });
    const armed = await launcher("claude", { ...base, targetId: "external:op", nativeMcp: mcpOption("claude") });
    const mcp = prepared(armed.nativeMcp);
    try {
      assert.deepEqual(unarmed.args, ["--model", "opus", "--", "literal prompt"]);
      assert.deepEqual(armed.args, ["--model", "opus", ...mcp.args, "--", "literal prompt"]);
      assert.deepEqual(armed.env, unarmed.env, "the environment gains nothing");
      assertNoToken({ args: armed.args, env: armed.env }, "the Claude descriptor");

      // Together with the hook observer: independent credentials, hook flag first.
      const both = await launcher("claude", {
        ...base,
        nativeHook: { bootstrap: hookBootstrapFor("claude") },
        nativeMcp: mcpOption("claude"),
      });
      try {
        assert.equal(both.nativeHook?.observation, "prepared");
        const bothMcp = prepared(both.nativeMcp);
        if (both.nativeHook?.observation !== "prepared") throw new Error("unreachable");
        assert.deepEqual(both.args, [...both.nativeHook.args, ...bothMcp.args]);
        assertNoToken({ args: both.args, env: both.env }, "the combined descriptor");
        assert.ok(!both.env[NATIVE_HOOK_BOOTSTRAP_ENV]!.includes(MCP_TOKEN));
        await bothMcp.lease.cleanup();
      } finally {
        if (both.nativeHook?.observation === "prepared") await both.nativeHook.lease.cleanup();
      }
    } finally {
      await mcp.lease.cleanup();
    }

    // An operator --mcp-config is joined: their tokens stay exactly as configured
    // and our attached flag follows them as one more value of the same option.
    const operatorConfig = configWith({
      op: { adapter: "claude-cli", command: join(bin, "claude"), args: ["--mcp-config", "/etc/operator.json"], review: {} },
    });
    const joined = await createNativeCliLauncher(operatorConfig, { platform: "linux" })("claude", {
      ...base, targetId: "external:op", nativeMcp: mcpOption("claude"),
    });
    const joinedMcp = prepared(joined.nativeMcp);
    try {
      assert.deepEqual(joined.args, ["--mcp-config", "/etc/operator.json", ...joinedMcp.args]);
    } finally {
      await joinedMcp.lease.cleanup();
    }

    // An operator --strict-mcp-config keeps its scope: declined, argv unchanged.
    const strictConfig = configWith({
      op: { adapter: "claude-cli", command: join(bin, "claude"), args: ["--mcp-config", "/etc/operator.json", "--strict-mcp-config"], review: {} },
    });
    const declined = await createNativeCliLauncher(strictConfig, { platform: "linux" })("claude", {
      ...base, targetId: "external:op", nativeMcp: mcpOption("claude"),
    });
    unavailable(declined.nativeMcp, "operator-mcp-override");
    assert.deepEqual(declined.args, ["--mcp-config", "/etc/operator.json", "--strict-mcp-config"]);
    assert.equal(artifactRootCount(), before, "every lease was released");
  });
});

/**
 * The `--mcp-config` value Claude's own option parser would build from `argv`,
 * transcribed from the parser observed in the installed CLI for the spellings
 * these fixtures use: a separated occurrence takes the next token
 * unconditionally and then every token up to the next option-like one (length
 * > 1, leading `-`); an attached `--mcp-config=v` takes exactly `v`; repeated
 * occurrences concatenate; a required-value option takes the next token as
 * data; `--` ends option parsing. Only the options these fixtures spell are
 * modeled, so this is a fixture oracle, not a second production parser.
 */
function claudeParsedMcpConfig(argv: readonly string[]): string[] {
  const valueOptions = new Set([
    "--model", "--name", "-n", "--system-prompt", "--append-system-prompt", "--settings",
    "--system-prompt-file", "--append-system-prompt-file", "--prefill",
  ]);
  const isOption = (token: string): boolean => token.length > 1 && token.startsWith("-");
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--") break;
    if (token === "--mcp-config") {
      // The first value is taken unconditionally (even `--`).
      if (index + 1 >= argv.length) throw new Error("option '--mcp-config <configs...>' argument missing");
      values.push(argv[++index]!);
      while (index + 1 < argv.length && !isOption(argv[index + 1]!)) values.push(argv[++index]!);
      continue;
    }
    if (token.startsWith("--mcp-config=")) {
      values.push(token.slice("--mcp-config=".length));
      continue;
    }
    if (valueOptions.has(token)) index += 1;
  }
  return values;
}

test("a non-strict operator --mcp-config is joined: every operator token stays in place and the one parsed option gains our file last; strict and unarmed launches are unchanged", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    // Prompt files whose names look like flags (Claude reads them relative to the workspace).
    await writeFile(join(workspace, "--"), "Operator prompt configuration.\n");
    await writeFile(join(workspace, "--mcp-config"), "Operator prompt configuration.\n");
    // Real operator files: they must never be opened for writing, replaced, or chmodded.
    const opA = join(root, "operator-a.json");
    const opB = join(root, "operator b.json");
    // A dash-leading relative operand (resolved by Claude, never by this host).
    const opDash = "-operator-dash.json";
    const operatorFiles = [opA, opB];
    for (const [index, path] of operatorFiles.entries()) {
      await writeFile(path, `${JSON.stringify({ mcpServers: { [`operator_${index}`]: { type: "stdio", command: "/bin/true" } } })}\n`);
      await chmod(path, 0o640);
    }
    const snapshot = () => operatorFiles.map((path) => {
      const stats = lstatSync(path, { bigint: true });
      return { path, text: readFileSync(path, "utf8"), ino: stats.ino, mode: stats.mode, mtime: stats.mtimeNs, ctime: stats.ctimeNs };
    });
    const filesBefore = snapshot();
    const inlineServer = JSON.stringify({ mcpServers: { operator_inline: { type: "stdio", command: "/bin/true", args: ["--strict-mcp-config"] } } });
    const before = artifactRootCount();

    // [operator argv, index our flag must land at]
    const cases: [string[], number][] = [
      // Separated, one value.
      [["--mcp-config", opA], 2],
      // Attached.
      [[`--mcp-config=${opA}`], 1],
      // Separated variadic: several values, including inline JSON with option-like text inside.
      [["--mcp-config", opA, opB, inlineServer, "--model", "opus"], 6],
      // Repeated, mixed spellings around unrelated options.
      [[`--mcp-config=${opA}`, "--name", "row", "--mcp-config", opB, inlineServer, "--settings", "/etc/s.json"], 8],
      // A dash-leading operand is taken as the value of a separated occurrence.
      [["--mcp-config", opDash, opB], 3],
      // Before the boundary: past `--` the same spellings are prompt data.
      [["--mcp-config", opA, opB, "--", "--mcp-config", "/not/an/input.json", "prompt"], 3],
      // Before an option still missing its operand.
      [["--mcp-config", opA, "--model"], 2],
      // An option-like operand of another option is data, not an MCP option.
      [["--system-prompt", "--mcp-config", "--model", "opus"], 4],
      [["--append-system-prompt", "--strict-mcp-config", "--mcp-config", opA], 4],
      // Empty attached value: Claude drops it; we preserve it.
      [["--mcp-config=", "--mcp-config", opA], 3],
      // An extensionless relative config named like a subcommand is a value of the run.
      [["--mcp-config", opA, "mcp", "--model", "opus"], 5],
      // `--` as a required operand is data and option parsing continues.
      [["--name", "--", "--mcp-config", opA], 4],
      // Prompt-file options take a required filename, even one that looks like a flag:
      // our flag never becomes that filename, and their operand is never an MCP option.
      [[`--mcp-config=${opA}`, "--system-prompt-file", "--"], 3],
      [["--append-system-prompt-file", "--mcp-config", "--mcp-config", opA], 4],
      // The same holds for a required-value option `--help` does not document.
      [["--prefill", "--mcp-config", "--mcp-config", opA], 4],
      // A genuine terminator: the strict spelling past it is prompt data.
      [[`--mcp-config=${opA}`, "--", "--strict-mcp-config"], 1],
      // A prefix-sharing inline server name is joined.
      [["--mcp-config", JSON.stringify({ mcpServers: { [`${HOST_SERVER_NAME}_backup`]: { type: "stdio", command: "/bin/true" } } })], 2],
    ];
    for (const [operatorArgs, at] of cases) {
      const config = configWith({ op: { adapter: "claude-cli", command: join(bin, "claude"), args: operatorArgs, review: {} } });
      const launcher = createNativeCliLauncher(config, { platform: "linux" });
      const request = { workspace, env: { PATH: bin }, targetId: "external:op" };
      const unarmed = await launcher("claude", request);
      assert.ok(!("nativeMcp" in unarmed));
      assert.deepEqual(unarmed.args, operatorArgs, "unarmed: exactly the operator argv");
      const armed = await launcher("claude", { ...request, nativeMcp: mcpOption("claude") });
      const mcp = prepared(armed.nativeMcp);
      try {
        const ours = join(mcp.lease.root, "claude-mcp-config.json");
        assert.deepEqual(mcp.args, [`--mcp-config=${ours}`]);
        const expected = [...operatorArgs];
        expected.splice(at, 0, `--mcp-config=${ours}`);
        assert.deepEqual(armed.args, expected, JSON.stringify(operatorArgs));
        // One native option value: the operator inputs, unchanged and in order, then ours.
        assert.deepEqual(claudeParsedMcpConfig(armed.args), [...claudeParsedMcpConfig(operatorArgs), ours]);
        assert.deepEqual(armed.env, unarmed.env, "the environment gains nothing");
        assertNoToken({ args: armed.args, env: armed.env }, "the joined descriptor");
        assert.ok(!armed.args.some((arg) => /strict-mcp-config|permission|allowed-?tools/iu.test(arg) && !operatorArgs.includes(arg)));
      } finally {
        await mcp.lease.cleanup();
      }
    }

    // An armed restoration keeps a well-formed variadic run as configuration:
    // both operator configs, then ours, then the exact resume id, before the
    // real terminator. A malformed run (`--mcp-config -- …`) and real prompt
    // data stay refused.
    {
      const resumeConversationId = "0f8e2a4c-6b1d-4c3e-9a7f-5d2b8c1e4a60";
      const request = { workspace, env: { PATH: bin }, targetId: "external:op", resumeConversationId };
      const restoreWith = (operatorArgs: string[]) => createNativeCliLauncher(
        configWith({ op: { adapter: "claude-cli", command: join(bin, "claude"), args: operatorArgs, review: {} } }),
        { platform: "linux" },
      );
      const restored = await restoreWith(["--mcp-config", opA, opB, "--"])("claude", { ...request, nativeMcp: mcpOption("claude") });
      const mcp = prepared(restored.nativeMcp);
      try {
        assert.deepEqual(restored.args, ["--mcp-config", opA, opB, ...mcp.args, "--resume", resumeConversationId, "--"]);
        assert.deepEqual(claudeParsedMcpConfig(restored.args), [opA, opB, join(mcp.lease.root, "claude-mcp-config.json")]);
      } finally {
        await mcp.lease.cleanup();
      }
      // A prompt-file operand is configuration, like a --system-prompt value.
      const withPromptFile = await restoreWith(["--system-prompt-file", "prompt.txt", "--mcp-config", opA])("claude", {
        ...request, nativeMcp: mcpOption("claude"),
      });
      const promptFileMcp = prepared(withPromptFile.nativeMcp);
      try {
        assert.deepEqual(withPromptFile.args, ["--system-prompt-file", "prompt.txt", "--mcp-config", opA, ...promptFileMcp.args, "--resume", resumeConversationId]);
      } finally {
        await promptFileMcp.lease.cleanup();
      }
      for (const operatorArgs of [
        ["--mcp-config", "--", opA],
        ["--mcp-config", opA, "--model", "opus", "a prompt"],
        ["--mcp-config", opA, "--", "a prompt"],
        // An undocumented option's value is consumed by the scan but never proves configuration.
        ["--prefill", "draft text", "--mcp-config", opA],
        // ...including one shaped like an option, which the raw positional check would accept.
        ["--prefill", "--file", "--mcp-config", opA],
        ["--mcp-config", opA, "--plan-mode-instructions", "--model"],
      ]) {
        await assert.rejects(restoreWith(operatorArgs)("claude", { ...request, nativeMcp: mcpOption("claude") }), /cannot restore/u, JSON.stringify(operatorArgs));
        if (operatorArgs[0] === "--prefill" || operatorArgs.includes("--plan-mode-instructions")) {
          await assert.rejects(restoreWith(operatorArgs)("claude", request), /unproven startup value for --(prefill|plan-mode-instructions)/u);
        }
      }
    }

    // Strict scope, a malformed separated occurrence, or a visible selected-name
    // entry: declined with nothing staged and the exact operator argv.
    const escapedKey = `{"mcpServers":{"${HOST_SERVER_NAME.replace(/_/gu, "\\u005f")}":{"type":"stdio","command":"/bin/true"}}}`;
    for (const operatorArgs of [
      ["--mcp-config", opA, "--strict-mcp-config"],
      ["--strict-mcp-config", `--mcp-config=${opA}`, "--mcp-config", opB],
      // The strict flag after a `--` that is `--name`'s value is real.
      [`--mcp-config=${opA}`, "--name", "--", "--strict-mcp-config"],
      // A real strict flag after a prompt filename that spells `--mcp-config`.
      ["--system-prompt-file", "--mcp-config", "--strict-mcp-config", "--mcp-config", opA],
      ["--append-system-prompt-file", "--", "--strict-mcp-config", `--mcp-config=${opA}`],
      ["--prefill", "--mcp-config", "--strict-mcp-config", "--mcp-config", opA],
      ["--mcp-config", opA, escapedKey],
      ["--model", "opus", "--mcp-config", "--", "prompt"],
      ["--mcp-config", opA, JSON.stringify({ mcpServers: { [HOST_SERVER_NAME]: { type: "stdio", command: "/bin/true" } } })],
    ]) {
      const config = configWith({ op: { adapter: "claude-cli", command: join(bin, "claude"), args: operatorArgs, review: {} } });
      const launcher = createNativeCliLauncher(config, { platform: "linux" });
      const request = { workspace, env: { PATH: bin }, targetId: "external:op" };
      const unarmed = await launcher("claude", request);
      const declined = await launcher("claude", { ...request, nativeMcp: mcpOption("claude") });
      unavailable(declined.nativeMcp, "operator-mcp-override");
      assert.deepEqual(declined.args, operatorArgs);
      assert.deepEqual(declined.args, unarmed.args);
      assert.deepEqual(declined.env, unarmed.env);
    }
    assert.equal(artifactRootCount(), before, "every lease was released and no decline staged anything");
    assert.deepEqual(snapshot(), filesBefore, "operator MCP files are never modified");
  });
});

test("the one scanner records Claude's variadic --mcp-config values as data without reclassifying any token", () => {
  const options = (args: string[]) => scanNativeArgPositions("claude", args, "synthetic-target").options;
  assert.deepEqual(options(["--mcp-config", "a.json", "b.json", "-", "--model", "opus", "prompt"]), [
    { tokenIndex: 0, name: "--mcp-config", operand: "a.json", variadicValues: ["b.json", "-"] },
    { tokenIndex: 4, name: "--model", operand: "opus" },
  ]);
  // Attached: exactly one value, the following token is not continued.
  assert.deepEqual(options(["--mcp-config=a.json", "prompt"]), [{ tokenIndex: 0, name: "--mcp-config", attached: "a.json" }]);
  // A separated operand is taken unconditionally; the run stops at an option-like token or `--`.
  assert.deepEqual(options(["--mcp-config", "-dash.json", "b.json", "--", "c.json"]), [
    { tokenIndex: 0, name: "--mcp-config", operand: "-dash.json", variadicValues: ["b.json"] },
  ]);
  // Claude takes `--` as a required operand (declined by preparation as malformed),
  // and the variadic run continues after it.
  assert.deepEqual(options(["--mcp-config", "--", "a.json"]), [
    { tokenIndex: 0, name: "--mcp-config", operand: "--", variadicValues: ["a.json"] },
  ]);
  // `--` as another option's operand: parsing continues, so a later strict flag is real.
  const strictAfterName = scanNativeArgPositions("claude", ["--mcp-config=o.json", "--name", "--", "--strict-mcp-config"], "synthetic-target");
  assert.equal(strictAfterName.terminatorIndex, -1);
  assert.deepEqual(strictAfterName.options.map((option) => option.name), ["--mcp-config", "--name", "--strict-mcp-config"]);
  assert.equal(strictAfterName.options[1]!.operand, "--");
  // A genuine terminator still ends option parsing.
  const genuine = scanNativeArgPositions("claude", ["--mcp-config=o.json", "--", "--strict-mcp-config"], "synthetic-target");
  assert.equal(genuine.terminatorIndex, 1);
  assert.equal(genuine.insertionIndex, 1);
  assert.deepEqual(genuine.options.map((option) => option.name), ["--mcp-config"]);
  // Codex keeps its boundary rule: a `--` where an operand is expected is the terminator.
  const codex = scanNativeArgPositions("codex", ["-m", "--", "-c", "x=1"], "synthetic-target");
  assert.equal(codex.terminatorIndex, 1);
  assert.equal(codex.insertionIndex, 0);
  // Another option's operand is data, even when it spells an MCP option.
  assert.deepEqual(options(["--system-prompt", "--mcp-config", "x"]), [{ tokenIndex: 0, name: "--system-prompt", operand: "--mcp-config" }]);
  // Non-variadic options never gain continuation values.
  assert.deepEqual(options(["--settings", "s.json", "prompt"]), [{ tokenIndex: 0, name: "--settings", operand: "s.json" }]);
  // Values of the run are operands: an extensionless relative config named `mcp`
  // (or an empty value, which Claude drops) is data, not a subcommand.
  assert.deepEqual(options(["--mcp-config", "a.json", "mcp", "", "--model", "opus"]), [
    { tokenIndex: 0, name: "--mcp-config", operand: "a.json", variadicValues: ["mcp", ""] },
    { tokenIndex: 4, name: "--model", operand: "opus" },
  ]);
  // A genuine bare subcommand stays refused: alone, after other options, or after
  // the attached spelling, which never continues.
  for (const args of [["mcp"], ["--model", "opus", "mcp"], ["--mcp-config=a.json", "mcp"], ["--mcp-config", "a.json", "--model", "opus", "mcp"]]) {
    assert.throws(() => options(args), /headless or service mode/u, JSON.stringify(args));
  }
  // Both spellings of Claude's tool allow/deny lists are refused like the camel-case ones.
  for (const args of [
    ["--mcp-config", "a.json", "--allowed-tools", "Read"],
    ["--mcp-config=a.json", "--disallowed-tools=Read"],
    ["--allowed-tools=Read"],
    ["--disallowed-tools", "Read"],
    ["--mcp-config", "a.json", "--allowedTools", "Read"],
  ]) {
    assert.throws(() => options(args), /approval or sandbox bypass option/u, JSON.stringify(args));
  }
  // Past a genuine terminator the same spelling is prompt data.
  assert.deepEqual(options(["--mcp-config=a.json", "--", "--allowed-tools", "Read"]).map((option) => option.name), ["--mcp-config"]);
  // Undocumented required-value options consume their operand like documented ones.
  assert.deepEqual(options(["--prefill", "--strict-mcp-config", "--mcp-config=a.json"]), [
    { tokenIndex: 0, name: "--prefill", operand: "--strict-mcp-config" },
    { tokenIndex: 2, name: "--mcp-config", attached: "a.json" },
  ]);
  // Printable-string validation still covers the run.
  assert.throws(() => options(["--mcp-config", "a.json", "b\u0007.json"]), /not a printable string/u);
});

test("owned Codex places the override on the backend render only, after the operator's -c tokens; the TUI, descriptor, and non-owned Codex stay unarmed", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const before = artifactRootCount();
    const config = configWith({
      op: { adapter: "codex-cli", command: join(bin, "codex"), args: ["-c", "mcp_servers.other.command=\"x\"", "-m", "o3"], review: {} },
    });
    const owned = createNativeCliLauncher(config, { platform: "linux", ownedCodexBackend: true });
    const request = { workspace, env: { PATH: bin }, targetId: "external:op" };
    const unarmed = await owned("codex", request);
    const armed = await owned("codex", { ...request, nativeMcp: mcpOption("codex") });
    const mcp = prepared(armed.nativeMcp);
    try {
      assert.equal(mcp.placement, "codex-owned-backend");
      assert.deepEqual(armed.args, unarmed.args, "the ordinary descriptor argv is unarmed");
      assert.deepEqual(armed.env, unarmed.env);
      const unarmedBackend = ownedPlanOf(unarmed).renderBackend(OWNED_CONTROL, { PATH: bin });
      const armedBackend = ownedPlanOf(armed).renderBackend(OWNED_CONTROL, { PATH: bin });
      assert.deepEqual(unarmedBackend.args, ["-c", "mcp_servers.other.command=\"x\"", ...OWNED_CONTROL]);
      assert.deepEqual(armedBackend.args, ["-c", "mcp_servers.other.command=\"x\"", ...mcp.args, ...OWNED_CONTROL]);
      assert.deepEqual(armedBackend.env, unarmedBackend.env, "the backend environment gains nothing");
      const unarmedTui = ownedPlanOf(unarmed).renderTui(OWNED_TUI_CONNECTION);
      const armedTui = ownedPlanOf(armed).renderTui(OWNED_TUI_CONNECTION);
      assert.deepEqual(armedTui.args, unarmedTui.args, "the TUI never receives the MCP override");
      assert.deepEqual(armedTui.env, unarmedTui.env);
      assertNoToken({ a: armed.args, b: armedBackend, t: armedTui, e: armed.env, be: ownedPlanOf(armed).backendEnv }, "the owned renders");
    } finally {
      await mcp.lease.cleanup();
    }

    const plain = createNativeCliLauncher(config, { platform: "linux" });
    const plainUnarmed = await plain("codex", request);
    const legacy = await plain("codex", { ...request, nativeMcp: mcpOption("codex") });
    unavailable(legacy.nativeMcp, "codex-backend-not-owned");
    assert.deepEqual(legacy.args, plainUnarmed.args);
    assert.deepEqual(legacy.env, plainUnarmed.env);
    assert.equal(artifactRootCount(), before);
  });
});

test("a malformed or cross-backend MCP option is refused before environment, discovery, hook, or artifact work", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const before = artifactRootCount();
    const hookRootsBefore = readdirSync(tmpdir()).filter((name) => name.startsWith("prg-native-hook-")).length;
    const launcher = createNativeCliLauncher(configWith({}), { platform: "linux" });
    // PATH points nowhere: a later stage would fail with "not found", so the MCP
    // refusal surfacing proves it ran first.
    const request = { workspace, env: { PATH: join(root, "nowhere") }, nativeHook: { bootstrap: hookBootstrapFor("claude") } };
    for (const nativeMcp of [
      { bootstrap: mcpBootstrapFor("codex") },
      { bootstrap: hookBootstrapFor("claude") },
      {},
      null,
    ]) {
      await assert.rejects(
        launcher("claude", { ...request, nativeMcp: nativeMcp as never }),
        /native MCP (bootstrap is registered for codex|launch option must carry)/u,
      );
    }
    assert.equal(artifactRootCount(), before);
    assert.equal(readdirSync(tmpdir()).filter((name) => name.startsWith("prg-native-hook-")).length, hookRootsBefore);
  });
});

test("a Windows launch keeps its descriptor unchanged and stages nothing when MCP is armed", async () => {
  await fixture(async (root, bin) => {
    const exe = join(bin, "claude.exe");
    await fakeExecutable(exe);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const before = artifactRootCount();
    const launcher = createNativeCliLauncher(configWith({
      op: { adapter: "claude-cli", command: exe, args: ["--model", "opus"], review: {} },
    }), { platform: "win32" });
    const request = { workspace, env: { PATH: bin }, targetId: "external:op" };
    const unarmed = await launcher("claude", request);
    const armed = await launcher("claude", { ...request, nativeMcp: mcpOption("claude") });
    unavailable(armed.nativeMcp, "platform-unsupported");
    assert.deepEqual(armed.args, unarmed.args);
    assert.deepEqual(armed.env, unarmed.env);
    assert.equal(artifactRootCount(), before);
  });
});

/** Another valid stable host name, to prove the name is the supplied one rather than a constant. */
const OTHER_HOST_SERVER_NAME = `${NATIVE_MCP_SERVER_NAME_PREFIX}${"f".repeat(NATIVE_MCP_SERVER_NAME_SUFFIX_LENGTH)}`;

test("both providers stage the same supplied host server name with no provider proof or inventory; the name is the caller's, not a constant", async () => {
  const before = artifactRootCount();
  assert.ok(isValidNativeMcpServerName(HOST_SERVER_NAME) && isValidNativeMcpServerName(OTHER_HOST_SERVER_NAME));
  for (const serverName of [HOST_SERVER_NAME, OTHER_HOST_SERVER_NAME]) {
    // The ordinary path: no operator MCP settings, no compatibility proof.
    // Each lease is released by its own finally, so a later failure cannot strand an earlier one.
    const claude = prepared(await prepareNativeMcpLaunch(input("claude", [], { serverName })));
    try {
      assert.equal(claude.serverName, serverName);
      const configFile = join(claude.lease.root, "claude-mcp-config.json");
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(configFile, "utf8")).mcpServers), [serverName]);
      const codex = prepared(await prepareNativeMcpLaunch(input("codex", [], { serverName })));
      try {
        assert.equal(codex.serverName, serverName);
        assert.equal(codex.args.length, 2);
        assert.equal(codex.args[0], "-c");
        assert.ok(codex.args[1]!.startsWith(`mcp_servers.${serverName}={command=`), codex.args[1]);
      } finally {
        await codex.lease.cleanup();
      }
    } finally {
      await claude.lease.cleanup();
    }
  }
  assert.equal(artifactRootCount(), before);
});

test("an absent or invalid host server name is refused before any role check, path work, or artifact", async () => {
  const before = artifactRootCount();
  const invalid: unknown[] = [
    undefined,
    null,
    42,
    "",
    "pi_review_gate",
    NATIVE_MCP_SERVER_NAME_PREFIX,
    `${NATIVE_MCP_SERVER_NAME_PREFIX}${"a".repeat(NATIVE_MCP_SERVER_NAME_SUFFIX_LENGTH - 1)}`,
    `${NATIVE_MCP_SERVER_NAME_PREFIX}${"a".repeat(NATIVE_MCP_SERVER_NAME_SUFFIX_LENGTH + 1)}`,
    `${NATIVE_MCP_SERVER_NAME_PREFIX}${"A".repeat(NATIVE_MCP_SERVER_NAME_SUFFIX_LENGTH)}`,
    `${NATIVE_MCP_SERVER_NAME_PREFIX}${"g".repeat(NATIVE_MCP_SERVER_NAME_SUFFIX_LENGTH)}`,
    `other_${"a".repeat(NATIVE_MCP_SERVER_NAME_SUFFIX_LENGTH)}`,
    ` ${HOST_SERVER_NAME}`,
    `${HOST_SERVER_NAME}\n`,
    HOST_SERVER_NAME.toUpperCase(),
    "claude-opus-4",
  ];
  for (const backend of ["claude", "codex"] as const) {
    for (const serverName of invalid) {
      assert.equal(isValidNativeMcpServerName(serverName), false, `${JSON.stringify(serverName)} is not a host server name`);
      await assert.rejects(
        prepareNativeMcpLaunch(input(backend, [], { serverName: serverName as string, env: { [RUNTIME_ROLE_ENV]: "executor" } })),
        /stable host MCP server name/u,
      );
    }
    const { serverName: _omitted, ...withoutName } = input(backend, []);
    await assert.rejects(prepareNativeMcpLaunch(withoutName as NativeMcpLaunchPreparationInput), /stable host MCP server name/u);
  }
  assert.equal(artifactRootCount(), before, "no refusal staged an artifact");
});

test("an operator argv entry that names the selected host server declines; unrelated and differently named servers stay untouched", async () => {
  const before = artifactRootCount();
  // Observed conflicts: the selected name in real option position, by tool namespace.
  for (const args of [
    ["-c", `mcp_servers.${HOST_SERVER_NAME}.enabled=false`],
    ["--config", `mcp_servers.${HOST_SERVER_NAME.toUpperCase()}.command="x"`],
    ["-c", "mcp_servers.github.command=\"gh\"", "-c", `mcp_servers."${HOST_SERVER_NAME}"={}`],
  ]) {
    unavailable(await prepareNativeMcpLaunch(input("codex", args)), "operator-mcp-override");
  }
  // Claude: an inline JSON --mcp-config input that defines the selected server
  // (decoded key, by tool namespace) declines, in every supported spelling, as
  // does an input that starts like JSON but does not parse.
  const inline = (name: string) => JSON.stringify({ mcpServers: { [name]: { type: "stdio", command: "/bin/true" } } });
  const escapedKey = `{"mcpServers":{"${HOST_SERVER_NAME.replace(/_/gu, "\\u005f")}":{"type":"stdio","command":"/bin/true"}}}`;
  assert.ok(!escapedKey.includes(HOST_SERVER_NAME), "the escaped spelling hides the literal name");
  assert.deepEqual(Object.keys(JSON.parse(escapedKey).mcpServers), [HOST_SERVER_NAME]);
  for (const args of [
    ["--mcp-config", inline(HOST_SERVER_NAME)],
    [`--mcp-config=${inline(HOST_SERVER_NAME.toUpperCase())}`],
    ["--mcp-config", "/etc/operator.json", inline(HOST_SERVER_NAME.replace(/_/gu, "-"))],
    ["--mcp-config=/etc/a.json", "--model", "opus", "--mcp-config", "/etc/b.json", "-", inline(HOST_SERVER_NAME)],
    ["--mcp-config", escapedKey],
    [`--mcp-config= ${escapedKey} `],
    ["--mcp-config", "/etc/operator.json", `{"mcpServers":{"${HOST_SERVER_NAME}":`],
  ]) {
    unavailable(await prepareNativeMcpLaunch(input("claude", args)), "operator-mcp-override");
  }
  assert.equal(artifactRootCount(), before, "a declined request stages nothing");

  // Other inline servers and file paths are joined; their contents are never read.
  for (const args of [
    ["--mcp-config", inline("operator_one"), "/etc/operator.json"],
    [`--mcp-config=${inline(`${NATIVE_MCP_SERVER_NAME_PREFIX}extra`)}`],
    // A prefix-sharing server name is a different server.
    ["--mcp-config", inline(`${HOST_SERVER_NAME}_backup`)],
    [`--mcp-config=${inline(`backup_${HOST_SERVER_NAME}`)}`],
    // A file path is opaque even when it happens to spell the host name.
    ["--mcp-config", `/etc/${HOST_SERVER_NAME}.json`, `./${HOST_SERVER_NAME}`],
    // The selected name past the boundary is prompt data, not an input.
    ["--mcp-config", "/etc/operator.json", "--", inline(HOST_SERVER_NAME)],
  ]) {
    const outcome = prepared(await prepareNativeMcpLaunch(input("claude", args)));
    await outcome.lease.cleanup();
  }
  // The same inline entry is unrelated when the host selected another name.
  const other = prepared(await prepareNativeMcpLaunch(input("claude", ["--mcp-config", inline(HOST_SERVER_NAME)], {
    serverName: OTHER_HOST_SERVER_NAME,
  })));
  await other.lease.cleanup();
  assert.equal(artifactRootCount(), before);

  // The same operator entry is unrelated when the host selected another name,
  // as are the legacy fixed name and prefix-sharing names.
  for (const args of [
    ["-c", `mcp_servers.${HOST_SERVER_NAME}.enabled=false`],
    ["-c", "mcp_servers.pi_review_gate.command=\"x\"", "-c", `mcp_servers.${NATIVE_MCP_SERVER_NAME_PREFIX}extra.command="y"`],
  ]) {
    const outcome = prepared(await prepareNativeMcpLaunch(input("codex", args, { serverName: OTHER_HOST_SERVER_NAME })));
    assert.ok(outcome.args[1]!.startsWith(`mcp_servers.${OTHER_HOST_SERVER_NAME}=`));
    await outcome.lease.cleanup();
  }
  assert.equal(artifactRootCount(), before);
});

test("the launcher arms Claude and owned Codex with the same host name and no provider proof, declines an observed selected-name conflict, and refuses an absent or invalid name before discovery", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const before = artifactRootCount();
    const base = { workspace, env: { PATH: bin } };
    const launcher = createNativeCliLauncher(configWith({}), { platform: "linux" });
    const owned = createNativeCliLauncher(configWith({}), { platform: "linux", ownedCodexBackend: true });

    // Each lease is released by its own finally, so a later failure cannot strand an earlier one.
    const claude = await launcher("claude", { ...base, nativeMcp: mcpOption("claude") });
    const claudeMcp = prepared(claude.nativeMcp);
    try {
      assert.equal(claudeMcp.serverName, HOST_SERVER_NAME);
      const configFile = join(claudeMcp.lease.root, "claude-mcp-config.json");
      assert.ok(claude.args.includes(`--mcp-config=${configFile}`));
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(configFile, "utf8")).mcpServers), [HOST_SERVER_NAME]);
      const codex = await owned("codex", { ...base, nativeMcp: mcpOption("codex") });
      const codexMcp = prepared(codex.nativeMcp);
      try {
        assert.equal(codexMcp.serverName, HOST_SERVER_NAME);
        const backendArgs = ownedPlanOf(codex).renderBackend(OWNED_CONTROL, { PATH: bin }).args;
        assert.ok(backendArgs.some((arg) => arg.startsWith(`mcp_servers.${HOST_SERVER_NAME}=`)));
        // No approval, permission, or trust posture moves on either child.
        for (const arg of [...claude.args, ...backendArgs]) {
          assert.ok(!/permission|approval|allowed-?tools|strict-mcp|trust|sandbox/iu.test(arg), arg);
        }
      } finally {
        await codexMcp.lease.cleanup();
      }
    } finally {
      await claudeMcp.lease.cleanup();
    }

    // An operator entry for the selected name is an observed conflict: declined, renders unchanged.
    const conflicting = createNativeCliLauncher(configWith({
      op: { adapter: "codex-cli", command: join(bin, "codex"), args: ["-c", `mcp_servers.${HOST_SERVER_NAME}.command="x"`], review: {} },
    }), { platform: "linux", ownedCodexBackend: true });
    const request = { ...base, targetId: "external:op" };
    const unarmed = await conflicting("codex", request);
    const declined = await conflicting("codex", { ...request, nativeMcp: mcpOption("codex") });
    unavailable(declined.nativeMcp, "operator-mcp-override");
    assert.deepEqual(
      ownedPlanOf(declined).renderBackend(OWNED_CONTROL, { PATH: bin }).args,
      ownedPlanOf(unarmed).renderBackend(OWNED_CONTROL, { PATH: bin }).args,
    );

    // PATH points nowhere: the name refusal surfacing proves it ran before discovery.
    const nowhere = { workspace, env: { PATH: join(root, "nowhere") } };
    for (const nativeMcp of [
      { bootstrap: mcpBootstrapFor("claude") },
      { bootstrap: mcpBootstrapFor("claude"), serverName: "pi_review_gate" },
      { bootstrap: mcpBootstrapFor("claude"), serverName: "claude-opus-4" },
    ]) {
      await assert.rejects(launcher("claude", { ...nowhere, nativeMcp: nativeMcp as never }), /stable host MCP server name/u);
    }
    assert.equal(artifactRootCount(), before);
  });
});

test("a failure at any staging point rolls back every created entry, and an unprotected parent is rejected before anything is created", async () => {
  const stages: NativeMcpStagingStage[] = ["root-before-open", "root-created", "bootstrap-opened", "bootstrap-written", "config-opened", "config-written"];
  await fixture(async (root) => {
    const parent = join(root, "parent");
    await mkdir(parent, { mode: 0o700 });
    for (const failAt of stages) {
      const seen: NativeMcpStagingStage[] = [];
      const outcome = await prepareNativeMcpLaunch(input("claude", [], {
        artifactParent: parent,
        stagingProbe: (stage) => {
          seen.push(stage);
          if (stage === failAt) throw new Error(`injected failure at ${stage}`);
        },
      }));
      unavailable(outcome, "artifact-staging-failed");
      assert.equal(seen[seen.length - 1], failAt, `the probe reached ${failAt}`);
      assert.deepEqual(readdirSync(parent), [], `nothing survives a failure at ${failAt}`);
    }
    // Without a fault every stage is observed in order.
    const seen: NativeMcpStagingStage[] = [];
    const outcome = prepared(await prepareNativeMcpLaunch(input("claude", [], { artifactParent: parent, stagingProbe: (stage) => { seen.push(stage); } })));
    assert.deepEqual(seen, stages);
    await outcome.lease.cleanup();
    assert.deepEqual(readdirSync(parent), []);
  });

  await fixture(async (root) => {
    const open = join(root, "world-writable");
    await mkdir(open);
    await chmod(open, 0o777);
    const seen: NativeMcpStagingStage[] = [];
    unavailable(await prepareNativeMcpLaunch(input("codex", [], { artifactParent: open, stagingProbe: (stage) => { seen.push(stage); } })), "artifact-path-unprotected");
    assert.deepEqual(seen, [], "no staging point was ever reached");
    assert.deepEqual(readdirSync(open), [], "nothing was created in the unprotected parent");
    // Nothing anywhere in the fixture carries the token.
    assert.ok(filesUnder(root).every((file) => !file.text.includes(MCP_TOKEN)));
  }, 0o755);
});

test("an unlinked-then-recreated bootstrap is preserved, while a consumed bootstrap with no replacement is reported absent", async () => {
  await fixture(async (root) => {
    const openDescriptors = (): number | undefined => {
      try { return readdirSync("/proc/self/fd").length; } catch { return undefined; }
    };
    const descriptorsBefore = openDescriptors();
    const recreated = prepared(await prepareNativeMcpLaunch(input("codex", [], { artifactParent: root })));
    if (descriptorsBefore !== undefined) {
      // The root and the bootstrap stay pinned while the lease is live.
      assert.equal(openDescriptors(), descriptorsBefore + 2);
    }
    await unlink(recreated.lease.bootstrapFile);
    await writeFile(recreated.lease.bootstrapFile, "replacement\n", { mode: 0o600 });
    const first = await recreated.lease.cleanup();
    assert.deepEqual(first.removed, []);
    assert.deepEqual(first.absent, []);
    assert.deepEqual([...first.preserved].sort(), [recreated.lease.bootstrapFile, recreated.lease.root].sort());
    assert.equal(readFileSync(recreated.lease.bootstrapFile, "utf8"), "replacement\n", "the replacement survives");
    if (descriptorsBefore !== undefined) assert.equal(openDescriptors(), descriptorsBefore, "cleanup releases every pinned descriptor");
    await rm(recreated.lease.root, { recursive: true, force: true });

    const consumed = prepared(await prepareNativeMcpLaunch(input("codex", [], { artifactParent: root })));
    await unlink(consumed.lease.bootstrapFile);
    const second = await consumed.lease.cleanup();
    assert.deepEqual(second.absent, [consumed.lease.bootstrapFile]);
    assert.deepEqual(second.removed, [consumed.lease.root]);
    assert.deepEqual(second.preserved, []);
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(NATIVE_MCP_ARTIFACT_ROOT_PREFIX)), []);
  });
});

test("a cleanup lookup that fails for any reason but a missing entry preserves the file instead of reporting it absent", async () => {
  // The module calls `lstatSync` through the shared builtin at call time, so a
  // scoped wrapper injects EACCES for exactly the chosen paths.
  const fsModule = require("node:fs") as { lstatSync: (...args: unknown[]) => unknown };
  const original = fsModule.lstatSync;
  const failing = new Set<string>();
  fsModule.lstatSync = (...args: unknown[]) => {
    if (typeof args[0] === "string" && failing.has(args[0])) {
      throw Object.assign(new Error(`EACCES: permission denied, lstat '${args[0]}'`), { code: "EACCES" });
    }
    return original.apply(fsModule, args);
  };
  try {
    await fixture(async (root) => {
      // The bootstrap lookup fails: the credential file survives and is preserved.
      const unreadable = prepared(await prepareNativeMcpLaunch(input("codex", [], { artifactParent: root })));
      failing.add(unreadable.lease.bootstrapFile);
      const first = await unreadable.lease.cleanup();
      failing.clear();
      assert.deepEqual(first.absent, []);
      assert.deepEqual(first.removed, []);
      assert.deepEqual([...first.preserved].sort(), [unreadable.lease.bootstrapFile, unreadable.lease.root].sort());
      assert.equal(readFileSync(unreadable.lease.bootstrapFile, "utf8"), encodeNativeMcpBootstrap(mcpBootstrapFor("codex")));
      await rm(unreadable.lease.root, { recursive: true, force: true });

      // The root lookup fails too: nothing is reported absent and nothing is removed.
      const unreadableRoot = prepared(await prepareNativeMcpLaunch(input("claude", [], { artifactParent: root })));
      failing.add(unreadableRoot.lease.root);
      const second = await unreadableRoot.lease.cleanup();
      failing.clear();
      assert.deepEqual(second.absent, []);
      assert.deepEqual(second.removed, []);
      assert.equal(second.preserved.length, 3);
      assert.ok(lstatSync(unreadableRoot.lease.bootstrapFile).isFile(), "the bootstrap is still on disk");
      await rm(unreadableRoot.lease.root, { recursive: true, force: true });

      // The genuinely consumed case still reports absent.
      const consumed = prepared(await prepareNativeMcpLaunch(input("codex", [], { artifactParent: root })));
      await unlink(consumed.lease.bootstrapFile);
      const third = await consumed.lease.cleanup();
      assert.deepEqual(third.absent, [consumed.lease.bootstrapFile]);
      assert.deepEqual(third.removed, [consumed.lease.root]);
    });
  } finally {
    fsModule.lstatSync = original;
  }
});

/**
 * Scoped fault injection through the shared `node:fs` builtin, which the module
 * reads at call time. Every wrapper is restored before the test settles.
 */
async function withFsFaults(
  faults: {
    lstat?: (path: string) => boolean;
    afterOpen?: (path: string, fd: number) => void;
    fstat?: (fd: number) => void;
  },
  run: () => Promise<void>,
): Promise<void> {
  const fsModule = require("node:fs") as Record<string, (...args: unknown[]) => unknown>;
  const originals = { lstatSync: fsModule.lstatSync!, openSync: fsModule.openSync!, fstatSync: fsModule.fstatSync! };
  fsModule.lstatSync = (...args: unknown[]) => {
    if (typeof args[0] === "string" && faults.lstat?.(args[0])) {
      throw Object.assign(new Error(`EACCES: permission denied, lstat '${args[0]}'`), { code: "EACCES" });
    }
    return originals.lstatSync.apply(fsModule, args);
  };
  fsModule.openSync = (...args: unknown[]) => {
    const fd = originals.openSync.apply(fsModule, args) as number;
    if (typeof args[0] === "string") faults.afterOpen?.(args[0], fd);
    return fd;
  };
  fsModule.fstatSync = (...args: unknown[]) => {
    if (typeof args[0] === "number") faults.fstat?.(args[0]);
    return originals.fstatSync.apply(fsModule, args);
  };
  try {
    await run();
  } finally {
    Object.assign(fsModule, originals);
  }
}

test("a staging failure whose rollback cannot remove the written bootstrap reports the surviving paths instead of hiding them", async () => {
  await fixture(async (root) => {
    const parent = join(root, "parent");
    await mkdir(parent, { mode: 0o700 });
    let unreadable: string | undefined;
    await withFsFaults({ lstat: (path) => path === unreadable }, async () => {
      const outcome = await prepareNativeMcpLaunch(input("codex", [], {
        artifactParent: parent,
        stagingProbe: (stage) => {
          if (stage !== "bootstrap-written") return;
          const [rootName] = readdirSync(parent);
          unreadable = join(parent, rootName!, "native-mcp-bootstrap.json");
          throw new Error("injected failure after the bootstrap was written");
        },
      }));
      unreadable = undefined;
      assert.equal(outcome.mcp, "unavailable");
      if (outcome.mcp !== "unavailable") throw new Error("unreachable");
      assert.equal(outcome.reason, "artifact-staging-failed");
      const [rootName] = readdirSync(parent);
      const stagedRoot = join(parent, rootName!);
      const bootstrapFile = join(stagedRoot, "native-mcp-bootstrap.json");
      assert.deepEqual(outcome.rollback?.removed, []);
      assert.deepEqual([...(outcome.rollback?.preserved ?? [])].sort(), [bootstrapFile, stagedRoot].sort());
      assert.equal(readFileSync(bootstrapFile, "utf8"), encodeNativeMcpBootstrap(mcpBootstrapFor("codex")), "the bootstrap is still on disk");
      assertNoToken(outcome, "the failure outcome");
    });
  });

  // A clean rollback adds no rollback field at all.
  await fixture(async (root) => {
    const outcome = await prepareNativeMcpLaunch(input("codex", [], {
      artifactParent: root,
      stagingProbe: (stage) => { if (stage === "bootstrap-written") throw new Error("injected"); },
    }));
    assert.deepEqual(outcome, { mcp: "unavailable", backend: "codex", reason: "artifact-staging-failed" });
  });
});

test("an artifact whose identity could never be read is never removed: a replacement survives and is reported", async () => {
  await fixture(async (root) => {
    const parent = join(root, "parent");
    await mkdir(parent, { mode: 0o700 });
    let target: { path: string; fd: number } | undefined;
    await withFsFaults({
      afterOpen: (path, fd) => { if (path.endsWith("/native-mcp-bootstrap.json")) target = { path, fd }; },
      fstat: (fd) => {
        if (target === undefined || fd !== target.fd) return;
        // Something else now stands at the path before the identity is read.
        unlinkSync(target.path);
        writeFileSync(target.path, "synthetic replacement\n", { mode: 0o600 });
        throw Object.assign(new Error("EIO: i/o error, fstat"), { code: "EIO" });
      },
    }, async () => {
      const outcome = await prepareNativeMcpLaunch(input("claude", [], { artifactParent: parent }));
      assert.equal(outcome.mcp, "unavailable");
      if (outcome.mcp !== "unavailable") throw new Error("unreachable");
      assert.equal(outcome.reason, "artifact-staging-failed");
      assert.ok(target !== undefined, "the bootstrap open was observed");
      const stagedRoot = join(parent, readdirSync(parent)[0]!);
      assert.deepEqual([...(outcome.rollback?.preserved ?? [])].sort(), [target!.path, stagedRoot].sort());
      assert.equal(readFileSync(target!.path, "utf8"), "synthetic replacement\n", "the replacement survives");
    });
  });

  // A root whose identity could not be recorded right after creation is not
  // removed by ownership alone; it is reported as preserved.
  await fixture(async (root) => {
    const parent = join(root, "parent");
    await mkdir(parent, { mode: 0o700 });
    let failRoot = true;
    await withFsFaults({
      lstat: (path) => failRoot && path.startsWith(join(parent, NATIVE_MCP_ARTIFACT_ROOT_PREFIX)),
    }, async () => {
      const outcome = await prepareNativeMcpLaunch(input("codex", [], { artifactParent: parent }));
      failRoot = false;
      assert.equal(outcome.mcp, "unavailable");
      if (outcome.mcp !== "unavailable") throw new Error("unreachable");
      assert.equal(outcome.reason, "artifact-staging-failed");
      const entries = readdirSync(parent);
      assert.equal(entries.length, 1, "the unverified root was left in place");
      assert.deepEqual(outcome.rollback, { removed: [], absent: [], preserved: [join(parent, entries[0]!)] });
      assert.deepEqual(readdirSync(join(parent, entries[0]!)), [], "nothing was written into it");
    });
  });
});
