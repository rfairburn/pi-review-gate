/**
 * Narrow compatibility adapter for the pinned `@lydell/node-pty` Windows
 * bundled-ConPTY output reader (#666).
 *
 * Why this exists: in the pinned addon the ConPTY-DLL natural-exit path
 * (`windowsPtyAgent._$onProcessExit`) performs no reader cleanup at all — its
 * flush/cleanup ladder runs only for the non-DLL backend. On the DLL path a
 * reader disposal is reachable only through `kill()`, and there only from a
 * future `data` event, which cannot arrive once the child's output socket has
 * closed. The addon's owned conout reader Worker therefore stays alive after the
 * public PTY reported its genuine exit, and a live Worker keeps the owning Node
 * process from settling.
 *
 * This module captures the exact reader object the addon created for one
 * default-factory spawn, subscribes to that same public handle's own exit event,
 * and only then releases the reader through the addon's own drain/dispose path,
 * exactly once. Because the addon reaches its Worker through mutable internal
 * slots, the whole captured chain — handle, agent, connection, Worker, and the
 * dispose method itself — is revalidated at the actual exit before anything is
 * called, and only the captured method is invoked, only against the captured
 * receiver. A replaced pointer or method is never rebound to and never called.
 * This module never kills or signals a native process, never terminates the
 * Worker itself, never touches a handle whose ownership it cannot establish, and
 * never synthesizes an exit, an event, or a result.
 *
 * Settlement is observed rather than assumed: the captured Worker's own `exit`
 * event is the only positive evidence. An unconfirmed settlement is reported
 * truthfully to the owner, which turns it into a cleanup failure — never into
 * success. That observation is bounded by exactly one deadline per record,
 * anchored at the handle's exit that triggered the release and sized by the
 * owner's existing confirmation window; a later confirmation attempt never renews
 * or restarts it. A Worker exit that arrives before the handle's own exit is only
 * provisional: the chain is validated at that exit, and only then may the record
 * be called settled or pruned away. Positive evidence arriving after that deadline
 * — including a provisional early ending whose stop budget already ran out — is an
 * explicit `settlement-timeout` failure, never settlement.
 */
import { Worker } from "node:worker_threads";

/** Why a required release never ran; each one keeps the outcome an explicit failure. */
export type ConptyReaderRefusal =
	/** The exact handle's own exit event could not be subscribed, so no safe trigger exists. */
	| "trigger-unavailable"
	/** The spawned handle never exposed the pinned owned-reader chain to capture. */
	| "ownership-unidentified"
	/** A captured handle, agent, connection, Worker, or dispose slot was replaced. */
	| "ownership-replaced"
	/** The addon threw inside its own drain/dispose path. */
	| "disposal-threw"
	/** Settlement was not confirmed within the applicable absolute deadline. */
	| "settlement-timeout";

export type ConptyReaderSettlementState = "pending" | "settled" | "failed";

/** Truthful settlement view of one captured owned reader. */
export interface OwnedConptyReaderSettlement {
	readonly state: ConptyReaderSettlementState;
	/** True only when this module positively observed the captured Worker's exit. */
	readonly settled: boolean;
	/** True only when the captured drain/dispose method actually ran on the captured receiver. */
	readonly disposalRequested: boolean;
	/** True once the exact handle's own exit event fired, which is when a release becomes due. */
	readonly exitObserved: boolean;
	/** Why the release was refused or failed; `undefined` while nothing refused. */
	readonly refusal: ConptyReaderRefusal | undefined;
	/**
	 * Restrict confirmation to an already-started owned stop budget. Shortening
	 * only: a later call can move the deadline earlier but never renews, extends,
	 * or replaces a cap with a fresher window of its own.
	 */
	limitConfirmationDeadline(deadlineMs: number): void;
	/**
	 * Await positive settlement, bounded by the one absolute confirmation deadline
	 * this record established when the exact handle's exit made the release due
	 * (that exit plus the owner's existing confirmation window). A call after that
	 * deadline resolves `false` immediately: no window is ever rearmed, restarted,
	 * or granted afresh, and nothing resolves `true` without an observed Worker
	 * exit. `maxWaitMs`, when given, can only shorten the remaining wait.
	 */
	confirmSettlement(maxWaitMs?: number): Promise<boolean>;
}

/**
 * The complete identity chain captured at spawn. Every slot is re-read and
 * compared by identity at the actual exit, and only the captured `dispose` is
 * ever invoked, only against the captured `connection` receiver.
 */
interface CapturedOwnedReader {
	readonly handle: object;
	readonly agent: object;
	readonly connection: object;
	readonly worker: Worker;
	readonly dispose: () => void;
}

class CapturedConptyReader implements OwnedConptyReaderSettlement {
	readonly #owned: CapturedOwnedReader | undefined;
	readonly #confirmationWindowMs: number;
	readonly #waiters: (() => void)[] = [];
	#state: ConptyReaderSettlementState = "pending";
	#disposalRequested = false;
	#exitObserved = false;
	/** A Worker exit before the handle's own exit is only provisional. */
	#workerExitedEarly = false;
	#confirmationDeadlineMs: number | undefined;
	#refusal: ConptyReaderRefusal | undefined;

	constructor(owned: CapturedOwnedReader | undefined, confirmationWindowMs: number) {
		this.#owned = owned;
		this.#confirmationWindowMs = Math.max(0, confirmationWindowMs);
		if (owned === undefined) {
			// Nothing was owned, so this required release can never be confirmed.
			this.#refuse("ownership-unidentified");
			return;
		}
		// Attached synchronously at spawn: the addon created this Worker inside the
		// same synchronous spawn call, and a Worker reports `exit` only on a later
		// event-loop turn, so no exit can have been dispatched before this line.
		owned.worker.once("exit", () => {
			if (this.#state === "failed") return;
			if (!this.#exitObserved) {
				// Provisional only. The reader may have ended on its own, but the
				// release is validated against the captured chain at the handle's own
				// exit, so a record that died early is never reported settled before
				// then — and never pruned as if it were.
				this.#workerExitedEarly = true;
				return;
			}
			// A Worker exit is only positive evidence if it arrives inside the one
			// applicable deadline. After it, a late exit is an explicit failure: it must
			// not become settled success that disposal then skips as already clean.
			// A Worker exit is only positive evidence if it arrives inside the one
			// applicable deadline. After it, a late exit is an explicit failure: it must
			// not become settled success that disposal then skips as already clean.
			if (this.#confirmationDeadlineMs === undefined || Date.now() > this.#confirmationDeadlineMs) {
				this.#refuse("settlement-timeout");
				return;
			}
			this.#state = "settled";
			this.#notify();
		});
	}

	get state(): ConptyReaderSettlementState {
		return this.#state;
	}

	get settled(): boolean {
		return this.#state === "settled";
	}

	get disposalRequested(): boolean {
		return this.#disposalRequested;
	}

	get exitObserved(): boolean {
		return this.#exitObserved;
	}

	get refusal(): ConptyReaderRefusal | undefined {
		return this.#refusal;
	}

	/**
	 * Apply a shortening-only cap. The exit-anchored window below can only ever
	 * tighten an owner's already-running stop deadline, never widen it, so a late
	 * exit cannot restart time an exhausted stop already spent.
	 */
	limitConfirmationDeadline(deadlineMs: number): void {
		this.#confirmationDeadlineMs = Math.min(this.#confirmationDeadlineMs ?? Infinity, deadlineMs);
	}

	/**
	 * Invoke the captured drain/dispose method once, and only once, and only after
	 * the whole captured ownership chain still matches what spawn observed. A
	 * replaced pointer or method is recorded as a refusal: nothing is called,
	 * nothing is rebound, and the required cleanup stays an explicit failure.
	 * Duplicate exit events are latched here because the addon's own DLL-path
	 * `dispose()` re-arms its drain on every call.
	 */
	requestDisposal(): void {
		// This exact handle's exit is the only caller, and it is what makes a
		// required release due — even for a handle whose ownership was never
		// identified, so the owner learns the release came due and was not confirmed.
		// The one confirmation deadline is fixed here, once, from this exit; nothing
		// later grants a fresh window or restarts this one.
		if (!this.#exitObserved) {
			this.#exitObserved = true;
			this.limitConfirmationDeadline(Date.now() + this.#confirmationWindowMs);
		}
		// A settled reader needs no release, a refused one is never retried against a
		// chain this module no longer owns, and a duplicate exit never re-arms the
		// addon's drain.
		if (this.#state !== "pending" || this.#disposalRequested) return;
		const owned = this.#owned;
		if (owned === undefined || !this.#chainIntact()) {
			this.#refuse("ownership-replaced");
			return;
		}
		// The captured chain validated at the real exit: an owned reader that had
		// already ended on its own is genuinely settled, so nothing is drained — but
		// only if that ending still falls inside the applicable deadline.
		if (this.#workerExitedEarly) {
			if (this.#confirmationDeadlineMs === undefined || Date.now() > this.#confirmationDeadlineMs) {
				this.#refuse("settlement-timeout");
				return;
			}
			this.#state = "settled";
			this.#notify();
			return;
		}
		this.#disposalRequested = true;
		try {
			owned.dispose.call(owned.connection);
		} catch {
			// The addon refused its own disposal: the required release is unconfirmed.
			this.#refuse("disposal-threw");
		}
	}

	/** The exact handle's exit event is unavailable, so its release can never be triggered. */
	markTriggerUnavailable(): void {
		if (this.#state === "pending") this.#refuse("trigger-unavailable");
	}

	confirmSettlement(maxWaitMs?: number): Promise<boolean> {
		// Nothing is due before the exact handle's own exit, so nothing can be
		// confirmed — and a settled state is never reachable without that exit.
		if (!this.#exitObserved) return Promise.resolve(false);
		if (this.#state === "settled") return Promise.resolve(true);
		if (this.#state === "failed") return Promise.resolve(false);
		// The only bound is the absolute deadline fixed by the real exit. Before any
		// exit nothing is due and nothing may be reported settled; after that
		// deadline has passed this resolves at once instead of granting time again.
		const remainingMs = this.#confirmationDeadlineMs === undefined
			? 0
			: this.#confirmationDeadlineMs - Date.now();
		if (remainingMs <= 0) return Promise.resolve(false);
		const waitMs = maxWaitMs === undefined ? remainingMs : Math.min(remainingMs, Math.max(0, maxWaitMs));
		return new Promise<boolean>((resolve) => {
			const settle = (value: boolean): void => {
				clearTimeout(timer);
				drop();
				resolve(value);
			};
			const listener = (): void => settle(this.#state === "settled");
			const drop = (): void => {
				const index = this.#waiters.indexOf(listener);
				if (index >= 0) this.#waiters.splice(index, 1);
			};
			const timer = setTimeout(() => settle(this.#state === "settled"), waitMs);
			this.#waiters.push(listener);
		});
	}

	#notify(): void {
		for (const waiter of this.#waiters.splice(0, this.#waiters.length)) waiter();
	}

	#refuse(reason: ConptyReaderRefusal): void {
		this.#refusal = reason;
		this.#state = "failed";
		this.#notify();
	}

	/**
	 * Re-read every captured slot through the original handle and compare it by
	 * identity. Any difference — including a getter that now throws — means this
	 * module no longer owns what it captured, so nothing may be called.
	 */
	#chainIntact(): boolean {
		const owned = this.#owned;
		if (owned === undefined) return false;
		try {
			const agent = (owned.handle as { readonly _agent?: unknown })._agent;
			if (agent !== owned.agent) return false;
			if ((agent as { readonly _useConptyDll?: unknown })._useConptyDll !== true) return false;
			const connection = (agent as { readonly _conoutSocketWorker?: unknown })._conoutSocketWorker;
			if (connection !== owned.connection) return false;
			if ((connection as { readonly _worker?: unknown })._worker !== owned.worker) return false;
			if ((connection as { readonly dispose?: unknown }).dispose !== owned.dispose) return false;
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * The one handle-keyed registry of what this adapter owns. Keyed by the exact
 * public handle so a POSIX spawn, an injected custom/fake PTY, or any handle
 * this factory never created has no record at all and is never touched.
 */
const ownedRecords = new WeakMap<object, OwnedConptyReaderRecord>();

/** Reads the one pinned-addon identity chain this adapter recognizes; undefined for anything else. */
function readOwnedReaderChain(handle: object): CapturedOwnedReader | undefined {
	try {
		const agent = (handle as { readonly _agent?: unknown })._agent;
		if (typeof agent !== "object" || agent === null) return undefined;
		// Only the bundled-ConPTY backend leaks its reader; anything else stays
		// entirely with the addon's own (unchanged) cleanup.
		if ((agent as { readonly _useConptyDll?: unknown })._useConptyDll !== true) return undefined;
		const connection = (agent as { readonly _conoutSocketWorker?: unknown })._conoutSocketWorker;
		if (typeof connection !== "object" || connection === null) return undefined;
		const dispose = (connection as { readonly dispose?: unknown }).dispose;
		if (typeof dispose !== "function") return undefined;
		const worker = (connection as { readonly _worker?: unknown })._worker;
		// A real pinned-addon reader is always a `node:worker_threads` Worker; a
		// foreign, replaced, or stubbed reader is never treated as owned.
		if (!(worker instanceof Worker)) return undefined;
		return {
			handle,
			agent,
			connection,
			worker,
			dispose: dispose as () => void,
		};
	} catch {
		return undefined; // throwing getters and other foreign shapes fail closed
	}
}

/**
 * What the default PTY factory learned about one spawned handle. `captured` is
 * true only when the exact owned reader was captured at spawn. A false record is
 * retained deliberately: on the bundled-ConPTY path a release whose owner cannot
 * be identified is a required cleanup that must stay an explicit failure, never a
 * silently skipped one.
 */
export interface OwnedConptyReaderRecord {
	readonly captured: boolean;
	/** The truthful settlement record for this handle: captured, refused, or failed. */
	readonly settlement: OwnedConptyReaderSettlement;
}

/** How long an owner allows a release it already triggered to settle. */
export interface CaptureOwnedConptyReaderOptions {
	/**
	 * The owner's existing confirmation window. The adapter turns it into one
	 * absolute deadline anchored at the exact handle's exit — the moment the
	 * release was triggered — and never re-anchors or renews it.
	 */
	readonly confirmationWindowMs: number;
}

/**
 * Capture the exact owned reader of one freshly spawned default-factory handle
 * and wire its release to that same handle's own exit event. The default PTY
 * factory calls this only for its bundled-ConPTY request; POSIX spawns and every
 * injected factory never reach it, and the returned handle is never wrapped or
 * replaced.
 *
 * Repeat capture of the identical handle returns the existing record unchanged:
 * a second subscription can never schedule a second drain, and ownership is never
 * upgraded or rebound to whatever the handle points at now.
 */
export function captureOwnedConptyReader(
	ptyHandle: unknown,
	options: CaptureOwnedConptyReaderOptions,
): OwnedConptyReaderRecord | undefined {
	if (typeof ptyHandle !== "object" || ptyHandle === null) return undefined;
	const existing = ownedRecords.get(ptyHandle);
	if (existing !== undefined) return existing;
	const chain = readOwnedReaderChain(ptyHandle);
	const captured = new CapturedConptyReader(chain, options.confirmationWindowMs);
	const record: OwnedConptyReaderRecord = Object.freeze({
		captured: chain !== undefined,
		settlement: captured as OwnedConptyReaderSettlement,
	});
	ownedRecords.set(ptyHandle, record);
	try {
		// This exact handle's own public exit event is the only trigger allowed to
		// release the reader, so no disposal can ever precede the genuine exit. An
		// unrecognized chain still observes its exit, so the owner learns that a
		// required release came due and was never confirmed.
		(ptyHandle as { onExit(listener: (event: unknown) => void): unknown })
			.onExit(() => captured.requestDisposal());
	} catch {
		// Without the handle's own exit event there is no safe trigger; the required
		// release stays unconfirmed instead of guessing a moment to dispose.
		captured.markTriggerUnavailable();
	}
	return record;
}

/**
 * The adapter's record for a handle this module's default factory spawned, or
 * `undefined` for any other handle — which is exactly "no owned addon reader
 * exists here", so nothing is required and nothing is touched.
 */
export function ownedConptyReaderRecord(ptyHandle: object): OwnedConptyReaderRecord | undefined {
	return ownedRecords.get(ptyHandle);
}
