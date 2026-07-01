import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangedFile } from "./capture";
import type { EvidenceBundle } from "./evidence";
import { buildReviewerPrompt } from "./prompts";
import type { TokenUsage } from "./usage";

export interface ReviewBundleInput {
  cwd: string;
  request: string;
  changes: ChangedFile[];
  patch: string;
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
  metadataPath: string;
  promptPath: string;
}

export async function createReviewBundle(input: ReviewBundleInput): Promise<ReviewBundle> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-"));
  const prompt = buildReviewerPrompt({
    request: input.request,
    changes: input.changes,
    patch: input.patch,
    cwd: input.cwd,
    evidenceMarkdown: input.evidence?.markdown,
  });

  const requestPath = join(dir, "request.md");
  const changedFilesPath = join(dir, "changed-files.json");
  const patchPath = join(dir, "patch.diff");
  const metadataPath = join(dir, "metadata.json");
  const promptPath = join(dir, "reviewer-prompt.md");
  const evidenceJsonPath = join(dir, "evidence.json");
  const evidenceMarkdownPath = join(dir, "evidence.md");
  const actingUsagePath = join(dir, "acting-model-usage.json");

  const changedFiles = input.changes.map((change) => ({
    path: change.path,
    status: change.status,
    binary: change.binary,
    oversized: change.oversized,
    diffOmittedReason: change.diffOmittedReason,
  }));

  await Promise.all([
    writeFile(requestPath, input.request, "utf8"),
    writeFile(changedFilesPath, JSON.stringify(changedFiles, null, 2), "utf8"),
    writeFile(patchPath, input.patch, "utf8"),
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
    metadataPath,
    promptPath,
  };
}

export async function removeReviewBundle(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
