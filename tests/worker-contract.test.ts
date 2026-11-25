import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { createEvidenceState, recordObservedToolEventEvidence, rememberFinalAssistantSummaryText } from "../src/evidence";
import {
  buildInPlaceContinuationDisclosure,
  buildInPlacePrompt,
  buildInPlaceReviewRequest,
  computeInPlaceAttribution,
  createInPlaceBaseline,
} from "../src/execution/inplace-worker";
import { buildWaveWorkerContinuationPrompt, buildWaveWorkerPrompt, type WaveWorkerTask } from "../src/execution/wave-worker";
import { buildReviewRequest } from "../src/execution/wave-worker-lifecycle";
import {
  WORKER_CONTRACT_HEADING,
  WORKER_CONTRACT_PRECEDENCE,
  WORKER_CORRECTION_RULE,
  workerContractKindFor,
  workerContractLines,
  type WorkerContractKind,
} from "../src/execution/worker-contract";
import { buildReviewerInstructions, buildReviewerPrompt, REVIEW_PROPORTIONALITY_POLICY } from "../src/prompts";

// The #760 scenario: a reasonable output-format instruction that the
// harness-required report and read-only verification would otherwise appear
// to contradict.
const scenarioTask: WaveWorkerTask = {
  title: "sleep exit code",
  instructions: "Run `sleep 60`, report the exit code in one line and stop; change no files.",
  acceptanceCriteria: ["The exit code is reported", "No files changed"],
};

/** Independently extract the contract bullet lines that follow the heading in a rendered prompt. */
function renderedContractLines(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(WORKER_CONTRACT_HEADING);
  assert.notEqual(start, -1, "the rendered text carries the harness worker contract heading");
  assert.equal(lines.indexOf(WORKER_CONTRACT_HEADING, start + 1), -1, "the contract is rendered exactly once");
  const bullets: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("- ")) bullets.push(line);
    else if (bullets.length > 0) break;
  }
  return bullets;
}

function workerPrompt(kind: WorkerContractKind): string {
  if (kind === "inplace") return buildInPlacePrompt(scenarioTask, "/workspace/root");
  return buildWaveWorkerPrompt({ ...scenarioTask, ...(kind === "research" ? { backgroundKind: "research" as const } : {}) }, "/source/root", "/worker/root");
}

async function inPlaceReviewRequest(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "pi-review-worker-contract-"));
  try {
    const config = normalizeConfig({ enabled: true });
    const baseline = await createInPlaceBaseline(workspace, config);
    const attribution = await computeInPlaceAttribution(baseline, config);
    const evidence = createEvidenceState();
    for (const [toolName, command, result] of [
      ["bash", "sleep 60; echo EXIT_CODE=$?", "EXIT_CODE=0"],
      ["bash", "git status --porcelain | wc -l", "STATUS_LINES=0"],
    ] as const) {
      recordObservedToolEventEvidence({ state: evidence, cwd: workspace, selectedRoot: workspace, adapter: "pi-model", stage: "end", toolName, toolInput: { command }, result });
    }
    rememberFinalAssistantSummaryText(evidence, "Exit code: 0\n\nChanged: nothing. Verification: git status --porcelain (0 entries). Side effects: one short-lived sleep process.");
    return buildInPlaceReviewRequest(scenarioTask, attribution, evidence);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("#760 one selector picks the worktree contract kind for both builders", () => {
  assert.equal(workerContractKindFor({}), "execute");
  assert.equal(workerContractKindFor({ backgroundKind: "execute" }), "execute");
  assert.equal(workerContractKindFor({ backgroundKind: "research" }), "research");
});

test("#760 every kind's worker prompt carries the shared harness contract generated from one definition", () => {
  for (const kind of ["execute", "research", "inplace"] as const) {
    const prompt = workerPrompt(kind);
    assert.deepEqual(renderedContractLines(prompt), workerContractLines(kind), `${kind} worker prompt contract`);
    assert.ok(prompt.indexOf(WORKER_CONTRACT_HEADING) > prompt.indexOf("Acceptance criteria:"), `${kind}: the authoritative contract follows task-controlled text`);
  }
  assert.match(workerPrompt("research"), /Begin with one `Summary:` line of at most 240 characters/);
  assert.match(workerPrompt("inplace"), /every external side effect performed/);
  assert.doesNotMatch(workerPrompt("execute"), /every external side effect performed/);
});

test("#760 reviewer requests carry byte-identical contract lines to the worker prompt for the same kind", async () => {
  const requests: Record<WorkerContractKind, string> = {
    execute: buildReviewRequest(scenarioTask, false),
    // Research tasks skip automatic review today; the shared builder still
    // renders the same research contract if a review request is built.
    research: buildReviewRequest({ ...scenarioTask, backgroundKind: "research" }, false),
    inplace: await inPlaceReviewRequest(),
  };
  for (const kind of ["execute", "research", "inplace"] as const) {
    const request = requests[kind];
    assert.deepEqual(renderedContractLines(request), renderedContractLines(workerPrompt(kind)), `${kind}: worker and reviewer contract text must not drift`);
    assert.match(request, /Behavior this contract requires is authoritative and is never a finding by itself, including its required report sections and read-only verification\./);
    assert.match(request, /This contract does not make worker claims evidence\./);
    assert.match(request, /when that evidence is insufficient, incomplete, or truncated, say so and block/);
  }
  assert.notDeepEqual(workerContractLines("execute"), workerContractLines("inplace"), "kinds keep their own report sections");
});

test("#760 precedence and correction wording is shared verbatim by worker prompts and reviewer requests", async () => {
  const inplace = await inPlaceReviewRequest();
  for (const text of [workerPrompt("execute"), workerPrompt("research"), workerPrompt("inplace"), buildReviewRequest(scenarioTask, true), inplace]) {
    assert.ok(text.includes(`- ${WORKER_CONTRACT_PRECEDENCE}`));
    assert.ok(text.includes(`- ${WORKER_CORRECTION_RULE}`));
  }
  assert.match(WORKER_CONTRACT_PRECEDENCE, /output instructions in the task text .* govern the content and length of the result the worker leads with/);
  assert.match(WORKER_CONTRACT_PRECEDENCE, /harness-required report sections and read-only verification in this contract still apply .* and do not violate those instructions/);
  assert.match(WORKER_CONTRACT_PRECEDENCE, /A real conflict that this rule cannot resolve is a non_blocking observation, never a blocking finding\./);
});

test("#760 reviewer instructions state proportional verdicts independent of reviewer selection", () => {
  const instructions = buildReviewerInstructions();
  assert.ok(instructions.includes(REVIEW_PROPORTIONALITY_POLICY));
  assert.ok(buildReviewerInstructions({ correctionAttemptCount: 2, threshold: 1 }).includes(REVIEW_PROPORTIONALITY_POLICY), "escalated instructions keep the same policy");
  assert.match(instructions, /A finding is blocking only when the delivered outcome fails the explicit request or an explicit acceptance criterion, or has a material technical, safety, security, or audit defect\./);
  assert.match(instructions, /Evidence that is insufficient, incomplete, or truncated for the required outcome remains a valid blocking finding/);
  assert.match(instructions, /The form, wording, or length of the worker's or agent's final report or summary \(not documentation or other deliverables\), and extra read-only verification, are non_blocking when the required outcome is met and evidenced, unless an explicit acceptance criterion makes that form the deliverable\./);
  assert.match(instructions, /Behavior that a supplied harness worker contract requires is never a finding by itself/);
  assert.match(instructions, /recommend a corrected report, not re-execution/);
  assert.match(instructions, /Recommend re-running completed work only when the evidence does not establish the required outcome, and name the specific gap/);
  // The existing gates stay in force.
  assert.match(instructions, /Return "needs_changes" only when the primary agent can take a concrete follow-up action/);
  assert.match(instructions, /Missing verification is blocking only when it leaves a concrete material risk/);
});

test("#760 scenario fixture presents harness-required verification and report sections as contract-sanctioned", async () => {
  const request = await inPlaceReviewRequest();
  // The task's one-line instruction and the evidence both reach the reviewer.
  assert.match(request, /report the exit code in one line and stop; change no files\./);
  assert.match(request, /git status --porcelain/);
  assert.match(request, /Exit code: 0/);
  // The contract the worker followed is visible and authoritative.
  assert.match(request, /Read-only inspection that supports an acceptance criterion \(for example confirming that no files changed\) is verification, not extra work\./);
  assert.match(request, /summarize exactly what you changed in this workspace, the verification you ran, and remaining risks/);
  assert.match(request, /discloses every external side effect performed/);
  // Fail-closed in-place disclosures are unchanged.
  assert.match(request, /In-place workspace disclosure \(authoritative\)/);
  assert.match(request, /Attribution boundary \(authoritative\)/);
  // The full reviewer prompt pairs the request with the proportionality policy,
  // with no model- or reviewer-specific branch.
  const prompt = buildReviewerPrompt({ request, submittedChanges: [], patch: "", cwd: "/workspace/root" });
  assert.ok(prompt.includes(REVIEW_PROPORTIONALITY_POLICY));
  assert.ok(prompt.includes(`- ${WORKER_CONTRACT_PRECEDENCE}`));
});

test("#760 continuation and correction prompts carry the shared correction rule exactly once", () => {
  const feedback = "Review pass 1 transmission for the implementing model.\nAction: Review found blocking issues.";
  const count = (text: string) => text.split(WORKER_CORRECTION_RULE).length - 1;
  // Resumed sessions get only the continuation text, so it carries the rule.
  const execute = buildWaveWorkerContinuationPrompt(feedback, "/source/root", "/worker/root");
  assert.equal(count(execute), 1);
  assert.ok(execute.indexOf(WORKER_CORRECTION_RULE) < execute.indexOf(feedback.split("\n")[0]!), "the rule frames the feedback");
  const resumedInPlace = buildInPlaceContinuationDisclosure(true);
  assert.equal(count(resumedInPlace), 1);
  // An execute task continued in place carries the in-place disclosure; the
  // execute continuation must not duplicate the rule it already contains.
  assert.equal(count(buildWaveWorkerContinuationPrompt(`${resumedInPlace}\n\n${feedback}`, "/source/root", "/worker/root")), 1);
  // Fresh-session prompts are assembled exactly as adapter-workflow.ts and the
  // resumeWaveWorker handoff assemble them: the full worker prompt (whose
  // contract carries the rule) plus the continuation, with no second copy.
  const freshInPlace = [buildInPlacePrompt(scenarioTask, "/workspace/root"), "", buildInPlaceContinuationDisclosure(false), "", "Current continuation instructions:", feedback].join("\n");
  assert.equal(count(freshInPlace), 1);
  for (const inPlace of [false, true]) {
    const handoff = [
      buildWaveWorkerPrompt(scenarioTask, "/source/root", "/worker/root"),
      "",
      "Current continuation instructions:",
      buildWaveWorkerContinuationPrompt(inPlace ? `${buildInPlaceContinuationDisclosure(false)}\n\n${feedback}` : feedback, "/source/root", "/worker/root", { correctionRule: false }),
    ].join("\n");
    assert.equal(count(handoff), 1, `fresh ${inPlace ? "in-place " : ""}execute handoff`);
  }
  assert.match(WORKER_CORRECTION_RULE, /Satisfy a finding about the report alone .* by returning a corrected report\./);
  assert.match(WORKER_CORRECTION_RULE, /Re-execute completed work only when a finding names a required outcome that the evidence does not establish\./);
});
