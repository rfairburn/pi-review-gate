import type { ChangedFile } from "./capture";
import { summarizeSideEffectChanges, summarizeSubmittedChanges } from "./change-context";
import type { ReviewFinding, ReviewResult } from "./schema";

const REVIEW_CONTEXT_POLICY = `Review policy:
- Submitted workspace changes are the primary implementation under review.
- Captured side-effect changes are evidence from tool activity that was not detected as submitted workspace changes. They may include temp-like process artifacts, generated files, or real outside-workspace side effects.
- A temp-like side-effect classification is a heuristic, not a guarantee. Do not block solely because a temp-like external file exists, but do block if it is referenced by submitted code, contains secrets, stores meaningful user content, changes persistent behavior, or indicates unsafe/unmanaged side effects.
- Persistent-looking external side effects deserve scrutiny, but do not block solely because they are outside the workspace or not explicitly named in the user request. Block only when they are unrelated to the task, modify user/environment configuration, create or change executable/runtime content, store meaningful user data in an unmanaged location, leak secrets, or leave state that affects future behavior.
- Working notes or review documents may be acceptable when they are consistent with the session context; review them for correctness, not for their mere existence.
- Workspace side effects that are not submitted changes should be reviewed for accidental generated output, ignored files needed by the implementation, or files that should be cleaned up.
- If you have read-only tools, use them as needed to inspect the workspace and review bundle. Treat the workspace as ground truth. Do not modify files, run shell commands, use network access, or ask the primary model for more context.
- Prior review feedback in the request context is historical evidence, not a statement of the current workspace. Independently verify every prior finding against the current files and patch.
- Complete individual results from prior review passes were transmitted to the implementing model under the disposition shown in the request context. A request recorded as sent for correction establishes why the following implementation exchange occurred; do not call that correction unsolicited merely because it originated with a reviewer rather than the user.
- Passing assessments and non-blocking observations are visible context, not mandatory corrections. Feedback disclosed with correction deferred also does not establish an immediate correction obligation. User instructions remain authoritative when reviewer feedback conflicts with them.
- Do not repeat a prior finding when its requested correction is present. Repeat it only if you can cite current file/line or current session evidence showing a concrete remaining defect, and explain why the prior correction was insufficient.
- If you do not have tools, review from the supplied prompt and be explicit in your summary when the supplied context is insufficient for certainty.
- Return "needs_changes" only when the primary agent can take a concrete follow-up action that could make a later review pass. If a finding is only a sentinel/status flag, acknowledgement, or other terminal note with no requested fix, return "pass" with a non_blocking finding instead of a blocking finding.`;

function implementationGuidancePolicy(requireConcreteGuidance: boolean): string {
  return `Response quality:
- Put the direct conclusion in "summary".
- Put actionable explanation in "guidance" as Markdown.
- Include a concise fenced code snippet or minimal diff in "guidance" or a finding recommendation whenever it would materially help the primary model implement or correct the work.
- Do not add decorative or redundant code when prose is sufficient.
- Preserve exact identifiers, commands, and replacement text needed to act on the review.
${requireConcreteGuidance
    ? "- One or more correction attempts have occurred. First determine from the current workspace whether each historical finding is resolved. Only for a problem you independently verify still remains, you MUST provide a concrete implementation example or minimal diff unless code would be inapplicable; in that case, provide exact actionable steps. Do not infer that a problem remains merely because it appears in prior feedback."
    : "- Make the first response implementation-ready; do not defer useful concrete guidance to a later review."}`;
}

export function buildReviewerPrompt(input: {
  request: string;
  changes: ChangedFile[];
  submittedChanges?: ChangedFile[];
  sideEffectChanges?: ChangedFile[];
  patch: string;
  sideEffectPatch?: string;
  cwd: string;
  bundleDir?: string;
  evidenceMarkdown?: string;
  requireConcreteGuidance?: boolean;
}): string {
  const submittedChanges = input.submittedChanges ?? input.changes;
  const sideEffectChanges = input.sideEffectChanges ?? [];
  const submittedChangeSummaries = summarizeSubmittedChanges(input.cwd, submittedChanges);
  const sideEffectChangeSummaries = summarizeSideEffectChanges(input.cwd, sideEffectChanges);

  return `You are reviewing code changes made by another coding agent.

Review the supplied user request context, submitted workspace patch, captured side-effect evidence, session evidence, and the current workspace. The user request context may include additional guidance given after the initial request; treat that later guidance as part of the same task, not as a replacement for the initial request. Do not ask for more context unless the supplied context and read-only inspection are impossible to review without it. Do not include chain of thought. Return only valid JSON matching the schema.

${REVIEW_CONTEXT_POLICY}

${implementationGuidancePolicy(input.requireConcreteGuidance ?? false)}

Workspace:
${input.cwd}

Review bundle:
${input.bundleDir ?? "(not supplied)"}

User request context:
<request>
${input.request}
</request>

Submitted workspace changes:
<submitted_changes_json>
${JSON.stringify(submittedChangeSummaries, null, 2)}
</submitted_changes_json>

Submitted workspace patch:
<submitted_patch_diff>
${input.patch || "(no submitted workspace changes detected)"}
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

Return JSON:
{
  "verdict": "pass" | "needs_changes",
  "summary": "Direct conclusion.",
  "guidance": "Markdown explanation and implementation guidance.",
  "findings": [
    {
      "severity": "blocking" | "non_blocking",
      "file": string,
      "line": number | null,
      "issue": string,
      "recommendation": string
    }
  ]
}

Use "file": "session" and "line": null for findings about missing commands, process evidence, or other issues that do not belong to a specific file.
`;
}

export function buildReviewerQuestionPrompt(input: {
  question: string;
  request: string;
  changes: ChangedFile[];
  submittedChanges?: ChangedFile[];
  sideEffectChanges?: ChangedFile[];
  patch: string;
  sideEffectPatch?: string;
  cwd: string;
  bundleDir?: string;
  evidenceMarkdown?: string;
  requireConcreteGuidance?: boolean;
}): string {
  const submittedChanges = input.submittedChanges ?? input.changes;
  const sideEffectChanges = input.sideEffectChanges ?? [];
  const submittedChangeSummaries = summarizeSubmittedChanges(input.cwd, submittedChanges);
  const sideEffectChangeSummaries = summarizeSideEffectChanges(input.cwd, sideEffectChanges);

  return `You are an independent reviewer consulted about work done by another coding agent.

Answer the user's reviewer question using the supplied context and read-only inspection of the current workspace when tools are available. The context may include submitted workspace changes, captured side-effect changes, tool calls, read-only investigation, shell output, planning discussion, and the primary agent's final summary. If no submitted patch is present, answer from the request context, captured side effects, session evidence, and any relevant files you inspect. Do not modify files, run shell commands, use network access, or include chain of thought. Return only valid JSON matching the schema.

${REVIEW_CONTEXT_POLICY}

${implementationGuidancePolicy(input.requireConcreteGuidance ?? false)}

Workspace:
${input.cwd}

Review bundle:
${input.bundleDir ?? "(not supplied)"}

Reviewer question:
<question>
${input.question}
</question>

User request context:
<request>
${input.request}
</request>

Submitted workspace changes:
<submitted_changes_json>
${JSON.stringify(submittedChangeSummaries, null, 2)}
</submitted_changes_json>

Submitted workspace patch:
<submitted_patch_diff>
${input.patch || "(no submitted workspace patch supplied)"}
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

Return JSON:
{
  "verdict": "pass" | "needs_changes",
  "summary": "Direct conclusion.",
  "guidance": "Direct Markdown answer and implementation guidance.",
  "findings": [
    {
      "severity": "blocking" | "non_blocking",
      "file": string,
      "line": number | null,
      "issue": string,
      "recommendation": string
    }
  ]
}

Use "file": "session" and "line": null for findings about missing commands, process evidence, or other issues that do not belong to a specific file.

Use "pass" when the answer does not require the primary model to change course. Use "needs_changes" when the answer identifies something the primary model should fix, inspect, or ask the user about.
`;
}

export function buildFollowUpMessage(result: ReviewResult): string {
  const blocking = result.findings.filter((finding) => finding.severity === "blocking");
  const findings = blocking.length > 0 ? blocking : result.findings;
  const lines = findings.map((finding, index) => `${index + 1}. ${formatFindingForFollowUp(finding)}`);

  return [
    "Review found blocking issues in your last changes.",
    ...(result.guidance ? ["", "Implementation guidance:", result.guidance] : []),
    "",
    "Fix only these items:",
    ...lines,
    "",
    "After fixing, run the relevant tests and report the result.",
  ].join("\n");
}

export function buildReviewerResultsNotice(results: ReviewResult[] | undefined, bundleDir?: string): string {
  const lines: string[] = [];
  if (results && results.length > 1) {
    lines.push("Reviewer results:");
    for (const result of results) {
      lines.push(formatReviewerResult(result));
    }
  }
  if (bundleDir) {
    lines.push(`Retained review bundle: ${bundleDir}`);
  }
  return lines.join("\n");
}

function formatFinding(finding: ReviewFinding): string {
  const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  const reviewer = finding.reviewerId ? `[${finding.reviewerId}] ` : "";
  return `${reviewer}${location} - ${finding.issue} ${finding.recommendation}`;
}

function formatFindingForFollowUp(finding: ReviewFinding): string {
  const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  const reviewer = finding.reviewerId ? `[${finding.reviewerId}] ` : "";
  return [
    `${reviewer}${location}`,
    `Issue: ${finding.issue}`,
    `Recommendation: ${finding.recommendation}`,
  ].join("\n");
}

function formatReviewerResult(result: ReviewResult): string {
  const counts = [];
  const blocking = result.findings.filter((finding) => finding.severity === "blocking").length;
  const nonBlocking = result.findings.filter((finding) => finding.severity === "non_blocking").length;
  if (blocking > 0) {
    counts.push(`${blocking} blocking`);
  }
  if (nonBlocking > 0) {
    counts.push(`${nonBlocking} non-blocking`);
  }
  const status = counts.length > 0 ? `${result.verdict}, ${counts.join(", ")}` : result.verdict;
  const error = result.error ? ` (${result.error})` : "";
  return `- ${result.reviewerId}: ${status}${error} - ${compactReviewerSummary(result.summary)}`;
}

function compactReviewerSummary(summary: string): string {
  const compact = summary.replace(/\s+/g, " ").trim();
  return compact.length > 360 ? `${compact.slice(0, 357)}...` : compact;
}
