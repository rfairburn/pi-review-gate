import type { ChangedFile } from "./capture";
import type { ChangeIdentity } from "./schema";
import { summarizeSideEffectChanges, summarizeSubmittedChanges } from "./change-context";

export const REVIEW_AUTHORIZATION_POLICY = `The orchestrator owns task direction, scope, and authorization. Treat the task and implementation direction recorded in the evidence as authorized. Do not second-guess whether the user explicitly requested each implementation choice.
Never refuse, abort, or return "needs_changes" merely because a change was not explicitly requested by the user. "The user did not ask for this" is not, by itself, a review finding.
Review for concrete technical defects: incorrect logic, regressions, unsafe behavior, security problems, broken APIs, inadequate tests, and failure to satisfy explicit acceptance criteria. Raise a scope-related finding only when it identifies a demonstrable technical harm or a direct violation of an explicit acceptance criterion.`;

export const REVIEW_TEST_POLICY = `Targeted tests are the expected verification inside delegated implementation and correction loops. Do not return "needs_changes" merely because the full repository test suite was not run. Require a full-suite run only when an explicit acceptance criterion assigns it to this task or when you identify a concrete cross-cutting risk that the targeted tests cannot exercise. Otherwise, mention a full-suite final orchestration run only as a non_blocking observation.`;

export const REVIEW_OUTCOME_POLICY = `Judge the delivered outcome against the explicit request and acceptance criteria, not against a preferred implementation or process. The current workspace and independently verifiable final behavior are authoritative. Missing evidence that an intermediate step occurred is not a defect when the final state proves the required outcome and the method itself was not required. Treat the method as material only when the request makes it part of the deliverable or when safety, security, migration, destructive-operation, or audit semantics depend on it.
Missing verification is blocking only when it leaves a concrete material risk that read-only inspection and existing targeted evidence cannot resolve. Name that risk and recommend the smallest targeted verification that would resolve it; do not demand redundant proof.`;

const REVIEW_CONTEXT_POLICY = `Review policy:
${REVIEW_AUTHORIZATION_POLICY}
${REVIEW_OUTCOME_POLICY}
${REVIEW_TEST_POLICY}
- Submitted workspace changes define the parent exchange's review scope, not a delivery artifact. Independently reviewed subtask landings may be present in the live workspace but intentionally absent; do not flag that absence alone.
- Captured side-effect changes are evidence from tool activity that was not detected as submitted workspace changes. They may include temp-like process artifacts, generated files, or real outside-workspace side effects.
- A temp-like side-effect classification is a heuristic, not a guarantee. Do not block solely because a temp-like external file exists, but do block if it is referenced by submitted code, contains secrets, stores meaningful user content, changes persistent behavior, or indicates unsafe/unmanaged side effects.
- Persistent-looking external side effects deserve scrutiny, but do not block solely because they are outside the workspace or not explicitly named in the user request. Block only when they are unrelated to the task, modify user/environment configuration, create or change executable/runtime content, store meaningful user data in an unmanaged location, leak secrets, or leave state that affects future behavior.
- Working notes or review documents may be acceptable when they are consistent with the session context; review them for correctness, not for their mere existence.
- Workspace side effects that are not submitted changes should be reviewed for accidental generated output, ignored files needed by the implementation, or files that should be cleaned up.
- Use read-only filesystem tools as needed to inspect the workspace and review bundle. If a shell-backed tool is your only filesystem interface, you may run strictly read-only commands such as pwd, ls, find, rg, grep, sed, cat, and git status/diff/show. Treat the workspace as ground truth. Never modify files, run commands with persistent side effects, use network access, or ask the primary model for more context.
- Prior review feedback in the request context is historical evidence, not a statement of the current workspace. Independently verify every prior finding against the current files and patch.
- Complete individual results from prior review passes were transmitted to the implementing model under the disposition shown in the request context. A request recorded as sent for correction establishes why the following implementation exchange occurred; do not call that correction unsolicited merely because it originated with a reviewer rather than the user.
- Runtime and reviewer-output artifacts are not review evidence. Do not inspect \`sessions/\`, raw model streams, invocation diagnostics, or any current or prior \`reviews/<sequence>/reviewers/\` and \`questions/<sequence>/reviewers/\` directories. When prior reviewer context is relevant, use the corresponding \`implementing-model-transmission.md\` and targeted exchange evidence, which contain the official results without another reviewer's runtime history.
- Passing assessments and non-blocking observations are visible context, not mandatory corrections. Feedback disclosed with correction deferred also does not establish an immediate correction obligation. User instructions remain authoritative when reviewer feedback conflicts with them.
- Do not repeat a prior finding when its requested correction is present. Repeat it only if you can cite current file/line or current session evidence showing a concrete remaining defect, and explain why the prior correction was insufficient.
- If you do not have tools, review from the supplied prompt and be explicit in your summary when the supplied context is insufficient for certainty.
- Return "needs_changes" only when the primary agent can take a concrete follow-up action that could make a later review pass. If a finding is only a sentinel/status flag, acknowledgement, or other terminal note with no requested fix, return "pass" with a non_blocking finding instead of a blocking finding.`;

export const REVIEW_RESPONSE_FORMAT = `Return one JSON object with exactly this shape. Do not wrap it in a Markdown fence and do not put literal, unescaped newlines inside JSON strings:
{
  "verdict": "pass" | "needs_changes" | "error",
  "summary": string,
  "guidance": string | null,
  "findings": [
    {
      "severity": "blocking" | "non_blocking",
      "file": string | null,
      "line": number | null,
      "issue": string,
      "recommendation": string
    }
  ],
  "error": string | null
}
Use "error" only when infrastructure or unavailable evidence prevents an actual review; explain the failure in "error" and return no findings.`;

export interface ImplementationGuidanceEscalation {
  correctionAttemptCount: number;
  threshold: number;
}

function implementationGuidancePolicy(escalation?: ImplementationGuidanceEscalation): string {
  return `Response quality:
- Put the direct conclusion in "summary".
- Put actionable explanation in "guidance" as Markdown.
${escalation
    ? "- Keep the required prose and implementation diff concise; do not add decorative or redundant material."
    : "- Include a concise fenced code snippet or minimal diff in \"guidance\" or a finding recommendation whenever it would materially help the primary model implement or correct the work.\n- Do not add decorative or redundant code when prose is sufficient."}
- Preserve exact identifiers, commands, and replacement text needed to act on the review.
${escalation
    ? `- Concrete-guidance escalation is active: ${escalation.correctionAttemptCount} correction attempt(s) have occurred, meeting the configured threshold of ${escalation.threshold}.
- First determine from the current workspace whether each historical finding is resolved. Do not infer that a problem remains merely because it appears in prior feedback.
- For every code problem you independently verify still remains, you MUST put both of the following in "guidance": concise prose that explains and defends the proposed correction, and a concise fenced implementation diff showing exactly what code you expect to see for that finding to pass. Include as much code and context as necessary for the correction to be complete and directly applicable; the diff does not have to be minimal.
- Do not substitute prose for the implementation diff or provide an implementation diff without the supporting explanation. Pair both with a finding whose "recommendation" says exactly where and how to apply the correction.
- Keep the outer response as JSON: encode Markdown line breaks inside the "guidance" JSON string. The implementing model will receive that string rendered under the formatted Guidance section.
- For a genuinely non-code finding, put exact commands, paths, or ordered steps in "guidance" and defend why those actions are sufficient for that finding to pass.`
    : "- Make the first response implementation-ready; do not defer useful concrete guidance to a later review."}`;
}

export function buildReviewerInstructions(escalation?: ImplementationGuidanceEscalation): string {
  return `${REVIEW_CONTEXT_POLICY}\n\n${implementationGuidancePolicy(escalation)}\n\n${REVIEW_RESPONSE_FORMAT}`;
}

export interface ReviewerPromptContext {
  request: string;
  submittedChanges: ChangedFile[];
  sideEffectChanges?: ChangedFile[];
  patch: string;
  sideEffectPatch?: string;
  cwd: string;
  bundleDir?: string;
  evidenceMarkdown?: string;
  guidanceEscalation?: ImplementationGuidanceEscalation;
  changeIdentity?: ChangeIdentity;
}

export interface ReviewerQuestionPromptContext extends ReviewerPromptContext {
  question: string;
}

export function buildReviewerPrompt(input: ReviewerPromptContext): string {
  return renderReviewerPrompt({ kind: "review", ...input });
}

export function buildReviewerQuestionPrompt(input: ReviewerQuestionPromptContext): string {
  return renderReviewerPrompt({ kind: "question", ...input });
}

type ReviewerPromptInput =
  | ({ kind: "review" } & ReviewerPromptContext)
  | ({ kind: "question" } & ReviewerQuestionPromptContext);

function renderReviewerPrompt(input: ReviewerPromptInput): string {
  const sideEffectChanges = input.sideEffectChanges ?? [];
  const submittedChangeSummaries = summarizeSubmittedChanges(input.cwd, input.submittedChanges);
  const sideEffectChangeSummaries = summarizeSideEffectChanges(input.cwd, sideEffectChanges);
  const question = input.kind === "question";
  const role = question
    ? "You are an independent reviewer consulted about work done by another coding agent."
    : "You are reviewing code changes made by another coding agent.";
  const task = question
    ? "Answer the user's reviewer question using the supplied context and read-only inspection of the current workspace when tools are available. The context may include submitted workspace changes, captured side-effect changes, tool calls, read-only investigation, shell output, planning discussion, and the primary agent's final summary. If no submitted patch is present, answer from the request context, captured side effects, session evidence, and any relevant files you inspect. Do not modify files, run commands with persistent side effects, use network access, or include chain of thought. Return only valid JSON matching the schema."
    : "Review the supplied user request context, submitted workspace patch, captured side-effect evidence, session evidence, and the current workspace for concrete code logic, correctness, regression, security, API, test, and acceptance-criteria problems. The user request context may include additional guidance given after the initial request; treat that later guidance as part of the same task, not as a replacement for the initial request. Do not ask for more context unless the supplied context and read-only inspection are impossible to review without it. Do not include chain of thought. Return only valid JSON matching the schema.";
  const questionBlock = question
    ? `Reviewer question:\n<question>\n${input.question}\n</question>\n\n`
    : "";
  const emptyPatch = question
    ? "(no submitted workspace patch supplied)"
    : "(no submitted workspace changes detected)";
  const questionVerdictPolicy = question
    ? '\nUse "pass" when the answer does not require the primary model to change course. Use "needs_changes" when the answer identifies something the primary model should fix, inspect, or ask the user about.\n'
    : "";

  return `${role}

${task}

${buildReviewerInstructions(input.guidanceEscalation)}

Workspace:
${input.cwd}

Review bundle:
${input.bundleDir ?? "(not supplied)"}

${questionBlock}User request context:
<request>
${input.request}
</request>

Submitted workspace changes:
<submitted_changes_json>
${JSON.stringify(submittedChangeSummaries, null, 2)}
</submitted_changes_json>

Submitted workspace patch:
<submitted_patch_diff>
${input.patch || emptyPatch}
</submitted_patch_diff>

Captured side-effect changes:
<captured_side_effect_changes_json>
${JSON.stringify(sideEffectChangeSummaries, null, 2)}
</captured_side_effect_changes_json>

Captured side-effect patch:
<captured_side_effect_patch_diff>
${input.sideEffectPatch || "(no captured side-effect changes detected)"}
</captured_side_effect_patch_diff>

Session evidence:
<session_evidence>
${input.evidenceMarkdown || "(no session evidence captured)"}
</session_evidence>

${input.changeIdentity
  ? `Change identity:
<change_identity>
base: ${input.changeIdentity.baseCommit}
candidate: ${input.changeIdentity.candidateCommit}
range: ${input.changeIdentity.baseCommit}..${input.changeIdentity.candidateCommit}
</change_identity>
This review verdict applies specifically to candidate commit ${input.changeIdentity.candidateCommit}.`
  : ""}

Use "file": "session" and "line": null for findings about missing commands, process evidence, or other issues that do not belong to a specific file.
${questionVerdictPolicy}`;
}
