import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { EXECUTION_TOOL_NAMES, ExecutionToolManager } from "../src/execution/tool";
import { buildWakeFailureDiagnostic, captureRejectionSummary } from "../src/execution/subtask-notifications";
import { newTask, transitionTaskState } from "../src/execution/task-state";
import type { BackgroundExecutionGroup } from "../src/execution/background-group-store";
import { captureWaveBase, WaveCaptureError } from "../src/execution/wave-repository";
import { createState } from "../src/state";

// #467: an isolated source capture that rejects one source entry happens
// before any worker exists. It must be a typed, path-bearing failed task
// outcome with exactly two explicit recovery choices — never a crash, a
// generic controller failure, nonexistent-worker advice, /review-clear, or an
// automatic replacement launch. All fixtures are synthetic and owned here.

const execFileAsync = promisify(execFile);
const SYSTEM_TMP = tmpdir();

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function initRepo(dir: string, files: Record<string, string>): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, ".."), { recursive: true });
    await writeFile(join(dir, name), content, "utf8");
  }
  await git(dir, "add", ...Object.keys(files));
  await git(dir, "commit", "-qm", "base");
  return realpath(dir);
}

test("capture rejects an over-budget or invalid entry with a typed cause and path; cancellation keeps its own code", async () => {
  const root = await mkdtemp(join(SYSTEM_TMP, "pi-467-typed-"));
  try {
    const repo = await initRepo(join(root, "repo"), { "tracked.txt": "tracked\n" });
    await writeFile(join(repo, "big.bin"), Buffer.alloc(1024, "u"));
    const sized = await captureWaveBase({ cwd: repo, maxSnapshotBytes: 100, waveId: "t467-size" }).then(
      () => assert.fail("over-budget untracked capture must reject"),
      (error: unknown) => error,
    );
    assert.ok(sized instanceof WaveCaptureError);
    assert.equal(sized.code, "source_entry_rejected");
    assert.deepEqual(sized.rejectedEntry, { reason: "untracked_size_limit", path: "big.bin", captureRoot: repo });
    assert.match(sized.message, /Snapshot size limit exceeded for untracked files.*big\.bin/, "the original cause text is preserved");

    // Non-size control: an escaping symlink keeps its own cause, not a size limit.
    await rm(join(repo, "big.bin"));
    await symlink("../outside-target", join(repo, "escape-link"));
    const escaped = await captureWaveBase({ cwd: repo, maxSnapshotBytes: 1_000_000, waveId: "t467-link" }).then(
      () => assert.fail("escaping symlink capture must reject"),
      (error: unknown) => error,
    );
    assert.ok(escaped instanceof WaveCaptureError);
    assert.deepEqual(escaped.rejectedEntry, { reason: "symlink_target_escapes_root", path: "escape-link", captureRoot: repo });

    // Cancellation control: unchanged code, no entry rejection.
    const abort = new AbortController();
    abort.abort();
    const cancelled = await captureWaveBase({ cwd: repo, maxSnapshotBytes: 1_000_000, waveId: "t467-cancel", signal: abort.signal }).then(
      () => assert.fail("cancelled capture must reject"),
      (error: unknown) => error,
    );
    assert.ok(cancelled instanceof WaveCaptureError);
    assert.equal(cancelled.code, "cancelled");
    assert.equal(cancelled.rejectedEntry, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function failedGroup(kind: "execute" | "research", withRejection: boolean): BackgroundExecutionGroup {
  const task = newTask({ title: "rejected capture", instructions: "work", acceptanceCriteria: ["done"] });
  transitionTaskState(task, "failed");
  task.executorEntryId = "default";
  task.error = "Snapshot size limit exceeded for untracked files";
  if (withRejection) {
    task.captureRejection = { code: "source_entry_rejected", reason: "untracked_size_limit", path: "data/huge.bin", captureRoot: "/synthetic/workspace" };
  }
  return { executionId: "exec-467", kind, revision: 3, cwd: "/synthetic/workspace", tasks: [task] } as unknown as BackgroundExecutionGroup;
}

test("failure diagnostic for a typed capture rejection offers exactly two path-bearing choices; other failures keep worker recovery", () => {
  for (const kind of ["execute", "research"] as const) {
    const group = failedGroup(kind, true);
    const diagnostic = buildWakeFailureDiagnostic({ group, task: group.tasks[0]!, content: "failure" });
    const actions = diagnostic.recovery.suggestedActions;
    assert.equal(actions.length, 2, `${kind}: exactly two recovery alternatives`);
    assert.match(actions[0]!, /^Narrower workspace: explicitly start a new SubtasksStart task/);
    assert.match(actions[1]!, /^InPlace worker: explicitly start a new SubtasksStart task with kind inplace/);
    for (const action of actions) {
      assert.ok(action.includes("\"data/huge.bin\""), `${kind}: each choice names the triggering path`);
      assert.doesNotMatch(action, /\/review-clear|SubtasksContinue|SubtasksInterrupt|SubtasksForceMerge|SubtasksAdd/);
    }
    assert.match(actions[0]!, /subdirectory of the same repository still captures it/, "no nested-cwd exclusion promise");
    assert.deepEqual(diagnostic.recovery.captureRejection, group.tasks[0]!.captureRejection);
    assert.equal(diagnostic.recovery.executorEntryId, undefined, "a never-started lease is not a recovery handle");
  }
  // Control: an ordinary failure without the typed record keeps the existing actions.
  const ordinary = failedGroup("execute", false);
  const control = buildWakeFailureDiagnostic({ group: ordinary, task: ordinary.tasks[0]!, content: "failure" }).recovery;
  assert.equal(control.captureRejection, undefined);
  assert.equal(control.executorEntryId, "default");
  assert.ok(control.suggestedActions.some((action) => action.startsWith("SubtasksInterrupt")));
  assert.ok(control.suggestedActions.some((action) => action.includes("SubtasksForceMerge")));
});

/** Decode every JSON string literal in prose (the exact path identities a model reads). */
function literalsIn(text: string): string[] {
  return [...text.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((match) => JSON.parse(match[0]) as string);
}

test("capture-rejection diagnostics preserve exact path identity (whitespace, control characters) and stay bounded", () => {
  const paths = ["data/large  dump.bin", " lead.bin", "trail.bin ", "tab\tand\nnewline.bin", "nbsp\u00a0name.bin", "quote\"and\\slash.bin", "plain name.bin"];
  for (const path of paths) {
    const group = failedGroup("execute", true);
    const task = group.tasks[0]!;
    task.captureRejection = { code: "source_entry_rejected", reason: "untracked_size_limit", path, captureRoot: "/synthetic/work  space" };
    task.summary = captureRejectionSummary(task.captureRejection);
    const diagnostic = buildWakeFailureDiagnostic({ group, task, content: task.summary });
    assert.equal(diagnostic.recovery.captureRejection?.path, path, `${JSON.stringify(path)}: typed field is exact`);
    assert.equal(diagnostic.recovery.captureRejection?.captureRoot, "/synthetic/work  space");
    assert.equal(diagnostic.recovery.suggestedActions.length, 2);
    for (const action of diagnostic.recovery.suggestedActions) {
      assert.equal(literalsIn(action)[0], path, `${JSON.stringify(path)}: each choice's first literal decodes to the exact path`);
    }
    assert.ok(literalsIn(diagnostic.recovery.suggestedActions[0]!).includes("/synthetic/work  space"), "root literal is exact");
    for (const text of [diagnostic.summary!, diagnostic.message]) {
      assert.equal(literalsIn(text)[0], path, `${JSON.stringify(path)}: bounded summary/notice keeps the exact path`);
    }
    // Negative control: the prose normalizer this replaces would have changed the identity.
    if (path !== "plain name.bin" && !path.includes("\"")) assert.notEqual(path.replace(/\s+/g, " ").trim(), path);
  }
  // Over-budget path: exact prefix, visible marker, every field within its bound.
  const long = `deep/${"seg  ".repeat(200)}end.bin`;
  const group = failedGroup("execute", true);
  group.tasks[0]!.captureRejection = { code: "source_entry_rejected", reason: "untracked_size_limit", path: long, captureRoot: "/synthetic/workspace" };
  const diagnostic = buildWakeFailureDiagnostic({ group, task: group.tasks[0]!, content: "failure" });
  const bounded = diagnostic.recovery.captureRejection!.path;
  assert.ok(bounded.endsWith("…[truncated]") && long.startsWith(bounded.slice(0, -"…[truncated]".length)), "typed path is an exact prefix");
  assert.ok(JSON.stringify(bounded).length - 2 <= 200);
  for (const action of diagnostic.recovery.suggestedActions) {
    assert.ok(action.length <= 600);
    const first = literalsIn(action)[0]!;
    assert.ok(first.length > 0 && long.startsWith(first), "each choice names an exact prefix of the long path");
  }
});

// ── registered tools + production controller ──────────────────────────────

/**
 * Owned stand-in for the Claude Code CLI speaking the installed Agent SDK's
 * stream-json protocol (no network/provider). Every launch is appended to the
 * marker log. A fresh session performs one real structured Write of the file
 * named by WRITE_FILE=<name> in its prompt; resumed sessions only reply.
 */
const mockCli = String.raw`
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const argv = process.argv;
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const resumed = argv.includes("--resume");
const session = flag("--resume") || flag("--session-id") || randomUUID();
fs.appendFileSync(process.env.CAPTURE_467_MARKER, JSON.stringify({ cwd: process.cwd(), resumed }) + "\n");
const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const base = () => ({ session_id: session, uuid: randomUUID(), parent_tool_use_id: null });
const textOf = (content) => typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => b && b.text || "").join("\n") : "";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
function handle(message) {
  if (message.type === "control_request") {
    const subtype = message.request && message.request.subtype;
    const response = subtype === "initialize"
      ? { commands: [], agents: [], output_style: "default", available_output_styles: ["default"], models: [], account: {} }
      : {};
    out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } });
    return;
  }
  if (message.type !== "user") return;
  out({ type: "system", subtype: "init", tools: ["Write"], model: "mock", ...base() });
  const match = /WRITE_FILE=([A-Za-z0-9._-]+)/.exec(textOf(message.message && message.message.content));
  if (!resumed && match) {
    const file = path.join(process.cwd(), match[1]);
    const content = "explicit recovery edit " + match[1] + "\n";
    out({ type: "assistant", ...base(), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_write_467", name: "Write", input: { file_path: file, content } }] } });
    fs.writeFileSync(file, content);
    out({ type: "user", ...base(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_write_467", content: "File created successfully" }] } });
  }
  out({ type: "assistant", ...base(), message: { role: "assistant", content: [{ type: "text", text: "requested edit complete" }] } });
  out({ type: "result", subtype: "success", is_error: false, result: "requested edit complete", duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: null, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID(), session_id: session });
}
`;

const sandboxEnvironment = ["HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "PI_CODING_AGENT_DIR", "GIT_CEILING_DIRECTORIES"] as const;
type SubtaskMessage = { customType: string; content: string; details?: Record<string, any> };
type ExecuteTool = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

async function waitUntil(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

test("registered SubtasksStart: real over-budget capture is a typed pre-start failure; explicit narrower-root and InPlace Tools-only launches both work", { skip: process.platform === "win32", timeout: 180_000 }, async () => {
  const sandbox = await realpath(await mkdtemp(join(SYSTEM_TMP, "pi-467-recovery-")));
  const prior = sandboxEnvironment.map((key) => [key, process.env[key]] as const);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  let manager: ExecutionToolManager | undefined;
  try {
    for (const dir of ["home", "tmp", "agent", "cli"]) await mkdir(join(sandbox, dir));
    process.env.HOME = join(sandbox, "home");
    process.env.USERPROFILE = join(sandbox, "home");
    process.env.TMPDIR = process.env.TMP = process.env.TEMP = join(sandbox, "tmp");
    process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
    process.env.GIT_CEILING_DIRECTORIES = sandbox;

    // Blocked workspace: one committed repository whose only problem is a
    // non-ignored untracked file over the (deliberately small) capture budget.
    // pkg/ is an independent nested repository (ignored by the outer one), so
    // its actual capture root excludes the triggering path; sub/ is an
    // ordinary subdirectory of the outer repository and does not.
    const blocked = await initRepo(join(sandbox, "blocked"), { ".gitignore": "pkg/\n", "base.txt": "base\n", "sub/keep.txt": "keep\n" });
    const narrower = await initRepo(join(blocked, "pkg"), { "pkg.txt": "independent root\n" });
    await writeFile(join(blocked, "huge-capture.bin"), Buffer.alloc(128 * 1024, "x"));
    const cli = join(sandbox, "cli", "mock-claude-cli.cjs");
    await writeFile(cli, `#!/usr/bin/env node\n${mockCli}`, "utf8");
    await chmod(cli, 0o755);
    const marker = join(sandbox, "cli", "launches.jsonl");
    const prompts = join(sandbox, "cli", "reviewer-prompts.jsonl");
    const reviewer = `const fs=require('node:fs');let p='';process.stdin.on('data',c=>p+=c);process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(prompts)},JSON.stringify(p)+'\\n');process.stdout.write(JSON.stringify({verdict:'pass',summary:'synthetic reviewer',findings:[]}));});`;
    const config = normalizeConfig({
      enabled: true,
      retainBundles: "always",
      maxSnapshotBytes: 64 * 1024,
      review: {
        subtaskReviewers: [{ source: "external", id: "reviewer" }],
        evidence: { inplaceToolOnly: true },
      },
      externalAgents: {
        reviewer: { adapter: "generic-cli", command: process.execPath, review: { args: ["-e", reviewer], timeoutMs: 20_000 } },
        "claude-mock": { adapter: "claude-cli", command: cli, env: { CAPTURE_467_MARKER: marker }, execution: { model: "mock-model" } },
      },
      execution: {
        maxWorkers: 1,
        workerResources: { default: { selection: { source: "external", id: "claude-mock" }, maxConcurrent: 1 } },
        routes: { execute: [{ resourceId: "default" }], research: [] },
        retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 0 },
      },
    });
    const tools: Array<Record<string, any>> = [];
    const messages: SubtaskMessage[] = [];
    manager = new ExecutionToolManager({
      pi: {
        registerTool: (tool: Record<string, any>) => { tools.push(tool); },
        registerCommand() {},
        setToolActive() {},
        getActiveTools: () => ["read", "bash", ...Object.values(EXECUTION_TOOL_NAMES)],
        sendMessage: (message: SubtaskMessage) => { messages.push(message); },
      },
      config,
      state: createState(),
      cwd: () => blocked,
    });
    manager.sync();
    const tool = (name: string): ExecuteTool => {
      const found = tools.find((candidate) => candidate.name === name);
      assert.ok(found, `${name} is registered`);
      return found.execute as ExecuteTool;
    };
    const start = tool("SubtasksStart");
    const inspect = tool("SubtasksInspect");
    const groups = () => (manager as unknown as { controller: { groups: Map<string, unknown> } }).controller.groups;
    const launches = async () => (await readFile(marker, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as { cwd: string; resumed: boolean });
    const failureFor = (taskId: string) => messages.find((message) => message.details?.taskId === taskId && message.content.includes("requires recovery attention"));
    const taskOf = async (executionId: string, taskId: string) =>
      (await inspect(`inspect-${taskId}`, { executionId, taskId }, undefined, undefined, {})).details.tasks[0] as Record<string, any>;
    const startTask = async (id: string, params: Record<string, unknown>) => {
      const started = await start(id, params, undefined, undefined, {});
      assert.equal(started.isError, false, `${id}: asynchronous admission succeeds`);
      return { executionId: started.details.executionId as string, taskId: started.details.tasks[0].taskId as string };
    };

    // 1. The isolated launch against the blocked workspace and, as the
    //    guidance control, against an ordinary subdirectory of it.
    const rejected: Array<{ executionId: string; taskId: string }> = [];
    for (const [id, workspace] of [["blocked-root", blocked], ["blocked-subdir", join(blocked, "sub")]] as const) {
      const handle = await startTask(id, {
        workspace,
        tasks: [{ title: `isolated ${id}`, instructions: "WRITE_FILE=never.txt", acceptanceCriteria: ["never.txt exists"] }],
      });
      rejected.push(handle);
      await waitUntil(() => failureFor(handle.taskId) !== undefined, `${id} failure notification`);
      const task = await taskOf(handle.executionId, handle.taskId);
      assert.equal(task.state, "failed");
      assert.match(task.summary, /^Capture rejected before worker started: /);
      assert.ok(task.summary.includes("\"huge-capture.bin\""));
      assert.doesNotMatch(task.summary, /Background controller failure/);
      assert.match(task.error, /Snapshot size limit exceeded for untracked files.*huge-capture\.bin/, "cause-specific error retained");
      assert.equal(task.waveRoot, undefined, "no wave/worker root was created");

      const message = failureFor(handle.taskId)!;
      const diagnostic = message.details!.diagnostic as Record<string, any>;
      assert.deepEqual(diagnostic.recovery.captureRejection, {
        code: "source_entry_rejected", reason: "untracked_size_limit", path: "huge-capture.bin", captureRoot: blocked,
      }, "the actual capture root is the Git top level even for a nested cwd");
      assert.equal(diagnostic.recovery.suggestedActions.length, 2);
      for (const action of diagnostic.recovery.suggestedActions as string[]) assert.ok(action.includes("\"huge-capture.bin\""));
      assert.ok(message.content.includes("Capture rejected before worker started"));
      for (const forbidden of [/Background controller failure/, /\/review-clear/, /SubtasksContinue/, /SubtasksInterrupt/, /SubtasksForceMerge/, /SubtasksAdd/]) {
        assert.doesNotMatch(message.content, forbidden, `${id}: model-visible failure omits ${forbidden}`);
      }
    }
    // Let any (forbidden) automatic replacement surface before asserting none.
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
    assert.deepEqual(await launches(), [], "no executor process ever started for the rejected captures");
    assert.equal(groups().size, 2, "no automatic replacement, conversion, or retry was launched");
    assert.equal((manager as unknown as { controller: { runtimes: Map<string, unknown> } }).controller.runtimes.size, 0);

    // 2. Model-equivalent explicit choice 1: a workspace whose actual capture
    //    root excludes the triggering path launches and lands normally.
    const narrow = await startTask("narrower-root", {
      workspace: narrower,
      tasks: [{ title: "narrower root", instructions: "WRITE_FILE=narrow-result.txt", acceptanceCriteria: ["narrow-result.txt exists"] }],
    });
    await waitUntil(async () => (await taskOf(narrow.executionId, narrow.taskId)).state === "landed", "narrower-root landing", 90_000);
    assert.equal(await readFile(join(narrower, "narrow-result.txt"), "utf8"), "explicit recovery edit narrow-result.txt\n");

    // 3. Model-equivalent explicit choice 2: InPlace in the SAME blocked
    //    workspace with the existing Tools only evidence setting.
    const before = (await readFile(prompts, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
    const inplace = await startTask("inplace-same-workspace", {
      kind: "inplace",
      workspace: blocked,
      tasks: [{ title: "inplace despite capture", instructions: "WRITE_FILE=inplace-result.txt", acceptanceCriteria: ["inplace-result.txt exists"] }],
    });
    await waitUntil(async () => (await taskOf(inplace.executionId, inplace.taskId)).state === "reported", "in-place review settlement", 90_000);
    const settled = await taskOf(inplace.executionId, inplace.taskId);
    assert.match(settled.summary, /Review: passed/);
    assert.match(settled.summary, /InPlace review evidence: Tools only; no exact workspace snapshot certification/);
    assert.equal(await readFile(join(blocked, "inplace-result.txt"), "utf8"), "explicit recovery edit inplace-result.txt\n", "the actual edit is retained in the blocked workspace");
    const reviewerPrompts = (await readFile(prompts, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).slice(before);
    assert.ok(reviewerPrompts.length >= 1, "the configured reviewer was reached");
    const inplacePrompt = reviewerPrompts.join("\n");
    assert.ok(inplacePrompt.includes("explicit recovery edit inplace-result.txt"), "retained observed tool content reaches the reviewer");
    assert.ok(inplacePrompt.includes("tool_call claude-cli/Write id=toolu_write_467 paths=inplace-result.txt"), "the structured tool observation is retained as evidence");
    assert.ok(inplacePrompt.includes("Review evidence method: Tools only"), "the reviewer is told the truthful tool-only scope");
    assert.ok(inplacePrompt.includes("Workspace delta not captured under the selected Tools only method"));
    assert.ok(!inplacePrompt.includes("x".repeat(256)), "the over-budget file was never captured into review evidence");

    const started = await launches();
    assert.ok(started.some((launch) => launch.cwd === blocked && !launch.resumed), "the InPlace executor ran directly in the blocked workspace");
    assert.ok(started.every((launch) => launch.cwd !== join(blocked, "sub")));
    assert.equal(groups().size, 4, "only the explicitly requested groups exist");
    assert.deepEqual(unhandled, [], "no unhandled rejection escaped the controller");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    try {
      if (manager) {
        await manager.shutdown();
        await manager.detach();
      }
    } finally {
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    // A cleanup error preserves the fixture instead of deleting under an unconfirmed writer.
    await rm(sandbox, { recursive: true, force: true });
  }
});
