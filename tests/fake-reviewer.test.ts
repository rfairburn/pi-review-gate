import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("fake reviewer returns pass by default", async () => {
  const stdout = await runFakeReviewer("Changed files:\n{\"path\":\"src/example.ts\"}");
  const parsed = JSON.parse(stdout) as { verdict: string; findings: unknown[] };

  assert.equal(parsed.verdict, "pass");
  assert.deepEqual(parsed.findings, []);
});

test("fake reviewer returns needs_changes in retry mode", async () => {
  const stdout = await runFakeReviewer("Changed files:\n{\"path\":\"src/example.ts\"}", {
    env: {
      ...process.env,
      PI_REVIEW_GATE_FAKE_VERDICT: "retry",
      PI_REVIEW_GATE_FAKE_ISSUE: "Controlled retry issue.",
    },
  });
  const parsed = JSON.parse(stdout) as {
    verdict: string;
    findings: Array<{ file: string; issue: string }>;
  };

  assert.equal(parsed.verdict, "needs_changes");
  assert.equal(parsed.findings[0]?.file, "src/example.ts");
  assert.equal(parsed.findings[0]?.issue, "Controlled retry issue.");
});

async function runFakeReviewer(prompt: string, options: { env?: NodeJS.ProcessEnv } = {}): Promise<string> {
  return await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["scripts/fake-reviewer.cjs"], {
      cwd: process.cwd(),
      env: options.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`fake reviewer exited ${code}: ${stderr}`));
      }
    });
    proc.stdin.end(prompt);
  });
}
