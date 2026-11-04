/**
 * #419 (deterministic tier): the settings transaction publishes its own
 * foreground Escape, and the production review-abort listeners route to it
 * instead of cancelling.
 *
 * This file models only the host's input-ordering contract (raw listeners in
 * registration order, first consumer wins, otherwise the focused component
 * handles the key) plus the editor-slot focus identity `ui.custom()` gives the
 * produced component. The real ordering on the installed runtime is proven in
 * tests/settings-escape-pi-host.test.ts; these cases pin the seam itself:
 * nested and root settings exits, the same-dispatch guarantee for a
 * later-registered aborter, exact retirement when the slot closes, and the
 * plain/RPC fallback (no `custom`) publishing nothing at all.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { createState } from "../src/state";
import { createReviewAbortController } from "../src/activation/review-abort";
import { createReviewCancellationCoordinator } from "../src/review-cancellation";
import { registerReviewSettings } from "../src/settings/command";
import { routeForegroundEscape } from "../src/foreground-escape";
import { setMenuTuiHost } from "../src/settings/menu";
import { createFakeMenuTuiHost, IDENTITY_THEME, KEY_DOWN, KEY_ENTER, KEY_ESCAPE } from "./menu-tui-fakes";
import { fakeNeedsChangesConfig } from "./helpers";

type RawListener = (data: string) => { consume?: boolean } | undefined;

interface HostModel {
  context: Record<string, unknown>;
  dispatch(data: string): void;
  /** True while a component other than the stand-in editor holds focus. */
  componentForeground(): boolean;
  frame(): string;
  notices(): string[];
  close(): void;
}

/** A minimal Pi-shaped custom slot: factory, focus, done, raw listeners. */
function createHostModel(options: { withCustom: boolean }): HostModel {
  const listeners: RawListener[] = [];
  const notices: string[] = [];
  const editor = { handleInput(): void {} };
  let focused: { handleInput?(data: string): void; render?(width: number): string[] } = editor;
  const tui = {
    requestRender(): void {},
    getFocusedComponent: () => focused,
  };
  const ui: Record<string, unknown> = {
    mode: "tui",
    notify(message: string): void {
      notices.push(message);
    },
    onTerminalInput(handler: RawListener): () => void {
      listeners.push(handler);
      return () => {
        const index = listeners.indexOf(handler);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    async select(): Promise<string | undefined> {
      return undefined;
    },
    // The host's editor-slot confirmation dialog (showExtensionConfirm): a new
    // component takes focus synchronously, and its own cancel binding resolves
    // false. It is not a custom component, so the settings custom-slot publish
    // cannot cover it (#419 review pass 1).
    confirm(title: string): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        const dialog = {
          handleInput(data: string): void {
            if (data !== KEY_ESCAPE) return;
            focused = editor;
            resolve(false);
          },
          render: () => [title, "Yes", "No"],
        };
        focused = dialog;
      });
    },
  };
  if (options.withCustom) {
    ui.custom = (factory: (hostTui: unknown, theme: unknown, keybindings: unknown, done: (value?: string) => void) => unknown) =>
      new Promise<string | undefined>((resolve) => {
        let settled = false;
        const done = (value?: string): void => {
          if (settled) return;
          settled = true;
          // The host restores the editor slot when the custom component closes.
          focused = editor;
          resolve(value);
        };
        const component = factory(tui, IDENTITY_THEME, null, done) as typeof focused;
        // showExtensionCustom focuses the produced component.
        focused = component;
      });
  }
  const context = { sessionManager: {}, mode: "tui", cwd: process.cwd(), scopedModels: [], ui };
  return {
    context,
    dispatch(data: string): void {
      for (const listener of [...listeners]) {
        if (listener(data)?.consume) return;
      }
      focused?.handleInput?.(data);
    },
    componentForeground: () => focused !== editor,
    frame: () => (typeof focused?.render === "function" ? focused.render(120).join("\n") : ""),
    notices: () => [...notices],
    close(): void {
      listeners.length = 0;
      focused = editor;
    },
  };
}

async function settingsInput(root: string): Promise<{
  pi: Record<string, unknown>;
  commands: Map<string, { handler(args: string, ctx: unknown): Promise<void> }>;
  config: ReturnType<typeof normalizeConfig>;
  configPath: string;
}> {
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const configPath = join(root, "review-gate.json");
  await writeFile(configPath, "{}\n");
  const config = normalizeConfig(fakeNeedsChangesConfig());
  return {
    pi: {
      registerCommand(name: string, value: { handler(args: string, ctx: unknown): Promise<void> }) { commands.set(name, value); },
    },
    commands,
    config,
    configPath,
  };
}

/** Highlight one settings row by its label in the fake host's rendered menu. */
function focusRow(host: HostModel, label: string): void {
  for (let press = 0; press < 30; press += 1) {
    if (host.frame().split("\n").some((line) => line.includes("→") && line.includes(label))) return;
    host.dispatch(KEY_DOWN);
  }
  throw new Error(`settings row "${label}" was never highlighted:\n${host.frame()}`);
}

async function until(label: string, probe: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!probe()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a live settings screen owns Escape: nested and root exits never abort, a separate press does", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-settings-escape-owned-"));
  setMenuTuiHost(createFakeMenuTuiHost());
  const host = createHostModel({ withCustom: true });
  const { pi, commands, config, configPath } = await settingsInput(root);
  const cancellation = createReviewCancellationCoordinator();
  const state = createState();
  state.reviewInProgress = true;
  // Two production aborters on the same session: the second registers later,
  // exactly like a command-driven abort underneath an already-running one.
  const first = createReviewAbortController({
    signal: undefined, noticeTarget: host.context, state, isSessionActive: () => true,
    cancellation, settled: Promise.resolve(), describe: () => "the automatic review",
  });
  const second = createReviewAbortController({
    signal: undefined, noticeTarget: host.context, state, isSessionActive: () => true,
    cancellation, settled: Promise.resolve(), describe: () => "the automatic review",
  });
  try {
    registerReviewSettings({ pi, config, configPath, onScopedModels: () => {} });
    const settings = commands.get("review-settings")!.handler("", host.context);
    await until("the settings root menu", () => host.frame().includes("Review settings"));
    assert.equal(host.componentForeground(), true);

    // Nested submenu (Operating mode is the root's first row), then its Back.
    host.dispatch(KEY_ENTER);
    await until("the nested submenu", () => host.componentForeground() && !host.frame().includes("Review settings"));
    host.dispatch(KEY_ESCAPE);
    await until("the settings root again", () => host.frame().includes("Review settings"));
    assert.equal(first.signal.aborted, false, "a nested settings Escape never aborts the review");
    assert.equal(second.signal.aborted, false);
    assert.equal(first.getReason(), undefined);

    // The root exit: this Escape closes the menu synchronously inside the same
    // dispatch. It stays consumed for the later-registered aborter too.
    host.dispatch(KEY_ESCAPE);
    assert.equal(first.signal.aborted, false, "the root Escape is the menu's own apply-for-session action");
    assert.equal(second.signal.aborted, false, "a later listener cannot re-own the same packet");
    assert.equal(first.getReason(), undefined);
    await settings;

    // With no settings UI in the foreground, the next press is ordinary
    // explicit cancellation, handled by the first listener.
    host.dispatch(KEY_ESCAPE);
    assert.equal(first.signal.aborted, true);
    assert.equal(first.getReason(), "escape");
    assert.equal(second.signal.aborted, false, "the first consumer ends the dispatch");
  } finally {
    first.cleanup();
    second.cleanup();
    setMenuTuiHost(undefined);
    host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the settings YOLO confirmation is a settings screen: its Escape cancels the dialog, not the review", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-settings-escape-confirm-"));
  setMenuTuiHost(createFakeMenuTuiHost());
  const host = createHostModel({ withCustom: true });
  const { pi, commands, config, configPath } = await settingsInput(root);
  const cancellation = createReviewCancellationCoordinator();
  const state = createState();
  state.reviewInProgress = true;
  const abort = createReviewAbortController({
    signal: undefined, noticeTarget: host.context, state, isSessionActive: () => true,
    cancellation, settled: Promise.resolve(), describe: () => "the automatic review",
  });
  try {
    registerReviewSettings({ pi, config, configPath, onScopedModels: () => {} });
    const settings = commands.get("review-settings")!.handler("", host.context);
    await until("the settings root menu", () => host.frame().includes("Review settings"));
    // Tools → Web → Browser permissions → the YOLO row (Off).
    focusRow(host, "Tools");
    host.dispatch(KEY_ENTER);
    await until("the Tools menu", () => host.frame().includes("Top-level tools"));
    focusRow(host, "Web");
    host.dispatch(KEY_ENTER);
    await until("the Web settings menu", () => host.frame().includes("Maximum download"));
    focusRow(host, "Browser permissions");
    host.dispatch(KEY_ENTER);
    await until("the browser permissions menu", () => host.frame().includes("YOLO / allow everything"));
    focusRow(host, "YOLO / allow everything");
    host.dispatch(KEY_ENTER);
    await until("the YOLO confirmation", () => host.frame().includes("Enable YOLO / allow everything?"));

    // Escape belongs to the confirmation: it resolves as a decline, YOLO stays
    // Off, and the review underneath is untouched.
    host.dispatch(KEY_ESCAPE);
    assert.doesNotMatch(host.frame(), /Enable YOLO/, "the confirmation dismissed");
    await until("back at the browser permissions menu", () => host.frame().includes("YOLO / allow everything"));
    assert.ok(host.notices().some((message) => message.includes("YOLO stays Off.")),
      "the existing decline notice still runs");
    assert.equal(abort.signal.aborted, false, "the confirmation Escape never reaches review cancellation");
    assert.equal(abort.getReason(), undefined);
    assert.equal(config.web?.browserPermissions?.yolo, false, "YOLO stayed Off");

    // Back out to the root, apply the transaction for the session, then a
    // separate press cancels normally.
    for (const [label, marker] of [
      ["the Web settings menu", "Maximum download"],
      ["the Tools menu", "Top-level tools"],
      ["the settings root", "Review settings"],
    ] as const) {
      host.dispatch(KEY_ESCAPE);
      await until(label, () => host.frame().includes(marker));
    }
    host.dispatch(KEY_ESCAPE);
    await settings;
    assert.equal(abort.signal.aborted, false, "the root exit is still the menu's own action");
    assert.equal(config.web?.browserPermissions?.yolo, false);
    host.dispatch(KEY_ESCAPE);
    assert.equal(abort.signal.aborted, true, "a separate press cancels normally");
    assert.equal(abort.getReason(), "escape");
  } finally {
    abort.cleanup();
    setMenuTuiHost(undefined);
    host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a closed settings transaction publishes nothing: a separate press cancels", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-settings-escape-claim-"));
  setMenuTuiHost(createFakeMenuTuiHost());
  const host = createHostModel({ withCustom: true });
  const { pi, commands, config, configPath } = await settingsInput(root);
  const cancellation = createReviewCancellationCoordinator();
  const state = createState();
  state.reviewInProgress = true;
  const abort = createReviewAbortController({
    signal: undefined, noticeTarget: host.context, state, isSessionActive: () => true,
    cancellation, settled: Promise.resolve(), describe: () => "the automatic review",
  });
  try {
    registerReviewSettings({ pi, config, configPath, onScopedModels: () => {} });
    const settings = commands.get("review-settings")!.handler("", host.context);
    await until("the settings root menu", () => host.frame().includes("Review settings"));
    assert.equal(routeForegroundEscape(host.context, KEY_ESCAPE), true,
      "while the settings component really has focus its Escape is owned");
    assert.equal(abort.signal.aborted, false);
    await settings;
    assert.equal(routeForegroundEscape(host.context, KEY_ESCAPE), false,
      "a closed settings transaction publishes nothing");
  } finally {
    abort.cleanup();
    setMenuTuiHost(undefined);
    host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the plain/RPC selector fallback publishes no settings ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "prg-settings-escape-plain-"));
  const host = createHostModel({ withCustom: false });
  const { pi, commands, config, configPath } = await settingsInput(root);
  const cancellation = createReviewCancellationCoordinator();
  const state = createState();
  state.reviewInProgress = true;
  const abort = createReviewAbortController({
    signal: undefined, noticeTarget: host.context, state, isSessionActive: () => true,
    cancellation, settled: Promise.resolve(), describe: () => "the automatic review",
  });
  try {
    registerReviewSettings({ pi, config, configPath, onScopedModels: () => {} });
    const settings = commands.get("review-settings")!.handler("", host.context);
    // The fallback path resolves the plain selector without any custom slot,
    // so nothing here may suppress the documented cancellation.
    assert.equal(routeForegroundEscape(host.context, KEY_ESCAPE), false);
    host.dispatch(KEY_ESCAPE);
    assert.equal(abort.signal.aborted, true, "cancellation stays available without a custom settings surface");
    assert.equal(abort.getReason(), "escape");
    await settings;
  } finally {
    abort.cleanup();
    host.close();
    await rm(root, { recursive: true, force: true });
  }
});
