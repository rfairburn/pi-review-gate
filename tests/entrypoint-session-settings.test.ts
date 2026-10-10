/**
 * Issue #294 / PR #352 regression: session-only settings must survive the
 * /subtasks-view toggle through the actual activate() entrypoint.
 *
 * The view toggle persists only its owned disk preference
 * (ui.subtasksViewExpanded). The old callback installed the disk-derived
 * config into the live config, which reset the Escape-applied executor,
 * reviewer, mode, and catalog choices while their pending session-delta
 * metadata (keyed by live config identity) still referenced them — a
 * reopened /review-settings then failed with "Pending external worker is
 * missing from live settings." This regression drives the real activate()
 * entrypoint and its registered commands:
 *
 *   disk A → /review-settings mode change + rename A→B, root Escape
 *          (live B/execute, disk still A)
 *          → /subtasks-view (disk still A for unrelated settings; the view
 *            preference is the only disk change)
 *          → reopen /review-settings (B/catalog and the session mode are
 *            still visible, no pending external worker error)
 *          → Save (explicit "Save changes" row and root Ctrl+S) persists
 *            B/catalog, the mode, and the view choice.
 *
 * A successful Save also proves the pending external-worker operation
 * metadata survived the toggle: without it, Save would reject the renamed
 * reviewer ("no longer supports review on disk") instead of persisting B.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Key, matchesKey } from "pi-session-host-tui";
import { normalizeConfig } from "../src/config";
import { activate } from "../src/index";
import { setMenuTuiHost } from "../src/settings/menu";
import { createTuiSettingsContext, KEY_DOWN } from "./menu-tui-fakes";
import { indexTestConfig, testActivation, trigger } from "./entrypoint-harness";

/** Raw terminal Ctrl+S encoding (the same public matcher as the hotkey suite). */
const CTRL_S = "\x13";
const KEY_ENTER = "\r";

// Row formatting mirrors src/settings/command.ts alignedSettingsRows so the
// scripted /review-settings selections match the rendered menu exactly.
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
  "Bundle retention",
  "Global concurrency",
  "Retry policy",
  "Subtask notifications",
  "Deferred Pi tools",
  "Subtasks view",
  "Scheduled tasks",
  "Web",
] as const;

function alignedTestRow(label: string, value: string, labels: readonly string[]): string {
  const width = Math.max(...labels.map((candidate) => candidate.length));
  return `${label.padEnd(width)}  ${value}`;
}

function rootSettingsRow(label: (typeof ROOT_SETTING_LABELS)[number], value: string): string {
  return alignedTestRow(label, value, ROOT_SETTING_LABELS);
}

interface EntrypointRuntime {
  hooks: Map<string, Array<(...args: unknown[]) => unknown>>;
  commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
  notices: string[];
  /** Option lists passed to each plain ui.select call, in order. */
  selectOptions: string[][];
  pi: Record<string, unknown>;
  ctx: Record<string, unknown>;
}

/**
 * Minimal top-level runtime capturing every command activate() registers.
 * The session context provides the below-editor widget surface that
 * /subtasks-view requires (background-controller toggleExpandedView).
 */
function createEntrypointRuntime(cwd: string): EntrypointRuntime {
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const notices: string[] = [];
  const selectOptions: string[][] = [];
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options.handler);
    },
    notify(message: string) { notices.push(String(message)); },
    sendUserMessage() {},
  };
  const ctx = {
    cwd,
    ui: {
      notify: (message: string) => notices.push(String(message)),
      setWidget: () => undefined,
    },
  };
  return { hooks, commands, notices, selectOptions, pi, ctx };
}

/** Disk config A: external worker A referenced as executor and primary reviewer. */
async function writeDiskA(dir: string): Promise<{ configPath: string; body: Record<string, unknown> }> {
  const body = {
    ...indexTestConfig,
    externalAgents: {
      A: { adapter: "claude-cli", command: process.execPath, model: "model-a", review: {}, execution: {} },
    },
    review: { primaryReviewers: [{ source: "external", id: "A" }], subtaskReviewers: [] },
    execution: {
      workerResources: { r: { selection: { source: "external", id: "A" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "r" }], research: [] },
    },
  };
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify(body), "utf8");
  process.env.PI_REVIEW_GATE_CONFIG = configPath;
  delete process.env.PI_REVIEW_GATE_DISABLED;
  return { configPath, body };
}

async function activateRuntime(cwd: string): Promise<EntrypointRuntime> {
  const rt = createEntrypointRuntime(cwd);
  await activate(rt.pi, testActivation());
  await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);
  return rt;
}

/** Drive /review-settings through the plain selector fallback. */
async function runPlainSettings(
  rt: EntrypointRuntime,
  values: Array<string | undefined>,
  inputs: string[],
): Promise<void> {
  const handler = rt.commands.get("review-settings");
  assert.ok(handler, "activate() registers the review-settings command");
  let index = 0;
  await handler("", {
    scopedModels: [],
    ui: {
      select: async (_title: string, options: string[]) => {
        rt.selectOptions.push(options);
        const value = values[index++];
        if (value !== undefined) assert.ok(options.includes(value), `missing selection ${value}: ${options.join(" | ")}`);
        return value;
      },
      input: async () => {
        assert.ok(inputs.length > 0, "unexpected text field");
        return inputs.shift();
      },
      confirm: async () => false,
      notify: (message: string, type?: string) => rt.notices.push(type ? `${type}: ${message}` : message),
    },
  });
}

/** Drive /review-settings through the fake native TUI host (Ctrl+S flow). */
async function runTuiSettings(rt: EntrypointRuntime, steps: string[][]): Promise<string[][]> {
  const handler = rt.commands.get("review-settings");
  assert.ok(handler, "activate() registers the review-settings command");
  const harness = createTuiSettingsContext(steps);
  setMenuTuiHost({ ...harness.host, matchesCtrlS: (data) => matchesKey(data, Key.ctrl("s")) });
  // Route the menu's notices into the runtime's shared notice log.
  const base = harness.context as { ui: Record<string, unknown> };
  const context = {
    ...base,
    ui: { ...base.ui, notify: (message: string, type?: string) => rt.notices.push(type ? `${type}: ${message}` : message) },
  };
  try {
    await handler("", context);
  } finally {
    setMenuTuiHost(undefined);
  }
  assert.equal(harness.exhausted(), false, "the scripted flow must not run out of steps");
  return harness.frames;
}

function assertNoErrors(rt: EntrypointRuntime): void {
  for (const notice of rt.notices) {
    assert.ok(!notice.startsWith("error:"), `unexpected error notice: ${notice}`);
  }
}

/**
 * Shared scenario: disk A → /review-settings mode change + rename A→B with
 * root Escape (live B/execute, disk still A) → /subtasks-view. The caller
 * reopens settings and saves through the variant under test.
 */
async function scenarioThroughViewToggle(dir: string): Promise<{ rt: EntrypointRuntime; configPath: string }> {
  const { configPath, body } = await writeDiskA(dir);
  const rt = await activateRuntime(dir);

  // Run 1: switch the operating mode and rename external worker A → B, then
  // exit with root Escape — the session-only apply installs both live while
  // disk keeps A (the rename cascades the executor and reviewer references).
  await runPlainSettings(rt, [
    rootSettingsRow("Operating mode", "Prefer orchestration"),
    "Prefer execution",
    rootSettingsRow("External workers", "1 defined"),
    "A [claude-cli]",
    "Identifier: A",
    "Apply edit",
    "Back",
    undefined, // root Escape: session-only apply
  ], ["B"]);
  assertNoErrors(rt);
  assert.ok(
    rt.notices.some((notice) => notice === "info: Review settings applied for this session (not saved to disk)."),
    "the root Escape applies the staged settings session-only",
  );
  const afterEscape = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(afterEscape.externalAgents.B, undefined, "Escape must not write the config file");
  assert.deepEqual(afterEscape.externalAgents, body.externalAgents);

  // /subtasks-view through the registered command: it persists only its owned
  // disk preference; every unrelated setting stays exactly as disk A (the
  // save boundary canonicalizes the catalogs in place, so compare the whole
  // record with the ui key excluded).
  const beforeToggle = JSON.parse(await readFile(configPath, "utf8"));
  const viewHandler = rt.commands.get("subtasks-view");
  assert.ok(viewHandler, "activate() registers the subtasks-view command");
  await viewHandler("", rt.ctx);
  assertNoErrors(rt);
  const afterToggle = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(afterToggle.ui.subtasksViewExpanded, true, "the view preference persists to disk");
  // The save boundary canonicalizes the catalogs in place; normalize both
  // sides so only semantic changes can fail this check.
  const { ui: _uiAfter, ...restAfter } = afterToggle;
  assert.deepEqual(normalizeConfig(restAfter), normalizeConfig(beforeToggle), "unrelated disk settings stay A");

  return { rt, configPath };
}

/** Assert the reopened root menu still shows the session-only state. */
function assertLiveStateVisible(rt: EntrypointRuntime): void {
  assert.ok(
    rt.selectOptions.some((options) => options.includes("B [claude-cli]")),
    "the renamed worker is still visible after the view toggle",
  );
  assert.ok(
    !rt.selectOptions.some((options) => options.includes("A [claude-cli]")),
    "the pre-rename worker is gone from the live catalog",
  );
  assert.ok(
    rt.selectOptions.some((options) => options.includes(rootSettingsRow("Operating mode", "Prefer execution"))),
    "the Escape-applied operating mode survives the view toggle",
  );
  assert.ok(
    rt.selectOptions.some((options) => options.includes(rootSettingsRow("Subtasks view", "Expanded"))),
    "the live config shows the expanded view choice",
  );
}

/** The Save must persist B/catalog, the mode, and the view choice. */
async function assertSavedB(configPath: string): Promise<void> {
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved.externalAgents.A, undefined, "the rename releases the original id on disk");
  assert.equal(saved.externalAgents.B.model, "model-a", "the renamed worker persists its definition");
  assert.deepEqual(saved.review.primaryReviewers, [{ source: "external", id: "B" }], "the reviewer cascade persists");
  assert.deepEqual(saved.execution.workerResources.r.selection, { source: "external", id: "B" }, "the executor cascade persists");
  assert.equal(saved.operatingMode, "execute", "the session-applied mode persists");
  assert.equal(saved.ui.subtasksViewExpanded, true, "the view choice persists");
}

test("/subtasks-view keeps Escape-applied settings live; explicit Save persists them with the view choice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-entrypoint-view-save-"));
  try {
    const { rt, configPath } = await scenarioThroughViewToggle(dir);

    // Reopen: B/catalog and the session mode are still visible (no pending
    // external worker error), then the explicit Save row persists everything.
    rt.selectOptions.length = 0;
    let reopenError: unknown;
    try {
      await runPlainSettings(rt, [
        rootSettingsRow("External workers", "1 defined"),
        "Back",
        "Save changes",
      ], []);
    } catch (error) {
      reopenError = error;
    }
    assert.equal(
      reopenError,
      undefined,
      `reopening settings after /subtasks-view must not fail: ${String(reopenError)}`,
    );
    assertNoErrors(rt);
    assertLiveStateVisible(rt);
    assert.ok(rt.notices.some((notice) => notice === "info: Review settings saved."));
    await assertSavedB(configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/subtasks-view keeps Escape-applied settings live; root Ctrl+S persists them with the view choice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-entrypoint-view-ctrls-"));
  try {
    const { rt, configPath } = await scenarioThroughViewToggle(dir);

    // Reopen through the fake native TUI host: the external-worker list frame
    // still shows B (the catalog survived the toggle), then Ctrl+S at the root
    // latches the same canonical Save path as the explicit row.
    const frames = await runTuiSettings(rt, [
      [KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER], // root → External workers
      [KEY_DOWN, KEY_DOWN, KEY_ENTER], // list re-show → Back
      [CTRL_S], // root re-show: request save
    ]);
    assertNoErrors(rt);
    assert.ok(
      frames.some((frame) => frame.some((line) => line.includes("B [claude-cli]"))),
      "the renamed worker is still visible in the native UI after the view toggle",
    );
    assert.ok(rt.notices.some((notice) => notice === "info: Review settings saved."));
    await assertSavedB(configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
