/**
 * Issue #175: the review settings split — legacy `review.activeReviewers`
 * import, the /review-settings Review submenu, persistence of the split
 * fields, and the shared `effectiveReviewSettings` accessor consumed by
 * runtime review gating.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  automaticReviewEnabled,
  effectiveReviewSettings,
  frozenReviewerSelection,
  materializeReviewConfig,
  normalizeConfig,
  recoverConfig,
  resolveReviewers,
  type ReviewGateConfig,
} from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { persistReviewSettings, type ReviewSettingsSelection } from "../src/settings/persistence";

const REVIEW_SETTING_LABELS = [
  "Automatic primary review",
  "Automatic subtask review",
  "Review landed changes",
  "Primary reviewers",
  "Subtask reviewers",
] as const;

function reviewSettingsRow(label: typeof REVIEW_SETTING_LABELS[number], value: string): string {
  return alignedTestRow(label, value, REVIEW_SETTING_LABELS);
}

function alignedTestRow(label: string, value: string, labels: readonly string[]): string {
  const width = Math.max(...labels.map((candidate) => candidate.length));
  return `${label.padEnd(width)}  ${value}`;
}

const LEGACY_ONE = { source: "external", id: "one" } as const;
const LEGACY_TWO = { source: "external", id: "two" } as const;

async function splitWorkspace(name: string, json: Record<string, unknown>): Promise<{ configPath: string; config: ReviewGateConfig; original: string }> {
  const dir = await mkdtemp(join(tmpdir(), `pi-review-split-${name}-`));
  const configPath = join(dir, "review-gate.json");
  const original = JSON.stringify(json);
  await writeFile(configPath, original, "utf8");
  const config = normalizeConfig(JSON.parse(original));
  return { configPath, config, original };
}

interface MenuRunResult {
  lists: string[][];
  notes: Array<{ message: string; type?: string }>;
}

function menuHarness(config: ReviewGateConfig, configPath: string): {
  run: (selections: Array<string | undefined>) => Promise<MenuRunResult>;
} {
  let handler: ((args: string, ctx: unknown) => unknown) | undefined;
  const registered = {
    pi: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }): void {
        if (name === "review-settings") handler = options.handler;
      },
    },
  };
  registerReviewSettings({ pi: registered.pi, config, configPath });
  return {
    async run(selections) {
      let index = 0;
      const lists: string[][] = [];
      const notes: Array<{ message: string; type?: string }> = [];
      assert.ok(handler);
      await handler("", {
        scopedModels: [],
        ui: {
          async select(_title: string, options: string[]) {
            lists.push(options);
            const value = selections[index++];
            if (value !== undefined) assert.ok(options.includes(value), `missing selection ${value}: ${options.join(" | ")}`);
            return value;
          },
          async input() {
            return undefined;
          },
          notify(message: string, type?: string) {
            notes.push({ message, type: type ?? "info" });
          },
        },
      });
      return { lists, notes };
    },
  };
}

function baseSelection(overrides: Partial<ReviewSettingsSelection> = {}): ReviewSettingsSelection {
  return {
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
    maxWorkers: 2,
    retryPolicy: {
      maxRetries: 2,
      baseDelayMs: 1_000,
      maxDelayMs: 15_000,
      jitter: true,
      maxSameIncidentRepeats: 2,
    },
    subtaskNotifications: "quiet",
    subtasksViewExpanded: false,
    ...overrides,
  };
}

test("legacy activeReviewers import is effective in memory for both sets without rewriting the file", async () => {
  const { configPath, config, original } = await splitWorkspace("import", {
    enabled: true,
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
    review: { activeReviewers: [LEGACY_ONE] },
  });

  const settings = effectiveReviewSettings(config);
  assert.deepEqual(settings.primaryReviewers, [LEGACY_ONE]);
  assert.deepEqual(settings.subtaskReviewers, [LEGACY_ONE]);
  assert.equal(settings.primaryEnabled, true);
  assert.equal(settings.subtaskEnabled, true);
  assert.equal(settings.reviewLandedChanges, false);
  // Returned arrays are fresh clones: mutating them never touches the config.
  const mutatedClone = effectiveReviewSettings(config).primaryReviewers;
  mutatedClone.push(LEGACY_TWO);
  assert.deepEqual(effectiveReviewSettings(config).primaryReviewers, [LEGACY_ONE]);

  // Both layers resolve the imported set; the default (omitted) layer is primary.
  assert.deepEqual(resolveReviewers(config, []).reviewers.map((r) => r.id), ["one"]);
  assert.deepEqual(resolveReviewers(config, [], "primary").reviewers.map((r) => r.id), ["one"]);
  assert.deepEqual(resolveReviewers(config, [], "subtask").reviewers.map((r) => r.id), ["one"]);
  assert.equal(automaticReviewEnabled(config, [], "primary"), true);
  assert.equal(automaticReviewEnabled(config, [], "subtask"), true);
  assert.equal(automaticReviewEnabled(config, []), true);

  // Loading never writes: the stored record still carries only the legacy key.
  assert.equal(await readFile(configPath, "utf8"), original);
});

test("a split configuration honors its saved choices and never re-imports legacy", async () => {
  const { config } = await splitWorkspace("split-honored", {
    enabled: true,
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
      two: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
    review: {
      activeReviewers: [LEGACY_TWO],
      primaryReviewers: [LEGACY_ONE],
      subtaskReviewers: [],
      primaryEnabled: false,
      subtaskEnabled: true,
      reviewLandedChanges: true,
    },
  });

  const settings = effectiveReviewSettings(config);
  assert.deepEqual(settings.primaryReviewers, [LEGACY_ONE]);
  assert.deepEqual(settings.subtaskReviewers, []);
  assert.equal(settings.primaryEnabled, false);
  assert.equal(settings.subtaskEnabled, true);
  assert.equal(settings.reviewLandedChanges, true);

  // Layer-aware resolution follows the stored sets, not the legacy copy.
  assert.deepEqual(resolveReviewers(config, [], "primary").reviewers.map((r) => r.id), ["one"]);
  assert.deepEqual(resolveReviewers(config, [], "subtask").reviewers, []);
  // The subtask layer has no reviewers and the legacy set is not re-imported,
  // so it resolves to off — automatic review is off for that layer, proving
  // no legacy re-import.
  assert.equal(automaticReviewEnabled(config, [], "subtask"), false);

  // The default (omitted) layer resolves the primary set and freezes it.
  const resolution = resolveReviewers(config, []);
  assert.deepEqual(frozenReviewerSelection(config, resolution).activeReviewers, [LEGACY_ONE]);
  assert.deepEqual(frozenReviewerSelection(config, resolution, "subtask").activeReviewers, []);
});

test("a doubled record consumes the split fields and ignores the legacy copy without a rewrite", async () => {
  const { configPath, config, original } = await splitWorkspace("doubled", {
    enabled: true,
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
      two: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
    review: {
      activeReviewers: [LEGACY_TWO],
      primaryReviewers: [LEGACY_ONE],
    },
  });
  const settings = effectiveReviewSettings(config);
  assert.deepEqual(settings.primaryReviewers, [LEGACY_ONE]);
  assert.deepEqual(settings.subtaskReviewers, []);
  assert.equal(await readFile(configPath, "utf8"), original);
});

test("malformed split fields fail strict validation and recover per-entry with warnings", () => {
  assert.throws(() => normalizeConfig({ review: { primaryEnabled: "yes" } }), /review\.primaryEnabled must be a boolean/);
  assert.throws(() => normalizeConfig({ review: { subtaskEnabled: 1 } }), /review\.subtaskEnabled must be a boolean/);
  assert.throws(() => normalizeConfig({ review: { reviewLandedChanges: null } }), /review\.reviewLandedChanges must be a boolean/);
  assert.throws(() => normalizeConfig({ review: { primaryReviewers: "nope" } }), /review\.primaryReviewers must be an array/);
  assert.throws(() => normalizeConfig({ review: { subtaskReviewers: [{ source: "external" }] } }), /external reviewer selection requires id/);

  const recovered = recoverConfig({
    review: {
      primaryReviewers: [LEGACY_ONE, { source: "external" }],
      subtaskReviewers: "nope",
      reviewLandedChanges: "yes",
    },
  });
  assert.deepEqual(recovered.config.review?.primaryReviewers, [LEGACY_ONE]);
  assert.equal(recovered.config.review?.subtaskReviewers, undefined);
  assert.ok(recovered.warnings!.some((w) => w.includes("review.subtaskReviewers")));
  assert.ok(recovered.warnings!.some((w) => w.includes("review.reviewLandedChanges")));

  // A valid split record survives recovery untouched.
  const intact = recoverConfig({
    review: { primaryReviewers: [LEGACY_ONE], primaryEnabled: false, reviewLandedChanges: true },
  });
  assert.deepEqual(intact.config.review?.primaryReviewers, [LEGACY_ONE]);
  assert.equal(intact.warnings?.length ?? 0, 0);
});

test("the Review submenu displays both imported sets immediately and Cancel keeps the file", async () => {
  const { configPath, config, original } = await splitWorkspace("menu-cancel", {
    enabled: true,
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
    review: { activeReviewers: [LEGACY_ONE] },
  });
  const registered = menuHarness(config, configPath);

  // Open the submenu and both pickers: both show the imported selection.
  const first = await registered.run([
    rootReviewersRow("primary 1/1 selected · auto · subtask 1/1 selected · auto"),
    reviewSettingsRow("Primary reviewers", "1/1 selected"),
    "Back",
    reviewSettingsRow("Subtask reviewers", "1/1 selected"),
    "Back",
    "Back",
    undefined,
  ]);
  assert.equal(await readFile(configPath, "utf8"), original);
  const submenu = first.lists[1]!;
  assert.ok(submenu.some((row) => row === reviewSettingsRow("Primary reviewers", "1/1 selected")));
  assert.ok(submenu.some((row) => row === reviewSettingsRow("Subtask reviewers", "1/1 selected")));
  const primaryPicker = first.lists[2]!;
  assert.ok(primaryPicker.some((row) => row.includes("one [generic-cli] ✓")));
  const subtaskPicker = first.lists[4]!;
  assert.ok(subtaskPicker.some((row) => row.includes("one [generic-cli] ✓")));
  assert.ok(first.notes.every((note) => note.type !== "error"));
  // The import is session-effective even after Cancel.
  assert.deepEqual(effectiveReviewSettings(config).primaryReviewers, [LEGACY_ONE]);
  assert.deepEqual(effectiveReviewSettings(config).subtaskReviewers, [LEGACY_ONE]);

  // Reopening after Cancel re-derives the same imported state from the
  // unchanged file; toggling a layer and cancelling still writes nothing.
  const before = await readFile(configPath, "utf8");
  await registered.run([
    rootReviewersRow("primary 1/1 selected · auto · subtask 1/1 selected · auto"),
    reviewSettingsRow("Automatic subtask review", "On"),
    "Back",
    undefined,
  ]);
  assert.equal(await readFile(configPath, "utf8"), before);
  assert.equal(effectiveReviewSettings(config).subtaskEnabled, true);
});

test("Save without edits persists the effective split fields and removes the legacy key", async () => {
  const { configPath, config } = await splitWorkspace("save-no-edit", {
    enabled: true,
    futureKey: { keep: true },
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
    review: { activeReviewers: [LEGACY_ONE] },
  });
  const registered = menuHarness(config, configPath);
  await registered.run([
    rootReviewersRow("primary 1/1 selected · auto · subtask 1/1 selected · auto"),
    "Back",
    "Save changes",
  ]);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.review.primaryReviewers, [LEGACY_ONE]);
  assert.deepEqual(saved.review.subtaskReviewers, [LEGACY_ONE]);
  assert.equal(saved.review.primaryEnabled, true);
  assert.equal(saved.review.subtaskEnabled, true);
  assert.equal(saved.review.reviewLandedChanges, false);
  assert.equal(saved.review.activeReviewers, undefined);
  assert.deepEqual(saved.futureKey, { keep: true });

  // The persisted split config is honored on reload: identical effective sets.
  const reloaded = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const settings = effectiveReviewSettings(reloaded);
  assert.deepEqual(settings.primaryReviewers, [LEGACY_ONE]);
  assert.deepEqual(settings.subtaskReviewers, [LEGACY_ONE]);
  assert.equal(automaticReviewEnabled(reloaded, [], "primary"), true);
  assert.equal(automaticReviewEnabled(reloaded, [], "subtask"), true);
});

test("manual edits win over the imported values and a reload keeps the split", async () => {
  const { configPath, config, original } = await splitWorkspace("manual-win", {
    enabled: true,
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
      two: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
    review: { activeReviewers: [LEGACY_ONE] },
  });
  const registered = menuHarness(config, configPath);
  await registered.run([
    rootReviewersRow("primary 1/2 selected · auto · subtask 1/2 selected · auto"),
    reviewSettingsRow("Subtask reviewers", "1/2 selected"),
    "one [generic-cli] ✓",
    "Back",
    "Back",
    "Save changes",
  ]);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  // The primary set keeps the imported value; the manually edited subtask set
  // wins; the legacy key is gone.
  assert.deepEqual(saved.review.primaryReviewers, [LEGACY_ONE]);
  assert.deepEqual(saved.review.subtaskReviewers, []);
  assert.equal(saved.review.activeReviewers, undefined);
  assert.notEqual(await readFile(configPath, "utf8"), original);

  // Reloading the split config keeps both sets exactly as saved: no legacy
  // re-import over the manual choice.
  const reloaded = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  assert.deepEqual(effectiveReviewSettings(reloaded).primaryReviewers, [LEGACY_ONE]);
  assert.deepEqual(effectiveReviewSettings(reloaded).subtaskReviewers, []);
});

test("both layers off save cleanly; reviewer sets stay available for manual commands", async () => {
  const { configPath, config } = await splitWorkspace("both-off", {
    enabled: true,
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
    review: { activeReviewers: [LEGACY_ONE] },
  });
  const registered = menuHarness(config, configPath);
  await registered.run([
    rootReviewersRow("primary 1/1 selected · auto · subtask 1/1 selected · auto"),
    reviewSettingsRow("Automatic primary review", "On"),
    reviewSettingsRow("Automatic subtask review", "On"),
    "Back",
    "Save changes",
  ]);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.review.primaryEnabled, false);
  assert.equal(saved.review.subtaskEnabled, false);
  assert.deepEqual(saved.review.primaryReviewers, [LEGACY_ONE]);
  assert.deepEqual(saved.review.subtaskReviewers, [LEGACY_ONE]);

  const reloaded = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  // Both toggles are stored off: with both layers off there is no automatic
  // review, and the selected reviewer sets remain available to manual
  // commands.
  assert.equal(effectiveReviewSettings(reloaded).primaryEnabled, false);
  assert.equal(effectiveReviewSettings(reloaded).subtaskEnabled, false);
  // The selected reviewer sets remain available to manual commands.
  assert.deepEqual(resolveReviewers(reloaded, [], "primary").reviewers.map((r) => r.id), ["one"]);
  assert.deepEqual(resolveReviewers(reloaded, [], "subtask").reviewers.map((r) => r.id), ["one"]);
});

test("saving automatic primary review Off keeps manual review commands usable", async () => {
  const { config } = await splitWorkspace("primary-off-manual", {
    enabled: true,
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
    review: { primaryReviewers: [LEGACY_ONE], subtaskReviewers: [LEGACY_ONE], primaryEnabled: false },
  });

  // Saving the layer Off stops automatic review for that layer; the selected
  // reviewers stay selected and resolvable, so human-invoked /review-now and
  // /ask-reviewer remain usable — the toggles control automatic review only.
  assert.equal(effectiveReviewSettings(config).primaryEnabled, false);
  assert.deepEqual(resolveReviewers(config, [], "primary").reviewers.map((r) => r.id), ["one"]);
  assert.deepEqual(resolveReviewers(config, [], "subtask").reviewers.map((r) => r.id), ["one"]);
});

test("reviewing landed changes is inactive while automatic primary review is off", async () => {
  const { configPath, config, original } = await splitWorkspace("landed-inactive", {
    enabled: true,
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
    review: { primaryReviewers: [LEGACY_ONE], subtaskReviewers: [LEGACY_ONE], primaryEnabled: false },
  });
  const registered = menuHarness(config, configPath);

  // The row displays the inactive state; attempting to toggle is refused and
  // stages nothing.
  const run = await registered.run([
    rootReviewersRow("primary off · subtask 1/1 selected · auto"),
    reviewSettingsRow("Review landed changes", "Off"),
    "Back",
    undefined,
  ]);
  assert.ok(runNotes(run).some((note) => note.message.includes("inactive while automatic primary review is off")));
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.equal(effectiveReviewSettings(config).reviewLandedChanges, false);

  // With automatic primary review on, the landed choice stages and saves.
  const enabled = await splitWorkspace("landed-on", {
    enabled: true,
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
    review: { primaryReviewers: [LEGACY_ONE], subtaskReviewers: [LEGACY_ONE] },
  });
  const enabledHarness = menuHarness(enabled.config, enabled.configPath);
  await enabledHarness.run([
    rootReviewersRow("primary 1/1 selected · auto · subtask 1/1 selected · auto"),
    reviewSettingsRow("Review landed changes", "Off"),
    "Back",
    "Save changes",
  ]);
  const saved = JSON.parse(await readFile(enabled.configPath, "utf8"));
  assert.equal(saved.review.reviewLandedChanges, true);
  assert.equal(saved.review.primaryEnabled, true);
  assert.equal(saved.review.subtaskEnabled, true);
  assert.deepEqual(saved.review.primaryReviewers, [LEGACY_ONE]);
});

test("persistReviewSettings writes split fields, removes the legacy key, and preserves unrelated keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-split-persist-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    futureKey: { keep: true },
    review: { activeReviewers: [LEGACY_ONE], primaryEnabled: false },
  }));
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const settings = effectiveReviewSettings(config);
  // Save with the effective imported sets, both layers off: a valid both-off
  // configuration with the landed choice explicitly on.
  await persistReviewSettings(configPath, baseSelection({
    primaryReviewers: settings.primaryReviewers,
    subtaskReviewers: settings.subtaskReviewers,
    primaryEnabled: false,
    subtaskEnabled: false,
    reviewLandedChanges: true,
  }));
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.review, {
    primaryReviewers: [LEGACY_ONE],
    subtaskReviewers: [LEGACY_ONE],
    primaryEnabled: false,
    subtaskEnabled: false,
    reviewLandedChanges: true,
  });
  assert.deepEqual(saved.futureKey, { keep: true });
});

test("materializeReviewConfig keeps freezing the primary layer for live configs", async () => {
  const { config } = await splitWorkspace("materialize", {
    enabled: true,
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
    review: {
      primaryReviewers: [LEGACY_ONE],
      subtaskReviewers: [],
    },
  });
  const materialized = materializeReviewConfig(config, []);
  // The frozen window form stays self-contained over the primary set.
  assert.deepEqual(materialized.review?.activeReviewers, [LEGACY_ONE]);
  assert.equal(automaticReviewEnabled(materialized), true);
  assert.deepEqual(resolveReviewers(materialized, []).reviewers.map((r) => r.id), ["one"]);
});

function runNotes(run: MenuRunResult): MenuRunResult["notes"] {
  return run.notes;
}

function rootReviewersRow(value: string): string {
  return alignedTestRow("Reviewers", value, ROOT_SETTING_LABELS);
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
  "Web",
] as const;