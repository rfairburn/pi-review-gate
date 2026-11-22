/**
 * Session-host sidebar presenter for the LOCAL review settings (issue #653).
 *
 * The sidebar is only a configuration vessel for the ONE shared persisted
 * `/review-settings` transaction that Main opens through
 * `openLocalReviewSettings`: this module owns no settings data, no option
 * list, no menu definition, and no IO. It composes the structural
 * {@link UiContext} that transaction takes from three primitives the sidebar
 * supplies — its own in-pane `custom` screen host, its shared
 * SessionHostTextField (`editText`), and a bounded notice sink with its
 * optional single-slot section help — plus a
 * {@link MenuTuiHost} built from this project's pinned `pi-session-host-tui`
 * components, supplied per UI (never through the process-global
 * `setMenuTuiHost` test seam).
 *
 * The host deliberately has no `setKeybindings` member: the shared menus would
 * otherwise install the live manager process-globally and leave it there. The
 * sidebar instead runs every factory, render, and input of a screen inside
 * {@link SidebarMenuKeybindings.run}, which Main backs with the existing
 * `withNativeFieldKeybindings` scope, so configured `tui.select.*` and editing
 * bindings apply while nothing stays installed afterwards.
 *
 * `select` and `confirm` are small list screens on the same `custom` host and
 * the same pinned SelectList. They never latch a save; a confirm defaults to
 * No, and a cancel (or an aborted pane) is always No. Like the shared menus,
 * their list follows the rows the pane measured for the screen. A confirm's
 * message is the screen's mandatory `disclosure` metadata: the pane shows it
 * whole as the screen's one notice and accepts Yes only from a written frame
 * that shows it. A confirmation the native flow precedes with a separate
 * warning arrives through the explicit `settingsWarningConfirm` port instead,
 * and its disclosure is that warning followed by the message.
 *
 * Issue #716 requester side: {@link runTargetedReviewSettings} is the one
 * reusable outer loop of that same transaction for a caller that owns a target
 * list (the remote Review editor). It opens LOCAL first, then a
 * caller-qualified exact remote target whenever the shared editor reports a
 * switch, and it owns the host picker and the dirty-draft confirmation — both
 * on this file's own `custom` viewport and both driven by stable host
 * identity, never by a display label or a roster row. It knows no transport,
 * no configuration data, and no save backend: every open comes from the
 * caller, and the pane's lifetime is the caller's `AbortSignal` (see
 * `SidebarReviewSettingsHost.open`).
 */
import {
  Container,
  Input,
  isKeyRelease,
  isKeyRepeat,
  Key,
  matchesKey,
  SelectList,
  Text,
} from "pi-session-host-tui";
import {
  claimMenuAction,
  consumeMenuActionFence,
  createMenuListPointer,
  createMenuListViewport,
  fitMenuListViewport,
  MENU_NATIVE_MAX_VISIBLE,
  menuPartRows,
  menuRenderTheme,
  resolveMenuActionMatcher,
  type MenuCustomFactory,
  type MenuSelectItem,
  type MenuTuiHost,
} from "../settings/menu";
import type { PersistedReviewSettingsInput } from "../settings/command";
import type { SettingTextEditor } from "../settings/text-input";
import type {
  NativeTextFieldRegion,
  TextFieldMouseEvent,
  TextFieldMouseResult,
} from "../text-field-mouse";
import type { SettingsDraftStatus, SettingsSectionHelpPort, UiContext } from "../settings/ui";

/** The live native keybinding manager surface the sidebar's settings screens use. */
export interface SidebarMenuKeybindingsManager {
  matches(data: string, keybinding: string): boolean;
  getKeys?(keybinding: string): readonly string[];
  getDefinition?(keybinding: string): unknown;
}

/**
 * The native keybindings of ONE review-settings open. `run` scopes the
 * manager for components that read pi-tui's global keybindings and must
 * restore the previous manager when it returns (Main: the existing
 * `withNativeFieldKeybindings`).
 */
export interface SidebarMenuKeybindings {
  readonly manager: SidebarMenuKeybindingsManager;
  run<T>(operation: () => T): T;
  /** Bounded notice when the native keybindings file could not be used. */
  readonly notice?: string;
}

/**
 * Main's narrow review-settings port for the sidebar. `open` runs the shared
 * transaction over the given UI and resolves when the whole pane open ends; it
 * never receives selected-session or remote-row data. `loadKeybindings` reads
 * the native keybindings fresh for each open.
 *
 * `signal` (issue #716) is the pane's lifetime, aborted once when the pane ends
 * for any reason (hide, toggle, shutdown, another pane, or a superseding open).
 * A LOCAL-only open may ignore it; a caller that also opens remote targets
 * (see {@link runTargetedReviewSettings}) passes it on as the lifetime of its
 * own work, so a late load, picker, confirmation, or switch can neither start
 * the next open nor touch a closed pane. It is advisory cancellation only: the
 * shared written-frame and held-input fences keep their authority, and an
 * aborted pane never invents, saves, or discards a persisted draft.
 */
export interface SidebarReviewSettingsHost {
  open(ui: UiContext, signal?: AbortSignal): Promise<void>;
  loadKeybindings?(): SidebarMenuKeybindings;
}

/** The sidebar primitives one review-settings UI is composed from. */
export interface SidebarReviewSettingsUiPorts {
  custom(factory: MenuCustomFactory): Promise<string | undefined>;
  editText: SettingTextEditor;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  /** The pane's single contextual-notice slot for a running settings section (#653). */
  sectionHelp?: SettingsSectionHelpPort;
  /**
   * The pane's single registration slot for the running transaction's own
   * dirty predicate (#723). Passed through unchanged as
   * {@link UiContext.settingsDraftStatus}, so the LOCAL editor, the targeted
   * loop's LOCAL open, and the remote editor (whose UI inherits this one) all
   * publish the SAME shared-draft comparison and nothing else.
   */
  draftStatus?: SettingsDraftStatus;
  menuTuiHost: MenuTuiHost;
}

/**
 * The pinned pi-tui components as a per-UI menu host. Key hints follow the
 * live manager, so a remapped binding is described truthfully.
 */
export function createSidebarMenuTuiHost(manager: SidebarMenuKeybindingsManager): MenuTuiHost {
  const ctrlS = Key.ctrl("s");
  return {
    SelectList: SelectList as unknown as MenuTuiHost["SelectList"],
    Container: Container as unknown as MenuTuiHost["Container"],
    Text: Text as unknown as MenuTuiHost["Text"],
    Input: Input as unknown as MenuTuiHost["Input"],
    matchesCtrlS: (data) => matchesKey(data, ctrlS),
    rawKeyHint: (keys, description) => `${keys} ${description}`,
    keyHint: (keybinding, description) => `${keyLabel(manager, keybinding)} ${description}`,
  };
}

function keyLabel(manager: SidebarMenuKeybindingsManager, keybinding: string): string {
  try {
    const keys = manager.getKeys?.(keybinding) ?? [];
    if (keys.length > 0) return keys.join("/");
  } catch {
    // A failing manager falls back to the action name.
  }
  return keybinding;
}

/** Compose the structural settings UI over the sidebar's primitives. */
export function createSidebarReviewSettingsUi(ports: SidebarReviewSettingsUiPorts): UiContext {
  const ui: UiContext = {
    mode: "tui",
    menuTuiHost: ports.menuTuiHost,
    custom: (factory) => ports.custom(factory),
    editText: (request) => ports.editText(request),
    notify: (message, type) => ports.notify(message, type),
    ...(ports.sectionHelp !== undefined ? { settingsSectionHelp: ports.sectionHelp } : {}),
    ...(ports.draftStatus !== undefined ? { settingsDraftStatus: ports.draftStatus } : {}),
    select: (title, options) => listScreen(ui, ports.menuTuiHost, {
      title,
      rows: options.map((option) => ({ value: option, label: option })),
    }),
    confirm: (title, message) => confirmScreen(ui, ports.menuTuiHost, title, message),
    // The pane has ONE notice slot, so a warning emitted before a confirmation
    // would be displaced by the confirmation's own disclosure: the explicit
    // port makes both canonical texts that one disclosure, warning first.
    settingsWarningConfirm: {
      confirm: (title, warning, message) => confirmScreen(ui, ports.menuTuiHost, title, `${warning} ${message}`),
    },
  };
  return ui;
}

/** One confirmation: Yes only for an explicit Yes choice; a cancel or a closed pane is No. */
async function confirmScreen(ui: UiContext, host: MenuTuiHost, title: string, message: string): Promise<boolean> {
  return await listScreen(ui, host, {
    title,
    message,
    rows: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
    initialValue: "no",
  }) === "yes";
}

/**
 * The left-bar leave confirmation of the sidebar's Review settings pane (#723):
 * the same shared confirmation screen (defaults to No; Escape, a cancel, or a
 * closed pane is No) on the pane's own `custom` host, so the pane's
 * written-frame, disclosure, and held-input fences apply unchanged. Nothing is
 * saved on either answer; `true` only permits the caller to discard after it
 * re-proves its own target.
 */
export function confirmReviewSettingsLeave(ui: UiContext): Promise<boolean> {
  const host = ui.menuTuiHost;
  if (host === undefined) return Promise.resolve(false);
  return confirmScreen(
    ui,
    host,
    "Discard unsaved Review settings?",
    "Unsaved Review settings changes will be discarded. Nothing is saved, and the clicked row opens instead.",
  );
}

interface ListScreenInput {
  readonly title: string;
  readonly message?: string;
  readonly rows: readonly MenuSelectItem[];
  readonly initialValue?: string;
}

/** One plain list screen (host selector or confirmation) on the sidebar's custom host. */
function listScreen(ui: UiContext, host: MenuTuiHost, input: ListScreenInput): Promise<string | undefined> {
  const custom = ui.custom;
  if (typeof custom !== "function") return Promise.resolve(undefined);
  return custom((tui, theme, keybindings, done) => {
    const confirmMatch = resolveMenuActionMatcher(keybindings, "tui.select.confirm");
    const cancelMatch = resolveMenuActionMatcher(keybindings, "tui.select.cancel");
    const container = new host.Container();
    // Every part except the list: the pane's bounded render measures them (#653).
    const chrome: unknown[] = [];
    const add = (part: unknown, isChrome = true): void => {
      container.addChild(part);
      if (isChrome) chrome.push(part);
    };
    add(new host.Text(menuRenderTheme.titleText(theme, input.title), 1, 0));
    // The message is not drawn here: it is the pane's single notice (#653).
    const disclosure = input.message !== undefined && input.message.length > 0 ? input.message : undefined;
    const items = [...input.rows];
    const viewport = createMenuListViewport({
      host,
      theme: menuRenderTheme.selectListTheme(host, theme),
      items,
      nativeLimit: (count) => Math.min(Math.max(count, 1), MENU_NATIVE_MAX_VISIBLE),
    });
    if (input.initialValue !== undefined) {
      const index = items.findIndex((item) => item.value === input.initialValue);
      if (index >= 0) viewport.list.setSelectedIndex(index);
    }
    let closed = false;
    const close = (value: string | undefined): void => {
      if (closed) return;
      closed = true;
      done(value);
    };
    viewport.list.onSelect = (item) => close(item.value);
    viewport.list.onCancel = () => close(undefined);
    add(viewport.component, false);
    // ONLY the parts stacked above the list place its first drawn row; the hint
    // line added after it must not count. The pointer bounds are read from this
    // snapshot, never assumed (#723).
    const aboveList = [...chrome];
    const listPointer = createMenuListPointer(viewport);
    add(new host.Text(`${host.rawKeyHint?.("↑↓", "navigate") ?? "↑↓ navigate"} · ${host.keyHint?.("tui.select.confirm", "select") ?? "enter select"} · ${host.keyHint?.("tui.select.cancel", "cancel") ?? "esc cancel"}`, 1, 0));
    return {
      ...(disclosure !== undefined ? { disclosure } : {}),
      // The sidebar pane passes the rows it measured for this screen (#653).
      render: (width: number, maxRows?: number): readonly string[] => {
        fitMenuListViewport(viewport, width, maxRows, chrome);
        let aboveRows = 0;
        for (const part of aboveList) aboveRows += menuPartRows(part, width).length;
        listPointer.track(width, aboveRows);
        return container.render(width);
      },
      invalidate: (): void => container.invalidate(),
      /**
       * Where THIS screen's rows actually landed in its last render, in the
       * screen's own coordinates (#723). The session-host sidebar owns the
       * whole gesture here, so it uses these to confirm a press is on a drawn
       * row before it holds the button.
       */
      listMouseRegion: (): NativeTextFieldRegion | undefined => listPointer.region(),
      /**
       * Pointer events over the drawn rows reach the pinned native list
       * unchanged in type (#723): a left press highlights, a completed left
       * click activates once through the same `onSelect` path as Enter, one
       * wheel report steps one clamped row, and hover, motion, a bare release,
       * or a non-primary button consume nothing. Nothing is forwarded once the
       * screen answered.
       */
      handleMouse: (event: TextFieldMouseEvent): TextFieldMouseResult | undefined => {
        if (closed) return undefined;
        const result = listPointer.route(event);
        // The native list reports whether ITS view changed; a clamped wheel
        // report answers `render: false`, and re-rendering for a report that
        // changed nothing would move the pane's written-frame receipt for no
        // visible reason (#723).
        if (result !== undefined && result.render !== false) tui.requestRender?.();
        return result;
      },
      handleInput: (data: string): void => {
        if (closed) return;
        // Any key is unrelated to a row press the pointer still holds (#723).
        listPointer.cancelPress();
        // The transaction's shared held-action fence: a held key that already
        // acted in a parent screen cannot answer this one.
        if (consumeMenuActionFence(ui.saveControl, data)) return;
        if (isKeyRelease(data)) return;
        if (isKeyRepeat(data) && (confirmMatch(data) || cancelMatch(data))) return;
        // The pane forwards Cancel without requiring a written disclosure and
        // treats a key bound to both as Cancel; SelectList would check Confirm
        // first, so a disclosure screen settles that key as Cancel (No) here —
        // before the save chord, which may itself be the configured Cancel.
        if (disclosure !== undefined && cancelMatch(data)) {
          claimMenuAction(ui.saveControl, cancelMatch);
          close(undefined);
          return;
        }
        // A list screen never saves: Ctrl+S is inert unless it answered No above.
        if (host.matchesCtrlS?.(data) === true) return;
        if (confirmMatch(data)) claimMenuAction(ui.saveControl, confirmMatch);
        else if (cancelMatch(data)) claimMenuAction(ui.saveControl, cancelMatch);
        viewport.list.handleInput(data);
        tui.requestRender?.();
      },
    };
  });
}

// ---------------------------------------------------------------------------
// The requester-side target loop (#716)
// ---------------------------------------------------------------------------

/**
 * One stable remote review-settings target. Both identity fields are routing
 * authority; `label` is presentation only, so two targets that display the
 * same label are still two distinct rows and a pick can never alias the other
 * route. No roster row id participates: the caller qualifies every target
 * itself (that is what {@link TargetedReviewSettingsInput.openRemote} is for).
 */
export interface ReviewSettingsRemoteTarget {
  /** The owning host's stable id. */
  readonly hostId: string;
  /** The exact owner run this target was observed in. */
  readonly hostRunId: string;
  /** Display label only; the picker keys rows by identity, not by this text. */
  readonly label: string;
}

/** The shared transaction's target switch (`PersistedReviewSettingsInput.targetControl`). */
export type ReviewSettingsTargetControl = NonNullable<PersistedReviewSettingsInput["targetControl"]>;

/** One target's editor open, over the pane's own UI. */
export interface TargetedReviewSettingsOpen {
  /** The pane's UI (the one `SidebarReviewSettingsHost.open` received). */
  readonly ui: UiContext;
  /** This open's target switch; passing it to the shared transaction is the caller's job. */
  readonly targetControl: ReviewSettingsTargetControl;
  /** The pane's lifetime; an aborted signal means this open must not act. */
  readonly signal: AbortSignal;
}

/**
 * Opens ONE target's shared persisted editor. Resolves `true` only when that
 * editor ended through the supplied `targetControl` (the shared `switched`
 * outcome: the old draft ended without a Save, and the loop may open the newly
 * chosen target). Any other end — Save, Cancel, Escape, failure — resolves
 * `false` and ends the loop.
 */
export type TargetedReviewSettingsOpener = (open: TargetedReviewSettingsOpen) => Promise<boolean>;

/** The requester-side target loop over the shared persisted editor (#716). */
export interface TargetedReviewSettingsInput {
  /** The sidebar pane's UI; the picker and every confirmation draw on its own `custom` host. */
  readonly ui: UiContext;
  /** The pane's lifetime (see `SidebarReviewSettingsHost.open`). */
  readonly signal: AbortSignal;
  /**
   * The current eligible, connected remote targets, in display order. Read
   * fresh for every decision: a target this callback no longer lists can never
   * be switched to, whatever its label said when the picker was drawn.
   */
  readonly remoteTargets: () => readonly ReviewSettingsRemoteTarget[];
  /** Open this host's LOCAL editor. */
  readonly openLocal: TargetedReviewSettingsOpener;
  /**
   * Resolve the caller-qualified opener for one exact current target, or
   * `undefined` when the caller cannot prove that route now. A route without an
   * opener is not offered, and an accepted route is re-resolved immediately
   * before the switch is reported.
   */
  readonly openRemote: (target: ReviewSettingsRemoteTarget) => TargetedReviewSettingsOpener | undefined;
}

/** The LOCAL target's display label in the root row and the picker. */
const LOCAL_TARGET_LABEL = "Local";
/** The LOCAL route's stable picker key (never derived from its label). */
const LOCAL_TARGET_KEY = JSON.stringify(["local"]);

/** One stable remote route: identity only, never the display label. */
interface RemoteRoute {
  readonly kind: "remote";
  readonly hostId: string;
  readonly hostRunId: string;
}

type TargetedRoute = { readonly kind: "local" } | RemoteRoute;

/** One current route, with the label it is displayed under and its opener. */
interface TargetedChoice {
  readonly route: TargetedRoute;
  readonly label: string;
  readonly opener: TargetedReviewSettingsOpener;
}

/**
 * The requester-side outer loop of the shared persisted Review editor (the
 * remote Review editor's UI half, issue #716).
 *
 * It opens LOCAL first, exactly like the LOCAL-only editor, and every further
 * open happens only because the shared editor reported a `switched` end:
 *
 * - The root menu's ONE `Host: <label>` row asks `requestSwitch`, which shows
 *   the host picker on this pane's own `custom` viewport: LOCAL plus the remote
 *   targets the caller currently lists AND can qualify. Rows are keyed by
 *   `hostId`/`hostRunId`; duplicate labels are separate rows, and the label is
 *   never consulted to resolve a choice.
 * - Choosing the target already open, cancelling the picker, declining the
 *   dirty confirmation, or losing the chosen route to a fresher roster read
 *   all resolve `false`, so the SAME draft re-shows untouched (#716 leaves that
 *   to the shared menu).
 * - A clean draft switches with no confirmation. A dirty one asks first, and
 *   the confirmation says explicitly that the unsaved draft on the current host
 *   is discarded; declining keeps the draft. Nothing is saved on either path.
 * - Acceptance itself is atomic with its last proof: `requestSwitch` awaits the
 *   picker and any confirmation, then re-proves the exact route by identity
 *   (and re-qualifies it with the caller) and re-checks the pane lifetime in
 *   that same continuation before returning `true`. A roster that changed while
 *   those screens were open therefore resolves `false`, and the SAME draft
 *   stays open and staged.
 * - A reported switch is trusted only together with that accepted route and a
 *   live signal, and the route is re-proved ONE more time at the handoff: the
 *   outgoing editor may still have been settling while that host disconnected
 *   or restarted, so only a route that is current right now (same
 *   `hostId`/`hostRunId`, freshly qualified opener) may be opened next. A route
 *   that is gone ends the loop instead — never a substitute.
 * - The next target's opener runs over fresh state — including LOCAL, which
 *   simply opens again.
 *
 * The pane's `signal` gates every step: an aborted pane never opens another
 * target and a late picker or confirmation result is dropped. The picker and
 * confirmation are ordinary sidebar screens, so the pane's written-frame and
 * held-input fences apply unchanged; this loop never latches, saves, or
 * fabricates a draft. An opener rejection propagates unchanged (the caller
 * surfaces it), and `true` without an accepted choice ends the loop rather than
 * start an opener nobody chose.
 */
export async function runTargetedReviewSettings(input: TargetedReviewSettingsInput): Promise<void> {
  let current: TargetedChoice = { route: { kind: "local" }, label: LOCAL_TARGET_LABEL, opener: input.openLocal };
  while (!input.signal.aborted) {
    let accepted: TargetedRoute | undefined;
    const targetControl: ReviewSettingsTargetControl = {
      label: current.label,
      // The shared menu runs this with Ctrl+S suspended; every screen below is
      // the pane's own. `false` re-shows the same draft with its staged edits.
      requestSwitch: async (hasUnsavedChanges: boolean): Promise<boolean> => {
        const route = await chooseTarget(input, current, hasUnsavedChanges === true);
        // The last proof and the acceptance are the SAME continuation: a roster
        // update that lands while the picker or confirmation was open (or while
        // this result is being resumed) can never accept a dead route and
        // discard a dirty draft for it.
        if (route === undefined || input.signal.aborted) return false;
        if (requalify(input, route) === undefined || input.signal.aborted) return false;
        accepted = route;
        return true;
      },
    };
    const switched = await current.opener({ ui: input.ui, targetControl, signal: input.signal });
    // A switch needs both facts: the editor really ended through this control,
    // and this loop really accepted a route (then the pane is still live).
    if (switched !== true || accepted === undefined || input.signal.aborted) return;
    // Re-prove the accepted route at the handoff. The outgoing editor may have
    // been settling while the chosen host disconnected or restarted, so the
    // earlier qualification is not enough: only a route that is current NOW
    // (same host id and owner run, freshly qualified opener) is opened, and a
    // route that is gone ends the loop without a substitute.
    const next = requalify(input, accepted);
    if (next === undefined) return;
    current = next;
  }
}

/** Pick and confirm one target route; undefined means "keep the draft". */
async function chooseTarget(
  input: TargetedReviewSettingsInput,
  current: TargetedChoice,
  hasUnsavedChanges: boolean,
): Promise<TargetedRoute | undefined> {
  if (input.signal.aborted) return undefined;
  const host = input.ui.menuTuiHost;
  // No in-pane host means no picker: nothing is offered and nothing switches.
  if (host === undefined) return undefined;
  const choices = currentChoices(input);
  if (choices.length === 0) return undefined;
  const pickedKey = await listScreen(input.ui, host, {
    title: "Review settings: host",
    rows: choices.map((choice) => ({ value: pickerKey(choice.route), label: choice.label })),
    initialValue: pickerKey(current.route),
  });
  // Cancel (Escape, or a pane that closed the screen) keeps the draft.
  if (pickedKey === undefined || input.signal.aborted) return undefined;
  const picked = choices.find((choice) => pickerKey(choice.route) === pickedKey);
  if (picked === undefined) return undefined;
  // The same target is a no-op, even when its label changed meanwhile.
  if (sameRoute(picked.route, current.route)) return undefined;
  if (hasUnsavedChanges) {
    const confirmed = await confirmScreen(
      input.ui,
      host,
      "Switch review settings host",
      `Unsaved changes to ${current.label} will be discarded. Nothing is saved, and ${picked.label} opens instead.`,
    );
    if (!confirmed || input.signal.aborted) return undefined;
  }
  // The caller's `requestSwitch` re-proves this exact route (and this pane's
  // lifetime) in its own continuation immediately before accepting it.
  return picked.route;
}

/** LOCAL plus every currently listed remote route the caller can qualify. */
function currentChoices(input: TargetedReviewSettingsInput): TargetedChoice[] {
  const choices: TargetedChoice[] = [
    { route: { kind: "local" }, label: LOCAL_TARGET_LABEL, opener: input.openLocal },
  ];
  for (const target of listedTargets(input.remoteTargets)) {
    const opener = input.openRemote(target);
    // An unqualifiable route is not offered; the label never substitutes for it.
    if (typeof opener !== "function") continue;
    choices.push({
      route: { kind: "remote", hostId: target.hostId, hostRunId: target.hostRunId },
      label: target.label,
      opener,
    });
  }
  return choices;
}

/**
 * The exact route as it is right now: a remote target must still be listed with
 * the same identity and still resolve an opener. `undefined` means the choice
 * is stale and nothing switches.
 */
function requalify(input: TargetedReviewSettingsInput, route: TargetedRoute): TargetedChoice | undefined {
  if (route.kind === "local") {
    return typeof input.openLocal === "function"
      ? { route, label: LOCAL_TARGET_LABEL, opener: input.openLocal }
      : undefined;
  }
  const target = listedTargets(input.remoteTargets).find(
    (candidate) => candidate.hostId === route.hostId && candidate.hostRunId === route.hostRunId,
  );
  if (target === undefined) return undefined;
  const opener = input.openRemote(target);
  if (typeof opener !== "function") return undefined;
  return {
    route: { kind: "remote", hostId: target.hostId, hostRunId: target.hostRunId },
    label: target.label,
    opener,
  };
}

/**
 * The caller's current eligible targets, validated and de-duplicated by exact
 * identity. An entry without both identity strings or a display label is not
 * offered (no label is invented for it), and a repeated identity is one route.
 */
function listedTargets(read: () => readonly ReviewSettingsRemoteTarget[]): ReviewSettingsRemoteTarget[] {
  const listed: unknown = read();
  if (!Array.isArray(listed)) return [];
  const seen = new Set<string>();
  const targets: ReviewSettingsRemoteTarget[] = [];
  for (const entry of listed as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const hostId = typeof record.hostId === "string" ? record.hostId : "";
    const hostRunId = typeof record.hostRunId === "string" ? record.hostRunId : "";
    const label = typeof record.label === "string" ? record.label : "";
    if (hostId.length === 0 || hostRunId.length === 0 || label.trim().length === 0) continue;
    const key = pickerKey({ kind: "remote", hostId, hostRunId });
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ hostId, hostRunId, label });
  }
  return targets;
}

/** The stable picker key of one route: JSON identity, never a label or a row id. */
function pickerKey(route: TargetedRoute): string {
  return route.kind === "local" ? LOCAL_TARGET_KEY : JSON.stringify(["remote", route.hostId, route.hostRunId]);
}

/** Route identity, which is all a same-target no-op may compare. */
function sameRoute(left: TargetedRoute, right: TargetedRoute): boolean {
  if (left.kind === "local" || right.kind === "local") return left.kind === right.kind;
  return left.hostId === right.hostId && left.hostRunId === right.hostRunId;
}
