import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeCliAdapter } from "../src/adapters/claude-cli";
import { CodexCliAdapter } from "../src/adapters/codex-cli";

test("CodexCliAdapter runs with read-only sandbox and review bundle access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-codex-adapter-"));
  try {
    const argvPath = join(dir, "argv.json");
    const commandPath = join(dir, "fake-codex.mjs");
    const reviewJson = JSON.stringify({ verdict: "pass", summary: "codex ok", findings: [] });
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
      "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'codex-session-1'})+'\\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:2}})+'\\n'));",
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new CodexCliAdapter({
      id: "codex",
      adapter: "codex-cli",
      command: commandPath,
      timeoutMs: 5000,
    });

    let session;
    const result = await adapter.run({
      id: "codex",
      cwd: process.cwd(),
      prompt: "review",
      bundleDir: dir,
      timeoutMs: 5000,
      onSession(value) { session = value; },
    });
    const resumed = await adapter.run({
      id: "codex",
      cwd: process.cwd(),
      prompt: "review correction",
      bundleDir: dir,
      timeoutMs: 5000,
      session,
    });

    const [argv, resumedArgv] = JSON.parse(await readFile(argvPath, "utf8"));
    assert.equal(result.verdict, "pass");
    assert.equal(resumed.verdict, "pass");
    assert.deepEqual(argv.includes("--sandbox"), true);
    assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
    assert.deepEqual(argv.includes("--add-dir"), true);
    assert.equal(argv[argv.indexOf("--add-dir") + 1], dir);
    assert.equal(argv.includes("--ephemeral"), false);
    assert.deepEqual(resumedArgv.slice(0, 2), ["exec", "resume"]);
    assert.equal(resumedArgv.includes("codex-session-1"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ClaudeCliAdapter limits reviewers to read-only tools, exposes the bundle, and retains its session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-claude-adapter-"));
  try {
    const argvPath = join(dir, "argv.json");
    const commandPath = join(dir, "fake-claude.mjs");
    const reviewJson = JSON.stringify({ verdict: "pass", summary: "claude ok", findings: [] });
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
      timeoutMs: 5000,
    });

    let session;
    const result = await adapter.run({
      id: "claude",
      cwd: process.cwd(),
      prompt: "review",
      bundleDir: dir,
      timeoutMs: 5000,
      onSession(value) { session = value; },
    });
    const resumed = await adapter.run({
      id: "claude",
      cwd: process.cwd(),
      prompt: "review correction",
      bundleDir: dir,
      timeoutMs: 5000,
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
    assert.equal(argv.includes("--no-session-persistence"), false);
    const sessionId = argv[argv.indexOf("--session-id") + 1];
    assert.equal(typeof sessionId, "string");
    assert.equal(resumedArgv[resumedArgv.indexOf("--resume") + 1], sessionId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
