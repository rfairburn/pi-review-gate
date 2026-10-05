import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig, resolvedExternalAgent } from "../src/config";
import { changeExternalAgent, guardExternalAgentReferences, manageExternalAgents, stageExternalAgentOperation, type ExternalAgentOperation } from "../src/settings/external-agent-catalog";
import { selectExternalAgentCreation, selectExternalAgentEdit } from "../src/settings/external-agents";
import type { UiContext } from "../src/settings/ui";

function fixture() {
  const config = normalizeConfig({ externalAgents: {
    A: { adapter: "claude-cli", model: "old-custom", command: "/custom/native-tool", args: ["shared-secret"], env: { TOKEN: "shared-env-secret" }, execution: { model: "pinned", timeoutMs: 1234, args: ["role-secret"], env: { TOKEN: "role-env-secret" }, protocol: "pi-review-executor-jsonl-v1" }, review: { model: "review-pinned", protocol: "pi-reviewer-json-v1" } },
    X: { adapter: "run-as-binary", command: "unused", execution: { protocol: "pi-review-executor-jsonl-v1" }, review: { protocol: "pi-reviewer-json-v1" } },
  }, execution: { workerResources: {
    r: { selection: { source: "external", id: "A" }, maxConcurrent: 1 },
    r1: { selection: { source: "external", id: "X" }, maxConcurrent: 1 },
  }, routes: { execute: [{ resourceId: "r1" }, { resourceId: "r" }], research: [{ resourceId: "r" }] } },
  review: { primaryReviewers: [{ source: "external", id: "A" }, { source: "external", id: "X" }], subtaskReviewers: [{ source: "external", id: "X" }, { source: "external", id: "A" }] },
  scheduledTasks: {
    pin: { name: "Pin", cron: "0 * * * *", enabled: true, kind: "execute", workspace: __dirname, instructions: "X is literal", workerResourceId: "r1", review: { mode: "off" } },
    selected: { name: "Selected", cron: "0 * * * *", enabled: false, kind: "execute", workspace: __dirname, instructions: "A stays literal", workerResourceId: "r", review: { mode: "selected", reviewers: [{ source: "external", id: "A" }, { source: "external", id: "X" }] } },
    dormant: { name: "Dormant", cron: "0 * * * *", enabled: true, kind: "inplace", destination: "orchestrator-turn", instructions: "keep", review: { mode: "selected", reviewers: [{ source: "external", id: "X" }] } },
  } });
  // Exercise all matching resource keys even in a manually staged duplicate
  // catalog, without weakening the existing schema's uniqueness invariant.
  config.execution!.workerResources!.r2 = { selection: { source: "external", id: "X" }, maxConcurrent: 2 };
  config.execution!.routes!.execute!.push({ resourceId: "r2" });
  return config;
}
function script(actions: Array<string | undefined>, edits: Array<string | undefined> = []) {
  const menus: string[][] = [], notices: string[] = [];
  const ui: UiContext = {
    async select(title, options) {
      menus.push(options); assert.ok(actions.length, title);
      const action = actions.shift(); if (action === undefined) return undefined;
      const row = options.find((row) => row.startsWith(action)); assert.ok(row, `${action}: ${options.join(" | ")}`); return row;
    },
    async editor() { assert.ok(edits.length); return edits.shift(); },
    notify(message) { notices.push(message); },
  };
  return { ui, menus, notices, consumed() { assert.equal(actions.length, 0); assert.equal(edits.length, 0); } };
}

test("rename pairs resources, reviewers and dormant scheduled references without identity or text substitution", () => {
  const opening = fixture(), before = structuredClone(opening);
  const renamed = changeExternalAgent(opening, "A", "B", opening.externalAgents!.A).config;
  assert.deepEqual(opening, before);
  assert.equal((renamed.execution!.workerResources!.r.selection as { id: string }).id, "B");
  assert.deepEqual(renamed.execution!.routes, opening.execution!.routes);
  assert.deepEqual(renamed.review!.primaryReviewers, [{ source: "external", id: "B" }, { source: "external", id: "X" }]);
  assert.equal(renamed.scheduledTasks!.selected.enabled, false);
  assert.equal(renamed.scheduledTasks!.selected.workerResourceId, "r");
  assert.equal(renamed.scheduledTasks!.selected.instructions, "A stays literal");
  assert.deepEqual(renamed.scheduledTasks!.selected.review, { mode: "selected", reviewers: [{ source: "external", id: "B" }, { source: "external", id: "X" }] });
  assert.throws(() => changeExternalAgent(opening, "A", "X", opening.externalAgents!.A), /already exists/);
  assert.throws(() => changeExternalAgent(opening, "A", "bad id", opening.externalAgents!.A));
  assert.deepEqual(opening, before);
});

test("delete cascades actual resources, routes, both layers, dormant tasks and emits complete staged notices", () => {
  const opening = fixture(); const { config, notices } = changeExternalAgent(opening, "X");
  assert.deepEqual(Object.keys(config.execution!.workerResources!), ["r"]);
  assert.deepEqual(config.execution!.routes!.execute, [{ resourceId: "r", thinkingLevel: undefined }]);
  for (const layer of ["primaryReviewers", "subtaskReviewers"] as const) assert.deepEqual(config.review![layer], [{ source: "external", id: "A" }]);
  assert.equal(config.scheduledTasks!.pin.enabled, false);
  assert.equal(config.scheduledTasks!.pin.workerResourceId, undefined);
  assert.deepEqual(config.scheduledTasks!.pin.review, { mode: "off" });
  assert.equal(config.scheduledTasks!.dormant.enabled, false);
  assert.equal(config.scheduledTasks!.dormant.review, undefined);
  assert.deepEqual(config.scheduledTasks!.selected.review, { mode: "selected", reviewers: [{ source: "external", id: "A" }] });
  assert.equal(config.scheduledTasks!.selected.workerResourceId, "r");
  const text = notices.join("\n");
  for (const expected of ["X", "r1", "r2", "execute route", "primary layer", "subtask layer", "pin", "selected", "dormant", "inheritance", "Later enabling uses configured defaults", "Cancel discards"]) assert.ok(text.includes(expected), expected);
  assert.ok(opening.externalAgents!.X);
});

test("catalog lists native/unsupported and action-name IDs; unsupported offers only Delete/Back, Back and native Cancel are inert", async () => {
  const config = normalizeConfig({ externalAgents: Object.fromEntries(["create", "back", "__proto__"].map((id, index) => [id, index === 2 ? { adapter: "generic-cli", command: "unused", review: {} } : { adapter: "codex-cli", execution: {} }])) });
  const before = structuredClone(config);
  const s = script(["__proto__", "Back", "create [", "Cancel", "back [", "Cancel", "Back"]);
  await manageExternalAgents(s.ui, config, async () => { throw new Error("Back or Cancel applied a change"); });
  assert.deepEqual(config, before);
  assert.equal(s.menus[0].length, 5);
  assert.ok(s.menus[0].includes("Create worker"));
  assert.deepEqual(s.menus[1], ["Delete", "Back"]);
  assert.deepEqual(s.notices, []);
  const editors = s.menus.filter((rows) => rows.some((row) => row.startsWith("Identifier:")));
  assert.equal(editors.length, 2);
  assert.ok(editors[0].includes("Delete create"));
  assert.ok(editors[1].includes("Delete back"));
  s.consumed();
});

test("unsupported Delete passes only the selected ID to the apply callback", async () => {
  const config = fixture(), before = structuredClone(config);
  const s = script(["X [", "Delete", "Back"]);
  const calls: unknown[][] = [];
  await manageExternalAgents(s.ui, config, async (...args) => { calls.push(args); });
  assert.deepEqual(s.menus[1], ["Delete", "Back"]);
  assert.deepEqual(calls, [["X"]]);
  assert.deepEqual(config, before);
  assert.deepEqual(s.notices, []);
  s.consumed();
});

test("native edits normalize only edited commands/args/protocol, preserve models/env and field cancel", async () => {
  const config = fixture(); const existing = resolvedExternalAgent(config, "A")!;
  const s = script(["Shared model:", undefined, "Advanced execution overrides", "Model:", "Keep current", "Timeout (ms):", "Back", "Apply edit"], ["60000"]);
  const result = await selectExternalAgentEdit(s.ui, config, existing);
  assert.ok(result?.kind === "apply");
  const edited = result.agent;
  assert.equal(edited!.command, "claude"); assert.equal(edited!.model, "old-custom");
  assert.equal(edited!.execution!.model, "pinned"); assert.equal(edited!.execution!.timeoutMs, 60000);
  assert.deepEqual(edited!.args, []); assert.deepEqual(edited!.env, existing.env);
  assert.deepEqual(edited!.execution!.args, []); assert.deepEqual(edited!.execution!.env, existing.execution!.env);
  assert.equal(edited!.execution!.protocol, undefined);
  assert.ok(!JSON.stringify([s.menus, s.notices]).includes("secret"));
  s.consumed();
  const switched = script(["Adapter:", "Codex", "Apply edit"]);
  const switchedResult = await selectExternalAgentEdit(switched.ui, config, existing);
  assert.ok(switchedResult?.kind === "apply");
  const changed = switchedResult.agent;
  assert.equal(changed!.adapter, "codex-cli"); assert.equal(changed!.command, "codex");
  assert.equal(changed!.model, "old-custom"); assert.equal(changed!.execution!.model, "pinned"); assert.equal(changed!.review!.model, "review-pinned");
  assert.deepEqual(changed!.args, []); assert.deepEqual(changed!.env, existing.env);
  assert.deepEqual(changed!.execution, { ...existing.execution, args: [], protocol: undefined });
  assert.deepEqual(changed!.review, { ...existing.review, args: [], protocol: undefined });
  assert.ok(switched.notices.some(notice => /removed custom executable/.test(notice))); switched.consumed();
});

test("cleanup warnings precede the manager apply callback and never affect unrelated definitions", async () => {
  const config = fixture(), before = structuredClone(config);
  const s = script(["A [", "Apply edit", "Back"]);
  let called = false;
  await manageExternalAgents(s.ui, config, async (id, _nextId, definition) => {
    called = true;
    assert.equal(id, "A");
    assert.ok(s.notices.some(notice => /removed custom executable/.test(notice)));
    assert.ok(s.notices.some(notice => /removed other argument tokens 1/.test(notice)));
    assert.equal(definition?.command, "claude");
    assert.deepEqual(config, before);
  });
  assert.equal(called, true); s.consumed();
});

test("environment text cancel preserves values, and unchanged empty environments retain their spelling", async () => {
  const config = fixture(), existing = resolvedExternalAgent(config, "A")!;
  const s = script(["Advanced shared environment:", "Environment entry 1", "Edit value", "Back", "Apply edit"], [undefined]);
  const result = await selectExternalAgentEdit(s.ui, config, existing);
  assert.ok(result?.kind === "apply");
  const edited = result.agent;
  assert.deepEqual(edited!.args, []); assert.deepEqual(edited!.env, existing.env);
  assert.ok(!JSON.stringify([s.menus, s.notices]).includes("secret")); s.consumed();
  const emptyConfig = normalizeConfig({ externalAgents: { empty: { adapter: "codex-cli", env: {}, review: { env: {} } } } });
  const empty = script(["Advanced shared environment:", "Back", "Advanced review overrides", "Environment overrides:", undefined, "Back", "Apply edit"]);
  const unchangedResult = await selectExternalAgentEdit(empty.ui, emptyConfig, resolvedExternalAgent(emptyConfig, "empty")!);
  assert.ok(unchangedResult?.kind === "apply");
  const unchanged = unchangedResult.agent;
  assert.deepEqual(unchanged!.env, {}); assert.deepEqual(unchanged!.review!.env, {}); empty.consumed();
});

for (const adapter of ["claude-cli", "codex-cli"] as const) {
  test(`${adapter}: direct Delete uses original identity and discards invalid, unapplied edits`, async () => {
    const config = fixture();
    config.externalAgents!.A.adapter = adapter;
    const before = structuredClone(config);
    const s = script(["Identifier:", "Shared model:", "Unset", "Adapter:", adapter === "claude-cli" ? "Codex" : "Claude Code", "Delete A"], ["unapplied-name"]);
    assert.deepEqual(await selectExternalAgentEdit(s.ui, config, resolvedExternalAgent(config, "A")!), { kind: "delete", id: "A" });
    assert.deepEqual(config, before);
    // Delete must still work without implicit Apply or cleanup warnings.
    assert.deepEqual(s.notices, []);
    assert.ok(s.menus[0].includes("Apply edit"));
    assert.ok(s.menus[0].includes("Delete A"));
    assert.ok(s.menus[0].includes("Cancel"));
    assert.ok(s.menus.at(-1)!.includes("Identifier: unapplied-name"));
    assert.ok(s.menus.at(-1)!.includes("Delete A"));
    s.consumed();
  });

  test(`${adapter}: manager dispatches direct Delete through the existing ID-only callback`, async () => {
    const config = normalizeConfig({ externalAgents: { custom: { adapter, execution: {}, review: {} } } });
    const before = structuredClone(config), calls: unknown[][] = [];
    const s = script(["custom [", "Identifier:", "Delete custom", "Back"], ["not-applied"]);
    await manageExternalAgents(s.ui, config, async (...args) => { calls.push(args); });
    assert.deepEqual(calls, [["custom"]]);
    assert.equal(s.menus[1][0], "Identifier: custom");
    assert.deepEqual(config, before);
    s.consumed();
  });

  for (const cancel of ["Cancel", undefined]) test(`${adapter}: editor ${cancel ?? "Escape"} discards unapplied edits`, async () => {
    const config = normalizeConfig({ externalAgents: { custom: { adapter, execution: {} } } });
    const before = structuredClone(config);
    const s = script(["custom [", "Identifier:", "Shared model:", "Unset", cancel, "Back"], ["not-applied"]);
    await manageExternalAgents(s.ui, config, async () => { throw new Error("Canceled editor applied a change"); });
    assert.deepEqual(config, before);
    assert.deepEqual(s.notices, []);
    s.consumed();
  });
}

test("initial creation has Cancel but no Delete and preserves the untagged creation API", async () => {
  const config = normalizeConfig({});
  const s = script(["Claude Code", "Identifier:", "Roles:", "Execution only", "Create"], ["created"]);
  const created = await selectExternalAgentCreation(s.ui, config);
  assert.equal(created?.id, "created");
  assert.equal(created?.adapter, "claude-cli");
  for (const rows of s.menus.filter((rows) => rows.some((row) => row.startsWith("Identifier:")))) {
    assert.ok(rows.includes("Cancel"));
    assert.ok(!rows.some((row) => row.startsWith("Delete")));
  }
  s.consumed();
});

test("operation lineage coalesces repeated rename and unsaved creation edits", () => {
  const opening = fixture(), operations: ExternalAgentOperation[] = [];
  stageExternalAgentOperation(operations, opening, "A", "B", opening.externalAgents!.A);
  stageExternalAgentOperation(operations, opening, "B", "C", { ...opening.externalAgents!.A, model: "changed" });
  stageExternalAgentOperation(operations, opening, "new", "new", opening.externalAgents!.A);
  stageExternalAgentOperation(operations, opening, "new", "renamed-new", opening.externalAgents!.A);
  assert.equal(operations.length, 2); assert.equal(operations[0].id, "A"); assert.equal(operations[0].nextId, "C");
  assert.deepEqual(operations[0].baseline, opening.externalAgents!.A);
  assert.equal(operations[1].baseline, undefined); assert.equal(operations[1].nextId, "renamed-new");
  guardExternalAgentReferences(opening, structuredClone(opening), "X");
  const latest = fixture(); latest.scheduledTasks!.new = { ...latest.scheduledTasks!.pin };
  assert.throws(() => guardExternalAgentReferences(opening, latest, "X"), /references changed/);
});
