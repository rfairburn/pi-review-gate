"use strict";
/*
 * Synthetic run-as-binary executor used by the #412 combined activity
 * regression. It speaks the real pi-review-executor-jsonl-v1 stream, reports
 * one assistant turn, records an explicit owned readiness acknowledgement, and
 * then stays genuinely running until the production interrupt path terminates
 * it. On exit it records a settlement acknowledgement keyed by its own pid, so
 * the regression can prove the exact process exited rather than trusting a
 * tool acknowledgement. No provider credential or model request is involved.
 */
const fs = require("node:fs");
const path = require("node:path");

const readyDir = process.env.PRG_412_WORKER_READY_DIR;
const exitDir = process.env.PRG_412_WORKER_EXIT_DIR;
const writeAck = (dir, suffix, payload) => {
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${process.pid}.${suffix}`), JSON.stringify(payload));
  } catch {
    // Acknowledgement failure is reported by the regression as missing evidence.
  }
};

process.stdin.resume();
process.stdout.write(`${JSON.stringify({
  type: "session",
  sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID ?? "synthetic-executor-session",
})}\n`);
process.stdout.write(`${JSON.stringify({
  type: "assistant",
  text: "synthetic running executor holding admitted work",
})}\n`);
writeAck(readyDir, "ready", {
  pid: process.pid,
  operation: process.env.PI_REVIEW_EXECUTOR_OPERATION ?? null,
  sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID ?? null,
});

let settled = false;
const settle = (signal) => {
  if (settled) return;
  settled = true;
  writeAck(exitDir, "exit", { pid: process.pid, signal });
  process.exit(0);
};
process.on("SIGTERM", () => settle("SIGTERM"));
process.on("SIGINT", () => settle("SIGINT"));
process.on("SIGHUP", () => settle("SIGHUP"));
// Safety bound only: the regression interrupts this child long before it.
setTimeout(() => settle("timeout"), 120_000).unref();
setInterval(() => undefined, 1_000);
