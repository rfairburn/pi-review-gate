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
import { TOOLS_ONLY_LABEL, WORKSPACE_CHANGES_LABEL } from "../src/review-evidence";

const REVIEW_SETTING_LABELS = [
  "Automatic primary review (Pi)",
  "Automatic primary review (Claude Code)",
  "Automatic primary review (Codex)",
  "Automatic subtask review",
  "Review landed changes",
  "Primary reviewers",
  "Subtask reviewers",
] as const;

function reviewSettingsRow(label: typeof REVIEW_SETTING_LABELS[number], value: string): string {
  const group = label.startsWith("Automatic primary review (")
    ? REVIEW_SETTING_LABELS.slice(0, 3)
    : REVIEW_SETTING_LABELS.slice(3);
  return alignedTestRow(label, value, group);
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
  /** `lists` is how many selector lists had been shown when the notice arrived. */
  notes: Array<{ message: string; type?: string; lists: number }>;
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
      const notes: MenuRunResult["notes"] = [];
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
            notes.push({ message, type: type ?? "info", lists: lists.length });
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
    primaryClaudeCodeEnabled: false,
    primaryCodexEnabled: false,
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
  // The hosted native provider toggles default off and are independent of the
  // Pi toggle (issue #736).
  assert.equal(settings.primaryClaudeCodeEnabled, false);
  assert.equal(settings.primaryCodexEnabled, false);
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
      primaryClaudeCodeEnabled: true,
      primaryCodexEnabled: false,
      reviewLandedChanges: true,
    },
  });

  const settings = effectiveReviewSettings(config);
  assert.deepEqual(settings.primaryReviewers, [LEGACY_ONE]);
  assert.deepEqual(settings.subtaskReviewers, []);
  assert.equal(settings.primaryEnabled, false);
  assert.equal(settings.subtaskEnabled, true);
  assert.equal(settings.primaryClaudeCodeEnabled, true);
  assert.equal(settings.primaryCodexEnabled, false);
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
  assert.throws(() => normalizeConfig({ review: { primaryClaudeCodeEnabled: "yes" } }), /review\.primaryClaudeCodeEnabled must be a boolean/);
  assert.throws(() => normalizeConfig({ review: { primaryClaudeCodeEnabled: null } }), /review\.primaryClaudeCodeEnabled must be a boolean/);
  assert.throws(() => normalizeConfig({ review: { primaryCodexEnabled: 1 } }), /review\.primaryCodexEnabled must be a boolean/);
  assert.throws(() => normalizeConfig({ review: { reviewLandedChanges: null } }), /review\.reviewLandedChanges must be a boolean/);
  assert.throws(() => normalizeConfig({ review: { primaryReviewers: "nope" } }), /review\.primaryReviewers must be an array/);
  assert.throws(() => normalizeConfig({ review: { subtaskReviewers: [{ source: "external" }] } }), /external reviewer selection requires id/);

  const recovered = recoverConfig({
    review: {
      primaryReviewers: [LEGACY_ONE, { source: "external" }],
      subtaskReviewers: "nope",
      primaryClaudeCodeEnabled: "yes",
      reviewLandedChanges: "yes",
    },
  });
  assert.deepEqual(recovered.config.review?.primaryReviewers, [LEGACY_ONE]);
  assert.equal(recovered.config.review?.subtaskReviewers, undefined);
  assert.ok(recovered.warnings!.some((w) => w.includes("review.subtaskReviewers")));
  assert.ok(recovered.warnings!.some((w) => w.includes("review.primaryClaudeCodeEnabled")));
  assert.ok(recovered.warnings!.some((w) => w.includes("review.reviewLandedChanges")));

  // A valid split record survives recovery untouched.
  const intact = recoverConfig({
    review: { primaryReviewers: [LEGACY_ONE], primaryEnabled: false, primaryClaudeCodeEnabled: true, primaryCodexEnabled: true, reviewLandedChanges: true },
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

  // Reopening after the session-only apply re-derives the same imported
  // state from the unchanged file; toggling a layer and escaping at the root
  // applies it to the live config only (issue #294) — still no disk write.
  const before = await readFile(configPath, "utf8");
  await registered.run([
    rootReviewersRow("primary 1/1 selected · auto · subtask 1/1 selected · auto"),
    reviewSettingsRow("Automatic subtask review", "On"),
    "Back",
    undefined,
  ]);
  assert.equal(await readFile(configPath, "utf8"), before);
  assert.equal(effectiveReviewSettings(config).subtaskEnabled, false);
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
    reviewSettingsRow("Automatic primary review (Pi)", "On"),
    reviewSettingsRow("Automatic subtask review", "On"),
    "Back",
    "Save changes",
  ]);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.review.primaryEnabled, false);
  assert.equal(saved.review.subtaskEnabled, false);
  // The native provider toggles were never touched: they save as their
  // defaults (off), independently of the Pi toggle.
  assert.equal(saved.review.primaryClaudeCodeEnabled, false);
  assert.equal(saved.review.primaryCodexEnabled, false);
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

test("reviewing landed changes is inactive while Pi automatic primary review is off", async () => {
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
  assert.ok(runNotes(run).some((note) => note.message.includes("inactive while Pi automatic primary review is off")));
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

test("the three per-provider automatic primary review rows toggle independently", async () => {
  const { configPath, config, original } = await splitWorkspace("per-provider", {
    enabled: true,
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
    review: { primaryReviewers: [LEGACY_ONE], subtaskReviewers: [LEGACY_ONE] },
  });
  const registered = menuHarness(config, configPath);

  // Every provider row is drawn with the same label shape, and the native rows
  // start at their off default while the Pi row starts on (issue #736).
  const opened = await registered.run([
    rootReviewersRow("primary 1/1 selected · auto · subtask 1/1 selected · auto"),
    "Back",
    undefined,
  ]);
  assert.deepEqual(opened.lists[1]!.slice(0, 3), [
    reviewSettingsRow("Automatic primary review (Pi)", "On"),
    reviewSettingsRow("Automatic primary review (Claude Code)", "Off"),
    reviewSettingsRow("Automatic primary review (Codex)", "Off"),
  ]);
  assert.equal(await readFile(configPath, "utf8"), original);

  // Pi off + Claude Code on + Codex on: each Enter toggles only its own row.
  await registered.run([
    rootReviewersRow("primary 1/1 selected · auto · subtask 1/1 selected · auto"),
    reviewSettingsRow("Automatic primary review (Pi)", "On"),
    reviewSettingsRow("Automatic primary review (Claude Code)", "Off"),
    reviewSettingsRow("Automatic primary review (Codex)", "Off"),
    "Back",
    "Save changes",
  ]);
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.review.primaryEnabled, false);
  assert.equal(saved.review.primaryClaudeCodeEnabled, true);
  assert.equal(saved.review.primaryCodexEnabled, true);

  // The saved combination reloads unchanged: the native toggles never follow
  // the Pi toggle.
  const settings = effectiveReviewSettings(normalizeConfig(saved));
  assert.equal(settings.primaryEnabled, false);
  assert.equal(settings.primaryClaudeCodeEnabled, true);
  assert.equal(settings.primaryCodexEnabled, true);
  assert.equal(settings.reviewLandedChanges, false);

  // Turning a native row on does not unlock the landed row: with Pi off it is
  // still refused, and toggling a native row changes only that row.
  const nativeOn = await splitWorkspace("per-provider-landed", {
    enabled: true,
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
    review: {
      primaryReviewers: [LEGACY_ONE],
      subtaskReviewers: [LEGACY_ONE],
      primaryEnabled: false,
      primaryClaudeCodeEnabled: true,
      primaryCodexEnabled: true,
    },
  });
  const nativeRun = await menuHarness(nativeOn.config, nativeOn.configPath).run([
    rootReviewersRow("primary off · subtask 1/1 selected · auto"),
    reviewSettingsRow("Automatic primary review (Claude Code)", "On"),
    reviewSettingsRow("Review landed changes", "Off"),
    "Back",
    undefined,
  ]);
  assert.ok(nativeRun.lists[1]!.some((row) => row === reviewSettingsRow("Review landed changes", "Off")));
  assert.ok(runNotes(nativeRun).some((note) => note.message.includes("inactive while Pi automatic primary review is off")));
  assert.equal(effectiveReviewSettings(nativeOn.config).reviewLandedChanges, false);
  assert.equal(effectiveReviewSettings(nativeOn.config).primaryClaudeCodeEnabled, false);
  assert.equal(effectiveReviewSettings(nativeOn.config).primaryCodexEnabled, true);
});

test("persistReviewSettings writes split fields, removes the legacy key, and preserves unrelated keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-split-persist-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    enabled: true,
    futureKey: { keep: true },
    externalAgents: {
      one: { adapter: "generic-cli", command: process.execPath, args: [], review: {} },
    },
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
    primaryClaudeCodeEnabled: true,
    primaryCodexEnabled: false,
    reviewLandedChanges: true,
  }));
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(saved.review, {
    primaryReviewers: [LEGACY_ONE],
    subtaskReviewers: [LEGACY_ONE],
    primaryEnabled: false,
    subtaskEnabled: false,
    primaryClaudeCodeEnabled: true,
    primaryCodexEnabled: false,
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

// Issue #653: the sidebar's single-notice section help is host-only. In Pi the
// Review and Evidence methods sections keep their exact full description as
// one ordinary info notice on each entry, before the section's first list.
const NATIVE_REVIEW_HELP = "Automatic primary review is one toggle per provider: Automatic primary review (Pi) covers the primary assistant's own changes (one policy shared by Execute and Orchestrate), while Automatic primary review (Claude Code) and Automatic primary review (Codex) turn on automatic review of a hosted native Claude Code or Codex sidebar row's own top-level changes with the primary reviewer set. The three are independent, the two native ones default Off, and each needs the master Review switch On: a native row's hooks are armed when it launches, while switching a provider Off stops review on a running row from its next hook. In a narrow pane these three rows display as Primary (Pi), Primary (Claude Code), and Primary (Codex): the same rows with the same states. Automatic subtask review covers subtask results before ordinary accepted landing. The toggles control automatic review only — /review-now and /ask-reviewer stay available while reviewers remain selected, and a saved Off stops automatic review for that layer once saved. Reviewing landed changes adds only unreviewed subtask landings to the primary review window instead of checkpointing them out; a subtask landing that passed its own review keeps today's checkpoint/bypass and is not redundantly re-reviewed by the primary review. It is inactive while Pi automatic primary review is off. Review timing stays model idle — the landed toggle governs inclusion in the review window, never instant review. Each layer has its own reviewer set from the same reviewer catalog.";
const NATIVE_EVIDENCE_HELP = `Evidence methods only — the three scope choices do not disable review, change operating mode, or select reviewers. Each scope is independent. ${WORKSPACE_CHANGES_LABEL} adds whole-workspace snapshot/diff review evidence; ${TOOLS_ONLY_LABEL} omits that whole-workspace evidence. Both retain bounded tool calls/results, observed file content and per-file tool-observation diffs, task/assistant context, and reviewer read access. Mandatory construction, checkpoint, and landing verification is unchanged. Enter cycles the method. Snapshot-failure fallback defaults On and uses ${TOOLS_ONLY_LABEL} when an eligible snapshot capture fails; Off warns that review is disabled for an eligible Primary baseline failure and blocks other failures. Navigation only stages choices; root Escape applies for the session, Save/Ctrl+S persists, and Cancel discards.`;

test("native /review-settings keeps the exact full Review and Evidence help as one notice per entry", async () => {
  const { configPath, config, original } = await splitWorkspace("native-help", { enabled: true });
  const registered = menuHarness(config, configPath);
  const run = await registered.run([
    rootReviewersRow("primary 0/0 selected · auto off (no reviewers) · subtask 0/0 selected · auto off (no reviewers)"),
    "Evidence methods",
    "Back",
    "Back",
    rootReviewersRow("primary 0/0 selected · auto off (no reviewers) · subtask 0/0 selected · auto off (no reviewers)"),
    "Back",
    undefined,
  ]);
  assert.equal(await readFile(configPath, "utf8"), original);
  const help = run.notes.filter((note) => note.message === NATIVE_REVIEW_HELP || note.message === NATIVE_EVIDENCE_HELP);
  // Lists: 0 root, 1 Review, 2 Evidence, 3 Review, 4 root, 5 Review, 6 root.
  assert.deepEqual(help, [
    { message: NATIVE_REVIEW_HELP, type: "info", lists: 1 },
    { message: NATIVE_EVIDENCE_HELP, type: "info", lists: 2 },
    { message: NATIVE_REVIEW_HELP, type: "info", lists: 5 },
  ], JSON.stringify(run.notes));
  assert.ok(!run.notes.some((note) => note.message.includes("docs/settings.md")), "no sidebar summary reaches Pi");
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
  "External workers",
  "Execution priority",
  "Research priority",
  "Reviewers",
  "Timeouts",
  "Review policy",
  "Retention",
  "Global concurrency",
  "Retry policy",
  "Subtasks",
  "Tools",
  "Scheduled tasks",
] as const;