/**
 * Issue #213: immediate interactive-startup peer prewarm.
 *
 * The first /review-settings after startup paused on a cold load of the
 * running Pi agent package (several seconds on Windows/macOS). This file pins
 * the prewarm mechanics against fake Pi install trees (no injected host):
 *
 * - the import starts immediately when requested — no artificial timer delay;
 * - an early open racing an in-flight prewarm coalesces into the same module
 *   record (one evaluation, one identity), including the require() race that
 *   throws ERR_REQUIRE_ESM_RACE_CONDITION against the in-flight native import;
 * - a completed prewarm is consumed by the on-demand loader and the full
 *   retained menu exactly as the cached module — no duplicate evaluation;
 * - failures (non-Pi entry, broken install) resolve to undefined invisibly
 *   and leave the on-demand loader's fail-closed degradation untouched.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadHostPeerModule } from "../src/host-peer-loader";
import { prewarmPiAgentPeer, setPeerPrewarmEntryProvider } from "../src/peer-prewarm";
import { retainedSelect, setMenuTuiHost, setMenuTuiHostEntryProvider, type RetainedUi } from "../src/settings/menu";

const PI_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

type AgentVariant = "plain" | "gated" | "broken";

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
function fakeAgentModuleSource(variant: AgentVariant): string {
  const lines = [
    "globalThis.__fakeAgentPrewarmEvals = (globalThis.__fakeAgentPrewarmEvals ?? 0) + 1;",
    "globalThis.__fakeAgentPrewarmEvalStarted = true;",
  ];
  if (variant === "gated") {
    // Hold evaluation at a top-level await until the test releases it, so an
    // in-flight prewarm can be raced deterministically.
    lines.push("await new Promise((resolve) => { globalThis.__fakeAgentPrewarmRelease = resolve; });");
  }
  lines.push(
    "export class CustomEditor {}",
    "export class DynamicBorder {",
    "  constructor() { globalThis.__fakePiAgentBorderUsed = true; }",
    "  render() { return ['border']; }",
    "  invalidate() {}",
    "}",
    "export function getSelectListTheme() {",
    "  globalThis.__fakePiAgentThemeUsed = true;",
    "  throw new Error('theme not initialized');",
    "}",
    'export const prewarmMarker = "agent-peer";',
  );
  return lines.join("\n");
}

/**
 * Builds a minimal fake Pi install tree shaped like the npm package:
 * import-only "exports" plus a main field on the agent package (mirroring
 * the installed @earendil-works/pi-coding-agent), and a nested pi-tui peer.
 */
async function makeFakePiInstall(variant: AgentVariant): Promise<FakePiInstall> {
  const base = await mkdtemp(join(tmpdir(), "pi-review-prewarm-"));
  const root = join(base, "@earendil-works", "pi-coding-agent");
  const tuiDir = join(root, "node_modules", "@earendil-works", "pi-tui");
  await mkdir(join(root, "dist", "bundle"), { recursive: true });
  await mkdir(join(tuiDir, "dist"), { recursive: true });
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
  if (variant !== "broken") await writeFile(join(root, "dist", "index.js"), fakeAgentModuleSource(variant));
  await writeFile(join(root, "dist", "bundle", "cli.js"), "// fake pi entry\n");
  await writeFile(
    join(tuiDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-tui", version: "0.0.0-fake", type: "module", main: "dist/index.js" }),
  );
  await writeFile(join(tuiDir, "dist", "index.js"), FAKE_TUI_MODULE_SOURCE);
  return { base, entry: join(root, "dist", "bundle", "cli.js") };
}

/** A non-Pi process tree: the nearest package.json names another package. */
async function makeNonPiTree(): Promise<FakePiInstall> {
  const base = await mkdtemp(join(tmpdir(), "pi-review-prewarm-nonpi-"));
  const root = join(base, "some-other-package");
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "some-other-package", version: "0.0.0" }));
  const entry = join(root, "dist", "tool.js");
  await writeFile(entry, "// not pi\n");
  return { base, entry };
}

function clearSeams(): void {
  setPeerPrewarmEntryProvider(undefined);
  setMenuTuiHost(undefined);
  setMenuTuiHostEntryProvider(undefined);
}

function clearFakeGlobals(): void {
  for (const key of [
    "__fakePiTuiModuleEvals",
    "__fakeAgentPrewarmEvals",
    "__fakeAgentPrewarmEvalStarted",
    "__fakeAgentPrewarmRelease",
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

/**
 * Waits for the fake agent module's top level to start executing, bounded by
 * macrotask turns. A timer-gated start (the anti-pattern this issue removes)
 * would never appear within the bound; a genuine immediate import of a small
 * local file does.
 */
async function waitForEvalStarted(): Promise<void> {
  for (let turns = 0; turns < 200; turns += 1) {
    if (fakeGlobal("__fakeAgentPrewarmEvalStarted") === true) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fakeGlobal("__fakeAgentPrewarmEvalStarted"), true, "prewarm import started without artificial delay");
}

/** A TUI-mode ui that records which surface the adapter used. */
function recordingUi(): {
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
          null,
          resolve,
        ) as { handleInput?(data: string): void };
        component.handleInput?.("\r"); // Enter confirms the selected row.
      });
    },
  };
  return { ui, state };
}

test("prewarm starts immediately on request, with no artificial delay", async (t) => {
  const install = await makeFakePiInstall("gated");
  t.after(() => rm(install.base, { recursive: true, force: true }).catch(() => {}));
  clearSeams();
  clearFakeGlobals();
  setPeerPrewarmEntryProvider(() => install.entry);

  // Fire-and-forget contract: the caller does not await.
  const prewarm = prewarmPiAgentPeer();
  await waitForEvalStarted();
  (fakeGlobal("__fakeAgentPrewarmRelease") as () => void)();
  const mod = await prewarm;
  assert.equal(mod?.prewarmMarker, "agent-peer");
  assert.equal(fakeGlobal("__fakeAgentPrewarmEvals"), 1);
});

test("repeated calls join the one memoized prewarm without re-evaluating", async (t) => {
  const install = await makeFakePiInstall("plain");
  t.after(() => rm(install.base, { recursive: true, force: true }).catch(() => {}));
  clearSeams();
  clearFakeGlobals();
  setPeerPrewarmEntryProvider(() => install.entry);

  const first = prewarmPiAgentPeer();
  const second = prewarmPiAgentPeer();
  assert.equal(first, second, "the memoized promise is shared");
  const mod = await first;
  assert.equal(mod?.prewarmMarker, "agent-peer");
  assert.equal(fakeGlobal("__fakeAgentPrewarmEvals"), 1);
});

test("early open racing an in-flight prewarm coalesces into one evaluation and one identity", async (t) => {
  const install = await makeFakePiInstall("gated");
  t.after(() => rm(install.base, { recursive: true, force: true }).catch(() => {}));
  clearSeams();
  clearFakeGlobals();
  setPeerPrewarmEntryProvider(() => install.entry);

  const prewarm = prewarmPiAgentPeer();
  // Hold the evaluation in flight at its top-level await, then open the menu's
  // on-demand load against it: require() races the in-flight native import.
  await waitForEvalStarted();
  const onDemand = loadHostPeerModule(PI_AGENT_PACKAGE_NAME, {
    entryProvider: () => install.entry,
    packageMainFallback: true,
  });
  (fakeGlobal("__fakeAgentPrewarmRelease") as () => void)();
  const [prewarmed, demanded] = await Promise.all([prewarm, onDemand]);
  assert.equal(prewarmed?.prewarmMarker, "agent-peer");
  assert.equal(demanded, prewarmed, "the racing open consumed the exact cached module");
  assert.equal(fakeGlobal("__fakeAgentPrewarmEvals"), 1, "no duplicate evaluation under the race");
});

test("completed prewarm: on-demand loader and retained menu consume the exact cached module", async (t) => {
  const install = await makeFakePiInstall("plain");
  t.after(() => rm(install.base, { recursive: true, force: true }).catch(() => {}));
  clearSeams();
  clearFakeGlobals();
  setPeerPrewarmEntryProvider(() => install.entry);

  const prewarmed = await prewarmPiAgentPeer();
  assert.equal(prewarmed?.prewarmMarker, "agent-peer");
  assert.equal(fakeGlobal("__fakeAgentPrewarmEvals"), 1);

  // The menu/native-editor on-demand load path returns the identical record.
  const onDemand = await loadHostPeerModule(PI_AGENT_PACKAGE_NAME, {
    entryProvider: () => install.entry,
    packageMainFallback: true,
  });
  assert.equal(onDemand, prewarmed);
  assert.equal(fakeGlobal("__fakeAgentPrewarmEvals"), 1);

  // The full retained menu through the production load path still works and
  // reuses the cached agent module (pi-tui loads once; the agent never again).
  setMenuTuiHostEntryProvider(() => install.entry);
  const { ui, state } = recordingUi();
  const result = await retainedSelect(ui, {
    title: "Pick",
    rows: [
      { key: "a", label: "Alpha" },
      { key: "b", label: "Beta" },
    ],
  });
  assert.equal(result, "a");
  assert.equal(state.customCalls, 1);
  assert.equal(state.selectCalls.length, 0);
  assert.equal(fakeGlobal("__fakePiTuiModuleEvals"), 1);
  assert.equal(fakeGlobal("__fakeAgentPrewarmEvals"), 1);
});

test("non-Pi process entry: prewarm resolves undefined and loads nothing", async (t) => {
  const tree = await makeNonPiTree();
  t.after(() => rm(tree.base, { recursive: true, force: true }).catch(() => {}));
  clearSeams();
  clearFakeGlobals();
  setPeerPrewarmEntryProvider(() => tree.entry);

  const mod = await prewarmPiAgentPeer();
  assert.equal(mod, undefined);
  assert.equal(fakeGlobal("__fakeAgentPrewarmEvalStarted"), undefined);
  // The on-demand loader degrades exactly as before the prewarm existed.
  const onDemand = await loadHostPeerModule(PI_AGENT_PACKAGE_NAME, {
    entryProvider: () => tree.entry,
    packageMainFallback: true,
  });
  assert.equal(onDemand, undefined);
});

test("broken install: failed prewarm stays invisible and on-demand degradation is unchanged", async (t) => {
  const install = await makeFakePiInstall("broken");
  t.after(() => rm(install.base, { recursive: true, force: true }).catch(() => {}));
  clearSeams();
  clearFakeGlobals();
  setPeerPrewarmEntryProvider(() => install.entry);

  // The package.json main field points at a file that does not exist.
  const mod = await prewarmPiAgentPeer();
  assert.equal(mod, undefined);
  assert.equal(fakeGlobal("__fakeAgentPrewarmEvalStarted"), undefined);
  // The on-demand loader independently reaches the same dead end and degrades
  // (plain selector fallback upstream) instead of throwing.
  const onDemand = await loadHostPeerModule(PI_AGENT_PACKAGE_NAME, {
    entryProvider: () => install.entry,
    packageMainFallback: true,
  });
  assert.equal(onDemand, undefined);
});
