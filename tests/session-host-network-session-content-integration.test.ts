/**
 * End-to-end coverage for the selected-session native viewport content channel
 * (#389) across the real paired peer transport, both real content endpoints, and
 * the real owning-host service.
 *
 * Real here: the `/app` TLS listener and WebSocket upgrade, the pairing accept
 * and its directional grant, both in-memory signed TLS identities, the ONE
 * `createLocalOwningHostService` and its ONE `InstanceManager`, that manager's
 * terminal surfaces, its status hook, its per-row viewer-geometry rule, and BOTH
 * content endpoints (`createSessionContentHost` and
 * `attachSessionContentViewer`) attached to channels the transport admitted.
 *
 * Synthetic, and deliberately so: the launch fixtures are descriptor-only. The
 * PTY is an in-memory `InstancePty` whose data/exit events the test drives, the
 * profile preparer is a pass-through over a temporary agent directory, and the
 * status registrar is in-memory. That is exactly the injection the real manager
 * already supports, so its own launch, surface, status, change-hook, geometry,
 * and viewer code all run unmodified while no real child process, agent
 * session, product listener, clipboard, or native platform feature is touched.
 * Every temporary directory is created under the owned OS temporary root and
 * removed here, the listener binds an ephemeral `127.0.0.1` port, and every key
 * is generated in memory.
 *
 * These tests do not restate the endpoints' unit contracts (the focused
 * endpoint tests own those). They assert the layer boundary: which lane an
 * authenticated content channel can reach, what the real manager's canonical
 * geometry actually becomes for two independent viewers of one row, that a
 * stale owner run is fenced before any owner-side mutation, how a whole native
 * viewport larger than one channel message crosses atomically, what a revoked
 * directional grant stops, and what a stopped or lost viewer can never
 * resurrect. Nothing here claims OS dual-stack behavior, a physical clipboard,
 * native Windows exchange, or process-level TLS certificates.
 */

import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { deflateSync } from "node:zlib";
import { normalizeNativeSourceInput } from "../src/session-host/input";
import { createRealKeybindingsManager, GEOMETRY_TUI, loadRealBridgeHost, REAL_IDENTITY_THEME, skipOrFail } from "./bridge-fakes";

import {
	createInMemoryDirectionalGrantStore,
	type DirectionalGrantStore,
	type OwnedPeerIdentity,
	type PeerByteChannel,
	type PeerClient,
} from "../src/session-host/network/index";
import {
	DEFAULT_INSTANCE_COLS,
	DEFAULT_INSTANCE_ROWS,
	InstanceManager,
	isNativeViewerStartupInputSource,
	type InstanceManagerOptions,
	type InstancePty,
	type InstanceSpawnDescriptor,
	type InstanceStatusHandlers,
	type InstanceStatusRegistration,
	type InstanceStatusUpdate,
	type PtyFactory,
	type StatusRegistrar,
} from "../src/session-host/instances";
import {
	encodeNativeClipboardOriginCapsule,
	type NativeClipboardEvent,
} from "../src/session-host/native-clipboard";
import {
	createNativeInputDecoder,
	NATIVE_INPUT_RAW_FRAGMENT_BYTES,
	NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES,
	type NativeInputDecoder,
	type NativeInputExpectedTuple,
	type NativeInputFragment,
	type NativeInputOrigin,
} from "../src/session-host/native-input-origin";
import type { PreparedProfile, ProfilePreparer } from "../src/session-host/profiles";
import {
	createLocalOwningHostService,
	type OwningHostManager,
	type OwningHostService,
} from "../src/session-host/owning-host-service";
import {
	createSessionContentHost,
	type SessionContentChannelBinding,
	type SessionContentHost,
	type SessionContentHostDiagnosticCode,
} from "../src/session-host/network/session-content-host";
import {
	attachSessionContentViewer,
	isSessionContentViewerError,
	type SessionContentViewer,
	type SessionContentViewerOptions,
} from "../src/session-host/network/session-content-client";
import {
	buildNativeInputInline,
	buildNativeInputPaste,
	DEFAULT_SESSION_CONTENT_BOUNDS,
	decodeSessionContentViewport,
	decodeSessionContentFrame,
	encodeSessionContentFrame,
	encodeSessionContentViewport,
	NATIVE_COPY_MAX_ENCODED_CHARS,
	NATIVE_TEXT_PASTE_MAX_BYTES,
	isNativeIoStartupSource,
	nativeIoSourceEquals,
	SESSION_CONTENT_MAJOR,
	SESSION_CONTENT_MINOR,
	SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY,
	SESSION_CONTENT_NATIVE_IO_CAPABILITY,
	SESSION_CONTENT_REQUIRED_CAPABILITY,
	SESSION_CONTENT_SERVICE,
	type NativeIoCompletedCopy,
	type NativeIoInputSource,
	type NativeIoSource,
	type SessionContentBeginFrame,
	type SessionContentErrorFrame,
	type SessionContentFrame,
	type SessionContentSnapshot,
} from "../src/session-host/network/session-content-protocol";
import {
	stripGeneratedSgr,
	type TerminalFrame,
	type TerminalSurface,
} from "../src/session-host/terminal-surface";
import {
	deferred,
	newIdentity,
	startClient,
	startHost,
	withTimeout,
	type HostFixture,
} from "./session-host-network-helpers";

/* ------------------------------------------------------------------------- *
 * Generated native viewport fixtures
 * ------------------------------------------------------------------------- */

/** One locally generated, structurally valid PNG payload plus its real size. */
interface GeneratedPng {
	readonly base64: string;
	readonly widthPx: number;
	readonly heightPx: number;
}

function crc32(input: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of input) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([typeBytes, data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/**
 * One RGBA PNG built here, never copied from a fixture: 8-bit colour type 6,
 * one filter byte per row, every chunk CRC computed locally. Noise payloads keep
 * their declared size incompressible so a whole viewport can be larger than one
 * channel message without any artificial ceiling on the content itself.
 */
function pngFromRaw(widthPx: number, heightPx: number, raw: Buffer): string {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(widthPx, 0);
	header.writeUInt32BE(heightPx, 4);
	header[8] = 8;
	header[9] = 6;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
}

function noiseImage(widthPx: number, heightPx: number): GeneratedPng {
	const stride = 1 + widthPx * 4;
	const pixels = randomBytes(widthPx * heightPx * 4);
	const raw = Buffer.alloc(heightPx * stride);
	for (let row = 0; row < heightPx; row += 1) {
		// PNG filter type 0 followed by the row's raw RGBA cells.
		raw[row * stride] = 0;
		pixels.copy(raw, row * stride + 1, row * widthPx * 4, (row + 1) * widthPx * 4);
	}
	return { base64: pngFromRaw(widthPx, heightPx, raw), widthPx, heightPx };
}

/**
 * One direct Kitty PNG transfer exactly as this surface's parser accepts it:
 * `a=T`, `f=100`, `C=1`, explicit cell footprint, and a payload-free fallback is
 * produced by the surface itself.
 */
function kittyTransfer(image: GeneratedPng, options: { readonly id: number; readonly columns: number; readonly rows: number }): string {
	return `\x1b_Ga=T,f=100,q=2,C=1,i=${options.id},c=${options.columns},r=${options.rows};${image.base64}\x1b\\`;
}

/**
 * The canonical form the protocol publishes for one captured native frame. The
 * expectation is produced by the codec's own viewport encoder from the real
 * surface's frame, so these assertions are about the transport and the two
 * endpoints, not about re-typing the fixture here.
 */
function canonicalFrame(frame: TerminalFrame): TerminalFrame {
	return decodeSessionContentViewport(encodeSessionContentViewport(frame));
}

function textOf(frame: TerminalFrame): string {
	return frame.lines.map((line) => stripGeneratedSgr(line)).join("\n");
}

/**
 * The one wall-clock wait in this file. The rule it covers is a negative — a
 * published, unchanged viewport must never expire — and "nothing happened over
 * time" can only be observed by letting time pass. Every other wait is driven by
 * a real event: a published snapshot, an owner diagnostic, or a settled closure.
 */
function observationWindow(ms: number): Promise<void> {
	return new Promise<void>((resolveWindow) => {
		setTimeout(resolveWindow, ms);
	});
}

/* ------------------------------------------------------------------------- *
 * Descriptor-only launch fixtures (copied here, local to this file)
 * ------------------------------------------------------------------------- */

function makeRoot(label: string): string {
	// Evidence stays outside the repository tree and is removed by this file.
	return realpathSync(mkdtempSync(join(realpathSync(process.env.TMPDIR ?? "/tmp"), `prg-389-net-${label}-`)));
}

function makePackageFixture(root: string): { packageRoot: string; piExecutable: string } {
	const packageRoot = join(root, "package");
	mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
	mkdirSync(join(packageRoot, "scripts"), { recursive: true });
	writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// Synthetic gate fixture; never imported.\n", "utf8");
	writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// Synthetic reporter fixture.\n", "utf8");
	writeFileSync(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// Synthetic preload fixture.\n", "utf8");
	// The launch descriptor pins the packaged skills the shipped launcher refreshes.
	for (const [skill, files] of [
		["pi-review-gate-orchestrator", ["SKILL.md", "references/recovery.md"]],
		["pi-review-gate-execution", ["SKILL.md"]],
		["pi-review-gate-research", ["SKILL.md"]],
		["pi-review-gate-completion", ["SKILL.md"]],
	] as const) {
		for (const file of files) {
			const path = join(packageRoot, "skills", skill, ...file.split("/"));
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, `${skill}/${file}\n`, "utf8");
		}
	}
	const piExecutable = join(root, "bin", "mock-pi");
	mkdirSync(join(piExecutable, ".."), { recursive: true });
	writeFileSync(piExecutable, "#!/usr/bin/env node\n\"use strict\";\n", "utf8");
	chmodSync(piExecutable, 0o755);
	return { packageRoot, piExecutable };
}

/** In-memory PTY: the manager's real data/exit wiring, driven by the test only. */
class SyntheticPty implements InstancePty {
	static #nextPid = 730_000;
	readonly pid: number;
	cols: number;
	rows: number;
	readonly spawnDescriptor: InstanceSpawnDescriptor;
	readonly resizeCalls: { cols: number; rows: number }[] = [];
	exited = false;
	#dataListeners: ((data: string) => void)[] = [];
	#exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];

	constructor(descriptor: InstanceSpawnDescriptor) {
		this.pid = SyntheticPty.#nextPid += 1;
		this.cols = descriptor.cols;
		this.rows = descriptor.rows;
		this.spawnDescriptor = descriptor;
	}

	onData(listener: (data: string) => void): { dispose(): void } {
		this.#dataListeners.push(listener);
		return { dispose: () => { this.#dataListeners = this.#dataListeners.filter((entry) => entry !== listener); } };
	}

	onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
		this.#exitListeners.push(listener);
		return { dispose: () => { this.#exitListeners = this.#exitListeners.filter((entry) => entry !== listener); } };
	}

	on(): void { /* the read-error channel is not exercised here */ }

	removeListener(): void { /* the read-error channel is not exercised here */ }

	write(): void { /* input bytes are not the subject of these cases */ }

	resize(columns: number, rows: number): void {
		this.resizeCalls.push({ cols: columns, rows });
		this.cols = columns;
		this.rows = rows;
	}

	kill(signal?: string): void {
		if (signal === "SIGKILL" || signal === "SIGTERM") this.emitExit(0);
	}

	pause(): void { /* not exercised */ }

	resume(): void { /* not exercised */ }

	/** Child output, through the manager's own PTY-data path. */
	emitData(data: string): void {
		for (const listener of [...this.#dataListeners]) listener(data);
	}

	emitExit(exitCode: number, signal?: number): void {
		if (this.exited) return;
		this.exited = true;
		for (const listener of [...this.#exitListeners]) listener({ exitCode, signal });
	}
}

/** Host role markers must never reach a synthetic launch descriptor. */
const HOST_ROLE_ENV_KEYS = ["PI_REVIEW_GATE_RUNTIME_ROLE", "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG"] as const;

function cleanTestEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of HOST_ROLE_ENV_KEYS) delete env[key];
	return env;
}

/** Descriptor-only preparer over a temporary agent directory. */
function syntheticPreparer(agentDir: string): ProfilePreparer {
	return {
		prepare(options: { workspace: string; profile?: string }): PreparedProfile {
			return {
				workspace: resolve(options.workspace),
				agentDir,
				created: false,
				release(): void { /* nothing is owned */ },
			};
		},
	};
}

function statusRegistrar(handlers: Map<string, InstanceStatusHandlers>): StatusRegistrar {
	return {
		register(instanceId: string, rowHandlers: InstanceStatusHandlers): InstanceStatusRegistration {
			handlers.set(instanceId, rowHandlers);
			return {
				bootstrap: {
					version: 1,
					socketPath: `/synthetic/${instanceId}.sock`,
					token: `tok-${randomUUID()}`,
					instanceId,
					generation: randomUUID(),
				},
				release(): void { /* nothing is owned */ },
			};
		},
	};
}

/* ------------------------------------------------------------------------- *
 * Owner-side observation of the real content channel
 * ------------------------------------------------------------------------- */

/**
 * Transparent tap over the channel the transport handed the owner. It records
 * only frames the owner actually handed to the socket and can hold transfer-body
 * frames, which is how a test produces a real mid-transfer write without
 * touching the endpoint's own serialized writer.
 */
class ContentWire implements PeerByteChannel {
	readonly sent: Buffer[] = [];
	readonly frames: SessionContentFrame[] = [];
	/** Hold `content_chunk` / `content_end` writes until released. */
	holdTransferBody = false;
	readonly #inner: PeerByteChannel;
	readonly #held: Array<{ bytes: Buffer; resolve: () => void; reject: (error: unknown) => void }> = [];
	readonly #holdWaiters: Array<() => void> = [];

	constructor(inner: PeerByteChannel) {
		this.#inner = inner;
	}

	get peerKey(): PeerByteChannel["peerKey"] {
		return this.#inner.peerKey;
	}

	get lane(): PeerByteChannel["lane"] {
		return this.#inner.lane;
	}

	get label(): string | null {
		return this.#inner.label;
	}

	get bufferedAmount(): number {
		return this.#inner.bufferedAmount;
	}

	get closed(): PeerByteChannel["closed"] {
		return this.#inner.closed;
	}

	get heldCount(): number {
		return this.#held.length;
	}

	send(bytes: Uint8Array): Promise<void> {
		const copy = Buffer.from(bytes);
		const frame = decodeSessionContentFrame(copy);
		if (this.holdTransferBody && (frame.type === "content_chunk" || frame.type === "content_end")) {
			for (const waiter of this.#holdWaiters.splice(0)) waiter();
			return new Promise<void>((resolveHold, rejectHold) => {
				this.#held.push({ bytes: copy, resolve: resolveHold, reject: rejectHold });
			});
		}
		this.#record(copy, frame);
		return this.#inner.send(copy);
	}

	/** Evidence that the owner reached a real mid-transfer write. */
	whenHolding(): Promise<void> {
		if (this.#held.length > 0) return Promise.resolve();
		return new Promise<void>((resolveHold) => {
			this.#holdWaiters.push(resolveHold);
		});
	}

	/**
	 * Forward what is held, one message at a time, then let later writes through.
	 * The endpoint's writer is serialized, so at most one frame is ever held; the
	 * sequential forward keeps the socket's own outbound-queue bound satisfied and
	 * lets the owner attempt its next protected write only after this one settles.
	 */
	releaseTransferBody(): void {
		const held = [...this.#held];
		this.#held.length = 0;
		this.holdTransferBody = false;
		const forward = (index: number): void => {
			const entry = held[index];
			if (entry === undefined) return;
			// Recorded at the moment the bytes are actually handed to the socket, so
			// the tap's frame order is the admitted write order and nothing held is
			// ever counted as delivered.
			this.#record(entry.bytes, decodeSessionContentFrame(entry.bytes));
			void this.#inner.send(entry.bytes).then(
				() => {
					entry.resolve();
					forward(index + 1);
				},
				(error: unknown) => {
					entry.reject(error);
					forward(index + 1);
				},
			);
		};
		forward(0);
	}

	close(): Promise<void> {
		return this.#inner.close();
	}

	onMessage(handler: (bytes: Buffer) => void): () => void {
		return this.#inner.onMessage(handler);
	}

	types(): readonly string[] {
		return this.frames.map((frame) => frame.type);
	}

	count(type: SessionContentFrame["type"]): number {
		return this.frames.filter((frame) => frame.type === type).length;
	}

	begins(): SessionContentBeginFrame[] {
		return this.frames.filter((frame): frame is SessionContentBeginFrame => frame.type === "content_begin");
	}

	#record(bytes: Buffer, frame: SessionContentFrame): void {
		this.sent.push(bytes);
		this.frames.push(frame);
	}
}

/**
 * Assert the owner's own write order across the whole channel: one transfer at a
 * time, chunks in order exactly once, and an end only after every declared chunk.
 * Nothing partial is ever published because nothing partial is ever admitted.
 */
function assertWholeTransfers(wire: ContentWire): void {
	let openTransfer: string | null = null;
	let nextIndex = 0;
	let declaredChunks = 0;
	for (const frame of wire.frames) {
		if (frame.type === "content_begin") {
			assert.equal(openTransfer, null, "a second transfer began before the first ended");
			openTransfer = frame.transferId;
			nextIndex = 0;
			declaredChunks = frame.chunkCount;
			continue;
		}
		if (frame.type === "content_chunk") {
			assert.notEqual(openTransfer, null, "a chunk arrived outside a transfer");
			assert.equal(frame.transferId, openTransfer, "a chunk never joins another transfer");
			assert.equal(frame.index, nextIndex, "transfer chunks arrive in order, exactly once");
			assert.ok(
				Buffer.from(frame.data, "base64").length <= DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes,
				"one chunk payload stays inside the declared chunk bound",
			);
			nextIndex += 1;
			continue;
		}
		if (frame.type === "content_end") {
			assert.notEqual(openTransfer, null, "a transfer ended without a begin");
			assert.equal(frame.transferId, openTransfer);
			assert.equal(nextIndex, declaredChunks, "every declared chunk arrived before the end");
			openTransfer = null;
		}
	}
	assert.equal(openTransfer, null, "every begun transfer ended");
	for (const bytes of wire.sent) {
		assert.ok(
			bytes.length <= DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes,
			`one channel message stays inside the declared message bound (${bytes.length} bytes)`,
		);
	}
}

/* ------------------------------------------------------------------------- *
 * Real owner fixture
 * ------------------------------------------------------------------------- */

interface ContentAttachment {
	readonly wire: ContentWire;
	readonly binding: SessionContentChannelBinding;
}

interface OwnerFixture {
	readonly root: string;
	readonly manager: InstanceManager;
	readonly service: OwningHostService;
	readonly contentHost: SessionContentHost;
	readonly host: HostFixture;
	/** The exact directional grant store the transport itself consults. */
	readonly grants: DirectionalGrantStore;
	/** The ONE run identity of this service/manager, read from the real service. */
	readonly hostRunId: string;
	readonly taps: ContentWire[];
	readonly attachments: ContentAttachment[];
	readonly appChannels: PeerByteChannel[];
	readonly ownerDiagnostics: SessionContentHostDiagnosticCode[];
	createRow(label: string): Promise<string>;
	emitStatus(id: string, update: InstanceStatusUpdate): void;
	ptyFor(id: string): SyntheticPty;
	surfaceFor(id: string): TerminalSurface;
	/** Feed child output through the manager's real PTY path and await its parse. */
	feed(id: string, chunks: readonly string[]): Promise<void>;
	/** Resolve with the next content channel the transport admits to the endpoint. */
	expectContentAttachment(): Promise<ContentAttachment>;
	/** Resolve with the next legacy `app` channel the transport admits. */
	expectAppChannel(): Promise<PeerByteChannel>;
	/** Resolve on the next owner diagnostic with this code (never a past one). */
	whenDiagnostic(code: SessionContentHostDiagnosticCode): Promise<void>;
}

async function startOwner(
	t: TestContext,
	options: { readonly cols?: number; readonly rows?: number } = {},
): Promise<OwnerFixture> {
	const root = makeRoot("owner");
	const pkg = makePackageFixture(root);
	const workspaceRoot = join(root, "workspaces");
	mkdirSync(workspaceRoot, { recursive: true });
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	// Legacy profile launches require the registry-owned config to exist; this
	// fixture never reads it, it only satisfies the launch descriptor's checks.
	writeFileSync(join(agentDir, "review-gate.json"), "{}\n", "utf8");

	// Each row gets its own workspace, which identifies its synthetic PTY exactly.
	const ptysByWorkspace = new Map<string, SyntheticPty>();
	const ptyFactory: PtyFactory = (descriptor) => {
		const pty = new SyntheticPty(descriptor);
		ptysByWorkspace.set(descriptor.cwd, pty);
		return pty;
	};
	// One in-memory status registrar, wired into the same manager this fixture
	// builds, so a status update travels the manager's real status path.
	const statusHandlers = new Map<string, InstanceStatusHandlers>();
	const registrar = statusRegistrar(statusHandlers);
	// The service wires its own observer through the manager's real change hook,
	// exactly as the production host does; this indirection lets the manager be
	// constructed before the service owns it.
	let managerChange: InstanceManagerOptions["onChange"];
	const manager = new InstanceManager({
		packageRoot: pkg.packageRoot,
		piExecutable: pkg.piExecutable,
		statusRegistrar: registrar,
		nativeSetup: false,
		profileRegistry: syntheticPreparer(agentDir),
		args: [],
		env: cleanTestEnv(),
		cols: options.cols ?? DEFAULT_INSTANCE_COLS,
		rows: options.rows ?? DEFAULT_INSTANCE_ROWS,
		getSupportedKeyboardFlags: () => 7,
		onChange: (instanceId) => managerChange?.(instanceId),
		ptyFactory,
	});
	const service = createLocalOwningHostService({
		createManager: (managerOptions) => {
			managerChange = managerOptions.onChange;
			return manager as unknown as OwningHostManager;
		},
		teardownRequested: () => false,
	});
	service.openManager({
		packageRoot: pkg.packageRoot,
		piExecutable: pkg.piExecutable,
		statusRegistrar: registrar,
	} as InstanceManagerOptions);

	const inventory = service.readInventorySnapshot();
	assert.ok(inventory, "the real owning-host service must observe its own manager run");
	const hostRunId = inventory.hostRunId;

	// The exact directional grant the TLS pairing commit records is the only
	// authorization policy this endpoint is given.
	const grants = createInMemoryDirectionalGrantStore();
	const taps: ContentWire[] = [];
	const attachments: ContentAttachment[] = [];
	const appChannels: PeerByteChannel[] = [];
	const ownerDiagnostics: SessionContentHostDiagnosticCode[] = [];
	const attachmentWaiters: Array<(attachment: ContentAttachment) => void> = [];
	const appWaiters: Array<(channel: PeerByteChannel) => void> = [];
	const diagnosticWaiters: Array<{ code: SessionContentHostDiagnosticCode; resolve: () => void }> = [];
	/** Owner diagnostics already consumed by a wait, per code. */
	const diagnosticConsumed = new Map<SessionContentHostDiagnosticCode, number>();

	const contentHost = createSessionContentHost({
		source: service,
		authorizePeer: (peerKey) => grants.get(peerKey.keyId) !== undefined,
		onDiagnostic: (event) => {
			ownerDiagnostics.push(event.code);
			const index = diagnosticWaiters.findIndex((waiter) => waiter.code === event.code);
			if (index < 0) return;
			const waiter = diagnosticWaiters.splice(index, 1)[0];
			diagnosticConsumed.set(event.code, (diagnosticConsumed.get(event.code) ?? 0) + 1);
			waiter?.resolve();
		},
	});

	const identity = await newIdentity("owner-host");
	const host = await startHost(t, {
		identity,
		grants,
		onPairingRequest: (request) => {
			request.approve();
		},
		onAppChannel: (channel) => {
			appChannels.push(channel);
			const waiter = appWaiters.shift();
			if (waiter !== undefined) waiter(channel);
		},
		onContentChannel: (channel) => {
			const wire = new ContentWire(channel);
			const attachment: ContentAttachment = { wire, binding: contentHost.attach(wire) };
			taps.push(wire);
			attachments.push(attachment);
			const waiter = attachmentWaiters.shift();
			if (waiter !== undefined) waiter(attachment);
		},
	});

	let counter = 0;
	const workspaceFor = (label: string): string => {
		counter += 1;
		const path = join(workspaceRoot, `${label}-${counter}`);
		mkdirSync(path, { recursive: true });
		return path;
	};
	const createRow = async (label: string): Promise<string> => {
		const id = await manager.create({ workspace: workspaceFor(label) });
		const view = service.readRow(id);
		assert.equal(view?.lifecycle, "alive", `the synthetic row launched (error: ${view?.error ?? "none"})`);
		return id;
	};
	const ptyFor = (id: string): SyntheticPty => {
		const view = service.readRow(id);
		assert.ok(view, `row ${id} is not listed`);
		const pty = ptysByWorkspace.get(view.workspace);
		assert.ok(pty, `no synthetic PTY was spawned for row ${id}`);
		return pty;
	};
	const surfaceFor = (id: string): TerminalSurface => {
		const surface = manager.surface(id);
		assert.ok(surface, `row ${id} has no terminal surface`);
		return surface;
	};
	const feed = async (id: string, chunks: readonly string[]): Promise<void> => {
		const pty = ptyFor(id);
		for (const chunk of chunks) pty.emitData(chunk);
		// The surface parses asynchronously; flush is the real completion signal
		// that its frame, modes, and change notification are observable.
		await surfaceFor(id).flush();
	};
	const close = async (): Promise<void> => {
		await contentHost.stopAll();
		await manager.dispose();
		rmSync(root, { recursive: true, force: true });
	};
	t.after(close);

	return {
		root,
		manager,
		service,
		contentHost,
		host,
		grants,
		hostRunId,
		taps,
		attachments,
		appChannels,
		ownerDiagnostics,
		createRow,
		emitStatus(id: string, update: InstanceStatusUpdate): void {
			const handlers = statusHandlers.get(id);
			assert.ok(handlers, `row ${id} has no live status registration`);
			handlers.onStatus(update);
		},
		ptyFor,
		surfaceFor,
		feed,
		expectContentAttachment(): Promise<ContentAttachment> {
			return new Promise<ContentAttachment>((resolveAttachment) => {
				attachmentWaiters.push(resolveAttachment);
			});
		},
		expectAppChannel(): Promise<PeerByteChannel> {
			return new Promise<PeerByteChannel>((resolveApp) => {
				appWaiters.push(resolveApp);
			});
		},
		whenDiagnostic(code: SessionContentHostDiagnosticCode): Promise<void> {
			return new Promise<void>((resolveDiagnostic) => {
				// A diagnostic the owner already recorded still satisfies this wait: the
				// owner's own write path, not this test's scheduling, decides when it
				// happens, and one wait consumes exactly one event.
				const recorded = ownerDiagnostics.filter((entry) => entry === code).length;
				const consumed = diagnosticConsumed.get(code) ?? 0;
				if (recorded > consumed) {
					diagnosticConsumed.set(code, consumed + 1);
					resolveDiagnostic();
					return;
				}
				diagnosticWaiters.push({ code, resolve: resolveDiagnostic });
			});
		},
	};
}

/* ------------------------------------------------------------------------- *
 * Real viewer fixture
 * ------------------------------------------------------------------------- */

interface ViewerFixture {
	readonly viewer: SessionContentViewer;
	readonly channel: PeerByteChannel;
	readonly client: PeerClient;
	readonly identity: OwnedPeerIdentity;
	readonly wire: ContentWire;
	readonly binding: SessionContentChannelBinding;
	readonly inbox: SnapshotInbox;
	readonly viewerDiagnostics: string[];
}

/**
 * Event-driven inbox over one viewer's snapshot callback. Waits are consumed in
 * order, so a snapshot that already arrived (a real possibility when two
 * channels share one owner row) is returned instead of being waited for again,
 * and a test never polls for one.
 */
interface SnapshotInbox {
	readonly events: Array<SessionContentSnapshot | undefined>;
	/** Every non-cleared publication this viewer ever received. */
	readonly published: number;
	onSnapshot(snapshot: SessionContentSnapshot | undefined): void;
	/** The next unconsumed whole viewport, already received or still arriving. */
	next(label: string): Promise<SessionContentSnapshot>;
	/** The next unconsumed cleared view, already received or still arriving. */
	nextClear(label: string): Promise<void>;
}

function snapshotInbox(): SnapshotInbox {
	const events: Array<SessionContentSnapshot | undefined> = [];
	const snapshotWaiters: Array<(snapshot: SessionContentSnapshot) => void> = [];
	const clearWaiters: Array<() => void> = [];
	/** Events before this index have already been consumed by a wait. */
	let cursor = 0;
	const settle = (): void => {
		while (snapshotWaiters.length > 0) {
			const index = events.findIndex((event, position) => position >= cursor && event !== undefined);
			if (index < 0) return;
			const snapshot = events[index];
			if (snapshot === undefined) return;
			cursor = index + 1;
			const waiter = snapshotWaiters.shift();
			if (waiter === undefined) return;
			waiter(snapshot);
		}
		while (clearWaiters.length > 0) {
			const index = events.findIndex((event, position) => position >= cursor && event === undefined);
			if (index < 0) return;
			cursor = index + 1;
			const waiter = clearWaiters.shift();
			if (waiter === undefined) return;
			waiter();
		}
	};
	return {
		events,
		get published(): number {
			return events.filter((event) => event !== undefined).length;
		},
		onSnapshot(snapshot: SessionContentSnapshot | undefined): void {
			events.push(snapshot);
			settle();
		},
		next(label: string): Promise<SessionContentSnapshot> {
			return withTimeout(
				new Promise<SessionContentSnapshot>((resolveSnapshot) => {
					snapshotWaiters.push(resolveSnapshot);
					settle();
				}),
				8_000,
				label,
			);
		},
		nextClear(label: string): Promise<void> {
			return withTimeout(
				new Promise<void>((resolveClear) => {
					clearWaiters.push(resolveClear);
					settle();
				}),
				8_000,
				label,
			);
		},
	};
}

async function connectViewer(
	t: TestContext,
	owner: OwnerFixture,
	options: {
		readonly label: string;
		readonly sessionId: string;
		readonly cols: number;
		readonly rows: number;
		/** Deliberately stale run for the fencing case; defaults to the real one. */
		readonly hostRunId?: string;
		readonly timeouts?: SessionContentViewerOptions["timeouts"];
		/** Hold the first transfer's body pages, for real mid-transfer backpressure. */
		readonly holdTransferBody?: boolean;
	},
): Promise<ViewerFixture> {
	const identity = await newIdentity(options.label);
	const clientFixture = startClient(t, identity);
	const paired = await clientFixture.client.pair({
		port: owner.host.port,
		approveServerKey: () => "accept",
	});
	assert.equal(paired.ok, true, `pairing ${options.label} must be accepted`);
	// The attachment waiter is registered first, so the owner's own binding is
	// observed rather than guessed from timing.
	const attachmentPromise = owner.expectContentAttachment();
	const channel = await clientFixture.client.connectApp({
		port: owner.host.port,
		lane: "content",
		approveServerKey: () => {
			throw new Error("the server key is already remembered");
		},
	});
	const attachment = await withTimeout(
		attachmentPromise,
		5_000,
		"the owner never attached a content binding for the admitted channel",
	);
	assert.equal(channel.lane, "content");
	if (options.holdTransferBody === true) attachment.wire.holdTransferBody = true;
	const inbox = snapshotInbox();
	const viewerDiagnostics: string[] = [];
	const viewer = attachSessionContentViewer({
		channel,
		hostRunId: options.hostRunId ?? owner.hostRunId,
		sessionId: options.sessionId,
		cols: options.cols,
		rows: options.rows,
		...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
		onSnapshot: (snapshot) => inbox.onSnapshot(snapshot),
		onDiagnostic: (event) => {
			viewerDiagnostics.push(event.code);
		},
	});
	t.after(async () => {
		await viewer.stop();
		await channel.close();
	});
	return {
		viewer,
		channel,
		client: clientFixture.client,
		identity,
		wire: attachment.wire,
		binding: attachment.binding,
		inbox,
		viewerDiagnostics,
	};
}

function errorFrameOf(wire: ContentWire): SessionContentErrorFrame {
	const frame = wire.frames.find((candidate): candidate is SessionContentErrorFrame => candidate.type === "error");
	if (frame === undefined) throw new Error("the owner never answered with a fixed error frame");
	return frame;
}

/* ------------------------------------------------------------------------- *
 * Cases
 * ------------------------------------------------------------------------- */

test("a paired content channel carries the complete native viewport while the legacy lane stays legacy", async (t) => {
	const owner = await startOwner(t);
	const row = await owner.createRow("viewed");
	const image = noiseImage(4, 4);

	// The manager's real status path supplies the allowlisted native tuple.
	owner.emitStatus(row, {
		busy: false,
		pendingInput: false,
		inputSurface: false,
		activity: [],
		nativeSession: { sessionId: "conversation-viewed", epoch: 4, name: "Viewed conversation" },
	});
	await owner.feed(row, [
		"\x1b[2J\x1b[H",
		// DECCKM, bracketed paste, and modifyOtherKeys=2: real non-default VT state.
		"\x1b[?1h\x1b[?2004h\x1b[>4;2m",
		"\x1b[1;38;5;196m世界文字 e\u0301\x1b[0m",
		`\x1b[3;1H${kittyTransfer(image, { id: 1, columns: 2, rows: 2 })}`,
	]);

	const surface = owner.surfaceFor(row);
	const expectedFrame = canonicalFrame(surface.frame());
	const expectedModes = surface.inputModes();
	const expectedGeometry = owner.service.readSessionGeometry(row);
	assert.ok(expectedGeometry, "the manager must report its own canonical geometry");
	assert.deepEqual(expectedGeometry, { cols: DEFAULT_INSTANCE_COLS, rows: DEFAULT_INSTANCE_ROWS, revision: 0 });
	assert.equal(expectedModes.applicationCursorKeys, true);
	assert.equal(expectedModes.bracketedPaste, true);
	assert.equal(expectedModes.modifyOtherKeys, 2);
	// 4x4 noise RGBA plus the styled text is well inside one channel message here;
	// the paging case below covers a viewport larger than one message.
	const expectedPayload = encodeSessionContentViewport(expectedFrame);
	assert.ok(expectedPayload.length < DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes);

	const fixture = await connectViewer(t, owner, {
		label: "viewer-one",
		sessionId: row,
		cols: DEFAULT_INSTANCE_COLS,
		rows: DEFAULT_INSTANCE_ROWS,
		// Narrow the in-flight transfer deadline so the idle-current rule below is
		// observable in a bounded window; nothing else changes.
		timeouts: { transferIdleTimeoutMs: 1_000 },
	});
	await withTimeout(fixture.viewer.ready, 5_000, "the viewer never received its exact subscribed acknowledgement");
	assert.equal(fixture.channel.peerKey.keyId, owner.host.identity.key.keyId,
		"the viewer's identity is the exact server key its TLS handshake verified");
	assert.equal(fixture.wire.peerKey.keyId, fixture.identity.key.keyId,
		"the owner's only identity for the channel is the TLS-verified viewer key");

	const snapshot = await fixture.inbox.next("the first complete native viewport");
	assert.equal(snapshot.meta.hostRunId, owner.hostRunId);
	assert.equal(snapshot.meta.sessionId, row);
	assert.deepEqual(snapshot.meta.nativeSession, { sessionId: "conversation-viewed", epoch: 4 });
	assert.deepEqual(snapshot.meta.geometry, expectedGeometry);
	assert.deepEqual(snapshot.meta.inputModes, expectedModes);
	assert.deepEqual(snapshot.frame, expectedFrame, "the complete native frame crosses unchanged");
	assert.deepEqual(snapshot.frame.cursor, surface.frame().cursor,
		"the generated cursor position crosses unchanged");
	assert.equal(snapshot.frame.cursor.visible, true);

	const visible = textOf(snapshot.frame);
	assert.ok(visible.includes("世界文字"), "Unicode text is preserved exactly");
	assert.ok(visible.includes("e\u0301"), "a combining mark is not normalized away");
	const runs = snapshot.frame.styles?.find((style) => style.line === 0)?.runs ?? [];
	const styled = runs.find((run) => run.startColumn === 0);
	assert.ok(styled !== undefined, "the generated style run for the first row crossed");
	assert.equal(styled.bold, true);
	assert.deepEqual(styled.fg, { mode: "palette", value: 196 });
	assert.equal(snapshot.frame.graphics?.images.length, 1);
	assert.equal(snapshot.frame.graphics?.images[0]?.base64.length, image.base64.length);
	assert.equal(snapshot.frame.graphics?.images[0]?.widthPx, image.widthPx);
	const placement = snapshot.frame.graphics?.placements[0];
	assert.ok(placement !== undefined);
	assert.deepEqual(placement.crop, { x: 0, y: 0, width: image.widthPx, height: image.heightPx });
	assert.equal(snapshot.frame.graphics?.fallbacks[0]?.id, placement.id,
		"the payload-free fallback travels with the placement it belongs to");

	// Owner-side write order and bounds for the whole channel.
	assertWholeTransfers(fixture.wire);
	assert.equal(fixture.wire.types()[0], "hello_ack");
	assert.equal(fixture.wire.types()[1], "subscribed");
	assert.equal(fixture.wire.types().at(-1), "content_end");
	assert.equal(fixture.wire.count("content_begin"), fixture.inbox.published,
		"one complete transfer per published viewport and nothing else");
	assert.equal(owner.contentHost.activeSubscriptionCount, 1);
	assert.equal(owner.contentHost.activeBindingCount, 1);
	assert.equal(owner.appChannels.length, 0,
		"the authenticated content connection never reached the legacy metadata receiver");

	// A default legacy channel from the same paired client still works, and it is
	// never mistaken for (or routed to) the content endpoint.
	const appWait = owner.expectAppChannel();
	const app = await fixture.client.connectApp({
		port: owner.host.port,
		approveServerKey: () => {
			throw new Error("the server key is already remembered");
		},
	});
	const serverApp = await withTimeout(appWait, 5_000, "the legacy app channel never reached its receiver");
	assert.equal(app.lane, "app");
	assert.equal(serverApp.lane, "app");
	assert.equal(owner.appChannels.length, 1, "the legacy connection reached the metadata receiver exactly once");
	assert.equal(owner.appChannels[0], serverApp, "the one metadata channel is this legacy connection");
	assert.equal(owner.contentHost.activeBindingCount, 1, "the legacy channel never reached the content endpoint");
	assert.equal(owner.taps.length, 1, "no content binding exists for the legacy lane");

	const legacyBytes: string[] = [];
	serverApp.onMessage((bytes) => {
		legacyBytes.push(bytes.toString("utf8"));
		void serverApp.send(bytes).catch(() => undefined);
	});
	const echoed = deferred<string>();
	app.onMessage((bytes) => echoed.resolve(bytes.toString("utf8")));
	await app.send(Buffer.from("legacy-metadata"));
	assert.equal(
		await withTimeout(echoed.promise, 5_000, "the legacy lane did not deliver its own bytes"),
		"legacy-metadata",
	);
	assert.deepEqual(legacyBytes, ["legacy-metadata"],
		"only legacy bytes reach the metadata receiver; authenticated content frames never do");
	assert.equal(owner.contentHost.activeSubscriptionCount, 1);
	await app.close();

	// An unchanged published viewport is still current after a window well past
	// the narrowed in-flight transfer deadline: publishing arms no expiry.
	const current = fixture.viewer.readSnapshot();
	await observationWindow(2_500);
	assert.equal(fixture.viewer.readSnapshot(), current, "an unchanged current viewport never expires");
	assert.equal(fixture.viewerDiagnostics.includes("content_rejected"), false);
	assert.equal(fixture.viewerDiagnostics.includes("channel_closed"), false);

	// ...and the subscription is still live, which a real publication proves.
	fixture.viewer.resize(78, 22);
	const resized = await fixture.inbox.next("the viewport at the viewer's new pane size");
	assert.deepEqual(resized.meta.geometry, { cols: 78, rows: 22, revision: 1 });
	assert.deepEqual(resized.meta.geometry, owner.service.readSessionGeometry(row),
		"only the manager's own canonical geometry reaches the wire");
	assert.equal(resized.frame.cols, 78);
	assert.equal(resized.frame.rows, 22);
});

test("two viewers of one owner row set independent minima at the real manager and a sibling row is untouched", async (t) => {
	const owner = await startOwner(t);
	const viewed = await owner.createRow("viewed");
	const sibling = await owner.createRow("sibling");
	await owner.feed(viewed, ["\x1b[2J\x1b[Hviewed first\n"]);
	await owner.feed(sibling, ["\x1b[2J\x1b[Hsibling-only-text\n"]);

	const viewedPty = owner.ptyFor(viewed);
	const siblingPty = owner.ptyFor(sibling);
	const siblingGeometry = owner.service.readSessionGeometry(sibling);
	const siblingFrameBefore = canonicalFrame(owner.surfaceFor(sibling).frame());

	const wide = await connectViewer(t, owner, {
		label: "viewer-wide",
		sessionId: viewed,
		cols: 100,
		rows: 40,
	});
	await withTimeout(wide.viewer.ready, 5_000, "the wide viewer never became ready");
	const wideFirst = await wide.inbox.next("the wide viewer's first viewport");
	assert.deepEqual(wideFirst.meta.geometry, { cols: 100, rows: 40, revision: 1 });
	assert.deepEqual(owner.service.readSessionGeometry(viewed), { cols: 100, rows: 40, revision: 1 });
	assert.deepEqual(viewedPty.resizeCalls, [{ cols: 100, rows: 40 }]);

	const narrow = await connectViewer(t, owner, {
		label: "viewer-narrow",
		sessionId: viewed,
		cols: 80,
		rows: 50,
	});
	await withTimeout(narrow.viewer.ready, 5_000, "the narrow viewer never became ready");
	const narrowFirst = await narrow.inbox.next("the narrow viewer's first viewport");
	const wideSecond = await wide.inbox.next("the wide viewer's updated geometry");

	// Columns and rows take their own minimum: 100x40 and 80x50 give 80x40.
	assert.deepEqual(narrowFirst.meta.geometry, { cols: 80, rows: 40, revision: 2 });
	assert.deepEqual(wideSecond.meta.geometry, { cols: 80, rows: 40, revision: 2 });
	assert.deepEqual(owner.service.readSessionGeometry(viewed), { cols: 80, rows: 40, revision: 2 });
	assert.deepEqual(viewedPty.resizeCalls, [{ cols: 100, rows: 40 }, { cols: 80, rows: 40 }]);
	assert.deepEqual(narrowFirst.meta.geometry, owner.service.readSessionGeometry(viewed));
	assert.equal(owner.service.readSessionViewers(viewed).length, 2,
		"both surfaces display the same row and neither owns it");
	assert.equal(owner.contentHost.activeSubscriptionCount, 2);

	// A sibling's change is captured for nobody: a same-channel ordering barrier
	// (the watched row's own change published afterwards) makes the absence real.
	// First, the sibling's own row is untouched by anything the viewers did above.
	assert.deepEqual(canonicalFrame(owner.surfaceFor(sibling).frame()), siblingFrameBefore,
		"viewing another row never changes this row's own content");
	await owner.feed(sibling, ["\x1b[2J\x1b[Hsibling changed again\n"]);
	// The sibling really did change: this is the baseline its row must still show
	// when the viewers on the other row close, so nothing overwrote or replaced it.
	const siblingFrameAfter = canonicalFrame(owner.surfaceFor(sibling).frame());
	assert.ok(textOf(siblingFrameAfter).includes("sibling changed again"));
	assert.equal(textOf(siblingFrameAfter).includes("sibling-only-text"), false,
		"the sibling baseline really is its new state, not its previous one");
	await owner.feed(viewed, ["\x1b[2J\x1b[Hviewed changed\n"]);
	const wideChanged = await wide.inbox.next("the watched row's change on the wide viewer");
	const narrowChanged = await narrow.inbox.next("the watched row's change on the narrow viewer");
	assert.ok(textOf(wideChanged.frame).includes("viewed changed"));
	assert.ok(textOf(narrowChanged.frame).includes("viewed changed"));
	for (const event of [...wide.inbox.events, ...narrow.inbox.events]) {
		if (event === undefined) continue;
		assert.equal(event.meta.sessionId, viewed, "no frame or row of an inactive session is ever published");
		assert.equal(textOf(event.frame).includes("sibling"), false);
	}

	// Closing one viewer recomputes the minima over the viewers that remain.
	await narrow.viewer.stop();
	await withTimeout(narrow.viewer.closed, 5_000, "the narrow viewer never finished stopping");
	const restored = await wide.inbox.next("the wide viewer's restored geometry");
	assert.deepEqual(restored.meta.geometry, { cols: 100, rows: 40, revision: 3 });
	assert.deepEqual(owner.service.readSessionGeometry(viewed), { cols: 100, rows: 40, revision: 3 });
	assert.deepEqual(viewedPty.resizeCalls, [{ cols: 100, rows: 40 }, { cols: 80, rows: 40 }, { cols: 100, rows: 40 }]);
	assert.equal(owner.contentHost.activeSubscriptionCount, 1);

	// Closing the last viewer keeps the last canonical size: no reset, no stop.
	const lastGeometry = owner.service.readSessionGeometry(viewed);
	const resizesBeforeLast = viewedPty.resizeCalls.length;
	await wide.viewer.stop();
	await withTimeout(wide.viewer.closed, 5_000, "the last viewer never finished stopping");
	// Client-local retirement is not proof that the owner's bounded close has
	// settled. Observe both actual owner bindings before asserting their registry.
	await withTimeout(Promise.all([narrow.binding.closed, wide.binding.closed]), 5_000,
		"the owner never confirmed retirement of both viewing surfaces");
	assert.deepEqual(owner.service.readSessionGeometry(viewed), lastGeometry,
		"the last viewer leaving keeps the row's last canonical size");
	assert.equal(viewedPty.resizeCalls.length, resizesBeforeLast, "no further resize is issued");
	assert.equal(viewedPty.exited, false, "the owned child keeps running");
	assert.equal(owner.contentHost.activeSubscriptionCount, 0);
	assert.equal(owner.contentHost.activeBindingCount, 0);

	// The inactive sibling row never contributed a dimension or a capture.
	assert.deepEqual(owner.service.readSessionGeometry(sibling), siblingGeometry);
	assert.deepEqual(siblingPty.resizeCalls, []);
	assert.deepEqual(canonicalFrame(owner.surfaceFor(sibling).frame()), siblingFrameAfter,
		"the sibling keeps exactly its own last observed native content");
	assert.deepEqual(owner.service.readSessionViewers(sibling), []);
});

test("a stale owner run is fenced before any owner viewer exists and the same run is served afterwards", async (t) => {
	const owner = await startOwner(t);
	const row = await owner.createRow("viewed");
	await owner.feed(row, ["\x1b[2J\x1b[Hcontent\n"]);
	const geometryBefore = owner.service.readSessionGeometry(row);
	const pty = owner.ptyFor(row);

	const stale = await connectViewer(t, owner, {
		label: "viewer-stale",
		sessionId: row,
		cols: 70,
		rows: 20,
		hostRunId: randomUUID(),
	});
	await assert.rejects(
		withTimeout(stale.viewer.ready, 5_000, "the stale owner run was never refused"),
		(error: unknown) => isSessionContentViewerError(error) && error.code === "unavailable",
	);
	await withTimeout(stale.viewer.closed, 5_000, "the refused viewer never retired");
	await withTimeout(owner.whenDiagnostic("run_changed"), 5_000, "the owner never recorded the stale run");

	// The refusal is observable strictly before owner-side mutation.
	assert.equal(owner.contentHost.activeSubscriptionCount, 0);
	assert.deepEqual(owner.service.readSessionViewers(row), [],
		"no viewing surface was registered for the stale run");
	assert.deepEqual(owner.service.readSessionGeometry(row), geometryBefore);
	assert.deepEqual(pty.resizeCalls, []);
	assert.deepEqual(stale.inbox.events, [], "a refused subscription never publishes content");
	assert.equal(stale.wire.count("content_begin"), 0);
	const refusal = errorFrameOf(stale.wire);
	assert.equal(refusal.code, "unavailable");
	assert.equal(refusal.subscriptionId, stale.viewer.subscriptionId);
	assert.deepEqual(stale.wire.types(), ["hello_ack", "error"]);

	// The same endpoint and run still serves an exact request, and the manager's
	// first viewer allocation is this subscription's own: nothing was allocated
	// and abandoned for the refused run.
	const exact = await connectViewer(t, owner, {
		label: "viewer-exact",
		sessionId: row,
		cols: 70,
		rows: 20,
	});
	await withTimeout(exact.viewer.ready, 5_000, "the exact owner run was refused");
	const snapshot = await exact.inbox.next("the exact-run viewport");
	assert.equal(snapshot.meta.hostRunId, owner.hostRunId);
	assert.deepEqual(snapshot.meta.geometry, { cols: 70, rows: 20, revision: 1 });
	const viewers = owner.service.readSessionViewers(row);
	assert.deepEqual(viewers.map((viewer) => viewer.viewerId), ["viewer-1"],
		"the manager's first viewer allocation belongs to the accepted subscription");
	assert.deepEqual(owner.service.readSessionGeometry(row), { cols: 70, rows: 20, revision: 1 });
	assert.equal(owner.contentHost.activeSubscriptionCount, 1);
});

test("a viewport larger than one channel message crosses as atomic pages and keeps only the newest in-flight change", async (t) => {
	const owner = await startOwner(t);
	const row = await owner.createRow("viewed");
	const firstImage = noiseImage(200, 200);
	const newestImage = noiseImage(150, 120);

	assert.deepEqual(
		{
			frame: DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes,
			transfer: DEFAULT_SESSION_CONTENT_BOUNDS.maxTransferBytes,
			chunk: DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes,
		},
		{ frame: 65_536, transfer: 64 * 1024 * 1024, chunk: 32_768 },
		"the declared content bounds are the full-frame / per-message / chunk contract",
	);

	await owner.feed(row, [
		"\x1b[2J\x1b[H",
		"\x1b[?2004h",
		"\x1b[1;38;2;10;20;30mfirst-pass\u0301 text\x1b[0m",
		`\x1b[2;1H${kittyTransfer(firstImage, { id: 1, columns: 4, rows: 2 })}`,
	]);
	const surface = owner.surfaceFor(row);
	const firstPayload = encodeSessionContentViewport(surface.frame());
	assert.ok(
		firstPayload.length > DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes,
		`the whole viewport must need more than one channel message (${firstPayload.length} bytes)`,
	);
	const untouchedGeometry = owner.service.readSessionGeometry(row);

	const fixture = await connectViewer(t, owner, {
		label: "viewer-paged",
		sessionId: row,
		cols: DEFAULT_INSTANCE_COLS,
		rows: DEFAULT_INSTANCE_ROWS,
		holdTransferBody: true,
	});
	await withTimeout(fixture.viewer.ready, 5_000, "the paged viewer never became ready");
	// Evidence that the owner really reached a mid-transfer page write.
	await withTimeout(fixture.wire.whenHolding(), 5_000, "the owner never reached the first paged transfer");

	// Two real source updates land while the one writer is held; only the newest
	// is retained, and neither is allowed to rewrite the transfer already begun.
	await owner.feed(row, [
		"\x1b[2J\x1b[H",
		"\x1b[?1h",
		"\x1b[1;4mintermediate-pass text\x1b[0m",
	]);
	await owner.feed(row, [
		"\x1b[2J\x1b[H",
		"\x1b[?2004l",
		"\x1b[1;53;38;5;200mnewest-pass text\x1b[0m",
		// Reuses image id 1 on purpose: a same-id transfer replaces the cached image
		// and its placement, which is what makes the newest frame carry exactly the
		// new PNG. (CSI 2J clears text but does not invalidate Kitty placements in
		// the normal buffer, so a second id would leave the first image enumerated.)
		`\x1b[2;1H${kittyTransfer(newestImage, { id: 1, columns: 4, rows: 2 })}`,
	]);
	await withTimeout(
		owner.whenDiagnostic("viewport_pending_replaced"),
		5_000,
		"the owner never retained a newer snapshot while its writer was held",
	);
	assert.deepEqual(fixture.inbox.events, [], "nothing is published before a whole transfer ends");
	assert.equal(fixture.wire.count("content_end"), 0, "no transfer end is admitted while the body is held");

	const currentFrame = canonicalFrame(surface.frame());
	const currentModes = surface.inputModes();
	fixture.wire.releaseTransferBody();
	const first = await fixture.inbox.next("the first paged viewport");
	const second = await fixture.inbox.next("the newest retained viewport");

	// The first publication is the whole first state, not a mixture with the
	// updates that arrived during its transfer.
	assert.ok(textOf(first.frame).includes("first-pass"));
	assert.equal(textOf(first.frame).includes("newest-pass"), false);
	assert.deepEqual(first.meta.geometry, untouchedGeometry);
	assert.equal(first.meta.inputModes.bracketedPaste, true);
	assert.equal(first.meta.inputModes.applicationCursorKeys, false);
	assert.equal(first.frame.graphics?.images[0]?.widthPx, firstImage.widthPx);
	assert.equal(first.frame.graphics?.images[0]?.heightPx, firstImage.heightPx);

	// The second publication is entirely the newest state: frame, geometry, input
	// modes, and native tuple all agree with the one manager and surface.
	assert.ok(textOf(second.frame).includes("newest-pass"));
	assert.equal(textOf(second.frame).includes("intermediate-pass"), false);
	assert.deepEqual(second.frame, currentFrame, "the retained viewport is the whole newest native frame");
	assert.deepEqual(second.meta.geometry, owner.service.readSessionGeometry(row));
	assert.deepEqual(second.meta.inputModes, currentModes);
	assert.equal(second.meta.inputModes.applicationCursorKeys, true);
	assert.equal(second.meta.inputModes.bracketedPaste, false);
	assert.equal(second.frame.graphics?.images[0]?.widthPx, newestImage.widthPx);
	assert.equal(second.frame.graphics?.images[0]?.heightPx, newestImage.heightPx);
	assert.equal(second.frame.graphics?.images.length, 1, "the newest frame carries exactly one PNG image");
	assert.equal(second.frame.graphics?.placements.length, 1);
	assert.equal(fixture.inbox.published, 2, "one in-flight transfer plus one newest pending, nothing else");

	// Atomic paging at the real socket: every message inside the per-message
	// bound, more than one page per viewport, chunk order exact, end only last.
	assertWholeTransfers(fixture.wire);
	const begins = fixture.wire.begins();
	assert.equal(begins.length, 2);
	assert.equal(fixture.wire.count("content_end"), 2);
	assert.equal(fixture.wire.count("content_begin"), fixture.inbox.published);
	for (const begin of begins) {
		assert.ok(begin.byteLength > DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes,
			`each whole viewport payload exceeds one message (${begin.byteLength} bytes)`);
		assert.ok(begin.chunkCount > 1, "each viewport is carried by more than one page");
		assert.equal(begin.chunkCount, Math.ceil(begin.byteLength / DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes));
	}
});

test("a revoked directional grant stops protected publication and releases only that viewer", async (t) => {
	const owner = await startOwner(t);
	const row = await owner.createRow("viewed");
	const sibling = await owner.createRow("sibling");
	await owner.feed(row, [
		"\x1b[2J\x1b[H",
		"\x1b[1;38;5;33mgranted view\u0301\x1b[0m",
		`\x1b[2;1H${kittyTransfer(noiseImage(180, 180), { id: 1, columns: 4, rows: 2 })}`,
	]);
	await owner.feed(sibling, ["\x1b[2J\x1b[Hsibling stays running\n"]);
	const geometry = owner.service.readSessionGeometry(row);
	const siblingGeometry = owner.service.readSessionGeometry(sibling);
	const pty = owner.ptyFor(row);
	const siblingPty = owner.ptyFor(sibling);

	const fixture = await connectViewer(t, owner, {
		label: "viewer-revoked",
		sessionId: row,
		cols: DEFAULT_INSTANCE_COLS,
		rows: DEFAULT_INSTANCE_ROWS,
		holdTransferBody: true,
	});
	await withTimeout(fixture.viewer.ready, 5_000, "the revoked viewer never became ready");
	await withTimeout(fixture.wire.whenHolding(), 5_000, "the owner never reached a mid-transfer page write");
	assert.equal(fixture.wire.count("content_end"), 0);

	// The endpoint's only policy is the transport's own directional grant, so
	// deleting that exact grant is what its next protected write observes. The
	// already-open channel stays open: revocation is an authorization fact here.
	assert.equal(owner.grants.delete(fixture.identity.key.keyId), true);
	fixture.wire.releaseTransferBody();

	await withTimeout(owner.whenDiagnostic("authorization_refused"), 5_000,
		"the owner never observed the revoked grant");
	await withTimeout(fixture.viewer.closed, 5_000, "the viewer never retired after the revocation");

	// No further page and no end: the transfer that had begun is abandoned whole,
	// so nothing is ever published from it.
	assert.equal(fixture.wire.count("content_begin"), 1);
	assert.equal(fixture.wire.count("content_end"), 0);
	assert.equal(errorFrameOf(fixture.wire).code, "not_authorized");
	assert.deepEqual(fixture.inbox.events, [], "a partial transfer is never published");
	assert.equal(fixture.viewer.readSnapshot(), undefined);

	// Only this endpoint's own viewer was released; no row was stopped or resized.
	assert.deepEqual(owner.service.readSessionViewers(row), []);
	assert.equal(owner.contentHost.activeSubscriptionCount, 0);
	assert.deepEqual(owner.service.readSessionGeometry(row), geometry);
	assert.deepEqual(pty.resizeCalls, []);
	assert.deepEqual(owner.service.readRow(row)?.lifecycle, "alive");
	assert.equal(owner.service.readRow(row)?.hasLiveProcess, true);
	assert.equal(pty.exited, false);
	assert.deepEqual(owner.service.readSessionGeometry(sibling), siblingGeometry);
	assert.deepEqual(siblingPty.resizeCalls, []);
	assert.deepEqual(owner.service.readRow(sibling)?.lifecycle, "alive");
});

test("a stopped or disconnected viewer drops its view immediately and can never be resurrected", async (t) => {
	const owner = await startOwner(t);
	const row = await owner.createRow("viewed");
	await owner.feed(row, ["\x1b[2J\x1b[Hfirst view\n"]);
	const pty = owner.ptyFor(row);

	const stopped = await connectViewer(t, owner, {
		label: "viewer-stop",
		sessionId: row,
		cols: 72,
		rows: 22,
	});
	await withTimeout(stopped.viewer.ready, 5_000, "the stopping viewer never became ready");
	const published = await stopped.inbox.next("the viewport before stop");
	assert.deepEqual(published.meta.geometry, { cols: 72, rows: 22, revision: 1 });

	const stopping = stopped.viewer.stop();
	assert.equal(stopped.viewer.readSnapshot(), undefined, "stop clears the current view synchronously");
	await withTimeout(stopping, 5_000, "the viewer never finished stopping");
	await withTimeout(stopped.viewer.closed, 5_000, "the stopped viewer never settled its closure");
	await withTimeout(stopped.binding.closed, 5_000, "the owner never finished the stopped subscription");

	assert.equal(owner.contentHost.activeSubscriptionCount, 0);
	assert.deepEqual(owner.service.readSessionViewers(row), []);

	// A retired viewer's local calls are inert: no write can restart delivery.
	const framesAfterStop = stopped.wire.frames.length;
	stopped.viewer.resize(60, 20);
	await withTimeout(stopped.viewer.stop(), 5_000, "a repeated stop never settled");
	assert.equal(stopped.wire.frames.length, framesAfterStop, "a retired viewer never writes again");
	assert.equal(stopped.inbox.published, 1);

	// A later real change lands while only the retired viewer's channel is gone;
	// it is never delivered to that viewer's callback.
	await owner.feed(row, ["\x1b[2J\x1b[Hafter stop\n"]);
	assert.equal(stopped.inbox.published, 1, "the retired viewer's snapshot callback never ran again");
	assert.deepEqual(owner.service.readSessionGeometry(row), { cols: 72, rows: 22, revision: 1 },
		"the stopped viewer's last canonical size is kept");
	assert.deepEqual(pty.resizeCalls, [{ cols: 72, rows: 22 }]);
	assert.equal(owner.service.readRow(row)?.lifecycle, "alive");

	// Transport loss: a fresh viewer loses the current view the moment its
	// channel dies, and the owner releases only that subscription's resources.
	const lost = await connectViewer(t, owner, {
		label: "viewer-loss",
		sessionId: row,
		cols: 72,
		rows: 22,
	});
	await withTimeout(lost.viewer.ready, 5_000, "the losing viewer never became ready");
	const beforeLoss = await lost.inbox.next("the viewport before transport loss");
	assert.deepEqual(beforeLoss.meta.geometry, { cols: 72, rows: 22, revision: 1 });
	const cleared = lost.inbox.nextClear("the cleared view on transport loss");
	await lost.channel.close();
	await withTimeout(cleared, 5_000, "the lost channel never cleared the current view");
	assert.equal(lost.viewer.readSnapshot(), undefined, "a lost channel drops the current view immediately");
	await withTimeout(lost.viewer.closed, 5_000, "the viewer never settled after the channel was lost");
	await withTimeout(lost.binding.closed, 5_000, "the owner never finished the lost subscription");

	assert.equal(owner.contentHost.activeBindingCount, 0);
	assert.equal(owner.contentHost.activeSubscriptionCount, 0);
	assert.deepEqual(owner.service.readSessionViewers(row), []);

	// Nothing about the still-running row changes, and no late owner change can
	// resurrect the lost subscription.
	await owner.feed(row, ["\x1b[2J\x1b[Hafter loss\n"]);
	assert.equal(owner.contentHost.activeSubscriptionCount, 0);
	assert.equal(lost.inbox.published, 1, "the lost viewer never publishes again");
	assert.deepEqual(owner.service.readSessionGeometry(row), { cols: 72, rows: 22, revision: 1 });
	assert.deepEqual(pty.resizeCalls, [{ cols: 72, rows: 22 }]);
	assert.equal(pty.exited, false);
	assert.equal(owner.service.readRow(row)?.hasLiveProcess, true);
});

/* ------------------------------------------------------------------------- *
 * Real native input / text-copy acceptance over the real content lane
 * ------------------------------------------------------------------------- */

/**
 * EVIDENCE SCOPE for the three cases below, stated once because "native" and
 * "copy" invite over-claiming.
 *
 * Real here: the `/app` TLS listener and WebSocket upgrade, the pairing accept
 * and the one directional grant it records, both in-memory signed TLS
 * identities, ONE `createLocalOwningHostService` over ONE `InstanceManager` in
 * native setup with the closed `nativeInputOriginFraming` opt-in, that
 * manager's real terminal surfaces, real status path, real per-row
 * viewer-geometry rule, real `readViewerInputSource` / `writeViewerInput`
 * fences, real scope-token minting and verification, real input framing and
 * HMAC, real OSC 777 capsule verification, and BOTH content endpoints with the
 * native IO capability actually negotiated in the hello.
 *
 * Synthetic, and deliberately so: the child is an in-memory PTY whose stdout
 * this test drives, and its input-framing readiness and copy capsules are
 * encoded here with that registration's own bootstrap key. These are therefore
 * LEVEL1 real-transport acceptance cases against the settled public contracts.
 * They make no claim about a real native Pi process or the order in which its
 * decoder installs, a physical OS clipboard, Main-side proof, cross-machine or
 * mobile behavior, native Windows exchange, or real-native CLI acceptance.
 */

const NATIVE_READY_PREFIX = "prg-native-input-ready-v1;";
const NATIVE_READY_DOMAIN = "pi-review-gate/native-input-ready/v1\0";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const COPY_FRAME_TYPES: readonly SessionContentFrame["type"][] = ["copy", "copy_begin", "copy_chunk", "copy_end"];

/** The private capsule OSC the strict child bridge writes on the same stdout. */
const capsuleOsc = (capsule: string): string => `\x1b]777;${capsule}\x07`;

/** Re-derives this registration's child-side readiness wire format. */
function nativeReadyCapsule(bootstrap: InstanceStatusRegistration["bootstrap"]): string {
	const body = JSON.stringify({
		version: 1,
		kind: "input-framing-ready",
		instanceId: bootstrap.instanceId,
		generation: bootstrap.generation,
	});
	const encoded = Buffer.from(body, "utf8").toString("base64");
	const mac = createHmac("sha256", Buffer.from(bootstrap.token, "hex"))
		.update(NATIVE_READY_DOMAIN)
		.update(encoded)
		.digest("hex");
	return `${NATIVE_READY_PREFIX}${encoded};${mac}`;
}

/** One authentic v2 copy capsule for this registration, on the child's stdout. */
function nativeCopyCapsule(
	bootstrap: InstanceStatusRegistration["bootstrap"],
	sequence: number,
	event: NativeClipboardEvent,
	origin: { readonly kind: "local" } | { readonly kind: "viewer"; readonly token: string },
	dispatchId: number,
): string {
	return capsuleOsc(encodeNativeClipboardOriginCapsule(bootstrap, sequence, event, { origin, dispatchId }));
}

function copyEventOf(text: string, sessionId: string, sessionEpoch: number): NativeClipboardEvent {
	return { kind: "copy", encoded: Buffer.from(text, "utf8").toString("base64"), sessionId, sessionEpoch };
}

/** Mixed-Unicode text of exactly `byteLength` decoded UTF-8 bytes. */
function pasteBodyOf(byteLength: number): string {
	const unit = "世界 café \u{1f5a5} line\r\n";
	const unitBytes = Buffer.byteLength(unit, "utf8");
	const parts: string[] = [];
	let remaining = byteLength;
	while (remaining >= unitBytes) {
		parts.push(unit);
		remaining -= unitBytes;
	}
	parts.push("x".repeat(remaining));
	const text = parts.join("");
	assert.equal(Buffer.byteLength(text, "utf8"), byteLength, "the paste body is exactly its declared byte count");
	return text;
}

/**
 * Transparent tap over one content channel, used in either direction: it
 * records only the frames THIS side actually handed to the socket, can hold
 * copy frames and input pages to produce a real mid-write stall, and resolves
 * waits from its own record instead of polling.
 */
class NativeWire implements PeerByteChannel {
	readonly sent: Buffer[] = [];
	readonly frames: SessionContentFrame[] = [];
	/** Hold every copy frame this side would write until {@link releaseHeld}. */
	holdCopyBody = false;
	/**
	 * Hold `copy_chunk` pages at or after this index while letting the begin frame
	 * and the earlier pages through: a copy interrupted in the middle of its body,
	 * which is when an owner-known revocation or a lost transport matters.
	 */
	holdCopyChunkFrom: number | null = null;
	/**
	 * Make the held writes released next FAIL instead of complete: the owner's own
	 * `channel.send()` rejects, which is how a transport that died mid-transfer
	 * reaches an endpoint. Bytes that fail are never recorded as delivered.
	 */
	failHeldOnRelease: Error | null = null;
	/** Hold `input_chunk` pages at or after this index; `null` holds none. */
	holdInputChunkFrom: number | null = null;
	readonly #inner: PeerByteChannel;
	readonly #held: { bytes: Buffer; resolve: () => void; reject: (error: unknown) => void }[] = [];
	readonly #holdWaiters: Array<() => void> = [];
	readonly #frameWaiters: Array<{ type: SessionContentFrame["type"]; resolve: (frame: SessionContentFrame) => void }> = [];
	/** Frames already consumed by a {@link nextFrame} wait. */
	#consumed = 0;

	constructor(inner: PeerByteChannel) {
		this.#inner = inner;
	}

	get peerKey(): PeerByteChannel["peerKey"] {
		return this.#inner.peerKey;
	}

	get lane(): PeerByteChannel["lane"] {
		return this.#inner.lane;
	}

	get label(): string | null {
		return this.#inner.label;
	}

	get bufferedAmount(): number {
		return this.#inner.bufferedAmount;
	}

	get closed(): PeerByteChannel["closed"] {
		return this.#inner.closed;
	}

	get heldCount(): number {
		return this.#held.length;
	}

	send(bytes: Uint8Array): Promise<void> {
		const copy = Buffer.from(bytes);
		const frame = decodeSessionContentFrame(copy);
		if (this.#shouldHold(frame)) {
			for (const waiter of this.#holdWaiters.splice(0)) waiter();
			return new Promise<void>((resolveHold, rejectHold) => {
				this.#held.push({ bytes: copy, resolve: resolveHold, reject: rejectHold });
			});
		}
		this.#record(copy, frame);
		return this.#inner.send(copy);
	}

	close(): Promise<void> {
		return this.#inner.close();
	}

	onMessage(handler: (bytes: Buffer) => void): () => void {
		return this.#inner.onMessage(handler);
	}

	types(): readonly SessionContentFrame["type"][] {
		return this.frames.map((frame) => frame.type);
	}

	count(type: SessionContentFrame["type"]): number {
		return this.frames.filter((frame) => frame.type === type).length;
	}

	framesOf<T extends SessionContentFrame["type"]>(type: T): Extract<SessionContentFrame, { type: T }>[] {
		return this.frames.filter(
			(frame): frame is Extract<SessionContentFrame, { type: T }> => frame.type === type,
		);
	}

	/** Evidence that this side really reached a protected write. */
	whenHolding(): Promise<void> {
		if (this.#held.length > 0) return Promise.resolve();
		return new Promise<void>((resolveHold) => {
			this.#holdWaiters.push(resolveHold);
		});
	}

	/**
	 * Forward what is held, one message at a time in the order it was attempted,
	 * then let later writes through. The endpoint's writer is serialized, so the
	 * socket's own outbound bound stays satisfied and the endpoint attempts its
	 * NEXT protected write only after this one settles.
	 */
	releaseHeld(): void {
		const held = [...this.#held];
		this.#held.length = 0;
		this.holdCopyBody = false;
		this.holdCopyChunkFrom = null;
		this.holdInputChunkFrom = null;
		const failure = this.failHeldOnRelease;
		this.failHeldOnRelease = null;
		const forward = (index: number): void => {
			const entry = held[index];
			if (entry === undefined) return;
			if (failure !== null) {
				// The transport went down: these bytes never reached the peer, so they
				// are not recorded and the writer is told the truth about them.
				entry.reject(failure);
				forward(index + 1);
				return;
			}
			// Recorded when the bytes are actually handed over, so nothing held is ever
			// counted as delivered and the frame order is the admitted write order.
			this.#record(entry.bytes, decodeSessionContentFrame(entry.bytes));
			void this.#inner.send(entry.bytes).then(
				() => {
					entry.resolve();
					forward(index + 1);
				},
				(error: unknown) => {
					entry.reject(error);
					forward(index + 1);
				},
			);
		};
		forward(0);
	}

	/** The next frame of this type this side wrote, already written or still to come. */
	nextFrame(type: SessionContentFrame["type"], label: string): Promise<SessionContentFrame> {
		return withTimeout(
			new Promise<SessionContentFrame>((resolveFrame) => {
				this.#frameWaiters.push({ type, resolve: resolveFrame });
				this.#settleFrameWaiters();
			}),
			8_000,
			label,
		);
	}

	#shouldHold(frame: SessionContentFrame): boolean {
		if (this.holdCopyBody && COPY_FRAME_TYPES.includes(frame.type)) return true;
		if (this.holdCopyChunkFrom !== null
			&& frame.type === "copy_chunk"
			&& frame.index >= this.holdCopyChunkFrom) return true;
		return this.holdInputChunkFrom !== null && frame.type === "input_chunk" && frame.index >= this.holdInputChunkFrom;
	}

	#record(bytes: Buffer, frame: SessionContentFrame): void {
		this.sent.push(bytes);
		this.frames.push(frame);
		this.#settleFrameWaiters();
	}

	#settleFrameWaiters(): void {
		for (;;) {
			const wanted = this.#frameWaiters[0];
			if (wanted === undefined) return;
			const index = this.frames.findIndex(
				(frame, position) => position >= this.#consumed && frame.type === wanted.type,
			);
			if (index < 0) return;
			this.#frameWaiters.shift();
			this.#consumed = index + 1;
			wanted.resolve(this.frames[index]);
		}
	}
}

function lastFrameOfType<T extends SessionContentFrame["type"]>(
	wire: NativeWire,
	type: T,
): Extract<SessionContentFrame, { type: T }> | undefined {
	const frames = wire.framesOf(type);
	return frames[frames.length - 1];
}

function nativeErrorFrameOf(wire: NativeWire): SessionContentErrorFrame {
	const frame = wire.frames.find((candidate): candidate is SessionContentErrorFrame => candidate.type === "error");
	if (frame === undefined) throw new Error("the owner never answered with a fixed error frame");
	return frame;
}

/** Every channel message this side wrote stays inside the declared bound. */
function assertNativeMessagesInsideBound(...wires: NativeWire[]): void {
	for (const wire of wires) {
		for (const bytes of wire.sent) {
			assert.ok(
				bytes.length <= DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes,
				`one channel message stays inside the declared message bound (${bytes.length} bytes)`,
			);
		}
	}
}

/** One logical host dispatch, verified with this registration's own decoder. */
interface NativeDispatch {
	readonly dispatchId: number;
	readonly origin: NativeInputOrigin;
	readonly expectedNativeTuple: NativeInputExpectedTuple | undefined;
	readonly expectedNativePhase: NativeInputFragment["expectedNativePhase"];
	readonly fragments: readonly NativeInputFragment[];
	readonly payload: Buffer;
}

/**
 * Independent reader of the framed bytes the manager actually handed the child:
 * the expectation is re-derived from this registration's own decoder rather than
 * from the manager's private state, and every write must authenticate.
 */
function nativeDispatchReader(
	decoder: NativeInputDecoder,
): (writes: readonly (string | Buffer)[]) => readonly NativeDispatch[] {
	const dispatches: NativeDispatch[] = [];
	let fed = 0;
	let open: NativeInputFragment[] = [];
	return (writes) => {
		while (fed < writes.length) {
			const framed = writes[fed];
			fed += 1;
			const outcome = decoder.feed(framed);
			assert.equal(outcome.ok, true, `every host write authenticates on this registration: ${outcome.ok ? "" : outcome.code}`);
			for (const fragment of outcome.fragments) {
				open.push(fragment);
				if (!fragment.end) continue;
				const first = open[0];
				assert.ok(first !== undefined, "a completed dispatch carries its first fragment");
				dispatches.push(Object.freeze({
					dispatchId: first.dispatchId,
					origin: first.origin,
					expectedNativeTuple: first.expectedNativeTuple,
					expectedNativePhase: first.expectedNativePhase,
					fragments: Object.freeze([...open]),
					payload: Buffer.concat(open.map((entry) => entry.payload)),
				}));
				open = [];
			}
		}
		return dispatches;
	};
}

/** In-memory PTY that records the exact framed strings the manager wrote. */
class NativePty implements InstancePty {
	static #nextPid = 940_000;
	readonly pid: number;
	cols: number;
	rows: number;
	readonly spawnDescriptor: InstanceSpawnDescriptor;
	/** One entry per host write, in write order: the complete framing string. */
	readonly writes: (string | Buffer)[] = [];
	readonly resizeCalls: { cols: number; rows: number }[] = [];
	exited = false;
	#dataListeners: ((data: string) => void)[] = [];
	#exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
	readonly #writeWaiters: { needed: number; resolve: () => void }[] = [];

	constructor(descriptor: InstanceSpawnDescriptor) {
		this.pid = NativePty.#nextPid += 1;
		this.cols = descriptor.cols;
		this.rows = descriptor.rows;
		this.spawnDescriptor = descriptor;
	}

	onData(listener: (data: string) => void): { dispose(): void } {
		this.#dataListeners.push(listener);
		return { dispose: () => { this.#dataListeners = this.#dataListeners.filter((entry) => entry !== listener); } };
	}

	onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
		this.#exitListeners.push(listener);
		return { dispose: () => { this.#exitListeners = this.#exitListeners.filter((entry) => entry !== listener); } };
	}

	on(): void { /* the read-error channel is not exercised here */ }

	removeListener(): void { /* the read-error channel is not exercised here */ }

	write(data: string | Buffer): void {
		// The manager frames a whole logical dispatch into ONE write; the independent
		// decoder below proves that every byte of it is authenticated framing.
		this.writes.push(data);
		for (const waiter of this.#writeWaiters.filter((entry) => entry.needed <= this.writes.length)) {
			this.#writeWaiters.splice(this.#writeWaiters.indexOf(waiter), 1);
			waiter.resolve();
		}
	}

	/**
	 * Wait until this child has actually recorded `count` host writes.
	 *
	 * `submitted` from a viewer only means the viewer's own socket accepted the
	 * frames; the owner still has to receive, admit, translate, and dispatch them.
	 * Every expectation about the child therefore waits on the write itself and
	 * never on the return value of a send.
	 */
	whenWrites(count: number, label: string): Promise<void> {
		return withTimeout(new Promise<void>((resolveWrites) => {
			if (this.writes.length >= count) resolveWrites();
			else this.#writeWaiters.push({ needed: count, resolve: resolveWrites });
		}), 8_000, `${label} (after ${this.writes.length} recorded write(s))`);
	}

	resize(columns: number, rows: number): void {
		this.resizeCalls.push({ cols: columns, rows });
		this.cols = columns;
		this.rows = rows;
	}

	kill(signal?: string): void {
		if (signal === "SIGKILL" || signal === "SIGTERM") this.emitExit(0);
	}

	pause(): void { /* not exercised */ }

	resume(): void { /* not exercised */ }

	emitData(data: string): void {
		for (const listener of [...this.#dataListeners]) listener(data);
	}

	emitExit(exitCode: number, signal?: number): void {
		if (this.exited) return;
		this.exited = true;
		for (const listener of [...this.#exitListeners]) listener({ exitCode, signal });
	}
}

/**
 * Failure-preserving cleanup shared by the native fixtures.
 *
 * The hook exists before any fallible setup, every owned retirement is
 * attempted whether or not an earlier one failed, failures are aggregated
 * instead of replacing one another, and an evidence root is removed only when
 * the case itself reported success and every retirement was confirmed. A case
 * that failed keeps its root and says where it is, so a failure never destroys
 * the evidence of the failure.
 */
interface EvidenceCleanup {
	/** Take responsibility for retiring one acquired resource. */
	own(what: string, run: () => Promise<void>): void;
	/** Called by the case itself as its last statement. */
	succeeded(): void;
}

function evidenceCleanup(t: TestContext, label: string, root: string | null): EvidenceCleanup {
	const owned: { what: string; run: () => Promise<void> }[] = [];
	let caseSucceeded = false;
	t.after(async () => {
		const failures: unknown[] = [];
		// Reverse acquisition order, so a resource retires before the thing it sits
		// on; a failure in one never skips the rest.
		for (const entry of owned.reverse()) {
			try {
				await entry.run();
			}
			catch (error) {
				failures.push(error);
			}
		}
		if (root !== null) {
			if (failures.length === 0 && caseSucceeded) {
				try {
					rmSync(root, { recursive: true, force: true });
				}
				catch (error) {
					failures.push(error);
				}
			}
			else {
				t.diagnostic(failures.length > 0
					? `${label}: ${failures.length} owned retirement(s) failed; evidence retained at ${root}`
					: `${label}: the case did not pass; evidence retained at ${root}`);
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(failures, `${label}: cleanup could not confirm every owned retirement`);
		}
	});
	return {
		own(what, run) {
			owned.push({ what, run });
		},
		succeeded() {
			caseSucceeded = true;
		},
	};
}

/**
 * Consume published viewports in arrival order until one matches.
 *
 * An inbox hands out the oldest unconsumed publication, so a barrier naming a
 * specific geometry, native tuple, or output marker has to say which publication
 * it means instead of assuming that one is next. The wait stays event-driven and
 * bounded by the inbox: it fails as soon as no further publication arrives.
 */
async function nextSnapshotMatching(
	inbox: SnapshotInbox,
	label: string,
	matches: (snapshot: SessionContentSnapshot) => boolean,
): Promise<SessionContentSnapshot> {
	for (;;) {
		const snapshot = await inbox.next(`the published viewport for ${label}`);
		if (matches(snapshot)) return snapshot;
	}
}

interface NativeRegistrarEntry {
	readonly instanceId: string;
	readonly bootstrap: InstanceStatusRegistration["bootstrap"];
	released: boolean;
}

/**
 * Registrar of production shape: a fresh hex64 key per registration (both the
 * input codec and the copy receiver key on exactly this shape, and distinct keys
 * are what make another row's capsule mean nothing) and the closed framing mode
 * recorded in the bootstrap the child would actually receive.
 */
function nativeStatusRegistrar(
	handlers: Map<string, InstanceStatusHandlers>,
): StatusRegistrar & { readonly entries: NativeRegistrarEntry[] } {
	const entries: NativeRegistrarEntry[] = [];
	return {
		entries,
		register(instanceId, rowHandlers, options) {
			const entry: NativeRegistrarEntry = {
				instanceId,
				released: false,
				bootstrap: {
					version: 1,
					socketPath: `/synthetic/${instanceId}.sock`,
					token: randomBytes(32).toString("hex"),
					instanceId,
					generation: randomUUID(),
					...(options?.inputOriginFraming === true ? { inputOriginFraming: 1 as const } : {}),
				},
			};
			entries.push(entry);
			handlers.set(instanceId, rowHandlers);
			return {
				bootstrap: entry.bootstrap,
				release(): void { entry.released = true; },
			};
		},
	};
}

interface NativeRow {
	readonly id: string;
	readonly pty: NativePty;
	readonly bootstrap: InstanceStatusRegistration["bootstrap"];
	readonly entry: NativeRegistrarEntry;
}

interface NativeOwnerFixture {
	readonly root: string;
	readonly manager: InstanceManager;
	readonly service: OwningHostService;
	readonly contentHost: SessionContentHost;
	readonly host: HostFixture;
	readonly grants: DirectionalGrantStore;
	readonly hostRunId: string;
	readonly wires: NativeWire[];
	readonly bindings: SessionContentChannelBinding[];
	readonly ownerDiagnostics: SessionContentHostDiagnosticCode[];
	/** Everything the manager's OWN owner-local clipboard route was handed. */
	readonly localCopies: { readonly instanceId: string; readonly event: NativeClipboardEvent }[];
	createRow(label: string): Promise<NativeRow>;
	setConversation(row: NativeRow, sessionId: string, epoch: number): void;
	/** Deliver one arbitrary status (for example a null tuple) through the real status path. */
	emitStatus(row: NativeRow, update: InstanceStatusUpdate): void;
	/** Deliver this row's own readiness capsule and await the parse that verifies it. */
	markReady(row: NativeRow): Promise<void>;
	ptyFor(row: NativeRow): NativePty;
	surfaceFor(row: NativeRow): TerminalSurface;
	feed(row: NativeRow, chunks: readonly string[]): Promise<void>;
	/** The dispatches this row's child actually received, verified independently. */
	dispatches(row: NativeRow): readonly NativeDispatch[];
	lastDispatch(row: NativeRow): NativeDispatch;
	expectContentAttachment(): Promise<{ readonly wire: NativeWire; readonly binding: SessionContentChannelBinding }>;
	whenDiagnostic(code: SessionContentHostDiagnosticCode): Promise<void>;
	/**
	 * Report from inside the case that it ran to its last assertion. The owner's
	 * evidence root is removed only when this happened and every retirement was
	 * confirmed; otherwise the tree stays on disk for inspection.
	 */
	succeeded(): void;
}

/**
 * The same real owner stack as the display-only cases above, in the native
 * production mode: native setup launch composition, the closed input-framing
 * opt-in, and the content host's explicit `nativeIo: true` opt-in.
 */
async function startNativeOwner(
	t: TestContext,
	options: { readonly cols?: number; readonly rows?: number } = {},
): Promise<NativeOwnerFixture> {
	const root = makeRoot("native-owner");
	// Registered before anything else can fail, so a half-built fixture still
	// retires whatever it managed to acquire.
	const cleanup = evidenceCleanup(t, "native owner", root);
	const pkg = makePackageFixture(root);
	const workspaceRoot = join(root, "workspaces");
	const home = join(root, "home");
	const agentDir = join(root, "native-agent");
	const sessionDir = join(agentDir, "sessions");
	for (const path of [workspaceRoot, home, join(agentDir, "extensions"), sessionDir]) {
		mkdirSync(path, { recursive: true });
	}
	// A closed environment of the production shape: the child would see exactly
	// these, and nothing under the real user's home is touched.
	const nativeEnv: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CODING_AGENT_SESSION_DIR: sessionDir,
	};

	const ptysByWorkspace = new Map<string, NativePty>();
	const ptyFactory: PtyFactory = (descriptor) => {
		const pty = new NativePty(descriptor);
		ptysByWorkspace.set(descriptor.cwd, pty);
		return pty;
	};
	const statusHandlers = new Map<string, InstanceStatusHandlers>();
	const registrar = nativeStatusRegistrar(statusHandlers);
	const localCopies: { readonly instanceId: string; readonly event: NativeClipboardEvent }[] = [];
	let managerChange: InstanceManagerOptions["onChange"];
	const manager = new InstanceManager({
		packageRoot: pkg.packageRoot,
		piExecutable: pkg.piExecutable,
		statusRegistrar: registrar,
		// Native setup is the production mode this seam runs in, and the closed
		// opt-in is what makes EVERY host write to this child a framed dispatch.
		nativeSetup: true,
		nativeInputOriginFraming: true,
		args: [],
		env: { ...nativeEnv },
		cols: options.cols ?? DEFAULT_INSTANCE_COLS,
		rows: options.rows ?? DEFAULT_INSTANCE_ROWS,
		getSupportedKeyboardFlags: () => 7,
		onChange: (instanceId) => managerChange?.(instanceId),
		// The owner's own local clipboard route: a viewer-origin copy must never
		// appear here, so this records every claim that it did.
		onNativeClipboard: (instanceId, event) => { localCopies.push({ instanceId, event }); },
		ptyFactory,
	});
	cleanup.own("instance manager and its synthetic children", async () => {
		for (const pty of ptysByWorkspace.values()) pty.emitExit(0);
		await manager.dispose();
	});
	const service = createLocalOwningHostService({
		createManager: (managerOptions) => {
			managerChange = managerOptions.onChange;
			return manager as unknown as OwningHostManager;
		},
		teardownRequested: () => false,
	});
	service.openManager({
		packageRoot: pkg.packageRoot,
		piExecutable: pkg.piExecutable,
		statusRegistrar: registrar,
	} as InstanceManagerOptions);

	const inventory = service.readInventorySnapshot();
	assert.ok(inventory, "the real owning-host service must observe its own manager run");
	const hostRunId = inventory.hostRunId;

	const grants = createInMemoryDirectionalGrantStore();
	const wires: NativeWire[] = [];
	const bindings: SessionContentChannelBinding[] = [];
	const ownerDiagnostics: SessionContentHostDiagnosticCode[] = [];
	const attachmentWaiters: Array<(attachment: { wire: NativeWire; binding: SessionContentChannelBinding }) => void> = [];
	const diagnosticWaiters: Array<{ code: SessionContentHostDiagnosticCode; resolve: () => void }> = [];
	const diagnosticConsumed = new Map<SessionContentHostDiagnosticCode, number>();

	const contentHost = createSessionContentHost({
		source: service,
		authorizePeer: (peerKey) => grants.get(peerKey.keyId) !== undefined,
		// The one explicit opt-in: without it this endpoint offers, accepts, and
		// acts on nothing native.
		nativeIo: true,
		onDiagnostic: (event) => {
			ownerDiagnostics.push(event.code);
			const index = diagnosticWaiters.findIndex((waiter) => waiter.code === event.code);
			if (index < 0) return;
			const waiter = diagnosticWaiters.splice(index, 1)[0];
			diagnosticConsumed.set(event.code, (diagnosticConsumed.get(event.code) ?? 0) + 1);
			waiter?.resolve();
		},
	});
	// The content host retires before the manager above, and independently of it.
	cleanup.own("session content host", async () => {
		await contentHost.stopAll();
	});

	const identity = await newIdentity("native-owner-host");
	const host = await startHost(t, {
		identity,
		grants,
		onPairingRequest: (request) => { request.approve(); },
		onContentChannel: (channel) => {
			const wire = new NativeWire(channel);
			const attachment = { wire, binding: contentHost.attach(wire) };
			wires.push(wire);
			bindings.push(attachment.binding);
			const waiter = attachmentWaiters.shift();
			if (waiter !== undefined) waiter(attachment);
		},
	});

	let counter = 0;
	const workspaceFor = (): string => {
		counter += 1;
		const path = join(workspaceRoot, `row-${counter}`);
		mkdirSync(path, { recursive: true });
		return path;
	};
	const createRow = async (label: string): Promise<NativeRow> => {
		const id = await manager.create({ workspace: workspaceFor() });
		const view = service.readRow(id);
		assert.ok(view, `row ${id} is not listed (${label})`);
		assert.equal(view.lifecycle, "alive", `the native synthetic row launched (error: ${view.error ?? "none"}) for ${label}`);
		const pty = ptysByWorkspace.get(view.workspace);
		assert.ok(pty, `no synthetic PTY was spawned for ${label}`);
		const entry = registrar.entries.find((candidate) => candidate.instanceId === id);
		assert.ok(entry, `creating a row registers it (${label})`);
		assert.equal(entry.released, false);
		assert.equal(entry.bootstrap.inputOriginFraming, 1, "the closed mode is recorded before the child exists");
		return { id, pty, bootstrap: entry.bootstrap, entry };
	};
	const surfaceFor = (row: NativeRow): TerminalSurface => {
		const surface = manager.surface(row.id);
		assert.ok(surface, `row ${row.id} has no terminal surface`);
		return surface;
	};
	const ptyFor = (row: NativeRow): NativePty => {
		const pty = ptysByWorkspace.get(service.readRow(row.id)?.workspace ?? "");
		assert.ok(pty, `no synthetic PTY was spawned for row ${row.id}`);
		return pty;
	};
	const decoders = new Map<string, (writes: readonly (string | Buffer)[]) => readonly NativeDispatch[]>();
	const dispatches = (row: NativeRow): readonly NativeDispatch[] => {
		let reader = decoders.get(row.id);
		if (reader === undefined) {
			reader = nativeDispatchReader(createNativeInputDecoder(row.bootstrap));
			decoders.set(row.id, reader);
		}
		return reader(row.pty.writes);
	};

	return {
		root,
		succeeded: cleanup.succeeded,
		manager,
		service,
		contentHost,
		host,
		grants,
		hostRunId,
		wires,
		bindings,
		ownerDiagnostics,
		localCopies,
		createRow,
		setConversation(row, sessionId, epoch) {
			const handlers = statusHandlers.get(row.id);
			assert.ok(handlers, `row ${row.id} has no live status registration`);
			handlers.onStatus({
				busy: false,
				pendingInput: false,
				inputSurface: false,
				activity: [],
				nativeSession: { sessionId, epoch, name: `conversation ${sessionId}` },
			});
		},
		emitStatus(row, update) {
			const handlers = statusHandlers.get(row.id);
			assert.ok(handlers, `row ${row.id} has no live status registration`);
			handlers.onStatus(update);
		},
		async markReady(row) {
			row.pty.emitData(capsuleOsc(nativeReadyCapsule(row.bootstrap)));
			// Readiness is observed by the terminal parser, so the parse is the real
			// signal that a later write may be framed.
			await surfaceFor(row).flush();
		},
		ptyFor,
		surfaceFor,
		async feed(row, chunks) {
			const pty = ptyFor(row);
			for (const chunk of chunks) pty.emitData(chunk);
			await surfaceFor(row).flush();
		},
		dispatches,
		lastDispatch(row) {
			const list = dispatches(row);
			assert.ok(list.length > 0, `row ${row.id} received at least one framed dispatch`);
			return list[list.length - 1];
		},
		expectContentAttachment() {
			return new Promise<{ wire: NativeWire; binding: SessionContentChannelBinding }>((resolveAttachment) => {
				attachmentWaiters.push(resolveAttachment);
			});
		},
		whenDiagnostic(code) {
			return new Promise<void>((resolveDiagnostic) => {
				const recorded = ownerDiagnostics.filter((entry) => entry === code).length;
				const consumed = diagnosticConsumed.get(code) ?? 0;
				if (recorded > consumed) {
					diagnosticConsumed.set(code, consumed + 1);
					resolveDiagnostic();
					return;
				}
				diagnosticWaiters.push({ code, resolve: resolveDiagnostic });
			});
		},
	};
}

interface NativeViewerFixture {
	readonly viewer: SessionContentViewer;
	readonly channel: PeerByteChannel;
	readonly identity: OwnedPeerIdentity;
	/** Viewer -> owner direction: holds input pages for a real mid-paste stall. */
	readonly outbound: NativeWire;
	/** Owner -> viewer direction: records what this viewer was actually written. */
	readonly wire: NativeWire;
	readonly binding: SessionContentChannelBinding;
	readonly inbox: SnapshotInbox;
	/** Copies delivered to THIS viewer and nobody else. */
	readonly copies: NativeIoCompletedCopy[];
	/** Every source (conversation or startup) the endpoint asked this fixture's guard about. */
	readonly guardAsks: NativeIoInputSource[];
	readonly viewerDiagnostics: string[];
	/** The deliberate commit: the guard proves THIS source, never the newest one. */
	commit(source: NativeIoInputSource | undefined): void;
	/** The next published snapshot that states a CONVERSATION native input source. */
	nextSource(label: string): Promise<NativeIoSource>;
	/** The next copy delivered to this viewer. */
	nextCopy(label: string): Promise<NativeIoCompletedCopy>;
}

function viewerIdOf(binding: SessionContentChannelBinding): string {
	const viewerId = binding.viewerId;
	assert.ok(viewerId !== null, "this binding's own viewing surface is registered with the manager");
	return viewerId;
}

async function connectNativeViewer(
	t: TestContext,
	owner: NativeOwnerFixture,
	options: {
		readonly label: string;
		readonly sessionId: string;
		readonly cols: number;
		readonly rows: number;
		/** `false` keeps the exact legacy display-only hello: nothing native offered. */
		readonly nativeIo?: boolean;
	},
): Promise<NativeViewerFixture> {
	const identity = await newIdentity(options.label);
	const clientFixture = startClient(t, identity);
	const paired = await clientFixture.client.pair({
		port: owner.host.port,
		approveServerKey: () => "accept",
	});
	assert.equal(paired.ok, true, `pairing ${options.label} must be accepted`);
	const attachmentPromise = owner.expectContentAttachment();
	const channel = await clientFixture.client.connectApp({
		port: owner.host.port,
		lane: "content",
		approveServerKey: () => {
			throw new Error("the server key is already remembered");
		},
	});
	const attachment = await withTimeout(
		attachmentPromise,
		5_000,
		`the owner never attached a native content binding for ${options.label}`,
	);
	const outbound = new NativeWire(channel);
	// The channel is owned from the moment it exists — before the viewer is even
	// attached — and both retirements are attempted whatever the first one does, so
	// a failing stop never leaves the channel open and never hides either failure.
	let attached: SessionContentViewer | undefined;
	t.after(async () => {
		const failures: unknown[] = [];
		if (attached !== undefined) {
			try {
				await attached.stop();
			}
			catch (error) {
				failures.push(error);
			}
		}
		try {
			await channel.close();
		}
		catch (error) {
			failures.push(error);
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1) {
			throw new AggregateError(
				failures,
				`native viewer ${options.label}: cleanup could not confirm both retirements`,
			);
		}
	});

	// The written-source guard is a commit seam owned by this fixture: it never
	// derives its answer from whatever source happens to be current, which is
	// exactly what these cases need to be able to disprove. (It is a simulated
	// written-source proof, not Main's own physical focus proof.)
	let committed: NativeIoInputSource | undefined;
	const guardAsks: NativeIoInputSource[] = [];
	const copies: NativeIoCompletedCopy[] = [];
	const copyWaiters: Array<(copy: NativeIoCompletedCopy) => void> = [];
	let copiesConsumed = 0;
	const nativeIo = options.nativeIo === false
		? undefined
		: {
			authorizeInput: (expected: NativeIoInputSource): boolean => {
				guardAsks.push(expected);
				return committed !== undefined && nativeIoSourceEquals(expected, committed);
			},
			onCopy: (copy: NativeIoCompletedCopy): void => {
				copies.push(copy);
				const waiter = copyWaiters.shift();
				if (waiter !== undefined) waiter(copy);
			},
		};

	const inbox = snapshotInbox();
	const viewerDiagnostics: string[] = [];
	const viewer = attachSessionContentViewer({
		channel: outbound,
		hostRunId: owner.hostRunId,
		sessionId: options.sessionId,
		cols: options.cols,
		rows: options.rows,
		...(nativeIo === undefined ? {} : { nativeIo }),
		onSnapshot: (snapshot) => inbox.onSnapshot(snapshot),
		onDiagnostic: (event) => {
			viewerDiagnostics.push(event.code);
		},
	});
	attached = viewer;

	return {
		viewer,
		channel,
		identity,
		outbound,
		wire: attachment.wire,
		binding: attachment.binding,
		inbox,
		copies,
		guardAsks,
		viewerDiagnostics,
		commit(source) {
			committed = source;
		},
		async nextSource(label) {
			for (;;) {
				const snapshot = await inbox.next(label);
				const source = snapshot.meta.inputSource;
				// Only a conversation source qualifies; a startup source names no tuple.
				if (source !== undefined && source !== null && !isNativeIoStartupSource(source)) return source;
			}
		},
		nextCopy(label) {
			return withTimeout(
				new Promise<NativeIoCompletedCopy>((resolveCopy) => {
					if (copies.length > copiesConsumed) {
						const copy = copies[copiesConsumed];
						copiesConsumed += 1;
						resolveCopy(copy);
						return;
					}
					copyWaiters.push((copy) => {
						copiesConsumed += 1;
						resolveCopy(copy);
					});
				}),
				8_000,
				label,
			);
		},
	};
}

/**
 * A content viewer driven at the frame level, for page sequences no honest
 * endpoint would produce: an abandoned partial, and pages that arrive out of
 * order. It performs the real hello and subscribe itself and reads the owner's
 * stated source straight out of the viewport it publishes.
 */
interface RawNativeSubscription {
	readonly channel: PeerByteChannel;
	readonly identity: OwnedPeerIdentity;
	readonly wire: NativeWire;
	readonly subscriptionId: string;
	/** The viewport this subscription was most recently given. */
	readonly begin: SessionContentBeginFrame;
	/** Send one frame of this endpoint's own schema. */
	send(frame: SessionContentFrame): Promise<void>;
	/** Send pre-packed native IO bytes verbatim, in whatever order the caller chooses. */
	sendBytes(bytes: Buffer): Promise<void>;
	nextFrame(type: SessionContentFrame["type"], label: string): Promise<SessionContentFrame>;
	/** Subscribe (or resubscribe after an explicit unsubscribe) and await its viewport. */
	subscribe(cols: number, rows: number, label: string): Promise<SessionContentBeginFrame>;
}

async function openRawNativeSubscription(
	t: TestContext,
	owner: NativeOwnerFixture,
	options: { readonly label: string; readonly sessionId: string; readonly cols: number; readonly rows: number },
): Promise<RawNativeSubscription> {
	const identity = await newIdentity(options.label);
	const clientFixture = startClient(t, identity);
	const paired = await clientFixture.client.pair({
		port: owner.host.port,
		approveServerKey: () => "accept",
	});
	assert.equal(paired.ok, true, `pairing ${options.label} must be accepted`);
	const attachmentPromise = owner.expectContentAttachment();
	const channel = await clientFixture.client.connectApp({
		port: owner.host.port,
		lane: "content",
		approveServerKey: () => {
			throw new Error("the server key is already remembered");
		},
	});
	const attachment = await withTimeout(
		attachmentPromise,
		5_000,
		`the owner never attached a raw content binding for ${options.label}`,
	);
	t.after(async () => {
		await channel.close();
	});

	let subscriptionId = "";
	let currentBegin: SessionContentBeginFrame | undefined;
	/** What the OWNER wrote on this channel: the raw subscriber reads itself here. */
	const wire = attachment.wire;
	const sendBytes = async (bytes: Buffer): Promise<void> => {
		// This side is the peer: its frames go out on its own channel, never on the
		// owner's tap.
		await channel.send(bytes);
	};
	const fixture: RawNativeSubscription = {
		channel,
		identity,
		wire,
		get subscriptionId() {
			return subscriptionId;
		},
		get begin() {
			assert.ok(currentBegin !== undefined, "this subscription has a published viewport");
			return currentBegin;
		},
		async send(frame) {
			await sendBytes(encodeSessionContentFrame(frame));
		},
		sendBytes,
		nextFrame(type, label) {
			return wire.nextFrame(type, label);
		},
		async subscribe(cols, rows, label) {
			subscriptionId = randomUUID();
			await fixture.send({
				type: "subscribe",
				subscriptionId,
				hostRunId: owner.hostRunId,
				sessionId: options.sessionId,
				cols,
				rows,
			});
			await fixture.nextFrame("subscribed", `${label}: the owner acknowledged the subscription`);
			const begin = await fixture.nextFrame("content_begin", `${label}: the owner published a viewport`);
			currentBegin = begin as SessionContentBeginFrame;
			return currentBegin;
		},
	};

	await sendBytes(encodeSessionContentFrame({
		type: "hello",
		service: SESSION_CONTENT_SERVICE,
		major: SESSION_CONTENT_MAJOR,
		minor: SESSION_CONTENT_MINOR,
		capabilities: [SESSION_CONTENT_REQUIRED_CAPABILITY, SESSION_CONTENT_NATIVE_IO_CAPABILITY],
	}));
	await wire.nextFrame("hello_ack", "the raw native subscriber was acknowledged");
	await fixture.subscribe(options.cols, options.rows, options.label);
	return fixture;
}

/* ------------------------------------------------------------------------- *
 * Native input / text-copy cases
 * ------------------------------------------------------------------------- */

function statedSource(source: NativeIoInputSource | null | undefined): NativeIoSource {
	assert.ok(source !== undefined && source !== null, "this publish states the owner's own native input source");
	if (isNativeIoStartupSource(source)) throw new Error("this publish was expected to state a conversation source");
	return source;
}

for (const kittyFlags of [0, 7]) {
	test(`network Ctrl+J reaches the native editor without early submit (owner Kitty flags ${kittyFlags})`, async (t) => {
		const real = await loadRealBridgeHost();
		if (!real) return skipOrFail(t, "no installed Pi for network native editor input");
		const nativeKitty = real.tui.setKittyProtocolActive as (active: boolean) => void;
		const previousKitty = (real.tui.isKittyProtocolActive as () => boolean)();
		const previousBindings = real.host.tuiGetKeybindings?.();
		t.after(() => {
			nativeKitty(previousKitty);
			real.host.tuiSetKeybindings?.(previousBindings);
		});
		const bindings = createRealKeybindingsManager(real.tui);
		nativeKitty(kittyFlags !== 0);
		const editor = new real.host.CustomEditor(GEOMETRY_TUI, REAL_IDENTITY_THEME, bindings);
		const siblingEditor = new real.host.CustomEditor(GEOMETRY_TUI, REAL_IDENTITY_THEME, bindings);
		siblingEditor.setText("independent sibling draft");
		const submits: string[] = [];
		editor.onSubmit = (text) => submits.push(text);
		siblingEditor.onSubmit = () => assert.fail("nonselected owner must not submit");
		const owner = await startNativeOwner(t);
		const sibling = await owner.createRow("unselected-newline-owner");
		const row = await owner.createRow("selected-newline-owner");
		owner.setConversation(row, "newline-conversation", 1);
		await owner.markReady(row);
		await owner.feed(row, [`\x1b[=0;1u\x1b[=${kittyFlags};1u`, "native prompt"]);
		const viewer = await connectNativeViewer(t, owner, {
			label: "newline-viewer", sessionId: row.id, cols: 80, rows: 24,
		});
		await withTimeout(viewer.viewer.ready, 5_000, "newline viewer ready");
		const source = await viewer.nextSource("newline owner input source");
		const inputModes = viewer.viewer.readSnapshot()!.meta.inputModes;
		assert.equal(inputModes.kittyFlags, kittyFlags);
		const sourceKitty = false;
		const send = async (packet: string): Promise<string> => {
			const count = row.pty.writes.length;
			assert.deepEqual(await viewer.viewer.sendInput({
				source, inputModes, kind: "keyboard",
				text: normalizeNativeSourceInput(packet, sourceKitty),
			}), { status: "submitted" });
			await row.pty.whenWrites(count + 1, "newline input reached its exact owner");
			const dispatch = owner.lastDispatch(row);
			assert.deepEqual(dispatch.origin, { kind: "viewer", token: source.sourceToken });
			assert.deepEqual(dispatch.expectedNativeTuple, { sessionId: "newline-conversation", epoch: 1 });
			const text = dispatch.payload.toString("utf8");
			// Actual authenticated owner bytes enter the real CustomEditor. The PTY
			// itself is synthetic; this is TLS/protocol + headless editor evidence.
			editor.handleInput(text);
			return text;
		};
		// A current source is insufficient without the caller's committed proof.
		assert.deepEqual(await viewer.viewer.sendInput({
			source, inputModes, kind: "keyboard", text: normalizeNativeSourceInput("\n", false),
		}), { status: "not-sent", reason: "unauthorized" });
		assert.equal(row.pty.writes.length, 0);
		viewer.commit(source);
		for (const newline of ["\n", "\x1b[106;5u", "\x1b[13;2u"]) {
			editor.setText("");
			const count = submits.length;
			await send("first line");
			const newlineBytes = await send(newline);
			if (newline === "\n") assert.equal(newlineBytes, kittyFlags === 0 ? "\n" : "\x1b[106;5u");
			assert.equal(editor.getText(), "first line\n");
			assert.equal(submits.length, count, "no send callback at newline");
			await send("second line");
			assert.equal(editor.getText(), "first line\nsecond line");
			assert.equal(submits.length, count);
			assert.equal(await send("\r"), "\r");
			assert.deepEqual(submits.slice(count), ["first line\nsecond line"]);
			assert.equal(sibling.pty.writes.length, 0, "no input framing reaches a nonselected owner");
			assert.equal(siblingEditor.getText(), "independent sibling draft");
		}
		owner.succeeded();
	});
}

test("a native viewer's input crosses TLS into the framed child under the owner's current source, modes, and paste bound", async (t) => {
	const owner = await startNativeOwner(t);
	const row = await owner.createRow("native-input");
	owner.setConversation(row, "conversation-native-input", 7);
	await owner.markReady(row);
	await owner.feed(row, ["\x1b[2J\x1b[H", "\x1b[?2004h", "owner prompt\n"]);

	const viewer = await connectNativeViewer(t, owner, {
		label: "native-viewer",
		sessionId: row.id,
		cols: 240,
		rows: 200,
	});
	await withTimeout(viewer.viewer.ready, 5_000, "the native viewer never became ready");
	const first = await viewer.nextSource("a published viewport that states a native input source");
	const lower = owner.service.readViewerInputSource(viewerIdOf(viewer.binding));
	assert.ok(lower !== undefined && !isNativeViewerStartupInputSource(lower),
		"the manager resolves this binding's own conversation input scope");
	// The exact settled schema: one `nativeSession` tuple, the canonical geometry
	// with its revision, this viewer's revision, and the host-minted token.
	assert.deepEqual(first, {
		hostRunId: owner.hostRunId,
		sessionId: row.id,
		nativeSession: { sessionId: "conversation-native-input", epoch: 7 },
		geometry: { cols: 240, rows: 200, revision: 1 },
		viewerRevision: lower.viewerRevision,
		sourceToken: lower.sourceToken,
	}, "the stated source is exactly the owner's current scope facts");
	assert.deepEqual(lower.nativeSession, { sessionId: "conversation-native-input", epoch: 7 });
	assert.deepEqual(viewer.viewer.readNativeInputSource(), first);
	const modes = viewer.viewer.readSnapshot()?.meta.inputModes;
	assert.ok(modes !== undefined, "the viewer holds the current published viewport");
	assert.equal(modes.bracketedPaste, true);
	assert.equal(row.pty.writes.length, 0, "readiness, snapshots, and metadata never write a byte to the child");

	// The guard is a live proof seam, not a formality: with nothing committed, the
	// perfectly current source and modes authorize nothing at all.
	assert.deepEqual(
		await viewer.viewer.sendInput({ source: first, inputModes: modes, kind: "keyboard", text: "ls\r" }),
		{ status: "not-sent", reason: "unauthorized" },
	);
	assert.equal(viewer.guardAsks.length, 1, "the caller's guard was asked about the exact current source");
	assert.deepEqual(viewer.guardAsks[0], first);
	assert.equal(viewer.outbound.count("input"), 0, "a refusal before any write puts no frame on the wire");
	assert.equal(row.pty.writes.length, 0);

	// The same packet after a deliberate commit, translated exactly once.
	viewer.commit(first);
	assert.deepEqual(
		await viewer.viewer.sendInput({ source: first, inputModes: modes, kind: "keyboard", text: "ls\r" }),
		{ status: "submitted" },
	);
	// `submitted` only says this side's socket took the frames; the child's own
	// recorded write is the receipt that the owner received, admitted, and
	// dispatched them.
	await row.pty.whenWrites(1, "the committed keyboard packet reached the child");
	assert.equal(row.pty.writes.length, 1, "one logical keyboard packet is exactly one framed PTY write");
	const framedKeyboard = String(row.pty.writes[0]);
	assert.notEqual(framedKeyboard, "ls\r");
	assert.equal(framedKeyboard.includes("ls\r"), false, "no unframed byte reaches the child");
	const keyboard = owner.lastDispatch(row);
	assert.deepEqual(keyboard.origin, { kind: "viewer", token: first.sourceToken });
	assert.deepEqual(keyboard.expectedNativeTuple, { sessionId: "conversation-native-input", epoch: 7 });
	assert.equal(keyboard.payload.toString("utf8"), "ls\r", "a normalized keyboard packet is not reinterpreted");
	assert.equal(keyboard.fragments.length, 1);

	// A canonical SGR report in content coordinates is re-encoded exactly once for
	// the child's ACTUAL mouse state: DECSET 1000 with the default (legacy) encoding
	// means the report leaves as high-bit bytes, encoded once and not twice.
	await owner.feed(row, ["\x1b[?1000h\x1b[?1006l"]);
	const legacyMouse = await nextSnapshotMatching(viewer.inbox, "the viewport reporting legacy mouse tracking",
		(snapshot) => snapshot.meta.inputModes.mouseTracking === "vt200");
	assert.equal(legacyMouse.meta.inputModes.mouseTracking, "vt200");
	assert.equal(legacyMouse.meta.inputModes.mouseEncoding, "default");
	viewer.commit(statedSource(legacyMouse.meta.inputSource));
	assert.deepEqual(
		await viewer.viewer.sendInput({
			source: statedSource(legacyMouse.meta.inputSource),
			inputModes: legacyMouse.meta.inputModes,
			kind: "mouse",
			text: "\x1b[<0;170;170M",
		}),
		{ status: "submitted" },
	);
	await row.pty.whenWrites(2, "the legacy mouse report reached the child");
	const mouse = owner.lastDispatch(row);
	assert.deepEqual([...mouse.payload], [0x1b, 0x5b, 0x4d, 32, 202, 202],
		"the report leaves as the six legacy bytes the child's own mode expects");
	assert.equal(mouse.payload.length, 6, "no UTF-8 re-encoding of the high-bit coordinates");

	// Exactly 1 MiB of decoded UTF-8, with bracketed paste ON.
	const body = pasteBodyOf(NATIVE_TEXT_PASTE_MAX_BYTES);
	const pasteView = viewer.viewer.readSnapshot();
	assert.ok(pasteView !== undefined);
	const pasteSource = statedSource(pasteView.meta.inputSource);
	const writesBeforePaste = row.pty.writes.length;
	viewer.commit(pasteSource);
	assert.deepEqual(
		await viewer.viewer.sendInput({
			source: pasteSource,
			inputModes: pasteView.meta.inputModes,
			kind: "paste",
			text: body,
		}),
		{ status: "submitted" },
	);
	await row.pty.whenWrites(writesBeforePaste + 1,
		"the whole 1 MiB paste reached the child as one dispatch");
	assert.equal(row.pty.writes.length, writesBeforePaste + 1,
		"one completed logical paste is one dispatch however many pages crossed");
	const pasteBegin = lastFrameOfType(viewer.outbound, "input_begin");
	assert.ok(pasteBegin !== undefined, "the paste crossed as a paged transfer");
	assert.equal(pasteBegin.byteLength, NATIVE_TEXT_PASTE_MAX_BYTES);
	assert.equal(pasteBegin.chunkCount,
		Math.ceil(NATIVE_TEXT_PASTE_MAX_BYTES / DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes));
	const pasteChunks = viewer.outbound.framesOf("input_chunk").filter((chunk) => chunk.inputId === pasteBegin.inputId);
	assert.equal(pasteChunks.length, pasteBegin.chunkCount, "every declared page was written exactly once");
	assert.equal(Buffer.concat(pasteChunks.map((chunk) => Buffer.from(chunk.data, "base64"))).toString("utf8"), body,
		"the pages reassemble to the whole body, untruncated and unreordered");
	assert.equal(viewer.outbound.count("input_end"), 1);
	assertNativeMessagesInsideBound(viewer.outbound);
	const paste = owner.lastDispatch(row);
	const pastePayloadBytes = NATIVE_TEXT_PASTE_MAX_BYTES + PASTE_START.length + PASTE_END.length;
	assert.equal(paste.fragments.length, Math.ceil(pastePayloadBytes / NATIVE_INPUT_RAW_FRAGMENT_BYTES),
		"the 1 MiB body plus its two markers is 33 raw fragments, not 32");
	assert.equal(paste.payload.length, pastePayloadBytes);
	assert.equal(NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES, pastePayloadBytes,
		"the child's whole-dispatch bound is exactly the 1 MiB body plus its two markers");
	assert.equal(paste.payload.subarray(0, PASTE_START.length).toString("utf8"), PASTE_START);
	assert.equal(paste.payload.subarray(paste.payload.length - PASTE_END.length).toString("utf8"), PASTE_END);
	assert.equal(paste.payload.subarray(PASTE_START.length, paste.payload.length - PASTE_END.length).toString("utf8"), body);
	assert.deepEqual(paste.origin, { kind: "viewer", token: pasteSource.sourceToken });

	// One byte over the same bound is refused before a single frame exists.
	const over = pasteBodyOf(NATIVE_TEXT_PASTE_MAX_BYTES + 1);
	const writesBeforeOver = row.pty.writes.length;
	const framesBeforeOver = viewer.outbound.frames.length;
	assert.deepEqual(
		await viewer.viewer.sendInput({
			source: pasteSource,
			inputModes: pasteView.meta.inputModes,
			kind: "paste",
			text: over,
		}),
		{ status: "not-sent", reason: "too-large" },
	);
	assert.equal(row.pty.writes.length, writesBeforeOver, "one byte over the paste bound writes nothing");
	assert.equal(viewer.outbound.frames.length, framesBeforeOver, "an oversized paste never reaches the wire");

	// Mode-specific paste: with bracketed paste OFF the same submission carries no
	// markers, because the owner's one translator removes the wrapper the child did
	// not ask for.
	await owner.feed(row, ["\x1b[?2004l"]);
	const pasteOff = await nextSnapshotMatching(viewer.inbox, "the viewport with bracketed paste off",
		(snapshot) => snapshot.meta.inputModes.bracketedPaste === false);
	assert.equal(pasteOff.meta.inputModes.bracketedPaste, false);
	viewer.commit(statedSource(pasteOff.meta.inputSource));
	assert.deepEqual(
		await viewer.viewer.sendInput({
			source: statedSource(pasteOff.meta.inputSource),
			inputModes: pasteOff.meta.inputModes,
			kind: "paste",
			text: "pasted body",
		}),
		{ status: "submitted" },
	);
	await row.pty.whenWrites(4, "the unwrapped paste reached the child");
	assert.equal(owner.lastDispatch(row).payload.toString("utf8"), "pasted body",
		"the body is never reinterpreted as a keyboard packet and gains no second wrapper");

	// A real native-tuple change moves the source; the old one is refused locally.
	owner.setConversation(row, "conversation-native-input", 8);
	const epochEight = await nextSnapshotMatching(viewer.inbox, "the viewport at the new native epoch",
		(snapshot) => snapshot.meta.nativeSession?.epoch === 8);
	assert.deepEqual(epochEight.meta.nativeSession, { sessionId: "conversation-native-input", epoch: 8 });
	assert.equal(nativeIoSourceEquals(statedSource(epochEight.meta.inputSource), pasteSource), false);
	const writesBeforeStale = row.pty.writes.length;
	const staleTuple = await viewer.viewer.sendInput({
		source: pasteSource,
		inputModes: pasteOff.meta.inputModes,
		kind: "keyboard",
		text: "stale\r",
	});
	assert.deepEqual(staleTuple, { status: "not-sent", reason: "stale-source" });
	assert.equal(row.pty.writes.length, writesBeforeStale,
		"a source the owner no longer holds writes nothing");

	// A real mode change with an unchanged source is refused as stale modes.
	await owner.feed(row, ["\x1b[?2004h"]);
	const pasteOn = await nextSnapshotMatching(viewer.inbox, "the viewport with bracketed paste on again",
		(snapshot) => snapshot.meta.inputModes.bracketedPaste === true
			&& snapshot.meta.nativeSession?.epoch === 8);
	assert.equal(pasteOn.meta.inputModes.bracketedPaste, true);
	const currentSource = statedSource(pasteOn.meta.inputSource);
	assert.equal(nativeIoSourceEquals(currentSource, statedSource(epochEight.meta.inputSource)), true,
		"the modes moved while the source facts did not");
	assert.deepEqual(
		await viewer.viewer.sendInput({
			source: currentSource,
			inputModes: pasteOff.meta.inputModes,
			kind: "keyboard",
			text: "stale\r",
		}),
		{ status: "not-sent", reason: "stale-modes" },
	);

	// A real mid-paste interruption: one page write is genuinely outstanding while
	// a second viewer moves the row's canonical geometry under this paste.
	viewer.commit(currentSource);
	viewer.outbound.holdInputChunkFrom = 2;
	const writesBeforeMid = row.pty.writes.length;
	const pendingPaste = viewer.viewer.sendInput({
		source: currentSource,
		inputModes: pasteOn.meta.inputModes,
		kind: "paste",
		text: pasteBodyOf(200_000),
	});
	await withTimeout(viewer.outbound.whenHolding(), 5_000, "the viewer never reached a real mid-paste channel write");
	const midInputId = lastFrameOfType(viewer.outbound, "input_begin")?.inputId;
	assert.ok(midInputId !== undefined);
	const sibling = await connectNativeViewer(t, owner, {
		label: "native-sibling",
		sessionId: row.id,
		cols: 200,
		rows: 180,
	});
	await withTimeout(sibling.viewer.ready, 5_000, "the second native viewer never became ready");
	const moved = await nextSnapshotMatching(viewer.inbox, "the geometry the owner reports for two viewers",
		(snapshot) => snapshot.meta.geometry.cols === 200 && snapshot.meta.geometry.rows === 180);
	assert.deepEqual(moved.meta.geometry, { cols: 200, rows: 180, revision: 2 });
	const movedSource = statedSource(moved.meta.inputSource);
	assert.equal(nativeIoSourceEquals(movedSource, currentSource), false, "the owner's own facts moved");
	viewer.outbound.releaseHeld();
	assert.deepEqual(await withTimeout(pendingPaste, 5_000, "the interrupted paste never settled truthfully"),
		{ status: "unknown" },
		"pages already invoked are never reported as sent, and never replayed");
	assert.equal(viewer.outbound.framesOf("input_end").some((frame) => frame.inputId === midInputId), false,
		"the remaining pages of an invalidated input are never written");
	assert.equal(row.pty.writes.length, writesBeforeMid, "the abandoned paste produced no dispatch at all");
	await withTimeout(owner.whenDiagnostic("input_incomplete"), 5_000,
		"the owner never freed the partial assembly it no longer describes");

	// The next deliberate commit against the CURRENT source works, on the new scope.
	const staleAgain = await viewer.viewer.sendInput({
		source: currentSource,
		inputModes: pasteOn.meta.inputModes,
		kind: "keyboard",
		text: "stale\r",
	});
	assert.deepEqual(staleAgain, { status: "not-sent", reason: "stale-source" });
	viewer.commit(movedSource);
	assert.deepEqual(
		await viewer.viewer.sendInput({
			source: movedSource,
			inputModes: moved.meta.inputModes,
			kind: "keyboard",
			text: "current\r",
		}),
		{ status: "submitted" },
	);
	await row.pty.whenWrites(5, "the packet on the newer scope reached the child");
	const after = owner.lastDispatch(row);
	assert.equal(after.payload.toString("utf8"), "current\r");
	assert.deepEqual(after.origin, { kind: "viewer", token: movedSource.sourceToken });
	assert.notEqual(movedSource.sourceToken, currentSource.sourceToken,
		"the abandoned source was never retargeted onto the newer viewport");
	assert.deepEqual(after.expectedNativeTuple, { sessionId: "conversation-native-input", epoch: 8 });

	// Page sequences no honest endpoint produces: an abandoned partial, then pages
	// that arrive out of order. Both write nothing and stop nothing.
	const pageRow = await owner.createRow("native-pages");
	owner.setConversation(pageRow, "conversation-pages", 3);
	await owner.markReady(pageRow);
	await owner.feed(pageRow, ["\x1b[2J\x1b[H\x1b[?2004h", "pages\n"]);
	const raw = await openRawNativeSubscription(t, owner, {
		label: "raw-pages",
		sessionId: pageRow.id,
		cols: 90,
		rows: 30,
	});
	const rawSource = statedSource(raw.begin.inputSource);
	const abandoned = buildNativeInputPaste({
		subscriptionId: raw.subscriptionId,
		inputId: randomUUID(),
		ordinal: 1,
		source: rawSource,
		inputModes: raw.begin.inputModes,
		text: pasteBodyOf(200_000),
	});
	await raw.sendBytes(abandoned.frames[0]);
	await raw.sendBytes(abandoned.frames[1]);
	assert.equal(pageRow.pty.writes.length, 0, "an unfinished paste is never partially delivered");
	// Abandoning through the existing unsubscribe is the whole budget: no new timer.
	await raw.send({ type: "unsubscribe", subscriptionId: raw.subscriptionId });
	await raw.nextFrame("unsubscribed", "the owner acknowledged the abandoned subscription");
	assert.equal(pageRow.pty.writes.length, 0, "an abandoned partial never becomes a dispatch");
	assert.equal(pageRow.pty.exited, false, "an abandoned partial never stops the child");

	const again = await raw.subscribe(90, 30, "the resubscribed raw viewer");
	const againSource = statedSource(again.inputSource);
	const valid = buildNativeInputInline({
		subscriptionId: raw.subscriptionId,
		inputId: randomUUID(),
		ordinal: 2,
		source: againSource,
		inputModes: again.inputModes,
		kind: "keyboard",
		data: "next\r",
	});
	await raw.sendBytes(valid.frames[0]);
	// Ordering barrier: the child's own recorded write proves the owner received,
	// admitted, and dispatched the packet above. A frame this side merely handed to
	// its own socket would say nothing about the owner at all.
	await pageRow.pty.whenWrites(1, "the packet after an abandoned partial reached the child");
	assert.ok(owner.dispatches(pageRow).some((entry) => entry.payload.toString("utf8") === "next\r"),
		"the packet after an abandoned partial is admitted normally");

	const reordered = buildNativeInputPaste({
		subscriptionId: raw.subscriptionId,
		inputId: randomUUID(),
		ordinal: 3,
		source: againSource,
		inputModes: again.inputModes,
		text: pasteBodyOf(200_000),
	});
	const writesBeforeReorder = pageRow.pty.writes.length;
	await raw.sendBytes(reordered.frames[0]);
	await raw.sendBytes(reordered.frames[2]);
	await withTimeout(owner.whenDiagnostic("protocol_violation"), 5_000,
		"the owner never refused a page set that skipped its first page");
	assert.equal(nativeErrorFrameOf(raw.wire).code, "bad_frame");
	await withTimeout(raw.channel.closed, 5_000, "the refused content lane never closed");
	assert.equal(pageRow.pty.writes.length, writesBeforeReorder,
		"a refused page set writes nothing, in whole or in part");
	assert.equal(pageRow.pty.exited, false, "a refused page set never stops the child");
	assert.equal(owner.service.readRow(pageRow.id)?.hasLiveProcess, true);
	assert.deepEqual(owner.service.readSessionViewers(pageRow.id), [],
		"only the refused content viewer was released");
	assertNativeMessagesInsideBound(raw.wire, viewer.outbound, viewer.wire);
	owner.succeeded();
});

test("input held for a native redraw wakes for the whole parsed chunk, and a packet whose facts moved never reaches the child", async (t) => {
	// #500 on the real pipeline: surface, service, endpoint, manager, provider, framed
	// PTY. The child ends its synchronized redraw and THEN changes input modes in the
	// same chunk, with a graphics APC between them — the barrier that splits one chunk
	// into several parser writes. A wake-up delivered between those writes reports a
	// state the child never displayed, and the waiting click would cross as bytes the
	// child can no longer interpret. Zero PTY invocations is the only acceptable result.
	const owner = await startNativeOwner(t);
	const row = await owner.createRow("native-defer");
	owner.setConversation(row, "conversation-native-defer", 7);
	await owner.markReady(row);
	await owner.feed(row, ["\x1b[2J\x1b[H", "\x1b[?1003h\x1b[?1006h\x1b[?2004h", "prompt\n"]);

	const viewer = await connectNativeViewer(t, owner, {
		label: "native-defer-viewer", sessionId: row.id, cols: 240, rows: 200,
	});
	await withTimeout(viewer.viewer.ready, 5_000, "the native viewer never became ready");
	const first = await viewer.nextSource("a published viewport that states a native input source");
	viewer.commit(first);

	// The child opens a redraw and is still painting when the viewer's click completes.
	await owner.feed(row, ["\x1b[?2026h\x1b[2J\x1b[Hmid-redraw"]);
	const surface = owner.surfaceFor(row);
	assert.equal(surface.redrawState(), "held", "the child's redraw is genuinely in flight");
	const modes = viewer.viewer.readSnapshot()?.meta.inputModes;
	assert.ok(modes !== undefined, "the viewer holds the committed frame's input modes");
	assert.equal(modes.mouseTracking, "any", "the viewer holds the committed frame's mouse facts");
	assert.deepEqual(
		await viewer.viewer.sendInput({ source: first, inputModes: modes, kind: "mouse", text: "\x1b[<0;12;7M" }),
		{ status: "submitted" },
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(row.pty.writes.length, 0,
		"a completed packet waits BEFORE the first provider write while the owner is mid-redraw");

	// End marker, graphics APC, then mouse tracking and bracketed paste go OFF.
	await owner.feed(row, ["\x1b[?2026l\x1b_Ga=d\x1b\\\x1b[?1003l\x1b[?1006l\x1b[?2004l"]);
	await owner.whenDiagnostic("input_refused");
	assert.equal(row.pty.writes.length, 0,
		"the stale click is discarded: no provider, manager, or PTY invocation at all");

	// The refusal is about those facts, not the lane: the committed frame's own modes
	// are published, and current input on them still crosses once.
	const settled = await nextSnapshotMatching(viewer.inbox, "the viewport after the redraw committed",
		(snapshot) => snapshot.meta.inputModes.mouseTracking === "none");
	assert.equal(settled.meta.inputModes.mouseTracking, "none");
	assert.equal(settled.meta.inputModes.bracketedPaste, false);
	const current = statedSource(settled.meta.inputSource);
	viewer.commit(current);
	assert.deepEqual(
		await viewer.viewer.sendInput({ source: current, inputModes: settled.meta.inputModes, kind: "keyboard", text: "now\r" }),
		{ status: "submitted" },
	);
	await row.pty.whenWrites(1, "current input on current facts still crosses");
	assert.equal(row.pty.writes.length, 1, "exactly one byte sequence ever reached this child");
	assert.equal(owner.lastDispatch(row).payload.toString("utf8"), "now\r",
		"and it is the current packet, not the discarded click");
});

test("input admitted between the parser parts of a graphics-split chunk never outruns the chunk it landed in", async (t) => {
	// Suppressing the wake-up is only half of it: readiness is also POLLED, by the next
	// input that arrives. One child chunk that ends a synchronized redraw, contains a
	// Kitty graphics APC (a splitter barrier — this chunk reaches the parser as three
	// separate writes), and then turns mouse tracking off, leaves a real interval in
	// which the end marker has parsed and the mode change has not. Input admitted there
	// must still wait: otherwise it drains work parked under the frame's own facts and
	// hands bytes to a child that had already turned that reporting off.
	const owner = await startNativeOwner(t);
	const row = await owner.createRow("native-mid-chunk");
	owner.setConversation(row, "conversation-native-mid-chunk", 7);
	await owner.markReady(row);
	await owner.feed(row, ["\x1b[2J\x1b[H", "\x1b[?1003h\x1b[?1006h\x1b[?2004h", "prompt\n"]);
	const viewer = await connectNativeViewer(t, owner, {
		label: "native-mid-chunk-viewer", sessionId: row.id, cols: 240, rows: 200,
	});
	await withTimeout(viewer.viewer.ready, 5_000, "the native viewer never became ready");
	const first = await viewer.nextSource("a published viewport that states a native input source");
	viewer.commit(first);
	const modes = viewer.viewer.readSnapshot()?.meta.inputModes;
	assert.ok(modes !== undefined, "the viewer holds the committed frame's input modes");
	assert.equal(modes.mouseTracking, "any");

	// A completed click parked behind an unfinished redraw.
	await owner.feed(row, ["\x1b[?2026h\x1b[2J\x1b[Hmid-redraw"]);
	const surface = owner.surfaceFor(row);
	assert.equal(surface.redrawState(), "held", "the child is mid-redraw");
	assert.deepEqual(
		await viewer.viewer.sendInput({ source: first, inputModes: modes, kind: "mouse", text: "\x1b[<0;12;7M" }),
		{ status: "submitted" },
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(row.pty.writes.length, 0, "the click waits before its first owner write");

	// Admit a second click in the interval itself, from inside the parser pipeline.
	const terminal = (surface as unknown as { terminal: { write: (data: string, cb?: () => void) => void } }).terminal;
	const realWrite = terminal.write.bind(terminal);
	const parts: string[] = [];
	let admittedInInterval = false;
	terminal.write = (data: string, cb?: () => void): void => {
		parts.push(data);
		if (!admittedInInterval && data.includes("?1003l")) {
			admittedInInterval = true;
			// What this interval really looks like: the hold is gone, the mode change is
			// not parsed or observed yet. Neither half of that is permission to write.
			assert.equal(surface.redrawState(), "held",
				"an end marker whose chunk is still parsing is not readiness");
			assert.equal(surface.publishedInputModes().mouseTracking, "any",
				"the mode change has not been observed at this point");
			void viewer.viewer.sendInput({ source: first, inputModes: modes, kind: "mouse", text: "\x1b[<0;13;8M" });
			assert.equal(row.pty.writes.length, 0,
				"admitting input here touches no provider — neither the new click nor the parked one");
		}
		realWrite(data, cb);
	};
	try {
		await owner.feed(row, ["\x1b[?2026l\x1b_Ga=d\x1b\\\x1b[?1003l\x1b[?1006l\x1b[?2004l"]);
	} finally {
		terminal.write = realWrite;
	}
	assert.ok(admittedInInterval, "the mode change really is a later parser write");
	assert.ok(parts.some((part) => part.includes("?2026l") && !part.includes("?1003l")),
		"the end marker parsed as its own part of the chunk");
	await owner.whenDiagnostic("input_refused");
	assert.equal(row.pty.writes.length, 0,
		"neither the parked click nor the interval click ever reached the child");

	// The lane is intact: the committed frame's own facts still take current input.
	const settled = await nextSnapshotMatching(viewer.inbox, "the viewport after the mode change",
		(snapshot) => snapshot.meta.inputModes.mouseTracking === "none");
	const current = statedSource(settled.meta.inputSource);
	viewer.commit(current);
	assert.deepEqual(
		await viewer.viewer.sendInput({ source: current, inputModes: settled.meta.inputModes, kind: "keyboard", text: "now\r" }),
		{ status: "submitted" },
	);
	await row.pty.whenWrites(1, "current input on the committed frame still crosses");
	assert.equal(row.pty.writes.length, 1, "exactly one byte sequence ever reached this child");
	assert.equal(owner.lastDispatch(row).payload.toString("utf8"), "now\r");
});

test("a native parse failure cancels input held for its redraw and receives no byte, then refuses later input too", async (t) => {
	// A grounded pipeline is not a healthy surface with nothing in flight. The waiting
	// packet is cancelled, and the next packet is refused rather than written into a
	// parser whose behaviour after failure is undefined.
	const owner = await startNativeOwner(t);
	const row = await owner.createRow("native-parse-failure");
	owner.setConversation(row, "conversation-native-parse-failure", 7);
	await owner.markReady(row);
	await owner.feed(row, ["\x1b[2J\x1b[H", "\x1b[?2004h", "prompt\n"]);
	const viewer = await connectNativeViewer(t, owner, {
		label: "native-parse-failure-viewer", sessionId: row.id, cols: 240, rows: 200,
	});
	await withTimeout(viewer.viewer.ready, 5_000, "the native viewer never became ready");
	const first = await viewer.nextSource("a published viewport that states a native input source");
	viewer.commit(first);
	await owner.feed(row, ["\x1b[?2026h\x1b[2J\x1b[Hpainting"]);
	const surface = owner.surfaceFor(row);
	assert.equal(surface.redrawState(), "held", "the redraw is in flight");
	const modes = viewer.viewer.readSnapshot()?.meta.inputModes;
	assert.ok(modes !== undefined, "the viewer holds the committed frame's input modes");
	assert.deepEqual(
		await viewer.viewer.sendInput({ source: first, inputModes: modes, kind: "keyboard", text: "held\r" }),
		{ status: "submitted" },
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(row.pty.writes.length, 0, "the packet is waiting for the frame");

	// The parse pipeline fails while the packet waits.
	(surface as unknown as { terminal: { write: () => void } }).terminal.write = () => {
		throw new Error("synthetic parse pipeline failure");
	};
	owner.ptyFor(row).emitData("\x1b[?2026l");
	let failed = false;
	try {
		await surface.flush();
	} catch {
		failed = true;
	}
	assert.ok(failed, "the parse failure is reported to its owner, not swallowed");
	assert.equal(surface.redrawState(), "unavailable",
		"a failed pipeline is unavailable, never 'clear' with nothing in flight");
	await owner.whenDiagnostic("input_refused");
	assert.equal(row.pty.writes.length, 0, "the waiting packet never reached the child");

	// And the next packet is refused on the same ground rather than written anyway.
	assert.deepEqual(
		await viewer.viewer.sendInput({ source: first, inputModes: modes, kind: "keyboard", text: "later\r" }),
		{ status: "submitted" },
	);
	await owner.whenDiagnostic("input_refused");
	assert.equal(row.pty.writes.length, 0,
		"a grounded pipeline takes no input at all, now or afterwards");
});

test("a native copy reaches only the viewer whose own input caused it, whole, in native emission order", async (t) => {
	const owner = await startNativeOwner(t);
	const row = await owner.createRow("native-copy");
	owner.setConversation(row, "conversation-copy", 11);
	await owner.markReady(row);
	await owner.feed(row, ["\x1b[2J\x1b[H", "copy owner prompt\n"]);

	const first = await connectNativeViewer(t, owner, { label: "copy-viewer-a", sessionId: row.id, cols: 120, rows: 40 });
	await withTimeout(first.viewer.ready, 5_000, "viewer A never became ready");
	// A's own publication is consumed before the second viewer exists, so every
	// later wait knows exactly which viewport it means.
	const aOwnView = await first.inbox.next("viewer A's viewport at its own pane size");
	assert.deepEqual(aOwnView.meta.geometry, { cols: 120, rows: 40, revision: 1 });

	const second = await connectNativeViewer(t, owner, { label: "copy-viewer-b", sessionId: row.id, cols: 100, rows: 36 });
	await withTimeout(second.viewer.ready, 5_000, "viewer B never became ready");
	// Two real viewers of one row are two real scopes. The row's canonical size
	// follows the minimum, so registering B moved the geometry A is told about.
	const aView = await nextSnapshotMatching(first.inbox, "viewer A's viewport once both viewers are registered",
		(snapshot) => snapshot.meta.geometry.cols === 100 && snapshot.meta.geometry.rows === 36);
	const bView = await nextSnapshotMatching(second.inbox, "viewer B's first viewport",
		(snapshot) => snapshot.meta.geometry.cols === 100 && snapshot.meta.geometry.rows === 36);
	assert.deepEqual(aView.meta.geometry, { cols: 100, rows: 36, revision: 2 });
	const sourceA = statedSource(aView.meta.inputSource);
	const sourceB = statedSource(bView.meta.inputSource);
	assert.notEqual(sourceA.sourceToken, sourceB.sourceToken, "two viewers of one row hold two distinct scopes");

	// Three real inputs cross TLS into their own framed dispatches: two from A and
	// one from B, so one binding can later emit two copies out of dispatch order.
	first.commit(sourceA);
	second.commit(sourceB);
	// Each input is awaited at the child before the next one is submitted. Two
	// viewers are two independent connections: submitting both says nothing about
	// the order the owner processed them, and only that order can establish the
	// dispatch ids the copy cases below pair with their capsules.
	assert.deepEqual(
		await first.viewer.sendInput({ source: sourceA, inputModes: aView.meta.inputModes, kind: "keyboard", text: "a-one\r" }),
		{ status: "submitted" },
	);
	await row.pty.whenWrites(1, "A's first input reached the child before B submits");
	assert.deepEqual(
		await second.viewer.sendInput({ source: sourceB, inputModes: bView.meta.inputModes, kind: "keyboard", text: "b-one\r" }),
		{ status: "submitted" },
	);
	await row.pty.whenWrites(2, "B's input reached the child before A submits again");
	assert.deepEqual(
		await first.viewer.sendInput({ source: sourceA, inputModes: aView.meta.inputModes, kind: "keyboard", text: "a-two\r" }),
		{ status: "submitted" },
	);
	await row.pty.whenWrites(3, "all three viewer inputs reached the child as their own dispatches");
	const dispatches = owner.dispatches(row);
	assert.equal(dispatches.length, 3, "each viewer's input is its own framed dispatch to the child");
	const byPayload = new Map(dispatches.map(
		(entry): [string, NativeDispatch] => [entry.payload.toString("utf8"), entry],
	));
	const dispatchA1 = byPayload.get("a-one\r");
	const dispatchA2 = byPayload.get("a-two\r");
	const dispatchB = byPayload.get("b-one\r");
	assert.ok(dispatchA1 !== undefined && dispatchA2 !== undefined && dispatchB !== undefined,
		"every input produced its own verified dispatch");
	assert.deepEqual(dispatchA1.origin, { kind: "viewer", token: sourceA.sourceToken },
		"viewer A's input carries A's own scope token");
	assert.deepEqual(dispatchA2.origin, { kind: "viewer", token: sourceA.sourceToken });
	assert.deepEqual(dispatchB.origin, { kind: "viewer", token: sourceB.sourceToken },
		"viewer B's input carries B's own scope token");
	assert.ok(dispatchA2.dispatchId > dispatchB.dispatchId && dispatchB.dispatchId > dispatchA1.dispatchId,
		"native dispatch ids rise with the inputs that produced them");

	// The child emits three copies, each naming the dispatch AND the viewer scope
	// that actually caused it. They are emitted in an order that is not the input
	// order: an asynchronous copy caused by a later input may legitimately be
	// emitted first, and each binding numbers its own copies from one.
	const copyFromB1 = copyEventOf("the copy B's own input caused", "conversation-copy", 11);
	const copyFromA2 = copyEventOf("the copy A's second input caused", "conversation-copy", 11);
	const copyFromA1 = copyEventOf("the copy A's first input caused", "conversation-copy", 11);
	row.pty.emitData(nativeCopyCapsule(row.bootstrap, 1, copyFromB1,
		{ kind: "viewer", token: sourceB.sourceToken }, dispatchB.dispatchId));
	await owner.surfaceFor(row).flush();
	row.pty.emitData(nativeCopyCapsule(row.bootstrap, 2, copyFromA2,
		{ kind: "viewer", token: sourceA.sourceToken }, dispatchA2.dispatchId));
	await owner.surfaceFor(row).flush();
	row.pty.emitData(nativeCopyCapsule(row.bootstrap, 3, copyFromA1,
		{ kind: "viewer", token: sourceA.sourceToken }, dispatchA1.dispatchId));
	await owner.surfaceFor(row).flush();

	const deliveredB = await second.nextCopy("the copy viewer B's own input caused");
	const deliveredA1 = await first.nextCopy("the first copy viewer A's own input caused");
	const deliveredA2 = await first.nextCopy("the second copy viewer A's own input caused");
	assert.deepEqual(deliveredB.event, copyFromB1);
	assert.deepEqual(deliveredA1.event, copyFromA2);
	assert.deepEqual(deliveredA2.event, copyFromA1);
	assert.deepEqual(deliveredB.source, sourceB, "a copy is addressed to the initiating viewer's own current scope");
	assert.deepEqual(deliveredA1.source, sourceA);
	assert.equal(deliveredB.dispatchId, dispatchB.dispatchId, "a copy names the dispatch that caused it");
	assert.equal(deliveredA1.dispatchId, dispatchA2.dispatchId);
	assert.equal(deliveredA2.dispatchId, dispatchA1.dispatchId);
	assert.equal(second.copies.length, 1, "no broadcast: B receives only the copy B's own input caused");
	assert.equal(first.copies.length, 2, "and A receives only A's own two copies");
	assert.deepEqual(owner.localCopies, [], "a viewer-origin copy never becomes the owner's local clipboard route");
	// Emission order is each binding's own monotonic copy sequence, never the input
	// dispatch id: A's sequence 1 names its HIGHER dispatch and sequence 2 its lower
	// one, while B's own numbering starts again at 1.
	const copiesToA = first.wire.framesOf("copy");
	const copyToB = lastFrameOfType(second.wire, "copy");
	assert.ok(copyToB !== undefined, "each whole small copy crossed as one frame");
	assert.equal(copiesToA.length, 2);
	assert.deepEqual(copiesToA.map((frame) => frame.sequence), [1, 2]);
	assert.deepEqual(copiesToA.map((frame) => frame.dispatchId), [dispatchA2.dispatchId, dispatchA1.dispatchId]);
	assert.ok(dispatchA2.dispatchId > dispatchA1.dispatchId,
		"the binding's own copy sequence, not the dispatch id, decides the order it is told");
	assert.equal(copyToB.sequence, 1, "a sibling viewer keeps its own emission numbering");
	assert.equal(copyToB.dispatchId, dispatchB.dispatchId);

	// A replay of an already-delivered emission, and a raw OSC 52 decoy from the
	// child, are both refused by the owner's own receivers.
	row.pty.emitData(nativeCopyCapsule(row.bootstrap, 3, copyFromA1,
		{ kind: "viewer", token: sourceA.sourceToken }, dispatchA1.dispatchId));
	row.pty.emitData("\x1b]52;c;aGVsbG8=\x07");
	await owner.feed(row, ["\x1b[2J\x1b[Hafter the replay\n"]);
	const replayBarrierA = await nextSnapshotMatching(first.inbox, "the ordering barrier on viewer A",
		(snapshot) => textOf(snapshot.frame).includes("after the replay"));
	const replayBarrierB = await nextSnapshotMatching(second.inbox, "the ordering barrier on viewer B",
		(snapshot) => textOf(snapshot.frame).includes("after the replay"));
	assert.ok(textOf(replayBarrierA.frame).includes("after the replay"));
	assert.ok(textOf(replayBarrierB.frame).includes("after the replay"));
	assert.equal(first.copies.length, 2, "a replayed emission delivers nothing a second time");
	assert.equal(second.copies.length, 1);
	assert.equal(first.wire.count("copy") + first.wire.count("copy_begin"), 2);
	assert.deepEqual(owner.localCopies, [], "a raw OSC 52 write routes no copy anywhere, local or remote");

	// The full producer bound crosses whole. The wire carries the producer's
	// canonical base64 STRING as ASCII bytes, paged: 100,000 encoded characters
	// (which themselves decode to 75,000 bytes of text) split 32768, 32768, 32768,
	// 1696. Nothing is trimmed, and the pages are never re-encoded as decoded text.
	const bigBody = pasteBodyOf(75_000);
	const bigEncoded = Buffer.from(bigBody, "utf8").toString("base64");
	assert.equal(bigEncoded.length, NATIVE_COPY_MAX_ENCODED_CHARS, "the bound is 100,000 canonical base64 characters");
	assert.equal(Buffer.from(bigEncoded, "base64").length, 75_000);
	row.pty.emitData(nativeCopyCapsule(row.bootstrap, 4, copyEventOf(bigBody, "conversation-copy", 11),
		{ kind: "viewer", token: sourceA.sourceToken }, dispatchA1.dispatchId));
	await owner.surfaceFor(row).flush();
	const bigCopy = await first.nextCopy("the whole 100,000-character copy");
	assert.equal(bigCopy.event.kind, "copy");
	assert.ok(bigCopy.event.kind === "copy");
	assert.equal(bigCopy.event.encoded, bigEncoded, "the copy arrives whole, never truncated to one message");
	assert.equal(Buffer.from(bigCopy.event.encoded, "base64").toString("utf8"), bigBody);
	assert.equal(bigCopy.sequence, 3, "the paged copy continues this binding's own emission order");
	const copyBegin = lastFrameOfType(first.wire, "copy_begin");
	assert.ok(copyBegin !== undefined, "a bound-sized copy crosses as one atomic paged transfer");
	assert.equal(copyBegin.byteLength, NATIVE_COPY_MAX_ENCODED_CHARS, "the header counts encoded characters, the wire payload");
	assert.equal(copyBegin.chunkCount,
		Math.ceil(NATIVE_COPY_MAX_ENCODED_CHARS / DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes),
		"four pages of 32768, 32768, 32768, 1696 encoded characters");
	const copyChunks = first.wire.framesOf("copy_chunk");
	assert.equal(copyChunks.length, copyBegin.chunkCount);
	const chunkBound = DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes;
	assert.equal(copyBegin.chunkCount, Math.ceil(NATIVE_COPY_MAX_ENCODED_CHARS / chunkBound),
		"the producer bound crosses as four pages, never truncated to one message");
	assert.deepEqual(copyChunks.map((chunk) => chunk.index), copyChunks.map((_, position) => position),
		"pages arrive in order, once each, with no gap");
	// Each wire page carries the base64 OF its ASCII slice of the canonical encoded
	// string, so the decoded page is what stays inside the chunk bound.
	const pages = copyChunks.map((chunk) => {
		const page = Buffer.from(chunk.data, "base64");
		assert.ok(page.length <= chunkBound, `one decoded page stays inside the chunk bound (${page.length} bytes)`);
		assert.equal(chunk.data.length, 4 * Math.ceil(page.length / 3),
			"the frame carries the page's own base64 layer, not raw bytes");
		return page;
	});
	assert.deepEqual(pages.map((page) => page.length),
		[chunkBound, chunkBound, chunkBound, NATIVE_COPY_MAX_ENCODED_CHARS - (3 * chunkBound)],
		"full pages up to the bound, then the remainder");
	assert.equal(Buffer.concat(pages).toString("ascii"), bigEncoded,
		"the ASCII base64 reassembles byte-exactly, so the decoded text is exactly 75,000 bytes");
	assert.equal(first.wire.count("copy_end"), 1);
	assertNativeMessagesInsideBound(first.wire, second.wire, first.outbound, second.outbound);
	assert.equal(second.copies.length, 1, "the other viewer receives none of this copy");

	// A copy whose scope goes stale mid-transfer is never finished or delivered:
	// the owner's next protected copy write re-proves the scope and stops.
	first.wire.holdCopyBody = true;
	row.pty.emitData(nativeCopyCapsule(row.bootstrap, 5, copyEventOf(bigBody, "conversation-copy", 11),
		{ kind: "viewer", token: sourceA.sourceToken }, dispatchA1.dispatchId));
	await owner.surfaceFor(row).flush();
	await withTimeout(first.wire.whenHolding(), 5_000, "the owner never reached the copy write it is holding");
	second.viewer.resize(90, 30);
	const resized = await nextSnapshotMatching(second.inbox, "the geometry after viewer B resized",
		(snapshot) => snapshot.meta.geometry.cols === 90 && snapshot.meta.geometry.rows === 30);
	assert.deepEqual(resized.meta.geometry, { cols: 90, rows: 30, revision: 3 });
	first.wire.releaseHeld();
	await withTimeout(owner.whenDiagnostic("copy_dropped"), 5_000, "the owner never dropped the copy its own facts stale-dated");
	await withTimeout(first.binding.closed, 5_000, "the owner never retired the subscription whose copy went stale");
	await withTimeout(first.viewer.closed, 5_000, "the viewer never retired with its stale copy");
	assert.equal(first.copies.length, 3, "a copy whose scope went stale is never delivered");
	assert.equal(first.wire.count("copy_chunk"), copyBegin.chunkCount, "no further page of it is ever emitted");
	assert.equal(first.wire.count("copy_end"), 1, "its transfer is never completed");
	// Only this endpoint retires: the row, its child, and the sibling viewer live on.
	await owner.feed(row, ["\x1b[2J\x1b[Hstill streaming\n"]);
	const survivor = await nextSnapshotMatching(second.inbox, "the surviving viewer keeps receiving",
		(snapshot) => textOf(snapshot.frame).includes("still streaming"));
	assert.ok(textOf(survivor.frame).includes("still streaming"));
	assert.equal(row.pty.exited, false, "a stale copy never stops the child");
	assert.equal(owner.service.readRow(row.id)?.hasLiveProcess, true);
	assert.deepEqual(owner.service.readSessionViewers(row.id).map((entry) => entry.viewerId), [viewerIdOf(second.binding)]);
	assert.equal(second.copies.length, 1, "and it is never retargeted onto the surviving viewer");
	assert.deepEqual(owner.localCopies, []);

	// Owner-known transport loss INSIDE an outgoing copy body. The begin frame and
	// the first page are already handed over; the next page is in flight when the
	// transport the owner writes through fails. A copy the peer never received must
	// never be presented as a clipboard change that happened.
	//
	// The copy has to be caused by an input on the scope the viewer holds NOW: the
	// resize above retired B's earlier source, so a capsule naming that token would
	// be dropped upstream and never reach a wire page at all.
	const lossSource = statedSource(survivor.meta.inputSource);
	assert.notEqual(lossSource.sourceToken, sourceB.sourceToken,
		"the resize really moved this viewer's own scope");
	second.commit(lossSource);
	const writesBeforeLoss = row.pty.writes.length;
	assert.deepEqual(
		await second.viewer.sendInput({
			source: lossSource,
			inputModes: survivor.meta.inputModes,
			kind: "keyboard",
			text: "copy before loss\r",
		}),
		{ status: "submitted" },
	);
	await row.pty.whenWrites(writesBeforeLoss + 1, "the loss-copy initiating input reached the child");
	const lossDispatch = owner.lastDispatch(row);
	assert.deepEqual(lossDispatch.origin, { kind: "viewer", token: lossSource.sourceToken },
		"the copy is paired with the dispatch that actually caused it");
	second.wire.holdCopyChunkFrom = 1;
	row.pty.emitData(nativeCopyCapsule(row.bootstrap, 6, copyEventOf(bigBody, "conversation-copy", 11),
		{ kind: "viewer", token: lossSource.sourceToken }, lossDispatch.dispatchId));
	await owner.surfaceFor(row).flush();
	await withTimeout(second.wire.whenHolding(), 5_000, "the owner never reached the copy page it is holding");
	assert.equal(second.wire.count("copy_begin"), 1, "the transfer really started on the wire");
	assert.equal(second.wire.count("copy_chunk"), 1, "and exactly one page of it got out");
	const pagesWritten = second.wire.count("copy_chunk");
	second.wire.failHeldOnRelease = new Error("the content channel went down mid-copy");
	second.wire.releaseHeld();
	await withTimeout(owner.whenDiagnostic("send_failed"), 5_000,
		"the owner never noticed the copy page its transport refused");
	await withTimeout(second.binding.closed, 5_000, "the content lane whose copy failed never retired");
	await withTimeout(second.viewer.closed, 5_000, "the viewer never retired with its failed lane");
	assert.equal(second.wire.count("copy_chunk"), pagesWritten, "a failed copy page is never retried");
	assert.equal(second.wire.count("copy_end"), 0, "a copy the peer never received is never completed");
	assert.equal(second.copies.length, 1, "and it is never delivered as a clipboard change that happened");
	assert.deepEqual(owner.localCopies, [], "a failed viewer-origin copy never falls back to the owner's clipboard");
	assert.equal(row.pty.exited, false, "a failed copy never stops the child");
	assert.equal(owner.service.readRow(row.id)?.hasLiveProcess, true, "the row keeps its process");

	// The row and its saved content outlive the lane: a new viewer sees what the
	// child wrote before the loss and what it writes afterwards.
	await owner.feed(row, ["more surviving output\n"]);
	const witness = await connectNativeViewer(t, owner, { label: "copy-witness", sessionId: row.id, cols: 100, rows: 36 });
	await withTimeout(witness.viewer.ready, 5_000, "a new viewer could not view the row after the loss");
	const witnessView = await witness.inbox.next("the surviving row's content after the loss");
	assert.ok(textOf(witnessView.frame).includes("still streaming"), "content written before the loss is still there");
	assert.ok(textOf(witnessView.frame).includes("more surviving output"),
		"and the child keeps writing to the same row afterwards");
	assertNativeMessagesInsideBound(second.wire, witness.wire, second.outbound, witness.outbound);
	owner.succeeded();
});

test("a revoked grant stops every protected native write, releases only that viewer, and leaves the child, its history, and its sibling alone", async (t) => {
	const owner = await startNativeOwner(t);
	const row = await owner.createRow("revoke");
	owner.setConversation(row, "conversation-revoke", 5);
	await owner.markReady(row);
	await owner.feed(row, ["\x1b[?2004h", "revoked view prompt\n"]);

	const small = await connectNativeViewer(t, owner, { label: "revoke-viewer-a", sessionId: row.id, cols: 100, rows: 40 });
	await withTimeout(small.viewer.ready, 5_000, "viewer A never became ready");
	const aView = await small.inbox.next("viewer A's viewport");
	const sourceA = statedSource(aView.meta.inputSource);
	// A is the minimum contributor, and a second viewer that is LARGER changes the
	// row's canonical size not at all — so no new publication moves A's source.
	const large = await connectNativeViewer(t, owner, { label: "revoke-viewer-b", sessionId: row.id, cols: 240, rows: 200 });
	await withTimeout(large.viewer.ready, 5_000, "viewer B never became ready");
	const bView = await large.inbox.next("viewer B's viewport");
	const sourceB = statedSource(bView.meta.inputSource);
	assert.notEqual(sourceA.sourceToken, sourceB.sourceToken, "two viewers of one row hold two distinct scopes");
	assert.deepEqual(owner.service.readSessionGeometry(row.id), { cols: 100, rows: 40, revision: 1 });
	const modes = aView.meta.inputModes;

	// One paste is genuinely mid-flight: its first page was written and accepted,
	// and the owner holds a real partial assembly.
	small.commit(sourceA);
	small.outbound.holdInputChunkFrom = 1;
	const writesBefore = row.pty.writes.length;
	const resizesBefore = row.pty.resizeCalls.length;
	assert.equal(writesBefore, 0);
	const pendingPaste = small.viewer.sendInput({
		source: sourceA,
		inputModes: modes,
		kind: "paste",
		text: pasteBodyOf(200_000),
	});
	await withTimeout(small.outbound.whenHolding(), 5_000, "the viewer never reached a real mid-paste channel write");
	assert.equal(small.outbound.count("input_begin"), 1, "the paste began on the real lane before the revocation");

	// The owner's own policy source now says no. This is exactly what its next
	// protected write will observe; nothing is scripted into the endpoint.
	const grant = owner.grants.get(small.identity.key.keyId);
	assert.ok(grant !== undefined, "the accepted pairing recorded this peer's one directional grant");
	assert.equal(grant.direction, "peer->host");
	assert.equal(owner.grants.delete(small.identity.key.keyId), true);

	// The revocation becomes known at the owner's next protected write: a viewport
	// page it must emit for the row it is still streaming. The row keeps producing
	// ordinary output, appended, so its saved content stays observable.
	await owner.feed(row, ["output after the revocation\n"]);
	await withTimeout(owner.whenDiagnostic("authorization_refused"), 5_000,
		"the owner never refused its next protected write after the grant went away");
	assert.equal(nativeErrorFrameOf(small.wire).code, "not_authorized");
	await withTimeout(small.channel.closed, 5_000, "the owner never closed the revoked content channel");
	await withTimeout(small.binding.closed, 5_000, "the revoked binding never finished retiring");
	await withTimeout(small.viewer.closed, 5_000, "the revoked viewer never retired");

	// The page this side was still holding now meets a closed channel. Bytes that
	// were already invoked are never called sent, and never called unsent.
	small.outbound.releaseHeld();
	assert.deepEqual(await withTimeout(pendingPaste, 5_000, "the revoked submission never settled truthfully"),
		{ status: "unknown" });
	assert.equal(row.pty.writes.length, writesBefore,
		"once the owner knows the revocation, zero bytes are accepted for the child");
	assert.equal(small.outbound.count("input_end"), 0, "nothing further was handed over either");

	// Only this endpoint's own viewer was released, and the canonical geometry
	// follows the viewer that remains: not the revoked viewer's size, not "last".
	assert.deepEqual(owner.service.readSessionViewers(row.id).map((entry) => entry.viewerId), [viewerIdOf(large.binding)]);
	assert.deepEqual(owner.service.readSessionGeometry(row.id), { cols: 240, rows: 200, revision: 2 });
	assert.deepEqual(row.pty.resizeCalls.slice(resizesBefore), [{ cols: 240, rows: 200 }],
		"the row was resized once for the surviving viewer, never stopped");
	// The child and its saved conversation are exactly as they were.
	assert.equal(row.pty.exited, false);
	assert.equal(row.entry.released, false, "a viewer's revocation never releases the row's own registration");
	assert.equal(owner.service.readRow(row.id)?.lifecycle, "alive");
	assert.equal(owner.service.readRow(row.id)?.hasLiveProcess, true);
	assert.ok(owner.manager.list().some((view) => view.id === row.id), "the row stays in the host's inventory");
	assert.ok(textOf(bView.frame).includes("revoked view prompt"),
		"the row's own content is untouched");

	// A copy the child emits afterwards, naming the revoked viewer's scope, reaches
	// nobody: not the sibling, not the owner's local clipboard route.
	row.pty.emitData(nativeCopyCapsule(row.bootstrap, 1, copyEventOf("after revocation", "conversation-revoke", 5), { kind: "viewer", token: sourceA.sourceToken }, 1));
	await owner.feed(row, ["the revoked copy changed nothing\n"]);
	const copyBarrier = await nextSnapshotMatching(large.inbox, "the surviving viewer's copy barrier",
		(snapshot) => textOf(snapshot.frame).includes("the revoked copy changed nothing"));
	assert.ok(textOf(copyBarrier.frame).includes("the revoked copy changed nothing"));
	assert.equal(large.copies.length, 0, "a revoked viewer's copy is never retargeted onto a sibling");
	assert.equal(large.wire.count("copy") + large.wire.count("copy_begin"), 0);
	assert.equal(small.wire.count("copy"), 0);
	assert.deepEqual(owner.localCopies, [], "and it never falls back to the owner's local clipboard route");

	// Re-granting the same peer key resurrects nothing: no resume, no retry, no
	// re-derivation of the retired binding.
	owner.grants.set(grant);
	await owner.feed(row, ["still streaming after a re-grant\n"]);
	const regranted = await nextSnapshotMatching(large.inbox, "the surviving viewer keeps streaming after a re-grant",
		(snapshot) => textOf(snapshot.frame).includes("still streaming after a re-grant"));
	assert.ok(textOf(regranted.frame).includes("still streaming after a re-grant"));
	assert.ok(textOf(regranted.frame).includes("revoked view prompt"),
		"the row's saved content is still there, prompt and all");
	assert.deepEqual(owner.service.readSessionViewers(row.id).map((entry) => entry.viewerId), [viewerIdOf(large.binding)],
		"a re-grant never resumes the retired viewer");
	assert.equal(small.viewerDiagnostics.includes("owner_error"), true,
		"the revoked viewer was explicitly told its view ended, and records that refusal");
	assert.equal(small.viewer.readSnapshot(), undefined, "a retired viewer publishes no view at all");
	assert.equal(row.pty.writes.length, writesBefore, "nothing was ever typed on the revoked viewer's behalf");
	assert.deepEqual(row.pty.resizeCalls.slice(resizesBefore), [{ cols: 240, rows: 200 }],
		"nothing stopped or re-sized the row a second time");

	// Owner-known revocation INSIDE an outgoing copy body, on its own row: the begin
	// frame and one body page are already written when the grant is deleted, so it
	// is the owner's NEXT protected copy write that has to stop.
	const copyRow = await owner.createRow("revoke-copy");
	owner.setConversation(copyRow, "conversation-revoke-copy", 6);
	await owner.markReady(copyRow);
	await owner.feed(copyRow, ["\x1b[?2004h", "copy prompt\n"]);
	const courier = await connectNativeViewer(t, owner, {
		label: "revoke-copy-viewer",
		sessionId: copyRow.id,
		cols: 120,
		rows: 40,
	});
	await withTimeout(courier.viewer.ready, 5_000, "the copy courier never became ready");
	const courierView = await courier.inbox.next("the copy courier's own viewport");
	const courierSource = statedSource(courierView.meta.inputSource);
	courier.commit(courierSource);
	assert.deepEqual(
		await courier.viewer.sendInput({
			source: courierSource,
			inputModes: courierView.meta.inputModes,
			kind: "keyboard",
			text: "copy this\r",
		}),
		{ status: "submitted" },
	);
	await copyRow.pty.whenWrites(1, "the input that caused the copy reached the child");
	const courierDispatch = owner.lastDispatch(copyRow);
	assert.deepEqual(courierDispatch.origin, { kind: "viewer", token: courierSource.sourceToken });

	// A copy at the producer bound, so its body really is a transfer: the begin
	// frame and the first page go out; the second page is held in flight.
	courier.wire.holdCopyChunkFrom = 1;
	const revokedBody = copyEventOf(pasteBodyOf(75_000), "conversation-revoke-copy", 6);
	copyRow.pty.emitData(nativeCopyCapsule(copyRow.bootstrap, 1, revokedBody,
		{ kind: "viewer", token: courierSource.sourceToken }, courierDispatch.dispatchId));
	await owner.surfaceFor(copyRow).flush();
	await withTimeout(courier.wire.whenHolding(), 5_000, "the owner never reached the copy page it is holding");
	assert.equal(courier.wire.count("copy_begin"), 1, "the copy transfer started before the revocation");
	assert.equal(courier.wire.count("copy_chunk"), 1, "and one page of its body was already written");
	const revokedChunksWritten = courier.wire.count("copy_chunk");
	const copyWritesBefore = copyRow.pty.writes.length;

	// The owner's policy source now says no, mid-transfer, and the in-flight page is
	// released into it.
	const courierGrant = owner.grants.get(courier.identity.key.keyId);
	assert.ok(courierGrant !== undefined, "the courier's peer holds its own directional grant");
	assert.equal(owner.grants.delete(courier.identity.key.keyId), true);
	// The page already in flight passed the owner's authorization check before the
	// revocation and was genuinely invoked: it is allowed to complete. What must not
	// happen is any FURTHER protected write for this copy.
	assert.equal(courier.wire.heldCount, 1, "exactly one copy page was already invoked");
	courier.wire.releaseHeld();
	await withTimeout(owner.whenDiagnostic("authorization_refused"), 5_000,
		"the owner kept writing a copy body after the grant went away");
	assert.equal(nativeErrorFrameOf(courier.wire).code, "not_authorized");
	await withTimeout(courier.binding.closed, 5_000, "the binding whose copy was revoked never retired");
	await withTimeout(courier.viewer.closed, 5_000, "the viewer whose copy was revoked never retired");
	assert.equal(courier.wire.count("copy_chunk"), revokedChunksWritten + 1,
		"only the already-invoked page completes; no subsequent protected page is written");
	assert.deepEqual(courier.wire.framesOf("copy_chunk").map((chunk) => chunk.index), [0, 1],
		"the body stops after the page the owner had already committed to");
	assert.equal(courier.wire.count("copy_end"), 0, "the revoked transfer is never completed");
	assert.equal(courier.copies.length, 0, "and no copy callback fires for a body the peer never received");
	assert.deepEqual(owner.localCopies, [], "a revoked viewer-origin copy never becomes the owner's local copy");
	assert.equal(copyRow.pty.writes.length, copyWritesBefore,
		"a revoked copy writes nothing more for the child, and a partial input never becomes a dispatch");
	assert.equal(copyRow.pty.exited, false, "revoking a copy never stops the child");
	assert.equal(owner.service.readRow(copyRow.id)?.hasLiveProcess, true, "the copy row keeps its process");
	assert.ok(textOf(courierView.frame).includes("copy prompt"), "the copy row's saved content is intact");

	// Default-inert native IO: a display-only channel never negotiated the
	// extension, so an input frame there is a frame this side never receives.
	const display = await connectNativeViewer(t, owner, {
		label: "revoke-display-only",
		sessionId: row.id,
		cols: 240,
		rows: 200,
		nativeIo: false,
	});
	await withTimeout(display.viewer.ready, 5_000, "the display-only viewer never became ready");
	const displayView = await display.inbox.next("the display-only viewport");
	assert.equal(displayView.meta.inputSource, undefined,
		"a display-only publish states no native input source at all");
	const writesBeforeDisplay = row.pty.writes.length;
	const unnegotiated = buildNativeInputInline({
		subscriptionId: display.viewer.subscriptionId,
		inputId: randomUUID(),
		ordinal: 1,
		source: sourceB,
		inputModes: displayView.meta.inputModes,
		kind: "keyboard",
		data: "should never exist\r",
	});
	await display.outbound.send(unnegotiated.frames[0]);
	await withTimeout(owner.whenDiagnostic("protocol_violation"), 5_000,
		"the owner never refused a native frame on a channel that never negotiated one");
	assert.equal(nativeErrorFrameOf(display.wire).code, "bad_frame");
	await withTimeout(display.binding.closed, 5_000, "the owner never retired the violating binding");
	assert.equal(row.pty.writes.length, writesBeforeDisplay, "an unnegotiated input frame writes zero bytes");
	assert.equal(row.pty.exited, false);
	assert.equal(owner.service.readRow(row.id)?.hasLiveProcess, true, "a malformed native frame never stops the child");
	await owner.feed(row, ["the violating frame changed nothing\n"]);
	const surviving = await nextSnapshotMatching(large.inbox, "the surviving viewer after the malformed frame",
		(snapshot) => textOf(snapshot.frame).includes("the violating frame changed nothing"));
	assert.ok(textOf(surviving.frame).includes("the violating frame changed nothing"));
	assert.ok(textOf(surviving.frame).includes("revoked view prompt"),
		"and the row's content is still intact afterwards");
	assertNativeMessagesInsideBound(small.outbound, small.wire, large.outbound, large.wire, display.outbound);
	owner.succeeded();
});

test("startup-phase input crosses TLS before the first status, carries only the startup fence, and retires for good", async (t) => {
	const owner = await startNativeOwner(t);
	const row = await owner.createRow("native-startup");
	// Framed and ready, but no status yet: the row is in its explicit startup phase.
	await owner.markReady(row);
	await owner.feed(row, ["\x1b[2J\x1b[H", "Trust project folder?\n"]);

	const viewer = await connectNativeViewer(t, owner, { label: "startup-viewer", sessionId: row.id, cols: 100, rows: 30 });
	await withTimeout(viewer.viewer.ready, 5_000, "the startup viewer never became ready");
	const acknowledged = lastFrameOfType(viewer.wire, "hello_ack");
	assert.ok(acknowledged !== undefined, "the owner acknowledged the hello");
	assert.deepEqual(acknowledged.capabilities, [
		SESSION_CONTENT_REQUIRED_CAPABILITY,
		SESSION_CONTENT_NATIVE_IO_CAPABILITY,
		SESSION_CONTENT_NATIVE_INPUT_STARTUP_CAPABILITY,
	], "startup input is acknowledged beside native IO");

	const startupView = await nextSnapshotMatching(viewer.inbox, "the null-tuple viewport with a startup source",
		(snapshot) => snapshot.meta.inputSource !== undefined && snapshot.meta.inputSource !== null
			&& isNativeIoStartupSource(snapshot.meta.inputSource));
	assert.equal(startupView.meta.nativeSession, null, "the startup publish names no conversation");
	const startup = startupView.meta.inputSource;
	assert.ok(startup !== undefined && startup !== null && isNativeIoStartupSource(startup));
	assert.equal(Object.hasOwn(startup, "nativeSession"), false, "no tuple key at all, never a null or fake one");
	assert.match(startup.sourceToken, /^nvst1\.[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.[0-9a-f]{32}$/);
	const lowerStartup = owner.service.readViewerInputSource(viewerIdOf(viewer.binding));
	assert.ok(lowerStartup !== undefined && isNativeViewerStartupInputSource(lowerStartup),
		"the manager states the startup variant for this exact viewer");
	assert.equal(row.pty.writes.length, 0, "stating a source writes nothing to the child");

	// One authorized keyboard answer, framed with the startup fence and nothing else.
	viewer.commit(startup);
	assert.deepEqual(
		await viewer.viewer.sendInput({ source: startup, inputModes: startupView.meta.inputModes, kind: "keyboard", text: "1" }),
		{ status: "submitted" },
		"submitted means transport handoff only",
	);
	await row.pty.whenWrites(1, "the startup answer reached the child");
	const answer = owner.lastDispatch(row);
	assert.deepEqual(answer.origin, { kind: "viewer", token: startup.sourceToken },
		"the answer is explicit viewer input, never local");
	assert.equal(answer.expectedNativeTuple, undefined, "no conversation tuple, real or fabricated");
	assert.equal(answer.expectedNativePhase, "startup", "the child-side fence is the startup phase");
	assert.equal(answer.payload.toString("utf8"), "1");

	// A capsule naming the startup token is never a copy: there is no conversation to
	// attribute it to, so it reaches neither the viewer nor the owner's local route.
	row.pty.emitData(nativeCopyCapsule(row.bootstrap, 1, copyEventOf("startup copy", "conversation-later", 1),
		{ kind: "viewer", token: startup.sourceToken }, answer.dispatchId));
	await owner.surfaceFor(row).flush();
	assert.equal(viewer.copies.length, 0, "startup confers no copy authority");
	assert.deepEqual(owner.localCopies, []);

	// The first ACCEPTED status — even one with a null tuple — retires startup for good.
	owner.emitStatus(row, { busy: false, pendingInput: false, inputSurface: false, activity: [], nativeSession: null });
	await nextSnapshotMatching(viewer.inbox, "the viewport after the first null-tuple status",
		(snapshot) => snapshot.meta.inputSource === null && snapshot.meta.nativeSession === null);
	assert.equal(owner.service.readViewerInputSource(viewerIdOf(viewer.binding)), undefined,
		"no source while the tuple is unknown after startup closed");
	const writesBeforeStale = row.pty.writes.length;
	assert.deepEqual(
		await viewer.viewer.sendInput({ source: startup, inputModes: startupView.meta.inputModes, kind: "keyboard", text: "late" }),
		{ status: "not-sent", reason: "stale-source" },
		"the captured startup authority is refused before any write",
	);
	assert.equal(row.pty.writes.length, writesBeforeStale);

	// A real tuple brings the ordinary conversation source back.
	owner.setConversation(row, "conversation-after-startup", 1);
	const conversation = await viewer.nextSource("the conversation source after startup");
	assert.match(conversation.sourceToken, /^nvs1\./);
	assert.deepEqual(conversation.nativeSession, { sessionId: "conversation-after-startup", epoch: 1 });

	// Losing that tuple again never reopens startup.
	owner.emitStatus(row, { busy: false, pendingInput: false, inputSurface: false, activity: [], nativeSession: null });
	await nextSnapshotMatching(viewer.inbox, "the viewport after the tuple was lost",
		(snapshot) => snapshot.meta.nativeSession === null);
	assert.equal(owner.service.readViewerInputSource(viewerIdOf(viewer.binding)), undefined,
		"a once-known, now lost tuple never becomes startup again");
	assert.deepEqual(owner.localCopies, []);
	owner.succeeded();
});
