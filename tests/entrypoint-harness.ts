// Shared setup and fixtures extracted from the former tests/index.test.ts
// extension-entrypoint suites. Importing suites inherit the environment
// save/reset hooks below (registered per importing suite, matching the
// previous single-file behavior) and share fixtures rather than duplicating
// the runtime wiring.
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { activate } from "../src/index";

export const executionToolNames = [
  "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue",
  "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean",
];
export const backgroundShellToolNames = ["ShellStart", "ShellList", "ShellLog", "ShellSend", "ShellStop"];
export const webToolNames = [
  "WebSearch", "WebFetch", "BrowserExtract",
  "BrowserOpen", "BrowserNavigate", "BrowserSnapshot", "BrowserConsole", "BrowserNetwork", "BrowserInspect", "BrowserScreenshot",
  "BrowserScroll", "BrowserHover", "BrowserClick", "BrowserFill", "BrowserType", "BrowserSelect", "BrowserPress",
  "BrowserUpload", "BrowserDownloadSave", "BrowserClipboard",
  "BrowserWait", "BrowserHistory", "BrowserTabs", "BrowserClose",
];

let previousConfig: string | undefined;
let previousDisabled: string | undefined;
let previousRuntimeRole: string | undefined;

beforeEach(() => {
  previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
  // Hermetic top-level surface: an inherited executor role would divert
  // activate() to the executor runtime branch (orchestrated workers set it).
  previousRuntimeRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.PI_REVIEW_GATE_CONFIG;
  else process.env.PI_REVIEW_GATE_CONFIG = previousConfig;
  if (previousDisabled === undefined) delete process.env.PI_REVIEW_GATE_DISABLED;
  else process.env.PI_REVIEW_GATE_DISABLED = previousDisabled;
  if (previousRuntimeRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previousRuntimeRole;
});

export const indexTestConfig = {
  enabled: true,
  maxCorrectionCycles: 3,
  implementationGuidanceAfterCorrectionAttempts: 1,
  maxPatchBytes: 200_000,
  maxFileBytes: 1_048_576,
  maxSnapshotBytes: 52_428_800,
  retainBundles: "never",
} as const;
export function countingPassReviewer(id: string, invocationPath: string) {
  return {
    id,
    adapter: "generic-cli" as const,
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        [
          "const fs=require('node:fs');",
          `const invocationPath=${JSON.stringify(invocationPath)};`,
          "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
          "fs.writeFileSync(invocationPath,String(count+1));",
          "process.stdin.resume();",
          `process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:${JSON.stringify(`${id} passed`)},findings:[]})));`,
        ].join(""),

      ],
      timeoutMs: 15000,
    },
  };
}

/** countingPassReviewer that also appends the full review prompt (the
 *  request context included) so tests can inspect what a reviewer saw. */
export function countingPassReviewerWithPromptDump(id: string, invocationPath: string, promptPath: string) {
  return {
    id,
    adapter: "generic-cli" as const,
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        [
          "const fs=require('node:fs');",
          `const invocationPath=${JSON.stringify(invocationPath)};`,
          "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
          "fs.writeFileSync(invocationPath,String(count+1));",
          "let prompt='';",
          "process.stdin.on('data',(chunk)=>{prompt+=chunk;});",
          `process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(promptPath)},prompt);process.stdout.write(JSON.stringify({verdict:'pass',summary:${JSON.stringify(`${id} passed`)},findings:[]}));});`,
        ].join(""),

      ],
      timeoutMs: 15000,
    },
  };
}

/** Canonical JSON with sorted object keys (same form the sidecar integrity
 *  hash uses), for simulating superseded-format sidecars in tests. */
export function stableJsonForTest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonForTest).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJsonForTest(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Recursively removes every displayLabel key (simulating a superseded-format
 *  sidecar whose results never carried a snapshotted identity). */
export function stripDisplayLabels(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripDisplayLabels);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === "displayLabel") delete record[key];
      else record[key] = stripDisplayLabels(record[key]);
    }
  }
  return value;
}

/** Like countingPassReviewer but records an explicit readiness marker and then
 *  blocks until the parent test writes the release file, so a settings change
 *  can be scripted while the invocation is provably still in flight. A verdict
 *  marker is written only once the release gate opens and the verdict is about
 *  to be emitted, giving the parent a deterministic not-yet-settled probe.
 *  Same poll-for-release pattern as the clean-exit-order decider fixture. */
export function releaseGatedCountingPassReviewer(id: string, invocationPath: string, startedPath: string, releasePath: string, emittedPath: string) {
  return {
    id,
    adapter: "generic-cli" as const,
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        [
          "const fs=require('node:fs');",
          `const invocationPath=${JSON.stringify(invocationPath)};`,
          "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
          "fs.writeFileSync(invocationPath,String(count+1));",
          `fs.writeFileSync(${JSON.stringify(startedPath)},'started');`,
          "const timer=setInterval(()=>{",
          `if(!fs.existsSync(${JSON.stringify(releasePath)}))return;`,
          "clearInterval(timer);",
          `fs.writeFileSync(${JSON.stringify(emittedPath)},'emitted');`,
          `process.stdout.write(JSON.stringify({verdict:'pass',summary:${JSON.stringify(`${id} passed`)},findings:[]}));`,
          "},10);",
        ].join(""),

      ],
      timeoutMs: 15000,
    },
  };
}

export async function runFirstReviewSession(dir: string, sessionFile: string) {
  const first = createSessionRuntime("conversation-a", sessionFile, dir);
  await activate(first.pi);
  await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
  await trigger(first.hooks, "input", { cwd: dir, text: "implement the change", source: "user" }, first.ctx);
  await trigger(first.hooks, "before_agent_start", { cwd: dir }, first.ctx);
  await writeFile(join(dir, "index.ts"), "v1\n", "utf8");
  await trigger(first.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo reconcile-evidence" } }, first.ctx);
  await triggerAgentEnd(first.hooks, {
    cwd: dir,
    messages: [{ role: "assistant", content: "first assistant summary" }],
  });
  await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);
  return first;
}

export function extractBundleDir(message: string, reviewSequence: number): string {
  const suffix = `/reviews/${String(reviewSequence).padStart(4, "0")}`;
  const line = message.split("\n").find((entry) => entry.startsWith("Complete immutable pass evidence: "));
  assert.ok(line, "transmission includes the immutable pass path");
  const passDir = line.slice("Complete immutable pass evidence: ".length);
  assert.ok(passDir.endsWith(suffix));
  return passDir.slice(0, -suffix.length);
}

export async function trigger(hooks: Map<string, Array<(...args: unknown[]) => unknown>>, name: string, ...args: unknown[]): Promise<void> {
  for (const handler of hooks.get(name) ?? []) {
    await handler(...args);
  }
}

/** Escape a literal string for use inside a RegExp constructor. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a minimal Pi host + session context for session_start integration
 * tests, mirroring the runtime helper used by the conversation-restore test.
 */
export function createSessionRuntime(
  sessionId: string,
  file: string,
  cwd: string,
  capture?: { reviewSettings?: (handler: (args: string, ctx: unknown) => Promise<void>) => void },
) {
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const notices: string[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const sent: Array<{ message: string; options: unknown }> = [];
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      if (name === "review-settings") capture?.reviewSettings?.(options.handler);
    },
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    notify(message: string) { notices.push(message); },
    sendUserMessage(message: string, options: unknown) { sent.push({ message, options }); },
  };
  const ctx = {
    cwd,
    ui: { notify: (message: string) => notices.push(message) },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => file,
      getCwd: () => cwd,
    },
  };
  return { hooks, notices, entries, sent, pi, ctx };
}

/** Fire the hook pair Pi emits when a turn has no further automatic work:
 *  agent_end (one per low-level run) followed by agent_settled (once, after
 *  retries, compaction retries, and queued continuations have drained). */
export async function triggerAgentEnd(hooks: Map<string, Array<(...args: unknown[]) => unknown>>, ...args: unknown[]): Promise<void> {
  await trigger(hooks, "agent_end", ...args);
  await trigger(hooks, "agent_settled", ...args);
}

export async function triggerResults(hooks: Map<string, Array<(...args: unknown[]) => unknown>>, name: string, ...args: unknown[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of hooks.get(name) ?? []) {
    results.push(await handler(...args));
  }
  return results.filter((result) => result !== undefined);
}

export async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await access(path);
}

export async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), "condition became true before timeout");
}
