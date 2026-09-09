/**
 * Occupancy checks against Pi's own resolved keybindings (issue #20). The
 * host keybinding table is never duplicated here: when Pi is loadable, its
 * live {@link KeybindingsManager} resolution (built-in defaults plus user
 * keybindings.json overrides) is queried; when it is not (unit tests, or a
 * host that does not expose the manager), the check reports itself as
 * unresolved instead of guessing from a copied table. Pi additionally emits
 * its own startup shortcut diagnostics for extension conflicts, so an
 * undetectable conflict is still surfaced by the host rather than silently
 * resolved either way.
 */

import { canonicalModeCycleChord } from "./config";

export interface HostKeybindingCheck {
  /** True when Pi's live resolution could be read at all. */
  resolved: boolean;
  /** Keybinding ids whose current resolution includes the checked key. */
  bindings: string[];
}

type HostKeybindingResolution = Record<string, unknown>;

type HostKeybindingLoader = () => HostKeybindingResolution | undefined;

let loaderOverride: HostKeybindingLoader | undefined;

/** Test seam: replace (or clear) the host resolution loader. */
export function setHostKeybindingLoader(value: HostKeybindingLoader | undefined): void {
  loaderOverride = value;
}

function loadHostKeybindingResolution(): HostKeybindingResolution | undefined {
  try {
    // Loaded inside Pi: the extension loader aliases @earendil-works/pi-tui
    // to the running host's module. Never a hard import: the package is a
    // host-provided peer, not a dependency of this extension.
    const tui = require("@earendil-works/pi-tui") as
      | {
          getKeybindings?: () => { getResolvedBindings?: () => unknown } | undefined;
        }
      | undefined;
    const manager = tui?.getKeybindings?.();
    const resolution = manager?.getResolvedBindings?.();
    return isRecord(resolution) ? resolution : undefined;
  } catch {
    // Outside Pi (unit tests, tooling) the peer is simply not resolvable.
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return the built-in keybinding ids currently bound to `key`, using Pi's
 * live resolution when available and reporting `resolved: false` otherwise.
 * Both sides are compared as canonical chord identities (modifier order and
 * casing/alias insensitive), so a host binding for "ctrl+shift+r" is detected
 * even when the configured shortcut is written "shift+ctrl+r".
 */
export function findOccupiedHostBindings(key: string): HostKeybindingCheck {
  const resolution = (loaderOverride ?? loadHostKeybindingResolution)();
  if (!resolution) return { resolved: false, bindings: [] };
  const target = canonicalModeCycleChord(key);
  if (target === undefined) return { resolved: true, bindings: [] };
  const bindings: string[] = [];
  for (const [id, keys] of Object.entries(resolution)) {
    for (const candidate of Array.isArray(keys) ? keys : [keys]) {
      if (typeof candidate === "string" && canonicalModeCycleChord(candidate) === target) {
        bindings.push(id);
        break;
      }
    }
  }
  return { resolved: true, bindings };
}
