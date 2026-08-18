import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeCliAdapter } from "../src/adapters/claude-cli";
import { CodexCliAdapter, codexSandboxPreflightArgs } from "../src/adapters/codex-cli";

test("CodexCliAdapter uses the platform-agnostic current sandbox command", () => {
  assert.deepEqual(codexSandboxPreflightArgs(), [
    "sandbox",
    "--permissions-profile",
    ":read-only",
    process.execPath,
    "-e",
    "",
  ]);
});

test("CodexCliAdapter runs with read-only sandbox and review bundle access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-codex-adapter-"));
  try {
    const argvPath = join(dir, "argv.json");
    const commandPath = join(dir, "fake-codex.mjs");
    const reviewJson = JSON.stringify({ verdict: "pass", summary: "codex ok", guidance: null, findings: [], error: null });
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      `const argvPath=${JSON.stringify(argvPath)};`,
      "const history=existsSync(argvPath)?JSON.parse(readFileSync(argvPath,'utf8')):[];",
      "history.push(process.argv.slice(2));writeFileSync(argvPath,JSON.stringify(history));",
      "const args = process.argv.slice(2);",
      "const out = args[args.indexOf('--output-last-message') + 1];",
      `writeFileSync(out, ${JSON.stringify(reviewJson)});`,
      "process.stdin.resume();",
      "process.stdin.on('end',()=>{const events=[",
      "{type:'thread.started',thread_id:'codex-session-1'},",
      "{type:'turn.started'},",
      "{type:'item.started',item:{type:'reasoning'}},",
      "{type:'item.completed',item:{type:'reasoning',text:'private reasoning'}},",
      "{type:'item.completed',item:{type:'agent_message',text:'private reviewer response'}},",
      "{type:'item.started',item:{type:'command_execution',command:'rg TODO',status:'in_progress'}},",
      "{type:'item.completed',item:{type:'command_execution',command:'rg TODO',aggregated_output:'',exit_code:0,status:'completed'}},",
      "{type:'turn.completed',usage:{input_tokens:1,output_tokens:2}}",
      "];process.stdout.write(events.map(JSON.stringify).join('\\n')+'\\n');});",
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new CodexCliAdapter({
      id: "codex",
      adapter: "codex-cli",
      command: commandPath,
      timeoutMs: 15000,
    });

    let session;
    const activity: string[] = [];
    const result = await adapter.run({
      id: "codex",
      cwd: process.cwd(),
      prompt: "review",
      bundleDir: dir,
      timeoutMs: 15000,
      onSession(value) { session = value; },
      onUpdate(message) { activity.push(message); },
    });
    const resumed = await adapter.run({
      id: "codex",
      cwd: process.cwd(),
      prompt: "review correction",
      bundleDir: dir,
      timeoutMs: 15000,
      session,
    });

    const [argv, resumedArgv] = JSON.parse(await readFile(argvPath, "utf8"));
    assert.equal(result.verdict, "pass");
    assert.equal(resumed.verdict, "pass");
    assert.deepEqual(argv.includes("--sandbox"), true);
    assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
    assert.equal(argv.includes("--add-dir"), false);
    assert.deepEqual(argv.includes("--output-schema"), true);
    const outputSchemaPath = argv[argv.indexOf("--output-schema") + 1];
    const outputSchema = JSON.parse(await readFile(outputSchemaPath, "utf8"));
    assert.deepEqual(outputSchema.properties.verdict.enum, ["pass", "needs_changes", "error"]);
    assert.deepEqual(outputSchema.required, ["verdict", "summary", "guidance", "findings", "error"]);
    assert.deepEqual(
      outputSchema.properties.findings.items.required,
      ["severity", "file", "line", "issue", "recommendation"],
    );
    assert.equal(argv.includes("--ephemeral"), false);
    assert.deepEqual(activity, [
      "model turn started",
      "model reasoning",
      "bash · rg TODO",
      "bash completed",
      "model turn completed",
    ]);
    assert.equal(activity.some((message) => message.includes("private")), false);
    assert.deepEqual(resumedArgv.slice(0, 2), ["exec", "resume"]);
    assert.equal(resumedArgv.includes("codex-session-1"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CodexCliAdapter reports a read-only sandbox startup failure explicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-codex-sandbox-error-"));
  try {
    const commandPath = join(dir, "fake-codex.mjs");
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "const args=process.argv.slice(2);",
      "const out=args[args.indexOf('--output-last-message')+1];",
      "writeFileSync(out,JSON.stringify({decision:'blocked',summary:'cannot read',findings:[]}));",
      "process.stderr.write('fs sandbox helper failed: bwrap: loopback: Failed RTM_NEWADDR');",
      "process.stdin.resume();",
      "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'sandbox-session'})+'\\n'));",
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new CodexCliAdapter({
      id: "codex",
      adapter: "codex-cli",
      command: commandPath,
      timeoutMs: 15000,
    });
    const result = await adapter.run({
      id: "codex",
      cwd: process.cwd(),
      prompt: "review",
      evidenceBundleDir: dir,
      bundleDir: dir,
      timeoutMs: 15000,
    });

    assert.equal(result.verdict, "error");
    assert.equal(result.error, "sandbox_unavailable");
    assert.match(result.summary, /read-only filesystem sandbox failed to start/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CodexCliAdapter preflights the platform sandbox before spending a reviewer turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-codex-preflight-"));
  try {
    const commandPath = join(dir, "codex");
    const invocationPath = join(dir, "invocations.txt");
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      `const invocationPath=${JSON.stringify(invocationPath)};`,
      "const count=existsSync(invocationPath)?Number(readFileSync(invocationPath,'utf8')):0;",
      "writeFileSync(invocationPath,String(count+1));",
      "if(process.argv[2]==='sandbox'){process.stderr.write('bwrap: loopback: Failed RTM_NEWADDR');process.exit(1);}",
      "process.exit(9);",
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new CodexCliAdapter({
      id: "codex",
      adapter: "codex-cli",
      command: commandPath,
      timeoutMs: 15000,
    });
    const result = await adapter.run({
      id: "codex",
      cwd: process.cwd(),
      prompt: "review",
      evidenceBundleDir: dir,
      bundleDir: dir,
      timeoutMs: 15000,
    });

    assert.equal(result.error, "sandbox_unavailable");
    assert.equal(await readFile(invocationPath, "utf8"), "1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ClaudeCliAdapter limits reviewers to read-only tools, exposes the bundle, and retains its session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-claude-adapter-"));
  try {
    const argvPath = join(dir, "argv.json");
    const commandPath = join(dir, "fake-claude.mjs");
    const reviewJson = JSON.stringify({ verdict: "pass", summary: "claude ok", guidance: null, findings: [], error: null });
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      `const argvPath=${JSON.stringify(argvPath)};`,
      "const history=existsSync(argvPath)?JSON.parse(readFileSync(argvPath,'utf8')):[];",
      "history.push(process.argv.slice(2));writeFileSync(argvPath,JSON.stringify(history));",
      "process.stdin.resume();",
      `process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'result',result:${JSON.stringify(reviewJson)},usage:{input_tokens:1,output_tokens:2}})));`,
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new ClaudeCliAdapter({
      id: "claude",
      adapter: "claude-cli",
      command: commandPath,
      timeoutMs: 15000,
    });

    let session;
    const result = await adapter.run({
      id: "claude",
      cwd: process.cwd(),
      prompt: "review",
      bundleDir: dir,
      timeoutMs: 15000,
      onSession(value) { session = value; },
    });
    const resumed = await adapter.run({
      id: "claude",
      cwd: process.cwd(),
      prompt: "review correction",
      bundleDir: dir,
      timeoutMs: 15000,
      session,
    });

    const [argv, resumedArgv] = JSON.parse(await readFile(argvPath, "utf8"));
    assert.equal(result.verdict, "pass");
    assert.equal(resumed.verdict, "pass");
    assert.deepEqual(argv.includes("--tools"), true);
    assert.equal(argv[argv.indexOf("--tools") + 1], "Read,Grep,Glob");
    assert.deepEqual(argv.includes("--add-dir"), true);
    assert.equal(argv[argv.indexOf("--add-dir") + 1], dir);
    assert.deepEqual(argv.includes("--append-system-prompt"), true);
    assert.equal(argv.includes("--output-schema"), false);
    assert.equal(argv.includes("--no-session-persistence"), false);
    const sessionId = argv[argv.indexOf("--session-id") + 1];
    assert.equal(typeof sessionId, "string");
    assert.equal(resumedArgv[resumedArgv.indexOf("--resume") + 1], sessionId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
