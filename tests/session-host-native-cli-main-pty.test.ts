/**
 * One integrated top-level acceptance scenario for native provider hosting in
 * the REAL public Main (issue #277 host acceptance slice).
 *
 * Everything below runs through the real public `runSessionHost(options)` entry
 * of a privately staged candidate package on a real outer `@lydell/node-pty`,
 * driven with real keystrokes, exactly like the existing native Main proofs:
 *
 * 1. one ordinary Pi row created through the Workspace-only New form, running
 *    the pinned real Pi 1.6.1 offline with `--no-tools --no-context-files
 *    --no-themes` (no model call, no prompt, no context file read);
 * 2. two native provider rows created through the SAME New form's actual
 *    Provider control (Shift+Tab to Host, Shift+Tab to Provider, arrow-cycled,
 *    Tab back to Workspace, submitted), which carries the operator's explicit
 *    choice through the production sidebar action, host create options, manager,
 *    and `createNativeCliLauncher` into a real PTY child. Both rows are the
 *    built-in DEFAULT targets — the only native choices a New session offers
 *    (#493) — and the claude-backed row is that default's interactive child alone. The codex-backed row is the
 *    production owned pair: one private `app-server` backend child on plain
 *    stdio pipes (NOT a terminal), and only after that backend reports its own
 *    loopback endpoint, the interactive TUI child in this row's real PTY; and
 * 3. the whole lifecycle: addressed input and one synthetic prompt answer,
 *    switching rows with the retained frame, one deliberate outer resize with
 *    the fixture's own SIGWINCH geometry, the truthful Claude owned-startup
 *    baseline and the owned Codex all-unknown status, one natural fixture exit,
 *    one public stop confirmation that settles BOTH owned Codex processes, the
 *    real Pi row's graceful exit, and the host's normal Quit with full outer
 *    restoration.
 *
 * EVIDENCE SCOPE — read before drawing any conclusion:
 * - Every provider process here is a SYNTHETIC Node program this file wrote.
 *    They are NOT Claude Code and NOT the Codex CLI. Nothing here proves a real
 *    provider TUI's rendering, prompts, key handling, trust dialogs, or
 *    telemetry, and nothing reads or writes any provider's real configuration,
 *    credentials, keychain, clipboard, or conversations. Each default target
 *    resolves its bare `claude` / `codex` command through the host's own PATH,
 *    whose FIRST entry is a fixture-owned directory holding exactly two shims
 *    that exec this test's Node interpreter on the recording script, so the
 *    default launch reaches the synthetic program and never a real provider
 *    binary later on PATH. The authored configuration also carries two
 *    external worker profiles pointing at the same fixture with their own
 *    `PATH`/target-id overlay; they are never offered as New choices, and every
 *    child's own environment proves no such overlay reached it.
 * - The owned Codex backend stand-in is deliberately minimal and hermetic: it
 *    validates the lease's capability-token digest against the bearer its
 *    client presents, prints the ONE readiness banner grammar the production
 *    lease parses, answers only the read-only `initialize` + one empty
 *    `thread/loaded/list` pre-attach census, and supports a real socket close.
 *    It invents no model, status value, approval/control request, thread, turn,
 *    or root selection, and it logs no bearer or digest. The interactive TUI
 *    stand-in never connects to the relay, so it never emits a genuine Codex
 *    `initialize` or starts a turn; that is why the owned Codex row can only
 *    stay unknown.
 * - Native-CLI witnesses come from the fixture itself. The harness's
 *    `records()` / `ownedSessions()` / `paneGeometry()` / `setOuterSize()` /
 *    `closeNativeNormally()` all key off the Pi observer extension a provider
 *    child never loads, so they are used here ONLY for the real Pi row. For the
 *    provider rows, PID, role, argv, TTY state, workspace, environment,
 *    received input, SIGWINCH geometry, and continuation are read from each
 *    fixture's own journal, and the original-process settlement is the harness
 *    `OwnedPidExitWatcher` on every fixture-REPORTED PID — both the codex TUI
 *    and its backend — plus the Main runner's real `@lydell/node-pty` `onExit`
 *    journal for the manager-owned TUI PTY.
 * - OBSERVATION ARMING IS REAL, HOOK DELIVERY IS NOT. The host arms every
 *    provider row it can. The claude-backed launch appends its documented
 *    hook-only `--settings` layer, the child receives the fresh per-launch
 *    native-hook opt-in marker (a different marker family from the Pi
 *    session-host bootstrap, which stays absent), and the host publishes the
 *    observer's static applicability declaration. A SYNTHETIC fixture never
 *    runs a hook, so no hook event ever arrives; what the claude-backed row
 *    shows is ONLY what that run's own owner is entitled to state from the
 *    spawn it holds — idle, nothing pending, 0 tasks, 0 shells, `Ready` — and
 *    never a provider-reported lifecycle fact. The OWNED codex-backed launch is
 *    different by construction: the launcher declines this host's own hook
 *    preparation entirely, so neither child receives a generated flag or the
 *    opt-in marker, and the operator's configured args and environment reach
 *    both children unchanged. Its observer starts as the legacy route and
 *    switches to the owned read-only RPC lane with all five categories
 *    supported, but until a genuine TUI source binds a fresh root it publishes
 *    no `Ready`, no zero, and no guessed thread — so every Codex cell is
 *    unknown. Nothing here proves a hook fired, and nothing here proves a real
 *    provider accepts any flag or reports its own foreground, question, or
 *    background state.
 * - macOS only (the shared harness's explicit scope). Windows ConPTY, a
 *    physical terminal, and any real provider remain unverified.
 * - The sidebar roster is read by the ONE shared strict roster witness in
 *    `helpers/session-host-native-roster-witness.ts`, whose closed value grammar
 *    includes the not-applicable word, the unknown value word, and observed
 *    counts alike. This file keeps no roster grammar of its own: what remains is
 *    only how a parsed entry is NAMED inside its own step and failure messages,
 *    so every completeness rule, card extent, action tail, and partial-frame
 *    rejection is the same one every other harness uses.
 *
 * FORM SUBMISSION is never assumed, and nothing here re-choreographs it.
 * `submitWorkspace` presses exactly the keys `MainPtyDriver.createNativeSession`
 * presses for the same field, in the same order, under the same per-key witness:
 * Enter either submits New outright or accepts the exact owned-folder completion
 * (the field's own documented semantics: Enter confirms the highlighted
 * completion while that list is open and only submits when it is not), and the
 * one further Enter is sent only when a POSITIVE witness captured on the frame
 * that matched it says the form is still completely drawn and its field now
 * holds the exact completed owned folder. The other two witnesses — the host's
 * own pending-create row, and this fixture's own freshly reported start, fenced
 * against every identity already in its journal — mean the real host already
 * took the submission, so no Enter is ever sent into a child that has taken
 * input ownership. For the owned Codex row the fresh-start witness additionally
 * admits ONLY a journal record positively labeled as the interactive TUI, with
 * its own real terminal and the expected lease-issued remote flags; a backend
 * `app-server` start is structurally unable to satisfy it even though it is a
 * new PID with a fresh journal record. A frame that merely lost the Workspace
 * row to a partial repaint is not a witness at all, so the driver keeps waiting
 * instead of concluding a submission that never happened. No extra Enter, no
 * Escape, no retry, no sleep is added anywhere, so a New form that never takes
 * the submission stays a failure here instead of being worked around. The
 * shared positive witnesses live in
 * `tests/helpers/session-host-native-new-form-witness.ts`, and for a provider
 * row the fresh-start witness is the fixture's OWN journal, never the Pi
 * observer a provider child does not load.
 * `untilNativeLaunch` watches the drawn frame while it waits for the fixture, so
 * a create the real host refused is named by its own public notice rather than
 * surfacing later as a child that never appeared.
 *
 * READING A FAILURE: a stop inside the real Pi row's `createNativeSession` is
 * the shared harness's own Workspace-submit and Pi-start path — the same one the
 * existing native Main cases use, deliberately left unchanged here. A stop
 * inside `createNativeFixtureSession` is this file's provider-UI path, and its
 * message states the drawn field value, whether the New form is still displayed,
 * whether the host posted its create-refusal notice, and the fixture journal.
 *
 * Runtime guard: `resolveRuntimePin(t)` is used unchanged and is never
 * deleted or bypassed. It still refuses (throws, never skips) inside a delegated
 * runtime role. The focused command runs this TEST SUBPROCESS with only the
 * test-only `PI_REVIEW_GATE_RUNTIME_ROLE` / `PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG`
 * variables unset, which is the official environment isolation for a spawned
 * test child and changes no real role or permission. The scenario is evidenced
 * only by that focused run's own actual result; this comment is not a pass
 * claim.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, sep } from "node:path";
import test from "node:test";

import { normalizeConfig } from "../src/config";
import { SESSION_HOST_BOOTSTRAP_ENV } from "../src/session-host/launch";
import { listNativeCliNewSessionTargets, listNativeCliTargets } from "../src/session-host/native-cli-launch";
import { NATIVE_CODEX_BACKEND_AUTH_ENV_PREFIX } from "../src/session-host/native-codex-backend";
import {
  CLAUDE_NATIVE_HOOK_EVENTS,
  NATIVE_HOOK_TIMEOUT_SECONDS,
} from "../src/session-host/native-hook-launch-prep";
import { NATIVE_HOOK_BOOTSTRAP_ENV } from "../src/session-host/native-hook-protocol";
import { NATIVE_STATUS_NOT_APPLICABLE_TEXT } from "../src/session-host/native-status";

import {
  EVENT_TIMEOUT_MS,
  KEYS,
  MainPtyDriver,
  OBSERVER_FIXTURE,
  OUTER_COLS,
  OUTER_ROWS,
  OwnedPidExitWatcher,
  TEST_TIMEOUT_MS,
  type CandidatePackage,
  type CleanupOutcome,
  type OwnedSession,
  compileAndStageCandidate,
  createEditorExecutable,
  createEditorLog,
  createOwnedScratchRoot,
  makeNativeAgentRoot,
  makeRuntimeEnvironment,
  makeWorkspace,
  processIsAlive,
  removeOwnedScratchTree,
  resolveRuntimePin,
} from "./helpers/session-host-native-main-harness";
import {
  captureStartIdentities,
  completeNewFormDrawn,
  newFormPendingCreateDrawn,
  newFormWorkspaceValue,
  observeFreshStart,
  observeWorkspaceSubmitWitness,
  requiresSecondWorkspaceEnter,
  type WorkspaceSubmitWitness,
} from "./helpers/session-host-native-new-form-witness";
import {
  NATIVE_PANE_START,
  SIDEBAR_COLUMNS,
  type ParsedRoster,
  type RosterCardEntry,
  type RosterEntry,
  type RosterNavigationTarget,
  frameHeader,
  nextRosterNavigationTarget,
  parseRosterFrame,
  renderedTitleMatches,
  rosterCards,
  selectedRosterEntry,
} from "./helpers/session-host-native-roster-witness";

const SHIFT_TAB = "\x1b[Z";
const TAB = "\t";

/**
 * The synthetic fixture tags: the journal key and the `FX <tag>` pane prefix of
 * each provider fixture, and also the ids of the two configured external worker
 * profiles the New form must never offer (#493).
 */
const CLAUDE_TAG = "scla";
const CODEX_TAG = "scod";
/** The outer geometry the displayed row's pane has at the wide 120x50 layout. */
const PANE_COLS = OUTER_COLS - SIDEBAR_COLUMNS - 1;
const PANE_ROWS = OUTER_ROWS - 1;
/** The deliberate outer resize: wide, so the native pane is `100 - 33` by `30 - 1`. */
const RESIZED_OUTER = { cols: 100, rows: 30 } as const;
const RESIZED_PANE = { cols: RESIZED_OUTER.cols - SIDEBAR_COLUMNS - 1, rows: RESIZED_OUTER.rows - 1 } as const;

/** The provider choices the New form offers, in cycle order: the two defaults only (#493). */
const OFFERED_TARGETS = [
  { id: "claude", backend: "claude", label: "Claude Code (default)" },
  { id: "codex", backend: "codex", label: "Codex CLI (default)" },
] as const;

/** The launcher's full configured identity list, worker profiles included, which is never offered whole. */
const CONFIGURED_TARGETS = [
  ...OFFERED_TARGETS,
  { id: `external:${CLAUDE_TAG}`, backend: "claude", label: `${CLAUDE_TAG} (Claude Code)` },
  { id: `external:${CODEX_TAG}`, backend: "codex", label: `${CODEX_TAG} (Codex CLI)` },
] as const;

/** One synthetic provider question is answered; nothing real is ever answered. */
const ANSWER = "YES";
const FAREWELL = "BYE";

/** Startup switches the real Pi child must (and must never) receive. */
const REQUIRED_PI_ARGS = ["--offline", "--no-context-files", "--no-themes", "--no-tools"] as const;
const FORBIDDEN_SESSION_ARGS = new Set([
  "--session", "--session-id", "--sessionID", "--session-dir", "--no-session",
  "--continue", "--resume", "--fork",
]);

/** The drawn New form's editable Workspace row and the provider default. */
const NEW_FORM_FIELD_MARKER = "> Workspace:";
const PI_PROVIDER_VALUE = "[ Pi ]";
/** The host's bounded public create-failure notice, as `runSessionHost` words it. */
const CREATE_REFUSAL_NOTICE = "Session could not be started";

/**
 * The synthetic provider fixture. One program, two ACTUAL invocation modes,
 * positively labeled from its own real argv:
 *
 * - `tui` is the interactive provider child. It runs the original synthetic
 *   program in this row's real PTY and journals its own PID, argv, TTY and
 *   stdin state, pane geometry (from its own `resize`/SIGWINCH events), cwd,
 *   environment, every input line it actually receives, its continuing
 *   heartbeat, any signal, and its own farewell — and echoes a compact form of
 *   each into its own terminal so the real Main frame shows the same facts.
 * - `backend` is the owned Codex app-server stand-in. It is spawned with
 *   `app-server` in its real argv and plain stdio pipes, so it is deliberately
 *   NOT a terminal. It validates the lease's capability-token digest against
 *   the bearer its client presents, prints the production lease's exact
 *   readiness banner, answers only the read-only `initialize` and one empty
 *   `thread/loaded/list` census, and exits on the owned stop signal. It
 *   journals its own PID, a redacted argv, its non-TTY state, and closed method
 *   names, and never a bearer or digest.
 */
const SYNTHETIC_CLI_SOURCE = `"use strict";
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const journal = process.env.PRG_SYNTH_JOURNAL;
const tag = process.env.PRG_SYNTH_TAG || "fixture";
const argv = process.argv.slice(1);
const backendMode = argv.includes("app-server");
const role = backendMode ? "backend" : "tui";
const record = (event) => {
  try { fs.appendFileSync(journal, JSON.stringify(Object.assign({ tag: tag, role: role }, event)) + "\\n", "utf8"); } catch (error) { void error; }
};
const say = (line) => { try { process.stdout.write(line + "\\r\\n"); } catch (error) { void error; } };
const redact = (tokens) => {
  const out = [];
  let hide = false;
  for (const token of tokens) {
    if (hide) { out.push("<redacted>"); hide = false; continue; }
    out.push(token);
    if (token === "--ws-token-sha256") hide = true;
  }
  return out;
};
const envValue = (name) => (process.env[name] === undefined ? "absent" : "present");
const remoteIndex = argv.indexOf("--remote");
const authNameIndex = argv.indexOf("--remote-auth-token-env");
const authEnvName = authNameIndex >= 0 ? argv[authNameIndex + 1] : undefined;
const self = {
  type: "hello",
  pid: process.pid,
  ppid: process.ppid,
  execPath: process.execPath,
  argv: backendMode ? redact(argv) : argv,
  tty: process.stdout.isTTY === true,
  stdinTty: process.stdin !== null && process.stdin.isTTY === true,
  cols: process.stdout.columns,
  rows: process.stdout.rows,
  cwd: process.cwd(),
  path: process.env.PATH === undefined ? "absent" : process.env.PATH,
  home: process.env.HOME === undefined ? "absent" : process.env.HOME,
  target: process.env.PRG_SYNTH_TARGET === undefined ? "absent" : process.env.PRG_SYNTH_TARGET,
  boot: envValue(${JSON.stringify(SESSION_HOST_BOOTSTRAP_ENV)}),
  hook: envValue(${JSON.stringify(NATIVE_HOOK_BOOTSTRAP_ENV)}),
  runtimeRole: envValue("PI_REVIEW_GATE_RUNTIME_ROLE"),
  nodeOptions: envValue("NODE_OPTIONS"),
  remote: remoteIndex >= 0,
  remoteEndpoint: remoteIndex >= 0 ? argv[remoteIndex + 1] : undefined,
  authEnvNamePresent: authNameIndex >= 0,
  authEnvValuePresent: authEnvName !== undefined && process.env[authEnvName] !== undefined,
};
record(self);
process.on("exit", () => { record({ type: "exit" }); });

function runTui() {
  say("FX " + tag + " HELLO pid=" + self.pid + " tty=" + (self.tty ? 1 : 0) + " geo=" + self.cols + "x" + self.rows);
  say("FX " + tag + " TARGET " + self.target + " CWD " + self.cwd);
  process.stdout.on("resize", () => {
    const cols = process.stdout.columns, rows = process.stdout.rows;
    record({ type: "resize", cols: cols, rows: rows });
    say("FX " + tag + " RESIZE " + cols + "x" + rows);
  });
  let beats = 0;
  setInterval(() => { beats += 1; record({ type: "beat", n: beats }); }, 250).unref();
  process.on("SIGTERM", () => { record({ type: "signal", signal: "SIGTERM" }); say("FX " + tag + " SIGTERM"); setTimeout(() => process.exit(0), 150).unref(); });
  process.on("SIGHUP", () => { record({ type: "signal", signal: "SIGHUP" }); say("FX " + tag + " SIGHUP"); setTimeout(() => process.exit(0), 150).unref(); });
  say("FX " + tag + " QUESTION type " + ${JSON.stringify(ANSWER)} + " to confirm");
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    let index;
    while ((index = pending.search(/[\\r\\n]/)) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line.length === 0) continue;
      record({ type: "input", line: line });
      say("FX " + tag + " GOT " + JSON.stringify(line));
      if (line === ${JSON.stringify(ANSWER)}) { record({ type: "answered" }); say("FX " + tag + " CONFIRMED"); }
      if (line === ${JSON.stringify(FAREWELL)}) { record({ type: "farewell" }); say("FX " + tag + " FAREWELL"); setTimeout(() => process.exit(0), 120).unref(); }
    }
  });
}

function runBackend() {
  const listenAt = argv.indexOf("--listen");
  const authAt = argv.indexOf("--ws-auth");
  const digestAt = argv.indexOf("--ws-token-sha256");
  const listen = listenAt >= 0 ? argv[listenAt + 1] : undefined;
  const authMode = authAt >= 0 ? argv[authAt + 1] : undefined;
  const digest = digestAt >= 0 ? argv[digestAt + 1] : undefined;
  if (listen !== "ws://127.0.0.1:0" || authMode !== "capability-token"
    || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    record({ type: "backend_rejected", reason: "control-argv" });
    process.exit(2);
    return;
  }
  const sockets = new Set();
  const sendFrame = (socket, opcode, payload) => {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
    let header;
    if (body.length < 126) {
      header = Buffer.from([0x80 | opcode, body.length]);
    } else if (body.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(body.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(body.length), 2);
    }
    try { socket.write(Buffer.concat([header, body])); } catch (error) { void error; }
  };
  const answer = (socket, request) => {
    if (request === null || typeof request !== "object" || typeof request.method !== "string") return;
    record({ type: "backend_rpc", method: request.method });
    if (request.id === undefined) return;
    let result;
    if (request.method === "initialize") result = {};
    else if (request.method === "thread/loaded/list") result = { data: [], nextCursor: null };
    else return;
    sendFrame(socket, 1, JSON.stringify({ jsonrpc: "2.0", id: request.id, result: result }));
  };
  const parseFrames = (state) => {
    for (;;) {
      const buffer = state.buffer;
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const wide = buffer.readBigUInt64BE(2);
        if (wide > BigInt(16 * 1024 * 1024)) { state.socket.destroy(); return; }
        length = Number(wide);
        offset = 10;
      }
      if (!masked) { state.socket.destroy(); return; }
      const total = offset + 4 + length;
      if (buffer.length < total) return;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, total));
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      state.buffer = buffer.subarray(total);
      if (opcode === 8) {
        sendFrame(state.socket, 8, payload);
        state.socket.end();
        return;
      }
      if (opcode === 9) { sendFrame(state.socket, 10, payload); continue; }
      if (opcode !== 1) continue;
      let parsed;
      try { parsed = JSON.parse(payload.toString("utf8")); } catch (error) { void error; continue; }
      answer(state.socket, parsed);
    }
  };
  const server = http.createServer((request, response) => {
    void request;
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found\\n");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => { sockets.delete(socket); });
    socket.on("error", () => { sockets.delete(socket); });
  });
  server.on("upgrade", (request, socket, head) => {
    const header = request.headers.authorization;
    const presented = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    const accepted = presented.length > 0
      && crypto.createHash("sha256").update(presented, "utf8").digest("hex") === digest;
    if (!accepted) {
      record({ type: "backend_auth", ok: false });
      try { socket.write("HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\nContent-Length: 0\\r\\n\\r\\n"); } catch (error) { void error; }
      socket.destroy();
      return;
    }
    record({ type: "backend_auth", ok: true });
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string" || key.length === 0) { socket.destroy(); return; }
    const accept = crypto.createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11", "utf8").digest("base64");
    try {
      socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
    } catch (error) { void error; socket.destroy(); return; }
    const state = { socket: socket, buffer: head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0) };
    socket.on("data", (chunk) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      parseFrames(state);
    });
    parseFrames(state);
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (address === null || typeof address === "string") { process.exit(2); return; }
    const port = address.port;
    record({ type: "backend_listening" });
    say("codex app-server (WebSockets)");
    say("listening on: ws://127.0.0.1:" + port);
    say("readyz: http://127.0.0.1:" + port + "/readyz");
    say("healthz: http://127.0.0.1:" + port + "/healthz");
    say("note: synthetic hermetic fixture stand-in");
  });
  const stop = (signal) => {
    record({ type: "signal", signal: signal });
    try { server.close(); } catch (error) { void error; }
    for (const socket of sockets) {
      try { sendFrame(socket, 8, Buffer.alloc(0)); } catch (error) { void error; }
      try { socket.destroy(); } catch (error) { void error; }
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGHUP", () => stop("SIGHUP"));
}

if (backendMode) runBackend();
else runTui();
`;

/** One fixture's own journaled fact. Absent fields stay absent, never guessed. */
interface FixtureRecord {
  type?: string;
  tag?: string;
  /** The fixture's own POSITIVE invocation-mode label, derived from its actual argv. */
  role?: "backend" | "tui";
  pid?: number;
  ppid?: number;
  execPath?: string;
  /** The TUI's real argv; the backend's argv with its private digest redacted. */
  argv?: string[];
  tty?: boolean;
  stdinTty?: boolean;
  cols?: number;
  rows?: number;
  cwd?: string;
  path?: string;
  home?: string;
  target?: string;
  boot?: string;
  /** Presence only: a fresh native-hook bootstrap is never copied into a witness. */
  hook?: string;
  /** Presence only: the delegated test-process role variable is never copied. */
  runtimeRole?: string;
  nodeOptions?: string;
  /** True only for the TUI's own real invocation, whose argv carries --remote. */
  remote?: boolean;
  remoteEndpoint?: string;
  /** Presence only: neither the auth variable's value nor any bearer is journaled. */
  authEnvNamePresent?: boolean;
  authEnvValuePresent?: boolean;
  /** The backend's closed JSON-RPC method name; no params or payload are recorded. */
  method?: string;
  ok?: boolean;
  reason?: string;
  line?: string;
  signal?: string;
  n?: number;
}

/** One owned native fixture: its journal, its TUI, and — for owned Codex — its backend. */
interface NativeFixture {
  readonly targetId: string;
  readonly tag: string;
  readonly journalFile: string;
  readonly workspace: string;
  readonly pid: number;
  readonly hello: FixtureRecord;
  readonly watcher: OwnedPidExitWatcher;
  /** Present only for the owned Codex pair: the separate non-TTY app-server child. */
  readonly backend?: {
    readonly pid: number;
    readonly hello: FixtureRecord;
    readonly watcher: OwnedPidExitWatcher;
  };
}

interface CaseState {
  scratch: string;
  driver?: MainPtyDriver;
  /** True only after every scenario assertion, including every exit and the host Quit. */
  assertionsCompleted?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

function readJournal(file: string): FixtureRecord[] {
  const records: FixtureRecord[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as FixtureRecord);
    } catch {
      // An append may be observed between its write and its trailing newline.
    }
  }
  return records;
}

/**
 * Bounded wait for one native create's INTERACTIVE child to report itself,
 * watching the drawn frame at the same time: a create the real host refused, or
 * a New form that was never actually submitted, is named here instead of
 * surfacing later as an unexplained child that never appeared. An owned Codex
 * backend's earlier non-TTY hello is NOT the launch this waits for; its own
 * report is read separately and truthfully as the backend it is.
 */
async function untilNativeLaunch(
  driver: MainPtyDriver,
  journalFile: string,
  description: string,
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<FixtureRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = readJournal(journalFile);
    if (records.some(isInteractiveTuiStart)) return records;
    const frame = driver.currentText();
    if (frame.includes(CREATE_REFUSAL_NOTICE)) {
      throw new Error(`the real host refused the native create (${description}); no fixture child was started.`
        + `\nActual owned Main frame:\n${frame}`);
    }
    assert.ok(Date.now() < deadline,
      `timed out after ${timeoutMs}ms waiting for ${description}; the host's pending-create row is drawn: `
      + `${newFormPendingCreateDrawn(frame)}, a complete New form is still drawn: `
      + `${completeNewFormDrawn(frame)}, its Workspace field holds `
      + `${JSON.stringify(workspaceFieldValue(frame))}; fixture journal was:\n`
      + records.slice(-16).map((record) => JSON.stringify(record)).join("\n")
      + `\nActual owned Main frame:\n${frame}`);
    await sleep(25);
  }
}

/** Bounded wait on one fixture's own journal; the journal tail is the failure evidence. */
async function untilJournal(
  file: string,
  predicate: (records: FixtureRecord[]) => boolean,
  description: string,
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<FixtureRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = readJournal(file);
    if (predicate(records)) return records;
    assert.ok(Date.now() < deadline,
      `timed out after ${timeoutMs}ms waiting for ${description}; fixture journal was:\n`
      + records.slice(-16).map((record) => JSON.stringify(record)).join("\n"));
    await sleep(25);
  }
}

/**
 * A provider start this driver may admit as the interactive child: the fixture's
 * own POSITIVE mode label says `tui`, and its own real terminal says it is a
 * terminal. A backend `app-server` start has no TTY and never matches.
 */
function isInteractiveTuiStart(record: FixtureRecord): boolean {
  return record.type === "hello" && record.role === "tui" && record.tty === true;
}

/** The provider shim's unchanged base argv prefix: the recording script, then its fixture tag. */
function configuredArgvPrefixMatches(
  argv: readonly string[] | undefined,
  fixtureScript: string,
  tag: string,
): boolean {
  return argv !== undefined && argv.length >= 2 && argv[0] === fixtureScript && argv[1] === tag;
}

/**
 * The owned Codex TUI's exact lease-issued argv shape: the shim's base argv
 * unchanged, then ONLY the relay's `--remote` endpoint and the name of the
 * child-only auth variable. No generated hook flag, no daemon-isolating flag,
 * and no secret token appears anywhere in it.
 */
function codexOwnedTuiArgvMatches(
  argv: readonly string[] | undefined,
  fixtureScript: string,
  tag: string,
): boolean {
  if (argv === undefined || argv.length !== 6) return false;
  if (!configuredArgvPrefixMatches(argv, fixtureScript, tag)) return false;
  if (argv[2] !== "--remote" || argv[4] !== "--remote-auth-token-env") return false;
  if (typeof argv[3] !== "string" || !/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(argv[3])) return false;
  if (typeof argv[5] !== "string") return false;
  return new RegExp(`^${NATIVE_CODEX_BACKEND_AUTH_ENV_PREFIX}[0-9A-F]{16}$`, "u").test(argv[5]);
}

/** Assert the owned Codex TUI's exact argv after the positive witness admitted it. */
function assertCodexOwnedTuiArgv(
  argv: readonly string[] | undefined,
  fixtureScript: string,
  tag: string,
): void {
  assert.ok(codexOwnedTuiArgvMatches(argv, fixtureScript, tag),
    "the owned Codex TUI receives exactly the unchanged shim base argv, then the lease's "
    + `private --remote/--remote-auth-token-env tokens, and nothing else: ${JSON.stringify(argv)}`);
  for (const forbidden of ["--no-daemon", "--settings", "-c"]) {
    assert.ok(!(argv ?? []).includes(forbidden),
      `the owned Codex launch declines this host's hook preparation entirely; the TUI must not receive ${forbidden}`);
  }
}

/**
 * The positive fresh-start evidence: a hello this fixture itself labeled as the
 * interactive TUI, reporting a real terminal, in this exact workspace, with the
 * exact argv shape the backend's own launch mode requires. A backend start can
 * never satisfy this, however new its PID is.
 */
function interactiveTuiStarts(
  records: readonly FixtureRecord[],
  options: {
    readonly workspace: string;
    readonly tuiArgvMatches: (argv: readonly string[] | undefined) => boolean;
  },
): FixtureRecord[] {
  return records.filter((record) => isInteractiveTuiStart(record)
    && record.cwd === options.workspace
    && options.tuiArgvMatches(record.argv));
}

const countOf = (records: FixtureRecord[], type: string): number => records.filter((record) => record.type === type).length;
const lastBeat = (records: FixtureRecord[]): number => records.reduce((highest, record) => (record.type === "beat" && typeof record.n === "number" && record.n > highest ? record.n : highest), 0);

/** The content (right-hand) pane with its rows kept separate; the New form lives here. */
function contentPaneLines(text: string): string[] {
  return text.split("\n").map((line) => line.slice(NATIVE_PANE_START).replace(/\s+$/u, ""));
}

/** The native pane with its rows joined, so a real viewport soft-wrap can never hide a match. */
function nativePaneText(frame: string): string {
  return contentPaneLines(frame).join("");
}

/** The New form's Provider line, read only inside the content pane that draws the form. */
function providerRow(text: string): string | undefined {
  return contentPaneLines(text).find((line) => line.trimStart().endsWith("]")
    && line.trimStart().replace(/^>\s+/u, "").startsWith("Provider: "));
}

function providerValue(row: string | undefined): string {
  if (row === undefined) return "";
  const index = row.indexOf("Provider:");
  return row.slice(index + "Provider:".length).trim();
}

/* -------------------------------------------------------------------------- *
 * The drawn roster, read with the ONE shared strict witness                  *
 *                                                                            *
 * Every card rule lives in `helpers/session-host-native-roster-witness.ts`   *
 * and nowhere else in this file: the pinned terminal-cell pane scope, the    *
 * header-declared session count, the fixed 3-or-5-row card extents, the      *
 * ordered required action tail with the one optional Settings row in its     *
 * only legal position, the "any extra entry-shaped row means this roster is  *
 * not complete" rule, and the closed set of accepted status/input/count      *
 * VALUE words — including the shared not-applicable word an armed native row *
 * draws. What stays here is only how this scenario NAMES a parsed entry      *
 * inside its own step and failure messages. A partial repaint, an unknown    *
 * status word, a duplicated entry, or a roster whose cards do not fill the   *
 * declared count is still no parse at all, so nothing here is ever stepped   *
 * on.                                                                        *
 * -------------------------------------------------------------------------- */

/** The drawn roster, but only when the shared witness calls it complete. */
function completeRoster(text: string): ParsedRoster | undefined {
  const parsed = parseRosterFrame(text, SIDEBAR_COLUMNS);
  return parsed.complete ? parsed : undefined;
}

/**
 * The one drawn card whose complete title line belongs to `caption`, if any.
 * Its `status` and `background` are the real drawn rows, read verbatim.
 */
function cardFor(text: string, caption: string): RosterCardEntry | undefined {
  const matches = rosterCards(text, SIDEBAR_COLUMNS)
    .filter((card) => renderedTitleMatches(card.title, caption));
  return matches.length === 1 ? matches[0] : undefined;
}

/** The outer header names the displayed owner, tolerating a bounded host notice after " | ". */
function headerNamesOwner(text: string, title: string): boolean {
  const header = frameHeader(text);
  return renderedTitleMatches(header, title)
    || renderedTitleMatches(header.split(" | ")[0] ?? header, title);
}

/** True only for a complete roster whose single highlight is the requested row or action. */
function rosterSelectionIs(text: string, expected: string): boolean {
  const selected = selectedRosterEntry(text, SIDEBAR_COLUMNS);
  if (selected === undefined) return false;
  return selected.kind === "action"
    ? selected.label === expected
    : renderedTitleMatches(selected.title, expected);
}

/** How the drawn roster names one entry, for a step message that cannot lie about where it pressed. */
function entryCaption(entry: RosterEntry): string {
  return entry.kind === "action" ? entry.label : entry.title;
}

/**
 * The shared witness's navigation targets for one COMPLETE drawn roster, in the
 * order it actually rendered them. `rosterNavigationTargets()` cannot take this
 * role here: it correlates every drawn native card with an observer-confirmed Pi
 * row, and a provider child never loads that observer. Positions, selection, and
 * the duplicate-position refusal still come from the shared parse and the shared
 * step logic, so no local rule decides where a Down press may land.
 */
function drawnRosterTargets(parsed: ParsedRoster): readonly RosterNavigationTarget[] {
  return parsed.entries.map((entry) => ({ position: entry.position, label: entryCaption(entry) }));
}

/**
 * Explicit cyclic sidebar navigation with individually witnessed highlights.
 *
 * The harness's `moveRosterTo` correlates every drawn native card with an
 * observer-confirmed Pi row, and a provider child never loads that observer, so
 * a roster that contains provider cards has no correlation to navigate on. This
 * reads the COMPLETE rendered roster through the shared witness, derives the
 * single entry one cyclic Down below the drawn highlight with the shared step
 * logic, presses one real Down, and witnesses the highlight
 * landing on exactly that intermediate entry before any further key is sent — so
 * a destination several rows away is reached step by step instead of timing out
 * on the first intermediate highlight. Wrapping is the roster's own order, never
 * a key count. A row removal that leaves no highlight at all is handled too: one
 * Down must re-establish a unique highlight, which the next pass re-reads.
 */
async function stepRosterTo(driver: MainPtyDriver, expected: string, maximumSteps = 12): Promise<void> {
  for (let step = 0; step < maximumSteps; step += 1) {
    const text = driver.currentText();
    if (rosterSelectionIs(text, expected)) return;
    const parsed = completeRoster(text);
    assert.ok(parsed, `the drawn sidebar is not a complete roster while navigating to ${expected}:\n${text}`);
    const after = driver.frameRevision;
    const highlight = selectedRosterEntry(text, SIDEBAR_COLUMNS);
    if (highlight === undefined) {
      // Removing a row can leave the roster with no highlight at all. One real
      // Down must then establish a unique highlight before any further step.
      driver.pty.write(KEYS.down);
      await driver.waitFrame((drawn) => selectedRosterEntry(drawn, SIDEBAR_COLUMNS) !== undefined,
      `one real Down re-establishes a unique sidebar highlight on the way to ${expected}`, after);
      continue;
    }
    const next = nextRosterNavigationTarget(drawnRosterTargets(parsed), highlight.position);
    assert.ok(next, `the drawn roster names no unambiguous entry one Down from position ${highlight.position}:\n${text}`);
    driver.pty.write(KEYS.down); // Explicit UI navigation only, never activation.
    await driver.waitFrame((drawn) => {
      const landed = selectedRosterEntry(drawn, SIDEBAR_COLUMNS);
      return landed !== undefined && landed.position === next.position;
    }, `the real sidebar highlight steps one entry, ${entryCaption(highlight)} to ${next.label}, on the way to ${expected}`, after);
  }
  throw new Error(`the real sidebar highlight never reached ${expected} within ${maximumSteps} witnessed single-entry steps\nActual owned Main frame:\n${driver.currentText()}`);
}

/** Activate the highlighted row with the real Enter binding and witness the new owner. */
async function activateHighlighted(driver: MainPtyDriver, caption: string, expectedFrame: (text: string) => boolean): Promise<void> {
  const after = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  driver.focus = "main";
  await driver.waitFrame((text) => headerNamesOwner(text, caption) && expectedFrame(text),
  `Enter activates the highlighted ${caption} row and displays its own content`, after);
}

/**
 * The same real Enter activation, held until the host's frame writer goes quiet,
 * for the row whose exit the shared harness is about to count.
 *
 * `MainPtyDriver.closeNativeNormally()` takes its already-exited-card census from
 * the frame it is called with and then requires exactly ONE new exited card, so
 * that frame must show every card really on screen. The host's frame writer emits
 * only the rows that changed since its last write, with no atomic frame marker,
 * so a header-plus-nonempty-pane match can still be a mid-repaint slice missing
 * another row's card, and the census would start from an undercount. This applies
 * the same settled-activation discipline the harness's own witnessed activation
 * uses, with the shared witness: the COMPLETE roster whose single highlight is
 * the activated row, then the real frame writer going quiet,
 * then that same complete witness re-asserted on the settled frame. No extra key,
 * retry, or sleep is added, and no census assertion is relaxed.
 *
 * The harness's `activateRoster(label, draft, witness)` cannot take this role
 * here: it navigates with `moveRosterTo()`, which refuses any roster it cannot
 * correlate card-for-card with observer-confirmed Pi rows, and a provider child
 * never loads that observer. Its settled-editor fence also requires a non-empty
 * draft, and this scenario sends the real Pi row no draft at all.
 */
async function activateHighlightedOnSettledFrame(driver: MainPtyDriver, caption: string): Promise<void> {
  const settledFrame = (text: string): boolean => {
    if (!headerNamesOwner(text, caption)) return false;
    if (nativePaneText(text).length === 0) return false;
    const highlight = selectedRosterEntry(text, SIDEBAR_COLUMNS);
    return highlight !== undefined && highlight.kind === "native"
      && renderedTitleMatches(highlight.title, caption);
  };
  const after = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  driver.focus = "main";
  await driver.waitFrame(settledFrame,
  `Enter activates the highlighted ${caption} row on a complete roster with that row uniquely highlighted`, after);
  await driver.waitForFrameQuiet(`the real Main frame writer finishes repainting the activated ${caption} row`);
  const settled = driver.currentText();
  assert.ok(settledFrame(settled),
    `the settled frame after activating ${caption} still draws the complete roster with that row uniquely highlighted\nActual owned Main frame:\n${settled}`);
}

/**
 * Author the fixture-owned review-gate configuration the host discovers.
 *
 * It carries two external worker profiles in the shape the product documents
 * for a configured external agent: `command` is this test process's own Node
 * interpreter and the shared `args` are the owned recording script, with a
 * shared `env` overlay naming one owned empty `PATH` and the profile's own
 * `external:<tag>` target id. Since #493 such a profile is never a New choice;
 * if the host ever launched one anyway, the child's own journal would report
 * that overlay, which every row's assertions below refuse.
 */
function writeNativeAgentConfig(
  agentDir: string,
  fixtureScript: string,
  ownedBin: string,
  journals: Readonly<Record<string, string>>,
): void {
  const target = (tag: string, adapter: string): Record<string, unknown> => ({
    adapter,
    command: process.execPath,
    args: [fixtureScript, tag],
    env: {
      PATH: ownedBin,
      PRG_SYNTH_TAG: tag,
      PRG_SYNTH_TARGET: `external:${tag}`,
      PRG_SYNTH_JOURNAL: journals[tag],
    },
    review: {},
  });
  const config = {
    enabled: true,
    review: { activeReviewers: [] },
    execution: { workerResources: {}, routes: { execute: [], research: [] } },
    externalAgents: {
      [CLAUDE_TAG]: target(CLAUDE_TAG, "claude-cli"),
      [CODEX_TAG]: target(CODEX_TAG, "codex-cli"),
    },
  };
  writeFileSync(join(agentDir, "review-gate.json"), JSON.stringify(config, undefined, 2), { mode: 0o600 });
}

/** Quote one value for a POSIX `sh` script as a single literal word. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Write the fixture-owned `claude` and `codex` shims a DEFAULT target resolves
 * to. Each one sets only its own fixture tag and journal, then `exec`s this
 * test's Node interpreter on the recording script with the launcher's argv
 * appended unchanged, so the provider process keeps the shim's PID, PTY, and
 * stdio, and its argv is exactly `[script, tag, ...launcher argv]`.
 */
function writeProviderShims(
  binDir: string,
  fixtureScript: string,
  journals: Readonly<Record<string, string>>,
): void {
  const shims: Readonly<Record<string, string>> = { claude: CLAUDE_TAG, codex: CODEX_TAG };
  for (const [command, tag] of Object.entries(shims)) {
    const file = join(binDir, command);
    writeFileSync(file, [
      "#!/bin/sh",
      `PRG_SYNTH_TAG=${shellQuote(tag)}`,
      `PRG_SYNTH_JOURNAL=${shellQuote(journals[tag]!)}`,
      "export PRG_SYNTH_TAG PRG_SYNTH_JOURNAL",
      `exec ${shellQuote(process.execPath)} ${shellQuote(fixtureScript)} ${shellQuote(tag)} "$@"`,
      "",
    ].join("\n"), { mode: 0o700 });
    chmodSync(file, 0o700);
  }
}

/**
 * The two absolute files an armed observer's generated hook command names, as
 * the REAL Main process resolves them: its own Node interpreter (the same
 * interpreter this test spawned it with) and the compiled relay entry inside the
 * staged candidate package, which is the only place the launch preparation
 * looks for it. Both are non-secret paths.
 */
interface HookEntrypoints {
  readonly nodeExecutable: string;
  readonly relayEntry: string;
}

function expectedHookEntrypoints(candidate: CandidatePackage): HookEntrypoints {
  const relayEntry = join(candidate.root, "dist", "src", "session-host", "native-hook-relay.js");
  assert.ok(statSync(relayEntry).isFile(),
    `the staged candidate package must carry the compiled native hook relay the armed launch names: ${relayEntry}`);
  // The expected command strings below quote each path literally. If a fixture
  // path ever needed shell or TOML escaping, this fails instead of quietly
  // comparing a form the launcher would never deliver.
  for (const path of [process.execPath, relayEntry]) {
    assert.ok(!/[\\"\u0000-\u001f]/u.test(path),
      `the hook command path ${JSON.stringify(path)} needs escaping this witness does not model`);
  }
  return { nodeExecutable: process.execPath, relayEntry };
}

/**
 * Validate the one Claude hook-settings file this armed launch staged, from the
 * path the child itself reported. This runs while the row is live: the manager
 * releases the artifact lease once the provider source and the PTY settle, so
 * the file is only guaranteed present now.
 *
 * Only the non-secret shape is checked: a flag-settings layer carrying nothing
 * but `hooks`, exactly the events this host observes, and one command handler
 * naming the Node interpreter and the compiled relay. No token, instance id,
 * socket path, or generation can satisfy it, and none is ever printed.
 */
function assertClaudeHookSettingsFile(options: {
  readonly settingsPath: string;
  readonly ownedTmpRoot: string;
  readonly entrypoints: HookEntrypoints;
}): void {
  const { settingsPath, ownedTmpRoot, entrypoints } = options;
  assert.equal(basename(settingsPath), "claude-hook-settings.json",
    "the generated flag-settings file keeps its own fixed owned name");
  const namespace = dirname(settingsPath);
  assert.ok(basename(namespace).startsWith("prg-native-hook-"),
    "the settings file lives in the launcher's own freshly created artifact namespace");
  const canonicalTmp = realpath(ownedTmpRoot);
  const canonicalNamespace = realpath(namespace);
  assert.ok(canonicalNamespace !== canonicalTmp && canonicalNamespace.startsWith(`${canonicalTmp}${sep}`),
    "that namespace is this run's own, under the temporary root this host was started with");
  assert.equal(statSync(settingsPath).mode & 0o777, 0o600,
    "the staged settings file stays private to this process");
  const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["hooks"],
    "the flag-settings layer carries ONLY the hooks key, so every other settings layer and key keeps its own value");
  const hooks = parsed.hooks as Record<string, unknown>;
  assert.deepEqual(Object.keys(hooks), [...CLAUDE_NATIVE_HOOK_EVENTS],
    "the generated map names exactly the events this host observes, in order");
  for (const event of CLAUDE_NATIVE_HOOK_EVENTS) {
    const groups = hooks[event];
    assert.ok(Array.isArray(groups) && groups.length === 1, `${event} carries exactly one matcher group`);
    const group = (groups as unknown[])[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(group), ["hooks"], `${event} names no key besides its handler list`);
    const handlers = group.hooks;
    assert.ok(Array.isArray(handlers) && handlers.length === 1, `${event} carries exactly one handler`);
    assert.deepEqual((handlers as unknown[])[0], {
      type: "command",
      command: entrypoints.nodeExecutable,
      args: [entrypoints.relayEntry],
      timeout: NATIVE_HOOK_TIMEOUT_SECONDS,
      onFailure: "continue",
    }, `the generated ${event} hook is the compiled relay's exec form, with no matcher, no condition, and no secret`);
  }
}

/**
 * The exact observer flags an armed claude launch appended after the configured
 * base argv, proved by reading the file they point at and returned so the
 * caller's single ordered-argv assertion pins both tokens in place.
 */
function claudeObserverFlags(
  argv: readonly string[],
  context: { readonly ownedTmpRoot: string; readonly entrypoints: HookEntrypoints },
): readonly string[] {
  const generated = argv.slice(2);
  assert.equal(generated.length, 2,
    `the claude-backed child receives exactly the shim's base argv plus the two generated --settings tokens and nothing else; its own argv was ${JSON.stringify(argv)}`);
  assert.equal(generated[0], "--settings",
    "the claude route is the single hook-only --settings layer, because the configured argv carries no --settings of its own");
  const settingsPath = generated[1] ?? "";
  assertClaudeHookSettingsFile({ settingsPath, ...context });
  return ["--settings", settingsPath];
}

/**
 * The Claude TUI is the default target's interactive child plus exactly the one
 * generated hook-only `--settings` pair: the unchanged base argv, then those two
 * tokens, and nothing else. Used as a non-throwing fresh-start witness so a
 * partial or unexpected record can never stand in for the launched child.
 */
function claudeTuiArgvMatches(
  argv: readonly string[] | undefined,
  fixtureScript: string,
  tag: string,
  ownedTmpRoot: string,
): boolean {
  if (argv === undefined || argv.length !== 4) return false;
  if (!configuredArgvPrefixMatches(argv, fixtureScript, tag)) return false;
  if (argv[2] !== "--settings" || typeof argv[3] !== "string") return false;
  return basename(argv[3]) === "claude-hook-settings.json"
    && argv[3].startsWith(`${ownedTmpRoot}${sep}`);
}

/** Open the real New form and require the provider choice to start at Pi. */
async function openNewForm(driver: MainPtyDriver): Promise<void> {
  await driver.ensureSidebarFocus();
  await stepRosterTo(driver, "New session");
  const afterOpen = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  driver.focus = "form";
  await driver.waitFrame((text) => {
    const pane = contentPaneLines(text);
    return pane.some((line) => line.trim() === "New session")
      && pane.some((line) => line.includes(NEW_FORM_FIELD_MARKER))
      && !pane.some((line) => line.includes("> New name:"))
      && providerValue(providerRow(text)) === PI_PROVIDER_VALUE;
  },
  "the real New form opens again in the content pane with the provider defaulting to Pi and no native target preselected", afterOpen);
}

/**
 * Shift+Tab once to the Provider line — the control drawn directly ABOVE the
 * workspace field and BELOW the Host line — still on Pi, and witness that drawn
 * order in the same frame.
 */
async function focusProviderLine(driver: MainPtyDriver): Promise<void> {
  const afterProvider = driver.frameRevision;
  driver.pty.write(SHIFT_TAB);
  await driver.waitFrame((text) => {
    const focusedProvider = providerRow(text);
    if (focusedProvider?.trimStart().startsWith("> Provider: ") !== true) return false;
    if (providerValue(focusedProvider) !== PI_PROVIDER_VALUE) return false;
    const lines = contentPaneLines(text);
    const bare = (line: string): string => line.trimStart().replace(/^>\s+/u, "");
    const hostIndex = lines.findIndex((line) => bare(line).startsWith("Host: ["));
    const providerIndex = lines.findIndex((line) => line === focusedProvider);
    const workspaceIndex = lines.findIndex((line) => bare(line).startsWith("Workspace: "));
    return hostIndex >= 0 && providerIndex > hostIndex
      && (workspaceIndex < 0 || workspaceIndex > providerIndex);
  }, "one Shift+Tab focuses the Provider line drawn between Host and Workspace", afterProvider);
}

/**
 * Cycle the Provider line one real Down at a time and witness every drawn
 * choice by its exact drawn value; reaching the last default also proves the
 * cycle wraps straight back to Pi.
 */
async function cycleProviderTo(driver: MainPtyDriver, steps: number): Promise<string> {
  for (let step = 1; step <= steps; step += 1) {
    const expected = `[ ${OFFERED_TARGETS[step - 1]!.label} ]`;
    const after = driver.frameRevision;
    driver.pty.write(KEYS.down);
    await driver.waitFrame((text) => providerValue(providerRow(text)) === expected,
    `the Provider line cycles to the offered choice ${expected}`, after);
  }
  if (steps === OFFERED_TARGETS.length) {
    // The last default is the last native choice: one more Down wraps to Pi, so
    // no configured worker profile is ever drawn (#493), and Up returns to it.
    const last = `[ ${OFFERED_TARGETS[steps - 1]!.label} ]`;
    const afterWrap = driver.frameRevision;
    driver.pty.write(KEYS.down);
    await driver.waitFrame((text) => providerValue(providerRow(text)) === PI_PROVIDER_VALUE,
      "one Down past the last default wraps the Provider line to Pi: no worker profile choice exists", afterWrap);
    const afterBack = driver.frameRevision;
    driver.pty.write(KEYS.up);
    await driver.waitFrame((text) => providerValue(providerRow(text)) === last,
      `Up returns the Provider line to ${last}`, afterBack);
  }
  return providerValue(providerRow(driver.currentText()));
}

/** The New form's Workspace field content row value, read in the content pane. */
function workspaceFieldValue(text: string): string | undefined {
  const rows = contentPaneLines(text);
  const index = rows.findIndex((line) => line.includes(NEW_FORM_FIELD_MARKER));
  if (index < 0) return undefined;
  const column = rows[index]!.indexOf(NEW_FORM_FIELD_MARKER) + NEW_FORM_FIELD_MARKER.length + 1;
  return rows[index]!.slice(column).trim();
}

/** Hand the form's focus back to the Workspace field and submit an exact path. */
async function submitWorkspace(
  driver: MainPtyDriver,
  workspace: string,
  journalFile: string,
  tuiArgvMatches: (argv: readonly string[] | undefined) => boolean,
): Promise<void> {
  const afterTab = driver.frameRevision;
  driver.pty.write(TAB);
  await driver.waitFrame((text) => providerRow(text)?.trimStart().startsWith("> ") === false
    && text.includes(NEW_FORM_FIELD_MARKER),
  "Tab returns the New form's focus from the Provider line to the Workspace field", afterTab);

  await driver.clearWorkspaceField("the native `ctrl+c clear` action removes any retained Workspace draft");
  await driver.writeAndWait(workspace, (text) => text.includes(workspace.slice(-18)),
    "the explicit workspace is entered in the real native field");

  // Exactly the harness's two-step submit and nothing more: the first Enter
  // submits or accepts the exact owned-folder completion, and only a complete
  // New form whose field then holds the exact completed owned folder gets one
  // further Enter. Every witness is positive and captured on the frame that
  // matched it, and the fresh-start witness is this fixture's own journal,
  // fenced against the identities already in it before this Enter. The journal
  // record must be a POSITIVE interactive-TUI start with this target's expected
  // argv: the owned Codex backend's earlier non-TTY `app-server` hello, and any
  // other new PID, is structurally not a fresh-start witness.
  const afterFirstEnter = driver.frameRevision;
  const preexistingStarts = captureStartIdentities(readJournal(journalFile));
  driver.pty.write(KEYS.enter);
  let firstEnter: WorkspaceSubmitWitness<FixtureRecord> | undefined;
  await driver.waitFrame((text) => {
    const witness = observeWorkspaceSubmitWitness(text, {
      completedPath: `${workspace}/`,
      freshStart: () => observeFreshStart(interactiveTuiStarts(readJournal(journalFile), {
        workspace,
        tuiArgvMatches,
      }), {
        workspace,
        startType: "hello",
        fence: preexistingStarts,
      }),
    });
    if (witness === undefined) return false;
    firstEnter = witness; // the matched frame and record ARE the branch's evidence
    return true;
  },
  "native Enter positively shows the completed owned folder in a complete New form, "
    + "the host's pending-create row, or this fixture's own fresh start report",
  afterFirstEnter);
  assert.ok(firstEnter !== undefined,
    "the bounded frame wait resolves only once a positive New-form witness was captured");
  if (requiresSecondWorkspaceEnter(firstEnter)) {
    assert.equal(newFormWorkspaceValue(firstEnter.frame), `${workspace}/`,
      "first native Enter accepted the exact owned folder completion, not another path or an error");
    await driver.writeKeys(KEYS.enter, "a separate native Enter submits the accepted Workspace path");
  }
}

/**
 * Create one native provider row entirely through the real New form's Provider
 * control, then take every child this launch actually created from its own
 * journal and put a kernel exit watcher on each reported PID. For owned Codex
 * that is BOTH the real non-TTY app-server backend and the real interactive TUI;
 * for Claude it is the one interactive child.
 */
async function createNativeFixtureSession(options: {
  readonly driver: MainPtyDriver;
  readonly workspace: string;
  readonly tag: string;
  readonly journalFile: string;
  readonly fixtureScript: string;
  /** The host's own PATH, which a default target's child inherits unchanged. */
  readonly hostPath: string;
  readonly scratchHome: string;
  readonly cycles: number;
  /** The default target id this row must launch, and its drawn label. */
  readonly targetId: string;
  readonly label: string;
  /** True only for the production owned-Codex split: one backend plus one TUI. */
  readonly ownedCodex: boolean;
  /** Non-throwing positive witness for this target's exact interactive-TUI argv. */
  readonly tuiArgvMatches: (argv: readonly string[] | undefined) => boolean;
  /** Exact assertion for that same argv once the TUI has been admitted. */
  readonly assertTuiArgv: (argv: readonly string[] | undefined) => void;
}): Promise<NativeFixture> {
  const { driver, workspace, tag, journalFile } = options;
  await openNewForm(driver);
  await focusProviderLine(driver);
  const drawnChoice = await cycleProviderTo(driver, options.cycles);
  assert.equal(drawnChoice, `[ ${options.label} ]`,
    `the focused Provider line names the default target ${options.targetId}; drawn value was ${drawnChoice}`);
  await submitWorkspace(driver, workspace, journalFile, options.tuiArgvMatches);

  const records = await untilNativeLaunch(driver, journalFile,
    `${tag}'s own interactive-TUI identity report after the real provider create launched it`);
  driver.focus = "main";
  const hello = records.filter(isInteractiveTuiStart).at(-1)!;
  assert.ok(hello, `${tag} reported an interactive TUI start of its own`);
  assert.equal(typeof hello.pid, "number", `${tag} reported its own process id`);
  const pid = hello.pid!;
  // Register the TUI watcher at acquisition, before any other assertion, so a
  // failure below still leaves this exact process owned and observable.
  const watcher = new OwnedPidExitWatcher(pid);
  driver.nativeExitWatchers.set(pid, watcher);
  await watcher.waitUntilRegistered(EVENT_TIMEOUT_MS);

  let backend: NativeFixture["backend"];
  const backendHellos = records.filter((entry) => entry.type === "hello" && entry.role === "backend");
  if (options.ownedCodex) {
    assert.equal(backendHellos.length, 1,
      "the owned Codex launch creates exactly ONE app-server backend for this row");
    const backendHello = backendHellos[0]!;
    assert.equal(typeof backendHello.pid, "number", "the owned Codex backend reports its own process id");
    const backendPid = backendHello.pid!;
    assert.notEqual(backendPid, pid,
      "the owned backend and the interactive TUI are two distinct OS processes");
    // Same discipline for the second owned child: watcher first, assertions after.
    const backendWatcher = new OwnedPidExitWatcher(backendPid);
    driver.nativeExitWatchers.set(backendPid, backendWatcher);
    await backendWatcher.waitUntilRegistered(EVENT_TIMEOUT_MS);
    backend = { pid: backendPid, hello: backendHello, watcher: backendWatcher };
  } else {
    assert.equal(backendHellos.length, 0,
      "a non-owned native launch creates no app-server backend beside its interactive child");
  }

  assert.equal(hello.role, "tui",
    "the fixture positively labeled the PTY child from its OWN actual invocation mode, not from a journal position or a new PID");
  assert.equal(hello.target, "absent",
    "a default target carries no configured environment overlay: no worker profile's target id reached the child");
  assert.equal(hello.tty, true, "the real interactive child reports a real terminal of its own");
  assert.equal(hello.stdinTty, true, "the interactive child's own stdin is that same real terminal");
  assert.deepEqual([hello.cols, hello.rows], [PANE_COLS, PANE_ROWS],
    "the child's own terminal is the pane the real host displays");
  assert.equal(hello.cwd, workspace, "the child runs in the workspace this row selected");
  options.assertTuiArgv(hello.argv);
  assert.equal(hello.remote, options.ownedCodex,
    options.ownedCodex
      ? "the TUI's own invocation is the remote-attached interactive one, never the backend's app-server mode"
      : "a non-owned claude launch has no owned backend and therefore no lease-issued --remote flag");
  assert.equal(hello.authEnvNamePresent, options.ownedCodex,
    options.ownedCodex
      ? "the owned Codex TUI receives the private auth variable NAME in argv; its value is never journaled"
      : "a non-owned claude launch receives no owned Codex auth variable name");
  assert.equal(hello.authEnvValuePresent, options.ownedCodex,
    options.ownedCodex
      ? "the child-only environment really carries a value for that name; the witness records presence only"
      : "a non-owned claude launch receives no owned Codex auth variable value");
  assert.equal(hello.path, options.hostPath,
    "the default target's child inherits the host's own PATH unchanged, never a worker profile's PATH overlay");
  assert.equal(hello.execPath !== undefined && realpath(hello.execPath) === realpath(process.execPath), true,
    "the hosted child is the fixture shim's exec of this test's own Node interpreter, never a real provider binary");
  assert.equal(hello.home, options.scratchHome, "the child's HOME stays the fixture's owned home");
  assert.equal(hello.boot, "absent", "no session-host bootstrap token reaches a provider child");
  assert.equal(hello.runtimeRole, "absent", "no delegated runtime-role authorization reaches a provider child");
  assert.notEqual(NATIVE_HOOK_BOOTSTRAP_ENV, SESSION_HOST_BOOTSTRAP_ENV,
    "the native-hook opt-in marker is a different marker family from the Pi session-host bootstrap that stays absent");
  assert.equal(hello.hook, options.ownedCodex ? "absent" : "present",
    options.ownedCodex
      ? "the owned Codex launch declines this host's hook preparation entirely, so its TUI receives no marker"
      : "this launch's own fresh native-hook opt-in marker reaches its provider child, which is what lets the armed observer authenticate a later hook");

  if (backend !== undefined) {
    assert.equal(backend.hello.role, "backend",
      "the fixture positively labeled this process from its OWN actual app-server invocation mode");
    assert.equal(backend.hello.tty, false,
      "the owned app-server backend is a real stdio child, never a terminal, and this is asserted separately from the TUI's own tty=true");
    assert.equal(backend.hello.stdinTty, false,
      "the owned backend's stdin is not a terminal either");
    assert.equal(backend.hello.remote, false,
      "the backend's own argv carries no --remote: that is the TUI's invocation alone");
    assert.deepEqual(backend.hello.argv, [
      options.fixtureScript, tag,
      "app-server", "--listen", "ws://127.0.0.1:0",
      "--ws-auth", "capability-token", "--ws-token-sha256", "<redacted>",
    ], "the owned backend receives exactly the shim's base argv and the lease's closed app-server capability-token control argv; the private digest is redacted from the witness, never copied");
    assert.equal(backend.hello.hook, "absent",
      "the owned backend receives no generated hook marker either");
    assert.equal(backend.hello.boot, "absent", "no session-host bootstrap token reaches the backend");
    assert.equal(backend.hello.runtimeRole, "absent", "no delegated runtime-role authorization reaches the backend");
    assert.equal(backend.hello.target, "absent", "no worker profile overlay reaches the backend either");
    assert.equal(backend.hello.cwd, workspace, "the owned backend runs in the same selected workspace");
    assert.equal(backend.hello.path, options.hostPath, "the backend inherits the same host PATH as its TUI");
    assert.equal(backend.hello.home, options.scratchHome, "the backend sees the same owned HOME the operator set");
    // NEGATIVE CONTROL: a backend start is a fresh PID with a fresh hello, yet
    // it can never satisfy the interactive fresh-start witness this file uses.
    assert.equal(isInteractiveTuiStart(backend.hello), false,
      "a backend hello is never an interactive TUI start, however new its PID is");
    assert.equal(observeFreshStart(interactiveTuiStarts([backend.hello], {
      workspace,
      tuiArgvMatches: options.tuiArgvMatches,
    }), {
      workspace,
      startType: "hello",
      fence: { pids: new Set(), sessionIds: new Set() },
    }), undefined,
    "the backend's own non-TTY app-server startup cannot satisfy the frontend fresh-start witness");
    const backendIndex = records.indexOf(backend.hello);
    const tuiIndex = records.indexOf(hello);
    assert.ok(backendIndex >= 0 && tuiIndex > backendIndex,
      "the backend reports before the TUI can exist: the real launch waits for backend readiness first");
    const authRecords = records.filter((entry) => entry.type === "backend_auth");
    assert.ok(authRecords.length >= 1 && authRecords.every((entry) => entry.ok === true),
      "the backend accepted the lease's real bearer/digest authentication and recorded no rejected handshake");
    const rpcMethods = records.filter((entry) => entry.type === "backend_rpc").map((entry) => entry.method);
    assert.deepEqual(rpcMethods, ["initialize", "initialized", "thread/loaded/list"],
      "the backend saw ONLY the production read-only pre-attach census: no TUI-originated genuine initialize, thread start, or turn start was ever invented");
    const journalText = readFileSync(journalFile, "utf8");
    assert.ok(!/[0-9a-f]{64}/u.test(journalText),
      "the private capability-token digest is never copied into the witness journal");
  }

  return { targetId: options.targetId, tag, journalFile, workspace, pid, hello, watcher, ...(backend === undefined ? {} : { backend }) };
}

function realpath(path: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { realpathSync } = require("node:fs") as typeof import("node:fs");
  return realpathSync(path);
}

/** Bounded wait for the Main runner's real `@lydell/node-pty` onExit journal record. */
async function untilPtyExit(driver: MainPtyDriver, pid: number, description: string): Promise<void> {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  for (;;) {
    const record = driver.ptyExits().find((entry) => entry.type === "pty_exit" && entry.pid === pid);
    if (record !== undefined) {
      assert.equal(record.exitCode, 0, `${description}: the manager-owned PTY reported exitCode ${record.exitCode}`);
      assert.ok(!record.signal, `${description}: the manager-owned PTY exit was not signal termination`);
      return;
    }
    assert.ok(Date.now() < deadline,
      `timed out after ${EVENT_TIMEOUT_MS}ms waiting for ${description}: the runner journaled no owned-PTY exit for pid ${pid}`);
    await sleep(25);
  }
}

function registerCaseCleanup(t: { after(fn: () => Promise<void>): void }, state: CaseState): void {
  t.after(async () => {
    let cleanup: CleanupOutcome | undefined;
    if (state.driver) {
      try {
        cleanup = await state.driver.boundedCleanup();
      } catch {
        try { cleanup = await state.driver.forceCleanupAndObserve(); } catch {
          cleanup = state.driver.cleanupStatus(true);
        }
      } finally {
        state.driver.dispose();
      }
    }
    const cleanupConfirmed = cleanup?.childrenExited === true
      && cleanup.shutdownEventsObserved
      && cleanup.gracefulHostExit
      && !cleanup.forced;
    // Failed witnesses are always retained, and the compatibility cleanup entry
    // point retains even successful runtime trees until positive per-entry
    // ownership receipts exist; root creation alone never authorizes removal.
    // Assertion success is not a retention predicate; settlement is.
    if (cleanupConfirmed) {
      try {
        if (!removeOwnedScratchTree(state.scratch)) {
          process.stderr.write(`preserved Main runtime witness (per-entry ownership receipts unavailable): ${state.scratch}\n`);
        }
      } catch {
        process.stderr.write("preserved owned Main scratch: bounded cleanup could not positively remove every entry\n");
      }
    } else {
      const status = cleanup
        ? `childrenExited=${cleanup.childrenExited} shutdownEvents=${cleanup.shutdownEventsObserved} hostExited=${cleanup.hostExited} gracefulHostExit=${cleanup.gracefulHostExit} forced=${cleanup.forced}`
        : "cleanup status unavailable";
      process.stderr.write(`preserved owned Main scratch ${state.scratch}; assertionsCompleted=${state.assertionsCompleted === true}; ${status}\n`);
    }
  });
}

test("real public Main hosts a real Pi row, a synthetic native CLI fixture, and the owned synthetic Codex backend+TUI through the New provider UI, with owned input, resize, switching, Claude's host-owned startup baseline, the owned Codex all-unknown status, and exact exits", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const runtime = resolveRuntimePin(t);
  if (!runtime) return;

  const scratch = createOwnedScratchRoot();
  const state: CaseState = { scratch };
  registerCaseCleanup(t, state);

  const workspacePi = makeWorkspace(scratch, "workspace-pi");
  const workspaceClaude = makeWorkspace(scratch, "workspace-claude-fixture");
  const workspaceCodex = makeWorkspace(scratch, "workspace-codex-fixture");

  // The fixture tree is owned by this file: the recording script, one journal
  // per fixture, the two provider shims a default target resolves to, and the
  // empty directory the never-offered worker profiles name as their PATH.
  const fixtureDir = join(scratch, "native-fixture");
  mkdirSync(fixtureDir, { mode: 0o700 });
  const fixtureScript = join(fixtureDir, "synthetic-cli.cjs");
  writeFileSync(fixtureScript, SYNTHETIC_CLI_SOURCE, { mode: 0o600 });
  const ownedBin = join(fixtureDir, "owned-empty-bin");
  mkdirSync(ownedBin, { mode: 0o700 });
  const providerBin = join(fixtureDir, "provider-bin");
  mkdirSync(providerBin, { mode: 0o700 });
  const journals: Record<string, string> = {
    [CLAUDE_TAG]: join(fixtureDir, `${CLAUDE_TAG}.jsonl`),
    [CODEX_TAG]: join(fixtureDir, `${CODEX_TAG}.jsonl`),
  };
  for (const file of Object.values(journals)) writeFileSync(file, "", { mode: 0o600 });
  writeProviderShims(providerBin, fixtureScript, journals);

  // One ordinary shared native agent root, then this scenario's configured
  // worker profiles in it. The host discovers exactly this file; its New form
  // offers only the two defaults, while the launcher's configured identity list
  // still carries the profiles untouched.
  const nativeAgentDir = makeNativeAgentRoot(scratch);
  writeNativeAgentConfig(nativeAgentDir, fixtureScript, ownedBin, journals);
  const authoredConfig = normalizeConfig(JSON.parse(readFileSync(join(nativeAgentDir, "review-gate.json"), "utf8")) as never);
  assert.deepEqual(listNativeCliNewSessionTargets(authoredConfig), OFFERED_TARGETS,
    "the authored configuration offers exactly Pi's two built-in defaults, in the order the New form cycles them");
  assert.deepEqual(listNativeCliTargets(authoredConfig), CONFIGURED_TARGETS,
    "the configured worker profiles stay in the launcher's identity list, untouched, yet are never offered");

  const observerFile = join(scratch, "observer", "native-main.jsonl");
  const editorLog = createEditorLog(scratch);
  const editorTarget = join(scratch, "editor-target");
  mkdirSync(editorTarget, { mode: 0o700 });
  const editor = createEditorExecutable(scratch, editorTarget, editorLog);
  const candidate = compileAndStageCandidate(scratch);

  const scratchHome = join(scratch, "home");
  const startEnv = makeRuntimeEnvironment(scratch, runtime, editor, observerFile, editorLog, "", nativeAgentDir);
  // The fixture's provider shims come FIRST on the host's PATH, so a default
  // target's bare `claude` / `codex` resolves to them and never to a real
  // provider binary that may share a later directory (such as Node's own).
  const hostPath = `${providerBin}${delimiter}${startEnv.PATH ?? ""}`;
  startEnv.PATH = hostPath;
  assert.deepEqual(Object.keys(startEnv).filter((name) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i.test(name)), [],
    "the synthetic native child environment contains no external credentials");
  const args = [...REQUIRED_PI_ARGS, "--extension", OBSERVER_FIXTURE];
  assert.equal(args.some((arg) => FORBIDDEN_SESSION_ARGS.has(arg)), false,
    "the real Pi session receives no forced, resumed, or no-session override");

  // The armed CLAUDE launch stages its private hook artifact under the
  // temporary root this host was started with, and its generated command names
  // the compiled relay inside the staged candidate. Both are known here, so
  // that row's observer flag is checked against the real path rather than
  // allowed to be anything. The owned Codex row deliberately receives no such
  // flag, marker, or artifact, so it has no hook entrypoint to model here.
  const ownedTmpRoot = startEnv.TMPDIR ?? "";
  assert.ok(ownedTmpRoot.startsWith(`${scratch}${sep}`),
    "the host's own temporary root stays inside this case's owned scratch");
  const hookEntrypoints = expectedHookEntrypoints(candidate);

  const driver = await MainPtyDriver.start({
    ptyModule: runtime.pty,
    scratchRoot: scratch,
    candidate,
    runtime,
    observerFile,
    editor,
    editorLog,
    editorValue: "",
    args,
    env: startEnv,
  });
  state.driver = driver;
  await driver.waitFrame((text) => text.includes("Welcome") && text.includes("New session") && text.includes("Quit host"),
    "fresh real Main displays its empty welcome/sidebar state");

  // --- One real Pi row: the unchanged Pi path, offline and tool-less. ---
  const piSession: OwnedSession = await driver.createNativeSession(workspacePi);
  assert.equal(piSession.record.agentDir, nativeAgentDir, "the Pi row uses the fixture's shared normal agent root");
  assert.equal(piSession.record.tty, true, "the real Pi child has its own real native PTY");
  assert.deepEqual(piSession.record.credentialLikeEnvironmentNames, [],
    "the Pi child inherited no external credential-like environment variables");
  assert.equal(processIsAlive(piSession.record.pid), true, "the real Pi child is live");

  // --- Two native provider rows through the actual New form Provider control. ---
  // The claude-backed fixture is the default Claude target, one Down past Pi.
  // Its armed launch adds exactly one hook-only `--settings` layer, because the
  // default target carries no argv of its own; the file it points at is read
  // and validated here, while the row is still live.
  const claudeFixture = await createNativeFixtureSession({
    driver,
    workspace: workspaceClaude,
    tag: CLAUDE_TAG,
    journalFile: journals[CLAUDE_TAG]!,
    fixtureScript,
    hostPath,
    scratchHome,
    cycles: 1,
    targetId: OFFERED_TARGETS[0].id,
    label: OFFERED_TARGETS[0].label,
    ownedCodex: false,
    tuiArgvMatches: (argv) => claudeTuiArgvMatches(argv, fixtureScript, CLAUDE_TAG, ownedTmpRoot),
    assertTuiArgv: (argv) => assert.deepEqual(argv,
      [fixtureScript, CLAUDE_TAG, ...claudeObserverFlags(argv ?? [], { ownedTmpRoot, entrypoints: hookEntrypoints })],
      "the claude-backed child sees exactly the shim's base argv plus this launch's own generated hook-only --settings pair, in order"),
  });
  await driver.waitFrame((text) => headerNamesOwner(text, "Claude")
    && nativePaneText(text).includes(`FX ${CLAUDE_TAG} HELLO pid=${claudeFixture.pid}`)
    && nativePaneText(text).includes(`FX ${CLAUDE_TAG} QUESTION`),
  "the real host displays the created native row's own terminal output under its own header");
  const claudeCard = cardFor(driver.currentText(), "Claude");
  assert.ok(claudeCard, "the native row draws its own roster card");
  // The drawn Claude cells are the launch baseline the run's OWN owner stated
  // when it bound this row to its live PTY handle and incarnation, before any
  // byte could reach the child. Their evidence is the spawn, which only the host
  // holds: no hook ran in this synthetic child, so no provider ever reported a
  // foreground, a question, or a background count here. In particular the
  // fixture's own `QUESTION` line above is terminal text this file wrote — it is
  // pane content, never native pending-input metadata, and it leaves the input
  // cell `none` because no provider question was ever observed.
  assert.equal(claudeCard.status, "agent idle | input none",
    "the claude-backed card draws the host-owned fresh-start baseline — idle with nothing pending — rather than an unknown that only a provider hook could retire");
  assert.equal(claudeCard.background, "bg tasks 0 | shells 0",
    "the same baseline states this freshly launched run's empty background set as observed zeros, never the unknown-count aggregate and never a provider's own job count");
  assert.deepEqual(claudeCard.activity, ["Ready", ""],
    "the card's two fixed activity slots contain the owner-stated Ready baseline and a blank second slot; a synthetic child that runs no hook adds no activity of its own");
  assert.ok(!`${claudeCard.status} ${claudeCard.background}`.includes(NATIVE_STATUS_NOT_APPLICABLE_TEXT),
    "a route that can report every category never gains a not-applicable claim");

  // The codex-backed fixture is the default Codex target as the production
  // OWNED pair; reaching it also proves the cycle then wraps to Pi. This host's
  // own hook preparation is declined for the owned launch: the TUI gets no
  // generated hook flag and no opt-in marker, and the backend gets neither
  // either. Its only extra TUI tokens are the lease's private remote flags.
  const codexFixture = await createNativeFixtureSession({
    driver,
    workspace: workspaceCodex,
    tag: CODEX_TAG,
    journalFile: journals[CODEX_TAG]!,
    fixtureScript,
    hostPath,
    scratchHome,
    cycles: 2,
    targetId: OFFERED_TARGETS[1].id,
    label: OFFERED_TARGETS[1].label,
    ownedCodex: true,
    tuiArgvMatches: (argv) => codexOwnedTuiArgvMatches(argv, fixtureScript, CODEX_TAG),
    assertTuiArgv: (argv) => assertCodexOwnedTuiArgv(argv, fixtureScript, CODEX_TAG),
  });
  assert.ok(codexFixture.backend, "the owned Codex row reports both of its actual processes");
  await driver.waitFrame((text) => headerNamesOwner(text, "Codex")
    && nativePaneText(text).includes(`FX ${CODEX_TAG} HELLO pid=${codexFixture.pid}`),
  "the second native row becomes the displayed owner under its own header");
  const codexCard = cardFor(driver.currentText(), "Codex");
  assert.ok(codexCard);
  // The owned route declares all five categories supported, but this synthetic
  // TUI never emitted a genuine Codex initialize or started a turn, so no fresh
  // root was ever bound. The card must therefore state unknown everywhere:
  // never the legacy N/A declaration, never a fabricated Ready, and never a
  // guessed zero.
  assert.equal(codexCard.status, "agent unknown | input unknown",
    "the owned Codex card declares every category supported and stays unknown until its own genuine source binds a root; the old legacy not-applicable input claim is gone");
  assert.equal(codexCard.background, "bg tasks unknown | shells unknown",
    "both background categories are supported-but-unobserved unknowns, never not-applicable and never guessed zeros");
  assert.deepEqual(codexCard.activity, ["", ""],
    "the card draws two empty activity slots: no owner-stated Ready baseline and no invented provider activity");
  assert.ok(!`${codexCard.status} ${codexCard.background} ${codexCard.activity.join(" ")}`.includes(NATIVE_STATUS_NOT_APPLICABLE_TEXT),
    "the owned RPC lane declares all five categories reportable, so no owned Codex cell opts out as not-applicable");
  assert.ok(!`${codexCard.status} ${codexCard.background} ${codexCard.activity.join(" ")}`.includes("Ready"),
    "no Ready claim exists before a genuine TUI source binds a fresh root");
  assert.ok(!/bg tasks 0|shells 0/u.test(codexCard.background),
    "no zero is guessed for either unobserved background category");

  // Independent ownership: four distinct OS processes across three distinct
  // workspaces, each journalling to its own file. The owned Codex row really
  // has two children: the non-TTY backend and the interactive TUI.
  const codexBackend = codexFixture.backend!;
  assert.equal(new Set([piSession.record.pid, claudeFixture.pid, codexFixture.pid, codexBackend.pid]).size, 4,
    "the real Pi child, the claude fixture, the codex TUI, and the codex backend are four distinct OS processes");
  assert.equal(claudeFixture.hello.cwd, workspaceClaude);
  assert.equal(codexFixture.hello.cwd, workspaceCodex);
  assert.equal(codexBackend.hello.cwd, workspaceCodex,
    "the codex backend and TUI share this row's selected workspace but are separate processes");
  // The PTY children and the backend are all spawned by the one real Main
  // process, so a shared parent is correct and expected. What must be
  // impossible is any fixture being another's child, so each child's own
  // reported parent is compared against the SIBLING pids rather than against
  // the other child's parent.
  assert.equal(typeof claudeFixture.hello.ppid, "number", "the claude-backed fixture reports its own parent pid");
  assert.equal(typeof codexFixture.hello.ppid, "number", "the codex TUI reports its own parent pid");
  assert.equal(typeof codexBackend.hello.ppid, "number", "the codex backend reports its own parent pid");
  for (const [owner, siblingPids] of [
    [claudeFixture.hello, [codexFixture.pid, codexBackend.pid]],
    [codexFixture.hello, [claudeFixture.pid, codexBackend.pid]],
    [codexBackend.hello, [claudeFixture.pid, codexFixture.pid]],
  ] as const) {
    for (const sibling of siblingPids) {
      assert.notEqual(owner.ppid, sibling, "no fixture is a child of another fixture in this row");
    }
  }

  // --- Addressed input: only the displayed row's real child is answered. ---
  await driver.waitFrame((text) => nativePaneText(text).includes(`FX ${CODEX_TAG} QUESTION`),
    "the displayed native row shows its own synthetic question");
  const claudeInputBeforeAnswer = countOf(readJournal(claudeFixture.journalFile), "input");
  await driver.writeAndWait(`${ANSWER}\r`, (text) => nativePaneText(text).includes(`FX ${CODEX_TAG} CONFIRMED`),
    "the synthetic prompt answer reaches the displayed native child and is echoed by that child alone");
  await untilJournal(codexFixture.journalFile,
    (records) => records.some((record) => record.type === "input" && record.line === ANSWER),
    "the answered fixture journals the exact line it received");
  assert.equal(countOf(readJournal(claudeFixture.journalFile), "input"), claudeInputBeforeAnswer,
    "the sibling fixture received no byte of the addressed answer");
  assert.equal(readJournal(codexFixture.journalFile).filter((record) => record.role === "backend" && record.type === "input").length, 0,
    "the owned non-TTY backend receives no interactive input; stdin belongs to the TUI alone");

  // --- Switch back: the retained frame, then input addressed to the other row. ---
  await driver.ensureSidebarFocus();
  await stepRosterTo(driver, "Claude");
  await activateHighlighted(driver, "Claude",
    (text) => nativePaneText(text).includes(`FX ${CLAUDE_TAG} HELLO pid=${claudeFixture.pid}`)
      && nativePaneText(text).includes(`FX ${CLAUDE_TAG} QUESTION`));
  const codexBeatsBeforeSwitch = lastBeat(readJournal(codexFixture.journalFile));
  const codexInputBeforeSwitch = countOf(readJournal(codexFixture.journalFile), "input");
  await driver.writeAndWait(`${ANSWER}\r`, (text) => nativePaneText(text).includes(`FX ${CLAUDE_TAG} CONFIRMED`),
    "the answer follows the deliberate switch to the other row's real child");
  await untilJournal(claudeFixture.journalFile,
    (records) => records.some((record) => record.type === "input" && record.line === ANSWER),
    "the newly displayed fixture journals the exact line it received");
  assert.equal(countOf(readJournal(codexFixture.journalFile), "input"), codexInputBeforeSwitch,
    "the row that is no longer displayed received no byte of this answer");
  assert.equal(readJournal(codexFixture.journalFile).filter((record) => record.role === "backend" && record.type === "input").length, 0,
    "the backend still receives no interactive input after the deliberate row switch");
  // The un-displayed sibling keeps running and keeps journalling its own
  // heartbeat while the other row is displayed and interacted with.
  await untilJournal(codexFixture.journalFile, (records) => lastBeat(records) > codexBeatsBeforeSwitch,
    "the un-displayed sibling fixture continues on its own while the other row is displayed");

  // --- One deliberate outer resize, witnessed by each child's own terminal. ---
  const claudeResizesBefore = countOf(readJournal(claudeFixture.journalFile), "resize");
  const codexResizesBefore = countOf(readJournal(codexFixture.journalFile), "resize");
  const outputBeforeResize = driver.outputRevision;
  driver.pty.resize(RESIZED_OUTER.cols, RESIZED_OUTER.rows);
  driver.surface.resize(RESIZED_OUTER.cols, RESIZED_OUTER.rows);
  await driver.waitForOuterOutput(outputBeforeResize,
    `real ProcessTerminal redraw after outer resize to ${RESIZED_OUTER.cols}x${RESIZED_OUTER.rows}`);
  await untilJournal(claudeFixture.journalFile,
    (records) => records.some((record) => record.type === "resize"
      && record.cols === RESIZED_PANE.cols && record.rows === RESIZED_PANE.rows),
    `the displayed native fixture reports its own new ${RESIZED_PANE.cols}x${RESIZED_PANE.rows} terminal`);
  assert.equal(countOf(readJournal(codexFixture.journalFile), "resize"), codexResizesBefore,
    "the un-displayed native fixture receives no resize from an outer resize");
  assert.equal(readJournal(codexFixture.journalFile).filter((record) => record.role === "backend" && record.type === "resize").length, 0,
    "the owned non-TTY backend has no terminal geometry and receives no PTY resize");

  const outputBeforeRestore = driver.outputRevision;
  driver.pty.resize(OUTER_COLS, OUTER_ROWS);
  driver.surface.resize(OUTER_COLS, OUTER_ROWS);
  await driver.waitForOuterOutput(outputBeforeRestore, "real ProcessTerminal redraw after restoring the outer size");
  await untilJournal(claudeFixture.journalFile,
    (records) => records.some((record) => record.type === "resize" && record.cols === PANE_COLS && record.rows === PANE_ROWS),
    `the displayed native fixture reports its own restored ${PANE_COLS}x${PANE_ROWS} terminal`);
  assert.equal(countOf(readJournal(codexFixture.journalFile), "resize"), codexResizesBefore,
    "restoring the outer size still resizes no un-displayed native fixture");
  assert.equal(readJournal(codexFixture.journalFile).filter((record) => record.role === "backend" && record.type === "resize").length, 0,
    "restoring the outer size still gives the non-TTY backend no PTY geometry");

  // --- One natural fixture exit: the fixture's own farewell, then real settlement. ---
  await driver.writeAndWait(`${FAREWELL}\r`, (text) => nativePaneText(text).includes(`FX ${CLAUDE_TAG} FAREWELL`),
    "the fixture ends its own session when asked in its own terminal");
  await claudeFixture.watcher.waitForExit(EVENT_TIMEOUT_MS);
  assert.equal(claudeFixture.watcher.observedExit, true,
    "the kernel exit event for the fixture-REPORTED PID was observed on the exact owned process");
  assert.equal(processIsAlive(claudeFixture.pid), false, "the settled fixture process is gone");
  await untilPtyExit(driver, claudeFixture.pid, "the manager-owned native PTY exit for the naturally exiting fixture");
  await driver.waitFrame((text) => cardFor(text, "Claude")?.status === "exited (code 0)",
    "the real sidebar restates the exited provider card with its actual exit code");
  assert.equal(processIsAlive(codexFixture.pid), true, "the sibling fixture is untouched by this exit");

  // --- One public stop confirmation for the live sibling row. ---
  await driver.ensureSidebarFocus();
  await stepRosterTo(driver, "Codex");
  const codexSignalsBefore = countOf(readJournal(codexFixture.journalFile), "signal");
  await driver.writeAndWait("d", (text) => text.includes("Stop session?"),
    "the real sidebar asks for an explicit stop confirmation for a live native row");
  assert.equal(countOf(readJournal(codexFixture.journalFile), "signal"), codexSignalsBefore,
    "the unconfirmed request signals nothing to the real child");
  assert.equal(processIsAlive(codexFixture.pid), true, "the unconfirmed request leaves the child running");
  // The confirmation is a bounded key write, never a terminal-output witness:
  // highlighting a row does not display it, so the stopped children's own
  // SIGTERM lines belong to their journals, not to the pane of the row still on
  // screen. Both owned processes of this row receive the same owned stop, and
  // each is witnessed separately by its own role label and its own exact PID.
  const afterStopConfirm = driver.frameRevision;
  await driver.writeKeys(KEYS.enter, "the confirmed stop is written to the real host");
  await untilJournal(codexFixture.journalFile,
    (records) => records.filter((record) => record.role === "tui")
      .some((record) => record.type === "signal" && record.signal === "SIGTERM"),
    "the stopped interactive TUI journals the signal it actually received");
  await untilJournal(codexFixture.journalFile,
    (records) => records.filter((record) => record.role === "backend")
      .some((record) => record.type === "signal" && record.signal === "SIGTERM"),
    "the stopped row's owned backend journals the signal it actually received");
  await codexFixture.watcher.waitForExit(EVENT_TIMEOUT_MS);
  assert.equal(codexFixture.watcher.observedExit, true,
    "the kernel exit event for the stopped TUI's exact PID was observed");
  assert.equal(processIsAlive(codexFixture.pid), false, "the stopped TUI process is gone");
  await codexBackend.watcher.waitForExit(EVENT_TIMEOUT_MS);
  assert.equal(codexBackend.watcher.observedExit, true,
    "the kernel exit event for the stopped row's exact backend PID was observed");
  assert.equal(processIsAlive(codexBackend.pid), false, "the stopped row's backend process is gone");
  await untilPtyExit(driver, codexFixture.pid, "the manager-owned native PTY exit for the stopped TUI fixture");
  assert.equal(driver.ptyExits().some((entry) => entry.type === "pty_exit" && entry.pid === codexBackend.pid), false,
    "the backend is deliberately NOT a manager-owned PTY and therefore has no PTY exit record at all");
  // A confirmed stop that ended in a positive exit removes its own row. Nothing
  // else may move: the roster must still be complete, with the real Pi row and
  // the naturally exited fixture's retained card both preserved.
  await driver.waitFrame((text) => {
    const parsed = completeRoster(text);
    if (parsed === undefined) return false;
    return !parsed.cards.some((card) => renderedTitleMatches(card.title, "Codex"))
      && parsed.cards.some((card) => renderedTitleMatches(card.title, "Claude")
        && card.status === "exited (code 0)")
      && parsed.cards.some((card) => renderedTitleMatches(card.title, piSession.displayName));
  }, "the confirmed stop removes only its own row: no Codex card remains, while the exited Claude card and the real Pi row are preserved",
  afterStopConfirm);

  // --- The real Pi row exits gracefully, then the host is quit normally. ---
  await driver.ensureSidebarFocus();
  await stepRosterTo(driver, piSession.displayName);
  // The shared exit census counts from the frame it is handed, so the real Pi
  // row is activated on a settled complete-roster frame, never a partial repaint.
  await activateHighlightedOnSettledFrame(driver, piSession.displayName);
  await driver.closeNativeNormally(piSession);

  const hostExit = await driver.finishHostNormally();
  assert.equal(hostExit.exitCode, 0, "the real public Main returned success after every owned child settled");
  assert.equal(hostExit.signal ?? 0, 0, "the outer Main PTY exited normally, not by signal cleanup");
  assert.equal(claudeFixture.watcher.observedExit, true, "every fixture's original process settled before the host Quit");
  assert.equal(codexFixture.watcher.observedExit, true, "the codex TUI's original process settled before the host Quit");
  assert.equal(codexBackend.watcher.observedExit, true, "the owned codex backend's original process settled before the host Quit");
  assert.equal(piSession.exitWatcher.observedExit, true, "the real Pi child's original process settled before the host Quit");

  state.assertionsCompleted = true;
});
