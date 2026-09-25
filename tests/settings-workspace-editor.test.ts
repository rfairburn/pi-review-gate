/**
 * Issue #26: the scheduled-task workspace directory field through the shared
 * host-wired native editor bridge.
 *
 * The bespoke workspace-only editor/provider/matcher surface is gone: this
 * field is one of the /review-settings text fields and routes through the
 * same bridge as every other (src/native-editor-bridge.ts). What remains
 * workspace-specific is pinned here at the flow level:
 *
 * - The staged workspace value arrives as the field's editable prefill, an
 *   Enter-submitted value stages like before, and cancel (`undefined`) leaves
 *   the staged value unchanged.
 * - Save-time validation stays the authority: a typed non-existent directory
 *   is rejected with an error notice and the config file is byte-unchanged;
 *   nothing about completion can bypass the directory boundary.
 * - In the interactive TUI the field opens through the bridge (one embedded
 *   host editor instance, no second draft surface); the real-host flow test
 *   pins that native Tab completion stages an existing directory through
 *   Save end to end (skipped when no Pi install is resolvable; enforced via
 *   PI_REVIEW_GATE_REQUIRE_PI_HOST where available).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { setMenuTuiHost } from "../src/settings/menu";
import { setNativeEditorHost, __resetActiveNativeEditorFieldForTest } from "../src/native-editor-bridge";
import { createFakeMenuTuiHost, IDENTITY_THEME, KEY_DOWN, KEY_ENTER } from "./menu-tui-fakes";
import {
  CTRL_U,
  ENTER,
  ESCAPE,
  TAB,
  REAL_IDENTITY_THEME,
  createBridgeUi,
  createRealKeybindingsManager,
  fakeHost,
  fakeKeybindingsManager,
  loadRealBridgeHost,
  skipOrFail,
  typeText,
} from "./bridge-fakes";
import type { FakeBridgeEditor } from "./bridge-fakes";

const WORKSPACE_TITLE = "Authorized target workspace directory";

// ---------------------------------------------------------------------------
// Flow harness: TUI context whose menus and the bridge field both render
// through ctx.ui.custom, driven by one scripted step per surface.
// ---------------------------------------------------------------------------

type FlowStep = (component: { render?(width: number): string[]; handleInput?(data: string): void }) => void | Promise<void>;

interface FlowHarness {
  ctx: unknown;
  notifyCalls: Array<{ message: string; type?: string }>;
  editorCalls: Array<{ title: string; prefill?: string }>;
  customCount(): number;
}

function flowHarness(
  steps: FlowStep[],
  options: { cwd?: string; keybindings?: unknown; theme?: unknown; provider?: unknown; draft?: string },
): FlowHarness {
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  const editorCalls: Array<{ title: string; prefill?: string }> = [];
  const { ui } = createBridgeUi({
    keybindings: options.keybindings ?? fakeKeybindingsManager(),
    theme: options.theme,
    provider: options.provider,
    draft: options.draft ?? "chat draft",
    drivers: steps,
  });
  let customCount = 0;
  const wrapped = {
    ...ui,
    custom(factory: Parameters<NonNullable<typeof ui.custom>>[0]): Promise<string | undefined> {
      customCount += 1;
      return ui.custom!(factory);
    },
    notify(message: string, type?: string): void {
      notifyCalls.push({ message, type });
    },
    async select(): Promise<string | undefined> {
      throw new Error("plain select must not be used in TUI mode with a loadable host");
    },
    async editor(title: string, prefill?: string): Promise<string | undefined> {
      editorCalls.push({ title, prefill });
      return undefined;
    },
  };
  const ctx = {
    mode: "tui",
    scopedModels: [],
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ui: wrapped,
  };
  return { ctx, notifyCalls, editorCalls, customCount: () => customCount };
}

// ---------------------------------------------------------------------------
// Shared flow setup
// ---------------------------------------------------------------------------

const keys = (...sequence: string[]): FlowStep => (component) => {
  for (const key of sequence) component.handleInput?.(key);
};

async function writeFlowConfig(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-ws-flow-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({ scheduledTasks: { "task-abcdef12": { name: "Nightly check", cron: "30 2 * * *", enabled: true, kind: "execute", instructions: "Check the docs for staleness", workspace: dir } } }, null, 2));
  return { dir, configPath };
}

async function registerFlowHandler(configPath: string): Promise<(ctx: unknown) => Promise<void>> {
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  registerReviewSettings({
    pi: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        if (name === "review-settings") handler = options.handler;
      },
    },
    config,
    configPath,
  });
  assert.ok(handler, "the /review-settings command registered");
  return (ctx) => handler!("", ctx);
}

for (const targetKind of ["missing", "existing file"] as const) {
  test(`full TUI flow: a typed ${targetKind} workspace is rejected at Save`, async (t) => {
    const instances: FakeBridgeEditor[] = [];
    const menuHost = createFakeMenuTuiHost();
    setMenuTuiHost(menuHost);
    setNativeEditorHost(fakeHost(instances));
    t.after(() => {
      setMenuTuiHost(undefined);
      setNativeEditorHost(undefined);
      __resetActiveNativeEditorFieldForTest();
    });

    const { dir, configPath } = await writeFlowConfig();
    const invalid = targetKind === "existing file" ? join(dir, "guide.md") : join(dir, "missing-directory");
    if (targetKind === "existing file") await writeFile(invalid, "guide\n");
    const before = await readFile(configPath, "utf8");
    const run = await registerFlowHandler(configPath);
    const harness = flowHarness([
      keys(...Array(14).fill(KEY_DOWN), KEY_ENTER), // root → Scheduled tasks (index 14)
      keys(KEY_ENTER), // list → task entry (row 0)
      keys(KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER), // entry editor → workspace (row 4)
      async (component) => {
        const frame = component.render!(80).join("\n");
        assert.ok(frame.includes(dir), `the staged workspace is the field prefill: ${frame}`);
        component.handleInput?.(CTRL_U); // clear the prefilled staged value
        typeText(component, invalid);
        component.handleInput?.(ENTER);
      },
      keys(...Array(5).fill(KEY_DOWN), KEY_ENTER), // entry re-show (row 4) → Back (row 9)
      keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // list re-show → Back (row 2)
      keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // root re-show (index 14) → Save changes (row 16)
      keys(ESCAPE), // failed save re-shows the root menu; Esc leaves without saving
    ], { cwd: dir });

    await run(harness.ctx);

    assert.ok(instances.length === 1, "exactly one bridge editor instance for the field");
    assert.equal(harness.editorCalls.length, 0, "the field used the embedded host editor, not a second draft");
    assert.equal(harness.customCount(), 8, "seven menus plus the workspace field surface");
    assert.ok(
      harness.notifyCalls.some((call) => call.type === "error" && /not an existing directory/.test(call.message)),
      `Save validation rejected the ${targetKind} target: ${JSON.stringify(harness.notifyCalls)}`,
    );
    assert.equal(await readFile(configPath, "utf8"), before, "the config file is byte-unchanged after a failed save");
  });
}

test("full TUI flow: a typed existing workspace stages through Save", async (t) => {
  const instances: FakeBridgeEditor[] = [];
  const menuHost = createFakeMenuTuiHost();
  setMenuTuiHost(menuHost);
  setNativeEditorHost(fakeHost(instances));
  t.after(() => {
    setMenuTuiHost(undefined);
    setNativeEditorHost(undefined);
    __resetActiveNativeEditorFieldForTest();
  });

  const { dir, configPath } = await writeFlowConfig();
  const target = await mkdtemp(join(tmpdir(), "pi-ws-target-"));
  const run = await registerFlowHandler(configPath);

  const harness = flowHarness([
    keys(...Array(14).fill(KEY_DOWN), KEY_ENTER), // root → Scheduled tasks (index 14)
    keys(KEY_ENTER), // list → task entry (row 0)
    keys(KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER), // entry editor → workspace (row 4)
    async (component) => {
      component.handleInput?.(CTRL_U); // clear the prefilled staged value
      typeText(component, target);
      component.handleInput?.(ENTER); // submit the existing directory
    },
    keys(...Array(5).fill(KEY_DOWN), KEY_ENTER), // entry re-show (row 4) → Back (row 9)
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // list re-show → Back (row 2)
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // root re-show (index 14) → Save changes (row 16)
  ], { cwd: dir });

  await run(harness.ctx);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.scheduledTasks["task-abcdef12"].workspace, target, "the typed directory is staged and saved");
});

test("full TUI flow: cancel in the workspace field leaves the staged value unchanged", async (t) => {
  const instances: FakeBridgeEditor[] = [];
  const menuHost = createFakeMenuTuiHost();
  setMenuTuiHost(menuHost);
  setNativeEditorHost(fakeHost(instances));
  t.after(() => {
    setMenuTuiHost(undefined);
    setNativeEditorHost(undefined);
    __resetActiveNativeEditorFieldForTest();
  });

  const { dir, configPath } = await writeFlowConfig();
  const before = await readFile(configPath, "utf8");
  const run = await registerFlowHandler(configPath);

  const harness = flowHarness([
    keys(...Array(14).fill(KEY_DOWN), KEY_ENTER), // root → Scheduled tasks (index 14)
    keys(KEY_ENTER), // list → task entry (row 0)
    keys(KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER), // entry editor → workspace (row 4)
    async (component) => {
      const frame = component.render!(80).join("\n");
      assert.ok(frame.includes(dir), `the staged workspace is the field prefill: ${frame}`);
      typeText(component, "-partial"); // a partial edit that must not survive
      component.handleInput?.(ESCAPE); // cancel the field
    },
    keys(...Array(5).fill(KEY_DOWN), KEY_ENTER), // entry re-show (row 4) → Back (row 9)
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // list re-show → Back (row 2)
    keys(ESCAPE), // root: leave without saving
  ], { cwd: dir });

  await run(harness.ctx);

  assert.equal(await readFile(configPath, "utf8"), before, "the config file is unchanged");
});

/** Points os.homedir at a fixture home (it reads $HOME). */
function withFixtureHome(home: string, t: { after(callback: () => void): void }): void {
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  if (process.platform === "win32") process.env.USERPROFILE = home;
  t.after(() => {
    if (previous.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previous.HOME;
    if (previous.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous.USERPROFILE;
  });
}

test("full TUI flow (real host): native Tab completion stages an existing directory through Save", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  const menuHost = createFakeMenuTuiHost();
  setMenuTuiHost(menuHost);
  t.after(() => {
    setMenuTuiHost(undefined);
    setNativeEditorHost(undefined);
    __resetActiveNativeEditorFieldForTest();
  });

  // Fixture home: the native provider completes ~/a to ~/alpha/.
  const home = await mkdtemp(join(tmpdir(), "pi-ws-flowreal-"));
  await mkdir(join(home, "alpha"), { recursive: true });
  await mkdir(join(home, "beta"), { recursive: true });
  withFixtureHome(home, t);

  const { configPath } = await writeFlowConfig();
  const run = await registerFlowHandler(configPath);

  setNativeEditorHost(loaded.host);
  const providerCtor = loaded.tui.CombinedAutocompleteProvider as new (commands: never[], basePath: string) => unknown;
  const harness = flowHarness([
    keys(...Array(14).fill(KEY_DOWN), KEY_ENTER), // root → Scheduled tasks (index 14)
    keys(KEY_ENTER), // list → task entry (row 0)
    keys(KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER), // entry editor → workspace (row 4)
    async (component) => {
      component.handleInput?.(CTRL_U); // clear the prefilled staged value
      typeText(component, "~/a");
      component.handleInput?.(TAB); // Tab: the single native match (~/alpha/) applies
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.ok(component.render!(200).join("\n").includes("~/alpha/"), "the folder completion is in the draft");
      component.handleInput?.(ENTER); // submit
    },
    keys(...Array(5).fill(KEY_DOWN), KEY_ENTER), // entry re-show (row 4) → Back (row 9)
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // list re-show → Back (row 2)
    keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // root re-show (index 14) → Save changes (row 16)
  ], { cwd: home, keybindings: createRealKeybindingsManager(loaded.tui), theme: REAL_IDENTITY_THEME, provider: new providerCtor([], home) });

  await run(harness.ctx);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  // expandHomePath joins the home prefix with the remainder verbatim, so the
  // native directory completion's trailing slash is preserved in the save.
  assert.equal(saved.scheduledTasks["task-abcdef12"].workspace, join(home, "alpha/"), "the completed directory is staged (expanded) and saved");
});
