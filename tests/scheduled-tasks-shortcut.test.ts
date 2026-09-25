/**
 * Issue #190: the /scheduled-tasks landing shortcut into the existing
 * settings transaction.
 *
 * Contract under test: in an interactive session, /scheduled-tasks opens the
 * existing Scheduled tasks submenu immediately (before the settings root);
 * Esc or Back from there lands at the /review-settings root with the
 * Scheduled tasks row highlighted — the root's own retained-selection state,
 * so the ordinary route keeps its retention behavior unchanged — where the
 * same Save changes persists staged edits through the existing validation and
 * persistence and Cancel discards them. The shortcut stages into the one
 * canonical staged catalog through the shared readers/writers — no duplicate
 * scheduler UI or state, no implicit save, and no change to the ordinary
 * /review-settings entry behavior (which still opens at the settings root).
 *
 * Tiers:
 * - Plain-selector (RPC-style) contexts prove the menu order, the staged
 *   Save/Cancel semantics, that nothing is written until Save, and the
 *   fail-closed notices for a missing UI or config file.
 * - The fake TUI host (tests/menu-tui-fakes.ts) proves the same through the
 *   retained-selection custom surface with real Esc keypresses.
 * - The real installed pi-tui SelectList (when resolvable) proves the initial
 *   landing and the save through the actual component; the test skips where
 *   no host is resolvable.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { setMenuTuiHost } from "../src/settings/menu";
import {
  createTuiSettingsContext,
  KEY_DOWN,
  KEY_ENTER,
  KEY_ESCAPE,
  loadRealMenuTuiHost,
} from "./menu-tui-fakes";

const ENTRY_ID = "task-abcdef12";
const ENTRY_ROW = `1. Original name — 0 9 * * * — execute — enabled`;

// Root menu labels (the Scheduler runtime row is absent without the injected
// seam; it never changes the alignment width).
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

/** Row index of the Scheduled tasks section in the root menu. The
 * conditionally shown Scheduler runtime row comes after it, so this holds
 * with or without the injected seam. */
const SCHEDULED_ROOT_INDEX = ROOT_SETTING_LABELS.indexOf("Scheduled tasks");

function alignedRow(label: string, value: string, labels: readonly string[]): string {
  const width = Math.max(...labels.map((candidate) => candidate.length));
  return `${label.padEnd(width)}  ${value}`;
}

function rootSettingsRow(label: string, value: string): string {
  return alignedRow(label, value, ROOT_SETTING_LABELS);
}

function scheduledEditorRow(label: string, value: string): string {
  return alignedRow(label, value, SCHEDULED_EDITOR_LABELS);
}

const downs = (count: number): string[] => Array.from({ length: count }, () => KEY_DOWN);

interface CommandHarness {
  pi: { registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }): void };
  handlers: Map<string, (args: string, ctx: unknown) => Promise<void>>;
}

function makeHarness(): CommandHarness {
  const handlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  return {
    pi: {
      registerCommand(name, options) {
        handlers.set(name, options.handler);
      },
    },
    handlers,
  };
}

interface RecordingContext {
  titles: string[];
  context: unknown;
}

/** Plain-selector command context that records every menu title shown. */
function recordingContext(
  values: Array<string | undefined>,
  inputs: Array<string | undefined> = [],
  hooks: { cwd?: string; onRootShown?: () => void | Promise<void> } = {},
): RecordingContext {
  let index = 0;
  let inputIndex = 0;
  const titles: string[] = [];
  return {
    titles,
    context: {
      scopedModels: [],
      ...(hooks.cwd !== undefined ? { cwd: hooks.cwd } : {}),
      ui: {
        async select(title: string, options: string[]) {
          titles.push(title);
          if (title === "Review settings") await hooks.onRootShown?.();
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
    },
  };
}

async function makeFixture(): Promise<{ dir: string; configPath: string; config: ReturnType<typeof normalizeConfig>; before: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-scheduled-shortcut-"));
  const configPath = join(dir, "review-gate.json");
  const json = {
    enabled: true,
    review: { primaryReviewers: [], subtaskReviewers: [] },
    scheduledTasks: {
      [ENTRY_ID]: {
        name: "Original name",
        cron: "0 9 * * *",
        enabled: true,
        kind: "execute",
        instructions: "Original instructions",
        workspace: dir,
      },
    },
  };
  await writeFile(configPath, JSON.stringify(json), "utf8");
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  return { dir, configPath, config, before: await readFile(configPath, "utf8") };
}

test("/scheduled-tasks registers alongside /review-settings", () => {
  const registered = makeHarness();
  registerReviewSettings({ pi: registered.pi, config: normalizeConfig({}), configPath: "/unused/review-gate.json" });
  assert.ok(registered.handlers.has("review-settings"), "/review-settings still registers");
  assert.ok(registered.handlers.has("scheduled-tasks"), "/scheduled-tasks registers");
});

test("/scheduled-tasks stages an edit; Esc lands at root and Cancel discards it without writing", async () => {
  const { dir, configPath, config, before } = await makeFixture();
  try {
    const registered = makeHarness();
    const runtimeToggles: boolean[] = [];
    registerReviewSettings({
      pi: registered.pi,
      config,
      configPath,
      schedulerRuntime: { enabled: false, setEnabled(next) { runtimeToggles.push(next); } },
    });
    const shortcut = registered.handlers.get("scheduled-tasks")!;

    const ctx = recordingContext([
      ENTRY_ROW, // list → entry
      scheduledEditorRow("Enabled", "On"), // editor → stage toggle
      "Back", // editor → list
      undefined, // Esc from list → root
      "Cancel", // root → discard staged edit
    ]);
    await shortcut("", ctx.context);
    assert.deepEqual(ctx.titles, [
      "Scheduled tasks",
      `Scheduled task ${ENTRY_ID}`,
      `Scheduled task ${ENTRY_ID}`,
      "Scheduled tasks",
      "Review settings",
    ], "the scheduled submenu opens first; Esc lands at the root");
    assert.equal(await readFile(configPath, "utf8"), before, "Cancel discards the staged toggle without writing");
    assert.equal(config.scheduledTasks![ENTRY_ID]!.enabled, true, "Cancel leaves the live config unchanged");
    assert.deepEqual(runtimeToggles, [], "the shortcut does not enable or disable the scheduler");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/scheduled-tasks stages edits through the existing entry editor; Back lands at root and nothing is written until Save", async () => {
  const { dir, configPath, config, before } = await makeFixture();
  try {
    const registered = makeHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const shortcut = registered.handlers.get("scheduled-tasks")!;

    // The root menu is on screen with staged edits in hand: no write yet.
    let rootSnapshot: string | undefined;
    const ctx = recordingContext(
      [
        ENTRY_ROW, // list → entry
        scheduledEditorRow("Name", "Original name"), // editor → Name
        scheduledEditorRow("Enabled", "On"), // re-show → toggle Enabled
        "Back", // editor → list
        "Back", // list → root
        "Save changes", // root → Save
      ],
      ["Renamed via shortcut"],
      {
        onRootShown: async () => {
          rootSnapshot = await readFile(configPath, "utf8");
        },
      },
    );
    await shortcut("", ctx.context);

    assert.deepEqual(ctx.titles, [
      "Scheduled tasks",
      `Scheduled task ${ENTRY_ID}`,
      `Scheduled task ${ENTRY_ID}`,
      `Scheduled task ${ENTRY_ID}`,
      "Scheduled tasks",
      "Review settings",
    ]);
    assert.equal(rootSnapshot, before, "no config write until Save");

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(Object.keys(saved.scheduledTasks), [ENTRY_ID], "the stable identity is preserved");
    assert.equal(saved.scheduledTasks[ENTRY_ID].name, "Renamed via shortcut");
    assert.equal(saved.scheduledTasks[ENTRY_ID].enabled, false);
    assert.equal(saved.scheduledTasks[ENTRY_ID].cron, "0 9 * * *");
    assert.equal(saved.scheduledTasks[ENTRY_ID].instructions, "Original instructions");
    assert.equal(saved.scheduledTasks[ENTRY_ID].workspace, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/review-settings still opens at the root and reaches Scheduled tasks as before", async () => {
  const { dir, configPath, config } = await makeFixture();
  try {
    const registered = makeHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const handler = registered.handlers.get("review-settings")!;

    const ctx = recordingContext([
      rootSettingsRow("Scheduled tasks", "1 of 1 enabled"), // root → Scheduled tasks
      ENTRY_ROW, // list → entry
      scheduledEditorRow("Enabled", "On"), // editor → toggle Enabled
      "Back", // editor → list
      "Back", // list → root
      "Save changes", // root → Save
    ]);
    await handler("", ctx.context);

    assert.deepEqual(ctx.titles, [
      "Review settings",
      "Scheduled tasks",
      `Scheduled task ${ENTRY_ID}`,
      `Scheduled task ${ENTRY_ID}`,
      "Scheduled tasks",
      "Review settings",
    ]);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.scheduledTasks[ENTRY_ID].enabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/scheduled-tasks fails closed without an interactive selector UI", async () => {
  const notices: string[] = [];
  const registered = makeHarness();
  registerReviewSettings({ pi: registered.pi, config: normalizeConfig({}), configPath: "/unused/review-gate.json" });
  const shortcut = registered.handlers.get("scheduled-tasks")!;
  await shortcut("", { log: (message: string) => notices.push(message) });
  assert.deepEqual(notices, ["review gate: /scheduled-tasks requires an interactive selector UI"]);
});

test("/scheduled-tasks fails closed without a persistent config file", async () => {
  const notifications: Array<{ message: string; type?: string }> = [];
  let selectCalls = 0;
  const registered = makeHarness();
  registerReviewSettings({ pi: registered.pi, config: normalizeConfig({}) });
  const shortcut = registered.handlers.get("scheduled-tasks")!;
  await shortcut("", {
    scopedModels: [],
    ui: {
      async select() {
        selectCalls += 1;
        return undefined;
      },
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  });
  assert.equal(selectCalls, 0, "no menu is shown without a config file");
  assert.deepEqual(notifications, [{ message: "No persistent review-gate config file is loaded.", type: "error" }]);
});

test("TUI: /scheduled-tasks lands in the scheduled list; Esc returns to root and Save persists", async () => {
  const { dir, configPath, config } = await makeFixture();
  try {
    const registered = makeHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const shortcut = registered.handlers.get("scheduled-tasks")!;
    const harness = createTuiSettingsContext([
      [KEY_ENTER], // list → entry (row 0)
      [...downs(7), KEY_ENTER], // editor → Enabled (row 7)
      [KEY_ESCAPE], // editor → list
      [KEY_ESCAPE], // list → root (Scheduled tasks row highlighted)
      [...downs(2), KEY_ENTER], // root → Save changes (row 16, two below the highlight)
    ]);
    setMenuTuiHost(harness.host);
    try {
      await shortcut("", harness.context);
    } finally {
      setMenuTuiHost(undefined);
    }

    // The first menu is the scheduled list, not the root.
    assert.equal(harness.lists[0]!.items[0]!.value, ENTRY_ID);
    assert.ok(harness.frames[0]!.join("\n").includes("Scheduled tasks"), "first frame shows the Scheduled tasks submenu");
    assert.ok(harness.frames[4]!.join("\n").includes("Review settings"), "after Esc/Esc the root menu is shown");
    assert.equal(harness.initialIndexes[0], 0, "the list opens at its first row");
    // Menus shown: list, editor, editor re-show, list, root.
    assert.equal(harness.initialIndexes[4], SCHEDULED_ROOT_INDEX, "returning from the list highlights the Scheduled tasks root row");
    assert.equal(harness.selectCalls.length, 0, "every menu used the custom TUI surface");
    assert.equal(harness.exhausted(), false);

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.scheduledTasks[ENTRY_ID].enabled, false, "the staged toggle persisted through the root Save");
    assert.deepEqual(harness.notifyCalls.filter((call) => call.type === "error"), [], "Save succeeded cleanly");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TUI: /scheduled-tasks Esc lands at root and a second Esc exits without saving", async () => {
  const { dir, configPath, config, before } = await makeFixture();
  try {
    const registered = makeHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const shortcut = registered.handlers.get("scheduled-tasks")!;
    const harness = createTuiSettingsContext([
      [KEY_ESCAPE], // list → root
      [KEY_ESCAPE], // root → exit (discard)
    ]);
    setMenuTuiHost(harness.host);
    try {
      await shortcut("", harness.context);
    } finally {
      setMenuTuiHost(undefined);
    }

    assert.equal(harness.lists.length, 2);
    assert.ok(harness.frames[0]!.join("\n").includes("Scheduled tasks"), "first frame shows the Scheduled tasks submenu");
    assert.ok(harness.frames[1]!.join("\n").includes("Review settings"), "Esc from the list lands at the root");
    assert.equal(await readFile(configPath, "utf8"), before, "exiting at the root writes nothing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TUI: /scheduled-tasks Esc from the list highlights the Scheduled tasks root row", async () => {
  const { dir, configPath, config, before } = await makeFixture();
  try {
    const registered = makeHarness();
    const runtimeToggles: boolean[] = [];
    registerReviewSettings({
      pi: registered.pi,
      config,
      configPath,
      schedulerRuntime: { enabled: false, setEnabled(next) { runtimeToggles.push(next); } },
    });
    const shortcut = registered.handlers.get("scheduled-tasks")!;
    const harness = createTuiSettingsContext([
      [KEY_ESCAPE], // list → root (Esc)
      [KEY_ESCAPE], // root → exit (discard)
    ]);
    setMenuTuiHost(harness.host);
    try {
      await shortcut("", harness.context);
    } finally {
      setMenuTuiHost(undefined);
    }

    assert.equal(harness.lists.length, 2);
    assert.equal(harness.initialIndexes[0], 0, "the list opens at its first row");
    assert.equal(harness.initialIndexes[1], SCHEDULED_ROOT_INDEX, "Esc return preselects the Scheduled tasks root row");
    const selectedLines = harness.frames[1]!.filter((line) => line.startsWith("→ "));
    assert.equal(selectedLines.length, 1, `exactly one highlighted root row:\n${harness.frames[1]!.join("\n")}`);
    assert.ok(selectedLines[0]!.includes("Scheduled tasks"), `the highlighted row is Scheduled tasks: ${selectedLines[0]}`);
    assert.equal(harness.exhausted(), false);
    assert.deepEqual(runtimeToggles, [], "opening and backing out does not touch the scheduler runtime");
    assert.equal(await readFile(configPath, "utf8"), before, "backing out writes nothing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TUI: /scheduled-tasks Back from the list highlights the Scheduled tasks root row", async () => {
  const { dir, configPath, config, before } = await makeFixture();
  try {
    const registered = makeHarness();
    const runtimeToggles: boolean[] = [];
    registerReviewSettings({
      pi: registered.pi,
      config,
      configPath,
      schedulerRuntime: { enabled: false, setEnabled(next) { runtimeToggles.push(next); } },
    });
    const shortcut = registered.handlers.get("scheduled-tasks")!;
    const harness = createTuiSettingsContext([
      [...downs(2), KEY_ENTER], // list → Back (rows: entry, Add scheduled task, Back)
      [KEY_ESCAPE], // root → exit (discard)
    ]);
    setMenuTuiHost(harness.host);
    try {
      await shortcut("", harness.context);
    } finally {
      setMenuTuiHost(undefined);
    }

    assert.equal(harness.lists.length, 2);
    assert.equal(harness.initialIndexes[0], 0, "the list opens at its first row");
    assert.equal(harness.initialIndexes[1], SCHEDULED_ROOT_INDEX, "Back return preselects the Scheduled tasks root row");
    const selectedLines = harness.frames[1]!.filter((line) => line.startsWith("→ "));
    assert.equal(selectedLines.length, 1, `exactly one highlighted root row:\n${harness.frames[1]!.join("\n")}`);
    assert.ok(selectedLines[0]!.includes("Scheduled tasks"), `the highlighted row is Scheduled tasks: ${selectedLines[0]}`);
    assert.equal(harness.exhausted(), false);
    assert.deepEqual(runtimeToggles, [], "opening and backing out does not touch the scheduler runtime");
    assert.equal(await readFile(configPath, "utf8"), before, "backing out writes nothing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("TUI: /review-settings still opens at the root head and retains the Scheduled tasks row on return", async () => {
  const { dir, configPath, config } = await makeFixture();
  try {
    const registered = makeHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const handler = registered.handlers.get("review-settings")!;
    const harness = createTuiSettingsContext([
      [...downs(SCHEDULED_ROOT_INDEX), KEY_ENTER], // root → Scheduled tasks
      [KEY_ESCAPE], // list → root (retained)
      [KEY_ESCAPE], // root → exit (discard)
    ]);
    setMenuTuiHost(harness.host);
    try {
      await handler("", harness.context);
    } finally {
      setMenuTuiHost(undefined);
    }

    assert.equal(harness.lists.length, 3);
    assert.equal(harness.initialIndexes[0], 0, "the ordinary entry opens at the root head");
    assert.equal(harness.initialIndexes[1], 0, "the list opens at its first row");
    assert.equal(harness.initialIndexes[2], SCHEDULED_ROOT_INDEX, "returning from Scheduled tasks keeps its root row highlighted");
    assert.equal(harness.exhausted(), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("installed Pi host: /scheduled-tasks lands in the scheduled list and saves through the real SelectList", async (t) => {
  const host = await loadRealMenuTuiHost();
  if (!host) {
    t.skip("no installed pi-tui resolvable in this environment");
    return;
  }
  const { dir, configPath, config } = await makeFixture();
  try {
    const registered = makeHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const shortcut = registered.handlers.get("scheduled-tasks")!;
    const harness = createTuiSettingsContext([
      [KEY_ENTER], // list → entry (row 0)
      [...downs(7), KEY_ENTER], // editor → Enabled (row 7)
      [KEY_ESCAPE], // editor → list
      [KEY_ESCAPE], // list → root (Scheduled tasks row highlighted)
      [...downs(2), KEY_ENTER], // root → Save changes (row 16, two below the highlight)
    ]);
    setMenuTuiHost(host);
    try {
      await shortcut("", harness.context);
    } finally {
      setMenuTuiHost(undefined);
    }

    // The real component renders through frames (harness.lists collects fake
    // instances only), so the initial landing is proven from the first frame.
    const frame = harness.frames[0]!.join("\n");
    assert.ok(frame.includes("Scheduled tasks"), `first frame shows the submenu:\n${frame}`);
    assert.ok(frame.includes(ENTRY_ROW), `first frame lists the existing entry:\n${frame}`);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.scheduledTasks[ENTRY_ID].enabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The real SelectList renders the selected row with the component's own
// "→ " prefix (unselected rows get two spaces); strip ANSI styling first so
// a host-provided colored theme cannot hide the prefix.
const PLAIN_LINE = (line: string): string => line.replace(/\u001b\[[0-9;]*m/g, "");

test("installed Pi host: /scheduled-tasks Esc and Back from the list highlight the Scheduled tasks root row", async (t) => {
  const host = await loadRealMenuTuiHost();
  if (!host) {
    t.skip("no installed pi-tui resolvable in this environment");
    return;
  }
  // Both return paths through the real SelectList: Esc and Back.
  const firstSteps: Array<[string, string[]]> = [
    ["Esc", [KEY_ESCAPE]],
    ["Back", [...downs(2), KEY_ENTER]], // list rows: entry, Add scheduled task, Back
  ];
  for (const [name, firstStep] of firstSteps) {
    const { dir, configPath, config } = await makeFixture();
    try {
      const registered = makeHarness();
      registerReviewSettings({ pi: registered.pi, config, configPath });
      const shortcut = registered.handlers.get("scheduled-tasks")!;
      const harness = createTuiSettingsContext([firstStep, [KEY_ESCAPE]]);
      setMenuTuiHost(host);
      try {
        await shortcut("", harness.context);
      } finally {
        setMenuTuiHost(undefined);
      }

      // The real component renders through frames (harness.lists collects fake
      // instances only), so the preselection is proven from the root frame.
      const rootFrame = harness.frames[1]!;
      assert.ok(rootFrame.join("\n").includes("Review settings"), `${name}: second frame is the root menu`);
      const selectedLines = rootFrame.map(PLAIN_LINE).filter((line) => line.startsWith("→ "));
      assert.equal(selectedLines.length, 1, `${name}: exactly one highlighted root row:\n${rootFrame.join("\n")}`);
      assert.ok(selectedLines[0]!.includes("Scheduled tasks"), `${name}: the highlighted row is Scheduled tasks: ${selectedLines[0]}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
