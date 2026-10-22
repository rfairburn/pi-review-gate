/**
 * Direct sidebar component provisioning parity (issues 344/378, replaced
 * contract).
 *
 * The direct sidebar entry points no longer own a skill-provisioning copy: the
 * sidebars and the Pi/web wrappers all go through ONE shared authority
 * (scripts/prepare-application.cjs), which gates the shipped skills and the DDGS
 * environment behind completed markers. This file therefore exercises:
 * - the shared component gate natively (real filesystem publication, refresh
 *   reuse, ownership-safe migration, and fail-closed behavior);
 * - the sidebar launcher flow through that shared authority, proving the host
 *   loads only after provisioning succeeds and that a skill failure stops the
 *   launch with an actionable error.
 *
 * The former per-launcher `refreshShippedSkills` copy, its synthetic win32 path
 * seam, and its duplicate skill-manifest tests were retired with the pre-#344
 * build/provisioning pipeline. Atomic publication, symlink refusal, directory
 * destinations, and provenance-based migration remain covered natively here and
 * in the Pi/web launcher suites.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const requireCjs = createRequire(join(process.cwd(), "tests", "session-host-skill-provisioning.test.ts"));
const sessionsLauncher = requireCjs("../scripts/pi-review-sessions.cjs") as {
  __test: {
    runSessionHostLauncher(argv: readonly string[], overrides?: Record<string, unknown>): Promise<number>;
  };
};
const prepare = requireCjs("../scripts/prepare-application.cjs") as {
  SKILL_PUBLISH_PLAN: Array<{ name: string; label: string; files: Array<{ source: string[]; destination: string[] }> }>;
  ensureShippedSkills(options: Record<string, unknown>): { ok: boolean; published?: boolean; error?: string };
  applicationStateRoot(agentDir: string): string;
};

const repoRoot = process.cwd();
const isWindows = process.platform === "win32";

/** All fixture data stays under the ignored worker node_modules directory. */
function makeFixture(prefix: string): { root: string; home: string; packageRoot: string; agentDir: string; stateRoot: string } {
  const nodeModules = join(repoRoot, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  const root = mkdtempSync(join(nodeModules, prefix));
  const home = join(root, "home");
  const packageRoot = join(root, "package");
  const agentDir = join(root, "agent");
  mkdirSync(home, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  return { root, home, packageRoot, agentDir, stateRoot: prepare.applicationStateRoot(agentDir) };
}

function cleanup(t: test.TestContext, root: string): void {
  t.after(() => rmSync(root, { recursive: true, force: true }));
}

/** Copy the real shipped skills tree into a fixture package root. */
function withShippedSkills(packageRoot: string, missing?: readonly string[]): void {
  cpSync(join(repoRoot, "skills"), join(packageRoot, "skills"), { recursive: true });
  for (const rel of missing ?? []) rmSync(join(packageRoot, "skills", ...rel.split("/")), { force: true });
}

/** The fixture package root is a packaged (non-source) checkout. */
function withCompiledEntry(packageRoot: string): void {
  for (const entry of ["dist/src/session-host/main.js", "dist/src/index.js", "dist/src/web/cli.js"]) {
    const file = join(packageRoot, ...entry.split("/"));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "// synthetic compiled entry\n", "utf8");
  }
}

function publish(fixture: { packageRoot: string; home: string; agentDir: string; stateRoot: string }, identity = "source:fixture") {
  return prepare.ensureShippedSkills({
    stateRoot: fixture.stateRoot,
    agentDir: fixture.agentDir,
    packageRoot: fixture.packageRoot,
    homeDir: fixture.home,
    applicationIdentity: identity,
  });
}

function assertPublished(home: string, packageRoot: string): void {
  for (const skill of prepare.SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const source = join(packageRoot, ...file.source);
      const destination = join(home, ".agents", "skills", skill.name, ...file.destination);
      assert.ok(existsSync(destination), `published: ${skill.name}/${file.destination.join("/")}`);
      assert.equal(readFileSync(destination, "utf8"), readFileSync(source, "utf8"),
        `content parity: ${skill.name}/${file.destination.join("/")}`);
    }
  }
}

function assertNoPublishLitter(home: string): void {
  const skillsRoot = join(home, ".agents", "skills");
  if (!existsSync(skillsRoot)) return;
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsRoot, entry.name);
    for (const child of readdirSync(dir)) {
      assert.ok(!child.startsWith(".skill-publish."), `no staged publication litter: ${join(entry.name, child)}`);
    }
  }
}

test("direct sidebar provisioning publishes every canonical manifest file (native fs)", (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-publish-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot);

  const result = publish(fixture);
  assert.equal(result.ok, true);
  assertPublished(fixture.home, fixture.packageRoot);
  assertNoPublishLitter(fixture.home);
});

test("repeat launch reuses a current component marker and refreshes stale files (native fs)", (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-repeat-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot);
  assert.equal(publish(fixture).ok, true);
  assert.equal(publish(fixture).published, false, "a current component performs no copy or comparison");

  const stale = join(fixture.home, ".agents", "skills", "pi-review-gate-execution", "SKILL.md");
  const untouched = join(fixture.home, ".agents", "skills", "pi-review-gate-research", "SKILL.md");
  writeFileSync(stale, readFileSync(stale, "utf8") + "\n<!-- stale local edit -->\n", "utf8");
  const untouchedBefore = statSync(untouched, { bigint: true }).mtimeNs;

  const repaired = publish(fixture);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.published, true, "modified installed content forces a republish");
  assert.equal(readFileSync(stale, "utf8"),
    readFileSync(join(fixture.packageRoot, "skills", "pi-review-gate-execution", "SKILL.md"), "utf8"),
    "the stale installed skill is refreshed to the packaged bytes");
  assert.equal(statSync(untouched, { bigint: true }).mtimeNs, untouchedBefore,
    "a byte-identical installed skill is reused, not rewritten");
  assertNoPublishLitter(fixture.home);
});

test("a missing packaged skill source fails closed before any publication", (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-missing-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot, ["pi-review-gate-completion/SKILL.md"]);

  const result = publish(fixture);
  assert.equal(result.ok, false, "the launch must be stopped");
  assert.match(String(result.error), /packaged skill file is missing/);
  assert.equal(existsSync(join(fixture.home, ".agents")), false,
    "no skill directory is created when a packaged source is missing");
});

test("provisioning migrates proven generic copies and preserves user-owned files (native fs)", (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-migration-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot);

  const skillsRoot = join(fixture.home, ".agents", "skills");
  const priorOrchestrator = join(skillsRoot, "orchestrator", "SKILL.md");
  const priorRecovery = join(skillsRoot, "orchestrator", "references", "recovery.md");
  mkdirSync(join(skillsRoot, "orchestrator", "references"), { recursive: true });
  writeFileSync(priorOrchestrator, readFileSync(join(repoRoot, "tests", "fixtures", "skill-migration", "orchestrator", "SKILL.md"), "utf8"), "utf8");
  writeFileSync(priorRecovery, readFileSync(join(repoRoot, "tests", "fixtures", "skill-migration", "orchestrator", "references", "recovery.md"), "utf8"), "utf8");
  const userResearch = join(skillsRoot, "research", "SKILL.md");
  mkdirSync(join(skillsRoot, "research"), { recursive: true });
  writeFileSync(userResearch, "# user-owned research skill\n", "utf8");
  const userSkill = join(skillsRoot, "my-user-skill", "SKILL.md");
  mkdirSync(join(skillsRoot, "my-user-skill"), { recursive: true });
  writeFileSync(userSkill, "# unrelated user skill\n", "utf8");

  assert.equal(publish(fixture).ok, true);

  assert.equal(existsSync(priorOrchestrator), false, "the proven generic orchestrator copy is migrated away");
  assert.equal(existsSync(priorRecovery), false, "the paired proven generic recovery.md is removed with it");
  assert.equal(readFileSync(userResearch, "utf8"), "# user-owned research skill\n",
    "a customized generic copy is preserved fail-closed");
  assert.equal(readFileSync(userSkill, "utf8"), "# unrelated user skill\n",
    "unrelated user skills are untouched");
  assertPublished(fixture.home, fixture.packageRoot);
});

function fixturePython(fixture: { root: string }, env: NodeJS.ProcessEnv): { venv: string; python: string } {
  const venv = join(fixture.root, "ddgs-venv");
  mkdirSync(join(venv, "bin"), { recursive: true });
  const python = join(venv, "bin", "python");
  writeFileSync(python, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(python, 0o755);
  env.PI_REVIEW_GATE_DDGS_VENV = venv;
  return { venv, python };
}

function flowOverrides(
  fixture: { root: string; home: string; packageRoot: string; agentDir: string },
  events: string[],
  stderr: string[],
): Record<string, unknown> {
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: fixture.home };
  const { python } = fixturePython(fixture, environment);
  return {
    getEnv: () => environment,
    processEnv: {},
    platform: process.platform,
    nodeVersion: "22.23.4",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot: fixture.packageRoot,
    // The shared authority is the only preparation path; DDGS provisioning is
    // synthetic here so the flow test stays offline and deterministic.
    prepareApplication: (options: Record<string, unknown>) => prepareLaunchForTest(options, python),
    resolvePiRuntime: () => ({ file: "/synthetic/pi", version: "1.0.4", source: "npm-global" }),
    loadMain: (entry: string) => {
      events.push("load");
      assert.ok(existsSync(entry), "only an available compiled entry is handed to the module loader");
      return { runSessionHost: () => { events.push("run"); return 0; } };
    },
    writeOut: () => undefined,
    writeError: (text: string) => { stderr.push(text); },
  };
}

const prepareLaunch = (requireCjs("../scripts/prepare-application.cjs") as {
  prepareLaunch(options: Record<string, unknown>): Promise<Record<string, unknown>>;
}).prepareLaunch;

function prepareLaunchForTest(options: Record<string, unknown>, python: string): Promise<Record<string, unknown>> {
  return prepareLaunch({ ...options, provisionDdgs: () => ({ ok: true, python }) });
}

test("the launcher provisions components before host load (mocked setup, real provisioning)", async (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-flow-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot);
  withCompiledEntry(fixture.packageRoot);

  const events: string[] = [];
  const stderr: string[] = [];
  const status = await sessionsLauncher.__test.runSessionHostLauncher([], flowOverrides(fixture, events, stderr));

  assert.equal(status, 0, stderr.join(""));
  assert.deepEqual(events, ["load", "run"], "the host loads only after setup succeeds");
  assertPublished(fixture.home, fixture.packageRoot);
  assertNoPublishLitter(fixture.home);
});

test("a blocked skill directory stops startup and preserves existing content", async (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-directory-failure-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot);
  withCompiledEntry(fixture.packageRoot);
  mkdirSync(join(fixture.home, ".agents"), { recursive: true });
  const blocker = join(fixture.home, ".agents", "skills");
  writeFileSync(blocker, "user-owned blocking file\n");

  const events: string[] = [];
  const stderr: string[] = [];
  const status = await sessionsLauncher.__test.runSessionHostLauncher([], flowOverrides(fixture, events, stderr));

  assert.equal(status, 2);
  assert.deepEqual(events, [], "the host never loads after directory preparation fails");
  assert.match(stderr.join(""), /shipped skill provisioning failed: could not create the skill directory/);
  assert.equal(readFileSync(blocker, "utf8"), "user-owned blocking file\n");
});

test("a blocked publication destination stops startup and preserves existing content", async (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-publication-failure-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot);
  withCompiledEntry(fixture.packageRoot);
  const skill = prepare.SKILL_PUBLISH_PLAN[0]!;
  const destination = join(fixture.home, ".agents", "skills", skill.name, ...skill.files[0]!.destination);
  mkdirSync(destination, { recursive: true });
  const marker = join(destination, "user-owned-marker");
  writeFileSync(marker, "preserve me\n");

  const events: string[] = [];
  const stderr: string[] = [];
  const status = await sessionsLauncher.__test.runSessionHostLauncher([], flowOverrides(fixture, events, stderr));

  assert.equal(status, 2);
  assert.deepEqual(events, [], "the host never loads after publication fails");
  assert.match(stderr.join(""), /shipped skill provisioning failed: could not refresh the shipped skill file/);
  assert.equal(readFileSync(marker, "utf8"), "preserve me\n");
  assertNoPublishLitter(fixture.home);
});

test("a missing packaged skill source stops host load before any publication", async (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-flow-failure-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot, ["pi-review-gate-research/SKILL.md"]);
  withCompiledEntry(fixture.packageRoot);

  const events: string[] = [];
  const stderr: string[] = [];
  const status = await sessionsLauncher.__test.runSessionHostLauncher([], flowOverrides(fixture, events, stderr));

  assert.equal(status, 2, "the launch is stopped");
  assert.deepEqual(events, [], "the host module is never loaded");
  assert.match(stderr.join(""), /shipped skill provisioning failed: packaged skill file is missing/);
  assert.equal(existsSync(join(fixture.home, ".agents")), false,
    "no partial publication precedes the failure");
});

test("native Windows: the launcher publishes into the native discovery home", {
  skip: isWindows ? false : "the HOME/USERPROFILE divergence regression is native-Windows evidence",
}, async (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-win-home-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot);
  withCompiledEntry(fixture.packageRoot);
  // On native Windows the shared component home is os.homedir() (USERPROFILE),
  // which can differ from the flow's HOME; publication must land there.
  const userProfile = join(fixture.root, "userprofile");
  mkdirSync(userProfile, { recursive: true });
  const previous = process.env.USERPROFILE;
  process.env.USERPROFILE = userProfile;
  t.after(() => {
    if (previous === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous;
  });

  const events: string[] = [];
  const stderr: string[] = [];
  const overrides = flowOverrides(fixture, events, stderr);
  // Keep the production Windows home resolver. Replacing the whole preparer
  // bypasses that resolver and silently publishes into the synthetic HOME.
  delete overrides.prepareApplication;
  overrides.ensureDdgs = () => ({ ok: true, python: join(fixture.root, "ddgs-venv", "bin", "python") });
  const status = await sessionsLauncher.__test.runSessionHostLauncher([], overrides);

  assert.equal(status, 0, stderr.join(""));
  assert.deepEqual(events, ["load", "run"]);
  assertPublished(userProfile, fixture.packageRoot);
  assert.equal(existsSync(join(fixture.home, ".agents")), false,
    "the alternate HOME skill tree must remain untouched");
});
