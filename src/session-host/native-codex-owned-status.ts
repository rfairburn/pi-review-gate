/**
 * The owning host's Codex status consumer: the legacy hook lane until THIS run's
 * own owned-backend capability arrives, then ONE read-only RPC observer that owns
 * all five sidebar categories.
 *
 * ## Why the lane switch happens here and not in the manager
 *
 * The manager arms a run's observer BEFORE that run's launch descriptor exists, so
 * no observer factory can know at construction time whether the row will turn out
 * to be an owned Codex launch. This consumer therefore starts as the EXACT legacy
 * Codex source — same controller, same applicability declaration, same hook
 * handling — and stays that way until the manager hands it this run's one private
 * owned-backend capability. That capability is the only evidence that the backend
 * beside this row is this host's own, so it is the only thing allowed to change the
 * row's applicability. A host that opts in but whose provider composed an ordinary
 * standalone descriptor receives no capability and keeps the legacy lane, its
 * declaration, and its behavior byte-for-byte.
 *
 * ## One source at a time, never a blend
 *
 * The switch is one-way, exclusive, and happens at most once per run: the legacy
 * controller is disposed (its own full retirement, and it emits nothing for it), and
 * every later hook event and closed failure is dropped rather than merged into RPC
 * facts. The RPC lane is then the
 * only writer, and its complete snapshots (which declare all five categories)
 * replace the earlier declaration through the shared merge, so an owned row never
 * keeps a not-applicable category it outgrew. Nothing reverts: a later facts
 * withdrawal publishes unknown values under the RPC declaration; it never restores
 * the retired hook lane, and it never opts a healthy owned row out of a category.
 *
 * ## The fresh-candidate and fresh-root preconditions
 *
 * The RPC observer needs a positively proven thread, and this consumer never
 * guesses one. It attaches to the retained facts source of THIS lease's relay only
 * after the live capability delivery, and it starts exactly one RPC observer when
 * that source states either the owner-private FRESH CANDIDATE binding — the empty
 * owned-backend census, one genuine TUI `initialize`, and exactly one initial
 * non-helper, parentless, non-ephemeral `thread/start` naming thread A — or a
 * BOUND fresh root, which additionally has this connection's own first successful
 * `turn/start` on that same A. All of it is proved inside the relay and the
 * composite, not here. Starting on the candidate is what lets a fresh, still
 * unprompted session reach a positively read `Ready`, `input none`, and `0`/`0`:
 * those values come only from the observer's own complete `thread/read` of A and
 * its complete descendant and background-terminal censuses plus the source's
 * positively empty async question queue — never from a default, a quiet period,
 * or the empty-backend witness alone. When A later binds, the SAME observer keeps
 * running (no redial), and any census that may have read A before its own first
 * turn is superseded so it can never land a stale Ready over that work. A
 * connected-only, an empty, a candidate without the fresh binding, or a withdrawn
 * source publishes nothing beyond the switch's single unknown snapshot.
 *
 * ## What the facts may and may not say
 *
 * The relay attributes a tool fact only to the bound root, so a helper or child
 * thread never reaches this consumer as a root label; the consumer additionally
 * fences every later snapshot against the connection generation and root thread it
 * actually dialed, and applies only the CURRENT rooted tool as one bounded label
 * through the RPC lane's documented merge seam, clearing it with `null` when a new
 * root turn has no tool or the tool completed. That retained current fact is also
 * what lets a recovered read-only connection restore its label without a new relay
 * event. The source's CURRENT async question queue state is forwarded the same
 * way through the RPC lane's async-input merge seam, which combines it with the
 * provider's blocked flags for the input axis only. The RPC lane keeps authority
 * over Ready/Working, the pending-input axes, and both background counts; a tool completion is never fed to the row as a Ready
 * claim, and this consumer never replies to, requests, or controls anything on
 * either lane.
 *
 * ## Failure and retirement
 *
 * A permanent facts withdrawal, a bound snapshot naming a connection or root other
 * than the adopted one, an unusable endpoint on this run's own capability, or an
 * observer construction refusal retires the OBSERVATION only: the RPC socket and
 * timers are closed, the facts watcher is detached, and exactly one complete unknown
 * snapshot is published through the row's current live context. Nothing
 * here invalidates the run's status capture, retires a manager generation, rebinds
 * a root, stops the owned backend, stops the relay, detaches its metadata tap, or
 * terminates the native PTY. The manager's own retirement (invalidate then dispose)
 * closes the live RPC socket, the watcher, and the retired hook lane, and later
 * facts or in-flight census answers publish nothing.
 */

import type {
  NativeOwnedCodexBackendObservationSource,
  NativeStatusObserver,
} from "./instances";
import type { NativeHookEvent, NativeHookFailure } from "./native-hook-protocol";
import { readNativeCodexOwnedObserverEndpoint } from "./native-codex-owned-composite";
import {
  NATIVE_CODEX_RPC_STATUS_SUPPORT,
  NativeCodexRpcStatusObserver,
  type NativeCodexRpcStatusLimits,
  type NativeCodexRpcStatusScheduler,
} from "./native-codex-rpc-status";
import type {
  NativeCodexTuiRootAsyncInput,
  NativeCodexTuiRootFactsSnapshot,
  NativeCodexTuiRootFactsSource,
  NativeCodexTuiRootToolFact,
} from "./native-codex-tui-root-facts";
import type { NativeCodexTuiRelayToolCategory } from "./native-codex-tui-relay";
import type { NativeStatusObservation, NativeStatusSupportMap } from "./native-status";

/**
 * The relay's closed root tool categories mapped to the SAME closed activity
 * labels the repository already uses for Codex tool activity (`native-codex-status`
 * item and hook vocabularies). It is a label lookup only: no provider text, no
 * command, no path, and no argument can reach it, because the relay itself decoded
 * nothing beyond the closed category.
 */
export const NATIVE_CODEX_OWNED_TOOL_LABELS: Readonly<Record<NativeCodexTuiRelayToolCategory, string>> =
  Object.freeze({
    command: "Exec",
    "file-change": "Edit",
    "mcp-tool": "MCP tool",
    "dynamic-tool": "Tool",
    "web-search": "Web search",
  });

/** One complete unknown snapshot that states the RPC lane's own applicability. */
function ownedUnknownObservation(): NativeStatusObservation {
  return Object.freeze({
    busy: null,
    pendingInput: null,
    activeTasks: null,
    activeShells: null,
    activity: [],
    support: NATIVE_CODEX_RPC_STATUS_SUPPORT,
  });
}

/**
 * The RPC observer's OWN binding fence. It is neither the capability source's
 * lease counter nor the manager's status generation: unrelated counters that
 * happen to share a name are never assumed equal, so this consumer composes its
 * own value and keeps its own epoch alongside it.
 */
function ownedRpcGeneration(
  source: NativeOwnedCodexBackendObservationSource,
  connectionId: string | undefined,
  epoch: number,
): string {
  const composed = `owned-codex:${source.leaseId}:${connectionId ?? "none"}:${epoch}`;
  // The observer bounds its fence; a value that cannot fit stays bounded rather
  // than throwing, and the consumer's own epoch still fences every publish.
  return composed.length <= 256 ? composed : `owned-codex:${epoch}`;
}

export interface OwnedNativeCodexStatusObserverOptions {
  /** The exact legacy Codex source this run starts with; retired by the switch. */
  readonly legacy: NativeStatusObserver;
  /** The run's own live status seam. Never queues, retries, or replays. */
  readonly emit: (observation: NativeStatusObservation) => void;
  /** Timer seam passed through to the RPC lane. */
  readonly scheduler?: NativeCodexRpcStatusScheduler;
  /** Bounds passed through to the RPC lane. */
  readonly limits?: Partial<NativeCodexRpcStatusLimits>;
}

/**
 * Build one run's owned-aware Codex status consumer. It is the manager's
 * {@linkcode NativeStatusObserver} for the whole run: hook lane first, RPC lane
 * only after this run's own owned-backend capability arrives.
 */
export function createOwnedNativeCodexStatusObserver(
  options: OwnedNativeCodexStatusObserverOptions,
): NativeStatusObserver {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("owned native Codex status options must be an object");
  }
  if (typeof options.emit !== "function") {
    throw new TypeError("owned native Codex status emit must be a function");
  }
  const legacy = options.legacy;
  if (legacy === null || typeof legacy !== "object"
    || typeof legacy.acceptHook !== "function"
    || typeof legacy.acceptFailure !== "function"
    || typeof legacy.dispose !== "function") {
    throw new TypeError("owned native Codex status requires the run's legacy source");
  }
  return new OwnedNativeCodexStatusConsumer(options);
}

class OwnedNativeCodexStatusConsumer implements NativeStatusObserver {
  readonly #emit: (observation: NativeStatusObservation) => void;
  readonly #scheduler: NativeCodexRpcStatusScheduler | undefined;
  readonly #limits: Partial<NativeCodexRpcStatusLimits> | undefined;

  /** The hook lane, until the exclusive switch retires it. */
  #legacy: NativeStatusObserver | undefined;
  /** This run's one adopted capability; never replaced by a later one. */
  #source: NativeOwnedCodexBackendObservationSource | undefined;
  #factsUnsubscribe: (() => void) | undefined;
  #rpc: NativeCodexRpcStatusObserver | undefined;
  /**
   * The binding this run's one observer was dialed under. Every later snapshot is
   * compared against it: the card the row shows describes exactly this connection
   * and this root, and nothing else may edit it.
   */
  #boundConnectionId: string | undefined;
  #boundRootThreadId: string | undefined;
  /** True once the adopted thread's first own turn bound it as the root. */
  #rootBound = false;
  /**
   * The last validated CURRENT rooted tool fact under that binding. It is the
   * consumer's own memory of the relay's current state, which is what lets a
   * recovered read-only connection restore its label without a new relay event.
   */
  #currentTool: NativeCodexTuiRootToolFact | undefined;
  /** True while a label restore is driving this consumer's own sink. */
  #restoring = false;
  #restorePublished = false;

  #switched = false;
  #withdrawn = false;
  #retired = false;
  #disposed = false;
  /** This consumer's own publish epoch, bumped by every retirement. */
  #epoch = 0;

  constructor(options: OwnedNativeCodexStatusObserverOptions) {
    this.#legacy = options.legacy;
    this.#emit = options.emit;
    this.#scheduler = options.scheduler;
    this.#limits = options.limits;
  }

  /**
   * What THIS consumer can report right now: the legacy source's own declaration
   * until the switch, the RPC lane's declaration after it. It is read at the
   * moment the manager publishes, so it never states a lane the run is not using.
   */
  get support(): NativeStatusSupportMap | undefined {
    if (this.#switched) return NATIVE_CODEX_RPC_STATUS_SUPPORT;
    return this.#legacy?.support;
  }

  /* ------------------------------------------------------------- hook lane */

  acceptHook(event: NativeHookEvent): void {
    const legacy = this.#legacy;
    // After the switch the RPC lane is the only writer, and a retired hook event
    // is not a fact. Before it, this is the untouched legacy path.
    if (legacy === undefined || this.#retired || this.#disposed) return;
    legacy.acceptHook(event);
  }

  acceptFailure(failure: NativeHookFailure): void {
    const legacy = this.#legacy;
    if (legacy === undefined || this.#retired || this.#disposed) return;
    legacy.acceptFailure(failure);
  }

  /**
   * The launch-time baseline belongs to whichever lane is live. The legacy Codex
   * source states none today, so this is that same refusal; the RPC lane states no
   * baseline at all, because an ordinary first prompt is already running inside the
   * native TUI and a fresh root is only known after its own proof.
   */
  observeOwnedStartup(): void {
    const legacy = this.#legacy;
    if (legacy === undefined || this.#retired || this.#disposed) return;
    legacy.observeOwnedStartup?.();
  }

  /* ------------------------------------------------------- the owned switch */

  /**
   * This run's ONE private owned-backend capability. A duplicate or a different
   * source is never adopted and never dials again; a capability for a retired run
   * claims nothing. An accepted capability switches this row exclusively to the RPC
   * lane even when its facts are not yet bound, or are unusable: that is unknown
   * under a supported declaration, never a not-applicable opt-out and never a
   * reason to touch the backend or the TUI.
   */
  observeOwnedCodexBackend(source: NativeOwnedCodexBackendObservationSource): void {
    if (this.#switched || this.#retired || this.#disposed) return;
    this.#switched = true;
    this.#source = usableOwnedSource(source) ? source : undefined;

    // Exclusive: the hook lane is retired before the RPC lane can say anything.
    // `dispose()` is the full retirement (no emission of its own); the row's honest
    // unknown is stated once, by the snapshot below, under the RPC declaration.
    const legacy = this.#legacy;
    this.#legacy = undefined;
    if (legacy !== undefined) {
      try {
        legacy.dispose();
      } catch {
        // A retired source's own teardown cannot affect the row.
      }
    }

    // One complete snapshot that both states the RPC applicability and withdraws
    // every value the hook lane may have published. It goes through the run's
    // current live seam only: the manager refuses it before a capture exists, and
    // nothing here queues, retries, or replays it.
    this.#publish(ownedUnknownObservation());

    // The facts watcher attaches only now, after the live capability, so its
    // first delivery is the CURRENT closed state rather than a reconstruction.
    const facts = this.#source?.tuiRootFacts;
    if (facts !== undefined) this.#attachFacts(facts);
  }

  #attachFacts(facts: NativeCodexTuiRootFactsSource): void {
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = facts.watch((snapshot) => {
        this.#onFacts(snapshot);
      });
    } catch {
      // A source that refuses a watcher leaves the row unknown; it is not a
      // reason to touch anything the row owns.
      return;
    }
    if (typeof unsubscribe !== "function") return;
    // The initial delivery is synchronous, so a withdrawal can already have
    // happened inside `watch`. Detach immediately rather than keeping a watcher
    // whose consumer is gone.
    if (this.#withdrawn || this.#retired || this.#disposed) {
      try {
        unsubscribe();
      } catch {
        // Contained.
      }
      return;
    }
    this.#factsUnsubscribe = unsubscribe;
  }

  #onFacts(snapshot: NativeCodexTuiRootFactsSnapshot | undefined): void {
    // A retired or withdrawn consumer publishes nothing further, and a snapshot
    // from a lane this run never adopted claims nothing.
    if (!this.#switched || this.#withdrawn || this.#retired || this.#disposed) return;
    if (snapshot === null || typeof snapshot !== "object") return;

    if (snapshot.phase === "withdrawn") {
      this.#withdraw();
      return;
    }

    let threadId: string | undefined;
    let bound: boolean;
    if (snapshot.phase === "bound") {
      threadId = snapshot.rootThreadId;
      bound = true;
    } else if (snapshot.phase === "candidate" && snapshot.candidateThreadId !== undefined) {
      threadId = snapshot.candidateThreadId;
      bound = false;
    } else {
      // `empty`, `connected`, and a candidate without the fresh binding are all
      // pre-observation states: no thread, no Ready, no zero, and nothing dialed.
      // The source is sticky, so such a state after an adopted binding is a
      // contradiction of what this observer was built on.
      if (this.#rpc !== undefined) this.#withdraw();
      return;
    }

    const connectionId = snapshot.connectionId;
    if (typeof threadId !== "string" || threadId.length === 0
      || typeof connectionId !== "string" || connectionId.length === 0) {
      // A binding this consumer cannot fence contradicts the source's own
      // contract: it is a binding loss, never a thread to guess at.
      this.#withdraw();
      return;
    }

    const tool = bound ? snapshot.tool : undefined;
    const asyncInput = snapshot.asyncInput ?? "unknown";
    if (this.#rpc === undefined) {
      this.#rootBound = bound;
      this.#startRpc(threadId, connectionId, tool, asyncInput);
      return;
    }
    // The adopted connection generation and thread are the whole identity of
    // what this card describes. A later snapshot naming either differently is not
    // an update to apply and never a reason to re-dial: it is the loss of the
    // fresh premise this observer was built on. A bound root never regresses.
    if (this.#boundConnectionId !== connectionId || this.#boundRootThreadId !== threadId
      || (this.#rootBound && !bound)) {
      this.#withdraw();
      return;
    }
    if (bound && !this.#rootBound) {
      // The fresh candidate's own first turn bound it: the same observer keeps
      // reading the same thread, and a census that may predate that work is
      // superseded so it can never publish a stale Ready over it.
      this.#rootBound = true;
      try {
        this.#rpc.supersedeCensus();
      } catch {
        // Contained.
      }
    }
    this.#currentTool = tool;
    this.#applyTool(tool);
    this.#applyAsyncInput(asyncInput);
  }

  #startRpc(
    rootThreadId: string,
    connectionId: string,
    tool: NativeCodexTuiRootToolFact | undefined,
    asyncInput: NativeCodexTuiRootAsyncInput,
  ): void {
    const source = this.#source;
    if (source === undefined) {
      this.#withdraw();
      return;
    }
    let endpoint;
    try {
      // The SAME certified grammar the composite's own probe uses: this run's
      // banner endpoint plus its bearer through the accessor, nothing else.
      endpoint = readNativeCodexOwnedObserverEndpoint(source);
    } catch {
      // An endpoint this host cannot describe is an observation loss, never a
      // reason to touch the backend or the interactive child.
      this.#withdraw();
      return;
    }
    const epoch = this.#epoch += 1;
    this.#boundConnectionId = connectionId;
    this.#boundRootThreadId = rootThreadId;
    this.#currentTool = tool;
    let observer: NativeCodexRpcStatusObserver;
    try {
      observer = new NativeCodexRpcStatusObserver({
        endpoint,
        rootThreadId,
        generation: ownedRpcGeneration(source, connectionId, epoch),
        asyncInput,
        onObservation: (observation) => {
          if (this.#restoring) this.#restorePublished = true;
          this.#onRpcObservation(observation, epoch);
        },
        ...(this.#scheduler === undefined ? {} : { scheduler: this.#scheduler }),
        ...(this.#limits === undefined ? {} : { limits: this.#limits }),
      });
    } catch {
      this.#boundConnectionId = undefined;
      this.#boundRootThreadId = undefined;
      this.#rootBound = false;
      this.#withdraw();
      return;
    }
    this.#rpc = observer;
    // A consumer that attaches while the root is already executing still sees the
    // positively running tool; the provider's own status still decides the axis.
    this.#applyTool(tool);
    // `start()` resolves after the first census. Its rejection is the observer's
    // own closed failure: it withdraws its axes and keeps recovering on its own
    // bounded backoff, and this consumer never surfaces or logs it.
    void Promise.resolve(observer.start()).catch(() => undefined);
  }

  /**
   * Apply the CURRENT rooted tool as the RPC lane's tool-type sub-detail. A
   * completed or absent tool clears the label with `null` — the underlying
   * Ready/Working truth stays with the provider read, never with a completion.
   */
  #applyTool(tool: NativeCodexTuiRootToolFact | undefined): void {
    this.#applyLabel(this.#labelFor(tool));
  }

  /** Forward the source's CURRENT async question queue state (input axis only). */
  #applyAsyncInput(state: NativeCodexTuiRootAsyncInput): void {
    const rpc = this.#rpc;
    if (rpc === undefined) return;
    try {
      rpc.observeAsyncInput(state);
    } catch {
      // The merge seam is total; a throw cannot break the row.
    }
  }

  #labelFor(tool: NativeCodexTuiRootToolFact | undefined): string | null {
    if (tool === undefined || tool.phase !== "started") return null;
    const known = NATIVE_CODEX_OWNED_TOOL_LABELS[tool.category];
    return typeof known === "string" ? known : null;
  }

  #applyLabel(label: string | null): void {
    const rpc = this.#rpc;
    if (rpc === undefined) return;
    try {
      rpc.observeToolActivity(label);
    } catch {
      // The merge seam is total; a throw cannot break the row.
    }
  }

  /**
   * Deliver one RPC snapshot, first restoring the retained tool label when the
   * SAME binding again positively reports an active root.
   *
   * A read-only reconnection re-pulls the provider state and starts with no tool
   * label, while the relay's retained CURRENT fact is unchanged — so no new relay
   * event ever arrives to restate it. Restoring from the consumer's own memory is
   * what keeps a running Exec on screen across a recovery. It invents nothing: the
   * provider's own active witness gates it, the label is the RPC lane's documented
   * idempotent merge seam, and if that call produced a publication, the label-less
   * snapshot that triggered the restore is never republished behind it.
   */
  #onRpcObservation(observation: NativeStatusObservation, epoch: number): void {
    // The epoch is this consumer's own fence: a retired or withdrawn lane cannot
    // publish, however late its census answer arrives.
    if (this.#disposed || this.#retired || this.#withdrawn || epoch !== this.#epoch) return;
    const label = this.#labelFor(this.#currentTool);
    if (!this.#restoring && label !== null && this.#rpc?.rootTurnActive === true) {
      this.#restoring = true;
      this.#restorePublished = false;
      try {
        this.#applyLabel(label);
      } finally {
        this.#restoring = false;
      }
      if (this.#restorePublished) return;
    }
    this.#publish(observation);
  }

  /** Sticky observation withdrawal: close the lane, detach, publish unknown once. */
  #withdraw(): void {
    if (this.#withdrawn) return;
    this.#withdrawn = true;
    this.#epoch += 1;
    this.#currentTool = undefined;
    this.#boundConnectionId = undefined;
    this.#boundRootThreadId = undefined;
    this.#rootBound = false;
    this.#closeRpc();
    this.#detachFacts();
    // Deliberately NOT a capture invalidation and NOT a manager retirement: the
    // row stays live, its generation stays current, and the backend, the relay,
    // and the interactive child keep running.
    this.#publish(ownedUnknownObservation());
  }

  /* -------------------------------------------------------------- teardown */

  /**
   * The manager's authoritative retirement of this run's callbacks. Required-closed
   * for the live lane: the RPC socket and timers close, the facts watcher detaches,
   * and the hook lane is disposed. It never signals a process and never stops a
   * relay. The row's own unknown statement is the manager's capture invalidation,
   * so nothing here writes a second one.
   */
  invalidate(): void {
    if (this.#disposed || this.#retired) return;
    this.#retired = true;
    this.#epoch += 1;
    this.#closeRpc();
    this.#detachFacts();
    const legacy = this.#legacy;
    this.#legacy = undefined;
    if (legacy !== undefined) {
      try {
        legacy.dispose();
      } catch {
        // Contained.
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#retired = true;
    this.#epoch += 1;
    this.#closeRpc();
    this.#detachFacts();
    const legacy = this.#legacy;
    this.#legacy = undefined;
    this.#source = undefined;
    if (legacy !== undefined) {
      try {
        legacy.dispose();
      } catch {
        // Contained.
      }
    }
  }

  #closeRpc(): void {
    const rpc = this.#rpc;
    this.#rpc = undefined;
    if (rpc === undefined) return;
    try {
      // The observer's own disposal closes its real read-only WebSocket and every
      // timer it armed; it never reaches the backend it is only reading.
      rpc.dispose();
    } catch {
      // Contained.
    }
  }

  #detachFacts(): void {
    const unsubscribe = this.#factsUnsubscribe;
    this.#factsUnsubscribe = undefined;
    if (unsubscribe === undefined) return;
    try {
      // Detaching this consumer only. The relay's tap and forwarding stay armed.
      unsubscribe();
    } catch {
      // Contained.
    }
  }

  #publish(observation: NativeStatusObservation): void {
    try {
      this.#emit(observation);
    } catch {
      // The host's sink cannot corrupt this consumer, exactly as for a hook lane.
    }
  }
}

/**
 * Structural validation of the private capability, with no value retained beyond
 * the object itself. A malformed capability is not a reason to throw into the
 * manager: it withdraws this row's status under the RPC declaration instead.
 */
function usableOwnedSource(value: unknown): value is NativeOwnedCodexBackendObservationSource {
  if (value === null || typeof value !== "object") return false;
  const source = value as Partial<NativeOwnedCodexBackendObservationSource>;
  if (typeof source.leaseId !== "string" || source.leaseId.length === 0) return false;
  if (typeof source.generation !== "number" || !Number.isSafeInteger(source.generation) || source.generation < 0) {
    return false;
  }
  if (typeof source.endpoint !== "string" || source.endpoint.length === 0) return false;
  if (typeof source.readObserverBearer !== "function") return false;
  const facts = source.tuiRootFacts;
  if (facts !== undefined
    && (facts === null
      || typeof facts !== "object"
      || typeof facts.current !== "function"
      || typeof facts.watch !== "function")) {
    return false;
  }
  return true;
}
