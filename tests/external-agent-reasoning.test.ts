import assert from "node:assert/strict";
import test from "node:test";
import { encodeNativeReasoning, importNativeReasoning, nativeReasoningArgs, parseLiteralReasoning, validateNativeReasoning } from "../src/external-agent-reasoning";

test("Codex attached short config options import and filter only exact effort keys", () => {
  for (const prefix of ["-c", "-c="]) {
    const effort = `${prefix}model_reasoning_effort="high"`;
    const unrelated = [`${prefix}other_model_reasoning_effort="low"`, `${prefix}model_reasoning_effort_extra="low"`, "--sandbox", "read-only"];
    assert.deepEqual(parseLiteralReasoning("codex-cli", [effort, ...unrelated]), {
      reasoning: { kind: "value", value: "high" }, remainingArgs: unrelated,
      recognizedSettingCount: 1, removedTokenCount: 1, warnings: [],
    });
    const shared = [effort, ...unrelated];
    const role = ['-cmodel_reasoning_effort="low"', "--role-guard"];
    assert.deepEqual(nativeReasoningArgs("codex-cli", shared, role, undefined), [...shared, ...role]);
    assert.deepEqual(nativeReasoningArgs("codex-cli", shared, role, "default"), [...unrelated, "--role-guard"]);
    assert.deepEqual(nativeReasoningArgs("codex-cli", shared, role, "high"), [...unrelated, "--role-guard", "-c", 'model_reasoning_effort="high"']);
    const conflicting = parseLiteralReasoning("codex-cli", [effort, "-cmodel_reasoning_effort=low"]);
    assert.deepEqual(conflicting.reasoning, { kind: "unresolved", reason: "conflicting" });
    const unknown = parseLiteralReasoning("codex-cli", [`${prefix}model_reasoning_effort="secret-unknown"`]);
    assert.deepEqual(unknown.reasoning, { kind: "unresolved", reason: "malformed-or-unknown" });
    assert.deepEqual(unknown.warnings, ["malformed-or-unknown-effort"]);
    assert.ok(!JSON.stringify(unknown).includes("secret-unknown"));
  }
});

test("literal native canonical and equivalent effort forms", () => {
  for (const args of [["--effort", "high"], ["--effort=high"]]) {
    assert.deepEqual(parseLiteralReasoning("claude-cli", args).reasoning, { kind: "value", value: "high" });
  }
  for (const args of [["-c", 'model_reasoning_effort="ultra"'], ["--config", "model_reasoning_effort='ultra'"], ["-c=model_reasoning_effort=ultra"], ["--config=model_reasoning_effort=ultra"]]) {
    assert.deepEqual(parseLiteralReasoning("codex-cli", args).reasoning, { kind: "value", value: "ultra" });
  }
  assert.deepEqual(encodeNativeReasoning("claude-cli", "max"), ["--effort", "max"]);
  assert.deepEqual(encodeNativeReasoning("codex-cli", "xhigh"), ["-c", 'model_reasoning_effort="xhigh"']);
  assert.deepEqual(encodeNativeReasoning("codex-cli", "default"), []);
  assert.throws(() => encodeNativeReasoning("claude-cli", "ultra"), /invalid native reasoning effort/);
});

test("no shell splitting, no unrelated key prefix matching, and no [] sentinel", () => {
  const args = ["--effort high", "-c", 'model_reasoning_effort_extra="high"', "--config=model_reasoning_effort_other=high"];
  assert.deepEqual(parseLiteralReasoning("codex-cli", args).remainingArgs, args);
  assert.equal(parseLiteralReasoning("claude-cli", ["--effort high"]).reasoning.kind, "absent");
  assert.equal(parseLiteralReasoning("claude-cli", []).reasoning.kind, "absent");
  assert.deepEqual(nativeReasoningArgs("claude-cli", ["--effort", "high"], [], undefined), ["--effort", "high"]);
});

test("duplicates and invalid literal imports require no guesses and have private diagnostics", () => {
  const identical = parseLiteralReasoning("claude-cli", ["--effort", "high", "--effort=high"]);
  assert.deepEqual(identical.reasoning, { kind: "value", value: "high" });
  assert.deepEqual(identical.warnings, ["identical-duplicates"]);
  const conflicting = parseLiteralReasoning("claude-cli", ["--effort=high", "--effort=low"]);
  assert.deepEqual(conflicting.reasoning, { kind: "unresolved", reason: "conflicting" });
  for (const args of [["--effort"], ["--effort=secret-token"], ["--effort=ultra"], ["--effort=default"], ["--effort=high", "--effort=secret-token"]]) {
    const parsed = parseLiteralReasoning("claude-cli", args);
    assert.deepEqual(parsed.reasoning, { kind: "unresolved", reason: "malformed-or-unknown" });
    assert.ok(!JSON.stringify(parsed).includes("secret-token"));
  }
  assert.deepEqual(parseLiteralReasoning("claude-cli", ["--effort", "--sandbox"]).remainingArgs, ["--sandbox"]);
  assert.equal(parseLiteralReasoning("codex-cli", ["-c", "model_reasoning_effort"]).reasoning.kind, "unresolved");
});

test("typed editor extraction is authoritative and exposes per-location drop counts", () => {
  const imported = importNativeReasoning("claude-cli", { reasoningEffort: "default", args: ["--effort=secret-token", "--unsafe"], review: { args: ["--effort=low", "--effort=high"] }, execution: {} });
  assert.deepEqual(imported[0], { location: "shared", reasoning: { kind: "structured", value: "default" }, recognizedSettingCount: 1, droppedOtherTokenCount: 1, warnings: ["stale-literal-effort"] });
  assert.equal(imported[1]!.reasoning.kind, "absent");
  assert.deepEqual(imported[1]!.warnings, ["stale-literal-effort"]);
  assert.equal(imported[2]!.reasoning.kind, "absent");
  assert.ok(!JSON.stringify(imported).includes("secret-token"));
});

test("runtime filtering recognizes effort settings spanning shared/role argv", () => {
  for (const adapter of ["claude-cli", "codex-cli"] as const) {
    const shared = ["--guard", adapter === "claude-cli" ? "--effort" : "-c"];
    const role = [adapter === "claude-cli" ? "low" : 'model_reasoning_effort="low"', "--role-guard"];
    assert.deepEqual(nativeReasoningArgs(adapter, shared, role, undefined), [...shared, ...role]);
    assert.deepEqual(nativeReasoningArgs(adapter, shared, role, "default"), ["--guard", "--role-guard"]);
    assert.deepEqual(nativeReasoningArgs(adapter, shared, role, "high"), ["--guard", "--role-guard", ...encodeNativeReasoning(adapter, "high")]);
  }
});

test("role imports retain inherited structured authority over all stale literal flags", () => {
  for (const adapter of ["claude-cli", "codex-cli"] as const) {
    const flag = (value: string) => adapter === "claude-cli" ? `--effort=${value}` : `--config=model_reasoning_effort=${value}`;
    for (const shared of ["high", "default"] as const) {
      for (const args of [[flag("low")], [flag("low"), flag("high")], [flag("secret-token")]]) {
        for (const location of ["review", "execution"] as const) {
          const imported = importNativeReasoning(adapter, { reasoningEffort: shared, [location]: { args } })[1]!;
          assert.deepEqual(imported.reasoning, { kind: "absent" });
          assert.deepEqual(imported.warnings, ["stale-literal-effort"]);
          assert.equal(imported.recognizedSettingCount, args.length);
          assert.ok(!JSON.stringify(imported).includes("secret-token"));
          const override = importNativeReasoning(adapter, { reasoningEffort: shared, [location]: { args, reasoningEffort: "default" } })[1]!;
          assert.deepEqual(override.reasoning, { kind: "structured", value: "default" });
        }
      }
    }
    assert.equal(importNativeReasoning(adapter, { review: { args: [flag("low"), flag("high")] } })[1]!.reasoning.kind, "unresolved");
  }
});

test("edited-only exact-model validation handles inheritance, defaults, Haiku, and model changes", () => {
  assert.deepEqual(validateNativeReasoning("codex-cli", { model: "gpt-6.1-sol", reasoningEffort: "ultra", review: {}, execution: { reasoningEffort: "default", model: "unknown" } }), []);
  assert.deepEqual(validateNativeReasoning("codex-cli", { model: "gpt-6.1-sol", reasoningEffort: "ultra", review: { model: "gpt-5.5" } }), [{ location: "review", reason: "unsupported-effort" }]);
  for (const model of [undefined, "default", "opus", "unknown"]) {
    assert.deepEqual(validateNativeReasoning("claude-cli", { model, reasoningEffort: "high" }), [{ location: "shared", reason: "unverified-model" }]);
    assert.deepEqual(validateNativeReasoning("claude-cli", { model, reasoningEffort: "default", execution: {} }), []);
  }
  for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-20251001"]) {
    assert.deepEqual(validateNativeReasoning("claude-cli", { model, execution: { reasoningEffort: "low" } }), [{ location: "execution", reason: "unsupported-effort" }]);
  }
  assert.deepEqual(validateNativeReasoning("claude-cli", { model: "claude-opus-5-5", reasoningEffort: "max", execution: {} }), []);
});
