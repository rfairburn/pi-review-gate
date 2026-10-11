import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { isKittyProtocolActive, matchesKey, setKittyProtocolActive } from "pi-session-host-tui";

import {
  assertHostShortcutsDistinct,
  DEFAULT_HOST_SHORTCUTS,
  normalizeHostShortcutBindings,
  normalizeHostShortcutKey,
  parseHostShortcutConfig,
} from "../src/session-host/host-shortcuts";
import {
  hostShortcutsPath,
  readHostShortcutConfig,
  writeHostShortcutConfig,
} from "../src/session-host/host-shortcuts-store";

const TEST_ROOT = join(process.cwd(), "node_modules", ".cache", "session-host-shortcuts-tests");

function agentDirectory(): string {
  mkdirSync(TEST_ROOT, { recursive: true });
  return mkdtempSync(join(TEST_ROOT, "agent-"));
}

test("host shortcut schema uses defaults for omitted actions and canonicalizes supported chords", () => {
  assert.deepEqual(parseHostShortcutConfig({ version: 1 }), DEFAULT_HOST_SHORTCUTS);
  assert.deepEqual(parseHostShortcutConfig({ version: 1, toggle: "SUPER+ALT+LEFT", returnToMain: "CTRL+SHIFT+F" }), {
    toggle: "alt+super+left",
    returnToMain: "ctrl+shift+f",
  });
  assert.equal(normalizeHostShortcutKey("SHIFT+CTRL+PAGEUP", "toggle"), "ctrl+shift+pageUp");
  assert.equal(normalizeHostShortcutKey("shift+left", "toggle"), "shift+left");
  assert.deepEqual(normalizeHostShortcutBindings({ toggle: "ctrl+left", returnToMain: "f12" }), {
    toggle: "ctrl+left",
    returnToMain: "f12",
  });
});

test("host shortcut validation rejects typing, plain navigation, protected keys, and unmatchable specials", () => {
  for (const key of [
    "a", "9", "!", "shift+a", "shift+1", "left", "up", "pageDown", "enter", "return", "space",
    "ctrl+enter", "ctrl+space", "escape", "alt+esc", "ctrl+[", "ctrl+c", "q", "shift+q", "ctrl+f8",
    "ctrl+clear", "bogus", "ctrl+left+alt", "ctrl+ctrl+a", "ctrl+alt+", "super+delete",
  ]) {
    assert.throws(() => normalizeHostShortcutKey(key, "toggle"), /./, `expected rejection for ${key}`);
  }
  for (const [toggle, returnToMain] of [
    ["CTRL+ALT+LEFT", "alt+ctrl+left"],
    ["ctrl+pageup", "CTRL+PAGEUP"],
    ["ctrl+-", "ctrl+_"],
    ["ctrl+alt+-", "ctrl+alt+_"],
    ["alt+b", "alt+left"],
    ["alt+f", "alt+right"],
    ["alt+p", "alt+up"],
    ["alt+n", "alt+down"],
  ]) {
    assert.throws(() => assertHostShortcutsDistinct(toggle, returnToMain), /different shortcut chords/);
  }
  assert.throws(() => parseHostShortcutConfig({ version: 1, toggle: "ctrl+-", returnToMain: "ctrl+_" }), /different shortcut chords/);
  assert.throws(() => parseHostShortcutConfig({ version: 1, toggle: "ctrl+alt+-", returnToMain: "ctrl+alt+_" }), /different shortcut chords/);
  assert.throws(() => parseHostShortcutConfig({ version: 1, toggle: "alt+f", returnToMain: "alt+right" }), /different shortcut chords/);
  assert.throws(() => parseHostShortcutConfig({ version: 1, toggle: "f8", extra: true }), /unknown property/);
  assert.throws(() => parseHostShortcutConfig({ version: 2 }), /version 1/);
});

test("pinned matcher aliases make otherwise distinct spellings overlapping host chords", () => {
  assert.equal(matchesKey("\x1f", "ctrl+-"), true);
  assert.equal(matchesKey("\x1f", "ctrl+_"), true);
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(false);
  try {
    for (const [packet, printableChord, navigationChord] of [
      ["\x1bb", "alt+b", "alt+left"],
      ["\x1bf", "alt+f", "alt+right"],
      ["\x1bp", "alt+p", "alt+up"],
      ["\x1bn", "alt+n", "alt+down"],
    ] as const) {
      assert.equal(matchesKey(packet, printableChord), true);
      assert.equal(matchesKey(packet, navigationChord), true);
    }
    assert.equal(matchesKey("\x1b\x1f", "ctrl+alt+-"), true);
    assert.equal(matchesKey("\x1b\x1f", "ctrl+alt+_"), true);
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("ordinary Enter packets cannot be reserved through Ctrl-letter aliases", () => {
  const previous = isKittyProtocolActive();
  setKittyProtocolActive(false);
  try {
    for (const [packet, chord] of [["\r", "ctrl+m"], ["\n", "ctrl+j"]] as const) {
      assert.equal(matchesKey(packet, chord), true);
      assert.throws(() => normalizeHostShortcutKey(chord, "toggle"), /native Enter/);
      assert.throws(() => parseHostShortcutConfig({ version: 1, toggle: chord, returnToMain: "f9" }), /native Enter/);
      assert.throws(() => parseHostShortcutConfig({ version: 1, toggle: "f8", returnToMain: chord }), /native Enter/);
    }
    assert.equal(normalizeHostShortcutKey("ctrl+shift+m", "toggle"), "ctrl+shift+m");
    assert.equal(normalizeHostShortcutKey("ctrl+shift+j", "returnToMain"), "ctrl+shift+j");
  } finally {
    setKittyProtocolActive(previous);
  }
});

test("shift-only navigation is supported by the pinned matcher", () => {
  assert.equal(matchesKey("\x1b[d", "shift+left"), true);
  assert.equal(normalizeHostShortcutKey("shift+home", "returnToMain"), "shift+home");
});

test("missing host shortcut file selects defaults without creating the file; save is atomic and reloadable", () => {
  const agentDir = agentDirectory();
  try {
    const missing = readHostShortcutConfig(agentDir);
    assert.deepEqual(missing, { status: "absent", bindings: DEFAULT_HOST_SHORTCUTS });
    const path = hostShortcutsPath(agentDir);
    assert.equal(existsSync(path), false);

    const saved = writeHostShortcutConfig(agentDir, { toggle: "f8", returnToMain: "f9" });
    assert.deepEqual(saved, { toggle: "f8", returnToMain: "f9" });
    assert.deepEqual(readHostShortcutConfig(agentDir), { status: "loaded", bindings: saved });
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
      version: 1,
      toggle: "f8",
      returnToMain: "f9",
    });
    if (process.platform !== "win32") assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(agentDir, "session-host")).filter((entry) => entry.includes(".tmp.")), []);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("invalid existing host shortcut JSON is refused and preserved; legacy override cannot create a conflicting save", () => {
  const agentDir = agentDirectory();
  try {
    const dir = join(agentDir, "session-host");
    mkdirSync(dir);
    const path = hostShortcutsPath(agentDir);
    const original = '{"version":1,"toggle":"f8","returnToMain":"f8"}\n';
    writeFileSync(path, original, "utf8");
    const result = readHostShortcutConfig(agentDir);
    assert.equal(result.status, "unavailable");
    if (result.status === "unavailable") {
      assert.match(result.message, /left untouched/);
      assert.match(result.message, /different shortcut chords/);
    }
    assert.equal(readFileSync(path, "utf8"), original);

    rmSync(path);
    for (const [returnToMain, legacyToggle] of [
      ["ctrl+_", "ctrl+-"],
      ["ctrl+alt+_", "ctrl+alt+-"],
      ["alt+right", "alt+f"],
    ] as const) {
      assert.throws(
        () => writeHostShortcutConfig(agentDir, { toggle: "f9", returnToMain }, legacyToggle),
        /different shortcut chords/,
      );
      assert.equal(existsSync(path), false, "a matcher-overlapping effective pair is never persisted");
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("unsafe symlinked host shortcut file is neither followed nor replaced", { skip: process.platform === "win32" }, () => {
  const agentDir = agentDirectory();
  try {
    const dir = join(agentDir, "session-host");
    mkdirSync(dir);
    const target = join(agentDir, "outside.json");
    writeFileSync(target, '{"version":1}\n', "utf8");
    const path = hostShortcutsPath(agentDir);
    symlinkSync(target, path);

    const result = readHostShortcutConfig(agentDir);
    assert.equal(result.status, "unavailable");
    assert.equal(readFileSync(target, "utf8"), '{"version":1}\n');
    assert.throws(() => writeHostShortcutConfig(agentDir, { toggle: "f8", returnToMain: "f9" }), /not a regular file/);
    assert.equal(lstatSync(path).isSymbolicLink(), true);
    assert.equal(readFileSync(target, "utf8"), '{"version":1}\n');
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
