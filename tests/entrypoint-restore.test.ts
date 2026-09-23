// Extension entrypoint review-window and sidecar restoration suites: durable
// conversation restore, reviewer-settings reconciliation of persisted review
// windows, sidecar quarantine/corruption fail-closed behavior, and queued
// input recovery semantics.
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activate } from "../src/index";
import { normalizeConfig } from "../src/config";
import { queueModelDelivery } from "../src/durable-delivery";
import { freezeReviewWindowConfig } from "../src/state";
import { SessionStateStore } from "../src/session-state";
import { agentCatalog } from "./helpers";
import {
  countingPassReviewer,
  countingPassReviewerWithPromptDump,
  createSessionRuntime,
  escapeRegExp,
  indexTestConfig,
  releaseGatedCountingPassReviewer,
  runFirstReviewSession,
  stableJsonForTest,
  stripDisplayLabels,
  trigger,
  triggerAgentEnd,
  waitForFile,
} from "./entrypoint-harness";
test("review state restores only when the same persisted conversation resumes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-conversation-restore-"));
  try {
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const runtime = (sessionId: string, file: string) => {
      const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
      const notices: string[] = [];
      const entries: Array<{ type: string; data: unknown }> = [];
      const sent: Array<{ message: string; options: unknown }> = [];
      const pi = {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          hooks.set(name, [...(hooks.get(name) ?? []), handler]);
        },
        registerCommand() {},
        appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
        notify(message: string) { notices.push(message); },
        sendUserMessage(message: string, options: unknown) { sent.push({ message, options }); },
      };
      const ctx = {
        cwd: dir,
        ui: { notify: (message: string) => notices.push(message) },
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => file,
          getCwd: () => dir,
        },
      };
      return { hooks, notices, entries, sent, pi, ctx };
    };

    const first = runtime("conversation-a", sessionFile);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dir, text: "preserve this request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dir }, first.ctx);
    const statePath = `${sessionFile}.pi-review-gate-state.json`;
    const beforeTools = await readFile(statePath, "utf8");
    await Promise.all([
      trigger(first.hooks, "tool_call", { cwd: dir, toolName: "read", input: { path: "one.ts" } }, first.ctx),
      trigger(first.hooks, "tool_call", { cwd: dir, toolName: "grep", input: { path: dir, pattern: "evidence" } }, first.ctx),
      trigger(first.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "printf evidence" } }, first.ctx),
    ]);
    await Promise.all([
      trigger(first.hooks, "tool_result", { cwd: dir, toolName: "read", input: { path: "one.ts" }, content: [{ type: "text", text: "contents" }], isError: false }, first.ctx),
      trigger(first.hooks, "tool_result", { cwd: dir, toolName: "grep", input: { path: dir, pattern: "evidence" }, content: [{ type: "text", text: "grep failed" }], isError: true }, first.ctx),
      trigger(first.hooks, "tool_result", { cwd: dir, toolName: "bash", input: { command: "printf evidence" }, content: [{ type: "text", text: "evidence" }], isError: false }, first.ctx),
    ]);
    assert.equal(await readFile(statePath, "utf8"), beforeTools, "tool hooks keep evidence in memory");
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);
    const targetStore = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const targetState = await targetStore.restore(dir);
    assert.ok(targetState);
    assert.deepEqual(targetState.state.reviewWindow?.evidence.events.map((event) => event.toolName), ["bash", "grep", "bash"]);
    assert.match(targetState.state.reviewWindow?.evidence.events[0]?.summary ?? "", /printf evidence/);
    assert.equal(targetState.state.reviewWindow?.evidence.events[1]?.isError, true);
    queueModelDelivery(targetState.state, {
      kind: "review_authorization",
      channel: "follow_up",
      message: "durable pending message for resumed conversation",
    });
    // Re-freeze the restored window against the same settings the runtime
    // loaded and save with the frozen config so the sidecar carries the
    // canonical selection digest, exactly as the production runtime persists it.
    freezeReviewWindowConfig(targetState.state, normalizeConfig(JSON.parse(await readFile(configPath, "utf8"))));
    await targetStore.save(targetState.state, targetState.execution, targetState.state.reviewWindow?.reviewConfig);

    // Model the ordinary interactive flow exactly: a later application starts
    // in a temporary/default session, then /resume replaces that runtime with
    // a freshly loaded extension instance for the selected conversation.
    const bootstrapFile = join(dir, "startup-session.jsonl");
    await writeFile(bootstrapFile, "", "utf8");
    const bootstrap = runtime("startup-session", bootstrapFile);
    await activate(bootstrap.pi);
    await trigger(bootstrap.hooks, "session_start", { type: "session_start", reason: "startup" }, bootstrap.ctx);
    await trigger(bootstrap.hooks, "input", { cwd: dir, text: "must not leak into resumed conversation", source: "user" }, bootstrap.ctx);
    await trigger(bootstrap.hooks, "session_shutdown", {
      type: "session_shutdown",
      reason: "resume",
      targetSessionFile: sessionFile,
    }, bootstrap.ctx);

    const resumed = runtime("conversation-a", sessionFile);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);
    assert.match(resumed.notices.join("\n"), /restored conversation state revision/);
    assert.deepEqual(resumed.sent, [{
      message: "durable pending message for resumed conversation",
      options: { deliverAs: "followUp" },
    }]);
    const resumedState = await readFile(`${sessionFile}.pi-review-gate-state.json`, "utf8");
    assert.match(resumedState, /preserve this request/);
    assert.doesNotMatch(resumedState, /must not leak into resumed conversation/);

    const newSessionFile = join(dir, "conversation-b.jsonl");
    await writeFile(newSessionFile, "", "utf8");
    const fresh = runtime("conversation-b", newSessionFile);
    await activate(fresh.pi);
    await trigger(fresh.hooks, "session_start", { type: "session_start", reason: "new" }, fresh.ctx);
    assert.doesNotMatch(fresh.notices.join("\n"), /restored conversation state revision/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Deterministic fake generic-cli reviewer that counts invocations and passes. */

test("a persisted review window reconciles to changed reviewer settings on reload without clearing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reconcile-ab-"));
  try {
    const alphaInvocations = join(dir, "alpha-invocations.txt");
    const betaInvocations = join(dir, "beta-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    const writeConfig = (value: Record<string, unknown>) => writeFile(configPath, JSON.stringify({ ...indexTestConfig, ...value }), "utf8");
    await writeConfig({
externalAgents: agentCatalog(
countingPassReviewer("alpha", alphaInvocations)
      ),
review: { activeReviewers: [
        { source: "external", id: "alpha" }
      ] },
    });
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    // Session 1 persists a passed review window under reviewer set A.
    const first = await runFirstReviewSession(dir, sessionFile);
    assert.match(first.notices.join("\n"), /review gate: passed/);
    assert.equal(await readFile(alphaInvocations, "utf8"), "1");

    // The user changes the reviewer settings to set B and resumes.
    await writeConfig({
externalAgents: agentCatalog(
countingPassReviewer("beta", betaInvocations)
      ),
review: { activeReviewers: [
        { source: "external", id: "beta" }
      ] },
    });

    const resumed = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    const restoredStore = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const restoredAfterStart = await restoredStore.restore(dir);
    assert.ok(restoredAfterStart?.state.reviewWindow, "reconciliation must not clear the persisted review window");
    assert.equal(restoredAfterStart.state.reviewWindow?.requestHistory[0]?.text, "implement the change");
    assert.match(
      restoredAfterStart.state.reviewWindow?.evidence.events.map((event) => event.summary).join(" ") ?? "",
      /reconcile-evidence/,
      "captured evidence must survive reconciliation",
    );
    assert.equal(restoredAfterStart.state.reviewWindow?.reviewHistory.length, 1);
    assert.equal(restoredAfterStart.state.reviewWindow?.reviewHistory[0]?.reviewerResults[0]?.reviewerId, "alpha");

    // The next turn reviews the same captured baseline/evidence with B.
    await trigger(resumed.hooks, "input", { cwd: dir, text: "continue the change", source: "user" }, resumed.ctx);
    await trigger(resumed.hooks, "before_agent_start", { cwd: dir }, resumed.ctx);
    await writeFile(join(dir, "index.ts"), "v2\n", "utf8");
    await trigger(resumed.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo second-evidence" } }, resumed.ctx);
    await triggerAgentEnd(resumed.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "second assistant summary" }],
    });

    assert.equal(await readFile(betaInvocations, "utf8"), "1", "the current reviewer set must review the preserved window");
    assert.equal(await readFile(alphaInvocations, "utf8"), "1", "a removed reviewer must never be resurrected");
    assert.match(resumed.notices.join("\n"), /review gate: passed/);

    const finalState = await restoredStore.restore(dir);
    const history = finalState?.state.reviewWindow?.reviewHistory ?? [];
    assert.equal(history.length, 2, "the completed historical result and the reconciled review are both retained");
    assert.equal(history[0]?.verdict, "pass");
    assert.equal(history[0]?.reviewerResults[0]?.reviewerId, "alpha", "history stays attributed to its original reviewer");
    assert.equal(history[1]?.reviewerResults[0]?.reviewerId, "beta");

    // A repeated reload under the same settings is idempotent: no second
    // reconciliation notice and no further state change.
    const again = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(again.pi);
    await trigger(again.hooks, "session_start", { type: "session_start", reason: "resume" }, again.ctx);
    assert.doesNotMatch(again.notices.join("\n"), /reconciled/);
    assert.match(again.notices.join("\n"), /restored conversation state revision/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("in-session reviewer settings changes reconcile open review windows without reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reconcile-insession-"));
  try {
    const alphaInvocations = join(dir, "alpha-invocations.txt");
    const betaInvocations = join(dir, "beta-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    // Both reviewers exist in the catalog; only alpha is selected initially.
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(
countingPassReviewer("alpha", alphaInvocations),
countingPassReviewer("beta", betaInvocations)
      ),
review: { activeReviewers: [
        { source: "external", id: "alpha" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    let reviewSettings: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const session = createSessionRuntime("conversation-a", sessionFile, dir, {
      reviewSettings: (handler) => { reviewSettings = handler; },
    });
    await activate(session.pi);
    assert.ok(reviewSettings, "the /review-settings command must be registered");

    await trigger(session.hooks, "session_start", { type: "session_start", reason: "startup" }, session.ctx);
    await trigger(session.hooks, "input", { cwd: dir, text: "implement the change", source: "user" }, session.ctx);
    await trigger(session.hooks, "before_agent_start", { cwd: dir }, session.ctx);
    await writeFile(join(dir, "index.ts"), "v1\n", "utf8");
    await trigger(session.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo reconcile-evidence" } }, session.ctx);
    await triggerAgentEnd(session.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "first assistant summary" }],
    });

    assert.equal(await readFile(alphaInvocations, "utf8"), "1");
    assert.match(session.notices.join("\n"), /review gate: passed/);

    // In-session settings change: swap the selection from alpha to beta via
    // the /review-settings UI. No reload happens.
    let rootMenu = 0;
    let reviewMenu = 0;
    let reviewerMenu = 0;
    await reviewSettings!("", {
      ui: {
        select: async (title: string, options: string[]) => {
          if (title === "Review settings") {
            return rootMenu++ === 0
              ? options.find((option) => option.startsWith("Reviewers"))!
              : "Save changes";
          }
          if (title === "Review") {
            // The Review submenu: open the primary reviewer picker, then Back.
            return reviewMenu++ === 0
              ? options.find((option) => option.startsWith("Primary reviewers"))!
              : "Back";
          }
          if (title.startsWith("Reviewers —")) {
            const step = reviewerMenu++;
            if (step === 0) return options.find((option) => option.startsWith("alpha [generic-cli]"))!;
            if (step === 1) return options.find((option) => option.startsWith("beta [generic-cli]"))!;
            return "Back";
          }
          return undefined;
        },
        notify() {},
      },
    });

    assert.match(
      session.notices.join("\n"),
      /1 review window\(s\) reconciled to the updated reviewer settings \(1 configured reviewer\(s\)\)/,
    );

    // The next turn reviews the same preserved window under beta.
    await trigger(session.hooks, "input", { cwd: dir, text: "continue the change", source: "user" }, session.ctx);
    await trigger(session.hooks, "before_agent_start", { cwd: dir }, session.ctx);
    await writeFile(join(dir, "index.ts"), "v2\n", "utf8");
    await trigger(session.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo second-evidence" } }, session.ctx);
    await triggerAgentEnd(session.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "second assistant summary" }],
    });

    assert.equal(await readFile(betaInvocations, "utf8"), "1", "the updated selection must review the preserved window without reload");
    assert.equal(await readFile(alphaInvocations, "utf8"), "1", "the old selection must not be resurrected");
    assert.match(session.notices.join("\n"), /review gate: passed/);

    await trigger(session.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, session.ctx);

    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const finalState = await store.restore(dir);
    const history = finalState?.state.reviewWindow?.reviewHistory ?? [];
    assert.equal(history.length, 2, "both completed reviews are retained");
    assert.equal(history[0]?.reviewerResults[0]?.reviewerId, "alpha", "history stays attributed to its original reviewer");
    assert.equal(history[1]?.reviewerResults[0]?.reviewerId, "beta");
    // Captured evidence survives the in-session reconciliation.
    assert.match(
      finalState?.state.reviewWindow?.evidence.events.map((event) => event.summary).join(" ") ?? "",
      /reconcile-evidence/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a zero-usable frozen window recovers when reviewer settings are fixed in-session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reconcile-zero-usable-"));
  try {
    const alphaInvocations = join(dir, "alpha-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    // The only selection is unresolvable: the window freezes with nothing
    // usable to run and reviews must fail closed without clearing it.
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(
countingPassReviewer("alpha", alphaInvocations)
      ),
review: { activeReviewers: [
        { source: "external", id: "gone" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    let reviewSettings: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const session = createSessionRuntime("conversation-a", sessionFile, dir, {
      reviewSettings: (handler) => { reviewSettings = handler; },
    });
    await activate(session.pi);

    await trigger(session.hooks, "session_start", { type: "session_start", reason: "startup" }, session.ctx);
    await trigger(session.hooks, "input", { cwd: dir, text: "implement the change", source: "user" }, session.ctx);
    await trigger(session.hooks, "before_agent_start", { cwd: dir }, session.ctx);
    await writeFile(join(dir, "index.ts"), "v1\n", "utf8");
    await trigger(session.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo zero-usable-evidence" } }, session.ctx);
    await triggerAgentEnd(session.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "first assistant summary" }],
    });

    assert.match(session.notices.join("\n"), /no configured reviewer is currently available/);
    await assert.rejects(access(alphaInvocations), /ENOENT/, "nothing may run while no reviewer is usable");

    // Fix the selection in-session: drop the unresolvable selection and
    // enable alpha via /review-settings — in BOTH imported sets, because the
    // legacy import copied the unresolvable selection into the subtask set
    // too. The unavailable selection stays visible (and save is rejected)
    // until it is explicitly removed.
    let rootMenu = 0;
    let reviewMenu = 0;
    let reviewerMenu = 0;
    await reviewSettings!("", {
      ui: {
        select: async (title: string, options: string[]) => {
          if (title === "Review settings") {
            return rootMenu++ === 0
              ? options.find((option) => option.startsWith("Reviewers"))!
              : "Save changes";
          }
          if (title === "Review") {
            // The Review submenu: primary picker, then subtask picker, then Back.
            const step = reviewMenu++;
            if (step === 0) return options.find((option) => option.startsWith("Primary reviewers"))!;
            if (step === 1) return options.find((option) => option.startsWith("Subtask reviewers"))!;
            return "Back";
          }
          if (title.startsWith("Reviewers —")) {
            // Flat step sequence across both picker visits: primary set first
            // (remove the unresolvable selection, enable alpha), then the
            // subtask set in the same order.
            const step = reviewerMenu++;
            if (step === 0 || step === 3) return options.find((option) => option.includes("[unavailable]"))!;
            if (step === 1 || step === 4) return options.find((option) => option.startsWith("alpha [generic-cli]"))!;
            return "Back";
          }
          return undefined;
        },
        notify() {},
      },
    });

    assert.match(session.notices.join("\n"), /1 review window\(s\) reconciled to the updated reviewer settings/);

    // The next turn runs alpha over the same preserved window — no reload.
    await trigger(session.hooks, "input", { cwd: dir, text: "continue the change", source: "user" }, session.ctx);
    await trigger(session.hooks, "before_agent_start", { cwd: dir }, session.ctx);
    await writeFile(join(dir, "index.ts"), "v2\n", "utf8");
    await trigger(session.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo second-evidence" } }, session.ctx);
    await triggerAgentEnd(session.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "second assistant summary" }],
    });

    assert.equal(await readFile(alphaInvocations, "utf8"), "1");
    assert.match(session.notices.join("\n"), /review gate: passed/);

    await trigger(session.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, session.ctx);

    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const finalState = await store.restore(dir);
    assert.match(
      finalState?.state.reviewWindow?.evidence.events.map((event) => event.summary).join(" ") ?? "",
      /zero-usable-evidence/,
      "the deferred window's evidence must survive the settings fix",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a reviewer settings change during an active invocation keeps the in-flight selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reconcile-inflight-"));
  const alphaStarted = join(dir, "alpha-started.txt");
  const alphaRelease = join(dir, "alpha-release.txt");
  const alphaEmitted = join(dir, "alpha-verdict-emitted.txt");
  // The un-awaited settle promise for the turn whose review is in flight, plus
  // a flag confirming whether it has resolved. Used both for the "still blocked
  // during the settings change" assertion and for bounded teardown.
  let settled: Promise<void> | undefined;
  let settledDone = false;
  // Kept accessible to teardown so a stuck settle can be escalated through a
  // session shutdown (which aborts the in-flight review) before the workspace
  // is deleted.
  let sessionRef: ReturnType<typeof createSessionRuntime> | undefined;
  try {
    const alphaInvocations = join(dir, "alpha-invocations.txt");
    const betaInvocations = join(dir, "beta-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(
releaseGatedCountingPassReviewer("alpha", alphaInvocations, alphaStarted, alphaRelease, alphaEmitted),
countingPassReviewer("beta", betaInvocations)
      ),
review: { activeReviewers: [
        { source: "external", id: "alpha" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    let reviewSettings: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const session = createSessionRuntime("conversation-a", sessionFile, dir, {
      reviewSettings: (handler) => { reviewSettings = handler; },
    });
    sessionRef = session;
    await activate(session.pi);

    await trigger(session.hooks, "session_start", { type: "session_start", reason: "startup" }, session.ctx);
    await trigger(session.hooks, "input", { cwd: dir, text: "implement the change", source: "user" }, session.ctx);
    await trigger(session.hooks, "before_agent_start", { cwd: dir }, session.ctx);
    await writeFile(join(dir, "index.ts"), "v1\n", "utf8");
    await trigger(session.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo inflight-evidence" } }, session.ctx);

    // Start the settle without awaiting it; alpha's invocation is in flight
    // and provably cannot finish until the parent writes the release file.
    settled = triggerAgentEnd(session.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "first assistant summary" }],
    }).finally(() => { settledDone = true; });
    // Guard against an unhandled rejection if the reviewer dies before the
    // happy-path await; awaiting `settled` below still surfaces the error.
    settled.catch(() => {});
    // Explicit readiness gate: alpha has started and recorded its invocation.
    await waitForFile(alphaStarted);

    // Swap the selection to beta while alpha is still running.
    let rootMenu = 0;
    let reviewMenu = 0;
    let reviewerMenu = 0;
    await reviewSettings!("", {
      ui: {
        select: async (title: string, options: string[]) => {
          if (title === "Review settings") {
            return rootMenu++ === 0
              ? options.find((option) => option.startsWith("Reviewers"))!
              : "Save changes";
          }
          if (title === "Review") {
            // The Review submenu: open the primary reviewer picker, then Back.
            return reviewMenu++ === 0
              ? options.find((option) => option.startsWith("Primary reviewers"))!
              : "Back";
          }
          if (title.startsWith("Reviewers —")) {
            const step = reviewerMenu++;
            if (step === 0) return options.find((option) => option.startsWith("alpha [generic-cli]"))!;
            if (step === 1) return options.find((option) => option.startsWith("beta [generic-cli]"))!;
            return "Back";
          }
          return undefined;
        },
        notify() {},
      },
    });

    // The settings save reconciled the open window while the original reviewer
    // was provably still blocked in flight.
    assert.match(
      session.notices.join("\n"),
      /1 review window\(s\) reconciled to the updated reviewer settings \(1 configured reviewer\(s\)\)/,
      "settings reconciliation must complete while the original reviewer is blocked in flight",
    );
    assert.equal(settledDone, false, "the in-flight invocation must not settle before the parent releases the reviewer");
    // Deterministic in-flight proof: the reviewer only writes its verdict
    // marker after the release gate opens, so its absence here means the
    // original invocation is provably still blocked during the settings save.
    await assert.rejects(access(alphaEmitted), /ENOENT/, "the reviewer must not have emitted a verdict before the parent released it");

    // Release the gate; the in-flight pass completes under its original selection.
    await writeFile(alphaRelease, "release\n", "utf8");
    await settled;
    assert.equal(await readFile(alphaInvocations, "utf8"), "1", "the in-flight invocation completes under its original selection");
    assert.equal(await access(betaInvocations).then(() => true, () => false), false, "beta must not join an already-started review");

    // The next turn uses the new selection.
    await trigger(session.hooks, "input", { cwd: dir, text: "continue the change", source: "user" }, session.ctx);
    await trigger(session.hooks, "before_agent_start", { cwd: dir }, session.ctx);
    await writeFile(join(dir, "index.ts"), "v2\n", "utf8");
    await trigger(session.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo second-evidence" } }, session.ctx);
    await triggerAgentEnd(session.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "second assistant summary" }],
    });

    assert.equal(await readFile(betaInvocations, "utf8"), "1");
    assert.equal(await readFile(alphaInvocations, "utf8"), "1");

    await trigger(session.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, session.ctx);

    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const finalState = await store.restore(dir);
    const history = finalState?.state.reviewWindow?.reviewHistory ?? [];
    assert.equal(history.length, 2);
    // The in-flight pass keeps alpha's identity; the later pass is beta.
    assert.equal(history[0]?.reviewerResults[0]?.reviewerId, "alpha");
    assert.equal(history[0]?.reviewerResults[0]?.displayLabel, "alpha", "the result is stamped with the configuration that ran it");
    assert.equal(history[1]?.reviewerResults[0]?.reviewerId, "beta");
  } finally {
    if (sessionRef && settled && !settledDone) {
      // Bounded teardown on assertion failure: release the gate so the
      // reviewer can finish normally, then await settlement. If a bounded
      // grace period expires first, escalate to session shutdown — which
      // aborts the in-flight review and kills its child (the reviewer's own
      // timeoutMs is the hard backstop) — and still await the original settle
      // so no test-owned work outlives this test. The workspace is deleted
      // only after settlement completes.
      try { await writeFile(alphaRelease, "release\n", "utf8"); } catch { /* release is best-effort */ }
      let graceTimer: NodeJS.Timeout | undefined;
      const grace = new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, 3000);
      });
      await Promise.race([settled.catch(() => {}), grace]);
      clearTimeout(graceTimer);
      if (!settledDone) {
        // Grace expired: the settle is stuck. Shut the session down to abort
        // the in-flight review, then await the original settle before
        // deleting anything.
        await trigger(
          sessionRef.hooks,
          "session_shutdown",
          { type: "session_shutdown", reason: "quit" },
          sessionRef.ctx,
        ).catch(() => {});
        await settled.catch(() => {});
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("a superseded-format sidecar keeps historical identities honest after reconciliation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reconcile-legacy-"));
  try {
    const oneInvocationsA = join(dir, "one-a-invocations.txt");
    const oneInvocationsB = join(dir, "one-b-invocations.txt");
    const promptB = join(dir, "prompt-b.txt");
    const configPath = join(dir, "review-gate.json");
    // Session 1: reviewer id "one" under identity A.
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(
countingPassReviewerWithPromptDump("one", oneInvocationsA, join(dir, "prompt-a.txt"))
      ),
review: { activeReviewers: [
        { source: "external", id: "one" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const first = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dir, text: "implement the change", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dir }, first.ctx);
    await writeFile(join(dir, "index.ts"), "v1\n", "utf8");
    await trigger(first.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo legacy-evidence" } }, first.ctx);
    await triggerAgentEnd(first.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "first assistant summary" }],
    });
    assert.equal(await readFile(oneInvocationsA, "utf8"), "1");
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    // Simulate a superseded-format sidecar: the persisted history entries
    // carry no displayLabel at all. Strip the field and recompute the
    // integrity hash over the modified document (same canonical form the
    // store uses).
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const raw = JSON.parse(await readFile(store.path, "utf8")) as Record<string, unknown>;
    stripDisplayLabels(raw);
    const { integritySha256: _integrity, ...unsigned } = raw;
    raw.integritySha256 = createHash("sha256").update(stableJsonForTest(JSON.parse(JSON.stringify(unsigned)))).digest("hex");
    await writeFile(store.path, `${JSON.stringify(raw)}\n`, "utf8");

    // Session 2: the same reviewer id now has a different identity (B).
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(
countingPassReviewerWithPromptDump("one", oneInvocationsB, promptB)
      ),
review: { activeReviewers: [
        { source: "external", id: "one" }
      ] },
    }), "utf8");

    const resumed = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    // Restore must not backfill the missing historical identity from B.
    const restored = await store.restore(dir);
    assert.equal(
      restored?.state.reviewWindow?.reviewHistory[0]?.reviewerResults[0]?.displayLabel,
      undefined,
      "a superseded-format result must stay honestly unlabeled",
    );

    // The next turn reviews the preserved window under identity B.
    await trigger(resumed.hooks, "input", { cwd: dir, text: "continue the change", source: "user" }, resumed.ctx);
    await trigger(resumed.hooks, "before_agent_start", { cwd: dir }, resumed.ctx);
    await writeFile(join(dir, "index.ts"), "v2\n", "utf8");
    await trigger(resumed.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo second-evidence" } }, resumed.ctx);
    await triggerAgentEnd(resumed.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "second assistant summary" }],
    });

    assert.equal(await readFile(oneInvocationsB, "utf8"), "1");
    const prompt = await readFile(promptB, "utf8");
    // The request context renders the legacy entry by its raw stored id.
    assert.match(prompt, /- one \(pass\): one passed/);

    await trigger(resumed.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, resumed.ctx);

    const finalState = await store.restore(dir);
    const history = finalState?.state.reviewWindow?.reviewHistory ?? [];
    assert.equal(history.length, 2);
    assert.equal(
      history[0]?.reviewerResults[0]?.displayLabel,
      undefined,
      "the legacy entry must not be backfilled after the reconciled review",
    );
    assert.equal(history[1]?.reviewerResults[0]?.displayLabel, "one", "new results are stamped with their running identity");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a persisted review window reconciles with a label/count-only notice and no prompts or secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reconcile-notice-"));
  try {
    const alphaInvocations = join(dir, "alpha-invocations.txt");
    const betaInvocations = join(dir, "beta-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(
countingPassReviewer("alpha", alphaInvocations)
      ),
review: { activeReviewers: [
        { source: "external", id: "alpha" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const first = await runFirstReviewSession(dir, sessionFile);
    assert.match(first.notices.join("\n"), /review gate: passed/);

    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(
countingPassReviewer("beta", betaInvocations)
      ),
review: { activeReviewers: [
        { source: "external", id: "beta" }
      ] },
    }), "utf8");

    const resumed = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    const noticeText = resumed.notices.join("\n");
    assert.match(noticeText, /reconciled 1 review window/);
    assert.match(noticeText, /1 configured reviewer/);
    assert.doesNotMatch(noticeText, /clear or reconcile/);
    assert.doesNotMatch(noticeText, /reviewer selection error/);
    // The notice labels and counts only: no request text, evidence content,
    // or prior review summaries may be disclosed.
    assert.doesNotMatch(noticeText, /implement the change/);
    assert.doesNotMatch(noticeText, /reconcile-evidence/);
    assert.doesNotMatch(noticeText, /alpha passed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a stale reviewer selection reconciles with bounded outcomes while healthy reviewers run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reconcile-stale-"));
  try {
    const alphaInvocations = join(dir, "alpha-invocations.txt");
    const betaInvocations = join(dir, "beta-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(
countingPassReviewer("alpha", alphaInvocations)
      ),
review: { activeReviewers: [
        { source: "external", id: "alpha" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const first = await runFirstReviewSession(dir, sessionFile);
    assert.match(first.notices.join("\n"), /review gate: passed/);

    // Set B renames/replaces the reviewer but leaves a stale selection behind.
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(
countingPassReviewer("beta", betaInvocations)
      ),
review: { activeReviewers: [
        { source: "external", id: "beta" },
        { source: "external", id: "gone" }
      ] },
    }), "utf8");

    const resumed = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);
    await trigger(resumed.hooks, "input", { cwd: dir, text: "continue the change", source: "user" }, resumed.ctx);
    await trigger(resumed.hooks, "before_agent_start", { cwd: dir }, resumed.ctx);
    await writeFile(join(dir, "index.ts"), "v2\n", "utf8");
    await triggerAgentEnd(resumed.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "second assistant summary" }],
    });

    // Documented aggregation policy is unchanged through reconciliation:
    // at least one completed pass with another unavailable selection passes
    // with warnings instead of silently dropping the unresolved selection.
    assert.equal(await readFile(betaInvocations, "utf8"), "1", "the healthy reviewer must still run");
    assert.match(resumed.notices.join("\n"), /passed with reviewer warnings/);

    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const state = await store.restore(dir);
    const history = state?.state.reviewWindow?.reviewHistory ?? [];
    assert.equal(history.length, 2);
    const latest = history.at(-1);
    assert.equal(latest?.verdict, "pass");
    assert.deepEqual(
      latest?.reviewerResults.map((result) => ({ reviewerId: result.reviewerId, verdict: result.verdict })),
      [
        { reviewerId: "beta", verdict: "pass" },
        { reviewerId: "external:gone", verdict: "error" },
      ],
      "the stale selection keeps an explicit bounded error outcome",
    );
    assert.equal(latest?.reviewerResults[1]?.error, "reviewer_unavailable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a persisted window with zero usable reviewers is retained with an actionable notice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reconcile-zero-"));
  try {
    const alphaInvocations = join(dir, "alpha-invocations.txt");
    const betaInvocations = join(dir, "beta-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(
countingPassReviewer("alpha", alphaInvocations)
      ),
review: { activeReviewers: [
        { source: "external", id: "alpha" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const first = await runFirstReviewSession(dir, sessionFile);
    assert.match(first.notices.join("\n"), /review gate: passed/);

    // Set B references only a stale selection: no reviewer can be invoked.
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(
countingPassReviewer("beta", betaInvocations)
      ),
review: { activeReviewers: [
        { source: "external", id: "gone" }
      ] },
    }), "utf8");

    const resumed = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);
    await trigger(resumed.hooks, "input", { cwd: dir, text: "continue the change", source: "user" }, resumed.ctx);
    await trigger(resumed.hooks, "before_agent_start", { cwd: dir }, resumed.ctx);
    await writeFile(join(dir, "index.ts"), "v2\n", "utf8");
    await triggerAgentEnd(resumed.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "second assistant summary" }],
    });

    // Fail closed without clearing: the preserved window stays open and the
    // notice is actionable (counts/labels only).
    assert.match(resumed.notices.join("\n"), /no configured reviewer is currently available/);
    assert.doesNotMatch(resumed.notices.join("\n"), /clear or reconcile/);
    assert.equal(await readFile(betaInvocations, "utf8").catch(() => "absent"), "absent", "nothing may run without a usable reviewer");

    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const state = await store.restore(dir);
    assert.ok(state?.state.reviewWindow, "the review window must not be auto-cleared for zero usable reviewers");
    assert.equal(state.state.reviewWindow?.requestHistory[0]?.text, "implement the change");
    assert.match(
      state.state.reviewWindow?.evidence.events.map((event) => event.summary).join(" ") ?? "",
      /reconcile-evidence/,
    );
    assert.equal(state.state.reviewWindow?.reviewHistory.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a persisted window reconciles to an added reviewer and runs the whole current set", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-reconcile-added-"));
  try {
    const alphaInvocations = join(dir, "alpha-invocations.txt");
    const betaInvocations = join(dir, "beta-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(
countingPassReviewer("alpha", alphaInvocations)
      ),
review: { activeReviewers: [
        { source: "external", id: "alpha" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const first = await runFirstReviewSession(dir, sessionFile);
    assert.match(first.notices.join("\n"), /review gate: passed/);
    assert.equal(await readFile(alphaInvocations, "utf8"), "1");

    // Set B adds a second reviewer alongside the original one.
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(
countingPassReviewer("alpha", alphaInvocations),
countingPassReviewer("beta", betaInvocations)
      ),
review: { activeReviewers: [
        { source: "external", id: "alpha" },
        { source: "external", id: "beta" }
      ] },
    }), "utf8");

    const resumed = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);
    assert.match(resumed.notices.join("\n"), /reconciled 1 review window/);

    await trigger(resumed.hooks, "input", { cwd: dir, text: "continue the change", source: "user" }, resumed.ctx);
    await trigger(resumed.hooks, "before_agent_start", { cwd: dir }, resumed.ctx);
    await writeFile(join(dir, "index.ts"), "v2\n", "utf8");
    await triggerAgentEnd(resumed.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "second assistant summary" }],
    });

    // Both current reviewers review the preserved window.
    assert.equal(await readFile(alphaInvocations, "utf8"), "2");
    assert.equal(await readFile(betaInvocations, "utf8"), "1");
    assert.match(resumed.notices.join("\n"), /review gate: passed/);

    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const state = await store.restore(dir);
    const latest = state?.state.reviewWindow?.reviewHistory.at(-1)?.reviewerResults ?? [];
    assert.deepEqual(
      latest.map((result) => result.reviewerId).sort(),
      ["alpha", "beta"],
      "the reconciled review records every current reviewer",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same-conversation/different-cwd session start quarantines the prior sidecar and starts fresh", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "pi-review-gate-cwd-mismatch-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "pi-review-gate-cwd-mismatch-b-"));
  const dirC = await mkdtemp(join(tmpdir(), "pi-review-gate-cwd-mismatch-c-"));
  try {
    const configPath = join(dirA, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dirA, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    // First session in dirA persists state with a pending delivery.
    const first = createSessionRuntime("conversation-a", sessionFile, dirA);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dirA, text: "preserve this request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dirA }, first.ctx);
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    const statePath = `${sessionFile}.pi-review-gate-state.json`;
    const targetStore = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dirA });
    const targetState = await targetStore.restore(dirA);
    assert.ok(targetState);
    queueModelDelivery(targetState.state, {
      kind: "review_authorization",
      channel: "follow_up",
      message: "durable pending message for the prior cwd",
    });
    // Re-freeze the restored window against the same settings the runtime
    // loaded and save with the frozen config so the sidecar carries the
    // canonical selection digest, exactly as the production runtime persists it.
    freezeReviewWindowConfig(targetState.state, normalizeConfig(JSON.parse(await readFile(configPath, "utf8"))));
    await targetStore.save(targetState.state, targetState.execution, targetState.state.reviewWindow?.reviewConfig);
    const priorBytes = await readFile(statePath, "utf8");

    // Second session: same conversation, different cwd (dirB).
    const resumed = createSessionRuntime("conversation-a", sessionFile, dirB);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    assert.deepEqual(resumed.sent, [], "no old follow-up may be delivered into a different cwd");
    const noticeText = resumed.notices.join("\n");
    assert.match(noticeText, /different working directory/);
    assert.match(noticeText, /quarantined to/);
    assert.match(noticeText, /1 pending delivery record\(s\) preserved/);
    assert.match(noticeText, /review_authorization 1/);
    assert.doesNotMatch(noticeText, /durable pending message for the prior cwd/);
    assert.doesNotMatch(noticeText, /restored conversation state revision/);

    const quarantineFiles = (await readdir(dirA)).filter((name) => name.includes(".quarantine-"));
    assert.equal(quarantineFiles.length, 1);
    assert.equal(
      await readFile(join(dirA, quarantineFiles[0]!), "utf8"),
      priorBytes,
      "quarantine preserves the exact prior sidecar bytes",
    );

    const freshText = await readFile(statePath, "utf8");
    assert.doesNotMatch(freshText, /durable pending message for the prior cwd/);
    assert.doesNotMatch(freshText, /preserve this request/);
    assert.match(freshText, new RegExp(`"cwd":"${escapeRegExp(dirB)}"`));
    const freshState = await targetStore.restore(dirB);
    assert.ok(freshState);
    assert.equal(freshState.state.pendingModelDeliveries.length, 0, "fresh state is isolated from prior pending records");

    // Third session: repeated mismatch (dirC) must not clobber the first quarantine.
    const secondBytes = freshText;
    const again = createSessionRuntime("conversation-a", sessionFile, dirC);
    await activate(again.pi);
    await trigger(again.hooks, "session_start", { type: "session_start", reason: "resume" }, again.ctx);
    assert.deepEqual(again.sent, []);
    const quarantineFiles2 = (await readdir(dirA)).filter((name) => name.includes(".quarantine-"));
    assert.equal(quarantineFiles2.length, 2, "repeated mismatch creates a new quarantine without clobbering prior ones");
    const contents = new Set(await Promise.all(quarantineFiles2.map((name) => readFile(join(dirA, name), "utf8"))));
    assert.ok(contents.has(priorBytes), "first quarantine keeps the exact prior bytes");
    assert.ok(contents.has(secondBytes), "second quarantine holds the intermediate fresh state");
    const finalText = await readFile(statePath, "utf8");
    assert.match(finalText, new RegExp(`"cwd":"${escapeRegExp(dirC)}"`));
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
    await rm(dirC, { recursive: true, force: true });
  }
});

test("quarantine failure leaves the prior sidecar untouched and disables persistence", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("permission-based tests require a non-root POSIX user");
    return;
  }
  const dirA = await mkdtemp(join(tmpdir(), "pi-review-gate-quarantine-fail-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "pi-review-gate-quarantine-fail-b-"));
  try {
    const configPath = join(dirA, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dirA, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const first = createSessionRuntime("conversation-a", sessionFile, dirA);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dirA, text: "preserve this request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dirA }, first.ctx);
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    const statePath = `${sessionFile}.pi-review-gate-state.json`;
    const priorBytes = await readFile(statePath, "utf8");

    // Make the sidecar's directory read-only so quarantine (link) fails.
    await chmod(dirA, 0o555);

    const resumed = createSessionRuntime("conversation-a", sessionFile, dirB);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    assert.deepEqual(resumed.sent, [], "no old follow-up may be delivered");
    const noticeText = resumed.notices.join("\n");
    assert.match(noticeText, /could not be quarantined/);
    assert.match(noticeText, /left untouched/);
    assert.match(noticeText, /persistence is disabled/);
    assert.equal(await readFile(statePath, "utf8"), priorBytes, "original sidecar must be untouched");
    const quarantineFiles = (await readdir(dirA)).filter((name) => name.includes(".quarantine-"));
    assert.deepEqual(quarantineFiles, [], "no quarantine file may be created");

    // No later save: a subsequent input must not overwrite the prior sidecar.
    await trigger(resumed.hooks, "input", { cwd: dirB, text: "must not be persisted", source: "user" }, resumed.ctx);
    assert.equal(await readFile(statePath, "utf8"), priorBytes, "no later save may overwrite the prior sidecar");
  } finally {
    await chmod(dirA, 0o755).catch(() => undefined);
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("a corrupted prior sidecar is preserved in place and persistence is disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-corrupt-sidecar-"));
  try {
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const first = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dir, text: "preserve this request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dir }, first.ctx);
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    const statePath = `${sessionFile}.pi-review-gate-state.json`;
    const priorBytes = await readFile(statePath, "utf8");

    // Corrupt the sidecar so restore fails its integrity check.
    const corrupted = JSON.parse(priorBytes) as { state: { reviewsPaused: boolean } };
    corrupted.state.reviewsPaused = !corrupted.state.reviewsPaused;
    const corruptedBytes = `${JSON.stringify(corrupted)}\n`;
    await writeFile(statePath, corruptedBytes, "utf8");

    const resumed = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    assert.deepEqual(resumed.sent, [], "no follow-up may be delivered from a failed restore");
    const noticeText = resumed.notices.join("\n");
    assert.match(noticeText, /was not restored/);
    assert.match(noticeText, /left untouched/);
    assert.match(noticeText, /persistence is disabled/);
    assert.equal(await readFile(statePath, "utf8"), corruptedBytes, "corrupted sidecar must be preserved in place");

    // No later save may overwrite the corrupted sidecar.
    await trigger(resumed.hooks, "input", { cwd: dir, text: "must not be persisted", source: "user" }, resumed.ctx);
    assert.equal(await readFile(statePath, "utf8"), corruptedBytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a throwing notifier cannot disable persistence after a successful quarantine", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "pi-review-gate-notice-fail-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "pi-review-gate-notice-fail-b-"));
  try {
    const configPath = join(dirA, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dirA, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const first = createSessionRuntime("conversation-a", sessionFile, dirA);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dirA, text: "preserve this request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dirA }, first.ctx);
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    const statePath = `${sessionFile}.pi-review-gate-state.json`;
    const priorBytes = await readFile(statePath, "utf8");

    // Second session in dirB: the notifier throws exactly once (on the
    // quarantine success notice), then recovers.
    const resumed = createSessionRuntime("conversation-a", sessionFile, dirB);
    let notifyCalls = 0;
    resumed.ctx.ui.notify = (message: string) => {
      notifyCalls += 1;
      if (notifyCalls === 1) throw new Error("notifier exploded");
      return resumed.notices.push(message);
    };
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    assert.ok(notifyCalls >= 1, "the quarantine notice was attempted");
    assert.deepEqual(resumed.sent, [], "no old follow-up may be delivered");
    const quarantineFiles = (await readdir(dirA)).filter((name) => name.includes(".quarantine-"));
    assert.equal(quarantineFiles.length, 1, "quarantine succeeds despite the throwing notifier");
    assert.equal(
      await readFile(join(dirA, quarantineFiles[0]!), "utf8"),
      priorBytes,
      "quarantine preserves the exact prior sidecar bytes",
    );

    // Notification failure must not disable the store after quarantine
    // succeeded: the fresh save for the new cwd still proceeds.
    const freshText = await readFile(statePath, "utf8");
    assert.match(freshText, new RegExp(`"cwd":"${escapeRegExp(dirB)}"`));
    await trigger(resumed.hooks, "input", { cwd: dirB, text: "later input persists", source: "user" }, resumed.ctx);
    const laterText = await readFile(statePath, "utf8");
    assert.notEqual(laterText, freshText, "persistence stays enabled after the notice failure");
    assert.match(laterText, /later input persists/);
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test("malformed sidecar JSON never leaks content or unbounded paths into restore notices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-bad-json-"));
  try {
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      ...indexTestConfig,
      review: { activeReviewers: [] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    // A deeply nested session directory pushes the sidecar path past the
    // notice-path bound so truncation can be asserted.
    let deep = dir;
    for (let i = 0; i < 3; i += 1) {
      deep = join(deep, `segment-${i}-${"x".repeat(50)}`);
    }
    await mkdir(deep, { recursive: true });
    const sessionFile = join(deep, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const first = createSessionRuntime("conversation-a", sessionFile, deep);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: deep, text: "preserve this request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: deep }, first.ctx);
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    const statePath = `${sessionFile}.pi-review-gate-state.json`;
    assert.ok(statePath.length > 160, "test setup: sidecar path exceeds the notice path bound");

    // Corrupt the sidecar into invalid JSON that carries a secret sentinel:
    // a raw JSON.parse error would quote this text into the notice.
    const sentinel = "SECRET-SENTINEL-pending-message-text";
    const corruptedBytes = `{ "state": { "pendingModelDeliveries": [{ "message": "${sentinel}`;
    await writeFile(statePath, corruptedBytes, "utf8");

    const resumed = createSessionRuntime("conversation-a", sessionFile, deep);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    const noticeText = resumed.notices.join("\n");
    assert.match(noticeText, /was not restored/);
    assert.match(noticeText, /invalid JSON/);
    assert.doesNotMatch(noticeText, new RegExp(sentinel), "sidecar content may never reach the notice");
    assert.ok(statePath.length > 160 && !noticeText.includes(statePath), "unbounded paths may never reach the notice");
    assert.match(noticeText, /… \(truncated\)/);
    assert.match(noticeText, /persistence is disabled/);

    // The malformed sidecar is preserved in place; no later save overwrites it.
    assert.equal(await readFile(statePath, "utf8"), corruptedBytes, "malformed sidecar must be preserved in place");
    await trigger(resumed.hooks, "input", { cwd: deep, text: "must not be persisted", source: "user" }, resumed.ctx);
    assert.equal(await readFile(statePath, "utf8"), corruptedBytes, "no later save may overwrite the malformed sidecar");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("sidecars whose review window lacks the selection digest are rejected at restore without upgrading them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-missing-digest-"));
  try {
    const invocations = join(dir, "invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(countingPassReviewerWithPromptDump("one", invocations, join(dir, "prompt.txt"))),
review: { activeReviewers: [
        { source: "external", id: "one" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    // Session 1: establish a persisted review window (baseline + history).
    const first = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dir, text: "implement the change", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dir }, first.ctx);
    await writeFile(join(dir, "index.ts"), "v1\n", "utf8");
    await trigger(first.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo evidence" } }, first.ctx);
    await triggerAgentEnd(first.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "first assistant summary" }],
    });
    assert.equal(await readFile(invocations, "utf8"), "1");
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    // Simulate an old-only sidecar: the review window is persisted but the
    // reviewer-selection digest field is absent. Strip it and recompute the
    // integrity hash over the modified document (same canonical form).
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const raw = JSON.parse(await readFile(store.path, "utf8")) as Record<string, unknown>;
    delete raw.reviewerSelectionDigest;
    const { integritySha256: _integrity, ...unsigned } = raw;
    raw.integritySha256 = createHash("sha256").update(stableJsonForTest(JSON.parse(JSON.stringify(unsigned)))).digest("hex");
    await writeFile(store.path, `${JSON.stringify(raw)}\n`, "utf8");
    const oldOnlyBytes = await readFile(store.path);

    // Session 2: the unsupported shape is rejected before state is applied.
    const resumed = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    // Explicit actionable local failure; no restored-state notice.
    assert.match(
      resumed.notices.join("\n"),
      /persisted conversation state was not restored \(unsupported pre-cutover session format \(missing reviewer-selection digest\)\)/,
    );
    assert.doesNotMatch(resumed.notices.join("\n"), /restored conversation state revision/);
    assert.match(resumed.notices.join("\n"), /state file was left untouched at/);
    assert.match(resumed.notices.join("\n"), /persistence is disabled for this session/);

    // The application keeps operating and the review gate still enforces: a
    // fresh turn runs a full automatic review under the current configuration.
    await trigger(resumed.hooks, "input", { cwd: dir, text: "continue the change", source: "user" }, resumed.ctx);
    await trigger(resumed.hooks, "before_agent_start", { cwd: dir }, resumed.ctx);
    await writeFile(join(dir, "index.ts"), "v2\n", "utf8");
    await trigger(resumed.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo more" } }, resumed.ctx);
    await triggerAgentEnd(resumed.hooks, {
      cwd: dir,
      messages: [{ role: "assistant", content: "second assistant summary" }],
    });
    assert.equal(await readFile(invocations, "utf8"), "2");
    assert.match(resumed.notices.join("\n"), /review gate: passed/);

    // The old-only sidecar was never upgraded on read: byte-for-byte intact
    // even after the session ran (persistence is disabled for it).
    assert.deepEqual(await readFile(store.path), oldOnlyBytes);
  } finally {
    process.env.PI_REVIEW_GATE_CONFIG = "";
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued inputs without durable delivery records are reported unreleasable, preserved, and never replayed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-mixed-queued-"));
  try {
    const invocations = join(dir, "invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
...indexTestConfig,
externalAgents: agentCatalog(countingPassReviewerWithPromptDump("one", invocations, join(dir, "prompt.txt"))),
review: { activeReviewers: [
        { source: "external", id: "one" }
      ] },
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const sessionFile = join(dir, "conversation-a.jsonl");
    await writeFile(sessionFile, "", "utf8");

    // Session 1: establish a review window with a baseline, then shut down.
    const first = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(first.pi);
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await trigger(first.hooks, "input", { cwd: dir, text: "initial request", source: "user" }, first.ctx);
    await trigger(first.hooks, "before_agent_start", { cwd: dir }, first.ctx);
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    // Simulate a crash during review: one queued input has its active durable
    // delivery record, the other predates durable delivery tracking and has
    // none. The raw document is rewritten (with its integrity hash recomputed)
    // so every other field — including the reviewer-selection digest — stays
    // exactly as the first session saved it.
    const store = new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir });
    const rawPersisted = JSON.parse(await readFile(store.path, "utf8"));
    rawPersisted.state.queuedUserInputsDuringReview = ["canonical mid-review direction", "legacy mid-review direction"];
    rawPersisted.state.pendingModelDeliveries = [{
      deliveryId: "queued-user-input:test-window:1",
      kind: "queued_user_input",
      channel: "follow_up",
      message: "canonical mid-review direction",
      status: "queued",
      createdAt: new Date().toISOString(),
    }];
    const { integritySha256: _integrity, ...unsignedPersisted } = rawPersisted;
    rawPersisted.integritySha256 = createHash("sha256").update(stableJsonForTest(JSON.parse(JSON.stringify(unsignedPersisted)))).digest("hex");
    await writeFile(store.path, `${JSON.stringify(rawPersisted)}\n`, "utf8");

    // Resumed session: the recovery notice must split the occurrences — it
    // may promise a /review-now release only for the one with an active
    // record, and must identify the other as unreleasable but preserved.
    const resumed = createSessionRuntime("conversation-a", sessionFile, dir);
    await activate(resumed.pi);
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);
    assert.match(
      resumed.notices.join("\n"),
      /2 user input\(s\) remain queued from an interrupted review and were not reordered automatically; 1 of them can be released by finishing the interrupted review with \/review-now, but 1 cannot be released automatically because no active durable delivery record exists for them; all of them stay preserved until cancelled with \/review-clear/,
    );

    // Finish the interrupted review: it passes, releasing exactly the input
    // that has an active durable delivery record.
    await trigger(resumed.hooks, "agent_end", { cwd: dir }, resumed.ctx);
    await trigger(resumed.hooks, "agent_settled", { cwd: dir }, resumed.ctx);

    assert.equal(await readFile(invocations, "utf8"), "1");
    assert.match(resumed.notices.join("\n"), /review gate: passed/);
    const sentMessages = resumed.sent.map((entry) => entry.message);
    assert.equal(
      sentMessages.filter((message) => message === "canonical mid-review direction").length,
      1,
      "the queued input with an active delivery record is released exactly once",
    );
    assert.ok(
      !sentMessages.some((message) => message === "legacy mid-review direction"),
      "the old-only occurrence is never dispatched or replayed",
    );
    // Review completion identifies the unreleased occurrence explicitly.
    assert.match(
      resumed.notices.join("\n"),
      /review gate: 1 queued user input\(s\) were not released because no active durable delivery record exists for them; they stay preserved and can be cancelled with \/review-clear/,
    );

    // The old-only occurrence stays preserved in the ledger with no delivery
    // record fabricated for it.
    const persisted = JSON.parse(await readFile(store.path, "utf8")) as {
      state: { queuedUserInputsDuringReview: string[]; pendingModelDeliveries: Array<{ kind: string; status: string; message: string }> };
    };
    assert.deepEqual(persisted.state.queuedUserInputsDuringReview, ["legacy mid-review direction"]);
    const canonicalDelivery = persisted.state.pendingModelDeliveries.find((delivery) => delivery.message === "canonical mid-review direction");
    assert.equal(canonicalDelivery?.status, "delivered");
    assert.ok(!persisted.state.pendingModelDeliveries.some((delivery) => delivery.message === "legacy mid-review direction"));
  } finally {
    process.env.PI_REVIEW_GATE_CONFIG = "";
    await rm(dir, { recursive: true, force: true });
  }
});
