/**
 * Issue #536: the `/review-settings` → Tools → **Tool protection** submenu for
 * the already-landed canonical `toolProtection` block.
 *
 * These tests cover the settings surface only: navigation into the submenu, the
 * staged scalar controls, the single auditor picker over the scoped Pi models
 * and EVERY configured external definition, core's strict rules (an enabled
 * level needs an auditor; a selected audit scope needs at least one exact
 * name), the rename/delete/reference lifecycle of the auditor selection, and
 * persistence through the existing staged transaction with unrelated raw JSON
 * preserved. No test here calls a provider or model, enables a tool, or touches
 * a live configuration file: the suspicious-fetch example stays a synthetic
 * string, and the runtime gate itself is tested in the tool-protection suites.
 */

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig, recoverConfig, type ReviewGateConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { changeExternalAgent, externalAgentReferences, guardExternalAgentReferences } from "../src/settings/external-agent-catalog";
import { persistReviewSettings } from "../src/settings/persistence";
import { getPendingSessionDelta } from "../src/settings/session-delta";
import { stagedToolProtectionSettings, toolProtectionStagedWriteNeeded } from "../src/settings/tool-protection";
import { validateToolProtectionSelection } from "../src/settings/validation";

/** Root row index of the Tools subsection. */
const ROOT_TOOLS = 13;
/** Tools submenu row indices (the protection row sits between Web and Back). */
const TOOLS = { topLevel: 0, executor: 1, deferred: 2, notices: 3, guidance: 4, web: 5, toolProtection: 6, back: 7 } as const;

const PROTECTION_TITLE = "Tool protection";

async function tempConfig(body: Record<string, unknown>): Promise<{ dir: string; configPath: string; original: string; config: ReviewGateConfig }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-protection-"));
  const configPath = join(dir, "review-gate.json");
  const original = JSON.stringify(body);
  await writeFile(configPath, original, "utf8");
  return { dir, configPath, original, config: normalizeConfig(JSON.parse(original)) };
}

function commandHarness(): { pi: { registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }): void }; handler: (args: string, ctx: unknown) => Promise<void> } {
  let handler: ((args: string, ctx: unknown) => unknown) | undefined;
  return {
    pi: { registerCommand(name, options) { if (name === "review-settings") handler = options.handler; } },
    handler: async (args, ctx) => {
      assert.ok(handler);
      await handler(args, ctx);
    },
  };
}

interface ScriptOptions {
  scopedModels?: unknown[];
  /** Editor answers in call order; `undefined` cancels the field. */
  editors?: Array<(title: string, prefill: string) => string | undefined>;
  /** When present the host offers a confirmation dialog with this answer. */
  confirm?: boolean;
}

interface ScriptResult {
  context: unknown;
  calls: Array<{ title: string; options: string[] }>;
  notices: Array<{ message: string; type?: string }>;
  editors: Array<{ title: string; prefill: string }>;
  confirmations: Array<{ title: string; message: string }>;
}

/**
 * Plain-select scripted host. Every returned value must be one of the offered
 * options, so a script cannot silently select a row that does not exist.
 */
function scripted(script: Array<(title: string, options: string[]) => string | undefined>, options: ScriptOptions = {}): ScriptResult {
  let index = 0;
  let editorIndex = 0;
  const calls: ScriptResult["calls"] = [];
  const notices: ScriptResult["notices"] = [];
  const editors: ScriptResult["editors"] = [];
  const confirmations: ScriptResult["confirmations"] = [];
  const ui: Record<string, unknown> = {
    async select(title: string, optionList: string[]): Promise<string | undefined> {
      calls.push({ title, options: optionList });
      const step = script[Math.min(index, script.length - 1)];
      index += 1;
      const value = step?.(title, optionList);
      if (value !== undefined) assert.ok(optionList.includes(value), `scripted selection not offered (${title}): ${value}`);
      return value;
    },
    notify(message: string, type?: string) { notices.push({ message, type }); },
    async editor(title: string, prefill?: string): Promise<string | undefined> {
      editors.push({ title, prefill: prefill ?? "" });
      const step = options.editors?.[Math.min(editorIndex, (options.editors?.length ?? 1) - 1)];
      editorIndex += 1;
      return step?.(title, prefill ?? "");
    },
  };
  if (options.confirm !== undefined) {
    ui.confirm = async (title: string, message: string) => {
      confirmations.push({ title, message });
      return options.confirm === true;
    };
  }
  return { context: { scopedModels: options.scopedModels ?? [], ui }, calls, notices, editors, confirmations };
}

const pick = (prefix: string) => (_title: string, options: string[]) => {
  const value = options.find((option) => option.startsWith(prefix));
  assert.ok(value !== undefined, `no option starts with ${prefix}: ${options.join(" | ")}`);
  return value;
};
const pickExact = (value: string) => (_title: string, options: string[]) => {
  assert.ok(options.includes(value), `option missing (${value}): ${options.join(" | ")}`);
  return value;
};
const back = pickExact("Back");
const cancel = pickExact("Cancel");
const save = pickExact("Save changes");
/** Root → Tools → Tool protection. */
const intoProtection = [pick("Tools"), pick("Tool protection")];
/** Compare aligned rows without depending on the label gutter width. */
const flat = (options: string[]) => options.map((option) => option.replace(/\s+/g, " ").trim());

const scopedOpus = {
  model: { provider: "anthropic", id: "claude-opus-4-1", reasoning: true, thinkingLevelMap: {} },
  thinkingLevel: "high",
};

const fourAdapters = {
  externalAgents: {
    "claude-auditor": { adapter: "claude-cli", review: {} },
    "codex-auditor": { adapter: "codex-cli", review: {} },
    "generic-auditor": { adapter: "generic-cli", command: "audit-bin", review: {} },
    "binary-auditor": { adapter: "run-as-binary", command: "decide-bin", review: { protocol: "pi-reviewer-json-v1" } },
  },
};

// ---------------------------------------------------------------------------
// Navigation and display
// ---------------------------------------------------------------------------

test("Tools offers Tool protection and a config without the block opens on the effective defaults without claiming a stored Off", async () => {
  const { dir, configPath, original, config } = await tempConfig({ enabled: false, review: { activeReviewers: [] } });
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context, calls, notices } = scripted([
      ...intoProtection,
      (title, options) => {
        assert.equal(title, PROTECTION_TITLE);
        assert.deepEqual(flat(options), [
          "Protection level Off",
          "Auditor None · allowed while Off",
          "Audit scope All calls",
          "Decision timeout 10s (entered in seconds)",
          "Context budget 128000 characters",
          "Save auditor sessions Off — audits are not saved",
          "Debug audit output Off — only what a call already reports is shown",
          "Back",
        ]);
        return back(title, options);
      },
      (title, options) => {
        assert.equal(title, "Tools");
        assert.ok(options[TOOLS.toolProtection]!.startsWith("Tool protection"), options[TOOLS.toolProtection]);
        assert.ok(options[TOOLS.toolProtection]!.includes("Off · no auditor · scope: all calls · auditing disabled"), options[TOOLS.toolProtection]);
        // The presentation makes no maturity claim: no "experimental" or
        // proof-of-concept wording anywhere in the real-run surface.
        assert.doesNotMatch(options[TOOLS.toolProtection]!, /experimental|proof of concept|\bpoc\b/i);
        // The existing rows and their alignment are unchanged.
        assert.ok(options[TOOLS.web]!.startsWith("Web"), options[TOOLS.web]);
        assert.equal(options[TOOLS.back], "Back");
        return options[TOOLS.back]!;
      },
      cancel,
    ]);
    await registered.handler("", context);
    assert.equal(calls[1]!.title, "Tools");
    assert.ok(notices.some((notice) => notice.message.includes("all display the same defaults")
      && notice.message.includes("does not claim the stored configuration said Off")), JSON.stringify(notices));
    assert.ok(notices.some((notice) => notice.message.includes("additional restriction only")), JSON.stringify(notices));
    assert.equal(await readFile(configPath, "utf8"), original, "browsing stages nothing");
    assert.equal(config.toolProtection, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Scalar controls, auditor selection, and the canonical write
// ---------------------------------------------------------------------------

test("enabling a level and choosing an external auditor persists the canonical block and preserves unrelated raw JSON", async () => {
  const { dir, configPath, config } = await tempConfig({
    enabled: false,
    review: { activeReviewers: [] },
    ...fourAdapters,
    toolProtection: { level: "off", auditor: null, futureKey: { keep: true } },
    customFutureKey: "keep",
  });
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context, notices } = scripted([
      ...intoProtection,
      pick("Protection level"),
      (title, options) => {
        assert.match(title, /^Protection level — one shared level/);
        assert.deepEqual(options, [
          "Off — this added gate does not apply  current",
          "Dangerous only (dangerous)",
          "Dangerous plus task alignment (aligned)",
          "Workspace and temporary-root intent (workspace)",
        ]);
        return "Dangerous only (dangerous)";
      },
      pick("Auditor"),
      (title, options) => {
        assert.equal(title, "Tool protection auditor — Enter selects");
        // Every configured definition is offered — no reviewer-role or route
        // filtering — and the Off-only "no auditor" row is gone now that an
        // enabled level requires an auditor.
        assert.deepEqual(options, [
          "binary-auditor [run-as-binary]",
          "claude-auditor [claude-cli] · Claude route unsupported (retry disabling unproven) — audits would fail",
          "codex-auditor [codex-cli] · no-tools route unproven — audits would fail",
          "generic-auditor [generic-cli]",
          "Back",
        ]);
        return "generic-auditor [generic-cli]";
      },
      (title, options) => {
        // No confirm dialog on this host: the same disclosure arrives as a
        // warning instead of being skipped.
        assert.ok(notices.some((notice) => notice.type === "warning"
          && notice.message.includes("exact proposed tool name and arguments")
          && notice.message.includes("Audit scope is All calls")), JSON.stringify(notices));
        return back(title, options);
      },
      back,
      save,
    ]);
    await registered.handler("", context);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.toolProtection, {
      futureKey: { keep: true },
      level: "dangerous",
      auditor: { source: "external", id: "generic-auditor" },
      scope: "all",
      toolNames: [],
      timeoutMs: 10_000,
      maxContextChars: 128_000,
      // Retention is an owned field of the block, so an explicit apply writes
      // it alongside the rest instead of leaving a stale stored value.
      retainAuditorSessions: false,
      // So is the #549 debug switch: the staged effective value is written with
      // the rest of the owned fields rather than left ambiguous.
      debug: false,
    });
    assert.equal(saved.customFutureKey, "keep");
    assert.deepEqual(config.toolProtection?.auditor, { source: "external", id: "generic-auditor" });
    assert.equal(config.toolProtection?.level, "dangerous");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an interactive host must confirm the auditor boundary and a decline leaves the selection unchanged", async () => {
  const { dir, configPath, original, config } = await tempConfig({
    enabled: false,
    review: { activeReviewers: [] },
    ...fourAdapters,
    toolProtection: { level: "aligned", auditor: { source: "external", id: "claude-auditor" } },
  });
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context, confirmations, notices } = scripted([
      ...intoProtection,
      pick("Auditor"),
      (title, options) => {
        assert.ok(options.some((option) => option.startsWith("claude-auditor [claude-cli]") && option.endsWith("  current")), options.join(" | "));
        return "binary-auditor [run-as-binary]";
      },
      back,
      back,
      cancel,
    ], { confirm: false });
    await registered.handler("", context);
    assert.equal(confirmations.length, 1, JSON.stringify(confirmations));
    assert.match(confirmations[0]!.message, /replaces the current auditor claude-auditor/);
    assert.match(confirmations[0]!.message, /NOT AUDITED|Audit scope is All calls/);
    assert.ok(notices.some((notice) => notice.message.includes("Auditor unchanged") || notice.message.includes("unchanged")), JSON.stringify(notices));
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.deepEqual(config.toolProtection?.auditor, { source: "external", id: "claude-auditor" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the shared enable/auditor disclosure keeps the take-effect rules and states no decision-time goal", async () => {
  const { dir, configPath, original, config } = await tempConfig({
    enabled: false,
    review: { activeReviewers: [] },
    ...fourAdapters,
    toolProtection: { level: "off", auditor: { source: "external", id: "generic-auditor" }, timeoutMs: 10_000, maxContextChars: 128_000 },
  });
  /** Wording that would state an intended or aspirational audit-completion time. */
  const goalPhrasing = /2\s*[–-]\s*3\s*second|decision goal|aspirational|benchmark|performance target/i;
  const takeEffect = "Nothing takes effect until root Escape (this session) or Save/Ctrl+S (disk); Cancel discards.";
  try {
    // Interactive host: the level-enable dialog and the auditor-change dialog
    // share one disclosure, and neither may carry a timing goal.
    const confirmed = commandHarness();
    registerReviewSettings({ pi: confirmed.pi, config, configPath });
    const withConfirm = scripted([
      ...intoProtection,
      pick("Protection level"),
      pickExact("Dangerous only (dangerous)"),
      pick("Auditor"),
      pickExact("binary-auditor [run-as-binary]"),
      back,
      back,
      cancel,
    ], { confirm: true });
    await confirmed.handler("", withConfirm.context);
    const dialogs = withConfirm.confirmations.filter((entry) => entry.title === "Enable tool protection?" || entry.title === "Send audited tool calls to this auditor?");
    assert.deepEqual(dialogs.map((entry) => entry.title), ["Enable tool protection?", "Send audited tool calls to this auditor?"], JSON.stringify(withConfirm.confirmations));
    for (const dialog of dialogs) {
      assert.ok(!goalPhrasing.test(dialog.message), `${dialog.title}: ${dialog.message}`);
      assert.ok(dialog.message.includes(takeEffect), `${dialog.title}: ${dialog.message}`);
      assert.ok(dialog.message.includes("decision-only with no tools"), `${dialog.title}: ${dialog.message}`);
    }
    assert.ok(withConfirm.confirmations.find((entry) => entry.title === "Enable tool protection?")!.message.includes('Enabling Protection level "dangerous"'));
    assert.ok(withConfirm.confirmations.find((entry) => entry.title === "Send audited tool calls to this auditor?")!.message.includes("replaces the current auditor generic-auditor"));

    // Hosts without a confirmation dialog get the SAME text as a warning
    // notice, so no host silently gets a shorter disclosure.
    const fallback = commandHarness();
    registerReviewSettings({ pi: fallback.pi, config, configPath });
    const withoutConfirm = scripted([
      ...intoProtection,
      pick("Protection level"),
      pickExact("Dangerous only (dangerous)"),
      pick("Auditor"),
      pickExact("binary-auditor [run-as-binary]"),
      back,
      back,
      cancel,
    ]);
    await fallback.handler("", withoutConfirm.context);
    const warnings = withoutConfirm.notices.filter((notice) => notice.type === "warning" && notice.message.includes("as the tool-protection auditor sends"));
    assert.equal(warnings.length, 2, JSON.stringify(withoutConfirm.notices.map((notice) => notice.message)));
    for (const notice of warnings) {
      assert.ok(!goalPhrasing.test(notice.message), notice.message);
      assert.ok(notice.message.includes(takeEffect), notice.message);
      assert.ok(notice.message.includes("decision-only with no tools"), notice.message);
    }

    assert.equal(await readFile(configPath, "utf8"), original, "Cancel wrote nothing");
    assert.equal(config.toolProtection?.level, "off", "Cancel discarded the staged level");
    assert.deepEqual(config.toolProtection?.auditor, { source: "external", id: "generic-auditor" }, "Cancel discarded the staged auditor");
    assert.equal(config.toolProtection?.timeoutMs, 10_000, "the decision deadline control and its default are untouched");
    assert.equal(config.toolProtection?.maxContextChars, 128_000, "the context budget control and its default are untouched");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the picker lists scoped models and unscoped worker-resource models truthfully and Pi reasoning is chosen per model", async () => {
  const { dir, configPath, original, config } = await tempConfig({
    enabled: false,
    review: { activeReviewers: [] },
    execution: {
      workerResources: {
        "pi-openai-gpt-6": { selection: { source: "pi", model: "openai/gpt-6-sol" }, maxConcurrent: 1 },
      },
    },
  });
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context, calls } = scripted([
      ...intoProtection,
      pick("Auditor"),
      (title, options) => {
        assert.deepEqual(options, [
          "No auditor — valid only while Protection level is Off  current",
          "claude-opus-4-1 [anthropic]",
          "openai/gpt-6-sol [worker resource · not currently scoped]",
          "Back",
        ]);
        return "openai/gpt-6-sol [worker resource · not currently scoped]";
      },
      (title, options) => {
        // An unscoped model has no reasoning surface to choose, and says so.
        assert.equal(title, PROTECTION_TITLE);
        assert.ok(options[1]!.includes("openai/gpt-6-sol [not currently scoped]"), options[1]);
        return back(title, options);
      },
      back,
      cancel,
    ], { scopedModels: [scopedOpus] });
    await registered.handler("", context);
    assert.ok(calls.length >= 4);
    assert.equal(await readFile(configPath, "utf8"), original, "Cancel discards the staged auditor");

    // Now drop the unscoped worker resource (its pin would fail the ordinary
    // selection validation for a reason unrelated to this gate), then select
    // the scoped model and choose its reasoning level.
    const reopened = commandHarness();
    registerReviewSettings({ pi: reopened.pi, config, configPath });
    const second = scripted([
      pick("Worker resources"),
      pickExact("1. openai/gpt-6-sol [unavailable] · shared max 1"),
      pickExact("Remove"),
      back,
      ...intoProtection,
      pick("Protection level"),
      pickExact("Dangerous only (dangerous)"),
      pick("Auditor"),
      pickExact("claude-opus-4-1 [anthropic]"),
      (title, options) => {
        assert.equal(title, "Reasoning — claude-opus-4-1 [anthropic]");
        assert.deepEqual(options, ["Off", "Minimal", "Low", "Medium", "High  current"]);
        return pick("High")(title, options);
      },
      back,
      back,
      save,
    ], { scopedModels: [scopedOpus] });
    await reopened.handler("", second.context);
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).toolProtection.auditor, {
      source: "pi",
      model: "anthropic/claude-opus-4-1",
      thinkingLevel: "high",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("timeout and context budget validate with explicit units and persist as milliseconds and characters", async () => {
  const { dir, configPath, config } = await tempConfig({ enabled: false, review: { activeReviewers: [] } });
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context, notices, editors } = scripted([
      ...intoProtection,
      pick("Decision timeout"),
      pick("Decision timeout"),
      pick("Decision timeout"),
      pick("Context budget"),
      pick("Context budget"),
      back,
      back,
      save,
    ], {
      editors: [
        () => "0",
        () => "121",
        () => "2.5",
        () => "abc",
        () => "64000",
      ],
    });
    await registered.handler("", context);
    assert.deepEqual(editors.map((editor) => editor.title), [
      "Decision timeout in SECONDS (1-120 seconds) — stored in milliseconds",
      "Decision timeout in SECONDS (1-120 seconds) — stored in milliseconds",
      "Decision timeout in SECONDS (1-120 seconds) — stored in milliseconds",
      "Auditor context budget in CHARACTERS (4000-2000000) — the assembled prompt ceiling, not a token count",
      "Auditor context budget in CHARACTERS (4000-2000000) — the assembled prompt ceiling, not a token count",
    ]);
    assert.deepEqual(editors.map((editor) => editor.prefill), ["10", "10", "10", "128000", "128000"]);
    // Exactly the three malformed entries were refused; the two accepted ones
    // replaced the stored defaults without any extra complaint.
    assert.equal(notices.filter((notice) => notice.type === "error").length, 3, JSON.stringify(notices));
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    // 2.5 seconds is accepted as whole milliseconds; the rejected entries left
    // the stored defaults in place until the accepted value replaced them.
    assert.equal(saved.toolProtection.timeoutMs, 2_500);
    assert.equal(saved.toolProtection.maxContextChars, 64_000);
    assert.equal(config.toolProtection?.timeoutMs, 2_500);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Reduced coverage, and core's strict rules at the apply boundary
// ---------------------------------------------------------------------------

test("audited names are chosen in the same searchable multi-select: exact-name toggles, the retained unavailable name, and the reserved loader", async () => {
  const { dir, configPath, config } = await tempConfig({
    enabled: false,
    review: { activeReviewers: [] },
    ...fourAdapters,
    toolProtection: { level: "dangerous", auditor: { source: "external", id: "generic-auditor" }, scope: "selected", toolNames: ["GhostTool"] },
  });
  try {
    const registered = commandHarness();
    registerReviewSettings({
      pi: registered.pi,
      config,
      configPath,
      getToolChoices: () => [
        { name: "read", description: "Read files." },
        { name: "bash", description: "Run shell commands." },
        // The runtime here DOES offer the reserved loader. The audit subset may
        // audit it; the deny selectors must still never offer it (asserted in
        // tests/settings-audit-names.test.ts).
        { name: "tool_search", description: "Search the authorized tool catalog." },
      ],
    });
    const { context, notices, editors } = scripted([
      ...intoProtection,
      (title, options) => {
        assert.ok(options[2]!.includes("Selected tool names · 1 named · REDUCED COVERAGE"), options[2]);
        assert.ok(options[3]!.startsWith("Audited tool names") && options[3]!.includes("GhostTool"), options[3]);
        return pick("Audited tool names")(title, options);
      },
      // The picker is the tool-block picker's searchable multi-select: one row
      // per offered tool, the retained unavailable name, Back, and a checked row
      // meaning AUDITED. The reserved discovery loader is never a checked
      // candidate: its row states the infrastructure exemption instead.
      (title, options) => {
        assert.equal(title, "Audited tool names (tools outside the list are NOT AUDITED) — Enter toggles — 1 audited");
        assert.deepEqual(flat(options), [
          "read (Read files) ✗ not audited",
          "bash (Run shell commands) ✗ not audited",
          "tool_search (Search the authorized tool catalog) · never audited — discovery loader",
          "GhostTool [not currently available] ✓ audited",
          "Back",
        ]);
        return "read (Read files)  ✗ not audited";
      },
      (title, options) => {
        assert.ok(title.endsWith("— Enter toggles — 2 audited"), title);
        // The toggled row keeps its identity and is now checked.
        assert.ok(options.includes("read (Read files)  ✓ audited"), options.join(" | "));
        return "tool_search (Search the authorized tool catalog)  · never audited — discovery loader";
      },
      (title, options) => {
        // Pressing Enter on the loader row cannot make it audited: the count and
        // the row marker are unchanged, and a notice says why.
        assert.ok(title.endsWith("— Enter toggles — 2 audited"), title);
        assert.ok(options.includes("tool_search (Search the authorized tool catalog)  · never audited — discovery loader"), options.join(" | "));
        return back(title, options);
      },
      back,
      back,
      save,
    ]);
    await registered.handler("", context);
    // No text field is ever opened for names: nothing is typed, pasted, or
    // comma-parsed; a name is staged only by toggling a row.
    assert.deepEqual(editors, [], JSON.stringify(editors));
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    // Exact names only, order preserved, and the saved name the live inventory
    // does not offer is retained, not dropped. The reserved discovery loader is
    // NOT among them: this gate never audits it, so no picker action can stage
    // a name the runtime would ignore.
    assert.deepEqual(saved.toolProtection.toolNames, ["GhostTool", "read"]);
    assert.ok(notices.some((notice) => notice.type === "warning" && notice.message.includes("NOT AUDITED")), JSON.stringify(notices));
    assert.ok(notices.some((notice) => notice.message.includes("tool-discovery loader")
      && notice.message.includes("never audits")), JSON.stringify(notices));
    assert.deepEqual(config.toolProtection?.toolNames, ["GhostTool", "read"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("leaving the audit picker with nothing checked is refused, so an empty audit subset is never staged", async () => {
  const { dir, configPath, config } = await tempConfig({
    enabled: false,
    review: { activeReviewers: [] },
    ...fourAdapters,
    toolProtection: { level: "dangerous", auditor: { source: "external", id: "generic-auditor" }, scope: "selected", toolNames: ["GhostTool"] },
  });
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath, getToolChoices: () => [{ name: "read" }] });
    const { context, notices } = scripted([
      ...intoProtection,
      pick("Audited tool names"),
      (title, options) => {
        assert.ok(title.endsWith("— Enter toggles — 1 audited"), title);
        return "GhostTool [not currently available]  ✓ audited";
      },
      (title, options) => {
        assert.ok(title.endsWith("— Enter toggles — 0 audited"), title);
        assert.ok(options.includes("GhostTool [not currently available]  ✗ not audited"), options.join(" | "));
        return back(title, options);
      },
      back,
      back,
      save,
    ]);
    await registered.handler("", context);
    assert.ok(notices.some((notice) => notice.type === "error" && notice.message.includes("at least one exact tool name")
      && notice.message.includes("nothing changed")
      && notice.message.includes("All calls")), JSON.stringify(notices));
    // The empty subset never reached the staged draft, so Save wrote the stored
    // names unchanged instead of failing core's strict validation.
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.toolProtection.toolNames, ["GhostTool"]);
    assert.deepEqual(config.toolProtection?.toolNames, ["GhostTool"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an enabled level with no auditor and an empty selected scope are refused without turning protection Off", async () => {
  const { dir, configPath, original, config } = await tempConfig({
    enabled: false,
    review: { activeReviewers: [] },
    ...fourAdapters,
    toolProtection: { level: "off", auditor: null },
  });
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context, notices } = scripted([
      ...intoProtection,
      pick("Auditor"),
      pick("No auditor"),
      pick("Protection level"),
      pickExact("Dangerous plus task alignment (aligned)"),
      back,
      back,
      save,
      save,
      cancel,
    ]);
    await registered.handler("", context);
    assert.ok(notices.some((notice) => notice.type === "error"
      && notice.message.includes("requires an auditor")
      && notice.message.includes("not silently turned Off")), JSON.stringify(notices));
    assert.equal(await readFile(configPath, "utf8"), original, "the missing auditor blocks the write");
    assert.equal(config.toolProtection?.level, "off", "nothing is applied live either");
    assert.equal(config.toolProtection?.auditor, null, "no auditor was invented to force the write through");

    // Root Escape (session-only apply) is rejected by the same rule.
    const escapeHarness = commandHarness();
    registerReviewSettings({ pi: escapeHarness.pi, config, configPath });
    const escape = scripted([
      ...intoProtection,
      pick("Protection level"),
      pickExact("Workspace and temporary-root intent (workspace)"),
      back,
      back,
      () => undefined,
      cancel,
    ]);
    await escapeHarness.handler("", escape.context);
    assert.ok(escape.notices.some((notice) => notice.type === "error" && notice.message.includes("requires an auditor")), JSON.stringify(escape.notices));
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.equal(getPendingSessionDelta(config), undefined, "a rejected session apply records no pending delta");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validation keeps an unresolved auditor a warning while core's rules stay errors", () => {
  const config = normalizeConfig({ enabled: false, ...fourAdapters });
  const base = stagedToolProtectionSettings(config);
  assert.deepEqual(validateToolProtectionSelection({ ...base, level: "dangerous", auditor: null }, config, []), {
    error: validateToolProtectionSelection({ ...base, level: "dangerous", auditor: null }, config, []).error,
    warnings: [],
  });
  assert.match(validateToolProtectionSelection({ ...base, level: "aligned", auditor: null }, config, []).error ?? "", /requires an auditor/);
  assert.match(validateToolProtectionSelection({ ...base, level: "aligned", auditor: { source: "external", id: "generic-auditor" }, scope: "selected", toolNames: [] }, config, []).error ?? "", /at least one exact tool name/);

  // A deleted/unconfigured external auditor and an out-of-route Pi model are
  // warnings: the selection is saved as chosen and the runtime says so.
  const unresolved = validateToolProtectionSelection({ ...base, level: "workspace", auditor: { source: "external", id: "gone-today" } }, config, []);
  assert.equal(unresolved.error, undefined);
  assert.ok(unresolved.warnings.some((warning) => warning.includes("unresolved selection") && warning.includes("stay blocked")), JSON.stringify(unresolved.warnings));
  const codex = validateToolProtectionSelection({ ...base, level: "dangerous", auditor: { source: "external", id: "codex-auditor" } }, config, []);
  assert.equal(codex.error, undefined);
  assert.ok(codex.warnings.some((warning) => warning.includes("no-tools route is unproven")), JSON.stringify(codex.warnings));
  // The runner starts no process for a Claude auditor today, so the picker
  // label and the Save warning must say so rather than leave an apparently
  // usable choice that blocks every audited call.
  const claude = validateToolProtectionSelection({ ...base, level: "dangerous", auditor: { source: "external", id: "claude-auditor" } }, config, []);
  assert.equal(claude.error, undefined, "the choice stays selectable and nothing is substituted");
  assert.ok(claude.warnings.some((warning) => warning.includes("Claude CLI") && warning.includes("retry disabling") && warning.includes("every audited call is blocked")), JSON.stringify(claude.warnings));
  const unscoped = validateToolProtectionSelection({ ...base, level: "dangerous", auditor: { source: "pi", model: "anthropic/claude-opus-4-1" } }, config, []);
  assert.ok(unscoped.warnings.some((warning) => warning.includes("not currently scoped")), JSON.stringify(unscoped.warnings));
  assert.ok(unscoped.warnings.every((warning) => !warning.includes("until that model is scoped")));
  // The ordinary reduced-coverage warning names the configured exact subset and
  // says every other tool is not audited.
  const auditor = { source: "external", id: "generic-auditor" } as const;
  const subset = validateToolProtectionSelection(
    { ...base, level: "dangerous", auditor, scope: "selected", toolNames: ["read", "write"] }, config, []);
  assert.equal(subset.error, undefined);
  assert.ok(subset.warnings.some((warning) => warning.includes("exact tool names: read, write.")
    && warning.includes("Every other tool is NOT AUDITED")), JSON.stringify(subset.warnings));
  // Off with no auditor is complete silence: no error, no warning.
  assert.deepEqual(validateToolProtectionSelection(base, config, []), { warnings: [] });
});

// ---------------------------------------------------------------------------
// Auditor lifecycle through the external-worker catalog, and the reference guard
// ---------------------------------------------------------------------------

test("a worker rename follows the auditor id while a delete keeps the unresolved selection and level with a warning", () => {
  const opening = normalizeConfig({
    enabled: false,
    externalAgents: { aud: { adapter: "claude-cli", review: {} } },
    toolProtection: { level: "workspace", auditor: { source: "external", id: "aud" } },
  });
  const renamed = changeExternalAgent(opening, "aud", "aud2", opening.externalAgents!.aud);
  assert.deepEqual(renamed.config.toolProtection, { level: "workspace", auditor: { source: "external", id: "aud2" }, scope: "all", toolNames: [], timeoutMs: 10_000, maxContextChars: 128_000, retainAuditorSessions: false, debug: false });
  assert.deepEqual(renamed.warnings, []);
  assert.ok(renamed.notices.some((notice) => notice.includes("Tool protection auditor reference updated to aud2")), JSON.stringify(renamed.notices));

  const deleted = changeExternalAgent(opening, "aud");
  // Retained, not Off, and not substituted: the level and the id both survive.
  assert.deepEqual(deleted.config.toolProtection?.level, "workspace");
  assert.deepEqual(deleted.config.toolProtection?.auditor, { source: "external", id: "aud" });
  assert.equal(deleted.warnings.length, 1, JSON.stringify(deleted.warnings));
  assert.match(deleted.warnings[0]!, /still selects the deleted worker aud/);
  assert.match(deleted.warnings[0]!, /stay blocked until you choose an available auditor/);
});

test("the optimistic external-agent guard includes the tool-protection auditor", () => {
  const opening = normalizeConfig({
    enabled: false,
    externalAgents: { aud: { adapter: "claude-cli", review: {} }, other: { adapter: "claude-cli", review: {} }, unrelated: { adapter: "claude-cli", review: {} } },
    toolProtection: { level: "dangerous", auditor: { source: "external", id: "aud" } },
  });
  // Unchanged references on disk pass.
  guardExternalAgentReferences(opening, normalizeConfig(JSON.parse(JSON.stringify(opening))), "aud");
  // A concurrent change of the auditor selection conflicts instead of being
  // overwritten by this transaction's draft.
  const moved = JSON.parse(JSON.stringify(opening)) as Record<string, unknown>;
  (moved.toolProtection as Record<string, unknown>).auditor = { source: "external", id: "other" };
  assert.throws(() => guardExternalAgentReferences(opening, normalizeConfig(moved), "aud"), /references changed on disk/);
  // An unrelated auditor (a different agent is being renamed) is not affected.
  assert.doesNotThrow(() => guardExternalAgentReferences(opening, normalizeConfig(JSON.parse(JSON.stringify(opening))), "other"));
  assert.doesNotThrow(() => guardExternalAgentReferences(opening, normalizeConfig(moved), "unrelated"), "moving the auditor between other agents must not conflict an unrelated edit");
  // Only references to the affected agent participate in its guard.
  assert.equal((externalAgentReferences(opening, "aud") as { toolProtection?: string }).toolProtection, "external:aud");
  assert.equal((externalAgentReferences(opening, "other") as { toolProtection?: string }).toolProtection, undefined);
  assert.equal((externalAgentReferences(normalizeConfig({ enabled: false }), "aud") as { toolProtection?: string }).toolProtection, undefined);
});

test("deleting the active auditor through the menu keeps the selection and level and still saves", async () => {
  const { dir, configPath, config } = await tempConfig({
    enabled: false,
    review: { activeReviewers: [] },
    externalAgents: { "generic-auditor": { adapter: "generic-cli", command: "audit-bin", review: {} } },
    toolProtection: { level: "aligned", auditor: { source: "external", id: "generic-auditor" } },
  });
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context, notices } = scripted([
      pick("External workers"),
      pickExact("generic-auditor [generic-cli]"),
      pickExact("Delete"),
      back,
      save,
    ]);
    await registered.handler("", context);
    assert.ok(notices.some((notice) => notice.type === "warning" && notice.message.includes("still selects the deleted worker generic-auditor")), JSON.stringify(notices));
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.externalAgents, {});
    assert.equal(saved.toolProtection.level, "aligned", "the gate is never silently switched Off");
    assert.deepEqual(saved.toolProtection.auditor, { source: "external", id: "generic-auditor" }, "no substitute auditor is chosen");
    assert.ok(notices.some((notice) => notice.type === "warning" && notice.message.includes("unresolved selection")), JSON.stringify(notices));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The staged transaction: Escape, Cancel, and never inventing a block
// ---------------------------------------------------------------------------

test("root Escape applies the staged block for the session and a later Cancel keeps that applied state", async () => {
  const { dir, configPath, original, config } = await tempConfig({
    enabled: false,
    review: { activeReviewers: [] },
    ...fourAdapters,
    toolProtection: { level: "off", auditor: null },
  });
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const first = scripted([
      ...intoProtection,
      pick("Protection level"),
      pickExact("Dangerous only (dangerous)"),
      pick("Auditor"),
      pick("claude-auditor"),
      back,
      back,
      () => undefined,
    ]);
    await registered.handler("", first.context);
    assert.equal(config.toolProtection?.level, "dangerous", "Escape applies the staged level live");
    assert.deepEqual(config.toolProtection?.auditor, { source: "external", id: "claude-auditor" });
    assert.equal(await readFile(configPath, "utf8"), original, "Escape never writes the file");
    assert.ok(first.notices.some((notice) => notice.type === "warning" && notice.message.includes("exact proposed tool name and arguments")), JSON.stringify(first.notices));

    // Reopen and Cancel: the previously applied session choices survive a
    // cancel of nothing, and the file still never changed.
    const reopened = commandHarness();
    registerReviewSettings({ pi: reopened.pi, config, configPath });
    const second = scripted([...intoProtection, pick("Protection level"), pickExact("Off — this added gate does not apply"), back, back, cancel]);
    await reopened.handler("", second.context);
    assert.equal(config.toolProtection?.level, "dangerous", "Cancel discards the draft, including choices applied earlier in the session");
    assert.equal(await readFile(configPath, "utf8"), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistence never invents a block for an unchanged default and always writes a real change", () => {
  const defaults = stagedToolProtectionSettings(normalizeConfig({}));
  assert.equal(toolProtectionStagedWriteNeeded(undefined, defaults), false, "an absent block stays absent");
  assert.equal(toolProtectionStagedWriteNeeded({ level: "off", auditor: null }, defaults), false, "an identical stored block is untouched");
  assert.equal(toolProtectionStagedWriteNeeded({ level: "dangerous", auditor: { source: "external", id: "x" }, scope: "all", toolNames: [], timeoutMs: 10_000, maxContextChars: 128_000 }, defaults), true,
    "turning a stored enabled block Off is always written");
  assert.equal(toolProtectionStagedWriteNeeded(undefined, { ...defaults, timeoutMs: 20_000 }), true);
  assert.equal(toolProtectionStagedWriteNeeded("nonsense", defaults), true, "a malformed stored block is replaced by an explicit apply");
});

test("a Save with no protection change leaves an absent block absent and preserves unrelated JSON", async () => {
  const { dir, configPath } = await tempConfig({ enabled: false, review: { activeReviewers: [] }, customFutureKey: { keep: true } });
  try {
    await persistReviewSettings(configPath, {
      operatingMode: "execute",
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
      retainBundles: "on-failure",
      maxWorkers: 2,
      retryPolicy: { maxRetries: 2, baseDelayMs: 1_000, maxDelayMs: 30_000, maxSameIncidentRepeats: 2, jitter: false },
      subtaskNotifications: "quiet",
      subtasksViewExpanded: false,
      toolProtection: stagedToolProtectionSettings(normalizeConfig({})),
    });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(saved.toolProtection, undefined, "no protection block is invented");
    assert.deepEqual(saved.customFutureKey, { keep: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Review pass 1 regressions: startup-error recovery, and stored Pi reasoning
// ---------------------------------------------------------------------------

test("a stored block that failed startup validation is replaced by Save, which is how the startup error recovers", async () => {
  // Core requires `level` whenever the block is present, and a tool-name list
  // must be a list, so both shapes are rejected at load. The menu then displays
  // the effective defaults, and saving those defaults MUST replace the invalid
  // block: treating it as "already says this" would skip the write and leave
  // Save failing on the unchanged stored block.
  for (const invalid of [{}, { toolNames: null, futureKey: { keep: true } }]) {
    const dir = await mkdtemp(join(tmpdir(), "pi-review-protection-"));
    const configPath = join(dir, "review-gate.json");
    const body = { enabled: false, review: { activeReviewers: [] }, ...fourAdapters, toolProtection: invalid, customFutureKey: "keep" };
    await writeFile(configPath, JSON.stringify(body), "utf8");
    try {
      // Exactly what the extension does at load: the invalid block is dropped
      // from the live config and the derived startup error is set.
      const recovered = recoverConfig(JSON.parse(JSON.stringify(body)));
      assert.match(recovered.toolProtectionError ?? "", /toolProtection is invalid/);
      assert.equal(recovered.config.toolProtection, undefined, "an invalid block never recovers into a live value");
      (recovered.config as { toolProtectionError?: string }).toolProtectionError = recovered.toolProtectionError;
      let savedCalls = 0;
      const registered = commandHarness();
      registerReviewSettings({ pi: registered.pi, config: recovered.config, configPath, onSaved: () => { savedCalls += 1; } });
      // Nothing is changed in the menu: the displayed defaults ARE the fix.
      const { context, notices } = scripted([...intoProtection, back, back, save]);
      await registered.handler("", context);
      assert.ok(!notices.some((notice) => notice.type === "error"), JSON.stringify(notices));
      assert.equal(savedCalls, 1, "the existing save path ran");
      const saved = JSON.parse(await readFile(configPath, "utf8"));
      assert.doesNotThrow(() => normalizeConfig(saved), "the saved record validates");
      assert.equal(saved.toolProtection.level, "off");
      assert.equal(saved.toolProtection.auditor, null);
      assert.equal(saved.toolProtection.scope, "all");
      assert.deepEqual(saved.toolProtection.toolNames, []);
      assert.equal(saved.toolProtection.timeoutMs, 10_000);
      assert.deepEqual(saved.toolProtection.futureKey, Object.hasOwn(invalid, "futureKey") ? { keep: true } : undefined, "unrelated keys inside the block survive the replacement");
      assert.deepEqual(saved.customFutureKey, "keep");
      assert.equal((recovered.config as { toolProtectionError?: string }).toolProtectionError, undefined, "the derived startup error clears with the saved valid block");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("re-selecting the current Pi auditor keeps its stored reasoning level when the reasoning dialog is cancelled", async () => {
  const { dir, configPath, config } = await tempConfig({
    enabled: false,
    review: { activeReviewers: [] },
    toolProtection: { level: "dangerous", auditor: { source: "pi", model: "anthropic/claude-opus-4-1", thinkingLevel: "low" } },
  });
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context, notices } = scripted([
      ...intoProtection,
      (title, options) => {
        assert.ok(options[1]!.includes("claude-opus-4-1 [anthropic] · reasoning Low"), options[1]);
        return pick("Auditor")(title, options);
      },
      (title, options) => {
        assert.deepEqual(options, ["claude-opus-4-1 [anthropic]  current", "Back"]);
        return "claude-opus-4-1 [anthropic]  current";
      },
      (title, options) => {
        // The dialog opens on the SAVED level, not on the model's default
        // (this session's scoped model is pinned High), so cancelling it — and
        // merely re-selecting the current auditor — cannot move the auditor to
        // a more expensive reasoning level.
        assert.equal(title, "Reasoning — claude-opus-4-1 [anthropic]");
        assert.deepEqual(options, ["Off", "Minimal", "Low  current", "Medium", "High"]);
        return undefined;
      },
      back,
      back,
      save,
    ], { scopedModels: [scopedOpus] });
    await registered.handler("", context);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.toolProtection.auditor, { source: "pi", model: "anthropic/claude-opus-4-1", thinkingLevel: "low" });
    assert.deepEqual(config.toolProtection?.auditor, { source: "pi", model: "anthropic/claude-opus-4-1", thinkingLevel: "low" });
    assert.ok(!notices.some((notice) => notice.type === "error"), JSON.stringify(notices));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Optional auditor-session retention (#536)
// ---------------------------------------------------------------------------

/** A stored block with an enabled level, a resolving auditor, and retention Off. */
function retentionBody(retain: boolean): Record<string, unknown> {
  return {
    enabled: false,
    review: { activeReviewers: [] },
    externalAgents: { "auditor-1": { adapter: "generic-cli", command: "audit-bin", review: {} } },
    toolProtection: {
      level: "dangerous",
      auditor: { source: "external", id: "auditor-1" },
      scope: "all",
      toolNames: [],
      timeoutMs: 10_000,
      maxContextChars: 128_000,
      retainAuditorSessions: retain,
    },
    customFutureKey: "keep",
  };
}

test("turning auditor-session retention on discloses the behavior, confirms it, and persists only that field", async () => {
  const { dir, configPath, config } = await tempConfig(retentionBody(false));
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context, confirmations } = scripted([
      ...intoProtection,
      (title, options) => {
        assert.ok(flat(options).includes("Save auditor sessions Off — audits are not saved"), flat(options).join(" | "));
        return pick("Save auditor sessions")(title, options);
      },
      (title, options) => {
        assert.ok(flat(options).some((option) => option.startsWith("Save auditor sessions On")
          && option.includes("session you can browse")), flat(options).join(" | "));
        return back(title, options);
      },
      back,
      save,
    ], { confirm: true });
    await registered.handler("", context);

    assert.equal(confirmations.length, 1, JSON.stringify(confirmations));
    assert.equal(confirmations[0]!.title, "Save every auditor session?");
    const disclosure = confirmations[0]!.message;
    for (const phrase of [
      "ordinary saved Pi session",
      "one session per audit",
      "never read back into a later decision",
      "grants the auditor no tools or authority",
      "kept until you delete them",
      "you keep the auditor's verdict and see a warning",
      "Nothing is written while this is Off",
    ]) {
      assert.ok(disclosure.includes(phrase), `disclosure is missing "${phrase}": ${disclosure}`);
    }

    const saved = JSON.parse(await readFile(configPath, "utf8")) as { toolProtection: Record<string, unknown>; customFutureKey?: string };
    assert.equal(saved.toolProtection.retainAuditorSessions, true);
    assert.equal(saved.toolProtection.level, "dangerous", "no other owned field changed");
    assert.equal(saved.customFutureKey, "keep", "unrelated raw JSON survives");
    assert.equal(config.toolProtection?.retainAuditorSessions, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("declining the retention confirmation stages nothing, applies nothing, and writes nothing", async () => {
  const { dir, configPath, original, config } = await tempConfig(retentionBody(false));
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context, confirmations } = scripted([
      ...intoProtection,
      pick("Save auditor sessions"),
      back,
      back,
      cancel,
    ], { confirm: false });
    await registered.handler("", context);
    assert.equal(confirmations.length, 1);
    assert.equal(await readFile(configPath, "utf8"), original, "a declined disclosure never writes the file");
    assert.equal(config.toolProtection?.retainAuditorSessions, false, "and never applies for the session either");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("turning retention back Off needs no confirmation and is written as a real change", async () => {
  const { dir, configPath, config } = await tempConfig(retentionBody(true));
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context, confirmations } = scripted([
      ...intoProtection,
      (title, options) => {
        assert.ok(flat(options).some((option) => option.startsWith("Save auditor sessions On")), flat(options).join(" | "));
        return pick("Save auditor sessions")(title, options);
      },
      back,
      back,
      save,
    ], { confirm: true });
    await registered.handler("", context);
    assert.deepEqual(confirmations, [], "stopping a side effect is never blocked by a confirmation");
    const saved = JSON.parse(await readFile(configPath, "utf8")) as { toolProtection: Record<string, unknown> };
    assert.equal(saved.toolProtection.retainAuditorSessions, false);
    assert.equal(config.toolProtection?.retainAuditorSessions, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("root Escape applies retention for the session only and leaves the stored file untouched", async () => {
  const { dir, configPath, original, config } = await tempConfig(retentionBody(false));
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context } = scripted([
      ...intoProtection,
      pick("Save auditor sessions"),
      back,
      back,
      () => undefined,
      cancel,
    ], { confirm: true });
    await registered.handler("", context);
    assert.equal(config.toolProtection?.retainAuditorSessions, true, "Escape applies the staged choice for this session");
    assert.equal(await readFile(configPath, "utf8"), original, "Escape never writes to disk");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retention is an owned field of the stored block for change detection", () => {
  const defaults = stagedToolProtectionSettings(normalizeConfig({}));
  assert.equal(defaults.retainAuditorSessions, false);
  assert.equal(toolProtectionStagedWriteNeeded(undefined, defaults), false, "an absent block stays absent");
  assert.equal(toolProtectionStagedWriteNeeded(undefined, { ...defaults, retainAuditorSessions: true }), true,
    "turning retention on over an absent block is a real change");
  const stored = retentionBody(false).toolProtection as Record<string, unknown>;
  assert.equal(toolProtectionStagedWriteNeeded(stored, { ...defaults, level: "dangerous", auditor: { source: "external", id: "auditor-1" }, retainAuditorSessions: true }), true);
  assert.equal(toolProtectionStagedWriteNeeded(retentionBody(true).toolProtection as Record<string, unknown>, {
    ...defaults, level: "dangerous", auditor: { source: "external", id: "auditor-1" }, retainAuditorSessions: true,
  }), false, "an identical stored block is untouched");
  // A stored block that predates the field differs from the staged default only
  // by normalization, so an unchanged menu never rewrites it, and recovery keeps
  // the legacy block intact.
  const legacy = { level: "dangerous", auditor: { source: "external", id: "auditor-1" } };
  assert.equal(recoverConfig({ toolProtection: legacy }).config.toolProtection?.retainAuditorSessions, false);
});

// ---------------------------------------------------------------------------
// Optional audit debug output (#549)
// ---------------------------------------------------------------------------

/**
 * A stored block with an enabled level and a resolving auditor. `debug: undefined`
 * stores a block that predates the field, exactly as an older configuration does.
 */
function debugBody(debug: boolean | undefined): Record<string, unknown> {
  const toolProtection: Record<string, unknown> = {
    level: "dangerous",
    auditor: { source: "external", id: "auditor-1" },
    scope: "all",
    toolNames: [],
    timeoutMs: 10_000,
    maxContextChars: 128_000,
    retainAuditorSessions: false,
  };
  if (debug !== undefined) toolProtection.debug = debug;
  return {
    enabled: false,
    review: { activeReviewers: [] },
    externalAgents: { "auditor-1": { adapter: "generic-cli", command: "audit-bin", review: {} } },
    toolProtection,
    customFutureKey: "keep",
  };
}

test("Debug audit output toggles in the existing submenu, discloses its limits, and persists only that field", async () => {
  const { dir, configPath, config } = await tempConfig(debugBody(false));
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context, notices, confirmations } = scripted([
      ...intoProtection,
      (title, options) => {
        assert.ok(flat(options).includes("Debug audit output Off — only what a call already reports is shown"), flat(options).join(" | "));
        return pick("Debug audit output")(title, options);
      },
      (title, options) => {
        assert.ok(flat(options).includes("Debug audit output On — audit diagnostics are shown to you"), flat(options).join(" | "));
        return back(title, options);
      },
      back,
      save,
    ], { confirm: true });
    await registered.handler("", context);

    assert.deepEqual(confirmations, [], "a display-only switch is never blocked by a confirmation");
    assert.ok(!notices.some((notice) => notice.type === "error"), JSON.stringify(notices));
    const disclosure = notices.find((notice) => notice.message.includes("Debug audit output staged as On"));
    assert.ok(disclosure, JSON.stringify(notices));
    for (const phrase of [
      "does not enable or disable protection",
      "does not audit or skip anything",
      "does not save auditor sessions",
      "does not contact a model or provider",
      "does not send the acting model anything about a call that passed or was not audited",
      "Failures and audit errors are reported either way",
      "Nothing applies until root Escape (this session) or Save/Ctrl+S (disk)",
    ]) {
      assert.ok(disclosure.message.includes(phrase), `disclosure is missing "${phrase}": ${disclosure.message}`);
    }

    const saved = JSON.parse(await readFile(configPath, "utf8")) as { toolProtection: Record<string, unknown>; customFutureKey?: string };
    assert.equal(saved.toolProtection.debug, true);
    assert.equal(saved.toolProtection.level, "dangerous", "no other owned field changed");
    assert.equal(saved.toolProtection.retainAuditorSessions, false, "retention stays a separate choice");
    assert.equal(saved.customFutureKey, "keep", "unrelated raw JSON survives");
    assert.equal(config.toolProtection?.debug, true);
    assert.deepEqual(await readdir(dir), ["review-gate.json"], "toggling debug recorded nothing anywhere in the config directory");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stored block without the debug field displays Off and saving it is a real change", async () => {
  const { dir, configPath, config } = await tempConfig(debugBody(undefined));
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context } = scripted([
      ...intoProtection,
      (title, options) => {
        assert.ok(flat(options).includes("Debug audit output Off — only what a call already reports is shown"), flat(options).join(" | "));
        return pick("Debug audit output")(title, options);
      },
      back,
      back,
      save,
    ]);
    await registered.handler("", context);
    const saved = JSON.parse(await readFile(configPath, "utf8")) as { toolProtection: Record<string, unknown> };
    assert.equal(saved.toolProtection.debug, true, "the legacy block gains the field only when the user changes it");
    assert.equal(saved.toolProtection.retainAuditorSessions, false, "and every other stored field is preserved");
    assert.equal(config.toolProtection?.debug, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("turning debug back Off needs no confirmation and is written as a real change", async () => {
  const { dir, configPath, config } = await tempConfig(debugBody(true));
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context, confirmations } = scripted([
      ...intoProtection,
      (title, options) => {
        assert.ok(flat(options).includes("Debug audit output On — audit diagnostics are shown to you"), flat(options).join(" | "));
        return pick("Debug audit output")(title, options);
      },
      back,
      back,
      save,
    ], { confirm: true });
    await registered.handler("", context);
    assert.deepEqual(confirmations, [], "stopping extra output is never blocked by a confirmation");
    const saved = JSON.parse(await readFile(configPath, "utf8")) as { toolProtection: Record<string, unknown> };
    assert.equal(saved.toolProtection.debug, false);
    assert.equal(config.toolProtection?.debug, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("root Escape applies debug for the session only and leaves the stored file untouched", async () => {
  const { dir, configPath, original, config } = await tempConfig(debugBody(false));
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context } = scripted([
      ...intoProtection,
      pick("Debug audit output"),
      back,
      back,
      () => undefined,
    ]);
    await registered.handler("", context);
    assert.equal(config.toolProtection?.debug, true, "Escape applies the staged choice for this session");
    assert.equal(await readFile(configPath, "utf8"), original, "Escape never writes to disk");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Cancel discards a staged debug change without applying or writing it", async () => {
  const { dir, configPath, original, config } = await tempConfig(debugBody(false));
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const { context } = scripted([
      ...intoProtection,
      pick("Debug audit output"),
      back,
      back,
      cancel,
    ]);
    await registered.handler("", context);
    assert.equal(config.toolProtection?.debug, false, "Cancel leaves the live configuration unchanged");
    assert.equal(await readFile(configPath, "utf8"), original, "and the stored file byte for byte");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("debug is an owned field of the stored block for change detection", () => {
  const defaults = stagedToolProtectionSettings(normalizeConfig({}));
  assert.equal(defaults.debug, false);
  assert.equal(toolProtectionStagedWriteNeeded(undefined, defaults), false, "an absent block stays absent");
  assert.equal(toolProtectionStagedWriteNeeded(undefined, { ...defaults, debug: true }), true,
    "turning debug on over an absent block is a real change");
  const stored = debugBody(false).toolProtection as Record<string, unknown>;
  assert.equal(toolProtectionStagedWriteNeeded(stored, { ...defaults, level: "dangerous", auditor: { source: "external", id: "auditor-1" }, debug: true }), true);
  assert.equal(toolProtectionStagedWriteNeeded(debugBody(true).toolProtection as Record<string, unknown>, {
    ...defaults, level: "dangerous", auditor: { source: "external", id: "auditor-1" }, debug: true,
  }), false, "an identical stored block is untouched");
  // A stored block that predates the field differs from the staged default only
  // by normalization, so an unchanged menu never rewrites it, and recovery keeps
  // the legacy block intact with debug Off.
  const legacy = { level: "dangerous", auditor: { source: "external", id: "auditor-1" } };
  assert.equal(recoverConfig({ toolProtection: legacy }).config.toolProtection?.debug, false);
  assert.equal(toolProtectionStagedWriteNeeded(legacy, { ...defaults, level: "dangerous", auditor: { source: "external", id: "auditor-1" } }), false,
    "an unchanged legacy block is not rewritten just to add the field");
});
