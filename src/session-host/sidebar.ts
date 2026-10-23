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
 *   labels remain plain text + generated SGR. Every labeled field places its
 *   label beside the Editor's first editable body row — a structural anchor that
 *   never follows the caret across wrapped values — and never beside a rule.
 *   The value column, cursor geometry, clipping, and tiny-pane refusal are
 *   untouched. New/Edit, Host shortcuts, and the Network listen/Add-destination
 *   editors share that one layout seam.
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
 * Remote roster rows are separate typed entries in both surfaces, never
 * fabricated `SidebarItem`s: no invented agent dir, busy flag, input surface,
 * or exit code. The Network pane keeps its metadata-only notice, and the LEFT
 * roster projects the SAME attached `PeerUiSnapshot` host rosters into typed
 * `remote` cards whose ordinary activation emits exactly one
 * `select-remote` DTO (host id, exact observed owner run or null, and owner row
 * id). No local select/resume/create/stop/remove/rename/quit/consent action can
 * be reached from a remote card, even when an opaque remote id collides with a
 * local one, and the native content owner is never changed by this module.
 * Their workspace path is exact display-only owner data (sanitized, never
 * resolved or otherwise used), and a stale observation is marked as stale
 * rather than refreshed, reconnected, or guessed.
 *
 * The Saved picker can also browse ONE selected owner host's Saved history.
 * It always opens on Local with a blank query; its Host line appears only while
 * an attached snapshot describes a connected Saved-capable destination, and an
 * ACTUAL Host change clears the query and every result. A remote choice shows
 * the owner's exact rows (id, saved file path, caption, workspace) through the
 * same row/details/confirmation formatter as a local row, reached through
 * bounded windows (at most three retained) over the owner's FULL result with
 * absolute wrap navigation; uncached indexes are non-actionable loading
 * placeholders. Remote rows and actions are a closed, separate family of
 * intents (`saved-remote-*`) naming only opaque owner catalog/result/entry
 * handles and the exact owner run; Resume and Delete-prepare require the
 * actual-written picker frame (`settleSavedPickerRender`) and Delete the
 * written confirmation. Delete hints and acceptance follow the OWNER's live
 * delete exposure only. This module still performs no IO: Main transports.
 *
 * `renderPeerAlert` is the one extra notification surface, for a host-owned
 * alert band that the compositor places when the normal sidebar cannot show a
 * pending request (hidden pane, or narrow layout while Main has focus). It is
 * bounded, never renders confirmation controls, mints no consent frame token,
 * and changes no focus or ownership; the settled consent-frame API above is
 * unchanged.
 *
 * Stable DTO/API surface for future root-host phases: `SidebarItem`,
 * `SidebarAction`, `SidebarControllerOptions`, `SidebarMainOwnerKey`, and
 * `SidebarController` with the getters/setters documented below. Internal
 * shapes may evolve.
 */

import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  getKeybindings,
  isKeyRelease,
  isKeyRepeat,
  Input,
  type AutocompleteProvider,
  type KeyId,
  matchesKey,
  parseKey,
  truncateToWidth,
  visibleWidth,
} from "pi-session-host-tui";
import { resolve } from "node:path";
import {
	createSessionHostTextField,
	type SessionHostFieldOptions,
	type SessionHostFieldRejection,
	type SessionHostFieldRender,
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
  PeerSavedUiAction,
  PeerUiAction,
  PeerUiConsent,
  PeerUiHost,
  PeerUiHostSaved,
  PeerUiSettings,
  PeerUiSnapshot,
  PeerUiTrustedPeer,
} from "./peer-ui-protocol";
import { isOwnerSavedWindowFacts, type OwnerSavedWindowFacts } from "./network/peer-saved";

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
 * One remote roster row exactly as the coordinator projected it. This is the
 * SAME display DTO the Network pane renders, never a private owner view.
 */
export type SidebarRemoteRosterRow = NonNullable<PeerUiHost["roster"]["rows"]>[number];

/**
 * Structured identity and display facts of one remote card projected into the
 * LEFT roster. It is derived from the attached `PeerUiSnapshot` during entry
 * rebuild and is not another manager, authority, or cache: `hostId` and the
 * row are DTO values, `hostLabel` is the owner's sanitized friendly label, and
 * `hostRunId` is the exact opaque owner run the coordinator reported for this
 * host's projection — or `null` when an older DTO/fake carries none. Nothing
 * here is normalized, defaulted, or guessed.
 */
export interface SidebarRemoteEntry {
  readonly hostId: string;
  readonly hostLabel: string;
  readonly hostRunId: string | null;
  readonly rosterState: "current" | "stale";
  readonly row: SidebarRemoteRosterRow;
}

/**
 * Structured identity of the conversation Main is ACTUALLY displaying. It is
 * deliberately independent of the left-roster highlight: Main marks the real
 * content owner here, and a remote owner can never be mistaken for a local
 * item id (or vice versa). `hostRunId` is the exact observed owner run or
 * `null` when no run was observed.
 */
export type SidebarMainOwnerKey =
  | { readonly kind: "local"; readonly id: string }
  | {
      readonly kind: "remote";
      readonly hostId: string;
      readonly hostRunId: string | null;
      readonly rowId: string;
    };

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
  /**
   * Ordinary Enter/normal left press on one projected remote roster card.
   * `hostRunId` is the exact opaque owner run observed when that card was
   * projected, or `null` when the DTO carried none. It is a display-selection
   * intent for Main only: never a local select, resume, create, stop, remove,
   * rename, quit, consent, connect, or trust change.
   */
  | {
      readonly type: "select-remote";
      readonly hostId: string;
      readonly hostRunId: string | null;
      readonly rowId: string;
    }
  | { readonly type: "remove"; readonly id: string }
  /**
   * Ordinary `d`/Delete on the remote card the left roster actually drew as its
   * complete highlight. It names the owner's frozen run and row and nothing
   * else: it is not a local stop/removal, not a confirmation, and not authority.
   * Main independently proves that this exact row is the written highlight
   * before it asks the owner anything.
   */
  | {
      readonly type: "remote-close-request";
      readonly hostId: string;
      readonly hostRunId: string | null;
      readonly rowId: string;
    }
  /**
   * One deliberate confirmation of the frozen remote-close target, emitted
   * while that exact dialog frame is still current and written. `generation`
   * and `renderToken` are the frozen intent; Main's own synchronous recheck and
   * one-shot consumption decide whether anything is sent.
   */
  | {
      readonly type: "remote-close-confirmed";
      readonly hostId: string;
      readonly hostRunId: string;
      readonly rowId: string;
      readonly generation: number;
      readonly renderToken: number;
    }
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
  /**
   * One deliberate REMOTE New submission: exactly the destination host, the
   * exact owner run this form's Host line named, the canonical workspace text
   * the form held, and the frozen id of the New-form frame the writer actually
   * wrote. It is never a local `create`, never a connect, and Main never
   * re-derives any field of it from a later roster index, label, or selection.
   */
  | {
      readonly type: "create-on-peer";
      readonly requestId: number;
      readonly formGeneration: number;
      readonly renderToken: number;
      readonly hostId: string;
      readonly hostRunId: string;
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
  | PeerUiAction
  /**
   * Remote Saved picker intents for the selected owner host. They are a closed,
   * separate family: no remote row or action ever becomes a local `saved-open`,
   * `saved-delete*`, `saved-search`, or `saved-list`, even when its id, file, or
   * caption equals a local one.
   */
  | PeerSavedUiAction;

/**
 * The Saved picker's current Host choice, as drawn. Local is the default at
 * every opening. A remote choice carries the exact observed owner run (or null),
 * whether the destination is still connected, and the OWNER's descriptive Saved
 * support and live delete exposure. Display facts only; nothing here is authority.
 */
export type SidebarSavedPickerHost =
  | { readonly kind: "local" }
  | {
      readonly kind: "remote";
      readonly hostId: string;
      readonly label: string;
      readonly hostRunId: string | null;
      readonly connected: boolean;
      readonly supported: boolean;
      readonly deleteExposed: boolean | null;
    };

/**
 * Read-only description of the remote Saved picker for Main: the exact picker,
 * query revision and text, selected destination/run, the bound owner
 * catalog/result (when one completed), the FULL result total, the absolute
 * selection, the bounded retained windows, and the newest outstanding read
 * request ids. It is a view, never authority.
 */
export interface SidebarRemoteSavedContext {
  readonly pickerId: number;
  readonly revision: number;
  readonly query: string;
  readonly hostId: string;
  readonly hostRunId: string | null;
  readonly catalogId: string | undefined;
  readonly resultId: string | undefined;
  readonly total: number | undefined;
  readonly issueCount: number;
  readonly selectedIndex: number;
  readonly windows: readonly { readonly offset: number; readonly length: number }[];
  readonly pendingReads: readonly number[];
}

/**
 * The one remote Saved picker frame the last complete render drew: the exact
 * picker/revision/host/run/catalog/result, the absolute selection, the pane
 * geometry, and every completely drawn row's absolute index and opaque owner
 * entry id (loading placeholders are never drawn rows). Main captures it beside
 * the composed frame and settles it through `settleSavedPickerRender` ONLY when
 * its writer reports that exact frame written; until then no Resume or
 * Delete-prepare can be emitted from it.
 */
export interface SidebarSavedPickerPresentation {
  readonly renderToken: number;
  /**
   * Monotonic Saved view epoch this frame was drawn under. Every actual
   * selection change, new query/result, Host or run change, and eviction of the
   * selected row advances it, so a frame (or an operation frozen from it) can
   * never regain authority by returning to identical values.
   */
  readonly viewEpoch: number;
  readonly pickerId: number;
  readonly revision: number;
  readonly hostId: string;
  readonly hostRunId: string;
  readonly catalogId: string;
  readonly resultId: string;
  readonly total: number;
  readonly selectedIndex: number;
  readonly selectedEntryId: string | undefined;
  readonly deleteExposed: boolean;
  readonly cols: number;
  readonly rows: number;
  readonly drawn: readonly { readonly paneRow: number; readonly index: number; readonly entryId: string }[];
}

/** The completed owner window facts the sidebar accepts (the wire's `window` fact set). */
export type SidebarRemoteSavedWindowFacts = Extract<OwnerSavedWindowFacts, { readonly kind: "window" }>;

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
  /**
   * The exact remote card this render drew as the complete left-roster
   * highlight, or undefined when the highlight was not a fully drawn remote
   * row (tiny/clipped fallback, another pane, hidden, or a non-remote entry).
   * It is the minimal frozen owner target plus the drawn row/geometry and the
   * condensed local preflight facts of that same drawn row. It grants nothing:
   * Main requires the writer's own written receipt for this exact value before
   * any Close is requested, and the owner host revalidates its own row.
   */
  readonly remoteClose: SidebarRemoteCloseRow | undefined;
  /** Activates only entries captured by the exact sidebar render this token represents. */
  activateRosterAt(column: number, row: number, cols: number, rows: number): boolean;
  /** Activates only saved rows captured by the exact sidebar render this token represents. */
  activateSavedAt(column: number, row: number, cols: number, rows: number): boolean;
  /**
   * Activates only a network-menu row the captured render actually drew, using
   * the network pane's ordinary Enter action.
   */
  activatePeerAt(column: number, row: number, cols: number, rows: number): boolean;
  /**
   * Dispatches one press inside the form-slot pane (the wide right pane or the
   * narrow full-content form) to whichever pane that captured render actually
   * drew: the Saved picker or the Network menu. A render never draws both, so
   * exactly one map — if either — can act.
   */
  activateFormRowAt(column: number, row: number, cols: number, rows: number): boolean;
  /**
   * Activates only the Host line the captured New-form render actually drew:
   * a press on the drawn value cycles that one selection, and a press elsewhere
   * on that same drawn row only focuses it. Any other row, geometry, or option
   * list refuses, so an invisible or since-changed control can never act.
   */
  activateFormHostAt(column: number, row: number, cols: number, rows: number): boolean;
}

/**
 * One written left-roster highlight of a remote card, captured at render time.
 *
 * This is deliberately NOT the sidebar's activation identity, authorization
 * key, or content key: those embed the native conversation tuple, lifecycle,
 * labels, and stream identity, and a Close needs none of them. It carries only
 * the minimal owner target ({hostId, hostRunId, rowId}), the drawn row/geometry
 * of the complete highlighted card, its display labels, and the condensed local
 * preflight facts of that same drawn row.
 */
export interface SidebarRemoteCloseRow {
  /** Local saved-destination handle of the owner host. */
  readonly hostId: string;
  /** Exact observed owner run, or null when the projection carries none. */
  readonly hostRunId: string | null;
  /** Exact owner row id within that run. */
  readonly rowId: string;
  /** Pane row and complete card height this render actually drew. */
  readonly row: number;
  readonly height: number;
  /** Pane geometry the card was drawn in. */
  readonly cols: number;
  readonly rows: number;
  /** Focus domain of that render; only a roster-owned highlight can act. */
  readonly focus: SidebarFocus;
  /** Drawn lifecycle/process observation of this same row. */
  readonly lifecycle: SidebarItem["lifecycle"];
  readonly hasLiveProcess: boolean;
  /** Existing complete-idle preflight over this same drawn row's facts. */
  readonly idle: boolean;
  /** Bounded display title of the drawn card (UI only, never identity). */
  readonly title: string;
  /** Bounded display friendly label of the owner host (UI only). */
  readonly hostLabel: string;
}

export interface SidebarFieldFactoryOptions {
  /**
   * `plain` is bounded OWNER text: the ordinary workspace field bound (the same
   * 2048 code points the rowless create contract carries) with no local
   * filesystem completion at all. It exists so a remote workspace can be typed
   * as canonical raw text for the OWNER's filesystem without the rename field's
   * tighter name bound and without this machine reading any path.
   */
  readonly kind: "name" | "path" | "plain";
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
 * The no-completion provider installed on a plain owner-entry field. Text the
 * operator types is canonical input for the OWNER's filesystem, so this side
 * never completes, lists, resolves, or reads any path: this provider has no
 * suggestions and never asks the native Editor for a file branch.
 */
const NO_LOCAL_COMPLETION_PROVIDER: AutocompleteProvider = {
  triggerCharacters: [],
  async getSuggestions(): Promise<null> { return null; },
  applyCompletion(lines: string[], cursorLine: number, cursorCol: number) {
    return { lines, cursorLine, cursorCol };
  },
  shouldTriggerFileCompletion(): boolean { return false; },
};

/** Options for one plain owner-entry workspace field; the kind is fixed. */
export type PlainOwnerWorkspaceFieldOptions =
  Omit<SessionHostFieldOptions, "kind" | "workspaceBasePath" | "maxNameBytes">
  & { readonly workspaceBasePath: string };

/**
 * Build one plain OWNER-entry workspace field: the ordinary workspace text bound
 * (2048 code points, exactly the bound the rowless create contract carries) with
 * no local filesystem completion at all. It is the ordinary path field whose
 * completion provider is replaced for the WHOLE field lifetime, so nothing on
 * this machine is ever read, listed, resolved, or offered as a suggestion. The
 * LOCAL New form's path field and every rename/name field stay untouched.
 */
export function createPlainOwnerWorkspaceField(
  options: PlainOwnerWorkspaceFieldOptions,
): SessionHostTextField {
  const field = createSessionHostTextField({ ...options, kind: "path" });
  // The field re-installs its retained provider on cancel/settle, so replacing
  // that retained provider (not only the Editor's current one) is what keeps
  // this machine's filesystem out of the field for its whole lifetime.
  (field as unknown as { autocompleteProvider?: AutocompleteProvider }).autocompleteProvider =
    NO_LOCAL_COMPLETION_PROVIDER;
  field.editor.setAutocompleteProvider(NO_LOCAL_COMPLETION_PROVIDER);
  return field;
}

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
    | "remote"
    | "saved"
    | "new"
    | "quit"
    | "settings"
    | "diagnostics"
    | "peer";
  readonly item?: SidebarItem;
  /** Structured remote facts; present only for kind "remote". */
  readonly remote?: SidebarRemoteEntry;
  /** Warning snapshot rendered by a `diagnostics` entry (display and clear fence). */
  readonly warning?: TerminalDiagnosticsWarningView;
}

/**
 * Stable composite key for one remote card: owner host id plus owner row id,
 * length-prefixed so two different (host, row) pairs can never share a key even
 * when either value contains separators. The structured `SidebarRemoteEntry`
 * fields remain the authority for what a card names; this key is only map,
 * expansion, and selection identity.
 */
export function remoteRosterEntryKey(hostId: string, rowId: string): string {
  return `${REMOTE_ENTRY_KEY_PREFIX}${hostId.length}:${hostId}:${rowId}`;
}

/** Exact native-session tuple/epoch identity, or null when none was observed. */
function remoteNativeSessionIdentity(row: SidebarRemoteRosterRow): readonly [string, number] | null {
  const native = row.nativeSession;
  return native === null ? null : [native.sessionId, native.epoch];
}

/**
 * True when a captured remote card still names the same owner target: the same
 * host, the same exact (or absent) owner run, the same owner row id, the same
 * lifecycle/process observation, the same native-session tuple/epoch, and the
 * same current-vs-stale observation. Display-only facts (activity, counts,
 * error text) are not target identity.
 */
function sameRemoteEntry(a: SidebarRemoteEntry, b: SidebarRemoteEntry): boolean {
  return a.hostId === b.hostId
    && a.hostRunId === b.hostRunId
    && a.rosterState === b.rosterState
    && a.hostLabel === b.hostLabel
    && a.row.id === b.row.id
    && a.row.lifecycle === b.row.lifecycle
    && a.row.hasLiveProcess === b.row.hasLiveProcess
    && JSON.stringify(remoteNativeSessionIdentity(a.row))
      === JSON.stringify(remoteNativeSessionIdentity(b.row));
}

function remoteEntryActivationIdentity(entryKey: string, remote: SidebarRemoteEntry): readonly unknown[] {
  return [entryKey, "remote", remote.hostId, remote.hostRunId, remote.rosterState,
    remote.hostLabel, remote.row.id, remote.row.lifecycle, remote.row.hasLiveProcess,
    remoteNativeSessionIdentity(remote.row)];
}

// updateItems rebuilds bounded DTO snapshots even when their content is
// unchanged; a skipped frame may keep the prior emitted map active. Compare
// the activation identity and safety state, not display/telemetry metadata.
function sameSidebarEntry(a: SidebarEntry, b: SidebarEntry): boolean {
  if (a.key !== b.key || a.kind !== b.kind) return false;
  if (a.kind === "remote" || b.kind === "remote") {
    return a.remote !== undefined && b.remote !== undefined && sameRemoteEntry(a.remote, b.remote);
  }
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
  if (entry.kind === "remote" && entry.remote !== undefined) {
    return remoteEntryActivationIdentity(entry.key, entry.remote);
  }
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
  /**
   * Present ONLY for a row of the selected REMOTE owner: the opaque owner handles
   * that are its sole operation identity. A local row never carries it, and a
   * remote row is never matched to anything by its display id, file, or caption.
   */
  readonly remote?: RemoteSavedRowIdentity;
}

interface DisplayedSavedRows {
  readonly cols: number;
  readonly rows: number;
  readonly entries: readonly DisplayedSavedRow[];
  /** Remote picker frame token of the render that drew these rows (remote only). */
  readonly renderToken?: number;
}

/** Opaque owner identity of one remote Saved row. Never a path or a local id. */
interface RemoteSavedRowIdentity {
  readonly hostId: string;
  readonly hostRunId: string;
  readonly catalogId: string;
  readonly resultId: string;
  readonly entryId: string;
}

/** One cached owner row: its opaque entry handle plus the exact display row. */
interface RemoteSavedRow {
  readonly entryId: string;
  readonly row: SidebarSavedRow;
}

/** One bounded contiguous window of ONE owner result, at its absolute offset. */
interface RemoteSavedWindow {
  readonly offset: number;
  readonly rows: readonly RemoteSavedRow[];
}

/** One read intent this picker emitted and still awaits. */
interface RemoteSavedReadIntent {
  readonly requestId: number;
  readonly kind: "list" | "search" | "window";
  readonly revision: number;
  readonly hostRunId: string;
  readonly catalogId: string | undefined;
  readonly resultId: string | undefined;
  readonly offset: number;
  readonly count: number;
}

/**
 * The selected remote host's picker state. Only the CURRENT owner result is
 * kept, as at most `REMOTE_SAVED_MAX_WINDOWS` bounded windows: nothing
 * accumulates a whole catalog, a history, or another host's rows.
 */
interface RemoteSavedState {
  readonly hostId: string;
  /** Owner run the bound catalog (and any outstanding result read) belongs to. */
  catalog: { readonly hostRunId: string; readonly catalogId: string } | undefined;
  result: {
    readonly resultId: string;
    readonly total: number;
    readonly issueCount: number;
  } | undefined;
  windows: RemoteSavedWindow[];
  /** Outstanding list/search that defines the next result (newest only). */
  resultRead: RemoteSavedReadIntent | undefined;
  /** Outstanding window reads of the current result (bounded, newest last). */
  windowReads: RemoteSavedReadIntent[];
}

/**
 * One frozen remote entry operation (Resume, Delete-prepare, or the Delete it
 * confirms): the exact picker, query revision, destination, run, owner
 * catalog/result/entry handles, the absolute index it was drawn at, the drawn
 * frame token, and the display row the operator saw (text only, never identity).
 */
interface RemoteSavedOperation {
  readonly pickerId: number;
  readonly requestId: number;
  readonly revision: number;
  readonly hostId: string;
  readonly hostRunId: string;
  readonly catalogId: string;
  readonly resultId: string;
  readonly entryId: string;
  /** Absolute result index of the acted-on entry (a press may name a non-selected drawn row). */
  readonly index: number;
  /** The selection when the operation was frozen; a press never moves it. */
  readonly selectedIndex: number;
  /** Saved view epoch the operation was frozen under; any advance retires it for good. */
  readonly viewEpoch: number;
  readonly renderToken: number;
  readonly row: SidebarSavedRow;
  readonly hostLabel: string;
}

/** The current remote picker frame candidate (writer receipt pending until settled). */
interface SavedPickerCandidate {
  readonly token: number;
  readonly identity: string;
  readonly presentation: SidebarSavedPickerPresentation;
  written: boolean;
}

/** One Host choice the Saved picker's Host line can name. */
interface SavedHostOption {
  readonly kind: "local" | "remote";
  readonly hostId: string;
  readonly label: string;
  readonly hostRunId: string | null;
  readonly connected: boolean;
  readonly supported: boolean;
  readonly deleteExposed: boolean | null;
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
  readonly selectedKey: string | undefined;
}

/**
 * One Host choice the New form's single Host line can name. `hostId` is the
 * local saved-destination handle (never a native instance id, endpoint, label,
 * index, or fingerprint), and `hostRunId` is the EXACT owner run the attached
 * DTO reported for that destination's last complete observation — or `null`
 * when no run was observed, which is never guessed.
 */
interface NewFormHostOption {
  readonly kind: "local" | "remote";
  readonly hostId: string;
  readonly label: string;
  readonly hostRunId: string | null;
  /** False for a chosen destination a later observation no longer reports. */
  readonly connected: boolean;
}

/** Stable identity of one Host choice: Local, or one saved destination. */
function newFormHostOptionKey(option: { readonly kind: "local" | "remote"; readonly hostId: string }): string {
  return option.kind === "local" ? "local" : `remote:${option.hostId}`;
}

/**
 * The exact New-form frame one render actually drew, retained so a NEW form
 * submission can require the writer's own receipt for it instead of relying on
 * any later render, DTO, or selection. `written` becomes true only when Main's
 * frame writer reports THIS candidate as written.
 *
 * `workspace` is the field value that was drawn, so a source-only change whose
 * visible bytes were clipped away still mints a new candidate and needs its own
 * written boundary before anything may be sent.
 */
interface CreateFormCandidate {
  readonly token: number;
  /** Complete identity of the drawn form; an identical redraw keeps this entry. */
  readonly identity: string;
  readonly formGeneration: number;
  readonly hostKind: "local" | "remote";
  readonly hostId: string;
  readonly hostRunId: string | null;
  readonly workspace: string;
  /** Pane geometry this candidate was composed at. */
  readonly cols: number;
  readonly rows: number;
  written: boolean;
}

/** The frozen public description of one drawn New-form candidate. */
export interface SidebarCreateFormPresentation {
  readonly formGeneration: number;
  readonly renderToken: number;
  readonly hostKind: "local" | "remote";
  readonly hostId: string;
  readonly hostRunId: string | null;
  readonly workspace: string;
  readonly cols: number;
  readonly rows: number;
}

/**
 * One Host line drawn completely in a New-form pane, with the pane geometry and
 * the exact column span its value occupied, so a pointer target is written
 * geometry rather than an inferred row. `optionKey` binds the drawn option list
 * and selection, so a press can never act on a list that changed behind the
 * frame the operator saw.
 */
interface DisplayedFormHostRow {
  /** Which form-slot pane drew this Host line: the New form or the Saved picker. */
  readonly pane: "new" | "saved";
  readonly cols: number;
  readonly rows: number;
  readonly row: number;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly optionKey: string;
  /** New-form generation, or the Saved picker id that drew the line. */
  readonly formGeneration: number;
}

/** One remote roster row exactly as the coordinator projected it (display only). */
type PeerRosterRow = SidebarRemoteRosterRow;

/**
 * The semantic state one actionable network row's ordinary Enter action reads:
 * a flat list of primitives captured with the row when the pane renders it.
 *
 * Toggles act on the opposite of the state that was drawn, and Apply rows send
 * the local drafts that were shown, so a captured pointer target must bind the
 * intent itself and not merely the row's stable key. Otherwise a snapshot or a
 * draft change behind an unwritten frame could make a press run the opposite
 * action or send values the operator never saw. A press whose intent no longer
 * matches refuses instead of reinterpreting the row.
 */
type PeerPaneRowIntent = readonly (string | number | boolean | null)[];

/** The row kinds whose Enter action changes state rather than showing information. */
type PeerActionRowKind =
  | "toggle-hosting"
  | "edit-bind-host"
  | "edit-bind-port"
  | "apply-hosting"
  | "toggle-auto"
  | "toggle-bell"
  | "toggle-viewer-input"
  | "toggle-history-delete"
  | "add-host"
  | "edit-add-label"
  | "edit-add-host"
  | "edit-add-port"
  | "apply-add";

/** Selectable network-panel rows; remote rows are a separate typed kind. */
type PeerPaneRow =
  | {
      readonly kind: PeerActionRowKind;
      readonly key: string;
      readonly intent: PeerPaneRowIntent;
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

/**
 * One bounded network field editor: an explicit listen value, or exactly one
 * part of the local Add-destination draft. A purpose never edits two fields.
 */
type PeerFieldPurpose = "bind-host" | "bind-port" | "add-label" | "add-host" | "add-port";

/** Which Add-destination part a purpose edits; undefined for a listen field. */
function peerAddFieldOf(purpose: PeerFieldPurpose): "label" | "host" | "port" | undefined {
  if (purpose === "add-label") return "label";
  if (purpose === "add-host") return "host";
  if (purpose === "add-port") return "port";
  return undefined;
}

function peerAddFieldLabel(field: "label" | "host" | "port"): string {
  return field === "label" ? "Destination name" : field === "host" ? "Host" : "Port";
}

interface DisplayedPeerRows {
  readonly cols: number;
  readonly rows: number;
  readonly signature: string;
  readonly selectedKey: string | undefined;
  readonly entries: readonly DisplayedPeerRow[];
}

/**
 * One network-menu row paired with the pane row it was actually drawn on, so a
 * pointer target is the written geometry and row identity rather than an index
 * a later snapshot could reinterpret.
 */
interface DisplayedPeerRow {
  readonly paneRow: number;
  readonly row: PeerPaneRow;
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

/**
 * Frozen remote-close target: the minimal owner identity a Close names plus the
 * bounded display labels of the card the operator actually saw. The labels are
 * UI text only; no comparison or authorization ever reads them.
 */
interface FrozenRemoteCloseTarget {
  readonly hostId: string;
  readonly hostRunId: string;
  readonly rowId: string;
  readonly title: string;
  readonly hostLabel: string;
}

/**
 * The exact remote-close dialog candidate: frozen target + monotonic
 * confirmation generation + complete pane geometry + the control rows that
 * were actually emitted. Any new generation or moved control mints a new
 * token instead of inheriting the previous written proof.
 */
interface DisplayedRemoteClose {
  readonly identity: string;
  readonly generation: number;
  readonly token: number;
  readonly cols: number;
  readonly rows: number;
  readonly target: FrozenRemoteCloseTarget;
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
      // Actionable rows bind their drawn semantic intent, so a captured pointer
      // target can never run the opposite or unseen action.
      return [row.key, row.kind, row.intent];
  }
}

/** True when a captured drawn row still names the same current pane target. */
function samePeerPaneRow(a: PeerPaneRow, b: PeerPaneRow): boolean {
  return JSON.stringify(peerPaneRowIdentity(a)) === JSON.stringify(peerPaneRowIdentity(b));
}

/**
 * True when a captured pointer map is still the map the pane currently draws:
 * the same pane geometry, the same drawn ordering, and every written row still
 * on its own written pane row. Row identity alone is not enough — a stable key
 * that scrolled, reordered, or re-flowed to a different row would otherwise let
 * an old coordinate activate whatever now sits under it.
 */
function sameDisplayedPeerRows(
  captured: DisplayedPeerRows,
  current: DisplayedPeerRows,
): boolean {
  if (captured.cols !== current.cols || captured.rows !== current.rows
    || captured.signature !== current.signature
    || captured.entries.length !== current.entries.length) return false;
  return captured.entries.every((entry, index) => {
    const live = current.entries[index];
    return live !== undefined && entry.paneRow === live.paneRow
      && samePeerPaneRow(entry.row, live.row);
  });
}

function mouseAuthorizationKey(
  roster: DisplayedRoster | undefined,
  saved: DisplayedSavedRows | undefined,
  peer: DisplayedPeerRows | undefined,
  consent: DisplayedPeerConsent | undefined,
  consentRendered: boolean,
  formHost: DisplayedFormHostRow | undefined,
): string {
  return JSON.stringify({
    roster: roster === undefined ? null : [roster.cols, roster.rows,
      [...roster.regions.values()].map((region) => [region.row, region.height, sidebarActivationIdentity(region.entry)])],
    // Local rows keep their exact identity; a remote row adds its opaque owner
    // handles and the drawn picker frame token, so equal display text on two
    // hosts (or on a local and a remote row) can never share authorization.
    saved: saved === undefined ? null : [saved.cols, saved.rows,
      saved.entries.map(({ paneRow, entry, remote }) => remote === undefined
        ? [paneRow, entry.id, entry.file]
        : [paneRow, entry.id, entry.file, remote.hostId, remote.hostRunId,
          remote.catalogId, remote.resultId, remote.entryId]),
      ...(saved.renderToken === undefined ? [] : ["remote", saved.renderToken])],
    // Network-panel targets and the consent dialog's decision geometry are part
    // of the authorization identity: a presentation captured from a frame with
    // different peer/consent targets can never authorize the current one.
    peer: peer === undefined ? null : [peer.cols, peer.rows, peer.signature,
      peer.entries.map((entry) => [entry.paneRow, ...peerPaneRowIdentity(entry.row)])],
    consent: consent === undefined || !consentRendered ? null : [
      consent.token, consent.consentId, consent.choice, consent.cols, consent.rows,
      consent.approveRow, consent.denyRow,
    ],
    // The New form's Host line is a written pointer target like every other
    // host-owned row: its drawn row, value span, and option list are part of
    // the authorization identity, so a moved or re-labeled control needs its
    // own written boundary.
    formHost: formHost === undefined ? null : [
      formHost.pane, formHost.cols, formHost.rows, formHost.row, formHost.valueStart, formHost.valueEnd,
      formHost.optionKey, formHost.formGeneration,
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

/**
 * The common picker row for one REMOTE owner entry, built by the same copy rule
 * `sanitizeSavedRows` applies to a local row: the owner's session id becomes the
 * row id and its saved file path is kept exactly (it is display identity only,
 * never resolved, opened, or used as authority here), while the caption and
 * recorded workspace take the same bounded presentation copy. An empty `cwd` is
 * "unavailable", exactly like a local row without a recorded workspace. Unlike a
 * local catalog copy, no entry is ever dropped: a remote window is positional, so
 * every index of the owner result stays aligned.
 */
function remoteSavedDisplayRow(entry: {
  readonly sessionId: string;
  readonly file: string;
  readonly caption: string;
  readonly cwd: string;
}): SidebarSavedRow {
  return {
    id: entry.sessionId,
    file: entry.file,
    caption: sanitizeBounded(entry.caption, SAVED_CAPTION_MAX_CODEPOINTS),
    ...(entry.cwd.length > 0 ? { cwd: sanitizeBounded(entry.cwd, SAVED_WORKSPACE_MAX_CODEPOINTS) } : {}),
  };
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
/**
 * Fixed, bounded notices for a remote New submission this side refuses BEFORE
 * anything is sent. They describe only what is known locally: the form that was
 * not the written one, a destination that is no longer connected, and an owner
 * run that was never observed. No dialog, path, exception text, reconnect,
 * regrant, or retry is claimed or offered.
 */
export const CREATE_ON_PEER_UNWRITTEN_NOTICE =
  "That New session form is not the displayed form; nothing was sent";
export const CREATE_ON_PEER_TARGET_CHANGED_NOTICE =
  "That destination is disconnected or gone; nothing was sent";
export const CREATE_ON_PEER_NO_RUN_NOTICE =
  "That destination's owner run was not observed; nothing was sent";
export const CREATE_ON_PEER_OTHER_RUN_NOTICE =
  "The remote host reported a different owner run; nothing was selected";
export const CREATE_ON_PEER_UNCERTAIN_NOTICE =
  "UNCERTAIN: the remote create may have been handed off; outcome unknown";
/**
 * Fixed, bounded notices for the selected-host Saved picker. Each states only
 * what this side knows locally; none claims an owner outcome, a retry, a
 * reconnect, a cancellation, or a path, and no raw error text is shown.
 */
export const REMOTE_SAVED_UNWRITTEN_NOTICE =
  "That Saved list is not the displayed list; nothing was sent";
export const REMOTE_SAVED_HOST_CHANGED_NOTICE =
  "That host disconnected or its owner run changed; its Saved list was cleared and nothing was requested";
export const REMOTE_SAVED_UNSUPPORTED_NOTICE =
  "That host does not offer Saved history; nothing was requested";
export const REMOTE_SAVED_NO_RUN_NOTICE =
  "That host's owner run was not observed; nothing was requested";
export const REMOTE_SAVED_DISCONNECTED_NOTICE =
  "That host is disconnected; nothing was requested";
export const REMOTE_SAVED_DELETE_OFF_NOTICE =
  "That host does not allow remote history deletion; nothing was deleted";
export const REMOTE_SAVED_OTHER_RUN_NOTICE =
  "The remote host reported a different owner run; nothing was selected";
export const REMOTE_SAVED_UNCERTAIN_NOTICE =
  "UNCERTAIN: the remote request may have been handed off; outcome unknown";
/** The one Host line of the New form names Local until the operator changes it. */
const NEW_FORM_LOCAL_HOST_LABEL = "Local";
const NEW_FORM_HOST_PREFIX = "Host: ";
/** Native-session card heights: title, status, background (+2 activity). */
const CARD_COLLAPSED_ROWS = 3;
const CARD_EXPANDED_ROWS = 5;
const ACTIVITY_LINES_MAX = CARD_EXPANDED_ROWS - CARD_COLLAPSED_ROWS;
/** Projected remote cards add exactly one indented owner-host line under the title. */
const REMOTE_CARD_COLLAPSED_ROWS = CARD_COLLAPSED_ROWS + 1;
const REMOTE_CARD_EXPANDED_ROWS = CARD_EXPANDED_ROWS + 1;
const ACTIVITY_INPUT_MAX_CODEPOINTS = 400;
const SAVED_CAPTION_MAX_CODEPOINTS = 256;
const MAX_SAVED_QUERY_DISPLAY_CODEPOINTS = 4096;
/** Bounded recorded-workspace (cwd) display limit; the raw catalog keeps the full value for admission. */
const SAVED_WORKSPACE_MAX_CODEPOINTS = 4096;
/** Fixed reserved details-area height between the saved list and the footer. */
const SAVED_DETAILS_ROWS = 3;
/**
 * Remote Saved window sizing reuses the EXISTING metadata-lane bounds instead of
 * inventing a business limit: a request asks for at least one lane page
 * (`maxRowsPerPage`, 32) and at most one transfer's row bound
 * (`maxSnapshotRows`, 4096), otherwise the drawn list height. The owner may
 * still return a shorter honest prefix when its byte budget is reached.
 */
const REMOTE_SAVED_PAGE_ROWS = 32;
const REMOTE_SAVED_MAX_WINDOW_ROWS = 4096;
/** At most the current window and its neighbours are retained (no catalog accumulation). */
const REMOTE_SAVED_MAX_WINDOWS = 3;
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
/** Namespace of projected remote cards; never a local item id namespace. */
const REMOTE_ENTRY_KEY_PREFIX = "remote:";
/** Network menu key; present only with an attached snapshot. */
const ENTRY_PEER_KEY = "peer-network";
/** Fixed height of the host-owned terminal diagnostics warning entry. */
const DIAGNOSTICS_ENTRY_ROWS = 3;
/**
 * Fixed height of the prominent incoming-consent band: heading, name, key
 * fingerprint, origin endpoint, remaining human window, and the review hint.
 * The band is reserved OUTSIDE the scrolling roster so it stays visible while
 * later rows are selected; it never collapses into a tiny indicator. Main also
 * reserves bounded compositor rows when a form or confirmation obscures this
 * roster notice; that notification surface grants no approval authority.
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
/**
 * Fresh-start listen suggestion shown as editable draft text
 * when a KNOWN settings snapshot has no saved listen address/port. It is a
 * local UI draft only: never written to the settings DTO or the store, never
 * sent unless the operator acts, and never substituted while settings are
 * unknown, unavailable, or unsafe.
 */
const PEER_DEFAULT_LISTEN_HOST = "*";
const PEER_DEFAULT_LISTEN_PORT = "8088";
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

/**
 * Standard Shift+Tab, as the pinned matcher identifies it. The canonical xterm
 * back-tab packet is accepted as the same gesture because that legacy encoding
 * carries no modifier bits, exactly like the ordinary F-key packets above.
 */
function matchesShiftTab(data: string): boolean {
  return matchesKey(data, asHostKeyId("shift+tab")) || data === "\x1b[Z";
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
 * The rows one labeled native field occupies, in pane order.
 *
 * The label belongs beside the field's editable body row, which the field
 * adapter reports from the pinned Editor's own layout contract: the public
 * Editor renders its top border first and its editable rows after it, so the
 * body row is structural and never the caret. The label therefore stays put
 * while the caret moves within the field or a value wraps over several rows.
 * Every other row keeps the same-width gutter, so the value column, the native
 * cursor geometry, the Editor's clipping, and its tiny-pane refusal stay exactly
 * as the field rendered them. All session-host field panes (New/Edit, Host
 * shortcuts, and the Network listen/Add-destination editors) place their label
 * through this one seam instead of assuming row 0.
 *
 * A frame whose row budget never reaches the Editor's body row returns
 * undefined: callers keep their existing truthful too-small refusal rather than
 * labelling a border row or forcing out-of-range native geometry into range.
 */
function labeledFieldRows(
  frame: SessionHostFieldRender,
  rowCount: number,
  prefix: string,
  prefixWidth: number,
  cols: number,
): string[] | undefined {
  const bodyRow = frame.contentRow;
  if (!Number.isSafeInteger(bodyRow) || bodyRow < 0 || bodyRow >= rowCount) return undefined;
  const gutter = " ".repeat(prefixWidth);
  const rows: string[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const source = frame.lines[index] ?? "";
    rows.push(wrapRow(index === bodyRow ? `${prefix}${source}` : `${gutter}${source}`, cols));
  }
  return rows;
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

/**
 * The existing card status facts one remote roster DTO exposes. This adapter is
 * the only seam between a remote row and the local card renderer: the same
 * lifecycle/input/activity/unknown facts, no fabricated `SidebarItem` fields
 * (no agent dir, current file, ownership, or exit authority).
 */
function remoteSessionStatusFacts(row: SidebarRemoteRosterRow): SessionStatusFacts {
  return {
    lifecycle: row.lifecycle,
    busy: row.busy,
    pendingInput: row.pendingInput,
    inputSurface: row.inputSurface,
    activeTasks: row.activeTasks,
    activeShells: row.activeShells,
    ...(row.exitCode === undefined ? {} : { exitCode: row.exitCode }),
  };
}

/** Canonical card title facts shared by local items and projected remote rows. */
interface CardTitleFacts {
  readonly label: string;
  readonly nativeSession?: { readonly name: string } | null;
}

/** Canonical card title: validated native name, else the row label. */
function cardTitle(item: CardTitleFacts): string {
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
function isCompleteIdle(item: {
  readonly busy: boolean | null;
  readonly pendingInput: boolean | null;
  readonly inputSurface: boolean;
  readonly backgroundTasks?: number | null;
  readonly backgroundShells?: number | null;
}): boolean {
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
  const viewerNativeInputEnabled = displayBoolean(source.viewerNativeInputEnabled);
  const remoteHistoryDeleteEnabled = displayBoolean(source.remoteHistoryDeleteEnabled);
  const bindHost = displayText(source.bindHost);
  const bindPort = source.bindPort === null ? null : displayPort(source.bindPort);
  // Every setting is a real boolean or the whole settings fact is unknown: a
  // missing flag is never displayed (or acted on) as its default.
  if (hostingEnabled === undefined || autoReconnect === undefined || bellEnabled === undefined
    || viewerNativeInputEnabled === undefined || remoteHistoryDeleteEnabled === undefined
    || bindHost === undefined || bindPort === undefined) return null;
  return {
    hostingEnabled,
    bindHost,
    bindPort,
    autoReconnect,
    bellEnabled,
    viewerNativeInputEnabled,
    remoteHistoryDeleteEnabled,
  };
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

/**
 * A copied host plus the optional owner-run identity the coordinator may report
 * alongside its roster projection. Older DTOs and fakes omit it; absence and
 * `null` both mean "not observed" and never a fabricated run identity.
 */
type SidebarPeerHost = PeerUiHost & {
  readonly roster: PeerUiHost["roster"] & { readonly hostRunId?: string | null };
};

/**
 * The exact opaque owner-run id the coordinator reported for this host's row
 * projection, read with a safe optional presence/type check so an older DTO or
 * a test fake stays backward compatible. The value is returned exactly as
 * observed (never normalized, defaulted, or guessed); anything else is null.
 */
function peerHostRosterRunId(host: PeerUiHost): string | null {
  const roster = host.roster as SidebarPeerHost["roster"];
  const value = roster.hostRunId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function copyPeerHost(value: unknown): SidebarPeerHost | null {
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
  const rosterRun = displayOptionalText(rosterValue?.hostRunId);
  // Optional Saved description: kept only when both facts are well formed. A
  // missing or malformed value is "not supported", never a guessed capability.
  const savedValue = displayObject(source.saved);
  const savedSupported = displayBoolean(savedValue?.supported);
  const savedDeleteExposed = savedValue?.deleteExposed === null
    ? null
    : displayBoolean(savedValue?.deleteExposed);
  const saved: PeerUiHostSaved | undefined = savedSupported !== undefined && savedDeleteExposed !== undefined
    ? { supported: savedSupported, deleteExposed: savedDeleteExposed }
    : undefined;
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
    roster: {
      state: rosterState,
      rows,
      // Preserved only when the coordinator actually reports a nonempty run id.
      ...(typeof rosterRun === "string" && rosterRun.length > 0 ? { hostRunId: rosterRun } : {}),
    },
    ...(saved === undefined ? {} : { saved }),
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
  /** True while the Add-destination field menu replaces the network rows. */
  private peerAddMenuOpen = false;
  private peerFieldTarget: { readonly purpose: PeerFieldPurpose } | undefined;
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
  /**
   * The New form's one Host choice. It is Local at every form opening and is
   * never carried across forms; `label` is a bounded display copy remembered
   * for a destination a later observation stopped listing, and it is never
   * identity — the saved `hostId` (plus the DTO's exact owner run) is.
   */
  private newFormHost:
    | { readonly kind: "local" }
    | { readonly kind: "remote"; readonly hostId: string; readonly label: string } = { kind: "local" };
  /** True only while the New form's Host line owns the form's keyboard focus. */
  private formHostFocused = false;
  /** The Host line the last complete New-form render drew, or undefined. */
  private formHostDisplay: DisplayedFormHostRow | undefined;
  /** The New-form frame the last complete render drew (writer receipt pending). */
  private createFormCandidate: CreateFormCandidate | undefined;
  private createFormTokenSequence = 1;
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
  /**
   * The Saved picker's one Host choice. Local at every opening; an ACTUAL change
   * re-mints the picker identity and clears the query and every result. `label`
   * is a bounded display copy kept for a destination a later observation stopped
   * listing; identity is the saved `hostId` plus the DTO's exact owner run.
   */
  private savedHost:
    | { readonly kind: "local" }
    | { readonly kind: "remote"; readonly hostId: string; readonly label: string } = { kind: "local" };
  /** True only while the Saved picker's Host line owns the picker's keyboard focus. */
  private savedHostFocused = false;
  /** Present exactly while the Saved Host choice is remote (closed discriminator). */
  private remoteSaved: RemoteSavedState | undefined;
  /** Remote picker frame drawn by the last complete render (writer receipt pending). */
  private savedPickerCandidate: SavedPickerCandidate | undefined;
  private savedPickerTokenSequence = 1;
  /**
   * Monotonic Saved view epoch. It only ever increases, so authority retired by
   * a selection, query, result, Host, run, or eviction change can never be
   * revived by values that later compare equal again.
   */
  private savedViewEpoch = 0;
  /** Last drawn Saved list height; sizes remote windows within the existing bounds. */
  private savedLastListRows = REMOTE_SAVED_PAGE_ROWS;
  /** Bounded notice for a failed or invalidated remote read (cleared on success). */
  private remoteSavedNotice: string | undefined;
  /** Deliberate remote Resume in flight; late results are fenced by the exact request. */
  private pendingRemoteSavedResume: RemoteSavedOperation | undefined;
  /** Remote Delete prepare awaiting the owner's answer (never a confirmation). */
  private pendingRemoteSavedDeleteCheck: RemoteSavedOperation | undefined;
  /** Frozen remote Delete target while its confirmation is open. */
  private remoteSavedDeleteTarget: RemoteSavedOperation | undefined;
  /** The confirmed remote Delete that was emitted and still awaits its outcome. */
  private remoteSavedDeleteOperation: RemoteSavedOperation | undefined;
  /** Newest live owner delete exposure Main reported for the selected host/run. */
  private remoteSavedPolicyOverlay:
    | { readonly hostId: string; readonly hostRunId: string; readonly deleteExposed: boolean | null }
    | undefined;
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
   * activated live local child or remote card). Set by Main through
   * `setActiveMainOwner`/`setActiveMainOwnerKey`, never inferred from the
   * selection; it only drives the white title highlight and is cleared when
   * Main reports no owner. It never changes activation or input ownership.
   */
  private activeMainOwner_: SidebarMainOwnerKey | undefined;
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
  private pendingCreate:
    | {
        readonly requestId: number;
        /** Frozen remote target facts; absent for a local `create`. */
        readonly peer?: {
          readonly formGeneration: number;
          readonly renderToken: number;
          readonly hostId: string;
          readonly hostRunId: string;
          readonly workspace: string;
        };
      }
    | undefined;
  private pendingRename: { readonly requestId: number } | undefined;
  /** Explicit confirmation purpose: quit the host or stop one owned session. */
  private confirmPurpose:
    | "quit"
    | "stop-remove"
    | "saved-delete"
    | "peer-consent"
    | "peer-remove"
    | "peer-revoke"
    | "remote-close" = "quit";
  /** Frozen stop target id; later navigation never retargets the confirmation. */
  private stopRemoveTargetId: string | undefined;
  /** True only while the last render drew the complete stop warning dialog. */
  private stopConfirmDisplayed = false;
  /**
   * Frozen minimal remote-close target (owner host/run/row) plus its bounded
   * display labels. Opened only by Main after it proved the drawn highlight and
   * asked for a confirmation; later snapshots, navigation, or a newer
   * projection never retarget it.
   */
  private remoteCloseTarget: FrozenRemoteCloseTarget | undefined;
  /**
   * Monotonic confirmation generation. Every deliberate open advances it, so a
   * re-opened dialog with identical bytes is still a different decision.
   */
  private remoteCloseGeneration = 0;
  /** Candidate remote-close dialog frame (identity + generation + geometry). */
  private remoteCloseDisplay: DisplayedRemoteClose | undefined;
  /** True only while the last render drew this exact complete dialog. */
  private remoteCloseRendered = false;
  /** Token Main reported as actually written; the ONLY confirmation authority. */
  private remoteCloseWrittenToken: number | undefined;
  private remoteCloseTokenSequence = 1;
  /** Bounded local notice shown inside the remote-close dialog (never authority). */
  private remoteCloseNotice: string | undefined;
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
   * Composite entry keys of collapsed REMOTE cards. Remote expansion is keyed
   * by the composite (host, row) entry key, never by the owner row id, so two
   * hosts that expose the same opaque row id expand independently.
   */
  private readonly collapsedRemoteEntryKeys = new Set<string>();
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

  /** View-only: the host's actual active Main owner id (undefined when none or remote). */
  get activeMainOwnerID(): string | undefined {
    return this.activeMainOwner_?.kind === "local" ? this.activeMainOwner_.id : undefined;
  }

  /**
   * View-only: the structured actual Main owner. A remote owner never appears
   * as a local item id, and `activeMainOwnerID` stays undefined for it.
   */
  get activeMainOwnerKey(): SidebarMainOwnerKey | undefined {
    const owner = this.activeMainOwner_;
    if (owner === undefined) return undefined;
    return owner.kind === "local"
      ? { kind: "local", id: owner.id }
      : { kind: "remote", hostId: owner.hostId, hostRunId: owner.hostRunId, rowId: owner.rowId };
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

  /**
   * True only while the frozen remote-close dialog owns confirm focus. Main uses
   * it as a state signal, never as an input or confirmation authority: a
   * confirmation additionally needs the written receipt below.
   */
  get remoteCloseConfirmationActive(): boolean {
    return this._visible && this._focus === "confirm" && this.confirmPurpose === "remote-close"
      && this.remoteCloseTarget !== undefined;
  }

  /**
   * Capture the exact current complete dialog candidate for Main's frame
   * writer, or undefined when no complete dialog candidate exists. Capturing
   * authorizes nothing by itself.
   */
  captureRemoteCloseConfirmationPresentation(): {
    readonly generation: number;
    readonly renderToken: number;
    readonly target: {
      readonly hostId: string;
      readonly hostRunId: string;
      readonly rowId: string;
    };
    /** Bounded display title of the frozen target. Never part of the token. */
    readonly title: string;
  } | undefined {
    const display = this.remoteCloseDisplay;
    const target = this.remoteCloseTarget;
    if (display === undefined || target === undefined) return undefined;
    if (!this.isRemoteCloseConfirmationRenderCurrent(display.generation, display.token)) return undefined;
    return {
      generation: display.generation,
      renderToken: display.token,
      target: { hostId: target.hostId, hostRunId: target.hostRunId, rowId: target.rowId },
      title: target.title,
    };
  }

  /**
   * Whether this exact generation/render token is the complete dialog frame the
   * last render drew and is still the current one. A superseded, replaced,
   * too-small, or non-dialog frame is not current.
   */
  isRemoteCloseConfirmationRenderCurrent(generation: number, renderToken: number): boolean {
    const display = this.remoteCloseDisplay;
    const target = this.remoteCloseTarget;
    return display !== undefined && target !== undefined && this.remoteCloseRendered
      && display.generation === generation && display.token === renderToken
      && display.target === target
      && this._visible && this._focus === "confirm" && this.confirmPurpose === "remote-close";
  }

  /**
   * Grant confirmation authority only after Main's writer settles this exact
   * frame, i.e. after the operator's own terminal actually shows it.
   */
  settleRemoteCloseConfirmationRender(generation: number, renderToken: number): boolean {
    if (!this.isRemoteCloseConfirmationRenderCurrent(generation, renderToken)) return false;
    this.remoteCloseWrittenToken = renderToken;
    return true;
  }

  /** Revoke remote-close display authority before any focus, target, or geometry invalidation. */
  invalidateRemoteCloseConfirmationDisplay(): void {
    this.remoteCloseDisplay = undefined;
    this.remoteCloseRendered = false;
    this.remoteCloseWrittenToken = undefined;
  }

  /**
   * Dismiss a pending remote-close dialog without emitting anything, because
   * Main positively observed that its frozen owner target no longer exists (the
   * row was removed or the owner run was replaced). It decides nothing, sends
   * nothing, and preserves focus ownership of the roster itself.
   */
  abandonRemoteCloseConfirmation(): boolean {
    if (!this.remoteCloseConfirmationActive) return false;
    this.cancelRemoteCloseConfirmation();
    return true;
  }

  /**
   * Main's synchronous two-phase entry point for one deliberate `d`/Delete on a
   * remote card. It re-proves that the currently drawn highlight is exactly the
   * frozen request target, then either reports the direct plan (`direct`, the
   * caller performs the one owner request) or opens the written confirmation
   * (`confirmation-opened`) and returns. It never emits anything, so a request
   * that arrives here is not re-routed or duplicated.
   */
  prepareRemoteClose(
    target: {
      readonly hostId: string;
      readonly hostRunId: string | null;
      readonly rowId: string;
    },
    options: { readonly direct: boolean },
  ): "direct" | "confirmation-opened" | "refused" {
    const drawn = this.drawnRemoteCloseTarget();
    if (drawn === undefined) return "refused";
    if (target.hostRunId === null || target.hostRunId.length === 0) return "refused";
    if (drawn.hostId !== target.hostId || drawn.hostRunId !== target.hostRunId
      || drawn.rowId !== target.rowId) return "refused";
    if (options.direct) return "direct";
    this.openRemoteCloseConfirmation(drawn);
    return "confirmation-opened";
  }

  /** Revoke Saved-delete display authority before any focus, target, or geometry invalidation. */
  invalidateSavedDeleteConfirmationDisplay(): void {
    this.savedDeleteConfirmationDisplayed = false;
    this.savedDeleteConfirmationRenderToken = undefined;
  }

  /** Whether a still-current complete warning render is awaiting/has reached writer settlement. */
  isSavedDeleteConfirmationRenderCurrent(token: number): boolean {
    // The same written-warning fence covers the local target and the frozen
    // remote owner target; exactly one of them exists while the dialog is open.
    const target = this.savedDeleteTarget ?? this.remoteSavedDeleteTarget;
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
      && this.savedHost.kind === "local"
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
      && this.savedHost.kind === "local"
      && this.savedPickerId === context.pickerId && this.savedQueryRevision === context.revision
      && this.savedRows[this.savedSelectedIndex]?.id === context.id
      && this.savedRows[this.savedSelectedIndex]?.file === context.file;
  }

  // --- Selected-host Saved picker: pure API for Main (remote owner). ---------
  //
  // None of these methods performs IO, sends anything, or grants authority. Main
  // feeds owner facts in and receives intents out; the owner re-checks its own
  // run, policy, and file guards on every request.

  /** The Saved picker's current Host choice, as the fresh option list describes it. */
  get savedPickerHost(): SidebarSavedPickerHost {
    const chosen = this.savedHost;
    if (chosen.kind === "local") return Object.freeze({ kind: "local" as const });
    const option = this.currentSavedHostOption();
    return Object.freeze({
      kind: "remote" as const,
      hostId: chosen.hostId,
      label: option?.label ?? chosen.label,
      hostRunId: option?.hostRunId ?? null,
      connected: option?.connected === true,
      supported: option?.supported === true,
      deleteExposed: option?.deleteExposed ?? null,
    });
  }

  /** Read-only remote picker context, or undefined unless a remote Saved picker is open. */
  savedRemoteContext(): SidebarRemoteSavedContext | undefined {
    const state = this.remoteSaved;
    const pickerId = this.savedPickerId;
    if (state === undefined || pickerId === undefined || !this.remoteSavedPickerOpen()) return undefined;
    const option = this.currentSavedHostOption();
    return Object.freeze({
      pickerId,
      revision: this.savedQueryRevision,
      query: this.savedQuery,
      hostId: state.hostId,
      hostRunId: option?.hostRunId ?? null,
      catalogId: state.catalog?.catalogId,
      resultId: state.result?.resultId,
      total: state.result?.total,
      issueCount: state.result?.issueCount ?? 0,
      selectedIndex: this.savedSelectedIndex,
      windows: Object.freeze(state.windows.map((window) => Object.freeze({
        offset: window.offset,
        length: window.rows.length,
      }))),
      pendingReads: Object.freeze([
        ...(state.resultRead === undefined ? [] : [state.resultRead.requestId]),
        ...state.windowReads.map((read) => read.requestId),
      ]),
    });
  }

  /**
   * Accept one completed owner window for the EXACT outstanding read it answers:
   * a `saved-remote-list` (replaces catalog and result), `saved-remote-search`
   * (same catalog, replaces the result), or `saved-remote-window` (same catalog,
   * result, and total; never relists). The request must still belong to this
   * picker, query revision, destination, and owner run. A refused reply retires
   * its request and changes nothing else; nothing is retried. Only bounded
   * windows of the current result are retained.
   */
  completeRemoteSavedWindow(requestId: number, facts: SidebarRemoteSavedWindowFacts): boolean {
    const state = this.remoteSaved;
    if (state === undefined || !this.remoteSavedPickerOpen()) return false;
    const intent = state.resultRead?.requestId === requestId
      ? state.resultRead
      : state.windowReads.find((candidate) => candidate.requestId === requestId);
    if (intent === undefined || intent.revision !== this.savedQueryRevision) return false;
    // The request is answered either way: a refused reply is never re-awaited.
    this.retireRemoteSavedRead(state, intent);
    if (!isOwnerSavedWindowFacts(facts) || facts.kind !== "window"
      || facts.entries.length > REMOTE_SAVED_MAX_WINDOW_ROWS) {
      this.remoteSavedNotice = "The remote Saved list reply was not usable; nothing was changed";
      this.onInvalidate?.();
      return false;
    }
    if (facts.hostRunId !== intent.hostRunId) {
      this.remoteSavedNotice = REMOTE_SAVED_OTHER_RUN_NOTICE;
      this.onInvalidate?.();
      return false;
    }
    const option = this.currentSavedHostOption();
    if (!this.remoteSavedHostUsable(option) || option.hostRunId !== intent.hostRunId) return false;
    if (intent.kind === "search" && facts.catalogId !== intent.catalogId) return false;
    if (intent.kind === "window") {
      const catalog = state.catalog;
      const result = state.result;
      if (catalog === undefined || result === undefined
        || catalog.catalogId !== intent.catalogId || result.resultId !== intent.resultId
        || facts.catalogId !== catalog.catalogId || facts.resultId !== result.resultId
        || facts.total !== result.total) return false;
    }
    const rows: RemoteSavedRow[] = facts.entries.map((entry) => Object.freeze({
      entryId: entry.entryId,
      row: Object.freeze(remoteSavedDisplayRow(entry)),
    }));
    if (intent.kind !== "window") {
      state.catalog = Object.freeze({ hostRunId: facts.hostRunId, catalogId: facts.catalogId });
      state.result = Object.freeze({ resultId: facts.resultId, total: facts.total, issueCount: facts.issueCount });
      state.windows = [];
      state.windowReads = [];
      // Existing query behaviour: the absolute selection is kept and only
      // clamped when the new result is shorter (Host changes reset it to 0).
      if (this.savedSelectedIndex >= facts.total) this.savedSelectedIndex = Math.max(0, facts.total - 1);
      // A new owner result is a new view, even if the owner reused handles.
      this.retireSavedViewAuthority();
    }
    if (rows.length > 0) this.addRemoteSavedWindow(state, { offset: facts.offset, rows });
    this.remoteSavedNotice = undefined;
    this.displayedSavedRows = undefined;
    // A positive reply may leave the selection (or the drawn rows) uncached; one
    // bounded follow-up window is a new read, never a retry of this one.
    if (rows.length > 0) this.requestRemoteSavedCoverage();
    this.onInvalidate?.();
    return true;
  }

  /** Retire one outstanding remote read with a bounded notice; nothing is retried. */
  failRemoteSavedRead(requestId: number, message: string): boolean {
    const state = this.remoteSaved;
    if (state === undefined || !this.remoteSavedPickerOpen()) return false;
    const intent = state.resultRead?.requestId === requestId
      ? state.resultRead
      : state.windowReads.find((candidate) => candidate.requestId === requestId);
    if (intent === undefined) return false;
    this.retireRemoteSavedRead(state, intent);
    this.remoteSavedNotice = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
    this.onInvalidate?.();
    return true;
  }

  /**
   * The remote picker frame the last complete render drew, for Main's writer.
   * Undefined for a Local picker, a too-small/covered/hidden frame, or a frame
   * that is no longer current. Capturing authorizes nothing by itself.
   */
  captureSavedPickerPresentation(): SidebarSavedPickerPresentation | undefined {
    const candidate = this.savedPickerCandidate;
    return candidate !== undefined && this.remoteSavedCandidateCurrent(candidate)
      ? candidate.presentation
      : undefined;
  }

  /** Whether this token is still the current complete remote picker frame. */
  isSavedPickerRenderCurrent(renderToken: number): boolean {
    const candidate = this.savedPickerCandidate;
    return candidate !== undefined && candidate.token === renderToken
      && this.remoteSavedCandidateCurrent(candidate);
  }

  /**
   * Main's ACTUAL-writer receipt for this exact remote picker frame. Until it is
   * reported no Resume or Delete-prepare may be emitted from that frame; a
   * queued, held, superseded, resized, covered, or merely rendered frame never
   * becomes a receipt.
   */
  settleSavedPickerRender(renderToken: number): boolean {
    const candidate = this.savedPickerCandidate;
    if (candidate === undefined || candidate.token !== renderToken
      || !this.remoteSavedCandidateCurrent(candidate)) return false;
    candidate.written = true;
    return true;
  }

  /** Forget the drawn remote picker frame (covered, resized, hidden, or replaced). */
  invalidateSavedPickerPresentation(): void {
    this.savedPickerCandidate = undefined;
  }

  /**
   * Main's last-instant re-proof for one UNSUBMITTED remote entry intent: the
   * exact pending Resume, Delete-prepare, or confirmed Delete still exists with
   * every frozen handle and view epoch, still owns this picker/query/selection/
   * destination/run/result, the CURRENT written receipt it came from still
   * stands (the same written picker frame, token, and geometry for Resume and
   * Delete-prepare, which must still draw the entry; the same written
   * confirmation token for Delete), and for delete the OWNER's live exposure is
   * still on. Any invalidation, resize, re-minted dialog token, or epoch advance
   * fails it for good. It never checks a local setting and grants nothing; it
   * never cancels work the owner already accepted.
   */
  remoteSavedIntentStillCurrent(
    intent: Extract<PeerSavedUiAction, {
      readonly type: "saved-remote-resume" | "saved-remote-delete-prepare" | "saved-remote-delete";
    }>,
  ): boolean {
    const operation = intent.type === "saved-remote-resume"
      ? this.pendingRemoteSavedResume
      : intent.type === "saved-remote-delete-prepare"
        ? this.pendingRemoteSavedDeleteCheck
        : this.remoteSavedDeleteOperation;
    if (operation === undefined || operation.requestId !== intent.requestId
      || operation.pickerId !== intent.pickerId || operation.revision !== intent.revision
      || operation.hostId !== intent.hostId || operation.hostRunId !== intent.hostRunId
      || operation.catalogId !== intent.catalogId || operation.resultId !== intent.resultId
      || operation.entryId !== intent.entryId || operation.renderToken !== intent.renderToken) return false;
    if (!this._visible || this.formKind !== "saved") return false;
    if (intent.type === "saved-remote-delete") {
      const target = this.remoteSavedDeleteTarget;
      if (target === undefined || target.entryId !== operation.entryId
        || this._focus !== "confirm" || this.confirmPurpose !== "saved-delete") return false;
      // The exact written confirmation frame must still stand: any re-render,
      // geometry change, or invalidation re-mints or drops its token.
      if (!this.savedDeleteConfirmationDisplayed
        || this.savedDeleteConfirmationRenderToken !== intent.renderToken
        || !this.isSavedDeleteConfirmationRenderCurrent(intent.renderToken)) return false;
    } else {
      // The exact written picker frame (token + geometry + epoch) must still be
      // current and must still draw this exact entry.
      const candidate = this.savedPickerCandidate;
      if (this._focus !== "form" || candidate === undefined || !candidate.written
        || candidate.token !== intent.renderToken
        || !this.remoteSavedCandidateCurrent(candidate)
        || !candidate.presentation.drawn.some((row) => row.index === operation.index
          && row.entryId === operation.entryId)) return false;
    }
    if (intent.type !== "saved-remote-resume" && this.currentSavedHostOption()?.deleteExposed !== true) return false;
    return this.remoteSavedOperationOwned(operation);
  }

  /**
   * Main's QUEUED-write re-proof for one remote entry intent Main has ALREADY
   * admitted (and consumed) from its own exact actually-written receipt. It is
   * read-only and REMOTE-only, and it never admits anything by itself: a caller
   * that has not proved and consumed a written receipt must use
   * {@link remoteSavedIntentStillCurrent} instead.
   *
   * It re-proves the same semantic ownership as that admission check — the exact
   * pending operation of this kind with every frozen owner handle, the frame
   * token it was emitted from, and its view epoch; the open picker; the right
   * focus and confirmation purpose (and, for Delete, the frozen confirmation
   * target); the same picker, query revision, destination, usable run, catalog,
   * result, selection, and cached entry; and for Delete-prepare/Delete the
   * OWNER's live exposure — and deliberately ignores ONLY the per-render mutable
   * frame token currency and written flag. Those re-mint on every harmless
   * repaint (the Delete confirmation mints a new token on every render), so
   * checking them here would let an identical redraw refuse an already admitted
   * intent; Main's own geometry and lifetime epochs cover what they would add.
   */
  remoteSavedAdmittedIntentStillOwned(
    intent: Extract<PeerSavedUiAction, {
      readonly type: "saved-remote-resume" | "saved-remote-delete-prepare" | "saved-remote-delete";
    }>,
  ): boolean {
    const operation = intent.type === "saved-remote-resume"
      ? this.pendingRemoteSavedResume
      : intent.type === "saved-remote-delete-prepare"
        ? this.pendingRemoteSavedDeleteCheck
        : this.remoteSavedDeleteOperation;
    if (operation === undefined || operation.requestId !== intent.requestId
      || operation.pickerId !== intent.pickerId || operation.revision !== intent.revision
      || operation.hostId !== intent.hostId || operation.hostRunId !== intent.hostRunId
      || operation.catalogId !== intent.catalogId || operation.resultId !== intent.resultId
      || operation.entryId !== intent.entryId || operation.renderToken !== intent.renderToken) return false;
    if (!this._visible || this.formKind !== "saved") return false;
    if (intent.type === "saved-remote-delete") {
      const target = this.remoteSavedDeleteTarget;
      if (target === undefined || this._focus !== "confirm" || this.confirmPurpose !== "saved-delete") return false;
      // The confirmed operation is the frozen target plus its own request id and
      // confirmation token: every other frozen fact must still be that target's.
      if (target.pickerId !== operation.pickerId || target.revision !== operation.revision
        || target.hostId !== operation.hostId || target.hostRunId !== operation.hostRunId
        || target.catalogId !== operation.catalogId || target.resultId !== operation.resultId
        || target.entryId !== operation.entryId || target.index !== operation.index
        || target.selectedIndex !== operation.selectedIndex || target.viewEpoch !== operation.viewEpoch) return false;
    } else if (this._focus !== "form") {
      return false;
    }
    if (intent.type !== "saved-remote-resume" && this.currentSavedHostOption()?.deleteExposed !== true) return false;
    return this.remoteSavedOperationOwned(operation);
  }

  /**
   * Main's SILENT retirement of one outstanding remote read it never submitted
   * (a newer unsent read replaced it before the destination was free). The read
   * is forgotten exactly like an answered one, so the picker can request that
   * range again later instead of keeping a permanent loading hole. Nothing else
   * changes: no notice, redraw request, follow-up read, retry, or cancellation
   * claim, and a request that is not outstanding here is a no-op (`false`).
   */
  retireUnsentRemoteSavedRead(requestId: number): boolean {
    const state = this.remoteSaved;
    if (state === undefined) return false;
    const intent = state.resultRead?.requestId === requestId
      ? state.resultRead
      : state.windowReads.find((candidate) => candidate.requestId === requestId);
    if (intent === undefined) return false;
    this.retireRemoteSavedRead(state, intent);
    return true;
  }

  /**
   * Resolve one remote Resume. The OWNER created/selected its row; this side
   * selects that exact owner run/row ONLY while the exact request still owns the
   * picker (same picker, query, destination, run, catalog, result, entry, and
   * selection). A late or superseded reply finishes nothing here: it never
   * steals the pane or focus, never changes a draft or geometry, and never stops
   * or cancels anything.
   */
  completeRemoteSavedResume(requestId: number, facts: { readonly hostRunId: string; readonly rowId: string }): boolean {
    const pending = this.pendingRemoteSavedResume;
    if (pending === undefined || pending.requestId !== requestId) return false;
    this.pendingRemoteSavedResume = undefined;
    const owned = this._visible && this._focus === "form" && this.formKind === "saved"
      && this.remoteSavedOperationOwned(pending);
    if (typeof facts?.hostRunId !== "string" || facts.hostRunId !== pending.hostRunId
      || typeof facts.rowId !== "string" || facts.rowId.length === 0) {
      if (owned) {
        this.savedError = REMOTE_SAVED_OTHER_RUN_NOTICE;
        this.onInvalidate?.();
      }
      return false;
    }
    if (!owned) return false;
    this.emit({ type: "saved-remote-dismiss", pickerId: pending.pickerId, hostId: pending.hostId });
    this.savedError = undefined;
    this.clearSavedPickerState();
    this.displayedSavedRows = undefined;
    this.disposeFormField();
    this.formKind = undefined;
    this._focus = "main";
    this.emit({ type: "select-remote", hostId: pending.hostId, hostRunId: facts.hostRunId, rowId: facts.rowId });
    return true;
  }

  /** Show a bounded Resume refusal/uncertainty only while the request still owns the picker. */
  failRemoteSavedResume(requestId: number, message: string): boolean {
    const pending = this.pendingRemoteSavedResume;
    if (pending === undefined || pending.requestId !== requestId) return false;
    this.pendingRemoteSavedResume = undefined;
    if (this._focus !== "form" || this.formKind !== "saved" || this.savedPickerId !== pending.pickerId) return false;
    this.savedError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
    this.onInvalidate?.();
    return true;
  }

  /**
   * The owner answered one Delete prepare. A prepare is never a confirmation:
   * only an allowed answer for the still-owned exact row opens the same written
   * confirmation dialog the local picker uses (annotated with the owner host).
   */
  completeRemoteSavedDeletePrepare(requestId: number, allowed: boolean, message?: string): boolean {
    const context = this.pendingRemoteSavedDeleteCheck;
    if (context === undefined || context.requestId !== requestId) return false;
    this.pendingRemoteSavedDeleteCheck = undefined;
    if (!this._visible || this._focus !== "form" || this.formKind !== "saved"
      || !this.remoteSavedOperationOwned(context)) return false;
    if (allowed !== true) {
      this.savedError = sanitizeBounded(message ?? "Saved conversation is not safe to delete", ERROR_TEXT_MAX_CODEPOINTS);
      this.onInvalidate?.();
      return true;
    }
    this.invalidateSavedDeleteConfirmationDisplay();
    this.invalidateSavedPickerPresentation();
    this.savedDeleteTarget = undefined;
    this.remoteSavedDeleteTarget = context;
    this.remoteSavedDeleteOperation = undefined;
    this.displayedSavedRows = undefined;
    this.confirmPurpose = "saved-delete";
    this._focus = "confirm";
    this.onInvalidate?.();
    return true;
  }

  /**
   * Complete the one confirmed remote Delete while its dialog still owns the
   * pane. The OWNER's live policy is deliberately not re-read here: an accepted
   * delete keeps its truthful completion ownership even if the policy turned Off
   * meanwhile. A deletion relists the owner's catalog (a new read, never a retry).
   */
  completeRemoteSavedDelete(requestId: number, message: string, deleted: boolean): boolean {
    const operation = this.remoteSavedDeleteOperation;
    if (operation === undefined || operation.requestId !== requestId) return false;
    if (this.remoteSavedDeleteTarget === undefined || !this._visible || this._focus !== "confirm"
      || this.confirmPurpose !== "saved-delete" || this.savedPickerId !== operation.pickerId
      || this.savedQueryRevision !== operation.revision) return false;
    this.remoteSavedDeleteOperation = undefined;
    this.remoteSavedDeleteTarget = undefined;
    this.invalidateSavedDeleteConfirmationDisplay();
    this.confirmPurpose = "quit";
    this._focus = "form";
    this.savedError = sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS);
    if (deleted === true) this.requestRemoteSavedResult(true);
    this.onInvalidate?.();
    return true;
  }

  /**
   * Newest live OWNER delete exposure for the selected destination and exact
   * owner run (from a policy fact Main observed). It is a description, never
   * permission. Off or unknown hides the delete hints and refuses new sends,
   * without retiring a preparation or confirmation solely for a policy change.
   * An already emitted confirmed delete keeps its completion ownership. On
   * restores hints without relisting or rebinding anything. A later snapshot that reports a
   * concrete exposure for that destination replaces this value.
   */
  updateRemoteSavedDeleteExposure(hostId: string, hostRunId: string, deleteExposed: boolean | null): boolean {
    if (this.savedHost.kind !== "remote" || this.savedHost.hostId !== hostId
      || typeof hostRunId !== "string" || hostRunId.length === 0
      || (deleteExposed !== true && deleteExposed !== false && deleteExposed !== null)) return false;
    this.remoteSavedPolicyOverlay = Object.freeze({ hostId, hostRunId, deleteExposed });
    this.reconcileSavedPickerHost();
    this.onInvalidate?.();
    return true;
  }

  /**
   * Main-owned, view-only observer of the actual active LOCAL Main
   * conversation. It only drives the white title highlight; it never activates
   * a row, moves input focus, or changes ownership. Main clears it (undefined)
   * when the owner row leaves the roster so a sibling is never falsely
   * highlighted. Remote content owners use `setActiveMainOwnerKey`.
   */
  setActiveMainOwner(id: string | undefined): void {
    this.activeMainOwner_ = typeof id === "string" && id.length > 0
      ? { kind: "local", id }
      : undefined;
  }

  /**
   * Main-owned, view-only observer of the ACTUAL conversation Main displays,
   * local or remote, with the left-roster highlight kept entirely separate.
   * This is the stable public API for marking remote content ownership: a
   * structured key, never a parsed string, and a remote key can never be read
   * back as a local id through `selectedId`/`activeMainOwnerID`.
   *
   * It only drives the white title highlight. It never activates a row, moves
   * focus, emits an action, changes the left highlight, connects, pairs, or
   * retargets anything. An unobserved/empty identity fails closed to no owner.
   */
  setActiveMainOwnerKey(owner: SidebarMainOwnerKey | undefined): void {
    if (owner === undefined) {
      this.activeMainOwner_ = undefined;
      return;
    }
    switch (owner.kind) {
      case "local":
        this.setActiveMainOwner(owner.id);
        return;
      case "remote":
        this.activeMainOwner_ = typeof owner.hostId === "string" && owner.hostId.length > 0
          && typeof owner.rowId === "string" && owner.rowId.length > 0
          && (owner.hostRunId === null || (typeof owner.hostRunId === "string" && owner.hostRunId.length > 0))
          ? {
            kind: "remote",
            hostId: owner.hostId,
            hostRunId: owner.hostRunId,
            rowId: owner.rowId,
          }
          : undefined;
        return;
      default:
        // An unknown kind is not an observed owner: fail closed to none.
        this.activeMainOwner_ = undefined;
    }
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
    const previous = this.peerUiSnapshot;
    // A chosen destination's own identity facts: connection state, exact owner
    // run, destination key fingerprint, and this host's requester identity.
    const chosenHostId = this.formKind === "new" && this.newFormHost.kind === "remote"
      ? this.newFormHost.hostId
      : undefined;
    const before = previous?.hosts?.find((host) => host.id === chosenHostId);
    const after = next.hosts?.find((host) => host.id === chosenHostId);
    const targetChanged = chosenHostId !== undefined && (
      previous?.identityFingerprint !== next.identityFingerprint
      || before?.state !== after?.state
      || before?.roster.hostRunId !== after?.roster.hostRunId
      || before?.fingerprint !== after?.fingerprint
    );
    this.peerUiSnapshot = next;
    if (targetChanged) {
      // Comparing present values is not enough: a run or connection that returns
      // to its earlier value (A -> B -> A, or disconnected -> connected) must
      // never revive a receipt that was written before the transition. Retire the
      // drawn New-form receipt synchronously, so a queued or held write can never
      // be submitted again on this side.
      this.invalidateCreateFormPresentation();
      const pending = this.pendingCreate;
      if (pending !== undefined && pending.peer !== undefined) {
        // Dispatch may already have happened, so only uncertainty is claimed. This
        // releases this side's UI ownership; the owner's accepted work is never
        // cancelled, re-sent, retried, or retargeted by it.
        this.failCreateOnPeer(pending.requestId, CREATE_ON_PEER_UNCERTAIN_NOTICE);
      }
    }
    // A newer snapshot that reports a concrete OWNER delete exposure for the
    // selected Saved destination supersedes an earlier policy fact Main reported.
    const policyOverlay = this.remoteSavedPolicyOverlay;
    if (policyOverlay !== undefined) {
      const reported = next.hosts?.find((host) => host.id === policyOverlay.hostId)?.saved?.deleteExposed;
      if (reported === true || reported === false) this.remoteSavedPolicyOverlay = undefined;
    }
    // An open Saved picker follows its chosen destination's connection, run, and
    // live owner policy without relisting, retrying, or retargeting anything.
    this.reconcileSavedPickerHost();
    if (this.peerBindDirty && next.settings !== null
      && next.settings.bindHost === this.peerBindHostDraft.trim()
      && (next.settings.bindPort === null ? "" : String(next.settings.bindPort)) === this.peerBindPortDraft.trim()) {
      // The coordinator now reports exactly the value this pane requested, so
      // the local draft is no longer unsaved.
      this.peerBindDirty = false;
    }
    if (!this.peerBindDirty) {
      const draft = peerListenDraftFromSettings(next.settings);
      this.peerBindHostDraft = draft.host;
      this.peerBindPortDraft = draft.port;
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
    this.peerAddMenuOpen = false;
    this.peerConfirmDisplayed = false;
    this.peerRemoveTarget = undefined;
    this.peerRevokeTarget = undefined;
    this.invalidatePeerConsentDisplay();
    this.peerConsentLatch = undefined;
    this.peerConsentLocalNotice = undefined;
    this.remoteCloseTarget = undefined;
    this.remoteCloseNotice = undefined;
    this.invalidateRemoteCloseConfirmationDisplay();
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
    const displayedFormHost = this.formHostDisplay;
    return Object.freeze({
      authorizationKey: mouseAuthorizationKey(
        displayedRoster,
        displayedSavedRows,
        displayedPeerRows,
        displayedPeerConsent,
        this.peerConsentRendered,
        displayedFormHost,
      ),
      remoteClose: this.remoteCloseRowFrom(displayedRoster),
      activateRosterAt: (column: number, row: number, cols: number, rows: number): boolean =>
        this.activateRosterAtFrom(displayedRoster, column, row, cols, rows, false),
      activateSavedAt: (column: number, row: number, cols: number, rows: number): boolean =>
        this.activateSavedAtFrom(displayedSavedRows, column, row, cols, rows),
      activatePeerAt: (column: number, row: number, cols: number, rows: number): boolean =>
        this.activatePeerAtFrom(displayedPeerRows, column, row, cols, rows),
      activateFormHostAt: (column: number, row: number, cols: number, rows: number): boolean =>
        this.activateFormHostAtFrom(displayedFormHost, column, row, cols, rows),
      // Only one form-slot pane is ever drawn by one render, so the captured
      // maps dispatch to exactly the surface the operator saw (or to neither).
      activateFormRowAt: (column: number, row: number, cols: number, rows: number): boolean =>
        this.activateFormHostAtFrom(displayedFormHost, column, row, cols, rows)
          || (displayedSavedRows !== undefined
            ? this.activateSavedAtFrom(displayedSavedRows, column, row, cols, rows)
            : this.activatePeerAtFrom(displayedPeerRows, column, row, cols, rows)),
    });
  }

  /**
   * The written remote-close highlight of one roster render record, or
   * undefined when that render did not draw a complete remote card as its
   * highlight. Only the drawn region's own entry is used, never a newer
   * projection or the logical selection alone.
   */
  private remoteCloseRowFrom(shown: DisplayedRoster | undefined): SidebarRemoteCloseRow | undefined {
    // The DRAWN highlight decides, never the logical selection: a capture from
    // an older record must describe the row that record actually marked.
    const key = shown?.selectedKey;
    if (shown === undefined || key === undefined) return undefined;
    if (shown.focus !== "sidebar" || shown.signature !== this.rosterSignature()) return undefined;
    const region = shown.regions.get(key);
    const entry = region?.entry;
    if (region === undefined || entry === undefined) return undefined;
    if (entry.kind !== "remote" || entry.remote === undefined) return undefined;
    if (region.height !== this.entryHeight(entry)) return undefined;
    const remote = entry.remote;
    return Object.freeze({
      hostId: remote.hostId,
      hostRunId: remote.hostRunId,
      rowId: remote.row.id,
      row: region.row,
      height: region.height,
      cols: shown.cols,
      rows: shown.rows,
      focus: shown.focus,
      lifecycle: remote.row.lifecycle,
      hasLiveProcess: remote.row.hasLiveProcess,
      idle: isCompleteIdle(remote.row),
      title: cardTitle(remote.row),
      hostLabel: sanitizeBounded(remote.hostLabel, PEER_LABEL_MAX_CODEPOINTS),
    });
  }

  /**
   * The remote-close target this sidebar's last complete roster render drew as
   * its highlight. Undefined when that card is not a fully drawn remote row, or
   * when the projection carried no owner run (a Close is never guessed).
   */
  private drawnRemoteCloseTarget(): FrozenRemoteCloseTarget | undefined {
    const shown = this.displayedRoster;
    if (shown === undefined || shown.selectedKey === undefined
      || shown.selectedKey !== this.selectedEntryKey) return undefined;
    const drawn = this.remoteCloseRowFrom(shown);
    if (drawn === undefined || drawn.hostRunId === null || drawn.hostRunId.length === 0) return undefined;
    return Object.freeze({
      hostId: drawn.hostId,
      hostRunId: drawn.hostRunId,
      rowId: drawn.rowId,
      title: drawn.title,
      hostLabel: drawn.hostLabel,
    });
  }

  /**
   * Activates the exact roster entry whose complete row/card was drawn at this
   * pane-relative coordinate. Main consumes all other gestures in the visible
   * pane; this method never derives row positions independently of rendering.
   * While a right-hand host UI is open beside that written roster, a click on a
   * different row closes the UI through its own cancellation route and then
   * performs the clicked row's ordinary action once; a click on the
   * currently highlighted row is a pure no-op.
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
    // A right-hand host UI is only in play when it actually owns the wide
    // layout's right pane slot; the written-roster proof below is what shows
    // the clicked picker is the one on screen beside it.
    const rightPaneOpen = this.rightHandPaneIsOpen();
    if (!this._visible
      || (this._focus !== "main" && this._focus !== "sidebar" && !rightPaneOpen)
      || !validHitGeometry(column, row, cols, rows)) return false;
    if (shown === undefined || (requireCurrentSignature
      && (shown.signature !== this.rosterSignature() || shown.focus !== this._focus))
      || shown.cols !== cols || shown.rows !== rows) return false;
    const region = [...shown.regions.values()].find((candidate) => row >= candidate.row
      && row < candidate.row + candidate.height);
    if (region === undefined || region.height !== this.entryHeight(region.entry)) return false;
    // The clicked target is the drawn entry's immutable key and activation
    // identity — never a row index — so a later reorder, state change, or
    // cancellation can only refuse it, never retarget it.
    const clicked = region.entry;
    // A captured remote presentation is a coordinate + structured target from
    // one written roster. Even when the caller's capture token is not the
    // uncaptured controller path, a reordered/replaced projection must refuse
    // it instead of resolving that coordinate against a newer order. Local
    // rows keep their existing capture semantics unchanged.
    if (clicked.kind === "remote" && shown.signature !== this.rosterSignature()) return false;
    let target = this.entries.find((entry) => entry.key === clicked.key);
    if (target === undefined || !sameSidebarEntry(target, clicked)) return false;
    if (rightPaneOpen) {
      // Same-row semantics belong to the drawn highlight, not a newer backend
      // selection. A stale captured presentation cannot cancel or swallow a click.
      if (shown.selectedKey !== this.selectedEntryKey) return false;
      // Clicking the row that already holds the LEFT highlight while a
      // right-hand UI is open changes nothing at all: the pane, its draft,
      // focus, selection, notices, and any pending operation stay exactly as
      // they were, and no cancellation or activation action is emitted. The
      // left highlight decides, not the native Main owner, an edit target, or
      // whichever row originally opened the pane.
      if (target.key === shown.selectedKey) return true;
      // A different row first closes that UI through its own existing
      // cancellation route, then performs the clicked row's ordinary action
      // once. Nothing is confirmed, approved, denied, submitted, or deleted by
      // the cancellation itself.
      if (!this.cancelRightHandPaneForRosterClick()) return false;
      // Re-prove the clicked target after the cancellation: a vanished or
      // changed entry is refused silently, exactly as a stale draw already is.
      target = this.entries.find((entry) => entry.key === clicked.key);
      if (target === undefined || !sameSidebarEntry(target, clicked)) return false;
    }
    this.selectedEntryKey = target.key;
    this.desiredSelectionId = undefined;
    this.noticeError = undefined;
    // A mouse activation can originate while Main owns input. Exited-row
    // recovery is a sidebar-owned intent: move focus there before invoking the
    // existing resume guard so completeRowResume can validate the same request.
    if (target.kind === "item" && target.item?.lifecycle === "exited"
      && target.item.unavailable !== true && this.pendingRowResume === undefined
      && this._focus === "main") {
      this._focus = "sidebar";
    }
    this.activateEntry(clicked);
    return true;
  }

  /**
   * True only while a host UI occupies the wide layout's right-hand pane slot
   * next to the still-visible roster: any host form, or exactly the
   * confirmation the compositor places there (the same rule as the layout's
   * form slot). Confirmations that replace the roster instead — Quit, stop or
   * remove, peer remove and revoke — are never reported here, and the
   * written-roster check in the activation path still refuses any frame whose
   * roster was not actually drawn at this geometry.
   */
  private rightHandPaneIsOpen(): boolean {
    if (!this._visible) return false;
    if (this._focus === "form") return this.formKind !== undefined;
    if (this._focus === "confirm") {
      return this.savedDeleteConfirmationActive || this.peerConsentConfirmationActive;
    }
    return false;
  }

  /**
   * Closes the whole right-hand host UI so a left-roster click can activate
   * its own row against a closed pane. Every branch is the UI's own keyboard
   * cancellation route minus the held-Escape claim, which is keyboard
   * provenance only and is never set from a pointer gesture. Each route keeps
   * its existing draft retention or discard semantics and clears its own
   * pending UI ownership; nested UI is dismissed completely (the Saved-delete
   * confirmation returns to its picker, then the picker's own dismissal closes
   * the containing pane) so no hidden pane, query, or pending UI ownership
   * survives. Backend work keeps its existing cancellation and request-id
   * fences; dismissing a pane does not guarantee that a submitted operation
   * stops. Returns false when the current focus holds no closable right-hand
   * UI, in which case the click activates nothing.
   */
  private cancelRightHandPaneForRosterClick(): boolean {
    if (this._focus === "confirm") {
      if (this.confirmPurpose === "saved-delete") {
        this.cancelSavedDeleteConfirmation();
        this.dismissSavedPane();
        return true;
      }
      // Only a dismissal, never a decision: the pending request stays in
      // Main's snapshot and its alert band.
      if (this.confirmPurpose === "peer-consent") {
        this.dismissPeerConsentReview();
        return true;
      }
      return false;
    }
    if (this._focus !== "form") return false;
    switch (this.formKind) {
      case "saved":
        this.dismissSavedPane();
        return true;
      case "peer":
        if (this.peerAddMenuOpen) this.closePeerAddMenu();
        this.closePeerPane();
        this._focus = "sidebar";
        this.onInvalidate?.();
        return true;
      case "peer-field":
        // The field editor returns to its Add menu/network pane; the whole
        // containing pane closes after it, so nothing stays open underneath.
        this.closePeerFieldForm();
        if (this.peerAddMenuOpen) this.closePeerAddMenu();
        this.closePeerPane();
        this._focus = "sidebar";
        this.onInvalidate?.();
        return true;
      case "new":
      case "edit":
      case "shortcuts":
        this.abandonForm();
        this._focus = "sidebar";
        this.onInvalidate?.();
        return true;
      default:
        return false;
    }
  }

  /** Activates a fully drawn saved row in the currently owned Saved pane. */
  activateSavedAt(column: number, row: number, cols: number, rows: number): boolean {
    return this.activateSavedAtFrom(this.displayedSavedRows, column, row, cols, rows);
  }

  /**
   * Activates a fully drawn network-menu row in the currently owned Network
   * pane: the click selects that exact row and performs its ordinary Enter
   * action once, exactly like a Saved-picker click and like the Enter key.
   */
  activatePeerAt(column: number, row: number, cols: number, rows: number): boolean {
    return this.activatePeerAtFrom(this.peerDisplay, column, row, cols, rows);
  }

  /**
   * Activates only the New form's Host line that the captured render drew: the
   * drawn value span cycles that one selection, and any other column on that
   * same drawn row only focuses the control. A different row, pane geometry, form
   * generation, or option list refuses, so no invisible field can be clicked.
   */
  private activateFormHostAtFrom(
    shown: DisplayedFormHostRow | undefined,
    column: number,
    row: number,
    cols: number,
    rows: number,
  ): boolean {
    if (shown === undefined) return false;
    if (shown.pane === "saved") return this.activateSavedHostAtFrom(shown, column, row, cols, rows);
    if (!this._visible || this._focus !== "form" || this.formKind !== "new"
      || this.pendingCreate !== undefined) return false;
    if (!validHitGeometry(column, row, cols, rows)) return false;
    if (shown.cols !== cols || shown.rows !== rows || shown.row !== row) return false;
    if (this.formGeneration !== shown.formGeneration) return false;
    if (shown.optionKey !== this.newFormHostOptionsKey()) return false;
    if (column >= shown.valueStart && column < shown.valueEnd) {
      this.cycleNewFormHost(1);
      return true;
    }
    this.formHostFocused = true;
    this.onInvalidate?.();
    return true;
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
    if (shown.renderToken !== undefined || displayed.remote !== undefined) {
      // A REMOTE drawn row acts only through the exact written picker frame that
      // drew it, and only on the same opaque owner entry: never by matching a
      // display id, file, or caption, and never through a local route.
      const remote = displayed.remote;
      const candidate = this.savedPickerCandidate;
      if (remote === undefined || shown.renderToken === undefined || this.savedHost.kind !== "remote"
        || candidate === undefined || candidate.token !== shown.renderToken || !candidate.written
        || !this.remoteSavedCandidateCurrent(candidate)) return false;
      if (this.remoteSavedRowAt(displayed.index)?.entryId !== remote.entryId) return false;
      if (this.savedHostFocused) {
        this.savedHostFocused = false;
        this.onInvalidate?.();
      }
      // The press acts on the drawn row of the written frame WITHOUT moving the
      // selection, so the frame it came from stays the current written receipt
      // that Main's last-instant re-proof requires.
      this.activateRemoteSavedRow(displayed.index);
      return true;
    }
    if (this.savedHost.kind !== "local") return false;
    const currentIndex = this.savedRows.findIndex((candidate) => candidate.id === displayed.entry.id
      && candidate.file === displayed.entry.file);
    if (currentIndex < 0) return false;
    this.savedSelectedIndex = currentIndex;
    this.activateSavedRow();
    return true;
  }

  /**
   * Selects the exact network row this captured render actually drew at the
   * pressed pane coordinate and performs its ordinary Enter action once through
   * the pane's single activation routine — the same action the Enter key runs,
   * so no second copy of any menu action exists.
   *
   * The target is the written row's immutable identity, never its index: a
   * snapshot that reordered, changed, or removed that row refuses the press
   * instead of retargeting it, and a hidden, replaced, superseded, or
   * differently sized pane authorizes nothing. Selecting a destination, opening
   * the Add-destination menu, or opening a pending request's review decides
   * nothing: consent, removal, and revoke keep their existing separately
   * confirmed written-confirmation paths, and no field value is touched.
   */
  private activatePeerAtFrom(
    shown: DisplayedPeerRows | undefined,
    column: number,
    row: number,
    cols: number,
    rows: number,
  ): boolean {
    if (!this._visible || this._focus !== "form" || this.formKind !== "peer"
      || !validHitGeometry(column, row, cols, rows)) return false;
    if (shown === undefined || shown.cols !== cols || shown.rows !== rows) return false;
    // The captured map must still be the map the pane currently draws: same
    // geometry, same drawn ordering, and each written row still on the pane row
    // it was written on. A reordered, scrolled, or re-flowed pane refuses rather
    // than letting an old coordinate activate whatever now sits there.
    const live = this.peerDisplay;
    if (live === undefined || !sameDisplayedPeerRows(shown, live)) return false;
    const clicked = shown.entries.find((candidate) => candidate.paneRow === row);
    if (clicked === undefined) return false;
    // The row now drawn on that written pane row must still be the same target,
    // and the current complete render must still draw it with the same semantic
    // intent it was drawn with. Stale targets refuse rather than reinterpret.
    const drawn = live.entries.find((candidate) => candidate.paneRow === row);
    if (drawn === undefined || !samePeerPaneRow(drawn.row, clicked.row)) return false;
    const current = this.drawnPeerPaneRow(drawn.row.key);
    if (current === undefined || !samePeerPaneRow(current, drawn.row)) return false;
    this.peerSelectedKey = current.key;
    this.performPeerPaneAction(current);
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
    // The remote-close dialog's written proof is re-established the same way:
    // only a complete render of the exact frozen target can mint/keep its token.
    this.remoteCloseRendered = false;
    if (!this._visible) {
      // A hidden pane draws no form, so nothing of the drawn New form survives it.
      this.invalidateCreateFormPresentation();
      this.invalidateSavedPickerPresentation();
      this.invalidateSavedDeleteConfirmationDisplay();
      this.invalidateRemoteCloseConfirmationDisplay();
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
    this.remoteCloseRendered = false;
    this.invalidateSavedDeleteConfirmationDisplay();
    // A standalone roster render draws no form pane. The wide layout renders the
    // roster and then the form in one pass, so only a render that is NOT part of
    // a form pass may retire the drawn New form.
    if (this._focus !== "form") {
      this.invalidateCreateFormPresentation();
      this.invalidateSavedPickerPresentation();
    }
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
    this.remoteCloseRendered = false;
    this.invalidateSavedDeleteConfirmationDisplay();
    this.displayedSavedRows = undefined;
    // Only the network pane owns the displayed peer-row mapping; every other
    // form-slot pane forgets it so a stale map can never authorize an action.
    if (this.formKind !== "peer") this.peerDisplay = undefined;
    // Likewise only an uncovered Saved picker render may keep its drawn frame.
    if (this.formKind !== "saved" || this.peerConsentConfirmationActive) this.invalidateSavedPickerPresentation();
    if (cols < FORM_MIN_COLS || rows < FORM_MIN_ROWS) {
      this.invalidateSavedPickerPresentation();
      // An unshowable form-slot frame forgets the drawn network rows and
      // revokes any consent candidate/proof: nothing off-screen may act, and no
      // earlier receipt may be restored by a later render at the old geometry.
      this.peerDisplay = undefined;
      this.invalidatePeerConsentDisplay();
      // An unshowable New form is not on screen at all.
      this.invalidateCreateFormPresentation();
      return this.renderTooSmall(cols, rows);
    }
    if (this.peerConsentConfirmationActive) {
      // Wide hostConfirmation slot: the security-sensitive consent dialog is
      // placed in the right-hand pane while confirm focus is unchanged. The
      // roster render stays independent for the left-hand notice/rows.
      // A covering dialog means the New form is not the displayed pane.
      this.invalidateCreateFormPresentation();
      return this.renderPeerConsentPane(cols, rows);
    }
    if (this.formKind === "peer") {
      this.invalidateCreateFormPresentation();
      return this.renderPeerPane(cols, rows);
    }
    if (this.formKind === "peer-field") {
      this.invalidateCreateFormPresentation();
      return this.renderPeerFieldPane(cols, rows);
    }
    if (this.formKind === "saved") {
      this.invalidateCreateFormPresentation();
      return this.renderSavedPane(cols, rows);
    }
    if (this.formKind === "shortcuts") {
      this.invalidateCreateFormPresentation();
      return this.renderHostShortcutPane(cols, rows);
    }
    // The New/Edit pane is the only render that re-establishes (or, for an
    // absent/covered/Edit/Local form, retires) the drawn New-form candidate.
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
    this.remoteCloseRendered = false;
    this.invalidateSavedDeleteConfirmationDisplay();
    this.invalidateCreateFormPresentation();
    // The confirmation covers the picker: its drawn frame is not on screen.
    this.invalidateSavedPickerPresentation();
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
      // A confirmation replaces the content pane: the New form is not drawn.
      this.invalidateCreateFormPresentation();
      this.invalidateSavedPickerPresentation();
      if (cols < ROSTER_MIN_COLS || rows < ROSTER_MIN_ROWS) {
        this.stopConfirmDisplayed = false;
        this.peerConfirmDisplayed = false;
        this.invalidateSavedDeleteConfirmationDisplay();
        this.invalidatePeerConsentDisplay();
        // An unshowable confirmation proves nothing: no pending remote close
        // keeps a written receipt or a confirmable token at this geometry.
        this.invalidateRemoteCloseConfirmationDisplay();
        return this.renderTooSmall(cols, rows);
      }
      return this.renderConfirmPane(cols, rows);
    }
    this.invalidateSavedDeleteConfirmationDisplay();
    // Roster-only focus draws no content pane, so nothing of a drawn New form
    // (or Saved picker frame) can be submitted from it.
    this.invalidateCreateFormPresentation();
    this.invalidateSavedPickerPresentation();
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
    if (entry === undefined) {
      return;
    }
    if (entry.kind === "remote") {
      // Composite entry key: two hosts exposing the same opaque row id keep
      // independent expansion state.
      if (this.collapsedRemoteEntryKeys.has(entry.key)) {
        this.collapsedRemoteEntryKeys.delete(entry.key);
      } else {
        this.collapsedRemoteEntryKeys.add(entry.key);
      }
      return;
    }
    if (entry.kind !== "item" || entry.item === undefined) {
      return;
    }
    const id = entry.item.id;
    if (this.collapsedItemIds.has(id)) {
      this.collapsedItemIds.delete(id);
    } else {
      this.collapsedItemIds.add(id);
    }
  }

  /** Rendered height of one entry: local cards are 3/5 rows, remote cards 4/6, actions 1. */
  private entryHeight(entry: SidebarEntry | undefined): number {
    if (entry?.kind === "diagnostics") return DIAGNOSTICS_ENTRY_ROWS;
    if (entry?.kind === "remote") {
      return this.collapsedRemoteEntryKeys.has(entry.key)
        ? REMOTE_CARD_COLLAPSED_ROWS
        : REMOTE_CARD_EXPANDED_ROWS;
    }
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
    if (entry.kind === "remote") {
      // The emitted target is the structure of the card that was actually
      // drawn. A vanished, replaced, stale, reordered, or otherwise changed
      // card refuses instead of retargeting whatever now holds its key.
      const shown = displayed?.kind === "remote" ? displayed : undefined;
      const remote = shown?.remote;
      if (shown === undefined || remote === undefined || !sameSidebarEntry(entry, shown)) return;
      this.cancelRowResume();
      this.selectedEntryKey = entry.key;
      this.desiredSelectionId = undefined;
      this.noticeError = undefined;
      // Same existing selection convention as a local row: the sidebar stays
      // visible and focus returns to Main. Main resolves the actual remote
      // content owner separately; no local action, connect, pair, or fallback
      // is emitted here.
      this._focus = "main";
      this.emit({
        type: "select-remote",
        hostId: remote.hostId,
        hostRunId: remote.hostRunId,
        rowId: remote.row.id,
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
    if (entry?.kind === "remote") {
      // A remote card is never a local row: this asks the OWNER host about its
      // own session through Main's independent written-highlight gate. Nothing
      // is stopped, removed, or confirmed here.
      this.requestRemoteClose();
      return;
    }
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

  // --- Remote Close: the owner's row, asked over the existing roster lane. ---

  /**
   * One deliberate `d`/Delete on a remote card. It emits the drawn target and
   * nothing else: no confirmation flag, no local removal, no guess. Main proves
   * the exact written highlight and decides whether an owner request may be
   * sent directly or needs this operator's written confirmation first.
   */
  private requestRemoteClose(): void {
    const shown = this.displayedRoster;
    const drawn = shown !== undefined && shown.selectedKey !== undefined
      && shown.selectedKey === this.selectedEntryKey
      ? this.remoteCloseRowFrom(shown)
      : undefined;
    if (drawn === undefined) {
      this.noticeError = "Highlight a completely displayed remote session row to close it";
      return;
    }
    if (drawn.hostRunId === null || drawn.hostRunId.length === 0) {
      // No observed owner run: a Close is never guessed against another run.
      this.noticeError = "That remote session's owner run was not observed; no close was requested";
      return;
    }
    this.noticeError = undefined;
    this.emit({
      type: "remote-close-request",
      hostId: drawn.hostId,
      hostRunId: drawn.hostRunId,
      rowId: drawn.rowId,
    });
  }

  /**
   * Opens the deliberate remote-close confirmation for the frozen target. The
   * generation advances on every open, so a re-opened dialog is a new decision
   * even when every drawn byte matches the previous one.
   */
  private openRemoteCloseConfirmation(target: FrozenRemoteCloseTarget): void {
    this.forgetDisplayedRoster(); // the confirmation replaces the roster
    this.remoteCloseTarget = target; // frozen: later navigation never retargets
    this.remoteCloseGeneration += 1;
    this.remoteCloseNotice = undefined;
    this.invalidateRemoteCloseConfirmationDisplay();
    this.confirmPurpose = "remote-close";
    this._focus = "confirm";
    this.onInvalidate?.();
  }

  /**
   * Cancel without any owner request: the highlighted row, focus ownership, and
   * every local session stay exactly as they were, and nothing is emitted.
   */
  private cancelRemoteCloseConfirmation(): void {
    this.remoteCloseTarget = undefined;
    this.remoteCloseNotice = undefined;
    this.invalidateRemoteCloseConfirmationDisplay();
    this.confirmPurpose = "quit";
    this._focus = "sidebar";
    this.onInvalidate?.();
  }

  /**
   * One deliberate confirmation of the frozen target, emitted only while this
   * exact dialog frame is current AND already settled by the actual writer.
   * Main rechecks the same receipt synchronously before it awaits anything, so a
   * cancelled, superseded, too-small, queued, held, or stale frame sends nothing.
   */
  private applyRemoteCloseConfirmation(data: string): void {
    const display = this.remoteCloseDisplay;
    const target = this.remoteCloseTarget;
    if (display === undefined || target === undefined
      || !this.isRemoteCloseConfirmationRenderCurrent(display.generation, display.token)) {
      this.remoteCloseNotice = "No current dialog frame; no close was requested";
      this.onInvalidate?.();
      return;
    }
    if (this.remoteCloseWrittenToken !== display.token) {
      this.remoteCloseNotice = "No written receipt for this dialog yet; no close was requested";
      this.onInvalidate?.();
      return;
    }
    const generation = display.generation;
    const renderToken = display.token;
    // Claim the held confirm key so its repeat/release cannot submit twice.
    this.claimHeldAction(this.peerConsentActionMatcher(data));
    // Dispatch while this exact dialog is still current: Main's synchronous
    // guard must observe a live, current, written dialog for this generation.
    this.emit({
      type: "remote-close-confirmed",
      hostId: target.hostId,
      hostRunId: target.hostRunId,
      rowId: target.rowId,
      generation,
      renderToken,
    });
    // Dismiss only the same dialog this intent came from, and only while its
    // written proof still stands: a refused submission keeps the frame (and its
    // notice) so the operator can review it again.
    if (this.remoteCloseTarget !== target || this.remoteCloseGeneration !== generation) return;
    if (this.remoteCloseDisplay === undefined || this.remoteCloseWrittenToken !== renderToken) {
      this.remoteCloseNotice = "No current written dialog frame; no close was requested";
      this.onInvalidate?.();
      return;
    }
    this.remoteCloseTarget = undefined;
    this.remoteCloseNotice = undefined;
    this.invalidateRemoteCloseConfirmationDisplay();
    this.confirmPurpose = "quit";
    this._focus = "sidebar";
    this.onInvalidate?.();
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
    // Standard Shift+Tab is recognized BEFORE the bracketed-paste carry: the
    // canonical back-tab packet ends with a lone ESC[ prefix, which that fence
    // would otherwise park as a possible paste opener and consume. Nothing is
    // bypassed while a real paste is in progress or a carry is outstanding.
    if (!this.formPasteActive && this.formPasteCarry.length === 0
      && this.formKind === "new" && matchesShiftTab(data)
      && this.handleNewFormHostKey(data)) return;
    if (this.routeBracketedPaste(data)) {
      // A pasted body is opaque to host actions, and it can never edit a field
      // the operator is not typing in: while the New form's Host line owns the
      // focus the chunk is consumed instead of reaching the hidden editor.
      if (this.formKind !== "new" || !this.formHostFocused) this.formField?.handleInput(data);
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
      // A network field editor holds exactly one field: Tab cycles nothing here
      // and is consumed rather than inserted into the value or forwarded.
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
    // The New form's Host line is one host-owned selection control: Shift+Tab
    // reaches it, Tab (or one fresh Escape) returns to the ordinary workspace
    // editor, and its cycle keys act only while IT holds the form's focus.
    // Nothing here changes the path editor's own keys while it has the focus.
    if (this.handleNewFormHostKey(data)) return;
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
    // Every opening shows LOCAL with a blank query; nothing of an earlier
    // remote choice, its results, or its pending UI ownership survives.
    this.resetRemoteSavedPicker();
    this._focus = "form";
    this.displayedSavedRows = undefined;
    const requestId = this.nextRequestId++;
    this.savedPickerId = requestId;
    this.savedQueryRevision = 0;
    this.openSavedQueryInput();
    this.pendingSavedList = { requestId };
    this.emit({ type: "saved-list", requestId });
  }

  /** A fresh native query Input (blank), with the same fallback notice as before. */
  private openSavedQueryInput(): void {
    this.disposeSavedQueryInput();
    let inputNotice: string | undefined;
    let input: SidebarSavedQueryInput;
    try {
      input = this.createSavedQueryInput?.() ?? createDefaultSavedQueryInput();
    } catch {
      input = createDefaultSavedQueryInput();
      inputNotice = "Native query input is unavailable; using Pi's default keys";
    }
    this.savedQueryInput = input;
    this.savedQueryNotice = inputNotice ?? input.notice;
  }

  /** Drop every remote Saved fact and UI ownership; accepted owner work is never cancelled. */
  private resetRemoteSavedPicker(): void {
    this.savedHost = { kind: "local" };
    this.savedHostFocused = false;
    this.remoteSaved = undefined;
    this.remoteSavedNotice = undefined;
    this.pendingRemoteSavedResume = undefined;
    this.pendingRemoteSavedDeleteCheck = undefined;
    this.remoteSavedDeleteTarget = undefined;
    this.remoteSavedDeleteOperation = undefined;
    this.remoteSavedPolicyOverlay = undefined;
    this.retireSavedViewAuthority();
  }

  /**
   * Advance the monotonic Saved view epoch: the drawn remote frame and every
   * frozen remote operation lose their UI authority for good (a later return to
   * identical values cannot revive them), and an unanswered Delete prepare is
   * dropped. A pending Resume keeps only its duplicate fence; its late reply can
   * no longer select anything. Accepted owner work is never cancelled.
   */
  private retireSavedViewAuthority(): void {
    this.savedViewEpoch += 1;
    this.invalidateSavedPickerPresentation();
    this.pendingRemoteSavedDeleteCheck = undefined;
  }

  /**
   * Dismisses the picker and restores the roster display. Cancelling an
   * outstanding listing only aborts that read; it never pauses, stops, or
   * rolls back any instance. A pending saved-open keeps running in the
   * backend; its late result is fenced by requestId.
   */
  private dismissSavedPane(): void {
    const pickerId = this.savedPickerId;
    if (pickerId !== undefined) {
      // Closed discriminator: a remote picker retires only through its own
      // remote intent and never reaches Main's local catalog route.
      if (this.savedHost.kind === "remote") {
        this.emit({ type: "saved-remote-dismiss", pickerId, hostId: this.savedHost.hostId });
      } else {
        this.emit({ type: "saved-dismiss", pickerId });
      }
    }
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
    // The Host line (shown only when a remote choice exists) is reached with
    // standard Shift+Tab, recognized before the bracketed-paste carry exactly as
    // the New form's Host line is. Nothing is bypassed during a real paste.
    if (!this.formPasteActive && this.formPasteCarry.length === 0
      && this.savedHostLineShown() && matchesShiftTab(data)
      && this.handleSavedHostKey(data)) return;
    // Bracketed paste is opaque in the picker and never activates a row; a
    // streamed body chunk that merely equals a host/native action must not
    // dismiss or delete. The native Input still owns paste insertion, except
    // while the Host line owns focus: a paste never edits a hidden query.
    if (this.routeBracketedPaste(data)) {
      if (!this.savedHostFocused) this.feedSavedQueryInput(data);
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
    // While the Host line owns focus only its own selection gestures act.
    if (this.savedHostFocused && this.handleSavedHostKey(data)) return;
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
    // Local and remote rows take separate routes: a remote row can never reach a
    // local saved-open/delete action (or the reverse), whatever its id or file.
    if (this.savedMatches(data, "app.session.delete")) {
      if (this.savedHost.kind === "remote") this.beginRemoteSavedDeleteCheck("app.session.delete");
      else this.beginSavedDeleteCheck("app.session.delete");
      return;
    }
    if (this.savedMatches(data, "app.session.deleteNoninvasive")) {
      if (this.savedQuery.length !== 0) this.feedSavedQueryInput(data);
      else if (this.savedHost.kind === "remote") this.beginRemoteSavedDeleteCheck("app.session.deleteNoninvasive");
      else this.beginSavedDeleteCheck("app.session.deleteNoninvasive");
      return;
    }
    if (this.savedMatches(data, "tui.select.confirm")) {
      if (this.savedHost.kind === "remote") this.activateRemoteSavedRow(this.savedSelectedIndex);
      else this.activateSavedRow();
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
      if (this.savedHost.kind === "remote") {
        // The OWNER matches the exact query text; this side never searches,
        // indexes, or filters anything itself.
        this.requestRemoteSavedResult(false);
      } else if (this.savedPickerId !== undefined) {
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
    if (this.savedHost.kind !== "local") return;
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
    if (this.savedHost.kind === "remote") {
      // Absolute wrap over the FULL owner total (0 -> last and last -> 0); an
      // uncached target is reached through one bounded window read.
      const total = this.remoteSaved?.result?.total ?? 0;
      if (total === 0) return;
      const current = Math.min(this.savedSelectedIndex, total - 1);
      const next = delta > 0
        ? (current + 1 >= total ? 0 : current + 1)
        : (current === 0 ? total - 1 : current - 1);
      if (next !== this.savedSelectedIndex) {
        this.savedSelectedIndex = next;
        // An actual selection change permanently retires every written frame
        // and pending UI ownership; moving back never revives them.
        this.retireSavedViewAuthority();
      }
      this.requestRemoteSavedCoverage();
      return;
    }
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
    if (this.savedHost.kind !== "local") return;
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
    if (this.savedHost.kind !== "local") return false;
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
      || this.formKind !== "saved" || this.pendingSavedList !== undefined
      || this.savedHost.kind !== "local") return false;
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
    // Remote picker state never outlives its pane. This releases UI ownership
    // only: accepted owner work is never cancelled, stopped, or replayed.
    this.resetRemoteSavedPicker();
  }

  private disposeSavedQueryInput(): void {
    const input = this.savedQueryInput;
    this.savedQueryInput = undefined;
    try { input?.dispose(); } catch { /* private query text is discarded even if UI cleanup fails */ }
  }

  // --- Saved picker Host line: Local by default, one host-owned selection. ---

  /**
   * The Host choices the Saved picker can name: Local first, then every
   * destination the attached DTO reports connected AND describes with the
   * optional Saved facts, with its exact observed owner run (an empty roster
   * still reports one) and the OWNER's descriptive Saved support and delete
   * exposure. A connected legacy owner described as unsupported stays an honest
   * unsupported choice; a destination whose DTO carries no Saved description at
   * all (an older coordinator) is not offered, so a Main without the Saved
   * provider exposes no remote Saved choice. A destination the operator already
   * chose stays listed after it disconnects or vanishes, so nothing silently
   * falls back to Local or retargets another host. This viewer's own network
   * settings are never consulted.
   */
  private savedHostOptions(): SavedHostOption[] {
    const options: SavedHostOption[] = [{
      kind: "local", hostId: "", label: NEW_FORM_LOCAL_HOST_LABEL, hostRunId: null,
      connected: true, supported: true, deleteExposed: null,
    }];
    const chosen = this.savedHost;
    const chosenHostId = chosen.kind === "remote" ? chosen.hostId : undefined;
    let chosenListed = false;
    for (const host of this.peerUiSnapshot?.hosts ?? []) {
      const chosenHere = chosenHostId !== undefined && host.id === chosenHostId;
      if (!chosenHere && (host.state !== "connected" || host.saved === undefined)) continue;
      if (chosenHere) chosenListed = true;
      const hostRunId = peerHostRosterRunId(host);
      const supported = host.saved?.supported === true;
      const overlay = this.remoteSavedPolicyOverlay;
      const exposure = chosenHere && overlay !== undefined && overlay.hostId === host.id
        && hostRunId !== null && overlay.hostRunId === hostRunId
        ? overlay.deleteExposed
        : host.saved?.deleteExposed ?? null;
      options.push({
        kind: "remote",
        hostId: host.id,
        label: sanitizeBounded(host.label, PEER_LABEL_MAX_CODEPOINTS),
        hostRunId,
        connected: host.state === "connected",
        supported,
        // An unsupported destination exposes nothing, whatever else it reports.
        deleteExposed: supported ? exposure : null,
      });
    }
    if (chosen.kind === "remote" && !chosenListed) {
      options.push({
        kind: "remote", hostId: chosen.hostId, label: chosen.label, hostRunId: null,
        connected: false, supported: false, deleteExposed: null,
      });
    }
    return options;
  }

  /** Stable identity of the Saved Host line's current choice. */
  private savedHostKey(): string {
    return newFormHostOptionKey(this.savedHost.kind === "local"
      ? { kind: "local", hostId: "" }
      : { kind: "remote", hostId: this.savedHost.hostId });
  }

  /** The drawn identity of the Saved option list plus its current choice. */
  private savedHostOptionsKey(): string {
    return JSON.stringify([
      this.savedHostOptions().map((option) => [
        newFormHostOptionKey(option), option.label, option.hostRunId, option.connected,
        option.supported, option.deleteExposed,
      ]),
      this.savedHostKey(),
    ]);
  }

  /** The current Saved choice as the fresh option list describes it. */
  private currentSavedHostOption(): SavedHostOption | undefined {
    const key = this.savedHostKey();
    return this.savedHostOptions().find((option) => newFormHostOptionKey(option) === key);
  }

  /**
   * The Host line exists only while a peer snapshot is attached AND at least one
   * connected destination is described as Saved-capable (or a remote choice is
   * already made); otherwise the picker is exactly the existing Local picker,
   * row for row, key for key.
   */
  private savedHostLineShown(): boolean {
    if (this.peerUiSnapshot === undefined || this.formKind !== "saved") return false;
    return this.savedHost.kind === "remote"
      || this.savedHostOptions().some((option) => option.kind === "remote" && option.supported);
  }

  /** True only for a connected, Saved-capable destination with an observed owner run. */
  private remoteSavedHostUsable(
    option: SavedHostOption | undefined,
  ): option is SavedHostOption & { readonly kind: "remote"; readonly hostRunId: string } {
    return option !== undefined && option.kind === "remote" && option.connected && option.supported
      && typeof option.hostRunId === "string" && option.hostRunId.length > 0;
  }

  /** Fixed body text for a remote choice that cannot be asked anything. */
  private remoteSavedUnusableText(option: SavedHostOption | undefined): string | undefined {
    if (option === undefined || option.kind !== "remote" || !option.connected) return REMOTE_SAVED_DISCONNECTED_NOTICE;
    if (!option.supported) return REMOTE_SAVED_UNSUPPORTED_NOTICE;
    if (option.hostRunId === null || option.hostRunId.length === 0) return REMOTE_SAVED_NO_RUN_NOTICE;
    return undefined;
  }

  /** A remote Saved picker currently owns the pane (its list or its delete dialog). */
  private remoteSavedPickerOpen(): boolean {
    return this.savedPickerId !== undefined && this.savedHost.kind === "remote" && this.remoteSaved !== undefined
      && (this.formKind === "saved" || this.confirmPurpose === "saved-delete");
  }

  /** Cycle the one Saved Host selection; never a connect, retry, or retarget. */
  private cycleSavedHost(direction: 1 | -1): void {
    if (this.formKind !== "saved") return;
    const options = this.savedHostOptions();
    if (options.length < 2) return;
    const key = this.savedHostKey();
    const index = options.findIndex((option) => newFormHostOptionKey(option) === key);
    const next = index < 0
      ? options[0]
      : options[((index + direction) % options.length + options.length) % options.length];
    if (next !== undefined) this.selectSavedHost(next);
  }

  /**
   * One ACTUAL Saved Host change. Selecting the same choice is a no-op. A
   * different choice retires the previous picker identity through its own
   * existing route (Local: `saved-dismiss` and any pending listing's
   * `saved-cancel`; remote: `saved-remote-dismiss`), clears the query and every
   * result, re-mints the picker identity, and lists the new choice: Local through
   * the unchanged `saved-list`, a remote owner through one `saved-remote-list`
   * when it can be asked at all. No per-host query history is kept.
   */
  private selectSavedHost(option: SavedHostOption): void {
    const previousPicker = this.savedPickerId;
    if (this.formKind !== "saved" || this._focus !== "form" || previousPicker === undefined) return;
    if (newFormHostOptionKey(option) === this.savedHostKey()) return;
    if (this.savedHost.kind === "local") {
      this.emit({ type: "saved-dismiss", pickerId: previousPicker });
      if (this.pendingSavedList !== undefined) {
        this.emit({ type: "saved-cancel", requestId: this.pendingSavedList.requestId });
        this.pendingSavedList = undefined;
      }
    } else {
      this.emit({ type: "saved-remote-dismiss", pickerId: previousPicker, hostId: this.savedHost.hostId });
    }
    const hostFocused = this.savedHostFocused;
    this.resetRemoteSavedPicker();
    this.savedHostFocused = hostFocused;
    this.savedRows = [];
    this.savedIssueCount = 0;
    this.savedError = undefined;
    this.savedSelectedIndex = 0;
    this.savedListTop = 0;
    // A changed Host retires every pending UI ownership of the old choice; the
    // backend work itself is never cancelled by this.
    this.pendingSavedOpen = undefined;
    this.pendingSavedDeleteCheck = undefined;
    this.savedDeleteTarget = undefined;
    this.savedDeleteOperation = undefined;
    this.invalidateSavedDeleteConfirmationDisplay();
    this.displayedSavedRows = undefined;
    this.openSavedQueryInput();
    const pickerId = this.nextRequestId++;
    this.savedPickerId = pickerId;
    this.savedQueryRevision = 0;
    if (option.kind === "local") {
      this.pendingSavedList = { requestId: pickerId };
      this.emit({ type: "saved-list", requestId: pickerId });
    } else {
      this.savedHost = { kind: "remote", hostId: option.hostId, label: option.label };
      this.remoteSaved = {
        hostId: option.hostId,
        catalog: undefined,
        result: undefined,
        windows: [],
        resultRead: undefined,
        windowReads: [],
      };
      this.requestRemoteSavedResult(true);
    }
    this.onInvalidate?.();
  }

  /**
   * One key while the Saved picker's Host line is reachable. Shift+Tab focuses
   * it; while it owns focus, Up/Left and Down/Right cycle the choice, Tab,
   * Shift+Tab, or one fresh Escape return to the query, and every other key is
   * consumed so it can never edit the query underneath. Mirrors the New form.
   */
  private handleSavedHostKey(data: string): boolean {
    if (this.formKind !== "saved" || !this.savedHostLineShown()) {
      this.savedHostFocused = false;
      return false;
    }
    if (!this.savedHostFocused) {
      if (!matchesShiftTab(data)) return false;
      if (!isKeyRelease(data) && !isKeyRepeat(data)) {
        this.savedHostFocused = true;
        this.onInvalidate?.();
      }
      return true;
    }
    if (matchesKey(data, "tab") || matchesShiftTab(data)) {
      if (!isKeyRelease(data) && !isKeyRepeat(data)) {
        this.savedHostFocused = false;
        this.onInvalidate?.();
      }
      return true;
    }
    if (isKeyRelease(data) || isKeyRepeat(data)) return true;
    if (matchesKey(data, "escape")) {
      // Leaving the control is the picker's own back gesture: no dismissal, and
      // the still-held Escape keeps its fence. The Escape was consumed as a key,
      // so it is not left behind as a possible paste-opener prefix either.
      this.formEscapeClaimed = true;
      this.formPasteCarry = "";
      this.savedHostFocused = false;
      this.onInvalidate?.();
      return true;
    }
    if (matchesKey(data, "up") || matchesKey(data, "left")) this.cycleSavedHost(-1);
    else if (matchesKey(data, "down") || matchesKey(data, "right")) this.cycleSavedHost(1);
    return true;
  }

  /** Activates only the Saved Host line the captured render actually drew. */
  private activateSavedHostAtFrom(
    shown: DisplayedFormHostRow,
    column: number,
    row: number,
    cols: number,
    rows: number,
  ): boolean {
    if (!this._visible || this._focus !== "form" || this.formKind !== "saved") return false;
    if (!validHitGeometry(column, row, cols, rows)) return false;
    if (shown.cols !== cols || shown.rows !== rows || shown.row !== row) return false;
    if (this.savedPickerId !== shown.formGeneration) return false;
    if (!this.savedHostLineShown() || shown.optionKey !== this.savedHostOptionsKey()) return false;
    if (column >= shown.valueStart && column < shown.valueEnd) {
      this.cycleSavedHost(1);
      return true;
    }
    this.savedHostFocused = true;
    this.onInvalidate?.();
    return true;
  }

  // --- Remote Saved windows: bounded reads over ONE owner result. ---

  /** One cached owner row at an absolute result index, or undefined (loading). */
  private remoteSavedRowAt(index: number): RemoteSavedRow | undefined {
    const state = this.remoteSaved;
    if (state === undefined) return undefined;
    for (const window of state.windows) {
      const relative = index - window.offset;
      if (relative >= 0 && relative < window.rows.length) return window.rows[relative];
    }
    return undefined;
  }

  /** Window request size: the drawn list height within the lane's existing bounds. */
  private remoteSavedWindowCount(): number {
    return Math.min(REMOTE_SAVED_MAX_WINDOW_ROWS, Math.max(REMOTE_SAVED_PAGE_ROWS, this.savedLastListRows));
  }

  /**
   * Ask the owner for a new result for the current query: `saved-remote-search`
   * inside the bound catalog of the same run, otherwise (or when `forceList`) a
   * fresh `saved-remote-list`. The previous result, its windows, and every
   * outstanding read are retired first; the newest intent is the first
   * submission of THAT query, never a retry. Nothing is asked of a destination
   * that is disconnected, unsupported, or has no observed run.
   */
  private requestRemoteSavedResult(forceList: boolean): void {
    const state = this.remoteSaved;
    const pickerId = this.savedPickerId;
    if (state === undefined || pickerId === undefined) return;
    this.retireSavedViewAuthority();
    state.result = undefined;
    state.windows = [];
    state.windowReads = [];
    state.resultRead = undefined;
    this.displayedSavedRows = undefined;
    const option = this.currentSavedHostOption();
    if (!this.remoteSavedHostUsable(option)) return;
    const hostRunId = option.hostRunId;
    const catalog = !forceList && state.catalog !== undefined && state.catalog.hostRunId === hostRunId
      ? state.catalog
      : undefined;
    if (catalog === undefined) state.catalog = undefined;
    const requestId = this.nextRequestId++;
    const count = this.remoteSavedWindowCount();
    const query = this.savedQuery;
    const revision = this.savedQueryRevision;
    state.resultRead = Object.freeze({
      requestId,
      kind: catalog === undefined ? "list" as const : "search" as const,
      revision,
      hostRunId,
      catalogId: catalog?.catalogId,
      resultId: undefined,
      offset: 0,
      count,
    });
    if (catalog === undefined) {
      this.emit({
        type: "saved-remote-list", pickerId, requestId, revision,
        hostId: state.hostId, hostRunId, query, offset: 0, count,
      });
    } else {
      this.emit({
        type: "saved-remote-search", pickerId, requestId, revision,
        hostId: state.hostId, hostRunId, catalogId: catalog.catalogId, query, offset: 0, count,
      });
    }
  }

  /**
   * Make the selected row (first) and the drawn rows reachable through at most
   * one new bounded window read. The window is aligned to the request size; if
   * that aligned start is already cached (an earlier honest prefix was shorter),
   * the read starts AT the wanted index, so a short prefix can never repeat the
   * same window forever. Drawn-row reads never evict retained windows and never
   * stack, so the follow-up chain is bounded; the selection is always reachable.
   */
  private requestRemoteSavedCoverage(): void {
    const state = this.remoteSaved;
    const pickerId = this.savedPickerId;
    const result = state?.result;
    const catalog = state?.catalog;
    if (state === undefined || pickerId === undefined || result === undefined || catalog === undefined
      || state.resultRead !== undefined || result.total === 0) return;
    const option = this.currentSavedHostOption();
    if (!this.remoteSavedHostUsable(option) || option.hostRunId !== catalog.hostRunId) return;
    const selected = Math.min(this.savedSelectedIndex, result.total - 1);
    let target: number | undefined;
    if (this.remoteSavedRowAt(selected) === undefined) {
      target = selected;
    } else if (state.windowReads.length === 0
      && (state.windows.length < REMOTE_SAVED_MAX_WINDOWS
        || state.windows.some((window) => !this.remoteSavedWindowDrawn(window)))) {
      // Drawn-row follow-ups may only displace an OFF-screen window, so the
      // chain ends once every retained window is on screen: it is bounded.
      const { first, end } = this.remoteSavedVisibleRange();
      for (let index = first; index < end; index += 1) {
        if (this.remoteSavedRowAt(index) === undefined) {
          target = index;
          break;
        }
      }
    }
    if (target === undefined) return;
    const count = this.remoteSavedWindowCount();
    const aligned = Math.floor(target / count) * count;
    const offset = this.remoteSavedRowAt(aligned) === undefined ? aligned : target;
    if (state.windowReads.some((read) => read.offset === offset)) return;
    const requestId = this.nextRequestId++;
    const revision = this.savedQueryRevision;
    state.windowReads.push(Object.freeze({
      requestId,
      kind: "window" as const,
      revision,
      hostRunId: catalog.hostRunId,
      catalogId: catalog.catalogId,
      resultId: result.resultId,
      offset,
      count,
    }));
    while (state.windowReads.length > REMOTE_SAVED_MAX_WINDOWS) state.windowReads.shift();
    this.emit({
      type: "saved-remote-window", pickerId, requestId, revision,
      hostId: state.hostId, hostRunId: catalog.hostRunId,
      catalogId: catalog.catalogId, resultId: result.resultId, offset, count,
    });
  }

  /**
   * The list rows the next render will draw: the last drawn height from the
   * scroll top `savedScrollWindow` will choose, which always contains the
   * selection (so a selection that moved since the last render is never treated
   * as off screen). Pure; it moves nothing.
   */
  private remoteSavedVisibleRange(): { readonly first: number; readonly end: number } {
    const total = this.remoteSaved?.result?.total ?? 0;
    const listRows = Math.max(1, this.savedLastListRows);
    let top = Math.min(Math.max(this.savedListTop, 0), Math.max(0, total - 1));
    const selected = this.savedSelectedIndex;
    if (selected < top) top = selected;
    else if (selected >= top + listRows) top = selected - listRows + 1;
    return { first: top, end: Math.min(total, top + listRows) };
  }

  /** True when a retained window intersects the rows the next render draws. */
  private remoteSavedWindowDrawn(window: RemoteSavedWindow): boolean {
    const { first, end } = this.remoteSavedVisibleRange();
    return window.offset < end && window.offset + window.rows.length > first;
  }

  /**
   * Retain the newest window plus at most two others: windows on screen first,
   * then those nearest the selection. A window at the same offset, or one the
   * newest window fully covers, is dropped. No full-catalog allocation is ever
   * made from the owner's total.
   */
  private addRemoteSavedWindow(state: RemoteSavedState, window: RemoteSavedWindow): void {
    const selected = this.savedSelectedIndex;
    const windowEnd = window.offset + window.rows.length;
    const distance = (candidate: RemoteSavedWindow): number => {
      const last = candidate.offset + candidate.rows.length - 1;
      if (selected < candidate.offset) return candidate.offset - selected;
      if (selected > last) return selected - last;
      return 0;
    };
    const rank = (candidate: RemoteSavedWindow): number => (this.remoteSavedWindowDrawn(candidate) ? 0 : 1);
    const selectedBefore = this.remoteSavedRowAt(selected)?.entryId;
    const others = state.windows
      .filter((candidate) => candidate.offset !== window.offset
        && !(candidate.offset >= window.offset && candidate.offset + candidate.rows.length <= windowEnd))
      .sort((left, right) => rank(left) - rank(right) || distance(left) - distance(right));
    state.windows = [window, ...others.slice(0, REMOTE_SAVED_MAX_WINDOWS - 1)];
    // Merely re-received data is never a grant: losing the selected cached row
    // retires the view for good, and a drawn frame whose rows were evicted is
    // dropped instead of becoming current again when they are refetched.
    if (selectedBefore !== undefined && this.remoteSavedRowAt(selected)?.entryId !== selectedBefore) {
      this.retireSavedViewAuthority();
    }
    const candidate = this.savedPickerCandidate;
    if (candidate !== undefined && !candidate.presentation.drawn.every((drawn) =>
      this.remoteSavedRowAt(drawn.index)?.entryId === drawn.entryId)) {
      this.invalidateSavedPickerPresentation();
    }
  }

  /** Forget one answered (or failed) read so it is never re-awaited. */
  private retireRemoteSavedRead(state: RemoteSavedState, intent: RemoteSavedReadIntent): void {
    if (state.resultRead === intent) {
      state.resultRead = undefined;
      return;
    }
    state.windowReads = state.windowReads.filter((candidate) => candidate !== intent);
  }

  /**
   * True while a captured remote picker frame still describes the current pane:
   * it is the newest candidate, the pane is the visible Saved picker, and the
   * view epoch, picker, query revision, destination, run, live delete exposure,
   * catalog, result, total, selection, and every drawn row's cached owner entry
   * are unchanged. Any new Host, query, window replacement, eviction, selection
   * change (even one later reversed), dismissal, or resize fails it for good.
   */
  private remoteSavedCandidateCurrent(candidate: SavedPickerCandidate): boolean {
    if (candidate !== this.savedPickerCandidate) return false;
    if (!this._visible || this._focus !== "form" || this.formKind !== "saved") return false;
    const state = this.remoteSaved;
    const presentation = candidate.presentation;
    if (state === undefined || this.savedHost.kind !== "remote"
      || presentation.viewEpoch !== this.savedViewEpoch
      || presentation.pickerId !== this.savedPickerId
      || presentation.revision !== this.savedQueryRevision
      || presentation.hostId !== state.hostId) return false;
    const option = this.currentSavedHostOption();
    if (!this.remoteSavedHostUsable(option) || option.hostRunId !== presentation.hostRunId
      || (option.deleteExposed === true) !== presentation.deleteExposed) return false;
    if (state.resultRead !== undefined || state.catalog === undefined || state.result === undefined
      || state.catalog.hostRunId !== presentation.hostRunId
      || state.catalog.catalogId !== presentation.catalogId
      || state.result.resultId !== presentation.resultId
      || state.result.total !== presentation.total) return false;
    if (presentation.selectedIndex !== this.savedSelectedIndex) return false;
    return presentation.drawn.every((drawn) => this.remoteSavedRowAt(drawn.index)?.entryId === drawn.entryId);
  }

  /**
   * Freeze one remote entry operation from the ACTUAL-WRITTEN current picker
   * frame: the selected row (keyboard) or another row that frame drew (a press).
   * A loading placeholder is never actionable (silently, like an undrawn local
   * row); an unwritten, superseded, or changed frame refuses with a fixed notice
   * and sends nothing. File path and caption are display only: the operation
   * names opaque owner handles and the current view epoch exclusively.
   */
  private writtenRemoteSavedOperation(index: number): RemoteSavedOperation | undefined {
    const cached = this.remoteSavedRowAt(index);
    if (cached === undefined) return undefined;
    const candidate = this.savedPickerCandidate;
    if (candidate === undefined || !candidate.written || !this.remoteSavedCandidateCurrent(candidate)) {
      this.savedError = REMOTE_SAVED_UNWRITTEN_NOTICE;
      this.onInvalidate?.();
      return undefined;
    }
    const presentation = candidate.presentation;
    const drawn = presentation.drawn.find((row) => row.index === index);
    if (drawn === undefined || drawn.entryId !== cached.entryId) return undefined;
    const option = this.currentSavedHostOption();
    return Object.freeze({
      pickerId: presentation.pickerId,
      requestId: this.nextRequestId++,
      revision: presentation.revision,
      hostId: presentation.hostId,
      hostRunId: presentation.hostRunId,
      catalogId: presentation.catalogId,
      resultId: presentation.resultId,
      entryId: cached.entryId,
      index,
      selectedIndex: this.savedSelectedIndex,
      viewEpoch: this.savedViewEpoch,
      renderToken: presentation.renderToken,
      row: cached.row,
      hostLabel: option?.label ?? "",
    });
  }

  /**
   * True while a frozen remote operation still owns the picker: the same view
   * epoch (so no selection, query, result, Host, run, or eviction change has
   * happened since, even one later reversed), picker, query revision,
   * destination, usable run, catalog, result, selection, and the same cached
   * owner entry at its index.
   */
  private remoteSavedOperationOwned(operation: RemoteSavedOperation): boolean {
    const state = this.remoteSaved;
    if (operation.viewEpoch !== this.savedViewEpoch) return false;
    if (state === undefined || this.savedHost.kind !== "remote" || state.hostId !== operation.hostId) return false;
    if (this.savedPickerId !== operation.pickerId || this.savedQueryRevision !== operation.revision) return false;
    if (state.catalog === undefined || state.result === undefined
      || state.catalog.hostRunId !== operation.hostRunId || state.catalog.catalogId !== operation.catalogId
      || state.result.resultId !== operation.resultId) return false;
    const option = this.currentSavedHostOption();
    if (!this.remoteSavedHostUsable(option) || option.hostRunId !== operation.hostRunId) return false;
    if (this.savedSelectedIndex !== operation.selectedIndex) return false;
    return this.remoteSavedRowAt(operation.index)?.entryId === operation.entryId;
  }

  /**
   * Deliberately resume one remote row (Enter on the written selection, or a
   * press on a written drawn row). Emits exactly one `saved-remote-resume`
   * intent; the OWNER performs its native resume. Nothing local is opened.
   */
  private activateRemoteSavedRow(index: number): void {
    const state = this.remoteSaved;
    if (state === undefined || state.resultRead !== undefined
      || this.pendingRemoteSavedDeleteCheck !== undefined) return;
    if (this.pendingRemoteSavedResume !== undefined) {
      this.savedError = "A saved conversation is already starting";
      this.onInvalidate?.();
      return;
    }
    const operation = this.writtenRemoteSavedOperation(index);
    if (operation === undefined) return;
    this.pendingRemoteSavedResume = operation;
    this.savedError = undefined;
    // Same held-key fence as a local open: the confirm key's repeat/release
    // never reaches a later focused pane.
    const confirmMatcher = this.savedActionMatcher("tui.select.confirm");
    this.formSubmitClaim = confirmMatcher;
    this.claimSavedAction(confirmMatcher);
    this.emit({
      type: "saved-remote-resume",
      pickerId: operation.pickerId,
      requestId: operation.requestId,
      revision: operation.revision,
      hostId: operation.hostId,
      hostRunId: operation.hostRunId,
      catalogId: operation.catalogId,
      resultId: operation.resultId,
      entryId: operation.entryId,
      renderToken: operation.renderToken,
    });
  }

  /**
   * Remote delete key: refused with a fixed notice unless the OWNER currently
   * exposes remote delete; otherwise one owner prepare for the written selected
   * row. A prepare is never a confirmation.
   */
  private beginRemoteSavedDeleteCheck(action: "app.session.delete" | "app.session.deleteNoninvasive"): void {
    const state = this.remoteSaved;
    if (state === undefined || state.resultRead !== undefined || this.pendingRemoteSavedResume !== undefined
      || this.pendingRemoteSavedDeleteCheck !== undefined || this.remoteSavedDeleteTarget !== undefined) return;
    if (this.currentSavedHostOption()?.deleteExposed !== true) {
      this.claimSavedAction(this.savedActionMatcher(action));
      this.savedError = REMOTE_SAVED_DELETE_OFF_NOTICE;
      this.onInvalidate?.();
      return;
    }
    const operation = this.writtenRemoteSavedOperation(this.savedSelectedIndex);
    if (operation === undefined) return;
    this.pendingRemoteSavedDeleteCheck = operation;
    this.displayedSavedRows = undefined;
    this.savedError = undefined;
    this.claimSavedAction(this.savedActionMatcher(action));
    this.emit({
      type: "saved-remote-delete-prepare",
      pickerId: operation.pickerId,
      requestId: operation.requestId,
      revision: operation.revision,
      hostId: operation.hostId,
      hostRunId: operation.hostRunId,
      catalogId: operation.catalogId,
      resultId: operation.resultId,
      entryId: operation.entryId,
      renderToken: operation.renderToken,
    });
  }

  /**
   * The written remote delete confirmation: the same keys and the same written
   * warning fence as the local dialog. Pasted bodies never reach here (routed as
   * opaque by `handleConfirmInput`). An actual confirmation attempt while the
   * current owner exposure is Off, or whose run/result changed, closes with a
   * fixed notice; an emitted delete is never sent twice.
   */
  private handleRemoteSavedDeleteConfirmInput(data: string): void {
    if (this.savedMatches(data, "tui.select.cancel")) {
      this.claimSavedAction(this.savedActionMatcher("tui.select.cancel"));
      if (matchesKey(data, "escape")) this.formEscapeClaimed = true;
      this.cancelSavedDeleteConfirmation();
      return;
    }
    if (!this.savedDeleteConfirmationDisplayed || !this.savedMatches(data, "tui.select.confirm")) return;
    const target = this.remoteSavedDeleteTarget;
    if (target === undefined || this.remoteSavedDeleteOperation !== undefined
      || this.savedPickerId !== target.pickerId) return;
    const exposed = this.currentSavedHostOption()?.deleteExposed === true;
    if (!exposed || !this.remoteSavedOperationOwned(target)) {
      this.cancelSavedDeleteConfirmation();
      this.savedError = exposed ? REMOTE_SAVED_HOST_CHANGED_NOTICE : REMOTE_SAVED_DELETE_OFF_NOTICE;
      return;
    }
    const renderToken = this.savedDeleteConfirmationRenderToken;
    if (renderToken === undefined) return;
    const operation: RemoteSavedOperation = Object.freeze({
      ...target,
      requestId: this.nextRequestId++,
      renderToken,
    });
    this.remoteSavedDeleteOperation = operation;
    this.claimSavedAction(this.savedActionMatcher("tui.select.confirm"));
    this.emit({
      type: "saved-remote-delete",
      pickerId: operation.pickerId,
      requestId: operation.requestId,
      revision: operation.revision,
      hostId: operation.hostId,
      hostRunId: operation.hostRunId,
      catalogId: operation.catalogId,
      resultId: operation.resultId,
      entryId: operation.entryId,
      renderToken: operation.renderToken,
    });
  }

  /**
   * Apply a destination change to an open remote picker. A disconnected,
   * unsupported, or re-run destination retires every fact bound to the old run
   * (catalog, result, windows, reads, drawn frame, unsubmitted prepare or
   * confirmation) and says so; nothing is relisted, retried, reconnected, or
   * retargeted. The OWNER's live delete exposure only controls current hints
   * and send preflight; a transient policy change retires no semantic target.
   */
  private reconcileSavedPickerHost(): void {
    if (this.savedPickerId === undefined) return;
    if (this.formKind !== "saved" && this.confirmPurpose !== "saved-delete") return;
    if (this.savedHostFocused && !this.savedHostLineShown()) this.savedHostFocused = false;
    const state = this.remoteSaved;
    if (state === undefined || this.savedHost.kind !== "remote") return;
    const option = this.currentSavedHostOption();
    const usable = this.remoteSavedHostUsable(option);
    const boundRun = state.catalog?.hostRunId ?? state.resultRead?.hostRunId;
    if (boundRun !== undefined && (!usable || option?.hostRunId !== boundRun)) {
      // A run returning to an earlier value later can never revive anything.
      this.retireSavedViewAuthority();
      state.catalog = undefined;
      state.result = undefined;
      state.windows = [];
      state.resultRead = undefined;
      state.windowReads = [];
      this.displayedSavedRows = undefined;
      this.pendingRemoteSavedDeleteCheck = undefined;
      if (this.remoteSavedDeleteTarget !== undefined && this.remoteSavedDeleteOperation === undefined) {
        this.cancelSavedDeleteConfirmation();
      }
      this.remoteSavedNotice = REMOTE_SAVED_HOST_CHANGED_NOTICE;
      return;
    }
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
    // Every New form opens on the LOCAL host. A previous REMOTE choice is an
    // actual Host change, so it clears the workspace field exactly like an
    // in-form change; an ordinary local draft is retained as before.
    const wasRemote = this.newFormHost.kind === "remote";
    this.newFormHost = { kind: "local" };
    this.formHostFocused = false;
    if (wasRemote) this.workspaceDraft = "";
    this._focus = "form";
    this.createFormField(this.workspaceDraft);
  }

  // --- New form Host line: Local by default, one host-owned selection. ---

  /**
   * The Host choices this form can name: Local first, then every destination the
   * attached DTO reports as connected. A destination the operator already chose
   * is kept even after it disconnects or disappears from a complete observation,
   * so a later submit refuses truthfully instead of silently falling back to
   * Local, connecting, or retargeting another destination.
   */
  private newFormHostOptions(): NewFormHostOption[] {
    const options: NewFormHostOption[] = [{
      kind: "local", hostId: "", label: NEW_FORM_LOCAL_HOST_LABEL, hostRunId: null, connected: true,
    }];
    const chosen = this.newFormHost;
    const chosenHostId = chosen.kind === "remote" ? chosen.hostId : undefined;
    const chosenLabel = chosen.kind === "remote" ? chosen.label : "";
    let chosenListed = false;
    for (const host of this.peerUiSnapshot?.hosts ?? []) {
      const chosenHere = chosenHostId !== undefined && host.id === chosenHostId;
      if (!chosenHere && host.state !== "connected") continue;
      if (chosenHere) chosenListed = true;
      options.push({
        kind: "remote",
        hostId: host.id,
        label: sanitizeBounded(host.label, PEER_LABEL_MAX_CODEPOINTS),
        hostRunId: typeof host.roster.hostRunId === "string" && host.roster.hostRunId.length > 0
          ? host.roster.hostRunId
          : null,
        connected: host.state === "connected",
      });
    }
    if (chosenHostId !== undefined && !chosenListed) {
      // The chosen destination is no longer reported at all. Its saved handle and
      // the label the operator selected stay on screen; nothing is substituted.
      options.push({
        kind: "remote",
        hostId: chosenHostId,
        label: chosenLabel,
        hostRunId: null,
        connected: false,
      });
    }
    return options;
  }

  /** Stable identity of the Host line's current choice. */
  private newFormHostKey(): string {
    return newFormHostOptionKey(this.newFormHost.kind === "local"
      ? { kind: "local", hostId: "" }
      : { kind: "remote", hostId: this.newFormHost.hostId });
  }

  /** The drawn identity of the whole option list plus its current choice. */
  private newFormHostOptionsKey(): string {
    return JSON.stringify([
      this.newFormHostOptions().map((option) => [
        newFormHostOptionKey(option), option.label, option.hostRunId, option.connected,
      ]),
      this.newFormHostKey(),
    ]);
  }

  /** The current choice as the fresh option list describes it, if it is listed. */
  private currentNewFormHostOption(): NewFormHostOption | undefined {
    const key = this.newFormHostKey();
    return this.newFormHostOptions().find((option) => newFormHostOptionKey(option) === key);
  }

  /** The bounded display label of the current choice, exactly as it will be drawn. */
  private currentNewFormHostLabel(): string {
    const option = this.currentNewFormHostOption();
    if (option !== undefined) return option.label;
    return this.newFormHost.kind === "remote" ? this.newFormHost.label : NEW_FORM_LOCAL_HOST_LABEL;
  }

  /** True while the form's target is a remote destination (plain owner entry). */
  private newFormHostIsRemote(): boolean {
    return this.newFormHost.kind === "remote";
  }

  /**
   * One ACTUAL Host choice change. Reselecting the very same destination is a
   * no-op that preserves the draft, its caret, and its completer state; a
   * different destination atomically clears the workspace value, the stored
   * draft, the caret, and any completer state by reopening the field for the
   * new field kind.
   */
  private selectNewFormHost(option: NewFormHostOption): void {
    if (this.formKind !== "new" || this.pendingCreate !== undefined) return;
    if (newFormHostOptionKey(option) === this.newFormHostKey()) return;
    this.newFormHost = option.kind === "local"
      ? { kind: "local" }
      : { kind: "remote", hostId: option.hostId, label: option.label };
    this.workspaceDraft = "";
    this.formError = undefined;
    this.createFormField("");
  }

  /** Cycle the one Host selection; never a submit, connect, or retarget. */
  private cycleNewFormHost(direction: 1 | -1): void {
    if (this.formKind !== "new" || this.pendingCreate !== undefined) return;
    const options = this.newFormHostOptions();
    if (options.length < 2) return;
    const key = this.newFormHostKey();
    const index = options.findIndex((option) => newFormHostOptionKey(option) === key);
    const next = index < 0
      ? options[0]
      : options[((index + direction) % options.length + options.length) % options.length];
    if (next !== undefined) this.selectNewFormHost(next);
  }

  /**
   * One fresh key while the Host line owns the form's focus. Only that control's
   * own dropdown/cycle gestures and Tab act; every other press is consumed so it
   * can never edit the workspace underneath the control the operator is using,
   * and the ordinary path editor's keys are untouched while IT has the focus.
   */
  private handleNewFormHostKey(data: string): boolean {
    if (this.formKind !== "new") return false;
    if (!this.formHostFocused) {
      if (!matchesShiftTab(data)) return false;
      if (!isKeyRelease(data) && !isKeyRepeat(data)) {
        this.formHostFocused = true;
        this.onInvalidate?.();
      }
      return true;
    }
    if (matchesKey(data, "tab") || matchesShiftTab(data)) {
      if (!isKeyRelease(data) && !isKeyRepeat(data)) {
        this.formHostFocused = false;
        this.onInvalidate?.();
      }
      return true;
    }
    if (isKeyRelease(data) || isKeyRepeat(data)) return true;
    if (matchesKey(data, "escape")) {
      // Leaving the control is this form's own back gesture: no cancel, no
      // submit, no data loss, and the still-held Escape keeps its fence.
      this.formHostFocused = false;
      this.onInvalidate?.();
      return true;
    }
    if (matchesKey(data, "up") || matchesKey(data, "left")) this.cycleNewFormHost(-1);
    else if (matchesKey(data, "down") || matchesKey(data, "right")) this.cycleNewFormHost(1);
    return true;
  }

  /**
   * The New-form frame this renderer last drew completely, with the exact host
   * identity, owner run, and drawn workspace it held. Main captures this beside
   * the composed frame and keeps it only while the writer reports THAT frame
   * written, so a queued, held, clipped, or too-small frame authorizes nothing.
   */
  captureCreateFormPresentation(): SidebarCreateFormPresentation | undefined {
    const candidate = this.createFormCandidate;
    if (candidate === undefined) return undefined;
    return Object.freeze({
      formGeneration: candidate.formGeneration,
      renderToken: candidate.token,
      hostKind: candidate.hostKind,
      hostId: candidate.hostId,
      hostRunId: candidate.hostRunId,
      workspace: candidate.workspace,
      cols: candidate.cols,
      rows: candidate.rows,
    });
  }

  /** True while this token is still the renderer's current complete New form. */
  isCreateFormRenderCurrent(renderToken: number): boolean {
    return this.createFormCandidate?.token === renderToken;
  }

  /** Main's actual-writer receipt for the exact New-form candidate it submitted. */
  settleCreateFormRender(renderToken: number): boolean {
    const candidate = this.createFormCandidate;
    if (candidate === undefined || candidate.token !== renderToken) return false;
    candidate.written = true;
    return true;
  }

  /** Forget the drawn New form (a covering pane, a resize, or a dismissal). */
  invalidateCreateFormPresentation(): void {
    this.createFormCandidate = undefined;
    this.formHostDisplay = undefined;
  }

  /**
   * Capture one completely drawn New form. The candidate is kept across
   * identical redraws so an ordinary repaint never revokes the receipt it
   * already earned; any change of generation, host identity, owner run, drawn
   * workspace, or pane geometry mints a new token that starts unwritten.
   */
  private captureCreateFormCandidate(workspace: string, cols: number, rows: number): void {
    const hostKind = this.newFormHost.kind;
    const hostId = this.newFormHost.kind === "remote" ? this.newFormHost.hostId : "";
    const option = this.currentNewFormHostOption();
    const hostRunId = option !== undefined && option.kind === "remote" ? option.hostRunId : null;
    const identity = JSON.stringify([
      this.formGeneration, hostKind, hostId, hostRunId, workspace, cols, rows,
    ]);
    const previous = this.createFormCandidate;
    if (previous !== undefined && previous.identity === identity) return;
    this.createFormCandidate = {
      token: this.createFormTokenSequence++,
      identity,
      formGeneration: this.formGeneration,
      hostKind,
      hostId,
      hostRunId,
      workspace,
      cols,
      rows,
      written: false,
    };
  }

  /**
   * The caller's last-instant proof for one frozen remote New submission: this
   * EXACT request still owns this form, and the host choice, its exact owner run,
   * the canonical workspace, and the form generation are still the submitted
   * ones. Nothing is re-derived from a later roster index, label, or selection.
   */
  createOnPeerStillCurrent(submission: {
    readonly requestId: number;
    readonly formGeneration: number;
    readonly hostId: string;
    readonly hostRunId: string;
    readonly workspace: string;
  }): boolean {
    if (!this._visible || this._focus !== "form") return false;
    if (this.formKind !== "new") return false;
    const pending = this.pendingCreate;
    if (pending === undefined || pending.requestId !== submission.requestId) return false;
    if (pending.peer === undefined) return false;
    if (this.formGeneration !== submission.formGeneration) return false;
    if (this.newFormHost.kind !== "remote" || this.newFormHost.hostId !== submission.hostId) return false;
    const option = this.currentNewFormHostOption();
    if (option === undefined || option.kind !== "remote" || !option.connected) return false;
    if (option.hostRunId !== submission.hostRunId) return false;
    if (this.workspaceDraft !== submission.workspace) return false;
    const field = this.formField;
    return field !== undefined && field.getValue() === submission.workspace;
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
    //
    // A New form whose Host line names a REMOTE destination is plain OWNER text:
    // the workspace belongs to that owner's filesystem (a POSIX or Windows path,
    // relative or absolute, with spaces or Unicode), so it keeps the workspace
    // text bound and installs NO local completer at all — this machine neither
    // reads nor lists anything on its behalf. Only the LOCAL New form keeps the
    // ordinary path editor and its startup-cwd completion base.
    const kind: SidebarFieldFactoryOptions["kind"] = this.formKind === "edit"
      || this.formKind === "shortcuts" || this.formKind === "peer-field"
      ? "name"
      : this.formKind === "new" && this.newFormHostIsRemote()
        ? "plain"
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
          field: kind === "plain"
            ? createPlainOwnerWorkspaceField({
              initialText, workspaceBasePath: this.workspaceBasePath,
              onInvalidate: fieldOptions.onInvalidate, onSubmit: fieldOptions.onSubmit,
              onCancel: fieldOptions.onCancel, onReject: fieldOptions.onReject,
            })
            : kind === "path"
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
    if (this.newFormHostIsRemote()) {
      this.submitCreateOnPeer(submission);
      return;
    }
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

  /**
   * One deliberate REMOTE New submission. The workspace text is the operator's
   * canonical value for the OWNER's filesystem: it is forwarded verbatim (only
   * the form's own single-line/limit safety rule applies), never resolved,
   * completed, guessed, or validated locally. Nothing is emitted unless the
   * form that is actually on screen is the one this renderer drew completely and
   * the writer reported written, and unless the chosen destination is still
   * connected with the EXACT owner run that was drawn.
   */
  private submitCreateOnPeer(submission: SessionHostFieldSubmission): void {
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
    const target = this.currentNewFormHostOption();
    const chosen = this.newFormHost;
    if (chosen.kind !== "remote" || target === undefined || target.kind !== "remote"
      || !target.connected) {
      // A destination that disconnected, retired, or vanished is refused here
      // instead of silently becoming Local, connecting, or another host.
      this.formError = CREATE_ON_PEER_TARGET_CHANGED_NOTICE;
      this.createFormField(workspace);
      return;
    }
    if (target.hostRunId === null || target.hostRunId.length === 0) {
      // No exact owner run is observed, so nothing can be addressed. This is
      // never guessed from a label, endpoint, native tuple, or an older run.
      this.formError = CREATE_ON_PEER_NO_RUN_NOTICE;
      this.createFormField(workspace);
      return;
    }
    const drawn = this.createFormCandidate;
    if (drawn === undefined || !drawn.written
      || drawn.formGeneration !== this.formGeneration
      || drawn.hostKind !== "remote"
      || drawn.hostId !== target.hostId
      || drawn.hostRunId !== target.hostRunId
      || drawn.workspace !== workspace) {
      // The exact displayed form is the only thing that may submit: a too-small,
      // covered, queued, held, or since-changed frame sends nothing.
      this.formError = CREATE_ON_PEER_UNWRITTEN_NOTICE;
      this.createFormField(workspace);
      return;
    }
    const requestId = this.nextRequestId++;
    this.pendingCreate = {
      requestId,
      peer: {
        formGeneration: drawn.formGeneration,
        renderToken: drawn.token,
        hostId: target.hostId,
        hostRunId: target.hostRunId,
        workspace,
      },
    };
    this.formError = undefined;
    const submitKey = this.formInputSubmitKey;
    this.formSubmitClaim = submitKey === undefined
      ? undefined
      : (data: string) => matchesKey(data, submitKey);
    this.emit({
      type: "create-on-peer",
      requestId,
      formGeneration: drawn.formGeneration,
      renderToken: drawn.token,
      hostId: target.hostId,
      hostRunId: target.hostRunId,
      workspace,
    });
  }

  /**
   * Resolves one remote New submission that the OWNER reported started. Nothing
   * local is created or accepted: no row is added to this roster and no local
   * manager is touched. The returned owner run must be the exact run that was
   * submitted, and the display selection is emitted only while this exact
   * request still owns the form — a late reply never steals a newer form, a
   * newer selection, or the panes the operator moved on to.
   */
  completeCreateOnPeer(requestId: number, facts: { readonly hostRunId: string; readonly rowId: string }): void {
    const pending = this.pendingCreate;
    if (pending === undefined || pending.requestId !== requestId || pending.peer === undefined) return;
    const target = pending.peer;
    if (facts.hostRunId !== target.hostRunId) {
      this.failCreateOnPeer(requestId, CREATE_ON_PEER_OTHER_RUN_NOTICE);
      return;
    }
    this.pendingCreate = undefined;
    if (this.formKind === "new" && this.formField) this.workspaceDraft = this.formField.getValue();
    this.disposeFormField();
    this.formKind = undefined;
    this.formError = undefined;
    this.formHostFocused = false;
    this.invalidateCreateFormPresentation();
    if (this._focus !== "form") return; // the request no longer owns the pane
    this._focus = "main";
    this.emit({
      type: "select-remote",
      hostId: target.hostId,
      hostRunId: facts.hostRunId,
      rowId: facts.rowId,
    });
  }

  /** Fails one remote New submission only while that exact request still owns it. */
  failCreateOnPeer(requestId: number, message: string): void {
    this.failCreate(requestId, message);
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
    this.formHostFocused = false;
    this.invalidateCreateFormPresentation();
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
      || this.confirmPurpose === "peer-revoke"
      || this.confirmPurpose === "remote-close"
      // A REMOTE Saved delete confirmation is equally opaque to pasted bodies:
      // a pasted Enter/y/Escape can never confirm or cancel it. The local
      // Saved-delete dialog keeps its existing input semantics unchanged.
      || (this.confirmPurpose === "saved-delete" && this.remoteSavedDeleteTarget !== undefined))
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
    if (this.confirmPurpose === "remote-close") {
      this.handleRemoteCloseConfirmInput(data);
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
    // Closed discriminator: a remote owner target has its own confirm route and
    // never reaches the local `saved-delete` emission below (or the reverse).
    if (this.remoteSavedDeleteTarget !== undefined) {
      this.handleRemoteSavedDeleteConfirmInput(data);
      return;
    }
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
    // Cancelling releases this dialog's UI ownership only; an already emitted
    // remote delete is never cancelled on the owner.
    this.remoteSavedDeleteTarget = undefined;
    this.remoteSavedDeleteOperation = undefined;
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

  /**
   * Remote Close confirmation: deliberate initial presses only. Cancel sends no
   * owner request and keeps the highlighted row and roster focus; confirm is
   * accepted only while the complete dialog frame is on screen and written.
   */
  private handleRemoteCloseConfirmInput(data: string): void {
    if (this.consumeSavedActionClaim(data)) return;
    if (isKeyRepeat(data) || isKeyRelease(data)) return;
    if (matchesKey(data, "escape")) {
      this.formEscapeClaimed = true;
      this.cancelRemoteCloseConfirmation();
      return;
    }
    const printable = printableOf(data);
    if (printable === "n" || printable === "N") {
      this.cancelRemoteCloseConfirmation();
      return;
    }
    if (!matchesKey(data, "enter") && printable !== "y" && printable !== "Y") return;
    if (!this.remoteCloseRendered) return;
    this.applyRemoteCloseConfirmation(data);
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

  /**
   * The semantic intent one actionable network row acts on, read at the moment
   * the row is built. Toggles flip the opposite of the drawn state and Apply rows
   * send the current local drafts, so availability, the drawn toggle states, and
   * the exact draft values are all part of what a press was allowed to do.
   */
  private peerPaneRowIntent(kind: PeerActionRowKind): PeerPaneRowIntent {
    const settings = this.peerUiSnapshot?.settings ?? null;
    const known = settings !== null;
    const bindHost = this.peerBindHostDraft;
    const bindPort = this.peerBindPortDraft;
    const add = this.peerAddDraft;
    switch (kind) {
      // Both hosting rows send the drawn listen endpoint together with the
      // opposite-or-remembered hosting state the row displayed.
      case "toggle-hosting":
      case "apply-hosting":
        return [kind, known, settings?.hostingEnabled ?? null, bindHost, bindPort];
      case "edit-bind-host":
        return [kind, known, bindHost];
      case "edit-bind-port":
        return [kind, known, bindPort];
      case "toggle-auto":
        return [kind, known, settings?.autoReconnect ?? null];
      case "toggle-bell":
        return [kind, known, settings?.bellEnabled ?? null];
      case "toggle-viewer-input":
        return [kind, known, settings?.viewerNativeInputEnabled ?? null];
      case "toggle-history-delete":
        return [kind, known, settings?.remoteHistoryDeleteEnabled ?? null];
      // Opening the menu shows the whole draft, so the whole draft is its intent.
      case "add-host":
      case "apply-add":
        return [kind, add.label, add.host, add.port];
      case "edit-add-label":
        return [kind, add.label];
      case "edit-add-host":
        return [kind, add.host];
      case "edit-add-port":
        return [kind, add.port];
    }
  }

  /** Selectable network-panel rows, built fresh from the attached snapshot. */
  private buildPeerPaneRows(): readonly PeerPaneRow[] {
    // The Add-destination menu is its own field menu: the draft's three fields
    // and one explicit Add action, reachable in any order like the Listen rows.
    if (this.peerAddMenuOpen) {
      return (["edit-add-label", "edit-add-host", "edit-add-port", "apply-add"] as const)
        .map((kind) => ({ key: kind, kind, intent: this.peerPaneRowIntent(kind) }));
    }
    const rows: PeerPaneRow[] = ([
      "toggle-hosting",
      "edit-bind-host",
      "edit-bind-port",
      "apply-hosting",
      "toggle-auto",
      "toggle-bell",
      "toggle-viewer-input",
      "toggle-history-delete",
      "add-host",
    ] as const).map((kind) => ({ key: kind, kind, intent: this.peerPaneRowIntent(kind) }));
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
      // A bound IPv6 address is bracketed so the endpoint reads `[::]:8088`
      // rather than the ambiguous `:::8088`. Display-only formatting.
      const host = listener.host === null ? "" : ` on ${peerBracketHost(listener.host)}`;
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
      case "toggle-viewer-input":
        return `Remote input/copy: ${settings === null ? "unknown" : settings.viewerNativeInputEnabled ? "on" : "off"} (enter to toggle)`;
      case "toggle-history-delete":
        return `Allow remote history deletion: ${settings === null ? "unknown" : settings.remoteHistoryDeleteEnabled ? "on" : "off"} (enter to toggle)`;
      case "add-host":
        return "Add destination";
      case "edit-add-label":
        return `Name: ${this.peerAddDraft.label.length > 0 ? sanitizeBounded(this.peerAddDraft.label, PEER_LABEL_MAX_CODEPOINTS) : "(not set)"} (enter to edit)`;
      case "edit-add-host":
        return `Host: ${this.peerAddDraft.host.length > 0 ? sanitizeBounded(this.peerAddDraft.host, PEER_ADDRESS_MAX_CODEPOINTS) : "(not set)"} (enter to edit)`;
      case "edit-add-port":
        return `Port: ${this.peerAddDraft.port.length > 0 ? sanitizeBounded(this.peerAddDraft.port, 16) : "(not set)"} (enter to edit)`;
      case "apply-add":
        return "Add destination (enter to add)";
      case "host": {
        const host = row.host;
        const endpoint = `${peerBracketHost(host.host)}:${host.port}`;
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
    const addMenu = this.peerAddMenuOpen;
    const header = addMenu ? " Add destination " : " Network ";
    const statusLines = wrapHintLines(this.peerStatusSegments(snapshot), cols);
    const identityLines = wrapBoundedField(this.peerIdentityText(snapshot), cols, 2);
    const notices = [snapshot.notice, this.peerPaneError, this.peerPaneNotice]
      .filter((message): message is string => typeof message === "string" && message.trim().length > 0)
      .map((message) => `! ${sanitizeBounded(message, ERROR_TEXT_MAX_CODEPOINTS)}`);
    const noticeLines = notices.length === 0 ? [] : wrapHintLines(notices, cols) ?? [];
    const footerLines = wrapHintLines(addMenu
      ? [
        `${this.toggleLabel} toggle`,
        "up/down select",
        "enter edit",
        "esc back",
      ]
      : [
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
    const drawn: DisplayedPeerRow[] = [];
    for (let index = top; index < paneRows.length && drawn.length < listRows; index += 1) {
      const row = paneRows[index];
      const selected = index === selectedIndex;
      // Record the written row position so a pointer target is the geometry the
      // operator actually saw, never an index a later snapshot could reuse.
      drawn.push({ paneRow: lines.length, row });
      lines.push(wrapRow(
        `${selected ? "> " : "  "}${this.peerPaneRowText(row)}`,
        cols,
        selected ? SGR_SELECTION_BLUE : undefined,
      ));
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
      if (this.peerAddMenuOpen) {
        // Escape leaves the Add-destination menu for the network pane. The
        // local draft is kept, nothing is sent, and the held key is claimed so
        // its repeat/release cannot hide the roster.
        this.closePeerAddMenu();
        return;
      }
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
    // The Add-destination menu shows no destination or permission row, so the
    // host-action keys are not offered there and do nothing; Enter, Up/Down,
    // and Escape are its whole navigation surface.
    if (this.peerAddMenuOpen) return;
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
    // The keyboard acts on the drawn highlight only: a newer highlight the
    // current frame never drew is not a target.
    if (display === undefined || display.selectedKey !== this.peerSelectedKey) return undefined;
    return this.drawnPeerPaneRow(display.selectedKey ?? "");
  }

  /** The row the current complete network render actually drew for `key`. */
  private drawnPeerPaneRow(key: string): PeerPaneRow | undefined {
    const display = this.peerDisplay;
    if (display === undefined || this.formKind !== "peer" || this._focus !== "form" || !this._visible) {
      return undefined;
    }
    if (display.signature !== this.peerPaneRowKeys()) return undefined;
    const drawn = display.entries.find((entry) => entry.row.key === key)?.row;
    if (drawn === undefined) return undefined;
    // The row the current state would draw must still carry the same immutable
    // identity and the same semantic intent the operator was shown: a toggle
    // never flips the opposite of the drawn state, and an Apply never sends a
    // draft or endpoint the drawn frame never displayed. Stale intents refuse
    // rather than reinterpret the row.
    const current = this.buildPeerPaneRows().find((row) => row.key === key);
    if (current === undefined || !samePeerPaneRow(current, drawn)) return undefined;
    return drawn;
  }

  private activatePeerPaneRow(): void {
    const row = this.selectedPeerPaneRow();
    if (row === undefined) {
      this.peerPaneError = "The network pane changed; review it before acting";
      this.onInvalidate?.();
      return;
    }
    this.performPeerPaneAction(row);
  }

  /**
   * The network pane's single row-activation routine. The Enter key (on the
   * drawn highlight) and a pointer press (on a drawn row) both arrive here with
   * an already-authorized row, so neither path duplicates a menu action.
   * Consent rows only OPEN their review, host/trusted/remote rows stay
   * informational, and removal and revoke stay on their own explicitly
   * confirmed keyboard paths.
   */
  private performPeerPaneAction(row: PeerPaneRow): void {
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
      case "toggle-viewer-input":
        // Viewer side only: this sidebar's own remote pane. The drawn known state
        // is required, so an unknown or unavailable settings fact sends nothing.
        if (settings === null) {
          this.peerPaneError = "Network settings are unavailable; no remote input/copy change was sent";
          this.onInvalidate?.();
          return;
        }
        this.emit({ type: "peer-viewer-native-input", enabled: !settings.viewerNativeInputEnabled });
        this.peerPaneNotice = "Remote input/copy change requested for this viewer only; the coordinator reports the saved setting";
        this.peerPaneError = undefined;
        this.onInvalidate?.();
        return;
      case "toggle-history-delete":
        // Owner side only: what this host exposes to its paired viewers. It never
        // changes local Saved deletion here.
        if (settings === null) {
          this.peerPaneError = "Network settings are unavailable; no history deletion change was sent";
          this.onInvalidate?.();
          return;
        }
        this.emit({ type: "peer-remote-history-delete", enabled: !settings.remoteHistoryDeleteEnabled });
        this.peerPaneNotice = "Remote history deletion policy change requested for this host; the coordinator reports the saved setting";
        this.peerPaneError = undefined;
        this.onInvalidate?.();
        return;
      case "add-host":
        this.openPeerAddMenu();
        return;
      case "edit-add-label":
        this.openPeerFieldForm("add-label");
        return;
      case "edit-add-host":
        this.openPeerFieldForm("add-host");
        return;
      case "edit-add-port":
        this.openPeerFieldForm("add-port");
        return;
      case "apply-add":
        this.requestPeerAdd();
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
    // Fail closed on availability, not just on text shape: an unknown,
    // unavailable, or unsafe settings document is never authority for a
    // listener request, even when a valid local draft (including the prefilled
    // suggestion) is retained for display.
    const settings = this.peerUiSnapshot === undefined ? null : this.peerUiSnapshot.settings;
    if (settings === null || settings === undefined) {
      this.peerPaneError = "Network settings are unavailable; no hosting change was sent";
      this.onInvalidate?.();
      return;
    }
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
    this.peerAddMenuOpen = false;
    this.peerDisplay = undefined;
    this.peerPaneError = undefined;
    this.peerPaneNotice = undefined;
    this.peerConfirmDisplayed = false;
    this.peerRemoveTarget = undefined;
    this.peerRevokeTarget = undefined;
  }

  /**
   * Opens the local Add-destination field menu. Opening it sends nothing: the
   * draft is edited one field at a time and only the menu's Add action emits a
   * command. The network rows stay reachable by leaving the menu.
   */
  private openPeerAddMenu(): void {
    this.peerAddMenuOpen = true;
    this.peerPaneError = undefined;
    this.peerSelectedKey = "edit-add-label";
    this.onInvalidate?.();
  }

  /**
   * Returns from the Add-destination menu (or one of its field editors) to the
   * network pane. A draft left half-edited stays local and unsent, so the
   * operator can revisit any field later; nothing is emitted here.
   */
  private closePeerAddMenu(): void {
    this.peerAddMenuOpen = false;
    this.peerPaneError = undefined;
    this.peerSelectedKey = "add-host";
    this.onInvalidate?.();
  }

  /**
   * The one Add action: validate the whole local draft with the existing field
   * rules, then emit exactly one unchanged peer-add. An invalid or incomplete
   * draft is refused locally with its fixed message and sends nothing, so a
   * partially edited draft can never be sent.
   */
  private requestPeerAdd(): void {
    const draft = {
      label: this.peerAddDraft.label,
      host: this.peerAddDraft.host,
      port: this.peerAddDraft.port,
    };
    const error = peerLabelFieldError(draft.label)
      ?? peerHostFieldError(draft.host, "Destination host")
      ?? peerPortFieldError(draft.port, "Port");
    if (error !== undefined) {
      this.peerPaneError = error;
      this.onInvalidate?.();
      return;
    }
    this.peerAddDraft = { label: "", host: "", port: "" };
    this.peerPaneError = undefined;
    this.peerPaneNotice = "Destination add requested; the coordinator validates and saves it";
    this.closePeerAddMenu();
    this.emit({ type: "peer-add", label: draft.label, host: draft.host, port: draft.port });
  }

  /** Opens one bounded text editor for an explicit listen value or one Add-destination field. */
  private openPeerFieldForm(purpose: PeerFieldPurpose): void {
    this.disposeFormField();
    this.pendingCreate = undefined;
    this.pendingRename = undefined;
    this.pendingShortcutSave = undefined;
    this.formKind = "peer-field";
    this.peerFieldTarget = { purpose };
    this.formError = undefined;
    this._focus = "form";
    this.createFormField(this.peerFieldValue(purpose));
  }

  private peerFieldValue(purpose: PeerFieldPurpose): string {
    switch (purpose) {
      case "bind-host":
        return this.peerBindHostDraft;
      case "bind-port":
        return this.peerBindPortDraft;
      case "add-label":
        return this.peerAddDraft.label;
      case "add-host":
        return this.peerAddDraft.host;
      case "add-port":
        return this.peerAddDraft.port;
    }
  }

  private closePeerFieldForm(): void {
    this.abandonForm();
    this.formKind = this.peerUiSnapshot === undefined ? undefined : "peer";
    this._focus = this.formKind === "peer" ? "form" : "sidebar";
    this.onInvalidate?.();
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
    const addField = peerAddFieldOf(purpose);
    if (addField === undefined) return;
    const error = addField === "label"
      ? peerLabelFieldError(value)
      : addField === "host"
        ? peerHostFieldError(value, "Destination host")
        : peerPortFieldError(value, "Port");
    if (error !== undefined) {
      // The field keeps its own text and the fixed local data-shape message; an
      // unusable value is never stored in the draft and nothing is sent.
      this.formError = error;
      this.createFormField(value);
      return;
    }
    this.peerAddDraft[addField] = value;
    this.peerPaneNotice = `${peerAddFieldLabel(addField)} updated locally; choose Add destination to request it`;
    this.peerPaneError = undefined;
    // A saved field returns to the Add-destination menu with no command: the
    // destination is sent only by that menu's single Add action.
    this.closePeerFieldForm();
  }

  private renderPeerFieldPane(
    cols: number,
    rows: number,
  ): { lines: string[]; cursor?: { column: number; row: number } } {
    const target = this.peerFieldTarget;
    const field = this.formField;
    const purpose = target?.purpose;
    if (target === undefined || field === undefined || purpose === undefined) return this.renderTooSmall(cols, rows);
    const addField = peerAddFieldOf(purpose);
    const header = addField === undefined ? " Network settings " : " Add destination ";
    const activeLabel = purpose === "bind-host"
      ? "Listen address"
      : purpose === "bind-port"
        ? "Listen port"
        : peerAddFieldLabel(addField ?? "label");
    const contextLines = wrapHintLines([
      addField !== undefined
        ? "The destination is display data; the coordinator validates and saves it."
        : "Address and port are separate fields. \"*\" asks for one dual-stack listener (IPv4 and IPv6); \"0.0.0.0\" is IPv4 only. New hosts start with Hosting off. Edits stay local until Apply or Enable; no other address or port is substituted.",
    ], cols);
    const errorLines = this.formError === undefined ? [] : wrapHintLines([`! ${this.formError}`], cols);
    // One editor holds and shows only the chosen field: Enter saves that field
    // to the local draft and goes back; there is no field cycling, no implicit
    // submit of anything, and no read-only sibling rows beside the input.
    const hints = [`${this.formHints.submit} save`, `${this.formHints.cancel} cancel`];
    const footerLines = wrapHintLines(hints, cols);
    if (contextLines === undefined || errorLines === undefined || footerLines === undefined
      || visibleWidth(header) > cols) return this.renderTooSmall(cols, rows);
    const fixedRows = 1 + contextLines.length + 1 + errorLines.length + footerLines.length;
    const activeRows = rows - fixedRows;
    if (activeRows < 1) return this.renderTooSmall(cols, rows);
    const prefix = `> ${activeLabel}: `;
    const prefixWidth = Math.min(visibleWidth(prefix), cols - 1);
    const fieldWidth = Math.max(1, cols - prefixWidth);
    const fieldFrame = field.render(fieldWidth, activeRows);
    if (!fieldFrame.cursor.visible || fieldFrame.lines.length === 0) return this.renderTooSmall(cols, rows);
    const labeledRows = labeledFieldRows(
      fieldFrame,
      Math.min(activeRows, fieldFrame.lines.length),
      prefix,
      prefixWidth,
      cols,
    );
    if (labeledRows === undefined) return this.renderTooSmall(cols, rows);

    const lines = [wrapRow(header, cols, "\x1b[1m")];
    for (const line of contextLines) lines.push(wrapRow(line, cols));
    const fieldTopRow = lines.length;
    lines.push(...labeledRows);
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
    // A hidden pane cannot hold an open stop confirmation or remote close.
    this.confirmPurpose = "quit";
    this.stopRemoveTargetId = undefined;
    this.stopConfirmDisplayed = false;
    this.remoteCloseTarget = undefined;
    this.remoteCloseNotice = undefined;
    this.invalidateRemoteCloseConfirmationDisplay();
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
    // A hidden pane also holds no Add-destination menu: reopening Network shows
    // the network rows, and an unseen menu can never authorize an Add.
    this.peerAddMenuOpen = false;
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
      // Remote cards are a display projection of the SAME attached peer
      // snapshot the Network pane renders. Local rows keep their existing order
      // and the projection preserves the DTO's host order and each host's own
      // row order: no sorting, deduplication, cache, or new authority.
      ...this.projectRemoteEntries(),
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
    this.pruneVanishedRemoteSelection();
    this.pruneRemoteExpansionMemory();
  }

  /**
   * One typed card per observed remote roster row. `rows: null` means "no
   * complete observation" and contributes no cards at all; a `stale` host
   * projection is marked stale rather than refreshed, reconnected, or guessed.
   * This derives every rebuild from the existing snapshot and keeps no second
   * authoritative row store.
   */
  private projectRemoteEntries(): SidebarEntry[] {
    const snapshot = this.peerUiSnapshot;
    if (snapshot === undefined) return [];
    const entries: SidebarEntry[] = [];
    for (const host of snapshot.hosts ?? []) {
      const rows = host.roster.rows;
      if (rows === null) continue;
      const rosterState: "current" | "stale" = host.roster.state === "stale" ? "stale" : "current";
      const hostRunId = peerHostRosterRunId(host);
      for (const row of rows) {
        entries.push({
          key: remoteRosterEntryKey(host.id, row.id),
          kind: "remote",
          remote: {
            hostId: host.id,
            hostLabel: host.label,
            hostRunId,
            rosterState,
            row,
          },
        });
      }
    }
    return entries;
  }

  /**
   * A remote card that a metadata update removed or replaced loses only the
   * left highlight. Focus, visibility, an open pane/draft, Main's actual
   * content owner, and every local row are untouched, and nothing is
   * retargeted to whatever now happens to sit near the old position.
   */
  private pruneVanishedRemoteSelection(): void {
    const key = this.selectedEntryKey;
    if (key === undefined || !key.startsWith(REMOTE_ENTRY_KEY_PREFIX)) return;
    if (this.entries.some((entry) => entry.key === key)) return;
    this.selectedEntryKey = undefined;
  }

  /** Keeps per-card expansion memory bounded to the currently projected cards. */
  private pruneRemoteExpansionMemory(): void {
    if (this.collapsedRemoteEntryKeys.size === 0) return;
    const live = new Set(
      this.entries.filter((entry) => entry.kind === "remote").map((entry) => entry.key),
    );
    for (const key of [...this.collapsedRemoteEntryKeys]) {
      if (!live.has(key)) this.collapsedRemoteEntryKeys.delete(key);
    }
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
        ...(this._focus === "sidebar" && this.hasExpandableCards() ? ["space expand"] : []),
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
    // At least one entry row is required, and the highlighted entry (a local
    // card is 3 or 5 rows, a remote card 4 or 6) must fit completely: a picker whose selected target is
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
      selectedKey: this.selectedEntryKey,
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
      selectedKey: undefined,
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
   * line, and — when expanded — two generic sanitized activity rows. A remote
   * card inserts exactly one indented owner-host line directly under the title.
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
      if (this._focus === "main" && this.activeMainOwnerID === item.id) {
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
    if (entry.kind === "remote") {
      // A projected remote card always carries its structured facts; if one
      // somehow does not, draw an honest placeholder instead of falling
      // through to a host action row that could be mistaken for Quit host.
      if (entry.remote === undefined) {
        return [wrapRow(`${marker}Remote session unavailable`, cols)];
      }
      return this.renderRemoteEntryLines(entry, entry.remote, selected, cols);
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

  /**
   * One projected remote card at the local card shape plus exactly one line:
   * an ordinary indented owner-host line directly under the canonical title.
   * It reuses the existing bounded title/status/background/activity helpers
   * through the remote display-facts adapter, keeps the honest current-vs-stale
   * mark on the host line ahead of the variable-length friendly label, and
   * never draws the owner workspace path, invents a local status, agent dir,
   * or current file.
   */
  private renderRemoteEntryLines(
    entry: SidebarEntry,
    remote: SidebarRemoteEntry,
    selected: boolean,
    cols: number,
  ): string[] {
    const marker = selected ? "> " : "  ";
    const facts = remoteSessionStatusFacts(remote.row);
    // Same one focus-domain title highlight as local cards; the white mark is
    // Main's actual content owner, which is always a structured identity and
    // never inferred from the left highlight.
    let titleSgr: string;
    if (this._focus === "main" && this.remoteIsActiveMainOwner(remote)) {
      titleSgr = SGR_ACTIVE_MAIN_WHITE;
    } else if (selected && this._focus !== "main") {
      titleSgr = SGR_SELECTION_BLUE;
    } else {
      titleSgr = "\x1b[1m";
    }
    const hostLabel = sanitizeBounded(remote.hostLabel, PEER_LABEL_MAX_CODEPOINTS);
    // Staleness leads the variable-length owner label so clipping can never
    // hide the honest observation behind a long friendly name.
    const stale = remote.rosterState === "stale" ? "[stale] " : "";
    const lines = [
      wrapRow(cardTitle(remote.row), cols, titleSgr),
      wrapRow(`  host ${stale}${hostLabel}`, cols),
      wrapRow(`${marker}${cardStatusText(facts)}`, cols),
      wrapRow(`  ${cardBackgroundText(facts)}`, cols),
    ];
    if (!this.collapsedRemoteEntryKeys.has(entry.key)) {
      const activity = renderActivityLines(remote.row.activity, cols);
      while (activity.length < ACTIVITY_LINES_MAX) {
        activity.push(wrapRow("", cols));
      }
      lines.push(...activity);
    }
    return lines;
  }

  /** True only when Main reports this exact remote card as the actual content owner. */
  private remoteIsActiveMainOwner(remote: SidebarRemoteEntry): boolean {
    const owner = this.activeMainOwner_;
    return owner !== undefined && owner.kind === "remote"
      && owner.hostId === remote.hostId
      && owner.hostRunId === remote.hostRunId
      && owner.rowId === remote.row.id;
  }

  /** True when at least one left-roster card can be expanded/collapsed with Space. */
  private hasExpandableCards(): boolean {
    return this.entries.some((entry) => entry.kind === "item" || entry.kind === "remote");
  }

  private renderFormPane(
    cols: number,
    rows: number,
  ): { lines: string[]; cursor?: { column: number; row: number } } {
    const editing = this.formKind === "edit";
    // Only the New form carries the single Host line; Edit keeps its exact
    // existing layout and budget.
    const newForm = this.formKind === "new";
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
    // The New form's one Host line takes the single spacer row the form has
    // always reserved below the editor, so the editable body keeps exactly its
    // previous row budget at every geometry; Edit is untouched.
    const hostRows = newForm ? 1 : 0;
    const fixedRows = editing
      ? 1 + 2 + 1 + 1 + noticeLines.length + footerLines.length
      : 1 + hostRows + 1 + noticeLines.length + footerLines.length;
    const fieldRows = rows - fixedRows;
    if (fieldRows < 1) return this.renderTooSmall(cols, rows);

    const prefix = editing ? "> New name: " : "> Workspace: ";
    const prefixWidth = Math.min(visibleWidth(prefix), cols - 1);
    const fieldWidth = Math.max(1, cols - prefixWidth);
    const fieldFrame = this.formField.render(fieldWidth, fieldRows);
    if (!fieldFrame.cursor.visible || fieldFrame.lines.length === 0) return this.renderTooSmall(cols, rows);
    const labeledRows = labeledFieldRows(
      fieldFrame,
      Math.min(fieldRows, fieldFrame.lines.length),
      prefix,
      prefixWidth,
      cols,
    );
    if (labeledRows === undefined) return this.renderTooSmall(cols, rows);

    const lines = [wrapRow(header, cols, "\x1b[1m")];
    let hostRow: number | undefined;
    let hostValueStart = 0;
    let hostValueEnd = 0;
    if (newForm) {
      // One fixed Host line, drawn with the pane's ordinary marker/label style
      // and clipped exactly like every other bounded host-owned row.
      const hostPrefix = this.formHostFocused ? `> ${NEW_FORM_HOST_PREFIX}` : `  ${NEW_FORM_HOST_PREFIX}`;
      const hostPrefixWidth = Math.min(visibleWidth(hostPrefix), cols - 1);
      const hostAvailable = Math.max(1, cols - hostPrefixWidth);
      const hostValue = truncateToWidth(`[ ${this.currentNewFormHostLabel()} ]`, hostAvailable, "...", true);
      hostRow = lines.length;
      hostValueStart = hostPrefixWidth;
      hostValueEnd = hostPrefixWidth + Math.max(1, visibleWidth(hostValue));
      lines.push(wrapRow(`${hostPrefix}${hostValue}`, cols));
    }
    if (editing) {
      lines.push(wrapRow(" Current name (display only; type a complete replacement): ", cols));
      const currentName = sanitizeBounded(this.editTarget?.currentName ?? "", 256);
      lines.push(wrapRow(truncateToWidth(currentName, cols, "...", true), cols));
    }
    const fieldTopRow = lines.length;
    lines.push(...labeledRows);
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

    // This complete pane IS the drawn New form: retain the Host line's written
    // geometry so only that drawn control can be clicked.
    this.formHostDisplay = newForm && hostRow !== undefined
      ? Object.freeze({
        pane: "new" as const,
        cols,
        rows,
        row: hostRow,
        valueStart: hostValueStart,
        valueEnd: hostValueEnd,
        optionKey: this.newFormHostOptionsKey(),
        formGeneration: this.formGeneration,
      })
      : undefined;
    // The written-submit candidate exists only for a REMOTE destination: a
    // Local submission keeps its exact previous path and needs no receipt, and
    // it therefore adds no extra writer boundary either.
    if (newForm && this.newFormHostIsRemote()) {
      this.captureCreateFormCandidate(this.formField.getValue(), cols, rows);
    } else {
      this.createFormCandidate = undefined;
    }

    const fieldCursor = {
      column: Math.min(prefixWidth + fieldFrame.cursor.column, cols - 1),
      row: fieldTopRow + fieldFrame.cursor.row,
    };
    return {
      lines,
      // While the Host line owns the form's focus the hardware cursor belongs to
      // that drawn control; the workspace body keeps its label and geometry.
      cursor: newForm && this.formHostFocused && hostRow !== undefined
        ? { column: Math.min(hostValueEnd, cols - 1), row: hostRow }
        : fieldCursor,
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
    const inactiveRows = inactiveLines.map((line, index) => wrapRow(
      `${index === 0 ? inactivePrefix : " ".repeat(inactivePrefixWidth)}${line}`,
      cols,
    ));
    // The active editor's label sits beside its editable body row, exactly like
    // the inactive sibling row above/below it, whose label already sits beside
    // its value text.
    const activeRowsToDraw = labeledFieldRows(
      fieldFrame,
      Math.min(activeRows, fieldFrame.lines.length),
      activePrefix,
      activePrefixWidth,
      cols,
    );
    if (activeRowsToDraw === undefined) return this.renderTooSmall(cols, rows);
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
    // Only a complete remote render below may re-establish a picker frame.
    const previousCandidate = this.savedPickerCandidate;
    this.savedPickerCandidate = undefined;
    const remote = this.savedHost.kind === "remote" ? this.remoteSaved : undefined;
    const remoteOption = remote === undefined ? undefined : this.currentSavedHostOption();
    // The Host line is part of this picker only when a remote choice exists;
    // otherwise every row below is exactly the existing Local layout.
    const hostLine = this.savedHostLineShown();
    if (!hostLine) this.savedHostFocused = false;
    const header = " Saved conversations ";
    const queryRow = hostLine ? 2 : 1;
    const queryLine = this.renderSavedQueryLine(cols, queryRow);
    // Delete hints follow the Local picker unchanged, and for a remote choice the
    // OWNER's live delete exposure only (never this viewer's own settings).
    const deleteHints = remote === undefined || remoteOption?.deleteExposed === true;
    const footerLines = wrapHintLines(
      [
        `${this.toggleLabel} toggle / ${this.savedKeyHint("tui.select.up", "up")}/${this.savedKeyHint("tui.select.down", "down")} select`,
        `${this.savedKeyHint("tui.select.confirm", "enter")} open / ${this.savedKeyHint("tui.select.cancel", "esc")} back`,
        ...(deleteHints
          ? [`${this.savedKeyHint("app.session.delete", "ctrl+d")} delete / ${this.savedKeyHint("app.session.deleteNoninvasive", "ctrl+backspace")} empty`]
          : []),
        ...(hostLine ? ["shift+tab host"] : []),
      ],
      cols,
    );
    const notices = [this.savedError, ...(remote === undefined ? [] : [this.remoteSavedNotice]), this.savedQueryNotice]
      .filter((message, index, all): message is string => message !== undefined && all.indexOf(message) === index);
    const noticeLines = notices.length === 0 ? [] : wrapHintLines(notices.map((message) => `! ${message}`), cols);
    const issueCount = remote === undefined
      ? (this.pendingSavedList === undefined ? this.savedIssueCount : 0)
      : remote.result?.issueCount ?? 0;
    const issueLines = issueCount > 0
      ? wrapHintLines([`${issueCount} catalog issue(s) not shown`], cols)
      : [];
    if (footerLines === undefined || noticeLines === undefined || issueLines === undefined
      || visibleWidth(header) > cols) {
      return this.renderTooSmall(cols, rows);
    }
    // The fixed details area is reserved between the list and the footer so
    // notices can never displace it or make an impossible action look done.
    const hostRows = hostLine ? 1 : 0;
    const fixedRows = hostRows + 2 + SAVED_DETAILS_ROWS + noticeLines.length + issueLines.length + footerLines.length;
    const listRows = rows - fixedRows;
    if (listRows < 1) {
      return this.renderTooSmall(cols, rows);
    }
    this.savedLastListRows = listRows;

    const lines: string[] = [wrapRow(header, cols, "\x1b[1m")];
    let hostRow: number | undefined;
    let hostValueEnd = 0;
    if (hostLine) {
      // The New form's one Host line, reused: same marker/label style, value
      // span, clipping, and drawn-geometry pointer target.
      const hostPrefix = this.savedHostFocused ? `> ${NEW_FORM_HOST_PREFIX}` : `  ${NEW_FORM_HOST_PREFIX}`;
      const hostPrefixWidth = Math.min(visibleWidth(hostPrefix), cols - 1);
      const hostAvailable = Math.max(1, cols - hostPrefixWidth);
      const label = this.savedHost.kind === "local"
        ? NEW_FORM_LOCAL_HOST_LABEL
        : remoteOption?.label ?? this.savedHost.label;
      const hostValue = truncateToWidth(`[ ${label} ]`, hostAvailable, "...", true);
      hostRow = lines.length;
      hostValueEnd = hostPrefixWidth + Math.max(1, visibleWidth(hostValue));
      lines.push(wrapRow(`${hostPrefix}${hostValue}`, cols));
      if (this.savedPickerId !== undefined) {
        this.formHostDisplay = Object.freeze({
          pane: "saved" as const,
          cols,
          rows,
          row: hostRow,
          valueStart: hostPrefixWidth,
          valueEnd: hostValueEnd,
          optionKey: this.savedHostOptionsKey(),
          formGeneration: this.savedPickerId,
        });
      }
    }
    lines.push(queryLine.line);
    let y = 0;
    if (remote !== undefined) {
      y = this.renderRemoteSavedRows(remote, remoteOption, lines, listRows, cols, rows, previousCandidate);
    } else if (this.pendingSavedList !== undefined) {
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
      const top = this.savedScrollWindow(listRows, this.savedRows.length);
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
    // A remote selection's details stay blank until its actual owner row is
    // cached; a loading placeholder never fabricates a caption or workspace.
    const selectedRow = remote !== undefined
      ? (remote.result !== undefined && remote.resultRead === undefined
        ? this.remoteSavedRowAt(this.savedSelectedIndex)?.row
        : undefined)
      : this.pendingSavedList === undefined && this.savedRows.length > 0
        ? this.savedRows[this.savedSelectedIndex]
        : undefined;
    for (const detailLine of this.renderSavedDetails(selectedRow, cols)) {
      lines.push(wrapRow(detailLine, cols));
    }
    for (const noticeLine of noticeLines) lines.push(wrapRow(noticeLine, cols));
    for (const issueLine of issueLines) lines.push(wrapRow(issueLine, cols));
    lines.push(...blankLines(Math.max(0, rows - lines.length - footerLines.length)));
    for (const footerLine of footerLines) lines.push(wrapRow(footerLine, cols));
    return {
      lines,
      // While the Host line owns focus the hardware cursor belongs to it.
      cursor: hostLine && this.savedHostFocused && hostRow !== undefined
        ? { column: Math.min(hostValueEnd, cols - 1), row: hostRow }
        : queryLine.cursor,
    };
  }

  /**
   * The remote list body: the honest unusable/loading/empty state, or the drawn
   * window of the owner result from the absolute scroll top. Each index is the
   * cached owner row through the SAME row renderer as a local row, or a loading
   * placeholder that is never a drawn (actionable) row. Empty is claimed only
   * when the owner's FULL total is zero. A complete remote list with a result
   * records the frame candidate (kept across identical redraws, so an ordinary
   * repaint never revokes an earned writer receipt). Returns the rows used.
   */
  private renderRemoteSavedRows(
    remote: RemoteSavedState,
    option: SavedHostOption | undefined,
    lines: string[],
    listRows: number,
    cols: number,
    rows: number,
    previousCandidate: SavedPickerCandidate | undefined,
  ): number {
    const result = remote.result;
    const catalog = remote.catalog;
    if (result === undefined || catalog === undefined) {
      const unusable = this.remoteSavedUnusableText(option);
      if (remote.resultRead !== undefined) {
        lines.push(wrapRow(" Loading saved conversations... ", cols));
        return 1;
      }
      if (unusable !== undefined) {
        lines.push(wrapRow(` ${unusable} `, cols));
        return 1;
      }
      if (this.savedError === undefined && this.remoteSavedNotice === undefined) {
        lines.push(wrapRow(" Not loaded; edit the query or choose the host again ", cols));
        return 1;
      }
      return 0;
    }
    if (result.total === 0) {
      lines.push(wrapRow(
        this.savedQuery.trim().length > 0 ? " No matching saved conversations "
          : result.issueCount > 0 ? " No conversations could be listed " : " No saved conversations ",
        cols,
      ));
      return 1;
    }
    if (this.savedSelectedIndex >= result.total) {
      this.savedSelectedIndex = result.total - 1;
      this.retireSavedViewAuthority();
    }
    const selected = this.savedSelectedIndex;
    const top = this.savedScrollWindow(listRows, result.total);
    const displayed: DisplayedSavedRow[] = [];
    const drawn: { readonly paneRow: number; readonly index: number; readonly entryId: string }[] = [];
    let y = 0;
    for (let index = top; index < result.total && y < listRows; index += 1) {
      const cached = this.remoteSavedRowAt(index);
      if (cached === undefined) {
        // A placeholder is not a row: no hit target, no details, no authority.
        lines.push(wrapRow(`${index === selected ? "> " : "  "}loading...`, cols,
          index === selected ? SGR_SELECTION_BLUE : undefined));
      } else {
        const identity: RemoteSavedRowIdentity = Object.freeze({
          hostId: remote.hostId,
          hostRunId: catalog.hostRunId,
          catalogId: catalog.catalogId,
          resultId: result.resultId,
          entryId: cached.entryId,
        });
        displayed.push({ paneRow: lines.length, index, entry: cached.row, remote: identity });
        drawn.push(Object.freeze({ paneRow: lines.length, index, entryId: cached.entryId }));
        lines.push(this.renderSavedRow(cached.row, index === selected, cols));
      }
      y += 1;
    }
    let candidate: SavedPickerCandidate | undefined;
    if (this.remoteSavedHostUsable(option) && option.hostRunId === catalog.hostRunId
      && remote.resultRead === undefined && this.savedPickerId !== undefined) {
      const deleteExposed = option.deleteExposed === true;
      const selectedEntryId = this.remoteSavedRowAt(selected)?.entryId;
      const identity = JSON.stringify([
        this.savedViewEpoch, this.savedPickerId, this.savedQueryRevision, remote.hostId, catalog.hostRunId,
        catalog.catalogId, result.resultId, result.total, selected, selectedEntryId ?? null,
        deleteExposed, cols, rows, drawn.map((row) => [row.paneRow, row.index, row.entryId]),
      ]);
      if (previousCandidate !== undefined && previousCandidate.identity === identity) {
        candidate = previousCandidate;
      } else {
        const token = this.savedPickerTokenSequence++;
        candidate = {
          token,
          identity,
          presentation: Object.freeze({
            renderToken: token,
            viewEpoch: this.savedViewEpoch,
            pickerId: this.savedPickerId,
            revision: this.savedQueryRevision,
            hostId: remote.hostId,
            hostRunId: catalog.hostRunId,
            catalogId: catalog.catalogId,
            resultId: result.resultId,
            total: result.total,
            selectedIndex: selected,
            selectedEntryId,
            deleteExposed,
            cols,
            rows,
            drawn: Object.freeze(drawn),
          }),
          written: false,
        };
      }
    }
    this.savedPickerCandidate = candidate;
    // Exact draw-derived remote rows, bound to the frame token that drew them.
    this.displayedSavedRows = candidate === undefined
      ? { cols, rows, entries: [] }
      : { cols, rows, entries: displayed, renderToken: candidate.token };
    return y;
  }

  private renderSavedQueryLine(
    cols: number,
    row = 1,
  ): { readonly line: string; readonly cursor: { column: number; row: number } } {
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
        row,
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

  /**
   * Keeps the keyboard-highlighted saved row visible inside the list window.
   * `count` is the local row count or the remote owner's FULL result total; the
   * top is absolute either way.
   */
  private savedScrollWindow(listRows: number, count: number): number {
    const maxTop = Math.max(0, count - 1);
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
    if (this.confirmPurpose === "remote-close") {
      return this.renderRemoteCloseConfirmPane(cols, rows);
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
    // One dialog for both targets: the local row, or the frozen REMOTE owner row
    // with the same text, warnings, full-file-path fit, and safety guard, plus one
    // annotation naming the owner host. Exactly one target exists at a time.
    const remoteTarget = this.remoteSavedDeleteTarget;
    const context = this.savedDeleteTarget ?? remoteTarget;
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
    const hostPrefix = "Host: ";
    const hostLabelWidth = cols - visibleWidth(hostPrefix);
    if (remoteTarget !== undefined && hostLabelWidth < 1) return this.renderTooSmall(cols, rows);
    const targetText = [
      `${captionPrefix}${visibleCaption}`,
      ...(remoteTarget === undefined
        ? []
        : [`${hostPrefix}${truncateToWidth(sanitizeBounded(remoteTarget.hostLabel, PEER_LABEL_MAX_CODEPOINTS), hostLabelWidth, "...", true)}`]),
      `Saved file: ${file}`,
    ];
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

  /**
   * The remote Close confirmation: the frozen target's display title and owner
   * host, the two bounded warnings that describe exactly what the owner may do,
   * and the confirm/cancel hints. The dialog is the WHOLE frozen target: nothing
   * here is re-read from a newer projection, so a snapshot, reorder, or
   * navigation can only refuse it.
   *
   * A frame that cannot show every line mints no candidate token at all. An
   * identical target/generation/geometry keeps the token it already had, while
   * a new generation is a new decision even when the drawn bytes match.
   */
  private renderRemoteCloseConfirmPane(cols: number, rows: number): { lines: string[] } {
    const tooSmall = (): { lines: string[] } => {
      this.invalidateRemoteCloseConfirmationDisplay();
      return this.renderTooSmall(cols, rows);
    };
    const target = this.remoteCloseTarget;
    if (target === undefined) return tooSmall();
    const header = " Close remote session? ";
    const hints = wrapHintLines(["enter/y = close", "esc/n = cancel"], cols);
    const warnings = wrapHintLines([
      "Only this session on its owner host is asked to stop; saved conversations are kept.",
      "The owner removes the row only after it observes an actual exit.",
    ], cols);
    if (hints === undefined || warnings === undefined || visibleWidth(header) > cols) return tooSmall();
    const titleLines = wrapHintLines([truncateToWidth(target.title, cols, "...", true)], cols);
    const hostLines = wrapHintLines([`host: ${target.hostLabel}`], cols);
    if (titleLines === undefined || hostLines === undefined) return tooSmall();
    const noticeLines = this.remoteCloseNotice === undefined
      ? []
      : wrapHintLines([`! ${this.remoteCloseNotice}`], cols) ?? [];
    const bodyRows = 1 + titleLines.length + hostLines.length + warnings.length
      + noticeLines.length + hints.length;
    if (bodyRows > rows) return tooSmall();

    const lines: string[] = [wrapRow(header, cols, "\x1b[1m")];
    for (const line of titleLines) lines.push(wrapRow(line, cols));
    for (const line of hostLines) lines.push(wrapRow(line, cols));
    for (const line of warnings) lines.push(wrapRow(line, cols));
    for (const line of noticeLines) lines.push(wrapRow(line, cols));
    lines.push(...blankLines(Math.max(0, rows - lines.length - hints.length)));
    const controlRow = lines.length;
    for (const line of hints) lines.push(wrapRow(line, cols));

    const generation = this.remoteCloseGeneration;
    // Identity is the frozen target, the monotonic generation, this pane's
    // geometry, and where the confirm/cancel controls were actually written.
    // The bounded notice is presentation text, not identity.
    const identity = JSON.stringify([
      target.hostId, target.hostRunId, target.rowId, generation,
      cols, rows, controlRow, hints.length,
    ]);
    if (this.remoteCloseDisplay !== undefined && this.remoteCloseDisplay.identity === identity) {
      this.remoteCloseRendered = true;
      return { lines };
    }
    const token = this.remoteCloseTokenSequence++;
    this.remoteCloseDisplay = Object.freeze({
      identity,
      generation,
      token,
      cols,
      rows,
      target,
    });
    this.remoteCloseWrittenToken = undefined;
    this.remoteCloseRendered = true;
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
 * The listen address/port text the Network pane drafts for one snapshot. A
 * KNOWN settings document with no saved address/port is prefilled with the
 * editable initial suggestion (`*:8088`); an explicit stored value — including
 * a stored port of `0` — is shown exactly as stored and is never defaulted.
 * Unknown, unavailable, or unsafe settings suggest nothing: the drafts stay
 * empty so the pane keeps refusing to enable hosting. This is local display
 * text only; it persists nothing and emits nothing.
 */
function peerListenDraftFromSettings(settings: PeerUiSettings | null): { host: string; port: string } {
  if (settings === null) return { host: "", port: "" };
  // Only a genuinely empty stored value is filled by the suggestion. A stored
  // value that sanitizes away stays empty so nothing is ever substituted for it.
  const host = sanitizeBounded(settings.bindHost, PEER_ADDRESS_MAX_CODEPOINTS);
  return {
    host: settings.bindHost.length === 0 ? PEER_DEFAULT_LISTEN_HOST : host,
    port: settings.bindPort === null || settings.bindPort === undefined
      ? PEER_DEFAULT_LISTEN_PORT
      : String(settings.bindPort),
  };
}

/**
 * Bracketed display form of one endpoint host, so a bound IPv6 address reads
 * `[::]:8088` instead of the ambiguous `:::8088`. Purely presentational: it
 * sanitizes for the terminal and changes no stored, requested, or advertised
 * address, and it adds no new address or discovery data.
 */
function peerBracketHost(host: string): string {
  const safe = sanitizeBounded(host, PEER_ADDRESS_MAX_CODEPOINTS);
  if (safe.length === 0 || !safe.includes(":") || safe.startsWith("[")) return safe;
  return `[${safe}]`;
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