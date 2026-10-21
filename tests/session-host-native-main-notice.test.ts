/**
 * Installed-host end-to-end regression for the shared pending-notice and
 * pending-question surface (issue #295).
 *
 * The test drives the public Main API in an owned outer PTY, two real native
 * Pi sessions, the freshly compiled extension, its registered
 * YouShouldKnow/AskUserQuestion tools, the production reporter/broker/sidebar,
 * and the existing public scripted faux-provider fixture. No external model
 * request or credential is used. The installed-host behavior is intentionally
 * covered here rather than by a synthetic UI/controller implementation.
 */
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, watch as fsWatch, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";

import {
  ChangeSignal,
  CleanupOutcome,
  EVENT_TIMEOUT_MS,
  KEYS,
  MainPtyDriver,
  OUTER_COLS,
  OUTER_ROWS,
  OBSERVER_FIXTURE,
  TEST_TIMEOUT_MS,
  compileAndStageCandidate,
  createEditorExecutable,
  createEditorLog,
  createOwnedScratchRoot,
  makeRuntimeEnvironment,
  makeNativeAgentRoot,
  makeWorkspace,
  processIsAlive,
  removeOwnedScratchTreePruningTerraform,
  resolveRuntimePin,
} from "./helpers/session-host-native-main-harness";
import {
  NATIVE_PANE_START,
  renderedTitleMatches,
  rosterCards,
  type RosterCardEntry,
} from "./helpers/session-host-native-roster-witness";

const PROVIDER_FIXTURE = join(process.cwd(), "tests", "fixtures", "session-host-main-provider.cjs");
const QUESTION_MARKER = "Native notice regression question";
const QUESTION_TEXT = [
  `# ${QUESTION_MARKER}`,
  "",
  "Which release lane should QA use?",
  "",
  "- Canary lane exercises the candidate release.",
  "- Stable lane protects production traffic.",
  "",
  "```ts",
  'owner = "QA";',
  "```",
].join("\n");
const QUESTION_BULLET = "Canary lane exercises the candidate release.";
const QUESTION_CODE = 'owner = "QA";';
const CHOICE_A = "Canary lane";
const CHOICE_B = "Stable lane";
const CHOICE_CONTROL_RAW = "Unsafe \u001b[2J choice **plain**";
const CHOICE_CONTROL_VISIBLE = "Unsafe \\u001b[2J choice **plain**";
const INITIAL_PROMPT = "Please register the native notice and ask the release question.";
const NOTICE_TITLE = "Reviewed deployment sequencing notice";
const CLOSE_NOTICE_TITLE = "Close only this selected notice";
const REMAINING_NOTICE_TITLE = "Preserved sibling notice";
const NOTICE_CONTEXT_MARKER = "Origin marker native-notice-context-QA-295: this context belongs only to owner QA.";
const NATIVE_MARKDOWN_DISPLAY_PROBE = "\u001b[31mNATIVE_TRANSCRIPT_SGR_PROBE_295\u001b[0m";
const NATIVE_MARKDOWN_DISPLAY_PROBE_VISIBLE = "\\u001b[31mNATIVE_TRANSCRIPT_SGR_PROBE_295\\u001b[0m";
const NOTICE_CONTEXT = `${NOTICE_CONTEXT_MARKER} ${NATIVE_MARKDOWN_DISPLAY_PROBE}`;
const DETAILS_REQUEST_INSTRUCTION = "Please elaborate on these details in your normal conversation reply.";
const BODY_HEADING = "Reviewed deployment sequence";
const BODY_BULLET = "preserve the two independent native session identities";
const BODY_CODE = 'nativeNotice.send({ mode: "follow-up" });';
const BODY_SENTINEL = "DISTANT_NOTICE_BODY_SENTINEL_295: retained details remain available through this full body.";
const BODY_CHECKPOINT_IDENTIFIERS = Array.from({ length: 12 }, (_, index) =>
  `Checkpoint ${String(index + 1).padStart(2, "0")}`);
// This canned response proves the details enter an ordinary assistant
// conversation turn; it makes no claim about real-model elaboration quality.
const DETAILS_SCRIPTED_RESPONSE = "Fixture scripted reply: I received the notice-details request and am responding in the normal conversation.";
const ANSWER_ECHO_PREFIX = "Fixture echo of delivered answer: ";
const CONTINUATION_SENTINEL = "BUSY_CONTINUATION_SENTINEL_295";
const KEY_CTRL_ALT_UP = "\x1b[1;7A";
const KEY_CTRL_ALT_PAGE_UP = "\x1b[5;7~";
const KEY_CTRL_ALT_PAGE_DOWN = "\x1b[6;7~";
const KEY_SHIFT_ALT_UP = "\x1b[1;4A";
const KEY_SHIFT_ALT_DOWN = "\x1b[1;4B";
const LONG_TURN_TIMEOUT_MS = EVENT_TIMEOUT_MS * 6;
const SHARED_OVERLAY_VERTICAL_MARGIN = 1;
const NATIVE_PANE_COLUMNS = OUTER_COLS - NATIVE_PANE_START;
const SHARED_OVERLAY_COLUMNS = NATIVE_PANE_COLUMNS;
const SHARED_OVERLAY_MAX_ROWS = Math.max(1, OUTER_ROWS - 2 * SHARED_OVERLAY_VERTICAL_MARGIN);
const SHARED_OVERLAY_START_COLUMN = 0;

const NOTICE_BODY = [
  `# ${BODY_HEADING}`,
  "",
  "This reviewed handoff keeps operator guidance attached to the exact session that produced it. Read the complete notice before making a change; the title is only a summary, and the code and checkpoints below are part of the model-visible details.",
  "",
  "## Required boundaries",
  `- ${BODY_BULLET}; never infer that a sibling session owns this notice.`,
  "- Keep the human-readable explanation intact, including its Markdown structure.",
  "- A request for more information is a follow-up, not an interruption or an answer to another pending question.",
  "",
  "> More details consumes only this notice before its ordinary request is delivered; the separate question remains pending.",
  "",
  "## Delivery example",
  "```ts",
  BODY_CODE,
  'nativeNotice.context = "native-notice-context-QA-295";',
  "```",
  "",
  "## Review checkpoints",
  ...BODY_CHECKPOINT_IDENTIFIERS.map((checkpoint) =>
    `${checkpoint}: confirm ownership, preserve the visible status, and keep the complete explanation available.`),
  "",
  "### Final verification",
  "The body is intentionally long enough to exercise Markdown layout and the full detail surface, rather than a title-only notification.",
  BODY_SENTINEL,
].join("\n");

// This scripted assistant response keeps A in its genuinely observed running
// state while the test opens the shared list and requests details. Its final
// marker is persisted only if the busy run was allowed to finish rather than
// being interrupted by More details.
const BUSY_CONTINUATION = [
  ...Array.from({ length: 72 }, (_, index) =>
    `Busy continuation checkpoint ${String(index + 1).padStart(2, "0")}: the original native run continues while a follow-up is queued.`,
  ),
  CONTINUATION_SENTINEL,
].join("\n");

interface ProviderJournalRecord {
  event?: string;
  requestIndex?: number;
  lastUserPreview?: string;
  lastUserMessage?: string;
  [key: string]: unknown;
}

function providerJournalRecords(path: string): ProviderJournalRecord[] {
  if (!existsSync(path)) return [];
  const records: ProviderJournalRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as ProviderJournalRecord);
    } catch {
      // An append may be observed between the write and its trailing newline.
    }
  }
  return records;
}

function cardFor(text: string, label: string): RosterCardEntry | undefined {
  const matches = rosterCards(text, 32).filter((card) => renderedTitleMatches(card.title, label));
  return matches.length === 1 ? matches[0] : undefined;
}

function rowHasInputBadge(text: string, label: string): boolean {
  return cardFor(text, label)?.status.includes("input pending") === true;
}

function rowBadgeState(text: string, label: string): "running" | "waiting" | "idle" | "unknown" | undefined {
  const status = cardFor(text, label)?.status;
  if (status === undefined) return undefined;
  if (status.startsWith("agent running")) return "running";
  if (status.startsWith("agent waiting")) return "waiting";
  if (status.startsWith("agent idle")) return "idle";
  if (status.startsWith("agent unknown")) return "unknown";
  return undefined;
}

function nativePaneText(frame: string): string {
  return frame.split("\n").slice(1).map((line) => line.slice(NATIVE_PANE_START)).join("\n");
}

const SHARED_OVERLAY_RULE = "─".repeat(SHARED_OVERLAY_COLUMNS);
const SHARED_OVERLAY_BLANK_ROW = " ".repeat(SHARED_OVERLAY_COLUMNS);

/** Remove exactly the one-cell side padding from one verified content row. */
function popupLineContent(line: string): string {
  return line.slice(1, -1).trim();
}

/**
 * Locate the shared popup by its exact geometry: a full-overlay-width top
 * rule, a blank vertical-padding row, content rows that each keep one padding
 * cell on both sides, a blank vertical-padding row, and a matching bottom
 * rule. A padded content row can never equal the full-width rule, so body
 * horizontal rules or code/table box glyphs are never mistaken for the frame,
 * and transcript rules without the padding structure are skipped.
 */
function locateNativeSharedPopup(paneLines: readonly string[]): string[] | undefined {
  for (let top = SHARED_OVERLAY_VERTICAL_MARGIN; top < paneLines.length; top += 1) {
    if (paneLines[top] !== SHARED_OVERLAY_RULE || paneLines[top + 1] !== SHARED_OVERLAY_BLANK_ROW) continue;
    const bottom = paneLines.findIndex((line, index) => index > top && line === SHARED_OVERLAY_RULE);
    if (bottom <= top || bottom - top + 1 > SHARED_OVERLAY_MAX_ROWS
      || bottom >= OUTER_ROWS - SHARED_OVERLAY_VERTICAL_MARGIN) continue;
    const popupRows = paneLines.slice(top, bottom + 1);
    const contentRows = popupRows.slice(1, -1);
    if (contentRows.length < 3 || contentRows.at(-1) !== SHARED_OVERLAY_BLANK_ROW
      || !contentRows.every((line) => line.startsWith(" ") && line.endsWith(" "))) continue;
    return popupRows;
  }
  // Never use the maximum-height region as a substitute for locating the
  // visible rules: short centered popups leave transcript rows above/below.
  return undefined;
}

function nativeSharedPopupLines(frame: string): string[] {
  const paneLines = nativePaneText(frame).split("\n").map((line) =>
    line.slice(SHARED_OVERLAY_START_COLUMN, SHARED_OVERLAY_START_COLUMN + SHARED_OVERLAY_COLUMNS));
  const popupRows = locateNativeSharedPopup(paneLines);
  return popupRows ? popupRows.slice(1, -1).map(popupLineContent) : [];
}

function assertNativePopupSpansConversationPane(frame: string, view: string): void {
  const paneLines = nativePaneText(frame).split("\n");
  const rows = locateNativeSharedPopup(paneLines);
  assert.ok(rows, `${view} has a ruled, padded popup in the native conversation pane`);
  assert.equal(rows[0], SHARED_OVERLAY_RULE,
    `${view} top rule reaches the conversation pane's left and right edges`);
  assert.equal(rows.at(-1), SHARED_OVERLAY_RULE,
    `${view} bottom rule reaches the conversation pane's left and right edges`);
  for (const [index, row] of rows.slice(1, -1).entries()) {
    assert.ok(row.startsWith(" ") && row.endsWith(" "),
      `${view} content row ${index} keeps one padding cell at both conversation pane margins, with no side border`);
  }
  assert.equal(rows[0]!.length, NATIVE_PANE_COLUMNS,
    `${view} outer rows span the complete conversation viewport, not the sidebar`);
}

function nativeSharedPopupText(frame: string): string {
  return nativeSharedPopupLines(frame).join("\n");
}

function sharedPopupContains(frame: string, needle: string): boolean {
  return collapsed(nativeSharedPopupText(frame)).includes(collapsed(needle));
}

function frameContains(frame: string, needle: string): boolean {
  const collapse = (text: string): string => text.replace(/\s+/g, "");
  return collapse(nativePaneText(frame)).includes(collapse(needle));
}

function selectedEntryContains(frame: string, needle: string): boolean {
  return nativeSharedPopupLines(frame).some((line) => {
    const trimmed = line.trimStart();
    return trimmed.startsWith("> ") && trimmed.includes(needle);
  });
}

function actionRows(frame: string): string[] {
  return nativeSharedPopupLines(frame).map((line) => line.trim())
    .map((line) => line.replace(/^>\s+/u, ""))
    .filter((line) => line === "More details" || line === "Close");
}

function selectedAction(frame: string): "More details" | "Close" | undefined {
  for (const line of nativeSharedPopupLines(frame)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("> ")) continue;
    const action = trimmed.slice(2);
    if (action === "More details" || action === "Close") return action;
  }
  return undefined;
}

function collapsed(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function visibleNoticeMarkers(frame: string, markers: readonly string[]): string[] {
  return markers.filter((marker) => sharedPopupContains(frame, marker));
}

function noticeBodyStartVisible(frame: string): boolean {
  const lines = nativeSharedPopupLines(frame);
  let titleRow = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]!.includes(`n1: ${NOTICE_TITLE}`)) {
      titleRow = index;
      break;
    }
  }
  const headingRow = lines.findIndex((line) => line.includes(BODY_HEADING));
  return titleRow >= 0 && headingRow > titleRow;
}

async function revealFullMarkdownBody(
  driver: MainPtyDriver,
  shortcutPair: "ctrlAltPage" | "shiftAltArrow",
): Promise<void> {
  const witnessed = new Set<string>();
  const markers = [
    NOTICE_TITLE,
    BODY_HEADING,
    BODY_BULLET,
    BODY_CODE,
    NOTICE_CONTEXT_MARKER,
    NATIVE_MARKDOWN_DISPLAY_PROBE_VISIBLE,
    BODY_SENTINEL,
    ...BODY_CHECKPOINT_IDENTIFIERS,
  ];
  const scrollMarkers = [BODY_HEADING, BODY_BULLET, BODY_CODE, BODY_SENTINEL, ...BODY_CHECKPOINT_IDENTIFIERS];
  const pageDiagnostics: string[] = [];
  const recordPage = (label: string, revision: number, pageFrame: string): void => {
    const visible = visibleNoticeMarkers(pageFrame, markers);
    for (const marker of visible) witnessed.add(marker);
    if (actionRows(pageFrame).length > 0) {
      for (const marker of markers) {
        assert.ok(witnessed.has(marker),
          `notice action rows are not offered until the complete body/context was exposed (${marker})`);
      }
    }
    if (pageDiagnostics.length >= 33) return;
    const rows = nativeSharedPopupLines(pageFrame).map((line) => line.trimEnd());
    pageDiagnostics.push(`${label} (frame ${revision}; visible markers: ${visible.join(", ") || "none"})\n${rows.join("\n")}`);
  };
  let frame = driver.currentText();
  recordPage("opening", driver.frameRevision, frame);

  const scrollNoticePage = async (direction: "PageUp" | "PageDown", page: number): Promise<string> => {
    const beforeFrame = driver.currentText();
    const beforePopup = nativeSharedPopupText(beforeFrame);
    const beforeRevision = driver.frameRevision;
    const beforeContentMarkers = new Set(visibleNoticeMarkers(beforeFrame, scrollMarkers));
    const key = shortcutPair === "ctrlAltPage"
      ? direction === "PageUp" ? KEY_CTRL_ALT_PAGE_UP : KEY_CTRL_ALT_PAGE_DOWN
      : direction === "PageUp" ? KEY_SHIFT_ALT_UP : KEY_SHIFT_ALT_DOWN;
    driver.pty.write(key);
    let observedFrame: string | undefined;
    let observedRevision = -1;
    const description = `the native detail body advances through ${direction} (${page})`;
    try {
      await driver.waitFrame((next) => {
        const nextPopup = nativeSharedPopupText(next);
        if (nextPopup === beforePopup) return false;
        // Ignore incidental repaint/background changes until the shared
        // editor-slot viewport changes while retaining an overlapping body
        // marker. The complete read below separately requires every marker.
        const nextContentMarkers = visibleNoticeMarkers(next, scrollMarkers);
        if (!nextContentMarkers.some((marker) => beforeContentMarkers.has(marker))) return false;
        observedFrame = next;
        observedRevision = driver.frameRevision;
        return true;
      }, description, beforeRevision);
    } catch (error) {
      recordPage(`${direction} ${page} (no semantic progress)`, driver.frameRevision, driver.currentText());
      throw new Error(`${description} did not expose overlapping notice-body content.\n`
        + `Bounded full-pane popup frames:\n${pageDiagnostics.join("\n\n--- next captured page ---\n\n")}`,
      { cause: error });
    }
    const nextFrame = observedFrame ?? driver.currentText();
    recordPage(`${direction} ${page}`, observedRevision, nextFrame);
    return nextFrame;
  };

  // The popup may preserve its own viewport when reopened; return to the body
  // start rather than accepting any page where the heading remains visible.
  for (let page = 0; page < 128 && !noticeBodyStartVisible(frame); page += 1) {
    frame = await scrollNoticePage("PageUp", page + 1);
  }
  // A PTY read can end mid-repaint: the heading arrives before the list item.
  // Require both inside the ruled popup before inspecting the opening page;
  // a missing item still fails this bounded wait and the assertions below.
  await driver.waitFrame((next) => noticeBodyStartVisible(next)
    && sharedPopupContains(next, BODY_HEADING) && sharedPopupContains(next, BODY_BULLET),
  "the native Markdown opening page renders its heading and complete list item");
  frame = driver.currentText();
  recordPage("opening (complete)", driver.frameRevision, frame);
  assert.ok(noticeBodyStartVisible(frame) && sharedPopupContains(frame, BODY_HEADING),
    "the notice returns to the beginning of its native Markdown body");
  const openingPopupLines = nativeSharedPopupLines(frame).map((line) => line.trim());
  assert.ok(openingPopupLines.some((line) => line.includes(BODY_HEADING))
    && !openingPopupLines.some((line) => line.startsWith(`# ${BODY_HEADING}`) || line.startsWith(`## ${BODY_HEADING}`)),
  "the native Markdown renderer presents the heading instead of its raw # source marker");
  assert.ok(openingPopupLines.some((line) => line.includes(BODY_BULLET)),
    "the native Markdown renderer presents the complete list-item content");
  assert.equal(sharedPopupContains(frame, "Native Markdown unavailable; showing the complete notice as plain text."), false,
    "the installed host renders the notice through native Markdown rather than the disclosed plain-text fallback");

  // Exercise the approved Ctrl+Alt+PageUp/PageDown pair on the first complete
  // read and the laptop Shift+Alt+Up/Down alternative on the reopened read.
  // Neither pair is the plain transcript-scrolling key intercepted globally.
  for (let page = 0; page < 128 && !(sharedPopupContains(frame, BODY_SENTINEL)
    && actionRows(frame).length === 2); page += 1) {
    frame = await scrollNoticePage("PageDown", page + 1);
  }

  assert.ok(sharedPopupContains(frame, BODY_SENTINEL),
    "the distant notice-body sentinel is readable after bounded popup-local scrolling");
  for (const marker of markers) {
    assert.ok(witnessed.has(marker), `native Markdown scrolling exposed ${marker} inside the shared popup.\n`
      + `Bounded full-pane popup frames:\n${pageDiagnostics.join("\n\n--- next captured page ---\n\n")}`);
  }
  assert.deepEqual(actionRows(frame).sort(), ["Close", "More details"],
    "the exact two notice actions are reachable at the end of the complete body");
}

function assistantTextMessages(sessionFile: string): string[] {
  const stats = lstatSync(sessionFile);
  assert.ok(stats.isFile() && !stats.isSymbolicLink() && stats.size <= 8 * 1024 * 1024,
    "the owned native session transcript is a bounded regular file");
  const output: string[] = [];
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const message = (entry as { message?: unknown }).message;
    if (message === null || typeof message !== "object") continue;
    const assistant = message as { role?: unknown; content?: unknown };
    if (assistant.role !== "assistant") continue;
    if (typeof assistant.content === "string") {
      output.push(assistant.content);
      continue;
    }
    if (!Array.isArray(assistant.content)) continue;
    const text = assistant.content.flatMap((block: unknown) => {
      if (block === null || typeof block !== "object") return [];
      const item = block as { type?: unknown; text?: unknown };
      return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
    }).join("\n");
    if (text) output.push(text);
  }
  return output;
}

interface TestState {
  readonly scratch: string;
  driver?: MainPtyDriver;
  providerWatcher?: { close(): void };
  assertionsCompleted?: boolean;
}

function registerCleanup(t: { after(fn: () => Promise<void>): void }, state: TestState): void {
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
    try { state.providerWatcher?.close(); } catch { /* owned provider-journal directory watch */ }
    const cleanupConfirmed = cleanup?.childrenExited === true
      && cleanup.shutdownEventsObserved
      && cleanup.gracefulHostExit
      && !cleanup.forced;
    if (state.assertionsCompleted === true && cleanupConfirmed) {
      try {
        if (!removeOwnedScratchTreePruningTerraform(state.scratch)) {
          process.stderr.write(`preserved native notice witness (per-entry ownership receipts unavailable): ${state.scratch}\n`);
        }
      } catch {
        process.stderr.write("preserved owned native notice scratch: bounded cleanup could not positively remove every entry\n");
      }
    } else {
      const status = cleanup
        ? `childrenExited=${cleanup.childrenExited} shutdownEvents=${cleanup.shutdownEventsObserved} hostExited=${cleanup.hostExited} gracefulHostExit=${cleanup.gracefulHostExit} forced=${cleanup.forced}`
        : "cleanup status unavailable";
      process.stderr.write(`preserved owned native notice scratch ${state.scratch}; assertionsCompleted=${state.assertionsCompleted === true}; ${status}\n`);
    }
  });
}

async function waitForProvider(
  signal: ChangeSignal,
  path: string,
  predicate: (records: ProviderJournalRecord[]) => boolean,
  description: string,
  timeoutMs = EVENT_TIMEOUT_MS,
): Promise<ProviderJournalRecord[]> {
  // `providerJournalRecords` re-reads the durable provider journal on every
  // evaluation, and this dedicated signal's only live trigger is the owned
  // directory `fs.watch`, so readiness uses the shared durable recheck with the
  // caller's unchanged predicate, deadline, and description.
  await signal.waitForRecheck(() => predicate(providerJournalRecords(path)), timeoutMs, description);
  return providerJournalRecords(path);
}

function anySharedPendingListVisible(frame: string): boolean {
  return /Pending input \(\d+\)/u.test(nativeSharedPopupText(frame));
}

function sharedPendingListVisible(frame: string): boolean {
  return sharedPopupContains(frame, "Pending input (4)")
    && sharedPopupContains(frame, NOTICE_TITLE)
    && sharedPopupContains(frame, CLOSE_NOTICE_TITLE)
    && sharedPopupContains(frame, REMAINING_NOTICE_TITLE)
    && sharedPopupContains(frame, QUESTION_MARKER)
    && selectedEntryContains(frame, NOTICE_TITLE);
}

function noticesAndQuestionListVisible(frame: string): boolean {
  return sharedPopupContains(frame, "Pending input (3)")
    && sharedPopupContains(frame, NOTICE_TITLE)
    && sharedPopupContains(frame, REMAINING_NOTICE_TITLE)
    && sharedPopupContains(frame, QUESTION_MARKER)
    && !sharedPopupContains(frame, CLOSE_NOTICE_TITLE);
}

function remainingNoticeQuestionListVisible(frame: string): boolean {
  return sharedPopupContains(frame, "Pending input (2)")
    && sharedPopupContains(frame, REMAINING_NOTICE_TITLE)
    && sharedPopupContains(frame, QUESTION_MARKER)
    && !sharedPopupContains(frame, NOTICE_TITLE)
    && !sharedPopupContains(frame, CLOSE_NOTICE_TITLE);
}

function questionOnlyListVisible(frame: string): boolean {
  return sharedPopupContains(frame, "Pending input (1)")
    && selectedEntryContains(frame, QUESTION_MARKER)
    && !sharedPopupContains(frame, NOTICE_TITLE)
    && !sharedPopupContains(frame, CLOSE_NOTICE_TITLE)
    && !sharedPopupContains(frame, REMAINING_NOTICE_TITLE);
}

async function selectAction(driver: MainPtyDriver, target: "More details" | "Close"): Promise<void> {
  assert.deepEqual(actionRows(driver.currentText()).sort(), ["Close", "More details"],
    "the notice detail surface exposes exactly More details and Close");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const selected = selectedAction(driver.currentText());
    assert.ok(selected, "one native detail action is visibly selected before confirmation");
    if (selected === target) return;
    const before = driver.frameRevision;
    driver.pty.write(selected === "More details" ? KEYS.down : KEYS.up);
    await driver.waitFrame((text) => selectedAction(text) === target,
      `the native detail action selection moves to ${target}`, before);
  }
  assert.equal(selectedAction(driver.currentText()), target);
}

test("short shared-popup matcher rejects answer/body sentinels outside the actual rules", () => {
  const outerRows = Array.from({ length: OUTER_ROWS + 1 }, () => " ".repeat(OUTER_COLS));
  const popupTop = 20;
  const insideBody = "NOTICE_BODY_SENTINEL_INSIDE_RULES";
  const aboveAnswer = "UNDERLAY_ANSWER_SENTINEL_ABOVE_RULE";
  const belowBody = "UNDERLAY_BODY_SENTINEL_BELOW_RULE";
  const outerRow = (paneLine: string): string =>
    " ".repeat(NATIVE_PANE_START) + paneLine.padEnd(NATIVE_PANE_COLUMNS, " ");
  const rule = "─".repeat(NATIVE_PANE_COLUMNS);
  const content = (text: string): string => ` ${text}`.padEnd(NATIVE_PANE_COLUMNS, " ");
  const setPaneRow = (row: number, text: string): void => { outerRows[row + 1] = outerRow(text); };

  setPaneRow(4, `Transcript ${aboveAnswer}`);
  setPaneRow(6, rule); // A transcript-wide rule without popup padding is not the frame.
  setPaneRow(7, `Transcript after rule ${aboveAnswer}`);
  setPaneRow(popupTop, rule);
  setPaneRow(popupTop + 1, content(""));
  setPaneRow(popupTop + 2, content(`n1: ${NOTICE_TITLE}`));
  setPaneRow(popupTop + 3, content("─".repeat(NATIVE_PANE_COLUMNS - 2))); // body rule inside the padding
  setPaneRow(popupTop + 4, content(`│ ${insideBody} │`)); // body table/code glyphs stay content
  setPaneRow(popupTop + 5, content(""));
  setPaneRow(popupTop + 6, rule);
  setPaneRow(44, `Underlying chat ${belowBody}`);
  const frame = outerRows.join("\n");

  assert.ok(4 < SHARED_OVERLAY_MAX_ROWS && 44 < SHARED_OVERLAY_MAX_ROWS,
    "both underlay sentinels are inside the old maximum-height crop");
  assert.ok(frameContains(frame, aboveAnswer) && frameContains(frame, belowBody),
    "both sentinels are present in underlying pane rows");
  assert.ok(sharedPopupContains(frame, insideBody), "complete notice body inside the actual rules is matchable");
  const popupLines = nativeSharedPopupLines(frame);
  assert.deepEqual(popupLines, ["", `n1: ${NOTICE_TITLE}`, "─".repeat(NATIVE_PANE_COLUMNS - 2), `│ ${insideBody} │`, ""],
    "the projection is exactly the padded interior between the two full-width rules, keeping body glyphs");
  assert.equal(sharedPopupContains(frame, aboveAnswer), false,
    "answer-like transcript text above the popup cannot satisfy an overlay assertion");
  assert.equal(sharedPopupContains(frame, belowBody), false,
    "body-like chat text below the popup cannot satisfy an overlay assertion");
});

test("real public Main shares native pending notice/question details and preserves origin/status ownership", {
  timeout: TEST_TIMEOUT_MS,
}, async (t) => {
  const runtime = resolveRuntimePin(t);
  if (!runtime) return;

  const scratch = createOwnedScratchRoot();
  const state: TestState = { scratch };
  registerCleanup(t, state);

  const workspaceA = makeWorkspace(scratch, "workspace-a");
  const workspaceB = makeWorkspace(scratch, "workspace-b");
  const nativeAgentDir = makeNativeAgentRoot(scratch, { deferredPiTools: false });
  const editorTarget = join(workspaceA, "editor-target");
  mkdirSync(editorTarget, { mode: 0o700 });
  const observerFile = join(scratch, "observer", "native-main-notice.jsonl");
  const editorLog = createEditorLog(scratch);
  const editor = createEditorExecutable(scratch, editorTarget, editorLog);
  const candidate = compileAndStageCandidate(scratch);

  const stateDir = join(scratch, "fixture-state");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const providerJournalFile = join(stateDir, "provider-journal.jsonl");
  const turnScript = {
    steps: [
      { toolCalls: [{
        toolName: "YouShouldKnow",
        arguments: { title: NOTICE_TITLE, body: NOTICE_BODY, context: NOTICE_CONTEXT },
      }] },
      { toolCalls: [{
        toolName: "YouShouldKnow",
        arguments: { title: CLOSE_NOTICE_TITLE, body: "Close must remove only this selected notice and send no request." },
      }] },
      { toolCalls: [{
        toolName: "YouShouldKnow",
        arguments: { title: REMAINING_NOTICE_TITLE, body: "This sibling notice remains pending until explicitly closed." },
      }] },
      { toolCalls: [{
        toolName: "AskUserQuestion",
        arguments: { question: QUESTION_TEXT, choices: [CHOICE_A, CHOICE_B, CHOICE_CONTROL_RAW], mode: "async" },
      }] },
      { text: BUSY_CONTINUATION },
      { text: DETAILS_SCRIPTED_RESPONSE, captureLastUser: true },
      { echoLastUser: ANSWER_ECHO_PREFIX, captureLastUser: true },
    ],
  };
  writeFileSync(join(stateDir, "turn-script.json"), JSON.stringify(turnScript), { mode: 0o600 });

  const startEnv = makeRuntimeEnvironment(scratch, runtime, editor, observerFile, editorLog, "", nativeAgentDir);
  startEnv.PRG_FIXTURE_AGENT_DIR = runtime.agentDir;
  startEnv.PRG_FIXTURE_STATE_DIR = stateDir;
  assert.deepEqual(Object.keys(startEnv).filter((name) => /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD)/i.test(name)), [],
    "the synthetic real-host environment contains no external credentials");
  const args = [
    "--offline",
    "--no-context-files",
    "--no-skills",
    "--no-themes",
    "--extension",
    OBSERVER_FIXTURE,
    "--extension",
    PROVIDER_FIXTURE,
  ];
  const forbiddenArgs = new Set(["--session", "--session-id", "--sessionID", "--session-dir", "--no-session", "--continue", "--resume", "--fork"]);
  assert.equal(args.some((arg) => forbiddenArgs.has(arg)), false,
    "the installed native sessions receive no forced/resumed/no-session override");

  const providerSignal = new ChangeSignal();
  const providerWatcher = fsWatch(stateDir, (_event, filename) => {
    if (filename === null || filename.toString() === basename(providerJournalFile)) providerSignal.notify();
  });
  state.providerWatcher = providerWatcher;

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
  const labelA = "QA";
  const labelB = "QB";
  const sessionA = await driver.createNativeSession(workspaceA);
  await driver.renameNativeSession(sessionA, labelA);
  const sessionB = await driver.createNativeSession(workspaceB);
  await driver.renameNativeSession(sessionB, labelB);

  assert.equal(sessionA.record.agentDir, nativeAgentDir);
  assert.equal(sessionB.record.agentDir, nativeAgentDir);
  assert.notEqual(sessionA.record.pid, sessionB.record.pid, "the real native owners have independent process identities");
  assert.notEqual(sessionA.record.sessionId, sessionB.record.sessionId, "the two owners have independent native conversations");
  assert.notEqual(sessionA.record.sessionFile, sessionB.record.sessionFile, "the owners retain independent session files");
  for (const session of [sessionA, sessionB]) {
    assert.equal(processIsAlive(session.record.pid), true, `${session.rowProbe} is a real live native Pi child`);
    assert.equal(session.record.tty, true, `${session.rowProbe} owns a real native PTY`);
    assert.deepEqual(session.record.credentialLikeEnvironmentNames, [], `${session.rowProbe} inherited no credential-like environment variables`);
    assert.ok(session.record.activeTools?.includes("YouShouldKnow"), `${session.rowProbe} admitted the real YouShouldKnow tool`);
    assert.ok(session.record.activeTools?.includes("AskUserQuestion"), `${session.rowProbe} admitted the real AskUserQuestion tool`);
  }

  await providerSignal.waitForRecheck(
    () => providerJournalRecords(providerJournalFile).filter((record) => record.event === "auto_model_selected").length >= 2,
    EVENT_TIMEOUT_MS,
    "both independent native sessions selected the local scripted faux model",
  );
  await driver.waitFrame((text) => rowBadgeState(text, labelB) === "idle",
    "B's idle state is observed from the real reporter/broker/sidebar before A's request");
  assert.equal(rowHasInputBadge(driver.currentText(), labelB), false, "idle owner B has no pending-input badge");

  await driver.activateRoster(labelA);
  const beforePrompt = driver.frameRevision;
  await driver.writeAndWait(INITIAL_PROMPT, (text) => frameContains(text, INITIAL_PROMPT),
    "A receives its initial request through the real native editor");
  await driver.writeKeys(KEYS.enter, "A submits the initial request to the real native agent");
  await driver.waitForRecords((records) => records.some((record) => record.type === "agent_start"
    && record.pid === sessionA.record.pid), "A's actual native agent run starts");
  await driver.waitForRecords((records) => records.some((record) => record.type === "tool_call"
    && record.toolName === "YouShouldKnow" && record.pid === sessionA.record.pid),
  "the registered YouShouldKnow tool is called by A's real native model turn");
  await driver.waitForRecords((records) => records.some((record) => record.type === "tool_call"
    && record.toolName === "AskUserQuestion" && record.pid === sessionA.record.pid),
  "the same native turn admits the real AskUserQuestion tool");
  await waitForProvider(providerSignal, providerJournalFile,
    (records) => records.filter((record) => record.event === "model_request").length >= 5,
    "the three notices, question, and long running continuation are real scripted model requests");
  await driver.waitFrame((text) => rowBadgeState(text, labelA) === "running"
    && rowHasInputBadge(text, labelA),
  "A's real sidebar card observes running plus pending input while notices and question are registered", beforePrompt);

  const beforeList = driver.frameRevision;
  driver.pty.write(KEY_CTRL_ALT_UP); // same public Ctrl+Alt+Up shortcut as the pending-question list
  await driver.waitFrame(sharedPendingListVisible,
    "the installed shared list displays the distinct notice and question entries", beforeList);
  assertNativePopupSpansConversationPane(driver.currentText(), "shared pending list");
  assert.ok(frameContains(driver.currentText(), QUESTION_MARKER),
    "the shared list retains the rich pending question alongside the notice");
  assert.equal(selectedEntryContains(driver.currentText(), NOTICE_TITLE), true,
    "creation-ordered selection initially belongs to the earlier notice");
  assert.equal(rowHasInputBadge(driver.currentText(), labelA), true,
    "the real sidebar reports A's input pending while the shared list is open");
  assert.equal(rowHasInputBadge(driver.currentText(), labelB), false,
    "the shared list does not leak A's pending status into B");

  const requestCountBeforeClose = providerJournalRecords(providerJournalFile)
    .filter((record) => record.event === "model_request").length;
  assert.equal(requestCountBeforeClose, 5, "all scripted initial requests are present before either Close action");
  const beforeCloseCandidate = driver.frameRevision;
  driver.pty.write(KEYS.down);
  await driver.waitFrame((frame) => selectedEntryContains(frame, CLOSE_NOTICE_TITLE),
    "the shared list selects the separate Close candidate without disturbing the original notice or question", beforeCloseCandidate);
  const beforeCloseCandidateDetails = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  await driver.waitFrame((frame) => sharedPopupContains(frame, CLOSE_NOTICE_TITLE)
    && sharedPopupContains(frame, "Close must remove only this selected notice"),
  "the selected Close candidate opens its own native details", beforeCloseCandidateDetails);
  await selectAction(driver, "Close");
  const beforeCloseConfirm = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  await driver.waitFrame(noticesAndQuestionListVisible,
    "Close removes only its selected notice while the original notice, another notice, and question remain", beforeCloseConfirm);
  assert.ok(!sharedPopupContains(driver.currentText(), CLOSE_NOTICE_TITLE), "the selected Close candidate is gone");
  assert.equal(selectedEntryContains(driver.currentText(), NOTICE_TITLE), true,
    "selection remains on a live sibling notice after Close");
  assert.equal(rowHasInputBadge(driver.currentText(), labelA), true,
    "the owner remains input-pending because sibling inputs remain");
  assert.equal(rowHasInputBadge(driver.currentText(), labelB), false,
    "closing A's notice does not affect sibling B's pending status");
  assert.equal(providerJournalRecords(providerJournalFile)
    .filter((record) => record.event === "model_request").length, requestCountBeforeClose,
  "Close sends no provider request");

  const beforeDetail = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  await driver.waitFrame((frame) => sharedPopupContains(frame, NOTICE_TITLE)
    && sharedPopupContains(frame, BODY_HEADING),
  "Enter opens the selected notice in the real shared Markdown detail surface", beforeDetail);
  assertNativePopupSpansConversationPane(driver.currentText(), "notice detail");
  await revealFullMarkdownBody(driver, "ctrlAltPage");
  assert.equal(rowBadgeState(driver.currentText(), labelA), "running",
    "opening the long notice preserves A's observed busy state");
  assert.equal(rowBadgeState(driver.currentText(), labelB), "idle",
    "opening A's details preserves B's independently observed idle state");

  await selectAction(driver, "More details");
  const settledBeforeMoreDetails = driver.records().filter((record) => record.type === "agent_settled"
    && record.pid === sessionA.record.pid).length;
  assert.equal(settledBeforeMoreDetails, 0,
    "A has not settled before its selected notice details are sent while the real run is busy");
  const beforeMoreDetails = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  await driver.waitFrame((frame) => rowBadgeState(frame, labelA) === "running"
    && rowHasInputBadge(frame, labelA)
    && actionRows(frame).length === 0
    && !anySharedPendingListVisible(frame),
  "More details closes the shared editor-slot popup while queuing without interrupting A's actual running turn", beforeMoreDetails);

  assert.equal(providerJournalRecords(providerJournalFile).filter((record) => record.event === "model_request").length, 5,
    "A's busy continuation has not finished or begun the selected-details follow-up yet");
  const beforeConsumedList = driver.frameRevision;
  driver.pty.write(KEY_CTRL_ALT_UP);
  await driver.waitFrame(remainingNoticeQuestionListVisible,
    "More details consumes only its selected notice while the other notice and question remain pending", beforeConsumedList);
  assert.equal(sharedPopupContains(driver.currentText(), NOTICE_TITLE), false,
    "the selected More details notice is consumed");
  assert.equal(rowHasInputBadge(driver.currentText(), labelA), true,
    "the remaining notice and separate question keep A input-pending after More details");
  const beforeRemainingListClose = driver.frameRevision;
  driver.pty.write(KEYS.escape);
  await driver.waitFrame((frame) => !sharedPopupContains(frame, "Pending input (1)"),
    "Escape closes the remaining question list without dismissing its question", beforeRemainingListClose);

  const providerAfterDetails = await waitForProvider(providerSignal, providerJournalFile,
    (records) => records.filter((record) => record.event === "model_request").length >= 6,
    "A's busy-safe More details delivery becomes a native model request after the original run",
    LONG_TURN_TIMEOUT_MS);
  assert.deepEqual(providerAfterDetails.filter((record) => record.event === "model_request")
    .map((record) => record.requestIndex), [0, 1, 2, 3, 4, 5],
  "only A issued the five initial requests and one selected-details follow-up; idle B issued none");
  assert.equal(driver.records().filter((record) => record.type === "agent_start"
    && record.pid === sessionB.record.pid).length, 0, "B received no agent start or notice delivery");
  assert.equal(driver.records().filter((record) => record.type === "tool_call"
    && record.pid === sessionB.record.pid).length, 0, "B received no native tool call");
  await driver.waitForRecords((records) => records.filter((record) => record.type === "agent_settled"
    && record.pid === sessionA.record.pid).length >= 1,
  "the genuinely busy A turn eventually settles after its scripted continuation", LONG_TURN_TIMEOUT_MS);
  await driver.waitFrame((frame) => rowBadgeState(frame, labelA) === "waiting"
    && rowHasInputBadge(frame, labelA),
  "after delivery A is truthfully idle/waiting on its still-pending entries", -1, LONG_TURN_TIMEOUT_MS);
  assert.ok(!DETAILS_SCRIPTED_RESPONSE.includes(NATIVE_MARKDOWN_DISPLAY_PROBE)
    && !DETAILS_SCRIPTED_RESPONSE.includes(NATIVE_MARKDOWN_DISPLAY_PROBE_VISIBLE),
  "the canned assistant reply cannot fake the display-transform probe");
  // The 72-line busy continuation moves the old YouShouldKnow parameter card
  // out of Main's visible transcript. Require the unique natural-language
  // request suffix, the later scripted assistant reply, and a closed popup
  // before accepting the probe as native user-message rendering evidence.
  await driver.waitFrame((frame) => frameContains(frame, DETAILS_SCRIPTED_RESPONSE)
    && frameContains(frame, DETAILS_REQUEST_INSTRUCTION)
    && frameContains(frame, NATIVE_MARKDOWN_DISPLAY_PROBE_VISIBLE)
    && actionRows(frame).length === 0
    && !anySharedPendingListVisible(frame),
  "the ordinary request and scripted assistant reply are visible in Main's native transcript after popup close, including the safely escaped SGR probe",
  -1, LONG_TURN_TIMEOUT_MS);
  // This deterministic reply verifies an ordinary native conversation turn,
  // not the quality of model-generated elaboration. More details consumed the
  // notice immediately; the independent question remains pending.
  await driver.waitForFrameQuiet("normal assistant reply and restored editor finish repainting");
  assert.equal(rowHasInputBadge(driver.currentText(), labelA), true,
    "the pending question continues to keep A's input status present after the details reply");
  assert.equal(rowHasInputBadge(driver.currentText(), labelB), false,
    "consuming A's notice does not affect B's sidebar status");
  assert.equal(providerJournalRecords(providerJournalFile)
    .filter((record) => record.event === "model_request").length, 6,
  "the selected notice details produced exactly one ordinary user turn");

  // Reopen the list to verify the unselected sibling notice survived More
  // details, then Close it without creating another provider request.
  const current = driver.currentText();
  if (!remainingNoticeQuestionListVisible(current)) {
    const beforeQuestionList = driver.frameRevision;
    driver.pty.write(KEY_CTRL_ALT_UP);
    await driver.waitFrame(remainingNoticeQuestionListVisible,
      "the same public shortcut reopens the remaining notice and question after More details consumed its selection", beforeQuestionList);
  }
  await driver.waitForFrameQuiet("the remaining native notice/question list finishes opening before selection");
  assert.ok(remainingNoticeQuestionListVisible(driver.currentText()),
    "the unselected notice and question remain available after More details");
  assert.equal(selectedEntryContains(driver.currentText(), REMAINING_NOTICE_TITLE), true,
    "the remaining notice is selected in creation order");
  const beforeRemainingNotice = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  await driver.waitFrame((frame) => sharedPopupContains(frame, REMAINING_NOTICE_TITLE)
    && actionRows(frame).length === 2,
  "the preserved sibling notice opens its independent detail view", beforeRemainingNotice);
  await selectAction(driver, "Close");
  const requestsBeforeSiblingClose = providerJournalRecords(providerJournalFile)
    .filter((record) => record.event === "model_request").length;
  const beforeSiblingClose = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  await driver.waitFrame(questionOnlyListVisible,
    "Close removes only the preserved sibling notice and leaves the question available", beforeSiblingClose);
  assert.equal(providerJournalRecords(providerJournalFile)
    .filter((record) => record.event === "model_request").length, requestsBeforeSiblingClose,
  "closing the remaining notice sends no provider request");
  assert.equal(rowHasInputBadge(driver.currentText(), labelA), true,
    "the remaining question keeps only owner A input-pending after Close");
  assert.equal(rowHasInputBadge(driver.currentText(), labelB), false,
    "closing A's sibling notice does not change B's pending status");
  assert.equal(questionOnlyListVisible(driver.currentText()), true,
    "the remaining question-only list contains no notice");

  const beforeAnswer = driver.frameRevision;
  driver.pty.write(KEYS.enter);
  await driver.waitFrame((frame) => sharedPopupContains(frame, QUESTION_MARKER)
    && sharedPopupContains(frame, QUESTION_BULLET)
    && sharedPopupContains(frame, QUESTION_CODE)
    && sharedPopupContains(frame, `1. ${CHOICE_A}`)
    && sharedPopupContains(frame, `2. ${CHOICE_B}`)
    && sharedPopupContains(frame, `3. ${CHOICE_CONTROL_VISIBLE}`),
  "the remaining pending question still uses its normal native answer view", beforeAnswer);
  assertNativePopupSpansConversationPane(driver.currentText(), "question answer view");
  const questionDetailLines = nativeSharedPopupLines(driver.currentText()).map((line) => line.trim());
  assert.ok(questionDetailLines.some((line) => line === "q1:"), "the native question ID stays separate from Markdown source");
  assert.ok(questionDetailLines.some((line) => line.includes(QUESTION_MARKER))
    && questionDetailLines.some((line) => line.includes(QUESTION_BULLET))
    && questionDetailLines.some((line) => line.includes(QUESTION_CODE)),
  "the question popup renders its heading, list, and code block through native Markdown");
  const displayedControlChoice = nativeSharedPopupLines(driver.currentText()).map((line) => line.trim())
    .find((line) => line.startsWith("3. "));
  assert.equal(displayedControlChoice, `3. ${CHOICE_CONTROL_VISIBLE}`,
    "the native question view shows the hostile choice control as visible escape text");
  assert.ok(!displayedControlChoice!.includes(CHOICE_CONTROL_RAW),
    "the native question choice row never renders the raw terminal control byte");
  assert.equal(questionDetailLines.some((line) => line.startsWith(`# ${QUESTION_MARKER}`)), false,
    "native rendering presents the parsed heading instead of literal Markdown markers");
  const startsBeforeAnswer = driver.records().filter((record) => record.type === "agent_start"
    && record.pid === sessionA.record.pid).length;
  const settlesBeforeAnswer = driver.records().filter((record) => record.type === "agent_settled"
    && record.pid === sessionA.record.pid).length;
  const beforeRawChoice = driver.frameRevision;
  driver.pty.write(KEYS.down);
  await driver.waitFrame((frame) => selectedEntryContains(frame, `2. ${CHOICE_B}`),
    "the native answer selection moves to the second raw choice", beforeRawChoice);
  const beforeControlChoice = driver.frameRevision;
  driver.pty.write(KEYS.down);
  await driver.waitFrame((frame) => selectedEntryContains(frame, `3. ${CHOICE_CONTROL_VISIBLE}`),
    "the native answer selection reaches the displayed escaped-control choice", beforeControlChoice);
  const beforeSubmit = driver.frameRevision;
  driver.pty.write(KEYS.enter); // choose the displayed escaped label; submit its raw original value
  await driver.waitForRecords((records) => records.filter((record) => record.type === "agent_start"
    && record.pid === sessionA.record.pid).length > startsBeforeAnswer,
  "the ordinary UI-delivered question answer starts a native model turn");
  await driver.waitFrame((frame) => rowBadgeState(frame, labelA) === "running",
  "the question answer turn has a fresh real running sidebar observation", beforeSubmit);
  await waitForProvider(providerSignal, providerJournalFile,
    (records) => records.filter((record) => record.event === "model_request").length >= 7,
    "the normal question answer is the seventh A-owned scripted request");
  await driver.waitForRecords((records) => records.filter((record) => record.type === "agent_settled"
    && record.pid === sessionA.record.pid).length > settlesBeforeAnswer,
  "the normal native question-answer turn settles");
  await driver.waitFrame((frame) => {
    const status = rowBadgeState(frame, labelA);
    return (status === "idle" || status === "unknown") && !rowHasInputBadge(frame, labelA);
  }, "the actual reporter/broker/sidebar clears A's pending status only after the question answer");

  const requests = providerJournalRecords(providerJournalFile).filter((record) => record.event === "model_request");
  assert.deepEqual(requests.map((record) => record.requestIndex), [0, 1, 2, 3, 4, 5, 6],
    "A's full native flow is locally scripted, ordered, and has no sibling model request");
  assert.ok(String(requests[5]?.lastUserPreview ?? "").includes(NOTICE_TITLE),
    "the origin's model request starts with the selected notice details");
  const expectedDetailsRequest = `More details requested for "${NOTICE_TITLE}":\n\n${NOTICE_BODY}`
    + `\n\nRelevant context:\n${NOTICE_CONTEXT}\n\n${DETAILS_REQUEST_INSTRUCTION}`;
  assert.equal(requests[5]?.lastUserMessage, expectedDetailsRequest,
    "the native provider request retains the exact raw body/context and adds only explicit elaboration prose");
  assert.ok(String(requests[5]?.lastUserMessage ?? "").includes(NATIVE_MARKDOWN_DISPLAY_PROBE),
    "the controlled raw SGR probe reaches the real scripted model request unchanged");
  assert.ok(String(requests[6]?.lastUserPreview ?? "").includes(QUESTION_TEXT),
    "the normal question answer is delivered as its own later user message");
  assert.equal(requests[6]?.lastUserMessage,
    `Answer to pending question "${QUESTION_TEXT}": ${CHOICE_CONTROL_RAW}`,
    "the escaped native choice still reaches the owner model as its exact raw selected value");

  assert.ok(sessionA.record.sessionFile && existsSync(sessionA.record.sessionFile),
    "A's real native SessionManager persisted its conversation");
  const assistantMessages = assistantTextMessages(sessionA.record.sessionFile!);
  assert.ok(assistantMessages.some((message) => message.includes(CONTINUATION_SENTINEL)),
    "the original busy assistant response reached its final marker rather than being interrupted");
  assert.ok(assistantMessages.some((message) => message === DETAILS_SCRIPTED_RESPONSE),
    "the native session persists the deterministic response as an ordinary assistant turn");
  assert.ok(assistantMessages.some((message) => message.includes(ANSWER_ECHO_PREFIX)
    && message.includes(`Answer to pending question \"${QUESTION_TEXT}\": ${CHOICE_CONTROL_RAW}`)),
  "the ordinary native question answer reaches A's later model context without display rewriting");

  if (existsSync(sessionB.record.sessionFile!)) {
    const siblingMessages = assistantTextMessages(sessionB.record.sessionFile!);
    assert.ok(!siblingMessages.some((message) => message.includes(DETAILS_SCRIPTED_RESPONSE)
      || message.includes(NOTICE_CONTEXT_MARKER) || message.includes(BODY_SENTINEL)),
    "B's actual independent conversation contains no selected notice/context");
  }
  const bRecords = driver.records().filter((record) => record.pid === sessionB.record.pid);
  assert.ok(bRecords.every((record) => record.type === "session_start"
    || record.type === "native_session_name" || record.type === "resize"),
  "idle sibling B observed only its real start/name/geometry lifecycle events");

  await driver.closeNativeNormally(sessionA);
  await driver.activateRoster(labelB);
  await driver.closeNativeNormally(sessionB);
  const hostExit = await driver.finishHostNormally();
  assert.equal(hostExit.signal ?? 0, 0, "the real public Main returned normally after both native owners exited");
  state.assertionsCompleted = true;
});
