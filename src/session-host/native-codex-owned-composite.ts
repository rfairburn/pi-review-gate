/**
 * One synchronous owned Codex composite lease: the actual owned app-server
 * backend plus the private native TUI relay in front of it.
 *
 * This module adds no new factory abstraction, configuration surface, manager,
 * port scan, provider hook, or control path. It decorates an existing
 * {@linkcode OwnedCodexBackendFactory} and answers the exact existing
 * {@linkcode OwnedCodexBackendLease} contract:
 *
 * - `factory(request)` calls the wrapped backend factory SYNCHRONOUSLY and
 *   returns the wrapping lease immediately. The actual backend lease is
 *   therefore retained before anything is awaited, so every stop, retirement,
 *   and settlement path reaches the child the backend factory created.
 * - `status()` is the backend lease's own status verbatim. No relay or probe
 *   fact is allowed to rewrite the backend's process truth.
 * - readiness resolves only after the backend's own readiness, the owner's
 *   read-only pre-attach loaded-thread census (plus, for a restore launch, the
 *   exact saved conversation's admission read), and the relay's own readiness.
 *   A confirmed backend `exitObserved` is never admitted, even while both
 *   captured readers are still draining and settlement is still pending.
 * - the ready value's `endpoint` and `readObserverBearer()` are the ACTUAL
 *   backend's observer lane; `createTuiConnection()` is the ACTUAL relay's TUI
 *   lane, so the genuine TUI's `--remote` names the relay and the observer
 *   still dials the backend.
 * - settlement resolves only after the backend's own proof (genuine exit plus
 *   both captured readers' natural ends), the relay's own real listener/socket
 *   close proof when a relay ever started, and the probe's own actual socket
 *   close proof (not merely an initiated close). It never rejects and never
 *   treats a stop acknowledgement, timer, or stream destroy as proof.
 *
 * ## Ordering that is deliberately strict
 *
 * 1. backend readiness;
 * 2. read-only `initialize` + `thread/loaded/list` against the EXACT backend
 *    endpoint, before the relay is listening and before any TUI exists. An
 *    empty terminal page is the only fresh-backend witness this module can
 *    produce. It is a fact, never a root selection: no thread id, page item,
 *    or "only loaded thread" is adopted from it. A restore launch then reads
 *    exactly its saved conversation on the same connection (admission only;
 *    see "Exact restored conversation admission" below);
 * 3. relay start, synchronously in the same continuation, with the retained
 *    relay lease;
 * 4. relay readiness.
 *
 * A census failure, a non-empty census, or a timeout withdraws only the
 * retained root-facts source; it NEVER prevents the genuine native TUI from
 * starting and it never rejects the composite readiness. The census result and
 * its socket-close proof are separate: readiness uses only the result, while
 * settlement waits for the socket's own close, so a draining probe cannot
 * block native work and a still-open probe can never be claimed settled. A
 * status failure is not a transport failure. A real relay failure is different:
 * a launch whose TUI endpoint did not bind cannot proceed, so both owned
 * resources are asked to stop and readiness rejects with a closed composite
 * error without widening the backend's own failure codes.
 *
 * ## Exact restored conversation admission (restore mode)
 *
 * A launch request carrying `resumeConversationId` B is a RESTORE launch. Fresh
 * launches (no B) are exactly unchanged: `workspace` is ignored for them and a
 * census failure still never blocks their TUI.
 *
 * For a restore launch the retained binder is created with B, and the SAME
 * read-only pre-attach probe, after its loaded-thread census, additionally
 * reads exactly B (`thread/read` with `includeTurns: false`) and compares B's
 * provider cwd with the request's exact workspace at the transport's decode
 * edge. The read is ADMISSION only: it proves that THIS owned backend knows B as
 * a parentless thread of this workspace, it binds nothing, and it never adopts
 * anything from the census, history, or a list. A saved B that is not loaded
 * (`notLoaded`) is the ordinary cold state and is admitted. Only the genuine
 * TUI's own successful resume of B (proved later inside the binder) can name a
 * candidate. The census still decides only the binder's empty-backend witness.
 *
 * A malformed B, a missing workspace, a missing or refused B, an unreadable
 * row, another thread's row, a child row, a different workspace, or any probe
 * failure is a closed `restore-unavailable` readiness failure BEFORE the relay
 * (and therefore any TUI) exists. It uses the existing creation-failure path:
 * both owned resources are asked to stop exactly once, and settlement still
 * waits for the backend's own proof and the probe's own socket-close proof.
 * There is no fresh or picker fallback.
 *
 * ## Stop and settlement algebra
 *
 * `requestStop()` is an idempotent intent latch. It closes this module's own
 * read-only probe connection, requests the backend stop, and requests the relay
 * stop exactly once per resource. It synthesizes no settlement. A backend
 * settlement requests the relay stop; that is what makes a fully owned relay
 * settlement reachable. A late readiness answer, a late relay answer, or a late
 * capability adoption after a stop or after the backend ended starts nothing.
 *
 * The relay's own metadata tap and forwarding are never detached or stopped by
 * a consumer unsubscribing from the exposed root-facts source: the source owns
 * only its watcher registration.
 */

import type {
  OwnedCodexBackendLaunchIdentity,
  OwnedCodexBackendLease,
  OwnedCodexBackendReady,
  OwnedCodexBackendSettlement,
  OwnedCodexBackendStatus,
} from "./native-codex-backend";
import type { OwnedCodexBackendFactory, OwnedCodexBackendLaunchRequest } from "./instances";
import { isNativeConversationId } from "./native-conversation";
import {
  NativeCodexRpcTransport,
  readNativeCodexRpcEndpoint,
  type NativeCodexRpcEndpoint,
} from "./native-codex-rpc";
import {
  startNativeCodexTuiRelay,
  type NativeCodexTuiRelayInput,
  type NativeCodexTuiRelayLease,
  type NativeCodexTuiRelayReadiness,
} from "./native-codex-tui-relay";
import {
  createNativeCodexTuiRootFactsBinder,
  type NativeCodexTuiRootCallbackFactsReader,
  type NativeCodexTuiRootFactsBinder,
  type NativeCodexTuiRootFactsSnapshot,
  type NativeCodexTuiRootFactsSource,
} from "./native-codex-tui-root-facts";

/**
 * The composite decorator's inputs. `backend` is an existing owned backend
 * factory (for example the production owned launcher). The two remaining
 * members are narrow focused-test seams; production omits them and gets the
 * real read-only RPC transport and the real relay.
 */
export interface RelayedOwnedCodexPreAttachCensus {
  /** The loaded-thread census result. Readiness uses only this. */
  readonly threadIds: Promise<readonly string[]>;
  /**
   * Resolves only after the probe's own read-only socket has actually closed
   * (or when no socket was ever opened). Readiness NEVER waits for it; only
   * composite settlement does, so a status read that failed or a socket still
   * draining can never block the genuine native TUI.
   */
  readonly closed: Promise<void>;
  /**
   * Restore mode only: whether THIS backend positively knows the expected
   * conversation as a parentless thread whose provider cwd is the expected
   * workspace. Absent means unproven (a restore is then refused); it is never
   * assumed. Fresh mode ignores it.
   */
  readonly restoredThread?: Promise<boolean>;
}

/**
 * The exact restore expectation handed to the pre-attach probe: the admitted
 * conversation UUID and the row's exact canonical workspace. Owner-private.
 */
export interface RelayedOwnedCodexRestoreExpectation {
  readonly conversationId: string;
  readonly workspace: string;
}

/**
 * The composite decorator's inputs. `backend` is an existing owned backend
 * factory (for example the production owned launcher). The remaining member is
 * a narrow focused-test seam; production omits it and gets the real read-only
 * RPC transport and the real relay.
 */
export interface RelayedOwnedCodexBackendOptions {
  readonly backend: OwnedCodexBackendFactory;
  /**
   * Test seam: the one pre-attach read-only census. Production omits it and
   * gets the existing observer transport's `initialize` + `thread/loaded/list`
   * probe, whose `closed` proof is the underlying socket's own close event.
   */
  readonly preAttachCensus?: (
    backend: OwnedCodexBackendReady,
    signal: AbortSignal,
    restore?: RelayedOwnedCodexRestoreExpectation,
  ) => RelayedOwnedCodexPreAttachCensus;
  /** Test seam: the one relay start. Production omits it. */
  readonly startRelay?: (input: NativeCodexTuiRelayInput) => NativeCodexTuiRelayLease;
}

/** Closed composite-only readiness failures. Backend failures keep their code. */
export type NativeCodexOwnedCompositeFailureCode =
  | "backend-ended"
  | "relay-failed"
  /** Restore mode: the exact saved conversation/workspace was not admitted. */
  | "restore-unavailable"
  | "stopped";

/** A composite failure whose message is its closed code and carries no provider text. */
export class NativeCodexOwnedCompositeError extends Error {
  readonly code: NativeCodexOwnedCompositeFailureCode;

  constructor(code: NativeCodexOwnedCompositeFailureCode) {
    super(`native Codex owned composite readiness failed: ${code}`);
    this.name = "NativeCodexOwnedCompositeError";
    this.code = code;
  }
}

/**
 * Build the composite factory from one existing owned backend factory. The
 * returned value is the exact existing factory type, so an instance manager
 * can substitute it with no manager, plan, argv, environment, or roster change.
 */
export function createRelayedOwnedCodexBackendFactory(
  options: RelayedOwnedCodexBackendOptions,
): OwnedCodexBackendFactory {
  assertCompositeOptions(options);
  return (request) => {
    // The wrapped factory runs synchronously and its exact lease is retained on
    // the wrapper before any await. A throw here happens before this composite
    // owns anything, and propagates unchanged.
    const backend = options.backend(request);
    return new RelayedOwnedCodexBackendLease(backend, request, options);
  };
}

class RelayedOwnedCodexBackendLease implements OwnedCodexBackendLease {
  readonly #identity: OwnedCodexBackendLaunchIdentity;
  readonly #backend: OwnedCodexBackendLease;
  readonly #options: RelayedOwnedCodexBackendOptions;
  readonly #facts: NativeCodexTuiRootFactsBinder;
  readonly #factsSource: NativeCodexTuiRootFactsSource;
  readonly #callbackFactsReader: NativeCodexTuiRootCallbackFactsReader;
  readonly #readiness: Promise<OwnedCodexBackendReady>;
  readonly #settlement: Promise<OwnedCodexBackendSettlement>;
  readonly #abortSignal: AbortSignal | undefined;
  /**
   * Restore launches only: `"admissible"` carries the exact expectation, and
   * `"refused"` means the request already cannot be admitted (malformed B or
   * no workspace). Undefined is a fresh launch, exactly as before.
   */
  readonly #restore:
    | { readonly status: "admissible"; readonly expectation: RelayedOwnedCodexRestoreExpectation }
    | { readonly status: "refused" }
    | undefined;

  #readinessResolve!: (ready: OwnedCodexBackendReady) => void;
  #readinessReject!: (error: unknown) => void;
  #settlementResolve!: (settlement: OwnedCodexBackendSettlement) => void;
  #readinessState: "pending" | "fulfilled" | "rejected" = "pending";
  #settlementState: "pending" | "settled" = "pending";

  #stopRequested = false;
  #backendStopRequested = false;
  #backendSettled = false;
  #backendSettlement: OwnedCodexBackendSettlement | undefined;
  #relay: NativeCodexTuiRelayLease | undefined;
  #relayStopRequested = false;
  #relaySettled = false;
  #relayDeclined = false;
  #probe: AbortController | undefined;
  #probeFinished = true;
  #probeClosed = true;
  #onAbort: (() => void) | undefined;

  constructor(
    backend: OwnedCodexBackendLease,
    request: OwnedCodexBackendLaunchRequest,
    options: RelayedOwnedCodexBackendOptions,
  ) {
    // The backend lease is already retained on this object's caller frame; the
    // first assignment below keeps it before anything else can throw.
    this.#backend = backend;
    const identity = request.identity;
    const signal: AbortSignal | undefined = request.signal;
    this.#identity = Object.freeze({
      leaseId: identity.leaseId,
      generation: identity.generation,
    });
    this.#options = options;
    // Only an admissible restore configures the binder with B. A fresh launch
    // keeps the exact fresh-only binder; a refused restore never reaches a TUI.
    // Nothing here may throw past the retained backend: a binder refusal turns
    // the restore into a refused one instead.
    let restore = readRestoreRequest(request);
    let facts: NativeCodexTuiRootFactsBinder;
    try {
      facts = restore?.status === "admissible"
        ? createNativeCodexTuiRootFactsBinder({ resumeConversationId: restore.expectation.conversationId })
        : createNativeCodexTuiRootFactsBinder();
    } catch {
      restore = Object.freeze({ status: "refused" as const });
      facts = createNativeCodexTuiRootFactsBinder();
    }
    this.#restore = restore;
    this.#facts = facts;
    this.#factsSource = Object.freeze({
      current: (): NativeCodexTuiRootFactsSnapshot => this.#facts.current(),
      watch: (listener: (snapshot: NativeCodexTuiRootFactsSnapshot) => void): (() => void) => this.#facts.watch(listener),
    });
    this.#callbackFactsReader = Object.freeze({
      callbackFacts: () => this.#facts.callbackFacts(),
      // #682: the same retained binder's handshake version read, from the
      // genuine TUI's own initialize response on THIS lease's relay.
      callbackBackendVersion: () => this.#facts.callbackBackendVersion(),
    });
    this.#abortSignal = signal;

    this.#readiness = new Promise<OwnedCodexBackendReady>((resolve, reject) => {
      this.#readinessResolve = resolve;
      this.#readinessReject = reject;
    });
    // The caller is expected to observe readiness. Retaining a failed lease for
    // settlement must not become an unhandled rejection in the meantime.
    void this.#readiness.catch(() => undefined);
    this.#settlement = new Promise<OwnedCodexBackendSettlement>((resolve) => {
      this.#settlementResolve = resolve;
    });

    // Attach to the backend's own settlement BEFORE anything is awaited, so a
    // proven exit that lands while readiness is still racing is never missed.
    // The backend lease contract is "never rejects"; a violating rejection is
    // not proof, so settlement stays pending (fail closed).
    try {
      void this.#backend.settlement.then(
        (settlement) => this.#onBackendSettled(settlement),
        () => undefined,
      );
    } catch {
      // A lease without an observable settlement cannot prove anything. Leave
      // settlement pending rather than inventing an exit.
    }

    if (signal !== undefined) {
      const onAbort = (): void => this.requestStop();
      this.#onAbort = onAbort;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        // Abort before any continuation: nothing is awaited or created.
        this.requestStop();
      }
    }

    void this.#runReadiness().catch(() => {
      // No expected path reaches here; a programming fault must still stop the
      // owned resources and fail the readiness closed.
      this.#relayDeclined = this.#relay === undefined ? true : this.#relayDeclined;
      this.#stopOwnedResources();
      this.#rejectComposite("relay-failed");
    });
    Object.freeze(this);
  }

  get identity(): OwnedCodexBackendLaunchIdentity {
    return this.#identity;
  }

  get readiness(): Promise<OwnedCodexBackendReady> {
    return this.#readiness;
  }

  get settlement(): Promise<OwnedCodexBackendSettlement> {
    return this.#settlement;
  }

  /** The backend lease's own lifecycle facts, verbatim. Never rewritten. */
  status(): OwnedCodexBackendStatus {
    return this.#backend.status();
  }

  requestStop(): void {
    if (this.#stopRequested) return;
    this.#stopRequested = true;
    if (this.#relay === undefined) this.#relayDeclined = true;
    this.#abortProbe();
    if (this.#readinessState === "pending") {
      this.#readinessState = "rejected";
      this.#readinessReject(new NativeCodexOwnedCompositeError("stopped"));
    }
    this.#stopOwnedResources();
    this.#maybeSettle();
  }

  /* ------------------------------------------------------------ readiness */

  async #runReadiness(): Promise<void> {
    let backendReady: OwnedCodexBackendReady;
    try {
      backendReady = await this.#backend.readiness;
    } catch (error) {
      // The backend's own closed failure is propagated unchanged; the composite
      // adds no backend failure code.
      this.#rejectBackend(error);
      return;
    }
    if (this.#readinessState !== "pending") return;
    if (this.#stopRequested) {
      this.#rejectComposite("stopped");
      return;
    }
    if (this.#backendEnded()) {
      this.#rejectComposite("backend-ended");
      return;
    }

    // Pre-attach census: read-only, owned endpoint, no relay and no TUI yet.
    // Its outcome is a fresh-backend witness only; failure withdraws facts and
    // never blocks the native TUI. A restore launch additionally reads exactly
    // its saved conversation in the same probe (admission only, never binding).
    const restore = this.#restore;
    const probe = this.#startProbe(
      backendReady,
      restore?.status === "admissible" ? restore.expectation : undefined,
    );
    let census: "empty" | "not-empty" | "unavailable";
    try {
      const ids: unknown = await probe.threadIds;
      if (!Array.isArray(ids)) census = "unavailable";
      else census = ids.length === 0 ? "empty" : "not-empty";
    } catch {
      census = "unavailable";
    }
    let restoreAdmitted = false;
    if (restore?.status === "admissible") {
      try {
        restoreAdmitted = (await probe.restoredThread) === true;
      } catch {
        restoreAdmitted = false;
      }
    }
    if (census === "empty") this.#facts.attestEmptyBackend();
    else this.#facts.withdraw(census === "not-empty" ? "backend-not-empty" : "backend-attestation-unavailable");

    if (this.#readinessState !== "pending") return;
    if (this.#stopRequested) {
      this.#rejectComposite("stopped");
      return;
    }
    if (this.#backendEnded()) {
      this.#rejectComposite("backend-ended");
      return;
    }
    if (restore !== undefined && !restoreAdmitted) {
      // The exact saved conversation was not admitted on THIS backend. No relay
      // and no TUI exist yet; the existing creation-failure path asks both owned
      // resources to stop, and settlement still waits for their real proofs.
      this.#relayDeclined = true;
      this.#stopOwnedResources();
      this.#rejectComposite("restore-unavailable");
      return;
    }

    // Synchronous retained relay creation in this continuation. Nothing between
    // the fence above and this assignment is awaited.
    const startRelay = this.#options.startRelay ?? startNativeCodexTuiRelay;
    let relay: NativeCodexTuiRelayLease;
    try {
      relay = startRelay({
        backend: backendReady,
        onMetadata: (event) => {
          this.#facts.observe(event);
        },
      });
    } catch {
      // A synchronous relay refusal (invalid owned capability) means no TUI
      // endpoint exists; both owned resources are asked to stop.
      this.#relayDeclined = true;
      this.#stopOwnedResources();
      this.#rejectComposite("relay-failed");
      return;
    }
    this.#relay = relay;
    void relay.settlementPromise.then(
      () => this.#onRelaySettled(),
      () => this.#onRelaySettled(),
    );

    let relayReady: NativeCodexTuiRelayReadiness;
    try {
      relayReady = await relay.readinessPromise;
    } catch {
      if (this.#readinessState !== "pending") return;
      if (this.#stopRequested) this.#rejectComposite("stopped");
      else if (this.#backendEnded()) this.#rejectComposite("backend-ended");
      else this.#rejectComposite("relay-failed");
      this.#stopOwnedResources();
      return;
    }
    if (this.#readinessState !== "pending") return;
    if (this.#stopRequested) {
      this.#stopOwnedResources();
      this.#rejectComposite("stopped");
      return;
    }
    if (this.#backendEnded()) {
      this.#stopOwnedResources();
      this.#rejectComposite("backend-ended");
      return;
    }

    // Dual-lane capability: the observer dials the actual backend; the genuine
    // TUI dials the actual relay. The root-facts source is the composite's own
    // private retained state, not a wire or roster shape.
    const ready: OwnedCodexBackendReady = Object.freeze({
      endpoint: backendReady.endpoint,
      readObserverBearer: (): string => backendReady.readObserverBearer(),
      createTuiConnection: () => relayReady.createTuiConnection(),
      tuiRootFacts: this.#factsSource,
      // #682: the same retained binder's owner-private callback read, apart from
      // the status source (which stays current/watch only).
      tuiRootCallbackFacts: this.#callbackFactsReader,
    });
    this.#readinessState = "fulfilled";
    this.#readinessResolve(ready);
  }

  /* ------------------------------------------------------------ probe */

  #startProbe(
    backend: OwnedCodexBackendReady,
    restore: RelayedOwnedCodexRestoreExpectation | undefined,
  ): { readonly threadIds: Promise<readonly string[]>; readonly restoredThread: Promise<boolean> } {
    const controller = new AbortController();
    this.#probe = controller;
    this.#probeFinished = false;
    this.#probeClosed = false;
    let census: RelayedOwnedCodexPreAttachCensus;
    try {
      const create = this.#options.preAttachCensus ?? createOwnedBackendPreAttachCensus;
      census = restore === undefined
        ? create(backend, controller.signal)
        : create(backend, controller.signal, restore);
    } catch {
      census = {
        threadIds: Promise.reject(new Error("pre-attach census seam threw")),
        closed: Promise.resolve(),
      };
    }
    const threadIds = Promise.resolve(census.threadIds);
    void threadIds.catch(() => undefined);
    // A restore proof the probe did not supply is unproven, never assumed.
    const restoredThread = restore === undefined
      ? Promise.resolve(false)
      : census.restoredThread === undefined
        ? Promise.resolve(false)
        : Promise.resolve(census.restoredThread).then((admitted) => admitted === true, () => false);
    // Readiness progression uses only the results. The close proof is a separate
    // settlement gate, so a slowly closing (or failed) probe cannot block the
    // genuine native TUI, while settlement can never claim a still-open probe.
    void Promise.allSettled([threadIds, restoredThread]).then(() => this.#finishProbe());
    void Promise.resolve(census.closed).then(
      () => this.#closeProbe(),
      // A rejected close proof is not proof: settlement stays pending.
      () => undefined,
    );
    return { threadIds, restoredThread };
  }

  #finishProbe(): void {
    this.#probeFinished = true;
    this.#maybeSettle();
  }

  #closeProbe(): void {
    this.#probeClosed = true;
    this.#maybeSettle();
  }

  #abortProbe(): void {
    const controller = this.#probe;
    if (controller === undefined || controller.signal.aborted) return;
    try {
      controller.abort();
    } catch {
      // An abort listener throw is contained; the probe's own deadlines remain.
    }
  }

  /* ------------------------------------------------------------ stop and settlement */

  #stopOwnedResources(): void {
    this.#abortProbe();
    if (!this.#backendStopRequested) {
      this.#backendStopRequested = true;
      try {
        this.#backend.requestStop();
      } catch {
        // Stop intent is idempotent by contract; a throw here is contained and
        // settlement still requires the backend's own proof.
      }
    }
    this.#stopRelay();
  }

  #stopRelay(): void {
    const relay = this.#relay;
    if (relay === undefined || this.#relayStopRequested) return;
    this.#relayStopRequested = true;
    try {
      relay.requestStop();
    } catch {
      // The relay's own close events still drive its settlement.
    }
  }

  #onBackendSettled(settlement: OwnedCodexBackendSettlement): void {
    if (this.#backendSettled) return;
    this.#backendSettled = true;
    this.#backendSettlement = settlement;
    // A proven backend exit makes the relay unreachable for its purpose, and
    // its own real close proof is part of this composite's settlement. This is
    // the ONLY place the backend settlement crosses into relay authority.
    this.#abortProbe();
    if (this.#relay === undefined) this.#relayDeclined = true;
    this.#stopRelay();
    this.#maybeSettle();
  }

  #onRelaySettled(): void {
    if (this.#relaySettled) return;
    this.#relaySettled = true;
    this.#maybeSettle();
  }

  #maybeSettle(): void {
    if (this.#settlementState !== "pending") return;
    if (!this.#backendSettled) return;
    if (!this.#probeFinished) return;
    if (!this.#probeClosed) return;
    if (this.#relay === undefined) {
      // Settlement may resolve only once no relay can ever be created.
      if (!this.#relayDeclined) return;
    } else if (!this.#relaySettled) {
      return;
    }
    const proof = this.#backendSettlement;
    if (proof === undefined) return;
    this.#settlementState = "settled";
    this.#removeAbortListener();
    this.#settlementResolve(proof);
  }

  #backendEnded(): boolean {
    if (this.#backendSettled) return true;
    try {
      // The backend's own synchronous state is already settled before its
      // promise reaction runs, so this closes the last interleaving window
      // between an awaited continuation and a queued settlement callback.
      const status = this.#backend.status();
      // A genuine exit is already fatal to TUI admission while both captured
      // readers are still draining and settlement is therefore still pending.
      return status.settled === true || status.exitObserved === true;
    } catch {
      return true;
    }
  }

  #rejectComposite(code: NativeCodexOwnedCompositeFailureCode): void {
    if (this.#readinessState !== "pending") return;
    this.#readinessState = "rejected";
    if (this.#relay === undefined) this.#relayDeclined = true;
    this.#abortProbe();
    this.#maybeSettle();
    this.#readinessReject(new NativeCodexOwnedCompositeError(code));
  }

  #rejectBackend(error: unknown): void {
    if (this.#readinessState !== "pending") return;
    this.#readinessState = "rejected";
    if (this.#relay === undefined) this.#relayDeclined = true;
    this.#abortProbe();
    this.#maybeSettle();
    this.#readinessReject(error);
  }

  #removeAbortListener(): void {
    const signal = this.#abortSignal;
    const onAbort = this.#onAbort;
    if (signal === undefined || onAbort === undefined) return;
    signal.removeEventListener("abort", onAbort);
    this.#onAbort = undefined;
  }
}

/**
 * The production pre-attach census: the existing read-only observer transport's
 * `initialize` plus ONE `thread/loaded/list` page against the exact owned
 * backend endpoint (plus, for a restore launch, ONE `thread/read` of exactly the
 * saved conversation after it, on the same connection). The transport's own
 * handshake/request deadlines bound the whole probe, and the socket is closed
 * once every read it made has settled (and on abort).
 *
 * `closed` is a distinct proof from the census result: it is the transport's
 * own `socketClosed` promise, which settles only on the underlying WebSocket's
 * real `close` event (or a positively never-opened, irreversibly disposed
 * case), not when `close()` merely initiates an asynchronous WebSocket close.
 * Readiness uses only `threadIds`; settlement waits for `closed`.
 *
 * A nonempty page is returned as-is (the caller withdraws the fresh source), and
 * an empty first page with a further cursor is NOT proof of emptiness, so the
 * probe fails closed instead of walking an unbounded page space or adopting a
 * loaded thread.
 */
function createOwnedBackendPreAttachCensus(
  backend: OwnedCodexBackendReady,
  signal: AbortSignal,
  restore?: RelayedOwnedCodexRestoreExpectation,
): RelayedOwnedCodexPreAttachCensus {
  const refused = (error: unknown): RelayedOwnedCodexPreAttachCensus => ({
    threadIds: Promise.reject(error),
    closed: Promise.resolve(),
    ...(restore === undefined ? {} : { restoredThread: Promise.resolve(false) }),
  });
  let endpoint: NativeCodexRpcEndpoint;
  try {
    endpoint = readNativeCodexOwnedObserverEndpoint(backend);
  } catch (error) {
    // No socket was created, so the close proof is already complete.
    return refused(error);
  }
  if (signal.aborted) {
    return refused(new Error("pre-attach census aborted"));
  }

  let transport: NativeCodexRpcTransport;
  try {
    transport = new NativeCodexRpcTransport({ endpoint });
  } catch (error) {
    // Construction refusal happens before any socket exists.
    return refused(error);
  }
  // The transport's own physical-close proof, retained for the whole probe
  // lifetime and independent of the census result. `close()` below only
  // initiates the close; this promise resolves from the actual WebSocket
  // `close` event (or the positively never-opened disposal case).
  const closed = transport.socketClosed;
  const closeTransport = (): void => {
    try {
      transport.close();
    } catch {
      // Closing is an intentional probe action; its failure is not a native
      // lease fact. A failed close leaves `closed` pending (fail closed).
    }
  };
  const onAbort = (): void => closeTransport();
  signal.addEventListener("abort", onAbort, { once: true });

  const connected = transport.connect();
  void connected.catch(() => undefined);
  const threadIds = (async (): Promise<readonly string[]> => {
    await connected;
    const page = await transport.listLoadedThreadIds();
    if (page.threadIds.length === 0 && page.nextCursor !== null) {
      throw new Error("pre-attach census page is not terminal");
    }
    return page.threadIds;
  })();
  // The composite observes this rejection; this branch only prevents an
  // unhandled rejection if readiness was already rejected by a stop.
  void threadIds.catch(() => undefined);

  // Restore admission runs strictly AFTER the census on the same connection, so
  // reading B can never make the census itself observe a loaded thread. It is
  // the exact known B only: no list, no history, no other thread.
  const restoredThread = restore === undefined
    ? undefined
    : threadIds.then(() => undefined, () => undefined).then(async (): Promise<boolean> => {
        await connected;
        const read = await transport.readThreadInWorkspace(restore.conversationId, restore.workspace);
        return read !== null
          && read.row.threadId === restore.conversationId
          && read.row.parentThreadId === null
          && read.workspaceMatches;
      }).catch(() => false);

  // One close for the whole probe, after every read it makes has settled (or
  // on abort, which rejects whatever is still pending).
  void Promise.allSettled([threadIds, restoredThread ?? Promise.resolve(false)]).then(() => {
    signal.removeEventListener("abort", onAbort);
    closeTransport();
  });
  return { threadIds, closed, ...(restoredThread === undefined ? {} : { restoredThread }) };
}

/**
 * Read the restore expectation off one launch request. Fresh requests (no
 * `resumeConversationId`) answer undefined and keep the exact fresh behavior;
 * `workspace` alone never makes a launch a restore. A restore whose B is not one
 * exact provider UUID, or which carries no usable workspace, is refused here so
 * it can never reach a TUI.
 */
function readRestoreRequest(
  request: OwnedCodexBackendLaunchRequest,
):
  | { readonly status: "admissible"; readonly expectation: RelayedOwnedCodexRestoreExpectation }
  | { readonly status: "refused" }
  | undefined {
  const conversationId: unknown = request.resumeConversationId;
  if (conversationId === undefined) return undefined;
  const workspace: unknown = request.workspace;
  if (!isNativeConversationId(conversationId) || typeof workspace !== "string" || workspace.length === 0) {
    return Object.freeze({ status: "refused" as const });
  }
  return Object.freeze({
    status: "admissible" as const,
    expectation: Object.freeze({ conversationId, workspace }),
  });
}

/**
 * Derive the existing observer endpoint from the lease's own banner endpoint.
 *
 * Exported because the host's owned status reader needs the SAME certified
 * grammar for the SAME private capability: the banner string is validated here
 * (numeric IPv4 loopback `ws:`, no credentials, no query, no fragment, no path)
 * and the bearer is reached only through the lease's accessor. A second copy of
 * this parsing would be a second URL grammar with its own SSRF surface.
 */
export function readNativeCodexOwnedObserverEndpoint(
  backend: Pick<OwnedCodexBackendReady, "endpoint" | "readObserverBearer">,
): NativeCodexRpcEndpoint {
  let url: URL;
  try {
    url = new URL(backend.endpoint);
  } catch {
    throw new Error("owned Codex backend endpoint is not a URL");
  }
  if (
    url.protocol !== "ws:"
    || url.hostname !== "127.0.0.1"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("owned Codex backend endpoint is not a private loopback WebSocket");
  }
  const port = Number(url.port);
  const read = readNativeCodexRpcEndpoint({
    kind: "loopback-ws",
    host: "127.0.0.1",
    port,
    authorization: { scheme: "bearer", token: () => backend.readObserverBearer() },
  });
  if (read.status !== "valid") {
    throw new Error("owned Codex backend endpoint is not usable for the pre-attach census");
  }
  return read.endpoint;
}

function assertCompositeOptions(options: RelayedOwnedCodexBackendOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("relayed owned Codex options must be an object");
  }
  if (typeof options.backend !== "function") {
    throw new TypeError("relayed owned Codex options.backend must be a function");
  }
  if (options.preAttachCensus !== undefined && typeof options.preAttachCensus !== "function") {
    throw new TypeError("relayed owned Codex options.preAttachCensus must be a function");
  }
  if (options.startRelay !== undefined && typeof options.startRelay !== "function") {
    throw new TypeError("relayed owned Codex options.startRelay must be a function");
  }
}
