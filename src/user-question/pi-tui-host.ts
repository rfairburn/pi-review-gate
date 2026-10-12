/**
 * Host pi-tui access for the pending-question UI (issue #95).
 *
 * The question list is a plain structural Component (render/handleInput/
 * invalidate) so its logic is testable without any host module. This loader
 * supplies width-safe text helpers, native Markdown, ScrollView, and raw key
 * matching from the running Pi's own pi-tui, following the same two-step strategy as
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
 * Anything that cannot be resolved (unit tests, SEA/binary hosts) degrades
 * width handling to the existing naive text path and leaves input to the live
 * keybinding manager. When native Markdown or the application's Markdown
 * theme is unavailable, question and notice details disclose and use the
 * authorized full, width-wrapped plain-text fallback (no custom Markdown
 * parser). The shared question/notice component is a public overlay, whose
 * compositor clips lines to `maxHeight` but does not lay out a ScrollView.
 * Production therefore owns a manual viewport whose row budget matches the
 * overlay's explicit maxHeight and margins, recalculated on terminal resize.
 * The public ScrollView factory remains available only for components whose
 * host parent actually traverses its layout node. The
 * free-text answer row embeds the host-wired native
 * editor acquired through the shared bridge (src/native-editor-bridge.ts);
 * this loader no longer exposes a standalone Editor for it — without the
 * bridge's seams the row renders an unavailable line instead of a non-parity
 * fallback. No installed path is hard-coded.
 */

import { loadHostPeerModule } from "../host-peer-loader";

const PI_TUI_PACKAGE_NAME = "@earendil-works/pi-tui";
const PI_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** Structural subset of pi-tui's native Markdown component. */
export interface QuestionMarkdownComponent {
  render(width: number): string[];
  invalidate(): void;
}

/** Native pi-tui ScrollView; its viewport is available when host layout traverses its node. */
export interface QuestionScrollViewComponent extends QuestionMarkdownComponent {
  readonly viewportHeight: number;
  scrollBy(lines: number): number;
  scrollToStart(): void;
}

/** The pi-tui surface the question UI uses; every member is optional. */
export interface QuestionTuiHost {
  matchesKey?(data: string, keyId: string): boolean;
  visibleWidth?(text: string): number;
  truncateToWidth?(text: string, width: number, ellipsis?: string): string;
  wrapTextWithAnsi?(text: string, width: number): string[];
  /** Public Editor wrapping with original source offsets. */
  wrapEditorLine?(text: string, width: number): Array<{
    text: string;
    startIndex: number;
    endIndex: number;
  }>;
  /** The module-global KeybindingsManager (default resolution). */
  getKeybindings?(): { matches?(data: string, keybinding: string): boolean } | undefined;
  /** Native pi-tui Markdown using the running application's Markdown theme. */
  createMarkdown?(markdown: string): QuestionMarkdownComponent | undefined;
  /** Native ScrollView for component slots whose parent performs layout. */
  createScrollView?(
    content: QuestionMarkdownComponent,
    fallbackViewportRows?: () => number,
  ): QuestionScrollViewComponent | undefined;
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
  const editorModule = await loadHostPeerModule(`${PI_TUI_PACKAGE_NAME}/dist/components/editor.js`, {
    entryProvider: hostEntryProvider,
  });
  const wordWrapLine = editorModule?.wordWrapLine as
    | ((text: string, width: number) => Array<{ text: string; startIndex: number; endIndex: number }>)
    | undefined;
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
  if (typeof wordWrapLine === "function") {
    host.wrapEditorLine = (text, width) => wordWrapLine(text, width);
  }
  if (typeof getKeybindings === "function") {
    host.getKeybindings = () => {
      const manager = getKeybindings();
      return isRecord(manager) && typeof manager.matches === "function"
        ? manager as unknown as { matches(data: string, keybinding: string): boolean }
        : undefined;
    };
  }
  const Markdown = mod.Markdown;
  if (typeof Markdown === "function") {
    const agent = await loadHostPeerModule(PI_AGENT_PACKAGE_NAME, {
      entryProvider: hostEntryProvider,
      packageMainFallback: true,
    });
    const getMarkdownTheme = agent?.getMarkdownTheme;
    if (typeof getMarkdownTheme === "function") {
      host.createMarkdown = (markdown) => {
        try {
          const theme = getMarkdownTheme();
          const component = new (Markdown as new (
            markdown: string,
            paddingX?: number,
            paddingY?: number,
            theme?: unknown,
          ) => QuestionMarkdownComponent)(markdown, 0, 0, theme);
          return typeof component.render === "function" && typeof component.invalidate === "function"
            ? component
            : undefined;
        } catch {
          // Outside a fully initialized host theme, notice rendering discloses
          // the complete plain-text fallback; question details remain literal.
          return undefined;
        }
      };
    }
  }
  const ScrollView = mod.ScrollView;
  if (typeof ScrollView === "function") {
    host.createScrollView = (content) => {
      try {
        const component = new (ScrollView as new (
          child: QuestionMarkdownComponent,
          options?: { axis?: "vertical"; overscroll?: "chain" | "contain"; scrollbar?: "hidden" | "auto" | "always" },
        ) => QuestionScrollViewComponent)(content, {
          axis: "vertical",
          overscroll: "contain",
          scrollbar: "hidden",
        });
        return typeof component.render === "function"
          && typeof component.invalidate === "function"
          && typeof component.scrollBy === "function"
          && typeof component.scrollToStart === "function"
          ? component
          : undefined;
      } catch {
        return undefined;
      }
    };
  }
  return Object.keys(host).length > 0 ? host : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
