import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  THINKING_LEVELS,
  loadConfig,
  normalizeConfig,
  recoverConfig,
} from "../src/config";
import {
  DEFAULT_TOOL_PROTECTION_CONFIG,
  PROTECTION_LEVELS,
  TOOL_PROTECTION_CONTEXT_MAX_CHARS,
  TOOL_PROTECTION_CONTEXT_MIN_CHARS,
  TOOL_PROTECTION_THINKING_LEVELS,
  TOOL_PROTECTION_TIMEOUT_MAX_MS,
  TOOL_PROTECTION_TIMEOUT_MIN_MS,
  effectiveToolProtectionSettings,
  isToolProtectionDiscoveryLoaderExempt,
  normalizeToolProtectionConfig,
  toolProtectionAppliesTo,
} from "../src/tool-protection/config";
import { DEFERRED_TOOL_SEARCH_NAME } from "../src/tool-inventory";

const enabled = { level: "dangerous", auditor: { source: "external", id: "auditor-1" } } as const;

test("an absent block stays Off, stores no second enable flag, and audits nothing", () => {
  // Off is a level, not a toggle: neither the root defaults nor the block carry
  // a separate `enabled` field that could disagree with the level.
  assert.equal(Object.hasOwn(DEFAULT_CONFIG, "toolProtection"), false);
  assert.equal(Object.hasOwn(DEFAULT_TOOL_PROTECTION_CONFIG, "enabled"), false);
  assert.equal(normalizeConfig({}).toolProtection, undefined);

  const settings = effectiveToolProtectionSettings(normalizeConfig({}));
  assert.deepEqual(settings, {
    level: "off",
    enabled: false,
    auditor: null,
    scope: "all",
    toolNames: [],
    timeoutMs: 10_000,
    maxContextChars: 128_000,
    // Retention is default-off and part of the same block: no second enable flag.
    retainAuditorSessions: false,
  });
  assert.deepEqual([...PROTECTION_LEVELS], ["off", "dangerous", "aligned", "workspace"]);
  assert.equal(toolProtectionAppliesTo(settings, "bash"), false);
});

test("optional fields default and an unresolved auditor selection is preserved", () => {
  const config = normalizeConfig({
    toolProtection: { level: "dangerous", auditor: { source: "external", id: "renamed-away-today" } },
  });
  assert.deepEqual(config.toolProtection, {
    level: "dangerous",
    auditor: { source: "external", id: "renamed-away-today" },
    scope: "all",
    toolNames: [],
    timeoutMs: DEFAULT_TOOL_PROTECTION_CONFIG.timeoutMs,
    maxContextChars: DEFAULT_TOOL_PROTECTION_CONFIG.maxContextChars,
    retainAuditorSessions: false,
  });

  const pi = normalizeToolProtectionConfig({
    level: "workspace",
    scope: "selected",
    toolNames: ["bash", "bash", "apply_patch"],
    auditor: { source: "pi", model: "  test/auditor  ", thinkingLevel: "low" },
    timeoutMs: TOOL_PROTECTION_TIMEOUT_MIN_MS,
    maxContextChars: TOOL_PROTECTION_CONTEXT_MAX_CHARS,
  });
  assert.deepEqual(pi.auditor, { source: "pi", model: "test/auditor", thinkingLevel: "low" });
  assert.deepEqual(pi.toolNames, ["bash", "apply_patch"]);
  assert.equal(pi.timeoutMs, TOOL_PROTECTION_TIMEOUT_MIN_MS);
  assert.equal(pi.maxContextChars, TOOL_PROTECTION_CONTEXT_MAX_CHARS);
  assert.deepEqual(normalizeToolProtectionConfig(pi), pi);
  assert.deepEqual(normalizeToolProtectionConfig({ level: "off", auditor: null }), DEFAULT_TOOL_PROTECTION_CONFIG);
});

test("strict validation rejects partial, coercible, and unusable protection blocks", () => {
  const rejected: unknown[] = [
    null, "off", 5, [], true,
    {},
    { level: "OFF", auditor: null },
    { level: "safe", auditor: null },
    { level: true, auditor: null },
    { auditor: { source: "pi", model: "m" } },
    { level: "dangerous" },
    { level: "dangerous", auditor: null },
    { level: "aligned", auditor: { source: "external" } },
    { level: "aligned", auditor: { source: "other", id: "x" } },
    { level: "aligned", auditor: { source: "external", id: "has space" } },
    { level: "aligned", auditor: { source: "pi", model: "  " } },
    { level: "aligned", auditor: { source: "pi", model: "m", thinkingLevel: "turbo" } },
    { level: "aligned", auditor: { source: "external", id: "a" }, scope: "selected" },
    { level: "aligned", auditor: { source: "external", id: "a" }, scope: "some" },
    { level: "aligned", auditor: { source: "external", id: "a" }, toolNames: "bash" },
    { level: "aligned", auditor: { source: "external", id: "a" }, toolNames: ["bash "] },
    { level: "aligned", auditor: { source: "external", id: "a" }, toolNames: [""] },
    { level: "aligned", auditor: { source: "external", id: "a" }, toolNames: ["bash", 5] },
    { level: "dangerous", auditor: { source: "external", id: "a" }, timeoutMs: TOOL_PROTECTION_TIMEOUT_MIN_MS - 1 },
    { level: "dangerous", auditor: { source: "external", id: "a" }, timeoutMs: TOOL_PROTECTION_TIMEOUT_MAX_MS + 1 },
    { level: "dangerous", auditor: { source: "external", id: "a" }, timeoutMs: "10000" },
    { level: "dangerous", auditor: { source: "external", id: "a" }, timeoutMs: 10_000.5 },
    { level: "dangerous", auditor: { source: "external", id: "a" }, maxContextChars: TOOL_PROTECTION_CONTEXT_MIN_CHARS - 1 },
    { level: "dangerous", auditor: { source: "external", id: "a" }, maxContextChars: TOOL_PROTECTION_CONTEXT_MAX_CHARS + 1 },
  ];
  rejected.forEach((value) => {
    assert.throws(() => normalizeToolProtectionConfig(value), Error, JSON.stringify(value));
    assert.throws(() => normalizeConfig({ toolProtection: value }), Error, JSON.stringify(value));
  });
  // An explicit `undefined` value is indistinguishable from an absent key, which
  // is the same "absent stays absent" rule every other block follows.
  assert.throws(() => normalizeToolProtectionConfig(undefined), Error);
  assert.equal(normalizeConfig({ toolProtection: undefined }).toolProtection, undefined);
  // Bounds are inclusive on both ends.
  for (const timeoutMs of [TOOL_PROTECTION_TIMEOUT_MIN_MS, TOOL_PROTECTION_TIMEOUT_MAX_MS]) {
    assert.equal(normalizeToolProtectionConfig({ ...enabled, timeoutMs }).timeoutMs, timeoutMs);
  }
  for (const maxContextChars of [TOOL_PROTECTION_CONTEXT_MIN_CHARS, TOOL_PROTECTION_CONTEXT_MAX_CHARS]) {
    assert.equal(normalizeToolProtectionConfig({ ...enabled, maxContextChars }).maxContextChars, maxContextChars);
  }
});

test("a selected scope is an explicit subset with no read-only exemption", () => {
  const selected = effectiveToolProtectionSettings(normalizeConfig({
    toolProtection: { ...enabled, level: "aligned", scope: "selected", toolNames: ["apply_patch"] },
  }));
  assert.equal(toolProtectionAppliesTo(selected, "apply_patch"), true);
  // A skipped call is NOT AUDITED; it is never an implied PASS or an automatic
  // safe/read-only exemption, and no tool class is exempt for speed.
  assert.equal(toolProtectionAppliesTo(selected, "read"), false);
  assert.equal(toolProtectionAppliesTo(selected, "bash"), false);

  const all = effectiveToolProtectionSettings(normalizeConfig({ toolProtection: { ...enabled, scope: "all" } }));
  assert.equal(all.scope, "all");
  assert.equal(toolProtectionAppliesTo(all, "read"), true);
  assert.equal(toolProtectionAppliesTo(all, "anything-else"), true);
});

test("the native discovery loader is exempt by ownership, never by scope membership", () => {
  // The exempt NAME is the canonical loader name the deferred-tools loader
  // registers under — not a prefix, a glob, or a class of tools.
  assert.equal(isToolProtectionDiscoveryLoaderExempt(DEFERRED_TOOL_SEARCH_NAME), true);
  assert.equal(isToolProtectionDiscoveryLoaderExempt("tool"), false);
  assert.equal(isToolProtectionDiscoveryLoaderExempt("tool_search_extended"), false);
  assert.equal(isToolProtectionDiscoveryLoaderExempt("ToolSearch"), false);
  assert.equal(isToolProtectionDiscoveryLoaderExempt("read"), false);

  // Scope membership is a pure name lookup that grants NOTHING. Even the reserved
  // loader name is a member here, because a name-level skip would let an unrelated
  // definition that borrowed the name escape the auditor. The never-audited
  // treatment belongs to the coordinator's ownership-verified branch alone.
  const all = effectiveToolProtectionSettings(normalizeConfig({ toolProtection: { ...enabled, scope: "all" } }));
  assert.equal(toolProtectionAppliesTo(all, DEFERRED_TOOL_SEARCH_NAME), true, "scope matching grants no infrastructure exemption");
  // Read-only, network, and unknown names are all audited too: this is not a
  // read-only, public-URL, prefix, or class exemption.
  assert.equal(toolProtectionAppliesTo(all, "read"), true);
  assert.equal(toolProtectionAppliesTo(all, "web_fetch"), true);

  // A retained loader name in `selected` is ordinary membership here; the runtime
  // still treats the genuine loader as infrastructure and reports the retained name
  // as inert in the picker instead of rewriting the stored list.
  const selected = effectiveToolProtectionSettings(normalizeConfig({
    toolProtection: { ...enabled, scope: "selected", toolNames: [DEFERRED_TOOL_SEARCH_NAME, "write"] },
  }));
  assert.equal(toolProtectionAppliesTo(selected, DEFERRED_TOOL_SEARCH_NAME), true, "membership is the stored name, not an exemption");
  assert.equal(toolProtectionAppliesTo(selected, "write"), true);
  assert.equal(toolProtectionAppliesTo(selected, "read"), false);

  // Off still audits nothing at all — the exemption is not a way to turn the
  // gate on for one tool.
  const off = effectiveToolProtectionSettings(normalizeConfig({}));
  assert.equal(toolProtectionAppliesTo(off, DEFERRED_TOOL_SEARCH_NAME), false);
});

test("a malformed protection block never recovers into an implicit Off", () => {
  const input = {
    enabled: true,
    maxPatchBytes: 1234,
    web: { enabled: false },
    review: { primaryReviewers: [{ source: "pi", model: "test/reviewer" }] },
    tools: { topLevelDeny: ["bash"] },
    toolProtection: { level: "dangerours", auditor: { source: "external", id: "auditor-1" } },
  };
  const before = JSON.stringify(input);
  const recovered = recoverConfig(input);
  const protectionError = recovered.toolProtectionError ?? "";
  assert.match(protectionError, /toolProtection is invalid/);
  assert.match(protectionError, /toolProtection.level must be one of/);
  // The unusable block is not materialized, so the derived error — not a
  // silently Off configuration — is what a runtime consumer sees.
  assert.equal(recovered.config.toolProtection, undefined);
  assert.equal(effectiveToolProtectionSettings(recovered.config).enabled, false);
  // Every unrelated setting survives recovery.
  assert.equal(recovered.config.enabled, true);
  assert.equal(recovered.config.maxPatchBytes, 1234);
  assert.equal(recovered.config.web?.enabled, false);
  assert.deepEqual(recovered.config.review?.primaryReviewers, [{ source: "pi", model: "test/reviewer" }]);
  assert.deepEqual(recovered.config.tools, { topLevelDeny: ["bash"], executorDeny: [] });
  assert.ok(recovered.warnings?.includes(protectionError));
  assert.equal(JSON.stringify(input), before, "recovery never rewrites the stored document");
});

test("recovery keeps a valid block and never discards an unresolvable auditor reference", () => {
  const valid = { toolProtection: { ...enabled, level: "workspace" } };
  assert.deepEqual(recoverConfig(valid), { config: normalizeConfig(valid) });

  const mixed = recoverConfig({
    maxPatchBytes: -1,
    toolProtection: { ...enabled, auditor: { source: "external", id: "not-in-any-catalog" } },
  });
  assert.equal(mixed.toolProtectionError, undefined);
  assert.deepEqual(mixed.config.toolProtection, {
    level: "dangerous",
    auditor: { source: "external", id: "not-in-any-catalog" },
    scope: "all",
    toolNames: [],
    timeoutMs: DEFAULT_TOOL_PROTECTION_CONFIG.timeoutMs,
    maxContextChars: DEFAULT_TOOL_PROTECTION_CONFIG.maxContextChars,
    retainAuditorSessions: false,
  });
  assert.equal(mixed.config.maxPatchBytes, DEFAULT_CONFIG.maxPatchBytes);
  assert.deepEqual(mixed.warnings, ["maxPatchBytes is invalid or unsupported; using its default."]);
  // The auditor is not in `externalAgents`, and that is not a load error: the
  // selection stays so the runtime can explain that it is unavailable.
  assert.deepEqual(mixed.config.toolProtection?.auditor, { source: "external", id: "not-in-any-catalog" });
});

test("loadConfig reports the derived protection error and leaves the file untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-protection-"));
  try {
    const brokenPath = join(dir, "broken.json");
    const brokenContent = JSON.stringify({
      enabled: true,
      web: { enabled: false },
      toolProtection: { level: "aligned", auditor: { source: "external", id: "a" }, timeoutMs: 5 },
    });
    await writeFile(brokenPath, brokenContent, "utf8");
    const broken = loadConfig({ PI_REVIEW_GATE_CONFIG: brokenPath });
    assert.match(broken.toolProtectionError ?? "", /toolProtection.timeoutMs must be between/);
    assert.equal(broken.config.toolProtection, undefined);
    assert.equal(broken.config.web?.enabled, false, "other settings still load");
    assert.equal(await readFile(brokenPath, "utf8"), brokenContent);

    const goodPath = join(dir, "good.json");
    const goodContent = JSON.stringify({ toolProtection: { ...enabled, scope: "selected", toolNames: ["bash"] } });
    await writeFile(goodPath, goodContent, "utf8");
    const good = loadConfig({ PI_REVIEW_GATE_CONFIG: goodPath });
    assert.equal(good.toolProtectionError, undefined);
    assert.equal(good.warnings, undefined);
    assert.deepEqual(good.config.toolProtection?.toolNames, ["bash"]);
    assert.equal(effectiveToolProtectionSettings(good.config).enabled, true);
    assert.equal(await readFile(goodPath, "utf8"), goodContent);

    const legacyPath = join(dir, "legacy.json");
    await writeFile(legacyPath, JSON.stringify({ enabled: true }), "utf8");
    const legacy = loadConfig({ PI_REVIEW_GATE_CONFIG: legacyPath });
    assert.equal(legacy.toolProtectionError, undefined);
    assert.equal(legacy.config.toolProtection, undefined);
    assert.equal(effectiveToolProtectionSettings(legacy.config).enabled, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the auditor thinking-level mirror stays in step with the root configuration", () => {
  assert.deepEqual([...TOOL_PROTECTION_THINKING_LEVELS], [...THINKING_LEVELS]);
});

test("auditor-session retention is opt-in, strict, and never changes what gets audited", () => {
  // Absent means Off, so a stored block, a parent launch pin, or a build that
  // predates the field keeps the pre-retention behavior exactly.
  assert.equal(DEFAULT_TOOL_PROTECTION_CONFIG.retainAuditorSessions, false);
  assert.equal(normalizeToolProtectionConfig({ ...enabled }).retainAuditorSessions, false);
  assert.equal(effectiveToolProtectionSettings(normalizeConfig({ toolProtection: { ...enabled } })).retainAuditorSessions, false);

  const on = normalizeToolProtectionConfig({ ...enabled, retainAuditorSessions: true });
  assert.equal(on.retainAuditorSessions, true);
  assert.deepEqual(normalizeToolProtectionConfig(on), on, "a normalized block normalizes to itself");
  assert.equal(normalizeConfig({ toolProtection: { ...enabled, retainAuditorSessions: true } }).toolProtection?.retainAuditorSessions, true);
  assert.equal(normalizeToolProtectionConfig({ ...enabled, retainAuditorSessions: false }).retainAuditorSessions, false);

  // Only the JSON booleans are accepted: a half-written setting beside a
  // protection control must not silently acquire a new side effect by coercion.
  for (const value of ["true", "false", 1, 0, null, [], {}, "yes"]) {
    assert.throws(() => normalizeToolProtectionConfig({ ...enabled, retainAuditorSessions: value }), Error, JSON.stringify(value));
    assert.throws(() => normalizeConfig({ toolProtection: { ...enabled, retainAuditorSessions: value } }), Error, JSON.stringify(value));
  }
  // An explicit `undefined` is indistinguishable from an absent key: Off.
  assert.equal(normalizeToolProtectionConfig({ ...enabled, retainAuditorSessions: undefined }).retainAuditorSessions, false);

  // An unintelligible stored value is the same fail-closed load error every
  // other field in this block gets — never a silent default, never an implicit
  // Off, and the rest of the configuration still loads.
  const recovered = recoverConfig({
    web: { enabled: false },
    toolProtection: { ...enabled, retainAuditorSessions: "true" },
  });
  assert.match(recovered.toolProtectionError ?? '', /toolProtection\.retainAuditorSessions must be true or false/);
  assert.equal(recovered.config.toolProtection, undefined);
  assert.equal(recovered.config.web?.enabled, false);

  // Retention changes no decision input: the same block with it On audits
  // exactly the same calls under the same scope.
  const off = effectiveToolProtectionSettings(normalizeConfig({ toolProtection: { ...enabled, scope: "selected", toolNames: ["bash"] } }));
  const onSettings = effectiveToolProtectionSettings(normalizeConfig({ toolProtection: { ...enabled, scope: "selected", toolNames: ["bash"], retainAuditorSessions: true } }));
  for (const name of ["bash", "read", "anything-else"]) {
    assert.equal(toolProtectionAppliesTo(off, name), toolProtectionAppliesTo(onSettings, name), name);
  }
  assert.deepEqual({ ...off, retainAuditorSessions: true }, onSettings);
});

test("a stored file without the retention field loads as Off and an explicit On survives reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-retention-"));
  try {
    const legacyPath = join(dir, "legacy.json");
    await writeFile(legacyPath, JSON.stringify({
      toolProtection: { level: "dangerous", auditor: { source: "external", id: "a" }, timeoutMs: 20_000 },
    }), "utf8");
    const legacy = loadConfig({ PI_REVIEW_GATE_CONFIG: legacyPath });
    assert.equal(legacy.toolProtectionError, undefined);
    assert.equal(effectiveToolProtectionSettings(legacy.config).retainAuditorSessions, false);

    const onPath = join(dir, "on.json");
    await writeFile(onPath, JSON.stringify({
      toolProtection: { level: "dangerous", auditor: { source: "external", id: "a" }, retainAuditorSessions: true },
    }), "utf8");
    const on = loadConfig({ PI_REVIEW_GATE_CONFIG: onPath });
    assert.equal(on.toolProtectionError, undefined);
    assert.equal(effectiveToolProtectionSettings(on.config).retainAuditorSessions, true);
    assert.equal(await readFile(onPath, "utf8"), JSON.stringify({
      toolProtection: { level: "dangerous", auditor: { source: "external", id: "a" }, retainAuditorSessions: true },
    }), "loading never rewrites the stored document");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
