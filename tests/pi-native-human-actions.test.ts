import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createBgShellWakeFixture, type BgShellWakeFixture } from "./pi-native-bgshell-wake-fixture";
import { skipOrFail } from "./bridge-fakes";

// Real installed Pi, actual registered commands and native agent loop, scripted
// local provider only. Unlike human-action-notices, no sendMessage seam is mocked.
test("native human add/explicit and picker steer reach the busy parent's model before stop without abort; idle add wakes", { timeout: 180_000 }, async (t) => {
  const candidate = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY;
  if (!candidate || !existsSync(candidate)) { skipOrFail(t, "PI_REVIEW_GATE_CANDIDATE_ENTRY must name a scratch compiled candidate"); return; }
  if (process.platform === "win32") { t.skip("POSIX foreground bash fixture, not Windows evidence"); return; }
  const config = {
    enabled: true, review: { activeReviewers: [] },
    externalAgents: { held: { adapter: "run-as-binary", command: process.execPath,
      execution: { protocol: "pi-review-executor-jsonl-v1", args: [] as string[] } } },
    execution: { deferredPiTools: false, workerResources: { default: { selection: { source: "external", id: "held" }, maxConcurrent: 1 } }, routes: { execute: [{ resourceId: "default" }], research: [] } },
  };
  let fixture: BgShellWakeFixture;
  try {
    fixture = createBgShellWakeFixture({ candidateEntry: candidate, gateConfig: config,
      scratchParent: process.env.PI_REVIEW_GATE_SCRATCH_PARENT,
      uiResponder: (request) => request.method === "select"
        ? { value: (request.options as string[])[0]! }
        : request.method === "input" ? { value: "NATIVE-PICKER-STEER" } : undefined,
    });
  } catch (error) { skipOrFail(t, String(error)); return; }
  const release = join(fixture.paths.stateDir, "release-workers");
  config.externalAgents.held.execution.args = ["-e", `const fs=require('node:fs');
console.log(JSON.stringify({type:'session',sessionId:process.env.PI_REVIEW_EXECUTOR_SESSION_ID}));
const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);console.log(JSON.stringify({type:'assistant',text:'done'}));}},30);`];
  t.after(async () => {
    // Let every admitted worker finish naturally before terminating its owning
    // native session. If that cannot be verified, retain it rather than delete.
    if (existsSync(fixture.paths.stateDir)) await writeFile(release, "done");
    const settled = await fixture.waitFor(() => {
      const events = fixture.journal();
      const starts = events.filter((entry) => entry.event === "message_start" && entry.customType === "pi-review-subtask-launch");
      const terminalTasks = new Set(events.filter((entry) => entry.event === "message_start"
        && entry.customType === "pi-review-subtask-event"
        // The binary adapter can leave live steering queued at final exit.
        // Its recovery notice still records LANDED after verified child exit;
        // do not pretend it applied steering or demand a COMPLETE verdict.
        && /landed independently|at state LANDED/.test(entry.preview ?? ""))
        .map((entry) => entry.preview?.match(/task-[0-9a-f-]{36}/)?.[0]));
      return starts.every((entry) => terminalTasks.has(entry.preview?.match(/task-[0-9a-f-]{36}/)?.[0]))
        && events.map((entry) => entry.event).lastIndexOf("agent_settled") > events.map((entry) => entry.event).lastIndexOf("agent_start");
    }, 60_000);
    if (!settled) throw new Error(`native worker settlement unverified; retained ${fixture.paths.scratch}; ${fixture.stderr}`);
    await fixture.dispose();
  });
  await fixture.start(Array.from({ length: 12 }, () => ({ text: "native-idle-ack" })));
  await fixture.prompt("/subtask-add NATIVE-IDLE-ADD");
  assert.ok(await fixture.waitFor(() => fixture.modelRequests().some((entry) => entry.transcriptTail?.some((message) => /NATIVE-IDLE-ADD/.test(message.preview ?? "")))), fixture.stderr);
  const launch = fixture.journal().find((entry) => entry.customType === "pi-review-subtask-launch" && entry.event === "message_start")!;
  const executionId = launch.preview?.match(/exec-[0-9a-f-]+/)?.[0];
  const taskId = launch.preview?.match(/task-[0-9a-f-]{36}/)?.[0];
  assert.ok(executionId && taskId, JSON.stringify(launch));
  assert.ok(fixture.journal().some((entry) => entry.event === "agent_start"), "idle admission triggered a native model run");
  assert.ok(await fixture.waitFor(() => fixture.journal().some((entry) => entry.event === "agent_settled")));

  for (const action of ["add", "explicit", "picker"] as const) {
    const begin = fixture.journal().length;
    const marker = `NATIVE-NO-ABORT-${action}`;
    await fixture.setTurnScript([
      { toolCalls: [{ toolName: "bash", arguments: { command: `sleep 2; echo ${marker}` } }] },
      ...Array.from({ length: 12 }, () => ({ text: `native-natural-stop-${action}` })),
    ]);
    await fixture.prompt(`Busy parent ${action}`);
    assert.ok(await fixture.waitFor(() => fixture.journal().slice(begin).some((entry) => entry.event === "message_end" && entry.role === "assistant" && /toolCall:bash/.test(entry.preview ?? ""))), fixture.stderr);
    // A custom notice is represented as a user message in native model
    // context. Keep the scripted provider from replaying its first tool step
    // when that changes stepsSinceLastUser; the in-flight bash is untouched.
    await fixture.setTurnScript(Array.from({ length: 12 }, () => ({ text: `native-natural-stop-${action}` })));
    const command = action === "add" ? "/subtask-add NATIVE-BUSY-ADD"
      : action === "explicit" ? `/subtask-steer ${executionId} ${taskId} NATIVE-EXPLICIT-STEER` : "/subtask-steer";
    await fixture.rpc("prompt", { message: command, streamingBehavior: "steer" });
    const customType = action === "add" ? "pi-review-subtask-launch" : "pi-review-subtask-steer";
    assert.ok(await fixture.waitFor(() => fixture.journal().slice(begin).some((entry) => entry.event === "agent_settled")), fixture.stderr);
    const journal = fixture.journal().slice(begin);
    const noticeIndex = journal.findIndex((entry) => entry.event === "message_start" && entry.customType === customType);
    assert.ok(noticeIndex >= 0, `${action} command notice missing: ${JSON.stringify(journal)}; ${fixture.stderr}`);
    assert.equal(journal.filter((entry) => entry.event === "message_start" && entry.customType === customType).length, 1);
    const priorAssistant = journal.slice(0, noticeIndex).reverse().find((entry) => entry.event === "message_end" && entry.role === "assistant");
    assert.match(priorAssistant?.preview ?? "", /toolCall:bash/, "notice injected at active tool boundary, not after natural stop");
    assert.ok(noticeIndex < journal.findIndex((entry) => entry.event === "agent_settled"));
    const requests = journal.filter((entry) => entry.event === "model_request");
    assert.ok(requests.some((entry) => entry.transcriptTail?.some((message) => (message.preview ?? "").includes(action === "add" ? "NATIVE-BUSY-ADD" : action === "explicit" ? "NATIVE-EXPLICIT-STEER" : "NATIVE-PICKER-STEER"))), "actual model context contains the action notice");
    assert.ok(requests.some((entry) => entry.transcriptTail?.some((message) => message.role === "toolResult" && (message.preview ?? "").includes(marker))), "in-flight foreground command completed normally and reached the native model");
    assert.ok(!journal.some((entry) => entry.stopReason === "aborted" || entry.stopReason === "error"));
  }
  t.diagnostic("Observed real registered slash commands in installed Pi's native model contexts with a local scripted provider; not a physical-terminal, live-provider, or Windows result.");
});
