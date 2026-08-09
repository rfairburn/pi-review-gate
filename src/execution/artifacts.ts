import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessRunResult } from "../adapters/process";
import type { TokenUsage } from "../usage";

export async function writeExecutorArtifacts(input: {
  artifactDir: string;
  turn: number;
  output: ProcessRunResult;
  text: string;
  usage?: TokenUsage;
  sessionId?: string;
  adapter: string;
}): Promise<{ stdoutPath: string; stderrPath: string }> {
  const dir = join(input.artifactDir, "executor", String(input.turn).padStart(4, "0"));
  await mkdir(dir, { recursive: true });
  const stdoutPath = join(dir, "raw-stream.txt");
  const stderrPath = join(dir, "stderr.txt");
  await Promise.all([
    writeFile(stdoutPath, input.output.stdout, "utf8"),
    writeFile(stderrPath, input.output.stderr, "utf8"),
    writeFile(join(dir, "final-response.md"), input.text, "utf8"),
    writeFile(join(dir, "usage.json"), JSON.stringify(input.usage ?? null, null, 2), "utf8"),
    writeFile(join(dir, "process-result.json"), JSON.stringify({
      adapter: input.adapter,
      sessionId: input.sessionId,
      code: input.output.code,
      timedOut: input.output.timedOut,
      aborted: input.output.aborted,
      stdoutTruncated: input.output.stdoutTruncated,
      stderrTruncated: input.output.stderrTruncated,
    }, null, 2), "utf8"),
  ]);
  return { stdoutPath, stderrPath };
}
