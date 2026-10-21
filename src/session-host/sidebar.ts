/**
 * Pure keyboard sidebar controller and bounded roster/form renderer for the
 * optional custom session host terminal sidebar (#323).
 *
 * Each sidebar row is an independent native process; the main UI is its
 * nativePTY frame, so this module renders ONLY the sidebar-owned panes: the
 * roster snapshot (top-level public agent/input/activity metadata), the
 * New/Edit forms, and the deliberate saved-conversation picker. It returns
 * plain, bounded lines at the supplied pane
 * geometry — `render()` for the focused pane, `renderRoster()`/`renderForm()`
 * for the wide layout that shows both at once. The compositor owns offsets,
 * composition over the native frame, the real TTY, and resizing.
 *
 * Hard boundaries of this module (pure frontend):
 *
 * - No process, PTY, network, filesystem, config, Git, or model work. All
 *   lifecycle/roster truth arrives as `SidebarItem` DTOs from the backend;
 *   launch/workspace validation stays in the backend. No host module is
 *   imported — in particular no TerminalSurface.
 * - UI actions never stop an instance directly: hiding the sidebar,
 *   confirming an item, abandoning a form, or asking to remove or stop a
 *   row only emits visibility/select/create/quit/remove/stop-remove action
 *   DTOs; the backend decides what they mean and performs any process stop.
 *   The sidebar itself never signals a process or deletes persistent files.
 * - Escape in MAIN focus is never intercepted (it stays native input, e.g.
 *   native menu cancellation); while MAIN is focused every chunk — including
 *   `q`/Ctrl+C and terminal-native bytes like bracketed pastes and Kitty key
 *   releases — is forwarded unchanged except the reserved, configurable
 *   toggle chord (legacy and Kitty packets both honored via the real
 *   matchesKey). The reserved chord is two-step: hidden -> show and focus
 *   the sidebar; visible with MAIN focus -> focus the sidebar without a
 *   visibility (resize) action; sidebar-owned focus -> hide and return to
 *   main. Only initial presses act; repeats/releases are consumed.
 * - Each native session renders as a fixed-height card: 5 rows expanded
 *   (default) or 3 collapsed, toggled per card with Space and persisted by
 *   id. Row 1 is ONLY the sanitized canonical title; status (selection
 *   marker, observed/unknown agent/input state), honest background counts
 *   (unknown is never shown as zero), and generic activity follow below.
 *   Scrolling keeps the complete highlighted card visible or falls back to
 *   the too-small pane, and selection-targeted keys (Enter, edit,
 *   stop/remove) act only on an entry the last roster render completely
 *   drew at its current height and order; hiding or overlaying the roster
 *   forgets it.
 * - `d` and Delete stop/remove the highlighted session row: an exited row
 *   removes immediately; a settled
 *   error row without a live process requests the same deliberate removal
 *   (the manager stays authoritative and may still refuse); a live owned
 *   process stops only after explicit confirmation unless complete idleness
 *   is positively observed (unknown is never idle); a row with no owned
 *   process and no confirmed exit is refused with a bounded notice.
 *   The stop confirmation freezes the target id and never retargets a later
 *   highlighted row; the quit host confirmation stays separate.
 * - `n` displays no session: it detaches only this sidebar's own content/input
 *   view (issue 474). Every session keeps running, the roster and its entries,
 *   saved conversations, and the host itself are untouched, and a later Enter on
 *   a row displays that session again; only the remembered active entry is
 *   dropped, so a later roster restore cannot silently re-adopt a session the
 *   operator deliberately stopped displaying. It is never Close, Quit, a removal,
 *   or a stop, and while detached the local surface contributes no size to any
 *   session.
 * - Roster/form/error text is sanitized (C0/C1/DEL and ANSI/OSC/APC
 *   sequences stripped) and bounded before it can appear in a rendered line.
 *   Generated hint text wraps across reserved footer rows instead of being
 *   ellipsized; geometry that cannot show the hints plus a usable pane falls
 *   back to a truthful too-small message.
 *   Only fixed generated SGR (bold 1, inverse 7/27, explicit 0 resets at row
 *   boundaries) is ever emitted; untrusted ESC/OSC-52/title/window commands
 *   can never reach the composed frame. Real pi-tui key matching
 *   (legacy, modifyOtherKeys, and Kitty CSI-u packets) plus the native Editor
 *   adapter provide field editing, grapheme-safe caret movement, and bounded
 *   single-line input.
 * - Editable fields use the native Editor adapter; roster and surrounding form
 *   labels remain plain text + generated SGR.
 *
 * Network sidebar (issue #482, pure frontend): every peer fact arrives as a
 * `PeerUiSnapshot` DTO from the parent-owned coordinator. This module performs
 * no network/process/filesystem/trust work; it only renders attached metadata
 * and emits `PeerUiCommand` DTOs for the coordinator to perform. The network
 * menu, incoming-consent alert, and remote roster rows appear ONLY while a
 * peer snapshot is attached, so isolated legacy `Sidebar` callers never grow
 * unsolicited entries. Attaching or updating a snapshot never changes
 * visibility, focus, the highlighted entry, or the observed active Main owner,
 * and an incoming request never opens a pane by itself.
 *
 * Incoming consent is the one deliberately fenced confirmation: the dialog
 * latches its immutable identity (opaque consent id, kind, label, key
 * fingerprint, endpoint), never retargets a newer request in place, and only
 * authorizes a decision after Main reports the ACTUAL writer receipt for the
 * exact current frame through `settlePeerConsentRender`. A render, capture,
 * too-small frame, superseded frame, or snapshot arrival alone never enables
 * Approve or Deny; changing the selected decision or the pane geometry
 * invalidates that proof until the new exact frame is written.
 *
 * Remote roster rows are separate typed pane entries, never fabricated
 * `SidebarItem`s: no invented agent dir, busy flag, input surface, or exit
 * code. Their workspace path is exact display-only owner data (sanitized, never
 * resolved or otherwise used), and activating one only shows a local
 * metadata-only notice — no local select/resume/create/stop/remove/rename
 * action is emitted and the native content owner is unchanged.
 *
 * `renderPeerAlert` is the one extra notification surface, for a host-owned
 * alert band that the compositor places when the normal sidebar cannot show a
 * pending request (hidden pane, or narrow layout while Main has focus). It is
 * bounded, never renders confirmation controls, mints no consent frame token,
 * and changes no focus or ownership; the settled consent-frame API above is
 * unchanged.
 *
 * Stable DTO/API surface for future root-host phases: `SidebarItem`,
 * `SidebarAction`, `SidebarControllerOptions`, and `SidebarController` with
 * the getters/setters documented below. Internal shapes may evolve.
 */

import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  getKeybindings,
  isKeyRelease,
  isKeyRepeat,
  Input,
  type KeyId,
  matchesKey,
  parseKey,
  truncateToWidth,
  visibleWidth,
} from "pi-session-host-tui";
import { resolve } from "node:path";
import {
	createSessionHostTextField,
	type SessionHostFieldRejection,
	type SessionHostFieldSubmission,
	type SessionHostTextField,
} from "./field-editor";
import { isValidNativeSessionId, isValidRenameName, type SessionHostNativeSession } from "./protocol";
import {
  asHostKeyId,
  assertHostShortcutsDistinct,
  DEFAULT_HOST_SHORTCUTS,
  normalizeHostShortcutBindings,
  normalizeHostShortcutKey,
  type HostShortcutBindings,
} from "./host-shortcuts";
import {
  terminalDiagnosticsFailurePhrase,
  type TerminalDiagnosticsWarningView,
} from "./terminal-diagnostics";
import type {
  PeerConsentPresentation,
  PeerUiAction,
  PeerUiConsent,
  PeerUiHost,
  PeerUiSettings,
  PeerUiSnapshot,
  PeerUiTrustedPeer,
} from "./peer-ui-protocol";

/** One roster row: a top-level snapshot of one host-owned instance. */
export interface SidebarItem {
  readonly id: string;
  readonly label: string;
  readonly workspace: string;
  readonly agentDir: string;
  readonly lifecycle: "starting" | "alive" | "exited" | "error";
  /** True only while the host still owns the instance's native process handle. */
  readonly hasLiveProcess?: boolean;
  /**
   * True only for a remembered conversation that owns no process and cannot be
   * restarted (its row is a bounded placeholder, not a session). Such an entry
   * is never activatable: Enter must not change focus or input ownership.
   */
  readonly unavailable?: boolean;
  /** true/false when observed; null means unknown (never rendered as false). */
  readonly busy: boolean | null;
  readonly pendingInput: boolean | null;
  readonly inputSurface: boolean;
  /** Generic top-level activity lines; at most 2 are rendered, sanitized. */
  readonly activity: readonly string[];
	/** Last validated canonical native conversation identity and display name. */
	readonly nativeSession?: SessionHostNativeSession | null;
  readonly exitCode?: number;
  /**
   * Observed OWNERSHIP count of unsettled background task work from
   * protocol/backend telemetry: active/queued logical work plus every retained
   * cleanup/recovery anchor. Only a nonnegative safe integer is accepted;
   * anything else (including absence) is stored and rendered as unknown, never
   * inferred as zero. This conservative channel gates stop/remove confirmation;
   * it is never used for the displayed activity number.
   */
  readonly backgroundTasks?: number | null;
  /** Observed ownership count of background shell jobs not yet confirmed settled. */
  readonly backgroundShells?: number | null;
  /**
   * Observed ACTIVITY-INTENT count of admitted/running background task work.
   * Same honesty rules as backgroundTasks: anything but a nonnegative safe
   * integer is unknown, never zero. This is the number the card displays and
   * the state behind the running/idle line; an absent value is unknown, never
   * a fallback to the ownership count.
   */
  readonly activeTasks?: number | null;
  /** Observed activity-intent count of starting/running background shells. */
  readonly activeShells?: number | null;
}

/**
 * One saved-conversation row for the deliberate picker (issue 323): identity
 * and canonical caption only. Never a transcript, tool argument, question
 * text, or credential — the read-only listing API guarantees that shape.
 */
export interface SidebarSavedRow {
  readonly id: string;
  readonly file: string;
  readonly caption: string;
  /**
   * The exact recorded workspace (cwd) for this saved conversation, when the
   * catalog supplied one. Display-only metadata: it never affects admission,
   * ordering, or the opaque id/file. Absent/empty means "unavailable".
   */
  readonly cwd?: string;
}

export type SidebarSavedPickerAction =
  | "tui.select.confirm"
  | "tui.select.cancel"
  | "tui.select.up"
  | "tui.select.down"
  | "app.session.delete"
  | "app.session.deleteNoninvasive";

/** A native pi-tui single-line Input and the shared native keybinding matcher. */
export interface SidebarSavedQueryInput {
  getValue(): string;
  handleInput(data: string): void;
  render(width: number): string[];
  matches(data: string, action: SidebarSavedPickerAction): boolean;
  keys?(action: SidebarSavedPickerAction): readonly string[];
  dispose(): void;
  readonly notice?: string;
}

/** Actions the sidebar asks the backend to perform. */
export type SidebarAction =
  | { readonly type: "forward"; readonly data: string }
  | { readonly type: "select"; readonly id: string }
  | { readonly type: "remove"; readonly id: string }
  | { readonly type: "resume-row"; readonly requestId: number; readonly id: string }
  | { readonly type: "resume-row-cancel"; readonly requestId: number }
  /**
   * Stop an owned live session and remove its row. confirmed:false is a
   * known-idle request the parent revalidates with fresh idle state;
   * confirmed:true followed a deliberate confirmation of the frozen target.
   */
  | { readonly type: "stop-remove"; readonly id: string; readonly confirmed: boolean }
  /** Detach only this sidebar's own content/input view (#474); never a stop, removal, or Quit. */
  | { readonly type: "detach-view" }
  | { readonly type: "edit"; readonly id: string; readonly nativeSession: SessionHostNativeSession }
  /** Open the saved-conversation picker and list the shared native catalog. */
  | { readonly type: "saved-list"; readonly requestId: number }
  /** Re-list after a successful saved-file deletion without losing the query. */
  | { readonly type: "saved-refresh"; readonly requestId: number; readonly pickerId: number }
  /** Query changes are resolved only from Main's current branded catalog. */
  | { readonly type: "saved-search"; readonly pickerId: number; readonly revision: number; readonly query: string }
  /** Drop Main's private catalog/search references when this pane is dismissed. */
  | { readonly type: "saved-dismiss"; readonly pickerId: number }
  /** Synchronous Main-side eligibility check before opening a confirmation. */
  | { readonly type: "saved-delete-prepare"; readonly pickerId: number; readonly requestId: number; readonly id: string; readonly file: string; readonly revision: number }
  /** Confirmed deletion of the frozen, prevalidated target. */
  | { readonly type: "saved-delete"; readonly pickerId: number; readonly requestId: number; readonly id: string; readonly file: string; readonly revision: number }
  /** Cancel an outstanding listing (dismiss or shutdown); Main aborts its signal. */
  | { readonly type: "saved-cancel"; readonly requestId: number }
  /** Deliberately open one listed conversation as a new independently owned child. */
  | { readonly type: "saved-open"; readonly requestId: number; readonly file: string; readonly sessionId: string }
  | {
      readonly type: "create";
      readonly requestId: number;
      readonly workspace: string;
    }
  | {
      readonly type: "rename";
      readonly requestId: number;
      readonly id: string;
      readonly expectedSessionId: string;
      readonly expectedSessionEpoch: number;
      readonly name: string;
    }
  | { readonly type: "quit" }
  /**
   * Clear the host-owned terminal diagnostics warning the user actually saw
   * (#428): warning events up to `throughCount`, and a persistence failure only
   * when it was displayed. Never deletes, rotates, or resets the log.
   */
  | { readonly type: "terminal-diagnostics-clear"; readonly throughCount: number; readonly failureShown: boolean }
  | {
      readonly type: "host-shortcuts-save";
      readonly requestId: number;
      readonly bindings: HostShortcutBindings;
    }
  | { readonly type: "visibility"; readonly visible: boolean }
  /**
   * Network sidebar actions are exactly the parent-owned `PeerUiAction` DTOs.
   * Consent decisions travel only as `peer-consent` with the written
   * `renderToken`; Main independently rechecks them, and this module never
   * performs the network or trust work itself.
   */
  | PeerUiAction;

export interface SidebarControllerOptions {
  /** Canonical native KeyId or a bounded known alternative (e.g. "f8"). */
  readonly toggleKey?: string;
  /** Effective roster-only return chord (defaults to Alt+Right). */
  readonly returnToMainKey?: string;
  /** Stored editor values; distinct from an active legacy toggle override. */
  readonly configuredShortcuts?: HostShortcutBindings;
  readonly legacyToggleOverride?: boolean;
  /** Main disables persistence UI only when no canonical native agent dir exists. */
  readonly settingsAvailable?: boolean;
  /** Suggested editable workspace path pre-filled in the New session form. */
  readonly initialWorkspace?: string;
  /** Host-startup cwd used by the native path completer for relative input. */
  readonly workspaceBasePath?: string;
  /** Optional Main-owned factory; production supplies current native keybindings and external-editor ownership. */
  readonly createTextField?: (options: SidebarFieldFactoryOptions) => SidebarFieldFactoryResult;
  /** Main supplies native global keybindings and owns the safe Input manager bridge. */
  readonly createSavedQueryInput?: () => SidebarSavedQueryInput;
  /** Redraw hook for asynchronous native completion and Editor invalidation. */
  readonly onInvalidate?: () => void;
  /** Initial visibility (default true: the empty welcome picker shows). */
  readonly initialVisible?: boolean;
  /**
   * Injected clock used ONLY to display and fence the bounded human consent
   * approval window (defaults to the wall clock). Tests and Main may supply a
   * deterministic source; this module performs no IO.
   */
  readonly now?: () => number;
  readonly onAction?: (action: SidebarAction) => void;
}

export interface SidebarMousePresentation {
  /**
   * Stable signature of the captured maps' activation targets and
   * pane-relative positions, including the network pane's rows and the consent
   * dialog's decision/geometry targets.
   */
  readonly authorizationKey: string;
  /** Activates only entries captured by the exact sidebar render this token represents. */
  activateRosterAt(column: number, row: number, cols: number, rows: number): boolean;
  /** Activates only saved rows captured by the exact sidebar render this token represents. */
  activateSavedAt(column: number, row: number, cols: number, rows: number): boolean;
}

export interface SidebarFieldFactoryOptions {
  readonly kind: "name" | "path";
  readonly initialText: string;
  readonly onInvalidate: () => void;
  readonly onSubmit: (submission: SessionHostFieldSubmission) => void;
  readonly onCancel: () => void;
  readonly onReject: (reason: SessionHostFieldRejection) => void;
}

export interface SidebarFieldFactoryResult {
  readonly field: SessionHostTextField;
  readonly matchesCancel?: (data: string) => boolean;
  /**
   * Optional matcher for the field's effective submit key. The submission
   * provenance fence consumes the held submit key's repeat/release, so it must
   * follow the native field's configured binding (e.g. `tui.input.submit`),
   * not assume unmodified Enter.
   */
  readonly matchesSubmit?: (data: string) => boolean;
  readonly notice?: string;
  readonly hints?: {
    readonly submit: string;
    readonly cancel: string;
    readonly complete: string;
    readonly clear: string;
    readonly externalEditor: string;
  };
}

export type SidebarFocus = "main" | "sidebar" | "form" | "confirm";

/**
 * The complete set of generated SGR sequences this renderer may ever embed
 * in a returned line (always between explicit `\x1b[0m` row boundaries).
 */
export const SIDEBAR_GENERATED_SGR_ALLOWLIST: ReadonlySet<string> = new Set([
  "0",
  "1",
  "7",
  "27",
  "1;7",
  // Focus-domain title highlights: blue for the sidebar-selected navigation
  // target, white for the actual active Main conversation (native focus).
  "1;34",
  "1;97",
]);

/** Sidebar-selected navigation-target title highlight (blue). */
const SGR_SELECTION_BLUE = "\x1b[1;34m";
/** Actual active Main conversation title highlight (white). */
const SGR_ACTIVE_MAIN_WHITE = "\x1b[1;97m";

interface SidebarEntry {
  /** Internal key; real item ids are namespaced with "item:" to stay unique. */
  readonly key: string;
  readonly kind:
    | "item"
    | "saved"
    | "new"
    | "quit"
    | "settings"
    | "diagnostics"
    | "peer";
  readonly item?: SidebarItem;
  /** Warning snapshot rendered by a `diagnostics` entry (display and clear fence). */
  readonly warning?: TerminalDiagnosticsWarningView;
}

// updateItems rebuilds bounded DTO snapshots even when their content is
// unchanged; a skipped frame may keep the prior emitted map active. Compare
// the activation identity and safety state, not display/telemetry metadata.
function sameSidebarEntry(a: SidebarEntry, b: SidebarEntry): boolean {
  if (a.key !== b.key || a.kind !== b.kind) return false;
  if (a.item === undefined || b.item === undefined) return a.item === b.item;
  return a.item.id === b.item.id
    && a.item.lifecycle === b.item.lifecycle
    && (a.item.unavailable === true) === (b.item.unavailable === true)
    && a.item.hasLiveProcess === b.item.hasLiveProcess
    && (a.item.lifecycle !== "exited"
      || (a.item.nativeSession?.sessionId === b.item.nativeSession?.sessionId
        && a.item.nativeSession?.epoch === b.item.nativeSession?.epoch));
}

function sidebarActivationIdentity(entry: SidebarEntry): readonly unknown[] {
  const item = entry.item;
  return item === undefined
    ? [entry.key, entry.kind]
    : [entry.key, entry.kind, item.id, item.lifecycle, item.unavailable === true,
      item.hasLiveProcess, item.lifecycle === "exited"
        ? [item.nativeSession?.sessionId ?? null, item.nativeSession?.epoch ?? null]
        : null];
}

interface DisplayedRosterRegion {
  readonly row: number;
  readonly height: number;
  readonly entry: SidebarEntry;
}

interface DisplayedSavedRow {
  readonly paneRow: number;
  readonly index: number;
  readonly entry: SidebarSavedRow;
}

interface DisplayedSavedRows {
  readonly cols: number;
  readonly rows: number;
  readonly entries: readonly DisplayedSavedRow[];
}

interface SavedDeleteContext {
  readonly pickerId: number;
  readonly requestId: number;
  readonly id: string;
  readonly file: string;
  readonly revision: number;
  readonly row: SidebarSavedRow;
}

interface DisplayedRoster {
  readonly signature: string;
  readonly heights: ReadonlyMap<string, number>;
  readonly regions: ReadonlyMap<string, DisplayedRosterRegion>;
  readonly cols: number;
  readonly rows: number;
  readonly focus: SidebarFocus;
}

/** One remote roster row exactly as the coordinator projected it (display only). */
type PeerRosterRow = NonNullable<PeerUiHost["roster"]["rows"]>[number];

/** Selectable network-panel rows; remote rows are a separate typed kind. */
type PeerPaneRow =
  | {
      readonly kind:
        | "toggle-hosting"
        | "edit-bind-host"
        | "edit-bind-port"
        | "apply-hosting"
        | "toggle-auto"
        | "toggle-bell"
        | "add-host";
      readonly key: string;
    }
  | { readonly kind: "host"; readonly key: string; readonly host: PeerUiHost }
  | { readonly kind: "trusted"; readonly key: string; readonly peer: PeerUiTrustedPeer }
  | { readonly kind: "consent"; readonly key: string; readonly consent: PeerUiConsent }
  | {
      readonly kind: "remote";
      readonly key: string;
      readonly hostId: string;
      readonly hostLabel: string;
      readonly rosterState: "current" | "stale";
      readonly row: PeerRosterRow;
    };

interface DisplayedPeerRows {
  readonly cols: number;
  readonly rows: number;
  readonly signature: string;
  readonly selectedKey: string | undefined;
  readonly entries: readonly PeerPaneRow[];
}

/** Immutable, latched consent identity: snapshot reordering never retargets it. */
interface PeerConsentLatch {
  readonly id: string;
  readonly kind: "incoming" | "server-key";
  readonly label: string;
  readonly fingerprint: string;
  readonly endpoint: string | null;
  readonly requestedAt: number;
  readonly expiresAt: number;
}

/**
 * The exact candidate frame: latched identity + semantic decision + geometry +
 * the control positions/bytes actually emitted. `identity` names the semantic
 * target; `key` additionally covers the rendered lines so any content or
 * position change (for example a notice shifting Approve/Deny) mints a new
 * token instead of silently inheriting the previous written proof.
 */
interface DisplayedPeerConsent {
  readonly identity: string;
  readonly key: string;
  readonly token: number;
  readonly consentId: string;
  readonly choice: "approve" | "deny";
  readonly cols: number;
  readonly rows: number;
  readonly approveRow: number;
  readonly denyRow: number;
}

function peerPaneRowIdentity(row: PeerPaneRow): readonly unknown[] {
  switch (row.kind) {
    case "host":
      return [row.key, row.kind, row.host.id, row.host.state, row.host.roster.state,
        row.host.roster.rows === null ? null : row.host.roster.rows.length,
        row.host.reconnectSuppressed, row.host.previouslyConnected];
    case "trusted":
      return [row.key, row.kind, row.peer.id, row.peer.hasInboundGrant];
    case "consent":
      return [row.key, row.kind, row.consent.id, row.consent.kind, row.consent.expiresAt];
    case "remote":
      return [row.key, row.kind, row.hostId, row.rosterState, row.row.id, row.row.lifecycle,
        row.row.hasLiveProcess];
    default:
      return [row.key, row.kind];
  }
}

function mouseAuthorizationKey(
  roster: DisplayedRoster | undefined,
  saved: DisplayedSavedRows | undefined,
  peer: DisplayedPeerRows | undefined,
  consent: DisplayedPeerConsent | undefined,
  consentRendered: boolean,
): string {
  return JSON.stringify({
    roster: roster === undefined ? null : [roster.cols, roster.rows,
      [...roster.regions.values()].map((region) => [region.row, region.height, sidebarActivationIdentity(region.entry)])],
    saved: saved === undefined ? null : [saved.cols, saved.rows,
      saved.entries.map(({ paneRow, entry }) => [paneRow, entry.id, entry.file])],
    // Network-panel targets and the consent dialog's decision geometry are part
    // of the authorization identity: a presentation captured from a frame with
    // different peer/consent targets can never authorize the current one.
    peer: peer === undefined ? null : [peer.cols, peer.rows, peer.signature,
      peer.entries.map((row) => peerPaneRowIdentity(row))],
    consent: consent === undefined || !consentRendered ? null : [
      consent.token, consent.consentId, consent.choice, consent.cols, consent.rows,
      consent.approveRow, consent.denyRow,
    ],
  });
}

const DEFAULT_SAVED_ACTION_KEYS: Readonly<Record<SidebarSavedPickerAction, readonly string[]>> = {
  "tui.select.confirm": ["enter"],
  "tui.select.cancel": ["escape", "ctrl+c"],
  "tui.select.up": ["up"],
  "tui.select.down": ["down"],
  "app.session.delete": ["ctrl+d"],
  "app.session.deleteNoninvasive": ["ctrl+backspace"],
};

function defaultSavedActionMatch(data: string, action: SidebarSavedPickerAction): boolean {
  let manager: ReturnType<typeof getKeybindings> | undefined;
  try { manager = getKeybindings(); } catch { /* native defaults below */ }
  if (manager !== undefined) {
    try {
      const source = manager as unknown as { matches(data: string, action: string): boolean; getDefinition?: (id: string) => unknown };
      if (source.getDefinition?.(action) !== undefined) return source.matches(data, action);
    } catch { /* use a bounded default action chord */ }
  }
  return (DEFAULT_SAVED_ACTION_KEYS[action] ?? []).some((key) => matchesKey(data, key as KeyId));
}

function createDefaultSavedQueryInput(): SidebarSavedQueryInput {
  const input = new Input();
  input.focused = true;
  return {
    getValue: () => input.getValue(),
    handleInput: (data) => input.handleInput(data),
    render: (width) => input.render(width),
    matches: defaultSavedActionMatch,
    keys: (action) => {
      let manager: ReturnType<typeof getKeybindings> | undefined;
      try { manager = getKeybindings(); } catch { /* native defaults below */ }
      try {
        const getKeys = (manager as unknown as { getKeys?: (id: string) => string[] } | undefined)?.getKeys;
        const keys = getKeys?.call(manager, action);
        if (Array.isArray(keys) && keys.length > 0) return keys;
      } catch { /* use the built-in Pi defaults */ }
      return DEFAULT_SAVED_ACTION_KEYS[action] ?? [];
    },
    dispose: () => {
      input.focused = false;
      input.setValue("");
    },
  };
}

function sanitizeSavedRows(rows: readonly SidebarSavedRow[]): SidebarSavedRow[] {
  const accepted: SidebarSavedRow[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.id !== "string" || row.id.length === 0
      || typeof row.file !== "string" || row.file.length === 0
      || typeof row.caption !== "string") continue;
    accepted.push({
      id: row.id,
      file: row.file,
      caption: sanitizeBounded(row.caption, SAVED_CAPTION_MAX_CODEPOINTS),
      ...(typeof row.cwd === "string" && row.cwd.length > 0
        ? { cwd: sanitizeBounded(row.cwd, SAVED_WORKSPACE_MAX_CODEPOINTS) }
        : {}),
    });
  }
  return accepted;
}

// The pinned matcher knows legacy F1-F12 packets but not parameterized CSI
// forms. These tables cover only standard function-key codes with no key
// modifier (Caps/Num Lock bits are ignored, matching public matcher behavior).
const FUNCTION_KEY_BY_TILDE_CODE: Readonly<Record<string, string>> = {
  "11": "f1",
  "12": "f2",
  "13": "f3",
  "14": "f4",
  "15": "f5",
  "17": "f6",
  "18": "f7",
  "19": "f8",
  "20": "f9",
  "21": "f10",
  "23": "f11",
  "24": "f12",
};
const FUNCTION_KEY_BY_CSI_FINAL: Readonly<Record<string, string>> = {
  P: "f1",
  Q: "f2",
  R: "f3",
  S: "f4",
};
const FUNCTION_KEY_TILDE_EVENT = /^\x1b\[(\d+);(\d+)(?::([123]))?~$/;
const FUNCTION_KEY_LETTER_EVENT = /^\x1b\[1;(\d+)(?::([123]))?([PQRS])$/;
const PATH_FIELD_MAX_CODEPOINTS = 2048;
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const DEFAULT_FORM_HINTS = {
  submit: "enter",
  cancel: "esc",
  complete: "tab",
  clear: "ctrl+c",
  externalEditor: "ctrl+g",
};
/** Native-session card heights: title, status, background (+2 activity). */
const CARD_COLLAPSED_ROWS = 3;
const CARD_EXPANDED_ROWS = 5;
const ACTIVITY_LINES_MAX = CARD_EXPANDED_ROWS - CARD_COLLAPSED_ROWS;
const ACTIVITY_INPUT_MAX_CODEPOINTS = 400;
const SAVED_CAPTION_MAX_CODEPOINTS = 256;
const MAX_SAVED_QUERY_DISPLAY_CODEPOINTS = 4096;
/** Bounded recorded-workspace (cwd) display limit; the raw catalog keeps the full value for admission. */
const SAVED_WORKSPACE_MAX_CODEPOINTS = 4096;
/** Fixed reserved details-area height between the saved list and the footer. */
const SAVED_DETAILS_ROWS = 3;
const ITEM_LABEL_INPUT_MAX_CODEPOINTS = 400;
const ERROR_TEXT_MAX_CODEPOINTS = 300;
const ROSTER_MIN_COLS = 12;
const ROSTER_MIN_ROWS = 4;
const FORM_MIN_COLS = 24;
const FORM_MIN_ROWS = 6;
const PANE_MAX_COLS = 1000;
const PANE_MAX_ROWS = 1000;

const ENTRY_NEW_KEY = "new";
const ENTRY_QUIT_KEY = "quit";
const ENTRY_SAVED_KEY = "saved";
const ENTRY_SETTINGS_KEY = "host-shortcuts";
const ENTRY_DIAGNOSTICS_KEY = "terminal-diagnostics";
/** Network menu key; present only with an attached snapshot. */
const ENTRY_PEER_KEY = "peer-network";
/** Fixed height of the host-owned terminal diagnostics warning entry. */
const DIAGNOSTICS_ENTRY_ROWS = 3;
/**
 * Fixed height of the prominent incoming-consent band: heading, name, key
 * fingerprint, origin endpoint, remaining human window, and the review hint.
 * The band is reserved OUTSIDE the scrolling roster so it stays visible while
 * later rows are selected; it never collapses into a tiny indicator.
 */
const PEER_CONSENT_ALERT_ROWS = 6;
/** Bounded display copies of coordinator DTO lists (render is bounded anyway). */
const PEER_MAX_HOSTS = 32;
const PEER_MAX_TRUSTED_PEERS = 32;
const PEER_MAX_CONSENTS = 8;
const PEER_MAX_ROSTER_ROWS = 64;
const PEER_LABEL_MAX_CODEPOINTS = 256;
const PEER_ADDRESS_MAX_CODEPOINTS = 256;
const PEER_FINGERPRINT_MAX_CODEPOINTS = 256;
const PEER_ENDPOINT_MAX_CODEPOINTS = 512;
/** Explicit listen-port text admitted locally; the coordinator revalidates. */
const PEER_PORT_MIN = 1;
const PEER_PORT_MAX = 65535;
const DIAGNOSTICS_CLEARED_NOTICE = "Terminal warning cleared; the diagnostics log was kept";
const ITEM_KEY_PREFIX = "item:";

const LIFECYCLE_VALUES: ReadonlySet<string> = new Set([
  "starting",
  "alive",
  "exited",
  "error",
]);

/**
 * Removes complete terminal control sequences and all remaining C0/C1/DEL
 * controls. Incomplete sequences fail closed by discarding their remainder.
 */
function sanitizeCellText(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  let out = "";
  let index = 0;
  while (index < raw.length) {
    const code = raw.charCodeAt(index);
    const next = raw[index + 1];
    // 7-bit ESC introducers: CSI and terminal string commands.
    if (code === 0x1b) {
      if (next === "[") {
        let end = index + 2;
        while (end < raw.length) {
          const final = raw.charCodeAt(end);
          end += 1;
          if (final >= 0x40 && final <= 0x7e) {
            break;
          }
        }
        index = end;
        continue;
      }
      if (next === "]" || next === "P" || next === "_" || next === "^" || next === "X") {
        let end = index + 2;
        let terminated = false;
        while (end < raw.length) {
          const current = raw.charCodeAt(end);
          if (current === 0x07 || current === 0x9c) {
            end += 1;
            terminated = true;
            break;
          }
          if (current === 0x1b && raw.charCodeAt(end + 1) === 0x5c) {
            end += 2;
            terminated = true;
            break;
          }
          end += 1;
        }
        index = end;
        if (!terminated) {
          break;
        }
        continue;
      }
      // Other ESC functions have intermediate bytes followed by one final.
      let end = index + 1;
      while (end < raw.length) {
        const current = raw.charCodeAt(end);
        end += 1;
        if (current >= 0x30 && current <= 0x7e) {
          break;
        }
      }
      index = end;
      continue;
    }
    // 8-bit C1 CSI and terminal string introducers.
    if (code === 0x9b) {
      let end = index + 1;
      while (end < raw.length) {
        const final = raw.charCodeAt(end);
        end += 1;
        if (final >= 0x40 && final <= 0x7e) {
          break;
        }
      }
      index = end;
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      let end = index + 1;
      let terminated = false;
      while (end < raw.length) {
        const current = raw.charCodeAt(end);
        if (current === 0x07 || current === 0x9c) {
          end += 1;
          terminated = true;
          break;
        }
        if (current === 0x1b && raw.charCodeAt(end + 1) === 0x5c) {
          end += 2;
          terminated = true;
          break;
        }
        end += 1;
      }
      index = end;
      if (!terminated) {
        break;
      }
      continue;
    }
    // Drop controls, including stray ESC string terminators.
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      index += 1;
      continue;
    }
    const char = String.fromCodePoint(raw.codePointAt(index) ?? code);
    out += char;
    index += char.length;
  }
  return out;
}

/** Sanitizes and bounds a string by code points. */
function sanitizeBounded(value: unknown, maxCodePoints: number): string {
  const sanitized = sanitizeCellText(value);
  const codePoints = [...sanitized];
  return codePoints.length <= maxCodePoints ? sanitized : codePoints.slice(0, maxCodePoints).join("");
}

function countCodePoints(value: string): number {
  return [...value].length;
}

type KeyEventType = "press" | "repeat" | "release";

/** Exact, modifier-aware fallback for parameterized function-key CSI packets. */
function functionKeyEventType(data: string, key: string): KeyEventType | undefined {
  const tildeMatch = FUNCTION_KEY_TILDE_EVENT.exec(data);
  if (tildeMatch !== null) {
    if (!hasOnlyFunctionKeyLockModifiers(tildeMatch[2]) || FUNCTION_KEY_BY_TILDE_CODE[tildeMatch[1] ?? ""] !== key) {
      return undefined;
    }
    return eventTypeFromDigit(tildeMatch[3]);
  }
  const letterMatch = FUNCTION_KEY_LETTER_EVENT.exec(data);
  if (letterMatch !== null) {
    // CSI 1;1R without an event suffix is indistinguishable from a DSR cursor
    // position report; F3 remains available through its tilde form instead.
    if (letterMatch[2] === undefined && letterMatch[3] === "R") {
      return undefined;
    }
    if (!hasOnlyFunctionKeyLockModifiers(letterMatch[1]) || FUNCTION_KEY_BY_CSI_FINAL[letterMatch[3] ?? ""] !== key) {
      return undefined;
    }
    return eventTypeFromDigit(letterMatch[2]);
  }
  return undefined;
}

function hasOnlyFunctionKeyLockModifiers(value: string | undefined): boolean {
  const modifierValue = Number(value);
  // Public key matching ignores Caps Lock/Num Lock while preserving every
  // independent Shift/Alt/Ctrl/Super bit.
  return [1, 65, 129, 193].includes(modifierValue);
}

function eventTypeFromDigit(value: string | undefined): KeyEventType | undefined {
  switch (value) {
    case undefined:
    case "1":
      return "press";
    case "2":
      return "repeat";
    case "3":
      return "release";
    default:
      return undefined;
  }
}

/** Match one already-validated host chord, including supported F-key event packets. */
function hostKeyEventType(data: string, key: string): KeyEventType | undefined {
  const fallback = functionKeyEventType(data, key);
  if (!matchesKey(data, asHostKeyId(key)) && fallback === undefined) return undefined;
  if (isKeyRelease(data) || fallback === "release") return "release";
  if (isKeyRepeat(data) || fallback === "repeat") return "repeat";
  return "press";
}

/** Fixed, generated display label for a normalized toggle key id. */
function toggleDisplayName(key: string): string {
  // Normalization already bounds every component; the complete validated
  // chord is preserved so the footer wrap (or truthful too-small fallback)
  // decides what fits instead of a partial, misleading label.
  const display = sanitizeCellText(key);
  return display
    .split("+")
    .map((part) => (/[a-z]/.test(part.charAt(0)) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join("+");
}

/** Printable text of one chunk: Kitty CSI-u decoding or a single byte. */
function printableOf(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) {
    const sanitized = sanitizeBounded(kitty, 1);
    return sanitized.length === 1 ? sanitized : undefined;
  }
  if (data.length === 1) {
    const code = data.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      return data;
    }
  }
  return undefined;
}

/** Wraps one padded pane row with explicit SGR reset boundaries. */
function wrapRow(text: string, cols: number, sgr?: string): string {
  const padded = truncateToWidth(text, cols, "...", true);
  return sgr === undefined
    ? `\x1b[0m${padded}\x1b[0m`
    : `\x1b[0m${sgr}${padded}\x1b[0m`;
}

/**
 * Word-wraps generated hint segments into lines of at most `cols` visible
 * width, separated by " | ". Hints are never ellipsized: a segment that does
 * not fit moves whole to the next line, and only a segment wider than the
 * pane is word-wrapped. Returns undefined when even one word cannot fit, so
 * callers fall back to the truthful too-small pane instead of half-hints.
 */
function wrapHintLines(segments: readonly string[], cols: number): string[] | undefined {
  const lines: string[] = [];
  let current = "";
  for (const segment of segments) {
    if (visibleWidth(segment) > cols) {
      // Wider than the pane as a unit: it starts its own line and word-wraps,
      // so hint separators are never lost or merged.
      if (current !== "") {
        lines.push(current);
        current = "";
      }
      for (const word of segment.split(" ")) {
        if (word.length === 0) continue;
        if (visibleWidth(word) > cols) return undefined;
        const candidate = current === "" ? word : `${current} ${word}`;
        if (visibleWidth(candidate) <= cols) {
          current = candidate;
        } else {
          lines.push(current);
          current = word;
        }
      }
      continue;
    }
    const candidate = current === "" ? segment : `${current} | ${segment}`;
    if (visibleWidth(candidate) <= cols) {
      current = candidate;
    } else {
      lines.push(current);
      current = segment;
    }
  }
  if (current !== "") lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function blankLines(count: number): string[] {
  return Array.from({ length: count }, () => "");
}

/**
 * Truthful card status text (the line below the title): lifecycle or
 * observed/unknown agent state, plus observed/unknown input state for live
 * rows. Unknown (null) is never rendered as if it were false.
 */
interface SessionStatusFacts {
  readonly lifecycle: SidebarItem["lifecycle"];
  readonly busy: boolean | null;
  readonly pendingInput: boolean | null;
  readonly inputSurface: boolean;
  readonly activeTasks?: number | null;
  readonly activeShells?: number | null;
  readonly exitCode?: number;
}

function cardStatusText(item: SessionStatusFacts): string {
  const parts: string[] = [];
  switch (item.lifecycle) {
    case "starting":
      parts.push("starting");
      break;
    case "alive":
      parts.push(
        item.busy === true || (sanitizeCount(item.activeTasks) ?? 0) > 0
          || (sanitizeCount(item.activeShells) ?? 0) > 0
          ? "agent running"
          : item.pendingInput === true || item.inputSurface === true
            ? "agent waiting"
            : item.busy === false && item.pendingInput === false
              && sanitizeCount(item.activeTasks) === 0 && sanitizeCount(item.activeShells) === 0
              ? "agent idle"
              : "agent unknown",
      );
      break;
    case "exited":
      parts.push(
        typeof item.exitCode === "number"
          ? `exited (code ${Math.trunc(item.exitCode)})`
          : "exited",
      );
      break;
    case "error":
      parts.push(
        typeof item.exitCode === "number"
          ? `error (code ${Math.trunc(item.exitCode)})`
          : "error",
      );
      break;
  }
  if (item.lifecycle === "starting" || item.lifecycle === "alive") {
    parts.push(
      item.pendingInput === true || item.inputSurface === true
        ? "input pending"
        : item.pendingInput === false
          ? "input none"
          : "input unknown",
    );
  }
  return parts.join(" | ");
}

/** Honest ACTIVITY-INTENT counts: a missing/invalid count is "unknown", never 0. */
function cardBackgroundText(item: SessionStatusFacts): string {
  const tasks = sanitizeCount(item.activeTasks);
  const shells = sanitizeCount(item.activeShells);
  if (tasks === null && shells === null) {
    return "background unknown";
  }
  return `bg tasks ${tasks ?? "unknown"} | shells ${shells ?? "unknown"}`;
}

/** Accepts only nonnegative safe integers; everything else is unknown. */
function sanitizeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.abs(value) // normalizes -0
    : null;
}

/** Canonical card title: validated native name, else the row label. */
function cardTitle(item: SidebarItem): string {
  return sanitizeBounded(item.nativeSession?.name ?? item.label, ITEM_LABEL_INPUT_MAX_CODEPOINTS);
}

function requiresQuitConfirmation(item: SidebarItem): boolean {
  return (
    item.lifecycle === "starting" ||
    item.lifecycle === "alive" ||
    item.hasLiveProcess === true
  );
}

/**
 * Complete idleness, positively observed: every activity category and modal
 * input known-false or known-zero. Unknown (null) states or counts are never
 * idle. The caller already established hasLiveProcess === true. This reads the
 * conservative OWNERSHIP channel, deliberately not the displayed
 * activity-intent counts: retained cleanup/recovery work still requires
 * confirmation before a stop or removal.
 */
function isCompleteIdle(item: SidebarItem): boolean {
  return (
    item.busy === false &&
    item.pendingInput === false &&
    item.inputSurface === false &&
    sanitizeCount(item.backgroundTasks) === 0 &&
    sanitizeCount(item.backgroundShells) === 0
  );
}

function copyItem(item: SidebarItem): SidebarItem {
  if (typeof item !== "object" || item === null) {
    throw new Error("SidebarItem must be an object");
  }
  if (typeof item.id !== "string" || item.id.length === 0) {
    throw new Error("SidebarItem.id must be a nonempty string");
  }
  if (typeof item.lifecycle !== "string" || !LIFECYCLE_VALUES.has(item.lifecycle)) {
    throw new Error(
      `SidebarItem.lifecycle must be a known lifecycle, got ${JSON.stringify(item.lifecycle)}`,
    );
  }
  if (item.busy !== null && typeof item.busy !== "boolean") {
    throw new Error("SidebarItem.busy must be a boolean or null");
  }
  if (item.pendingInput !== null && typeof item.pendingInput !== "boolean") {
    throw new Error("SidebarItem.pendingInput must be a boolean or null");
  }
  if (typeof item.inputSurface !== "boolean") {
    throw new Error("SidebarItem.inputSurface must be a boolean");
  }
  if (item.hasLiveProcess !== undefined && typeof item.hasLiveProcess !== "boolean") {
    throw new Error("SidebarItem.hasLiveProcess must be a boolean when provided");
  }
  return {
    id: item.id,
    label: typeof item.label === "string" ? item.label : "",
    workspace: typeof item.workspace === "string" ? item.workspace : "",
    agentDir: typeof item.agentDir === "string" ? item.agentDir : "",
    lifecycle: item.lifecycle,
    ...(typeof item.hasLiveProcess === "boolean" ? { hasLiveProcess: item.hasLiveProcess } : {}),
    ...(item.unavailable === true ? { unavailable: true } : {}),
    busy: item.busy,
    pendingInput: item.pendingInput,
    inputSurface: item.inputSurface,
    activity: Array.isArray(item.activity) ? [...item.activity] : [],
    ...(item.nativeSession === null ? { nativeSession: null }
      : item.nativeSession && isValidNativeSessionId(item.nativeSession.sessionId)
        && Number.isSafeInteger(item.nativeSession.epoch) && item.nativeSession.epoch > 0
        && isValidRenameName(item.nativeSession.name)
        ? { nativeSession: { ...item.nativeSession } }
        : {}),
    ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
    backgroundTasks: sanitizeCount(item.backgroundTasks),
    backgroundShells: sanitizeCount(item.backgroundShells),
    activeTasks: sanitizeCount(item.activeTasks),
    activeShells: sanitizeCount(item.activeShells),
  };
}

/**
 * Bounded defensive copies of the coordinator's display DTOs. Nothing here
 * performs IO, resolves paths, or invents facts: a malformed nested entry is
 * dropped instead of being coerced into a plausible one, and absent
 * observations stay unknown (`null`).
 */
function displayObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function displayText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function displayOptionalText(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : undefined;
}

function displayBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function displayObservation(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function displayNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function displayPersistence(value: unknown): "saved" | "unsaved" | "unknown" | undefined {
  return value === "saved" || value === "unsaved" || value === "unknown" ? value : undefined;
}

function displayPort(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= PEER_PORT_MAX
    ? value
    : undefined;
}

function copyPeerSettings(value: unknown): PeerUiSettings | null {
  if (value === null || value === undefined) return null;
  const source = displayObject(value);
  if (source === undefined) return null;
  const hostingEnabled = displayBoolean(source.hostingEnabled);
  const autoReconnect = displayBoolean(source.autoReconnect);
  const bellEnabled = displayBoolean(source.bellEnabled);
  const bindHost = displayText(source.bindHost);
  const bindPort = source.bindPort === null ? null : displayPort(source.bindPort);
  if (hostingEnabled === undefined || autoReconnect === undefined || bellEnabled === undefined
    || bindHost === undefined || bindPort === undefined) return null;
  return { hostingEnabled, bindHost, bindPort, autoReconnect, bellEnabled };
}

function copyPeerRosterRow(value: unknown): PeerRosterRow | null {
  const source = displayObject(value);
  if (source === undefined) return null;
  const id = displayText(source.id);
  const label = displayText(source.label);
  const workspace = displayText(source.workspace);
  const lifecycle = displayText(source.lifecycle);
  const hasLiveProcess = displayBoolean(source.hasLiveProcess);
  const inputSurface = displayBoolean(source.inputSurface);
  if (id === undefined || id.length === 0 || label === undefined || workspace === undefined
    || lifecycle === undefined || !LIFECYCLE_VALUES.has(lifecycle)
    || hasLiveProcess === undefined || inputSurface === undefined) return null;
  const nativeValue = displayObject(source.nativeSession);
  const persistence = nativeValue === undefined ? undefined : displayPersistence(nativeValue.persistence);
  const nativeSession = nativeValue === undefined ? null
    : isValidNativeSessionId(displayText(nativeValue.sessionId) ?? "")
      && Number.isSafeInteger(nativeValue.epoch) && (nativeValue.epoch as number) > 0
      && typeof nativeValue.name === "string" && nativeValue.name.length > 0
      ? {
        sessionId: nativeValue.sessionId as string,
        epoch: nativeValue.epoch as number,
        name: nativeValue.name,
        ...(persistence === undefined ? {} : { persistence }),
      }
      : null;
  return {
    id,
    label,
    workspace,
    lifecycle: lifecycle as PeerRosterRow["lifecycle"],
    hasLiveProcess,
    busy: displayObservation(source.busy),
    pendingInput: displayObservation(source.pendingInput),
    inputSurface,
    activity: Array.isArray(source.activity)
      ? source.activity.filter((line): line is string => typeof line === "string")
      : [],
    nativeSession,
    backgroundTasks: sanitizeCount(source.backgroundTasks),
    backgroundShells: sanitizeCount(source.backgroundShells),
    activeTasks: sanitizeCount(source.activeTasks),
    activeShells: sanitizeCount(source.activeShells),
    ...(displayNumber(source.exitCode) === undefined ? {} : { exitCode: displayNumber(source.exitCode) }),
    ...(displayText(source.error) === undefined ? {} : { error: displayText(source.error) }),
  };
}

function copyPeerHost(value: unknown): PeerUiHost | null {
  const source = displayObject(value);
  if (source === undefined) return null;
  const id = displayText(source.id);
  const label = displayText(source.label);
  const host = displayText(source.host);
  const port = displayPort(source.port);
  const state = displayText(source.state);
  const fingerprint = displayOptionalText(source.fingerprint);
  const message = displayOptionalText(source.message);
  const reconnectSuppressed = displayBoolean(source.reconnectSuppressed);
  const previouslyConnected = displayBoolean(source.previouslyConnected);
  const rosterValue = displayObject(source.roster);
  const rosterState = displayText(rosterValue?.state);
  const rowsValue = rosterValue?.rows;
  if (id === undefined || id.length === 0 || label === undefined || host === undefined
    || port === undefined || state === undefined
    || fingerprint === undefined || message === undefined
    || reconnectSuppressed === undefined || previouslyConnected === undefined
    || rosterState === undefined) return null;
  if (state !== "disconnected" && state !== "connecting" && state !== "pairing"
    && state !== "connected" && state !== "retrying" && state !== "error") return null;
  if (rosterState !== "never" && rosterState !== "current" && rosterState !== "stale") return null;
  let rows: readonly PeerRosterRow[] | null = null;
  if (rowsValue !== null && rowsValue !== undefined) {
    if (!Array.isArray(rowsValue)) return null;
    const accepted: PeerRosterRow[] = [];
    for (const candidate of rowsValue.slice(0, PEER_MAX_ROSTER_ROWS)) {
      const row = copyPeerRosterRow(candidate);
      if (row !== null) accepted.push(row);
    }
    rows = accepted;
  }
  return {
    id,
    label,
    host,
    port,
    state: state as PeerUiHost["state"],
    fingerprint,
    message,
    reconnectSuppressed,
    previouslyConnected,
    roster: { state: rosterState, rows },
  };
}

function copyPeerTrustedPeer(value: unknown): PeerUiTrustedPeer | null {
  const source = displayObject(value);
  if (source === undefined) return null;
  const id = displayText(source.id);
  const label = displayText(source.label);
  const fingerprint = displayText(source.fingerprint);
  const hasInboundGrant = displayBoolean(source.hasInboundGrant);
  if (id === undefined || id.length === 0 || label === undefined
    || fingerprint === undefined || hasInboundGrant === undefined) return null;
  return { id, label, fingerprint, hasInboundGrant };
}

function copyPeerConsent(value: unknown): PeerUiConsent | null {
  const source = displayObject(value);
  if (source === undefined) return null;
  const id = displayText(source.id);
  const kind = displayText(source.kind);
  const label = displayText(source.label);
  const fingerprint = displayText(source.fingerprint);
  const endpoint = displayOptionalText(source.endpoint);
  const requestedAt = displayNumber(source.requestedAt);
  const expiresAt = displayNumber(source.expiresAt);
  if (id === undefined || id.length === 0 || label === undefined || fingerprint === undefined
    || endpoint === undefined || requestedAt === undefined || expiresAt === undefined) return null;
  if (kind !== "incoming" && kind !== "server-key") return null;
  return { id, kind, label, fingerprint, endpoint, requestedAt, expiresAt };
}

function copyPeerList<T>(value: unknown, max: number, copy: (entry: unknown) => T | null): readonly T[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return null;
  const accepted: T[] = [];
  for (const candidate of value.slice(0, max)) {
    const item = copy(candidate);
    if (item !== null) accepted.push(item);
  }
  return accepted;
}

/**
 * Validates and copies one attached network snapshot. A snapshot that is not
 * object-shaped is refused loudly; malformed nested rows are dropped so a
 * hostile or buggy producer cannot fabricate a host, grant, or request. A
 * `null` settings/hosts/trusted list stays `null` (unavailable/unknown), never
 * an empty list that would read as "none".
 */
function copyPeerSnapshot(value: PeerUiSnapshot): PeerUiSnapshot {
  const source = displayObject(value);
  if (source === undefined) {
    throw new Error("SidebarController.setPeerUiSnapshot expects a PeerUiSnapshot");
  }
  const revision = displayNumber(source.revision);
  const status = displayText(source.status);
  const listener = displayObject(source.listener);
  const listenerState = displayText(listener?.state);
  const listenerHost = displayOptionalText(listener?.host);
  const listenerPort = listener?.port === null || listener?.port === undefined
    ? null
    : displayPort(listener?.port);
  const listenerMessage = displayOptionalText(listener?.message);
  const identityFingerprint = displayOptionalText(source.identityFingerprint);
  const notice = displayOptionalText(source.notice);
  if (revision === undefined || status === undefined
    || (status !== "loading" && status !== "ready" && status !== "unavailable")
    || listener === undefined || listenerState === undefined
    || (listenerState !== "off" && listenerState !== "starting"
      && listenerState !== "listening" && listenerState !== "error")
    || listenerHost === undefined || listenerPort === undefined || listenerMessage === undefined
    || identityFingerprint === undefined || notice === undefined) {
    throw new Error("SidebarController.setPeerUiSnapshot expects a complete PeerUiSnapshot");
  }
  return {
    revision,
    status,
    settings: copyPeerSettings(source.settings),
    identityFingerprint,
    listener: {
      state: listenerState,
      host: listenerHost,
      port: listenerPort,
      message: listenerMessage,
    },
    hosts: copyPeerList(source.hosts, PEER_MAX_HOSTS, copyPeerHost),
    trustedPeers: copyPeerList(source.trustedPeers, PEER_MAX_TRUSTED_PEERS, copyPeerTrustedPeer),
    consents: copyPeerList(source.consents, PEER_MAX_CONSENTS, copyPeerConsent) ?? [],
    notice,
  };
}

function assertPaneDimension(value: number, max: number, label: "cols" | "rows"): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(
      `Sidebar render ${label} must be a safe integer between 1 and ${max}, got ${value}`,
    );
  }
}

function validHitGeometry(column: number, row: number, cols: number, rows: number): boolean {
  return Number.isSafeInteger(column) && column >= 0 && Number.isSafeInteger(row) && row >= 0
    && Number.isSafeInteger(cols) && cols > 0 && column < cols
    && Number.isSafeInteger(rows) && rows > 0 && row < rows;
}

function markerSuffixLength(value: string, marker: string): number {
  const limit = Math.min(value.length, marker.length - 1);
  for (let length = limit; length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

export class SidebarController {
  private toggleKey: string;
  private toggleLabel: string;
  private returnToMainKey: string;
  private returnToMainLabel: string;
  private configuredShortcuts: HostShortcutBindings;
  private readonly legacyToggleOverride: boolean;
  private readonly settingsAvailable: boolean;
  private readonly onAction?: (action: SidebarAction) => void;
  private readonly onInvalidate?: () => void;
  private readonly workspaceBasePath: string;
  private readonly createTextField?: SidebarControllerOptions["createTextField"];
  private readonly createSavedQueryInput?: SidebarControllerOptions["createSavedQueryInput"];
  /** Clock for the bounded human consent window only; never used for IO. */
  private readonly now: () => number;
  /**
   * Attached coordinator display snapshot. While it is undefined this
   * controller is exactly the legacy local sidebar: no Network menu, no
   * incoming-consent alert, and no remote rows exist at all.
   */
  private peerUiSnapshot: PeerUiSnapshot | undefined;
  /** Highlighted network-panel row key (kept across snapshot updates). */
  private peerSelectedKey: string | undefined;
  private peerPaneTop = 0;
  /** Exact rows/geometry drawn by the last complete network-panel render. */
  private peerDisplay: DisplayedPeerRows | undefined;
  private peerPaneError: string | undefined;
  /** Local, fixed notice describing a requested action (never claimed success). */
  private peerPaneNotice: string | undefined;
  /** Unsaved explicit listen address/port drafts; no default port is invented. */
  private peerBindHostDraft = "";
  private peerBindPortDraft = "";
  private peerBindDirty = false;
  /** Unsaved Add-destination drafts. */
  private peerAddDraft = { label: "", host: "", port: "" };
  private peerFieldTarget: { readonly purpose: "bind-host" | "bind-port" | "add" } | undefined;
  private peerFieldIndex: 0 | 1 | 2 = 0;
  /** Frozen destination-removal target; later snapshots never retarget it. */
  private peerRemoveTarget: { readonly hostId: string; readonly label: string; readonly endpoint: string } | undefined;
  /** Frozen receiving-revocation target; independent of the outgoing direction. */
  private peerRevokeTarget: { readonly peerId: string; readonly label: string; readonly fingerprint: string } | undefined;
  /** True only while the complete remove/revoke warning was drawn. */
  private peerConfirmDisplayed = false;
  /** Latched incoming consent identity; never replaced in place by a newer request. */
  private peerConsentLatch: PeerConsentLatch | undefined;
  private peerConsentChoice: "approve" | "deny" = "deny";
  /** Current candidate consent frame (identity + decision + geometry). */
  private peerConsentDisplay: DisplayedPeerConsent | undefined;
  /** True only while the last render drew this exact complete consent dialog. */
  private peerConsentRendered = false;
  /** Token Main reported as actually written; the ONLY decision authority. */
  private peerConsentWrittenToken: number | undefined;
  private peerConsentTokenSequence = 1;
  /** Bounded local notice shown inside the consent dialog (never a decision). */
  private peerConsentLocalNotice: string | undefined;
  private savedQueryInput?: SidebarSavedQueryInput;
  private formField?: SessionHostTextField;
  private formMatchesCancel: (data: string) => boolean = (data) => matchesKey(data, "escape");
  /** Effective native submit-key matcher for the current form field. */
  private formMatchesSubmit: (data: string) => boolean = (data) => matchesKey(data, "enter");
  /**
   * The exact canonical key id of the field input currently being handled,
   * captured only while it synchronously submits the New form. This
   * distinguishes which configured submit binding actually fired when several
   * keys are bound to `tui.input.submit`.
   */
  private formInputSubmitKey: KeyId | undefined;
  private formPasteActive = false;
  private formPasteCarry = "";
  private formHints = DEFAULT_FORM_HINTS;
  private formNotice: string | undefined;
  private formGeneration = 0;
  private formKind: "new" | "edit" | "saved" | "shortcuts" | "peer" | "peer-field" | undefined;
  private shortcutDraft: { toggle: string; returnToMain: string } = { ...DEFAULT_HOST_SHORTCUTS };
  private shortcutFieldIndex: 0 | 1 = 0;
  private pendingShortcutSave: { readonly requestId: number } | undefined;
  /** Outstanding saved-conversation listing request (issue 323). */
  private pendingSavedList: { readonly requestId: number } | undefined;
  /** Deliberate saved-open in flight; late results are fenced by requestId. */
  private pendingSavedOpen: { readonly requestId: number } | undefined;
  private pendingRowResume: { readonly requestId: number; readonly id: string } | undefined;
  private savedRows: SidebarSavedRow[] = [];
  private savedPickerId: number | undefined;
  private savedQueryRevision = 0;
  private savedQueryNotice: string | undefined;
  private pendingSavedDeleteCheck: SavedDeleteContext | undefined;
  private savedDeleteTarget: SavedDeleteContext | undefined;
  private savedDeleteOperation: SavedDeleteContext | undefined;
  private savedDeleteConfirmationDisplayed = false;
  private savedDeleteConfirmationRenderToken: number | undefined;
  private nextSavedDeleteConfirmationRenderToken = 1;
  /** Held native action packets remain consumed across cancel, dismiss, or focus changes. */
  private savedActionClaims: Array<(data: string) => boolean> = [];
  private savedIssueCount = 0;
  private savedError: string | undefined;
  private savedSelectedIndex = 0;
  private savedListTop = 0;
  /**
   * The exact saved rows (id|file) fully drawn by the last valid picker render.
   * A saved-open is refused unless the highlighted tuple is in this set, so a
   * too-small fallback or an undrawn/hidden row can never be opened. Invalidated
   * on fallback, dismissal, and catalog replacement.
   */
  private displayedSavedRows: DisplayedSavedRows | undefined;
  private editTarget?: { readonly id: string; readonly nativeSession: SessionHostNativeSession; readonly currentName: string };
  private workspaceDraft: string;
  private editDraft = "";
  private rowStore: SidebarItem[] = [];
  private entries: SidebarEntry[] = [];
  private selectedEntryKey: string | undefined = ENTRY_NEW_KEY;
  private desiredSelectionId: string | undefined;
  private _visible: boolean;
  private _focus: SidebarFocus = "main";
  /**
   * View-only observer of the host's actual active Main owner (the explicitly
   * activated live child). Set by Main, never inferred from the selection; it
   * only drives the white title highlight and is cleared when the row leaves
   * the roster. It never changes activation or input ownership.
   */
  private activeMainOwnerID_: string | undefined;
  /**
   * Provenance fence for every host-claimed return chord. Retain each chord's
   * identity across successful rebinding so its repeat/release cannot leak
   * into Main under the new binding; the set is bounded by the finite accepted
   * chord vocabulary. A fresh press clears that chord's old claim.
   */
  private readonly claimedReturnToMainKeys = new Set<string>();
  /** Preserve toggle chord identity across a successful settings rebind. */
  private readonly claimedToggleKeys = new Set<string>();
  /**
   * Provenance fence for a host-owned form Escape: a fresh Escape that cancels
   * only the New or Edit form — or that the native field consumes to dismiss
   * its completion list — must not let the held key's repeat/release bubble
   * into the roster's Escape-hide or leak into the child as native input. A
   * fresh roster Escape still hides (existing semantics).
   */
  private formEscapeClaimed = false;
  /**
   * Provenance fence for the fresh submit key that submitted the New form or
   * opened a saved conversation. Success transfers input ownership to the
   * newly created child, so the held key's repeat/release must not be replayed
   * into that child as native input; a later fresh press of that key in Main is
   * ordinary native input. The matcher is captured at submission time so it
   * survives the field teardown that follows a successful completion.
   */
  private formSubmitClaim: ((data: string) => boolean) | undefined;
  private pendingCreate: { readonly requestId: number } | undefined;
  private pendingRename: { readonly requestId: number } | undefined;
  /** Explicit confirmation purpose: quit the host or stop one owned session. */
  private confirmPurpose:
    | "quit"
    | "stop-remove"
    | "saved-delete"
    | "peer-consent"
    | "peer-remove"
    | "peer-revoke" = "quit";
  /** Frozen stop target id; later navigation never retargets the confirmation. */
  private stopRemoveTargetId: string | undefined;
  /** True only while the last render drew the complete stop warning dialog. */
  private stopConfirmDisplayed = false;
  private formError: string | undefined;
  private noticeError: string | undefined;
  private nextRequestId = 1;
  private listTop = 0;
  /**
   * Item ids whose cards the user collapsed with Space. Cards default to
   * expanded; each card's state persists independently of the highlight.
   */
  private readonly collapsedItemIds = new Set<string>();
  /**
   * Narrow resume-replacement fence: old exited placeholder ids the backend is
   * removing because their replacement child actually started. Consumed by the
   * roster update that observes the disappearance; never used for ordinary
   * vanished-row safety or explicit removals.
   */
  private readonly replacedRowIds = new Set<string>();
  /**
   * What the last roster render actually drew: the entry-order signature at
   * that time and the height of every COMPLETELY rendered entry. A too-small
   * render records no entries; hiding the pane or replacing it with a
   * form/picker/confirmation forgets the record. Selection-targeted keys
   * (Enter, edit, remove) act only on an entry present here at its current
   * height, so nothing invisible or since-changed can be activated.
   */
  private displayedRoster: DisplayedRoster | undefined;
  /** Current host-owned terminal diagnostics warning (#428); undefined hides the entry. */
  private diagnosticsWarning: TerminalDiagnosticsWarningView | undefined;

  constructor(options: SidebarControllerOptions = {}) {
    this.configuredShortcuts = normalizeHostShortcutBindings(options.configuredShortcuts ?? DEFAULT_HOST_SHORTCUTS);
    this.toggleKey = normalizeHostShortcutKey(options.toggleKey ?? this.configuredShortcuts.toggle, "toggle");
    this.returnToMainKey = normalizeHostShortcutKey(
      options.returnToMainKey ?? this.configuredShortcuts.returnToMain,
      "returnToMain",
    );
    assertHostShortcutsDistinct(this.toggleKey, this.returnToMainKey);
    this.toggleLabel = toggleDisplayName(this.toggleKey);
    this.returnToMainLabel = toggleDisplayName(this.returnToMainKey);
    this.legacyToggleOverride = options.legacyToggleOverride === true;
    this.settingsAvailable = options.settingsAvailable ?? false;
    this.onAction = options.onAction;
    this.onInvalidate = options.onInvalidate;
    this._visible = options.initialVisible ?? true;
    this.workspaceBasePath = resolve(options.workspaceBasePath ?? "/");
    this.createTextField = options.createTextField;
    this.createSavedQueryInput = options.createSavedQueryInput;
    this.now = options.now ?? (() => Date.now());

    const suggestedWorkspace = sanitizeCellText(options.initialWorkspace ?? "");
    if (countCodePoints(suggestedWorkspace) > PATH_FIELD_MAX_CODEPOINTS) {
      throw new Error(
        `initialWorkspace exceeds the ${PATH_FIELD_MAX_CODEPOINTS}-character limit`,
      );
    }
    this.workspaceDraft = suggestedWorkspace;
    // A visible pane is an opened pane: the welcome picker (default) and a
    // supplied roster both take sidebar focus, while an explicitly hidden
    // start keeps main focus for native typing.
    this._focus = this._visible ? "sidebar" : "main";
    this.rebuildEntries();
  }

  /** Whether the sidebar pane is currently shown at all. */
  get visible(): boolean {
    return this._visible;
  }

  /** Where keyboard input currently goes. */
  get focus(): SidebarFocus {
    return this._focus;
  }

  /** Return from the roster to Main without changing its selection or visibility. */
  focusMainFromNativeClick(): boolean {
    if (!this._visible || this._focus !== "sidebar") return false;
    this._focus = "main";
    this.onInvalidate?.();
    return true;
  }

  /** Currently highlighted roster item id (undefined for non-item rows). */
  get selectedId(): string | undefined {
    const entry = this.currentEntry();
    return entry !== undefined && entry.kind === "item" && entry.item !== undefined
      ? entry.item.id
      : undefined;
  }

  /** View-only: the host's actual active Main owner id (undefined when none). */
  get activeMainOwnerID(): string | undefined {
    return this.activeMainOwnerID_;
  }

  /** Opaque identity of the currently open Saved picker, when one owns the pane. */
  get savedPickerRequestId(): number | undefined {
    return this.formKind === "saved" || this.confirmPurpose === "saved-delete" ? this.savedPickerId : undefined;
  }

  /** Current native Input query; never copied into display rows or persisted state. */
  get savedQuery(): string {
    return this.savedQueryInput?.getValue() ?? "";
  }

  get savedQueryRevisionNumber(): number {
    return this.savedQueryRevision;
  }

  /** True only for the Saved-file confirmation; this is a placement signal, not an input-focus alias. */
  get savedDeleteConfirmationActive(): boolean {
    return this._visible && this._focus === "confirm" && this.confirmPurpose === "saved-delete";
  }

  /**
   * True while a latched consent confirmation owns confirm focus, whether or
   * not it has rendered yet. Main uses it as a placement signal for the wide
   * right-hand confirmation slot (the same shape as the Saved-delete warning);
   * it is never an input-focus alias and grants no consent authority.
   */
  get peerConsentConfirmationActive(): boolean {
    return this._visible && this._focus === "confirm" && this.confirmPurpose === "peer-consent"
      && this.peerConsentLatch !== undefined;
  }

  /** Opaque token for the last fully rendered Saved-delete warning candidate. */
  get savedDeleteConfirmationRenderTokenNumber(): number | undefined {
    return this.savedDeleteConfirmationRenderToken;
  }

  /** Revoke Saved-delete display authority before any focus, target, or geometry invalidation. */
  invalidateSavedDeleteConfirmationDisplay(): void {
    this.savedDeleteConfirmationDisplayed = false;
    this.savedDeleteConfirmationRenderToken = undefined;
  }

  /** Whether a still-current complete warning render is awaiting/has reached writer settlement. */
  isSavedDeleteConfirmationRenderCurrent(token: number): boolean {
    const target = this.savedDeleteTarget;
    return token === this.savedDeleteConfirmationRenderToken
      && this._visible && this._focus === "confirm" && this.confirmPurpose === "saved-delete"
      && target !== undefined && this.savedPickerId === target.pickerId
      && this.savedQueryRevision === target.revision;
  }

  /** Grant input authority only after Main's writer settles this exact render token. */
  settleSavedDeleteConfirmationRender(token: number): boolean {
    if (!this.isSavedDeleteConfirmationRenderCurrent(token)) return false;
    this.savedDeleteConfirmationDisplayed = true;
    return true;
  }

  /** Release the picker Input and its bounded UI rows during host shutdown. */
  disposeSavedPicker(): void {
    const wasSavedConfirmation = this.confirmPurpose === "saved-delete";
    this.clearSavedPickerState();
    this.savedError = undefined;
    this.displayedSavedRows = undefined;
    if (this.formKind === "saved") this.formKind = undefined;
    if (wasSavedConfirmation && this._focus === "confirm") this._focus = "sidebar";
  }

  /** Verify that a deletion preflight came from the exact selected displayed row. */
  isSavedDeletePreparationCurrent(
    requestId: number,
    pickerId: number,
    id: string,
    file: string,
    revision: number,
  ): boolean {
    const check = this.pendingSavedDeleteCheck;
    return this._visible && this._focus === "form" && this.formKind === "saved"
      && this.savedPickerId === pickerId && this.savedQueryRevision === revision
      && check !== undefined && check.requestId === requestId && check.pickerId === pickerId
      && check.id === id && check.file === file && check.revision === revision
      && this.savedRows[this.savedSelectedIndex]?.id === id
      && this.savedRows[this.savedSelectedIndex]?.file === file;
  }

  /** Confirmation-phase authority checked again by Main immediately before mutation. */
  isSavedDeleteConfirmationCurrent(
    requestId: number,
    pickerId: number,
    id: string,
    file: string,
    revision: number,
  ): boolean {
    const target = this.savedDeleteTarget;
    const operation = this.savedDeleteOperation;
    return this._visible && this._focus === "confirm" && this.confirmPurpose === "saved-delete"
      && this.savedDeleteConfirmationDisplayed && this.savedPickerId === pickerId
      && this.savedQueryRevision === revision
      && target !== undefined && operation !== undefined
      && target.requestId === requestId && operation.requestId === requestId
      && target.pickerId === pickerId && operation.pickerId === pickerId
      && target.id === id && operation.id === id && target.file === file && operation.file === file
      && target.revision === revision && operation.revision === revision;
  }

  /** Main has rechecked the exact row and live-child guard synchronously. */
  completeSavedDeleteCheck(requestId: number, allowed: boolean, message?: string): boolean {
    const context = this.pendingSavedDeleteCheck;
    if (!context || context.requestId !== requestId) return false;
    this.pendingSavedDeleteCheck = undefined;
    if (!this.isSavedDeletePreparationStillCurrent(context)) return false;
    if (!allowed) {
      this.savedError = sanitizeBounded(message ?? "Saved conversation is not safe to delete", ERROR_TEXT_MAX_CODEPOINTS);
      this.onInvalidate?.();
      return true;
    }
    this.invalidateSavedDeleteConfirmationDisplay();
    this.savedDeleteTarget = context;
    this.savedDeleteOperation = undefined;
    this.displayedSavedRows = undefined;
    this.confirmPurpose = "saved-delete";
    this._focus = "confirm";
    this.onInvalidate?.();
    return true;
  }

  /** Complete or refuse the one confirmed deletion while preserving the picker draft. */
  completeSavedDelete(requestId: number, message: string, refresh: boolean): boolean {
    const context = this.savedDeleteOperation;
    if (!context || context.requestId !== requestId || !this.isSavedDeleteConfirmationCurrent(
      requestId, context.pickerId, context.id, context.file, context.revision,
    )) return false;
    this.savedDeleteOperation = undefined;
    this.savedDeleteTarget = undefined;
    this.invalidateSavedDeleteConfirmationDisplay();
    this.confirmPurpose = "quit";
    this._focus = "form";
    this.savedError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
    if (refresh && this.savedPickerId === context.pickerId) {
      const requestId = this.nextRequestId++;
      this.pendingSavedList = { requestId };
      this.displayedSavedRows = undefined;
      this.emit({ type: "saved-refresh", requestId, pickerId: context.pickerId });
    }
    this.onInvalidate?.();
    return true;
  }

  private isSavedDeletePreparationStillCurrent(context: SavedDeleteContext): boolean {
    return this._visible && this._focus === "form" && this.formKind === "saved"
      && this.savedPickerId === context.pickerId && this.savedQueryRevision === context.revision
      && this.savedRows[this.savedSelectedIndex]?.id === context.id
      && this.savedRows[this.savedSelectedIndex]?.file === context.file;
  }

  /**
   * Main-owned, view-only observer of the actual active Main conversation.
   * It only drives the white title highlight; it never activates a row,
   * moves input focus, or changes ownership. Main clears it (undefined) when
   * the owner row leaves the roster so a sibling is never falsely highlighted.
   */
  setActiveMainOwner(id: string | undefined): void {
    this.activeMainOwnerID_ = typeof id === "string" && id.length > 0 ? id : undefined;
  }

  /** Read-only view of the last updateItems roster (defensive copies). */
  get items(): readonly SidebarItem[] {
    return [...this.rowStore];
  }

  /**
   * Replaces the roster from backend snapshots. Items are copied; keyboard
   * selection follows ids across metadata updates and reorders. When the
   * selected item disappears, focus returns to the roster picker and the
   * selection is cleared, so subsequent keystrokes are never silently
   * forwarded to a different instance until an explicit selection.
   */
  updateItems(items: readonly SidebarItem[]): void {
    if (!Array.isArray(items)) {
      throw new Error("SidebarController.updateItems expects an array of SidebarItem");
    }
    this.rowStore = items.map((item) => copyItem(item));
    this.rebuildEntries();
    if (this.pendingRowResume && !this.rowStore.some(item => item.id === this.pendingRowResume!.id
      && item.lifecycle === "exited" && item.hasLiveProcess !== true)) this.cancelRowResume();
    // Keep expansion memory bounded to the current roster.
    const liveIds = new Set(this.rowStore.map((item) => item.id));
    for (const id of [...this.collapsedItemIds]) {
      if (!liveIds.has(id)) this.collapsedItemIds.delete(id);
    }
    if (this.desiredSelectionId !== undefined) {
      const resolved = this.findItemEntry(this.desiredSelectionId);
      if (resolved !== undefined) {
        this.selectedEntryKey = resolved.key;
        this.desiredSelectionId = undefined;
      }
      // A still-pending desired selection stays pending until its row
      // actually appears; no index-based guess is ever made.
      this.pruneRowReplacementFences(liveIds);
      return;
    }
    const entry = this.currentEntry();
    if (this.selectedEntryKey !== undefined && entry === undefined
      && this.selectedEntryKey.startsWith(ITEM_KEY_PREFIX)) {
      const vanishedId = this.selectedEntryKey.slice(ITEM_KEY_PREFIX.length);
      this.selectedEntryKey = undefined;
      if (!this.replacedRowIds.delete(vanishedId)) {
        // The highlighted instance vanished on its own: show the picker and
        // pull focus back to the list.
        if (this._focus === "main") {
          this._focus = "sidebar";
          if (!this._visible) {
            // A vanished selection must not eat input in an invisible picker:
            // show the pane and emit the visibility action for the reflow.
            this._visible = true;
            this.emit({ type: "visibility", visible: true });
          }
        }
      }
    }
    this.pruneRowReplacementFences(liveIds);
  }

  /** Drops replacement fences whose row is no longer in the roster. */
  private pruneRowReplacementFences(liveIds: ReadonlySet<string>): void {
    for (const id of [...this.replacedRowIds]) {
      if (!liveIds.has(id)) this.replacedRowIds.delete(id);
    }
  }

  /** Backend-driven selection (e.g. for a spawn the host initiated). */
  select(id: string): void {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("SidebarController.select expects a nonempty string id");
    }
    this.cancelRowResume();
    // A newer backend selection supersedes this request's UI ownership,
    // not the native launch. Preserve the draft and current focus. The native
    // Editor field is one-shot after submit, so reopen it for a real retry.
    if (this.pendingCreate !== undefined) {
      this.pendingCreate = undefined;
      if (this.formKind === "new") {
        this.workspaceDraft = this.formField?.getValue() ?? this.workspaceDraft;
        this.createFormField(this.workspaceDraft);
      }
    }
    const entry = this.findItemEntry(id);
    if (entry !== undefined) {
      this.selectedEntryKey = entry.key;
      this.desiredSelectionId = undefined;
    } else {
      // Not in the roster yet (typical for an initial spawn): remember the
      // desired id, clear the selection, and let updateItems apply it once
      // the row arrives.
      this.desiredSelectionId = id;
      this.selectedEntryKey = undefined;
    }
  }

  /**
   * Resolves a pending create. A successful explicit New submission activates
   * the created child as the Main input owner without a second host-row Enter
   * (the pane stays visible exactly as it was); the new row is highlighted only
   * while the request still owns the form. Late completions never steal focus
   * from a newer selection or form draft.
   */
  completeCreate(requestId: number, id: string): void {
    if (this.pendingCreate?.requestId !== requestId) {
      return; // stale callback: ignore entirely, no contamination
    }
    this.pendingCreate = undefined;
    if (this.formKind === "new" && this.formField) this.workspaceDraft = this.formField.getValue();
    this.disposeFormField();
    this.formKind = undefined;
    this.formError = undefined;
    if (this._focus === "form") {
      this.acceptCompletedRow(id);
      this._focus = "main";
      this.emit({ type: "select", id });
    }
  }

  /**
   * Fails a pending create. Entered fields and the error are preserved when
   * the request still matches; stale callbacks are ignored without touching
   * the current form.
   */
  failCreate(requestId: number, message: string): void {
    if (this.pendingCreate?.requestId !== requestId) {
      return; // stale callback: ignore entirely, no contamination
    }
    this.pendingCreate = undefined;
    this.formError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
    if (this.formKind === "new") {
      if (this.formField) this.workspaceDraft = this.formField.getValue();
      this.disposeFormField();
      this.createFormField(this.workspaceDraft);
    }
  }

  /** Open Edit for the exact observed native conversation, without selecting it. */
  openEdit(target: { readonly id: string; readonly nativeSession: SessionHostNativeSession; readonly currentName: string }): boolean {
    if (!this._visible || this._focus !== "sidebar" || !target.id || !target.nativeSession
      || !isValidNativeSessionId(target.nativeSession.sessionId)
      || !Number.isSafeInteger(target.nativeSession.epoch) || target.nativeSession.epoch < 1
      || !isValidRenameName(target.nativeSession.name)) return false;
    this.forgetDisplayedRoster(); // narrow layouts overlay the roster
    this.disposeFormField();
    this.pendingCreate = undefined;
    this.pendingRename = undefined;
    this.formKind = "edit";
    this.editTarget = {
      id: target.id,
      nativeSession: { ...target.nativeSession },
      currentName: sanitizeBounded(target.currentName, 256),
    };
    this.editDraft = "";
    this.formError = undefined;
    this.noticeError = undefined;
    this._focus = "form";
    this.createFormField(this.editDraft);
    return this.formField !== undefined;
  }

  /** Complete one rename only while that request still owns the open form. */
  completeRename(requestId: number, status: string): void {
    if (this.pendingRename?.requestId !== requestId || this.formKind !== "edit") return;
    this.pendingRename = undefined;
    if (this.formField) this.editDraft = this.formField.getValue();
    this.disposeFormField();
    if (status === "renamed") {
      this.formKind = undefined;
      this.editTarget = undefined;
      this.formError = undefined;
      this._focus = "sidebar";
      this.noticeError = undefined;
      return;
    }
    this.formError = renameFailureNotice(status);
    this.createFormField(this.editDraft);
  }

  /** Shows a bounded error when Main rejects an edit before broker admission. */
  failRename(requestId: number, message: string): void {
    if (this.pendingRename?.requestId !== requestId || this.formKind !== "edit") return;
    this.pendingRename = undefined;
    if (this.formField) this.editDraft = this.formField.getValue();
    this.disposeFormField();
    this.formError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
    this.createFormField(this.editDraft);
  }

  private acceptCompletedRow(id: string): void {
    if (typeof id !== "string" || id.length === 0) {
      return;
    }
    const entry = this.findItemEntry(id);
    if (entry !== undefined) {
      this.selectedEntryKey = entry.key;
      this.desiredSelectionId = undefined;
    } else {
      // Rows arrive through updateItems; keep the pending desire visible as
      // a cleared picker instead of a stale highlight on an older row.
      this.desiredSelectionId = id;
      this.selectedEntryKey = undefined;
    }
  }

  /**
   * Complete only the still-current deliberate exited-row intent: the pending
   * request must still match, the old row must still be a confirmed exit with
   * no owned process, and the replacement must be an actual live child
   * (lifecycle alive with a confirmed owned process). Anything else refuses
   * without selecting or changing focus.
   */
  completeRowResume(requestId: number, oldId: string, newId: string): boolean {
    const pending = this.pendingRowResume;
    if (!pending || pending.requestId !== requestId || pending.id !== oldId) return false;
    this.pendingRowResume = undefined;
    if (!this._visible || this._focus !== "sidebar" || this.selectedId !== oldId
      || !this.rowStore.some(item => item.id === oldId && item.lifecycle === "exited" && item.hasLiveProcess !== true)
      || !this.rowStore.some(item => item.id === newId && item.lifecycle === "alive" && item.hasLiveProcess === true)) return false;
    this.noticeError = undefined;
    this.select(newId);
    this._focus = "main";
    this.emit({ type: "select", id: newId });
    return true;
  }

  /**
   * Narrow resume-replacement fence: the backend is about to remove one old
   * exited placeholder after its replacement child actually started. The
   * following roster update must not read exactly that row's disappearance as
   * the user's highlight vanishing (which would pull focus back from a hidden
   * main pane and show the picker). Ordinary vanished-row safety and explicit
   * removals are unchanged.
   */
  noteRowReplacement(id: string): void {
    if (typeof id === "string" && id.length > 0 && this.rowStore.some((item) => item.id === id)) {
      this.replacedRowIds.add(id);
    }
  }

  /** Releases a replacement fence when the backend removal did not actually occur. */
  clearRowReplacement(id: string): void {
    this.replacedRowIds.delete(id);
  }

  failRowResume(requestId: number, message: string): void {
    if (this.pendingRowResume?.requestId !== requestId) return;
    this.pendingRowResume = undefined;
    if (this._visible && this._focus === "sidebar") this.noticeError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
  }

  private cancelRowResume(): void {
    const pending = this.pendingRowResume;
    this.pendingRowResume = undefined;
    if (pending) this.emit({ type: "resume-row-cancel", requestId: pending.requestId });
  }

  /**
   * Main-owned terminal diagnostics warning (#428). A defined view shows one
   * host-owned roster entry whose explicit activation clears exactly what was
   * displayed; undefined removes it. Never changes focus, the active Main
   * owner, visibility, or a sibling; a highlighted warning that disappears
   * leaves no selection rather than retargeting Enter.
   */
  setTerminalDiagnosticsWarning(view: TerminalDiagnosticsWarningView | undefined): void {
    this.diagnosticsWarning = view === undefined ? undefined : {
      count: Math.max(0, Math.trunc(view.count) || 0),
      throughCount: Math.max(0, Math.trunc(view.throughCount) || 0),
      logStatus: view.logStatus,
      ...(view.logFailure === undefined ? {} : { logFailure: view.logFailure }),
      failureNotice: view.failureNotice === true,
    };
    this.rebuildEntries();
    if (this.selectedEntryKey === ENTRY_DIAGNOSTICS_KEY && this.currentEntry() === undefined) {
      this.selectedEntryKey = undefined;
    }
  }

  /** Read-only view of the current terminal diagnostics warning (tests/Main). */
  get terminalDiagnosticsWarning(): TerminalDiagnosticsWarningView | undefined {
    return this.diagnosticsWarning === undefined ? undefined : { ...this.diagnosticsWarning };
  }

  // --- Network sidebar (pure DTO rendering; the coordinator owns all IO). ---

  /**
   * Attaches or replaces the coordinator's display snapshot. It never changes
   * visibility, focus, the highlighted entry, or the observed active Main
   * owner, so an incoming request can never steal focus, open a pane, or
   * retarget native content by arriving.
   */
  setPeerUiSnapshot(snapshot: PeerUiSnapshot): void {
    const next = copyPeerSnapshot(snapshot);
    this.peerUiSnapshot = next;
    if (this.peerBindDirty && next.settings !== null
      && next.settings.bindHost === this.peerBindHostDraft.trim()
      && (next.settings.bindPort === null ? "" : String(next.settings.bindPort)) === this.peerBindPortDraft.trim()) {
      // The coordinator now reports exactly the value this pane requested, so
      // the local draft is no longer unsaved.
      this.peerBindDirty = false;
    }
    if (!this.peerBindDirty) {
      this.peerBindHostDraft = sanitizeBounded(next.settings?.bindHost ?? "", PEER_ADDRESS_MAX_CODEPOINTS);
      this.peerBindPortDraft = next.settings?.bindPort === null || next.settings?.bindPort === undefined
        ? ""
        : String(next.settings.bindPort);
    }
    // Arrival is never authority: a latched request that ended (removed,
    // superseded, or past its human window) loses its frame and written proof.
    // Unrelated snapshot metadata deliberately leaves an unchanged frame alone.
    if (this.peerConsentLatch !== undefined
      && this.peerConsentPendingState(this.peerConsentLatch) !== "current") {
      this.invalidatePeerConsentDisplay();
      this.peerConsentLocalNotice = "This request is no longer pending; no decision was sent";
    }
    this.rebuildEntries();
    if (this.selectedEntryKey === ENTRY_PEER_KEY && this.currentEntry() === undefined) {
      this.selectedEntryKey = undefined;
    }
  }

  /**
   * Operator-initiated open of the network settings/status pane. It is the
   * only way the pane appears: an incoming request never opens it. With no
   * attached snapshot there is nothing to show and nothing happens.
   */
  openPeerMenu(): void {
    if (this.peerUiSnapshot === undefined) return;
    if (!this._visible) {
      this._visible = true;
      this.emit({ type: "visibility", visible: true });
    }
    this.forgetDisplayedRoster();
    this.disposeFormField();
    this.pendingCreate = undefined;
    this.pendingRename = undefined;
    this.pendingShortcutSave = undefined;
    this.pendingSavedOpen = undefined;
    this.editTarget = undefined;
    this.formKind = "peer";
    this.formError = undefined;
    this.noticeError = undefined;
    this.peerPaneError = undefined;
    this.peerPaneNotice = undefined;
    this.peerFieldTarget = undefined;
    this.peerConfirmDisplayed = false;
    this.peerRemoveTarget = undefined;
    this.peerRevokeTarget = undefined;
    this.invalidatePeerConsentDisplay();
    this.peerConsentLatch = undefined;
    this.peerConsentLocalNotice = undefined;
    this.confirmPurpose = "quit";
    this._focus = "form";
    this.onInvalidate?.();
  }

  /**
   * Captures the exact current complete consent candidate for Main's frame
   * writer. It returns undefined unless the whole identity and both decision
   * controls fit, the candidate was not superseded, and the request is still
   * pending inside its human window. Capturing authorizes nothing by itself.
   */
  capturePeerConsentPresentation(): PeerConsentPresentation | undefined {
    const display = this.peerConsentDisplay;
    if (display === undefined || !this.isPeerConsentRenderCurrent(display.token)) return undefined;
    return { consentId: display.consentId, decision: display.choice, renderToken: display.token };
  }

  /**
   * Whether this token still names the CURRENT complete consent frame: same
   * latched identity, same semantic decision, same geometry, still open and
   * pending. Superseded, dropped, too-small, expired, and retargeted frames
   * are never current.
   */
  isPeerConsentRenderCurrent(token: number): boolean {
    const display = this.peerConsentDisplay;
    const latch = this.peerConsentLatch;
    if (display === undefined || latch === undefined) return false;
    if (token !== display.token || !this.peerConsentRendered) return false;
    if (!this._visible || this._focus !== "confirm" || this.confirmPurpose !== "peer-consent") return false;
    if (this.peerConsentPendingState(latch) !== "current") return false;
    if (display.consentId !== latch.id || display.choice !== this.peerConsentChoice) return false;
    return display.identity === this.peerConsentFrameIdentity(
      latch,
      this.peerConsentChoice,
      display.cols,
      display.rows,
      display.approveRow,
      display.denyRow,
    );
  }

  /**
   * Trusted Main-only settlement: the actual writer reported this exact frame
   * as written. Until then Approve/Deny stay refused. A repeated settlement of
   * an unchanged, already-written frame is idempotent rather than a revoke.
   */
  settlePeerConsentRender(token: number): boolean {
    if (!this.isPeerConsentRenderCurrent(token)) return false;
    this.peerConsentWrittenToken = token;
    return true;
  }

  /**
   * Revokes the candidate frame and any written proof without touching the
   * latched request identity (the coordinator owns its lifecycle). Main calls
   * this when the writer cannot prove the bytes, when a semantically different
   * dialog target rendered identical bytes, and on any layout/target invalidation.
   */
  invalidatePeerConsentDisplay(): void {
    this.peerConsentDisplay = undefined;
    this.peerConsentRendered = false;
    this.peerConsentWrittenToken = undefined;
  }

  /**
   * The prominent pending-consent notification band for layouts where the
   * normal sidebar cannot show it (hidden pane, or narrow layout while Main is
   * focused). This is a notification surface only: it renders NO confirmation
   * control, mints no frame token, and neither grants nor revokes consent
   * authority, so a band that cannot show the complete identity still
   * authorizes nothing. Useful for the bounded 1..6 row bands the compositor
   * supplies; taller bands are padded, and short bands show the most important
   * complete lines with the review hint kept in view.
   */
  renderPeerAlert(
    cols: number,
    rows: number,
  ): { lines: string[]; cursor?: { column: number; row: number } } {
    assertPaneDimension(cols, PANE_MAX_COLS, "cols");
    assertPaneDimension(rows, PANE_MAX_ROWS, "rows");
    const consents = this.orderedPeerConsents();
    const oldest = consents[0];
    if (oldest === undefined) return { lines: [] };
    const heading = oldest.kind === "incoming"
      ? "! Incoming connection request"
      : "! Server key confirmation needed";
    const count = consents.length > 1 ? ` (${consents.length})` : "";
    const hint = consents.length > 1
      ? `open Network to review ${consents.length} pending requests`
      : "open Network or the sidebar to review before approving";
    const identityLines = [
      `name: ${sanitizeBounded(oldest.label, PEER_LABEL_MAX_CODEPOINTS)}`,
      `key: ${sanitizeBounded(oldest.fingerprint, PEER_FINGERPRINT_MAX_CODEPOINTS)}`,
      `from: ${oldest.endpoint === null
        ? "endpoint not provided"
        : sanitizeBounded(oldest.endpoint, PEER_ENDPOINT_MAX_CODEPOINTS)}`,
      this.peerConsentWindowText(oldest),
    ];
    const capacity = Math.min(rows, PEER_CONSENT_ALERT_ROWS);
    const lines: string[] = [];
    if (capacity === 1) {
      // A single row cannot show identity; it only points at the real review
      // surface. Nothing here can be approved.
      lines.push(wrapRow(`${heading}${count} — review`, cols, "\x1b[1m"));
    } else {
      lines.push(wrapRow(`${heading}${count}`, cols, "\x1b[1m"));
      for (const line of identityLines.slice(0, capacity - 2)) lines.push(wrapRow(line, cols));
      lines.push(wrapRow(hint, cols));
    }
    while (lines.length < rows) lines.push("");
    return { lines };
  }

  /** Shows a bounded, sanitized error near the pane's footer. */
  showError(message: string): void {
    this.noticeError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
  }

  /**
   * Capture the immutable draw-derived hit maps for one render. Main retains
   * this token beside the composed frame until the frame writer settles it;
   * later renders replace the controller's current maps without mutating this
   * presentation.
   */
  captureMousePresentation(): SidebarMousePresentation {
    const displayedRoster = this.displayedRoster;
    const displayedSavedRows = this.displayedSavedRows;
    const displayedPeerRows = this.peerDisplay;
    const displayedPeerConsent = this.peerConsentDisplay;
    return Object.freeze({
      authorizationKey: mouseAuthorizationKey(
        displayedRoster,
        displayedSavedRows,
        displayedPeerRows,
        displayedPeerConsent,
        this.peerConsentRendered,
      ),
      activateRosterAt: (column: number, row: number, cols: number, rows: number): boolean =>
        this.activateRosterAtFrom(displayedRoster, column, row, cols, rows, false),
      activateSavedAt: (column: number, row: number, cols: number, rows: number): boolean =>
        this.activateSavedAtFrom(displayedSavedRows, column, row, cols, rows),
    });
  }

  /**
   * Activates the exact roster entry whose complete row/card was drawn at this
   * pane-relative coordinate. Main consumes all other gestures in the visible
   * pane; this method never derives row positions independently of rendering.
   */
  activateRosterAt(column: number, row: number, cols: number, rows: number): boolean {
    return this.activateRosterAtFrom(this.displayedRoster, column, row, cols, rows, true);
  }

  private activateRosterAtFrom(
    shown: DisplayedRoster | undefined,
    column: number,
    row: number,
    cols: number,
    rows: number,
    requireCurrentSignature: boolean,
  ): boolean {
    if (!this._visible || (this._focus !== "main" && this._focus !== "sidebar")
      || !validHitGeometry(column, row, cols, rows)) return false;
    if (shown === undefined || (requireCurrentSignature
      && (shown.signature !== this.rosterSignature() || shown.focus !== this._focus))
      || shown.cols !== cols || shown.rows !== rows) return false;
    const region = [...shown.regions.values()].find((candidate) => row >= candidate.row
      && row < candidate.row + candidate.height);
    if (region === undefined || region.height !== this.entryHeight(region.entry)) return false;
    const current = this.entries.find((entry) => entry.key === region.entry.key);
    if (current === undefined || !sameSidebarEntry(current, region.entry)) return false;
    this.selectedEntryKey = current.key;
    this.desiredSelectionId = undefined;
    this.noticeError = undefined;
    // A mouse activation can originate while Main owns input. Exited-row
    // recovery is a sidebar-owned intent: move focus there before invoking the
    // existing resume guard so completeRowResume can validate the same request.
    if (current.kind === "item" && current.item?.lifecycle === "exited"
      && current.item.unavailable !== true && this.pendingRowResume === undefined
      && this._focus === "main") {
      this._focus = "sidebar";
    }
    this.activateEntry(region.entry);
    return true;
  }

  /** Activates a fully drawn saved row in the currently owned Saved pane. */
  activateSavedAt(column: number, row: number, cols: number, rows: number): boolean {
    return this.activateSavedAtFrom(this.displayedSavedRows, column, row, cols, rows);
  }

  private activateSavedAtFrom(
    shown: DisplayedSavedRows | undefined,
    column: number,
    row: number,
    cols: number,
    rows: number,
  ): boolean {
    if (!this._visible || this._focus !== "form" || this.formKind !== "saved"
      || !validHitGeometry(column, row, cols, rows)) return false;
    if (shown === undefined || shown.cols !== cols || shown.rows !== rows) return false;
    const displayed = shown.entries.find((candidate) => candidate.paneRow === row);
    if (displayed === undefined) return false;
    const currentIndex = this.savedRows.findIndex((candidate) => candidate.id === displayed.entry.id
      && candidate.file === displayed.entry.file);
    if (currentIndex < 0) return false;
    this.savedSelectedIndex = currentIndex;
    this.activateSavedRow();
    return true;
  }

  /** Dispatches one input chunk by current focus area. */
  handleInput(data: string): void {
    if (typeof data !== "string" || data.length === 0) {
      return;
    }
    switch (this._focus) {
      case "main":
        this.handleMainInput(data);
        break;
      case "sidebar":
        this.handleSidebarInput(data);
        break;
      case "form":
        this.handleFormInput(data);
        break;
      case "confirm":
        this.handleConfirmInput(data);
        break;
    }
  }

  /**
   * Renders only this pane at the supplied geometry. Hidden panes render
   * nothing; too-small panes get a bounded graceful message instead of a
   * broken layout. No resize is ever propagated to any backend.
   */
  render(
    cols: number,
    rows: number,
  ): { lines: string[]; cursor?: { column: number; row: number } } {
    assertPaneDimension(cols, PANE_MAX_COLS, "cols");
    assertPaneDimension(rows, PANE_MAX_ROWS, "rows");
    // A fresh frame starts with no settled consent-dialog authority; only a
    // complete render of the exact dialog can re-establish a candidate token.
    this.peerConsentRendered = false;
    if (!this._visible) {
      this.invalidateSavedDeleteConfirmationDisplay();
      return { lines: [] };
    }
    return this.renderForFocus(cols, rows);
  }

  /**
   * Renders the roster picker pane at the supplied geometry regardless of
   * focus. The wide layout shows it beside the New session form; hidden
   * visibility is decided by the compositor, not here.
   */
  renderRoster(cols: number, rows: number): { lines: string[] } {
    assertPaneDimension(cols, PANE_MAX_COLS, "cols");
    assertPaneDimension(rows, PANE_MAX_ROWS, "rows");
    this.peerConsentRendered = false;
    this.invalidateSavedDeleteConfirmationDisplay();
    if (cols < ROSTER_MIN_COLS || rows < ROSTER_MIN_ROWS) {
      return this.renderRosterTooSmall(cols, rows);
    }
    return this.renderRosterPane(cols, rows);
  }

  /**
   * Renders the New session form pane at the supplied geometry regardless of
   * focus. On wide terminals the compositor places it in the native pane's
   * rect; on narrow terminals it becomes the full-content overlay.
   */
  renderForm(cols: number, rows: number): { lines: string[]; cursor?: { column: number; row: number } } {
    assertPaneDimension(cols, PANE_MAX_COLS, "cols");
    assertPaneDimension(rows, PANE_MAX_ROWS, "rows");
    this.peerConsentRendered = false;
    this.invalidateSavedDeleteConfirmationDisplay();
    this.displayedSavedRows = undefined;
    // Only the network pane owns the displayed peer-row mapping; every other
    // form-slot pane forgets it so a stale map can never authorize an action.
    if (this.formKind !== "peer") this.peerDisplay = undefined;
    if (cols < FORM_MIN_COLS || rows < FORM_MIN_ROWS) {
      // An unshowable form-slot frame forgets the drawn network rows and
      // revokes any consent candidate/proof: nothing off-screen may act, and no
      // earlier receipt may be restored by a later render at the old geometry.
      this.peerDisplay = undefined;
      this.invalidatePeerConsentDisplay();
      return this.renderTooSmall(cols, rows);
    }
    if (this.peerConsentConfirmationActive) {
      // Wide hostConfirmation slot: the security-sensitive consent dialog is
      // placed in the right-hand pane while confirm focus is unchanged. The
      // roster render stays independent for the left-hand notice/rows.
      return this.renderPeerConsentPane(cols, rows);
    }
    if (this.formKind === "peer") {
      return this.renderPeerPane(cols, rows);
    }
    if (this.formKind === "peer-field") {
      return this.renderPeerFieldPane(cols, rows);
    }
    if (this.formKind === "saved") {
      return this.renderSavedPane(cols, rows);
    }
    if (this.formKind === "shortcuts") {
      return this.renderHostShortcutPane(cols, rows);
    }
    return this.renderFormPane(cols, rows);
  }

  /**
   * Renders only the Saved-file warning into Main's right-pane slot. The
   * roster render remains independent, and only a complete exact warning
   * produces the usual writer-settled confirmation token.
   */
  renderSavedDeleteConfirmation(cols: number, rows: number): { lines: string[] } {
    assertPaneDimension(cols, PANE_MAX_COLS, "cols");
    assertPaneDimension(rows, PANE_MAX_ROWS, "rows");
    this.peerConsentRendered = false;
    this.invalidateSavedDeleteConfirmationDisplay();
    if (!this.savedDeleteConfirmationActive) return { lines: [] };
    if (cols < ROSTER_MIN_COLS || rows < ROSTER_MIN_ROWS) return this.renderTooSmall(cols, rows);
    return this.renderSavedDeleteConfirmPane(cols, rows);
  }

  private renderForFocus(
    cols: number,
    rows: number,
  ): { lines: string[]; cursor?: { column: number; row: number } } {
    // In this focused-pane (narrow) path the form/picker/confirmation
    // replaces the roster on screen, even if a wide-layout renderRoster()
    // drew it earlier; standalone renderForm() keeps the wide roster record.
    if (this._focus === "form") {
      this.forgetDisplayedRoster();
      return this.renderForm(cols, rows);
    }
    if (this._focus === "confirm") {
      this.forgetDisplayedRoster();
      if (cols < ROSTER_MIN_COLS || rows < ROSTER_MIN_ROWS) {
        this.stopConfirmDisplayed = false;
        this.peerConfirmDisplayed = false;
        this.invalidateSavedDeleteConfirmationDisplay();
        this.invalidatePeerConsentDisplay();
        return this.renderTooSmall(cols, rows);
      }
      return this.renderConfirmPane(cols, rows);
    }
    this.invalidateSavedDeleteConfirmationDisplay();
    if (cols < ROSTER_MIN_COLS || rows < ROSTER_MIN_ROWS) {
      return this.renderRosterTooSmall(cols, rows);
    }
    return this.renderRosterPane(cols, rows);
  }

  /** Consumes every matcher-recognized toggle event; only initial presses act. */
  private handleReservedToggle(data: string, beforePress?: () => void): boolean {
    let consumedClaim = false;
    for (const key of [...this.claimedToggleKeys]) {
      const event = hostKeyEventType(data, key);
      if (event === undefined) continue;
      if (event !== "repeat") this.claimedToggleKeys.delete(key);
      if (event === "repeat" || event === "release") consumedClaim = true;
    }
    if (consumedClaim) return true;

    const eventType = hostKeyEventType(data, this.toggleKey);
    if (eventType === undefined) return false;
    if (eventType === "press") {
      this.claimedToggleKeys.add(this.toggleKey);
      beforePress?.();
      this.toggle();
    }
    return true;
  }

  private emitForward(data: string): void {
    this.emit({ type: "forward", data });
  }

  /**
   * Fences the held Escape key that canceled only a host-owned form (New or
   * Edit) — or that the field consumed to dismiss its completion list —
   * across every focus domain until its release or a fresh Escape press.
   * Unrelated input does NOT clear the claim, so a later repeat/release of the
   * still-held key is consumed (never a roster hide or child input) wherever
   * focus lands. Returns true when the event was consumed by the fence.
   */
  private consumeFormEscapeClaim(data: string): boolean {
    if (!this.formEscapeClaimed) return false;
    if (matchesKey(data, "escape")) {
      if (isKeyRelease(data)) { this.formEscapeClaimed = false; return true; }
      if (isKeyRepeat(data)) return true; // consume the held-key repeat
      // A fresh Escape press ends the fence; let it proceed to the normal handler.
      this.formEscapeClaimed = false;
      return false;
    }
    // Unrelated input does not clear the claim; only the Escape release or a
    // fresh Escape press ends the fence.
    return false;
  }

  /**
   * Fences the held submit key whose fresh press submitted the New form or
   * opened a saved conversation. Once that success transferred ownership to
   * the new child, the same key's repeat/release is consumed instead of being
   * replayed into the child; a later fresh press of that key in Main is
   * ordinary native input and is forwarded. The matcher follows the native
   * field's configured submit binding. Returns true when the event was
   * consumed.
   */
  private consumeFormSubmitClaim(data: string): boolean {
    const claimed = this.formSubmitClaim;
    if (claimed === undefined || !claimed(data)) return false;
    if (isKeyRelease(data)) { this.formSubmitClaim = undefined; return true; }
    if (isKeyRepeat(data)) return true; // consume the held-key repeat
    this.formSubmitClaim = undefined; // a fresh press is ordinary native input
    return false;
  }

  /** Consume repeats/releases for host-claimed return chords across rebinding. */
  private consumeClaimedReturnChord(data: string): boolean {
    let consumed = false;
    for (const key of [...this.claimedReturnToMainKeys]) {
      const event = hostKeyEventType(data, key);
      if (event === undefined) continue;
      if (event === "repeat") consumed = true;
      else this.claimedReturnToMainKeys.delete(key); // release or fresh press
      if (event === "release") consumed = true;
    }
    return consumed;
  }

  private claimReturnToMainChord(): void {
    this.claimedReturnToMainKeys.add(this.returnToMainKey);
  }

  // --- Main focus: everything is forwarded unchanged except the toggle. ---

  private handleMainInput(data: string): void {
    if (this.consumeClaimedReturnChord(data)) return;
    if (this.handleReservedToggle(data)) {
      return;
    }
    // A held Escape that canceled only a host-owned form must not leak into
    // the child as input, even after a focus change; its repeat/release is
    // consumed here until the key is released or freshly pressed again.
    if (this.consumeFormEscapeClaim(data)) {
      return;
    }
    if (this.consumeSavedActionClaim(data)) return;
    // The held Enter that submitted the New form or opened a saved
    // conversation must not replay its repeat/release into the newly focused
    // child after that success transferred ownership.
    if (this.consumeFormSubmitClaim(data)) {
      return;
    }
    // A fresh return chord in Main is ordinary native input; a claimed held
    // repeat or release was consumed by its original chord identity above.
    // Nonreserved releases and repeats are forwarded verbatim for the child
    // adapter to interpret under its own Kitty-protocol state.
    this.emitForward(data);
  }

  // --- Sidebar focus: roster navigation, New session, Quit host. ---

  private handleSidebarInput(data: string): void {
    // Bracketed paste is opaque in roster focus: a streamed body that merely
    // equals a host chord must not change focus or leak the remaining pasted
    // content into Main.
    if (this.routeBracketedPaste(data)) return;
    // Fence the held Escape that canceled only a host-owned form across focus
    // domains until its release or a fresh Escape press.
    if (this.consumeFormEscapeClaim(data)) return;
    if (this.consumeClaimedReturnChord(data)) return;
    // The reserved toggle takes precedence over the separate return chord.
    if (this.handleReservedToggle(data)) {
      return;
    }
    const returnEvent = hostKeyEventType(data, this.returnToMainKey);
    if (returnEvent !== undefined) {
      if (returnEvent === "release" || returnEvent === "repeat") return;
      this.claimReturnToMainChord();
      // A roster-only return never activates a row and is fenced by the exact
      // complete draw just like the existing Alt+Right action.
      if (!this.selectionFitsLastRoster()) return;
      this._focus = "main";
      this.onInvalidate?.();
      return;
    }
    if (this.consumeSavedActionClaim(data)) return;
    if (isKeyRelease(data)) {
      return;
    }
    if (matchesKey(data, "up")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "enter")) {
      // A held Enter never activates a roster entry — including a row that a
      // just-completed saved-open highlighted; only a fresh press does.
      if (isKeyRepeat(data)) return;
      // Never activate a target the last roster render could not show whole.
      if (!this.selectionFitsLastRoster()) return;
      this.activateEntry(this.selectedEntryKey === undefined
        ? undefined
        : this.displayedRoster?.regions.get(this.selectedEntryKey)?.entry);
      return;
    }
    if (matchesKey(data, "space") || printableOf(data) === " ") {
      // Space toggles only the highlighted card's own expansion; a held
      // Space does not flap it.
      if (!isKeyRepeat(data)) this.toggleSelectedExpansion();
      return;
    }
    if (matchesKey(data, "delete")) {
      // A held Delete/x never stops; only a deliberate initial press does.
      if (isKeyRepeat(data)) return;
      if (!this.selectionFitsLastRoster()) return;
      this.stopRemoveSelectedEntry();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.hide();
      return;
    }
    const printable = printableOf(data);
    if (printable === "d" || printable === "D") {
      // A held d never stops; only a deliberate initial press does.
      if (isKeyRepeat(data)) return;
      if (!this.selectionFitsLastRoster()) return;
      this.stopRemoveSelectedEntry();
      return;
    }
    if (printable === "e" || printable === "E") {
      if (!this.selectionFitsLastRoster()) return;
      this.editSelectedEntry();
      return;
    }
    if (printable === "n" || printable === "N") {
      // Explicit "no session displayed": a fresh press only, and it targets no
      // highlighted row, so it needs no draw fence. A held n never re-fires.
      if (isKeyRepeat(data)) return;
      this.detachLocalView();
      return;
    }
    if (printable === "q" || printable === "Q") {
      // Menu `q` is the same explicit Quit action as the Quit host row.
      this.activateQuit();
    }
  }

  private moveSelection(delta: number): void {
    this.cancelRowResume();
    if (this.entries.length === 0) {
      return;
    }
    const current = this.entries.findIndex((entry) => entry.key === this.selectedEntryKey);
    const nextIndex =
      current === -1
        ? delta > 0
          ? 0
          : this.entries.length - 1
        : (current + delta + this.entries.length) % this.entries.length;
    this.selectedEntryKey = this.entries[nextIndex]?.key;
    this.desiredSelectionId = undefined;
    this.noticeError = undefined;
  }

  private currentEntry(): SidebarEntry | undefined {
    return this.entries.find((entry) => entry.key === this.selectedEntryKey);
  }

  /** Flips the highlighted card between 5-line expanded and 3-line collapsed. */
  private toggleSelectedExpansion(): void {
    const entry = this.currentEntry();
    if (entry?.kind !== "item" || entry.item === undefined) {
      return;
    }
    const id = entry.item.id;
    if (this.collapsedItemIds.has(id)) {
      this.collapsedItemIds.delete(id);
    } else {
      this.collapsedItemIds.add(id);
    }
  }

  /** Rendered height of one entry: cards are 3 or 5 rows, actions 1 row. */
  private entryHeight(entry: SidebarEntry | undefined): number {
    if (entry?.kind === "diagnostics") return DIAGNOSTICS_ENTRY_ROWS;
    if (entry?.kind !== "item" || entry.item === undefined) {
      return 1;
    }
    return this.collapsedItemIds.has(entry.item.id) ? CARD_COLLAPSED_ROWS : CARD_EXPANDED_ROWS;
  }

  /**
   * True only when the highlighted entry was completely drawn by the last
   * roster render, at its current height (expansion state), with the same
   * entry order. With no highlighted entry there is nothing to activate (the
   * keys only produce a bounded notice), so that case is allowed.
   */
  private selectionFitsLastRoster(): boolean {
    const entry = this.currentEntry();
    if (entry === undefined) {
      return true;
    }
    const shown = this.displayedRoster;
    if (shown === undefined || shown.signature !== this.rosterSignature()) {
      return false;
    }
    return shown.heights.get(entry.key) === this.entryHeight(entry);
  }

  private rosterSignature(): string {
    return JSON.stringify(this.entries.map((entry) => entry.key));
  }

  /** The roster is no longer on screen (hidden or replaced by another pane). */
  private forgetDisplayedRoster(): void {
    this.cancelRowResume();
    this.displayedRoster = undefined;
  }

  /**
   * Activate the highlighted entry. `displayed` is the entry exactly as the
   * emitted roster drew it; display-fenced actions (the diagnostics clear) use
   * that snapshot so they act only on what the user saw.
   */
  private activateEntry(displayed?: SidebarEntry): void {
    const entry = this.currentEntry();
    if (entry === undefined) {
      return;
    }
    if (entry.kind === "diagnostics") {
      const shown = displayed?.kind === "diagnostics" ? displayed.warning : undefined;
      if (shown === undefined) return;
      this.cancelRowResume();
      this.noticeError = DIAGNOSTICS_CLEARED_NOTICE;
      this.emit({
        type: "terminal-diagnostics-clear",
        throughCount: shown.throughCount,
        failureShown: shown.failureNotice,
      });
      return;
    }
    if (entry.kind === "item" && entry.item !== undefined) {
      if (entry.item.unavailable === true) {
        // A remembered conversation that owns no process never becomes the Main
        // input owner: refusing here leaves focus and input ownership exactly
        // where they were instead of handing the child input to a sibling.
        this.noticeError = "This remembered conversation is unavailable; remove it to forget it";
        return;
      }
      if (entry.item.lifecycle === "exited") {
        if (this.pendingRowResume) { this.noticeError = "This conversation is already starting"; return; }
        const requestId = this.nextRequestId++;
        this.pendingRowResume = { requestId, id: entry.item.id };
        this.noticeError = "Opening this conversation";
        this.emit({ type: "resume-row", requestId, id: entry.item.id });
        return;
      }
      this.cancelRowResume();
      this.selectedEntryKey = entry.key;
      this.desiredSelectionId = undefined;
      // The sidebar stays visible; the typing room stays narrower until a
      // later hide. Only the select action is emitted.
      this._focus = "main";
      this.emit({ type: "select", id: entry.item.id });
      return;
    }
    if (entry.kind === "saved") {
      this.openSavedPane();
      return;
    }
    if (entry.kind === "new") {
      this.openNewForm();
      return;
    }
    if (entry.kind === "settings") {
      this.openHostShortcutForm();
      return;
    }
    if (entry.kind === "peer") {
      this.openPeerMenu();
      return;
    }
    this.activateQuit();
  }

  /**
   * `n`: display no session. Emits the local view detach, which retires only
   * this sidebar's content/input participation — no stop, removal, quit, roster
   * purge, or saved-conversation change — and cancels an in-flight exited-row
   * restart so its completion cannot display itself over the operator's choice.
   */
  private detachLocalView(): void {
    this.cancelRowResume();
    this.noticeError = undefined;
    this.emit({ type: "detach-view" });
  }

  private editSelectedEntry(): void {
    const entry = this.currentEntry();
    if (entry?.kind !== "item" || !entry.item) {
      this.noticeError = "Select a session row to edit its native name";
      return;
    }
    const nativeSession = entry.item.nativeSession;
    if (!nativeSession) {
      this.noticeError = "Native conversation name is unavailable until status is observed";
      return;
    }
    this.noticeError = undefined;
    this.emit({ type: "edit", id: entry.item.id, nativeSession: { ...nativeSession } });
  }

  /**
   * d / Delete: an exited row removes immediately; a settled error row without
   * a live process requests the same
   * deliberate removal (the manager stays authoritative and may still refuse);
   * a live owned process requests a stop — directly only when complete
   * idleness is positively observed, otherwise after explicit confirmation.
   * A row with no owned process and no confirmed exit is refused with a
   * bounded notice; nothing is faked or cancelled.
   */
  private stopRemoveSelectedEntry(): void {
    this.cancelRowResume();
    const entry = this.currentEntry();
    if (entry === undefined || entry.kind !== "item" || entry.item === undefined) {
      this.noticeError = "Select a session row to stop or remove";
      return;
    }
    const item = entry.item;
    if (item.lifecycle === "exited") {
      // Confirmed exit: plain removal; the backend stays authoritative.
      this.noticeError = undefined;
      this.emit({ type: "remove", id: item.id });
      return;
    }
    if (item.lifecycle === "error" && item.hasLiveProcess === false) {
      // Settled error row with no live process: the same deliberate removal
      // flow as an exited row. The error badge is not exit or force authority;
      // the manager decides whether it may actually be closed.
      this.noticeError = undefined;
      this.emit({ type: "remove", id: item.id });
      return;
    }
    if (item.hasLiveProcess !== true) {
      // No owned process to stop and no confirmed exit (starting, unspawned
      // error, or a live row without an observed handle): refuse truthfully.
      this.noticeError = "No owned process to stop";
      return;
    }
    if (isCompleteIdle(item)) {
      // Positively observed complete idleness: request the stop directly;
      // the parent revalidates fresh idle before acting.
      this.noticeError = undefined;
      this.emit({ type: "stop-remove", id: item.id, confirmed: false });
      return;
    }
    // Active or unknown: explicit confirmation with a frozen target id.
    this.openStopRemoveConfirmation(item.id);
  }

  private openStopRemoveConfirmation(id: string): void {
    this.forgetDisplayedRoster(); // the confirmation replaces the roster
    this.confirmPurpose = "stop-remove";
    this.stopRemoveTargetId = id; // frozen: later navigation never retargets
    this.stopConfirmDisplayed = false; // the warning must be drawn before a stop
    this._focus = "confirm";
  }

  /**
   * Cancel the stop confirmation: preserve the highlighted row and sidebar
   * input ownership, reset the purpose, send no native input, keep visible.
   */
  private cancelStopRemove(): void {
    this.confirmPurpose = "quit";
    this.stopRemoveTargetId = undefined;
    this.stopConfirmDisplayed = false;
    this._focus = "sidebar";
  }

  /**
   * Confirms the frozen stop target only while it still exists and is live
   * owned; a vanished or no-longer-live target is refused, never a sibling.
   */
  private confirmStopRemove(): void {
    const id = this.stopRemoveTargetId;
    this.confirmPurpose = "quit";
    this.stopRemoveTargetId = undefined;
    this.stopConfirmDisplayed = false;
    this._focus = "sidebar";
    if (id === undefined) return;
    const entry = this.findItemEntry(id);
    if (entry === undefined || entry.item === undefined) {
      this.noticeError = "Session no longer exists";
      return;
    }
    if (entry.item.hasLiveProcess !== true) {
      this.noticeError = "Session is no longer live";
      return;
    }
    this.emit({ type: "stop-remove", id, confirmed: true });
  }

  /**
   * Quit requires confirmation for starting/alive rows or any row whose
   * snapshot says the host still owns a live process. With none, the explicit
   * quit action is emitted immediately; no other key path quits the host.
   */
  private activateQuit(): void {
    this.cancelRowResume();
    const hasLive = this.rowStore.some(requiresQuitConfirmation);
    if (hasLive) {
      this.forgetDisplayedRoster(); // the confirmation replaces the roster
      this._focus = "confirm";
      return;
    }
    this.emit({ type: "quit" });
  }

  // --- Forms use the real public Editor adapter for every editable value. ---

  private handleFormInput(data: string): void {
    if (this.formKind === "saved") {
      this.handleSavedPaneInput(data);
      return;
    }
    if (this.formKind === "peer") {
      this.handlePeerPaneInput(data);
      return;
    }
    if (this.routeBracketedPaste(data)) {
      this.formField?.handleInput(data);
      return;
    }
    // Fence the held Escape that canceled only a host-owned form across focus
    // domains until its release or a fresh Escape press.
    if (this.consumeFormEscapeClaim(data)) return;
    if (this.consumeClaimedReturnChord(data)) return;
    if (this.handleReservedToggle(data, () => this.abandonForm())) return;
    // Host-owned form UI: the configured return chord never dismisses, submits, forwards to the
    // child, or steals ownership; it is consumed in every event form. An
    // initial press is claimed so its repeat/release stays fenced if a focus
    // change (e.g. the reserved toggle) happens while the key is still held;
    // the release clears the claim.
    const returnEvent = hostKeyEventType(data, this.returnToMainKey);
    if (returnEvent !== undefined) {
      if (returnEvent === "press") this.claimReturnToMainChord();
      return;
    }
    if (this.formKind === "shortcuts" && matchesKey(data, "tab")) {
      if (!isKeyRelease(data) && !isKeyRepeat(data)) this.switchShortcutField();
      return;
    }
    if (this.formKind === "peer-field" && matchesKey(data, "tab")) {
      if (!isKeyRelease(data) && !isKeyRepeat(data)) this.switchPeerField();
      return;
    }
    if (isKeyRelease(data)) return;
    // A held Escape's repeat never cancels a form: the press may have just
    // dismissed the native completion list, and its repeat must not then cancel
    // New or Edit, hide the roster, or reach the child. Only a fresh press
    // cancels; the field's own completion-list Escape precedence is intact.
    if (matchesKey(data, "escape") && isKeyRepeat(data)) return;
    if (this.pendingCreate || this.pendingRename || this.pendingShortcutSave) {
      // The configured cancel binding still abandons a pending New/Edit form;
      // a held repeat never cancels a pending Edit rename (existing rule).
      if (this.formMatchesCancel(data)
        && (this.formKind !== "edit" || !isKeyRepeat(data))) this.escapeFromForm();
      return;
    }
    // Claim every fresh, non-pasted form Escape BEFORE the field sees it: the
    // field may consume this press to dismiss its own native completion list
    // without cancelling, and the still-held key's repeat/release can arrive
    // after a reserved toggle, a focus change, or a completed create. Without
    // an early claim those later events would hide the roster or become child
    // input. The field still receives the press first, so its completion-list
    // precedence and the reserved-toggle priority are unchanged.
    if (matchesKey(data, "escape")) this.formEscapeClaimed = true;
    if (this.formField) {
      // Capture the exact canonical key id while the field synchronously
      // handles this packet, so a multi-binding submit fences the binding that
      // actually fired rather than the whole action matcher.
      this.formInputSubmitKey = this.formMatchesSubmit(data)
        ? parseKey(data) as KeyId | undefined
        : undefined;
      try {
        this.formField.handleInput(data);
      } finally {
        this.formInputSubmitKey = undefined;
      }
    } else if (matchesKey(data, "escape")) this.escapeFromForm();
  }

  /** Keep bracketed-paste chunks opaque to host actions; the native Editor still owns their contents. */
  private routeBracketedPaste(data: string): boolean {
    let owned = this.formPasteActive;
    let combined = this.formPasteCarry + data;
    this.formPasteCarry = "";

    for (;;) {
      const marker = this.formPasteActive ? BRACKETED_PASTE_END : BRACKETED_PASTE_START;
      const index = combined.indexOf(marker);
      if (index < 0) {
        const suffixLength = markerSuffixLength(combined, marker);
        this.formPasteCarry = suffixLength === 0 ? "" : combined.slice(-suffixLength);
        if (combined === "\x1b" && !owned) return false;
        return owned || suffixLength > 0;
      }
      owned = true;
      this.formPasteActive = !this.formPasteActive;
      combined = combined.slice(index + marker.length);
    }
  }




  // --- Saved-conversation picker (issue 323): deliberate, read-only. ---

  /**
   * Opens the saved-conversation picker in the form pane slot and requests a
   * fresh listing of the shared native catalog. Highlighting rows never
   * touches any running session; only an explicit Enter on a row emits a
   * saved-open action.
   */
  private openSavedPane(): void {
    this.forgetDisplayedRoster(); // narrow layouts overlay the roster
    this.disposeSavedQueryInput();
    this.disposeFormField();
    this.formKind = "saved";
    this.editTarget = undefined;
    this.pendingCreate = undefined;
    this.pendingRename = undefined;
    this.pendingShortcutSave = undefined;
    this.pendingSavedOpen = undefined;
    this.pendingSavedDeleteCheck = undefined;
    this.savedDeleteTarget = undefined;
    this.savedDeleteOperation = undefined;
    this.invalidateSavedDeleteConfirmationDisplay();
    this.formError = undefined;
    this.noticeError = undefined;
    this.savedRows = [];
    this.savedIssueCount = 0;
    this.savedError = undefined;
    this.savedSelectedIndex = 0;
    this.savedListTop = 0;
    this._focus = "form";
    this.displayedSavedRows = undefined;
    const requestId = this.nextRequestId++;
    this.savedPickerId = requestId;
    this.savedQueryRevision = 0;
    let inputNotice: string | undefined;
    try {
      this.savedQueryInput = this.createSavedQueryInput?.() ?? createDefaultSavedQueryInput();
    } catch {
      this.savedQueryInput = createDefaultSavedQueryInput();
      inputNotice = "Native query input is unavailable; using Pi's default keys";
    }
    this.savedQueryNotice = inputNotice ?? this.savedQueryInput.notice;
    this.pendingSavedList = { requestId };
    this.emit({ type: "saved-list", requestId });
  }

  /**
   * Dismisses the picker and restores the roster display. Cancelling an
   * outstanding listing only aborts that read; it never pauses, stops, or
   * rolls back any instance. A pending saved-open keeps running in the
   * backend; its late result is fenced by requestId.
   */
  private dismissSavedPane(): void {
    const pickerId = this.savedPickerId;
    if (pickerId !== undefined) this.emit({ type: "saved-dismiss", pickerId });
    if (this.pendingSavedList !== undefined) {
      this.emit({ type: "saved-cancel", requestId: this.pendingSavedList.requestId });
      this.pendingSavedList = undefined;
    }
    this.pendingSavedOpen = undefined; // UI ownership only; the backend op continues
    this.clearSavedPickerState();
    this.abandonForm();
    this.savedError = undefined;
    this.displayedSavedRows = undefined; // dismissal invalidates the display record
    this._focus = "sidebar";
  }

  private handleSavedPaneInput(data: string): void {
    // Bracketed paste is opaque in the picker and never activates a row; a
    // streamed body chunk that merely equals a host/native action must not
    // dismiss or delete. The native Input still owns paste insertion.
    if (this.routeBracketedPaste(data)) {
      this.feedSavedQueryInput(data);
      return;
    }
    // Fence the held Escape that canceled only a host-owned form across focus
    // domains until its release or a fresh Escape press.
    if (this.consumeFormEscapeClaim(data)) return;
    if (this.consumeClaimedReturnChord(data)) return;
    if (this.handleReservedToggle(data, () => this.dismissSavedPane())) return;
    // Host-owned picker UI: the configured return chord is consumed, never a row action. An
    // initial press is claimed so its repeat/release stays fenced across any
    // subsequent focus change while the key is still held; the release clears
    // the claim.
    const returnEvent = hostKeyEventType(data, this.returnToMainKey);
    if (returnEvent !== undefined) {
      if (returnEvent === "press") this.claimReturnToMainChord();
      return;
    }
    if (this.consumeSavedActionClaim(data)) return;
    if (isKeyRelease(data)) return;
    if (this.savedMatches(data, "tui.select.up")) {
      this.moveSavedSelection(-1);
      this.onInvalidate?.();
      return;
    }
    if (this.savedMatches(data, "tui.select.down")) {
      this.moveSavedSelection(1);
      this.onInvalidate?.();
      return;
    }
    // Suppress repeats of host actions while preserving native Input editing repeats.
    if (isKeyRepeat(data)) {
      const actionRepeat = this.savedMatches(data, "app.session.delete")
        || this.savedMatches(data, "tui.select.confirm")
        || this.savedMatches(data, "tui.select.cancel")
        || (this.savedQuery.length === 0
          && this.savedMatches(data, "app.session.deleteNoninvasive"));
      if (!actionRepeat) this.feedSavedQueryInput(data);
      return;
    }
    if (this.savedMatches(data, "app.session.delete")) {
      this.beginSavedDeleteCheck("app.session.delete");
      return;
    }
    if (this.savedMatches(data, "app.session.deleteNoninvasive")) {
      if (this.savedQuery.length === 0) this.beginSavedDeleteCheck("app.session.deleteNoninvasive");
      else this.feedSavedQueryInput(data);
      return;
    }
    if (this.savedMatches(data, "tui.select.confirm")) {
      this.activateSavedRow();
      return;
    }
    if (this.savedMatches(data, "tui.select.cancel")) {
      this.claimSavedAction(this.savedActionMatcher("tui.select.cancel"));
      if (matchesKey(data, "escape")) this.formEscapeClaimed = true;
      this.dismissSavedPane();
      return;
    }
    this.feedSavedQueryInput(data);
  }

  private savedMatches(data: string, action: SidebarSavedPickerAction): boolean {
    try {
      return this.savedQueryInput?.matches(data, action) ?? defaultSavedActionMatch(data, action);
    } catch {
      return false;
    }
  }

  private feedSavedQueryInput(data: string): void {
    const input = this.savedQueryInput;
    if (!input) return;
    const before = input.getValue();
    try { input.handleInput(data); } catch { return; }
    const after = input.getValue();
    if (after !== before) {
      this.displayedSavedRows = undefined;
      this.savedQueryRevision += 1;
      if (this.savedPickerId !== undefined) {
        this.emit({
          type: "saved-search",
          pickerId: this.savedPickerId,
          revision: this.savedQueryRevision,
          query: after,
        });
      }
    }
    this.onInvalidate?.();
  }

  private beginSavedDeleteCheck(action: "app.session.delete" | "app.session.deleteNoninvasive"): void {
    if (this.pendingSavedList !== undefined || this.pendingSavedOpen !== undefined
      || this.pendingSavedDeleteCheck !== undefined || this.savedDeleteTarget !== undefined) return;
    const row = this.savedRows[this.savedSelectedIndex];
    const shown = this.displayedSavedRows;
    const pickerId = this.savedPickerId;
    if (row === undefined || shown === undefined || pickerId === undefined
      || !shown.entries.some((entry) => entry.index === this.savedSelectedIndex && entry.entry === row)) return;
    const requestId = this.nextRequestId++;
    const context: SavedDeleteContext = Object.freeze({
      pickerId,
      requestId,
      id: row.id,
      file: row.file,
      revision: this.savedQueryRevision,
      row: Object.freeze({ ...row }),
    });
    this.pendingSavedDeleteCheck = context;
    this.displayedSavedRows = undefined;
    this.savedError = undefined;
    this.claimSavedAction(this.savedActionMatcher(action));
    this.emit({
      type: "saved-delete-prepare",
      pickerId,
      requestId,
      id: row.id,
      file: row.file,
      revision: this.savedQueryRevision,
    });
  }

  private claimSavedAction(matches: (data: string) => boolean): void {
    this.claimHeldAction(matches);
  }

  /** Bounded held-key fence shared by picker and network-consent actions. */
  private claimHeldAction(matches: (data: string) => boolean): void {
    this.savedActionClaims.push(matches);
    if (this.savedActionClaims.length > 8) this.savedActionClaims.splice(0, this.savedActionClaims.length - 8);
  }

  private savedActionMatcher(action: SidebarSavedPickerAction): (data: string) => boolean {
    const input = this.savedQueryInput;
    return input === undefined
      ? (data) => defaultSavedActionMatch(data, action)
      : (data) => input.matches(data, action);
  }

  private consumeSavedActionClaim(data: string): boolean {
    let consumed = false;
    for (const matches of [...this.savedActionClaims]) {
      let matched = false;
      try { matched = matches(data); } catch { /* malformed event is not a match */ }
      if (!matched) continue;
      if (isKeyRelease(data)) {
        this.savedActionClaims.splice(this.savedActionClaims.indexOf(matches), 1);
        consumed = true;
      } else if (isKeyRepeat(data)) {
        consumed = true;
      } else {
        this.savedActionClaims.splice(this.savedActionClaims.indexOf(matches), 1);
      }
    }
    return consumed;
  }

  private moveSavedSelection(delta: number): void {
    if (this.savedRows.length === 0) return;
    const current = this.savedSelectedIndex;
    this.savedSelectedIndex = (current + delta + this.savedRows.length) % this.savedRows.length;
  }

  /**
   * Deliberately opens the highlighted conversation. While a listing is still
   * in flight there is nothing to open; while an open is already pending the
   * row is not re-emitted.
   */
  private activateSavedRow(): void {
    if (this.pendingSavedList !== undefined) return;
    const row = this.savedRows[this.savedSelectedIndex];
    if (row === undefined) return;
    // Refuse to open a row the last valid picker render could not show whole:
    // a too-small fallback or an undrawn/hidden selection never opens.
    if (this.displayedSavedRows === undefined
      || !this.displayedSavedRows.entries.some((displayed) => displayed.index === this.savedSelectedIndex
        && displayed.entry === row)) return;
    if (this.pendingSavedOpen !== undefined) {
      this.savedError = "A saved conversation is already starting";
      return;
    }
    const requestId = this.nextRequestId++;
    this.pendingSavedOpen = { requestId };
    this.savedError = undefined;
    // Claim the fresh submit key that opened the saved conversation: its
    // repeat/release must not reach the newly focused native child after a
    // successful completion. The picker's open key is Enter.
    const confirmMatcher = this.savedActionMatcher("tui.select.confirm");
    this.formSubmitClaim = confirmMatcher;
    this.claimSavedAction(confirmMatcher);
    this.emit({ type: "saved-open", requestId, file: row.file, sessionId: row.id });
  }

  /**
   * Accepts one saved-conversation listing only while that request still owns
   * the pane. Stale completions (dismissed or superseded panes) are ignored
   * entirely and never seize a later-opened or dismissed UI.
   */
  completeSavedList(
    requestId: number,
    rows: readonly SidebarSavedRow[],
    issueCount: number,
    pickerId = requestId,
  ): boolean {
    if (this.pendingSavedList?.requestId !== requestId) return false; // stale: ignore
    if (this.savedPickerId !== pickerId || (this.formKind !== "saved" && this.confirmPurpose !== "saved-delete")) return false;
    this.pendingSavedList = undefined;
    this.savedRows = sanitizeSavedRows(rows);
    this.displayedSavedRows = undefined; // catalog replacement invalidates the display record
    this.savedIssueCount = Number.isSafeInteger(issueCount) && issueCount > 0 ? issueCount : 0;
    this.savedError = this.savedError ?? this.savedQueryNotice;
    if (this.savedSelectedIndex >= this.savedRows.length) this.savedSelectedIndex = Math.max(0, this.savedRows.length - 1);
    return true;
  }

  /** Replace picker rows only for the exact current private-catalog query revision. */
  completeSavedSearch(pickerId: number, revision: number, rows: readonly SidebarSavedRow[]): boolean {
    if (this.savedPickerId !== pickerId || this.savedQueryRevision !== revision
      || this.formKind !== "saved" || this.pendingSavedList !== undefined) return false;
    const accepted = sanitizeSavedRows(rows);
    this.displayedSavedRows = undefined;
    this.savedRows = accepted;
    if (this.savedSelectedIndex >= this.savedRows.length) this.savedSelectedIndex = Math.max(0, this.savedRows.length - 1);
    this.onInvalidate?.();
    return true;
  }

  /** Shows a bounded, truthful unavailable notice for a failed listing. */
  failSavedList(requestId: number, message: string): void {
    if (this.pendingSavedList?.requestId !== requestId) return; // stale: ignore
    this.pendingSavedList = undefined;
    this.savedError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
    this.displayedSavedRows = undefined;
  }

  /**
   * Completes a deliberate saved-open. A successful explicit Saved submission
   * activates the restored child as the Main input owner without a second
   * host-row Enter (the pane stays visible exactly as it was); the new row is
   * highlighted only while the request still owns the open pane. Late
   * completions never steal ownership or visibility.
   */
  completeSavedOpen(requestId: number, id: string): void {
    if (this.pendingSavedOpen?.requestId !== requestId) return; // stale: ignore
    this.pendingSavedOpen = undefined;
    if (this._focus === "form" && this.formKind === "saved") {
      this.savedError = undefined;
      if (this.savedPickerId !== undefined) this.emit({ type: "saved-dismiss", pickerId: this.savedPickerId });
      this.clearSavedPickerState();
      this.displayedSavedRows = undefined;
      this.disposeFormField();
      this.formKind = undefined;
      this.acceptCompletedRow(id);
      this._focus = "main";
      this.emit({ type: "select", id });
    }
  }

  /** Shows a bounded refusal/failure notice while the picker still owns the pane. */
  failSavedOpen(requestId: number, message: string): void {
    if (this.pendingSavedOpen?.requestId !== requestId) return; // stale: ignore
    this.pendingSavedOpen = undefined;
    if (this._focus === "form" && this.formKind === "saved") {
      this.savedError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
    }
  }

  private clearSavedPickerState(): void {
    this.disposeSavedQueryInput();
    this.savedPickerId = undefined;
    this.savedQueryRevision = 0;
    this.savedQueryNotice = undefined;
    this.savedRows = [];
    this.savedIssueCount = 0;
    this.savedSelectedIndex = 0;
    this.savedListTop = 0;
    this.pendingSavedDeleteCheck = undefined;
    this.savedDeleteTarget = undefined;
    this.savedDeleteOperation = undefined;
    this.invalidateSavedDeleteConfirmationDisplay();
    this.confirmPurpose = "quit";
  }

  private disposeSavedQueryInput(): void {
    const input = this.savedQueryInput;
    this.savedQueryInput = undefined;
    try { input?.dispose(); } catch { /* private query text is discarded even if UI cleanup fails */ }
  }

  private openNewForm(): void {
    this.forgetDisplayedRoster(); // narrow layouts overlay the roster
    this.disposeFormField();
    this.formKind = "new";
    this.editTarget = undefined;
    this.pendingCreate = undefined;
    this.pendingRename = undefined;
    this.pendingShortcutSave = undefined;
    this.formError = undefined;
    this._focus = "form";
    this.createFormField(this.workspaceDraft);
  }

  private openHostShortcutForm(): void {
    this.forgetDisplayedRoster();
    this.disposeFormField();
    this.pendingCreate = undefined;
    this.pendingRename = undefined;
    this.pendingShortcutSave = undefined;
    this.formKind = "shortcuts";
    this.editTarget = undefined;
    this.shortcutDraft = { ...this.configuredShortcuts };
    this.shortcutFieldIndex = 0;
    this.formError = undefined;
    this.noticeError = undefined;
    this._focus = "form";
    this.createFormField(this.shortcutDraft.toggle);
  }

  /** Apply a completed atomic Save without changing focus or session ownership. */
  completeHostShortcutSave(requestId: number, bindings: HostShortcutBindings): boolean {
    if (this.pendingShortcutSave?.requestId !== requestId || this.formKind !== "shortcuts") return false;
    const configured = normalizeHostShortcutBindings(bindings);
    const effectiveToggle = this.legacyToggleOverride ? this.toggleKey : configured.toggle;
    assertHostShortcutsDistinct(effectiveToggle, configured.returnToMain);
    this.pendingShortcutSave = undefined;
    this.configuredShortcuts = configured;
    if (!this.legacyToggleOverride) {
      this.toggleKey = configured.toggle;
      this.toggleLabel = toggleDisplayName(configured.toggle);
    }
    this.returnToMainKey = configured.returnToMain;
    this.returnToMainLabel = toggleDisplayName(configured.returnToMain);
    this.shortcutDraft = { ...configured };
    this.disposeFormField();
    this.formKind = undefined;
    this.formError = undefined;
    this._focus = "sidebar";
    this.onInvalidate?.();
    return true;
  }

  /** A refused validation/write leaves the same editor open and the active chords unchanged. */
  failHostShortcutSave(requestId: number, message: string): void {
    if (this.pendingShortcutSave?.requestId !== requestId || this.formKind !== "shortcuts") return;
    this.pendingShortcutSave = undefined;
    this.formError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
    this.createFormField(this.shortcutFieldIndex === 0 ? this.shortcutDraft.toggle : this.shortcutDraft.returnToMain);
    this.onInvalidate?.();
  }

  private switchShortcutField(): void {
    if (this.formKind !== "shortcuts" || this.pendingShortcutSave !== undefined) return;
    if (this.shortcutFieldIndex === 0) this.shortcutDraft.toggle = this.formField?.getValue() ?? this.shortcutDraft.toggle;
    else this.shortcutDraft.returnToMain = this.formField?.getValue() ?? this.shortcutDraft.returnToMain;
    this.shortcutFieldIndex = this.shortcutFieldIndex === 0 ? 1 : 0;
    this.formError = undefined;
    this.createFormField(this.shortcutFieldIndex === 0 ? this.shortcutDraft.toggle : this.shortcutDraft.returnToMain);
  }

  private submitHostShortcutForm(): void {
    if (this.formKind !== "shortcuts" || this.pendingShortcutSave !== undefined) return;
    if (this.shortcutFieldIndex === 0) this.shortcutDraft.toggle = this.formField?.getValue() ?? this.shortcutDraft.toggle;
    else this.shortcutDraft.returnToMain = this.formField?.getValue() ?? this.shortcutDraft.returnToMain;
    let bindings: HostShortcutBindings;
    try {
      bindings = normalizeHostShortcutBindings(this.shortcutDraft);
      const effectiveToggle = this.legacyToggleOverride ? this.toggleKey : bindings.toggle;
      assertHostShortcutsDistinct(effectiveToggle, bindings.returnToMain);
    } catch (error) {
      this.formError = sanitizeBounded(error instanceof Error ? error.message : "Shortcut settings are invalid", ERROR_TEXT_MAX_CODEPOINTS);
      this.createFormField(this.shortcutFieldIndex === 0 ? this.shortcutDraft.toggle : this.shortcutDraft.returnToMain);
      this.onInvalidate?.();
      return;
    }
    const requestId = this.nextRequestId++;
    this.pendingShortcutSave = { requestId };
    this.formError = undefined;
    this.emit({ type: "host-shortcuts-save", requestId, bindings });
  }

  private createFormField(initialText: string): void {
    this.disposeFormField();
    // Network listen/destination fields are plain data, never filesystem
    // paths: they use the bounded single-line name field, not the path
    // completer, so nothing is resolved or rewritten.
    const kind = this.formKind === "edit" || this.formKind === "shortcuts"
      || this.formKind === "peer-field"
      ? "name"
      : "path";
    const generation = this.formGeneration;
    const fieldOptions: SidebarFieldFactoryOptions = {
      kind,
      initialText,
      onInvalidate: () => {
        if (generation === this.formGeneration) this.onInvalidate?.();
      },
      onSubmit: (submission) => {
        if (generation !== this.formGeneration) return;
        if (this.formKind === "edit") this.submitRename(submission);
        else if (this.formKind === "new") this.submitCreate(submission);
        else if (this.formKind === "shortcuts") this.submitHostShortcutForm();
        else if (this.formKind === "peer-field") this.submitPeerField(submission);
      },
      onCancel: () => {
        if (generation === this.formGeneration) this.escapeFromForm();
      },
      onReject: (reason) => {
        if (generation === this.formGeneration) {
          this.formError = fieldRejectionNotice(reason);
          this.onInvalidate?.();
        }
      },
    };
    try {
      const created: SidebarFieldFactoryResult = this.createTextField
        ? this.createTextField(fieldOptions)
        : {
          field: kind === "path"
            ? createSessionHostTextField({
              kind: "path", initialText, workspaceBasePath: this.workspaceBasePath,
              onInvalidate: fieldOptions.onInvalidate, onSubmit: fieldOptions.onSubmit,
              onCancel: fieldOptions.onCancel, onReject: fieldOptions.onReject,
            })
            : createSessionHostTextField({
              kind: "name", initialText, onInvalidate: fieldOptions.onInvalidate,
              onSubmit: fieldOptions.onSubmit, onCancel: fieldOptions.onCancel,
              onReject: fieldOptions.onReject,
            }),
        };
      this.formField = created.field;
      this.formMatchesCancel = created.matchesCancel ?? ((data) => matchesKey(data, "escape"));
      this.formMatchesSubmit = created.matchesSubmit ?? ((data) => matchesKey(data, "enter"));
      this.formHints = created.hints ?? DEFAULT_FORM_HINTS;
      this.formNotice = created.notice
        ? sanitizeBounded(created.notice, ERROR_TEXT_MAX_CODEPOINTS)
        : undefined;
    } catch {
      this.formField = undefined;
      this.formError = "Session host field could not be opened";
    }
    this.onInvalidate?.();
  }

  private disposeFormField(): void {
    this.formGeneration += 1;
    try { this.formField?.dispose(); } catch { /* independent field cleanup */ }
    this.formField = undefined;
    this.formMatchesCancel = (data) => matchesKey(data, "escape");
    this.formMatchesSubmit = (data) => matchesKey(data, "enter");
    this.formPasteActive = false;
    this.formPasteCarry = "";
    this.formHints = DEFAULT_FORM_HINTS;
    this.formNotice = undefined;
  }

  private submitCreate(submission: SessionHostFieldSubmission): void {
    if (this.pendingCreate || this.formKind !== "new") return;
    const workspace = submission.value;
    if (workspace.length === 0) {
      this.formError = "Workspace is required";
      this.workspaceDraft = "";
      this.createFormField("");
      return;
    }
    if (sanitizeCellText(workspace) !== workspace || countCodePoints(workspace) > PATH_FIELD_MAX_CODEPOINTS) {
      this.formError = `Path exceeds ${PATH_FIELD_MAX_CODEPOINTS} characters or contains unsafe text`;
      this.workspaceDraft = this.formField?.getValue() ?? "";
      this.createFormField(this.workspaceDraft);
      return;
    }
    this.workspaceDraft = workspace;
    const requestId = this.nextRequestId++;
    this.pendingCreate = { requestId };
    this.formError = undefined;
    // Claim only the exact submit key that fired this submission: its
    // repeat/release must not reach the newly focused native child after a
    // successful completion, while any other configured submit binding stays
    // ordinary input. The captured key survives the field teardown.
    const submitKey = this.formInputSubmitKey;
    this.formSubmitClaim = submitKey === undefined
      ? undefined
      : (data: string) => matchesKey(data, submitKey);
    this.emit({ type: "create", requestId, workspace });
  }

  private submitRename(submission: SessionHostFieldSubmission): void {
    if (this.pendingRename || this.formKind !== "edit" || !this.editTarget) return;
    const name = submission.value;
    if (!isValidRenameName(name)) {
      this.formError = submission.value.length === 0 ? "New name is required" : "New name must be valid and at most 1024 UTF-8 bytes";
      this.editDraft = name;
      this.createFormField(name);
      return;
    }
    const requestId = this.nextRequestId++;
    this.pendingRename = { requestId };
    this.editDraft = name;
    this.formError = undefined;
    this.emit({
      type: "rename", requestId, id: this.editTarget.id,
      expectedSessionId: this.editTarget.nativeSession.sessionId,
      expectedSessionEpoch: this.editTarget.nativeSession.epoch, name,
    });
  }

  private escapeFromForm(): void {
    if (this.formKind === "peer-field") {
      // A cancelled listen/destination draft returns to the network pane. The
      // held Escape is claimed so its repeat/release cannot hide the roster.
      this.formEscapeClaimed = true;
      this.closePeerFieldForm();
      return;
    }
    this.abandonForm();
    // New and Edit cancellations are both LOCAL: return to the VISIBLE roster
    // without hiding and without forwarding anything to the child. The active
    // Main owner, native process, native input draft, persisted name,
    // selection, and geometry are all preserved; abandonForm retains the
    // workspace/name draft. Claim the Escape so a held key's repeat/release
    // does not bubble into the roster's Escape-hide or leak into the child as
    // native input; a fresh roster Escape still hides (existing semantics).
    this.formEscapeClaimed = true;
    this._focus = "sidebar";
    this.onInvalidate?.();
  }

  private abandonForm(): void {
    if (this.formKind === "new" && this.formField) this.workspaceDraft = this.formField.getValue();
    if (this.formKind === "edit" && this.formField) this.editDraft = this.formField.getValue();
    if (this.formKind === "shortcuts" && this.formField) {
      if (this.shortcutFieldIndex === 0) this.shortcutDraft.toggle = this.formField.getValue();
      else this.shortcutDraft.returnToMain = this.formField.getValue();
    }
    this.pendingCreate = undefined;
    this.pendingRename = undefined;
    this.pendingShortcutSave = undefined;
    this.peerFieldTarget = undefined;
    this.disposeFormField();
    this.formKind = undefined;
    this.editTarget = undefined;
  }

  // --- Confirm focus: explicit quit or stop confirmation. ---

  private handleConfirmInput(data: string): void {
    // Streamed bracketed paste is opaque in the network dialogs: a pasted body
    // chunk that merely equals Enter/y can never approve a settled consent
    // frame, remove a destination, or revoke a receiving grant. Only the new
    // network confirmations take this route; existing confirmation semantics
    // are unchanged.
    if ((this.confirmPurpose === "peer-consent"
      || this.confirmPurpose === "peer-remove"
      || this.confirmPurpose === "peer-revoke")
      && this.routeBracketedPaste(data)) return;
    // Fence the held Escape that canceled only a host-owned form across focus
    // domains until its release or a fresh Escape press.
    if (this.consumeFormEscapeClaim(data)) return;
    if (this.consumeClaimedReturnChord(data)) return;
    // The reserved toggle takes precedence over the separate return chord.
    if (this.handleReservedToggle(data, () => {
      if (this.confirmPurpose === "saved-delete") this.dismissSavedPane();
    })) {
      return;
    }
    const returnEvent = hostKeyEventType(data, this.returnToMainKey);
    if (returnEvent !== undefined) {
      if (returnEvent === "press") this.claimReturnToMainChord();
      return;
    }
    if (this.consumeSavedActionClaim(data)) return;
    if (isKeyRelease(data)) {
      return;
    }
    if (this.confirmPurpose === "saved-delete") {
      this.handleSavedDeleteConfirmInput(data);
      return;
    }
    if (this.confirmPurpose === "peer-consent") {
      this.handlePeerConsentInput(data);
      return;
    }
    if (this.confirmPurpose === "peer-remove" || this.confirmPurpose === "peer-revoke") {
      this.handlePeerConfirmInput(data);
      return;
    }
    if (this.confirmPurpose === "stop-remove") {
      this.handleStopRemoveConfirmInput(data);
      return;
    }
    if (matchesKey(data, "escape")) {
      // Cancel the confirmation and restore the main frame.
      this._focus = "sidebar";
      this.hide();
      return;
    }
    if (matchesKey(data, "enter")) {
      this.confirmQuit();
      return;
    }
    const printable = printableOf(data);
    if (printable === "y" || printable === "Y") {
      this.confirmQuit();
      return;
    }
    if (printable === "n" || printable === "N") {
      this._focus = "sidebar";
    }
  }

  private handleSavedDeleteConfirmInput(data: string): void {
    if (this.consumeSavedActionClaim(data)) return;
    if (isKeyRepeat(data) || isKeyRelease(data)) return;
    if (this.savedMatches(data, "tui.select.cancel")) {
      this.claimSavedAction(this.savedActionMatcher("tui.select.cancel"));
      if (matchesKey(data, "escape")) this.formEscapeClaimed = true;
      this.cancelSavedDeleteConfirmation();
      return;
    }
    if (!this.savedDeleteConfirmationDisplayed || !this.savedMatches(data, "tui.select.confirm")) return;
    const target = this.savedDeleteTarget;
    if (!target || this.savedPickerId !== target.pickerId) return;
    this.savedDeleteOperation = target;
    this.claimSavedAction(this.savedActionMatcher("tui.select.confirm"));
    this.emit({
      type: "saved-delete",
      pickerId: target.pickerId,
      requestId: target.requestId,
      id: target.id,
      file: target.file,
      revision: target.revision,
    });
  }

  private cancelSavedDeleteConfirmation(): void {
    this.savedDeleteTarget = undefined;
    this.savedDeleteOperation = undefined;
    this.invalidateSavedDeleteConfirmationDisplay();
    this.confirmPurpose = "quit";
    this._focus = "form";
    this.onInvalidate?.();
  }

  /**
   * Stop confirmation: deliberate initial presses only. Confirm acts on the
   * frozen target id; cancel keeps the highlighted row and sidebar input
   * ownership without sending any native input or hiding the pane.
   */
  private handleStopRemoveConfirmInput(data: string): void {
    // Held keys never confirm or cancel twice; releases are already consumed.
    if (isKeyRepeat(data)) return;
    if (matchesKey(data, "escape")) {
      this.cancelStopRemove();
      return;
    }
    const printable = printableOf(data);
    if (printable === "n" || printable === "N") {
      // Cancellation stays available even while the warning is not displayed.
      this.cancelStopRemove();
      return;
    }
    // A stop is only confirmable while the complete warning is on screen.
    if (!this.stopConfirmDisplayed) return;
    if (matchesKey(data, "enter")) {
      this.confirmStopRemove();
      return;
    }
    if (printable === "y" || printable === "Y") {
      this.confirmStopRemove();
    }
  }

  private confirmQuit(): void {
    this._focus = "sidebar";
    this.emit({ type: "quit" });
  }

  // --- Network pane, incoming consent, and metadata-only remote rows. ---

  /** Pending requests, oldest first, bounded; ordering never latches a target. */
  private orderedPeerConsents(): readonly PeerUiConsent[] {
    const consents = this.peerUiSnapshot?.consents ?? [];
    return [...consents]
      .sort((left, right) => left.requestedAt - right.requestedAt || left.id.localeCompare(right.id))
      .slice(0, PEER_MAX_CONSENTS);
  }

  private peerPendingConsentCount(): number {
    return this.peerUiSnapshot?.consents.length ?? 0;
  }

  /**
   * The latched request's live state, re-derived from the current snapshot.
   * A removed request or any changed identity fact ends this latch; expiry is
   * decided by the injected clock, never assumed.
   */
  private peerConsentPendingState(latch: PeerConsentLatch): "current" | "ended" | "expired" {
    const pending = this.peerUiSnapshot?.consents.find((consent) => consent.id === latch.id);
    if (pending === undefined) return "ended";
    if (pending.kind !== latch.kind || pending.label !== latch.label
      || pending.fingerprint !== latch.fingerprint
      || pending.endpoint !== latch.endpoint
      || pending.expiresAt !== latch.expiresAt) return "ended";
    const now = this.now();
    if (!Number.isFinite(now) || now >= latch.expiresAt) return "expired";
    return "current";
  }

  /**
   * The exact semantic target identity: latched request facts + decision + pane
   * geometry + decision-control rows. Unrelated snapshot metadata is
   * deliberately absent, so an unchanged dialog keeps its token and its written
   * proof, while a moved control can never keep the old target mapping.
   */
  private peerConsentFrameIdentity(
    latch: PeerConsentLatch,
    choice: "approve" | "deny",
    cols: number,
    rows: number,
    approveRow: number,
    denyRow: number,
  ): string {
    return JSON.stringify([
      latch.id, latch.kind, latch.label, latch.fingerprint, latch.endpoint,
      latch.expiresAt, choice, cols, rows, approveRow, denyRow,
    ]);
  }

  /** Full frame bytes are part of the token identity as well. */
  private peerConsentFrameKey(identity: string, lines: readonly string[]): string {
    return `${identity}\n${lines.join("\n")}`;
  }

  private peerConsentWindowText(latch: PeerConsentLatch): string {
    const remaining = latch.expiresAt - this.now();
    if (!Number.isFinite(remaining) || remaining <= 0) return "approval window: ended";
    return `approval window: ${Math.max(1, Math.ceil(remaining / 1000))}s remaining`;
  }

  /**
   * Latches ONE request's immutable identity. A later request never replaces
   * this dialog in place; it can only be opened after this view is closed.
   */
  private openPeerConsentReview(consent: PeerUiConsent): void {
    if (this.peerUiSnapshot === undefined) return;
    this.forgetDisplayedRoster();
    this.disposeFormField();
    this.pendingCreate = undefined;
    this.pendingRename = undefined;
    this.pendingShortcutSave = undefined;
    this.pendingSavedOpen = undefined;
    this.formKind = undefined;
    this.peerDisplay = undefined;
    this.peerConfirmDisplayed = false;
    this.peerRemoveTarget = undefined;
    this.peerRevokeTarget = undefined;
    this.peerConsentLatch = Object.freeze({
      id: consent.id,
      kind: consent.kind,
      label: consent.label,
      fingerprint: consent.fingerprint,
      endpoint: consent.endpoint,
      requestedAt: consent.requestedAt,
      expiresAt: consent.expiresAt,
    });
    this.peerConsentChoice = "deny";
    this.peerConsentLocalNotice = undefined;
    this.invalidatePeerConsentDisplay();
    this.confirmPurpose = "peer-consent";
    this._focus = "confirm";
    this.onInvalidate?.();
  }

  /**
   * Closes the view without inventing any decision. The coordinator still owns
   * the request lifecycle; the persistent alert keeps showing it while pending.
   */
  private dismissPeerConsentReview(): void {
    this.peerConsentLatch = undefined;
    this.peerConsentLocalNotice = undefined;
    this.invalidatePeerConsentDisplay();
    this.confirmPurpose = "quit";
    this._focus = "sidebar";
    this.onInvalidate?.();
  }

  /**
   * Complete consent dialog: the full identity and both decision controls must
   * fit. A too-small frame mints no candidate token, so nothing can be approved
   * or denied from a partial or invisible presentation.
   */
  private renderPeerConsentPane(cols: number, rows: number): { lines: string[] } {
    // A frame that cannot show the complete identity and both controls is a
    // dropped frame: it revokes the candidate token and any written proof so
    // neither a smaller render nor a later re-render can inherit authority.
    const tooSmall = (): { lines: string[] } => {
      this.invalidatePeerConsentDisplay();
      return this.renderTooSmall(cols, rows);
    };
    const latch = this.peerConsentLatch;
    if (latch === undefined) return tooSmall();
    const incoming = latch.kind === "incoming";
    const header = incoming ? " Approve incoming connection? " : " Trust this server key? ";
    const identity: ReadonlyArray<readonly [string, string]> = [
      ["name", latch.label],
      ["key", latch.fingerprint],
      ["from", latch.endpoint === null ? "endpoint not provided" : latch.endpoint],
    ];
    const identityLines: string[] = [];
    for (const [label, value] of identity) {
      // Never ellipsize identity: an unshowable label/key/endpoint is too small.
      const wrapped = wrapExactField(`${label}: ${sanitizeCellText(value)}`, cols, 4);
      if (wrapped === undefined) return tooSmall();
      identityLines.push(...wrapped);
    }
    const windowLines = wrapHintLines([this.peerConsentWindowText(latch)], cols);
    const warningLines = wrapHintLines([
      incoming
        ? "Approving allows this peer to connect here until you revoke it."
        : "Approving trusts this server key until you remove the destination.",
      "The bounded window is the approval window, not the grant lifetime.",
    ], cols);
    const hintLines = wrapHintLines(["up/down choose", "enter apply", "esc close"], cols);
    if (windowLines === undefined || warningLines === undefined || hintLines === undefined
      || visibleWidth(header) > cols) {
      return tooSmall();
    }
    const noticeLines = this.peerConsentLocalNotice === undefined
      ? []
      : wrapHintLines([`! ${this.peerConsentLocalNotice}`], cols) ?? [];
    const bodyRows = 1 + identityLines.length + windowLines.length + warningLines.length
      + noticeLines.length + 2 + hintLines.length;
    if (bodyRows > rows) return tooSmall();

    const lines: string[] = [wrapRow(header, cols, "\x1b[1m")];
    for (const line of identityLines) lines.push(wrapRow(line, cols));
    for (const line of windowLines) lines.push(wrapRow(line, cols));
    for (const line of warningLines) lines.push(wrapRow(line, cols));
    for (const line of noticeLines) lines.push(wrapRow(line, cols));
    const approveRow = lines.length;
    lines.push(wrapRow(`${this.peerConsentChoice === "approve" ? "> " : "  "}Approve`, cols,
      this.peerConsentChoice === "approve" ? SGR_SELECTION_BLUE : undefined));
    const denyRow = lines.length;
    lines.push(wrapRow(`${this.peerConsentChoice === "deny" ? "> " : "  "}Deny`, cols,
      this.peerConsentChoice === "deny" ? SGR_SELECTION_BLUE : undefined));
    lines.push(...blankLines(Math.max(0, rows - lines.length - hintLines.length)));
    for (const line of hintLines) lines.push(wrapRow(line, cols));

    if (this.peerConsentPendingState(latch) !== "current") {
      // Ended/expired: the frame names no token and authorizes nothing.
      this.invalidatePeerConsentDisplay();
      return { lines };
    }
    const frameIdentity = this.peerConsentFrameIdentity(
      latch, this.peerConsentChoice, cols, rows, approveRow, denyRow,
    );
    // The live countdown is display metadata, not identity: it changes every
    // second and must not revoke a proven frame. Control positions are already
    // covered by the decision rows, so this placeholder cannot hide a shift.
    const windowRow = 1 + identityLines.length;
    const keyLines = lines.map((line, index) =>
      index >= windowRow && index < windowRow + windowLines.length ? "<approval-window>" : line);
    const key = this.peerConsentFrameKey(frameIdentity, keyLines);
    if (this.peerConsentDisplay !== undefined && this.peerConsentDisplay.key === key) {
      // Identical identity/decision/geometry/bytes: keep the token that was
      // already written instead of constantly revoking an unchanged frame.
      this.peerConsentRendered = true;
      return { lines };
    }
    const token = this.peerConsentTokenSequence++;
    this.peerConsentDisplay = {
      identity: frameIdentity,
      key,
      token,
      consentId: latch.id,
      choice: this.peerConsentChoice,
      cols,
      rows,
      approveRow,
      denyRow,
    };
    this.peerConsentWrittenToken = undefined;
    this.peerConsentRendered = true;
    return { lines };
  }

  private handlePeerConsentInput(data: string): void {
    if (this.consumeSavedActionClaim(data)) return;
    // Only deliberate initial presses decide; held repeats/releases never do.
    if (isKeyRelease(data) || isKeyRepeat(data)) return;
    if (matchesKey(data, "escape")) {
      this.formEscapeClaimed = true;
      this.dismissPeerConsentReview();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "tab")) {
      this.setPeerConsentChoice(this.peerConsentChoice === "approve" ? "deny" : "approve");
      return;
    }
    if (matchesKey(data, "enter")) {
      this.applyPeerConsentDecision(data);
      return;
    }
    const printable = printableOf(data);
    if (printable === "y" || printable === "Y") {
      this.setPeerConsentChoice("approve");
      return;
    }
    if (printable === "n" || printable === "N") this.setPeerConsentChoice("deny");
  }

  /**
   * The semantic decision target changed: the previous frame token and any
   * written proof named the other choice, so Apply stays refused until the new
   * exact frame has been written.
   */
  private setPeerConsentChoice(choice: "approve" | "deny"): void {
    if (this.peerConsentChoice === choice) return;
    this.peerConsentChoice = choice;
    this.invalidatePeerConsentDisplay();
    this.peerConsentLocalNotice = "Decision changed; apply becomes available once this frame is written";
    this.onInvalidate?.();
  }

  /**
   * Emits one consent decision only for the exact CURRENT frame that Main
   * already settled with an actual writer receipt. No render, capture, arrival,
   * or too-small frame can reach this point, and the held key is fenced so a
   * repeat/release cannot emit a second decision.
   */
  private applyPeerConsentDecision(data: string): void {
    const display = this.peerConsentDisplay;
    const latch = this.peerConsentLatch;
    if (display === undefined || latch === undefined || !this.isPeerConsentRenderCurrent(display.token)) {
      this.peerConsentLocalNotice = "No current dialog frame; no decision was sent";
      this.onInvalidate?.();
      return;
    }
    if (this.peerConsentWrittenToken !== display.token) {
      this.peerConsentLocalNotice = "No written receipt for this frame yet; no decision was sent";
      this.onInvalidate?.();
      return;
    }
    const consentId = latch.id;
    const decision = this.peerConsentChoice;
    const renderToken = display.token;
    this.claimHeldAction(this.peerConsentActionMatcher(data));
    // Dispatch while this exact frame is still current: Main's independent
    // synchronous guard rechecks the token during its onAction handling and
    // must observe a live, current consent presentation.
    this.emit({ type: "peer-consent", consentId, decision, renderToken });
    // Close only the same view this decision came from. A callback that
    // already replaced it (a newer review, dismissal, hide, or snapshot
    // invalidation) keeps its own state untouched.
    if (this.peerConsentLatch === latch) this.dismissPeerConsentReview();
  }

  private peerConsentActionMatcher(data: string): (candidate: string) => boolean {
    const key = parseKey(data) as KeyId | undefined;
    if (key !== undefined) return (candidate) => matchesKey(candidate, key);
    const printable = printableOf(data);
    return (candidate) => printable !== undefined && printableOf(candidate) === printable;
  }

  /** Selectable network-panel rows, built fresh from the attached snapshot. */
  private buildPeerPaneRows(): readonly PeerPaneRow[] {
    const rows: PeerPaneRow[] = [
      { key: "toggle-hosting", kind: "toggle-hosting" },
      { key: "edit-bind-host", kind: "edit-bind-host" },
      { key: "edit-bind-port", kind: "edit-bind-port" },
      { key: "apply-hosting", kind: "apply-hosting" },
      { key: "toggle-auto", kind: "toggle-auto" },
      { key: "toggle-bell", kind: "toggle-bell" },
      { key: "add-host", kind: "add-host" },
    ];
    const snapshot = this.peerUiSnapshot;
    if (snapshot === undefined) return rows;
    for (const host of snapshot.hosts ?? []) {
      rows.push({ key: `host:${host.id}`, kind: "host", host });
      const rosterRows = host.roster.rows;
      // rows === null is "no complete observation": never fabricate empty rows.
      if (rosterRows === null) continue;
      const rosterState = host.roster.state === "stale" ? "stale" : "current";
      for (const row of rosterRows) {
        rows.push({
          key: `remote:${host.id}:${row.id}`,
          kind: "remote",
          hostId: host.id,
          hostLabel: host.label,
          rosterState,
          row,
        });
      }
    }
    for (const peer of snapshot.trustedPeers ?? []) {
      rows.push({ key: `trusted:${peer.id}`, kind: "trusted", peer });
    }
    for (const consent of this.orderedPeerConsents()) {
      rows.push({ key: `consent:${consent.id}`, kind: "consent", consent });
    }
    return rows;
  }

  private peerPaneRowKeys(): string {
    return this.buildPeerPaneRows().map((row) => row.key).join("|");
  }

  private normalizePeerSelection(paneRows: readonly PeerPaneRow[]): number {
    if (paneRows.length === 0) {
      this.peerSelectedKey = undefined;
      return -1;
    }
    const index = paneRows.findIndex((row) => row.key === this.peerSelectedKey);
    if (index >= 0) return index;
    this.peerSelectedKey = paneRows[0]?.key;
    return 0;
  }

  private peerScrollWindow(selectedIndex: number, listRows: number, count: number): number {
    const maxTop = Math.max(0, count - 1);
    let top = Math.min(Math.max(this.peerPaneTop, 0), maxTop);
    if (selectedIndex < top) {
      top = selectedIndex;
    } else if (selectedIndex >= top + listRows) {
      top = selectedIndex - listRows + 1;
    }
    this.peerPaneTop = top;
    return top;
  }

  private movePeerSelection(delta: number): void {
    const paneRows = this.buildPeerPaneRows();
    if (paneRows.length === 0) return;
    const current = paneRows.findIndex((row) => row.key === this.peerSelectedKey);
    const next = current < 0
      ? (delta > 0 ? 0 : paneRows.length - 1)
      : (current + delta + paneRows.length) % paneRows.length;
    this.peerSelectedKey = paneRows[next]?.key;
    this.peerPaneError = undefined;
  }

  private peerStatusSegments(snapshot: PeerUiSnapshot): string[] {
    const settings = snapshot.settings;
    const segments = [
      settings === null
        ? "hosting: unknown (settings unavailable)"
        : `hosting: ${settings.hostingEnabled ? "enabled" : "disabled"}`,
    ];
    const listener = snapshot.listener;
    if (listener.state === "listening") {
      const host = listener.host === null ? "" : ` on ${sanitizeBounded(listener.host, PEER_ADDRESS_MAX_CODEPOINTS)}`;
      const port = listener.port === null ? "" : `:${listener.port}`;
      segments.push(`listener: listening${host}${port}`);
    } else if (listener.state === "error") {
      const message = listener.message === null
        ? ""
        : ` (${sanitizeBounded(listener.message, ERROR_TEXT_MAX_CODEPOINTS)})`;
      segments.push(`listener: error${message}`);
    } else {
      segments.push(`listener: ${listener.state}`);
    }
    segments.push(`auto: ${settings === null ? "unknown" : settings.autoReconnect ? "on" : "off"}`);
    segments.push(`bell: ${settings === null ? "unknown" : settings.bellEnabled ? "on" : "off"}`);
    segments.push(snapshot.hosts === null
      ? "destinations: unavailable"
      : `destinations: ${snapshot.hosts.length}`);
    segments.push(snapshot.trustedPeers === null
      ? "receiving: unavailable"
      : `receiving: ${snapshot.trustedPeers.length}`);
    return segments;
  }

  private peerIdentityText(snapshot: PeerUiSnapshot): string {
    if (snapshot.identityFingerprint === null) {
      return snapshot.status === "loading" ? "identity key: loading" : "identity key: unavailable";
    }
    return `identity key: ${sanitizeBounded(snapshot.identityFingerprint, PEER_FINGERPRINT_MAX_CODEPOINTS)}`;
  }

  private peerPaneRowText(row: PeerPaneRow): string {
    const settings = this.peerUiSnapshot?.settings ?? null;
    switch (row.kind) {
      case "toggle-hosting":
        return `Hosting: ${settings === null ? "unknown" : settings.hostingEnabled ? "enabled" : "disabled"} (enter to ${settings?.hostingEnabled === true ? "disable" : "enable"})`;
      case "edit-bind-host":
        return `Listen address: ${this.peerBindHostDraft.length > 0 ? sanitizeBounded(this.peerBindHostDraft, PEER_ADDRESS_MAX_CODEPOINTS) : "(not set)"} (enter to edit)`;
      case "edit-bind-port":
        return `Listen port: ${this.peerBindPortDraft.length > 0 ? sanitizeBounded(this.peerBindPortDraft, 16) : "(not set)"} (enter to edit)`;
      case "apply-hosting":
        return `Apply listen address/port${this.peerBindDirty ? " (unsaved changes)" : ""}`;
      case "toggle-auto":
        return `Auto reconnect: ${settings === null ? "unknown" : settings.autoReconnect ? "on" : "off"} (enter to toggle)`;
      case "toggle-bell":
        return `Incoming bell: ${settings === null ? "unknown" : settings.bellEnabled ? "on" : "off"} (enter to toggle)`;
      case "add-host":
        return "Add destination";
      case "host": {
        const host = row.host;
        const endpoint = `${sanitizeBounded(host.host, PEER_ADDRESS_MAX_CODEPOINTS)}:${host.port}`;
        const fingerprint = host.fingerprint === null
          ? "key unknown"
          : `key ${sanitizeBounded(host.fingerprint, PEER_FINGERPRINT_MAX_CODEPOINTS)}`;
        const roster = host.roster.state === "current"
          ? `roster current (${host.roster.rows === null ? "unknown" : host.roster.rows.length})`
          : host.roster.state === "stale"
            ? `roster stale (${host.roster.rows === null ? "rows unknown" : `${host.roster.rows.length} last seen`})`
            : "roster never observed";
        const flags = [
          host.previouslyConnected ? "" : "never connected",
          host.reconnectSuppressed ? "auto retry suppressed until Connect" : "",
          host.message === null ? "" : sanitizeBounded(host.message, ERROR_TEXT_MAX_CODEPOINTS),
        ].filter((flag) => flag.length > 0);
        const suffix = flags.length === 0 ? "" : ` — ${flags.join(" | ")}`;
        return `${sanitizeBounded(host.label, PEER_LABEL_MAX_CODEPOINTS)} ${endpoint} — ${host.state} — ${fingerprint} — ${roster}${suffix}`;
      }
      case "trusted":
        return `${sanitizeBounded(row.peer.label, PEER_LABEL_MAX_CODEPOINTS)} — receiving grant ${row.peer.hasInboundGrant ? "allowed" : "none observed"} — key ${sanitizeBounded(row.peer.fingerprint, PEER_FINGERPRINT_MAX_CODEPOINTS)}`;
      case "consent": {
        const endpoint = row.consent.endpoint === null
          ? "endpoint not provided"
          : sanitizeBounded(row.consent.endpoint, PEER_ENDPOINT_MAX_CODEPOINTS);
        return `! ${sanitizeBounded(row.consent.label, PEER_LABEL_MAX_CODEPOINTS)} — from ${endpoint} — ${this.peerConsentWindowText(row.consent)} (enter to review)`;
      }
      case "remote": {
        const facts: SessionStatusFacts = {
          lifecycle: row.row.lifecycle,
          busy: row.row.busy,
          pendingInput: row.row.pendingInput,
          inputSurface: row.row.inputSurface,
          activeTasks: row.row.activeTasks,
          activeShells: row.row.activeShells,
          ...(row.row.exitCode === undefined ? {} : { exitCode: row.row.exitCode }),
        };
        const stale = row.rosterState === "stale" ? " [stale]" : "";
        const error = row.row.error === undefined
          ? ""
          : ` | error: ${sanitizeBounded(row.row.error, ERROR_TEXT_MAX_CODEPOINTS)}`;
        const title = sanitizeBounded(row.row.label, ITEM_LABEL_INPUT_MAX_CODEPOINTS);
        const workspace = sanitizeBounded(row.row.workspace, SAVED_WORKSPACE_MAX_CODEPOINTS);
        const hostLabel = sanitizeBounded(row.hostLabel, PEER_LABEL_MAX_CODEPOINTS);
        return `- ${hostLabel}: ${title}${stale} | ${cardStatusText(facts)} | ${cardBackgroundText(facts)} | ${workspace}${error}`;
      }
    }
  }

  private renderPeerPane(
    cols: number,
    rows: number,
  ): { lines: string[]; cursor?: { column: number; row: number } } {
    this.peerDisplay = undefined;
    const snapshot = this.peerUiSnapshot;
    if (snapshot === undefined) return this.renderTooSmall(cols, rows);
    const header = " Network ";
    const statusLines = wrapHintLines(this.peerStatusSegments(snapshot), cols);
    const identityLines = wrapBoundedField(this.peerIdentityText(snapshot), cols, 2);
    const notices = [snapshot.notice, this.peerPaneError, this.peerPaneNotice]
      .filter((message): message is string => typeof message === "string" && message.trim().length > 0)
      .map((message) => `! ${sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS)}`);
    const noticeLines = notices.length === 0 ? [] : wrapHintLines(notices, cols) ?? [];
    const footerLines = wrapHintLines([
      `${this.toggleLabel} toggle`,
      "up/down select",
      "enter open",
      "c connect",
      "x disconnect",
      "r remove",
      "v revoke",
      "esc back",
    ], cols);
    if (statusLines === undefined || footerLines === undefined) return this.renderTooSmall(cols, rows);
    const fixedRows = 1 + statusLines.length + identityLines.length + noticeLines.length + footerLines.length;
    const listRows = rows - fixedRows;
    if (listRows < 1) return this.renderTooSmall(cols, rows);
    const paneRows = this.buildPeerPaneRows();
    const selectedIndex = this.normalizePeerSelection(paneRows);
    const top = this.peerScrollWindow(Math.max(0, selectedIndex), listRows, paneRows.length);
    const lines: string[] = [wrapRow(header, cols, "\x1b[1m")];
    for (const line of statusLines) lines.push(wrapRow(line, cols));
    for (const line of identityLines) lines.push(wrapRow(line, cols));
    for (const line of noticeLines) lines.push(wrapRow(line, cols));
    const drawn: PeerPaneRow[] = [];
    for (let index = top; index < paneRows.length && drawn.length < listRows; index += 1) {
      const row = paneRows[index];
      const selected = index === selectedIndex;
      lines.push(wrapRow(
        `${selected ? "> " : "  "}${this.peerPaneRowText(row)}`,
        cols,
        selected ? SGR_SELECTION_BLUE : undefined,
      ));
      drawn.push(row);
    }
    lines.push(...blankLines(Math.max(0, rows - lines.length - footerLines.length)));
    for (const line of footerLines) lines.push(wrapRow(line, cols));
    this.peerDisplay = {
      cols,
      rows,
      signature: paneRows.map((row) => row.key).join("|"),
      selectedKey: paneRows[selectedIndex]?.key,
      entries: drawn,
    };
    return { lines };
  }

  private handlePeerPaneInput(data: string): void {
    // There is no text target in this pane: pasted bodies are opaque.
    if (this.routeBracketedPaste(data)) return;
    if (this.consumeFormEscapeClaim(data)) return;
    if (this.consumeClaimedReturnChord(data)) return;
    if (this.handleReservedToggle(data, () => this.closePeerPane())) return;
    const returnEvent = hostKeyEventType(data, this.returnToMainKey);
    if (returnEvent !== undefined) {
      if (returnEvent === "press") this.claimReturnToMainChord();
      return;
    }
    if (this.consumeSavedActionClaim(data)) return;
    if (isKeyRelease(data)) return;
    if (matchesKey(data, "up")) {
      this.movePeerSelection(-1);
      this.onInvalidate?.();
      return;
    }
    if (matchesKey(data, "down")) {
      this.movePeerSelection(1);
      this.onInvalidate?.();
      return;
    }
    if (matchesKey(data, "escape")) {
      this.formEscapeClaimed = true;
      this.closePeerPane();
      this._focus = "sidebar";
      this.onInvalidate?.();
      return;
    }
    if (matchesKey(data, "enter")) {
      if (isKeyRepeat(data)) return;
      this.activatePeerPaneRow();
      return;
    }
    if (isKeyRepeat(data)) return;
    const printable = printableOf(data);
    if (printable === "c" || printable === "C") {
      this.requestPeerConnect();
      return;
    }
    if (printable === "x" || printable === "X") {
      this.requestPeerDisconnect();
      return;
    }
    if (printable === "r" || printable === "R") {
      this.requestPeerRemoveConfirmation();
      return;
    }
    if (printable === "v" || printable === "V") {
      this.requestPeerRevokeConfirmation();
    }
  }

  /** Acts only on a row the last complete network-pane render actually drew. */
  private selectedPeerPaneRow(): PeerPaneRow | undefined {
    const display = this.peerDisplay;
    if (display === undefined || this.formKind !== "peer" || this._focus !== "form" || !this._visible) {
      return undefined;
    }
    if (display.selectedKey !== this.peerSelectedKey || display.signature !== this.peerPaneRowKeys()) {
      return undefined;
    }
    return display.entries.find((row) => row.key === this.peerSelectedKey);
  }

  private activatePeerPaneRow(): void {
    const row = this.selectedPeerPaneRow();
    if (row === undefined) {
      this.peerPaneError = "The network pane changed; review it before acting";
      this.onInvalidate?.();
      return;
    }
    const settings = this.peerUiSnapshot?.settings ?? null;
    switch (row.kind) {
      case "toggle-hosting":
        this.requestPeerListener(settings?.hostingEnabled !== true);
        return;
      case "edit-bind-host":
        this.openPeerFieldForm("bind-host");
        return;
      case "edit-bind-port":
        this.openPeerFieldForm("bind-port");
        return;
      case "apply-hosting":
        this.requestPeerListener(settings?.hostingEnabled === true);
        return;
      case "toggle-auto":
        this.emit({ type: "peer-auto-reconnect", enabled: settings?.autoReconnect !== true });
        this.peerPaneNotice = "Auto reconnect change requested; the coordinator reports the saved setting";
        this.peerPaneError = undefined;
        this.onInvalidate?.();
        return;
      case "toggle-bell":
        this.emit({ type: "peer-bell", enabled: settings?.bellEnabled !== true });
        this.peerPaneNotice = "Bell change requested; the coordinator reports the saved setting";
        this.peerPaneError = undefined;
        this.onInvalidate?.();
        return;
      case "add-host":
        this.openPeerFieldForm("add");
        return;
      case "host": {
        const label = sanitizeBounded(row.host.label, PEER_LABEL_MAX_CODEPOINTS);
        this.peerPaneError = undefined;
        this.peerPaneNotice = `Selected ${label}; c connect, x disconnect, r remove`;
        this.onInvalidate?.();
        return;
      }
      case "trusted": {
        const label = sanitizeBounded(row.peer.label, PEER_LABEL_MAX_CODEPOINTS);
        const grant = row.peer.hasInboundGrant ? "" : " (no grant observed)";
        this.peerPaneNotice = `Receiving permission for ${label}${grant}; v revoke`;
        this.peerPaneError = undefined;
        this.onInvalidate?.();
        return;
      }
      case "consent":
        this.openPeerConsentReview(row.consent);
        return;
      case "remote":
        // Metadata-only: no local select/resume/create/stop/remove/rename
        // action, no focus change, and the native content owner is untouched.
        this.peerPaneError = undefined;
        this.peerPaneNotice = `Remote session metadata only (${row.rosterState}): local display is not available in this version`;
        this.onInvalidate?.();
        return;
    }
  }

  private requestPeerListener(enabled: boolean): void {
    const host = this.peerBindHostDraft.trim();
    const port = this.peerBindPortDraft.trim();
    const error = peerHostFieldError(host, "Listen address") ?? peerPortFieldError(port, "Listen port");
    if (error !== undefined) {
      this.peerPaneError = error;
      this.onInvalidate?.();
      return;
    }
    this.peerPaneError = undefined;
    this.peerPaneNotice = enabled
      ? "Listen request sent; the coordinator reports the actual binding"
      : "Hosting disable requested; the remembered settings stay saved";
    this.emit({ type: "peer-listener", enabled, host, port });
    this.onInvalidate?.();
  }

  private requestPeerConnect(): void {
    const row = this.selectedPeerPaneRow();
    if (row?.kind !== "host") {
      this.peerPaneError = "Select a destination to connect";
      this.onInvalidate?.();
      return;
    }
    if (row.host.state === "connected") {
      this.peerPaneError = "This destination is already connected";
      this.onInvalidate?.();
      return;
    }
    if (row.host.state === "pairing" || row.host.state === "connecting") {
      this.peerPaneError = "This destination is already connecting";
      this.onInvalidate?.();
      return;
    }
    this.peerPaneError = undefined;
    const label = sanitizeBounded(row.host.label, PEER_LABEL_MAX_CODEPOINTS);
    const action = row.host.reconnectSuppressed || row.host.previouslyConnected ? "Retry" : "Connect";
    this.peerPaneNotice = `${action} requested for ${label}; the coordinator decides the outcome`;
    this.emit({ type: "peer-connect", hostId: row.host.id });
    this.onInvalidate?.();
  }

  private requestPeerDisconnect(): void {
    const row = this.selectedPeerPaneRow();
    if (row?.kind !== "host") {
      this.peerPaneError = "Select a destination to disconnect";
      this.onInvalidate?.();
      return;
    }
    const state = row.host.state;
    if (state !== "connected" && state !== "connecting" && state !== "pairing" && state !== "retrying") {
      this.peerPaneError = "This destination is not connected";
      this.onInvalidate?.();
      return;
    }
    this.peerPaneError = undefined;
    this.peerPaneNotice = `Disconnect requested for ${sanitizeBounded(row.host.label, PEER_LABEL_MAX_CODEPOINTS)}; the association and its suppression are kept`;
    this.emit({ type: "peer-disconnect", hostId: row.host.id });
    this.onInvalidate?.();
  }

  private requestPeerRemoveConfirmation(): void {
    const row = this.selectedPeerPaneRow();
    if (row?.kind !== "host") {
      this.peerPaneError = "Select a destination to remove";
      this.onInvalidate?.();
      return;
    }
    this.openPeerRemoveConfirmation(row.host);
  }

  private requestPeerRevokeConfirmation(): void {
    const row = this.selectedPeerPaneRow();
    if (row?.kind !== "trusted") {
      this.peerPaneError = "Select a receiving permission to revoke";
      this.onInvalidate?.();
      return;
    }
    if (!row.peer.hasInboundGrant) {
      this.peerPaneError = "No receiving grant is observed for this peer";
      this.onInvalidate?.();
      return;
    }
    this.openPeerRevokeConfirmation(row.peer);
  }

  private openPeerRemoveConfirmation(host: PeerUiHost): void {
    this.forgetDisplayedRoster(); // the confirmation replaces the pane
    this.disposeFormField();
    this.formKind = undefined;
    this.peerDisplay = undefined;
    this.peerConfirmDisplayed = false;
    this.peerRevokeTarget = undefined;
    this.peerRemoveTarget = Object.freeze({
      hostId: host.id,
      label: sanitizeBounded(host.label, PEER_LABEL_MAX_CODEPOINTS),
      endpoint: `${sanitizeBounded(host.host, PEER_ADDRESS_MAX_CODEPOINTS)}:${host.port}`,
    });
    this.confirmPurpose = "peer-remove";
    this._focus = "confirm";
    this.onInvalidate?.();
  }

  private openPeerRevokeConfirmation(peer: PeerUiTrustedPeer): void {
    this.forgetDisplayedRoster();
    this.disposeFormField();
    this.formKind = undefined;
    this.peerDisplay = undefined;
    this.peerConfirmDisplayed = false;
    this.peerRemoveTarget = undefined;
    this.peerRevokeTarget = Object.freeze({
      peerId: peer.id,
      label: sanitizeBounded(peer.label, PEER_LABEL_MAX_CODEPOINTS),
      fingerprint: sanitizeBounded(peer.fingerprint, PEER_FINGERPRINT_MAX_CODEPOINTS),
    });
    this.confirmPurpose = "peer-revoke";
    this._focus = "confirm";
    this.onInvalidate?.();
  }

  private renderPeerRemoveConfirmPane(cols: number, rows: number): { lines: string[] } {
    this.peerConfirmDisplayed = false;
    const target = this.peerRemoveTarget;
    const header = " Remove destination? ";
    const hints = wrapHintLines(["enter/y = remove", "esc/n = cancel"], cols);
    const warnings = wrapHintLines([
      "The saved destination and its local remembered key are forgotten.",
      "The other host's receiving grant and its sessions are not changed.",
    ], cols);
    if (target === undefined || hints === undefined || warnings === undefined || visibleWidth(header) > cols) {
      return this.renderTooSmall(cols, rows);
    }
    const nameLines = wrapExactField(`name: ${target.label}`, cols, 4);
    const endpointLines = wrapExactField(`destination: ${target.endpoint}`, cols, 4);
    if (nameLines === undefined || endpointLines === undefined) return this.renderTooSmall(cols, rows);
    const targetLines = [...nameLines, ...endpointLines];
    if (1 + targetLines.length + warnings.length + hints.length > rows) return this.renderTooSmall(cols, rows);
    const lines = [wrapRow(header, cols, "\x1b[1m")];
    for (const line of targetLines) lines.push(wrapRow(line, cols));
    for (const line of warnings) lines.push(wrapRow(line, cols));
    lines.push(...blankLines(Math.max(0, rows - lines.length - hints.length)));
    for (const line of hints) lines.push(wrapRow(line, cols));
    this.peerConfirmDisplayed = true;
    return { lines };
  }

  private renderPeerRevokeConfirmPane(cols: number, rows: number): { lines: string[] } {
    this.peerConfirmDisplayed = false;
    const target = this.peerRevokeTarget;
    const header = " Revoke receiving permission? ";
    const hints = wrapHintLines(["enter/y = revoke", "esc/n = cancel"], cols);
    const warnings = wrapHintLines([
      "This host may no longer connect here until it is approved again.",
      "No session is stopped and the opposite direction is unchanged.",
    ], cols);
    if (target === undefined || hints === undefined || warnings === undefined || visibleWidth(header) > cols) {
      return this.renderTooSmall(cols, rows);
    }
    const nameLines = wrapExactField(`name: ${target.label}`, cols, 4);
    const keyLines = wrapExactField(`key: ${target.fingerprint}`, cols, 4);
    if (nameLines === undefined || keyLines === undefined) return this.renderTooSmall(cols, rows);
    const targetLines = [...nameLines, ...keyLines];
    if (1 + targetLines.length + warnings.length + hints.length > rows) return this.renderTooSmall(cols, rows);
    const lines = [wrapRow(header, cols, "\x1b[1m")];
    for (const line of targetLines) lines.push(wrapRow(line, cols));
    for (const line of warnings) lines.push(wrapRow(line, cols));
    lines.push(...blankLines(Math.max(0, rows - lines.length - hints.length)));
    for (const line of hints) lines.push(wrapRow(line, cols));
    this.peerConfirmDisplayed = true;
    return { lines };
  }

  private handlePeerConfirmInput(data: string): void {
    if (isKeyRepeat(data) || isKeyRelease(data)) return;
    if (matchesKey(data, "escape")) {
      this.cancelPeerConfirmation();
      return;
    }
    const printable = printableOf(data);
    if (printable === "n" || printable === "N") {
      this.cancelPeerConfirmation();
      return;
    }
    if (!this.peerConfirmDisplayed) return;
    if (!matchesKey(data, "enter") && printable !== "y" && printable !== "Y") return;
    const removeTarget = this.peerRemoveTarget;
    const revokeTarget = this.peerRevokeTarget;
    const purpose = this.confirmPurpose;
    this.cancelPeerConfirmation();
    if (purpose === "peer-remove" && removeTarget !== undefined) {
      this.peerPaneNotice = `Remove requested for ${removeTarget.label}; the coordinator forgets the saved destination and local key`;
      this.emit({ type: "peer-remove", hostId: removeTarget.hostId });
      return;
    }
    if (purpose === "peer-revoke" && revokeTarget !== undefined) {
      this.peerPaneNotice = `Revoke requested for ${revokeTarget.label}; the coordinator reports the current receiving permission`;
      this.emit({ type: "peer-revoke", peerId: revokeTarget.peerId });
    }
  }

  private cancelPeerConfirmation(): void {
    this.peerConfirmDisplayed = false;
    this.peerRemoveTarget = undefined;
    this.peerRevokeTarget = undefined;
    this.confirmPurpose = "quit";
    this.formKind = this.peerUiSnapshot === undefined ? undefined : "peer";
    this._focus = this.formKind === "peer" ? "form" : "sidebar";
    this.onInvalidate?.();
  }

  private closePeerPane(): void {
    this.disposeFormField();
    this.formKind = undefined;
    this.peerFieldTarget = undefined;
    this.peerDisplay = undefined;
    this.peerPaneError = undefined;
    this.peerPaneNotice = undefined;
    this.peerConfirmDisplayed = false;
    this.peerRemoveTarget = undefined;
    this.peerRevokeTarget = undefined;
  }

  /** Opens one bounded text editor for an explicit listen value or a new destination. */
  private openPeerFieldForm(purpose: "bind-host" | "bind-port" | "add"): void {
    this.disposeFormField();
    this.pendingCreate = undefined;
    this.pendingRename = undefined;
    this.pendingShortcutSave = undefined;
    this.formKind = "peer-field";
    this.peerFieldTarget = { purpose };
    this.peerFieldIndex = 0;
    this.formError = undefined;
    this._focus = "form";
    this.createFormField(this.peerFieldValue(purpose, 0));
  }

  private peerFieldValue(purpose: "bind-host" | "bind-port" | "add", index: 0 | 1 | 2): string {
    if (purpose === "bind-host") return this.peerBindHostDraft;
    if (purpose === "bind-port") return this.peerBindPortDraft;
    return index === 0 ? this.peerAddDraft.label : index === 1 ? this.peerAddDraft.host : this.peerAddDraft.port;
  }

  private closePeerFieldForm(): void {
    this.abandonForm();
    this.formKind = this.peerUiSnapshot === undefined ? undefined : "peer";
    this._focus = this.formKind === "peer" ? "form" : "sidebar";
    this.onInvalidate?.();
  }

  private switchPeerField(): void {
    const purpose = this.peerFieldTarget?.purpose;
    if (this.formKind !== "peer-field" || purpose !== "add") return;
    const value = this.formField?.getValue() ?? "";
    if (this.peerFieldIndex === 0) this.peerAddDraft.label = value;
    else if (this.peerFieldIndex === 1) this.peerAddDraft.host = value;
    else this.peerAddDraft.port = value;
    this.peerFieldIndex = (this.peerFieldIndex + 1) % 3 as 0 | 1 | 2;
    this.formError = undefined;
    this.createFormField(this.peerFieldValue("add", this.peerFieldIndex));
  }

  private submitPeerField(submission: SessionHostFieldSubmission): void {
    const purpose = this.peerFieldTarget?.purpose;
    if (purpose === undefined) return;
    const value = submission.value;
    if (purpose === "bind-host") {
      const error = peerHostFieldError(value, "Listen address");
      if (error !== undefined) {
        this.formError = error;
        this.createFormField(value);
        return;
      }
      this.peerBindHostDraft = value;
      this.peerBindDirty = true;
      this.peerPaneNotice = "Listen address updated locally; choose Apply to request it";
      this.peerPaneError = undefined;
      this.closePeerFieldForm();
      return;
    }
    if (purpose === "bind-port") {
      const error = peerPortFieldError(value, "Listen port");
      if (error !== undefined) {
        this.formError = error;
        this.createFormField(value);
        return;
      }
      this.peerBindPortDraft = value;
      this.peerBindDirty = true;
      this.peerPaneNotice = "Listen port updated locally; choose Apply to request it";
      this.peerPaneError = undefined;
      this.closePeerFieldForm();
      return;
    }
    if (this.peerFieldIndex === 0) {
      const error = peerLabelFieldError(value);
      if (error !== undefined) {
        this.formError = error;
        this.createFormField(value);
        return;
      }
      this.peerAddDraft.label = value;
      this.peerFieldIndex = 1;
      this.formError = undefined;
      this.createFormField(this.peerAddDraft.host);
      return;
    }
    if (this.peerFieldIndex === 1) {
      const error = peerHostFieldError(value, "Destination host");
      if (error !== undefined) {
        this.formError = error;
        this.createFormField(value);
        return;
      }
      this.peerAddDraft.host = value;
      this.peerFieldIndex = 2;
      this.formError = undefined;
      this.createFormField(this.peerAddDraft.port);
      return;
    }
    const error = peerLabelFieldError(this.peerAddDraft.label)
      ?? peerHostFieldError(this.peerAddDraft.host, "Destination host")
      ?? peerPortFieldError(value, "Port");
    if (error !== undefined) {
      this.formError = error;
      this.createFormField(value);
      return;
    }
    const draft = { label: this.peerAddDraft.label, host: this.peerAddDraft.host, port: value };
    this.peerAddDraft = { label: "", host: "", port: "" };
    this.peerPaneError = undefined;
    this.peerPaneNotice = "Destination add requested; the coordinator validates and saves it";
    this.closePeerFieldForm();
    this.emit({ type: "peer-add", label: draft.label, host: draft.host, port: draft.port });
  }

  private renderPeerFieldPane(
    cols: number,
    rows: number,
  ): { lines: string[]; cursor?: { column: number; row: number } } {
    const target = this.peerFieldTarget;
    const field = this.formField;
    const header = " Network settings ";
    const purpose = target?.purpose;
    if (target === undefined || field === undefined) return this.renderTooSmall(cols, rows);
    const activeLabel = purpose === "bind-host"
      ? "Listen address"
      : purpose === "bind-port"
        ? "Listen port"
        : this.peerFieldIndex === 0 ? "Destination name" : this.peerFieldIndex === 1 ? "Host" : "Port";
    const contextLines = wrapHintLines([
      purpose === "add"
        ? "The destination is display data; the coordinator validates and saves it."
        : "An explicit local listen address/port is required; no wildcard or fallback is chosen.",
    ], cols);
    const errorLines = this.formError === undefined ? [] : wrapHintLines([`! ${this.formError}`], cols);
    const hints = purpose === "add"
      ? [`${this.formHints.submit} next/save`, "tab next field", `${this.formHints.cancel} cancel`]
      : [`${this.formHints.submit} save`, `${this.formHints.cancel} cancel`];
    const footerLines = wrapHintLines(hints, cols);
    if (contextLines === undefined || errorLines === undefined || footerLines === undefined
      || visibleWidth(header) > cols) return this.renderTooSmall(cols, rows);
    const allFields = [
      { label: "Destination name", value: this.peerAddDraft.label },
      { label: "Host", value: this.peerAddDraft.host },
      { label: "Port", value: this.peerAddDraft.port },
    ];
    const inactive = purpose === "add"
      ? allFields.filter((_entry, index) => index !== this.peerFieldIndex)
      : [];
    const fixedRows = 1 + contextLines.length + inactive.length + 1 + errorLines.length + footerLines.length;
    const activeRows = rows - fixedRows;
    if (activeRows < 1) return this.renderTooSmall(cols, rows);
    const prefix = `> ${activeLabel}: `;
    const prefixWidth = Math.min(visibleWidth(prefix), cols - 1);
    const fieldWidth = Math.max(1, cols - prefixWidth);
    const fieldFrame = field.render(fieldWidth, activeRows);
    if (!fieldFrame.cursor.visible || fieldFrame.lines.length === 0) return this.renderTooSmall(cols, rows);

    const lines = [wrapRow(header, cols, "\x1b[1m")];
    for (const line of contextLines) lines.push(wrapRow(line, cols));
    for (const entry of inactive) {
      lines.push(wrapRow(
        `  ${entry.label}: ${sanitizeBounded(entry.value, PEER_ADDRESS_MAX_CODEPOINTS)}`,
        cols,
      ));
    }
    const fieldTopRow = lines.length;
    const fieldRowCount = Math.min(activeRows, fieldFrame.lines.length);
    for (let index = 0; index < fieldRowCount; index += 1) {
      const source = fieldFrame.lines[index] ?? "";
      const positioned = index === 0 ? `${prefix}${source}` : `${" ".repeat(prefixWidth)}${source}`;
      lines.push(wrapRow(positioned, cols));
    }
    lines.push(wrapRow(errorLines[0] ?? "", cols));
    for (const line of errorLines.slice(1)) lines.push(wrapRow(line, cols));
    lines.push(...blankLines(Math.max(0, rows - lines.length - footerLines.length)));
    for (const line of footerLines) lines.push(wrapRow(line, cols));
    return {
      lines,
      cursor: {
        column: Math.min(prefixWidth + fieldFrame.cursor.column, cols - 1),
        row: fieldTopRow + fieldFrame.cursor.row,
      },
    };
  }

  // --- Visibility. ---

  /**
   * Hides the pane. This is a pure visibility action: it never stops or
   * pauses any instance; the backend only reflows the main frame.
   */
  private hide(): void {
    if (!this._visible) {
      return;
    }
    this.forgetDisplayedRoster();
    // A hidden pane cannot hold an open stop confirmation.
    this.confirmPurpose = "quit";
    this.stopRemoveTargetId = undefined;
    this.stopConfirmDisplayed = false;
    // A hidden pane also holds no consent dialog, network confirmation, or
    // drawn peer-row map: none of them may authorize anything off-screen.
    this.peerConsentLatch = undefined;
    this.peerConsentLocalNotice = undefined;
    this.invalidatePeerConsentDisplay();
    this.peerConfirmDisplayed = false;
    this.peerRemoveTarget = undefined;
    this.peerRevokeTarget = undefined;
    this.peerDisplay = undefined;
    this.peerFieldTarget = undefined;
    this._visible = false;
    this._focus = "main";
    this.emit({ type: "visibility", visible: false });
  }

  /**
   * Reserved shortcut, two-step:
   * - hidden: show the pane and focus the roster picker (visibility action);
   * - visible with MAIN focus: focus the roster picker only — no visibility
   *   action, so the layout is neither hidden nor resized;
   * - visible with sidebar-owned focus (roster, form, picker, confirm): hide
   *   and return focus to main. Form/picker callers run their own
   *   cancellation fence (abandonForm/dismissSavedPane) before this.
   */
  private toggle(): void {
    if (!this._visible) {
      this._visible = true;
      this._focus = "sidebar";
      this.emit({ type: "visibility", visible: true });
      return;
    }
    if (this._focus === "main") {
      this._focus = "sidebar";
      // Focus moved without a layout change; ask the host for a redraw.
      this.onInvalidate?.();
      return;
    }
    this.hide();
  }

  private emit(action: SidebarAction): void {
    this.onAction?.(action);
  }

  // --- Entry bookkeeping. ---

  private rebuildEntries(): void {
    this.entries = [
      ...this.rowStore.map(
        (item): SidebarEntry => ({ key: ITEM_KEY_PREFIX + item.id, kind: "item", item }),
      ),
      ...(this.diagnosticsWarning === undefined
        ? []
        : [{ key: ENTRY_DIAGNOSTICS_KEY, kind: "diagnostics" as const, warning: this.diagnosticsWarning }]),
      { key: ENTRY_SAVED_KEY, kind: "saved" },
      { key: ENTRY_NEW_KEY, kind: "new" },
      ...(this.peerUiSnapshot === undefined
        ? []
        : [{ key: ENTRY_PEER_KEY, kind: "peer" as const }]),
      { key: ENTRY_QUIT_KEY, kind: "quit" },
      ...(this.settingsAvailable ? [{ key: ENTRY_SETTINGS_KEY, kind: "settings" as const }] : []),
    ];
  }

  private findItemEntry(id: string): SidebarEntry | undefined {
    return this.entries.find(
      (entry) => entry.kind === "item" && entry.item !== undefined && entry.item.id === id,
    );
  }

  // --- Rendering. ---

  private renderTooSmall(cols: number, rows: number): { lines: string[] } {
    const message = cols >= 26 ? ` pane ${cols}x${rows} too small ` : "too small";
    const lines = [wrapRow(message, cols, "\x1b[1;7m")];
    for (let row = 1; row < rows; row += 1) {
      lines.push("");
    }
    return { lines };
  }

  private renderRosterPane(cols: number, rows: number): { lines: string[] } {
    const header = ` Sessions (${this.rowStore.length}) `;
    const footerLines = wrapHintLines(
      [
        `${this.toggleLabel} toggle`,
        "enter open",
        ...(this._focus === "sidebar" ? ["e edit name"] : []),
        ...(this._focus === "sidebar"
          ? ["d stop/remove"]
          : []),
        "esc hide",
        "q quit",
        ...(this._focus === "sidebar" && this.rowStore.length > 0 ? ["space expand"] : []),
        // The configured return chord focuses the existing Main owner (roster-only);
        // it never activates the highlighted row. Shown only while the roster
        // owns focus, where the key actually acts.
        ...(this._focus === "sidebar" ? [`${this.returnToMainLabel.toLowerCase()} main`] : []),
      ],
      cols,
    );
    const noticeLines = this.noticeError === undefined
      ? []
      : wrapHintLines([`! ${this.noticeError}`], cols);
    // The pending-consent band is reserved ABOVE the scrolling list, so a later
    // selected row can never scroll it out of view. It is the same bounded,
    // notification-only presentation as renderPeerAlert: no confirmation
    // control, no authority, and no focus/selection change.
    const alertLines = this.renderPeerAlert(cols, PEER_CONSENT_ALERT_ROWS).lines;
    if (footerLines === undefined || noticeLines === undefined || visibleWidth(header) > cols) {
      return this.renderRosterTooSmall(cols, rows);
    }
    const listRows = rows - 1 - alertLines.length - noticeLines.length - footerLines.length;
    const selectedIndex = this.entries.findIndex((entry) => entry.key === this.selectedEntryKey);
    const selectedHeight = selectedIndex >= 0 ? this.entryHeight(this.entries[selectedIndex]) : 1;
    // At least one entry row is required, and the highlighted entry (a card
    // is 3 or 5 rows) must fit completely: a picker whose selected target is
    // invisible or clipped would let Enter act on something not shown.
    if (listRows < 1 || listRows < selectedHeight) {
      return this.renderRosterTooSmall(cols, rows);
    }
    const lines: string[] = [wrapRow(header, cols, "\x1b[1m")];
    lines.push(...alertLines);
    const top = this.scrollWindow(selectedIndex, listRows);
    const displayed = new Map<string, number>();
    const regions = new Map<string, DisplayedRosterRegion>();
    let y = 0;
    for (let index = top; index < this.entries.length; index += 1) {
      const entry = this.entries[index];
      const entryLines = this.renderEntryLines(entry, index === selectedIndex, cols);
      // Only complete entries are drawn; a partially clipped card would
      // misrepresent its status.
      if (y + entryLines.length > listRows) {
        break;
      }
      lines.push(...entryLines);
      displayed.set(entry.key, entryLines.length);
      regions.set(entry.key, { row: lines.length - entryLines.length, height: entryLines.length, entry });
      y += entryLines.length;
    }
    this.displayedRoster = {
      signature: this.rosterSignature(),
      heights: displayed,
      regions,
      cols,
      rows,
      focus: this._focus,
    };
    for (const noticeLine of noticeLines) {
      lines.push(wrapRow(noticeLine, cols));
    }
    lines.push(...blankLines(Math.max(0, rows - lines.length - footerLines.length)));
    for (const footerLine of footerLines) {
      lines.push(wrapRow(footerLine, cols));
    }
    return { lines };
  }

  /**
   * Too-small roster fallback: no entry is displayed (the hit map stays empty,
   * so no roster target can act), but a pending request keeps its bounded,
   * notification-only presentation instead of vanishing behind a generic
   * message. With nothing pending the legacy too-small message is unchanged.
   */
  private renderRosterTooSmall(cols: number, rows: number): { lines: string[] } {
    this.displayedRoster = {
      signature: this.rosterSignature(),
      heights: new Map(),
      regions: new Map(),
      cols,
      rows,
      focus: this._focus,
    };
    const alert = this.renderPeerAlert(cols, rows);
    return alert.lines.length === 0 ? this.renderTooSmall(cols, rows) : { lines: alert.lines };
  }

  /**
   * Variable-height scroll: keeps the complete highlighted entry inside the
   * list window, moves the top only when needed, and pulls the window back
   * up when the whole tail fits (e.g. after a card collapses).
   */
  private scrollWindow(selectedIndex: number, listRows: number): number {
    const heights = this.entries.map((entry) => this.entryHeight(entry));
    const maxTop = Math.max(0, this.entries.length - 1);
    let top = Math.min(Math.max(this.listTop, 0), maxTop);
    if (selectedIndex >= 0) {
      if (selectedIndex < top) {
        top = selectedIndex;
      }
      let used = 0;
      for (let index = top; index <= selectedIndex; index += 1) {
        used += heights[index] ?? 1;
      }
      while (used > listRows && top < selectedIndex) {
        used -= heights[top] ?? 1;
        top += 1;
      }
    }
    let tail = 0;
    for (let index = top; index < heights.length; index += 1) {
      tail += heights[index] ?? 1;
    }
    while (top > 0 && tail + (heights[top - 1] ?? 1) <= listRows) {
      top -= 1;
      tail += heights[top] ?? 1;
    }
    this.listTop = top;
    return top;
  }

  /**
   * One entry's rows. Native-session cards: a title line holding ONLY the
   * sanitized canonical title, a status line (selection marker plus
   * observed/unknown agent and input state), an honest background-count
   * line, and — when expanded — two generic sanitized activity rows.
   */
  private renderEntryLines(entry: SidebarEntry, selected: boolean, cols: number): string[] {
    const marker = selected ? "> " : "  ";
    if (entry.kind === "item" && entry.item !== undefined) {
      const item = entry.item;
      // One focus-domain title highlight: white identifies the ACTUAL active
      // Main conversation only while Main has focus; blue identifies the LEFT
      // selected navigation target while the sidebar-owned surfaces have
      // focus. Never both at once, and never a false sibling/owner mark.
      let titleSgr: string;
      if (this._focus === "main" && this.activeMainOwnerID_ === item.id) {
        titleSgr = SGR_ACTIVE_MAIN_WHITE;
      } else if (selected && this._focus !== "main") {
        titleSgr = SGR_SELECTION_BLUE;
      } else {
        titleSgr = "\x1b[1m";
      }
      const lines = [
        wrapRow(cardTitle(item), cols, titleSgr),
        wrapRow(`${marker}${cardStatusText(item)}`, cols),
        wrapRow(`  ${cardBackgroundText(item)}`, cols),
      ];
      if (!this.collapsedItemIds.has(item.id)) {
        const activity = renderActivityLines(item.activity, cols);
        while (activity.length < ACTIVITY_LINES_MAX) {
          activity.push(wrapRow("", cols));
        }
        lines.push(...activity);
      }
      return lines;
    }
    if (entry.kind === "diagnostics" && entry.warning !== undefined) {
      const warning = entry.warning;
      const count = warning.count > 9999 ? "9999+" : String(warning.count);
      const title = warning.count > 0 ? `! Terminal diagnostics (${count})` : "! Terminal diagnostics";
      // Appends are queued asynchronously with no per-record acknowledgement,
      // so a healthy status only points at the log and never claims a save
      // completed. A known persistence failure is shown explicitly.
      const status = warning.logStatus === "ok"
        ? "details: diagnostics log"
        : `NOT saved: ${terminalDiagnosticsFailurePhrase(warning.logFailure)}`;
      return [
        wrapRow(`${marker}${title}`, cols, selected && this._focus !== "main" ? SGR_SELECTION_BLUE : "\x1b[1m"),
        wrapRow(`  ${status}`, cols),
        wrapRow("  enter clears warning", cols),
      ];
    }
    const text = entry.kind === "saved"
      ? `${marker}Saved conversations`
      : entry.kind === "new"
        ? `${marker}New session`
        : entry.kind === "peer"
          ? `${marker}Network${this.peerPendingConsentCount() > 0
            ? ` (${this.peerPendingConsentCount()} request${this.peerPendingConsentCount() === 1 ? "" : "s"})`
            : ""}`
        : entry.kind === "settings"
          ? `${marker}Host shortcuts${this.legacyToggleOverride ? " (--sidebar-key override active)" : ""}`
          : `${marker}Quit host`;
    // Host-owned action rows take the blue selection target while a
    // sidebar-owned surface has focus; they are never the native active owner.
    return [wrapRow(text, cols, selected && this._focus !== "main" ? SGR_SELECTION_BLUE : undefined)];
  }

  private renderFormPane(
    cols: number,
    rows: number,
  ): { lines: string[]; cursor?: { column: number; row: number } } {
    const editing = this.formKind === "edit";
    const header = editing ? " Edit native session name " : " New session ";
    const hints = editing
      ? [`${this.formHints.submit} save`, `${this.formHints.cancel} cancel`, `${this.formHints.clear} clear`, `${this.formHints.externalEditor} external editor`]
      : [`${this.formHints.submit} create`, `${this.formHints.cancel} cancel`, `${this.formHints.complete} complete`, `${this.formHints.clear} clear`, `${this.formHints.externalEditor} external editor`];
    const footerLines = wrapHintLines(hints, cols);
    const noticeLines = this.formNotice === undefined
      ? []
      : wrapHintLines([`! ${this.formNotice}`], cols);
    if (footerLines === undefined || noticeLines === undefined || visibleWidth(header) > cols || !this.formField) {
      return this.renderTooSmall(cols, rows);
    }
    const fixedRows = 1 + (editing ? 2 : 0) + 1 + 1 + noticeLines.length + footerLines.length;
    const fieldRows = rows - fixedRows;
    if (fieldRows < 1) return this.renderTooSmall(cols, rows);

    const prefix = editing ? "> New name: " : "> Workspace: ";
    const prefixWidth = Math.min(visibleWidth(prefix), cols - 1);
    const fieldWidth = Math.max(1, cols - prefixWidth);
    const fieldFrame = this.formField.render(fieldWidth, fieldRows);
    if (!fieldFrame.cursor.visible || fieldFrame.lines.length === 0) return this.renderTooSmall(cols, rows);

    const lines = [wrapRow(header, cols, "\x1b[1m")];
    if (editing) {
      lines.push(wrapRow(" Current name (display only; type a complete replacement): ", cols));
      const currentName = sanitizeBounded(this.editTarget?.currentName ?? "", 256);
      lines.push(wrapRow(truncateToWidth(currentName, cols, "...", true), cols));
    }
    const fieldTopRow = lines.length;
    const fieldRowsToShow = Math.min(fieldRows, fieldFrame.lines.length);
    for (let index = 0; index < fieldRowsToShow; index += 1) {
      const source = fieldFrame.lines[index] ?? "";
      const positionedSource = index === 0 ? `${prefix}${source}` : `${" ".repeat(prefixWidth)}${source}`;
      lines.push(wrapRow(positionedSource, cols));
    }
    lines.push(
      this.pendingCreate !== undefined
        ? wrapRow(` Starting (request ${this.pendingCreate.requestId}) `, cols)
        : this.pendingRename !== undefined
          ? wrapRow(" Saving native name... ", cols)
          : this.formError !== undefined
            ? wrapRow(` ! ${this.formError} `, cols)
            : "",
    );
    for (const noticeLine of noticeLines) lines.push(wrapRow(noticeLine, cols));
    lines.push(...blankLines(Math.max(0, rows - lines.length - footerLines.length)));
    for (const footerLine of footerLines) lines.push(wrapRow(footerLine, cols));

    return {
      lines,
      cursor: {
        column: Math.min(prefixWidth + fieldFrame.cursor.column, cols - 1),
        row: fieldTopRow + fieldFrame.cursor.row,
      },
    };
  }

  /** Host-owned editor for the two reserved sidebar chords. */
  private renderHostShortcutPane(
    cols: number,
    rows: number,
  ): { lines: string[]; cursor?: { column: number; row: number } } {
    const header = " Host shortcuts ";
    const footerLines = wrapHintLines([
      `${this.formHints.submit} Save`,
      `${this.formHints.cancel} Cancel`,
      "tab switch field",
    ], cols);
    const contextLines = wrapHintLines([
      "Separate from native Pi keybindings; terminal/OS delivery may vary.",
      ...(this.legacyToggleOverride
        ? [`Legacy --sidebar-key override active: ${this.toggleLabel}`]
        : []),
    ], cols);
    const errorLines = this.formError === undefined ? [] : wrapHintLines([`! ${this.formError}`], cols);
    if (!this.formField || footerLines === undefined || contextLines === undefined || errorLines === undefined
      || visibleWidth(header) > cols) return this.renderTooSmall(cols, rows);

    const togglePrefix = this.shortcutFieldIndex === 0 ? "> Toggle (stored): " : "  Toggle (stored): ";
    const returnPrefix = this.shortcutFieldIndex === 1 ? "> Return to Main: " : "  Return to Main: ";
    const inactivePrefix = this.shortcutFieldIndex === 0 ? returnPrefix : togglePrefix;
    const inactiveValue = this.shortcutFieldIndex === 0 ? this.shortcutDraft.returnToMain : this.shortcutDraft.toggle;
    const inactivePrefixWidth = Math.min(visibleWidth(inactivePrefix), cols - 1);
    const inactiveLines = wrapHintLines([inactiveValue], Math.max(1, cols - inactivePrefixWidth));
    if (inactiveLines === undefined) return this.renderTooSmall(cols, rows);

    const fixedRows = 1 + contextLines.length + inactiveLines.length + 1 + 1 + errorLines.length + footerLines.length;
    const activeRows = rows - fixedRows;
    if (activeRows < 1) return this.renderTooSmall(cols, rows);
    const activePrefix = this.shortcutFieldIndex === 0 ? togglePrefix : returnPrefix;
    const activePrefixWidth = Math.min(visibleWidth(activePrefix), cols - 1);
    const fieldWidth = Math.max(1, cols - activePrefixWidth);
    const fieldFrame = this.formField.render(fieldWidth, activeRows);
    if (!fieldFrame.cursor.visible || fieldFrame.lines.length === 0) return this.renderTooSmall(cols, rows);

    const lines = [wrapRow(header, cols, "\x1b[1m")];
    for (const contextLine of contextLines) lines.push(wrapRow(contextLine, cols));
    const activeLines = fieldFrame.lines.slice(0, activeRows);
    const inactiveRows = inactiveLines.map((line, index) => wrapRow(
      `${index === 0 ? inactivePrefix : " ".repeat(inactivePrefixWidth)}${line}`,
      cols,
    ));
    const activeRowsToDraw = activeLines.map((line, index) => wrapRow(
      `${index === 0 ? activePrefix : " ".repeat(activePrefixWidth)}${line}`,
      cols,
    ));
    const toggleRows = this.shortcutFieldIndex === 0 ? activeRowsToDraw : inactiveRows;
    const returnRows = this.shortcutFieldIndex === 1 ? activeRowsToDraw : inactiveRows;
    lines.push(...toggleRows, ...returnRows);
    const status = this.pendingShortcutSave !== undefined
      ? " Saving host shortcuts... "
      : errorLines.length === 0 ? "" : errorLines[0];
    lines.push(wrapRow(status, cols));
    for (const errorLine of errorLines.slice(1)) lines.push(wrapRow(errorLine, cols));
    const fieldRow = 1 + contextLines.length + (this.shortcutFieldIndex === 0 ? 0 : toggleRows.length);
    lines.push(...blankLines(Math.max(0, rows - lines.length - footerLines.length)));
    for (const footerLine of footerLines) lines.push(wrapRow(footerLine, cols));
    return {
      lines,
      cursor: {
        column: Math.min(activePrefixWidth + fieldFrame.cursor.column, cols - 1),
        row: fieldRow + fieldFrame.cursor.row,
      },
    };
  }

  /**
   * The deliberate saved-conversation picker: canonical captions only, with
   * truthful loading/empty/unavailable/partial notices and wrapped keyboard
   * hints. It occupies the same form-pane slot (right pane on wide layouts,
   * full-content overlay on narrow ones) as New/Edit.
   */
  private renderSavedPane(cols: number, rows: number): { lines: string[]; cursor?: { column: number; row: number } } {
    // A fresh render starts with no displayed rows; a too-small fallback never
    // establishes a displayable selection, so the saved-open guard stays closed.
    this.displayedSavedRows = undefined;
    const header = " Saved conversations ";
    const queryLine = this.renderSavedQueryLine(cols);
    const footerLines = wrapHintLines(
      [
        `${this.toggleLabel} toggle / ${this.savedKeyHint("tui.select.up", "up")}/${this.savedKeyHint("tui.select.down", "down")} select`,
        `${this.savedKeyHint("tui.select.confirm", "enter")} open / ${this.savedKeyHint("tui.select.cancel", "esc")} back`,
        `${this.savedKeyHint("app.session.delete", "ctrl+d")} delete / ${this.savedKeyHint("app.session.deleteNoninvasive", "ctrl+backspace")} empty`,
      ],
      cols,
    );
    const notices = [this.savedError, this.savedQueryNotice]
      .filter((message, index, all): message is string => message !== undefined && all.indexOf(message) === index);
    const noticeLines = notices.length === 0 ? [] : wrapHintLines(notices.map((message) => `! ${message}`), cols);
    const issueLines = this.pendingSavedList === undefined && this.savedIssueCount > 0
      ? wrapHintLines([`${this.savedIssueCount} catalog issue(s) not shown`], cols)
      : [];
    if (footerLines === undefined || noticeLines === undefined || issueLines === undefined
      || visibleWidth(header) > cols) {
      return this.renderTooSmall(cols, rows);
    }
    // The fixed details area is reserved between the list and the footer so
    // notices can never displace it or make an impossible action look done.
    const fixedRows = 2 + SAVED_DETAILS_ROWS + noticeLines.length + issueLines.length + footerLines.length;
    const listRows = rows - fixedRows;
    if (listRows < 1) {
      return this.renderTooSmall(cols, rows);
    }

    const lines: string[] = [wrapRow(header, cols, "\x1b[1m"), queryLine.line];
    let y = 0;
    if (this.pendingSavedList !== undefined) {
      lines.push(wrapRow(" Loading saved conversations... ", cols));
      y += 1;
    } else if (this.savedRows.length === 0) {
      // A failed listing never establishes an empty catalog; only a
      // successful issue-free empty one says "No saved conversations".
      if (this.savedError === undefined) {
        lines.push(wrapRow(
          this.savedQuery.trim().length > 0 ? " No matching saved conversations "
            : this.savedIssueCount > 0 ? " No conversations could be listed " : " No saved conversations ",
          cols,
        ));
        y += 1;
      }
    } else {
      const top = this.savedScrollWindow(listRows);
      let index = top;
      const displayed: DisplayedSavedRow[] = [];
      while (index < this.savedRows.length && y < listRows) {
        const row = this.savedRows[index];
        displayed.push({ paneRow: lines.length, index, entry: row });
        lines.push(this.renderSavedRow(row, index === this.savedSelectedIndex, cols));
        y += 1;
        index += 1;
      }
      // Record exact draw-derived row locations and identity so a click/open
      // can target only a row the user actually saw; undrawn/hidden rows stay refused.
      this.displayedSavedRows = { cols, rows, entries: displayed };
    }
    // Pad the list window so the details area sits at a fixed position (just
    // above the footer), not floating up when there are few rows.
    lines.push(...blankLines(Math.max(0, listRows - y)));
    // Fixed details area for the highlighted row, updated in the same frame as
    // the list highlight. Empty (never a fabricated workspace) while loading,
    // empty, or failed; late listings are fenced by the pending request.
    const selectedRow = this.pendingSavedList === undefined && this.savedRows.length > 0
      ? this.savedRows[this.savedSelectedIndex]
      : undefined;
    for (const detailLine of this.renderSavedDetails(selectedRow, cols)) {
      lines.push(wrapRow(detailLine, cols));
    }
    for (const noticeLine of noticeLines) lines.push(wrapRow(noticeLine, cols));
    for (const issueLine of issueLines) lines.push(wrapRow(issueLine, cols));
    lines.push(...blankLines(Math.max(0, rows - lines.length - footerLines.length)));
    for (const footerLine of footerLines) lines.push(wrapRow(footerLine, cols));
    return { lines, cursor: queryLine.cursor };
  }

  private renderSavedQueryLine(cols: number): { readonly line: string; readonly cursor: { column: number; row: number } } {
    let rendered: string[];
    try { rendered = this.savedQueryInput?.render(cols) ?? []; } catch { rendered = []; }
    const source = rendered[0] ?? "";
    const markerIndex = source.indexOf(CURSOR_MARKER);
    const beforeMarker = markerIndex >= 0 ? source.slice(0, markerIndex) : source;
    const safeBefore = sanitizeBounded(beforeMarker, MAX_SAVED_QUERY_DISPLAY_CODEPOINTS);
    const withoutMarker = source.split(CURSOR_MARKER).join("");
    const safeLine = sanitizeBounded(withoutMarker, MAX_SAVED_QUERY_DISPLAY_CODEPOINTS);
    return {
      line: wrapRow(safeLine, cols),
      cursor: {
        column: Math.min(visibleWidth(safeBefore), cols - 1),
        row: 1,
      },
    };
  }

  private savedKeyHint(action: SidebarSavedPickerAction, fallback: string): string {
    try {
      const keys = this.savedQueryInput?.keys?.(action);
      if (keys !== undefined && keys.length > 0) {
        return keys.map((key) => key === "escape" ? "esc" : key).join("/");
      }
    } catch { /* render a truthful native default if the manager is unavailable */ }
    return fallback;
  }

  /**
   * The fixed details area for one highlighted saved row: the conversation
   * caption and its EXACT recorded workspace, wrapped within the reserved
   * rows. A missing recorded workspace renders as unavailable, never a
   * current-workspace guess. Display only; it never feeds admission.
   */
  private renderSavedDetails(row: SidebarSavedRow | undefined, cols: number): string[] {
    if (row === undefined) {
      return blankLines(SAVED_DETAILS_ROWS);
    }
    const caption = sanitizeBounded(row.caption, SAVED_CAPTION_MAX_CODEPOINTS);
    const workspace = row.cwd !== undefined
      ? sanitizeBounded(row.cwd, SAVED_WORKSPACE_MAX_CODEPOINTS)
      : "workspace unavailable";
    // Reserve independent capacity for each field so a long multiword caption
    // cannot consume every row and hide the workspace (and vice versa). The
    // caption gets one row; the workspace gets the remaining rows with
    // column-safe wrapping that splits long path tokens across rows.
    const captionLines = wrapBoundedField(caption, cols, 1);
    const workspaceLines = wrapBoundedField(workspace, cols, SAVED_DETAILS_ROWS - 1);
    return [...captionLines, ...workspaceLines];
  }

  /** Keeps the keyboard-highlighted saved row visible inside the list window. */
  private savedScrollWindow(listRows: number): number {
    const maxTop = Math.max(0, this.savedRows.length - 1);
    let top = Math.min(Math.max(this.savedListTop, 0), maxTop);
    if (this.savedSelectedIndex < top) {
      top = this.savedSelectedIndex;
    } else if (this.savedSelectedIndex >= top + listRows) {
      top = this.savedSelectedIndex - listRows + 1;
    }
    this.savedListTop = top;
    return top;
  }

  private renderSavedRow(row: SidebarSavedRow, selected: boolean, cols: number): string {
    const marker = selected ? "> " : "  ";
    const markerWidth = visibleWidth(marker);
    const caption = sanitizeBounded(row.caption, SAVED_CAPTION_MAX_CODEPOINTS);
    let text: string;
    if (row.cwd !== undefined) {
      // One single line per entry: caption and recorded workspace summaries,
      // each fairly bounded and visibly ellipsized. The caption stays the
      // row's leading identity so picker witnesses keep matching.
      const separator = " | ";
      const available = Math.max(0, cols - markerWidth - visibleWidth(separator));
      const captionWidth = Math.floor(available / 2);
      const cwdWidth = Math.max(0, available - captionWidth);
      const cwd = sanitizeBounded(row.cwd, SAVED_WORKSPACE_MAX_CODEPOINTS);
      const visibleCaption = captionWidth > 0 ? truncateToWidth(caption, captionWidth, "...", true) : "";
      const visibleCwd = cwdWidth > 0 ? truncateToWidth(cwd, cwdWidth, "...", true) : "";
      text = `${marker}${visibleCaption}${separator}${visibleCwd}`;
    } else {
      // No recorded workspace: caption only, never a fabricated default.
      const labelWidth = Math.max(0, cols - markerWidth);
      const visibleLabel = labelWidth > 0 ? truncateToWidth(caption, labelWidth, "...", true) : "";
      text = `${marker}${visibleLabel}`;
    }
    return wrapRow(text, cols, selected ? SGR_SELECTION_BLUE : undefined);
  }

  private renderConfirmPane(cols: number, rows: number): { lines: string[] } {
    this.peerConsentRendered = false;
    if (this.confirmPurpose === "peer-consent") {
      return this.renderPeerConsentPane(cols, rows);
    }
    if (this.confirmPurpose === "peer-remove") {
      return this.renderPeerRemoveConfirmPane(cols, rows);
    }
    if (this.confirmPurpose === "peer-revoke") {
      return this.renderPeerRevokeConfirmPane(cols, rows);
    }
    if (this.confirmPurpose === "saved-delete") {
      return this.renderSavedDeleteConfirmPane(cols, rows);
    }
    if (this.confirmPurpose === "stop-remove") {
      return this.renderStopRemoveConfirmPane(cols, rows);
    }
    const header = " Quit host? ";
    const liveCount = this.rowStore.filter(requiresQuitConfirmation).length;
    const countLines = wrapHintLines(
      [`${liveCount} session(s) starting, alive, or host-owned`],
      cols,
    );
    const hintLines = wrapHintLines(["enter/y = quit host", "esc/n = cancel"], cols);
    if (countLines === undefined || hintLines === undefined || visibleWidth(header) > cols) {
      return this.renderTooSmall(cols, rows);
    }
    if (rows < 1 + countLines.length + hintLines.length) {
      return this.renderTooSmall(cols, rows);
    }
    const lines = [wrapRow(header, cols, "\x1b[1m")];
    for (const line of countLines) {
      lines.push(wrapRow(line, cols));
    }
    lines.push(...blankLines(Math.max(0, rows - lines.length - hintLines.length)));
    for (const line of hintLines) {
      lines.push(wrapRow(line, cols));
    }
    return { lines };
  }

  /** Confirmation is enabled only after the entire exact target and warning fit. */
  private renderSavedDeleteConfirmPane(cols: number, rows: number): { lines: string[] } {
    this.invalidateSavedDeleteConfirmationDisplay();
    const context = this.savedDeleteTarget;
    const header = " Delete saved conversation? ";
    const hints = wrapHintLines([
      `${this.savedKeyHint("tui.select.confirm", "enter")} confirm`,
      `${this.savedKeyHint("tui.select.cancel", "esc")} cancel`,
    ], cols);
    const warnings = wrapHintLines([
      "Only this saved file is removed; the host will not stop any child.",
      "If trash fails, this file is permanently unlinked.",
    ], cols);
    if (!context || hints === undefined || warnings === undefined || visibleWidth(header) > cols) {
      return this.renderTooSmall(cols, rows);
    }

    const file = sanitizeBounded(context.row.file, SAVED_WORKSPACE_MAX_CODEPOINTS);
    const caption = sanitizeBounded(context.row.caption, SAVED_CAPTION_MAX_CODEPOINTS);
    // The exact file path is the deletion identity and must remain complete;
    // the caption is only a short visual aid. Private session ids are omitted.
    if (file !== context.row.file) return this.renderTooSmall(cols, rows);
    const captionPrefix = "Conversation: ";
    const captionWidth = cols - visibleWidth(captionPrefix);
    if (captionWidth < 1) return this.renderTooSmall(cols, rows);
    const visibleCaption = truncateToWidth(caption, captionWidth, "...", true);
    const targetText = [`${captionPrefix}${visibleCaption}`, `Saved file: ${file}`];
    const targetLines: string[] = [];
    const availableTargetRows = rows - 1 - warnings.length - hints.length;
    if (availableTargetRows < targetText.length) return this.renderTooSmall(cols, rows);
    for (const text of targetText) {
      const wrapped = wrapExactField(text, cols, availableTargetRows - targetLines.length);
      if (wrapped === undefined) return this.renderTooSmall(cols, rows);
      targetLines.push(...wrapped);
    }
    if (1 + targetLines.length + warnings.length + hints.length > rows) return this.renderTooSmall(cols, rows);

    const lines = [wrapRow(header, cols, "\x1b[1m")];
    for (const line of targetLines) lines.push(wrapRow(line, cols));
    for (const line of warnings) lines.push(wrapRow(line, cols));
    lines.push(...blankLines(Math.max(0, rows - lines.length - hints.length)));
    for (const line of hints) lines.push(wrapRow(line, cols));
    this.savedDeleteConfirmationRenderToken = this.nextSavedDeleteConfirmationRenderToken++;
    return { lines };
  }

  /**
   * The explicit stop confirmation: the frozen target's title (or a truthful
   * gone notice), the warning that its active turn, questions, background
   * tasks, and shells will be stopped, and the confirm/cancel hints.
   */
  private renderStopRemoveConfirmPane(cols: number, rows: number): { lines: string[] } {
    const header = " Stop session? ";
    const target = this.stopRemoveTargetId !== undefined
      ? this.findItemEntry(this.stopRemoveTargetId)
      : undefined;
    // The title truncates to the pane so it can never push the warning or
    // hints out of the dialog.
    const targetLines = wrapHintLines(
      [target?.item !== undefined
        ? truncateToWidth(cardTitle(target.item), cols, "...", true)
        : "The session no longer exists"],
      cols,
    );
    const warningLines = wrapHintLines(
      ["Stopping will stop its active turn, questions, background tasks, and shells"],
      cols,
    );
    const hintLines = wrapHintLines(["enter/y = stop", "esc/n = cancel"], cols);
    if (targetLines === undefined || warningLines === undefined || hintLines === undefined
      || visibleWidth(header) > cols) {
      this.stopConfirmDisplayed = false;
      return this.renderTooSmall(cols, rows);
    }
    if (rows < 1 + targetLines.length + warningLines.length + hintLines.length) {
      this.stopConfirmDisplayed = false;
      return this.renderTooSmall(cols, rows);
    }
    const lines = [wrapRow(header, cols, "\x1b[1m")];
    for (const line of targetLines) {
      lines.push(wrapRow(line, cols));
    }
    for (const line of warningLines) {
      lines.push(wrapRow(line, cols));
    }
    lines.push(...blankLines(Math.max(0, rows - lines.length - hintLines.length)));
    for (const line of hintLines) {
      lines.push(wrapRow(line, cols));
    }
    this.stopConfirmDisplayed = true;
    return { lines };
  }
}

/**
 * Word-wraps text with hard line breaks into at most `maxLines` rows of
 * visible width `cols`. A single word wider than the pane is ellipsized.
 * When the content overflows the reserved rows, the last row carries an
 * explicit truncation marker instead of silently dropping text.
 */
/**
 * Column-safe wrapping of one bounded field into at most `maxLines` rows of
 * visible width `cols`. Grapheme clusters (including spaces and wide Unicode)
 * are preserved in order; a token longer than a row is split across rows
 * rather than immediately ellipsized. When the content overflows the reserved
 * rows, the last row carries an explicit truncation marker instead of silently
 * dropping text.
 */
const detailGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function wrapBoundedField(text: string, cols: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";
  let truncated = false;
  for (const { segment: char } of detailGraphemes.segment(text)) {
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
    const candidate = current + char;
    if (visibleWidth(candidate) <= cols) {
      current = candidate;
    } else {
      lines.push(current);
      current = char; // preserve the character (including spaces) on the new row
      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
    }
  }
  if (current !== "") {
    if (lines.length < maxLines) lines.push(current);
    else truncated = true;
  }
  if (truncated && lines.length > 0) {
    const last = lines[lines.length - 1];
    const base = truncateToWidth(last, Math.max(1, cols - 3), "", true);
    lines[lines.length - 1] = `${base}...`;
  }
  while (lines.length < maxLines) lines.push("");
  return lines.slice(0, maxLines);
}

/** Wrap without clipping: undefined means the complete value cannot be shown. */
function wrapExactField(text: string, cols: number, maxLines: number): string[] | undefined {
  if (cols < 1 || maxLines < 1) return undefined;
  const lines: string[] = [];
  let line = "";
  let width = 0;
  for (const grapheme of detailGraphemes.segment(text)) {
    const graphemeWidth = visibleWidth(grapheme.segment);
    if (graphemeWidth > cols) return undefined;
    if (width + graphemeWidth > cols) {
      lines.push(line);
      if (lines.length >= maxLines) return undefined;
      line = "";
      width = 0;
    }
    line += grapheme.segment;
    width += graphemeWidth;
  }
  lines.push(line);
  return lines.length <= maxLines ? lines : undefined;
}

function renderActivityLines(activity: readonly string[], cols: number): string[] {
  return activity
    .map((line) => sanitizeCellText(line))
    .filter((line) => line.length > 0)
    .slice(0, ACTIVITY_LINES_MAX)
    .map((line) =>
      wrapRow(`    ${sanitizeBounded(line, ACTIVITY_INPUT_MAX_CODEPOINTS)}`, cols),
    );
}

function fieldRejectionNotice(reason: SessionHostFieldRejection): string {
  switch (reason) {
    case "unsafe-text": return "Unsafe terminal text was rejected";
    case "text-limit": return "Field value exceeds its limit";
    case "paste-limit": return "Pasted text exceeds the field limit";
    case "input-chunk-limit": return "Input chunk exceeds the field limit";
    case "completion-limit": return "Native completion exceeds the field limit";
    case "external-editor-failed": return "External editor did not complete; the field was not changed";
  }
}

function renameFailureNotice(status: string): string {
  switch (status) {
    case "stale-session": return "Native conversation changed; reopen Edit before renaming";
    case "unavailable": return "Native session rename is unavailable";
    case "invalid-name": return "New name is invalid or exceeds 1024 UTF-8 bytes";
    case "setter-failed": return "Pi could not set the new session name";
    case "verification-failed": return "Pi could not verify the native session name";
    case "busy": return "Session name was not changed while Pi is busy";
    case "timeout": return "Session rename timed out; verify the session name before retrying";
    case "disconnected": return "Status connection closed; session name was not confirmed";
    case "invalid-request": return "Session rename request was rejected";
    default: return "Session name could not be changed";
  }
}

/**
 * Fixed, local data-shape errors for network fields. They never claim network
 * admission: the coordinator revalidates every command; these only refuse
 * obviously unusable text before it is sent.
 */
function peerHostFieldError(value: string, label: string): string | undefined {
  if (value.length === 0) return `${label} is required (no default is chosen for you)`;
  if (/\s/.test(value)) return `${label} cannot contain whitespace`;
  if (sanitizeCellText(value) !== value) return `${label} contains unsafe text`;
  if (countCodePoints(value) > PEER_ADDRESS_MAX_CODEPOINTS) return `${label} is too long`;
  return undefined;
}

function peerPortFieldError(value: string, label: string): string | undefined {
  if (value.length === 0) return `${label} is required (no default port is chosen for you)`;
  if (!/^[0-9]+$/.test(value)) return `${label} must be a whole number`;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < PEER_PORT_MIN || port > PEER_PORT_MAX) {
    return `${label} must be between ${PEER_PORT_MIN} and ${PEER_PORT_MAX}`;
  }
  return undefined;
}

function peerLabelFieldError(value: string): string | undefined {
  if (value.trim().length === 0) return "A destination name is required";
  if (sanitizeCellText(value) !== value) return "The destination name contains unsafe text";
  if (countCodePoints(value) > PEER_LABEL_MAX_CODEPOINTS) return "The destination name is too long";
  return undefined;
}