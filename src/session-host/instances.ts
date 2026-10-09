import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { IPty } from "@lydell/node-pty";

import { NativeAgentRegistry, PreparedProfile, ProfilePreparer } from "./profiles";
import {
  SESSION_HOST_BOOTSTRAP_ENV,
  NativeLaunchDescriptor,
  prepareNativeLaunch,
} from "./launch";
import { TerminalSurface } from "./terminal-surface";
import { hasCompleteSessionIdle, isValidNativeSessionId, isValidRenameName, type SessionHostNativeSession } from "./protocol";
import { isSavedSessionAdmission, type OwnedLiveSession, type SavedSessionAdmission } from "./saved-sessions";
import type { StatusRenameRequest, StatusRenameResult, StatusShutdownResult } from "./broker";

/**
 * Independent owned-PTY process lifecycle for the optional per-instance
 * custom terminal host (#323 alpha, POSIX and source-level Windows ConPTY path).
 *
 * `InstanceManager` owns the full native lifecycle of one or more independent
 * native Pi session-host processes. By default every row uses one shared
 * native Pi agent directory; only explicit legacy test mode uses private
 * profiles. Each row owns, exclusively:
 *
 * - one explicitly selected workspace (canonical cwd of the child);
 * - one prepared native launch descriptor (`prepareNativeLaunch`) applied
 *   verbatim: file/argv/env/cwd are never rewritten by the manager;
 * - one status registration created BEFORE the child is spawned, whose
 *   JSON bootstrap ({@linkcode SESSION_HOST_BOOTSTRAP_ENV}) is injected only
 *   into a fresh clone of the descriptor env at the actual PTY spawn —
 *   never during setup work and never into the caller's
 *   environment, which is never mutated;
 * - one `InstancePty` (real @lydell/node-pty 1.2.0-beta.15, lazy-loaded only
 *   when the default factory actually spawns; never imported eagerly so a
 *   standalone embed can never load the native addon accidentally);
 * - one `TerminalSurface` parsing that PTY's raw output into sanitized
 *   frames, with the surface's query replies written back ONLY to that
 *   same instance's PTY (no raw child bytes ever escape to a real tty) and
 *   with the surface's queued-bytes/count backpressure pausing and resuming
 *   that same PTY;
 * - one bounded, copied, immutable view row (later SidebarItem shape).
 *
 * Safety semantics (fail closed):
 *
 * - Input is written only to the explicitly addressed instance id whose
 *   child is still known alive. There is no implicit selected-instance
 *   fallback and no input translation, no sidebar focus logic, and no
 *   frontend concerns in this module. Stale callbacks (exit/data/status
 *   events from older, released, or disposed records and registrations) are
 *   guarded per instance and can never affect another row.
 * - Exit and disconnect are truthful: the lifecycle badge is the actual
 *   owned child state, the exit code comes only from the owned exit event,
 *   and `busy`/`pendingInput`/owned-work counts collapse to null on exit or
 *   reporter disconnect (never inferred, never "Idle"/zero), keeping the
 *   retained last frame (queued bytes are flushed before the surface freezes).
 * - Shutdown and dispose are bounded and owned-scoped: request graceful exit
 *   through the active authenticated public status registration when
 *   available; on POSIX, fall back to SIGTERM and escalate with SIGKILL on the
 *   same owned PTY handle only. On Windows, force through that handle's
 *   no-argument kill() API; it is never treated as graceful. There are no
 *   global process scans, arbitrary group kills, or daemon/adopted-descendant
 *   cleanup (remaining handles are reported honestly and are released only
 *   when their own exit event fires).
 *   Setup admission is released only after a known child exit or a
 *   failed spawn before any child exists; a kill that never settles never
 *   frees an admission as if it were safely gone.
 * - Resource ownership is recorded before any spawned-child callback can
 *   fire; parser/spawn/read/resize failures are contained per instance with
 *   a truthful bounded public error, never silently losing ownership and
 *   never stopping siblings.
 * - Diagnostics carry at most bounded, single-line public error text: no
 *   arguments, no config contents, no tokens, and no provider environment
 *   values; the bootstrap token is redacted even if it somehow surfaced in
 *   an upstream message.
 * - Deliberate saved-conversation creation (issue 323) accepts a branded
 *   SavedSessionAdmission, reserves its session id/exact file synchronously
 *   before any await so concurrent deliberate opens cannot spawn duplicates,
 *   and passes the receipt verbatim to prepareNativeLaunch. The reservation
 *   is released only when creation definitively failed before a child exists
 *   or the exact owned PTY actually exited — never on an acknowledgement,
 *   unknown state, or reporter disconnect. Each row also keeps its
 *   last-observed current native conversation id privately (replaced by a
 *   newer observed binding on native /new or /resume) so duplicate fencing
 *   survives status disconnects; exited and removed rows never block
 *   reopening their saved conversation.
 */

export interface StopInstanceResult {
	readonly status: "exited" | "confirmation-required" | "unavailable" | "unconfirmed";
	readonly forced: boolean;
}

/** Default terminal geometry for newly created instances. */
export const DEFAULT_INSTANCE_COLS = 80;
export const DEFAULT_INSTANCE_ROWS = 24;

/** Default bounded windows for graceful owned shutdown escalation. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 8000;
export const DEFAULT_SHUTDOWN_KILL_MS = 2000;

/** Internal policy seam for synthetic manager tests; production defaults to the actual host platform. */
let shutdownPlatformForTests: NodeJS.Platform | undefined;

/** Upper bound for a single-line instance label (UTF-16 code units). */
export const MAX_LABEL_CHARS = 80;

/** Bounds for the copied activity snapshot: two lines, each at most 120 Unicode code points. */
export const MAX_ACTIVITY_ENTRIES = 2;
export const MAX_ACTIVITY_ENTRY_CHARS = 120;

/** Upper bound for the bounded public error text of an errored row. */
export const MAX_INSTANCE_ERROR_CHARS = 240;

/** Lifecycle of one owned instance row; always the process's actual state. */
export type InstanceLifecycle = "starting" | "alive" | "exited" | "error";

/**
 * The small structural PTY surface the manager needs — the exact public
 * subset of the pinned `@lydell/node-pty` `IPty` (data/exit events, write,
 * resize, kill, pause/resume), injectable so focused tests never load the
 * native addon. The default factory casts the real pinned implementation to
 * this interface; Windows ConPTY uses node-pty's normal public spawn API,
 * not private bindings or emulated callbacks. Actual Windows behavior still
 * requires the parent-owned native validation harness.
 */
export interface InstancePty {
	readonly pid: number;
	readonly cols: number;
	readonly rows: number;
	onData(listener: (data: string) => void): { dispose(): void };
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
	/** Runtime node-pty EventEmitter hooks; the pinned declaration omits these inherited methods. */
	on?(eventName: "error", listener: (error: Error) => void): unknown;
	removeListener?(eventName: "error", listener: (error: Error) => void): unknown;
	write(data: string | Buffer): void;
	resize(columns: number, rows: number): void;
	kill(signal?: string): void;
	pause(): void;
	resume(): void;
}

/** The exact spawn descriptor handed to the PTY factory. */
export interface InstanceSpawnDescriptor {
	file: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
	cols: number;
	rows: number;
}

export type PtyFactory = (descriptor: InstanceSpawnDescriptor) => InstancePty;

/** Status update published by the per-instance status reporter. */
export interface InstanceStatusUpdate {
	busy: boolean | null;
	pendingInput: boolean | null;
	inputSurface: boolean;
	activity: readonly string[];
	/** Optional canonical native conversation metadata; never transcript or status detail. */
	nativeSession?: SessionHostNativeSession | null;
	/**
	 * Optional bounded owned background-work counts. Omitted by an older
	 * registrar; absence, null, or any invalid value normalizes to null
	 * (unknown), never zero. Never a PID/process count.
	 */
	backgroundTasks?: number | null;
	backgroundShells?: number | null;
	/**
	 * Optional bounded ACTIVITY-INTENT counts, independent of ownership. Absent
	 * or invalid normalizes to null (unknown), never zero. Display reads these;
	 * the stop/idle gate keeps reading the ownership pair above.
	 */
	activeTasks?: number | null;
	activeShells?: number | null;
}

export interface InstanceStatusHandlers {
	onStatus(update: InstanceStatusUpdate): void;
	onDisconnect(): void;
}

export interface InstanceStatusBootstrap {
	readonly version: 1;
	readonly socketPath: string;
	readonly token: string;
	readonly instanceId: string;
	readonly generation: string;
}

export interface InstanceStatusRegistration {
	readonly bootstrap: InstanceStatusBootstrap;
	/** Authenticated persisted rename when supported by the current registrar. */
	rename?(request: StatusRenameRequest): Promise<StatusRenameResult>;
	/** Authenticated public native shutdown when supported; acceptance is not PTY exit. */
	shutdown?(options?: { readonly requireIdle?: boolean }): Promise<StatusShutdownResult>;
	release(): void;
}

/**
 * Structural status registrar contract. The broker owns all authentication,
 * generation, request-fence, and wire checks; this module never duplicates
 * any wire parser.
 */
export interface StatusRegistrar {
	register(instanceId: string, handlers: InstanceStatusHandlers): InstanceStatusRegistration;
}

/** Immutable, copied view row for one instance (later SidebarItem shape). */
export interface NativeInstanceView {
	readonly id: string;
	readonly label: string;
	readonly workspace: string;
	readonly agentDir: string;
	readonly lifecycle: InstanceLifecycle;
	readonly busy: boolean | null;
	readonly pendingInput: boolean | null;
	readonly inputSurface: boolean;
	/** Last validated native conversation tuple; null means unavailable/unknown. */
	readonly nativeSession: SessionHostNativeSession | null;
	/** Retained current binding for exited-row restart only; never revives live command availability. */
	readonly lastNativeSession?: SessionHostNativeSession;
	/** Observed owned logical background work (tasks + automatic review); null means unknown, never 0. */
	readonly backgroundTasks?: number | null;
	/** Observed owned background shell jobs not yet confirmed settled; null means unknown, never 0. */
	readonly backgroundShells?: number | null;
	/** Observed admitted/running logical work intent; null means unknown, never 0. */
	readonly activeTasks?: number | null;
	/** Observed starting/running background shell intent; null means unknown, never 0. */
	readonly activeShells?: number | null;
	/** True only while this manager still owns a PTY without a confirmed exit. */
	readonly hasLiveProcess: boolean;
	readonly activity: readonly string[];
	readonly exitCode?: number;
	/** Bounded single-line public failure text; set only on `error` rows. */
	readonly error?: string;
}

export interface CreateInstanceOptions {
	/** Legacy/test-only initial display label; production creation omits it and waits for native metadata. */
	label?: string;
	/** Explicit workspace directory for the instance's child process. */
	workspace: string;
	/** Legacy-test-only explicit profile directory; native setup rejects it. */
	profile?: string;
	/**
	 * Deliberate per-child saved-conversation selection: a branded receipt
	 * minted by admitSavedSession (src/session-host/saved-sessions.ts) from the
	 * read-only native saved-conversation catalog. The exact saved header cwd
	 * (`admission.workspace`) determines the child workspace and must equal
	 * `workspace` — the host cwd is never substituted. The receipt is reserved
	 * synchronously before any await for known-owned duplicate fencing and
	 * passed verbatim to prepareNativeLaunch.
	 */
	savedSession?: SavedSessionAdmission;
}

export interface InstanceManagerOptions {
	/** Already-built gate package root (owning dist/src/index.js). */
	packageRoot: string;
	/** Pi executable (already resolved and version-probed by resolveNativePi). */
	piExecutable: string;
	/** Per-instance status registrar (the future broker); rows are registered before spawn. */
	statusRegistrar: StatusRegistrar;
  /** Native setup is the production/default mode; false requires explicit test injection. */
  nativeSetup?: boolean;
  /** Structural setup preparer (legacy option name retained for compatibility). */
  profileRegistry?: ProfilePreparer;
	/** Native pi arguments snapshotted at construction and forwarded verbatim to each launch. */
	args?: readonly string[];
	/** Environment snapshotted at construction (or from process.env); caller originals are never mutated. */
	env?: NodeJS.ProcessEnv;
	/** Initial geometry shared by instances (default 80x24). */
	cols?: number;
	/** Initial geometry shared by instances (default 80x24). */
	rows?: number;
	/** Kitty keyboard flags support passed through to each terminal surface. */
	getSupportedKeyboardFlags?: () => number;
	/** Called with an instance id whenever that row changed (frontend hook). */
	onChange?: (instanceId: string) => void;
	/** PTY factory; defaults to the pinned real @lydell/node-pty (lazily loaded). */
	ptyFactory?: PtyFactory;
}

export interface ShutdownOptions {
	/** Shared grace window for public shutdown request and POSIX SIGTERM fallback (default 8000 ms). */
	graceMs?: number;
	/** Confirmation window after forced owned-handle escalation (default 2000 ms). */
	killMs?: number;
}

/** Truthful outcome: forced = owned-handle force escalation was attempted; remaining = never confirmed exit. */
export interface ShutdownResult {
	readonly forcedIds: readonly string[];
	readonly remainingIds: readonly string[];
}

interface ManagedInstance {
	id: string;
	/**
	 * True only once THIS row's own asynchronous launch has positively
	 * finished. Initialized before any await and finalized in create()'s
	 * finally, so it distinguishes a completed, already-released failed launch
	 * from a row whose preparation or spawn is still in flight. It is never
	 * inferred from a missing PTY handle, a sibling's state, a status count, or
	 * the global create set.
	 */
	launchSettled: boolean;
	label: string;
	nativeSession: SessionHostNativeSession | null;
	lastNativeSession?: SessionHostNativeSession;
	workspace: string;
	agentDir: string;
	lifecycle: InstanceLifecycle;
	busy: boolean | null;
	pendingInput: boolean | null;
	inputSurface: boolean;
	backgroundTasks: number | null;
	backgroundShells: number | null;
	activeTasks: number | null;
	activeShells: number | null;
	activity: string[];
	exitCode?: number;
	error?: string;
	profile?: PreparedProfile;
	profileReleased: boolean;
	/**
	 * True only once this row's profile admission release positively returned
	 * (or there was none to release). Distinct from profileReleased, which is
	 * only an idempotency latch set before the external call: a throwing release
	 * leaves this false so removal stays fail closed.
	 */
	profileReleaseSettled: boolean;
	/**
	 * Synchronous saved-session creation reservation (issue 323): set before
	 * any await in create() and released only when creation definitively failed
	 * before a child exists or the exact owned PTY actually exited — never on
	 * an acknowledgement, unknown state, or reporter disconnect.
	 */
	savedReservation?: { readonly sessionId: string; readonly file: string };
	/**
	 * Last-observed CURRENT native conversation id, kept privately for
	 * duplicate fencing across status disconnects. Replaced only by a newer
	 * observed binding (native /new or /resume); never a UI badge.
	 */
	knownNativeSessionId?: string;
	registration?: InstanceStatusRegistration;
	registrationReleased: boolean;
	/**
	 * True only once this row's registration release positively returned (or
	 * there was none to release). Distinct from registrationReleased, which is
	 * only an idempotency latch set before the external call: a throwing release
	 * leaves this false so removal stays fail closed.
	 */
	registrationReleaseSettled: boolean;
	surface?: TerminalSurface;
	pty?: InstancePty;
	ptyExited: boolean;
	sigtermSent: boolean;
	sigkillSent: boolean;
	stopPromise?: Promise<boolean>;
	exitWaiters: (() => void)[];
	dataDisposable?: { dispose(): void };
	exitDisposable?: { dispose(): void };
	readErrorDisposable?: { dispose(): void };
}

/** The lazy loader for the pinned real native PTY implementation. */
interface LoadedNodePty {
	spawn(file: string, args: string[], options: {
		name: string;
		cols: number;
		rows: number;
		cwd: string;
		env: NodeJS.ProcessEnv;
		/**
		 * Windows-only public option of the pinned node-pty: prefer the ConPTY
		 * DLL bundled with the platform package over the host's system ConPTY.
		 */
		useConptyDll?: boolean;
	}): IPty;
}

const nodePtyRequire = createRequire(__filename);
let cachedNodePty: LoadedNodePty | undefined;
let nodePtyLoaderForTests: (() => LoadedNodePty) | undefined;

export const __test = Object.freeze({
	setShutdownPlatform(platform: NodeJS.Platform | undefined): void {
		shutdownPlatformForTests = platform;
	},
	setNodePtyLoaderForTests(loader: (() => LoadedNodePty) | undefined): void {
		nodePtyLoaderForTests = loader;
		cachedNodePty = undefined;
	},
});

/**
 * The default PTY factory. Loads the pinned `@lydell/node-pty` module only
 * when an instance actually spawns (never at import time), so a standalone
 * embed can never load the native addon accidentally.
 */
export function createDefaultPtyFactory(): PtyFactory {
	return (descriptor: InstanceSpawnDescriptor): InstancePty => {
		let nodePty = cachedNodePty;
		if (!nodePty) {
			nodePty = nodePtyLoaderForTests?.() ?? nodePtyRequire("@lydell/node-pty") as LoadedNodePty;
			cachedNodePty = nodePty;
		}
		// The pinned implementation satisfies the InstancePty subset
		// structurally (data/exit events, write, resize, kill, pause/resume).
		return nodePty.spawn(descriptor.file, descriptor.args, {
			name: "xterm-256color",
			cols: descriptor.cols,
			rows: descriptor.rows,
			cwd: descriptor.cwd,
			env: descriptor.env,
			// Windows-only: explicitly select the ConPTY DLL bundled with the
			// pinned public @lydell/node-pty instead of the host's system ConPTY,
			// so the shipped source path matches the acceptance transport.
			// POSIX options are unchanged, and the deprecated ignored
			// `useConpty` hint is never set.
			...(process.platform === "win32" ? { useConptyDll: true } : {}),
		});
	};
}

function validateDimension(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
		throw new Error(`session-host: instance ${label} must be a safe integer between 1 and 1000, got ${value}`);
	}
}

function validateShutdownMs(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`session-host: shutdown ${label} must be a non-negative safe integer, got ${value}`);
	}
}

/** Only a well-shaped accepted public response suppresses the POSIX SIGTERM fallback. */
function validShutdownRequest(value: unknown): boolean {
	try {
		if (typeof value !== "object" || value === null) return false;
		const result = value as Partial<StatusShutdownResult>;
		return typeof result.requestId === "string"
			&& result.requestId.length > 0
			&& ["requested", "rejected", "unavailable", "busy", "timeout", "disconnected"].includes(result.status as string)
			&& result.status === "requested";
	} catch {
		// Malformed foreign objects (including throwing getters) fail closed.
		return false;
	}
}

/** Fixed public diagnostics never copy upstream arguments, env, config, or token material. */
const PUBLIC_INSTANCE_ERRORS = {
	launchPreparation: "session-host: instance launch preparation failed",
	ptySetup: "session-host: instance PTY setup failed",
	outputParsing: "session-host: instance output parsing failed",
	queryReply: "session-host: instance query reply write failed",
	ptyRead: "session-host: instance PTY read failed",
	ptyResize: "session-host: instance PTY resize failed",
	surfaceResize: "session-host: instance terminal surface resize failed",
	ptyPause: "session-host: instance PTY pause failed",
	ptyResume: "session-host: instance PTY resume failed",
} as const;

type InstanceErrorCode = keyof typeof PUBLIC_INSTANCE_ERRORS;

function publicInstanceError(code: InstanceErrorCode): string {
	const message = PUBLIC_INSTANCE_ERRORS[code];
	return message.length <= MAX_INSTANCE_ERROR_CHARS
		? message
		: "session-host: instance operation failed";
}

/**
 * Subscribe to the pinned PTY's inherited EventEmitter error channel. The
 * pinned UnixTerminal attaches one internal socket error handler and throws
 * unexpected errors if there is no second listener; `on`/`removeListener`
 * forward to that same socket in the installed 1.2.0-beta.15 runtime.
 */
function subscribePtyReadErrors(pty: InstancePty, listener: (error: Error) => void): { dispose(): void } {
	if (typeof pty.on !== "function" || typeof pty.removeListener !== "function") {
		throw new Error("PTY error event subscription is unavailable");
	}
	let disposed = false;
	const onError = (error: Error): void => {
		const code = (error as NodeJS.ErrnoException).code;
		if (disposed || (typeof code === "string" && (
			code.includes("EAGAIN") || code.includes("EIO") || code.includes("errno 5")
		))) {
			return;
		}
		listener(error);
	};
	pty.on("error", onError);
	return {
		dispose: () => {
			if (disposed) return;
			disposed = true;
			// Keep the second listener throughout native error dispatch.
			setImmediate(() => {
				try {
					pty.removeListener?.("error", onError);
				} catch {
					// Listener cleanup remains best-effort after confirmed exit.
				}
			});
		},
	};
}

/** Bounded, copied activity snapshot (count- and length-capped). */
function boundedActivity(activity: readonly string[] | undefined): string[] {
	if (!Array.isArray(activity)) {
		return [];
	}
	return activity.slice(-MAX_ACTIVITY_ENTRIES).map((entry) => {
		if (typeof entry !== "string") {
			return "";
		}
		// Registrar lines are structural text, not terminal output: remove
		// controls rather than allowing CR/LF or C1 bytes into the sidebar.
		let line = "";
		let codePoints = 0;
		for (const character of entry) {
			const code = character.codePointAt(0)!;
			if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
				continue;
			}
			line += character;
			if (++codePoints === MAX_ACTIVITY_ENTRY_CHARS) {
				break;
			}
		}
		return line;
	});
}

/**
 * Normalizes an observed owned-work count: only a nonnegative safe integer is
 * real. Absence, null, fractions, negatives, and non-numbers are unknown
 * (null) — a cleared or unavailable tracker is never reported as zero.
 */
function normalizedOwnedCount(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		return null;
	}
	return value === 0 ? 0 : value; // normalize -0
}

function validatedNativeSession(value: unknown): SessionHostNativeSession | null | undefined {
	if (value === null) return null;
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Partial<SessionHostNativeSession>;
	if (!isValidNativeSessionId(candidate.sessionId)
		|| !Number.isSafeInteger(candidate.epoch) || (candidate.epoch as number) < 1
		|| typeof candidate.name !== "string"
		|| candidate.name.trim().length === 0 || candidate.name.trim() !== candidate.name
		|| [...candidate.name].length > 256 || Buffer.byteLength(candidate.name, "utf8") > 1024
		|| /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(candidate.name)) return undefined;
	return {
		sessionId: candidate.sessionId, epoch: candidate.epoch as number, name: candidate.name,
		...(candidate.persistence === "saved" || candidate.persistence === "unsaved" || candidate.persistence === "unknown"
			? { persistence: candidate.persistence } : {}),
	};
}

function validateLabel(label: unknown): string {
	if (typeof label !== "string") {
		throw new Error("session-host: instance label must be a string");
	}
	if (label.length > MAX_LABEL_CHARS) {
		throw new Error(`session-host: instance label exceeds the ${MAX_LABEL_CHARS}-character bound`);
	}
	if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(label)) {
		throw new Error("session-host: instance label must be a single line (control characters and line breaks are rejected)");
	}
	return label;
}

/**
 * Manager of independently owned native session-host instances. See the
 * module documentation for the ownership, isolation, and shutdown rules.
 */
export class InstanceManager {
	readonly #packageRoot: string;
	readonly #piExecutable: string;
	readonly #statusRegistrar: StatusRegistrar;
	readonly #profilePreparer: ProfilePreparer;
	readonly #nativeSetup: boolean;
	readonly #args: readonly string[];
	readonly #env: NodeJS.ProcessEnv;
	#cols: number;
	#rows: number;
	readonly #getSupportedKeyboardFlags?: () => number;
	readonly #onChange?: (instanceId: string) => void;
	readonly #ptyFactory: PtyFactory;
	readonly #shutdownPlatform: NodeJS.Platform;
	readonly #records = new Map<string, ManagedInstance>();
	readonly #inflightCreates = new Set<Promise<void>>();
	#stopping = false;
	#disposed = false;
	#disposePromise?: Promise<void>;

	constructor(options: InstanceManagerOptions) {
		if (!options || typeof options !== "object") {
			throw new Error("session-host: InstanceManager requires constructor options");
		}
		if (typeof options.packageRoot !== "string" || options.packageRoot === "") {
			throw new Error("session-host: InstanceManager requires a packageRoot");
		}
		if (typeof options.piExecutable !== "string" || options.piExecutable === "") {
			throw new Error("session-host: InstanceManager requires a piExecutable");
		}
		if (!options.statusRegistrar || typeof options.statusRegistrar.register !== "function") {
			throw new Error("session-host: InstanceManager requires a statusRegistrar with register()");
		}
		this.#packageRoot = options.packageRoot;
		this.#piExecutable = options.piExecutable;
		this.#statusRegistrar = options.statusRegistrar;
		this.#args = [...(options.args ?? [])];
		this.#env = { ...(options.env ?? process.env) };
		this.#cols = options.cols ?? DEFAULT_INSTANCE_COLS;
		this.#rows = options.rows ?? DEFAULT_INSTANCE_ROWS;
		validateDimension(this.#cols, "cols");
		validateDimension(this.#rows, "rows");
		if (options.profileRegistry !== undefined && options.nativeSetup === undefined) {
			throw new Error("session-host: nativeSetup must be explicit when a setup preparer is injected");
		}
		if (options.nativeSetup === false && options.profileRegistry === undefined) {
			throw new Error("session-host: nativeSetup:false requires an explicitly injected legacy setup preparer");
		}
		this.#nativeSetup = options.nativeSetup ?? true;
		this.#profilePreparer = options.profileRegistry ?? new NativeAgentRegistry({ env: this.#env });
		this.#getSupportedKeyboardFlags = options.getSupportedKeyboardFlags;
		this.#onChange = options.onChange;
		this.#ptyFactory = options.ptyFactory ?? createDefaultPtyFactory();
		this.#shutdownPlatform = shutdownPlatformForTests ?? process.platform;
	}

	/** Current rows, copied and immutable per call (later SidebarItem shape). */
	list(): NativeInstanceView[] {
		const views: NativeInstanceView[] = [];
		for (const record of this.#records.values()) {
			const view: NativeInstanceView & { exitCode?: number; error?: string } = {
				id: record.id,
				label: record.label,
				nativeSession: record.nativeSession ? Object.freeze({ ...record.nativeSession }) : null,
				...(record.lastNativeSession ? { lastNativeSession: Object.freeze({ ...record.lastNativeSession }) } : {}),
				workspace: record.workspace,
				agentDir: record.agentDir,
				lifecycle: record.lifecycle,
				hasLiveProcess: Boolean(record.pty && !record.ptyExited),
				busy: record.busy,
				pendingInput: record.pendingInput,
				inputSurface: record.inputSurface,
				backgroundTasks: record.backgroundTasks,
				backgroundShells: record.backgroundShells,
				activeTasks: record.activeTasks,
				activeShells: record.activeShells,
				activity: Object.freeze([...record.activity]),
			};
			if (record.exitCode !== undefined) {
				view.exitCode = record.exitCode;
			}
			if (record.error !== undefined) {
				view.error = record.error;
			}
			views.push(Object.freeze(view));
		}
		return views;
	}

	/**
	 * The terminal surface of one instance (the retained last frame stays
	 * readable after the child exited, until the manager is disposed) or
	 * undefined for unknown ids and rows that never got a parse pipeline.
	 */
	surface(id: string): TerminalSurface | undefined {
		if (this.#disposed) {
			return undefined;
		}
		return this.#records.get(id)?.surface;
	}

	/**
	 * Remove one row whose owned PTY has confirmed exit. This never signals a
	 * process: unknown rows, rows without an observed PTY exit, and every
	 * still-owned live process are left untouched. Persistent workspace/native
	 * data is outside the manager's cleanup ownership and is never removed.
	 * Returns true only when the row was removed; otherwise returns false.
	 */
	closeExited(id: string): boolean {
		const record = this.#records.get(id);
		if (!record || !record.pty || !record.ptyExited) {
			return false;
		}
		this.#detachRow(record);
		return true;
	}

	/**
	 * Remove one terminal `error` row that owns no live or unsettled child.
	 *
	 * This is the deliberate error-row cleanup for a failed launch: it never
	 * signals a process, never touches workspace/native files, and never
	 * affects a sibling. It refuses unless the exact record is still in the
	 * map, its own asynchronous launch has positively finished, and the row is
	 * terminally errored. A row that still owns its original PTY refuses while
	 * that child has no confirmed exit; once the exact owned exit is observed
	 * the removal is delegated to {@linkcode closeExited}, preserving that
	 * strict actual-exit-only path and its cleanup exactly. A row that never
	 * created a child is removable only when the failed launch has positively
	 * completed cleanup — its registration and profile admission releases
	 * actually returned (or there was nothing to release) and any saved-session
	 * reservation was cleared. A missing handle, an idempotency latch set before
	 * a throwing release, stale status, an unknown PID, or a false busy/zero
	 * count is never evidence of that. Returns true only when the row was
	 * removed.
	 */
	closeError(id: string): boolean {
		const record = this.#records.get(id);
		if (!record || this.#disposed || record.lifecycle !== "error" || !record.launchSettled) {
			return false;
		}
		if (record.pty) {
			// The original owned child exists: only its own confirmed exit may
			// release it, through the strict exited-row path.
			return record.ptyExited ? this.closeExited(id) : false;
		}
		// No child was ever created. Require positively completed cleanup of the
		// failed launch (registration and profile release actually returned, and
		// any saved-session reservation was cleared) instead of an idempotency
		// latch, a missing handle, or UI flags.
		if (!record.registrationReleaseSettled || !record.profileReleaseSettled || record.savedReservation !== undefined) {
			return false;
		}
		this.#detachRow(record);
		return true;
	}

	/**
	 * Detach one already-removable row (no live/unsettled owned child) from the
	 * live map, then dispose only its manager-owned in-memory bookkeeping with
	 * the scoped, idempotent cleanup helpers. Nothing on disk is touched and no
	 * process is signaled. Callers must have established removability.
	 */
	#detachRow(record: ManagedInstance): void {
		// Detach first so even synchronous callbacks caused by cleanup (or
		// callbacks already queued by the PTY/status source) are stale before
		// any retained resource is disposed, and cannot resurrect or retarget
		// this row.
		this.#records.delete(record.id);
		this.#releaseRegistration(record);
		this.#disposeDataListener(record);
		this.#disposeExitListener(record);
		this.#disposeReadErrorListener(record);
		try {
			record.surface?.dispose();
		} catch {
			// Teardown is scoped to this already-detached row; still notify removal.
		}
		record.surface = undefined;
		record.registration = undefined;
		record.profile = undefined;
		record.pty = undefined;
		record.stopPromise = undefined;
		this.#safeChanged(record.id);
	}

	/** Stop ONLY this exact owned row; removal is a separate actual-exit-only operation. */
	async stop(id: string, options: { readonly confirmed: boolean }): Promise<StopInstanceResult> {
		const record = this.#records.get(id);
		if (!record || !record.pty || this.#disposed || this.#stopping) return { status: "unavailable", forced: false };
		const outcome = (): StopInstanceResult => ({ status: record.ptyExited ? "exited" : "unconfirmed", forced: record.sigkillSent });
		if (record.ptyExited) return outcome();
		if (record.stopPromise) { await record.stopPromise; return outcome(); }
		let alreadyRequested = false;
		if (options?.confirmed !== true) {
			if (!hasCompleteSessionIdle(record)) return { status: "confirmation-required", forced: false };
			const registration = record.registration;
			if (!registration || record.registrationReleased) return { status: "confirmation-required", forced: false };
			// Register before the public request, because it may synchronously exit.
			// This bounded preflight never sends a fallback signal or force attempt.
			const exit = this.#waitForExit(record, DEFAULT_SHUTDOWN_GRACE_MS);
			let request: Promise<StatusShutdownResult | undefined>;
			try {
				const shutdown = registration.shutdown;
				if (typeof shutdown !== "function") return { status: "confirmation-required", forced: false };
				request = Promise.resolve(shutdown.call(registration, { requireIdle: true })).catch(() => undefined);
			} catch {
				return { status: "confirmation-required", forced: false };
			}
			const first = await Promise.race([
				request.then((result) => ({ kind: "request" as const, result })),
				exit.then((exited) => ({ kind: "exit" as const, exited })),
			]);
			if (record.ptyExited) return outcome();
			if (this.#records.get(id) !== record || this.#disposed) return { status: "unavailable", forced: record.sigkillSent };
			if (first.kind !== "request" || !validShutdownRequest(first.result)) {
				return { status: "confirmation-required", forced: record.sigkillSent };
			}
			alreadyRequested = true;
		}
		await this.#gracefulStop(record, DEFAULT_SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_KILL_MS, alreadyRequested);
		return outcome();
	}

	/** Launch one independently owned instance and resolve with its row id. */
	async create(options: CreateInstanceOptions): Promise<string> {
		if (this.#disposed || this.#stopping) {
			throw new Error("session-host: the instance manager is shut down; no new instances can be created");
		}
		const label = options?.label === undefined ? "(session starting)" : validateLabel(options.label);
		if (typeof options?.workspace !== "string" || options.workspace === "") {
			throw new Error("session-host: create requires an explicit workspace directory");
		}
		const profile = options.profile;
		if (profile !== undefined && typeof profile !== "string") {
			throw new Error("session-host: the instance profile directory must be a string");
		}
		const savedSession = options.savedSession;
		if (savedSession !== undefined && !isSavedSessionAdmission(savedSession)) {
			throw new Error("session-host: the saved-session selection is not a valid admission receipt; select from the current saved-conversation catalog");
		}
		// The exact saved header cwd determines the child workspace; a
		// conflicting explicit workspace is refused, never silently substituted.
		if (savedSession !== undefined && options.workspace !== savedSession.workspace) {
			throw new Error("session-host: a saved-session selection uses the conversation's recorded workspace");
		}
		// Synchronous known-owned duplicate fence and reservation BEFORE any
		// await: concurrent deliberate opens of the same saved conversation
		// cannot both spawn, including pending creations of siblings.
		if (savedSession !== undefined) {
			this.#assertSavedSessionAvailable(savedSession);
		}
		const id = randomUUID();
		// Row posted (resource ownership starts here) before any async step.
		const record: ManagedInstance = {
			id,
			label,
			nativeSession: null,
			workspace: options.workspace,
			agentDir: "",
			lifecycle: "starting",
			busy: null,
			pendingInput: null,
			inputSurface: false,
			backgroundTasks: null,
			backgroundShells: null,
			activeTasks: null,
			activeShells: null,
			activity: [],
			savedReservation: savedSession !== undefined
				? { sessionId: savedSession.sessionId, file: savedSession.file }
				: undefined,
			launchSettled: false,
			profileReleased: false,
			profileReleaseSettled: false,
			registrationReleased: false,
			registrationReleaseSettled: false,
			ptyExited: false,
			sigtermSent: false,
			sigkillSent: false,
			exitWaiters: [],
		};
		this.#records.set(id, record);
		this.#safeChanged(id);
		const launch = this.#launchInstance(record, { workspace: options.workspace, profile, savedSession });
		this.#inflightCreates.add(launch);
		try {
			await launch;
		} finally {
			this.#inflightCreates.delete(launch);
			// This exact row's launch has positively finished: no later spawn can
			// occur for it, whatever the launch settled as. The flag is per record,
			// so a sibling's pending or failing launch can never qualify this row.
			record.launchSettled = true;
		}
		return id;
	}

	/**
	 * Refuse a saved-session admission that a known-owned row already holds:
	 * an active reservation (pending or live creation) with the same session id
	 * or exact file, or a live row whose last-observed current native binding
	 * is the same conversation. Exited and removed rows never block reopening.
	 */
	#assertSavedSessionAvailable(admission: SavedSessionAdmission): void {
		for (const record of this.#records.values()) {
			const live = Boolean(record.pty && !record.ptyExited);
			if (!live && record.savedReservation === undefined) continue;
			if (record.savedReservation !== undefined
				&& (record.savedReservation.sessionId === admission.sessionId
					|| record.savedReservation.file === admission.file)) {
				throw new Error("session-host: the saved conversation is already open in this host");
			}
			if (live && record.knownNativeSessionId === admission.sessionId) {
				throw new Error("session-host: the saved conversation is already open in this host");
			}
		}
	}

	/**
	 * Known-owned live native session data for deliberate saved-conversation
	 * duplicate fencing (issue 323): the last-observed current conversation id
	 * of every live row plus admitted saved-session reservations, including
	 * pending creations. Data only — no process discovery, scan, daemon, or
	 * lock. Exited and removed rows contribute nothing.
	 */
	ownedLiveSessions(): readonly OwnedLiveSession[] {
		const sessions: OwnedLiveSession[] = [];
		for (const record of this.#records.values()) {
			const live = Boolean(record.pty && !record.ptyExited);
			if (!live && record.savedReservation === undefined) continue;
			const entry: OwnedLiveSession = {};
			if (record.savedReservation !== undefined) {
				entry.id = record.savedReservation.sessionId;
				entry.file = record.savedReservation.file;
			}
			if (live && record.knownNativeSessionId !== undefined) {
				entry.id = record.knownNativeSessionId;
			}
			sessions.push(entry);
		}
		return sessions;
	}

	/**
	 * Rename only the currently observed native conversation through its
	 * authenticated registration. The expected tuple is checked before and
	 * after the broker call; stale/released owners never receive an optimistic
	 * caption update.
	 */
	async rename(id: string, request: StatusRenameRequest): Promise<StatusRenameResult> {
		const record = this.#records.get(id);
		const requestId = randomUUID();
		const expectedSessionId = request?.expectedSessionId;
		const expectedSessionEpoch = request?.expectedSessionEpoch;
		const name = request?.name;
		const observed = (): { observedSessionId: string | null; observedSessionEpoch: number | null } => ({
			observedSessionId: record?.nativeSession?.sessionId ?? null,
			observedSessionEpoch: record?.nativeSession?.epoch ?? null,
		});
		const result = (status: StatusRenameResult["status"], resultId: string = requestId): StatusRenameResult => ({
			requestId: resultId,
			status,
			...(typeof expectedSessionId === "string" ? { expectedSessionId } : {}),
			...(Number.isSafeInteger(expectedSessionEpoch) ? { expectedSessionEpoch } : {}),
			...observed(),
		});
		if (!isValidNativeSessionId(expectedSessionId)
			|| !Number.isSafeInteger(expectedSessionEpoch) || expectedSessionEpoch <= 0) {
			return result("invalid-request");
		}
		if (!isValidRenameName(name)) return result("invalid-name");
		if (!record || this.#disposed || !record.registration || record.registrationReleased) {
			return result(record ? "disconnected" : "unavailable");
		}
		if (!record.nativeSession) return result("unavailable");
		if (record.nativeSession.sessionId !== expectedSessionId || record.nativeSession.epoch !== expectedSessionEpoch) {
			return result("stale-session");
		}
		const registration = record.registration;
		if (typeof registration.rename !== "function") return result("unavailable");
		let brokerResult: StatusRenameResult;
		try {
			brokerResult = await registration.rename({ expectedSessionId, expectedSessionEpoch, name });
		} catch {
			return result("disconnected");
		}
		if (this.#records.get(id) !== record || record.registration !== registration || record.registrationReleased) {
			return result("disconnected", brokerResult.requestId);
		}
		if (!record.nativeSession
			|| record.nativeSession.sessionId !== expectedSessionId
			|| record.nativeSession.epoch !== expectedSessionEpoch) {
			return result("stale-session", brokerResult.requestId);
		}
		const statuses: readonly StatusRenameResult["status"][] = [
			"renamed", "stale-session", "unavailable", "invalid-name", "setter-failed",
			"verification-failed", "busy", "timeout", "disconnected", "invalid-request",
		];
		if (!brokerResult || typeof brokerResult.requestId !== "string" || !statuses.includes(brokerResult.status)
			|| brokerResult.expectedSessionId !== expectedSessionId
			|| brokerResult.expectedSessionEpoch !== expectedSessionEpoch) {
			return result("verification-failed", typeof brokerResult?.requestId === "string" ? brokerResult.requestId : requestId);
		}
		return result(brokerResult.status, brokerResult.requestId);
	}

	/** Write input to the explicitly addressed known-alive child. Never a fallback. */
	write(id: string, data: string | Buffer): void {
		this.#assertUsable("write");
		if (typeof data !== "string" && !Buffer.isBuffer(data)) {
			throw new Error("session-host: instance input must be a string or Buffer");
		}
		const record = this.#records.get(id);
		if (!record) {
			throw new Error("session-host: unknown instance id; input is routed to explicit ids only");
		}
		const pty = record.pty;
		if (!pty || record.ptyExited || record.lifecycle !== "alive") {
			throw new Error(`session-host: instance ${id} is not accepting input (lifecycle ${record.lifecycle})`);
		}
		pty.write(data);
	}

	/**
	 * Update the geometry of every live instance: both instances the
	 * frontend shows and hidden ones (hiding or switching is a frontend
	 * concern; the manager never stops a child for selection or hiding).
	 */
	resize(cols: number, rows: number): void {
		this.#assertUsable("resize");
		validateDimension(cols, "cols");
		validateDimension(rows, "rows");
		this.#cols = cols;
		this.#rows = rows;
		for (const record of this.#records.values()) {
			if (!record.pty || record.ptyExited) {
				continue;
			}
			try {
				record.pty.resize(cols, rows);
			} catch {
				this.#failRunningInstance(record, "ptyResize");
				continue;
			}
			if (record.surface) {
				try {
					record.surface.resize(cols, rows);
				} catch {
					this.#failRunningInstance(record, "surfaceResize");
				}
			}
		}
	}

	/** True when the manager still owns at least one child handle not known exited. */
	hasLiveProcesses(): boolean {
		for (const record of this.#records.values()) {
			if (record.pty && !record.ptyExited) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Bounded graceful shutdown of every owned child: authenticated public
	 * native shutdown when available, POSIX SIGTERM fallback, and bounded
	 * forced escalation on the same owned handle only, honest
	 * forced/remaining tracking. No global process scans, no arbitrary group
	 * kills, no adopted-descendant cleanup: remaining handles keep their
	 * admission and are released only by their own confirmed exit event.
	 */
	async shutdown(options?: ShutdownOptions): Promise<ShutdownResult> {
		if (this.#disposed) {
			return {
				forcedIds: [...this.#records.values()]
					.filter((record) => record.pty && record.sigkillSent)
					.map((record) => record.id),
				remainingIds: [...this.#records.values()]
					.filter((record) => record.pty && !record.ptyExited)
					.map((record) => record.id),
			};
		}
		const graceMs = options?.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
		const killMs = options?.killMs ?? DEFAULT_SHUTDOWN_KILL_MS;
		validateShutdownMs(graceMs, "graceMs");
		validateShutdownMs(killMs, "killMs");
		this.#stopping = true;
		// Late async creates settle or abort here; none can spawn after stop.
		await Promise.allSettled([...this.#inflightCreates]);
		return this.#stopOwnedProcesses(graceMs, killMs);
	}

	/**
	 * Idempotent graceful cleanup then owned resource disposal: stops any
	 * owned child never signaled before (default windows). Exited rows release
	 * their status registrations and terminal surfaces; rows whose child never
	 * confirmed exit retain both, keep lifecycle 'alive', and hold their setup
	 * admission until their own exit event fires. Native/session files and
	 * unknown files are never touched by this module.
	 */
	async dispose(): Promise<void> {
		if (this.#disposed) {
			return;
		}
		if (this.#disposePromise) {
			await this.#disposePromise;
			return;
		}
		this.#disposePromise = this.#runDispose();
		await this.#disposePromise;
	}

	async #runDispose(): Promise<void> {
		this.#stopping = true;
		await Promise.allSettled([...this.#inflightCreates]);
		try {
			await this.#stopOwnedProcesses(DEFAULT_SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_KILL_MS);
		} catch {
			// Contained: disposal proceeds with owned resource cleanup below.
		}
		this.#disposed = true;
		for (const record of this.#records.values()) {
			record.busy = null;
			record.pendingInput = null;
			record.inputSurface = false;
			record.backgroundTasks = null;
			record.backgroundShells = null;
			record.activeTasks = null;
			record.activeShells = null;
			record.activity = [];
			this.#disposeDataListener(record);
			if (record.pty && !record.ptyExited) {
				// Preserve the authenticated owner and terminal surface until actual
				// PTY exit. The retained exit/error listeners complete this teardown.
				continue;
			}
			this.#releaseRegistration(record);
			try {
				record.surface?.dispose();
			} catch {
				// Each surface is independently owned; keep disposing siblings.
			}
			record.surface = undefined;
		}
		// Exit and read-error listeners of never-settled children stay attached:
		// they release registration, surface, and admission on a late exit and
		// keep the pinned native stream's unexpected errors contained.
	}

	#assertUsable(operation: string): void {
		if (this.#disposed) {
			throw new Error(`session-host: the instance manager is disposed; ${operation} is no longer available`);
		}
	}

	/**
	 * The whole launch is guarded at every async boundary; the spawn itself
	 * (factory call through handler wiring) is one synchronous stretch, so a
	 * concurrent shutdown either saw #stopping false and the child exists, or
	 * the launch aborts before any spawn. Every failure is contained on this
	 * row with truthful state and owned-resource cleanup, and create()
	 * resolves with the row id (an error row) instead of orphaning callers.
	 */
	async #launchInstance(
			record: ManagedInstance,
			options: { workspace: string; profile?: string; savedSession?: SavedSessionAdmission },
		): Promise<void> {
		try {
			// 1. Setup admission. Native mode shares the fixed Pi root; legacy
			// mode is available only through explicit test injection. No tokens
			// exist yet anywhere.
			const profile = this.#profilePreparer.prepare({
				workspace: options.workspace,
				profile: options.profile === "" ? undefined : options.profile,
			});
			record.profile = profile;
			record.agentDir = profile.agentDir;
			record.workspace = profile.workspace;
			this.#safeChanged(record.id);

			await yieldCheckpoint();
			if (this.#stopping) {
				throw new Error("shutting down; native launch preparation aborted before any token or child existed");
			}

			// 2. Native launch preparation (verbatim; the launch module owns
			// its helper responsibilities; skills publication happens here).
			// The branded saved-session receipt is revalidated by the launch
			// module against the accepted agent directory and live file identity
			// before spawn, then composed as the exact per-child --session pair.
			// This stretch through registration and spawn never yields, so a
			// file/header/root replacement landing at the checkpoint above is
			// caught by the revalidation instead of reaching the child.
			const descriptor: NativeLaunchDescriptor = prepareNativeLaunch({
				nativeSetup: this.#nativeSetup,
				packageRoot: this.#packageRoot,
				agentDir: profile.agentDir,
				workspace: profile.workspace,
				piExecutable: this.#piExecutable,
				args: this.#args,
				env: this.#env,
				...(options.savedSession !== undefined ? { savedSession: options.savedSession } : {}),
			});
			record.workspace = descriptor.cwd;

			// 3. Status registration immediately before the spawn; its JSON
			// bootstrap is injected only into a fresh env clone below, at the
			// actual PTY spawn — never during setup work above and
			// never into the caller's or user's environment.
			const registration: { current?: InstanceStatusRegistration } = {};
			const handle = this.#statusRegistrar.register(record.id, {
				onStatus: (update) => this.#onStatus(record, registration, update),
				onDisconnect: () => this.#onDisconnect(record, registration),
			});
			registration.current = handle;
			record.registration = handle;
			record.registrationReleased = false;

			// 4. Synchronous spawn stretch: nothing yields until handlers and
			// the terminal surface are attached, so ownership is recorded
			// before any child callback can fire.
			let pty: InstancePty | undefined;
			try {
				const spawnEnv = { ...descriptor.env };
				spawnEnv[SESSION_HOST_BOOTSTRAP_ENV] = JSON.stringify(handle.bootstrap);
				pty = this.#ptyFactory({
					file: descriptor.file,
					args: descriptor.args,
					env: spawnEnv,
					cwd: descriptor.cwd,
					cols: this.#cols,
					rows: this.#rows,
				});
				record.pty = pty;
				record.exitDisposable = pty.onExit((event) => this.#onPtyExit(record, event));
				if (record.ptyExited) {
					this.#disposeExitListener(record);
					if (this.#records.get(record.id) !== record) {
						// An exit observer may synchronously close the row while
						// onExit() is registering its listener. Do not allocate a
						// surface or any other resources for a detached record.
						return;
					}
				}
				record.surface = new TerminalSurface(this.#cols, this.#rows, {
					onReply: (data) => this.#onQueryReply(record, data),
					onChange: () => this.#safeChanged(record.id),
					onBackpressure: (paused) => this.#onBackpressure(record, paused),
					getSupportedKeyboardFlags: this.#getSupportedKeyboardFlags,
				});
				if (!record.ptyExited) {
					record.readErrorDisposable = subscribePtyReadErrors(pty, () => this.#onPtyReadError(record));
					if (record.ptyExited) {
						this.#disposeReadErrorListener(record);
					}
				}
				if (!record.ptyExited) {
					record.dataDisposable = pty.onData((data) => this.#onPtyData(record, data));
					if (record.ptyExited) {
						// An injected/fake event source may emit synchronously while
						// listener registration is returning; dispose the now-known
						// handle and never revive its row.
						this.#disposeDataListener(record);
					} else if (record.lifecycle === "starting") {
						record.lifecycle = "alive";
					}
				}
			} catch {
				if (pty) {
					// The child exists but could not be wired: keep ownership and
					// initiate a bounded graceful owned stop rather than leaving
					// an untracked running process behind an error row.
					record.error = publicInstanceError("ptySetup");
					record.lifecycle = "error";
					if (!record.exitDisposable && !record.ptyExited) {
						try {
							record.exitDisposable = pty.onExit((event) => this.#onPtyExit(record, event));
						} catch {
							// Without an exit event, ownership remains held fail-closed.
						}
					}
					if (record.ptyExited) {
						this.#disposeExitListener(record);
					}
					try {
						record.dataDisposable?.dispose();
					} catch {
						// Continue toward an owned stop even if listener cleanup fails.
					}
					record.dataDisposable = undefined;
					if (record.ptyExited) {
						this.#disposeReadErrorListener(record);
					}
					this.#safeChanged(record.id);
					if (record.ptyExited) {
						this.#releaseRegistration(record);
						this.#releaseProfile(record);
					} else {
						void this.#gracefulStop(record, DEFAULT_SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_KILL_MS).catch(() => {});
					}
					return;
				}
				// Failed spawn before any child exists: release everything,
				// including the saved-session reservation (no child ever existed).
				record.error = publicInstanceError("ptySetup");
				record.lifecycle = "error";
				this.#releaseRegistration(record);
				this.#releaseProfile(record);
				record.savedReservation = undefined;
				this.#safeChanged(record.id);
				return;
			}
			if (this.#records.get(record.id) === record) {
				this.#safeChanged(record.id);
			}
		} catch {
			// Pre-spawn failure or a stop-aborted launch: release everything
			// acquired so far; no child ever existed to wait for, so the
			// saved-session reservation (if any) is released with it.
			record.error = publicInstanceError("launchPreparation");
			record.lifecycle = "error";
			this.#releaseRegistration(record);
			this.#releaseProfile(record);
			record.savedReservation = undefined;
			this.#safeChanged(record.id);
		}
	}

	#onPtyData(record: ManagedInstance, data: string): void {
		if (this.#disposed) {
			return; // the parse pipeline is closed by design after dispose
		}
		if (this.#records.get(record.id) !== record || record.ptyExited) {
			return; // stale: unknown/disposed/already-exited child
		}
		const surface = record.surface;
		if (!surface) {
			return;
		}
		try {
			surface.write(data);
		} catch {
			// Parser/queue failure is fatal for this row only: contained,
			// truthful, and its owned child gets a graceful stop; siblings
			// are untouched and ownership is never silently lost.
			this.#failRunningInstance(record, "outputParsing");
		}
	}

	#onPtyReadError(record: ManagedInstance): void {
		if (this.#records.get(record.id) !== record || record.ptyExited) {
			return;
		}
		// Never expose the native error object: it may contain process, path,
		// environment, or other upstream details. The owned row gets one safe
		// operation-specific diagnostic and an owned graceful stop.
		this.#failRunningInstance(record, "ptyRead");
	}

	#onQueryReply(record: ManagedInstance, data: string): void {
		if (this.#records.get(record.id) !== record || this.#disposed) {
			return;
		}
		const pty = record.pty;
		if (!pty || record.ptyExited) {
			return;
		}
		try {
			pty.write(data);
		} catch {
			this.#failRunningInstance(record, "queryReply");
		}
	}

	#onBackpressure(record: ManagedInstance, paused: boolean): void {
		if (this.#disposed || this.#records.get(record.id) !== record || record.ptyExited) {
			return;
		}
		const pty = record.pty;
		if (!pty) {
			return;
		}
		try {
			if (paused) {
				pty.pause();
			} else {
				pty.resume();
			}
		} catch {
			// TerminalSurface has already committed its pause state. If native
			// flow control failed, fail this owner closed instead of leaving a
			// permanently paused child behind an apparently healthy row.
			this.#failRunningInstance(record, paused ? "ptyPause" : "ptyResume");
		}
	}

	#onPtyExit(record: ManagedInstance, event: { exitCode: number; signal?: number }): void {
		if (this.#records.get(record.id) !== record || record.ptyExited) {
			return; // stale or already-final exit
		}
		record.ptyExited = true;
		record.busy = null;
		record.pendingInput = null;
		record.inputSurface = false;
		record.backgroundTasks = null;
		record.backgroundShells = null;
		record.activeTasks = null;
		record.activeShells = null;
		record.activity = [];
		if (typeof event?.exitCode === "number" && Number.isFinite(event.exitCode)) {
			record.exitCode = event.exitCode;
		}
		if (record.lifecycle === "starting" || record.lifecycle === "alive") {
			record.lifecycle = "exited";
		}
		// A known exit is the only condition (besides a failed spawn before
		// any child exists) under which the admission — and the saved-session
		// reservation — is released; an exited row never blocks reopening.
		this.#releaseRegistration(record);
		this.#disposeDataListener(record);
		this.#disposeExitListener(record);
		this.#disposeReadErrorListener(record);
		this.#releaseProfile(record);
		record.savedReservation = undefined;
		this.#resolveExitWaiters(record);
		this.#safeChanged(record.id);
		// Flush the queued child bytes so the retained last frame is the
		// complete final one before the row freezes.
		const surface = record.surface;
		if (this.#disposed) {
			try {
				surface?.dispose();
			} catch {
				// A late exit after manager disposal still completes per-row cleanup.
			}
			record.surface = undefined;
			return;
		}
		void (async () => {
			try {
				await surface?.flush();
			} catch {
				// Contained: the freeze outcome does not depend on this flush.
			}
			if (this.#records.get(record.id) === record) {
				this.#safeChanged(record.id);
			}
		})();
	}

	#onStatus(
		record: ManagedInstance,
		registration: { current?: InstanceStatusRegistration },
		update: InstanceStatusUpdate,
	): void {
		if (!this.#currentRegistration(record, registration)) {
			return; // stale/released/disposed status event, never cross-row
		}
		record.busy = update && typeof update.busy === "boolean" ? update.busy : null;
		record.pendingInput = update && typeof update.pendingInput === "boolean" ? update.pendingInput : null;
		record.inputSurface = update?.inputSurface === true;
		record.backgroundTasks = normalizedOwnedCount(update?.backgroundTasks);
		record.backgroundShells = normalizedOwnedCount(update?.backgroundShells);
		record.activeTasks = normalizedOwnedCount(update?.activeTasks);
		record.activeShells = normalizedOwnedCount(update?.activeShells);
		record.activity = boundedActivity(update?.activity);
		if (Object.prototype.hasOwnProperty.call(update ?? {}, "nativeSession")) {
			const next = validatedNativeSession(update?.nativeSession);
			const previous = record.lastNativeSession ?? record.nativeSession;
			if (next === null) {
				record.nativeSession = null;
				record.label = "(session name unavailable)";
			} else if (next !== undefined) {
				if (previous && (next.epoch < previous.epoch
					|| (next.sessionId !== previous.sessionId && next.epoch <= previous.epoch))) {
					record.nativeSession = null;
					record.label = "(session name unavailable)";
				} else {
					// Never forget positive saved evidence for the SAME current binding.
					if (previous?.sessionId === next.sessionId && previous.persistence === "saved") next.persistence = "saved";
					record.nativeSession = next;
					record.lastNativeSession = { ...next };
					record.label = next.name;
					// Private duplicate-fencing binding: the CURRENT observed
					// conversation replaces any older one (native /new or
					// /resume) and is retained across later disconnects.
					record.knownNativeSessionId = next.sessionId;
					// A valid newer binding that supersedes the initial saved
					// conversation releases its reservation: this row no longer
					// represents that saved file, so the conversation can be
					// opened again while the new binding stays fenced. Pending
					// (unobserved) reservations are untouched.
					if (record.savedReservation !== undefined
						&& record.savedReservation.sessionId !== next.sessionId) {
						record.savedReservation = undefined;
					}
				}
			} else {
				record.nativeSession = null;
				record.label = "(session name unavailable)";
			}
		}
		this.#safeChanged(record.id);
	}

	#onDisconnect(record: ManagedInstance, registration: { current?: InstanceStatusRegistration }): void {
		if (!this.#currentRegistration(record, registration)) {
			return; // stale/released/disposed disconnect event
		}
		// Truthful process telemetry: the reporter is gone, the child may very
		// well still run. Never an exit, never an inferred "Idle" state; busy
		// and pending input collapse to null until a fresh reporter reports.
		record.busy = null;
		record.pendingInput = null;
		record.inputSurface = false;
		record.backgroundTasks = null;
		record.backgroundShells = null;
		record.activeTasks = null;
		record.activeShells = null;
		record.activity = [];
		record.nativeSession = null;
		record.label = "(session name unavailable)";
		this.#safeChanged(record.id);
	}

	/** Guard: the record is live and the event belongs to its active registration. */
	#currentRegistration(record: ManagedInstance, registration: { current?: InstanceStatusRegistration }): boolean {
		return this.#records.get(record.id) === record
			&& !this.#disposed
			&& record.registration !== undefined
			&& registration.current === record.registration
			&& !record.registrationReleased;
	}

	#failRunningInstance(record: ManagedInstance, errorCode: InstanceErrorCode): void {
		if (this.#records.get(record.id) !== record) {
			return;
		}
		if (record.ptyExited) {
			// Already-final exit: keep the truthful exited row.
			return;
		}
		record.error = publicInstanceError(errorCode);
		record.lifecycle = "error";
		if (record.pty && !this.#stopping) {
			// A fatal display error while the PTY is alive must not leave an
			// untracked running process behind an error row: initiate a
			// bounded, owned graceful stop.
			void this.#gracefulStop(record, DEFAULT_SHUTDOWN_GRACE_MS, DEFAULT_SHUTDOWN_KILL_MS).catch(() => {});
		}
		this.#safeChanged(record.id);
	}

	#releaseRegistration(record: ManagedInstance): void {
		if (record.registrationReleased) {
			return;
		}
		// Mark released before calling external code: release may synchronously
		// report a disconnect, which must already be stale at this point.
		record.registrationReleased = true;
		try {
			record.registration?.release();
		} catch {
			// The attempt is recorded but not confirmed; no-child removal stays
			// fail closed and never retries the external release.
			return;
		}
		// Positively settled: either there was no registration owned yet, or the
		// external release returned. Only this authorizes no-child removal.
		record.registrationReleaseSettled = true;
	}

	#disposeDataListener(record: ManagedInstance): void {
		try {
			record.dataDisposable?.dispose();
		} catch {
			// Listener disposal is best-effort during per-instance cleanup.
		}
		record.dataDisposable = undefined;
	}

	#disposeExitListener(record: ManagedInstance): void {
		try {
			record.exitDisposable?.dispose();
		} catch {
			// Listener disposal is best-effort once the child is known exited.
		}
		record.exitDisposable = undefined;
	}

	#disposeReadErrorListener(record: ManagedInstance): void {
		try {
			record.readErrorDisposable?.dispose();
		} catch {
			// The owned child exit remains the source of truth if disposal fails.
		}
		record.readErrorDisposable = undefined;
	}

	#releaseProfile(record: ManagedInstance): void {
		if (record.profileReleased) {
			return;
		}
		record.profileReleased = true;
		// A throwing admission release keeps the confirmed flag false (the
		// caller's existing propagation semantics are preserved); a later
		// idempotent call cannot silently claim success for it.
		record.profile?.release();
		record.profileReleaseSettled = true;
	}

	#resolveExitWaiters(record: ManagedInstance): void {
		const waiters = record.exitWaiters.splice(0);
		for (const waiter of waiters) {
			waiter();
		}
	}

	#waitForExit(record: ManagedInstance, ms: number): Promise<boolean> {
		if (record.ptyExited) {
			return Promise.resolve(true);
		}
		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				const index = record.exitWaiters.indexOf(waiter);
				if (index >= 0) {
					record.exitWaiters.splice(index, 1);
				}
				resolve(false);
			}, ms);
			const waiter = () => {
				clearTimeout(timer);
				resolve(true);
			};
			record.exitWaiters.push(waiter);
		});
	}

	/**
	 * Owned graceful stop of one child: ask the active authenticated public
	 * status registration to request native shutdown, bounded by the same grace
	 * deadline as the owned PTY exit wait. On POSIX, unavailable or failed
	 * control falls back to SIGTERM; Windows never treats a PTY signal as
	 * graceful and forces only through the owned handle's no-argument kill().
	 * Forced escalation remains bounded and owned-handle-only.
	 * Releases happen only in the exit handler (confirmed exit) — this routine
	 * never frees an admission for a child that never settled.
	 */
	#gracefulStop(record: ManagedInstance, graceMs: number, killMs: number, alreadyRequested = false): Promise<boolean> {
		const pty = record.pty;
		if (!pty || record.ptyExited) {
			return Promise.resolve(true);
		}
		if (record.stopPromise) {
			return record.stopPromise;
		}
		const stopPromise = this.#runGracefulStop(record, pty, graceMs, killMs, alreadyRequested);
		record.stopPromise = stopPromise;
		return stopPromise;
	}

	async #runGracefulStop(record: ManagedInstance, pty: InstancePty, graceMs: number, killMs: number, alreadyRequested = false): Promise<boolean> {
		// Register the actual-exit waiter before making any public request: a
		// synchronous PTY exit inside shutdown() must win over its acknowledgement.
		const graceExit = this.#waitForExit(record, graceMs);
		const registration = record.registration;
		let requestShutdown: InstanceStatusRegistration["shutdown"] = undefined;
		try {
			if (registration && !record.registrationReleased) {
				requestShutdown = registration.shutdown;
			}
		} catch {
			// A broken optional adapter is equivalent to unavailable control.
		}

		let requested = alreadyRequested;
		if (!alreadyRequested && registration && requestShutdown) {
			let requestTimer: NodeJS.Timeout | undefined;
			const requestTimeout = this.#shutdownPlatform === "win32" ? undefined : new Promise<{ kind: "request-timeout" }>((resolve) => {
				// Reserve half of the single grace window for POSIX SIGTERM to
				// produce an exit. A hung public request must not postpone its
				// fallback until immediately before forced SIGKILL.
				requestTimer = setTimeout(() => resolve({ kind: "request-timeout" }), Math.floor(graceMs / 2));
			});
			let request: Promise<boolean>;
			try {
				// Attach both fulfillment and rejection handlers immediately. A
				// hung or late public response can never outlive the grace wait as
				// an unhandled rejection or change owned-process truth.
				request = Promise.resolve(requestShutdown.call(registration)).then(
					(result) => validShutdownRequest(result),
					() => false,
				);
			} catch {
				request = Promise.resolve(false);
			}
			const first = await Promise.race([
				request.then((accepted) => ({ kind: "request" as const, accepted })),
				graceExit.then((exited) => ({ kind: "exit" as const, exited })),
				...(requestTimeout ? [requestTimeout] : []),
			]);
			if (requestTimer) clearTimeout(requestTimer);
			if (first.kind === "exit" && first.exited) {
				return true;
			}
			if (first.kind === "request") {
				requested = first.accepted;
			}
		}
		if (record.ptyExited) {
			return true;
		}

		// `requested` acknowledges only the public native request. It never
		// substitutes for the owned PTY's actual exit event.
		if (!requested && this.#shutdownPlatform !== "win32") {
			record.sigtermSent = true;
			try {
				pty.kill("SIGTERM");
			} catch {
				// Contained: the escalation still runs against the owned handle.
			}
			if (record.ptyExited) {
				return true;
			}
		}

		// This is the remainder of the original grace window, not a second
		// post-request grace period. On Windows-like injected policy, no PTY
		// signal is sent until the forced owned-handle escalation below.
		const settled = await graceExit;
		if (settled || record.ptyExited) {
			return true;
		}
		// Record the force attempt before invoking a native API that may throw or
		// partially complete; it is never evidence that the PTY actually exited.
		record.sigkillSent = true;
		try {
			// Public node-pty's Windows signal argument is unsupported; its
			// no-argument kill is the forced owned-handle operation there.
			if (this.#shutdownPlatform === "win32") {
				pty.kill();
			} else {
				pty.kill("SIGKILL");
			}
		} catch {
			// Contained: truthfully reported below if the child never settles.
		}
		return this.#waitForExit(record, killMs);
	}

	/** Bounded stopping pass over owned children, sharing any existing stop ladder. */
	async #stopOwnedProcesses(graceMs: number, killMs: number): Promise<ShutdownResult> {
		const targets = [...this.#records.values()].filter((record) => record.pty && !record.ptyExited);
		const outcomes = await Promise.all(targets.map(async (record) => {
			await this.#gracefulStop(record, graceMs, killMs);
			return { id: record.id, forced: record.sigkillSent };
		}));
		// Escalation is historical, but remaining is current truth after every
		// targeted ladder has completed: a late confirmed exit is not remaining.
		return {
			forcedIds: outcomes.filter((outcome) => outcome.forced).map((outcome) => outcome.id),
			remainingIds: targets.filter((record) => record.pty && !record.ptyExited).map((record) => record.id),
		};
	}

	/** Contains host callback failures; lifecycle callbacks of the manager never break rows. */
	#safeChanged(id: string | undefined): void {
		if (this.#disposed || !this.#onChange) {
			return;
		}
		try {
			if (id !== undefined) {
				this.#onChange(id);
			}
		} catch {
			// Contained: frontend change hooks are never load-bearing here.
		}
	}
}

/** One macrotask yield so concurrent create/shutdown interleavings are real. */
function yieldCheckpoint(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}
