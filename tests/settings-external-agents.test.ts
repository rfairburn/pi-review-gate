import assert from "node:assert/strict";
import test, { mock } from "node:test";
import childProcess from "node:child_process";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { selectExternalAgentCreation, selectExternalAgentEdit } from "../src/settings/external-agents";
import { EXTERNAL_AGENT_MODEL_CATALOG } from "../src/settings/external-agent-models";
import type { UiContext } from "../src/settings/ui";

type Step = string | undefined;
function scripted(selects: Step[], edits: Step[] = []) {
  const menus: Array<{ title: string; options: string[] }> = [];
  const fields: Array<{ title: string; prefill: string | undefined }> = [];
  const notices: string[] = [];
  const ui: UiContext = {
    async select(title, options) {
      menus.push({ title, options });
      assert.ok(selects.length, `Unexpected menu: ${title}`);
      const next = selects.shift();
      if (next === undefined) return undefined;
      return options.find((option) => option === next || option.startsWith(next)) ?? next;
    },
    async editor(title, prefill) {
      fields.push({ title, prefill });
      assert.ok(edits.length, `Unexpected text field: ${title}`);
      return edits.shift();
    },
    async input() { throw new Error("Editor seam must be preferred"); },
    notify(message) { notices.push(message); },
  };
  return { ui, menus, fields, notices, assertConsumed() { assert.equal(selects.length, 0); assert.equal(edits.length, 0); } };
}

for (const [adapter, application, model] of [
  ["claude-cli", "Claude Code", "claude-opus-5-5"], ["codex-cli", "Codex", "gpt-6.1-sol"],
] as const) {
  test(`${adapter}: creates without activation, role models are application-specific`, async () => {
    const config = normalizeConfig({ externalAgents: {} });
    const before = JSON.stringify(config);
    Object.freeze(config.externalAgents); Object.freeze(config);
    const s = scripted([application, "Identifier:", "Roles:", "Execution and review", "Shared model:",
      EXTERNAL_AGENT_MODEL_CATALOG[adapter].models[0].label, "Advanced execution overrides", "Model:",
      EXTERNAL_AGENT_MODEL_CATALOG[adapter].models[1].label, "Back", "Advanced review overrides", "Model:",
      "Inherit shared model", "Back", "Create"], ["worker-1"]);
    const result = await selectExternalAgentCreation(s.ui, config);
    assert.equal(result?.adapter, adapter); assert.equal(result?.model, model);
    assert.equal(result?.execution?.model, EXTERNAL_AGENT_MODEL_CATALOG[adapter].models[1].value);
    assert.equal(result?.review?.model, undefined);
    assert.equal(JSON.stringify(config), before);
    assert.equal(config.execution?.workerResources, undefined);
    for (const menu of s.menus.filter((entry) => entry.title.startsWith("Model —"))) {
      for (const known of EXTERNAL_AGENT_MODEL_CATALOG[adapter].models) assert.ok(menu.options.includes(known.label));
      const other = adapter === "claude-cli" ? "codex-cli" : "claude-cli";
      for (const foreign of EXTERNAL_AGENT_MODEL_CATALOG[other].models) assert.ok(!menu.options.includes(foreign.label));
      assert.ok(!menu.options.some((option) => /manual/i.test(option)));
    }
    s.assertConsumed();
  });
}

test("invalid and duplicate IDs, including prototype-sensitive own IDs, do not insert", async () => {
  const config = normalizeConfig({ externalAgents: Object.fromEntries([
    ["__proto__", { adapter: "claude-cli", execution: {} }],
    ["constructor", { adapter: "codex-cli", review: {}, model: "unrelated-unknown-model" }],
  ]) });
  const before = JSON.stringify(config);
  const s = scripted(["Claude Code", "Create", "Identifier:", "Identifier:", "Identifier:", "Identifier:", "Identifier:",
    "Roles:", "Execution only", "Create"], ["bad id", ".", "__proto__", "constructor", "toString"]);
  const result = await selectExternalAgentCreation(s.ui, config);
  assert.equal(result?.id, "toString");
  assert.equal(s.notices.length, 5);
  assert.ok(s.notices.some((notice) => /unique/.test(notice)));
  assert.equal(JSON.stringify(config), before);
  s.assertConsumed();
});

test("shared/role environment and timeout remain editable without argv, executable or protocol controls", async () => {
  const s = scripted(["Codex", "Identifier:", "Roles:", "Execution and review",
    "Advanced shared environment:", "Add environment entry", "Back",
    "Advanced execution overrides", "Environment overrides:", "Add environment entry", "Back",
    "Timeout (ms):", "Timeout (ms):", "Back", "Create"],
    ["worker", "TOKEN", "secret-env", "TOKEN", "secret-role-env", "0", "90000"]);
  const result = await selectExternalAgentCreation(s.ui, normalizeConfig({}));
  assert.equal(result?.command, "codex");
  assert.deepEqual(result?.env, { TOKEN: "secret-env" });
  assert.deepEqual(result?.execution?.env, { TOKEN: "secret-role-env" });
  assert.equal(result?.execution?.timeoutMs, 90000);
  assert.equal(s.notices.length, 1);
  const display = JSON.stringify([s.menus, s.notices]);
  assert.doesNotMatch(display, /secret|executable|[Aa]rgument|[Pp]rotocol/);
  s.assertConsumed();
});

test("adapter changes retain model strings and compatible effort, automatic command replaces custom executable", async () => {
  const config = normalizeConfig({externalAgents: { agent: { adapter: "claude-cli", command: "/secret/claude", model: "claude-opus-5-5", reasoningEffort: "high", execution: {} } }});
  const s = scripted(["Adapter:", "Codex", "Apply edit", "Shared model:", "GPT-6.1-Sol", "Apply edit"]);
  const result = await selectExternalAgentEdit(s.ui, config, {id: "agent", ...config.externalAgents!.agent});
  assert.ok(result?.kind === "apply");
  assert.equal(result.agent.command, "codex"); assert.equal(result.agent.reasoningEffort, "high");
  assert.ok(s.menus.some(menu => menu.options.includes("Shared model: claude-opus-5-5")));
  assert.match(s.notices[0], /resolve invalid reasoning/);
  assert.match(s.notices[1], /removed custom executable/);
  assert.ok(!JSON.stringify(s.menus.concat()).includes("/secret"));
  s.assertConsumed();
});

test("cancellation never creates; text cancellation preserves the draft; invalid selection does not set a model", async () => {
  const config: ReviewGateConfig = normalizeConfig({});
  for (const selects of [[undefined], ["unknown adapter"], ["Claude Code", undefined], ["Claude Code", "Cancel"]]) {
    const s = scripted(selects);
    assert.equal(await selectExternalAgentCreation(s.ui, config), undefined);
    s.assertConsumed();
  }
  const s = scripted(["Claude Code", "Identifier:", "Identifier:", "Roles:", "Review only", "Shared model:", "unknown-model", "Create"], ["retained", undefined]);
  const result = await selectExternalAgentCreation(s.ui, config);
  assert.equal(result?.id, "retained"); assert.equal(result?.model, undefined);
  assert.equal(result?.execution, undefined); assert.ok(result?.review);
  s.assertConsumed();
});

test("automatic command creation never invokes process/provider", async () => {
  const forbidden = () => { throw new Error("Creation must not invoke a process/provider"); };
  const spies = [mock.method(childProcess, "spawn", forbidden), mock.method(childProcess, "spawnSync", forbidden),
    mock.method(childProcess, "exec", forbidden), mock.method(childProcess, "execFile", forbidden), mock.method(globalThis, "fetch", forbidden)];
  try {
    const s = scripted(["Claude Code", "Identifier:", "Roles:", "Execution only", "Create"], ["worker"]);
    const result = await selectExternalAgentCreation(s.ui, normalizeConfig({}));
    assert.equal(result?.command, "claude");
    for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
    s.assertConsumed();
  } finally { mock.restoreAll(); }
});

test("catalog records release verification provenance without runtime discovery", () => {
  for (const catalog of Object.values(EXTERNAL_AGENT_MODEL_CATALOG)) {
    assert.equal(catalog.verifiedOn, "2026-10-05");
    assert.match(catalog.source, /^https:\/\//);
    assert.ok(catalog.models.length > 0);
  }
});
