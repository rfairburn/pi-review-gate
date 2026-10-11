import type { KeyId } from "pi-session-host-tui";

/** Host-owned actions only; this is deliberately separate from Pi keybindings. */
export interface HostShortcutBindings {
  readonly toggle: string;
  readonly returnToMain: string;
}

export const DEFAULT_HOST_SHORTCUTS: HostShortcutBindings = Object.freeze({
  toggle: "alt+left",
  returnToMain: "alt+right",
});

const MODIFIER_ORDER = ["ctrl", "shift", "alt", "super"] as const;
const MODIFIER_SET = new Set<string>(MODIFIER_ORDER);
const SYMBOL_KEYS = new Set([
  "`", "-", "=", "[", "]", "\\", ";", "'", ",", ".", "/", "!", "@", "#", "$", "%", "^", "&", "*",
  "(", ")", "_", "|", "~", "{", "}", ":", "<", ">", "?",
]);
const NAVIGATION_KEYS = new Set(["up", "down", "left", "right", "home", "end", "pageup", "pagedown"]);
// Extra key IDs that the pinned matcher treats as overlapping in at least one
// supported legacy packet mode. Keep these as canonical pairs, not native-Pi
// collisions: only host actions are compared here.
const MATCHER_ALIAS_PAIRS: readonly (readonly [string, string])[] = [
  ["ctrl+-", "ctrl+_"], // both map to raw Ctrl+_ (0x1f)
  ["ctrl+alt+-", "ctrl+alt+_"], // both map to ESC + raw Ctrl+_ in legacy mode
  ["alt+b", "alt+left"],
  ["alt+f", "alt+right"],
  ["alt+p", "alt+up"],
  ["alt+n", "alt+down"], // legacy ESC + printable also aliases Alt+arrow
];

/** Normalize one host chord to the pinned matcher's canonical KeyId spelling. */
export function normalizeHostShortcutKey(raw: unknown, action: string): string {
  const label = action === "returnToMain" ? "returnToMain" : "toggleKey";
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 80
    || /[\u0000-\u001f\u007f-\u009f\s]/u.test(raw)) {
    throw new Error(`${label} must be one supported host shortcut chord`);
  }
  const parts = raw.toLowerCase().split("+");
  const base = parts.at(-1);
  const modifiers = parts.slice(0, -1);
  if (!base || modifiers.some((modifier) => !MODIFIER_SET.has(modifier))) {
    throw new Error(`${label} must use supported ctrl, shift, alt, or super modifiers`);
  }
  if (new Set(modifiers).size !== modifiers.length) {
    throw new Error(`${label} must not repeat a modifier`);
  }

  if (base === "escape" || base === "esc") {
    throw new Error(`${label} conflicts with native Escape`);
  }
  if (base === "[" && modifiers.includes("ctrl")) {
    throw new Error(`${label} conflicts with native Escape (Ctrl+[)`);
  }
  if (base === "c" && modifiers.length === 1 && modifiers[0] === "ctrl") {
    throw new Error(`${label} conflicts with native Ctrl+C`);
  }
  if ((base === "m" || base === "j") && modifiers.length === 1 && modifiers[0] === "ctrl") {
    throw new Error(`${label} conflicts with native Enter (Ctrl+M/Ctrl+J)`);
  }
  if (base === "q" && (modifiers.length === 0 || (modifiers.length === 1 && modifiers[0] === "shift"))) {
    throw new Error(`${label} conflicts with native q/Q`);
  }

  const functionKey = /^f(1[0-2]|[1-9])$/.exec(base);
  if (functionKey) {
    if (modifiers.length !== 0) {
      throw new Error(`${label} supports only unmodified F1-F12 function keys`);
    }
    return base;
  }

  const printable = /^[a-z0-9]$/.test(base) || SYMBOL_KEYS.has(base);
  if (printable) {
    // Shift-only printable input is ordinary typing, not a host action. The
    // matcher does not provide an independent Shift-only chord identity.
    if (!modifiers.some((modifier) => modifier !== "shift")) {
      throw new Error(`${label} must not reserve ordinary typing`);
    }
  } else if (NAVIGATION_KEYS.has(base)) {
    if (modifiers.length === 0) {
      throw new Error(`${label} must not reserve plain navigation`);
    }
  } else {
    // In particular, Enter/Return and Space are not host shortcuts. Keeping
    // the accepted special-key set narrow avoids editor/form aliases and keys
    // the pinned matcher cannot identify consistently.
    throw new Error(`${label} is not a supported modified key or unmodified F1-F12`);
  }

  const canonicalBase = base === "pageup" ? "pageUp" : base === "pagedown" ? "pageDown" : base;
  const canonicalModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier));
  return [...canonicalModifiers, canonicalBase].join("+");
}

/** Validate and canonicalize the two independently configured host actions. */
export function normalizeHostShortcutBindings(value: unknown): HostShortcutBindings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Host shortcut settings must be an object");
  }
  const raw = value as Record<string, unknown>;
  const toggle = normalizeHostShortcutKey(raw.toggle, "toggle");
  const returnToMain = normalizeHostShortcutKey(raw.returnToMain, "returnToMain");
  assertHostShortcutsDistinct(toggle, returnToMain);
  return Object.freeze({ toggle, returnToMain });
}

/** Reject key spellings that the pinned matcher considers the same chord. */
export function assertHostShortcutsDistinct(toggle: string, returnToMain: string): void {
  const canonicalToggle = normalizeHostShortcutKey(toggle, "toggle");
  const canonicalReturn = normalizeHostShortcutKey(returnToMain, "returnToMain");
  const overlaps = canonicalToggle === canonicalReturn || MATCHER_ALIAS_PAIRS.some(([left, right]) =>
    (canonicalToggle === left && canonicalReturn === right)
    || (canonicalToggle === right && canonicalReturn === left));
  if (overlaps) {
    throw new Error("toggle and returnToMain must use different shortcut chords because the pinned matcher treats them as overlapping");
  }
}

/** Runtime type bridge for the pinned matcher after validation. */
export function asHostKeyId(value: string): KeyId {
  return value as KeyId;
}

/** Strict versioned JSON schema. Omitted actions retain their defaults. */
export function parseHostShortcutConfig(value: unknown): HostShortcutBindings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("settings must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("settings require version 1");
  if (Object.keys(record).some((key) => key !== "version" && key !== "toggle" && key !== "returnToMain")) {
    throw new Error("settings contain an unknown property");
  }
  const toggle = record.toggle === undefined
    ? DEFAULT_HOST_SHORTCUTS.toggle
    : normalizeHostShortcutKey(record.toggle, "toggle");
  const returnToMain = record.returnToMain === undefined
    ? DEFAULT_HOST_SHORTCUTS.returnToMain
    : normalizeHostShortcutKey(record.returnToMain, "returnToMain");
  assertHostShortcutsDistinct(toggle, returnToMain);
  return Object.freeze({ toggle, returnToMain });
}
