/**
 * Issue #452 real-host proof: an eligible background-shell notification that
 * the gate sends while the owning session is BUSY must reach the RUNNING turn
 * at its next supported boundary (delivery mode "steer") instead of waiting
 * for the natural stop (the old "followUp" lane). A wake drained only at the
 * stop boundary arrives after the run is already over, which is exactly the
 * deferral #452 reports.
 *
 * These tests drive a REAL `pi --mode rpc` session with the compiled candidate
 * extension and the scripted faux model from the existing background-shell
 * fixture (tests/pi-native-bgshell-wake-fixture.ts +
 * tests/fixtures/pi-native-bgshell-probe.cjs). The probe journals every
 * session event and every model request, so delivery is proven from the owning
 * session itself — never from the send options the extension merely chose:
 *
 * - an injected wake appears as a `message_start`/`message_end` event with
 *   customType `pi-review-bg-shell` and the wake display
 *   (`background job … — exited N`), so its INJECTION point is explicit;
 * - the assistant message immediately before that injection point classifies
 *   the boundary: a tool-call message means the wake was injected into the
 *   still-running turn at its next supported boundary (pre-natural-stop
 *   steering), while stop text means it was drained behind the natural stop.
 *
 * Classifying the injection point (not "any model request whose transcript
 * still contains the wake") matters: after injection, the wake stays in the
 * transcript tail of later requests of the same run, which would otherwise
 * look like fresh pre-stop delivery.
 *
 * Scenarios:
 * - busy exit wake: the wake must be injected at a tool-call boundary of the
 *   running turn while an unrelated long foreground command is still part of
 *   that run, and that command must finish normally (steering never aborts
 *   in-flight work);
 * - idle exit wake: the same completion must still resume an idle session with
 *   an ordinary triggered run;
 * - routine match wake fired while busy: the wake must be INJECTED into the
 *   still-running turn at its next supported boundary, exactly like the exit
 *   wake — a pre-send hold that waits for settlement fails this test (it is
 *   the negative control the unmodified base violates).
 *
 * Skips when no installed Pi 1.x host or compiled candidate is available
 * (hard-fails under PI_REVIEW_GATE_REQUIRE_PI_HOST=1), matching the existing
 * real-host convention.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import {
  createBgShellWakeFixture,
  type BgShellWakeFixture,
} from "./pi-native-bgshell-wake-fixture";
import { skipOrFail } from "./bridge-fakes";

const WAKE_WAIT_MS = 60_000;
const RUN_SETTLE_WAIT_MS = 45_000;
const SETTLE_WAIT_MS = 75_000;
const WAKE_CUSTOM_TYPE = "pi-review-bg-shell";

interface SteerJournalMessage {
  role?: string;
  customType?: string;
  preview?: string;
}

interface SteerJournalEntry {
  ts: number;
  journalIndex?: number;
  event: string;
  requestIndex?: number;
  transcriptTail?: SteerJournalMessage[];
  preview?: string;
  role?: string;
  customType?: string;
}

function candidateEntry(): string | null {
  const fromEnv = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY;
  if (fromEnv) return resolvePath(fromEnv);
  return existsSync(resolvePath(process.cwd(), join("dist", "src", "index.js")))
    ? resolvePath(process.cwd(), join("dist", "src", "index.js"))
    : null;
}

/** Fixture scratch defaults outside the repository; callers may point it at an
 *  owned private tree. */
function scratchParent(): string | undefined {
  const fromEnv = process.env.PI_REVIEW_GATE_SCRATCH_PARENT;
  return fromEnv ? resolvePath(fromEnv) : undefined;
}

/** Verify the real-host prerequisites. Returns false only when the test was
 *  skipped — callers must return immediately and never construct a fixture
 *  after a skip (t.skip does not stop an async test body). */
function checkPrerequisites(t: { skip(message?: string): void }): boolean {
  if (!candidateEntry()) {
    skipOrFail(t, "no compiled candidate extension (build with npm run build) and no PI_REVIEW_GATE_CANDIDATE_ENTRY");
    return false;
  }
  try {
    createBgShellWakeFixture({ candidateEntry: null });
  } catch (error) {
    skipOrFail(t, error instanceof Error ? error.message : String(error));
    return false;
  }
  return true;
}

function journalOf(fixture: BgShellWakeFixture): SteerJournalEntry[] {
  return fixture.journal().map((entry, journalIndex) => ({ ...entry, journalIndex })) as unknown as SteerJournalEntry[];
}

/** First injected background-shell wake whose text matches the pattern. */
function injectionIndex(journal: SteerJournalEntry[], pattern: RegExp): number {
  return journal.findIndex((entry) =>
    entry.event === "message_start"
    && entry.customType === WAKE_CUSTOM_TYPE
    && pattern.test(String(entry.preview ?? "")));
}

function injectionCount(journal: SteerJournalEntry[], pattern: RegExp): number {
  return journal.filter((entry) =>
    entry.event === "message_start"
    && entry.customType === WAKE_CUSTOM_TYPE
    && pattern.test(String(entry.preview ?? ""))).length;
}

/** The assistant message immediately preceding an event classifies the
 *  boundary it was injected at. Append order is authoritative: adjacent
 *  events can share a millisecond. */
function assistantBefore(journal: SteerJournalEntry[], index: number): SteerJournalEntry | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const entry = journal[cursor]!;
    if (entry.event === "message_end" && entry.role === "assistant") return entry;
  }
  return undefined;
}

function injectedAtToolBoundary(journal: SteerJournalEntry[], index: number): boolean {
  return /toolCall:/.test(String(assistantBefore(journal, index)?.preview ?? ""));
}

function firstSettledIndex(journal: SteerJournalEntry[]): number {
  return journal.findIndex((entry) => entry.event === "agent_settled");
}

function firstSettledAt(fixture: BgShellWakeFixture): number | undefined {
  return journalOf(fixture).find((entry) => entry.event === "agent_settled")?.ts;
}

/** A model request's transcript carried a tool result with this marker. */
function toolResultSeen(fixture: BgShellWakeFixture, marker: string): boolean {
  return fixture.modelRequests().some((request) =>
    (request.transcriptTail ?? []).some((message) =>
      message.role === "toolResult" && String(message.preview ?? "").includes(marker)));
}

function journalDump(fixture: BgShellWakeFixture): string {
  return JSON.stringify(fixture.modelRequests().map((request) => ({
    index: request.requestIndex,
    tail: (request.transcriptTail ?? []).map((message) =>
      `${message.role}${message.customType ? `:${message.customType}` : ""}:${String(message.preview ?? "").slice(0, 90)}`),
  })), null, "\t");
}

/** Text-only continuation: once the wake under test has been observed, further
 *  (wake-driven) runs stay harmless instead of replaying a stale tool step. */
const TEXT_ONLY_STEPS: Array<Record<string, unknown>> = Array.from(
  { length: 8 },
  (_, index) => ({ text: `ack-after-wake-${index}` }),
);

function fixtureWith(candidate: string): BgShellWakeFixture {
  return createBgShellWakeFixture({ candidateEntry: candidate, scratchParent: scratchParent() });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exact process-group ids of every background job THIS fixture started, taken
 *  from its own journal — never a process-table scan. */
function ownedJobPids(fixture: BgShellWakeFixture): number[] {
  const pids = new Set<number>();
  for (const entry of fixture.journal()) {
    if (entry.event !== "message_end") continue;
    for (const match of String(entry.preview ?? "").matchAll(/Started "[^"]*" as job\d+ \(pid (\d+)\)/g)) {
      pids.add(Number(match[1]));
    }
  }
  return [...pids];
}

/** True only when every owned job's process group is gone. */
function ownedGroupsAbsent(pids: number[]): boolean {
  for (const pid of pids) {
    if (process.platform === "win32") return false; // No Job Object proof on this RPC fixture.
    try {
      process.kill(-pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
    }
  }
  return true;
}

/** Append-order quiescence: the newest settlement follows the newest run start.
 *  Counting start/settled events is invalid — several start/end cycles can
 *  share one final settlement. */
function sessionRunsSettled(fixture: BgShellWakeFixture): boolean {
  const events = fixture.journal().map((entry) => entry.event);
  const lastStart = events.lastIndexOf("agent_start");
  const lastSettled = events.lastIndexOf("agent_settled");
  return lastStart < 0 || lastSettled > lastStart;
}

/** Let every command this fixture started finish normally and confirm the
 *  session is idle. Nothing is terminated or deleted until this reports
 *  settled. */
async function settleOwnedWork(fixture: BgShellWakeFixture): Promise<{ settled: boolean; detail: string }> {
  if (fixture.journal().length === 0) {
    return { settled: true, detail: "no session activity (startup never produced a run)" };
  }
  await fixture.setTurnScript(TEXT_ONLY_STEPS);
  const deadline = Date.now() + SETTLE_WAIT_MS;
  let detail = "settlement window exhausted";
  while (Date.now() < deadline) {
    const pids = ownedJobPids(fixture);
    let streaming: boolean | undefined;
    try {
      const state = (await fixture.rpc("get_state")) as { isStreaming?: boolean };
      streaming = state?.isStreaming;
    } catch (error) {
      return { settled: false, detail: `get_state failed: ${error instanceof Error ? error.message : String(error)}` };
    }
    const groupsAbsent = ownedGroupsAbsent(pids);
    const runsSettled = sessionRunsSettled(fixture);
    if (streaming === false && runsSettled && groupsAbsent) {
      return {
        settled: true,
        detail: `idle session; last settlement after last start; ${pids.length} owned group(s) gone`,
      };
    }
    detail = `streaming=${String(streaming)} runsSettled=${runsSettled} ownedGroupsAbsent=${groupsAbsent} ownedGroups=${pids.length}`;
    await delay(150);
  }
  return { settled: false, detail };
}

/** Disposal contract: never invoke the destructive disposer while a command
 *  this fixture started is still running or a run is still active. Uncertain
 *  resources are retained (live session and scratch) and reported instead of
 *  being killed or deleted. */
async function disposeAfterSettlement(
  fixture: BgShellWakeFixture,
  t: { diagnostic(message: string): void },
): Promise<void> {
  const outcome = await settleOwnedWork(fixture);
  if (!outcome.settled) {
    t.diagnostic(`owned commands did not settle (${outcome.detail}); retained the live Pi session and scratch at ${fixture.paths.scratch} without terminating anything`);
    throw new Error(`test cleanup refused to terminate owned work: ${outcome.detail}; retained ${fixture.paths.scratch}`);
  }
  await fixture.dispose();
}

/** Assert the exit wake was injected into the running turn at a tool-call
 *  boundary (i.e. steered, not drained behind the natural stop). */
async function assertBusySteering(fixture: BgShellWakeFixture, label: string, marker: string): Promise<void> {
  const exitWake = new RegExp(`background job "${label}" \\(job\\d+\\) — exited 0`);
  const delivered = await fixture.waitFor(() => injectionIndex(journalOf(fixture), exitWake) >= 0, WAKE_WAIT_MS);
  // The wake is known to have been injected; rewrite the script first so any
  // replayed tool step cannot cascade into new jobs, then wait for the run's
  // own settlement before classifying the injection boundary.
  await fixture.setTurnScript(TEXT_ONLY_STEPS);
  assert.equal(
    await fixture.waitFor(() => firstSettledAt(fixture) !== undefined, RUN_SETTLE_WAIT_MS),
    true,
    `the busy run never settled; stderr:\n${fixture.stderr}`,
  );
  const journal = journalOf(fixture);
  const injectedAt = injectionIndex(journal, exitWake);
  assert.equal(
    delivered && injectedAt >= 0,
    true,
    `the exit wake was never injected into the owning session (no polling in the script); requests:\n`
      + `${journalDump(fixture)}\nstderr:\n${fixture.stderr}`,
  );
  const settleIndex = firstSettledIndex(journal);
  assert.ok(
    settleIndex >= 0 && injectedAt < settleIndex,
    "the exit wake injection must precede the run's first settlement in append order",
  );
  const boundary = String(assistantBefore(journal, injectedAt)?.preview ?? "");
  assert.equal(
    injectedAtToolBoundary(journal, injectedAt),
    true,
    `the exit wake was drained behind the natural stop, not steered into the still-running turn: `
      + `injected after assistant message "${boundary.slice(0, 120)}". A "steer" delivery is injected at a tool-call `
      + `boundary of the active run; a "followUp" delivery is drained only after the run's stop text.\nstderr:\n${fixture.stderr}`,
  );
  // Steering never aborts in-flight work: the long foreground command of the
  // same run finished and its result reached a later model request.
  assert.equal(toolResultSeen(fixture, marker), true, `the long foreground command (${marker}) was aborted or never reported`);
}

test("busy run: a background-shell exit wake steers before natural stop; in-flight commands finish (#452)", { timeout: 180_000 }, async (t) => {
  const candidate = checkPrerequisites(t) ? candidateEntry() : null;
  if (!candidate) return;
  const fixture = fixtureWith(candidate);
  t.after(() => disposeAfterSettlement(fixture, t));
  await fixture.start([
    {
      toolCalls: [
        {
          toolName: "ShellStart",
          arguments: {
            command: "sleep 3.5 && echo STEER-EXIT-DONE",
            label: "steer-exit",
            wake_on: { exit: true },
          },
        },
        { toolName: "bash", arguments: { command: "sleep 6; echo STEER-BUSY-LONG-DONE" } },
      ],
    },
    { text: "steer-busy-natural-stop" },
  ]);
  const response = (await fixture.prompt("start the busy exit scenario")) as { disposition?: string };
  assert.equal(response?.disposition, "started", `prompt did not start a run: ${JSON.stringify(response)}`);

  await assertBusySteering(fixture, "steer-exit", "STEER-BUSY-LONG-DONE");
  t.diagnostic("exit wake was injected at a tool-call boundary of the still-running turn (steered pre-stop)");
  const outcome = await settleOwnedWork(fixture);
  assert.equal(outcome.settled, true, `owned work did not settle: ${outcome.detail}; stderr:\n${fixture.stderr}`);
  t.diagnostic(`cleanup gate: ${outcome.detail}`);
});

test("idle: a background-shell exit wake still resumes the session after a completed run (#452)", { timeout: 180_000 }, async (t) => {
  const candidate = checkPrerequisites(t) ? candidateEntry() : null;
  if (!candidate) return;
  const fixture = fixtureWith(candidate);
  t.after(() => disposeAfterSettlement(fixture, t));
  await fixture.start([
    {
      toolCalls: [{
        toolName: "ShellStart",
        arguments: { command: "sleep 6 && echo IDLE-STEER-DONE", label: "idle-steer", wake_on: { exit: true } },
      }],
    },
    { text: "idle-first-run-stop" },
  ]);
  const response = (await fixture.prompt("start the idle scenario")) as { disposition?: string };
  assert.equal(response?.disposition, "started", `prompt did not start a run: ${JSON.stringify(response)}`);

  assert.equal(
    await fixture.waitFor(() => firstSettledAt(fixture) !== undefined, RUN_SETTLE_WAIT_MS),
    true,
    `the initial run never settled; stderr:\n${fixture.stderr}`,
  );
  const settledAt = firstSettledAt(fixture)!;
  await fixture.setTurnScript(TEXT_ONLY_STEPS);

  const idleWake = /background job "idle-steer" \(job\d+\) — exited 0/;
  const delivered = await fixture.waitFor(() => {
    const journal = journalOf(fixture);
    const injectedAt = injectionIndex(journal, idleWake);
    return injectedAt >= 0 && journal[injectedAt]!.ts > settledAt;
  }, WAKE_WAIT_MS);
  assert.equal(delivered, true, `the idle exit wake never resumed the session; requests:\n${journalDump(fixture)}\nstderr:\n${fixture.stderr}`);

  const journal = journalOf(fixture);
  const injectedAt = injectionIndex(journal, idleWake);
  assert.ok(
    /IDLE-STEER-DONE/.test(String(journal[injectedAt]!.preview ?? "")),
    "the idle wake must carry the job's own completion output",
  );
  assert.equal(
    injectedAtToolBoundary(journal, injectedAt),
    false,
    "an idle wake resumes a fresh run; it must not look like busy pre-stop steering",
  );
  assert.ok(
    journal.some((entry) => entry.event === "agent_start" && entry.ts > settledAt),
    "the idle exit wake must start a normal run",
  );
  const outcome = await settleOwnedWork(fixture);
  assert.equal(outcome.settled, true, `owned work did not settle: ${outcome.detail}; stderr:\n${fixture.stderr}`);
  t.diagnostic(`cleanup gate: ${outcome.detail}`);
});

test("routine match wake fired while busy steers pre-settlement (no busy hold) (#452)", { timeout: 180_000 }, async (t) => {
  const candidate = checkPrerequisites(t) ? candidateEntry() : null;
  if (!candidate) return;
  const fixture = fixtureWith(candidate);
  t.after(() => disposeAfterSettlement(fixture, t));
  // The match job outlives the busy turn; a wake deferred to settlement would
  // still be current, so a settlement-only implementation cannot pass by
  // accident.
  await fixture.start([
    {
      toolCalls: [
        {
          toolName: "ShellStart",
          arguments: {
            command: "echo MATCH-BOOT; sleep 1; echo STEER-MATCH-ONE; sleep 8",
            label: "steer-match",
            wake_on: { exit: true, match: ["STEER-MATCH-ONE"] },
          },
        },
        { toolName: "bash", arguments: { command: "sleep 6; echo MATCH-BUSY-LONG-DONE" } },
      ],
    },
    { text: "match-busy-natural-stop" },
  ]);
  const response = (await fixture.prompt("start the routine match scenario")) as { disposition?: string };
  assert.equal(response?.disposition, "started", `prompt did not start a run: ${JSON.stringify(response)}`);

  // The routine line matches while the run is still busy; make every later
  // model request text-only so the wake-driven continuation is harmless.
  await delay(2_200);
  await fixture.setTurnScript(TEXT_ONLY_STEPS);

  const matchWake = /matched "STEER-MATCH-ONE"/;
  const delivered = await fixture.waitFor(() => injectionIndex(journalOf(fixture), matchWake) >= 0, WAKE_WAIT_MS);
  assert.equal(
    delivered,
    true,
    `the routine match wake was never injected; requests:\n${journalDump(fixture)}\nstderr:\n${fixture.stderr}`,
  );
  // Classify only after the busy run's own settlement exists, so "before the
  // natural stop" is proven by append order at the injection point itself
  // (never by scanning later transcript tails or comparing timestamps).
  assert.equal(
    await fixture.waitFor(() => firstSettledAt(fixture) !== undefined, RUN_SETTLE_WAIT_MS),
    true,
    `the busy run never settled; stderr:\n${fixture.stderr}`,
  );
  const journal = journalOf(fixture);
  const injectedAt = injectionIndex(journal, matchWake);
  const settleIndex = firstSettledIndex(journal);
  assert.ok(
    settleIndex >= 0 && injectedAt < settleIndex,
    "the routine match wake was injected only at/after the run's settlement (a pre-send hold deferred it)",
  );
  assert.equal(
    injectedAtToolBoundary(journal, injectedAt),
    true,
    `the routine match wake was drained behind the natural stop, not steered into the still-running turn: `
      + `injected after assistant message "${String(assistantBefore(journal, injectedAt)?.preview ?? "").slice(0, 120)}"`
      + `\nstderr:\n${fixture.stderr}`,
  );
  // Steering never aborts in-flight work: the long foreground command of the
  // same run finished and its result reached a later model request.
  assert.equal(toolResultSeen(fixture, "MATCH-BUSY-LONG-DONE"), true, "the long foreground command was aborted or never reported");

  // Let the match job exit on its own — and any wake-driven run settle — before
  // evaluating duplicates: a late duplicate could only appear in that drain.
  const outcome = await settleOwnedWork(fixture);
  assert.equal(outcome.settled, true, `owned work did not settle: ${outcome.detail}; stderr:\n${fixture.stderr}`);
  t.diagnostic(`cleanup gate: ${outcome.detail}`);

  // Exactly one routine match wake for the single matching line.
  assert.equal(injectionCount(journalOf(fixture), matchWake), 1, "the routine match wake must be delivered exactly once");
});
