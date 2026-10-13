/**
 * Direct sidebar skill provisioning parity (issue 378).
 *
 * The direct sidebar entry points (scripts/pi-review-sessions.sh /
 * scripts/pi-review-sessions.cmd → scripts/pi-review-sessions.cjs) provision
 * the shipped skills themselves before host startup — wrapper-equivalent
 * destinations under ~/.agents/skills/ in the pi-review-gate- namespace,
 * atomic per-file
 * publication, and the ownership-safe pre-#151 generic-location migration, all
 * derived from the canonical SKILL_PUBLISH_PLAN in
 * scripts/pi-review-gate-launcher.cjs. A direct sidebar launch therefore needs
 * no wrapper prerequisite, a repeat launch refreshes stale skills while
 * reusing byte-identical files, and any provisioning failure stops the launch
 * with an actionable error before the host loads.
 *
 * Evidence split:
 * - NATIVE (real filesystem, runs on POSIX and Windows): refreshShippedSkills
 *   against fixture homes using process.platform — real directory creation,
 *   atomic rename publication, byte comparison, and migration on this
 *   platform's filesystem. The same compiled file is the native-Windows setup
 *   evidence in the CI windows-launcher job; it proves entrypoint setup only,
 *   never real Windows ConPTY or sidebar UI readiness. On native Windows the
 *   discovery home is USERPROFILE via os.homedir() (the wrapper's semantics),
 *   which can differ from HOME; a dedicated regression pins distinct HOME and
 *   USERPROFILE fixture directories and asserts publication lands in the
 *   USERPROFILE tree with the HOME tree untouched.
 * - MOCKED (synthetic seams): launcher flow ordering and failure semantics
 *   with injected build/Pi/DDGS/loadMain dependencies, plus the win32 path
 *   seam fail-closed check, which runs everywhere without claiming native
 *   Windows behavior.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import test from "node:test";

const requireCjs = createRequire(join(process.cwd(), "tests", "session-host-skill-provisioning.test.ts"));
const sessionsLauncher = requireCjs("../scripts/pi-review-sessions.cjs") as {
  __test: {
    runSessionHostLauncher(argv: readonly string[], overrides?: Record<string, unknown>): Promise<number>;
    refreshShippedSkills(packageRoot: string, homeDir: string, platform: string): { ok: true } | { ok: false; error: string };
  };
};
const gateLauncher = requireCjs("../scripts/pi-review-gate-launcher.cjs") as {
  SKILL_PUBLISH_PLAN: Array<{ name: string; label: string; files: Array<{ source: string[]; destination: string[] }> }>;
};

const repoRoot = process.cwd();
const isWindows = process.platform === "win32";

/** All fixture data stays under the ignored worker node_modules directory. */
function makeFixture(prefix: string): { root: string; home: string; packageRoot: string } {
  const nodeModules = join(repoRoot, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  const root = mkdtempSync(join(nodeModules, prefix));
  const home = join(root, "home");
  const packageRoot = join(root, "package");
  mkdirSync(home, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  return { root, home, packageRoot };
}

function cleanup(t: test.TestContext, root: string): void {
  t.after(() => rmSync(root, { recursive: true, force: true }));
}

/**
 * Pin the native discovery-home source for in-process os.homedir() (issue
 * 378): on win32 Node reads USERPROFILE from the live process environment,
 * which is where the wrapper publishes — and it can differ from the flow's
 * getEnv HOME. On POSIX this is a no-op: the discovery home is the setup
 * HOME itself.
 */
function pinNativeDiscoveryHome(t: test.TestContext, userProfile: string): void {
  const previous = process.env.USERPROFILE;
  if (isWindows) process.env.USERPROFILE = userProfile;
  t.after(() => {
    if (previous === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previous;
  });
}

/** The wrapper-equivalent discovery home for the native platform. */
function nativeDiscoveryHome(home: string, userProfile: string): string {
  return isWindows ? userProfile : home;
}

/** Copy the real shipped skills tree into a fixture package root. */
function withShippedSkills(packageRoot: string, missing?: readonly string[]): void {
  cpSync(join(repoRoot, "skills"), join(packageRoot, "skills"), { recursive: true });
  for (const rel of missing ?? []) rmSync(join(packageRoot, "skills", ...rel.split("/")), { force: true });
}

/** The fixture package root is a packaged (non-source) checkout. */
function withCompiledEntry(packageRoot: string): void {
  const entry = join(packageRoot, "dist", "src", "session-host", "main.js");
  mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
  writeFileSync(entry, "// synthetic compiled native host\n", "utf8");
}

function assertPublished(home: string, packageRoot = repoRoot): void {
  for (const skill of gateLauncher.SKILL_PUBLISH_PLAN) {
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

  const result = sessionsLauncher.__test.refreshShippedSkills(fixture.packageRoot, fixture.home, process.platform);
  assert.deepEqual(result, { ok: true });
  assertPublished(fixture.home, fixture.packageRoot);
  assertNoPublishLitter(fixture.home);
});

test("repeat launch refreshes stale skills and reuses byte-identical files (native fs)", (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-repeat-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot);
  assert.deepEqual(sessionsLauncher.__test.refreshShippedSkills(fixture.packageRoot, fixture.home, process.platform), { ok: true });

  const stale = join(fixture.home, ".agents", "skills", "pi-review-gate-execution", "SKILL.md");
  const untouched = join(fixture.home, ".agents", "skills", "pi-review-gate-research", "SKILL.md");
  writeFileSync(stale, readFileSync(stale, "utf8") + "\n<!-- stale local edit -->\n", "utf8");
  const untouchedBefore = statSync(untouched, { bigint: true }).mtimeNs;

  assert.deepEqual(sessionsLauncher.__test.refreshShippedSkills(fixture.packageRoot, fixture.home, process.platform), { ok: true });

  assert.equal(readFileSync(stale, "utf8"),
    readFileSync(join(repoRoot, "skills", "pi-review-gate-execution", "SKILL.md"), "utf8"),
    "the stale installed skill is refreshed to the packaged bytes");
  assert.equal(statSync(untouched, { bigint: true }).mtimeNs, untouchedBefore,
    "a byte-identical installed skill is reused, not rewritten");
  assertNoPublishLitter(fixture.home);
});

test("a missing packaged skill source fails closed before any publication", (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-missing-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot, ["pi-review-gate-completion/SKILL.md"]);

  const result = sessionsLauncher.__test.refreshShippedSkills(fixture.packageRoot, fixture.home, process.platform);
  assert.equal(result.ok, false, "the launch must be stopped");
  if (!result.ok) {
    assert.match(result.error, /packaged skill file is missing/);
  }
  assert.equal(existsSync(join(fixture.home, ".agents")), false,
    "no skill directory is created when a packaged source is missing");
});

test("a blocked skill directory stops startup without modifying the blocking file", async (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-directory-failure-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot);
  withCompiledEntry(fixture.packageRoot);
  const userProfile = join(fixture.root, "userprofile");
  mkdirSync(userProfile, { recursive: true });
  pinNativeDiscoveryHome(t, userProfile);
  const home = nativeDiscoveryHome(fixture.home, userProfile);
  mkdirSync(join(home, ".agents"), { recursive: true });
  const blocker = join(home, ".agents", "skills");
  writeFileSync(blocker, "user-owned blocking file\n");

  const events: string[] = [];
  const stderr: string[] = [];
  const status = await sessionsLauncher.__test.runSessionHostLauncher([], flowOverrides(fixture, events, stderr));

  assert.equal(status, 1);
  assert.deepEqual(events, [], "the host never loads after directory preparation fails");
  assert.match(stderr.join(""), /shipped skill provisioning failed: could not create the skill directory/);
  assert.equal(readFileSync(blocker, "utf8"), "user-owned blocking file\n");
});

test("a blocked publication destination stops startup and preserves existing content", async (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-publication-failure-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot);
  withCompiledEntry(fixture.packageRoot);
  const userProfile = join(fixture.root, "userprofile");
  mkdirSync(userProfile, { recursive: true });
  pinNativeDiscoveryHome(t, userProfile);
  const home = nativeDiscoveryHome(fixture.home, userProfile);
  const skill = gateLauncher.SKILL_PUBLISH_PLAN[0]!;
  const destination = join(home, ".agents", "skills", skill.name, ...skill.files[0]!.destination);
  mkdirSync(destination, { recursive: true });
  const marker = join(destination, "user-owned-marker");
  writeFileSync(marker, "preserve me\n");

  const events: string[] = [];
  const stderr: string[] = [];
  const status = await sessionsLauncher.__test.runSessionHostLauncher([], flowOverrides(fixture, events, stderr));

  assert.equal(status, 1);
  assert.deepEqual(events, [], "the host never loads after publication fails");
  assert.match(stderr.join(""), /shipped skill provisioning failed: could not refresh the shipped skill file/);
  assert.equal(readFileSync(marker, "utf8"), "preserve me\n");
  assertNoPublishLitter(home);
});

test("provisioning migrates proven generic copies and preserves user-owned files (native fs)", (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-migration-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot);

  const skillsRoot = join(fixture.home, ".agents", "skills");
  // Proven pre-#151 package-owned generic copies (digest-anchored fixtures).
  const priorOrchestrator = join(skillsRoot, "orchestrator", "SKILL.md");
  const priorRecovery = join(skillsRoot, "orchestrator", "references", "recovery.md");
  mkdirSync(join(skillsRoot, "orchestrator", "references"), { recursive: true });
  writeFileSync(priorOrchestrator, readFileSync(join(repoRoot, "tests", "fixtures", "skill-migration", "orchestrator", "SKILL.md"), "utf8"), "utf8");
  writeFileSync(priorRecovery, readFileSync(join(repoRoot, "tests", "fixtures", "skill-migration", "orchestrator", "references", "recovery.md"), "utf8"), "utf8");
  // User-owned content: a customized generic copy and an unrelated skill.
  const userResearch = join(skillsRoot, "research", "SKILL.md");
  mkdirSync(join(skillsRoot, "research"), { recursive: true });
  writeFileSync(userResearch, "# user-owned research skill\n", "utf8");
  const userSkill = join(skillsRoot, "my-user-skill", "SKILL.md");
  mkdirSync(join(skillsRoot, "my-user-skill"), { recursive: true });
  writeFileSync(userSkill, "# unrelated user skill\n", "utf8");

  assert.deepEqual(sessionsLauncher.__test.refreshShippedSkills(fixture.packageRoot, fixture.home, process.platform), { ok: true });

  assert.equal(existsSync(priorOrchestrator), false, "the proven generic orchestrator copy is migrated away");
  assert.equal(existsSync(priorRecovery), false, "the paired proven generic recovery.md is removed with it");
  assert.equal(readFileSync(userResearch, "utf8"), "# user-owned research skill\n",
    "a customized generic copy is preserved fail-closed");
  assert.equal(readFileSync(userSkill, "utf8"), "# unrelated user skill\n",
    "unrelated user skills are untouched");
  assertPublished(fixture.home, fixture.packageRoot);
});

test("the win32 path seam fails closed on a missing source without native Windows", (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-win32-seam-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot, ["pi-review-gate-completion/SKILL.md"]);

  const result = sessionsLauncher.__test.refreshShippedSkills(fixture.packageRoot, fixture.home, "win32");
  assert.equal(result.ok, false, "the win32 seam must fail closed on a missing source");
  if (!result.ok) {
    // The diagnostic carries the win32-joined path regardless of host platform.
    // On POSIX the backslash-joined sources never resolve, so the first plan
    // file is reported; on native Windows only the deleted source is missing.
    const named = gateLauncher.SKILL_PUBLISH_PLAN
      .flatMap((skill) => skill.files)
      .map((file) => win32.join(fixture.packageRoot, ...file.source))
      .find((sourcePath) => result.error.includes(sourcePath));
    assert.ok(named, `the error names a win32-joined manifest source path: ${result.error}`);
  }
  assert.equal(existsSync(join(fixture.home, ".agents")), false, "no publication happens before the fail-closed check");
});

function flowOverrides(fixture: { home: string; packageRoot: string }, events: string[], stderr: string[]): Record<string, unknown> {
  return {
    getEnv: () => ({ PATH: process.env.PATH, HOME: fixture.home }),
    processEnv: {},
    platform: process.platform,
    nodeVersion: "22.19.0",
    stdinIsTTY: true,
    stdoutIsTTY: true,
    packageRoot: fixture.packageRoot,
    // Packaged (non-source) fixture: the real build must never run.
    build: () => { throw new Error("the packaged fixture must not trigger a source build"); },
    resolvePiRuntime: () => ({ file: "/synthetic/pi", version: "1.0.4", source: "npm-global" }),
    ensureDdgs: () => ({ ok: true, python: "/synthetic/python" }),
    // No refreshShippedSkills override: the real provisioning runs.
    loadMain: (entry: string) => {
      events.push("load");
      assert.ok(existsSync(entry), "only an available compiled entry is handed to the module loader");
      return { runSessionHost: () => { events.push("run"); return 0; } };
    },
    writeOut: () => undefined,
    writeError: (text: string) => { stderr.push(text); },
  };
}

test("the launcher provisions skills before host load (mocked setup, real provisioning)", async (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-flow-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot);
  withCompiledEntry(fixture.packageRoot);
  const userProfile = join(fixture.root, "userprofile");
  mkdirSync(userProfile, { recursive: true });
  pinNativeDiscoveryHome(t, userProfile);

  const events: string[] = [];
  const stderr: string[] = [];
  const status = await sessionsLauncher.__test.runSessionHostLauncher([], flowOverrides(fixture, events, stderr));

  assert.equal(status, 0);
  assert.deepEqual(events, ["load", "run"], "the host loads only after setup succeeds");
  const discoveryHome = nativeDiscoveryHome(fixture.home, userProfile);
  assertPublished(discoveryHome, fixture.packageRoot);
  assertNoPublishLitter(discoveryHome);
});

test("skill provisioning failure prevents host load with an actionable error (mocked flow)", async (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-flow-failure-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot, ["pi-review-gate-research/SKILL.md"]);
  withCompiledEntry(fixture.packageRoot);
  const userProfile = join(fixture.root, "userprofile");
  mkdirSync(userProfile, { recursive: true });
  pinNativeDiscoveryHome(t, userProfile);

  const events: string[] = [];
  const stderr: string[] = [];
  const status = await sessionsLauncher.__test.runSessionHostLauncher([], flowOverrides(fixture, events, stderr));

  assert.equal(status, 1, "the launch is stopped");
  assert.deepEqual(events, [], "the host module is never loaded");
  assert.match(stderr.join(""), /shipped skill provisioning failed: packaged skill file is missing/);
  assert.equal(existsSync(join(nativeDiscoveryHome(fixture.home, userProfile), ".agents")), false,
    "no partial publication precedes the failure");
});

test("native Windows: skills publish to the USERPROFILE discovery home, not HOME", {
  skip: isWindows ? false : "the HOME/USERPROFILE divergence regression is native-Windows evidence",
}, async (t) => {
  const fixture = makeFixture(".session-host-skill-provisioning-win-home-");
  cleanup(t, fixture.root);
  withShippedSkills(fixture.packageRoot);
  withCompiledEntry(fixture.packageRoot);

  // HOME and USERPROFILE deliberately differ: node's os.homedir() uses
  // USERPROFILE on win32 — the wrapper's exact semantics — so the sidebar
  // launcher must publish into the USERPROFILE tree and leave the HOME tree
  // untouched.
  const userProfile = join(fixture.root, "userprofile");
  mkdirSync(userProfile, { recursive: true });
  pinNativeDiscoveryHome(t, userProfile);

  const events: string[] = [];
  const stderr: string[] = [];
  const status = await sessionsLauncher.__test.runSessionHostLauncher([], flowOverrides(fixture, events, stderr));

  assert.equal(status, 0);
  assert.deepEqual(events, ["load", "run"], "the host loads only after provisioning succeeds");
  for (const skill of gateLauncher.SKILL_PUBLISH_PLAN) {
    for (const file of skill.files) {
      const destination = join(userProfile, ".agents", "skills", skill.name, ...file.destination);
      assert.ok(existsSync(destination), `published in the USERPROFILE discovery home: ${skill.name}/${file.destination.join("/")}`);
      assert.equal(readFileSync(destination, "utf8"), readFileSync(join(fixture.packageRoot, ...file.source), "utf8"),
        `content parity: ${skill.name}/${file.destination.join("/")}`);
    }
  }
  assert.equal(existsSync(join(fixture.home, ".agents")), false,
    "the alternate HOME skill tree must remain untouched");
});
