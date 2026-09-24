/**
 * Host pi-tui access for the pending-question UI (issue #95).
 *
 * The question list is a plain structural Component (render/handleInput/
 * invalidate) so its logic is testable without any host module. This loader
 * supplies only the width-safe text helpers and raw key matching from the
 * running Pi's own pi-tui, following the same two-step strategy as
 * src/settings/menu.ts:
 *
 * 1. Soft `require` of the package name — inside a jiti-transformed Pi
 *    extension the loader aliases the name to the running host's module.
 * 2. Host-relative resolution for compiled entries: since pi 0.86 (jiti 2.7,
 *    Node >= 24) a pre-compiled CommonJS entry is loaded by native import and
 *    its `require()` calls bypass the jiti aliases, so step 1 throws
 *    MODULE_NOT_FOUND. The loader then locates the running Pi install from
 *    `process.argv[1]` (realpath, nearest package.json named
 *    @earendil-works/pi-coding-agent) and pi-tui is resolved with
 *    `createRequire(piEntry).resolve()` plus `require()`, falling back to a
 *    native dynamic `import()` for ESM on Node 20.
 *
 * Anything that cannot be resolved (unit tests, SEA/binary hosts) degrades:
 * the UI then renders with naive width handling and only the live keybinding
 * manager drives input. The host chat editor (`Editor`) is exposed for the
 * free-text answer row (issue #182); without it the component keeps its
 * built-in fallback editor. No installed path is hard-coded.
 */

import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PI_AGENT_PACKAGE_NAMES = new Set(["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"]);
const PI_TUI_PACKAGE_NAME = "@earendil-works/pi-tui";
/** How far up from the host entry to look for its package.json. */
const MAX_HOST_ROOT_DEPTH = 16;

// tsc rewrites `await import(x)` in CommonJS output to require(x), which
// cannot load ESM on Node 20 and would defeat the explicit file resolution
// done here. Compile a native dynamic import the transpiler leaves untouched.
const nativeDynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

/**
 * The host chat-editor surface the free-text answer row drives (issue #182).
 * Mirrors the pi-tui Editor contract the component relies on; the editor is
 * the single source of truth for the draft text and cursor — the component
 * never stores a copy.
 */
export interface QuestionAnswerEditor {
  /** Focus flag consumed by the TUI for IME cursor placement; the component propagates it. */
  focused: boolean;
  /** Fired by the editor's own submit action with expanded, trimmed text. */
  onSubmit?: (text: string) => void;
  /** Fired after every content change (raw stored text, paste markers included). */
  onChange?: (text: string) => void;
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
  setText(text: string): void;
  /** Stored text with paste markers expanded to their actual content. */
  getExpandedText(): string;
}

/** Select-list styling the host editor theme requires (never visible here: no autocomplete provider is set). */
export interface QuestionAnswerEditorSelectListTheme {
  selectedPrefix(text: string): string;
  selectedText(text: string): string;
  description(text: string): string;
  scrollInfo(text: string): string;
  noMatch(text: string): string;
}

/** Theme for the host editor component (border + select-list styling). */
export interface QuestionAnswerEditorTheme {
  borderColor(text: string): string;
  selectList: QuestionAnswerEditorSelectListTheme;
}

/** The pi-tui surface the question UI uses; every member is optional. */
export interface QuestionTuiHost {
  matchesKey?(data: string, keyId: string): boolean;
  visibleWidth?(text: string): number;
  truncateToWidth?(text: string, width: number, ellipsis?: string): string;
  wrapTextWithAnsi?(text: string, width: number): string[];
  /** The module-global KeybindingsManager (default resolution). */
  getKeybindings?(): { matches?(data: string, keybinding: string): boolean } | undefined;
  /** The pi-tui Editor class (host chat editor), when the module exposes it. */
  Editor?: new (tui: unknown, theme: QuestionAnswerEditorTheme) => QuestionAnswerEditor;
  /**
   * The loaded module's public setKeybindings(). Since pi >= 0.86 the
   * standalone module's global keybinding state is a fresh default-only copy
   * (the app sets its own inlined chunk), so components built from this
   * module must be pointed at the live manager — same strategy as
   * src/settings/menu.ts.
   */
  setKeybindings?(keybindings: unknown): void;
}

let hostOverride: QuestionTuiHost | undefined;
let hostLoadPromise: Promise<QuestionTuiHost | undefined> | undefined;
let hostEntryProvider: (() => string | undefined) | undefined;

/** Test seam: inject a fake TUI host, or clear the override with undefined. */
export function setUserQuestionTuiHost(host: QuestionTuiHost | undefined): void {
  hostOverride = host;
  hostLoadPromise = undefined;
}

/**
 * Test seam: replace (or clear) discovery of the running Pi entry file. The
 * replacement still goes through the same realpath/package.json validation.
 */
export function setUserQuestionTuiHostEntryProvider(provider: (() => string | undefined) | undefined): void {
  hostEntryProvider = provider;
  hostLoadPromise = undefined;
}

export function loadQuestionTuiHost(): Promise<QuestionTuiHost | undefined> {
  if (hostOverride !== undefined) return Promise.resolve(hostOverride);
  hostLoadPromise ??= doLoadQuestionTuiHost();
  return hostLoadPromise;
}

async function doLoadQuestionTuiHost(): Promise<QuestionTuiHost | undefined> {
  const mod = await loadPeerModule(PI_TUI_PACKAGE_NAME);
  if (!mod) return undefined;
  const matchesKey = mod.matchesKey as ((data: string, keyId: string) => boolean) | undefined;
  const visibleWidth = mod.visibleWidth as ((text: string) => number) | undefined;
  const truncateToWidth = mod.truncateToWidth as
    | ((text: string, width: number, ellipsis?: string) => string)
    | undefined;
  const wrapTextWithAnsi = mod.wrapTextWithAnsi as ((text: string, width: number) => string[]) | undefined;
  const getKeybindings = mod.getKeybindings as (() => unknown) | undefined;
  const EditorCtor = mod.Editor as
    | (new (tui: unknown, theme: QuestionAnswerEditorTheme) => QuestionAnswerEditor)
    | undefined;
  const setKeybindings = mod.setKeybindings as ((keybindings: unknown) => void) | undefined;
  const host: QuestionTuiHost = {};
  if (typeof matchesKey === "function") {
    host.matchesKey = (data, keyId) => Boolean(matchesKey(data, keyId));
  }
  if (typeof visibleWidth === "function") {
    host.visibleWidth = (text) => visibleWidth(text);
  }
  if (typeof truncateToWidth === "function") {
    host.truncateToWidth = (text, width, ellipsis) => truncateToWidth(text, width, ellipsis);
  }
  if (typeof wrapTextWithAnsi === "function") {
    host.wrapTextWithAnsi = (text, width) => [...wrapTextWithAnsi(text, width)];
  }
  if (typeof getKeybindings === "function") {
    host.getKeybindings = () => {
      const manager = getKeybindings();
      return isRecord(manager) && typeof manager.matches === "function"
        ? manager as unknown as { matches(data: string, keybinding: string): boolean }
        : undefined;
    };
  }
  if (typeof EditorCtor === "function") {
    host.Editor = EditorCtor;
  }
  if (typeof setKeybindings === "function") {
    host.setKeybindings = (keybindings) => {
      setKeybindings(keybindings);
    };
  }
  return Object.keys(host).length > 0 ? host : undefined;
}

/** Loads one host peer module. Never a hard dependency: any failure yields undefined. */
async function loadPeerModule(name: string): Promise<Record<string, unknown> | undefined> {
  try {
    const mod = require(name) as unknown;
    if (isRecord(mod)) return mod;
  } catch {
    // MODULE_NOT_FOUND for compiled CJS entries under pi >= 0.86: the native
    // import bypasses the jiti aliases. Try host-relative resolution.
  }
  const piRoot = findRunningPiRoot();
  if (!piRoot) return undefined;
  let entry: string | undefined;
  try {
    const hostRequire = createRequire(piRoot.entry);
    entry = hostRequire.resolve(name);
  } catch {
    return undefined;
  }
  try {
    const mod = require(entry) as unknown;
    if (isRecord(mod)) return mod;
  } catch {
    // ESM-only package on a Node without require(esm): fall through.
  }
  try {
    const mod = await nativeDynamicImport(pathToFileURL(entry).href);
    if (isRecord(mod)) return mod;
  } catch {
    return undefined;
  }
  return undefined;
}

interface RunningPiRoot {
  root: string;
  entry: string;
}

/**
 * Locates the running Pi install from the process entry, mirroring
 * src/settings/menu.ts. Returns undefined when the process was not started
 * from a Pi install (unit tests, other hosts).
 */
function findRunningPiRoot(): RunningPiRoot | undefined {
  const candidate = (hostEntryProvider ?? defaultHostEntry)();
  if (!candidate) return undefined;
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return undefined;
  }
  let dir = dirname(real);
  for (let depth = 0; depth < MAX_HOST_ROOT_DEPTH; depth += 1) {
    const pkg = readPackageJson(dir);
    if (pkg && typeof pkg.name === "string" && PI_AGENT_PACKAGE_NAMES.has(pkg.name)) {
      return { root: dir, entry: real };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function defaultHostEntry(): string | undefined {
  const candidate = process.argv[1];
  if (!candidate || typeof candidate !== "string") return undefined;
  return isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
}

function readPackageJson(dir: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
