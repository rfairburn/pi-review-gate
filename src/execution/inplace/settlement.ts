import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { redactSensitiveText } from "../../redaction";
import { TOOLS_ONLY_LABEL } from "../../review-evidence";
import { buildReviewReportFromOutputs } from "../../review-report";
import { buildOperationDiagnostics, readOperationRecord, writeOperationRecord } from "../operation-record";
import { computeInPlaceAttribution } from "./basis";
import type { InPlaceLifecycleInput, InPlaceLifecycleResult } from "./contracts";
import { createEvidenceState } from "../../evidence";
import { restoreObservedToolEvidence } from "../observed-evidence";

async function writeInPlaceResult(artifactDir: string, result: InPlaceLifecycleResult): Promise<void> {
  await writeFile(
    join(artifactDir, "result.json"),
    JSON.stringify({
      version: 1,
      inPlace: true,
      workspaceRoot: result.workspaceRoot,
      baseline: {
        mode: result.baseline.mode,
        ...(result.baseline.gitHead ? { gitHead: result.baseline.gitHead } : {}),
        capturedAt: result.baseline.capturedAt,
        omissions: result.baseline.snapshot?.omissions.length,
        omissionsTruncated: result.baseline.snapshot?.omissionsTruncated,
      },
      evidenceMethod: result.evidenceMethod ?? "snapshot",
      evidenceCoverageNotice: result.evidenceCoverageNotice,
      changedSinceLaunch: result.changedSinceLaunch,
      observedExternalPaths: result.observedExternalPaths ?? [],
      toolObservabilityNotes: result.toolObservabilityNotes ?? [],
      toolObservationsTruncated: result.toolObservationsTruncated === true,
      reviewEvidenceNotes: result.reviewEvidenceNotes ?? [],
      reviewEvidenceNotesTruncated: result.reviewEvidenceNotesTruncated === true,
      ...(result.attributionError ? { attributionError: result.attributionError } : {}),
      status: result.status,
      taskId: result.taskId,
      title: result.title,
      summary: result.summary,
      adapter: result.adapter,
      model: result.model,
      reviewCycles: result.reviewCycles.map((cycle) => ({
        cycle: cycle.cycle,
        verdict: cycle.verdict,
        evidenceMethod: cycle.reviewOutput.evidenceMethod ?? "snapshot",
        evidenceCoverageNotice: cycle.reviewOutput.evidenceCoverageNotice,
        toolObservationRevision: cycle.toolObservationRevision,
        changedSinceLaunchCount: cycle.changedSinceLaunch.length,
      })),
      reviewReport: result.reviewReport,
      operationRecord: result.operationRecord,
      incidents: result.incidents,
      attempts: result.attempts,
      diagnostics: result.diagnostics,
      error: result.error,
      completedAt: new Date().toISOString(),
    }, null, 2),
    "utf8",
  );
}

async function operationStateFor(input: Pick<InPlaceLifecycleInput, "taskId" | "workspaceRoot" | "artifactDir" | "config" | "task">, result: InPlaceLifecycleResult): Promise<void> {
  const state = result.status === "reviewed" || result.status === "unreviewed" || result.status === "no_changes"
    ? "completed"
    : result.status === "cancelled"
      ? "cancelled"
      : "paused_recoverable";
  try {
    const operation = await readOperationRecord(join(input.artifactDir, "operation.json"));
    if (operation.state !== "failed_critical") operation.state = state;
    result.diagnostics = await buildOperationDiagnostics(operation, resolve(input.workspaceRoot));
    await writeOperationRecord(operation);
  } catch {
    // Best-effort diagnostics; the lifecycle result stays authoritative.
  }
}

/** Single settlement path: operation state, result.json, review report. */
export async function settleInPlace(input: InPlaceLifecycleInput, result: InPlaceLifecycleResult): Promise<InPlaceLifecycleResult> {
  const evidence = createEvidenceState();
  await restoreObservedToolEvidence(evidence, result.artifactDir, result.workspaceRoot, {
    required: result.baseline.mode === "tool" || input.task.reviewEvidencePolicy?.toolOnly === true
      || result.evidenceMethod === "tool-only" || result.evidenceMethod === "tool-only-fallback",
  });
  result.observedExternalPaths = [...evidence.candidates.values()]
    .filter((candidate) => candidate.externalSideEffect === true)
    .map((candidate) => redactSensitiveText(candidate.absolutePath));
  result.toolObservabilityNotes = [...(evidence.toolObservabilityNotes ?? [])];
  result.toolObservationsTruncated = evidence.toolObservationsTruncated === true;
  result.reviewEvidenceNotes = [...(evidence.reviewEvidenceNotes ?? [])];
  result.reviewEvidenceNotesTruncated = evidence.reviewEvidenceNotesTruncated === true;
  if (result.status === "no_changes") {
    const notes = result.toolObservabilityNotes ?? [];
    const snapshotLimits = ` Snapshot policy excludes ignored directories (including .git, node_modules, and dist) and may omit content for oversized or unreadable files; ${result.baseline.snapshot?.omissions.length ?? 0} omission(s) were recorded${result.baseline.snapshot?.omissionsTruncated ? " and the omission list was truncated" : ""}.`;
    const interval = result.baseline.mode === "tool" || result.baseline.toolOnlyHistory
      ? `No subsequent-work snapshot delta was recorded. Earlier ${TOOLS_ONLY_LABEL} work is not certified as unchanged since launch.`
      : "No workspace paths changed within the recorded bounded snapshot since launch.";
    result.summary = `${interval} This does not establish that no external side effects occurred.${snapshotLimits}${notes.length > 0 ? ` Tool-event observability limits: ${notes.join("; ")}` : ""}${result.toolObservationsTruncated ? " The bounded tool-event evidence limit was reached; additional observations were omitted." : ""}`;
  }
  const disclosureNotes = [...(result.reviewEvidenceNotes ?? []), ...(result.toolObservabilityNotes ?? [])];
  if (result.toolObservationsTruncated && result.status !== "no_changes") {
    disclosureNotes.push("The bounded tool-event/path evidence limit was reached; additional observations were omitted.");
  }
  if (result.reviewEvidenceNotesTruncated) {
    disclosureNotes.push("Earlier method/fallback notices were omitted at the evidence bound.");
  }
  if (disclosureNotes.length > 0) {
    const disclosure = `Review evidence limitations: ${disclosureNotes.slice(-4).join("; ")}`;
    if (!result.summary.includes(disclosure)) result.summary = `${result.summary}\n\n${disclosure}`;
  }
  result.reviewReport ??= buildReviewReportFromOutputs({
    outputs: result.reviewCycles.map((cycle) => ({ reviewOutput: cycle.reviewOutput })),
    artifactDir: result.artifactDir,
  });
  // #220 pass-2 (finding 1): a failed, timed-out, interrupted, or otherwise
  // stopped lifecycle can leave writes the worker already performed. The
  // settle-time result must carry the REAL recorded workspace delta against
  // the launch baseline — never a fabricated empty delta; when inspection
  // fails the delta is reported as UNKNOWN via attributionError instead of
  // zero. Reviewed/unreviewed/no_changes already carry a settled delta.
  const toolBasis = result.baseline.mode === "tool" || (result.evidenceMethod !== undefined && result.evidenceMethod !== "snapshot");
  if (toolBasis) {
    // No whole-root capture, even during failure/cancellation settlement.
    result.changedSinceLaunch = [];
    result.attributionError = `not captured under ${TOOLS_ONLY_LABEL}; absence of observed paths is not proof of no effects`;
  } else if (!["reviewed", "unreviewed", "no_changes"].includes(result.status)) {
    try {
      // Pass 3 (finding 1): the turn may have been cancelled, and its abort
      // signal aborts any dependent operation. Settlement runs AFTER the turn
      // has stopped, so inspect the writes left in place WITHOUT that
      // signal; genuine inspection failures still land in attributionError.
      if (result.baseline.mode === "tool") throw new Error("Tool basis has no workspace snapshot.");
      const latest = await computeInPlaceAttribution(result.baseline, input.config);
      result.changedSinceLaunch = latest.changes.map(({ status, path }) => ({ status, path }));
    } catch (error) {
      result.attributionError = error instanceof Error ? error.message : String(error);
    }
  } else {
    delete result.attributionError;
  }
  await operationStateFor(input, result);
  await writeInPlaceResult(result.artifactDir, result);
  return result;
}
