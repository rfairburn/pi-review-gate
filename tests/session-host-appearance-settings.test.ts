/**
 * #613 acceptance: the session host's OWN sidebar appearance (Dark/Light) and
 * the single grouped Settings entry point.
 *
 * Everything is proven through the seams the product actually uses: the real
 * per-native-agent session-host state directory, real `main.ts` startup and
 * action handling over a fake terminal, and the frames Main actually wrote.
 * Nothing here reads or changes Pi's own theme, configuration, or keybindings.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { ComposedHostFrame } from "../src/session-host/compositor";
import {
  APPEARANCE_FILENAME,
  appearancePath,
  readAppearanceConfig,
  writeAppearanceConfig,
} from "../src/session-host/appearance-store";
import { SIDEBAR_GENERATED_SGR_ALLOWLIST } from "../src/session-host/sidebar";
import {
  DEFAULT_SIDEBAR_THEME,
  SIDEBAR_THEME_IDS,
  SIDEBAR_THEME_SGR_CODES,
  sidebarPaletteFor,
} from "../src/session-host/sidebar-theme";
import {
  ALT_LEFT,
  ENTER,
  ESC,
  type Harness,
  type MainTestDependencies,
  closeWithSignal,
  createHarness,
  makeMainTestDirectory,
  nextTurn,
  peerMainHarness,
  plain,
  ready,
} from "./helpers/session-host-main-harness";

const DOWN = "\x1b[B";
const SGR = /\x1b\[([0-9;]*)m/g;

/** A synthetic native agent directory, exactly as Main sees one. */
function ownedAgentDir(): string {
  const dir = makeMainTestDirectory("appearance-agent");
  writeFileSync(join(dir, "keybindings.json"), "{}", "utf8");
  return dir;
}

/** One real Main run over `agentDir`, with only the requested seams replaced. */
function appearanceMain(agentDir: string, extra: MainTestDependencies = {}): Harness {
  return createHarness({}, {
    createSessionSetup: () => ({
      nativeSetup: true,
      nativeAgentDir: agentDir,
      profileRegistry: {
        prepare: () => { throw new Error("the synthetic harness prepares no profile"); },
      },
    }),
    openHostState: ({ agentDir: ownedDir, hostId }) => ({
      status: "opened",
      state: {
        agentDir: ownedDir,
        hostId,
        ownershipPath: join(ownedDir, "synthetic-owner"),
        roster: undefined,
        problem: undefined,
        persist: () => true,
        release: () => true,
      },
    }),
    ...extra,
  });
}

function lastFrame(harness: Harness): ComposedHostFrame | undefined {
  return harness.writer.frames.at(-1)?.frame;
}

function frameText(harness: Harness): string {
  return plain(lastFrame(harness));
}

function rawFrameText(harness: Harness): string {
  return lastFrame(harness)?.lines.join("\n") ?? "";
}

function sgrCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(SGR)) codes.add(match[1] ?? "");
  return codes;
}

/** The attribute-only sequences the renderer owns: resets, bold, inverse. */
const ATTRIBUTE_SGR_CODES: ReadonlySet<string> = new Set<string>(["", "0", "1", "7", "27", "1;7"]);

/**
 * The closed-set rule for one generated sequence: it is either an attribute the
 * renderer owns or one of the exact palette parameter strings. An arbitrary RGB
 * triple, a 256-color index, or a background selector is refused even though it
 * is valid SGR syntax.
 */
function assertClosedSgr(code: string, where: string): void {
  assert.ok(
    SIDEBAR_THEME_SGR_CODES.has(code) || ATTRIBUTE_SGR_CODES.has(code),
    `${where}: ${JSON.stringify(code)} is outside the closed generated set`,
  );
}

/**
 * Pi's own chat viewport has no whole-pane canvas. Both host appearances keep
 * their explicit foreground but must leave the background on the terminal
 * default, never paint a forced black (`40`) or white (`47`) ground.
 */
function assertTerminalDefaultGround(text: string, theme: "dark" | "light"): void {
  const palette = sidebarPaletteFor(theme);
  assert.match(palette.canvas, /^[0-9;]+;49$/, `${theme}: the canvas resets the background to terminal default`);
  assert.ok(text.includes(`\x1b[${palette.canvas}m`),
    `${theme}: written host rows carry the appearance's foreground/default ground`);
  assert.equal(text.includes("\x1b[40m"), false, `${theme}: no forced black whole-pane background`);
  assert.equal(text.includes("\x1b[47m"), false, `${theme}: no forced white whole-pane background`);
}

/** True when the LAST written frame draws `label` as its highlighted row. */
function highlighted(harness: Harness, label: string): boolean {
  return frameText(harness).split("\n").some((line) => line.includes(`> ${label}`));
}

async function moveTo(harness: Harness, label: string): Promise<void> {
  for (let step = 0; step <= 8; step += 1) {
    if (highlighted(harness, label)) return;
    harness.terminal.emitInput(DOWN);
    await nextTurn();
  }
  assert.fail(`the written host never highlighted a ${JSON.stringify(label)} row:\n${frameText(harness)}`);
}

/** roster -> the ONE grouped Settings row -> Enter. */
async function openSettingsMenu(harness: Harness): Promise<void> {
  await moveTo(harness, "Settings");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.ok(highlighted(harness, "Theme"),
    `the grouped Settings submenu did not open with Theme first:\n${frameText(harness)}`);
}

/** Settings submenu -> one of its entries -> Enter. */
async function openSettingsEntry(harness: Harness, label: string): Promise<void> {
  await moveTo(harness, label);
  harness.terminal.emitInput(ENTER);
  await nextTurn();
}

// ---------------------------------------------------------------------------
// The host's own appearance file
// ---------------------------------------------------------------------------

test("the appearance file is absent by default and reading it never creates it", () => {
  const agentDir = ownedAgentDir();
  try {
    const read = readAppearanceConfig(agentDir);
    assert.equal(read.status, "absent");
    assert.equal(read.appearance.theme, DEFAULT_SIDEBAR_THEME);
    assert.equal(existsSync(appearancePath(agentDir)), false,
      "the default is selected without writing a file");
    assert.equal(existsSync(join(agentDir, "session-host", `${APPEARANCE_FILENAME}.tmp`)), false);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a saved appearance round-trips through the host-owned file and reloads cleanly", () => {
  const agentDir = ownedAgentDir();
  try {
    for (const theme of SIDEBAR_THEME_IDS) {
      const saved = writeAppearanceConfig(agentDir, { theme });
      assert.deepEqual(saved, { theme });
      assert.equal(readFileSync(appearancePath(agentDir), "utf8"), `${JSON.stringify({ version: 1, theme })}\n`,
        "the record is the strict versioned shape");
      const read = readAppearanceConfig(agentDir);
      assert.equal(read.status, "loaded");
      assert.equal(read.appearance.theme, theme, "a later read sees exactly what was saved");
      assert.deepEqual(readdirSync(join(agentDir, "session-host")).filter((name) => name.includes(".tmp.")), [],
        "the atomic save leaves no temporary entry behind");
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("malformed, oversized, schema-invalid, and unsafe appearance files refuse without touching the file", () => {
  const cases: readonly { readonly name: string; readonly body: string }[] = [
    { name: "malformed JSON", body: "{ version: 1," },
    { name: "wrong version", body: '{"version":2,"theme":"light"}\n' },
    { name: "unknown theme", body: '{"version":1,"theme":"neon"}\n' },
    { name: "missing theme", body: '{"version":1}\n' },
    { name: "unknown property", body: '{"version":1,"theme":"light","piTheme":"dracula"}\n' },
    { name: "not an object", body: '["light"]\n' },
  ];
  for (const testCase of cases) {
    const agentDir = ownedAgentDir();
    try {
      // Reading first is what creates the host state directory, exactly as a
      // real startup does; the refusal cases then replace the file's contents.
      assert.equal(readAppearanceConfig(agentDir).status, "absent");
      writeFileSync(appearancePath(agentDir), testCase.body, "utf8");
      const read = readAppearanceConfig(agentDir);
      assert.equal(read.status, "unavailable", `${testCase.name} must refuse`);
      assert.ok(read.message.startsWith("Session host refused:"), read.message);
      assert.equal(readFileSync(appearancePath(agentDir), "utf8"), testCase.body,
        `${testCase.name}: the refused read never rewrites or removes the file`);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  }

  const oversizedDir = ownedAgentDir();
  try {
    assert.equal(readAppearanceConfig(oversizedDir).status, "absent");
    writeFileSync(appearancePath(oversizedDir), `{"version":1,"theme":"light","pad":"${"x".repeat(8192)}"}\n`);
    const read = readAppearanceConfig(oversizedDir);
    assert.equal(read.status, "unavailable");
    assert.match(read.message, /exceed \d+ bytes/);
  } finally {
    rmSync(oversizedDir, { recursive: true, force: true });
  }

  // A symlinked appearance entry is refused, and neither link nor target moves.
  const unsafeDir = ownedAgentDir();
  try {
    assert.equal(readAppearanceConfig(unsafeDir).status, "absent");
    const target = join(unsafeDir, "someone-elses-file");
    writeFileSync(target, "do not touch", "utf8");
    symlinkSync(target, appearancePath(unsafeDir));
    const read = readAppearanceConfig(unsafeDir);
    assert.equal(read.status, "unavailable");
    assert.match(read.message, /not a regular file/);
    assert.equal(readFileSync(target, "utf8"), "do not touch");
    assert.throws(() => writeAppearanceConfig(unsafeDir, { theme: "light" }), /not a regular file/);
    assert.equal(readFileSync(target, "utf8"), "do not touch",
      "a refused save never replaces the unsafe path");
    assert.deepEqual(readdirSync(unsafeDir).filter((name) => name.includes(".tmp.")), [],
      "the refused save leaves no temporary entry behind");
  } finally {
    rmSync(unsafeDir, { recursive: true, force: true });
  }
});

test("a save refuses to replace an existing record the host could not read", () => {
  const bodies: readonly { readonly name: string; readonly body: string; readonly reason: RegExp }[] = [
    { name: "malformed JSON", body: "{ version: 1,\n", reason: /malformed JSON/ },
    { name: "unknown theme", body: '{"version":1,"theme":"neon"}\n', reason: /invalid/ },
    { name: "missing theme", body: '{"version":1}\n', reason: /invalid/ },
    { name: "wrong version", body: '{"version":2,"theme":"light"}\n', reason: /invalid/ },
    { name: "not an object", body: '"light"\n', reason: /invalid/ },
  ];
  for (const testCase of bodies) {
    const agentDir = ownedAgentDir();
    try {
      assert.equal(readAppearanceConfig(agentDir).status, "absent");
      writeFileSync(appearancePath(agentDir), testCase.body, "utf8");
      assert.throws(() => writeAppearanceConfig(agentDir, { theme: "light" }), testCase.reason,
        `${testCase.name}: the deliberate save must refuse`);
      assert.equal(readFileSync(appearancePath(agentDir), "utf8"), testCase.body,
        `${testCase.name}: the refused save left the operator's file byte-identical`);
      assert.deepEqual(readdirSync(join(agentDir, "session-host")).filter((name) => name.includes(".tmp.")), [],
        `${testCase.name}: the refused save left no temporary entry`);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  }

  // An oversized existing record is refused on its size, before any read of it.
  const oversizedDir = ownedAgentDir();
  try {
    assert.equal(readAppearanceConfig(oversizedDir).status, "absent");
    const oversizedBody = `{"version":1,"theme":"light","pad":"${"x".repeat(8192)}"}\n`;
    writeFileSync(appearancePath(oversizedDir), oversizedBody);
    assert.throws(() => writeAppearanceConfig(oversizedDir, { theme: "dark" }), /exceed \d+ bytes/);
    assert.equal(readFileSync(appearancePath(oversizedDir), "utf8"), oversizedBody,
      "the oversized entry is preserved, not truncated or replaced");
  } finally {
    rmSync(oversizedDir, { recursive: true, force: true });
  }

  // A valid record IS replaceable: the preservation rule is about unreadable
  // settings, not about refusing every later change.
  const validDir = ownedAgentDir();
  try {
    writeAppearanceConfig(validDir, { theme: "dark" });
    writeAppearanceConfig(validDir, { theme: "light" });
    assert.equal(readAppearanceConfig(validDir).status, "loaded");
    assert.equal(readFileSync(appearancePath(validDir), "utf8"), '{"version":1,"theme":"light"}\n');
  } finally {
    rmSync(validDir, { recursive: true, force: true });
  }
});

test("Main keeps an unreadable appearance file after a deliberate theme change attempt", async () => {
  const agentDir = ownedAgentDir();
  assert.equal(readAppearanceConfig(agentDir).status, "absent");
  const broken = '{ "version": 1, theme: "solarized" }';
  writeFileSync(appearancePath(agentDir), broken, "utf8");
  const harness = appearanceMain(agentDir);
  try {
    const manager = await ready(harness);
    assert.equal(harness.sidebar?.currentTheme, DEFAULT_SIDEBAR_THEME,
      "the refused read keeps Dark active and the host running");

    await openSettingsMenu(harness);
    assert.match(frameText(harness), /theme: Dark/);
    await openSettingsEntry(harness, "Theme");
    await moveTo(harness, "Light");
    harness.terminal.emitInput(ENTER);
    await nextTurn();

    assert.equal(harness.sidebar?.currentTheme, DEFAULT_SIDEBAR_THEME,
      "a save that would overwrite the operator's file never applies a palette");
    assert.equal(readFileSync(appearancePath(agentDir), "utf8"), broken,
      "the refused save left the file byte-identical");
    assert.deepEqual(readdirSync(join(agentDir, "session-host")).filter((name) => name.includes(".tmp.")), [],
      "no temporary entry was left behind");
    assert.match(frameText(harness), /existing appearance settings contain/,
      `the save refusal is stated where the operator chose:\n${frameText(harness)}`);
    assert.match(frameText(harness), /the existing file was not replaced/);
    assert.match(frameText(harness), /Dark \(current\)/);
    assert.match(frameText(harness), /Session host refused: appearance settings/,
      "the startup notice is not cleared by the attempt");
    assert.equal(manager.writes.length, 0, "the whole gesture stayed host-owned");
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Startup resolution in real Main
// ---------------------------------------------------------------------------

test("a host with no appearance file starts Dark and writes nothing", async () => {
  const agentDir = ownedAgentDir();
  const harness = appearanceMain(agentDir);
  try {
    await ready(harness);
    assert.equal(harness.sidebar?.currentTheme, DEFAULT_SIDEBAR_THEME);
    assert.equal(existsSync(appearancePath(agentDir)), false,
      "startup selects the default without creating a file");
    const codes = sgrCodes(rawFrameText(harness));
    assert.ok(codes.has(sidebarPaletteFor("dark").header),
      `the written roster carries the dark palette header:\n${frameText(harness)}`);
    assert.equal(codes.has(sidebarPaletteFor("light").selected), false,
      "no light-only sequence appears while Dark is active");
    assertTerminalDefaultGround(rawFrameText(harness), "dark");
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a persisted light appearance is live at startup and every emitted sequence stays allowed", async () => {
  const agentDir = ownedAgentDir();
  writeAppearanceConfig(agentDir, { theme: "light" });
  const harness = appearanceMain(agentDir);
  try {
    await ready(harness);
    assert.equal(harness.sidebar?.currentTheme, "light");
    const codes = sgrCodes(rawFrameText(harness));
    assert.ok(codes.has(sidebarPaletteFor("light").selected),
      "the selected navigation target uses the light palette");
    assert.equal(codes.has(sidebarPaletteFor("dark").header), false,
      "the dark-only header sequence is gone");
    for (const code of codes) {
      assert.ok(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(code), `unexpected generated SGR ${code}`);
      // The set is closed: every colour the pane emits is one of the exact
      // generated Pi foreground parameter strings, never an arbitrary RGB
      // triple, a 256-color index, or a background selector.
      assertClosedSgr(code, "a written light-theme host row");
    }
    for (const refused of ["38;2;255;0;0", "1;38;2;255;0;0", "38;5;39", "44"]) {
      assert.equal(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(refused), false,
        `an unknown RGB or palette colour stays refused: ${refused}`);
    }
    assertTerminalDefaultGround(rawFrameText(harness), "light");
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("an unreadable appearance file never blocks startup: bounded notice and default Dark stay active", async () => {
  const agentDir = ownedAgentDir();
  const message = "Session host refused: appearance settings contain malformed JSON. "
    + "The file was left untouched; fix or move it before restarting.";
  const harness = appearanceMain(agentDir, {
    readAppearanceConfig: () => ({ status: "unavailable", message }),
  });
  try {
    const manager = await ready(harness);
    assert.ok(manager, "a refused appearance read is not a startup failure");
    assert.equal(harness.sidebar?.currentTheme, DEFAULT_SIDEBAR_THEME);
    await openSettingsMenu(harness);
    await openSettingsEntry(harness, "Theme");
    assert.ok(frameText(harness).includes("malformed JSON"),
      `the Theme pane states the bounded refusal:\n${frameText(harness)}`);
    assert.ok(frameText(harness).includes("Dark (current)"),
      "the notice never silently changes the active appearance");
    assert.equal(manager.writes.length, 0, "the notice and the keystrokes stay host-owned");
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Choosing an appearance through the grouped Settings entry
// ---------------------------------------------------------------------------

test("the Theme submenu saves through Main, applies live, and the next host start reloads it", async () => {
  const agentDir = ownedAgentDir();
  const harness = appearanceMain(agentDir);
  try {
    const manager = await ready(harness);
    const writesBefore = manager.writes.length;
    const createsBefore = manager.createOptions.length;
    assert.equal(harness.sidebar?.currentTheme, "dark");

    await openSettingsMenu(harness);
    await openSettingsEntry(harness, "Theme");
    assert.match(frameText(harness), /Theme/);
    assert.match(frameText(harness), /Dark \(current\)/);
    assert.match(frameText(harness), /Host sidebar only/, "the pane states its own scope");
    assert.match(frameText(harness), /Saved for this native Pi agent/);

    await moveTo(harness, "Light");
    harness.terminal.emitInput(ENTER);
    await nextTurn();

    assert.equal(harness.sidebar?.currentTheme, "light",
      "the palette changes only after Main reports a successful save");
    assert.deepEqual(JSON.parse(readFileSync(appearancePath(agentDir), "utf8")),
      { version: 1, theme: "light" }, "the choice is the host's own persisted record");
    assert.match(frameText(harness), /Light \(current\)/,
      "the pane marks the applied choice in text, not color alone");
    const codes = sgrCodes(rawFrameText(harness));
    assert.ok(codes.has(sidebarPaletteFor("light").selected), "the live palette is the light one");
    assert.equal(codes.has(sidebarPaletteFor("dark").header), false);
    // The Theme pane is a host form, so this covers form and roster rows.
    assertTerminalDefaultGround(rawFrameText(harness), "light");
    for (const code of codes) {
      assertClosedSgr(code, "a written Theme-pane or roster row");
    }
    assert.equal(manager.writes.length, writesBefore,
      "no settings keystroke reached a native child");
    assert.equal(manager.createOptions.length, createsBefore, "no child was started by the settings gesture");
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    // The restart proof runs after the first host released its directory.
  }

  const second = appearanceMain(agentDir);
  try {
    await ready(second);
    assert.equal(second.sidebar?.currentTheme, "light",
      "a fresh host over the same native agent directory reloads the choice");
    assert.equal(await closeWithSignal(second), 0);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a refused appearance write keeps the previous theme active and leaves the file untouched", async () => {
  const agentDir = ownedAgentDir();
  writeAppearanceConfig(agentDir, { theme: "dark" });
  const before = readFileSync(appearancePath(agentDir), "utf8");
  let attempts = 0;
  const harness = appearanceMain(agentDir, {
    writeAppearanceConfig: () => {
      attempts += 1;
      throw new Error("synthetic appearance write failure");
    },
  });
  try {
    const manager = await ready(harness);
    await openSettingsMenu(harness);
    await openSettingsEntry(harness, "Theme");
    await moveTo(harness, "Light");
    harness.terminal.emitInput(ENTER);
    await nextTurn();

    assert.equal(attempts, 1, "Main attempted the host-owned write once");
    assert.equal(harness.sidebar?.currentTheme, "dark",
      "a failed save never applies an unsaved palette");
    assert.match(frameText(harness), /synthetic appearance write failure/,
      `the refusal is stated where the operator chose:\n${frameText(harness)}`);
    assert.match(frameText(harness), /Dark \(current\)/);
    assert.equal(readFileSync(appearancePath(agentDir), "utf8"), before,
      "the refused save left the record byte-identical");
    assert.deepEqual(readdirSync(join(agentDir, "session-host")).filter((name) => name.includes(".tmp.")), [],
      "a failed save leaves no temporary entry");

    // Escape returns through the menu; nothing commits.
    harness.terminal.emitInput(ESC);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form", "Cancel returns to the Settings menu");
    assert.equal(harness.sidebar?.currentTheme, "dark");
    harness.terminal.emitInput(ESC);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "sidebar");
    assert.equal(manager.writes.length, 0, "the whole failed gesture stayed host-owned");
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The grouped Settings entry reaches the existing panes unchanged
// ---------------------------------------------------------------------------

test("the Settings submenu opens the existing Network pane and returns through Settings to the roster", async (t) => {
  const { harness, peer } = await peerMainHarness(t);
  const commandsBefore = peer.commands.length;
  const decisionsBefore = peer.decisions.length;

  await moveTo(harness, "Settings");
  assert.equal(harness.sidebar?.focus, "sidebar", "the grouped row is a roster row like the others");
  const rosterLines = frameText(harness).split("\n");
  assert.equal(rosterLines.filter((line) => line.startsWith("> Network")
    || line.startsWith("> Host shortcuts")).length, 0,
    "no independent Network or Host shortcuts roster row is drawn");

  harness.terminal.emitInput(ENTER);
  await nextTurn();
  const menu = frameText(harness);
  assert.match(menu, /Theme/);
  assert.match(menu, /Network/);
  assert.match(menu, /Host shortcuts/);
  assert.equal(peer.commands.length, commandsBefore, "opening the menu sends nothing");

  await openSettingsEntry(harness, "Network");
  assert.equal(harness.sidebar?.focus, "form", "the existing Network pane owns the right-hand slot");
  assert.match(frameText(harness), /Network/, "the Network pane is the pane that already existed");
  assert.equal(peer.commands.length, commandsBefore, "reaching it through Settings sends no command");
  assert.equal(peer.decisions.length, decisionsBefore, "and confirms or denies nothing");

  harness.terminal.emitInput(ESC);
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "form", "Escape returns to the Settings menu that opened it");
  assert.match(frameText(harness), /Theme/);
  assert.match(frameText(harness), /Theme/, "the Settings menu is on screen");
  assert.match(frameText(harness), /Network/, "the Network entry is still offered for a later visit");

  harness.terminal.emitInput(ESC);
  await nextTurn();
  assert.equal(harness.sidebar?.focus, "sidebar", "leaving Settings closes to the roster");
  assert.equal(harness.sidebar?.visible, true, "closing a submenu never hides the sidebar");
  assert.equal(peer.commands.length, commandsBefore);
  assert.equal(await closeWithSignal(harness), 0);
});

test("the Settings submenu opens the existing Host shortcuts editor with its own save semantics intact", async () => {
  const agentDir = ownedAgentDir();
  const harness = appearanceMain(agentDir);
  try {
    const manager = await ready(harness);
    await openSettingsMenu(harness);
    await openSettingsEntry(harness, "Host shortcuts");
    assert.equal(harness.sidebar?.focus, "form");
    assert.match(frameText(harness), /Toggle/, "the existing host shortcut editor is the pane that opened");
    assert.equal(existsSync(join(agentDir, "session-host", "keybindings.json")), false,
      "opening the editor writes nothing");

    // Cancel returns through the menu and commits nothing.
    harness.terminal.emitInput(ESC);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "form");
    assert.match(frameText(harness), /Theme/);
    assert.equal(existsSync(join(agentDir, "session-host", "keybindings.json")), false,
      "Cancel commits no keybindings");
    harness.terminal.emitInput(ESC);
    await nextTurn();
    assert.equal(harness.sidebar?.focus, "sidebar");
    assert.equal(manager.writes.length, 0, "the settings gesture never reached a native child");
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("the toggle chord closes the whole Settings chain and reopening shows the roster", async () => {
  const agentDir = ownedAgentDir();
  const harness = appearanceMain(agentDir);
  try {
    const manager = await ready(harness);
    await openSettingsMenu(harness);
    await openSettingsEntry(harness, "Theme");
    assert.equal(harness.sidebar?.focus, "form");

    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    assert.equal(harness.sidebar?.visible, false, "the reserved toggle hides from any nested Settings pane");
    harness.terminal.emitInput(ALT_LEFT);
    await nextTurn();
    assert.equal(harness.sidebar?.visible, true);
    assert.equal(harness.sidebar?.focus, "sidebar",
      "a hidden-then-shown sidebar returns to the roster, never to a stale submenu");
    assert.match(frameText(harness), /Sessions \(\d\)/);
    assert.equal(frameText(harness).includes("Theme"), false,
      "no submenu or Theme pane survives the hide/show cycle");
    assert.equal(manager.writes.length, 0);
    assert.equal(await closeWithSignal(harness), 0);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
