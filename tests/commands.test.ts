import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkspaceSnapshot } from "../src/capture";
import { formatReviewerAnswer, registerCommands } from "../src/commands";
import type { ReviewGateConfig } from "../src/config";
import { createState, getReviewerQuestionWindow, recordReviewerFeedback, rememberUserRequest } from "../src/state";
import { createReviewCancellationCoordinator } from "../src/review-cancellation";
import { fakeNeedsChangesConfig } from "./helpers";

test("reviewer command output shows internal model labels instead of encoded reviewer ids", async () => {
  const reviewerId = "pi-b2xsYW1hL2RlZXBzZWVrLXY0LWZsYXNoOjA3MzEtY2xvdWQ";
  const displayLabel = "ollama/deepseek-v4-flash:0731-cloud";
  const answer = formatReviewerAnswer("is this safe?", [{
    reviewerId,
    verdict: "pass",
    summary: "Looks safe.",
    findings: [],
  }], { [reviewerId]: displayLabel });

  assert.match(answer, /## ollama\/deepseek-v4-flash:0731-cloud — pass/);
  assert.doesNotMatch(answer, /pi-b2xsYW1hL2RlZXBzZWVrLXY0LWZsYXNoOjA3MzEtY2xvdWQ/);

  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const notices: string[] = [];
  registerCommands({
    pi: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
    },
    cwd: () => process.cwd(),
    config: {
      ...fakeNeedsChangesConfig(),
      decider: {
        id: reviewerId,
        adapter: "pi-model",
        model: displayLabel,
        timeoutMs: 15000,
      },
    },
    state: createState(),
  });
  await commands.get("review-gate-ping")?.("", { notify(message: string) { notices.push(message); } });

  assert.match(notices[0] ?? "", /reviewers=ollama\/deepseek-v4-flash:0731-cloud/);
  assert.doesNotMatch(notices[0] ?? "", /pi-b2xsYW1hL2RlZXBzZWVrLXY0LWZsYXNoOjA3MzEtY2xvdWQ/);
});

test("/review-pause and /review-unpause gate explicit reviewer commands", async () => {
  const state = createState();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const notices: string[] = [];
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
      commands.set(name, options.handler);
    },
  };
  const ctx = {
    notify(message: string) {
      notices.push(message);
    },
  };

  registerCommands({
    pi,
    cwd: () => process.cwd(),
    config: reviewConfig(),
    state,
  });

  await commands.get("review-pause")?.("", ctx);
  assert.equal(state.reviewsPaused, true);
  assert.match(notices.at(-1) ?? "", /reviews paused; turn evidence will still be collected/);

  await commands.get("review-now")?.("", ctx);
  assert.match(notices.at(-1) ?? "", /use \/review-unpause before \/review-now/);

  await commands.get("ask-reviewer")?.("is this safe?", ctx);
  assert.match(notices.at(-1) ?? "", /use \/review-unpause before \/ask-reviewer/);

  await commands.get("review-unpause")?.("", ctx);
  assert.equal(state.reviewsPaused, false);
  assert.match(notices.at(-1) ?? "", /next eligible turn will review accumulated changes and evidence/);
});

test("/review-clear starts the next prompt fresh without deleting retained review artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-review-clear-"));
  try {
    const retainedBundleMarker = join(dir, "retained-review-bundle.txt");
    await writeFile(retainedBundleMarker, "keep me", "utf8");
    await writeFile(join(dir, "index.ts"), "current workspace\n", "utf8");

    const state = createState();
    rememberUserRequest(state, "old task");
    const oldWindow = state.reviewWindow!;
    oldWindow.baseline = await createWorkspaceSnapshot(dir, {
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
    });
    oldWindow.lastCappedFollowUp = "old held feedback";
    oldWindow.correctionCycles = 2;
    oldWindow.evidence.events.push({
      sequence: 1,
      phase: "tool_call",
      toolName: "edit",
      summary: "old evidence",
      candidatePaths: ["index.ts"],
      riskSignals: [],
    });
    state.queuedUserInputsDuringReview.push("old queued input");

    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
    };
    const ctx = {
      notify(message: string) {
        notices.push(message);
      },
    };

    registerCommands({
      pi,
      cwd: () => dir,
      config: { ...reviewConfig(), retainBundles: "always" },
      state,
    });

    state.reviewInProgress = true;
    await commands.get("review-clear")?.("", ctx);
    assert.equal(state.reviewWindow, oldWindow);
    assert.match(notices.at(-1) ?? "", /cannot clear while a review is in progress/);

    state.reviewInProgress = false;
    await commands.get("review-clear")?.("", ctx);

    assert.equal(state.reviewWindow, undefined);
    assert.equal(state.lastQuestionWindow, undefined);
    assert.deepEqual(state.queuedUserInputsDuringReview, []);
    assert.equal(await readFile(retainedBundleMarker, "utf8"), "keep me");
    assert.match(notices.at(-1) ?? "", /next prompt will start fresh from the current workspace/);
    assert.match(notices.at(-1) ?? "", /bundle retention remains governed by retainBundles=always/);
    assert.match(notices.at(-1) ?? "", /reviewer sessions from the cleared window will not be reused/);

    rememberUserRequest(state, "fresh task");
    const freshWindow = getReviewerQuestionWindow(state)!;
    assert.notEqual(freshWindow.id, oldWindow.id);
    assert.deepEqual(freshWindow.requestHistory.map((item) => item.text), ["fresh task"]);
    assert.equal(freshWindow.baseline, undefined);
    assert.equal(freshWindow.evidence.events.length, 0);
    assert.equal(freshWindow.reviewHistory.length, 0);
    assert.equal(freshWindow.correctionCycles, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/review-now requested changes reset the automatic correction budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-review-now-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const state = createState();
    rememberUserRequest(state, "change index");
    state.reviewWindow!.correctionCycles = 2;
    state.reviewWindow!.baseline = await createWorkspaceSnapshot(dir, {
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const followUps: string[] = [];
    const notices: string[] = [];
    const statuses: Array<[string, string | undefined]> = [];
    let queuedInputsReleased = 0;
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };
    const ctx = {
      ui: {
        setStatus(key: string, text: string | undefined) {
          statuses.push([key, text]);
        },
      },
      notify(message: string) {
        notices.push(message);
      },
    };

    registerCommands({
      pi,
      cwd: () => dir,
      config: reviewConfig(),
      state,
      releaseQueuedUserInputs: async () => { queuedInputsReleased += 1; },
    });

    await commands.get("review-now")?.("", ctx);

    assert.equal(state.reviewWindow!.correctionCycles, 0);
    assert.equal(followUps.length, 1);
    assert.match(followUps[0] ?? "", /missing test/);
    assert.match(notices.join("\n"), /review gate: changes requested/);
    assert.ok(statuses.some(([, text]) => text?.includes("reviewing changes")));
    assert.deepEqual(statuses.at(-1), ["review-gate", undefined]);
    assert.equal(queuedInputsReleased, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Escape immediately aborts an active /review-now", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-review-now-escape-"));
  try {
    const markerPath = join(dir, "reviewer-started.txt");
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const state = createState();
    rememberUserRequest(state, "change index");
    state.reviewWindow!.baseline = await createWorkspaceSnapshot(dir, {
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const terminalHandlers: Array<(input: unknown) => unknown> = [];
    const notices: string[] = [];
    const followUps: string[] = [];
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };
    const ctx = {
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        setStatus() {},
        onTerminalInput(handler: (input: unknown) => unknown) {
          terminalHandlers.push(handler);
          return () => {
            const index = terminalHandlers.indexOf(handler);
            if (index >= 0) terminalHandlers.splice(index, 1);
          };
        },
      },
    };
    registerCommands({
      pi,
      cwd: () => dir,
      config: {
        ...reviewConfig(),
        decider: {
          id: "slow",
          adapter: "generic-cli",
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'started');process.stdin.resume();setInterval(()=>{},1000)`,
          ],
          timeoutMs: 300_000,
        },
      },
      state,
    });

    const pending = commands.get("review-now")?.("", ctx);
    await waitForPath(markerPath);
    assert.equal(terminalHandlers.length, 1);
    assert.deepEqual(terminalHandlers[0]?.({ key: "Escape" }), { action: "handled", consume: true });
    await pending;

    assert.match(notices.join("\n"), /review gate: review cancelled/);
    assert.equal(terminalHandlers.length, 0);
    assert.equal(followUps.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/review-cancel stops an active /review-now, reports quiescence, and works without terminal interception", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-review-cancel-now-"));
  try {
    const pidPath = join(dir, "reviewer-pid.txt");
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const state = createState();
    rememberUserRequest(state, "change index");
    state.reviewWindow!.baseline = await createWorkspaceSnapshot(dir, {
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      sendUserMessage() {},
    };
    // The subscription throws when removed to prove cleanup is exception-safe
    // and cannot mask the review outcome or deadlock the command.
    const throwingUnsubscribe = () => {
      throw new Error("stale ui context");
    };
    const ctx = {
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        setStatus() {},
        onTerminalInput() {
          return throwingUnsubscribe;
        },
      },
    };
    registerCommands({
      pi,
      cwd: () => dir,
      cancellation: createReviewCancellationCoordinator(),
      config: {
        ...reviewConfig(),
        decider: {
          id: "slow",
          adapter: "generic-cli",
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000)`,
          ],
          timeoutMs: 300_000,
        },
      },
      state,
    });

    const pending = commands.get("review-now")?.("", ctx);
    await waitForPath(pidPath);
    const reviewerPid = Number(await readFile(pidPath, "utf8"));
    assert.doesNotThrow(() => process.kill(reviewerPid, 0));

    await commands.get("review-cancel")?.("", ctx);
    assert.match(notices.join("\n"), /review gate: cancelling the \/review-now review; waiting for reviewer processes to stop/);
    assert.match(notices.join("\n"), /review gate: review cancelled; reviewer processes stopped/);
    assert.equal(
      notices.filter((notice) => notice === "review gate: review cancelled; reviewer processes stopped").length,
      1,
    );
    await waitForCondition(() => {
      try {
        process.kill(reviewerPid, 0);
        return false;
      } catch {
        return true;
      }
    });

    // The throwing terminal-input unsubscribe must not have masked the outcome.
    await pending;

    await commands.get("review-cancel")?.("", ctx);
    assert.match(notices.join("\n"), /no active review to cancel/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/review-now delivers multi-reviewer results once and keeps its notice concise", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-review-now-multi-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const state = createState();
    rememberUserRequest(state, "change index");
    state.reviewWindow!.baseline = await createWorkspaceSnapshot(dir, {
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const followUps: string[] = [];
    const notices: string[] = [];
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };
    const ctx = {
      notify(message: string) {
        notices.push(message);
      },
    };

    registerCommands({
      pi,
      cwd: () => dir,
      config: multiReviewerReviewConfig(),
      state,
    });

    await commands.get("review-now")?.("", ctx);

    const noticeText = notices.join("\n");
    assert.equal(followUps.length, 1);
    assert.match(followUps[0] ?? "", /\[blocking\] index\.ts\n  Issue: missing test\n  Recommendation: add coverage/);
    assert.match(followUps[0] ?? "", /### claude — pass/);
    assert.match(followUps[0] ?? "", /claude found no blocking issues/);
    assert.match(noticeText, /review gate: changes requested/);
    assert.doesNotMatch(noticeText, /Reviewer results:/);
    assert.doesNotMatch(noticeText, /claude found no blocking issues/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a passing /review-now transmits the complete pass and keeps its window open for the response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-review-now-pass-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const state = createState();
    rememberUserRequest(state, "change index");
    state.reviewWindow!.baseline = await createWorkspaceSnapshot(dir, {
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const followUps: string[] = [];
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };
    const ctx = {
      notify(message: string) {
        notices.push(message);
      },
    };

    registerCommands({
      pi,
      cwd: () => dir,
      config: passingReviewConfig(),
      state,
    });

    await commands.get("review-now")?.("", ctx);
    assert.notEqual(state.reviewWindow, undefined);
    assert.equal(state.reviewWindow?.reviewHistory.at(-1)?.disposition, "sent_for_observation");
    assert.equal(followUps.length, 1);
    assert.match(followUps[0] ?? "", /Gate verdict: pass/);
    assert.match(followUps[0] ?? "", /### passing — pass/);
    assert.match(notices.join("\n"), /review gate: passed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/ask-reviewer-interactive retains a passing review's patch and evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-review-now-pass-ask-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const state = createState();
    rememberUserRequest(state, "change index");
    state.reviewWindow!.baseline = await createWorkspaceSnapshot(dir, {
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
    });
    state.reviewWindow!.evidence.events.push({
      sequence: 1,
      phase: "tool_call",
      toolName: "edit",
      summary: "passed-review-tool-evidence",
      candidatePaths: ["index.ts"],
      riskSignals: [],
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const editorViews: Array<{ title: string; prefill: string }> = [];
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
    };
    const ctx = {
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        async editor(title: string, prefill: string) {
          editorViews.push({ title, prefill });
          return undefined;
        },
      },
    };

    registerCommands({
      pi,
      cwd: () => dir,
      config: passingReviewWithQuestionCheckConfig(),
      state,
    });

    await commands.get("review-now")?.("", ctx);
    assert.notEqual(state.reviewWindow, undefined);
    assert.match(notices.join("\n"), /review gate: passed/);

    await commands.get("ask-reviewer-interactive")?.("what supports the passed change?", ctx);

    assert.equal(editorViews.length, 1);
    assert.match(editorViews[0]?.prefill ?? "", /retained passed patch and evidence/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/review-continue sends capped feedback and resets the correction budget", async () => {
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const followUps: string[] = [];
  const notices: string[] = [];
  const state = createState();
  rememberUserRequest(state, "change index");
  state.reviewWindow!.correctionCycles = 3;
  state.reviewWindow!.lastCappedFollowUp = "Review found blocking issues.\n\n1. index.ts - missing guard add it";
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
      commands.set(name, options.handler);
    },
    sendUserMessage(message: string) {
      followUps.push(message);
    },
  };
  const ctx = {
    notify(message: string) {
      notices.push(message);
    },
  };

  registerCommands({
    pi,
    cwd: () => process.cwd(),
    config: reviewConfig(),
    state,
  });

  await commands.get("review-continue")?.("", ctx);

  assert.equal(state.reviewWindow!.correctionCycles, 0);
  assert.equal(state.reviewWindow!.lastCappedFollowUp, undefined);
  assert.deepEqual(followUps, ["Review found blocking issues.\n\n1. index.ts - missing guard add it"]);
  assert.match(notices.join("\n"), /correction budget reset to 3/);

  await commands.get("review-continue")?.("", ctx);
  assert.equal(followUps.length, 1);
  assert.match(notices.join("\n"), /no capped reviewer feedback available/);
});

test("/ask-reviewer-interactive at the correction cap receives the complete unresolved review window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ask-capped-window-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const state = createState();
    rememberUserRequest(state, "change index with the existing API");
    const window = state.reviewWindow!;
    window.baseline = await createWorkspaceSnapshot(dir, {
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
    });
    window.evidence.events.push({
      sequence: 1,
      phase: "tool_call",
      toolName: "edit",
      summary: "capped-window-tool-evidence",
      candidatePaths: ["index.ts"],
      riskSignals: [],
    });
    const cappedFollowUp = "Review found blocking issues. Add the missing guard.";
    window.lastCappedFollowUp = cappedFollowUp;
    recordReviewerFeedback(state, {
      source: "automatic",
      disposition: "sent_at_cap",
      result: {
        reviewerId: "codex",
        verdict: "needs_changes",
        summary: "The existing API path is missing a guard.",
        findings: [{
          severity: "blocking",
          file: "index.ts",
          line: 1,
          issue: "Missing guard.",
          recommendation: "Add the guard.",
        }],
      },
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const editorViews: Array<{ title: string; prefill: string }> = [];
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
    };
    const ctx = {
      ui: {
        notify() {},
        async editor(title: string, prefill: string) {
          editorViews.push({ title, prefill });
          return undefined;
        },
      },
    };

    registerCommands({
      pi,
      cwd: () => dir,
      config: cappedWindowAskReviewerConfig(),
      state,
    });

    await commands.get("ask-reviewer-interactive")?.("is the capped finding still valid?", ctx);

    assert.equal(editorViews.length, 1);
    assert.match(editorViews[0]?.prefill ?? "", /complete capped review window/);
    assert.equal(state.reviewWindow, window);
    assert.equal(window.lastCappedFollowUp, cappedFollowUp);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/ask-reviewer-interactive opens the reviewer answer in the editor when canceled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ask-command-"));
  try {
    const state = createState();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const userMessages: string[] = [];
    const notices: string[] = [];
    const editorViews: Array<{ title: string; prefill: string }> = [];
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      sendUserMessage(message: string) {
        userMessages.push(message);
      },
    };
    const ctx = {
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        async editor(title: string, prefill: string) {
          editorViews.push({ title, prefill });
          return undefined;
        },
      },
    };

    registerCommands({
      pi,
      cwd: () => dir,
      config: askReviewerConfig(),
      state,
    });

    await commands.get("ask-reviewer-interactive")?.("does this plan look right?", ctx);
    assert.equal(userMessages.length, 0);
    assert.equal(editorViews.length, 1);
    assert.equal(editorViews[0]?.title, "review gate: reviewer answer");
    assert.match(editorViews[0]?.prefill ?? "", /Question: does this plan look right\?/);
    assert.match(editorViews[0]?.prefill ?? "", /Answer: reviewer answer ready/);
    assert.match(editorViews[0]?.prefill ?? "", /```ts\nconst ready = true;\n```/);
    assert.match(notices.join("\n"), /reviewer answer cleared/);
    assert.equal(state.reviewWindow, undefined);
    assert.equal(state.pendingAcceptedReviewerQuestions.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Escape immediately aborts an active /ask-reviewer and clears its terminal handler", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ask-escape-"));
  try {
    const markerPath = join(dir, "reviewer-started.txt");
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const terminalHandlers: Array<(input: unknown) => unknown> = [];
    const notices: string[] = [];
    const statuses: Array<string | undefined> = [];
    const userMessages: string[] = [];
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      sendUserMessage(message: string) {
        userMessages.push(message);
      },
    };
    const ctx = {
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        setStatus(_key: string, text: string | undefined) {
          statuses.push(text);
        },
        onTerminalInput(handler: (input: unknown) => unknown) {
          terminalHandlers.push(handler);
          return () => {
            const index = terminalHandlers.indexOf(handler);
            if (index >= 0) terminalHandlers.splice(index, 1);
          };
        },
      },
    };
    registerCommands({
      pi,
      cwd: () => dir,
      config: {
        ...reviewConfig(),
        decider: {
          id: "slow",
          adapter: "generic-cli",
          command: process.execPath,
          args: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'started');process.stdin.resume();setInterval(()=>{},1000)`,
          ],
          timeoutMs: 300_000,
        },
      },
      state: createState(),
    });

    const pending = commands.get("ask-reviewer")?.("should this stop?", ctx);
    await waitForPath(markerPath);
    assert.equal(terminalHandlers.length, 1);
    const escapedAt = Date.now();
    assert.deepEqual(terminalHandlers[0]?.("\x1b"), { action: "handled", consume: true });
    await pending;

    assert.equal(Date.now() - escapedAt < 1_000, true);
    assert.match(notices.join("\n"), /reviewer question cancelled/);
    assert.equal(statuses.at(-1), undefined);
    assert.equal(terminalHandlers.length, 0);
    assert.equal(userMessages.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/ask-reviewer-interactive submits edited reviewer text when the editor is submitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ask-submit-"));
  try {
    const state = createState();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const userMessages: Array<{ message: string; options: unknown }> = [];
    const preparedCommands: string[] = [];
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      sendUserMessage(message: string, options: unknown) {
        userMessages.push({ message, options });
      },
    };
    const ctx = {
      ui: {
        notify() {},
        async editor(_title: string, prefill: string) {
          return `${prefill}\n\nPlease act on this.`;
        },
      },
    };

    registerCommands({
      pi,
      cwd: () => dir,
      config: askReviewerConfig(),
      state,
      prepareReviewerQuestion: async (commandName) => {
        preparedCommands.push(commandName);
      },
    });

    await commands.get("ask-reviewer-interactive")?.("should this be shared?", ctx);

    assert.equal(userMessages.length, 1);
    assert.deepEqual(userMessages[0]?.options, { deliverAs: "steer" });
    assert.match(userMessages[0]?.message ?? "", /Reviewer note from \/ask-reviewer:/);
    assert.match(userMessages[0]?.message ?? "", /Question: should this be shared\?/);
    assert.match(userMessages[0]?.message ?? "", /Please act on this\./);
    assert.equal(state.reviewWindow?.evidence.acceptedReviewerQuestions.length, 1);
    assert.equal(
      state.reviewWindow?.evidence.acceptedReviewerQuestions[0]?.question,
      "should this be shared?",
    );
    assert.match(
      state.reviewWindow?.evidence.acceptedReviewerQuestions[0]?.acceptedAnswer ?? "",
      /Please act on this\./,
    );
    assert.match(
      state.reviewWindow?.evidence.acceptedReviewerQuestions[0]?.acceptedAnswer ?? "",
      /```ts\nconst ready = true;\n```/,
    );
    assert.deepEqual(preparedCommands, ["ask-reviewer-interactive"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/ask-reviewer submits the same reviewer text without opening the interactive editor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ask-now-"));
  try {
    const state = createState();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const userMessages: Array<{ message: string; options: unknown }> = [];
    const preparedCommands: string[] = [];
    const statuses: Array<[string, string | undefined]> = [];
    let editorCalls = 0;
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      sendUserMessage(message: string, options: unknown) {
        userMessages.push({ message, options });
      },
    };
    const ctx = {
      ui: {
        notify() {},
        setStatus(key: string, text: string | undefined) {
          statuses.push([key, text]);
        },
        async editor(_title: string, prefill: string) {
          editorCalls += 1;
          return prefill;
        },
      },
    };

    registerCommands({
      pi,
      cwd: () => dir,
      config: askReviewerConfig(),
      state,
      prepareReviewerQuestion: async (commandName) => {
        preparedCommands.push(commandName);
      },
    });

    await commands.get("ask-reviewer-interactive")?.("should this be shared?", ctx);
    await commands.get("ask-reviewer")?.("should this be shared?", ctx);

    assert.equal(editorCalls, 1);
    assert.equal(userMessages.length, 2);
    assert.deepEqual(userMessages.map(({ options }) => options), [
      { deliverAs: "steer" },
      { deliverAs: "steer" },
    ]);
    assert.equal(userMessages[1]?.message, userMessages[0]?.message);
    assert.deepEqual(preparedCommands, ["ask-reviewer-interactive", "ask-reviewer"]);
    assert.equal(state.reviewWindow?.evidence.acceptedReviewerQuestions.length, 2);
    assert.ok(statuses.some(([, text]) => text?.includes("asking reviewer")));
    assert.equal(statuses.filter(([, text]) => text === undefined).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/ask-reviewer-interactive opens partial multi-reviewer answers when one reviewer errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ask-partial-"));
  try {
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const userMessages: string[] = [];
    const notices: string[] = [];
    const editorViews: Array<{ title: string; prefill: string }> = [];
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      sendUserMessage(message: string) {
        userMessages.push(message);
      },
    };
    const ctx = {
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        async editor(title: string, prefill: string) {
          editorViews.push({ title, prefill });
          return undefined;
        },
      },
    };

    registerCommands({
      pi,
      cwd: () => dir,
      config: askReviewerPartialErrorConfig(),
      state: createState(),
    });

    await commands.get("ask-reviewer-interactive")?.("do you agree?", ctx);

    assert.equal(userMessages.length, 0);
    assert.equal(editorViews.length, 1);
    assert.match(editorViews[0]?.prefill ?? "", /## passing — pass/);
    assert.match(editorViews[0]?.prefill ?? "", /Answer: reviewer answer ready/);
    assert.match(editorViews[0]?.prefill ?? "", /## bad-json — error/);
    assert.match(editorViews[0]?.prefill ?? "", /Answer: Reviewer JSON has an invalid verdict/);
    assert.match(editorViews[0]?.prefill ?? "", /Reviewer error: schema_error/);
    assert.match(editorViews[0]?.prefill ?? "", /Retained review bundle: /);
    assert.match(notices.join("\n"), /reviewer answer cleared, bundle retained at /);
    assert.doesNotMatch(notices.join("\n"), /ask-reviewer failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function reviewConfig(): ReviewGateConfig {
  return fakeNeedsChangesConfig();
}

function passingReviewConfig(): ReviewGateConfig {
  return {
    ...reviewConfig(),
    decider: {
      id: "passing",
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'approved',findings:[]})))",
      ],
      timeoutMs: 15000,
    },
  };
}

function passingReviewWithQuestionCheckConfig(): ReviewGateConfig {
  return {
    ...reviewConfig(),
    decider: {
      id: "prompt-checker",
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stdin.resume();",
          "let s='';",
          "process.stdin.on('data',c=>s+=c);",
          "process.stdin.on('end',()=>{",
          "const asking=s.includes('Reviewer question:');",
          "const complete=s.includes('what supports the passed change?')",
          "&& s.includes('change index')",
          "&& s.includes('passed-review-tool-evidence')",
          "&& s.includes('-before')",
          "&& s.includes('+after');",
          "process.stdout.write(JSON.stringify(asking",
          "?(complete",
          "?{verdict:'pass',summary:'retained passed patch and evidence',findings:[]}",
          ":{verdict:'needs_changes',summary:'lost passed review context',findings:[]})",
          ":{verdict:'pass',summary:'approved',findings:[]}));",
          "});",
        ].join(""),
      ],
      timeoutMs: 15000,
    },
  };
}

function multiReviewerReviewConfig(): ReviewGateConfig {
  return {
    ...reviewConfig(),
    decider: undefined,
    reviewers: [
      {
        id: "blocking",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:null,issue:'missing test',recommendation:'add coverage'}]})))",
        ],
        timeoutMs: 15000,
      },
      {
        id: "claude",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'claude found no blocking issues',findings:[]})))",
        ],
        timeoutMs: 15000,
      },
    ],
  };
}

function askReviewerPartialErrorConfig(): ReviewGateConfig {
  return {
    ...reviewConfig(),
    decider: undefined,
    retainBundles: "on-failure",
    reviewers: [
      {
        id: "passing",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'reviewer answer ready',findings:[]})))",
        ],
        timeoutMs: 15000,
      },
      {
        id: "bad-json",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'maybe',summary:'invalid verdict',findings:[]})))",
        ],
        timeoutMs: 15000,
      },
    ],
  };
}

function cappedWindowAskReviewerConfig(): ReviewGateConfig {
  return {
    ...reviewConfig(),
    maxCorrectionCycles: 0,
    decider: {
      id: "prompt-checker",
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stdin.resume();",
          "let s='';",
          "process.stdin.on('data',c=>s+=c);",
          "process.stdin.on('end',()=>{",
          "const ok=s.includes('is the capped finding still valid?')",
          "&& s.includes('change index with the existing API')",
          "&& s.includes('capped-window-tool-evidence')",
          "&& s.includes('complete feedback transmitted to the implementing model with correction deferred at the cap')",
          "&& s.includes('The existing API path is missing a guard.')",
          "&& s.includes('Review found blocking issues. Add the missing guard.')",
          "&& s.includes('-before')",
          "&& s.includes('+after');",
          "process.stdout.write(JSON.stringify(ok",
          "?{verdict:'pass',summary:'complete capped review window',findings:[]}",
          ":{verdict:'needs_changes',summary:'incomplete capped review window',findings:[{severity:'blocking',file:'session',line:null,issue:'ask-reviewer lost capped context',recommendation:'supply the complete review window'}]}));",
          "});",
        ].join(""),
      ],
      timeoutMs: 15000,
    },
  };
}

function askReviewerConfig(): ReviewGateConfig {
  return {
    ...reviewConfig(),
    decider: {
      id: "fake",
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        [
          "process.stdin.resume();",
          "let s='';",
          "process.stdin.on('data',c=>s+=c);",
          "process.stdin.on('end',()=>{",
          "const ok=s.includes('Reviewer question:')&&(s.includes('does this plan look right?')||s.includes('should this be shared?'));",
          "process.stdout.write(JSON.stringify(ok",
          "?{verdict:'pass',summary:'reviewer answer ready',guidance:'Use this when helpful:\\n\\n```ts\\nconst ready = true;\\n```',findings:[]}",
          ":{verdict:'needs_changes',summary:'question text was not passed through',findings:[]}));",
          "});",
        ].join(""),
      ],
      timeoutMs: 15000,
    },
  };
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition(), "timed out waiting for condition");
}
