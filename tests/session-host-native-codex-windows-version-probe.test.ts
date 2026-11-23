import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { normalizeConfig } from "../src/config";
import type { NativeVersionCommandRunner } from "../src/session-host/native-claude-version-probe";
import { createNativeCliLauncher } from "../src/session-host/native-cli-launch";
import { CODEX_CALLBACK_SUPPORTED_PLATFORMS } from "../src/session-host/native-codex-version-probe";

/**
 * #682: Windows Codex callback compatibility stays declined before any probe.
 *
 * Callback compatibility needs a bounded version probe whose process tree is
 * provably settled. Windows has no such probe yet: the shared bounded runner is
 * Linux-only, and the existing Windows process-tree authority
 * (`terminateProcessTree`, `taskkill /T /F`) cannot prove exit for a helper
 * that outlives its parent, nor bound a blocking process creation. These cases
 * pin the fail-closed decline so a future Windows probe must land together
 * with real Windows evidence. They are hermetic: the platform is injected, the
 * runner is a recording stub that must never be called, and no Codex binary,
 * provider configuration, or credential is touched. The tiny fixture tree is
 * removed in `finally`.
 */

test("Windows is not an enabled Codex callback platform", () => {
  assert.deepEqual([...CODEX_CALLBACK_SUPPORTED_PLATFORMS], ["linux"]);
  assert.equal(CODEX_CALLBACK_SUPPORTED_PLATFORMS.includes("win32"), false);
});

test("a Windows owned Codex launch requesting callback compatibility is declined without probing", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-codex-windows-version-probe-")));
  try {
    const bin = join(root, "bin");
    const workspace = join(root, "workspace");
    await mkdir(bin, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(bin, "codex"), "#!/bin/sh\necho never invoked; exit 3\n");
    await chmod(join(bin, "codex"), 0o755);
    const calls: string[] = [];
    const runner: NativeVersionCommandRunner = async (file) => {
      calls.push(file);
      return { kind: "completed", stdout: "codex-cli 0.171.0\n" };
    };
    const launcher = createNativeCliLauncher(normalizeConfig({ enabled: true, externalAgents: {} }), {
      platform: "win32",
      ownedCodexBackend: true,
      codexVersionCommandRunner: runner,
    });
    const descriptor = await launcher("codex", { workspace, env: { PATH: bin }, codexCallbackCompatibility: true });
    assert.deepEqual(descriptor.codexCallbackCompatibility, { compatibility: "declined", reason: "unsupported-platform" });
    assert.equal(calls.length, 0, "no version probe ran");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
