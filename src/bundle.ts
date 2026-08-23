import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChangedFile } from "./capture";
import type { ChangeIdentity } from "./schema";
import { summarizeReviewChanges } from "./change-context";
import type { EvidenceBundle } from "./evidence";
import {
  buildReviewerPrompt,
  buildReviewerQuestionPrompt,
  buildReviewerInstructions,
  REVIEW_AUTHORIZATION_POLICY,
  REVIEW_OUTCOME_POLICY,
  REVIEW_RESPONSE_FORMAT,
  REVIEW_TEST_POLICY,
  type ImplementationGuidanceEscalation,
} from "./prompts";
import type { ReviewExchangeContext } from "./state";
import type { TokenUsage } from "./usage";

interface ReviewBundleContext {
  dir?: string;
  reviewSequence?: number;
  exchanges?: ReviewExchangeContext[];
  cwd: string;
  request: string;
  submittedChanges: ChangedFile[];
  sideEffectChanges?: ChangedFile[];
  patch: string;
  sideEffectPatch?: string;
  evidence?: EvidenceBundle;
  actingUsage?: TokenUsage;
  guidanceEscalation?: ImplementationGuidanceEscalation;
  changeIdentity?: ChangeIdentity;
  metadata?: Record<string, unknown>;
}

export interface ReviewBundleInput extends ReviewBundleContext {}

export interface ReviewBundle {
  dir: string;
  invocationDir: string;
  prompt: string;
  bundlePrompt: string;
}

export interface ReviewerQuestionBundleInput extends ReviewBundleContext {
  question: string;
}

export async function createReviewBundle(input: ReviewBundleInput): Promise<ReviewBundle> {
  return createBundle({ kind: "review", ...input });
}

export async function createReviewerQuestionBundle(input: ReviewerQuestionBundleInput): Promise<ReviewBundle> {
  return createBundle({ kind: "question", ...input });
}

type CreateBundleInput =
  | ({ kind: "review" } & ReviewBundleInput)
  | ({ kind: "question" } & ReviewerQuestionBundleInput);

async function createBundle(input: CreateBundleInput): Promise<ReviewBundle> {
  const question = input.kind === "question";
  const dir = input.dir ?? await mkdtemp(join(tmpdir(), "pi-review-gate-"));
  const reviewSequence = input.reviewSequence ?? 1;
  const invocationDir = join(dir, question ? "questions" : "reviews", sequencePath(reviewSequence));
  await mkdir(invocationDir, { recursive: true });
  const promptContext = {
    request: input.request,
    submittedChanges: input.submittedChanges,
    sideEffectChanges: input.sideEffectChanges ?? [],
    patch: input.patch,
    sideEffectPatch: input.sideEffectPatch,
    cwd: input.cwd,
    bundleDir: dir,
    evidenceMarkdown: input.evidence?.markdown,
    guidanceEscalation: input.guidanceEscalation,
    changeIdentity: input.changeIdentity,
  };
  const prompt = question
    ? buildReviewerQuestionPrompt({ ...promptContext, question: input.question })
    : buildReviewerPrompt(promptContext);

  const changedFiles = summarizeReviewChanges({
    cwd: input.cwd,
    submittedChanges: input.submittedChanges,
    sideEffectChanges: input.sideEffectChanges ?? [],
  });

  const writes: Array<Promise<void>> = [
    writeFile(join(invocationDir, "request.md"), input.request, "utf8"),
    writeFile(join(invocationDir, "changed-files.json"), JSON.stringify(changedFiles, null, 2), "utf8"),
    writeFile(join(invocationDir, "patch.diff"), input.patch, "utf8"),
    writeFile(join(invocationDir, "side-effect.patch.diff"), input.sideEffectPatch ?? "", "utf8"),
    writeFile(join(invocationDir, "metadata.json"), JSON.stringify({
      cwd: input.cwd,
      createdAt: new Date().toISOString(),
      ...(question ? { kind: "ask-reviewer" } : {}),
      ...(input.changeIdentity ? { changeIdentity: input.changeIdentity } : {}),
      ...input.metadata,
    }, null, 2), "utf8"),
    writeFile(join(invocationDir, "reviewer-context.md"), prompt, "utf8"),
    writeFile(join(invocationDir, "reviewer-instructions.md"), buildReviewerInstructions(input.guidanceEscalation), "utf8"),
    writeFile(join(invocationDir, "evidence.json"), JSON.stringify(input.evidence ?? null, null, 2), "utf8"),
    writeFile(join(invocationDir, "evidence.md"), input.evidence?.markdown ?? "", "utf8"),
    writeReviewArtifacts(invocationDir, input.submittedChanges, input.sideEffectChanges ?? [], input.evidence),
    writeCurrentReviewFiles(dir, input.request, changedFiles, input.patch, input.sideEffectPatch ?? "", prompt, input.evidence, input.changeIdentity),
    writeExchangeArtifacts(dir, input.dir ? (input.exchanges ?? []).slice(-1) : input.exchanges ?? []),
    writeReviewIndex(dir, input.cwd, reviewSequence, input.exchanges ?? [], question),
  ];
  if (question) {
    writes.push(writeFile(join(invocationDir, "question.md"), input.question, "utf8"));
  } else {
    writes.push(writeFile(join(invocationDir, "acting-model-usage.json"), JSON.stringify(input.actingUsage ?? null, null, 2), "utf8"));
  }
  await Promise.all(writes);

  return {
    dir,
    invocationDir,
    prompt,
    bundlePrompt: buildBundlePrompt(dir, invocationDir, question),
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
    writeExchangeArtifacts(input.dir, input.exchanges.slice(-1)),
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
  changeIdentity: ChangeIdentity | undefined,
): Promise<void> {
  const currentDir = join(dir, "current");
  await mkdir(currentDir, { recursive: true });
  const writes: Array<Promise<void>> = [
    writeFile(join(dir, "request.md"), request, "utf8"),
    writeFile(join(currentDir, "changed-files.json"), JSON.stringify(changedFiles, null, 2), "utf8"),
    writeFile(join(currentDir, "cumulative.patch"), patch, "utf8"),
    writeFile(join(currentDir, "side-effect.patch"), sideEffectPatch, "utf8"),
    writeFile(join(currentDir, "reviewer-context.md"), prompt, "utf8"),
    writeFile(join(currentDir, "evidence.json"), JSON.stringify(evidence ?? null, null, 2), "utf8"),
    writeFile(join(currentDir, "evidence.md"), evidence?.markdown ?? "", "utf8"),
  ];
  if (changeIdentity) {
    writes.push(writeFile(join(currentDir, "change-identity.json"), JSON.stringify(changeIdentity, null, 2), "utf8"));
  } else {
    writes.push(rm(join(currentDir, "change-identity.json"), { force: true }));
  }
  await Promise.all(writes);
}

async function writeExchangeArtifacts(dir: string, exchanges: ReviewExchangeContext[]): Promise<void> {
  for (const exchange of exchanges) {
    const exchangeDir = join(dir, "exchanges", sequencePath(exchange.sequence));
    const metadataPath = join(exchangeDir, "metadata.json");
    const completionPath = join(exchangeDir, ".complete");
    if (await access(completionPath).then(() => true, () => false)) {
      continue;
    }
    await mkdir(exchangeDir, { recursive: true });
    await Promise.all([
      writeFile(metadataPath, JSON.stringify({
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
    await writeFile(completionPath, "", "utf8");
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
    "Read `request.md`, `current/changed-files.json`, and the current workspace before deciding.",
    "On the first review, start with `current/cumulative.patch`. For correction reviews, start with the latest `exchanges/<sequence>/submitted.patch`, tool events, and assistant summary, plus the immediately preceding review transmission that caused that exchange.",
    "`current/reviewer-context.md` contains the complete inlined fallback context. Do not read it by default during a correction review; use it only when the targeted artifacts and current files are insufficient.",
    "Earlier exchange directories and review results are historical evidence; the current workspace is ground truth.",
    "Do not read every earlier review pass by default. Consult older `implementing-model-transmission.md` and `delivery.json` files only when the latest correction evidence identifies a concrete unresolved dependency or contradiction.",
    "Do not inspect `sessions/`, raw model streams, invocation diagnostics, or any `reviews/<sequence>/reviewers/` and `questions/<sequence>/reviewers/` directories. Those are runtime/output artifacts, not review evidence; official prior results are in `implementing-model-transmission.md`.",
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
    REVIEW_AUTHORIZATION_POLICY,
    REVIEW_OUTCOME_POLICY,
    REVIEW_TEST_POLICY,
    `The authoritative evidence bundle is ${dir}.`,
    `Read ${join(dir, "REVIEW.md")} and ${join(invocationDir, "reviewer-instructions.md")} first, then follow the targeted evidence routing. Inspect the current workspace and the latest exchange files before expanding into historical or complete fallback context.`,
    "Do not inspect session/runtime streams or reviewer output directories. They are deliberately excluded from review evidence so each reviewer remains independent.",
    "Use read-only filesystem tools to inspect the evidence. If shell execution is the only filesystem interface, strictly read-only commands such as pwd, ls, find, rg, grep, sed, cat, and git status/diff/show are allowed.",
    "Never modify files, run commands with persistent side effects, use network access, or ask the primary agent for more context.",
    REVIEW_RESPONSE_FORMAT,
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
  const readable = withoutRoot
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .map((part) => part.replace(/[^a-zA-Z0-9._-]+/g, "_"))
    .join("/") || "unnamed";
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 12);
  return `${readable}--${digest}`;
}
