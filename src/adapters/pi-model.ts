import { randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PiDeciderConfig } from "../config";
import { parseReviewResult, type ReviewResult } from "../schema";
import { extractReviewTextFromPiJsonl, PiJsonlReviewExtractor } from "../usage";
import { PiJsonlActivityExtractor } from "../execution/progress";
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
import { readBoundedTextFile } from "../bounded-file";
import { isRecord } from "../record-guard";
import { isValidNativeSessionFile } from "../session-host/protocol";
import { REVIEWER_SESSION_RECEIPT_ENV } from "./session-ref-reporter";

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
    const sessionId = randomUUID();
    // Capture this fresh reviewer's native file outside immutable evidence.
    const receiptPath = join(req.bundleDir, "session-ref.json");
    await mkdir(req.bundleDir, { recursive: true });
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
      "--session-id", sessionId,
      "--tools",
      "read,grep,find,ls",
      "--no-skills",
      "--no-extensions",
      "--extension",
      resolve(__dirname, "session-ref-reporter.js"),
      "--no-prompt-templates",
      "--no-themes",
      "--system-prompt",
      readOnlyReviewerSystemPrompt(),
    ];

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
      env: reviewerEnv(
        { ...process.env, ...this.config.env, [REVIEWER_SESSION_RECEIPT_ENV]: receiptPath },
        req.evidenceBundleDir,
      ),
      signal: req.signal,
      onStdoutChunk: (chunk) => {
        streamExtractor.push(chunk);
        activity.push(chunk);
      },
    });
    activity.finish();
    // Read the one bounded receipt now that the child settled, then remove it:
    // the published artifacts keep a single session reference (invocation.json).
    const sessionFile = await readReviewerSessionFile(receiptPath, sessionId);
    if (sessionFile !== undefined) req.onSession?.({ adapter: this.kind, id: sessionId, file: sessionFile });
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
          sessionRefCaptured: sessionFile !== undefined,
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
    // A successful review must leave its native reference in the pass metadata.
    if (sessionFile === undefined) {
      return {
        ...reviewerErrorResult(
          req.id,
          "Reviewer did not report its own native session reference, so the pass was not accepted.",
          artifacts.rawOutput,
          "session_reference_missing",
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

async function readReviewerSessionFile(path: string, sessionId: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse((await readBoundedTextFile(path, 64 * 1024)).text);
    return isRecord(parsed) && parsed.sessionId === sessionId && isValidNativeSessionFile(parsed.sessionFile)
      ? parsed.sessionFile : undefined;
  } catch {
    return undefined;
  } finally {
    await unlink(path).catch(() => undefined);
  }
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
