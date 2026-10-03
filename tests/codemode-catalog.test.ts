import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeExecutorAdapter } from "../src/execution/adapters/claude-cli";
import { RESEARCH_ALLOWED_TOOLS } from "../src/execution/tool";
import {
  createExecutorToolCatalog,
  createPiWorkerToolCatalog,
  defaultExecutorInitialActiveTools,
  DEFERRED_TOOL_SEARCH_NAME,
} from "../src/execution/tool-catalog";

/**
 * Dedicated codemode catalog regression (#224): the tool follows the ordinary
 * existing deferred-tools setting — deferred ON keeps it in the allowed
 * execute/orchestrate ceilings for search_tools activation but never in the
 * conservative initial subset; deferred OFF runs the full-active contract;
 * read-only research catalogs always exclude it, with no special exceptions.
 * Unsupported external adapter mappings preserve no authorization widening.
 */

interface FakeQueueInput {
  uuid: string;
}

interface FakeSdkOptions extends Record<string, unknown> {
  tools: unknown;
  allowedTools?: string[];
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    context: Record<string, unknown>,
  ) => Promise<{ behavior: "allow" | "deny"; message?: string }>;
}

/**
 * Minimal single-turn SDK fake: every streaming input immediately emits the
 * terminal result for that input, so an executor run settles without any
 * steering and the captured options expose the read-only research profile.
 */
function createSettlingFakeQuery(
  prompt: AsyncIterable<FakeQueueInput>,
): { next(): Promise<IteratorResult<unknown>>; return: () => Promise<IteratorResult<unknown>>; throw: (error?: unknown) => Promise<never>; [Symbol.asyncIterator](): unknown; initializationResult: () => Promise<Record<string, unknown>>; interrupt: () => Promise<{ still_queued: number[] }>; close: () => void } {
  const values: unknown[] = [];
  let closed = false;
  const waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  const push = (value: unknown): void => {
    const waiter = waiters.shift();
    if (waiter) waiter({ value, done: false });
    else values.push(value);
  };
  void (async () => {
    for await (const message of prompt) {
      push({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "claude complete",
        user_message_uuid: message.uuid,
        session_id: "codemode-claude",
        uuid: `result-${message.uuid}`,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: {},
        permission_denials: [],
      });
    }
  })();
  const next = (): Promise<IteratorResult<unknown>> => {
    const value = values.shift();
    if (value) return Promise.resolve({ value, done: false });
    if (closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolvePromise) => waiters.push(resolvePromise));
  };
  return {
    next,
    return: async () => ({ value: undefined, done: true }),
    throw: async (error?: unknown) => { throw error; },
    [Symbol.asyncIterator]() { return this; },
    initializationResult: async () => ({ commands: [], agents: [], output_style: "", available_output_styles: [], models: [], account: {} }),
    interrupt: async () => ({ still_queued: [] }),
    close: () => {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
  };
}

test("Pi worker launch catalogs keep authorized codemode deferred, never initial-active (#224)", () => {
  const authorized = ["read", "bash", "codemode", "SubtasksStart", "SubtasksSteer"];
  // Deferred tools ON: the durable initial subset is derived through the
  // conservative order, so the tool stays search-deferred even when launched.
  const worker = createPiWorkerToolCatalog(
    createExecutorToolCatalog(authorized, defaultExecutorInitialActiveTools(authorized)),
  );
  // The tool stays launchable in the allowed ceiling: the existing Pi adapter
  // derives --tools from exactly this set, so search_tools activation works
  // with no adapter change; delegation controls alone are stripped, and
  // recursive delegation stays unregistered.
  assert.deepEqual(worker.initialActiveTools, ["read", "bash"]);
  assert.equal(worker.allowedToolCatalog.includes("codemode"), true);
  const launchTools = [...new Set([...worker.allowedToolCatalog, DEFERRED_TOOL_SEARCH_NAME])];
  assert.equal(launchTools.includes("codemode"), true);
  assert.equal(launchTools.includes("SubtasksStart"), false);
  assert.equal(launchTools.includes("SubtasksSteer"), false);

  // Deferred tools OFF: the ordinary full-active contract includes the
  // authorized tool with no exception.
  const fullActive = createPiWorkerToolCatalog(createExecutorToolCatalog(authorized, authorized));
  assert.deepEqual(fullActive.initialActiveTools, ["read", "bash", "codemode"]);

  // An unadmitted tool produces no launch capability and no widening.
  const excluded = createPiWorkerToolCatalog(createExecutorToolCatalog(["read", "bash"]));
  const excludedLaunch = [...new Set([...excluded.allowedToolCatalog, DEFERRED_TOOL_SEARCH_NAME])];
  assert.equal(excluded.allowedToolCatalog.includes("codemode"), false);
  assert.equal(excludedLaunch.includes("codemode"), false);
});

test("read-only research policy always excludes codemode from researcher catalogs (#224)", () => {
  // The policy entry itself stays absent, so the research intersection cannot
  // admit the tool even when the parent ceiling or an explicit user tool list
  // carries it.
  assert.equal(RESEARCH_ALLOWED_TOOLS.has("codemode"), false);
});

test("Claude's unsupported external mapping drops codemode without authorization widening (#224)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-codemode-claude-"));
  try {
    const artifactDir = join(dir, "artifacts");
    await mkdir(artifactDir);
    let capturedOptions: FakeSdkOptions | undefined;
    const loadSdk = async () => ({
      query: ((params: { prompt: AsyncIterable<FakeQueueInput>; options: FakeSdkOptions }) => {
        capturedOptions = params.options;
        return createSettlingFakeQuery(params.prompt);
      }) as unknown as typeof import("@anthropic-ai/claude-agent-sdk")["query"],
    });
    const adapter = new ClaudeExecutorAdapter(
      { id: "claude", adapter: "claude-cli", command: "claude", model: "sonnet" },
      { loadSdk },
    );
    const result = await adapter.run({
      cwd: dir,
      prompt: "research against the captured catalog",
      artifactDir,
      turn: 1,
      workspaceAccess: "read-only",
      executorToolCatalog: {
        // A durable ceiling that carried the tool plus a write-capable tool:
        // both vanish in the Claude role mapping. Defense in depth on top of
        // the research exclusion — unsupported external adapters never
        // widen to a Pi-native tool name they cannot execute.
        allowedToolCatalog: ["read", "grep", "WebFetch", "codemode", "bash"],
        initialActiveTools: ["read", "codemode"],
      },
    });
    assert.equal(result.failure, undefined);
    assert.equal(result.text, "claude complete");
    // Codemode is a Pi-native tool with no Claude mapping; the role profile
    // keeps only its own known read-only names and never widens to bash.
    assert.deepEqual(capturedOptions?.tools, ["Read", "Grep", "WebFetch"]);
    assert.deepEqual(capturedOptions?.allowedTools, ["Read", "Grep", "WebFetch"]);
    const canUseTool = capturedOptions?.canUseTool;
    assert.ok(canUseTool, "read-only runs install the fail-closed tool policy");
    assert.equal((await canUseTool("Codemode", {}, {})).behavior, "deny");
    assert.equal((await canUseTool("Bash", {}, {})).behavior, "deny");
    assert.equal((await canUseTool("Read", {}, {})).behavior, "allow");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});