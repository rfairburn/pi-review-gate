import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LittleCoderAdapter } from "../src/adapters/little-coder";

test("LittleCoderAdapter disables tools and reports missing final assistant text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-little-coder-adapter-"));
  try {
    const argvPath = join(dir, "argv.json");
    const commandPath = join(dir, "fake-little-coder.mjs");
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      `const argvPath=${JSON.stringify(argvPath)};`,
      "const history=existsSync(argvPath)?JSON.parse(readFileSync(argvPath,'utf8')):[];",
      "history.push({argv:process.argv.slice(2),budget:process.env.LITTLE_CODER_THINKING_BUDGET});writeFileSync(argvPath,JSON.stringify(history));",
      "process.stdin.resume();",
      "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'message',message:{role:'assistant',content:[{type:'thinking',thinking:'still thinking'}]}})+'\\n'));",
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new LittleCoderAdapter({
      id: "glm",
      adapter: "little-coder-model",
      model: "ollama/glm-5.2",
      thinkingLevel: "max",
      command: commandPath,
      timeoutMs: 15000,
    });

    let session;
    const result = await adapter.run({
      id: "glm",
      cwd: process.cwd(),
      prompt: "review",
      bundleDir: dir,
      timeoutMs: 15000,
      onSession(value) { session = value; },
    });
    await adapter.run({
      id: "glm",
      cwd: process.cwd(),
      prompt: "review correction",
      bundleDir: dir,
      timeoutMs: 15000,
      session,
    });

    assert.equal(result.verdict, "error");
    assert.equal(result.error, "missing_final_text");
    assert.equal(result.summary, "Reviewer did not produce final assistant text.");
    const [firstRun, resumedRun] = JSON.parse(await readFile(argvPath, "utf8"));
    const argv = firstRun.argv;
    const resumedArgv = resumedRun.argv;
    assert.deepEqual(argv.includes("--no-tools"), true);
    assert.deepEqual(argv.includes("--tools"), true);
    assert.deepEqual(argv.includes("read,grep,find,ls"), true);
    assert.deepEqual(argv.includes("--system-prompt"), true);
    assert.equal(argv[argv.indexOf("--thinking") + 1], "max");
    assert.equal(firstRun.budget, "16384");
    assert.equal(argv.includes("--no-session"), false);
    const sessionId = argv[argv.indexOf("--session-id") + 1];
    assert.equal(typeof sessionId, "string");
    assert.equal(resumedArgv[resumedArgv.indexOf("--session-id") + 1], sessionId);
    assert.equal(resumedArgv[resumedArgv.indexOf("--thinking") + 1], "max");
    assert.equal(resumedRun.budget, "16384");
    assert.equal(argv[argv.indexOf("--session-dir") + 1], join(dir, "session"));
    assert.deepEqual(JSON.parse(await readFile(join(dir, "process-result.json"), "utf8")).stdoutTruncated, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LittleCoderAdapter reports terminal provider failures instead of missing final text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-little-coder-provider-error-"));
  try {
    const commandPath = join(dir, "fake-little-coder-provider-error.mjs");
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end',()=>{",
      "  process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],errorMessage:'Codex error: Our servers are currently overloaded. Please try again later.'}})+'\\n');",
      "  process.stdout.write(JSON.stringify({type:'auto_retry_end',success:false,attempt:3,finalError:'Codex error: Our servers are currently overloaded. Please try again later.'})+'\\n');",
      "});",
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new LittleCoderAdapter({
      id: "luna",
      adapter: "little-coder-model",
      model: "openai-codex/gpt-5.6-luna",
      command: commandPath,
      timeoutMs: 15000,
    });
    const result = await adapter.run({
      id: "luna",
      cwd: process.cwd(),
      prompt: "review",
      bundleDir: dir,
      timeoutMs: 15000,
    });

    assert.equal(result.verdict, "error");
    assert.equal(result.error, "provider_error");
    assert.equal(result.summary, "Reviewer provider failed before producing a final response.");
    assert.match(result.diagnostic ?? "", /servers are currently overloaded/);
    const processResult = JSON.parse(await readFile(join(dir, "process-result.json"), "utf8"));
    assert.match(processResult.terminalProviderError, /servers are currently overloaded/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LittleCoderAdapter reports truncated output before final assistant text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-little-coder-truncated-"));
  try {
    const commandPath = join(dir, "fake-little-coder-truncated.mjs");
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end',()=>process.stdout.write('x'.repeat(1100000)));",
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new LittleCoderAdapter({
      id: "glm",
      adapter: "little-coder-model",
      model: "ollama/glm-5.2",
      command: commandPath,
      timeoutMs: 15000,
    });

    const result = await adapter.run({
      id: "glm",
      cwd: process.cwd(),
      prompt: "review",
      bundleDir: dir,
      timeoutMs: 15000,
    });

    assert.equal(result.verdict, "error");
    assert.equal(result.error, "output_truncated");
    assert.equal(result.summary, "Reviewer output was truncated before a final assistant text was captured.");
    assert.deepEqual(JSON.parse(await readFile(join(dir, "process-result.json"), "utf8")).stdoutTruncated, true);
    const rawOutput = await readFile(join(dir, "raw-output.txt"), "utf8");
    assert.match(rawOutput, /No final assistant text was captured/);
    assert.match(rawOutput, /stdoutTruncated: true/);
    assert.equal(rawOutput.includes("x".repeat(1000)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("LittleCoderAdapter captures final assistant text after retained stdout cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-little-coder-stream-"));
  try {
    const commandPath = join(dir, "fake-little-coder-stream.mjs");
    const reviewJson = JSON.stringify({ verdict: "pass", summary: "final response captured", findings: [] });
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "const noise = 'x'.repeat(2000);",
      "process.stdin.resume();",
      "process.stdin.on('end',()=>{",
      "  for (let index = 0; index < 600; index += 1) {",
      "    process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:noise,partial:{role:'assistant',content:[{type:'thinking',thinking:noise}]}}})+'\\n');",
      "  }",
      `  process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:${JSON.stringify(reviewJson)}}]},usage:{input:1,output:2,totalTokens:3,cost:{total:0.01}}})+'\\n');`,
      "});",
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new LittleCoderAdapter({
      id: "glm",
      adapter: "little-coder-model",
      model: "ollama/glm-5.2",
      command: commandPath,
      timeoutMs: 15000,
    });

    const result = await adapter.run({
      id: "glm",
      cwd: process.cwd(),
      prompt: "review",
      bundleDir: dir,
      timeoutMs: 15000,
    });

    assert.equal(result.verdict, "pass");
    assert.equal(result.summary, "final response captured");
    assert.equal(result.usage?.totalTokens, 3);
    const processResult = JSON.parse(await readFile(join(dir, "process-result.json"), "utf8"));
    assert.deepEqual(processResult.stdoutTruncated, true);
    assert.deepEqual(processResult.rawOutputContainsStream, false);
    assert.equal(await readFile(join(dir, "raw-output.txt"), "utf8"), reviewJson);
    assert.equal((await readFile(join(dir, "raw-stream.jsonl"), "utf8")).length, 1000000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
