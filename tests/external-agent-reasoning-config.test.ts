import assert from "node:assert/strict";
import test from "node:test";
import { activeExternalExecutor, normalizeConfig, resolveReviewers, resolvedWorkerRoute, type ExternalAgentValue } from "../src/config";

function configFor(agent: ExternalAgentValue) {
  return normalizeConfig({ externalAgents: { native: agent }, review: { activeReviewers: [{ source: "external", id: "native" }] }, execution: { workerResources: { native: { selection: { source: "external", id: "native" }, maxConcurrent: 1 } }, routes: { research: [{ resourceId: "native" }], execute: [{ resourceId: "native" }] } } });
}

test("native shared and role fields roundtrip without model gating or argv mutation", () => {
  for (const adapter of ["claude-cli", "codex-cli"] as const) {
    const config = configFor({ adapter, model: "unknown", reasoningEffort: "high", args: ["--old"], review: { reasoningEffort: "default" }, execution: { reasoningEffort: "low" } });
    assert.deepEqual(normalizeConfig(JSON.parse(JSON.stringify(config))).externalAgents, config.externalAgents);
    assert.equal(config.externalAgents!.native!.reasoningEffort, "high");
    assert.equal(config.externalAgents!.native!.review!.reasoningEffort, "default");
    assert.deepEqual(config.externalAgents!.native!.args, ["--old"]);
  }
});

test("native values reject safely, foreign schemas stay unchanged", () => {
  for (const scope of ["shared", "review", "execution"] as const) {
    for (const invalid of ["secret-token", "ultra", null, 3]) {
      const agent: Record<string, unknown> = { adapter: "claude-cli", review: {}, execution: {} };
      if (scope === "shared") agent.reasoningEffort = invalid;
      else agent[scope] = { reasoningEffort: invalid };
      assert.throws(() => normalizeConfig({ externalAgents: { native: agent } }), (error: unknown) => error instanceof Error && error.message === "invalid native external agent reasoningEffort");
    }
  }
  assert.equal(configFor({ adapter: "codex-cli", reasoningEffort: "ultra", review: {} }).externalAgents!.native!.reasoningEffort, "ultra");
  const config = normalizeConfig({ externalAgents: { foreign: { adapter: "generic-cli", command: "custom", reasoningEffort: "secret-token", review: { reasoningEffort: "bad" } } } });
  assert.ok(!Object.hasOwn(config.externalAgents!.foreign!, "reasoningEffort"));
  assert.ok(!Object.hasOwn(config.externalAgents!.foreign!.review!, "reasoningEffort"));
});

test("runtime structured role/default wins, stale efforts strip, unrelated guards preserved", () => {
  for (const adapter of ["claude-cli", "codex-cli"] as const) {
    const staleShared = adapter === "claude-cli" ? ["--effort=low"] : ["--config=model_reasoning_effort=low"];
    const staleRole = adapter === "claude-cli" ? ["--effort", "medium"] : ["-c", 'model_reasoning_effort="medium"'];
    const canonical = (level: string) => adapter === "claude-cli" ? ["--effort", level] : ["-c", `model_reasoning_effort="${level}"`];
    for (const override of [undefined, "max", "default"] as const) {
      const config = configFor({ adapter, command: "custom-native", model: "unknown", reasoningEffort: "high", args: [...staleShared, "--sandbox", "read-only"], review: { args: [...staleRole, "--review-guard"], reasoningEffort: override }, execution: { args: [...staleRole, "--execute-guard"], reasoningEffort: override, protocol: "pi-review-executor-jsonl-v1" } });
      const effective = override ?? "high";
      const tail = effective === "default" ? [] : canonical(effective);
      const reviewer = resolveReviewers(config).reviewers[0]!;
      const executor = activeExternalExecutor(config, { source: "external", id: "native" })!;
      assert.deepEqual(reviewer.args, ["--sandbox", "read-only", "--review-guard", ...tail]);
      assert.deepEqual(executor.args, ["--sandbox", "read-only", "--execute-guard", ...tail]);
      assert.equal(executor.command, "custom-native");
      assert.equal(config.externalAgents!.native!.execution!.protocol, "pi-review-executor-jsonl-v1");
      const research = resolvedWorkerRoute(config, "research")[0]!;
      assert.deepEqual(activeExternalExecutor(config, research.selection)!.args, executor.args);
    }
  }
});

test("reviewer and executor descriptors filter effort across shared/role boundaries", () => {
  for (const adapter of ["claude-cli", "codex-cli"] as const) {
    const sharedArgs = [adapter === "claude-cli" ? "--effort" : "--config"];
    const roleArgs = [adapter === "claude-cli" ? "low" : 'model_reasoning_effort="low"'];
    for (const reasoningEffort of [undefined, "high", "default"] as const) {
      const config = configFor({ adapter, args: sharedArgs, reasoningEffort, review: { args: roleArgs }, execution: { args: roleArgs } });
      const expected = reasoningEffort === undefined ? [...sharedArgs, ...roleArgs] : reasoningEffort === "default" ? [] : adapter === "claude-cli" ? ["--effort", "high"] : ["-c", 'model_reasoning_effort="high"'];
      assert.deepEqual(resolveReviewers(config).reviewers[0]!.args, expected);
      assert.deepEqual(activeExternalExecutor(config, { source: "external", id: "native" })!.args, expected);
    }
  }
});

test("missing fields preserve exact legacy duplicate concat and commands/protocol", () => {
  const agent: ExternalAgentValue = { adapter: "claude-cli", command: "old-claude", args: ["--effort", "high"], review: { args: ["--effort=low"] }, execution: { args: [], protocol: "pi-review-executor-jsonl-v1" } };
  const config = configFor(agent);
  assert.ok(!Object.hasOwn(config.externalAgents!.native!, "reasoningEffort"));
  assert.ok(!Object.hasOwn(config.externalAgents!.native!.execution!, "reasoningEffort"));
  assert.deepEqual(resolveReviewers(config).reviewers[0]!.args, ["--effort", "high", "--effort=low"]);
  assert.deepEqual(activeExternalExecutor(config, { source: "external", id: "native" })!.args, ["--effort", "high"]);
  assert.equal(config.externalAgents!.native!.command, "old-claude");
  const defaultRole = configFor({ ...agent, execution: { reasoningEffort: "default" } });
  assert.deepEqual(activeExternalExecutor(defaultRole, { source: "external", id: "native" })!.args, []);
});

test("Codex attached effort honors shared and role settings without mutating legacy config", () => {
  const sharedArgs = ['-cmodel_reasoning_effort="high"', '-cmodel_reasoning_effort_extra="low"', "--sandbox", "read-only"];
  const roleArgs = ["-c=model_reasoning_effort=low", "-c", "other_model_reasoning_effort=medium", "--role-guard"];
  const preserved = [...sharedArgs.slice(1), ...roleArgs.slice(1)];
  for (const model of [undefined, "custom-pinned"])
    for (const shared of [undefined, "default", "high"] as const)
      for (const role of [undefined, "default", "medium"] as const) {
        const config = configFor({ adapter: "codex-cli", model, args: sharedArgs, reasoningEffort: shared,
          review: { args: roleArgs, reasoningEffort: role }, execution: { args: roleArgs, reasoningEffort: role } });
        const before = structuredClone(config);
        const effort = role ?? shared;
        const expected = effort === undefined ? [...sharedArgs, ...roleArgs]
          : [...preserved, ...(effort === "default" ? [] : ["-c", `model_reasoning_effort="${effort}"`])];
        assert.deepEqual(resolveReviewers(config).reviewers[0]!.args, expected);
        assert.deepEqual(activeExternalExecutor(config, { source: "external", id: "native" })!.args, expected);
        assert.deepEqual(config, before);
        assert.deepEqual(config.externalAgents!.native!.args, sharedArgs);
        assert.deepEqual(config.externalAgents!.native!.execution!.args, roleArgs);
      }
});
