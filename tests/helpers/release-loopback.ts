import { execFile, execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { loadReleaseModule, projectRoot } from "./release-scripts";

// Owned loopback HTTP harness for release publisher transport regressions.
//
// The fixture process (tests/fixtures/release-loopback-transport.cjs) serves
// HTTP/1.1 keep-alive on 127.0.0.1 and forwards each request over IPC to the
// handler given here, so routing stays in the test while the listener keeps
// running even when this process's event loop is blocked. `controlSync` runs
// the fixture's control mode synchronously: it blocks this event loop exactly
// like the publisher's synchronous artifact work, and can ask the server to
// close every idle pooled connection meanwhile.
//
// Ownership and cancellation: one spawned fixture per call. The arm runs under
// one bounded deadline; on success, failure, or deadline the harness aborts
// every owned in-flight fetch, asks the fixture to shut down gracefully (it
// destroys pending responses, closes both listeners, then disconnects its own
// IPC channel), and awaits the fixture's `exit` (code 0) and `close` within a
// settlement deadline that starts when shutdown begins. Only if that graceful
// settlement fails is the owned child handle signalled, and its exit is still
// awaited; such a run is always reported as not positively settled. No PID is
// ever addressed directly and nothing foreign is adopted.
//
// Diagnostics: every failure leaves this harness as a LoopbackHarnessError
// carrying only a fixed label, the allowlisted transport classifier line, and
// booleans — never the original error, its message, a cause, or any header,
// body, URL, address, port, pid, path, or environment value.

const releaseCommon = loadReleaseModule<{ describeReleaseTransport(error: unknown): string | null }>("common.cjs");

const FIXTURE = () => join(projectRoot(), "tests", "fixtures", "release-loopback-transport.cjs");
const DEFAULT_ARM_DEADLINE_MS = 60_000;
const SETTLE_DEADLINE_MS = 10_000;
const CONTROL_TIMEOUT_MS = 20_000;

// Only these two origins are ever rewritten; anything else is refused before
// any connection is attempted.
const OWNED_ORIGINS: ReadonlyArray<readonly [origin: string, prefix: string]> = [
  ["https://api.github.com/", "/api/"],
  ["https://uploads.github.com/", "/uploads/"],
];

export interface LoopbackRequest {
  method: string;
  // The original (pre-rewrite) https URL the client asked for.
  url: string;
  contentType: string;
  body: Buffer;
}

export type LoopbackResponse = { status: number; body?: Buffer | string; contentType?: string } | { destroy: true };
export type LoopbackHandler = (request: LoopbackRequest) => LoopbackResponse | Promise<LoopbackResponse>;

export interface LoopbackStats {
  connections: number;
  requests: number;
  patches: number;
  closedIdle: number;
  open: number;
  // Idle connections closed (and witnessed closed by the server) by this call.
  closed: number;
}

export type LoopbackControlAction = "stats" | "close-idle";

export interface LoopbackServer {
  // Native global fetch through the strict owned-loopback URL rewriter; every
  // request carries the harness's cancellation signal.
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  // Blocks this event loop for the whole control round trip.
  controlSync(action: LoopbackControlAction): LoopbackStats;
  // Same control round trip with this event loop free.
  controlAsync(action: LoopbackControlAction): Promise<LoopbackStats>;
}

export interface LoopbackSettlement {
  exited: boolean;
  closed: boolean;
  exitCodeZero: boolean;
  // True only for a graceful shutdown with exit code 0, no signal, and close.
  positive: boolean;
}

export class LoopbackHarnessError extends Error {
  constructor(
    readonly label: string,
    readonly transport: string | null,
    readonly settlement: LoopbackSettlement,
    readonly bodySettled: boolean,
  ) {
    super(`${label}${transport ? ` [${transport}]` : ""} (settled=${settlement.positive}, bodySettled=${bodySettled})`);
    this.name = "LoopbackHarnessError";
  }
}

// Fixed-label errors raised by this harness itself; safe to report by label.
class HarnessLabel extends Error {}

function controlArgs(port: number, action: LoopbackControlAction): string[] {
  return [FIXTURE(), "control", String(port), action];
}

function parseStats(text: string): LoopbackStats {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HarnessLabel("loopback control: malformed acknowledgement");
  }
  const stats = {} as Record<keyof LoopbackStats, number>;
  for (const field of ["connections", "requests", "patches", "closedIdle", "open", "closed"] as const) {
    const value = parsed[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new HarnessLabel("loopback control: acknowledgement field is not a counter");
    }
    stats[field] = value;
  }
  return stats;
}

// Fixed label for an arbitrary failure: harness labels pass through, a
// fetch-boundary failure gets the closed classifier line, anything else is
// reduced to its constructor family without any of its content.
function sanitize(error: unknown): { label: string; transport: string | null } {
  if (error instanceof HarnessLabel) return { label: error.message, transport: null };
  let transport: string | null = null;
  try {
    transport = releaseCommon.describeReleaseTransport(error);
  } catch {
    transport = null;
  }
  return { label: "loopback arm failed", transport };
}

function trackChild(child: ChildProcess) {
  const state = { exit: undefined as { code: number | null; signal: NodeJS.Signals | null } | undefined, closed: false };
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const waiter of waiters) waiter();
  };
  child.once("exit", (code, signal) => {
    state.exit = { code, signal };
    notify();
  });
  child.once("close", () => {
    state.closed = true;
    notify();
  });
  // Resolves once `done()` holds or the deadline (started now) elapses.
  const until = (done: () => boolean, deadlineMs: number) => new Promise<void>((resolve) => {
    if (done()) {
      resolve();
      return;
    }
    const finish = () => {
      if (!done()) return;
      clearTimeout(timer);
      waiters.delete(finish);
      resolve();
    };
    const timer = setTimeout(() => {
      waiters.delete(finish);
      resolve();
    }, deadlineMs);
    waiters.add(finish);
  });
  return { state, until };
}

function deadline(ms: number): { promise: Promise<"deadline">; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

// Runs `body` against a freshly spawned owned loopback server and always
// shuts the fixture down afterwards, on success, failure, and deadline paths.
export async function withLoopbackServer<T>(
  handler: LoopbackHandler,
  body: (server: LoopbackServer) => Promise<T>,
  options: { deadlineMs?: number } = {},
): Promise<T> {
  const child = spawn(process.execPath, [FIXTURE(), "server"], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const tracked = trackChild(child);
  const abort = new AbortController();
  const arm = deadline(options.deadlineMs ?? DEFAULT_ARM_DEADLINE_MS);
  let stderrBytes = 0;
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
  });
  child.on("error", () => {});
  let handlerFailures = 0;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  let bodyPromise: Promise<unknown> | undefined;

  const ready = new Promise<{ api: number; control: number }>((resolve, reject) => {
    child.once("exit", () => reject(new HarnessLabel("loopback server: exited before ready")));
    child.on("message", (message: { type?: string; api?: unknown; control?: unknown }) => {
      if (message?.type !== "ready") return;
      if (!Number.isSafeInteger(message.api) || !Number.isSafeInteger(message.control)) {
        reject(new HarnessLabel("loopback server: malformed ready message"));
        return;
      }
      resolve({ api: message.api as number, control: message.control as number });
    });
  });
  ready.catch(() => {});

  child.on("message", (message: { type?: string; id?: unknown; method?: unknown; path?: unknown; contentType?: unknown; body?: unknown }) => {
    if (message?.type !== "request") return;
    void (async () => {
      let reply: Record<string, unknown>;
      try {
        const path = String(message.path ?? "");
        const owned = OWNED_ORIGINS.find(([, prefix]) => path.startsWith(prefix));
        if (!owned) throw new HarnessLabel("unowned loopback path");
        const response = await handler({
          method: String(message.method ?? ""),
          url: `${owned[0]}${path.slice(owned[1].length)}`,
          contentType: String(message.contentType ?? ""),
          body: Buffer.from(String(message.body ?? ""), "base64"),
        });
        if ("destroy" in response) {
          reply = { type: "response", id: message.id, destroy: true };
        } else {
          const bytes = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body ?? "", "utf8");
          reply = { type: "response", id: message.id, status: response.status, contentType: response.contentType ?? "application/json", body: bytes.toString("base64") };
        }
      } catch {
        handlerFailures += 1;
        reply = { type: "response", id: message.id, status: 599, body: "" };
      }
      if (child.connected) child.send(reply);
    })();
  });

  try {
    const ports = await Promise.race([ready, arm.promise]);
    if (ports === "deadline") throw new HarnessLabel("loopback server: not ready before the deadline");
    const rewrite = (url: string): string => {
      const owned = OWNED_ORIGINS.find(([origin]) => url.startsWith(origin));
      if (!owned) throw new HarnessLabel("loopback rewriter: refusing an unowned origin");
      return `http://127.0.0.1:${ports.api}${owned[1]}${url.slice(owned[0].length)}`;
    };
    const server: LoopbackServer = {
      fetchImpl: (url, init) => globalThis.fetch(rewrite(url), { ...init, signal: abort.signal }),
      controlSync(action) {
        let text: string;
        try {
          text = execFileSync(process.execPath, controlArgs(ports.control, action), { encoding: "utf8", timeout: CONTROL_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
        } catch {
          throw new HarnessLabel(`loopback control (${action}): helper did not exit successfully`);
        }
        return parseStats(text);
      },
      controlAsync(action) {
        return new Promise((resolve, reject) => {
          execFile(process.execPath, controlArgs(ports.control, action), { encoding: "utf8", timeout: CONTROL_TIMEOUT_MS }, (error, stdout) => {
            if (error) {
              reject(new HarnessLabel(`loopback control (${action}): helper did not exit successfully`));
              return;
            }
            try {
              resolve(parseStats(stdout));
            } catch (parseError) {
              reject(parseError);
            }
          });
        });
      },
    };
    bodyPromise = Promise.resolve().then(() => body(server));
    bodyPromise.catch(() => {});
    const raced = await Promise.race([bodyPromise.then((value) => ({ value: value as T })), arm.promise]);
    if (raced === "deadline") throw new HarnessLabel("loopback arm: deadline exceeded");
    outcome = { ok: true, value: raced.value };
  } catch (error) {
    outcome = { ok: false, error };
  }
  arm.cancel();

  // Coordinated shutdown: cancel owned requests, stop the server gracefully,
  // and give everything one settlement deadline that starts now.
  abort.abort();
  if (child.connected) child.send({ type: "shutdown" });
  let bodySettled = bodyPromise === undefined;
  if (bodyPromise) {
    const settleBody = deadline(SETTLE_DEADLINE_MS);
    const settledBody = await Promise.race([bodyPromise.then(() => true, () => true), settleBody.promise]);
    settleBody.cancel();
    bodySettled = settledBody === true;
  }
  await tracked.until(() => tracked.state.exit !== undefined && tracked.state.closed, SETTLE_DEADLINE_MS);
  const graceful = tracked.state.exit !== undefined && tracked.state.closed;
  if (tracked.state.exit === undefined) {
    // The graceful path failed: signal the owned handle and still await its
    // exit, so nothing outlives the harness unobserved.
    child.kill("SIGKILL");
    await tracked.until(() => tracked.state.exit !== undefined && tracked.state.closed, SETTLE_DEADLINE_MS);
  }
  const exit = tracked.state.exit;
  const settlement: LoopbackSettlement = {
    exited: exit !== undefined,
    closed: tracked.state.closed,
    exitCodeZero: exit?.code === 0,
    positive: graceful && exit?.code === 0 && exit?.signal === null,
  };

  if (!outcome.ok) {
    const { label, transport } = sanitize(outcome.error);
    throw new LoopbackHarnessError(label, transport, settlement, bodySettled);
  }
  if (!settlement.positive) throw new LoopbackHarnessError("loopback server: not positively settled", null, settlement, bodySettled);
  if (stderrBytes !== 0) throw new LoopbackHarnessError("loopback server: unexpected stderr output", null, settlement, bodySettled);
  if (handlerFailures !== 0) throw new LoopbackHarnessError("loopback server: a request failed in the test handler", null, settlement, bodySettled);
  return outcome.value;
}
