/**
 * Issue #536 correction: `Selected tool names` is chosen in the SAME searchable
 * multi-select the tool-block (deny) pickers use.
 *
 * Production coverage for the audit-name picker in
 * `src/settings/tool-protection.ts` reusing `src/settings/deny-picker.ts`:
 *
 * - The candidate inventory is the runtime's discoverable list read WITHOUT the
 *   deny-only loader filter, so a runtime that offers `tool_search` still shows
 *   it — as an explicit never-audited infrastructure row that no toggle can
 *   check, while both deny pickers keep excluding it from the very same
 *   inventory.
 * - The live NAME query is a pure view filter: a name hidden by the query stays
 *   audited and is saved, the query is per-picker and transient, and Back stays
 *   reachable under a query that matches nothing.
 * - A saved audit name the live inventory does not offer stays a reversible
 *   `[not currently available]` row across toggles and Back/re-entry.
 * - The transaction behaves like the deny picker: Save, Ctrl+S inside a
 *   narrowed picker, root Escape (session-only apply), and Cancel.
 * - Reduced coverage STARTS CHECKED (issue #536): entering `Selected tool names`
 *   with no established list checks every currently offered auditable name once
 *   (the exempt loader is never among them), so the user unchecks exemptions. An
 *   existing nonempty subset is never re-checked, an unchecked tool stays
 *   unchecked across Back and reopening, and an inventory that offers nothing
 *   keeps the existing empty-invalid warning path.
 *
 * Everything here is synthetic: no provider, no auditor run, no network, and no
 * live configuration file. Every scripted UI flow fails boundedly.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Key, matchesKey } from "pi-session-host-tui";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { DeferredToolManager } from "../src/deferred-tools";
import { registerReviewSettings } from "../src/settings/command";
import { setMenuTuiHost } from "../src/settings/menu";
import { readToolChoices } from "../src/settings/tools";
import { initialAuditedToolNames } from "../src/settings/tool-protection";
import {
  createTuiSettingsContext,
  KEY_DOWN,
  KEY_ENTER,
  KEY_ESCAPE,
  stripAnsi,
  type TuiSettingsHarness,
} from "./menu-tui-fakes";

const CTRL_S = "\x13";
const TEST_TIMEOUT_MS = 30_000;

const down = (count: number): string[] => Array.from({ length: count }, () => KEY_DOWN);
const typed = (text: string): string[] => [...text];

/** Root row indices of the /review-settings menu (see settings-menu.test.ts). */
const ROOT = { tools: 13, save: 16, cancel: 17 } as const;
/** Tools submenu row indices. */
const TOOLS = { topLevel: 0, toolProtection: 6, rows: 8 } as const;
/** Tool protection submenu rows with `scope: "selected"` (names row present). */
const PROTECTION = { auditedNames: 3, rows: 7 } as const;

/** A modest synthetic inventory that DOES offer the reserved loader. */
const INVENTORY = [
  { name: "apply_patch", description: "Edit files with a patch." },
  { name: "bash", description: "Run shell commands." },
  { name: "read", description: "Read files." },
  { name: "tool_search", description: "Search the authorized tool catalog." },
  { name: "web_fetch", description: "Fetch a page." },
  { name: "write", description: "Write files." },
];
const INVENTORY_NAMES = INVENTORY.map((choice) => choice.name);
/** The offered names this gate can actually audit — the loader is exempt. */
const AUDITABLE_NAMES = INVENTORY_NAMES.filter((name) => name !== "tool_search");

/** A saved audit name the live inventory does not offer. */
const GHOST_TOOL = "GhostTool";

const AUDIT_CONFIG = {
  enabled: false,
  review: { activeReviewers: [] },
  externalAgents: { "generic-auditor": { adapter: "generic-cli", command: "audit-bin", review: {} } },
  toolProtection: {
    level: "dangerous",
    auditor: { source: "external", id: "generic-auditor" },
    scope: "selected",
    toolNames: [GHOST_TOOL, "read"],
  },
};

/** The saved shape with NO audit names established: scope `all`, empty list. */
const ALL_SCOPE_CONFIG = {
  ...AUDIT_CONFIG,
  toolProtection: { ...AUDIT_CONFIG.toolProtection, scope: "all", toolNames: [] },
};

/** The exact `Audit scope` option that switches to the exact-name subset. */
const SELECTED_SCOPE_OPTION = "Selected tool names — REDUCED coverage, only the listed exact names";

/** The tool rows of one non-TUI picker presentation, as `ui.select` labels. */
function auditLabels(options: readonly string[]): string[] {
  return options.filter((option) => /(✓ audited|✗ not audited)\s*$/.test(option));
}

/** The exempt infrastructure rows — never checked, never counted as audited. */
function exemptLabels(options: readonly string[]): string[] {
  return options.filter((option) => /· never audited — discovery loader/.test(option));
}

/** The loader row exactly as the picker renders it for an offered tool. */
const LOADER_ROW = "tool_search (Search the authorized tool catalog)  · never audited — discovery loader";

const auditedCount = (title: string): string => title.match(/— Enter toggles — (\d+) audited$/)?.[1] ?? "?";

/** The tool rows (not chrome) of one rendered picker frame. */
function toolRowsOf(frame: readonly string[], marker: "audited" | "denied"): string[] {
  const pattern = marker === "audited" ? /(✓ audited|✗ not audited)\s*$/ : /(✓ denied|✗ allowed)\s*$/;
  return frame
    .map((line) => stripAnsi(line))
    .filter((line) => pattern.test(line))
    .map((line) => line.replace(/^\s*(→\s*)?/, "").trim());
}

/** The tool NAMES shown by one rendered audit-picker frame, in order. Includes
 * the exempt infrastructure row, which reports neither ✓ nor ✗. */
function toolNamesOf(frame: readonly string[]): string[] {
  const toolRow = /(✓ audited|✗ not audited|· never audited — discovery loader)\s*$/;
  return frame
    .map((line) => stripAnsi(line))
    .filter((line) => toolRow.test(line.trim()))
    .map((line) => line.replace(/^\s*(→\s*)?/, "").trim().split(/\s/)[0]!);
}

/** The highlighted row of one rendered frame (the fake SelectList marks it). */
function highlightedOf(frame: readonly string[]): string | undefined {
  const line = frame.map((entry) => stripAnsi(entry)).find((entry) => /^\s*→/.test(entry));
  return line?.replace(/^\s*→\s*/, "").trim();
}

/** The query line rendered by the native Input ("> query"). */
function queryLineOf(frame: readonly string[]): string | undefined {
  return frame.map((line) => stripAnsi(line)).find((line) => line.startsWith("> ") || line === ">");
}

const names = (frame: readonly string[]): string => frame.map((line) => stripAnsi(line)).join("\n");

function commandHarness(): {
  pi: { registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }): void };
  handler: (args: string, ctx: unknown) => Promise<void>;
} {
  let handler: ((args: string, ctx: unknown) => unknown) | undefined;
  return {
    pi: { registerCommand(name, options) { if (name === "review-settings") handler = options.handler; } },
    handler: async (args, ctx) => {
      assert.ok(handler);
      await handler(args, ctx);
    },
  };
}

async function tempConfig(body: Record<string, unknown>): Promise<{
  dir: string;
  configPath: string;
  original: string;
  config: ReviewGateConfig;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-audit-names-"));
  const configPath = join(dir, "review-gate.json");
  const original = JSON.stringify(body);
  await writeFile(configPath, original, "utf8");
  return { dir, configPath, original, config: normalizeConfig(JSON.parse(original)) };
}

/**
 * Runs the registered /review-settings command over a scripted TUI harness that
 * fails boundedly, with a Ctrl+S-aware host and captured notices.
 */
async function runRegistered(
  configBody: Record<string, unknown>,
  steps: string[][],
  inventory: readonly { name: string; description?: string }[] = INVENTORY,
): Promise<{
  harness: TuiSettingsHarness;
  config: ReviewGateConfig;
  original: string;
  fileText: string;
  notices: Array<{ message: string; type?: string }>;
}> {
  const { dir, configPath, original, config } = await tempConfig(configBody);
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath, getToolChoices: () => inventory });
    const harness = createTuiSettingsContext(steps, { failUnresolvedSteps: true });
    const notices: Array<{ message: string; type?: string }> = [];
    setMenuTuiHost({ ...harness.host, matchesCtrlS: (data) => matchesKey(data, Key.ctrl("s")) });
    const base = harness.context as { ui: Record<string, unknown> };
    try {
      await registered.handler("", {
        ...(base as Record<string, unknown>),
        ui: { ...base.ui, notify: (message: string, type?: string) => notices.push({ message, type }) },
      });
    } finally {
      setMenuTuiHost(undefined);
    }
    assert.deepEqual(harness.failures(), [], "every scripted step must settle exactly its own menu");
    assert.equal(harness.exhausted(), false, "the scripted flow must not run out of steps");
    return { harness, config, original, fileText: await readFile(configPath, "utf8"), notices };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Root → Tools → Tool protection → Audited tool names. Every presentation
 * consumes exactly one scripted step, so each flow below counts the re-show of
 * the parent menu after a nested picker closes.
 */
const intoAuditPicker = [
  [...down(ROOT.tools), KEY_ENTER],                       // root → Tools
  [...down(TOOLS.toolProtection), KEY_ENTER],             // Tools → Tool protection
  [...down(PROTECTION.auditedNames), KEY_ENTER],          // protection → Audited tool names
];

// ---------------------------------------------------------------------------
// The inventory: the loader is auditable, and still never deniable
// ---------------------------------------------------------------------------

test("the loader-inclusive read is the audit picker's only inventory difference", () => {
  // The deny read is unchanged: the reserved loader is never a candidate.
  assert.deepEqual(readToolChoices(() => INVENTORY).map((choice) => choice.name),
    INVENTORY_NAMES.filter((name) => name !== "tool_search"));
  // The audit read keeps it when the runtime offers it, order preserved.
  assert.deepEqual(readToolChoices(() => INVENTORY, { includeReservedDiscoveryLoader: true }).map((choice) => choice.name), INVENTORY_NAMES);
  // A runtime that does not offer it yields the same list either way — nothing
  // is invented, and a malformed provider still yields no rows.
  const withoutLoader = INVENTORY.filter((choice) => choice.name !== "tool_search");
  assert.deepEqual(readToolChoices(() => withoutLoader, { includeReservedDiscoveryLoader: true }).map((choice) => choice.name),
    withoutLoader.map((choice) => choice.name));
  assert.deepEqual(readToolChoices(undefined, { includeReservedDiscoveryLoader: true }), []);
  assert.deepEqual(readToolChoices(() => { throw new Error("host failure"); }, { includeReservedDiscoveryLoader: true }), []);
});

test("the production runtime inventory shows the loader as exempt infrastructure and never offers it to a deny picker", async () => {
  // The real generator, not a synthetic callback: a live DeferredToolManager
  // supplies BOTH providers exactly as the extension registers them
  // (`toolDenyChoices()` for the deny selectors, `toolAuditChoices()` for the
  // audit subset). The saved audit list starts WITHOUT the loader, so the run
  // proves the picker cannot put it there and the deny lists never offer it.
  const definitions: Array<{ name: string; description?: string }> = [
    { name: "read", description: "Read file contents." },
    { name: "write", description: "Create or overwrite a file." },
  ];
  let active = definitions.map((tool) => tool.name);
  const host = {
    registerTool(definition: { name: string; description?: string }) {
      const index = definitions.findIndex((tool) => tool.name === definition.name);
      if (index >= 0) definitions.splice(index, 1, definition);
      else definitions.push(definition);
      if (!active.includes(definition.name)) active.push(definition.name);
    },
    getActiveTools: () => [...active],
    getAllTools: () => definitions.map((tool) => ({ ...tool })),
    setActiveTools: (names: string[]) => { active = [...names]; },
  };
  const manager = new DeferredToolManager(host, () => "execute", () => true, undefined, () => false);
  manager.register();
  manager.sessionStart({});
  const activeBefore = [...active];

  const { dir, configPath, config } = await tempConfig({
    ...AUDIT_CONFIG,
    toolProtection: { ...AUDIT_CONFIG.toolProtection, toolNames: ["read"] },
  });
  try {
    const registered = commandHarness();
    registerReviewSettings({
      pi: registered.pi,
      config,
      configPath,
      getToolChoices: () => manager.toolDenyChoices(),
      getAuditedToolChoices: () => manager.toolAuditChoices(),
    });
    let index = 0;
    let loaderRow = "";
    const script: Array<(title: string, options: string[]) => string | undefined> = [
      (_title, options) => options.find((option) => option.startsWith("Tools"))!,
      (_title, options) => options.find((option) => option.startsWith("Tool protection"))!,
      (_title, options) => options.find((option) => option.startsWith("Audited tool names"))!,
      (title, options) => {
        // The live runtime inventory offers the loader as an explicit exempt
        // infrastructure row — not checked, not counted, and not a retained
        // unavailable row.
        assert.match(title, /^Audited tool names .*— Enter toggles — 1 audited$/);
        loaderRow = options.find((option) => option.startsWith("tool_search ")) ?? "";
        assert.ok(loaderRow.endsWith("· never audited — discovery loader"), options.join(" | "));
        assert.ok(!loaderRow.includes("not currently available"), loaderRow);
        assert.doesNotMatch(loaderRow, /✓|✗/, loaderRow);
        assert.ok(options.some((option) => option.startsWith("read ") && option.includes("✓ audited")), options.join(" | "));
        return loaderRow;
      },
      (title, options) => {
        // Enter on the exempt row changes nothing: it cannot be audited.
        assert.ok(title.endsWith("— Enter toggles — 1 audited"), title);
        assert.ok(options.some((option) => option.startsWith("tool_search ") && option.endsWith("· never audited — discovery loader")), options.join(" | "));
        return "Back";
      },
      () => "Back",
      (_title, options) => options.find((option) => option.startsWith("Top-level tools"))!,
      (title, options) => {
        assert.match(title, /^Top-level tools — Enter toggles — 0 denied$/);
        assert.ok(!options.some((option) => option.startsWith("tool_search")), options.join(" | "));
        assert.ok(options.some((option) => option.startsWith("read ")), options.join(" | "));
        return "Back";
      },
      (_title, options) => options.find((option) => option.startsWith("Executor tools"))!,
      (title, options) => {
        assert.match(title, /^Executor tools — Enter toggles — 0 denied$/);
        assert.ok(!options.some((option) => option.startsWith("tool_search")), options.join(" | "));
        return "Back";
      },
      () => "Back",
      () => "Save changes",
    ];
    const ui = {
      async select(title: string, options: string[]): Promise<string | undefined> {
        const step = script[Math.min(index, script.length - 1)]!;
        index += 1;
        const value = step(title, options);
        assert.ok(value !== undefined && options.includes(value), `scripted selection not offered (${title}): ${value}`);
        return value;
      },
      notify() {},
    };
    await registered.handler("", { scopedModels: [], ui });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    // The exempt name was never staged, and the unrelated saved name survived.
    assert.deepEqual(saved.toolProtection.toolNames, ["read"]);
    assert.deepEqual(config.toolProtection?.toolNames, ["read"]);
    // Reading both inventories is display-only: the manager's active set is
    // exactly what it was before the menu opened.
    assert.deepEqual(active, activeBefore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the audit picker offers the reserved loader while both deny pickers never do", async () => {
  const { dir, configPath, original, config } = await tempConfig(AUDIT_CONFIG);
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath, getToolChoices: () => INVENTORY });
    let index = 0;
    const script: Array<(title: string, options: string[]) => string | undefined> = [
      (_title, options) => options.find((option) => option.startsWith("Tools"))!,
      (_title, options) => options.find((option) => option.startsWith("Tool protection"))!,
      (_title, options) => options.find((option) => option.startsWith("Audited tool names"))!,
      (title, options) => {
        assert.match(title, /^Audited tool names .*— Enter toggles — 2 audited$/);
        // The loader is an explicit never-audited infrastructure row here …
        assert.ok(options.includes(LOADER_ROW), options.join(" | "));
        // … while the retained unavailable name and the stored name are checked.
        assert.ok(options.some((option) => option === `${GHOST_TOOL} [not currently available]  ✓ audited`), options.join(" | "));
        assert.ok(options.some((option) => option === "read (Read files)  ✓ audited"), options.join(" | "));
        return "Back";
      },
      () => "Back",
      (_title, options) => options.find((option) => option.startsWith("Top-level tools"))!,
      (title, options) => {
        // The same inventory through the DENY selector still has no loader row.
        assert.match(title, /^Top-level tools — Enter toggles — 0 denied$/);
        assert.ok(!options.some((option) => option.startsWith("tool_search")), options.join(" | "));
        assert.deepEqual(options.map((option) => option.split(/\s/)[0]),
          [...INVENTORY_NAMES.filter((name) => name !== "tool_search"), "Back"]);
        return "Back";
      },
      (_title, options) => options.find((option) => option.startsWith("Executor tools"))!,
      (title, options) => {
        assert.match(title, /^Executor tools — Enter toggles — 0 denied$/);
        assert.ok(!options.some((option) => option.startsWith("tool_search")), options.join(" | "));
        return "Back";
      },
      () => "Back",
      () => "Cancel",
    ];
    const ui = {
      async select(title: string, options: string[]): Promise<string | undefined> {
        const step = script[Math.min(index, script.length - 1)]!;
        index += 1;
        const value = step(title, options);
        assert.ok(value !== undefined && options.includes(value), `scripted selection not offered (${title}): ${value}`);
        return value;
      },
      notify() {},
    };
    await registered.handler("", { scopedModels: [], ui });
    assert.equal(await readFile(configPath, "utf8"), original, "Cancel writes nothing");
    assert.deepEqual(config.toolProtection?.toolNames, [GHOST_TOOL, "read"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The searchable interaction (real TUI picker)
// ---------------------------------------------------------------------------

test("the audit picker searches by name, keeps a hidden audited name, and saves the complete subset", { timeout: TEST_TIMEOUT_MS }, async () => {
  const run = await runRegistered(AUDIT_CONFIG, [
    ...intoAuditPicker,                                   // 0-2 open the picker
    [...typed("web_fetch"), KEY_ENTER],                   // 3 narrow, toggle web_fetch on
    [KEY_ESCAPE],                                         // 4 leave the picker
    [KEY_ENTER],                                          // 5 protection → picker again (fresh query)
    [...typed("qzx"), KEY_DOWN, KEY_ENTER],               // 6 truthful no-match state, Back leaves
    [KEY_ESCAPE],                                         // 7 protection → Tools
    [KEY_ESCAPE],                                         // 8 Tools → root
    [...down(ROOT.save - ROOT.tools), KEY_ENTER],         // 9 Save
  ]);
  const steps = run.harness.framesByStep;

  // Presentation 1: every offered tool (loader included) plus the retained
  // unavailable name, with the stored audit names checked and no query.
  const opened = steps[3]![0]!;
  assert.ok(names(opened).includes("Audited tool names (tools outside the list are NOT AUDITED) — Enter toggles — 2 audited"));
  assert.equal(queryLineOf(opened)?.trim(), ">");
  assert.deepEqual(toolNamesOf(opened), [...INVENTORY_NAMES, GHOST_TOOL]);
  assert.ok(toolRowsOf(opened, "audited").includes("read (Read files)  ✓ audited"));
  assert.ok(toolRowsOf(opened, "audited").includes(`${GHOST_TOOL} [not currently available]  ✓ audited`));
  // The offered loader is neither checked nor unchecked: it states the
  // infrastructure exemption instead of an audit state.
  assert.ok(names(opened).includes("· never audited — discovery loader"), names(opened));
  assert.ok(!/tool_search[^\n]*[✓✗]/.test(names(opened)), names(opened));

  // Typing narrows by NAME only; Enter toggles the highlighted row and the
  // re-show keeps the query and the toggled row's identity, now checked.
  const narrowed = steps[3]!.at(-2)!;
  assert.equal(queryLineOf(narrowed)?.trim(), "> web_fetch");
  assert.deepEqual(toolNamesOf(narrowed), ["web_fetch"]);
  const reshown = steps[4]![0]!;
  assert.equal(queryLineOf(reshown)?.trim(), "> web_fetch");
  assert.deepEqual(toolNamesOf(reshown), ["web_fetch"]);
  assert.equal(highlightedOf(reshown), "web_fetch (Fetch a page)  ✓ audited");
  assert.ok(names(reshown).includes("— Enter toggles — 3 audited"));
  // The parent row reports the new names while the scope row keeps the
  // reduced-coverage warning.
  assert.ok(names(steps[5]![0]!).includes("Audited tool names"));
  assert.ok(names(steps[5]![0]!).includes("GhostTool, read, web_fetch"));
  assert.ok(names(steps[5]![0]!).includes("Selected tool names · 3 named · REDUCED COVERAGE"));
  // Re-entry starts a fresh query with every audited name visible again.
  const reentered = steps[6]![0]!;
  assert.equal(queryLineOf(reentered)?.trim(), ">");
  assert.deepEqual(toolNamesOf(reentered), [...INVENTORY_NAMES, GHOST_TOOL]);
  assert.ok(toolRowsOf(reentered, "audited").includes("read (Read files)  ✓ audited"), "the name hidden by the earlier query stayed audited");
  assert.ok(toolRowsOf(reentered, "audited").includes("web_fetch (Fetch a page)  ✓ audited"));

  // A query that matches nothing is truthful, and Back stays reachable.
  const noMatch = steps[6]!.at(-2)!;
  assert.ok(names(noMatch).includes("No matching tools"));
  assert.deepEqual(toolNamesOf(noMatch), []);
  assert.equal(highlightedOf(noMatch), "Back");

  // The COMPLETE subset is saved: the hidden stored name survived every query,
  // the toggle landed, the unavailable name stayed audited, and no query was
  // persisted anywhere.
  const saved = JSON.parse(run.fileText);
  assert.deepEqual(saved.toolProtection.toolNames, [GHOST_TOOL, "read", "web_fetch"]);
  assert.deepEqual(run.config.toolProtection?.toolNames, [GHOST_TOOL, "read", "web_fetch"]);
  assert.ok(!run.fileText.includes("qzx"), "the query is never persisted");
  assert.ok(run.notices.some((notice) => notice.message === "Review settings saved."));
});

test("an unavailable saved audit name stays a reversible row across toggles and Back/re-entry", { timeout: TEST_TIMEOUT_MS }, async () => {
  const run = await runRegistered(AUDIT_CONFIG, [
    ...intoAuditPicker,                                   // 0-2
    [...typed("ghost"), KEY_ENTER],                       // 3 find the ghost row, uncheck it
    [KEY_ESCAPE],                                         // 4 leave the picker
    [KEY_ENTER],                                          // 5 protection → picker again
    [...typed("ghost"), KEY_ENTER],                       // 6 find it again (still unchecked), recheck
    [KEY_ESCAPE],                                         // 7 leave the picker
    [KEY_ESCAPE],                                         // 8 protection → Tools
    [KEY_ESCAPE],                                         // 9 Tools → root
    [...down(ROOT.cancel - ROOT.tools), KEY_ENTER],       // Cancel
  ]);
  const steps = run.harness.framesByStep;
  // Narrowed to the ghost row, checked before the toggle reverses it.
  assert.deepEqual(toolRowsOf(steps[3]!.at(-2)!, "audited"), [`${GHOST_TOOL} [not currently available]  ✓ audited`]);
  // The reversed row does not disappear: it stays a configured, unchecked,
  // highlighted row with its query retained.
  const unchecked = steps[4]![0]!;
  assert.deepEqual(toolRowsOf(unchecked, "audited"), [`${GHOST_TOOL} [not currently available]  ✗ not audited`]);
  assert.equal(highlightedOf(unchecked), `${GHOST_TOOL} [not currently available]  ✗ not audited`);
  assert.ok(names(unchecked).includes("— Enter toggles — 1 audited"));
  // Re-entering the picker keeps it as a row too (fresh query, unchecked), and it
  // is findable by name and reversible again.
  assert.ok(toolRowsOf(steps[6]![0]!, "audited").includes(`${GHOST_TOOL} [not currently available]  ✗ not audited`));
  assert.deepEqual(toolRowsOf(steps[6]!.at(-2)!, "audited"), [`${GHOST_TOOL} [not currently available]  ✗ not audited`]);
  assert.ok(toolRowsOf(steps[7]![0]!, "audited").includes(`${GHOST_TOOL} [not currently available]  ✓ audited`));
  // Cancel discards the whole flow: the stored subset is untouched on disk and
  // in the live config.
  assert.equal(run.fileText, run.original);
  assert.deepEqual(run.config.toolProtection?.toolNames, [GHOST_TOOL, "read"]);
});

test("root Escape applies the complete audit subset for the session without writing", { timeout: TEST_TIMEOUT_MS }, async () => {
  const run = await runRegistered(AUDIT_CONFIG, [
    ...intoAuditPicker,                                   // 0-2
    [...typed("write"), KEY_ENTER],                       // 3 toggle `write` inside a narrowed view
    [KEY_ESCAPE],                                         // 4 leave the picker
    [KEY_ESCAPE],                                         // 5 protection → Tools
    [KEY_ESCAPE],                                         // 6 Tools → root
    [KEY_ESCAPE],                                         // 7 root Escape (session apply)
  ]);
  assert.deepEqual(run.config.toolProtection?.toolNames, [GHOST_TOOL, "read", "write"]);
  assert.equal(run.fileText, run.original, "a session apply never writes the config file");
});

test("Ctrl+S inside a narrowed audit picker saves the whole draft", { timeout: TEST_TIMEOUT_MS }, async () => {
  const run = await runRegistered(AUDIT_CONFIG, [
    ...intoAuditPicker,                                   // 0-2
    [...typed("bash"), KEY_ENTER],                        // 3 toggle bash
    [CTRL_S],                                             // 4 save from inside the narrowed picker
  ]);
  const saved = JSON.parse(run.fileText);
  assert.deepEqual(saved.toolProtection.toolNames, [GHOST_TOOL, "read", "bash"]);
  assert.ok(run.notices.some((notice) => notice.message === "Review settings saved."));
});

// ---------------------------------------------------------------------------
// Reduced coverage starts CHECKED (issue #536)
// ---------------------------------------------------------------------------

/**
 * Scripted non-TUI run: one script entry per menu presentation, so a flow that
 * gains or loses a presentation fails loudly instead of silently reusing one.
 */
async function runScripted(
  configBody: Record<string, unknown>,
  script: Array<(title: string, options: string[]) => string | undefined>,
  inventory: readonly { name: string; description?: string }[] = INVENTORY,
): Promise<{ config: ReviewGateConfig; original: string; fileText: string; notices: Array<{ message: string; type?: string }> }> {
  const { dir, configPath, original, config } = await tempConfig(configBody);
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath, getToolChoices: () => inventory });
    const notices: Array<{ message: string; type?: string }> = [];
    let index = 0;
    const ui = {
      async select(title: string, options: string[]): Promise<string | undefined> {
        assert.ok(index < script.length, `the scripted flow ran past its ${script.length} presentations (${title})`);
        const step = script[index]!;
        index += 1;
        const value = step(title, options);
        assert.ok(value !== undefined && options.includes(value), `scripted selection not offered (${title}): ${value}`);
        return value;
      },
      notify: (message: string, type?: string) => { notices.push({ message, type }); },
    };
    await registered.handler("", { scopedModels: [], ui });
    assert.equal(index, script.length, "every scripted presentation is used exactly once");
    return { config, original, fileText: await readFile(configPath, "utf8"), notices };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The shared opening: root → Tools → Tool protection → Audit scope → Selected. */
function intoSelectedScope(): Array<(title: string, options: string[]) => string | undefined> {
  return [
    (_title, options) => options.find((option) => option.startsWith("Tools"))!,
    (_title, options) => options.find((option) => option.startsWith("Tool protection"))!,
    (_title, options) => options.find((option) => option.startsWith("Audit scope"))!,
    (title, options) => {
      assert.match(title, /^Audit scope$/);
      assert.ok(options.includes(SELECTED_SCOPE_OPTION), options.join(" | "));
      return SELECTED_SCOPE_OPTION;
    },
  ];
}

const openAuditedNames = (title: string, options: string[]): string => {
  assert.match(title, /^Tool protection/);
  return options.find((option) => option.startsWith("Audited tool names"))!;
};
const leaveToTools = (): string => "Back";
const leaveToRoot = (): string => "Back";

test("the seeded subset is the offered auditable names, deduped, and never the exempt loader", () => {
  // Every offered auditable name once, in offered order — the reserved loader is
  // exempt, so it is never seeded as if it were audited.
  assert.deepEqual(initialAuditedToolNames(INVENTORY), AUDITABLE_NAMES);
  // A runtime that does not offer the loader seeds the same auditable names.
  assert.deepEqual(initialAuditedToolNames(INVENTORY.filter((choice) => choice.name !== "tool_search")), AUDITABLE_NAMES);
  // Duplicates collapse, an empty name is never a name, and an unavailable
  // inventory seeds nothing rather than falling back to anything.
  assert.deepEqual(initialAuditedToolNames([{ name: "bash" }, { name: "bash" }, { name: "" }, { name: "read" }]), ["bash", "read"]);
  assert.deepEqual(initialAuditedToolNames([]), []);
  // A loader-only inventory leaves nothing to seed: the empty-invalid path stays
  // honest instead of fabricating a name or widening to All calls.
  assert.deepEqual(initialAuditedToolNames(INVENTORY.filter((choice) => choice.name === "tool_search")), []);
});

test("entering Selected checks every currently available tool so the user unchecks exemptions", async () => {
  const purpose = (name: string): string => INVENTORY.find((choice) => choice.name === name)!.description.replace(/[.!?]+$/, "");
  const run = await runScripted(ALL_SCOPE_CONFIG, [
    ...intoSelectedScope(),                               // 0-3
    openAuditedNames,                                     // 4 protection → picker
    (title, options) => {                                 // 5 the picker itself
      assert.equal(auditedCount(title), String(AUDITABLE_NAMES.length), title);
      // Every offered auditable name is a row, each checked exactly once.
      assert.deepEqual(auditLabels(options), AUDITABLE_NAMES.map((name) => `${name} (${purpose(name)})  ✓ audited`));
      // The reserved loader is an explicit never-audited infrastructure row, so
      // an all-checked start never implies that it was audited.
      assert.deepEqual(exemptLabels(options), [LOADER_ROW]);
      assert.ok(!options.some((option) => option.startsWith("tool_search") && /[✓✗]/.test(option)), options.join(" | "));
      return "Back";
    },
    leaveToTools,                                         // 6 protection → Tools
    leaveToRoot,                                          // 7 Tools → root
    () => "Cancel",                                       // 8
  ]);
  // The parent rows report the seeded subset while nothing was applied.
  assert.equal(run.fileText, run.original, "Cancel writes nothing");
  assert.equal(run.config.toolProtection?.scope, "all");
  assert.deepEqual(run.config.toolProtection?.toolNames, []);
  // The reduced-coverage warning and the all-checked notice both said so.
  assert.ok(run.notices.some((notice) => notice.type === "warning" && notice.message.includes("deliberately REDUCED coverage")), JSON.stringify(run.notices));
  assert.ok(run.notices.some((notice) => notice.message.includes(`All ${AUDITABLE_NAMES.length} currently available auditable tool name(s) are checked to start (${AUDITABLE_NAMES.join(", ")})`)
    && notice.message.includes("uncheck the tools you want NOT audited")), JSON.stringify(run.notices));
  // The notice names the one offered tool that is deliberately absent, so the
  // omission is explained rather than looked like an oversight.
  assert.ok(run.notices.some((notice) => notice.message.includes("tool_search is not in the list because this gate never audits the tool-discovery loader")), JSON.stringify(run.notices));
});

test("an unchecked exemption survives Back and reopening and is never re-checked", async () => {
  const kept = AUDITABLE_NAMES.filter((name) => name !== "bash");
  const run = await runScripted(ALL_SCOPE_CONFIG, [
    ...intoSelectedScope(),                               // 0-3
    openAuditedNames,                                     // 4 protection → picker
    (title, options) => {                                 // 5 uncheck bash (its CURRENT checked label)
      assert.equal(auditedCount(title), String(AUDITABLE_NAMES.length), title);
      return "bash (Run shell commands)  ✓ audited";
    },
    (title, options) => {                                 // 6 re-shown, unchecked
      assert.equal(auditedCount(title), String(kept.length), title);
      assert.ok(options.includes("bash (Run shell commands)  ✗ not audited"), options.join(" | "));
      return "Back";
    },
    openAuditedNames,                                     // 7 reopen the SAME picker
    (title, options) => {                                 // 8 the seed did not re-run
      assert.equal(auditedCount(title), String(kept.length), title);
      assert.ok(options.includes("bash (Run shell commands)  ✗ not audited"), options.join(" | "));
      assert.equal(auditLabels(options).filter((row) => row.endsWith("✓ audited")).length, kept.length, options.join(" | "));
      return "Back";
    },
    leaveToTools,                                         // 9 protection → Tools
    leaveToRoot,                                          // 10 Tools → root
    () => "Save changes",                                 // 11
  ]);
  const saved = JSON.parse(run.fileText);
  assert.equal(saved.toolProtection.scope, "selected");
  assert.deepEqual(saved.toolProtection.toolNames, kept);
  assert.deepEqual(run.config.toolProtection?.toolNames, kept);
});

test("an existing nonempty audit subset is never overwritten by the initial all-checked seed", async () => {
  // A saved subset that happens to sit under scope `all` is still an
  // established list: entering Selected keeps it instead of checking the rest.
  const run = await runScripted({
    ...ALL_SCOPE_CONFIG,
    toolProtection: { ...ALL_SCOPE_CONFIG.toolProtection, toolNames: ["read", "bash"] },
  }, [
    ...intoSelectedScope(),                               // 0-3
    (title, options) => {                                 // 4 protection, unchanged
      assert.match(title, /^Tool protection/);
      assert.ok(options.some((option) => option.includes("Selected tool names · 2 named · REDUCED COVERAGE")), options.join(" | "));
      assert.ok(options.some((option) => option.includes("read, bash")), options.join(" | "));
      return options.find((option) => option.startsWith("Audited tool names"))!;
    },
    (title, options) => {                                 // 5 only the saved names are checked
      assert.equal(auditedCount(title), "2", title);
      assert.deepEqual(auditLabels(options).filter((row) => row.endsWith("✓ audited")),
        ["bash (Run shell commands)  ✓ audited", "read (Read files)  ✓ audited"]);
      assert.equal(auditLabels(options).filter((row) => row.endsWith("✗ not audited")).length, AUDITABLE_NAMES.length - 2, options.join(" | "));
      return "Back";
    },
    leaveToTools,                                         // 6 protection → Tools
    leaveToRoot,                                          // 7 Tools → root
    () => "Cancel",                                       // 8
  ]);
  assert.equal(run.fileText, run.original, "Cancel writes nothing");
  assert.deepEqual(run.config.toolProtection?.toolNames, ["read", "bash"]);
  assert.ok(!run.notices.some((notice) => notice.message.includes("checked to start")), JSON.stringify(run.notices));
});

test("with no available tool names Selected stays empty-invalid and nothing is invented", async () => {
  const run = await runScripted(ALL_SCOPE_CONFIG, [
    ...intoSelectedScope(),                               // 0-3
    (title, options) => {                                 // 4 the empty list is said, not filled
      assert.match(title, /^Tool protection/);
      assert.ok(options.some((option) => option.includes("Selected tool names · 0 named · REDUCED COVERAGE")), options.join(" | "));
      assert.ok(options.some((option) => option.includes("none — at least one exact name required")), options.join(" | "));
      return options.find((option) => option.startsWith("Audited tool names"))!;
    },
    (title, options) => {                                 // 5 an honest empty picker
      assert.equal(auditedCount(title), "0", title);
      assert.deepEqual(auditLabels(options), []);
      assert.ok(options.includes("Back"), options.join(" | "));
      return "Back";
    },
    leaveToTools,                                         // 6 protection → Tools
    leaveToRoot,                                          // 7 Tools → root
    () => "Cancel",                                       // 8
  ], []);
  // The existing empty-invalid path is intact: a warning at the scope change and
  // the picker refusing to stage an empty subset.
  assert.ok(run.notices.some((notice) => notice.type === "warning" && notice.message === "No tool named yet: at least one exact tool name is required before this can be applied or saved."), JSON.stringify(run.notices));
  assert.ok(run.notices.some((notice) => notice.type === "error" && notice.message.includes("requires at least one exact tool name")
    && notice.message.includes("so nothing changed")), JSON.stringify(run.notices));
  // No fabricated name, no all-checked notice, and no fallback to All calls/Off.
  assert.ok(!run.notices.some((notice) => notice.message.includes("checked to start")), JSON.stringify(run.notices));
  assert.equal(run.fileText, run.original);
  assert.equal(run.config.toolProtection?.scope, "all");
  assert.deepEqual(run.config.toolProtection?.toolNames, []);
});

test("the audit picker and the deny picker never share a query", { timeout: TEST_TIMEOUT_MS }, async () => {
  const run = await runRegistered(AUDIT_CONFIG, [
    [...down(ROOT.tools), KEY_ENTER],                     // 0 root → Tools
    [KEY_ENTER],                                          // 1 Tools → Top-level tools
    [...typed("bash"), KEY_ENTER],                        // 2 deny bash
    [KEY_ESCAPE],                                         // 3 leave → Tools (Top-level still highlighted)
    [...down(TOOLS.toolProtection), KEY_ENTER],           // 4 Tools → Tool protection
    [...down(PROTECTION.auditedNames), KEY_ENTER],        // 5 protection → Audited tool names
    [KEY_ESCAPE],                                         // 6 leave → protection
    [KEY_ESCAPE],                                         // 7 protection → Tools
    [...down(2), KEY_ENTER],                              // 8 Tools → Top-level tools again
    [KEY_ESCAPE],                                         // 9 leave → Tools
    [...down(TOOLS.toolProtection), KEY_ENTER],           // 10 Tools → Tool protection (a fresh submenu)
    [...down(PROTECTION.auditedNames), KEY_ENTER],        // 11 protection → Audited tool names
    [KEY_ESCAPE],                                         // 12 leave → protection
    [KEY_ESCAPE],                                         // 13 protection → Tools
    [KEY_ESCAPE],                                         // 14 Tools → root
    [...down(ROOT.save - ROOT.tools), KEY_ENTER],         // 15 Save
  ]);
  const steps = run.harness.framesByStep;
  assert.equal(queryLineOf(steps[2]![0]!)?.trim(), ">", "the deny picker opens with an empty query");
  assert.ok(names(steps[2]![0]!).includes("Top-level tools — Enter toggles — 0 denied"));
  assert.equal(queryLineOf(steps[6]![0]!)?.trim(), ">", "the audit picker never inherits the deny query");
  assert.ok(names(steps[6]![0]!).includes("Audited tool names"));
  // Re-entering either picker starts a fresh query as well.
  assert.equal(queryLineOf(steps[9]![0]!)?.trim(), ">");
  assert.equal(queryLineOf(steps[12]![0]!)?.trim(), ">");
  const saved = JSON.parse(run.fileText);
  assert.deepEqual(saved.tools, { topLevelDeny: ["bash"], executorDeny: [] });
  assert.deepEqual(saved.toolProtection.toolNames, [GHOST_TOOL, "read"]);
});
