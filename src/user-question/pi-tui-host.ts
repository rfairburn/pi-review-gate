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
 * manager drives input. The free-text answer row embeds the host-wired native
 * editor acquired through the shared bridge (src/native-editor-bridge.ts);
 * this loader no longer exposes a standalone Editor for it — without the
 * bridge's seams the row renders an unavailable line instead of a non-parity
 * fallback. No installed path is hard-coded.
 */

import { loadHostPeerModule } from "../host-peer-loader";

const PI_TUI_PACKAGE_NAME = "@earendil-works/pi-tui";

/** The pi-tui surface the question UI uses; every member is optional. */
export interface QuestionTuiHost {
  matchesKey?(data: string, keyId: string): boolean;
  visibleWidth?(text: string): number;
  truncateToWidth?(text: string, width: number, ellipsis?: string): string;
  wrapTextWithAnsi?(text: string, width: number): string[];
  /** The module-global KeybindingsManager (default resolution). */
  getKeybindings?(): { matches?(data: string, keybinding: string): boolean } | undefined;
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
  const mod = await loadHostPeerModule(PI_TUI_PACKAGE_NAME, { entryProvider: hostEntryProvider });
  if (!mod) return undefined;
  const matchesKey = mod.matchesKey as ((data: string, keyId: string) => boolean) | undefined;
  const visibleWidth = mod.visibleWidth as ((text: string) => number) | undefined;
  const truncateToWidth = mod.truncateToWidth as
    | ((text: string, width: number, ellipsis?: string) => string)
    | undefined;
  const wrapTextWithAnsi = mod.wrapTextWithAnsi as ((text: string, width: number) => string[]) | undefined;
  const getKeybindings = mod.getKeybindings as (() => unknown) | undefined;
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
  return Object.keys(host).length > 0 ? host : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
