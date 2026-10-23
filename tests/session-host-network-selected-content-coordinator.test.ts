/**
 * Selected native viewport content through the ONE peer coordinator (#389).
 *
 * These are real-loopback lifecycle tests: two coordinators, their real
 * transport, real protected stores, the real metadata bridge, and the real
 * owner-side content endpoint. Only the owning-host service is a minimal
 * read-only fake that shares ONE owner run identity between its inventory watch
 * (metadata) and its content watch/viewer registry (viewport), exactly as the
 * real service does. No account key, saved preference, listener, or live
 * session outside the test process is touched.
 *
 * What this file holds the coordinator to:
 *
 * - one globally selected outgoing target, one dedicated content channel, and
 *   one latest viewport, while every other connected host and every unselected
 *   row stay metadata-only;
 * - ONE reconciler serves the newest selection: a burst of clicks while an open is
 *   in flight installs one subscription, never one per click, and a burst that ends
 *   on "nothing selected" cannot leave an older target current;
 * - the selection is fenced against the exact owner run, owner row, remembered
 *   pin, current identity, and live destination/channel/client references, and a
 *   superseded or falsified attempt attaches nothing; the same fences are re-proved
 *   after the channel opens, after the subscription is acknowledged, and before every
 *   published viewport, so a late acknowledgement or a mid-stream authority change
 *   cannot leave content current;
 * - selecting never pairs, prompts for or replaces a key, creates an identity,
 *   implicitly connects, retries, or disposes the borrowed destination client;
 * - loss, loss of content authority, disconnect, and remove clear the authorized
 *   view immediately and retire local resources, while the deliberate target is
 *   kept as an honest `unavailable` rather than rewritten or retargeted; a genuine
 *   reachability transition re-arms that same deliberate target instead of leaving a
 *   spent attempt permanently stuck;
 * - an unconfirmed retirement is never reported as a settled close. The final case
 *   states the expectation for the refined content-host contract owned by the
 *   recovery task: a source release that cannot be confirmed makes the inbound
 *   binding's own retirement reject, which the coordinator retains as sticky
 *   uncertainty and refuses to call a settled close.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { NativeInstanceView, SessionGeometry } from "../src/session-host/instances";
import type {
	OwningHostInventoryListener,
	OwningHostInventorySnapshot,
	OwningHostInventoryWatch,
	OwningHostService,
	OwningHostSessionContentListener,
	OwningHostSessionContentSnapshot,
	OwningHostSessionContentWatch,
	SessionViewerState,
	SessionViewerUpdate,
	SessionViewerUpdateResult,
} from "../src/session-host/owning-host-service";
import type { TerminalFrame, TerminalInputModes } from "../src/session-host/terminal-surface";
import {
	createPeerCoordinator,
	isPeerCoordinatorCloseError,
	type PeerCoordinatorTestHooks,
} from "../src/session-host/network/peer-coordinator";
import type { SessionContentSource } from "../src/session-host/network/session-content-host";
import type {
	PeerContentObservation,
	PeerContentTarget,
	PeerCoordinatorWithContent,
} from "../src/session-host/network/peer-content";
import type { PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";
import {
	consentsOf,
	createOwnedAgentDir,
	createSnapshotLog,
	delay,
	reserveLoopbackPort,
	rowView,
	type SnapshotLog,
} from "./session-host-network-peer-coordinator-helpers";
import { createPosixTestPolicy } from "./session-host-network-peer-state-fixtures";

const OWNER_COLS = 80;
const OWNER_ROWS = 24;

const INPUT_MODES: TerminalInputModes = Object.freeze({
	kittyFlags: 0,
	applicationCursorKeys: false,
	applicationKeypad: false,
	bracketedPaste: false,
	mouseTracking: "none",
	modifyOtherKeys: 0,
	mouseEncoding: "default",
});

/** One plain native viewport at exactly the row's canonical geometry. */
function viewport(cols: number, rows: number): TerminalFrame {
	return Object.freeze({
		cols,
		rows,
		// Runtime-frozen; the public frame type declares a mutable array.
		lines: Object.freeze(Array.from({ length: rows }, (_unused, index) => `row ${index}`)) as string[],
		cursor: Object.freeze({ column: 0, row: 0, visible: true }),
	});
}

/* ------------------------------------------------------------------------- *
 * One fake owning-host service: metadata inventory AND viewport content, on
 * exactly one owner run identity.
 * ------------------------------------------------------------------------- */

interface OwnerRow {
	readonly id: string;
	cols: number;
	rows: number;
	revision: number;
}

interface OwnerViewer {
	readonly viewerId: string;
	sessionId: string | undefined;
	cols: number | undefined;
	rows: number | undefined;
	revision: number;
}

interface OwnerInventoryWatch {
	listener: OwningHostInventoryListener;
	active: boolean;
}

interface OwnerContentWatch {
	readonly rowId: string;
	readonly listener: OwningHostSessionContentListener;
	active: boolean;
}

/**
 * The narrowest stand-in that still behaves like the one manager: the inventory
 * watch and the content watch report the SAME owner run and the SAME row ids, a
 * viewer change recomputes that row's canonical geometry and re-delivers its
 * content, and a removed row is reported as unobservable rather than empty.
 *
 * It owns no transport, no UI, and no session lifecycle: there is no start,
 * stop, write, resize, or remove call to record, which is exactly the point —
 * the content endpoint must never need one.
 */
class FakeOwnerService implements SessionContentSource, Pick<OwningHostService, "watchInventory"> {
	#runId = `run-${Math.random().toString(36).slice(2, 10)}`;
	/** Make viewer release report uncertainty, as a real owner whose resource never settles. */
	failViewerClose = false;
	readonly rows = new Map<string, OwnerRow>();
	/** Every row id a content watch was ever installed for, in order. */
	readonly installedRowIds: string[] = [];
	readonly closedViewerIds: string[] = [];
	readonly updateCalls: SessionViewerUpdate[] = [];
	/** Every source capability call, in order, for inertness assertions. */
	readonly calls: string[] = [];
	#inventoryRows: string[] = [];
	#inventoryRevision = 0;
	#sequence = 0;
	#nextViewerId = 1;
	readonly #inventoryWatches = new Set<OwnerInventoryWatch>();
	readonly #contentWatches = new Set<OwnerContentWatch>();
	readonly #viewers = new Map<string, OwnerViewer>();
	#liveWatchPeak = 0;

	constructor(initial: readonly string[] = []) {
		this.setRows(initial);
	}

	/** The owner run identity every metadata and content fact carries. */
	get runId(): string {
		return this.#runId;
	}

	/**
	 * A host restart that keeps the SAME row ids: every row id stays, the owner run
	 * identity does not. This is what proves the content fence is on the run, not on a
	 * row id that a later run could hand out again.
	 */
	rotateRun(): void {
		this.calls.push("rotateRun");
		this.#runId = `run-${Math.random().toString(36).slice(2, 10)}`;
		this.#inventoryRevision += 1;
		this.#deliverInventory();
	}

	/** The most content watches this owner ever kept live at the same time. */
	get liveWatchPeak(): number {
		return this.#liveWatchPeak;
	}

	get liveWatchCount(): number {
		return [...this.#contentWatches].filter((watch) => watch.active).length;
	}

	get liveViewerCount(): number {
		return this.#viewers.size;
	}

	get liveInventoryWatchCount(): number {
		return this.#inventoryWatches.size;
	}

	/** One authoritative row-set change, delivered to every live inventory watch. */
	setRows(ids: readonly string[]): void {
		this.calls.push("setRows");
		const removed = this.#inventoryRows.filter((id) => !ids.includes(id));
		this.#inventoryRows = [...ids];
		for (const id of ids) {
			if (this.rows.has(id)) continue;
			this.rows.set(id, { id, cols: OWNER_COLS, rows: OWNER_ROWS, revision: 0 });
		}
		this.#inventoryRevision += 1;
		// A row that left the inventory is unobservable, never an empty viewport.
		for (const id of removed) this.#deliverContent(id, undefined);
		this.#deliverInventory();
	}

	/** One live content change for one row, as the manager's own hook would. */
	emit(rowId: string): void {
		this.#deliverContent(rowId, this.#capture(rowId));
	}

	/** Publish a viewport that claims a different owner run. */
	emitRun(rowId: string, runId: string): void {
		this.#deliverContent(rowId, this.#capture(rowId, runId));
	}

	/** Make one row's content unobservable while it stays in the inventory. */
	emitUnavailable(rowId: string): void {
		this.#deliverContent(rowId, undefined);
	}

	// ------------------------------------------------------------- metadata side

	watchInventory(listener: OwningHostInventoryListener): OwningHostInventoryWatch | undefined {
		this.calls.push("watchInventory");
		if (typeof listener !== "function") throw new TypeError("inventory listener must be callable");
		const watch: OwnerInventoryWatch = { listener, active: true };
		this.#inventoryWatches.add(watch);
		return Object.freeze({
			snapshot: this.#inventorySnapshot(),
			unsubscribe: (): void => {
				if (!watch.active) return;
				watch.active = false;
				this.#inventoryWatches.delete(watch);
			},
		});
	}

	// -------------------------------------------------------------- content side

	readInventorySnapshot(): OwningHostInventorySnapshot | undefined {
		this.calls.push("readInventorySnapshot");
		return this.#inventorySnapshot();
	}

	watchSessionContent(
		rowId: string,
		listener: OwningHostSessionContentListener,
	): OwningHostSessionContentWatch | undefined {
		this.calls.push(`watchSessionContent:${rowId}`);
		this.installedRowIds.push(rowId);
		if (typeof listener !== "function") throw new TypeError("content listener must be callable");
		if (!this.rows.has(rowId)) return undefined;
		const snapshot = this.#capture(rowId);
		const watch: OwnerContentWatch = { rowId, listener, active: true };
		this.#contentWatches.add(watch);
		this.#liveWatchPeak = Math.max(this.#liveWatchPeak, this.liveWatchCount);
		return Object.freeze({
			snapshot,
			unsubscribe: (): void => {
				if (!watch.active) return;
				watch.active = false;
				this.#contentWatches.delete(watch);
				this.calls.push(`unsubscribe:${rowId}`);
			},
		});
	}

	openViewer(): SessionViewerState | undefined {
		this.calls.push("openViewer");
		const viewer: OwnerViewer = {
			viewerId: `viewer-${this.#nextViewerId++}`,
			sessionId: undefined,
			cols: undefined,
			rows: undefined,
			revision: 0,
		};
		this.#viewers.set(viewer.viewerId, viewer);
		return this.#viewerState(viewer);
	}

	readViewer(viewerId: string): SessionViewerState | undefined {
		const viewer = this.#viewers.get(viewerId);
		return viewer === undefined ? undefined : this.#viewerState(viewer);
	}

	updateViewer(viewerId: string, update: SessionViewerUpdate = {}): SessionViewerUpdateResult {
		this.calls.push(`updateViewer:${viewerId}`);
		this.updateCalls.push(update);
		const viewer = this.#viewers.get(viewerId);
		if (viewer === undefined) return { applied: false, reason: "unknown-viewer" };
		if (update.expectedRevision !== undefined && update.expectedRevision !== viewer.revision) {
			return { applied: false, reason: "stale" };
		}
		if (update.sessionId !== undefined) viewer.sessionId = update.sessionId ?? undefined;
		if (update.cols !== undefined) viewer.cols = update.cols;
		if (update.rows !== undefined) viewer.rows = update.rows;
		viewer.revision += 1;
		const target = viewer.sessionId;
		const cols = viewer.cols;
		const rows = viewer.rows;
		if (target !== undefined && cols !== undefined && rows !== undefined) {
			// The manager recomputes the row's canonical geometry from its viewers.
			const row = this.rows.get(target);
			if (row !== undefined && (row.cols !== cols || row.rows !== rows)) {
				row.cols = cols;
				row.rows = rows;
				row.revision += 1;
			}
			this.emit(target);
		}
		return { applied: true, state: this.#viewerState(viewer) };
	}

	closeViewer(viewerId: string): boolean {
		this.calls.push(`closeViewer:${viewerId}`);
		const viewer = this.#viewers.get(viewerId);
		if (viewer === undefined) return false;
		if (this.failViewerClose) {
			// The native viewport release did not settle. The owner still owns the
			// resource, so this is reported as a failure rather than as "already gone".
			throw new Error("native viewport release did not settle");
		}
		this.#viewers.delete(viewerId);
		this.closedViewerIds.push(viewerId);
		return true;
	}

	// ------------------------------------------------------------------ internals

	#inventorySnapshot(): OwningHostInventorySnapshot {
		const rows: NativeInstanceView[] = this.#inventoryRows.map((id) => rowView(id));
		return Object.freeze({
			hostRunId: this.#runId,
			revision: this.#inventoryRevision,
			rows: Object.freeze(rows),
		});
	}

	#deliverInventory(): void {
		const snapshot = this.#inventorySnapshot();
		for (const watch of [...this.#inventoryWatches]) {
			if (!watch.active) continue;
			try {
				watch.listener(snapshot);
			} catch {
				// The real service contains a throwing watcher; so does this fake.
			}
		}
	}

	#capture(rowId: string, runId = this.#runId): OwningHostSessionContentSnapshot {
		const row = this.rows.get(rowId);
		if (row === undefined) throw new Error("unknown row");
		this.#sequence += 1;
		const geometry: SessionGeometry = Object.freeze({ cols: row.cols, rows: row.rows, revision: row.revision });
		return Object.freeze({
			hostRunId: runId,
			sessionId: rowId,
			nativeSession: Object.freeze({ sessionId: `conversation-${rowId}`, epoch: 3 }),
			sequence: this.#sequence,
			geometry,
			// Frame dimensions always match this row's canonical geometry.
			frame: viewport(geometry.cols, geometry.rows),
			inputModes: INPUT_MODES,
		});
	}

	#deliverContent(rowId: string, snapshot: OwningHostSessionContentSnapshot | undefined): void {
		for (const watch of [...this.#contentWatches]) {
			if (!watch.active || watch.rowId !== rowId) continue;
			try {
				watch.listener(snapshot);
			} catch {
				// The real service contains listener failures; the fake does too.
			}
		}
	}

	#viewerState(viewer: OwnerViewer): SessionViewerState {
		return Object.freeze({
			viewerId: viewer.viewerId,
			sessionId: viewer.sessionId,
			cols: viewer.cols,
			rows: viewer.rows,
			revision: viewer.revision,
		});
	}
}

/* ------------------------------------------------------------------------- *
 * Coordinator fixtures
 * ------------------------------------------------------------------------- */

function hooks(autoReconnectDelaysMs?: readonly number[]): PeerCoordinatorTestHooks {
	return {
		preferencesPermissions: createPosixTestPolicy(),
		peerStatePermissions: createPosixTestPolicy(),
		...(autoReconnectDelaysMs === undefined ? {} : { autoReconnectDelaysMs }),
	};
}

interface Side {
	readonly coordinator: PeerCoordinatorWithContent;
	readonly log: SnapshotLog;
	/** Every observation handed to the advisory content callback, in order. */
	readonly observations: PeerContentObservation[];
}

/**
 * Start one coordinator with the content contracts wired. `contentSource` is
 * optional on purpose: a side that omits it never offers an incoming content
 * lane, which is what the metadata-only refusal test relies on.
 */
async function startSide(
	t: TestContext,
	options: {
		readonly agentDir: string;
		readonly inventory: FakeOwnerService;
		readonly contentSource?: FakeOwnerService;
		readonly listen?: boolean | number;
		readonly throwOnContentChange?: boolean;
		readonly autoReconnectDelaysMs?: readonly number[];
	},
): Promise<Side & { readonly source: FakeOwnerService }> {
	const log = createSnapshotLog();
	const observations: PeerContentObservation[] = [];
	const coordinator = createPeerCoordinator({
		agentDir: options.agentDir,
		inventory: options.inventory,
		onChange: log.onChange,
		onIncomingConsentArrival: log.onArrival,
		onContentChange: (observation): void => {
			observations.push(observation);
			if (options.throwOnContentChange === true) throw new Error("advisory observer failed");
		},
		...(options.contentSource === undefined ? {} : { contentSource: options.contentSource }),
		testHooks: hooks(options.autoReconnectDelaysMs),
	});
	t.after(async () => {
		try {
			await coordinator.close();
		} catch {
			// A rejected close is an observed outcome of this test, never a hook failure.
		}
	});
	await coordinator.start();
	if (options.listen !== undefined && options.listen !== false) {
		const port = typeof options.listen === "number" ? String(options.listen) : "0";
		await coordinator.perform({ type: "peer-listener", enabled: true, host: "127.0.0.1", port });
		assert.equal(coordinator.read().listener.state, "listening");
	}
	return { coordinator, log, observations, source: options.inventory };
}

async function addDestination(side: Side, label: string, port: number): Promise<string> {
	await side.coordinator.perform({ type: "peer-add", label, host: "127.0.0.1", port: String(port) });
	const host = side.coordinator.read().hosts?.find((candidate) => candidate.port === port);
	assert.ok(host, "the destination was not saved");
	return host.id;
}

/** Connect and approve the local first-use key plus the remote human window. */
async function connectWithApprovals(clientSide: Side, hostSide: Side, hostId: string): Promise<void> {
	const connecting = clientSide.coordinator.perform({ type: "peer-connect", hostId });
	const withKey = await clientSide.log.waitFor(
		(snapshot) => consentsOf(snapshot, "server-key").length > 0,
		"the local first-use server-key consent",
	);
	const keyConsent = consentsOf(withKey, "server-key")[0];
	assert.ok(keyConsent);
	assert.equal(clientSide.coordinator.decideConsent(keyConsent.id, "approve"), true);
	const withIncoming = await hostSide.log.waitFor(
		(snapshot) => consentsOf(snapshot, "incoming").length > 0,
		"the receiving pairing consent",
	);
	const incoming = consentsOf(withIncoming, "incoming")[0];
	assert.ok(incoming);
	assert.equal(hostSide.coordinator.decideConsent(incoming.id, "approve"), true);
	await connecting;
}

function hostOf(side: Side, hostId: string): string | undefined {
	return side.coordinator.read().hosts?.find((candidate) => candidate.id === hostId)?.state;
}

async function waitConnected(side: Side, hostId: string, message: string): Promise<PeerUiSnapshot> {
	return side.log.waitFor((snapshot) => {
		const host = snapshot.hosts?.find((candidate) => candidate.id === hostId);
		return host?.state === "connected" && host.roster.state === "current";
	}, message);
}

async function waitRosterState(
	side: Side,
	hostId: string,
	state: "current" | "stale",
	message: string,
): Promise<PeerUiSnapshot> {
	return side.log.waitFor(
		(snapshot) => snapshot.hosts?.find((candidate) => candidate.id === hostId)?.roster.state === state,
		message,
	);
}

interface OwnerSide extends Side {
	readonly source: FakeOwnerService;
}

/** One content-serving owner: its own listener plus its owner-side content lane. */
async function startOwner(t: TestContext, rows: readonly string[]): Promise<OwnerSide> {
	const fixture = createOwnedAgentDir(t);
	const source = new FakeOwnerService(rows);
	return startSide(t, { agentDir: fixture.agentDir, inventory: source, contentSource: source, listen: true });
}

/** One client side that serves no content lane of its own. */
async function startViewer(
	t: TestContext,
	options: {
		readonly listen?: boolean | number;
		readonly throwOnContentChange?: boolean;
		readonly autoReconnectDelaysMs?: readonly number[];
	} = {},
): Promise<OwnerSide> {
	const fixture = createOwnedAgentDir(t);
	const inventory = new FakeOwnerService([]);
	return startSide(t, {
		agentDir: fixture.agentDir,
		inventory,
		listen: options.listen,
		throwOnContentChange: options.throwOnContentChange,
		autoReconnectDelaysMs: options.autoReconnectDelaysMs,
	});
}

/** Viewer -> owner only: one direction, metadata connected on the viewer side. */
async function connectViewerToOwner(t: TestContext, ownerRows: readonly string[]): Promise<{
	readonly viewer: OwnerSide;
	readonly owner: OwnerSide;
	readonly ownerHostId: string;
}> {
	const owner = await startOwner(t, ownerRows);
	const viewer = await startViewer(t);
	const ownerHostId = await addDestination(viewer, "Owner laptop", owner.coordinator.read().listener.port as number);
	await connectWithApprovals(viewer, owner, ownerHostId);
	await waitConnected(viewer, ownerHostId, "the viewer's connected metadata roster");
	return { viewer, owner, ownerHostId };
}

/** Both directions: each side hosts, serves content, and holds the other's key. */
async function pairBothWays(t: TestContext, ownerRows: readonly string[], viewerRows: readonly string[]): Promise<{
	readonly viewer: OwnerSide;
	readonly owner: OwnerSide;
	readonly ownerHostId: string;
	readonly viewerHostId: string;
}> {
	const owner = await startOwner(t, ownerRows);
	const viewer = await startSide(t, {
		agentDir: createOwnedAgentDir(t).agentDir,
		inventory: new FakeOwnerService(viewerRows),
		listen: true,
	});
	const ownerHostId = await addDestination(viewer, "Owner laptop", owner.coordinator.read().listener.port as number);
	const viewerHostId = await addDestination(owner, "Viewer laptop", viewer.coordinator.read().listener.port as number);
	await connectWithApprovals(viewer, owner, ownerHostId);
	await waitConnected(viewer, ownerHostId, "the viewer's outbound connection");
	await connectWithApprovals(owner, viewer, viewerHostId);
	await waitConnected(owner, viewerHostId, "the owner's inbound-direction connection");
	return { viewer, owner, ownerHostId, viewerHostId };
}

/** The exact observed owner run of one connected destination, or a hard failure. */
function ownerRunOf(side: Side, hostId: string): string {
	const host = side.coordinator.read().hosts?.find((candidate) => candidate.id === hostId);
	assert.ok(host, "the destination is missing");
	assert.equal(host.state, "connected");
	assert.equal(host.roster.state, "current", "the roster observation must be complete");
	assert.ok(host.roster.hostRunId, "the coordinator must preserve the owner run identity");
	return host.roster.hostRunId;
}

function targetOf(
	hostId: string,
	runId: string,
	rowId: string,
	generation: number,
	cols = 40,
	rows = 12,
): PeerContentTarget {
	return Object.freeze({ hostId, hostRunId: runId, rowId, selectionGeneration: generation, cols, rows });
}

async function waitForContent(
	side: Side,
	predicate: (observation: PeerContentObservation) => boolean,
	message: string,
	timeoutMs = 10_000,
): Promise<PeerContentObservation> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const observation = side.coordinator.content.readContent();
		if (predicate(observation)) return observation;
		if (Date.now() > deadline) {
			throw new Error(
				`timed out waiting for ${message} (state=${observation.state}, reason=${observation.reason ?? "none"})`,
			);
		}
		await delay(10);
	}
}

async function waitForOwnerContent(
	source: FakeOwnerService,
	predicate: () => boolean,
	message: string,
	timeoutMs = 10_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
		await delay(10);
	}
}

function expectNoConsentRecorded(side: Side, fromIndex: number): void {
	assert.equal(
		side.log.snapshots.slice(fromIndex).some((snapshot) => snapshot.consents.length > 0),
		false,
		"selecting content must never request a consent",
	);
}

/**
 * Replay the owner's ordered source calls as a resource timeline.
 *
 * This is the deterministic shape of the retirement ordering the coordinator owes:
 * a replacement must never install a content watch or a viewer while the superseded
 * endpoint's own resources are still live, and an abandoned channel must have
 * finished its bounded local close before the reconciler subscribes again. A peak
 * above one is only possible if a new subscription was installed while an earlier
 * local close was still outstanding.
 */
function ownerResourcePeaks(calls: readonly string[]): {
	readonly watchPeak: number;
	readonly viewerPeak: number;
} {
	let watches = 0;
	let viewers = 0;
	let watchPeak = 0;
	let viewerPeak = 0;
	for (const call of calls) {
		if (call === "openViewer") {
			viewers += 1;
			viewerPeak = Math.max(viewerPeak, viewers);
		} else if (call.startsWith("closeViewer:")) {
			viewers = Math.max(0, viewers - 1);
		} else if (call.startsWith("watchSessionContent:")) {
			watches += 1;
			watchPeak = Math.max(watchPeak, watches);
		} else if (call.startsWith("unsubscribe:")) {
			watches = Math.max(0, watches - 1);
		}
	}
	return { watchPeak, viewerPeak };
}

/* ------------------------------------------------------------------------- *
 * Tests
 * ------------------------------------------------------------------------- */

test("the content controller is inert until selected and never reopens a stream on a repeated selection", async (t) => {
	const { viewer, owner, ownerHostId } = await connectViewerToOwner(t, ["one"]);
	const source = owner.source;
	const runId = ownerRunOf(viewer, ownerHostId);

	// The controller exists before any selection and has created nothing at all.
	const idle = viewer.coordinator.content.readContent();
	assert.deepEqual(idle, { target: null, state: "none", view: undefined, reason: null });
	assert.equal(Object.isFrozen(idle), true);
	assert.deepEqual(source.installedRowIds, []);
	assert.equal(source.liveWatchCount, 0);
	assert.equal(source.liveViewerCount, 0);
	assert.equal(source.calls.includes("watchSessionContent"), false);
	assert.equal(source.calls.includes("openViewer"), false);

	// Selecting a real current row reaches the owner's lane over the EXISTING
	// authenticated destination: same listener, same grant, no new pairing.
	const viewerIndex = viewer.log.snapshots.length;
	const ownerIndex = owner.log.snapshots.length;
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 1));
	const streamed = await waitForContent(viewer, (observation) => observation.state === "current", "the first viewport");
	assert.equal(streamed.target?.rowId, "one", "the deliberate target is kept, never dropped or rewritten");
	assert.equal(streamed.view?.snapshot.meta.sessionId, "one");
	expectNoConsentRecorded(viewer, viewerIndex);
	expectNoConsentRecorded(owner, ownerIndex);
	assert.equal(owner.log.arrivals.length, 1, "a content channel is not a new pairing arrival");

	// Re-selecting the identical target is inert: no second channel, no restart.
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 1));
	assert.equal(viewer.coordinator.content.readContent().state, "current");
	await delay(100);
	assert.deepEqual(source.installedRowIds, ["one"], "one install for one deliberate selection");
	assert.equal(source.liveWatchCount, 1);
	assert.equal(source.liveViewerCount, 1);
});

test("a host with no content source refuses the content upgrade and reports an honest unavailable", async (t) => {
	const metadataOnly = await startSide(t, {
		agentDir: createOwnedAgentDir(t).agentDir,
		inventory: new FakeOwnerService(["quiet"]),
		listen: true,
	});
	const inventory = metadataOnly.source;
	const viewer = await startViewer(t);
	const hostId = await addDestination(viewer, "Metadata-only host", metadataOnly.coordinator.read().listener.port as number);
	await connectWithApprovals(viewer, metadataOnly, hostId);
	await waitConnected(viewer, hostId, "the metadata-only connection");
	const runId = ownerRunOf(viewer, hostId);

	const viewerIndex = viewer.log.snapshots.length;
	const ownerIndex = metadataOnly.log.snapshots.length;
	viewer.coordinator.content.selectContent(targetOf(hostId, runId, "quiet", 1));
	const refused = await waitForContent(
		viewer,
		(observation) => observation.state === "unavailable",
		"the refused content upgrade to be reported",
	);
	assert.equal(refused.view, undefined);
	assert.equal(refused.target?.rowId, "quiet", "the refusal keeps the deliberate target visible");
	assert.ok(
		refused.reason === "open-failed" || refused.reason === "not-authorized",
		`expected an open/authorization refusal, got ${refused.reason ?? "none"}`,
	);
	// Nothing was installed anywhere, and nothing asked a human.
	assert.equal(inventory.liveWatchCount, 0);
	assert.equal(inventory.liveViewerCount, 0);
	assert.equal(inventory.calls.includes("watchSessionContent"), false);
	assert.equal(inventory.calls.includes("openViewer"), false);
	expectNoConsentRecorded(viewer, viewerIndex);
	expectNoConsentRecorded(metadataOnly, ownerIndex);
	// Metadata is untouched: still connected, still current, still serving rows.
	const host = viewer.coordinator.read().hosts?.find((candidate) => candidate.id === hostId);
	assert.equal(host?.state, "connected");
	assert.equal(host?.roster.state, "current");
	assert.equal(host?.roster.rows?.length, 1);
	assert.equal(inventory.liveInventoryWatchCount, 1);

	// A refusal is not silently retried: the attempt stays spent until a new
	// selection or a fresh roster observation of the same target.
	await delay(100);
	assert.equal(viewer.coordinator.content.readContent().state, "unavailable");
	assert.equal(inventory.calls.includes("watchSessionContent"), false);
});

test("one selected row streams its viewport while every other row stays metadata-only", async (t) => {
	const { viewer, owner, ownerHostId } = await connectViewerToOwner(t, ["one", "two"]);
	const source = owner.source;
	const runId = ownerRunOf(viewer, ownerHostId);
	const viewerIndex = viewer.log.snapshots.length;

	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 7, 42, 11));
	const current = await waitForContent(
		viewer,
		(observation) => observation.state === "current" && observation.view?.snapshot.meta.geometry.cols === 42,
		"the selected viewport at this viewer's canonical geometry",
	);

	assert.equal(current.view?.hostId, ownerHostId);
	assert.equal(current.view?.selectionGeneration, 7);
	const snapshot = current.view?.snapshot;
	assert.ok(snapshot, "a current selection publishes a complete viewport");
	assert.equal(snapshot.meta.hostRunId, runId);
	assert.equal(snapshot.meta.sessionId, "one");
	assert.equal(snapshot.meta.geometry.rows, 11, "the owner reports its own canonical geometry after this viewer's contribution");
	assert.equal(Object.isFrozen(current), true);
	assert.equal(Object.isFrozen(current.view), true);
	assert.equal(Object.isFrozen(snapshot), true);
	assert.equal(Object.isFrozen(snapshot.frame), true);
	// No control, transcript, clipboard, authorization, or raw byte crosses here.
	assert.equal(Object.hasOwn(snapshot, "currentFile"), false);
	assert.equal(Object.hasOwn(snapshot, "input"), false);

	// Only the selected row was ever watched, and only ONE viewer exists.
	assert.deepEqual(source.installedRowIds, ["one"]);
	assert.equal(source.liveWatchCount, 1);
	assert.equal(source.liveViewerCount, 1);
	assert.equal(source.rows.get("two")?.cols, OWNER_COLS, "an unselected row's geometry is never touched");
	assert.equal(source.rows.get("two")?.rows, OWNER_ROWS);

	// Every row of this destination stays metadata: content never narrows roster.
	const host = viewer.coordinator.read().hosts?.find((candidate) => candidate.id === ownerHostId);
	assert.equal(host?.roster.state, "current");
	assert.deepEqual(host?.roster.rows?.map((row) => row.id), ["one", "two"]);
	expectNoConsentRecorded(viewer, viewerIndex);

	// The newest viewport wins, and the published frame is the endpoint's own.
	source.emit("one");
	const replaced = await waitForContent(
		viewer,
		(observation) => observation.view?.snapshot.meta.sequence === snapshot.meta.sequence + 1,
		"the newer viewport",
	);
	assert.equal(replaced.state, "current");

	// A viewport claiming another owner run never stays up as a substitute.
	source.emitRun("one", `other-${runId}`);
	const fenced = await waitForContent(viewer, (observation) => observation.view === undefined, "the run-fenced viewport to clear");
	assert.equal(fenced.state, "unavailable");
	assert.equal(fenced.target?.rowId, "one");
	assert.notEqual(fenced.reason, null);
});

test("superseding one row with another then nothing keeps exactly one stream and clears synchronously", async (t) => {
	const { viewer, owner, ownerHostId } = await connectViewerToOwner(t, ["one", "two"]);
	const source = owner.source;
	const runId = ownerRunOf(viewer, ownerHostId);

	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 1));
	await waitForContent(viewer, (observation) => observation.state === "current", "the first selection's viewport");

	// A -> B is a replacement, not a second stream: the view is gone synchronously.
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "two", 2));
	const switching = viewer.coordinator.content.readContent();
	assert.equal(switching.view, undefined, "the previous view cannot survive a replacement");
	assert.equal(switching.state, "connecting");
	assert.equal(switching.target?.rowId, "two");

	const second = await waitForContent(
		viewer,
		(observation) => observation.state === "current" && observation.view?.snapshot.meta.sessionId === "two",
		"the second selection's viewport",
	);
	assert.equal(second.view?.snapshot.meta.hostRunId, runId);
	assert.deepEqual(source.installedRowIds, ["one", "two"]);
	await waitForOwnerContent(source, () => source.liveWatchCount === 1 && source.liveViewerCount === 1, "exactly one live owner resource pair");
	assert.equal(source.closedViewerIds.length, 1, "the superseded viewer retired before the new one installed");
	// Ordered owner timeline: no watch or viewer was ever installed while the previous
	// endpoint's own resources were still live.
	assert.deepEqual(ownerResourcePeaks(source.calls), { watchPeak: 1, viewerPeak: 1 });

	// A late observation for the superseded row cannot resurrect it.
	source.emit("one");
	await delay(100);
	assert.equal(viewer.coordinator.content.readContent().view?.snapshot.meta.sessionId, "two");

	// Local sessions and passive viewing select nothing: clearing is immediate.
	viewer.coordinator.content.selectContent(null);
	const cleared = viewer.coordinator.content.readContent();
	assert.deepEqual(cleared, { target: null, state: "none", view: undefined, reason: null });
	await waitForOwnerContent(source, () => source.liveWatchCount === 0 && source.liveViewerCount === 0, "the owner's local retirement");
	assert.equal(source.closedViewerIds.length, 2);
	// Clearing is not a remote stop: the destination and its metadata are intact.
	const host = viewer.coordinator.read().hosts?.find((candidate) => candidate.id === ownerHostId);
	assert.equal(host?.state, "connected");
	assert.equal(host?.roster.state, "current");
});

test("a stale generation, an unknown row, another run, and an invalid shape change nothing", async (t) => {
	const { viewer, owner, ownerHostId } = await connectViewerToOwner(t, ["one"]);
	const source = owner.source;
	const runId = ownerRunOf(viewer, ownerHostId);

	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 5));
	await waitForContent(viewer, (observation) => observation.state === "current", "the baseline viewport");
	const baseline = viewer.coordinator.content.readContent();
	assert.deepEqual(source.installedRowIds, ["one"]);

	// A stale generation from a superseded UI selection is inert.
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 4));
	assert.deepEqual(viewer.coordinator.content.readContent(), baseline);

	// A row that is not in this run's current roster is refused with no install.
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "ghost", 6));
	const ghost = await waitForContent(viewer, (observation) => observation.reason === "row-unavailable", "the unknown-row refusal");
	assert.equal(ghost.state, "unavailable");
	assert.equal(ghost.view, undefined);
	assert.equal(ghost.target?.rowId, "ghost", "the refusal reports the target it refused");
	assert.deepEqual(source.installedRowIds, ["one"], "no watch or viewer for a row the roster does not hold");

	// Another owner run is refused even though the row id still exists locally.
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, `not-${runId}`, "one", 7));
	const wrongRun = await waitForContent(viewer, (observation) => observation.reason === "run-changed", "the run-change refusal");
	assert.equal(wrongRun.view, undefined);
	assert.deepEqual(source.installedRowIds, ["one"]);

	// An unrepresentable selection is reported, never guessed at or defaulted.
	viewer.coordinator.content.selectContent(null);
	assert.equal(viewer.coordinator.content.readContent().state, "none");
	viewer.coordinator.content.selectContent({
		hostId: ownerHostId,
		hostRunId: runId,
		rowId: "one",
		selectionGeneration: 8,
		cols: 0,
		rows: 12,
	} as PeerContentTarget);
	const invalid = viewer.coordinator.content.readContent();
	assert.equal(invalid.state, "unavailable");
	assert.equal(invalid.reason, "invalid-selection");
	assert.equal(invalid.target, null, "a partial selection is never partially adopted");
	assert.deepEqual(source.installedRowIds, ["one"]);

	// A different destination cannot be substituted for the one that is missing.
	viewer.coordinator.content.selectContent(targetOf("no-such-host", runId, "one", 9));
	const missing = await waitForContent(
		viewer,
		(observation) => observation.reason === "destination-unavailable",
		"the missing-destination refusal",
	);
	assert.equal(missing.target?.hostId, "no-such-host");
	assert.deepEqual(source.installedRowIds, ["one"]);
});

test("a newly reachable selected row connects without republishing its stale missing-row refusal", async (t) => {
	const { viewer, owner, ownerHostId } = await connectViewerToOwner(t, []);
	const runId = ownerRunOf(viewer, ownerHostId);
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 1));
	await waitForContent(viewer, (observation) => observation.reason === "row-unavailable", "the not-yet-observed row");
	const start = viewer.observations.length;
	owner.source.setRows(["one"]);
	const current = await waitForContent(viewer, (observation) => observation.state === "current", "the new row's viewport");
	assert.equal(current.target?.rowId, "one");
	const opening = viewer.observations.slice(start);
	assert.ok(opening.some((observation) => observation.state === "connecting" && observation.reason === null),
		"the authorized open reports connecting before its first viewport");
	assert.equal(opening.some((observation) => observation.state === "unavailable"), false,
		"the new open never republishes the previous missing-row refusal");
	assert.deepEqual(owner.source.installedRowIds, ["one"], "one ordinary content attempt, not a retry");
});

test("losing the selected row clears the view immediately and the same target returns with it", async (t) => {
	const { viewer, owner, ownerHostId } = await connectViewerToOwner(t, ["one", "two"]);
	const source = owner.source;
	const runId = ownerRunOf(viewer, ownerHostId);
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 1));
	await waitForContent(viewer, (observation) => observation.state === "current", "the baseline viewport");

	// The owner's authoritative inventory loses the row: content stops being
	// claimed at once, and the target is kept as an honest unavailable.
	source.setRows(["two"]);
	const lost = await waitForContent(viewer, (observation) => observation.view === undefined, "the lost row to clear the view");
	assert.equal(lost.state, "unavailable");
	assert.equal(lost.target?.rowId, "one");
	assert.notEqual(lost.reason, null);
	await waitForOwnerContent(source, () => source.liveWatchCount === 0 && source.liveViewerCount === 0, "the owner's local retirement");

	// The same row id coming back on the SAME run restores exactly that selection
	// over the existing connection: no new pairing, prompt, or destination.
	const viewerIndex = viewer.log.snapshots.length;
	const ownerIndex = owner.log.snapshots.length;
	source.setRows(["one", "two"]);
	const restored = await waitForContent(viewer, (observation) => observation.state === "current", "the same target to return");
	assert.equal(restored.target?.rowId, "one");
	assert.equal(restored.view?.snapshot.meta.sessionId, "one");
	assert.equal(restored.view?.snapshot.meta.hostRunId, runId);
	expectNoConsentRecorded(viewer, viewerIndex);
	expectNoConsentRecorded(owner, ownerIndex);
	assert.deepEqual(source.installedRowIds, ["one", "one"]);
	assert.equal(source.liveWatchCount, 1);

	// A change that becomes unobservable clears the published view rather than
	// leaving a stale frame up as "current".
	source.emitUnavailable("one");
	const gone = await waitForContent(viewer, (observation) => observation.view === undefined, "the unavailable viewport to clear");
	assert.equal(gone.state, "unavailable");
	assert.equal(gone.reason, "content-lost");
	assert.equal(gone.target?.rowId, "one");
});

test("disconnect and remove clear content immediately without rewriting or reconnecting it", async (t) => {
	const { viewer, owner, ownerHostId } = await connectViewerToOwner(t, ["one"]);
	const source = owner.source;
	const runId = ownerRunOf(viewer, ownerHostId);
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 1));
	await waitForContent(viewer, (observation) => observation.state === "current", "the baseline viewport");

	await viewer.coordinator.perform({ type: "peer-disconnect", hostId: ownerHostId });
	const dropped = viewer.coordinator.content.readContent();
	assert.equal(dropped.view, undefined, "the authorized view is gone before any await");
	assert.equal(dropped.state, "unavailable");
	assert.equal(dropped.reason, "connection-lost");
	assert.equal(dropped.target?.rowId, "one", "the deliberate target is kept, never silently retargeted");
	// The owner retires its own watch and viewer for the lost channel.
	await waitForOwnerContent(source, () => source.liveWatchCount === 0 && source.liveViewerCount === 0, "the owner's local retirement");
	assert.equal(source.closedViewerIds.length, 1);

	// The destination is disconnected and Auto is suppressed by the explicit
	// Disconnect, so content cannot come back on its own.
	await delay(100);
	assert.equal(hostOf(viewer, ownerHostId), "disconnected");
	assert.equal(viewer.coordinator.content.readContent().state, "unavailable");
	assert.deepEqual(source.installedRowIds, ["one"], "no second attempt after the loss");

	// Remove preserves the deliberate target under its old destination id: the loss is
	// honest and observable, and the old id is what keeps a re-added endpoint from
	// ever inheriting or retargeting this selection.
	await viewer.coordinator.perform({ type: "peer-remove", hostId: ownerHostId });
	const removed = viewer.coordinator.content.readContent();
	assert.equal(removed.state, "unavailable");
	assert.deepEqual(removed.target, dropped.target);
	assert.equal(removed.view, undefined);
	assert.equal(removed.reason, "connection-lost");
	const readded = await addDestination(viewer, "Owner laptop again", owner.coordinator.read().listener.port as number);
	assert.notEqual(readded, ownerHostId, "a re-added endpoint is a different local id");
	assert.deepEqual(
		viewer.coordinator.content.readContent(),
		removed,
		"a new destination never inherits the removed one's selection",
	);
});

test("revoking the receiving direction stops receiving work but never the selected outgoing stream", async (t) => {
	const { viewer, owner, ownerHostId, viewerHostId } = await pairBothWays(t, ["one"], ["mine"]);
	const source = owner.source;
	const runId = ownerRunOf(viewer, ownerHostId);
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 1));
	await waitForContent(viewer, (observation) => observation.state === "current", "the baseline viewport");
	const before = viewer.coordinator.content.readContent();

	// The viewer's OWN receiving permission is the opposite direction. Revoking it
	// must not end the selected outgoing stream or touch the owner's resources.
	const revokedPeerId = viewer.coordinator.read().trustedPeers?.[0]?.id;
	assert.ok(revokedPeerId, "the viewer holds the owner's key from the inbound direction");
	await viewer.coordinator.perform({ type: "peer-revoke", peerId: revokedPeerId });
	const after = viewer.coordinator.content.readContent();
	assert.deepEqual(after, before, "revoking the opposite direction is not a content stop");
	assert.equal(source.liveWatchCount, 1);
	assert.equal(source.liveViewerCount, 1);
	assert.equal(source.closedViewerIds.length, 0);
	// The receiving side really did react: the owner's roster of the viewer goes
	// stale, while its own connection and the content stream stay intact.
	await waitRosterState(owner, viewerHostId, "stale", "the revoked inbound roster to become stale");
	assert.equal(hostOf(owner, viewerHostId), "connected", "Revoke is not a transport teardown");
	assert.equal(viewer.coordinator.content.readContent().state, "current");
	assert.equal(owner.coordinator.read().listener.state, "listening", "Revoke never stops the listener");

	// Losing the authority that SERVES this content stops content: the owner's
	// revocation makes its roster observation stale, and a stale roster cannot
	// fence a selection. Metadata survives as last-observed, not current, not empty.
	const ownerPeerId = owner.coordinator.read().trustedPeers?.[0]?.id;
	assert.ok(ownerPeerId);
	await owner.coordinator.perform({ type: "peer-revoke", peerId: ownerPeerId });
	const stopped = await waitForContent(
		viewer,
		(observation) => observation.view === undefined,
		"the revoked content authority to clear the view",
	);
	assert.equal(stopped.state, "unavailable");
	assert.equal(stopped.target?.rowId, "one", "the target is kept as an honest unavailable");
	await waitForOwnerContent(source, () => source.liveWatchCount === 0 && source.liveViewerCount === 0, "the owner's local retirement");
	const host = viewer.coordinator.read().hosts?.find((candidate) => candidate.id === ownerHostId);
	assert.equal(host?.state, "connected", "content revocation is not a transport teardown");
	assert.equal(host?.roster.state, "stale");
	assert.equal(host?.roster.rows?.length, 1);
});

test("close during a pending content open never installs anything and settles cleanly", async (t) => {
	const owner = await startOwner(t, ["one"]);
	const source = owner.source;
	const viewer = await startViewer(t);
	const ownerHostId = await addDestination(viewer, "Owner laptop", owner.coordinator.read().listener.port as number);
	await connectWithApprovals(viewer, owner, ownerHostId);
	await waitConnected(viewer, ownerHostId, "the connected metadata roster");
	const runId = ownerRunOf(viewer, ownerHostId);

	// Select and close in the same synchronous turn: the content-channel open is
	// genuinely in flight, and close owns it.
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 1));
	assert.equal(viewer.coordinator.content.readContent().state, "connecting");
	await viewer.coordinator.close();

	// A settled close means the abort won: nothing was ever installed on the owner.
	assert.equal(source.installedRowIds.length, 0, "a superseded open attaches nothing");
	assert.equal(source.liveViewerCount, 0);
	assert.equal(source.liveWatchCount, 0);
	const settled = viewer.coordinator.content.readContent();
	assert.deepEqual(settled, { target: null, state: "none", view: undefined, reason: null });
	// A closed coordinator's controller is inert.
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 2));
	assert.deepEqual(viewer.coordinator.content.readContent(), settled);
	await delay(100);
	assert.deepEqual(source.installedRowIds, [], "a late open cannot install a subscription after close");
});

test("a throwing advisory content observer is contained and resize stays newest-only", async (t) => {
	const owner = await startOwner(t, ["one"]);
	const source = owner.source;
	const viewer = await startViewer(t, { throwOnContentChange: true });
	const ownerHostId = await addDestination(viewer, "Owner laptop", owner.coordinator.read().listener.port as number);
	await connectWithApprovals(viewer, owner, ownerHostId);
	await waitConnected(viewer, ownerHostId, "the connected metadata roster");
	const runId = ownerRunOf(viewer, ownerHostId);

	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 3, 30, 8));
	const current = await waitForContent(
		viewer,
		(observation) => observation.view?.snapshot.meta.geometry.cols === 30,
		"content despite a failing advisory observer",
	);
	assert.equal(current.state, "current");
	assert.equal(current.view?.snapshot.meta.sessionId, "one");
	assert.ok(viewer.observations.length > 0, "the observer was still called on the way there");

	// Resize is newest-only: the newest size wins and no second stream opens. A
	// stale generation and an out-of-range size are both ignored.
	viewer.coordinator.content.updateContentViewport({ selectionGeneration: 3, cols: 33, rows: 8 });
	viewer.coordinator.content.updateContentViewport({ selectionGeneration: 3, cols: 36, rows: 9 });
	viewer.coordinator.content.updateContentViewport({ selectionGeneration: 2, cols: 99, rows: 99 });
	viewer.coordinator.content.updateContentViewport({ selectionGeneration: 3, cols: 0, rows: 9 });
	const resized = await waitForContent(
		viewer,
		(observation) => observation.target?.cols === 36 && observation.target?.rows === 9,
		"the newest viewport intent",
	);
	assert.equal(resized.state, "current");
	await waitForContent(
		viewer,
		(observation) => observation.view?.snapshot.meta.geometry.cols === 36 && observation.view.snapshot.meta.geometry.rows === 9,
		"the owner's recomputed canonical geometry",
	);
	assert.equal(source.liveWatchCount, 1, "a resize never opens a second stream");
	assert.equal(source.liveViewerCount, 1, "a resize never registers a second viewer");
	assert.ok(
		source.updateCalls.length <= 4,
		`expected a bounded number of viewer changes, got ${source.updateCalls.length}`,
	);
});

test("a burst of selections runs one reconciler and streams only the newest intent", async (t) => {
	const rows = Array.from({ length: 20 }, (_unused, index) => `row-${index + 1}`);
	const { viewer, owner, ownerHostId } = await connectViewerToOwner(t, rows);
	const source = owner.source;
	const runId = ownerRunOf(viewer, ownerHostId);

	// Twenty deliberate clicks in one synchronous turn, while the first content
	// open is genuinely still in flight. The coordinator keeps ONE reconciler, and a
	// reconciler pass takes only the newest intent: the nineteen abandoned attempts
	// attach no subscription, and the superseded opens are aborted rather than
	// queued up behind each other.
	rows.forEach((rowId, index) => {
		viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, rowId, index + 1));
	});
	const inFlight = viewer.coordinator.content.readContent();
	assert.equal(inFlight.target?.rowId, "row-20", "the newest intent replaces the intent synchronously");
	assert.equal(inFlight.state, "connecting");
	assert.equal(inFlight.view, undefined);

	const current = await waitForContent(viewer, (observation) => observation.state === "current", "the newest row");
	assert.equal(current.target?.rowId, "row-20");
	assert.equal(current.view?.snapshot.meta.sessionId, "row-20");
	assert.deepEqual(source.installedRowIds, ["row-20"], "twenty clicks install exactly one subscription");
	assert.equal(source.liveWatchCount, 1);
	assert.equal(source.liveViewerCount, 1);
	assert.equal(source.liveWatchPeak, 1, "a burst never keeps two native viewports live at once");
	// The abandoned opens are joined work, not fire-and-forget: across the whole burst
	// the owner never had a second watch or viewer installed while an earlier one was
	// still live, so the pump could not subscribe a replacement over an outstanding
	// local close.
	assert.deepEqual(ownerResourcePeaks(source.calls), { watchPeak: 1, viewerPeak: 1 });

	// A burst that ends on "nothing selected" clears synchronously and retires the
	// stream it superseded, instead of leaving an older target current.
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "row-1", 21));
	viewer.coordinator.content.selectContent(null);
	assert.deepEqual(
		viewer.coordinator.content.readContent(),
		{ target: null, state: "none", view: undefined, reason: null },
		"clearing selection is synchronous",
	);
	await waitForOwnerContent(
		source,
		() => source.liveWatchCount === 0 && source.liveViewerCount === 0,
		"the superseded stream to retire",
	);
	assert.equal(source.installedRowIds.length, 1, "the burst ending on null still costs one attempt, not twenty-one");
});

test("two content-serving hosts still share one globally selected content stream", async (t) => {
	const ownerA = await startOwner(t, ["one"]);
	const ownerB = await startOwner(t, ["one"]);
	const viewer = await startViewer(t);
	const hostA = await addDestination(viewer, "Owner A laptop", ownerA.coordinator.read().listener.port as number);
	const hostB = await addDestination(viewer, "Owner B laptop", ownerB.coordinator.read().listener.port as number);
	await connectWithApprovals(viewer, ownerA, hostA);
	await waitConnected(viewer, hostA, "the first owner's metadata roster");
	await connectWithApprovals(viewer, ownerB, hostB);
	await waitConnected(viewer, hostB, "the second owner's metadata roster");
	const sourceA = ownerA.source;
	const sourceB = ownerB.source;
	const runA = ownerRunOf(viewer, hostA);
	const runB = ownerRunOf(viewer, hostB);

	viewer.coordinator.content.selectContent(targetOf(hostA, runA, "one", 1));
	await waitForContent(viewer, (observation) => observation.state === "current", "the first owner's viewport");
	assert.equal(sourceA.liveWatchCount, 1);
	assert.equal(sourceB.liveWatchCount, 0, "a connected, content-serving host is never streamed unselected");

	// The selection is global, not per host: choosing the second row retires the
	// first endpoint completely while both metadata connections stay current.
	viewer.coordinator.content.selectContent(targetOf(hostB, runB, "one", 2));
	const onB = await waitForContent(
		viewer,
		(observation) => observation.view?.snapshot.meta.hostRunId === runB,
		"the second owner's viewport",
	);
	assert.equal(onB.state, "current");
	assert.equal(onB.target?.hostId, hostB);
	await waitForOwnerContent(
		sourceA,
		() => sourceA.liveWatchCount === 0 && sourceA.liveViewerCount === 0,
		"the first owner's local retirement",
	);
	assert.equal(sourceB.liveWatchCount, 1);
	assert.equal(sourceA.installedRowIds.length, 1, "the unselected host is never re-subscribed");
	// Cross-host replacement is still one retirement then one subscription: neither
	// owner ever held a second live resource, and the first host's pair closed before
	// the second host's watch was installed.
	assert.deepEqual(ownerResourcePeaks(sourceA.calls), { watchPeak: 1, viewerPeak: 1 });
	assert.deepEqual(ownerResourcePeaks(sourceB.calls), { watchPeak: 1, viewerPeak: 1 });

	// Metadata for the unselected host is untouched: still connected, still current.
	const stillA = viewer.coordinator.read().hosts?.find((candidate) => candidate.id === hostA);
	assert.equal(stillA?.state, "connected");
	assert.equal(stillA?.roster.state, "current");
	assert.equal(stillA?.roster.rows?.length, 1);

	// A viewport delivered by the unselected host can never become the published view.
	sourceA.emit("one");
	await delay(100);
	const unchanged = viewer.coordinator.content.readContent();
	assert.equal(unchanged.view?.snapshot.meta.hostRunId, runB);
	assert.equal(sourceA.liveWatchCount, 0, "an unselected host's change never reopens its stream");
});

test("the same row id under a new owner run is never the selected run", async (t) => {
	const { viewer, owner, ownerHostId } = await connectViewerToOwner(t, ["one"]);
	const source = owner.source;
	const runId = ownerRunOf(viewer, ownerHostId);
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 1));
	await waitForContent(viewer, (observation) => observation.state === "current", "the baseline viewport");

	// The owner restarts: every row id survives, the run identity does not. The owner
	// terminates the existing metadata subscription on a run change rather than
	// publishing a new run into it, so the viewer keeps its last-observed rows as
	// explicitly stale, and a stale roster cannot fence a content selection at all.
	source.rotateRun();
	await waitRosterState(viewer, ownerHostId, "stale", "the old run's subscription to become stale");
	const stale = await waitForContent(viewer, (observation) => observation.view === undefined, "the old viewport to clear");
	assert.equal(stale.reason, "roster-unavailable");
	assert.equal(stale.target?.rowId, "one");
	assert.equal(stale.target?.hostRunId, runId, "the target keeps the run it was selected under");
	await waitForOwnerContent(
		source,
		() => source.liveWatchCount === 0 && source.liveViewerCount === 0,
		"the retired endpoint",
	);

	// A fresh metadata subscription is the only thing that can produce a current
	// observation of the new run: the coordinator never rewrites the target to it.
	await viewer.coordinator.perform({ type: "peer-disconnect", hostId: ownerHostId });
	await viewer.coordinator.perform({ type: "peer-connect", hostId: ownerHostId });
	await waitConnected(viewer, ownerHostId, "the new run's metadata roster");
	const changed = await waitForContent(
		viewer,
		(observation) => observation.reason === "run-changed",
		"the new-run fence against the preserved target",
	);
	assert.equal(changed.state, "unavailable");
	assert.equal(changed.target?.rowId, "one");
	assert.equal(changed.target?.hostRunId, runId, "the target is never rewritten to the new run");

	// The coordinator does not guess that the same row id means the same session.
	await delay(150);
	assert.equal(viewer.coordinator.content.readContent().state, "unavailable", "no automatic retarget");
	assert.equal(source.installedRowIds.length, 1, "a new run is not silently re-attached");

	// A fresh selection carrying the NEW run id is the only way content returns.
	const nextRun = ownerRunOf(viewer, ownerHostId);
	assert.notEqual(nextRun, runId);
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, nextRun, "one", 2));
	const restored = await waitForContent(viewer, (observation) => observation.state === "current", "the new run");
	assert.equal(restored.view?.snapshot.meta.hostRunId, nextRun);
	assert.equal(restored.view?.snapshot.meta.sessionId, "one");
	assert.equal(source.installedRowIds.length, 2);
});

test("content that failed before the metadata drop returns on the same target after reconnect", async (t) => {
	const { viewer, owner, ownerHostId } = await connectViewerToOwner(t, ["one"]);
	const source = owner.source;
	const runId = ownerRunOf(viewer, ownerHostId);
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 1));
	await waitForContent(viewer, (observation) => observation.state === "current", "the baseline viewport");

	// The stream fails first, while metadata is still connected. That attempt is
	// spent: the coordinator must not reopen it behind the user's back.
	source.emitUnavailable("one");
	const lost = await waitForContent(viewer, (observation) => observation.view === undefined, "the failed viewport");
	assert.equal(lost.reason, "content-lost");
	await delay(150);
	assert.equal(viewer.coordinator.content.readContent().state, "unavailable", "a failed stream is not retried");
	assert.equal(source.installedRowIds.length, 1);

	// The connection then drops and the user reconnects deliberately. Losing the
	// connection is a reachability transition, so the same deliberate target becomes
	// eligible again instead of staying permanently spent.
	await viewer.coordinator.perform({ type: "peer-disconnect", hostId: ownerHostId });
	assert.equal(viewer.coordinator.content.readContent().reason, "connection-lost");
	const consentIndex = viewer.log.snapshots.length;
	await viewer.coordinator.perform({ type: "peer-connect", hostId: ownerHostId });
	await waitConnected(viewer, ownerHostId, "the deliberate reconnect");
	const restored = await waitForContent(
		viewer,
		(observation) => observation.state === "current",
		"the same target to return over the existing pairing",
	);
	assert.equal(restored.target?.rowId, "one");
	assert.equal(restored.view?.snapshot.meta.hostRunId, runId, "the same owner run, not a substitute");
	assert.equal(source.installedRowIds.length, 2, "one attempt before the drop, one after the reconnect");
	expectNoConsentRecorded(viewer, consentIndex);
});

test("a row removed while the content open is in flight never becomes current", async (t) => {
	const { viewer, owner, ownerHostId } = await connectViewerToOwner(t, ["one", "two"]);
	const source = owner.source;
	const runId = ownerRunOf(viewer, ownerHostId);

	// Select and remove in the same turn: the authoritative removal outruns the
	// content open, whichever order the two channels deliver in.
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 1));
	source.setRows(["two"]);

	const settled = await waitForContent(
		viewer,
		(observation) => observation.state === "unavailable" && observation.view === undefined,
		"the honest refusal",
	);
	assert.equal(settled.target?.rowId, "one", "the deliberate target is kept, never retargeted to row two");
	assert.notEqual(settled.reason, null);
	await waitForOwnerContent(
		source,
		() => source.liveWatchCount === 0 && source.liveViewerCount === 0,
		"no owner resource to survive the removal",
	);

	// A late acknowledgement or a late frame cannot resurrect the removed row.
	source.emit("one");
	await delay(200);
	const late = viewer.coordinator.content.readContent();
	assert.equal(late.state, "unavailable");
	assert.equal(late.view, undefined, "a removed row never becomes current");
	assert.ok(
		source.installedRowIds.filter((rowId) => rowId === "one").length <= 1,
		"the lost attempt is spent and never retried",
	);
});

test("a destination whose key really changed loses content for good and is never re-pinned", async (t) => {
	const port = await reserveLoopbackPort(t);
	const firstSource = new FakeOwnerService(["one"]);
	const owner = await startSide(t, {
		agentDir: createOwnedAgentDir(t).agentDir,
		inventory: firstSource,
		contentSource: firstSource,
		listen: port,
	});
	const viewer = await startViewer(t, { autoReconnectDelaysMs: [40, 40, 80, 80, 120, 120] });
	const ownerHostId = await addDestination(viewer, "Owner laptop", port);
	await connectWithApprovals(viewer, owner, ownerHostId);
	await waitConnected(viewer, ownerHostId, "the connected metadata roster");
	const runId = ownerRunOf(viewer, ownerHostId);
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 1));
	await waitForContent(viewer, (observation) => observation.state === "current", "the baseline viewport");
	const pinned = viewer.coordinator.read().hosts?.find((candidate) => candidate.id === ownerHostId)?.fingerprint;
	assert.ok(pinned);

	await owner.coordinator.close();

	// A different owner identity on the same endpoint is exactly the changed-key case.
	const secondSource = new FakeOwnerService(["one"]);
	const replacement = await startSide(t, {
		agentDir: createOwnedAgentDir(t).agentDir,
		inventory: secondSource,
		contentSource: secondSource,
		listen: port,
	});
	const replacementIndex = replacement.log.snapshots.length;
	// The destination may already have reached its terminal state through an automatic
	// attempt, or may need one deliberate attempt to meet the new identity.
	await viewer.coordinator.perform({ type: "peer-connect", hostId: ownerHostId }).catch(() => undefined);
	const failed = await viewer.log.waitFor(
		(snapshot) => snapshot.hosts?.find((candidate) => candidate.id === ownerHostId)?.state === "error",
		"the terminal changed-key state",
	);
	const failedHost = failed.hosts?.find((candidate) => candidate.id === ownerHostId);
	assert.match(failedHost?.message ?? "", /key changed/);
	assert.equal(failedHost?.fingerprint, pinned, "the remembered pin is never replaced");

	// Content is gone with the connection and never comes back on an identity this
	// side no longer trusts: no silent re-pin, no re-pair, no content stream.
	const after = viewer.coordinator.content.readContent();
	assert.equal(after.state, "unavailable");
	assert.equal(after.view, undefined);
	await delay(200);
	assert.equal(viewer.coordinator.content.readContent().state, "unavailable", "content never resumes unconfirmed");
	assert.equal(secondSource.installedRowIds.length, 0, "the new identity is never handed a viewport");
	assert.equal(
		replacement.log.snapshots.slice(replacementIndex).some((snapshot) => snapshot.consents.length > 0),
		false,
		"a changed key never produces a silent approval on the new host",
	);
	assert.deepEqual(replacement.coordinator.read().trustedPeers, []);
});

test("an inbound content retirement that never settles is never reported as a settled close", async (t) => {
	const { viewer, owner, ownerHostId } = await connectViewerToOwner(t, ["one"]);
	const source = owner.source;
	const runId = ownerRunOf(viewer, ownerHostId);
	viewer.coordinator.content.selectContent(targetOf(ownerHostId, runId, "one", 1));
	await waitForContent(viewer, (observation) => observation.state === "current", "the baseline viewport");

	// From here the owner cannot confirm that it released the native viewport. Under
	// the refined host contract that uncertainty is reported by the binding itself:
	// the local stop rejects, the coordinator keeps ownership, and close refuses to
	// claim a settled teardown. A closed transport is never taken as proof.
	source.failViewerClose = true;
	const ownerPeerId = owner.coordinator.read().trustedPeers?.[0]?.id;
	assert.ok(ownerPeerId, "the owner holds the viewer's receiving key");
	await owner.coordinator.perform({ type: "peer-revoke", peerId: ownerPeerId });

	await assert.rejects(
		owner.coordinator.close(),
		(error: unknown): boolean => isPeerCoordinatorCloseError(error),
		"an unconfirmed content retirement is not a settled close",
	);

	// The viewer reports its own side honestly rather than assuming the owner is clean.
	const stopped = await waitForContent(
		viewer,
		(observation) => observation.view === undefined,
		"the revoked stream to clear on the viewer side",
	);
	assert.equal(stopped.state, "unavailable");
	assert.equal(stopped.target?.rowId, "one");
});
