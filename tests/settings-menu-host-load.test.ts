/**
 * Issue #140: production host-peer loading for compiled CJS extension entries.
 *
 * Under pi 0.86 (jiti 2.7, Node >= 24) a pre-compiled CommonJS entry is
 * loaded by native import, so its `require("@earendil-works/pi-tui")` calls
 * bypass the jiti aliases and throw MODULE_NOT_FOUND. The loader must then
 * resolve the peers from the running Pi install (discovered via the process
 * entry) instead of silently degrading every menu to the plain selector.
 *
 * These tests exercise that production loading path against fake Pi install
 * trees (no injected host): a valid ESM peer, an ESM peer that forces the
 * dynamic import fallback, an absent peer (plain fallback), and a non-Pi
 * process entry (guard). The end-to-end proof on the actually installed pi
 * runs through a real interactive PTY; this file pins the resolution
 * mechanics so they cannot regress.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { retainedSelect, setMenuTuiHost, setMenuTuiHostEntryProvider, type RetainedUi } from "../src/settings/menu";

type TuiVariant = "esm" | "esm-async" | "absent";

interface FakePiInstall {
  /** Base directory of the fake install (removed after each test). */
  base: string;
  /** The fake pi CLI entry (stand-in for dist/bundle/cli.js). */
  entry: string;
}

/** Fake pi-tui module source; counts its own evaluations on globalThis. */
const FAKE_TUI_MODULE_SOURCE = [
  "globalThis.__fakePiTuiModuleEvals = (globalThis.__fakePiTuiModuleEvals ?? 0) + 1;",
  "export class SelectList {",
  "  constructor(items) { this.items = items; this.selectedIndex = 0; }",
  "  setSelectedIndex(index) { this.selectedIndex = index; }",
  "  handleInput(data) {",
  "    if (data === '\\r') this.onSelect?.(this.items[this.selectedIndex]);",
  "    else if (data === '\\x1b') this.onCancel?.();",
  "  }",
  "  render() { return []; }",
  "  invalidate() {}",
  "}",
  "export class Container { addChild() {} render() { return []; } invalidate() {} }",
  "export class Text { constructor(text) { this.text = text; } render() { return [this.text]; } invalidate() {} }",
  "export function setKeybindings(kb) { globalThis.__fakePiTuiSetKeybindings = kb; }",
].join("\n");

/** Fake agent entry source; mirrors the import-only exports of installed pi. */
const FAKE_AGENT_MODULE_SOURCE = [
  "globalThis.__fakePiAgentModuleEvals = (globalThis.__fakePiAgentModuleEvals ?? 0) + 1;",
  "export class DynamicBorder {",
  "  constructor() { globalThis.__fakePiAgentBorderUsed = true; }",
  "  render() { return ['border']; }",
  "  invalidate() {}",
  "}",
  "export function getSelectListTheme() {",
  "  globalThis.__fakePiAgentThemeUsed = true;",
  "  throw new Error('theme not initialized');",
  "}",
].join("\n");

/**
 * Builds a minimal fake Pi install tree shaped like the npm package:
 * import-only "exports" plus a main field on the agent package (mirroring
 * the installed @earendil-works/pi-coding-agent), and a nested pi-tui peer.
 */
async function makeFakePiInstall(variant: TuiVariant): Promise<FakePiInstall> {
  const base = await mkdtemp(join(tmpdir(), "pi-review-menu-host-"));
  const root = join(base, "@earendil-works", "pi-coding-agent");
  const tuiDir = join(root, "node_modules", "@earendil-works", "pi-tui");
  await mkdir(join(root, "dist", "bundle"), { recursive: true });
  if (variant !== "absent") await mkdir(join(tuiDir, "dist"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.0.0-fake",
      type: "module",
      main: "./dist/index.js",
      exports: { ".": { import: "./dist/index.js" } },
    }),
  );
  await writeFile(join(root, "dist", "index.js"), FAKE_AGENT_MODULE_SOURCE);
  await writeFile(join(root, "dist", "bundle", "cli.js"), "// fake pi entry\n");

  if (variant !== "absent") {
    await writeFile(
      join(tuiDir, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-tui", version: "0.0.0-fake", type: "module", main: "dist/index.js" }),
    );
    const topLevelAwait = variant === "esm-async" ? "await Promise.resolve();\n" : "";
    await writeFile(join(tuiDir, "dist", "index.js"), topLevelAwait + FAKE_TUI_MODULE_SOURCE);
  }
  return { base, entry: join(root, "dist", "bundle", "cli.js") };
}

/** A TUI-mode ui that records which surface the adapter used. */
function recordingUi(keybindings: unknown = null): {
  ui: RetainedUi;
  state: { customCalls: number; selectCalls: Array<{ title: string; options: string[] }> };
} {
  const state = { customCalls: 0, selectCalls: [] as Array<{ title: string; options: string[] }> };
  const ui: RetainedUi = {
    mode: "tui",
    async select(title: string, options: string[]): Promise<string | undefined> {
      state.selectCalls.push({ title, options });
      return undefined;
    },
    custom(factory) {
      state.customCalls += 1;
      // Drive the component like the host showExtensionCustom would.
      return new Promise((resolve) => {
        const component = factory(
          { requestRender(): void {} },
          { fg: (_color: string, text: string): string => text, bold: (text: string): string => text },
          keybindings,
          resolve,
        ) as { handleInput?(data: string): void };
        component.handleInput?.("\r"); // Enter confirms the selected row.
      });
    },
  };
  return { ui, state };
}

function clearSeams(): void {
  setMenuTuiHost(undefined);
  setMenuTuiHostEntryProvider(undefined);
}

function clearFakeGlobals(): void {
  for (const key of [
    "__fakePiTuiModuleEvals",
    "__fakePiAgentModuleEvals",
    "__fakePiAgentBorderUsed",
    "__fakePiAgentThemeUsed",
    "__fakePiTuiSetKeybindings",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

function fakeGlobal(key: string): unknown {
  return (globalThis as Record<string, unknown>)[key];
}

test("production load path: resolves and loads the host peers from a running Pi entry", async (t) => {
  const install = await makeFakePiInstall("esm");
  t.after(() => rm(install.base, { recursive: true, force: true }).catch(() => {}));
  clearSeams();
  clearFakeGlobals();
  setMenuTuiHostEntryProvider(() => install.entry);

  const liveManager = { matches: (_data: string, _keybinding: string): boolean => false };
  const { ui, state } = recordingUi(liveManager);
  const result = await retainedSelect(ui, {
    title: "Pick",
    rows: [
      { key: "a", label: "Alpha" },
      { key: "b", label: "Beta" },
    ],
  });

  // The custom (host TUI) surface was used — not the plain fallback.
  assert.equal(result, "a");
  assert.equal(state.customCalls, 1);
  assert.equal(state.selectCalls.length, 0);
  // The adapter captured the module's setKeybindings and pointed it at the
  // host's injected live manager (the #140 fix, on the production load path).
  assert.equal(fakeGlobal("__fakePiTuiSetKeybindings"), liveManager);
  // Both peers loaded exactly once: pi-tui via createRequire resolution,
  // the agent via its import-only-exports main field.
  assert.equal(fakeGlobal("__fakePiTuiModuleEvals"), 1);
  assert.equal(fakeGlobal("__fakePiAgentModuleEvals"), 1);
  // The adapter wired in the agent's cosmetic exports (border + theme).
  assert.equal(fakeGlobal("__fakePiAgentBorderUsed"), true);
  assert.equal(fakeGlobal("__fakePiAgentThemeUsed"), true);
});

test("production load path: ESM peer that defeats require() loads through the dynamic import fallback", async (t) => {
  // Top-level await makes require(esm) throw even on Node >= 22.12, forcing
  // the same native dynamic import branch that Node 20 hits via
  // ERR_REQUIRE_ESM. If the transpiler rewrote that import into a require,
  // this test fails (host undefined -> plain fallback).
  const install = await makeFakePiInstall("esm-async");
  t.after(() => rm(install.base, { recursive: true, force: true }).catch(() => {}));
  clearSeams();
  clearFakeGlobals();
  setMenuTuiHostEntryProvider(() => install.entry);

  const { ui, state } = recordingUi();
  const result = await retainedSelect(ui, {
    title: "Pick",
    rows: [{ key: "a", label: "Alpha" }],
  });
  assert.equal(result, "a");
  assert.equal(state.customCalls, 1);
  assert.equal(state.selectCalls.length, 0);
  assert.equal(fakeGlobal("__fakePiTuiModuleEvals"), 1);
});

test("production load path: absent peer degrades to the plain selector without throwing", async (t) => {
  const install = await makeFakePiInstall("absent");
  t.after(() => rm(install.base, { recursive: true, force: true }).catch(() => {}));
  clearSeams();
  clearFakeGlobals();
  setMenuTuiHostEntryProvider(() => install.entry);

  const { ui, state } = recordingUi();
  const result = await retainedSelect(ui, {
    title: "Pick",
    rows: [
      { key: "a", label: "Alpha" },
      { key: "b", label: "Beta" },
    ],
  });
  // Plain fallback with the same labels in the same order.
  assert.equal(result, undefined);
  assert.equal(state.customCalls, 0);
  assert.equal(state.selectCalls.length, 1);
  assert.deepEqual(state.selectCalls[0], { title: "Pick", options: ["Alpha", "Beta"] });
});

test("production load path: a non-Pi process entry never resolves host peers", async (t) => {
  // The nearest package.json to the entry must name the pi agent package;
  // any other process (tooling, another host) degrades to plain select.
  const base = await mkdtemp(join(tmpdir(), "pi-review-menu-host-"));
  const root = join(base, "some-other-package");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "some-other-package", version: "0.0.0" }));
  const entry = join(root, "dist", "tool.js");
  await writeFile(entry, "// not pi\n");
  t.after(() => rm(base, { recursive: true, force: true }).catch(() => {}));

  clearSeams();
  clearFakeGlobals();
  setMenuTuiHostEntryProvider(() => entry);

  const { ui, state } = recordingUi();
  await retainedSelect(ui, { title: "Pick", rows: [{ key: "a", label: "Alpha" }] });
  assert.equal(state.customCalls, 0);
  assert.equal(state.selectCalls.length, 1);
});

test("production load path: repeated menus reuse the memoized host without reloading", async (t) => {
  const install = await makeFakePiInstall("esm");
  t.after(() => rm(install.base, { recursive: true, force: true }).catch(() => {}));
  clearSeams();
  clearFakeGlobals();
  let entryConsults = 0;
  setMenuTuiHostEntryProvider(() => {
    entryConsults += 1;
    return install.entry;
  });

  const { ui, state } = recordingUi();
  await retainedSelect(ui, { title: "One", rows: [{ key: "a", label: "Alpha" }] });
  const consultsAfterFirstMenu = entryConsults;
  assert.ok(consultsAfterFirstMenu > 0);
  await retainedSelect(ui, { title: "Two", rows: [{ key: "b", label: "Beta" }] });
  assert.equal(state.customCalls, 2);
  // The memoized load promise means the second menu never re-consults the
  // process entry (each peer resolution inside one load consults it once).
  assert.equal(entryConsults, consultsAfterFirstMenu);
  // Each menu constructs its own components, but each module loads once.
  assert.equal(fakeGlobal("__fakePiTuiModuleEvals"), 1);
  assert.equal(fakeGlobal("__fakePiAgentModuleEvals"), 1);
});
