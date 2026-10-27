/**
 * Gate-owned native session reference reporter (#533).
 *
 * A Pi `--mode json --print` reviewer has no RPC channel, so its own
 * `get_state` is unavailable and its JSON stdout carries no session path.
 * Rather than re-resolving Pi's session store from the parent (which would
 * have to duplicate Pi's flag/env/user/project precedence and would silently
 * search the wrong directory), the reviewer pass loads this tiny extension
 * explicitly with `--extension` while keeping `--no-extensions` discovery off.
 * The extension asks the live session manager for the authoritative identity —
 * `getSessionFile()`, `getSessionId()`, `getCwd()` — and records the canonical
 * association through the shared helper in `src/pi-session-reference.ts`.
 *
 * Contract:
 * - Loaded ONLY when the parent supplies `PI_REVIEW_GATE_PI_SESSION_REFERENCE`,
 *   the exact run-private `<staging>/pi-sessions/<id>.json` path it owns. With
 *   the variable unset the extension is inert.
 * - It writes exactly that one small reference file. It never copies, reads,
 *   or publishes the transcript, never registers tools, commands, or flags, and
 *   never touches the shared session store.
 * - A relative `getSessionFile()` (Pi reports one whenever the effective
 *   `sessionDir` is relative) is canonicalized against the reported session cwd
 *   by the shared helper, never against the parent's cwd.
 * - Failure is reported on stderr and simply leaves the reference unwritten;
 *   the parent records the pass as having NO canonical reference instead of
 *   silently downgrading to a guessed path.
 */
import { writePiSessionReferenceAt, canonicalPiSessionReference } from "./pi-session-reference";

/** Parent-owned exact target path for this run's canonical reference. */
export const PI_SESSION_REFERENCE_ENV = "PI_REVIEW_GATE_PI_SESSION_REFERENCE";

function callString(target: unknown, method: string): string | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  const candidate = (target as Record<string, unknown>)[method];
  if (typeof candidate !== "function") return undefined;
  try {
    const value = (candidate as () => unknown).call(target);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function report(ctx: unknown, target: string): Promise<void> {
  const manager = (ctx as { sessionManager?: unknown } | undefined)?.sessionManager;
  const sessionId = callString(manager, "getSessionId");
  const sessionFile = callString(manager, "getSessionFile");
  const cwd = callString(manager, "getCwd");
  if (!sessionId || !sessionFile || !cwd) {
    process.stderr.write("pi-review-gate session reporter: the live session manager reported no persistent session identity; no canonical session reference was recorded.\n");
    return;
  }
  const canonical = canonicalPiSessionReference({ id: sessionId, file: sessionFile, cwd, relativeTo: cwd });
  if (!canonical.ok) {
    process.stderr.write(`pi-review-gate session reporter: ${canonical.message}\n`);
    return;
  }
  const written = await writePiSessionReferenceAt(target, canonical.value);
  if (!written.ok) {
    process.stderr.write(`pi-review-gate session reporter: ${written.message}\n`);
  }
}

/** Pi extension entry (duck-typed like every other entry point in this package). */
export default function piSessionReferenceReporter(pi: unknown): void {
  const target = process.env[PI_SESSION_REFERENCE_ENV];
  if (typeof target !== "string" || target.length === 0) return;
  const api = pi as { on?: (event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) => unknown } | undefined;
  if (!api || typeof api.on !== "function") {
    process.stderr.write("pi-review-gate session reporter: the extension API is unavailable; no canonical session reference was recorded.\n");
    return;
  }
  api.on("session_start", (_event, ctx) => {
    return report(ctx, target);
  });
}
