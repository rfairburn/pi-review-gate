/**
 * Fresh-process reopen probe for the protected peer state store tests.
 *
 * Run as a separate Node process against one synthetic agent directory. It
 * prints only bounded, non-secret observations (public key ids, labels, times,
 * counts, and POSIX modes); it never prints PEM, private-key material, or file
 * contents. Query ids are supplied by the parent so the probe uses only the
 * public store seams.
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";

import { openPeerStateStoreWithPermissions } from "../src/session-host/network/peer-state-store";
import { openPeerStateStore } from "../src/session-host/network/peer-state";
import { createPosixTestPolicy } from "./session-host-network-peer-state-fixtures";

interface ProbeRequest {
	readonly accepted: readonly string[];
	readonly grants: readonly string[];
	readonly targets: readonly string[];
}

function main(): void {
	const agentDir = process.argv[2];
	const rawRequest = process.argv[3];
	if (typeof agentDir !== "string" || agentDir === "" || typeof rawRequest !== "string") {
		process.stderr.write("usage: child <agentDir> <request-json>\n");
		process.exit(2);
	}
	let request: ProbeRequest;
	try {
		request = JSON.parse(rawRequest) as ProbeRequest;
	} catch {
		process.stderr.write("invalid request\n");
		process.exit(2);
	}

	const store = process.argv[4] === "--default-policy"
		? openPeerStateStore({ agentDir })
		: openPeerStateStoreWithPermissions({ agentDir, permissions: createPosixTestPolicy() });
	try {
		const identity = store.identity;
		const accepted = request.accepted.map((keyId) => {
			const record = store.acceptedPeers.get(keyId);
			return record === undefined
				? { keyId, present: false }
				: { keyId, present: true, label: record.label, acceptedAt: record.acceptedAt, receiver: record.receiverKeyId };
		});
		const grants = request.grants.map((peerKeyId) => {
			const record = store.grants.get(peerKeyId);
			return record === undefined
				? { peerKeyId, present: false }
				: {
					peerKeyId,
					present: true,
					direction: record.direction,
					capability: record.capability,
					grantedAt: record.grantedAt,
					receiver: record.receiverKeyId,
				};
		});
		const remembered: Record<string, { keyId: string; fingerprint: string } | null> = Object.create(null);
		for (const targetId of request.targets) {
			const key = store.rememberedFor(targetId).read();
			remembered[targetId] = key === null ? null : { keyId: key.keyId, fingerprint: key.fingerprint };
		}
		process.stdout.write(`${JSON.stringify({
			label: identity === null ? null : identity.label,
			keyId: identity === null ? null : identity.key.keyId,
			certificateDerBytes: identity === null ? null : identity.certificateDer.length,
			accepted,
			grants,
			remembered,
		})}\n`);
	} finally {
		store.close();
	}

	const sessionHostDir = join(agentDir, "session-host");
	const peersDir = join(sessionHostDir, "peers");
	process.stdout.write(`${JSON.stringify({
		agentDirMode: lstatSync(agentDir).mode & 0o777,
		peersDirMode: lstatSync(peersDir).mode & 0o777,
		stateFileMode: lstatSync(join(peersDir, "state.json")).mode & 0o777,
	})}\n`);
}

main();
