/**
 * Issue #434: exact-name top-level/executor tool denials and the Tools
 * settings subsection.
 *
 * Production coverage for the canonical configuration contract
 * (`ReviewGateConfig.tools`), its strict validation and startup recovery, the
 * shared staged-selection persistence/session-delta pipeline, and the UI
 * slice: one root Tools subsection that owns the two independent deny
 * multi-selectors (checked = strictly denied) plus the moved Deferred Pi
 * tools, YouShouldKnow notices, Completion guidance, and Web/browser
 * subtree — all staged into the existing Save / Ctrl+S / root-Escape /
 * Cancel transaction. No test here enables, activates, or authorizes a tool:
 * the candidate inventory is display-only.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Key, matchesKey } from "pi-session-host-tui";
import { normalizeConfig, recoverConfig, type ReviewGateConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { persistReviewSettings } from "../src/settings/persistence";
import { getPendingSessionDelta } from "../src/settings/session-delta";
import { setMenuTuiHost } from "../src/settings/menu";
import { readToolChoices } from "../src/settings/tools";
import { createTuiSettingsContext, KEY_DOWN, KEY_ENTER, type TuiSettingsHarness } from "./menu-tui-fakes";

const CTRL_S = "\x13";
const down = (count: number): string[] => Array.from({ length: count }, () => KEY_DOWN);

/** Root row index of the Tools subsection (after Subtask notifications). */
const ROOT_TOOLS = 13;
/** Tools submenu row indices. */
const TOOLS = { topLevel: 0, executor: 1, deferred: 2, notices: 3, guidance: 4, web: 5, back: 6 } as const;

async function tempConfig(body: Record<string, unknown>): Promise<{ dir: string; configPath: string; original: string; config: ReviewGateConfig }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-tools-"));
  const configPath = join(dir, "review-gate.json");
  const original = JSON.stringify(body);
  await writeFile(configPath, original, "utf8");
  return { dir, configPath, original, config: normalizeConfig(JSON.parse(original)) };
}

function commandHarness(): { pi: { registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }): void }; handler: (args: string, ctx: unknown) => Promise<void> } {
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

interface SelectCall {
  title: string;
  options: string[];
}

/**
 * Plain-select scripted context (the RPC/fallback host). Each script step sees
 * the live title and options and returns the exact option string to pick (or
 * undefined to cancel); every returned value must be one of the offered
 * options. Records the calls for label assertions.
 */
function scriptedContext(
  script: Array<(title: string, options: string[]) => string | undefined>,
  scopedModels: unknown[] = [],
): { context: unknown; calls: SelectCall[] } {
  let index = 0;
  const calls: SelectCall[] = [];
  const context = {
    scopedModels,
    ui: {
      async select(title: string, options: string[]): Promise<string | undefined> {
        calls.push({ title, options });
        const step = script[Math.min(index, script.length - 1)];
        index += 1;
        const value = step?.(title, options);
        if (value !== undefined) assert.ok(options.includes(value), `scripted selection not offered (${title}): ${value}`);
        return value;
      },
      notify() {},
    },
  };
  return { context, calls };
}

const pickPrefix = (prefix: string) => (_title: string, options: string[]) => {
  const value = options.find((option) => option.startsWith(prefix));
  assert.ok(value !== undefined, `no option starts with ${prefix}: ${options.join(" | ")}`);
  return value;
};

// ---------------------------------------------------------------------------
// Canonical configuration: strict validation, defaults, recovery
// ---------------------------------------------------------------------------

test("tools normalizes exact-name deny arrays with empty defaults and a canonical set", () => {
  assert.equal(normalizeConfig({}).tools, undefined, "an old config keeps no tools field");
  assert.deepEqual(normalizeConfig({ tools: {} }).tools, { topLevelDeny: [], executorDeny: [] });
  assert.deepEqual(
    normalizeConfig({ tools: { topLevelDeny: ["read", "bash"], executorDeny: ["ShellStart"] } }).tools,
    { topLevelDeny: ["read", "bash"], executorDeny: ["ShellStart"] },
  );
  // Exact names are preserved verbatim, order is preserved, duplicates collapse
  // to their first occurrence: the canonical array is a deterministic set.
  assert.deepEqual(
    normalizeConfig({ tools: { topLevelDeny: ["WebFetch", "read", "WebFetch"] } }).tools,
    { topLevelDeny: ["WebFetch", "read"], executorDeny: [] },
  );
  // The two lists stay independent: nothing cascades between them.
  const config = normalizeConfig({ tools: { topLevelDeny: ["read"], executorDeny: [] } });
  assert.deepEqual(config.tools!.topLevelDeny, ["read"]);
  assert.deepEqual(config.tools!.executorDeny, []);
});

test("tools strict validation rejects non-array, non-string, empty, and padded names", () => {
  for (const tools of [
    { topLevelDeny: "read" },
    { executorDeny: { read: true } },
    { topLevelDeny: ["read", 7] },
    { topLevelDeny: [""] },
    { topLevelDeny: [" read"] },
    { executorDeny: ["read "] },
  ]) {
    assert.throws(() => normalizeConfig({ tools }), /tools\.(topLevelDeny|executorDeny)/, JSON.stringify(tools));
  }
  assert.throws(() => normalizeConfig({ tools: 5 }), /tools must be an object/);
});

test("startup recovery drops only the malformed deny list and keeps valid entries and unrelated JSON", () => {
  const { config, warnings } = recoverConfig({
    tools: { topLevelDeny: "read", executorDeny: ["bash", 7] },
    customFutureKey: { keep: true },
  });
  assert.deepEqual(config.tools, { topLevelDeny: [], executorDeny: ["bash"] });
  assert.ok(warnings!.some((warning) => warning.includes("tools.topLevelDeny")), JSON.stringify(warnings));
  assert.ok(warnings!.some((warning) => warning.includes("tools.executorDeny[1]")), JSON.stringify(warnings));

  // A wholly malformed tools field (and a non-object tools value) recovers to
  // the canonical default instead of rejecting the whole config.
  assert.deepEqual(recoverConfig({ tools: { topLevelDeny: { nope: true } } }).config.tools, { topLevelDeny: [], executorDeny: [] });
  assert.equal(recoverConfig({ tools: 5 }).config.tools, undefined);
  assert.ok(recoverConfig({ tools: 5 }).warnings!.some((warning) => warning.includes("tools")));
});

test("strict validation rejects the required discovery loader in either deny list (#434 follow-up)", () => {
  for (const tools of [
    { topLevelDeny: ["tool_search"] },
    { executorDeny: ["tool_search"] },
    { topLevelDeny: ["read", "tool_search"] },
    { executorDeny: ["bash", "tool_search", "WebFetch"] },
  ]) {
    assert.throws(
      () => normalizeConfig({ tools }),
      (error: unknown) => error instanceof Error
        && /required discovery loader cannot be denied/.test(error.message)
        && /tools\.(topLevelDeny|executorDeny)\[/.test(error.message),
      JSON.stringify(tools),
    );
  }
  // The reserved name is the only rejection: other exact-name denials, including
  // currently unavailable names, keep validating in either independent list.
  assert.deepEqual(
    normalizeConfig({ tools: { topLevelDeny: ["read", "GhostTool"], executorDeny: ["ShellStart"] } }).tools,
    { topLevelDeny: ["read", "GhostTool"], executorDeny: ["ShellStart"] },
  );
});

test("startup recovery drops the reserved loader and keeps valid entries and unrelated JSON (#434 follow-up)", () => {
  const { config, warnings } = recoverConfig({
    tools: { topLevelDeny: ["read", "tool_search", "bash"], executorDeny: ["tool_search", "WebFetch"] },
    customFutureKey: { keep: true },
  });
  assert.deepEqual(config.tools, { topLevelDeny: ["read", "bash"], executorDeny: ["WebFetch"] });
  assert.ok(warnings!.some((warning) => warning.includes("tools.topLevelDeny[1]")), JSON.stringify(warnings));
  assert.ok(warnings!.some((warning) => warning.includes("tools.executorDeny[0]")), JSON.stringify(warnings));
  // The recovered config is canonical and re-normalizes without the loader.
  assert.deepEqual(normalizeConfig(config).tools, { topLevelDeny: ["read", "bash"], executorDeny: ["WebFetch"] });
});

test("readToolChoices keeps only exact non-empty unique names and never invents an inventory", () => {
  assert.deepEqual(readToolChoices(undefined), []);
  assert.deepEqual(readToolChoices(() => { throw new Error("host failure"); }), []);
  assert.deepEqual(readToolChoices((() => "nope") as never), []);
  assert.deepEqual(
    readToolChoices(() => [
      { name: "read", description: "Read files." },
      { name: "read" },
      { name: "" },
      { name: "bash " },
      { name: "bash", description: "Run shell commands." },
    ]),
    [
      { name: "read", description: "Read files." },
      { name: "bash", description: "Run shell commands." },
    ],
  );
});

test("readToolChoices never offers the required discovery loader even when a provider supplies it (#434 follow-up)", () => {
  assert.deepEqual(
    readToolChoices(() => [
      { name: "read", description: "Read files." },
      { name: "tool_search", description: "Search tools." },
      { name: "bash", description: "Run shell commands." },
      { name: "tool_search" },
    ]),
    [
      { name: "read", description: "Read files." },
      { name: "bash", description: "Run shell commands." },
    ],
  );
});

// ---------------------------------------------------------------------------
// Shared persistence: staged deny arrays through the existing save pipeline
// ---------------------------------------------------------------------------

const baseSelection = {
  operatingMode: "execute" as const,
  modeCycleShortcut: "alt+m",
  workerResources: {},
  primaryReviewers: [],
  subtaskReviewers: [],
  primaryEnabled: false,
  subtaskEnabled: false,
  reviewLandedChanges: false,
  reviewerTimeoutMs: 600_000,
  executorTimeoutMs: 1_800_000,
  maxCorrectionCycles: 1,
  implementationGuidanceAfterCorrectionAttempts: 1,
  retainBundles: "on-failure" as const,
  maxWorkers: 2,
  retryPolicy: { maxRetries: 2, baseDelayMs: 1_000, maxDelayMs: 30_000, maxSameIncidentRepeats: 2, jitter: false },
  subtaskNotifications: "quiet" as const,
  subtasksViewExpanded: false,
};

test("persistReviewSettings writes both exact deny lists and preserves unrelated JSON", async () => {
  const { dir, configPath } = await tempConfig({ enabled: false, review: { activeReviewers: [] }, customFutureKey: { keep: true } });
  try {
    const config = await persistReviewSettings(configPath, {
      ...baseSelection,
      tools: { topLevelDeny: ["WebSearch"], executorDeny: ["ShellStart", "BrowserOpen"] },
    });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.tools, { topLevelDeny: ["WebSearch"], executorDeny: ["ShellStart", "BrowserOpen"] });
    assert.deepEqual(config.tools, { topLevelDeny: ["WebSearch"], executorDeny: ["ShellStart", "BrowserOpen"] });
    assert.deepEqual(saved.customFutureKey, { keep: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a strict config write rejects the required discovery loader in either deny list (#434 follow-up)", async () => {
  const { dir, configPath, original } = await tempConfig({ enabled: false, review: { activeReviewers: [] } });
  try {
    await assert.rejects(
      persistReviewSettings(configPath, { ...baseSelection, tools: { topLevelDeny: ["tool_search"], executorDeny: [] } }),
      /required discovery loader cannot be denied/,
    );
    await assert.rejects(
      persistReviewSettings(configPath, { ...baseSelection, tools: { topLevelDeny: [], executorDeny: ["tool_search"] } }),
      /required discovery loader cannot be denied/,
    );
    assert.equal(await readFile(configPath, "utf8"), original, "a rejected write leaves the file untouched");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unrelated save never invents an empty tools field, and clearing an existing list persists", async () => {
  const { dir, configPath } = await tempConfig({ enabled: false, review: { activeReviewers: [] } });
  try {
    await persistReviewSettings(configPath, { ...baseSelection, tools: { topLevelDeny: [], executorDeny: [] } });
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).tools, undefined, "an unchanged empty deny set stays absent");
    await persistReviewSettings(configPath, { ...baseSelection, tools: { topLevelDeny: ["read"], executorDeny: [] } });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).tools, { topLevelDeny: ["read"], executorDeny: [] });
    await persistReviewSettings(configPath, { ...baseSelection, tools: { topLevelDeny: [], executorDeny: [] } });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).tools, { topLevelDeny: [], executorDeny: [] }, "clearing an existing list persists an empty list");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saves merge the owned deny fields into the raw tools object and never drop unrelated nested JSON", async () => {
  const { dir, configPath } = await tempConfig({
    enabled: false,
    review: { activeReviewers: [] },
    tools: { topLevelDeny: ["read"], executorDeny: [], futureToolsKey: { keep: true }, futureToolsFlag: 3 },
  });
  try {
    // Clearing both owned lists keeps the unknown nested keys verbatim.
    await persistReviewSettings(configPath, { ...baseSelection, tools: { topLevelDeny: [], executorDeny: [] } });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).tools, {
      futureToolsKey: { keep: true },
      futureToolsFlag: 3,
      topLevelDeny: [],
      executorDeny: [],
    });
    // A non-empty write keeps them too.
    await persistReviewSettings(configPath, { ...baseSelection, tools: { topLevelDeny: ["WebFetch"], executorDeny: ["ShellStart"] } });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).tools, {
      futureToolsKey: { keep: true },
      futureToolsFlag: 3,
      topLevelDeny: ["WebFetch"],
      executorDeny: ["ShellStart"],
    });
    // A record without any tools field still never gains one from an unchanged empty staging.
    const fresh = await tempConfig({ enabled: false, review: { activeReviewers: [] }, customFutureKey: "keep" });
    try {
      await persistReviewSettings(fresh.configPath, { ...baseSelection, tools: { topLevelDeny: [], executorDeny: [] } });
      const saved = JSON.parse(await readFile(fresh.configPath, "utf8"));
      assert.equal(saved.tools, undefined);
      assert.equal(saved.customFutureKey, "keep");
    } finally {
      await rm(fresh.dir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tools subsection: moved controls, independent checked=denied selectors
// ---------------------------------------------------------------------------

test("the root Tools subsection replaces the four moved rows and keeps their values and selection keys", async () => {
  const { dir, configPath, config } = await tempConfig({
    enabled: false,
    review: { activeReviewers: [] },
    execution: { deferredPiTools: false },
    youShouldKnow: { enabled: false, completionGuidance: true },
    web: { browserVisible: true },
  });
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context, calls } = scriptedContext([
      pickPrefix("Tools"), // root → Tools
      (title, options) => {
        assert.equal(title, "Tools");
        // The moved controls keep their previous selection labels/keys; the two
        // deny selectors are new rows in the same staged transaction.
        assert.ok(options[TOOLS.topLevel]!.startsWith("Top-level tools") && options[TOOLS.topLevel]!.includes("0 denied"));
        assert.ok(options[TOOLS.executor]!.startsWith("Executor tools") && options[TOOLS.executor]!.includes("0 denied"));
        assert.ok(options[TOOLS.deferred]!.startsWith("Deferred Pi tools") && options[TOOLS.deferred]!.includes("Off · local now, new subtasks"));
        assert.ok(options[TOOLS.notices]!.startsWith("YouShouldKnow notices") && options[TOOLS.notices]!.includes("Off"));
        assert.ok(options[TOOLS.guidance]!.startsWith("Completion guidance") && options[TOOLS.guidance]!.includes("On"));
        assert.ok(options[TOOLS.web]!.startsWith("Web") && options[TOOLS.web]!.includes("50 MiB max download · headed browser"));
        return options[TOOLS.back];
      },
      () => "Cancel",
    ]);
    await registered.handler("", context);
    const rootOptions = calls[0]!.options;
    // The four moved rows are gone from the root; one Tools row carries their
    // consolidated state and the two deny counts.
    assert.ok(!rootOptions.some((option) => option.startsWith("Deferred Pi tools")));
    assert.ok(!rootOptions.some((option) => option.startsWith("YouShouldKnow notices")));
    assert.ok(!rootOptions.some((option) => option.startsWith("Completion guidance")));
    assert.ok(!rootOptions.some((option) => option.startsWith("Web ")));
    const toolsRow = rootOptions.find((option) => option.startsWith("Tools"))!;
    assert.ok(toolsRow.includes("0 top-level denied · 0 executor denied · deferred Off · 50 MiB max download · headed browser"), toolsRow);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("top-level and executor selectors are distinct multi-selects where checked is strictly denied", async () => {
  const { dir, configPath, config } = await tempConfig({ enabled: false, review: { activeReviewers: [] }, customFutureKey: "keep" });
  try {
    const registered = commandHarness();
    registerReviewSettings({
      pi: registered.pi,
      config,
      configPath,
      getToolChoices: () => [
        { name: "read", description: "Read files." },
        { name: "bash", description: "Run shell commands." },
        { name: "WebFetch", description: "Fetch a page." },
      ],
    });
    const { context, calls } = scriptedContext([
      pickPrefix("Tools"),                       // root → Tools
      pickPrefix("Top-level tools"),            // Tools → Top-level tools
      (title, options) => {                     // deny read
        assert.match(title, /^Top-level tools — Enter toggles — 0 denied$/);
        assert.deepEqual(options.slice(0, 3), [
          "read (Read files)  ✗ allowed",
          "bash (Run shell commands)  ✗ allowed",
          "WebFetch (Fetch a page)  ✗ allowed",
        ]);
        return "read (Read files)  ✗ allowed";
      },
      (title, options) => {                     // re-show: deny bash too
        assert.match(title, /^Top-level tools — Enter toggles — 1 denied$/);
        assert.equal(options[0], "read (Read files)  ✓ denied");
        return "bash (Run shell commands)  ✗ allowed";
      },
      (title, options) => {
        assert.match(title, /^Top-level tools — Enter toggles — 2 denied$/);
        assert.equal(options[1], "bash (Run shell commands)  ✓ denied");
        return options.find((option) => option === "Back")!;
      },
      pickPrefix("Executor tools"),             // Tools → Executor tools (distinct list)
      (title, options) => {
        assert.match(title, /^Executor tools — Enter toggles — 0 denied$/);
        // Same inventory, still allowed: top-level denials never cascade.
        assert.deepEqual(options.slice(0, 3), [
          "read (Read files)  ✗ allowed",
          "bash (Run shell commands)  ✗ allowed",
          "WebFetch (Fetch a page)  ✗ allowed",
        ]);
        return "WebFetch (Fetch a page)  ✗ allowed";
      },
      (title, options) => {
        assert.match(title, /^Executor tools — Enter toggles — 1 denied$/);
        assert.equal(options[2], "WebFetch (Fetch a page)  ✓ denied");
        return "Back";
      },
      pickPrefix("Back"),                       // Tools → root
      () => "Save changes",
    ]);
    await registered.handler("", context);
    // The Tools submenu was the second menu shown and offered the moved rows.
    assert.equal(calls[1]!.title, "Tools");

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.tools, { topLevelDeny: ["read", "bash"], executorDeny: ["WebFetch"] });
    assert.deepEqual(config.tools, { topLevelDeny: ["read", "bash"], executorDeny: ["WebFetch"] });
    assert.equal(saved.customFutureKey, "keep", "unrelated JSON is retained");

    // Reopening shows the checked=denied state reversibly.
    const reopen = commandHarness();
    registerReviewSettings({
      pi: reopen.pi,
      config,
      configPath,
      getToolChoices: () => [{ name: "read" }, { name: "bash" }, { name: "WebFetch" }],
    });
    const replayed = scriptedContext([
      pickPrefix("Tools"),
      pickPrefix("Top-level tools"),
      (title, options) => {
        assert.match(title, /^Top-level tools — Enter toggles — 2 denied$/);
        assert.deepEqual(options.slice(0, 3), ["read  ✓ denied", "bash  ✓ denied", "WebFetch  ✗ allowed"]);
        return "read  ✓ denied"; // reverse it: allowed again
      },
      () => "Back",
      () => "Back",
      () => "Save changes",
    ]);
    await reopen.handler("", replayed.context);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).tools, { topLevelDeny: ["bash"], executorDeny: ["WebFetch"] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a saved denial missing from the live inventory stays reversible and is never treated as authorization", async () => {
  const { dir, configPath, original, config } = await tempConfig({
    enabled: false,
    review: { activeReviewers: [] },
    tools: { topLevelDeny: ["GhostTool", "read"], executorDeny: [] },
  });
  try {
    const registered = commandHarness();
    registerReviewSettings({
      pi: registered.pi,
      config,
      configPath,
      // The live pre-deny inventory no longer offers GhostTool; `read` is
      // denied and must render as such rather than being granted by omission.
      getToolChoices: () => [{ name: "read" }, { name: "bash" }],
    });
    const { context } = scriptedContext([
      pickPrefix("Tools"),
      pickPrefix("Top-level tools"),
      (title, options) => {
        assert.match(title, /^Top-level tools — Enter toggles — 2 denied$/);
        assert.deepEqual(options.slice(0, 4), [
          "read  ✓ denied",
          "bash  ✗ allowed",
          "GhostTool [not currently available]  ✓ denied",
          "Back",
        ]);
        return "GhostTool [not currently available]  ✓ denied"; // reversible
      },
      () => "Back",
      () => "Back",
      () => "Cancel", // discard the draft: the saved denial is untouched
    ]);
    await registered.handler("", context);
    assert.equal(await readFile(configPath, "utf8"), original, "Cancel writes nothing");
    assert.deepEqual(config.tools, { topLevelDeny: ["GhostTool", "read"], executorDeny: [] }, "the live config keeps the saved denials");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unavailable saved denial stays a reversible row for both selectors, even unchecked and after Back/re-entry", async () => {
  const { dir, configPath, config } = await tempConfig({
    enabled: false,
    review: { activeReviewers: [] },
    tools: { topLevelDeny: ["GhostTool", "read"], executorDeny: ["GhostExec"] },
  });
  try {
    const registered = commandHarness();
    registerReviewSettings({
      pi: registered.pi,
      config,
      configPath,
      getToolChoices: () => [{ name: "read" }, { name: "bash" }, { name: "WebFetch" }],
    });
    const { context } = scriptedContext([
      pickPrefix("Tools"),
      pickPrefix("Top-level tools"),
      (title, options) => {
        assert.match(title, /^Top-level tools — Enter toggles — 2 denied$/);
        assert.deepEqual(options.slice(0, 5), [
          "read  ✓ denied",
          "bash  ✗ allowed",
          "WebFetch  ✗ allowed",
          "GhostTool [not currently available]  ✓ denied",
          "Back",
        ]);
        return "GhostTool [not currently available]  ✓ denied"; // uncheck
      },
      (title, options) => {
        assert.match(title, /^Top-level tools — Enter toggles — 1 denied$/);
        // The retained row survives its own unchecking, now rendered unchecked.
        assert.deepEqual(options.slice(0, 5), [
          "read  ✓ denied",
          "bash  ✗ allowed",
          "WebFetch  ✗ allowed",
          "GhostTool [not currently available]  ✗ allowed",
          "Back",
        ]);
        return "Back";
      },
      pickPrefix("Top-level tools"), // re-enter the picker
      (title, options) => {
        assert.match(title, /^Top-level tools — Enter toggles — 1 denied$/);
        assert.deepEqual(options.slice(0, 5), [
          "read  ✓ denied",
          "bash  ✗ allowed",
          "WebFetch  ✗ allowed",
          "GhostTool [not currently available]  ✗ allowed",
          "Back",
        ], "the transaction-opening saved name survives Back/re-entry while unchecked");
        return "GhostTool [not currently available]  ✗ allowed"; // recheck
      },
      (title, options) => {
        assert.match(title, /^Top-level tools — Enter toggles — 2 denied$/);
        assert.equal(options[3], "GhostTool [not currently available]  ✓ denied");
        return "Back";
      },
      pickPrefix("Executor tools"),
      (title, options) => {
        assert.match(title, /^Executor tools — Enter toggles — 1 denied$/);
        // Distinct selectors: the top-level ghost is absent, the executor ghost is here.
        assert.deepEqual(options.slice(0, 5), [
          "read  ✗ allowed",
          "bash  ✗ allowed",
          "WebFetch  ✗ allowed",
          "GhostExec [not currently available]  ✓ denied",
          "Back",
        ]);
        return "GhostExec [not currently available]  ✓ denied"; // uncheck
      },
      (title, options) => {
        assert.match(title, /^Executor tools — Enter toggles — 0 denied$/);
        assert.equal(options[3], "GhostExec [not currently available]  ✗ allowed", "the retained executor row survives at zero denied");
        return "Back";
      },
      pickPrefix("Executor tools"), // re-enter the picker
      (title, options) => {
        assert.match(title, /^Executor tools — Enter toggles — 0 denied$/);
        assert.equal(options[3], "GhostExec [not currently available]  ✗ allowed", "retained across Back/re-entry at zero denied");
        return "GhostExec [not currently available]  ✗ allowed"; // recheck
      },
      (title, options) => {
        assert.match(title, /^Executor tools — Enter toggles — 1 denied$/);
        assert.equal(options[3], "GhostExec [not currently available]  ✓ denied");
        return "Back";
      },
      pickPrefix("Back"),
      () => "Save changes",
    ]);
    await registered.handler("", context);

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.tools, { topLevelDeny: ["read", "GhostTool"], executorDeny: ["GhostExec"] });
    assert.deepEqual(config.tools, { topLevelDeny: ["read", "GhostTool"], executorDeny: ["GhostExec"] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a raw programmatic config never offers or counts the reserved loader in either scope (#434 follow-up)", async () => {
  const { dir, configPath } = await tempConfig({ enabled: false, review: { activeReviewers: [] } });
  try {
    // Canonical validation now rejects this shape, so only a raw programmatic
    // config can carry the loader into the menu; the UI must never offer it as a
    // selectable (or retained unavailable) row nor count it as denied.
    const config = {
      ...normalizeConfig({ enabled: false, review: { activeReviewers: [] } }),
      tools: { topLevelDeny: ["read", "tool_search"], executorDeny: ["tool_search", "ShellStart"] },
    } as ReviewGateConfig;
    const registered = commandHarness();
    registerReviewSettings({
      pi: registered.pi,
      config,
      configPath,
      // Simulate a production selector-callback bug leaking the reserved loader.
      getToolChoices: () => [{ name: "read" }, { name: "bash" }, { name: "tool_search" }],
    });
    const { context, calls } = scriptedContext([
      pickPrefix("Tools"),
      (title, options) => {
        assert.equal(title, "Tools");
        assert.ok(options[TOOLS.topLevel]!.includes("1 denied"), options[TOOLS.topLevel]);
        assert.ok(options[TOOLS.executor]!.includes("1 denied"), options[TOOLS.executor]);
        return options[TOOLS.topLevel]!;
      },
      (title, options) => {
        assert.match(title, /^Top-level tools — Enter toggles — 1 denied$/);
        // The reserved loader is absent even though the inventory supplied it.
        assert.deepEqual(options, ["read  ✓ denied", "bash  ✗ allowed", "Back"]);
        return "Back";
      },
      pickPrefix("Executor tools"),
      (title, options) => {
        assert.match(title, /^Executor tools — Enter toggles — 1 denied$/);
        // The independent unavailable name stays a reversible row; the loader is
        // never retained and never implied denied.
        assert.deepEqual(options, [
          "read  ✗ allowed",
          "bash  ✗ allowed",
          "ShellStart [not currently available]  ✓ denied",
          "Back",
        ]);
        return "Back";
      },
      pickPrefix("Back"),
      () => "Save changes",
    ]);
    await registered.handler("", context);
    const rootOptions = calls[0]!.options;
    const toolsRow = rootOptions.find((option) => option.startsWith("Tools"))!;
    assert.ok(toolsRow.includes("1 top-level denied · 1 executor denied"), toolsRow);
    const savedText = await readFile(configPath, "utf8");
    assert.doesNotMatch(savedText, /tool_search/);
    assert.deepEqual(JSON.parse(savedText).tools, { topLevelDeny: ["read"], executorDeny: ["ShellStart"] });
    assert.deepEqual(config.tools, { topLevelDeny: ["read"], executorDeny: ["ShellStart"] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("root Escape applies staged denials for the session and a reopened Save persists them", async () => {
  const { dir, configPath, original, config } = await tempConfig({ enabled: false, review: { activeReviewers: [] } });
  try {
    const registered = commandHarness();
    registerReviewSettings({
      pi: registered.pi,
      config,
      configPath,
      getToolChoices: () => [{ name: "read" }, { name: "bash" }],
    });
    const first = scriptedContext([
      pickPrefix("Tools"),
      pickPrefix("Top-level tools"),
      (title, options) => {
        assert.match(title, /^Top-level tools — Enter toggles — 0 denied$/);
        return "bash  ✗ allowed";
      },
      () => "Back",
      () => "Back",
      () => undefined, // undefined selection at the root is the session-only Escape
    ]);
    await registered.handler("", first.context);
    assert.deepEqual(config.tools, { topLevelDeny: ["bash"], executorDeny: [] }, "Escape applies the staged denial live");
    assert.equal(await readFile(configPath, "utf8"), original, "Escape never writes the config file");
    // The pending session delta stays baseline-only (agent/schedule metadata);
    // the live canonical config is the single active store for denials.
    const delta = getPendingSessionDelta(config) as { topLevelDeny?: unknown } | undefined;
    assert.notEqual(delta, undefined);
    assert.equal(delta!.topLevelDeny, undefined);

    // Reopen (same live config) and Save with no new edits: the session-applied
    // denial is now durable through the ordinary pipeline.
    const reopened = commandHarness();
    registerReviewSettings({ pi: reopened.pi, config, configPath, getToolChoices: () => [{ name: "read" }, { name: "bash" }] });
    const second = scriptedContext([() => "Save changes"]);
    await reopened.handler("", second.context);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).tools, { topLevelDeny: ["bash"], executorDeny: [] });
    assert.equal(getPendingSessionDelta(config), undefined, "a successful Save clears the pending delta");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Cancel discards the staged denial and a reloaded config reopens on the saved value", async () => {
  const { dir, configPath, original, config } = await tempConfig({ enabled: false, review: { activeReviewers: [] } });
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath, getToolChoices: () => [{ name: "read" }] });
    const { context } = scriptedContext([
      pickPrefix("Tools"),
      pickPrefix("Executor tools"),
      (title, options) => {
        assert.match(title, /^Executor tools — Enter toggles — 0 denied$/);
        return "read  ✗ allowed";
      },
      () => "Back",
      () => "Back",
      () => "Cancel",
    ]);
    await registered.handler("", context);
    assert.equal(await readFile(configPath, "utf8"), original, "Cancel writes nothing");
    assert.equal(config.tools, undefined, "Cancel does not apply live");

    // Simulated /reload: a fresh config object from the unchanged file.
    const reloaded = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
    const reopen = commandHarness();
    registerReviewSettings({ pi: reopen.pi, config: reloaded, configPath, getToolChoices: () => [{ name: "read" }] });
    const replayed = scriptedContext([
      pickPrefix("Tools"),
      (title, options) => {
        assert.equal(title, "Tools");
        assert.ok(options[TOOLS.topLevel]!.includes("0 denied"));
        assert.ok(options[TOOLS.executor]!.includes("0 denied"));
        return options[TOOLS.back]!;
      },
      () => "Cancel",
    ]);
    await reopen.handler("", replayed.context);
    assert.equal(reloaded.tools, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Ctrl+S from inside the deny picker saves the whole staged Tools draft", async (t) => {
  const { dir, configPath, config } = await tempConfig({ enabled: false, review: { activeReviewers: [] } });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const registered = commandHarness();
  const notices: Array<{ message: string; type?: string }> = [];
  registerReviewSettings({
    pi: registered.pi,
    config,
    configPath,
    getToolChoices: () => [{ name: "read" }, { name: "bash" }],
  });
  const harness: TuiSettingsHarness = createTuiSettingsContext([
    [...down(ROOT_TOOLS), KEY_ENTER], // root → Tools
    [KEY_ENTER],                      // Tools → Top-level tools (row 0)
    [KEY_ENTER],                      // deny read (row 0)
    [CTRL_S],                         // nested picker: request the canonical save
  ]);
  setMenuTuiHost({ ...harness.host, matchesCtrlS: (data) => matchesKey(data, Key.ctrl("s")) });
  const base = harness.context as { ui: Record<string, unknown> };
  try {
    await registered.handler("", { ...(base as Record<string, unknown>), ui: { ...base.ui, notify: (message: string, type?: string) => notices.push({ message, type }) } });
  } finally {
    setMenuTuiHost(undefined);
  }
  assert.equal(harness.exhausted(), false, "the scripted flow must not run out of steps");
  assert.ok(!notices.some((notice) => notice.type === "error"), JSON.stringify(notices));
  assert.ok(notices.some((notice) => notice.message === "Review settings saved."));
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).tools, { topLevelDeny: ["read"], executorDeny: [] });
});
