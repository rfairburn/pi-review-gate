import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { CodexCliDeciderConfig } from "../config";
import { parseReviewResult, REVIEW_OUTPUT_JSON_SCHEMA, type ReviewResult } from "../schema";
import { extractCodexSessionId, extractReviewTextFromCodexJsonl, parseCodexUsageFromJsonl } from "../usage";
import { reviewerEnv, runPromptProcess } from "./process";
import type { ModelAdapter, ModelAdapterRequest } from "./types";

export class CodexCliAdapter implements ModelAdapter {
  readonly kind = "codex-cli";

  constructor(private readonly config: CodexCliDeciderConfig) {}

  async run(req: ModelAdapterRequest): Promise<ReviewResult> {
    const rawOutputPath = join(req.bundleDir, "raw-output.txt");
    const stderrPath = join(req.bundleDir, "stderr.txt");
    const finalPath = join(req.bundleDir, "reviewer-final.txt");
    const usagePath = join(req.bundleDir, "usage.json");
    const outputSchemaPath = join(req.bundleDir, "review-output-schema.json");
    await writeFile(outputSchemaPath, JSON.stringify(REVIEW_OUTPUT_JSON_SCHEMA, null, 2), "utf8");
    const command = this.config.command ?? "codex";
    if (shouldPreflightSandbox(command, this.config.args)) {
      const preflight = await runPromptProcess({
        command,
        args: codexSandboxPreflightArgs(),
        cwd: req.cwd,
        prompt: "",
        timeoutMs: Math.min(req.timeoutMs, 10_000),
        env: reviewerEnv(process.env, req.evidenceBundleDir),
        signal: req.signal,
      });
      if (codexSandboxFailed(preflight.stderr)) {
        await Promise.all([
          writeFile(rawOutputPath, "", "utf8"),
          writeFile(stderrPath, preflight.stderr, "utf8"),
          writeFile(usagePath, "null\n", "utf8"),
        ]);
        return errorResult(
          req.id,
          "Codex reviewer could not inspect the evidence because its read-only filesystem sandbox failed to start.",
          rawOutputPath,
          "sandbox_unavailable",
          undefined,
        );
      }
    }
    const args = req.session
      ? [
        "exec",
        "resume",
        "--json",
        "--output-last-message",
        finalPath,
        ...(this.config.model ? ["--model", this.config.model] : []),
        ...(this.config.args ?? []),
        "--skip-git-repo-check",
        req.session.id,
        "-",
      ]
      : [
        "exec",
        "--json",
        "--output-last-message",
        finalPath,
        ...(this.config.model ? ["--model", this.config.model] : []),
        ...(this.config.args ?? []),
        "--sandbox",
        "read-only",
        "--output-schema",
        outputSchemaPath,
        "--skip-git-repo-check",
        "-",
      ];

    const output = await runPromptProcess({
      command,
      args,
      cwd: req.cwd,
      prompt: req.prompt,
      timeoutMs: req.timeoutMs,
      env: reviewerEnv(process.env, req.evidenceBundleDir),
      signal: req.signal,
    });
    await Promise.all([
      writeFile(rawOutputPath, output.stdout, "utf8"),
      writeFile(stderrPath, output.stderr, "utf8"),
    ]);

    const usage = parseCodexUsageFromJsonl(output.stdout);
    const sessionId = extractCodexSessionId(output.stdout) ?? req.session?.id;
    if (sessionId) {
      req.onSession?.({ adapter: this.kind, id: sessionId });
    }
    await writeFile(usagePath, JSON.stringify(usage ?? null, null, 2), "utf8").catch(() => undefined);

    if (output.aborted) {
      return errorResult(req.id, "Reviewer was aborted.", rawOutputPath, "aborted", usage);
    }
    if (output.timedOut) {
      return errorResult(req.id, `Reviewer timed out after ${req.timeoutMs}ms.`, rawOutputPath, "timeout", usage);
    }
    if (output.code !== 0) {
      return errorResult(req.id, `Reviewer exited with status ${output.code}.`, rawOutputPath, `exit_${output.code}`, usage);
    }

    const finalTextFromFile = await readFile(finalPath, "utf8").catch(() => "");
    const finalText = finalTextFromFile.trim() ? finalTextFromFile : extractReviewTextFromCodexJsonl(output.stdout) || output.stdout;
    const result = parseReviewResult(req.id, finalText, rawOutputPath);
    result.usage = usage;
    if (result.verdict === "error" && codexSandboxFailed(output.stderr)) {
      return errorResult(
        req.id,
        "Codex reviewer could not inspect the evidence because its read-only filesystem sandbox failed to start.",
        rawOutputPath,
        "sandbox_unavailable",
        usage,
      );
    }
    return result;
  }
}

export function codexSandboxPreflightArgs(): string[] {
  return ["sandbox", "--permissions-profile", ":read-only", process.execPath, "-e", ""];
}

function codexSandboxFailed(stderr: string): boolean {
  return /fs sandbox helper failed|\bbwrap:|sandbox[^\n]*failed/i.test(stderr);
}

function shouldPreflightSandbox(command: string, args: string[] | undefined): boolean {
  return basename(command) === "codex"
    && !args?.includes("--dangerously-bypass-approvals-and-sandbox");
}

function errorResult(reviewerId: string, summary: string, rawOutputPath: string, error: string, usage: ReviewResult["usage"]): ReviewResult {
  return { reviewerId, verdict: "error", summary, findings: [], rawOutputPath, error, usage };
}
