import assert from "node:assert/strict";
import test, { mock } from "node:test";
import childProcess from "node:child_process";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { selectExternalAgentCreation } from "../src/settings/external-agents";
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
  ["claude-cli", "Claude Code", "sonnet"], ["codex-cli", "Codex", "gpt-6.1-sol"],
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

test("structured shared/role args and env, literal secrets, timeout feedback and executable validation", async () => {
  const s = scripted(["Codex", "Identifier:", "Application executable:", "Application executable:",
    "Roles:", "Execution and review", "Advanced shared arguments:", "Add argument", "Add argument", "Argument 1", "Edit value", "Back",
    "Advanced shared environment:", "Add environment entry", "Add environment entry", "Add environment entry", "Environment entry 1", "Edit value", "Back",
    "Advanced execution overrides", "Additional arguments:", "Add argument", "Back", "Environment overrides:", "Add environment entry", "Back",
    "Timeout (ms):", "Timeout (ms):", "Timeout (ms):", "Timeout (ms):", "Back", "Create"],
  ["codex-worker", "/bin/unknown", "C:\\Apps\\codex.cmd", "secret-arg", "second-secret", "changed-secret",
    "TOKEN", "secret-env", "TOKEN", "OTHER", "other-secret", "changed-env-secret", "role-secret", "TOKEN", "role-env-secret", "0", "1.5", "90000", ""]);
  const config = normalizeConfig({});
  const result = await selectExternalAgentCreation(s.ui, config);
  assert.equal(result?.command, "C:\\Apps\\codex.cmd");
  assert.deepEqual(result?.args, ["changed-secret", "second-secret"]);
  assert.deepEqual(result?.env, { TOKEN: "changed-env-secret", OTHER: "other-secret" });
  assert.deepEqual(result?.execution?.args, ["role-secret"]);
  assert.deepEqual(result?.execution?.env, { TOKEN: "role-env-secret" });
  assert.equal(result?.execution?.timeoutMs, undefined);
  assert.equal(s.notices.length, 4);
  assert.ok(s.notices.some((notice) => /positive integer.*60000/.test(notice)));
  const display = JSON.stringify([s.menus, s.notices]);
  for (const secret of ["secret-arg", "second-secret", "changed-secret", "secret-env", "changed-env-secret", "other-secret", "role-secret", "role-env-secret"]) {
    assert.ok(!display.includes(secret), `Summary leaked ${secret}`);
  }
  s.assertConsumed();
});

test("optional overrides inherit, unset model works, adapter changes clear incompatible models and command", async () => {
  const s = scripted(["Claude Code", "Identifier:", "Roles:", "Execution only", "Shared model:", "Sonnet", "Application executable:",
    "Advanced execution overrides", "Model:", "Opus", "Timeout (ms):", "Back", "Adapter:", "Codex", "Shared model:", "GPT-6 Luna", "Shared model:", "Unset", "Create"],
  ["agent", "/usr/bin/claude.exe", "60000"]);
  const result = await selectExternalAgentCreation(s.ui, normalizeConfig({}));
  assert.equal(result?.adapter, "codex-cli"); assert.equal(result?.command, "codex");
  assert.equal(result?.model, undefined); assert.equal(result?.execution?.model, undefined);
  assert.equal(result?.execution?.timeoutMs, 60000); assert.equal(result?.review, undefined);
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

test("missing matching executable is accepted without process or provider invocation", async () => {
  const forbidden = () => { throw new Error("Creation must not invoke a process/provider"); };
  const spawn = mock.method(childProcess, "spawn", forbidden);
  const spawnSync = mock.method(childProcess, "spawnSync", forbidden);
  const exec = mock.method(childProcess, "exec", forbidden);
  const execFile = mock.method(childProcess, "execFile", forbidden);
  const fetch = mock.method(globalThis, "fetch", forbidden);
  try {
    const s = scripted(["Claude Code", "Identifier:", "Application executable:", "Roles:", "Execution only", "Create"],
      ["missing-cli", "/nonexistent/application-directory/claude"]);
    const result = await selectExternalAgentCreation(s.ui, normalizeConfig({}));
    assert.equal(result?.command, "/nonexistent/application-directory/claude");
    for (const spy of [spawn, spawnSync, exec, execFile, fetch]) assert.equal(spy.mock.callCount(), 0);
    s.assertConsumed();
  } finally { mock.restoreAll(); }
});

test("structured entries can be renamed/removed, with invalid keys rejected and positive timeout retained", async () => {
  const s = scripted(["Codex", "Identifier:", "Roles:", "Review only", "Advanced shared arguments:", "Add argument", "Argument 1", "Remove", "Back",
    "Advanced shared environment:", "Add environment entry", "Add environment entry", "Environment entry 1", "Edit key", "Environment entry 1", "Edit key", "Environment entry 1", "Remove", "Back",
    "Advanced review overrides", "Timeout (ms):", "Back", "Create"],
  ["entry-editor", "removed-secret", "bad=key", "OLD", "removed-env-secret", "", "NEW", "60000"]);
  const result = await selectExternalAgentCreation(s.ui, normalizeConfig({}));
  assert.deepEqual(result?.args, []); assert.equal(result?.env, undefined);
  assert.equal(result?.review?.timeoutMs, 60000);
  assert.equal(s.notices.length, 2);
  s.assertConsumed();
});

test("catalog records release verification provenance without runtime discovery", () => {
  for (const catalog of Object.values(EXTERNAL_AGENT_MODEL_CATALOG)) {
    assert.equal(catalog.verifiedOn, "2026-10-04");
    assert.match(catalog.source, /^https:\/\//);
    assert.ok(catalog.models.length > 0);
  }
});
