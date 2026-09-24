/**
 * Issue #26: every /review-settings text field is truly editable.
 *
 * Pins the agreed UI correction at the seam level:
 *
 * - All twelve former `ui.input(title, placeholder)` seams now go through Pi's
 *   public `ctx.ui.editor(title, currentValue)` when the host offers it: the
 *   current value arrives as an *editable prefill* (asserted per field), a
 *   submitted value stages exactly like before, and cancel (`undefined`)
 *   leaves the staged value unchanged.
 * - Without an editor the legacy `ui.input` fallback keeps its old
 *   title/placeholder semantics byte-for-byte.
 * - A host with neither seam fails closed: an error notice, nothing staged.
 * - The cron field shows the compact heading above the editable prefilled
 *   text: all five fields in order, machine-local time, and
 *   `* * * * * = every minute`.
 * - Scheduled instructions (and every ordinary field) use the public editor
 *   seam even in an interactive TUI — that is where the host provides native
 *   controls such as Ctrl+G external editing; no bespoke surface or private
 *   Pi member stands in for it.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { setMenuTuiHost } from "../src/settings/menu";
import { createFakeMenuTuiHost, IDENTITY_THEME } from "./menu-tui-fakes";

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

test("scheduled instructions use the public editor seam (the host's Ctrl+G path), never a custom surface", async (t) => {
  const fakeHost = createFakeMenuTuiHost();
  setMenuTuiHost(fakeHost);
  t.after(() => setMenuTuiHost(undefined));

  const { configPath } = await writeScheduledConfig();
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  // Interactive TUI context: menus render through ui.custom (fake host), but
  // the instructions field must still open through the public ui.editor —
  // that is where the host provides native controls such as Ctrl+G external
  // editing. A custom component for this ordinary field would be a regression.
  const KEY_DOWN = "\x1b[B";
  const KEY_ENTER = "\r";
  const editorCalls: Array<{ title: string; prefill?: string }> = [];
  let customCount = 0;
  let editorIndex = 0;
  const steps: string[][] = [
    // Root menu (16 sections): navigate to Scheduled tasks (index 14).
    [...Array(14).fill(KEY_DOWN), KEY_ENTER],
    // Scheduled list: row 0 is the task entry.
    [KEY_ENTER],
    // Entry editor: rows Name(0) cron(1) kind(2) instructions(3).
    [KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER],
    // Entry editor re-show (highlighted on instructions, row 3): Back is row 9.
    [...Array(6).fill(KEY_DOWN), KEY_ENTER],
    // Scheduled list re-show (entry row 0, Add row 1): Back is row 2.
    [KEY_DOWN, KEY_DOWN, KEY_ENTER],
    // Root re-show (highlighted on scheduled, index 14): Save is row 16.
    [KEY_DOWN, KEY_DOWN, KEY_ENTER],
  ];
  let stepIndex = 0;
  const ctx = {
    mode: "tui",
    scopedModels: [],
    ui: {
      custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | undefined) => void) => unknown): Promise<string | undefined> {
        customCount += 1;
        return new Promise<string | undefined>((resolve) => {
          const component = factory({ requestRender(): void {} }, IDENTITY_THEME, null, resolve) as {
            render?(width: number): string[];
            handleInput?(data: string): void;
          };
          component.render?.(80);
          for (const key of steps[stepIndex++] ?? []) component.handleInput?.(key);
        });
      },
      async select() {
        throw new Error("plain select must not be used in TUI mode with a loadable host");
      },
      async editor(title: string, prefill?: string) {
        editorCalls.push({ title, prefill });
        return ["Rewritten instructions"][editorIndex++];
      },
      notify() {},
    },
  };

  await registered.handler("", ctx);

  assert.equal(editorCalls.length, 1, "exactly one text field opened during this flow");
  assert.deepEqual(editorCalls[0], { title: "Instructions for the scheduled subtask", prefill: "Check the docs for staleness" });
  // Six custom surfaces — all menus; none for the instructions edit itself.
  assert.equal(customCount, 6, "menus use custom; the instructions field uses the public editor");

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.scheduledTasks["task-abcdef12"].instructions, "Rewritten instructions");
});
