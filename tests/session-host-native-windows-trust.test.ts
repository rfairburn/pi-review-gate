import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createNativeAgentRoot,
  createOwnedDirectory,
  denyAmbientNativeProjectTrust,
  ownedNativeSettings,
} from "./helpers/session-host-native-windows-harness";

test("the synthetic native agent settings deny ambient project resources instead of trusting them", () => {
  // Pi's resolveProjectTrusted returns false for defaultProjectTrust "never"
  // without showing the interactive trust prompt, so the harness neither trusts
  // nor loads the real user's ambient `.agents/skills` project resources.
  assert.deepEqual(ownedNativeSettings(), { defaultProjectTrust: "never" });
  assert.equal(Object.hasOwn(ownedNativeSettings(), "defaultProjectTrust"), true);
});

test("the synthetic native agent trust boundary is written exactly once into a task-created agent root", () => {
  const root = createOwnedDirectory(realpathSync(tmpdir()), `prg-trust-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  try {
    const agentDir = createNativeAgentRoot(root);
    denyAmbientNativeProjectTrust(agentDir);
    const written: unknown = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(written, ownedNativeSettings());
    assert.throws(() => denyAmbientNativeProjectTrust(agentDir), /EEXIST/,
      "an existing settings file is never overwritten");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the synthetic native agent trust boundary refuses an unowned directory", () => {
  const root = createOwnedDirectory(realpathSync(tmpdir()), `prg-trust-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
  try {
    const unowned = join(root, "not-registered");
    mkdirSync(unowned);
    assert.throws(() => denyAmbientNativeProjectTrust(unowned), /task-created directory identity/,
      "an unregistered directory is never given the synthetic trust policy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
