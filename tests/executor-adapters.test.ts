import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeExecutorAdapter } from "../src/execution/adapters/claude-cli";
import { CodexExecutorAdapter } from "../src/execution/adapters/codex-cli";
import { LittleCoderExecutorAdapter } from "../src/execution/adapters/little-coder";

test("little-coder executor uses the canonical model, isolated session, and nested-gate kill switch", async () => {
  const fixture = await harnessFixture("little");
  const adapter = new LittleCoderExecutorAdapter({
    model: "openai-codex/gpt-5.6-sol",
    thinkingLevel: "max",
    command: fixture.command,
    args: [fixture.capture],
  });

  const first = await adapter.run(request(fixture, 1));
  const second = await adapter.run(request(fixture, 2, first.session));

  assert.equal(first.text, "little complete");
  assert.equal(second.session.id, first.session.id);
  const captured = JSON.parse(await readFile(fixture.capture, "utf8"));
  assert.deepEqual(valueAfter(captured.argv, "--model"), "openai-codex/gpt-5.6-sol");
  assert.deepEqual(valueAfter(captured.argv, "--thinking"), "max");
  assert.equal(captured.thinkingBudget, "0");
  assert.deepEqual(valueAfter(captured.argv, "--session-id"), first.session.id);
  assert.equal(captured.disabled, "1");
});

test("Codex executor starts workspace-write and resumes the exact thread", async () => {
  const fixture = await harnessFixture("codex");
  const adapter = new CodexExecutorAdapter({
    id: "codex",
    adapter: "codex-cli",
    command: fixture.command,
    model: "gpt-5.6-sol",
    args: [],
    env: { CAPTURE_PATH: fixture.capture, PI_REVIEW_GATE_DISABLED: "0" },
  });

  const first = await adapter.run(request(fixture, 1));
  assert.equal(first.session.id, "11111111-1111-4111-8111-111111111111");
  const start = JSON.parse(await readFile(fixture.capture, "utf8"));
  assert.ok(start.argv.includes("--approve-for-me"));
  assert.equal(valueAfter(start.argv, "--sandbox"), "workspace-write");
  assert.equal(valueAfter(start.argv, "--model"), "gpt-5.6-sol");
  assert.equal(start.disabled, "1");

  await adapter.run(request(fixture, 2, first.session));
  const resumed = JSON.parse(await readFile(fixture.capture, "utf8"));
  assert.deepEqual(resumed.argv.slice(0, 2), ["exec", "resume"]);
  assert.ok(resumed.argv.includes(first.session.id));
});

test("Claude executor uses editable auto mode and resumes its UUID", async () => {
  const fixture = await harnessFixture("claude");
  const adapter = new ClaudeExecutorAdapter({
    id: "claude",
    adapter: "claude-cli",
    command: fixture.command,
    model: "sonnet",
    args: [],
    env: { CAPTURE_PATH: fixture.capture },
  });

  const first = await adapter.run(request(fixture, 1));
  const start = JSON.parse(await readFile(fixture.capture, "utf8"));
  assert.equal(first.text, "claude complete");
  assert.equal(valueAfter(start.argv, "--permission-mode"), "auto");
  assert.equal(valueAfter(start.argv, "--tools"), "default");
  assert.equal(valueAfter(start.argv, "--session-id"), first.session.id);

  await adapter.run(request(fixture, 2, first.session));
  const resumed = JSON.parse(await readFile(fixture.capture, "utf8"));
  assert.equal(valueAfter(resumed.argv, "--resume"), first.session.id);
});

async function harnessFixture(mode: "little" | "codex" | "claude"): Promise<{
  root: string;
  artifactDir: string;
  command: string;
  capture: string;
}> {
  const root = await mkdtemp(join(tmpdir(), `pi-review-${mode}-adapter-`));
  const artifactDir = join(root, "artifacts");
  await mkdir(artifactDir);
  const command = join(root, "fake-harness.cjs");
  const capture = join(root, "capture.json");
  await writeFile(command, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    `const mode = ${JSON.stringify(mode)};`,
    "const argv = process.argv.slice(2);",
    "const capture = process.env.CAPTURE_PATH || argv.at(-1);",
    "fs.writeFileSync(capture, JSON.stringify({ argv, disabled: process.env.PI_REVIEW_GATE_DISABLED, thinkingBudget: process.env.LITTLE_CODER_THINKING_BUDGET }));",
    "if (mode === 'little') {",
    "  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'little complete' }] } }));",
    "} else if (mode === 'codex') {",
    "  console.log(JSON.stringify({ type: 'thread.started', thread_id: '11111111-1111-4111-8111-111111111111' }));",
    "  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex complete' } }));",
    "} else {",
    "  console.log(JSON.stringify({ result: 'claude complete', usage: { input_tokens: 10, output_tokens: 2 } }));",
    "}",
  ].join("\n"), "utf8");
  await chmod(command, 0o755);
  return { root, artifactDir, command, capture };
}

function request(
  fixture: { root: string; artifactDir: string },
  turn: number,
  session?: { adapter: string; id: string },
) {
  return {
    cwd: fixture.root,
    prompt: `turn ${turn}`,
    artifactDir: fixture.artifactDir,
    turn,
    session,
  };
}

function valueAfter(values: string[], flag: string): string | undefined {
  const index = values.indexOf(flag);
  return index === -1 ? undefined : values[index + 1];
}
