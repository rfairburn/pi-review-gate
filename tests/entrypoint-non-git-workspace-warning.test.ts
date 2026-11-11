/**
 * Issue #292: informational startup warning for a positively non-Git workspace.
 *
 * These suites pin the real top-level `session_start` notice path plus the
 * classification boundary behind it:
 *
 * - exactly the specified sentence, delivered as a user-only `warning`-severity
 *   UI notice, once per `session_start` (startup/reload/new/resume/fork),
 *   beside the existing loaded notice, and never per prompt or tool call;
 * - no warning in a Git root, a subdirectory, a linked worktree, or a
 *   repository with an unborn HEAD, and none when Git is missing, its metadata
 *   is malformed, a path cannot be resolved, or discovery is redirected — an
 *   indeterminate workspace is never reported as non-Git;
 * - the whole classification settles inside its budget even when the Git child
 *   ignores termination or a filesystem read stalls, and a late result never
 *   delivers a warning;
 * - a throwing notice transport never blocks startup, a retired session never
 *   receives a stale warning, nothing model-facing is delivered, and the
 *   workspace is neither written to nor turned into a repository;
 * - the fixture's own Git invocations run in an isolated allowlisted
 *   environment that hostile ambient redirects, templates, and global hook
 *   configuration cannot influence.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import { activate } from "../src/index";
import {
  NON_GIT_WORKSPACE_WARNING,
  probeWorkspaceGitKind,
  sendNonGitWorkspaceWarning,
  type WorkspaceGitKind,
} from "../src/activation/non-git-workspace";
import { createSessionRuntime, indexTestConfig, trigger } from "./entrypoint-harness";

const run = promisify(execFile);

/** Isolated fixture Git environment: an explicit allowlist rather than an
 *  environment pass-through. Nothing that could redirect the repository, index,
 *  or object store, seed files from a template, prompt, or run an ambient hook
 *  is inherited, and the user's global/system configuration is never read.
 *  `core.hooksPath` and `init.templateDir` are pinned to fixture-owned empty
 *  directories through the highest-precedence configuration channel, and
 *  auto-maintenance/auto-gc stay off so the object store is quiescent once an
 *  awaited call settles. */
async function isolatedGitEnv(root: string): Promise<Record<string, string>> {
  const emptyConfig = join(root, "gitconfig-isolated");
  const hooks = join(root, "git-hooks-isolated");
  const template = join(root, "git-template-isolated");
  await writeFile(emptyConfig, "", "utf8");
  await mkdir(hooks, { recursive: true });
  await mkdir(template, { recursive: true });
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "maintenance.auto",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "gc.auto",
    GIT_CONFIG_VALUE_1: "0",
    GIT_CONFIG_KEY_2: "core.hooksPath",
    GIT_CONFIG_VALUE_2: hooks,
    GIT_CONFIG_KEY_3: "init.templateDir",
    GIT_CONFIG_VALUE_3: template,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    // Deliberately absent: GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR,
    // GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES,
    // GIT_TEMPLATE_DIR, GIT_CONFIG, GIT_EXEC_PATH, GIT_SSH_COMMAND,
    // GIT_CEILING_DIRECTORIES, and HOME.
  };
}

interface RecordedNotice {
  message: string;
  level?: string;
}

interface Fixture {
  root: string;
  /** The workspace under test. Kept separate from config/session files so a
   *  "startup wrote nothing here" assertion stays meaningful. */
  workspace: string;
  home: string;
  /** Fixture Git commands run only in the isolated environment above. */
  git: (cwd: string, ...args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

async function fixture(t: TestContext, name: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `pi-review-nongit-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(workspace, "notes.txt"), "existing workspace file\n", "utf8");
  process.env.PI_REVIEW_GATE_CONFIG = join(home, "review-gate.json");
  await writeFile(
    process.env.PI_REVIEW_GATE_CONFIG,
    JSON.stringify({ ...indexTestConfig, review: { activeReviewers: [] } }),
    "utf8",
  );
  delete process.env.PI_REVIEW_GATE_DISABLED;
  const env = await isolatedGitEnv(root);
  return {
    root,
    workspace,
    home,
    git: (cwd, ...args) => run("git", args, { cwd, env }),
  };
}

/** The shared fake host, with severity recorded and model-facing transports
 *  spied on so a user-only notice can be told apart from a model delivery. */
function warningRuntime(fixtureDir: Fixture, sessionId = "nongit-session") {
  const rt = createSessionRuntime(sessionId, join(fixtureDir.home, "session.jsonl"), fixtureDir.workspace);
  const recorded: RecordedNotice[] = [];
  const modelFacing: string[] = [];
  const ctx = rt.ctx as { ui: { notify: (message: string, level?: string) => void } };
  ctx.ui.notify = (message: string, level?: string) => {
    rt.notices.push(message);
    recorded.push({ message, level });
  };
  Object.assign(rt.pi, {
    sendMessage: (message: unknown) => { modelFacing.push(`sendMessage ${JSON.stringify(message)}`); },
    sendSystemMessage: (message: unknown) => { modelFacing.push(`sendSystemMessage ${String(message)}`); },
  });
  const warnings = () => recorded.filter((notice) => notice.message === NON_GIT_WORKSPACE_WARNING);
  return { ...rt, recorded, modelFacing, warnings };
}

const loadedIndex = (recorded: RecordedNotice[]) =>
  recorded.findIndex((notice) => notice.message.startsWith("review gate: loaded"));

/** Recursive, sorted workspace inventory (paths only) for mutation assertions. */
async function inventory(dir: string): Promise<string[]> {
  const entries: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      entries.push(`${relative}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory()) await walk(join(current, entry.name), relative);
    }
  };
  await walk(dir, "");
  return entries.sort();
}

const exists = async (path: string): Promise<boolean> => access(path).then(() => true, () => false);

/** A notice target that only records what it receives. */
function noticeSink(): { notices: RecordedNotice[]; target: unknown } {
  const notices: RecordedNotice[] = [];
  return {
    notices,
    target: { ui: { notify: (message: string, level?: string) => notices.push({ message, level }) } },
  };
}

/** Set ambient variables for one test and restore them exactly. */
async function withAmbientEnv(overrides: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const saved: Array<[string, string | undefined]> = Object.keys(overrides).map((key) => [key, process.env[key]]);
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  try {
    await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a positively non-Git workspace warns once with the specified text beside the loaded notice", async (t) => {
  const fx = await fixture(t, "plain");
  const rt = warningRuntime(fx);

  await activate(rt.pi);
  await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);

  const loaded = loadedIndex(rt.recorded);
  const warning = rt.recorded.findIndex((notice) => notice.message === NON_GIT_WORKSPACE_WARNING);
  assert.ok(loaded >= 0, "the existing loaded notice still appears");
  assert.equal(rt.recorded[loaded]?.level, "info", "the loaded notice keeps its info severity");
  assert.equal(warning, loaded + 1, "the warning lands beside the loaded notice");
  assert.equal(
    rt.recorded[warning]?.message,
    "Warning: Evidence capture works best in a Git worktree. Capture may be degraded in this workspace.",
    "exact specified sentence, unchanged",
  );
  assert.equal(rt.recorded[warning]?.level, "warning", "user-only warning severity");
  assert.equal(rt.warnings().length, 1, "once per startup");
  // User-only: no model turn, no system/steering/follow-up/custom delivery.
  assert.deepEqual(rt.modelFacing, []);
  assert.deepEqual(rt.sent, []);
});

test("the warning repeats once per session_start and never per prompt or tool call", async (t) => {
  const fx = await fixture(t, "cadence");
  const rt = warningRuntime(fx);
  await activate(rt.pi);

  for (const reason of ["startup", "reload", "new", "resume", "fork"] as const) {
    await trigger(rt.hooks, "session_start", { type: "session_start", reason }, rt.ctx);
    assert.equal(rt.warnings().length, rt.recorded.filter((n) => n.message.startsWith("review gate: loaded")).length,
      `one warning for each loaded notice (${reason})`);
    assert.equal(rt.warnings().length, ["startup", "reload", "new", "resume", "fork"].indexOf(reason) + 1);
  }

  // Ordinary per-turn activity never repeats it.
  await trigger(rt.hooks, "input", { cwd: fx.workspace, text: "keep working", source: "user" }, rt.ctx);
  await trigger(rt.hooks, "before_agent_start", { cwd: fx.workspace }, rt.ctx);
  await trigger(rt.hooks, "tool_call", { toolCallId: "call-1", toolName: "bash", input: { command: "echo hi" } }, rt.ctx);
  await trigger(rt.hooks, "agent_end", { cwd: fx.workspace, messages: [] }, rt.ctx);
  await trigger(rt.hooks, "agent_settled", { cwd: fx.workspace, messages: [] }, rt.ctx);
  assert.equal(rt.warnings().length, 5, "no warning per prompt or tool call");
});

test("Git roots, subdirectories, linked worktrees, and unborn repositories never warn", async (t) => {
  const cases: Array<{ name: string; cwd: (fx: Fixture) => Promise<string> }> = [
    { name: "root", cwd: async (fx) => { await fx.git(fx.workspace, "init", "--quiet"); return fx.workspace; } },
    {
      name: "subdirectory",
      cwd: async (fx) => {
        await fx.git(fx.workspace, "init", "--quiet");
        const sub = join(fx.workspace, "packages", "app");
        await mkdir(sub, { recursive: true });
        return sub;
      },
    },
    {
      name: "unborn",
      cwd: async (fx) => {
        await fx.git(fx.workspace, "init", "--quiet");
        await writeFile(join(fx.workspace, "notes.txt"), "still no commit\n", "utf8");
        return fx.workspace;
      },
    },
    {
      name: "linked-worktree",
      cwd: async (fx) => {
        await fx.git(fx.workspace, "init", "--quiet");
        await fx.git(fx.workspace, "add", "-A");
        await fx.git(fx.workspace, "commit", "--quiet", "-m", "seed");
        const linked = join(fx.root, "linked");
        await fx.git(fx.workspace, "worktree", "add", "--quiet", "-b", "wt-fixture", linked);
        return linked;
      },
    },
  ];

  for (const testCase of cases) {
    const fx = await fixture(t, testCase.name);
    const cwd = await testCase.cwd(fx);
    const rt = warningRuntime(fx);
    Object.assign(rt.ctx, { cwd });

    await activate(rt.pi);
    await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);

    assert.ok(loadedIndex(rt.recorded) >= 0, `${testCase.name}: startup still reports loaded`);
    assert.deepEqual(rt.warnings(), [], `${testCase.name}: a Git worktree never gets the non-Git warning`);
  }
});

test("malformed Git metadata and a redirected Git environment never warn", async (t) => {
  const cases: Array<{ name: string; prepare: (fx: Fixture) => Promise<void> }> = [
    {
      name: "empty-git-dir",
      prepare: async (fx) => { await mkdir(join(fx.workspace, ".git"), { recursive: true }); },
    },
    {
      name: "corrupt-config",
      prepare: async (fx) => {
        await mkdir(join(fx.workspace, ".git"), { recursive: true });
        await writeFile(join(fx.workspace, ".git", "config"), "not a config file\n[broken\n", "utf8");
      },
    },
    {
      name: "dangling-git-file",
      prepare: async (fx) => {
        await writeFile(join(fx.workspace, ".git"), `gitdir: ${join(fx.root, "nowhere.git")}\n`, "utf8");
      },
    },
    {
      name: "ambient-git-dir-redirect",
      prepare: async (fx) => {
        // An ambient redirect answers about another repository, so this cwd
        // cannot be classified at all.
        const inside = join(fx.root, "redirect-target");
        await mkdir(inside, { recursive: true });
        await fx.git(inside, "init", "--quiet");
        process.env.GIT_DIR = join(inside, ".git");
      },
    },
  ];

  for (const testCase of cases) {
    const fx = await fixture(t, testCase.name);
    await testCase.prepare(fx);
    const rt = warningRuntime(fx);
    try {
      await activate(rt.pi);
      await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);
      assert.ok(loadedIndex(rt.recorded) >= 0, `${testCase.name}: startup still reports loaded`);
      assert.deepEqual(rt.warnings(), [], `${testCase.name}: indeterminate is never labelled non-Git`);
    } finally {
      delete process.env.GIT_DIR;
    }
  }
});

test("a symlinked workspace is classified by its physical location", async (t) => {
  // A Git repository reached through an alias is still a Git worktree.
  const healthy = await fixture(t, "alias-git");
  await healthy.git(healthy.workspace, "init", "--quiet");
  const healthySub = join(healthy.workspace, "nested", "deep");
  await mkdir(healthySub, { recursive: true });
  const healthyAlias = join(healthy.root, "alias");
  await symlink(healthySub, healthyAlias);
  assert.equal(await probeWorkspaceGitKind(healthyAlias), "git");

  // The regression case: an alias into a subdirectory beneath malformed
  // metadata. Git reports "not a git repository" from the physical directory,
  // and only a physical ancestor walk finds the broken `.git` above it, so the
  // workspace must stay indeterminate rather than be labelled non-Git.
  const broken = await fixture(t, "alias-malformed");
  const brokenSub = join(broken.workspace, "nested", "deep");
  await mkdir(join(broken.workspace, ".git"), { recursive: true });
  await writeFile(join(broken.workspace, ".git", "config"), "[broken\n", "utf8");
  await mkdir(brokenSub, { recursive: true });
  const brokenAlias = join(broken.root, "alias");
  await symlink(brokenSub, brokenAlias);
  assert.equal(await probeWorkspaceGitKind(brokenAlias), "unknown");

  // Through the real startup notice path as well.
  const rt = warningRuntime(broken);
  Object.assign(rt.ctx, { cwd: brokenAlias });
  await activate(rt.pi);
  await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);
  assert.ok(loadedIndex(rt.recorded) >= 0, "startup still reports loaded");
  assert.deepEqual(rt.warnings(), [], "an alias into broken metadata never warns");

  // An unresolvable path is indeterminate, never a non-Git verdict.
  assert.equal(await probeWorkspaceGitKind(join(broken.root, "no-such-directory")), "unknown");
});

test("a Git child that ignores termination cannot hold startup open", { skip: process.platform === "win32" && "POSIX signal fixture" }, async (t) => {
  const fx = await fixture(t, "stalling-git");
  const bin = join(fx.root, "stalling-bin");
  await mkdir(bin, { recursive: true });
  const shim = join(bin, "git");
  // Ignores the gentle signal and never answers, so only the classification
  // budget's own kill of the owned child can release the awaited startup path.
  // The shim's PATH holds only its own directory, so it calls sleep by path.
  await writeFile(shim, "#!/bin/sh\ntrap '' TERM INT HUP\n/bin/sleep 2\nexit 0\n");
  await chmod(shim, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  try {
    const kindStarted = Date.now();
    const kind = await probeWorkspaceGitKind(fx.workspace);
    const kindElapsed = Date.now() - kindStarted;
    assert.equal(kind, "unknown", "a killed probe is never a non-Git verdict");
    // Outliving the gentle 1.5s signal proves the child really was still running
    // and had to be terminated by the budget, not answered and returned.
    assert.ok(kindElapsed >= 1_500, `the probe really stalled past the gentle signal (${kindElapsed}ms)`);
    assert.ok(kindElapsed < 6_000, `classification settled inside its budget (${kindElapsed}ms)`);

    const sink = noticeSink();
    const noticeStarted = Date.now();
    await sendNonGitWorkspaceWarning({
      cwd: fx.workspace,
      target: sink.target,
      isCurrent: () => true,
    });
    const noticeElapsed = Date.now() - noticeStarted;
    assert.ok(noticeElapsed >= 1_500, `the notice path's probe also stalled past the gentle signal (${noticeElapsed}ms)`);
    assert.ok(noticeElapsed < 6_000, `the notice path settled inside its budget (${noticeElapsed}ms)`);
    assert.deepEqual(sink.notices, [], "a probe that had to be killed warns nothing");
  } finally {
    process.env.PATH = previousPath;
  }
});

test("a stalled marker read is abandoned within the budget and its late result never warns", async (t) => {
  const fx = await fixture(t, "stalled-marker");
  const sink = noticeSink();
  let abandonMarkerRead: () => void = () => undefined;
  const stalledMarker = () => new Promise<unknown>((_resolve, reject) => {
    // Late settlement names the marker as absent, which would otherwise let a
    // non-Git verdict through after the budget was already exhausted.
    abandonMarkerRead = () => reject(Object.assign(new Error("late"), { code: "ENOENT" }));
  });

  const started = Date.now();
  await sendNonGitWorkspaceWarning({
    cwd: fx.workspace,
    target: sink.target,
    isCurrent: () => true,
    probe: (cwd) => probeWorkspaceGitKind(cwd, { statMarker: stalledMarker }),
  });
  const elapsed = Date.now() - started;

  // The stalled read, not an answer, is what ended the classification.
  assert.ok(elapsed >= 1_900, `the stalled walk ran to the budget (${elapsed}ms)`);
  assert.ok(elapsed < 5_000, `classification settled inside its budget (${elapsed}ms)`);
  assert.deepEqual(sink.notices, [], "an abandoned classification warns nothing");
  abandonMarkerRead();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(sink.notices, [], "a late marker result is ignored");
});

test("a throwing notice transport never blocks startup", async (t) => {
  const fx = await fixture(t, "notice-throws");
  const rt = warningRuntime(fx);
  const ctx = rt.ctx as unknown as { ui: { notify: (message: string, level?: string) => void } };
  ctx.ui.notify = (message: string, level?: string) => {
    rt.notices.push(message);
    rt.recorded.push({ message, level });
    if (message === NON_GIT_WORKSPACE_WARNING) throw new Error("notice transport exploded");
  };

  await activate(rt.pi);
  await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);

  assert.ok(loadedIndex(rt.recorded) >= 0, "session_start completed through the loaded notice");
  assert.equal(rt.recorded.filter((notice) => notice.message === NON_GIT_WORKSPACE_WARNING).length, 1,
    "the warning was attempted once and its failure was contained");
});

test("startup never writes into the workspace or creates a repository", async (t) => {
  const fx = await fixture(t, "no-mutation");
  await mkdir(join(fx.workspace, "src"), { recursive: true });
  await writeFile(join(fx.workspace, "src", "a.ts"), "export const a = 1;\n", "utf8");
  const before = await inventory(fx.workspace);
  const rt = warningRuntime(fx);

  await activate(rt.pi);
  await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);
  await trigger(rt.hooks, "session_start", { type: "session_start", reason: "new" }, rt.ctx);

  assert.deepEqual(await inventory(fx.workspace), before);
  assert.ok(!before.includes(".git/"), "the fixture workspace is not a repository");
});

test("the disabled startup path is unchanged", async (t) => {
  const fx = await fixture(t, "disabled");
  process.env.PI_REVIEW_GATE_DISABLED = "1";
  const rt = warningRuntime(fx);

  await activate(rt.pi);
  await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);

  // The disabled branch reports through the API object and returns before any
  // session hook is registered, so the startup notice path never runs at all.
  assert.ok(rt.notices.some((notice) => notice.startsWith("review gate: disabled")),
    "the existing disabled notice still appears");
  assert.equal(rt.hooks.get("session_start"), undefined, "no session_start handler is registered when disabled");
  assert.deepEqual(rt.warnings(), [], "a disabled gate warns about nothing");
});

test("classification is bounded, read-only, and indeterminate-safe", async (t) => {
  const plain = await fixture(t, "probe-plain");
  assert.equal(await probeWorkspaceGitKind(plain.workspace), "non-git");

  const inside = await fixture(t, "probe-git");
  await inside.git(inside.workspace, "init", "--quiet");
  await inside.git(inside.workspace, "add", "-A");
  await inside.git(inside.workspace, "commit", "--quiet", "-m", "seed");
  const sub = join(inside.workspace, "nested", "deeper");
  await mkdir(sub, { recursive: true });
  const linked = join(inside.root, "linked");
  await inside.git(inside.workspace, "worktree", "add", "--quiet", "-b", "wt-probe", linked);
  assert.equal(await probeWorkspaceGitKind(inside.workspace), "git");
  assert.equal(await probeWorkspaceGitKind(sub), "git");
  assert.equal(await probeWorkspaceGitKind(linked), "git");

  const unborn = await fixture(t, "probe-unborn");
  await unborn.git(unborn.workspace, "init", "--quiet");
  assert.equal(await probeWorkspaceGitKind(unborn.workspace), "git");

  const malformed = await fixture(t, "probe-malformed");
  await mkdir(join(malformed.workspace, ".git"), { recursive: true });
  await writeFile(join(malformed.workspace, ".git", "config"), "[broken\n", "utf8");
  assert.equal(await probeWorkspaceGitKind(malformed.workspace), "unknown");

  const dangling = await fixture(t, "probe-dangling");
  await writeFile(join(dangling.workspace, ".git"), `gitdir: ${join(dangling.root, "nowhere.git")}\n`, "utf8");
  assert.equal(await probeWorkspaceGitKind(dangling.workspace), "unknown");

  // A missing Git binary is never evidence of a non-Git workspace. The probe
  // resolves `git` from the environment it hands the child, so an empty PATH
  // directory models an installation without Git.
  const emptyBin = join(plain.root, "empty-bin");
  await mkdir(emptyBin, { recursive: true });
  const previousPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    assert.equal(await probeWorkspaceGitKind(plain.workspace), "unknown");
  } finally {
    process.env.PATH = previousPath;
  }

  // A missing workspace is indeterminate too.
  assert.equal(await probeWorkspaceGitKind(join(plain.root, "no-such-directory")), "unknown");
});

test("fixture Git commands ignore hostile ambient redirects, templates, and global hooks", async (t) => {
  const fx = await fixture(t, "hostile-git-env");
  const hostile = join(fx.root, "hostile");
  const hooks = join(hostile, "hooks");
  const template = join(hostile, "template");
  const hookRan = join(fx.root, "ambient-hook-ran");
  await mkdir(join(hostile, ".git"), { recursive: true });
  await mkdir(hooks, { recursive: true });
  await mkdir(template, { recursive: true });
  await writeFile(join(hooks, "post-checkout"), `#!/bin/sh\ntouch ${hookRan}\n`, "utf8");
  await chmod(join(hooks, "post-checkout"), 0o755);
  await writeFile(join(template, "INJECTED_BY_TEMPLATE"), "seeded by an ambient template\n", "utf8");
  const globalConfig = join(hostile, "global-gitconfig");
  await writeFile(
    globalConfig,
    `[core]\n\thooksPath = ${hooks}\n[init]\n\ttemplateDir = ${template}\n`,
    "utf8",
  );

  await withAmbientEnv({
    GIT_DIR: join(hostile, ".git"),
    GIT_WORK_TREE: hostile,
    GIT_COMMON_DIR: join(hostile, ".git"),
    GIT_INDEX_FILE: join(hostile, "index"),
    GIT_TEMPLATE_DIR: template,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_SYSTEM: globalConfig,
  }, async () => {
    await fx.git(fx.workspace, "init", "--quiet");
    await fx.git(fx.workspace, "add", "-A");
    await fx.git(fx.workspace, "commit", "--quiet", "-m", "seed");
    const linked = join(fx.root, "linked-hostile");
    await fx.git(fx.workspace, "worktree", "add", "--quiet", "-b", "hostile-wt", linked);

    // The mutations landed in the fixture workspace and its own linked worktree,
    // never in the ambient redirect target.
    const toplevel = (await fx.git(linked, "rev-parse", "--show-toplevel")).stdout.trim();
    assert.equal(await realpath(toplevel), await realpath(linked), "the linked worktree is the fixture's own");
    assert.ok(await exists(join(fx.workspace, ".git", "HEAD")), "the fixture repository was created in place");
    assert.ok(!(await exists(hookRan)), "an ambient global hook path never ran");
    const files = await inventory(fx.workspace);
    assert.ok(files.includes(".git/"), "the repository is the fixture's own");
    assert.ok(!files.includes("INJECTED_BY_TEMPLATE"), "an ambient template seeded nothing");
  });

  // The hostile values are gone again, so no later probe inherits them.
  assert.equal(process.env.GIT_DIR, undefined);
  assert.equal(process.env.GIT_WORK_TREE, undefined);
});

test("a session that retires while the probe is in flight receives no stale warning", async () => {
  const notices: RecordedNotice[] = [];
  let current = true;
  let releaseProbe: () => void = () => {};
  const probeStarted = new Promise<void>((resolve) => { releaseProbe = resolve; });
  const delivery = sendNonGitWorkspaceWarning({
    cwd: "/no/such/cwd",
    target: { ui: { notify: (message: string, level?: string) => notices.push({ message, level }) } },
    isCurrent: () => current,
    probe: async () => {
      // Retirement lands while the classification is still awaiting.
      await probeStarted;
      current = false;
      return "non-git";
    },
  });
  releaseProbe();
  await delivery;
  assert.deepEqual(notices, [], "no stale notice after the session retired");
});

test("a throwing probe never blocks the notice path", async () => {
  const notices: RecordedNotice[] = [];
  await sendNonGitWorkspaceWarning({
    cwd: "/no/such/cwd",
    target: { ui: { notify: (message: string, level?: string) => notices.push({ message, level }) } },
    isCurrent: () => true,
    probe: async (): Promise<WorkspaceGitKind> => { throw new Error("probe failed"); },
  });
  assert.deepEqual(notices, []);
});
