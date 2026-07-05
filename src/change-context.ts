import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { ChangedFile } from "./capture";

export type ReviewChangeRole = "submitted_workspace_change" | "captured_side_effect";
export type ReviewLocationKind = "workspace" | "workspace_unsubmitted" | "external_temp_like" | "external_persistent";

export interface ReviewChangeSummary {
  path: string;
  status: ChangedFile["status"];
  binary: boolean;
  oversized: boolean;
  diffOmittedReason?: string;
  reviewRole: ReviewChangeRole;
  locationKind: ReviewLocationKind;
  tempLike: boolean;
  note: string;
}

export function summarizeReviewChanges(input: {
  cwd: string;
  submittedChanges: ChangedFile[];
  sideEffectChanges: ChangedFile[];
}): ReviewChangeSummary[] {
  return [
    ...input.submittedChanges.map((change) => summarizeChange(input.cwd, change, "submitted_workspace_change")),
    ...input.sideEffectChanges.map((change) => summarizeChange(input.cwd, change, "captured_side_effect")),
  ];
}

export function summarizeSubmittedChanges(cwd: string, changes: ChangedFile[]): ReviewChangeSummary[] {
  return changes.map((change) => summarizeChange(cwd, change, "submitted_workspace_change"));
}

export function summarizeSideEffectChanges(cwd: string, changes: ChangedFile[]): ReviewChangeSummary[] {
  return changes.map((change) => summarizeChange(cwd, change, "captured_side_effect"));
}

function summarizeChange(cwd: string, change: ChangedFile, reviewRole: ReviewChangeRole): ReviewChangeSummary {
  const locationKind = classifyLocation(cwd, change.path, reviewRole);
  return {
    path: change.path,
    status: change.status,
    binary: change.binary,
    oversized: change.oversized,
    diffOmittedReason: change.diffOmittedReason,
    reviewRole,
    locationKind,
    tempLike: locationKind === "external_temp_like",
    note: noteForLocation(locationKind),
  };
}

function classifyLocation(cwd: string, path: string, reviewRole: ReviewChangeRole): ReviewLocationKind {
  const root = resolve(cwd);
  const absolutePath = isAbsolute(path) ? resolve(path) : resolve(root, path);
  if (reviewRole === "submitted_workspace_change") {
    return "workspace";
  }
  if (isInsideOrSame(root, absolutePath)) {
    return "workspace_unsubmitted";
  }
  if (isTempLikePath(absolutePath)) {
    return "external_temp_like";
  }
  return "external_persistent";
}

function noteForLocation(kind: ReviewLocationKind): string {
  if (kind === "workspace") {
    return "Detected as a submitted workspace change.";
  }
  if (kind === "workspace_unsubmitted") {
    return "Captured from tool evidence inside the workspace, but not detected as a submitted workspace change; this may be ignored, generated, or otherwise untracked process output.";
  }
  if (kind === "external_temp_like") {
    return "Captured outside the workspace under a temp-like path. This classification is a heuristic; treat this as likely process/scratch evidence, but still inspect for references, secrets, meaningful content, or harmful side effects.";
  }
  return "Captured outside the workspace in a persistent-looking location. Treat as high risk unless it was explicitly requested or configured as allowed.";
}

function isTempLikePath(path: string): boolean {
  return tempRoots().some((root) => isInsideOrSame(root, path));
}

function tempRoots(): string[] {
  return unique([
    tmpdir(),
    process.env.TMPDIR,
    process.env.TEMP,
    process.env.TMP,
    "/tmp",
    "/private/tmp",
    "/var/tmp",
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => resolve(value)));
}

function isInsideOrSame(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
