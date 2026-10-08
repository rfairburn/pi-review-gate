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
import { describe, it } from "node:test";
import { __test as backgroundShellTest } from "../src/background-shell";

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
