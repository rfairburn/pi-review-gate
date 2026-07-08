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
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
      "process.stdin.resume();",
      "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'message',message:{role:'assistant',content:[{type:'thinking',thinking:'still thinking'}]}})+'\\n'));",
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new LittleCoderAdapter({
      id: "glm",
      adapter: "little-coder-model",
      model: "ollama/glm-5.2",
      command: commandPath,
      timeoutMs: 5000,
    });

    const result = await adapter.run({
      id: "glm",
      cwd: process.cwd(),
      prompt: "review",
      bundleDir: dir,
      timeoutMs: 5000,
    });

    assert.equal(result.verdict, "error");
    assert.equal(result.error, "missing_final_text");
    assert.equal(result.summary, "Reviewer did not produce final assistant text.");
    assert.deepEqual(JSON.parse(await readFile(argvPath, "utf8")).includes("--no-tools"), true);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "process-result.json"), "utf8")).stdoutTruncated, false);
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
      timeoutMs: 5000,
    });

    const result = await adapter.run({
      id: "glm",
      cwd: process.cwd(),
      prompt: "review",
      bundleDir: dir,
      timeoutMs: 5000,
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
      timeoutMs: 5000,
    });

    const result = await adapter.run({
      id: "glm",
      cwd: process.cwd(),
      prompt: "review",
      bundleDir: dir,
      timeoutMs: 5000,
    });

    assert.equal(result.verdict, "pass");
    assert.equal(result.summary, "final response captured");
    assert.equal(result.usage?.totalTokens, 3);
    assert.equal(await readFile(join(dir, "reviewer-final.txt"), "utf8"), reviewJson);
    const processResult = JSON.parse(await readFile(join(dir, "process-result.json"), "utf8"));
    assert.deepEqual(processResult.stdoutTruncated, true);
    assert.deepEqual(processResult.rawOutputContainsStream, false);
    assert.equal(await readFile(join(dir, "raw-output.txt"), "utf8"), reviewJson);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
