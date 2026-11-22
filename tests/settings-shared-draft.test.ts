/**
 * Issue #723: ONE shared staged draft behind every Review settings surface.
 *
 * Every Review settings screen — the Pi `/review-settings` command, the
 * session-host sidebar's Local editor, and the remote Review editor — runs the
 * same menu over the same single transaction draft, and a host can ask whether
 * THAT draft has unsaved changes through the one optional per-UI handle
 * `ui.settingsDraftStatus`. These cases pin what that means in practice:
 *
 * - The transaction publishes its OWN existing dirty comparison once, at
 *   opening, and detaches it when it ends — on Cancel, root Escape, Save, an
 *   accepted target switch, or a rejection. It is one registration per UI per
 *   transaction, never an observer list.
 * - An accepted edit is dirty while the screen that took it is still drawn:
 *   two levels deep (Tools), three levels deep (Tools → Web), inside the
 *   reviewer and deny pickers, and inside the editors that redraw their own
 *   screen — the role-route editor, the worker-resource editor, and a
 *   scheduled task's reviewer picker. Nothing has to unwind for the draft to
 *   know.
 * - An external-worker Create/Edit form commits only on Create/Apply, so its
 *   unapplied edit is never staged; the same comparison still reads that one
 *   active form branch, and Cancel closes it clean.
 * - What is NOT a change stays clean: reverting a value, clearing a selection
 *   back to the opening set, restoring a deny list by unchecking and rechecking
 *   a member (its text order moved, its members did not), and merely opening a
 *   submenu or picker and going Back.
 * - The handle is the same comparison the caller-supplied target switch already
 *   receives, so no second dirty source exists.
 * - Attaching the handle changes nothing about Save or cancellation: the staged
 *   draft still persists on Save, still discards on Cancel and root Escape, and
 *   still writes nothing on a discard.
 *
 * Every run drives the real menu through its public non-TUI selector seam with
 * a synthetic config in a fresh temporary directory. No real config, provider,
 * network, or Pi session is touched.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import type { ScopedModelChoice } from "../src/settings/models";
import {
  registerReviewSettings,
  runPersistedReviewSettings,
  type PersistedReviewSettingsInput,
} from "../src/settings/command";
import type { PersistedSaveBackend } from "../src/settings/persisted-save";
import type { SettingsDraftStatus, UiContext } from "../src/settings/ui";

// ---------------------------------------------------------------------------
// The host's one registration slot (what the session-host sidebar implements)
// ---------------------------------------------------------------------------

interface DraftProbe {
  /** The port handed to `ui.settingsDraftStatus`. */
  port: SettingsDraftStatus;
  /** How many times a transaction registered a predicate (expected: one). */
  attaches: number;
  /** How many times that registration was released. */
  detaches: number;
  /** The predicate the live transaction published, or undefined after detach. */
  published(): (() => boolean) | undefined;
  /** Ask the live transaction whether ITS draft is dirty. */
  dirty(): boolean;
}

function draftProbe(): DraftProbe {
  let current: (() => boolean) | undefined;
  const probe: DraftProbe = {
    attaches: 0,
    detaches: 0,
    published: () => current,
    dirty(): boolean {
      const predicate = current;
      assert.ok(predicate, "the open transaction publishes its dirty predicate on the shared handle");
      return predicate();
    },
    port: {
      attach(isChanged: () => boolean): () => void {
        probe.attaches += 1;
        // One transaction, one handle: there is no observer collection to
        // accumulate into, and a live registration is never replaced silently.
        assert.equal(current, undefined, "only one settings transaction publishes a dirty predicate at a time");
        current = isChanged;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          probe.detaches += 1;
          current = undefined;
        };
      },
    },
  };
  return probe;
}

// ---------------------------------------------------------------------------
// Scripted plain-selector harness that samples the shared handle every show
// ---------------------------------------------------------------------------

interface Shown {
  title: string;
  options: string[];
  /** What the shared handle said while this screen was being opened. */
  dirty: boolean;
}

interface ScriptedRun {
  ui: UiContext;
  /** Every menu shown, in order, each with the dirty state sampled at that show. */
  shown: Shown[];
  notices: Array<{ message: string; type?: string }>;
  remaining(): number;
}

function scripted(steps: Array<string | undefined>, probe: DraftProbe | undefined, texts: Array<string | undefined> = []): ScriptedRun {
  const shown: Shown[] = [];
  const notices: ScriptedRun["notices"] = [];
  let index = 0;
  const ui: UiContext = {
    select: async (title, options) => {
      shown.push({ title, options: [...options], dirty: probe?.dirty() ?? false });
      assert.ok(index < steps.length, `unexpected extra selection (${title}): ${options.join(" | ")}`);
      const step = steps[index++];
      if (step === undefined) return undefined;
      const match = options.find((option) => option === step) ?? options.find((option) => option.startsWith(step));
      assert.ok(match !== undefined, `missing selection ${JSON.stringify(step)}: ${options.join(" | ")}`);
      return match;
    },
    editText: async (request) => {
      assert.ok(texts.length > 0, `unexpected text field: ${request.title}`);
      return texts.shift();
    },
    notify: (message, type) => { notices.push({ message, type }); },
  };
  // A host that watches the draft supplies its one registration slot on the
  // SAME per-UI context the transaction runs on (issue #723).
  if (probe !== undefined) ui.settingsDraftStatus = probe.port;
  return { ui, shown, notices, remaining: () => steps.length - index };
}

/** Every show whose title starts with `prefix`, in order. */
function showsStartingWith(run: ScriptedRun, prefix: string): Shown[] {
  return run.shown.filter((entry) => entry.title.startsWith(prefix));
}

/** Every show of one menu title, in order. */
function shows(run: ScriptedRun, title: string): Shown[] {
  return run.shown.filter((entry) => entry.title === title);
}

function assertNoErrors(run: ScriptedRun): void {
  for (const notice of run.notices) assert.notEqual(notice.type, "error", notice.message);
}

// ---------------------------------------------------------------------------
// Owned scratch: one fresh synthetic config per case, removed afterwards
// ---------------------------------------------------------------------------

interface Fixture {
  dir: string;
  configPath: string;
  /** The exact bytes on disk when the case opened. */
  original: string;
  loaded: ReviewGateConfig;
}

async function fixture(t: TestContext, body: Record<string, unknown>): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-shared-draft-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "review-gate.json");
  const original = JSON.stringify(body, null, 2);
  await writeFile(configPath, original, "utf8");
  return { dir, configPath, original, loaded: normalizeConfig(JSON.parse(original)) };
}

/** The staged YouShouldKnow notices value the disk holds. */
async function diskNotices(f: Fixture): Promise<{ enabled: boolean; completionGuidance: boolean }> {
  return JSON.parse(await readFile(f.configPath, "utf8")).youShouldKnow;
}

// ---------------------------------------------------------------------------
// One handle, published once and released on every exit path
// ---------------------------------------------------------------------------

test("the transaction publishes its dirty predicate once at opening and releases it when it ends", async (t) => {
  const f = await fixture(t, { enabled: true, youShouldKnow: { enabled: true, completionGuidance: true } });
  const probe = draftProbe();
  const run = scripted(["Cancel"], probe);

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped: [] }),
    { kind: "discarded" },
  );

  assert.equal(probe.attaches, 1, "one registration for the whole transaction, not an observer collection");
  assert.equal(probe.detaches, 1, "the registration is released when the transaction ends");
  assert.equal(probe.published(), undefined, "no predicate outlives the transaction that owns the draft");
  assert.equal(run.shown.length, 1);
  assert.equal(run.shown[0]!.dirty, false, "a fresh draft is clean");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "Cancel writes nothing");
});

test("the handle is released on root Escape, on Save, and when a Save rejects", async (t) => {
  const f = await fixture(t, { enabled: true, youShouldKnow: { enabled: true, completionGuidance: true } });

  // Root Escape (the selector's own cancel) — a discard, and a release.
  const escaped = draftProbe();
  const escapeRun = scripted([undefined], escaped);
  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: escapeRun.ui, scoped: [] }),
    { kind: "discarded" },
  );
  assert.deepEqual([escaped.attaches, escaped.detaches], [1, 1]);
  assert.equal(escaped.published(), undefined);
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "root Escape writes nothing");

  // Save persists the staged nested edit, and still releases the handle.
  const saved = draftProbe();
  const saveRun = scripted(["Tools", "YouShouldKnow notices", undefined, "Save changes"], saved);
  const outcome = await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: saveRun.ui, scoped: [] });
  assert.equal(outcome.kind, "saved");
  assert.deepEqual(await diskNotices(f), { enabled: false, completionGuidance: true }, "Save still persists the staged edit");
  assert.deepEqual([saved.attaches, saved.detaches], [1, 1]);
  assert.equal(saved.published(), undefined);

  // A rejected Save propagates unchanged and still releases the handle.
  const rejected = draftProbe();
  const f2 = await fixture(t, { enabled: true, youShouldKnow: { enabled: true, completionGuidance: true } });
  const backend: PersistedSaveBackend = {
    saveStaged: async () => { throw new Error("the Save backend failed on purpose"); },
  };
  const rejectRun = scripted(["Tools", "YouShouldKnow notices", undefined, "Save changes"], rejected);
  await assert.rejects(
    runPersistedReviewSettings({ config: f2.loaded, configPath: f2.configPath, ui: rejectRun.ui, scoped: [], backend }),
    /failed on purpose/,
  );
  assert.deepEqual([rejected.attaches, rejected.detaches], [1, 1]);
  assert.equal(rejected.published(), undefined, "a rejection cannot leak the handle");
  assert.equal(await readFile(f2.configPath, "utf8"), f2.original, "a rejected Save writes nothing");
});

// ---------------------------------------------------------------------------
// An accepted nested edit is visible before anything unwinds
// ---------------------------------------------------------------------------

test("an accepted Tools toggle is dirty while the Tools submenu is still drawn, and clean again when reverted", async (t) => {
  const f = await fixture(t, { enabled: true, youShouldKnow: { enabled: true, completionGuidance: true } });
  const probe = draftProbe();
  // Root → Tools → toggle → toggle back → Back → Cancel.
  const run = scripted(["Tools", "YouShouldKnow notices", "YouShouldKnow notices", undefined, "Cancel"], probe);

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped: [] }),
    { kind: "discarded" },
  );
  assertNoErrors(run);

  const tools = shows(run, "Tools");
  assert.equal(tools.length, 3, "the submenu re-shows after each accepted toggle");
  assert.equal(tools[0]!.dirty, false, "entering the submenu is not a change");
  assert.equal(tools[1]!.dirty, true, "the accepted toggle is dirty while the operator is still inside the submenu");
  assert.equal(tools[2]!.dirty, false, "the reverted value is clean again: the draft holds the value, not the visit");
  assert.equal(shows(run, "Review settings").at(-1)!.dirty, false, "the root sees the same clean draft after Back");
  assert.equal(run.remaining(), 0);
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "nothing was written");
});

test("an accepted edit three levels deep is dirty there and stays dirty on the way back", async (t) => {
  const f = await fixture(t, { enabled: true, web: { browserVisible: false } });
  const probe = draftProbe();
  // Root → Tools → Web → Browser visibility → Headed → Back → Back → Cancel.
  const run = scripted(
    ["Tools", "Web", "Browser visibility", "Headed · visible browser window", undefined, undefined, "Cancel"],
    probe,
  );

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped: [] }),
    { kind: "discarded" },
  );
  assertNoErrors(run);

  const web = shows(run, "Web settings");
  assert.equal(web.length, 2, "the Web submenu re-shows after the accepted choice");
  assert.equal(web[0]!.dirty, false, "opening Web is not a change");
  assert.equal(web[1]!.dirty, true, "the accepted value is dirty while the operator is still three menus deep");
  assert.equal(shows(run, "Tools").at(-1)!.dirty, true, "Back to Tools keeps the staged edit");
  assert.equal(shows(run, "Review settings").at(-1)!.dirty, true, "the root still sees the staged edit before Cancel");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "a discarded deep edit never reaches the disk");
});

test("a field entry is staged as soon as it is accepted, and a cancelled or invalid entry is not a change", async (t) => {
  const f = await fixture(t, { enabled: true, web: { browserIdleExpiryMinutes: 5 } });
  const probe = draftProbe();
  // Root → Tools → Web → idle expiry: an invalid entry, then a cancelled one,
  // then a real one; then Back out and Cancel.
  const run = scripted(
    ["Tools", "Web", "Browser idle expiry", "Browser idle expiry", "Browser idle expiry", undefined, undefined, "Cancel"],
    probe,
    ["not-a-number", undefined, "30"],
  );

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped: [] }),
    { kind: "discarded" },
  );
  const web = shows(run, "Web settings");
  assert.equal(web[0]!.dirty, false, "opening Web is not a change");
  assert.equal(web[1]!.dirty, false, "an invalid entry that was rejected is not a staged change");
  assert.equal(web[2]!.dirty, false, "a cancelled field is not a staged change");
  assert.equal(web[3]!.dirty, true, "the accepted entry is staged while Web is still drawn");
  assert.ok(run.notices.some((notice) => notice.type === "error"), "the invalid entry was reported actionably");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "Cancel discards the accepted entry too");
});

test("an accepted reviewer toggle is dirty inside the reviewer picker; clearing the set again is clean", async (t) => {
  const f = await fixture(t, { enabled: true, review: { primaryReviewers: [], subtaskReviewers: [] } });
  const probe = draftProbe();
  // Root → Reviewers → Primary reviewers → toggle the model on (the reasoning
  // picker answers) → toggle it off → Back → Back → Cancel.
  const run = scripted(
    ["Reviewers", "Primary reviewers", "acme/deep", "High", "acme/deep", undefined, undefined, "Cancel"],
    probe,
  );

  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [{ model: "acme/deep", label: "acme/deep", supportedThinkingLevels: ["off", "low", "high"] }],
    }),
    { kind: "discarded" },
  );
  const reviewers = shows(run, "Reviewers — Enter toggles — 0/1 selected");
  const withOne = shows(run, "Reviewers — Enter toggles — 1/1 selected");
  assert.ok(reviewers.length >= 1 && withOne.length >= 1, "the picker re-shows with the new selection count");
  assert.equal(shows(run, "Review").at(0)!.dirty, false, "opening the Review submenu is not a change");
  assert.equal(withOne[0]!.dirty, true, "the accepted reviewer is dirty inside the picker, before anything unwinds");
  assert.equal(reviewers.at(-1)!.dirty, false, "clearing the selection back to the opening set is clean again");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "nothing was written");
});

test("a deny-list toggle is dirty as it is drawn, and unchecking it again is clean", async (t) => {
  const f = await fixture(t, { enabled: true, tools: { topLevelDeny: [] } });
  const probe = draftProbe();
  // Root → Tools → Top-level tools → toggle bash → toggle bash back → Back →
  // Back → Cancel. The picker re-shows after each accepted toggle.
  const run = scripted(
    ["Tools", "Top-level tools", "bash", "bash", undefined, undefined, "Cancel"],
    probe,
  );

  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [],
      getToolChoices: () => [{ name: "bash", description: "Execute a shell command." }],
    }),
    { kind: "discarded" },
  );
  const denied = shows(run, "Top-level tools — Enter toggles — 1 denied");
  const allowed = shows(run, "Top-level tools — Enter toggles — 0 denied");
  assert.ok(denied.length >= 1 && allowed.length >= 1, "the picker re-shows after each accepted toggle");
  assert.equal(denied[0]!.dirty, true, "the accepted denial is dirty inside the picker itself");
  assert.equal(allowed.at(-1)!.dirty, false, "unchecking it again leaves the draft clean");
  assert.equal(shows(run, "Tools").at(-1)!.dirty, false, "Tools agrees the reverted list is not a change");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "nothing was written");
});

test("opening a submenu or picker and going Back is never a change", async (t) => {
  const f = await fixture(t, { enabled: true, youShouldKnow: { enabled: true, completionGuidance: true } });
  const probe = draftProbe();
  const run = scripted(
    ["Tools", "Top-level tools", undefined, "Web", undefined, undefined, "Reviewers", "Evidence methods", undefined, undefined, "Cancel"],
    probe,
  );

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped: [] }),
    { kind: "discarded" },
  );
  assert.equal(shows(run, "Review settings").every((entry) => entry.dirty === false), true, "the root never saw a change");
  for (const entry of run.shown) {
    assert.equal(entry.dirty, false, `visiting ${entry.title} is not a change`);
  }
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "navigation writes nothing");
});

// ---------------------------------------------------------------------------
// One comparison for every surface
// ---------------------------------------------------------------------------

test("the shared handle and the caller's target switch report the same value (no second dirty source)", async (t) => {
  const f = await fixture(t, { enabled: true, youShouldKnow: { enabled: true, completionGuidance: true } });
  const probe = draftProbe();
  const requests: boolean[] = [];
  const targetControl: NonNullable<PersistedReviewSettingsInput["targetControl"]> = {
    label: "beta",
    requestSwitch: async (hasUnsavedChanges: boolean) => {
      // The caller's answer and the handle's answer, sampled at the same moment.
      requests.push(hasUnsavedChanges, probe.dirty());
      return false;
    },
  };
  const run = scripted(["Host: beta", "Tools", "YouShouldKnow notices", undefined, "Host: beta", "Cancel"], probe);

  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [],
      targetControl,
    }),
    { kind: "discarded" },
  );
  assert.deepEqual(requests, [false, false, true, true], "both readers see the same clean/dirty pair");
  assert.equal(probe.attaches, 1, "the target switch adds no second registration");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "a declined switch writes nothing");
});

test("the live /review-settings command transaction publishes the same handle", async (t) => {
  const f = await fixture(t, { enabled: true, youShouldKnow: { enabled: true, completionGuidance: true } });
  const probe = draftProbe();
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
  const run = scripted(["Tools", "YouShouldKnow notices", undefined, "Cancel"], probe);
  await handler("", { ui: run.ui });

  assert.equal(probe.attaches, 1, "the Pi command surface registers the same one handle");
  assert.equal(probe.detaches, 1);
  assert.equal(probe.published(), undefined);
  assert.equal(shows(run, "Tools").at(-1)!.dirty, true, "the same nested edit is dirty on this surface too");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "Cancel still discards without a write");
});

test("a host that supplies no handle keeps the menu exactly as it was", async (t) => {
  const f = await fixture(t, { enabled: true, youShouldKnow: { enabled: true, completionGuidance: true } });
  const run = scripted(["Tools", "YouShouldKnow notices", undefined, "Cancel"], undefined);
  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped: [] }),
    { kind: "discarded" },
  );
  assert.equal(run.shown.length, 4);
  assert.equal(await readFile(f.configPath, "utf8"), f.original);
});

// ---------------------------------------------------------------------------
// Editors that redraw their own screen: the edit is staged as it is drawn
// ---------------------------------------------------------------------------

/** One Pi model in the pool, deliberately not listed in either role route. */
const POOL_BODY = {
  enabled: true,
  execution: {
    workerResources: {
      "pi-acme-deep": { selection: { source: "pi", model: "acme/deep" }, maxConcurrent: 2 },
    },
    routes: { execute: [], research: [] },
    maxWorkers: 4,
  },
};
const POOL_SCOPED: ScopedModelChoice[] = [{ model: "acme/deep", label: "acme/deep", supportedThinkingLevels: ["off", "low", "high"] }];

test("an accepted route change is dirty while the route editor is still drawn", async (t) => {
  const f = await fixture(t, structuredClone(POOL_BODY));
  const probe = draftProbe();
  // Root → Execution priority → Add resource → the model → the route editor
  // re-shows with the new entry at slot 1.
  const run = scripted(["Execution priority", "Add resource", "acme/deep", undefined, "Cancel"], probe);

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped: POOL_SCOPED }),
    { kind: "discarded" },
  );
  assertNoErrors(run);

  const route = shows(run, "Execution priority");
  assert.equal(route.length, 2, "the route editor re-shows after the accepted Add");
  assert.equal(route[0]!.dirty, false, "opening the route editor is not a change");
  assert.equal(route[1]!.dirty, true, "the added entry is staged while the route editor still shows it");
  assert.ok(route[1]!.options.some((label) => label.startsWith("1. acme/deep")), "the redraw really lists the added resource");
  assert.equal(shows(run, "Review settings").at(-1)!.dirty, true, "the root agrees the route changed");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "Cancel discards the route edit");
});

test("an accepted resource capacity change is dirty while the resource editor is still drawn", async (t) => {
  const f = await fixture(t, structuredClone(POOL_BODY));
  const probe = draftProbe();
  // Root → Worker resources → the resource → Maximum concurrency → 3 → the
  // resource editor re-shows with the new capacity.
  const run = scripted(["Worker resources", "1. ", "Maximum concurrency", "3", undefined, undefined, "Cancel"], probe);

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped: POOL_SCOPED }),
    { kind: "discarded" },
  );
  assertNoErrors(run);

  const resource = shows(run, "Worker resource pi-acme-deep");
  assert.equal(resource.length, 2, "the resource editor re-shows after the accepted capacity change");
  assert.equal(resource[0]!.dirty, false, "opening the resource editor is not a change");
  assert.equal(resource[1]!.dirty, true, "the new capacity is staged while the resource editor still shows it");
  assert.ok(resource[1]!.options.some((label) => label.startsWith("Maximum concurrency") && label.includes("3")), "the redraw really shows the new capacity");
  assert.equal(shows(run, "Worker resources — shared capacity").at(-1)!.dirty, true, "the pool agrees the resource changed");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "Cancel discards the capacity edit");
});

test("an accepted scheduled-task reviewer is dirty inside the picker; clearing it back is clean", async (t) => {
  const body = {
    enabled: true,
    scheduledTasks: {
      "task-1": {
        name: "Nightly",
        cron: "0 * * * *",
        enabled: true,
        kind: "execute",
        instructions: "do the thing",
        workspace: "/srv/app",
        review: { mode: "selected", reviewers: [{ source: "pi", model: "acme/deep", thinkingLevel: "high" }] },
      },
    },
  };
  const scoped: ScopedModelChoice[] = [
    { model: "acme/deep", label: "acme/deep", supportedThinkingLevels: ["off", "low", "high"] },
    { model: "acme/fast", label: "acme/fast", supportedThinkingLevels: ["off", "low", "high"] },
  ];
  const f = await fixture(t, structuredClone(body));
  const probe = draftProbe();
  // Root → Scheduled tasks → the task → Review → Select reviewers… → add
  // acme/fast (the reasoning picker answers) → remove it again → Back out.
  const run = scripted(
    ["Scheduled tasks", "1. ", "Review", "Select reviewers", "acme/fast", "High", "acme/fast", undefined, undefined, undefined, "Cancel"],
    probe,
  );

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped }),
    { kind: "discarded" },
  );
  assertNoErrors(run);

  const withTwo = shows(run, "Reviewers — Enter toggles — 2/2 selected");
  const withOne = shows(run, "Reviewers — Enter toggles — 1/2 selected");
  assert.ok(withTwo.length >= 1 && withOne.length >= 2, "the picker re-shows with the new selection count");
  assert.equal(withOne[0]!.dirty, false, "opening the task's reviewer picker is not a change");
  assert.equal(withTwo[0]!.dirty, true, "the accepted task reviewer is dirty inside the picker, before anything unwinds");
  assert.equal(withOne.at(-1)!.dirty, false, "clearing back to the opening override is clean again");
  assert.equal(shows(run, "Scheduled task task-1").at(-1)!.dirty, false, "the task editor agrees");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "Cancel discards the task override edit");
});

test("emptying a scheduled task's reviewer picker never stages and restores its prior override", async (t) => {
  const body = {
    enabled: true,
    scheduledTasks: {
      "task-1": {
        name: "Nightly",
        cron: "0 * * * *",
        enabled: true,
        kind: "execute",
        instructions: "do the thing",
        workspace: "/srv/app",
        review: { mode: "selected", reviewers: [{ source: "pi", model: "acme/deep", thinkingLevel: "high" }] },
      },
    },
  };
  const scoped: ScopedModelChoice[] = [{ model: "acme/deep", label: "acme/deep", supportedThinkingLevels: ["off", "low", "high"] }];
  const f = await fixture(t, structuredClone(body));
  const probe = draftProbe();
  // Uncheck the task's only reviewer, leave the picker, and back out.
  const run = scripted(["Scheduled tasks", "1. ", "Review", "Select reviewers", "acme/deep", undefined, undefined, undefined, "Cancel"], probe);

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped }),
    { kind: "discarded" },
  );

  const empty = shows(run, "Reviewers — Enter toggles — 0/1 selected");
  assert.ok(empty.length >= 1, "the picker re-shows with nothing selected");
  assert.equal(empty[0]!.dirty, false, "an emptied selection restores the opening override instead of staging nothing");
  const task = shows(run, "Scheduled task task-1").at(-1)!;
  assert.equal(task.dirty, false, "the rejected subset leaves the task clean");
  assert.ok(
    task.options.some((label) => label.startsWith("Review") && label.includes("1 reviewer selected")),
    `the prior override is still there: ${task.options.join(" | ")}`,
  );
  assert.ok(
    run.notices.some((notice) => notice.type === "error" && notice.message.includes("unchanged")),
    "the rejected empty subset is reported actionably",
  );
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "nothing was written");
});

test("an unapplied external-worker form edit is dirty while the form is open, and clean again after Cancel", async (t) => {
  const body = { enabled: true, externalAgents: { "worker-a": { adapter: "codex-cli", execution: {}, review: {} } } };
  const f = await fixture(t, structuredClone(body));
  const probe = draftProbe();
  // Root → External workers → worker-a → a submitted Identifier → Cancel.
  const run = scripted(
    ["External workers", "worker-a", "Identifier", "Cancel", undefined, "Cancel"],
    probe,
    ["worker-renamed"],
  );

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped: [] }),
    { kind: "discarded" },
  );
  assertNoErrors(run);

  const form = shows(run, "Edit external worker definition");
  assert.equal(form.length, 2, "the form re-shows with the submitted identifier");
  assert.equal(form[0]!.dirty, false, "opening the form is not a change");
  assert.ok(form[0]!.options.some((label) => label === "Identifier: worker-a"), form[0]!.options.join(" | "));
  assert.equal(form[1]!.dirty, true, "the unapplied edit is dirty while the form still shows it");
  assert.ok(form[1]!.options.some((label) => label === "Identifier: worker-renamed"), form[1]!.options.join(" | "));
  assert.equal(shows(run, "External workers — definitions only").at(-1)!.dirty, false, "Cancel rolls the branch back");
  assert.equal(shows(run, "Review settings").at(-1)!.dirty, false, "the transaction is clean again after cancelling");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "an unapplied edit never reaches the disk");
});

test("a new external-worker Create form is clean on open and dirty once a field is submitted", async (t) => {
  const f = await fixture(t, { enabled: true, externalAgents: {} });
  const probe = draftProbe();
  const run = scripted(
    ["External workers", "Create worker", "Codex", "Identifier", "Cancel", undefined, "Cancel"],
    probe,
    ["brand-new"],
  );

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped: [] }),
    { kind: "discarded" },
  );
  assertNoErrors(run);

  const form = shows(run, "Create external agent definition");
  assert.equal(form.length, 2, "the form re-shows with the submitted identifier");
  assert.equal(form[0]!.dirty, false, "a fresh Create form is clean");
  assert.ok(form[0]!.options.some((label) => label === "Identifier: required"), form[0]!.options.join(" | "));
  assert.equal(form[1]!.dirty, true, "the unapplied definition is dirty while the form is open");
  assert.equal(shows(run, "External workers — definitions only").at(-1)!.dirty, false, "Cancel discards the whole branch");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "a discarded Create writes nothing");
});

test("unchecking and rechecking an opening deny-list member is not a change even though its order moved", async (t) => {
  const f = await fixture(t, { enabled: true, tools: { topLevelDeny: ["bash", "read"] } });
  const probe = draftProbe();

  const run = scripted(
    ["Tools", "Top-level tools", "bash", "bash", undefined, undefined, "Cancel"],
    probe,
  );

  assert.deepEqual(
    await runPersistedReviewSettings({
      config: f.loaded,
      configPath: f.configPath,
      ui: run.ui,
      scoped: [],
      getToolChoices: () => [
        { name: "bash", description: "Execute a shell command." },
        { name: "read", description: "Read a file." },
      ],
    }),
    { kind: "discarded" },
  );
  assertNoErrors(run);

  const two = shows(run, "Top-level tools — Enter toggles — 2 denied");
  const one = shows(run, "Top-level tools — Enter toggles — 1 denied");
  assert.equal(one.length, 1, "the first toggle leaves one denial");
  assert.equal(one[0]!.dirty, true, "dropping a denial is a real change");
  assert.ok(two.length >= 2, "the second toggle restores both denials");
  assert.equal(two[1]!.dirty, false, "the same denied members are clean even though the re-added name moved to the end");
  assert.equal(shows(run, "Tools").at(-1)!.dirty, false, "Tools agrees the restored set is not a change");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "nothing was written");
});

// ---------------------------------------------------------------------------
// Reverts inside an editor: restoring the opening value is clean before Back
// ---------------------------------------------------------------------------

for (const path of ["target-controlled", "Local-only"] as const) {
  test(`a ${path} research route restored inside the editor is clean on its own redraw, before Back`, async (t) => {
    // The stored research route names a pooled resource this route cannot use, so
    // the editor opens on an empty working route while the stored entry stays
    // behind. Add, then Exclude, and the route is back where it started. The
    // in-editor redraws agree on both paths; only leaving the editor differs.
    const f = await fixture(t, {
      enabled: true,
      externalAgents: { bin: { adapter: "run-as-binary", command: "unused", execution: { protocol: "pi-review-executor-jsonl-v1" } } },
      execution: {
        workerResources: {
          "pi-acme-deep": { selection: { source: "pi", model: "acme/deep" }, maxConcurrent: 1 },
          "external-bin": { selection: { source: "external", id: "bin" }, maxConcurrent: 1 },
        },
        routes: { execute: [], research: [{ resourceId: "external-bin" }] },
        maxWorkers: 4,
      },
    });
    const probe = draftProbe();
    const requests: boolean[] = [];
    const targetControl: NonNullable<PersistedReviewSettingsInput["targetControl"]> = {
      label: "beta",
      requestSwitch: async (hasUnsavedChanges: boolean) => {
        requests.push(hasUnsavedChanges);
        return false;
      },
    };
    const run = scripted(
      ["Research priority", "Add resource", "acme/deep", "1. acme/deep", "Exclude from this route", undefined, "Cancel"],
      probe,
    );

    assert.deepEqual(
      await runPersistedReviewSettings({
        config: f.loaded,
        configPath: f.configPath,
        ui: run.ui,
        scoped: [{ model: "acme/deep", label: "acme/deep", supportedThinkingLevels: ["off", "low", "high"] }],
        ...(path === "target-controlled" ? { targetControl } : {}),
      }),
      { kind: "discarded" },
    );
    assertNoErrors(run);

    const route = shows(run, "Research priority");
    assert.equal(route.length, 3, "the route editor re-shows after the Add and again after the Exclude");
    assert.deepEqual(
      route.map((shown) => shown.dirty),
      [false, true, false],
      "opening is clean, the staged Add is dirty, and excluding it again restores the stored route before the editor leaves",
    );
    assert.ok(route[1]!.options.some((label) => label.startsWith("1. acme/deep")), "the redraw really lists the added resource");
    assert.ok(!route[2]!.options.some((label) => label.includes("acme/deep")), "the second redraw really dropped it");
    assert.deepEqual(requests, [], "the transaction never asked to switch targets");
    // Leaving the editor keeps each path's existing boundary: the target-switch
    // opt-in keeps the stored entry on an unchanged visit, while the Local-only
    // editor still adopts the reconciled route at Back, as it always has.
    assert.equal(
      shows(run, "Review settings").at(-1)!.dirty,
      path === "Local-only",
      path === "Local-only"
        ? "Local-only Back still reconciles away the entry this route cannot use"
        : "the root agrees the restored route is clean",
    );
    assert.equal(await readFile(f.configPath, "utf8"), f.original, "Cancel wrote nothing");
  });
}

test("Add then Remove of a new worker resource is clean on the pool redraw, before Back", async (t) => {
  const f = await fixture(t, {
    enabled: true,
    execution: {
      workerResources: {
        "pi-acme-deep": { selection: { source: "pi", model: "acme/deep" }, maxConcurrent: 1 },
      },
      routes: { execute: [{ resourceId: "pi-acme-deep" }], research: [] },
      maxWorkers: 4,
    },
  });
  const probe = draftProbe();
  const scoped: ScopedModelChoice[] = [
    { model: "acme/deep", label: "acme/deep", supportedThinkingLevels: ["off", "low", "high"] },
    { model: "acme/fast", label: "acme/fast", supportedThinkingLevels: ["off", "low", "high"] },
  ];
  const run = scripted(
    ["Worker resources", "Add worker resource", "acme/fast", "1", "2. acme/fast", "Remove", undefined, "Cancel"],
    probe,
  );

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped }),
    { kind: "discarded" },
  );
  assertNoErrors(run);

  const pool = shows(run, "Worker resources — shared capacity");
  assert.equal(pool.length, 3, "the pool re-shows after the Add and again after the Remove");
  assert.equal(pool[0]!.dirty, false, "opening the pool is not a change");
  assert.equal(pool[1]!.dirty, true, "the added resource and its enrollment are staged while the pool shows them");
  assert.ok(pool[1]!.options.some((label) => label.includes("acme/fast")), "the redraw really lists the new resource");
  assert.equal(pool[2]!.dirty, false, "removing it again is clean while the pool still shows the visit's route entries");
  assert.ok(pool[2]!.options.some((label) => label.includes("acme/deep")) && !pool[2]!.options.some((label) => label.includes("acme/fast")));
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "nothing was written");
});

test("choosing Inherit shared reasoning again on a role that already inherits is not a change", async (t) => {
  const f = await fixture(t, { enabled: true, externalAgents: { "worker-a": { adapter: "codex-cli", execution: {}, review: {} } } });
  const probe = draftProbe();
  const run = scripted(
    ["External workers", "worker-a", "Advanced review", "Reasoning", "Inherit shared reasoning", undefined, "Cancel", undefined, "Cancel"],
    probe,
  );

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped: [] }),
    { kind: "discarded" },
  );
  assertNoErrors(run);

  assert.ok(showsStartingWith(run, "Reasoning — native model capabilities").length >= 1, "the reasoning picker was reached");
  const role = showsStartingWith(run, "Review overrides");
  assert.equal(role.length, 2, "the role screen re-shows after the choice");
  assert.equal(role[0]!.dirty, false, "opening the role overrides is not a change");
  assert.equal(role[1]!.dirty, false, "re-selecting the value it already had is not a change");
  assert.equal(shows(run, "Edit external worker definition").at(-1)!.dirty, false, "the form stays clean after the no-op choice");
  assert.equal(shows(run, "External workers — definitions only").at(-1)!.dirty, false, "the catalog stays clean");
  assert.equal(shows(run, "Review settings").at(-1)!.dirty, false, "the root stays clean");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "nothing was written");
});

test("an applied external-worker edit restored to its original values is clean on the Local backend", async (t) => {
  // Set a review timeout and Apply, then clear that same timeout and Apply
  // again. The queued operation for the worker id never goes away, but the
  // definition is back to what it was, and this backend holds the whole
  // definition in the draft — so the catalog is clean again.
  const f = await fixture(t, { enabled: true, externalAgents: { "worker-a": { adapter: "codex-cli", execution: {}, review: {} } } });
  const probe = draftProbe();
  const run = scripted(
    ["External workers", "worker-a", "Advanced review", "Timeout", "Back", "Apply edit",
      "worker-a", "Advanced review", "Timeout", "Back", "Apply edit", undefined, "Cancel"],
    probe,
    ["60000", ""],
  );

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped: [] }),
    { kind: "discarded" },
  );
  assertNoErrors(run);

  const role = showsStartingWith(run, "Review overrides");
  assert.equal(role.length, 4, "the role screen re-shows after each timeout entry");
  assert.ok(role[1]!.options.some((label) => label.startsWith("Timeout (ms): 60000")), role[1]!.options.join(" | "));
  assert.ok(role[3]!.options.some((label) => label.startsWith("Timeout (ms): default")), role[3]!.options.join(" | "));

  const catalog = shows(run, "External workers — definitions only");
  assert.deepEqual(catalog.map((entry) => entry.dirty), [false, true, false], "the applied-then-restored edit is clean");
  assert.equal(shows(run, "Review settings").at(-1)!.dirty, false, "the root agrees the restored worker is clean");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "Cancel leaves the file unchanged");
});

test("creating then deleting an unreferenced worker is clean in the catalog, before Back", async (t) => {
  const f = await fixture(t, { enabled: true, externalAgents: {} });
  const probe = draftProbe();
  const run = scripted(
    ["External workers", "Create worker", "Codex", "Identifier", "Roles", "Execution and review", "Create", "temp-worker [", "Delete temp-worker", undefined, "Cancel"],
    probe,
    ["temp-worker"],
  );

  assert.deepEqual(
    await runPersistedReviewSettings({ config: f.loaded, configPath: f.configPath, ui: run.ui, scoped: [] }),
    { kind: "discarded" },
  );
  assertNoErrors(run);

  const catalog = shows(run, "External workers — definitions only");
  assert.equal(catalog.length, 3, "the catalog re-shows after the Create and again after the Delete");
  assert.equal(catalog[0]!.dirty, false, "opening the catalog is not a change");
  assert.equal(catalog[1]!.dirty, true, "the created worker is a real staged change");
  assert.ok(catalog[1]!.options.some((label) => label.startsWith("temp-worker [")), "the redraw lists the new worker");
  assert.equal(catalog[2]!.dirty, false, "deleting it again leaves the catalog at its opening value");
  assert.ok(!catalog[2]!.options.some((label) => label.startsWith("temp-worker [")), "the worker is gone from the list");
  assert.equal(shows(run, "Review settings").at(-1)!.dirty, false, "the root agrees the net-zero transaction is clean");
  assert.equal(await readFile(f.configPath, "utf8"), f.original, "nothing was written");
});
