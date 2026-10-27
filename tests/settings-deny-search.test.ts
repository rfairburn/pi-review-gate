/**
 * Issue #463: live tool-NAME search in both scoped deny pickers.
 *
 * Production coverage for the search-capable deny picker
 * (src/settings/deny-picker.ts) and the shared saved-conversation search
 * grammar it reuses (src/session-host/saved-search.ts):
 *
 * - The pure filter narrows a large synthetic inventory of MCP-style tool
 *   names by NAME only, keeps the Back row reachable under any query, and
 *   matches exactly like the saved-conversation search and Pi's own /resume
 *   reference.
 * - The picker is driven through the host's real custom-component contract
 *   (`done()` settles it, the host focuses it) with the native pi-tui Input
 *   and SelectList: live filtering, navigation, identity retention, scroll,
 *   width, focus, editing, paste, held-key repeats, and remapped keys.
 * - The registered `/review-settings` path is driven for BOTH roles with a
 *   large synthetic inventory and prechecked hidden/unavailable denials: the
 *   rendered narrowed inventory is asserted per presentation, and the full
 *   resulting configuration is asserted for Save, Ctrl+S, root Escape
 *   (session apply), and Cancel.
 * - Non-TUI (RPC/plain) hosts keep the full, unfiltered selector.
 *
 * Every scripted UI flow fails boundedly: a script that does not settle its
 * menu is recorded and unwound instead of waiting forever.
 *
 * Everything here is synthetic: no MCP server, no real session, no private
 * data, and no clipboard.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CURSOR_MARKER,
  Input as PinnedInput,
  Key,
  KeybindingsManager,
  matchesKey,
  SelectList as PinnedSelectList,
  Text as PinnedText,
  Container as PinnedContainer,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "pi-session-host-tui";
import { normalizeConfig, type ReviewGateConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { persistReviewSettings } from "../src/settings/persistence";
import { createMenuActionFence, setMenuTuiHost, type MenuTuiHost, type SettingsSaveControl } from "../src/settings/menu";
import {
  filterDenyPickerRows,
  NO_MATCHING_TOOLS_MESSAGE,
  retainedDenySelect,
  type DenyPickerRow,
} from "../src/settings/deny-picker";
import {
  filterBySavedSearch,
  matchSavedSearchText,
  parseSavedSearchQuery,
} from "../src/session-host/saved-search";
import { skipOrFail } from "./bridge-fakes";
import {
  createFakeMenuTuiHost,
  createTuiSettingsContext,
  findInstalledAgentDirs,
  IDENTITY_THEME,
  KEY_DOWN,
  KEY_ENTER,
  KEY_ESCAPE,
  KEY_UP,
  stripAnsi,
  type TuiSettingsHarness,
} from "./menu-tui-fakes";

const CTRL_C = "\x03";
const CTRL_S = "\x13";
const KEY_BACKSPACE = "\x7f";
const KEY_END = "\x1b[F";
const KEY_LEFT = "\x1b[D";
const KEY_RIGHT = "\x1b[C";
const KEY_UNDO = "\x1f"; // Ctrl+-, Pi's default tui.editor.undo
// Kitty keyboard-protocol held-key events (event type 2 = repeat, 3 = release).
const REPEAT_ENTER = "\x1b[13;1:2u";
const REPEAT_ESCAPE = "\x1b[27;1:2u";
const RELEASE_ESCAPE = "\x1b[27;1:3u";
const REPEAT_CTRL_S = "\x1b[115;5:2u";
const REPEAT_DOWN = "\x1b[1;1:2B";
const REPEAT_A = "\x1b[97;1:2u";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const down = (count: number): string[] => Array.from({ length: count }, () => KEY_DOWN);
const backspaces = (count: number): string[] => Array.from({ length: count }, () => KEY_BACKSPACE);
const typed = (text: string): string[] => [...text];

/** A bounded per-test deadline: a scripted UI test must fail, not hang. */
const TEST_TIMEOUT_MS = 30_000;

/** Root row indices of the /review-settings menu (see settings-menu.test.ts). */
const ROOT = { tools: 13, save: 16, cancel: 17 } as const;
/** Tools submenu row indices. */
const TOOLS = { topLevel: 0, executor: 1 } as const;

/**
 * A large synthetic inventory of MCP-style tool names: four families that
 * share a prefix and a near-match suffix scheme (`read_1`, `read_10`, ...),
 * plus a few plain native names. 123 tools in all.
 */
const SYNTHETIC_FAMILIES = ["alpha", "beta", "gamma", "delta"] as const;

function syntheticInventory(): { name: string; description: string }[] {
  const choices: { name: string; description: string }[] = [];
  for (const family of SYNTHETIC_FAMILIES) {
    for (let index = 0; index < 30; index += 1) {
      choices.push({ name: `mcp__${family}__read_${index}`, description: `Read ${family} record ${index}.` });
    }
  }
  choices.push({ name: "read", description: "Read files." });
  choices.push({ name: "bash", description: "Run shell commands." });
  choices.push({ name: "WebFetch", description: "Fetch a page." });
  return choices;
}

const SYNTHETIC_INVENTORY = syntheticInventory();
const INVENTORY_NAMES = SYNTHETIC_INVENTORY.map((choice) => choice.name);

/** A saved denial the live inventory no longer offers (a retained ghost row). */
const GHOST_TOOL = "mcp__ghost__absent_tool";

/** The picker rows the deny picker shows for the synthetic inventory. */
const PICKER_ROWS: DenyPickerRow[] = [
  ...SYNTHETIC_INVENTORY.map((choice) => ({
    key: `tool:${choice.name}`,
    label: `${choice.name}  ✗ allowed`,
    searchText: choice.name,
  })),
  { key: "back", label: "Back", searchText: "back", alwaysVisible: true },
];

const PICKER_TITLE = "Top-level tools — Enter toggles — 0 denied";

/** The tool rows (not chrome) of one rendered deny-picker frame. */
function toolRowsOf(frame: readonly string[]): string[] {
  return frame
    .map((line) => stripAnsi(line))
    .filter((line) => /(✓ denied|✗ allowed)\s*$/.test(line))
    .map((line) => line.replace(/^\s*(→\s*)?/, "").trim());
}

/** The tool NAMES shown by one rendered deny-picker frame, in order. */
function toolNamesOf(frame: readonly string[]): string[] {
  return toolRowsOf(frame).map((row) => row.split(/\s/)[0]!);
}

/** The highlighted row of one rendered frame (fake SelectList marks it with →). */
function highlightedOf(frame: readonly string[]): string | undefined {
  const line = frame.map((entry) => stripAnsi(entry)).find((entry) => /^\s*→/.test(entry));
  return line?.replace(/^\s*→\s*/, "").trim();
}

/** The query line rendered by the native Input ("> query"). */
function queryLineOf(frame: readonly string[]): string | undefined {
  return frame.map((line) => stripAnsi(line)).find((line) => line.startsWith("> ") || line === ">");
}

/** The real pi-tui components, pinned by this project's own dependency. */
function pinnedRealHost(): MenuTuiHost {
  return {
    SelectList: PinnedSelectList as unknown as MenuTuiHost["SelectList"],
    Container: PinnedContainer as unknown as MenuTuiHost["Container"],
    Text: PinnedText as unknown as MenuTuiHost["Text"],
    Input: PinnedInput as unknown as MenuTuiHost["Input"],
  };
}

interface DriveResult {
  /** Raw frames: the initial render, then one render after every key. */
  frames: string[][];
  picked: { key: string | undefined; query: string };
  /** The live component, for post-settle focus/render probes. */
  component: { render(width: number): string[]; focused?: boolean };
}

/**
 * Drives the deny picker through a host-faithful custom slot.
 *
 * Like the production host's showExtensionCustom, the slot settles ONLY when
 * the component calls `done()`, and it focuses a Focusable component once it
 * is shown. The drive is bounded: keys after the picker settled, scripted keys
 * that never settle it, or any fallback to another selector are recorded and
 * fail the test instead of leaving a promise pending.
 */
async function drivePicker(
  keys: readonly string[],
  options: {
    query?: string;
    rows?: readonly DenyPickerRow[];
    initialKey?: string;
    keybindings?: unknown;
    host?: MenuTuiHost;
    width?: number;
    saveControl?: SettingsSaveControl;
  } = {},
): Promise<DriveResult> {
  const frames: string[][] = [];
  const failures: string[] = [];
  const width = options.width ?? 80;
  let customCalls = 0;
  let component: DriveResult["component"] | undefined;
  const ui = {
    mode: "tui",
    ...(options.saveControl === undefined ? {} : { saveControl: options.saveControl }),
    custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | undefined) => void) => unknown): Promise<string | undefined> {
      customCalls += 1;
      return new Promise<string | undefined>((resolve, reject) => {
        if (customCalls > 1) {
          failures.push("the search picker fell back to another custom selector");
          reject(new Error("unexpected fallback"));
          return;
        }
        let settled = false;
        const done = (value: string | undefined): void => {
          if (settled) failures.push("done() was called twice");
          settled = true;
          resolve(value);
        };
        const shown = factory({ requestRender() {} }, IDENTITY_THEME, options.keybindings ?? null, done) as DriveResult["component"] & {
          handleInput(data: string): void;
        };
        component = shown;
        if ("focused" in shown) shown.focused = true;
        frames.push(shown.render(width));
        for (const [index, key] of keys.entries()) {
          if (settled) {
            failures.push(`scripted key ${index} arrived after the picker settled`);
            break;
          }
          shown.handleInput(key);
          frames.push(shown.render(width));
        }
        if (!settled) {
          failures.push("the scripted keys did not settle the picker");
          resolve(undefined);
        }
      });
    },
    async select(): Promise<string | undefined> {
      failures.push("the plain selector was used");
      return undefined;
    },
    notify() {},
  };
  setMenuTuiHost(options.host ?? createFakeMenuTuiHost());
  let picked: DriveResult["picked"];
  try {
    picked = await retainedDenySelect(ui as never, {
      title: PICKER_TITLE,
      rows: options.rows ?? PICKER_ROWS,
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(options.initialKey === undefined ? {} : { initialKey: options.initialKey }),
    });
  } finally {
    setMenuTuiHost(undefined);
  }
  assert.deepEqual(failures, [], "the scripted picker drive must settle exactly once");
  return { frames, picked, component: component! };
}

/** The plain-selector (RPC/fallback) context used for the non-TUI coverage. */
function scriptedContext(
  script: Array<(title: string, options: string[]) => string | undefined>,
): { context: unknown; calls: Array<{ title: string; options: string[] }> } {
  let index = 0;
  const calls: Array<{ title: string; options: string[] }> = [];
  const context = {
    scopedModels: [],
    ui: {
      async select(title: string, options: string[]): Promise<string | undefined> {
        calls.push({ title, options });
        // A bounded script: running out cancels instead of repeating a step.
        const step = script[index];
        index += 1;
        const value = step?.(title, options);
        if (value !== undefined) assert.ok(options.includes(value), `scripted selection not offered (${title}): ${value}`);
        return value;
      },
      notify() {},
    },
  };
  return { context, calls };
}

function commandHarness(): {
  pi: { registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }): void };
  handler: (args: string, ctx: unknown) => Promise<void>;
} {
  let handler: ((args: string, ctx: unknown) => unknown) | undefined;
  return {
    pi: {
      registerCommand(name, options) {
        if (name === "review-settings") handler = options.handler;
      },
    },
    handler: async (args, ctx) => {
      assert.ok(handler);
      await handler(args, ctx);
    },
  };
}

async function tempConfig(body: Record<string, unknown>): Promise<{
  dir: string;
  configPath: string;
  original: string;
  config: ReviewGateConfig;
}> {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-deny-search-"));
  const configPath = join(dir, "review-gate.json");
  const original = JSON.stringify(body);
  await writeFile(configPath, original, "utf8");
  return { dir, configPath, original, config: normalizeConfig(JSON.parse(original)) };
}

/**
 * Runs the registered /review-settings command over a scripted TUI harness
 * that fails boundedly, with a Ctrl+S-aware host and captured notices.
 */
async function runRegistered(
  configBody: Record<string, unknown>,
  steps: string[][],
  inventory: readonly { name: string; description: string }[] = SYNTHETIC_INVENTORY,
): Promise<{
  harness: TuiSettingsHarness;
  config: ReviewGateConfig;
  original: string;
  fileText: string;
  notices: Array<{ message: string; type?: string }>;
}> {
  const { dir, configPath, original, config } = await tempConfig(configBody);
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath, getToolChoices: () => inventory });
    const harness = createTuiSettingsContext(steps, { failUnresolvedSteps: true });
    const notices: Array<{ message: string; type?: string }> = [];
    setMenuTuiHost({ ...harness.host, matchesCtrlS: (data) => matchesKey(data, Key.ctrl("s")) });
    const base = harness.context as { ui: Record<string, unknown> };
    try {
      await registered.handler("", {
        ...(base as Record<string, unknown>),
        ui: { ...base.ui, notify: (message: string, type?: string) => notices.push({ message, type }) },
      });
    } finally {
      setMenuTuiHost(undefined);
    }
    assert.deepEqual(harness.failures(), [], "every scripted step must settle exactly its own menu");
    assert.equal(harness.exhausted(), false, "the scripted flow must not run out of steps");
    return { harness, config, original, fileText: await readFile(configPath, "utf8"), notices };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The pure filter and the shared saved-conversation grammar
// ---------------------------------------------------------------------------

test("the deny filter narrows a large synthetic inventory by tool name only", () => {
  assert.equal(PICKER_ROWS.length, 124, "the synthetic inventory is large");

  // An empty or whitespace query keeps every row in the inventory order.
  for (const query of ["", "   "]) {
    const all = filterDenyPickerRows(PICKER_ROWS, query);
    assert.deepEqual(all.visible.map((row) => row.key), PICKER_ROWS.map((row) => row.key));
  }

  // A family prefix narrows to that family, in inventory order (equal scores
  // keep the incoming order), and the Back row stays the last visible row.
  const family = filterDenyPickerRows(PICKER_ROWS, "mcp__beta__");
  assert.deepEqual(
    family.matches.map((row) => row.searchText),
    INVENTORY_NAMES.filter((name) => name.startsWith("mcp__beta__")),
  );
  assert.equal(family.visible.at(-1)?.key, "back");

  // A purpose/description phrase never matches: only the NAME is searched.
  assert.deepEqual(filterDenyPickerRows(PICKER_ROWS, '"Read files"').matches, []);
  assert.deepEqual(filterDenyPickerRows(PICKER_ROWS, "record").matches, []);

  // Near-match names: an exact quoted phrase keeps read_1 and its read_1x
  // neighbours, and a regex anchors to exactly one name.
  assert.deepEqual(
    filterDenyPickerRows(PICKER_ROWS, '"mcp__gamma__read_1"').matches.map((row) => row.searchText),
    ["mcp__gamma__read_1", ...Array.from({ length: 10 }, (_, index) => `mcp__gamma__read_1${index}`)],
  );
  assert.deepEqual(
    filterDenyPickerRows(PICKER_ROWS, "re:^mcp__gamma__read_1$").matches.map((row) => row.searchText),
    ["mcp__gamma__read_1"],
  );

  // A zero-match or unparsable query keeps only the Back row.
  for (const query of ["zzz-nothing-matches", "re:[", "re:"]) {
    const none = filterDenyPickerRows(PICKER_ROWS, query);
    assert.deepEqual(none.matches, [], query);
    assert.deepEqual(none.visible.map((row) => row.key), ["back"], query);
  }
});

const GRAMMAR_QUERIES = [
  "", "   ", "read", "READ", "mcp__beta__read_3", "b3", "mcp__alpha__ mcp__beta__", "gam rd 2",
  '"mcp__alpha__read_3"', '"MCP__ALPHA__READ_3"', 'mcp__delta "read_2"', '"mcp__beta', 'beta "',
  "re:^mcp__gamma__read_1", "re:read_(1|2)7", "RE:read", "re:", "re:  ", "re:[", "nope-nothing-matches",
];

test("the deny picker matches exactly like the shared saved-conversation search helper", () => {
  for (const query of GRAMMAR_QUERIES) {
    const shared = filterBySavedSearch(INVENTORY_NAMES, query, (name) => name);
    const picker = filterDenyPickerRows(
      INVENTORY_NAMES.map((name) => ({ key: `tool:${name}`, label: `${name} (purpose)`, searchText: name })),
      query,
    );
    assert.deepEqual(picker.matches.map((row) => row.searchText), shared, `query ${JSON.stringify(query)}`);
  }
  const parsed = parseSavedSearchQuery("re:^read$");
  assert.equal(parsed.mode, "regex");
  assert.deepEqual(matchSavedSearchText("read", parsed), { matches: true, score: 0 });
  const unbalanced = parseSavedSearchQuery('mcp__beta__ "read');
  assert.deepEqual(unbalanced.tokens, [{ kind: "fuzzy", value: "mcp__beta__" }, { kind: "fuzzy", value: '"read' }]);
});

test("the deny picker's tool-name search matches Pi's native /resume search reference", (t) => {
  const agentPackage = findInstalledAgentDirs().find((path) => {
    try {
      const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
      return manifest.name === "@earendil-works/pi-coding-agent" && manifest.version === "1.4.0";
    } catch { return false; }
  });
  if (!agentPackage) {
    skipOrFail(t, "no installed Pi 1.4.0 for native search parity");
    return;
  }
  // Reference-only import of the native selector search (the same reference
  // the saved-conversation parity test uses); production never loads it.
  const native = createRequire(join(agentPackage, "package.json"))(
    join(agentPackage, "dist", "modes", "interactive", "components", "session-selector-search.js"),
  ) as {
    parseSearchQuery(query: string): { mode: string; tokens: unknown[]; error?: string };
    filterAndSortSessions(sessions: unknown[], query: string, sortMode: "relevance"): Array<{ id: string }>;
  };
  // Synthetic "sessions" whose searched text is the tool name alone. A shared
  // modification time leaves score ties in inventory order, as in the picker.
  const modified = new Date(Date.UTC(2025, 0, 1));
  const sessions = INVENTORY_NAMES.map((name) => ({ id: name, name: undefined, allMessagesText: "", cwd: "", modified }));
  for (const query of GRAMMAR_QUERIES) {
    const ours = parseSavedSearchQuery(query);
    const theirs = native.parseSearchQuery(query);
    assert.equal(ours.mode, theirs.mode, `mode for ${JSON.stringify(query)}`);
    assert.deepEqual(ours.tokens, theirs.tokens, `tokens for ${JSON.stringify(query)}`);
    assert.equal(ours.error !== undefined, theirs.error !== undefined, `error for ${JSON.stringify(query)}`);
    // The native text appends empty fields, so an end-anchored regex is not
    // comparable; every other query must rank identically.
    if (/\$/.test(query)) continue;
    const expected = native.filterAndSortSessions(sessions, query, "relevance").map((session) => session.id);
    const actual = filterDenyPickerRows(PICKER_ROWS, query).matches.map((row) => row.searchText);
    assert.deepEqual(actual, expected, `ranking for ${JSON.stringify(query)}`);
  }
});

// ---------------------------------------------------------------------------
// The picker component: host contract, filtering, navigation, editing
// ---------------------------------------------------------------------------

test("the picker filters live, renders only the matches, and toggles the highlighted match", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { frames, picked } = await drivePicker([...typed("mcp__beta"), KEY_ENTER]);
  assert.deepEqual(picked, { key: "tool:mcp__beta__read_0", query: "mcp__beta" });

  // The initial frame: an empty native query line above the full inventory.
  assert.equal(queryLineOf(frames[0]!)?.trim(), ">");
  assert.deepEqual(toolNamesOf(frames[0]!), INVENTORY_NAMES);

  // After "m": every mcp__ name still matches (the native names do not).
  assert.deepEqual(toolNamesOf(frames[1]!), INVENTORY_NAMES.filter((name) => /m/i.test(name)));
  // After the full query: exactly the beta family, in inventory order.
  const narrowed = frames.at(-2)!;
  assert.equal(queryLineOf(narrowed)?.trim(), "> mcp__beta");
  assert.deepEqual(toolNamesOf(narrowed), INVENTORY_NAMES.filter((name) => name.startsWith("mcp__beta__")));
  assert.equal(highlightedOf(narrowed), "mcp__beta__read_0  ✗ allowed");
  assert.ok(narrowed.some((line) => stripAnsi(line).trim() === "Back"), "Back stays reachable");
});

test("the picker navigates the filtered results, keeps the highlighted identity, and clamps", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { frames, picked } = await drivePicker([
    ...typed("beta"), KEY_DOWN, KEY_DOWN, KEY_UP, // highlight beta read_1
    ...typed("_1"),                               // read_1 is still visible: identity kept
    KEY_DOWN,                                     // → read_10 within the narrowed list
    KEY_ENTER,
  ]);
  assert.deepEqual(picked, { key: "tool:mcp__beta__read_10", query: "beta_1" });
  const afterUp = frames[7]!;
  assert.equal(highlightedOf(afterUp), "mcp__beta__read_1  ✗ allowed");
  const afterNarrow = frames[9]!;
  assert.equal(highlightedOf(afterNarrow), "mcp__beta__read_1  ✗ allowed", "the highlighted row keeps its identity");
  assert.deepEqual(toolNamesOf(afterNarrow).slice(0, 3), ["mcp__beta__read_1", "mcp__beta__read_10", "mcp__beta__read_11"]);

  // A highlighted row hidden by the query falls back to the first visible row.
  const clamp = await drivePicker([...typed("beta"), ...down(5), ...typed("2"), KEY_ENTER]);
  assert.equal(clamp.picked.key, "tool:mcp__beta__read_2", "read_5 is hidden by beta2: the first match is highlighted");

  // Up from the first row wraps to the always-visible Back row.
  const wrap = await drivePicker([...typed("beta"), KEY_UP, KEY_ENTER]);
  assert.deepEqual(wrap.picked, { key: "back", query: "beta" });
});

test("a re-shown picker restores its query, caret, and highlighted row", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { frames, picked } = await drivePicker([...typed("_2"), KEY_ENTER], {
    query: "mcp__delta",
    initialKey: "tool:mcp__delta__read_3",
  });
  assert.equal(queryLineOf(frames[0]!)?.trim(), "> mcp__delta");
  assert.deepEqual(toolNamesOf(frames[0]!), INVENTORY_NAMES.filter((name) => name.startsWith("mcp__delta__")));
  assert.equal(highlightedOf(frames[0]!), "mcp__delta__read_3  ✗ allowed");
  // Typing continues at the end of the restored query.
  assert.deepEqual(picked, { key: "tool:mcp__delta__read_2", query: "mcp__delta_2" });
});

test("a zero-match query shows a truthful no-match state and Back/Escape stay usable", { timeout: TEST_TIMEOUT_MS }, async () => {
  const escape = await drivePicker([...typed("zzz"), KEY_ESCAPE]);
  assert.deepEqual(escape.picked, { key: undefined, query: "zzz" });
  const noMatch = escape.frames.at(-2)!.map((line) => stripAnsi(line));
  assert.ok(noMatch.some((line) => line.includes(NO_MATCHING_TOOLS_MESSAGE.trim())), noMatch.join("\n"));
  assert.deepEqual(toolRowsOf(noMatch), [], "no tool row is shown");
  assert.equal(highlightedOf(noMatch), "Back", "only Back is offered, so Enter cannot toggle a hidden tool");

  // Enter under a zero-match query chooses Back, never a hidden tool.
  const enter = await drivePicker([...typed("zzz"), KEY_ENTER]);
  assert.deepEqual(enter.picked, { key: "back", query: "zzz" });

  // The no-match state is editable: clearing the query restores the inventory.
  const recovered = await drivePicker([...typed("zzz"), ...backspaces(3), KEY_ESCAPE]);
  assert.deepEqual(toolNamesOf(recovered.frames.at(-2)!), INVENTORY_NAMES);
  assert.ok(!recovered.frames.at(-2)!.some((line) => line.includes(NO_MATCHING_TOOLS_MESSAGE.trim())));
});

test("leaving a zero-match state highlights the first match, so Enter toggles it", { timeout: TEST_TIMEOUT_MS }, async () => {
  // A regex typed key by key passes through the invalid `re:` (zero matches,
  // Back highlighted); once valid, the match is highlighted and toggled.
  const regex = await drivePicker([...typed("re:^mcp__beta__read_0$"), KEY_ENTER]);
  assert.equal(highlightedOf(regex.frames[3]!), "Back", "the invalid `re:` state offers only Back");
  assert.deepEqual(toolRowsOf(regex.frames.at(-2)!), ["mcp__beta__read_0  ✗ allowed"]);
  assert.equal(highlightedOf(regex.frames.at(-2)!), "mcp__beta__read_0  ✗ allowed");
  assert.deepEqual(regex.picked, { key: "tool:mcp__beta__read_0", query: "re:^mcp__beta__read_0$" });

  // A quoted phrase typed key by key is unbalanced (zero matches) until its
  // closing quote; the closed phrase highlights its first match.
  const phrase = await drivePicker([...typed('"mcp__gamma__read_1"'), KEY_ENTER]);
  assert.equal(highlightedOf(phrase.frames[1]!), "Back", "a lone quote matches no tool name");
  assert.equal(highlightedOf(phrase.frames.at(-2)!), "mcp__gamma__read_1  ✗ allowed");
  assert.deepEqual(phrase.picked, { key: "tool:mcp__gamma__read_1", query: '"mcp__gamma__read_1"' });

  // Clearing a zero-match query restores the inventory at its first row.
  const cleared = await drivePicker([...typed("zzz"), ...backspaces(3), KEY_ENTER]);
  assert.equal(highlightedOf(cleared.frames.at(-2)!), "mcp__alpha__read_0  ✗ allowed");
  assert.deepEqual(cleared.picked, { key: "tool:mcp__alpha__read_0", query: "" });

  // The real SelectList shows the restored inventory from its top, not
  // scrolled to the trailing Back row.
  const real = await drivePicker([...typed("zzz"), ...backspaces(3), KEY_ESCAPE], { host: pinnedRealHost() });
  const window = real.frames.at(-2)!.map((line) => stripAnsi(line));
  assert.ok(window.some((line) => /→\s*mcp__alpha__read_0\b/.test(line)), window.join("\n"));
  assert.ok(!window.some((line) => /^\s*→?\s*Back\s*$/.test(line)), "the window is not scrolled to Back");

  // A deliberate Back highlight among real matches is still kept by identity.
  const deliberate = await drivePicker([...typed("beta"), KEY_UP, "_", KEY_ENTER]);
  assert.deepEqual(deliberate.picked, { key: "back", query: "beta_" });
});

test("the query field edits with the native cursor, delete, and undo keys", { timeout: TEST_TIMEOUT_MS }, async () => {
  const cursor = await drivePicker([
    ...typed("beta"), KEY_END, KEY_BACKSPACE, KEY_LEFT, KEY_BACKSPACE, KEY_RIGHT, "z", KEY_ESCAPE,
  ]);
  assert.deepEqual(cursor.picked, { key: undefined, query: "btz" });
  assert.equal(queryLineOf(cursor.frames.at(-2)!)?.trim(), "> btz");

  // Ctrl+- undoes the typed word (the native Input coalesces word typing).
  const undo = await drivePicker([...typed("abc"), KEY_UNDO, KEY_ESCAPE]);
  assert.deepEqual(undo.picked, { key: undefined, query: "" });
});

test("a bracketed paste is opaque query text, even when split across chunks", { timeout: TEST_TIMEOUT_MS }, async () => {
  const saveControl: SettingsSaveControl = { saveRequested: false, suspended: 0, actionFence: createMenuActionFence() };
  const host = { ...createFakeMenuTuiHost(), matchesCtrlS: (data: string) => matchesKey(data, Key.ctrl("s")) };
  // The body carries Enter, Escape, Ctrl+S, and Ctrl+C bytes: none of them
  // may toggle, save, or leave the picker. The pasted text is exactly what
  // the native Input (the saved-conversation picker's field) keeps.
  const paste = `${PASTE_START}beta\r\x1b${CTRL_S}${CTRL_C}${PASTE_END}`;
  const reference = new PinnedInput();
  reference.handleInput(paste);
  const whole = await drivePicker([paste, KEY_ESCAPE], { host, saveControl });
  assert.equal(saveControl.saveRequested, false, "a pasted Ctrl+S byte never saves");
  assert.deepEqual(whole.picked, { key: undefined, query: reference.getValue() }, "only the final fresh Escape leaves");
  assert.ok(whole.picked.query.startsWith("beta"));
  assert.ok(!whole.picked.query.includes("\r"), "a pasted Enter is never a confirm");

  // A paste split across chunks, with its end marker split too, is still one
  // paste: the pasted Enter neither toggles nor ends the paste early.
  const split = await drivePicker([`${PASTE_START}mcp__del`, "ta\r", "\x1b[20", "1~", KEY_ENTER], { host, saveControl });
  assert.equal(queryLineOf(split.frames[4]!)?.trim(), "> mcp__delta");
  assert.deepEqual(toolNamesOf(split.frames[4]!), INVENTORY_NAMES.filter((name) => name.startsWith("mcp__delta__")));
  assert.deepEqual(split.picked, { key: "tool:mcp__delta__read_0", query: "mcp__delta" });
  assert.equal(saveControl.saveRequested, false);
});

test("held keys never replay host actions while navigation and editing repeat", { timeout: TEST_TIMEOUT_MS }, async () => {
  const saveControl: SettingsSaveControl = { saveRequested: false, suspended: 0, actionFence: createMenuActionFence() };
  const host = { ...createFakeMenuTuiHost(), matchesCtrlS: (data: string) => matchesKey(data, Key.ctrl("s")) };
  const { frames, picked } = await drivePicker([
    ...typed("bet"),
    REPEAT_A,        // an editing repeat inserts its character
    REPEAT_ENTER,    // never toggles
    REPEAT_ESCAPE,   // never leaves
    RELEASE_ESCAPE,  // never leaves
    REPEAT_CTRL_S,   // never saves
    KEY_DOWN, REPEAT_DOWN, // navigation repeats keep navigating
    KEY_ENTER,
  ], { host, saveControl });
  assert.equal(saveControl.saveRequested, false);
  assert.equal(queryLineOf(frames[4]!)?.trim(), "> beta");
  assert.deepEqual(picked, { key: "tool:mcp__beta__read_2", query: "beta" });
});

test("a fresh Ctrl+S in the picker latches the canonical save and settles once", { timeout: TEST_TIMEOUT_MS }, async () => {
  const saveControl: SettingsSaveControl = { saveRequested: false, suspended: 0, actionFence: createMenuActionFence() };
  const host = { ...createFakeMenuTuiHost(), matchesCtrlS: (data: string) => matchesKey(data, Key.ctrl("s")) };
  const { frames, picked } = await drivePicker([...typed("beta"), CTRL_S], { host, saveControl });
  assert.deepEqual(picked, { key: undefined, query: "beta" });
  assert.equal(saveControl.saveRequested, true);
  assert.ok(stripAnsi(frames[0]!.join("\n")).includes("Ctrl+S save"), "the hint offers the save chord");
});

test("the picker resolves its actions through the host's live keybindings manager", { timeout: TEST_TIMEOUT_MS }, async () => {
  const manager = new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": "ctrl+p",
    "tui.select.down": "ctrl+n",
    "tui.select.confirm": "ctrl+o",
    "tui.select.cancel": "ctrl+g",
  });
  // The remapped down/confirm keys act; the default down arrow no longer moves.
  const remapped = await drivePicker([...typed("beta"), KEY_DOWN, "\x0e", "\x0f"], { keybindings: manager });
  assert.deepEqual(remapped.picked, { key: "tool:mcp__beta__read_1", query: "beta" });
  assert.equal(highlightedOf(remapped.frames[5]!), "mcp__beta__read_0  ✗ allowed", "the default arrow is inert under a remap");
  // The remapped cancel leaves; the default Escape does not.
  const cancel = await drivePicker([...typed("beta"), KEY_ESCAPE, "\x07"], { keybindings: manager });
  assert.deepEqual(cancel.picked, { key: undefined, query: "beta" });

  // Without a manager, Pi's default chords apply, including Ctrl+C cancel.
  const ctrlC = await drivePicker([...typed("beta"), CTRL_C]);
  assert.deepEqual(ctrlC.picked, { key: undefined, query: "beta" });
});

test("the real pi-tui Input and SelectList scroll, fit the width, and follow host focus", { timeout: TEST_TIMEOUT_MS }, async () => {
  const host = pinnedRealHost();
  // Scroll: the real SelectList shows a bounded window that follows the
  // highlighted match through the 30-row narrowed family.
  const scrolled = await drivePicker([...typed("gamma"), ...down(15), KEY_ENTER], { host });
  assert.deepEqual(scrolled.picked, { key: "tool:mcp__gamma__read_15", query: "gamma" });
  const window = scrolled.frames.at(-2)!.map((line) => stripAnsi(line));
  assert.ok(window.some((line) => /→\s*mcp__gamma__read_15\b/.test(line)), window.join("\n"));
  assert.ok(!window.some((line) => /mcp__gamma__read_0\b/.test(line)), "the window scrolled past the first match");
  assert.ok(!window.some((line) => /mcp__alpha__/.test(line)), "only the matches are listed");

  // Width/resize: every rendered line fits each requested width, including
  // the no-match line and the query line.
  const resized = await drivePicker([...typed("zzzz"), KEY_ESCAPE], { host, width: 24 });
  for (const width of [80, 24, 12, 60]) {
    for (const line of resized.component.render(width)) {
      assert.ok(visibleWidth(line) <= width, `line exceeds ${width}: ${JSON.stringify(line)}`);
    }
  }
  assert.ok(resized.frames.at(-2)!.some((line) => stripAnsi(line).includes("No matching")), "no-match renders at a narrow width");

  // Focus: the host focuses the component, which propagates focus to the
  // native Input so the IME cursor marker lands in the query line.
  const focus = await drivePicker([...typed("beta"), KEY_ESCAPE], { host });
  assert.equal(focus.component.focused, true);
  const focusedQuery = focus.frames[0]!.find((line) => line.includes(CURSOR_MARKER));
  assert.ok(focusedQuery !== undefined, "the focused query line carries the IME cursor marker");
  focus.component.focused = false;
  assert.ok(!focus.component.render(80).some((line) => line.includes(CURSOR_MARKER)), "an unfocused picker draws no IME cursor");
});

test("a host peer without the native Input keeps the existing full-list retained menu", { timeout: TEST_TIMEOUT_MS }, async () => {
  const withoutInput: MenuTuiHost = { ...createFakeMenuTuiHost() };
  delete withoutInput.Input;
  const frames: string[][] = [];
  const ui = {
    mode: "tui",
    custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | undefined) => void) => unknown): Promise<string | undefined> {
      return new Promise<string | undefined>((resolve) => {
        const component = factory({ requestRender() {} }, IDENTITY_THEME, null, resolve) as {
          render(width: number): string[];
          handleInput(data: string): void;
        };
        frames.push(component.render(80));
        component.handleInput(KEY_ESCAPE);
      });
    },
    async select(): Promise<string | undefined> {
      return undefined;
    },
  };
  setMenuTuiHost(withoutInput);
  try {
    const picked = await retainedDenySelect(ui as never, { title: PICKER_TITLE, rows: PICKER_ROWS, query: "beta" });
    assert.deepEqual(picked, { key: undefined, query: "beta" });
  } finally {
    setMenuTuiHost(undefined);
  }
  assert.equal(queryLineOf(frames[0]!), undefined, "no query field without the native Input");
  assert.deepEqual(toolNamesOf(frames[0]!), INVENTORY_NAMES, "the full, unfiltered list in the original order");
});

// ---------------------------------------------------------------------------
// The registered /review-settings path: both roles, full resulting config
// ---------------------------------------------------------------------------

/**
 * The scripted registered flow for one role. Each picker presentation is
 * its own step (the picker is re-shown after every toggle, retaining its
 * query); closing the picker re-shows Tools, and closing Tools re-shows the
 * root, so every level consumes one step.
 */
function roleFlowSteps(role: "topLevel" | "executor", rootFinal: string[]): string[][] {
  return [
    [...down(ROOT.tools), KEY_ENTER],                                  // 0 root → Tools
    [...down(TOOLS[role]), KEY_ENTER],                                 // 1 Tools → picker
    [...typed("mcp__beta"), KEY_ENTER],                                // 2 narrow, toggle beta read_0
    [...backspaces(4), ...typed("gamma"), KEY_DOWN, KEY_ENTER],        // 3 change query, toggle gamma read_1
    [...backspaces("mcp__gamma".length), ...typed("ghost"), KEY_ENTER], // 4 find + reverse the unavailable denial
    [...backspaces("ghost".length), ...typed("zzzz"), KEY_ESCAPE],     // 5 zero-match, leave without toggling
    [KEY_ESCAPE],                                                      // 6 Tools → root
    rootFinal,                                                         // 7 root: Save / Escape / Cancel
  ];
}

function roleConfig(role: "topLevel" | "executor"): Record<string, unknown> {
  // The edited role opens with a hidden prechecked denial and an unavailable
  // saved name; the other role has its own denial that must stay untouched.
  const edited = ["mcp__alpha__read_5", GHOST_TOOL];
  const other = ["mcp__delta__read_9"];
  return {
    enabled: false,
    review: { activeReviewers: [] },
    tools: role === "topLevel"
      ? { topLevelDeny: edited, executorDeny: other }
      : { topLevelDeny: other, executorDeny: edited },
  };
}

const EDITED_RESULT = ["mcp__alpha__read_5", "mcp__beta__read_0", "mcp__gamma__read_1"];

function expectedTools(role: "topLevel" | "executor", edited: string[]): { topLevelDeny: string[]; executorDeny: string[] } {
  const other = ["mcp__delta__read_9"];
  return role === "topLevel" ? { topLevelDeny: edited, executorDeny: other } : { topLevelDeny: other, executorDeny: edited };
}

for (const role of ["topLevel", "executor"] as const) {
  test(`${role}: the registered picker renders narrowed results and saves the complete denial set`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const run = await runRegistered(roleConfig(role), roleFlowSteps(role, [...down(ROOT.save - ROOT.tools), KEY_ENTER]));
    const steps = run.harness.framesByStep;
    const title = role === "topLevel" ? "Top-level tools" : "Executor tools";

    // Presentation 1: the full inventory plus the retained ghost row, with
    // the hidden prechecked denial checked and an empty query.
    const opened = steps[2]![0]!;
    assert.ok(stripAnsi(opened.join("\n")).includes(`${title} — Enter toggles — 2 denied`));
    assert.equal(queryLineOf(opened)?.trim(), ">");
    assert.deepEqual(toolNamesOf(opened), [...INVENTORY_NAMES, GHOST_TOOL]);
    assert.ok(toolRowsOf(opened).includes("mcp__alpha__read_5 (Read alpha record 5)  ✓ denied"));
    assert.ok(toolRowsOf(opened).includes(`${GHOST_TOOL} [not currently available]  ✓ denied`));
    const betaFamily = INVENTORY_NAMES.filter((name) => name.startsWith("mcp__beta__"));
    assert.deepEqual(toolNamesOf(steps[2]!.at(-2)!), betaFamily, "typing narrows to the beta family");

    // Presentation 2: the re-show keeps the query and the toggled row's
    // identity, now checked; the changed query narrows to gamma.
    const reshown = steps[3]![0]!;
    assert.equal(queryLineOf(reshown)?.trim(), "> mcp__beta");
    assert.deepEqual(toolNamesOf(reshown), betaFamily);
    assert.equal(highlightedOf(reshown), "mcp__beta__read_0 (Read beta record 0)  ✓ denied");
    const gammaFrame = steps[3]!.at(-3)!;
    assert.equal(queryLineOf(gammaFrame)?.trim(), "> mcp__gamma");
    assert.deepEqual(toolNamesOf(gammaFrame), INVENTORY_NAMES.filter((name) => name.startsWith("mcp__gamma__")));

    // Presentation 3: the unavailable saved name is findable by name and
    // shown as denied before the toggle reverses it.
    const ghostFrame = steps[4]!.at(-2)!;
    assert.deepEqual(toolRowsOf(ghostFrame), [`${GHOST_TOOL} [not currently available]  ✓ denied`]);

    // Presentation 4: the reversed ghost row stays a configured row; a
    // zero-match query renders the truthful no-match state with Back only.
    assert.deepEqual(toolRowsOf(steps[5]![0]!), [`${GHOST_TOOL} [not currently available]  ✗ allowed`]);
    const noMatch = steps[5]!.at(-2)!;
    assert.ok(noMatch.some((line) => stripAnsi(line).includes(NO_MATCHING_TOOLS_MESSAGE.trim())));
    assert.deepEqual(toolRowsOf(noMatch), []);

    // The COMPLETE set is saved: the hidden prechecked denial survived every
    // query, both toggles landed, the ghost was reversed, the other role is
    // untouched, and no query is stored anywhere.
    const saved = JSON.parse(run.fileText);
    assert.deepEqual(saved.tools, expectedTools(role, EDITED_RESULT));
    assert.deepEqual(run.config.tools, expectedTools(role, EDITED_RESULT));
    assert.deepEqual(Object.keys(saved.tools).sort(), ["executorDeny", "topLevelDeny"]);
    assert.ok(!run.fileText.includes("zzzz") && !run.fileText.includes("\"ghost\""), "the query is never persisted");
    assert.ok(run.notices.some((notice) => notice.message === "Review settings saved."));
  });

  test(`${role}: root Escape applies the complete set for the session without writing`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const run = await runRegistered(roleConfig(role), roleFlowSteps(role, [KEY_ESCAPE]));
    assert.deepEqual(run.config.tools, expectedTools(role, EDITED_RESULT));
    assert.equal(run.fileText, run.original, "a session apply never writes the config file");
  });

  test(`${role}: an explicit Cancel discards every toggle`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const run = await runRegistered(roleConfig(role), roleFlowSteps(role, [...down(ROOT.cancel - ROOT.tools), KEY_ENTER]));
    assert.deepEqual(run.config.tools, expectedTools(role, ["mcp__alpha__read_5", GHOST_TOOL]));
    assert.equal(run.fileText, run.original, "Cancel writes nothing");
  });

  test(`${role}: Ctrl+S inside a narrowed picker saves the whole draft`, { timeout: TEST_TIMEOUT_MS }, async () => {
    const run = await runRegistered(roleConfig(role), [
      [...down(ROOT.tools), KEY_ENTER],
      [...down(TOOLS[role]), KEY_ENTER],
      [...typed("mcp__beta"), KEY_ENTER],
      [CTRL_S],
    ]);
    const saved = JSON.parse(run.fileText);
    assert.deepEqual(saved.tools, expectedTools(role, ["mcp__alpha__read_5", GHOST_TOOL, "mcp__beta__read_0"]));
    assert.ok(run.notices.some((notice) => notice.message === "Review settings saved."));
  });
}

test("the two pickers keep independent queries and independent selections", { timeout: TEST_TIMEOUT_MS }, async () => {
  const run = await runRegistered({ enabled: false, review: { activeReviewers: [] } }, [
    [...down(ROOT.tools), KEY_ENTER],                     // 0 root → Tools
    [KEY_ENTER],                                          // 1 Tools → Top-level tools
    [...typed("alpha"), KEY_ENTER],                       // 2 toggle alpha read_0
    [KEY_ESCAPE],                                         // 3 leave the picker
    [...down(TOOLS.executor), KEY_ENTER],                 // 4 Tools → Executor tools
    [...typed("gam"), KEY_ENTER],                         // 5 its OWN empty query
    [KEY_ESCAPE],                                         // 6 leave the executor picker
    [KEY_UP, KEY_ENTER],                                  // 7 Tools → Top-level tools again
    [KEY_ESCAPE],                                         // 8 a fresh presentation, fresh query
    [KEY_ESCAPE],                                         // 9 Tools → root
    [...down(ROOT.save - ROOT.tools), KEY_ENTER],         // 10 Save
  ]);
  const executorOpened = run.harness.framesByStep[5]![0]!;
  assert.ok(stripAnsi(executorOpened.join("\n")).includes("Executor tools — Enter toggles — 0 denied"));
  assert.equal(queryLineOf(executorOpened)?.trim(), ">", "the executor picker never inherits the top-level query");
  assert.deepEqual(toolNamesOf(executorOpened), INVENTORY_NAMES);
  // Re-entering a picker from Tools starts a new transient query.
  assert.equal(queryLineOf(run.harness.framesByStep[8]![0]!)?.trim(), ">");
  const saved = JSON.parse(run.fileText);
  assert.deepEqual(saved.tools, { topLevelDeny: ["mcp__alpha__read_0"], executorDeny: ["mcp__gamma__read_0"] });
});

test("held keys never cross presentations: a repeated Enter, Escape, or Ctrl+S is fenced", { timeout: TEST_TIMEOUT_MS }, async () => {
  const run = await runRegistered({ enabled: false, review: { activeReviewers: [] } }, [
    [...down(ROOT.tools), KEY_ENTER],          // 0 root → Tools
    [KEY_ENTER],                               // 1 Tools → Top-level tools
    [...typed("beta"), KEY_ENTER],             // 2 toggle beta read_0
    [REPEAT_ENTER, REPEAT_CTRL_S, KEY_ESCAPE], // 3 the held Enter/Ctrl+S never act; a fresh Escape leaves
    [REPEAT_ESCAPE, KEY_ESCAPE],               // 4 Tools: the held Escape never closes it; a fresh one does
    [REPEAT_ESCAPE, KEY_ESCAPE],               // 5 root: the held Escape never applies; a fresh one does
  ]);
  assert.deepEqual(run.config.tools, { topLevelDeny: ["mcp__beta__read_0"], executorDeny: [] });
  assert.equal(run.fileText, run.original, "no held key saved the draft");
});

test("a plain (RPC) host keeps the full unfiltered deny list", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { dir, configPath, config } = await tempConfig({ enabled: false, review: { activeReviewers: [] } });
  try {
    const registered = commandHarness();
    registerReviewSettings({ pi: registered.pi, config, configPath, getToolChoices: () => SYNTHETIC_INVENTORY });
    const { context, calls } = scriptedContext([
      (_title, options) => options.find((option) => option.startsWith("Tools"))!,
      (_title, options) => options.find((option) => option.startsWith("Top-level tools"))!,
      (title, options) => {
        assert.match(title, /^Top-level tools — Enter toggles — 0 denied$/);
        assert.equal(options.length, SYNTHETIC_INVENTORY.length + 1, "every tool plus Back, unfiltered");
        assert.deepEqual(options.slice(0, 3), [
          "mcp__alpha__read_0 (Read alpha record 0)  ✗ allowed",
          "mcp__alpha__read_1 (Read alpha record 1)  ✗ allowed",
          "mcp__alpha__read_2 (Read alpha record 2)  ✗ allowed",
        ]);
        assert.equal(options.at(-1), "Back");
        return "read (Read files)  ✗ allowed";
      },
      () => "Back",
      () => "Back",
      () => "Cancel",
    ]);
    await registered.handler("", context);
    assert.equal(calls.length, 6);
    for (const call of calls) assert.doesNotMatch(call.title, /search/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the persisted tools configuration never carries a query", { timeout: TEST_TIMEOUT_MS }, async () => {
  const { dir, configPath } = await tempConfig({ enabled: false, review: { activeReviewers: [] } });
  try {
    const staged = await persistReviewSettings(configPath, {
      operatingMode: "execute",
      modeCycleShortcut: "alt+m",
      workerResources: {},
      primaryReviewers: [],
      subtaskReviewers: [],
      primaryEnabled: false,
      subtaskEnabled: false,
      reviewLandedChanges: false,
      reviewerTimeoutMs: 600_000,
      executorTimeoutMs: 1_800_000,
      maxCorrectionCycles: 1,
      implementationGuidanceAfterCorrectionAttempts: 1,
      retainBundles: "on-failure",
      deleteSpawnedPiSessionsOnCleanup: false,
      maxWorkers: 2,
      retryPolicy: { maxRetries: 2, baseDelayMs: 1_000, maxDelayMs: 30_000, maxSameIncidentRepeats: 2, jitter: false },
      subtaskNotifications: "quiet",
      subtasksViewExpanded: false,
      tools: { topLevelDeny: ["mcp__beta__read_0"], executorDeny: [] },
    });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(saved.tools, { topLevelDeny: ["mcp__beta__read_0"], executorDeny: [] });
    assert.deepEqual(staged.tools, { topLevelDeny: ["mcp__beta__read_0"], executorDeny: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
