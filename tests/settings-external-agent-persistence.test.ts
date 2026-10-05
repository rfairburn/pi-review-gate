import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { effectiveReviewSettings, normalizeConfig, type ReviewGateConfig } from "../src/config";
import { changeExternalAgent, stageExternalAgentOperation, type ExternalAgentOperation } from "../src/settings/external-agent-catalog";
import { persistReviewSettings, type ReviewSettingsSelection } from "../src/settings/persistence";

function selection(config: ReviewGateConfig, opening: ReviewGateConfig, operations: ExternalAgentOperation[]): ReviewSettingsSelection {
  const review = effectiveReviewSettings(config);
  return {
    operatingMode: config.operatingMode, modeCycleShortcut: config.modeCycleShortcut,
    workerResources: config.execution!.workerResources!, executeRoute: config.execution!.routes?.execute, researchRoute: config.execution!.routes?.research,
    ...review, reviewerTimeoutMs: config.reviewerTimeoutMs, executorTimeoutMs: config.executorTimeoutMs,
    maxCorrectionCycles: config.maxCorrectionCycles, implementationGuidanceAfterCorrectionAttempts: config.implementationGuidanceAfterCorrectionAttempts,
    retainBundles: config.retainBundles, maxWorkers: config.execution!.maxWorkers!, retryPolicy: config.execution!.retryPolicy!, subtaskNotifications: config.execution!.subtaskNotifications!, subtasksViewExpanded: false,
    scheduledTasks: config.scheduledTasks ?? {}, scheduledTasksStagedFrom: Object.keys(opening.scheduledTasks ?? {}),
    externalAgentOperations: operations, externalAgentOpening: opening,
  };
}
async function workspace(run: (path: string, opening: ReviewGateConfig) => Promise<void>) {
  const directory = await mkdtemp(join(__dirname, "catalog-persistence-"));
  try {
    const path = join(directory, "config.json");
    const raw = { future: { preserve: true }, externalAgents: [
      { id: "A", adapter: "codex-cli", command: "codex", model: "custom", execution: { model: "custom-execution", args: ["literal secret"], env: { TOKEN: "literal secret" }, timeoutMs: 5678 }, review: { model: "custom-review" } },
      { id: "X", adapter: "run-as-binary", command: "binary", execution: { protocol: "pi-review-executor-jsonl-v1" }, review: { protocol: "pi-reviewer-json-v1" } },
      { id: "other", adapter: "claude-cli", execution: {} },
    ], execution: { workerResources: { r: { selection: { source: "external", id: "A" }, maxConcurrent: 1 }, arbitrary: { selection: { source: "external", id: "X" }, maxConcurrent: 1 } }, routes: { execute: [{ resourceId: "r" }, { resourceId: "arbitrary" }], research: [] } },
    review: { primaryReviewers: [{ source: "external", id: "A" }, { source: "external", id: "X" }], subtaskReviewers: [{ source: "external", id: "X" }, { source: "external", id: "A" }] },
    scheduledTasks: { t: { name: "Task", cron: "0 * * * *", instructions: "keep A X", workspace: __dirname, kind: "execute", enabled: true, workerResourceId: "arbitrary", review: { mode: "selected", reviewers: [{ source: "external", id: "X" }, { source: "external", id: "A" }] } } } };
    await writeFile(path, JSON.stringify(raw)); await chmod(path, 0o600);
    await run(path, normalizeConfig(raw));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function latest(path: string, mutate: (config: any) => void) {
  const raw = JSON.parse(await readFile(path, "utf8")); mutate(raw); await writeFile(path, JSON.stringify(raw));
}

test("rename/repeated edits and deletion round-trip atomically with resource identities, latest unrelated definitions, legacy roles and private perms", async () => {
  await workspace(async (path, opening) => {
    const operations: ExternalAgentOperation[] = [];
    let draft = changeExternalAgent(opening, "A", "B", opening.externalAgents!.A).config;
    stageExternalAgentOperation(operations, opening, "A", "B", draft.externalAgents!.B);
    draft = changeExternalAgent(draft, "B", "__proto__", { ...draft.externalAgents!.B, model: "changed-custom" }).config;
    stageExternalAgentOperation(operations, opening, "B", "__proto__", draft.externalAgents!.__proto__);
    draft = changeExternalAgent(draft, "X").config;
    stageExternalAgentOperation(operations, opening, "X");
    await latest(path, (raw) => { raw.externalAgents.find((a: any) => a.id === "other").model = "newest-other"; raw.scheduledTasks.foreign = { malformed: "preserve verbatim" }; });
    const result = await persistReviewSettings(path, selection(draft, opening, operations));
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.externalAgents.other.model, "newest-other");
    assert.equal(raw.externalAgents.__proto__.model, "changed-custom");
    assert.equal(raw.externalAgents.__proto__.execution.model, "custom-execution");
    assert.equal(raw.externalAgents.__proto__.execution.timeoutMs, 5678);
    assert.deepEqual(raw.externalAgents.__proto__.execution.env, { TOKEN: "literal secret" });
    assert.equal(raw.externalAgents.A, undefined); assert.equal(raw.externalAgents.X, undefined);
    assert.equal(raw.execution.workerResources.r.selection.id, "__proto__");
    assert.deepEqual(raw.execution.routes.execute, [{ resourceId: "r" }]);
    assert.deepEqual(raw.review.primaryReviewers, [{ source: "external", id: "__proto__" }]);
    assert.equal(raw.scheduledTasks.t.enabled, false); assert.equal(raw.scheduledTasks.t.workerResourceId, undefined);
    assert.deepEqual(raw.scheduledTasks.t.review, { mode: "selected", reviewers: [{ source: "external", id: "__proto__" }] });
    assert.equal(raw.scheduledTasks.t.instructions, "keep A X");
    assert.deepEqual(raw.scheduledTasks.foreign, { malformed: "preserve verbatim" });
    assert.deepEqual(raw.future, { preserve: true }); assert.equal((await stat(path)).mode & 0o777, 0o600);
    delete raw.scheduledTasks.foreign;
    assert.deepEqual(normalizeConfig(raw), result);
  });
});

for (const conflict of ["changed", "disappeared", "destination", "resource", "route", "reviewer", "foreign-pin", "foreign-reviewer", "dormant-reviewer"] as const) test(`optimistic ${conflict} conflict rejects without disk mutation`, async () => {
  await workspace(async (path, opening) => {
    const operations: ExternalAgentOperation[] = [];
    const draft = changeExternalAgent(opening, "A", "B", opening.externalAgents!.A).config;
    stageExternalAgentOperation(operations, opening, "A", "B", draft.externalAgents!.B);
    await latest(path, (raw) => {
      if (conflict === "changed") raw.externalAgents[0].model = "concurrent";
      if (conflict === "disappeared") raw.externalAgents.shift();
      if (conflict === "destination") raw.externalAgents.push({ id: "B", adapter: "codex-cli", execution: {} });
      if (conflict === "resource") raw.execution.workerResources.new = { selection: { source: "external", id: "A" }, maxConcurrent: 1 };
      if (conflict === "route") raw.execution.routes.execute.push({ resourceId: "r" });
      if (conflict === "reviewer") raw.review.primaryReviewers.unshift({ source: "external", id: "other" });
      if (conflict === "foreign-pin") raw.scheduledTasks.new = { ...raw.scheduledTasks.t, workerResourceId: "r", review: { mode: "off" } };
      if (conflict === "foreign-reviewer") raw.scheduledTasks.new = { ...raw.scheduledTasks.t, workerResourceId: undefined };
      if (conflict === "dormant-reviewer") raw.scheduledTasks.new = { ...raw.scheduledTasks.t, enabled: false, destination: "orchestrator-turn", kind: "inplace", workerResourceId: undefined };
    });
    const before = await readFile(path, "utf8");
    await assert.rejects(persistReviewSettings(path, selection(draft, opening, operations)), /Reopen settings/);
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("deletion cannot erase new on-disk references or foreign dormant schedules", async () => {
  await workspace(async (path, opening) => {
    const draft = changeExternalAgent(opening, "X").config;
    const operations: ExternalAgentOperation[] = []; stageExternalAgentOperation(operations, opening, "X");
    await latest(path, (raw) => { raw.scheduledTasks.foreign = { ...raw.scheduledTasks.t, enabled: false, kind: "inplace", destination: "orchestrator-turn" }; });
    const before = await readFile(path, "utf8");
    await assert.rejects(persistReviewSettings(path, selection(draft, opening, operations)), /references changed.*Reopen/);
    assert.equal(await readFile(path, "utf8"), before);
  });
});

for (const edit of ["role", "model"] as const) test(`same-ID ${edit} edit rejects newly added related resources and foreign schedule pins`, async () => {
  await workspace(async (path, opening) => {
    delete opening.execution!.workerResources!.r;
    opening.execution!.routes!.execute = opening.execution!.routes!.execute!.filter((entry) => entry.resourceId !== "r");
    await writeFile(path, JSON.stringify(opening));
    const definition = structuredClone(opening.externalAgents!.A);
    if (edit === "role") delete definition.execution;
    else definition.model = "changed-model";
    const draft = changeExternalAgent(opening, "A", "A", definition).config;
    const operations: ExternalAgentOperation[] = [];
    stageExternalAgentOperation(operations, opening, "A", "A", definition);
    await latest(path, (raw) => {
      raw.execution.workerResources.new = { selection: { source: "external", id: "A" }, maxConcurrent: 1 };
      raw.scheduledTasks.foreign = { ...raw.scheduledTasks.t, workerResourceId: "new", review: { mode: "off" } };
    });
    const before = await readFile(path, "utf8");
    await assert.rejects(persistReviewSettings(path, selection(draft, opening, operations)), /references changed.*Reopen/);
    assert.equal(await readFile(path, "utf8"), before);
  });
});

for (const form of ["keyed", "legacy-explicit", "legacy-generated"] as const) test(`creation rejects a preserved schedule pin dropped from the latest ${form} resource catalog`, async () => {
  await workspace(async (path, opening) => {
    const draft = structuredClone(opening);
    const definition = { adapter: "codex-cli" as const, execution: {} };
    draft.externalAgents!.created = definition;
    const operations: ExternalAgentOperation[] = [];
    stageExternalAgentOperation(operations, opening, "created", "created", definition);
    await latest(path, (raw) => {
      raw.execution.workerResources.future = { selection: { source: "external", id: "created" }, maxConcurrent: 1 };
      if (form !== "keyed") raw.execution.workerResources = Object.entries(raw.execution.workerResources).map(([resourceId, resource]) => ({
        ...(resource as object), ...(form === "legacy-generated" && resourceId === "future" ? {} : { resourceId }),
      }));
      // Derive the pin through the real importer, so this regression cannot
      // accidentally test an unsupported legacy identity field.
      const imported = normalizeConfig({ execution: { workerResources: raw.execution.workerResources } });
      const pin = Object.entries(imported.execution!.workerResources!).find(([, resource]) => resource.selection.source === "external" && resource.selection.id === "created")![0];
      assert.equal(pin, form === "legacy-generated" ? "external-created" : "future");
      raw.scheduledTasks.foreign = { ...raw.scheduledTasks.t, workerResourceId: ` ${pin} `, review: { mode: "off" } };
    });
    const before = await readFile(path, "utf8");
    await assert.rejects(persistReviewSettings(path, selection(draft, opening, operations)), /preserved schedule still pins.*Reopen/);
    assert.equal(await readFile(path, "utf8"), before);
  });
});

test("staged rename chains may reuse safely released opening IDs without losing definitions or reference pairing", async () => {
  await workspace(async (path, opening) => {
    const operations: ExternalAgentOperation[] = [];
    let draft = changeExternalAgent(opening, "A", "temporary", opening.externalAgents!.A).config;
    stageExternalAgentOperation(operations, opening, "A", "temporary", draft.externalAgents!.temporary);
    draft = changeExternalAgent(draft, "other", "A", draft.externalAgents!.other).config;
    stageExternalAgentOperation(operations, opening, "other", "A", draft.externalAgents!.A);
    draft = changeExternalAgent(draft, "temporary", "other", draft.externalAgents!.temporary).config;
    stageExternalAgentOperation(operations, opening, "temporary", "other", draft.externalAgents!.other);
    const result = await persistReviewSettings(path, selection(draft, opening, operations));
    assert.equal(result.externalAgents!.A.adapter, "claude-cli");
    assert.equal(result.externalAgents!.other.adapter, "codex-cli");
    assert.equal(result.externalAgents!.other.model, "custom");
    assert.equal(result.externalAgents!.temporary, undefined);
    assert.deepEqual(result.execution!.workerResources!.r.selection, { source: "external", id: "other" });
    assert.deepEqual(result.review!.primaryReviewers, [{ source: "external", id: "other" }, { source: "external", id: "X" }]);
    assert.deepEqual(normalizeConfig(JSON.parse(await readFile(path, "utf8"))), result);
  });
});

test("reference guards compare normalized defaults without validating unrelated foreign schedule content", async () => {
  await workspace(async (path, opening) => {
    const draft = changeExternalAgent(opening, "A", "B", opening.externalAgents!.A).config;
    const operations: ExternalAgentOperation[] = []; stageExternalAgentOperation(operations, opening, "A", "B", draft.externalAgents!.B);
    await latest(path, (raw) => {
      delete raw.scheduledTasks.t.enabled;
      raw.scheduledTasks.t.workerResourceId = " arbitrary ";
      raw.scheduledTasks.foreign = { workerResourceId: 42, review: { mode: "selected", reviewers: "invalid" }, future: "keep" };
    });
    await persistReviewSettings(path, selection(draft, opening, operations));
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.externalAgents.B.model, "custom");
    assert.deepEqual(raw.scheduledTasks.foreign, { workerResourceId: 42, review: { mode: "selected", reviewers: "invalid" }, future: "keep" });
  });
});

for (const action of ["create", "rename"] as const) test(`catalog ${action} can save repairs to unrelated owned scalar settings`, async () => {
  await workspace(async (path, opening) => {
    const operations: ExternalAgentOperation[] = [];
    let draft: ReviewGateConfig;
    if (action === "rename") {
      draft = changeExternalAgent(opening, "A", "B", opening.externalAgents!.A).config;
      stageExternalAgentOperation(operations, opening, "A", "B", draft.externalAgents!.B);
    } else {
      draft = structuredClone(opening);
      draft.externalAgents!.created = { adapter: "codex-cli", execution: {} };
      stageExternalAgentOperation(operations, opening, "created", "created", draft.externalAgents!.created);
    }
    await latest(path, (raw) => {
      raw.operatingMode = "invalid-mode";
      raw.execution.maxWorkers = "invalid-count";
      raw.review.primaryEnabled = "invalid-flag";
    });
    const result = await persistReviewSettings(path, selection(draft, opening, operations));
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.operatingMode, opening.operatingMode);
    assert.equal(raw.execution.maxWorkers, opening.execution!.maxWorkers);
    assert.equal(raw.review.primaryEnabled, effectiveReviewSettings(opening).primaryEnabled);
    assert.deepEqual(raw.future, { preserve: true });
    assert.ok(result.externalAgents![action === "rename" ? "B" : "created"]);
    assert.deepEqual(normalizeConfig(raw), result);
  });
});

test("unsaved create/rename is one insertion; collision rejects and unrelated latest catalog survives", async () => {
  await workspace(async (path, opening) => {
    const draft = structuredClone(opening), operations: ExternalAgentOperation[] = [];
    const definition = opening.externalAgents!.other;
    stageExternalAgentOperation(operations, opening, "new", "new", definition);
    stageExternalAgentOperation(operations, opening, "new", "back", definition);
    Object.defineProperty(draft.externalAgents!, "back", { value: definition, enumerable: true });
    await latest(path, (raw) => { raw.externalAgents.push({ id: "newest", adapter: "claude-cli", review: {} }); });
    await persistReviewSettings(path, selection(draft, opening, operations));
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.ok(saved.externalAgents.back); assert.ok(saved.externalAgents.newest); assert.equal(saved.externalAgents.new, undefined);
    const before = await readFile(path, "utf8");
    await assert.rejects(persistReviewSettings(path, selection(draft, opening, operations)), /already exists/);
    assert.equal(await readFile(path, "utf8"), before);
  });
});
