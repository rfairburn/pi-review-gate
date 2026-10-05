import assert from "node:assert/strict";
import test from "node:test";
import { normalizeConfig, resolvedExternalAgent, type ExternalAgentConfig } from "../src/config";
import { selectExternalAgentCreation, selectExternalAgentEdit } from "../src/settings/external-agents";
import { EXTERNAL_AGENT_MODEL_CATALOG } from "../src/settings/external-agent-models";
import type { UiContext } from "../src/settings/ui";

function script(actions: (string | undefined)[], edits: string[] = []) {
  const menus: string[][] = [], notices: string[] = [];
  const ui: UiContext = {
    async select(title, options) {
      menus.push(options);
      assert.ok(actions.length, `Unexpected menu ${title}`);
      const action = actions.shift();
      if (action === undefined) return undefined;
      const match = options.find(option => option === action || option.startsWith(action));
      assert.ok(match, `Missing ${action}: ${options.join("; ")}`);
      return match;
    },
    async editor() { assert.ok(edits.length); return edits.shift(); },
    notify(message) { notices.push(message); },
  };
  return { ui, menus, notices, consumed() { assert.equal(actions.length, 0); assert.equal(edits.length, 0); } };
}
async function edit(definition: Omit<ExternalAgentConfig, "id">, actions: (string | undefined)[]) {
  const config = normalizeConfig({ externalAgents: { worker: definition } });
  const before = structuredClone(config);
  const s = script(actions);
  const result = await selectExternalAgentEdit(s.ui, config, resolvedExternalAgent(config, "worker")!);
  assert.deepEqual(config, before);
  s.consumed();
  return { ...s, result };
}

for (const adapter of ["claude-cli", "codex-cli"] as const) {
  for (const model of EXTERNAL_AGENT_MODEL_CATALOG[adapter].models) {
    test(`${model.value}: creation offers exactly verified human-readable reasoning levels`, async () => {
      const s = script([adapter === "claude-cli" ? "Claude Code" : "Codex", "Identifier:", "Roles:", "Execution and review",
        "Shared model:", model.label, "Shared reasoning:", "CLI default", "Advanced execution overrides", "Reasoning:", "Inherit shared reasoning", "Back", "Create"], ["worker"]);
      const result = await selectExternalAgentCreation(s.ui, normalizeConfig({}));
      assert.equal(result?.model, model.value);
      assert.equal(result?.reasoningEffort, "default");
      assert.equal(result?.execution?.reasoningEffort, undefined);
      const selector = s.menus.find(rows => rows.includes("CLI default (no app-owned effort flag)"))!;
      assert.equal(selector.length, model.effortLevels.length + 1);
      assert.equal(selector.includes("Ultra — automatic task delegation"), model.effortLevels.some(level => level === "ultra"));
      assert.equal(selector.includes("Max"), model.effortLevels.some(level => level === "max"));
      assert.equal(selector.includes("Extra High (xhigh)"), model.effortLevels.some(level => level === "xhigh"));
      assert.doesNotMatch(JSON.stringify(s.menus), /[Aa]rgument|executable|[Pp]rotocol|manual/);
      s.consumed();
    });
  }
}

test("legacy shared and role override import is simultaneous, canonicalized with private cleanup warnings", async () => {
  const { result, notices, menus } = await edit({ adapter: "claude-cli", model: "claude-opus-5-5", command: "/secret-path/claude",
    args: ["--effort", "high", "--effort=high", "secret-arg"], env: { TOKEN: "secret-env" },
    execution: { args: ["--effort", "low", "role-secret"], protocol: "pi-review-executor-jsonl-v1", env: {} }, review: {} }, ["Apply edit"]);
  assert.ok(result?.kind === "apply");
  assert.equal(result.agent.reasoningEffort, "high"); assert.equal(result.agent.execution?.reasoningEffort, "low");
  assert.equal(result.agent.review?.reasoningEffort, undefined);
  assert.deepEqual(result.agent.args, []); assert.deepEqual(result.agent.execution?.args, []);
  assert.equal(result.agent.execution?.protocol, undefined); assert.equal(result.agent.command, "claude");
  assert.deepEqual(result.agent.execution?.env, {}); assert.deepEqual(result.agent.env, { TOKEN: "secret-env" });
  assert.match(notices.join(" "), /identical-duplicates/);
  assert.match(notices.join(" "), /removed other argument tokens 1/);
  assert.match(notices.join(" "), /removed protocol override/);
  assert.doesNotMatch(JSON.stringify([menus, notices]), /secret-path|secret-arg|role-secret|secret-env/);
});

for (const args of [["--effort", "low", "--effort", "high"], ["--effort=secret-unknown"], ["--effort"]]) {
  test(`unresolved legacy pattern (${args.length} tokens) blocks until explicit CLI default`, async () => {
    const { result, menus, notices } = await edit({ adapter: "claude-cli", model: "claude-opus-5-5", args, execution: {} },
      ["Apply edit", "Shared reasoning:", "CLI default", "Apply edit"]);
    assert.ok(result?.kind === "apply"); assert.equal(result.agent.reasoningEffort, "default");
    assert.match(notices[0], /Cannot apply/); assert.match(JSON.stringify(menus), /Invalid — resolve explicitly/);
    assert.doesNotMatch(JSON.stringify([menus, notices]), /secret-unknown/);
  });
}

test("role explicit inheritance resolves owned conflicting tokens and preserves shared effort", async () => {
  const { result, notices } = await edit({ adapter: "claude-cli", model: "claude-opus-5-5", args: ["--effort=high"],
    execution: { args: ["--effort=low", "--effort=max"] } },
    ["Apply edit", "Advanced execution overrides", "Reasoning:", "Inherit shared reasoning", "Back", "Apply edit"]);
  assert.ok(result?.kind === "apply"); assert.equal(result.agent.reasoningEffort, "high");
  assert.equal(result.agent.execution?.reasoningEffort, undefined); assert.deepEqual(result.agent.execution?.args, []);
  assert.match(notices[0], /execution/);
});

test("inherited effort is validated against role model; default clears inherited effort", async () => {
  const { result, notices, menus } = await edit({ adapter: "claude-cli", model: "claude-opus-5-5", reasoningEffort: "high",
    execution: { model: "claude-haiku-4-5", reasoningEffort: "default" }, review: { model: "claude-haiku-4-5" } },
    ["Apply edit", "Advanced review overrides", "Reasoning:", "CLI default", "Back", "Apply edit"]);
  assert.ok(result?.kind === "apply"); assert.equal(result.agent.review?.reasoningEffort, "default");
  assert.equal(notices.filter(notice => notice.startsWith("Cannot apply")).length, 1);
  assert.deepEqual(menus.find(rows => rows.includes("CLI default (no app-owned effort flag)")), ["CLI default (no app-owned effort flag)"]);
});

for (const model of ["opus", "custom-pinned"]) test(`role model ${model} never offers unverified inherited High`, async () => {
  const { result, menus } = await edit({ adapter: "claude-cli", model: "claude-opus-5-5", reasoningEffort: "high",
    execution: { model } }, ["Advanced execution overrides", "Reasoning:", "CLI default", "Back", "Apply edit"]);
  assert.ok(result?.kind === "apply"); assert.equal(result.agent.execution?.reasoningEffort, "default");
  assert.deepEqual(menus.find(rows => rows.includes("CLI default (no app-owned effort flag)")), ["CLI default (no app-owned effort flag)"]);
});

test("unresolved shared effort cannot be selected through role inheritance", async () => {
  const { result, menus, notices } = await edit({ adapter: "claude-cli", model: "claude-opus-5-5",
    args: ["--effort=low", "--effort=high"], execution: {} },
    ["Advanced execution overrides", "Reasoning:", "CLI default", "Back", "Cancel"]);
  assert.equal(result, undefined); assert.deepEqual(notices, []);
  assert.ok(!menus.find(rows => rows.includes("CLI default (no app-owned effort flag)"))!.includes("Inherit shared reasoning"));
});

for (const model of [undefined, "opus", "custom-pinned"]) test(`unverified model ${model ?? "CLI default"} preserves value but effort requires resolution`, async () => {
  const { result, menus } = await edit({ adapter: "claude-cli", model, reasoningEffort: "high", execution: {} },
    ["Apply edit", "Shared reasoning:", "CLI default", "Apply edit"]);
  assert.ok(result?.kind === "apply"); assert.equal(result.agent.model, model); assert.equal(result.agent.reasoningEffort, "default");
  assert.deepEqual(menus.find(rows => rows.includes("CLI default (no app-owned effort flag)")), ["CLI default (no app-owned effort flag)"]);
});

test("model change retains incompatible Ultra visibly until model explicitly restored", async () => {
  const { result, notices, menus } = await edit({ adapter: "codex-cli", model: "gpt-6.1-sol", reasoningEffort: "ultra", execution: {} },
    ["Shared model:", "GPT-6-Luna", "Apply edit", "Shared model:", "GPT-6.1-Sol", "Apply edit"]);
  assert.ok(result?.kind === "apply"); assert.equal(result.agent.reasoningEffort, "ultra");
  assert.match(notices[0], /Cannot apply/); assert.match(JSON.stringify(menus), /Invalid — resolve explicitly; Ultra/);
});

test("disabled role conflicts do not validate; original adapter warning counts survive translation", async () => {
  const { result, notices } = await edit({ adapter: "claude-cli", model: "claude-opus-5-5", args: ["--effort=high", "secret-token"],
    execution: {}, review: { args: ["--effort=low", "--effort=max"] } },
    ["Roles:", "Execution only", "Adapter:", "Codex", "Shared model:", "GPT-6.1-Sol", "Apply edit"]);
  assert.ok(result?.kind === "apply"); assert.equal(result.agent.reasoningEffort, "high"); assert.equal(result.agent.review, undefined);
  assert.match(notices[0], /shared: normalized\/cleared legacy reasoning settings 1; removed other argument tokens 1/);
});

test("structured shared effort remains authoritative over stale legacy role flags", async () => {
  const { result, notices } = await edit({ adapter: "claude-cli", model: "claude-opus-5-5", reasoningEffort: "default",
    execution: { args: ["--effort=low", "--effort=high"] } }, ["Apply edit"]);
  assert.ok(result?.kind === "apply"); assert.equal(result.agent.execution?.reasoningEffort, undefined);
  assert.equal(result.agent.reasoningEffort, "default"); assert.match(notices[0], /stale-literal-effort/);
});

for (const cancel of ["Cancel", undefined]) test(`opening and ${cancel ?? "Escape"} leaves malformed legacy definition untouched with no cleanup notices`, async () => {
  const { result, notices } = await edit({ adapter: "claude-cli", args: ["--effort=secret"], command: "/secret/path", execution: {} }, [cancel]);
  assert.equal(result, undefined); assert.deepEqual(notices, []);
});

for (const prefix of ["-c", "-c="]) {
  test(`Codex ${prefix} attached High imports for shared and role scopes`, async () => {
    const { result, menus, notices } = await edit({ adapter: "codex-cli", model: "gpt-6.1-sol",
      command: "/secret-path/codex", args: [`${prefix}model_reasoning_effort="high"`, "secret-arg"],
      execution: { args: [`${prefix}model_reasoning_effort="low"`] }, review: {} }, ["Apply edit"]);
    assert.ok(result?.kind === "apply");
    assert.equal(result.agent.reasoningEffort, "high");
    assert.equal(result.agent.execution?.reasoningEffort, "low");
    assert.equal(result.agent.review?.reasoningEffort, undefined);
    assert.match(JSON.stringify(menus), /Shared reasoning: High/);
    assert.deepEqual(result.agent.args, []);
    assert.deepEqual(result.agent.execution?.args, []);
    assert.doesNotMatch(JSON.stringify([menus, notices]), /secret-path|secret-arg|model_reasoning_effort/);
  });

  for (const location of ["shared", "review", "execution"] as const) {
    for (const pattern of ["conflicting", "unknown"] as const) {
      test(`Codex ${prefix} attached ${pattern} ${location} effort blocks Apply until explicitly resolved`, async () => {
        const args = pattern === "conflicting" ? [`${prefix}model_reasoning_effort="high"`, "-cmodel_reasoning_effort=low"]
          : [`${prefix}model_reasoning_effort="secret-unknown"`];
        const scope = location === "shared" ? { args, execution: {} } : { execution: {}, [location]: { args } };
        const actions = location === "shared" ? ["Apply edit", "Shared reasoning:", "CLI default", "Apply edit"]
          : ["Apply edit", `Advanced ${location} overrides`, "Reasoning:", "CLI default", "Back", "Apply edit"];
        const { result, menus, notices } = await edit({ adapter: "codex-cli", model: "gpt-6.1-sol", command: "/secret-path/codex", ...scope }, actions);
        assert.ok(result?.kind === "apply");
        assert.equal((location === "shared" ? result.agent : result.agent[location])?.reasoningEffort, "default");
        assert.equal(notices.filter(notice => notice.startsWith("Cannot apply")).length, 1);
        assert.match(JSON.stringify(menus), /Invalid — resolve explicitly/);
        assert.doesNotMatch(JSON.stringify([menus, notices]), /secret-unknown|secret-path|model_reasoning_effort/);
      });
    }
  }
}

for (const model of [undefined, "custom-pinned"]) test(`Codex attached High with ${model ?? "default model"} requires verified-model resolution`, async () => {
  const { result, menus, notices } = await edit({ adapter: "codex-cli", model,
    args: ['-cmodel_reasoning_effort="high"'], execution: {} }, ["Apply edit", "Shared reasoning:", "CLI default", "Apply edit"]);
  assert.ok(result?.kind === "apply");
  assert.equal(result.agent.model, model);
  assert.equal(result.agent.reasoningEffort, "default");
  assert.match(notices[0], /Cannot apply/);
  assert.deepEqual(menus.find(rows => rows.includes("CLI default (no app-owned effort flag)")), ["CLI default (no app-owned effort flag)"]);
});

test("Codex structured default supersedes stale attached shared and inherited role effort", async () => {
  const { result, notices } = await edit({ adapter: "codex-cli", model: "gpt-6.1-sol", reasoningEffort: "default",
    args: ['-cmodel_reasoning_effort="high"'], execution: { args: ["-cmodel_reasoning_effort=low", "-c=model_reasoning_effort=secret-unknown"] } }, ["Apply edit"]);
  assert.ok(result?.kind === "apply");
  assert.equal(result.agent.reasoningEffort, "default");
  assert.equal(result.agent.execution?.reasoningEffort, undefined);
  assert.deepEqual(result.agent.args, []);
  assert.deepEqual(result.agent.execution?.args, []);
  assert.match(notices.join(" "), /stale-literal-effort/);
  assert.doesNotMatch(notices.join(" "), /secret-unknown|model_reasoning_effort/);
});

for (const cancel of ["Cancel", undefined]) test(`Codex attached unknown effort remains untouched on ${cancel ?? "Escape"}`, async () => {
  const { result, notices } = await edit({ adapter: "codex-cli", args: ["-cmodel_reasoning_effort=secret-unknown"],
    command: "/secret-path/codex", execution: {} }, [cancel]);
  assert.equal(result, undefined);
  assert.deepEqual(notices, []);
});
