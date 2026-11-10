/**
 * Synthetic peer host for the Android instrumented Keystore/mTLS checks.
 *
 * This fixture uses the unchanged production `createPeerHost` listener. It owns
 * one ephemeral P-256 identity per process and accepts pairing only for the exact
 * client public key and label supplied on the command line. It never accepts an
 * arbitrary client key, reads no ambient trust, and persists nothing.
 *
 * The fixture prints one JSON `ready` line with its public host key, then serves
 * the fixed `/pair` and `/app` shapes. A channel sends one metadata frame and
 * echoes every client binary message exactly. A `report` line on stdin prints a
 * bounded JSON report and exits 0 only when the requested mode's invariants hold.
 */

import { createInterface } from "node:readline";
import { createPeerHost, type PeerHost } from "../../src/session-host/network/peer-host";
import { generatePeerIdentity } from "../../src/session-host/network/identity";
import { isBoundedPeerKeyId, isValidPeerLabel } from "../../src/session-host/network/protocol";
import {
	createInMemoryAcceptedPeerStore,
	createInMemoryDirectionalGrantStore,
	type AcceptedPeerRecord,
	type DirectionalGrantRecord,
} from "../../src/session-host/network/trust";
import type { PeerByteChannel } from "../../src/session-host/network/channel";

type Mode = "happy" | "mismatch";
type Lane = "app" | "content";

interface PairingRecord {
	readonly peerKeyId: string;
	readonly label: string;
	readonly exactClient: boolean;
}

interface ChannelRecord {
	readonly lane: Lane;
	readonly peerKeyId: string;
	readonly peerLabel: string | null;
	bytesReceived: number;
	bytesEchoed: number;
}

interface FixtureOptions {
	readonly mode: Mode;
	readonly clientKeyId: string;
	readonly clientLabel: string;
	readonly listenHost: string;
	readonly listenPort: number;
}

const FIXTURE_HOST_LABEL = "android-peer-fixture-host";

function requiredOption(name: string): string {
	const args = process.argv.slice(2);
	const index = args.indexOf(`--${name}`);
	const value = index >= 0 ? args[index + 1] : undefined;
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`missing required fixture option: --${name}`);
	}
	return value;
}

function optionalOption(name: string, fallback: string): string {
	const args = process.argv.slice(2);
	const index = args.indexOf(`--${name}`);
	const value = index >= 0 ? args[index + 1] : undefined;
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readOptions(): FixtureOptions {
	const mode = optionalOption("mode", "happy");
	if (mode !== "happy" && mode !== "mismatch") throw new Error("--mode must be happy or mismatch");
	const clientKeyId = requiredOption("client-key-id");
	if (!isBoundedPeerKeyId(clientKeyId)) throw new Error("--client-key-id is not a bounded peer key id");
	const clientLabel = requiredOption("client-label");
	if (!isValidPeerLabel(clientLabel)) throw new Error("--client-label is not a bounded peer label");
	const listenHost = optionalOption("listen-host", "127.0.0.1");
	if (/[\s/\\?#@]/.test(listenHost) || listenHost.length > 255) {
		throw new Error("--listen-host is invalid");
	}
	const portText = optionalOption("port", "0");
	const listenPort = Number(portText);
	if (!Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65_535) {
		throw new Error("--port is invalid");
	}
	return { mode, clientKeyId, clientLabel, listenHost, listenPort };
}

async function main(): Promise<void> {
	const options = readOptions();
	const identity = await generatePeerIdentity(FIXTURE_HOST_LABEL);
	const acceptedPeers = createInMemoryAcceptedPeerStore();
	const grants = createInMemoryDirectionalGrantStore();
	const pairings: PairingRecord[] = [];
	const channels: ChannelRecord[] = [];
	const diagnostics = new Map<string, number>();
	let host: PeerHost | null = null;
	let reported = false;

	const recordDiagnostic = (event: { readonly code: string }): void => {
		diagnostics.set(event.code, (diagnostics.get(event.code) ?? 0) + 1);
	};

	const serveChannel = async (channel: PeerByteChannel, lane: Lane): Promise<void> => {
		const record: ChannelRecord = {
			lane,
			peerKeyId: channel.peerKey.keyId,
			peerLabel: channel.label,
			bytesReceived: 0,
			bytesEchoed: 0,
		};
		channels.push(record);
		const pending: Buffer[] = [];
		let ended = false;
		let wake: (() => void) | null = null;
		const wakeReader = (): void => {
			const resume = wake;
			wake = null;
			resume?.();
		};
		const stopMessages = channel.onMessage((bytes) => {
			pending.push(Buffer.from(bytes));
			wakeReader();
		});
		void channel.closed.then(() => {
			ended = true;
			wakeReader();
		});
		const nextMessage = async (): Promise<Buffer | null> => {
			for (;;) {
				const next = pending.shift();
				if (next !== undefined) return next;
				if (ended) return null;
				await new Promise<void>((resolve) => {
					wake = resolve;
					// Close or a queued message may have arrived between the checks
					// above and this assignment; resolve immediately in that case.
					if (pending.length > 0 || ended) {
						wake = null;
						resolve();
					}
				});
			}
		};
		try {
			const metadata = Buffer.from(
				JSON.stringify({
					kind: "android-peer-fixture-channel",
					lane,
					serverKeyId: identity.key.keyId,
					peerKeyId: channel.peerKey.keyId,
					peerLabel: channel.label,
				}),
				"utf8",
			);
			await channel.send(metadata);
			for (;;) {
				const message = await nextMessage();
				if (message === null) break;
				record.bytesReceived += message.length;
				await channel.send(message);
				record.bytesEchoed += message.length;
			}
		} catch {
			// A client close or fixture teardown ends this owned channel.
		} finally {
			stopMessages();
			try {
				await channel.close();
			} catch {
				// Already closed.
			}
		}
	};

	host = createPeerHost({
		identity,
		acceptedPeers,
		grants,
		onDiagnostic: recordDiagnostic,
		onPairingRequest: (request) => {
			const exactClient =
				request.peerKey.keyId === options.clientKeyId &&
				request.label === options.clientLabel;
			pairings.push({
				peerKeyId: request.peerKey.keyId,
				label: request.label,
				exactClient,
			});
			if (exactClient) {
				request.approve();
			} else {
				request.deny();
			}
		},
		onAppChannel: (channel) => {
			void serveChannel(channel, "app");
		},
		onContentChannel: (channel) => {
			void serveChannel(channel, "content");
		},
	});

	const bound = await host.listen({ host: options.listenHost, port: options.listenPort });
	process.stdout.write(
		`${JSON.stringify({
			event: "ready",
			mode: options.mode,
			hostKeyId: identity.key.keyId,
			hostFingerprint: identity.key.fingerprint,
			hostLabel: identity.label,
			host: bound.host,
			port: bound.port,
		})}\n`,
	);

	const report = async (): Promise<void> => {
		if (reported) return;
		reported = true;
		const current = host;
		if (current === null) return;
		const stats = { ...current.stats };
		const accepted = acceptedPeers.get(options.clientKeyId);
		const grant = grants.get(options.clientKeyId);
		const problems = evaluate(options, stats, pairings, channels, accepted, grant);
		const exitCode = problems.length === 0 ? 0 : 2;
		process.stdout.write(
			`${JSON.stringify({
				event: "report",
				ok: problems.length === 0,
				problems,
				mode: options.mode,
				clientKeyId: options.clientKeyId,
				clientLabel: options.clientLabel,
				hostKeyId: identity.key.keyId,
				hostFingerprint: identity.key.fingerprint,
				stats,
				pairings,
				channels,
				diagnostics: Object.fromEntries([...diagnostics.entries()].sort()),
				acceptedPresent: accepted !== undefined,
				grantPresent: grant !== undefined,
			})}\n`,
		);
		await current.close().catch(() => undefined);
		process.exit(exitCode);
	};

	if (optionalOption("report-on-stdin", "true") !== "false") {
		const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
		lines.on("line", (line) => {
			if (line.trim() === "report") void report();
		});
		lines.on("close", () => {
			void report();
		});
	}

	process.once("SIGTERM", () => {
		void report();
	});
	process.once("SIGINT", () => {
		void report();
	});
}

function evaluate(
	options: FixtureOptions,
	stats: PeerHost["stats"],
	pairings: readonly PairingRecord[],
	channels: readonly ChannelRecord[],
	accepted: AcceptedPeerRecord | undefined,
	grant: DirectionalGrantRecord | undefined,
): string[] {
	const problems: string[] = [];
	const wrongPairing = pairings.find((entry) => !entry.exactClient);
	if (wrongPairing !== undefined) problems.push("pairing request did not match the approved fixture key/label");
	const wrongChannel = channels.find(
		(entry) =>
			entry.peerKeyId !== options.clientKeyId ||
			entry.peerLabel !== options.clientLabel ||
			entry.bytesReceived <= 0 ||
			entry.bytesEchoed !== entry.bytesReceived,
	);
	if (wrongChannel !== undefined) problems.push("channel identity or binary echo did not match");

	if (options.mode === "mismatch") {
		if (stats.httpRequests !== 0) problems.push("mismatched-pin client wrote an HTTP request");
		if (stats.upgrades !== 0) problems.push("mismatched-pin client attempted an upgrade");
		if (stats.pairingRequests !== 0) problems.push("mismatched-pin client reached pairing");
		if (stats.appChannelsOpened !== 0) problems.push("mismatched-pin client opened a channel");
		if (channels.length !== 0) problems.push("mismatched-pin client produced a channel record");
		return problems;
	}

	if (stats.pairingRequests !== 1) problems.push("expected exactly one pairing request");
	if (stats.pairingAccepted !== 1) problems.push("pairing was not accepted");
	if (stats.pairingDenied !== 0 || stats.pairingFailed !== 0) problems.push("pairing was refused");
	if (accepted === undefined) problems.push("accepted peer record is absent");
	if (grant === undefined) problems.push("directional grant is absent");
	const lanes = channels.map((entry) => entry.lane).sort();
	if (lanes.join(",") !== "app,content") problems.push("both app and content lanes were not observed once");
	if (stats.appChannelsOpened !== 2) problems.push("expected exactly two opened channels");
	return problems;
}

if (require.main === module) {
	main().catch((error: unknown) => {
		process.stderr.write(
			`${JSON.stringify({
				event: "fixture_error",
				message: error instanceof Error ? error.message : "fixture failed",
			})}\n`,
		);
		process.exit(1);
	});
}
