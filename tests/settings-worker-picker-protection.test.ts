/**
 * Focused regression coverage for issue #604 on the production worker picker.
 * Every case drives the real `/review-settings` entrypoint into the Worker
 * resources pool editor, so the assertions cover the shipped
 * `visitWorkerResources` / executor-model selection rather than a re-implementation:
 *
 * - a valid Claude or Codex worker definition is offered and selectable at every
 *   Protection level, including with no `toolProtection` block at all;
 * - a stored block that could not be validated never hides such a definition:
 *   the picker shows the same rows and produces the same staged result;
 * - a definition with no execution role stays out of the executor list;
 * - listing definitions enrolls nothing: pool membership and both role routes
 *   change only through an explicit Add, so a worker that is merely defined and
 *   listed stays absent from a route until the user adds it there.
 *
 * No external worker, CLI, provider call, credential, or network access runs in
 * this file: the definitions name commands that are never launched.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { clearToolProtectionLoadError, noteToolProtectionLoadError } from "../src/tool-protection/coordinator";
import { PROTECTION_LEVELS, type ProtectionLevel } from "../src/tool-protection/config";

const MALFORMED_LOAD_ERROR = "toolProtection is invalid, so tool protection is unavailable and protected calls stay blocked until a valid configuration is saved: toolProtection.level must be one of: off, dangerous, aligned, workspace";

const CLAUDE_ROWS = "synthetic-claude [claude-cli]";
const CODEX_ROWS = "synthetic-codex [codex-cli]";

/** Every level plus the no-block default, so no level can hide a definition. */
const LEVELS: Array<ProtectionLevel | "unset"> = [...PROTECTION_LEVELS, "unset"];

/** One stored config carrying both application worker definitions plus a decision-only one. */
function seedConfig(level: ProtectionLevel | "unset"): Record<string, unknown> {
  const config: Record<string, unknown> = {
    enabled: false,
    review: { activeReviewers: [] },
    externalAgents: {
      "synthetic-claude": {
        adapter: "claude-cli",
        command: "synthetic-claude-cli",
        model: "synthetic-claude-model",
        execution: { timeoutMs: 30_000 },
      },
      "synthetic-codex": {
        adapter: "codex-cli",
        command: "synthetic-codex-cli",
        model: "synthetic-codex-model",
        execution: { timeoutMs: 30_000 },
      },
      // A decision-only definition: it has a review role and no execution role,
      // so it is not an acting worker and the executor picker must never list it.
      "synthetic-auditor": {
        adapter: "generic-cli",
        command: "synthetic-auditor-cli",
        review: { timeoutMs: 30_000 },
      },
    },
    execution: {},
  };
  if (level !== "unset") {
    config.toolProtection = {
      level,
      auditor: { source: "pi", model: "synthetic/model", thinkingLevel: "high" },
      scope: "all",
      toolNames: [],
      timeoutMs: 5_000,
      maxContextChars: 200_000,
      retainAuditorSessions: false,
    };
  }
  return config;
}

interface FlowOutcome {
  saved: Record<string, any>;
  /** Option rows the production executor-model picker showed, in show order. */
  modelRows: string[][];
}

/**
 * Open the pool editor through the real settings entrypoint, add the Claude and
 * then the Codex definition explicitly, and save. The recorded option lists are
 * what the shipped picker actually offered at each Add.
 */
async function runExplicitAddFlow(level: ProtectionLevel | "unset", loadError?: string): Promise<FlowOutcome> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-604-worker-picker-"));
  try {
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify(seedConfig(level)), "utf8");
    const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")) as ReviewGateConfig);
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const shown: Array<{ title: string; options: string[] }> = [];
    noteToolProtectionLoadError(loadError);
    try {
      await registered.handler("", scriptedContext([
        rootSettingsRow("Worker resources", "0 models · 0 slots"),
        "Add worker resource",
        CLAUDE_ROWS,
        "1  current",
        "Add worker resource",
        CODEX_ROWS,
        "1  current",
        "Back",
        "Save changes",
      ], shown));
    } finally {
      clearToolProtectionLoadError();
    }
    return {
      saved: JSON.parse(await readFile(configPath, "utf8")),
      modelRows: shown.filter((menu) => menu.title === "Executor model").map((menu) => menu.options),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("the production worker picker offers every execution-capable Claude and Codex definition at every Protection level", async () => {
  for (const level of LEVELS) {
    const outcome = await runExplicitAddFlow(level);
    assert.equal(outcome.modelRows.length, 2, `one executor-model picker per explicit Add at level ${level}`);
    const [first, second] = outcome.modelRows as [string[], string[]];
    assert.ok(first.includes(CLAUDE_ROWS), `the Claude definition is offered at level ${level}: ${first.join(" | ")}`);
    assert.ok(first.includes(CODEX_ROWS), `the Codex definition is offered at level ${level}: ${first.join(" | ")}`);
    // The already-pooled selection stays out of the second Add; that exclusion is
    // unrelated to Protection and survives unchanged.
    assert.ok(second.includes(CODEX_ROWS), `the Codex definition is still offered after the first Add at level ${level}: ${second.join(" | ")}`);
    assert.equal(second.includes(CLAUDE_ROWS), false, `the pooled Claude selection is not offered twice at level ${level}`);
    for (const rows of outcome.modelRows) {
      assert.equal(
        rows.some((row) => row.includes("synthetic-auditor")),
        false,
        `the decision-only definition is never offered as an executor at level ${level}: ${rows.join(" | ")}`,
      );
    }
    // The explicit Adds are what enrolled the resources; nothing about the
    // Protection level changed what the picker accepted.
    assert.deepEqual(outcome.saved.execution.workerResources, {
      "external-synthetic-claude": { selection: { source: "external", id: "synthetic-claude" }, maxConcurrent: 1 },
      "external-synthetic-codex": { selection: { source: "external", id: "synthetic-codex" }, maxConcurrent: 1 },
    }, `both definitions became worker resources at level ${level}`);
    assert.deepEqual(outcome.saved.execution.routes.execute, [
      { resourceId: "external-synthetic-codex" },
      { resourceId: "external-synthetic-claude" },
    ], `an explicit Add enrolls the acting resource in Execute at level ${level}`);
    assert.deepEqual(outcome.saved.execution.routes.research, [
      { resourceId: "external-synthetic-codex" },
      { resourceId: "external-synthetic-claude" },
    ], `both application adapters are research-capable, so Add enrolls them in Research at level ${level}`);
    if (level === "unset") {
      assert.equal(outcome.saved.toolProtection, undefined, `the visit never invents a toolProtection block at level ${level}`);
    } else {
      assert.equal(outcome.saved.toolProtection.level, level, `the visit never synthesizes Off or rewrites the stored level ${level}`);
      assert.deepEqual(outcome.saved.toolProtection.auditor, { source: "pi", model: "synthetic/model", thinkingLevel: "high" }, `the auditor selection is retained at level ${level}`);
    }
  }
});

test("an unvalidated stored Protection block shows the same executor rows and stages the same worker resources", async () => {
  const clean = await runExplicitAddFlow("aligned");
  const malformed = await runExplicitAddFlow("aligned", MALFORMED_LOAD_ERROR);
  assert.deepEqual(malformed.modelRows, clean.modelRows, "an unvalidated block neither adds nor hides an executor row");
  assert.ok(malformed.modelRows[0]!.includes(CLAUDE_ROWS) && malformed.modelRows[0]!.includes(CODEX_ROWS), "both application definitions stay selectable under an unvalidated block");
  assert.deepEqual(malformed.saved.execution, clean.saved.execution, "the same explicit Adds stage the same pool and role routes");
});

test("listing worker definitions never enrolls a resource or a route entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-604-worker-picker-passive-"));
  try {
    const configPath = join(dir, "review-gate.json");
    const seeded = seedConfig("workspace");
    seeded.execution = {
      workerResources: {
        // One Claude resource already in the pool, listed only in Execute.
        "external-synthetic-claude": { selection: { source: "external", id: "synthetic-claude" }, maxConcurrent: 2 },
      },
      routes: {
        execute: [{ resourceId: "external-synthetic-claude" }],
        research: [],
      },
    };
    await writeFile(configPath, JSON.stringify(seeded), "utf8");
    const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")) as ReviewGateConfig);
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath });
    const shown: Array<{ title: string; options: string[] }> = [];

    await registered.handler("", scriptedContext([
      rootSettingsRow("Worker resources", "1 model · 2 slots"),
      "Back",
      "Save changes",
    ], shown));

    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(Object.keys(saved.execution.workerResources), ["external-synthetic-claude"], "a passive pool visit adds no resource for a merely defined worker");
    assert.deepEqual(saved.execution.routes.execute, [{ resourceId: "external-synthetic-claude" }], "the Execute route keeps exactly the stored membership");
    assert.deepEqual(saved.execution.routes.research, [], "a research-capable definition that was never added stays out of Research");
    assert.deepEqual(Object.keys(saved.externalAgents), ["synthetic-claude", "synthetic-codex", "synthetic-auditor"], "the definitions stay defined without becoming resources or route entries");
    assert.equal(saved.toolProtection.level, "workspace", "the visit leaves the stored Protection level alone");
    assert.equal(shown.some((menu) => menu.title === "Executor model"), false, "no Add happened, so the executor-model picker never ran");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
  "Subtask notifications",
  "Tools",
  "Subtasks view",
  "Subtask task IDs",
  "Scheduled tasks",
] as const;

function rootSettingsRow(label: typeof ROOT_SETTING_LABELS[number], value: string): string {
  const width = Math.max(...ROOT_SETTING_LABELS.map((candidate) => candidate.length));
  return `${label.padEnd(width)}  ${value}`;
}

function commandHarness(): {
  pi: { registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }): void };
  handler: (args: string, ctx: unknown) => Promise<void>;
} {
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

/** Scripted host UI that records every option list the shipped menus present. */
function scriptedContext(values: Array<string | undefined>, shown: Array<{ title: string; options: string[] }>): unknown {
  let index = 0;
  return {
    scopedModels: [],
    ui: {
      async select(title: string, options: string[]) {
        shown.push({ title, options });
        const value = values[index++];
        if (value !== undefined) assert.ok(options.includes(value), `missing selection ${value}: ${options.join(" | ")}`);
        return value;
      },
      async input() {
        return undefined;
      },
      async confirm(_title: string, _message: string) {
        return false;
      },
      notify() {},
    },
  };
}
