/**
 * The shared `session-host` base for protected Network writes (Refs #494).
 *
 * Both protected Network stores (trust and preferences) may be the first to
 * need `<agentDir>/session-host`. This is the one rule they share:
 *
 * - Absent: created exclusively with private protection by the shared creator
 *   (`createSessionHostStateDirectory`), then proven private by the injected
 *   policy before anything is created inside it. The containing agent directory
 *   is not required to be owner-controlled for this, because there is no unsafe
 *   window: the directory is private at creation. A broadly writable ancestor can
 *   still rename or delete it — an availability boundary, not disclosure — and
 *   the stores' identity receipts detect a replacement.
 * - Created but unverified, or not created: the directory (if any) is left as it
 *   is for local use, and Network fails closed with the creator's fixed reason.
 * - Already present (including a concurrent creator's): the existing
 *   owner-controlled check applies unchanged. Nothing is repaired here; repair of
 *   existing storage is only the separate explicit remediation backend.
 */
import { lstatSync, type BigIntStats } from "node:fs";

import { createSessionHostStateDirectory } from "../roster-store";
import type { PeerStatePermissionPolicy } from "./peer-state-permission-policy";
import type { PeerStorageReason } from "./peer-storage-diagnostics";

/** Exact directory identity recorded for later fences. */
export interface StorageReceipt {
	readonly dev: bigint;
	readonly ino: bigint;
}

export interface EnsureNetworkStateDirectoryOptions {
	readonly stateDir: string;
	readonly permissions: PeerStatePermissionPolicy;
	/** The caller's fixed error for this object, carrying the fixed reason. */
	readonly fail: (reason: PeerStorageReason) => Error;
	/** The caller's policy-call wrapper (maps a policy refusal to its own error). */
	readonly protect: (operation: () => void) => void;
}

const CREATION_REASONS: readonly PeerStorageReason[] = [
	"unsafe-permissions",
	"extended-acl",
	"unsafe-object",
	"foreign-owner",
	"protection-unsupported",
	"unreadable",
	"changed",
];

function asReason(value: string): PeerStorageReason {
	return (CREATION_REASONS as readonly string[]).includes(value) ? value as PeerStorageReason : "protection-unsupported";
}

function observe(stateDir: string, fail: (reason: PeerStorageReason) => Error): BigIntStats | undefined {
	try {
		return lstatSync(stateDir, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw fail("unreadable");
	}
}

function realDirectory(stateDir: string, fail: (reason: PeerStorageReason) => Error): StorageReceipt {
	const current = observe(stateDir, fail);
	if (current === undefined) throw fail("changed");
	if (current.isSymbolicLink() || !current.isDirectory()) throw fail("unsafe-object");
	return { dev: current.dev, ino: current.ino };
}

export function ensureNetworkStateDirectory(options: EnsureNetworkStateDirectoryOptions): StorageReceipt {
	const { stateDir, permissions, fail, protect } = options;
	if (observe(stateDir, fail) === undefined) {
		const creation = createSessionHostStateDirectory(stateDir);
		if (creation.outcome === "created-protected") {
			const receipt = realDirectory(stateDir, fail);
			protect(() => permissions.assertPrivateDirectory(stateDir));
			const after = realDirectory(stateDir, fail);
			if (after.dev !== receipt.dev || after.ino !== receipt.ino) throw fail("changed");
			return receipt;
		}
		if (creation.outcome !== "existing") throw fail(asReason(creation.reason));
	}
	const receipt = realDirectory(stateDir, fail);
	protect(() => permissions.assertOwnerControlledDirectory(stateDir));
	return receipt;
}
