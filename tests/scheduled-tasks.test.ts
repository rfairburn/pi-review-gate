import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cloneScheduledTaskCatalog,
  normalizeConfig,
  recoverConfig,
  type ScheduledTaskCatalog,
} from "../src/config";
import { DEFAULT_EXECUTION_RETRY_POLICY } from "../src/config";
import { parseCronExpression } from "../src/scheduling/cron";
import { getSchedulerRuntime, resetSchedulerRuntimeForTests } from "../src/scheduling/runtime";
import { registerReviewSettings } from "../src/settings/command";
import { persistReviewSettings, type ReviewSettingsSelection } from "../src/settings/persistence";

const baseSelection: ReviewSettingsSelection = {
  operatingMode: "orchestrate",
  modeCycleShortcut: "alt+m",
  workerResources: {},
  primaryReviewers: [],
  subtaskReviewers: [],
  primaryEnabled: true,
  subtaskEnabled: true,
  reviewLandedChanges: false,
  reviewerTimeoutMs: 600_000,
  executorTimeoutMs: 1_800_000,
  maxCorrectionCycles: 1,
  implementationGuidanceAfterCorrectionAttempts: 1,
  retainBundles: "on-failure",
  maxWorkers: 4,
  retryPolicy: { ...DEFAULT_EXECUTION_RETRY_POLICY },
  subtaskNotifications: "quiet",
  deferredPiTools: true,
  subtasksViewExpanded: false,
};

const validEntry = {
  name: "Nightly docs check",
  cron: "30 2 * * *",
  enabled: true,
  kind: "execute",
  instructions: "Check the docs for staleness",
  workspace: "/tmp/prg-nightly",
};

// --- Cron expression grammar -------------------------------------------------

test("parseCronExpression accepts standard 5-field expressions and canonicalizes field sets", () => {
  const simple = parseCronExpression("30 2 * * *", "cron");
  assert.deepEqual(simple.minutes, [30]);
  assert.deepEqual(simple.hours, [2]);
  assert.deepEqual(simple.daysOfMonth, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
  assert.deepEqual(simple.months, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(simple.daysOfWeek, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(simple.expression, "30 2 * * *");

  const lists = parseCronExpression("0,15,30  9-17/2 * jan-mar mon-fri", "cron");
  assert.deepEqual(lists.minutes, [0, 15, 30]);
  assert.deepEqual(lists.hours, [9, 11, 13, 15, 17]);
  assert.deepEqual(lists.months, [1, 2, 3]);
  assert.deepEqual(lists.daysOfWeek, [1, 2, 3, 4, 5]);

  // Day-of-week 7 is Sunday, normalized to 0.
  const sunday = parseCronExpression("0 0 * * 7", "cron");
  assert.deepEqual(sunday.daysOfWeek, [0]);
  assert.deepEqual(parseCronExpression("0 0 * * 0,7", "cron").daysOfWeek, [0]);

  // Step on a bare value runs to the field maximum (Vixie semantics).
  assert.deepEqual(parseCronExpression("10/20 * * * *", "cron").minutes, [10, 30, 50]);
  // Star step.
  assert.deepEqual(parseCronExpression("*/15 * * * *", "cron").minutes, [0, 15, 30, 45]);
  // Extra whitespace is collapsed, never stored.
  assert.equal(parseCronExpression("  0\t12   1   *   0  ", "cron").expression, "0 12 1 * 0");
});

test("parseCronExpression rejects malformed or out-of-range expressions", () => {
  const invalid: Array<[unknown, RegExp]> = [
    ["", /must be a non-empty/],
    [undefined, /must be a non-empty/],
    [42, /must be a non-empty/],
    ["* * * *", /standard 5-field cron expression \(minute hour day-of-month month day-of-week\); got 4 field/],
    ["* * * * * *", /standard 5-field cron expression \(minute hour day-of-month month day-of-week\); got 6 field/],
    ["60 * * * *", /minute value "60" is out of range 0-59/],
    ["* 24 * * *", /hour value "24" is out of range 0-23/],
    ["* * 0 * *", /day of month value "0" is out of range 1-31/],
    ["* * * 13 *", /month value "13" is out of range 1-12/],
    ["* * * * 8", /day of week value "8" is out of range 0-7/],
    ["5-1 * * * *", /reversed minute range "5-1"/],
    ["*/0 * * * *", /invalid minute step "0"/],
    ["*/x * * * *", /invalid minute step "x"/],
    ["a-b * * * *", /invalid minute value "a"/],
    ["*/ * * * *", /invalid minute step/],
    ["1,,2 * * * *", /invalid minute value ""/],
  ];
  for (const [value, pattern] of invalid) {
    if (!pattern) {
      assert.doesNotThrow(() => parseCronExpression(value, "cron"));
      continue;
    }
    assert.throws(() => parseCronExpression(value, "cron"), pattern, `${String(value)} should be invalid`);
  }
});

// --- Config schema and normalization -----------------------------------------

function configWithScheduledTasks(scheduledTasks: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { enabled: true, review: { primaryReviewers: [], subtaskReviewers: [] }, scheduledTasks, ...extra };
}

test("scheduled task entries normalize with defaults, trimming, and cron validation", () => {
  const config = normalizeConfig(configWithScheduledTasks({
    "task-abc12345": { ...validEntry, workspace: "  /tmp/prg-nightly  " },
    "task-def67890": {
      name: "Weekly research",
      cron: "0 9 * * mon",
      enabled: false,
      kind: "research",
      instructions: "Summarize the release notes",
      workspace: "/tmp/prg-research",
      workerResourceId: "primary",
      review: { mode: "off" },
    },
    "task-00000001": {
      name: "Legacy import",
      cron: "0 12 * * 1",
      kind: "execute",
      instructions: "Run the import",
      workspace: "/tmp/prg-import",
      review: { mode: "selected", reviewers: [{ source: "pi", model: "openai/gpt-5" }] },
    },
  }, {
    execution: {
      workerResources: {
        primary: { selection: { source: "pi", model: "openai/gpt-5" }, maxConcurrent: 1 },
      },
    },
  }));
  const tasks = config.scheduledTasks!;
  assert.deepEqual(Object.keys(tasks), ["task-abc12345", "task-def67890", "task-00000001"]);
  assert.equal(tasks["task-abc12345"]!.enabled, true);
  assert.equal(tasks["task-abc12345"]!.kind, "execute");
  assert.equal(tasks["task-abc12345"]!.workspace, "/tmp/prg-nightly");
  assert.equal(tasks["task-abc12345"]!.workerResourceId, undefined);
  assert.equal(tasks["task-abc12345"]!.review, undefined);
  assert.equal(tasks["task-def67890"]!.enabled, false);
  assert.equal(tasks["task-def67890"]!.cron, "0 9 * * mon");
  assert.equal(tasks["task-def67890"]!.review!.mode, "off");
  assert.equal(tasks["task-00000001"]!.review!.mode, "selected");
  assert.deepEqual(tasks["task-00000001"]!.review as { reviewers: unknown[] }, {
    mode: "selected",
    reviewers: [{ source: "pi", model: "openai/gpt-5" }],
  });
});

test("config loading keeps a hand-edited ~/ workspace verbatim for run-time expansion", () => {
  // Load-time normalization is non-destructive: the tilde spelling stays in
  // the catalog (and the file) and is expanded at dispatch time against the
  // user's home, never baked in at load.
  const config = normalizeConfig(configWithScheduledTasks({
    "task-tilde": { ...validEntry, workspace: "~/prg/nightly" },
  }));
  assert.equal(config.scheduledTasks!["task-tilde"]!.workspace, "~/prg/nightly");
});

test("scheduled task entries reject invalid definitions strictly", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ "task-a": { ...validEntry, name: "   " } }, /scheduledTasks\.task-a\.name must be a non-empty string/],
    [{ "task-a": { ...validEntry, cron: "" } }, /scheduledTasks\.task-a\.cron must be a non-empty/],
    [{ "task-a": { ...validEntry, cron: "99 * * * *" } }, /minute value "99" is out of range/],
    [{ "task-a": { ...validEntry, enabled: "yes" } }, /scheduledTasks\.task-a\.enabled must be a boolean/],
    [{ "task-a": { ...validEntry, kind: "deploy" } }, /scheduledTasks\.task-a\.kind must be execute or research/],
    [{ "task-a": { ...validEntry, instructions: "" } }, /scheduledTasks\.task-a\.instructions must be a non-empty string/],
    [{ "task-a": { ...validEntry, workspace: "" } }, /scheduledTasks\.task-a\.workspace must be a non-empty string/],
    [{ "task-a": { ...validEntry, workerResourceId: "no such id" } }, /scheduled task worker resource id may contain only/],
    [{ "task-a": { ...validEntry, review: { mode: "whatever" } } }, /scheduledTasks\.task-a\.review\.mode must be "off" or "selected"/],
    [{ "task-a": { ...validEntry, review: { mode: "selected", reviewers: [{ source: "nonsense" }] } } }, /unsupported scheduledTasks\.task-a\.review\.reviewers source/],
    [{ "task-bad id": { ...validEntry } }, /scheduled task id may contain only/],
    [{ "task-a": { ...validEntry, workerResourceId: "missing-resource" } }, /references unknown worker resource missing-resource/],
  ];
  for (const [scheduledTasks, pattern] of cases) {
    assert.throws(() => normalizeConfig(configWithScheduledTasks(scheduledTasks)), pattern);
  }
});

test("a research scheduled task cannot override to a non-research-capable worker", () => {
  assert.throws(
    () => normalizeConfig({
      enabled: true,
      externalAgents: {
        "generic-only": { adapter: "generic-cli", command: "node", review: {} },
      },
      execution: {
        workerResources: {
          "generic-only": { selection: { source: "external", id: "generic-only" }, maxConcurrent: 1 },
        },
      },
      scheduledTasks: {
        "task-research": {
          name: "Research",
          cron: "0 9 * * *",
          kind: "research",
          instructions: "Investigate",
          workspace: "/tmp/prg",
          workerResourceId: "generic-only",
        },
      },
    }),
    /scheduledTasks\.task-research worker resource is not research-capable: generic-only/,
  );
});

test("an explicit worker override does not require global route membership", () => {
  // The override must come from the independent worker catalog: an entry can
  // name a resource that no global route lists (issue #26) without rejection.
  const config = normalizeConfig({
    enabled: true,
    execution: {
      workerResources: {
        "pi-resource": { selection: { source: "pi", model: "openai/gpt-5" }, maxConcurrent: 1 },
      },
      routes: { execute: [], research: [] },
    },
    scheduledTasks: {
      "task-independent": {
        name: "Independent",
        cron: "0 9 * * *",
        kind: "execute",
        instructions: "Work",
        workspace: "/tmp/prg",
        workerResourceId: "pi-resource",
      },
    },
  });
  assert.equal(config.scheduledTasks!["task-independent"]!.workerResourceId, "pi-resource");
});

test("scheduledTasks with a non-object or bad entry shape is rejected", () => {
  assert.throws(() => normalizeConfig(configWithScheduledTasks([])), /scheduledTasks must be an object/);
  assert.throws(() => normalizeConfig(configWithScheduledTasks({ "task-a": "nope" })), /scheduledTasks\.task-a must be an object/);
  assert.throws(() => normalizeConfig(configWithScheduledTasks({ "task-a": [validEntry] })), /scheduledTasks\.task-a must be an object/);
});

test("startup recovery drops only invalid scheduled task entries and warns", () => {
  const recovered = recoverConfig({
    enabled: true,
    scheduledTasks: {
      "task-good": { ...validEntry },
      "task-bad": { ...validEntry, cron: "not a cron" },
      "task-also-good": { ...validEntry, name: "Second", cron: "0 12 * * 1" },
    },
  });
  assert.deepEqual(Object.keys(recovered.config.scheduledTasks ?? {}), ["task-good", "task-also-good"]);
  assert.ok(recovered.warnings?.some((warning) => warning.includes("scheduledTasks.task-bad")));
});

test("cloneScheduledTaskCatalog deep-clones entries without sharing override state", () => {
  const catalog: ScheduledTaskCatalog = {
    "task-a": {
      name: "One",
      cron: "0 9 * * *",
      enabled: true,
      kind: "execute",
      instructions: "Work",
      workspace: "/tmp/prg",
      review: { mode: "selected", reviewers: [{ source: "pi", model: "openai/gpt-5" }] },
    },
  };
  const clone = cloneScheduledTaskCatalog(catalog);
  clone["task-a"]!.name = "Renamed";
  (clone["task-a"]!.review as { reviewers: Array<Record<string, unknown>> }).reviewers[0]!.model = "mutated";
  assert.equal(catalog["task-a"]!.name, "One");
  assert.equal(catalog["task-a"]!.review!.mode, "selected");
  assert.deepEqual(catalog["task-a"]!.review, { mode: "selected", reviewers: [{ source: "pi", model: "openai/gpt-5" }] });
});

// --- Persistence -------------------------------------------------------------

async function writeConfig(json: unknown): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-scheduled-tasks-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify(json), "utf8");
  return { dir, configPath };
}

test("scheduled tasks round-trip once with absent override fields staying absent", async () => {
  const { dir, configPath } = await writeConfig({
    enabled: true,
    review: { primaryReviewers: [{ source: "pi", model: "openai/gpt-5" }], subtaskReviewers: [{ source: "pi", model: "openai/gpt-5" }] },
    execution: { workerResources: { "pi-1": { selection: { source: "pi", model: "openai/gpt-5" }, maxConcurrent: 2 } } },
  });
  try {
    const catalog: ScheduledTaskCatalog = {
      "task-inherit": {
        name: "Inheriting task",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Work",
        workspace: "/tmp/prg-inherit",
        // No workerResourceId, no review: both inherit live global settings.
      },
      "task-override": {
        name: "Overriding task",
        cron: "0 12 * * 1",
        enabled: false,
        kind: "execute",
        instructions: "Other work",
        workspace: "/tmp/prg-override",
        workerResourceId: "pi-1",
        review: { mode: "off" },
      },
    };
    await persistReviewSettings(configPath, {
      ...baseSelection,
      primaryReviewers: [{ source: "pi", model: "openai/gpt-5" }],
      subtaskReviewers: [{ source: "pi", model: "openai/gpt-5" }],
      workerResources: { "pi-1": { selection: { source: "pi", model: "openai/gpt-5" }, maxConcurrent: 2 } },
      scheduledTasks: catalog,
    });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    // Each entry is stored exactly once; inherited fields are absent, not null
    // or copied globals.
    assert.deepEqual(saved.scheduledTasks, {
      "task-inherit": {
        name: "Inheriting task",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Work",
        workspace: "/tmp/prg-inherit",
      },
      "task-override": {
        name: "Overriding task",
        cron: "0 12 * * 1",
        enabled: false,
        kind: "execute",
        instructions: "Other work",
        workspace: "/tmp/prg-override",
        workerResourceId: "pi-1",
        review: { mode: "off" },
      },
    });
    assert.equal(Object.keys(saved.scheduledTasks["task-inherit"]).includes("workerResourceId"), false);
    assert.equal(Object.keys(saved.scheduledTasks["task-inherit"]).includes("review"), false);

    // The save is task-local: global review state and routes are untouched.
    assert.deepEqual(saved.review, {
      primaryReviewers: [{ source: "pi", model: "openai/gpt-5" }],
      subtaskReviewers: [{ source: "pi", model: "openai/gpt-5" }],
      primaryEnabled: true,
      subtaskEnabled: true,
      reviewLandedChanges: false,
    });
    assert.deepEqual(saved.execution.routes, { execute: [], research: [] });
    assert.deepEqual(saved.execution.workerResources, {
      "pi-1": { selection: { source: "pi", model: "openai/gpt-5" }, maxConcurrent: 2 },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("editing one scheduled task entry leaves the others untouched", async () => {
  const { dir, configPath } = await writeConfig({ enabled: true });
  try {
    const first: ScheduledTaskCatalog = {
      "task-one": { name: "One", cron: "0 9 * * *", enabled: true, kind: "execute", instructions: "One", workspace: "/tmp/prg-one" },
      "task-two": { name: "Two", cron: "0 10 * * *", enabled: true, kind: "research", instructions: "Two", workspace: "/tmp/prg-two" },
    };
    await persistReviewSettings(configPath, { ...baseSelection, scheduledTasks: first });
    const second = cloneScheduledTaskCatalog(first);
    second["task-one"] = { ...second["task-one"]!, name: "One renamed", enabled: false };
    await persistReviewSettings(configPath, { ...baseSelection, scheduledTasks: second });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.scheduledTasks["task-one"].name, "One renamed");
    assert.equal(saved.scheduledTasks["task-one"].enabled, false);
    assert.deepEqual(saved.scheduledTasks["task-two"], {
      name: "Two",
      cron: "0 10 * * *",
      enabled: true,
      kind: "research",
      instructions: "Two",
      workspace: "/tmp/prg-two",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a save that omits the scheduled-task section preserves the stored entries", async () => {
  const { dir, configPath } = await writeConfig({ enabled: true });
  try {
    const catalog: ScheduledTaskCatalog = {
      "task-keep": { name: "Keep", cron: "0 9 * * *", enabled: true, kind: "execute", instructions: "Work", workspace: "/tmp/prg" },
    };
    await persistReviewSettings(configPath, { ...baseSelection, scheduledTasks: catalog });
    // Older callers (or a section the menu did not stage) never erase schedules.
    await persistReviewSettings(configPath, baseSelection);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.scheduledTasks, {
      "task-keep": { name: "Keep", cron: "0 9 * * *", enabled: true, kind: "execute", instructions: "Work", workspace: "/tmp/prg" },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saving staged scheduled tasks never erases entries another process added", async () => {
  const { dir, configPath } = await writeConfig({ enabled: true });
  try {
    const staged: ScheduledTaskCatalog = {
      "task-stale": { name: "Staged", cron: "0 9 * * *", enabled: true, kind: "execute", instructions: "Work", workspace: "/tmp/prg" },
      "task-removed": { name: "Removed", cron: "0 10 * * *", enabled: true, kind: "execute", instructions: "Work", workspace: "/tmp/prg" },
    };
    await persistReviewSettings(configPath, { ...baseSelection, scheduledTasks: staged });
    // Another Pi process (for example a running scheduler) adds an entry on
    // disk after the settings menu captured its staged catalog.
    await persistReviewSettings(configPath, {
      ...baseSelection,
      scheduledTasks: {
        ...staged,
        "task-external": { name: "External", cron: "0 11 * * *", enabled: true, kind: "execute", instructions: "Work", workspace: "/tmp/prg" },
      },
    });
    const before = await readFile(configPath, "utf8");
    const saved = JSON.parse(before);
    assert.equal(saved.scheduledTasks["task-external"].name, "External");

    // The stale instance's Save (staged catalog without task-external, staged
    // from both of its own ids) keeps the externally added entry while still
    // applying its own removal.
    await persistReviewSettings(configPath, {
      ...baseSelection,
      scheduledTasks: {
        "task-stale": staged["task-stale"]!,
      },
      scheduledTasksStagedFrom: ["task-stale", "task-removed"],
    });
    const after = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(Object.keys(after.scheduledTasks).sort(), ["task-external", "task-stale"]);
    assert.equal(after.scheduledTasks["task-stale"].name, "Staged");
    assert.equal(after.scheduledTasks["task-external"].name, "External");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an invalid scheduled task entry fails the save before any write", async () => {
  const { dir, configPath } = await writeConfig({ enabled: true, custom: { keep: true } });
  try {
    const before = await readFile(configPath, "utf8");
    await assert.rejects(
      persistReviewSettings(configPath, {
        ...baseSelection,
        scheduledTasks: {
          "task-bad": { name: "Bad", cron: "61 * * * *", enabled: true, kind: "execute", instructions: "Work", workspace: "/tmp/prg" },
        },
      }),
      /minute value "61" is out of range 0-59/,
    );
    assert.equal(await readFile(configPath, "utf8"), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- Settings menu -----------------------------------------------------------

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

function contextWithSelections(
  values: Array<string | undefined>,
  inputs: Array<string | undefined> = [],
  cwd?: string,
): unknown {
  let index = 0;
  let inputIndex = 0;
  return {
    scopedModels: [],
    ...(cwd !== undefined ? { cwd } : {}),
    ui: {
      async select(title: string, options: string[]) {
        const value = values[index++];
        if (value !== undefined) assert.ok(options.includes(value), `missing selection ${value}: ${options.join(" | ")}`);
        return value;
      },
      async input() {
        return inputs[inputIndex++];
      },
      async confirm() {
        return false;
      },
      notify() {},
    },
  };
}

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
  "Scheduler runtime",
  "Web",
] as const;

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

function alignedTestRow(label: string, value: string, labels: readonly string[]): string {
  const width = Math.max(...labels.map((candidate) => candidate.length));
  return `${label.padEnd(width)}  ${value}`;
}

function rootSettingsRow(label: string, value: string): string {
  return alignedTestRow(label, value, ROOT_SETTING_LABELS);
}

function scheduledEditorRow(label: string, value: string): string {
  return alignedTestRow(label, value, SCHEDULED_EDITOR_LABELS);
}

test("/review-settings creates a scheduled task entry and saves it with staged semantics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-scheduled-menu-"));
  const workspace = dir;
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    customFutureKey: { keep: true },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Scheduled tasks", "None"),
    "Add scheduled task",
    // Editor: cron, kind, instructions, workspace, review override, then back.
    scheduledEditorRow("Schedule (cron)", "(not set)"),
    scheduledEditorRow("Kind", "execute"),
    "Execute — write-capable subtask  current",
    scheduledEditorRow("Instructions", "(not set)"),
    scheduledEditorRow("Workspace", "(not set)"),
    scheduledEditorRow("Review", "Inherit global subtask review"),
    "Off — run this task's subtasks without review",
    "Back",
    "Back",
    "Save changes",
  ], [
    "Nightly docs check",
    "30 2 * * *",
    "Check the docs for staleness",
    workspace,
  ]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  const ids = Object.keys(saved.scheduledTasks);
  assert.equal(ids.length, 1);
  assert.match(ids[0]!, /^task-[0-9a-f]{8}$/);
  const entry = saved.scheduledTasks[ids[0]!];
  // The explicit task-local review Off is persisted; no worker override was staged.
  assert.equal(Object.keys(entry).includes("workerResourceId"), false);
  assert.deepEqual(entry, {
    name: "Nightly docs check",
    cron: "30 2 * * *",
    enabled: true,
    kind: "execute",
    instructions: "Check the docs for staleness",
    workspace,
    review: { mode: "off" },
  });
  assert.deepEqual(saved.customFutureKey, { keep: true });
});

test("/review-settings validates a relative completed workspace against the session cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-scheduled-session-cwd-"));
  const relativeWorkspace = "only-under-this-session";
  const configPath = join(dir, "review-gate.json");
  await mkdir(join(dir, relativeWorkspace));
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  try {
    await registered.handler("", contextWithSelections([
      rootSettingsRow("Scheduled tasks", "None"),
      "Add scheduled task",
      scheduledEditorRow("Schedule (cron)", "(not set)"),
      scheduledEditorRow("Instructions", "(not set)"),
      scheduledEditorRow("Workspace", "(not set)"),
      "Back",
      "Back",
      "Save changes",
    ], [
      "Session-local docs check", "30 2 * * *", "Check docs", relativeWorkspace,
    ], dir));

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    const ids = Object.keys(saved.scheduledTasks);
    assert.equal(ids.length, 1, "Save accepts a directory in the session cwd even when the process cwd differs");
    assert.equal(saved.scheduledTasks[ids[0]!].workspace, relativeWorkspace, "the relative spelling is retained for runtime resolution");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/review-settings stages edits to an existing scheduled task and preserves its identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-scheduled-menu-edit-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Original name",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Original instructions",
        workspace: dir,
      },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  // Toggle the entry off and rename it; the id stays.
  await registered.handler("", contextWithSelections([
    rootSettingsRow("Scheduled tasks", "1 of 1 enabled"),
    "1. Original name — 0 9 * * * — execute — enabled",
    scheduledEditorRow("Name", "Original name"),
    scheduledEditorRow("Enabled", "On"),
    "Back",
    "Back",
    "Save changes",
  ], ["Renamed nightly check"]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(Object.keys(saved.scheduledTasks), ["task-abcdef12"]);
  const entry = saved.scheduledTasks["task-abcdef12"];
  assert.equal(entry.name, "Renamed nightly check");
  assert.equal(entry.enabled, false);
  assert.equal(entry.cron, "0 9 * * *");
  assert.equal(entry.instructions, "Original instructions");
  assert.equal(entry.workspace, dir);
});

test("/review-settings persists a task-local review Off without touching global review state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-scheduled-menu-review-"));
  const configPath = join(dir, "review-gate.json");
  const review = { primaryReviewers: [], subtaskReviewers: [], primaryEnabled: true, subtaskEnabled: true, reviewLandedChanges: false };
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review,
    scheduledTasks: {
      "task-abcdef12": {
        name: "Unreviewed sync",
        cron: "0 3 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Sync",
        workspace: dir,
      },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Scheduled tasks", "1 of 1 enabled"),
    "1. Unreviewed sync — 0 3 * * * — execute — enabled",
    scheduledEditorRow("Review", "Inherit global subtask review"),
    "Off — run this task's subtasks without review",
    "Back",
    "Back",
    "Save changes",
  ]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.scheduledTasks["task-abcdef12"].review, { mode: "off" });
  // Global/parent review state is byte-for-byte unchanged.
  assert.deepEqual(saved.review, review);
  // The in-memory config replacement carried the same task-local choice.
  assert.equal(config.scheduledTasks!["task-abcdef12"]!.review!.mode, "off");
  // normalizeConfig keeps the legacy import key as an explicit undefined slot
  // on the in-memory record; the persisted file omits it entirely.
  assert.deepEqual((config as unknown as { review: unknown }).review, { ...review, activeReviewers: undefined });
});

test("/review-settings rejects an incomplete scheduled task at Save and keeps editing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-scheduled-menu-invalid-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  const notifications: Array<{ message: string; type: string }> = [];
  const ctx = {
    scopedModels: [],
    ui: {
      selectCount: 0,
      async select(_title: string, _options: string[]) {
        // Sequence: root → scheduled list → Add → editor cron prompt (the
        // invalid input is rejected live) → leave editor and list → Save at
        // the root, where validateScheduledTasks blocks again → Cancel.
        this.selectCount += 1;
        if (this.selectCount === 1) return rootSettingsRow("Scheduled tasks", "None");
        if (this.selectCount === 2) return "Add scheduled task";
        if (this.selectCount === 3) return scheduledEditorRow("Schedule (cron)", "(not set)");
        if (this.selectCount === 4) return "Back";
        if (this.selectCount === 5) return "Back";
        if (this.selectCount === 6) return "Save changes";
        return "Cancel";
      },
      async input() {
        return "Only a name";
      },
      async confirm() {
        return false;
      },
      notify(message: string, type: string) {
        notifications.push({ message, type });
      },
    },
  };
  registerReviewSettings({ pi: registered.pi, config, configPath });
  await registered.handler("", ctx);
  // The editor's live cron parse rejected the input, and the Save gate then
  // rejected the still-incomplete staged entry with its own named error.
  assert.ok(
    notifications.some((entry) => entry.type === "error" && /cron expression must be a standard 5-field cron expression/.test(entry.message)),
    "expected the editor's live cron validation error",
  );
  assert.ok(
    notifications.some((entry) => entry.type === "error" && /scheduled task "Only a name" must be a non-empty standard 5-field cron expression string/.test(entry.message)),
    "expected the Save-gate validation error",
  );
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.scheduledTasks, undefined);
});

test("a foreign on-disk schedule entry this snapshot cannot resolve never blocks a Save", async () => {
  // Cross-process setup: another Pi saved resource pi-x and task-foreign
  // pinning it; this stale snapshot stages neither.
  const { dir, configPath } = await writeConfig({
    enabled: true,
    execution: {
      workerResources: {
        "pi-x": { selection: { source: "pi", model: "openai/gpt-5" }, maxConcurrent: 1 },
      },
    },
    scheduledTasks: {
      "task-stale": { name: "Staged", cron: "0 9 * * *", enabled: true, kind: "execute", instructions: "Work", workspace: "/tmp/prg" },
      "task-foreign": {
        name: "Foreign",
        cron: "0 11 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Work",
        workspace: "/tmp/prg",
        workerResourceId: "pi-x",
      },
    },
  });
  try {
    const normalized = await persistReviewSettings(configPath, {
      ...baseSelection,
      workerResources: {},
      scheduledTasks: {
        "task-stale": { name: "Staged renamed", cron: "0 9 * * *", enabled: true, kind: "execute", instructions: "Work", workspace: "/tmp/prg" },
      },
      scheduledTasksStagedFrom: ["task-stale"],
    });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    // The foreign entry survived verbatim, unvalidated by this save.
    assert.deepEqual(saved.scheduledTasks["task-foreign"], {
      name: "Foreign",
      cron: "0 11 * * *",
      enabled: true,
      kind: "execute",
      instructions: "Work",
      workspace: "/tmp/prg",
      workerResourceId: "pi-x",
    });
    // The staged entry was applied normally.
    assert.deepEqual(Object.keys(saved.scheduledTasks).sort(), ["task-foreign", "task-stale"]);
    assert.equal(saved.scheduledTasks["task-stale"].name, "Staged renamed");
    // The in-memory replacement carries the staged catalog only: this process
    // sees the other process's entry on its own reload.
    assert.deepEqual(Object.keys(normalized.scheduledTasks ?? {}), ["task-stale"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hand-edited invalid schedule entry survives a Save it cannot block", async () => {
  const { dir, configPath } = await writeConfig({
    enabled: true,
    scheduledTasks: {
      "task-good": { name: "Good", cron: "0 9 * * *", enabled: true, kind: "execute", instructions: "Work", workspace: "/tmp/prg" },
      // Hand-edited on disk: invalid cron. Recovery drops it from memory with
      // a warning, but the raw file keeps it, and a Save must keep it there
      // without failing because of it.
      "task-broken": { name: "Broken", cron: "not a cron", enabled: true, kind: "execute", instructions: "Work", workspace: "/tmp/prg" },
    },
  });
  try {
    const recovered = recoverConfig(JSON.parse(await readFile(configPath, "utf8")));
    assert.deepEqual(Object.keys(recovered.config.scheduledTasks ?? {}), ["task-good"]);
    await persistReviewSettings(configPath, {
      ...baseSelection,
      scheduledTasks: {
        "task-good": recovered.config.scheduledTasks!["task-good"]!,
      },
      scheduledTasksStagedFrom: ["task-good"],
    });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    // The broken entry stays verbatim on disk for its author; the staged entry
    // was saved normally.
    assert.deepEqual(saved.scheduledTasks["task-broken"], {
      name: "Broken",
      cron: "not a cron",
      enabled: true,
      kind: "execute",
      instructions: "Work",
      workspace: "/tmp/prg",
    });
    assert.equal(saved.scheduledTasks["task-good"].name, "Good");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovery keeps valid worker-pinned entries regardless of JSON key order", () => {
  const tasks = {
    "task-pinned": {
      name: "Pinned",
      cron: "0 9 * * *",
      enabled: true,
      kind: "execute",
      instructions: "Work",
      workspace: "/tmp/prg",
      workerResourceId: "pi-1",
    },
  };
  const execution = {
    workerResources: {
      "pi-1": { selection: { source: "pi", model: "openai/gpt-5" }, maxConcurrent: 1 },
    },
  };
  // scheduledTasks listed BEFORE execution, plus an unrelated invalid field.
  const tasksFirst = recoverConfig({
    reviewerTimeoutMs: -1,
    scheduledTasks: tasks,
    execution,
  });
  assert.deepEqual(Object.keys(tasksFirst.config.scheduledTasks ?? {}), ["task-pinned"]);
  assert.ok(tasksFirst.warnings?.some((warning) => warning.includes("reviewerTimeoutMs")));
  // The opposite key order recovers identically.
  const executionFirst = recoverConfig({
    reviewerTimeoutMs: -1,
    execution,
    scheduledTasks: tasks,
  });
  assert.deepEqual(Object.keys(executionFirst.config.scheduledTasks ?? {}), ["task-pinned"]);
});

test("a scheduled task can override to a worker resource added earlier in the same staged session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-scheduled-menu-worker-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    externalAgents: {
      fake: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  await registered.handler("", contextWithSelections([
    rootSettingsRow("Worker resources", "0 models · 0 slots"),
    "Add worker resource",
    "fake [run-as-binary]",
    "1  current",
    "Back",
    rootSettingsRow("Scheduled tasks", "None"),
    "Add scheduled task",
    scheduledEditorRow("Schedule (cron)", "(not set)"),
    scheduledEditorRow("Instructions", "(not set)"),
    scheduledEditorRow("Workspace", "(not set)"),
    scheduledEditorRow("Worker", "Inherit global route"),
    "fake [run-as-binary]",
    "Back",
    "Back",
    "Save changes",
  ], [
    "Staged worker task",
    "0 9 * * *",
    "Work",
    dir,
  ]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  // The staged (not yet persisted) resource was pickable and was saved as the
  // task's override together with the resource itself.
  assert.deepEqual(saved.execution.workerResources, {
    "external-fake": { selection: { source: "external", id: "fake" }, maxConcurrent: 1 },
  });
  const ids = Object.keys(saved.scheduledTasks);
  assert.equal(ids.length, 1);
  assert.equal(saved.scheduledTasks[ids[0]!].workerResourceId, "external-fake");
  assert.equal(saved.scheduledTasks[ids[0]!].name, "Staged worker task");
});

test("a hand-edited task id that matches a former action key stays editable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-scheduled-menu-id-collide-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      // Legally configured ids that once collided with the submenu action rows.
      add: { name: "AddTask", cron: "0 9 * * *", enabled: true, kind: "execute", instructions: "Work", workspace: dir },
      back: { name: "BackTask", cron: "0 10 * * *", enabled: true, kind: "execute", instructions: "Work", workspace: dir },
    },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });

  // Open the "add" entry directly (no longer shadowed by the Add action),
  // toggle it off, and save.
  await registered.handler("", contextWithSelections([
    rootSettingsRow("Scheduled tasks", "2 of 2 enabled"),
    "1. AddTask — 0 9 * * * — execute — enabled",
    scheduledEditorRow("Enabled", "On"),
    "Back",
    "Back",
    "Save changes",
  ]));

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.scheduledTasks["add"].enabled, false);
  assert.equal(saved.scheduledTasks["back"].enabled, true);
  await rm(dir, { recursive: true, force: true });
});

// --- Tilde workspaces (issue #26) -------------------------------------------

/**
 * Point the platform's homedir() source at a synthetic home for the duration
 * of fn and restore it afterwards (the same pattern apply-patch.test.ts uses),
 * so tilde expansion is exercised without touching the real home.
 */
async function withSyntheticHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = home;
    process.env.USERPROFILE = home; // win32's homedir source
    // Fail closed before any mutation if the override is not in effect.
    assert.equal(homedir(), home, "synthetic home must be in effect before any mutation");
    return await fn();
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  }
}

async function freshConfigWithScheduledTasks(json: Record<string, unknown>): Promise<{ dir: string; configPath: string; config: ReturnType<typeof normalizeConfig>; registered: { pi: unknown; handler: (args: string, ctx: unknown) => Promise<void> } }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-scheduled-tilde-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify(json), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  registerReviewSettings({ pi: registered.pi, config, configPath });
  return { dir, configPath, config, registered };
}

test("/review-settings expands an entered ~/ workspace to its absolute home path on Save", async () => {
  const fakeHome = await realpath(await mkdtemp(join(tmpdir(), "pi-review-scheduled-tilde-home-")));
  try {
    await mkdir(join(fakeHome, "nightly"), { recursive: true });
    const { dir, configPath, registered } = await freshConfigWithScheduledTasks({
      enabled: true,
      review: { primaryReviewers: [], subtaskReviewers: [] },
    });
    try {
      await withSyntheticHome(fakeHome, () => registered.handler("", contextWithSelections([
        rootSettingsRow("Scheduled tasks", "None"),
        "Add scheduled task",
        scheduledEditorRow("Schedule (cron)", "(not set)"),
        scheduledEditorRow("Instructions", "(not set)"),
        scheduledEditorRow("Workspace", "(not set)"),
        "Back",
        "Back",
        "Save changes",
      ], [
        "Nightly docs check",
        "30 2 * * *",
        "Check the docs for staleness",
        "~/nightly",
      ])));

      const saved = JSON.parse(await readFile(configPath, "utf8"));
      const ids = Object.keys(saved.scheduledTasks);
      assert.equal(ids.length, 1);
      // The persisted workspace is the expanded absolute home spelling, not
      // the entered tilde spelling: one representation in the saved file.
      assert.equal(saved.scheduledTasks[ids[0]!].workspace, join(fakeHome, "nightly"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("/review-settings expands a hand-edited ~/ workspace on Save without re-entry", async () => {
  const fakeHome = await realpath(await mkdtemp(join(tmpdir(), "pi-review-scheduled-tilde-home2-")));
  try {
    await mkdir(join(fakeHome, "prg", "nightly"), { recursive: true });
    const { dir, configPath, registered } = await freshConfigWithScheduledTasks({
      enabled: true,
      review: { primaryReviewers: [], subtaskReviewers: [] },
      scheduledTasks: {
        "task-tilde12": {
          name: "Tilde nightly",
          cron: "30 2 * * *",
          enabled: true,
          kind: "execute",
          instructions: "Check the docs",
          workspace: "~/prg/nightly",
        },
      },
    });
    try {
      // Open the section and save without touching the entry: the hand-edited
      // tilde spelling is accepted (the directory exists) and persisted in its
      // expanded absolute form.
      await withSyntheticHome(fakeHome, () => registered.handler("", contextWithSelections([
        rootSettingsRow("Scheduled tasks", "1 of 1 enabled"),
        "Back",
        "Save changes",
      ])));

      const saved = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(saved.scheduledTasks["task-tilde12"].workspace, join(fakeHome, "prg", "nightly"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("a Save fails closed on a ~/ workspace that is not an existing directory", async () => {
  const fakeHome = await realpath(await mkdtemp(join(tmpdir(), "pi-review-scheduled-tilde-home3-")));
  try {
    const { dir, configPath, registered } = await freshConfigWithScheduledTasks({
      enabled: true,
      review: { primaryReviewers: [], subtaskReviewers: [] },
      scheduledTasks: {
        "task-missing": {
          name: "Missing target",
          cron: "30 2 * * *",
          enabled: true,
          kind: "execute",
          instructions: "Work",
          workspace: "~/does-not-exist",
        },
      },
    });
    const before = await readFile(configPath, "utf8");
    try {
      // Validation rejects the entry; with no further selections the re-shown
      // menu exits and nothing is written.
      await withSyntheticHome(fakeHome, () => registered.handler("", contextWithSelections([
        rootSettingsRow("Scheduled tasks", "1 of 1 enabled"),
        "Back",
        "Save changes",
      ])));
      assert.equal(await readFile(configPath, "utf8"), before, "a rejected ~/ workspace must not change the config file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("a Save fails closed when a ~/ workspace names an existing file, not a directory", async () => {
  const fakeHome = await realpath(await mkdtemp(join(tmpdir(), "pi-review-scheduled-tilde-home4-")));
  try {
    await writeFile(join(fakeHome, "not-a-dir"), "a file\n", "utf8");
    const { dir, configPath, registered } = await freshConfigWithScheduledTasks({
      enabled: true,
      review: { primaryReviewers: [], subtaskReviewers: [] },
      scheduledTasks: {
        "task-file": {
          name: "File target",
          cron: "30 2 * * *",
          enabled: true,
          kind: "execute",
          instructions: "Work",
          workspace: "~/not-a-dir",
        },
      },
    });
    const before = await readFile(configPath, "utf8");
    try {
      await withSyntheticHome(fakeHome, () => registered.handler("", contextWithSelections([
        rootSettingsRow("Scheduled tasks", "1 of 1 enabled"),
        "Back",
        "Save changes",
      ])));
      assert.equal(await readFile(configPath, "utf8"), before, "a non-directory ~/ workspace must not change the config file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("the scheduler runtime row is a live process toggle and is never persisted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-scheduled-runtime-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
  }), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const registered = commandHarness();
  // Issue #26: the menu flips the real process-local holder through its setter
  // contract (no polling); reset first so the test owns the initial state.
  resetSchedulerRuntimeForTests();
  const runtime = getSchedulerRuntime();
  runtime.setEnabled(true);
  registerReviewSettings({ pi: registered.pi, config, configPath, schedulerRuntime: runtime });

  // Root shows the live toggle; selecting it flips the object in place.
  await registered.handler("", contextWithSelections([
    rootSettingsRow("Scheduler runtime", "On"),
    "Save changes",
  ]));
  assert.equal(runtime.enabled, false);
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  // The toggle is never written to the config file under any key.
  assert.equal(Object.keys(saved).some((key) => /scheduler/i.test(key)), false);

  // Without the injected seam the row is absent from the root menu.
  const plain = commandHarness();
  const optionsSeen: string[][] = [];
  const ctx = {
    scopedModels: [],
    ui: {
      async select(_title: string, options: string[]) {
        optionsSeen.push(options);
        return undefined;
      },
      async input() {
        return undefined;
      },
      async confirm() {
        return false;
      },
      notify() {},
    },
  };
  registerReviewSettings({ pi: plain.pi, config, configPath });
  await plain.handler("", ctx);
  assert.equal(optionsSeen[0]!.some((option) => option.startsWith("Scheduler runtime")), false);
  resetSchedulerRuntimeForTests();
  await rm(dir, { recursive: true, force: true });
});