import type { ChangedFile } from "./capture";
import type { ReviewFinding, ReviewResult } from "./schema";

export function buildReviewerPrompt(input: {
  request: string;
  changes: ChangedFile[];
  patch: string;
  cwd: string;
  evidenceMarkdown?: string;
}): string {
  const changedFiles = input.changes.map((change) => ({
    path: change.path,
    status: change.status,
    binary: change.binary,
    oversized: change.oversized,
    diffOmittedReason: change.diffOmittedReason,
  }));

  return `You are reviewing code changes made by another coding agent.

Review only the supplied user request context, patch, and session evidence. The user request context may include additional guidance given after the initial request; treat that later guidance as part of the same task, not as a replacement for the initial request. Do not ask for more context unless the patch is impossible to review without it. Do not include chain of thought. Return only valid JSON matching the schema.

Workspace:
${input.cwd}

User request context:
<request>
${input.request}
</request>

Changed files:
<changed_files_json>
${JSON.stringify(changedFiles, null, 2)}
</changed_files_json>

Patch:
<patch_diff>
${input.patch}
</patch_diff>

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
`;
}

export function buildReviewerQuestionPrompt(input: {
  question: string;
  request: string;
  changes: ChangedFile[];
  patch: string;
  cwd: string;
  evidenceMarkdown?: string;
}): string {
  const changedFiles = input.changes.map((change) => ({
    path: change.path,
    status: change.status,
    binary: change.binary,
    oversized: change.oversized,
    diffOmittedReason: change.diffOmittedReason,
  }));

  return `You are an independent reviewer consulted about work done by another coding agent.

Answer the user's reviewer question using only the supplied context. The context may include code changes, tool calls, read-only investigation, shell output, planning discussion, and the primary agent's final summary. If no patch is present, answer from the request context and session evidence. Do not include chain of thought. Return only valid JSON matching the schema.

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

Changed files:
<changed_files_json>
${JSON.stringify(changedFiles, null, 2)}
</changed_files_json>

Patch:
<patch_diff>
${input.patch || "(no patch supplied)"}
</patch_diff>

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
