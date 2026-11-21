/**
 * #682: reusable fixtures for the canonical managed-tool boundary
 * (`ExecutionToolManager.sharedManagedTool`) and the Pi registration that
 * shares its handler.
 *
 * Each fixture runs the real manager, controller, normalization, admission,
 * and result/failure shaping. Only the host is faked:
 * - The Pi object is a recording stub.
 * - The owner admission is an in-memory table of request snapshots keyed by
 *   (call id, tool name).
 * - The live call policy is a plain predicate.
 * - The external executor resource has `maxWorkers = 0`, so admitted tasks
 *   stay queued and no executor process, provider, or capture ever runs.
 *
 * These fixtures show that the Pi path and the shared path have the same
 * in-process semantics. They are not evidence of MCP transport, real owner
 * admission, or native-CLI parity.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeConfig } from "../src/config";
import {
  EXECUTION_TOOL_NAMES,
  ExecutionToolManager,
  type ManagedToolAdmission,
  type ManagedToolAdmittedCall,
  type ManagedToolDefinition,
  type ManagedToolInvocation,
  type SharedManagedToolAction,
} from "../src/execution/tool";
import { EXECUTION_TOOL_ACTIONS } from "../src/execution/tool-names";
import { createState } from "../src/state";
import { toolCallFingerprint } from "../src/tool-call-fingerprint";

export type PiToolExecute = (id: string, params: unknown, signal?: AbortSignal, update?: unknown, ctx?: unknown) => Promise<Record<string, any>>;

export const SUBTASK_TOOL_NAMES = EXECUTION_TOOL_ACTIONS.map((action) => EXECUTION_TOOL_NAMES[action]);

export const EMPTY_ASSOCIATIONS = { waveRoots: [], bundles: [], groupRoots: [] };

/** A shared definition typed for test reads of the result envelope. */
export type SharedTool = Omit<ManagedToolDefinition, "invoke"> & {
  invoke(invocation: ManagedToolInvocation): Promise<Record<string, any>>;
};

/**
 * Stand-in for the owner's admission records. `admit` stores a snapshot of the
 * effective params next to the raw, pre-coercion fingerprint of the submitted
 * input for one call id and tool, and returns that fingerprint.
 */
export class FixtureAdmission implements ManagedToolAdmission {
  private readonly records = new Map<string, { toolName: string; params: unknown; startCallFingerprint?: string }>();

  admit(toolCallId: string, toolName: string, rawInput: unknown, params: unknown = rawInput): string | undefined {
    const fingerprint = toolCallFingerprint(toolName, rawInput);
    this.records.set(toolCallId, {
      toolName,
      params: structuredClone(params),
      ...(fingerprint ? { startCallFingerprint: fingerprint } : {}),
    });
    return fingerprint;
  }

  resolveCall(toolCallId: string, toolName: string): ManagedToolAdmittedCall | undefined {
    const record = this.records.get(toolCallId);
    if (!record || record.toolName !== toolName) return undefined;
    return { params: structuredClone(record.params), startCallFingerprint: record.startCallFingerprint };
  }
}

export interface ManagedToolFixtureOptions {
  /** Pi's active tools at registration. Default: read, bash, and every Subtasks tool. */
  activeTools?: string[];
  /** Production-style parent catalog (index.ts wires DeferredToolManager.authorizedToolNames). */
  authorizedTools?: () => string[] | undefined;
  /** Production-style preflight resolver. Omitted means Pi's existing params fallback. */
  submittedFingerprintFor?: (toolCallId: string, toolName: string) => string | undefined;
  /** Owner live call policy. Default allows exactly the active tools. `null` leaves it unwired. */
  liveToolCallAllowed?: ((toolName: string) => boolean) | null;
}

export interface ManagedToolFixture {
  manager: ExecutionToolManager;
  admission: FixtureAdmission;
  /** Registered Pi tools in registration order. */
  tools: Array<Record<string, any>>;
  activations: Array<{ name: string; enabled: boolean }>;
  /** Calls the Pi returned-error observer received. */
  observedErrors: Array<[string, string]>;
  piTool(name: string): Record<string, any>;
  piExecute(name: string): PiToolExecute;
  /** Binds a shared tool with the fixture admission unless another one is given. */
  shared(action: SharedManagedToolAction, admission?: ManagedToolAdmission): SharedTool;
  groupCount(): number;
  dispose(): Promise<void>;
}

/** Same session order as index.ts: construct, restore associations, then sync. */
export async function managedToolFixture(options: ManagedToolFixtureOptions = {}): Promise<ManagedToolFixture> {
  const sourceRoot = await mkdtemp(join(tmpdir(), "pi-review-managed-tool-"));
  const tools: Array<Record<string, any>> = [];
  const activations: Array<{ name: string; enabled: boolean }> = [];
  const observedErrors: Array<[string, string]> = [];
  const activeTools = options.activeTools ?? ["read", "bash", ...SUBTASK_TOOL_NAMES];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive(name: string, enabled: boolean) { activations.push({ name, enabled }); },
    getActiveTools: () => [...activeTools],
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      unstarted: { adapter: "run-as-binary", command: process.execPath, execution: { protocol: "pi-review-executor-jsonl-v1", args: ["-e", ""] } },
    },
    execution: {
      workerResources: { default: { selection: { source: "external", id: "unstarted" }, maxConcurrent: 1 } },
      routes: { execute: [{ resourceId: "default" }], research: [] },
    },
  });
  // Admission only: queued tasks never dispatch, so nothing needs to settle.
  config.execution!.maxWorkers = 0;
  const liveToolCallAllowed = options.liveToolCallAllowed === null
    ? undefined
    : options.liveToolCallAllowed ?? ((name: string) => activeTools.includes(name));
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => sourceRoot,
    authorizedTools: options.authorizedTools,
    submittedFingerprintFor: options.submittedFingerprintFor,
    onNativeToolError: (toolCallId, toolName) => observedErrors.push([toolCallId, toolName]),
    ...(liveToolCallAllowed ? { liveToolCallAllowed } : {}),
  });
  await manager.restoreAssociations(EMPTY_ASSOCIATIONS);
  manager.sync();
  const admission = new FixtureAdmission();
  const piTool = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} was not registered`);
    return tool;
  };
  // Execution roots this fixture created. Collected on every count so roots
  // dropped by a later restore are still removed at teardown.
  const ownedRoots = new Set<string>();
  const collectRoots = () => {
    for (const root of manager.associations().groupRoots ?? []) ownedRoots.add(root);
  };
  let disposed = false;
  return {
    manager,
    admission,
    tools,
    activations,
    observedErrors,
    piTool,
    piExecute: (name) => piTool(name).execute as PiToolExecute,
    shared: (action, binding = admission) => manager.sharedManagedTool(action, binding) as SharedTool,
    groupCount: () => {
      collectRoots();
      return manager.associations().groupRoots?.length ?? 0;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      collectRoots();
      await manager.shutdown();
      await manager.detach();
      for (const root of ownedRoots) await rm(root, { recursive: true, force: true });
      await rm(sourceRoot, { recursive: true, force: true });
    },
  };
}

/** Every managed result, success or error, uses the Pi tool-result envelope. */
export function assertManagedEnvelope(result: Record<string, any>, isError: boolean, label = "result"): void {
  assert.deepEqual(Object.keys(result).sort(), ["content", "details", "isError"], label);
  assert.equal(result.isError, isError, label);
  assert.equal(result.content.length, 1, label);
  assert.equal(result.content[0].type, "text", label);
  assert.equal(typeof result.content[0].text, "string", label);
}

/**
 * Parity between two results of the same request. Digits are masked so live
 * revisions, timestamps, and timings can differ while text, structure, and
 * error state must match exactly.
 */
export function assertEnvelopeParity(left: Record<string, any>, right: Record<string, any>, label = "parity"): void {
  const mask = (value: unknown) => JSON.stringify(value).replace(/\d+/g, "#");
  assert.equal(mask(left), mask(right), label);
}

export function queuedTask(title: string): Record<string, unknown> {
  return { title, instructions: `bounded instructions for ${title}`, acceptanceCriteria: [`${title} done`] };
}
