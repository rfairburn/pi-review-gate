/**
 * Pi's OWN built-in Dark and Light foreground colours, copied verbatim for the
 * session host's sidebar palettes (#613).
 *
 * Provenance (MIT redistribution; see `NOTICE` and
 * `LICENSES/MIT-pi-theme-colors.txt`): these are the authored colour values of
 * Pi Coding Agent v1.5.0's built-in `dark` and `light` themes, published at
 * https://github.com/earendil-works/pi/tree/v1.5.0/packages/coding-agent/src/modes/interactive/theme
 * Pi's own theme documentation invites copying the built-in themes
 * (https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/themes.md).
 *
 * Each value is the theme's var-RESOLVED authored token. Pi writes colours that
 * several roles share as a `vars` entry and references them by name (for
 * example `colors.success` is the string `"green"`, and `vars.green` is
 * `okhsl(159 59% 67%)`). The string copied below is the value that reference
 * resolves to, copied byte-for-byte from the theme file, so the host needs no
 * colour-variable resolver of its own.
 *
 * This module is DATA ONLY. It performs no conversion, reads no Pi
 * configuration or saved theme, never touches an installed Pi at runtime, and
 * runs no terminal query or capability detection. The conversion to terminal
 * output happens exactly once in `sidebar-theme.ts`, through the pinned
 * `pi-session-host-tui` colour API, and the parity test compares these strings
 * against the real pinned Pi 1.5.0 theme files.
 */

/** Where the copied values come from, pinned to the exact upstream version. */
export const PI_THEME_COLOR_PROVENANCE: Readonly<{
  readonly package: string;
  readonly version: string;
  readonly darkTheme: string;
  readonly lightTheme: string;
}> = Object.freeze({
  package: "@earendil-works/pi-coding-agent",
  version: "1.5.0",
  darkTheme: "https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/modes/interactive/theme/dark.json",
  lightTheme: "https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/modes/interactive/theme/light.json",
});

/**
 * The Pi theme colour tokens the sidebar borrows. Every name is a real colour
 * token of Pi's theme schema (`colors` key), never a host-invented colour.
 */
export type PiSidebarColorToken =
  /** Pi's body text colour. */
  | "text"
  /** Pi's secondary/muted colour. */
  | "muted"
  /** Pi's faintest foreground colour. */
  | "dim"
  /** Pi's accent colour. */
  | "accent"
  /** Pi's success colour. */
  | "success"
  /** Pi's error colour. */
  | "error"
  /** Pi's warning colour. */
  | "warning"
  /** Pi's Markdown link colour. */
  | "mdLink"
  /**
   * Pi's own syntax-highlighting colour for a variable reference — the cyan
   * family Pi uses when it names a value in code. The sidebar borrows it for
   * one thing only: the friendly hostname in a projected remote card's owner
   * row (#613 follow-up).
   */
  | "syntaxVariable"
  /** Pi's own scrollbar track colour. */
  | "scrollbarTrack"
  /** Pi's own scrollbar thumb colour. */
  | "scrollbarThumb";

/** Every token the sidebar copies, in one fixed order. */
export const PI_SIDEBAR_COLOR_TOKENS: readonly PiSidebarColorToken[] = Object.freeze([
  "text",
  "muted",
  "dim",
  "accent",
  "success",
  "error",
  "warning",
  "mdLink",
  "syntaxVariable",
  "scrollbarTrack",
  "scrollbarThumb",
]);

/**
 * The copied, var-resolved OKHSL strings, per built-in Pi appearance. Only
 * foreground tokens appear: the sidebar never copies or paints a Pi background
 * (`selectedBg`, `tool*Bg`, `export.pageBg`), because its ground stays the
 * terminal's own default.
 */
export const PI_BUILTIN_FOREGROUND_COLORS: Readonly<
  Record<"dark" | "light", Readonly<Record<PiSidebarColorToken, string>>>
> = Object.freeze({
  // Pi 1.5.0 `dark.json`.
  dark: Object.freeze({
    text: "okhsl(234 3% 89%)",
    muted: "okhsl(229 6% 67%)",
    dim: "okhsl(229 8% 56%)",
    accent: "okhsl(295 50% 67%)",
    success: "okhsl(159 59% 67%)",
    error: "okhsl(20 72% 67%)",
    warning: "okhsl(83 88% 67%)",
    mdLink: "okhsl(232 54% 67%)",
    syntaxVariable: "okhsl(202 58% 67%)",
    scrollbarTrack: "okhsl(237 7% 33%)",
    scrollbarThumb: "okhsl(232 7% 65%)",
  }),
  // Pi 1.5.0 `light.json`.
  light: Object.freeze({
    text: "okhsl(225 5% 27%)",
    muted: "okhsl(229 8% 47%)",
    dim: "okhsl(229 7% 59%)",
    accent: "okhsl(295 60% 46%)",
    success: "okhsl(159 75% 46%)",
    error: "okhsl(20 91% 47%)",
    warning: "okhsl(83 99% 47%)",
    mdLink: "okhsl(231 68% 47%)",
    syntaxVariable: "okhsl(203 73% 46%)",
    scrollbarTrack: "okhsl(248 3% 90%)",
    scrollbarThumb: "okhsl(226 7% 65%)",
  }),
});
