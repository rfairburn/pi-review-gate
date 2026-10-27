import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PiDeciderConfig } from "../config";
import { parseReviewResult, type ReviewResult } from "../schema";
import { extractReviewTextFromPiJsonl, PiJsonlReviewExtractor } from "../usage";
import { PiJsonlActivityExtractor } from "../execution/progress";
import {
  PI_SESSION_REFERENCE_ENV,
} from "../pi-session-reference-reporter";
import {
  PI_SESSION_REFERENCE_DIRNAME,
  readPiSessionReferenceAt,
  verifyPiSessionReference,
} from "../pi-session-reference";
import {
  processFailureResult,
  processTelemetry,
  reviewerArtifactPaths,
  reviewerEnv,
  reviewerErrorResult,
  runPromptProcess,
  writeReviewerProcessArtifacts,
} from "./process";
import type { ModelAdapter, ModelAdapterRequest } from "./types";
import { assertNoPiToolPolicyArgs } from "../pi-tool-policy";

/**
 * Compiled path of the gate-owned session reference reporter (#533). Reviewers
 * run `--no-extensions` (discovery off) and load ONLY this explicit file, so
 * the child gains no discovered, configured, or built-in extension.
 */
const SESSION_REPORTER_EXTENSION = resolve(__dirname, "..", "pi-session-reference-reporter.js");

export class PiModelAdapter implements ModelAdapter {
  readonly kind = "pi-model";

  constructor(
    private readonly config: PiDeciderConfig,
    private readonly dependencies: { runPromptProcess?: typeof runPromptProcess } = {},
  ) {}

  async run(req: ModelAdapterRequest): Promise<ReviewResult> {
    assertNoPiToolPolicyArgs(this.config.args ?? [], "Pi reviewer arguments");
    const thinkingLevel = this.config.thinkingLevel ?? "high";
    const artifacts = reviewerArtifactPaths(req.bundleDir);
    const rawStreamPath = join(req.bundleDir, "raw-stream.jsonl");
    // #533: EVERY reviewer pass is a fresh native session. The review pipeline
    // never resumes a prior reviewer conversation, and a bare `--session-id`
    // that Pi cannot find under the current cwd silently starts an EMPTY session
    // with the same id, so reviewer identity is never treated as a continuation
    // handle anywhere in this adapter.
    const sessionId = randomUUID();
    // #533: the pass runs in Pi's own standard native session store — no
    // per-role `--session-dir`, so native `--session-dir`/env/setting/default
    // precedence applies untouched. Only the canonical reference (below) is
    // kept beside the private reviewer staging directory; the transcript itself
    // never enters the evidence bundle this or a sibling reviewer can read.
    const referencePath = join(req.bundleDir, PI_SESSION_REFERENCE_DIRNAME, `${sessionId}.json`);
    req.onSession?.({ adapter: this.kind, id: sessionId });
    const streamExtractor = new PiJsonlReviewExtractor();
    const activity = new PiJsonlActivityExtractor(
      (message) => req.onUpdate?.(message),
      { includeModelUpdates: false },
    );
    const args = [
      "--model",
      this.config.model,
      "--mode",
      "json",
      "--print",
      "--thinking",
      thinkingLevel,
      ...(this.config.args ?? []),
      "--session-id",
      sessionId,
      "--tools",
      "read,grep,find,ls",
      "--no-skills",
      // Explicit single-extension load keeps discovery off while still
      // reporting this pass's authoritative native session identity.
      "--extension",
      SESSION_REPORTER_EXTENSION,
      "--no-extensions",
      "--no-prompt-templates",
      "--no-themes",
      "--system-prompt",
      readOnlyReviewerSystemPrompt(),
    ];

    const childEnv = reviewerEnv({ ...process.env, ...this.config.env }, req.evidenceBundleDir);
    childEnv[PI_SESSION_REFERENCE_ENV] = referencePath;
    const output = await (this.dependencies.runPromptProcess ?? runPromptProcess)({
      command: this.config.command ?? "pi",
      args,
      // #204: only the Pi adapter opts into alias-independent default pi
      // resolution; other adapters sharing runPromptProcess keep their exact
      // configured command semantics.
      resolveDefaultPi: true,
      cwd: req.cwd,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
      env: childEnv,
      signal: req.signal,
      onStdoutChunk: (chunk) => {
        streamExtractor.push(chunk);
        activity.push(chunk);
      },
    });
    activity.finish();
    const sessionReference = await reviewerSessionReference({ path: referencePath, sessionId, cwd: req.cwd });
    const streamExtracted = streamExtractor.finish();
    const extracted = streamExtracted.text.trim() ? streamExtracted : extractReviewTextFromPiJsonl(output.stdout);
    const rawOutputText = extracted.text.trim()
      ? extracted.text
      : extracted.terminalError
        ? providerFailureDiagnostic(extracted.terminalError, output)
        : missingFinalTextDiagnostic(output);
    await Promise.all([
      writeFile(rawStreamPath, output.stdout, "utf8").catch((error: unknown) => {
        throw new Error([error instanceof Error ? error.message : "Reviewer artifact write failed.", output.terminationError]
          .filter(Boolean).join("\n"));
      }),
      writeReviewerProcessArtifacts({
        paths: artifacts,
        output,
        rawOutput: rawOutputText,
        usage: extracted.usage,
        metadata: {
          finalTextCaptured: extracted.text.trim().length > 0,
          terminalProviderError: extracted.terminalError,
          stdoutBytesCaptured: Buffer.byteLength(output.stdout),
          rawOutputContainsStream: false,
          rawStreamPath: "raw-stream.jsonl",
          sessionReference: sessionReference.metadata,
        },
      }),
    ]);

    const failure = processFailureResult({
      reviewerId: req.id,
      output,
      rawOutputPath: artifacts.rawOutput,
      timeoutMs: req.timeoutMs,
      usage: extracted.usage,
    });
    if (failure) return failure;
    if (extracted.terminalError) {
      return {
        ...reviewerErrorResult(
          req.id,
          "Reviewer provider failed before producing a final response.",
          artifacts.rawOutput,
          "provider_error",
          extracted.usage,
        ),
        diagnostic: [extracted.terminalError, output.terminationError].filter(Boolean).join("\n"),
        telemetry: processTelemetry(output),
        processSettlement: output.processSettlement,
      };
    }
    if (!extracted.text.trim()) {
      const summary = output.stdoutTruncated
        ? "Reviewer output was truncated before a final assistant text was captured."
        : "Reviewer did not produce final assistant text.";
      return {
        ...reviewerErrorResult(
        req.id,
        summary,
        artifacts.rawOutput,
        output.stdoutTruncated ? "output_truncated" : "missing_final_text",
        extracted.usage,
        ),
        telemetry: processTelemetry(output),
        processSettlement: output.processSettlement,
        diagnostic: output.terminationError,
      };
    }

    const result = parseReviewResult(req.id, extracted.text, artifacts.rawOutput);
    result.usage = extracted.usage;
    result.telemetry = processTelemetry(output);
    result.processSettlement = output.processSettlement;
    result.diagnostic = output.terminationError;
    return result;
  }
}

/**
 * Read the canonical native session reference this reviewer pass reported and
 * reduce it to MINIMAL pass metadata.
 *
 * The reporter extension is the ONLY source: there is no store re-resolution,
 * `findById`, or directory scan behind this. The pass artifacts record status,
 * the session id, and the locator of the canonical reference — never a second
 * copy of the session file or workspace, which live only in the reference
 * itself. A missing or unverifiable reference is recorded explicitly instead of
 * being silently replaced with a guessed path.
 */
async function reviewerSessionReference(input: {
  path: string;
  sessionId: string;
  cwd: string;
}): Promise<{ metadata: Record<string, unknown> }> {
  const locator = `${PI_SESSION_REFERENCE_DIRNAME}/${input.sessionId}.json`;
  const reference = await readPiSessionReferenceAt(input.path).catch(() => undefined);
  if (!reference) {
    return {
      metadata: {
        status: "unavailable",
        id: input.sessionId,
        reference: locator,
        detail: `The reviewer pass reported no canonical native session reference at ${input.path}; the native session file for this pass is not recorded.`,
      },
    };
  }
  const verified = verifyPiSessionReference(reference, { id: input.sessionId, cwd: input.cwd });
  if (!verified.ok) {
    return {
      metadata: {
        status: "unverified",
        id: input.sessionId,
        reference: locator,
        detail: verified.message,
      },
    };
  }
  return {
    metadata: { status: "recorded", id: reference.id, reference: locator },
  };
}

function missingFinalTextDiagnostic(output: {
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}): string {
  return [
    "No final assistant text was captured from the Pi JSONL stream.",
    `exitCode: ${output.code === null ? "null" : output.code}`,
    `timedOut: ${output.timedOut}`,
    `aborted: ${output.aborted}`,
    `stdoutTruncated: ${output.stdoutTruncated}`,
    `stderrTruncated: ${output.stderrTruncated}`,
  ].join("\n");
}

function providerFailureDiagnostic(error: string, output: {
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
}): string {
  return [
    "The Pi stream ended with a provider error before final assistant text was produced.",
    `providerError: ${error}`,
    `exitCode: ${output.code === null ? "null" : output.code}`,
    `timedOut: ${output.timedOut}`,
    `aborted: ${output.aborted}`,
  ].join("\n");
}

function readOnlyReviewerSystemPrompt(): string {
  return [
    "You are an independent read-only code reviewer.",
    "You have exactly these tools available: read, grep, find, and ls.",
    "Use those tools as needed to inspect the current workspace and the supplied review bundle.",
    "Do not inspect session/runtime streams or reviewer output directories; they are not review evidence.",
    "Do not modify files, run shell commands, use network access, or ask the primary agent for more context.",
    "Return only valid JSON matching the requested schema.",
  ].join(" ");
}
