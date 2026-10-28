/** Report this fresh reviewer's native identity into its private staging metadata. */
import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isValidNativeSessionFile, isValidNativeSessionId } from "../session-host/protocol";

export const REVIEWER_SESSION_RECEIPT_ENV = "PI_REVIEW_GATE_REVIEWER_SESSION_RECEIPT";

interface SessionContext {
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getCwd(): string;
  };
}

export default function activate(pi: {
  on(event: "session_start", handler: (event: unknown, ctx: SessionContext) => void): void;
}): void {
  const receiptPath = process.env[REVIEWER_SESSION_RECEIPT_ENV];
  delete process.env[REVIEWER_SESSION_RECEIPT_ENV];
  if (!receiptPath || !isAbsolute(receiptPath)) return;
  let written = false;
  pi.on("session_start", (_event, ctx) => {
    if (written) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return;
    const sessionFile = resolve(ctx.sessionManager.getCwd(), file);
    if (!isValidNativeSessionId(sessionId) || !isValidNativeSessionFile(sessionFile)) return;
    writeFileSync(receiptPath, JSON.stringify({ sessionId, sessionFile }), { flag: "wx", mode: 0o600 });
    written = true;
  });
}
