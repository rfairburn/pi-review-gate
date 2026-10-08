/**
 * Native Main owned-shell background-count acceptance (source only; the
 * orchestrating parent runs this test).
 *
 * This test is intended to prove one complete owned row lifecycle for a real background shell in
 * the real public Main API with a pinned real Pi 1.1.0 runtime and a real
 * native child:
 *
 *   known 0 shells  ->  1 live owned shell  ->  0 known shells (settled)
 *
 * The one job is a genuine bounded local service (a 127.0.0.1 loopback TCP
 * listener on an ephemeral port, see
 * tests/fixtures/session-host-background-count-job.cjs): it answers a real
 * client connection and shuts down gracefully on the SIGTERM that the public
 * ShellStop path sends. There is no sleep job, no timeout-as-work, no polling
 * wait, and no fabricated ownership or status count anywhere: every count is
 * read from the rendered native card, and the exact job handle is read from
 * the model's own ShellStart toolResult — never guessed as `job1`/latest.
 *
 * Evidence retention: this scenario performs NO filesystem deletion. The job
 * creates bounded readiness and listener-completion leaves (pid/port/status
 * JSON, 0600) exclusively inside the confined service directory and retains both; the test
 * inspects it through a bounded readonly descriptor whose observations are
 * dev/ino-identity-checked at every step (missing leaves, symlinks, swaps at
 * open or after the read, growth, in-place content changes, over-limit sizes,
 * and malformed records fail closed) and asserts the retained leaf is the same
 * byte-identical file after the normal stop. The owned scratch root is preserved
 * on success and failure alike — no cleanup entry point is called here.
 * Retention is not completion evidence. A distinct closed record is emitted
 * after the original listener closes successfully; no adopted service kernel
 * exit/code claim is made. Shell settlement additionally requires the row's
 * known zero shell count plus the exact job's `done` status in a successful
 * public ShellList result — one with explicit success metadata; a failed or
 * ambiguous result contributes no settlement rows, and conflicting provenance
 * fails closed. The ShellStop "stopping" acknowledgement — or a merely
 * retained/disappeared path — is never settlement.
 *
 * Startup-argument contract for THIS test only (the shared baseline argv is
 * untouched): Main's default `--no-tools` would keep the gate's own extension
 * tools from being callable, so this test replaces exactly that token with the
 * authoritative `--exclude-tools read,bash,edit,write,grep,find,ls`
 * restriction, keeping the same builtin discovery tools withheld while the
 * gate's ShellStart/ShellStop/ShellList tools remain registered. Whether they
 * are actually active is positively asserted from the child's own
 * `getActiveTools()` observation; nothing is assumed.
 *
 * The new provider step is opt-in (`{"stopStartedShell": true}`): it requires
 * the explicit `ShellStart` tool identity, explicit `isError === false`
 * success metadata (absent or ambiguous error/success state never becomes a
 * success), and exactly one successful result in the model context, then
 * issues ShellStop for that exact bounded id, failing loudly if the handle is
 * unavailable, partial, or ambiguous (separate results are never collapsed by
 * id). In this opted-in mode the request journal carries metadata only — no
 * user/prompt preview — and the step journals only the bounded handle and
 * numeric pid. A pure companion test in this file exercises the same
 * selection seam for repeated ids, missing/wrong tool identity, absent
 * success metadata, partial results, and the named unavailable/ambiguous
 * failure contract.
 *
 * Frame witnesses are complete, never substring-inferred: the initial welcome
 * requires the canonical header plus a complete count-0 roster plus the
 * COMPLETE sidebar-focused footer (including the final alt+right main hint);
 * creation and rename each complete with their full header/native-surface/
 * roster/footer witness before any further input; the roster activation
 * requires the latest outer geometry, the owner header, the activated native
 * card selected in a complete roster, and the Main-focused footer with no
 * stale sidebar-only hints; and the settled frame keeps that full witness
 * before native shutdown.
 *
 * Graceful native lifecycle and full outer TTY restoration are witnessed by the
 * shared harness (kernel exit for the exact owned native PID, public PTY onExit
 * with code 0 and no signal, runSessionHost return 0, alternate-screen/cursor/
 * style/raw-mode restoration). Kernel claims are scoped to the original native
 * handles actually retained; the owned job process is never adopted, scanned
 * for, or signalled by the test.
 *
 * Original runtime role/catalog aliases are refused by name — case-insensitively
 * and including empty values — before any scratch creation, compilation, or
 * native startup, so a delegated-runtime or executor-catalog marker can never
 * reach fixture mutation.
 *
 * macOS owned-PTY scoped, like the sibling native Main acceptance tests; Linux,
 * Windows, and physical-keyboard claims are out of scope. Skips without the
 * explicit runtime pins (hard-fails under PI_REVIEW_GATE_REQUIRE_PI_HOST=1).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  realpathSync,
  symlinkSync,
  watch as fsWatch,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  ChangeSignal,
  CleanupOutcome,
  EVENT_TIMEOUT_MS,
  KEYS,
  MainPtyDriver,
  OBSERVER_FIXTURE,
  OUTER_COLS,
  OUTER_ROWS,
  TEST_TIMEOUT_MS,
  type OwnedSession,
  type RuntimePin,
  compileAndStageCandidate,
  createEditorExecutable,
  createEditorLog,
  createOwnedScratchRoot,
  makeNativeAgentRoot,
  makeRuntimeEnvironment,
  makeWorkspace,
  processIsAlive,
  resolveRuntimePin,
} from "./helpers/session-host-native-main-harness";
import { hasFullWidthNativeEditorRule } from "./helpers/session-host-native-saved-main-harness";
import {
  SIDEBAR_COLUMNS,
  frameHeader,
  parseRosterFrame,
  renderedTitleMatches,
  rosterCards,
  selectedRosterCard,
  sidebarPaneLines,
  type RosterCardEntry,
} from "./helpers/session-host-native-roster-witness";

const PROVIDER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-native-provider.cjs");
const JOB_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-background-count-job.cjs");

/** Short row label so the three-row card always fits the 32-column pane. */
const ROW_LABEL = "BGT";
const JOB_LABEL = "bg-count-probe";
const PROMPT_START = "Please start the background probe service.";
const PROMPT_STOP = "Please stop the background probe service now.";
const PROMPT_LIST = "Please list the background probe service status.";

/** Builtin names withheld by the replacement restriction; never active here. */
const EXCLUDED_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
/** Gate tools this scenario really calls; their activation is asserted, not assumed. */
const REQUIRED_NATIVE_TOOLS = ["ShellStart", "ShellStop", "ShellList"] as const;
const BACKGROUND_PATTERN = /^bg tasks (unknown|\d+) \| shells (unknown|\d+)$/u;
const HANDLE_PATTERN = /^job\d{1,12}$/u;

/** Bounded metadata bounds for the confined service directory. */
const MAX_READINESS_LEAF_BYTES = 4_096;
const MAX_SERVICE_DIR_ENTRIES = 32;
const MAX_SERVICE_DIR_BYTES = 256 * 1024;

/** Main-focused sidebar footer hints (the non-mixed post-activation set). */
const MAIN_FOOTER_HINTS = ["F8 toggle", "enter open", "esc hide", "q quit"] as const;
/** Sidebar-only hints that must be absent once the activated row owns Main. */
const SIDEBAR_ONLY_FOOTER_HINTS = ["e edit name", "d stop/remove", "space expand", "alt+right main"] as const;
/**
 * Complete sidebar-focused footer hint set: every hint of the renderer's
 * sidebar-focus set, including the final `alt+right main` hint. A partial or
 * mixed footer never establishes sidebar ownership.
 */
const SIDEBAR_FOCUSED_HINTS = ["F8 toggle", "enter open", "e edit name", "d stop/remove", "esc hide", "q quit", "alt+right main"] as const;

interface StartedShellResult {
  readonly id: string;
  readonly pid: number;
}

interface ProviderFixtureModule {
  readonly startedShellResults: (messages: unknown[]) => StartedShellResult[];
  readonly selectStopHandle: (messages: unknown[]) => ({ handle: StartedShellResult } | { error: "unavailable" | "ambiguous" });
  readonly shellListStatuses: (messages: unknown[]) => Array<{ id: string; status: string }>;
}

interface ReadinessRecord {
  readonly pid: number;
  readonly port: number;
  readonly status: string;
}

interface JobFixtureModule {
  readonly readinessLeafName: string;
  readonly completionLeafName: string;
  readonly buildReadinessRecord: (pid: number, port: number) => string;
  readonly parseReadinessRecord: (text: string, expectedStatus?: "ready" | "closed") => ReadinessRecord;
  readonly validateAncestors: (dirPath: string) => boolean;
  readonly validateServiceDir: (serviceDir: string) => string;
}

const fixtureRequire = createRequire(join(process.cwd(), "package.json"));
const providerFixtureModule = fixtureRequire(PROVIDER_FIXTURE) as ProviderFixtureModule;
const jobFixtureModule = fixtureRequire(JOB_FIXTURE) as JobFixtureModule;

/** One synthetic successful ShellStart toolResult for the pure selection seam. */
function shellResult(id: string, pid: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: "toolResult",
    toolName: "ShellStart",
    isError: false,
    details: { event: "started", id, pid },
    content: [],
    ...overrides,
  };
}

interface CardCounts {
  readonly tasks: number | null;
  readonly shells: number | null;
}

/** POSIX single-quote shell quoting for a documented public ShellStart command. */
function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

function readJournalText(file: string): string {
  jobFixtureModule.validateAncestors(dirname(file));
  const before = lstatSync(file, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= 256n * 1024n,
    "the metadata-only journal is a bounded regular nonsymlink leaf");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    assert.ok(opened.isFile() && sameLeafIdentity(before, opened), "the journal descriptor matches its admitted identity");
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      assert.ok(n > 0, "the journal did not shrink while reading");
      offset += n;
    }
    assert.ok(sameLeafIdentity(opened, lstatSync(file, { bigint: true })), "the journal did not swap or resize while reading");
    return bytes.toString("utf8");
  } finally { closeSync(fd); }
}

function readJsonl(file: string): Array<Record<string, unknown>> {
  const text = readJournalText(file);
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop(); // an incomplete append is not an admitted event
  return lines.filter((line) => line.trim()).map((line) => {
    assert.ok(Buffer.byteLength(line) <= 4096, "each metadata event is bounded");
    const record: unknown = JSON.parse(line);
    assert.ok(record !== null && typeof record === "object" && !Array.isArray(record), "metadata event is a plain record");
    return record as Record<string, unknown>;
  });
}

/** The one complete native card whose rendered title belongs to `label`. */
function cardFor(text: string, label: string): RosterCardEntry | undefined {
  const matches = rosterCards(text, SIDEBAR_COLUMNS).filter((card) => renderedTitleMatches(card.title, label));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Honest counts from the card's own background row; undefined when unrendered. */
function cardCounts(text: string, label: string): CardCounts | undefined {
  const card = cardFor(text, label);
  if (!card) return undefined;
  const match = BACKGROUND_PATTERN.exec(card.background);
  if (!match) return undefined;
  return {
    tasks: match[1] === "unknown" ? null : Number(match[1]),
    shells: match[2] === "unknown" ? null : Number(match[2]),
  };
}

/** True only for the honest task count the acceptance tolerates: known 0 or unknown. */
function honestTaskCount(counts: CardCounts): boolean {
  return counts.tasks === null || counts.tasks === 0;
}

/** The sidebar pane footer text after a complete roster extent; undefined when incomplete. */
function sidebarFooterText(text: string): string | undefined {
  const parsed = parseRosterFrame(text, SIDEBAR_COLUMNS);
  if (!parsed.complete) return undefined;
  const pane = sidebarPaneLines(text, SIDEBAR_COLUMNS);
  const offset = /^\s*Sessions \(\d+\)\s*$/u.test(pane[0] ?? "") ? 0 : 1;
  return pane.slice(offset + 1 + parsed.entryEnd)
    .filter((line) => line.trim().length > 0)
    .join(" ")
    .replace(/\s+/gu, " ").trim();
}

/**
 * Complete post-activation frame witness for the exact owned row: the owner
 * header, the activated native card selected in a complete single-card roster,
 * and the Main-focused sidebar footer with no stale sidebar-only hints. A
 * stale header-only or mixed-footer frame never establishes ownership.
 */
function activatedRowFrame(text: string): boolean {
  if (frameHeader(text) !== ROW_LABEL) return false;
  const parsed = parseRosterFrame(text, SIDEBAR_COLUMNS);
  if (!parsed.complete || parsed.count !== 1) return false;
  const card = selectedRosterCard(text, SIDEBAR_COLUMNS);
  if (card === undefined || !renderedTitleMatches(card.title, ROW_LABEL)) return false;
  const footer = sidebarFooterText(text);
  if (footer === undefined) return false;
  if (footer !== "F8 toggle | enter open esc hide | q quit") return false;
  return mainFocusedFooter(text);
}

/** Complete Main-focused footer: every owner hint, no stale sidebar-only hint. */
function mainFocusedFooter(text: string): boolean {
  const footer = sidebarFooterText(text);
  if (footer === undefined) return false;
  for (const hint of MAIN_FOOTER_HINTS) {
    if (!footer.includes(hint)) return false;
  }
  for (const stale of SIDEBAR_ONLY_FOOTER_HINTS) {
    if (footer.includes(stale)) return false;
  }
  return true;
}

/**
 * Complete sidebar-focused footer witness for the current roster count: every
 * hint of the renderer's sidebar-focus set, including the final `alt+right
 * main` hint and `space expand` for a non-empty roster. A partial or mixed
 * footer never establishes sidebar ownership.
 */
function sidebarFocusedFooter(text: string): boolean {
  const parsed = parseRosterFrame(text, SIDEBAR_COLUMNS);
  if (!parsed.complete) return false;
  const footer = sidebarFooterText(text);
  if (footer === undefined) return false;
  for (const hint of SIDEBAR_FOCUSED_HINTS) {
    if (!footer.includes(hint)) return false;
  }
  if ((parsed.count ?? 0) > 0 && !footer.includes("space expand")) return false;
  return true;
}

/**
 * Complete owned-row frame after a successful New creation or host rename:
 * the active child's owner header, the complete single-card roster with that
 * card selected, and a COMPLETE focus footer — Main-focused right after a New
 * completion or sidebar-focused after an Edit completion. A partial or mixed
 * footer never establishes ownership.
 */
function sidebarOwnedFrame(text: string, expectedTitle: string): boolean {
  if (!renderedTitleMatches(frameHeader(text), expectedTitle)) return false;
  const parsed = parseRosterFrame(text, SIDEBAR_COLUMNS);
  if (!parsed.complete || parsed.count !== 1) return false;
  const card = selectedRosterCard(text, SIDEBAR_COLUMNS);
  if (card === undefined || !renderedTitleMatches(card.title, expectedTitle)) return false;
  return mainFocusedFooter(text) || sidebarFocusedFooter(text);
}

/** One stat observation of a leaf; the identity fields identify the file. */
interface LeafIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
}

/**
 * Pure identity contract: two observations identify the same unchanged leaf
 * only when dev/ino/size all agree — a swap changes the inode, growth or
 * shrinkage changes the size.
 */
function sameLeafIdentity(a: LeafIdentity, b: LeafIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size;
}

interface ReadinessInspection {
  readonly record: ReadinessRecord;
  readonly bytes: Buffer;
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * Bounded descriptor-based read-only inspection of the readiness leaf. Every
 * observation is identity-checked against the others so a swap is detected at
 * each step: the observed path (lstat), the opened descriptor (fstat), and the
 * post-read pathname (lstat) must all be the same regular nonsymlink file at
 * the same size; the admitted ancestors are revalidated first; and a second
 * read through the same descriptor rejects an in-place content change. The
 * content must parse to the exact bounded pid/port/status record. A symlink,
 * swap, over-limit size, or malformed record fails closed; the leaf itself is
 * never modified or removed. Point-in-time checks only — no atomic
 * containment claim.
 */
function inspectReadinessLeaf(leafPath: string, expectedStatus: "ready" | "closed" = "ready"): ReadinessInspection {
  jobFixtureModule.validateAncestors(dirname(leafPath)); // revalidate admitted ancestors
  const observed = lstatSync(leafPath, { bigint: true });
  assert.ok(observed.isFile() && !observed.isSymbolicLink(), "the readiness leaf is a regular nonsymlink file");
  // A regular-file observation can be swapped for a FIFO before opening.
  // Never block before the descriptor type and identity checks can reject it:
  // O_NONBLOCK leaves regular-file reads unchanged, while a FIFO opens without
  // waiting for a writer and is refused by the fstat regular-file check.
  const fd = openSync(leafPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(fd, { bigint: true });
    assert.ok(stats.isFile(), "the opened readiness descriptor is a regular file");
    assert.ok(sameLeafIdentity(observed, stats), "the descriptor matches the observed leaf (no swap at open)");
    assert.ok(stats.size <= BigInt(MAX_READINESS_LEAF_BYTES), "the readiness leaf stays within its byte bound");
    const readAll = (): Buffer => {
      const chunks: Buffer[] = [];
      let offset = 0n;
      while (offset < stats.size) {
        const remaining = stats.size - offset;
        const chunk = Buffer.alloc(remaining < 4_096n ? Number(remaining) : 4_096);
        const bytesRead = readSync(fd, chunk, 0, chunk.length, Number(offset));
        if (bytesRead === 0) throw new Error("the readiness leaf shrank below its observed size (swap)");
        chunks.push(chunk.subarray(0, bytesRead));
        offset += BigInt(bytesRead);
      }
      return Buffer.concat(chunks);
    };
    const bytes = readAll();
    // The pathname must still identify the same file at the same size after
    // the read: a swap or growth in between is rejected.
    const after = lstatSync(leafPath, { bigint: true });
    assert.ok(sameLeafIdentity(stats, after), "the readiness leaf was not swapped or resized while reading");
    // A second read through the same descriptor rejects an in-place content
    // change (same inode and size, different bytes).
    assert.deepEqual(readAll(), bytes, "the readiness leaf content did not change while reading");
    const record = jobFixtureModule.parseReadinessRecord(bytes.toString("utf8"), expectedStatus);
    return { record, bytes, dev: stats.dev, ino: stats.ino };
  } finally {
    closeSync(fd);
  }
}

/**
 * Bounded containment witness for the confined service directory: this
 * lifecycle-leaf architecture admits only the expected regular nonsymlink
 * ready/closed files for the current phase — and nothing else. Unexpected entries,
 * symlinks, and nested trees are refused rather than traversed; the file
 * count and aggregate bytes stay within their bounds (BigInt stats).
 * Point-in-time only — no atomic containment claim against later swaps.
 */
function inspectServiceDir(dirPath: string, expectedNames = [jobFixtureModule.readinessLeafName]): void {
  const handle = opendirSync(dirPath);
  try {
    let files = 0;
    let totalBytes = 0n;
    for (;;) {
      const entry = handle.readSync();
      if (entry === null) break;
      assert.ok(files < MAX_SERVICE_DIR_ENTRIES, "the confined service directory stays within its file bound");
      const stats = lstatSync(join(dirPath, entry.name), { bigint: true });
      assert.ok(!stats.isSymbolicLink(), `the service directory entry ${entry.name} is not a symlink`);
      assert.ok(stats.isFile(), `the service directory entry ${entry.name} is a regular file, never a nested tree`);
      assert.ok(expectedNames.includes(entry.name),
        "the confined service directory holds only admitted bounded lifecycle leaves");
      files += 1;
      totalBytes += stats.size;
    }
    assert.equal(files, expectedNames.length, "the confined service directory holds exactly the admitted lifecycle leaves");
    assert.ok(totalBytes <= BigInt(MAX_SERVICE_DIR_BYTES), "the confined service directory stays within its aggregate byte bound");
  } finally {
    handle.close();
  }
}

/** One bounded loopback client connection to the owned job service. */
function connectOnce(port: number, timeoutMs: number): Promise<{ pid: number; port: number; served: number }> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: "127.0.0.1", port });
    let buffer = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, value?: { pid: number; port: number; served: number }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket.destroy(); } catch { /* this test-owned client socket only */ }
      if (error) reject(error);
      else resolve(value!);
    };
    timer = setTimeout(() => finish(new Error("the owned job service did not answer before its deadline")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(buffer) + Buffer.byteLength(chunk) > 4096) { finish(new Error("service answer exceeded its bound")); return; }
      buffer += chunk.toString("utf8");
    });
    socket.on("error", (error) => finish(new Error(`the owned job service connection failed: ${error.message}`)));
    socket.on("end", () => {
      let parsed: { pid?: unknown; port?: unknown; served?: unknown };
      try {
        parsed = JSON.parse(buffer.trim()) as { pid?: unknown; port?: unknown; served?: unknown };
      } catch {
        finish(new Error("the owned job service answer was not bounded JSON"));
        return;
      }
      if (!Number.isSafeInteger(parsed.pid) || (parsed.pid as number) <= 0
        || !Number.isSafeInteger(parsed.port) || (parsed.port as number) < 1 || (parsed.port as number) > 65_535
        || !Number.isSafeInteger(parsed.served) || (parsed.served as number) < 1 || (parsed.served as number) > 64) {
        finish(new Error("the owned job service answered without a bounded pid/port/served triple"));
        return;
      }
      finish(undefined, { pid: parsed.pid as number, port: parsed.port as number, served: parsed.served as number });
    });
  });
}

interface CaseState {
  scratch: string;
  driver?: MainPtyDriver;
  closeProviderWatch?: () => void;
  /** True only after every scenario assertion, including exit/restore. */
  assertionsCompleted?: boolean;
}

function registerCaseCleanup(t: { after(fn: () => Promise<void>): void }, state: CaseState): void {
  t.after(async () => {
    let cleanup: CleanupOutcome | undefined;
    if (state.driver) {
      const driver = state.driver;
      if (!state.assertionsCompleted) {
        // Only original, already-associated owners are eligible for cleanup.
        // Never use helpers that stop every observer before uncertain exits settle.
        let owners: OwnedSession[] = [];
        try { owners = driver.ownedSessions(); } catch { /* preserve uncertain associations */ }
        for (const owner of owners) {
          if (!owner.exitWatcher.observedExit) {
            try { await driver.closeNativeNormally(owner); } catch { /* original owner remains observed */ }
          }
        }
        try {
          if (driver.cleanupStatus().childrenExited && !driver.cleanupStatus().hostExited) await driver.finishHostNormally();
        } catch { /* no restoration claim from failed normal cleanup */ }
        if (!driver.cleanupStatus().hostExited) {
          try { await driver.stopOwnedOuterPty(); } catch { /* only original retained outer handle */ }
        }
        for (const owner of owners) {
          try { await owner.exitWatcher.waitForExit(3000); } catch { /* retain unsettled original observer */ }
        }
      }
      cleanup = driver.cleanupStatus();
      if (cleanup.childrenExited && cleanup.hostExited) {
        await driver.stopNativeExitWatchers();
        driver.dispose();
      } // otherwise retain subscriptions/surface/original observers, without adoption
    }
    const cleanupConfirmed = cleanup?.childrenExited === true
      && cleanup.shutdownEventsObserved
      && cleanup.gracefulHostExit
      && !cleanup.forced;
    // This scenario retains every readiness/state witness on success and
    // failure: no filesystem deletion or compatibility cleanup call is made,
    // and root creation alone never authorizes recursive removal.
    const status = cleanup
      ? `childrenExited=${cleanup.childrenExited} shutdownEvents=${cleanup.shutdownEventsObserved} hostExited=${cleanup.hostExited} gracefulHostExit=${cleanup.gracefulHostExit} forced=${cleanup.forced}`
      : "cleanup status unavailable";
    process.stderr.write(`retained owned Main scratch ${state.scratch}; assertionsCompleted=${state.assertionsCompleted === true}; cleanupConfirmed=${cleanupConfirmed}; ${status}\n`);
    if (!state.driver || (cleanup?.childrenExited && cleanup.hostExited)) {
      try { state.closeProviderWatch?.(); } catch { /* settled fixture-state watcher only */ }
    }
  });
}

function assertOriginalEnvironmentAdmissible(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (upper === "PI_REVIEW_GATE_RUNTIME_ROLE" || upper === "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG") {
      throw new Error(`native background-count acceptance refuses a role/catalog marker: ${name}`);
    }
  }
}

test("native background counts refuses original role/catalog aliases without fixture mutation", () => {
  assert.doesNotThrow(() => assertOriginalEnvironmentAdmissible({ NODE_OPTIONS: "--trace-warnings" }));
  for (const name of [
    "PI_REVIEW_GATE_RUNTIME_ROLE",
    "pi_review_gate_runtime_role",
    "Pi_Review_Gate_Runtime_Role",
    "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG",
    "pi_review_gate_executor_tool_catalog",
    "Pi_Review_Gate_Executor_Tool_Catalog",
  ]) {
    for (const value of ["", "executor"]) {
      assert.throws(() => assertOriginalEnvironmentAdmissible({ [name]: value }), /role\/catalog marker/u);
    }
  }
});

test("real native Main reports one owned shell 0 to 1 to 0 in a single card and releases it through an exact-handle ShellStop", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  assertOriginalEnvironmentAdmissible(process.env);
  const runtime: RuntimePin | undefined = resolveRuntimePin(t);
  if (!runtime) return;

  const scratch = createOwnedScratchRoot();
  const state: CaseState = { scratch };
  registerCaseCleanup(t, state);

  const workspace = makeWorkspace(scratch, "workspace-bg");
  // Existing shared native-agent fixture with gate tools launch-active; the
  // production config default is unchanged.
  const nativeAgentDir = makeNativeAgentRoot(scratch, { deferredPiTools: false });
  const editorTarget = join(workspace, "editor-target");
  mkdirSync(editorTarget, { mode: 0o700 });
  const observerFile = join(scratch, "observer", "native-main.jsonl");
  const editorLog = createEditorLog(scratch);
  const editor = createEditorExecutable(scratch, editorTarget, editorLog);
  const candidate = compileAndStageCandidate(scratch);

  // The scripted provider's own state (turn script + generic handle/status journal).
  const stateDir = join(scratch, "fixture-state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const providerJournalFile = join(stateDir, "provider-journal.jsonl");
  // Exclusively pre-create the fixture's private journal as an inert 0600 leaf
  // so the fixture only ever appends to a test-owned file. It is retained on
  // both success and failure; the evidence stays bounded to bounded metadata.
  writeFileSync(providerJournalFile, "", { flag: "wx", mode: 0o600 });

  // The one service leg is a short directory inside the owned scratch root's
  // confined temporary leg. The job binds a 127.0.0.1 loopback TCP listener
  // (no filesystem socket leaf) and creates its single readiness leaf here.
  const serviceDir = join(scratch, "tmp", "bg-service");
  mkdirSync(serviceDir, { recursive: true, mode: 0o700 });
  const readyPath = join(serviceDir, jobFixtureModule.readinessLeafName);
  const completionPath = join(serviceDir, jobFixtureModule.completionLeafName);
  assert.equal(existsSync(readyPath), false, "the owned job's readiness leaf does not pre-exist");
  // Point-in-time containment and the fixture's own path-safety contract.
  assert.ok(realpathSync(serviceDir).startsWith(`${scratch}${sep}`),
    "the confined service directory stays under the owned scratch root");
  assert.doesNotThrow(() => jobFixtureModule.validateServiceDir(serviceDir),
    "the fixture's own path-safety contract admits the confined service directory");

  // The model's ShellStart command is a plain documented platform-shell command:
  // the trusted canonical regular nonsymlink Node executable plus the canonical
  // tracked fixture. No shell substitution, probe binary, sleep, or timer.
  const nodeExecutable = realpathSync(process.execPath);
  assert.ok(lstatSync(nodeExecutable).isFile(), "the trusted Node executable is a canonical regular nonsymlink file");
  const jobFixturePath = realpathSync(JOB_FIXTURE);
  assert.ok(lstatSync(jobFixturePath).isFile(), "the tracked background-count job fixture is a regular nonsymlink file");
  const command = `${shellQuote(nodeExecutable)} ${shellQuote(jobFixturePath)}`;
  writeFileSync(join(stateDir, "turn-script.json"), JSON.stringify({
    steps: [
      // Run 1: start the real service job and end the turn with the job live.
      {
        toolCalls: [{
          toolName: "ShellStart",
          arguments: { command, label: JOB_LABEL, wake_on: { exit: false } },
        }],
      },
      { text: "probe service started" },
      // Run 2 (driven by the test host's own stop prompt): read the exact
      // ShellStart handle from context and stop that exact job.
      { stopStartedShell: true },
      { text: "probe service stop requested" },
      // Run 3 (driven by the test host's own list prompt): public ShellList
      // corroboration of the exact settled job's status.
      { toolCalls: [{ toolName: "ShellList", arguments: {} }] },
      { text: "probe service listed" },
    ],
  }), { flag: "wx", mode: 0o600 });

  const startEnv = makeRuntimeEnvironment(scratch, runtime, editor, observerFile, editorLog, "", nativeAgentDir);
  startEnv.PRG_FIXTURE_AGENT_DIR = runtime.agentDir;
  startEnv.PRG_FIXTURE_STATE_DIR = stateDir;
  startEnv.PRG_FIXTURE_JOURNAL_SHELL_STATUS = "1";
  startEnv.PRG_BG_COUNT_JOB_SERVICE_DIR = serviceDir;
  assert.deepEqual(Object.keys(startEnv).filter((name) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i.test(name)), [],
    "the synthetic native child environment contains no external credentials");

  // THIS test's only argv override: retain offline/no-context/no-theme and the
  // observer/provider extensions, and replace the shared `--no-tools` token
  // with the authoritative builtin exclusion so the gate's own tools stay
  // registered. The existing default argv is untouched.
  const args = [
    "--offline",
    "--no-context-files",
    "--no-themes",
    "--exclude-tools",
    EXCLUDED_BUILTIN_TOOLS.join(","),
    "--extension",
    OBSERVER_FIXTURE,
    "--extension",
    PROVIDER_FIXTURE,
  ];
  assert.equal(args.includes("--no-tools"), false, "the new acceptance replaces only the --no-tools token");

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

  const assertLatestGeometry = (where: string): void => {
    assert.equal(driver.surface.frame().cols, OUTER_COLS, `${where}: latest outer geometry cols`);
    assert.equal(driver.surface.frame().rows, OUTER_ROWS, `${where}: latest outer geometry rows`);
  };

  // Complete initial welcome witness: the canonical header, a complete
  // count-0 roster, and the COMPLETE sidebar-focused footer (including the
  // final alt+right main hint) — never a partial Welcome/New/Quit substring
  // inference.
  await driver.waitFrame((text) => frameHeader(text) === "Session host"
    && parseRosterFrame(text, SIDEBAR_COLUMNS).complete
    && parseRosterFrame(text, SIDEBAR_COLUMNS).count === 0
    && sidebarFocusedFooter(text),
    "fresh real Main completely paints its canonical header, count-0 roster, and complete sidebar-focused footer before the first key");
  assertLatestGeometry("fresh welcome");

  const session: OwnedSession = await driver.createNativeSession(workspace);
  assert.equal(session.record.displayName, "(no messages)", "the fresh native conversation uses Pi's real no-messages fallback");
  // Complete post-creation frame guard before any further input: the shared
  // harness may return on a selected-card predicate while the footer repaint
  // is still in flight.
  await driver.waitFrame((text) => sidebarOwnedFrame(text, "(no messages)"),
    "creation completes with its full header/native-surface/roster/footer witness before any further input");
  assertLatestGeometry("post-creation");
  await driver.renameNativeSession(session, ROW_LABEL);
  assert.equal(session.currentName, ROW_LABEL, "the exact short row label is persisted through the real host Edit form");
  // Complete post-rename frame guard before any further input.
  await driver.waitFrame((text) => sidebarOwnedFrame(text, ROW_LABEL),
    "rename completes with its full header/native-surface/roster/footer witness before any further input");
  assertLatestGeometry("post-rename");
  assert.equal(session.record.tty, true, "the native child owns a real PTY");
  assert.deepEqual(session.record.credentialLikeEnvironmentNames, [],
    "the native process inherited no credential-like environment variables");

  // Positive registry availability: ShellStart/ShellStop/ShellList must be
  // launch-active, and the withheld builtin names must be absent. Nothing is
  // inferred from the absence of a failure.
  const activeTools = session.record.activeTools;
  assert.ok(Array.isArray(activeTools), "the child's real getActiveTools() observation was recorded");
  for (const name of REQUIRED_NATIVE_TOOLS) {
    assert.ok(activeTools!.includes(name), `the real native tool registry has ${name} launch-active`);
  }
  for (const name of EXCLUDED_BUILTIN_TOOLS) {
    assert.equal(activeTools!.includes(name), false, `the replacement restriction keeps builtin ${name} out of the active set`);
  }

  // The real provider auto-selects its scripted model on session start; wait for
  // that observed selection before submitting any turn.
  const providerSignal = new ChangeSignal();
  const providerWatch = fsWatch(stateDir, (_event, filename) => {
    if (filename === null || filename.toString() === "provider-journal.jsonl") providerSignal.notify();
  });
  state.closeProviderWatch = () => providerWatch.close();
  const waitForProvider = (predicate: (records: Array<Record<string, unknown>>) => boolean, description: string): Promise<void> =>
    providerSignal.waitFor(() => predicate(readJsonl(providerJournalFile)), EVENT_TIMEOUT_MS, description);
  await waitForProvider((records) => records.some((record) => record.event === "auto_model_selected"),
    "the scripted provider auto-selects its model in the real native child");

  const settledCount = (): number => driver.records()
    .filter((record) => record.type === "agent_settled" && record.pid === session.record.pid).length;
  const toolCallCount = (name: string): number => driver.records()
    .filter((record) => record.type === "tool_call" && record.toolName === name && record.pid === session.record.pid).length;
  const waitForSettled = (before: number, description: string): Promise<unknown> => driver.waitForRecords(
    (records) => records.filter((record) => record.type === "agent_settled" && record.pid === session.record.pid).length > before,
    description,
  );

  // 1. Known zero before any job exists, in the exact owned row's complete card.
  await driver.waitFrame((text) => {
    const counts = cardCounts(text, ROW_LABEL);
    return counts !== undefined && counts.shells === 0 && honestTaskCount(counts);
  }, "the exact owned row publishes a complete card with a known zero shell count before any job starts");
  const beforeCounts = cardCounts(driver.currentText(), ROW_LABEL);
  assert.ok(beforeCounts && beforeCounts.shells === 0, "the pre-job shell count is an observed known 0, never inferred");

  // Watch the confined service directory BEFORE the job can start so its
  // readiness leaf arrives as a real filesystem event rather than a poll.
  const readySignal = new ChangeSignal();
  const serviceWatch = fsWatch(serviceDir, () => { readySignal.notify(); });
  try {
    await driver.activateRoster(ROW_LABEL);
    // Complete activation witness: the latest outer geometry, the owner
    // header, the activated native card selected in a complete roster, and the
    // Main-focused footer with no stale sidebar-only hints. A stale
    // header-only or mixed-footer frame never establishes ownership.
    await driver.waitFrame((text) => activatedRowFrame(text)
      && hasFullWidthNativeEditorRule(text, OUTER_COLS - SIDEBAR_COLUMNS - 1),
      "activation completes with its full current-width native editor and owner/footer witness");
    assertLatestGeometry("post-activation");

    const beforeStart = settledCount();
    await driver.writeAndWait(PROMPT_START, (text) => text.includes(PROMPT_START),
      "the start prompt is typed into the real native editor");
    await driver.writeKeys(KEYS.enter, "the start prompt is submitted to the real native child");

    // The model's real ShellStart tool call runs the tracked fixture; the row
    // must report exactly one live owned shell while that job is up.
    await driver.waitFrame((text) => {
      const counts = cardCounts(text, ROW_LABEL);
      return counts !== undefined && counts.shells === 1 && honestTaskCount(counts);
    }, "the exact owned row reports exactly one live owned shell while the real service job runs");
    assert.equal(cardCounts(driver.currentText(), ROW_LABEL)?.shells, 1,
      "shells is a known 1 only while the real job is live");
    assert.ok(toolCallCount("ShellStart") >= 1,
      "the real native child dispatched the public ShellStart tool call that owns the live shell");

    // 2. Genuine service corroboration: wait for the listener's own readiness
    // event, inspect the leaf through a bounded readonly descriptor, then make
    // one real bounded loopback client connection and read its answer.
    await readySignal.waitFor(() => existsSync(readyPath), EVENT_TIMEOUT_MS,
      "the owned job listener publishes its readiness leaf");
    const initialInspection = inspectReadinessLeaf(readyPath);
    const readiness = initialInspection.record;
    assert.ok(Number.isSafeInteger(readiness.pid) && readiness.pid > 0,
      "the readiness leaf carries the job's own bounded pid");
    assert.ok(Number.isSafeInteger(readiness.port) && readiness.port >= 1 && readiness.port <= 65_535,
      "the readiness leaf carries a bounded loopback port");
    inspectServiceDir(serviceDir);
    const answer = await connectOnce(readiness.port, EVENT_TIMEOUT_MS);
    assert.equal(answer.served, 1, "the owned job service answered the one real client connection");
    assert.equal(answer.pid, readiness.pid,
      "the listener really served from the pid its own readiness leaf published");
    assert.equal(answer.port, readiness.port,
      "the listener really served on the port its own readiness leaf published");

    await waitForSettled(beforeStart, "the first scripted ShellStart turn settles with the job still live");
    await driver.waitFrame((text) => activatedRowFrame(text)
      && hasFullWidthNativeEditorRule(text, OUTER_COLS - SIDEBAR_COLUMNS - 1) && text.includes("probe service started"),
      "the start turn fully restores the current native editor and owner/footer before the stop prompt");
    assert.equal(processIsAlive(session.record.pid), true, "the native child stays live across the background start turn");

    // 3. Stop through the exact returned handle only.
    const beforeStop = settledCount();
    await driver.writeAndWait(PROMPT_STOP, (text) => text.includes(PROMPT_STOP),
      "the stop prompt is typed into the real native editor");
    await driver.writeKeys(KEYS.enter, "the stop prompt is submitted to the real native child");
    await waitForProvider((records) => records.some((record) => record.event === "shell_handle_selected"),
      "the opt-in provider step read the exact ShellStart result and issued ShellStop");
    const handleRecord = readJsonl(providerJournalFile).find((record) => record.event === "shell_handle_selected");
    assert.ok(handleRecord, "the exact handle selection is journaled");
    assert.match(String(handleRecord.handle ?? ""), HANDLE_PATTERN,
      "the selected handle is the exact bounded public job id returned by ShellStart");
    assert.ok(Number.isSafeInteger(handleRecord.pid) && (handleRecord.pid as number) > 0,
      "the selected handle carries the exact bounded numeric pid from the ShellStart result");
    const handle = String(handleRecord.handle);
    await waitForSettled(beforeStop, "the exact-handle stop turn settles");
    assert.ok(toolCallCount("ShellStop") >= 1,
      "the real native child dispatched the public ShellStop tool call for the exact handle");

    // The ShellStop acknowledgement is NOT settlement: wait for the row's own
    // shell count to return to a known zero.
    await driver.waitFrame((text) => {
      const counts = cardCounts(text, ROW_LABEL);
      return counts !== undefined && counts.shells === 0 && honestTaskCount(counts);
    }, "the exact owned row returns to a known zero shell count after the real stop");
    assert.equal(cardCounts(driver.currentText(), ROW_LABEL)?.shells, 0,
      "the settled shell count is a known 0, not a 'stopping' acknowledgement");
    // Readiness retention is NOT shutdown/completion evidence. Require a new
    // exclusive bounded record emitted only AFTER the original listener's close
    // callback succeeds. This proves real service-handle completion, not a
    // kernel exit/code claim for an adopted service PID. Public shell `done`
    // after SIGTERM can map a signalled wrapper's null exit code to zero.
    await readySignal.waitFor(() => existsSync(completionPath), EVENT_TIMEOUT_MS,
      "the original owned service listener positively closes before completion evidence is published");
    const completed = inspectReadinessLeaf(completionPath, "closed");
    assert.equal(completed.record.pid, readiness.pid, "completion belongs to the same original service binding");
    assert.equal(completed.record.port, readiness.port, "completion belongs to the exact original listener");
    inspectServiceDir(serviceDir, [jobFixtureModule.readinessLeafName, jobFixtureModule.completionLeafName]);
    assert.equal(existsSync(readyPath), true, "the gracefully stopped job retained its readiness leaf");
    const retained = inspectReadinessLeaf(readyPath);
    assert.deepEqual(retained.bytes, initialInspection.bytes,
      "the retained readiness leaf is byte-identical after the normal stop");
    assert.equal(retained.dev, initialInspection.dev, "the retained readiness leaf keeps its device identity (no recreation)");
    assert.equal(retained.ino, initialInspection.ino, "the retained readiness leaf keeps its inode identity (no swap)");
    assert.equal(processIsAlive(session.record.pid), true, "stopping the job never stops the owning native child");

    // 4. Corroborate the exact job's completion through a public ShellList
    // result: only the extension's confirmed settlement reports `done`.
    await driver.waitFrame((text) => activatedRowFrame(text)
      && hasFullWidthNativeEditorRule(text, OUTER_COLS - SIDEBAR_COLUMNS - 1) && text.includes("probe service stop requested"),
      "the stop turn restores the complete native editor before the list prompt");
    const beforeList = settledCount();
    await driver.writeAndWait(PROMPT_LIST, (text) => text.includes(PROMPT_LIST),
      "the list prompt is typed into the real native editor");
    await driver.writeKeys(KEYS.enter, "the list prompt is submitted to the real native child");
    await waitForProvider((records) => records.some((record) => {
      if (record.event !== "shell_list_status" || !Array.isArray(record.jobs)) return false;
      return (record.jobs as Array<{ id?: unknown; status?: unknown }>)
        .some((job) => job.id === handle && job.status === "done");
    }), "the public ShellList result reports the exact job as done");
    await waitForSettled(beforeList, "the list turn settles");
    assert.ok(toolCallCount("ShellList") >= 1,
      "the real native child dispatched the public ShellList tool call that corroborated the exact job");
    assert.equal(cardCounts(driver.currentText(), ROW_LABEL)?.shells, 0,
      "the row's known zero shell count is unchanged after the corroborating ShellList");

    // The opted-in journal is metadata-only: no request preview field and no
    // submitted prompt text may appear anywhere in it.
    const journalText = readJournalText(providerJournalFile);
    assert.equal(journalText.includes("lastUserPreview"), false,
      "the opted-in background-count journal carries no user/prompt preview field");
    for (const prompt of [PROMPT_START, PROMPT_STOP, PROMPT_LIST]) {
      assert.equal(journalText.includes(prompt), false,
        "the opted-in background-count journal never captures a submitted prompt");
    }

    // Complete settled-frame guard before native shutdown: the frame still
    // carries its full owner/native/footer witness, not a stale repaint.
    await driver.waitFrame((text) => activatedRowFrame(text)
      && hasFullWidthNativeEditorRule(text, OUTER_COLS - SIDEBAR_COLUMNS - 1) && text.includes("probe service listed"),
      "the settled frame keeps its full-width native editor and complete owner/footer before shutdown");
    assertLatestGeometry("pre-shutdown");

    // Orderly native lifecycle and full outer restoration.
    await driver.closeNativeNormally(session);
    assert.ok(driver.records().some((record) => record.type === "session_shutdown" && record.pid === session.record.pid),
      "the public native session_shutdown lifecycle ran for the owned child");
    const hostExit = await driver.finishHostNormally();
    assert.equal(hostExit.signal ?? 0, 0, "the public Main returned normally after the owned native child had exited");
    state.assertionsCompleted = true;
  } finally {
    serviceWatch.close();
  }
});

test("the opt-in stop step accepts only one explicitly identified successful ShellStart result", () => {
  const started = providerFixtureModule.startedShellResults;
  assert.equal(typeof started, "function",
    "the tracked provider fixture exposes the pure selection seam used by the live step");

  assert.deepEqual(started([shellResult("job7", 4242)]), [{ id: "job7", pid: 4242 }]);

  // Repeated ids with different pids are two separate results, never collapsed
  // into one accepted handle (job ids can repeat after an extension reload).
  assert.equal(started([shellResult("job7", 111), shellResult("job7", 222)]).length, 2,
    "same-id results stay distinct so the step can reject the ambiguity");

  // Distinct ids are equally ambiguous for a single-step selection.
  assert.equal(started([shellResult("job7", 111), shellResult("job8", 222)]).length, 2);

  // The explicit ShellStart tool identity is required provenance.
  assert.deepEqual(started([{ ...shellResult("job7", 111), toolName: undefined }]), []);
  assert.deepEqual(started([{ ...shellResult("job7", 111), toolName: "ShellList" }]), []);
  assert.deepEqual(started([{ ...shellResult("job7", 111), toolName: "shellstart" }]), []);

  // A failed result is never an accepted handle.
  assert.deepEqual(started([{ ...shellResult("job7", 111), isError: true }]), []);

  // Absent error/success metadata is not explicit success and never becomes a
  // handle: only `isError === false` is admitted.
  assert.deepEqual(started([{ ...shellResult("job7", 111), isError: undefined }]), []);

  // A partial result (id with no valid bounded pid) is not a usable handle.
  assert.deepEqual(started([shellResult("job7", 111, { details: { event: "started", id: "job7" } })]), []);

  // The exact documented result text is the only fallback source.
  assert.deepEqual(started([{
    role: "toolResult",
    toolName: "ShellStart",
    isError: false,
    content: [{ type: "text", text: 'Started "probe" as job12 (pid 3456); currently running.' }],
  }]), [{ id: "job12", pid: 3456 }]);

  // A malformed text pid is rejected rather than guessed.
  assert.deepEqual(started([{
    role: "toolResult",
    toolName: "ShellStart",
    isError: false,
    content: [{ type: "text", text: 'Started "probe" as job12 (pid ?); currently running.' }],
  }]), []);

  // The named failure contract: zero results are unavailable, more than one
  // is ambiguous, and exactly one is the exact handle — never a guess.
  const select = providerFixtureModule.selectStopHandle;
  assert.deepEqual(select([shellResult("job7", 4242)]), { handle: { id: "job7", pid: 4242 } });
  assert.deepEqual(select([]), { error: "unavailable" });
  assert.deepEqual(select([{ ...shellResult("job7", 111), isError: undefined }]), { error: "unavailable" });
  assert.deepEqual(select([shellResult("job7", 111), shellResult("job7", 222)]), { error: "ambiguous" });
  assert.deepEqual(select([shellResult("job7", 111), shellResult("job8", 222)]), { error: "ambiguous" });
});

test("ShellList settlement rows require explicit success metadata and fail closed on conflict", () => {
  const rows = providerFixtureModule.shellListStatuses;
  assert.equal(typeof rows, "function",
    "the tracked provider fixture exposes the pure ShellList selection seam used by the live journaling");

  // Explicit success metadata admits the bounded rows.
  assert.deepEqual(rows([{ role: "toolResult", toolName: "ShellList", isError: false, details: { jobs: [{ id: "job1", status: "done" }] } }]),
    [{ id: "job1", status: "done" }]);

  // A failed result contributes no rows: a matching done row can never settle
  // from an unsuccessful ShellList.
  assert.deepEqual(rows([{ role: "toolResult", toolName: "ShellList", isError: true, details: { jobs: [{ id: "job1", status: "done" }] } }]), []);

  // Absent success metadata is ambiguous and contributes no rows.
  assert.deepEqual(rows([{ role: "toolResult", toolName: "ShellList", details: { jobs: [{ id: "job1", status: "done" }] } }]), []);

  // Conflicting provenance across admitted results fails closed for that id.
  assert.deepEqual(rows([
    { role: "toolResult", toolName: "ShellList", isError: false, details: { jobs: [{ id: "job1", status: "running" }] } },
    { role: "toolResult", toolName: "ShellList", isError: false, details: { jobs: [{ id: "job1", status: "done" }] } },
  ]), []);

  // Agreed provenance across admitted results is still the one row.
  assert.deepEqual(rows([
    { role: "toolResult", toolName: "ShellList", isError: false, details: { jobs: [{ id: "job1", status: "done" }] } },
    { role: "toolResult", toolName: "ShellList", isError: false, details: { jobs: [{ id: "job1", status: "done" }] } },
  ]), [{ id: "job1", status: "done" }]);
});

test("the background-count job fixture retains its evidence and exposes bounded pure seams", () => {
  const build = jobFixtureModule.buildReadinessRecord;
  const parse = jobFixtureModule.parseReadinessRecord;

  // Exact bounded record grammar: numeric pid/port plus the generic status.
  assert.deepEqual(parse(build(4242, 31337)), { pid: 4242, port: 31337, status: "ready" });
  const closed = '{"pid":4242,"port":31337,"status":"closed"}';
  assert.deepEqual(parse(closed, "closed"), { pid: 4242, port: 31337, status: "closed" });
  assert.throws(() => parse(closed), /status/u, "completion is never accepted as initial readiness");
  assert.throws(() => parse(build(4242, 31337), "closed"), /status/u, "old readiness is never accepted as completion");

  // Over-limit, malformed, or extra-field records are rejected, never guessed.
  for (const bad of [
    "",
    "not json",
    '{"pid":4242,"port":31337}',                        // missing generic status
    '{"pid":4242,"port":31337,"status":"ready","x":1}', // extra field
    '{"pid":0,"port":31337,"status":"ready"}',          // unbounded pid
    '{"pid":-4,"port":31337,"status":"ready"}',         // negative pid
    '{"pid":4242,"port":0,"status":"ready"}',           // unbounded port
    '{"pid":4242,"port":70000,"status":"ready"}',       // port out of range
    '{"pid":4.5,"port":31337,"status":"ready"}',        // non-integer pid
    '{"pid":4242,"port":31337,"status":"running"}',     // non-generic status
  ]) {
    assert.throws(() => parse(bad), /readiness record/u, `readiness record rejected: ${bad}`);
  }

  // The tracked fixture performs no filesystem deletion anywhere: the
  // readiness/state evidence is retained by construction.
  const source = readFileSync(JOB_FIXTURE, "utf8");
  for (const forbidden of ["unlinkSync", "rmSync", "rmdirSync", "fs.rm(", "fs.unlink("]) {
    assert.equal(source.includes(forbidden), false, `the job fixture contains no ${forbidden} deletion call`);
  }
});

test("readiness leaf inspection fails closed on missing leaves, symlinks, growth, and malformed records", () => {
  assertOriginalEnvironmentAdmissible(process.env); // guard before any fixture mutation
  const tmpParent = realpathSync(tmpdir()); // canonical parent (macOS /var is a symlink)
  jobFixtureModule.validateAncestors(tmpParent);
  const root = mkdtempSync(join(tmpParent, "prg-bg-count-leaf-"));
  const dir = join(root, "leaf-case");
  mkdirSync(dir, { mode: 0o700 });

  // A missing leaf is refused.
  assert.throws(() => inspectReadinessLeaf(join(dir, jobFixtureModule.readinessLeafName)), /no such file/u);

  // A valid leaf is admitted with its bounded bytes and identity.
  const leaf = join(dir, jobFixtureModule.readinessLeafName);
  writeFileSync(leaf, jobFixtureModule.buildReadinessRecord(4242, 31337), { flag: "wx", mode: 0o600 });
  const admitted = inspectReadinessLeaf(leaf);
  assert.deepEqual(admitted.record, { pid: 4242, port: 31337, status: "ready" });

  // A symlinked leaf is refused.
  const target = join(dir, "target.json");
  writeFileSync(target, jobFixtureModule.buildReadinessRecord(1, 2), { flag: "wx", mode: 0o600 });
  const link = join(dir, "symlink-leaf.json");
  symlinkSync(target, link);
  assert.throws(() => inspectReadinessLeaf(link), /nonsymlink/u);

  // Over-limit growth is refused before any content is read.
  const grown = join(dir, "grown.json");
  writeFileSync(grown, "x".repeat(MAX_READINESS_LEAF_BYTES + 1), { flag: "wx", mode: 0o600 });
  assert.throws(() => inspectReadinessLeaf(grown), /byte bound/u);

  // A FIFO at the leaf path is refused without blocking: the exact inspection
  // open flags return immediately instead of waiting for a writer, and the
  // inspection fails closed on the non-regular path.
  if (process.platform !== "win32") {
    const fifo = join(dir, "fifo-leaf");
    execFileSync("/usr/bin/mkfifo", [fifo], { timeout: 5000, maxBuffer: 4096 }); // actual confined FIFO construction, not a native/probe substitute
    // The exact inspection open flags return immediately on a FIFO instead of
    // blocking for a writer.
    const fifoFd = openSync(fifo, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    closeSync(fifoFd); // this test-owned descriptor only
    assert.throws(() => inspectReadinessLeaf(fifo), /regular nonsymlink file/u);
  }

  // A malformed record is refused even at a regular admitted path shape.
  const malformed = join(dir, "malformed.json");
  writeFileSync(malformed, '{"pid":4242,"port":31337}', { flag: "wx", mode: 0o600 });
  assert.throws(() => inspectReadinessLeaf(malformed), /readiness record/u, "a record without its generic status is refused");

  // The identity contract rejects swaps (different inode) and growth/shrinkage
  // (different size) at the source level.
  const base = { dev: 1n, ino: 2n, size: 3n };
  assert.equal(sameLeafIdentity(base, { ...base }), true);
  assert.equal(sameLeafIdentity(base, { ...base, ino: 9n }), false, "a swapped inode is never the same leaf");
  assert.equal(sameLeafIdentity(base, { ...base, size: 4n }), false, "a grown or shrunken leaf is never the same leaf");
});

test("scenario frame witnesses reject partial and mixed footers", () => {
  const card = [
    "BGT",
    "> agent idle | input none",
    "  bg tasks 0 | shells 0",
    "",
    "",
  ];
  const actions = ["  Saved conversations", "  New session", "  Quit host"];
  const mainFooter = ["F8 toggle | enter open", "esc hide | q quit"];
  const sidebarFocusFooter = [
    "F8 toggle | enter open",
    "e edit name | d stop/remove",
    "esc hide | q quit",
    "space expand | alt+right main",
  ];
  const frame = (header: string, footer: string[]): string =>
    [header, ...[" Sessions (1) ", ...card, ...actions, ...footer].map((line, index) =>
      `${line.padEnd(32)}│${index === 0 ? "Welcome" : ""}`)].join("\n");

  // Complete witnesses are admitted: the Main-focused frame right after a New
  // completion, and the sidebar-focused frame right after an Edit completion.
  assert.equal(sidebarOwnedFrame(frame("BGT", mainFooter), "BGT"), true);
  assert.equal(sidebarOwnedFrame(frame("BGT", sidebarFocusFooter), "BGT"), true);
  assert.equal(activatedRowFrame(frame("BGT", mainFooter)), true);

  // Partial Main footer: a required owner hint is missing.
  assert.equal(sidebarOwnedFrame(frame("BGT", ["F8 toggle | enter open"]), "BGT"), false,
    "a partial Main-focused footer is never complete ownership evidence");
  // Mixed footer: a stale sidebar-only hint in a Main-focused frame.
  assert.equal(sidebarOwnedFrame(frame("BGT", ["F8 toggle | enter open", "esc hide | q quit", "alt+right main"]), "BGT"), false,
    "a stale sidebar-only hint in a Main-focused frame is refused");
  assert.equal(activatedRowFrame(frame("BGT", [...mainFooter, "alt+right main"])), false);

  // Stale header-only inference: the owner header is not the activated row's.
  assert.equal(sidebarOwnedFrame(frame("Session host", mainFooter), "BGT"), false,
    "a stale host header is never the active child's owner header");
  assert.equal(activatedRowFrame(frame("Session host", mainFooter)), false);
});

test("the job fixture path contract refuses unsafe service directories before mutation", () => {
  assertOriginalEnvironmentAdmissible(process.env); // guard before any fixture mutation
  const validate = jobFixtureModule.validateServiceDir;

  // Non-absolute and over-bound paths are refused without touching the disk.
  assert.throws(() => validate("relative/dir"), /absolute/u);
  assert.throws(() => validate(join(tmpdir(), "x".repeat(128))), /bound/u);
  // Use the same admitted short, private root as the native leg so this tests
  // missing-directory refusal rather than the independent 120-byte bound.
  const scratch = createOwnedScratchRoot();
  assert.throws(() => validate(join(scratch, `missing-${randomUUID()}`)), /not inspectable/u);

  // The lexical tmpdir() may sit under a symlinked mount point (macOS /var ->
  // /private/var); only the canonical parent is admitted for construction.
  const tmpParent = realpathSync(tmpdir());
  assert.doesNotThrow(() => jobFixtureModule.validateAncestors(tmpParent),
    "the canonical temp parent passes the fixture's ancestor contract");

  // A well-formed confined directory is admitted; a pre-existing readiness
  // leaf is refused, never adopted or overwritten. The small temp root is
  // retained like every other witness in this scenario.
  const serviceDir = join(scratch, "bg-service-contract");
  mkdirSync(serviceDir, { mode: 0o700 });
  assert.equal(validate(serviceDir), join(serviceDir, jobFixtureModule.readinessLeafName));
  writeFileSync(join(serviceDir, jobFixtureModule.readinessLeafName), "", { flag: "wx", mode: 0o600 });
  assert.throws(() => validate(serviceDir), /pre-existing readiness leaf/u);

  // A symlinked service directory is refused even when its target is a real
  // confined directory.
  const linkDir = join(scratch, "bg-service-link");
  symlinkSync(serviceDir, linkDir);
  assert.throws(() => validate(linkDir), /unsafe service dir ancestor/u);
});
