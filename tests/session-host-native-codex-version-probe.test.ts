import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import type {
  NativeVersionCommandOptions,
  NativeVersionCommandResult,
  NativeVersionCommandRunner,
} from "../src/session-host/native-claude-version-probe";
import { createNativeCliLauncher, type NativeCliLauncherOptions } from "../src/session-host/native-cli-launch";
import { NATIVE_CODEX_IDLE_WAKE_CONTRACT } from "../src/session-host/native-codex-idle-wake";
import {
  CODEX_CALLBACK_SUPPORTED_CLI_VERSIONS,
  CODEX_VERSION_PROBE_MAX_OUTPUT_BYTES,
  CODEX_VERSION_PROBE_TIMEOUT_MS,
  declineCodexCallbackCompatibilityForPlatformOnly,
  isCodexCallbackPlatformDeclined,
  probeCodexCallbackCompatibility,
  readCodexBackendDiscoveryVersion,
  readCodexBackendHandshakeVersion,
  readCodexCallbackCompatibilityVersion,
  type NativeCodexCallbackCompatibilityOutcome,
} from "../src/session-host/native-codex-version-probe";
import type { NativeMcpLaunchOutcome } from "../src/session-host/native-mcp-launch-prep";
import type { NativeMcpBootstrap } from "../src/session-host/native-mcp-protocol";
import { NATIVE_MCP_SERVER_NAME_PREFIX } from "../src/session-host/native-mcp-server-name";

/**
 * #682: explicitly requested owned Codex callback compatibility evidence.
 *
 * Launcher cases inject a synthetic version runner, so no Codex process ever
 * runs and no provider prompt, configuration, or credential is touched. The
 * real bounded runner is exercised only against a tiny `/bin/sh` fixture under
 * the system temporary directory (Linux-only), never a provider CLI. Every
 * fixture and staged MCP artifact is removed in `finally`.
 */

const SUPPORTED = "0.171.0";
const linuxOnly = { skip: process.platform !== "linux" ? "the bounded runner is Linux-only" : false };

async function fixture(run: (root: string, bin: string, workspace: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-codex-version-probe-")));
  const bin = join(root, "bin");
  const workspace = join(root, "workspace");
  await mkdir(bin, { recursive: true });
  await mkdir(workspace, { recursive: true });
  try { await run(root, bin, workspace); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function script(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

const fakeExecutable = (path: string): Promise<void> => script(path, "echo never invoked; exit 3");

function configWith(externalAgents: Record<string, unknown>): ReviewGateConfig {
  return normalizeConfig({ enabled: true, externalAgents });
}

function syntheticRunner(answer: NativeVersionCommandResult | (() => Promise<NativeVersionCommandResult>)) {
  const calls: Array<{ file: string; args: readonly string[]; options: NativeVersionCommandOptions }> = [];
  const runner: NativeVersionCommandRunner = async (file, args, options) => {
    calls.push({ file, args: [...args], options: { ...options, env: { ...options.env } } });
    return typeof answer === "function" ? answer() : answer;
  };
  return { runner, calls };
}

const completed = (stdout: string): NativeVersionCommandResult => ({ kind: "completed", stdout });

function declined(outcome: NativeCodexCallbackCompatibilityOutcome | undefined): string {
  assert.equal(outcome?.compatibility, "declined", `expected a declined outcome, got ${JSON.stringify(outcome)}`);
  if (outcome?.compatibility !== "declined") throw new Error("unreachable");
  return outcome.reason;
}

const MCP_SERVER_NAME = `${NATIVE_MCP_SERVER_NAME_PREFIX}${"0123456789abcdef".repeat(2)}`;

function mcpOptionFor(backend: "claude" | "codex") {
  return {
    bootstrap: {
      version: 1,
      type: "native_mcp_bootstrap",
      socketPath: "/tmp/prg-synthetic-status-broker.sock",
      generation: "33333333-3333-4333-8333-333333333333",
      instanceId: "11111111-1111-4111-8111-111111111111",
      backend,
      token: "b".repeat(64),
    } as NativeMcpBootstrap,
    serverName: MCP_SERVER_NAME,
  };
}

async function releaseMcp(outcome: NativeMcpLaunchOutcome | undefined): Promise<void> {
  if (outcome?.mcp === "prepared") await outcome.lease.cleanup();
}

function launcherFor(runner: NativeVersionCommandRunner, extra: NativeCliLauncherOptions = {}, config = configWith({})) {
  return createNativeCliLauncher(config, { platform: "linux", ownedCodexBackend: true, codexVersionCommandRunner: runner, ...extra });
}

test("the supported set is exactly the verified idle-wake contract version", () => {
  assert.deepEqual([...CODEX_CALLBACK_SUPPORTED_CLI_VERSIONS], [NATIVE_CODEX_IDLE_WAKE_CONTRACT.codexVersion]);
  assert.equal(NATIVE_CODEX_IDLE_WAKE_CONTRACT.codexVersion, SUPPORTED);
});

test("the probe verifies only the exact official form of a supported version", async () => {
  const cases: Array<[NativeVersionCommandResult, NativeCodexCallbackCompatibilityOutcome]> = [
    [completed(`codex-cli ${SUPPORTED}\n`), { compatibility: "verified", version: SUPPORTED }],
    [completed(`codex-cli ${SUPPORTED}`), { compatibility: "verified", version: SUPPORTED }],
    [completed("codex-cli 0.170.0\n"), { compatibility: "declined", reason: "version-unsupported" }],
    [completed("codex-cli 0.172.0\n"), { compatibility: "declined", reason: "version-unsupported" }],
    [completed(`${SUPPORTED}\n`), { compatibility: "declined", reason: "version-unrecognized" }],
    [completed(`codex-cli ${SUPPORTED}-alpha.1\n`), { compatibility: "declined", reason: "version-unrecognized" }],
    [completed(`codex-cli ${SUPPORTED}\nextra\n`), { compatibility: "declined", reason: "version-unrecognized" }],
    [{ kind: "abnormal-exit" }, { compatibility: "declined", reason: "version-unavailable" }],
    [{ kind: "timeout" }, { compatibility: "declined", reason: "version-unavailable" }],
    [{ kind: "oversized" }, { compatibility: "declined", reason: "version-unavailable" }],
    [{ kind: "failed" }, { compatibility: "declined", reason: "version-unavailable" }],
  ];
  for (const [answer, expected] of cases) {
    const { runner, calls } = syntheticRunner(answer);
    assert.deepEqual(await probeCodexCallbackCompatibility({ file: "/synthetic/codex", env: { PATH: "/x" }, cwd: "/w", runner }), expected);
    assert.deepEqual(calls[0]!.args, ["--version"]);
    assert.equal(calls[0]!.options.timeoutMs, CODEX_VERSION_PROBE_TIMEOUT_MS);
    assert.equal(calls[0]!.options.maxOutputBytes, CODEX_VERSION_PROBE_MAX_OUTPUT_BYTES);
  }
  const throwing: NativeVersionCommandRunner = async () => { throw new Error("boom"); };
  assert.deepEqual(await probeCodexCallbackCompatibility({ file: "/f", env: {}, cwd: "/w", runner: throwing }),
    { compatibility: "declined", reason: "version-unavailable" });
});

test("the manager-side receipt reader accepts only a verified supported version", () => {
  assert.equal(readCodexCallbackCompatibilityVersion({ codexCallbackCompatibility: { compatibility: "verified", version: SUPPORTED } }), SUPPORTED);
  for (const descriptor of [
    undefined, null, {}, { codexCallbackCompatibility: null },
    { codexCallbackCompatibility: { compatibility: "verified", version: "0.170.0" } },
    { codexCallbackCompatibility: { compatibility: "declined", reason: "version-unsupported" } },
    { codexCallbackCompatibility: { compatibility: "verified" } },
    { codexCallbackCompatibility: { compatibility: true, version: SUPPORTED } },
  ]) {
    assert.equal(readCodexCallbackCompatibilityVersion(descriptor), undefined, JSON.stringify(descriptor));
  }
});

test("an owned default Codex launch with a prepared backend MCP relay probes its exact file once", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "codex"));
    const { runner, calls } = syntheticRunner(completed(`codex-cli ${SUPPORTED}\n`));
    const launcher = launcherFor(runner);

    // No request: no probe and no field.
    const plain = await launcher("codex", { workspace, env: { PATH: bin } });
    assert.equal("codexCallbackCompatibility" in plain, false);
    assert.equal(calls.length, 0);

    // No MCP option: declined without probing.
    const noMcp = await launcher("codex", { workspace, env: { PATH: bin }, codexCallbackCompatibility: true });
    assert.equal(declined(noMcp.codexCallbackCompatibility), "native-mcp-not-prepared");
    assert.equal(calls.length, 0);

    const prepared = await launcher("codex", { workspace, env: { PATH: bin }, nativeMcp: mcpOptionFor("codex"), codexCallbackCompatibility: true });
    try {
      assert.equal(prepared.nativeMcp?.mcp, "prepared", JSON.stringify(prepared.nativeMcp));
      assert.ok(prepared.ownedCodex, "an owned plan exists");
      assert.deepEqual(prepared.codexCallbackCompatibility, { compatibility: "verified", version: SUPPORTED });
    } finally {
      await releaseMcp(prepared.nativeMcp);
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.file, await realpath(join(bin, "codex")), "the exact canonical executable");
    assert.deepEqual(calls[0]!.args, ["--version"]);
    assert.equal(calls[0]!.options.cwd, workspace);
  });
});

test("ineligible Codex requests are declined without running anything", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "codex"));
    await fakeExecutable(join(bin, "claude"));
    await fakeExecutable(join(bin, "codex-wrapper"));
    const { runner, calls } = syntheticRunner(completed(`codex-cli ${SUPPORTED}\n`));

    // A non-owned launcher has no owned backend to write to.
    const ordinary = await createNativeCliLauncher(configWith({}), { platform: "linux", codexVersionCommandRunner: runner })(
      "codex", { workspace, env: { PATH: bin }, codexCallbackCompatibility: true },
    );
    assert.equal(declined(ordinary.codexCallbackCompatibility), "not-owned-backend");

    // A Claude launch asking for Codex evidence.
    const claude = await launcherFor(runner)("claude", { workspace, env: { PATH: bin }, codexCallbackCompatibility: true });
    assert.equal(declined(claude.codexCallbackCompatibility), "not-codex-backend");

    // Another platform.
    const darwin = await launcherFor(runner, { platform: "darwin" })("codex", {
      workspace, env: { PATH: bin }, codexCallbackCompatibility: true,
    });
    assert.equal(declined(darwin.codexCallbackCompatibility), "unsupported-platform");

    // A configured command/wrapper target never probes, even for the very same
    // file and even with a prepared backend MCP relay.
    const configured = configWith({ wrapper: { adapter: "codex-cli", command: join(bin, "codex"), review: {} } });
    const external = await launcherFor(runner, {}, configured)("codex", {
      workspace, env: { PATH: bin }, targetId: "external:wrapper", nativeMcp: mcpOptionFor("codex"), codexCallbackCompatibility: true,
    });
    try {
      assert.equal(declined(external.codexCallbackCompatibility), "not-default-target");
    } finally {
      await releaseMcp(external.nativeMcp);
    }

    // A declined request changes nothing else.
    const plain = await launcherFor(runner)("codex", { workspace, env: { PATH: bin } });
    const noMcp = await launcherFor(runner)("codex", { workspace, env: { PATH: bin }, codexCallbackCompatibility: true });
    const { codexCallbackCompatibility: _ignored, ...rest } = noMcp;
    assert.equal(JSON.stringify(rest), JSON.stringify(plain));
    assert.equal(calls.length, 0, "nothing ran");
  });
});

test("#682: only a fully eligible launch on an unsupported platform carries the handshake-eligible marker; reasons are unchanged", async () => {
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "codex"));
    // The npm layout: a Windows bare name selects only the native PATHEXT
    // candidate, never the extensionless shell shim beside it (#682/#756).
    await fakeExecutable(join(bin, "codex.exe"));
    const { runner, calls } = syntheticRunner(completed(`codex-cli ${SUPPORTED}\n`));
    for (const platform of ["win32", "darwin"] as const) {
      // Owned default target with the backend MCP relay prepared: platform-only decline, marked.
      const eligible = await launcherFor(runner, { platform })("codex", {
        workspace, env: { PATH: bin }, nativeMcp: mcpOptionFor("codex"), codexCallbackCompatibility: true,
      });
      try {
        // The marker follows the launch's OWN prepared relay: injected win32 on a
        // non-Windows host cannot prove Windows artifact protection, so its relay
        // is unavailable and the decline stays bare (fail closed).
        const prepared = eligible.nativeMcp?.mcp === "prepared";
        if (platform === "darwin") assert.equal(prepared, true, "the darwin relay prepares on this host");
        if (platform === "win32" && process.platform !== "win32") assert.equal(prepared, false);
        assert.deepEqual(eligible.codexCallbackCompatibility, prepared
          ? { compatibility: "declined", reason: "unsupported-platform", handshakeEligible: true }
          : { compatibility: "declined", reason: "unsupported-platform" }, platform);
        assert.ok(Object.isFrozen(eligible.codexCallbackCompatibility));
      } finally {
        await releaseMcp(eligible.nativeMcp);
      }

      // A configured command/wrapper target with the very same file and a prepared relay: bare code.
      const configured = configWith({ wrapper: { adapter: "codex-cli", command: join(bin, "codex"), review: {} } });
      const external = await launcherFor(runner, { platform }, configured)("codex", {
        workspace, env: { PATH: bin }, targetId: "external:wrapper", nativeMcp: mcpOptionFor("codex"), codexCallbackCompatibility: true,
      });
      try {
        assert.deepEqual(external.codexCallbackCompatibility, { compatibility: "declined", reason: "unsupported-platform" }, platform);
      } finally {
        await releaseMcp(external.nativeMcp);
      }

      // No prepared relay, or no owned backend: bare code.
      const noMcp = await launcherFor(runner, { platform })("codex", { workspace, env: { PATH: bin }, codexCallbackCompatibility: true });
      assert.deepEqual(noMcp.codexCallbackCompatibility, { compatibility: "declined", reason: "unsupported-platform" });
      const notOwned = await launcherFor(runner, { platform, ownedCodexBackend: false })("codex", {
        workspace, env: { PATH: bin }, codexCallbackCompatibility: true,
      });
      assert.deepEqual(notOwned.codexCallbackCompatibility, { compatibility: "declined", reason: "unsupported-platform" });
    }
    // On Linux the same configured target keeps its existing reason and never carries the marker.
    const configured = configWith({ wrapper: { adapter: "codex-cli", command: join(bin, "codex"), review: {} } });
    const linuxExternal = await launcherFor(runner, {}, configured)("codex", {
      workspace, env: { PATH: bin }, targetId: "external:wrapper", nativeMcp: mcpOptionFor("codex"), codexCallbackCompatibility: true,
    });
    try {
      assert.deepEqual(linuxExternal.codexCallbackCompatibility, { compatibility: "declined", reason: "not-default-target" });
    } finally {
      await releaseMcp(linuxExternal.nativeMcp);
    }
    assert.equal(calls.length, 0, "nothing ran");
  });
});

test("#682: the owner-side platform-only reader requires the launcher's marker", () => {
  assert.equal(isCodexCallbackPlatformDeclined({ codexCallbackCompatibility: declineCodexCallbackCompatibilityForPlatformOnly() }), true);
  for (const outcome of [
    { compatibility: "declined", reason: "unsupported-platform" },
    { compatibility: "declined", reason: "unsupported-platform", handshakeEligible: "true" },
    { compatibility: "declined", reason: "not-default-target", handshakeEligible: true },
    { compatibility: "verified", version: SUPPORTED, handshakeEligible: true },
    null,
    "unsupported-platform",
  ]) {
    assert.equal(isCodexCallbackPlatformDeclined({ codexCallbackCompatibility: outcome }), false, JSON.stringify(outcome));
  }
  assert.equal(isCodexCallbackPlatformDeclined(null), false);
});

test("a malformed request or runner option is refused before any work", async () => {
  assert.throws(
    () => createNativeCliLauncher(configWith({}), { codexVersionCommandRunner: "probe" as unknown as NativeVersionCommandRunner }),
    /Codex version command runner launcher option must be a function or absent/u,
  );
  await fixture(async (_root, bin, workspace) => {
    await fakeExecutable(join(bin, "codex"));
    const { runner, calls } = syntheticRunner(completed(`codex-cli ${SUPPORTED}\n`));
    await assert.rejects(
      launcherFor(runner)("codex", { workspace, env: { PATH: bin }, codexCallbackCompatibility: "yes" as unknown as boolean }),
      /Codex callback compatibility request must be a boolean or absent/u,
    );
    assert.equal(calls.length, 0);
  });
});

test("the real bounded runner verifies a supported answer and declines another", linuxOnly, async () => {
  await fixture(async (_root, bin, workspace) => {
    await script(join(bin, "codex"), [
      `if [ "$1" = "--version" ] && [ "$#" -eq 1 ]; then echo "codex-cli ${SUPPORTED}"; exit 0; fi`,
      "exit 9",
    ].join("\n"));
    assert.deepEqual(
      await probeCodexCallbackCompatibility({ file: join(bin, "codex"), env: { PATH: bin }, cwd: workspace }),
      { compatibility: "verified", version: SUPPORTED },
    );
    await script(join(bin, "old-codex"), `echo "codex-cli 0.1.0"`);
    assert.deepEqual(
      await probeCodexCallbackCompatibility({ file: join(bin, "old-codex"), env: { PATH: bin }, cwd: workspace }),
      { compatibility: "declined", reason: "version-unsupported" },
    );
  });
});

test("a root-free discovery proof admits only a supported version for exactly the expected relay generation", () => {
  const supported = CODEX_CALLBACK_SUPPORTED_CLI_VERSIONS[0]!;
  const expected = { runId: "generation-1" };
  assert.deepEqual(readCodexBackendDiscoveryVersion({ version: supported, runId: "generation-1" }, expected),
    { version: supported, runId: "generation-1" });
  for (const proof of [
    null,
    undefined,
    "0.171.0",
    {},
    { version: supported },
    { runId: "generation-1" },
    { version: supported, runId: "" },
    { version: supported, runId: "generation-0" },
    { version: "0.170.0", runId: "generation-1" },
    { version: `${supported}-alpha.1`, runId: "generation-1" },
    { version: 171, runId: "generation-1" },
    { version: supported, runId: 1 },
  ]) {
    assert.equal(readCodexBackendDiscoveryVersion(proof, expected), undefined, JSON.stringify(proof));
  }
  const throwing = Object.defineProperty({}, "version", { get() { throw new Error("hostile"); } });
  assert.equal(readCodexBackendDiscoveryVersion(throwing, expected), undefined);
  // A root-free proof never satisfies the root-bound call/delivery reader.
  assert.equal(readCodexBackendHandshakeVersion({ version: supported, runId: "generation-1" }, { threadId: "thread-a" }), undefined);
});
