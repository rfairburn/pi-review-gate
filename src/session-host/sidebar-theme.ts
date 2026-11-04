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
  /**
   * The agent/lifecycle STATUS VALUE on a card's status row. These are separate
   * semantic roles because one status row can carry two independent facts:
   * an idle agent waiting for input is not the same as a running agent that
   * happens to have no pending input. A role paints only the value word
   * (`running`, `idle`, `unknown`); the `agent ` / `input ` label words, the
   * separator, and a plain `none` stay on the neutral pane canvas.
   */
  | "statusStarting"
  | "statusRunning"
  | "statusWaiting"
  | "statusIdle"
  | "statusUnknown"
  | "statusExited"
  | "statusError"
  /**
   * Pending editable input, emphasized independently of the agent state: the
   * `pending` value word only, never its `input ` label.
   */
  | "inputPending"
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
 * `canvas` is the pane's explicit foreground plus the TERMINAL'S DEFAULT
 * background (`"37;49"` for Dark, `"30;49"` for Light), and the renderer
 * restores it after every row reset it generates. Pi 1.5's own chat viewport is
 * a ScrollView/VStack with no overall canvas: `export.pageBg` is HTML-only,
 * message/tool panels carry their own scoped backgrounds, and terminal-default
 * colours are the native fallback. The sidebar therefore keeps the host's
 * chosen foreground readable without painting a black or white ground over the
 * operator's terminal. The pair is finite, allowlisted, and applied only to
 * rows this host draws — no native child cell, outer header, or divider is
 * recolored, and there is no terminal query, detection, or configuration
 * write. The operator's explicit appearance choice stays the only input.
 */
export type SidebarPalette = Readonly<Record<SidebarThemeRole, string>> & {
  readonly canvas: string;
};

const DARK_PALETTE: SidebarPalette = Object.freeze({
  // White foreground on the terminal's OWN default background. The host never
  // turns the whole sidebar into a black panel; rows inherit whatever native
  // ground the operator already uses, exactly like Pi's own chat viewport.
  canvas: "37;49",
  header: "1;36",
  title: "1",
  selected: "1;34",
  activeMain: "1;97",
  secondary: "90",
  statusStarting: "1;34",
  // Running is bold green and idle plain green: the SAME hue carries the agent's
  // own state, and the bold is what separates a working agent from a positively
  // idle one. Pending input keeps its own amber, bold on waiting's hue, so the
  // two facts on one status row stay independently readable.
  statusRunning: "1;32",
  statusWaiting: "33",
  statusIdle: "32",
  statusUnknown: "90",
  statusExited: "90",
  statusError: "1;31",
  inputPending: "1;33",
  hint: "90",
  notice: "33",
  error: "1;31",
  accent: "36",
  scrollbarTrack: "90",
  scrollbarThumb: "97",
});

const LIGHT_PALETTE: SidebarPalette = Object.freeze({
  // Black foreground on the terminal's OWN default background, not a forced
  // white panel. The notice drops to plain red because yellow on a light ground
  // is not readable; the refusal stays bold red, so the two notices stay
  // distinct. Status colours stay dark enough to read on the same default.
  canvas: "30;49",
  header: "1;34",
  title: "1",
  selected: "1;35",
  // The owner title needs its OWN colour, not the canvas black: once the pane
  // canvas foreground is applied, a black `activeMain` and a bold-only `title`
  // land on the same terminal cell attributes, so the conversation that owns
  // Main would be indistinguishable from an ordinary card. This is the SAME
  // blue the Light header already uses, and it stays distinct from the magenta
  // navigation target above it.
  activeMain: "1;34",
  secondary: "34",
  statusStarting: "34",
  // Same running/idle and pending/waiting relationship as the Dark palette: one
  // hue per fact, bold for the two states that ask for attention.
  statusRunning: "1;32",
  statusWaiting: "33",
  statusIdle: "32",
  statusUnknown: "90",
  statusExited: "90",
  statusError: "1;31",
  inputPending: "1;33",
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
