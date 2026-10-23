/**
 * Safe default entry point for explicit peer-state persistence (issue #480).
 * Importing this module creates no state, identity, process or listener. Opening
 * it reads only existing state; initialization is a separate explicit action.
 */
import { createPeerStatePermissionPolicy } from "./peer-state-permissions";
import { openPeerStateStoreWithPermissions, type PeerStateStore } from "./peer-state-store";

export interface OpenPeerStateStoreOptions {
	/** Existing canonical Pi agent directory owned by the caller's host lifecycle. */
	readonly agentDir: string;
}

export type { PeerStateStore, PeerStateTrustSnapshot } from "./peer-state-store";

/** Use the actual platform policy; callers cannot accidentally select test probes. */
export function openPeerStateStore(options: OpenPeerStateStoreOptions): PeerStateStore {
	return openPeerStateStoreWithPermissions({
		agentDir: options?.agentDir,
		permissions: createPeerStatePermissionPolicy(),
	});
}
