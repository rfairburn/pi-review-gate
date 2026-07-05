import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
