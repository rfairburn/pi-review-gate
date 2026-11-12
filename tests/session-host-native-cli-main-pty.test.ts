/**
 * One integrated top-level acceptance scenario for native provider hosting in
 * the REAL public Main (issue #277 host acceptance slice).
 *
 * Everything below runs through the real public `runSessionHost(options)` entry
 * of a privately staged candidate package on a real outer `@lydell/node-pty`,
 * driven with real keystrokes, exactly like the existing native Main proofs:
 *
 * 1. one ordinary Pi row created through the Workspace-only New form, running
 *    the pinned real Pi 1.5.2 offline with `--no-tools --no-context-files
 *    --no-themes` (no model call, no prompt, no context file read);
 * 2. two native provider rows created through the SAME New form's actual
 *    Provider control (Shift+Tab to Host, Shift+Tab to Provider, arrow-cycled,
 *    Tab back to Workspace, submitted), which carries the operator's explicit
 *    choice through the production sidebar action, host create options, manager,
 *    and `createNativeCliLauncher` into a real PTY child; and
 * 3. the whole lifecycle: addressed input and one synthetic prompt answer,
 *    switching rows with the retained frame, one deliberate outer resize with
 *    the fixture's own SIGWINCH geometry, the truthful unknown sidebar status,
 *    one natural fixture exit, one public stop confirmation, the real Pi row's
 *    graceful exit, and the host's normal Quit with full outer restoration.
 *
 * EVIDENCE SCOPE — read before drawing any conclusion:
 * - Both provider children are SYNTHETIC Node programs this file wrote, with a
 *    synthetic question of their own. They are NOT Claude Code and NOT the
 *    Codex CLI. Nothing here proves a real provider TUI's rendering, prompts,
 *    key handling, trust dialogs, or telemetry, and nothing reads or writes any
 *    provider's real configuration, credentials, keychain, clipboard, or
 *    conversations. Each fixture's configured shared `env` overrides `PATH` to
 *    one owned empty directory, so no real provider binary is reachable from a
 *    hosted child, and this test never submits a built-in default target at all.
 * - Native-CLI witnesses come from the fixture itself. The harness's
 *    `records()` / `ownedSessions()` / `paneGeometry()` / `setOuterSize()` /
 *    `closeNativeNormally()` all key off the Pi observer extension a provider
 *    child never loads, so they are used here ONLY for the real Pi row. For the
 *    provider rows, PID, argv, TTY state, workspace, environment, received
 *    input, SIGWINCH geometry, and continuation are read from each fixture's own
 *    journal, and the original-process settlement is the harness
 *    `OwnedPidExitWatcher` on the fixture-REPORTED PID plus the Main runner's
 *    real `@lydell/node-pty` `onExit` journal for the manager-owned PTY.
 * - macOS only (the shared harness's explicit scope). Windows ConPTY, a
 *    physical terminal, and any real provider remain unverified.
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
 * input ownership. A frame that merely lost the Workspace row to a partial
 * repaint is not a witness at all, so the driver keeps waiting instead of
 * concluding a submission that never happened. No extra Enter, no Escape, no
 * retry, no sleep is added anywhere, so a New form that never takes the
 * submission stays a failure here instead of being worked around. The witnesses
 * are the shared test-only ones in
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
 * Runtime guard: `resolveRuntimePin(t)` is used unchanged. It refuses
 * (throws, never skips) inside a delegated runtime role, so this file is
 * authored, type-checked, and fixture-syntax-checked in the delegated worker and
 * RUN by an independently authorized top-level integration context with the
 * standard pinned-runtime environment. Its scenario is UNVERIFIED until that
 * top-level run reports an actual result.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { normalizeConfig } from "../src/config";
import { listNativeCliTargets } from "../src/session-host/native-cli-launch";

import {
  EVENT_TIMEOUT_MS,
  KEYS,
  MainPtyDriver,
  OBSERVER_FIXTURE,
  OUTER_COLS,
  OUTER_ROWS,
  OwnedPidExitWatcher,
  TEST_TIMEOUT_MS,
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
  frameHeader,
  parseRosterFrame,
  renderedTitleMatches,
  rosterCards,
  selectedRosterEntry,
  sidebarPaneLines,
  type ParsedRoster,
  type RosterCardEntry,
  type RosterEntry,
} from "./helpers/session-host-native-roster-witness";

const SHIFT_TAB = "\x1b[Z";
const TAB = "\t";

/** The configured synthetic target ids, in the alphabetical catalog order the New form cycles. */
const CLAUDE_TARGET = "scla";
const CODEX_TARGET = "scod";
/** The outer geometry the displayed row's pane has at the wide 120x50 layout. */
const PANE_COLS = OUTER_COLS - SIDEBAR_COLUMNS - 1;
const PANE_ROWS = OUTER_ROWS - 1;
/** The deliberate outer resize: wide, so the native pane is `100 - 33` by `30 - 1`. */
const RESIZED_OUTER = { cols: 100, rows: 30 } as const;
const RESIZED_PANE = { cols: RESIZED_OUTER.cols - SIDEBAR_COLUMNS - 1, rows: RESIZED_OUTER.rows - 1 } as const;

/** The provider choices the New form offers, in cycle order, for the authored configuration. */
const OFFERED_TARGETS = [
  { id: "claude", backend: "claude", label: "Claude Code (default)" },
  { id: "codex", backend: "codex", label: "Codex CLI (default)" },
  { id: `external:${CLAUDE_TARGET}`, backend: "claude", label: `${CLAUDE_TARGET} (Claude Code)` },
  { id: `external:${CODEX_TARGET}`, backend: "codex", label: `${CODEX_TARGET} (Codex CLI)` },
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
 * The synthetic interactive CLI both provider rows run. It is the only witness
 * a native CLI child can provide: it journals its own PID, argv, TTY state,
 * pane geometry (from its own `resize`/SIGWINCH events), cwd, environment,
 * every input line it actually receives, its continuing heartbeat, any signal,
 * and its own farewell — and echoes a compact form of each into its own
 * terminal so the real Main frame shows the same facts.
 */
const SYNTHETIC_CLI_SOURCE = `"use strict";
const fs = require("node:fs");
const journal = process.env.PRG_SYNTH_JOURNAL;
const tag = process.env.PRG_SYNTH_TAG || "fixture";
const record = (event) => {
  try { fs.appendFileSync(journal, JSON.stringify(Object.assign({ tag: tag }, event)) + "\\n", "utf8"); } catch (error) { void error; }
};
const say = (line) => { try { process.stdout.write(line + "\\r\\n"); } catch (error) { void error; } };
const self = {
  type: "hello",
  pid: process.pid,
  ppid: process.ppid,
  execPath: process.execPath,
  argv: process.argv.slice(1),
  tty: process.stdout.isTTY === true,
  cols: process.stdout.columns,
  rows: process.stdout.rows,
  cwd: process.cwd(),
  path: process.env.PATH === undefined ? "absent" : process.env.PATH,
  home: process.env.HOME === undefined ? "absent" : process.env.HOME,
  target: process.env.PRG_SYNTH_TARGET === undefined ? "absent" : process.env.PRG_SYNTH_TARGET,
  boot: process.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP ? "present" : "absent",
  role: process.env.PI_REVIEW_GATE_RUNTIME_ROLE === undefined ? "absent" : "present",
  nodeOptions: process.env.NODE_OPTIONS === undefined ? "absent" : "present",
};
record(self);
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
`;

/** One fixture's own journaled fact. Absent fields stay absent, never guessed. */
interface FixtureRecord {
  type?: string;
  tag?: string;
  pid?: number;
  ppid?: number;
  execPath?: string;
  argv?: string[];
  tty?: boolean;
  cols?: number;
  rows?: number;
  cwd?: string;
  path?: string;
  home?: string;
  target?: string;
  boot?: string;
  role?: string;
  nodeOptions?: string;
  line?: string;
  signal?: string;
  n?: number;
}

/** One owned native fixture: its journal, its reported PID, and its kernel watcher. */
interface NativeFixture {
  readonly targetId: string;
  readonly tag: string;
  readonly journalFile: string;
  readonly workspace: string;
  readonly pid: number;
  readonly hello: FixtureRecord;
  readonly watcher: OwnedPidExitWatcher;
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
 * Bounded wait for one native create's child to report itself, watching the
 * drawn frame at the same time: a create the real host refused, or a New form
 * that was never actually submitted, is named here instead of surfacing later
 * as an unexplained child that never appeared.
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
    if (records.some((record) => record.type === "hello")) return records;
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

/** The one drawn card whose complete title line belongs to `caption`, if any. */
function cardFor(text: string, caption: string): RosterCardEntry | undefined {
  const matches = rosterCards(text, SIDEBAR_COLUMNS).filter((card) => renderedTitleMatches(card.title, caption));
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

/** The drawn roster only when it is complete; a partial roster is never stepped on. */
function completeRoster(text: string): ParsedRoster | undefined {
  const parsed = parseRosterFrame(text, SIDEBAR_COLUMNS);
  return parsed.complete ? parsed : undefined;
}

/** The one uniquely highlighted entry of a complete roster, or nothing when no unique highlight is drawn. */
function uniqueHighlight(parsed: ParsedRoster): RosterEntry | undefined {
  const selected = parsed.entries.filter((entry) => entry.selected);
  return selected.length === 1 ? selected[0] : undefined;
}

/** The entry one cyclic Down from `position`, or nothing when that step is ambiguous. */
function entryAfterOneDown(parsed: ParsedRoster, position: number): RosterEntry | undefined {
  if (parsed.entries.length === 0) return undefined;
  const index = parsed.entries.findIndex((entry) => entry.position === position);
  if (index < 0 || parsed.entries.some((entry, at) => at !== index && entry.position === position)) return undefined;
  return parsed.entries[(index + 1) % parsed.entries.length];
}

/** How the drawn roster names one entry, for a step message that cannot lie about where it pressed. */
function entryCaption(entry: RosterEntry): string {
  return entry.kind === "action" ? entry.label : entry.title;
}

/**
 * Explicit cyclic sidebar navigation with individually witnessed highlights.
 *
 * The harness's `moveRosterTo` correlates every drawn native card with an
 * observer-confirmed Pi row, and a provider child never loads that observer, so
 * a roster that contains provider cards has no correlation to navigate on. This
 * reads the COMPLETE rendered roster, derives the single entry one cyclic Down
 * below the drawn highlight, presses one real Down, and witnesses the highlight
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
    const highlight = uniqueHighlight(parsed);
    if (highlight === undefined) {
      // Removing a row can leave the roster with no highlight at all. One real
      // Down must then establish a unique highlight before any further step.
      driver.pty.write(KEYS.down);
      await driver.waitFrame((drawn) => {
        const redrawn = completeRoster(drawn);
        return redrawn !== undefined && uniqueHighlight(redrawn) !== undefined;
      }, `one real Down re-establishes a unique sidebar highlight on the way to ${expected}`, after);
      continue;
    }
    const next = entryAfterOneDown(parsed, highlight.position);
    assert.ok(next, `the drawn roster names no unambiguous entry one Down from position ${highlight.position}:\n${text}`);
    driver.pty.write(KEYS.down); // Explicit UI navigation only, never activation.
    await driver.waitFrame((drawn) => {
      const redrawn = completeRoster(drawn);
      const landed = redrawn === undefined ? undefined : uniqueHighlight(redrawn);
      return landed !== undefined && landed.position === next.position;
    }, `the real sidebar highlight steps one entry, ${entryCaption(highlight)} to ${entryCaption(next)}, on the way to ${expected}`, after);
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
 * uses, with the witnesses this file already parses: the COMPLETE roster whose
 * single highlight is the activated row, then the real frame writer going quiet,
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
    const parsed = completeRoster(text);
    const highlight = parsed === undefined ? undefined : uniqueHighlight(parsed);
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
 * Both targets share the shape the product documents for a configured external
 * agent: `command` is this test process's own Node interpreter and the shared
 * `args` are the owned recording script, so a hosted "provider" is never a real
 * provider binary; each target's shared `env` overlay is what the child actually
 * searches (`PATH` is one owned empty directory) and where it journals.
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
      [CLAUDE_TARGET]: target(CLAUDE_TARGET, "claude-cli"),
      [CODEX_TARGET]: target(CODEX_TARGET, "codex-cli"),
    },
  };
  writeFileSync(join(agentDir, "review-gate.json"), JSON.stringify(config, undefined, 2), { mode: 0o600 });
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

/** Shift+Tab once to the Host line, again to the Provider line, still on Pi. */
async function focusProviderLine(driver: MainPtyDriver): Promise<void> {
  const afterHost = driver.frameRevision;
  driver.pty.write(SHIFT_TAB);
  await driver.waitFrame((text) => contentPaneLines(text)
    .some((line) => line.trimStart().startsWith("> Host: ["))
    && providerValue(providerRow(text)) === PI_PROVIDER_VALUE,
  "Shift+Tab moves the New form's focus to its Host line", afterHost);

  const afterProvider = driver.frameRevision;
  driver.pty.write(SHIFT_TAB);
  await driver.waitFrame((text) => providerRow(text)?.trimStart().startsWith("> Provider: ") === true
    && providerValue(providerRow(text)) === PI_PROVIDER_VALUE,
  "a second Shift+Tab moves the focus to the Provider line, still Pi", afterProvider);
}

/**
 * Cycle the Provider line one real Down at a time and witness every drawn
 * choice by its exact drawn value, including the two built-in defaults this
 * scenario deliberately passes over without ever submitting them.
 */
async function cycleProviderTo(driver: MainPtyDriver, steps: number): Promise<string> {
  for (let step = 1; step <= steps; step += 1) {
    const expected = `[ ${OFFERED_TARGETS[step - 1]!.label} ]`;
    const after = driver.frameRevision;
    driver.pty.write(KEYS.down);
    await driver.waitFrame((text) => providerValue(providerRow(text)) === expected,
    `the Provider line cycles to the offered choice ${expected}`, after);
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
async function submitWorkspace(driver: MainPtyDriver, workspace: string, journalFile: string): Promise<void> {
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
  // fenced against the identities already in it before this Enter.
  const afterFirstEnter = driver.frameRevision;
  const preexistingStarts = captureStartIdentities(readJournal(journalFile));
  driver.pty.write(KEYS.enter);
  let firstEnter: WorkspaceSubmitWitness<FixtureRecord> | undefined;
  await driver.waitFrame((text) => {
    const witness = observeWorkspaceSubmitWitness(text, {
      completedPath: `${workspace}/`,
      freshStart: () => observeFreshStart(readJournal(journalFile), {
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
 * control, then take the launched child's own identity from its own journal and
 * put a kernel exit watcher on the PID it reported.
 */
async function createNativeFixtureSession(options: {
  readonly driver: MainPtyDriver;
  readonly workspace: string;
  readonly tag: string;
  readonly journalFile: string;
  readonly fixtureScript: string;
  readonly ownedBin: string;
  readonly scratchHome: string;
  readonly cycles: number;
  /** The one backend argument the production launcher appends, in launch order. */
  readonly extraArgs: readonly string[];
}): Promise<NativeFixture> {
  const { driver, workspace, tag, journalFile } = options;
  await openNewForm(driver);
  await focusProviderLine(driver);
  const drawnChoice = await cycleProviderTo(driver, options.cycles);
  assert.ok(drawnChoice.includes(`[ ${tag}`),
    `the focused Provider line names the configured target ${tag}; drawn value was ${drawnChoice}`);
  assert.ok(!drawnChoice.includes("default)"),
    "the submitted choice is the configured target, never a built-in default",);
  await submitWorkspace(driver, workspace, journalFile);

  const records = await untilNativeLaunch(driver, journalFile,
    `${tag}'s own identity report after the real provider create launched it`);
  driver.focus = "main";
  const hello = records.filter((entry) => entry.type === "hello").at(-1)!;
  assert.equal(typeof hello.pid, "number", `${tag} reported its own process id`);
  const pid = hello.pid!;
  assert.equal(hello.target, `external:${tag}`,
    "the child's own environment names the exact configured target id the Provider line selected");
  assert.equal(hello.tty, true, "the real child reports a real terminal of its own");
  assert.deepEqual([hello.cols, hello.rows], [PANE_COLS, PANE_ROWS],
    "the child's own terminal is the pane the real host displays");
  assert.equal(hello.cwd, workspace, "the child runs in the workspace this row selected");
  assert.deepEqual(hello.argv, [options.fixtureScript, tag, ...options.extraArgs],
    "the child sees exactly the argv the production launcher composed for its backend, in order");
  assert.equal(hello.path, options.ownedBin,
    "the configured shared environment makes one owned empty directory the only PATH the child can search");
  assert.equal(hello.execPath !== undefined && realpath(hello.execPath) === realpath(process.execPath), true,
    "the hosted child is this test's own Node interpreter, never a real provider binary");
  assert.equal(hello.home, options.scratchHome, "the child's HOME stays the fixture's owned home");
  assert.equal(hello.boot, "absent", "no session-host bootstrap token reaches a provider child");
  assert.equal(hello.role, "absent", "no delegated runtime-role authorization reaches a provider child");

  const watcher = new OwnedPidExitWatcher(pid);
  driver.nativeExitWatchers.set(pid, watcher);
  await watcher.waitUntilRegistered(EVENT_TIMEOUT_MS);
  return { targetId: `external:${tag}`, tag, journalFile, workspace, pid, hello, watcher };
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
    if (state.assertionsCompleted === true && cleanupConfirmed) {
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

test("real public Main hosts a real Pi row and two synthetic native CLI fixtures through the New provider UI, with owned input, resize, switching, unknown status, and exact exits", {
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
  // per target, and the empty directory a hosted child sees as its whole PATH.
  const fixtureDir = join(scratch, "native-fixture");
  mkdirSync(fixtureDir, { mode: 0o700 });
  const fixtureScript = join(fixtureDir, "synthetic-cli.cjs");
  writeFileSync(fixtureScript, SYNTHETIC_CLI_SOURCE, { mode: 0o600 });
  const ownedBin = join(fixtureDir, "owned-empty-bin");
  mkdirSync(ownedBin, { mode: 0o700 });
  const journals: Record<string, string> = {
    [CLAUDE_TARGET]: join(fixtureDir, `${CLAUDE_TARGET}.jsonl`),
    [CODEX_TARGET]: join(fixtureDir, `${CODEX_TARGET}.jsonl`),
  };
  for (const file of Object.values(journals)) writeFileSync(file, "", { mode: 0o600 });

  // One ordinary shared native agent root, then this scenario's configured
  // targets in it. The host discovers exactly this file, so the New form's
  // offered choices and the launcher's resolution come from one configuration.
  const nativeAgentDir = makeNativeAgentRoot(scratch);
  writeNativeAgentConfig(nativeAgentDir, fixtureScript, ownedBin, journals);
  const authoredConfig = normalizeConfig(JSON.parse(readFileSync(join(nativeAgentDir, "review-gate.json"), "utf8")) as never);
  assert.deepEqual(listNativeCliTargets(authoredConfig), OFFERED_TARGETS,
    "the authored configuration offers Pi's two built-in defaults plus the two owned synthetic targets, in the order the New form cycles them");

  const observerFile = join(scratch, "observer", "native-main.jsonl");
  const editorLog = createEditorLog(scratch);
  const editorTarget = join(scratch, "editor-target");
  mkdirSync(editorTarget, { mode: 0o700 });
  const editor = createEditorExecutable(scratch, editorTarget, editorLog);
  const candidate = compileAndStageCandidate(scratch);

  const scratchHome = join(scratch, "home");
  const startEnv = makeRuntimeEnvironment(scratch, runtime, editor, observerFile, editorLog, "", nativeAgentDir);
  assert.deepEqual(Object.keys(startEnv).filter((name) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i.test(name)), [],
    "the synthetic native child environment contains no external credentials");
  const args = [...REQUIRED_PI_ARGS, "--extension", OBSERVER_FIXTURE];
  assert.equal(args.some((arg) => FORBIDDEN_SESSION_ARGS.has(arg)), false,
    "the real Pi session receives no forced, resumed, or no-session override");

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
  // The claude-backed fixture is cycled past Pi and both built-in defaults.
  const claudeFixture = await createNativeFixtureSession({
    driver,
    workspace: workspaceClaude,
    tag: CLAUDE_TARGET,
    journalFile: journals[CLAUDE_TARGET]!,
    fixtureScript,
    ownedBin,
    scratchHome,
    cycles: 3,
    extraArgs: [],
  });
  await driver.waitFrame((text) => headerNamesOwner(text, "Claude")
    && nativePaneText(text).includes(`FX ${CLAUDE_TARGET} HELLO pid=${claudeFixture.pid}`)
    && nativePaneText(text).includes(`FX ${CLAUDE_TARGET} QUESTION`),
  "the real host displays the created native row's own terminal output under its own header");
  const claudeCard = cardFor(driver.currentText(), "Claude");
  assert.ok(claudeCard, "the native row draws its own roster card");
  assert.equal(claudeCard.status, "agent unknown | input unknown",
    "a provider card reports unknown agent and input state, never an inferred idle");
  assert.equal(claudeCard.background, "background unknown",
    "a provider card never invents zero background counts");

  // The codex-backed fixture also receives the daemon-isolating argument the
  // production launcher composes; its own argv witness proves it arrived.
  const codexFixture = await createNativeFixtureSession({
    driver,
    workspace: workspaceCodex,
    tag: CODEX_TARGET,
    journalFile: journals[CODEX_TARGET]!,
    fixtureScript,
    ownedBin,
    scratchHome,
    cycles: 4,
    // The Codex backend's one daemon-isolating argument, asserted as part of the
    // exact ordered argv above and again below as a backend-specific witness.
    extraArgs: ["--no-daemon"],
  });
  assert.deepEqual(codexFixture.hello.argv, [fixtureScript, CODEX_TARGET, "--no-daemon"],
    "the one deliberate Codex argument reaches the real child in argv order");
  await driver.waitFrame((text) => headerNamesOwner(text, "Codex")
    && nativePaneText(text).includes(`FX ${CODEX_TARGET} HELLO pid=${codexFixture.pid}`),
  "the second native row becomes the displayed owner under its own header");
  const codexCard = cardFor(driver.currentText(), "Codex");
  assert.ok(codexCard);
  assert.equal(codexCard.status, "agent unknown | input unknown",
    "the second provider card is equally truthful about knowing nothing");

  // Independent ownership: three distinct OS processes in three distinct
  // workspaces, each journalling to its own file.
  assert.equal(new Set([piSession.record.pid, claudeFixture.pid, codexFixture.pid]).size, 3,
    "the real Pi child and both native fixtures are three distinct OS processes");
  assert.equal(claudeFixture.hello.cwd, workspaceClaude);
  assert.equal(codexFixture.hello.cwd, workspaceCodex);
  // Both PTY children are spawned by the one real Main process, so a shared
  // parent is correct and expected. What must be impossible is either fixture
  // being its sibling's child, so each child's own reported parent is compared
  // against the SIBLING's pid rather than against the other child's parent.
  assert.equal(typeof claudeFixture.hello.ppid, "number", "the claude-backed fixture reports its own parent pid");
  assert.equal(typeof codexFixture.hello.ppid, "number", "the codex-backed fixture reports its own parent pid");
  assert.notEqual(claudeFixture.hello.ppid, codexFixture.pid,
    "the claude-backed fixture is not a child of the codex-backed fixture");
  assert.notEqual(codexFixture.hello.ppid, claudeFixture.pid,
    "the codex-backed fixture is not a child of the claude-backed fixture");

  // --- Addressed input: only the displayed row's real child is answered. ---
  await driver.waitFrame((text) => nativePaneText(text).includes(`FX ${CODEX_TARGET} QUESTION`),
    "the displayed native row shows its own synthetic question");
  const claudeInputBeforeAnswer = countOf(readJournal(claudeFixture.journalFile), "input");
  await driver.writeAndWait(`${ANSWER}\r`, (text) => nativePaneText(text).includes(`FX ${CODEX_TARGET} CONFIRMED`),
    "the synthetic prompt answer reaches the displayed native child and is echoed by that child alone");
  await untilJournal(codexFixture.journalFile,
    (records) => records.some((record) => record.type === "input" && record.line === ANSWER),
    "the answered fixture journals the exact line it received");
  assert.equal(countOf(readJournal(claudeFixture.journalFile), "input"), claudeInputBeforeAnswer,
    "the sibling fixture received no byte of the addressed answer");

  // --- Switch back: the retained frame, then input addressed to the other row. ---
  await driver.ensureSidebarFocus();
  await stepRosterTo(driver, "Claude");
  await activateHighlighted(driver, "Claude",
    (text) => nativePaneText(text).includes(`FX ${CLAUDE_TARGET} HELLO pid=${claudeFixture.pid}`)
      && nativePaneText(text).includes(`FX ${CLAUDE_TARGET} QUESTION`));
  const codexBeatsBeforeSwitch = lastBeat(readJournal(codexFixture.journalFile));
  const codexInputBeforeSwitch = countOf(readJournal(codexFixture.journalFile), "input");
  await driver.writeAndWait(`${ANSWER}\r`, (text) => nativePaneText(text).includes(`FX ${CLAUDE_TARGET} CONFIRMED`),
    "the answer follows the deliberate switch to the other row's real child");
  await untilJournal(claudeFixture.journalFile,
    (records) => records.some((record) => record.type === "input" && record.line === ANSWER),
    "the newly displayed fixture journals the exact line it received");
  assert.equal(countOf(readJournal(codexFixture.journalFile), "input"), codexInputBeforeSwitch,
    "the row that is no longer displayed received no byte of this answer");
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

  const outputBeforeRestore = driver.outputRevision;
  driver.pty.resize(OUTER_COLS, OUTER_ROWS);
  driver.surface.resize(OUTER_COLS, OUTER_ROWS);
  await driver.waitForOuterOutput(outputBeforeRestore, "real ProcessTerminal redraw after restoring the outer size");
  await untilJournal(claudeFixture.journalFile,
    (records) => records.some((record) => record.type === "resize" && record.cols === PANE_COLS && record.rows === PANE_ROWS),
    `the displayed native fixture reports its own restored ${PANE_COLS}x${PANE_ROWS} terminal`);
  assert.equal(countOf(readJournal(codexFixture.journalFile), "resize"), codexResizesBefore,
    "restoring the outer size still resizes no un-displayed native fixture");

  // --- One natural fixture exit: the fixture's own farewell, then real settlement. ---
  await driver.writeAndWait(`${FAREWELL}\r`, (text) => nativePaneText(text).includes(`FX ${CLAUDE_TARGET} FAREWELL`),
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
  // highlighting a row does not display it, so the stopped child's own SIGTERM
  // line belongs to its journal, not to the pane of the row still on screen.
  const afterStopConfirm = driver.frameRevision;
  await driver.writeKeys(KEYS.enter, "the confirmed stop is written to the real host");
  await untilJournal(codexFixture.journalFile,
    (records) => records.some((record) => record.type === "signal" && record.signal === "SIGTERM"),
    "the stopped fixture journals the signal it actually received");
  await codexFixture.watcher.waitForExit(EVENT_TIMEOUT_MS);
  assert.equal(codexFixture.watcher.observedExit, true,
    "the kernel exit event for the stopped fixture's exact PID was observed");
  assert.equal(processIsAlive(codexFixture.pid), false, "the stopped fixture process is gone");
  await untilPtyExit(driver, codexFixture.pid, "the manager-owned native PTY exit for the stopped fixture");
  // A confirmed stop that ended in a positive exit removes its own row. Nothing
  // else may move: the roster must still be complete, with the real Pi row and
  // the naturally exited fixture's retained card both preserved.
  await driver.waitFrame((text) => {
    if (completeRoster(text) === undefined) return false;
    const cards = rosterCards(text, SIDEBAR_COLUMNS);
    return !cards.some((card) => renderedTitleMatches(card.title, "Codex"))
      && cards.some((card) => renderedTitleMatches(card.title, "Claude")
        && card.status === "exited (code 0)")
      && cards.some((card) => renderedTitleMatches(card.title, piSession.displayName));
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
  assert.equal(codexFixture.watcher.observedExit, true, "every fixture's original process settled before the host Quit");
  assert.equal(piSession.exitWatcher.observedExit, true, "the real Pi child's original process settled before the host Quit");

  state.assertionsCompleted = true;
});
