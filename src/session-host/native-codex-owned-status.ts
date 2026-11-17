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
 * ## Exact restored root and the private conversation identity
 *
 * A consumer built with `resumeConversationId` B is a RESTORE consumer. It
 * accepts only a candidate or bound root that names exactly B; any other
 * thread, a restore expectation that is not one exact provider UUID, or a
 * restore without the row's workspace is never dialed and withdraws instead.
 * The binder (configured with the same B by the composite) is what proves that
 * the genuine TUI's own resume of B on this connection produced the candidate;
 * this consumer adds no second root proof, no rebind, and no history read.
 *
 * When the row's `workspace` is known, the ONE read-only observer is dialed with
 * it as its expected workspace, so the census's existing root `thread/read`
 * also positively compares that root's provider cwd with the workspace (at the
 * transport's decode edge, without retaining the cwd). Until it matches on the
 * current connection the observer publishes only unknown values; afterwards
 * every axis keeps exactly its ordinary complete-census authority. That same
 * validated root read is the only thing that lets `onConversationIdentity`
 * report the root's exact UUID — before the first prompt for a candidate, and
 * for a fresh root as well as a restored one. No other observer, bootstrap, or
 * read exists for it. An accepted identity is reported once; a refused one
 * (for example before the owner's activation) is retried by the next validated
 * root read, with no timer or queue of its own.
 *
 * A live loss of the source this identity rests on — a facts withdrawal, a
 * contradicting snapshot, the observer's own root read positively naming
 * another thread or another workspace, or any other observation withdrawal
 * while the run is live — reports an explicit `null` (alongside the single
 * unknown snapshot for a withdrawal), but only when an identity was previously
 * accepted: missing initial proof is not a loss, and an unknown input, tool, or
 * count axis, or an unreadable/failed root read, is never one either. The
 * owner's own retirement (`invalidate`, `dispose`) reports nothing, so a normal
 * stop never clears the saved identity and no callback can follow it. The
 * legacy hook lane never reports an identity.
 *
 * ## The bound TUI connection's stream ending
 *
 * The adopted connection's stream ending (`generation-closed` with the relay's
 * `client-closed` OR `backend-closed` reason, on the adopted connection)
 * commonly precedes the owner seeing the PTY exit of an ordinary quit, and
 * either socket may close first. That closure is NOT treated as proof of a
 * normal quit, and NOT as a loss either: once the connection is gone no root
 * can be selected without a later connection, and the source reports any
 * later event. So status is withdrawn exactly as for every other withdrawal
 * (socket closed, one unknown snapshot, sticky), while an already ACCEPTED
 * identity is held and only the facts watcher stays attached, identity-only.
 * The first later snapshot (a new connection, a stray event, any loss — the
 * source drops its close evidence on any of them) reports `null` and detaches.
 * The owner's retirement ends the hold silently. Every other close reason
 * (handshake, overflow, relay stopped) is an ordinary live loss.
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
import { isNativeConversationId } from "./native-conversation";
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
  /**
   * Owner-private: this row's exact canonical workspace. When present, the RPC
   * lane publishes nothing but unknown until its own root read positively
   * matched it, and only such a root can be reported as the run's identity.
   */
  readonly workspace?: string;
  /**
   * Owner-private: the exact admitted restored conversation UUID B. Present only
   * for a restoring row; an expectation to prove, never a proof.
   */
  readonly resumeConversationId?: string;
  /**
   * Owner-private identity channel: the exact provider conversation UUID this
   * consumer positively proved is the run's current root, or an explicit `null`
   * when a previously ACCEPTED identity was lost while the run is live. Returns
   * whether the owner accepted it. Never called by the legacy lane, never after
   * retirement, and never with a path or any other value.
   */
  readonly onConversationIdentity?: (conversationId: string | null) => boolean;
  /**
   * Owner-private TITLE channel (issue #690): one ACTUAL user-facing title the
   * consumer's own validated root read reported for the exact conversation identity
   * this owner already accepted, or an explicit `null` when that read positively
   * reported no title. It is reported ONLY for an accepted identity, never before
   * one, never after retirement, and never with a path, a preview, or any other
   * provider text. Returns whether the owner accepted it.
   */
  readonly onConversationTitle?: (conversationId: string, title: string | null) => boolean;
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
  /** The row's exact canonical workspace, when the owner supplied one. */
  readonly #workspace: string | undefined;
  /** True for a restoring row, whether or not its expectation is usable. */
  readonly #restoreMode: boolean;
  /** The exact restored UUID B; undefined in fresh mode or when unusable. */
  readonly #restoreConversationId: string | undefined;
  readonly #onConversationIdentity: ((conversationId: string | null) => boolean) | undefined;
  readonly #onConversationTitle: ((conversationId: string, title: string | null) => boolean) | undefined;
  /**
   * The root whose provider cwd the CURRENT observer positively matched to the
   * workspace. Evidence retained across a refused report so the next validated
   * read can retry; cleared by any withdrawal.
   */
  #validatedRootId: string | undefined;
  /** The identity the owner last ACCEPTED from this consumer. */
  #acceptedIdentity: string | undefined;
  /**
   * The title the owner last ACCEPTED, and only for
   * {@linkcode OwnedNativeCodexStatusConsumer.#acceptedIdentity}. Dedupe state: a
   * new accepted identity resets it, so a title proved for one conversation can
   * never be reported as another conversation's.
   */
  #acceptedTitle: string | null | undefined;
  /**
   * True while status is withdrawn because the adopted TUI connection's stream
   * ended (`client-closed` or `backend-closed`) and an accepted identity is
   * held, identity-only, until any later source event or the owner's retirement.
   */
  #closeHold = false;
  /** The adopted connection whose own stream end started the hold. */
  #heldConnectionId: string | undefined;

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
    this.#workspace = typeof options.workspace === "string" && options.workspace.length > 0
      ? options.workspace
      : undefined;
    this.#restoreMode = options.resumeConversationId !== undefined;
    this.#restoreConversationId = isNativeConversationId(options.resumeConversationId)
      ? options.resumeConversationId
      : undefined;
    this.#onConversationIdentity = typeof options.onConversationIdentity === "function"
      ? options.onConversationIdentity
      : undefined;
    this.#onConversationTitle = typeof options.onConversationTitle === "function"
      ? options.onConversationTitle
      : undefined;
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
    if ((this.#withdrawn && !this.#closeHold) || this.#retired || this.#disposed) {
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
    if (!this.#switched || this.#retired || this.#disposed) return;
    if (this.#closeHold) {
      // Identity-only hold after the adopted connection ended. Anything the
      // source says beyond that same close evidence means something happened
      // after it, so the held identity can no longer be the current one.
      if (!this.#isOwnConnectionStreamEnd(snapshot, this.#heldConnectionId)) this.#endCloseHold();
      return;
    }
    // A withdrawn consumer publishes nothing further, and a snapshot from a
    // lane this run never adopted claims nothing.
    if (this.#withdrawn) return;
    if (snapshot === null || typeof snapshot !== "object") return;

    if (snapshot.phase === "withdrawn") {
      this.#withdraw(this.#acceptedIdentity !== undefined
        && this.#isOwnConnectionStreamEnd(snapshot, this.#boundConnectionId));
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

    if (this.#restoreMode
      && (this.#restoreConversationId === undefined
        || threadId !== this.#restoreConversationId
        || this.#workspace === undefined)) {
      // A restoring row observes only its exact admitted B, and only where the
      // workspace can be proved. Anything else is never dialed or retained.
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
    const workspace = this.#workspace;
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
        // The SAME observer's own root read corroborates the workspace; no
        // second observer, socket, or bootstrap read exists for the identity.
        ...(workspace === undefined
          ? {}
          : {
              expectedWorkspace: workspace,
              onRootValidated: () => {
                this.#onRootValidated(rootThreadId, epoch);
              },
              onRootContradicted: () => {
                this.#onRootContradicted(rootThreadId, epoch);
              },
              // The SAME validated read that proves the identity also carries the
              // root's actual title: no second read, no second socket, and no
              // separate freshness path.
              onRootTitle: (title) => {
                this.#onRootTitle(rootThreadId, epoch, title);
              },
            }),
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
   * The current observer's own root read positively matched the workspace for
   * the adopted root under every observer fence. Re-checked here against this
   * consumer's own epoch and binding before it becomes identity evidence.
   */
  #onRootValidated(rootThreadId: string, epoch: number): void {
    if (this.#disposed || this.#retired || this.#withdrawn || epoch !== this.#epoch) return;
    if (this.#rpc === undefined || this.#boundRootThreadId !== rootThreadId) return;
    if (this.#restoreMode && rootThreadId !== this.#restoreConversationId) return;
    this.#validatedRootId = rootThreadId;
    this.#reportIdentity();
  }

  /**
   * The current observer's own root read POSITIVELY contradicted the adopted
   * root (another thread's row, or another workspace) under every observer
   * fence. The status axes are already unknown inside the observer; a
   * previously accepted identity is withdrawn explicitly while live.
   */
  #onRootContradicted(rootThreadId: string, epoch: number): void {
    if (this.#disposed || this.#retired || this.#withdrawn || epoch !== this.#epoch) return;
    if (this.#rpc === undefined || this.#boundRootThreadId !== rootThreadId) return;
    this.#validatedRootId = undefined;
    if (this.#acceptedIdentity === undefined) return;
    this.#acceptedIdentity = undefined;
    this.#acceptedTitle = undefined;
    this.#reportIdentityLoss();
  }

  /**
   * The CURRENT observer's own validated root read reported the bound root's actual
   * user-facing title, or positively reported that it has none, under every observer
   * fence. A title is only ever about a conversation this owner already accepted, so
   * nothing is reported before that proof and nothing is reported for a root this
   * consumer never adopted. Unknown — a title the read could not carry — reports
   * nothing at all, which is never the same claim as "no title".
   */
  #onRootTitle(rootThreadId: string, epoch: number, title: string | null): void {
    if (this.#disposed || this.#retired || this.#withdrawn || epoch !== this.#epoch) return;
    if (this.#rpc === undefined || this.#boundRootThreadId !== rootThreadId) return;
    const accepted = this.#acceptedIdentity;
    if (accepted === undefined || accepted !== rootThreadId) return;
    const report = this.#onConversationTitle;
    if (report === undefined) return;
    if (this.#acceptedTitle === title) return;
    let applied = false;
    try {
      applied = report(accepted, title) === true;
    } catch {
      applied = false;
    }
    if (applied) this.#acceptedTitle = title;
  }

  /**
   * The adopted connection's own stream-end evidence (`client-closed` or
   * `backend-closed`, in either socket order), unchanged since. Handshake,
   * overflow, and relay-stopped reasons are never a stream end.
   */
  #isOwnConnectionStreamEnd(
    snapshot: NativeCodexTuiRootFactsSnapshot | undefined,
    connectionId: string | undefined,
  ): boolean {
    return snapshot !== null
      && typeof snapshot === "object"
      && snapshot.phase === "withdrawn"
      && snapshot.withdrawal === "generation-closed"
      && (snapshot.closeReason === "client-closed" || snapshot.closeReason === "backend-closed")
      && connectionId !== undefined
      && snapshot.connectionId === connectionId;
  }

  /** A later source event ended the identity-only hold: a live identity loss. */
  #endCloseHold(): void {
    this.#closeHold = false;
    this.#heldConnectionId = undefined;
    this.#detachFacts();
    if (this.#acceptedIdentity === undefined) return;
    this.#acceptedIdentity = undefined;
    this.#acceptedTitle = undefined;
    this.#reportIdentityLoss();
  }

  /**
   * Report the validated root's exact UUID once it is accepted. A refusal keeps
   * the evidence so the next validated read retries; nothing is queued.
   */
  #reportIdentity(): void {
    const report = this.#onConversationIdentity;
    const conversationId = this.#validatedRootId;
    if (report === undefined || conversationId === undefined) return;
    if (this.#acceptedIdentity === conversationId) return;
    if (!isNativeConversationId(conversationId)) return;
    let accepted = false;
    try {
      accepted = report(conversationId) === true;
    } catch {
      accepted = false;
    }
    if (accepted) {
      // A different accepted conversation is a different subject: the title this
      // consumer last reported describes the previous one and is not carried over.
      if (this.#acceptedIdentity !== conversationId) this.#acceptedTitle = undefined;
      this.#acceptedIdentity = conversationId;
    }
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

  /**
   * Sticky observation withdrawal: close the lane, publish unknown once, and
   * (unless `holdIdentity`) detach and report a held identity's loss. With
   * `holdIdentity` — only for the adopted connection's own stream end
   * (`client-closed` or `backend-closed`) with an accepted identity — the
   * status withdrawal is identical, but the accepted identity and the facts
   * watcher are kept identity-only until a later source event or the owner's
   * retirement.
   */
  #withdraw(holdIdentity = false): void {
    if (this.#withdrawn) return;
    this.#withdrawn = true;
    this.#epoch += 1;
    const hold = holdIdentity && this.#acceptedIdentity !== undefined;
    const lostIdentity = !hold && this.#acceptedIdentity !== undefined;
    if (hold) {
      this.#closeHold = true;
      this.#heldConnectionId = this.#boundConnectionId;
    } else {
      this.#acceptedIdentity = undefined;
      this.#acceptedTitle = undefined;
    }
    this.#validatedRootId = undefined;
    this.#currentTool = undefined;
    this.#boundConnectionId = undefined;
    this.#boundRootThreadId = undefined;
    this.#rootBound = false;
    this.#closeRpc();
    if (!hold) this.#detachFacts();
    // Deliberately NOT a capture invalidation and NOT a manager retirement: the
    // row stays live, its generation stays current, and the backend, the relay,
    // and the interactive child keep running.
    this.#publish(ownedUnknownObservation());
    // A previously accepted identity rested on the source just lost while the
    // run is live: the owner is told explicitly. Missing initial proof is not a
    // loss and reports nothing. Retirement never reaches here.
    if (lostIdentity && !this.#retired && !this.#disposed) this.#reportIdentityLoss();
  }

  #reportIdentityLoss(): void {
    const report = this.#onConversationIdentity;
    if (report === undefined) return;
    try {
      report(null);
    } catch {
      // The owner's refusal or throw cannot affect this consumer.
    }
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
    // Retirement ends an identity-only hold silently: the saved identity stays.
    this.#closeHold = false;
    this.#acceptedTitle = undefined;
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
    this.#closeHold = false;
    this.#acceptedTitle = undefined;
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
