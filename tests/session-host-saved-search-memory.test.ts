/**
 * Issue #609 regression: an incremental saved-conversation search must not
 * retain derived copies of every conversation's message text.
 *
 * The reported failure was the whole Saved picker dying while the user typed
 * `n`, then `l`, then `b`. This suite drives that exact production sequence —
 * real `Main`, real `SidebarController` Saved picker, real public native
 * `Input`, Main's real `saved-search` action handler, the real read-only
 * catalog (`listSavedSessions` + `searchSavedSessions`), and the real composed
 * frame — inside one owned child process started with a bounded V8 heap.
 *
 * Calibration (measured on this repository's compiled tree, synthetic corpus
 * only): with the retained per-record message views, the child's LIVE heap goes
 * ~109MB -> ~211MB after the second keystroke and ~319MB once a quoted phrase
 * normalizes message text, so under `--max-old-space-size=176` the child dies
 * with a V8 heap exhaustion while processing the second keystroke and never
 * prints evidence (it still dies there at 192, 208, 224, and 256MB). With the
 * derived views scoped to one match invocation the same child stays near
 * ~109-115MB live and finishes the whole sequence; its own minimum passing heap
 * is 144MB. The 176MB bound therefore sits between the fixed peak and the
 * retention the old shape requires; it is a test budget, not a product limit,
 * and nothing in the product caps sizes, counts, or results.
 *
 * Everything the child indexes is independently invented synthetic text
 * generated in `./helpers/session-host-saved-search-memory-child.ts`: no real
 * saved conversation, corpus, home directory, configuration, model, or network
 * is read or required.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { listSavedSessions, searchSavedSessions } from "../src/session-host/saved-sessions";
import { makeMainTestDirectory } from "./helpers/session-host-main-harness";
import {
  CHILD_ENTRY,
  CHILD_FIXTURE_ROOT_ENV,
  EVIDENCE_PREFIX,
  SYNTHETIC_CONVERSATIONS,
  SYNTHETIC_TRANSCRIPT_UNITS,
} from "./helpers/session-host-saved-search-memory-child";

/** Bounded heap for the owned child, in MB (measured calibration above). */
const CHILD_HEAP_MB = 176;
/** Generous wall-clock bound; the child normally finishes in a few seconds. */
const CHILD_TIMEOUT_MS = 180_000;

interface ChildEvidence {
  ok: true;
  conversations: Array<{
    name: string;
    id: string;
    modified: string;
    nameCarriesFirstToken: boolean;
  }>;
  workspaces: Record<string, string>;
  listingCalls: number;
  transcriptUnits: number;
  steps: Array<{ label: string; query: string; captions: string[]; selected: string; focus: string }>;
  rosterMarkerAfterDismiss: string;
  creates: number;
  createdWorkspace: string | null;
  createdAdmission: boolean;
  createdSessionId: string | null;
  focusAfterOpen: string;
  pickerOpenAfterOpen: boolean;
  selectedIdAfterOpen: string | null;
  transcriptMarkerInFrames: boolean;
  messageTokenInFrames: boolean;
  heapUsedBytes: number;
  rssBytes: number;
}

/** Run the production-path child under the bounded heap and parse its evidence. */
async function runBoundedChild(): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError: string | null;
  evidence: ChildEvidence | null;
  stdout: string;
  stderr: string;
}> {
  // This invocation owns exactly one fresh fixture root and hands that exact
  // path to the child. Cleanup below removes only that directory, never an
  // entry another concurrent invocation created.
  const fixtureRoot = makeMainTestDirectory("saved-search-memory");
  try {
    const child = spawn(process.execPath, [`--max-old-space-size=${CHILD_HEAP_MB}`, CHILD_ENTRY], {
      cwd: process.cwd(),
      env: { ...process.env, [CHILD_FIXTURE_ROOT_ENV]: fixtureRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    // Settles only once the child is actually gone (a timeout kills it first and
    // then waits for its close), so the owned fixture tree is never removed
    // while the child is still running against it.
    const settled = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
      spawnError: string | null;
    }>((resolve) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, CHILD_TIMEOUT_MS);
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, signal: null, timedOut, spawnError: error instanceof Error ? error.message : String(error) });
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut, spawnError: null });
      });
    });
    const line = stdout.split("\n").find((entry) => entry.startsWith(EVIDENCE_PREFIX));
    return {
      ...settled,
      evidence: line === undefined ? null : JSON.parse(line.slice(EVIDENCE_PREFIX.length)) as ChildEvidence,
      stdout,
      stderr,
    };
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test(`a bounded-heap Saved search survives n, l, b, and a phrase with ${SYNTHETIC_CONVERSATIONS} synthetic conversations`, async () => {
  const { code, signal, timedOut, spawnError, evidence, stderr } = await runBoundedChild();
  assert.ok(evidence !== null,
    `the production saved-search path reached a fatal failure under the bounded heap`
    + ` (exit ${code}, signal ${signal}${timedOut ? `, timed out after ${CHILD_TIMEOUT_MS}ms` : ""}`
    + `${spawnError === null ? "" : `, spawn error: ${spawnError}`}):\n${stderr.slice(-4_000)}`);
  assert.equal(code, 0, `the child must exit cleanly (stderr: ${stderr.slice(-2_000)})`);

  // The bounded heap really did carry the invented corpus, so a pass cannot be
  // vacuous: the child's own heap already exceeds half of the indexed text.
  assert.equal(evidence.transcriptUnits, SYNTHETIC_TRANSCRIPT_UNITS);
  assert.ok(evidence.heapUsedBytes >= SYNTHETIC_CONVERSATIONS * SYNTHETIC_TRANSCRIPT_UNITS / 2,
    `the child must still hold the indexed corpus, saw ${(evidence.heapUsedBytes / 1048576).toFixed(1)}MB`);

  const newestFirst = [...evidence.conversations].sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified));
  const nameLiteralFirst = [
    ...newestFirst.filter((conversation) => conversation.nameCarriesFirstToken),
    ...newestFirst.filter((conversation) => !conversation.nameCarriesFirstToken),
  ];
  assert.equal(newestFirst[0]?.nameCarriesFirstToken, false,
    "the conversation whose name never carries the first keystroke is the newest, so a broken tier order would rank it first");
  assert.equal(evidence.conversations.length, SYNTHETIC_CONVERSATIONS);

  const step = (label: string): ChildEvidence["steps"][number] => {
    const found = evidence.steps.find((entry) => entry.label === label);
    assert.ok(found, `the child recorded the ${label} step`);
    return found;
  };

  // The picker lists the whole catalog in the existing recency order.
  assert.deepEqual(step("opened").captions, newestFirst.map((conversation) => conversation.name));
  assert.equal(step("opened").focus, "form");

  // The reported incremental keystrokes: fresh results and the native tier order
  // after every refinement, never a stale or empty pane.
  assert.equal(step("query-n").query, "n");
  // Every name-literal hit outranks the newest conversation whose name never
  // carries the token, whatever the fuzzy scores inside that tier look like.
  assert.deepEqual(step("query-n").captions.length, newestFirst.length);
  assert.equal(step("query-n").captions.at(-1), newestFirst[0].name,
    `the name-literal tier keeps ranking above a message-text hit: ${step("query-n").captions}`);
  assert.deepEqual(
    [...step("query-n").captions].sort(),
    [...nameLiteralFirst.map((conversation) => conversation.name)].sort(),
    "the same minted conversations answer, none dropped or suppressed",
  );
  assert.equal(step("query-nl").query, "nl");
  assert.deepEqual(step("query-nl").captions, newestFirst.map((conversation) => conversation.name));
  assert.equal(step("query-nlb").query, "nlb");
  assert.deepEqual(step("query-nlb").captions, newestFirst.map((conversation) => conversation.name));

  // A quoted phrase whose only home is message text with irregular whitespace,
  // and a mixed literal-token plus phrase query, keep matching and ranking.
  assert.deepEqual(step("phrase").captions, newestFirst.map((conversation) => conversation.name));
  assert.equal(step("mixed").query, `nlb ${step("phrase").query}`);
  assert.deepEqual(step("mixed").captions, newestFirst.map((conversation) => conversation.name));
  assert.deepEqual(step("cleared").captions, newestFirst.map((conversation) => conversation.name));
  assert.deepEqual(step("cleared-again").captions, newestFirst.map((conversation) => conversation.name));

  // Query editing, navigation, and dismissal stay usable.
  assert.equal(step("down").selected, newestFirst[1].name);
  assert.equal(step("down-again").selected, newestFirst[2].name);
  assert.equal(step("up").selected, newestFirst[1].name);
  assert.equal(step("dismissed").focus, "sidebar");
  assert.deepEqual(step("dismissed").captions, []);
  assert.equal(evidence.rosterMarkerAfterDismiss, "> Saved conversations", "dismissal leaves the roster where it was");
  assert.equal(step("reopened").focus, "form");
  assert.deepEqual(step("reopened").captions, newestFirst.map((conversation) => conversation.name));
  assert.equal(step("reopened-down").selected, newestFirst[1].name);

  // Selection semantics are unchanged: the deliberate Enter opens exactly one
  // child, from a branded admission receipt, for the highlighted conversation.
  assert.equal(evidence.listingCalls, 2, "the picker listed the real catalog once per open");
  assert.equal(evidence.creates, 1, "searching, navigating, and dismissing never spawn a child");
  assert.equal(evidence.createdAdmission, true, "the open still carries a branded saved-session admission");
  assert.equal(evidence.createdSessionId, newestFirst[1].id);
  assert.equal(evidence.createdWorkspace, evidence.workspaces[newestFirst[1].id ?? ""],
    "the opened child uses the highlighted conversation's recorded workspace");
  assert.equal(evidence.focusAfterOpen, "main", "the restored child becomes the Main owner");
  assert.equal(evidence.selectedIdAfterOpen, "native-1");
  assert.equal(evidence.pickerOpenAfterOpen, false, "a completed open dismisses the picker");

  // No indexed message text ever entered the rendered picker.
  assert.equal(evidence.transcriptMarkerInFrames, false, "private message text never reaches the display");
  assert.equal(evidence.messageTokenInFrames, false, "a message-text token never reaches the display");
});

/**
 * The small semantic floor behind that memory change: deriving the message
 * views per invocation must keep the exact transformations the retained copies
 * produced — case folding (never accent folding), whitespace collapse inside a
 * quoted phrase, and per-field matching of a mixed token-plus-phrase query.
 */
test("the invocation-local message views keep phrase, mixed-token, and case-folding semantics", async () => {
  const root = makeMainTestDirectory("saved-search-message-views");
  try {
    const agentDir = join(root, "agent");
    mkdirSync(join(agentDir, "sessions", "proj"), { recursive: true });
    const mintFile = (id: string): string => {
      const file = join(agentDir, "sessions", "proj", `${id}.jsonl`);
      writeFileSync(file, `${JSON.stringify({
        type: "session", version: 3, id, timestamp: "2025-01-01T00:00:00.000Z", cwd: root,
      })}\n`, "utf8");
      return file;
    };
    const accentedFile = mintFile("views-accented");
    const plainFile = mintFile("views-plain");
    const catalog = await listSavedSessions({
      agentDir,
      listAll: async () => [
        {
          path: accentedFile, id: "views-accented", cwd: "/synthetic/views-a", name: "Rollout Note",
          allMessagesText: "prefix caf\u00e9 \u00dcber   transcript\tend",
          modified: new Date("2025-01-02T00:00:00.000Z"),
        },
        {
          path: plainFile, id: "views-plain", cwd: "/synthetic/views-b", name: "Rollout Other",
          allMessagesText: "prefix cafe uber transcript end",
          modified: new Date("2025-01-01T00:00:00.000Z"),
        },
      ],
    });
    const idsFor = (query: string): string[] => searchSavedSessions(catalog, query).map((row) => row.id);

    // A quoted phrase still matches the whitespace-collapsed, case-folded view
    // of complete message text, including non-ASCII case folding.
    assert.deepEqual(idsFor('"caf\u00C9 \u00dcBER   TRANSCRIPT"'), ["views-accented"],
      "a quoted phrase keeps matching the normalized message view");
    assert.deepEqual(idsFor('"cafe uber transcript"'), ["views-plain"],
      "folding stays case-only: an unaccented phrase matches only unaccented text");
    // A name token and a message phrase may match different fields of the same
    // conversation, and one phrase never crosses a field boundary.
    assert.deepEqual(idsFor('note "caf\u00e9 \u00fcber transcript"'), ["views-accented"],
      "a mixed token-plus-phrase query still matches field by field");
    assert.deepEqual(idsFor('other "caf\u00e9 \u00fcber transcript"'), [],
      "a phrase found in no field matches nothing, whatever else matched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
