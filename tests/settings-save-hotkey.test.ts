/**
 * Issue #294 follow-on: the root-owned Ctrl+S save integration.
 *
 * The shared latch producer (src/settings/menu.ts) sets
 * `saveControl.saveRequested` and unwinds one selector at a time through its
 * normal cancellation return path; this file covers the canonical ROOT
 * CONSUMER in src/settings/command.ts: the control is initialized before the
 * /scheduled-tasks shortcut pre-loop, attached to the per-command UI, consumed
 * as an explicit Save after the root retainedSelect returns, and cleared
 * before validation so a failed save neither auto-retries nor degrades into a
 * session-only Escape apply.
 *
 * Coverage: root Ctrl+S persists staged settings through the same Save path
 * (onSaved fires once); the user's explicit contract — saved A → Escape B →
 * Cancel C → reopen Ctrl+S saves B; prior session-only choices (external
 * catalog transaction metadata, explicit alreadyRun edits) persist on a
 * reopen Ctrl+S; deep nested pickers (browser permissions, reviewer list)
 * latch and persist the locally staged state without extra keypresses; the
 * /scheduled-tasks shortcut pre-loop latches into the same Save path; a
 * failed validation leaves the menu open with no retry loop and no Escape
 * misapplication; nested Esc/Back and root Escape semantics are unchanged
 * with the control attached; Ctrl+S inside a suspended Create form is not
 * latched.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Key, matchesKey } from "pi-session-host-tui";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { setMenuTuiHost } from "../src/settings/menu";
import { getPendingSessionDelta } from "../src/settings/session-delta";
import { createTuiSettingsContext, KEY_DOWN, KEY_ENTER, KEY_UP, type TuiSettingsHarness } from "./menu-tui-fakes";

/** The raw terminal Ctrl+S encoding (the kitty encodings are covered by the frontend unit tests). */
const CTRL_S = "\x13";
const ESCAPE = "\x1b";

interface HotkeyHarness {
  config: ReviewGateConfig;
  configPath: string;
  original: string;
  /** Temp directories owned by this workspace, removed by cleanup(). */
  dirs: string[];
  /** Remove every owned temp directory (failure-tolerant). */
  cleanup(): Promise<void>;
  /** Run one menu invocation with the given raw-key steps (one per custom() call). */
  run: (command: "review-settings" | "scheduled-tasks", steps: string[][]) => Promise<TuiSettingsHarness>;
  notices: Array<{ message: string; type?: string }>;
  /** Live configs passed to onSaved, in order (both the Escape apply and Save fire it). */
  saved: ReviewGateConfig[];
}

function assertNoErrors(h: HotkeyHarness): void {
  for (const notice of h.notices) assert.notEqual(notice.type, "error", notice.message);
}

async function hotkeyWorkspace(body: Record<string, unknown>): Promise<HotkeyHarness> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-hotkey-"));
  const configPath = join(dir, "review-gate.json");
  const original = JSON.stringify(body);
  await writeFile(configPath, original, "utf8");
  const config = normalizeConfig(JSON.parse(original));
  let reviewHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let scheduledHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const saved: ReviewGateConfig[] = [];
  registerReviewSettings({
    pi: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        if (name === "review-settings") reviewHandler = options.handler as never;
        if (name === "scheduled-tasks") scheduledHandler = options.handler as never;
      },
    },
    config,
    configPath,
    onSaved: (savedConfig) => { saved.push(savedConfig); },
  });
  assert.ok(reviewHandler && scheduledHandler);
  const notices: Array<{ message: string; type?: string }> = [];
  const dirs = [dir];
  return {
    config,
    configPath,
    original,
    notices,
    saved,
    dirs,
    cleanup: async () => {
      for (const owned of dirs) await rm(owned, { recursive: true, force: true }).catch(() => undefined);
    },
    run: async (command, steps) => {
      const harness = createTuiSettingsContext(steps);
      // The shared Ctrl+S matcher: the public pi-tui key parser over the
      // supported encodings (the frontend unit tests pin the matrix).
      setMenuTuiHost({ ...harness.host, matchesCtrlS: (data) => matchesKey(data, Key.ctrl("s")) });
      const base = harness.context as { ui: Record<string, unknown> };
      const context = {
        ...base,
        ui: { ...base.ui, notify: (message: string, type?: string) => { notices.push({ message, type }); } },
      };
      try {
        await (command === "review-settings" ? reviewHandler! : scheduledHandler!)("", context);
      } finally {
        setMenuTuiHost(undefined);
      }
      assert.equal(harness.exhausted(), false, "the scripted flow must not run out of steps");
      return harness;
    },
  };
}

const down = (n: number): string[] => Array.from({ length: n }, () => KEY_DOWN);

test("root Ctrl+S persists the staged settings through the same Save path", async (t) => {
  const h = await hotkeyWorkspace({ enabled: false, review: { primaryReviewers: [], subtaskReviewers: [] } });
  t.after(() => h.cleanup());
  const rendered = await h.run("review-settings", [
    [...down(12), KEY_ENTER], // root → Subtask notifications
    [KEY_DOWN, KEY_ENTER], // Quiet → Noisy
    [CTRL_S], // root re-show: request save
  ]);
  assert.ok(rendered.frames[0]!.some((line) => line.includes("apply for session")), "root Escape hint must describe apply, not discard");
  assert.ok(rendered.frames[1]!.some((line) => line.includes("cancel")), "nested picker cancellation hint stays unchanged");
  assertNoErrors(h);
  assert.ok(h.notices.some((n) => n.type === "info" && n.message === "Review settings saved."));
  assert.equal(h.saved.length, 1, "onSaved fires exactly once for the hotkey save");
  const saved = JSON.parse(await readFile(h.configPath, "utf8"));
  assert.equal(saved.execution.subtaskNotifications, "noisy");
});

test("saved A → Escape B → Cancel C → reopen Ctrl+S saves B (the explicit contract)", async (t) => {
  const h = await hotkeyWorkspace({
    enabled: false,
    review: { activeReviewers: [] },
    externalAgents: {
      alpha: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
      beta: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
    execution: {
      workerResources: { r: { selection: { source: "external", id: "alpha" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "r" }], research: [] },
    },
  });
  t.after(() => h.cleanup());

  // Run 1: switch the executor alpha → beta and exit with root Escape.
  await h.run("review-settings", [
    [...down(2), KEY_ENTER], // root → Worker resources
    [KEY_ENTER], // pool → alpha entry
    [KEY_ENTER], // entry → Model
    [KEY_DOWN, KEY_ENTER], // model picker: alpha (current) → beta
    [...down(3), KEY_ENTER], // entry re-show → Back
    [...down(2), KEY_ENTER], // pool re-show → Back
    [ESCAPE], // root Escape: session-only apply
  ]);
  assertNoErrors(h);
  assert.deepEqual(h.config.execution!.workerResources!.r.selection, { source: "external", id: "beta" });
  assert.equal(await readFile(h.configPath, "utf8"), h.original, "Escape must not write the config file");
  assert.ok(h.notices.some((n) => n.message === "Review settings applied for this session (not saved to disk)."));
  assert.equal(h.saved.length, 1, "the Escape apply runs the same onSaved runtime hook as Save");

  // Run 2: switch back to alpha and explicitly Cancel — B stays active.
  await h.run("review-settings", [
    [...down(2), KEY_ENTER], // root → Worker resources
    [KEY_ENTER], // pool → beta entry
    [KEY_ENTER], // entry → Model
    [KEY_ENTER], // model picker: alpha (row 0, beta is current)
    [...down(3), KEY_ENTER], // entry re-show → Back
    [...down(2), KEY_ENTER], // pool re-show → Back
    [KEY_UP, KEY_UP, KEY_UP, KEY_ENTER], // root re-show (Worker resources): wrap to Cancel
  ]);
  assertNoErrors(h);
  assert.deepEqual(h.config.execution!.workerResources!.r.selection, { source: "external", id: "beta" });
  assert.equal(await readFile(h.configPath, "utf8"), h.original, "Cancel must not write the config file");
  assert.equal(h.saved.length, 1, "Cancel fires no onSaved");

  // Run 3: reopen and press Ctrl+S with no new edits — B persists.
  await h.run("review-settings", [[CTRL_S]]);
  assertNoErrors(h);
  assert.ok(h.notices.some((n) => n.message === "Review settings saved."));
  assert.equal(h.saved.length, 2);
  const saved = JSON.parse(await readFile(h.configPath, "utf8"));
  assert.deepEqual(saved.execution.workerResources.r.selection, { source: "external", id: "beta" });
  assert.equal(getPendingSessionDelta(h.config), undefined, "a successful Save clears the pending delta");
});

test("prior session-only catalog edit and alreadyRun edit persist on a reopen Ctrl+S", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-hotkey-meta-"));
  const h = await hotkeyWorkspace({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    externalAgents: {
      A: { adapter: "claude-cli", command: process.execPath, model: "model-a", execution: {} },
    },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Once",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Run once",
        workspace: dir,
        oneShot: true,
      },
    },
  });
  h.dirs.push(dir);
  t.after(() => h.cleanup());

  // Run 1: edit the external agent's shared model AND toggle the one-shot
  // already-run state, then exit with root Escape.
  await h.run("review-settings", [
    [...down(3), KEY_ENTER], // root → External workers
    [KEY_ENTER], // list → A
    [...down(3), KEY_ENTER], // edit menu → Shared model
    [...down(2), KEY_ENTER], // model picker: Unset, Keep current → Opus 5.5
    [...down(3), KEY_ENTER], // edit re-show (model) → Apply edit
    [...down(2), KEY_ENTER], // list re-show → Back
    [...down(12), KEY_ENTER], // root re-show (External workers) → Scheduled tasks
    [KEY_ENTER], // task list → Once
    [...down(10), KEY_ENTER], // entry editor → Already run
    [...down(2), KEY_ENTER], // entry re-show (Already run) → Back
    [...down(2), KEY_ENTER], // task list re-show → Back
    [ESCAPE], // root Escape: session-only apply
  ]);
  assertNoErrors(h);
  assert.equal(h.config.externalAgents!.A.model, "claude-opus-5-5", "the catalog edit is live-only");
  assert.equal(h.config.scheduledTasks!["task-abcdef12"].alreadyRun, true, "the explicit toggle is live-only");
  assert.equal(await readFile(h.configPath, "utf8"), h.original, "Escape must not write the config file");
  const pending = getPendingSessionDelta(h.config);
  assert.ok(pending, "the Escape apply records the pending delta");
  assert.deepEqual(pending!.agentOperations.map(({ id, nextId }) => [id, nextId]), [["A", "A"]]);
  assert.deepEqual([...pending!.alreadyRunEdited], ["task-abcdef12"]);

  // Run 2: reopen and press Ctrl+S with no new edits — both persist.
  await h.run("review-settings", [[CTRL_S]]);
  assertNoErrors(h);
  const saved = JSON.parse(await readFile(h.configPath, "utf8"));
  assert.equal(saved.externalAgents.A.model, "claude-opus-5-5");
  assert.equal(saved.scheduledTasks["task-abcdef12"].alreadyRun, true);
  assert.equal(getPendingSessionDelta(h.config), undefined, "a successful Save clears the pending delta");
  assert.equal(h.saved.length, 2, "Escape and Save each fire onSaved once");
});

test("Ctrl+S in a deep nested permissions submenu persists the staged toggle without extra keypresses", async (t) => {
  const h = await hotkeyWorkspace({ enabled: false, review: { primaryReviewers: [], subtaskReviewers: [] } });
  t.after(() => h.cleanup());
  await h.run("review-settings", [
    [...down(16), KEY_ENTER], // root → Web
    [...down(5), KEY_ENTER], // web settings → Browser permissions
    [...down(5), KEY_ENTER], // permissions → Model camera (toggle On)
    [CTRL_S], // permissions re-show: request save from the nested submenu
  ]);
  assertNoErrors(h);
  assert.ok(h.notices.some((n) => n.message === "Review settings saved."));
  const saved = JSON.parse(await readFile(h.configPath, "utf8"));
  assert.equal(saved.web.browserPermissions.modelCamera, true, "the nested staged permission persists");
  assert.equal(h.saved.length, 1);
});

test("Ctrl+S in the reviewer picker persists the staged reviewer set without extra keypresses", async (t) => {
  const h = await hotkeyWorkspace({
    enabled: false,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    externalAgents: {
      A: { adapter: "claude-cli", command: process.execPath, execution: {}, review: {} },
    },
  });
  t.after(() => h.cleanup());
  await h.run("review-settings", [
    [...down(6), KEY_ENTER], // root → Reviewers
    [...down(3), KEY_ENTER], // review section → Primary reviewers
    [KEY_ENTER], // reviewer list: toggle A
    [CTRL_S], // reviewer list re-show: request save from the nested picker
  ]);
  assertNoErrors(h);
  const saved = JSON.parse(await readFile(h.configPath, "utf8"));
  assert.deepEqual(saved.review.primaryReviewers, [{ source: "external", id: "A" }]);
  assert.equal(h.saved.length, 1);
});

test("the /scheduled-tasks shortcut pre-loop latches into the same Save path", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-hotkey-shortcut-"));
  const h = await hotkeyWorkspace({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Nightly",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Work",
        workspace: dir,
      },
    },
  });
  h.dirs.push(dir);
  t.after(() => h.cleanup());
  await h.run("scheduled-tasks", [
    [KEY_ENTER], // task list → Nightly
    [...down(8), KEY_ENTER], // entry editor → Enabled (toggle Off)
    [...down(4), KEY_ENTER], // entry re-show (Enabled) → Back
    [CTRL_S], // task list re-show: request save from the shortcut pre-loop
  ]);
  assertNoErrors(h);
  assert.ok(h.notices.some((n) => n.message === "Review settings saved."));
  const saved = JSON.parse(await readFile(h.configPath, "utf8"));
  assert.equal(saved.scheduledTasks["task-abcdef12"].enabled, false);
  assert.equal(h.saved.length, 1);
});

test("a failed Ctrl+S save stays open without retrying and Escape does not misapply", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-hotkey-fail-"));
  const temp = join(tmpdir(), "pi-clipboard-iijj.png"); // unobserved, never created
  const h = await hotkeyWorkspace({
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      "task-abcdef12": {
        name: "Hand-edited temp",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: `Analyze ${temp}`,
        workspace: dir,
      },
    },
  });
  h.dirs.push(dir);
  t.after(() => h.cleanup());
  await h.run("review-settings", [
    [CTRL_S], // root: request save — the unobserved temp reference fails closed
    [ESCAPE], // re-shown root (Save highlighted): Escape must NOT apply or save
    [KEY_DOWN, KEY_ENTER], // Save changes → Cancel: leave without persisting
  ]);
  const errors = h.notices.filter((n) => n.type === "error");
  assert.equal(errors.length, 2, `exactly one attempt per keypress — no auto-retry loop: ${JSON.stringify(h.notices)}`);
  for (const error of errors) assert.ok(error.message.includes(temp), "the actionable notice names the reference");
  assert.equal(await readFile(h.configPath, "utf8"), h.original, "nothing was persisted");
  assert.equal(h.saved.length, 0, "no onSaved for a failed save or the rejected Escape");
  assert.ok(!h.notices.some((n) => n.message === "Review settings saved."));
  assert.ok(!h.notices.some((n) => n.message === "Review settings applied for this session (not saved to disk)."));
});

test("nested Esc/Back and root Escape are unchanged with the save control attached", async (t) => {
  const h = await hotkeyWorkspace({ enabled: false, review: { primaryReviewers: [], subtaskReviewers: [] } });
  t.after(() => h.cleanup());
  await h.run("review-settings", [
    [...down(12), KEY_ENTER], // root → Subtask notifications
    [KEY_DOWN, KEY_ENTER], // Quiet → Noisy (staged)
    [ESCAPE], // root re-show: Escape applies session-only, as before
  ]);
  assertNoErrors(h);
  assert.equal(h.config.execution!.subtaskNotifications, "noisy", "the staged change is live");
  assert.equal(await readFile(h.configPath, "utf8"), h.original, "Escape must not write the config file");
  assert.ok(h.notices.some((n) => n.message === "Review settings applied for this session (not saved to disk)."));
  assert.equal(h.saved.length, 1, "the Escape apply runs the onSaved runtime hook");
});

test("Ctrl+S inside a suspended Create form is not latched and the form continues", async (t) => {
  const h = await hotkeyWorkspace({ enabled: false, review: { primaryReviewers: [], subtaskReviewers: [] } });
  t.after(() => h.cleanup());
  await h.run("review-settings", [
    [...down(3), KEY_ENTER], // root → External workers
    [KEY_ENTER], // list (0 agents) → Create worker
    [CTRL_S, KEY_ENTER], // adapter picker: Ctrl+S is suspended — the form continues to Claude Code
    [ESCAPE], // create form re-show: cancel the form
    [KEY_DOWN, KEY_ENTER], // list re-show → Back
    [ESCAPE], // root Escape: a real Escape, not a latched save
  ]);
  assertNoErrors(h);
  assert.ok(!h.notices.some((n) => n.message === "Review settings saved."), "the suspended Ctrl+S must not save");
  assert.ok(h.notices.some((n) => n.message === "Review settings applied for this session (not saved to disk)."));
  assert.equal(await readFile(h.configPath, "utf8"), h.original);
  assert.equal(h.saved.length, 1, "only the final Escape apply fires onSaved");
});
