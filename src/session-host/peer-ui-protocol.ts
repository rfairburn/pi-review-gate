/** Pure display/action contracts for the network sidebar (issue #482). No IO. */
import type { RemoteSessionMetadata } from "./network/roster-metadata";

export interface PeerUiConsent {
	/** Opaque coordinator-owned request handle, not a display label or fingerprint. */
	readonly id: string;
	readonly kind: "incoming" | "server-key";
	readonly label: string;
	readonly fingerprint: string;
	readonly endpoint: string | null;
	readonly requestedAt: number;
	readonly expiresAt: number;
}

/**
 * Descriptive Saved-history facts the coordinator observed for ONE destination.
 * `supported` is true only when that owner negotiated the optional Saved catalog
 * exchange on its current binding; `deleteExposed` is that OWNER's live
 * remote-history delete exposure (`null` when unknown). Both are display facts
 * only: they grant nothing, the owner re-checks its real policy and file guards on
 * every request, and an absent value is never support or delete authority. This is
 * never this viewer's own `remoteHistoryDeleteEnabled` (an owner setting for OTHER
 * viewers) nor its `viewerNativeInputEnabled` (native pane input/copy only).
 */
export interface PeerUiHostSaved {
	readonly supported: boolean;
	readonly deleteExposed: boolean | null;
}

export interface PeerUiHost {
	/** Local saved-destination handle. It is never a native instance id or identity. */
	readonly id: string;
	readonly label: string;
	readonly host: string;
	readonly port: number;
	readonly state: "disconnected" | "connecting" | "pairing" | "connected" | "retrying" | "error";
	readonly fingerprint: string | null;
	readonly message: string | null;
	readonly reconnectSuppressed: boolean;
	readonly previouslyConnected: boolean;
	readonly roster: {
		readonly state: "never" | "current" | "stale";
		/** null means no complete observation; current [] is a valid empty roster. */
		readonly rows: readonly RemoteSessionMetadata[] | null;
		/**
		 * Owner run identity of the last complete observation. A stale roster keeps
		 * the run it was observed on; `never`/unknown is null, never a guess. This is
		 * a display fact only: it grants nothing and authorizes nothing. Optional so
		 * an older coordinator's DTO stays representable.
		 */
		readonly hostRunId?: string | null;
	};
	/**
	 * Optional Saved-history capability and live owner delete-exposure description.
	 * Absent (an older coordinator or fake) means NOT supported and no delete
	 * exposure: the Saved picker does not offer this destination and requests
	 * nothing from it. A present `supported: false` (a connected legacy owner) is
	 * shown as an honest unsupported choice that is likewise never asked anything.
	 */
	readonly saved?: PeerUiHostSaved;
}

export interface PeerUiTrustedPeer {
	/** Opaque local receiving-permission action handle. */
	readonly id: string;
	readonly label: string;
	readonly fingerprint: string;
	readonly hasInboundGrant: boolean;
}

export interface PeerUiSettings {
	readonly hostingEnabled: boolean;
	readonly bindHost: string;
	readonly bindPort: number | null;
	readonly autoReconnect: boolean;
	readonly bellEnabled: boolean;
	/**
	 * VIEWER side: whether THIS host's sidebar forwards keyboard, mouse, paste, and
	 * text copies to the remote native pane it displays. Off affects only this
	 * viewer; it never disconnects, revokes, changes Hosting/Auto, stops or cancels
	 * owner work, or touches owner-local input/copy or any other viewer.
	 */
	readonly viewerNativeInputEnabled: boolean;
	/**
	 * OWNER side: whether THIS host exposes remote saved-history deletion to its
	 * paired viewers. It is an owner policy fact, never a viewer-side delete
	 * toggle, and it never gates this host's own local Saved deletion.
	 */
	readonly remoteHistoryDeleteEnabled: boolean;
}

export interface PeerUiSnapshot {
	readonly revision: number;
	readonly status: "loading" | "ready" | "unavailable";
	/** null is unavailable/unknown configuration, never silently selected defaults. */
	readonly settings: PeerUiSettings | null;
	readonly identityFingerprint: string | null;
	readonly listener: {
		readonly state: "off" | "starting" | "listening" | "error";
		readonly host: string | null;
		readonly port: number | null;
		readonly message: string | null;
	};
	readonly hosts: readonly PeerUiHost[] | null;
	readonly trustedPeers: readonly PeerUiTrustedPeer[] | null;
	readonly consents: readonly PeerUiConsent[];
	/** Bounded, display-safe local status, including unsaved configuration. */
	readonly notice: string | null;
}

/** All endpoint/label text is data; parsing and admission belong to the coordinator. */
export type PeerUiCommand =
	| { readonly type: "peer-listener"; readonly enabled: boolean; readonly host: string; readonly port: string }
	| { readonly type: "peer-auto-reconnect"; readonly enabled: boolean }
	| { readonly type: "peer-bell"; readonly enabled: boolean }
	/** Viewer-side remote native input/copy for this sidebar's displayed remote pane. */
	| { readonly type: "peer-viewer-native-input"; readonly enabled: boolean }
	/** Owner-side policy: expose remote saved-history deletion to paired viewers. */
	| { readonly type: "peer-remote-history-delete"; readonly enabled: boolean }
	| { readonly type: "peer-add"; readonly label: string; readonly host: string; readonly port: string }
	| { readonly type: "peer-connect"; readonly hostId: string }
	| { readonly type: "peer-disconnect"; readonly hostId: string }
	| { readonly type: "peer-remove"; readonly hostId: string }
	| { readonly type: "peer-revoke"; readonly peerId: string };

/** Consent cannot use the ordinary command path: Main must verify its written frame. */
export type PeerUiAction = PeerUiCommand
	| { readonly type: "peer-open" }
	| { readonly type: "peer-consent"; readonly consentId: string; readonly decision: "approve" | "deny"; readonly renderToken: number };

export interface PeerConsentPresentation {
	readonly consentId: string;
	readonly decision: "approve" | "deny";
	readonly renderToken: number;
}

/**
 * Exact identity shared by every remote Saved picker intent: the open picker
 * (`pickerId`, re-minted on every actual Host change), this intent's own
 * `requestId`, the query `revision` it belongs to, the selected destination
 * handle, and the exact owner run it names. Never a path or a local row id.
 */
export interface PeerSavedUiIntentBase {
	readonly pickerId: number;
	readonly requestId: number;
	readonly revision: number;
	readonly hostId: string;
	readonly hostRunId: string;
}

/** Fresh owner listing (replaces the owner's catalog AND result). */
export interface PeerSavedUiListIntent extends PeerSavedUiIntentBase {
	readonly type: "saved-remote-list";
	/** Exact query text; never trimmed or normalized. */
	readonly query: string;
	readonly offset: number;
	readonly count: number;
}

/** Search inside one exact owner catalog (replaces the owner's result only). */
export interface PeerSavedUiSearchIntent extends PeerSavedUiIntentBase {
	readonly type: "saved-remote-search";
	readonly catalogId: string;
	readonly query: string;
	readonly offset: number;
	readonly count: number;
}

/** Another bounded window of the SAME owner result; never relists or remints ids. */
export interface PeerSavedUiWindowIntent extends PeerSavedUiIntentBase {
	readonly type: "saved-remote-window";
	readonly catalogId: string;
	readonly resultId: string;
	readonly offset: number;
	readonly count: number;
}

/**
 * One deliberate destructive-class intent on one exact owner entry. `renderToken`
 * is the ACTUAL drawn frame it came from: the picker frame for Resume and
 * Delete-prepare, the written confirmation frame for Delete. Main must prove its
 * own writer receipt for that token before anything is sent.
 */
export interface PeerSavedUiEntryIntentBase extends PeerSavedUiIntentBase {
	readonly catalogId: string;
	readonly resultId: string;
	readonly entryId: string;
	readonly renderToken: number;
}

export interface PeerSavedUiResumeIntent extends PeerSavedUiEntryIntentBase {
	readonly type: "saved-remote-resume";
}

/** Owner prepare only (`confirmed: false` on the wire); never a confirmation. */
export interface PeerSavedUiDeletePrepareIntent extends PeerSavedUiEntryIntentBase {
	readonly type: "saved-remote-delete-prepare";
}

/** The one confirmed delete of the frozen, owner-prepared entry. */
export interface PeerSavedUiDeleteIntent extends PeerSavedUiEntryIntentBase {
	readonly type: "saved-remote-delete";
}

/**
 * The remote picker identity stopped owning the pane (dismissal, an actual Host
 * change, or a completed Resume). Main drops this picker's UNSENT read intent and
 * private references only; accepted owner work is never cancelled or replayed.
 */
export interface PeerSavedUiDismissIntent {
	readonly type: "saved-remote-dismiss";
	readonly pickerId: number;
	readonly hostId: string;
}

/**
 * Remote Saved picker intents. They are intents only: no transport, manager,
 * callback, or authority crosses this boundary, and none of them is ever a local
 * `saved-*` action.
 */
export type PeerSavedUiAction =
	| PeerSavedUiListIntent
	| PeerSavedUiSearchIntent
	| PeerSavedUiWindowIntent
	| PeerSavedUiResumeIntent
	| PeerSavedUiDeletePrepareIntent
	| PeerSavedUiDeleteIntent
	| PeerSavedUiDismissIntent;

/** Owned exclusively by Main; no manager or raw transport/consent handle escapes. */
export interface PeerCoordinator {
	start(): Promise<void>;
	read(): PeerUiSnapshot;
	perform(command: PeerUiCommand): Promise<void>;
	/** Trusted local Main only, after the exact dialog's actual-written fence. */
	decideConsent(id: string, decision: "approve" | "deny"): boolean;
	close(): Promise<void>;
}
