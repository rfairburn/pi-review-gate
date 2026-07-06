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
- Return "needs_changes" only when the primary agent can take a concrete follow-up action that could make a later review pass. If a finding is only a sentinel/status flag, acknowledgement, or other terminal note with no requested fix, return "pass" with a non_blocking finding instead of a blocking finding.`;

export function buildReviewerPrompt(input: {
  request: string;
  changes: ChangedFile[];
  submittedChanges?: ChangedFile[];
  sideEffectChanges?: ChangedFile[];
  patch: string;
  sideEffectPatch?: string;
  cwd: string;
  evidenceMarkdown?: string;
}): string {
  const submittedChanges = input.submittedChanges ?? input.changes;
  const sideEffectChanges = input.sideEffectChanges ?? [];
  const submittedChangeSummaries = summarizeSubmittedChanges(input.cwd, submittedChanges);
  const sideEffectChangeSummaries = summarizeSideEffectChanges(input.cwd, sideEffectChanges);

  return `You are reviewing code changes made by another coding agent.

Review only the supplied user request context, submitted workspace patch, captured side-effect evidence, and session evidence. The user request context may include additional guidance given after the initial request; treat that later guidance as part of the same task, not as a replacement for the initial request. Do not ask for more context unless the supplied context is impossible to review without it. Do not include chain of thought. Return only valid JSON matching the schema.

${REVIEW_CONTEXT_POLICY}

Workspace:
${input.cwd}

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
  "summary": string,
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
  evidenceMarkdown?: string;
}): string {
  const submittedChanges = input.submittedChanges ?? input.changes;
  const sideEffectChanges = input.sideEffectChanges ?? [];
  const submittedChangeSummaries = summarizeSubmittedChanges(input.cwd, submittedChanges);
  const sideEffectChangeSummaries = summarizeSideEffectChanges(input.cwd, sideEffectChanges);

  return `You are an independent reviewer consulted about work done by another coding agent.

Answer the user's reviewer question using only the supplied context. The context may include submitted workspace changes, captured side-effect changes, tool calls, read-only investigation, shell output, planning discussion, and the primary agent's final summary. If no submitted patch is present, answer from the request context, captured side effects, and session evidence. Do not include chain of thought. Return only valid JSON matching the schema.

${REVIEW_CONTEXT_POLICY}

Workspace:
${input.cwd}

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
  "summary": "Direct answer to the reviewer question.",
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
  const lines = findings.map((finding, index) => `${index + 1}. ${formatFinding(finding)}`);

  return [
    "Review found blocking issues in your last changes.",
    "",
    "Fix only these items:",
    ...lines,
    "",
    "After fixing, run the relevant tests and report the result.",
  ].join("\n");
}

function formatFinding(finding: ReviewFinding): string {
  const location = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
  return `${location} - ${finding.issue} ${finding.recommendation}`;
}
