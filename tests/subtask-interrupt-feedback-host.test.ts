/**
 * Issue #191 real-host coverage: a human /subtask-interrupt must be visible to
 * the NEXT model request outside any tool call.
 *
 * Runs inside the installed Pi 1.x SDK (in-process `createAgentSession` with
 * an in-memory session/settings, `DefaultResourceLoader` inline extension
 * factories, and Pi's own public `fauxProvider` — no provider API, credential,
 * or network use). The registered `/subtask-interrupt` command is invoked
 * through the host's own `session.prompt()` command dispatch, drives the real
 * ExecutionToolManager/BackgroundExecutionController with a real executor
 * process in a scratch git repository, and the assertions read what the faux
 * model actually received in its request context.
 *
 * The installed host resolves through `resolvePiHost` (PI_REVIEW_GATE_INSTALLED_AGENT
 * pins it). Without one the file skips with a reason, or fails under
 * PI_REVIEW_GATE_REQUIRE_PI_HOST=1 (tests/tool-host-gate.ts).
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { BackgroundExecutionController } from "../src/execution/background-controller";
import { deliverInterruptFeedback, SUBTASK_INTERRUPT_FEEDBACK_CUSTOM_TYPE } from "../src/execution/interrupt-feedback";
import { ExecutionToolManager } from "../src/execution/tool";
import { createState } from "../src/state";
import { controllerInternals, initGitRepo, waitFor, waitForAsync } from "./helpers/background-controller-fixtures";
import { resolvePiHost, type PiHostResolution } from "./pi-native-mcp-fixture";
import { registerMissingHostPlaceholder } from "./tool-host-gate";

const INTENT = "User intent: interrupted by user; do not restart without authorization.";

function resolveHost(): { host: PiHostResolution; sdk: any; ai: any } | { reason: string } {
  let host: PiHostResolution;
  try {
    host = resolvePiHost();
  } catch (error) {
    return { reason: `installed Pi host unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    const req = createRequire(join(host.agentDir, "package.json"));
    const sdk = req(join(host.agentDir, "dist", "index.js"));
    const aiCandidates = [
      join(host.agentDir, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
      join(host.agentDir, "..", "pi-ai", "dist", "index.js"),
    ];
    const aiEntry = aiCandidates.find((candidate) => existsSync(candidate));
    if (!aiEntry) return { reason: `pi-ai faux provider not found beside ${host.agentDir}` };
    const ai = req(aiEntry);
    for (const name of ["createAgentSession", "DefaultResourceLoader", "SessionManager", "SettingsManager", "ModelRuntime"]) {
      if (typeof sdk[name] !== "function") return { reason: `installed Pi SDK lacks ${name}` };
    }
    if (typeof ai.fauxProvider !== "function") return { reason: "installed pi-ai lacks fauxProvider" };
    return { host, sdk, ai };
  } catch (error) {
    return { reason: `installed Pi SDK unloadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const resolved = resolveHost();

interface RequestMessage { role: string; text: string }
type Hook = () => Promise<unknown>;

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((block: any) => (block?.type === "text" ? String(block.text ?? "") : `[${block?.type}]`)).join("\n");
}

function config(executor: string): ReviewGateConfig {
  return normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      "interrupt-host": { adapter: "run-as-binary", command: executor, execution: { protocol: "pi-review-executor-jsonl-v1" } },
    },
    execution: {
      maxWorkers: 2,
      workerResources: { default: { selection: { source: "external", id: "interrupt-host" }, maxConcurrent: 2 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
    retainBundles: "always",
  });
}

/**
 * Resources one test owns, released in reverse acquisition order once the
 * test body (or a partial setup) ends. Owned executor children are settled
 * first and proven quiescent through the controller's own #310 durable
 * ownership check; the scratch tree is deleted only afterwards, so a possibly
 * live writer's ownership evidence is retained and reported, never removed.
 */
interface OwnedScope { scratch?: string; settlers: Array<() => Promise<string[]>> }

/** Shut the manager down, then report every task whose owned writer may still be live. */
async function settleOwnedManager(manager: ExecutionToolManager): Promise<string[]> {
  const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
  // The prototype method, so an instance-level fault seam cannot mask a live writer.
  const unverifiedWriter = (BackgroundExecutionController.prototype as unknown as {
    unverifiedWriterAfterInterrupt: (group: unknown, task: unknown) => Promise<string | undefined>;
  }).unverifiedWriterAfterInterrupt;
  try {
    await manager.shutdown();
    const uncertain: string[] = [];
    for (const group of controllerInternals(controller).groups.values()) {
      for (const task of group.tasks) {
        const reason = await unverifiedWriter.call(controller, group, task);
        if (reason) uncertain.push(`${task.taskId}: ${reason}`);
      }
    }
    return uncertain;
  } finally {
    await manager.detach();
  }
}

async function releaseOwned(scope: OwnedScope): Promise<void> {
  const failures: unknown[] = [];
  const uncertain: string[] = [];
  for (const settle of scope.settlers.splice(0).reverse()) {
    try {
      uncertain.push(...await settle());
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0 || uncertain.length > 0) {
    throw new AggregateError(failures, `owned executor children were not proven settled${uncertain.length > 0 ? ` (${uncertain.join("; ")})` : ""}; retained ${scope.scratch ?? "no scratch tree"} as ownership evidence`);
  }
  if (scope.scratch) await rm(scope.scratch, { recursive: true, force: true });
}

/** A body or setup failure always wins over a release failure, which is still reported. */
async function withOwnedScope(body: (scope: OwnedScope) => Promise<void>): Promise<void> {
  const scope: OwnedScope = { settlers: [] };
  let primary: { error: unknown } | undefined;
  try {
    await body(scope);
  } catch (error) {
    primary = { error };
  }
  try {
    await releaseOwned(scope);
  } catch (releaseError) {
    if (!primary) throw releaseError;
    console.warn(`#191 fixture release also failed after the primary failure: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
  }
  if (primary) throw primary.error;
}

if ("reason" in resolved) {
  registerMissingHostPlaceholder("issue #191 real-host interrupt feedback", resolved.reason);
} else {
  const { sdk, ai } = resolved;

  async function scratchRepo(scope: OwnedScope, label: string): Promise<{ scratch: string; repo: string; agentDir: string; executor: string }> {
    const scratch = await mkdtemp(join(tmpdir(), `pi-review-interrupt-host-${label}-`));
    scope.scratch = scratch;
    const repo = join(scratch, "repo");
    const agentDir = join(scratch, "agent");
    await mkdir(repo, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await initGitRepo(repo);
    const executor = join(scratch, "slow-executor.cjs");
    await writeFile(executor, [
      "#!/usr/bin/env node",
      "const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{",
      "fs.writeFileSync('draft.txt','recover me\\n');",
      "setTimeout(()=>console.log(JSON.stringify({type:'assistant',text:'late completion'})),30000);",
      "});",
    ].join("\n"), "utf8");
    await chmod(executor, 0o755);
    return { scratch, repo, agentDir, executor };
  }

  async function hostSession(scope: OwnedScope, label: string, paths: { repo: string; agentDir: string; executor: string }) {
    const requests: RequestMessage[][] = [];
    const hooks: Hook[] = [];
    const providerId = `prg-interrupt-${label}`;
    const faux = ai.fauxProvider({
      provider: providerId,
      models: [{ id: "driven", name: "Interrupt feedback driven model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 16_384 }],
    });
    const respond = async (context: any) => {
      faux.appendResponses([respond]);
      requests.push((context.messages ?? []).map((message: any) => ({ role: String(message.role), text: messageText(message) })));
      const hook = hooks.shift();
      if (hook) return await hook();
      return ai.fauxAssistantMessage("acknowledged", { stopReason: "stop" });
    };
    faux.appendResponses([respond]);
    let manager: ExecutionToolManager | undefined;
    let session: any;
    let extensionPi: any;
    // Owned before anything is created, so a partial setup (a factory that ran,
    // a session that failed to bind) still settles every manager it made and
    // disposes its session; managers are settled before the session goes.
    const managers: ExecutionToolManager[] = [];
    scope.settlers.push(async () => {
      try {
        const uncertain: string[] = [];
        for (const owned of managers) uncertain.push(...await settleOwnedManager(owned));
        return uncertain;
      } finally {
        try { session?.dispose(); } catch { /* already disposed */ }
      }
    });
    const factory = (pi: any) => {
      extensionPi = pi;
      pi.registerProvider(faux.provider);
      pi.registerTool({
        name: "PrgNoop",
        label: "PrgNoop",
        description: "Test-only no-op tool.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ content: [{ type: "text", text: "noop" }], details: {} }),
      });
      manager = new ExecutionToolManager({ pi, config: config(paths.executor), state: createState(), cwd: () => paths.repo });
      managers.push(manager);
      pi.on("session_start", async (_event: unknown, ctx: any) => {
        manager!.sync();
        const model = ctx.modelRegistry.find(providerId, "driven");
        assert.ok(model, "faux model registered");
        assert.equal(await pi.setModel(model), true, "faux model selected");
      });
    };
    const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd: paths.repo,
      agentDir: paths.agentDir,
      settingsManager,
      extensionFactories: [factory],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();
    const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(paths.agentDir, "auth.json"), modelsPath: join(paths.agentDir, "models.json") });
    // A synthetic in-memory key for the local faux provider only; no real
    // credential exists and no network request is possible.
    await modelRuntime.setRuntimeApiKey(providerId, "faux-local-test-key");
    ({ session } = await sdk.createAgentSession({
      cwd: paths.repo,
      agentDir: paths.agentDir,
      modelRuntime,
      resourceLoader,
      sessionManager: sdk.SessionManager.inMemory(paths.repo),
      settingsManager,
      thinkingLevel: "off",
    }));
    await session.bindExtensions({});
    assert.ok(manager, "extension factory ran");
    const controller = (manager as unknown as { controller: BackgroundExecutionController }).controller;
    return {
      session,
      manager: manager!,
      controller,
      requests,
      hooks,
      extensionPi,
    };
  }

  async function startRunning(controller: BackgroundExecutionController, title: string): Promise<{ executionId: string; taskId: string }> {
    const started = await controller.start([{ title, instructions: "write draft.txt", acceptanceCriteria: ["draft.txt exists"] }]);
    const taskId = started.tasks[0]!.taskId;
    await waitFor(() => controller.inspect(started.executionId, taskId).tasks[0]?.state === "running", 30_000);
    await waitForAsync(async () => {
      const waveRoot = controller.inspect(started.executionId, taskId).tasks[0]?.waveRoot;
      if (!waveRoot) return false;
      return readFile(join(waveRoot, "workers", taskId, "draft.txt"), "utf8").then(() => true, () => false);
    }, 30_000);
    return { executionId: started.executionId, taskId };
  }

  function feedbackIn(request: RequestMessage[] | undefined): RequestMessage[] {
    return (request ?? []).filter((message) => message.text.includes(INTENT));
  }

  test("#191 real host: idle /subtask-interrupt failure steers into its own turn and later requests, only in its own session", () => withOwnedScope(async (scope) => {
    const paths = await scratchRepo(scope, "idle");
    const owner = await hostSession(scope, "idle-a", paths);
    const other = await hostSession(scope, "idle-b", paths);
    const { executionId, taskId } = await startRunning(owner.controller, "interrupt me");
    await owner.session.prompt(`/subtask-interrupt ${executionId} ${taskId} failure`);
    // The note steers with a triggered turn, so an idle session no longer
    // leaves it waiting for a request that may never come.
    await waitFor(() => owner.requests.length >= 1, 30_000);
    await owner.session.waitForIdle();
    assert.equal(owner.controller.inspect(executionId, taskId).tasks[0]?.state, "interrupted");
    const stored = owner.session.messages.filter((message: any) => message.customType === SUBTASK_INTERRUPT_FEEDBACK_CUSTOM_TYPE);
    assert.equal(stored.length, 1, "exactly one feedback note was queued (failure mode has no separate intent note)");
    assert.equal(owner.requests.length, 1, "the feedback triggered exactly one turn of its own");
    const seen = feedbackIn(owner.requests[0]);
    assert.equal(seen.length, 1, "the triggered model request carries the feedback once");
    assert.notEqual(seen[0]!.role, "toolResult", "the feedback is context, not a tool result");
    assert.match(seen[0]!.text, /interrupted by user/);
    assert.match(seen[0]!.text, /do not restart without authorization/);
    assert.ok(seen[0]!.text.includes(`Task ${taskId}`));
    assert.ok(seen[0]!.text.includes(`execute execution ${executionId}; requested mode interrupt_as_failure`));
    assert.match(seen[0]!.text, /Stop: acknowledged\./);
    assert.doesNotMatch(seen[0]!.text, /Merge:/);

    await owner.session.prompt("What is the state of my subtasks?");
    assert.equal(owner.requests.length, 2);
    assert.equal(feedbackIn(owner.requests[1]).length, 1, "the next model request still carries the feedback once");

    await other.session.prompt("Anything new?");
    assert.equal(other.requests.length, 1);
    assert.equal(feedbackIn(other.requests[0]).length, 0, "another live session never receives the note");
    assert.ok(other.requests[0]!.every((message) => !message.text.includes(taskId)));
  }));

  test("#191 real host: interrupt-with-merge intent steers first and the landing wake follows it in the same run", () => withOwnedScope(async (scope) => {
    const paths = await scratchRepo(scope, "merge");
    const owner = await hostSession(scope, "merge", paths);
    const { executionId, taskId } = await startRunning(owner.controller, "merge me");
    await owner.session.prompt(`/subtask-interrupt ${executionId} ${taskId} merge`);
    await waitFor(() => owner.requests.length >= 1, 30_000);
    await owner.session.waitForIdle();
    assert.equal(owner.controller.inspect(executionId, taskId).tasks[0]?.state, "landed");
    const intentTurn = owner.requests[0]!;
    const intent = feedbackIn(intentTurn);
    assert.equal(intent.length, 1, "the intent note steers and its own triggered turn carries it");
    assert.match(intent[0]!.text, /Settlement is pending: this note does not claim that the task stopped or that anything landed/);
    const landed = owner.requests.find((request) => request.some((message) => message.text.includes("force-merged and landed mechanically")));
    assert.ok(landed, "the completion wake reached the model");
    const intentIndex = landed.findIndex((message) => message.text.includes(INTENT));
    const wakeIndex = landed.findIndex((message) => message.text.includes("force-merged and landed mechanically"));
    assert.ok(intentIndex !== -1 && intentIndex < wakeIndex, "the user's intent precedes the completion wake it triggers");

    await owner.session.prompt("Status?");
    const next = owner.requests.at(-1)!;
    const notes = feedbackIn(next);
    assert.equal(notes.length, 2, "intent and settlement notes, each once");
    const settled = notes.find((message) => message.text.includes("Subtask interrupt result"))!;
    assert.match(settled.text, /Stop: acknowledged\./);
    assert.match(settled.text, /Merge: the mechanical merge attempt was acknowledged; the task state is now landed/);
    assert.match(settled.text, /inspect the main workspace manually/);
    const wakes = owner.session.messages.filter((message: any) => message.customType === "pi-review-subtask-event");
    assert.equal(wakes.length, 1, "exactly one completion wake; the feedback added none");
  }));

  test("#191 real host: an interrupt during a streaming run is visible to that run's next model request", () => withOwnedScope(async (scope) => {
    const paths = await scratchRepo(scope, "stream");
    const owner = await hostSession(scope, "stream", paths);
    const { executionId, taskId } = await startRunning(owner.controller, "interrupt mid-run");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inFirstRequest = new Promise<void>((resolve) => { entered = resolve; });
    owner.hooks.push(async () => {
      entered();
      await gate;
      return ai.fauxAssistantMessage([ai.fauxToolCall("PrgNoop", {}, { id: "prg-noop-1" })], { stopReason: "toolUse" });
    });
    const run = owner.session.prompt("Keep working");
    await inFirstRequest;
    await owner.session.prompt(`/subtask-interrupt ${executionId} ${taskId} failure`);
    assert.equal(feedbackIn(owner.requests[0]).length, 0, "the in-flight request predates the interrupt");
    release();
    await run;
    assert.equal(owner.requests.length, 2);
    const seen = feedbackIn(owner.requests[1]);
    assert.equal(seen.length, 1, "the same run's next request carries the note");
    assert.notEqual(seen[0]!.role, "toolResult");
    assert.match(seen[0]!.text, /Stop: acknowledged\./);
  }));

  test("#191 real host: a disposed session's extension API fails closed instead of delivering feedback", () => withOwnedScope(async (scope) => {
    const paths = await scratchRepo(scope, "stale");
    const owner = await hostSession(scope, "stale", paths);
    const stalePi = owner.extensionPi;
    owner.session.dispose();
    assert.throws(() => stalePi.sendMessage({ customType: "x", content: "x", display: false }, { triggerTurn: false }), /stale/);
    assert.equal(deliverInterruptFeedback(stalePi, { content: INTENT, details: {} }), false);
  }));
}
