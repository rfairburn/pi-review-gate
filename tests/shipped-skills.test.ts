import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// Shipped-skill capability and discovery matrix (issue 23).
//
// The launcher provisions three skills — orchestrator (with its recovery
// runbook), execution, and research — and each operating-mode prompt segment
// opens with a startup cue directing the model to the matching skill. These
// tests guard the observable capability matrix the skills teach (mode versus
// delegate boundaries, tool discovery, reporting semantics) and the cue /
// discovery wiring, not particular prose claims: content must stay
// capability-accurate against the actual runtime (src/execution/tool.ts,
// src/execution/tool-catalog.ts, src/deferred-tools.ts, src/background-shell)
// without duplicating the runtime tool catalog into static prompts.

const repoRoot = process.cwd();
const readSkill = (name: string): Promise<string> =>
  readFile(path.join(repoRoot, "skills", name, "SKILL.md"), "utf8");
// Markdown source wraps lines; capability-phrase matching is therefore run
// against whitespace-normalized text so wording stays the assertion target,
// not line breaking.
const normalize = (text: string): string => text.replace(/\s+/g, " ");
const readSkillFlat = async (name: string): Promise<string> => normalize(await readSkill(name));
const readRepoFileFlat = (relPath: string): Promise<string> =>
  readFile(path.join(repoRoot, relPath), "utf8").then(normalize);

const SHIPPED_SKILLS = ["orchestrator", "execution", "research"] as const;

test("every shipped skill declares valid frontmatter matching its directory", async () => {
  for (const name of SHIPPED_SKILLS) {
    const skill = await readSkill(name);
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(frontmatter, `${name} skill must carry frontmatter`);
    const nameLine = frontmatter[1].match(/^name: ([a-z0-9-]+)$/m);
    assert.ok(nameLine, `${name} skill must declare a lowercase name`);
    assert.equal(nameLine![1], name, "the declared name must match the skill directory");
    const descriptionLine = frontmatter[1].match(/^description: (.+)$/m);
    assert.ok(descriptionLine && descriptionLine![1].length > 0, `${name} skill must declare a description`);
  }
});

test("execution skill distinguishes primary execution mode from the delegated executor role", async () => {
  const skill = await readSkillFlat("execution");
  for (const phrase of [
    "Primary execution mode",
    "Delegated executor role",
    // Worker authority is fixed at capture; delegation never widens it.
    "captured from the parent's live authorization",
    "never widens",
    "Delegation never escalates permissions",
    // Availability ceilings come from the live inventory, not memory.
    "Availability ceilings are actual, not assumed",
  ]) {
    assert.ok(skill.includes(phrase), `execution skill missing: ${phrase}`);
  }
  // Pi executor roles do not register recursive delegation.
  assert.match(skill, /Recursive delegation is deliberately not registered/);
});

test("execution skill teaches the discovery contract without restating the runtime catalog", async () => {
  const skill = await readSkillFlat("execution");
  for (const phrase of [
    // Startup inventory: the role's discovery set (authorized minus baseline-loaded),
    // names plus a tiny purpose, schemas deferred.
    "startup inventory lists this role's discovery set",
    "full parameter schemas stay deferred",
    // The search_tools description carries that same discovery set.
    "`search_tools` tool description itself carries that same discovery set",
    "exact name",
    "Loading never performs the operation",
    // Stable-summary semantics: activation never rewrites the summary, baseline
    // tools are omitted from both surfaces.
    "stays byte-identical as deferred tools activate",
    "not a \"still inactive\" list",
    "loads automatically at baseline are omitted",
    // Do not duplicate or guess the runtime catalog.
    "Do not restate or guess the runtime catalog from memory",
    "absence from the summary never means absence of authority",
  ]) {
    assert.ok(skill.includes(phrase), `execution skill missing: ${phrase}`);
  }
  // No runtime catalog duplication and no superseded inclusive wording: the skill
  // must not enumerate its own authoritative name list as if it were the catalog,
  // and must not claim baseline-loaded tools appear in the discovery set.
  assert.doesNotMatch(skill, /Authorized tool names \(names only\)/);
  assert.doesNotMatch(skill, /carries the authorized tool names at live permissions/);
});

test("execution skill covers background shells, the workspace contract, and honest reporting", async () => {
  const skill = await readSkillFlat("execution");
  for (const phrase of [
    // Background-shell semantics from src/background-shell: handles, event
    // wakes, explicit stop — never polling.
    "`ShellStart`",
    "`ShellList`",
    "`ShellLog`",
    "`ShellSend`",
    "`ShellStop`",
    "event notifications and wakes",
    "never poll",
    // Delegated execution workspace contract: detached HEAD, harness-owned.
    "detached-HEAD managed worktrees",
    "Never check out, create, switch, or delete Git branches",
    "harness owns capture, checkpointing, and landing",
    // Evidence-capture semantics (#140): untracked worktree files are captured
    // and land; diagnostic scratch belongs outside the captured worktree.
    "Untracked files inside the worktree are captured",
    "outside the captured worktree",
    "a report-only or no-code intent does not exclude them",
    // Report-only phases: the summary is the deliverable; no fabricated edits.
    "the summary is the deliverable",
    "Do not fabricate file edits",
    // Reporting semantics: no_changes is legitimate but proves nothing.
    "`no_changes` is a legitimate deliverable",
    "does not prove task",
    "the parent evaluates the returned evidence",
  ]) {
    assert.ok(skill.includes(phrase), `execution skill missing: ${phrase}`);
  }
});

test("research skill enforces read-only work and forbids execution even when called research", async () => {
  const skill = await readSkillFlat("research");
  for (const phrase of [
    "enforced read-only boundary",
    "Primary plan/research mode",
    "Delegated research role",
    // Hard prohibitions regardless of the task's name.
    "No shell commands",
    "No process runs, PTY sessions, or process-based tests",
    "No file writes",
    // Observation-only browser boundary.
    "Browser observation only",
    "Click, form-fill, typing, upload, download, and",
    // The report is the deliverable; it never proves acceptance.
    "The report is the deliverable",
    "never lands workspace changes",
    "does not prove acceptance",
  ]) {
    assert.ok(skill.includes(phrase), `research skill missing: ${phrase}`);
  }
});

test("research skill teaches the same discovery contract as execution", async () => {
  const skill = await readSkillFlat("research");
  for (const phrase of [
    "startup inventory lists this role's discovery set",
    "`search_tools` tool description itself carries that same discovery set",
    "stays byte-identical as deferred tools activate",
    "not a \"still inactive\" list",
    "exact names",
    "Loading never performs the operation",
    // Research web-tool semantics that exist in the runtime.
    "`WebFetch`",
    "dynamic_content_suspected",
    "`BrowserExtract`",
    "nextIndex",
  ]) {
    assert.ok(skill.includes(phrase), `research skill missing: ${phrase}`);
  }
  assert.doesNotMatch(skill, /carries the authorized tool names at live permissions/);
});

test("orchestrator skill directs workers to the shipped role skills and keeps recovery guidance", async () => {
  const skill = await readSkillFlat("orchestrator");
  assert.match(skill, /execution workers at the execution skill/);
  assert.match(skill, /research workers at the research skill/);
  assert.match(skill, /references\/recovery\.md/);
});

test("orchestrator skill teaches capability-based dispatch with role links and authority ceilings", async () => {
  const skill = await readSkillFlat("orchestrator");
  // Capability-based role selection, not file-change-based: source-only
  // inspection fits research; anything that must run something fits execution
  // even when the deliverable is only a report.
  assert.match(skill, /Source-only inspection and investigation fit research/);
  assert.match(skill, /requires an authorized execution path, even when the deliverable is only a diagnostic report/);
  assert.match(skill, /Choose the delegate role by the capabilities the work needs, not by whether files will change/);
  // Check planned operations against actual tools; stable discovery inventory,
  // no static catalog duplication.
  assert.match(skill, /Check the planned operations against the actual available tools before dispatching/);
  assert.match(skill, /authorized tools minus the tools the role loads automatically at baseline/);
  assert.match(skill, /unchanged by later activations/);
  assert.match(skill, /rebuilt only when the real permissions or operating mode change/);
  assert.match(skill, /Never duplicate a static tool catalog/);
  // Delegation never widens authority in either direction.
  assert.match(skill, /Delegation never widens authority/);
  assert.match(skill, /a plan\/research operating mode cannot escalate past its own read-only boundary/);
  // Working relative links to the role skills, read before dispatching.
  assert.match(skill, /\[\.\.\/execution\/SKILL\.md\]\(\.\.\/execution\/SKILL\.md\)/);
  assert.match(skill, /\[\.\.\/research\/SKILL\.md\]\(\.\.\/research\/SKILL\.md\)/);
  assert.match(skill, /before choosing or dispatching a delegate/);
  // Preserved policies: detached worktree ownership, supervision, recovery,
  // useful concurrency.
  assert.match(skill, /the harness owns checkpointing and landing/);
  assert.match(skill, /references\/recovery\.md/);
  assert.match(skill, /Capacity is an opportunity, not a utilization target/);
  // Runtime diagnosis is an execution dispatch even without file changes.
  assert.match(skill, /runtime or process diagnosis[^"]*including report-only diagnosis that changes no files/);
});

test("execution skill sends minute-scale commands to background shells and broadens evidence beyond changed files", async () => {
  const skill = await readSkillFlat("execution");
  // Background shells, not long foreground calls, for minute-scale work even
  // without stdin interaction; foreground is for genuinely quick commands.
  assert.match(skill, /minute-scale commands such as builds, test runs, and dependency installs even when no stdin interaction is needed/);
  assert.match(skill, /Only genuinely quick commands[^"]*belong in the foreground/);
  assert.doesNotMatch(skill, /prefer that when no mid-flight interaction is needed/);
  // Evidence includes observations, not only changed files.
  assert.match(skill, /Evidence is not limited to files you actually change/);
  assert.match(skill, /observed commands and their results, unchanged-source findings/);
  assert.doesNotMatch(skill, /Only files you actually change are evidence/);
  // Preserved: role authorization ceilings and no-change reporting semantics.
  assert.match(skill, /Delegation never escalates permissions/);
  assert.match(skill, /`no_changes` is a legitimate deliverable/);
  assert.match(skill, /report the observations that establish it/);
  assert.match(skill, /the summary is the deliverable/);
});

test("research skill distinguishes content search, path discovery, and directory listing", async () => {
  const skill = await readSkillFlat("research");
  assert.match(skill, /`grep` searches file \*\*contents\*\*/);
  assert.match(skill, /`find` discovers file \*\*paths\*\* by glob pattern/);
  assert.match(skill, /`ls` lists a \*\*directory's\*\* entries/);
  // Read-only boundary unchanged.
  assert.match(skill, /No shell commands/);
  assert.match(skill, /not arbitrary shell/);
});

test("startup cue skill paths match the launcher provisioning destinations", async () => {
  // Both launchers provision each skill to <home>/.agents/skills/<name>/SKILL.md;
  // the system-prompt cues must not promise a path the launchers never write.
  const shSource = await readFile(path.join(repoRoot, "scripts", "pi-review-gate.sh"), "utf8");
  const cjsSource = await readFile(path.join(repoRoot, "scripts", "pi-review-gate-launcher.cjs"), "utf8");
  assert.match(shSource, /SKILLS_DIR="\$HOME\/\.agents\/skills"/);
  assert.match(cjsSource, /"\.agents", "skills", skill\.name/);
  for (const [, file, skillName] of [
    ["execute", "execution-system-prompt.md", "execution"],
    ["orchestrate", "orchestrator-system-prompt.md", "orchestrator"],
    ["plan-research", "planning-system-prompt.md", "research"],
  ] as Array<[string, string, string]>) {
    const segment = await readRepoFileFlat(path.join("scripts", file));
    const cue = `read the shipped ${skillName} skill (\`~/.agents/skills/${skillName}/SKILL.md\`)`;
    assert.ok(
      segment.includes(cue),
      `${file} cue path must match the launcher provisioning destination`,
    );
  }
});

test("each operating-mode prompt segment opens with a startup cue naming its skill", async () => {
  const cases: Array<[mode: string, file: string, skill: string, cue: RegExp]> = [
    ["execute", "execution-system-prompt.md", "execution", /read the shipped execution skill \(`~\/\.agents\/skills\/execution\/SKILL\.md`\)/],
    ["orchestrate", "orchestrator-system-prompt.md", "orchestrator", /read the shipped orchestrator skill \(`~\/\.agents\/skills\/orchestrator\/SKILL\.md`\)/],
    ["plan-research", "planning-system-prompt.md", "research", /read the shipped research skill \(`~\/\.agents\/skills\/research\/SKILL\.md`\)/],
  ];
  for (const [, file, skillName, cue] of cases) {
    const segment = await readRepoFileFlat(path.join("scripts", file));
    assert.match(segment, cue, `${file} must cue the ${skillName} skill by installed path`);
    // The cue must come before the role body so it is read first.
    const cueIndex = segment.search(cue);
    const roleIndex = segment.indexOf("You are");
    assert.ok(cueIndex !== -1 && roleIndex !== -1 && cueIndex < roleIndex, `${file} cue must precede the role body`);
  }
  // The orchestration cue is explicitly a before-acting requirement.
  const orchestrator = await readRepoFileFlat(path.join("scripts", "orchestrator-system-prompt.md"));
  assert.match(orchestrator, /Before orchestrating or dispatching any subtask,/);
});

test("static mode segments never duplicate the dynamic tool inventory", async () => {
  for (const file of ["execution-system-prompt.md", "orchestrator-system-prompt.md", "planning-system-prompt.md"]) {
    const segment = await readRepoFileFlat(path.join("scripts", file));
    // The startup inventory is rendered at runtime from the live catalog
    // (src/tool-inventory.ts); static segments must not embed its rendering.
    assert.doesNotMatch(segment, /Authorized tool names/);
    assert.doesNotMatch(segment, /search_tools/);
  }
});

test("the two launcher skill manifests agree on every shipped skill file in order", async () => {
  // The POSIX launcher (scripts/pi-review-gate.sh) and the native Windows
  // helper (scripts/pi-review-gate-launcher.cjs) each hand-maintain a
  // SKILL_PUBLISH_PLAN; drift between them would silently skip provisioning
  // on one platform. Compare the packaged source paths, order-sensitive.
  const shSource = await readFile(path.join(repoRoot, "scripts", "pi-review-gate.sh"), "utf8");
  const cjsSource = await readFile(path.join(repoRoot, "scripts", "pi-review-gate-launcher.cjs"), "utf8");

  const shPlan = shSource.match(/SKILL_PUBLISH_PLAN=\(\n([\s\S]*?)\n\)/);
  assert.ok(shPlan, "pi-review-gate.sh must declare SKILL_PUBLISH_PLAN");
  const shSources = [...shPlan[1].matchAll(/"\$REVIEW_GATE_ROOT\/([^"]+)"/g)].map((m) => m[1]);

  const cjsPlan = cjsSource.match(/const SKILL_PUBLISH_PLAN = \[([\s\S]*?)\n\];/);
  assert.ok(cjsPlan, "pi-review-gate-launcher.cjs must declare SKILL_PUBLISH_PLAN");
  const cjsSources = [...cjsPlan[1].matchAll(/source: \[([^\]]+)\]/g)].map((m) =>
    m[1].split(",").map((part) => part.trim().replace(/^"|"$/g, "")).join("/"),
  );

  assert.ok(shSources.length > 0, "the POSIX manifest must list skill files");
  assert.deepEqual(cjsSources, shSources, "both launcher manifests must agree on sources and order");
  // Every manifest source must exist so the fail-closed checks never fire in a
  // healthy tree.
  for (const source of shSources) {
    const exists = await stat(path.join(repoRoot, source)).then(() => true, () => false);
    assert.ok(exists, `manifest source must exist: ${source}`);
  }
});

test("every cross-skill reference in the shipped skills resolves to an existing file", async () => {
  for (const name of SHIPPED_SKILLS) {
    const skill = await readSkill(name);
    for (const match of skill.matchAll(/\]\(([^)#]+)\)/g)) {
      const target = match[1];
      if (/^https?:/.test(target)) continue;
      const resolved = path.resolve(path.join(repoRoot, "skills", name), target);
      assert.ok(
        resolved.startsWith(path.join(repoRoot, "skills")),
        `${name} skill link target ${target} must stay inside the skills tree`,
      );
      const exists = await stat(resolved).then(() => true, () => false);
      assert.ok(exists, `${name} skill link target ${target} must exist`);
    }
  }
});
