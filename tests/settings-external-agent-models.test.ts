import assert from "node:assert/strict";
import test from "node:test";
import { EXTERNAL_AGENT_MODEL_CATALOG, externalAgentModelCapability, type ExternalAgentModelCapability } from "../src/settings/external-agent-models";

const toXhigh = ["low", "medium", "high", "xhigh"];
const toMax = [...toXhigh, "max"];
const toUltra = [...toMax, "ultra"];

function metadata(models: readonly ExternalAgentModelCapability[]) {
  return models.map(({ value, label, effortLevels, defaultEffort }) => [value, label, effortLevels, defaultEffort]);
}

test("all eight pinned Codex models preserve exact labels, native capabilities and bundled defaults", () => {
  assert.deepEqual(metadata(EXTERNAL_AGENT_MODEL_CATALOG["codex-cli"].models), [
    ["gpt-6.1-sol", "GPT-6.1-Sol (gpt-6.1-sol)", toUltra, "low"],
    ["gpt-6-astra", "GPT-6-Astra (gpt-6-astra)", toUltra, "low"],
    ["gpt-6-sol", "GPT-6-Sol (gpt-6-sol)", toUltra, "medium"],
    ["gpt-6-luna", "GPT-6-Luna (gpt-6-luna)", toMax, "medium"],
    ["gpt-5.6-sol", "GPT-5.6-Sol (gpt-5.6-sol)", toUltra, "low"],
    ["gpt-5.6-terra", "GPT-5.6-Terra (gpt-5.6-terra)", toUltra, "medium"],
    ["gpt-5.6-luna", "GPT-5.6-Luna (gpt-5.6-luna)", toMax, "medium"],
    ["gpt-5.5", "GPT-5.5 (gpt-5.5)", toXhigh, "medium"],
  ]);
});

test("all four versioned Claude models have exact native defaults and Haiku has no effort", () => {
  assert.deepEqual(metadata(EXTERNAL_AGENT_MODEL_CATALOG["claude-cli"].models), [
    ["claude-opus-5-5", "Opus 5.5 (claude-opus-5-5)", toMax, "medium"],
    ["claude-fable-5-1", "Fable 5.1 (claude-fable-5-1)", toMax, "high"],
    ["claude-sonnet-5-5", "Sonnet 5.5 (claude-sonnet-5-5)", toMax, "medium"],
    ["claude-haiku-4-5", "Haiku 4.5 (claude-haiku-4-5)", [], undefined],
  ]);
});

test("native Max remains distinct from xhigh and Ultra is retained as data", () => {
  for (const catalog of Object.values(EXTERNAL_AGENT_MODEL_CATALOG)) {
    for (const model of catalog.models as readonly ExternalAgentModelCapability[]) {
      assert.equal(new Set(model.effortLevels).size, model.effortLevels.length);
      assert.ok(!model.effortLevels.some((level: string) => level === "off" || level === "minimal"));
      if (model.defaultEffort !== undefined) assert.ok(model.effortLevels.includes(model.defaultEffort));
      if (model.effortLevels.includes("max")) {
        assert.ok(model.effortLevels.includes("xhigh"));
        assert.notEqual(model.effortLevels.indexOf("max"), model.effortLevels.indexOf("xhigh"));
      }
    }
  }
  assert.ok(externalAgentModelCapability("codex-cli", "gpt-6.1-sol")!.effortLevels.includes("ultra"));
});

test("lookup accepts exact IDs and dated Haiku equivalence, never guesses aliases or defaults", () => {
  for (const adapter of ["claude-cli", "codex-cli"] as const) {
    for (const model of EXTERNAL_AGENT_MODEL_CATALOG[adapter].models) {
      assert.equal(externalAgentModelCapability(adapter, model.value), model);
      assert.equal(externalAgentModelCapability(adapter, ` ${model.value}`), undefined);
      assert.equal(externalAgentModelCapability(adapter, model.value.toUpperCase()), undefined);
    }
    for (const unknown of ["", "default", "auto", "opus", "sonnet", "haiku", "fable", "best", "unknown-model", "gpt-6", "claude-opus-5-5-latest"]) {
      assert.equal(externalAgentModelCapability(adapter, unknown), undefined);
    }
  }
  const haiku = externalAgentModelCapability("claude-cli", "claude-haiku-4-5-20251001");
  assert.equal(haiku, externalAgentModelCapability("claude-cli", "claude-haiku-4-5"));
  assert.deepEqual(haiku!.effortLevels, []);
  assert.equal(haiku!.defaultEffort, undefined);
  assert.equal(externalAgentModelCapability("claude-cli", "claude-haiku-4-5-20251002"), undefined);
  assert.equal(externalAgentModelCapability("codex-cli", "claude-haiku-4-5-20251001"), undefined);
  assert.equal(externalAgentModelCapability("claude-cli", "gpt-6.1-sol"), undefined);
});

test("every entry carries catalog source/date provenance and Codex is release pinned", () => {
  const claude = EXTERNAL_AGENT_MODEL_CATALOG["claude-cli"];
  const codex = EXTERNAL_AGENT_MODEL_CATALOG["codex-cli"];
  assert.equal(claude.source, "https://code.claude.com/docs/en/model-config");
  assert.equal(claude.effortSource, "https://code.claude.com/docs/en/effort");
  assert.equal(codex.source, "https://developers.openai.com/codex/models");
  assert.equal(codex.version, "0.160.0");
  assert.equal(codex.release, "https://github.com/openai/codex/releases/tag/rust-v0.160.0");
  assert.equal(codex.sourceBlob, "https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/models-manager/models.json");
  assert.equal(codex.effortSource, codex.sourceBlob);
  for (const catalog of [claude, codex]) {
    assert.equal(catalog.verifiedOn, "2026-10-05");
    for (const model of catalog.models) {
      assert.equal(model.provenance.source, catalog.source);
      assert.equal(model.provenance.effortSource, catalog.effortSource);
      assert.equal(model.provenance.verifiedOn, catalog.verifiedOn);
      if ("version" in catalog) assert.deepEqual(model.provenance, {
        source: catalog.source, effortSource: catalog.effortSource, verifiedOn: catalog.verifiedOn,
        version: catalog.version, release: catalog.release, sourceBlob: catalog.sourceBlob,
      });
    }
  }
});
