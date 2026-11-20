/**
 * Issue #653: the disk-only settings transaction shares the one settings menu
 * with the live /review-settings transaction.
 *
 * - runPersistedReviewSettings opens the same staged menu over a caller-loaded
 *   disk config: root Escape and explicit Cancel discard BEFORE validation or
 *   any managed image copy; only Save (row or Ctrl+S) validates and persists.
 * - The disk path never installs into a live config (replaceConfig), never
 *   calls onSaved, never reads/records/clears a pending session delta, and
 *   never shows or flips the scheduler runtime.
 * - The live session transaction keeps its root-Escape apply, Cancel, Save,
 *   pending-delta, and scheduler semantics.
 * - The explicit host-owned settings text seam (`ui.editText`) receives the
 *   title, current value, and options, and wins over the Pi/RPC chain.
 *
 * Every config here is synthetic and lives in a fresh temporary directory.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Module from "node:module";
import { normalizeConfig, type OperatingMode, type ReviewGateConfig } from "../src/config";
import type { UiContext } from "../src/settings/ui";
import type { SettingTextEditRequest } from "../src/settings/text-input";

// Spies installed before the command module loads: every live-effect seam the
// disk-only transaction must never reach, plus the validation and image
// preparation it must skip on discard.
const calls = {
  replaceConfigTargets: [] as ReviewGateConfig[],
  getPendingDelta: [] as ReviewGateConfig[],
  recordPendingDelta: [] as ReviewGateConfig[],
  clearPendingDelta: [] as ReviewGateConfig[],
  validateSelection: 0,
  prepareImages: 0,
  persist: 0,
};
function resetCalls(): void {
  calls.replaceConfigTargets.length = 0;
  calls.getPendingDelta.length = 0;
  calls.recordPendingDelta.length = 0;
  calls.clearPendingDelta.length = 0;
  calls.validateSelection = 0;
  calls.prepareImages = 0;
  calls.persist = 0;
}

const loader = Module as unknown as { _load: (request: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request, ...args) {
  const real = originalLoad.call(this, request, ...args) as Record<string, unknown>;
  if (request === "./persistence") {
    const persistence = real as typeof import("../src/settings/persistence");
    return {
      ...persistence,
      replaceConfig: (...rest: Parameters<typeof persistence.replaceConfig>) => {
        calls.replaceConfigTargets.push(rest[0]);
        return persistence.replaceConfig(...rest);
      },
      persistReviewSettings: (...rest: Parameters<typeof persistence.persistReviewSettings>) => {
        calls.persist += 1;
        return persistence.persistReviewSettings(...rest);
      },
    };
  }
  if (request === "./session-delta") {
    const delta = real as typeof import("../src/settings/session-delta");
    return {
      ...delta,
      getPendingSessionDelta: (config: ReviewGateConfig) => { calls.getPendingDelta.push(config); return delta.getPendingSessionDelta(config); },
      recordPendingSessionDelta: (config: ReviewGateConfig, value: Parameters<typeof delta.recordPendingSessionDelta>[1]) => {
        calls.recordPendingDelta.push(config);
        return delta.recordPendingSessionDelta(config, value);
      },
      clearPendingSessionDelta: (config: ReviewGateConfig) => { calls.clearPendingDelta.push(config); return delta.clearPendingSessionDelta(config); },
    };
  }
  if (request === "./validation") {
    const validation = real as typeof import("../src/settings/validation");
    return {
      ...validation,
      validateSelection: (...rest: Parameters<typeof validation.validateSelection>) => {
        calls.validateSelection += 1;
        return validation.validateSelection(...rest);
      },
    };
  }
  if (request === "./scheduled-image-assets") {
    const images = real as typeof import("../src/settings/scheduled-image-assets");
    return {
      ...images,
      prepareScheduledImageAssets: (...rest: Parameters<typeof images.prepareScheduledImageAssets>) => {
        calls.prepareImages += 1;
        return images.prepareScheduledImageAssets(...rest);
      },
    };
  }
  return real;
};
const { registerReviewSettings, runPersistedReviewSettings } = require("../src/settings/command") as typeof import("../src/settings/command");
const { getPendingSessionDelta } = require("../src/settings/session-delta") as typeof import("../src/settings/session-delta");
const { editSettingText } = require("../src/settings/text-input") as typeof import("../src/settings/text-input");

/** One scripted selection: an exact option, an option prefix, Escape (undefined), or Ctrl+S. */
type Step = string | undefined | { ctrlS: true };

interface ScriptedUi {
  ui: UiContext;
  notices: Array<{ message: string; kind: string }>;
  /** Every option list the menu showed, in order. */
  shown: string[][];
  /** Text values queued for the host-owned editText seam. */
  texts: string[];
  /** Every editText request the seam received. */
  textRequests: SettingTextEditRequest[];
  remaining(): number;
}

function scriptedUi(steps: Step[]): ScriptedUi {
  const notices: Array<{ message: string; kind: string }> = [];
  const shown: string[][] = [];
  const texts: string[] = [];
  const textRequests: SettingTextEditRequest[] = [];
  let index = 0;
  const ui: UiContext = {
    select: async (_title, options) => {
      shown.push(options);
      assert.ok(index < steps.length, `unexpected extra selection: ${options.join(" | ")}`);
      const step = steps[index++];
      if (step === undefined) return undefined;
      if (typeof step === "object") {
        assert.ok(ui.saveControl, "the settings transaction attaches a save control");
        ui.saveControl.saveRequested = true;
        return undefined;
      }
      const match = options.find((option) => option === step) ?? options.find((option) => option.startsWith(step));
      assert.ok(match !== undefined, `missing selection ${step}: ${options.join(" | ")}`);
      return match;
    },
    editText: async (request) => {
      textRequests.push(request);
      assert.ok(texts.length, "unexpected text field");
      return texts.shift();
    },
    confirm: async () => false,
    notify: (message, kind) => { notices.push({ message, kind: kind ?? "info" }); },
  };
  return { ui, notices, shown, texts, textRequests, remaining: () => steps.length - index };
}

function assertNoErrors(notices: ScriptedUi["notices"]): void {
  for (const notice of notices) assert.notEqual(notice.kind, "error", notice.message);
}

interface Fixture {
  configPath: string;
  original: string;
  /** Fresh disk-loaded config (the caller's job in production). */
  loadDisk(): Promise<ReviewGateConfig>;
  /** A separately owned live session config (parent B), never on disk here. */
  live: ReviewGateConfig;
  onSaved: Array<{ config: ReviewGateConfig; previousMode: OperatingMode }>;
  scheduler: { enabled: boolean; flips: number; setEnabled(next: boolean): void };
  /** Open the live /review-settings transaction over `live`. */
  runSession(steps: Step[]): Promise<ScriptedUi>;
}

async function fixture(diskBody: Record<string, unknown>, liveBody: Record<string, unknown>): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-persisted-settings-"));
  const configPath = join(dir, "review-gate.json");
  const original = JSON.stringify(diskBody, null, 2);
  await writeFile(configPath, original, "utf8");
  const live = normalizeConfig(liveBody);
  const onSaved: Fixture["onSaved"] = [];
  const scheduler = {
    enabled: false,
    flips: 0,
    setEnabled(next: boolean) { this.flips += 1; this.enabled = next; },
  };
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  registerReviewSettings({
    pi: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        if (name === "review-settings") handler = options.handler as never;
      },
    },
    config: live,
    configPath,
    onSaved: (config, previousMode) => { onSaved.push({ config, previousMode }); },
    schedulerRuntime: scheduler,
  });
  assert.ok(handler);
  return {
    configPath,
    original,
    loadDisk: async () => normalizeConfig(JSON.parse(await readFile(configPath, "utf8"))),
    live,
    onSaved,
    scheduler,
    runSession: async (steps) => {
      const scripted = scriptedUi(steps);
      await handler!("", { ui: scripted.ui });
      return scripted;
    },
  };
}

const DISK_A = { enabled: true, youShouldKnow: { enabled: true, completionGuidance: true }, operatingMode: "execute" };
const LIVE_B = { enabled: true, youShouldKnow: { enabled: false, completionGuidance: false }, operatingMode: "orchestrate" };

/** The disk-only path touched no live/session seam at all. */
function assertNoLiveEffects(f: Fixture, disk: ReviewGateConfig): void {
  assert.deepEqual(calls.replaceConfigTargets.filter((target) => target === f.live || target === disk), [], "never installs into the live or loaded config");
  assert.deepEqual(calls.getPendingDelta, [], "never reads a pending session delta");
  assert.deepEqual(calls.recordPendingDelta, [], "never records a pending session delta");
  assert.deepEqual(calls.clearPendingDelta, [], "never clears a pending session delta");
  assert.equal(getPendingSessionDelta(f.live), undefined);
  assert.equal(getPendingSessionDelta(disk), undefined);
  assert.equal(f.onSaved.length, 0, "never calls onSaved");
  assert.equal(f.scheduler.flips, 0, "never flips the scheduler runtime");
}

for (const exit of ["root Escape", "Cancel"] as const) {
  test(`disk-only ${exit} discards staged changes before validation or image preparation`, async () => {
    const f = await fixture(DISK_A, LIVE_B);
    const disk = await f.loadDisk();
    const diskSnapshot = structuredClone(disk);
    const liveSnapshot = structuredClone(f.live);
    resetCalls();
    // Stage C: turn YouShouldKnow notices Off, Back to the root, then leave.
    const scripted = scriptedUi(["Tools", "YouShouldKnow notices", undefined, exit === "Cancel" ? "Cancel" : undefined]);
    const outcome = await runPersistedReviewSettings({ config: disk, configPath: f.configPath, ui: scripted.ui, scoped: [] });
    assert.deepEqual(outcome, { kind: "discarded" });
    assert.equal(scripted.remaining(), 0);
    assertNoErrors(scripted.notices);
    assert.equal(calls.validateSelection, 0, "discard runs no validation");
    assert.equal(calls.prepareImages, 0, "discard prepares no managed image copies");
    assert.equal(calls.persist, 0, "discard writes nothing");
    assert.equal(await readFile(f.configPath, "utf8"), f.original, "the file keeps disk A");
    assert.deepEqual(disk, diskSnapshot, "the caller's loaded config is never mutated");
    assert.deepEqual(f.live, liveSnapshot, "the live parent config B is untouched");
    assertNoLiveEffects(f, disk);
    // The root never offers the process scheduler switch on the disk path.
    for (const options of scripted.shown) assert.ok(!options.some((option) => option.startsWith("Scheduler runtime")));
    // A later launch loads disk A, never the discarded C.
    assert.equal((await f.loadDisk()).youShouldKnow?.enabled, true);
  });
}

test("disk-only Save persists without live callbacks; a later disk load sees it and the live parent does not", async () => {
  const f = await fixture(
    { ...DISK_A, retainBundles: "always", unrelatedFutureField: { keep: true } },
    LIVE_B,
  );
  const disk = await f.loadDisk();
  const liveSnapshot = structuredClone(f.live);
  resetCalls();
  const scripted = scriptedUi(["Tools", "YouShouldKnow notices", undefined, "Save changes"]);
  const outcome = await runPersistedReviewSettings({ config: disk, configPath: f.configPath, ui: scripted.ui, scoped: [] });
  assertNoErrors(scripted.notices);
  assert.equal(outcome.kind, "saved");
  assert.equal(outcome.kind === "saved" && outcome.config.youShouldKnow?.enabled, false);
  assert.equal(calls.persist, 1);
  assert.ok(calls.validateSelection > 0, "Save validates through the shared boundary");
  assert.equal(calls.prepareImages, 1, "Save runs the shared image preparation");
  const written = JSON.parse(await readFile(f.configPath, "utf8"));
  assert.deepEqual(written.youShouldKnow, { enabled: false, completionGuidance: true });
  assert.equal(written.retainBundles, "always", "unrelated owned fields are preserved");
  assert.deepEqual(written.unrelatedFutureField, { keep: true }, "unknown fields are preserved");
  assert.deepEqual(f.live, liveSnapshot, "the running parent session keeps B");
  assertNoLiveEffects(f, disk);
  assert.ok(scripted.notices.some((notice) => /saved to disk/.test(notice.message)));
  // A newly launched session (fresh disk load) sees D.
  assert.equal((await f.loadDisk()).youShouldKnow?.enabled, false);
});

test("disk-only Ctrl+S takes the same Save path; a following run reopens on the saved value", async () => {
  const f = await fixture(DISK_A, LIVE_B);
  resetCalls();
  const first = scriptedUi(["Tools", "Completion guidance", { ctrlS: true }]);
  const firstDisk = await f.loadDisk();
  const outcome = await runPersistedReviewSettings({ config: firstDisk, configPath: f.configPath, ui: first.ui, scoped: [] });
  assertNoErrors(first.notices);
  assert.equal(outcome.kind, "saved");
  assert.deepEqual(JSON.parse(await readFile(f.configPath, "utf8")).youShouldKnow, { enabled: true, completionGuidance: false });
  assert.equal(first.ui.saveControl?.saveRequested, false, "the latch is consumed");
  assertNoLiveEffects(f, firstDisk);

  // Another editor reopening from disk sees E (the saved value), then Cancel.
  const second = scriptedUi(["Tools", undefined, "Cancel"]);
  await runPersistedReviewSettings({ config: await f.loadDisk(), configPath: f.configPath, ui: second.ui, scoped: [] });
  const toolsMenu = second.shown[1]!;
  assert.ok(toolsMenu.some((option) => option.startsWith("Completion guidance") && /Off/.test(option)), toolsMenu.join(" | "));
});

test("disk-only Save validation failure keeps the menu open and writes nothing; Cancel then discards", async () => {
  const f = await fixture({
    enabled: true,
    // A Pi executor that is not in the scoped model choices fails the shared
    // Save-time validation.
    execution: {
      workerResources: { r: { selection: { source: "pi", model: "synthetic/unscoped" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "r" }], research: [] },
    },
  }, LIVE_B);
  const disk = await f.loadDisk();
  resetCalls();
  // Root Escape over the same invalid draft discards silently: no validation.
  const escaped = scriptedUi([undefined]);
  assert.deepEqual(await runPersistedReviewSettings({ config: disk, configPath: f.configPath, ui: escaped.ui, scoped: [] }), { kind: "discarded" });
  assert.deepEqual(escaped.notices, []);
  assert.equal(calls.validateSelection, 0);
  const scripted = scriptedUi(["Save changes", "Cancel"]);
  const outcome = await runPersistedReviewSettings({ config: disk, configPath: f.configPath, ui: scripted.ui, scoped: [] });
  assert.deepEqual(outcome, { kind: "discarded" });
  assert.ok(scripted.notices.some((notice) => notice.kind === "error" && /Pi executor model is not currently scoped: synthetic\/unscoped/.test(notice.message)));
  assert.equal(calls.persist, 0);
  assert.equal(calls.prepareImages, 0);
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
  assertNoLiveEffects(f, disk);
});

test("disk-only text fields edit through the host-owned editText seam and persist on Save", async () => {
  const f = await fixture(DISK_A, LIVE_B);
  const disk = await f.loadDisk();
  resetCalls();
  const scripted = scriptedUi(["Retry policy", "Retries after initial attempt", "Back", "Save changes"]);
  scripted.texts.push("5");
  await runPersistedReviewSettings({ config: disk, configPath: f.configPath, ui: scripted.ui, scoped: [] });
  assertNoErrors(scripted.notices);
  assert.equal(scripted.textRequests.length, 1);
  assert.equal(scripted.textRequests[0]!.title, "Retry limit");
  assert.equal(scripted.textRequests[0]!.currentValue, "2");
  assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).execution.retryPolicy.maxRetries, 5);
  assertNoLiveEffects(f, disk);
});

test("editSettingText forwards title, value, and the observation callback to a host-owned editText", async () => {
  const requests: SettingTextEditRequest[] = [];
  const onHostInsert = (_text: string): void => {};
  const result = await editSettingText({
    mode: "tui",
    editText: async (request) => { requests.push(request); request.options.onHostInsert?.("/tmp/pasted.png"); return "edited"; },
    editor: async () => { throw new Error("the Pi/RPC chain must not run when the host owns the field"); },
    custom: async () => { throw new Error("the native bridge must not run when the host owns the field"); },
  }, "Instructions", "before", undefined, { onHostInsert });
  assert.equal(result, "edited");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.title, "Instructions");
  assert.equal(requests[0]!.currentValue, "before");
  assert.equal(requests[0]!.options.onHostInsert, onHostInsert);
  // Cancel from the host field stays a cancel.
  assert.equal(await editSettingText({ editText: async () => undefined }, "Name", "x"), undefined);
});

test("session regression: root Escape applies live with a pending delta; Cancel keeps it; Save installs and clears", async () => {
  const f = await fixture(DISK_A, { ...DISK_A });
  const before = structuredClone(f.live);
  resetCalls();

  // Scheduler runtime row stays a live process switch in the session menu.
  const toggled = await f.runSession(["Scheduler runtime", "Cancel"]);
  assertNoErrors(toggled.notices);
  assert.equal(f.scheduler.flips, 1);
  assert.equal(f.scheduler.enabled, true);
  assert.deepEqual(f.live, before, "Cancel leaves the live config unchanged");
  assert.equal(f.onSaved.length, 0);

  const escaped = await f.runSession(["Tools", "YouShouldKnow notices", undefined, undefined]);
  assertNoErrors(escaped.notices);
  assert.equal(f.live.youShouldKnow?.enabled, false, "root Escape applies to the live config");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "root Escape writes nothing");
  assert.ok(calls.replaceConfigTargets.includes(f.live));
  assert.ok(calls.recordPendingDelta.includes(f.live));
  assert.ok(getPendingSessionDelta(f.live), "a pending delta is recorded for a later Save");
  assert.equal(f.onSaved.length, 1);
  assert.equal(f.onSaved[0]!.config, f.live);

  await f.runSession(["Tools", "YouShouldKnow notices", undefined, "Cancel"]);
  assert.equal(f.live.youShouldKnow?.enabled, false, "Cancel keeps the earlier session-only choice");
  assert.equal(f.onSaved.length, 1);

  const saved = await f.runSession(["Save changes"]);
  assertNoErrors(saved.notices);
  assert.deepEqual(JSON.parse(await readFile(f.configPath, "utf8")).youShouldKnow, { enabled: false, completionGuidance: true });
  assert.equal(f.onSaved.length, 2);
  assert.ok(calls.clearPendingDelta.includes(f.live));
  assert.equal(getPendingSessionDelta(f.live), undefined, "a successful Save clears the delta");
  assert.ok(saved.notices.some((notice) => notice.message === "Review settings saved."));
});
