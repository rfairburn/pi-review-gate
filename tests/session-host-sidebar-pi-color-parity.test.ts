/**
 * #613 decisive colour proof: every sidebar foreground role must be Pi's OWN
 * built-in Dark/Light colour, converted by the pinned Pi TUI colour API — not a
 * generic ANSI substitution and not a hand-picked RGB triple.
 *
 * Two tiers, deliberately separated:
 *
 * 1. Pure-unit tier (runs without a pinned Pi runtime): pinned RGB
 *    goldens for both appearances, the closed generated-SGR set, the refusal of
 *    an arbitrary RGB triple, the absence of any bare ANSI/bright foreground
 *    parameter, terminal-default backgrounds only, and the semantic
 *    distinctness contract (an idle agent reads differently from the ordinary
 *    `agent` word and from a running one).
 * 2. Native parity tier (the required Pi-host run): reads Pi's REAL built-in
 *    `dark.json`/`light.json` from the pinned installed
 *    `@earendil-works/pi-coding-agent` package (`PI_REVIEW_GATE_INSTALLED_AGENT`,
 *    the established CI UI-runtime pin), resolves the authored `vars` here in
 *    the test, and compares BOTH the copied source strings and every converted
 *    role foreground for both themes and all mapped roles. The package assets
 *    are read read-only; no Pi user data, configuration, settings, or running
 *    Pi is involved. Without the pin this tier skips with an honest reason;
 *    under `PI_REVIEW_GATE_REQUIRE_PI_HOST=1` (the CI full suite) a missing
 *    runtime fails instead of silently degrading.
 *
 * The parity tier never compares the palette against itself: its expected
 * values come from the installed package's theme files through the pinned
 * converter. A palette that still used `32`/`34`/`90`-style ANSI colours, or a
 * vendored token string that drifted from real Pi, fails here.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { foregroundAnsi, parseColor } from "pi-session-host-tui";

import { SIDEBAR_GENERATED_SGR_ALLOWLIST } from "../src/session-host/sidebar";
import {
  SIDEBAR_THEME_IDS,
  SIDEBAR_THEME_SGR_CODES,
  sidebarPaletteFor,
  type SidebarPalette,
  type SidebarThemeId,
  type SidebarThemeRole,
} from "../src/session-host/sidebar-theme";
import {
  PI_BUILTIN_FOREGROUND_COLORS,
  PI_SIDEBAR_COLOR_TOKENS,
  PI_THEME_COLOR_PROVENANCE,
  type PiSidebarColorToken,
} from "../src/session-host/sidebar-theme-colors";
import { missingHostError, piHostRequired } from "./tool-host-gate";

/** One Pi theme file, exactly as the installed package ships it. */
interface PiThemeJson {
  readonly name?: string;
  readonly vars?: Record<string, string>;
  readonly colors?: Record<string, string | number>;
}

/** One role's expected colour source: a Pi token plus the emphasis it carries. */
interface ExpectedStyle {
  readonly token: PiSidebarColorToken;
  readonly bold: boolean;
}

/** The palette for one appearance, widened so role keys can be listed. */
function paletteEntries(theme: SidebarThemeId): Record<keyof SidebarPalette, string> {
  return { ...sidebarPaletteFor(theme) } as Record<keyof SidebarPalette, string>;
}

// ---------------------------------------------------------------------------
// Tier 1 — pure-unit goldens and the closed generated set (always runs).
// ---------------------------------------------------------------------------

/**
 * The exact SGR parameter strings both appearances must produce. These are Pi
 * 1.5.0's authored colours converted to truecolor, restated as literals so a
 * palette regression fails even where no Pi runtime is pinned; the parity tier
 * below proves these literals ARE Pi's values.
 */
const GOLDEN_PALETTE: Readonly<Record<SidebarThemeId, Readonly<Record<keyof SidebarPalette, string>>>> = {
  dark: {
    canvas: "38;2;222;224;225;49",
    header: "1;38;2;167;152;215",
    title: "1;38;2;157;165;169",
    selected: "1;38;2;105;173;208",
    activeMain: "1;38;2;222;224;225",
    secondary: "38;2;157;165;169",
    statusStarting: "1;38;2;105;173;208",
    statusRunning: "1;38;2;104;183;141",
    statusWaiting: "1;38;2;205;154;34",
    statusIdle: "38;2;157;165;169",
    statusUnknown: "38;2;126;136;142",
    statusExited: "38;2;126;136;142",
    statusError: "1;38;2;234;127;129",
    inputPending: "1;38;2;205;154;34",
    hint: "38;2;157;165;169",
    notice: "38;2;205;154;34",
    error: "1;38;2;234;127;129",
    accent: "38;2;167;152;215",
    remoteHost: "38;2;93;179;186",
    scrollbarTrack: "38;2;72;78;82",
    scrollbarThumb: "38;2;151;160;165",
  },
  light: {
    canvas: "38;2;59;63;65;49",
    header: "1;38;2;116;89;180",
    title: "1;38;2;103;113;118",
    selected: "1;38;2;116;89;180",
    activeMain: "1;38;2;59;63;65",
    secondary: "38;2;103;113;118",
    statusStarting: "38;2;47;120;153",
    statusRunning: "1;38;2;51;126;88",
    statusWaiting: "1;38;2;143;104;2",
    statusIdle: "38;2;103;113;118",
    statusUnknown: "38;2;135;144;149",
    statusExited: "38;2;135;144;149",
    statusError: "1;38;2;200;37;61",
    inputPending: "1;38;2;143;104;2",
    hint: "38;2;103;113;118",
    notice: "38;2;143;104;2",
    error: "1;38;2;200;37;61",
    accent: "38;2;116;89;180",
    remoteHost: "38;2;40;122;129",
    scrollbarTrack: "38;2;225;227;228",
    scrollbarThumb: "38;2;150;160;164",
  },
};

/** The RGB channels of one palette value, asserting it IS a truecolor triple. */
function rgbOf(value: string): readonly [number, number, number] {
  const match = /^(?:1;)?38;2;(\d{1,3});(\d{1,3});(\d{1,3})/.exec(value);
  assert.ok(match, `${JSON.stringify(value)} is an exact 24-bit foreground`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Every SGR parameter of a palette value must be an attribute, a default-colour
 * selector, or the foreground triple: a palette can never carry a background
 * selector, so the ground stays the terminal's own.
 */
function assertForegroundOnly(value: string, label: string): void {
  const params = value.split(";").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < params.length; index += 1) {
    const param = params[index] ?? Number.NaN;
    if (param === 38) {
      // The extended foreground triple (or index) belongs to the colour itself.
      index += 4;
      continue;
    }
    assert.ok(
      param === 0 || param === 1 || param === 2 || param === 7 || param === 22
        || param === 27 || param === 39 || param === 49,
      `${label}: parameter ${param} would set a background or an unlisted attribute`,
    );
  }
}

test("both palettes are exactly the pinned Pi 1.5.0 foreground goldens", () => {
  for (const theme of SIDEBAR_THEME_IDS) {
    const palette = paletteEntries(theme);
    const golden = GOLDEN_PALETTE[theme];
    assert.deepEqual(Object.keys(palette).sort(), Object.keys(golden).sort(),
      `${theme}: the palette covers exactly the mapped roles`);
    for (const role of Object.keys(golden) as (keyof SidebarPalette)[]) {
      assert.equal(palette[role], golden[role], `${theme}.${role}: exact Pi foreground`);
    }
  }
});

test("no sidebar role falls back to a generic ANSI, bright, or 256-color foreground", () => {
  // The specific substitutions the old hand-written palettes used, named so a
  // revert cannot pass by accident.
  const obsolete = [
    "37;49", "30;49", "1;36", "36", "1", "1;34", "34", "1;97", "97", "90",
    "1;32", "32", "33", "1;33", "1;31", "31", "1;35", "35",
  ];
  for (const theme of SIDEBAR_THEME_IDS) {
    const palette = paletteEntries(theme);
    for (const [role, value] of Object.entries(palette)) {
      assert.match(value, /^(?:1;)?38;2;\d{1,3};\d{1,3};\d{1,3}(?:;49)?$/,
        `${theme}.${role}: an exact 24-bit foreground, never a palette index`);
      assertForegroundOnly(value, `${theme}.${role}`);
    }
    for (const value of obsolete) {
      assert.equal(Object.values(palette).includes(value), false,
        `${theme}: the obsolete ANSI value ${JSON.stringify(value)} is gone from the palette`);
    }
  }
});

test("idle, the ordinary agent word, and a running agent stay three different colours", () => {
  for (const theme of SIDEBAR_THEME_IDS) {
    const palette = paletteEntries(theme);
    // The `agent ` / `input ` label words and the separator carry the canvas
    // foreground (Pi's body text) with no emphasis of their own, on the
    // terminal's default ground; the `none` VALUE takes the idle role instead.
    assert.equal(palette.canvas.endsWith(";49"), true, `${theme}: canvas keeps the default background`);
    assert.equal(/^1;/.test(palette.canvas), false, `${theme}: the canvas foreground is not bold`);
    // idle: muted and unbolded, and different from BOTH the ordinary word and
    // running — never a bold same-hue variant of running.
    assert.notDeepEqual(rgbOf(palette.statusIdle), rgbOf(palette.canvas),
      `${theme}: idle differs from the ordinary agent word`);
    assert.notDeepEqual(rgbOf(palette.statusIdle), rgbOf(palette.statusRunning), `${theme}: idle differs from running`);
    assert.equal(/^1;/.test(palette.statusIdle), false, `${theme}: idle is muted, not emphasized`);
    assert.equal(/^1;/.test(palette.statusRunning), true, `${theme}: running keeps its bold`);
    // waiting/pending share one warning hue AND its bold: the two value words
    // read identically while their labels stay canvas text.
    assert.deepEqual(rgbOf(palette.statusWaiting), rgbOf(palette.inputPending),
      `${theme}: waiting and pending keep the same warning hue`);
    assert.equal(/^1;/.test(palette.statusWaiting), true, `${theme}: waiting carries pending's bold`);
    assert.equal(/^1;/.test(palette.inputPending), true, `${theme}: pending keeps its bold`);
    assert.equal(palette.statusWaiting, palette.inputPending,
      `${theme}: waiting and pending are the one warning look`);
    // The focus-domain roles stay three distinct looks, and an ordinary title no
    // longer rests on bold alone against the owner's title.
    assert.notDeepEqual(rgbOf(palette.selected), rgbOf(palette.activeMain), `${theme}: nav target and owner differ`);
    assert.notDeepEqual(rgbOf(palette.title), rgbOf(palette.activeMain), `${theme}: ordinary title and owner differ`);
    assert.notDeepEqual(rgbOf(palette.statusUnknown), rgbOf(palette.statusIdle), `${theme}: unknown is not idle`);
    assert.notDeepEqual(rgbOf(palette.scrollbarTrack), rgbOf(palette.scrollbarThumb), `${theme}: track and thumb differ`);
    // The remote owner's hostname is Pi's cyan variable colour: distinct from
    // every other foreground on the card, and never an emphasis the row can
    // mistake for a status. Hue only — the same unbolded weight as before.
    assert.equal(/^1;/.test(palette.remoteHost), false, `${theme}: the host name stays unbolded`);
    for (const other of ["canvas", "secondary", "title", "selected", "activeMain", "statusStarting",
      "statusRunning", "statusWaiting", "statusIdle", "statusUnknown", "statusError", "accent"] as const) {
      assert.notDeepEqual(rgbOf(palette.remoteHost), rgbOf(palette[other]),
        `${theme}: the host name reads differently from ${other}`);
    }
  }
});

test("the copied token set is exactly the eleven Pi colours the sidebar borrows", () => {
  // A twelfth copied token, or a rename away from a real Pi colour key, has to
  // show up here as well as in the real-Pi parity tier below.
  assert.deepEqual([...PI_SIDEBAR_COLOR_TOKENS], [
    "text", "muted", "dim", "accent", "success", "error", "warning", "mdLink",
    "syntaxVariable", "scrollbarTrack", "scrollbarThumb",
  ]);
  assert.equal(PI_SIDEBAR_COLOR_TOKENS.length, 11);
  for (const theme of SIDEBAR_THEME_IDS) {
    assert.deepEqual(Object.keys(PI_BUILTIN_FOREGROUND_COLORS[theme]).sort(),
      [...PI_SIDEBAR_COLOR_TOKENS].sort(),
      `${theme}: every copied token has a value in both built-in themes`);
  }
});

test("the generated SGR set stays closed: only the exact generated RGB codes are allowed", () => {
  const derived = new Set<string>(SIDEBAR_THEME_IDS.flatMap((theme) => Object.values(paletteEntries(theme))));
  assert.deepEqual(new Set(SIDEBAR_THEME_SGR_CODES), derived,
    "SIDEBAR_THEME_SGR_CODES is exactly the two frozen palettes");
  assert.ok(SIDEBAR_THEME_SGR_CODES.size <= 40, "the generated set stays finite");
  for (const code of SIDEBAR_THEME_SGR_CODES) {
    assert.ok(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(code), `${code} is emitted-allowed`);
  }
  // Negative controls: an arbitrary RGB triple, a 256-color index, and any
  // background parameter stay refused even though they are valid SGR syntax.
  for (const refused of ["38;2;255;0;0", "1;38;2;255;0;0", "38;2;222;224;224", "38;5;39", "44", "100", "48;2;0;0;0"]) {
    assert.equal(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(refused), false, `${refused} is not in the closed set`);
  }
  // The attribute-only allowances the renderer still owns (row resets, bold,
  // inverse) are unchanged and carry no colour.
  for (const attribute of ["0", "1", "7", "27", "1;7"]) {
    assert.equal(SIDEBAR_GENERATED_SGR_ALLOWLIST.has(attribute), true, `${attribute} stays allowed`);
  }
});

// ---------------------------------------------------------------------------
// Tier 2 — native parity against the real pinned Pi 1.5.0 theme files.
// ---------------------------------------------------------------------------

/** The role map, restated here independently of the production module. */
const EXPECTED_ROLE_STYLES: Readonly<Record<SidebarThemeId, Readonly<Record<SidebarThemeRole, ExpectedStyle>>>> = {
  dark: {
    header: { token: "accent", bold: true },
    title: { token: "muted", bold: true },
    selected: { token: "mdLink", bold: true },
    activeMain: { token: "text", bold: true },
    secondary: { token: "muted", bold: false },
    statusStarting: { token: "mdLink", bold: true },
    statusRunning: { token: "success", bold: true },
    statusWaiting: { token: "warning", bold: true },
    statusIdle: { token: "muted", bold: false },
    statusUnknown: { token: "dim", bold: false },
    statusExited: { token: "dim", bold: false },
    statusError: { token: "error", bold: true },
    inputPending: { token: "warning", bold: true },
    hint: { token: "muted", bold: false },
    notice: { token: "warning", bold: false },
    error: { token: "error", bold: true },
    accent: { token: "accent", bold: false },
    remoteHost: { token: "syntaxVariable", bold: false },
    scrollbarTrack: { token: "scrollbarTrack", bold: false },
    scrollbarThumb: { token: "scrollbarThumb", bold: false },
  },
  light: {
    header: { token: "accent", bold: true },
    title: { token: "muted", bold: true },
    selected: { token: "accent", bold: true },
    activeMain: { token: "text", bold: true },
    secondary: { token: "muted", bold: false },
    statusStarting: { token: "mdLink", bold: false },
    statusRunning: { token: "success", bold: true },
    statusWaiting: { token: "warning", bold: true },
    statusIdle: { token: "muted", bold: false },
    statusUnknown: { token: "dim", bold: false },
    statusExited: { token: "dim", bold: false },
    statusError: { token: "error", bold: true },
    inputPending: { token: "warning", bold: true },
    hint: { token: "muted", bold: false },
    notice: { token: "warning", bold: false },
    error: { token: "error", bold: true },
    accent: { token: "accent", bold: false },
    remoteHost: { token: "syntaxVariable", bold: false },
    scrollbarTrack: { token: "scrollbarTrack", bold: false },
    scrollbarThumb: { token: "scrollbarThumb", bold: false },
  },
};

/** Resolve one Pi colour entry the way the theme file means it (vars included). */
function resolveAuthoredColor(theme: PiThemeJson, name: string): string {
  const raw = theme.colors?.[name];
  if (typeof raw === "number") {
    throw new Error(`the pinned Pi theme paints ${name} with ANSI palette index ${raw}; the sidebar requires an authored colour`);
  }
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error(`the pinned Pi theme has no ${JSON.stringify(name)} colour`);
  }
  if (!raw.includes("(") && !raw.startsWith("#")) {
    const resolved = theme.vars?.[raw];
    if (typeof resolved !== "string" || !resolved.includes("(")) {
      throw new Error(`the pinned Pi theme has no concrete vars.${raw} colour for ${name}`);
    }
    return resolved;
  }
  return raw;
}

/** The same pinned conversion production uses, applied to a real Pi value. */
function convertPiForeground(value: string): string {
  const sequence = foregroundAnsi(parseColor(value), "truecolor");
  const params = /^\x1b\[(38;2;\d{1,3};\d{1,3};\d{1,3})m$/.exec(sequence)?.[1];
  if (params === undefined) {
    throw new Error(`Pi's authored colour ${JSON.stringify(value)} did not convert to one exact truecolor foreground`);
  }
  return params;
}

/** The installed package's built-in theme files, read read-only. */
interface PinnedThemeFiles {
  readonly themeJson: Record<SidebarThemeId, PiThemeJson>;
  readonly packageVersion: string;
}

/**
 * Pi releases whose shipped `dark.json`/`light.json` were audited against this
 * colour copy: v1.5.0 is the authored source, and 1.5.1 ships byte-identical
 * theme files (compared directly between the published 1.5.0 and 1.5.1
 * `@earendil-works/pi-coding-agent` packages).
 */
const PI_THEME_PARITY_AUDITED_VERSIONS: readonly string[] = Object.freeze(["1.5.0", "1.5.1"]);

/** Read the pinned installed Pi package's built-in theme files (read-only). */
function pinnedPiThemeFiles(): PinnedThemeFiles | { reason: string } {
  const pinned = process.env.PI_REVIEW_GATE_INSTALLED_AGENT?.trim();
  if (!pinned) {
    return { reason: "no pinned Pi UI runtime (set PI_REVIEW_GATE_INSTALLED_AGENT to an @earendil-works/pi-coding-agent package root)" };
  }
  const manifestPath = join(pinned, "package.json");
  if (!existsSync(manifestPath)) return { reason: `pinned Pi package manifest is missing: ${manifestPath}` };
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; version?: string };
  if (manifest.name !== PI_THEME_COLOR_PROVENANCE.package) {
    return { reason: `pinned package is ${JSON.stringify(manifest.name)}, not ${PI_THEME_COLOR_PROVENANCE.package}` };
  }
  const themeDir = join(pinned, "dist", "modes", "interactive", "theme");
  const themeJson = {} as Record<SidebarThemeId, PiThemeJson>;
  for (const theme of SIDEBAR_THEME_IDS) {
    const file = join(themeDir, `${theme}.json`);
    if (!existsSync(file)) return { reason: `the pinned Pi package ships no built-in ${theme}.json at ${file}` };
    themeJson[theme] = JSON.parse(readFileSync(file, "utf8")) as PiThemeJson;
  }
  return { themeJson, packageVersion: manifest.version ?? "" };
}

test("the copied Pi colour values carry the required MIT attribution", () => {
  // Compiled tests run from dist-test/tests, so two levels up is the project root.
  const projectRoot = join(__dirname, "..", "..");
  const dataModule = readFileSync(join(projectRoot, "src", "session-host", "sidebar-theme-colors.ts"), "utf8");
  assert.match(dataModule, /github\.com\/earendil-works\/pi\/tree\/v1\.5\.0\/packages\/coding-agent\/src\/modes\/interactive\/theme/,
    "the colour table names its upstream source files");
  assert.match(dataModule, /LICENSES\/MIT-pi-theme-colors\.txt/,
    "the colour table points at the license text");

  const license = readFileSync(join(projectRoot, "LICENSES", "MIT-pi-theme-colors.txt"), "utf8");
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2025 Mario Zechner/,
    "the license text carries the upstream copyright, verified from the published package");
  assert.match(license, /blob\/v1\.5\.0\/packages\/coding-agent\/src\/modes\/interactive\/theme\/dark\.json/);
  assert.match(license, /blob\/v1\.5\.0\/packages\/coding-agent\/src\/modes\/interactive\/theme\/light\.json/);
  assert.match(license, /sidebar-theme-colors\.ts/, "the license names the file holding the copy");

  const notice = readFileSync(join(projectRoot, "NOTICE"), "utf8");
  assert.match(notice, /Pi Coding Agent \(https:\/\/github\.com\/earendil-works\/pi\)/);
  assert.match(notice, /LICENSES\/MIT-pi-theme-colors\.txt/);
});

test("the copied tokens and every converted sidebar foreground match real Pi 1.5.0 Dark/Light", (t) => {
  const resolved = pinnedPiThemeFiles();
  if ("reason" in resolved) {
    if (piHostRequired()) throw missingHostError(resolved.reason);
    t.skip(resolved.reason);
    return;
  }
  // The copy names Pi v1.5.0 as its authored source (PI_THEME_COLOR_PROVENANCE).
  // A newer pinned runtime is accepted only while its shipped built-in theme
  // files are audited for this copy: Pi 1.5.1's `dist/modes/interactive/theme/
  // dark.json` and `light.json` are byte-identical to v1.5.0's, so the authored
  // provenance and the copied strings stay unchanged while the parity below
  // still runs against the runtime actually installed. Any other installed
  // release fails closed until its theme files are audited.
  assert.ok(PI_THEME_PARITY_AUDITED_VERSIONS.includes(resolved.packageVersion),
    `the vendored colour copy is audited for Pi ${PI_THEME_PARITY_AUDITED_VERSIONS.join(" and ")}, not the installed Pi ${resolved.packageVersion}`);

  for (const theme of SIDEBAR_THEME_IDS) {
    const themeJson: PiThemeJson = resolved.themeJson[theme];
    assert.equal(themeJson.name, theme, `the pinned package's ${theme}.json is the built-in ${theme} theme`);

    // 1. The copied source strings must equal the real authored, var-resolved Pi
    //    values — this catches a fake or drifted "theme colour".
    for (const token of PI_SIDEBAR_COLOR_TOKENS) {
      assert.equal(PI_BUILTIN_FOREGROUND_COLORS[theme][token], resolveAuthoredColor(themeJson, token),
        `${theme}.${token}: the copied token string is identical to real Pi's authored value`);
    }

    // 2. Every mapped role's converted foreground must equal what real Pi's own
    //    value converts to through the pinned converter.
    const palette = paletteEntries(theme);
    const styles = EXPECTED_ROLE_STYLES[theme];
    const paletteRoles = Object.keys(palette).filter((key) => key !== "canvas").sort();
    assert.deepEqual(Object.keys(styles).sort(), paletteRoles,
      `${theme}: the restated role map covers every painted sidebar role`);
    for (const role of Object.keys(styles) as SidebarThemeRole[]) {
      const style = styles[role];
      const authored = resolveAuthoredColor(themeJson, style.token);
      const converted = convertPiForeground(authored);
      const expected = style.bold ? `1;${converted}` : converted;
      assert.equal(palette[role], expected, `${theme}.${role}: Pi's ${style.token} (${authored}) converted exactly`);
      // The always-on goldens are the same real-Pi values, not a second opinion.
      assert.equal(GOLDEN_PALETTE[theme][role], expected, `${theme}.${role}: the golden is real Pi`);
    }

    // 3. The canvas is Pi's body text on the terminal's own default background.
    assert.equal(palette.canvas, `${convertPiForeground(resolveAuthoredColor(themeJson, "text"))};49`,
      `${theme}: canvas is Pi text over the terminal-default background`);
    assert.equal(GOLDEN_PALETTE[theme].canvas, palette.canvas, `${theme}: the canvas golden is real Pi`);
  }
});
