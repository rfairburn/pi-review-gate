import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PiModelAdapter } from "../src/adapters/pi-model";
import type { ReviewerSession } from "../src/adapters/types";
import { runPromptProcess } from "../src/adapters/process";

const ONE_MEGABYTE_RETAINED_PROCESS = (input: Parameters<typeof runPromptProcess>[0]) => runPromptProcess({
  ...input,
  maxRetainedOutputBytes: 1_000_000,
});

test("PiModelAdapter uses one native --tools allowlist and reports missing final assistant text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-pi-adapter-"));
  try {
    const argvPath = join(dir, "argv.json");
    const commandPath = join(dir, "fake-pi.mjs");
    // The fake stands in for pi plus the reviewer session-ref companion: it
    // keeps the session in a store outside the bundle and reports the exact
    // native id and file through the receipt path the adapter provided.
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { basename, dirname, join } from 'node:path';",
      `const argvPath=${JSON.stringify(argvPath)};`,
      `const store=${JSON.stringify(join(dir, "native-store"))};`,
      "const history=existsSync(argvPath)?JSON.parse(readFileSync(argvPath,'utf8')):[];",
      "history.push({argv:process.argv.slice(2)});writeFileSync(argvPath,JSON.stringify(history));",
      "const a=process.argv.slice(2);",
      "const sid=a[a.indexOf('--session-id')+1];",
      "const file=join(store,`${sid}.jsonl`);",
      "mkdirSync(dirname(file),{recursive:true});",
      "if(!existsSync(file))writeFileSync(file,JSON.stringify({type:'session',version:3,id:basename(file,'.jsonl'),timestamp:new Date().toISOString(),cwd:process.cwd()})+'\\n');",
      "const receipt=process.env.PI_REVIEW_GATE_REVIEWER_SESSION_RECEIPT;",
      "if(receipt)writeFileSync(receipt,JSON.stringify({sessionId:basename(file,'.jsonl'),sessionFile:file}));",
      "process.stdin.resume();",
      "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'message',message:{role:'assistant',content:[{type:'thinking',thinking:'still thinking'}]}})+'\\n'));",
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new PiModelAdapter({
      id: "glm",
      adapter: "pi-model",
      model: "ollama/glm-5.2",
      thinkingLevel: "max",
      command: commandPath,
      timeoutMs: 15000,
    });

    let session: ReviewerSession | undefined;
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
    const [firstRun, secondRun] = JSON.parse(await readFile(argvPath, "utf8"));
    const argv = firstRun.argv;
    const secondArgv = secondRun.argv;
    assert.deepEqual(argv.includes("--no-tools"), false);
    assert.deepEqual(argv.includes("--tools"), true);
    assert.equal(argv[argv.indexOf("--tools") + 1], "read,grep,find,ls");
    assert.deepEqual(argv.includes("--system-prompt"), true);
    const systemPrompt = argv[argv.indexOf("--system-prompt") + 1];
    for (const name of ["read", "grep", "find", "ls"]) {
      assert.match(systemPrompt, new RegExp(`\\b${name}\\b`));
    }
    assert.match(systemPrompt, /exactly these tools available/);
    assert.doesNotMatch(systemPrompt, /parameters|properties|additionalProperties|Read file contents/);
    assert.equal(argv.includes("--output-schema"), false);
    assert.equal(argv[argv.indexOf("--thinking") + 1], "max");
    assert.equal(argv.includes("--no-session"), false);
    const sessionId = argv[argv.indexOf("--session-id") + 1];
    assert.equal(typeof sessionId, "string");
    assert.equal(argv.includes("--session-dir"), false);
    assert.equal(secondArgv.includes("--session-dir"), false);
    assert.equal(secondArgv.includes("--session"), false);
    assert.equal(secondArgv.includes("--session-id"), true);
    assert.notEqual(secondArgv[secondArgv.indexOf("--session-id") + 1], sessionId, "reviewer passes stay fresh even when given a prior session");
    assert.equal(session?.file, join(dir, "native-store", `${sessionId}.jsonl`));
    // The temporary receipt is consumed, so the published pass keeps only the
    // single session reference in its own metadata.
    assert.equal(existsSync(join(dir, "session-ref.json")), false);
    assert.equal(secondArgv[secondArgv.indexOf("--thinking") + 1], "max");
    assert.deepEqual(JSON.parse(await readFile(join(dir, "process-result.json"), "utf8")).stdoutTruncated, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PiModelAdapter reports terminal provider failures instead of missing final text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-pi-provider-error-"));
  try {
    const commandPath = join(dir, "fake-pi-provider-error.mjs");
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end',()=>{",
      "  process.stdout.write(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],errorMessage:'Codex error: Our servers are currently overloaded. Please try again later.'}})+'\\n');",
      "  process.stdout.write(JSON.stringify({type:'auto_retry_end',success:false,attempt:3,finalError:'Codex error: Our servers are currently overloaded. Please try again later.'})+'\\n');",
      "});",
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new PiModelAdapter({
      id: "luna",
      adapter: "pi-model",
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

test("PiModelAdapter reports truncated output before final assistant text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-pi-truncated-"));
  try {
    const commandPath = join(dir, "fake-pi-truncated.mjs");
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end',()=>process.stdout.write('x'.repeat(1100000)));",
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new PiModelAdapter({
      id: "glm",
      adapter: "pi-model",
      model: "ollama/glm-5.2",
      command: commandPath,
      timeoutMs: 15000,
    }, { runPromptProcess: ONE_MEGABYTE_RETAINED_PROCESS });

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

test("PiModelAdapter captures final assistant text after retained stdout cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-pi-stream-"));
  try {
    const commandPath = join(dir, "fake-pi-stream.mjs");
    const reviewJson = JSON.stringify({ verdict: "pass", summary: "final response captured", findings: [] });
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "import { existsSync, mkdirSync, writeFileSync } from 'node:fs';",
      "import { basename, dirname, join } from 'node:path';",
      `const store=${JSON.stringify(join(dir, "native-store"))};`,
      // A real reviewer pass reports its own native session, so this fake does too.
      "const a=process.argv.slice(2);const sid=a[a.indexOf('--session-id')+1];const file=join(store,`${sid}.jsonl`);",
      "mkdirSync(dirname(file),{recursive:true});",
      "if(!existsSync(file))writeFileSync(file,JSON.stringify({type:'session',version:3,id:basename(file,'.jsonl'),timestamp:new Date().toISOString(),cwd:process.cwd()})+'\\n');",
      "const receipt=process.env.PI_REVIEW_GATE_REVIEWER_SESSION_RECEIPT;",
      "if(receipt)writeFileSync(receipt,JSON.stringify({sessionId:sid,sessionFile:file}));",
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

    const adapter = new PiModelAdapter({
      id: "glm",
      adapter: "pi-model",
      model: "ollama/glm-5.2",
      command: commandPath,
      timeoutMs: 15000,
    }, { runPromptProcess: ONE_MEGABYTE_RETAINED_PROCESS });

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
    assert.equal(result.error, undefined);
    const processResult = JSON.parse(await readFile(join(dir, "process-result.json"), "utf8"));
    assert.deepEqual(processResult.stdoutTruncated, true);
    assert.deepEqual(processResult.rawOutputContainsStream, false);
    assert.deepEqual(processResult.sessionRefCaptured, true);
    assert.equal(await readFile(join(dir, "raw-output.txt"), "utf8"), reviewJson);
    assert.equal((await readFile(join(dir, "raw-stream.jsonl"), "utf8")).length, 1000000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A completed review must leave its native session reference in the pass metadata. */
test("PiModelAdapter refuses a passing review whose child reported no session receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-pi-no-receipt-"));
  try {
    const commandPath = join(dir, "fake-pi-no-receipt.mjs");
    const reviewJson = JSON.stringify({ verdict: "pass", summary: "verdict without a session reference", findings: [] });
    const finalTextFrame = JSON.stringify(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reviewJson }] } }) + "\n");
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      `process.stdin.on('end',()=>process.stdout.write(${finalTextFrame}));`,
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    let session: ReviewerSession | undefined;
    const result = await new PiModelAdapter({
      id: "glm", adapter: "pi-model", model: "ollama/glm-5.2", command: commandPath, timeoutMs: 15000,
    }).run({ id: "glm", cwd: process.cwd(), prompt: "review", bundleDir: dir, timeoutMs: 15000, onSession(value) { session = value; } });

    assert.equal(result.verdict, "error");
    assert.equal(result.error, "session_reference_missing");
    assert.match(result.summary, /did not report its own native session reference/);
    assert.equal(session?.file, undefined);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "process-result.json"), "utf8")).sessionRefCaptured, false);
    // The pass artifacts remain published so the refusal is diagnosable.
    assert.match(await readFile(join(dir, "raw-output.txt"), "utf8"), /verdict without a session reference/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PiModelAdapter refuses a passing review whose receipt names another session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-pi-wrong-receipt-"));
  try {
    const commandPath = join(dir, "fake-pi-wrong-receipt.mjs");
    const reviewJson = JSON.stringify({ verdict: "pass", summary: "verdict with a foreign session", findings: [] });
    const finalTextFrame = JSON.stringify(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reviewJson }] } }) + "\n");
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      // A foreign or corrupted receipt is never adopted, even though the
      // reviewer's own verdict parsed cleanly.
      "const receipt=process.env.PI_REVIEW_GATE_REVIEWER_SESSION_RECEIPT;",
      `if(receipt)writeFileSync(receipt,JSON.stringify({sessionId:'another-session',sessionFile:join(process.env.HOME??'/tmp','.pi','sessions','another-session.jsonl')}));`,
      "process.stdin.resume();",
      `process.stdin.on('end',()=>process.stdout.write(${finalTextFrame}));`,
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    let session: ReviewerSession | undefined;
    const result = await new PiModelAdapter({
      id: "glm", adapter: "pi-model", model: "ollama/glm-5.2", command: commandPath, timeoutMs: 15000,
    }).run({ id: "glm", cwd: process.cwd(), prompt: "review", bundleDir: dir, timeoutMs: 15000, onSession(value) { session = value; } });

    assert.equal(result.verdict, "error");
    assert.equal(result.error, "session_reference_missing");
    assert.equal(session?.file, undefined);
    // The temporary receipt is consumed rather than left beside the pass metadata.
    assert.equal(existsSync(join(dir, "session-ref.json")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
