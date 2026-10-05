import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig, resolvedExternalAgent } from "../src/config";
import { changeExternalAgent, guardExternalAgentReferences, manageExternalAgents, stageExternalAgentOperation, type ExternalAgentOperation } from "../src/settings/external-agent-catalog";
import { selectExternalAgentEdit } from "../src/settings/external-agents";
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

test("catalog lists native/unsupported and action-name IDs; unsupported Select is inert, native has no Delete", async () => {
  const config = normalizeConfig({ externalAgents: Object.fromEntries(["create", "back", "__proto__"].map((id, index) => [id, index === 2 ? { adapter: "generic-cli", command: "unused", review: {} } : { adapter: "codex-cli", execution: {} }])) });
  const before = structuredClone(config);
  const s = script(["__proto__", "Select", "create [", "Cancel", "back [", "Cancel", "Back"]);
  await manageExternalAgents(s.ui, config, async () => { throw new Error("view activated"); });
  assert.deepEqual(config, before);
  assert.equal(s.menus[0].length, 5);
  assert.ok(s.menus[0].includes("Create worker"));
  assert.ok(!s.menus.filter((rows) => rows.some((row) => row.startsWith("Identifier:"))).some((rows) => rows.includes("Delete")));
  s.consumed();
});

test("native edits preserve custom command/models and field cancel; adapter switch requires executable correction without clearing fields", async () => {
  const config = fixture(); const existing = resolvedExternalAgent(config, "A")!;
  const s = script(["Shared model:", undefined, "Advanced execution overrides", "Model:", "Keep current", "Timeout (ms):", "Back", "Apply edit"], ["60000"]);
  const edited = await selectExternalAgentEdit(s.ui, config, existing);
  assert.equal(edited!.command, existing.command); assert.equal(edited!.model, "old-custom");
  assert.equal(edited!.execution!.model, "pinned"); assert.equal(edited!.execution!.timeoutMs, 60000);
  assert.deepEqual(edited!.args, existing.args); assert.deepEqual(edited!.env, existing.env);
  assert.deepEqual(edited!.execution!.args, existing.execution!.args); assert.deepEqual(edited!.execution!.env, existing.execution!.env);
  assert.equal(edited!.execution!.protocol, existing.execution!.protocol);
  assert.ok(!JSON.stringify([s.menus, s.notices]).includes("secret"));
  s.consumed();
  const switched = script(["Adapter:", "Codex", "Apply edit", "Application executable:", "Apply edit"], [""]);
  const changed = await selectExternalAgentEdit(switched.ui, config, existing);
  assert.equal(changed!.adapter, "codex-cli"); assert.equal(changed!.command, "codex");
  assert.equal(changed!.model, "old-custom"); assert.equal(changed!.execution!.model, "pinned"); assert.equal(changed!.review!.model, "review-pinned");
  assert.deepEqual(changed!.args, existing.args); assert.deepEqual(changed!.env, existing.env);
  assert.deepEqual(changed!.execution, existing.execution); assert.deepEqual(changed!.review, existing.review);
  assert.match(switched.notices[0], /Choose or clear.*codex.*retained/); switched.consumed();
});

test("argument/environment text cancel preserves literals, and unchanged empty environments retain their spelling", async () => {
  const config = fixture(), existing = resolvedExternalAgent(config, "A")!;
  const s = script(["Advanced shared arguments:", "Argument 1", "Edit value", "Back", "Advanced shared environment:", "Environment entry 1", "Edit value", "Back", "Apply edit"], [undefined, undefined]);
  const edited = await selectExternalAgentEdit(s.ui, config, existing);
  assert.deepEqual(edited!.args, existing.args); assert.deepEqual(edited!.env, existing.env);
  assert.ok(!JSON.stringify([s.menus, s.notices]).includes("secret")); s.consumed();
  const emptyConfig = normalizeConfig({ externalAgents: { empty: { adapter: "codex-cli", env: {}, review: { env: {} } } } });
  const empty = script(["Advanced shared environment:", "Back", "Advanced review overrides", "Environment overrides:", undefined, "Back", "Apply edit"]);
  const unchanged = await selectExternalAgentEdit(empty.ui, emptyConfig, resolvedExternalAgent(emptyConfig, "empty")!);
  assert.deepEqual(unchanged!.env, {}); assert.deepEqual(unchanged!.review!.env, {}); empty.consumed();
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
