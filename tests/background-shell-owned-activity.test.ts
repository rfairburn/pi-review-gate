/**
 * Focused synthetic regression for background-shell owned-work telemetry
 * settlement (src/background-shell/index.ts).
 *
 * The pure decision seam is exercised directly: no process, shell, PTY, timer,
 * or IO is touched. It encodes that a bare ChildProcess 'error' is not proof of
 * exit, while an actual close (or the verified Windows ownership verdict) is.
 * A later real close after an error is judged by the same settled signal, so it
 * still releases even though the ordinary job record was already settled.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { __test as backgroundShellTest } from "../src/background-shell";
import {
  activateOwnedActivity,
  activeActivitySnapshot,
  ownedActivitySnapshot,
  subscribeOwnedActivity,
} from "../src/session-host/owned-activity";

/** Minimal synthetic job backed by a fake ChildProcess: no process, timer, or IO. */
function fakeShellJob(id: string, pid: number): { job: never; proc: EventEmitter & { pid: number } } {
  const proc = new EventEmitter() as EventEmitter & { pid: number };
  proc.pid = pid;
  const job = {
    id,
    proc,
    ownership: undefined,
    exited: false,
    // No exit wake: settleJob's wake path is never exercised by this seam.
    rules: { exit: false, match: [] },
    pending: { flush: () => "" },
    buffer: [],
    matchers: { match: () => null },
    wake: { matchCount: 0, lastWakeAt: 0, stallNotified: false },
    startedAt: Date.now(),
    label: id,
  };
  return { job: job as never, proc };
}

describe("background-shell owned-activity settlement decision", () => {
  it("holds ownership through a bare error and releases only on a confirmed exit", () => {
    const { shellCompletionAction } = backgroundShellTest;

    assert.equal(
      shellCompletionAction({ confirmedExit: false, verdict: undefined }),
      "retain",
      "an error alone is not proof the owned process exited",
    );
    assert.equal(
      shellCompletionAction({ confirmedExit: true, verdict: undefined }),
      "release",
      "an actual close independently settles the owned process",
    );
    // The later-close-after-error case uses the same decision: confirmedExit is
    // true even though the ordinary record was already settled by the error.
    assert.equal(
      shellCompletionAction({ confirmedExit: true, verdict: undefined }),
      "release",
    );
  });

  it("waits for verified Windows ownership before releasing", () => {
    const { shellCompletionAction } = backgroundShellTest;

    assert.equal(
      shellCompletionAction({ confirmedExit: true, verdict: "clear" }),
      "release",
    );
    assert.equal(
      shellCompletionAction({ confirmedExit: true, verdict: "running" }),
      "retain",
      "owned descendants may still be alive after the shell root closed",
    );
    assert.equal(
      shellCompletionAction({ confirmedExit: true, verdict: "unverifiable" }),
      "retain",
      "unverified ownership after an error stays positive rather than zero",
    );
  });
});

describe("background-shell activity-intent decision", () => {
  it("maps each completion observation to active/stopped/unknown independently of ownership", () => {
    const { shellIntentAction } = backgroundShellTest;
    assert.equal(
      shellIntentAction({ confirmedExit: false, verdict: undefined }),
      "active",
      "a bare error before close leaves the process work running",
    );
    assert.equal(
      shellIntentAction({ confirmedExit: true, verdict: undefined }),
      "stopped",
      "an actual close positively stops the work",
    );
    assert.equal(shellIntentAction({ confirmedExit: true, verdict: "clear" }), "stopped");
    assert.equal(
      shellIntentAction({ confirmedExit: false, verdict: "clear" }),
      "stopped",
      "a verified-empty job tree is not running even before the close lands",
    );
    assert.equal(
      shellIntentAction({ confirmedExit: true, verdict: "running" }),
      "active",
      "known live owned descendants stay active after the root exits",
    );
    assert.equal(
      shellIntentAction({ confirmedExit: true, verdict: "unverifiable" }),
      "unknown",
      "unproven liveness is unknown, never a fabricated positive or zero",
    );
  });

  it("publishes real shell observations through the registered source, independently of ownership", () => {
    activateOwnedActivity();
    const handle = backgroundShellTest.shellActivityHandle();
    assert.ok(handle, "the module registers its shell source at import");
    // The import-time registration is replayed uncertain: resolve both channels
    // so the activity baseline is positively known.
    handle.resolveUncertainty();
    handle.resolveIntentUncertainty();
    assert.equal(activeActivitySnapshot().activeShells, 0);

    // Spawn/start: the real callback pair acquires ownership AND activity.
    handle.acquire("job-active");
    backgroundShellTest.observeShellIntentForTests("job-active", "active");
    assert.equal(activeActivitySnapshot().activeShells, 1);
    assert.equal(ownedActivitySnapshot().backgroundShells, 1);

    // A confirmed stop releases activity while a retained ownership obligation
    // stays positive: the display number is not the cleanup gate.
    handle.acquire("job-retained");
    backgroundShellTest.observeShellIntentForTests("job-active", "stopped");
    handle.release("job-active");
    assert.equal(activeActivitySnapshot().activeShells, 0, "a confirmed stop releases activity");
    assert.equal(ownedActivitySnapshot().backgroundShells, 1, "the retained ownership token is untouched");

    // Unverifiable Windows ownership is genuinely unknown, never positive.
    backgroundShellTest.observeShellIntentForTests("job-unknown", "active");
    assert.equal(activeActivitySnapshot().activeShells, 1);
    backgroundShellTest.observeShellIntentForTests("job-unknown", "unknown");
    assert.equal(activeActivitySnapshot().activeShells, null, "unverifiable ownership is unknown");
    backgroundShellTest.observeShellIntentForTests("job-unknown", "stopped");
    assert.equal(activeActivitySnapshot().activeShells, 0, "a later verified stop settles the unknown to zero");

    handle.release("job-retained");
    assert.equal(ownedActivitySnapshot().backgroundShells, 0);
  });

  it("releases activity on the real exit callback before the delayed close settles ownership", () => {
    activateOwnedActivity();
    const handle = backgroundShellTest.shellActivityHandle();
    assert.ok(handle);
    handle.resolveUncertainty();
    handle.resolveIntentUncertainty();
    const baseActive = activeActivitySnapshot().activeShells;
    const baseOwned = ownedActivitySnapshot().backgroundShells;

    const { job, proc } = fakeShellJob("job-exit", 909_001);
    backgroundShellTest.attachStreamsForTests({} as never, job);
    // The real spawn/close pair uses the module's prefixed ownership token.
    handle.acquire(backgroundShellTest.ownedActivityTokenForTests("job-exit"));
    backgroundShellTest.observeShellIntentForTests("job-exit", "active");
    assert.equal(activeActivitySnapshot().activeShells, (baseActive ?? 0) + 1);
    assert.equal(ownedActivitySnapshot().backgroundShells, (baseOwned ?? 0) + 1);

    // The root's own exit fires before the stream close: activity must drop now,
    // while ownership still waits for the confirmed close.
    proc.emit("exit", 0, null);
    assert.equal(activeActivitySnapshot().activeShells, baseActive,
      "root exit releases the running indicator before a delayed close");
    assert.equal(ownedActivitySnapshot().backgroundShells, (baseOwned ?? 0) + 1,
      "ownership is untouched by the exit-only observation");

    // Ownership is still the only thing the close settles; clean it up so later
    // cases in this file start from the same baseline.
    proc.emit("close", 0, null);
    assert.equal(ownedActivitySnapshot().backgroundShells, baseOwned);
  });

  it("keeps activity positive through a bare error and releases it on the confirmed close", () => {
    activateOwnedActivity();
    const handle = backgroundShellTest.shellActivityHandle();
    assert.ok(handle);
    handle.resolveUncertainty();
    handle.resolveIntentUncertainty();
    const baseActive = activeActivitySnapshot().activeShells;
    const baseOwned = ownedActivitySnapshot().backgroundShells;

    const { job, proc } = fakeShellJob("job-error", 909_002);
    backgroundShellTest.attachStreamsForTests({} as never, job);
    handle.acquire(backgroundShellTest.ownedActivityTokenForTests("job-error"));
    backgroundShellTest.observeShellIntentForTests("job-error", "active");

    proc.emit("error", new Error("spawn failed"));
    assert.equal(activeActivitySnapshot().activeShells, (baseActive ?? 0) + 1,
      "a bare error is not proof of exit: the process work stays active");
    assert.equal(ownedActivitySnapshot().backgroundShells, (baseOwned ?? 0) + 1,
      "ownership is retained across the bare error");

    proc.emit("exit", -1, null);
    proc.emit("close", 0, null);
    assert.equal(activeActivitySnapshot().activeShells, baseActive,
      "the confirmed close releases activity");
    assert.equal(ownedActivitySnapshot().backgroundShells, baseOwned,
      "ownership settles on the confirmed close");
  });

  it("never publishes a fabricated zero across active→unknown and unknown→active transitions", () => {
    activateOwnedActivity();
    const handle = backgroundShellTest.shellActivityHandle();
    assert.ok(handle);
    handle.resolveUncertainty();
    handle.resolveIntentUncertainty();
    assert.equal(activeActivitySnapshot().activeShells, 0);

    // active -> unknown: uncertainty is marked BEFORE the token is dropped, so a
    // synchronous reporter subscriber must observe only unknown, never a zero.
    backgroundShellTest.observeShellIntentForTests("job-trace-a", "active");
    assert.equal(activeActivitySnapshot().activeShells, 1);
    const toUnknown: Array<number | null> = [];
    const unsubscribeUnknown = subscribeOwnedActivity(() => {
      toUnknown.push(activeActivitySnapshot().activeShells);
    });
    backgroundShellTest.observeShellIntentForTests("job-trace-a", "unknown");
    unsubscribeUnknown();
    assert.ok(toUnknown.length > 0, "the unknown observation published at least one frame");
    assert.ok(toUnknown.every((value) => value === null),
      `active→unknown must only ever publish unknown: ${JSON.stringify(toUnknown)}`);
    assert.equal(activeActivitySnapshot().activeShells, null);

    // Settle back to a known stopped state before the next trace.
    backgroundShellTest.observeShellIntentForTests("job-trace-a", "stopped");
    assert.equal(activeActivitySnapshot().activeShells, 0);

    // unknown -> active: the positive token is acquired BEFORE uncertainty is
    // resolved, so a synchronous reporter subscriber must never see null -> 0.
    backgroundShellTest.observeShellIntentForTests("job-trace-b", "unknown");
    assert.equal(activeActivitySnapshot().activeShells, null);
    const toActive: Array<number | null> = [];
    const unsubscribeActive = subscribeOwnedActivity(() => {
      toActive.push(activeActivitySnapshot().activeShells);
    });
    backgroundShellTest.observeShellIntentForTests("job-trace-b", "active");
    unsubscribeActive();
    assert.ok(toActive.length > 0, "the active observation published at least one frame");
    assert.ok(toActive.every((value) => value !== 0),
      `unknown→active must never publish a fabricated zero: ${JSON.stringify(toActive)}`);
    assert.equal(activeActivitySnapshot().activeShells, 1);

    backgroundShellTest.observeShellIntentForTests("job-trace-b", "stopped");
    assert.equal(activeActivitySnapshot().activeShells, 0);
  });
});
