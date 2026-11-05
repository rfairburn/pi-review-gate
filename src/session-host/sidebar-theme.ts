/**
 * Application-owned sidebar appearance palettes (#613).
 *
 * These are the session host's OWN two palettes. They never read Pi's saved
 * theme, Pi's configuration, or any running Pi process, and they never detect
 * what the terminal itself looks like: the operator's explicit choice inside
 * this host is the only input. Selection persists in the same per-native-agent
 * session-host state directory as the other host-owned settings.
 *
 * What the palettes PAINT is Pi's own colour vocabulary: every role takes its
 * foreground from a copied, var-resolved foreground token of Pi 1.5.0's
 * built-in `dark`/`light` themes (`sidebar-theme-colors.ts`), converted to
 * terminal output once at module load through the pinned `pi-session-host-tui`
 * colour API. There is no generic ANSI colour anywhere in a sidebar palette,
 * no hand-picked RGB triple, no colour math of our own, and no capability
 * query: the conversion mode is the fixed `"truecolor"` constant, so Pi's
 * authored colour is emitted exactly instead of being quantised to a palette
 * index.
 *
 * Every palette value is still an SGR *parameter string* drawn from one closed,
 * finite set derived from the two frozen palettes, so the renderer's generated
 * ANSI stays checkable against `SIDEBAR_THEME_SGR_CODES`. Only the specific
 * generated RGB parameter strings are allowed — never an arbitrary RGB triple.
 * A palette never carries text either: semantic status stays in the rendered
 * words.
 */

import { foregroundAnsi, parseColor } from "pi-session-host-tui";

import {
  PI_BUILTIN_FOREGROUND_COLORS,
  type PiSidebarColorToken,
} from "./sidebar-theme-colors";

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
 * `canvas` is the pane's explicit foreground — Pi's own body-text foreground
 * for that appearance — plus the TERMINAL'S DEFAULT background (`;49`), and the
 * renderer restores it after every row reset it generates. Pi 1.5's own chat
 * viewport is a ScrollView/VStack with no overall canvas: `export.pageBg` is HTML-only,
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

/**
 * The fixed conversion mode. Pi's authored colours are emitted exactly; a
 * 256-color mode would quantise them and a basic-ANSI palette cannot express
 * them at all. This is a constant, NOT `getCapabilities()` or
 * `getTerminalColorMode()`: the emitted SGR set must stay deterministic and
 * checkable, and the host performs no terminal query, environment sniffing, or
 * appearance detection of any kind.
 */
const SIDEBAR_COLOR_MODE = "truecolor";

/**
 * Convert one copied Pi token to the bare SGR foreground parameters the palette
 * mechanism stores (`38;2;<r>;<g>;<b>`). `foregroundAnsi` returns a complete
 * `ESC [ … m` sequence, so the wrapper is stripped here; anything that is not
 * exactly one in-range RGB foreground triple refuses rather than being passed
 * through, which keeps the generated set closed.
 */
function piForegroundParams(value: string): string {
  const sequence = foregroundAnsi(parseColor(value), SIDEBAR_COLOR_MODE);
  const params = /^\x1b\[(38;2;\d{1,3};\d{1,3};\d{1,3})m$/.exec(sequence)?.[1];
  if (params === undefined) {
    throw new Error(`Pi colour ${JSON.stringify(value)} did not convert to one exact truecolor foreground`);
  }
  const channels = params.split(";").slice(2).map((part) => Number.parseInt(part, 10));
  const inRange = channels.length === 3
    && channels.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255);
  if (!inRange) {
    throw new Error(`Pi colour ${JSON.stringify(value)} converted to an out-of-range foreground`);
  }
  return params;
}

/**
 * One sidebar role's colour: a Pi token plus the emphasis the role already had.
 * Bold stays a separate attribute layer (Pi's own themes carry no bold either),
 * so a palette change can never drop the bold distinction between two states.
 */
interface SidebarRoleColour {
  readonly token: PiSidebarColorToken;
  readonly bold: boolean;
}

/** Per-appearance role differences, keyed by role. */
type SidebarRoleOverrides = Readonly<Partial<Record<SidebarThemeRole, SidebarRoleColour>>>;

/**
 * The role map, shared by both appearances. Status VALUES are painted, never
 * the `agent ` / `input ` label words, the separator, or a plain `none`, which
 * stay on the pane canvas.
 *
 * A positively idle agent is Pi's muted colour, NOT a variant of the running
 * colour: idle, the ordinary `agent` word on the same row, and a running agent
 * then all read differently (muted, canvas text, and bold success). Running is
 * Pi's success, pending input is bold Pi's warning, and waiting input is the
 * same warning hue without the bold, so the two independent facts on one status
 * row stay separable while keeping their existing emphasis.
 */
const SHARED_ROLE_COLOURS: Readonly<Record<SidebarThemeRole, SidebarRoleColour>> = Object.freeze({
  header: { token: "accent", bold: true },
  // An ordinary card title keeps bold, and Pi's muted colour gives it real
  // contrast against the bold body-text title of the conversation that owns
  // Main (`activeMain` below) instead of resting on bold alone.
  title: { token: "muted", bold: true },
  selected: { token: "mdLink", bold: true },
  activeMain: { token: "text", bold: true },
  secondary: { token: "muted", bold: false },
  statusStarting: { token: "mdLink", bold: true },
  statusRunning: { token: "success", bold: true },
  statusWaiting: { token: "warning", bold: false },
  statusIdle: { token: "muted", bold: false },
  statusUnknown: { token: "dim", bold: false },
  statusExited: { token: "dim", bold: false },
  statusError: { token: "error", bold: true },
  inputPending: { token: "warning", bold: true },
  hint: { token: "muted", bold: false },
  notice: { token: "warning", bold: false },
  error: { token: "error", bold: true },
  accent: { token: "accent", bold: false },
  scrollbarTrack: { token: "scrollbarTrack", bold: false },
  scrollbarThumb: { token: "scrollbarThumb", bold: false },
});

/**
 * The only per-appearance differences, so both palettes stay recognisably the
 * same map. The Light navigation target uses Pi's accent rather than its link
 * colour, which keeps the magenta-family navigation and the violet header in
 * the family the Light palette already draws attention with; and Light's
 * `starting` value keeps the plain (unbolded) emphasis it had before.
 */
const THEME_ROLE_OVERRIDES = Object.freeze({
  dark: Object.freeze({}),
  light: Object.freeze({
    selected: Object.freeze({ token: "accent", bold: true }),
    statusStarting: Object.freeze({ token: "mdLink", bold: false }),
  }),
}) satisfies Readonly<Record<SidebarThemeId, SidebarRoleOverrides>>;

/**
 * Build one appearance's palette: every role's Pi token converted once, plus the
 * pane canvas (Pi's body-text foreground on the terminal's own default
 * background). The host never turns the whole sidebar into a black or white
 * panel; rows inherit whatever native ground the operator already uses, exactly
 * like Pi's own chat viewport, and no Pi background token is ever copied or
 * painted.
 */
function buildSidebarPalette(theme: SidebarThemeId): SidebarPalette {
  const colors = PI_BUILTIN_FOREGROUND_COLORS[theme];
  const overrides: SidebarRoleOverrides = THEME_ROLE_OVERRIDES[theme];
  const roles = {} as Record<SidebarThemeRole, string>;
  for (const role of Object.keys(SHARED_ROLE_COLOURS) as SidebarThemeRole[]) {
    const colour = overrides[role] ?? SHARED_ROLE_COLOURS[role];
    const foreground = piForegroundParams(colors[colour.token]);
    roles[role] = colour.bold ? `1;${foreground}` : foreground;
  }
  return Object.freeze({ ...roles, canvas: `${piForegroundParams(colors.text)};49` });
}

const DARK_PALETTE: SidebarPalette = buildSidebarPalette("dark");
const LIGHT_PALETTE: SidebarPalette = buildSidebarPalette("light");

/** The palette for one theme; both palettes cover exactly the same roles. */
export function sidebarPaletteFor(theme: SidebarThemeId): SidebarPalette {
  return theme === "light" ? LIGHT_PALETTE : DARK_PALETTE;
}

/**
 * Every SGR parameter string the two frozen palettes can produce: the exact
 * generated set, one entry per distinct palette role value. It is closed — the
 * renderer can never emit an RGB triple that is not in this set, and the set is
 * not a general RGB range or pattern.
 */
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
