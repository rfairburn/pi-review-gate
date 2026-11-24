/**
 * Issue #682: strict fresh persisted review-gate snapshot for native
 * (Claude/Codex) managed-tool requests.
 *
 * Every HOME, agent directory, and config file here is synthetic and lives in
 * a fresh temporary directory owned by the test; no real config is consulted.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG, loadConfig, normalizeConfig } from "../src/config";
import { PI_AGENT_DIR_ENV } from "../src/config-path";
import { MAX_NATIVE_CONFIG_BYTES } from "../src/session-host/launch";
import { configResolutionForEnv } from "../src/session-host/profiles";
import {
  readPersistedReviewGateSnapshot,
  type PersistedReviewGateSnapshot,
  type PersistedReviewGateSource,
} from "../src/session-host/persisted-review-gate-snapshot";
import { updateReviewGateConfig } from "../src/settings/persistence";

const SECRET = "sk-native-snapshot-secret-0123456789";

interface Fixture {
  root: string;
  home: string;
  agentDir: string;
  primary: string;
  fallback: string;
  source: PersistedReviewGateSource;
}

function fixture(t: TestContext, extraEnv: NodeJS.ProcessEnv = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rg-native-snapshot-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, ...extraEnv };
  return {
    root,
    home,
    agentDir,
    primary: join(agentDir, "review-gate.json"),
    fallback: join(home, ".config", "pi-review-gate", "config.json"),
    source: { env, agentDir },
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function available(snapshot: PersistedReviewGateSnapshot): Extract<PersistedReviewGateSnapshot, { status: "available" }> {
  assert.equal(snapshot.status, "available", JSON.stringify(snapshot));
  return snapshot as Extract<PersistedReviewGateSnapshot, { status: "available" }>;
}

function assertUnavailable(snapshot: PersistedReviewGateSnapshot, reason: string, path?: string): void {
  assert.equal(snapshot.status, "unavailable");
  assert.equal((snapshot as { reason: string }).reason, reason);
  assert.equal((snapshot as { path?: string }).path, path);
  assert.equal("config" in snapshot, false);
  assert.equal(JSON.stringify(snapshot).includes(SECRET), false);
}

/** What the sidebar editor and a managed Pi child resolve from the same host snapshot. */
function piResolvedPath(f: Fixture): string | undefined {
  const childEnv = { ...f.source.env, [PI_AGENT_DIR_ENV]: f.agentDir };
  return loadConfig(childEnv, configResolutionForEnv(f.source.env)).path;
}

const routedConfig = {
  enabled: true,
  review: { primaryEnabled: false, subtaskEnabled: true, reviewLandedChanges: true },
  tools: { topLevelDeny: ["Bash"], executorDeny: ["WebFetch"] },
  execution: {
    workerResources: { alpha: { selection: { source: "pi", model: "fake/alpha" }, maxConcurrent: 1 } },
    routes: { execute: [{ resourceId: "alpha" }], research: [] },
  },
};

test("resolves the same canonical file as Pi and the sidebar: primary, fallback, explicit override", (t) => {
  const f = fixture(t);
  writeJson(f.fallback, { tools: { topLevelDeny: ["FromFallback"] } });
  assert.equal(available(readPersistedReviewGateSnapshot(f.source)).path, f.fallback);
  assert.equal(piResolvedPath(f), f.fallback);

  writeJson(f.primary, { tools: { topLevelDeny: ["FromPrimary"] } });
  const primary = available(readPersistedReviewGateSnapshot(f.source));
  assert.equal(primary.path, f.primary);
  assert.equal(piResolvedPath(f), f.primary);
  assert.deepEqual(primary.config.tools?.topLevelDeny, ["FromPrimary"]);

  const explicitPath = join(f.root, "explicit", "rg.json");
  writeJson(explicitPath, { tools: { topLevelDeny: ["FromExplicit"] } });
  const g: Fixture = { ...f, source: { env: { ...f.source.env, PI_REVIEW_GATE_CONFIG: explicitPath }, agentDir: f.agentDir } };
  const explicit = available(readPersistedReviewGateSnapshot(g.source));
  assert.equal(explicit.path, explicitPath);
  assert.equal(piResolvedPath(g), explicitPath);
  assert.deepEqual(explicit.config.tools?.topLevelDeny, ["FromExplicit"]);
});

test("each read reflects the file saved at that moment; earlier snapshots stay unchanged", async (t) => {
  const f = fixture(t);
  writeJson(f.primary, { tools: { topLevelDeny: ["Bash"] } });
  const first = available(readPersistedReviewGateSnapshot(f.source));
  assert.deepEqual(first.config.tools, { topLevelDeny: ["Bash"], executorDeny: [] });
  assert.equal(first.config.review, undefined);
  const firstJson = JSON.stringify(first);

  // In-place rewrite (same inode): denies, review, and routes all change.
  const inode = statSync(f.primary).ino;
  writeFileSync(f.primary, JSON.stringify(routedConfig));
  assert.equal(statSync(f.primary).ino, inode);
  const second = available(readPersistedReviewGateSnapshot(f.source));
  assert.deepEqual(second.config.tools, { topLevelDeny: ["Bash"], executorDeny: ["WebFetch"] });
  assert.equal(second.config.review?.primaryEnabled, false);
  assert.equal(second.config.review?.reviewLandedChanges, true);
  assert.deepEqual(second.config.execution?.routes?.execute, [{ resourceId: "alpha", thinkingLevel: undefined }]);

  // The real settings Save path (atomic replace, new inode).
  await updateReviewGateConfig(f.primary, (config) => {
    config.tools = { topLevelDeny: ["Read"], executorDeny: [] };
    (config.review as Record<string, unknown>).primaryEnabled = true;
  });
  assert.notEqual(statSync(f.primary).ino, inode);
  const third = available(readPersistedReviewGateSnapshot(f.source));
  assert.deepEqual(third.config.tools, { topLevelDeny: ["Read"], executorDeny: [] });
  assert.equal(third.config.review?.primaryEnabled, true);

  // Snapshots are independent, detached, and immutable.
  assert.equal(JSON.stringify(first), firstJson);
  assert.deepEqual(second.config.tools?.executorDeny, ["WebFetch"]);
  assert.notEqual(first.config, second.config);
  assert.ok(Object.isFrozen(third.config) && Object.isFrozen(third.config.tools?.topLevelDeny));
  assert.throws(() => { (third.config.tools!.topLevelDeny as string[]).push("x"); }, TypeError);
  assert.notEqual(third.config.web, DEFAULT_CONFIG.web);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG), false);
  assert.equal(Object.isFrozen(DEFAULT_CONFIG.web), false);
});

test("a previously good file that becomes invalid fails closed with no last-good fallback", (t) => {
  const f = fixture(t);
  writeJson(f.primary, routedConfig);
  const piLoaded = loadConfig({ ...f.source.env, [PI_AGENT_DIR_ENV]: f.agentDir }, configResolutionForEnv(f.source.env));
  const piBefore = JSON.stringify(piLoaded.config);
  available(readPersistedReviewGateSnapshot(f.source));

  writeFileSync(f.primary, `{"tools": {"topLevelDeny": ["${SECRET}"`);
  assertUnavailable(readPersistedReviewGateSnapshot(f.source), "invalid-json", f.primary);
  // Pi's already-loaded in-memory settings are not touched by native reads.
  assert.equal(JSON.stringify(piLoaded.config), piBefore);
});

test("strict validation: documents Pi startup would recover still fail closed", (t) => {
  const f = fixture(t);
  writeJson(f.primary, { tools: { topLevelDeny: [` ${SECRET} `] } });
  assertUnavailable(readPersistedReviewGateSnapshot(f.source), "invalid-config", f.primary);
  assert.ok((piResolvedPath(f) === f.primary));

  writeJson(f.primary, { toolProtection: { level: "on", secret: SECRET } });
  const recovered = loadConfig({ ...f.source.env, [PI_AGENT_DIR_ENV]: f.agentDir }, configResolutionForEnv(f.source.env));
  assert.ok(recovered.toolProtectionError, "Pi startup recovery keeps its own behavior");
  assertUnavailable(readPersistedReviewGateSnapshot(f.source), "invalid-config", f.primary);

  writeJson(f.primary, [SECRET]);
  assertUnavailable(readPersistedReviewGateSnapshot(f.source), "invalid-config", f.primary);
});

test("kill switch and missing/unreadable configs fail closed without falling back", (t) => {
  const f = fixture(t);
  writeJson(f.primary, routedConfig);
  writeJson(f.fallback, { tools: { topLevelDeny: ["FromFallback"] } });

  const disabled = readPersistedReviewGateSnapshot({ ...f.source, env: { ...f.source.env, PI_REVIEW_GATE_DISABLED: "1" } });
  assert.equal(disabled.status, "disabled");
  assert.equal("config" in disabled, false);

  // A missing explicit override never falls back to an existing default.
  const missingExplicit = join(f.root, "absent.json");
  assertUnavailable(
    readPersistedReviewGateSnapshot({ ...f.source, env: { ...f.source.env, PI_REVIEW_GATE_CONFIG: missingExplicit } }),
    "missing",
    missingExplicit,
  );
  assertUnavailable(
    readPersistedReviewGateSnapshot({ ...f.source, env: { ...f.source.env, PI_REVIEW_GATE_CONFIG: "relative/rg.json" } }),
    "relative-override",
  );

  // A dangling primary keeps precedence; the fallback is not consulted.
  rmSync(f.primary);
  symlinkSync(join(f.root, "nowhere.json"), f.primary);
  assertUnavailable(readPersistedReviewGateSnapshot(f.source), "missing", f.primary);

  rmSync(f.primary);
  mkdirSync(f.primary);
  assertUnavailable(readPersistedReviewGateSnapshot(f.source), "not-regular-file", f.primary);

  rmSync(f.primary, { recursive: true });
  writeFileSync(f.primary, `${" ".repeat(MAX_NATIVE_CONFIG_BYTES)}{}`);
  assertUnavailable(readPersistedReviewGateSnapshot(f.source), "too-large", f.primary);

  rmSync(f.primary);
  rmSync(f.fallback);
  assertUnavailable(readPersistedReviewGateSnapshot(f.source), "no-config");

  assertUnavailable(readPersistedReviewGateSnapshot({ env: {}, agentDir: f.agentDir }), "home-unresolved");
  assertUnavailable(readPersistedReviewGateSnapshot({ ...f.source, agentDir: "agent" }), "invalid-source");
});

test("the agent-directory file needs no home; a relative home never selects a cwd file", (t) => {
  const f = fixture(t);
  writeJson(f.primary, routedConfig);
  for (const env of [{}, { HOME: "", USERPROFILE: "" }, { HOME: "relative-home", USERPROFILE: "relative-home" }]) {
    const snapshot = available(readPersistedReviewGateSnapshot({ env, agentDir: f.agentDir }));
    assert.equal(snapshot.path, f.primary);
    assert.deepEqual(snapshot.config.tools?.executorDeny, ["WebFetch"]);
  }
  // A managed Pi child launched with this agent directory loads the same file.
  assert.equal(loadConfig({ [PI_AGENT_DIR_ENV]: f.agentDir }, { homeDir: join(f.root, "elsewhere") }).path, f.primary);

  // With no primary, a relative home is refused even when it would resolve
  // (against the working directory) to an existing compatibility file.
  rmSync(f.primary);
  const cwdDecoy = join(f.root, "relative-home", ".config", "pi-review-gate", "config.json");
  writeJson(cwdDecoy, { tools: { topLevelDeny: ["FromCwd"] } });
  const previousCwd = process.cwd();
  process.chdir(f.root);
  t.after(() => process.chdir(previousCwd));
  // The hazard is real: lenient discovery with the same relative home finds the decoy.
  assert.equal(
    loadConfig({ [PI_AGENT_DIR_ENV]: f.agentDir }, { homeDir: "relative-home" }).path,
    join("relative-home", ".config", "pi-review-gate", "config.json"),
  );
  assertUnavailable(
    readPersistedReviewGateSnapshot({ env: { HOME: "relative-home", USERPROFILE: "relative-home" }, agentDir: f.agentDir }),
    "home-unresolved",
  );
  assertUnavailable(readPersistedReviewGateSnapshot({ env: {}, agentDir: f.agentDir }), "home-unresolved");
});

test("uses the owner's effective home for the compatibility file without a home variable", (t) => {
  const f = fixture(t);
  writeJson(f.fallback, { tools: { topLevelDeny: ["FromFallback"] } });
  const loaded = loadConfig({ [PI_AGENT_DIR_ENV]: f.agentDir }, { homeDir: f.home });
  const env: NodeJS.ProcessEnv = {};
  const snapshot = available(readPersistedReviewGateSnapshot({ env, agentDir: f.agentDir, resolvedHomeDir: f.home }));
  assert.equal(snapshot.path, f.fallback);
  assert.equal(snapshot.path, loaded.path);
  assert.deepEqual(snapshot.config.tools?.topLevelDeny, ["FromFallback"]);
  assert.deepEqual(env, {});

  // The explicit resolution wins over the environment's home variable.
  const other = join(f.root, "other-home");
  mkdirSync(other);
  assert.equal(
    available(readPersistedReviewGateSnapshot({ env: { HOME: other, USERPROFILE: other }, agentDir: f.agentDir, resolvedHomeDir: f.home })).path,
    f.fallback,
  );

  // A relative resolution is refused rather than resolved against the cwd.
  const previousCwd = process.cwd();
  process.chdir(f.root);
  t.after(() => process.chdir(previousCwd));
  assertUnavailable(
    readPersistedReviewGateSnapshot({ env: { HOME: f.home, USERPROFILE: f.home }, agentDir: f.agentDir, resolvedHomeDir: "home" }),
    "home-unresolved",
  );
});

test("malformed UTF-8 and a BOM fail closed instead of being repaired", (t) => {
  const f = fixture(t);
  const prefix = Buffer.from('{"tools":{"topLevelDeny":["Ba');
  const suffix = Buffer.from('sh"]}}');
  const corrupt = Buffer.concat([prefix, Buffer.from([0xff]), suffix]);
  // Lenient decoding would yield a schema-valid deny entry that no longer matches "Bash".
  const lenient = normalizeConfig(JSON.parse(corrupt.toString("utf8")));
  assert.deepEqual(lenient.tools?.topLevelDeny, ["Ba\ufffdsh"]);
  writeFileSync(f.primary, corrupt);
  assertUnavailable(readPersistedReviewGateSnapshot(f.source), "invalid-encoding", f.primary);

  writeFileSync(f.primary, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(routedConfig))]));
  assertUnavailable(readPersistedReviewGateSnapshot(f.source), "invalid-json", f.primary);

  writeFileSync(f.primary, JSON.stringify({ tools: { topLevelDeny: ["Bäsh"] } }));
  assert.deepEqual(available(readPersistedReviewGateSnapshot(f.source)).config.tools?.topLevelDeny, ["Bäsh"]);
});

test("reads only the owner-supplied environment and never writes", (t) => {
  const f = fixture(t);
  writeJson(f.primary, routedConfig);
  const decoy = join(f.root, "decoy.json");
  writeJson(decoy, { tools: { topLevelDeny: ["Decoy"] } });
  const saved = {
    disabled: process.env.PI_REVIEW_GATE_DISABLED,
    config: process.env.PI_REVIEW_GATE_CONFIG,
    agentDir: process.env[PI_AGENT_DIR_ENV],
  };
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  t.after(() => {
    restore("PI_REVIEW_GATE_DISABLED", saved.disabled);
    restore("PI_REVIEW_GATE_CONFIG", saved.config);
    restore(PI_AGENT_DIR_ENV, saved.agentDir);
  });
  process.env.PI_REVIEW_GATE_DISABLED = "1";
  process.env.PI_REVIEW_GATE_CONFIG = decoy;
  process.env[PI_AGENT_DIR_ENV] = join(f.root, "other-agent");

  const envBefore = JSON.stringify(f.source.env);
  const listing = (dir: string) => readdirSync(dir).sort();
  const before = { agent: listing(f.agentDir), root: listing(f.root), mtime: statSync(f.primary).mtimeMs };
  const snapshot = available(readPersistedReviewGateSnapshot(f.source));
  assert.equal(snapshot.path, f.primary);
  assert.deepEqual(snapshot.config.tools?.topLevelDeny, ["Bash"]);
  assert.equal(JSON.stringify(f.source.env), envBefore);
  assert.deepEqual({ agent: listing(f.agentDir), root: listing(f.root), mtime: statSync(f.primary).mtimeMs }, before);
});
