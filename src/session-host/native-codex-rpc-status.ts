/**
 * Owned-endpoint native Codex status observer (the native status slice's RPC lane).
 *
 * This component turns ONE host-owned native Codex app-server endpoint and ONE
 * positively bound ROOT thread into the five native sidebar categories as real
 * values — agent, input, background tasks, background shells, activity — and
 * publishes them through the shared {@link NativeStatusObservation} contract. It
 * is the read-only RPC counterpart to the hook/rollout lane: the hook lane owns
 * the root turn's durable foreground truth, and this lane owns the provider's
 * live thread status, the owned sub-agent census, and the background-terminal
 * census. The parent row merges them.
 *
 * ## Preconditions the CALLER owns (this module proves none of them)
 *
 * - `endpoint` is a private endpoint the host created for THIS row (its own
 *   `codex app-server --listen unix://<path>`, or a loopback `ws` endpoint it
 *   owns with its own credential). Filesystem ownership is the authentication;
 *   nothing here reads, writes, or migrates provider auth, config, or trust.
 * - `rootThreadId` is the row's own root thread identity, corroborated by its
 *   native-session or owned-launch evidence. Rollout/session metadata can
 *   corroborate a persisted root; an unqualified backend listing is never
 *   ownership evidence.
 * - `generation` changes whenever that endpoint lease or root binding changes.
 *   It is the fence that makes an in-flight read from a retired binding unable
 *   to publish.
 * - `expectedCodexHome` (when supplied) is the `CODEX_HOME` the host launched
 *   that exact backend with; a mismatch is a fail-closed `binding` failure.
 *
 * The observer never adopts a thread, never subscribes (`thread/resume` is not
 * something it can send), and never answers a provider request. See
 * `native-codex-rpc.ts` for why a reply — including an automatic error — would
 * resolve the operator's live approval prompt, and how the transport makes that
 * unrepresentable rather than merely discouraged.
 *
 * ## What each published value is
 *
 * - **agent / input** — the bound root's live `ThreadStatus`, from the global
 *   `thread/status/changed` broadcast plus a `thread/read` snapshot pull.
 *   `idle` is a positive Ready, `active` with no flags is a positive Working,
 *   and `activeFlags` is the positive `pending` witness (`[]` is a positively
 *   reported none). A root whose flags name a real operator prompt
 *   (`waitingOnApproval` / `waitingOnUserInput`) is canonically BLOCKED: it
 *   publishes `pendingInput: true` with `busy: false`, the same shape Pi uses
 *   for its own blocking question, while `rootTurnActive` keeps the provider's
 *   still-open turn as the preserved underlying foreground so the row resumes to
 *   running instead of being mistaken for Ready. `systemError` and `notLoaded`
 *   are neither Ready nor zero: they publish unknown plus a closed diagnostic.
 *   Background counts never hold the foreground running, and a descendant's own
 *   pending prompt never changes the root's agent/input axes.
 * - **tasks** — the count of this row's OWNED, currently ACTIVE native
 *   sub-agents. The census is `thread/list` filtered by `ancestorThreadId` (the
 *   provider's own descendant filter, which is also the privacy/ownership
 *   fence), merged by thread id with `thread/loaded/list` + `thread/read` for
 *   live and ephemeral children, followed across every page, and counted only on
 *   `status.type === "active"`. It is never a loaded-list length: a
 *   completed-but-still-loaded child, an unrelated same-cwd root, a fork, and a
 *   persisted-not-loaded child are all excluded. There is deliberately no cwd
 *   filter, because an owned child legitimately runs in its own worktree.
 * - **shells** — the complete `thread/backgroundTerminals/list` count for the
 *   bound root and its known descendants, deduplicated by process identity
 *   across pages and threads. An authoritative empty page is a real `0`.
 * - **activity** — `Ready` from `idle` and `Working` from `active`. The
 *   tool-TYPE sub-detail comes from the parent's existing hook/rollout feed
 *   through {@link NativeCodexRpcStatusObserver.observeToolActivity}, which is
 *   the documented merge seam: this lane never pretends to see item events it
 *   cannot receive without subscribing. `Working` is a real activity value, not
 *   a placeholder for an unknown.
 *
 * ## Freshness
 *
 * Refreshes are event-driven (root status edges, known-descendant status edges,
 * thread-set membership edges within the bound lineage, reconnect) plus a
 * provider-scoped refresh that re-arms only while work is actually known to be
 * in flight, so a background terminal or child finishing while the root status
 * stays unchanged still reaches a live `0` without a global poller and without a
 * new user-facing setting. One census runs at a time; requests that arrive
 * during one coalesce into at most one trailing refresh, so a broadcast burst
 * cannot become a poll storm. A refresh never blanks a known value: values are
 * only withdrawn by a real failure, and a failed census withdraws its own axis
 * to unknown rather than inventing a zero. Timers here bound scheduling; none of
 * them ever manufactures an idle claim.
 */

import {
  NativeCodexRpcTransport,
  NATIVE_CODEX_RPC_MAX_PAGE_LIMIT,
  type NativeCodexRpcEndpoint,
  type NativeCodexRpcFailureCode,
  type NativeCodexRpcNotification,
  type NativeCodexRpcTransportOptions,
  type NativeCodexServerRequestSignal,
  type NativeCodexThreadRow,
  type NativeCodexThreadStatus,
} from "./native-codex-rpc";
import { MAX_ACTIVITY_LINES, sanitizeActivityLine } from "./protocol";
import type { NativeStatusObservation, NativeStatusSupportMap } from "./native-status";

/* ------------------------------------------------------------------ bounds */

/**
 * All five native status categories are supported. A failed provider read
 * publishes `null` for the affected axis, never a fabricated zero or idle.
 */
export const NATIVE_CODEX_RPC_STATUS_SUPPORT: NativeStatusSupportMap = Object.freeze({
  agent: "supported",
  input: "supported",
  tasks: "supported",
  shells: "supported",
  activity: "supported",
});

/** Activity line for a positively observed idle root. */
export const NATIVE_CODEX_RPC_ACTIVITY_READY = "Ready";
/** Activity line for a positively observed active root with no tool type yet. */
export const NATIVE_CODEX_RPC_ACTIVITY_WORKING = "Working";

/** A caller-supplied tool type is a short label, never a command or argument. */
export const NATIVE_CODEX_RPC_MAX_TOOL_LABEL_CHARS = 48;

/** Scheduling and walk bounds. All of them are ceilings, never idle heuristics. */
export interface NativeCodexRpcStatusLimits {
  /** Requested page size for every census listing (capped by the transport). */
  readonly censusPageLimit: number;
  /** Maximum pages followed per listing source per census. */
  readonly maxCensusPages: number;
  /** Maximum `thread/read` calls one census may make for bare or unresolved ids. */
  readonly maxDescendantReads: number;
  /** Maximum parent hops accepted when proving a row descends from the bound root. */
  readonly maxDescendantDepth: number;
  /** Maximum descendant ids tracked at once; beyond it the census degrades. */
  readonly maxKnownDescendants: number;
  /** Maximum ids remembered as proven-not-descendant, so they stop costing reads. */
  readonly maxUnrelatedIds: number;
  /** Maximum threads whose background terminals one census may list. */
  readonly maxShellCensusThreads: number;
  /** Minimum spacing between census starts, in timer units. */
  readonly refreshCooldownMs: number;
  /** Re-arm interval while work is known to be in flight. */
  readonly activeRefreshIntervalMs: number;
  /** First reconnect delay. */
  readonly reconnectBackoffMs: number;
  /** Largest reconnect delay the backoff doubles to. */
  readonly reconnectMaxBackoffMs: number;
  /** Per-request timeout handed to the transport. */
  readonly requestTimeoutMs: number;
}

export const NATIVE_CODEX_RPC_STATUS_DEFAULT_LIMITS: NativeCodexRpcStatusLimits = Object.freeze({
  censusPageLimit: 50,
  maxCensusPages: 8,
  maxDescendantReads: 48,
  maxDescendantDepth: 4,
  maxKnownDescendants: 64,
  maxUnrelatedIds: 256,
  maxShellCensusThreads: 16,
  refreshCooldownMs: 250,
  activeRefreshIntervalMs: 2_000,
  reconnectBackoffMs: 250,
  reconnectMaxBackoffMs: 5_000,
  requestTimeoutMs: 5_000,
});

/**
 * Closed diagnostic vocabulary. Every entry is a fact about the observation, and
 * none of them can carry provider content.
 */
export type NativeCodexRpcStatusDiagnosticCode =
  /** The connection dropped; every axis was withdrawn and a reconnect is scheduled. */
  | "connection-lost"
  /** The `initialize` result contradicted the caller's owned-endpoint claim. */
  | "binding"
  /** The bound root could not be read. */
  | "root-read-failed"
  /** The bound root reported `systemError`: neither Ready nor zero. */
  | "root-system-error"
  /** The bound root reported `notLoaded`: neither Ready nor zero. */
  | "root-not-loaded"
  /** The sub-agent census could not be completed; tasks published unknown. */
  | "tasks-incomplete"
  /** The sub-agent census hit a walk bound before completing. */
  | "tasks-budget"
  /** The sub-agent census found a parent cycle. */
  | "tasks-cycle"
  /** The background-terminal census could not be completed; shells published unknown. */
  | "shells-incomplete"
  /** The background-terminal census hit its thread bound before completing. */
  | "shells-budget"
  /** A transport failure code, passed through unchanged. */
  | NativeCodexRpcFailureCode;

/** Injectable timer seam so refresh behavior is testable without wall-clock waits. */
export interface NativeCodexRpcStatusScheduler {
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

const REAL_SCHEDULER: NativeCodexRpcStatusScheduler = Object.freeze({
  setTimer: (callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs),
  clearTimer: (handle: unknown): void => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

/* ------------------------------------------------------------ pure helpers */

/** True for a status the census counts as one active owned sub-agent. */
export function isActiveNativeCodexDescendantStatus(status: NativeCodexThreadStatus): boolean {
  // A child waiting on approval or on user input is still running, so any
  // `active` status counts; `idle` (finished but still loaded), `notLoaded`, and
  // `systemError` do not.
  return status.kind === "active";
}

/**
 * The bound root's projection into the row model's agent/input axes.
 *
 * A root whose native `activeFlags` name a real operator prompt is GENUINELY
 * BLOCKED, and the canonical rendering of that state in this repository is
 * `agent waiting | input pending` — the same shape Pi uses for its own blocking
 * question. Reporting `busy: true` there would render `agent running` while the
 * row is actually waiting on a person, so the projection normalizes it:
 *
 * - `pendingInput: true`, `busy: false` while blocked;
 * - `rootTurnActive: true` throughout, because the provider's turn really is
 *   still open underneath. That witness is what lets the row resume to
 *   `busy: true` when the prompt closes, and it is why the waiting `busy: false`
 *   is never a fake Ready, a fake turn completion, or a zeroed count;
 * - `active` with no flags stays `busy: true` — an unblocked active root is
 *   running, and `activeFlags: []` is a positively reported none;
 * - `idle` is a positive rest; `systemError` and `notLoaded` are neither Ready
 *   nor zero and stay unknown.
 *
 * Nothing here replies to the native prompt, and nothing here is a new UI
 * concept: these are the existing axes with their existing shared meanings.
 */
export interface NativeCodexRootProjection {
  readonly busy: boolean | null;
  readonly pendingInput: boolean | null;
  /** The provider's own turn-active witness, independent of the waiting normalization. */
  readonly rootTurnActive: boolean | null;
  /** True only for a positively observed operator block (`waitingOnApproval`/`waitingOnUserInput`). */
  readonly blocked: boolean;
}

/** Projects one observed root status into the canonical agent/input axes. */
export function projectNativeCodexRootStatus(
  status: NativeCodexThreadStatus | null,
): NativeCodexRootProjection {
  if (status === null) {
    return { busy: null, pendingInput: null, rootTurnActive: null, blocked: false };
  }
  switch (status.kind) {
    case "active": {
      const blocked = status.activeFlags.length > 0;
      return {
        busy: blocked ? false : true,
        pendingInput: blocked ? true : false,
        rootTurnActive: true,
        blocked,
      };
    }
    case "idle":
      return { busy: false, pendingInput: false, rootTurnActive: false, blocked: false };
    default:
      // `systemError` and `notLoaded` are real provider states that are neither
      // Ready nor zero, so both axes stay unknown and the row is told why.
      return { busy: null, pendingInput: null, rootTurnActive: null, blocked: false };
  }
}

/** Counts the active rows in one already-deduplicated descendant set. */
export function countActiveNativeCodexDescendants(
  rows: Iterable<NativeCodexThreadRow>,
): number {
  let count = 0;
  for (const row of rows) {
    if (isActiveNativeCodexDescendantStatus(row.status)) count += 1;
  }
  return count;
}

/* ----------------------------------------------------------------- options */

export interface NativeCodexRpcStatusBinding {
  readonly rootThreadId?: string;
  readonly generation?: string;
  readonly endpoint?: NativeCodexRpcEndpoint;
  readonly expectedCodexHome?: string;
}

export interface NativeCodexRpcStatusObserverOptions {
  /** Private, host-created endpoint. Proven by the caller, validated for shape here. */
  readonly endpoint: NativeCodexRpcEndpoint;
  /** The row's own bound root thread id. Proven by the caller. */
  readonly rootThreadId: string;
  /** Caller binding generation; changes retire every earlier observation. */
  readonly generation: string;
  /** Optional `CODEX_HOME` equality corroboration. Never retained. */
  readonly expectedCodexHome?: string;
  /** One complete, de-duplicated snapshot. */
  readonly onObservation: (observation: NativeStatusObservation) => void;
  /** Closed diagnostic codes only. */
  readonly onDiagnostic?: (code: NativeCodexRpcStatusDiagnosticCode) => void;
  readonly scheduler?: NativeCodexRpcStatusScheduler;
  readonly limits?: Partial<NativeCodexRpcStatusLimits>;
}

type Ancestry = "descendant" | "unrelated";

interface CensusWalk {
  /** Every collected row, keyed by thread id, from either enumeration source. */
  readonly rows: Map<string, NativeCodexThreadRow>;
  /**
   * Which collected rows came from the provider's own ancestor-filtered query.
   * Those rows carry server-side ownership evidence, so a chain that
   * contradicts them is a source failure to degrade on — while a bare loaded id
   * that fails the chain is simply not this row's child.
   */
  readonly ancestorIds: Set<string>;
  /** Set when a bound was hit or a read failed: the census may not publish a number. */
  failure: NativeCodexRpcStatusDiagnosticCode | null;
  reads: number;
}

/**
 * Read-only observer of one owned native Codex endpoint.
 *
 * Public surface is exactly: `start`, `refresh`, `rebind`, `observeToolActivity`,
 * `dispose`, and read-only getters. There is no method that sends a provider
 * request the census does not need, no control call, and no raw frame path.
 */
export class NativeCodexRpcStatusObserver {
  readonly #limits: NativeCodexRpcStatusLimits;
  readonly #scheduler: NativeCodexRpcStatusScheduler;
  readonly #onObservation: (observation: NativeStatusObservation) => void;
  readonly #onDiagnostic: ((code: NativeCodexRpcStatusDiagnosticCode) => void) | undefined;

  #endpoint: NativeCodexRpcEndpoint;
  #rootThreadId: string;
  #generation: string;
  #expectedCodexHome: string | undefined;

  #transport: NativeCodexRpcTransport | null = null;
  #connectionSeq = 0;
  #started = false;
  #disposed = false;
  #connected = false;
  #connecting: Promise<void> | null = null;

  /** Root status as last positively observed, or null when unknown. */
  #rootStatus: NativeCodexThreadStatus | null = null;
  #tasks: number | null = null;
  #shells: number | null = null;
  /**
   * Whether the provider has positively reported work (an active root, a live
   * owned sub-agent, or a live background terminal) that no COMPLETE read has
   * since resolved.
   *
   * This witness is deliberately separate from the published values. A withdrawn
   * axis is missing information, not evidence that the work finished, and this
   * observer receives no terminal-completion subscription: if the re-arm
   * condition were derived only from the current display values, one failed
   * shell read on an otherwise idle row would stop the provider-scoped refresh
   * and leave `activeShells` unknown forever.
   */
  #workWitness = false;
  /** Tool type from the caller's hook/rollout lane; only while the root is active. */
  #toolLabel: string | null = null;

  /** Known descendants of the bound root and their last known status. */
  readonly #descendants = new Map<string, NativeCodexThreadStatus>();
  /** Bounded ancestry memory so unrelated loaded ids stop costing reads. */
  readonly #ancestry = new Map<string, Ancestry>();

  #inFlight = false;
  #queued = false;
  /** A forced request (connect or rebind) never waits behind the cooldown. */
  #forceQueued = false;
  #suppressPublish = false;
  #currentCensus: Promise<void> | null = null;
  #cooldownHandle: unknown = null;
  #activeHandle: unknown = null;
  #reconnectHandle: unknown = null;
  #reconnectDelayMs: number;

  #last: NativeStatusObservation | null = null;
  #serverRequestCount = 0;

  constructor(options: NativeCodexRpcStatusObserverOptions) {
    const rootThreadId = boundedText(options.rootThreadId, 256);
    const generation = boundedText(options.generation, 256);
    if (rootThreadId === null || generation === null) {
      throw new RangeError("native codex rpc status requires a bounded root thread id and generation");
    }
    this.#rootThreadId = rootThreadId;
    this.#generation = generation;
    this.#endpoint = options.endpoint;
    this.#expectedCodexHome = options.expectedCodexHome;
    this.#limits = normalizeLimits(options.limits);
    this.#scheduler = options.scheduler ?? REAL_SCHEDULER;
    this.#onObservation = options.onObservation;
    this.#onDiagnostic = options.onDiagnostic;
    this.#reconnectDelayMs = this.#limits.reconnectBackoffMs;
  }

  /* ------------------------------------------------------------- read-only */

  get connected(): boolean {
    return this.#connected;
  }

  get generation(): string {
    return this.#generation;
  }

  get rootThreadId(): string {
    return this.#rootThreadId;
  }

  /** True while one census is running. */
  get censusInFlight(): boolean {
    return this.#inFlight;
  }

  /** Tracked descendant ids; the scope the next refresh is keyed to. */
  get knownDescendantCount(): number {
    return this.#descendants.size;
  }

  /**
   * The provider's own turn-active witness for the bound root: true while a
   * native turn is open, including the whole time it is blocked on an operator
   * answer. The canonical `busy: false` of a blocked root never erases this, so
   * the row can resume to running instead of being mistaken for Ready.
   */
  get rootTurnActive(): boolean | null {
    return projectNativeCodexRootStatus(this.#rootStatus).rootTurnActive;
  }

  /** True while the bound root is positively blocked on an operator prompt. */
  get rootBlocked(): boolean {
    return projectNativeCodexRootStatus(this.#rootStatus).blocked;
  }

  /** Inbound server requests seen and dropped without a reply. */
  get serverRequestCount(): number {
    return this.#serverRequestCount;
  }

  /** The current snapshot the observer would publish. */
  get snapshot(): NativeStatusObservation {
    return this.#buildObservation();
  }

  /* ------------------------------------------------------------- lifecycle */

  /**
   * Connects and pulls once. Resolves once the first census has completed (it
   * may publish unknowns); a connection failure rejects with the closed code and
   * leaves the scheduled reconnect to recover.
   */
  async start(): Promise<void> {
    if (this.#disposed) throw new RangeError("native codex rpc status observer is disposed");
    if (this.#started) throw new RangeError("native codex rpc status observer is already started");
    this.#started = true;
    await this.#connect();
    // Resolve only after the first census has run, so a consumer never gets a
    // half-pulled card (an authoritative-looking zero that was never read).
    await this.#awaitCensus();
  }

  /**
   * Requests one coalesced provider-scoped refresh. Cheap and idempotent: at
   * most one census runs at a time and requests during one collapse into at most
   * one trailing census.
   */
  refresh(): void {
    this.#requestRefresh();
  }

  /**
   * Adopts a new root binding or endpoint lease. Everything the previous binding
   * proved is retired first (the row is withdrawn to unknown, never carried over),
   * then the new endpoint is connected and fully re-pulled.
   */
  async rebind(binding: NativeCodexRpcStatusBinding): Promise<void> {
    if (this.#disposed) throw new RangeError("native codex rpc status observer is disposed");
    const rootThreadId = binding.rootThreadId === undefined
      ? this.#rootThreadId
      : boundedText(binding.rootThreadId, 256);
    const generation = binding.generation === undefined
      ? this.#generation
      : boundedText(binding.generation, 256);
    if (rootThreadId === null || generation === null) {
      throw new RangeError("native codex rpc status rebind requires a bounded root thread id and generation");
    }
    const endpointChanged = binding.endpoint !== undefined && !sameEndpoint(this.#endpoint, binding.endpoint);
    this.#rootThreadId = rootThreadId;
    this.#generation = generation;
    if (binding.endpoint !== undefined) this.#endpoint = binding.endpoint;
    if (binding.expectedCodexHome !== undefined) this.#expectedCodexHome = binding.expectedCodexHome;

    this.#retireObservation();
    if (!endpointChanged && this.#connected) {
      // Same endpoint, new binding: the walk scope changed, so re-pull it and
      // resolve only once that pull has landed.
      this.#requestRefresh(true);
      await this.#awaitCensus();
      return;
    }
    await this.#reconnect();
    await this.#awaitCensus();
  }

  /** Resolves once no census is running and no forced census is still owed. */
  async #awaitCensus(): Promise<void> {
    for (let guard = 0; guard < 4; guard += 1) {
      const census = this.#currentCensus;
      if (census !== null) {
        await census;
        continue;
      }
      if (this.#forceQueued) {
        // The previous walk finished and owed an immediate census; make sure it
        // is the one this caller resolves on, rather than returning early.
        if (this.#cooldownHandle !== null) this.#clearTimer("#cooldownHandle");
        this.#startCensus();
        continue;
      }
      return;
    }
  }

  /**
   * The documented merge seam for the tool-TYPE sub-detail: the caller's hook or
   * rollout feed hands over one bounded tool label. The RPC lane keeps authority
   * over Ready vs Working; the caller keeps authority over the tool type, and is
   * responsible for clearing it. A label is ignored (and dropped) whenever the
   * root is not positively active, so it can never imply work that the provider
   * says is finished.
   */
  observeToolActivity(toolLabel: string | null): void {
    if (this.#disposed) return;
    const label = toolLabel === null ? null : boundedText(toolLabel, NATIVE_CODEX_RPC_MAX_TOOL_LABEL_CHARS);
    const sanitized = label === null || label.length === 0 ? null : sanitizeActivityLine(label);
    const next = sanitized !== null && sanitized.length > 0 ? sanitized : null;
    if (this.#toolLabel === next) return;
    this.#toolLabel = next;
    this.#publish();
  }

  /**
   * Ends the observation. Idempotent, timer-clean, and after it returns no
   * callback can fire again and no late census result can be published.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#connected = false;
    this.#clearTimer("#cooldownHandle");
    this.#clearTimer("#activeHandle");
    this.#clearTimer("#reconnectHandle");
    const transport = this.#transport;
    this.#transport = null;
    this.#connectionSeq += 1;
    this.#inFlight = false;
    this.#queued = false;
    this.#forceQueued = false;
    this.#currentCensus = null;
    this.#rootStatus = null;
    this.#tasks = null;
    this.#shells = null;
    this.#workWitness = false;
    this.#toolLabel = null;
    this.#descendants.clear();
    this.#ancestry.clear();
    transport?.close();
  }

  /* ------------------------------------------------------------ connection */

  #connect(): Promise<void> {
    if (this.#disposed) return Promise.reject(new RangeError("disposed"));
    // Any already-scheduled backoff attempt is superseded the moment a connection
    // is being made — otherwise a rebind that recovered first would let the stale
    // timer dial again, replace `#transport`, and abandon a live WebSocket that
    // `dispose()` can no longer reach.
    this.#clearTimer("#reconnectHandle");
    if (this.#connected) return Promise.resolve();
    if (this.#connecting !== null) return this.#connecting;
    const seq = ++this.#connectionSeq;
    const transport = this.#createTransport(seq);
    this.#transport = transport;
    const attempt = transport.connect()
      .then(() => {
        if (this.#disposed || seq !== this.#connectionSeq) return;
        this.#connected = true;
        this.#reconnectDelayMs = this.#limits.reconnectBackoffMs;
        // A fresh connection always re-pulls: broadcasts missed while
        // disconnected are gone, so nothing cached may be republished as fresh.
        this.#requestRefresh(true);
      })
      .catch((error: unknown) => {
        // A failed connect withdraws the card and keeps recovering on the same
        // bounded backoff, so a backend that is slow to bind is not a permanent
        // unknown. The rejection still reaches whoever called start()/rebind().
        if (!this.#disposed && seq === this.#connectionSeq) {
          this.#transport = null;
          this.#connected = false;
          this.#retireObservation();
          this.#diagnostic("connection-lost");
          this.#scheduleReconnect();
        }
        throw error;
      })
      .finally(() => {
        if (this.#connecting === attempt) this.#connecting = null;
      });
    this.#connecting = attempt;
    return attempt;
  }

  async #reconnect(): Promise<void> {
    const transport = this.#transport;
    this.#transport = null;
    // Retire the previous attempt completely, INCLUDING a `connect()` that is
    // still in flight. Dropping the stored promise is what makes the next
    // `#connect()` start a fresh attempt: adopting the retired promise would
    // leave the observer waiting on an attempt this method just invalidated,
    // whose sequence fence then suppresses any recovery scheduling.
    this.#connectionSeq += 1;
    this.#connecting = null;
    this.#connected = false;
    transport?.close();
    if (this.#disposed) return;
    await this.#connect();
  }

  #createTransport(seq: number): NativeCodexRpcTransport {
    const options: NativeCodexRpcTransportOptions = {
      endpoint: this.#endpoint,
      ...(this.#expectedCodexHome === undefined
        ? {}
        : { expectedCodexHome: this.#expectedCodexHome }),
      requestTimeoutMs: this.#limits.requestTimeoutMs,
      onConnected: () => {
        if (seq !== this.#connectionSeq) return;
        // Corroboration only: the observer never adopts or subscribes anything.
      },
      onNotification: (notification) => {
        if (seq !== this.#connectionSeq || this.#disposed) return;
        this.#handleNotification(notification);
      },
      onServerRequest: (signal) => {
        if (seq !== this.#connectionSeq || this.#disposed) return;
        this.#handleServerRequest(signal);
      },
      onFailure: (code) => {
        if (seq !== this.#connectionSeq || this.#disposed) return;
        this.#diagnostic(code);
      },
      onClosed: () => {
        if (seq !== this.#connectionSeq || this.#disposed) return;
        this.#handleDisconnected();
      },
    };
    return new NativeCodexRpcTransport(options);
  }

  #handleDisconnected(): void {
    // A closure while a connect attempt is still in flight IS that attempt
    // failing: its rejection owns the withdrawal and the backoff, so the card is
    // not withdrawn twice and no second recovery chain starts.
    if (!this.#connected && this.#connecting !== null) return;
    if (!this.#connected && this.#transport === null) return;
    this.#connected = false;
    this.#clearTimer("#cooldownHandle");
    this.#clearTimer("#activeHandle");
    this.#inFlight = false;
    this.#queued = false;
    // A real failure withdraws every axis: a stale number must never be
    // republished as fresh, and it must never be laundered into a zero.
    this.#rootStatus = null;
    this.#tasks = null;
    this.#shells = null;
    this.#workWitness = false;
    this.#toolLabel = null;
    this.#descendants.clear();
    this.#publish();
    this.#diagnostic("connection-lost");
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#disposed || this.#reconnectHandle !== null) return;
    const delay = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(this.#reconnectDelayMs * 2, this.#limits.reconnectMaxBackoffMs);
    this.#reconnectHandle = this.#scheduler.setTimer(() => {
      this.#reconnectHandle = null;
      if (this.#disposed) return;
      void this.#connect().catch(() => {
        // The next disconnect (or the next scheduled attempt) reports again.
      });
    }, delay);
  }

  /* ----------------------------------------------------------- projections */

  #handleNotification(notification: NativeCodexRpcNotification): void {
    switch (notification.method) {
      case "thread/status/changed": {
        if (notification.threadId === this.#rootThreadId) {
          this.#noteRootStatus(notification.status);
          // Status edges also move the descendant and terminal populations.
          this.#requestRefresh();
          return;
        }
        if (!this.#descendants.has(notification.threadId)) {
          // A broadcast for a thread outside the bound lineage is not this row's
          // evidence, and must not churn the census.
          return;
        }
        this.#descendants.set(notification.threadId, notification.status);
        this.#requestRefresh();
        return;
      }
      case "thread/started": {
        const row = notification.row;
        if (row.threadId === this.#rootThreadId) {
          this.#noteRootStatus(row.status);
          this.#requestRefresh();
          return;
        }
        if (row.parentThreadId === this.#rootThreadId || this.#descendants.has(row.threadId)
          || this.#ancestry.get(row.threadId) === "descendant") {
          this.#requestRefresh();
        }
        return;
      }
      case "thread/deleted":
      case "thread/archived":
      case "thread/closed": {
        const id = notification.threadId;
        if (id === this.#rootThreadId) {
          // The root is gone: the row's foreground is no longer positively known.
          this.#rootStatus = null;
          this.#publish();
          this.#requestRefresh();
          return;
        }
        if (!this.#descendants.delete(id)) return;
        this.#requestRefresh();
        return;
      }
    }
  }

  /**
   * An inbound server request is counted and forgotten. The payload is already
   * gone at the transport edge, there is no reply path to take, and pending input
   * is derived from the provider's own `activeFlags`, never from seeing a request.
   */
  #handleServerRequest(_signal: NativeCodexServerRequestSignal): void {
    this.#serverRequestCount += 1;
  }

  #noteRootStatus(status: NativeCodexThreadStatus): void {
    this.#rootStatus = status;
    if (status.kind !== "active") {
      // A tool label describes work inside a live turn; outside one it is stale.
      this.#toolLabel = null;
    }
    if (status.kind === "systemError") {
      // Not Ready, not zero: the agent axis becomes unknown and the row is told.
      this.#rootStatus = null;
      this.#diagnostic("root-system-error");
    } else if (status.kind === "notLoaded") {
      this.#rootStatus = null;
      this.#diagnostic("root-not-loaded");
    }
    this.#publish();
  }

  #buildObservation(): NativeStatusObservation {
    const projected = projectNativeCodexRootStatus(this.#rootStatus);
    const status = this.#rootStatus;
    const activity: string[] = [];
    if (status !== null) {
      // The activity line keeps reporting the UNDERLYING foreground: a blocked
      // root's turn is still open, and `Working` (or the caller's tool type) is
      // what is really happening. The waiting fact lives on the agent/input
      // axes, where the shared row model renders it as `agent waiting`.
      const line = status.kind === "active"
        ? (this.#toolLabel ?? NATIVE_CODEX_RPC_ACTIVITY_WORKING)
        : status.kind === "idle" ? NATIVE_CODEX_RPC_ACTIVITY_READY : null;
      if (line !== null) activity.push(line);
    }
    return {
      busy: projected.busy,
      pendingInput: projected.pendingInput,
      activity: activity.slice(0, MAX_ACTIVITY_LINES),
      activeTasks: this.#tasks,
      activeShells: this.#shells,
      support: NATIVE_CODEX_RPC_STATUS_SUPPORT,
    };
  }

  #publish(): void {
    // Mid-census publications are suppressed: the walk republishes one complete
    // snapshot when it lands, so a healthy refresh never shows a half-known card.
    if (this.#disposed || this.#suppressPublish) return;
    const observation = this.#buildObservation();
    if (sameObservation(this.#last, observation)) return;
    this.#last = observation;
    try {
      this.#onObservation(observation);
    } catch {
      // A host sink cannot corrupt this observer.
    }
  }

  /** Retire everything the current binding proved, without reconnecting. */
  #retireObservation(): void {
    this.#rootStatus = null;
    this.#tasks = null;
    this.#shells = null;
    this.#workWitness = false;
    this.#toolLabel = null;
    this.#descendants.clear();
    this.#ancestry.clear();
    this.#clearTimer("#cooldownHandle");
    this.#clearTimer("#activeHandle");
    // A retirement is never a mid-walk intermediate state: the walk that owned
    // it is already unable to publish, and the row must see the withdrawal now.
    this.#suppressPublish = false;
    this.#publish();
  }

  /* -------------------------------------------------------------- refresh */

  /**
   * Coalescing entry point. One census at a time; anything requested during one
   * collapses into at most one trailing census at the next cooldown boundary.
   * `immediate` skips the cooldown wait (used for the post-connect re-pull and a
   * rebind), never the coalescing.
   */
  #requestRefresh(immediate = false): void {
    if (this.#disposed || !this.#connected) return;
    if (this.#inFlight) {
      this.#queued = true;
      if (immediate) this.#forceQueued = true;
      return;
    }
    if (!immediate && this.#cooldownHandle !== null) {
      // A trailing slot already exists at the cooldown boundary; take it.
      this.#queued = true;
      return;
    }
    this.#startCensus();
  }

  #startCensus(): void {
    if (this.#inFlight) {
      this.#queued = true;
      return;
    }
    const census = this.#runCensus().finally(() => {
      if (this.#currentCensus === census) this.#currentCensus = null;
    });
    this.#currentCensus = census;
  }

  #afterCensus(): void {
    this.#inFlight = false;
    if (this.#disposed) return;
    // Only a request that actually arrived during the walk schedules a trailing
    // census, so an idle row leaves no timer running at all. A forced request
    // (connect or rebind) runs next, because the caller is waiting on it.
    if (this.#queued || this.#forceQueued) {
      const forced = this.#forceQueued;
      this.#queued = false;
      this.#forceQueued = false;
      const cooldown = this.#limits.refreshCooldownMs;
      if (!forced && cooldown > 0) {
        this.#cooldownHandle = this.#scheduler.setTimer(() => {
          this.#cooldownHandle = null;
          if (this.#disposed || !this.#connected) return;
          this.#startCensus();
        }, cooldown);
      } else {
        this.#startCensus();
      }
    }
    this.#rearmActiveRefresh();
  }

  /**
   * Re-arm only while the provider positively reports work: an active root, a
   * live owned sub-agent, or a live background terminal. When everything is
   * known-idle the chain stops, so an idle row generates no polling at all.
   */
  #rearmActiveRefresh(): void {
    if (this.#disposed || !this.#connected) return;
    if (this.#activeHandle !== null) return;
    const active = this.#rootStatus?.kind === "active"
      || (this.#tasks ?? 0) > 0
      || (this.#shells ?? 0) > 0
      || this.#workWitness;
    if (!active) return;
    this.#activeHandle = this.#scheduler.setTimer(() => {
      this.#activeHandle = null;
      if (this.#disposed || !this.#connected) return;
      if (this.#inFlight) {
        this.#queued = true;
        return;
      }
      if (this.#cooldownHandle !== null) {
        this.#queued = true;
        return;
      }
      this.#startCensus();
    }, this.#limits.activeRefreshIntervalMs);
  }

  /**
   * One complete census: root snapshot, owned descendant walk, background
   * terminal census. Every await is fenced on the binding that started it, so a
   * rebinding or disconnect can never publish out of a retired walk.
   */
  async #runCensus(): Promise<void> {
    if (this.#inFlight || this.#disposed || !this.#connected) return;
    const transport = this.#transport;
    if (transport === null) return;
    this.#inFlight = true;
    this.#suppressPublish = true;
    const generation = this.#generation;
    const rootThreadId = this.#rootThreadId;
    const seq = this.#connectionSeq;
    const stale = (): boolean => this.#disposed
      || !this.#connected
      || seq !== this.#connectionSeq
      || this.#generation !== generation
      || this.#rootThreadId !== rootThreadId
      || this.#transport !== transport;

    try {
      // 1. Root snapshot. Status broadcasts are additive, not authoritative:
      //    every census re-reads the bound root.
      let rootLiveForTerminals = false;
      try {
        const rootRow = await transport.readThread(rootThreadId);
        if (stale()) return;
        if (rootRow === null || rootRow.threadId !== rootThreadId) {
          this.#rootStatus = null;
          this.#diagnostic("root-read-failed");
        } else {
          this.#noteRootStatus(rootRow.status);
          // A thread the provider just described is in its in-memory model unless
          // it explicitly reports `notLoaded`, and only such a thread can own a
          // running background terminal.
          rootLiveForTerminals = rootRow.status.kind !== "notLoaded";
        }
      } catch {
        if (stale()) return;
        this.#rootStatus = null;
        this.#diagnostic("root-read-failed");
      }

      // 2. Owned descendant census.
      const walk: CensusWalk = { rows: new Map(), ancestorIds: new Set(), failure: null, reads: 0 };
      await this.#collectPersistedDescendants(transport, rootThreadId, walk, stale);
      if (stale()) return;
      await this.#collectLoadedChildren(transport, rootThreadId, walk, stale);
      if (stale()) return;
      await this.#resolveAncestry(transport, rootThreadId, walk, stale);
      if (stale()) return;

      const descendants = new Map<string, NativeCodexThreadRow>();
      if (walk.failure !== null) {
        // A partial walk cannot publish a number, and certainly not a zero.
        this.#tasks = null;
        this.#diagnostic(walk.failure);
      } else {
        for (const [id, row] of walk.rows) {
          if (id === rootThreadId) continue;
          if (this.#ancestry.get(id) !== "descendant") continue;
          descendants.set(id, row);
        }
        this.#descendants.clear();
        for (const [id, row] of descendants) this.#descendants.set(id, row.status);
        this.#tasks = countActiveNativeCodexDescendants(descendants.values());
      }

      // 3. Background terminal census. The threads that could own a running
      //    terminal are exactly the threads the provider has in memory, so a
      //    census whose membership never completed — or whose root liveness was
      //    never established — cannot claim a total. That axis is withdrawn
      //    rather than counted over a scope that may be missing an owned child.
      await this.#censusBackgroundTerminals(
        transport,
        rootThreadId,
        { rootLive: rootLiveForTerminals, descendants, membershipComplete: walk.failure === null },
        stale,
      );
      if (stale()) return;

      // Positive evidence on ANY axis keeps the witness, independently of whether
      // another axis failed: a live owned sub-agent is work even while the shell
      // axis is unknown, and dropping it here would let the chain stop with that
      // axis stranded. Only a census that positively saw everything idle clears it.
      if (this.#rootStatus?.kind === "active"
        || (this.#tasks ?? 0) > 0
        || (this.#shells ?? 0) > 0) {
        this.#workWitness = true;
      } else if (this.#rootStatus?.kind === "idle"
        && this.#tasks === 0 && this.#shells === 0) {
        this.#workWitness = false;
      }

      this.#suppressPublish = false;
      this.#publish();
    } finally {
      this.#suppressPublish = false;
      if (seq === this.#connectionSeq && !this.#disposed) this.#afterCensus();
      else this.#inFlight = false;
    }
  }

  /** `thread/list` scoped to the bound ancestor, followed across every page. */
  async #collectPersistedDescendants(
    transport: NativeCodexRpcTransport,
    rootThreadId: string,
    walk: CensusWalk,
    stale: () => boolean,
  ): Promise<void> {
    if (walk.failure !== null) return;
    let cursor: string | null = null;
    for (let page = 0; page < this.#limits.maxCensusPages; page += 1) {
      try {
        const result = await transport.listDescendantThreads(rootThreadId, cursor);
        if (stale()) return;
        for (const row of result.rows) {
          if (row.threadId === rootThreadId) continue;
          walk.rows.set(row.threadId, row);
          walk.ancestorIds.add(row.threadId);
          if (walk.rows.size > this.#limits.maxKnownDescendants) {
            walk.failure = "tasks-budget";
            return;
          }
        }
        cursor = result.nextCursor;
        if (cursor === null) return;
      } catch {
        if (stale()) return;
        walk.failure = "tasks-incomplete";
        return;
      }
    }
    // Pages remained: the walk is incomplete and may not publish a count.
    walk.failure = "tasks-budget";
  }

  /**
   * `thread/loaded/list` catches children that are live but absent from the
   * persisted listing (ephemeral sub-agents). The ids it returns are bare, so
   * each unknown one costs one metadata read, inside a bounded budget.
   */
  async #collectLoadedChildren(
    transport: NativeCodexRpcTransport,
    rootThreadId: string,
    walk: CensusWalk,
    stale: () => boolean,
  ): Promise<void> {
    if (walk.failure !== null) return;
    let cursor: string | null = null;
    for (let page = 0; page < this.#limits.maxCensusPages; page += 1) {
      let threadIds: readonly string[];
      try {
        const result = await transport.listLoadedThreadIds(cursor);
        if (stale()) return;
        threadIds = result.threadIds;
        cursor = result.nextCursor;
      } catch {
        if (stale()) return;
        walk.failure = "tasks-incomplete";
        return;
      }
      for (const id of threadIds) {
        if (id === rootThreadId) continue;
        if (walk.rows.has(id)) continue;
        if (this.#ancestry.get(id) === "unrelated") continue;
        if (walk.reads >= this.#limits.maxDescendantReads) {
          walk.failure = "tasks-budget";
          return;
        }
        walk.reads += 1;
        try {
          const row = await transport.readThread(id);
          if (stale()) return;
          // An unreadable row, or one whose identity does not match the id asked
          // for, means ownership could NOT be established. It is never evidence
          // that the thread is unrelated: caching it that way would exclude
          // possibly owned work from this census and from every healthy one
          // afterwards. The census degrades instead, and a later read can succeed.
          if (row === null || row.threadId !== id) {
            walk.failure = "tasks-incomplete";
            return;
          }
          walk.rows.set(row.threadId, row);
        } catch {
          if (stale()) return;
          walk.failure = "tasks-incomplete";
          return;
        }
      }
      if (cursor === null) return;
    }
    walk.failure = "tasks-budget";
  }

  /**
   * Proves each collected row descends from the bound root. A row counts only
   * when its parent chain reaches the root within the depth bound; a row that
   * reaches another root, a fork without a parent link, or a cycle does not.
   */
  async #resolveAncestry(
    transport: NativeCodexRpcTransport,
    rootThreadId: string,
    walk: CensusWalk,
    stale: () => boolean,
  ): Promise<void> {
    for (const [id] of [...walk.rows]) {
      if (walk.failure !== null) return;
      if (id === rootThreadId) continue;
      const fromAncestorQuery = walk.ancestorIds.has(id);
      const known = this.#ancestry.get(id);
      if (known === "descendant") continue;
      if (known === "unrelated") {
        // The provider's own ancestor filter said this row IS a descendant and
        // our chain memory says it is not: the view is contradictory, so the
        // census degrades instead of quietly dropping a possibly-live child.
        if (fromAncestorQuery) {
          walk.failure = "tasks-incomplete";
          return;
        }
        continue;
      }
      const visited = new Set<string>([id]);
      let currentId = id;
      let depth = 0;
      for (;;) {
        const row = walk.rows.get(currentId);
        if (row === undefined) {
          walk.failure = "tasks-incomplete";
          return;
        }
        const parent = row.parentThreadId;
        if (parent === null) {
          // A row with no parent is another root, or a fork with no parent link:
          // never this row's sub-agent. From the ancestor query that is a
          // contradiction, and the census degrades rather than under-counting.
          if (fromAncestorQuery) {
            walk.failure = "tasks-incomplete";
            return;
          }
          this.#markChain(visited, "unrelated");
          break;
        }
        if (parent === rootThreadId) {
          this.#markChain(visited, "descendant");
          break;
        }
        const parentKnown = this.#ancestry.get(parent);
        if (parentKnown !== undefined) {
          if (fromAncestorQuery && parentKnown === "unrelated") {
            walk.failure = "tasks-incomplete";
            return;
          }
          this.#markChain(visited, parentKnown);
          break;
        }
        if (visited.has(parent)) {
          walk.failure = "tasks-cycle";
          return;
        }
        depth += 1;
        if (depth > this.#limits.maxDescendantDepth) {
          walk.failure = "tasks-budget";
          return;
        }
        if (!walk.rows.has(parent)) {
          if (walk.reads >= this.#limits.maxDescendantReads) {
            walk.failure = "tasks-budget";
            return;
          }
          walk.reads += 1;
          try {
            const parentRow = await transport.readThread(parent);
            if (stale()) return;
            // Same rule one level up: a missing or identity-mismatched parent row
            // proves nothing about the chain, so the census degrades rather than
            // marking the chain unrelated on an unreadable read.
            if (parentRow === null || parentRow.threadId !== parent) {
              walk.failure = "tasks-incomplete";
              return;
            }
            walk.rows.set(parentRow.threadId, parentRow);
          } catch {
            if (stale()) return;
            walk.failure = "tasks-incomplete";
            return;
          }
        }
        visited.add(parent);
        currentId = parent;
      }
    }
    if (this.#descendants.size > this.#limits.maxKnownDescendants) walk.failure = "tasks-budget";
  }

  /**
   * `thread/backgroundTerminals/list` for every thread the provider POSITIVELY
   * established as live in this census — the bound root plus proven descendants
   * that are not `notLoaded` — summed as a deduplicated process-id count.
   *
   * `notLoaded` threads are excluded because the provider's own handler resolves
   * the id against its in-memory threads and rejects an unloaded one: querying a
   * historical persisted child would fail the whole axis for a thread that cannot
   * own a running terminal. Any other failure withdraws the aggregate rather than
   * publishing a partial count, and never publishes a zero it did not see.
   */
  async #censusBackgroundTerminals(
    transport: NativeCodexRpcTransport,
    rootThreadId: string,
    scope: {
      readonly rootLive: boolean;
      readonly descendants: ReadonlyMap<string, NativeCodexThreadRow>;
      readonly membershipComplete: boolean;
    },
    stale: () => boolean,
  ): Promise<void> {
    if (!scope.rootLive || !scope.membershipComplete) {
      this.#shells = null;
      this.#diagnostic("shells-incomplete");
      return;
    }
    const threadIds: string[] = [rootThreadId];
    for (const [id, row] of scope.descendants) {
      if (row.status.kind === "notLoaded") continue;
      threadIds.push(id);
    }
    if (threadIds.length > this.#limits.maxShellCensusThreads) {
      // Refuse to publish a knowingly partial count.
      this.#shells = null;
      this.#diagnostic("shells-budget");
      return;
    }
    const processes = new Set<string>();
    for (const threadId of threadIds) {
      let cursor: string | null = null;
      let pages = 0;
      for (;;) {
        pages += 1;
        if (pages > this.#limits.maxCensusPages) {
          // Pages remained: this is not a complete count.
          this.#shells = null;
          this.#diagnostic("shells-incomplete");
          return;
        }
        try {
          const result = await transport.listBackgroundTerminals(threadId, cursor);
          if (stale()) return;
          for (const processId of result.processIds) processes.add(processId);
          cursor = result.nextCursor;
        } catch {
          if (stale()) return;
          this.#shells = null;
          this.#diagnostic("shells-incomplete");
          return;
        }
        if (cursor === null) break;
      }
    }
    this.#shells = processes.size;
  }

  /* -------------------------------------------------------------- helpers */

  #markChain(ids: Iterable<string>, verdict: Ancestry): void {
    for (const id of ids) {
      if (id === this.#rootThreadId) continue;
      this.#ancestry.set(id, verdict);
      while (this.#ancestry.size > this.#limits.maxUnrelatedIds) {
        const oldest = this.#ancestry.keys().next();
        if (oldest.done === true) break;
        this.#ancestry.delete(oldest.value);
      }
    }
  }

  #clearTimer(field: "#cooldownHandle" | "#activeHandle" | "#reconnectHandle"): void {
    const handle = field === "#cooldownHandle"
      ? this.#cooldownHandle
      : field === "#activeHandle" ? this.#activeHandle : this.#reconnectHandle;
    if (handle === null) return;
    try {
      this.#scheduler.clearTimer(handle);
    } catch {
      // A timer that cannot be cleared is still unreachable: every path checks.
    }
    if (field === "#cooldownHandle") this.#cooldownHandle = null;
    else if (field === "#activeHandle") this.#activeHandle = null;
    else this.#reconnectHandle = null;
  }

  #diagnostic(code: NativeCodexRpcStatusDiagnosticCode): void {
    if (this.#disposed || this.#onDiagnostic === undefined) return;
    try {
      this.#onDiagnostic(code);
    } catch {
      // Contained.
    }
  }
}

/* --------------------------------------------------------------- internals */

function sameObservation(
  left: NativeStatusObservation | null,
  right: NativeStatusObservation,
): boolean {
  if (left === null) return false;
  if (left.busy !== right.busy) return false;
  if (left.pendingInput !== right.pendingInput) return false;
  if (left.activeTasks !== right.activeTasks) return false;
  if (left.activeShells !== right.activeShells) return false;
  const a = left.activity ?? [];
  const b = right.activity ?? [];
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function sameEndpoint(left: NativeCodexRpcEndpoint, right: NativeCodexRpcEndpoint): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "unix" && right.kind === "unix") return left.socketPath === right.socketPath;
  if (left.kind === "loopback-ws" && right.kind === "loopback-ws") {
    return left.host === right.host
      && left.port === right.port
      // Callable identity: a new credential accessor is a new lease. The token
      // value is never read here, so it cannot leak through a rebinding check.
      && left.authorization.token === right.authorization.token;
  }
  return false;
}

function boundedText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxChars) return null;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;
  return trimmed;
}

function normalizeLimits(limits: Partial<NativeCodexRpcStatusLimits> | undefined): NativeCodexRpcStatusLimits {
  const base = NATIVE_CODEX_RPC_STATUS_DEFAULT_LIMITS;
  const int = (value: number | undefined, fallback: number, max: number): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fallback;
    return Math.min(value, max);
  };
  const positive = (value: number | undefined, fallback: number, max: number): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return fallback;
    return Math.min(value, max);
  };
  return Object.freeze({
    censusPageLimit: positive(limits?.censusPageLimit, base.censusPageLimit, NATIVE_CODEX_RPC_MAX_PAGE_LIMIT),
    maxCensusPages: positive(limits?.maxCensusPages, base.maxCensusPages, 64),
    maxDescendantReads: positive(limits?.maxDescendantReads, base.maxDescendantReads, 512),
    maxDescendantDepth: positive(limits?.maxDescendantDepth, base.maxDescendantDepth, 16),
    maxKnownDescendants: positive(limits?.maxKnownDescendants, base.maxKnownDescendants, 512),
    maxUnrelatedIds: positive(limits?.maxUnrelatedIds, base.maxUnrelatedIds, 4_096),
    maxShellCensusThreads: positive(limits?.maxShellCensusThreads, base.maxShellCensusThreads, 64),
    refreshCooldownMs: int(limits?.refreshCooldownMs, base.refreshCooldownMs, 60_000),
    activeRefreshIntervalMs: positive(limits?.activeRefreshIntervalMs, base.activeRefreshIntervalMs, 600_000),
    reconnectBackoffMs: positive(limits?.reconnectBackoffMs, base.reconnectBackoffMs, 60_000),
    reconnectMaxBackoffMs: positive(limits?.reconnectMaxBackoffMs, base.reconnectMaxBackoffMs, 600_000),
    requestTimeoutMs: positive(limits?.requestTimeoutMs, base.requestTimeoutMs, 60_000),
  });
}
