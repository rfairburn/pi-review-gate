import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChangedFile } from "./capture";
import { summarizeReviewChanges } from "./change-context";
import type { EvidenceBundle } from "./evidence";
import { buildReviewerPrompt, buildReviewerQuestionPrompt } from "./prompts";
import type { ReviewExchangeContext } from "./state";
import type { TokenUsage } from "./usage";

export interface ReviewBundleInput {
  dir?: string;
  reviewSequence?: number;
  exchanges?: ReviewExchangeContext[];
  cwd: string;
  request: string;
  changes: ChangedFile[];
  submittedChanges?: ChangedFile[];
  sideEffectChanges?: ChangedFile[];
  patch: string;
  sideEffectPatch?: string;
  evidence?: EvidenceBundle;
  actingUsage?: TokenUsage;
  requireConcreteGuidance?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ReviewBundle {
  dir: string;
  invocationDir: string;
  prompt: string;
  bundlePrompt: string;
  requestPath: string;
  changedFilesPath: string;
  patchPath: string;
  sideEffectPatchPath: string;
  metadataPath: string;
  promptPath: string;
}

export interface ReviewerQuestionBundleInput {
  dir?: string;
  reviewSequence?: number;
  exchanges?: ReviewExchangeContext[];
  cwd: string;
  question: string;
  request: string;
  changes: ChangedFile[];
  submittedChanges?: ChangedFile[];
  sideEffectChanges?: ChangedFile[];
  patch: string;
  sideEffectPatch?: string;
  evidence?: EvidenceBundle;
  requireConcreteGuidance?: boolean;
  metadata?: Record<string, unknown>;
}

export async function createReviewBundle(input: ReviewBundleInput): Promise<ReviewBundle> {
  const dir = input.dir ?? await mkdtemp(join(tmpdir(), "pi-review-gate-"));
  const invocationDir = join(dir, "reviews", sequencePath(input.reviewSequence ?? 1));
  await mkdir(invocationDir, { recursive: true });
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
    requireConcreteGuidance: input.requireConcreteGuidance,
  });

  const requestPath = join(invocationDir, "request.md");
  const changedFilesPath = join(invocationDir, "changed-files.json");
  const patchPath = join(invocationDir, "patch.diff");
  const sideEffectPatchPath = join(invocationDir, "side-effect.patch.diff");
  const metadataPath = join(invocationDir, "metadata.json");
  const promptPath = join(invocationDir, "reviewer-context.md");
  const evidenceJsonPath = join(invocationDir, "evidence.json");
  const evidenceMarkdownPath = join(invocationDir, "evidence.md");
  const actingUsagePath = join(invocationDir, "acting-model-usage.json");

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
    writeReviewArtifacts(invocationDir, input.submittedChanges ?? input.changes, input.sideEffectChanges ?? [], input.evidence),
    writeCurrentReviewFiles(dir, input.request, changedFiles, input.patch, input.sideEffectPatch ?? "", prompt, input.evidence),
    writeExchangeArtifacts(dir, input.exchanges ?? []),
    writeReviewIndex(dir, input.cwd, input.reviewSequence ?? 1, input.exchanges ?? [], false),
  ]);

  const bundlePrompt = buildBundlePrompt(dir, invocationDir, false);

  return {
    dir,
    invocationDir,
    prompt,
    bundlePrompt,
    requestPath,
    changedFilesPath,
    patchPath,
    sideEffectPatchPath,
    metadataPath,
    promptPath,
  };
}

export async function createReviewerQuestionBundle(input: ReviewerQuestionBundleInput): Promise<ReviewBundle> {
  const dir = input.dir ?? await mkdtemp(join(tmpdir(), "pi-review-gate-"));
  const invocationDir = join(dir, "questions", sequencePath(input.reviewSequence ?? 1));
  await mkdir(invocationDir, { recursive: true });
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
    requireConcreteGuidance: input.requireConcreteGuidance,
  });

  const questionPath = join(invocationDir, "question.md");
  const requestPath = join(invocationDir, "request.md");
  const changedFilesPath = join(invocationDir, "changed-files.json");
  const patchPath = join(invocationDir, "patch.diff");
  const sideEffectPatchPath = join(invocationDir, "side-effect.patch.diff");
  const metadataPath = join(invocationDir, "metadata.json");
  const promptPath = join(invocationDir, "reviewer-context.md");
  const evidenceJsonPath = join(invocationDir, "evidence.json");
  const evidenceMarkdownPath = join(invocationDir, "evidence.md");

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
    writeReviewArtifacts(invocationDir, input.submittedChanges ?? input.changes, input.sideEffectChanges ?? [], input.evidence),
    writeCurrentReviewFiles(dir, input.request, changedFiles, input.patch, input.sideEffectPatch ?? "", prompt, input.evidence),
    writeExchangeArtifacts(dir, input.exchanges ?? []),
    writeReviewIndex(dir, input.cwd, input.reviewSequence ?? 1, input.exchanges ?? [], true),
  ]);

  const bundlePrompt = buildBundlePrompt(dir, invocationDir, true);

  return {
    dir,
    invocationDir,
    prompt,
    bundlePrompt,
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

export async function removeTransientWindowBundle(window: ReviewExchangeBundleOwner | undefined): Promise<void> {
  if (window?.bundleDir && !window.retainBundleAfterClose) {
    await removeReviewBundle(window.bundleDir);
    window.bundleDir = undefined;
  }
}

export async function syncReviewWindowArtifacts(input: {
  dir: string;
  cwd: string;
  currentReviewSequence: number;
  exchanges: ReviewExchangeContext[];
}): Promise<void> {
  await Promise.all([
    writeExchangeArtifacts(input.dir, input.exchanges),
    writeReviewIndex(input.dir, input.cwd, input.currentReviewSequence, input.exchanges, false),
  ]);
}

interface ReviewExchangeBundleOwner {
  bundleDir?: string;
  retainBundleAfterClose: boolean;
}

async function writeCurrentReviewFiles(
  dir: string,
  request: string,
  changedFiles: unknown,
  patch: string,
  sideEffectPatch: string,
  prompt: string,
  evidence: EvidenceBundle | undefined,
): Promise<void> {
  const currentDir = join(dir, "current");
  await mkdir(currentDir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, "request.md"), request, "utf8"),
    writeFile(join(currentDir, "changed-files.json"), JSON.stringify(changedFiles, null, 2), "utf8"),
    writeFile(join(currentDir, "cumulative.patch"), patch, "utf8"),
    writeFile(join(currentDir, "side-effect.patch"), sideEffectPatch, "utf8"),
    writeFile(join(currentDir, "reviewer-context.md"), prompt, "utf8"),
    writeFile(join(currentDir, "evidence.json"), JSON.stringify(evidence ?? null, null, 2), "utf8"),
    writeFile(join(currentDir, "evidence.md"), evidence?.markdown ?? "", "utf8"),
  ]);
}

async function writeExchangeArtifacts(dir: string, exchanges: ReviewExchangeContext[]): Promise<void> {
  for (const exchange of exchanges) {
    const exchangeDir = join(dir, "exchanges", sequencePath(exchange.sequence));
    await mkdir(exchangeDir, { recursive: true });
    await Promise.all([
      writeFile(join(exchangeDir, "metadata.json"), JSON.stringify({
        sequence: exchange.sequence,
        startedAt: exchange.startedAt,
        endedAt: exchange.endedAt,
        causedByReviewSequence: exchange.causedByReviewSequence,
        causedByReviewVerdict: exchange.causedByReviewVerdict,
        reviewResponseMode: exchange.reviewResponseMode,
      }, null, 2), "utf8"),
      writeFile(join(exchangeDir, "submitted.patch"), exchange.workspacePatch || "(no submitted workspace changes)", "utf8"),
      writeFile(join(exchangeDir, "side-effects.patch"), exchange.sideEffectPatch || "(no captured side-effect changes)", "utf8"),
      writeFile(join(exchangeDir, "tool-events.json"), JSON.stringify(exchange.evidenceEvents, null, 2), "utf8"),
      writeFile(join(exchangeDir, "tool-events.md"), renderExchangeEvents(exchange), "utf8"),
      writeFile(join(exchangeDir, "assistant-summary.md"), exchange.assistantSummaries.join("\n\n---\n\n"), "utf8"),
      writeFile(join(exchangeDir, "user-guidance.md"), exchange.userRequests.map((request) => request.text).join("\n\n---\n\n"), "utf8"),
      writeFile(join(exchangeDir, "acting-model-usage.json"), JSON.stringify(exchange.actingUsage ?? null, null, 2), "utf8"),
      writeReviewArtifacts(exchangeDir, exchange.workspaceChanges, exchange.sideEffectChanges, undefined),
    ]);
  }
}

async function writeReviewIndex(
  dir: string,
  cwd: string,
  reviewSequence: number,
  exchanges: ReviewExchangeContext[],
  question: boolean,
): Promise<void> {
  const latestExchange = exchanges.at(-1)?.sequence;
  const manifest = {
    version: 1,
    workspace: cwd,
    bundleDir: dir,
    currentReviewSequence: reviewSequence,
    kind: question ? "reviewer-question" : "review",
    exchangeSequences: exchanges.map((exchange) => exchange.sequence),
    latestExchange,
    entrypoint: "REVIEW.md",
    current: {
      request: "request.md",
      changedFiles: "current/changed-files.json",
      cumulativePatch: "current/cumulative.patch",
      sideEffectPatch: "current/side-effect.patch",
      evidence: "current/evidence.md",
      reviewerContext: "current/reviewer-context.md",
    },
  };
  const lines = [
    "# Review Evidence Bundle",
    "",
    `Workspace: ${cwd}`,
    `Current ${question ? "question" : "review"}: ${reviewSequence}`,
    `Latest completed exchange: ${latestExchange ?? "none"}`,
    "",
    "Read `request.md`, `current/reviewer-context.md`, and the current workspace before deciding.",
    "For correction reviews, read the latest `exchanges/<sequence>/submitted.patch`, tool events, and assistant summary.",
    "Earlier exchange directories and review results are historical evidence; the current workspace is ground truth.",
    "For every completed prior pass, read `reviews/<sequence>/implementing-model-transmission.md` and `delivery.json`. Those files record exactly what the implementing model was told and whether it was a required correction, passing observation, deferred finding, or review error.",
    "A numbered invocation containing `CANCELED.md` is a cancellation tombstone, not a completed reviewer result. It preserves sequence history but contributes no verdict or findings.",
    "",
    "## Exchanges",
    "",
    ...(exchanges.length > 0
      ? exchanges.map((exchange) => [
        `- Exchange ${exchange.sequence}`,
        exchange.causedByReviewSequence ? ` (response to review ${exchange.causedByReviewSequence})` : "",
        `: \`exchanges/${sequencePath(exchange.sequence)}/\``,
      ].join(""))
      : ["- None"]),
    "",
    "## Prior review invocations",
    "",
    reviewSequence > 1
      ? "Inspect the numbered `reviews/` and `questions/` directories as needed."
      : "- None",
    "",
  ];
  await Promise.all([
    writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8"),
    writeFile(join(dir, "REVIEW.md"), lines.join("\n"), "utf8"),
  ]);
}

function buildBundlePrompt(dir: string, invocationDir: string, question: boolean): string {
  return [
    `You are an independent read-only ${question ? "reviewer answering a question" : "code reviewer"}.`,
    `The authoritative evidence bundle is ${dir}.`,
    `Read ${join(dir, "REVIEW.md")} first, then ${join(invocationDir, "reviewer-context.md")}, the latest exchange files it references, and the current workspace.`,
    "Do not modify files, run shell commands, use network access, or ask the primary agent for more context.",
    "Return only the JSON response required by reviewer-context.md.",
  ].join("\n");
}

function renderExchangeEvents(exchange: ReviewExchangeContext): string {
  if (exchange.evidenceEvents.length === 0) {
    return "(no tool events captured)\n";
  }
  return exchange.evidenceEvents.map((event) => {
    const paths = event.candidatePaths.length > 0 ? ` paths=${event.candidatePaths.join(",")}` : "";
    return `- #${event.sequence} ${event.phase} ${event.toolName}${event.isError ? " ERROR" : ""}${paths}: ${event.summary}`;
  }).join("\n") + "\n";
}

function sequencePath(sequence: number): string {
  return String(sequence).padStart(4, "0");
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
