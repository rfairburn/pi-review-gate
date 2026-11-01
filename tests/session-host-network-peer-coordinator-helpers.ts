/**
 * Focused fixtures for the network sidebar coordinator (issue #482).
 *
 * Everything here is synthetic and owned by the test process: an agent
 * directory under the platform temp directory, an in-memory inventory watch that
 * only this test mutates, and snapshots observed through the coordinator's real
 * `onChange` callback. No account state, key, listener, or process is touched.
 */

import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import type { NativeInstanceView } from "../src/session-host/instances";
import type {
	OwningHostInventoryListener,
	OwningHostInventorySnapshot,
	OwningHostInventoryWatch,
	OwningHostService,
} from "../src/session-host/owning-host-service";
import type { SessionHostNativeSession } from "../src/session-host/protocol";
import {
	createPeerCoordinator,
	type PeerCoordinatorOptions,
} from "../src/session-host/network/peer-coordinator";
import type { PeerUiConsent, PeerUiSnapshot } from "../src/session-host/peer-ui-protocol";

export { assert };

/** The one owner capability the coordinator may use. */
export type InventorySource = Pick<OwningHostService, "watchInventory">;

export const SECRET_WORKSPACE = "/srv/owner/日本語-work";
export const SECRET_AGENT_DIR = "/Users/owner/.pi/agent";

function nativeSession(id: string): SessionHostNativeSession {
	return { sessionId: `conversation-${id}`, epoch: 3, name: `Conversation ${id}` };
}

type MutableView = {
	-readonly [K in keyof NativeInstanceView]: NativeInstanceView[K] extends readonly (infer Item)[]
		? Item[]
		: NativeInstanceView[K];
};

export function rowView(id: string, overrides: Partial<NativeInstanceView> = {}): MutableView {
	return {
		id,
		label: `Row ${id}`,
		workspace: SECRET_WORKSPACE,
		agentDir: SECRET_AGENT_DIR,
		lifecycle: "alive",
		busy: null,
		pendingInput: null,
		inputSurface: false,
		nativeSession: nativeSession(id),
		backgroundTasks: null,
		backgroundShells: null,
		activeTasks: null,
		activeShells: null,
		hasLiveProcess: true,
		activity: [],
		...overrides,
	} as MutableView;
}

function copyRows(rows: readonly NativeInstanceView[]): readonly NativeInstanceView[] {
	return Object.freeze(rows.map((row) => Object.freeze({
		...row,
		activity: Object.freeze([...(row.activity ?? [])]),
	})));
}

/**
 * A minimal authoritative inventory stand-in. It exposes only the read-only
 * watch the coordinator is allowed to use, and never a session operation.
 */
export interface FakeInventory extends InventorySource {
	setRows(rows: readonly NativeInstanceView[] | undefined): void;
	/** Make the authoritative source unobservable, so installing a watch fails. */
	setUnobservable(value: boolean): void;
	/**
	 * Fixture-only: adopt a different owner run, exactly as a restarted manager
	 * would. Nothing is emitted; a fresh subscription observes the new run.
	 */
	setRun(nextHostRunId: string): void;
	readonly activeWatches: number;
	readonly revisions: number;
}

export function createFakeInventory(initial: readonly NativeInstanceView[] = []): FakeInventory {
	let rows: readonly NativeInstanceView[] | undefined = copyRows(initial);
	let unobservable = false;
	let revision = 0;
	let hostRunId = `run-${Math.random().toString(36).slice(2, 10)}`;
	const watches = new Set<{ listener: OwningHostInventoryListener; active: boolean }>();

	const snapshotOf = (): OwningHostInventorySnapshot | undefined => (
		rows === undefined
			? undefined
			: Object.freeze({ hostRunId, revision, rows: copyRows(rows) })
	);

	return {
		get activeWatches() {
			return watches.size;
		},
		get revisions() {
			return revision;
		},
		watchInventory(listener: OwningHostInventoryListener): OwningHostInventoryWatch | undefined {
			if (typeof listener !== "function") throw new TypeError("inventory listener must be callable");
			revision += 1;
			if (unobservable) return undefined;
			const snapshot = snapshotOf();
			if (snapshot === undefined) return undefined;
			const record = { listener, active: true };
			watches.add(record);
			return {
				snapshot,
				unsubscribe() {
					if (!record.active) return;
					record.active = false;
					watches.delete(record);
				},
			};
		},
		setUnobservable(value: boolean): void {
			unobservable = value === true;
		},
		setRun(nextHostRunId: string): void {
			hostRunId = nextHostRunId;
		},
		setRows(next: readonly NativeInstanceView[] | undefined): void {
			revision += 1;
			rows = next === undefined ? undefined : copyRows(next);
			const snapshot = snapshotOf();
			for (const watch of [...watches]) watch.listener(snapshot);
		},
	};
}

export interface SnapshotLog {
	readonly snapshots: PeerUiSnapshot[];
	readonly arrivals: string[];
	readonly onChange: (snapshot: PeerUiSnapshot) => void;
	readonly onArrival: (consentId: string) => void;
	latest(): PeerUiSnapshot;
	waitFor(
		predicate: (snapshot: PeerUiSnapshot) => boolean,
		message: string,
		timeoutMs?: number,
	): Promise<PeerUiSnapshot>;
}

export function createSnapshotLog(): SnapshotLog {
	const snapshots: PeerUiSnapshot[] = [];
	const arrivals: string[] = [];
	const waiters = new Set<{
		predicate: (snapshot: PeerUiSnapshot) => boolean;
		resolve: (snapshot: PeerUiSnapshot) => void;
	}>();
	return {
		snapshots,
		arrivals,
		onChange(snapshot) {
			snapshots.push(snapshot);
			for (const waiter of [...waiters]) {
				if (!waiter.predicate(snapshot)) continue;
				waiters.delete(waiter);
				waiter.resolve(snapshot);
			}
		},
		onArrival(consentId) {
			arrivals.push(consentId);
		},
		latest() {
			const latest = snapshots[snapshots.length - 1];
			assert.ok(latest, "the coordinator emitted no snapshot");
			return latest;
		},
		waitFor(predicate, message, timeoutMs = 10_000) {
			// Only the CURRENT snapshot can satisfy a wait: an earlier state that
			// happened to match must never be mistaken for the present.
			const current = snapshots[snapshots.length - 1];
			if (current !== undefined && predicate(current)) return Promise.resolve(current);
			return new Promise<PeerUiSnapshot>((resolve, reject) => {
				const waiter = { predicate, resolve: (snapshot: PeerUiSnapshot) => {
					clearTimeout(timer);
					waiters.delete(waiter);
					resolve(snapshot);
				} };
				const timer = setTimeout(() => {
					waiters.delete(waiter);
					reject(new Error(`timed out waiting for ${message}`));
				}, timeoutMs);
				// This fixture actively awaits a finite observation deadline, including
				// periods with no listener/socket while recovery is being observed.
				// Keep that deadline referenced; pending Promises alone do not own
				// event-loop liveness. Production timers are unchanged.
				// Re-check between the synchronous scan and registration.
				const raced = snapshots[snapshots.length - 1];
				if (raced !== undefined && predicate(raced)) {
					clearTimeout(timer);
					resolve(raced);
					return;
				}
				waiters.add(waiter);
			});
		},
	};
}

export interface AgentFixture {
	readonly root: string;
	readonly agentDir: string;
	readonly sessionHostDir: string;
	readonly peersDir: string;
	readonly preferencesDir: string;
	readonly preferencesPath: string;
	readonly statePath: string;
}

/** Synthetic, positively owned agent directory; removed by the test's finalizer. */
export function createOwnedAgentDir(t: TestContext): AgentFixture {
	const root = `${tmpdir()}/prg-peer-coordinator-${Math.random().toString(36).slice(2, 10)}`;
	mkdirSync(root, { mode: 0o700 });
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
	});
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { mode: 0o700 });
	const canonical = realpathSync(agentDir);
	const sessionHostDir = join(canonical, "session-host");
	return {
		root,
		agentDir,
		sessionHostDir,
		peersDir: join(sessionHostDir, "peers"),
		preferencesDir: join(sessionHostDir, "peer-preferences"),
		preferencesPath: join(sessionHostDir, "peer-preferences", "preferences.json"),
		statePath: join(sessionHostDir, "peers", "state.json"),
	};
}

export interface StartedCoordinator {
	readonly coordinator: ReturnType<typeof createPeerCoordinator>;
	readonly log: SnapshotLog;
	readonly inventory: FakeInventory;
}

export async function startCoordinator(
	t: TestContext,
	options: {
		readonly agentDir: string;
		readonly inventory?: FakeInventory;
		readonly testHooks?: PeerCoordinatorOptions["testHooks"];
		readonly log?: SnapshotLog;
		readonly closeOwnedSession?: PeerCoordinatorOptions["closeOwnedSession"];
		readonly createOwnedSession?: PeerCoordinatorOptions["createOwnedSession"];
		readonly renameOwnedSession?: PeerCoordinatorOptions["renameOwnedSession"];
		readonly savedCatalogViewFactory?: PeerCoordinatorOptions["savedCatalogViewFactory"];
		readonly savedViewer?: PeerCoordinatorOptions["savedViewer"];
	},
): Promise<StartedCoordinator> {
	const log = options.log ?? createSnapshotLog();
	const inventory = options.inventory ?? createFakeInventory();
	const coordinator = createPeerCoordinator({
		agentDir: options.agentDir,
		inventory,
		onChange: log.onChange,
		onIncomingConsentArrival: log.onArrival,
		...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
		...(options.closeOwnedSession === undefined ? {} : { closeOwnedSession: options.closeOwnedSession }),
		...(options.createOwnedSession === undefined ? {} : { createOwnedSession: options.createOwnedSession }),
		...(options.renameOwnedSession === undefined ? {} : { renameOwnedSession: options.renameOwnedSession }),
		...(options.savedCatalogViewFactory === undefined
			? {}
			: { savedCatalogViewFactory: options.savedCatalogViewFactory }),
		...(options.savedViewer === undefined ? {} : { savedViewer: options.savedViewer }),
	});
	t.after(async () => {
		try {
			await coordinator.close();
		} catch {
			// A rejected close is the test's own observed outcome, never a hook failure.
		}
	});
	await coordinator.start();
	return { coordinator, log, inventory };
}

export function firstHostId(snapshot: PeerUiSnapshot): string {
	const host = snapshot.hosts?.[0];
	assert.ok(host, "expected one saved destination");
	return host.id;
}

export function consentsOf(snapshot: PeerUiSnapshot, kind: PeerUiConsent["kind"]): readonly PeerUiConsent[] {
	return snapshot.consents.filter((consent) => consent.kind === kind);
}

/** An owned loopback port reserved briefly, then released for the fixture. */
export async function reserveLoopbackPort(t: TestContext): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string", "fixture did not bind a loopback port");
	const port = address.port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

/** Delay used only for controlled short-window timing witnesses. */
export function delay(ms: number): Promise<void> {
	// The test explicitly observes this finite interval even after the final
	// socket closes. Do not let an unreferenced witness cancel its own test.
	return new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});
}
