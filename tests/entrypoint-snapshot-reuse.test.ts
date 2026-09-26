// Issue #193 lifecycle integration: safe snapshot reuse across ordinary new
// exchanges. The first capture of a new unseeded exchange reuses verified
// facts from the last successfully completed same-root snapshot, retained in
// a bounded session-local cache across normal review-window close. These
// entrypoint tests drive the real activate() hooks and prove: cross-window
// reuse with unchanged workspaces (retained record identity), fresh correct
// baselines for edit/add/delete workspaces (fresh-capture equality oracle),
// no reuse across sessions or roots, no cache poisoning from a failed
// capture, limits changed mid-session through the real /review-settings Save
// recomputing retain/omit against the reuse source, and unchanged seeded
// follow-up skip behavior. Reuse-source safety itself (per-entry
// re-verification) is owned by the capture helper tests in
// tests/capture.test.ts.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import * as captureModule from "../src/capture";
import { compareSnapshots, createWorkspaceSnapshot, type FileSnapshot, type WorkspaceSnapshot } from "../src/capture";
import { activate } from "../src/index";
import { CompletedSnapshotCache } from "../src/snapshot-reuse";
import { SessionStateStore } from "../src/session-state";
import { agentCatalog } from "./helpers";
import { countingPassReviewer, indexTestConfig, trigger, triggerAgentEnd } from "./entrypoint-harness";

interface ReuseRuntime {
  hooks: Map<string, Array<(...args: unknown[]) => unknown>>;
  notices: string[];
  sent: Array<{ message: string; options: unknown }>;
  commands: Map<string, (args: string, ctx: unknown) => Promise<void>>;
  pi: Record<string, unknown>;
  ctx: Record<string, unknown>;
}

/** Minimal top-level host mirroring the other entrypoint suites. */
function createReuseRuntime(sessionId: string | undefined, sessionFile: string | undefined, cwd: string): ReuseRuntime {
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const notices: string[] = [];
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  const sent: Array<{ message: string; options: unknown }> = [];
  const pi: Record<string, unknown> = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, options.handler);
    },
    notify(message: string) { notices.push(message); },
    sendUserMessage(message: string, options: unknown) { sent.push({ message, options }); },
  };
  const ctx: Record<string, unknown> = { cwd, ui: { notify: (message: string) => notices.push(message) } };
  if (sessionId !== undefined && sessionFile !== undefined) {
    pi.appendEntry = () => { /* persistence is observed through the sidecar store */ };
    ctx.sessionManager = {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getCwd: () => cwd,
    };
  }
  return { hooks, notices, sent, commands, pi, ctx };
}

/**
 * Write the review-gate config into the captured workspace (stable for the
 * whole test) but keep the reviewer invocation counter outside it: a counter
 * file inside a captured root would self-reference between baselines and turn
 * an unchanged response into a reviewable change.
 */
async function writeFakeReviewerConfig(dir: string, artifactsDir: string): Promise<void> {
  const invocationPath = join(artifactsDir, "reviewer-invocations.txt");
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify({
    ...indexTestConfig,
    externalAgents: agentCatalog(countingPassReviewer("fake", invocationPath)),
    review: {
      primaryReviewers: [{ source: "external", id: "fake" }],
      subtaskReviewers: [{ source: "external", id: "fake" }],
    },
  }), "utf8");
  process.env.PI_REVIEW_GATE_CONFIG = configPath;
}

/** A user-submitted turn: input, baseline capture, optional agent file work, settlement. */
async function runUserTurn(
  rt: ReuseRuntime,
  dir: string,
  request: string,
  file?: { name: string; content: string },
): Promise<void> {
  await trigger(rt.hooks, "input", { cwd: dir, text: request, source: "user" }, rt.ctx);
  await trigger(rt.hooks, "before_agent_start", { cwd: dir });
  if (file) {
    await writeFile(join(dir, file.name), file.content, "utf8");
    await trigger(rt.hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: `echo ${file.name}` } });
  }
  await triggerAgentEnd(rt.hooks, {
    cwd: dir,
    messages: [{ role: "assistant", content: `completed: ${request}` }],
  });
}

/** The implementing model's response to a transmitted verdict: no workspace changes. */
async function runResponseTurn(rt: ReuseRuntime, dir: string): Promise<void> {
  await trigger(rt.hooks, "before_agent_start", { cwd: dir });
  await triggerAgentEnd(rt.hooks, {
    cwd: dir,
    messages: [{ role: "assistant", content: "acknowledged the review" }],
  });
}

/** Open just the new unseeded exchange (input + baseline capture) without settling. */
async function beginUnseededExchange(rt: ReuseRuntime, dir: string, request: string): Promise<void> {
  await trigger(rt.hooks, "input", { cwd: dir, text: request, source: "user" }, rt.ctx);
  await trigger(rt.hooks, "before_agent_start", { cwd: dir });
}

/** Run the ordinary two-exchange cycle that ends in a normal window close. */
async function runClosedWindowCycle(
  rt: ReuseRuntime,
  dir: string,
  firstFile: { name: string; content: string },
): Promise<void> {
  await runUserTurn(rt, dir, "request A", firstFile);
  assert.match(rt.notices.join("\n"), /review gate: passed/, "the first exchange passes review");
  assert.equal(rt.sent.length, 1, "the pass is transmitted to the implementing model");
  // The unchanged response checkpoints and closes the window normally.
  await runResponseTurn(rt, dir);
}

/** Observable seam over a real cache: records every reuse-source request. */
function createSeam() {
  const inner = new CompletedSnapshotCache();
  const reuseCalls: Array<{ cwd: string; returned: WorkspaceSnapshot | undefined }> = [];
  let rememberCount = 0;
  return {
    inner,
    reuseCalls,
    get rememberCount(): number { return rememberCount; },
    snapshotReuse: {
      remember: (snapshot: WorkspaceSnapshot) => {
        rememberCount += 1;
        inner.remember(snapshot);
      },
      reuseSourceFor: (cwd: string) => {
        const returned = inner.reuseSourceFor(cwd);
        reuseCalls.push({ cwd, returned });
        return returned;
      },
      clear: () => inner.clear(),
      current: () => inner.current(),
    },
  };
}

// Decision-relevant fields of a record — what a review consumer observes
// (mirrors the fresh-snapshot equality oracle in tests/capture.test.ts).
function decisionFields(file: FileSnapshot | undefined) {
  if (!file) return undefined;
  return {
    exists: file.exists,
    size: file.size,
    entryType: file.entryType,
    sha256: file.sha256,
    isBinary: file.isBinary,
    content: file.content,
    omittedReason: file.omittedReason,
    linkTarget: file.linkTarget,
    gitObjectId: file.gitObjectId,
  };
}

function assertSnapshotsEquivalent(fresh: WorkspaceSnapshot, reused: WorkspaceSnapshot): void {
  const freshPaths = [...fresh.files.keys()].sort();
  assert.deepEqual([...reused.files.keys()].sort(), freshPaths, "reuse must cover exactly the fresh path set");
  for (const path of freshPaths) {
    assert.deepEqual(
      decisionFields(reused.files.get(path)),
      decisionFields(fresh.files.get(path)),
      `path ${path} must match the fresh capture`,
    );
  }
}

test("ordinary exchanges separated by a normal window close reuse the prior completed snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-reuse-lifecycle-"));
  // The session file (and its persistence sidecar) lives outside the captured
  // workspace so state saves never self-reference inside review baselines.
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-review-reuse-session-"));
  const sessionFile = join(sessionDir, "conversation-a.jsonl");
  try {
    await writeFile(join(dir, "a.txt"), "one\n", "utf8");
    await writeFile(join(dir, "b.txt"), "two\n", "utf8");
    await writeFile(sessionFile, "", "utf8");
    await writeFakeReviewerConfig(dir, sessionDir);

    const seam = createSeam();
    const rt = createReuseRuntime("conversation-a", sessionFile, dir);
    await activate(rt.pi, { snapshotReuse: seam.snapshotReuse });
    await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);

    // Exchange 1 (user): a fresh capture with no prior source. The seeded
    // follow-up (exchange 2) skips capture entirely, so the whole two-exchange
    // cycle makes exactly one reuse-source request and one remember.
    await runClosedWindowCycle(rt, dir, { name: "c.txt", content: "three\n" });
    const b1 = seam.inner.current()?.snapshot;
    assert.ok(b1, "the completed baseline is retained across the window close");
    assert.equal(seam.reuseCalls.length, 1, "only the unseeded exchange requested a reuse source");
    assert.equal(seam.reuseCalls[0]!.returned, undefined, "the first exchange has no prior source");
    assert.equal(seam.rememberCount, 1, "the seeded follow-up never captures or remembers");
    assert.equal(b1.files.get("a.txt")?.content, "one\n");
    assert.equal(b1.files.has("c.txt"), false, "the agent's write lands after the baseline");

    // Normal window close: the passed window is retained for /ask-reviewer.
    const closed = await new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir }).restore(dir);
    assert.ok(closed);
    assert.equal(closed.state.reviewWindow, undefined, "the review window closed normally");
    assert.equal(closed.state.lastQuestionWindow?.id, 1, "the passed window is retained");

    // Exchange 3 (user): a new unseeded exchange reuses the prior completed snapshot.
    await beginUnseededExchange(rt, dir, "request B");
    assert.equal(seam.reuseCalls.length, 2);
    assert.equal(seam.reuseCalls[1]!.cwd, dir);
    assert.equal(seam.reuseCalls[1]!.returned, b1, "the prior completed snapshot is the reuse source");
    const b3 = seam.inner.current()?.snapshot;
    assert.ok(b3 && b3 !== b1, "a fresh baseline is still created for the new exchange");
    // Retained record identity proves the helper reused verified facts.
    assert.equal(b3.files.get("a.txt"), b1.files.get("a.txt"));
    assert.equal(b3.files.get("b.txt"), b1.files.get("b.txt"));
    // The post-baseline addition is captured fresh, never hidden.
    assert.equal(b3.files.get("c.txt")?.content, "three\n");
    // The review baseline diff between successive ordinary exchanges reflects
    // only the real workspace change.
    assert.deepEqual(
      compareSnapshots(b1, b3).map((change) => [change.path, change.status]),
      [["c.txt", "added"]],
    );

    // The new window is a fresh review window from current file contents.
    const opened = await new SessionStateStore({ sessionId: "conversation-a", sessionFile, cwd: dir }).restore(dir);
    assert.ok(opened);
    assert.equal(opened.state.reviewWindow?.id, 2, "ordinary work starts a fresh window");
    assert.ok(opened.state.reviewWindow?.baseline, "the fresh window carries its own baseline");
    assert.deepEqual(
      opened.state.reviewWindow?.requestHistory.map((request) => request.text),
      ["request B"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test("edits, additions, and deletions between turns match a fresh snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-reuse-edits-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-review-reuse-session-"));
  const sessionFile = join(sessionDir, "conversation-a.jsonl");
  try {
    await writeFile(join(dir, "a.txt"), "one\n", "utf8");
    await writeFile(join(dir, "b.txt"), "two\n", "utf8");
    // e.txt predates the first baseline and is never touched: it must be the
    // entry that survives reuse by reference.
    await writeFile(join(dir, "e.txt"), "five\n", "utf8");
    await writeFile(sessionFile, "", "utf8");
    await writeFakeReviewerConfig(dir, sessionDir);

    const seam = createSeam();
    const rt = createReuseRuntime("conversation-a", sessionFile, dir);
    await activate(rt.pi, { snapshotReuse: seam.snapshotReuse });
    await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);

    await runClosedWindowCycle(rt, dir, { name: "c.txt", content: "three\n" });
    const b1 = seam.inner.current()?.snapshot;
    assert.ok(b1);

    // The workspace changes between the closed window and the next exchange.
    await writeFile(join(dir, "a.txt"), "one edited\n", "utf8");
    await rm(join(dir, "b.txt"));
    await writeFile(join(dir, "d.txt"), "four\n", "utf8");

    await beginUnseededExchange(rt, dir, "request B");
    assert.equal(seam.reuseCalls.at(-1)?.returned, b1, "the retained source is still offered");
    const b4 = seam.inner.current()?.snapshot;
    assert.ok(b4 && b4 !== b1);

    // The reused baseline must be decision-equivalent to a fresh capture.
    const fresh = await createWorkspaceSnapshot(dir, {
      maxFileBytes: indexTestConfig.maxFileBytes,
      maxSnapshotBytes: indexTestConfig.maxSnapshotBytes,
    });
    assertSnapshotsEquivalent(fresh, b4);

    // The changed entries are re-inspected, never served from the prior record.
    assert.notEqual(b4.files.get("a.txt"), b1.files.get("a.txt"));
    assert.equal(b4.files.get("a.txt")?.content, "one edited\n");
    assert.equal(b4.files.has("b.txt"), false, "deletions are never hidden by the reuse source");
    assert.equal(b4.files.get("d.txt")?.content, "four\n");
    // c.txt postdates the retained baseline, so it is a fresh record too.
    assert.equal(b4.files.get("c.txt")?.content, "three\n");
    assert.notEqual(b4.files.get("c.txt"), b1.files.get("c.txt"));
    // The untouched entry keeps its verified facts by reference.
    assert.equal(b4.files.get("e.txt"), b1.files.get("e.txt"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test("a new session never reuses a prior session's completed snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-reuse-root-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-review-reuse-session-"));
  const sessionFile = join(sessionDir, "conversation-a.jsonl");
  try {
    await writeFile(join(dir, "a.txt"), "one\n", "utf8");
    await writeFile(sessionFile, "", "utf8");
    await writeFakeReviewerConfig(dir, sessionDir);

    // One injected cache shared across two activations models the worst-case
    // carryover; the session boundaries must still make reuse impossible.
    const seam = createSeam();
    const first = createReuseRuntime("conversation-a", sessionFile, dir);
    await activate(first.pi, { snapshotReuse: seam.snapshotReuse });
    await trigger(first.hooks, "session_start", { type: "session_start", reason: "startup" }, first.ctx);
    await runClosedWindowCycle(first, dir, { name: "c.txt", content: "three\n" });
    const b1 = seam.inner.current()?.snapshot;
    assert.ok(b1, "the first session retained its completed snapshot");

    await trigger(first.hooks, "session_shutdown", { type: "session_shutdown", reason: "quit" }, first.ctx);

    const resumed = createReuseRuntime("conversation-a", sessionFile, dir);
    await activate(resumed.pi, { snapshotReuse: seam.snapshotReuse });
    await trigger(resumed.hooks, "session_start", { type: "session_start", reason: "resume" }, resumed.ctx);

    // A new unseeded exchange in the resumed session captures fresh.
    await beginUnseededExchange(resumed, dir, "request B");
    assert.equal(seam.reuseCalls.at(-1)?.returned, undefined, "no reuse source survives a session boundary");
    const b2 = seam.inner.current()?.snapshot;
    assert.ok(b2 && b2 !== b1);
    assert.notEqual(b2.files.get("a.txt"), b1.files.get("a.txt"), "records are re-inspected, not carried over");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test("a different root never reuses another root's snapshot", async () => {
  const dirA = await mkdtemp(join(tmpdir(), "pi-review-reuse-root-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "pi-review-reuse-root-b-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-review-reuse-session-"));
  const sessionFile = join(sessionDir, "conversation-a.jsonl");
  try {
    await writeFile(join(dirA, "a.txt"), "one\n", "utf8");
    await writeFile(join(dirB, "x.txt"), "x\n", "utf8");
    await writeFile(sessionFile, "", "utf8");
    await writeFakeReviewerConfig(dirA, sessionDir);

    const seam = createSeam();
    const rt = createReuseRuntime("conversation-a", sessionFile, dirA);
    await activate(rt.pi, { snapshotReuse: seam.snapshotReuse });
    await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);

    await runClosedWindowCycle(rt, dirA, { name: "c.txt", content: "three\n" });
    const bA = seam.inner.current()?.snapshot;
    assert.ok(bA && bA.cwd === resolve(dirA));

    // The next unseeded exchange starts from a different working directory.
    await beginUnseededExchange(rt, dirB, "request B");
    assert.equal(seam.reuseCalls.at(-1)?.returned, undefined, "a different root gets no reuse source");
    const bB = seam.inner.current()?.snapshot;
    assert.ok(bB && bB.cwd === resolve(dirB), "the cache entry moves to the new root");
    assert.equal(bB.files.get("x.txt")?.content, "x\n");
    assert.equal(seam.snapshotReuse.reuseSourceFor(dirA), undefined, "the old root is no longer served");
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test("a failed capture never poisons the retained source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-reuse-failure-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-review-reuse-session-"));
  const sessionFile = join(sessionDir, "conversation-a.jsonl");
  try {
    await writeFile(join(dir, "a.txt"), "one\n", "utf8");
    await writeFile(sessionFile, "", "utf8");
    await writeFakeReviewerConfig(dir, sessionDir);

    const seam = createSeam();
    const rt = createReuseRuntime("conversation-a", sessionFile, dir);
    await activate(rt.pi, { snapshotReuse: seam.snapshotReuse });
    await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);

    await runClosedWindowCycle(rt, dir, { name: "c.txt", content: "three\n" });
    const b1 = seam.inner.current()?.snapshot;
    assert.ok(b1);

    // Deterministically fail the next baseline capture. The compiled entrypoint
    // resolves createWorkspaceSnapshot as a live property of the capture
    // module, so intercepting the export makes the real hook path reject.
    const original = captureModule.createWorkspaceSnapshot;
    try {
      (captureModule as unknown as Record<string, unknown>).createWorkspaceSnapshot = async () => {
        throw new Error("injected capture failure");
      };
      await trigger(rt.hooks, "input", { cwd: dir, text: "request B", source: "user" }, rt.ctx);
      await assert.rejects(
        trigger(rt.hooks, "before_agent_start", { cwd: dir }, rt.ctx),
        /injected capture failure/,
      );
    } finally {
      (captureModule as unknown as Record<string, unknown>).createWorkspaceSnapshot = original;
    }

    // The failed capture neither replaces nor clears the last completed source.
    assert.equal(seam.inner.current()?.snapshot, b1, "the retained source survives a failed capture");
    assert.equal(seam.rememberCount, 1, "a failed capture is never remembered");

    // The next unseeded attempt succeeds and reuses the last completed source.
    await trigger(rt.hooks, "before_agent_start", { cwd: dir }, rt.ctx);
    assert.equal(seam.reuseCalls.at(-1)?.returned, b1, "the retry offers the last completed source");
    const b5 = seam.inner.current()?.snapshot;
    assert.ok(b5 && b5 !== b1);
    assert.equal(b5.files.get("a.txt"), b1.files.get("a.txt"), "unchanged entries are still reused");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }
});

test("limits changed mid-session recompute retain/omit against the reuse source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-reuse-limits-"));
  const sessionDir = await mkdtemp(join(tmpdir(), "pi-review-reuse-session-"));
  const sessionFile = join(sessionDir, "conversation-a.jsonl");
  try {
    // big.txt fits the default per-file limit (1 MiB) but exceeds the
    // tightened 1 KiB limit that is installed mid-session.
    await writeFile(join(dir, "a.txt"), "one\n", "utf8");
    const bigContent = "x".repeat(4096);
    await writeFile(join(dir, "big.txt"), bigContent, "utf8");
    await writeFile(sessionFile, "", "utf8");
    await writeFakeReviewerConfig(dir, sessionDir);

    const seam = createSeam();
    const rt = createReuseRuntime("conversation-a", sessionFile, dir);
    await activate(rt.pi, { snapshotReuse: seam.snapshotReuse });
    await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);

    await runClosedWindowCycle(rt, dir, { name: "c.txt", content: "three\n" });
    const b1 = seam.inner.current()?.snapshot;
    assert.ok(b1);
    assert.equal(b1.files.get("big.txt")?.content, bigContent, "the default limits retain the file's content");

    // Tighten the per-file limit on disk and drive the real /review-settings
    // Save: it re-reads the config file and installs the new limits into the
    // live config via replaceConfig — the settings UI never stages these
    // fields itself, so the on-disk value is authoritative.
    const configPath = join(dir, "review-gate.json");
    const onDisk = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    onDisk.maxFileBytes = 1024;
    await writeFile(configPath, JSON.stringify(onDisk), "utf8");
    const settings = rt.commands.get("review-settings");
    assert.ok(settings, "the /review-settings command is registered");
    const menus: string[] = [];
    await settings("", {
      ...rt.ctx,
      ui: {
        notify: (message: string) => rt.notices.push(message),
        select: async (title: string) => {
          menus.push(title);
          if (title === "Review settings") return "Save changes";
          throw new Error(`Unexpected menu: ${title}`);
        },
      },
    });
    assert.deepEqual(menus, ["Review settings"], "a direct Save from the root stages no field");
    assert.match(rt.notices.join("\n"), /Review settings saved/);

    // The next unseeded exchange captures under the NEW limits while offering
    // the pre-tightening snapshot as reuse source: retain/omit is recomputed,
    // never copied.
    await beginUnseededExchange(rt, dir, "request B");
    assert.equal(seam.reuseCalls.at(-1)?.returned, b1, "the pre-tightening snapshot is still the reuse source");
    const b4 = seam.inner.current()?.snapshot;
    assert.ok(b4 && b4 !== b1);
    const bigNow = b4.files.get("big.txt");
    assert.equal(bigNow?.omittedReason, "oversized", "the tightened limit drops previously retained content");
    assert.equal(bigNow?.content, undefined);
    assert.equal(bigNow?.sha256, b1.files.get("big.txt")?.sha256, "the proven hash survives the limit change");
    assert.equal(b4.files.get("a.txt"), b1.files.get("a.txt"), "small unchanged files are still reused by reference");
    assert.equal(b4.files.get("c.txt")?.content, "three\n", "small retained files keep their content");

    // The reused baseline is decision-identical to a fresh capture under the
    // same new limits — no stale option can leak through the cache.
    const onDiskAfter = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    assert.equal(onDiskAfter.maxFileBytes, 1024);
    const oracle = await createWorkspaceSnapshot(dir, {
      maxFileBytes: Number(onDiskAfter.maxFileBytes),
      maxSnapshotBytes: Number(onDiskAfter.maxSnapshotBytes),
    });
    assertSnapshotsEquivalent(oracle, b4);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(sessionDir, { recursive: true, force: true });
  }
});
