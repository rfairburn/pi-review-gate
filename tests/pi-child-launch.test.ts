import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { PiModelAdapter } from "../src/adapters/pi-model";
import { runPromptProcess } from "../src/adapters/process";
import { PiExecutorAdapter } from "../src/execution/adapters/pi-model";
import { createPiSettlementBootstrap, piSettlementEnvironment } from "../src/execution/pi-settlement-receipt";
import { EXECUTOR_TOOL_CATALOG_ENV } from "../src/execution/tool-catalog";
import { resolvePiChildSpawn } from "../src/pi-invocation";
import { findInstalledAgentDirs } from "./menu-tui-fakes";

/**
 * Issue #204: Pi child launches (reviewer, delegated Pi RPC executor,
 * compaction recovery) must be alias-independent. On Windows the only PATH
 * entry a spawned child can see is npm's pi.cmd shim (PowerShell aliases are
 * not inherited), and `spawn("pi", { shell: false })` fails with ENOENT. The
 * shared resolver maps the default `pi` to the installed pi.exe or the npm
 * shim's JavaScript entry through this Node binary; POSIX keeps direct
 * execvp, and configured custom commands keep their exact spawn semantics.
 *
 * Every launch regression below starts a REAL child process (the fixture is a
 * platform-appropriate PATH entry: an exact npm cmd-shim shape on native
 * Windows, an executable script elsewhere) — argv capture alone would prove
 * nothing about startup.
 */

/** An npm-generated Windows batch shim shape, as npm's cmd-shim writes it. */
function npmCmdShim(targetRelative: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%'",
    "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & goto :_undefined_#',
    `"%_prog%"  "%dp0%\\${targetRelative}" %*`,
    "",
  ].join("\r\n");
}

interface FakePiFixture {
  root: string;
  bin: string;
  entry: string;
  captureFile: string;
}

/**
 * Create a PATH directory whose only `pi` entry is platform-appropriate:
 * native Windows gets an exact npm cmd-shim shape (the observed real-world
 * layout), every other host gets an executable script. With shimOnly the bin
 * holds ONLY the npm cmd-shim shape on any host — the layout needed to test
 * the Windows resolution logic and the bare-spawn ENOENT reproduction
 * cross-platform (a .cmd file is not an executable PATH entry for a
 * shell:false spawn on any platform). The JS entry records its argv so a
 * test can prove which process actually ran.
 */
async function createFakePiBinIn(root: string, entryBody: string[], options: { shimOnly?: boolean } = {}): Promise<FakePiFixture> {
  const bin = join(root, "bin");
  const entry = join(root, "pkg", "pi-entry.cjs");
  const captureFile = join(root, "capture.jsonl");
  await mkdir(bin, { recursive: true });
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(entry, entryBody.join("\n"), "utf8");
  if (process.platform === "win32" || options.shimOnly) {
    await writeFile(join(bin, "pi.cmd"), npmCmdShim("..\\pkg\\pi-entry.cjs"), "utf8");
  } else {
    const pi = join(bin, "pi");
    await writeFile(pi, `#!/usr/bin/env bash\nexec node "${entry}" "$@"\n`, "utf8");
    await chmod(pi, 0o755);
  }
  return { root, bin, entry, captureFile };
}

async function makeFakePiBin(prefix: string, entryBody: string[], options: { shimOnly?: boolean } = {}): Promise<FakePiFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return createFakePiBinIn(root, entryBody, options);
}

/** Minimal settlement-receipt acknowledgement for fake RPC fixtures. */
const fakePiSettlementReceipt = [
  "const crypto=require('node:crypto');let ackGeneration=0;",
  "const ack=()=>{ackGeneration++;const sessionId=process.env.PI_REVIEW_GATE_SETTLEMENT_SESSION;const childId=process.env.PI_REVIEW_GATE_SETTLEMENT_CHILD;const secret=process.env.PI_REVIEW_GATE_SETTLEMENT_SECRET;const target=process.env.PI_REVIEW_GATE_SETTLEMENT_PATH;const pid=process.pid;const version=2;const oneShot=crypto.createHmac('sha256',secret).update('pi-review-gate-live-browser-settlement-key:v2:'+ackGeneration).digest();const mac=crypto.createHmac('sha256',oneShot).update(JSON.stringify([version,sessionId,childId,ackGeneration,pid])).digest('base64url');const receipt={version,sessionId,childId,settlement:ackGeneration,pid,mac};fs.mkdirSync(require('node:path').dirname(target),{recursive:true,mode:0o700});const temporary=target+'.tmp.'+crypto.randomUUID();fs.writeFileSync(temporary,JSON.stringify(receipt)+'\\n',{mode:0o600});fs.renameSync(temporary,target);};",
];

async function readCaptureLines(captureFile: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(captureFile, "utf8");
  return raw.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Shared resolver: cross-platform unit coverage (resolver/argv safety)
// ---------------------------------------------------------------------------

test("shared Pi child resolver keeps custom commands and POSIX default pi exactly as configured", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
  // Custom commands are never rewritten, on any platform.
  assert.deepEqual(resolvePiChildSpawn("/opt/custom/pi", ["--model", "m"], env, "win32"),
    { ok: true, file: "/opt/custom/pi", args: ["--model", "m"] });
  assert.deepEqual(resolvePiChildSpawn("C:\\tools\\pi.exe", ["--model", "m"], env, "win32"),
    { ok: true, file: "C:\\tools\\pi.exe", args: ["--model", "m"] });
  // POSIX default pi stays a plain execvp of the PATH entry.
  for (const platform of ["linux", "darwin"] as const) {
    assert.deepEqual(resolvePiChildSpawn("pi", ["--model", "m"], env, platform),
      { ok: true, file: "pi", args: ["--model", "m"] });
  }
});

test("shared Pi child resolver maps the Windows npm shim to the Node entry without touching argv", async () => {
  const fixture = await makeFakePiBin("prg-child-resolve-shim-", [
    "process.exit(0);",
  ], { shimOnly: true });
  try {
    const env: NodeJS.ProcessEnv = { PATH: fixture.bin };
    // Nasty argv must survive byte-exact with only the entry prepended — no
    // shell is ever involved, so nothing can reparse it.
    const nasty = ["--model", "a b\"c & d | e ^f (g)", "--label", '"a&b|c^d"'];
    const resolved = resolvePiChildSpawn("pi", nasty, env, "win32");
    assert.ok(resolved.ok, `expected the npm shim to resolve, got ${JSON.stringify(resolved)}`);
    if (!resolved.ok) return;
    assert.equal(resolved.file, process.execPath, "the shim entry must run through this Node binary");
    assert.deepEqual(resolved.args, [fixture.entry, ...nasty], "argv must be the entry plus the untouched original arguments");
    assert.deepEqual(nasty, ["--model", "a b\"c & d | e ^f (g)", "--label", '"a&b|c^d"'], "the caller's argv array must not be mutated");
    // Windows environment variable names are case-insensitive and Node
    // preserves the original key casing (commonly `Path`); the resolver must
    // find an installed Pi when only that spelling is present.
    assert.deepEqual(resolvePiChildSpawn("pi", nasty, { Path: fixture.bin }, "win32"), resolved,
      "a Path-only Windows environment must resolve identically to a PATH one");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("shared Pi child resolver prefers an installed pi.exe over the npm shim on Windows", async () => {
  const fixture = await makeFakePiBin("prg-child-resolve-exe-", ["process.exit(0);"], { shimOnly: true });
  try {
    const exe = join(fixture.bin, "pi.exe");
    await writeFile(exe, "not a real exe; presence is enough for resolution\n", "utf8");
    const resolved = resolvePiChildSpawn("pi", ["--model", "m"], { PATH: fixture.bin }, "win32");
    assert.ok(resolved.ok, `expected pi.exe to win, got ${JSON.stringify(resolved)}`);
    if (!resolved.ok) return;
    assert.equal(resolved.file, exe, "the installed pi.exe must be spawned directly");
    assert.deepEqual(resolved.args, ["--model", "m"]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("shared Pi child resolver fails closed for a missing or unresolvable default pi", async () => {
  const fixture = await makeFakePiBin("prg-child-resolve-fail-", ["process.exit(0);"], { shimOnly: true });
  try {
    // Missing: no pi entry at all in the searched PATH.
    const empty = join(fixture.root, "empty");
    await mkdir(empty, { recursive: true });
    const missing = resolvePiChildSpawn("pi", [], { PATH: empty }, "win32");
    assert.ok(!missing.ok && missing.kind === "missing");
    if (!missing.ok) {
      assert.match(missing.error, /not found on PATH/);
      assert.match(missing.error, /npm install -g @earendil-works\/pi/);
    }
    // Unresolvable: a shim whose target cannot be determined must not fall
    // back to a shell reparse.
    await writeFile(join(fixture.bin, "pi.cmd"), "@echo off\r\nrem opaque\r\n", "utf8");
    const unresolved = resolvePiChildSpawn("pi", [], { PATH: fixture.bin }, "win32");
    assert.ok(!unresolved.ok && unresolved.kind === "unresolved");
    if (!unresolved.ok) {
      assert.match(unresolved.error, /npm shim at .*pi\.cmd/);
      assert.match(unresolved.error, /reinstall Pi/);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The observed failure and its correction: real child launch, not argv alone
// ---------------------------------------------------------------------------

test("bare shell:false spawn of pi fails while only the npm shim exists; the resolved launch starts a real child", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-child-enoent-"));
  const captureFile = join(root, "capture.jsonl");
  // shimOnly: the bin holds ONLY pi.cmd on every host, so a shell:false spawn
  // of the bare name finds no executable (the observed Windows failure).
  const fixture = await createFakePiBinIn(root, [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }));`,
    "process.exit(0);",
  ], { shimOnly: true });
  try {
    // The pre-#204 launch shape: with only an npm shim on PATH, a shell:false
    // spawn of the bare name cannot find an executable. On native Windows this
    // is exactly the observed ENOENT; on POSIX hosts a .cmd file is likewise
    // not an executable PATH entry, so the reproduction holds everywhere.
    const bare = spawnSync("pi", ["--probe"], { env: { PATH: fixture.bin }, shell: false });
    assert.equal(bare.status, null);
    assert.equal((bare.error as NodeJS.ErrnoException | undefined)?.code, "ENOENT");

    // The corrected launch: resolve, then spawn the resolved file/argv pair.
    const spec = resolvePiChildSpawn("pi", ["--probe"], { PATH: fixture.bin }, "win32");
    assert.ok(spec.ok, `the shim must resolve for the corrected launch, got ${JSON.stringify(spec)}`);
    if (!spec.ok) return;
    const exitCode = await new Promise<number | null>((done) => {
      const child = spawn(spec.file, spec.args, { env: { PATH: fixture.bin }, shell: false });
      child.on("error", () => done(null));
      child.on("close", (code) => done(code));
    });
    assert.equal(exitCode, 0, "the resolved launch must start a real child that exits cleanly");
    const [captured] = await readCaptureLines(fixture.captureFile);
    assert.deepEqual(captured.argv, ["--probe"], "the real child must receive the exact original argv");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Shared-seam boundary and missing-CLI diagnostics
// ---------------------------------------------------------------------------

test("runPromptProcess keeps non-Pi callers' configured command semantics even for a command named pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-child-nonpi-"));
  try {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    // Only an npm-shim-shaped entry: not executable for a shell:false spawn on
    // any platform. Non-Pi adapters (generic-cli, run-as-binary, claude-cli,
    // codex-cli) do not opt into resolution, so their configured command must
    // keep the exact pre-#204 spawn behavior — including its raw failure.
    await writeFile(join(bin, "pi.cmd"), npmCmdShim("..\\pkg\\pi-entry.cjs"), "utf8");
    const error = await runPromptProcess({
      command: "pi",
      args: ["--probe"],
      cwd: root,
      prompt: "p",
      timeoutMs: 10_000,
      env: { PATH: bin },
    }).then(() => null, (thrown: unknown) => thrown);
    assert.ok(error instanceof Error, `expected the raw spawn failure, got ${String(error)}`);
    assert.equal((error as NodeJS.ErrnoException).code, "ENOENT", "non-Pi callers must keep the raw configured-command spawn error");
    assert.doesNotMatch(error.message, /install Pi \(npm install -g/,
      "the missing-CLI translation must not apply to non-Pi callers' configured commands");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Reviewer child startup regression (real shim + child process)
// ---------------------------------------------------------------------------

const REVIEW_JSON_TEXT = JSON.stringify({
  verdict: "pass",
  summary: "clean",
  guidance: null,
  findings: [],
  error: null,
});

function reviewerEntryBody(captureFile: string): string[] {
  return [
    "const fs=require('node:fs');",
    "let input='';process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',chunk=>{input+=chunk;});",
    "process.stdin.on('end',()=>{",
    `fs.writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ argv: process.argv.slice(2), promptBytes: Buffer.byteLength(input) }));`,
    "console.log(JSON.stringify({type:'turn_start'}));",
    `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:${JSON.stringify(REVIEW_JSON_TEXT)}}]}}));`,
    "console.log(JSON.stringify({type:'turn_end'}));",
    "process.exit(0);",
    "});",
  ];
}

test("Pi reviewer launches the default pi child alias-independently (real shim + child process)", async () => {
  // The capture path must exist before the entry body is generated, so the
  // fixture root is created here rather than inside makeFakePiBin.
  const root = await mkdtemp(join(tmpdir(), "prg-child-reviewer-"));
  const fixture = await createFakePiBinIn(root, reviewerEntryBody(join(root, "capture.jsonl")));
  try {
    const bundleDir = join(fixture.root, "bundle");
    await mkdir(bundleDir, { recursive: true });
    const adapter = new PiModelAdapter({
      id: "pi-reviewer",
      adapter: "pi-model",
      model: "provider/model",
      env: { PATH: `${fixture.bin}${delimiter}${process.env.PATH ?? ""}` },
    });
    const result = await adapter.run({
      id: "reviewer-1",
      cwd: fixture.root,
      prompt: "review this change",
      bundleDir,
      timeoutMs: 30_000,
    });
    assert.equal(result.verdict, "pass", `the reviewer child must have launched and produced a result: ${result.error ?? ""} ${result.summary}`);
    const captured = JSON.parse(await readFile(fixture.captureFile, "utf8")) as { argv: string[]; promptBytes: number };
    // The child is the fake pi from the PATH fixture — on native Windows that
    // means the npm shim resolved to its JS entry and a real process ran.
    assert.ok(captured.promptBytes > 0, "the reviewer prompt must reach the launched child");
    const argv = captured.argv;
    assert.deepEqual(argv.slice(0, 3), ["--model", "provider/model", "--mode"], "reviewer argv order is preserved through resolution");
    assert.equal(argv[argv.indexOf("--mode") + 1], "json");
    // Reviewer read-only flags stay exactly as configured.
    assert.ok(argv.includes("--no-extensions"));
    assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls");
    assert.ok(!argv.includes("--extension"), "the reviewer keeps no implicit extension");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi reviewer translates a missing default pi CLI into the actionable diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-child-reviewer-missing-"));
  try {
    const emptyBin = join(root, "empty-bin");
    await mkdir(emptyBin, { recursive: true });
    const bundleDir = join(root, "bundle");
    await mkdir(bundleDir, { recursive: true });
    // Default command (no configured command) with a PATH that holds no pi:
    // the POSIX direct spawn fails ENOENT and must surface as the actionable
    // missing-CLI diagnostic rather than the raw spawn error.
    const adapter = new PiModelAdapter({
      id: "pi-reviewer",
      adapter: "pi-model",
      model: "provider/model",
      env: { PATH: emptyBin },
    });
    await assert.rejects(
      adapter.run({ id: "reviewer-missing", cwd: root, prompt: "review this", bundleDir, timeoutMs: 10_000 }),
      (error: unknown) => error instanceof Error
        && /not found on PATH/.test(error.message)
        && /npm install -g @earendil-works\/pi/.test(error.message),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Delegated Pi RPC executor + compaction recovery launch regressions
// ---------------------------------------------------------------------------

function rpcEntryBody(captureFile: string): string[] {
  return [
    "const fs=require('node:fs');",
    ...fakePiSettlementReceipt,
    `fs.appendFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid })+'\\n');`,
    "let input='';process.stdin.setEncoding('utf8');",
    "const out=(v)=>console.log(JSON.stringify(v));",
    "const sessionId=process.argv[process.argv.indexOf('--session-id')+1];",
    "process.stdin.on('data',chunk=>{input+=chunk; for(;;){const n=input.indexOf('\\n');if(n<0)break;const raw=input.slice(0,n);input=input.slice(n+1);if(!raw)continue;const c=JSON.parse(raw);",
    "if(c.type==='prompt'){out({type:'response',id:c.id,command:'prompt',success:true});out({type:'turn_start'});out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'research complete'}]}});out({type:'turn_end'});ack();out({type:'agent_end'});}",
    "else if(c.type==='get_state')out({type:'response',id:c.id,command:c.type,success:true,data:{sessionId,isStreaming:false,pendingMessageCount:0}});",
    "else if(c.type==='compact')out({type:'response',id:c.id,command:c.type,success:true,data:{summary:'compacted'}});",
    "else if(c.type==='get_last_assistant_text')out({type:'response',id:c.id,command:c.type,success:true,data:{text:'research complete'}});",
    "}});",
    "process.stdin.on('end',()=>process.exit(0));",
  ];
}

const executorToolCatalog = {
  allowedToolCatalog: ["read", "grep", "find", "ls"],
  initialActiveTools: ["read", "grep", "find", "ls"],
};

/** Prepend the fixture bin to PATH for the duration of a run (restored after). */
function withPrependedPath(bin: string, fn: () => Promise<void>): Promise<void> {
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous ?? ""}`;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    });
}

test("delegated Pi RPC executor launches the default pi child alias-independently", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-child-rpc-"));
  const fixture = await createFakePiBinIn(root, rpcEntryBody(join(root, "capture.jsonl")));
  try {
    const artifactDir = join(fixture.root, "artifacts");
    await mkdir(artifactDir);
    await withPrependedPath(fixture.bin, async () => {
      const adapter = new PiExecutorAdapter({ model: "provider/model", timeoutMs: 60_000, settlementTimeoutMs: 15_000 });
      const result = await adapter.run({
        cwd: fixture.root,
        prompt: "research task",
        artifactDir,
        turn: 1,
        executorToolCatalog,
      });
      assert.equal(result.text, "research complete", `the RPC executor child must have launched and settled: ${result.failure?.message ?? ""}`);
      assert.equal(result.failure, undefined);
    });
    const launches = await readCaptureLines(fixture.captureFile);
    assert.equal(launches.length, 1, "exactly one real executor child must have been launched");
    const argv = launches[0].argv as string[];
    assert.equal(argv[argv.indexOf("--mode") + 1], "rpc");
    // The worker keeps its explicit absolute extension path and native
    // --tools allowlist, and no --no-extensions is added: normal third-party
    // extension discovery stays available to the worker.
    const extension = argv[argv.indexOf("--extension") + 1];
    assert.ok(extension.endsWith("index.js"), `the review-gate extension must load in the child, got ${extension}`);
    assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls,search_tools");
    assert.ok(!argv.includes("--no-extensions"), "the worker must not suppress discovered extensions");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** Replace PATH for the duration of a run (restored after). */
function withReplacedPath(dir: string, fn: () => Promise<void>): Promise<void> {
  const previous = process.env.PATH;
  process.env.PATH = dir;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    });
}

test("delegated Pi RPC executor translates a missing default pi CLI into the actionable diagnostic", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-child-rpc-missing-"));
  try {
    const emptyBin = join(root, "empty-bin");
    const artifactDir = join(root, "artifacts");
    await mkdir(emptyBin, { recursive: true });
    await mkdir(artifactDir);
    await withReplacedPath(emptyBin, async () => {
      const adapter = new PiExecutorAdapter({ model: "provider/model", timeoutMs: 30_000, settlementTimeoutMs: 5_000 });
      const message = await adapter.run({
        cwd: root,
        prompt: "research task",
        artifactDir,
        turn: 1,
        executorToolCatalog,
      }).then((result) => {
        assert.equal(result.code, 1, "a missing default pi CLI must fail the turn");
        assert.ok(result.failure, "the failure must be reported, not swallowed");
        return result.failure.message;
      }, (error: unknown) => {
        // Windows resolves the default CLI before spawn, so it fails during
        // adapter initialization; POSIX detects a missing executable on spawn.
        assert.equal(process.platform, "win32");
        return error instanceof Error ? error.message : String(error);
      });
      assert.match(message, /not found on PATH/);
      assert.match(message, /npm install -g @earendil-works\/pi/);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executor compaction recovery launches the default pi child through the same resolver", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-child-compact-"));
  const fixture = await createFakePiBinIn(root, rpcEntryBody(join(root, "capture.jsonl")));
  try {
    const artifactDir = join(fixture.root, "artifacts");
    await mkdir(artifactDir);
    await withPrependedPath(fixture.bin, async () => {
      const adapter = new PiExecutorAdapter({ model: "provider/model", timeoutMs: 60_000, settlementTimeoutMs: 15_000 });
      const result = await adapter.run({
        cwd: fixture.root,
        prompt: "continue after compaction",
        artifactDir,
        turn: 2,
        session: { adapter: "pi-model", id: "durable-session-1" },
        recovery: { kind: "compaction", compactBeforePrompt: true },
        executorToolCatalog,
      });
      assert.equal(result.text, "research complete", `the compaction-recovered turn must have completed: ${result.failure?.message ?? ""}`);
      assert.equal(result.failure, undefined);
    });
    // Two real children: the compaction recovery child (get_state + compact)
    // and the resumed RPC executor child — both launched through the shared
    // alias-independent resolution.
    const launches = await readCaptureLines(fixture.captureFile);
    assert.equal(launches.length, 2, "compaction recovery must launch its own real child before the resumed turn");
    for (const launch of launches) {
      const argv = launch.argv as string[];
      assert.equal(argv[argv.indexOf("--session-id") + 1], "durable-session-1", "both children reopen the durable session");
      assert.equal(argv[argv.indexOf("--mode") + 1], "rpc");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Bounded real-Pi RPC registration check (installed Pi; no provider/model call)
// ---------------------------------------------------------------------------

const ZERO_MODEL_DEFAULT_CONFIG = `{
  "enabled": true,
  "review": {
    "activeReviewers": []
  },
  "externalAgents": {},
  "execution": {
    "workerResources": {},
    "routes": {
      "execute": [],
      "research": []
    }
  }
}
`;

/** Disposable third-party probe extension: one tool + one command. */
function probeExtensionSource(): string {
  return [
    "'use strict';",
    "const fs = require('node:fs');",
    "module.exports = function (pi) {",
    "  pi.registerTool({",
    '    name: "prg-probe-tool",',
    '    label: "PRG probe tool",',
    '    description: "Disposable third-party probe tool for registration checks.",',
    "    parameters: { type: 'object', additionalProperties: false, properties: {} },",
    "    execute: async () => ({ content: [{ type: 'text', text: 'probe executed' }] }),",
    "  });",
    '  pi.registerCommand("prg-probe", {',
    '    description: "Write the live tool inventories to the probe result file.",',
    "    handler: async () => {",
    // Only verified host APIs are read from the live extension instance:
    // getActiveTools for the gate-curated active set and getAllTools for the
    // full registered inventory (the candidate extension itself uses
    // getAllTools). Command registration is asserted from the RPC
    // get_commands response, not from an optional host API.
    "      fs.writeFileSync(process.env.PRG_PROBE_RESULT, JSON.stringify({ activeTools: pi.getActiveTools(), registeredTools: pi.getAllTools().map((tool) => tool.name) }));",
    "    },",
    "  });",
    "};",
    "module.exports.default = module.exports;",
  ].join("\n");
}

interface RpcExchange {
  child: ChildProcess;
  request: (type: string, fields?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  lines: string[];
  close: () => Promise<void>;
}

/** Minimal JSON-over-stdio RPC driver for a real pi --mode rpc process. */
function drivePiRpc(child: ChildProcess): RpcExchange {
  let nextId = 1;
  let buffer = "";
  const pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  const lines: string[] = [];
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const raw = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!raw) continue;
      lines.push(raw);
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type === "response" && typeof event.id === "string") {
        const waiter = pending.get(event.id);
        if (!waiter) continue;
        pending.delete(event.id);
        if (event.success === true) waiter.resolve(event);
        else waiter.reject(new Error(typeof event.error === "string" ? event.error : JSON.stringify(event.error ?? {})));
      }
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    lines.push(`[stderr] ${chunk}`);
  });
  return {
    child,
    lines,
    request: (type, fields = {}) => new Promise((resolvePromise, reject) => {
      const id = `prg-probe-${nextId++}`;
      pending.set(id, { resolve: resolvePromise, reject });
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC ${type} timed out`));
      }, 30_000);
      timer.unref?.();
      child.stdin?.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    }),
    close: async () => {
      // A child that already exited will never emit another close event;
      // waiting for one unconditionally would stall cleanup.
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.stdin?.end();
      } catch {
        // already closed
      }
      await new Promise<void>((done) => {
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // already gone
          }
          // Bounded: settle cleanup even if no close event ever arrives.
          done();
        }, 10_000);
        timer.unref?.();
        child.once("close", () => {
          clearTimeout(timer);
          done();
        });
      });
    },
  };
}

test("real Pi RPC registers the candidate extension alongside a third-party extension (no provider call)", async (t) => {
  // Prerequisites: an installed pi-coding-agent CLI and a built candidate
  // extension entry. Skip-or-fail mirrors the other real-host tests; CI's
  // full suite sets PI_REVIEW_GATE_REQUIRE_PI_HOST=1, pins the agent, and
  // exports PI_REVIEW_GATE_CANDIDATE_ENTRY, so this genuinely runs there.
  const cliEntry = findInstalledAgentDirs()
    .map((agentDir) => join(agentDir, "dist", "bundle", "cli.js"))
    .find((candidate) => existsSync(candidate));
  const candidateEntry = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY ?? resolve("dist/src/index.js");
  if (!cliEntry || !existsSync(candidateEntry)) {
    const missing: string[] = [];
    if (!cliEntry) missing.push("installed pi-coding-agent (dist/bundle/cli.js; PI_REVIEW_GATE_INSTALLED_AGENT or ambient install)");
    if (!existsSync(candidateEntry)) missing.push(`built candidate entry (${candidateEntry})`);
    if (process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST === "1") {
      throw new Error(`required Pi host unavailable: ${missing.join(", ")}`);
    }
    t.skip(`real-Pi registration check prerequisites unavailable: ${missing.join(", ")}`);
    return;
  }

  const sandbox = await mkdtemp(join(tmpdir(), "prg-rpc-registration-"));
  const home = join(sandbox, "home");
  const agentDir = join(sandbox, "agent");
  const sessionsDir = join(sandbox, "sessions");
  const probePath = join(sandbox, "probe.cjs");
  const probeResult = join(sandbox, "probe-result.json");
  // The suite may itself run inside a review-gate worker (e.g. a delegated
  // executor sets PI_REVIEW_GATE_RUNTIME_ROLE=executor and points
  // PI_REVIEW_GATE_CONFIG at the host's real config). Stripping every
  // PI_REVIEW_GATE_* variable keeps the disposable session in the default
  // top-level role against the disposable agent dir.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("PI_REVIEW_GATE_")) delete childEnv[key];
  }
  await mkdir(home, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  // The zero-model default the launcher writes on first launch: no reviewers,
  // no workers, and — critically — no configured model or provider auth.
  await writeFile(join(agentDir, "review-gate.json"), ZERO_MODEL_DEFAULT_CONFIG, "utf8");
  await writeFile(probePath, probeExtensionSource(), "utf8");

  const child = spawn(process.execPath, [
    cliEntry,
    "--mode", "rpc",
    "--session-dir", sessionsDir,
    "--extension", candidateEntry,
    "--extension", probePath,
  ], {
    cwd: sandbox,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...childEnv,
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentDir,
      PRG_PROBE_RESULT: probeResult,
    },
  });
  const rpc = drivePiRpc(child);
  t.after(async () => {
    await rpc.close();
    await rm(sandbox, { recursive: true, force: true });
  });

  let startupFailure: string | undefined;
  child.once("error", (error) => {
    startupFailure = `pi failed to start: ${error.message}`;
  });
  child.once("close", (code, signal) => {
    if (code !== null && code !== 0 && !startupFailure) {
      startupFailure = `pi exited early with status ${code ?? signal}:\n${rpc.lines.slice(-20).join("\n")}`;
    }
  });

  try {
    // get_state proves the session is live. No model is configured, so no
    // provider call can occur; nothing below sends a plain prompt.
    const state = await rpc.request("get_state", {});
    assert.equal(state.success, true, startupFailure ?? "get_state failed");

    // Runtime registration proof (not argv): both extensions' commands must be
    // discoverable through the live session.
    const commandsResponse = await rpc.request("get_commands", {});
    assert.equal(commandsResponse.success, true, startupFailure ?? "get_commands failed");
    const commandData = isRecord(commandsResponse.data) ? commandsResponse.data : {};
    const commandNames = Array.isArray(commandData.commands)
      ? (commandData.commands as Array<Record<string, unknown>>).map((command) => String(command.name))
      : [];
    assert.ok(commandNames.includes("review-gate-ping"),
      `the candidate extension's commands must be registered at runtime; got: ${commandNames.join(", ") || "(none)"}`);
    assert.ok(commandNames.includes("prg-probe"),
      `the third-party probe command must be registered alongside the candidate's; got: ${commandNames.join(", ") || "(none)"}`);

    // Extension commands execute immediately without a model turn; the handler
    // only writes a file, so this stays provider-free.
    const promptResponse = await rpc.request("prompt", { message: "/prg-probe" });
    assert.equal(promptResponse.success, true, startupFailure ?? "probe command prompt was rejected");

    const deadline = Date.now() + 15_000;
    while (!existsSync(probeResult) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.ok(existsSync(probeResult), `the probe command never ran (no provider call was made): ${startupFailure ?? ""}\n${rpc.lines.slice(-20).join("\n")}`);
    const probe = JSON.parse(await readFile(probeResult, "utf8")) as { activeTools: string[]; registeredTools: string[] };
    assert.ok(Array.isArray(probe.activeTools), "getActiveTools must report a tool list");
    assert.ok(probe.activeTools.includes("ApplyPatch"),
      `the candidate extension's ApplyPatch tool must be registered and active at runtime; got: ${probe.activeTools.join(", ") || "(none)"}`);
    // Tool registration is asserted from the live registered inventory, not
    // from argv or the command list: a command registering without its tool
    // would still fail here.
    assert.ok(Array.isArray(probe.registeredTools) && probe.registeredTools.includes("prg-probe-tool"),
      `the third-party tool must be registered at runtime; got: ${probe.registeredTools?.join(", ") || "(none)"}`);
    // Command registration was already proven above from the RPC get_commands
    // response. The probe command executed from the live session, which only a
    // loaded and activated third-party extension can do — that is its
    // registration proof. Its tool need not be in the gate-managed active set:
    // under the default operating-mode policy the review gate curates active
    // tools to its own inventory, so activation of a foreign tool is
    // configuration-dependent and is deliberately not asserted here.
  } finally {
    // The session is disposable; terminate it without waiting for shutdown.
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
});

test("real Pi RPC executor registers this build and authorized discovered third-party tools (no provider call)", async (t) => {
  const cliEntry = findInstalledAgentDirs()
    .map((agentDir) => join(agentDir, "dist", "bundle", "cli.js"))
    .find((candidate) => existsSync(candidate));
  const candidateEntry = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY ?? resolve("dist/src/index.js");
  if (!cliEntry || !existsSync(candidateEntry)) {
    const missing = [!cliEntry && "installed Pi CLI", !existsSync(candidateEntry) && "built candidate extension"].filter(Boolean);
    if (process.env.PI_REVIEW_GATE_REQUIRE_PI_HOST === "1") throw new Error(`required Pi host unavailable: ${missing.join(", ")}`);
    t.skip(`real-Pi executor registration prerequisites unavailable: ${missing.join(", ")}`);
    return;
  }

  const sandbox = await mkdtemp(join(tmpdir(), "prg-rpc-executor-registration-"));
  const home = join(sandbox, "home");
  const agentDir = join(sandbox, "agent");
  const sessionsDir = join(sandbox, "sessions");
  const thirdPartyDir = join(agentDir, "extensions");
  const probeResult = join(sandbox, "probe-result.json");
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("PI_REVIEW_GATE_")) delete childEnv[key];
  }
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(thirdPartyDir, { recursive: true }),
  ]);
  await writeFile(join(agentDir, "review-gate.json"), ZERO_MODEL_DEFAULT_CONFIG, "utf8");
  // This fixture is discovered from Pi's agent directory, not passed with a
  // second --extension flag: the worker must retain third-party discovery.
  await writeFile(join(thirdPartyDir, "prg-probe.js"), probeExtensionSource(), "utf8");
  const catalog = {
    allowedToolCatalog: ["read", "ApplyPatch", "prg-probe-tool"],
    initialActiveTools: ["read", "ApplyPatch", "prg-probe-tool"],
  };
  const bootstrap = createPiSettlementBootstrap(sandbox, "executor-registration-test");
  const child = spawn(process.execPath, [
    cliEntry,
    "--mode", "rpc",
    "--session-id", bootstrap.sessionId,
    "--session-dir", sessionsDir,
    "--extension", candidateEntry,
    "--tools", "read,ApplyPatch,prg-probe-tool,search_tools",
  ], {
    cwd: sandbox,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...childEnv,
      ...piSettlementEnvironment(bootstrap),
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentDir,
      PI_REVIEW_GATE_RUNTIME_ROLE: "executor",
      [EXECUTOR_TOOL_CATALOG_ENV]: JSON.stringify(catalog),
      PRG_PROBE_RESULT: probeResult,
    },
  });
  const rpc = drivePiRpc(child);
  t.after(async () => {
    await rpc.close();
    await rm(sandbox, { recursive: true, force: true });
  });
  let startupFailure: string | undefined;
  child.once("error", (error) => { startupFailure = `pi failed to start: ${error.message}`; });
  child.once("close", (code, signal) => {
    if (code !== null && code !== 0 && !startupFailure) {
      startupFailure = `pi exited early with status ${code ?? signal}:\n${rpc.lines.slice(-20).join("\n")}`;
    }
  });

  try {
    const state = await rpc.request("get_state");
    assert.equal(state.success, true, startupFailure ?? "get_state failed");
    const commandsResponse = await rpc.request("get_commands");
    const commandData = isRecord(commandsResponse.data) ? commandsResponse.data : {};
    const commandNames = Array.isArray(commandData.commands)
      ? (commandData.commands as Array<Record<string, unknown>>).map((command) => String(command.name))
      : [];
    assert.ok(commandNames.includes("prg-probe"),
      `a discovered third-party extension must load in the executor: ${commandNames.join(", ") || "(none)"}`);
    assert.ok(!commandNames.includes("review-gate-ping"), "the child must run in executor role, not the top-level role");
    const promptResponse = await rpc.request("prompt", { message: "/prg-probe" });
    assert.equal(promptResponse.success, true, startupFailure ?? "probe command prompt was rejected");
    const deadline = Date.now() + 15_000;
    while (!existsSync(probeResult) && Date.now() < deadline) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    assert.ok(existsSync(probeResult), `executor probe command never ran: ${startupFailure ?? ""}\n${rpc.lines.slice(-20).join("\n")}`);
    const probe = JSON.parse(await readFile(probeResult, "utf8")) as { activeTools: string[]; registeredTools: string[] };
    for (const name of ["ApplyPatch", "prg-probe-tool", "search_tools"]) {
      assert.ok(probe.activeTools.includes(name),
        `authorized executor tool ${name} must be active; got ${probe.activeTools.join(", ") || "(none)"}`);
      assert.ok(probe.registeredTools.includes(name),
        `executor tool ${name} must be registered; got ${probe.registeredTools.join(", ") || "(none)"}`);
    }
  } finally {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
