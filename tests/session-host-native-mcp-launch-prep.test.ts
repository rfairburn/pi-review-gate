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
  NATIVE_MCP_SERVER_NAME,
  prepareNativeMcpLaunch,
  type NativeMcpLaunchOutcome,
  type NativeMcpLaunchPreparationInput,
  type NativeMcpProviderConfigCompatibility,
  type NativeMcpStagingStage,
} from "../src/session-host/native-mcp-launch-prep";
import { encodeNativeMcpBootstrap, type NativeMcpBootstrap } from "../src/session-host/native-mcp-protocol";
import { readNativeMcpBootstrapFile } from "../src/session-host/native-mcp-relay";

/**
 * #682 native MCP relay launch preparation. Everything here is synthetic: no
 * provider CLI or relay process runs, no broker is started, no live session is
 * created, and no provider configuration, approval, or credential is read or
 * written. Fixtures and staged artifacts live under the system temporary
 * directory only.
 */

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

async function fixture(run: (root: string, bin: string) => Promise<void>, mode = 0o700): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-mcp-prep-")));
  await chmod(root, mode);
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  try { await run(root, bin); }
  finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function fakeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\necho never invoked\n");
  await chmod(path, 0o755);
}

function configWith(externalAgents: Record<string, unknown>): ReviewGateConfig {
  return normalizeConfig({ enabled: true, externalAgents });
}

const SYNTHETIC_WORKSPACE = "/synthetic/workspace";

/** A trusted owner-produced compatibility result for one launch. */
function compatible(
  backend: "claude" | "codex",
  workspace = SYNTHETIC_WORKSPACE,
  configuredServerNames: readonly string[] = ["github"],
): NativeMcpProviderConfigCompatibility {
  return { status: "resolved", backend, instanceId: INSTANCE_ID, workspace, configuredServerNames };
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
    workspace: SYNTHETIC_WORKSPACE,
    providerConfig: compatible(backend),
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
    assert.equal(outcome.serverName, NATIVE_MCP_SERVER_NAME);
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
        [NATIVE_MCP_SERVER_NAME]: {
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
      `mcp_servers.${NATIVE_MCP_SERVER_NAME}={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(relayEntry)},"--bootstrap-file",${JSON.stringify(file)}]}`,
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
  const claudeConflicts: string[][] = [
    ["--mcp-config", "/etc/operator.json"],
    ["--mcp-config=/etc/operator.json"],
    ["--strict-mcp-config"],
    ["--model", "opus", "--strict-mcp-config", "--mcp-config", "{}"],
  ];
  for (const args of claudeConflicts) {
    unavailable(await prepareNativeMcpLaunch(input("claude", args)), "operator-mcp-override");
  }
  const codexConflicts: string[][] = [
    ["-c", "mcp_servers={}"],
    ["-c", `mcp_servers.${NATIVE_MCP_SERVER_NAME}.command="x"`],
    [`-cmcp_servers.${NATIVE_MCP_SERVER_NAME}.enabled=false`],
    [`--config= mcp_servers . ${NATIVE_MCP_SERVER_NAME} .args=[]`],
    ["--config", `mcp_servers."${NATIVE_MCP_SERVER_NAME}"={}`],
  ];
  for (const args of codexConflicts) {
    unavailable(await prepareNativeMcpLaunch(input("codex", args)), "operator-mcp-override");
  }
  assert.equal(artifactRootCount(), before, "a declined request stages nothing");

  // Unrelated servers and prompt data are not conflicts.
  for (const [backend, args] of [
    ["claude", ["--", "--mcp-config", "--strict-mcp-config"]],
    ["claude", ["--settings", "/etc/operator-settings.json"]],
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
    const armed = await launcher("claude", { ...base, targetId: "external:op", nativeMcp: { bootstrap: mcpBootstrapFor("claude"), providerConfig: compatible("claude", workspace) } });
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
        nativeMcp: { bootstrap: mcpBootstrapFor("claude"), providerConfig: compatible("claude", workspace) },
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

    // An operator --mcp-config stays authoritative: declined, argv unchanged.
    const operatorConfig = configWith({
      op: { adapter: "claude-cli", command: join(bin, "claude"), args: ["--mcp-config", "/etc/operator.json"], review: {} },
    });
    const declined = await createNativeCliLauncher(operatorConfig, { platform: "linux" })("claude", {
      ...base, targetId: "external:op", nativeMcp: { bootstrap: mcpBootstrapFor("claude"), providerConfig: compatible("claude", workspace) },
    });
    unavailable(declined.nativeMcp, "operator-mcp-override");
    assert.deepEqual(declined.args, ["--mcp-config", "/etc/operator.json"]);
    assert.equal(artifactRootCount(), before, "every lease was released");
  });
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
    const armed = await owned("codex", { ...request, nativeMcp: { bootstrap: mcpBootstrapFor("codex"), providerConfig: compatible("codex", workspace) } });
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
    const legacy = await plain("codex", { ...request, nativeMcp: { bootstrap: mcpBootstrapFor("codex"), providerConfig: compatible("codex", workspace) } });
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
    const armed = await launcher("claude", { ...request, nativeMcp: { bootstrap: mcpBootstrapFor("claude"), providerConfig: compatible("claude", workspace) } });
    unavailable(armed.nativeMcp, "platform-unsupported");
    assert.deepEqual(armed.args, unarmed.args);
    assert.deepEqual(armed.env, unarmed.env);
    assert.equal(artifactRootCount(), before);
  });
});

test("effective provider configuration must be resolved by a trusted launch-specific result: collisions and unresolved precedence decline, unrelated servers do not", async () => {
  const before = artifactRootCount();
  for (const backend of ["claude", "codex"] as const) {
    // No result at all is unresolved.
    unavailable(await prepareNativeMcpLaunch(input(backend, [], { providerConfig: undefined })), "provider-config-unresolved");
    unavailable(await prepareNativeMcpLaunch(input(backend, [], {
      providerConfig: { status: "unresolved", backend, instanceId: INSTANCE_ID, workspace: SYNTHETIC_WORKSPACE },
    })), "provider-config-unresolved");
    // The reserved name already configured in a provider layer, in any spelling
    // whose tool namespace collides.
    for (const name of [NATIVE_MCP_SERVER_NAME, "PI-Review-Gate", "pi.review.gate"]) {
      unavailable(await prepareNativeMcpLaunch(input(backend, [], {
        providerConfig: compatible(backend, SYNTHETIC_WORKSPACE, ["github", name]),
      })), "provider-config-conflict");
    }
  }
  assert.equal(artifactRootCount(), before, "a declined request stages nothing");

  // Known unrelated servers never block preparation.
  for (const backend of ["claude", "codex"] as const) {
    const outcome = prepared(await prepareNativeMcpLaunch(input(backend, [], {
      providerConfig: compatible(backend, SYNTHETIC_WORKSPACE, ["github", "pi_review_gate_extra", "filesystem"]),
    })));
    await outcome.lease.cleanup();
    prepared(await prepareNativeMcpLaunch(input(backend, [], { providerConfig: compatible(backend, SYNTHETIC_WORKSPACE, []) })))
      .lease.cleanup();
  }

  // A result for another registration, backend, or workspace, or a malformed
  // one, is a contract refusal rather than a silent arming.
  const mismatches: [Partial<NativeMcpLaunchPreparationInput>, RegExp][] = [
    [{ providerConfig: { ...compatible("claude"), instanceId: "55555555-5555-4555-8555-555555555555" } }, /different registration/u],
    [{ providerConfig: compatible("codex") }, /different registration/u],
    [{ providerConfig: compatible("claude", "/other/workspace") }, /different workspace/u],
    [{ providerConfig: { ...compatible("claude"), configuredServerNames: [""] } as NativeMcpProviderConfigCompatibility }, /malformed/u],
    [{ providerConfig: { ...compatible("claude"), extra: true } as unknown as NativeMcpProviderConfigCompatibility }, /malformed/u],
    [{ providerConfig: { status: "unresolved", backend: "claude", instanceId: INSTANCE_ID, workspace: "relative" } }, /malformed/u],
  ];
  for (const [overrides, pattern] of mismatches) {
    await assert.rejects(prepareNativeMcpLaunch(input("claude", [], overrides)), pattern);
  }
  assert.equal(artifactRootCount(), before);
});

test("the launcher declines without a compatibility result and refuses one bound to another registration, leaving argv unchanged", async () => {
  await fixture(async (root, bin) => {
    await fakeExecutable(join(bin, "claude"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const before = artifactRootCount();
    const launcher = createNativeCliLauncher(configWith({}), { platform: "linux" });
    const base = { workspace, env: { PATH: bin } };
    const unarmed = await launcher("claude", base);
    const missing = await launcher("claude", { ...base, nativeMcp: { bootstrap: mcpBootstrapFor("claude") } });
    unavailable(missing.nativeMcp, "provider-config-unresolved");
    assert.deepEqual(missing.args, unarmed.args);
    const colliding = await launcher("claude", {
      ...base,
      nativeMcp: { bootstrap: mcpBootstrapFor("claude"), providerConfig: compatible("claude", workspace, [NATIVE_MCP_SERVER_NAME]) },
    });
    unavailable(colliding.nativeMcp, "provider-config-conflict");
    assert.deepEqual(colliding.args, unarmed.args);
    await assert.rejects(launcher("claude", {
      ...base,
      nativeMcp: { bootstrap: mcpBootstrapFor("claude"), providerConfig: compatible("claude", join(root, "elsewhere")) },
    }), /different workspace/u);
    await assert.rejects(launcher("claude", {
      ...base,
      env: { PATH: join(root, "nowhere") },
      nativeMcp: { bootstrap: mcpBootstrapFor("claude"), providerConfig: { ...compatible("claude", workspace), instanceId: "55555555-5555-4555-8555-555555555555" } },
    }), /different registration/u, "a mismatched registration is refused before discovery");
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
