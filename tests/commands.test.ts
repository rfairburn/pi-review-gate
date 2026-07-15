import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkspaceSnapshot } from "../src/capture";
import { registerCommands } from "../src/commands";
import type { ReviewGateConfig } from "../src/config";
import { createState, recordReviewerFeedback, rememberUserRequest } from "../src/state";

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
      config: reviewConfig(),
      state,
    });

    await commands.get("review-now")?.("", ctx);

    assert.equal(state.reviewWindow!.correctionCycles, 0);
    assert.equal(followUps.length, 1);
    assert.match(followUps[0] ?? "", /missing test/);
    assert.match(notices.join("\n"), /review gate: changes requested/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/review-now notice shows non-blocking reviewer results in multi-reviewer runs", async () => {
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
    assert.match(followUps[0] ?? "", /\[blocking\] index\.ts - missing test add coverage/);
    assert.doesNotMatch(followUps[0] ?? "", /claude found no blocking issues/);
    assert.match(noticeText, /Reviewer results:/);
    assert.match(noticeText, /- blocking: needs_changes, 1 blocking - fix required/);
    assert.match(noticeText, /- claude: pass - claude found no blocking issues/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a passing /review-now checkpoints and closes its review window", async () => {
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
      config: passingReviewConfig(),
      state,
    });

    await commands.get("review-now")?.("", ctx);
    assert.equal(state.reviewWindow, undefined);
    assert.match(notices.join("\n"), /review gate: passed/);

    await commands.get("review-now")?.("", ctx);
    assert.match(notices.join("\n"), /no active review window with a baseline/);
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
  state.reviewWindow!.status = "paused_at_cap";
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
  assert.equal(state.reviewWindow!.status, "active");
  assert.deepEqual(followUps, ["Review found blocking issues.\n\n1. index.ts - missing guard add it"]);
  assert.match(notices.join("\n"), /correction budget reset to 3/);

  await commands.get("review-continue")?.("", ctx);
  assert.equal(followUps.length, 1);
  assert.match(notices.join("\n"), /no capped reviewer feedback available/);
});

test("/ask-reviewer at the correction cap receives the complete unresolved review window", async () => {
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
    window.status = "paused_at_cap";
    recordReviewerFeedback(state, {
      source: "automatic",
      disposition: "held_at_cap",
      followUpMessage: cappedFollowUp,
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

    await commands.get("ask-reviewer")?.("is the capped finding still valid?", ctx);

    assert.equal(editorViews.length, 1);
    assert.match(editorViews[0]?.prefill ?? "", /complete capped review window/);
    assert.equal(state.reviewWindow, window);
    assert.equal(window.status, "paused_at_cap");
    assert.equal(window.lastCappedFollowUp, cappedFollowUp);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/ask-reviewer opens the reviewer answer in the editor when canceled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ask-command-"));
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
      config: askReviewerConfig(),
      state: createState(),
    });

    await commands.get("ask-reviewer")?.("does this plan look right?", ctx);
    assert.equal(userMessages.length, 0);
    assert.equal(editorViews.length, 1);
    assert.equal(editorViews[0]?.title, "review gate: reviewer answer");
    assert.match(editorViews[0]?.prefill ?? "", /Question: does this plan look right\?/);
    assert.match(editorViews[0]?.prefill ?? "", /Answer: reviewer answer ready/);
    assert.match(notices.join("\n"), /reviewer answer cleared/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/ask-reviewer submits edited reviewer text when the editor is submitted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ask-submit-"));
  try {
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
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
      state: createState(),
    });

    await commands.get("ask-reviewer")?.("should this be shared?", ctx);

    assert.equal(userMessages.length, 1);
    assert.match(userMessages[0] ?? "", /Reviewer note from \/ask-reviewer:/);
    assert.match(userMessages[0] ?? "", /Question: should this be shared\?/);
    assert.match(userMessages[0] ?? "", /Please act on this\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/ask-reviewer opens partial multi-reviewer answers when one reviewer errors", async () => {
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

    await commands.get("ask-reviewer")?.("do you agree?", ctx);

    assert.equal(userMessages.length, 0);
    assert.equal(editorViews.length, 1);
    assert.match(editorViews[0]?.prefill ?? "", /Answer: passing: reviewer answer ready/);
    assert.match(editorViews[0]?.prefill ?? "", /bad-json: Reviewer JSON has an invalid verdict/);
    assert.match(editorViews[0]?.prefill ?? "", /Retained review bundle: /);
    assert.match(notices.join("\n"), /reviewer answer cleared, bundle retained at /);
    assert.doesNotMatch(notices.join("\n"), /ask-reviewer failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function reviewConfig(): ReviewGateConfig {
  return {
    enabled: true,
    mode: "single-decider",
    maxCorrectionCycles: 3,
    reviewWhen: "changed-files",
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
    decider: {
      id: "fake",
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:null,issue:'missing test',recommendation:'add coverage'}]})))",
      ],
      timeoutMs: 5000,
    },
  };
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
      timeoutMs: 5000,
    },
  };
}

function multiReviewerReviewConfig(): ReviewGateConfig {
  return {
    enabled: true,
    mode: "single-decider",
    maxCorrectionCycles: 3,
    reviewWhen: "changed-files",
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
    reviewers: [
      {
        id: "blocking",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:null,issue:'missing test',recommendation:'add coverage'}]})))",
        ],
        timeoutMs: 5000,
      },
      {
        id: "claude",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'claude found no blocking issues',findings:[]})))",
        ],
        timeoutMs: 5000,
      },
    ],
  };
}

function askReviewerPartialErrorConfig(): ReviewGateConfig {
  return {
    enabled: true,
    mode: "single-decider",
    maxCorrectionCycles: 3,
    reviewWhen: "changed-files",
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
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
        timeoutMs: 5000,
      },
      {
        id: "bad-json",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'maybe',summary:'invalid verdict',findings:[]})))",
        ],
        timeoutMs: 5000,
      },
    ],
  };
}

function cappedWindowAskReviewerConfig(): ReviewGateConfig {
  return {
    enabled: true,
    mode: "single-decider",
    maxCorrectionCycles: 0,
    reviewWhen: "changed-files",
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
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
          "&& s.includes('feedback held at the correction cap')",
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
      timeoutMs: 5000,
    },
  };
}

function askReviewerConfig(): ReviewGateConfig {
  return {
    enabled: true,
    mode: "single-decider",
    maxCorrectionCycles: 3,
    reviewWhen: "changed-files",
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
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
          "?{verdict:'pass',summary:'reviewer answer ready',findings:[]}",
          ":{verdict:'needs_changes',summary:'question text was not passed through',findings:[]}));",
          "});",
        ].join(""),
      ],
      timeoutMs: 5000,
    },
  };
}
