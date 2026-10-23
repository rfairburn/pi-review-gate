/**
 * Node preload for the session-host status companion (issue #323).
 *
 * The session-host process spawns the Node-based Pi CLI child directly with
 * NODE_OPTIONS prepended as `--require=<this compiled file>` (early, before
 * main) and a one-shot PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE frame
 * carrying the caller's original NODE_OPTIONS (or null). Because our flag is
 * PREPENDED, this module loads before any user --require fixture, restores
 * the original NODE_OPTIONS exactly, and consumes the one-shot bootstrap env
 * — so user fixtures and all descendants see a clean environment: no extra
 * preload, no status secret.
 *
 * No socket or UI setup. A valid top-level bootstrap also installs owned Node
 * stdio adapters for authenticated native clipboard transport (bounded CLI package
 * metadata inspection, no clipboard access). Otherwise this performs only
 * environment restoration, sticky priming, and (for a valid consumed
 * authenticated bootstrap, in a non-executor runtime) opting this process
 * into the pure in-memory owned-activity registry before native main and
 * every extension module evaluates. The opt-in opens no transport, registers
 * no hook, and performs no IO: it only flips the registry's process-local
 * active flag, so a fresh extension source registration landing after it is
 * observed directly instead of being replayed as pre-announcement uncertain.
 * The invalid-restore fallback may read the filesystem once (realpath identity
 * check for its own --require path) and performs no other IO; the opt-in
 * itself performs no IO. Inert when neither env is present. This is
 * standard Node CLI support, not a sandbox: a malicious user custom loader
 * ordered before our flag could still tamper with the environment; that is
 * outside this companion's trust model.
 *
 * Clipboard-bridge posture: an ordinary bootstrap keeps its legacy best-effort
 * install exactly. A bootstrap carrying the closed input-framing marker installs
 * the strict bridge before native main and refuses to start if that install
 * fails, so a host that requested framing never meets a silent legacy child. No
 * environment value is toggled per input and no Pi source, runtime, or version
 * changes.
 */

import { realpathSync } from "node:fs";

import { activateOwnedActivity } from "./owned-activity";
import { installNativeClipboardBridge } from "./native-clipboard";
import { primeReporterBootstrap } from "./reporter";
import { primeSessionHostStartupMetadata } from "./startup-request";

/** One-shot restore frame env set by the host next to NODE_OPTIONS. */
export const NODE_OPTIONS_RESTORE_ENV = "PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE";

/** Launch limit the host enforces on NODE_OPTIONS, in UTF-8 bytes. */
const MAX_NODE_OPTIONS_BYTES = 8_192;
/** Bounded parse cost for the restore frame itself, in UTF-8 bytes. */
const MAX_RESTORE_FRAME_BYTES = 65_536;

interface NodeOptionsRestoreFrame {
  original: string | null;
}

function parseRestoreFrame(raw: string): NodeOptionsRestoreFrame | undefined {
  if (Buffer.byteLength(raw, "utf8") > MAX_RESTORE_FRAME_BYTES) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const original = (parsed as Record<string, unknown>).original;
  // Bounds are measured in actual UTF-8 bytes (not UTF-16 length) so a
  // multibyte original cannot smuggle past the launch NODE_OPTIONS limit.
  if (original !== null && (typeof original !== "string" || Buffer.byteLength(original, "utf8") > MAX_NODE_OPTIONS_BYTES)) {
    return undefined;
  }
  return { original };
}

/** Splits NODE_OPTIONS into tokens at unquoted whitespace boundaries. */
function tokenizeNodeOptions(value: string): Array<{ text: string; start: number; end: number }> {
  const tokens: Array<{ text: string; start: number; end: number }> = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /\s/.test(value.charAt(i))) i += 1;
    if (i >= value.length) break;
    const start = i;
    // Quotes can begin mid-token (e.g. --require="/path with spaces/x.js"),
    // so track them throughout the token, skipping escaped characters.
    let quoted = false;
    while (i < value.length) {
      const char = value.charAt(i);
      if (char === '"') {
        quoted = !quoted;
        i += 1;
      } else if (quoted && char === "\\") {
        i = Math.min(i + 2, value.length); // skip the escaped character
      } else if (!quoted && /\s/.test(char)) {
        break;
      } else {
        i += 1;
      }
    }
    tokens.push({ text: value.slice(start, i), start, end: i });
  }
  return tokens;
}

function unquoteToken(text: string): string {
  let decoded = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (char === '"') {
      quoted = !quoted;
    } else if (quoted && char === "\\" && i + 1 < text.length) {
      decoded += text.charAt(++i); // decode Node's quoted escapes
    } else {
      decoded += char;
    }
  }
  return decoded;
}

/**
 * True when a decoded --require path identifies this module. Node resolves
 * required modules to canonical paths, so a symlinked prefix in NODE_OPTIONS
 * (e.g. /var -> /private/var on macOS) must compare by realpath, not string.
 */
function isSelfRequirePath(path: string): boolean {
  if (path === __filename) return true;
  try {
    return realpathSync(path) === __filename;
  } catch {
    return false; // Path no longer exists: only an exact match counts.
  }
}

/**
 * Removes this preload's own prepended `--require` option using quote-aware
 * token boundaries (both `--require=path` and `--require path` forms, quoted
 * or not), preserving the remaining original options verbatim. Returns
 * undefined when no self flag is identifiable; the caller leaves the value
 * untouched rather than corrupting trusted options.
 */
function stripSelfRequireOption(current: string): string | undefined {
  const tokens = tokenizeNodeOptions(current);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const bare = unquoteToken(token.text);
    let argEnd: number | undefined;
    if (bare === "--require") {
      const next = tokens[i + 1];
      if (next && isSelfRequirePath(unquoteToken(next.text))) argEnd = next.end;
    } else if (bare.startsWith("--require=")) {
      // bare is already decoded; compare the path directly.
      if (isSelfRequirePath(bare.slice("--require=".length))) argEnd = token.end;
    }
    if (argEnd === undefined) continue;
    // Host inserts one separator before the original options. Preserve any
    // whitespace belonging to the original string rather than normalizing it.
    const tail = argEnd + (current.charAt(argEnd) === " " ? 1 : 0);
    return current.slice(0, token.start) + current.slice(tail);
  }
  return undefined;
}

/**
 * Restore the caller's original NODE_OPTIONS from the one-shot frame. The
 * frame is always consumed (deleted) so descendants never inherit it. On an
 * invalid frame, fail closed by stripping only this preload's own
 * `--require` option; contents are never logged or dumped.
 */
export function restoreNodeOptions(): void {
  const raw = process.env[NODE_OPTIONS_RESTORE_ENV];
  delete process.env[NODE_OPTIONS_RESTORE_ENV];
  if (raw === undefined) return; // Inert: host did not provide a frame.
  const frame = parseRestoreFrame(raw);
  if (frame) {
    if (frame.original === null) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = frame.original;
    return;
  }
  const current = process.env.NODE_OPTIONS;
  if (typeof current !== "string") return;
  const stripped = stripSelfRequireOption(current);
  if (stripped === undefined) return; // Unidentifiable: leave untouched.
  if (stripped.length === 0) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = stripped;
}

// Pre-main: restore the environment, then prime the sticky bootstrap state
// the extension factory reads at load time. Both are inert without their env.
restoreNodeOptions();
const primed = primeReporterBootstrap();
primeSessionHostStartupMetadata(
  primed !== undefined && process.env.PI_REVIEW_GATE_RUNTIME_ROLE !== "executor",
  primed?.payloadDir,
);
/**
 * A child the host registered in the closed input-framing mode must never
 * continue as an ordinary legacy child when its strict bridge cannot install:
 * the host would then refuse every framed write while this process behaved like
 * a legacy Pi. One fixed, payload-free line on stderr (never the token, the
 * bootstrap, a path, or a caught error) and a nonzero exit use the preload's
 * existing pre-main failure posture — the environment is already restored and
 * the one-shot bootstrap consumed here, so nothing leaks to descendants and the
 * owned row reports a truthful launch failure.
 */
function refuseRequestedInputFraming(): never {
  try {
    process.stderr.write("pi-review-gate: the requested native input framing bridge is unavailable; refusing to start\n");
  } catch {
    // A closed stderr cannot hide the exit below.
  }
  process.exit(1);
}
// A valid consumed bootstrap — and the reporter's exact executor role ceiling,
// not an alias or a stripped marker — opts this process into pure owned-activity
// observation BEFORE native main and every extension module evaluates. That
// closes the pre-announcement blind window: later fresh source registrations
// land directly. Absent/invalid/foreign bootstraps never prime, and an executor
// runtime never activates, so standalone and worker runs stay inert. The
// registry is itself exception-safe and performs no IO; this guard only keeps
// any unexpected opt-in failure from affecting native startup.
//
// The clipboard bridge keeps its exact legacy best-effort behavior unless this
// authenticated bootstrap explicitly requests the closed input-framing mode.
// A requested mode is strict: the bridge installs before native main, and an
// install failure refuses to start rather than continuing as a legacy child.
if (primed !== undefined && process.env.PI_REVIEW_GATE_RUNTIME_ROLE !== "executor") {
  if (primed.inputOriginFraming === 1) {
    // Requested strict mode: install the framing bridge before native main can
    // write its startup queries, and never fall back to legacy on failure. The
    // child emits its own signed readiness capsule only after the decoder is
    // fully installed, so the host still owes its own live-record checks.
    let installed = false;
    try {
      installed = installNativeClipboardBridge(primed, { inputOriginFraming: true });
    } catch {
      installed = false;
    }
    if (!installed) refuseRequestedInputFraming();
  } else {
    try {
      installNativeClipboardBridge(primed);
    } catch {
      // Unsupported provenance never opens raw OSC forwarding or changes native copying.
    }
  }
  try {
    activateOwnedActivity();
  } catch {
    // Observation opt-in is best-effort: never break the real Pi process.
  }
}
