/**
 * Application-owned sidebar appearance palettes (#613).
 *
 * These are the session host's OWN two palettes. They never read Pi's saved
 * theme, Pi's configuration, or any running Pi process, and they never detect
 * what the terminal itself looks like: the operator's explicit choice inside
 * this host is the only input. Selection persists in the same per-native-agent
 * session-host state directory as the other host-owned settings.
 *
 * Every palette value is an SGR *parameter string* drawn from one closed set,
 * so the renderer's generated ANSI stays finite and every emitted sequence is
 * checkable against `SIDEBAR_THEME_SGR_CODES`. No truecolor or 256-color
 * parameter is ever generated here, and a palette never carries text: semantic
 * status stays in the rendered words.
 */

export type SidebarThemeId = "dark" | "light";

/** The complete, closed set of themes this host offers. */
export const SIDEBAR_THEME_IDS: readonly SidebarThemeId[] = Object.freeze(["dark", "light"] as const);

/** The application default; an absent selection file selects it without writing one. */
export const DEFAULT_SIDEBAR_THEME: SidebarThemeId = "dark";

export function isSidebarThemeId(value: unknown): value is SidebarThemeId {
  return value === "dark" || value === "light";
}

/** Validate one theme id; anything else refuses rather than guessing. */
export function parseSidebarThemeId(value: unknown): SidebarThemeId {
  if (!isSidebarThemeId(value)) throw new Error("theme must be one supported appearance (dark or light)");
  return value;
}

/** Human label shown for one theme in the host's own settings UI. */
export function sidebarThemeLabel(theme: SidebarThemeId): string {
  return theme === "light" ? "Light" : "Dark";
}

/**
 * The closed set of roles a sidebar palette can paint. Roles name WHAT a row
 * means, never a color, so a theme change can never move, rename, or drop a
 * control: it only restyles rows the renderer already draws.
 */
export type SidebarThemeRole =
  /** A pane's own title row (" Sessions (3) ", " Settings ", " Theme "). */
  | "header"
  /** A session card title that is neither the selected target nor active Main. */
  | "title"
  /** The sidebar-selected navigation target. */
  | "selected"
  /** The conversation that actually owns Main's content and native input. */
  | "activeMain"
  /** Secondary host-owned text: card status/background, owner and status lines. */
  | "secondary"
  /** Footer hint rows the pane draws for its own keys. */
  | "hint"
  /** A bounded host notice ("! ..."). */
  | "notice"
  /** A bounded refusal or failed-action notice ("! ..."). */
  | "error"
  /** The current value of a host-owned setting (the chosen appearance). */
  | "accent"
  /** The scrollbar track glyph an overflowing roster draws in its last column. */
  | "scrollbarTrack"
  /**
   * The scrollbar thumb, whether idle or actively dragged. A dragged thumb uses
   * the SAME role with the block glyph, so a drag never introduces a new colour
   * and no hover state is needed.
   */
  | "scrollbarThumb";

/**
 * One palette: a value for every semantic role PLUS the pane's own `canvas`.
 *
 * `canvas` is an explicit foreground/background pair (`"37;40"`, `"30;47"`) the
 * renderer restores after every row reset it generates. Without it a row that
 * inherits the terminal's default foreground or background can be unreadable
 * when the operator's terminal defaults are the opposite of the chosen
 * appearance: a Light black `activeMain` title on a dark terminal, or a Dark
 * grey status line on a light one. The pair is finite, allowlisted, and applied
 * only to rows this host draws — no native child cell, outer header, or divider
 * is recolored, and there is no terminal query, detection, or configuration
 * write. The operator's explicit appearance choice stays the only input.
 */
export type SidebarPalette = Readonly<Record<SidebarThemeRole, string>> & {
  readonly canvas: string;
};

const DARK_PALETTE: SidebarPalette = Object.freeze({
  // Explicit pane ground: white-on-black. Every role below either names its own
  // foreground or inherits this one, so no sidebar row depends on what the
  // operator's terminal uses as its default colours.
  canvas: "37;40",
  header: "1;36",
  title: "1",
  selected: "1;34",
  activeMain: "1;97",
  secondary: "90",
  hint: "90",
  notice: "33",
  error: "1;31",
  accent: "36",
  scrollbarTrack: "90",
  scrollbarThumb: "97",
});

const LIGHT_PALETTE: SidebarPalette = Object.freeze({
  // Explicit pane ground: black-on-white, which is what makes the Light
  // `activeMain` black title readable on any terminal instead of invisible on a
  // dark one. The notice drops to plain red because yellow on white is not
  // readable; the refusal stays bold red, so the two notices stay distinct.
  canvas: "30;47",
  header: "1;34",
  title: "1",
  selected: "1;35",
  activeMain: "1;30",
  secondary: "34",
  hint: "35",
  notice: "31",
  error: "1;31",
  accent: "35",
  scrollbarTrack: "90",
  scrollbarThumb: "30",
});

/** The palette for one theme; both palettes cover exactly the same roles. */
export function sidebarPaletteFor(theme: SidebarThemeId): SidebarPalette {
  return theme === "light" ? LIGHT_PALETTE : DARK_PALETTE;
}

/** Every SGR parameter string any palette can produce, plus the row resets. */
export const SIDEBAR_THEME_SGR_CODES: ReadonlySet<string> = Object.freeze(
  new Set<string>(SIDEBAR_THEME_IDS.flatMap((theme) => Object.values(sidebarPaletteFor(theme)))),
);

/** One palette role's complete SGR sequence. */
export function sidebarSgr(palette: SidebarPalette, role: SidebarThemeRole): string {
  return `\x1b[${palette[role]}m`;
}

/** The host's own persisted appearance record. */
export interface SidebarAppearance {
  readonly theme: SidebarThemeId;
}

export const DEFAULT_SIDEBAR_APPEARANCE: SidebarAppearance = Object.freeze({
  theme: DEFAULT_SIDEBAR_THEME,
});

/** Validate and canonicalize one proposed appearance record. */
export function normalizeSidebarAppearance(value: unknown): SidebarAppearance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Appearance settings must be an object");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "theme")) {
    throw new Error("appearance settings contain an unknown property");
  }
  return Object.freeze({ theme: parseSidebarThemeId(record.theme) });
}

/**
 * Strict versioned JSON schema for the dedicated appearance file. Every
 * property is required: a partial record is a malformed file, not a request to
 * guess, and omission of the whole FILE is the only condition that selects the
 * default.
 */
export function parseAppearanceConfig(value: unknown): SidebarAppearance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("settings must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("settings require version 1");
  if (Object.keys(record).some((key) => key !== "version" && key !== "theme")) {
    throw new Error("settings contain an unknown property");
  }
  return Object.freeze({ theme: parseSidebarThemeId(record.theme) });
}
