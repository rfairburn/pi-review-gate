import assert from "node:assert/strict";
import test, { after } from "node:test";
import { isKittyProtocolActive, Key, matchesKey, setKittyProtocolActive } from "pi-session-host-tui";
import { normalizeConfig } from "../src/config";
import { selectExternalAgentCreation, selectExternalAgentEdit } from "../src/settings/external-agents";
import { retainedChoice, retainedSelect, setMenuTuiHost, type RetainedUi, type SettingsSaveControl } from "../src/settings/menu";
import { selectWebSettings } from "../src/settings/web";
import type { UiContext } from "../src/settings/ui";
import { createTuiSettingsContext, KEY_DOWN, KEY_ENTER, type TuiSettingsHarness } from "./menu-tui-fakes";

const CTRL_S_ENCODINGS = ["\x13", "\x1b[115;5u", "\x1b[27;5;115~"];
const ALT_S_ENCODINGS = ["\x1bs", "\x1b[115;3u", "\x1b[27;3;115~"];
const previousKittyProtocolState = isKittyProtocolActive();
setKittyProtocolActive(true);
after(() => setKittyProtocolActive(previousKittyProtocolState));

function saveControl(): SettingsSaveControl {
  return { saveRequested: false, suspended: 0 };
}

function installHostMatcher(harness: TuiSettingsHarness): void {
  setMenuTuiHost({
    ...harness.host,
    matchesCtrlS: (data) => matchesKey(data, Key.ctrl("s")),
  });
}

function tuiUi(harness: TuiSettingsHarness, control?: SettingsSaveControl): UiContext & RetainedUi {
  const ui = (harness.context as { ui: UiContext & RetainedUi }).ui;
  ui.mode = "tui";
  if (control) ui.saveControl = control;
  return ui;
}

for (const encoding of CTRL_S_ENCODINGS) {
  test(`retained menu sets the shared save latch for Ctrl+S encoding ${JSON.stringify(encoding)}`, async () => {
    const harness = createTuiSettingsContext([[encoding]]);
    installHostMatcher(harness);
    const control = saveControl();
    const ui = tuiUi(harness, control);
    const result = await retainedSelect(ui, {
      title: "Settings submenu",
      rows: [{ key: "first", label: "First" }, { key: "second", label: "Second" }],
    });
    assert.equal(result, undefined);
    assert.equal(control.saveRequested, true);
    assert.equal(harness.lists.length, 1);
    assert.equal(harness.lists[0]!.selectedIndex, 0, "Ctrl+S is consumed before SelectList input");
    assert.ok(harness.frames[0]!.some((line) => line.includes("Ctrl+S save")));

    // The latch is root-owned and stays set while nested menus unwind; no new
    // custom or plain selector is shown after the request.
    assert.equal(await retainedSelect(ui, { title: "Outer menu", rows: [{ key: "x", label: "X" }] }), undefined);
    assert.equal(await retainedChoice(ui, "One-shot picker", ["Choice"]), undefined);
    assert.equal(harness.lists.length, 1);
    assert.equal(harness.selectCalls.length, 0);
  });
}

test("Alt+S is an ordinary key, not the shared Ctrl+S signal", async () => {
  for (const encoding of ALT_S_ENCODINGS) {
    const harness = createTuiSettingsContext([[encoding, KEY_ENTER]]);
    installHostMatcher(harness);
    const control = saveControl();
    const result = await retainedSelect(tuiUi(harness, control), {
      title: "Settings submenu",
      rows: [{ key: "first", label: "First" }, { key: "second", label: "Second" }],
    });
    assert.equal(result, "first", `Alt+S encoding ${JSON.stringify(encoding)} must not request save`);
    assert.equal(control.saveRequested, false);
  }
});

test("suspension leaves Ctrl+S to the active form and hides the save hint", async () => {
  const harness = createTuiSettingsContext([["\x13", KEY_ENTER]]);
  installHostMatcher(harness);
  const control = { saveRequested: false, suspended: 1 };
  const result = await retainedSelect(tuiUi(harness, control), {
    title: "Settings submenu",
    rows: [{ key: "first", label: "First" }],
  });
  assert.equal(result, "first");
  assert.equal(control.saveRequested, false);
  assert.ok(!harness.frames[0]!.some((line) => line.includes("Ctrl+S save")));
});

test("retainedChoice participates in interactive custom menus but RPC/plain fallback does not claim capture", async () => {
  const interactive = createTuiSettingsContext([["\x13"]]);
  installHostMatcher(interactive);
  const control = saveControl();
  assert.equal(await retainedChoice(tuiUi(interactive, control), "Pick one", ["Alpha", "Beta"]), undefined);
  assert.equal(control.saveRequested, true);
  assert.equal(interactive.selectCalls.length, 0);

  const fallback = createTuiSettingsContext([], { selectScript: ["Beta"] });
  installHostMatcher(fallback);
  const fallbackControl = saveControl();
  const hostUi = (fallback.context as { ui: RetainedUi }).ui;
  const rpcUi: RetainedUi = {
    mode: "rpc",
    select: hostUi.select.bind(hostUi),
    custom: hostUi.custom,
    saveControl: fallbackControl,
  };
  assert.equal(await retainedChoice(rpcUi, "Pick one", ["Alpha", "Beta"]), "Beta");
  assert.deepEqual(fallback.selectCalls, [{ title: "Pick one", options: ["Alpha", "Beta"] }]);
  assert.equal(fallbackControl.saveRequested, false);
});

test("Ctrl+S inside a nested permissions submenu propagates staged fields intact", async () => {
  const harness = createTuiSettingsContext([
    [ ...Array.from({ length: 5 }, () => KEY_DOWN), KEY_ENTER ], // Web → Browser permissions
    [ ...Array.from({ length: 5 }, () => KEY_DOWN), KEY_ENTER ], // toggle Model camera
    ["\x13"], // request save from the re-shown permissions menu
  ]);
  installHostMatcher(harness);
  const control = saveControl();
  const ui = tuiUi(harness, control);
  const web = normalizeConfig({}).web!;
  const staged = await selectWebSettings(
    ui,
    web.fetch.maxDownloadBytes,
    web.browserInteractionApproval,
    web.browserIdleExpiryMinutes,
    web.browserDownloadRetention,
    web.browserVisible,
    web.browserPermissions,
  );
  assert.equal(control.saveRequested, true);
  assert.equal(staged.browserPermissions.modelCamera, true, "nested staged permission survives normal returns");
  assert.equal(harness.lists.length, 3, "the signal unwinds permissions then Web without reopening a menu");
  assert.equal(harness.exhausted(), false);
});

function scriptedFormUi(control: SettingsSaveControl, choices: string[], editorResult: string | undefined): UiContext {
  return {
    saveControl: control,
    async select(_title, options) {
      assert.equal(control.suspended, 1, "Create/Edit selection stays inside the suspension bracket");
      const wanted = choices.shift();
      assert.ok(wanted, `unexpected selection: ${options.join(" | ")}`);
      return options.find((option) => option === wanted || option.startsWith(wanted!));
    },
    async editor() {
      assert.equal(control.suspended, 1, "native editor stays inside the suspension bracket");
      return editorResult;
    },
    async input() { assert.fail("editor seam must be preferred"); },
  };
}

test("external Create/Edit suspends Ctrl+S through the complete form and always resumes menus", async () => {
  const config = normalizeConfig({});
  const createControl = saveControl();
  const created = await selectExternalAgentCreation(
    scriptedFormUi(createControl, ["Claude Code", "Identifier:", "Roles:", "Execution only", "Create"], "worker"),
    config,
  );
  assert.equal(created?.id, "worker");
  assert.equal(createControl.suspended, 0);
  assert.equal(createControl.saveRequested, false);
  const resumedMenu = createTuiSettingsContext([["\x13"]]);
  installHostMatcher(resumedMenu);
  assert.equal(await retainedSelect(tuiUi(resumedMenu, createControl), { title: "Returned to catalog", rows: [{ key: "back", label: "Back" }] }), undefined);
  assert.equal(createControl.saveRequested, true, "menus resume Ctrl+S participation after Create returns");

  const editControl = saveControl();
  const existing = normalizeConfig({ externalAgents: { worker: { adapter: "codex-cli", execution: {} } } }).externalAgents!.worker!;
  const edited = await selectExternalAgentEdit(scriptedFormUi(editControl, ["Apply edit"], undefined), config, { id: "worker", ...existing });
  assert.equal(edited?.kind, "apply");
  assert.equal(editControl.suspended, 0);

  const cancelControl = saveControl();
  assert.equal(await selectExternalAgentCreation(scriptedFormUi(cancelControl, ["Claude Code", "Cancel"], undefined), config), undefined);
  assert.equal(cancelControl.suspended, 0, "cancel restores Ctrl+S participation");

  const errorControl = saveControl();
  await assert.rejects(selectExternalAgentCreation({
    ...scriptedFormUi(errorControl, [], undefined),
    async select() { throw new Error("synthetic form failure"); },
  }, config), /synthetic form failure/);
  assert.equal(errorControl.suspended, 0, "failure restores Ctrl+S participation in finally");
});
