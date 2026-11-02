/**
 * Focused regression coverage for issue #604: the added `toolProtection` gate is
 * scoped to Pi acting executors only. Every case here drives the production
 * executor factory, and the launch cases drive the real factory -> adapter ->
 * child path for the non-Pi adapters that can be launched synthetically (a
 * generic binary, a Codex app-server stand-in, and the Claude Agent SDK path —
 * both the honest absent-CLI negative and one completed synthetic turn against
 * an owned fixture CLI, skipped on Windows like the other real-CLI launch
 * cases). Fixtures are inert: no provider call, credential, login, destructive,
 * network or browser operation runs here.
 *
 * Contract under test (issue #604):
 * - a non-Pi acting worker (Codex, Claude, generic binary) never passes through
 *   protection admission at any Protection level, and a malformed/unvalidated
 *   stored `toolProtection` block never refuses its launch either;
 * - a Claude worker therefore completes a full real Agent SDK turn end to end
 *   (initialize, prompt, terminal result) instead of being refused before it
 *   starts, which is exactly what the pre-#604 gate did to it;
 * - nothing synthesizes an `off` protection setting or changes configuration for
 *   such a launch, and no protection pin travels to it;
 * - Pi admission, pinning, and the fail-closed load-error behavior are
 *   unchanged;
 * - pre-existing external-definition resolution failures still fail.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, type ReviewGateConfig } from "../src/config";
import { createExecutorAdapter } from "../src/execution/adapters/factory";
import {
  clearToolProtectionLoadError,
  noteToolProtectionLoadError,
  TOOL_PROTECTION_BOOTSTRAP_ENV,
  type ToolProtectionLaunchPin,
} from "../src/tool-protection/coordinator";
import { PROTECTION_LEVELS, type ProtectionLevel } from "../src/tool-protection/config";

const MALFORMED_LOAD_ERROR = "toolProtection is invalid, so tool protection is unavailable and protected calls stay blocked until a valid configuration is saved: toolProtection.level must be one of: off, dangerous, aligned, workspace";

/** One config carrying the level plus every non-Pi worker definition under test. */
function workerConfig(level: ProtectionLevel | "unset"): ReviewGateConfig {
  const config: Record<string, unknown> = {
    ...DEFAULT_CONFIG,
    externalAgents: {
      "synthetic-codex": {
        adapter: "codex-cli",
        command: "codex",
        model: "synthetic-codex-model",
        execution: { timeoutMs: 30_000 },
      },
      "synthetic-claude": {
        adapter: "claude-cli",
        command: "claude",
        model: "synthetic-claude-model",
        execution: { timeoutMs: 30_000 },
      },
      "synthetic-binary": {
        adapter: "run-as-binary",
        command: "synthetic-binary",
        model: "synthetic-binary-model",
        execution: { timeoutMs: 30_000 },
      },
      // A decision-only auditor definition is not an executor at all: it stays
      // unresolvable as a worker whatever the Protection level.
      "synthetic-auditor": {
        adapter: "generic-cli",
        command: "synthetic-auditor",
        review: { timeoutMs: 30_000 },
      },
    },
  };
  if (level !== "unset") {
    config.toolProtection = {
      level,
      auditor: { source: "pi", model: "synthetic/model", thinkingLevel: "high" },
      scope: "all",
      toolNames: [],
      timeoutMs: 5_000,
      maxContextChars: 200_000,
      retainAuditorSessions: false,
    };
  }
  return config as unknown as ReviewGateConfig;
}

/** Every level plus the no-block default, so no level can hide a refusal. */
const LEVELS: Array<ProtectionLevel | "unset"> = [...PROTECTION_LEVELS, "unset"];

function pinOf(adapter: unknown): ToolProtectionLaunchPin | undefined {
  return (adapter as { options?: { toolProtection?: ToolProtectionLaunchPin } }).options?.toolProtection;
}

test("non-Pi acting workers skip protection admission at every level and receive no pin", () => {
  noteToolProtectionLoadError(undefined);
  const expected = [
    ["synthetic-codex", "codex-cli"],
    ["synthetic-claude", "claude-cli"],
    ["synthetic-binary", "run-as-binary"],
  ] as const;
  for (const level of LEVELS) {
    const config = workerConfig(level);
    for (const [id, kind] of expected) {
      const adapter = createExecutorAdapter(config, { source: "external", id });
      assert.equal(adapter.kind, kind, `${id} reaches its adapter at level ${level}`);
      assert.equal(pinOf(adapter), undefined, `no protection pin travels to ${id} at level ${level}`);
      assert.equal(
        JSON.stringify(adapter).includes("toolProtection"),
        false,
        `no protection state is attached to ${id} at level ${level}`,
      );
    }
  }
});

test("a malformed stored protection block never refuses a non-Pi launch but still fails a Pi launch closed", () => {
  noteToolProtectionLoadError(MALFORMED_LOAD_ERROR);
  try {
    const config = workerConfig("aligned");
    for (const [id, kind] of [
      ["synthetic-codex", "codex-cli"],
      ["synthetic-claude", "claude-cli"],
      ["synthetic-binary", "run-as-binary"],
    ] as const) {
      const adapter = createExecutorAdapter(config, { source: "external", id });
      assert.equal(adapter.kind, kind, `${id} launches unchanged while the stored block is unvalidated`);
    }
    // The protected path stays fail-closed: an unvalidated block cannot admit a
    // Pi executor at an unknown level.
    assert.throws(
      () => createExecutorAdapter(config, { source: "pi", model: "synthetic/model" }),
      /Tool protection is unavailable .*no Pi executor was started/,
    );
  } finally {
    clearToolProtectionLoadError();
  }
});

test("missing and non-executor external definitions keep failing at every level and under a malformed block", () => {
  const check = (config: ReviewGateConfig) => {
    assert.throws(
      () => createExecutorAdapter(config, { source: "external", id: "absent-worker" }),
      /external executor definition is unavailable: absent-worker/,
    );
    // A decision-only auditor selection is not an acting executor definition.
    assert.throws(
      () => createExecutorAdapter(config, { source: "external", id: "synthetic-auditor" }),
      /external executor definition is unavailable: synthetic-auditor/,
    );
  };
  noteToolProtectionLoadError(undefined);
  for (const level of LEVELS) check(workerConfig(level));
  noteToolProtectionLoadError(MALFORMED_LOAD_ERROR);
  try {
    check(workerConfig("workspace"));
  } finally {
    clearToolProtectionLoadError();
  }
});

test("Pi admission and pinning stay unchanged at every level", () => {
  noteToolProtectionLoadError(undefined);
  for (const level of LEVELS) {
    const config = workerConfig(level);
    const adapter = createExecutorAdapter(config, { source: "pi", model: "synthetic/model" });
    assert.equal(adapter.kind, "pi-model");
    const pin = pinOf(adapter);
    assert.ok(pin, "a Pi launch always carries the parent's pinned snapshot");
    assert.equal(
      pin.settings.level,
      level === "unset" ? "off" : level,
      `the parent level ${level} reaches the Pi executor launch options`,
    );
    assert.equal(pin.settings.enabled, level !== "unset" && level !== "off", "Off stays an explicit pinned Off");
    assert.equal(pin.loadError, undefined);
  }
  // An external decision-only auditor still pins the parent's resolved
  // definition for the Pi launch; that boundary is untouched by #604.
  const auditorConfig = {
    ...workerConfig("aligned"),
    toolProtection: {
      ...workerConfig("aligned").toolProtection!,
      auditor: { source: "external", id: "synthetic-auditor" },
    },
  } as ReviewGateConfig;
  const pinned = pinOf(createExecutorAdapter(auditorConfig, { source: "pi", model: "synthetic/model" }));
  assert.equal(pinned?.settings.auditor?.source, "external");
  assert.equal(pinned?.auditorDefinition?.adapter, "generic-cli");
  assert.equal(pinned?.auditorDefinitionError, undefined);
});

test("a generic binary worker launched by the production factory runs with no protection bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-604-generic-"));
  try {
    await mkdir(join(root, "artifacts"));
    const script = [
      "const prompt = require('node:fs').readFileSync(0, 'utf8');",
      "const out = v => process.stdout.write(JSON.stringify(v) + '\\n');",
      "out({ type: 'session', sessionId: 'generic-scope-604' });",
      `out({ type: 'assistant', text: 'generic-complete pin=' + (process.env[${JSON.stringify(TOOL_PROTECTION_BOOTSTRAP_ENV)}] ? 'present' : 'absent') });`,
      "out({ type: 'usage', usage: { input_tokens: 1, output_tokens: 2 } });",
      "void prompt;",
    ].join("");
    const config = {
      ...workerConfig("workspace"),
      externalAgents: {
        ...workerConfig("workspace").externalAgents!,
        "synthetic-binary": {
          adapter: "run-as-binary",
          command: process.execPath,
          model: "synthetic-binary-model",
          execution: { args: ["-e", script], timeoutMs: 30_000 },
        },
      },
    } as ReviewGateConfig;

    const adapter = createExecutorAdapter(config, { source: "external", id: "synthetic-binary" });
    assert.equal(adapter.kind, "run-as-binary");
    const turn = await adapter.run({
      cwd: root,
      artifactDir: join(root, "artifacts"),
      turn: 1,
      prompt: "synthetic task",
    });
    assert.equal(turn.text, "generic-complete pin=absent", "the child launched and reported no protection bootstrap");
    assert.equal(turn.session.id, "generic-scope-604");
    assert.equal(turn.code, 0);
    assert.equal(turn.failure, undefined, "a non-Off level never interrupts a generic worker launch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Codex worker launched by the production factory completes a synthetic app-server turn with no protection bootstrap", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-604-codex-"));
  try {
    await mkdir(join(root, "artifacts"));
    const server = join(root, "synthetic-app-server.cjs");
    await writeFile(server, String.raw`
const readline = require('node:readline');
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const probe = process.env.PI_REVIEW_GATE_TOOL_PROTECTION ? 'present' : 'absent';
setTimeout(() => process.exit(91), 20_000);
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  let call;
  try { call = JSON.parse(line); } catch { return; }
  if (call.method === 'initialize') out({ jsonrpc: '2.0', id: call.id, result: { userAgent: 'prg-604-synthetic/1' } });
  else if (call.method === 'thread/start' || call.method === 'thread/resume') out({ jsonrpc: '2.0', id: call.id, result: { thread: { id: 'thread-scope-604' } } });
  else if (call.method === 'turn/start') {
    out({ jsonrpc: '2.0', id: call.id, result: { turn: { id: 'turn-scope-604' } } });
    out({ method: 'turn/completed', params: { threadId: 'thread-scope-604', turn: { id: 'turn-scope-604', status: 'completed', items: [{ type: 'agentMessage', text: 'codex-complete pin=' + probe }] } } });
  }
  else if (call.id !== undefined) out({ jsonrpc: '2.0', id: call.id, result: {} });
});
lines.on('close', () => process.exit(0));
`);
    const config = {
      ...workerConfig("aligned"),
      externalAgents: {
        ...workerConfig("aligned").externalAgents!,
        "synthetic-codex": {
          adapter: "codex-cli",
          command: process.execPath,
          model: "synthetic-codex-model",
          execution: { args: [server], timeoutMs: 30_000 },
        },
      },
    } as ReviewGateConfig;

    const adapter = createExecutorAdapter(config, { source: "external", id: "synthetic-codex" });
    assert.equal(adapter.kind, "codex-cli");
    const turn = await adapter.run({
      cwd: root,
      artifactDir: join(root, "artifacts"),
      turn: 1,
      prompt: "synthetic task",
    });
    assert.equal(turn.failure, undefined, "an aligned level never interrupts a Codex worker launch");
    assert.equal(turn.text, "codex-complete pin=absent", "the owned child launched and reported no protection bootstrap");
    assert.equal(turn.session.id, "thread-scope-604");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Claude worker reaches the real SDK launch path and reports an unavailable CLI, never a protection refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-604-claude-"));
  try {
    await mkdir(join(root, "artifacts"));
    // Honest negative control: no Claude CLI exists at this path, so the run
    // must settle through the real launch path's own unavailable diagnostic —
    // the installed Agent SDK rejects `options.pathToClaudeCodeExecutable`
    // before any turn, and either way the absent fixture path is what the
    // launch reports. A generic code-1 failure is not accepted here.
    const absentCli = join(root, "definitely-absent-claude-cli");
    const config = {
      ...workerConfig("workspace"),
      externalAgents: {
        ...workerConfig("workspace").externalAgents!,
        "synthetic-claude": {
          adapter: "claude-cli",
          command: absentCli,
          model: "synthetic-claude-model",
          execution: { timeoutMs: 20_000 },
        },
      },
    } as ReviewGateConfig;

    const adapter = createExecutorAdapter(config, { source: "external", id: "synthetic-claude" });
    assert.equal(adapter.kind, "claude-cli", "the added gate never refused the launch");
    const turn = await adapter.run({
      cwd: root,
      artifactDir: join(root, "artifacts"),
      turn: 1,
      prompt: "synthetic task",
    });
    assert.ok(turn.failure, `the absent CLI must settle as a failure; got ${JSON.stringify(turn.text)}`);
    assert.equal(turn.code, 1);
    assert.equal(turn.failure.category, "protocol", "the unavailable CLI is a launch-path protocol failure");
    const message = turn.failure.message;
    assert.ok(
      message.includes(absentCli),
      `the diagnostic names the absent configured executable; got ${message}`,
    );
    assert.match(message, /not found|ENOENT|spawn/i, `the diagnostic states the executable is unavailable; got ${message}`);
    assert.doesNotMatch(message, /tool protection/i, `failure came from the launch path, not the gate: ${message}`);
    assert.doesNotMatch(message, /cannot audit tool calls/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A minimal stand-in for a well-behaved Claude Code CLI, owned by the caller's
// scratch directory: it answers the installed Agent SDK's `initialize` control
// request, replies exactly once to the prompt it receives, and exits on stdin
// EOF. It records only the launch facts asserted below, into a file inside the
// same owned directory. No provider call, no network access, and no genuine
// Claude Code binary is involved — a real installed CLI stays a separate
// availability concern, covered honestly by the absent-CLI case above.
const CLAUDE_WORKER_FIXTURE = String.raw`
"use strict";
const fs = require("node:fs");
const session = "synthetic-claude-worker-604";
const reply = "synthetic claude worker reply";
const usage = { input_tokens: 1, output_tokens: 2 };
const factsPath = process.env.PRG_604_CLAUDE_FACTS;
const facts = {
  cwd: process.cwd(),
  protection: process.env.PI_REVIEW_GATE_TOOL_PROTECTION ? "present" : "absent",
  prompts: [],
};
const out = (message) => process.stdout.write(JSON.stringify(message) + "\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    if (frame.type === "control_request") {
      const initialize = frame.request && frame.request.subtype === "initialize";
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: frame.request_id,
          response: initialize
            ? { commands: [], agents: [], output_style: "default", available_output_styles: ["default"], models: [], account: {} }
            : {},
        },
      });
      continue;
    }
    if (frame.type !== "user") continue;
    facts.prompts.push(frame.message.content);
    if (factsPath) fs.writeFileSync(factsPath, JSON.stringify(facts));
    out({ type: "system", subtype: "init", session_id: session, model: "synthetic-claude-model", tools: [] });
    out({
      type: "assistant",
      session_id: session,
      parent_tool_use_id: null,
      uuid: frame.uuid,
      message: { role: "assistant", content: [{ type: "text", text: reply }], usage },
    });
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5,
      duration_api_ms: 5,
      num_turns: 1,
      result: reply,
      session_id: session,
      user_message_uuid: frame.uuid,
      usage,
    });
  }
});
process.stdin.on("end", () => process.exit(0));
// A fixture that outlived the adapter's own teardown would hang the run, so it
// exits with a distinctive code that the assertions below would report.
setTimeout(() => process.exit(91), 20_000);
`;

async function writeClaudeWorkerFixture(dir: string): Promise<string> {
  const path = join(dir, "synthetic-claude-worker.js");
  // The SDK owns the argument vector and the adapter appends configured args
  // after it, so the fixture is launched as an executable script the SDK spawn
  // hook can run directly (the same owned-shebang pattern as
  // tests/helpers/claude-mock-cli.ts) rather than as a positional script path
  // in front of the SDK's own flags. That shebang launch is POSIX-only, which is
  // why the case is skipped on Windows instead of claiming support there.
  await writeFile(path, `#!/usr/bin/env node\n${CLAUDE_WORKER_FIXTURE}`, "utf8");
  await chmod(path, 0o755);
  return path;
}

test("a Claude worker launched by the production factory completes a real Agent SDK turn against an owned fixture CLI with no protection bootstrap", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-604-claude-turn-"));
  try {
    const artifactDir = join(root, "artifacts");
    await mkdir(artifactDir);
    // The child resolves symlinks, so the workspace assertion compares realpaths.
    const workspace = await realpath(root);
    const fixture = await writeClaudeWorkerFixture(root);
    const states: Array<{ level: ProtectionLevel; loadError: string | undefined }> = [
      // A non-Off level: the pre-#604 gate refused this launch before it started
      // with 'Tool protection (level ...) cannot audit tool calls inside external
      // executor "synthetic-claude"', so a clean turn is the regression.
      { level: "workspace", loadError: undefined },
      // An unvalidated stored block: the pre-#604 gate refused every executor
      // launch here too ('no executor was started').
      { level: "aligned", loadError: MALFORMED_LOAD_ERROR },
    ];
    let turnIndex = 0;
    for (const state of states) {
      turnIndex += 1;
      const factsPath = join(root, `fixture-facts-${state.level}.json`);
      const config = {
        ...workerConfig(state.level),
        externalAgents: {
          ...workerConfig(state.level).externalAgents!,
          "synthetic-claude": {
            adapter: "claude-cli",
            command: fixture,
            model: "synthetic-claude-model",
            env: { PRG_604_CLAUDE_FACTS: factsPath },
            execution: { timeoutMs: 30_000 },
          },
        },
      } as ReviewGateConfig;
      const adapter = createExecutorAdapter(config, { source: "external", id: "synthetic-claude" });
      assert.equal(adapter.kind, "claude-cli");
      assert.equal(pinOf(adapter), undefined, `no protection pin travels to the Claude launch at level ${state.level}`);
      const prompt = `synthetic claude task ${state.level}`;
      const delivered: string[] = [];
      const started: Array<{ pid: number; processGroupId?: number }> = [];
      const exits: Array<{ pid: number; code: number | null; signal: NodeJS.Signals | null }> = [];
      noteToolProtectionLoadError(state.loadError);
      let turn;
      try {
        turn = await adapter.run({
          cwd: root,
          artifactDir,
          turn: turnIndex,
          prompt,
          onPromptDelivery: (delivery) => { delivered.push(delivery.prompt); },
          onProcessStart: (child) => { started.push({ pid: child.pid, processGroupId: child.processGroupId }); },
          onProcessExit: (child) => { exits.push({ pid: child.pid, code: child.code, signal: child.signal }); },
        });
      } finally {
        clearToolProtectionLoadError();
      }
      const label = `level ${state.level}${state.loadError ? " with an unvalidated stored block" : ""}`;
      assert.equal(turn.failure, undefined, `the gate never refuses a Claude worker launch (${label})`);
      assert.equal(turn.code, 0, `the turn settles cleanly (${label})`);
      assert.equal(turn.timedOut, false, `the turn is not left waiting on the executor timeout (${label})`);
      assert.equal(turn.aborted, false, `the turn is not classified as interrupted (${label})`);
      assert.equal(turn.text, "synthetic claude worker reply", `the fixture's exact synthetic result is the turn text (${label})`);
      assert.deepEqual(turn.session, { adapter: "claude-cli", id: "synthetic-claude-worker-604" }, `the reported session is the fixture's own (${label})`);
      assert.equal(turn.usage?.inputTokens, 1, `the reported usage is the fixture's (${label})`);
      assert.equal(turn.usage?.outputTokens, 2, `the reported usage is the fixture's (${label})`);
      assert.deepEqual(delivered, [prompt], `the prompt crossed the SDK delivery boundary exactly once (${label})`);
      const facts = JSON.parse(await readFile(factsPath, "utf8")) as { cwd: string; protection: string; prompts: string[] };
      assert.deepEqual(facts.prompts, [prompt], `the owned child received exactly the task prompt (${label})`);
      assert.equal(facts.cwd, workspace, `the owned child ran in the requested workspace (${label})`);
      assert.equal(facts.protection, "absent", `no tool-protection bootstrap reaches a non-Pi worker child (${label})`);
      assert.equal(started.length, 1, `the run owns exactly one CLI process (${label})`);
      assert.equal(exits.length, 1, `the owned CLI reported its exit (${label})`);
      assert.equal(exits[0]!.code, 0, `the owned CLI exited by itself after the turn (${label})`);
      assert.equal(exits[0]!.signal, null, `the adapter did not signal the owned CLI (${label})`);
      const groupId = started[0]!.processGroupId ?? started[0]!.pid;
      assert.throws(
        () => process.kill(-groupId, 0),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
        `the owned process group is gone after teardown (${label})`,
      );
      assert.ok(
        turn.stdoutPath.startsWith(artifactDir) && turn.stderrPath.startsWith(artifactDir),
        `the raw stream artifacts stay inside the caller-owned artifact directory (${label})`,
      );
      assert.ok(
        (await readFile(turn.stdoutPath, "utf8")).includes('"result":"synthetic claude worker reply"'),
        `the owned artifact captured the terminal result (${label})`,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
