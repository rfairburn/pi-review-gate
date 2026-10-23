/**
 * Focused fixtures for the protected peer state store tests (issue #480).
 *
 * The POSIX policy below is a REAL, test-only implementation of the shared
 * `PeerStatePermissionPolicy` seam: it inspects the actual file type, owner UID
 * and permission bits of the synthetic fixtures created by each test. It is NOT
 * the product platform policy and proves nothing about Windows ACL enforcement;
 * those cases belong to the platform/permissions task and its native fixture.
 */

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { PeerStatePermissionPolicy } from "../src/session-host/network/peer-state-permission-policy";

export type PeerStatePolicyOperation =
	| "assertOwnerControlledDirectory"
	| "assertPrivateDirectory"
	| "protectCreatedDirectory"
	| "assertPrivateFile"
	| "protectCreatedFile";

export interface RecordedPolicyCall {
	readonly operation: PeerStatePolicyOperation;
	readonly path: string;
	/** Observed byte size for file operations; the store must protect before writing. */
	readonly size: number | undefined;
}

export interface PeerStateTestPolicy extends PeerStatePermissionPolicy {
	readonly calls: RecordedPolicyCall[];
	/** Injected refusal predicate; called after the real check passed. */
	fail: ((call: RecordedPolicyCall) => boolean) | null;
}

function refuse(): never {
	throw new Error("peer state protection refused");
}

function ownerUid(): number {
	const getuid = process.getuid;
	// On Windows there is no POSIX owner; this test policy refuses everything and
	// must never be presented as native Windows protection.
	if (typeof getuid !== "function") refuse();
	return getuid.call(process);
}

function requireRealDirectory(path: string, expectedUid: number): Stats {
	const stats = lstatSync(path);
	if (stats.isSymbolicLink() || !stats.isDirectory()) refuse();
	if (stats.uid !== expectedUid) refuse();
	return stats;
}

function requireRealFile(path: string, expectedUid: number): Stats {
	const stats = lstatSync(path);
	if (stats.isSymbolicLink() || !stats.isFile()) refuse();
	if (stats.uid !== expectedUid) refuse();
	return stats;
}

/**
 * Real POSIX policy used only by focused tests. `ownerUid` may be overridden to
 * exercise the ownership branch against a synthetic expected account.
 */
export function createPosixTestPolicy(options: { ownerUid?: number } = {}): PeerStateTestPolicy {
	const expectedUid = options.ownerUid ?? ownerUid();
	const calls: RecordedPolicyCall[] = [];
	const policy: PeerStateTestPolicy = {
		calls,
		fail: null,
		assertOwnerControlledDirectory(path) {
			const stats = requireRealDirectory(path, expectedUid);
			if ((stats.mode & 0o022) !== 0) refuse();
			record({ operation: "assertOwnerControlledDirectory", path, size: undefined });
		},
		assertPrivateDirectory(path) {
			const stats = requireRealDirectory(path, expectedUid);
			const mode = stats.mode & 0o777;
			if ((mode & 0o077) !== 0 || (mode & 0o700) !== 0o700) refuse();
			record({ operation: "assertPrivateDirectory", path, size: undefined });
		},
		protectCreatedDirectory(path) {
			requireRealDirectory(path, expectedUid);
			chmodSync(path, 0o700);
			const stats = requireRealDirectory(path, expectedUid);
			if ((stats.mode & 0o777) !== 0o700) refuse();
			record({ operation: "protectCreatedDirectory", path, size: undefined });
		},
		assertPrivateFile(path) {
			const stats = requireRealFile(path, expectedUid);
			const mode = stats.mode & 0o777;
			if ((mode & 0o077) !== 0 || (mode & 0o600) !== 0o600) refuse();
			record({ operation: "assertPrivateFile", path, size: stats.size });
		},
		protectCreatedFile(path) {
			const before = requireRealFile(path, expectedUid);
			// Ownership receipt only: this fresh object must still be empty.
			chmodSync(path, 0o600);
			const stats = requireRealFile(path, expectedUid);
			if ((stats.mode & 0o777) !== 0o600) refuse();
			record({ operation: "protectCreatedFile", path, size: before.size });
		},
	};

	function record(call: RecordedPolicyCall): void {
		calls.push(call);
		if (policy.fail !== null && policy.fail(call)) refuse();
	}

	return policy;
}

export interface AgentDirFixture {
	readonly root: string;
	/** Lexical agent directory path (may contain platform symlinked parents). */
	readonly agentDir: string;
	/** Canonical real agent directory, matching what the store uses. */
	readonly canonicalAgentDir: string;
	readonly sessionHostDir: string;
	readonly peersDir: string;
	readonly statePath: string;
}

/** Synthetic, positively owned agent directory; removed by the test's finalizer. */
export function createAgentDirFixture(t: TestContext): AgentDirFixture {
	const root = mkdtempSync(join(tmpdir(), "prg-peer-state-"));
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
	});
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { mode: 0o700 });
	const canonicalAgentDir = realpathSync(agentDir);
	const sessionHostDir = join(canonicalAgentDir, "session-host");
	return {
		root,
		agentDir,
		canonicalAgentDir,
		sessionHostDir,
		peersDir: join(sessionHostDir, "peers"),
		statePath: join(sessionHostDir, "peers", "state.json"),
	};
}
