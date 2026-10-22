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

/** Owned exclusively by Main; no manager or raw transport/consent handle escapes. */
export interface PeerCoordinator {
	start(): Promise<void>;
	read(): PeerUiSnapshot;
	perform(command: PeerUiCommand): Promise<void>;
	/** Trusted local Main only, after the exact dialog's actual-written fence. */
	decideConsent(id: string, decision: "approve" | "deny"): boolean;
	close(): Promise<void>;
}
