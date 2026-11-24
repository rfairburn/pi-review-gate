import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { mock } from "node:test";
import {
  normalizeConfig,
  resolvedExecutorPool,
  reviewerConfigFingerprint,
  type DeciderConfig,
  type PiDeciderConfig,
  type ReviewGateConfig,
} from "../src/config";
import { createExecutorAdapter } from "../src/execution/adapters/factory";
import type { ExecutorAdapter, ExecutorRequest } from "../src/execution/types";
import { runWaveWorkerLifecycle } from "../src/execution/wave-worker-lifecycle";
import { captureWaveBase } from "../src/execution/wave-repository";
import { createWorkerWorktree, removeWorktree } from "../src/execution/wave-worktrees";
import { runInplaceLifecycle } from "../src/execution/inplace/coordinator";
import {
  ADMITTED_PI_REDACTION,
  ADMITTED_PI_UNAVAILABLE_DIAGNOSTIC,
  admittedPiCommandOrUndefined,
  redactAdmittedPiPath,
  resolveAdmittedPiChildSpawn,
  resolvePiChildSpawn,
  resolvePiLaunchSpawn,
  translatePiLaunchSpawnError,
} from "../src/pi-invocation";
import { runWaveWorker } from "../src/execution/wave-worker";
import { createReviewerAdapter } from "../src/review";
import { agentCatalog } from "./helpers";

/**
 * #682 downstream launch seam: one optional, trusted, nonpersisted admitted Pi
 * executable reaches the canonical Pi executor factory and the Pi model
 * subtask reviewer, while absence keeps every default/external launch as it
 * was. No live provider is ever contacted: Pi children are synthetic scripts.
 */

const factory = require("../src/execution/adapters/factory") as typeof import("../src/execution/adapters/factory");

const ADMITTED_FIXTURE_NAME = "admitted-pi-synthetic";
const REVIEWER_MODEL = "synthetic/reviewer";

/** Own one disposable root (and route os.tmpdir() into it) for one test. */
async function withOwnedRoot(prefix: string, fn: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const previousTmp = process.env.TMPDIR;
  const ownedTmp = join(root, "tmp");
  await mkdir(ownedTmp);
  process.env.TMPDIR = ownedTmp;
  try {
    await fn(root);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    mock.restoreAll();
    await rm(root, { recursive: true, force: true });
  }
}

async function withPrependedPath<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
}

/**
 * Synthetic Pi reviewer child: records its launch to `captureFile`, writes the
 * native session receipt, and answers needs_changes for its first `failFirst`
 * launches, then pass.
 */
function reviewerScript(captureFile: string, failFirst: number, passSummary = "clean"): string {
  const needsChanges = JSON.stringify({
    verdict: "needs_changes",
    summary: "fix required",
    guidance: null,
    findings: [{ severity: "blocking", file: "worker-output.txt", line: null, issue: "missing detail", recommendation: "add detail" }],
    error: null,
  });
  const pass = JSON.stringify({ verdict: "pass", summary: passSummary, guidance: null, findings: [], error: null });
  return [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');const path=require('node:path');",
    "const args=process.argv.slice(2);",
    "const sessionId=args[args.indexOf('--session-id')+1];",
    `const sessionFile=path.join(${JSON.stringify(join(captureFile, ".."))},'native',sessionId+'.jsonl');`,
    "fs.mkdirSync(path.dirname(sessionFile),{recursive:true});",
    "fs.writeFileSync(sessionFile,JSON.stringify({type:'session',version:3,id:sessionId,cwd:process.cwd()})+'\\n');",
    "const receipt=process.env.PI_REVIEW_GATE_REVIEWER_SESSION_RECEIPT;",
    "if(receipt)fs.writeFileSync(receipt,JSON.stringify({sessionId,sessionFile}));",
    "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{input+=c;});",
    "process.stdin.on('end',()=>{",
    `  const prior=fs.existsSync(${JSON.stringify(captureFile)})?fs.readFileSync(${JSON.stringify(captureFile)},'utf8').split('\\n').filter(Boolean).length:0;`,
    `  fs.appendFileSync(${JSON.stringify(captureFile)},JSON.stringify({argv:args})+'\\n');`,
    `  const text=prior<${failFirst}?${JSON.stringify(needsChanges)}:${JSON.stringify(pass)};`,
    "  console.log(JSON.stringify({type:'turn_start'}));",
    "  console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text}]}}));",
    "  console.log(JSON.stringify({type:'turn_end'}));",
    "  process.exit(0);",
    "});",
  ].join("\n");
}

/** An executable synthetic `pi` at `path` (POSIX shebang script). */
async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body, "utf8");
  await chmod(path, 0o755);
}

async function readLines(path: string): Promise<Array<{ argv: string[] }>> {
  const raw = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] });
}

/** Every regular file below `dir` whose bytes mention `needle`. */
async function filesMentioning(dir: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        await walk(path);
      } else if (entry.isFile()) {
        if ((await readFile(path)).includes(needle)) hits.push(path);
      }
    }
  };
  await walk(dir);
  return hits;
}

async function git(args: string[], cwd: string): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
  });
}

function canonicalPiReviewer(): PiDeciderConfig {
  return {
    id: "pi-synthetic",
    adapter: "pi-model",
    model: REVIEWER_MODEL,
    command: "pi",
    args: [],
    timeoutMs: 30_000,
  };
}

function adapterState(adapter: unknown): Record<string, unknown> {
  const record = adapter as { options?: Record<string, unknown>; config?: Record<string, unknown> };
  return (record.options ?? record.config)!;
}

/** The reviewer's launch-only admitted command (never part of its config). */
function reviewerAdmitted(adapter: unknown): string | undefined {
  return (adapter as { dependencies?: { admittedPiCommand?: string } }).dependencies?.admittedPiCommand;
}

// ── validation ───────────────────────────────────────────────────────────────

test("admitted Pi command validation keeps absence and refuses non-absolute values", () => {
  assert.equal(admittedPiCommandOrUndefined(undefined), undefined);
  const absolute = join(tmpdir(), "bin", ADMITTED_FIXTURE_NAME);
  assert.equal(admittedPiCommandOrUndefined(absolute), absolute);
  for (const invalid of ["", "pi", "./pi", `${absolute}\0x`]) {
    assert.throws(() => admittedPiCommandOrUndefined(invalid), /admitted Pi executable must be a non-empty absolute path/);
  }
});

// ── admitted spawn resolution ────────────────────────────────────────────────

test("admitted Pi spawn spec runs the JS entry through host Node on Windows and directly on POSIX", async () => {
  await withOwnedRoot("prg-682-spawnspec-", async (root) => {
    const entry = join(root, ADMITTED_FIXTURE_NAME);
    await writeExecutable(entry, "#!/usr/bin/env node\n");
    const fakeNode = join(root, "host", "node.exe");
    const args = ["--model", "synthetic/model", "--mode", "rpc"];

    // Windows: exactly the native host arrangement (host Node + entry first),
    // never a direct spawn of the entry and never through cmd.exe.
    assert.deepEqual(resolveAdmittedPiChildSpawn(entry, args, "win32", fakeNode), {
      ok: true, file: fakeNode, args: [entry, ...args],
    });
    // POSIX: direct execution of the admitted entry.
    assert.deepEqual(resolveAdmittedPiChildSpawn(entry, args, "linux", fakeNode), { ok: true, file: entry, args });
    assert.deepEqual(resolveAdmittedPiChildSpawn(entry, args, "darwin", fakeNode), { ok: true, file: entry, args });

    // Unmarked launches keep the existing default/custom resolution exactly.
    assert.deepEqual(resolvePiLaunchSpawn({ command: entry, admitted: false }, args), resolvePiChildSpawn(entry, args));
    assert.deepEqual(resolvePiLaunchSpawn({ command: "pi", admitted: false }, args), resolvePiChildSpawn("pi", args));

    // Preflight refusals are path-free and never fall back to `pi`.
    const notExecutable = join(root, "not-executable");
    await writeFile(notExecutable, "#!/usr/bin/env node\n", { mode: 0o644 });
    const refusals = [
      resolveAdmittedPiChildSpawn(join(root, "missing"), args, "linux", fakeNode),
      resolveAdmittedPiChildSpawn(join(root, "missing"), args, "win32", fakeNode),
      resolveAdmittedPiChildSpawn(root, args, "win32", fakeNode),
      resolveAdmittedPiChildSpawn("relative/pi", args, "linux", fakeNode),
      ...(process.platform !== "win32" ? [resolveAdmittedPiChildSpawn(notExecutable, args, "linux", fakeNode)] : []),
    ];
    for (const refusal of refusals) {
      assert.deepEqual(refusal, { ok: false, kind: "admitted-unavailable", error: ADMITTED_PI_UNAVAILABLE_DIAGNOSTIC });
      assert.ok(!refusal.ok && !refusal.error.includes(root));
    }
  });
});

test("admitted Pi spawn errors drop the path and keep only a safe code", () => {
  const admitted = join(tmpdir(), "owned", ADMITTED_FIXTURE_NAME);
  const raw = Object.assign(new Error(`spawn ${admitted} ENOENT`), { code: "ENOENT", path: admitted, spawnargs: [admitted] });
  const sanitized = translatePiLaunchSpawnError(raw, true, false) as NodeJS.ErrnoException;
  assert.equal(sanitized.code, "ENOENT");
  assert.match(sanitized.message, /admitted Pi executable failed to start \(ENOENT\)/);
  assert.ok(!sanitized.message.includes(admitted));
  assert.ok(!JSON.stringify(sanitized).includes(admitted), "no own property (path, spawnargs) carries the path");
  const odd = translatePiLaunchSpawnError(Object.assign(new Error(admitted), { code: admitted }), true, false);
  assert.match(odd.message, /\(SPAWN_ERROR\)/);
  assert.ok(!odd.message.includes(admitted));
  // Unmarked launches keep the existing translation unchanged.
  assert.equal(translatePiLaunchSpawnError(raw, false, false), raw);
});

// ── executor factory selection ───────────────────────────────────────────────

test("executor factory uses the admitted Pi command only for canonical Pi launches", () => {
  const admitted = join(tmpdir(), "owned", ADMITTED_FIXTURE_NAME);
  const config = normalizeConfig({
    enabled: true,
    externalAgents: agentCatalog({
      id: "synthetic-binary",
      adapter: "run-as-binary",
      command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1", args: ["synthetic.cjs"], timeoutMs: 15_000 },
    }),
  });
  const piSelection = { source: "pi", model: "synthetic/worker" } as const;

  // Absent: the existing default resolution (no explicit command) is kept.
  for (const adapter of [
    createExecutorAdapter(config, piSelection),
    createExecutorAdapter(config, piSelection, {}),
    createExecutorAdapter(config, piSelection, { admittedPiCommand: undefined }),
  ]) {
    assert.equal(adapterState(adapter).command, undefined);
    assert.equal(adapterState(adapter).admittedCommand, undefined);
  }

  // Present: exactly that path, with the same model and protection pin shape.
  const admittedAdapter = createExecutorAdapter(config, piSelection, { admittedPiCommand: admitted });
  assert.equal(admittedAdapter.kind, "pi-model");
  assert.equal(adapterState(admittedAdapter).admittedCommand, admitted, "carried as a marked admitted launch input");
  assert.equal(adapterState(admittedAdapter).command, undefined, "never as an ordinary configured command");
  assert.equal(admittedAdapter.model, "synthetic/worker");
  assert.ok(adapterState(admittedAdapter).toolProtection, "the parent protection pin still travels with the launch");

  // External workers never receive it.
  const external = createExecutorAdapter(config, { source: "external", id: "synthetic-binary" }, { admittedPiCommand: admitted });
  assert.equal(external.kind, "run-as-binary");
  assert.ok(!JSON.stringify(external).includes(admitted), "an external executor must not carry the admitted Pi path");

  // A present but invalid value fails closed instead of falling back to `pi`.
  assert.throws(
    () => createExecutorAdapter(config, piSelection, { admittedPiCommand: "pi" }),
    /admitted Pi executable must be a non-empty absolute path/,
  );
});

// ── reviewer adapter selection ───────────────────────────────────────────────

test("reviewer adapter swaps only the canonical default pi command on a launch-local copy", () => {
  const admitted = join(tmpdir(), "owned", ADMITTED_FIXTURE_NAME);
  const canonical = canonicalPiReviewer();
  const before = JSON.stringify(canonical);
  const fingerprint = reviewerConfigFingerprint(canonical);

  assert.equal(adapterState(createReviewerAdapter(canonical)).command, "pi");
  assert.equal(reviewerAdmitted(createReviewerAdapter(canonical)), undefined);
  const swapped = createReviewerAdapter(canonical, admitted);
  assert.equal(swapped.kind, "pi-model");
  assert.equal(reviewerAdmitted(swapped), admitted);
  assert.equal(adapterState(swapped), canonical, "the adapter keeps the caller's exact reviewer configuration");
  const implicitDefault: PiDeciderConfig = { id: "pi-implicit", adapter: "pi-model", model: REVIEWER_MODEL };
  assert.equal(reviewerAdmitted(createReviewerAdapter(implicitDefault, admitted)), admitted);
  assert.equal(JSON.stringify(canonical), before, "the caller's reviewer configuration is never mutated");
  assert.equal(reviewerConfigFingerprint(canonical), fingerprint, "the stamped fingerprint keeps the configured command");

  // An explicitly configured non-default Pi command keeps its exact semantics.
  const custom: PiDeciderConfig = { ...canonical, id: "pi-custom", command: "/opt/custom/pi" };
  assert.equal(adapterState(createReviewerAdapter(custom, admitted)).command, "/opt/custom/pi");
  assert.equal(reviewerAdmitted(createReviewerAdapter(custom, admitted)), undefined);

  // Non-Pi reviewers ignore it.
  const generic: DeciderConfig = { id: "generic", adapter: "generic-cli", command: process.execPath, args: ["-e", "0"] };
  assert.ok(!JSON.stringify(createReviewerAdapter(generic, admitted)).includes(admitted));

  assert.throws(() => createReviewerAdapter(canonical, "relative/pi"), /admitted Pi executable/);
});

test("Pi reviewer launches the admitted executable instead of an ambient pi (real synthetic children)", { skip: process.platform === "win32" }, async () => {
  await withOwnedRoot("prg-682-reviewer-", async (root) => {
    const decoyBin = join(root, "decoy-bin");
    const ownedBin = join(root, "owned-bin");
    await mkdir(decoyBin);
    await mkdir(ownedBin);
    const decoyCapture = join(root, "decoy", "capture.jsonl");
    const admittedCapture = join(root, "admitted", "capture.jsonl");
    await mkdir(join(root, "decoy"));
    await mkdir(join(root, "admitted"));
    await writeExecutable(join(decoyBin, "pi"), reviewerScript(decoyCapture, 0));
    const admitted = join(ownedBin, ADMITTED_FIXTURE_NAME);
    await writeExecutable(admitted, reviewerScript(admittedCapture, 0));

    await withPrependedPath(decoyBin, async () => {
      const run = async (command?: string) => {
        const bundleDir = await mkdtemp(join(root, "bundle-"));
        return createReviewerAdapter(canonicalPiReviewer(), command).run({
          id: "reviewer", cwd: root, prompt: "review", bundleDir, timeoutMs: 30_000,
        });
      };
      const admittedResult = await run(admitted);
      assert.equal(admittedResult.verdict, "pass", admittedResult.error ?? admittedResult.summary);
      assert.equal((await readLines(admittedCapture)).length, 1);
      assert.equal((await readLines(decoyCapture)).length, 0, "the ambient pi must not run when an admitted path is supplied");

      // Absent keeps the existing default `pi` PATH resolution.
      const defaultResult = await run(undefined);
      assert.equal(defaultResult.verdict, "pass", defaultResult.error ?? defaultResult.summary);
      assert.equal((await readLines(decoyCapture)).length, 1);
      assert.equal((await readLines(admittedCapture)).length, 1);
    });
  });
});

/** Synthetic Pi RPC executor child (session file, settlement receipt, compaction). */
function rpcExecutorScript(captureFile: string): string {
  return [
    "#!/usr/bin/env node",
    "const fs=require('node:fs');const nativePath=require('node:path');const crypto=require('node:crypto');",
    "const nativeArgs=process.argv.slice(2);",
    "const resumedFile=nativeArgs.includes('--session')?nativeArgs[nativeArgs.indexOf('--session')+1]:undefined;",
    "const sessionId=resumedFile?nativePath.basename(resumedFile,'.jsonl'):nativeArgs[nativeArgs.indexOf('--session-id')+1];",
    `const sessionFile=resumedFile??nativePath.join(${JSON.stringify(join(captureFile, ".."))},'native',sessionId+'.jsonl');`,
    "fs.mkdirSync(nativePath.dirname(sessionFile),{recursive:true});",
    "if(!fs.existsSync(sessionFile))fs.writeFileSync(sessionFile,JSON.stringify({type:'session',version:3,id:sessionId,cwd:process.cwd()})+'\\n');",
    "let ackGeneration=0;",
    "const ack=()=>{ackGeneration++;const sid=process.env.PI_REVIEW_GATE_SETTLEMENT_SESSION;const childId=process.env.PI_REVIEW_GATE_SETTLEMENT_CHILD;const secret=process.env.PI_REVIEW_GATE_SETTLEMENT_SECRET;const target=process.env.PI_REVIEW_GATE_SETTLEMENT_PATH;const pid=process.pid;const version=2;const oneShot=crypto.createHmac('sha256',secret).update('pi-review-gate-live-browser-settlement-key:v2:'+ackGeneration).digest();const mac=crypto.createHmac('sha256',oneShot).update(JSON.stringify([version,sid,childId,ackGeneration,pid])).digest('base64url');fs.mkdirSync(nativePath.dirname(target),{recursive:true,mode:0o700});const temporary=target+'.tmp.'+crypto.randomUUID();fs.writeFileSync(temporary,JSON.stringify({version,sessionId:sid,childId,settlement:ackGeneration,pid,mac})+'\\n',{mode:0o600});fs.renameSync(temporary,target);};",
    `fs.appendFileSync(${JSON.stringify(captureFile)},JSON.stringify({argv:nativeArgs})+'\\n');`,
    "let input='';process.stdin.setEncoding('utf8');const out=(v)=>console.log(JSON.stringify(v));",
    "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
    "if(c.type==='prompt'){out({type:'response',id:c.id,command:'prompt',success:true});out({type:'turn_start'});out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'synthetic done'}]}});out({type:'turn_end'});ack();out({type:'agent_end'});}",
    "else if(c.type==='get_state')out({type:'response',id:c.id,command:c.type,success:true,data:{sessionId,sessionFile,isStreaming:false,pendingMessageCount:0}});",
    "else if(c.type==='compact')out({type:'response',id:c.id,command:c.type,success:true,data:{summary:'compacted'}});",
    "else if(c.type==='get_last_assistant_text')out({type:'response',id:c.id,command:c.type,success:true,data:{text:'synthetic done'}});",
    "}});",
    "process.stdin.on('end',()=>process.exit(0));",
  ].join("\n");
}

// The delegated Pi RPC launch is POSIX-only here for the same reason as the
// existing alias-independent launch case (#335 Windows descendant proof).
test("factory-built Pi executor launches the admitted executable for fresh and compaction-recovery turns", { skip: process.platform === "win32" }, async () => {
  await withOwnedRoot("prg-682-executor-", async (root) => {
    const decoyBin = join(root, "decoy-bin");
    const ownedBin = join(root, "owned-bin");
    const work = join(root, "work");
    await mkdir(decoyBin);
    await mkdir(ownedBin);
    await mkdir(work);
    const decoyCapture = join(root, "decoy", "capture.jsonl");
    const admittedCapture = join(root, "admitted", "capture.jsonl");
    await mkdir(join(root, "decoy"));
    await mkdir(join(root, "admitted"));
    await writeExecutable(join(decoyBin, "pi"), rpcExecutorScript(decoyCapture));
    const admitted = join(ownedBin, ADMITTED_FIXTURE_NAME);
    await writeExecutable(admitted, rpcExecutorScript(admittedCapture));
    const config = normalizeConfig({ enabled: true });
    const executorToolCatalog = {
      allowedToolCatalog: ["read", "grep", "find", "ls"],
      initialActiveTools: ["read", "grep", "find", "ls"],
    };

    await withPrependedPath(decoyBin, async () => {
      const adapter = createExecutorAdapter(config, { source: "pi", model: "synthetic/worker" }, { admittedPiCommand: admitted });
      const artifactDir = join(root, "artifacts");
      await mkdir(artifactDir);
      const first = await adapter.run({ cwd: work, prompt: "task", artifactDir, turn: 1, executorToolCatalog });
      assert.equal(first.text, "synthetic done", first.failure?.message ?? "");
      assert.ok(first.session?.file, "the fresh turn reports its native session file");
      const recovered = await adapter.run({
        cwd: work,
        prompt: "continue after compaction",
        artifactDir,
        turn: 2,
        session: first.session,
        recovery: { kind: "compaction", compactBeforePrompt: true },
        executorToolCatalog,
      });
      assert.equal(recovered.text, "synthetic done", recovered.failure?.message ?? "");
    });

    const launches = await readLines(admittedCapture);
    assert.equal(launches.length, 3, "fresh turn, compaction child, and resumed turn all use the admitted path");
    for (const launch of launches) assert.equal(launch.argv[launch.argv.indexOf("--mode") + 1], "rpc");
    assert.equal((await readLines(decoyCapture)).length, 0, "the ambient pi must never launch");
    assert.deepEqual(await filesMentioning(join(root, "artifacts"), admitted), []);
  });
});

// ── lifecycle threading ──────────────────────────────────────────────────────

interface FactoryCall { selection: unknown; admittedPiCommand: string | undefined }

/** Synthetic structured executor for every turn; records each factory call. */
function installExecutorSpy(action: (request: ExecutorRequest, turn: number) => Promise<string>): { calls: FactoryCall[]; restore: () => void } {
  const calls: FactoryCall[] = [];
  let turns = 0;
  const adapter: ExecutorAdapter = {
    kind: "pi-model",
    toolEventObservability: { mode: "structured", description: "synthetic structured observations" },
    async run(request) {
      const text = await action(request, ++turns);
      return {
        text,
        session: { adapter: "pi-model", id: "synthetic-session" },
        stdoutPath: "",
        stderrPath: "",
        code: 0,
        aborted: false,
        timedOut: false,
      };
    },
  };
  const spy = mock.method(factory, "createExecutorAdapter", (_config: ReviewGateConfig, selection: unknown, launch?: { admittedPiCommand?: string }) => {
    calls.push({ selection, admittedPiCommand: launch?.admittedPiCommand });
    return adapter;
  });
  // Restore this exact spy: stacked spies restored out of order would leak.
  return { calls, restore: () => spy.mock.restore() };
}

async function observedWrite(request: ExecutorRequest, path: string, content: string): Promise<void> {
  request.onToolObservation?.({ stage: "start", toolName: "write", toolInput: { path, content } });
  await writeFile(join(request.cwd, path), content, "utf8");
  request.onToolObservation?.({ stage: "end", toolName: "write", toolInput: { path, content }, result: "written" });
}

function piWorkerConfig(): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    execution: {
      workerResources: { default: { selection: { source: "pi", model: "synthetic/worker" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [{ resourceId: "default" }] },
      retryPolicy: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, jitter: false, maxSameIncidentRepeats: 0 },
    },
    review: {
      primaryReviewers: [],
      subtaskReviewers: [{ source: "pi", model: REVIEWER_MODEL }],
    },
  });
}

async function runWaveLifecycleWith(root: string, admittedPiCommand: string | undefined) {
  const sourceDir = join(root, "source");
  await mkdir(sourceDir);
  await git(["init", "--quiet"], sourceDir);
  await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
  await git(["add", "."], sourceDir);
  await git(["commit", "--quiet", "-m", "init"], sourceDir);
  const waves = join(root, "waves");
  await mkdir(waves);
  const capture = await captureWaveBase({ cwd: sourceDir, maxSnapshotBytes: 1_000_000, waveId: "wave-682", artifactDir: waves });
  const worktree = await createWorkerWorktree(capture, "task-682");
  const { calls, restore } = installExecutorSpy(async (request, turn) => {
    if (turn === 1) await observedWrite(request, "worker-output.txt", "first\n");
    if (turn === 2) await observedWrite(request, "worker-output.txt", "first\nwith detail\n");
    return turn === 1 ? "Implemented." : turn === 2 ? "Corrected." : "Confirmed; nothing further.";
  });
  try {
    const result = await runWaveWorkerLifecycle({
      taskId: "task-682",
      task: { title: "Synthetic admitted Pi task", instructions: "Write worker-output.txt.", acceptanceCriteria: ["file exists"] },
      capture,
      worktree,
      artifactDir: join(capture.waveRoot, "artifacts", "task-682"),
      config: piWorkerConfig(),
      scopedModels: [REVIEWER_MODEL],
      sourceRoot: capture.discovery.captureRoot,
      ...(admittedPiCommand !== undefined ? { admittedPiCommand } : {}),
    });
    return { result, calls, waveRoot: capture.waveRoot };
  } finally {
    restore();
    await removeWorktree(worktree.worktreeRoot, capture.repositoryPath).catch(() => undefined);
  }
}

test("wave lifecycle carries the admitted Pi path to every executor turn and the Pi subtask reviewer without persisting it", { skip: process.platform === "win32" }, async () => {
  await withOwnedRoot("prg-682-wave-", async (root) => {
    const decoyBin = join(root, "decoy-bin");
    const ownedBin = join(root, "owned-bin");
    await mkdir(decoyBin);
    await mkdir(ownedBin);
    const decoyCapture = join(root, "decoy-capture.jsonl");
    const admittedCapture = join(root, "admitted-capture.jsonl");
    await writeExecutable(join(decoyBin, "pi"), reviewerScript(decoyCapture, 0));
    const admitted = join(ownedBin, ADMITTED_FIXTURE_NAME);
    await writeExecutable(admitted, reviewerScript(admittedCapture, 1));

    const { result, calls, waveRoot } = await withPrependedPath(decoyBin, () => runWaveLifecycleWith(root, admitted));

    assert.equal(result.status, "accepted", `${result.status}: ${result.summary} ${result.error ?? ""}`);
    // Initial turn, correction continuation, and pass confirmation all
    // received the same admitted path through the real factory seam.
    assert.ok(calls.length >= 3, `expected initial, correction, and confirmation launches, got ${calls.length}`);
    for (const call of calls) {
      assert.deepEqual(call.selection, { source: "pi", model: "synthetic/worker" });
      assert.equal(call.admittedPiCommand, admitted);
    }
    // Both review cycles launched the admitted reviewer; the ambient pi never ran.
    const reviewerLaunches = await readLines(admittedCapture);
    assert.equal(reviewerLaunches.length, 2);
    for (const launch of reviewerLaunches) {
      assert.equal(launch.argv[launch.argv.indexOf("--model") + 1], REVIEWER_MODEL);
      assert.equal(launch.argv[launch.argv.indexOf("--tools") + 1], "read,grep,find,ls");
    }
    assert.equal((await readLines(decoyCapture)).length, 0);

    // The configured reviewer identity (command "pi") is what was stamped,
    // and the admitted path is not written into any wave artifact or bundle.
    const cycles = result.reviewCycles;
    assert.equal(cycles.length, 2);
    assert.equal(await filesMentioning(waveRoot, admitted).then((hits) => hits.length), 0, "no wave artifact may persist the admitted path");
    assert.deepEqual(await filesMentioning(join(root, "tmp"), admitted), [], "no review bundle may persist the admitted path");
  });
});

test("wave lifecycle without an admitted path keeps the default pi reviewer and an unset executor launch option", { skip: process.platform === "win32" }, async () => {
  await withOwnedRoot("prg-682-wave-default-", async (root) => {
    const decoyBin = join(root, "decoy-bin");
    await mkdir(decoyBin);
    const decoyCapture = join(root, "decoy-capture.jsonl");
    await writeExecutable(join(decoyBin, "pi"), reviewerScript(decoyCapture, 0));

    const { result, calls } = await withPrependedPath(decoyBin, () => runWaveLifecycleWith(root, undefined));

    assert.equal(result.status, "accepted", `${result.status}: ${result.summary} ${result.error ?? ""}`);
    assert.ok(calls.length >= 1);
    for (const call of calls) assert.equal(call.admittedPiCommand, undefined);
    assert.ok((await readLines(decoyCapture)).length >= 1, "the default reviewer still resolves the ambient pi");
  });
});

test("in-place lifecycle carries the admitted Pi path to its executor factory and Pi subtask reviewer", { skip: process.platform === "win32" }, async () => {
  await withOwnedRoot("prg-682-inplace-", async (root) => {
    const workspace = join(root, "workspace");
    const ownedBin = join(root, "owned-bin");
    const decoyBin = join(root, "decoy-bin");
    await mkdir(workspace);
    await mkdir(ownedBin);
    await mkdir(decoyBin);
    await writeFile(join(workspace, "readme.md"), "# hello\n", "utf8");
    // Its own repository: the workspace never inherits an enclosing checkout's ignore rules.
    await git(["init", "--quiet"], workspace);
    const decoyCapture = join(root, "decoy-capture.jsonl");
    const admittedCapture = join(root, "admitted-capture.jsonl");
    await writeExecutable(join(decoyBin, "pi"), reviewerScript(decoyCapture, 0));
    const admitted = join(ownedBin, ADMITTED_FIXTURE_NAME);
    await writeExecutable(admitted, reviewerScript(admittedCapture, 0));

    const launches: Array<string | undefined> = [];
    let turns = 0;
    const adapter: ExecutorAdapter = {
      kind: "pi-model",
      toolEventObservability: { mode: "structured", description: "synthetic structured observations" },
      async run(request) {
        turns += 1;
        if (turns === 1) await observedWrite(request, "inplace-output.txt", "done\n");
        return {
          text: turns === 1 ? "Implemented in place." : "Confirmed; nothing further.",
          session: { adapter: "pi-model", id: "synthetic-inplace-session" },
          stdoutPath: "",
          stderrPath: "",
          code: 0,
          aborted: false,
          timedOut: false,
        };
      },
    };
    const config = piWorkerConfig();
    const entry = resolvedExecutorPool(config)[0];
    assert.ok(entry);

    const result = await withPrependedPath(decoyBin, () => runInplaceLifecycle({
      taskId: "inplace-682",
      task: { title: "Synthetic in-place task", instructions: "Write inplace-output.txt.", acceptanceCriteria: ["file exists"] },
      workspaceRoot: workspace,
      artifactDir: join(root, "artifacts", "inplace-682"),
      config,
      scopedModels: [REVIEWER_MODEL],
      executorAssignment: { entry, priority: 0 },
      admittedPiCommand: admitted,
      adapterFactory: (_config, _selection, launch) => {
        launches.push(launch?.admittedPiCommand);
        return adapter;
      },
    }));

    assert.equal(result.status, "reviewed", `${result.status}: ${result.summary} ${result.error ?? ""}`);
    assert.ok(launches.length >= 1);
    for (const launch of launches) assert.equal(launch, admitted);
    assert.equal((await readLines(admittedCapture)).length, 1, "the in-place Pi subtask reviewer used the admitted path");
    assert.equal((await readLines(decoyCapture)).length, 0);
    assert.deepEqual(await filesMentioning(join(root, "artifacts"), admitted), []);
  });
});

// ── unlaunchable admitted executable: fail closed, path-free records ────────

/** An executable whose interpreter does not exist: spawn fails with ENOENT naming the admitted path. */
async function writeUnspawnable(path: string): Promise<void> {
  await writeExecutable(path, "#!/nonexistent-682/interpreter\n");
}

test("an unlaunchable admitted Pi reviewer fails closed without ambient fallback or a persisted path", { skip: process.platform === "win32" }, async () => {
  await withOwnedRoot("prg-682-reviewer-missing-", async (root) => {
    const decoyBin = join(root, "decoy-bin");
    const ownedBin = join(root, "owned-bin");
    await mkdir(decoyBin);
    await mkdir(ownedBin);
    const decoyCapture = join(root, "decoy-capture.jsonl");
    await writeExecutable(join(decoyBin, "pi"), reviewerScript(decoyCapture, 0));
    for (const variant of ["spawn-error", "missing"] as const) {
      const admitted = join(ownedBin, `${ADMITTED_FIXTURE_NAME}-${variant}`);
      if (variant === "spawn-error") await writeUnspawnable(admitted);
      const caseRoot = join(root, variant);
      await mkdir(caseRoot);
      const { result, waveRoot } = await withPrependedPath(decoyBin, () => runWaveLifecycleWith(caseRoot, admitted));

      assert.notEqual(result.status, "accepted", `${variant}: an unlaunchable reviewer must never accept`);
      assert.notEqual(result.status, "accepted_with_warnings", variant);
      assert.equal((await readLines(decoyCapture)).length, 0, `${variant}: the ambient pi must never run`);
      assert.deepEqual(await filesMentioning(waveRoot, admitted), [], `${variant}: no wave artifact may persist the admitted path`);
      assert.ok(!JSON.stringify(result).includes(admitted), `${variant}: the lifecycle result must not carry the admitted path`);
    }
    assert.deepEqual(await filesMentioning(join(root, "tmp"), ownedBin), [], "no review bundle may persist the admitted path");
  });
});

test("an unlaunchable admitted Pi executor fails closed without ambient fallback or a persisted path", { skip: process.platform === "win32" }, async () => {
  await withOwnedRoot("prg-682-executor-missing-", async (root) => {
    const decoyBin = join(root, "decoy-bin");
    const ownedBin = join(root, "owned-bin");
    await mkdir(decoyBin);
    await mkdir(ownedBin);
    const decoyCapture = join(root, "decoy", "capture.jsonl");
    await mkdir(join(root, "decoy"));
    await writeExecutable(join(decoyBin, "pi"), rpcExecutorScript(decoyCapture));

    for (const variant of ["missing", "spawn-error"] as const) {
      const admitted = join(ownedBin, `${ADMITTED_FIXTURE_NAME}-${variant}`);
      if (variant === "spawn-error") await writeUnspawnable(admitted);
      const caseRoot = join(root, variant);
      const sourceDir = join(caseRoot, "source");
      const waves = join(caseRoot, "waves");
      await mkdir(sourceDir, { recursive: true });
      await mkdir(waves);
      await git(["init", "--quiet"], sourceDir);
      await writeFile(join(sourceDir, "readme.md"), "# hello\n", "utf8");
      await git(["add", "."], sourceDir);
      await git(["commit", "--quiet", "-m", "init"], sourceDir);
      const capture = await captureWaveBase({ cwd: sourceDir, maxSnapshotBytes: 1_000_000, waveId: `wave-682-${variant}`, artifactDir: waves });
      const worktree = await createWorkerWorktree(capture, "task-682");
      try {
        const result = await withPrependedPath(decoyBin, () => runWaveWorker({
          taskId: "task-682",
          task: {
            title: "Synthetic admitted Pi executor task",
            instructions: "Write worker-output.txt.",
            acceptanceCriteria: ["file exists"],
            executorToolCatalog: {
              allowedToolCatalog: ["read", "grep", "find", "ls"],
              initialActiveTools: ["read", "grep", "find", "ls"],
            },
          },
          capture,
          worktree,
          artifactDir: join(capture.waveRoot, "artifacts", "task-682"),
          config: piWorkerConfig(),
          sourceRoot: capture.discovery.captureRoot,
          admittedPiCommand: admitted,
        }));
        assert.notEqual(result.status, "completed", `${variant}: an unlaunchable executor must not complete`);
        assert.ok(!JSON.stringify(result).includes(admitted), `${variant}: the worker result must not carry the admitted path`);
        const operation = await readFile(join(capture.waveRoot, "artifacts", "task-682", "operation.json"), "utf8");
        assert.match(operation, /admitted Pi executable/, `${variant}: the durable incident keeps an actionable, path-free reason`);
        assert.deepEqual(await filesMentioning(capture.waveRoot, admitted), [], `${variant}: no wave artifact may persist the admitted path`);
      } finally {
        await removeWorktree(worktree.worktreeRoot, capture.repositoryPath).catch(() => undefined);
      }
    }
    assert.equal((await readLines(decoyCapture)).length, 0, "the ambient pi must never run");
  });
});

// ── post-spawn child failure: retained diagnostics are redacted ─────────────

test("admitted path redaction covers literal, realpath, URL, and Windows slash forms only for admitted launches", { skip: process.platform === "win32" }, async () => {
  await withOwnedRoot("prg-682-redact-", async (root) => {
    const real = join(root, "pkg", "cli.js");
    await mkdir(join(root, "pkg"));
    await writeExecutable(real, "#!/usr/bin/env node\n");
    const link = join(root, ADMITTED_FIXTURE_NAME);
    await symlink(real, link);
    const text = [
      `at Object.<anonymous> (${real}:3:7)`,
      `link ${link}`,
      `url ${pathToFileURL(real).href}`,
      "marker-682 keeps the rest",
    ].join("\n");
    const redacted = redactAdmittedPiPath(text, link);
    assert.ok(!redacted.includes(real) && !redacted.includes(link) && !redacted.includes("file://"), redacted);
    assert.match(redacted, /marker-682 keeps the rest/);
    assert.equal(redacted.split(ADMITTED_PI_REDACTION).length - 1, 3);
    // Windows forward-slash spelling of a backslash path.
    assert.equal(
      redactAdmittedPiPath("at C:/Pi/cli.js:1 and C:\\Pi\\cli.js", "C:\\Pi\\cli.js", "win32"),
      `at ${ADMITTED_PI_REDACTION}:1 and ${ADMITTED_PI_REDACTION}`,
    );
    // JSON-escaped spellings: a complete JSONL line redacts before parsing and stays valid.
    for (const [command, platform] of [["C:\\Pi\\cli.js", "win32"], [join(root, 'quoted"cli.js'), "linux"]] as const) {
      const line = JSON.stringify({ type: "auto_retry_end", finalError: `failed at ${command}` });
      const parsed = JSON.parse(redactAdmittedPiPath(line, command, platform)) as { finalError: string };
      assert.equal(parsed.finalError, `failed at ${ADMITTED_PI_REDACTION}`);
    }
    // No admitted launch: unchanged.
    assert.equal(redactAdmittedPiPath(text, undefined), text);
    assert.equal(redactAdmittedPiPath(undefined, link), undefined);
  });
});

const POST_SPAWN_MARKER = "post-spawn-failure-marker-682";

/** A valid Node entry that starts, names its own file on stderr, then fails with a startup stack. */
function postSpawnFailureScript(): string {
  return [
    "#!/usr/bin/env node",
    `process.stderr.write(${JSON.stringify(POST_SPAWN_MARKER)} + " in " + __filename + "\\n");`,
    "throw new Error('synthetic startup failure');",
  ].join("\n");
}

/**
 * A started RPC child that names its own file on stderr, then refuses session
 * reopening with an error that also names it (compaction's stderr-bearing path).
 */
function compactionRefusalScript(): string {
  return [
    "#!/usr/bin/env node",
    `process.stderr.write(${JSON.stringify(POST_SPAWN_MARKER)} + " in " + __filename + "\\n");`,
    "let input='';process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',chunk=>{input+=chunk;for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
    "console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:false,error:'synthetic reopen refusal at '+__filename}));}});",
    "process.stdin.on('end',()=>process.exit(0));",
  ].join("\n");
}

test("a started-then-failed admitted Pi child keeps its diagnostic but never its path (reviewer, executor, compaction)", { skip: process.platform === "win32" }, async () => {
  await withOwnedRoot("prg-682-post-spawn-", async (root) => {
    const ownedBin = join(root, "owned-bin");
    const work = join(root, "work");
    await mkdir(ownedBin);
    await mkdir(work);
    const admitted = join(ownedBin, ADMITTED_FIXTURE_NAME);
    await writeExecutable(admitted, postSpawnFailureScript());

    // Reviewer: diagnostic and every reviewer artifact keep the marker, not the path.
    const reviewerBundle = join(root, "reviewer-bundle");
    await mkdir(reviewerBundle);
    const review = await createReviewerAdapter(canonicalPiReviewer(), admitted).run({
      id: "reviewer", cwd: work, prompt: "review", bundleDir: reviewerBundle, timeoutMs: 30_000,
    });
    assert.notEqual(review.verdict, "pass");
    const reviewerStderr = await readFile(join(reviewerBundle, "stderr.txt"), "utf8");
    assert.match(reviewerStderr, new RegExp(POST_SPAWN_MARKER));
    assert.match(reviewerStderr, /synthetic startup failure/);
    assert.ok(!reviewerStderr.includes(admitted), reviewerStderr);
    // The persisted diagnostic is the bounded stderr tail: it keeps the failure
    // and the redacted stack frame, never the entry path.
    assert.match(review.diagnostic ?? "", /synthetic startup failure/, "the reviewer diagnostic keeps the useful failure text");
    assert.ok((review.diagnostic ?? "").includes(ADMITTED_PI_REDACTION), review.diagnostic);
    assert.ok(!JSON.stringify(review).includes(admitted));
    assert.deepEqual(await filesMentioning(reviewerBundle, admitted), []);

    // Reviewer structured stdout error: a terminal JSONL error naming the entry
    // (with a quote, so only its JSON-escaped spelling appears in the stream)
    // is redacted in the persisted diagnostic and raw-stream.jsonl.
    const structuredEntry = join(ownedBin, 'structured"failure');
    await writeExecutable(structuredEntry, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end', () => console.log(JSON.stringify({type:'auto_retry_end',success:false,finalError:'synthetic provider error at '+__filename})));",
    ].join("\n"));
    const structuredBundle = join(root, "structured-reviewer");
    await mkdir(structuredBundle);
    const structuredReview = await createReviewerAdapter(canonicalPiReviewer(), structuredEntry).run({
      id: "structured", cwd: work, prompt: "review", bundleDir: structuredBundle, timeoutMs: 30_000,
    });
    const providerDiagnostic = `synthetic provider error at ${ADMITTED_PI_REDACTION}`;
    assert.equal(structuredReview.diagnostic, providerDiagnostic);
    assert.equal(JSON.parse(await readFile(join(structuredBundle, "raw-stream.jsonl"), "utf8")).finalError, providerDiagnostic);
    assert.ok(!JSON.stringify(structuredReview).includes(ownedBin), "no reviewer result field carries the admitted path");
    assert.deepEqual(await filesMentioning(structuredBundle, structuredEntry), []);
    assert.deepEqual(await filesMentioning(structuredBundle, JSON.stringify(structuredEntry).slice(1, -1)), []);

    // Nested verdict: the same quoted executable passes with a verdict whose
    // summary quotes its path. The verdict JSON text is serialized again inside
    // the JSONL event, so the path appears twice-escaped in the raw stream.
    const nestedDir = join(root, "nested-reviewer");
    const nestedBundle = join(nestedDir, "bundle");
    await mkdir(nestedBundle, { recursive: true });
    await writeExecutable(structuredEntry, reviewerScript(join(nestedDir, "capture.jsonl"), 0, `reviewed ${structuredEntry}`));
    const nestedReview = await createReviewerAdapter(canonicalPiReviewer(), structuredEntry).run({
      id: "nested", cwd: work, prompt: "review", bundleDir: nestedBundle, timeoutMs: 30_000,
    });
    assert.equal(nestedReview.verdict, "pass", nestedReview.error ?? nestedReview.summary);
    assert.equal(nestedReview.summary, `reviewed ${ADMITTED_PI_REDACTION}`);
    const onceEscaped = JSON.stringify(structuredEntry).slice(1, -1);
    const twiceEscaped = JSON.stringify(onceEscaped).slice(1, -1);
    for (const form of [structuredEntry, onceEscaped, twiceEscaped]) {
      assert.ok(!JSON.stringify(nestedReview).includes(form), `the nested verdict result must not carry ${form}`);
      assert.deepEqual(await filesMentioning(nestedBundle, form), [], `no reviewer artifact may retain ${form}`);
    }

    // Executor turn: stderr.txt keeps the marker, not the path.
    const config = normalizeConfig({ enabled: true });
    const executorToolCatalog = { allowedToolCatalog: ["read"], initialActiveTools: ["read"] };
    const adapter = createExecutorAdapter(config, { source: "pi", model: "synthetic/worker" }, { admittedPiCommand: admitted });
    const turnArtifacts = join(root, "executor-artifacts");
    await mkdir(turnArtifacts);
    const turn = await adapter.run({ cwd: work, prompt: "task", artifactDir: turnArtifacts, turn: 1, executorToolCatalog })
      .catch((error: unknown) => ({ thrown: error instanceof Error ? error.message : String(error) }));
    assert.ok(!JSON.stringify(turn).includes(admitted), "the executor turn result must not carry the admitted path");
    const executorStderrFiles = (await filesMentioning(turnArtifacts, POST_SPAWN_MARKER));
    assert.ok(executorStderrFiles.some((file) => file.endsWith("stderr.txt")), `executor stderr artifact keeps the marker: ${executorStderrFiles.join(", ")}`);
    assert.deepEqual(await filesMentioning(turnArtifacts, admitted), []);

    // Compaction recovery: the durable failure message keeps the marker, not the path.
    const compactionEntry = join(ownedBin, `${ADMITTED_FIXTURE_NAME}-compaction`);
    await writeExecutable(compactionEntry, compactionRefusalScript());
    const compactionAdapter = createExecutorAdapter(config, { source: "pi", model: "synthetic/worker" }, { admittedPiCommand: compactionEntry });

    // Ordinary executor turn: a failed RPC response naming the entry is
    // redacted in the turn failure and the retained stdout artifact.
    const rpcArtifacts = join(root, "rpc-refusal-artifacts");
    await mkdir(rpcArtifacts);
    const refused = await compactionAdapter.run({ cwd: work, prompt: "task", artifactDir: rpcArtifacts, turn: 1, executorToolCatalog });
    const rpcDiagnostic = `synthetic reopen refusal at ${ADMITTED_PI_REDACTION}`;
    assert.equal(refused.failure?.message, rpcDiagnostic);
    assert.equal(JSON.parse((await readFile(refused.stdoutPath!, "utf8")).trim()).error, rpcDiagnostic);
    assert.ok(!JSON.stringify(refused).includes(compactionEntry), "the turn result must not carry the admitted path");
    assert.deepEqual(await filesMentioning(rpcArtifacts, ownedBin), []);
    const sessionFile = join(root, "native", "durable-session-682.jsonl");
    await mkdir(join(root, "native"));
    await writeFile(sessionFile, JSON.stringify({ type: "session", version: 3, id: "durable-session-682", cwd: work }) + "\n");
    const compactionArtifacts = join(root, "compaction-artifacts");
    await mkdir(compactionArtifacts);
    const compaction = await compactionAdapter.run({
      cwd: work,
      prompt: "continue",
      artifactDir: compactionArtifacts,
      turn: 2,
      session: { adapter: "pi-model", id: "durable-session-682", file: sessionFile },
      recovery: { kind: "compaction", compactBeforePrompt: true },
      executorToolCatalog,
    }).then(() => undefined, (error: unknown) => error instanceof Error ? error.message : String(error));
    assert.ok(compaction, "a failing compaction child must fail the recovery");
    assert.match(compaction, /synthetic reopen refusal at \[admitted Pi executable\]/, compaction);
    assert.match(compaction, new RegExp(`Stderr: ${POST_SPAWN_MARKER} in \\[admitted Pi executable\\]`), compaction);
    assert.ok(!compaction.includes(ownedBin), compaction);
    assert.deepEqual(await filesMentioning(compactionArtifacts, ownedBin), []);
  });
});
