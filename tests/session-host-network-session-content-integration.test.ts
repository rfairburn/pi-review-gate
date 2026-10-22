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
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { deflateSync } from "node:zlib";

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
	type InstanceManagerOptions,
	type InstancePty,
	type InstanceSpawnDescriptor,
	type InstanceStatusHandlers,
	type InstanceStatusRegistration,
	type InstanceStatusUpdate,
	type PtyFactory,
	type StatusRegistrar,
} from "../src/session-host/instances";
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
	DEFAULT_SESSION_CONTENT_BOUNDS,
	decodeSessionContentViewport,
	decodeSessionContentFrame,
	encodeSessionContentViewport,
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
