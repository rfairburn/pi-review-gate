/**
 * Issue #140: retained toggle-menu selection via the shared selector adapter.
 *
 * Covers the adapter against both a faithful fake TUI host and (when an
 * installed pi is resolvable) the real pi-tui SelectList — initial selected
 * row, input handling, cancel — plus menu integration through /review-settings:
 * Web browser permissions with repeated On/Off flips, YOLO confirm decline,
 * reviewer toggles, resource pool re-sort by stable id, route Move up/down,
 * root escape without save, and the plain-select fallback for hosts without
 * custom TUI support (RPC/mocks).
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { retainedSelect, setMenuTuiHost, type RetainedUi } from "../src/settings/menu";
import {
  createTuiSettingsContext,
  KEY_DOWN,
  KEY_ENTER,
  KEY_ESCAPE,
  KEY_UP,
  loadRealMenuTuiHost,
  loadRealPiTuiModule,
  type TuiSettingsHarness,
} from "./menu-tui-fakes";

const downs = (count: number): string[] => Array.from({ length: count }, () => KEY_DOWN);

function commandHarness(): {
  pi: { registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }): void };
  handler: (args: string, ctx: unknown) => Promise<void>;
} {
  let handler: ((args: string, ctx: unknown) => unknown) | undefined;
  return {
    pi: {
      registerCommand(name, options) {
        if (name === "review-settings") handler = options.handler;
      },
    },
    handler: async (args, ctx) => {
      assert.ok(handler);
      await handler(args, ctx);
    },
  };
}

async function makeConfig(json: Record<string, unknown>): Promise<{ configPath: string; config: ReturnType<typeof normalizeConfig> }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-menu-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify(json), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  return { configPath, config };
}

/** The adapter's RetainedUi view of a harness context (mode lives on ctx). */
function tuiUi(harness: TuiSettingsHarness): RetainedUi {
  const ui = (harness.context as { ui: Record<string, unknown> }).ui;
  return { mode: "tui", select: ui.select as RetainedUi["select"], custom: ui.custom as RetainedUi["custom"] };
}

// Root menu row indices (15 sections + Save changes + Cancel).
const ROOT = { resources: 2, routeExecute: 3, reviewers: 5, deferredTools: 12, web: 14, save: 15 } as const;
// Web settings row indices.
const WEB = { permissions: 5 } as const;
// Browser permissions row indices (field order, then yolo, then Back).
const PERM = { camera: 5, yolo: 11 } as const;

test("retainedSelect preselects initialKey and resolves the stable key on Enter", async () => {
  const harness = createTuiSettingsContext([[KEY_ENTER]]);
  setMenuTuiHost(harness.host);
  const result = await retainedSelect(tuiUi(harness), {
    title: "Pick",
    rows: [
      { key: "a", label: "Alpha" },
      { key: "b", label: "Beta" },
      { key: "c", label: "Gamma" },
    ],
    initialKey: "b",
  });
  assert.equal(result, "b");
  const list = harness.lists[0]!;
  assert.equal(list.selectedIndex, 1);
  // The initial frame shows the preselected row with the selection marker.
  assert.deepEqual(list.rendered[0], ["  Alpha", "→ Beta", "  Gamma"]);
});

test("retainedSelect keeps the first row when initialKey no longer exists", async () => {
  const harness = createTuiSettingsContext([[KEY_ENTER]]);
  setMenuTuiHost(harness.host);
  const result = await retainedSelect(tuiUi(harness), {
    title: "Pick",
    rows: [
      { key: "a", label: "Alpha" },
      { key: "c", label: "Gamma" },
    ],
    initialKey: "gone",
  });
  assert.equal(result, "a");
  assert.equal(harness.lists[0]!.selectedIndex, 0);
});

test("retainedSelect resolves undefined on Esc without touching plain select", async () => {
  const harness = createTuiSettingsContext([[KEY_ESCAPE]]);
  setMenuTuiHost(harness.host);
  const result = await retainedSelect(tuiUi(harness), {
    title: "Pick",
    rows: [{ key: "a", label: "Alpha" }],
  });
  assert.equal(result, undefined);
  assert.equal(harness.selectCalls.length, 0);
});

test("retainedSelect falls back to plain select for RPC hosts even when custom exists", async () => {
  const harness = createTuiSettingsContext([], { selectScript: ["Beta"] });
  setMenuTuiHost(harness.host);
  let customCalled = false;
  const ui: RetainedUi = {
    mode: "rpc",
    select: tuiUi(harness).select!,
    custom: () => {
      customCalled = true;
      return Promise.resolve(undefined);
    },
  };
  const result = await retainedSelect(ui, {
    title: "Pick",
    rows: [
      { key: "a", label: "Alpha" },
      { key: "b", label: "Beta" },
    ],
    initialKey: "b",
  });
  assert.equal(result, "b");
  assert.equal(customCalled, false);
  assert.deepEqual(harness.selectCalls[0], { title: "Pick", options: ["Alpha", "Beta"] });
});

test("retainedSelect degrades to plain select when the custom surface throws", async () => {
  const harness = createTuiSettingsContext([], { selectScript: ["Gamma"] });
  setMenuTuiHost(harness.host);
  const ui: RetainedUi = {
    mode: "tui",
    select: tuiUi(harness).select!,
    custom: () => {
      throw new Error("host custom failure");
    },
  };
  const result = await retainedSelect(ui, {
    title: "Pick",
    rows: [
      { key: "a", label: "Alpha" },
      { key: "b", label: "Beta" },
      { key: "c", label: "Gamma" },
    ],
  });
  assert.equal(result, "c");
  assert.equal(harness.selectCalls.length, 1);
});

test("plain fallback maps labels to keys by first match and passes unknown values through", async () => {
  setMenuTuiHost(undefined);
  const harness = createTuiSettingsContext([], { selectScript: ["X", "Z"] });
  const ui: RetainedUi = { mode: "tui", select: tuiUi(harness).select! };
  const rows = [
    { key: "a", label: "X" },
    { key: "b", label: "X" },
    { key: "c", label: "Y" },
  ];
  assert.equal(await retainedSelect(ui, { title: "Pick", rows }), "a");
  // A value matching no row is returned as-is so caller fall-throughs keep
  // their previous behavior.
  assert.equal(await retainedSelect(ui, { title: "Pick", rows }), "Z");
});

test("real pi-tui SelectList honors the initial selected row, input, and cancel", async (t) => {
  const host = await loadRealMenuTuiHost();
  if (!host) {
    t.skip("no installed pi-tui resolvable in this environment");
    return;
  }
  setMenuTuiHost(host);
  // Enter immediately (proves preselection), down+enter (proves navigation),
  // escape (proves cancel).
  const harness = createTuiSettingsContext([[KEY_ENTER], [KEY_DOWN, KEY_ENTER], [KEY_ESCAPE]]);
  const ui = tuiUi(harness);
  const rows = [
    { key: "a", label: "Alpha" },
    { key: "b", label: "Beta" },
    { key: "c", label: "Gamma" },
  ];
  assert.equal(await retainedSelect(ui, { title: "Pick", rows, initialKey: "b" }), "b");
  assert.equal(await retainedSelect(ui, { title: "Pick", rows }), "b");
  assert.equal(await retainedSelect(ui, { title: "Pick", rows }), undefined);
  // The real component rendered the title and every row label.
  const frame = harness.frames[0]!.join("\n");
  for (const text of ["Pick", "Alpha", "Beta", "Gamma"]) assert.ok(frame.includes(text), `missing ${text} in:\n${frame}`);
});

test("retainedSelect points the loaded module at the injected live keybindings manager", async () => {
  const manager = { matches: (_data: string, _keybinding: string): boolean => false };
  const harness = createTuiSettingsContext([[KEY_ENTER]], { keybindings: manager });
  setMenuTuiHost(harness.host);
  const result = await retainedSelect(tuiUi(harness), {
    title: "Pick",
    rows: [{ key: "a", label: "Alpha" }],
  });
  assert.equal(result, "a");
  // The adapter handed the host's live manager to the module's setKeybindings.
  assert.deepEqual(harness.setKeybindingsCalls, [manager]);
});

test("retainedSelect leaves module keybindings untouched when no manager is injected", async () => {
  const harness = createTuiSettingsContext([[KEY_ENTER]]); // keybindings: null
  setMenuTuiHost(harness.host);
  const result = await retainedSelect(tuiUi(harness), {
    title: "Pick",
    rows: [{ key: "a", label: "Alpha" }],
  });
  assert.equal(result, "a");
  assert.equal(harness.setKeybindingsCalls.length, 0);
});

test("real pi-tui SelectList honors user tui.select.* remaps through the injected live manager", async (t) => {
  const host = await loadRealMenuTuiHost();
  const tuiModule = await loadRealPiTuiModule();
  if (!host || !tuiModule) {
    t.skip("no installed pi-tui resolvable in this environment");
    return;
  }
  const KeybindingsManager = tuiModule.KeybindingsManager as new (
    definitions: unknown,
    userBindings?: Record<string, string | string[]>,
  ) => { matches(data: string, keybinding: string): boolean };
  if (typeof KeybindingsManager !== "function" || typeof tuiModule.getKeybindings !== "function") {
    t.skip("installed pi-tui lacks the keybinding manager exports");
    return;
  }
  setMenuTuiHost(host);
  // User remap: vim-style navigation; confirm and cancel keep their defaults.
  const manager = new KeybindingsManager(tuiModule.TUI_KEYBINDINGS, {
    "tui.select.up": "k",
    "tui.select.down": "j",
  });
  // The adapter points the module's global at the injected live manager;
  // restore the previous state afterwards so later tests see defaults.
  const previousGlobal = tuiModule.getKeybindings();
  t.after(() => {
    (tuiModule.setKeybindings as (manager: unknown) => void)(previousGlobal);
  });

  const harness = createTuiSettingsContext(
    [
      ["k", KEY_UP, "j", KEY_ENTER], // k up, stale up arrow inert, j down, enter confirms
      [KEY_DOWN, KEY_ENTER], // stale down arrow inert: first row confirms
      ["j", KEY_ESCAPE], // j navigates, escape cancels
    ],
    { keybindings: manager },
  );
  const ui = tuiUi(harness);
  const rows = [
    { key: "a", label: "Alpha" },
    { key: "b", label: "Beta" },
    { key: "c", label: "Gamma" },
  ];

  // Menu 1: preselect Beta; k moves to Alpha, the old default up arrow no
  // longer navigates (remapped away), j moves back to Beta, Enter confirms.
  assert.equal(await retainedSelect(ui, { title: "Pick", rows, initialKey: "b" }), "b");
  // Menu 2: the old default down arrow is inert; first row confirms.
  assert.equal(await retainedSelect(ui, { title: "Pick", rows }), "a");
  // Menu 3: j navigates, escape cancels without selecting.
  assert.equal(await retainedSelect(ui, { title: "Pick", rows }), undefined);

  // The module's global keybinding state is now the injected live manager.
  assert.equal(tuiModule.getKeybindings(), manager);
});

test("web permissions menu keeps the toggled row highlighted across repeated On/Off flips", async () => {
  const { configPath, config } = await makeConfig({ enabled: false });
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const harness = createTuiSettingsContext([
    [...downs(ROOT.web), KEY_ENTER],            // root → Web
    [...downs(WEB.permissions), KEY_ENTER],     // web → Browser permissions
    [...downs(PERM.camera), KEY_ENTER],         // toggle camera Off→On
    [KEY_ENTER],                                // re-show: preselected camera, On→Off
    [KEY_ENTER],                                // re-show: preselected camera, Off→On
    [KEY_ESCAPE],                               // back to web settings
    [KEY_ESCAPE],                               // back to root
    [...downs(1), KEY_ENTER],                   // save (web row + 1)
  ]);
  setMenuTuiHost(harness.host);
  await registered.handler("", harness.context);

  const [, , perm1, perm2, perm3, perm4, , root2] = harness.lists;
  const [rootFirst, webFirst, permFirst, permSecond, permThird, permFourth, webSecond, rootSecond] = harness.initialIndexes;
  // First visits open at the first row.
  assert.equal(rootFirst, 0);
  assert.equal(webFirst, 0);
  assert.equal(permFirst, 0);
  assert.ok(perm1!.items[PERM.camera]!.label.includes("Off"));
  // Re-shown after each flip: same stable row (key modelCamera) preselected
  // even though its label changed On/Off.
  assert.equal(permSecond, PERM.camera);
  assert.ok(perm2!.items[PERM.camera]!.label.includes("Model camera"));
  assert.ok(perm2!.items[PERM.camera]!.label.includes("On"));
  assert.equal(permThird, PERM.camera);
  assert.ok(perm3!.items[PERM.camera]!.label.includes("Off"));
  assert.equal(permFourth, PERM.camera);
  assert.ok(perm4!.items[PERM.camera]!.label.includes("On"));
  // Returning to the web menu keeps the permissions row; returning to root
  // keeps the web row.
  assert.equal(webSecond, WEB.permissions);
  assert.equal(rootSecond, ROOT.web);
  assert.equal(root2!.items[ROOT.web]!.value, "web");
  // Every retained menu used the custom surface; no one-shot picker was hit.
  assert.equal(harness.selectCalls.length, 0);
  assert.equal(harness.exhausted(), false);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.web.browserPermissions.modelCamera, true);
  assert.equal(saved.web.browserPermissions.yolo, false);
});

test("YOLO enablement decline leaves it off, retains the row, and cancels without saving", async () => {
  const { configPath, config } = await makeConfig({ enabled: false });
  const before = await readFile(configPath, "utf8");
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const harness = createTuiSettingsContext(
    [
      [...downs(ROOT.web), KEY_ENTER],          // root → Web
      [...downs(WEB.permissions), KEY_ENTER],   // web → Browser permissions
      [...downs(PERM.yolo), KEY_ENTER],         // attempt YOLO enablement (confirm declines)
      [KEY_ESCAPE],                             // re-show: yolo retained; back to web
      [KEY_ESCAPE],                             // back to root
      [KEY_ESCAPE],                             // cancel at root
    ],
    { confirms: [false] },
  );
  setMenuTuiHost(harness.host);
  await registered.handler("", harness.context);

  assert.equal(harness.confirmCalls(), 1);
  assert.ok(
    harness.notifyCalls.some((call) => call.type === "warning" && call.message.includes("YOLO enables every browser permission")),
    "expected the prominent YOLO warning",
  );
  const [, , perm1, perm2] = harness.lists;
  assert.ok(perm1!.items[PERM.yolo]!.label.includes("YOLO / allow everything"));
  // First visit opens at the first row; the re-show preselects the yolo row.
  assert.equal(harness.initialIndexes[2], 0);
  assert.equal(harness.initialIndexes[3], PERM.yolo);
  // Re-shown after the declined confirmation: same row retained, still Off.
  assert.ok(perm2!.items[PERM.yolo]!.label.includes("Off"));
  // Cancel at the root: nothing persisted.
  assert.equal(await readFile(configPath, "utf8"), before);
});

test("reviewers menu keeps the toggled reviewer highlighted", async () => {
  const { configPath, config } = await makeConfig({
    enabled: false,
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
      two: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
    review: { activeReviewers: [{ source: "external", id: "one" }] },
  });
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const harness = createTuiSettingsContext([
    [...downs(ROOT.reviewers), KEY_ENTER],      // root → Reviewers
    [KEY_DOWN, KEY_ENTER],                      // toggle "two" on (row 1)
    [KEY_ESCAPE],                               // re-show: two retained; back to root
    [...downs(10), KEY_ENTER],                  // save (reviewers row + 10)
  ]);
  setMenuTuiHost(harness.host);
  await registered.handler("", harness.context);

  const [, reviewers1, reviewers2] = harness.lists;
  const [rootFirst, reviewersFirst, reviewersSecond, rootSecond] = harness.initialIndexes;
  assert.equal(rootFirst, 0);
  // First visit opens at the first reviewer; the toggle targets row 1.
  assert.equal(reviewersFirst, 0);
  assert.equal(reviewers1!.items[1]!.label, "two [generic-cli] ✗");
  // Re-shown after the toggle: same reviewer row preselected with the flipped ✓.
  assert.equal(reviewersSecond, 1);
  assert.equal(reviewers2!.items[1]!.value, "external:two");
  assert.equal(reviewers2!.items[1]!.label, "two [generic-cli] ✓");
  assert.equal(rootSecond, ROOT.reviewers);
  assert.equal(harness.selectCalls.length, 0);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.review.activeReviewers, [
    { source: "external", id: "one" },
    { source: "external", id: "two" },
  ]);
});

test("worker resources keep the edited resource highlighted after a model switch re-sorts the list", async () => {
  const { configPath, config } = await makeConfig({
    enabled: false,
    externalAgents: {
      a: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
      b: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
      z: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
  });
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const harness = createTuiSettingsContext(
    [
      [...downs(ROOT.resources), KEY_ENTER],    // root → Worker resources
      [KEY_ENTER],                              // pool (empty): Add worker resource
      [KEY_ENTER],                              // pool re-show (Add retained): Add again
      [KEY_UP, KEY_UP, KEY_ENTER],              // pool re-show: open "a" (row 0)
      [KEY_ENTER],                              // editor: Model
      [KEY_ESCAPE],                             // editor re-show (model retained): back to pool
      [KEY_ESCAPE],                             // pool re-show: a now sorted as "z"; back to root
      [...downs(13), KEY_ENTER],                // save (resources row + 13)
    ],
    { selectScript: ["a [run-as-binary]", "1  current", "b [run-as-binary]", "1  current", "z [run-as-binary]"] },
  );
  setMenuTuiHost(harness.host);
  await registered.handler("", harness.context);

  const [, , pool2, pool3, editor1, editor2, pool4] = harness.lists;
  void pool2;
  void editor1;
  // Preselections: pools open at the retained "add" row after each add, the
  // editor re-show keeps Model, and the final pool preselects external-a at
  // its new (re-sorted) position.
  const [rootFirst, poolFirst, poolSecond, poolThird, editorFirst, editorSecond, poolFourth, rootSecond] = harness.initialIndexes;
  assert.equal(rootFirst, 0);
  assert.equal(poolFirst, 0);
  // After each add the pool re-shows with the Add row preselected (index 1
  // with one resource, index 2 with two).
  assert.equal(poolSecond, 1);
  assert.equal(poolThird, 2);
  assert.equal(editorFirst, 0);
  assert.equal(editorSecond, 0);
  // Pool after both adds: a (row 0), b (row 1), Add (row 2).
  assert.equal(pool3!.items.length, 4);
  assert.equal(pool3!.items[0]!.value, "external-a");
  assert.equal(pool3!.items[1]!.value, "external-b");
  // Editor re-show keeps the Model row preselected.
  assert.equal(editor2!.items[0]!.value, "model");
  // After switching a's model to z the catalog re-sorts (b first, z second),
  // but the same stable resource id stays highlighted at its new position.
  assert.equal(poolFourth, 1);
  assert.equal(pool4!.items[0]!.value, "external-b");
  assert.equal(pool4!.items[1]!.value, "external-a");
  assert.ok(pool4!.items[1]!.label.includes("z [run-as-binary]"));
  const frame = pool4!.rendered[0]!;
  assert.ok(frame[1]!.startsWith("→ "), `expected the moved resource highlighted:\n${frame.join("\n")}`);
  assert.equal(rootSecond, ROOT.resources);
  // One-shot pickers (model/capacity) still use plain select.
  assert.deepEqual(
    harness.selectCalls.map((call) => call.title),
    ["Executor model", "Maximum concurrency (1–16)", "Executor model", "Maximum concurrency (1–16)", "Executor model"],
  );

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.execution.workerResources, {
    "external-a": { selection: { source: "external", id: "z" }, maxConcurrent: 1 },
    "external-b": { selection: { source: "external", id: "b" }, maxConcurrent: 1 },
  });
});

test("route Move up keeps editing the moved entry and the outer list retains it", async () => {
  const { configPath, config } = await makeConfig({
    enabled: false,
    externalAgents: {
      a: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
      b: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
    execution: {
      workerResources: {
        "external-b": { selection: { source: "external", id: "b" }, maxConcurrent: 1 },
        "external-a": { selection: { source: "external", id: "a" }, maxConcurrent: 1 },
      },
      routes: { execute: [{ resourceId: "external-b" }, { resourceId: "external-a" }] },
    },
  });
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  const harness = createTuiSettingsContext([
    [...downs(ROOT.routeExecute), KEY_ENTER],   // root → Execution priority
    [KEY_DOWN, KEY_ENTER],                      // open entry 2 (external-a)
    [KEY_ENTER],                                // Move up (first action row)
    [KEY_ESCAPE],                               // inner re-show on the moved entry: back to list
    [KEY_ESCAPE],                               // outer re-show (a retained at new position): root
    [...downs(12), KEY_ENTER],                  // save (route row + 12)
  ]);
  setMenuTuiHost(harness.host);
  await registered.handler("", harness.context);

  const [, route1, inner1, inner2, route2] = harness.lists;
  const [rootFirst, routeFirst, innerFirst, innerSecond, routeSecond, rootSecond] = harness.initialIndexes;
  assert.equal(rootFirst, 0);
  // First visit opens at the first entry; the edit targets row 1 (external-a).
  assert.equal(routeFirst, 0);
  assert.equal(route1!.items[1]!.value, "external-a");
  // First inner editor: a at index 1 → Move up is the first row.
  assert.equal(inner1!.items[0]!.value, "moveUp");
  assert.equal(innerFirst, 0);
  // After the move the same entry is edited at index 0: no Move up offered,
  // and the previous action key (no longer present) falls back to row 0.
  assert.ok(inner2!.items.every((item) => item.value !== "moveUp"));
  assert.equal(innerSecond, 0);
  // The outer list re-shows with the moved resource highlighted at its new position.
  assert.equal(routeSecond, 0);
  assert.equal(route2!.items[0]!.value, "external-a");
  assert.equal(rootSecond, ROOT.routeExecute);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.execution.routes.execute, [
    { resourceId: "external-a" },
    { resourceId: "external-b" },
  ]);
});

test("escape at the root discards staged changes without saving", async () => {
  const { configPath, config } = await makeConfig({ enabled: false });
  const before = await readFile(configPath, "utf8");
  let savedCallbackCalls = 0;
  const registered = commandHarness();
  registerReviewSettings({
    pi: registered.pi,
    config,
    configPath,
    onSaved: () => {
      savedCallbackCalls += 1;
    },
  });
  const harness = createTuiSettingsContext([
    [...downs(ROOT.deferredTools), KEY_ENTER],  // toggle Deferred Pi tools Off
    [KEY_ESCAPE],                               // cancel at root
  ]);
  setMenuTuiHost(harness.host);
  await registered.handler("", harness.context);

  const [root1, root2] = harness.lists;
  void root1;
  // First visit opens at the first row; the re-show preselects the toggled
  // deferred-tools row, and its label is flipped.
  assert.equal(harness.initialIndexes[0], 0);
  assert.equal(harness.initialIndexes[1], ROOT.deferredTools);
  assert.ok(root2!.items[ROOT.deferredTools]!.label.includes("Off"));
  assert.equal(savedCallbackCalls, 0);
  assert.equal(await readFile(configPath, "utf8"), before);
});

test("plain-select hosts keep the legacy label flow for web permissions (fallback)", async () => {
  const { configPath, config } = await makeConfig({ enabled: false });
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  // No mode, no custom: the exact legacy label-based flow.
  const menus: Array<{ title: string; options: string[] }> = [];
  const counts: Record<string, number> = {};
  const context = {
    scopedModels: [],
    ui: {
      async select(title: string, options: string[]): Promise<string | undefined> {
        menus.push({ title, options });
        counts[title] = (counts[title] ?? 0) + 1;
        if (title === "Review settings") {
          return counts[title] === 1 ? options.find((option) => option.startsWith("Web"))! : "Save changes";
        }
        if (title === "Web settings") {
          return counts[title] === 1 ? options.find((option) => option.startsWith("Browser permissions"))! : "Back";
        }
        if (title === "Browser permissions") {
          // Toggle Model camera, then Back.
          return counts[title] === 1 ? options[PERM.camera]! : "Back";
        }
        return undefined;
      },
      notify() {},
    },
  };
  await registered.handler("", context);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.web.browserPermissions.modelCamera, true);
  // The root menu offered the legacy labels in order, ending with Save/Cancel.
  const rootOptions = menus[0]!.options;
  assert.equal(rootOptions.length, 17);
  assert.ok(rootOptions[ROOT.web]!.startsWith("Web"));
  assert.ok(rootOptions[ROOT.web]!.includes("50 MiB max download · headless browser"));
  assert.equal(rootOptions[15], "Save changes");
  assert.equal(rootOptions[16], "Cancel");
  // The permissions menu kept the legacy 11 fields + YOLO + Back order.
  const permMenu = menus.find((menu) => menu.title === "Browser permissions")!;
  assert.equal(permMenu.options.length, 13);
  assert.ok(permMenu.options[PERM.camera]!.startsWith("Model camera"));
  assert.ok(permMenu.options[PERM.yolo]!.startsWith("YOLO / allow everything"));
  assert.equal(permMenu.options[12], "Back");
});
