/**
 * Issue #222: scheduled orchestrator-turn lifecycle against a host-faithful
 * Pi event machine. The machine reproduces the installed host's delivery
 * semantics (verified against pi 0.87.x `AgentSession.sendCustomMessage` and
 * the low-level agent loop):
 *
 * - an IDLE custom send starts a new submit run directly: `before_agent_start`
 *   is NEVER emitted for it, while `agent_start` precedes `message_start` for
 *   the custom message, which precedes its model request, and exactly one
 *   `agent_settled` closes the cycle;
 * - a BUSY send queues as a follow-up drained inside the running cycle
 *   (sharing its exchange window); it also never emits before_agent_start;
 * - a human text prompt goes through `prompt()`, which emits
 *   before_agent_start and one agent_settled for the whole submit-cycle, and
 *   a send arriving while agent_settled is being emitted is deferred and then
 *   run (the `_isEmittingAgentSettled` path).
 *
 * The host-faithful tests prove: idle and busy scheduled custom turns arm the
 * fail-closed review gate BEFORE that message's model request; the
 * occurrence completes only at its own consuming run's end plus a settlement
 * (delivery and processing never count it); and a host without the required
 * message_start hook has the unsafe dispatch rejected before anything is
 * sent.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activate } from "../src/index";
import type { ScheduledOrchestratorTurnTracker } from "../src/scheduling/orchestrator-turn";
import { getSchedulerRuntime, resetSchedulerRuntimeForTests } from "../src/scheduling/runtime";
import { indexTestConfig, waitForCondition } from "./entrypoint-harness";

type HookHandler = (...args: unknown[]) => unknown;

interface MachineMessage {
  role: "user" | "custom";
  text?: string;
  customType?: string;
  content?: unknown;
  details?: Record<string, unknown>;
  display?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface ProbeRecord {
  kind: "user" | "custom";
  customType?: string;
  beforeAgentStarts: number;
  sawReviewWindow: boolean;
  requestTexts: string[];
  sidecarError?: string;
  pendingOccurrences: number;
  settledOccurrences: number;
}

/**
 * A minimal but event-faithful stand-in for the installed Pi session:
 * sendCustomMessage routing (idle → new run; busy → follow-up drained inside
 * the running cycle), the submit-cycle event order
 * (agent_start → turn_start → message_start/message_end → model request → …
 * → agent_end → agent_settled), before_agent_start only for text prompts, and
 * deferral-then-run for sends that arrive while agent_settled is being
 * emitted.
 */
class HostMachine {
  readonly hooks = new Map<string, HookHandler[]>();
  readonly sendMessageDeliveries: Array<{ customType?: string; content?: unknown; details?: Record<string, unknown>; delivery: { deliverAs?: string; triggerTurn?: boolean } }> = [];
  /** Each machine-driven run's completion promise, in send order (tests await teardown). */
  readonly sendPromises: Promise<unknown>[] = [];
  readonly beforeAgentStarts: string[] = [];
  readonly notices: string[] = [];
  readonly entries: Array<{ type: string; data: unknown }> = [];
  /** Event names the host refuses to register (simulates a host without them). */
  rejectsEvent: ReadonlySet<string> = new Set();
  private readonly dir: string;
  private readonly sessionFile: string;
  private readonly followUps: MachineMessage[] = [];
  private readonly steered: MachineMessage[] = [];
  private isStreaming = false;
  private emittingAgentSettled = false;
  private readonly deferredSettledActions: Array<() => Promise<void>> = [];
  private readonly modelPhase: (message: MachineMessage) => Promise<void> | void;

  constructor(dir: string, sessionFile: string, modelPhase: (message: MachineMessage) => Promise<void> | void) {
    this.dir = dir;
    this.sessionFile = sessionFile;
    this.modelPhase = modelPhase;
  }

  get pi() {
    const machine = this;
    return {
      on(name: string, handler: HookHandler): void {
        if (machine.rejectsEvent.has(name)) throw new Error(`host has no ${name} hook`);
        machine.hooks.set(name, [...(machine.hooks.get(name) ?? []), handler]);
      },
      notify(message: string): void {
        machine.notices.push(message);
      },
      appendEntry(type: string, data: unknown): void {
        machine.entries.push({ type, data });
      },
      // sendCustomMessage (verified against the installed host): followUp
      // queues while streaming; an idle triggerTurn send starts the run
      // directly; everything else appends without a turn.
      async sendMessage(raw: MachineMessage, delivery: { deliverAs?: string; triggerTurn?: boolean }): Promise<void> {
        if (!isRecord(raw)) throw new Error("host received a non-message send");
        const message: MachineMessage = { role: "custom", content: raw.content, display: raw.display, customType: raw.customType, details: raw.details };
        machine.sendMessageDeliveries.push({ customType: message.customType, content: message.content, details: message.details, delivery: { ...delivery } });
        if (machine.isStreaming && delivery?.triggerTurn !== false) {
          if (delivery?.deliverAs === "followUp") {
            machine.followUps.push(message);
            return;
          }
          machine.steered.push(message);
          return;
        }
        if (delivery?.triggerTurn) {
          if (machine.emittingAgentSettled) {
            machine.deferredSettledActions.push(async () => {
              await machine.submitCycle([message]);
            });
            return;
          }
          const cycle = machine.submitCycle([message]).catch((error) => {
            throw error;
          });
          machine.sendPromises.push(cycle);
          await cycle;
          return;
        }
        if (machine.isStreaming) {
          machine.followUps.push(message);
          return;
        }
        await machine.emitMessageLifecycle(message);
      },
      // sendUserMessage → AgentSession.prompt (a text prompt: full
      // before_agent_start path, queued while streaming, deferred while
      // agent_settled is being emitted).
      async sendUserMessage(text: string, options: { deliverAs?: "followUp" | "steer" } = {}): Promise<void> {
        if (machine.emittingAgentSettled) {
          machine.deferredSettledActions.push(async () => {
            await machine.prompt(text, "extension");
          });
          return;
        }
        if (machine.isStreaming) {
          if (options.deliverAs === "steer") {
            machine.steered.push({ role: "user", text });
            return;
          }
          machine.followUps.push({ role: "user", text });
          return;
        }
        const cycle = machine.prompt(text, "extension");
        machine.sendPromises.push(cycle);
        await cycle;
      },
    };
  }

  /** Register a test-side hook BEFORE activate (model-request probe seam). */
  probe(name: string, handler: HookHandler): void {
    this.hooks.set(name, [...(this.hooks.get(name) ?? []), handler]);
  }

  /** Test-visible count of queued follow-up messages (drained in-cycle). */
  get followUpCountForTest(): number {
    return this.followUps.length;
  }

  /** Public context builder (test-driving session boundaries). */
  buildCtx() {
    return {
      cwd: this.dir,
      hasUI: false,
      sessionManager: {
        getSessionId: () => "turn-lifecycle-session",
        getSessionFile: () => this.sessionFile,
        getCwd: () => this.dir,
      },
      ui: { notify: (message: string) => this.notices.push(message) },
    };
  }

  /** Fire one hook event (public for tests driving session boundaries). */
  async emit(name: string, ...args: unknown[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.hooks.get(name) ?? []) {
      results.push(await handler(...args));
    }
    return results;
  }

  /** AgentSession.prompt: input handlers, then before_agent_start, then the run. */
  /** Drive a text prompt through the host's own sendUserMessage path. */
  async sendUserMessageForTest(text: string): Promise<void> {
    await this.prompt(text, "user");
  }

  async prompt(text: string, source: "user" | "extension" = "user"): Promise<void> {
    await this.emit("input", { type: "input", cwd: this.dir, text, source }, this.buildCtx());
    this.beforeAgentStarts.push(text);
    await this.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: text, images: [], systemPrompt: "base", systemPromptOptions: { selectedTools: [] } },
      this.buildCtx(),
    );
    const cycle = this.submitCycle([{ role: "user", text }]);
    this.sendPromises.push(cycle);
    await cycle;
  }

  /**
   * One submit-cycle through the low-level run: agent_start … message events
   * with their model requests … (follow-ups drained inside the loop) …
   * agent_end, then exactly ONE agent_settled for the cycle. The host emits
   * NO before_agent_start on this path — the real gap for custom-message
   * runs (both idle runs and the busy queued drain).
   */
  async submitCycle(initial: MachineMessage[]): Promise<void> {
    this.isStreaming = true;
    try {
      await this.emit("agent_start", { type: "agent_start" }, this.buildCtx());
      await this.emit("turn_start", { type: "turn_start" }, this.buildCtx());
      const backlog: MachineMessage[] = [...initial];
      while (backlog.length > 0) {
        const message = backlog.shift()!;
        if (message.role === "user" && this.steered.length > 0) {
          // runLoop polls queued steering between turns.
          backlog.unshift(...this.steered.splice(0));
        }
        await this.emitMessageLifecycle(message);
        await this.emit("model_request_probe", {
          type: "model_request_probe",
          cwd: this.dir,
          kind: message.role,
          customType: message.customType,
        }, this.buildCtx());
        await this.runModelPhase(message);
        if (this.followUps.length > 0) {
          // The loop drains queued follow-ups before ending the run.
          backlog.push(...this.followUps.splice(0));
        }
      }
      await this.emit("agent_end", { type: "agent_end", messages: [] }, this.buildCtx());
    } finally {
      this.isStreaming = false;
      await this.emitAgentSettled();
    }
  }

  private async runModelPhase(message: MachineMessage): Promise<void> {
    await this.modelPhase(message);
  }

  private async emitMessageLifecycle(message: MachineMessage): Promise<void> {
    await this.emit("message_start", { type: "message_start", message }, this.buildCtx());
    await this.emit("message_end", { type: "message_end", message }, this.buildCtx());
  }

  private async emitAgentSettled(): Promise<void> {
    this.emittingAgentSettled = true;
    try {
      await this.emit("agent_settled", { type: "agent_settled" }, this.buildCtx());
    } finally {
      this.emittingAgentSettled = false;
    }
    const deferred = this.deferredSettledActions.splice(0);
    for (const action of deferred) await action();
  }
}

/** Read the persisted review-window state at the exact model-request boundary. */
function sidecarReviewWindow(sidecarPath: string): { window: { baseline?: unknown; requestHistory?: Array<{ text: string }> } | undefined; error?: string } {
  try {
    if (!existsSync(sidecarPath)) return { window: undefined, error: "sidecar missing" };
    const parsed = JSON.parse(readFileSync(sidecarPath, "utf8")) as { state?: { reviewWindow?: { baseline?: unknown; requestHistory?: Array<{ text: string }> } | undefined } };
    return { window: parsed.state?.reviewWindow };
  } catch (error) {
    return { window: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

const orchestratorEntry = {
  name: "Daily summary",
  cron: "* * * * *",
  enabled: true,
  kind: "execute" as const,
  destination: "orchestrator-turn" as const,
  instructions: "Summarize the current state of the scheduled turn test.",
  workspace: "",
};

function sessionsFile(dir: string): string {
  return join(dir, "sessions", "turn-lifecycle.jsonl");
}

function reviewerSuite(dir: string): { invocationMarker: string; reviewers: Record<string, unknown> } {
  const invocationMarker = join(dir, "reviewer-invocations.txt");
  return {
    invocationMarker,
    reviewers: {
      externalAgents: {
        counting: {
          adapter: "generic-cli",
          command: process.execPath,
          args: [],
          review: {
            args: [
              "-e",
              [
                `require('node:fs').appendFileSync(${JSON.stringify(invocationMarker)},'invoked\\n');`,
                "process.stdin.resume();",
                "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'scheduled turn reviewed',findings:[]})));",
              ].join(""),
            ],
            timeoutMs: 15000,
          },
        },
      },
      review: { activeReviewers: [{ source: "external", id: "counting" }] },
    },
  };
}

interface StartedSession {
  machine: HostMachine;
  tracker: ScheduledOrchestratorTurnTracker;
  sidecarPath: string;
  invocationMarker: string;
  probes: ProbeRecord[];
  advanceMinute: () => void;
  /** Stops the scheduler timers for tests that stop at a gated run. */
  stopScheduler: () => void;
  shutdownSession: () => Promise<void>;
}

/**
 * Activate the extension against the host machine with the scheduler switch
 * armed behind a controlled clock (one due tick away), and register the
 * session. The model-request probe records, at each model-request boundary,
 * whether the persisted state already carried a review window (i.e. the
 * review gate was armed BEFORE model work began) and the tracker's occurrence
 * state at that exact boundary.
 */
async function startScheduledSession(
  dir: string,
  modelPhase: (message: MachineMessage) => Promise<void> | void,
): Promise<StartedSession> {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  // The reviewer appends to this test-only marker and session-state persistence
  // rewrites its sidecar. Keep both out of the review diff so they cannot
  // themselves create a fresh change and an endless review loop.
  writeFileSync(join(dir, ".gitignore"), "reviewer-invocations.txt\nsessions/\n", "utf8");
  const configPath = join(dir, "review-gate.json");
  const { invocationMarker, reviewers } = reviewerSuite(dir);
  writeFileSync(configPath, JSON.stringify({
    ...indexTestConfig,
    scheduledTasks: { "task-turn": orchestratorEntry },
    ...reviewers,
  }), "utf8");
  process.env.PI_REVIEW_GATE_CONFIG = configPath;

  resetSchedulerRuntimeForTests();
  const schedulerRuntime = getSchedulerRuntime();
  schedulerRuntime.setEnabled(true);

  const machine = new HostMachine(dir, sessionsFile(dir), modelPhase);
  const probes: StartedSession["probes"] = [];
  let tracker!: ScheduledOrchestratorTurnTracker;
  const sidecarPath = `${sessionsFile(dir)}.pi-review-gate-state.json`;
  machine.probe("model_request_probe", (event) => {
    const info = sidecarReviewWindow(sidecarPath);
    probes.push({
      kind: isRecord(event) && event.kind === "user" ? "user" : "custom",
      customType: isRecord(event) && typeof event.customType === "string" ? event.customType : undefined,
      beforeAgentStarts: machine.beforeAgentStarts.length,
      sawReviewWindow: info.window?.baseline !== undefined,
      requestTexts: info.window?.requestHistory?.map((request) => request.text) ?? [],
      sidecarError: info.error,
      pendingOccurrences: tracker ? tracker.pendingOccurrences().length : -1,
      settledOccurrences: tracker ? tracker.settledOccurrences().length : -1,
    });
  });
  const minuteBase = Math.floor(Date.now() / 60_000) * 60_000;
  let now = minuteBase + 30_000; // mid-minute start; beginAt samples the in-progress minute
  await activate(machine.pi, {
    schedulerTimer: { now: () => now, tickIntervalMs: 5 },
    orchestratorTurnsTestAccess: (exposed) => { tracker = exposed; },
  });
  await machine.emit("session_start", { type: "session_start", reason: "startup" }, machine.buildCtx());
  return {
    machine,
    tracker,
    sidecarPath,
    invocationMarker,
    probes,
    advanceMinute: () => { now += 60_000; },
    stopScheduler: () => schedulerRuntime.setEnabled(false),
    shutdownSession: async () => {
      await machine.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, machine.buildCtx());
      schedulerRuntime.setEnabled(false);
    },
  };
}

/** Count reviewer invocations recorded in the marker file. */
function invocationCount(path: string): number {
  if (!existsSync(path)) return 0;
  return (readFileSync(path, "utf8").match(/invoked/g) ?? []).length;
}

test("an idle scheduled orchestrator turn arms review before its model request and completes only at its own turn end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-turn-host-idle-"));
  const editedPath = join(dir, "index.ts");
  writeFileSync(editedPath, "before\n", "utf8");
  try {
    const started = await startScheduledSession(dir, (message) => {
      // The "model" performs one workspace edit during the scheduled turn so
      // its review has changes to settle.
      if (typeof message.customType === "string" && message.customType.startsWith("pi-review-")) {
        writeFileSync(editedPath, "after\n", "utf8");
      }
    });
    const { machine, tracker } = started;

    // One due tick: the scheduler dispatches the orchestrator entry.
    started.advanceMinute();
    await waitForCondition(() => machine.sendMessageDeliveries.some((delivery) => delivery.customType === "pi-review-scheduled-orchestrator-turn"));
    assert.equal(machine.sendMessageDeliveries.length, 1, "the scheduler delivery rode the follow-up triggered-turn lane");
    assert.equal(machine.sendMessageDeliveries[0]!.delivery.triggerTurn, true);
    assert.equal(machine.sendMessageDeliveries[0]!.delivery.deliverAs, "followUp");
    await waitForCondition(() => tracker.pendingOccurrences().length === 1);
    const pending = tracker.pendingOccurrences()[0]!;
    assert.equal(pending.entryId, "task-turn");

    // The initiating turn's end plus its settlement complete the occurrence;
    // the machine drives the idle run inline, so wait for its cycle.
    await waitForCondition(() => invocationCount(started.invocationMarker) >= 1);
    await waitForCondition(() => tracker.settledOccurrences().length >= 1);
    const settled = tracker.settledOccurrences()[0]!;
    assert.equal(settled.entryId, "task-turn");
    assert.equal(settled.occurrenceId, pending.occurrenceId);
    assert.ok(settled.settledAt instanceof Date);
    assert.equal(tracker.pendingOccurrences().length, 0);

    // Drain every machine-driven cycle (the review transmission prompt was
    // deferred behind the settlement) before asserting aggregate paths.
    await waitForCondition(() => machine.sendPromises.length >= 2);
    await Promise.allSettled(machine.sendPromises);
    // Only the post-review transmission prompt uses before_agent_start: the
    // custom run itself bypassed it — the real-host gap this correction arms
    // on message_start instead.
    assert.equal(machine.beforeAgentStarts.length, 1, `unexpected prompt paths: ${machine.beforeAgentStarts.join(",")}`);

    // The model-request probe proves ordering: the arming was persisted
    // BEFORE the scheduled message's model request, and the occurrence was
    // observed (but NOT settled) at that exact boundary.
    const customProbes = started.probes.filter((probe) => probe.customType === "pi-review-scheduled-orchestrator-turn");
    assert.equal(customProbes.length, 1);
    assert.equal(customProbes[0]!.sawReviewWindow, true, `the review window must be armed before model work (${customProbes[0]!.sidecarError ?? "ok"})`);
    assert.ok(customProbes[0]!.requestTexts.some((request) => request.includes(orchestratorEntry.instructions)), "the reviewer must receive the scheduled request, not only its file diff");
    assert.equal(customProbes[0]!.pendingOccurrences, 1, "the occurrence was observed but still not settled at the model request");
    assert.equal(customProbes[0]!.settledOccurrences, 0, "delivery and processing never counted the occurrence");

    // The dispatcher reported truthful delivery (not uncertain) even though
    // the host's send promise only resolves after the entire idle cycle.
    assert.ok(
      machine.notices.some((notice) => notice.includes("delivered as an orchestrator turn")),
      `notices: ${machine.notices.join(" | ")}`,
    );

    // Exactly one reviewer invocation covers the scheduled turn's changes;
    // the follow-up review-transmission turn finds no new changes and runs
    // no reviewer.
    await waitForCondition(() => invocationCount(started.invocationMarker) === 1);
    assert.equal(invocationCount(started.invocationMarker), 1);

    // Drain every machine-driven cycle before teardown (the review
    // transmission prompt was deferred behind the settlement).
    await waitForCondition(() => machine.sendPromises.length >= 2);
    await Promise.allSettled(machine.sendPromises);

    await started.shutdownSession();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a busy queued scheduled turn shares the existing armed window and settles with its consuming cycle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-turn-host-busy-"));
  const editedPath = join(dir, "index.ts");
  writeFileSync(editedPath, "before\n", "utf8");
  try {
    // The human turn's model phase is gated so the scheduled dispatch lands
    // while the unrelated human cycle is streaming.
    let releaseGate!: () => void;
    const humanPhaseGate = new Promise<void>((resolvePromise) => { releaseGate = resolvePromise; });
    const started = await startScheduledSession(dir, (message) => {
      if (message.role === "user") {
        // The human turn blocks mid-cycle until the test releases it.
        const gated = humanPhaseGate.then(() => {
          writeFileSync(editedPath, "human\n", "utf8");
        });
        void gated;
        return gated;
      }
      // The scheduled queued segment's model phase edits again.
      writeFileSync(editedPath, "human+scheduled\n", "utf8");
      return;
    });
    const { machine, tracker } = started;

    // Begin the human turn: before_agent_start fires and arms the window.
    const humanCycle = machine.sendUserMessageForTest("run the human change");
    await waitForCondition(() => started.probes.some((probe) => probe.kind === "user"));

    // While the human cycle streams, its window is already armed.
    const humanProbe = started.probes[0]!;
    assert.equal(humanProbe.sawReviewWindow, true, "the human turn armed its own window through before_agent_start");
    assert.equal(tracker.pendingOccurrences().length, 0, "no scheduled occurrence is pending yet");
    assert.equal(machine.followUpCountForTest, 0, "no queued follow-up yet");
    // One due tick while busy: the queue lane, no second before_agent_start.
    started.advanceMinute();
    await waitForCondition(() => machine.sendMessageDeliveries.some((delivery) => delivery.customType === "pi-review-scheduled-orchestrator-turn"));
    assert.equal(machine.beforeAgentStarts.length, 1, "the queued scheduled turn shared the running cycle (no extra prompt path)");
    await waitForCondition(() => tracker.pendingOccurrences().length === 1);
    const queuedOccurrence = tracker.pendingOccurrences()[0]!;
    assert.equal(queuedOccurrence.processedAt, undefined, "the queued message is delivered but not yet consumed");
    assert.equal(tracker.settledOccurrences().length, 0, "delivery never counted the occurrence");
    assert.equal(machine.followUpCountForTest, 1, "the send was queued as a follow-up inside the running cycle");

    // Release the human phase: the loop drains the queued scheduled message
    // inside the SAME cycle, arms nothing new (window shared), and the
    // cycle's settlement reviews ALL of the cycle's changes.
    releaseGate();
    await humanCycle;
    const scheduledProbes = started.probes.filter((probe) => probe.customType === "pi-review-scheduled-orchestrator-turn");
    assert.equal(scheduledProbes.length, 1, "the queued scheduled message was consumed inside the running cycle");
    assert.equal(scheduledProbes[0]!.beforeAgentStarts, 1, "the scheduled drain never went through the prompt path");
    assert.equal(scheduledProbes[0]!.sawReviewWindow, true, "the shared window was already armed for the queued turn");
    assert.ok(scheduledProbes[0]!.requestTexts.some((request) => request.includes(orchestratorEntry.instructions)), "the scheduled request joins the current review exchange");
    assert.equal(scheduledProbes[0]!.pendingOccurrences, 1, "the occurrence was observed in-run");
    assert.equal(scheduledProbes[0]!.settledOccurrences, 0, "still not settled at its model request");

    // The consuming cycle's end plus its settlement complete the occurrence.
    await waitForCondition(() => tracker.settledOccurrences().length >= 1);
    assert.equal(tracker.settledOccurrences()[0]!.occurrenceId, queuedOccurrence.occurrenceId);
    assert.equal(tracker.pendingOccurrences().length, 0);
    // One review ran for the whole cycle (human + queued scheduled changes).
    await waitForCondition(() => invocationCount(started.invocationMarker) >= 1);
    assert.ok(invocationCount(started.invocationMarker) >= 1, "the consuming cycle's workspace changes reached the existing review gate");

    await started.shutdownSession();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a host without the message_start hook has the scheduled orchestrator dispatch rejected before anything is sent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-turn-host-nohooks-"));
  const originalWarn = console.warn;
  let schedulerRuntime: ReturnType<typeof getSchedulerRuntime> | undefined;
  try {
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const configPath = join(dir, "review-gate.json");
    writeFileSync(configPath, JSON.stringify({
      ...indexTestConfig,
      scheduledTasks: { "task-turn": orchestratorEntry },
      ...reviewerSuite(dir).reviewers,
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;

    resetSchedulerRuntimeForTests();
    schedulerRuntime = getSchedulerRuntime();
    schedulerRuntime.setEnabled(true);
    const machine = new HostMachine(dir, join(sessionsDir, "turn-lifecycle.jsonl"), () => undefined);
    machine.rejectsEvent = new Set(["message_start"]);
    const modelRequests: unknown[] = [];
    machine.probe("model_request_probe", (event) => { modelRequests.push(event); });
    const consoleWarnings: string[] = [];
    console.warn = (...args: unknown[]) => { consoleWarnings.push(args.map(String).join(" ")); };
    const minuteBase = Math.floor(Date.now() / 60_000) * 60_000;
    let now = minuteBase + 30_000;
    await activate(machine.pi, { schedulerTimer: { now: () => now, tickIntervalMs: 5 } });
    await machine.emit("session_start", { type: "session_start", reason: "startup" }, machine.buildCtx());

    now += 60_000;
    // No run is in progress: the unsafe-host limitation report must be
    // non-triggering rather than starting its own unreviewed custom-message run.
    await waitForCondition(() => consoleWarnings.some((warning) => warning.includes("run-lifecycle hooks")));
    assert.equal(machine.sendMessageDeliveries.length, 0, "no model-facing scheduled event was sent on a hook-less host");
    assert.equal(modelRequests.length, 0, "the limitation report itself must not begin a model request on an idle host");
    const report = consoleWarnings.find((warning) => warning.includes("run-lifecycle hooks"))!;
    assert.match(report, /could not be delivered to the existing agent/);
    assert.match(report, /NOT delivered/);

    await machine.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, machine.buildCtx());
  } finally {
    console.warn = originalWarn;
    schedulerRuntime?.setEnabled(false);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a message_start arming failure blocks tool calls and never counts an unreviewed scheduled turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-turn-host-arming-failure-"));
  const editedPath = join(dir, "index.ts");
  writeFileSync(editedPath, "before\n", "utf8");
  let host!: HostMachine;
  let blockedCalls = 0;
  try {
    const started = await startScheduledSession(dir, async (message) => {
      if (message.customType !== "pi-review-scheduled-orchestrator-turn") return;
      const results = await host.emit("tool_call", { id: "call-1", name: "Write", input: { path: editedPath } });
      if (results.some((result) => isRecord(result) && result.block === true)) blockedCalls += 1;
    });
    host = started.machine;
    // Force the checkpoint capture at message_start to fail closed after
    // activation; delivery itself remains otherwise available.
    mkdirSync(join(dir, ".pi-review-gate"), { recursive: true });
    writeFileSync(join(dir, ".pi-review-gate", "unrelated"), "not an owned checkpoint\n", "utf8");
    started.advanceMinute();
    await waitForCondition(() => host.sendMessageDeliveries.some((delivery) => delivery.customType === "pi-review-scheduled-orchestrator-turn"));
    await waitForCondition(() => blockedCalls === 1);
    await waitForCondition(() => started.tracker.pendingOccurrences().length === 1);
    assert.equal(started.tracker.pendingOccurrences()[0]!.processedAt instanceof Date, true, "the host message_start saw this occurrence");
    assert.equal(started.tracker.settledOccurrences().length, 0, "failed review arming cannot complete the occurrence");
    assert.equal(blockedCalls, 1, "every model tool call is stopped before execution after the arming failure");
    assert.equal(readFileSync(editedPath, "utf8"), "before\n", "no unreviewed workspace change escaped the gate");
    assert.equal(invocationCount(started.invocationMarker), 0, "no reviewer pass is fabricated without a baseline");
    await started.shutdownSession();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a queued scheduled turn that never runs is cleared by the session boundary and never counted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-turn-host-reset-"));
  try {
    // The human turn's model phase never completes in this test: the
    // scheduled delivery is queued but the cycle never drains it.
    const neverGates = new Promise<never>(() => {});
    const started = await startScheduledSession(dir, () => neverGates);
    const { machine, tracker } = started;

    // Never awaited: the model phase never completes in this test.
    void machine.sendUserMessageForTest("start work then never finish");
    await waitForCondition(() => started.probes.some((probe) => probe.kind === "user"));
    started.advanceMinute();
    await waitForCondition(() => machine.sendMessageDeliveries.some((delivery) => delivery.customType === "pi-review-scheduled-orchestrator-turn"));
    await waitForCondition(() => tracker.pendingOccurrences().length === 1);

    // Session boundary: correlation is cleared, the queued message was never
    // processed, and nothing can ever claim it ran.
    await started.shutdownSession();
    assert.equal(tracker.pendingOccurrences().length, 0, "the session boundary dropped the uncorrelated occurrence");
    assert.equal(tracker.settledOccurrences().length, 0, "no run in this session completed it");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});