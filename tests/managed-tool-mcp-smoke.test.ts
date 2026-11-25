/**
 * #682 slice 1b: MCP-boundary coverage for the TEST/DEVELOPMENT-ONLY smoke
 * owner (./managed-tool-mcp-smoke-owner.ts) that serves the shared
 * SubtasksStart/SubtasksInspect definitions, plus opt-in real native CLI
 * runs (./managed-tool-mcp-smoke.ts).
 *
 * Covered here without any native CLI:
 * - The MCP tool list is exactly the two `sharedManagedTool` definitions, with
 *   the same names, descriptions, and schemas Pi registers.
 * - Claude- and Codex-identified MCP sessions reach the same private
 *   canonical handler with owner-assigned call ids and no host context, and
 *   get equivalent results.
 * - Start queues under the owner's raw admitted identity; Inspect returns the
 *   same handles; the canonical validator rejects Inspect without taskId with
 *   the same text as Pi.
 * - Fail closed before admission: non-research kinds, a workspace override,
 *   non-object arguments, unexposed tools, and other MCP methods. Caller
 *   metadata cannot pick the call id. Each admission is consumed by one call.
 * - Separate owners cannot read each other's executions.
 * - Scratch validation, the explicit authority flag, stdio framing, teardown,
 *   and sanitized evidence of the real entry point.
 * - Evidence goes only to a new file directly under the scratch, created
 *   exclusively without following symlinks, and keeps only allowlisted
 *   fields even when callers send paths, secrets, or malformed handles.
 * - The mock provider plan, its loopback/synthetic-key boundary, and its
 *   sanitized journal.
 * - The runner: managed-policy preflight, SIGINT terminating a fake CLI's
 *   process group (escalating past an ignored SIGTERM) and removing the
 *   scratch, and raw CLI output withheld from the report.
 *
 * Real CLIs run only when PI_REVIEW_GATE_MCP_SMOKE_CLI lists them
 * (`claude`, `codex`, or `claude,codex`); a listed CLI that is missing fails.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { toolCallFingerprint } from "../src/tool-call-fingerprint";
import { assertEnvelopeParity, managedToolFixture } from "./managed-tool-fixtures";
import {
  SMOKE_AUTHORITY_FLAG,
  SMOKE_SCRATCH_MARKER,
  SmokeOwner,
  validateSmokeScratch,
} from "./managed-tool-mcp-smoke-owner";
import {
  SMOKE_SYNTHETIC_API_KEY,
  deliveredResult,
  nextSmokeCall,
  startMockProvider,
  type ObservedToolResult,
} from "./managed-tool-mcp-smoke-providers";
import { managedPolicyBlockers, managedPolicyLocations, runManagedToolMcpSmoke, resolveOnPath, type SmokeCli } from "./managed-tool-mcp-smoke";

const OWNER_SCRIPT = join(__dirname, "managed-tool-mcp-smoke-owner.js");
const task = (title: string) => ({ title, instructions: `bounded instructions for ${title}`, acceptanceCriteria: [`${title} done`] });
const researchStart = (title: string) => ({ kind: "research", tasks: [task(title)] });

type SpyBinding = { toolCallId: string; host?: unknown };
type Handler = (action: string, toolName: string, params: unknown, binding: SpyBinding) => Promise<Record<string, unknown>>;

function spyHandler(manager: unknown) {
  const instance = manager as { executeAction: Handler };
  const original = instance.executeAction.bind(manager);
  const calls: Array<{ action: string; toolName: string; params: unknown; binding: SpyBinding }> = [];
  instance.executeAction = async (action, toolName, params, binding) => {
    calls.push({ action, toolName, params, binding });
    return original(action, toolName, params, binding);
  };
  return { calls, restore: () => { instance.executeAction = original; } };
}

async function smokeScratch(): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "prg-mcp-smoke-test-"));
  await writeFile(join(scratch, SMOKE_SCRATCH_MARKER), "test scratch\n");
  return scratch;
}

async function withOwner<T>(run: (owner: SmokeOwner, scratch: string) => Promise<T>): Promise<T> {
  const scratch = await smokeScratch();
  const owner = await SmokeOwner.create({ scratch });
  try {
    return await run(owner, scratch);
  } finally {
    await owner.dispose();
    await rm(scratch, { recursive: true, force: true });
  }
}

let rpcId = 0;
async function rpc(owner: SmokeOwner, method: string, params?: unknown): Promise<Record<string, any>> {
  const response = await owner.handle({ jsonrpc: "2.0", id: ++rpcId, method, ...(params === undefined ? {} : { params }) });
  assert.ok(response, `${method} should answer`);
  return response as Record<string, any>;
}

async function callTool(owner: SmokeOwner, name: string, args: unknown, extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const response = await rpc(owner, "tools/call", { name, arguments: args, ...extra });
  assert.equal(response.error, undefined, `${name} should return a CallToolResult`);
  return response.result;
}

function groupCount(owner: SmokeOwner): number {
  return owner.manager.associations().groupRoots?.length ?? 0;
}

test("the MCP tool list is exactly the shared Start/Inspect definitions, identical to Pi's registration", async () => {
  const fixture = await managedToolFixture();
  try {
    await withOwner(async (owner) => {
      const init = await rpc(owner, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "claude-code", version: "test" } });
      assert.equal(init.result.protocolVersion, "2025-06-18");
      assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
      const fallback = await rpc(owner, "initialize", { protocolVersion: "1999-01-01" });
      assert.equal(fallback.result.protocolVersion, "2025-11-25", "unknown protocol versions get the newest supported one");
      const listed = (await rpc(owner, "tools/list")).result.tools as Array<Record<string, any>>;
      assert.deepEqual(listed.map((tool) => tool.name), ["SubtasksStart", "SubtasksInspect"]);
      for (const tool of listed) {
        const pi = fixture.piTool(tool.name);
        assert.equal(tool.description, pi.description, `${tool.name} description`);
        assert.deepEqual(tool.inputSchema, pi.parameters, `${tool.name} schema`);
      }
      assert.deepEqual(await owner.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
      assert.deepEqual((await rpc(owner, "ping")).result, {});
    });
  } finally {
    await fixture.dispose();
  }
});

test("Claude- and Codex-identified MCP sessions reach the same canonical handler with owner-assigned call ids", async () => {
  const results: Record<string, Array<Record<string, any>>> = {};
  for (const client of ["claude-code", "codex-mcp-client"]) {
    await withOwner(async (owner) => {
      const spy = spyHandler(owner.manager);
      try {
        await rpc(owner, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: client, version: "test" } });
        const start = await callTool(owner, "SubtasksStart", researchStart("parity"));
        const startText = start.content[0].text as string;
        const executionId = /exec-[0-9a-f-]{36}/.exec(startText)?.[0];
        const taskId = /task-[0-9a-f-]{36}/.exec(startText)?.[0];
        assert.ok(executionId && taskId, "Start returns handles immediately");
        const inspect = await callTool(owner, "SubtasksInspect", { executionId, taskId });
        const invalid = await callTool(owner, "SubtasksInspect", { executionId });
        assert.deepEqual(spy.calls.map(({ action, toolName }) => [action, toolName]), [
          ["start", "SubtasksStart"],
          ["inspect", "SubtasksInspect"],
          ["inspect", "SubtasksInspect"],
        ]);
        assert.deepEqual(spy.calls[0]!.params, researchStart("parity"), "the owner's snapshot of the submitted arguments runs");
        for (const call of spy.calls) {
          assert.ok(call.binding.toolCallId.startsWith(`${owner.ownerId}:call-`), "call ids come from the owner");
          assert.equal(call.binding.host, undefined, "the shared binding carries no host context");
        }
        assert.equal(start.isError, false);
        assert.match(startText, /^SubtasksStart accepted: research group exec-/);
        assert.match(startText, /queued/);
        assert.equal(inspect.isError, false);
        assert.ok((inspect.content[0].text as string).includes(executionId) && (inspect.content[0].text as string).includes(taskId),
          "Inspect returns the same execution and task handles");
        assert.equal(invalid.isError, true);
        results[client] = [start, inspect, invalid];
      } finally {
        spy.restore();
      }
    });
  }
  const mask = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>"));
  results["claude-code"]!.forEach((result, index) => assertEnvelopeParity(mask(result), mask(results["codex-mcp-client"]![index]), `result ${index}`));
});

test("Start persists the owner's raw admitted identity and a validation error matches Pi's canonical text", async () => {
  const fixture = await managedToolFixture();
  try {
    await withOwner(async (owner) => {
      const raw = researchStart("identity");
      await callTool(owner, "SubtasksStart", raw);
      assert.equal(owner.manager.startLiveness(toolCallFingerprint("SubtasksStart", raw)!).state, "active");
      const params = { executionId: "exec-missing" };
      const viaMcp = await callTool(owner, "SubtasksInspect", params);
      const viaPi = await fixture.piExecute("SubtasksInspect")("pi-invalid", params, undefined, undefined, {});
      assert.equal(viaMcp.isError, true);
      assert.equal(viaMcp.content[0].text, viaPi.content[0].text);
      assert.match(viaMcp.content[0].text, /^Invalid SubtasksInspect request: /);
      const evidence = owner.evidence.filter((event) => event.event === "tools_call");
      assert.equal(evidence[0]!.persistedIdentity, true);
      assert.match(String(evidence[0]!.rawFingerprint), /^[0-9a-f]{16}…$/, "evidence keeps only a fingerprint prefix");
    });
  } finally {
    await fixture.dispose();
  }
});

test("smoke authority refuses non-research kinds, workspace overrides, and non-object arguments before admission", async () => {
  await withOwner(async (owner) => {
    const spy = spyHandler(owner.manager);
    try {
      const refusals: Array<[string, unknown]> = [
        ["default kind", { tasks: [task("default")] }],
        ["execute", { kind: "execute", tasks: [task("execute")] }],
        ["inplace", { kind: "inplace", tasks: [task("inplace")] }],
        ["null kind", { kind: null, tasks: [task("null")] }],
        ["workspace override", { ...researchStart("workspace"), workspace: tmpdir() }],
        ["array arguments", [researchStart("array")]],
        ["string arguments", "research"],
      ];
      for (const [label, args] of refusals) {
        const result = await callTool(owner, "SubtasksStart", args);
        assert.equal(result.isError, true, label);
        assert.match(result.content[0].text, /^SubtasksStart failed closed in smoke mode: .*nothing was admitted, started, or read\.$/, label);
      }
      assert.equal(spy.calls.length, 0, "refusals never reach the canonical handler");
      assert.equal(groupCount(owner), 0, "no execution group was created");
      assert.ok(owner.evidence.filter((event) => event.event === "tools_call").every((event) => event.outcome === "refused_policy"));
    } finally {
      spy.restore();
    }
  });
});

test("unexposed tools and other MCP methods fail closed; caller metadata cannot choose the call id", async () => {
  await withOwner(async (owner) => {
    const spy = spyHandler(owner.manager);
    try {
      for (const name of ["SubtasksAdd", "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "Bash", "mcp__prg_smoke__SubtasksStart", 42]) {
        const response = await rpc(owner, "tools/call", { name, arguments: researchStart("unknown") });
        assert.equal(response.result, undefined, String(name));
        assert.equal(response.error.code, -32602, String(name));
      }
      for (const method of ["resources/list", "prompts/list", "server/discover", "tools/execute"]) {
        assert.equal((await rpc(owner, method)).error.code, -32601, method);
      }
      assert.equal(await owner.handle({ jsonrpc: "2.0", method: "resources/list" }), undefined, "notifications get no reply");
      assert.equal((await owner.handle("not an object"))!.error!.code, -32600);
      const toolParams = { name: "SubtasksStart", arguments: researchStart("invalid RPC") };
      assert.equal(await owner.handle({ jsonrpc: "2.0", method: "tools/call", params: toolParams }), undefined, "an id-less tools/call is ignored");
      for (const envelope of [{ jsonrpc: "1.0", id: 1 }, { id: 1 }, { jsonrpc: "2.0", id: null }, { jsonrpc: "2.0", id: { nested: 1 } }]) {
        const invalid = await owner.handle({ ...envelope, method: "tools/call", params: toolParams });
        assert.equal(invalid?.error?.code, -32600, JSON.stringify(envelope));
      }
      assert.equal((await owner.handle({ jsonrpc: "2.0", id: 9, params: toolParams }))?.error?.code, -32600, "a missing method is invalid");
      assert.equal(groupCount(owner), 0, "invalid RPC messages did not create a group");
      assert.equal(spy.calls.length, 0);

      // `_meta` and extra fields are never read as the call id or the owner.
      await callTool(owner, "SubtasksStart", researchStart("meta"), { _meta: { toolCallId: "attacker-call", ownerId: "attacker" }, toolCallId: "attacker-call" });
      assert.equal(spy.calls.length, 1);
      assert.ok(spy.calls[0]!.binding.toolCallId.startsWith(`${owner.ownerId}:call-`));
      assert.notEqual(spy.calls[0]!.binding.toolCallId, "attacker-call");

      // Each admission is consumed by its invocation: replaying the id is refused.
      const definition = (owner as unknown as { definitions: Map<string, { invoke(call: { toolCallId: string }): Promise<Record<string, any>> }> })
        .definitions.get("SubtasksStart")!;
      const replay = await definition.invoke({ toolCallId: spy.calls[0]!.binding.toolCallId });
      assert.equal(replay.isError, true);
      assert.match(replay.content[0].text, /no owner admission for this call and tool/);
      assert.equal(groupCount(owner), 1, "the replay created nothing");
    } finally {
      spy.restore();
    }
  });
});

test("separate owners never read each other's executions", async () => {
  await withOwner(async (first) => {
    await withOwner(async (second) => {
      assert.notEqual(first.ownerId, second.ownerId);
      assert.notEqual(first.ownerRoot, second.ownerRoot);
      const started = await callTool(first, "SubtasksStart", researchStart("first owner"));
      const text = started.content[0].text as string;
      const handles = { executionId: /exec-[0-9a-f-]{36}/.exec(text)![0], taskId: /task-[0-9a-f-]{36}/.exec(text)![0] };
      const foreign = await callTool(second, "SubtasksInspect", handles);
      assert.equal(foreign.isError, true);
      assert.match(foreign.content[0].text, new RegExp(`Unknown execution group ${handles.executionId}`));
      // The denial may echo the caller's own handle input, but no task data of the other owner.
      assert.ok(!(foreign.content[0].text as string).includes("first owner"), "the other owner's task definition is not disclosed");
      assert.ok(!(foreign.content[0].text as string).includes(first.ownerRoot), "the other owner's paths are not disclosed");
      assert.equal(groupCount(second), 0);
      assert.equal((await callTool(first, "SubtasksInspect", handles)).isError, false, "the owning session can still inspect it");
    });
  });
});

test("scratch must be a marked real directory and evidence must stay inside it", async () => {
  const unmarked = await mkdtemp(join(tmpdir(), "prg-mcp-smoke-unmarked-"));
  const scratch = await smokeScratch();
  const link = join(unmarked, "link");
  try {
    assert.throws(() => validateSmokeScratch(unmarked), /not marked as runner-owned/);
    assert.throws(() => validateSmokeScratch(join(unmarked, "missing")), /ENOENT/);
    await symlink(scratch, link);
    assert.throws(() => validateSmokeScratch(link), /real directory/);
    await rm(join(scratch, SMOKE_SCRATCH_MARKER));
    await mkdir(join(scratch, SMOKE_SCRATCH_MARKER));
    assert.throws(() => validateSmokeScratch(scratch), /not marked as runner-owned/);
    await rm(join(scratch, SMOKE_SCRATCH_MARKER), { recursive: true });
    await writeFile(join(scratch, SMOKE_SCRATCH_MARKER), "test scratch\n");
    await assert.rejects(SmokeOwner.create({ scratch, evidencePath: join(unmarked, "evidence.jsonl") }), /directly inside the smoke scratch/);
    assert.deepEqual(readdirSync(scratch), [SMOKE_SCRATCH_MARKER], "a refused owner creates nothing");
  } finally {
    await rm(unmarked, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
});

function runOwnerProcess(args: string[], lines: unknown[], timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [OWNER_SCRIPT, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`owner process exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
    for (const line of lines) child.stdin.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
    child.stdin.end();
  });
}

test("the stdio entry point refuses to start without explicit smoke authority or scratch", async () => {
  const scratch = await smokeScratch();
  try {
    const noFlag = await runOwnerProcess(["--scratch", scratch], []);
    assert.equal(noFlag.code, 2);
    assert.match(noFlag.stderr, new RegExp(`refusing to start without ${SMOKE_AUTHORITY_FLAG}`));
    const noScratch = await runOwnerProcess([SMOKE_AUTHORITY_FLAG], []);
    assert.equal(noScratch.code, 2);
    assert.match(noScratch.stderr, /--scratch is required/);
    const unknown = await runOwnerProcess([SMOKE_AUTHORITY_FLAG, "--scratch", scratch, "--listen", "0.0.0.0:1"], []);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown argument --listen/);
    for (const result of [noFlag, noScratch, unknown]) assert.equal(result.stdout, "");
    assert.deepEqual(readdirSync(scratch), [SMOKE_SCRATCH_MARKER]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("the stdio entry point serves newline-delimited JSON-RPC, tears down on stdin close, and keeps evidence sanitized", async () => {
  const scratch = await smokeScratch();
  const evidencePath = join(scratch, "evidence.jsonl");
  try {
    const run = await runOwnerProcess([SMOKE_AUTHORITY_FLAG, "--scratch", scratch, "--evidence", evidencePath, "--label", "stdio"], [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "stdio-test", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "SubtasksStart", arguments: researchStart("stdio") } },
      "{ not json",
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "SubtasksStart", arguments: { kind: "execute", tasks: [task("stdio")] } } },
    ]);
    assert.equal(run.code, 0, run.stderr);
    const responses = run.stdout.trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    assert.deepEqual(responses.map((response) => response.id), [1, 2, 3, null, 4]);
    assert.equal(responses[3]!.error.code, -32700);
    assert.equal(responses[2]!.result.isError, false);
    assert.equal(responses[4]!.result.isError, true);
    const evidence = readFileSync(evidencePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    assert.deepEqual(evidence.map((event) => event.event), ["owner_ready", "initialize", "tools_list", "tools_call", "tools_call", "owner_exit", "owner_disposed"]);
    assert.equal(evidence.at(-1)!.mode, "graceful");
    assert.equal(evidence[3]!.outcome, "admitted");
    assert.equal(evidence[4]!.outcome, "refused_policy");
    const serialized = JSON.stringify(evidence);
    assert.ok(!serialized.includes(tmpdir()), "evidence carries no filesystem paths");
    assert.ok(!/"(env|headers|authorization|apiKey)"/i.test(serialized), "evidence carries no environment or headers");
    assert.deepEqual(readdirSync(scratch).sort(), [SMOKE_SCRATCH_MARKER, "evidence.jsonl"].sort(), "the owner removed its own directory");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("the mock plan orders the steps and denies the foreign handles first on a second launch", () => {
  const results: ObservedToolResult[] = [];
  const foreign = { executionId: "exec-00000000-0000-4000-8000-000000000000", taskId: "task-00000000-0000-4000-8000-000000000000" };
  const own = { executionId: "exec-11111111-1111-4111-8111-111111111111", taskId: "task-11111111-1111-4111-8111-111111111111" };
  const steps: string[] = [];
  for (;;) {
    const next = nextSmokeCall(results, foreign, true);
    if (!next) break;
    steps.push(`${next.step}:${next.tool}`);
    const text = next.step === "start_research" ? `SubtasksStart accepted: research group ${own.executionId} ... ${own.taskId}` : "result";
    results.push({ step: next.step, text });
    if (next.step === "inspect_own") assert.deepEqual(next.input, own);
    if (next.step === "inspect_foreign") assert.deepEqual(next.input, foreign);
    if (next.step === "start_execute") assert.equal(next.input.kind, "execute");
    if (next.step === "start_research") assert.equal(next.input.kind, "research");
    if (next.step === "inspect_invalid") assert.deepEqual(next.input, { executionId: own.executionId });
  }
  assert.deepEqual(steps, [
    "tool_search:ToolSearch",
    "inspect_foreign:SubtasksInspect",
    "start_execute:SubtasksStart",
    "start_research:SubtasksStart",
    "inspect_own:SubtasksInspect",
    "inspect_invalid:SubtasksInspect",
  ]);
  assert.equal(nextSmokeCall([{ step: "start_execute", text: "" }, { step: "start_research", text: "no handles" }], undefined, false), undefined,
    "the plan stops instead of guessing handles");
});

test("the mock provider listens on loopback only and requires the synthetic key", async () => {
  const provider = await startMockProvider();
  try {
    assert.match(provider.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    provider.setLaunch("probe");
    const body = JSON.stringify({ model: "m", stream: false, messages: [], tools: [] });
    const denied = await fetch(`${provider.baseUrl}/v1/messages`, { method: "POST", body, headers: { "content-type": "application/json", "x-api-key": "other" } });
    assert.equal(denied.status, 401);
    const allowed = await fetch(`${provider.baseUrl}/v1/messages`, { method: "POST", body, headers: { "content-type": "application/json", "x-api-key": SMOKE_SYNTHETIC_API_KEY } });
    assert.equal(allowed.status, 200);
    assert.equal(((await allowed.json()) as Record<string, any>).content[0].text, "ok", "side requests get a plain answer");
    const unknown = await fetch(`${provider.baseUrl}/v1/models`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(provider.journal.map((entry) => entry.event), ["request_unauthorized", "anthropic_side_request", "request_unhandled"]);
    assert.ok(!JSON.stringify(provider.journal).includes(SMOKE_SYNTHETIC_API_KEY), "the journal never records the key");

    // Caller-controlled strings at the HTTP boundary never reach the journal.
    const marker = "sk-ant-prgHTTPMARKER123";
    const headers = { "content-type": "application/json", "x-api-key": SMOKE_SYNTHETIC_API_KEY };
    await fetch(`${provider.baseUrl}/v1/${marker}/home/prg-marker-user`, { method: "POST", body: "{}", headers });
    const anthropic = await fetch(`${provider.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "m",
        stream: false,
        tools: [{ name: "ToolSearch" }, { name: `mcp__prg_smoke__${marker}`, defer_loading: true }],
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: `prgsmoke_${marker}`, name: "x", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: `prgsmoke_${marker}`, content: marker }] },
        ],
      }),
    });
    assert.equal(anthropic.status, 200);
    const responses = await fetch(`${provider.baseUrl}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SMOKE_SYNTHETIC_API_KEY}` },
      body: JSON.stringify({
        tools: [{ type: "namespace", name: "mcp__prg_smoke", tools: [{ type: "function", name: marker }] }],
        input: [{ type: "function_call_output", call_id: `prgsmoke_${marker}`, output: marker }],
      }),
    });
    assert.equal(responses.status, 200);
    await responses.text();
    const journal = JSON.stringify(provider.journal);
    assert.ok(!journal.includes(marker) && !journal.includes("prg-marker-user"), journal);
    const turns = provider.journal.filter((entry) => entry.event === "anthropic_turn" || entry.event === "responses_turn");
    assert.equal(turns.length, 2);
    for (const turn of turns) {
      assert.deepEqual(turn.resultsSeen, [], "an unknown prgsmoke_ suffix is not a plan step");
      assert.equal(turn.smokeToolCount, 1, "advertised tools are counted, not named");
    }
  } finally {
    await provider.close();
  }
});

test("evidence must be a new file directly under the scratch; an existing symlink is refused without touching its target", async () => {
  const scratch = await smokeScratch();
  const outside = await mkdtemp(join(tmpdir(), "prg-mcp-smoke-outside-"));
  try {
    const target = join(outside, "target.jsonl");
    await writeFile(target, "original\n");
    await symlink(target, join(scratch, "evidence-link.jsonl"));
    await assert.rejects(SmokeOwner.create({ scratch, evidencePath: join(scratch, "evidence-link.jsonl") }), /existing files and symlinks are refused/);
    assert.equal(await readFile(target, "utf8"), "original\n", "the symlink target was not written");
    await symlink(target, join(scratch, "dangling-or-not.jsonl"));
    await rm(target);
    await assert.rejects(SmokeOwner.create({ scratch, evidencePath: join(scratch, "dangling-or-not.jsonl") }), /existing files and symlinks are refused/);
    assert.equal(existsSync(target), false, "a dangling evidence symlink is not followed to create its target");
    await writeFile(join(scratch, "existing.jsonl"), "keep\n");
    await assert.rejects(SmokeOwner.create({ scratch, evidencePath: join(scratch, "existing.jsonl") }), /existing files and symlinks are refused/);
    assert.equal(await readFile(join(scratch, "existing.jsonl"), "utf8"), "keep\n");
    await mkdir(join(scratch, "sub"));
    await symlink(outside, join(scratch, "linked-dir"));
    for (const nested of [join(scratch, "sub", "evidence.jsonl"), join(scratch, "linked-dir", "evidence.jsonl"), join(scratch, "evidence.txt")]) {
      await assert.rejects(SmokeOwner.create({ scratch, evidencePath: nested }), /directly inside the smoke scratch/, nested);
    }
    assert.deepEqual(readdirSync(outside), [], "nothing was created outside the scratch");
    assert.ok(!readdirSync(scratch).some((name) => name.startsWith("owner-")), "a refused sink creates no owner");
    // A fresh name works and is written through the descriptor opened at creation.
    const owner = await SmokeOwner.create({ scratch, evidencePath: join(scratch, "fresh.jsonl") });
    await owner.dispose();
    assert.match(await readFile(join(scratch, "fresh.jsonl"), "utf8"), /"event":"owner_disposed"/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("evidence keeps only allowlisted fields when callers send paths, secrets, and malformed handles", async () => {
  const markers = ["/home/prg-marker-user/private", "sk-ant-prgSECRETMARKER123", "PRG_PATH_MARKER"];
  // These match the shapes a looser allowlist would accept.
  const [name, version, tool, method] = ["claude-privateclientmarker", "1.2.3-privateversion", "PRG_PRIVATE_TOOL", "private/methodMarker"] as const;
  await withOwner(async (owner) => {
    await rpc(owner, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name, version } });
    const malformed = [
      { executionId: markers[0], taskId: markers[1] },
      { executionId: { nested: markers[2] }, taskId: [markers[0]] },
      { executionId: `exec-${markers[2]}`, taskId: "task-x" },
    ];
    for (const args of malformed) {
      const result = await callTool(owner, "SubtasksInspect", args);
      assert.equal(result.isError, true);
    }
    await callTool(owner, "SubtasksStart", { kind: markers[1], tasks: [task("marker")] });
    await rpc(owner, "tools/call", { name: tool, arguments: {} });
    await rpc(owner, method);
    const serialized = JSON.stringify(owner.evidence);
    for (const marker of [...markers, name, version, tool, method]) assert.ok(!serialized.includes(marker), `evidence must not contain ${marker}`);
    const inspects = owner.evidence.filter((event) => event.event === "tools_call" && event.tool === "SubtasksInspect");
    assert.deepEqual(inspects.map((event) => event.requestHandles), [
      { executionId: "<invalid>", taskId: "<invalid>" },
      { executionId: "<invalid>", taskId: "<invalid>" },
      { executionId: "<invalid>", taskId: "<invalid>" },
    ]);
    assert.ok(inspects.every((event) => typeof event.resultClass === "string" && !("textHead" in event)), "results are classified, never copied");
    const init = owner.evidence.find((event) => event.event === "initialize");
    assert.deepEqual(init?.client, { name: "claude" });
    const refused = owner.evidence.find((event) => event.outcome === "refused_policy");
    assert.equal(refused?.refusal, "kind_not_research");
    assert.equal(owner.evidence.find((event) => event.outcome === "refused_unknown_tool")?.tool, "<unknown>");
    assert.ok(owner.evidence.some((event) => event.event === "method_refused" && Object.keys(event).sort().join() === "at,event"),
      "a refused method is a fixed marker");
  });
});

test("the mock journal records result classes and validated handles, never raw delivered text", () => {
  const codexWrapped = deliveredResult({ step: "inspect_foreign", text: "Wall time: 0.01 seconds\nOutput:\nSubtasksInspect failed: Unknown execution group /home/prg-marker/x.\nmore" });
  assert.deepEqual(codexWrapped, { step: "inspect_foreign", isError: null, resultClass: "unknown_execution", handles: null });
  const accepted = deliveredResult({
    step: "start_research",
    isError: false,
    text: "SubtasksStart accepted: research group exec-11111111-1111-4111-8111-111111111111 ... task-22222222-2222-4222-8222-222222222222",
  });
  assert.deepEqual(accepted.handles, { executionId: "exec-11111111-1111-4111-8111-111111111111", taskId: "task-22222222-2222-4222-8222-222222222222" });
  assert.equal(accepted.resultClass, "start_accepted");
  assert.ok(!JSON.stringify(codexWrapped).includes("prg-marker"));
});

test("managed policy for the chosen CLI blocks the run before anything starts", async () => {
  assert.deepEqual(managedPolicyLocations("claude", "linux"), ["/etc/claude-code"]);
  assert.deepEqual(managedPolicyLocations("codex", "linux"), ["/etc/codex"]);
  assert.ok(managedPolicyLocations("claude", "darwin").some((location) => location.includes("com.anthropic.claudecode")));
  assert.deepEqual(managedPolicyBlockers("claude", () => false, "linux"), []);
  assert.match(managedPolicyBlockers("claude", (path) => path === "/etc/claude-code", "linux")[0]!, /managed policy is present at \/etc\/claude-code/);
  assert.match(managedPolicyBlockers("codex", () => false, "win32")[0]!, /POSIX-only/);
});

const RUNNER_SCRIPT = join(__dirname, "managed-tool-mcp-smoke.js");

/**
 * Writes an executable fake CLI. The runner gives it HOME = <scratch>/home,
 * so <scratch-parent> is two levels up; the fake writes its records there.
 */
async function fakeCli(dir: string, name: string, body: string, versionLine = "fake-cli 0.0.0"): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/usr/bin/env node\n"use strict";\nconst { join } = require("node:path");\nconst parent = join(process.env.HOME, "..", "..");\nif (process.argv.includes("--version")) { console.log(${JSON.stringify(versionLine)}); process.exit(0); }\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/**
 * True when the process no longer runs. On Linux an already-dead zombie
 * (state Z), which a non-reaping PID 1 may leave behind, is not running.
 */
function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
    } catch {
      return true;
    }
  }
  return false;
}

async function until(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

/**
 * Waits until `<parent>/fake-pids.json` parses into the expected shape, inside
 * the caller's deadline. The fake CLIs publish their records atomically (a
 * temporary sibling plus renameSync), and this readiness check keeps the test
 * from parsing a file another process has created but not finished writing.
 */
async function readFakePids<T>(parent: string, timeoutMs: number, label: string, isShape: (value: any) => value is T): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = JSON.parse(readFileSync(join(parent, "fake-pids.json"), "utf8"));
      if (isShape(value)) return value;
    } catch {
      // Not published yet, or not fully landed: keep waiting inside the deadline.
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

for (const keep of [false, true]) {
  test(`SIGINT to the runner terminates the active CLI process group and removes the scratch${keep ? " even with --keep" : ""}`, { timeout: 60_000 }, async (t) => {
    if (process.platform === "win32" || managedPolicyBlockers("claude").length > 0) {
      t.skip("runner preflight would refuse on this host");
      return;
    }
    const parent = await mkdtemp(join(tmpdir(), "prg-mcp-smoke-interrupt-"));
    try {
      // The fake CLI ignores SIGTERM (so termination must escalate) and starts a
      // grandchild in the same process group.
      const bin = await fakeCli(parent, "fake-hang-cli.cjs", `
const { spawn } = require("node:child_process");
const { renameSync, writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
// Publish atomically so a reader never sees the file before its bytes land.
const record = join(parent, "fake-pids.json");
writeFileSync(record + ".tmp", JSON.stringify({ cli: process.pid, grandchild: grandchild.pid }));
renameSync(record + ".tmp", record);
setInterval(() => {}, 1000);`);
      const args = [RUNNER_SCRIPT, "--cli", "claude", "--cli-bin", bin, "--scratch-parent", parent, "--timeout-ms", "60000", ...(keep ? ["--keep"] : [])];
      const runner = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      runner.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      const exited = new Promise<number | null>((resolveExit) => runner.on("close", (code) => resolveExit(code)));
      const pids = await readFakePids(parent, 20_000, "the fake CLI to start", (value: any): value is { cli: number; grandchild: number } => typeof value?.cli === "number" && typeof value?.grandchild === "number");
      assert.ok(readdirSync(parent).some((name) => name.startsWith("prg-mcp-smoke-")), "the scratch exists while the CLI runs");
      runner.kill("SIGINT");
      const code = await exited;
      assert.equal(code, 130, stdout);
      assert.match(stdout, /INTERRUPTED by SIGINT/);
      assert.doesNotMatch(stdout, /scratch kept at/, "interruption takes precedence over --keep");
      await until(() => processGone(pids.cli) && processGone(pids.grandchild), 10_000, "the CLI group to be gone");
      assert.deepEqual(readdirSync(parent).filter((name) => name.startsWith("prg-mcp-smoke-")), [], "the scratch was removed");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
}

test("after an ordinary CLI exit, a lingering same-group child that ignores SIGTERM cannot keep running", { timeout: 60_000 }, async (t) => {
  if (process.platform === "win32" || managedPolicyBlockers("claude").length > 0) {
    t.skip("runner preflight would refuse on this host");
    return;
  }
  const parent = await mkdtemp(join(tmpdir(), "prg-mcp-smoke-linger-"));
  try {
    // The CLI exits 0 once its grandchild (inherited stdio, same process group)
    // has installed a do-nothing SIGTERM handler and recorded its pid, so a
    // SIGTERM-only cleanup cannot win by racing the handler installation.
    const bin = await fakeCli(parent, "fake-linger-cli.cjs", `
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const pidFile = join(parent, "fake-pids.json");
const script = "process.on('SIGTERM', () => {}); const fs = require('node:fs'); const tmp = process.argv[1] + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ grandchild: process.pid })); fs.renameSync(tmp, process.argv[1]); setInterval(() => {}, 1000)";
spawn(process.execPath, ["-e", script, pidFile], { stdio: "inherit" });
// Readiness, not mere existence: only a fully published record releases the CLI.
const ready = setInterval(() => { try { JSON.parse(readFileSync(pidFile, "utf8")); clearInterval(ready); process.exit(0); } catch { /* not published yet */ } }, 20);`);
    const result = await new Promise<{ code: number | null; stdout: string }>((resolveRun) => {
      const runner = spawn(process.execPath, [RUNNER_SCRIPT, "--cli", "claude", "--cli-bin", bin, "--scratch-parent", parent, "--timeout-ms", "20000"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      runner.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      runner.on("close", (code) => resolveRun({ code, stdout }));
    });
    assert.equal(result.code, 1, result.stdout);
    assert.doesNotMatch(result.stdout, /CLI launch hit its deadline/, "inherited pipes must not turn a normal exit into a timeout");
    const pids = await readFakePids(parent, 5_000, "the lingering grandchild's pid record", (value: any): value is { grandchild: number } => typeof value?.grandchild === "number");
    await until(() => processGone(pids.grandchild), 5_000, "the lingering grandchild to stop running");
    assert.deepEqual(readdirSync(parent).filter((name) => name.startsWith("prg-mcp-smoke-")), [], "the scratch was removed");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the runner report withholds raw CLI stderr and stdout", { timeout: 60_000 }, async (t) => {
  if (process.platform === "win32" || managedPolicyBlockers("codex").length > 0) {
    t.skip("runner preflight would refuse on this host");
    return;
  }
  const parent = await mkdtemp(join(tmpdir(), "prg-mcp-smoke-noisy-"));
  const markers = ["/home/prg-marker-user/private/file", "sk-ant-prgSECRETMARKER123"];
  try {
    const bin = await fakeCli(parent, "fake-noisy-cli.cjs", `
process.stdout.write(${JSON.stringify(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: markers.join(" ") } }) + "\n")});
process.stderr.write(${JSON.stringify(`error at ${markers[0]} with key ${markers[1]}\n`)});
process.exit(1);`, "prgVERSIONTOKEN0123456789abcdef");
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
      const runner = spawn(process.execPath, [RUNNER_SCRIPT, "--cli", "codex", "--cli-bin", bin, "--scratch-parent", parent, "--timeout-ms", "20000", "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      runner.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      runner.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      runner.on("close", (code) => resolveRun({ code, stdout, stderr }));
    });
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stdout, /CLI stderr: 1 line\(s\) withheld from the sanitized report/);
    assert.match(result.stdout, /managed-tool MCP smoke \(codex\): FAIL/);
    for (const marker of [...markers, "prgVERSIONTOKEN0123456789abcdef"]) {
      assert.ok(!result.stdout.includes(marker) && !result.stderr.includes(marker), `runner output must not contain ${marker}`);
    }
    assert.match(result.stdout, /codex version: <unrecognized version output>/);
    assert.deepEqual(readdirSync(parent).filter((name) => name.startsWith("prg-mcp-smoke-")), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

const requestedClis = (process.env.PI_REVIEW_GATE_MCP_SMOKE_CLI ?? "").split(",").map((value) => value.trim()).filter(Boolean);
for (const cli of ["claude", "codex"] as const satisfies readonly SmokeCli[]) {
  test(`real ${cli} CLI drives shared Start/Inspect over MCP against a loopback mock (opt-in)`, { timeout: 420_000 }, async (t) => {
    if (!requestedClis.includes(cli)) {
      t.skip(`set PI_REVIEW_GATE_MCP_SMOKE_CLI=${cli} to run the real ${cli} CLI smoke`);
      return;
    }
    assert.ok(resolveOnPath(cli), `${cli} was requested by PI_REVIEW_GATE_MCP_SMOKE_CLI but is not on PATH`);
    const report = await runManagedToolMcpSmoke({ cli, timeoutMs: 150_000 });
    const summary = JSON.stringify({ problems: report.problems, launches: report.launches.map((launch) => ({ label: launch.label, problems: launch.problems })) });
    assert.equal(report.passed, true, summary);
    assert.equal(report.scratchRemoved, true);
    const [a, b] = report.launches;
    assert.equal(a!.prompts + b!.prompts, 2, "one prompt per launch");
    assert.notEqual(a!.ownerId, b!.ownerId);
    assert.equal(b!.foreignDenied, true);
    assert.deepEqual(a!.inspect, a!.start);
    assert.deepEqual(b!.inspect, b!.start);
    if (cli === "claude") assert.equal(a!.usedToolSearch, true, "Claude reached the deferred MCP tools through native ToolSearch");
    assert.ok(!existsSync(report.scratch ?? "/nonexistent-scratch"));
  });
}
