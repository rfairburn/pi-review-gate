// Extension entrypoint review-lifecycle suites: cap status and correction
// turns, review pause/steering, cancellation paths (terminal input, /new,
// /review-cancel), review window checkpointing and continuation, reviewer
// session semantics, transmission disclosure, and operating-mode settings.
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activate } from "../src/index";
import { reapAll } from "../src/background-shell";
import { SessionStateStore } from "../src/session-state";
import { agentCatalog } from "./helpers";
import {
  createSessionRuntime,
  extractBundleDir,
  indexTestConfig,
  stableJsonForTest,
  trigger,
  triggerAgentEnd,
  triggerResults,
  waitForCondition,
  waitForFile,
} from "./entrypoint-harness";
test("cap status is concise while reviewer results are delivered once in the transmission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-cap-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
maxCorrectionCycles: 0,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]})))",
      ],
      timeoutMs: 15000,
    }
  }
},
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: string[] = [];
    const statuses: Array<[string, string | undefined]> = [];
    const pi = {
      ui: {
        setStatus(key: string, text: string | undefined) {
          statuses.push([key, text]);
        },
      },
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir });

    const noticeText = notices.join("\n\n");
    assert.match(noticeText, /automatic correction cap reached/);
    assert.ok(statuses.some(([, text]) => text?.includes("reviewing changes")));
    assert.deepEqual(statuses.at(-1), ["review-gate", undefined]);
    assert.match(noticeText, /Complete reviewer feedback was transmitted to the implementing model/);
    assert.match(noticeText, /Use \/review-continue to authorize/);
    assert.doesNotMatch(noticeText, /missing guard/);
    assert.equal(followUps.length, 1);
    assert.match(followUps[0] ?? "", /missing guard/);
    assert.match(followUps[0] ?? "", /add the guard/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review pause collects separate exchanges and defers reviewer execution until unpaused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-paused-"));
  const invocationMarker = join(dir, "reviewer-invoked.txt");

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
maxCorrectionCycles: 1,
retainBundles: "always",
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(invocationMarker)},'invoked');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'reviewed accumulated paused work',findings:[]})))`,
    ],
      timeoutMs: 15000,
    }
    }
    },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const followUps: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };

    await activate(pi);
    await commands.get("review-pause")?.("", pi);

    await trigger(hooks, "input", { cwd: dir, text: "first paused change", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "paused one\n", "utf8");
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo paused-tool-one" } });
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "completed first paused change" }],
    });

    await trigger(hooks, "input", { cwd: dir, text: "second paused change", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "paused two\n", "utf8");
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo paused-tool-two" } });
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "completed second paused change" }],
    });

    await assert.rejects(access(invocationMarker), /ENOENT/);
    assert.equal(followUps.length, 0);

    await commands.get("review-unpause")?.("", pi);
    await trigger(hooks, "input", { cwd: dir, text: "review the accumulated work", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "ready for accumulated review" }],
    });

    assert.equal(await readFile(invocationMarker, "utf8"), "invoked");
    assert.equal(followUps.length, 1);
    assert.match(followUps[0] ?? "", /reviewed accumulated paused work/);
    const bundleDir = extractBundleDir(followUps[0] ?? "", 1);
    assert.match(await readFile(join(bundleDir, "exchanges", "0001", "tool-events.md"), "utf8"), /paused-tool-one/);
    assert.match(await readFile(join(bundleDir, "exchanges", "0002", "tool-events.md"), "utf8"), /paused-tool-two/);
    assert.match(await readFile(join(bundleDir, "exchanges", "0001", "assistant-summary.md"), "utf8"), /first paused change/);
    assert.match(await readFile(join(bundleDir, "exchanges", "0002", "assistant-summary.md"), "utf8"), /second paused change/);
    assert.match(notices.join("\n"), /reviews unpaused/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("user steering during review is held until reviewer feedback is queued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-steer-during-review-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        [
          "process.stdin.resume();",
          "process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify(",
          "{verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]}",
          ")),50));",
        ].join(""),
      ],
      timeoutMs: 15000,
    }
  }
},
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify() {},
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    // Automatic finalization starts at agent_settled, so steer the input in
    // between the two hooks to land it inside the active review window.
    await trigger(hooks, "agent_end", { cwd: dir });
    const reviewPromise = trigger(hooks, "agent_settled", { cwd: dir });
    const inputResults = await triggerResults(hooks, "input", { cwd: dir, text: "also keep the API name stable", source: "user" });
    await reviewPromise;

    assert.deepEqual(inputResults, [{ action: "handled" }]);
    assert.equal(followUps.length, 2);
    assert.match(followUps[0]?.message ?? "", /Review found blocking issues/);
    assert.match(followUps[0]?.message ?? "", /missing guard/);
    assert.equal(followUps[1]?.message, "also keep the API name stable");
    assert.deepEqual(followUps.map((item) => item.options), [{ deliverAs: "followUp" }, { deliverAs: "followUp" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent end skips reviewer when primary turn signal is already aborted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-aborted-before-review-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const markerPath = join(dir, "review-started.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        [
          `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'started');`,
        "process.stdin.resume();",
        "let input='';",
        "process.stdin.on('data',chunk=>input+=chunk);",
        "process.stdin.on('end',()=>{",
        "const ok=input.includes('Initial user request:')",
        "&& input.includes('change index')",
        "&& input.includes('redirect to finish safely')",
        "&& input.includes('-before')",
        "&& input.includes('+after redirected');",
        "process.stdout.write(JSON.stringify(ok",
        "?{verdict:'pass',summary:'kept interrupted context',findings:[]}",
        ":{verdict:'needs_changes',summary:'lost interrupted context',findings:[{severity:'blocking',file:'session',line:null,issue:'missing aborted run context',recommendation:'preserve baseline and request history across abort'}]}));",
        "});",
      ].join(""),
      ],
        timeoutMs: 15000,
      }
      }
      },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    const controller = new AbortController();
    controller.abort();
    await triggerAgentEnd(hooks, { cwd: dir, signal: controller.signal });

    await assert.rejects(access(markerPath), /ENOENT/);
    assert.doesNotMatch(notices.join("\n"), /reviewing changes/);

    await trigger(hooks, "input", { cwd: dir, text: "redirect to finish safely", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after redirected\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir });

    await access(markerPath);
    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /lost interrupted context/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("completed turns never invoke terminal browser cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-browser-settlement-failure-"));
  try {
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify(indexTestConfig), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    let cleanupCalls = 0;
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) { notices.push(message); },
    };
    await activate(pi, {
      webTools: {
        register() {},
        sync() { return Promise.resolve({ entries: [] }); },
        async applySavedSettings() { return null; },
        async cleanup() {
          cleanupCalls += 1;
          throw new Error("terminal cleanup must not run at turn settlement");
        },
      },
    });

    // Bare task completion keeps browser ownership across multiple turns.
    await trigger(hooks, "agent_settled", { cwd: dir });
    await trigger(hooks, "agent_settled", { cwd: dir });
    assert.equal(cleanupCalls, 0);
    assert.doesNotMatch(notices.join("\n"), /quiescence|teardown/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/new shutdown silently aborts review work before its context becomes stale", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-new-session-abort-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const markerPath = join(dir, "review-started.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        [
          "const fs=require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(markerPath)},'started');`,
        "setInterval(()=>{},1000);",
      ].join(""),
      ],
        timeoutMs: 300000,
      }
      }
      },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const terminalHandlers: Array<(input: unknown) => unknown> = [];
    const ui = {
      notify(message: string) {
        notices.push(message);
      },
      onTerminalInput(handler: (input: unknown) => unknown) {
        terminalHandlers.push(handler);
        return () => {
          const index = terminalHandlers.indexOf(handler);
          if (index >= 0) {
            terminalHandlers.splice(index, 1);
          }
        };
      },
    };
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
    };
    const controller = new AbortController();
    let contextActive = true;
    const ctx = {
      cwd: dir,
      signal: controller.signal,
      get ui() {
        if (!contextActive) {
          throw new Error("test context is stale after /new");
        }
        return ui;
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    await trigger(hooks, "agent_end", ctx);
    const reviewPromise = trigger(hooks, "agent_settled", ctx);
    await waitForFile(markerPath);
    assert.equal(terminalHandlers.length, 1);

    controller.abort();
    const shutdownPromise = trigger(hooks, "session_shutdown", { reason: "new" }, ctx);
    contextActive = false;

    await shutdownPromise;
    await reviewPromise;

    assert.equal(terminalHandlers.length, 0);
    assert.doesNotMatch(notices.join("\n"), /review gate: review cancelled/);
    assert.doesNotMatch(notices.join("\n"), /reviewer failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session_shutdown runs review cleanup before the #84 diagnostic reset", async () => {
  // Regression for the #84 integration ordering: the stream-failure
  // diagnostic bridge (message_end/context/tool_execution_start/agent_end/
  // session_start/session_tree/session_shutdown) must be registered after the
  // critical review lifecycle hooks, so the review session_shutdown handler
  // is dispatched first. The behavioral /new test above already proves the
  // observable contract; this test pins the registration-order invariant on
  // both the review machinery and the newly expected reporting hooks.
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-shutdown-order-"));
  try {
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify(indexTestConfig), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const registrationSequence = new Map<(...args: unknown[]) => unknown, number>();
    let registrationCounter = 0;
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        registrationSequence.set(handler, registrationCounter);
        registrationCounter += 1;
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify() {},
    };
    await activate(pi);

    // The #84 reporting hooks must be registered by real activation.
    for (const name of ["message_end", "context", "tool_execution_start", "agent_end", "session_start", "session_tree", "session_shutdown"]) {
      assert.ok((hooks.get(name) ?? []).length > 0, `stream-failure reporting must register ${name}`);
    }
    const sequence = (handler: (...args: unknown[]) => unknown): number => {
      const value = registrationSequence.get(handler);
      assert.ok(value !== undefined, "handler must have been registered through pi.on");
      return value;
    };
    const shutdownHandlers = hooks.get("session_shutdown")!;
    const sessionStartHandlers = hooks.get("session_start")!;
    // The minimal host has the review lifecycle and #84 bridge on both
    // session hooks. Anchor the bridge to its exclusive session_tree
    // registration, then identify the review hooks by exclusion rather than
    // relying on handler-array positions.
    const sessionTree = (hooks.get("session_tree") ?? []).at(-1);
    assert.ok(sessionTree, "the #84 bridge must register session_tree");
    const diagnosticShutdown = shutdownHandlers.find((handler) => sequence(handler) === sequence(sessionTree!) + 1);
    const diagnosticSessionStart = sessionStartHandlers.find((handler) => sequence(handler) === sequence(sessionTree!) - 1);
    assert.ok(diagnosticShutdown, "the bridge's shutdown reset must follow its session_tree registration");
    assert.ok(diagnosticSessionStart, "the bridge's session_start rebuild must precede its session_tree registration");
    assert.equal(shutdownHandlers.length, 2, "review shutdown + diagnostic reset");
    assert.equal(sessionStartHandlers.length, 2, "review session_start + diagnostic rebuild");
    const reviewShutdown = shutdownHandlers.find((handler) => handler !== diagnosticShutdown);
    const mainSessionStart = sessionStartHandlers.find((handler) => handler !== diagnosticSessionStart);
    assert.ok(reviewShutdown, "the review shutdown handler must remain distinct from the diagnostic reset");
    assert.ok(mainSessionStart, "the review session_start handler must remain distinct from the diagnostic rebuild");
    assert.ok(sequence(reviewShutdown!) < sequence(mainSessionStart!), "review shutdown must be registered before the main session_start lifecycle hook");
    assert.ok(sequence(mainSessionStart!) < sequence(diagnosticShutdown!), "diagnostic bridge must register after the critical lifecycle hooks");
    assert.ok(sequence(reviewShutdown!) < sequence(diagnosticShutdown!), "review cleanup must be dispatched before the diagnostic shutdown reset");
    assert.ok(sequence(diagnosticSessionStart!) < sequence(diagnosticShutdown!), "diagnostic bridge registers its own hooks before its shutdown reset");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("escape terminal input aborts an active reviewer process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-escape-review-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const markerPath = join(dir, "review-started.txt");
    const invocationPath = join(dir, "review-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        [
          "const fs=require('node:fs');",
          `const markerPath=${JSON.stringify(markerPath)};`,
          `const invocationPath=${JSON.stringify(invocationPath)};`,
          "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
          "fs.writeFileSync(invocationPath,String(count+1));",
          "fs.writeFileSync(markerPath,'started');",
          "if(count===0){setInterval(()=>{},1000);}",
          "else {",
          "process.stdin.resume();",
          "let input='';",
          "process.stdin.on('data',chunk=>input+=chunk);",
          "process.stdin.on('end',()=>{",
          "const ok=input.includes('Initial user request:')",
          "&& input.includes('change index')",
          "&& input.includes('redirect after cancelling review')",
          "&& input.includes('-before')",
          "&& input.includes('+after redirected');",
          "process.stdout.write(JSON.stringify(ok",
          "?{verdict:'pass',summary:'kept cancelled review context',findings:[]}",
          ":{verdict:'needs_changes',summary:'lost cancelled review context',findings:[{severity:'blocking',file:'session',line:null,issue:'missing cancelled review context',recommendation:'preserve baseline and request history across review cancellation'}]}));",
          "});",
          "}",
        ].join(""),
        ],
          timeoutMs: 300000,
        }
        }
        },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const terminalHandlers: Array<(input: unknown) => unknown> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        onTerminalInput(handler: (input: unknown) => unknown) {
          terminalHandlers.push(handler);
          return () => {
            const index = terminalHandlers.indexOf(handler);
            if (index >= 0) {
              terminalHandlers.splice(index, 1);
            }
          };
        },
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    await trigger(hooks, "agent_end", { cwd: dir, ui: pi.ui });
    const reviewPromise = trigger(hooks, "agent_settled", { cwd: dir, ui: pi.ui });
    await waitForFile(markerPath);

    assert.equal(terminalHandlers.length, 1);
    assert.deepEqual(
      await triggerResults(hooks, "input", { cwd: dir, text: "do not continue with this", source: "user" }),
      [{ action: "handled" }],
    );
    assert.deepEqual(terminalHandlers[0]?.("\x1b"), { action: "handled", consume: true });
    await reviewPromise;

    assert.match(notices.join("\n"), /review gate: review cancelled/);
    assert.doesNotMatch(notices.join("\n"), /reviewer failed/);
    assert.equal(followUps.length, 0);
    assert.equal(terminalHandlers.length, 0);
    // The mid-review guidance was deliberately dropped with the cancellation:
    // one bounded count-only notice, no input content, no follow-up delivery.
    assert.equal(
      notices.filter((notice) => notice.includes("were dropped when the review was cancelled")).length,
      1,
    );
    assert.match(
      notices.join("\n"),
      /review gate: 1 queued user input\(s\) were dropped when the review was cancelled and will not be sent automatically; resend them if still needed/,
    );
    assert.doesNotMatch(notices.join("\n"), /do not continue with this/);

    await trigger(hooks, "input", { cwd: dir, text: "redirect after cancelling review", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after redirected\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir, ui: pi.ui });

    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /lost cancelled review context/);
    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /Review pass 2 transmission/);
    assert.match(followUps[0]?.message ?? "", /Gate verdict: pass/);
    const bundleDir = extractBundleDir(followUps[0]?.message ?? "", 2);
    assert.match(
      await readFile(join(bundleDir, "reviews", "0001", "CANCELED.md"), "utf8"),
      /A review would have been run here but was canceled by the user\./,
    );
    await assert.rejects(access(join(bundleDir, "reviews", "0001", "reviewers", "fake", "parsed-result.json")), /ENOENT/);
    assert.equal(terminalHandlers.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kitty CSI-u escape aborts an active reviewer process; release and modified escape do not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-escape-csi-u-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const pidPath = join(dir, "reviewer-pid.txt");
    const invocationPath = join(dir, "review-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        [
          "const fs=require('node:fs');",
          `const pidPath=${JSON.stringify(pidPath)};`,
          `const invocationPath=${JSON.stringify(invocationPath)};`,
          "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
          "fs.writeFileSync(invocationPath,String(count+1));",
          "fs.writeFileSync(pidPath,String(process.pid));",
          "if(count===0){setInterval(()=>{},1000);}",
          "else {",
          "process.stdin.resume();",
          "let input='';",
          "process.stdin.on('data',chunk=>input+=chunk);",
          "process.stdin.on('end',()=>{",
          "const ok=input.includes('Initial user request:')",
          "&& input.includes('change index')",
          "&& input.includes('redirect after cancelling review')",
          "&& input.includes('-before')",
          "&& input.includes('+after redirected');",
          "process.stdout.write(JSON.stringify(ok",
          "?{verdict:'pass',summary:'kept cancelled review context',findings:[]}",
          ":{verdict:'needs_changes',summary:'lost cancelled review context',findings:[{severity:'blocking',file:'session',line:null,issue:'missing cancelled review context',recommendation:'preserve baseline and request history across review cancellation'}]}));",
          "});",
          "}",
        ].join(""),
        ],
          timeoutMs: 300000,
        }
        }
        },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: string[] = [];
    const terminalHandlers: Array<(input: unknown) => unknown> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      sendUserMessage(message: string) {
        followUps.push(message);
      },
      ui: {
        notify(message: string) {
          notices.push(message);
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

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    await trigger(hooks, "agent_end", { cwd: dir, ui: pi.ui });
    const reviewPromise = trigger(hooks, "agent_settled", { cwd: dir, ui: pi.ui });
    await waitForFile(pidPath);

    assert.equal(terminalHandlers.length, 1);
    const reviewerPid = Number(await readFile(pidPath, "utf8"));
    assert.doesNotThrow(() => process.kill(reviewerPid, 0), "reviewer child should be running before cancellation");

    // Key-release and modified Escape sequences must not cancel the review.
    assert.deepEqual(terminalHandlers[0]?.("\x1b[27;1:3u"), undefined);
    assert.deepEqual(terminalHandlers[0]?.("\x1b[27;5u"), undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.doesNotThrow(() => process.kill(reviewerPid, 0), "release/modified escape must not stop the reviewer");
    assert.doesNotMatch(notices.join("\n"), /review cancelled/);

    // Unmodified Escape in Kitty CSI-u form must cancel it.
    assert.deepEqual(terminalHandlers[0]?.("\x1b[27u"), { action: "handled", consume: true });
    // Let the asynchronous acknowledgement notice land before asserting order.
    await new Promise((resolve) => setImmediate(resolve));
    // Immediate acknowledgement must not claim reviewer quiescence; the
    // completion notice appears only after runReview returned and children died.
    assert.match(notices.join("\n"), /review gate: cancelling the automatic review; waiting for reviewer processes to stop/);
    assert.doesNotMatch(notices.join("\n"), /reviewer processes stopped/);
    await reviewPromise;

    await waitForCondition(() => {
      try {
        process.kill(reviewerPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    assert.match(notices.join("\n"), /review gate: review cancelled; reviewer processes stopped/);
    assert.equal(terminalHandlers.length, 0);
    // No input was queued during the review, so no dropped-input notice may
    // claim a drop.
    assert.doesNotMatch(notices.join("\n"), /were dropped when the review was cancelled/);
    assert.doesNotMatch(notices.join("\n"), /will not be sent automatically/);

    // The aborted invocation leaves the user-canceled tombstone artifact.
    await trigger(hooks, "input", { cwd: dir, text: "redirect after cancelling review", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after redirected\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir, ui: pi.ui });

    assert.match(notices.join("\n"), /review gate: passed/);
    const bundleDir = extractBundleDir(followUps[0] ?? "", 2);
    assert.match(
      await readFile(join(bundleDir, "reviews", "0001", "CANCELED.md"), "utf8"),
      /A review would have been run here but was canceled by the user\./,
    );
    assert.equal(terminalHandlers.length, 0);
  } finally {
    reapAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("/review-cancel stops an active automatic review and reports when no review is active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-review-cancel-auto-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const pidPath = join(dir, "reviewer-pid.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "slow": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));process.stdin.resume();setInterval(()=>{},1000)`,
    ],
      timeoutMs: 300000,
    }
    }
    },
review: { activeReviewers: [
        { source: "external", id: "slow" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage() {},
    };

    await activate(pi);
    assert.equal(commands.has("review-cancel"), true);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(hooks, "agent_end", { cwd: dir, ui: pi });

    // No review is active yet.
    await commands.get("review-cancel")?.("", pi);
    assert.match(notices.join("\n"), /no active review to cancel/);

    const reviewPromise = trigger(hooks, "agent_settled", { cwd: dir, ui: pi });
    await waitForFile(pidPath);
    const reviewerPid = Number(await readFile(pidPath, "utf8"));
    assert.doesNotThrow(() => process.kill(reviewerPid, 0));

    // Type guidance mid-review; /review-cancel drops it deliberately, so the
    // session must report the count without delivering or echoing the content.
    assert.deepEqual(
      await triggerResults(hooks, "input", { cwd: dir, text: "keep this guidance", source: "user" }),
      [{ action: "handled" }],
    );

    await commands.get("review-cancel")?.("", pi);
    await reviewPromise;

    assert.match(notices.join("\n"), /review gate: cancelling the automatic review; waiting for reviewer processes to stop/);
    assert.match(notices.join("\n"), /review gate: review cancelled; reviewer processes stopped/);
    // The completion notice appears exactly once even though both the command
    // and the automatic-review settlement path report cancellation.
    assert.equal(
      notices.filter((notice) => notice === "review gate: review cancelled; reviewer processes stopped").length,
      1,
    );
    assert.equal(
      notices.filter((notice) => notice.includes("were dropped when the review was cancelled")).length,
      1,
    );
    assert.match(
      notices.join("\n"),
      /review gate: 1 queued user input\(s\) were dropped when the review was cancelled and will not be sent automatically; resend them if still needed/,
    );
    assert.doesNotMatch(notices.join("\n"), /keep this guidance/);
    await waitForCondition(() => {
      try {
        process.kill(reviewerPid, 0);
        return false;
      } catch {
        return true;
      }
    });

    await commands.get("review-cancel")?.("", pi);
    assert.match(notices.join("\n"), /no active review to cancel/);
  } finally {
    reapAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy queued inputs without active delivery records are counted when a review is cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-legacy-queued-drop-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const markerPath = join(dir, "reviewer-marker.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "slow": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'started');process.stdin.resume();setInterval(()=>{},1000)`,
    ],
      timeoutMs: 300000,
    }
    }
    },
review: { activeReviewers: [
        { source: "external", id: "slow" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const sessionFile = join(dir, "legacy-conversation.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const mkRuntime = (sessionId: string) => {
      const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
      const notices: string[] = [];
      const followUps: Array<{ message: string; options: unknown }> = [];
      const terminalHandlers: Array<(input: unknown) => unknown> = [];
      const pi = {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          hooks.set(name, [...(hooks.get(name) ?? []), handler]);
        },
        registerCommand() {},
        notify(message: string) { notices.push(message); },
        ui: {
          notify(message: string) { notices.push(message); },
          onTerminalInput(handler: (input: unknown) => unknown) {
            terminalHandlers.push(handler);
            return () => {
              const index = terminalHandlers.indexOf(handler);
              if (index >= 0) terminalHandlers.splice(index, 1);
            };
          },
        },
        sendUserMessage(message: string, options: unknown) { followUps.push({ message, options }); },
      };
      const ctx = {
        cwd: dir,
        ui: pi.ui,
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => sessionFile,
          getCwd: () => dir,
        },
      };
      return { hooks, notices, followUps, terminalHandlers, pi, ctx };
    };

    // First session: establish a review window with a baseline, then shut down.
    const first = mkRuntime("legacy-conversation");
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dir, text: "initial request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dir }, first.ctx);
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    // Rewrite the persisted state into a legacy/inconsistent shape: a queued-input
    // ledger entry without an active durable delivery. A stale cancelled record
    // for the same text must not hide the currently queued occurrence. The raw
    // document is rewritten (with its integrity hash recomputed) so every other
    // field — including the reviewer-selection digest — stays exactly as the
    // first session saved it.
    const store = new SessionStateStore({ sessionId: "legacy-conversation", sessionFile, cwd: dir });
    const rawPersisted = JSON.parse(await readFile(store.path, "utf8"));
    rawPersisted.state.queuedUserInputsDuringReview = ["legacy mid-review direction"];
    rawPersisted.state.pendingModelDeliveries = [{
      deliveryId: "queued-user-input:old-window:1",
      kind: "queued_user_input",
      channel: "follow_up",
      message: "legacy mid-review direction",
      status: "cancelled",
      createdAt: new Date().toISOString(),
    }];
    const { integritySha256: _integrity, ...unsignedPersisted } = rawPersisted;
    rawPersisted.integritySha256 = createHash("sha256").update(stableJsonForTest(JSON.parse(JSON.stringify(unsignedPersisted)))).digest("hex");
    await writeFile(store.path, `${JSON.stringify(rawPersisted)}\n`, "utf8");

    // Resumed session: the legacy entry survives the restore (the recovery
    // notice reports it), the automatic review runs, and Escape cancels it.
    // The drop notice must count the legacy entry even though it has no
    // delivery record, without ever echoing its content.
    const resumed = mkRuntime("legacy-conversation");
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);
    // The recovery notice must not promise a /review-now release for an
    // occurrence that has no active durable delivery record; it stays
    // preserved until explicitly cancelled.
    assert.match(
      resumed.notices.join("\n"),
      /1 user input\(s\) remain queued from an interrupted review and were not reordered automatically; none can be released by \/review-now because no active durable delivery record exists for them; they stay preserved until cancelled with \/review-clear/,
    );

    await trigger(resumed.hooks, "agent_end", { cwd: dir, ui: resumed.pi.ui }, resumed.ctx);
    const reviewPromise = trigger(resumed.hooks, "agent_settled", { cwd: dir, ui: resumed.pi.ui }, resumed.ctx);
    await waitForFile(markerPath);

    assert.equal(resumed.terminalHandlers.length, 1);
    assert.deepEqual(resumed.terminalHandlers[0]?.("\x1b"), { action: "handled", consume: true });
    await reviewPromise;

    assert.match(resumed.notices.join("\n"), /review gate: review cancelled/);
    assert.equal(
      resumed.notices.filter((notice) => notice.includes("were dropped when the review was cancelled")).length,
      1,
    );
    assert.match(
      resumed.notices.join("\n"),
      /review gate: 1 queued user input\(s\) were dropped when the review was cancelled and will not be sent automatically; resend them if still needed/,
    );
    assert.doesNotMatch(resumed.notices.join("\n"), /legacy mid-review direction/);
    assert.equal(resumed.followUps.length, 0);

    // The cancellation is durable: the ledger is cleared and no delivery
    // record is fabricated for the old-only entry (no backfill), so a later
    // restore cannot resurrect it; only the pre-existing stale cancelled
    // record remains.
    const persisted = JSON.parse(await readFile(`${sessionFile}.pi-review-gate-state.json`, "utf8")) as {
      state: { queuedUserInputsDuringReview: string[]; pendingModelDeliveries: Array<{ kind: string; status: string; message: string }> };
    };
    assert.deepEqual(persisted.state.queuedUserInputsDuringReview, []);
    assert.equal(persisted.state.pendingModelDeliveries.length, 1);
    assert.ok(persisted.state.pendingModelDeliveries.every((delivery) => delivery.kind === "queued_user_input"));
    assert.ok(persisted.state.pendingModelDeliveries.every((delivery) => delivery.status === "cancelled"));
  } finally {
    reapAll();
    await rm(dir, { recursive: true, force: true });
  }
});


test("a failure after listener registration still unregisters, settles, and cleans up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-registration-reject-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-review-gate-reject-session-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const markerPath = join(dir, "reviewer-started.txt");
    const sessionFile = join(sessionDir, "session.jsonl");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'started');process.stdin.resume();setInterval(()=>{},1000)`,
    ],
      timeoutMs: 300000,
    }
    }
    },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const terminalHandlers: Array<(input: unknown) => unknown> = [];
    const sessionManager = {
      getSessionId: () => "reject-persist-session",
      getSessionFile: () => sessionFile,
      getCwd: () => dir,
    };
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage() {},
      ui: {
        notify(message: string) {
          notices.push(message);
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

    await activate(pi);
    await trigger(hooks, "session_start", { cwd: dir, ui: pi.ui, sessionManager });
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(hooks, "agent_end", { cwd: dir, ui: pi.ui });

    // Remove the persistence target so the post-registration
    // persistSessionState() await inside the agent_settled review path rejects.
    await rm(sessionDir, { recursive: true, force: true });
    const reviewPromise = trigger(hooks, "agent_settled", { cwd: dir, ui: pi.ui });
    await assert.rejects(reviewPromise);

    // The terminal-input listener and coordinator handle were cleaned up, the
    // reviewer never started, and neither session shutdown nor /review-cancel
    // can hang on stale state.
    assert.equal(terminalHandlers.length, 0);
    await assert.rejects(access(markerPath), /ENOENT/);
    await mkdir(sessionDir, { recursive: true });
    await commands.get("review-cancel")?.("", pi);
    assert.match(notices.join("\n"), /no active review to cancel/);
    await trigger(hooks, "session_shutdown", { reason: "new" }, { cwd: dir, ui: pi.ui });
  } finally {
    reapAll();
    await rm(sessionDir, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("automatic correction turns preserve original baseline and accumulated evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-auto-correction-evidence-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationPath = join(dir, "review-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
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
          "let input='';",
          "process.stdin.on('data',chunk=>input+=chunk);",
          "process.stdin.on('end',()=>{",
          "if(count===0){",
          "process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]}));",
          "return;",
          "}",
          "const ok=input.includes('original-tool-evidence')",
          "&& input.includes('fix-tool-evidence')",
          "&& input.includes('first assistant summary')",
          "&& input.includes('second assistant summary')",
          "&& input.includes('-before')",
          "&& input.includes('+fixed');",
          "process.stdout.write(JSON.stringify(ok",
          "?{verdict:'pass',summary:'kept accumulated evidence',findings:[]}",
          ":{verdict:'needs_changes',summary:'lost accumulated evidence',findings:[{severity:'blocking',file:'session',line:null,issue:'review prompt lost original baseline or evidence across automatic correction',recommendation:'preserve original baseline and accumulated evidence across automatic correction turns'}]}));",
          "});",
        ].join(""),
        ],
          timeoutMs: 15000,
        }
        }
        },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo original-tool-evidence" } });
    await writeFile(join(dir, "index.ts"), "broken\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "first assistant summary" }],
    });

    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /missing guard/);

    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo fix-tool-evidence" } });
    await writeFile(join(dir, "index.ts"), "fixed\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "second assistant summary" }],
    });

    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /lost accumulated evidence/);
    assert.equal(followUps.length, 2);
    assert.match(followUps[1]?.message ?? "", /Gate verdict: pass/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("automatic correction is reviewed when it exactly restores the original baseline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-auto-correction-exact-revert-"));
  const invocationPath = join(tmpdir(), `pi-review-gate-exact-revert-${process.pid}-${Date.now()}.txt`);
  const bundlePathRecord = join(tmpdir(), `pi-review-gate-exact-revert-bundle-${process.pid}-${Date.now()}.txt`);

  try {
    await writeFile(join(dir, "index.ts"), "original\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        [
          "const fs=require('node:fs');",
          `const invocationPath=${JSON.stringify(invocationPath)};`,
          `const bundlePathRecord=${JSON.stringify(bundlePathRecord)};`,
          "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
          "fs.writeFileSync(invocationPath,String(count+1));",
          "const bundle=process.env.PI_REVIEW_GATE_BUNDLE_DIR;",
          "const firstBundle=fs.existsSync(bundlePathRecord)?fs.readFileSync(bundlePathRecord,'utf8'):'';",
          "if(!firstBundle&&bundle)fs.writeFileSync(bundlePathRecord,bundle);",
          "process.stdin.resume();",
          "let input='';",
          "process.stdin.on('data',chunk=>input+=chunk);",
          "process.stdin.on('end',()=>{",
          "if(count===0){",
          "process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'restore required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'original content was removed',recommendation:'restore the original content'}]}));",
          "return;",
          "}",
          "const ok=input.includes('no net submitted workspace changes')",
          "&& input.includes('original content was removed')",
          "&& input.includes('restore the original content')",
          "&& input.includes('correction-tool-evidence')",
          "&& bundle===firstBundle",
          "&& fs.readFileSync(bundle+'/exchanges/0002/submitted.patch','utf8').includes('-incorrect')",
          "&& fs.readFileSync(bundle+'/exchanges/0002/submitted.patch','utf8').includes('+original')",
          "&& fs.readFileSync(bundle+'/exchanges/0002/tool-events.md','utf8').includes('correction-tool-evidence');",
          "process.stdout.write(JSON.stringify(ok",
          "?{verdict:'pass',summary:'exact restoration validated',findings:[]}",
          ":{verdict:'needs_changes',summary:'lost exact-restoration context',findings:[{severity:'blocking',file:'session',line:null,issue:'follow-up review lost the prior feedback or correction evidence',recommendation:'preserve and review the correction window'}]}));",
          "});",
        ].join(""),
        ],
          timeoutMs: 15000,
        }
        }
        },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "incorrect\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "changed the original content" }],
    });

    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /restore the original content/);

    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo correction-tool-evidence" } });
    await writeFile(join(dir, "index.ts"), "original\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "restored the original content" }],
    });

    assert.equal(await readFile(invocationPath, "utf8"), "2");
    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /lost exact-restoration context/);
    assert.equal(followUps.length, 2);
    assert.match(followUps[1]?.message ?? "", /Gate verdict: pass/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(invocationPath, { force: true });
    await rm(bundlePathRecord, { force: true });
  }
});

test("automatic correction starts each reviewer in a fresh session against the stable window bundle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reviewer-session-resume-"));
  const argvPath = join(tmpdir(), `pi-review-gate-reviewer-session-argv-${process.pid}-${Date.now()}.json`);
  let retainedBundleDir: string | undefined;

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const reviewerPath = join(dir, "fake-codex.mjs");
    await writeFile(reviewerPath, [
      "#!/usr/bin/env node",
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
      `const argvPath=${JSON.stringify(argvPath)};`,
      "const history=existsSync(argvPath)?JSON.parse(readFileSync(argvPath,'utf8')):[];",
      "history.push({argv:process.argv.slice(2),bundle:process.env.PI_REVIEW_GATE_BUNDLE_DIR});",
      "writeFileSync(argvPath,JSON.stringify(history));",
      "const args=process.argv.slice(2);",
      "const out=args[args.indexOf('--output-last-message')+1];",
      "const result=history.length===1",
      "?{verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'bad value',recommendation:'write the fixed value'}]}",
      ":{verdict:'pass',summary:'correction accepted',findings:[]};",
      "writeFileSync(out,JSON.stringify(result));",
      "let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);",
      "process.stdin.on('end',()=>{history.at(-1).prompt=prompt;writeFileSync(argvPath,JSON.stringify(history));process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'stable-review-session'})+'\\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})+'\\n')});",
    ].join("\n"), "utf8");
    await chmod(reviewerPath, 0o755);

    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "codex": {
    adapter: "codex-cli",
    command: reviewerPath,
    args: [],
    review: {
      timeoutMs: 15000,
    }
  }
},
review: { activeReviewers: [
        { source: "external", id: "codex" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const followUps: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify() {},
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "broken\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir });
    assert.equal(followUps.length, 1);

    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "fixed\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir });

    const history = JSON.parse(await readFile(argvPath, "utf8"));
    assert.equal(history.length, 2);
    assert.deepEqual(history[1].argv.slice(0, 2), ["exec", "--json"]);
    assert.equal(history[1].argv.includes("resume"), false);
    assert.equal(history[0].bundle, history[1].bundle);
    assert.match(history[0].prompt, /authoritative evidence bundle/);
    assert.match(history[1].prompt, /REVIEW\.md/);
    assert.doesNotMatch(history[1].prompt, /submitted_patch_diff/);
    const freshInvocation = JSON.parse(await readFile(
      join(history[1].bundle, "reviews", "0002", "reviewers", "codex", "invocation.json"),
      "utf8",
    ));
    assert.equal(freshInvocation.resumed, false);
    assert.equal(freshInvocation.telemetry.sessionResumed, false);
    assert.equal(freshInvocation.session.id, "stable-review-session");

    const bundleDir = history[1].bundle;
    retainedBundleDir = bundleDir;
    await trigger(hooks, "session_shutdown", { reason: "test" });
    await assert.rejects(access(bundleDir), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(argvPath, { force: true });
    if (retainedBundleDir) await rm(retainedBundleDir, { recursive: true, force: true });
  }
});

test("/review-continue after cap preserves original baseline and accumulated evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-capped-continue-evidence-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationPath = join(dir, "review-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
maxCorrectionCycles: 0,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
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
          "let input='';",
          "process.stdin.on('data',chunk=>input+=chunk);",
          "process.stdin.on('end',()=>{",
          "if(count===0){",
          "process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]}));",
          "return;",
          "}",
          "const ok=input.includes('capped-original-evidence')",
          "&& input.includes('continued-fix-evidence')",
          "&& input.includes('first capped summary')",
          "&& input.includes('continued summary')",
          "&& input.includes('-before')",
          "&& input.includes('+fixed after continue');",
          "process.stdout.write(JSON.stringify(ok",
          "?{verdict:'pass',summary:'kept capped continuation evidence',findings:[]}",
          ":{verdict:'needs_changes',summary:'lost capped continuation evidence',findings:[{severity:'blocking',file:'session',line:null,issue:'review prompt lost evidence after correction cap and review-continue',recommendation:'preserve evidence across capped continuation'}]}));",
          "});",
        ].join(""),
        ],
          timeoutMs: 15000,
        }
        }
        },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo capped-original-evidence" } });
    await writeFile(join(dir, "index.ts"), "broken\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "first capped summary" }],
    });

    assert.match(notices.join("\n"), /automatic correction cap reached/);
    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /automatic correction is deferred/);

    await commands.get("review-continue")?.("", { notify(message: string) { notices.push(message); } });

    assert.equal(followUps.length, 2);
    assert.match(followUps[1]?.message ?? "", /correction authorization/);
    assert.doesNotMatch(followUps[1]?.message ?? "", /missing guard/);
    const cappedBundleDir = extractBundleDir(followUps[0]?.message ?? "", 1);
    const cappedDeliveries = JSON.parse(await readFile(
      join(cappedBundleDir, "reviews", "0001", "delivery.json"),
      "utf8",
    ));
    assert.deepEqual(
      cappedDeliveries.deliveries.map((delivery: { action: string }) => delivery.action),
      ["deferred", "correction_required"],
    );

    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo continued-fix-evidence" } });
    await writeFile(join(dir, "index.ts"), "fixed after continue\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "continued summary" }],
    });

    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /lost capped continuation evidence/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("normal user input after cap continues the unresolved review window with complete context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-capped-fresh-input-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationPath = join(dir, "review-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
maxCorrectionCycles: 0,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
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
          "let input='';",
          "process.stdin.on('data',chunk=>input+=chunk);",
          "process.stdin.on('end',()=>{",
          "if(count===0){",
          "process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]}));",
          "return;",
          "}",
          "const ok=input.includes('fresh-task-evidence')",
          "&& input.includes('old-capped-evidence')",
          "&& input.includes('first capped summary')",
          "&& input.includes('missing guard')",
          "&& input.includes('complete feedback transmitted to the implementing model with correction deferred at the cap')",
          "&& input.includes('Initial user request:')",
          "&& input.includes('change index')",
          "&& input.includes('Additional user guidance during the same review window:')",
          "&& input.includes('start a different task')",
          "&& input.includes('-before')",
          "&& input.includes('+fresh change')",
          ";",
          "process.stdout.write(JSON.stringify(ok",
          "?{verdict:'pass',summary:'capped window retained complete context',findings:[]}",
          ":{verdict:'needs_changes',summary:'capped window lost context',findings:[{severity:'blocking',file:'session',line:null,issue:'normal prompt after cap lost evidence, feedback, or baseline',recommendation:'keep the unresolved review window intact'}]}));",
          "});",
        ].join(""),
        ],
          timeoutMs: 15000,
        }
        }
        },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage() {},
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo old-capped-evidence" } });
    await writeFile(join(dir, "index.ts"), "broken\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "first capped summary" }],
    });

    assert.match(notices.join("\n"), /automatic correction cap reached/);

    await trigger(hooks, "input", { cwd: dir, text: "start a different task", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo fresh-task-evidence" } });
    await writeFile(join(dir, "index.ts"), "fresh change\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "fresh task summary" }],
    });

    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /capped window lost context/);
    assert.equal(commands.has("review-continue"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a passed review remains available to /ask-reviewer-interactive but is checkpointed out of the next regular window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-window-checkpoint-"));
  const outside = join(tmpdir(), `pi-review-gate-outside-review-${process.pid}-${Date.now()}.md`);
  const invocationPath = join(tmpdir(), `pi-review-gate-window-invocations-${process.pid}-${Date.now()}.txt`);

  try {
    await writeFile(join(dir, "Dockerfile"), "FROM alpine:3.19\n", "utf8");
    await writeFile(outside, "old review document\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
maxCorrectionCycles: 0,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        [
          "const fs=require('node:fs');",
          `const invocationPath=${JSON.stringify(invocationPath)};`,
          `const outside=${JSON.stringify(outside)};`,
          "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
          "fs.writeFileSync(invocationPath,String(count+1));",
          "process.stdin.resume();",
          "let input='';",
          "process.stdin.on('data',chunk=>input+=chunk);",
          "process.stdin.on('end',()=>{",
          "const firstContext=input.includes(outside)&&input.includes('outside_workspace')&&input.includes('first Docker task');",
          "const ok=count===0",
          "?firstContext",
          ":count===1",
          "?firstContext&&input.includes('Reviewer question:')&&input.includes('what changed outside the workspace?')&&input.includes('-FROM alpine:3.19')&&input.includes('+FROM alpine:3.20')",
          ":!input.includes(outside)&&!input.includes('first Docker task')&&input.includes('second Docker task')&&input.includes('+FROM alpine:3.21');",
          "process.stdout.write(JSON.stringify(ok",
          "?{verdict:'pass',summary:count===0?'first window complete':count===1?'passed context retained for question':'second window isolated',findings:[]}",
          ":{verdict:'needs_changes',summary:'review windows mixed',findings:[{severity:'blocking',file:'session',line:null,issue:'a review used changes or context from the wrong window',recommendation:'checkpoint passed changes and open an isolated window'}]}));",
          "});",
        ].join(""),
        ],
          timeoutMs: 15000,
        }
        }
        },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const editorViews: Array<{ title: string; prefill: string }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage() {},
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "first Docker task", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "write", input: { path: outside } });
    await writeFile(outside, "rewritten review document\n", "utf8");
    await writeFile(join(dir, "Dockerfile"), "FROM alpine:3.20\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "finished first Docker task and review document" }],
    });

    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "acknowledged the passing review" }],
    });

    await commands.get("ask-reviewer-interactive")?.("what changed outside the workspace?", {
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        async editor(title: string, prefill: string) {
          editorViews.push({ title, prefill });
          return undefined;
        },
      },
    });

    await trigger(hooks, "input", { cwd: dir, text: "second Docker task", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "Dockerfile"), "FROM alpine:3.21\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "finished second Docker task" }],
    });

    assert.equal(
      notices.filter((notice) => /review gate: passed/.test(notice)).length,
      2,
      notices.join("\n"),
    );
    assert.match(editorViews[0]?.prefill ?? "", /passed context retained for question/);
    assert.doesNotMatch(notices.join("\n"), /review windows mixed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { force: true });
    await rm(invocationPath, { force: true });
  }
});

test("repeated no-progress reviewer feedback stops automatic correction loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-no-progress-loop-"));
  const invocationPath = join(tmpdir(), `pi-review-gate-no-progress-${process.pid}-${Date.now()}.txt`);

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
maxCorrectionCycles: 30,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
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
          "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({",
          "verdict:'needs_changes',summary:'sentinel flag',findings:[{",
          "severity:'blocking',file:'session',line:null,",
          "issue:count===0?'The user explicitly instructed review-gate to flag this rather than report pass. No file content change is needed.':'The user explicitly instructed review-gate to flag this request instead of reporting passed. No implementation change is required.',",
          "recommendation:count===0?'Keep this as the requested review-gate sentinel flag.':'Keep this as the requested sentinel flag.'",
          "}]})));",
        ].join(""),
        ],
          timeoutMs: 15000,
        }
        }
        },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "write hello world and flag review-gate", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "wrote the file and flagged review-gate" }],
    });

    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /sentinel flag/);

    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "no implementation change is required" }],
    });

    assert.equal(followUps.length, 2);
    assert.match(followUps[1]?.message ?? "", /automatic correction is deferred/);
    assert.match(notices.join("\n"), /repeated changes requested with no new correction evidence/);
    assert.match(notices.join("\n"), /Stopping automatic correction to avoid a loop/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(invocationPath, { force: true });
  }
});

test("a passing multi-model review discloses every result and reviews changes made after the transmission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-pass-transmission-continuation-"));
  const alphaCount = join(tmpdir(), `pi-review-gate-alpha-pass-${process.pid}-${Date.now()}.txt`);
  const betaCount = join(tmpdir(), `pi-review-gate-beta-pass-${process.pid}-${Date.now()}.txt`);

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const reviewer = (id: string, countPath: string, peerSummary: string) => ({
      id,
      adapter: "generic-cli" as const,
      command: process.execPath,
      args: [],
      review: {
        args: [
          "-e",
        [
          "const fs=require('node:fs');",
          `const countPath=${JSON.stringify(countPath)};`,
          "const count=fs.existsSync(countPath)?Number(fs.readFileSync(countPath,'utf8')):0;",
          "fs.writeFileSync(countPath,String(count+1));",
          "let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{",
          "if(count===0){process.stdout.write(JSON.stringify({verdict:'pass',",
          `summary:${JSON.stringify(`${id} approved with useful observation`)},`,
          `guidance:${JSON.stringify(`${id} optional guidance`)},`,
          `findings:[{severity:'non_blocking',file:'index.ts',line:1,issue:${JSON.stringify(`${id} observational note`)},recommendation:${JSON.stringify(`${id} optional next step`)}}]}));return;}`,
          "const sawHistory=input.includes('Complete individual reviewer results delivered to the implementing model:')",
          `&&input.includes(${JSON.stringify(peerSummary)})`,
          `&&input.includes(${JSON.stringify(`${id} approved with useful observation`)})`,
          "&&input.includes('complete passing review transmitted to the implementing model');",
          "process.stdout.write(JSON.stringify(sawHistory",
          `?{verdict:'pass',summary:${JSON.stringify(`${id} saw the complete prior pass`)},findings:[]}`,
          `:{verdict:'needs_changes',summary:${JSON.stringify(`${id} did not see complete prior reviewer results`)},findings:[{severity:'blocking',file:'session',line:null,issue:'prior multi-model pass was hidden',recommendation:'deliver every prior reviewer result'}]}));`,
            "});",
          ].join(""),
        ],
        timeoutMs: 15000,
      },
    });
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(
reviewer("alpha", alphaCount, "beta approved with useful observation"),
reviewer("beta", betaCount, "alpha approved with useful observation")
      ),
review: { activeReviewers: [
        { source: "external", id: "alpha" },
        { source: "external", id: "beta" }
      ] },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "implement the change", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "first implementation\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir });

    assert.equal(followUps.length, 1);
    assert.match(followUps[0] ?? "", /Gate verdict: pass/);
    assert.match(followUps[0] ?? "", /### alpha — pass/);
    assert.match(followUps[0] ?? "", /alpha optional guidance/);
    assert.match(followUps[0] ?? "", /alpha observational note/);
    assert.match(followUps[0] ?? "", /### beta — pass/);
    assert.match(followUps[0] ?? "", /beta optional guidance/);
    assert.match(followUps[0] ?? "", /beta observational note/);
    assert.doesNotMatch(followUps[0] ?? "", /Aggregate decision/);

    const bundleDir = extractBundleDir(followUps[0] ?? "", 1);
    const passOneDir = join(bundleDir, "reviews", "0001");
    assert.equal(await readFile(join(passOneDir, "implementing-model-transmission.md"), "utf8"), followUps[0]);
    const envelope = JSON.parse(await readFile(join(passOneDir, "implementing-model-transmission.json"), "utf8"));
    assert.equal(envelope.gateVerdict, "pass");
    assert.equal(envelope.reviewerResults.length, 2);
    assert.equal("aggregateResult" in envelope, false);
    await assert.rejects(access(join(passOneDir, "parsed-result.json")), /ENOENT/);
    const delivery = JSON.parse(await readFile(join(passOneDir, "delivery.json"), "utf8"));
    assert.equal(delivery.recipient, "implementing_model");
    assert.equal(delivery.deliveries.length, 1);
    assert.equal(delivery.deliveries[0].action, "passed");
    assert.equal(delivery.deliveries[0].content, "implementing-model-transmission.md");
    assert.equal(delivery.deliveries[0].message, undefined);

    await writeFile(join(dir, "index.ts"), "follow-up implementation\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir });

    assert.equal(await readFile(alphaCount, "utf8"), "2");
    assert.equal(await readFile(betaCount, "utf8"), "2");
    assert.equal(followUps.length, 2);
    assert.match(followUps[1] ?? "", /alpha saw the complete prior pass/);
    assert.match(followUps[1] ?? "", /beta saw the complete prior pass/);
    assert.doesNotMatch(notices.join("\n"), /prior multi-model pass was hidden/);
    const exchange = JSON.parse(await readFile(join(bundleDir, "exchanges", "0002", "metadata.json"), "utf8"));
    assert.equal(exchange.causedByReviewSequence, 1);
    assert.equal(exchange.causedByReviewVerdict, "pass");
    assert.equal(exchange.reviewResponseMode, "observation");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(alphaCount, { force: true });
    await rm(betaCount, { force: true });
  }
});

test("an unchanged response to a passing transmission closes without another review", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-pass-transmission-unchanged-"));
  const invocationCount = join(tmpdir(), `pi-review-gate-pass-unchanged-${process.pid}-${Date.now()}.txt`);

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "passing": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(invocationCount)},'1');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'final useful observation',guidance:'consider a later cleanup',findings:[]})))`],
      timeoutMs: 15000,
    }
    }
    },
review: { activeReviewers: [
        { source: "external", id: "passing" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const followUps: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify() {},
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "implement the change", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "implemented\n", "utf8");
    await triggerAgentEnd(hooks, { cwd: dir });
    const bundleDir = extractBundleDir(followUps[0] ?? "", 1);

    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "acknowledged the review without changing files" }],
    });

    assert.equal(await readFile(invocationCount, "utf8"), "1");
    assert.equal(followUps.length, 1);
    const finalExchange = JSON.parse(await readFile(
      join(bundleDir, "exchanges", "0002", "metadata.json"),
      "utf8",
    ));
    assert.equal(finalExchange.causedByReviewSequence, 1);
    assert.equal(finalExchange.reviewResponseMode, "observation");
    assert.match(
      await readFile(join(bundleDir, "exchanges", "0002", "assistant-summary.md"), "utf8"),
      /acknowledged the review without changing files/,
    );
    await trigger(hooks, "input", { cwd: dir, text: "next independent task", source: "user" });
    await assert.rejects(access(bundleDir), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(invocationCount, { force: true });
  }
});

test("/ask-reviewer pauses an active turn before invoking the reviewer and then steers the answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-ask-active-turn-"));
  const invocationMarker = join(dir, "reviewer-invoked.txt");

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
maxCorrectionCycles: 1,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
    command: process.execPath,
    args: [],
    review: {
      args: [
        "-e",
        [
          `require('node:fs').writeFileSync(${JSON.stringify(invocationMarker)},'invoked');`,
        "process.stdin.resume();let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>",
        "process.stdout.write(JSON.stringify(s.includes('paused at a stable boundary')",
        "?{verdict:'pass',summary:'reviewed the paused workspace',guidance:null,findings:[],error:null}",
        ":{verdict:'needs_changes',summary:'missing paused exchange',guidance:null,findings:[],error:null})));",
      ].join(""),
      ],
        timeoutMs: 15000,
      }
      }
      },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const userMessages: Array<{ message: string; options: unknown }> = [];
    let idle = true;
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify() {},
      sendUserMessage(message: string, options: unknown) {
        userMessages.push({ message, options });
      },
    };
    const ctx = {
      isIdle: () => idle,
      ui: { notify() {} },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    idle = false;
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "changed before consultation\n", "utf8");

    const questionPromise = Promise.resolve(commands.get("ask-reviewer")?.("is this correct?", ctx));
    await waitForCondition(() => userMessages.length === 1);

    assert.deepEqual(userMessages[0]?.options, { deliverAs: "steer" });
    assert.match(userMessages[0]?.message ?? "", /Pause implementation at this steering boundary/);
    await assert.rejects(access(invocationMarker), /ENOENT/);

    await triggerAgentEnd(hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "paused at a stable boundary" }],
    });
    idle = true;
    await questionPromise;

    assert.equal(await readFile(invocationMarker, "utf8"), "invoked");
    assert.equal(userMessages.length, 2);
    assert.deepEqual(userMessages[1]?.options, { deliverAs: "steer" });
    assert.match(userMessages[1]?.message ?? "", /Reviewer note from \/ask-reviewer:/);
    assert.match(userMessages[1]?.message ?? "", /reviewed the paused workspace/);
    assert.doesNotMatch(userMessages[1]?.message ?? "", /Review pass .* transmission/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider-error agent_end followed by a successful retry keeps the original baseline until agent_settled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-retry-settlement-"));

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationPath = join(dir, "review-invocations.txt");
    const promptPath = join(dir, "review-prompt.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: {
  "fake": {
    adapter: "generic-cli",
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
          "let input='';",
          "process.stdin.on('data',chunk=>input+=chunk);",
          "process.stdin.on('end',()=>{",
          `fs.writeFileSync(${JSON.stringify(promptPath)},input);`,
          "process.stdout.write(JSON.stringify({verdict:'pass',summary:'retry mutation reviewed against the original baseline',findings:[]}));",
          "});",
        ].join(""),
        ],
          timeoutMs: 15000,
        }
        }
        },
review: { activeReviewers: [
        { source: "external", id: "fake" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) { notices.push(message); },
      sendUserMessage(message: string, options: unknown) { followUps.push({ message, options }); },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });

    // The first low-level run ends with a retryable provider error and no
    // file changes. Pi has not settled yet: it will automatically retry the
    // same turn, so neither the reviewer nor the window may be finalized.
    await trigger(hooks, "agent_end", {
      cwd: dir,
      messages: [{ role: "assistant", content: "", stopReason: "error", errorMessage: "overloaded" }],
    });
    await assert.rejects(access(invocationPath), /ENOENT/);

    // The retry makes the actual edit. Retries do not re-fire
    // before_agent_start, and no review may run between this agent_end and
    // agent_settled either — the workspace is still mutable until then.
    await writeFile(join(dir, "index.ts"), "after retry\n", "utf8");
    await trigger(hooks, "agent_end", {
      cwd: dir,
      messages: [{ role: "assistant", content: "applied the change after the provider recovered" }],
    });
    await assert.rejects(access(invocationPath), /ENOENT/);

    // Settlement is the boundary where the automatic reviewer may run, and it
    // must still see the diff against the pre-error baseline.
    await trigger(hooks, "agent_settled", { cwd: dir });

    assert.equal(await readFile(invocationPath, "utf8"), "1");
    const reviewerPrompt = await readFile(promptPath, "utf8");
    assert.match(reviewerPrompt, /User request context:/);
    assert.match(reviewerPrompt, /change index/);
    assert.match(reviewerPrompt, /-before/);
    assert.match(reviewerPrompt, /\+after retry/);
    assert.match(notices.join("\n"), /review gate: passed/);
    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /Gate verdict: pass/);
    assert.match(followUps[0]?.message ?? "", /retry mutation reviewed against the original baseline/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("settings replace the mode prompt on the next run in the same conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-operating-mode-"));
  try {
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(indexTestConfig));
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    let settings: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const session = createSessionRuntime("mode-session", join(dir, "session.jsonl"), dir, {
      reviewSettings: (handler) => { settings = handler; },
    });
    await activate(session.pi);
    await trigger(session.hooks, "session_start", { cwd: dir }, session.ctx);
    const prompt = async () => {
      const results = await triggerResults(session.hooks, "before_agent_start", {
        cwd: dir, systemPrompt: "Shared safety and user append instructions.",
      }, session.ctx);
      return results.map((result) => (result as { systemPrompt?: string }).systemPrompt ?? "").join("\n");
    };
    const initial = await prompt();
    assert.match(initial, /# Orchestrator role/);
    assert.ok(settings);
    let status = "";
    for (const [label, mode, heading] of [
      ["Prefer execution", "execute", "# Execution posture"],
      ["Plan/research", "plan-research", "# Planning and research posture"],
      ["Prefer orchestration", "orchestrate", "# Orchestrator role"],
    ]) {
      let rootVisits = 0;
      await settings!("", { ...session.ctx, ui: {
        setStatus: (key: string, value: string) => { if (key === "review-gate-mode") status = value; },
        select: async (title: string, choices: string[]) => {
          if (title === "Review settings") return rootVisits++ === 0
            ? choices.find((choice) => choice.startsWith("Operating mode")) : "Save changes";
          if (title === "Operating mode") return choices.find((choice) => choice.startsWith(label!));
          throw new Error(`Unexpected menu: ${title}`);
        },
      } });
      const current = await prompt();
      assert.equal(status, `operating mode: ${label}`);
      assert.ok(current.includes(heading!));
      assert.match(current, /Shared safety and user append instructions/);
      for (const other of ["# Orchestrator role", "# Execution posture", "# Planning and research posture"]) {
        if (other !== heading) assert.ok(!current.includes(other));
      }
      assert.equal(JSON.parse(await readFile(configPath, "utf8")).operatingMode, mode);
    }
    assert.match(initial, /# Orchestrator role/, "previous run's prompt is unchanged");
    const saved = await readFile(configPath, "utf8");
    let cancelVisits = 0;
    await settings!("", { ...session.ctx, ui: {
      select: async (title: string, choices: string[]) => title === "Operating mode"
        ? choices.find((choice) => choice.startsWith("Prefer execution"))
        : cancelVisits++ === 0 ? choices.find((choice) => choice.startsWith("Operating mode")) : "Cancel",
    } });
    assert.equal(await prompt(), initial, "cancelling the staged mode preserves the current prompt");
    assert.equal(await readFile(configPath, "utf8"), saved);
    await trigger(session.hooks, "session_shutdown", {}, session.ctx);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
