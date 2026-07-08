import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChangedFile } from "./capture";
import { summarizeReviewChanges } from "./change-context";
import type { EvidenceBundle } from "./evidence";
import { buildReviewerPrompt, buildReviewerQuestionPrompt } from "./prompts";
import type { TokenUsage } from "./usage";

export interface ReviewBundleInput {
  cwd: string;
  request: string;
  changes: ChangedFile[];
  submittedChanges?: ChangedFile[];
  sideEffectChanges?: ChangedFile[];
  patch: string;
  sideEffectPatch?: string;
  evidence?: EvidenceBundle;
  actingUsage?: TokenUsage;
  metadata?: Record<string, unknown>;
}

export interface ReviewBundle {
  dir: string;
  prompt: string;
  requestPath: string;
  changedFilesPath: string;
  patchPath: string;
  sideEffectPatchPath: string;
  metadataPath: string;
  promptPath: string;
}

export interface ReviewerQuestionBundleInput {
  cwd: string;
  question: string;
  request: string;
  changes: ChangedFile[];
  submittedChanges?: ChangedFile[];
  sideEffectChanges?: ChangedFile[];
  patch: string;
  sideEffectPatch?: string;
  evidence?: EvidenceBundle;
  metadata?: Record<string, unknown>;
}

export async function createReviewBundle(input: ReviewBundleInput): Promise<ReviewBundle> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-"));
  const prompt = buildReviewerPrompt({
    request: input.request,
    changes: input.changes,
    submittedChanges: input.submittedChanges ?? input.changes,
    sideEffectChanges: input.sideEffectChanges ?? [],
    patch: input.patch,
    sideEffectPatch: input.sideEffectPatch,
    cwd: input.cwd,
    bundleDir: dir,
    evidenceMarkdown: input.evidence?.markdown,
  });

  const requestPath = join(dir, "request.md");
  const changedFilesPath = join(dir, "changed-files.json");
  const patchPath = join(dir, "patch.diff");
  const sideEffectPatchPath = join(dir, "side-effect.patch.diff");
  const metadataPath = join(dir, "metadata.json");
  const promptPath = join(dir, "reviewer-prompt.md");
  const evidenceJsonPath = join(dir, "evidence.json");
  const evidenceMarkdownPath = join(dir, "evidence.md");
  const actingUsagePath = join(dir, "acting-model-usage.json");

  const changedFiles = summarizeReviewChanges({
    cwd: input.cwd,
    submittedChanges: input.submittedChanges ?? input.changes,
    sideEffectChanges: input.sideEffectChanges ?? [],
  });

  await Promise.all([
    writeFile(requestPath, input.request, "utf8"),
    writeFile(changedFilesPath, JSON.stringify(changedFiles, null, 2), "utf8"),
    writeFile(patchPath, input.patch, "utf8"),
    writeFile(sideEffectPatchPath, input.sideEffectPatch ?? "", "utf8"),
    writeFile(metadataPath, JSON.stringify({ cwd: input.cwd, createdAt: new Date().toISOString(), ...input.metadata }, null, 2), "utf8"),
    writeFile(promptPath, prompt, "utf8"),
    writeFile(evidenceJsonPath, JSON.stringify(input.evidence ?? null, null, 2), "utf8"),
    writeFile(evidenceMarkdownPath, input.evidence?.markdown ?? "", "utf8"),
    writeFile(actingUsagePath, JSON.stringify(input.actingUsage ?? null, null, 2), "utf8"),
    writeReviewArtifacts(dir, input.submittedChanges ?? input.changes, input.sideEffectChanges ?? [], input.evidence),
  ]);

  return {
    dir,
    prompt,
    requestPath,
    changedFilesPath,
    patchPath,
    sideEffectPatchPath,
    metadataPath,
    promptPath,
  };
}

export async function createReviewerQuestionBundle(input: ReviewerQuestionBundleInput): Promise<ReviewBundle> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-"));
  const prompt = buildReviewerQuestionPrompt({
    question: input.question,
    request: input.request,
    changes: input.changes,
    submittedChanges: input.submittedChanges ?? input.changes,
    sideEffectChanges: input.sideEffectChanges ?? [],
    patch: input.patch,
    sideEffectPatch: input.sideEffectPatch,
    cwd: input.cwd,
    bundleDir: dir,
    evidenceMarkdown: input.evidence?.markdown,
  });

  const questionPath = join(dir, "question.md");
  const requestPath = join(dir, "request.md");
  const changedFilesPath = join(dir, "changed-files.json");
  const patchPath = join(dir, "patch.diff");
  const sideEffectPatchPath = join(dir, "side-effect.patch.diff");
  const metadataPath = join(dir, "metadata.json");
  const promptPath = join(dir, "reviewer-prompt.md");
  const evidenceJsonPath = join(dir, "evidence.json");
  const evidenceMarkdownPath = join(dir, "evidence.md");

  const changedFiles = summarizeReviewChanges({
    cwd: input.cwd,
    submittedChanges: input.submittedChanges ?? input.changes,
    sideEffectChanges: input.sideEffectChanges ?? [],
  });

  await Promise.all([
    writeFile(questionPath, input.question, "utf8"),
    writeFile(requestPath, input.request, "utf8"),
    writeFile(changedFilesPath, JSON.stringify(changedFiles, null, 2), "utf8"),
    writeFile(patchPath, input.patch, "utf8"),
    writeFile(sideEffectPatchPath, input.sideEffectPatch ?? "", "utf8"),
    writeFile(metadataPath, JSON.stringify({ cwd: input.cwd, createdAt: new Date().toISOString(), kind: "ask-reviewer", ...input.metadata }, null, 2), "utf8"),
    writeFile(promptPath, prompt, "utf8"),
    writeFile(evidenceJsonPath, JSON.stringify(input.evidence ?? null, null, 2), "utf8"),
    writeFile(evidenceMarkdownPath, input.evidence?.markdown ?? "", "utf8"),
    writeReviewArtifacts(dir, input.submittedChanges ?? input.changes, input.sideEffectChanges ?? [], input.evidence),
  ]);

  return {
    dir,
    prompt,
    requestPath,
    changedFilesPath,
    patchPath,
    sideEffectPatchPath,
    metadataPath,
    promptPath,
  };
}

export async function removeReviewBundle(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function writeReviewArtifacts(
  dir: string,
  submittedChanges: ChangedFile[],
  sideEffectChanges: ChangedFile[],
  evidence: EvidenceBundle | undefined,
): Promise<void> {
  const writes: Array<Promise<void>> = [];
  const artifactIndex: Array<{ kind: string; path: string; artifactPath: string; omitted?: string }> = [];

  for (const change of submittedChanges) {
    writes.push(...writeChangeContent(dir, "submitted", change, artifactIndex));
  }
  for (const change of sideEffectChanges) {
    writes.push(...writeChangeContent(dir, "side-effect", change, artifactIndex));
  }
  for (const candidate of evidence?.candidates ?? []) {
    const snapshot = candidate.baselineSnapshot;
    if (!snapshot?.content) {
      artifactIndex.push({
        kind: "evidence-baseline",
        path: candidate.path,
        artifactPath: "",
        omitted: snapshot?.omittedReason ?? candidate.baseline,
      });
      continue;
    }
    const artifactPath = join("artifacts", "evidence-baseline", safeArtifactPath(candidate.path));
    writes.push(writeArtifact(dir, artifactPath, snapshot.content));
    artifactIndex.push({ kind: "evidence-baseline", path: candidate.path, artifactPath });
  }

  writes.push(writeArtifact(dir, join("artifacts", "index.json"), JSON.stringify(artifactIndex, null, 2)));
  await Promise.all(writes);
}

function writeChangeContent(
  dir: string,
  kind: "submitted" | "side-effect",
  change: ChangedFile,
  artifactIndex: Array<{ kind: string; path: string; artifactPath: string; omitted?: string }>,
): Array<Promise<void>> {
  const writes: Array<Promise<void>> = [];
  for (const side of ["before", "after"] as const) {
    const content = side === "before" ? change.oldContent : change.newContent;
    if (content === undefined) {
      artifactIndex.push({
        kind: `${kind}-${side}`,
        path: change.path,
        artifactPath: "",
        omitted: change.diffOmittedReason ?? "content_unavailable",
      });
      continue;
    }
    const artifactPath = join("artifacts", kind, side, safeArtifactPath(change.path));
    writes.push(writeArtifact(dir, artifactPath, content));
    artifactIndex.push({ kind: `${kind}-${side}`, path: change.path, artifactPath });
  }
  return writes;
}

async function writeArtifact(dir: string, relativePath: string, content: string): Promise<void> {
  const path = join(dir, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function safeArtifactPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const withoutRoot = normalized.startsWith("/") ? `__absolute__/${normalized.slice(1)}` : normalized;
  return withoutRoot
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => part.replace(/[^a-zA-Z0-9._-]+/g, "_"))
    .join("/") || "unnamed";
}
