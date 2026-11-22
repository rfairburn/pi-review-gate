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
  /**
   * Optional host-only presentation of a section's contextual help (issue
   * #653). Pi hosts never supply it: they keep the full help as one ordinary
   * `notify` on entry, exactly as before. See {@link withSettingsSectionHelp}.
   */
  settingsSectionHelp?: SettingsSectionHelpPort;
  /**
   * Optional host-only confirmation for a confirmation that the native flow
   * precedes with a separate warning notice (issue #653). Pi hosts never
   * supply it: they keep the warning `notify` followed by `confirm`, exactly
   * as before. See {@link SettingsWarningConfirmPort}.
   */
  settingsWarningConfirm?: SettingsWarningConfirmPort;
  /**
   * Optional host-owned registration seam for the ONE staged-draft dirty
   * predicate of a running Review settings transaction (issue #723). Pi hosts
   * never supply it. See {@link SettingsDraftStatus}.
   */
  settingsDraftStatus?: SettingsDraftStatus;
}

/**
 * The one handle a host that embeds the shared Review settings menu uses to
 * learn whether the transaction it is showing has unsaved changes (issue
 * #723) — for example a sidebar pane that must confirm before it leaves the
 * editor for another row.
 *
 * It is a single registration slot, deliberately not an observer list: one
 * transaction runs on one UI at a time, and the transaction is the only thing
 * that can answer the question. {@link attach} is called once, at transaction
 * opening, with the transaction's OWN existing dirty comparison — the value
 * comparison over the single shared staged draft that the caller-supplied
 * target switch already uses (issue #716). Nothing is copied, mirrored, or
 * recomputed elsewhere, and the predicate has no effect on Save, Apply, or
 * cancellation. Because a nested Create/Edit form commits only when the
 * operator applies it, the same comparison also reads the one form whose
 * unapplied edits are currently on screen, so what the operator can see is
 * never reported clean.
 *
 * The returned function detaches the predicate. The transaction calls it when
 * it ends, on every exit path (Save, root Escape, Cancel, an accepted target
 * switch, or a rejection), so a host never keeps a predicate whose draft is
 * gone. A host must not hold on to the predicate past that detach, and must not
 * assume one exists at all: without this seam every surface behaves exactly as
 * it did before it.
 */
export interface SettingsDraftStatus {
  attach(isChanged: () => boolean): () => void;
}

/**
 * A host whose settings notices share ONE slot (the session-host sidebar)
 * shows `summary` as the contextual notice of every screen `run` opens and
 * restores its previous notice once `run` settles. It never stores or
 * replays settings values.
 */
export interface SettingsSectionHelpPort {
  section<T>(summary: string, run: () => Promise<T>): Promise<T>;
}

/**
 * A host whose settings notices share ONE slot (the session-host sidebar)
 * would otherwise let a confirmation's own message displace the separately
 * emitted warning before it. `confirm` receives both canonical texts
 * explicitly and presents them together as the confirmation's mandatory
 * disclosure, warning first; it resolves true only for an explicit Yes and
 * false for No, cancel, or a closed screen.
 */
export interface SettingsWarningConfirmPort {
  confirm(title: string, warning: string, message: string): Promise<boolean>;
}

/** One settings section's help: the full native description and its concise summary. */
export interface SettingsSectionHelp {
  /** Shown through `notify` on entry by every host without the port (Pi). */
  readonly full: string;
  /** Shown instead by a host with the port; points to the canonical docs for the details. */
  readonly summary: string;
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

/**
 * Run one settings section with its contextual help. Without the host port
 * this is the unchanged native flow: one `notify` of the full help, then the
 * section.
 */
export async function withSettingsSectionHelp<T>(
  ui: UiContext,
  help: SettingsSectionHelp,
  run: () => Promise<T>,
): Promise<T> {
  const port = ui.settingsSectionHelp;
  if (typeof port?.section !== "function") {
    await notify(ui, help.full, "info");
    return await run();
  }
  return await port.section(help.summary, run);
}
