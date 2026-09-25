/**
 * Scheduled image Save driven through the REAL installed Pi native editor
 * host (issue: scheduled image Save — native host tier).
 *
 * tests/scheduled-image-assets.test.ts exercises the full /review-settings
 * Save flow but with a structural FakeCustomEditor, and
 * tests/native-editor-bridge.test.ts drives the real installed Pi
 * CustomEditor only against a bare `editTextWithNativeEditor` call. This file
 * closes the remaining gap: the actual `registerReviewSettings` command/menu
 * route with the native CustomEditor acquired through the host's public
 * `setEditorComponent` seam and embedded in `ctx.ui.custom`, and a REAL
 * Ctrl+V ("\x16") dispatched through the embedded component's handleInput
 * into the native CustomEditor's `app.clipboard.pasteImage` keybinding
 * dispatch, whose `onPasteImage` host callback inserts a REAL UUID-named temp
 * PNG path created by this test — then field submit, root Save, and the
 * durable managed-asset invariants.
 *
 * EXACT COVERAGE LIMITS (stated, not implied):
 *
 * - Covered: the installed pi 0.87.1 `CustomEditor` (extends the real pi-tui
 *   `Editor`) created through the production bridge factory; the real
 *   KeybindingsManager over pi-tui's TUI definitions plus the app-level
 *   defaults (including `app.clipboard.pasteImage` = ctrl+v); the real
 *   dispatch chain component.handleInput(Ctrl+V) → CustomEditor's pasteImage
 *   branch → the `onPasteImage` callback wired the way the host wires it
 *   (dist/modes/interactive/components/custom-editor.js dispatches the
 *   keybinding; interactive-mode.js `handleClipboardPaste`'s terminal act is
 *   `this.editor.insertTextAtCursor?.(filePath)`); the bridge's
 *   observation-only onHostInsert seam recording the insert; Save copying the
 *   validated image into the private managed store.
 * - Simulated host acts (documented, never claimed as real): the
 *   `onPasteImage` callback is wired by this test. The inserted file is a
 *   REAL temp PNG (genuine `pi-clipboard-<UUID>.png` naming, real image
 *   bytes), but NO actual OS clipboard bytes were read or written, Pi's
 *   `handleClipboardPaste`/`readClipboardImage` image-decoding path was NOT
 *   executed, and NO Pi app main-loop input handler or terminal PTY was
 *   exercised — keys are dispatched directly through the embedded component's
 *   public `handleInput`, not through a real terminal.
 * - Menus render through the fake pi-tui SelectList stand-ins
 *   (tests/menu-tui-fakes.ts); the real SelectList component is covered by
 *   the settings-menu tests. The native field editor is the point here.
 * - Other native editor behaviors (completion, Esc list dismissal, Ctrl+C,
 *   Ctrl+G, external editing) are covered in
 *   tests/native-editor-bridge.test.ts; asset-transaction edge cases and the
 *   fake-wiring flow tiers live in tests/scheduled-image-assets.test.ts.
 *
 * Host gate: with no resolvable installed Pi, tests skip with a clear note;
 * `PI_REVIEW_GATE_REQUIRE_PI_HOST=1` turns that skip into a hard failure so
 * any environment that has Pi enforces these tests.
 */

import assert from "node:assert/strict";
import { dirname, isAbsolute, join } from "node:path";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { registerReviewSettings } from "../src/settings/command";
import { setMenuTuiHost } from "../src/settings/menu";
import {
  assertScheduledImagesPresent,
  managedScheduledImageRoot,
} from "../src/settings/scheduled-image-assets";
import { setNativeEditorHost, __resetActiveNativeEditorFieldForTest } from "../src/native-editor-bridge";
import { createFakeMenuTuiHost, KEY_DOWN, KEY_ENTER, KEY_ESCAPE } from "./menu-tui-fakes";
import {
  CTRL_V,
  ENTER,
  REAL_IDENTITY_THEME,
  createBridgeUi,
  createRealKeybindingsManager,
  loadRealBridgeHost,
  realHostAfter,
  skipOrFail,
  type BridgeUiState,
  type RealBridgeHost,
} from "./bridge-fakes";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal genuine PNG header + payload, with content sniffing in mind. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 7),
]);

/** The staged instructions prefix the pasted path is appended behind. */
const SCREENSHOT_PREFIX = "Analyze the attached screenshot";

/**
 * Writes a REAL image file at Pi's genuine clipboard-temp naming
 * (`pi-clipboard-<UUID>.png` in the OS temp dir). The test that created it
 * removes it in its own finally; random UUID prevents collisions.
 */
async function writeClipboardTempImage(bytes: Buffer = PNG_BYTES): Promise<string> {
  const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

function flowConfig(dir: string): Record<string, unknown> {
  return {
    scheduledTasks: {
      "task-nativeaa": {
        name: "Screenshot triage",
        cron: "30 2 * * *",
        enabled: true,
        kind: "execute",
        // normalizeConfig trims staged instructions, so the prefill ends
        // without whitespace — exactly like any reopened entry. The field
        // driver therefore types a real space through the native editor
        // before the Ctrl+V, matching what a real user does; the native
        // paste itself inserts the BARE temp path (no leading space),
        // exactly as Pi's own handleClipboardPaste does.
        instructions: SCREENSHOT_PREFIX,
        workspace: dir,
      },
      "task-nativebb": {
        name: "Untouched sibling",
        cron: "0 9 * * mon",
        enabled: true,
        kind: "research",
        instructions: "Summarize upstream releases",
        workspace: dir,
      },
    },
  };
}

const keys = (...sequence: string[]): ((component: { handleInput?(data: string): void }) => void) =>
  (component) => {
    for (const key of sequence) component.handleInput?.(key);
  };

interface FlowResult {
  notifyCalls: Array<{ message: string; type?: string }>;
  state: BridgeUiState;
  /** How many times the simulated onPasteImage host callback actually fired. */
  pasteFired: number;
}

/**
 * One scripted /review-settings flow against the real installed Pi host.
 * Menus drive fake SelectList stand-ins; the instructions field is the REAL
 * native CustomEditor, and `paste` is dispatched as a REAL Ctrl+V keypress
 * through the embedded component (the simulated host's onPasteImage terminal
 * act inserts the bare temp path via the editor's public insertTextAtCursor,
 * exactly as Pi's own handler does).
 */
async function runNativeImageFlow(
  loaded: RealBridgeHost,
  dir: string,
  options: { paste: string; fieldSettle: "submit" | "cancel"; outcome: "save" | "cancel" },
): Promise<FlowResult> {
  let pasteFired = 0;
  setMenuTuiHost(createFakeMenuTuiHost());
  setNativeEditorHost(loaded.host);
  const keybindings = createRealKeybindingsManager(loaded.tui);
  const configPath = join(dir, "review-gate.json");
  await writeFile(configPath, JSON.stringify(flowConfig(dir), null, 2));
  const config = normalizeConfig(JSON.parse(await readFile(configPath, "utf8")));
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  registerReviewSettings({
    pi: {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
        if (name === "review-settings") handler = options.handler;
      },
    },
    config,
    configPath,
  });
  assert.ok(handler, "the /review-settings command registered");

  const notifyCalls: Array<{ message: string; type?: string }> = [];
  const { ui, state } = createBridgeUi({
    theme: REAL_IDENTITY_THEME,
    keybindings,
    draft: "chat draft",
    // Wired the way the Pi host wires it (interactive-mode.js): the callback
    // captures the editor and inserts the temp file path at the cursor —
    // bare, no leading space. No OS clipboard is read here.
    onPasteImage: (editor) => () => {
      pasteFired += 1;
      editor.insertTextAtCursor(options.paste);
    },
    drivers: [
      keys(...Array(14).fill(KEY_DOWN), KEY_ENTER), // root → Scheduled tasks (row 14)
      keys(KEY_ENTER), // list → task entry (row 0)
      keys(KEY_DOWN, KEY_DOWN, KEY_DOWN, KEY_ENTER), // entry editor → instructions (row 3)
      async (component: { handleInput?(data: string): void }): Promise<void> => {
        component.handleInput?.(" "); // a real space keystroke: delimiter before the paste
        component.handleInput?.(CTRL_V); // real keypress through the native editor
        component.handleInput?.(options.fieldSettle === "cancel" ? KEY_ESCAPE : ENTER);
      },
      keys(...Array(6).fill(KEY_DOWN), KEY_ENTER), // entry re-show (instructions, row 3) → Back (row 9)
      keys(...Array(3).fill(KEY_DOWN), KEY_ENTER), // list re-show (two entries) → Back (row 3)
      ...(options.outcome === "cancel"
        ? [keys(KEY_ESCAPE)] // root: leave without saving
        : [
            keys(KEY_DOWN, KEY_DOWN, KEY_ENTER), // root re-show (retained "scheduled", row 14) → Save (row 16)
          ]),
    ],
  });
  const wrapped = {
    ...ui,
    notify(message: string, type?: string): void {
      notifyCalls.push({ message, type });
    },
    async select(): Promise<string | undefined> {
      throw new Error("plain select must not be used in TUI mode with a loadable host");
    },
  };
  let watchdog: NodeJS.Timeout | undefined;
  try {
    // A watchdog keeps a mis-driven flow from hanging forever on an
    // unresolved custom slot (e.g. after a failed Save re-shows the root).
    await Promise.race([
      handler!("", { mode: "tui", scopedModels: [], cwd: dir, ui: wrapped }),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error(
          `the /review-settings flow did not settle within 30s; notices so far: ${JSON.stringify(notifyCalls)}`,
        )), 30_000);
        watchdog.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(watchdog);
    setMenuTuiHost(undefined);
    setNativeEditorHost(undefined);
    __resetActiveNativeEditorFieldForTest();
  }
  return { notifyCalls, state, pasteFired };
}

// ---------------------------------------------------------------------------
// The real-host Save flow
// ---------------------------------------------------------------------------

test("real installed Pi host: native Ctrl+V in scheduled instructions is copied to the managed store at Save", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  realHostAfter(t);

  const dir = await mkdtemp(join(tmpdir(), "pi-sched-native-"));
  const temp = await writeClipboardTempImage();
  try {
    const { notifyCalls, state, pasteFired } = await runNativeImageFlow(loaded, dir, {
      paste: temp,
      fieldSettle: "submit",
      outcome: "save",
    });
    assert.equal(pasteFired, 1, "the real Ctrl+V reached the native onPasteImage host callback exactly once");
    assert.deepEqual(notifyCalls.filter((call) => call.type === "error"), [], "Save succeeded cleanly");

    const saved = JSON.parse(await readFile(configPathOf(dir), "utf8")) as { scheduledTasks: Record<string, { instructions: string }> };
    const instructions = saved.scheduledTasks["task-nativeaa"]!.instructions;
    const prefix = `${SCREENSHOT_PREFIX} `;
    assert.ok(instructions.startsWith(prefix), `the rewritten instructions keep the prefix: ${instructions}`);
    const managed = instructions.slice(prefix.length);
    assert.ok(managed.length > 0, "a managed path was persisted");
    assert.equal(isAbsolute(managed), true, `the managed path is absolute: ${managed}`);
    const root = managedScheduledImageRoot(configPathOf(dir));
    assert.ok(
      managed.startsWith(join(root, "task-nativeaa") + "/"),
      `the managed path is in the per-task store: ${managed}`,
    );

    // No temporary path anywhere in the persisted config.
    const configText = await readFile(configPathOf(dir), "utf8");
    assert.ok(!configText.includes(temp), "the temporary clipboard path is gone from the config");

    // The managed copy carries the EXACT validated bytes with private modes.
    assert.deepEqual(await readFile(managed), PNG_BYTES, "the managed copy carries the exact image bytes");
    assert.equal((await stat(managed)).mode & 0o777, 0o600, "managed files are private 0600");
    assert.equal((await stat(dirname(managed))).mode & 0o777, 0o700, "per-task directories are private 0700");
    assert.equal((await stat(root)).mode & 0o777, 0o700, "the managed store root is private 0700");

    // The source temp file was never moved or mutated.
    assert.deepEqual(await readFile(temp), PNG_BYTES, "the clipboard temp source is untouched");

    // Future-run present check: a later run can resolve the managed asset.
    await assertScheduledImagesPresent(instructions, root);

    // The sibling entry is untouched, and the editor invariants held.
    assert.equal(saved.scheduledTasks["task-nativebb"]!.instructions, "Summarize upstream releases");
    assert.equal(state.draft, "chat draft", "the normal chat draft was restored into the default editor");
    assert.deepEqual(state.chatSubmits, [], "no chat message was submitted from the field");
    assert.equal(state.shutdowns, 0, "the host exit/interrupt path never fired");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(temp, { force: true });
  }
});

test("real installed Pi host: cancel after a native Ctrl+V copies nothing and leaves the config unchanged", async (t) => {
  const loaded = await loadRealBridgeHost();
  if (!loaded) {
    skipOrFail(t, "no installed Pi is resolvable in this environment");
    return;
  }
  realHostAfter(t);

  const dir = await mkdtemp(join(tmpdir(), "pi-sched-native-cancel-"));
  const temp = await writeClipboardTempImage();
  try {
    const { notifyCalls, state, pasteFired } = await runNativeImageFlow(loaded, dir, {
      paste: temp,
      fieldSettle: "cancel",
      outcome: "cancel",
    });
    assert.equal(pasteFired, 1, "the real Ctrl+V reached the native onPasteImage host callback");
    assert.deepEqual(notifyCalls.filter((call) => call.type === "error"), []);

    const configText = await readFile(configPathOf(dir), "utf8");
    const saved = JSON.parse(configText) as { scheduledTasks: Record<string, { instructions: string }> };
    assert.equal(saved.scheduledTasks["task-nativeaa"]!.instructions, SCREENSHOT_PREFIX, "the staged entry is byte-identical");
    assert.ok(!configText.includes(temp), "the cancelled paste staged nothing");
    assert.equal(
      await stat(join(dir, "scheduled-image-assets")).then(() => true).catch(() => false),
      false,
      "Cancel creates no managed copy",
    );
    assert.deepEqual(await readFile(temp), PNG_BYTES, "the temp source is untouched");
    assert.equal(state.draft, "chat draft", "the chat draft survived the cancelled field");
    assert.deepEqual(state.chatSubmits, [], "no chat message was submitted");
    assert.equal(state.shutdowns, 0, "the host exit/interrupt path never fired");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await rm(temp, { force: true });
  }
});

function configPathOf(dir: string): string {
  return join(dir, "review-gate.json");
}
