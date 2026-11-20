/**
 * Leaf settings UI primitives shared by the domain modules under
 * src/settings: the structural UiContext surface every menu seam takes,
 * aligned label/value row rendering, the duration and byte-size value
 * formatters, and the notify seam. Nothing here knows the staged settings
 * draft or the root menu.
 */
import type { MenuCustomFactory, MenuTuiHost, SettingsSaveControl } from "./menu";
import type { SettingTextEditor } from "./text-input";

export interface UiContext {
  select(title: string, options: string[]): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
  /** Pi's public multi-line editor with editable prefill (issue #26). */
  editor?(title: string, prefill?: string): Promise<string | undefined>;
  /**
   * Explicit host-owned settings text field (issue #653), e.g. the session-host
   * sidebar's shared SessionHostTextField. When present every settings text
   * field edits through it; Pi hosts never supply it and keep the native
   * editor bridge. See src/settings/text-input.ts.
   */
  editText?: SettingTextEditor;
  confirm?(title: string, message: string): Promise<boolean>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  /** Host custom TUI component (Pi hosts only); guarded by `mode === "tui"`. */
  custom?(factory: MenuCustomFactory): Promise<string | undefined>;
  /**
   * Explicit host-owned menu TUI host (issue #653), e.g. the session-host
   * sidebar's own pinned pi-tui components. When present every retained
   * settings menu and deny picker of this UI renders through that host's own
   * live SelectList, Input, keybinding sync, and theme seams — no Pi peer
   * load, no hidden Pi session, and no shared global override, so separate
   * UIs with separate hosts never interfere. Pi hosts never supply it and
   * keep the host-peer path unchanged. See src/settings/menu.ts.
   */
  menuTuiHost?: MenuTuiHost;
  /** Host run mode ("tui" | "rpc" | ...); carried from the command context. */
  mode?: string;
  /** The host session's working directory, carried from the command context. */
  cwd?: string;
  /** Optional root-owned save signal shared with settings menu selectors. */
  saveControl?: SettingsSaveControl;
}

export function alignedSettingsRows(entries: ReadonlyArray<readonly [label: string, value: string]>): string[] {
  const labelWidth = Math.max(0, ...entries.map(([label]) => label.length));
  return entries.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`);
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds % 60_000 === 0) return `${milliseconds / 60_000}m`;
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000}s`;
  return `${milliseconds}ms`;
}

export function formatByteSize(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MiB`;
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} bytes`;
}

export async function notify(ui: UiContext, message: string, type: "info" | "warning" | "error"): Promise<void> {
  ui.notify?.(message, type);
}
