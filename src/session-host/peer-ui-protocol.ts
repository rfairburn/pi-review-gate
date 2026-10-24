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

/**
 * Closed sanitized storage vocabulary (Refs #494). These mirror the Network
 * storage diagnostics: a reason is never a path, errno, mode, SID, or native
 * output, and an object is a fixed storage name, never a path.
 */
export type PeerUiStorageReason =
	| "unsafe-permissions"
	| "extended-acl"
	| "unsafe-object"
	| "foreign-owner"
	| "protection-unsupported"
	| "unreadable"
	| "malformed"
	| "missing-initialized"
	| "changed";

export type PeerUiStorageObject =
	| "session-host"
	| "peers"
	| "peer-state"
	| "peer-preferences"
	| "preferences-document";

export const PEER_UI_STORAGE_REASONS: readonly PeerUiStorageReason[] = Object.freeze([
	"unsafe-permissions",
	"extended-acl",
	"unsafe-object",
	"foreign-owner",
	"protection-unsupported",
	"unreadable",
	"malformed",
	"missing-initialized",
	"changed",
]);

/** Fixed target order of the explicit permission repair (parent first). */
export const PEER_UI_STORAGE_OBJECTS: readonly PeerUiStorageObject[] = Object.freeze([
	"session-host",
	"peers",
	"peer-state",
	"peer-preferences",
	"preferences-document",
]);

/**
 * Conventional relative names, below the Pi agent directory, of the fixed
 * storage objects. They identify an object for a person; they are never a
 * resolved or private path.
 */
export const PEER_UI_STORAGE_OBJECT_NAMES: Readonly<Record<PeerUiStorageObject, string>> = Object.freeze({
	"session-host": "session-host",
	peers: "session-host/peers",
	"peer-state": "session-host/peers/state.json",
	"peer-preferences": "session-host/peer-preferences",
	"preferences-document": "session-host/peer-preferences/preferences.json",
});

/** One protected store that refused, with its sanitized reason when known. */
export interface PeerUiStorageProblem {
	/** `settings` is the preferences document; `trust` is the identity/trust document. */
	readonly store: "settings" | "trust";
	/** null when the refusal carried no sanitized diagnostic. */
	readonly reason: PeerUiStorageReason | null;
	readonly object: PeerUiStorageObject | null;
}

/** One fixed repair target as the last read-only assessment saw it. */
export interface PeerUiStorageTarget {
	readonly target: PeerUiStorageObject;
	readonly status: "absent" | "protected" | "repairable" | "refused" | "not-assessed";
	readonly reason: PeerUiStorageReason | null;
}

/**
 * Whether the explicit permission repair applies. Display facts only: the
 * coordinator re-proves eligibility, Network inactivity, and the exact
 * assessment generation at the actual mutation.
 *
 * - `none`: the refusal is not a permission problem the repair can address.
 * - `unchecked`: eligibility could not be assessed.
 * - `unsupported`: this platform cannot establish protection.
 * - `nothing-to-repair`: every present target already meets its protection.
 * - `blocked`: one target can never be repaired automatically.
 * - `busy`: Network activity owns state; it must stop before a repair.
 * - `offered`: a confirmed repair may be requested for exactly this generation.
 * - `restart-required`: protection changed or may have changed; Network stays
 *   unavailable until a deliberate host restart.
 */
export type PeerUiStorageRepair =
	| { readonly state: "none" | "unchecked" | "unsupported" | "nothing-to-repair" | "busy" }
	| { readonly state: "blocked"; readonly target: PeerUiStorageObject; readonly reason: PeerUiStorageReason | null }
	| { readonly state: "offered"; readonly generation: number; readonly targets: readonly PeerUiStorageTarget[] }
	| {
		readonly state: "restart-required";
		readonly outcome: "repaired" | "partial";
		readonly priorExposurePossible: boolean;
	};

export interface PeerUiStorage {
	/** Selects operating-system-appropriate mitigation text. */
	readonly platform: "windows" | "posix";
	readonly problems: readonly PeerUiStorageProblem[];
	readonly repair: PeerUiStorageRepair;
}

export interface PeerUiSnapshot {
	readonly revision: number;
	readonly status: "loading" | "ready" | "unavailable";
	/**
	 * Sanitized Network storage refusal facts and repair eligibility. Absent or
	 * null means no storage problem was observed in this lifecycle. Optional so an
	 * older coordinator's DTO stays representable.
	 */
	readonly storage?: PeerUiStorage | null;
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

/**
 * Consent and the storage permission repair cannot use the ordinary command
 * path: Main must verify the exact written confirmation frame first.
 */
export type PeerUiAction = PeerUiCommand
	| { readonly type: "peer-open" }
	| { readonly type: "peer-consent"; readonly consentId: string; readonly decision: "approve" | "deny"; readonly renderToken: number }
	/**
	 * The one confirmed request to repair the fixed storage targets' protection,
	 * frozen to the assessment `generation` the written confirmation showed.
	 */
	| { readonly type: "peer-storage-repair"; readonly generation: number; readonly renderToken: number };

export interface PeerConsentPresentation {
	readonly consentId: string;
	readonly decision: "approve" | "deny";
	readonly renderToken: number;
}

/** The current complete storage-repair confirmation candidate (Repair chosen). */
export interface PeerStorageRepairPresentation {
	readonly generation: number;
	readonly renderToken: number;
}

/**
 * What a confirmed repair request did. `stale` means the frozen generation or
 * the fresh eligibility recheck no longer matched; `busy` means Network
 * activity owned state; `not-run` means nothing could be attempted. In every one
 * of those nothing was changed. Otherwise the request ran, and the snapshot
 * carries the truthful outcome.
 */
export type PeerUiStorageRepairAdmission = "ran" | "stale" | "busy" | "not-run";

type StorageText = { readonly why: string; readonly mitigation: string };

function storageObjectText(object: PeerUiStorageObject | null): string {
	return object === null ? "Network storage" : PEER_UI_STORAGE_OBJECT_NAMES[object];
}

/**
 * Fixed why/mitigation text for one sanitized refusal. Pure and closed: it never
 * includes a path beyond the conventional relative object name, an errno, a
 * mode, a SID, native output, or record content.
 */
export function describePeerUiStorageReason(
	reason: PeerUiStorageReason | null,
	object: PeerUiStorageObject | null,
	platform: PeerUiStorage["platform"],
	repairOffered = false,
): StorageText {
	const name = storageObjectText(object);
	const restart = "then restart Pi.";
	const offer = repairOffered ? "Use Repair permissions below, or " : "";
	switch (reason) {
		case "unsafe-permissions":
			return {
				why: `${name} does not meet the required access permissions.`,
				mitigation: platform === "windows"
					? `${offer}${repairOffered ? "l" : "L"}imit access yourself to your account, SYSTEM, and Administrators; ${restart}`
					: `${offer}${repairOffered ? "m" : "M"}ake it owner-only yourself (directories 0700, files 0600); ${restart}`,
			};
		case "extended-acl":
			return {
				why: `${name} has an extended ACL entry that grants another account access.`,
				mitigation: `${offer}${repairOffered ? "r" : "R"}emove that ACL entry yourself; ${restart}`,
			};
		case "unsafe-object":
			return {
				why: `${name} is a link, junction, unexpected type, or has an extra hard link.`,
				mitigation: `It is never followed or changed. Replace it with a real item you own, ${restart}`,
			};
		case "foreign-owner":
			return {
				why: `${name} is owned by another account.`,
				mitigation: `Ownership is never taken over. Have it returned to your account, ${restart}`,
			};
		case "protection-unsupported":
			return {
				why: `Protection of ${name} cannot be verified on this system.`,
				mitigation: platform === "windows"
					? `Make sure Windows PowerShell is available and the access list holds only ordinary entries, ${restart}`
					: `Network stays unavailable here; nothing is changed. Use a supported local filesystem, ${restart}`,
			};
		case "unreadable":
			return {
				why: `${name} could not be read (access denied or an I/O error).`,
				mitigation: `Check that your account can read it and that the disk is healthy, ${restart}`,
			};
		case "malformed":
			return {
				why: `${name} is damaged, too large, or from an unsupported version.`,
				mitigation: "It is never reset or overwritten. Restore it from a backup; for the identity document see the manual identity replacement guide.",
			};
		case "missing-initialized":
			return {
				why: `${name} is missing from an already initialized storage directory.`,
				mitigation: "Nothing is refilled and no key is created. Restore the document from a backup or see the manual identity replacement guide.",
			};
		case "changed":
			return {
				why: `${name} changed while it was being checked.`,
				mitigation: `Make sure nothing else is modifying it, ${restart}`,
			};
		default:
			return {
				why: `${name} could not be opened.`,
				mitigation: "Nothing was changed. Restart Pi; see the recovery documentation if it persists.",
			};
	}
}

/**
 * Bounded display lines for an attached storage fact: one why/mitigation pair
 * per distinct refusal, then the repair state. Pure; no IO.
 */
export function describePeerUiStorage(storage: PeerUiStorage): readonly string[] {
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const problem of storage.problems) {
		const store = problem.store === "settings"
			? "Network settings are unavailable"
			: "Network identity and trust are unavailable";
		const text = describePeerUiStorageReason(
			problem.reason, problem.object, storage.platform, storage.repair.state === "offered",
		);
		const key = JSON.stringify([problem.reason, problem.object]);
		if (seen.has(key)) {
			lines.push(`${store}: same cause as above.`);
			continue;
		}
		seen.add(key);
		lines.push(`${store}: ${text.why}`);
		lines.push(text.mitigation);
	}
	const repair = storage.repair;
	switch (repair.state) {
		case "offered":
			lines.push("Repair permissions is available below; it changes only protection, after you confirm it.");
			break;
		case "blocked": {
			const text = describePeerUiStorageReason(repair.reason, repair.target, storage.platform);
			lines.push(`Repair is not possible: ${text.why}`);
			lines.push(text.mitigation);
			break;
		}
		case "busy":
			lines.push("Repair is not offered while Network work is active: disable hosting and disconnect first.");
			break;
		case "unsupported":
			lines.push("Repair is not supported on this platform; nothing is changed.");
			break;
		case "unchecked":
			lines.push("Repair eligibility could not be checked; nothing is changed.");
			break;
		case "nothing-to-repair":
			lines.push("Protection now looks correct; restart Pi to reopen Network.");
			break;
		case "restart-required":
			lines.push(repair.outcome === "repaired"
				? "Permissions were repaired. Network stays unavailable until you restart Pi."
				: "Permissions were only partly repaired and may have changed. Network stays unavailable until you restart Pi.");
			if (repair.priorExposurePossible) {
				lines.push("Repair cannot undo earlier access: if another account could read these files, replace the identity key separately and pair again.");
			}
			break;
		default:
			break;
	}
	return Object.freeze(lines);
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
	/**
	 * Trusted local Main only, after the exact written repair confirmation frame.
	 * Repairs only the protection of the fixed existing storage targets for the
	 * frozen assessment `generation`; it never hosts, connects, creates keys,
	 * reopens stores, restores saved intent, or retries. Optional so an older
	 * coordinator or fake stays representable (Main then refuses).
	 */
	repairStorageProtection?(generation: number): Promise<PeerUiStorageRepairAdmission>;
	close(): Promise<void>;
}
