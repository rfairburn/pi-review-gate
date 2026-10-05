import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import Module from "node:module";
import { effectiveReviewSettings, externalAgentCatalog, normalizeConfig, type ExternalAgentConfig, type ReviewGateConfig } from "../src/config";
import { validateSelection } from "../src/settings/validation";
import { validateScheduledTasks } from "../src/settings/scheduled-tasks";
import * as realExternalAgents from "../src/settings/external-agents";
const realCreator = realExternalAgents.selectExternalAgentCreation;

// Exercise selection/persistence with controlled definitions, plus the real
// creation form below to establish the complete menu-to-save path.
let creations: Array<ExternalAgentConfig | undefined> = [];
let useCreationForm = false;
const loader = Module as unknown as { _load: (request: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
loader._load = function (request, ...args) {
  if (request === "./external-agents") return {
    ...realExternalAgents,
    async selectExternalAgentCreation(ui: import("../src/settings/ui").UiContext, draft: ReviewGateConfig) {
      if (useCreationForm) return realCreator(ui, draft);
      const created = creations.shift();
      if (created) assert.equal(Object.hasOwn(draft.externalAgents ?? {}, created.id), false);
      if (!created) return undefined;
      const { id, ...definition } = created;
      return externalAgentCatalog(normalizeConfig({ externalAgents: { [id]: definition } }))[0];
    },
  };
  return originalLoad.call(this, request, ...args);
};
const { registerReviewSettings } = require("../src/settings/command") as typeof import("../src/settings/command");
loader._load = originalLoad;

const definitions: ExternalAgentConfig[] = [
  { id: "codex", adapter: "codex-cli", command: process.execPath, model: "custom-codex", review: {}, execution: {} },
  { id: "claude", adapter: "claude-cli", command: process.execPath, model: "custom-claude", review: {}, execution: {} },
];

type Action = string | undefined | ((options: string[]) => string | undefined);
async function workspace(run: (path: string, config: ReviewGateConfig, original: string) => Promise<void>) {
  const dir = await mkdtemp(join(__dirname, "external-integration-"));
  try {
    const path = join(dir, "config.json");
    const original = JSON.stringify({ enabled: true, review: { primaryReviewers: [], subtaskReviewers: [] }, execution: { workerResources: {}, routes: { execute: [], research: [] } } });
    await writeFile(path, original);
    await run(path, normalizeConfig(JSON.parse(original)), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function menu(path: string, config: ReviewGateConfig, actions: Action[], beforeSave?: () => Promise<void>, inputs: string[] = [], notices: string[] = []) {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  registerReviewSettings({ config, configPath: path, pi: {
    registerCommand(name: string, options: { handler: typeof handler }) {
      if (name === "review-settings") handler = options.handler;
    },
  } });
  assert.ok(handler);
  const warnings: string[] = [];
  await handler("", { scopedModels: [], ui: {
    async select(_title: string, options: string[]) {
      assert.ok(actions.length, `unexpected menu: ${_title}`);
      const action = actions.shift();
      const wanted = typeof action === "function" ? action(options) : action;
      if (wanted === undefined) return undefined;
      const selected = options.find((row) => row === wanted || row.trimStart().startsWith(wanted + " "));
      assert.ok(selected, `missing ${wanted}: ${options.join(" | ")}`);
      if (wanted === "Save changes") await beforeSave?.();
      return selected;
    },
    async input() {
      assert.ok(inputs.length, "unexpected text field");
      return inputs.shift();
    },
    notify(message: string, kind: string) {
      assert.notEqual(kind, "error", message);
      notices.push(message);
      if (kind === "warning") warnings.push(message);
    },
  } });
  assert.equal(actions.length, 0);
  assert.equal(inputs.length, 0);
  return warnings;
}
const createBoth: Action[] = ["External workers", "Create worker", "Create worker", "Back"];
const selectExplicitly: Action[] = [
  "Worker resources", "Add worker resource", "codex [codex-cli]", "1  current",
  "Add worker resource", "claude [claude-cli]", "1  current", "Back",
  "Reviewers", "Primary reviewers", "codex [codex-cli] ✗", "claude [claude-cli] ✗", "Back",
  "Subtask reviewers", "claude [claude-cli] ✗", "codex [codex-cli] ✗", "Back", "Back",
];

test("created definitions resolve for explicit resources and both reviewer layers before Save, then reload", async () => {
  await workspace(async (path, config, original) => {
    const activeBefore = structuredClone(config);
    creations = structuredClone(definitions);
    await menu(path, config, [...createBoth, ...selectExplicitly, "Save changes"], async () => {
      assert.deepEqual(config, activeBefore);
      assert.equal(await readFile(path, "utf8"), original);
    });
    const reloaded = normalizeConfig(JSON.parse(await readFile(path, "utf8")));
    assert.deepEqual(config, reloaded);
    assert.equal(reloaded.externalAgents!.codex.model, "custom-codex");
    assert.equal(reloaded.externalAgents!.claude.model, "custom-claude");
    assert.deepEqual(reloaded.execution!.workerResources, {
      "external-codex": { selection: { source: "external", id: "codex" }, maxConcurrent: 1 },
      "external-claude": { selection: { source: "external", id: "claude" }, maxConcurrent: 1 },
    });
    for (const role of ["execute", "research"] as const) assert.deepEqual(reloaded.execution!.routes![role], [
      { resourceId: "external-codex", thinkingLevel: undefined }, { resourceId: "external-claude", thinkingLevel: undefined },
    ]);
    assert.deepEqual(effectiveReviewSettings(reloaded).primaryReviewers, [{ source: "external", id: "codex" }, { source: "external", id: "claude" }]);
    assert.deepEqual(effectiveReviewSettings(reloaded).subtaskReviewers, [{ source: "external", id: "claude" }, { source: "external", id: "codex" }]);
  });
});

test("creation alone persists definitions without activating resources, routes, or reviewers", async () => {
  await workspace(async (path, config) => {
    creations = structuredClone(definitions);
    await menu(path, config, [...createBoth, "Save changes"]);
    const saved = normalizeConfig(JSON.parse(await readFile(path, "utf8")));
    assert.deepEqual(Object.keys(saved.externalAgents!).sort(), ["claude", "codex"]);
    assert.deepEqual(saved.execution!.workerResources, {});
    assert.deepEqual(saved.execution!.routes, { execute: [], research: [] });
    assert.deepEqual(effectiveReviewSettings(saved).primaryReviewers, []);
    assert.deepEqual(effectiveReviewSettings(saved).subtaskReviewers, []);
  });
});

for (const cancel of ["Cancel", undefined]) test(`root ${cancel ?? "Escape"} discards definitions and explicit selections`, async () => {
  await workspace(async (path, config, original) => {
    const activeBefore = structuredClone(config);
    creations = structuredClone(definitions);
    await menu(path, config, [...createBoth, ...selectExplicitly, cancel]);
    assert.deepEqual(config, activeBefore);
    assert.equal(await readFile(path, "utf8"), original);
  });
});

for (const selected of [false, true]) test(`missing application CLIs save with warnings (${selected ? "selected" : "inactive"}) and strict validation remains blocking`, async () => {
  await workspace(async (path, config) => {
    const previousPath = process.env.PATH;
    // Empty PATH deterministically makes a default CLI unavailable. The
    // configured absolute CLI is also absent. Neither is invoked.
    process.env.PATH = "";
    try {
      creations = definitions.map((definition, index) => ({ ...definition, command: index === 0 ? undefined : join(__dirname, "missing-claude") }));
      const warnings = await menu(path, config, [...createBoth, ...(selected ? selectExplicitly : []), "Save changes"]);
      assert.equal(warnings.length, 2);
      for (const warning of warnings) assert.match(warning, /cannot run until its (Codex|Claude) binary is installed and available/);
      const reloaded = normalizeConfig(JSON.parse(await readFile(path, "utf8")));
      assert.deepEqual(reloaded, config);
      if (selected) {
        assert.match((await validateSelection(reloaded.execution!.workerResources!, effectiveReviewSettings(reloaded).primaryReviewers, reloaded, []))!, /executable is unavailable/);
        const scheduled = { task: { enabled: true, name: "Task", cron: "0 * * * *", instructions: "Do work", workspace: __dirname, kind: "execute" as const, workerResourceId: "external-codex", review: { mode: "selected" as const, reviewers: [{ source: "external" as const, id: "claude" }] } } };
        assert.match((await validateScheduledTasks(scheduled, reloaded.execution!.workerResources!, reloaded, []))!, /executable is unavailable/);
        const scheduleWarnings = new Set<string>();
        assert.equal(await validateScheduledTasks(scheduled, reloaded.execution!.workerResources!, reloaded, [], undefined, { allowMissingApplicationCli: true, warnings: scheduleWarnings }), undefined);
        assert.equal(scheduleWarnings.size, 2);
        // Persist an actual scheduled override through the same root Save.
        reloaded.scheduledTasks = scheduled;
        await writeFile(path, JSON.stringify(reloaded));
        const savedWarnings = await menu(path, reloaded, ["Save changes"]);
        assert.equal(savedWarnings.length, 2);
        assert.deepEqual(normalizeConfig(JSON.parse(await readFile(path, "utf8"))).scheduledTasks, normalizeConfig(reloaded).scheduledTasks);
      }
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

test("unrelated root Save preserves untouched and concurrent latest native legacy fields", async () => {
  await workspace(async (path, config) => {
    const legacy = { adapter: "claude-cli", command: process.execPath, model: "opus", args: ["--effort=high", "literal-secret"],
      execution: { args: ["--effort=low", "--effort=max"], protocol: "pi-review-executor-jsonl-v1" }, review: {} };
    Object.assign(config, normalizeConfig({ ...config, externalAgents: { untouched: legacy } }));
    await writeFile(path, JSON.stringify(config));
    const opening = structuredClone(config.externalAgents!.untouched);
    await menu(path, config, ["Save changes"], async () => {
      const latest = JSON.parse(await readFile(path, "utf8"));
      latest.externalAgents.concurrent = { ...legacy, model: "latest-pinned", reasoningEffort: "default" };
      await writeFile(path, JSON.stringify(latest));
    });
    assert.deepEqual(config.externalAgents!.untouched, opening);
    const expected = normalizeConfig({ externalAgents: { concurrent: { ...legacy, model: "latest-pinned", reasoningEffort: "default" } } });
    assert.deepEqual(config.externalAgents!.concurrent, expected.externalAgents!.concurrent);
    assert.deepEqual(normalizeConfig(JSON.parse(await readFile(path, "utf8"))), config);
  });
});

test("save policy still blocks invalid role references and missing generic/binary executables", async () => {
  for (const adapter of ["generic-cli", "run-as-binary"] as const) {
    const config = normalizeConfig({ enabled: true, externalAgents: { other: {
      adapter, command: join(__dirname, "missing-other"), review: adapter === "run-as-binary" ? { protocol: "pi-reviewer-json-v1" } : {},
      ...(adapter === "run-as-binary" ? { execution: { protocol: "pi-review-executor-jsonl-v1" } } : {}),
    } } });
    const policy = { allowMissingApplicationCli: true, warnings: new Set<string>() };
    assert.match((await validateSelection({}, [{ source: "external", id: "other" }], config, [], [], [], policy))!, /executable is unavailable/);
    if (adapter === "run-as-binary") {
      const resources = { other: { selection: { source: "external" as const, id: "other" }, maxConcurrent: 1 } };
      assert.match((await validateSelection(resources, [], config, [], [], [], policy))!, /executable is unavailable/);
      assert.match((await validateSelection(resources, [], config, [], [], [{ resourceId: "other" }], policy))!, /not research-capable/);
    }
    assert.equal(policy.warnings.size, 0);
  }
  const config = normalizeConfig({ externalAgents: { exec: { adapter: "codex-cli", execution: {} } } });
  assert.match((await validateSelection({}, [{ source: "external", id: "exec" }], config, [], [], [], { allowMissingApplicationCli: true }))!, /External reviewer is unavailable/);
  assert.match((await validateSelection({}, [{ source: "external", id: "missing" }], config, [], [], [], { allowMissingApplicationCli: true }))!, /External reviewer is unavailable/);
  assert.match((await validateSelection({}, [{ source: "external", id: "missing" }, { source: "external", id: "missing" }], config, [], [], [], { allowMissingApplicationCli: true }))!, /Duplicate enabled reviewer/);
});

test("real creation forms share the resource/reviewer draft and persist advanced fields", async () => {
  await workspace(async (path, config, original) => {
    const activeBefore = structuredClone(config);
    const previousPath = process.env.PATH;
    process.env.PATH = "";
    useCreationForm = true;
    try {
      const warnings = await menu(path, config, [
        "External workers", "Create worker", "Codex (codex-cli)", "Identifier:", "Roles:", "Execution and review",
        "Shared model:", "GPT-6.1-Sol", "Shared reasoning:", "High",
        "Advanced review overrides", "Timeout (ms):", "Back", "Create",
        "Create worker", "Claude Code (claude-cli)", "Identifier:", "Roles:", "Execution and review",
        "Create", "Back",
        ...selectExplicitly, "Save changes",
      ], async () => {
        assert.deepEqual(config, activeBefore);
        assert.equal(await readFile(path, "utf8"), original);
      }, ["codex", "60000", "claude"]);
      assert.equal(warnings.length, 2);
      const reloaded = normalizeConfig(JSON.parse(await readFile(path, "utf8")));
      assert.deepEqual(config, reloaded);
      assert.deepEqual(reloaded.externalAgents!.codex.args, []);
      assert.equal(reloaded.externalAgents!.codex.reasoningEffort, "high");
      // GUI-created definitions carry no environment data: the menus expose
      // no env controls, so nothing is staged for a fresh definition.
      assert.equal(reloaded.externalAgents!.codex.env, undefined);
      assert.equal(reloaded.externalAgents!.codex.review!.timeoutMs, 60000);
      assert.equal(reloaded.externalAgents!.claude.command, "claude");
      assert.deepEqual(Object.keys(reloaded.execution!.workerResources!).sort(), ["external-claude", "external-codex"]);
      assert.equal(effectiveReviewSettings(reloaded).primaryReviewers.length, 2);
      assert.equal(effectiveReviewSettings(reloaded).subtaskReviewers.length, 2);
    } finally {
      useCreationForm = false;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});

for (const availableOnDisk of [true, false]) test(`warnings reflect the saved latest catalog (available: ${availableOnDisk})`, async () => {
  await workspace(async (path, config) => {
    const missing = join(__dirname, "missing", "codex");
    Object.assign(config, normalizeConfig({
      ...config,
      externalAgents: { existing: { adapter: "codex-cli", command: availableOnDisk ? missing : process.execPath, execution: {}, review: {} } },
      execution: { ...config.execution, workerResources: { existing: { selection: { source: "external", id: "existing" }, maxConcurrent: 1 } } },
      review: { ...config.review, primaryReviewers: [{ source: "external", id: "existing" }] },
    }));
    await writeFile(path, JSON.stringify(config));
    const warnings = await menu(path, config, ["Save changes"], async () => {
      const latest = JSON.parse(await readFile(path, "utf8"));
      latest.externalAgents.existing.command = availableOnDisk ? process.execPath : missing;
      await writeFile(path, JSON.stringify(latest));
    });
    assert.equal(warnings.length, availableOnDisk ? 0 : 1);
    assert.equal(config.externalAgents!.existing.command, availableOnDisk ? process.execPath : missing);
  });
});

for (const finish of ["Save changes", "Cancel", undefined]) test(`native rename and edit ${finish ?? "Escape"} preserves resource identities and paired schedule/reviewer state`, async () => {
  await workspace(async (path, config) => {
    Object.assign(config, normalizeConfig({ ...config,
      externalAgents: { A: { adapter: "claude-cli", command: process.execPath, model: "custom-model", env: { CUSTOM_OPTION: "manual-shared" }, execution: { model: "custom-role", env: { CUSTOM_OPTION: "manual-execution" } }, review: { env: { CUSTOM_OPTION: "manual-review" } } } },
      execution: { ...config.execution, workerResources: { r: { selection: { source: "external", id: "A" }, maxConcurrent: 1 } }, routes: { execute: [{ resourceId: "r" }], research: [{ resourceId: "r" }] } },
      review: { ...config.review, primaryReviewers: [{ source: "external", id: "A" }], subtaskReviewers: [{ source: "external", id: "A" }] },
      scheduledTasks: { task: { name: "Task", enabled: false, cron: "0 * * * *", kind: "execute", instructions: "A literal", workspace: __dirname, workerResourceId: "r", review: { mode: "selected", reviewers: [{ source: "external", id: "A" }] } } },
    }));
    const original = JSON.stringify(config); await writeFile(path, original);
    const before = structuredClone(config);
    await menu(path, config, ["External workers", "A [claude-cli]", "Identifier:", "Advanced execution overrides", "Timeout (ms):", "Back", "Shared model:", undefined, "Apply edit", "B [claude-cli]", "Identifier:", "Apply edit", "Back", finish], async () => {
      assert.deepEqual(config, before); assert.equal(await readFile(path, "utf8"), original);
    }, ["B", "60000", "__proto__"]);
    if (finish !== "Save changes") {
      assert.deepEqual(config, before); assert.equal(await readFile(path, "utf8"), original); return;
    }
    const saved = normalizeConfig(JSON.parse(await readFile(path, "utf8")));
    assert.deepEqual(saved, config); assert.equal(saved.externalAgents!.A, undefined); assert.equal(saved.externalAgents!.B, undefined);
    assert.equal(saved.externalAgents!.__proto__.command, "claude"); assert.equal(saved.externalAgents!.__proto__.model, "custom-model");
    assert.equal(saved.externalAgents!.__proto__.execution!.model, "custom-role"); assert.equal(saved.externalAgents!.__proto__.execution!.timeoutMs, 60000);
    assert.deepEqual(saved.externalAgents!.__proto__.env, before.externalAgents!.A.env);
    assert.deepEqual(saved.externalAgents!.__proto__.execution!.env, before.externalAgents!.A.execution!.env);
    assert.deepEqual(saved.externalAgents!.__proto__.review!.env, before.externalAgents!.A.review!.env);
    assert.deepEqual(saved.execution!.routes, before.execution!.routes);
    assert.deepEqual(saved.execution!.workerResources!.r.selection, { source: "external", id: "__proto__" });
    assert.deepEqual(saved.review!.primaryReviewers, [{ source: "external", id: "__proto__" }]);
    assert.deepEqual(saved.review!.subtaskReviewers, [{ source: "external", id: "__proto__" }]);
    assert.equal(saved.scheduledTasks!.task.workerResourceId, "r"); assert.equal(saved.scheduledTasks!.task.enabled, false);
    assert.deepEqual(saved.scheduledTasks!.task.review, { mode: "selected", reviewers: [{ source: "external", id: "__proto__" }] });
    assert.equal(saved.scheduledTasks!.task.instructions, "A literal");
  });
});

for (const adapter of ["run-as-binary", "claude-cli", "codex-cli"] as const)
for (const finish of ["Save changes", "Cancel", undefined]) test(`${adapter} deletion ${finish ?? "Escape"} is one shared transaction`, async () => {
  await workspace(async (path, config) => {
    Object.assign(config, normalizeConfig({ ...config,
      externalAgents: {
        X: { adapter, command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1" }, review: { protocol: "pi-reviewer-json-v1" } },
        untouched: { adapter: "codex-cli", command: process.execPath, execution: {}, model: "keep-custom" },
      },
      execution: { ...config.execution, workerResources: { arbitrary: { selection: { source: "external", id: "X" }, maxConcurrent: 1 } }, routes: { execute: [{ resourceId: "arbitrary" }], research: adapter === "run-as-binary" ? [] : [{ resourceId: "arbitrary" }] } },
      review: { ...config.review, primaryReviewers: [{ source: "external", id: "X" }], subtaskReviewers: [{ source: "external", id: "X" }] },
      scheduledTasks: { task: { name: "Task", enabled: true, cron: "0 * * * *", kind: "execute", instructions: "X literal", workspace: __dirname, workerResourceId: "arbitrary", review: { mode: "selected", reviewers: [{ source: "external", id: "X" }] } } },
    }));
    const original = JSON.stringify(config); await writeFile(path, original);
    const before = structuredClone(config);
    const notices: string[] = [];
    await menu(path, config, ["External workers", `X [${adapter}]`, ...(adapter === "run-as-binary" ? [] : ["Identifier:"]), "Delete", "Back", finish], async () => {
      assert.deepEqual(config, before); assert.equal(await readFile(path, "utf8"), original);
      const latest = JSON.parse(original);
      latest.externalAgents.latest = { adapter: "claude-cli", command: process.execPath, review: {}, model: "latest-custom" };
      await writeFile(path, JSON.stringify(latest));
    }, adapter === "run-as-binary" ? [] : ["unapplied-name"], notices);
    const noticeText = notices.join("\n");
    for (const expected of ["Staged deletion of external worker X", "Cancel discards", "Removed worker resource arbitrary", "Removed execute route", "Removed primary layer reviewer X", "Removed subtask layer reviewer X", "removed pin arbitrary", "empty selected-reviewer override reset to inheritance", "Task task disabled", "Later enabling uses configured defaults"]) assert.ok(noticeText.includes(expected), expected);
    if (adapter !== "run-as-binary") assert.ok(noticeText.includes("Removed research route"));
    if (finish !== "Save changes") {
      assert.deepEqual(config, before); assert.equal(await readFile(path, "utf8"), original); return;
    }
    const saved = normalizeConfig(JSON.parse(await readFile(path, "utf8")));
    assert.deepEqual(saved, config);
    assert.deepEqual(Object.keys(saved.externalAgents!).sort(), ["latest", "untouched"]);
    assert.deepEqual(saved.externalAgents!.untouched, before.externalAgents!.untouched);
    assert.equal(saved.externalAgents!.latest.model, "latest-custom");
    assert.equal(saved.externalAgents!["unapplied-name"], undefined);
    assert.deepEqual(saved.execution!.workerResources, {}); assert.deepEqual(saved.execution!.routes, { execute: [], research: [] });
    assert.deepEqual(saved.review!.primaryReviewers, []); assert.deepEqual(saved.review!.subtaskReviewers, []);
    assert.equal(saved.scheduledTasks!.task.enabled, false); assert.equal(saved.scheduledTasks!.task.workerResourceId, undefined); assert.equal(saved.scheduledTasks!.task.review, undefined);
    assert.equal(saved.scheduledTasks!.task.instructions, "X literal");
  });
});

test("created definition can be edited and renamed before explicit enrollment and shared Save", async () => {
  await workspace(async (path, config) => {
    // Use the owned fixture directory, not the host PATH: no Codex is installed here.
    const fixturePath = join(path, "..");
    creations = [{ ...structuredClone(definitions[0]), command: join(__dirname, "missing", "codex"), env: { PATH: fixturePath } }];
    const warnings = await menu(path, config, ["External workers", "Create worker", "codex [codex-cli]", "Identifier:", "Apply edit", "Back", "Worker resources", "Add worker resource", "back [codex-cli]", "1  current", "Back", "Save changes"], undefined, ["back"]);
    assert.deepEqual(warnings, [
      "Definition back, shared: removed custom executable (1); using automatic native command.",
      "External worker back cannot run until its Codex binary is installed and available.",
    ]);
    assert.equal(config.externalAgents!.back.command, "codex");
    assert.deepEqual(config.externalAgents!.back.env, { PATH: fixturePath });
    assert.deepEqual(Object.keys(config.externalAgents!), ["back"]);
    assert.deepEqual(config.execution!.workerResources!["external-back"].selection, { source: "external", id: "back" });
    assert.deepEqual(normalizeConfig(JSON.parse(await readFile(path, "utf8"))), config);
  });
});

for (const adapter of ["claude-cli", "codex-cli"] as const)
for (const finish of ["Save changes", "Cancel", undefined]) test(`${adapter}: real staged creation, enrollment and deletion respects root ${finish ?? "Escape"}`, async () => {
  await workspace(async (path, config) => {
    Object.assign(config, normalizeConfig({ ...config, externalAgents: {
      untouched: { adapter: "codex-cli", command: process.execPath, execution: {}, model: "keep-custom" },
    } }));
    const original = JSON.stringify(config); await writeFile(path, original);
    const before = structuredClone(config), notices: string[] = [];
    useCreationForm = true;
    try {
      const warnings = await menu(path, config, [
        "External workers", "Create worker", adapter === "claude-cli" ? "Claude Code" : "Codex",
        "Identifier:", "Roles:", "Execution and review", "Create", "Back",
        "Worker resources", "Add worker resource", `new-worker [${adapter}]`, "1  current", "Back",
        "Reviewers", "Primary reviewers", `new-worker [${adapter}] ✗`, "Back",
        "Subtask reviewers", `new-worker [${adapter}] ✗`, "Back", "Back",
        "External workers", `new-worker [${adapter}]`, "Delete new-worker", "Back", finish,
      ], async () => {
        assert.deepEqual(config, before);
        assert.equal(await readFile(path, "utf8"), original);
      }, ["new-worker"], notices);
      assert.deepEqual(warnings, []);
      if (finish !== "Save changes") {
        assert.deepEqual(config, before);
        assert.equal(await readFile(path, "utf8"), original);
      } else {
        assert.deepEqual(normalizeConfig(JSON.parse(await readFile(path, "utf8"))), config);
        // Root Save still materializes its existing scalar defaults. The
        // create/delete transaction leaves no definition or activation behind.
        assert.deepEqual(config.externalAgents, before.externalAgents);
        assert.deepEqual(config.execution!.workerResources, {});
        assert.deepEqual(config.execution!.routes, { execute: [], research: [] });
        assert.deepEqual(config.review!.primaryReviewers, []);
        assert.deepEqual(config.review!.subtaskReviewers, []);
        assert.deepEqual(config.scheduledTasks, {});
      }
      const text = notices.join("\n");
      for (const expected of ["Staged deletion of external worker new-worker", "Removed worker resource external-new-worker", "Removed execute route", "Removed research route", "Removed primary layer reviewer new-worker", "Removed subtask layer reviewer new-worker"]) assert.ok(text.includes(expected), expected);
    } finally { useCreationForm = false; }
  });
});

test("creation-form cancellation stages no definition", async () => {
  await workspace(async (path, config, original) => {
    const activeBefore = structuredClone(config);
    creations = [undefined];
    await menu(path, config, ["External workers", "Create worker", "Back", "Cancel"]);
    assert.deepEqual(config, activeBefore);
    assert.equal(await readFile(path, "utf8"), original);
  });
});
