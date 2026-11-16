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
 *   read-only pre-attach loaded-thread census, and the relay's own readiness.
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
 *    or "only loaded thread" is adopted from it;
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
import type { OwnedCodexBackendFactory } from "./instances";
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
  ) => RelayedOwnedCodexPreAttachCensus;
  /** Test seam: the one relay start. Production omits it. */
  readonly startRelay?: (input: NativeCodexTuiRelayInput) => NativeCodexTuiRelayLease;
}

/** Closed composite-only readiness failures. Backend failures keep their code. */
export type NativeCodexOwnedCompositeFailureCode =
  | "backend-ended"
  | "relay-failed"
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
    return new RelayedOwnedCodexBackendLease(backend, request.identity, options, request.signal);
  };
}

class RelayedOwnedCodexBackendLease implements OwnedCodexBackendLease {
  readonly #identity: OwnedCodexBackendLaunchIdentity;
  readonly #backend: OwnedCodexBackendLease;
  readonly #options: RelayedOwnedCodexBackendOptions;
  readonly #facts: NativeCodexTuiRootFactsBinder;
  readonly #factsSource: NativeCodexTuiRootFactsSource;
  readonly #readiness: Promise<OwnedCodexBackendReady>;
  readonly #settlement: Promise<OwnedCodexBackendSettlement>;
  readonly #abortSignal: AbortSignal | undefined;

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
    identity: OwnedCodexBackendLaunchIdentity,
    options: RelayedOwnedCodexBackendOptions,
    signal: AbortSignal | undefined,
  ) {
    this.#identity = Object.freeze({
      leaseId: identity.leaseId,
      generation: identity.generation,
    });
    this.#backend = backend;
    this.#options = options;
    this.#facts = createNativeCodexTuiRootFactsBinder();
    this.#factsSource = Object.freeze({
      current: (): NativeCodexTuiRootFactsSnapshot => this.#facts.current(),
      watch: (listener: (snapshot: NativeCodexTuiRootFactsSnapshot) => void): (() => void) => this.#facts.watch(listener),
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
    // never blocks the native TUI.
    let census: "empty" | "not-empty" | "unavailable";
    try {
      const ids: unknown = await this.#startProbe(backendReady);
      if (!Array.isArray(ids)) census = "unavailable";
      else census = ids.length === 0 ? "empty" : "not-empty";
    } catch {
      census = "unavailable";
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
    });
    this.#readinessState = "fulfilled";
    this.#readinessResolve(ready);
  }

  /* ------------------------------------------------------------ probe */

  #startProbe(backend: OwnedCodexBackendReady): Promise<readonly string[]> {
    const controller = new AbortController();
    this.#probe = controller;
    this.#probeFinished = false;
    this.#probeClosed = false;
    let census: RelayedOwnedCodexPreAttachCensus;
    try {
      const create = this.#options.preAttachCensus ?? createOwnedBackendPreAttachCensus;
      census = create(backend, controller.signal);
    } catch {
      census = {
        threadIds: Promise.reject(new Error("pre-attach census seam threw")),
        closed: Promise.resolve(),
      };
    }
    const threadIds = Promise.resolve(census.threadIds);
    // Readiness progression uses only the result. The close proof is a separate
    // settlement gate, so a slowly closing (or failed) probe cannot block the
    // genuine native TUI, while settlement can never claim a still-open probe.
    void threadIds.then(
      () => this.#finishProbe(),
      () => this.#finishProbe(),
    );
    void threadIds.catch(() => undefined);
    void Promise.resolve(census.closed).then(
      () => this.#closeProbe(),
      // A rejected close proof is not proof: settlement stays pending.
      () => undefined,
    );
    return threadIds;
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
 * backend endpoint. The transport's own handshake/request deadlines bound the
 * whole census, and the socket is closed in `finally` (and on abort).
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
): RelayedOwnedCodexPreAttachCensus {
  let endpoint: NativeCodexRpcEndpoint;
  try {
    endpoint = readNativeCodexOwnedObserverEndpoint(backend);
  } catch (error) {
    // No socket was created, so the close proof is already complete.
    return { threadIds: Promise.reject(error), closed: Promise.resolve() };
  }
  if (signal.aborted) {
    return {
      threadIds: Promise.reject(new Error("pre-attach census aborted")),
      closed: Promise.resolve(),
    };
  }

  let transport: NativeCodexRpcTransport;
  try {
    transport = new NativeCodexRpcTransport({ endpoint });
  } catch (error) {
    // Construction refusal happens before any socket exists.
    return { threadIds: Promise.reject(error), closed: Promise.resolve() };
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

  const threadIds = (async (): Promise<readonly string[]> => {
    try {
      await transport.connect();
      const page = await transport.listLoadedThreadIds();
      if (page.threadIds.length === 0 && page.nextCursor !== null) {
        throw new Error("pre-attach census page is not terminal");
      }
      return page.threadIds;
    } finally {
      signal.removeEventListener("abort", onAbort);
      closeTransport();
    }
  })();
  // The composite observes this rejection; this branch only prevents an
  // unhandled rejection if readiness was already rejected by a stop.
  void threadIds.catch(() => undefined);
  return { threadIds, closed };
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
