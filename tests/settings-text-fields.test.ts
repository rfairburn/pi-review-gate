/**
 * Issue #26: every /review-settings text field is truly editable.
 *
 * Pins the agreed UI correction at the seam level:
 *
 * - In an interactive TUI all twelve text fields use the shared host-wired
 *   main-editor bridge, including scheduled instructions and workspace. The
 *   bridge tests exercise native keys; these command tests check staging.
 * - Non-interactive hosts prefer `ctx.ui.editor(title, currentValue)` with an
 *   editable prefill, then the legacy `ui.input` placeholder fallback. Cancel
 *   leaves the staged value unchanged; a host without input fails closed.
 * - The cron field shows the five-field machine-local heading above its
 *   editable prefill, including `* * * * * = every minute`.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { setMenuTuiHost } from "../src/settings/menu";
import {
  __resetActiveNativeEditorFieldForTest,
  setNativeEditorHost,
  setNativeEditorHostEntryProvider as setNativeEditorHostEntryProviderForTest,
} from "../src/native-editor-bridge";
import { KEY_DOWN, KEY_ENTER, createFakeMenuTuiHost } from "./menu-tui-fakes";
import {
  CTRL_U,
  ENTER,
  ESCAPE,
  createBridgeUi,
  fakeHost,
  fakeKeybindingsManager,
  typeText,
} from "./bridge-fakes";
import type { FakeBridgeEditor } from "./bridge-fakes";

// ---------------------------------------------------------------------------
// Aligned row helpers (must mirror the menu's alignedSettingsRows rendering)
// ---------------------------------------------------------------------------

const ROOT_SETTING_LABELS = [
  "Operating mode",
  "Mode cycle hotkey",
  "Worker resources",
  "Execution priority",
  "Research priority",
  "Reviewers",
  "Timeouts",
  "Review policy",
  "Bundle retention",
  "Global concurrency",
  "Retry policy",
  "Subtask notifications",
  "Deferred Pi tools",
  "Subtasks view",
  "Scheduled tasks",
  "Web",
] as const;

const TIMEOUT_SETTING_LABELS = ["Reviewer timeout", "Executor timeout"] as const;
const POLICY_SETTING_LABELS = ["Automatic correction attempts", "Concrete guidance after"] as const;
const RETRY_SETTING_LABELS = [
  "Retries after initial attempt",
  "Base delay",
  "Maximum delay",
  "Same-incident repeat limit",
  "Delay jitter",
] as const;
const WEB_SETTING_LABELS = ["Maximum download", "Browser interaction approval", "Browser idle expiry", "Download retention", "Browser visibility", "Browser permissions"] as const;

function alignedRow(label: string, value: string, labels: readonly string[]): string {
  const width = Math.max(...labels.map((candidate) => candidate.length));
  return `${label.padEnd(width)}  ${value}`;
}

const rootRow = (label: (typeof ROOT_SETTING_LABELS)[number], value: string): string => alignedRow(label, value, ROOT_SETTING_LABELS);
const timeoutRow = (label: (typeof TIMEOUT_SETTING_LABELS)[number], value: string): string => alignedRow(label, value, TIMEOUT_SETTING_LABELS);
const policyRow = (label: (typeof POLICY_SETTING_LABELS)[number], value: string): string => alignedRow(label, value, POLICY_SETTING_LABELS);
const retryRow = (label: (typeof RETRY_SETTING_LABELS)[number], value: string): string => alignedRow(label, value, RETRY_SETTING_LABELS);
const webRow = (label: (typeof WEB_SETTING_LABELS)[number], value: string): string => alignedRow(label, value, WEB_SETTING_LABELS);

// ---------------------------------------------------------------------------
// Harness: command context with a recording public editor (and optional
// legacy input) plus scripted selections.
// ---------------------------------------------------------------------------

interface TextUiHarness {
  ctx: unknown;
  editorCalls: Array<{ title: string; prefill?: string }>;
  inputCalls: Array<{ title: string; placeholder?: string }>;
  notifyCalls: Array<{ message: string; type?: string }>;
}

function makeTextUiContext(
  selections: Array<string | undefined>,
  editorResults: Array<string | undefined> = [],
  inputResults: Array<string | undefined> = [],
  options: { withEditor?: boolean; withInput?: boolean } = {},
): TextUiHarness {
  const withEditor = options.withEditor ?? true;
  const withInput = options.withInput ?? false;
  let selectIndex = 0;
  let editorIndex = 0;
  let inputIndex = 0;
  const harness: TextUiHarness = {
    ctx: undefined,
    editorCalls: [],
    inputCalls: [],
    notifyCalls: [],
  };
  const ui: Record<string, unknown> = {
    async select(_title: string, optionsList: string[]) {
      const value = selections[selectIndex++];
      if (value !== undefined) assert.ok(optionsList.includes(value), `missing selection ${value}: ${optionsList.join(" | ")}`);
      return value;
    },
    notify(message: string, type?: string) {
      harness.notifyCalls.push({ message, type });
    },
  };
  if (withEditor) {
    ui.editor = async (title: string, prefill?: string) => {
      harness.editorCalls.push({ title, prefill });
      return editorResults[editorIndex++];
    };
  }
  if (withInput) {
    ui.input = async (title: string, placeholder?: string) => {
      harness.inputCalls.push({ title, placeholder });
      return inputResults[inputIndex++];
    };
  }
  harness.ctx = { scopedModels: [], ui };
  return harness;
}

function commandHarness(): {
  pi: { registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }): void };
  handler: (args: string, ctx: unknown) => Promise<void>;
} {
  let registered: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  return {
    pi: {
      registerCommand(name, options) {
        if (name === "review-settings") registered = options.handler as (args: string, ctx: unknown) => Promise<void>;
      },
    },
    get handler() {
      assert.ok(registered);
      return registered!;
    },
  };
}

/** Config with known current values for every text field. */
const KNOWN = {
  modeCycle: "alt+m",
  reviewerTimeoutMin: 45,
  executorTimeoutMin: 90,
  maxCorrectionCycles: 3,
  guidanceThreshold: 2,
  retry: { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 6000, jitter: false, maxSameIncidentRepeats: 4 },
  maxDownloadMib: 25,
  idleExpiryMin: 15,
  downloadRetention: 7,
};

async function writeKnownConfig(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-text-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    modeCycleShortcut: KNOWN.modeCycle,
    reviewerTimeoutMs: KNOWN.reviewerTimeoutMin * 60_000,
    executorTimeoutMs: KNOWN.executorTimeoutMin * 60_000,
    maxCorrectionCycles: KNOWN.maxCorrectionCycles,
    implementationGuidanceAfterCorrectionAttempts: KNOWN.guidanceThreshold,
    execution: { retryPolicy: { ...KNOWN.retry } },
    web: {
      fetch: { maxDownloadBytes: KNOWN.maxDownloadMib * 1024 * 1024 },
      browserIdleExpiryMinutes: KNOWN.idleExpiryMin,
      browserDownloadRetention: KNOWN.downloadRetention,
    },
  }), "utf8");
  return { dir, configPath };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("every settings text field prefills through the public editor and stages submitted values", async () => {
  const { configPath } = await writeKnownConfig();
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  const harness = makeTextUiContext([
    rootRow("Timeouts", `review ${KNOWN.reviewerTimeoutMin}m · executor ${KNOWN.executorTimeoutMin}m`),
    timeoutRow("Reviewer timeout", `${KNOWN.reviewerTimeoutMin}m`),
    timeoutRow("Executor timeout", `${KNOWN.executorTimeoutMin}m`),
    "Back",
    rootRow("Review policy", `${KNOWN.maxCorrectionCycles} corrections · concrete after ${KNOWN.guidanceThreshold}`),
    policyRow("Automatic correction attempts", String(KNOWN.maxCorrectionCycles)),
    policyRow("Concrete guidance after", String(KNOWN.guidanceThreshold)),
    "Back",
    rootRow("Retry policy", `${KNOWN.retry.maxRetries} retries · ${KNOWN.retry.baseDelayMs}ms base`),
    retryRow("Retries after initial attempt", String(KNOWN.retry.maxRetries)),
    retryRow("Base delay", `${KNOWN.retry.baseDelayMs}ms`),
    retryRow("Maximum delay", `${KNOWN.retry.maxDelayMs / 1000}s`),
    retryRow("Same-incident repeat limit", String(KNOWN.retry.maxSameIncidentRepeats)),
    "Back",
    rootRow("Mode cycle hotkey", KNOWN.modeCycle),
    rootRow("Web", `${KNOWN.maxDownloadMib} MiB max download · headless browser`),
    webRow("Browser idle expiry", `${KNOWN.idleExpiryMin} minutes`),
    webRow("Download retention", `${KNOWN.downloadRetention} unsaved per session`),
    webRow("Maximum download", `${KNOWN.maxDownloadMib} MiB`),
    "Back",
    "Save changes",
  ], [
    "60", // reviewer timeout minutes
    "120", // executor timeout minutes
    "5", // correction cycles
    "4", // guidance threshold
    "2", // retry limit
    "750", // base delay ms
    "9000", // max delay ms
    "3", // same-incident repeats
    KNOWN.modeCycle, // mode cycle hotkey (unchanged)
    "30", // browser idle expiry minutes
    "9", // download retention
    "40", // max download MiB
  ]);

  await registered.handler("", harness.ctx);

  // Every one of the twelve seams offered the current value as an editable
  // prefill through the public editor, with its established title.
  assert.deepEqual(harness.editorCalls, [
    { title: "Reviewer timeout in minutes", prefill: String(KNOWN.reviewerTimeoutMin) },
    { title: "Executor timeout in minutes", prefill: String(KNOWN.executorTimeoutMin) },
    { title: "Automatic correction attempts", prefill: String(KNOWN.maxCorrectionCycles) },
    { title: "Concrete guidance after correction attempts", prefill: String(KNOWN.guidanceThreshold) },
    { title: "Retry limit", prefill: String(KNOWN.retry.maxRetries) },
    { title: "Delay in milliseconds", prefill: String(KNOWN.retry.baseDelayMs) },
    { title: "Delay in milliseconds", prefill: String(KNOWN.retry.maxDelayMs) },
    { title: "Retry limit", prefill: String(KNOWN.retry.maxSameIncidentRepeats) },
    { title: "Mode cycle hotkey (modifiers + key, e.g. alt+m)", prefill: KNOWN.modeCycle },
    { title: "Browser idle expiry in minutes (0 disables idle close)", prefill: String(KNOWN.idleExpiryMin) },
    { title: "Maximum retained unsaved downloads per browser session (0 = unlimited)", prefill: String(KNOWN.downloadRetention) },
    { title: "Maximum download size in MiB", prefill: String(KNOWN.maxDownloadMib) },
  ]);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.reviewerTimeoutMs, 60 * 60_000);
  assert.equal(saved.executorTimeoutMs, 120 * 60_000);
  assert.equal(saved.maxCorrectionCycles, 5);
  assert.equal(saved.implementationGuidanceAfterCorrectionAttempts, 4);
  assert.deepEqual(saved.execution.retryPolicy, { maxRetries: 2, baseDelayMs: 750, maxDelayMs: 9000, jitter: false, maxSameIncidentRepeats: 3 });
  assert.equal(saved.modeCycleShortcut, KNOWN.modeCycle);
  assert.equal(saved.web.fetch.maxDownloadBytes, 40 * 1024 * 1024);
  assert.equal(saved.web.browserIdleExpiryMinutes, 30);
  assert.equal(saved.web.browserDownloadRetention, 9);
});

test("cancel in the editor leaves every staged value unchanged", async () => {
  const { configPath } = await writeKnownConfig();
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  // Reviewer timeout is cancelled (undefined); executor timeout submits.
  const harness = makeTextUiContext([
    rootRow("Timeouts", `review ${KNOWN.reviewerTimeoutMin}m · executor ${KNOWN.executorTimeoutMin}m`),
    timeoutRow("Reviewer timeout", `${KNOWN.reviewerTimeoutMin}m`),
    timeoutRow("Executor timeout", `${KNOWN.executorTimeoutMin}m`),
    "Back",
    "Save changes",
  ], [
    undefined, // cancel the reviewer timeout edit
    "120", // submit the executor timeout edit
  ]);

  await registered.handler("", harness.ctx);

  assert.deepEqual(harness.editorCalls, [
    { title: "Reviewer timeout in minutes", prefill: String(KNOWN.reviewerTimeoutMin) },
    { title: "Executor timeout in minutes", prefill: String(KNOWN.executorTimeoutMin) },
  ]);
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.reviewerTimeoutMs, KNOWN.reviewerTimeoutMin * 60_000, "cancelled edit keeps the old value");
  assert.equal(saved.executorTimeoutMs, 120 * 60_000);
});

test("without an editor the legacy input fallback keeps its title/placeholder semantics", async () => {
  const { configPath } = await writeKnownConfig();
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  const harness = makeTextUiContext(
    [
      rootRow("Timeouts", `review ${KNOWN.reviewerTimeoutMin}m · executor ${KNOWN.executorTimeoutMin}m`),
      timeoutRow("Reviewer timeout", `${KNOWN.reviewerTimeoutMin}m`),
      "Back",
      "Save changes",
    ],
    [],
    ["60"],
    { withEditor: false, withInput: true },
  );

  await registered.handler("", harness.ctx);

  assert.deepEqual(harness.inputCalls, [
    { title: "Reviewer timeout in minutes", placeholder: String(KNOWN.reviewerTimeoutMin) },
  ]);
  assert.equal(harness.editorCalls.length, 0);
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.reviewerTimeoutMs, 60 * 60_000);
});

test("a host with neither editor nor input fails closed: error notice, nothing staged", async () => {
  const { configPath } = await writeKnownConfig();
  const before = await readFile(configPath, "utf8");
  const config = normalizeConfig(JSON.parse(before));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  const harness = makeTextUiContext(
    [
      rootRow("Timeouts", `review ${KNOWN.reviewerTimeoutMin}m · executor ${KNOWN.executorTimeoutMin}m`),
      timeoutRow("Reviewer timeout", `${KNOWN.reviewerTimeoutMin}m`),
      "Back",
      "Save changes",
    ],
    [],
    [],
    { withEditor: false, withInput: false },
  );

  await registered.handler("", harness.ctx);

  assert.ok(
    harness.notifyCalls.some((call) => call.type === "error" && /does not support numeric input/.test(call.message)),
    `expected the unavailable-seam error notice: ${JSON.stringify(harness.notifyCalls)}`,
  );
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.reviewerTimeoutMs, KNOWN.reviewerTimeoutMin * 60_000, "nothing was staged from a missing UI");
});

// ---------------------------------------------------------------------------
// Scheduled task fields: cron heading, instructions through the public editor
// ---------------------------------------------------------------------------

const SCHEDULED_EDITOR_LABELS = [
  "Name",
  "Schedule (cron)",
  "Kind",
  "Instructions",
  "Workspace",
  "Worker",
  "Review",
  "Enabled",
] as const;

const scheduledRow = (label: (typeof SCHEDULED_EDITOR_LABELS)[number], value: string): string => alignedRow(label, value, SCHEDULED_EDITOR_LABELS);

async function writeScheduledConfig(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-settings-schedtext-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: false,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Nightly check",
        cron: "30 2 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Check the docs for staleness",
        workspace: dir,
      },
    },
  }), "utf8");
  return { dir, configPath };
}

test("the cron field shows the five-field heading above the editable prefilled text", async () => {
  const { configPath } = await writeScheduledConfig();
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  const harness = makeTextUiContext([
    rootRow("Scheduled tasks", "1 of 1 enabled"),
    "1. Nightly check — 30 2 * * * — execute — enabled",
    scheduledRow("Schedule (cron)", "30 2 * * *"),
    "Back",
    "Back",
    "Save changes",
  ], [
    "0 4 * * mon-fri", // submit a new cron expression
  ]);

  await registered.handler("", harness.ctx);

  assert.equal(harness.editorCalls.length, 1);
  const call = harness.editorCalls[0]!;
  assert.equal(call.prefill, "30 2 * * *", "the current schedule is the editable prefill");
  // The compact heading maps all five fields in order, states machine-local
  // time, and explains the canonical wildcard line.
  const lines = call.title.split("\n");
  assert.ok(lines.some((line) => line.includes("machine-local time")), `heading states machine-local time: ${JSON.stringify(call.title)}`);
  assert.ok(
    lines.some((line) => line === "minute  hour  day-of-month  month  day-of-week"),
    `heading maps all five fields in order: ${JSON.stringify(call.title)}`,
  );
  assert.ok(lines.some((line) => line.includes("* * * * * = every minute")), `heading explains the wildcard line: ${JSON.stringify(call.title)}`);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.scheduledTasks["task-abcdef12"].cron, "0 4 * * mon-fri");
});

test("cancel in the cron editor keeps the staged schedule", async () => {
  const { configPath } = await writeScheduledConfig();
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  const harness = makeTextUiContext([
    rootRow("Scheduled tasks", "1 of 1 enabled"),
    "1. Nightly check — 30 2 * * * — execute — enabled",
    scheduledRow("Schedule (cron)", "30 2 * * *"),
    "Back",
    "Back",
    "Save changes",
  ], [undefined]); // cancel

  await registered.handler("", harness.ctx);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.scheduledTasks["task-abcdef12"].cron, "30 2 * * *");
});

function tuiFlowContext(steps: Array<(component: { render?(width: number): string[]; handleInput?(data: string): void }) => void | Promise<void>>): {
  ctx: unknown;
  editorCalls: Array<{ title: string; prefill?: string }>;
  notifyCalls: Array<{ message: string; type?: string }>;
  customCount(): number;
} {
  const { ui } = createBridgeUi({ keybindings: fakeKeybindingsManager(), draft: "chat draft", drivers: steps });
  const editorCalls: Array<{ title: string; prefill?: string }> = [];
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  let customCount = 0;
  const wrapped = {
    ...ui,
    custom(factory: Parameters<NonNullable<typeof ui.custom>>[0]): Promise<string | undefined> {
      customCount += 1;
      return ui.custom!(factory);
    },
    async select(): Promise<string | undefined> {
      throw new Error("plain select must not be used in TUI mode with a loadable host");
    },
    async editor(title: string, prefill?: string): Promise<string | undefined> {
      editorCalls.push({ title, prefill });
      return undefined;
    },
    notify(message: string, type?: string): void {
      notifyCalls.push({ message, type });
    },
  };
  return { ctx: { mode: "tui", scopedModels: [], ui: wrapped }, editorCalls, notifyCalls, customCount: () => customCount };
}

const tuiKeys = (...sequence: string[]): ((component: { handleInput?(data: string): void }) => void) => (component) => {
  for (const key of sequence) component.handleInput?.(key);
};

test("in the interactive TUI a text field opens through the native editor bridge, never a second draft surface", async (t) => {
  const instances: FakeBridgeEditor[] = [];
  const menuHost = createFakeMenuTuiHost();
  setMenuTuiHost(menuHost);
  setNativeEditorHost(fakeHost(instances));
  t.after(() => {
    setMenuTuiHost(undefined);
    setNativeEditorHost(undefined);
    __resetActiveNativeEditorFieldForTest();
  });

  const { configPath } = await writeScheduledConfig();
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  // Interactive TUI context: menus render through ui.custom (fake host) and
  // the instructions field opens through the host-wired native editor bridge
  // — the same embedded host editor every other text field uses. The public
  // ui.editor chain is a non-interactive fallback only.
  const harness = tuiFlowContext([
    tuiKeys(...Array(14).fill(KEY_DOWN), KEY_ENTER), // root → Scheduled tasks (index 14)
    tuiKeys(KEY_ENTER), // list → task entry (row 0)
    tuiKeys(KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER), // entry editor → instructions (row 3)
    async (component) => {
      const frame = component.render!(80).join("\n");
      assert.ok(frame.includes("Check the docs for staleness"), `the current instructions are the field prefill: ${frame}`);
      component.handleInput?.(CTRL_U); // clear the prefill
      typeText(component, "Rewritten instructions");
      component.handleInput?.(ENTER); // submit through the bridge
    },
    tuiKeys(...Array(6).fill(KEY_DOWN), KEY_ENTER), // entry re-show (row 3) → Back (row 9)
    tuiKeys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // list re-show → Back (row 2)
    tuiKeys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // root re-show (index 14) → Save changes (row 16)
  ]);

  await registered.handler("", harness.ctx);

  assert.equal(instances.length, 1, "exactly one embedded host editor instance for the field");
  assert.equal(harness.editorCalls.length, 0, "the public editor chain is not used in the interactive TUI");
  assert.equal(harness.customCount(), 7, "six menus plus the bridge field surface");

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.scheduledTasks["task-abcdef12"].instructions, "Rewritten instructions");
});

test("an interactive TUI without the native editor seams fails closed: error notice, nothing staged", async (t) => {
  const menuHost = createFakeMenuTuiHost();
  setMenuTuiHost(menuHost);
  // No bridge host override, and entry discovery pointed at a non-existent
  // file so host resolution fails deterministically in every environment.
  setNativeEditorHostEntryProviderForTest(() => "/nonexistent/pi-entry.js");
  t.after(() => {
    setMenuTuiHost(undefined);
    setNativeEditorHostEntryProviderForTest(undefined);
    __resetActiveNativeEditorFieldForTest();
  });

  const { configPath } = await writeScheduledConfig();
  const before = await readFile(configPath, "utf8");
  const config = normalizeConfig(JSON.parse(before));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  // The field never opens a surface when the bridge is unavailable, so no
  // driver is consumed for it; the entry editor re-shows after the notice.
  const harness = tuiFlowContext([
    tuiKeys(...Array(14).fill(KEY_DOWN), KEY_ENTER), // root → Scheduled tasks (index 14)
    tuiKeys(KEY_ENTER), // list → task entry (row 0)
    tuiKeys(KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER), // entry editor → instructions (row 3)
    tuiKeys(...Array(6).fill(KEY_DOWN), KEY_ENTER), // entry re-show (row 3) → Back (row 9)
    tuiKeys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // list re-show → Back (row 2)
    tuiKeys(ESCAPE), // root: leave without saving
  ]);

  await registered.handler("", harness.ctx);

  assert.ok(
    harness.notifyCalls.some((call) => call.type === "error" && /native text editor is not available/i.test(call.message)),
    `expected the fail-closed notice: ${JSON.stringify(harness.notifyCalls)}`,
  );
  assert.equal(harness.editorCalls.length, 0, "no non-parity fallback field was presented");
  assert.equal(await readFile(configPath, "utf8"), before, "nothing was staged from a missing native seam");
});
