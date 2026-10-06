// #301 test helpers: raw (non-Git) parent-review checkpoints live in the live
// Pi session's external namespace under the Pi agent-data directory. Tests
// always point that directory at a disposable fixture, never the real home.
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewCheckpointScope } from "../src/review-checkpoint";

/** Run with a disposable Pi agent-data directory (PI_CODING_AGENT_DIR) and
 * restore the previous environment afterwards. */
export async function withTestAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await mkdtemp(join(tmpdir(), "prg-agent-dir-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try { return await run(agentDir); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
}

/** A trusted test scope for direct review-checkpoint API calls. */
export function testCheckpointScope(agentDir: string, sessionId = "test-session"): ReviewCheckpointScope {
  return { agentDir, sessionId };
}

const disposableAgentDirs: string[] = [];
process.on("exit", () => {
  for (const dir of disposableAgentDirs) rmSync(dir, { recursive: true, force: true });
});
/** A disposable Pi agent-data directory removed when the test process exits. */
export function disposableAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prg-test-agent-"));
  disposableAgentDirs.push(dir);
  return dir;
}
/** activate() dependencies for fake hosts that never emit a session_start with
 * a live session manager: the raw-checkpoint scope that session would have. */
export function testCheckpointActivation(sessionId = "test-session") {
  return { initialCheckpointScope: testCheckpointScope(disposableAgentDir(), sessionId) };
}
