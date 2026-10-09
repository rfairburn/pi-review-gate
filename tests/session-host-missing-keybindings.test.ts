import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { loadNativeFieldKeybindings } from "../src/session-host/form-support";

/**
 * Focused retention-safe regressions for the silent missing-keybindings fallback.
 * Every fixture is a genuine, exclusively created regular file or directory under
 * this confined cache root, and every output is retained as a witness: this file
 * performs no unlink/rm/cleanup and no platform skips.
 */
const MISSING_KEYBINDINGS_TEST_ROOT = join(process.cwd(), "node_modules", ".cache", "session-host-missing-keybindings-tests");

function makeConfinedDirectory(): string {
  mkdirSync(MISSING_KEYBINDINGS_TEST_ROOT, { recursive: true });
  return mkdtempSync(join(MISSING_KEYBINDINGS_TEST_ROOT, "missing-keybindings-"));
}

function assertRealDefaultBindings(manager: { matches: (data: string, action: string) => boolean }, label: string): void {
  assert.equal(manager.matches("\x03", "app.clear"), true, `${label}: app.clear keeps its real Ctrl+C default`);
  assert.equal(manager.matches("\x1b", "app.interrupt"), true, `${label}: app.interrupt keeps its real Escape default`);
  assert.equal(manager.matches("\x07", "app.editor.external"), true, `${label}: app.editor.external keeps its real Ctrl+G default`);
  assert.equal(manager.matches("\r", "tui.input.submit"), true, `${label}: native submit keeps its real Enter default`);
}

test("missing native keybindings file falls back silently to the real Pi defaults without creating a file", () => {
  const root = makeConfinedDirectory();
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const result = loadNativeFieldKeybindings(agentDir);
  assert.equal(result.notice, undefined, "a missing optional keybindings file is silent");
  assertRealDefaultBindings(result.manager, "missing file");
  let createdFile = false;
  try {
    lstatSync(join(agentDir, "keybindings.json"));
    createdFile = true;
  } catch {
    // The expected ENOENT proves the silent fallback did not create the user's file.
  }
  assert.equal(createdFile, false, "the silent fallback never creates the user's keybindings file");
});

test("missing native agent directory falls back silently to the real Pi defaults", () => {
  const root = makeConfinedDirectory();
  const result = loadNativeFieldKeybindings(join(root, "no-such-agent"));
  assert.equal(result.notice, undefined, "a missing agent directory is silent too");
  assertRealDefaultBindings(result.manager, "missing agent directory");
});

test("configured native keybindings apply without a notice", () => {
  const root = makeConfinedDirectory();
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const path = join(agentDir, "keybindings.json");
  const contents = `\uFEFF${JSON.stringify({
    "tui.input.submit": "f5",
    "app.clear": "ctrl+l",
    "app.interrupt": "ctrl+x",
    "app.editor.external": "ctrl+t",
  })}`;
  writeFileSync(path, contents, "utf8");
  const result = loadNativeFieldKeybindings(agentDir);
  assert.equal(result.notice, undefined, "a valid configured file is silent");
  assert.equal(result.manager.matches("\x1b[15~", "tui.input.submit"), true, "configured submit binding applies");
  assert.equal(result.manager.matches("\r", "tui.input.submit"), false, "configured submit replaces the default");
  assert.equal(result.manager.matches("\x0c", "app.clear"), true, "configured clear binding applies");
  assert.equal(result.manager.matches("\x03", "app.clear"), false, "configured clear replaces the default");
  assert.equal(result.manager.matches("\x18", "app.interrupt"), true, "configured interrupt binding applies");
  assert.equal(result.manager.matches("\x1b", "app.interrupt"), false, "configured interrupt replaces the default");
  assert.equal(result.manager.matches("\x14", "app.editor.external"), true, "configured external-editor binding applies");
  assert.equal(result.manager.matches("\x07", "app.editor.external"), false, "configured external-editor replaces the default");
  assert.equal(readFileSync(path, "utf8"), contents, "the configured file bytes are never rewritten");
});

test("malformed or non-object native keybindings keep the unsupported-format fail-safe notice", (t) => {
  const runCase = (label: string, contents: string): void => {
    const root = makeConfinedDirectory();
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const path = join(agentDir, "keybindings.json");
    writeFileSync(path, contents, "utf8");
    const result = loadNativeFieldKeybindings(agentDir);
    assert.match(result.notice ?? "", /unsupported format/, `${label}: the fail-safe notice is retained`);
    assertRealDefaultBindings(result.manager, label);
    assert.equal(readFileSync(path, "utf8"), contents, `${label}: the malformed file bytes are never rewritten`);
  };
  t.test("invalid JSON keeps the fail-safe notice", () => runCase("invalid JSON", "{invalid json"));
  t.test("non-object JSON keeps the fail-safe notice", () => runCase("non-object JSON", JSON.stringify(["app.clear"])));
});

test("oversized native keybindings keep the unavailable fail-safe notice without being read past the bound", () => {
  const root = makeConfinedDirectory();
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const path = join(agentDir, "keybindings.json");
  const oversized = Buffer.alloc(256 * 1024 + 1, 0x20);
  writeFileSync(path, oversized);
  const result = loadNativeFieldKeybindings(agentDir);
  assert.match(result.notice ?? "", /unavailable/, "the unavailable notice is retained");
  assertRealDefaultBindings(result.manager, "oversized file");
  assert.deepEqual(readFileSync(path), oversized, "the oversized file bytes are never rewritten");
});
