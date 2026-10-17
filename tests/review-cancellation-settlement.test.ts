/** #397: real reviewer children, production review/command registrations and notices.
 * The UI/persistence surfaces are structural fixtures, not an installed Pi TUI.
 * No process/settlement results are mocked; output spies observe real returns.
 * Artifact-error cases inject an invalid owned path into the real artifact writer.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkspaceSnapshot } from "../src/capture";
import { registerCommands } from "../src/commands";
import { createReviewTurnCoordinator } from "../src/activation/review-turn";
import { createReviewCancellationCoordinator } from "../src/review-cancellation";
import { createState, rememberUserRequest, snapshotReviewBaseline } from "../src/state";
import * as review from "../src/review";
import * as processArtifacts from "../src/adapters/process";
import { fakeNeedsChangesConfig } from "./helpers";

async function until(probe: () => boolean | Promise<boolean>, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await probe()) {
    assert.ok(Date.now() < deadline, `bounded fixture wait: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

async function ownedReviewers(root: string, uncertain: boolean) {
  const token = randomUUID();
  const home = join(root, "home");
  await mkdir(home);
  const stop = join(root, "stop");
  const ownership = join(root, "ownership.json");
  const rootPid = join(root, "root.pid");
  const ready = join(root, "ready");
  const worker = join(root, "holder.cjs");
  const launcher = join(root, "reviewer.cjs");
  await writeFile(worker, [
    "const fs=require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(ready)},'ready');`,
    // Independent finite lifetime also covers partial setup/test assertion failure.
    "setTimeout(()=>process.exit(0),18000);",
    `setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0)},20);`,
  ].join(""));
  await writeFile(launcher, [
    "const fs=require('node:fs');const {spawn}=require('node:child_process');",
    `fs.writeFileSync(${JSON.stringify(rootPid)},String(process.pid));`,
    "process.stdin.resume();process.stderr.write('private reviewer text must not enter notices');",
    // Uncertain holders escape the owned POSIX group and, on Windows, Node's
    // child job so root exit cannot terminate them and falsely confirm cleanup.
    // Confirmed holders stay owned: POSIX group, or live Windows root + taskkill /T.
    `const child=spawn(process.execPath,[${JSON.stringify(worker)}],{detached:${uncertain},stdio:['ignore',1,2]});`,
    `fs.writeFileSync(${JSON.stringify(ownership)},JSON.stringify({token:${JSON.stringify(token)},root:process.pid,child:child.pid}));`,
    // Let the descendant establish inherited pipes before exiting the root.
    // On Windows the confirmed fixture retains its owned root for taskkill /T.
    `const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(ready)})){clearInterval(timer);${!uncertain && process.platform === "win32" ? "" : "process.exit(0);"}}},10);`,
    `setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0)},20);`,
    "setTimeout(()=>process.exit(0),18000);",
  ].join(""));
  return {
    slow: { adapter: "generic-cli" as const, command: process.execPath, args: [],
      env: { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home },
      review: { args: [launcher], timeoutMs: 20000 } },
    async ready() {
      await until(() => exists(ready), "owned descendant readiness");
      const record = JSON.parse(await readFile(ownership, "utf8"));
      assert.equal(record.token, token);
      assert.ok(Number.isSafeInteger(record.root) && record.root > 0);
      assert.ok(Number.isSafeInteger(record.child) && record.child > 0 && record.child !== record.root);
      assert.equal(Number(await readFile(rootPid, "utf8")), record.root);
      if (uncertain || process.platform !== "win32") await until(() => !alive(record.root), "direct root exit");
      assert.equal(alive(record.child), true, "descendant still owns inherited pipes");
      return record.child as number;
    },
    async cleanup() {
      // Cooperative control, never signal a PID discovered from arbitrary files.
      // The file is unique to this positively allocated invocation, and both
      // launched scripts have independent finite lifetimes for partial setup.
      await writeFile(stop, "stop");
      if (await exists(ownership)) {
        const record = JSON.parse(await readFile(ownership, "utf8"));
        assert.equal(record.token, token);
        assert.ok(Number.isSafeInteger(record.root) && record.root > 0);
        assert.ok(Number.isSafeInteger(record.child) && record.child > 0);
        await until(() => !alive(record.root) && !alive(record.child), "owned fixture processes exited", 20000);
      }
    },
  };
}

for (const path of ["automatic", "review-now", "ask-reviewer", "ask-reviewer-interactive"] as const) {
  for (const mode of ["uncertain", "confirmed", ...(path === "automatic" || path === "review-now" ? ["artifact-error"] : [])]) {
    const uncertain = mode !== "confirmed";
    test(`${path}: real inherited-pipe cancellation reports ${uncertain ? "unconfirmed cleanup" : "confirmed settlement"} (${mode})`, { timeout: 35000 }, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "prg-cancel-settlement-"));
      const cwd = join(root, "repo");
      const cancellation = createReviewCancellationCoordinator();
      let fixture: Awaited<ReturnType<typeof ownedReviewers>> | undefined;
      let pending: Promise<unknown> | undefined;
      let bundleDir: string | undefined;
      let coordinator: ReturnType<typeof createReviewTurnCoordinator> | undefined;
      try {
        await mkdir(cwd);
        execFileSync("git", ["init", "-q"], { cwd });
        await writeFile(join(cwd, "index.ts"), "before\n");
        const state = createState();
        rememberUserRequest(state, "change index");
        const window = state.reviewWindow!;
        window.baseline = snapshotReviewBaseline(await createWorkspaceSnapshot(cwd, { maxFileBytes: 1048576, maxSnapshotBytes: 52428800 }));
        const baseline = window.baseline;
        await writeFile(join(cwd, "index.ts"), "after\n");
        fixture = await ownedReviewers(root, uncertain);
        const fastExit = join(root, "fast-exit");
        const config = { ...fakeNeedsChangesConfig(), retainBundles: "always" as const,
          externalAgents: {
            slow: fixture.slow,
            fast: { adapter: "generic-cli" as const, command: process.execPath, args: [],
              review: { args: ["-e", `process.stdin.resume();process.on('exit',()=>require('node:fs').writeFileSync(${JSON.stringify(fastExit)},String(process.pid)));process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:'DISCARD_THIS_PARTIAL_VERDICT',findings:[]})))`], timeoutMs: 15000 } },
          }, review: { activeReviewers: [{ source: "external" as const, id: "slow" }, { source: "external" as const, id: "fast" }] },
        };
        const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
        const notices: string[] = [];
        const sent: string[] = [];
        const terminalHandlers = new Set<(input: string) => unknown>();
        const ctx = { ui: { notify(message: string) { notices.push(message); }, setStatus() {},
          onTerminalInput(handler: (input: string) => unknown) { terminalHandlers.add(handler); return () => terminalHandlers.delete(handler); } } };
        const pi = { registerCommand(name: string, options: { handler(args: string, ctx: unknown): Promise<void> }) { commands.set(name, options); },
          sendUserMessage(message: string) { sent.push(message); } };
        registerCommands({ pi, cwd: () => cwd, config, state, cancellation });
        coordinator = createReviewTurnCoordinator({
          pi, state, config, cancellation, scopedModels: () => [], isSessionActive: () => true,
          observeCwd() {}, cwd: () => cwd, syncExecutionContext() {}, checkpointRestartBlocked: () => undefined,
          effectiveReviewConfig: () => config, persist: async () => {}, persistAutomaticDelivery: async () => true,
          backgroundShell: () => undefined, reviewReadiness: () => [], reapplyDeferredTools() {},
          orchestratorTurns: { hasRunsInFlight: () => false, noteMessageObserved: () => false, noteMessageArmingFailed() {} },
        });
        let output: review.ReviewRunOutput | review.AskReviewerOutput | undefined;
        // Observe actual output, without replacing execution, errors or evidence.
        const originalReview = review.runReview;
        const originalAsk = review.runAskReviewer;
        t.mock.method(review, "runReview", async (...args: Parameters<typeof review.runReview>) => { output = await originalReview(...args); return output; });
        t.mock.method(review, "runAskReviewer", async (...args: Parameters<typeof review.runAskReviewer>) => { output = await originalAsk(...args); return output; });
        if (mode === "artifact-error") {
          const writer = processArtifacts.writeReviewerProcessArtifacts;
          t.mock.method(processArtifacts, "writeReviewerProcessArtifacts", (input: Parameters<typeof writer>[0]) => writer(input.output.aborted
            ? { ...input, paths: { ...input.paths, stderr: join(root, "missing-owned-directory", "stderr") } } : input));
        }
        pending = path === "automatic" ? coordinator.onAgentSettled([ctx]) : commands.get(path)!.handler(path === "review-now" ? "" : "is this safe?", ctx);
        const child = await fixture.ready();
        await until(() => exists(fastExit), "settled sibling verdict");
        const fastPid = Number(await readFile(fastExit, "utf8"));
        await until(() => !alive(fastPid), "settled sibling exit");
        await until(() => window.bundleDir !== undefined, "invocation prepared");
        bundleDir = window.bundleDir;
        const active = cancellation.current();
        assert.ok(active);
        // /review-cancel races the owning completion path immediately after
        // settled resolves, rather than waiting for that path to send a notice.
        const cancel = commands.get("review-cancel")!.handler("", ctx);
        await until(() => notices.some((message) => message.includes("waiting for reviewer processes to stop")), "request acknowledgement");
        assert.doesNotMatch(notices.join("\n"), /processes stopped|termination unconfirmed/);
        await cancel;
        await pending;
        const completion = notices.filter((message) => message.includes("cancelled;"));
        assert.equal(completion.length, 1, "coordinator and owner emit only one completion notice");
        assert.equal(completion[0], `review gate: ${path.startsWith("ask") ? "reviewer question" : "review"} cancelled; ${uncertain
          ? "reviewer process termination unconfirmed; cleanup uncertain; owned processes may remain live" : "reviewer processes stopped"}`);
        assert.ok(output?.result);
        assert.equal(output.result.error, "aborted");
        assert.equal(output.result.processSettlement, uncertain ? "unconfirmed" : "confirmed");
        assert.equal(output.reviewerResults, undefined, "partial verdicts are discarded");
        if (uncertain) {
          assert.match(output.result.diagnostic!, /slow: .*cleanup uncertain: the child close event was not observed/s);
          if (mode === "artifact-error") assert.match(output.result.diagnostic!, /ENOENT/);
          assert.equal(alive(child), true, "bounded teardown returned while the invocation-owned pipe holder remains alive");
        } else {
          await until(() => !alive(child), "confirmed child exit");
          assert.equal(output.result.diagnostic, undefined);
        }
        const invocation = join(window.bundleDir!, path.startsWith("ask") ? "questions" : "reviews", "0001");
        const tombstone = JSON.parse(await readFile(join(invocation, "canceled.json"), "utf8"));
        assert.equal(tombstone.processSettlement, output.result.processSettlement);
        assert.equal(tombstone.diagnostic, output.result.diagnostic, "termination diagnostic survives in the cancellation tombstone");
        assert.match(await readFile(join(invocation, "CANCELED.md"), "utf8"), /canceled by the user/);
        assert.equal(await exists(join(invocation, "reviewers")), false);
        assert.equal(await exists(join(invocation, "reviewer-results.json")), false);
        assert.equal(sent.length, 0, "no verdict or reviewer answer delivered after cancellation");
        assert.equal(window.reviewHistory.length, 0);
        assert.equal(window.baseline, baseline);
        assert.equal(cancellation.current(), undefined);
        assert.doesNotMatch(notices.join("\n"), /private reviewer text|DISCARD_THIS_PARTIAL_VERDICT/);
        assert.equal(notices.some((message) => message.includes(root)), false, "no private fixture path enters cancellation notices");
      } finally {
        cancellation.current()?.requestCancel("manual");
        await fixture?.cleanup();
        await pending?.catch(() => {});
        await coordinator?.shutdownReview();
        if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
