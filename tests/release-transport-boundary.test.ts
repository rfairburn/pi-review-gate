import assert from "node:assert/strict";
import test from "node:test";
import { loadReleaseModule } from "./helpers/release-scripts";
import type { ReleaseApi } from "./helpers/release-scripts";
import { LoopbackHarnessError, withLoopbackServer } from "./helpers/release-loopback";
import type { LoopbackHandler, LoopbackServer, LoopbackStats } from "./helpers/release-loopback";

// Native-HTTP regressions for the publisher's transport phase boundary
// (issue #708), run against an owned loopback server with the actual release
// API client and Node's native global fetch.
//
// The hazard: the publisher's discovery GET and draft-creation POST leave
// keep-alive connections pooled; the synchronous artifact/APK work then blocks
// the event loop; if the peer closes an idle pooled connection meanwhile, the
// closure is not processed before the next request, and a draft-identity
// PATCH sent straight from that continuation is written to the stale socket
// and fails before the server receives it. Each arm reproduces that source
// shape (GET, then POST, then a synchronous block in the POST's continuation,
// then the PATCH) and differs only in whether the peer closes, whether the
// event loop is blocked, and whether the producer's actual
// `awaitTransportPhaseBoundary` runs before the PATCH. Diagnostics stay closed
// labels and integer counters.

const common = loadReleaseModule<{
  REPOSITORY: string;
  RELEASE_TRANSPORT_OPERATIONS: Record<string, string>;
  describeReleaseTransport(error: unknown): string | null;
  createApi(options: { fetchImpl: unknown; token: string; repository: string }): ReleaseApi;
}>("common.cjs");
const publish = loadReleaseModule<{ awaitTransportPhaseBoundary(): Promise<void> }>("publish.cjs");

const TOKEN = "dummy-loopback-token";
const STALE_SOCKET_FAILURE = "release diagnostics: op=update-draft-identity boundary=request transport=TypeError<UND_ERR_SOCKET";

// Minimal source-shaped routing: the discovery GET finds no published
// release, the create POST returns a draft, and the identity PATCH succeeds
// unless the arm asks for a genuine in-flight close.
function draftRouter(options: { destroyPatch?: boolean } = {}): LoopbackHandler {
  return (request) => {
    if (request.method === "GET") return { status: 404, body: JSON.stringify({ message: "Not Found" }) };
    if (request.method === "POST") return { status: 201, body: JSON.stringify({ id: 1, draft: true, tag_name: "b2" }) };
    if (request.method === "PATCH") {
      if (options.destroyPatch) return { destroy: true };
      return { status: 200, body: JSON.stringify({ id: 1, draft: true, tag_name: "b2" }) };
    }
    return { status: 404, body: "{}" };
  };
}

type Interlude = "none" | "block" | "block-and-close" | "async-close";

interface ArmResult {
  // Source-shape routing witnesses: discovery found nothing, create made a draft.
  discoveryNull: boolean;
  createdStatus: number;
  status?: number;
  diagnostics?: string | null;
  // Server counters acknowledged inside the interlude (absent for "none").
  ack?: LoopbackStats;
  // Server counters after the PATCH settled.
  after: LoopbackStats;
}

async function sourceShapedArm(server: LoopbackServer, interlude: Interlude, boundary: boolean): Promise<ArmResult> {
  const api = common.createApi({ fetchImpl: server.fetchImpl, token: TOKEN, repository: common.REPOSITORY });
  const discoveryNull = (await api.getReleaseByTag("b2")) === null;
  const created = await api.createRelease({ tag_name: "b2", draft: true });
  // Still inside the create response's continuation, exactly as the producer
  // reaches its synchronous artifact work.
  let ack: LoopbackStats | undefined;
  if (interlude === "block") ack = server.controlSync("stats");
  else if (interlude === "block-and-close") ack = server.controlSync("close-idle");
  else if (interlude === "async-close") ack = await server.controlAsync("close-idle");
  if (boundary) await publish.awaitTransportPhaseBoundary();
  let status: number | undefined;
  let diagnostics: string | null | undefined;
  try {
    const patched = await api.updateRelease(1, { tag_name: "b2", draft: true }, common.RELEASE_TRANSPORT_OPERATIONS.updateDraftIdentity);
    status = patched.status;
  } catch (error) {
    diagnostics = common.describeReleaseTransport(error);
  }
  const after = await server.controlAsync("stats");
  return { discoveryNull, createdStatus: created.status, status, diagnostics, ack, after };
}

// Assertions run outside the harness body on plain counters, so a failing
// expectation reports only these values.
function assertSourceShape(result: ArmResult, context: string) {
  assert.equal(result.discoveryNull, true, `${context}: discovery GET routed`);
  assert.equal(result.createdStatus, 201, `${context}: create POST routed`);
}

// The close interludes are only meaningful when the server positively
// witnessed at least one idle pooled connection close during the interlude.
function assertPeerClosedPooledConnection(result: ArmResult, context: string): LoopbackStats {
  assertSourceShape(result, context);
  assert.ok(result.ack, `${context}: interlude acknowledgement present`);
  const ack = result.ack as LoopbackStats;
  assert.equal(ack.patches, 0, `${context}: no PATCH before the interlude`);
  assert.ok(ack.closed >= 1, `${context}: inconclusive — no idle pooled connection was closed by the peer (closed=${ack.closed})`);
  assert.equal(ack.open, 0, `${context}: every pooled connection was closed and witnessed closed (open=${ack.open})`);
  return ack;
}

function assertSucceededOnce(result: ArmResult, context: string) {
  assertSourceShape(result, context);
  assert.equal(result.diagnostics, undefined, `${context}: the PATCH did not fail (failed=${result.diagnostics !== undefined})`);
  assert.equal(result.status, 200, `${context}: PATCH succeeded`);
  assert.equal(result.after.patches, 1, `${context}: exactly one PATCH reached the server`);
  assert.equal(result.after.requests, 3, `${context}: GET, POST, PATCH and nothing else`);
}

test("baseline: the source-shaped GET, POST, PATCH sequence succeeds without interference", async () => {
  const result = await withLoopbackServer(draftRouter(), (server) => sourceShapedArm(server, "none", false));
  assertSucceededOnce(result, "baseline");
  assert.equal(result.after.closedIdle, 0, "baseline: nothing was closed");
});

test("control: blocking the event loop without a peer close does not break the PATCH", async () => {
  const result = await withLoopbackServer(draftRouter(), (server) => sourceShapedArm(server, "block", false));
  assert.ok(result.ack, "block: interlude acknowledged");
  assert.ok((result.ack as LoopbackStats).open >= 1, "block: a pooled connection stayed open through the block");
  assertSucceededOnce(result, "block");
  assert.equal(result.after.closedIdle, 0, "block: nothing was closed");
});

test("control: a peer close while the event loop is free is processed before the PATCH", async () => {
  const result = await withLoopbackServer(draftRouter(), (server) => sourceShapedArm(server, "async-close", false));
  const ack = assertPeerClosedPooledConnection(result, "async close");
  assertSucceededOnce(result, "async close");
  assert.equal(result.after.connections, ack.connections + 1, "async close: the PATCH used one fresh connection");
});

test("uncorrected: a peer close during the synchronous block sends the PATCH to a stale socket", async () => {
  const result = await withLoopbackServer(draftRouter(), (server) => sourceShapedArm(server, "block-and-close", false));
  const ack = assertPeerClosedPooledConnection(result, "uncorrected");
  assert.notEqual(result.status, 200, "uncorrected: inconclusive — the stale-socket hazard was not reproduced, so the boundary regression cannot certify anything");
  assert.equal(result.diagnostics, STALE_SOCKET_FAILURE, "uncorrected: the native socket rejection is attributed to the identity PATCH request");
  assert.equal(result.after.patches, 0, "uncorrected: the server never received the PATCH");
  assert.equal(result.after.connections, ack.connections, "uncorrected: no fresh connection was opened for the PATCH");
});

test("corrected: the producer's actual phase boundary sends the PATCH over a fresh connection", async () => {
  const result = await withLoopbackServer(draftRouter(), (server) => sourceShapedArm(server, "block-and-close", true));
  const ack = assertPeerClosedPooledConnection(result, "corrected");
  assertSucceededOnce(result, "corrected");
  assert.equal(result.after.connections, ack.connections + 1, "corrected: the PATCH used one fresh connection");
});

test("a genuine in-flight close after the boundary still fails closed without a retry", async () => {
  const result = await withLoopbackServer(draftRouter({ destroyPatch: true }), (server) => sourceShapedArm(server, "none", true));
  assertSourceShape(result, "in-flight close");
  assert.equal(result.status, undefined, "in-flight close: the PATCH did not resolve");
  // The same closed label as the stale-socket case: the line alone cannot
  // tell a stale pooled socket from a request the server received.
  assert.equal(result.diagnostics, STALE_SOCKET_FAILURE, "in-flight close: attributed to the identity PATCH request");
  assert.equal(result.after.patches, 1, "in-flight close: the server received exactly one PATCH (no retry)");
  assert.equal(result.after.requests, 3, "in-flight close: GET, POST, PATCH and nothing else");
});

// --- Harness failure paths: bounded, settled, and content-free --------------

const HOSTILE = ["ghp_SENTINEL_plaintext_token_0123456789", "https://secret-host.internal/private?token=SENTINEL", "127.0.0.1", "/home/private/runner"];

function assertContentFree(error: LoopbackHarnessError, context: string) {
  assert.equal(Object.prototype.hasOwnProperty.call(error, "cause"), false, `${context}: no raw cause is attached`);
  for (const sentinel of HOSTILE) {
    assert.equal(error.message.includes(sentinel), false, `${context}: hostile content is never reported`);
    assert.equal(String(error.stack).split("\n")[0].includes(sentinel), false, `${context}: hostile content is not in the headline`);
  }
}

async function harnessFailure(run: () => Promise<unknown>): Promise<LoopbackHarnessError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof LoopbackHarnessError, "every harness failure is a sanitized harness error");
    return error;
  }
  assert.fail("the harness arm was expected to fail");
}

test("harness: a hung arm is cancelled at its deadline and the owned server still settles positively", async () => {
  // The handler never answers, so only coordinated cancellation can end the arm.
  const error = await harnessFailure(() => withLoopbackServer(
    () => new Promise<never>(() => {}),
    async (server) => {
      const api = common.createApi({ fetchImpl: server.fetchImpl, token: TOKEN, repository: common.REPOSITORY });
      return api.getReleaseByTag("b2");
    },
    { deadlineMs: 500 },
  ));
  assert.equal(error.label, "loopback arm: deadline exceeded");
  assert.equal(error.bodySettled, true, "the in-flight owned fetch was aborted and the arm settled");
  assert.deepEqual(error.settlement, { exited: true, closed: true, exitCodeZero: true, positive: true }, "exit and close were both observed after graceful shutdown");
  assertContentFree(error, "deadline");
});

test("harness: hostile failures are reported with fixed labels and the closed transport classifier only", async () => {
  const hostile = await harnessFailure(() => withLoopbackServer(draftRouter(), async () => {
    throw new Error(`boom ${HOSTILE.join(" ")}`, { cause: new Error(HOSTILE[1]) });
  }));
  assert.equal(hostile.label, "loopback arm failed");
  assert.equal(hostile.transport, null, "an unattributed failure carries no transport line");
  assert.equal(hostile.settlement.positive, true, "hostile: the server still settled positively");
  assertContentFree(hostile, "hostile error");

  // A native socket failure escaping the arm: its raw error names loopback
  // addresses and ports, but only the closed classifier line is reported.
  const escaped = await harnessFailure(() => withLoopbackServer(draftRouter({ destroyPatch: true }), async (server) => {
    const api = common.createApi({ fetchImpl: server.fetchImpl, token: TOKEN, repository: common.REPOSITORY });
    await api.updateRelease(1, { draft: true }, common.RELEASE_TRANSPORT_OPERATIONS.updateDraftIdentity);
  }));
  assert.equal(escaped.label, "loopback arm failed");
  assert.equal(escaped.transport, STALE_SOCKET_FAILURE, "only the allowlisted classifier line describes the escaped transport failure");
  assert.equal(escaped.settlement.positive, true, "escaped: the server still settled positively");
  assertContentFree(escaped, "escaped transport failure");
});
