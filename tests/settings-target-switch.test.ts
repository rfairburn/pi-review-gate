/**
 * The shared Review editor's caller-supplied target switch (the in-process
 * seam only; no transport, target list, or confirmation UI).
 *
 * - `PersistedReviewSettingsInput.targetControl` makes the root menu show ONE
 *   `Host: <label>` action. Choosing it calls the caller's `requestSwitch` with
 *   whether the staged selection differs from its opening baseline, and:
 *   `true` ends the old transaction with the distinct `switched` outcome (no
 *   Save, validation, image copy, or write); `false` (cancelled picker,
 *   declined dirty confirmation, or the caller's same-target no-op) re-shows
 *   the menu with exactly the same draft.
 * - The dirty state is a VALUE comparison over the shared staged selection:
 *   opening a field, going Back, or re-submitting an unchanged value stays
 *   clean, while a real staged edit — including staged external-worker
 *   operations and the edited-only TTL / already-run bookkeeping — is dirty.
 * - Ctrl+S inside the caller's temporary picker is suspended (it neither
 *   latches a save nor unwinds the picker), the shared held-action fence keeps
 *   the Enter that opened the row claimed, and every other surface keeps its
 *   default Ctrl+S participation.
 * - Without `targetControl` the menu is unchanged (live /review-settings and
 *   the Local editor keep no Host row).
 * - `workspaceInput: "owner"` stages the scheduled-workspace text exactly as
 *   typed (no `~` expansion against the requester's home), while the Local
 *   transaction keeps its existing immediate expansion.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Key, matchesKey } from "pi-session-host-tui";
import { executorEntryId, normalizeConfig, type ReviewGateConfig } from "../src/config";
import {
  registerReviewSettings,
  runPersistedReviewSettings,
  type PersistedReviewSettingsInput,
} from "../src/settings/command";
import { consumeMenuActionFence, retainedSelect, setMenuTuiHost, type RetainedUi } from "../src/settings/menu";
import type { ScopedModelChoice } from "../src/settings/models";
import type { PersistedSaveBackend, StagedPersistedSave } from "../src/settings/persisted-save";
import type { SettingTextEditRequest } from "../src/settings/text-input";
import type { UiContext } from "../src/settings/ui";
import { createTuiSettingsContext, KEY_ENTER, KEY_ESCAPE } from "./menu-tui-fakes";

/** The raw terminal Ctrl+S encoding. */
const CTRL_S = "\x13";
/** Kitty keyboard "repeat"/"release" encodings of Enter (held key). */
const REPEAT_ENTER = "\x1b[13:2u";
const RELEASE_ENTER = "\x1b[13:3u";

// ---------------------------------------------------------------------------
// Scripted plain-selector harness (the RPC/Local path)
// ---------------------------------------------------------------------------

interface ScriptedRun {
  ui: UiContext;
  /** Every menu shown, in order. */
  shown: Array<{ title: string; options: string[] }>;
  notices: Array<{ message: string; type?: string }>;
  /** Every host-owned text field the run opened. */
  textRequests: SettingTextEditRequest[];
  remaining(): number;
}
/**
 * One queued text-field result: the text the field submits, optionally with the
 * native insert observations the host reports for that same edit (the
 * image-paste provenance seam).
 */
type TextStep = string | { text: string; insert?: string };

function scripted(steps: Array<string | undefined>, texts: TextStep[] = []): ScriptedRun {
  const shown: ScriptedRun["shown"] = [];
  const notices: ScriptedRun["notices"] = [];
  const textRequests: SettingTextEditRequest[] = [];
  let index = 0;
  const ui: UiContext = {
    select: async (title, options) => {
      shown.push({ title, options: [...options] });
      assert.ok(index < steps.length, `unexpected extra selection (${title}): ${options.join(" | ")}`);
      const step = steps[index++];
      if (step === undefined) return undefined;
      const match = options.find((option) => option === step) ?? options.find((option) => option.startsWith(step));
      assert.ok(match !== undefined, `missing selection ${step}: ${options.join(" | ")}`);
      return match;
    },
    editText: async (request) => {
      textRequests.push(request);
      const next = texts.shift();
      if (next === undefined) assert.fail(`unexpected text field: ${request.title}`);
      if (typeof next === "string") return next;
      if (next.insert !== undefined) request.options.onHostInsert?.(next.insert);
      return next.text;
    },
    notify: (message, type) => { notices.push({ message, type }); },
  };
  return { ui, shown, notices, textRequests, remaining: () => steps.length - index };
}

interface Fixture {
  dir: string;
  configPath: string;
  original: string;
  /** A fresh disk-shaped config, as the caller would load it. */
  loaded: ReviewGateConfig;
}

async function fixture(body: Record<string, unknown>): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-target-switch-"));
  const configPath = join(dir, "review-gate.json");
  const original = JSON.stringify(body, null, 2);
  await writeFile(configPath, original, "utf8");
  return { dir, configPath, original, loaded: normalizeConfig(JSON.parse(original)) };
}

interface TargetScript {
  control: NonNullable<PersistedReviewSettingsInput["targetControl"]>;
  /** Every `requestSwitch` call's dirty argument, in order. */
  requests: boolean[];
}

function targetControl(label: string, outcomes: boolean[]): TargetScript {
  const requests: boolean[] = [];
  const pending = [...outcomes];
  return {
    requests,
    control: {
      label,
      requestSwitch: async (hasUnsavedChanges: boolean) => {
        requests.push(hasUnsavedChanges);
        return pending.shift() ?? false;
      },
    },
  };
}

function assertNoErrors(run: ScriptedRun): void {
  for (const notice of run.notices) assert.notEqual(notice.type, "error", notice.message);
}

/** Root row list of a scripted show, for Host-row assertions. */
function rootRows(run: ScriptedRun, index = 0): string[] {
  assert.equal(run.shown[index]!.title, "Review settings");
  return run.shown[index]!.options;
}

// ---------------------------------------------------------------------------
// The Host action itself
// ---------------------------------------------------------------------------

test("the root Host action exists only for a caller-supplied target control, once, with its label", async (t) => {
  const f = await fixture({ enabled: true, review: { primaryReviewers: [], subtaskReviewers: [] } });
  t.after(() => rm(f.dir, { recursive: true, force: true }));

  // (a) The Local editor and every other caller without a target control: the
  // root rows are exactly the ones they had before this seam existed.
  const plain = scripted([undefined]);
  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: plain.ui, scoped: [] }),
    { kind: "discarded" },
  );
  assert.equal(rootRows(plain).some((option) => option.startsWith("Host:")), false);

  // (b) With a target control: exactly ONE Host row, first, carrying the label.
  const target = targetControl("beta", []);
  const run = scripted(["Host: beta", "Cancel"]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [],
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  const root = rootRows(run);
  assert.equal(root.filter((option) => option.startsWith("Host:")).length, 1);
  assert.equal(root[0], "Host: beta");
  assert.ok(root.includes("Save changes"));
  assert.ok(root.includes("Cancel"));
  assert.ok(root.some((option) => option.startsWith("Operating mode")));
  assert.deepEqual(target.requests, [false], "the fresh draft reaches the caller as clean");
  assert.equal(run.remaining(), 0);
  assertNoErrors(run);
});

test("the live /review-settings menu keeps no Host row", async (t) => {
  const f = await fixture({ enabled: false, review: { primaryReviewers: [], subtaskReviewers: [] } });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  registerReviewSettings({
    pi: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        if (name === "review-settings") handler = options.handler;
      },
    },
    config: f.loaded,
    configPath: f.configPath,
  });
  assert.ok(handler);
  const run = scripted(["Cancel"]);
  await handler("", { ui: run.ui });
  assert.equal(rootRows(run).some((option) => option.startsWith("Host:")), false);
});

// ---------------------------------------------------------------------------
// Declined versus accepted switch
// ---------------------------------------------------------------------------

test("a declined switch re-shows the same draft, then Save persists the staged edit", async (t) => {
  const f = await fixture({ enabled: true, youShouldKnow: { enabled: true, completionGuidance: true } });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const target = targetControl("beta", [false]);
  const run = scripted(["Tools", "YouShouldKnow notices", undefined, "Host: beta", "Save changes"]);
  const outcome = await runPersistedReviewSettings({
    config: f.loaded,
    configPath: f.configPath,
    ui: run.ui,
    scoped: [],
    targetControl: target.control,
  });
  assertNoErrors(run);
  assert.equal(outcome.kind, "saved");
  assert.deepEqual(target.requests, [true], "the staged toggle reaches the caller as unsaved");
  // The decline closed nothing: the root re-shows with the same Host row and
  // the same staged draft, and the following Save persists that draft.
  const reopened = run.shown.at(-1)!;
  assert.equal(reopened.title, "Review settings");
  assert.equal(reopened.options[0], "Host: beta");
  assert.deepEqual(JSON.parse(await readFile(f.configPath, "utf8")).youShouldKnow, { enabled: false, completionGuidance: true });
  // The nested menus never gain a Host row.
  for (const shown of run.shown) {
    if (shown.title === "Review settings") continue;
    assert.equal(shown.options.some((option) => option.startsWith("Host:")), false, shown.title);
  }
});

test("an accepted switch ends the old transaction without Save, validation, or a write", async (t) => {
  // A config that loads fine but fails Save-time validation (an unscoped Pi
  // executor), so a Save/validation attempt would be visible as an error
  // notice instead of a switch.
  const f = await fixture({
    enabled: true,
    execution: {
      workerResources: { r: { selection: { source: "pi", model: "synthetic/unscoped" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "r" }], research: [] },
    },
  });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  let saves = 0;
  const backend: PersistedSaveBackend = {
    saveStaged: async () => {
      saves += 1;
      throw new Error("an accepted target switch must never reach a Save backend");
    },
  };
  const target = targetControl("beta", [true]);
  const run = scripted(["Tools", "YouShouldKnow notices", undefined, "Host: beta"]);
  const outcome = await runPersistedReviewSettings({
    config: f.loaded,
    configPath: f.configPath,
    ui: run.ui,
    scoped: [],
    targetControl: target.control,
    backend,
  });
  assert.deepEqual(outcome, { kind: "switched" });
  assert.deepEqual(target.requests, [true]);
  assert.equal(saves, 0, "no Save backend call");
  assert.deepEqual(run.notices, [], "no validation error, no Save notice, no switch notice of its own");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "nothing was written");
  assert.equal(run.remaining(), 0, "the menu closed on the accepted switch");
});

// ---------------------------------------------------------------------------
// Clean versus dirty staged state
// ---------------------------------------------------------------------------

test("opening a section, going Back, and re-submitting unchanged values keep the draft clean", async (t) => {
  const f = await fixture({ enabled: true, review: { primaryReviewers: [], subtaskReviewers: [] } });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const target = targetControl("beta", [false, false, false]);
  const run = scripted(
    // A first Host press on the untouched draft.
    ["Host: beta",
      // Open the Tools submenu and Back out again.
      "Tools", undefined,
      // Open the retry policy, re-submit the SAME retry value, and Back.
      "Retry policy", "Retries after initial attempt", "Back",
      // A second Host press.
      "Host: beta",
      // Leave.
      "Cancel"],
    ["2"],
  );
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [],
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(run);
  assert.deepEqual(target.requests, [false, false], "no prompted switch for opening/Back/unchanged values");
  assert.equal(run.textRequests[0]!.currentValue, "2", "the unchanged value was re-submitted verbatim");
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

test("a staged external-worker edit counts as dirty even though the model picker kept the current model", async (t) => {
  const f = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    externalAgents: { alpha: { adapter: "claude-cli", model: "claude-opus-5-5", execution: {} } },
  });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const target = targetControl("beta", [false]);
  const run = scripted([
    "External workers",
    "alpha", // the definition row
    "Shared model", // keep the SAME model
    "Keep current model",
    "Apply edit",
    "Back",
    "Host: beta",
    "Cancel",
  ]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [],
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assert.deepEqual(target.requests, [true], "a staged external-worker operation is an unsaved change");
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

test("re-submitting the prefilled cleanup age stays clean; a different age is dirty", async (t) => {
  // An accepted entry whose EFFECTIVE value equals the opening value is not an
  // edit and must not prompt, even though Save only carries the field once
  // this transaction edited it.
  const cleanFixture = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    waveArtifactTtlMs: 21_600_000,
  });
  t.after(() => rm(cleanFixture.dir, { recursive: true, force: true }));
  const cleanTarget = targetControl("beta", [false]);
  const clean = scripted(["Retention", "Wave artifact cleanup age", "Back", "Host: beta", "Cancel"], ["6h"]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: cleanFixture.loaded,
      configPath: cleanFixture.configPath,
      ui: clean.ui,
      scoped: [],
      targetControl: cleanTarget.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(clean);
  assert.equal(clean.textRequests[0]!.currentValue, "6h", "the field prefilled the same age");
  assert.deepEqual(cleanTarget.requests, [false], "an unchanged re-submitted age is not an edit");
  assert.equal(await readFile(cleanFixture.configPath, "utf8"), cleanFixture.original);

  // A genuinely different accepted age is dirty.
  const changedFixture = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    waveArtifactTtlMs: 21_600_000,
  });
  t.after(() => rm(changedFixture.dir, { recursive: true, force: true }));
  const changedTarget = targetControl("beta", [false]);
  const changed = scripted(["Retention", "Wave artifact cleanup age", "Back", "Host: beta", "Cancel"], ["12h"]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: changedFixture.loaded,
      configPath: changedFixture.configPath,
      ui: changed.ui,
      scoped: [],
      targetControl: changedTarget.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(changed);
  assert.deepEqual(changedTarget.requests, [true], "a different accepted age is an unsaved change");
  assert.equal(await readFile(changedFixture.configPath, "utf8"), changedFixture.original);
});

test("editing a scheduled task whose id is __proto__ counts as dirty", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-proto-ws-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  // A configured id may be any validated key, `__proto__` included: build the
  // catalog with an OWN __proto__ data property so the fixture really stores
  // it (an object-literal key would set the prototype instead).
  const scheduledTasks: Record<string, unknown> = {};
  Object.defineProperty(scheduledTasks, "__proto__", {
    value: { name: "Prototype task", cron: "0 9 * * *", enabled: true, kind: "execute", instructions: "Run", workspace },
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const f = await fixture({ enabled: true, review: { primaryReviewers: [], subtaskReviewers: [] }, scheduledTasks });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  assert.equal(
    Object.prototype.hasOwnProperty.call(f.loaded.scheduledTasks ?? {}, "__proto__"),
    true,
    "the fixture carries a real own __proto__ task id",
  );
  const target = targetControl("beta", [false]);
  const run = scripted([
    "Scheduled tasks",
    "1. Prototype task",
    "Enabled", // toggle it Off
    "Back",
    "Back",
    "Host: beta",
    "Cancel",
  ]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [],
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(run);
  assert.deepEqual(target.requests, [true], "an edit to a __proto__-id task is a real staged change");
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

test("an edited-only already-run state counts as dirty even when the value round-trips", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-target-ws-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const f = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Once",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Run once",
        workspace,
        oneShot: true,
      },
    },
  });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const target = targetControl("beta", [false]);
  const run = scripted([
    "Scheduled tasks",
    "1. Once",
    // Toggle Already run to Yes, then back to No: the displayed value returns
    // to its opening spelling, but an explicit already-run toggle is staged
    // OVERRIDE state — Save must honor it over a scheduler value recorded
    // meanwhile — so the draft is genuinely unsaved. (Unlike a re-submitted
    // cleanup age, this is not a prefilled value accepted unchanged.)
    "Already run",
    "Already run",
    "Back",
    "Back",
    "Host: beta",
    "Cancel",
  ]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [],
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(run);
  assert.deepEqual(target.requests, [true], "an explicit already-run edit is an unsaved change");
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

// ---------------------------------------------------------------------------
// Ctrl+S isolation and the shared held-action fence
// ---------------------------------------------------------------------------

test("Ctrl+S inside the caller's temporary picker is not latched; the fence keeps the opening Enter claimed", async (t) => {
  const f = await fixture({ enabled: true, review: { primaryReviewers: [], subtaskReviewers: [] } });
  t.after(() => rm(f.dir, { recursive: true, force: true }));

  const harness = createTuiSettingsContext([
    [KEY_ENTER], // root row 0 is the Host action
    [CTRL_S, KEY_ESCAPE], // the caller's temporary picker: Ctrl+S must be inert
    [KEY_ESCAPE], // the re-shown root: a real Escape discards
  ]);
  setMenuTuiHost({ ...harness.host, matchesCtrlS: (data) => matchesKey(data, Key.ctrl("s")) });
  t.after(() => setMenuTuiHost(undefined));
  const ui = Object.assign({}, (harness.context as { ui: UiContext }).ui, { mode: "tui" }) as UiContext;

  const requests: boolean[] = [];
  const observations: Array<{ suspended: number; claimed: boolean; latched: boolean }> = [];
  const outcome = await runPersistedReviewSettings({
    config: f.loaded,
    configPath: f.configPath,
    ui,
    scoped: [],
    targetControl: {
      label: "alpha",
      requestSwitch: async (hasUnsavedChanges: boolean) => {
        requests.push(hasUnsavedChanges);
        observations.push({
          suspended: ui.saveControl?.suspended ?? 0,
          // The Enter that opened the Host row is still claimed on the shared
          // fence, so its held repeat can never confirm this picker.
          claimed: consumeMenuActionFence(ui.saveControl, REPEAT_ENTER),
          latched: ui.saveControl?.saveRequested === true,
        });
        const picked = await retainedSelect(ui as RetainedUi, {
          title: "Select review host",
          rows: [{ key: "beta", label: "beta" }, { key: "alpha", label: "alpha" }],
        });
        // A held Enter release ends the claim without confirming anything.
        consumeMenuActionFence(ui.saveControl, RELEASE_ENTER);
        return picked === "beta";
      },
    },
  });

  assert.deepEqual(outcome, { kind: "discarded" });
  assert.deepEqual(requests, [false], "the untouched draft reaches the caller as clean");
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.suspended, 1, "Ctrl+S is suspended for the whole switch request");
  assert.equal(observations[0]!.claimed, true, "the root's Enter claim survives into the picker");
  assert.equal(observations[0]!.latched, false);
  assert.equal(ui.saveControl?.suspended, 0, "Ctrl+S participation is restored after the request");
  assert.equal(ui.saveControl?.saveRequested, false, "the picker's Ctrl+S never latched a save");
  assert.equal(harness.exhausted(), false);
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "the declined picker wrote nothing");
  assert.ok(!harness.notifyCalls.some((call) => /saved to disk/.test(call.message)), "no save ran");
  // The root frame really carried the Host action the Enter selected.
  assert.ok(harness.frames[0]!.some((line) => line.includes("Host: alpha")));
});

test("Ctrl+S outside the switch request keeps its ordinary save behavior", async (t) => {
  const f = await fixture({ enabled: true, review: { primaryReviewers: [], subtaskReviewers: [] } });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const harness = createTuiSettingsContext([[CTRL_S]]);
  setMenuTuiHost({ ...harness.host, matchesCtrlS: (data) => matchesKey(data, Key.ctrl("s")) });
  t.after(() => setMenuTuiHost(undefined));
  const ui = Object.assign({}, (harness.context as { ui: UiContext }).ui, { mode: "tui" }) as UiContext;
  const target = targetControl("alpha", []);
  const outcome = await runPersistedReviewSettings({
    config: f.loaded,
    configPath: f.configPath,
    ui,
    scoped: [],
    targetControl: target.control,
  });
  assert.equal(outcome.kind, "saved");
  assert.deepEqual(target.requests, [], "the switch was never requested");
  assert.ok(harness.notifyCalls.some((call) => /saved to disk/.test(call.message)));
  assert.equal(ui.saveControl?.saveRequested, false, "the latch was consumed by the Save");
});

// ---------------------------------------------------------------------------
// Scheduled workspace spelling (owner versus local)
// ---------------------------------------------------------------------------

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

async function writeScheduledFixture(workspace: string): Promise<Fixture> {
  return await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Nightly check",
        cron: "30 2 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Check the docs for staleness",
        workspace,
      },
    },
  });
}

const WORKSPACE_STEPS = [
  "Scheduled tasks",
  "1. Nightly check",
  "Workspace",
  // entry re-show after the accepted text: Back
  "Back",
  // list re-show: Back
  "Back",
];

test("workspaceInput owner stages the target spelling until the owner Save", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pi-review-requester-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  withFixtureHome(home, t);

  const f = await writeScheduledFixture("/owner/host/workspace");
  t.after(() => rm(f.dir, { recursive: true, force: true }));

  const staged: StagedPersistedSave[] = [];
  const backend: PersistedSaveBackend = {
    saveStaged: async (request) => {
      staged.push(request);
      return {
        kind: "saved",
        config: request.config,
        scheduledTasks: request.selection.scheduledTasks,
        warnings: [],
        scheduleDisableWarnings: [],
        scheduleDisableTaskIds: [],
        toolProtectionWarnings: [],
      };
    },
  };
  const run = scripted([...WORKSPACE_STEPS, "Save changes"], ["~/remote/workspace"]);
  const outcome = await runPersistedReviewSettings({
    config: f.loaded,
    configPath: f.configPath,
    ui: run.ui,
    scoped: [],
    backend,
    workspaceInput: "owner",
  });

  assertNoErrors(run);
  assert.equal(outcome.kind, "saved");
  assert.equal(run.textRequests[0]!.title, "Authorized target workspace directory");
  assert.equal(run.textRequests[0]!.currentValue, "/owner/host/workspace");
  assert.equal(staged.length, 1, "the owner Save received the staged payload");
  assert.equal(
    staged[0]!.selection.scheduledTasks["task-abcdef12"]!.workspace,
    "~/remote/workspace",
    "the requester never substitutes its own home into the owner's workspace",
  );
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "the delegating backend owns the write");
});

test("re-submitting a Local workspace with a home prefix stays clean; a real path edit is dirty", async (t) => {
  // A Local config may store `~/project`. The workspace field stages the
  // EXPANDED spelling when that exact prefill is re-submitted, so the switch
  // comparison expands the opening spelling the same way instead of calling an
  // unchanged workspace an edit. Neither directory needs to exist: the
  // comparison is lexical, and no Save (hence no workspace probe) runs.
  const home = await mkdtemp(join(tmpdir(), "pi-review-local-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  withFixtureHome(home, t);
  const f = await writeScheduledFixture("~/project");
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  assert.equal(f.loaded.scheduledTasks!["task-abcdef12"]!.workspace, "~/project", "the loaded config keeps the home spelling");
  const target = targetControl("beta", [false, false]);
  const run = scripted(
    [...WORKSPACE_STEPS, "Host: beta", ...WORKSPACE_STEPS, "Host: beta", "Cancel"],
    ["~/project", "~/different"],
  );
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [],
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(run);
  assert.equal(run.textRequests[0]!.currentValue, "~/project", "the field prefill keeps the stored spelling");
  assert.deepEqual(
    target.requests,
    [false, true],
    "an unchanged home spelling is clean; a different workspace is an unsaved change",
  );
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

test("the Local editor keeps expanding a typed home prefix before Save", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "pi-review-local-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "remote", "workspace"), { recursive: true });
  withFixtureHome(home, t);

  const f = await writeScheduledFixture(home);
  t.after(() => rm(f.dir, { recursive: true, force: true }));

  const run = scripted([...WORKSPACE_STEPS, "Save changes"], ["~/remote/workspace"]);
  const outcome = await runPersistedReviewSettings({
    config: f.loaded,
    configPath: f.configPath,
    ui: run.ui,
    scoped: [],
  });

  assertNoErrors(run);
  assert.equal(outcome.kind, "saved");
  assert.equal(
    JSON.parse(await readFile(f.configPath, "utf8")).scheduledTasks["task-abcdef12"].workspace,
    join(home, "remote", "workspace"),
    "the Local transaction keeps its existing immediate home expansion",
  );
});

test("reselecting the current Subtask destination stays clean; changing it is dirty", async (t) => {
  // Config loading accepts and preserves an explicit destination: "subtask",
  // but choosing that same Subtask option removes the redundant key. Both
  // spellings are the same scheduled destination and must not look edited.
  const f = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Nightly check",
        cron: "30 2 * * *",
        kind: "execute",
        enabled: true,
        instructions: "Check docs",
        workspace: "/owner/project",
        destination: "subtask",
      },
    },
  });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  assert.equal(
    f.loaded.scheduledTasks!["task-abcdef12"]!.destination,
    "subtask",
    "the loaded config preserves the explicit Subtask destination",
  );
  const target = targetControl("beta", [false, false]);
  const editDestination = (choice: string) => [
    "Scheduled tasks",
    "1. Nightly check",
    "Destination",
    choice,
    "Back",
    "Back",
  ];
  const run = scripted([
    ...editDestination("Subtask — isolated scheduled subtask (default)  current"), "Host: beta",
    ...editDestination("Orchestrator turn"), "Host: beta",
    "Cancel",
  ]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [],
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(run);
  assert.deepEqual(
    target.requests,
    [false, true],
    "the same effective destination is clean; a real destination change is dirty",
  );
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

test("owner-mode workspace text is never expanded against the requester during the switch comparison", async (t) => {
  // OWNER spelling belongs to another host's home. A requester's absolute
  // spelling of the same-looking path is a DIFFERENT workspace text for the
  // owner, so it must stay an edit — the Local-only comparison expansion must
  // never reach owner mode.
  const home = await mkdtemp(join(tmpdir(), "pi-review-owner-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  withFixtureHome(home, t);
  const f = await writeScheduledFixture("~/project");
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const target = targetControl("beta", [false]);
  const run = scripted([...WORKSPACE_STEPS, "Host: beta", "Cancel"], [join(home, "project")]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [],
      workspaceInput: "owner",
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(run);
  assert.deepEqual(
    target.requests,
    [true],
    "the owner's home spelling and the requester's absolute path remain different workspace text",
  );
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

// ---------------------------------------------------------------------------
// Representation-preserving no-ops (reasoning pickers) and staged image repair
// ---------------------------------------------------------------------------

const SCOPED_DEEP = {
  model: "acme/deep",
  label: "deep [acme]",
  pinnedThinkingLevel: "medium" as const,
  supportedThinkingLevels: ["off", "low", "medium", "high"] as const,
};

test("no-op reasoning edits in either global reviewer list leave the draft clean", async (t) => {
  // Repeated entries for one model at different levels: the shared picker
  // displays the FIRST entry's level and would write it to every matching
  // entry on Escape or a current-row reselect.
  const reviewers = [
    { source: "pi", model: SCOPED_DEEP.model, thinkingLevel: "medium" },
    { source: "pi", model: SCOPED_DEEP.model, thinkingLevel: "low" },
  ];
  const f = await fixture({ enabled: true, review: { primaryReviewers: reviewers, subtaskReviewers: reviewers } });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const target = targetControl("beta", [false, false]);
  const run = scripted([
    "Reviewers",
    "Primary reviewers",
    "Reasoning",
    undefined, // Escape: no change
    "Back", // reviewer list
    "Back", // review section
    "Host: beta",
    "Reviewers",
    "Subtask reviewers",
    "Reasoning",
    "Medium  current", // reselect the row marked current
    "Back",
    "Back",
    "Host: beta",
    "Cancel",
  ]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: scopedDeepModel(),
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(run);
  assert.deepEqual(target.requests, [false, false], "no-op reasoning edits in either layer are not changes");
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

test("a cancelled or current reasoning picker keeps an omitted route level clean; a real change is dirty", async (t) => {
  const f = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    execution: {
      workerResources: { r: { selection: { source: "pi", model: "acme/deep" }, maxConcurrent: 1 } },
      // Saved route entry omits thinkingLevel entirely.
      routes: { execute: [{ resourceId: "r" }], research: [] },
    },
  });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  assert.equal(
    f.loaded.execution!.routes!.execute![0]!.thinkingLevel,
    undefined,
    "the opening route entry selects no explicit thinking level",
  );
  const target = targetControl("beta", [false, false, false]);
  const editThinking = (choice: string | undefined) => [
    "Execution priority",
    "1. deep",
    "Thinking",
    choice,
    "Back", // entry editor
    "Back", // route list
  ];
  const run = scripted([
    // Cancel the reasoning picker.
    ...editThinking(undefined), "Host: beta",
    // Reselect the row marked current.
    ...editThinking("Medium  current"), "Host: beta",
    // Actually change the level.
    ...editThinking("High"), "Host: beta",
    "Cancel",
  ]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [{ ...SCOPED_DEEP, supportedThinkingLevels: [...SCOPED_DEEP.supportedThinkingLevels] }],
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(run);
  assert.deepEqual(
    target.requests,
    [false, false, true],
    "cancel and current-choice keep the omitted representation; High is a real change",
  );
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

test("a cancelled or current reasoning picker keeps an omitted scheduled-reviewer level clean; a real change is dirty", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-reviewer-ws-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const f = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Nightly check",
        cron: "30 2 * * *",
        kind: "execute",
        enabled: true,
        instructions: "Check docs",
        workspace,
        // Selected Pi reviewer that omits thinkingLevel.
        review: { mode: "selected", reviewers: [{ source: "pi", model: "acme/deep" }] },
      },
    },
  });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const target = targetControl("beta", [false, false, false]);
  const editReviewerThinking = (choice: string | undefined) => [
    "Scheduled tasks",
    "1. Nightly check",
    "Review",
    "Select reviewers",
    "Reasoning",
    choice,
    "Back", // reviewer list
    "Back", // entry editor
    "Back", // task list
  ];
  const run = scripted([
    ...editReviewerThinking(undefined), "Host: beta",
    ...editReviewerThinking("Medium  current"), "Host: beta",
    ...editReviewerThinking("High"), "Host: beta",
    "Cancel",
  ]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [{ ...SCOPED_DEEP, supportedThinkingLevels: [...SCOPED_DEEP.supportedThinkingLevels] }],
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(run);
  assert.deepEqual(
    target.requests,
    [false, false, true],
    "cancel and current-choice keep the omitted representation; High is a real change",
  );
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

test("accepting an observed paste of an already-referenced clipboard image is dirty; text-only edits are not", async (t) => {
  const clipboardPath = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  const instructions = `Analyze ${clipboardPath} for visual changes`;
  const makeFixture = async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pi-review-image-ws-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));
    const created = await fixture({
      enabled: true,
      review: { primaryReviewers: [], subtaskReviewers: [] },
      scheduledTasks: {
        "task-abcdef12": {
          name: "Nightly check",
          cron: "30 2 * * *",
          kind: "execute",
          enabled: true,
          instructions,
          workspace,
        },
      },
    });
    t.after(() => rm(created.dir, { recursive: true, force: true }));
    return created;
  };
  const steps = ["Scheduled tasks", "1. Nightly check", "Instructions", "Back", "Back", "Host: beta", "Cancel"];

  // Same text, no accepted host insert: Save has no new provenance to use.
  const unobserved = await makeFixture();
  const unobservedTarget = targetControl("beta", [false]);
  const unobservedRun = scripted(steps, [instructions]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: unobserved.loaded,
      configPath: unobserved.configPath,
      ui: unobservedRun.ui,
      scoped: [],
      targetControl: unobservedTarget.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(unobservedRun);
  assert.deepEqual(
    unobservedTarget.requests,
    [false],
    "re-submitting the same text without an observed paste is not an edit",
  );

  // Same text, but the host reports the clipboard path as an accepted insert:
  // Save can now verify and repair that reference, so the repair must survive
  // a target switch only with confirmation.
  const observed = await makeFixture();
  const observedTarget = targetControl("beta", [false]);
  const observedRun = scripted(steps, [{ text: instructions, insert: clipboardPath }]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: observed.loaded,
      configPath: observed.configPath,
      ui: observedRun.ui,
      scoped: [],
      targetControl: observedTarget.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(observedRun);
  assert.deepEqual(
    observedTarget.requests,
    [true],
    "an accepted observed paste of the referenced clipboard path is a staged repair",
  );
  // Neither run wrote or validated anything.
  assert.equal(await readFile(unobserved.configPath, "utf8"), unobserved.original);
  assert.equal(await readFile(observed.configPath, "utf8"), observed.original);
});

test("a cancelled or current reasoning picker keeps an omitted auditor level clean; a real change is dirty", async (t) => {
  const f = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    toolProtection: {
      level: "aligned",
      // Selected Pi auditor that omits thinkingLevel.
      auditor: { source: "pi", model: "acme/deep" },
      scope: "all",
      toolNames: [],
    },
  });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const target = targetControl("beta", [false, false, false]);
  const editAuditorThinking = (choice: string | undefined) => [
    "Tools",
    "Tool protection",
    "Auditor",
    "deep [acme]",
    choice,
    "Back", // tool protection
    "Back", // Tools
  ];
  const run = scripted([
    ...editAuditorThinking(undefined), "Host: beta",
    ...editAuditorThinking("Medium  current"), "Host: beta",
    ...editAuditorThinking("High"), "Host: beta",
    "Cancel",
  ]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [{ ...SCOPED_DEEP, supportedThinkingLevels: [...SCOPED_DEEP.supportedThinkingLevels] }],
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(run);
  assert.deepEqual(
    target.requests,
    [false, false, true],
    "cancel and current-choice keep the omitted representation; High is a real change",
  );
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

/** Two selected entries for ONE model: the first omits the level. */
const REPEATED_REVIEWERS = [
  { source: "pi", model: "acme/deep" },
  { source: "pi", model: "acme/deep", thinkingLevel: "medium" },
] as const;

function scopedDeepModel(): ScopedModelChoice[] {
  return [{ ...SCOPED_DEEP, supportedThinkingLevels: [...SCOPED_DEEP.supportedThinkingLevels] }];
}

/**
 * An orchestrator-turn task keeps a dormant selected-reviewer override with two
 * entries for the same scoped Pi model (pinned to medium): the first without a
 * level, the second explicit medium.
 */
async function repeatedReviewerFixture(t: { after(callback: () => void): void }): Promise<Fixture> {
  const f = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Daily summary",
        cron: "0 9 * * *",
        kind: "execute",
        enabled: true,
        destination: "orchestrator-turn",
        instructions: "Summarize the day",
        workspace: "/owner/project",
        review: { mode: "selected", reviewers: REPEATED_REVIEWERS },
      },
    },
  });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  return f;
}

test("leaving Scheduled tasks untouched never rewrites repeated reviewer entries for one model", async (t) => {
  // Merely opening the submenu and going Back must leave BOTH entries exactly
  // as stored, never cross-assign one entry's representation to the other.
  const f = await repeatedReviewerFixture(t);
  const target = targetControl("beta", [false]);
  const run = scripted(["Scheduled tasks", "Back", "Host: beta", "Save changes"]);
  const outcome = await runPersistedReviewSettings({
    config: f.loaded,
    configPath: f.configPath,
    ui: run.ui,
    scoped: scopedDeepModel(),
    targetControl: target.control,
  });
  assertNoErrors(run);
  assert.equal(outcome.kind, "saved");
  assert.deepEqual(target.requests, [false], "an untouched repeated reviewer list is not an edit");
  const saved = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.deepEqual(
    saved.scheduledTasks["task-abcdef12"].review.reviewers,
    [...REPEATED_REVIEWERS],
    "each stored reviewer entry keeps its own reasoning representation",
  );
});

test("cancelling the shared reasoning picker for repeated reviewers keeps both prior levels; a real change is dirty", async (t) => {
  // The shared picker shows the FIRST entry's effective level and writes the
  // returned level to every occurrence of that model, even on Escape.
  const editReview = (choice: string | undefined) => [
    "Scheduled tasks",
    "1. Daily summary",
    "Review",
    "Select reviewers",
    "Reasoning",
    choice,
    "Back", // reviewer list
    "Back", // entry editor
    "Back", // task list
  ];

  const cancelled = await repeatedReviewerFixture(t);
  const cancelledTarget = targetControl("beta", [false]);
  const cancelledRun = scripted([...editReview(undefined), "Host: beta", "Save changes"]);
  const cancelledOutcome = await runPersistedReviewSettings({
    config: cancelled.loaded,
    configPath: cancelled.configPath,
    ui: cancelledRun.ui,
    scoped: scopedDeepModel(),
    targetControl: cancelledTarget.control,
  });
  assertNoErrors(cancelledRun);
  assert.equal(cancelledOutcome.kind, "saved");
  assert.deepEqual(cancelledTarget.requests, [false], "a cancelled picker is not an edit");
  const saved = JSON.parse(await readFile(cancelled.configPath, "utf8"));
  assert.deepEqual(
    saved.scheduledTasks["task-abcdef12"].review.reviewers,
    [...REPEATED_REVIEWERS],
    "Save keeps each entry's original reasoning representation",
  );

  const changed = await repeatedReviewerFixture(t);
  const changedTarget = targetControl("beta", [false]);
  const changedRun = scripted([...editReview("High"), "Host: beta", "Cancel"]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: changed.loaded,
      configPath: changed.configPath,
      ui: changedRun.ui,
      scoped: scopedDeepModel(),
      targetControl: changedTarget.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(changedRun);
  assert.deepEqual(changedTarget.requests, [true], "a different level is a real change");
  assert.equal(await readFile(changed.configPath, "utf8"), changed.original);
});

test("adding and removing a task with an edited Already run state leaves the draft clean", async (t) => {
  // The override is only meaningful for a task still in the draft; Save never
  // consults it for an absent one. An orphaned id must not prompt a switch.
  const f = await fixture({ enabled: true, review: { primaryReviewers: [], subtaskReviewers: [] } });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const target = targetControl("beta", [false]);
  const run = scripted(
    ["Scheduled tasks", "Add scheduled task", "One shot", "Already run", "Remove", "Back", "Host: beta", "Cancel"],
    ["Temporary task"],
  );
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [],
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(run);
  assert.deepEqual(
    target.requests,
    [false],
    "the removed task's already-run override is not a staged change",
  );
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

test("a review override recreated from Off keeps its new level and reports a real change", async (t) => {
  // The reviewer-dialog baseline is the list THAT DIALOG opened with, not the
  // catalog from before the whole visit. Replacing a dormant xhigh override
  // with Off and then building a new selection must never resurrect xhigh.
  const f = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Daily summary",
        cron: "0 9 * * *",
        kind: "execute",
        enabled: true,
        destination: "orchestrator-turn",
        instructions: "Summarize the day",
        workspace: "/owner/project",
        review: { mode: "selected", reviewers: [{ source: "pi", model: "acme/deep", thinkingLevel: "xhigh" }] },
      },
    },
  });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const target = targetControl("beta", [false]);
  const run = scripted([
    "Scheduled tasks",
    "1. Daily summary",
    "Review",
    "Off", // clear the dormant override
    "Review", // re-open the picker from Off
    "Select reviewers",
    "deep [acme]", // new selection: add the scoped model
    "Medium  current", // accept the supported level
    "Back", // reviewer list
    "Back", // entry editor
    "Back", // task list
    "Host: beta",
    "Save changes",
  ]);
  const outcome = await runPersistedReviewSettings({
    config: f.loaded,
    configPath: f.configPath,
    ui: run.ui,
    scoped: scopedDeepModel(),
    targetControl: target.control,
  });
  assertNoErrors(run);
  assert.equal(outcome.kind, "saved");
  assert.deepEqual(
    target.requests,
    [true],
    "replacing a review override is a real change, not a no-op reasoning round trip",
  );
  const saved = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.deepEqual(
    saved.scheduledTasks["task-abcdef12"].review,
    { mode: "selected", reviewers: [{ source: "pi", model: "acme/deep", thinkingLevel: "medium" }] },
    "the intentionally chosen level is what Save persists",
  );
});

// ---------------------------------------------------------------------------
// Remove/re-add recreations (leaf-editor no-op opt-in)
// ---------------------------------------------------------------------------

/** A stored xhigh level that the scoped model cannot offer (Medium/High only). */
const STALE_LEVEL = "xhigh";

test("removing and re-adding a scheduled reviewer keeps the new level and reports a real change", async (t) => {
  const f = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Daily summary",
        cron: "0 9 * * *",
        kind: "execute",
        enabled: true,
        destination: "orchestrator-turn",
        instructions: "Summarize the day",
        workspace: "/owner/project",
        review: { mode: "selected", reviewers: [{ source: "pi", model: "acme/deep", thinkingLevel: STALE_LEVEL }] },
      },
    },
  });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const target = targetControl("beta", [false]);
  const run = scripted([
    "Scheduled tasks",
    "1. Daily summary",
    "Review",
    "Select reviewers",
    "deep [acme]", // remove
    "deep [acme]", // re-add (opens the reasoning picker)
    "Medium  current",
    "Back", // reviewer list
    "Back", // entry editor
    "Back", // task list
    "Host: beta",
    "Save changes",
  ]);
  const outcome = await runPersistedReviewSettings({
    config: f.loaded,
    configPath: f.configPath,
    ui: run.ui,
    scoped: scopedDeepModel(),
    targetControl: target.control,
  });
  assertNoErrors(run);
  assert.equal(outcome.kind, "saved");
  assert.deepEqual(target.requests, [true], "a recreated reviewer is a real change");
  const saved = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.deepEqual(
    saved.scheduledTasks["task-abcdef12"].review.reviewers,
    [{ source: "pi", model: "acme/deep", thinkingLevel: "medium" }],
    "the intentionally chosen level survives instead of the stale stored one",
  );
});

test("excluding and re-adding a route entry keeps the new level and reports a real change", async (t) => {
  const f = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    execution: {
      workerResources: { r: { selection: { source: "pi", model: "acme/deep" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "r", thinkingLevel: STALE_LEVEL }], research: [] },
    },
  });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const target = targetControl("beta", [false]);
  const run = scripted([
    "Execution priority",
    "1. deep",
    "Exclude from this route",
    "Add resource",
    "deep [acme]",
    "Back", // route list
    "Host: beta",
    "Save changes",
  ]);
  const outcome = await runPersistedReviewSettings({
    config: f.loaded,
    configPath: f.configPath,
    ui: run.ui,
    scoped: scopedDeepModel(),
    targetControl: target.control,
  });
  assertNoErrors(run);
  assert.equal(outcome.kind, "saved");
  assert.deepEqual(target.requests, [true], "a re-added route entry is a real change");
  const saved = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.deepEqual(
    saved.execution.routes.execute,
    [{ resourceId: "r", thinkingLevel: "medium" }],
    "the re-added entry keeps its new level instead of the stale stored one",
  );
});

test("clearing and reselecting the auditor keeps the new level and reports a real change", async (t) => {
  const f = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    toolProtection: {
      level: "off",
      auditor: { source: "pi", model: "acme/deep", thinkingLevel: STALE_LEVEL },
      scope: "all",
      toolNames: [],
    },
  });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const target = targetControl("beta", [false]);
  const run = scripted([
    "Tools",
    "Tool protection",
    "Auditor",
    "No auditor", // clear
    "Auditor",
    "deep [acme]", // reselect
    "Medium  current",
    "Back", // tool protection
    "Back", // Tools
    "Host: beta",
    "Save changes",
  ]);
  const outcome = await runPersistedReviewSettings({
    config: f.loaded,
    configPath: f.configPath,
    ui: run.ui,
    scoped: scopedDeepModel(),
    targetControl: target.control,
  });
  assertNoErrors(run);
  assert.equal(outcome.kind, "saved");
  assert.deepEqual(target.requests, [true], "a re-selected auditor is a real change");
  const saved = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.deepEqual(
    saved.toolProtection.auditor,
    { source: "pi", model: "acme/deep", thinkingLevel: "medium" },
    "the re-selected auditor keeps its new level instead of the stale stored one",
  );
});

// ---------------------------------------------------------------------------
// Passive route visits (target-aware) versus the existing reconciliation
// ---------------------------------------------------------------------------

/**
 * A stored research-priority entry on a resource that supports execution but
 * NOT research (`run-as-binary`): the config loads, the research editor's
 * eligible catalog excludes the resource, and Save rejects the stored entry.
 */
async function ineligibleResearchFixture(t: { after(callback: () => void): void }): Promise<Fixture> {
  const f = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    externalAgents: {
      "binary-worker": {
        adapter: "run-as-binary",
        command: process.execPath,
        execution: { protocol: "pi-review-executor-jsonl-v1" },
      },
    },
    execution: {
      workerResources: { r: { selection: { source: "external", id: "binary-worker" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "r" }], research: [{ resourceId: "r" }] },
    },
  });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  return f;
}

const RESEARCH_INELIGIBLE_ERROR = /Research priority resource is not research-capable: r/;

test("a passive Research priority visit keeps a stored ineligible route, and Save still validates it", async (t) => {
  const f = await ineligibleResearchFixture(t);
  const target = targetControl("beta", [false]);
  const run = scripted(["Research priority", "Back", "Host: beta", "Save changes", "Cancel"]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [],
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assert.deepEqual(target.requests, [false], "a passive route visit is not an edit");
  assert.ok(
    run.notices.some((notice) => notice.type === "error" && RESEARCH_INELIGIBLE_ERROR.test(notice.message)),
    `owner-side Save still validates the stored entry: ${JSON.stringify(run.notices)}`,
  );
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "nothing was written");
});

test("a passive Worker resources visit keeps a stored ineligible route, and Save still validates it", async (t) => {
  const f = await ineligibleResearchFixture(t);
  const target = targetControl("beta", [false]);
  const run = scripted(["Worker resources", "Back", "Host: beta", "Save changes", "Cancel"]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [],
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assert.deepEqual(target.requests, [false], "a passive pool visit is not an edit");
  assert.ok(
    run.notices.some((notice) => notice.type === "error" && RESEARCH_INELIGIBLE_ERROR.test(notice.message)),
    `owner-side Save still validates the stored entry: ${JSON.stringify(run.notices)}`,
  );
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "nothing was written");
});

test("an actual resource edit still reconciles the stored ineligible route", async (t) => {
  const f = await ineligibleResearchFixture(t);
  const target = targetControl("beta", [false]);
  const run = scripted([
    "Worker resources",
    "1. binary-worker", // the resource row
    "Maximum concurrency",
    "2",
    "Back", // entry editor
    "Back", // pool
    "Host: beta",
    "Save changes",
  ]);
  const outcome = await runPersistedReviewSettings({
    config: f.loaded,
    configPath: f.configPath,
    ui: run.ui,
    scoped: [],
    targetControl: target.control,
  });
  assertNoErrors(run);
  assert.equal(outcome.kind, "saved");
  assert.deepEqual(target.requests, [true], "the resource edit is a staged change");
  const saved = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.equal(saved.execution.workerResources.r.maxConcurrent, 2);
  assert.deepEqual(
    saved.execution.routes.research,
    [],
    "an actual resource edit keeps the existing reconciliation",
  );
});

test("without a target control a passive Worker resources visit keeps its existing reconciliation", async (t) => {
  const f = await ineligibleResearchFixture(t);
  const run = scripted(["Worker resources", "Back", "Save changes"]);
  const outcome = await runPersistedReviewSettings({
    config: f.loaded,
    configPath: f.configPath,
    ui: run.ui,
    scoped: [],
  });
  assertNoErrors(run);
  assert.equal(outcome.kind, "saved");
  const saved = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.deepEqual(
    saved.execution.routes.research,
    [],
    "existing behavior without a target control: the ineligible stored entry is reconciled away",
  );
});

// ---------------------------------------------------------------------------
// Passive pool visits versus an explicit remove/re-add of the same worker
// ---------------------------------------------------------------------------

const SCOPED_SHALLOW = {
  model: "acme/shallow",
  label: "shallow [acme]",
  supportedThinkingLevels: ["off", "high"] as const,
};

function deepAndShallowModels(): ScopedModelChoice[] {
  return [
    ...scopedDeepModel(),
    { ...SCOPED_SHALLOW, supportedThinkingLevels: [...SCOPED_SHALLOW.supportedThinkingLevels] },
  ];
}

/** A stored worker under its generated id, excluded from Execution priority. */
async function excludedWorkerFixture(t: { after(callback: () => void): void }): Promise<{ f: Fixture; resourceId: string }> {
  const resourceId = executorEntryId({ source: "pi", model: SCOPED_DEEP.model });
  const f = await fixture({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    execution: {
      workerResources: { [resourceId]: { selection: { source: "pi", model: SCOPED_DEEP.model }, maxConcurrent: 1 } },
      // Excluded from Execution priority: no route references it.
      routes: { execute: [], research: [] },
    },
  });
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  return { f, resourceId };
}

test("removing and re-adding the same excluded worker keeps its new route enrollment", async (t) => {
  const { f, resourceId } = await excludedWorkerFixture(t);
  const target = targetControl("beta", [false]);
  const run = scripted([
    "Worker resources",
    "1. deep [acme]", // the stored resource
    "Remove",
    "Add worker resource",
    "deep [acme]", // same model
    "1  current", // same capacity: the final catalog key matches the opening one
    "Back", // pool
    "Host: beta",
    "Save changes",
  ]);
  const outcome = await runPersistedReviewSettings({
    config: f.loaded,
    configPath: f.configPath,
    ui: run.ui,
    scoped: scopedDeepModel(),
    targetControl: target.control,
  });
  assertNoErrors(run);
  assert.equal(outcome.kind, "saved");
  assert.deepEqual(target.requests, [true], "an explicit re-add of an opening worker is a real edit");
  const saved = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.deepEqual(Object.keys(saved.execution.workerResources), [resourceId]);
  assert.equal(saved.execution.workerResources[resourceId].maxConcurrent, 1);
  assert.deepEqual(
    saved.execution.routes.execute,
    [{ resourceId, thinkingLevel: "medium" }],
    "Save keeps the Add enrollment the re-add produced",
  );
  assert.deepEqual(
    saved.execution.routes.research,
    [{ resourceId, thinkingLevel: "medium" }],
    "the research enrollment is kept too",
  );
});

test("a brand-new worker added and removed again leaves the draft passive", async (t) => {
  // The stored ineligible research route makes an over-broad guard observable:
  // if the temporary add made this visit "active" and reconciled the routes,
  // the stored entry would vanish and Host would report a change.
  const f = await ineligibleResearchFixture(t);
  const target = targetControl("beta", [false]);
  const run = scripted([
    "Worker resources",
    "Add worker resource",
    "shallow [acme]", // a resource that did not exist at opening
    "1  current",
    "2. shallow [acme]", // remove it again
    "Remove",
    "Back", // pool
    "Host: beta",
    "Cancel",
  ]);
  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: deepAndShallowModels(),
      targetControl: target.control,
    }),
    { kind: "discarded" },
  );
  assertNoErrors(run);
  assert.deepEqual(
    target.requests,
    [false],
    "a temporary new worker that was removed again is not a staged change",
  );
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});
