/**
 * Fakes for the issue #140 retained-selection menu tests.
 *
 * The fake TUI host mirrors the pi-tui surface the adapter drives (SelectList,
 * Container, Text, DynamicBorder) with the same key names and navigation
 * semantics as the real component (wrap-around arrows, Enter → onSelect,
 * Esc → onCancel, "→ " selected prefix), so tests exercise genuine component
 * instances through render() and handleInput() instead of mocking the adapter
 * itself. {@link createTuiSettingsContext} builds a command context whose
 * ctx.ui.custom simulates the host's showExtensionCustom: it runs the factory,
 * feeds the scripted raw key sequence to the returned component, and resolves
 * when the component calls done().
 *
 * {@link loadRealMenuTuiHost} best-effort loads the actually installed pi-tui
 * (and the agent package's DynamicBorder) so one test can drive the real
 * SelectList; it returns undefined where no host is resolvable and that test
 * skips.
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MenuContainer, MenuSelectItem, MenuSelectList, MenuSelectListTheme, MenuTuiHost } from "../src/settings/menu";

/** Raw key sequences matching pi-tui's default tui.select.* bindings. */
export const KEY_UP = "\x1b[A";
export const KEY_DOWN = "\x1b[B";
export const KEY_ENTER = "\r";
export const KEY_ESCAPE = "\x1b";

export class FakeSelectList implements MenuSelectList {
  readonly items: MenuSelectItem[];
  selectedIndex = 0;
  onSelect?: (item: MenuSelectItem) => void;
  onCancel?: () => void;
  /** Every render() output, in order, for assertions. */
  rendered: string[][] = [];

  constructor(items: MenuSelectItem[], _maxVisible: number, _theme: MenuSelectListTheme) {
    this.items = items;
  }

  setSelectedIndex(index: number): void {
    if (Number.isInteger(index) && index >= 0 && index < this.items.length) this.selectedIndex = index;
  }

  handleInput(data: string): void {
    // Same semantics as pi-tui SelectList with the default keybindings:
    // wrap-around navigation, Enter confirms, Esc cancels.
    if (data === KEY_UP) {
      this.selectedIndex = this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
    } else if (data === KEY_DOWN) {
      this.selectedIndex = this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (data === KEY_ENTER) {
      const item = this.items[this.selectedIndex];
      if (item && this.onSelect) this.onSelect(item);
    } else if (data === KEY_ESCAPE) {
      this.onCancel?.();
    }
  }

  render(_width: number): string[] {
    const lines = this.items.map((item, index) =>
      index === this.selectedIndex ? `→ ${item.label}` : `  ${item.label}`,
    );
    this.rendered.push(lines);
    return lines;
  }

  invalidate(): void {}
}

export class FakeContainer implements MenuContainer {
  readonly children: Array<{ render(width: number): string[] }> = [];

  addChild(component: unknown): void {
    const child = component as { render?(width: number): string[] };
    if (typeof child?.render !== "function") throw new Error("FakeContainer: child does not render");
    this.children.push({ render: (width) => child.render!(width) });
  }

  render(width: number): string[] {
    return this.children.flatMap((child) => child.render(width));
  }

  invalidate(): void {}
}

export class FakeText {
  readonly text: string;

  constructor(text: string, _x?: number, _y?: number) {
    this.text = text;
  }

  render(_width: number): string[] {
    return [this.text];
  }

  invalidate(): void {}
}

export class FakeDynamicBorder {
  private readonly color?: (segment: string) => string;

  constructor(color?: (segment: string) => string) {
    this.color = color;
  }

  render(width: number): string[] {
    const segment = "─".repeat(Math.max(1, width));
    return [this.color ? this.color(segment) : segment];
  }

  invalidate(): void {}
}

export interface FakeMenuTuiHostOptions {
  /** Collects every FakeSelectList created, in construction order. */
  lists?: FakeSelectList[];
  /** Collects every manager passed to the fake setKeybindings(). */
  setKeybindingsCalls?: unknown[];
}

export function createFakeMenuTuiHost(options: FakeMenuTuiHostOptions = {}): MenuTuiHost {
  const lists = options.lists ?? [];
  const setKeybindingsCalls = options.setKeybindingsCalls ?? [];
  return {
    SelectList: class extends FakeSelectList {
      constructor(items: MenuSelectItem[], maxVisible: number, theme: MenuSelectListTheme) {
        super(items, maxVisible, theme);
        lists.push(this);
      }
    },
    Container: FakeContainer,
    Text: FakeText,
    DynamicBorder: FakeDynamicBorder,
    setKeybindings: (keybindings: unknown): void => {
      setKeybindingsCalls.push(keybindings);
    },
  };
}

/** Identity theme: styling is applied but visible as plain text. */
export const IDENTITY_THEME = {
  fg: (_color: string, text: string): string => text,
  bold: (text: string): string => text,
};

const FAKE_TUI = { requestRender(): void {} };

export interface TuiSettingsHarness {
  /** The command context to pass to the registered handler. */
  context: unknown;
  /** The fake host to inject with setMenuTuiHost before running the flow. */
  host: MenuTuiHost;
  /** One initial rendered frame per custom() call (real or fake component). */
  frames: string[][];
  /** The selectedIndex of each fake list right after its initial frame, i.e.
   * the preselection before any scripted key was fed. */
  initialIndexes: number[];
  /** Every FakeSelectList created by the adapter, in show order. */
  lists: FakeSelectList[];
  /** Every manager the adapter passed to the host's setKeybindings(). */
  setKeybindingsCalls: unknown[];
  /** Plain ui.select calls (one-shot pickers and fallback only). */
  selectCalls: Array<{ title: string; options: string[] }>;
  inputCalls: Array<{ title: string; placeholder?: string }>;
  confirmCalls(): number;
  notifyCalls: Array<{ message: string; type?: string }>;
  /** True once a menu was shown with no scripted step left (defensive). */
  exhausted(): boolean;
}

/**
 * Builds a TUI-mode command context whose ui.custom drives real fake
 * components. `steps` holds one raw-key sequence per custom() call, in order;
 * each sequence must end by resolving the menu (Enter or Esc). One-shot
 * pickers still use plain ui.select and are scripted through `selectScript`.
 */
export function createTuiSettingsContext(
  steps: string[][],
  options: {
    scopedModels?: unknown[];
    selectScript?: Array<string | undefined>;
    inputs?: Array<string | undefined>;
    confirms?: boolean[];
    /** The keybindings manager the host injects into custom() (null = none). */
    keybindings?: unknown;
  } = {},
): TuiSettingsHarness {
  const lists: FakeSelectList[] = [];
  const setKeybindingsCalls: unknown[] = [];
  const host = createFakeMenuTuiHost({ lists, setKeybindingsCalls });
  const frames: string[][] = [];
  const initialIndexes: number[] = [];
  const selectCalls: TuiSettingsHarness["selectCalls"] = [];
  const inputCalls: TuiSettingsHarness["inputCalls"] = [];
  const notifyCalls: TuiSettingsHarness["notifyCalls"] = [];
  let stepIndex = 0;
  let selectIndex = 0;
  let inputIndex = 0;
  let confirmIndex = 0;
  let confirmCount = 0;
  let exhausted = false;

  const ui = {
    custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: string | undefined) => void) => unknown): Promise<string | undefined> {
      return new Promise<string | undefined>((resolve) => {
        // Simulate the host showExtensionCustom: run the factory with the
        // real done() as resolver, render one initial frame (so the
        // preselection is observable), then feed this menu's scripted keys.
        const component = factory(FAKE_TUI, IDENTITY_THEME, options.keybindings ?? null, resolve) as {
          render?(width: number): string[];
          handleInput?(data: string): void;
        };
        const frame = component.render?.(80);
        if (Array.isArray(frame)) frames.push(frame);
        const lastList = lists[lists.length - 1];
        if (lastList) initialIndexes.push(lastList.selectedIndex);
        const step = steps[stepIndex++];
        if (step === undefined) {
          exhausted = true;
          resolve(undefined);
          return;
        }
        for (const key of step) component.handleInput?.(key);
      });
    },
    async select(title: string, opts: string[]): Promise<string | undefined> {
      selectCalls.push({ title, options: opts });
      const script = options.selectScript ?? [];
      return script[selectIndex++];
    },
    async input(title: string, placeholder?: string): Promise<string | undefined> {
      inputCalls.push({ title, placeholder });
      const inputs = options.inputs ?? [];
      return inputs[inputIndex++];
    },
    async confirm(): Promise<boolean> {
      confirmCount += 1;
      const confirms = options.confirms ?? [];
      return confirms[confirmIndex++] ?? false;
    },
    notify(message: string, type?: string): void {
      notifyCalls.push({ message, type });
    },
  };

  return {
    context: { mode: "tui", scopedModels: options.scopedModels ?? [], ui },
    host,
    frames,
    initialIndexes,
    lists,
    setKeybindingsCalls,
    selectCalls,
    inputCalls,
    confirmCalls: () => confirmCount,
    notifyCalls,
    exhausted: () => exhausted,
  };
}

const TUI_PACKAGE_NAME = "@earendil-works/pi-tui";
const AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

interface RealPiModules {
  tui: Record<string, unknown>;
  agent?: Record<string, unknown>;
}

function isModuleRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves the actually installed pi packages. Resolution order: direct
 * package resolution (host alias or dependency), then the global pi install
 * next to the node binary, plus the common macOS Homebrew and /usr/local
 * prefixes where a separately installed pi may live. Returns undefined when
 * nothing is resolvable (test skips).
 */
async function resolveRealPiModules(): Promise<RealPiModules | undefined> {
  const fromModules = async (agentDir: string): Promise<RealPiModules | undefined> => {
    try {
      const requireFromAgent = createRequire(join(agentDir, "package.json"));
      const tui = requireFromAgent(TUI_PACKAGE_NAME) as Record<string, unknown>;
      if (typeof tui?.SelectList !== "function" || typeof tui?.Container !== "function" || typeof tui?.Text !== "function") {
        return undefined;
      }
      let agent: Record<string, unknown> | undefined;
      try {
        const loaded = requireFromAgent(AGENT_PACKAGE_NAME) as Record<string, unknown>;
        if (isModuleRecord(loaded)) agent = loaded;
      } catch {
        // Borders and themes are cosmetic; the real SelectList is the point.
      }
      return { tui, agent };
    } catch {
      return undefined;
    }
  };

  try {
    const tui = (await import(TUI_PACKAGE_NAME)) as Record<string, unknown>;
    if (typeof tui?.SelectList === "function" && typeof tui?.Container === "function" && typeof tui?.Text === "function") {
      let agent: Record<string, unknown> | undefined;
      try {
        const loaded = (await import(AGENT_PACKAGE_NAME)) as Record<string, unknown>;
        if (isModuleRecord(loaded)) agent = loaded;
      } catch {
        // Cosmetic.
      }
      return { tui, agent };
    }
  } catch {
    // Not resolvable from this tree; try the global install below.
  }

  // Node's own global root (nvm, asdf, system installs all put it at
  // <prefix>/lib/node_modules), plus the common macOS Homebrew and /usr/local
  // prefixes where a separately installed pi may live.
  const roots: string[] = [];
  let dir = dirname(process.execPath);
  for (let depth = 0; depth < 6; depth += 1) {
    const parent = dirname(dir);
    if (parent === dir) break;
    roots.push(join(dir, "lib", "node_modules"));
    dir = parent;
  }
  roots.push("/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules");
  for (const root of roots) {
    const agentDir = join(root, "@earendil-works", "pi-coding-agent");
    if (!existsSync(join(agentDir, "package.json"))) continue;
    const modules = await fromModules(agentDir);
    if (modules) return modules;
  }
  return undefined;
}

/**
 * Best-effort loader for the actually installed pi-tui module so tests can
 * drive the real SelectList and its keybinding exports. Returns undefined
 * when nothing is resolvable (test skips).
 */
export async function loadRealPiTuiModule(): Promise<Record<string, unknown> | undefined> {
  return (await resolveRealPiModules())?.tui;
}

/**
 * Best-effort loader for the actually installed pi packages so one test can
 * drive the real SelectList. Returns undefined when nothing is resolvable
 * (test skips).
 */
export async function loadRealMenuTuiHost(): Promise<MenuTuiHost | undefined> {
  const modules = await resolveRealPiModules();
  if (!modules) return undefined;
  const { tui, agent } = modules;
  const host: MenuTuiHost = {
    SelectList: tui.SelectList as MenuTuiHost["SelectList"],
    Container: tui.Container as MenuTuiHost["Container"],
    Text: tui.Text as MenuTuiHost["Text"],
  };
  if (typeof tui.setKeybindings === "function") {
    host.setKeybindings = tui.setKeybindings as MenuTuiHost["setKeybindings"];
  }
  if (agent) {
    if (typeof agent.DynamicBorder === "function") host.DynamicBorder = agent.DynamicBorder as MenuTuiHost["DynamicBorder"];
    if (typeof agent.getSelectListTheme === "function") host.getSelectListTheme = agent.getSelectListTheme as MenuTuiHost["getSelectListTheme"];
  }
  return host;
}
