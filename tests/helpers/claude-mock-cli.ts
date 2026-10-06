import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Issue #310 regression fixture: an owned local stand-in for the Claude Code
// CLI that speaks the installed Agent SDK's stream-json control protocol. It
// makes no network or provider calls. On an interrupt it behaves like a CLI
// without the interrupt_receipt_v1 capability: it acknowledges, emits an
// untagged interrupted result, and then its drain loop starts the steering
// that survived the interrupt. Like the real CLI it keeps running after
// stdin EOF, so only owned process termination can stop that drain.
//
// Events are appended to CLAUDE_MOCK_MARKER; CLAUDE_MOCK_DRAIN_MS sets how
// long after the interrupted result the surviving steering starts.
const script = `
"use strict";
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const marker = process.env.CLAUDE_MOCK_MARKER;
const drainMs = Number(process.env.CLAUDE_MOCK_DRAIN_MS || "150");
const session = "mock-claude-session";
const usage = { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const users = [];
const log = (event) => { if (marker) fs.appendFileSync(marker, event + "\\n"); };
const out = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const respond = (request, response) => out({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response } });
const toolUse = (id, command) => out({
  type: "assistant",
  session_id: session,
  uuid: randomUUID(),
  parent_tool_use_id: null,
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command } }] },
});
log("start:" + process.pid);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => log("stdin-eof"));
setInterval(() => {}, 1000);
function handle(message) {
  if (message.type === "control_request") {
    const subtype = message.request && message.request.subtype;
    log("control:" + subtype);
    if (subtype === "initialize") {
      respond(message, { commands: [], agents: [], output_style: "default", available_output_styles: ["default"], models: [], account: {} });
      return;
    }
    if (subtype === "interrupt") {
      respond(message, {});
      out({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["[ede_diagnostic] result_type=user stop_reason=tool_use"],
        terminal_reason: "aborted_streaming",
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage,
        modelUsage: {},
        permission_denials: [],
        uuid: randomUUID(),
        session_id: session,
      });
      setTimeout(() => {
        if (users.length < 2) return;
        log("post-interrupt-request");
        toolUse("bash-survivor", "touch after-interrupt");
        log("post-interrupt-tool");
      }, drainMs);
      return;
    }
    respond(message, {});
    return;
  }
  if (message.type === "user") {
    users.push(message);
    log("user:" + users.length);
    if (users.length === 1) {
      out({ type: "system", subtype: "init", session_id: session, uuid: randomUUID(), tools: [], model: "mock" });
      toolUse("bash-running", "sleep 600");
    }
  }
}
`;

/** Write the mock CLI as an executable owned by the caller's scratch dir. */
export async function writeMockClaudeCli(dir: string): Promise<string> {
  const path = join(dir, "mock-claude-cli.cjs");
  await writeFile(path, `#!/usr/bin/env node\n${script}`, "utf8");
  await chmod(path, 0o755);
  return path;
}

export async function readMockEvents(markerPath: string): Promise<string[]> {
  try {
    return (await readFile(markerPath, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function mockRootPid(events: readonly string[]): number | undefined {
  const start = events.find((event) => event.startsWith("start:"));
  return start ? Number(start.slice("start:".length)) : undefined;
}

/**
 * Inject the production condition that leaves owned shutdown unverified: the
 * operating system refuses (EPERM) signals and liveness probes addressed to a
 * blocked process group. Direct-child signals are untouched, so the mock root
 * still terminates; only group-wide verification becomes impossible. Returns
 * a restore function; callers must restore in finally.
 */
export function denyProcessGroupSignals(blockedGroups: ReadonlySet<number>): () => void {
  const original = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    if (pid < 0 && blockedGroups.has(-pid)) {
      throw Object.assign(new Error(`kill EPERM (injected for process group ${-pid})`), { code: "EPERM", errno: -1, syscall: "kill" });
    }
    return original.call(process, pid, signal);
  }) as typeof process.kill;
  return () => { process.kill = original; };
}
