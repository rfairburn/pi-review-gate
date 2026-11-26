/**
 * #736 slice 3a: focused tests for the native row's automatic primary review
 * coordinator.
 *
 * These run the REAL review machinery — real temporary workspaces (Git and
 * non-Git), real checkpoint capture and release, real review bundles, the
 * repository's fake external CLI reviewer — against the coordinator's two
 * entry events. No provider CLI, no host UI, and never a real model: the only
 * reviewer is the same fake CLI reviewer the rest of the suite uses.
 *
 * Each test owns its temporary root and removes it, then asserts the run left
 * no owned checkpoint record or review bundle behind, so an isolated failure
 * cannot leak artifacts into a shared temporary directory.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { access, mkdir, mkdtemp, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import type { ExternalAgentConfig, ReviewGateConfig } from "../src/config";
import type { ReviewRunOutput } from "../src/review";
import { agentCatalog } from "./helpers";
import {
  createNativeReviewCoordinator,
  type NativeReviewBackgroundState,
  type NativeReviewCoordinator,
} from "../src/session-host/native-review-coordinator";
import {
  MAX_NATIVE_REVIEW_REASON_BYTES,
  MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES,
  parseNativeReviewVerdict,
  type NativeReviewRequest,
} from "../src/session-host/native-review-hook-protocol";
import { NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS } from "../src/session-host/native-review-hook-launch-prep";
import { NATIVE_REVIEW_HOOK_RELAY_DEADLINE_MS } from "../src/session-host/native-review-hook-relay";
import {
  NATIVE_REVIEW_DEADLINE_MS,
  NATIVE_UNRESOLVED_FEEDBACK_NOTICE,
} from "../src/session-host/native-review-coordinator";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ownedRoots: string[] = [];

afterEach(async () => {
  // Only roots this file created are removed; nothing pre-existing is touched.
  const roots = ownedRoots.splice(0);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function makeRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `prg-native-review-${label}-`));
  ownedRoots.push(root);
  return root;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Test",
    GIT_COMMITTER_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
}

function exec(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env: gitEnv() }, (error) => error ? reject(error) : resolve());
  });
}

/** One bounded, recursive listing; never follows a symlink. */
async function walkFiles(dir: string, out: string[] = []): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    const path = join(dir, entry);
    const stats = await fs.promises.lstat(path).catch(() => undefined);
    if (!stats) continue;
    if (stats.isDirectory()) await walkFiles(path, out);
    else out.push(path);
  }
  return out;
}

async function checkpointRecords(agentDir: string): Promise<string[]> {
  return (await walkFiles(agentDir)).filter((path) => path.endsWith("record.json"));
}

async function waitFor(predicate: () => Promise<boolean> | boolean, limitMs = 5_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) assert.fail(`condition not met within ${limitMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type ReviewerMode = "pass" | "needs_changes" | "needs_changes_oversized" | "needs_changes_controls" | "error";

/**
 * Keeps the event loop alive with a REFERENCED timer while a test waits on a
 * production timer whose own handles are deliberately `unref`'d, and turns "it
 * never fired" into a test failure instead of a drained loop that silently ends
 * or cancels the test. Always `done()` in a `finally`.
 */
function hangGuard(label: string, timeoutMs = 20_000): { watch<T>(promise: Promise<T>): Promise<T>; done(): void } {
  let timer: NodeJS.Timeout | undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no outcome within ${timeoutMs}ms`)), timeoutMs);
  });
  return {
    watch<T>(promise: Promise<T>): Promise<T> { return Promise.race([promise, failure]); },
    done(): void { clearTimeout(timer); },
  };
}

/**
 * The repository's fake external CLI reviewer shape: a Node one-liner that
 * reads the review prompt on stdin and answers a fixed ReviewResult. The
 * verdict and the call counter live in files the test controls, so one harness
 * can flip pass → needs_changes between turns without rebuilding the config,
 * and every test can prove whether a reviewer actually ran.
 */
function fakeReviewerAgent(modeFile: string, callsFile: string, delayMs = 0, delayFile?: string, ignoresAbort = false): ExternalAgentConfig {
  const script = [
    "const fs = require('fs');",
    // A reviewer that survives the abort's SIGTERM keeps the settlement open
    // after the caller cancelled, which is what proves the deadline reply does
    // not wait for cleanup. The adapter still escalates to SIGKILL, so the stall
    // is bounded and the child always dies.
    ignoresAbort ? "process.on('SIGTERM', () => {});" : "",
    `const modeFile = ${JSON.stringify(modeFile)};`,
    `const callsFile = ${JSON.stringify(callsFile)};`,
    // A live delay file lets ONE test window run a slow reviewer and then a fast
    // one, which is what proving "the next request still proceeds after a review
    // deadline" needs; without it the delay is fixed for the whole harness.
    delayFile === undefined
      ? `const delay = ${delayMs};`
      : "let delay = 0; try { delay = Number(fs.readFileSync(" + JSON.stringify(delayFile) + ", 'utf8')) || 0; } catch {}",
    "let body = '';",
    "process.stdin.on('data', (chunk) => { body += chunk; });",
    "process.stdin.on('end', () => {",
    "  try { fs.appendFileSync(callsFile, 'call\\n'); } catch {}",
    "  let mode = 'pass';",
    "  try { mode = fs.readFileSync(modeFile, 'utf8').trim(); } catch {}",
    "  const emit = () => {",
    "    let payload;",
    "    if (mode === 'needs_changes') {",
    "      payload = { verdict: 'needs_changes', summary: 'fix required', findings: [{ severity: 'blocking', file: 'index.ts', line: null, issue: 'missing test', recommendation: 'add coverage' }] };",
    // A reviewer's finding text is arbitrary and unbounded: the transport's",
    // inline limit and its control-character rule have to be enforced by the",
    // host, never assumed about the reviewer.
    "    } else if (mode === 'needs_changes_oversized') {",
    "      payload = { verdict: 'needs_changes', summary: 'x'.repeat(400000), findings: Array.from({ length: 40 }, (_unused, i) => ({ severity: 'blocking', file: 'index.ts', line: null, issue: 'finding ' + i + ' ' + 'y'.repeat(8000), recommendation: 'r' })) };",
    "    } else if (mode === 'needs_changes_controls') {",
    "      payload = { verdict: 'needs_changes', summary: 'bell\\u0007 and nul\\u0000 in the summary', findings: [{ severity: 'blocking', file: 'index.ts', line: null, issue: 'control\\u0001 characters \\u007f in the finding', recommendation: 'r' }] };",
    "    } else if (mode === 'error') {",
    "      payload = { verdict: 'error', summary: 'reviewer produced no verdict', findings: [] };",
    "    } else {",
    "      payload = { verdict: 'pass', summary: 'looks fine', findings: [] };",
    "    }",
    "    process.stdout.write(JSON.stringify(payload));",
    "  };",
    "  if (delay > 0) setTimeout(emit, delay); else emit();",
    "});",
  ].join("");
  return {
    id: "fake",
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: { args: ["-e", script], timeoutMs: 20_000 },
  };
}

interface HarnessOptions {
  readonly git?: boolean;
  readonly backend?: "claude" | "codex";
  readonly reviewerDelayMs?: number;
  /** Read the fake reviewer's delay from a file this test can rewrite. */
  readonly liveReviewerDelay?: boolean;
  /** The fake reviewer ignores SIGTERM, so an abort leaves the settlement open. */
  readonly reviewerIgnoresAbort?: boolean;
  /** Overall per-request review deadline for this harness. */
  readonly deadlineMs?: number;
  /**
   * Holds the read-only baseline verification await of a settlement (see
   * `NativeReviewCoordinatorDependencies.observeBaselineVerification`).
   */
  readonly observeBaselineVerification?: () => void | Promise<void>;
  /** Holds the checkpoint comparison await of a settlement. */
  readonly observeCheckpointComparison?: () => void | Promise<void>;
  /** Holds a completed baseline capture (prompt arm or Tools-only recovery). */
  readonly observeBaselineCapture?: () => void | Promise<void>;
  /**
   * Holds or fails the arm's publish of a captured baseline (see
   * `NativeReviewCoordinatorDependencies.observeBaselinePublish`).
   */
  readonly observeBaselinePublish?: () => void | Promise<void>;
  /**
   * Waits for the release of a baseline capture that was never published, with
   * whether that release succeeded (see
   * `NativeReviewCoordinatorDependencies.observeUnpublishedCheckpointRelease`).
   */
  readonly observeUnpublishedCheckpointRelease?: (released: boolean) => void | Promise<void>;
  /**
   * Maps a completed run output before the settlement maps it (see
   * `NativeReviewCoordinatorDependencies.reviewOutputForTests`).
   */
  readonly reviewOutputForTests?: (output: ReviewRunOutput) => ReviewRunOutput;
  /** The host's Pi model scope handed to the coordinator. */
  readonly scopedModels?: readonly string[];
  /** The admitted Pi executable a `pi` reviewer is launched with. */
  readonly admittedPiCommand?: string;
  /** Create the checkpoint agent directory as a FILE so capture cannot succeed. */
  readonly unusableAgentDir?: boolean;
  /** Omit the workspace entirely so capture has no root to read. */
  readonly missingWorkspace?: boolean;
  readonly readConfigThrows?: boolean;
  readonly now?: () => Date;
}

interface Harness {
  readonly root: string;
  readonly workspace: string;
  readonly agentDir: string;
  coordinator: NativeReviewCoordinator;
  config: ReviewGateConfig;
  /** Flips the live settings read between readable and unreadable mid-test. */
  settingsUnreadable: boolean;
  /**
   * Runs INSIDE the live settings read, immediately before it answers. A test
   * uses it to land a hang-up or a deadline while a request is already inside a
   * settings-dependent branch, which no signal timing could otherwise pin down.
   */
  configReadHook?: () => void;
  background: NativeReviewBackgroundState | ((request: NativeReviewRequest) => Promise<NativeReviewBackgroundState>);
  setMode(mode: ReviewerMode): Promise<void>;
  /** Rewrite the live reviewer delay (requires `liveReviewerDelay`). */
  setDelay?(delayMs: number): Promise<void>;
  /**
   * Report tool activity from INSIDE the next settlement — after that settlement
   * sampled its activity watermark and before it recorded its correction marker,
   * which is where a row's own concurrent report lands. Such activity is not in
   * the reviewed checkpoint, so it still earns the NEXT `Stop` a review (#736
   * U6) while that next turn itself reports nothing at all.
   */
  noteActivityDuringNextReview(sessionId: string, activity?: { toolName: string; readOnly: boolean }): void;
  calls(): Promise<number>;
  records(): Promise<string[]>;
  dispose(): Promise<{ unreviewedConversations: number }>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await makeRoot("harness");
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const modeFile = join(root, "mode");
  const callsFile = join(root, "calls");
  const delayFile = options.liveReviewerDelay === true ? join(root, "delay") : undefined;
  if (!options.missingWorkspace) {
    await mkdir(workspace);
    await writeFile(join(workspace, "index.ts"), "before\n", "utf8");
  }
  if (options.unusableAgentDir) await writeFile(agentDir, "not a directory\n", "utf8");
  else await mkdir(agentDir, { recursive: true });
  if (options.git) {
    await exec("git", ["init", "-q", "-b", "main"], workspace);
    await exec("git", ["add", "-A"], workspace);
    await exec("git", ["commit", "-qm", "base"], workspace);
  }
  await writeFile(modeFile, "pass", "utf8");
  if (delayFile !== undefined) await writeFile(delayFile, String(options.reviewerDelayMs ?? 0), "utf8");
  /** Armed by `noteActivityDuringNextReview`; drained inside the next settlement. */
  const reviewNotes: { sessionId: string; toolName: string; readOnly: boolean }[] = [];

  const config: ReviewGateConfig = {
    enabled: true,
    operatingMode: "orchestrate",
    modeCycleShortcut: "alt+m",
    reviewerTimeoutMs: 20_000,
    executorTimeoutMs: 60_000,
    maxCorrectionCycles: 3,
    implementationGuidanceAfterCorrectionAttempts: 1,
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
    externalAgents: agentCatalog(
      fakeReviewerAgent(modeFile, callsFile, options.reviewerDelayMs ?? 0, delayFile, options.reviewerIgnoresAbort === true),
    ),
    review: {
      primaryReviewers: [{ source: "external", id: "fake" }],
      primaryClaudeCodeEnabled: true,
      primaryCodexEnabled: true,
    },
  };

  const harness: Harness = {
    root,
    workspace,
    agentDir,
    config,
    settingsUnreadable: false,
    background: { state: "idle" } as NativeReviewBackgroundState,
    coordinator: undefined as unknown as NativeReviewCoordinator,
    async setMode(mode) {
      await writeFile(modeFile, mode, "utf8");
    },
    noteActivityDuringNextReview(sessionId, activity = { toolName: "Write", readOnly: false }) {
      reviewNotes.push({ sessionId, ...activity });
    },
    ...(delayFile === undefined
      ? {}
      : { async setDelay(delayMs: number) { await writeFile(delayFile, String(delayMs), "utf8"); } }),
    async calls() {
      try {
        return (await readText(callsFile)).split("\n").filter((line) => line.length > 0).length;
      } catch {
        return 0;
      }
    },
    async records() {
      return checkpointRecords(agentDir);
    },
    async dispose() {
      return await harness.coordinator.dispose();
    },
  };
  harness.coordinator = createNativeReviewCoordinator({
    backend: options.backend ?? "claude",
    workspace,
    checkpointAgentDir: agentDir,
    readConfig: () => {
      harness.configReadHook?.();
      if (options.readConfigThrows || harness.settingsUnreadable) throw new Error("config file unreadable");
      return harness.config;
    },
    backgroundState: async (request) => {
      const value = harness.background;
      return typeof value === "function" ? await value(request) : value;
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.observeBaselineVerification === undefined
      ? {}
      : { observeBaselineVerification: options.observeBaselineVerification }),
    ...(options.observeCheckpointComparison === undefined
      ? {}
      : { observeCheckpointComparison: options.observeCheckpointComparison }),
    ...(options.observeBaselineCapture === undefined
      ? {}
      : { observeBaselineCapture: options.observeBaselineCapture }),
    ...(options.observeBaselinePublish === undefined
      ? {}
      : { observeBaselinePublish: options.observeBaselinePublish }),
    ...(options.observeUnpublishedCheckpointRelease === undefined
      ? {}
      : { observeUnpublishedCheckpointRelease: options.observeUnpublishedCheckpointRelease }),
    // Always mapped, so `noteActivityDuringNextReview` can fire from inside a
    // settlement; without a caller-supplied mapper this is the identity.
    reviewOutputForTests: (output) => {
      for (const note of reviewNotes.splice(0)) {
        harness.coordinator.noteToolActivity(note.sessionId, { toolName: note.toolName, readOnly: note.readOnly });
      }
      return options.reviewOutputForTests?.(output) ?? output;
    },
    ...(options.scopedModels === undefined ? {} : { scopedModels: options.scopedModels }),
    ...(options.admittedPiCommand === undefined ? {} : { admittedPiCommand: options.admittedPiCommand }),
  });
  return harness;
}

function readText(path: string): Promise<string> {
  return fs.promises.readFile(path, "utf8");
}

const ups = (sessionId: string, prompt = "add a retry to upload()"): NativeReviewRequest => ({
  backend: "claude",
  event: "UserPromptSubmit",
  sessionId,
  prompt,
});

const stop = (sessionId: string, lastAssistantMessage = "I made the change."): NativeReviewRequest => ({
  backend: "claude",
  event: "Stop",
  sessionId,
  lastAssistantMessage,
});

function newAbortSignal(): { signal: AbortSignal; abort: (reason?: unknown) => void } {
  const controller = new AbortController();
  return { signal: controller.signal, abort: (reason?: unknown) => controller.abort(reason ?? new Error("test abort")) };
}

/** The bundle directory a transmission message points its reader at. */
function bundleDirOf(reason: string): string {
  const match = reason.match(/Complete immutable pass evidence: (.+)[/\\]reviews[/\\][0-9]+/);
  assert.ok(match, `a transmission always names its bundle directory: ${reason.slice(0, 200)}`);
  return match[1]!;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

test("the coordinator and its whole import closure stay Pi-free", async () => {
  const source = await readText(join(process.cwd(), "src", "session-host", "native-review-coordinator.ts"));
  // Every import the module actually writes, in either supported syntax.
  const specifiers = [...source.matchAll(/(?:from|require\()\s*"([^"]+)"/g)].map((match) => match[1]!);
  assert.ok(specifiers.length > 0, "the module has imports to check");
  for (const specifier of specifiers) {
    assert.equal(specifier.startsWith("@earendil-works/"), false, `the coordinator imports ${specifier}`);
    assert.equal(specifier.startsWith("@mariozechner/"), false, `the coordinator imports ${specifier}`);
    assert.equal(specifier.includes("activation"), false, `the coordinator imports ${specifier}`);
    assert.notEqual(specifier, "./index", "the coordinator never reaches the Pi extension entrypoint");
    assert.notEqual(specifier, "../index", "the coordinator never reaches the Pi extension entrypoint");
  }

  // The stronger claim, checked on the real module graph this test process
  // loaded: nothing under a Pi package name is in the require cache.
  const loaded = Object.keys(require.cache ?? {});
  const piModules = loaded.filter((path) => path.includes("node_modules")
    && (path.includes("node_modules/@earendil-works") || path.includes("node_modules/@mariozechner")));
  assert.deepEqual(piModules, [], "loading the coordinator must never pull a Pi package into the process");
});

test("transmitReviewPass is one shared step the Pi path imports, not a copy", async () => {
  const shared = await readText(join(process.cwd(), "src", "review-transmission-pass.ts"));
  const piPath = await readText(join(process.cwd(), "src", "activation", "review-turn.ts"));
  assert.ok(shared.includes("recordReviewerFeedbackAndArmExchange"), "the shared step records feedback");
  assert.ok(shared.includes("createReviewTransmissionMessage"), "the shared step renders the transmission");
  assert.ok(piPath.includes('from "../review-transmission-pass"'), "the Pi path imports it");
  assert.equal(piPath.includes("async function transmitReviewPass"), false, "the Pi path keeps no private copy");
});

test("the coordinator module never carries a search-exclusion special case", async () => {
  const source = await readText(join(process.cwd(), "src", "session-host", "native-review-coordinator.ts"));
  assert.equal(source.includes(".terraform"), false);
});

test("the native lane validates the inline form between rendering and recording", async () => {
  // The shared step stays one step for the Pi path, but is exposed in halves so
  // a host with a bounded transport can make the message deliverable before the
  // reviewer's feedback counts as delivered.
  const shared = await readText(join(process.cwd(), "src", "review-transmission-pass.ts"));
  assert.ok(/export function renderReviewTransmissionMessage/.test(shared), "the render half is exported");
  assert.ok(/export function recordReviewTransmissionPass/.test(shared), "the recording half is exported");
  const coordinator = await readText(join(process.cwd(), "src", "session-host", "native-review-coordinator.ts"));
  assert.ok(coordinator.includes("renderReviewTransmissionMessage"), "the native lane renders");
  assert.ok(coordinator.includes("recordReviewTransmissionPass"), "and records only afterwards");
  assert.equal(coordinator.includes("transmitReviewPass"), false, "never the composed call: it would record text it has not checked");
  const sharedCallOrder = shared.indexOf("renderReviewTransmissionMessage") < shared.indexOf("recordReviewTransmissionPass(input)");
  assert.ok(sharedCallOrder, "the composed call keeps render-then-record order");
});

// ---------------------------------------------------------------------------
// The toggle
// ---------------------------------------------------------------------------

test("automatic review stays off until the backend's own toggle is on", async () => {
  const harness = await createHarness();
  try {
    harness.config = { ...harness.config, review: { ...harness.config.review!, primaryClaudeCodeEnabled: false, primaryCodexEnabled: true } };
    const off = await harness.coordinator.onReviewRequest(ups("session-off"), newAbortSignal().signal);
    assert.deepEqual(off, { action: "allow" }, "off is off: no reviewer, no notice");
    assert.equal(await harness.calls(), 0);
    assert.deepEqual(await harness.records(), [], "an off row never captures a baseline");

    // The other backend's switch does not answer for this one.
    harness.config = { ...harness.config, review: { ...harness.config.review!, primaryClaudeCodeEnabled: true, primaryCodexEnabled: false } };
    const codex = await harness.coordinator.onReviewRequest({ ...ups("session-off"), backend: "codex" }, newAbortSignal().signal);
    assert.deepEqual(codex, { action: "allow" });
    assert.equal(await harness.calls(), 0);

    // The master setting wins over both per-row switches.
    harness.config = { ...harness.config, enabled: false };
    const master = await harness.coordinator.onReviewRequest(ups("session-off"), newAbortSignal().signal);
    assert.deepEqual(master, { action: "allow" });
    assert.equal(await harness.calls(), 0);
  } finally {
    await harness.dispose();
  }
});

test("turning the toggle off closes an open window and releases its checkpoint", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-toggle"), newAbortSignal().signal);
    assert.ok((await harness.records()).length > 0, "the prompt armed a baseline");
    harness.config = { ...harness.config, review: { ...harness.config.review!, primaryClaudeCodeEnabled: false } };
    const verdict = await harness.coordinator.onReviewRequest(stop("session-toggle"), newAbortSignal().signal);
    assert.deepEqual(verdict, { action: "allow" }, "off never leaves a notice behind");
    await waitFor(async () => (await harness.records()).length === 0);
  } finally {
    await harness.dispose();
  }
});

test("an unreadable Review configuration allows with a notice and never blocks", async () => {
  const harness = await createHarness({ readConfigThrows: true });
  try {
    const prompt = await harness.coordinator.onReviewRequest(ups("session-config"), newAbortSignal().signal);
    assert.equal(prompt.action, "allow");
    assert.match(prompt.userMessage ?? "", /could not be read/);
    const settled = await harness.coordinator.onReviewRequest(stop("session-config"), newAbortSignal().signal);
    // #736 U19: the notice is one per unreadable stretch, so the next request
    // while settings are still unreadable is the same quiet allow.
    assert.deepEqual(settled, { action: "allow" });
    assert.equal(await harness.calls(), 0);
  } finally {
    await harness.dispose();
  }
});

test("the unreadable-settings notice is said once per unreadable stretch and again after a good read", async () => {
  const harness = await createHarness();
  try {
    harness.settingsUnreadable = true;
    const first = await harness.coordinator.onReviewRequest(ups("session-config-once"), newAbortSignal().signal);
    assert.equal(first.action, "allow");
    assert.match(first.userMessage ?? "", /could not be read/, "the first request of an unreadable stretch warns");
    const second = await harness.coordinator.onReviewRequest(stop("session-config-once"), newAbortSignal().signal);
    assert.deepEqual(second, { action: "allow" }, "a later request of the SAME stretch is a quiet allow");

    // Settings read successfully again — that resets the disclosure — and then
    // fail again, which is a new failure and warns again.
    harness.settingsUnreadable = false;
    const readable = await harness.coordinator.onReviewRequest(ups("session-config-once"), newAbortSignal().signal);
    assert.deepEqual(readable, { action: "allow" }, "a successful read never carries the notice");
    harness.settingsUnreadable = true;
    const again = await harness.coordinator.onReviewRequest(stop("session-config-once"), newAbortSignal().signal);
    assert.equal(again.action, "allow");
    assert.match(again.userMessage ?? "", /could not be read/, "a NEW unreadable read warns again");
    assert.equal(await harness.calls(), 0, "unavailable settings never launch a reviewer");
  } finally {
    await harness.dispose();
  }
});

test("an unreadable-settings request that hangs up never spends the warning", async () => {
  const harness = await createHarness();
  try {
    harness.settingsUnreadable = true;
    const hung = newAbortSignal();
    // Let the unreadable branch return, then hang up before `finish` runs: the
    // branch and `finish` are separate promise reactions, and a verdict `finish`
    // discards must not have consumed the warning.
    harness.configReadHook = () => queueMicrotask(() => hung.abort());
    const cancelled = await harness.coordinator.onReviewRequest(ups("session-config-hangup"), hung.signal);
    harness.configReadHook = undefined;
    assert.deepEqual(cancelled, { action: "allow" }, "a hung-up request carries nothing");
    // A disclosure nobody saw is not a disclosure made: the warning is still due,
    // so the next live request of this conversation says it.
    const next = await harness.coordinator.onReviewRequest(ups("session-config-hangup"), newAbortSignal().signal);
    assert.equal(next.action, "allow");
    assert.match(next.userMessage ?? "", /could not be read/, "the undelivered warning is not spent");
  } finally {
    await harness.dispose();
  }
});

test("the unreadable-settings warning survives superseding its conversation", async () => {
  const harness = await createHarness();
  try {
    harness.settingsUnreadable = true;
    const a1 = await harness.coordinator.onReviewRequest(ups("session-a"), newAbortSignal().signal);
    assert.match(a1.userMessage ?? "", /could not be read/, "A warns once");
    const a2 = await harness.coordinator.onReviewRequest(stop("session-a"), newAbortSignal().signal);
    assert.deepEqual(a2, { action: "allow" }, "A is quiet for the rest of the stretch");
    const b1 = await harness.coordinator.onReviewRequest(ups("session-b"), newAbortSignal().signal);
    assert.match(b1.userMessage ?? "", /could not be read/, "B warns once for its own id");
    // A's conversation object was dropped when B superseded it; the warning is
    // keyed to the id, so resuming A inside the same stretch stays quiet.
    const a3 = await harness.coordinator.onReviewRequest(ups("session-a"), newAbortSignal().signal);
    assert.deepEqual(a3, { action: "allow" }, "resumed A allows quietly");
    const a4 = await harness.coordinator.onReviewRequest(stop("session-a"), newAbortSignal().signal);
    assert.deepEqual(a4, { action: "allow" });
    assert.equal(await harness.calls(), 0);
  } finally {
    await harness.dispose();
  }
});

test("a successful settings read in a cancelled prompt's slot re-arms the unreadable warning", async () => {
  const harness = await createHarness();
  try {
    harness.settingsUnreadable = true;
    const first = await harness.coordinator.onReviewRequest(ups("session-config-recover"), newAbortSignal().signal);
    assert.match(first.userMessage ?? "", /could not be read/);
    const quiet = await harness.coordinator.onReviewRequest(stop("session-config-recover"), newAbortSignal().signal);
    assert.deepEqual(quiet, { action: "allow" });

    // The settings document becomes readable again, and the ONLY read that
    // observes it is the serialized slot of a prompt that was already cancelled.
    harness.settingsUnreadable = false;
    const cancelled = newAbortSignal();
    cancelled.abort();
    const dead = await harness.coordinator.onReviewRequest(ups("session-config-recover"), cancelled.signal);
    assert.deepEqual(dead, { action: "allow" }, "a cancelled prompt still answers a quiet allow");

    // Settings break again: that is a NEW failure, and this conversation was
    // never warned for it.
    harness.settingsUnreadable = true;
    const again = await harness.coordinator.onReviewRequest(ups("session-config-recover"), newAbortSignal().signal);
    assert.equal(again.action, "allow");
    assert.match(again.userMessage ?? "", /could not be read/, "the recovery reset was applied");
  } finally {
    await harness.dispose();
  }
});

test("settings that become unreadable retire the armed window instead of freezing it", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-gap"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-gap", { toolName: "Write", readOnly: false });
    assert.ok((await harness.records()).length > 0, "the conversation is armed with a real checkpoint baseline");

    harness.settingsUnreadable = true;
    const gap = await harness.coordinator.onReviewRequest(stop("session-gap"), newAbortSignal().signal);
    assert.equal(gap.action, "allow");
    assert.match(gap.userMessage ?? "", /could not be read/);
    assert.equal(await harness.calls(), 0, "unavailable settings never launch a reviewer");
    await waitFor(async () => (await harness.records()).length === 0, 5_000);
    assert.deepEqual(
      await harness.records(),
      [],
      "the frozen window and the checkpoint pins behind it are released now, not carried across the gap",
    );

    // Settings are back, and the change made during the gap is still unreviewed —
    // but there is no window left to review it against, so a Stop with no new
    // prompt must not reach a reviewer over a retired baseline.
    harness.settingsUnreadable = false;
    const restored = await harness.coordinator.onReviewRequest(stop("session-gap"), newAbortSignal().signal);
    assert.equal(restored.action, "allow");
    assert.equal(await harness.calls(), 0, "a later Stop never reviews against the retired window");
  } finally {
    await harness.dispose();
  }
});

test("an unsafe conversation id never captures and says automatic review is unavailable", async () => {
  const harness = await createHarness();
  try {
    // #736 U19: an id that cannot be a checkpoint directory is a lane-wide fact,
    // so it is said once per coordinator and every later request is a quiet allow.
    const ids = ["../escape", "a/b", "", ".", "nul"];
    for (const [index, sessionId] of ids.entries()) {
      const verdict = await harness.coordinator.onReviewRequest(ups(sessionId), newAbortSignal().signal);
      assert.equal(verdict.action, "allow");
      if (index === 0) {
        assert.match(verdict.userMessage ?? "", /automatic review is unavailable for this conversation/);
      } else {
        assert.equal(verdict.userMessage, undefined, `${sessionId}: a later unsafe id is a quiet allow`);
      }
    }
    assert.deepEqual(await harness.records(), [], "nothing is ever captured for an unsafe id");
    assert.equal(await harness.calls(), 0);
  } finally {
    await harness.dispose();
  }
});

test("the unsafe-conversation-id notice is said once per coordinator", async () => {
  const harness = await createHarness();
  try {
    const first = await harness.coordinator.onReviewRequest(ups("a/b"), newAbortSignal().signal);
    assert.equal(first.action, "allow");
    assert.match(first.userMessage ?? "", /automatic review is unavailable for this conversation/);
    const second = await harness.coordinator.onReviewRequest(ups("a/b"), newAbortSignal().signal);
    assert.deepEqual(second, { action: "allow" }, "the same unsafe id asked again is a quiet allow");
    const other = await harness.coordinator.onReviewRequest(ups("../escape"), newAbortSignal().signal);
    assert.deepEqual(other, { action: "allow" }, "so is a different unsafe id");
    // The disclosure is per coordinator, not per conversation: a safe request in
    // the same lane is unaffected either way.
    const safe = await harness.coordinator.onReviewRequest(ups("session-after-unsafe"), newAbortSignal().signal);
    assert.deepEqual(safe, { action: "allow" });
    assert.equal((await harness.records()).length, 1, "a safe conversation in the same lane is unaffected");
  } finally {
    await harness.dispose();
  }
});

// ---------------------------------------------------------------------------
// Arming on UserPromptSubmit
// ---------------------------------------------------------------------------

test("UserPromptSubmit captures a raw baseline and Stop reviews the change to a pass", async () => {
  const harness = await createHarness();
  try {
    const armed = await harness.coordinator.onReviewRequest(ups("session-raw"), newAbortSignal().signal);
    assert.deepEqual(armed, { action: "allow" });
    const records = await harness.records();
    assert.equal(records.length, 1, "one owned raw checkpoint record for this conversation");
    assert.ok(records[0]!.includes(join("sessions", "pi-review-gate", "session-raw")));

    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-raw", { toolName: "Write", readOnly: false });
    const verdict = await harness.coordinator.onReviewRequest(stop("session-raw"), newAbortSignal().signal);
    assert.equal(verdict.action, "block", "a passing review is transmitted to the model");
    assert.match(verdict.reason ?? "", /PASS|passed/i);
    assert.match(verdict.userMessage ?? "", /^review gate: passed \(/);
    assert.equal(await harness.calls(), 1);

    const bundleDir = bundleDirOf(verdict.reason!);
    assert.ok(await exists(bundleDir), "the bundle survives the turn so the reader can open it");
    // Live acceptance: a native row's tool calls are never recorded as tool
    // events, and the reviewer is told so rather than reading an empty record
    // as "nothing ran".
    const request = await readText(join(bundleDir, "reviews", "0001", "request.md"));
    assert.match(request, /Evidence note: this work was done in a hosted native coding-agent session/);
    assert.match(request, /an empty tool-event record means those calls were not observed/);

    const disposed = await harness.dispose();
    assert.deepEqual(disposed, { unreviewedConversations: 1 },
      "a passed review keeps its window open with its baseline, exactly as a Pi window does");
    assert.deepEqual(await harness.records(), [], "dispose releases every owned checkpoint record");
    assert.equal(await exists(bundleDir), false, "dispose removes the owned review bundle");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a pass verdict's notice never repeats the review-start progress line (#736 U15)", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-no-progress-line"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-no-progress-line", { toolName: "Write", readOnly: false });
    const verdict = await harness.coordinator.onReviewRequest(stop("session-no-progress-line"), newAbortSignal().signal);
    assert.equal(verdict.action, "block", "the review ran and passed");
    assert.match(verdict.userMessage ?? "", /^review gate: passed \(/);
    // In Pi this line is a LIVE progress notice; a native verdict carries its
    // notices AFTER the verdict, so the start line would read as stale noise.
    assert.doesNotMatch(verdict.userMessage ?? "", /reviewing changes with/);
    assert.doesNotMatch(verdict.userMessage ?? "", /asking reviewers/);
    assert.equal(await harness.calls(), 1, "the review still ran");
  } finally {
    await harness.dispose();
  }
});

test("a Git workspace arms through the checkpoint strategy and reviews to a pass", async () => {
  const harness = await createHarness({ git: true });
  try {
    const before = await execOut(harness);
    await harness.coordinator.onReviewRequest(ups("session-git"), newAbortSignal().signal);
    assert.deepEqual(await harness.records(), [], "a Git workspace pins a checkpoint, it never writes a raw record");
    assert.notEqual((await execOut(harness)).trim(), before.trim(), "the review armed a checkpoint ref");

    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-git", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
    const verdict = await harness.coordinator.onReviewRequest(stop("session-git"), newAbortSignal().signal);
    assert.equal(verdict.action, "block");
    assert.match(verdict.userMessage ?? "", /^review gate: passed/);

    const disposed = await harness.dispose();
    assert.deepEqual(disposed, { unreviewedConversations: 1 });
    await waitFor(async () => (await execOut(harness)).trim() === before.trim(), 5_000);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

function execOut(harness: Harness): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["for-each-ref", "--format=%(refname)"], { cwd: harness.workspace, env: gitEnv() },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

test("a Stop with no armed window allows with no notice", async () => {
  const harness = await createHarness();
  try {
    const verdict = await harness.coordinator.onReviewRequest(stop("session-never-armed"), newAbortSignal().signal);
    assert.deepEqual(verdict, { action: "allow" });
    assert.equal(await harness.calls(), 0);
  } finally {
    await harness.dispose();
  }
});

test("an unchanged turn allows without launching a reviewer", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-clean"), newAbortSignal().signal);
    harness.coordinator.noteToolActivity("session-clean", { toolName: "Write", readOnly: false });
    const verdict = await harness.coordinator.onReviewRequest(stop("session-clean"), newAbortSignal().signal);
    assert.deepEqual(verdict, { action: "allow" });
    assert.equal(await harness.calls(), 0, "no change means no reviewer");
  } finally {
    await harness.dispose();
  }
});

/**
 * The raw checkpoint capture's own per-entry cap, mirrored from
 * `src/review-checkpoint.ts`. It is a constant in the capture code rather than
 * a setting, so a test that has to exceed it names it here.
 */
const RAW_CAPTURE_MAX_ENTRY_BYTES = 512 * 1024 * 1024;

/**
 * Make the next capture fail with an eligible acquisition failure on every
 * platform; returns the undo.
 *
 * `captureReviewCheckpoint` refuses an untracked entry whose `stat` size is
 * over its capture cap before it reads a byte, from the content stage of
 * acquisition, so the outcome is exactly the acquisition failure the fallback
 * is defined for: `status: "failed"` with `evidenceCaptureFailure: true` and
 * `reason: "raw_checkpoint_failed"` — what `isEligibleReviewCaptureFailure`
 * accepts (the Git strategy reports the same refusal as `untracked_too_large`,
 * which is eligible too). The EACCES route to that eligibility — `chmod 000`
 * on a directory — does nothing on Windows and nothing as root, so the size
 * route is the one that holds everywhere: the cap is enforced whatever the uid.
 *
 * Capture rejects the entry before reading a byte of it, though extending it
 * can allocate about 512 MiB on a Windows filesystem. Deleting it is the undo,
 * and the next capture then succeeds, which is what the tests' recovery steps
 * need.
 */
async function breakCapture(harness: Harness): Promise<() => Promise<void>> {
  const oversized = join(harness.workspace, "oversized.bin");
  // `truncate` extends an existing file; it never creates one.
  await writeFile(oversized, "", "utf8");
  await truncate(oversized, RAW_CAPTURE_MAX_ENTRY_BYTES + 1);
  return async () => { await rm(oversized, { force: true }); };
}

test("fallback On: a capture failure warns once per conversation, retries quietly, and warns again only after a recovery", async () => {
  const harness = await createHarness({ git: false });
  let undo: (() => Promise<void>) | undefined;
  try {
    undo = await breakCapture(harness);
    const first = await harness.coordinator.onReviewRequest(ups("session-fallback"), newAbortSignal().signal);
    assert.equal(first.action, "allow", "an eligible failure continues, as in Pi");
    assert.match(first.userMessage ?? "", /snapshot could not be captured, so this session's turns are not reviewed until one succeeds/);
    assert.deepEqual(await harness.records(), [], "nothing is armed");

    await writeFile(join(harness.workspace, "added.ts"), "new\n", "utf8");
    harness.coordinator.noteToolActivity("session-fallback", { toolName: "Write", readOnly: false });
    assert.deepEqual(await harness.coordinator.onReviewRequest(stop("session-fallback"), newAbortSignal().signal), { action: "allow" },
      "an unarmed turn is not reported as reviewed");
    assert.deepEqual(await harness.coordinator.onReviewRequest(ups("session-fallback", "again"), newAbortSignal().signal), { action: "allow" },
      "a repeated failure retries quietly: no second warning");
    assert.equal(await harness.calls(), 0);

    // No Tools only latch: once the snapshot works again, a prompt arms. But a
    // prompt never captures into a window whose arm already failed, so this Stop
    // first closes the window that could not arm, and the prompt after it opens
    // a fresh window that tries the snapshot again.
    assert.deepEqual(await harness.coordinator.onReviewRequest(stop("session-fallback"), newAbortSignal().signal),
      { action: "allow" }, "the window that could never arm closes quietly");
    await undo();
    undo = undefined;
    assert.deepEqual(await harness.coordinator.onReviewRequest(ups("session-fallback", "recovered"), newAbortSignal().signal), { action: "allow" },
      "recovery arms silently");
    assert.equal((await harness.records()).length, 1, "the retried snapshot armed a real baseline");
  } finally {
    await undo?.();
    await harness.dispose();
  }
});

test("fallback Off: an eligible capture failure warns at each failing prompt and continues unreviewed, as Pi does", async () => {
  const harness = await createHarness({ git: false });
  let undo: (() => Promise<void>) | undefined;
  try {
    harness.config = { ...harness.config, review: { ...harness.config.review!, evidence: { snapshotFailureFallback: false } } };
    undo = await breakCapture(harness);
    // The second prompt arrives while the first prompt's window is still open, so
    // it never re-attempts the capture that window already failed — and it still
    // warns, because every prompt of a window that cannot be reviewed is disclosed.
    for (const prompt of ["first", "second"]) {
      const verdict = await harness.coordinator.onReviewRequest(ups("session-fallback-off", prompt), newAbortSignal().signal);
      assert.equal(verdict.action, "allow", "never blocked: Pi continues the turn unreviewed");
      assert.match(verdict.userMessage ?? "", /Review disabled for this turn/);
      assert.doesNotMatch(verdict.userMessage ?? "", /Tools only/, "no advice to use Tools only, which cannot review a native row");
    }
    assert.deepEqual(await harness.records(), []);
    assert.equal(await harness.calls(), 0);
  } finally {
    await undo?.();
    await harness.dispose();
  }
});

/**
 * #736 U14: the same snapshot failure at SETTLEMENT, on a window that armed
 * successfully. A native row records no tool evidence, so the shared Tools-only
 * fallback would review nothing, retire the window, and say “current tool
 * evidence is kept” — false here. Native turns the fallback off for the
 * settlement call, so the failure keeps the turn pending and retries at the next
 * `Stop`, exactly as an arm-time failure does.
 */
test("fallback On: a snapshot failure at settlement warns once, keeps the window, and reviews at the next Stop", async () => {
  const harness = await createHarness({ git: false });
  let undo: (() => Promise<void>) | undefined;
  try {
    const armed = await harness.coordinator.onReviewRequest(ups("session-settle-fallback"), newAbortSignal().signal);
    assert.deepEqual(armed, { action: "allow" }, "the prompt arms normally");
    assert.equal((await harness.records()).length, 1, "the window owns a real baseline");

    // The snapshot breaks only AFTER the arm, so this is a settlement failure.
    undo = await breakCapture(harness);
    await writeFile(join(harness.workspace, "added.ts"), "new\n", "utf8");
    harness.coordinator.noteToolActivity("session-settle-fallback", { toolName: "Write", readOnly: false });

    const failed = await harness.coordinator.onReviewRequest(stop("session-settle-fallback"), newAbortSignal().signal);
    assert.equal(failed.action, "allow", "the turn continues unreviewed rather than being certified");
    assert.match(failed.userMessage ?? "", /snapshot could not be captured, so this session's turns are not reviewed until one succeeds/);
    assert.match(failed.userMessage ?? "", /\(.+\)/, "the notice carries the closed capture reason");
    assert.equal(await harness.calls(), 0, "no reviewer ran on an empty Tools-only record");
    assert.equal((await harness.records()).length, 1, "the window keeps its baseline: nothing was released");

    // Capture recovers. The failing settlement advanced no activity mark, so the
    // next `Stop` retries the comparison with NO new tool call.
    await undo();
    undo = undefined;
    const reviewed = await harness.coordinator.onReviewRequest(stop("session-settle-fallback"), newAbortSignal().signal);
    assert.equal(reviewed.action, "block", "the pending change is reviewed at the next Stop");
    assert.match(reviewed.userMessage ?? "", /^review gate: passed \(/);
    assert.equal(await harness.calls(), 1);

    const keptRecords = (await harness.records()).length;
    // That successful settlement WAS the recovery, so a later capture failure in
    // the SAME conversation warns again — with no new prompt arm in between,
    // because an already-armed window never captures at arm time.
    undo = await breakCapture(harness);
    await writeFile(join(harness.workspace, "added-again.ts"), "more\n", "utf8");
    harness.coordinator.noteToolActivity("session-settle-fallback", { toolName: "Write", readOnly: false });
    const again = await harness.coordinator.onReviewRequest(stop("session-settle-fallback"), newAbortSignal().signal);
    assert.equal(again.action, "allow", "the new failure again continues unreviewed");
    assert.match(again.userMessage ?? "", /snapshot could not be captured/,
      "the warning is re-armed by the successful capture, not spent for the conversation");
    assert.equal(await harness.calls(), 1, "and still no reviewer ran on it");
    assert.equal((await harness.records()).length, keptRecords, "the window and its baselines are still kept");
  } finally {
    await undo?.();
    await harness.dispose();
  }
});

test("fallback On: a Stop that compared the workspace before it was cancelled re-arms the snapshot warning", async () => {
  const harness = await createHarness({ git: false, reviewerDelayMs: 400 });
  let undo: (() => Promise<void>) | undefined;
  try {
    await harness.coordinator.onReviewRequest(ups("session-settle-cancelled-capture"), newAbortSignal().signal);
    undo = await breakCapture(harness);
    await writeFile(join(harness.workspace, "added.ts"), "new\n", "utf8");
    harness.coordinator.noteToolActivity("session-settle-cancelled-capture", { toolName: "Write", readOnly: false });
    const first = await harness.coordinator.onReviewRequest(stop("session-settle-cancelled-capture"), newAbortSignal().signal);
    assert.match(first.userMessage ?? "", /snapshot could not be captured/, "the first failure warns");

    // Capture recovers, and this Stop gets as far as LAUNCHING the reviewer —
    // which can only happen after the workspace comparison succeeded — before it
    // is cancelled, so the run never returns a verdict.
    await undo();
    undo = undefined;
    const cancelling = newAbortSignal();
    const running = harness.coordinator.onReviewRequest(stop("session-settle-cancelled-capture"), cancelling.signal);
    await waitFor(async () => (await harness.calls()) === 1, 10_000);
    cancelling.abort();
    assert.deepEqual(await running, { action: "allow" }, "a cancelled Stop delivers nothing");

    // Capture breaks again, with no new tool call and no new prompt arm. The
    // warning is due again: the cancelled Stop's capture proved the snapshot
    // works, and notice deduplication is all this resets.
    undo = await breakCapture(harness);
    const again = await harness.coordinator.onReviewRequest(stop("session-settle-cancelled-capture"), newAbortSignal().signal);
    assert.equal(again.action, "allow");
    assert.match(again.userMessage ?? "", /snapshot could not be captured/,
      "a successful capture re-arms the notice even when that run never completed");
    assert.equal(await harness.calls(), 1, "the failing Stop ran no reviewer");
  } finally {
    await undo?.();
    await harness.dispose();
  }
});

test("fallback On: a second failing settlement Stop in the same conversation is a quiet allow", async () => {
  const harness = await createHarness({ git: false });
  let undo: (() => Promise<void>) | undefined;
  try {
    await harness.coordinator.onReviewRequest(ups("session-settle-fallback-once"), newAbortSignal().signal);
    undo = await breakCapture(harness);
    await writeFile(join(harness.workspace, "added.ts"), "new\n", "utf8");
    harness.coordinator.noteToolActivity("session-settle-fallback-once", { toolName: "Write", readOnly: false });

    const first = await harness.coordinator.onReviewRequest(stop("session-settle-fallback-once"), newAbortSignal().signal);
    assert.match(first.userMessage ?? "", /snapshot could not be captured/);
    // The window is still open and its activity is still unspent, so the next
    // `Stop` retries the comparison — and warns only once per conversation.
    const second = await harness.coordinator.onReviewRequest(stop("session-settle-fallback-once"), newAbortSignal().signal);
    assert.deepEqual(second, { action: "allow" }, "a repeated failure retries quietly, as at arm time");
    assert.equal(await harness.calls(), 0);
    assert.equal((await harness.records()).length, 1, "and the window is still kept");
  } finally {
    await undo?.();
    await harness.dispose();
  }
});

test("fallback Off: a snapshot failure at settlement warns at each failing Stop and keeps the window", async () => {
  const harness = await createHarness({ git: false });
  let undo: (() => Promise<void>) | undefined;
  try {
    harness.config = { ...harness.config, review: { ...harness.config.review!, evidence: { snapshotFailureFallback: false } } };
    await harness.coordinator.onReviewRequest(ups("session-settle-fallback-off"), newAbortSignal().signal);
    assert.equal((await harness.records()).length, 1, "the prompt armed normally");
    undo = await breakCapture(harness);
    await writeFile(join(harness.workspace, "added.ts"), "new\n", "utf8");
    harness.coordinator.noteToolActivity("session-settle-fallback-off", { toolName: "Write", readOnly: false });

    for (const attempt of [1, 2]) {
      const verdict = await harness.coordinator.onReviewRequest(stop("session-settle-fallback-off"), newAbortSignal().signal);
      assert.equal(verdict.action, "allow", `never blocked: the turn continues unreviewed (attempt ${attempt})`);
      assert.match(verdict.userMessage ?? "", /Review disabled for this turn/, "every failing turn is disclosed");
      assert.doesNotMatch(verdict.userMessage ?? "", /Tools only/, "no advice to use Tools only, which cannot review a native row");
      assert.equal(await harness.calls(), 0);
      assert.equal((await harness.records()).length, 1, "the window and its baseline survive each failing Stop");
    }
  } finally {
    await undo?.();
    await harness.dispose();
  }
});

test("a settlement snapshot failure never tells a native row that its tool evidence was kept", async () => {
  const harness = await createHarness({ git: false });
  let undo: (() => Promise<void>) | undefined;
  const userMessages: string[] = [];
  try {
    await harness.coordinator.onReviewRequest(ups("session-settle-no-tools-claim"), newAbortSignal().signal);
    undo = await breakCapture(harness);
    await writeFile(join(harness.workspace, "added.ts"), "new\n", "utf8");
    harness.coordinator.noteToolActivity("session-settle-no-tools-claim", { toolName: "Write", readOnly: false });
    for (const _attempt of [1, 2]) {
      const verdict = await harness.coordinator.onReviewRequest(stop("session-settle-no-tools-claim"), newAbortSignal().signal);
      assert.equal(verdict.action, "allow");
      userMessages.push(verdict.userMessage ?? "");
    }
    await undo();
    undo = undefined;
    const reviewed = await harness.coordinator.onReviewRequest(stop("session-settle-no-tools-claim"), newAbortSignal().signal);
    userMessages.push(reviewed.userMessage ?? "");
    assert.equal(await harness.calls(), 1, "the recovered Stop really reviewed");
    for (const message of userMessages) {
      assert.doesNotMatch(message, /Tools only \(snapshot-failure fallback\)/,
        "a native row has no tool evidence to keep, so that Pi warning is never true here");
    }
  } finally {
    await undo?.();
    await harness.dispose();
  }
});

test("a window that never armed closes at its Stop, so the next prompt opens a fresh window", async () => {
  // A window whose arm never attached a baseline can never be reviewed, and Pi
  // closes such a window at settlement. It must not stay open to collect later
  // prompts: a prompt that piled in would be judged against the stale first
  // request the window had already remembered, and its own work would earn no
  // baseline of its own.
  const harness = await createHarness({ git: false });
  let undo: (() => Promise<void>) | undefined;
  try {
    undo = await breakCapture(harness);
    const failed = await harness.coordinator.onReviewRequest(ups("session-close-unarmed", "the first request"), newAbortSignal().signal);
    assert.match(failed.userMessage ?? "", /snapshot could not be captured/, "the failed arm still warns");
    assert.deepEqual(await harness.records(), [], "nothing was armed");

    assert.deepEqual(
      await harness.coordinator.onReviewRequest(stop("session-close-unarmed"), newAbortSignal().signal),
      { action: "allow" },
      "an unreviewable window closes quietly, with no notice for a turn that was never armed",
    );

    // Capture works again, and this prompt opens its OWN window.
    await undo();
    undo = undefined;
    assert.deepEqual(
      await harness.coordinator.onReviewRequest(ups("session-close-unarmed", "the second request"), newAbortSignal().signal),
      { action: "allow" },
      "the next prompt arms a fresh window",
    );
    assert.equal((await harness.records()).length, 1, "the fresh window captured its own baseline");

    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-close-unarmed", { toolName: "Write", readOnly: false });
    const reviewed = await harness.coordinator.onReviewRequest(stop("session-close-unarmed"), newAbortSignal().signal);
    assert.equal(reviewed.action, "block");
    assert.equal(await harness.calls(), 1);
    const request = await readText(join(bundleDirOf(reviewed.reason!), "reviews", "0001", "request.md"));
    assert.match(request, /the second request/, "the fresh window's initial request is this prompt");
    assert.equal(request.includes("the first request"), false, "the stale first prompt never becomes the reviewer's request");
  } finally {
    await undo?.();
    await harness.dispose();
  }
});

test("a prompt never captures into a window whose arm already failed", async () => {
  // The failed turn's work is unreviewed, and a baseline captured later into the
  // SAME window would certify it as reviewed. So a later prompt into that window
  // answers exactly as it would have, minus the capture — even once capture works
  // again — and only the NEXT window arms.
  const harness = await createHarness({ git: false });
  let undo: (() => Promise<void>) | undefined;
  try {
    undo = await breakCapture(harness);
    const first = await harness.coordinator.onReviewRequest(ups("session-disabled-window", "first"), newAbortSignal().signal);
    assert.match(first.userMessage ?? "", /snapshot could not be captured/);
    assert.deepEqual(await harness.records(), [], "the first prompt armed nothing");

    // Capture would succeed now, and the window is still open: it still captures
    // nothing into that window, and the prompt still proceeds unreviewed.
    await undo();
    undo = undefined;
    assert.deepEqual(
      await harness.coordinator.onReviewRequest(ups("session-disabled-window", "second"), newAbortSignal().signal),
      { action: "allow" },
      "the request proceeds quietly: this window's notice was already given",
    );
    assert.deepEqual(await harness.records(), [], "a later prompt never captures into the window that failed");

    // Its Stop closes the unreviewable window, and the window after it arms.
    assert.deepEqual(
      await harness.coordinator.onReviewRequest(stop("session-disabled-window"), newAbortSignal().signal),
      { action: "allow" },
    );
    assert.deepEqual(
      await harness.coordinator.onReviewRequest(ups("session-disabled-window", "third"), newAbortSignal().signal),
      { action: "allow" },
    );
    assert.equal((await harness.records()).length, 1, "the next window arms normally");
    assert.equal(await harness.calls(), 0, "no turn of the disabled window was ever reported as reviewed");
  } finally {
    await undo?.();
    await harness.dispose();
  }
});

test("a disabled window still gives the notice its current settings call for", async () => {
  // Skipping only the capture must never skip a disclosure. The settings can
  // change after a window fails to arm, and what the CURRENT setting means for
  // this row still has to be said.
  const harness = await createHarness({ git: false });
  let undo: (() => Promise<void>) | undefined;
  try {
    undo = await breakCapture(harness);
    const first = await harness.coordinator.onReviewRequest(ups("session-disabled-notice", "first"), newAbortSignal().signal);
    assert.match(first.userMessage ?? "", /snapshot could not be captured/, "the failed arm warned about the fallback");
    assert.deepEqual(await harness.records(), [], "the window armed nothing");

    // The user now selects Tools only, and no prompt of this window has ever said
    // that a native row cannot be reviewed that way.
    harness.config = { ...harness.config, review: { ...harness.config.review!, evidence: { primaryToolOnly: true } } };
    const second = await harness.coordinator.onReviewRequest(ups("session-disabled-notice", "second"), newAbortSignal().signal);
    assert.match(second.userMessage ?? "", /Tools only, which cannot see a hosted native session's tool calls/,
      "the Tools-only notice is not swallowed by the disabled window");
    assert.deepEqual(await harness.records(), [], "and the window is still never armed");

    const third = await harness.coordinator.onReviewRequest(ups("session-disabled-notice", "third"), newAbortSignal().signal);
    assert.deepEqual(third, { action: "allow" }, "the notice is still once per conversation");
    assert.deepEqual(await harness.records(), [], "still nothing armed");
  } finally {
    await undo?.();
    await harness.dispose();
  }
});

test("a disabled window keeps the capture failure it failed for across settings changes", async () => {
  const harness = await createHarness({ git: false });
  let undo: (() => Promise<void>) | undefined;
  try {
    harness.config = { ...harness.config, review: { ...harness.config.review!, evidence: { snapshotFailureFallback: false } } };
    undo = await breakCapture(harness);
    const first = await harness.coordinator.onReviewRequest(ups("session-disabled-fallback", "first"), newAbortSignal().signal);
    assert.match(first.userMessage ?? "", /Review disabled for this turn/, "fallback Off warned at this prompt");
    assert.doesNotMatch(first.userMessage ?? "", /until one succeeds/, "and never showed the fallback-On warning");

    // The user selects Tools only. That prompt is answered by the CURRENT method,
    // and it must not erase the fact that this window failed its snapshot: nothing
    // in a disabled window retries the capture, so no later prompt can honestly
    // report a different reason.
    harness.config = {
      ...harness.config,
      review: { ...harness.config.review!, evidence: { snapshotFailureFallback: false, primaryToolOnly: true } },
    };
    const second = await harness.coordinator.onReviewRequest(ups("session-disabled-fallback", "second"), newAbortSignal().signal);
    assert.match(second.userMessage ?? "", /Tools only, which cannot see a hosted native session's tool calls/,
      "the Tools-only notice follows the current settings");
    assert.deepEqual(await harness.records(), [], "no capture was retried for the disabled window");

    // Back to snapshots with the fallback On, before any Stop. The conversation has
    // still never been told what that means while snapshots keep failing.
    harness.config = { ...harness.config, review: { ...harness.config.review!, evidence: { snapshotFailureFallback: true } } };
    const third = await harness.coordinator.onReviewRequest(ups("session-disabled-fallback", "third"), newAbortSignal().signal);
    assert.match(third.userMessage ?? "", /snapshot could not be captured, so this session's turns are not reviewed until one succeeds/,
      "the conversation's first fallback-On notice survives the Tools-only prompt");
    assert.deepEqual(await harness.records(), [], "still no capture attempt");

    const fourth = await harness.coordinator.onReviewRequest(ups("session-disabled-fallback", "fourth"), newAbortSignal().signal);
    assert.deepEqual(fourth, { action: "allow" }, "once per conversation, as always");

    // The turn's Stop closes the unreviewable window, and the window after it arms.
    assert.deepEqual(
      await harness.coordinator.onReviewRequest(stop("session-disabled-fallback"), newAbortSignal().signal),
      { action: "allow" },
    );
    assert.deepEqual(await harness.records(), [], "no baseline was ever captured for this window");
    await undo();
    undo = undefined;
    assert.deepEqual(
      await harness.coordinator.onReviewRequest(ups("session-disabled-fallback", "after the close"), newAbortSignal().signal),
      { action: "allow" },
    );
    assert.equal((await harness.records()).length, 1, "the next window arms normally");
  } finally {
    await undo?.();
    await harness.dispose();
  }
});

test("requests cancelled while queued still take their slots and leave the next prompt able to arm", async () => {
  // A request the host answered before its slot ran — its deadline fired while it
  // was queued, or the row hung up — is already history to the provider, which
  // moved on and is working. Its slot still owes the conversation the record that
  // the turn ran unreviewed, or the next prompt captures a baseline over that work.
  // The harness's one `deadlineMs` cannot make a queued request outlive its own
  // deadline while an earlier slot is still closing a window, so this reaches the
  // same slot entry by cancelling the request outright: either way the coordinator
  // finds an aborted controller before the slot has read the settings.
  let holdNext = false;
  let held = 0;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const harness = await createHarness({
    observeBaselineVerification: async () => {
      if (!holdNext) return;
      holdNext = false;
      held += 1;
      await firstHeld;
    },
  });
  try {
    await harness.coordinator.onReviewRequest(ups("session-lost-slot"), newAbortSignal().signal);
    assert.equal((await harness.records()).length, 1, "the first prompt armed a window");

    // This Stop closes that window (nothing changed), but it is parked in an
    // uninterruptible verification while the next prompt queues behind it.
    holdNext = true;
    const settling = harness.coordinator.onReviewRequest(stop("session-lost-slot"), newAbortSignal().signal);
    await waitFor(async () => held === 1, 5_000);

    const cancelled = newAbortSignal();
    cancelled.abort(new Error("the row hung up while this prompt was queued"));
    const lost = harness.coordinator.onReviewRequest(ups("session-lost-slot", "the turn nobody reviewed"), cancelled.signal);
    // The turn's own Stop is cancelled as well, and one prompt squeezes in between
    // them: it must not certify the lost turn's work either.
    const between = harness.coordinator.onReviewRequest(ups("session-lost-slot", "in between"), newAbortSignal().signal);
    const lostStop = harness.coordinator.onReviewRequest(stop("session-lost-slot"), cancelled.signal);

    releaseFirst();
    assert.deepEqual(await settling, { action: "allow" }, "the unchanged turn closed its window without a reviewer");
    await waitFor(async () => (await harness.records()).length === 0, 5_000);
    assert.deepEqual(await lost, { action: "allow" }, "the cancelled prompt still takes its slot, and answers allow");

    // The lost turn's work is what no later baseline may cover.
    await writeFile(join(harness.workspace, "index.ts"), "written by the lost turn\n", "utf8");
    harness.coordinator.noteToolActivity("session-lost-slot", { toolName: "Write", readOnly: false });
    assert.deepEqual(await between, { action: "allow" });
    assert.deepEqual(await harness.records(), [], "no baseline is captured over the unreviewed turn");

    // The cancelled Stop takes its slot too. A window with no baseline holds
    // nothing to review and nothing to retry, so it closes there; otherwise the
    // conversation stays stuck unreviewed after the turn already sent its Stop.
    assert.deepEqual(await lostStop, { action: "allow" }, "the cancelled Stop retires the unarmed window");
    assert.deepEqual(await harness.records(), [], "retiring an unarmed window captures nothing");

    // And the conversation is usable again: the next prompt arms a fresh baseline.
    assert.deepEqual(
      await harness.coordinator.onReviewRequest(ups("session-lost-slot", "after the close"), newAbortSignal().signal),
      { action: "allow" },
    );
    assert.equal((await harness.records()).length, 1, "the next prompt arms a fresh window");
    assert.equal(await harness.calls(), 0, "nothing was ever reported as reviewed");
  } finally {
    releaseFirst();
    await harness.dispose();
  }
});

test("a baseline capture that cannot fall back fails CLOSED and blocks the prompt", async () => {
  const harness = await createHarness({ unusableAgentDir: true });
  try {
    const verdict = await harness.coordinator.onReviewRequest(ups("session-failclosed"), newAbortSignal().signal);
    assert.equal(verdict.action, "block", "no baseline means nothing this turn produces can be reviewed");
    assert.match(verdict.reason ?? "", /could not capture the workspace baseline/);
    assert.match(verdict.reason ?? "", /automatic review Off in Review settings/);
    assert.match(verdict.reason ?? "", /raw_checkpoint_failed/, "the closed short detail is carried");
    assert.match(verdict.userMessage ?? "", /this turn was not reviewed/);
    assert.equal(await harness.calls(), 0);

    // With the snapshot-failure fallback explicitly Off, the same honest
    // fail-closed answer stands: a native row has no manual review to resume.
    harness.config = {
      ...harness.config,
      review: { ...harness.config.review!, evidence: { snapshotFailureFallback: false } },
    };
    const fallbackOff = await harness.coordinator.onReviewRequest(ups("session-failclosed-off"), newAbortSignal().signal);
    assert.equal(fallbackOff.action, "block");
  } finally {
    await harness.dispose();
  }
}

);

test("configured Tools only arms nothing, says once that these turns are not reviewed, and reviews nothing", async () => {
  const harness = await createHarness();
  try {
    harness.config = { ...harness.config, review: { ...harness.config.review!, evidence: { primaryToolOnly: true } } };
    const armed = await harness.coordinator.onReviewRequest(ups("session-toolonly"), newAbortSignal().signal);
    assert.equal(armed.action, "allow");
    assert.match(armed.userMessage ?? "", /Tools only, which cannot see a hosted native session's tool calls/);
    const again = await harness.coordinator.onReviewRequest(ups("session-toolonly", "again"), newAbortSignal().signal);
    assert.deepEqual(again, { action: "allow" }, "said once per conversation, not on every prompt");
    assert.deepEqual(await harness.records(), []);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-toolonly", { toolName: "Write", readOnly: false });
    const settled = await harness.coordinator.onReviewRequest(stop("session-toolonly"), newAbortSignal().signal);
    assert.deepEqual(settled, { action: "allow" }, "nothing was armed, so nothing is reported as reviewed");
    assert.equal(await harness.calls(), 0);

    // A window that could never arm closed at that Stop, so this prompt opens a
    // fresh window — and the notice is still once per CONVERSATION, not per window.
    const third = await harness.coordinator.onReviewRequest(ups("session-toolonly", "third"), newAbortSignal().signal);
    assert.deepEqual(third, { action: "allow" }, "the notice is per conversation, and no window arms");
    assert.deepEqual(await harness.records(), [], "Tools only never captures a baseline");
  } finally {
    await harness.dispose();
  }
});

// ---------------------------------------------------------------------------
// Settlement on Stop
// ---------------------------------------------------------------------------

test("needs_changes blocks with the complete transmission and a changes-requested notice", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-needs-changes"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-needs-changes", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
    const verdict = await harness.coordinator.onReviewRequest(stop("session-needs-changes"), newAbortSignal().signal);
    assert.equal(verdict.action, "block");
    assert.match(verdict.reason ?? "", /missing test/, "the reviewer's finding reaches the model");
    assert.match(verdict.reason ?? "", /Complete immutable pass evidence/);
    assert.match(verdict.userMessage ?? "", /^review gate: changes requested \(/);
    assert.equal(await harness.calls(), 1);
    await harness.dispose();
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a passing review arms the response turn so a following unchanged Stop allows", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-response"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-response", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
    const passed = await harness.coordinator.onReviewRequest(stop("session-response"), newAbortSignal().signal);
    assert.equal(passed.action, "block");
    assert.equal(await harness.calls(), 1);

    // The model answers the pass without touching the workspace, so no
    // qualifying call is reported: the settlement runs no reviewer and returns
    // runReview's pass-without-activity outcome.
    harness.coordinator.noteToolActivity("session-response", { toolName: "Read", readOnly: true });
    const response = await harness.coordinator.onReviewRequest(stop("session-response", "Confirmed, nothing else to change."), newAbortSignal().signal);
    assert.deepEqual(response, { action: "allow" }, "an unchanged response turn is not re-reviewed");
    assert.equal(await harness.calls(), 1, "the response turn never launched a second reviewer");
  } finally {
    await harness.dispose();
  }
});

test("automatic correction stops at the configured cap", async () => {
  const harness = await createHarness();
  try {
    harness.config = { ...harness.config, maxCorrectionCycles: 1 };
    await harness.coordinator.onReviewRequest(ups("session-cap"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "one.ts"), "one\n", "utf8");
    harness.coordinator.noteToolActivity("session-cap", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
    const first = await harness.coordinator.onReviewRequest(stop("session-cap"), newAbortSignal().signal);
    assert.equal(first.action, "block");
    assert.match(first.userMessage ?? "", /changes requested \(/, "the first cycle is a normal correction");

    // A genuinely different change keeps this out of the no-progress guard.
    await writeFile(join(harness.workspace, "two.ts"), "two\n", "utf8");
    harness.coordinator.noteToolActivity("session-cap", { toolName: "Write", readOnly: false });
    const second = await harness.coordinator.onReviewRequest(stop("session-cap"), newAbortSignal().signal);
    assert.equal(second.action, "block");
    assert.match(second.userMessage ?? "", /correction cap reached/);
    assert.match(second.reason ?? "", /Complete immutable pass evidence/, "the full feedback is still transmitted");
    // A native row has no /review-continue: the cap notice says what the user
    // can actually do here, which is prompt again (#736 U16).
    assert.match(second.userMessage ?? "", /Prompt the assistant again to resume automatic correction with a fresh correction budget/);
    assert.match(second.userMessage ?? "", /automatic review Off in Review settings/);
    assert.equal(await harness.calls(), 2);
  } finally {
    await harness.dispose();
  }
});

test("a prompt into a capped window resumes automatic correction with a fresh budget", async () => {
  // #736 U16: a hosted native row has no `/review-continue`, so the user's next
  // prompt into the capped window is the continuation Pi's command performs.
  const harness = await createHarness();
  try {
    harness.config = { ...harness.config, maxCorrectionCycles: 1 };
    await harness.coordinator.onReviewRequest(ups("session-continuation"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "one.ts"), "one\n", "utf8");
    harness.coordinator.noteToolActivity("session-continuation", { toolName: "Write", readOnly: false });
    await harness.coordinator.onReviewRequest(stop("session-continuation"), newAbortSignal().signal);

    await writeFile(join(harness.workspace, "two.ts"), "two\n", "utf8");
    harness.coordinator.noteToolActivity("session-continuation", { toolName: "Write", readOnly: false });
    const capped = await harness.coordinator.onReviewRequest(stop("session-continuation"), newAbortSignal().signal);
    assert.match(capped.userMessage ?? "", /correction cap reached/);
    assert.match(capped.userMessage ?? "", /Prompt the assistant again to resume automatic correction with a fresh correction budget/);
    assert.match(capped.reason ?? "", /automatic correction is deferred/, "the capped pass is a deferral");

    // The prompt IS the continuation: an allow, with the reset said to the user
    // and nothing new put in front of the model.
    const continued = await harness.coordinator.onReviewRequest(ups("session-continuation", "keep going"), newAbortSignal().signal);
    assert.equal(continued.action, "allow");
    assert.equal(continued.reason, undefined, "a continuation is never a block");
    assert.match(continued.userMessage ?? "", /^review gate: continuing review; correction budget reset to 1$/);

    // The next qualifying needs_changes is a CORRECTION again, not a second cap.
    await writeFile(join(harness.workspace, "three.ts"), "three\n", "utf8");
    harness.coordinator.noteToolActivity("session-continuation", { toolName: "Write", readOnly: false });
    const corrected = await harness.coordinator.onReviewRequest(stop("session-continuation"), newAbortSignal().signal);
    assert.equal(corrected.action, "block");
    assert.match(corrected.userMessage ?? "", /changes requested \(/);
    assert.doesNotMatch(corrected.userMessage ?? "", /correction cap reached/);
    assert.match(corrected.reason ?? "", /Action: Review found blocking issues/, "sent_for_correction, not another deferral");
    assert.equal(await harness.calls(), 3);
  } finally {
    await harness.dispose();
  }
});

test("the continuation marks the capped feedback sent and clears the cap marker", async () => {
  const harness = await createHarness();
  try {
    harness.config = { ...harness.config, maxCorrectionCycles: 1 };
    await harness.coordinator.onReviewRequest(ups("session-capped-mark"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "one.ts"), "one\n", "utf8");
    harness.coordinator.noteToolActivity("session-capped-mark", { toolName: "Write", readOnly: false });
    await harness.coordinator.onReviewRequest(stop("session-capped-mark"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "two.ts"), "two\n", "utf8");
    harness.coordinator.noteToolActivity("session-capped-mark", { toolName: "Write", readOnly: false });
    assert.match((await harness.coordinator.onReviewRequest(stop("session-capped-mark"), newAbortSignal().signal)).userMessage ?? "",
      /correction cap reached/);

    assert.match((await harness.coordinator.onReviewRequest(ups("session-capped-mark", "keep going"), newAbortSignal().signal)).userMessage ?? "",
      /continuing review; correction budget reset to 1/, "the first prompt continues the capped window");
    // The marker is cleared with it: only ONE prompt ever carries the
    // continuation, exactly as `/review-continue` can only be used once.
    const second = await harness.coordinator.onReviewRequest(ups("session-capped-mark", "and again"), newAbortSignal().signal);
    assert.doesNotMatch(second.userMessage ?? "", /continuing review/, "the cap marker was cleared, so nothing continues twice");

    // The capped pass's disposition is what the NEXT reviewer request renders.
    await writeFile(join(harness.workspace, "three.ts"), "three\n", "utf8");
    harness.coordinator.noteToolActivity("session-capped-mark", { toolName: "Write", readOnly: false });
    const corrected = await harness.coordinator.onReviewRequest(stop("session-capped-mark"), newAbortSignal().signal);
    const request = await readText(join(bundleDirOf(corrected.reason!), "reviews", "0003", "request.md"));
    assert.match(request, /feedback held at the correction cap, then sent/, "the capped feedback is held_then_sent");
    assert.equal(request.includes("with correction deferred at the cap"), false,
      "the continued pass no longer reads as still held at the cap");
  } finally {
    await harness.dispose();
  }
});

test("a continued capped window proves the resumed correction even with no net change", async () => {
  // The cap transmission armed this window's response exchange as a DEFERRED
  // response. If the continuation left that mode in place, a qualifying turn
  // that reports a tool call but leaves no net workspace change would settle as
  // an unchanged deferred response — no reviewer at all — right after the user
  // was told correction resumed.
  const harness = await createHarness();
  try {
    harness.config = { ...harness.config, maxCorrectionCycles: 1 };
    await harness.coordinator.onReviewRequest(ups("session-continuation-unchanged"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "one.ts"), "one\n", "utf8");
    harness.coordinator.noteToolActivity("session-continuation-unchanged", { toolName: "Write", readOnly: false });
    await harness.coordinator.onReviewRequest(stop("session-continuation-unchanged"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "two.ts"), "two\n", "utf8");
    harness.coordinator.noteToolActivity("session-continuation-unchanged", { toolName: "Write", readOnly: false });
    assert.match((await harness.coordinator.onReviewRequest(stop("session-continuation-unchanged"), newAbortSignal().signal)).userMessage ?? "",
      /correction cap reached/);

    await harness.setMode("pass");
    assert.match((await harness.coordinator.onReviewRequest(ups("session-continuation-unchanged", "keep going"), newAbortSignal().signal)).userMessage ?? "",
      /continuing review; correction budget reset to 1/);

    // A qualifying call with NO file change since the capped pass's checkpoint.
    harness.coordinator.noteToolActivity("session-continuation-unchanged", { toolName: "Bash", readOnly: false });
    const resumed = await harness.coordinator.onReviewRequest(stop("session-continuation-unchanged", "I addressed the findings without touching the tree."), newAbortSignal().signal);
    assert.equal(await harness.calls(), 3, "the resumed correction really reached the reviewer");
    assert.equal(resumed.action, "block", "and its verdict is delivered, not swallowed as an unchanged deferral");
    assert.match(resumed.userMessage ?? "", /review gate: passed \(/);
  } finally {
    await harness.dispose();
  }
});

test("a newer no-progress deferral supersedes an earlier cap marker", async () => {
  // The cap marker names the LATEST delivered review. A later deferral that is
  // not a cap must not leave the older marker behind: a prompt would otherwise
  // mark that newer feedback held_then_sent and reset the budget behind a
  // deferral whose own notice never promised a continuation.
  const harness = await createHarness({ git: true });
  try {
    harness.config = { ...harness.config, maxCorrectionCycles: 1 };
    await harness.coordinator.onReviewRequest(ups("session-stale-cap"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-stale-cap", { toolName: "Write", readOnly: false });
    assert.match((await harness.coordinator.onReviewRequest(stop("session-stale-cap"), newAbortSignal().signal)).userMessage ?? "",
      /changes requested \(/, "an ordinary correction first");

    // A genuinely different change set reaches the cap.
    await writeFile(join(harness.workspace, "asset.bin"), Buffer.from([0, 1]));
    harness.coordinator.noteToolActivity("session-stale-cap", { toolName: "Write", readOnly: false });
    // The NEXT Stop's qualifying call is the one the row reports while THIS
    // reviewer runs: it is not in the reviewed checkpoint (#736 U6), and the cap
    // marker already counts it, so the next turn can report nothing at all.
    harness.noteActivityDuringNextReview("session-stale-cap");
    const capped = await harness.coordinator.onReviewRequest(stop("session-stale-cap"), newAbortSignal().signal);
    assert.match(capped.userMessage ?? "", /correction cap reached/);

    // A binary-only edit is a real exchange delta the checkpoint sees, but the
    // CUMULATIVE no-progress fingerprint omits binary contents, and this turn
    // reports no tool activity of its own, so this Stop is a NEWER no-progress
    // deferral, not another cap.
    await writeFile(join(harness.workspace, "asset.bin"), Buffer.from([0, 2]));
    const deferred = await harness.coordinator.onReviewRequest(stop("session-stale-cap", "I changed the asset again."), newAbortSignal().signal);
    assert.match(deferred.userMessage ?? "", /repeated changes requested with no new correction evidence/);

    const prompt = await harness.coordinator.onReviewRequest(ups("session-stale-cap", "keep going"), newAbortSignal().signal);
    assert.equal(prompt.action, "allow");
    assert.doesNotMatch(prompt.userMessage ?? "", /continuing review/,
      "the superseded cap marker continues nothing");
  } finally {
    await harness.dispose();
  }
});

test("a prompt into a window with no capped feedback is unchanged", async () => {
  const harness = await createHarness();
  try {
    harness.config = { ...harness.config, maxCorrectionCycles: 1 };
    await harness.coordinator.onReviewRequest(ups("session-uncapped"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "one.ts"), "one\n", "utf8");
    harness.coordinator.noteToolActivity("session-uncapped", { toolName: "Write", readOnly: false });
    const first = await harness.coordinator.onReviewRequest(stop("session-uncapped"), newAbortSignal().signal);
    assert.match(first.userMessage ?? "", /changes requested \(/, "the first cycle is an ordinary correction");

    const prompt = await harness.coordinator.onReviewRequest(ups("session-uncapped", "keep going"), newAbortSignal().signal);
    assert.equal(prompt.action, "allow");
    assert.doesNotMatch(prompt.userMessage ?? "", /continuing review/, "nothing was capped, so nothing continues");

    // The spent budget survives the prompt: the next needs_changes still reaches
    // the cap, so the continuation is not a blanket reset on every prompt.
    await writeFile(join(harness.workspace, "two.ts"), "two\n", "utf8");
    harness.coordinator.noteToolActivity("session-uncapped", { toolName: "Write", readOnly: false });
    const capped = await harness.coordinator.onReviewRequest(stop("session-uncapped"), newAbortSignal().signal);
    assert.match(capped.userMessage ?? "", /correction cap reached/);
  } finally {
    await harness.dispose();
  }
});

test("a prompt after a repeated-no-progress deferral continues nothing", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-no-progress"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "one.ts"), "one\n", "utf8");
    harness.coordinator.noteToolActivity("session-no-progress", { toolName: "Write", readOnly: false });
    // The correction turn reports NO tool activity at all: its qualifying call
    // is the one reported while this reviewer runs (#736 U6), already counted in
    // the marker this turn records (#736 U7).
    harness.noteActivityDuringNextReview("session-no-progress");
    await harness.coordinator.onReviewRequest(stop("session-no-progress"), newAbortSignal().signal);
    const deferred = await harness.coordinator.onReviewRequest(stop("session-no-progress", "I did not change anything."), newAbortSignal().signal);
    assert.match(deferred.userMessage ?? "", /repeated changes requested with no new correction evidence/);
    assert.match(deferred.userMessage ?? "", /Ask the assistant to continue/, "the no-progress guidance is unchanged");

    const prompt = await harness.coordinator.onReviewRequest(ups("session-no-progress", "keep going"), newAbortSignal().signal);
    assert.equal(prompt.action, "allow");
    assert.doesNotMatch(prompt.userMessage ?? "", /continuing review/, "a no-progress deferral never sets the cap marker");
  } finally {
    await harness.dispose();
  }
});

test("a correction turn that reported tool activity is not judged no-progress", async () => {
  // #736 U7: native records no evidence events, so its no-progress check reads
  // the count of ALL reported tool activity, exactly where Pi reads
  // `window.evidence.events.length`. A correction turn that ran tools made
  // progress even when its file-change fingerprint is byte-identical.
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-activity-evidence"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-activity-evidence", { toolName: "Write", readOnly: false });
    // The NEXT Stop's qualifying call is the one the row reports while THIS
    // reviewer runs (#736 U6), so the correction turn's own report can be
    // read-only alone and that turn still reaches the reviewer.
    harness.noteActivityDuringNextReview("session-activity-evidence");
    const first = await harness.coordinator.onReviewRequest(stop("session-activity-evidence"), newAbortSignal().signal);
    assert.equal(first.action, "block");
    assert.match(first.userMessage ?? "", /changes requested \(/);
    assert.match(first.reason ?? "", /Action: Review found blocking issues/, "sent_for_correction");

    // Identical blocking findings over an unchanged change set, and the ONLY
    // activity this turn reports is a read-only call: read-only activity counts
    // toward the no-progress evidence exactly as Pi's evidence events do, so it
    // alone keeps this a correction. Drop it and the unchanged fingerprint makes
    // this the no-progress deferral instead.
    harness.coordinator.noteToolActivity("session-activity-evidence", { toolName: "Read", readOnly: true });
    const second = await harness.coordinator.onReviewRequest(stop("session-activity-evidence", "I did not change anything."), newAbortSignal().signal);
    assert.equal(second.action, "block");
    assert.doesNotMatch(second.userMessage ?? "", /repeated changes requested with no new correction evidence/,
      "reported activity is new correction evidence, unchanged fingerprint or not");
    assert.match(second.userMessage ?? "", /changes requested \(/);
    assert.match(second.reason ?? "", /Action: Review found blocking issues/, "sent_for_correction, not a deferral");
    assert.equal(await harness.calls(), 2);
  } finally {
    await harness.dispose();
  }
});

test("repeated identical feedback with no new correction evidence stops the loop", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-noprogress"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-noprogress", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
    // The correction turn reports NO tool activity at all: its qualifying call
    // is the one reported while THIS reviewer runs (#736 U6), which the marker
    // this settlement records already counts (#736 U7).
    harness.noteActivityDuringNextReview("session-noprogress");
    const first = await harness.coordinator.onReviewRequest(stop("session-noprogress"), newAbortSignal().signal);
    assert.equal(first.action, "block");
    assert.match(first.userMessage ?? "", /changes requested \(/);

    // The same blocking findings over the same unchanged change set, with no new
    // tool activity reported by this turn. With nothing new on either axis, the
    // loop stops.
    const second = await harness.coordinator.onReviewRequest(stop("session-noprogress", "I did not change anything."), newAbortSignal().signal);
    assert.equal(second.action, "block");
    assert.match(second.userMessage ?? "", /repeated changes requested with no new correction evidence/);
    assert.match(second.userMessage ?? "", /Stopping automatic correction to avoid a loop/);
    assert.match(second.userMessage ?? "", /Ask the assistant to continue/, "the deferral names the native way forward");
    assert.equal(await harness.calls(), 2);
  } finally {
    await harness.dispose();
  }
});

test("a reviewer that produces no verdict allows the turn with a reviewer-failed notice", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-review-error"), newAbortSignal().signal);
    await harness.setMode("error");
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-review-error", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
    const verdict = await harness.coordinator.onReviewRequest(stop("session-review-error"), newAbortSignal().signal);
    assert.equal(verdict.action, "block", "an error verdict is still a transmitted review outcome");
    assert.match(verdict.userMessage ?? "", /reviewer failed/);
    assert.equal(await harness.calls(), 1);
  } finally {
    await harness.dispose();
  }
});

test("background work defers the review, and unverifiable background state blocks it", async () => {
  const harness = await createHarness();
  const agents = harness.config.externalAgents;
  try {
    // #736 U8: armed while the configured reviewer cannot resolve, so the
    // background-deferred `Stop` is also the `Stop` that picks up the fixed
    // Review settings — a deferral still notifies the user, so it says so.
    harness.config = {
      ...harness.config,
      externalAgents: {},
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "gone" }] },
    };
    await harness.coordinator.onReviewRequest(ups("session-background"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    // U21: a workspace change alone never reaches the background census, so one
    // qualifying call is reported; the census, not the activity gate, defers.
    harness.coordinator.noteToolActivity("session-background", { toolName: "Write", readOnly: false });

    // The user fixes the reviewer while background work is still running.
    harness.config = {
      ...harness.config,
      externalAgents: agents,
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "fake" }] },
    };
    harness.background = { state: "running", count: 2 };
    const deferred = await harness.coordinator.onReviewRequest(stop("session-background"), newAbortSignal().signal);
    assert.equal(deferred.action, "allow");
    assert.match(deferred.userMessage ?? "", /deferred while 2 background task\(s\) remain active/);
    assert.match(
      deferred.userMessage ?? "",
      /review gate: 1 review window\(s\) reconciled to the updated reviewer settings \(1 configured reviewer\(s\)\); preserved evidence and history are unchanged/,
      "a deferred Stop still reports the settings it reconciled",
    );

    harness.background = { state: "unknown", detail: "the row's task list was unreadable" };
    const blocked = await harness.coordinator.onReviewRequest(stop("session-background"), newAbortSignal().signal);
    assert.equal(blocked.action, "allow");
    assert.match(blocked.userMessage ?? "", /background state could not be verified: the row's task list was unreadable/);
    assert.doesNotMatch(blocked.userMessage ?? "", /reconciled to the updated reviewer settings/, "the reconciliation is reported once");

    assert.equal(await harness.calls(), 0, "neither deferral nor a block launches a reviewer");

    // The window, its baseline and its evidence all survive both answers.
    harness.background = { state: "idle" };
    harness.coordinator.noteToolActivity("session-background", { toolName: "Write", readOnly: false });
    const settled = await harness.coordinator.onReviewRequest(stop("session-background"), newAbortSignal().signal);
    assert.equal(settled.action, "block");
    assert.match(settled.userMessage ?? "", /passed/, "the reconciled selection is what reviewed the change");
    assert.doesNotMatch(settled.userMessage ?? "", /reconciled to the updated reviewer settings/, "and the notice is not repeated");
  } finally {
    await harness.dispose();
  }
});

test("read-only activity alone never earns a review, and one qualifying call does", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-activity"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    assert.equal(harness.coordinator.activityTracked, false, "nothing reported yet");

    harness.coordinator.noteToolActivity("session-activity", { toolName: "Read", readOnly: true });
    harness.coordinator.noteToolActivity("session-activity", { toolName: "Grep", readOnly: true });
    assert.equal(harness.coordinator.activityTracked, true);
    const quiet = await harness.coordinator.onReviewRequest(stop("session-activity"), newAbortSignal().signal);
    assert.deepEqual(quiet, { action: "allow" }, "looking around is not reviewable work");
    assert.equal(await harness.calls(), 0);

    harness.coordinator.noteToolActivity("session-activity", { toolName: "Write", readOnly: false });
    const reviewed = await harness.coordinator.onReviewRequest(stop("session-activity"), newAbortSignal().signal);
    assert.equal(reviewed.action, "block");
    assert.equal(await harness.calls(), 1);

    // Another Stop with no further qualifying call is not a second review.
    const again = await harness.coordinator.onReviewRequest(stop("session-activity"), newAbortSignal().signal);
    assert.deepEqual(again, { action: "allow" });
    assert.equal(await harness.calls(), 1);
  } finally {
    await harness.dispose();
  }
});

test("activity for another conversation never earns this one a review", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-mine"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-someone-else", { toolName: "Write", readOnly: false });
    const verdict = await harness.coordinator.onReviewRequest(stop("session-mine"), newAbortSignal().signal);
    assert.deepEqual(verdict, { action: "allow" });
    assert.equal(await harness.calls(), 0);
  } finally {
    await harness.dispose();
  }
});

test("a turn with no qualifying activity and no change closes the window, so the next prompt starts its own", async () => {
  // U3: a non-qualifying turn settles through runReview rather than returning
  // before it. Nothing changed, so the run's no-change outcome completes the
  // exchange and retires the window instead of leaving it open. A read-only
  // call IS reported, because that is the turn the old gate short-circuited:
  // with nothing reported at all the old coordinator fell through to a run
  // anyway, and this test would prove nothing.
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-quiet-close", "the first request"), newAbortSignal().signal);
    assert.equal((await harness.records()).length, 1, "the armed window owns one baseline");

    harness.coordinator.noteToolActivity("session-quiet-close", { toolName: "Read", readOnly: true });
    const settled = await harness.coordinator.onReviewRequest(stop("session-quiet-close", "Nothing to do."), newAbortSignal().signal);
    assert.deepEqual(settled, { action: "allow" }, "a no-change turn is a quiet allow");
    assert.equal(await harness.calls(), 0, "nothing to review means no reviewer");
    assert.deepEqual(await harness.records(), [], "the closed window releases its baseline");

    // The next prompt arms a fresh window whose request is its own, rather than
    // piling into the closed one behind the first prompt's stale request.
    await harness.coordinator.onReviewRequest(ups("session-quiet-close", "the second request"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-quiet-close", { toolName: "Write", readOnly: false });
    const reviewed = await harness.coordinator.onReviewRequest(stop("session-quiet-close"), newAbortSignal().signal);
    assert.equal(reviewed.action, "block");
    const request = await readText(join(bundleDirOf(reviewed.reason!), "reviews", "0001", "request.md"));
    assert.match(request, /the second request/);
    assert.equal(request.includes("the first request"), false, "the fresh window carries only its own request");
  } finally {
    await harness.dispose();
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a workspace change with no qualifying call completes its exchange and keeps the window open", async () => {
  // U3: the changed-but-not-qualifying turn settles through runReview
  // (no_new_tool_activity), which COMPLETES the exchange it settled instead of
  // returning before the run and leaving it active, and keeps the window, its
  // baseline, and the unreviewed change available to a later qualifying turn.
  // Again the turn reports a read-only call, so it is one the old gate skipped
  // itself out of rather than one the old code reviewed anyway.
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-quiet-open", "the first request"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-quiet-open", { toolName: "Read", readOnly: true });
    const quiet = await harness.coordinator.onReviewRequest(stop("session-quiet-open"), newAbortSignal().signal);
    assert.deepEqual(quiet, { action: "allow" }, "the turn is quiet, with no notice of any kind");
    assert.equal(await harness.calls(), 0, "no qualifying call means no reviewer");
    assert.equal((await harness.records()).length, 1, "the window keeps its baseline");

    // A second prompt belongs to a NEW exchange only because that Stop
    // completed the exchange it settled. Had it left the exchange active, this
    // prompt would have joined it and the bundle would list exchange 1 alone.
    await harness.coordinator.onReviewRequest(ups("session-quiet-open", "the second request"), newAbortSignal().signal);
    harness.coordinator.noteToolActivity("session-quiet-open", { toolName: "Write", readOnly: false });
    const reviewed = await harness.coordinator.onReviewRequest(stop("session-quiet-open"), newAbortSignal().signal);
    assert.equal(reviewed.action, "block");
    assert.equal(await harness.calls(), 1);
    const manifest = JSON.parse(await readText(join(bundleDirOf(reviewed.reason!), "manifest.json"))) as { exchangeSequences?: number[] };
    assert.deepEqual(manifest.exchangeSequences, [1, 2],
      "the quiet turn closed exchange 1, so the review ran in exchange 2 of the same window");
  } finally {
    await harness.dispose();
  }
});

test("a workspace change with no reported tool activity at all never reaches a reviewer", async () => {
  // U21: before ANY activity was ever reported, a workspace change alone is not
  // reviewable work. The old gate let those turns through because it skipped
  // itself until the first call was reported.
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-never-reported"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    for (const attempt of [1, 2, 3]) {
      const verdict = await harness.coordinator.onReviewRequest(stop("session-never-reported"), newAbortSignal().signal);
      assert.deepEqual(verdict, { action: "allow" }, `turn ${attempt}: a workspace change alone is never a review`);
    }
    assert.equal(harness.coordinator.activityTracked, false, "nothing was ever reported");
    assert.equal(await harness.calls(), 0, "no reviewer ever ran");

    // The pending change is not lost: the first qualifying call earns its review.
    harness.coordinator.noteToolActivity("session-never-reported", { toolName: "Write", readOnly: false });
    assert.equal((await harness.coordinator.onReviewRequest(stop("session-never-reported"), newAbortSignal().signal)).action, "block");
    assert.equal(await harness.calls(), 1);
  } finally {
    await harness.dispose();
  }
});

test("a Stop deferred by running background work still records its final assistant message into the window", async () => {
  // #736 B3: the provider's final answer is recorded at the TOP of settlement,
  // exactly where Pi records it at agent_end, so a `Stop` that never reached a
  // reviewer because background work was still running still leaves its claim in
  // the window's evidence for the review a later turn earns.
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-summary-deferred"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-summary-deferred", { toolName: "Write", readOnly: false });

    harness.background = { state: "running", count: 2 };
    const deferred = await harness.coordinator.onReviewRequest(
      stop("session-summary-deferred", "DEFERRED TURN SUMMARY: rewrote upload() with a retry."),
      newAbortSignal().signal,
    );
    assert.equal(deferred.action, "allow");
    assert.match(deferred.userMessage ?? "", /deferred while 2 background task\(s\) remain active/);
    assert.equal(await harness.calls(), 0, "the deferral launches no reviewer");

    // The window survives the deferral and this later turn earns the review.
    harness.background = { state: "idle" };
    const reviewed = await harness.coordinator.onReviewRequest(
      stop("session-summary-deferred", "REVIEWED TURN SUMMARY: the retry is in place."),
      newAbortSignal().signal,
    );
    assert.equal(reviewed.action, "block");
    const evidence = await readText(join(bundleDirOf(reviewed.reason!), "current", "evidence.md"));
    assert.match(evidence, /DEFERRED TURN SUMMARY: rewrote upload\(\) with a retry\./,
      "the deferred turn's summary reached the reviewer's evidence");
    assert.match(evidence, /REVIEWED TURN SUMMARY: the retry is in place\./);
  } finally {
    await harness.dispose();
  }
});

test("a Stop that answers the no-reviewer notice still records its final assistant message into the window", async () => {
  // #736 B3: the same rule for the other early return: a qualifying `Stop` turned
  // away because no reviewer is available keeps its summary, and the window's
  // later review — once a reviewer resolves again — carries it.
  const harness = await createHarness();
  const agents = harness.config.externalAgents;
  try {
    harness.config = {
      ...harness.config,
      externalAgents: {},
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "gone" }] },
    };
    await harness.coordinator.onReviewRequest(ups("session-summary-no-reviewer"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-summary-no-reviewer", { toolName: "Write", readOnly: false });

    const blocked = await harness.coordinator.onReviewRequest(
      stop("session-summary-no-reviewer", "NO REVIEWER TURN SUMMARY: changed upload() and its caller."),
      newAbortSignal().signal,
    );
    assert.equal(blocked.action, "allow");
    assert.match(blocked.userMessage ?? "", /no configured reviewer is currently available/);
    assert.equal(await harness.calls(), 0, "the no-reviewer answer launches no reviewer");

    harness.config = {
      ...harness.config,
      externalAgents: agents,
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "fake" }] },
    };
    const reviewed = await harness.coordinator.onReviewRequest(
      stop("session-summary-no-reviewer", "REVIEWED TURN SUMMARY: the change stands."),
      newAbortSignal().signal,
    );
    assert.equal(reviewed.action, "block");
    const evidence = await readText(join(bundleDirOf(reviewed.reason!), "current", "evidence.md"));
    assert.match(evidence, /NO REVIEWER TURN SUMMARY: changed upload\(\) and its caller\./,
      "the no-reviewer turn's summary reached the reviewer's evidence");
  } finally {
    await harness.dispose();
  }
});

test("a non-qualifying turn shows neither the background deferral nor the no-reviewer notice", async () => {
  // K1: a turn that was never going to review cannot be deferred for background
  // work and cannot be told a reviewer is missing. Both conditions are set at
  // once so neither notice appears.
  const harness = await createHarness();
  try {
    harness.config = {
      ...harness.config,
      externalAgents: {},
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "gone" }] },
    };
    harness.background = { state: "running", count: 3 };
    await harness.coordinator.onReviewRequest(ups("session-quiet-notices"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    const verdict = await harness.coordinator.onReviewRequest(stop("session-quiet-notices"), newAbortSignal().signal);
    assert.deepEqual(verdict, { action: "allow" }, "neither notice is shown");
    assert.equal(await harness.calls(), 0);
    assert.ok((await harness.records()).length >= 1, "the window survives for a turn that does qualify");
  } finally {
    await harness.dispose();
  }
});

test("a new conversation id closes the previous window once and discloses it", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-old"), newAbortSignal().signal);
    assert.equal((await harness.records()).length, 1);

    const switched = await harness.coordinator.onReviewRequest(ups("session-new"), newAbortSignal().signal);
    assert.equal(switched.action, "allow");
    assert.match(switched.userMessage ?? "", /previous conversation's automatic review window closed without reviewing its latest changes/);
    await waitFor(async () => (await harness.records()).length === 1, 5_000);
    const kept = await harness.records();
    assert.ok(kept[0]!.includes("session-new"), "only the new conversation's record survives");

    // One-time: the disclosure is never repeated on the next request.
    const next = await harness.coordinator.onReviewRequest(stop("session-new"), newAbortSignal().signal);
    assert.equal(next.userMessage, undefined);
  } finally {
    await harness.dispose();
  }
});

test("a window never survives its conversation: an abandoned baseline is released", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-abandoned"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    const switched = await harness.coordinator.onReviewRequest(ups("session-next"), newAbortSignal().signal);
    assert.match(switched.userMessage ?? "", /previous conversation/);
    await waitFor(async () => {
      const records = await harness.records();
      return records.length === 1 && records[0]!.includes("session-next");
    }, 5_000);
    // Only the live conversation remains, and it is the one still unreviewed.
    assert.deepEqual(await harness.dispose(), { unreviewedConversations: 1 });
    assert.deepEqual(await harness.records(), []);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cancellation, serialization, disposal
// ---------------------------------------------------------------------------

test("aborting mid-review releases nothing the next turn needs and answers allow", async () => {
  const harness = await createHarness({ reviewerDelayMs: 400 });
  try {
    await harness.coordinator.onReviewRequest(ups("session-abort"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    // One qualifying call, reported before the first attempt and never again:
    // a cancelled review must not have spent it.
    harness.coordinator.noteToolActivity("session-abort", { toolName: "Write", readOnly: false });

    const first = newAbortSignal();
    const running = harness.coordinator.onReviewRequest(stop("session-abort"), first.signal);
    await waitFor(async () => (await harness.calls()) === 1);
    first.abort();
    const verdict = await running;
    assert.deepEqual(verdict, { action: "allow" }, "the relay is gone; nothing can be delivered");

    // The baseline survives, so the next Stop re-reviews the same change.
    assert.ok((await harness.records()).length >= 1);
    const second = await harness.coordinator.onReviewRequest(stop("session-abort"), newAbortSignal().signal);
    assert.equal(second.action, "block", "the abandoned review did not consume the window");
    assert.match(second.userMessage ?? "", /passed/);
  } finally {
    await harness.dispose();
  }
});

test("a UserPromptSubmit that arrives during an in-flight Stop is serialized", async () => {
  const harness = await createHarness({ reviewerDelayMs: 400 });
  try {
    await harness.coordinator.onReviewRequest(ups("session-race"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-race", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review

    const settling = harness.coordinator.onReviewRequest(stop("session-race"), newAbortSignal().signal);
    await waitFor(async () => (await harness.calls()) === 1);
    // Claude fires UserPromptSubmit at submit time while the Stop hook still
    // runs. It must not interleave with the window state the review owns.
    const queued = harness.coordinator.onReviewRequest(ups("session-race", "and keep the tests green"), newAbortSignal().signal);

    let settledFirst = false;
    void settling.then(() => {
      settledFirst = true;
    });
    const promptVerdict = await queued;
    assert.equal(settledFirst, true, "the queued prompt request waited for the in-flight review");
    assert.equal(promptVerdict.action, "allow");
    await settling;

    // Exactly one baseline was captured: the queued prompt joined the armed
    // exchange instead of racing a second capture into the same window.
    assert.equal((await harness.records()).length, 2, "the window baseline plus the reviewed after-baseline");
  } finally {
    await harness.dispose();
  }
});

test("dispose aborts an in-flight review and reports the conversations left unreviewed", async () => {
  const harness = await createHarness({ reviewerDelayMs: 500 });
  try {
    await harness.coordinator.onReviewRequest(ups("session-dispose-abort"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-dispose-abort", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
    const running = harness.coordinator.onReviewRequest(stop("session-dispose-abort"), newAbortSignal().signal);
    await waitFor(async () => (await harness.calls()) === 1);
    const disposed = await harness.dispose();
    assert.deepEqual(await running, { action: "allow" }, "an aborted review never answers a verdict");
    assert.deepEqual(disposed, { unreviewedConversations: 1 });
    await waitFor(async () => (await harness.records()).length === 0);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("dispose releases every owned record and bundle and counts open windows", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-open"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-open", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
    const verdict = await harness.coordinator.onReviewRequest(stop("session-open"), newAbortSignal().signal);
    const bundleDir = bundleDirOf(verdict.reason!);
    // The pass armed a response exchange, whose reviewed baseline is a second
    // owned record; both belong to this one open window.
    assert.equal((await harness.records()).length, 2);

    const disposed = await harness.dispose();
    assert.deepEqual(disposed, { unreviewedConversations: 1 }, "the window is still open with a baseline");
    assert.deepEqual(await harness.records(), [], "no owned record survives dispose");
    assert.equal(await exists(bundleDir), false, "no owned review bundle survives dispose");

    // Dispose is idempotent, and a later request is answered honestly.
    assert.deepEqual(await harness.dispose(), { unreviewedConversations: 0 });
    const after = await harness.coordinator.onReviewRequest(stop("session-open"), newAbortSignal().signal);
    assert.equal(after.action, "allow");
    assert.match(after.userMessage ?? "", /host session ended/);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("the host-session-ended notice is said once per coordinator", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-ended"), newAbortSignal().signal);
    assert.deepEqual(await harness.dispose(), { unreviewedConversations: 1 }, "the armed window is still open at dispose");
    const first = await harness.coordinator.onReviewRequest(stop("session-ended"), newAbortSignal().signal);
    assert.equal(first.action, "allow");
    assert.match(first.userMessage ?? "", /host session ended/, "the first request after dispose says why");
    const second = await harness.coordinator.onReviewRequest(ups("session-ended"), newAbortSignal().signal);
    assert.deepEqual(second, { action: "allow" }, "a later request after dispose is a quiet allow");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("an empty conversation reports nothing unreviewed", async () => {
  const harness = await createHarness();
  try {
    assert.deepEqual(await harness.dispose(), { unreviewedConversations: 0 });
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Never throws, always bounded
// ---------------------------------------------------------------------------

test("an unexpected internal failure becomes an allow with a notice, never a throw", async () => {
  const root = await makeRoot("boom");
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  await mkdir(workspace);
  await mkdir(agentDir);
  const coordinator = createNativeReviewCoordinator({
    backend: "claude",
    workspace,
    checkpointAgentDir: agentDir,
    readConfig: () => ({
      enabled: true,
      operatingMode: "orchestrate",
      modeCycleShortcut: "alt+m",
      reviewerTimeoutMs: 20_000,
      executorTimeoutMs: 60_000,
      maxCorrectionCycles: 3,
      implementationGuidanceAfterCorrectionAttempts: 1,
      maxPatchBytes: 200_000,
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
      retainBundles: "never",
      externalAgents: {},
      review: { primaryReviewers: [{ source: "external", id: "fake" }], primaryClaudeCodeEnabled: true, primaryCodexEnabled: true },
    }),
    backgroundState: async () => {
      throw new Error("the row's task list exploded");
    },
    now: () => {
      throw new Error("the host clock exploded");
    },
  });
  const verdict = await coordinator.onReviewRequest(ups("session-boom"), newAbortSignal().signal);
  assert.equal(verdict.action, "allow");
  assert.match(verdict.userMessage ?? "", /automatic review failed \(the host clock exploded\)/);
  assert.deepEqual(await coordinator.dispose(), { unreviewedConversations: 0 });
});

test("a background failure is reported honestly and stays inside the notice bound", async () => {
  const harness = await createHarness();
  const agents = harness.config.externalAgents;
  try {
    // #736 U8: armed while the configured reviewer cannot resolve, with the
    // settings fixed before this Stop. The reconciliation notice has to fit
    // ALONGSIDE a message that already fills the transport's whole byte bound.
    harness.config = {
      ...harness.config,
      externalAgents: {},
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "gone" }] },
    };
    await harness.coordinator.onReviewRequest(ups("session-huge-unknown"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-huge-unknown", { toolName: "Write", readOnly: false }); // U21: the census is only consulted for a qualifying turn
    harness.background = { state: "unknown", detail: "x".repeat(100_000) };
    harness.config = {
      ...harness.config,
      externalAgents: agents,
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "fake" }] },
    };
    const verdict = await harness.coordinator.onReviewRequest(stop("session-huge-unknown"), newAbortSignal().signal);
    assert.equal(verdict.action, "allow");
    assert.ok(Buffer.byteLength(verdict.userMessage ?? "", "utf8") <= MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES,
      "an over-bound notice would be refused by the transport and unreview a reviewed turn");
    assert.match(verdict.userMessage ?? "", /background state could not be verified/);
    assert.match(
      verdict.userMessage ?? "",
      /review gate: 1 review window\(s\) reconciled to the updated reviewer settings \(1 configured reviewer\(s\)\); preserved evidence and history are unchanged/,
      "the reconciliation survives an existing message that fills the bound",
    );
    // Both notices really are inside the ONE bounded line: the substantive
    // headline first (shortened as needed), the fixed reconcile notice last.
    const lines = (verdict.userMessage ?? "").split("\n");
    assert.match(lines[0] ?? "", /background state could not be verified/);
    assert.match(lines.at(-1) ?? "", /preserved evidence and history are unchanged/);
  } finally {
    await harness.dispose();
  }
});

test("an already-aborted request never captures and never reviews", async () => {
  const harness = await createHarness();
  try {
    const aborted = newAbortSignal();
    aborted.abort();
    const armed = await harness.coordinator.onReviewRequest(ups("session-preflight"), aborted.signal);
    assert.deepEqual(armed, { action: "allow" });
    assert.deepEqual(await harness.records(), []);
    const settled = await harness.coordinator.onReviewRequest(stop("session-preflight"), aborted.signal);
    assert.deepEqual(settled, { action: "allow" });
    assert.equal(await harness.calls(), 0);
  } finally {
    await harness.dispose();
  }
});

test("the submitted prompt and the final answer reach the reviewer through state", async () => {
  // The reason the request lane carries a prompt at all: on UserPromptSubmit
  // the assistant answer does not exist yet, so the reviewer would otherwise
  // be judging a turn it cannot see. Both texts reach the reviewer through the
  // window's own request history and final-summary evidence, exactly as in Pi.
  const root = await makeRoot("prompt-body");
  const workspace = join(root, "workspace");
  const agentDir = join(root, "agent");
  const bodyFile = join(root, "prompt-body");
  await mkdir(workspace);
  await mkdir(agentDir);
  await writeFile(join(workspace, "index.ts"), "before\n", "utf8");
  const script = [
    "const fs = require('fs');",
    `const bodyFile = ${JSON.stringify(bodyFile)};`,
    "let body = '';",
    "process.stdin.on('data', (chunk) => { body += chunk; });",
    "process.stdin.on('end', () => {",
    "  fs.writeFileSync(bodyFile, body);",
    "  process.stdout.write(JSON.stringify({ verdict: 'pass', summary: 'ok', findings: [] }));",
    "});",
  ].join("");
  const coordinator = createNativeReviewCoordinator({
    backend: "claude",
    workspace,
    checkpointAgentDir: agentDir,
    readConfig: () => ({
      enabled: true,
      operatingMode: "orchestrate",
      modeCycleShortcut: "alt+m",
      reviewerTimeoutMs: 20_000,
      executorTimeoutMs: 60_000,
      maxCorrectionCycles: 3,
      implementationGuidanceAfterCorrectionAttempts: 1,
      maxPatchBytes: 200_000,
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
      retainBundles: "never",
      externalAgents: { fake: { id: "fake", adapter: "generic-cli", command: process.execPath, args: [], review: { args: ["-e", script], timeoutMs: 20_000 } } },
      review: { primaryReviewers: [{ source: "external", id: "fake" }], primaryClaudeCodeEnabled: true, primaryCodexEnabled: true },
    }),
    backgroundState: async () => ({ state: "idle" }),
  });
  try {
    await coordinator.onReviewRequest(ups("session-body", "add exponential backoff to upload()"), newAbortSignal().signal);
    await writeFile(join(workspace, "index.ts"), "after\n", "utf8");
    coordinator.noteToolActivity("session-body", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
    const verdict = await coordinator.onReviewRequest(stop("session-body", "Added backoff with a jitter test."), newAbortSignal().signal);
    assert.equal(verdict.action, "block");
    const promptBody = await readText(bodyFile);
    assert.match(promptBody, /add exponential backoff to upload\(\)/, "the submitted prompt is what the reviewer judges against");
    assert.match(promptBody, /Added backoff with a jitter test\./, "the provider's final answer is included as the assistant summary");
  } finally {
    await coordinator.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * #736 R-fix: Pi records the request at the prompt event whatever arming does, so
 * a prompt whose own hook hit its deadline is still in the context the next Stop
 * reviews. This lane skipped the record for a cancelled prompt even when the
 * window it landed in already owned a baseline and was still going to be reviewed.
 */
test("a cancelled prompt into an armed window still reaches the next review as mid-run guidance", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-cancelled-prompt", "add a retry to upload()"), newAbortSignal().signal);
    // The user's second prompt: its hook is cancelled before its slot runs — the
    // provider already moved on — while the window keeps its baseline.
    const hungUp = newAbortSignal();
    hungUp.abort(new Error("the row hung up"));
    const abandoned = await harness.coordinator.onReviewRequest(
      ups("session-cancelled-prompt", "also cap the retry at three attempts"),
      hungUp.signal,
    );
    assert.deepEqual(abandoned, { action: "allow" }, "a cancelled prompt answers allow, as it always did");

    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-cancelled-prompt", { toolName: "Write", readOnly: false });
    const reviewed = await harness.coordinator.onReviewRequest(
      stop("session-cancelled-prompt", "Added the retry, capped at three."),
      newAbortSignal().signal,
    );
    assert.equal(reviewed.action, "block");
    const request = await readText(join(bundleDirOf(reviewed.reason!), "reviews", "0001", "request.md"));
    assert.match(request, /add a retry to upload\(\)/, "the prompt that armed the window");
    assert.match(
      request,
      /also cap the retry at three attempts/,
      "the prompt whose own hook was cancelled is mid-run guidance for this review",
    );
  } finally {
    await harness.dispose();
  }
});

/**
 * #736 R-fix (review pass 1): the recording must not wait on the settings read.
 * A cancelled prompt that landed in an armed window while the settings document
 * was unreadable returned before it was recorded, and once settings recovered the
 * next qualifying `Stop` reviewed that same window without that guidance.
 */
test("a cancelled prompt during an unreadable settings stretch still reaches the next review", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-outage-prompt", "add a retry to upload()"), newAbortSignal().signal);
    // The settings document breaks, and the next prompt's hook is cancelled inside
    // that stretch: its slot can arm nothing, but the window it landed in already
    // owns a baseline and is still going to be reviewed.
    harness.settingsUnreadable = true;
    const hungUp = newAbortSignal();
    hungUp.abort(new Error("the row hung up"));
    const abandoned = await harness.coordinator.onReviewRequest(
      ups("session-outage-prompt", "also cap the retry at three attempts"),
      hungUp.signal,
    );
    assert.deepEqual(abandoned, { action: "allow" }, "a cancelled prompt answers allow, as it always did");
    harness.settingsUnreadable = false;

    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-outage-prompt", { toolName: "Write", readOnly: false });
    const reviewed = await harness.coordinator.onReviewRequest(
      stop("session-outage-prompt", "Added the retry, capped at three."),
      newAbortSignal().signal,
    );
    assert.equal(reviewed.action, "block", "the armed window survived the outage and still reviewed the change");
    const request = await readText(join(bundleDirOf(reviewed.reason!), "reviews", "0001", "request.md"));
    assert.match(request, /add a retry to upload\(\)/, "the prompt that armed the window");
    assert.match(
      request,
      /also cap the retry at three attempts/,
      "and the prompt whose hook was cancelled while the settings could not be read",
    );
  } finally {
    await harness.dispose();
  }
});

test("a Stop never reaches a reviewer when the frozen window has no resolvable reviewer", async () => {
  const harness = await createHarness();
  try {
    // The window freezes its reviewer selection when it is armed, so this is
    // the shape that matters: a configuration whose reviewer cannot resolve.
    harness.config = {
      ...harness.config,
      externalAgents: {},
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "gone" }] },
    };
    await harness.coordinator.onReviewRequest(ups("session-no-reviewer"), newAbortSignal().signal);
    assert.ok((await harness.records()).length >= 1, "arming still captures a baseline");
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-no-reviewer", { toolName: "Write", readOnly: false });
    const verdict = await harness.coordinator.onReviewRequest(stop("session-no-reviewer"), newAbortSignal().signal);
    assert.equal(verdict.action, "allow");
    assert.match(verdict.userMessage ?? "", /no configured reviewer is currently available/);
    assert.equal(await harness.calls(), 0);
    // The window stays open with its baseline so a later turn can still review.
    assert.ok((await harness.records()).length >= 1);
  } finally {
    await harness.dispose();
  }
});

/**
 * #736 U8: native has no settings-save event, so a window picks up a
 * Review-settings reviewer change at its next `Stop` through the same
 * `reconcileWindowReviewerSelection` Pi calls when settings are saved.
 */
test("a reviewer change in Review settings reconciles the open window at its next reviewed Stop", async () => {
  const harness = await createHarness();
  const agents = harness.config.externalAgents;
  try {
    // Armed while the configured reviewer cannot resolve — the shape of a user
    // who has not finished configuring Review settings.
    harness.config = {
      ...harness.config,
      externalAgents: {},
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "gone" }] },
    };
    await harness.coordinator.onReviewRequest(ups("session-reconcile"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-reconcile", { toolName: "Write", readOnly: false });

    // The user fixes the reviewer mid-window. Native reads fresh settings on
    // every request, so this Stop reconciles the window instead of reporting the
    // stale frozen selection forever.
    harness.config = {
      ...harness.config,
      externalAgents: agents,
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "fake" }] },
    };
    const verdict = await harness.coordinator.onReviewRequest(stop("session-reconcile"), newAbortSignal().signal);
    assert.equal(verdict.action, "block", "the reconciled selection ran the review");
    assert.doesNotMatch(verdict.userMessage ?? "", /no configured reviewer/, "the stale frozen selection is not reported");
    assert.match(
      verdict.userMessage ?? "",
      /review gate: 1 review window\(s\) reconciled to the updated reviewer settings \(1 configured reviewer\(s\)\); preserved evidence and history are unchanged/,
    );
    assert.match(verdict.userMessage ?? "", /passed/, "and the Stop reviewed the change");
    assert.equal(await harness.calls(), 1, "the reconciled reviewer actually ran");
  } finally {
    await harness.dispose();
  }
});

test("a Stop whose reviewer settings are unchanged carries no reconcile notice", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-no-change"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-no-change", { toolName: "Write", readOnly: false });
    const verdict = await harness.coordinator.onReviewRequest(stop("session-no-change"), newAbortSignal().signal);
    assert.equal(verdict.action, "block");
    assert.match(verdict.userMessage ?? "", /passed/);
    assert.doesNotMatch(verdict.userMessage ?? "", /reconciled to the updated reviewer settings/);
  } finally {
    await harness.dispose();
  }
});

test("a non-qualifying Stop after a reviewer change stays completely quiet", async () => {
  const harness = await createHarness();
  const agents = harness.config.externalAgents;
  try {
    harness.config = {
      ...harness.config,
      externalAgents: {},
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "gone" }] },
    };
    await harness.coordinator.onReviewRequest(ups("session-quiet-reconcile"), newAbortSignal().signal);
    // A workspace change with no reported qualifying call: K1 keeps this turn
    // quiet whatever the reviewer settings say, so the reconcile never becomes a
    // notice of its own.
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.config = {
      ...harness.config,
      externalAgents: agents,
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "fake" }] },
    };
    const verdict = await harness.coordinator.onReviewRequest(stop("session-quiet-reconcile"), newAbortSignal().signal);
    assert.deepEqual(verdict, { action: "allow" }, "no notice at all, reconcile included");
    assert.equal(await harness.calls(), 0);
  } finally {
    await harness.dispose();
  }
});

/**
 * #736 R-fix: the reconcile notice is composed at the one delivery point, so a
 * `Stop` that reconciled its window and then answered a quiet allow could not
 * carry it — and it never gets a second chance, because that `Stop` already
 * swapped the window's frozen selection. The notice stays pending on the window,
 * and the next `Stop` that notifies or reviews says it once.
 */
test("a reconcile notice a quiet Stop could not carry is said once by the next reviewed Stop", async () => {
  const harness = await createHarness();
  const agents = harness.config.externalAgents;
  try {
    // Armed while the configured reviewer cannot resolve, so the window's frozen
    // selection really does change when the user fixes it mid-window.
    harness.config = {
      ...harness.config,
      externalAgents: {},
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "gone" }] },
    };
    await harness.coordinator.onReviewRequest(ups("session-pending-reconcile"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.config = {
      ...harness.config,
      externalAgents: agents,
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "fake" }] },
    };
    // A workspace change with no reported qualifying call: this `Stop` reconciles
    // the window and then settles quiet, and it stays quiet — the notice is what
    // a turn that can be told receives, never a notice of its own.
    const quiet = await harness.coordinator.onReviewRequest(stop("session-pending-reconcile"), newAbortSignal().signal);
    assert.deepEqual(quiet, { action: "allow" }, "the quiet allow still shows nothing");
    assert.equal(await harness.calls(), 0);

    // The next qualifying `Stop` of the SAME window runs the review the reconciled
    // selection makes possible, and carries the notice this window still owed.
    harness.coordinator.noteToolActivity("session-pending-reconcile", { toolName: "Write", readOnly: false });
    const reviewed = await harness.coordinator.onReviewRequest(stop("session-pending-reconcile"), newAbortSignal().signal);
    assert.equal(reviewed.action, "block");
    assert.match(reviewed.userMessage ?? "", /passed/);
    assert.match(
      reviewed.userMessage ?? "",
      /review gate: 1 review window\(s\) reconciled to the updated reviewer settings \(1 configured reviewer\(s\)\); preserved evidence and history are unchanged/,
      "the notice the quiet Stop could not carry travels with the first verdict that can carry one",
    );

    // A following reviewed Stop of the same window never repeats it.
    await writeFile(join(harness.workspace, "index.ts"), "after again\n", "utf8");
    harness.coordinator.noteToolActivity("session-pending-reconcile", { toolName: "Write", readOnly: false });
    const following = await harness.coordinator.onReviewRequest(stop("session-pending-reconcile"), newAbortSignal().signal);
    assert.equal(following.action, "block");
    assert.match(following.userMessage ?? "", /passed/);
    assert.doesNotMatch(following.userMessage ?? "", /reconciled to the updated reviewer settings/, "said once, never again");
  } finally {
    await harness.dispose();
  }
});

test("a Stop that reconciled the window and then hit its deadline still reports the reconciliation", async () => {
  // The reconcile runs before the reviewer does, so a settlement this host's own
  // deadline cancelled has already swapped the window's selection. The timeout
  // reply is the only notice the user will ever get for that change, and the next
  // Stop — under unchanged settings — has nothing left to announce.
  const harness = await createHarness({ liveReviewerDelay: true, reviewerDelayMs: 6_000, deadlineMs: 1_500 });
  const agents = harness.config.externalAgents;
  try {
    harness.config = {
      ...harness.config,
      externalAgents: {},
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "gone" }] },
    };
    await harness.coordinator.onReviewRequest(ups("session-deadline-reconcile"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-deadline-reconcile", { toolName: "Write", readOnly: false });
    harness.config = {
      ...harness.config,
      externalAgents: agents,
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "fake" }] },
    };
    const timedOut = await harness.coordinator.onReviewRequest(stop("session-deadline-reconcile"), newAbortSignal().signal);
    assert.equal(timedOut.action, "allow");
    assert.match(timedOut.userMessage ?? "", /time limit/);
    assert.match(
      timedOut.userMessage ?? "",
      /review gate: 1 review window\(s\) reconciled to the updated reviewer settings \(1 configured reviewer\(s\)\); preserved evidence and history are unchanged/,
      "the timed-out Stop still reports the selection it swapped in",
    );

    // The same window, no new qualifying call, and a fast reviewer from here on.
    assert.ok(harness.setDelay, "the harness exposes a live reviewer delay");
    await harness.setDelay(0);
    const retry = await harness.coordinator.onReviewRequest(stop("session-deadline-reconcile"), newAbortSignal().signal);
    assert.equal(retry.action, "block", "the reconciled selection reviewed the pending change");
    assert.match(retry.userMessage ?? "", /passed/);
    assert.doesNotMatch(retry.userMessage ?? "", /reconciled to the updated reviewer settings/, "the notice is not repeated");
  } finally {
    await harness.dispose();
  }
});

test("a transmission that could not be created still reports the reconciliation with the failure", async () => {
  // The reconcile happens before the reviewer runs, so a review that failed only
  // when its transmission was created — the bundle directory cannot be made
  // beneath a regular file — already swapped the window's selection. That failure
  // is answered outside the settlement, so composing the notice at delivery is
  // what keeps the change from going unreported.
  let workspace = "";
  const harness = await createHarness({
    reviewOutputForTests: (output) => ({
      ...output,
      invocationDir: join(workspace, "index.ts", "reviews", "1"),
    }),
  });
  workspace = harness.workspace;
  const agents = harness.config.externalAgents;
  try {
    harness.config = {
      ...harness.config,
      externalAgents: {},
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "gone" }] },
    };
    await harness.coordinator.onReviewRequest(ups("session-transmission-fail"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-transmission-fail", { toolName: "Write", readOnly: false });
    harness.config = {
      ...harness.config,
      externalAgents: agents,
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "fake" }] },
    };
    const verdict = await harness.coordinator.onReviewRequest(stop("session-transmission-fail"), newAbortSignal().signal);
    assert.equal(verdict.action, "allow");
    assert.match(verdict.userMessage ?? "", /automatic review failed/, "the transmission failure is still reported");
    assert.match(
      verdict.userMessage ?? "",
      /review gate: 1 review window\(s\) reconciled to the updated reviewer settings \(1 configured reviewer\(s\)\); preserved evidence and history are unchanged/,
      "and it reports the selection this Stop already swapped in",
    );
    assert.ok(Buffer.byteLength(verdict.userMessage ?? "", "utf8") <= MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES);
    assert.equal(await harness.calls(), 1, "the reconciled reviewer did run");
  } finally {
    await harness.dispose();
  }
});

// ---------------------------------------------------------------------------
// Settlement ownership, cancellation, and the transport's inline limits
// ---------------------------------------------------------------------------

test("a pass's reviewed after-checkpoint is retired by the response turn, not left for teardown", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-after"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-after", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
    const passed = await harness.coordinator.onReviewRequest(stop("session-after"), newAbortSignal().signal);
    assert.equal(passed.action, "block");
    // The open window owns its baseline AND the reviewed after-checkpoint the
    // pass handed to the response exchange.
    assert.equal((await harness.records()).length, 2);

    // The confirmation reports no qualifying call, so it settles as a pass that
    // produced nothing new and closes the window, releasing both checkpoints.
    harness.coordinator.noteToolActivity("session-after", { toolName: "Read", readOnly: true });
    const response = await harness.coordinator.onReviewRequest(stop("session-after", "Confirmed, nothing else."), newAbortSignal().signal);
    assert.equal(response.action, "allow");
    // Asserted BEFORE teardown: a reviewed-after record that only disappears
    // when the fixture deletes the whole tree is a leak, not cleanup. Nothing
    // in this conversation can reference it once the turn settled.
    await waitFor(async () => (await harness.records()).length === 0, 5_000);
    assert.deepEqual(await harness.records(), [], "the settled after-checkpoint is released while the conversation is still live");
    assert.deepEqual(await harness.dispose(), { unreviewedConversations: 0 });
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a second review in one window retires the checkpoint the first one reviewed", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-chain"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "one.ts"), "one\n", "utf8");
    harness.coordinator.noteToolActivity("session-chain", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
    assert.equal((await harness.coordinator.onReviewRequest(stop("session-chain"), newAbortSignal().signal)).action, "block");
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "two.ts"), "two\n", "utf8");
    harness.coordinator.noteToolActivity("session-chain", { toolName: "Write", readOnly: false });
    assert.equal((await harness.coordinator.onReviewRequest(stop("session-chain"), newAbortSignal().signal)).action, "block");
    // Two settlements, one live chain of descriptors — never a pile of every
    // baseline this window ever passed.
    const records = await harness.records();
    assert.ok(records.length <= 2, `only reachable descriptors survive, saw ${records.length}`);
    assert.deepEqual(await harness.dispose(), { unreviewedConversations: 1 });
    assert.deepEqual(await harness.records(), [], "dispose still owns everything");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a cancelled review keeps its qualifying activity so the next Stop retries the same change", async () => {
  const harness = await createHarness({ reviewerDelayMs: 500 });
  try {
    await harness.coordinator.onReviewRequest(ups("session-retry"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    // One qualifying call, reported BEFORE the first attempt, and never again.
    harness.coordinator.noteToolActivity("session-retry", { toolName: "Write", readOnly: false });

    const first = newAbortSignal();
    const running = harness.coordinator.onReviewRequest(stop("session-retry"), first.signal);
    // Cancel once the reviewer is provably running. A fixed delay only assumes
    // the child had started, which a slower process start can break; the call
    // record is written after the reviewer's stdin closes, so seeing it is the
    // proof that this Stop really reached the reviewer.
    await waitFor(async () => (await harness.calls()) === 1, 20_000);
    first.abort(new Error("the row hung up"));
    assert.deepEqual(await running, { action: "allow" }, "a cancellation never blocks a turn the provider stopped waiting for");

    // No new tool event: the unreviewed change is still pending, so the retry
    // must run the reviewer again rather than treating the turn as reviewed.
    const retry = await harness.coordinator.onReviewRequest(stop("session-retry"), newAbortSignal().signal);
    assert.equal(retry.action, "block", "cancelling must not consume the only qualifying activity");
    assert.match(retry.reason ?? "", /Complete immutable pass evidence/);
    assert.equal(await harness.calls(), 2, "the aborted attempt and the retry each reached the reviewer");
  } finally {
    await harness.dispose();
  }
});

// ---------------------------------------------------------------------------
// The activity watermark tracks the LAST RECORDED review (#736 U6)
//
// `qualifyingToolActivity` is this lane's stand-in for Pi's
// `hasNewQualifyingToolCall`, which measures from `window.reviewHistory.at(-1)`.
// So the watermark is set once, when a window first gets its baseline, and moves
// only when a verdict is recorded. Everything that records no verdict — a
// cancellation, the overall deadline, a run with no result, a transmission that
// could not be rendered — leaves it where it was, and the next `Stop` of the same
// window re-reviews with no new tool call.
// ---------------------------------------------------------------------------

test("a review the overall deadline cancelled is retried by the next Stop of the same window with no new tool call", async () => {
  // The deadline notice promises the change "stays pending for a later turn".
  // That is only true while the timed-out turn spent nothing: the very next Stop
  // — with no new qualifying call — has to reach the reviewer again.
  const harness = await createHarness({ liveReviewerDelay: true, reviewerDelayMs: 6_000, deadlineMs: 1_500 });
  try {
    await harness.coordinator.onReviewRequest(ups("session-u6-deadline"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-u6-deadline", { toolName: "Write", readOnly: false });

    const timedOut = await harness.coordinator.onReviewRequest(stop("session-u6-deadline"), newAbortSignal().signal);
    assert.equal(timedOut.action, "allow");
    assert.match(timedOut.userMessage ?? "", /time limit/);
    assert.equal(await harness.calls(), 1, "the timed-out attempt reached the reviewer");

    // The SAME window, no new tool call anywhere, and a fast reviewer from here
    // on: the unreviewed change is still pending, so it is still reviewed.
    assert.ok(harness.setDelay, "the harness exposes a live reviewer delay");
    await harness.setDelay(0);
    const retry = await harness.coordinator.onReviewRequest(stop("session-u6-deadline"), newAbortSignal().signal);
    assert.equal(retry.action, "block", "a review that recorded no verdict spent no activity");
    assert.match(retry.userMessage ?? "", /passed/);
    assert.equal(await harness.calls(), 2, "the timed-out attempt and the retry each reached the reviewer");
  } finally {
    await harness.dispose();
  }
});

test("a reviewer failure that recorded no verdict is retried by the next Stop with no new tool call", async () => {
  // The run output that carries no `result` at all is the closed
  // `No reviewers configured.` shape: nothing was transmitted, so nothing was
  // recorded, so the turn's qualifying call is still unspent. A native settlement
  // with a resolvable reviewer can never produce that output by itself, so the
  // harness maps the real run's output onto it once (see `reviewOutputForTests`).
  // A real result-less run never reached a reviewer, so it never handed off an
  // after-checkpoint either. This one did, so the fixture releases that
  // descriptor the way the settlement would have, and the assertion below proves
  // it is really gone rather than disappearing with the temporary root.
  let stripResult = true;
  let discardedRelease: (() => Promise<void>) | undefined;
  const harness = await createHarness({
    reviewOutputForTests: (output) => {
      if (!stripResult) return output;
      stripResult = false;
      discardedRelease = output.releaseReviewedBaseline;
      return { ...output, result: undefined };
    },
  });
  try {
    await harness.coordinator.onReviewRequest(ups("session-u6-noresult"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-u6-noresult", { toolName: "Write", readOnly: false });

    const failed = await harness.coordinator.onReviewRequest(stop("session-u6-noresult"), newAbortSignal().signal);
    assert.deepEqual(
      { action: failed.action, notice: /reviewer failed/.test(failed.userMessage ?? "") },
      { action: "allow", notice: true },
      "a run with no verdict delivers nothing and records nothing",
    );
    assert.equal(await harness.calls(), 1);

    await discardedRelease?.();
    await waitFor(async () => (await harness.records()).length === 1, 5_000);
    assert.equal((await harness.records()).length, 1, "only the window's own baseline survives the discarded run");

    const retry = await harness.coordinator.onReviewRequest(stop("session-u6-noresult"), newAbortSignal().signal);
    assert.equal(retry.action, "block", "the unrecorded failure is retried with no new tool call");
    assert.match(retry.userMessage ?? "", /passed/);
    assert.equal(await harness.calls(), 2, "the failed attempt and the retry each reached the reviewer");
  } finally {
    await harness.dispose();
  }
});

test("a transmitted verdict advances the watermark, so a following turn with no qualifying call runs no reviewer", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-u6-recorded"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-u6-recorded", { toolName: "Write", readOnly: false });
    const corrected = await harness.coordinator.onReviewRequest(stop("session-u6-recorded"), newAbortSignal().signal);
    assert.equal(corrected.action, "block", "the correction was transmitted and recorded");
    assert.equal(await harness.calls(), 1);

    // The verdict is in the window's review history now, so this turn's activity
    // is spent: the next Stop is a quiet no-review turn, not a second review of
    // the same feedback.
    const quiet = await harness.coordinator.onReviewRequest(stop("session-u6-recorded", "Working on it."), newAbortSignal().signal);
    assert.equal(quiet.action, "allow");
    assert.match(quiet.userMessage ?? "", /earlier requested changes remain unresolved/);
    assert.equal(await harness.calls(), 1, "a recorded verdict is never reviewed twice");
  } finally {
    await harness.dispose();
  }
});

test("a second prompt of an armed window never spends activity reported since the last recorded review", async () => {
  // The watermark belongs to the window's last RECORDED review, so a new
  // exchange of an already-armed window must never resample it. Before U6 every
  // prompt did, which spent the pending call on the prompt itself and left the
  // change it made unreviewed until some later qualifying call.
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-u6-prompt", "the first request"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-u6-prompt", { toolName: "Write", readOnly: false });
    const corrected = await harness.coordinator.onReviewRequest(stop("session-u6-prompt"), newAbortSignal().signal);
    assert.equal(corrected.action, "block", "a recorded verdict advances the watermark to here");
    assert.equal(await harness.calls(), 1);

    // A quiet response turn: no qualifying call, so it records nothing, but it
    // completes the exchange and leaves the unresolved window on its baseline —
    // the state a later prompt must not resample the watermark over.
    const quiet = await harness.coordinator.onReviewRequest(stop("session-u6-prompt", "Working on it."), newAbortSignal().signal);
    assert.equal(quiet.action, "allow");
    assert.equal(await harness.calls(), 1, "the quiet response turn ran no reviewer");
    assert.ok((await harness.records()).length >= 1, "the unresolved window survives with its baseline");

    // The qualifying call is reported BEFORE the next prompt, so it is activity
    // since the recorded verdict, and the prompt itself may not spend it.
    await writeFile(join(harness.workspace, "index.ts"), "the correction\n", "utf8");
    harness.coordinator.noteToolActivity("session-u6-prompt", { toolName: "Write", readOnly: false });
    await harness.coordinator.onReviewRequest(ups("session-u6-prompt", "the second request"), newAbortSignal().signal);

    const reviewed = await harness.coordinator.onReviewRequest(stop("session-u6-prompt"), newAbortSignal().signal);
    assert.equal(reviewed.action, "block", "the second prompt did not consume the pending qualifying call");
    assert.equal(await harness.calls(), 2);
  } finally {
    await harness.dispose();
  }
});

// ---------------------------------------------------------------------------
// The overall review deadline
// ---------------------------------------------------------------------------

test("the coordinator's overall review deadline sits inside the provider's own hook timeout", () => {
  assert.equal(NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS, 3600);
  assert.equal(NATIVE_REVIEW_DEADLINE_MS, NATIVE_REVIEW_HOOK_TIMEOUT_SECONDS * 1000 - 300_000);
  assert.ok(NATIVE_REVIEW_DEADLINE_MS < NATIVE_REVIEW_HOOK_RELAY_DEADLINE_MS,
    "the host's review deadline is the first one to fire, never the relay's backstop");
});

test("a review that outlives its overall deadline is cancelled like a hang-up and the conversation proceeds", async () => {
  const harness = await createHarness({ liveReviewerDelay: true, reviewerDelayMs: 6_000, deadlineMs: 2_000 });
  try {
    await harness.coordinator.onReviewRequest(ups("session-deadline"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-deadline", { toolName: "Write", readOnly: false });

    const started = Date.now();
    const timedOut = await harness.coordinator.onReviewRequest(stop("session-deadline"), newAbortSignal().signal);
    const waited = Date.now() - started;
    assert.equal(timedOut.action, "allow", "a timed-out review never blocks the turn it could not finish");
    assert.ok(waited >= 1_800, `the deadline ended the wait, not the reviewer (${waited}ms)`);
    assert.ok(waited < 5_000, `the deadline fired long before the slow reviewer finished (${waited}ms)`);
    assert.match(timedOut.userMessage ?? "", /time limit/);
    assert.match(timedOut.userMessage ?? "", /not reviewed/);
    assert.ok(Buffer.byteLength(timedOut.userMessage ?? "", "utf8") <= MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES,
      "the timeout notice is a deliverable bounded notice");

    // Exactly the cancellation contract: the window keeps its baseline, so the
    // unreviewed change is still owned and still pending.
    assert.ok((await harness.records()).length >= 1, "the deadline keeps the unreviewed baseline");

    // A later request for the SAME conversation proceeds: with a fast reviewer,
    // the next Stop reviews the very same change to a pass, which also proves the
    // timed-out turn spent neither the window nor the turn's qualifying activity.
    assert.ok(harness.setDelay, "the harness exposes a live reviewer delay");
    await harness.setDelay(0);
    const next = await harness.coordinator.onReviewRequest(stop("session-deadline"), newAbortSignal().signal);
    assert.equal(next.action, "block", "the timed-out turn did not consume the pending change");
    assert.match(next.userMessage ?? "", /passed/);
    assert.equal(await harness.calls(), 2, "the timed-out attempt and the later review each reached the reviewer");

    // The pass armed its response turn; the unchanged turn after it closes the
    // completed window exactly as it would have with no deadline in the story.
    const closed = await harness.coordinator.onReviewRequest(stop("session-deadline", ""), newAbortSignal().signal);
    assert.equal(closed.action, "allow");

    const { unreviewedConversations } = await harness.coordinator.dispose();
    assert.equal(unreviewedConversations, 0, "the completed review closed its window");
    assert.deepEqual(await harness.records(), [], "the deadline leaked no checkpoint record behind");
  } finally {
    await harness.dispose();
  }
});

test("a request that is still queued when its deadline fires answers allow with its notice", async () => {
  const harness = await createHarness({ deadlineMs: 300 });
  // The only handles this fixture leaves outstanding are the coordinator's own
  // unref'd deadline timers, so a referenced guard is what turns a watchdog that
  // never fires into a failure rather than a drained event loop.
  const guard = hangGuard("queued review deadline");
  try {
    // A census that never answers holds the first request in flight, so the
    // second one really is queued behind it rather than racing it.
    harness.background = () => new Promise<NativeReviewBackgroundState>(() => undefined);
    await harness.coordinator.onReviewRequest(ups("session-queued"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-queued", { toolName: "Write", readOnly: false });

    const running = harness.coordinator.onReviewRequest(stop("session-queued"), newAbortSignal().signal);
    const queued = await guard.watch(harness.coordinator.onReviewRequest(stop("session-queued"), newAbortSignal().signal));
    assert.equal(queued.action, "allow", "a queued request whose deadline passed still answers, and never blocks");
    assert.match(queued.userMessage ?? "", /time limit/);
    const first = await guard.watch(running);
    assert.equal(first.action, "allow");
    assert.match(first.userMessage ?? "", /time limit/);
    assert.equal(await harness.calls(), 0, "neither timed-out request launched a reviewer");
  } finally {
    guard.done();
    await harness.dispose();
  }
});

// POSIX-only by construction: this fixture stalls a settlement by having the
// fake reviewer ignore SIGTERM, and Windows teardown terminates the whole tree
// with `taskkill /T /F`, which no in-process handler can survive. The portable
// held-verification test above is what proves queue progress on every platform.
test("a cancelled baseline verification releases the queue, so a later Stop reviews the same change", async () => {
  // Verifying a baseline is the one settlement await an abort cannot interrupt:
  // a raw checkpoint `open`/read has no process to signal. Held unresolved, it is
  // exactly what used to park every later turn of this conversation behind a
  // request nobody is waiting for any more.
  let holdNext = false;
  let held = 0;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const harness = await createHarness({
    deadlineMs: 1_500,
    observeBaselineVerification: async () => {
      if (!holdNext) return;
      holdNext = false;
      held += 1;
      await firstHeld;
    },
  });
  const guard = hangGuard("held baseline verification against the conversation queue", 30_000);
  try {
    await guard.watch(harness.coordinator.onReviewRequest(ups("session-hold"), newAbortSignal().signal));
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-hold", { toolName: "Write", readOnly: false });

    holdNext = true;
    const first = await guard.watch(harness.coordinator.onReviewRequest(stop("session-hold"), newAbortSignal().signal));
    assert.equal(first.action, "allow");
    assert.match(first.userMessage ?? "", /time limit/);
    await waitFor(async () => held === 1, 5_000);
    assert.equal(await harness.calls(), 0, "the held verification never reached the reviewer");

    // THE POINT: the queue advanced. With the first verification STILL held, a
    // later Stop runs a real review of the same change and passes it.
    const second = await guard.watch(harness.coordinator.onReviewRequest(stop("session-hold"), newAbortSignal().signal));
    assert.equal(second.action, "block", "a later Stop reviewed the same unreviewed change");
    assert.match(second.userMessage ?? "", /passed/);
    assert.equal(await harness.calls(), 1, "only the later Stop reached the reviewer");

    // Releasing the held load must launch nothing: a late verification result is
    // dropped, and never reaches the capture or the reviewer invocation.
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await harness.calls(), 1, "the released late verification launched no reviewer");

    await guard.watch(harness.coordinator.dispose());
    assert.deepEqual(await harness.records(), [], "dispose leaves no checkpoint behind");
  } finally {
    releaseFirst();
    guard.done();
    await harness.dispose();
  }
});

test("a configured Pi-model reviewer resolves only inside the host's Pi-scoped models, as in Pi", { skip: process.platform === "win32" }, async () => {
  // Live acceptance found the lane resolving against an empty scope always. The
  // scope is now the host's Pi-scoped models, exactly as a Pi session's own.
  const root = await makeRoot("pi-scope");
  const marker = join(root, "pi-invoked");
  const fakePi = join(root, "fake-pi");
  await writeFile(fakePi, `#!/bin/sh\necho invoked >> '${marker}'\nexit 3\n`, { mode: 0o700 });
  const piConfig = (harness: Harness): ReviewGateConfig => ({
    ...harness.config,
    review: { ...harness.config.review!, primaryReviewers: [{ source: "pi", model: "probe/reviewer-model" }] },
  });
  for (const scenario of [
    { name: "unscoped", scopedModels: undefined, expectInvoked: false },
    { name: "in-scope", scopedModels: ["probe/reviewer-model"], expectInvoked: true },
    { name: "excluded", scopedModels: ["probe/other-model"], expectInvoked: false },
  ] as const) {
    await rm(marker, { force: true });
    const harness = await createHarness({
      admittedPiCommand: fakePi,
      ...(scenario.scopedModels === undefined ? {} : { scopedModels: scenario.scopedModels }),
    });
    try {
      harness.config = piConfig(harness);
      const session = `session-scope-${scenario.name}`;
      await harness.coordinator.onReviewRequest(ups(session), newAbortSignal().signal);
      await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
      harness.coordinator.noteToolActivity(session, { toolName: "Write", readOnly: false });
      const verdict = await harness.coordinator.onReviewRequest(stop(session), newAbortSignal().signal);
      const invoked = fs.existsSync(marker);
      assert.equal(invoked, scenario.expectInvoked, `${scenario.name}: the Pi reviewer launch`);
      if (scenario.expectInvoked) {
        assert.doesNotMatch(verdict.userMessage ?? "", /no configured reviewer/, scenario.name);
      } else {
        assert.match(verdict.userMessage ?? "", /no configured reviewer is currently available/, scenario.name);
      }
    } finally {
      await harness.dispose();
    }
  }
});

test("a retained bundle outlives its closed window and is removed when the conversation ends, as in Pi", async () => {
  const harness = await createHarness();
  try {
    harness.config = { ...harness.config, retainBundles: "always" };
    await harness.coordinator.onReviewRequest(ups("session-retain"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-retain", { toolName: "Write", readOnly: false });
    const verdict = await harness.coordinator.onReviewRequest(stop("session-retain"), newAbortSignal().signal);
    assert.equal(verdict.action, "block");
    const bundleDir = bundleDirOf(verdict.reason!);

    // Switching the provider Off closes the window.
    harness.config = { ...harness.config, review: { ...harness.config.review!, primaryClaudeCodeEnabled: false } };
    assert.deepEqual(await harness.coordinator.onReviewRequest(ups("session-retain", "next"), newAbortSignal().signal), { action: "allow" });
    assert.ok(await exists(bundleDir), "the retained bundle survives the closed window");

    await harness.dispose();
    assert.equal(await exists(bundleDir), false, "the conversation's end removes it");
  } finally {
    await harness.dispose();
  }
});

/** One held gate the seam waits on, armed for exactly the next capture. */
function captureHold(): { arm(): void; held(): number; release(): void; seam: () => Promise<void> } {
  let armed = false;
  let held = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    arm: () => { armed = true; },
    held: () => held,
    release: () => release(),
    seam: async () => {
      if (!armed) return;
      armed = false;
      held += 1;
      await gate;
    },
  };
}

test("a prompt whose baseline capture outlives the deadline frees the queue and never publishes the late baseline", async () => {
  const hold = captureHold();
  const harness = await createHarness({ deadlineMs: 1_500, observeBaselineCapture: hold.seam });
  const guard = hangGuard("held prompt capture against the conversation queue", 30_000);
  try {
    hold.arm();
    const first = await guard.watch(harness.coordinator.onReviewRequest(ups("session-arm-stall"), newAbortSignal().signal));
    assert.equal(first.action, "allow", "a prompt that ran out of setup time proceeds");
    assert.match(first.userMessage ?? "", /could not prepare this turn in time/);
    await waitFor(async () => hold.held() === 1, 5_000);
    const late = await harness.records();
    assert.equal(late.length, 1, "the stalled capture had completed its checkpoint");

    // The provider proceeded and wrote; the late baseline must never cover it.
    await writeFile(join(harness.workspace, "index.ts"), "written while the capture was held\n", "utf8");
    harness.coordinator.noteToolActivity("session-arm-stall", { toolName: "Write", readOnly: false });
    const stopped = await guard.watch(harness.coordinator.onReviewRequest(stop("session-arm-stall"), newAbortSignal().signal));
    assert.deepEqual(stopped, { action: "allow" }, "the queue advanced past the held capture, and nothing was armed to review");
    assert.equal(await harness.calls(), 0);

    hold.release();
    await waitFor(async () => (await harness.records()).length === 0, 10_000);

    // The next prompt arms a fresh baseline of its own.
    const next = await guard.watch(harness.coordinator.onReviewRequest(ups("session-arm-stall", "next"), newAbortSignal().signal));
    assert.equal(next.action, "allow");
    assert.equal((await harness.records()).length, 1, "a fresh baseline for the next turn");
    await guard.watch(harness.coordinator.dispose());
    assert.deepEqual(await harness.records(), [], "dispose leaves no checkpoint behind");
  } finally {
    hold.release();
    guard.done();
    await harness.dispose();
  }
});

/**
 * #736 R-fix: an arm releases a baseline capture it must never publish — the
 * request was cancelled, or the publish itself failed. Pi raises
 * `orphan release failed` when that release fails; a native row has no such
 * channel, so the answer that reports the arm's failure says it instead.
 */
test("a capture that could not be published and could not be released is disclosed, not swallowed", async () => {
  let agentDir = "";
  const releases: boolean[] = [];
  const harness = await createHarness({
    observeBaselinePublish: async () => {
      // Damage the record the release has to verify first, so the real release
      // really fails, then fail the publish so the capture must be released.
      for (const record of await checkpointRecords(agentDir)) await writeFile(record, "damaged\n", "utf8");
      throw new Error("test: the window baseline could not be published");
    },
    observeUnpublishedCheckpointRelease: (released) => { releases.push(released); },
  });
  agentDir = harness.agentDir;
  try {
    const verdict = await harness.coordinator.onReviewRequest(ups("session-orphan-release"), newAbortSignal().signal);
    assert.equal(verdict.action, "allow", "a cleanup that failed never blocks or fails the turn");
    assert.match(verdict.userMessage ?? "", /automatic review failed/, "the arm failure is still reported");
    assert.match(
      verdict.userMessage ?? "",
      /review gate: a temporary review checkpoint could not be removed/,
      "and the release that failed with it is disclosed instead of dropped",
    );
    assert.ok(Buffer.byteLength(verdict.userMessage ?? "", "utf8") <= MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES);
    assert.deepEqual(releases, [false], "the real release of the unpublished capture failed");
    assert.ok((await harness.records()).length >= 1, "the record really is still there: the release failed");
    assert.equal(await harness.calls(), 0, "a turn that never armed runs no reviewer");
    // Said once: the following request of this conversation never repeats it.
    const following = await harness.coordinator.onReviewRequest(stop("session-orphan-release"), newAbortSignal().signal);
    assert.doesNotMatch(following.userMessage ?? "", /temporary review checkpoint/, "said once, never again");
  } finally {
    await harness.dispose();
  }
});

/**
 * #736 R-fix (review pass 2): a baseline capture that must never be published can
 * ALSO fail to release — in DETACHED cleanup, after the request that captured it
 * was answered by its own deadline and after its own conversation was superseded
 * and dropped. And the reply that finally says it may already be at the
 * transport's byte limit with another owed notice on top. So the disclosure
 * belongs to the lane, both fixed lines are reserved room before anything is
 * shortened, and each is spent only once it really travelled.
 */
test("a release that fails after its conversation is gone is still said, whole, and only once", async () => {
  let agentDir = "";
  let held = 0;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const releases: boolean[] = [];
  const harness = await createHarness({
    deadlineMs: 1_500,
    observeBaselineCapture: async () => {
      held += 1;
      if (held > 1) return;
      // The capture wrote its record; damage it so the release of a baseline that
      // must never be published really fails, then hold the completed capture
      // past this request's deadline.
      for (const record of await checkpointRecords(agentDir)) await writeFile(record, "damaged\n", "utf8");
      await gate;
    },
    observeUnpublishedCheckpointRelease: (released) => { releases.push(released); },
  });
  agentDir = harness.agentDir;
  const agents = harness.config.externalAgents;
  // Armed with a reviewer that cannot be resolved, so the next settlement really
  // reconciles and owes a line of its own.
  harness.config = {
    ...harness.config,
    externalAgents: {},
    review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "gone" }] },
  };
  const guard = hangGuard("held capture against the conversation queue", 30_000);
  try {
    const first = await guard.watch(harness.coordinator.onReviewRequest(ups("session-late-a"), newAbortSignal().signal));
    assert.equal(first.action, "allow", "a prompt that ran out of setup time proceeds");
    assert.match(first.userMessage ?? "", /could not prepare this turn in time/);
    assert.doesNotMatch(first.userMessage ?? "", /temporary review checkpoint/, "the release has not even run when the deadline answers");
    await waitFor(async () => held === 1, 5_000);

    // B takes the lane. A's conversation is superseded and dropped, so the
    // warning no longer has an owner to hold it.
    const armedB = await guard.watch(harness.coordinator.onReviewRequest(ups("session-late-b"), newAbortSignal().signal));
    assert.equal(armedB.action, "allow");

    // Let A's late capture go: the detached cleanup releases it, and fails.
    releaseGate();
    await waitFor(async () => releases.length === 1, 10_000);
    assert.deepEqual(releases, [false], "the release of the unpublished baseline failed");
    assert.ok((await harness.records()).length >= 1, "the record really is still there");

    // B's first reply owes BOTH lines and already carries a near-limit notice of
    // its own, because the lane cannot verify the background.
    harness.config = {
      ...harness.config,
      externalAgents: agents,
      review: { ...harness.config.review!, primaryReviewers: [{ source: "external", id: "fake" }] },
    };
    harness.background = { state: "unknown", detail: "unverifiable ".repeat(600) };
    harness.coordinator.noteToolActivity("session-late-b", { toolName: "Write", readOnly: false });
    const told = await guard.watch(harness.coordinator.onReviewRequest(stop("session-late-b"), newAbortSignal().signal));
    assert.equal(told.action, "allow");
    const lines = (told.userMessage ?? "").split("\n");
    assert.equal(
      lines.filter((line) => line === "review gate: a temporary review checkpoint could not be removed").length,
      1,
      "the cleanup line travels as one complete line",
    );
    assert.equal(
      lines.filter((line) => line.includes("reconciled to the updated reviewer settings")).length,
      1,
      "and so does the reconcile line, in the same reply",
    );
    assert.ok(
      Buffer.byteLength(told.userMessage ?? "", "utf8") <= MAX_NATIVE_REVIEW_USER_MESSAGE_BYTES,
      "both lines fit inside the transport bound",
    );

    // And neither is said twice.
    const following = await guard.watch(harness.coordinator.onReviewRequest(stop("session-late-b"), newAbortSignal().signal));
    assert.doesNotMatch(following.userMessage ?? "", /temporary review checkpoint/, "the cleanup line is said once");
    assert.doesNotMatch(following.userMessage ?? "", /reconciled to the updated reviewer settings/, "the reconcile line is said once");
  } finally {
    releaseGate();
    guard.done();
    await harness.dispose();
  }
});

/**
 * #736 R-fix (review pass 2): the publish step is the last uninterruptible step
 * of a prompt arm, and a cancellation that lands while it is held must not leave
 * a baseline attached. The provider already proceeded without that baseline, so
 * reviewing from it would certify writes it never saw — and the capture itself
 * has to go back to the store, because nothing owns it any more.
 */
test("a capture whose publish was cancelled is released, not made the next baseline", async () => {
  let held = 0;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const releases: boolean[] = [];
  const harness = await createHarness({
    observeBaselinePublish: async () => {
      held += 1;
      if (held > 1) return;
      await gate;
    },
    observeUnpublishedCheckpointRelease: (released) => { releases.push(released); },
  });
  const guard = hangGuard("held publish against the conversation queue", 30_000);
  try {
    const prompt = newAbortSignal();
    const inflight = harness.coordinator.onReviewRequest(ups("session-publish-cancel"), prompt.signal);
    await waitFor(async () => held === 1, 5_000);
    prompt.abort(new Error("the row hung up"));
    releaseGate();
    const first = await guard.watch(inflight);
    assert.deepEqual(first, { action: "allow" }, "a cancelled prompt's answer is dropped as it always was");
    await waitFor(async () => releases.length === 1, 10_000);
    assert.deepEqual(releases, [true], "the unpublished capture was released rather than published");
    await waitFor(async () => (await harness.records()).length === 0, 10_000);

    // The next Stop has no baseline to review, and the capture the cancelled
    // prompt had already made is not used as one.
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-publish-cancel", { toolName: "Write", readOnly: false });
    const stopped = await guard.watch(harness.coordinator.onReviewRequest(stop("session-publish-cancel"), newAbortSignal().signal));
    assert.deepEqual(stopped, { action: "allow" });
    assert.equal(await harness.calls(), 0, "the cancelled capture never became a baseline");
  } finally {
    releaseGate();
    guard.done();
    await harness.dispose();
  }
});

test("a cancelled checkpoint comparison releases the queue, and its late after-checkpoint is released not published", async () => {
  // The comparison is the SECOND uninterruptible read of a raw settlement: it
  // loads this same baseline again. Stalling there — after the after-checkpoint
  // was captured — is the case a baseline-read race alone did not cover.
  let holdNext = false;
  let held = 0;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const harness = await createHarness({
    deadlineMs: 1_500,
    observeCheckpointComparison: async () => {
      if (!holdNext) return;
      holdNext = false;
      held += 1;
      await firstHeld;
    },
  });
  const guard = hangGuard("held checkpoint comparison against the conversation queue", 30_000);
  try {
    await guard.watch(harness.coordinator.onReviewRequest(ups("session-compare"), newAbortSignal().signal));
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-compare", { toolName: "Write", readOnly: false });
    const armed = new Set(await harness.records());
    assert.ok(armed.size > 0, "the armed baseline is a real checkpoint record");

    holdNext = true;
    const first = await guard.watch(harness.coordinator.onReviewRequest(stop("session-compare"), newAbortSignal().signal));
    assert.equal(first.action, "allow");
    assert.match(first.userMessage ?? "", /time limit/);
    await waitFor(async () => held === 1, 5_000);
    assert.equal(await harness.calls(), 0, "the stalled comparison never reached the reviewer");
    const stalled = (await harness.records()).filter((name) => !armed.has(name));
    assert.equal(stalled.length, 1, "the stalled settlement had already acquired its after-checkpoint");

    // THE POINT: the queue advanced with the comparison STILL held.
    const second = await guard.watch(harness.coordinator.onReviewRequest(stop("session-compare"), newAbortSignal().signal));
    assert.equal(second.action, "block", "a later Stop reviewed the same unreviewed change");
    assert.match(second.userMessage ?? "", /passed/);
    assert.equal(await harness.calls(), 1, "only the later Stop reached the reviewer");

    // Releasing the stalled comparison launches nothing, and the after-checkpoint
    // it captured is released by the detached cleanup — never published as a
    // reviewed baseline, because the run that owned it was cancelled.
    releaseFirst();
    await waitFor(async () => !(await harness.records()).includes(stalled[0]!), 10_000);
    assert.equal(await harness.calls(), 1, "the released late settlement launched no reviewer");

    await guard.watch(harness.coordinator.dispose());
    assert.deepEqual(await harness.records(), [], "dispose leaves no checkpoint behind");
  } finally {
    releaseFirst();
    guard.done();
    await harness.dispose();
  }
});

test("a settlement that cannot be interrupted cannot hold the provider past its deadline, and its late work commits nothing", { skip: process.platform === "win32" }, async () => {
  // The reviewer ignores the abort's SIGTERM, so the settlement stays open for
  // the adapter's full SIGKILL escalation: a stage the coordinator cannot wait
  // out, which is exactly the case the reply must not be chained behind.
  const harness = await createHarness({
    reviewerDelayMs: 20_000,
    reviewerIgnoresAbort: true,
    deadlineMs: 800,
  });
  const guard = hangGuard("deadline reply against a stalled settlement");
  try {
    await harness.coordinator.onReviewRequest(ups("session-stall"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-stall", { toolName: "Write", readOnly: false });

    const started = Date.now();
    const timedOut = await guard.watch(harness.coordinator.onReviewRequest(stop("session-stall"), newAbortSignal().signal));
    const waited = Date.now() - started;
    assert.ok(waited < 4_000, `the reply came on the deadline, not after the stalled reviewer (${waited}ms)`);
    assert.equal(timedOut.action, "allow");
    assert.match(timedOut.userMessage ?? "", /time limit/);

    // The late work is still running, and it has committed nothing: the window
    // still owns its baseline, and no second reviewer was launched.
    assert.ok((await harness.records()).length >= 1, "the stalled settlement kept the unreviewed baseline");
    assert.equal(await harness.calls(), 1, "the stalled attempt launched exactly one reviewer");

    // The queue is not starved: the NEXT request is answered on its own deadline
    // while the stalled head is still open, rather than waiting behind it.
    const nextStarted = Date.now();
    const queued = await guard.watch(harness.coordinator.onReviewRequest(stop("session-stall"), newAbortSignal().signal));
    assert.ok(Date.now() - nextStarted < 4_000, "the queued request was answered on its own deadline");
    assert.equal(queued.action, "allow");
    assert.match(queued.userMessage ?? "", /time limit/);
    assert.equal(await harness.calls(), 1, "neither the late work nor the queued request launched another reviewer");

    // And the turn's change is still pending: nothing a cancelled settlement can
    // reach was spent, so a later turn still owns the same unreviewed delta.
    assert.ok((await harness.records()).length >= 1, "the unreviewed baseline outlived the stalled settlement");
    const { unreviewedConversations } = await guard.watch(harness.coordinator.dispose());
    assert.equal(unreviewedConversations, 1, "the conversation is reported as left unreviewed, not as reviewed");
    assert.deepEqual(await harness.records(), [], "dispose still released what the stalled settlement owned");
  } finally {
    guard.done();
    await harness.dispose();
  }
});

test("a write reported while the reviewer runs is not covered by that review and earns the next Stop one", async () => {
  const harness = await createHarness({ reviewerDelayMs: 800 });
  try {
    await harness.coordinator.onReviewRequest(ups("session-midreview"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-midreview", { toolName: "Write", readOnly: false });

    const running = harness.coordinator.onReviewRequest(stop("session-midreview"), newAbortSignal().signal);
    // The reviewer records its call only after the reviewed checkpoint was
    // captured, so a write from here on is outside what it is examining.
    await waitFor(async () => (await harness.calls()) === 1);
    await writeFile(join(harness.workspace, "index.ts"), "second write\n", "utf8");
    harness.coordinator.noteToolActivity("session-midreview", { toolName: "Write", readOnly: false });
    const first = await running;
    assert.equal(first.action, "block", "the first review still passes what it examined");

    // No further tool event: the second write was never reviewed, so the next
    // Stop must launch a reviewer instead of taking the no-activity path.
    const next = await harness.coordinator.onReviewRequest(stop("session-midreview", "Done."), newAbortSignal().signal);
    assert.equal(await harness.calls(), 2, "the write made during the first review reached a reviewer");
    assert.equal(next.action, "block");
  } finally {
    await harness.dispose();
  }
});

test("a cancelled review never arms the response exchange it did not deliver", async () => {
  const harness = await createHarness({ reviewerDelayMs: 500 });
  try {
    await harness.coordinator.onReviewRequest(ups("session-unarmed"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-unarmed", { toolName: "Write", readOnly: false });

    const first = newAbortSignal();
    const running = harness.coordinator.onReviewRequest(stop("session-unarmed"), first.signal);
    // Cancel once the reviewer is provably running, not after a delay that only
    // assumes the child had started.
    await waitFor(async () => (await harness.calls()) === 1, 20_000);
    first.abort(new Error("the row hung up"));
    assert.deepEqual(await running, { action: "allow" });

    // A recorded transmission would have armed a response exchange and counted
    // a correction cycle for feedback the model never saw; the next turn is
    // therefore a plain re-review of the same change, not an answer.
    harness.coordinator.noteToolActivity("session-unarmed", { toolName: "Write", readOnly: false });
    const retry = await harness.coordinator.onReviewRequest(stop("session-unarmed"), newAbortSignal().signal);
    assert.equal(retry.action, "block");
    assert.match(retry.userMessage ?? "", /changes requested \(/, "a fresh correction cycle, not a cap deferral");
    assert.equal(await harness.calls(), 2);
  } finally {
    await harness.dispose();
  }
});

test("a completed pass closes its window so a later prompt cannot re-review the same delta", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-closed"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-closed", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
    assert.equal((await harness.coordinator.onReviewRequest(stop("session-closed"), newAbortSignal().signal)).action, "block");
    assert.equal(await harness.calls(), 1);

    // The model answers the pass without touching the workspace: accepted.
    assert.deepEqual(await harness.coordinator.onReviewRequest(stop("session-closed", "Confirmed, nothing else."), newAbortSignal().signal), { action: "allow" });
    assert.deepEqual(await harness.records(), [], "an accepted review keeps no baseline pinning the workspace");

    // A genuinely new request with no edits must NOT inherit the accepted
    // window's baseline, request history, frozen configuration, or count.
    await harness.coordinator.onReviewRequest(ups("session-closed"), newAbortSignal().signal);
    const settled = await harness.coordinator.onReviewRequest(stop("session-closed"), newAbortSignal().signal);
    assert.deepEqual(settled, { action: "allow" }, "nothing new changed, so nothing is reviewed");
    assert.equal(await harness.calls(), 1, "the already-passed delta is never reviewed twice");
  } finally {
    await harness.dispose();
  }
});

test("an unresolved correction with no qualifying call tells the user and stays out of the model's way", async () => {
  // U4: the correction turn changed the workspace but recorded no qualifying
  // tool call, so runReview answers `no_new_tool_activity` while the earlier
  // requested changes are still unresolved. Pi warns the user in that case;
  // the native row says the same thing without its `/review-now` sentence, and
  // says it to the USER: `userMessage` on an allow reaches no model at all.
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-unresolved-notice"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "one.ts"), "one\n", "utf8");
    harness.coordinator.noteToolActivity("session-unresolved-notice", { toolName: "Write", readOnly: false });
    const corrected = await harness.coordinator.onReviewRequest(stop("session-unresolved-notice"), newAbortSignal().signal);
    assert.equal(corrected.action, "block", "the reviewer's feedback is transmitted to the model");
    assert.equal(await harness.calls(), 1);

    // No `noteToolActivity` call: a workspace change alone is not qualifying
    // activity, so this turn earns no reviewer.
    await writeFile(join(harness.workspace, "two.ts"), "two\n", "utf8");
    const skipped = await harness.coordinator.onReviewRequest(stop("session-unresolved-notice", "I made the change."), newAbortSignal().signal);
    assert.equal(NATIVE_UNRESOLVED_FEEDBACK_NOTICE,
      "review gate: automatic review skipped because no new qualifying tool call was recorded since the last review;"
      + " the earlier requested changes remain unresolved.",
      "Pi's sentence, minus the `/review-now` clause a native row cannot honor");
    assert.deepEqual(skipped, { action: "allow", userMessage: NATIVE_UNRESOLVED_FEEDBACK_NOTICE },
      "the notice is shown exactly, as the user's only channel");
    assert.equal(skipped.reason, undefined, "a user notice is never a model-facing block reason");
    assert.equal(await harness.calls(), 1, "the skipped turn launched no reviewer");
    assert.ok((await harness.records()).length >= 1, "the unresolved window stays open with its baseline");
    assert.deepEqual(await harness.dispose(), { unreviewedConversations: 1 }, "the window survived the skipped turn");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("the same skipped turn with no unresolved review stays a quiet allow", async () => {
  // U4's negative half: the notice exists to say that earlier requested changes
  // are still outstanding. With no review history at all there is nothing
  // outstanding, so the turn stays as quiet as it was before the notice.
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-resolved-quiet"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "one.ts"), "one\n", "utf8");
    const skipped = await harness.coordinator.onReviewRequest(stop("session-resolved-quiet"), newAbortSignal().signal);
    assert.deepEqual(skipped, { action: "allow" }, "no unresolved review means no notice of any kind");
    assert.equal(await harness.calls(), 0, "a non-qualifying turn still runs no reviewer");
    assert.ok((await harness.records()).length >= 1, "the unreviewed change stays available to a qualifying turn");
  } finally {
    await harness.dispose();
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("changes nobody can attribute to the model are warned about after its pass", async () => {
  // U5: the turn answering a pass wrote to the workspace but recorded no
  // qualifying activity, so runReview answers `no_new_reviewable_activity`. The
  // actual pass stands; what gets disclosed is the post-pass delta the response
  // exchange observed, in Pi's exact words, naming the review that passed.
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-unattributed"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-unattributed", { toolName: "Write", readOnly: false });
    const passed = await harness.coordinator.onReviewRequest(stop("session-unattributed"), newAbortSignal().signal);
    assert.equal(passed.action, "block", "the pass is transmitted for observation");
    assert.equal(await harness.calls(), 1);

    // Written straight from here, so no tool activity is reported for it: this
    // is exactly the drift no review can attribute to the running model.
    await writeFile(join(harness.workspace, "drift.ts"), "drift\n", "utf8");
    const response = await harness.coordinator.onReviewRequest(stop("session-unattributed", "Confirmed, nothing else to change."), newAbortSignal().signal);
    assert.equal(response.action, "allow", "the accepted pass is never reopened");
    assert.equal(response.userMessage,
      "WARNING: review gate: Unattributed changes were detected after review 1 passed."
      + " They could not be attributed to the running model and were not subject to further review.",
    "Pi's warning, verbatim, naming the review that passed");
    assert.equal(response.reason, undefined, "a user warning is never a model-facing block reason");
    assert.equal(await harness.calls(), 1, "the response turn launched no second reviewer");
    // As in Pi: a response exchange that carries a delta keeps the window, its
    // baseline, and that delta available, rather than closing over unreviewed
    // work. Only a genuinely unchanged confirmation closes it (test below).
    assert.ok((await harness.records()).length >= 1, "the window stays open with its unattributed change");
    assert.deepEqual(await harness.dispose(), { unreviewedConversations: 1 }, "the window survived the response turn");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("an unchanged confirmation after a pass warns about nothing and closes the window", async () => {
  // U5's negative half: an unchanged response exchange is not a new safety
  // problem, so it stays quiet and completes the review as before.
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-attributed-quiet"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-attributed-quiet", { toolName: "Write", readOnly: false });
    assert.equal((await harness.coordinator.onReviewRequest(stop("session-attributed-quiet"), newAbortSignal().signal)).action, "block");
    assert.equal(await harness.calls(), 1);

    const response = await harness.coordinator.onReviewRequest(stop("session-attributed-quiet", "Confirmed, nothing else to change."), newAbortSignal().signal);
    assert.deepEqual(response, { action: "allow" }, "an unchanged confirmation carries no warning");
    assert.equal(await harness.calls(), 1);
    await waitFor(async () => (await harness.records()).length === 0, 5_000);
    assert.deepEqual(await harness.records(), [], "the accepted review closes its window and releases its checkpoints");
    assert.deepEqual(await harness.dispose(), { unreviewedConversations: 0 });
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a deferred window survives a completed turn so its unresolved feedback is not forgotten", async () => {
  const harness = await createHarness();
  try {
    harness.config = { ...harness.config, maxCorrectionCycles: 1 };
    await harness.coordinator.onReviewRequest(ups("session-deferred"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "one.ts"), "one\n", "utf8");
    harness.coordinator.noteToolActivity("session-deferred", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
    await harness.coordinator.onReviewRequest(stop("session-deferred"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "two.ts"), "two\n", "utf8");
    harness.coordinator.noteToolActivity("session-deferred", { toolName: "Write", readOnly: false });
    const capped = await harness.coordinator.onReviewRequest(stop("session-deferred"), newAbortSignal().signal);
    assert.match(capped.userMessage ?? "", /correction cap reached/);

    // The unresolved review stays open: its baseline and its reviewer feedback
    // are what a later turn is still answering.
    await harness.setMode("pass");
    await writeFile(join(harness.workspace, "three.ts"), "three\n", "utf8");
    harness.coordinator.noteToolActivity("session-deferred", { toolName: "Write", readOnly: false });
    const next = await harness.coordinator.onReviewRequest(stop("session-deferred"), newAbortSignal().signal);
    assert.equal(next.action, "block", "a deferred window is reviewed again, not silently accepted");
    assert.ok((await harness.records()).length >= 1, "the deferred window keeps its baseline");
  } finally {
    await harness.dispose();
  }
});

test("reviewer text that cannot travel inline is made deliverable before the correction is recorded", async () => {
  for (const mode of ["needs_changes_oversized", "needs_changes_controls"] as const) {
    const harness = await createHarness();
    try {
      await harness.coordinator.onReviewRequest(ups(`session-${mode}`), newAbortSignal().signal);
      await harness.setMode(mode);
      await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
      harness.coordinator.noteToolActivity(`session-${mode}`, { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
      const verdict = await harness.coordinator.onReviewRequest(stop(`session-${mode}`), newAbortSignal().signal);
      assert.equal(verdict.action, "block");
      const reason = verdict.reason ?? "";
      // The broker refuses an unsendable verdict and answers the closed
      // `failed` code, which would unreview a turn this host did review.
      const accepted = parseNativeReviewVerdict({ action: verdict.action, reason: verdict.reason, userMessage: verdict.userMessage });
      assert.ok(accepted, `${mode}: the broker's own validation must accept the verdict`);
      assert.ok(Buffer.byteLength(reason, "utf8") <= MAX_NATIVE_REVIEW_REASON_BYTES, `${mode}: reason stays inside the inline limit`);
      assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason), false, `${mode}: no control character survives`);
      if (mode === "needs_changes_oversized") {
        // Never silently truncated: the reader is pointed at the complete text.
        assert.match(reason, /larger than this provider's inline limit/);
        const pointer = reason.match(/transmission at (\S+?implementing-model-transmission\.md)/);
        assert.ok(pointer, `the bounded form names where the full text lives: ${reason.slice(0, 200)}`);
        // The pass's own transmission, never the shared multi-pass directory.
        assert.match(pointer[1]!, new RegExp(`reviews[/\\\\][0-9]{4}[/\\\\]implementing-model-transmission\.md$`),
          `the pointer names one pass's transmission file: ${pointer[1]}`);
        assert.ok(await exists(pointer[1]!), "the pointer names a transmission file that exists");
      } else {
        assert.match(reason, /fix required|index\.ts|control/i, "the bounded form still says what changed");
      }
    } finally {
      await harness.dispose();
    }
  }
});

test("an oversized deferred verdict still forbids an unauthorized correction", async () => {
  const harness = await createHarness();
  try {
    harness.config = { ...harness.config, maxCorrectionCycles: 1 };
    await harness.coordinator.onReviewRequest(ups("session-oversized-cap"), newAbortSignal().signal);
    await harness.setMode("needs_changes_oversized");
    await writeFile(join(harness.workspace, "one.ts"), "one\n", "utf8");
    harness.coordinator.noteToolActivity("session-oversized-cap", { toolName: "Write", readOnly: false }); // U21: a change alone is no longer a review
    await harness.coordinator.onReviewRequest(stop("session-oversized-cap"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "two.ts"), "two\n", "utf8");
    harness.coordinator.noteToolActivity("session-oversized-cap", { toolName: "Write", readOnly: false });
    const capped = await harness.coordinator.onReviewRequest(stop("session-oversized-cap"), newAbortSignal().signal);
    assert.equal(capped.action, "block");
    assert.match(capped.userMessage ?? "", /correction cap reached/);
    const reason = capped.reason ?? "";
    assert.ok(Buffer.byteLength(reason, "utf8") <= MAX_NATIVE_REVIEW_REASON_BYTES);
    // A model that never opens the evidence must still be told not to correct.
    assert.match(reason, /Do not make a correction solely from this message unless the user authorizes continuation/);
    const pointer = reason.match(/transmission at (\S+?implementing-model-transmission\.md)/);
    assert.ok(pointer, `the bounded form names where the full text lives: ${reason.slice(-200)}`);
    assert.match(pointer[1]!, new RegExp(`reviews[/\\\\][0-9]{4}[/\\\\]implementing-model-transmission\.md$`),
      "the pointer names this pass's transmission, not the multi-pass window directory");
    assert.ok(await exists(pointer[1]!), "and that file exists");
    // The directory it lives in holds exactly this pass, so nothing in it can
    // contradict the deferred instruction with an earlier correction request.
    const siblings = await walkFiles(join(pointer[1]!, ".."));
    assert.ok(siblings.every((path) => !path.includes(join("reviews", "0001"))),
      "an earlier pass's transmission is never what a deferred verdict points at");
    assert.ok(siblings.some((path) => path.endsWith("implementing-model-transmission.md")));
  } finally {
    await harness.dispose();
  }
});

test("review coverage lost on an unreviewable turn is disclosed instead of dropped", async () => {
  const harness = await createHarness();
  let undo: (() => Promise<void>) | undefined;
  try {
    await harness.coordinator.onReviewRequest(ups("session-lost"), newAbortSignal().signal);
    assert.equal((await harness.records()).length, 1, "the baseline captured normally first");
    // The after-capture at settlement is what fails now.
    undo = await breakCapture(harness);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-lost", { toolName: "Write", readOnly: false });
    const verdict = await harness.coordinator.onReviewRequest(stop("session-lost"), newAbortSignal().signal);
    await undo();
    undo = undefined;
    assert.equal(verdict.action, "allow");
    // The notice is the only signal that this turn's review coverage changed;
    // a no-verdict allow that discards it hides the loss from the user.
    // #736 U14: on a native row that signal is this lane's own snapshot notice,
    // because the shared Tools-only warning would claim tool evidence a native
    // row never records.
    assert.match(verdict.userMessage ?? "", /snapshot could not be captured/, "the snapshot-failure notice reaches the user");
    assert.doesNotMatch(verdict.userMessage ?? "", /Review evidence method|Tools only/, "no Tools-only claim on a row with no tool evidence");
    assert.equal((await harness.records()).length, 1, "the window stays open, so the unreviewed change is not closed over");
  } finally {
    await undo?.();
    await harness.dispose();
  }
});

test("a conversation is retired even when the incoming id cannot be a checkpoint path", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-safe"), newAbortSignal().signal);
    assert.equal((await harness.records()).length, 1);

    const unsafe = await harness.coordinator.onReviewRequest(ups("../escape"), newAbortSignal().signal);
    assert.equal(unsafe.action, "allow");
    assert.match(unsafe.userMessage ?? "", /automatic review is unavailable for this conversation/);
    // Refusing to open a scope for the new id is not a reason to leave the old
    // conversation's baseline pinning the workspace forever.
    await waitFor(async () => (await harness.records()).length === 0, 5_000);
    assert.deepEqual(await harness.dispose(), { unreviewedConversations: 0 });
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("an undeliverable request never consumes the one-time closure disclosure", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-held"), newAbortSignal().signal);
    assert.equal((await harness.records()).length, 1);

    // The switch happens, but this request can never show anything.
    const dead = newAbortSignal();
    dead.abort();
    const lost = await harness.coordinator.onReviewRequest(ups("session-next"), dead.signal);
    assert.equal(lost.action, "allow");
    assert.equal(lost.userMessage, undefined, "an aborted request carries nothing and consumes nothing");

    const delivered = await harness.coordinator.onReviewRequest(ups("session-next"), newAbortSignal().signal);
    assert.match(delivered.userMessage ?? "", /previous conversation's automatic review window closed without reviewing its latest changes/);
    // Still one-time.
    const later = await harness.coordinator.onReviewRequest(stop("session-next"), newAbortSignal().signal);
    assert.doesNotMatch(later.userMessage ?? "", /previous conversation/);
  } finally {
    await harness.dispose();
  }
});

// ---------------------------------------------------------------------------
// Reopened windows, cancellation commits, and an injected census that stalls
// ---------------------------------------------------------------------------

/** Fails the test instead of hanging the runner when a host call never settles. */
async function within<T>(label: string, limitMs: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${limitMs}ms`)), limitMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("a window reopened after the toggle came back On is still releasable", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-reopen-toggle"), newAbortSignal().signal);
    assert.equal((await harness.records()).length, 1);

    // Off closes the window and releases what it owned.
    harness.config = { ...harness.config, enabled: false };
    await harness.coordinator.onReviewRequest(ups("session-reopen-toggle"), newAbortSignal().signal);
    await waitFor(async () => (await harness.records()).length === 0, 5_000);

    // Back On: a fresh window captures again. Its release must not inherit the
    // resolved promise of the release that already ran.
    harness.config = { ...harness.config, enabled: true };
    await harness.coordinator.onReviewRequest(ups("session-reopen-toggle"), newAbortSignal().signal);
    assert.equal((await harness.records()).length, 1, "the reopened window captured its own baseline");

    await harness.dispose();
    // Asserted before fixture teardown, which would hide the leak.
    assert.deepEqual(await harness.records(), [], "the SECOND window's checkpoint is released too");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a window reopened after a completed turn is still releasable", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-reopen-turn"), newAbortSignal().signal);
    // Nothing changed: the completed window closes and releases its baseline.
    assert.deepEqual(await harness.coordinator.onReviewRequest(stop("session-reopen-turn"), newAbortSignal().signal), { action: "allow" });
    assert.deepEqual(await harness.records(), []);

    await harness.coordinator.onReviewRequest(ups("session-reopen-turn"), newAbortSignal().signal);
    assert.equal((await harness.records()).length, 1, "the new prompt armed a fresh baseline");

    await harness.dispose();
    assert.deepEqual(await harness.records(), [], "dispose sees the reopened window, not the retired one's promise");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a superseded conversation releasing late still releases its own window", async () => {
  const harness = await createHarness({ reviewerDelayMs: 300 });
  try {
    await harness.coordinator.onReviewRequest(ups("session-late-release"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-late-release", { toolName: "Write", readOnly: false });
    // Retired while its review is still running; the release waits for that chain.
    const switched = await harness.coordinator.onReviewRequest(ups("session-late-next"), newAbortSignal().signal);
    assert.match(switched.userMessage ?? "", /previous conversation/);
    await waitFor(async () => (await harness.records()).length === 1, 5_000);
    await harness.dispose();
    assert.deepEqual(await harness.records(), [], "neither conversation leaves a record behind");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a cancelled review spends no correction cycle", async () => {
  const harness = await createHarness({ reviewerDelayMs: 500 });
  try {
    // A cap of one makes an undelivered correction observable: it would turn the
    // retry into a deferral the model was never told about.
    harness.config = { ...harness.config, maxCorrectionCycles: 1 };
    await harness.coordinator.onReviewRequest(ups("session-cycle"), newAbortSignal().signal);
    await harness.setMode("needs_changes");
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-cycle", { toolName: "Write", readOnly: false });

    const first = newAbortSignal();
    const running = harness.coordinator.onReviewRequest(stop("session-cycle"), first.signal);
    // Cancel once the reviewer is provably running, not after a delay that only
    // assumes the child had started.
    await waitFor(async () => (await harness.calls()) === 1, 20_000);
    first.abort(new Error("the row hung up while the transmission was being prepared"));
    assert.deepEqual(await running, { action: "allow" });

    // No new tool event: the same change is still pending, and it is still the
    // FIRST correction cycle rather than a cap deferral.
    const retry = await harness.coordinator.onReviewRequest(stop("session-cycle"), newAbortSignal().signal);
    assert.equal(retry.action, "block", "the cancelled attempt consumed no qualifying activity");
    assert.match(retry.userMessage ?? "", /changes requested \(/, "a fresh correction, not a deferral");
    assert.doesNotMatch(retry.userMessage ?? "", /correction cap reached/);
    assert.equal(await harness.calls(), 2);
  } finally {
    await harness.dispose();
  }
});

test("a census that never answers cannot hold the conversation open", async () => {
  const harness = await createHarness();
  try {
    let stalled = false;
    harness.background = () => {
      stalled = true;
      return new Promise<NativeReviewBackgroundState>(() => { /* the host never answers */ });
    };
    await harness.coordinator.onReviewRequest(ups("session-stall"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-stall", { toolName: "Write", readOnly: false });

    const first = newAbortSignal();
    const parked = harness.coordinator.onReviewRequest(stop("session-stall"), first.signal);
    await waitFor(() => stalled, 2_000);
    // A second request for this conversation queues behind the parked one.
    const queued = harness.coordinator.onReviewRequest(ups("session-stall", "follow-up"), newAbortSignal().signal);

    first.abort(new Error("the hook was cancelled"));
    assert.deepEqual(await within("the cancelled Stop", 5_000, parked), { action: "allow" });
    const followUp = await within("the queued UserPromptSubmit", 5_000, queued);
    assert.equal(followUp.action, "allow");
    assert.ok((await harness.records()).length >= 1, "the queued request still armed its own baseline");
  } finally {
    await harness.dispose();
  }
});

test("dispose settles and releases while an injected census is still pending", async () => {
  const harness = await createHarness();
  try {
    let stalled = false;
    harness.background = () => {
      stalled = true;
      return new Promise<NativeReviewBackgroundState>(() => { /* the host never answers */ });
    };
    await harness.coordinator.onReviewRequest(ups("session-dispose-stall"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-dispose-stall", { toolName: "Write", readOnly: false });
    const parked = harness.coordinator.onReviewRequest(stop("session-dispose-stall"), newAbortSignal().signal);
    await waitFor(() => stalled, 2_000);

    // Dispose aborts in-flight reviews; the stalled observation must not be able
    // to hold dispose — or the checkpoint it owns — open indefinitely.
    const disposed = await within("dispose", 5_000, harness.dispose());
    assert.deepEqual(disposed, { unreviewedConversations: 1 });
    assert.deepEqual(await within("the parked Stop", 5_000, parked), { action: "allow" });
    assert.deepEqual(await harness.records(), [], "no checkpoint outlives a dispose during a stalled census");
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("a census that rejects after cancellation is never an unhandled rejection", async () => {
  const harness = await createHarness();
  const seen: unknown[] = [];
  const observe = (reason: unknown): void => { seen.push(reason); };
  process.on("unhandledRejection", observe);
  try {
    harness.background = () => new Promise<NativeReviewBackgroundState>((_resolve, reject) => {
      setTimeout(() => reject(new Error("the census failed late")), 50);
    });
    await harness.coordinator.onReviewRequest(ups("session-late-reject"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-late-reject", { toolName: "Write", readOnly: false });

    const first = newAbortSignal();
    const running = harness.coordinator.onReviewRequest(stop("session-late-reject"), first.signal);
    first.abort(new Error("cancelled before the census failed"));
    assert.deepEqual(await within("the cancelled Stop", 5_000, running), { action: "allow" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(seen, [], "a late census rejection is handled by the coordinator");
  } finally {
    process.off("unhandledRejection", observe);
    await harness.dispose();
  }
});

test("a superseded conversation finishing late never spends the incoming disclosure", async () => {
  const harness = await createHarness();
  try {
    let releaseCensus!: (value: NativeReviewBackgroundState) => void;
    let parked = false;
    harness.background = () => new Promise<NativeReviewBackgroundState>((resolve) => {
      parked = true;
      releaseCensus = resolve;
    });
    await harness.coordinator.onReviewRequest(ups("session-late-finish"), newAbortSignal().signal);
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    harness.coordinator.noteToolActivity("session-late-finish", { toolName: "Write", readOnly: false });
    // Parked mid-settlement, so it finishes AFTER the switch happens below.
    const parkedRequest = harness.coordinator.onReviewRequest(stop("session-late-finish"), newAbortSignal().signal);
    await waitFor(() => parked, 2_000);

    // The switch retires it and leaves the disclosure pending: this request is
    // already cancelled, so it can neither carry nor spend a notice.
    const dead = newAbortSignal();
    dead.abort();
    assert.deepEqual(await harness.coordinator.onReviewRequest(ups("session-incoming"), dead.signal), { action: "allow" });

    // The old settlement now completes — as a closed conversation.
    releaseCensus({ state: "idle" });
    // A session switch ENDS the old review: it is cancelled outright, so it
    // never captures the workspace under the old prompt and baseline, never
    // reaches a reviewer, and never returns a verdict nobody is waiting for.
    const late = await within("the parked Stop", 5_000, parkedRequest);
    assert.deepEqual(late, { action: "allow" }, "a superseded review is cancelled, not completed");
    assert.equal(await harness.calls(), 0, "the retired conversation never reaches a reviewer");
    assert.doesNotMatch(late.userMessage ?? "", /previous conversation/, "a retired conversation does not spend the notice");

    // The disclosure still belongs to the incoming conversation.
    const incoming = await harness.coordinator.onReviewRequest(ups("session-incoming"), newAbortSignal().signal);
    assert.match(incoming.userMessage ?? "", /previous conversation's automatic review window closed without reviewing its latest changes/);
  } finally {
    await harness.dispose();
  }
});

test("a tool-gated pass confirmation retires the completed window without a reviewer", async () => {
  const harness = await createHarness();
  try {
    await harness.coordinator.onReviewRequest(ups("session-gated-pass"), newAbortSignal().signal);
    // One qualifying event before the first Stop, and none afterwards: the
    // observation response never passes the activity gate, so it never reaches a
    // settlement — and an activity-gated lane must still finish the review.
    harness.coordinator.noteToolActivity("session-gated-pass", { toolName: "Write", readOnly: false });
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    const passed = await harness.coordinator.onReviewRequest(stop("session-gated-pass"), newAbortSignal().signal);
    assert.equal(passed.action, "block");
    assert.equal(await harness.calls(), 1);
    assert.equal((await harness.records()).length, 2, "the open window owns its baseline and its reviewed after-checkpoint");

    const confirmation = await harness.coordinator.onReviewRequest(stop("session-gated-pass", "Confirmed, nothing else."), newAbortSignal().signal);
    assert.deepEqual(confirmation, { action: "allow" });
    assert.equal(await harness.calls(), 1, "an unchanged confirmation launches no reviewer");
    // Asserted BEFORE the next UPS: a surviving window would hand the next prompt
    // the accepted baseline, the old request's history, and a spent correction
    // budget, so a later edit gets reviewed together with the passed delta.
    assert.deepEqual(await harness.records(), [], "the completed pass releases both checkpoints");

    await harness.coordinator.onReviewRequest(ups("session-gated-pass"), newAbortSignal().signal);
    assert.equal((await harness.records()).length, 1, "the next prompt arms a fresh baseline");
    assert.deepEqual(await harness.dispose(), { unreviewedConversations: 1 });
    assert.deepEqual(await harness.records(), []);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("an unresolved window survives a tool-gated turn that reaches no settlement", async () => {
  const harness = await createHarness();
  try {
    await harness.setMode("needs_changes");
    await harness.coordinator.onReviewRequest(ups("session-gated-open"), newAbortSignal().signal);
    harness.coordinator.noteToolActivity("session-gated-open", { toolName: "Write", readOnly: false });
    await writeFile(join(harness.workspace, "index.ts"), "after\n", "utf8");
    const blocked = await harness.coordinator.onReviewRequest(stop("session-gated-open"), newAbortSignal().signal);
    assert.equal(blocked.action, "block");

    // No new qualifying activity: the correction window stays open, because its
    // reviewer feedback is still unresolved.
    const follow = await harness.coordinator.onReviewRequest(stop("session-gated-open", "I did not change anything."), newAbortSignal().signal);
    // U4: with that feedback unresolved, the skipped turn says so to the user.
    assert.deepEqual(follow, { action: "allow", userMessage: NATIVE_UNRESOLVED_FEEDBACK_NOTICE });
    assert.ok((await harness.records()).length >= 1, "an unresolved window keeps its baseline");
    assert.deepEqual((await harness.dispose()).unreviewedConversations, 1);
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("nothing a cancellation can reach is committed before the verdict is deliverable", async () => {
  // The commit-after-delivery ordering is a source-level invariant: the window
  // it protects (after the reviewer answered, while the transmission is being
  // written) cannot be hit deterministically from a fake, and getting it wrong
  // silently spends a correction the model never received.
  const source = await readText(join(process.cwd(), "src", "session-host", "native-review-coordinator.ts"));
  const start = source.indexOf("const transmit = async (");
  const end = source.indexOf("const failed = `review gate: reviewer failed");
  assert.ok(start > 0 && end > start, "the settlement's transmission helper is present");
  const body = source.slice(start, end);

  const render = body.indexOf("renderReviewTransmissionMessage(");
  const finalCheck = body.indexOf("if (signal.aborted)", render);
  const record = body.indexOf("recordReviewTransmissionPass(", finalCheck);
  // The FIRST watermark commit in the settlement body is the transmission path:
  // nothing may advance the watermark before the record proves deliverability.
  const commit = body.indexOf("conversation.mark = settledActivity");
  assert.ok(render > 0 && render < finalCheck && finalCheck < record && record < commit,
    "render, then re-check cancellation, then record, then commit the activity watermark");
  // U6: the transmission path holds the settlement's ONLY watermark commit. A
  // no-review outcome records no verdict into the window's review history, so it
  // leaves the watermark alone — that is what makes a review that recorded
  // nothing (no verdict, no change, a cancellation) retried by the next Stop with
  // no new tool call, exactly as Pi's gate measures from the last recorded review.
  assert.equal(body.indexOf("conversation.mark = settledActivity", commit + 1), -1,
    "no watermark commit anywhere but a recorded verdict");
  // Retiring the previous exchange's checkpoint yields to the event loop, so it
  // happens before the last check, never after the commit.
  assert.ok(body.indexOf("await retireUnreachableOwners(conversation);") < finalCheck,
    "the prior checkpoint retirement happens before the last cancellation check");

  // Correction bookkeeping is committed only after a deliverable transmission.
  const marker = body.indexOf("const correctionMarker = createCorrectionFeedbackMarker(");
  const correction = body.indexOf('await transmit("sent_for_correction"', marker);
  assert.ok(correction > 0, "the correction marker is built before the transmission");
  assert.ok(body.indexOf("window.correctionCycles += 1;", correction) > correction,
    "the correction cycle is counted only once the correction was delivered");
  assert.ok(body.indexOf("window.lastCorrectionFeedback = correctionMarker;", correction) > correction,
    "the feedback marker is stored only once the correction was delivered");
  assert.equal(body.includes("conversation.mark = activityCount("), false,
    "the watermark is sampled, never advanced, before delivery is proven");
});
