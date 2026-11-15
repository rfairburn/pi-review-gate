/**
 * Owned, authenticated, ephemeral Codex app-server backend lease.
 *
 * The caller owns process creation and termination through the injected seams,
 * and binds the genuine native TUI and its read-only observer to this lease's
 * private endpoint.
 *
 * One launch owns exactly one app-server child and exactly one fresh
 * capability token. The child receives only the SHA-256 digest of that token in
 * its owner-generated arguments; the plaintext bearer never enters the
 * backend's argv, backend environment, or a file. The bearer is reachable only
 * through the private accessor on a fulfilled readiness value:
 *
 * - `readObserverBearer()` returns the observer token.
 * - `createTuiConnection()` returns a fresh child-only environment clone with
 *   the bearer in a reserved variable name plus the native TUI remote
 *   arguments. That material is sensitive and must not be logged or stored.
 *
 * The backend listens on the exact ephemeral loopback endpoint it prints in
 * its own recognized readiness banner (`codex app-server (WebSockets)`, then
 * `listening on: ws://127.0.0.1:<nonzero port>`, `readyz:`, `healthz:`, and
 * `note:`); this module never scans a port, adopts another server, or falls
 * back to an unauthenticated or shared daemon. A bounded record is accumulated
 * only until that complete banner is recognized or rejected. Arbitrary URL
 * mentions do not count as readiness.
 *
 * ## Spawn and termination seams
 *
 * `spawnBackend(controlArgs, env)` must synchronously return the real Node
 * `ChildProcess` it created, with both stdio pipes available. It must either
 * return that exact handle or throw only when no child was created; a child
 * created and then hidden by a throw cannot be proven abandoned. Events are
 * expected to be emitted after the handle is returned, as Node does.
 *
 * `terminateOwnedBackend(child)` is the caller's platform-owned exact child or
 * tree termination. It receives the same captured handle and is invoked at
 * most once, and only while a genuine `exit` event has not been observed. It
 * must resolve/return normally on success and throw/reject on failure. This
 * module never signals a PID, scans process names, or kills the child itself.
 *
 * ## Settlement
 *
 * For a created child, positive settlement requires a genuine child `exit`
 * event AND both captured stdout/stderr readers reaching natural
 * end-of-stream. A close event, a stop acknowledgement, an undefined `exitCode`
 * property, a stream's `destroyed` flag, listener removal, or a timeout is
 * never proof. If no child was created (a spawn throw or a pre-aborted
 * launch), settlement reports proven abandonment immediately. If the spawn
 * seam returned a handle whose `error` arrived before any successful `spawn`
 * event and before any stop/termination attempt, that is a positively
 * witnessed pre-spawn failure: settlement reports `not-created` only after the
 * captured readers complete or close, and no termination is requested.
 * Readiness rejection is never settlement: an owned child can outlive a rejected
 * readiness value, and the caller retains the lease until positive settlement.
 *
 * An `error` event after a successful `spawn` is never abandonment; it still
 * requires the exact child's exit. A stream close without a natural end is not
 * ordinary reader settlement, though it can close a proven never-created
 * child's captured readers. Late banner data after a failure, stop, abort,
 * deadline, or exit cannot make readiness succeed again.
 *
 * The repository's generic bounded child-close helper is deliberately not
 * reused for this proof: its timeout path destroys local pipe handles and its
 * close observation is not per-captured-reader completion. This module keeps
 * the exact captured readers' natural `end` events as the only reader proof
 * for a created child, and their complete/closed state for a proven
 * never-created child.
 */

import { createHash, randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** Reserved per-lease TUI auth environment name prefix. */
export const NATIVE_CODEX_BACKEND_AUTH_ENV_PREFIX = "PI_REVIEW_GATE_OWNED_CODEX_RPC_";
/** Bounded raw banner bytes retained per captured reader while recognizing the readiness record. */
export const NATIVE_CODEX_BACKEND_MAX_BANNER_BYTES = 8 * 1024;
/** Default readiness deadline when the caller does not supply one. */
export const NATIVE_CODEX_BACKEND_DEFAULT_STARTUP_TIMEOUT_MS = 15_000;

const WS_SCHEME = "ws://";
const LISTEN_URL = "ws://127.0.0.1:0";
const AUTH_ENV_NAME_ATTEMPTS = 32;
const READINESS_BANNER_TITLE = "codex app-server (WebSockets)";
const READINESS_LISTEN_PREFIX = "listening on:";
const READINESS_READY_PREFIX = "readyz:";
const READINESS_HEALTH_PREFIX = "healthz:";
const READINESS_NOTE_PREFIX = "note:";

/** Fixed, sanitized readiness outcomes; provider output never enters these. */
export type OwnedCodexBackendFailureCode =
  | "aborted"
  | "auth-env-unavailable"
  | "banner-invalid"
  | "banner-oversize"
  | "child-error"
  | "child-exited"
  | "endpoint-ambiguous"
  | "endpoint-invalid"
  | "endpoint-non-loopback"
  | "endpoint-not-observed"
  | "reader-closed"
  | "reader-error"
  | "spawn-failed"
  | "spawn-invalid"
  | "startup-timeout"
  | "stopped"
  | "stream-unavailable";

/** One immutable launch identity copied from the caller's input. */
export interface OwnedCodexBackendLaunchIdentity {
  readonly leaseId: string;
  readonly generation: number;
}

/** A read-only observation of this lease's confirmed lifecycle facts. */
export interface OwnedCodexBackendStatus {
  readonly identity: OwnedCodexBackendLaunchIdentity;
  readonly phase: "starting" | "ready" | "stopping" | "exited" | "failed" | "settled";
  /** True only after this exact child's bounded banner produced a valid endpoint. */
  readonly ready: boolean;
  readonly readinessFailure: OwnedCodexBackendFailureCode | undefined;
  readonly stopRequested: boolean;
  readonly childWitnessed: boolean;
  /** True only after this exact child's own `spawn` event fired. */
  readonly spawnObserved: boolean;
  /** True only after a positively witnessed pre-spawn failure (error before spawn, no prior stop attempt). */
  readonly spawnFailureObserved: boolean;
  /** True only after this exact child's own `exit` event fired. */
  readonly exitObserved: boolean;
  /** True only after the captured stdout reader reached natural end-of-stream. */
  readonly stdoutEnded: boolean;
  /** True only after the captured stderr reader reached natural end-of-stream. */
  readonly stderrEnded: boolean;
  readonly settled: boolean;
  readonly terminationAttempted: boolean;
  readonly terminationFailed: boolean;
  readonly childErrorObserved: boolean;
  readonly readerErrorObserved: boolean;
}

/**
 * Child-only native TUI connection material. The environment contains the
 * plaintext bearer and is intentionally only obtainable through the explicit
 * readiness accessor.
 */
export interface OwnedCodexTuiConnection {
  readonly endpoint: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Fulfilled readiness value: exact endpoint plus private auth accessors. */
export interface OwnedCodexBackendReady {
  readonly endpoint: string;
  /** Sensitive: returns the observer bearer. Do not log or persist it. */
  readObserverBearer(): string;
  /** Sensitive: builds a fresh child-only TUI env/argument set. */
  createTuiConnection(): OwnedCodexTuiConnection;
}

/**
 * Positive settlement proof. The `not-created` variant is used when the spawn
 * seam threw before returning a child, a pre-aborted launch never spawned, or
 * a returned handle emitted `error` before any successful `spawn` event and
 * before any stop/termination attempt, then its captured readers completed or
 * closed.
 */
export type OwnedCodexBackendSettlement =
  | {
      readonly status: "settled";
      readonly child: "exited";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stdout: "ended";
      readonly stderr: "ended";
    }
  | { readonly status: "settled"; readonly child: "not-created" };

/** Narrow injected seams; the caller owns executable resolution and process control. */
export interface OwnedCodexBackendLaunchInput {
  readonly identity: OwnedCodexBackendLaunchIdentity;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly spawnBackend: (controlArgs: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;
  readonly terminateOwnedBackend: (child: ChildProcess) => unknown;
  readonly startupTimeoutMs?: number;
  /** Aborting (including generation retirement) cancels startup and requests the exact owned stop while unsettled. */
  readonly signal?: AbortSignal;
}

/** One owned backend process resource. */
export interface OwnedCodexBackendLease {
  readonly identity: OwnedCodexBackendLaunchIdentity;
  readonly readiness: Promise<OwnedCodexBackendReady>;
  /** Never rejects; remains pending until positive settlement is proven. */
  readonly settlement: Promise<OwnedCodexBackendSettlement>;
  status(): OwnedCodexBackendStatus;
  /** Idempotent. Repeated calls never signal a second time or after a confirmed exit. */
  requestStop(): void;
}

/** Sanitized readiness failure with a fixed code and no captured provider text. */
export class OwnedCodexBackendReadinessError extends Error {
  readonly code: OwnedCodexBackendFailureCode;

  constructor(code: OwnedCodexBackendFailureCode) {
    super(`owned Codex backend readiness failed: ${code}`);
    this.name = "OwnedCodexBackendReadinessError";
    this.code = code;
  }
}

/**
 * Launch one owned backend and return its lease synchronously. Invalid seam
 * arguments are programming errors and throw before any spawn; a spawn throw
 * is represented by a rejected readiness value plus positive abandonment
 * settlement on the returned lease.
 */
export function launchOwnedCodexBackend(input: OwnedCodexBackendLaunchInput): OwnedCodexBackendLease {
  assertLaunchInput(input);
  return new OwnedCodexBackendLeaseImpl(input);
}

class OwnedCodexBackendLeaseImpl implements OwnedCodexBackendLease {
  readonly #identity: OwnedCodexBackendLaunchIdentity;
  readonly #baseEnv: Readonly<Record<string, string | undefined>>;
  readonly #spawnBackend: OwnedCodexBackendLaunchInput["spawnBackend"];
  readonly #terminateOwnedBackend: OwnedCodexBackendLaunchInput["terminateOwnedBackend"];
  readonly #startupTimeoutMs: number;
  readonly #readiness: Promise<OwnedCodexBackendReady>;
  readonly #settlement: Promise<OwnedCodexBackendSettlement>;
  readonly #abortSignal: AbortSignal | undefined;

  #readinessResolve!: (ready: OwnedCodexBackendReady) => void;
  #readinessReject!: (error: Error) => void;
  #settlementResolve!: (settlement: OwnedCodexBackendSettlement) => void;
  #readinessState: "pending" | "fulfilled" | "rejected" = "pending";
  #readinessFailure: OwnedCodexBackendFailureCode | undefined;
  #settlementState: "pending" | "settled" = "pending";

  #child: ChildProcess | undefined;
  #childWitnessed = false;
  #spawnObserved = false;
  #spawnFailureObserved = false;
  #stdout: ReaderWitness | undefined;
  #stderr: ReaderWitness | undefined;
  #exitObserved = false;
  #exitCode: number | null = null;
  #exitSignal: NodeJS.Signals | null = null;
  #stopRequested = false;
  #terminationAttempted = false;
  #terminationFailed = false;
  #childErrorObserved = false;
  #startupTimer: NodeJS.Timeout | undefined;
  #onAbort: (() => void) | undefined;

  #token: string | undefined;
  #authEnvName: string | undefined;

  constructor(input: OwnedCodexBackendLaunchInput) {
    this.#identity = Object.freeze({
      leaseId: input.identity.leaseId,
      generation: input.identity.generation,
    });
    // The operator environment is retained unchanged, but as a private clone:
    // neither the caller's object nor the parent process environment is mutated.
    this.#baseEnv = Object.freeze({ ...input.baseEnv });
    this.#spawnBackend = input.spawnBackend;
    this.#terminateOwnedBackend = input.terminateOwnedBackend;
    this.#startupTimeoutMs = input.startupTimeoutMs ?? NATIVE_CODEX_BACKEND_DEFAULT_STARTUP_TIMEOUT_MS;
    this.#abortSignal = input.signal;

    this.#readiness = new Promise<OwnedCodexBackendReady>((resolve, reject) => {
      this.#readinessResolve = resolve;
      this.#readinessReject = reject;
    });
    // The caller is expected to observe readiness. Attaching an internal
    // handler keeps an intentionally retained failed lease from becoming an
    // unhandled rejection in the meantime.
    void this.#readiness.catch(() => undefined);
    this.#settlement = new Promise<OwnedCodexBackendSettlement>((resolve) => {
      this.#settlementResolve = resolve;
    });

    if (this.#abortSignal !== undefined) {
      const onAbort = (): void => {
        this.#abortReadiness("aborted");
      };
      this.#onAbort = onAbort;
      this.#abortSignal.addEventListener("abort", onAbort, { once: true });
      if (this.#abortSignal.aborted) {
        // Cancellation before spawn is proven abandonment: no child exists.
        this.#stopRequested = true;
        this.#rejectReadiness("aborted");
        this.#resolveAbandonedSettlement();
        Object.freeze(this);
        return;
      }
    }

    this.#start();
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

  status(): OwnedCodexBackendStatus {
    const stdoutEnded = this.#stdout?.ended === true;
    const stderrEnded = this.#stderr?.ended === true;
    return Object.freeze({
      identity: this.#identity,
      phase: this.#phase(),
      ready: this.#readinessState === "fulfilled",
      readinessFailure: this.#readinessFailure,
      stopRequested: this.#stopRequested,
      childWitnessed: this.#childWitnessed,
      spawnObserved: this.#spawnObserved,
      spawnFailureObserved: this.#spawnFailureObserved,
      exitObserved: this.#exitObserved,
      stdoutEnded,
      stderrEnded,
      settled: this.#settlementState === "settled",
      terminationAttempted: this.#terminationAttempted,
      terminationFailed: this.#terminationFailed,
      childErrorObserved: this.#childErrorObserved,
      readerErrorObserved: (this.#stdout?.errored ?? false) || (this.#stderr?.errored ?? false),
    });
  }

  requestStop(): void {
    this.#abortReadiness("stopped");
  }

  #phase(): OwnedCodexBackendStatus["phase"] {
    if (this.#settlementState === "settled") return "settled";
    if (this.#readinessState === "pending") return "starting";
    if (this.#readinessState === "rejected") return "failed";
    if (this.#exitObserved) return "exited";
    if (this.#stopRequested) return "stopping";
    return "ready";
  }

  #start(): void {
    // Fresh 32-byte bearer per lease. The backend receives only its SHA-256
    // digest, over the literal UTF-8 token, in the owner-generated argv.
    const token = randomBytes(32).toString("base64url");
    this.#token = token;
    const digest = createHash("sha256").update(token, "utf8").digest("hex");

    let authEnvName: string;
    try {
      authEnvName = chooseAuthEnvName(this.#baseEnv);
    } catch {
      this.#rejectReadiness("auth-env-unavailable");
      this.#resolveAbandonedSettlement();
      return;
    }
    this.#authEnvName = authEnvName;

    const controlArgs = Object.freeze([
      "app-server",
      "--listen", LISTEN_URL,
      "--ws-auth", "capability-token",
      "--ws-token-sha256", digest,
    ]);
    // The backend environment is the operator environment unchanged. In
    // particular it does not gain the TUI-only bearer variable.
    const backendEnv: NodeJS.ProcessEnv = { ...this.#baseEnv };

    let spawned: unknown;
    try {
      spawned = this.#spawnBackend(controlArgs, backendEnv);
    } catch {
      // The seam contract guarantees a throw means no child was created.
      this.#rejectReadiness("spawn-failed");
      this.#resolveAbandonedSettlement();
      return;
    }

    let childLike = false;
    try {
      childLike = isChildProcessLike(spawned);
    } catch {
      childLike = false;
    }
    if (!childLike) {
      // A replaced or foreign value cannot be adopted, and it does not prove
      // that no child exists, so settlement stays pending (fail closed).
      this.#rejectReadiness("spawn-invalid");
      return;
    }

    const child = spawned as ChildProcess;
    this.#child = child;
    this.#childWitnessed = true;

    try {
      this.#captureChild(child);
    } catch {
      this.#abortReadiness("stream-unavailable");
      return;
    }

    // An abort can land synchronously inside the spawn seam before the exact
    // child is captured. Now that the handle is retained, request its stop.
    if (this.#stopRequested) {
      this.#requestStopInternal();
    }

    if (this.#readinessState === "pending" && !this.#stopRequested && !this.#exitObserved) {
      this.#startStartupTimer();
    }
  }

  #captureChild(child: ChildProcess): void {
    // Observe the exact handle's own lifecycle before touching stdio, so a
    // stream accessor failure still leaves genuine spawn/exit evidence.
    child.on("spawn", this.#handleChildSpawn);
    child.on("exit", this.#handleChildExit);
    child.on("error", this.#handleChildError);

    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!isReadableLike(stdout) || !isReadableLike(stderr)) {
      throw new Error("captured stdio readers unavailable");
    }

    this.#stdout = new ReaderWitness(stdout, {
      onEndpoint: this.#handleEndpoint,
      onFailure: this.#handleReaderFailure,
      onEnded: this.#handleReaderEnded,
    });
    this.#stderr = new ReaderWitness(stderr, {
      onEndpoint: this.#handleEndpoint,
      onFailure: this.#handleReaderFailure,
      onEnded: this.#handleReaderEnded,
    });
    this.#stdout.initialize();
    this.#stderr.initialize();
  }

  #startStartupTimer(): void {
    this.#clearStartupTimer();
    const timer = setTimeout(() => {
      this.#startupTimer = undefined;
      if (this.#readinessState !== "pending") return;
      this.#abortReadiness("startup-timeout");
    }, this.#startupTimeoutMs);
    timer.unref?.();
    this.#startupTimer = timer;
  }

  #clearStartupTimer(): void {
    if (this.#startupTimer === undefined) return;
    clearTimeout(this.#startupTimer);
    this.#startupTimer = undefined;
  }

  #rejectReadiness(code: OwnedCodexBackendFailureCode): void {
    if (this.#readinessState !== "pending") return;
    this.#readinessState = "rejected";
    this.#readinessFailure = code;
    // No readiness value can consume the bearer after a rejection. Drop the
    // lease's private copy; the caller retains only the unsettled child.
    this.#token = undefined;
    this.#authEnvName = undefined;
    this.#clearStartupTimer();
    this.#disarmBanner();
    this.#readinessReject(new OwnedCodexBackendReadinessError(code));
  }

  #abortReadiness(code: OwnedCodexBackendFailureCode): void {
    this.#rejectReadiness(code);
    this.#requestStopInternal();
  }

  #requestStopInternal(): void {
    // A positively witnessed pre-spawn failure means no process exists. Never
    // record a stop intent or call the termination seam for that handle.
    if (this.#isProvenNeverCreated()) return;
    this.#stopRequested = true;
    const child = this.#child;
    // Never signal after a genuine exit, and never repeat a termination
    // attempt. An unconfirmed stop remains visible as unsettled.
    if (child === undefined || this.#exitObserved || this.#terminationAttempted) return;
    this.#terminationAttempted = true;
    let result: unknown;
    try {
      result = this.#terminateOwnedBackend(child);
    } catch {
      this.#terminationFailed = true;
      return;
    }
    if (isThenable(result)) {
      Promise.resolve(result).catch(() => {
        this.#terminationFailed = true;
      });
    }
  }

  #handleChildSpawn = (): void => {
    this.#spawnObserved = true;
  };

  #handleChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (this.#exitObserved) return;
    this.#exitObserved = true;
    this.#exitCode = typeof code === "number" ? code : null;
    this.#exitSignal = typeof signal === "string" ? signal : null;
    if (this.#readinessState === "pending") {
      // The process ended before it produced a usable endpoint. Genuine exit
      // is observed, but readiness is not settlement.
      this.#abortReadiness("child-exited");
    }
    this.#maybeSettle();
  };

  #handleChildError = (): void => {
    // Node reports a failed exec (ENOENT/EACCES) as `error` before any
    // `spawn` event, followed by stdio closure and no `exit`. That is positive
    // evidence the process was never created. Any error after `spawn` remains
    // a normal post-spawn child error with the exit requirement intact.
    if (
      !this.#spawnObserved
      && !this.#exitObserved
      && !this.#stopRequested
      && !this.#terminationAttempted
    ) {
      if (this.#spawnFailureObserved) return;
      this.#spawnFailureObserved = true;
      this.#childErrorObserved = true;
      this.#rejectReadiness("spawn-failed");
      this.#maybeSettle();
      return;
    }
    if (this.#childErrorObserved) return;
    // Error contents are deliberately not captured or surfaced.
    this.#childErrorObserved = true;
    this.#abortReadiness("child-error");
  };

  #handleReaderFailure = (code: OwnedCodexBackendFailureCode): void => {
    this.#abortReadiness(code);
    this.#maybeSettle();
  };

  #handleReaderEnded = (): void => {
    if (this.#readinessState === "pending" && this.#stdout?.ended === true && this.#stderr?.ended === true) {
      this.#abortReadiness("endpoint-not-observed");
    }
    this.#maybeSettle();
  };

  #handleEndpoint = (endpoint: string): void => {
    if (this.#readinessState !== "pending") return;
    if (this.#stopRequested || this.#exitObserved) return;
    const verdict: ReturnType<typeof validateLoopbackAuthority> = endpoint.startsWith(WS_SCHEME)
      ? validateLoopbackAuthority(endpoint.slice(WS_SCHEME.length))
      : "endpoint-invalid";
    if (verdict !== "ok") {
      this.#abortReadiness(verdict);
      return;
    }
    const token = this.#token;
    const authEnvName = this.#authEnvName;
    if (token === undefined || authEnvName === undefined) {
      this.#abortReadiness("endpoint-invalid");
      return;
    }
    const ready = new ReadyConnection(endpoint, token, authEnvName, this.#baseEnv);
    this.#readinessState = "fulfilled";
    this.#clearStartupTimer();
    this.#disarmBanner();
    // The ready value owns the bearer from here; the lease no longer needs a
    // duplicate private copy.
    this.#token = undefined;
    this.#authEnvName = undefined;
    this.#readinessResolve(ready);
  };

  #maybeSettle(): void {
    if (this.#settlementState !== "pending") return;
    if (this.#isProvenNeverCreated()) {
      if (this.#readersSettledForAbandonment()) this.#finalizeNotCreatedSettlement();
      return;
    }
    if (!this.#childWitnessed || !this.#exitObserved) return;
    if (this.#stdout?.ended !== true || this.#stderr?.ended !== true) return;
    this.#settlementState = "settled";
    const result: OwnedCodexBackendSettlement = Object.freeze({
      status: "settled" as const,
      child: "exited" as const,
      code: this.#exitCode,
      signal: this.#exitSignal,
      stdout: "ended" as const,
      stderr: "ended" as const,
    });
    try {
      this.#cleanupAfterSettlement();
    } catch {
      // The proof above is already complete; best-effort listener cleanup must
      // not erase it.
    }
    this.#settlementResolve(result);
  }

  #resolveAbandonedSettlement(): void {
    if (this.#settlementState !== "pending" || this.#childWitnessed) return;
    this.#finalizeNotCreatedSettlement();
  }

  #finalizeNotCreatedSettlement(): void {
    if (this.#settlementState !== "pending") return;
    this.#settlementState = "settled";
    try {
      this.#cleanupAfterSettlement();
    } catch {
      // No process was created; proof stands regardless of cleanup.
    }
    const settlement: OwnedCodexBackendSettlement = Object.freeze({
      status: "settled" as const,
      child: "not-created" as const,
    });
    this.#settlementResolve(settlement);
  }

  #isProvenNeverCreated(): boolean {
    return this.#spawnFailureObserved
      && !this.#spawnObserved
      && !this.#exitObserved
      && !this.#stopRequested
      && !this.#terminationAttempted;
  }

  #readersSettledForAbandonment(): boolean {
    return this.#stdout?.settled === true && this.#stderr?.settled === true;
  }

  #cleanupAfterSettlement(): void {
    this.#clearStartupTimer();
    this.#disarmBanner();
    this.#removeAbortListener();
    const child = this.#child;
    if (child !== undefined) {
      child.removeListener("spawn", this.#handleChildSpawn);
      child.removeListener("exit", this.#handleChildExit);
      child.removeListener("error", this.#handleChildError);
    }
    this.#stdout?.dispose();
    this.#stderr?.dispose();
  }

  #removeAbortListener(): void {
    const signal = this.#abortSignal;
    const onAbort = this.#onAbort;
    if (signal === undefined || onAbort === undefined) return;
    signal.removeEventListener("abort", onAbort);
    this.#onAbort = undefined;
  }

  #disarmBanner(): void {
    this.#stdout?.disarm();
    this.#stderr?.disarm();
  }
}

class ReadyConnection implements OwnedCodexBackendReady {
  readonly #endpoint: string;
  readonly #bearer: string;
  readonly #authEnvName: string;
  readonly #baseEnv: Readonly<Record<string, string | undefined>>;

  constructor(
    endpoint: string,
    bearer: string,
    authEnvName: string,
    baseEnv: Readonly<Record<string, string | undefined>>,
  ) {
    this.#endpoint = endpoint;
    this.#bearer = bearer;
    this.#authEnvName = authEnvName;
    this.#baseEnv = baseEnv;
    Object.freeze(this);
  }

  get endpoint(): string {
    return this.#endpoint;
  }

  readObserverBearer(): string {
    return this.#bearer;
  }

  createTuiConnection(): OwnedCodexTuiConnection {
    const env = Object.freeze({
      ...this.#baseEnv,
      [this.#authEnvName]: this.#bearer,
    });
    const args = Object.freeze([
      "--remote", this.#endpoint,
      "--remote-auth-token-env", this.#authEnvName,
    ]);
    return Object.freeze({ endpoint: this.#endpoint, args, env });
  }
}

interface ReaderCallbacks {
  readonly onEndpoint: (endpoint: string) => void;
  readonly onFailure: (code: OwnedCodexBackendFailureCode) => void;
  readonly onEnded: () => void;
}

/**
 * One exact captured reader's banner record and settlement witness. Only a
 * natural `end` event proves ordinary completion; a positively witnessed
 * never-created child may also settle abandonment after captured readers
 * close. `error`, timeout, listener removal, and `.destroyed` are never proof
 * by themselves.
 */
class ReaderWitness {
  readonly #source: Readable;
  readonly #callbacks: ReaderCallbacks;
  readonly #scanner: ReadinessBannerScanner;
  readonly #decoder = new StringDecoder("utf8");
  #rawBytes = 0;
  #ended = false;
  #closed = false;
  #errored = false;
  #active = true;

  readonly #handleData = (chunk: Buffer | string): void => {
    if (!this.#active || this.#ended || this.#closed || this.#errored) return;
    const bytes: Buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.#rawBytes += bytes.length;
    if (this.#rawBytes > NATIVE_CODEX_BACKEND_MAX_BANNER_BYTES) {
      this.#fail("banner-oversize");
      return;
    }
    this.#consume(this.#scanner.push(this.#decoder.write(bytes)));
  };

  readonly #handleEnd = (): void => {
    this.#finishEnd();
  };

  readonly #handleClose = (): void => {
    if (this.#ended || this.#closed) return;
    if (readableEnded(this.#source)) {
      this.#finishEnd();
      return;
    }
    this.#closed = true;
    this.#active = false;
    this.#scanner.clear();
    // A required reader closed without reaching natural end: it can never
    // prove ordinary reader settlement, so readiness fails closed and the
    // exact owned stop is requested while the process may still exist.
    this.#callbacks.onFailure("reader-closed");
  };

  readonly #handleError = (): void => {
    if (this.#errored || this.#ended) return;
    this.#errored = true;
    this.#active = false;
    this.#scanner.clear();
    this.#callbacks.onFailure("reader-error");
  };

  constructor(source: Readable, callbacks: ReaderCallbacks) {
    this.#source = source;
    this.#callbacks = callbacks;
    this.#scanner = new ReadinessBannerScanner();
    source.on("data", this.#handleData);
    source.on("end", this.#handleEnd);
    source.on("close", this.#handleClose);
    source.on("error", this.#handleError);
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** Closed or naturally ended; used only for proven never-created abandonment. */
  get settled(): boolean {
    return this.#ended || (this.#closed && !this.#errored);
  }

  get errored(): boolean {
    return this.#errored;
  }

  /** Observe a reader that was already naturally ended before listeners attached. */
  initialize(): void {
    if (this.#ended || this.#closed || this.#errored) return;
    if (readableEnded(this.#source)) this.#finishEnd();
  }

  /** Stop bounded banner retention while continuing to drain the exact reader. */
  disarm(): void {
    this.#active = false;
    this.#scanner.clear();
  }

  /** Remove listeners only after positive settlement, never as evidence itself. */
  dispose(): void {
    this.#active = false;
    this.#scanner.clear();
    this.#source.removeListener("data", this.#handleData);
    this.#source.removeListener("end", this.#handleEnd);
    this.#source.removeListener("close", this.#handleClose);
    this.#source.removeListener("error", this.#handleError);
  }

  #finishEnd(): void {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#active) {
      this.#consume(this.#scanner.push(this.#decoder.end()));
      if (this.#active) this.#consume(this.#scanner.finish());
    }
    this.#active = false;
    this.#scanner.clear();
    this.#callbacks.onEnded();
  }

  #consume(outcome: BannerScan): void {
    if (outcome.kind === "invalid") {
      this.#fail(outcome.failure);
      return;
    }
    if (outcome.kind === "endpoint" && this.#active) {
      this.#active = false;
      this.#scanner.clear();
      this.#callbacks.onEndpoint(outcome.endpoint);
    }
  }

  #fail(code: OwnedCodexBackendFailureCode): void {
    this.#active = false;
    this.#scanner.clear();
    this.#callbacks.onFailure(code);
  }
}

type BannerScan =
  | { readonly kind: "pending" }
  | { readonly kind: "endpoint"; readonly endpoint: string }
  | { readonly kind: "invalid"; readonly failure: OwnedCodexBackendFailureCode };

type BannerRecordState =
  | "await-title"
  | "await-listening"
  | "await-readyz"
  | "await-healthz"
  | "await-note"
  | "complete";

/**
 * Parse the exact Codex 0.169 WebSocket readiness banner, in order:
 *
 *   codex app-server (WebSockets)
 *     listening on: ws://127.0.0.1:<port>
 *     readyz: http://127.0.0.1:<port>/readyz
 *     healthz: http://127.0.0.1:<port>/healthz
 *     note: ...
 *
 * ANSI sequences are removed incrementally; an incomplete escape is retained
 * and never interpreted as endpoint text. A record is published only after its
 * complete note line, and duplicate/unexpected endpoint declarations
 * invalidate it. Output after the note line is not part of the readiness
 * record (the provider logs its listening URL again afterward).
 */
class ReadinessBannerScanner {
  readonly #ansi: AnsiNormalizer;
  #lineBuffer = "";
  #state: BannerRecordState = "await-title";
  #endpoint: string | undefined;
  #invalid: OwnedCodexBackendFailureCode | undefined;

  constructor() {
    this.#ansi = new AnsiNormalizer();
  }

  push(text: string): BannerScan {
    if (this.#invalid !== undefined) return { kind: "invalid", failure: this.#invalid };
    const ansi = this.#ansi.push(text);
    if (ansi.invalid) return this.#fail("banner-invalid");
    return this.#processText(ansi.text);
  }

  finish(): BannerScan {
    if (this.#invalid !== undefined) return { kind: "invalid", failure: this.#invalid };
    const ansi = this.#ansi.finish();
    if (ansi.invalid || ansi.incomplete) return this.#fail("banner-invalid");
    const outcome = this.#processText(ansi.text);
    if (outcome.kind !== "pending") return outcome;
    if (this.#lineBuffer.length > 0) {
      const finalLine = this.#lineBuffer;
      this.#lineBuffer = "";
      const lineOutcome = this.#processLine(finalLine);
      if (lineOutcome.kind !== "pending") return lineOutcome;
    }
    return this.#result();
  }

  clear(): void {
    this.#lineBuffer = "";
    this.#ansi.clear();
  }

  #processText(text: string): BannerScan {
    if (text.length > 0) {
      this.#lineBuffer += text;
      if (this.#lineBuffer.length > NATIVE_CODEX_BACKEND_MAX_BANNER_BYTES) {
        return this.#fail("banner-oversize");
      }
    }
    let newline = this.#lineBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#lineBuffer.slice(0, newline);
      this.#lineBuffer = this.#lineBuffer.slice(newline + 1);
      const outcome = this.#processLine(line);
      if (outcome.kind !== "pending") return outcome;
      newline = this.#lineBuffer.indexOf("\n");
    }
    return this.#result();
  }

  #processLine(line: string): BannerScan {
    if (this.#invalid !== undefined) return { kind: "invalid", failure: this.#invalid };
    const trimmed = line.replace(/\r+$/, "").trim();
    if (trimmed.length === 0) return { kind: "pending" };

    if (this.#state === "complete") {
      if (trimmed.startsWith(READINESS_LISTEN_PREFIX)) return this.#fail("endpoint-ambiguous");
      if (isKnownBannerLine(trimmed)) return this.#fail("banner-invalid");
      // Post-record output is ordinary provider logging, including the
      // provider's own repeated listening URL. It is not a new declaration.
      return { kind: "pending" };
    }

    if (trimmed === READINESS_BANNER_TITLE) {
      if (this.#state !== "await-title") return this.#fail("banner-invalid");
      this.#state = "await-listening";
      return { kind: "pending" };
    }

    if (this.#state === "await-title") {
      if (isKnownBannerLine(trimmed)) return this.#fail("banner-invalid");
      return this.#rejectUnexpectedLine(trimmed);
    }

    if (trimmed.startsWith(READINESS_LISTEN_PREFIX)) {
      return this.#processListeningLine(trimmed);
    }
    if (trimmed.startsWith(READINESS_READY_PREFIX)) {
      return this.#processReadyLine(trimmed);
    }
    if (trimmed.startsWith(READINESS_HEALTH_PREFIX)) {
      return this.#processHealthLine(trimmed);
    }
    if (trimmed.startsWith(READINESS_NOTE_PREFIX)) {
      return this.#processNoteLine(trimmed);
    }
    return this.#rejectUnexpectedLine(trimmed);
  }

  #processListeningLine(line: string): BannerScan {
    if (this.#state !== "await-listening") return this.#fail("endpoint-ambiguous");
    const value = line.slice(READINESS_LISTEN_PREFIX.length).trim();
    const schemes = countEndpointSchemes(value);
    if (schemes > 1) return this.#fail("endpoint-ambiguous");
    if (schemes === 0) return this.#fail("endpoint-invalid");
    const parsed = parseListenEndpoint(value);
    if (parsed.kind === "invalid") return this.#fail(parsed.failure);
    this.#endpoint = parsed.endpoint;
    this.#state = "await-readyz";
    return { kind: "pending" };
  }

  #processReadyLine(line: string): BannerScan {
    if (this.#state !== "await-readyz") return this.#fail("banner-invalid");
    const port = this.#endpoint === undefined ? undefined : endpointPortOf(this.#endpoint);
    const expected = port === undefined ? undefined : `readyz: http://127.0.0.1:${port}/readyz`;
    if (expected === undefined || line !== expected) return this.#fail("banner-invalid");
    this.#state = "await-healthz";
    return { kind: "pending" };
  }

  #processHealthLine(line: string): BannerScan {
    if (this.#state !== "await-healthz") return this.#fail("banner-invalid");
    const port = this.#endpoint === undefined ? undefined : endpointPortOf(this.#endpoint);
    const expected = port === undefined ? undefined : `healthz: http://127.0.0.1:${port}/healthz`;
    if (expected === undefined || line !== expected) return this.#fail("banner-invalid");
    this.#state = "await-note";
    return { kind: "pending" };
  }

  #processNoteLine(line: string): BannerScan {
    if (this.#state !== "await-note") return this.#fail("banner-invalid");
    if (line.length <= READINESS_NOTE_PREFIX.length) return this.#fail("banner-invalid");
    if (countEndpointSchemes(line) > 0) return this.#rejectUnexpectedLine(line);
    this.#state = "complete";
    // Continue through the rest of this chunk so a duplicate record or a
    // duplicate listening declaration is still rejected; ordinary post-record
    // logs are ignored by the complete-state branch.
    return { kind: "pending" };
  }

  #rejectUnexpectedLine(line: string): BannerScan {
    const schemes = countEndpointSchemes(line);
    if (schemes > 1) return this.#fail("endpoint-ambiguous");
    if (schemes === 1) return this.#fail("banner-invalid");
    return { kind: "pending" };
  }

  #result(): BannerScan {
    if (this.#invalid !== undefined) return { kind: "invalid", failure: this.#invalid };
    const endpoint = this.#endpoint;
    if (this.#state === "complete" && endpoint !== undefined) {
      return { kind: "endpoint", endpoint };
    }
    return { kind: "pending" };
  }

  #fail(code: OwnedCodexBackendFailureCode): BannerScan {
    this.#invalid = code;
    this.#lineBuffer = "";
    this.#ansi.clear();
    return { kind: "invalid", failure: code };
  }
}

interface AnsiNormalizeResult {
  readonly text: string;
  readonly incomplete: boolean;
  readonly invalid: boolean;
}

/**
 * Remove complete ANSI SGR/OSC/escape sequences while retaining an incomplete
 * trailing escape until more bytes arrive. Bytes inside an incomplete escape
 * are never passed to the endpoint parser.
 */
class AnsiNormalizer {
  #pending = "";
  #invalid = false;

  push(text: string): AnsiNormalizeResult {
    if (this.#invalid) return { text: "", incomplete: false, invalid: true };
    const input = this.#pending + text;
    this.#pending = "";
    let output = "";
    let index = 0;
    while (index < input.length) {
      const character = input[index]!;
      if (character !== "\x1b") {
        output += character;
        index += 1;
        continue;
      }
      const consumed = consumeAnsiSequence(input, index);
      if (consumed === "incomplete") {
        this.#pending = input.slice(index);
        return { text: output, incomplete: true, invalid: false };
      }
      if (consumed === "invalid") {
        this.#invalid = true;
        this.#pending = input.slice(index);
        return { text: output, incomplete: false, invalid: true };
      }
      index = consumed;
    }
    return { text: output, incomplete: false, invalid: false };
  }

  finish(): AnsiNormalizeResult {
    const incomplete = this.#pending.length > 0;
    this.#pending = "";
    return { text: "", incomplete, invalid: this.#invalid };
  }

  clear(): void {
    this.#pending = "";
  }
}

/**
 * Consume one ANSI sequence beginning at `start` (an ESC byte). Returns the
 * exclusive end offset for a complete sequence, `"incomplete"` when more bytes
 * are needed, or `"invalid"` for an unexpected escape shape.
 */
function consumeAnsiSequence(input: string, start: number): number | "incomplete" | "invalid" {
  const introducer = input[start + 1];
  if (introducer === undefined) return "incomplete";
  if (introducer === "[") {
    let index = start + 2;
    while (index < input.length && isCsiParameter(input[index]!)) index += 1;
    while (index < input.length && isCsiIntermediate(input[index]!)) index += 1;
    if (index >= input.length) return "incomplete";
    const final = input[index]!;
    if (final >= "@" && final <= "~") return index + 1;
    return "invalid";
  }
  if (introducer === "]") {
    let index = start + 2;
    while (index < input.length) {
      if (input[index] === "\x07") return index + 1;
      if (input[index] === "\x1b" && input[index + 1] === "\\") return index + 2;
      index += 1;
    }
    return "incomplete";
  }
  if (introducer >= "@" && introducer <= "_") return start + 2;
  return "invalid";
}

function isCsiParameter(character: string): boolean {
  return character >= "0" && character <= "?";
}

function isCsiIntermediate(character: string): boolean {
  return character >= " " && character <= "/";
}

function parseListenEndpoint(
  value: string,
): { readonly kind: "ok"; readonly endpoint: string } | { readonly kind: "invalid"; readonly failure: OwnedCodexBackendFailureCode } {
  if (!value.startsWith(WS_SCHEME)) return { kind: "invalid", failure: "endpoint-invalid" };
  const verdict = validateLoopbackAuthority(value.slice(WS_SCHEME.length));
  if (verdict !== "ok") return { kind: "invalid", failure: verdict };
  return { kind: "ok", endpoint: value };
}

function countEndpointSchemes(text: string): number {
  return text.match(/wss?:\/\//gi)?.length ?? 0;
}

function endpointPortOf(endpoint: string): string | undefined {
  return /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(endpoint)?.[1];
}

function isKnownBannerLine(line: string): boolean {
  return line === READINESS_BANNER_TITLE
    || line.startsWith(READINESS_LISTEN_PREFIX)
    || line.startsWith(READINESS_READY_PREFIX)
    || line.startsWith(READINESS_HEALTH_PREFIX)
    || line.startsWith(READINESS_NOTE_PREFIX);
}

function validateLoopbackAuthority(
  authority: string,
): "ok" | "endpoint-invalid" | "endpoint-non-loopback" {
  if (authority === "127.0.0.1") return "endpoint-invalid";
  if (!authority.startsWith("127.0.0.1:")) return "endpoint-non-loopback";
  const portText = authority.slice("127.0.0.1:".length);
  if (!/^[1-9][0-9]{0,4}$/.test(portText)) return "endpoint-invalid";
  const port = Number(portText);
  if (port < 1 || port > 65_535) return "endpoint-invalid";
  return "ok";
}

function chooseAuthEnvName(baseEnv: Readonly<Record<string, string | undefined>>): string {
  const reserved = new Set(Object.keys(baseEnv).map((key) => key.toUpperCase()));
  for (let attempt = 0; attempt < AUTH_ENV_NAME_ATTEMPTS; attempt += 1) {
    const name = `${NATIVE_CODEX_BACKEND_AUTH_ENV_PREFIX}${randomBytes(8).toString("hex").toUpperCase()}`;
    if (!reserved.has(name)) return name;
  }
  throw new Error("owned Codex backend could not reserve an auth environment name");
}

function readableEnded(source: Readable): boolean {
  try {
    return source.readableEnded === true;
  } catch {
    return false;
  }
}

function isChildProcessLike(value: unknown): value is ChildProcess {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { on?: unknown; removeListener?: unknown };
  return typeof record.on === "function" && typeof record.removeListener === "function";
}

function isReadableLike(value: unknown): value is Readable {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { on?: unknown; removeListener?: unknown };
  return typeof record.on === "function" && typeof record.removeListener === "function";
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { then?: unknown }).then === "function";
}

function assertLaunchInput(input: OwnedCodexBackendLaunchInput): void {
  if (typeof input !== "object" || input === null) {
    throw new TypeError("owned Codex backend launch input must be an object");
  }
  const identity = input.identity;
  if (typeof identity !== "object" || identity === null) {
    throw new TypeError("owned Codex backend identity must be an object");
  }
  if (typeof identity.leaseId !== "string" || identity.leaseId.length === 0) {
    throw new TypeError("owned Codex backend leaseId must be a nonempty string");
  }
  if (!Number.isSafeInteger(identity.generation) || identity.generation < 0) {
    throw new RangeError("owned Codex backend generation must be a non-negative safe integer");
  }
  if (typeof input.baseEnv !== "object" || input.baseEnv === null || Array.isArray(input.baseEnv)) {
    throw new TypeError("owned Codex backend baseEnv must be an environment object");
  }
  if (typeof input.spawnBackend !== "function") {
    throw new TypeError("owned Codex backend spawnBackend must be a function");
  }
  if (typeof input.terminateOwnedBackend !== "function") {
    throw new TypeError("owned Codex backend terminateOwnedBackend must be a function");
  }
  if (
    input.startupTimeoutMs !== undefined
    && (!Number.isSafeInteger(input.startupTimeoutMs) || input.startupTimeoutMs < 0)
  ) {
    throw new RangeError("owned Codex backend startupTimeoutMs must be a non-negative safe integer");
  }
  if (input.signal !== undefined) {
    const signal = input.signal as unknown as {
      aborted?: unknown;
      addEventListener?: unknown;
      removeEventListener?: unknown;
    };
    if (
      typeof signal !== "object" || signal === null
      || typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function"
    ) {
      throw new TypeError("owned Codex backend signal must be an AbortSignal");
    }
  }
}
