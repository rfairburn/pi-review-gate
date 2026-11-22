/**
 * Issue #729: the existing canonical `waveArtifactTtlMs` age is exposed under
 * /review-settings → Retention and staged through the one existing settings
 * transaction.
 *
 * These tests pin the agreed behavior:
 * - the 30-day default and any pre-existing custom age display with clear
 *   units, and a reopened editor prefills the same duration in its parseable
 *   spelling (`6h`, `30d`, `2500ms`, `0`);
 * - a six-hour entry (`6h`) saves `waveArtifactTtlMs: 21600000` and nothing
 *   else, and reopening shows six hours again;
 * - Cancel and every invalid entry leave the staged and saved age unchanged, and
 *   an unrelated Save from a stale menu preserves a newer on-disk age while a
 *   session-only edit still carries through to a later Save;
 * - `0` stages the documented disabled state;
 * - Bundle retention **Always** is explained in the section's notice surface (Pi
 *   info notice and the sidebar's single-notice summary) and the age is kept
 *   untouched, verified at a narrow sidebar pane width;
 * - root Escape applies the age for the session without writing the file, and
 *   the sidebar's disk-only transaction shares the same row, Save, and
 *   discard exits.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, normalizeConfig, type ReviewGateConfig } from "../src/config";
import { registerReviewSettings, runPersistedReviewSettings } from "../src/settings/command";
import type { UiContext } from "../src/settings/ui";
import { formatWaveArtifactAge, parseWaveArtifactAge, waveArtifactAgeInput, waveArtifactAgeSummary } from "../src/settings/controls";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const WAVE_AGE_FIELD_TITLE = "Wave artifact cleanup age in milliseconds or with a unit suffix (6h, 45m, 30d; 0 disables age-based cleanup)";

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

const RETENTION_SUBMENU_LABELS = ["Bundle retention", "Wave artifact cleanup age", "Spawned Pi sessions"] as const;

function rootRow(label: (typeof ROOT_SETTING_LABELS)[number], value: string): string {
  return alignedRow(label, value, ROOT_SETTING_LABELS);
}

function retentionRow(label: (typeof RETENTION_SUBMENU_LABELS)[number], value: string): string {
  return alignedRow(label, value, RETENTION_SUBMENU_LABELS);
}

function alignedRow(label: string, value: string, labels: readonly string[]): string {
  const width = Math.max(...labels.map((candidate) => candidate.length));
  return `${label.padEnd(width)}  ${value}`;
}

/** Everything one menu run showed: menu options, text-field edits, notices. */
interface Recorded {
  menus: Array<{ title: string; options: string[] }>;
  fieldEdits: Array<{ title: string; placeholder?: string }>;
  notices: Array<{ message: string; type?: string }>;
  /** Summaries a single-notice host's section-help port received, in order. */
  sectionSummaries: string[];
}

/** Assert that some menu this run rendered showed `row` as one of its rows. */
function assertShows(recorded: Recorded, row: string): void {
  assert.ok(
    recorded.menus.some((menu) => menu.options.includes(row)),
    `no menu showed ${JSON.stringify(row)}: ${recorded.menus.map((menu) => menu.options.join(" | ")).join(" /// ")}`,
  );
}

async function writeConfig(contents: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-wave-retention-"));
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify(contents), "utf8");
  return configPath;
}

/**
 * Registers /review-settings against `config`/`configPath` and drives it with
 * scripted menu selections and scripted text-field entries. Every scripted
 * selection must actually be offered, so a row that renders differently fails
 * the run instead of silently selecting nothing.
 */
async function run(
  config: ReviewGateConfig,
  configPath: string,
  selections: Array<string | undefined>,
  entries: Array<string | undefined> = [],
  options: { withSectionHelp?: boolean } = {},
): Promise<Recorded> {
  let commandHandler: ((args: string, ctx: unknown) => unknown) | undefined;
  registerReviewSettings({
    pi: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }): void {
        if (name === "review-settings") commandHandler = options.handler;
      },
    },
    config,
    configPath,
  });
  assert.ok(commandHandler, "review-settings command was not registered");
  const recorded: Recorded = { menus: [], fieldEdits: [], notices: [], sectionSummaries: [] };
  await commandHandler!("", { scopedModels: [], ui: makeUi(selections, entries, recorded, options) });
  return recorded;
}

/** The scripted UI shared by the session and disk-only menu drivers. */
function makeUi(
  selections: Array<string | undefined>,
  entries: Array<string | undefined>,
  recorded: Recorded,
  options: { withSectionHelp?: boolean } = {},
): UiContext & { notify(message: string, type?: string): void } {
  let selectIndex = 0;
  let entryIndex = 0;
  return {
    async select(title: string, optionsList: string[]) {
      recorded.menus.push({ title, options: optionsList });
      const value = selections[selectIndex++];
      if (value !== undefined) {
        assert.ok(optionsList.includes(value), `missing selection ${JSON.stringify(value)} for "${title}": ${optionsList.join(" | ")}`);
      }
      return value;
    },
    async input(title: string, placeholder?: string) {
      recorded.fieldEdits.push({ title, placeholder });
      return entries[entryIndex++];
    },
    notify(message: string, type?: string) {
      recorded.notices.push({ message, type });
    },
    // The single-notice host shape (the sidebar): the section summary replaces
    // the Pi host's full info notice, and the host wraps or opens it whole.
    ...(options.withSectionHelp
      ? {
        settingsSectionHelp: {
          async section<T>(summary: string, runSection: () => Promise<T>): Promise<T> {
            recorded.sectionSummaries.push(summary);
            return await runSection();
          },
        },
      }
      : {}),
  };
}

/**
 * The sidebar's disk-only transaction over the same menu (issue #653): root
 * Escape discards there, so the wave age exits are Save and Cancel only.
 */
async function runDiskOnly(
  config: ReviewGateConfig,
  configPath: string,
  selections: Array<string | undefined>,
  entries: Array<string | undefined> = [],
): Promise<Recorded> {
  const recorded: Recorded = { menus: [], fieldEdits: [], notices: [], sectionSummaries: [] };
  await runPersistedReviewSettings({
    config,
    configPath,
    ui: makeUi(selections, entries, recorded),
    scoped: [],
  });
  return recorded;
}

test("Retention shows the 30-day default, and a six-hour edit saves the exact canonical field", async () => {
  const configPath = await writeConfig({ enabled: true, review: { activeReviewers: [] } });
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  assert.equal(config.waveArtifactTtlMs, DEFAULT_CONFIG.waveArtifactTtlMs);
  assert.equal(DEFAULT_CONFIG.waveArtifactTtlMs, 30 * 24 * 60 * 60 * 1000);

  // Opening the submenu shows the default age without touching anything.
  const opened = await run(config, configPath, [
    rootRow("Retention", "On failure"),
    "Back",
    "Cancel",
  ]);
  assertShows(opened, retentionRow("Wave artifact cleanup age", "30 days"));
  assert.equal(opened.fieldEdits.length, 0, "the row alone opens no editor");

  // Six hours is entered as a duration and stored as the canonical field value.
  await run(config, configPath, [
    rootRow("Retention", "On failure"),
    retentionRow("Wave artifact cleanup age", "30 days"),
    "Back",
    "Save changes",
  ], ["6h"]);

  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.waveArtifactTtlMs, SIX_HOURS_MS);
  assert.equal(config.waveArtifactTtlMs, SIX_HOURS_MS);
  // Nothing else in Retention moved: only the one canonical field carries the age.
  assert.equal(saved.retainBundles, "on-failure");
});

test("reopening shows the six-hour age in the row and prefills the same duration in the editor", async () => {
  const configPath = await writeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    waveArtifactTtlMs: SIX_HOURS_MS,
  });
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const reopened = await run(config, configPath, [
    rootRow("Retention", "On failure"),
    retentionRow("Wave artifact cleanup age", "6h"),
    "Back",
    "Cancel",
  ], [undefined]);
  // The reopened field offers the same six-hour duration the row shows, in its
  // parseable spelling — not a bare number.
  assert.deepEqual(reopened.fieldEdits, [{ title: WAVE_AGE_FIELD_TITLE, placeholder: "6h" }]);
  // Cancelling the field and the menu changed nothing.
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).waveArtifactTtlMs, SIX_HOURS_MS);
  assert.equal(config.waveArtifactTtlMs, SIX_HOURS_MS);
});

test("pre-existing custom wave ages display with clear units", async () => {
  const cases: Array<[number, string]> = [
    [30 * 24 * 60 * 60 * 1000, "30 days"],
    [24 * 60 * 60 * 1000, "1 day"],
    [SIX_HOURS_MS, "6h"],
    [90 * 60 * 1000, "90m"],
    [500, "500ms"],
    [0, "0 · age-based cleanup disabled"],
  ];
  for (const [stored, displayed] of cases) {
    const configPath = await writeConfig({
      enabled: true,
      review: { activeReviewers: [] },
      waveArtifactTtlMs: stored,
    });
    const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
    const opened = await run(config, configPath, [
      rootRow("Retention", "On failure"),
      "Back",
      "Cancel",
    ]);
    assertShows(opened, retentionRow("Wave artifact cleanup age", displayed));
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).waveArtifactTtlMs, stored);
  }
});

test("cancelling the field or the menu leaves the saved wave age unchanged", async () => {
  const configPath = await writeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    waveArtifactTtlMs: SEVEN_DAYS_MS,
  });
  const original = await readFile(configPath, "utf8");

  // Cancel inside the field: the staged age stays at the stored value, and a
  // later Save in the same transaction persists that unchanged value.
  const config = normalizeConfig(JSON.parse(original));
  await run(config, configPath, [
    rootRow("Retention", "On failure"),
    retentionRow("Wave artifact cleanup age", "7 days"),
    "Back",
    "Save changes",
  ], [undefined]);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).waveArtifactTtlMs, SEVEN_DAYS_MS);
  assert.equal(config.waveArtifactTtlMs, SEVEN_DAYS_MS);

  // Cancel at the root discards a staged six-hour edit entirely.
  const cancelPath = await writeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    waveArtifactTtlMs: SEVEN_DAYS_MS,
  });
  const cancelOriginal = await readFile(cancelPath, "utf8");
  const discarded = normalizeConfig(JSON.parse(cancelOriginal));
  await run(discarded, cancelPath, [
    rootRow("Retention", "On failure"),
    retentionRow("Wave artifact cleanup age", "7 days"),
    "Back",
    "Cancel",
  ], ["6h"]);
  assert.equal(await readFile(cancelPath, "utf8"), cancelOriginal, "Cancel must not write the settings file");
  assert.equal(discarded.waveArtifactTtlMs, SEVEN_DAYS_MS);
});

test("invalid wave age entries are rejected without changing the staged age", async () => {
  const configPath = await writeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    waveArtifactTtlMs: SEVEN_DAYS_MS,
  });
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const invalid = ["", "   ", "abc", "-1", "1.5", "10x", "days", "99999999999999999999", "99999999999d"];
  // Like the other numeric settings fields, a rejected entry re-shows the
  // submenu, so the row is selected once per rejected entry plus the cancel.
  const recorded = await run(config, configPath, [
    rootRow("Retention", "On failure"),
    ...Array.from({ length: invalid.length + 1 }, () => retentionRow("Wave artifact cleanup age", "7 days")),
    "Back",
    "Save changes",
  ], [...invalid, undefined]);

  assert.equal(recorded.fieldEdits.length, invalid.length + 1, "every invalid entry re-prompts the same field");
  const errors = recorded.notices.filter((notice) => notice.type === "error");
  assert.equal(errors.length, invalid.length);
  assert.match(errors[0]!.message, /whole number of milliseconds/);
  // The staged age never moved, so the save wrote the stored value back.
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).waveArtifactTtlMs, SEVEN_DAYS_MS);
  assert.equal(config.waveArtifactTtlMs, SEVEN_DAYS_MS);
});

test("zero stages the documented disabled state for age-based wave cleanup", async () => {
  const configPath = await writeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    waveArtifactTtlMs: SEVEN_DAYS_MS,
  });
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  await run(config, configPath, [
    rootRow("Retention", "On failure"),
    retentionRow("Wave artifact cleanup age", "7 days"),
    retentionRow("Wave artifact cleanup age", "0 · age-based cleanup disabled"),
    "Back",
    "Save changes",
  ], ["0"]);

  assert.equal(JSON.parse(await readFile(configPath, "utf8")).waveArtifactTtlMs, 0);
  assert.equal(config.waveArtifactTtlMs, 0);
});

test("Bundle retention Always explains the suppression and preserves the configured age", async () => {
  const configPath = await writeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    retainBundles: "on-failure",
    waveArtifactTtlMs: SIX_HOURS_MS,
  });
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const recorded = await run(config, configPath, [
    rootRow("Retention", "On failure"),
    retentionRow("Bundle retention", "On failure"),
    "Always",
    "Back",
    "Save changes",
  ]);

  // The staged age is unchanged, and the row states the precedence.
  assertShows(recorded, retentionRow("Wave artifact cleanup age", "6h · suppressed while Bundle retention is Always"));
  assert.equal(recorded.fieldEdits.length, 0, "the suppression note opens no extra field");
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.retainBundles, "always");
  assert.equal(saved.waveArtifactTtlMs, SIX_HOURS_MS, "Always must not rewrite the configured age");
  assert.equal(config.waveArtifactTtlMs, SIX_HOURS_MS);
});

test("root Escape applies a wave age edit for the session without writing the file", async () => {
  const configPath = await writeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    waveArtifactTtlMs: SEVEN_DAYS_MS,
  });
  const original = await readFile(configPath, "utf8");
  const config = normalizeConfig(JSON.parse(original));
  await run(config, configPath, [
    rootRow("Retention", "On failure"),
    retentionRow("Wave artifact cleanup age", "7 days"),
    "Back",
    undefined,
  ], ["12h"]);

  assert.equal(await readFile(configPath, "utf8"), original, "root Escape must not write the settings file");
  assert.equal(config.waveArtifactTtlMs, 12 * 60 * 60 * 1000);
});

test("an unrelated Save preserves a newer on-disk wave age; an intentional edit still persists", async () => {
  // A Pi session opened while the age was seven days.
  const stalePath = await writeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    waveArtifactTtlMs: SEVEN_DAYS_MS,
  });
  const stale = normalizeConfig(JSON.parse(await readFile(stalePath, "utf8")));
  // The sidebar writes 0 while that menu's config is stale.
  const newer = JSON.parse(await readFile(stalePath, "utf8"));
  newer.waveArtifactTtlMs = 0;
  await writeFile(stalePath, JSON.stringify(newer), "utf8");

  // Opening the age field and cancelling it is not an edit: the Save keeps 0.
  await run(stale, stalePath, [
    rootRow("Retention", "On failure"),
    retentionRow("Wave artifact cleanup age", "7 days"),
    "Back",
    "Save changes",
  ], [undefined]);
  assert.equal(JSON.parse(await readFile(stalePath, "utf8")).waveArtifactTtlMs, 0, "a stale Save must not re-enable age-based collection");

  // Changing only Bundle retention keeps the newer age too.
  const retentionOnlyPath = await writeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    waveArtifactTtlMs: SEVEN_DAYS_MS,
  });
  const retentionOnly = normalizeConfig(JSON.parse(await readFile(retentionOnlyPath, "utf8")));
  const newerOnDisk = JSON.parse(await readFile(retentionOnlyPath, "utf8"));
  newerOnDisk.waveArtifactTtlMs = 0;
  await writeFile(retentionOnlyPath, JSON.stringify(newerOnDisk), "utf8");
  await run(retentionOnly, retentionOnlyPath, [
    rootRow("Retention", "On failure"),
    retentionRow("Bundle retention", "On failure"),
    "Always",
    "Back",
    "Save changes",
  ]);
  const untouched = JSON.parse(await readFile(retentionOnlyPath, "utf8"));
  assert.equal(untouched.retainBundles, "always");
  assert.equal(untouched.waveArtifactTtlMs, 0, "changing Bundle retention must not overwrite the newer age");

  // An accepted age entry from a stale menu does persist.
  const editPath = await writeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    waveArtifactTtlMs: SEVEN_DAYS_MS,
  });
  const edited = normalizeConfig(JSON.parse(await readFile(editPath, "utf8")));
  const editedDisk = JSON.parse(await readFile(editPath, "utf8"));
  editedDisk.waveArtifactTtlMs = 0;
  await writeFile(editPath, JSON.stringify(editedDisk), "utf8");
  await run(edited, editPath, [
    rootRow("Retention", "On failure"),
    retentionRow("Wave artifact cleanup age", "7 days"),
    "Back",
    "Save changes",
  ], ["6h"]);
  assert.equal(JSON.parse(await readFile(editPath, "utf8")).waveArtifactTtlMs, SIX_HOURS_MS);
});

test("a session-only wave age edit carries through to a later Save", async () => {
  const configPath = await writeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    waveArtifactTtlMs: SEVEN_DAYS_MS,
  });
  const original = await readFile(configPath, "utf8");
  const config = normalizeConfig(JSON.parse(original));

  // Root Escape applies six hours for the session only.
  await run(config, configPath, [
    rootRow("Retention", "On failure"),
    retentionRow("Wave artifact cleanup age", "7 days"),
    "Back",
    undefined,
  ], ["6h"]);
  assert.equal(await readFile(configPath, "utf8"), original, "the apply itself writes nothing");
  assert.equal(config.waveArtifactTtlMs, SIX_HOURS_MS);

  // Reopened, the applied age shows — and an unrelated Save now persists it.
  await run(config, configPath, [
    rootRow("Retention", "On failure"),
    retentionRow("Wave artifact cleanup age", "6h"),
    "Back",
    "Save changes",
  ]);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).waveArtifactTtlMs, SIX_HOURS_MS);
});

test("the Retention help explains the Always suppression through the notice surface", async () => {
  const writeHelpConfig = async (): Promise<string> => writeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    retainBundles: "always",
    waveArtifactTtlMs: SIX_HOURS_MS,
  });

  // A Pi host gets the full explanation as one info notice when the section opens.
  const piPath = await writeHelpConfig();
  const piConfig = normalizeConfig(JSON.parse(await readFile(piPath, "utf8")));
  const pi = await run(piConfig, piPath, [rootRow("Retention", "Always"), "Back", "Cancel"]);
  const full = pi.notices.filter((notice) => notice.type === "info").map((notice) => notice.message).find((message) => message.includes("Retention has three independent controls"));
  assert.ok(full, `no Retention help notice among: ${pi.notices.map((notice) => notice.message).join(" | ")}`);
  assert.match(full!, /Bundle retention is always, age-based wave collection stays suppressed whatever this threshold says/);
  assert.match(full!, /the configured age is kept/);
  assert.match(full!, /choosing always never changes it/);

  // A single-notice host gets the concise summary instead, which its own pane
  // wraps or opens whole — so the explanation never depends on row width.
  const sidebarPath = await writeHelpConfig();
  const sidebarConfig = normalizeConfig(JSON.parse(await readFile(sidebarPath, "utf8")));
  const sidebar = await run(sidebarConfig, sidebarPath, [rootRow("Retention", "Always"), "Back", "Cancel"], [], { withSectionHelp: true });
  assert.equal(sidebar.sectionSummaries.length, 1, sidebar.sectionSummaries.join(" | "));
  assert.match(sidebar.sectionSummaries[0]!, /Bundle retention Always suppresses age-based wave cleanup whatever the saved age says/);
  assert.match(sidebar.sectionSummaries[0]!, /the configured age is kept/);
  assert.deepEqual(sidebar.notices, [], "the summary replaces the full notice rather than stacking a second one");
});

test("the disk-only sidebar transaction stages the same wave age through the shared menu", async () => {
  const configPath = await writeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    waveArtifactTtlMs: SEVEN_DAYS_MS,
  });
  const original = await readFile(configPath, "utf8");

  // Root Escape discards there: the file stays exactly as it was.
  const discarded = normalizeConfig(JSON.parse(original));
  await runDiskOnly(discarded, configPath, [
    rootRow("Retention", "On failure"),
    retentionRow("Wave artifact cleanup age", "7 days"),
    "Back",
    undefined,
  ], ["6h"]);
  assert.equal(await readFile(configPath, "utf8"), original, "the disk-only root Escape must not write");
  assert.equal(discarded.waveArtifactTtlMs, SEVEN_DAYS_MS);

  // Save writes the same canonical field, and a reopen shows six hours again.
  const saved = normalizeConfig(JSON.parse(original));
  await runDiskOnly(saved, configPath, [
    rootRow("Retention", "On failure"),
    retentionRow("Wave artifact cleanup age", "7 days"),
    "Back",
    "Save changes",
  ], ["6h"]);
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).waveArtifactTtlMs, SIX_HOURS_MS);

  const reopened = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  const shown = await runDiskOnly(reopened, configPath, [
    rootRow("Retention", "On failure"),
    "Back",
    "Cancel",
  ]);
  assertShows(shown, retentionRow("Wave artifact cleanup age", "6h"));
});

test("the wave age formatter and parser keep the canonical value exact", () => {
  assert.equal(DEFAULT_CONFIG.waveArtifactTtlMs, 2592000000);
  assert.equal(formatWaveArtifactAge(2592000000), "30 days");
  assert.equal(formatWaveArtifactAge(21600000), "6h");
  assert.equal(formatWaveArtifactAge(45 * 60 * 1000), "45m");
  assert.equal(formatWaveArtifactAge(90_000), "90s");
  assert.equal(formatWaveArtifactAge(2000), "2s");
  assert.equal(formatWaveArtifactAge(2500), "2500ms");
  assert.equal(formatWaveArtifactAge(2000), "2s");
  assert.equal(formatWaveArtifactAge(1), "1ms");
  assert.equal(formatWaveArtifactAge(0), "0 · age-based cleanup disabled");
  // The Always precedence is display-only: the age itself is untouched.
  assert.equal(waveArtifactAgeSummary(21600000, "always"), "6h · suppressed while Bundle retention is Always");
  assert.equal(waveArtifactAgeSummary(21600000, "on-failure"), "6h");
  assert.equal(waveArtifactAgeSummary(0, "never"), "0 · age-based cleanup disabled");

  // The reopened field's prefill is the same duration in a parseable spelling.
  assert.equal(waveArtifactAgeInput(2592000000), "30d");
  assert.equal(waveArtifactAgeInput(21600000), "6h");
  assert.equal(waveArtifactAgeInput(45 * 60 * 1000), "45m");
  assert.equal(waveArtifactAgeInput(90_000), "90s");
  assert.equal(waveArtifactAgeInput(2500), "2500ms");
  assert.equal(waveArtifactAgeInput(1), "1ms");
  assert.equal(waveArtifactAgeInput(0), "0");
  // Every prefill round-trips back through the parser to the same value.
  for (const value of [0, 1, 2500, 90_000, 21600000, SEVEN_DAYS_MS, 2592000000, 123456789]) {
    assert.equal(parseWaveArtifactAge(waveArtifactAgeInput(value)), value, String(value));
  }

  assert.equal(parseWaveArtifactAge("21600000"), 21600000);
  assert.equal(parseWaveArtifactAge("6h"), 21600000);
  assert.equal(parseWaveArtifactAge(" 6H "), 21600000);
  assert.equal(parseWaveArtifactAge("45m"), 2700000);
  assert.equal(parseWaveArtifactAge("30d"), 2592000000);
  assert.equal(parseWaveArtifactAge("500ms"), 500);
  assert.equal(parseWaveArtifactAge("0"), 0);
  assert.equal(parseWaveArtifactAge("0d"), 0);
  for (const invalid of ["", "  ", "abc", "-1", "-0", "1.5", "1e3", "6 hours", "h", "10x", "99999999999999999999", "99999999999d"]) {
    assert.equal(parseWaveArtifactAge(invalid), undefined, invalid);
  }
});
