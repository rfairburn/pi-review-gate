import assert from "node:assert/strict";
import test from "node:test";
import { loadReleaseModule } from "./helpers/release-scripts";
import type { ReleaseApi } from "./helpers/release-scripts";

// Contract-level tests for the GitHub REST client used by the release builder.
// The key risk these guard against: local mocks accept request shapes that
// Node's native fetch (undici) rejects, so every generated (url, init) pair is
// also validated by constructing a real `Request` from it.

const common = loadReleaseModule<{
  REPOSITORY: string;
  ReleaseError: new (message: string) => Error;
  createApi(options: { fetchImpl: unknown; token: string; repository: string }): ReleaseApi;
}>("common.cjs");

const TOKEN = "test-token";
const API_BASE = `https://api.github.com/repos/${common.REPOSITORY}`;

interface CapturedCall {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: Buffer | string };
}

function makeClient(responder: (call: CapturedCall) => { status: number; text?: string; bytes?: Buffer }) {
  const calls: CapturedCall[] = [];
  const fetchImpl = async (url: string, init?: CapturedCall["init"]) => {
    const call: CapturedCall = { url, init };
    calls.push(call);
    const response = responder(call);
    const bytes = response.bytes ?? Buffer.from(response.text ?? "", "utf8");
    return {
      status: response.status,
      text: async () => bytes.toString("utf8"),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  };
  const api = common.createApi({ fetchImpl, token: TOKEN, repository: common.REPOSITORY });
  return { api, calls };
}

// Constructing the native Request from the generated arguments must not throw;
// this is exactly what fails when a GET carries any body. The cast is type-
// level only: the runtime object is byte-for-byte what the client passes to
// fetch.
function assertNativeRequestAccepts(call: CapturedCall) {
  const request = new Request(call.url, (call.init ?? {}) as RequestInit);
  return request;
}

test("downloadAsset issues a binary GET with no body that native fetch accepts", async () => {
  const payload = Buffer.from([0, 1, 2, 128, 250, 255]); // non-UTF8 bytes
  const { api, calls } = makeClient(() => ({ status: 200, bytes: payload }));
  const { buffer, status } = await api.downloadAsset(42);
  assert.equal(status, 200);
  assert.deepEqual(buffer, payload, "downloaded bytes must round-trip exactly");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${API_BASE}/releases/assets/42`);
  const request = assertNativeRequestAccepts(calls[0] as CapturedCall);
  assert.equal(request.method, "GET");
  assert.equal(request.body, null, "a GET must never carry a body");
  assert.equal(request.headers.get("accept"), "application/octet-stream");
  assert.match(request.headers.get("authorization") ?? "", /^Bearer test-token$/);
});

test("uploadAsset posts the exact buffer payload with an octet-stream content type", async () => {
  const payload = Buffer.from([0, 1, 2, 128, 250, 255]);
  const { api, calls } = makeClient(() => ({ status: 201, text: JSON.stringify({ id: 9, name: "a.tgz", size: payload.length }) }));
  const uploadUrl = `https://uploads.github.com/repos/${common.REPOSITORY}/releases/7/assets?name={name}&label={label}`;
  const result = await api.uploadAsset(uploadUrl, "pi-review-gate-0.1.0-dev.2.tgz", payload);
  assert.equal(result.id, 9);
  assert.equal(calls.length, 1);
  const call = calls[0] as CapturedCall;
  // Documented upload_url form: name substituted, unused label placeholder dropped.
  const parsed = new URL(call.url);
  assert.equal(parsed.origin, "https://uploads.github.com");
  assert.equal(parsed.searchParams.get("name"), "pi-review-gate-0.1.0-dev.2.tgz");
  assert.ok(!call.url.includes("{"), "no placeholder may remain in the upload URL");
  assert.ok(!parsed.searchParams.has("label"), "the unused label placeholder must be dropped");
  const request = assertNativeRequestAccepts(call);
  assert.equal(request.method, "POST");
  const bodyBytes = Buffer.from(await request.arrayBuffer());
  assert.deepEqual(bodyBytes, payload, "the upload body must be the exact buffer bytes");
  assert.equal(request.headers.get("content-type"), "application/octet-stream");
});

test("uploadAsset also handles the template-style upload_url", async () => {
  const payload = Buffer.from("bytes");
  const { api, calls } = makeClient(() => ({ status: 201, text: JSON.stringify({ id: 9 }) }));
  await api.uploadAsset(`https://uploads.github.com/repos/${common.REPOSITORY}/releases/7/assets{?name,label}`, "a b.tgz", payload);
  const parsed = new URL((calls[0] as CapturedCall).url);
  assert.equal(parsed.pathname, `/repos/${common.REPOSITORY}/releases/7/assets`);
  // The raw query is percent-encoded; the decoded value round-trips.
  assert.ok(parsed.search.includes("name=a%20b.tgz"), `raw query: ${parsed.search}`);
  assert.equal(parsed.searchParams.get("name"), "a b.tgz");
  assertNativeRequestAccepts(calls[0] as CapturedCall);
});

test("getTag reads the bare ref (no refs/ prefix) and createTagRef keeps it in the body", async () => {
  const { api, calls } = makeClient((call) => {
    if (call.url.endsWith("/git/ref/tags%2Fb2")) return { status: 200, text: JSON.stringify({ ref: "refs/tags/b2", object: { sha: "a".repeat(40), type: "commit" } }) };
    if (new URL(call.url).pathname === `/repos/${common.REPOSITORY}/git/refs`) return { status: 201, text: JSON.stringify({ ref: "refs/tags/b2" }) };
    return { status: 404, text: JSON.stringify({ message: `unrouted ${call.url}` }) };
  });
  const tag = await api.getTag("refs/tags/b2");
  assert.ok(tag);
  assert.equal((calls[0] as CapturedCall).url, `${API_BASE}/git/ref/tags%2Fb2`);
  assertNativeRequestAccepts(calls[0] as CapturedCall);
  const created = await api.createTagRef("refs/tags/b2", "a".repeat(40));
  assert.equal(created.status, 201);
  const body = JSON.parse(String((calls[1] as CapturedCall).init?.body ?? "{}")) as { ref: string; sha: string };
  assert.equal(body.ref, "refs/tags/b2", "the create-ref body must keep the full refs/ form");
  assert.equal(body.sha, "a".repeat(40));
});

test("getTag resolves to null on 404 (absent ref)", async () => {
  const { api } = makeClient(() => ({ status: 404, text: JSON.stringify({ message: "Not Found" }) }));
  assert.equal(await api.getTag("refs/tags/b9"), null);
});

test("getPullRequest returns the detailed record and resolves 404 to null", async () => {
  const detail = { number: 7, state: "closed", merged: true, merge_commit_sha: "a".repeat(40) };
  const { api } = makeClient((call) => {
    if (new URL(call.url).pathname === `/repos/${common.REPOSITORY}/pulls/7`) return { status: 200, text: JSON.stringify(detail) };
    if (new URL(call.url).pathname === `/repos/${common.REPOSITORY}/pulls/8`) return { status: 404, text: JSON.stringify({ message: "Not Found" }) };
    return { status: 500, text: "{}" };
  });
  assert.deepEqual(await api.getPullRequest(7), detail);
  assert.equal(await api.getPullRequest(8), null);
});

test("listReleases stops at a short page and is bounded by maxPages", async () => {
  // Page 1: full (2 items with per_page=2), page 2: short -> stop.
  const { api, calls } = makeClient((call) => {
    const page = Number(new URL(call.url).searchParams.get("page") ?? "1");
    const items = page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }];
    return { status: 200, text: JSON.stringify(items) };
  });
  const releases = await api.listReleases({ perPage: 2, maxPages: 5 });
  assert.deepEqual(releases.map((release) => release.id), [1, 2, 3]);
  assert.equal(calls.length, 2, "a short page must end pagination");

  // All pages full: the maxPages cap bounds the walk.
  const cappedCalls: CapturedCall[] = [];
  const cappedFetch = async (url: string, init?: CapturedCall["init"]) => {
    cappedCalls.push({ url, init });
    return { status: 200, text: async () => JSON.stringify([{ id: 1 }, { id: 2 }]), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const cappedApi = common.createApi({ fetchImpl: cappedFetch, token: TOKEN, repository: common.REPOSITORY });
  const capped = await cappedApi.listReleases({ perPage: 2, maxPages: 3 });
  assert.equal(capped.length, 6);
  assert.equal(cappedCalls.length, 3, "pagination must never exceed maxPages");

  // Non-200 fails closed.
  const failing = makeClient(() => ({ status: 500, text: JSON.stringify({ message: "boom" }) }));
  await assert.rejects(failing.api.listReleases(), /list releases failed/);
});

test("getCommitPullRequests returns the list-shaped association and fails closed on malformed bodies", async () => {
  const items = [{ id: 1, number: 7, state: "closed", merged_at: "2026-01-02T00:00:00Z" }];
  const { api } = makeClient((call) => {
    if (/\/commits\/[0-9a-f]{40}\/pulls$/.test(new URL(call.url).pathname)) return { status: 200, text: JSON.stringify(items) };
    return { status: 500, text: "{}" };
  });
  assert.deepEqual(await api.getCommitPullRequests("a".repeat(40)), items);

  const malformed = makeClient(() => ({ status: 200, text: JSON.stringify({ not: "an array" }) }));
  await assert.rejects(malformed.api.getCommitPullRequests("a".repeat(40)), /malformed/);
});

test("JSON endpoints never attach a body to GET requests", async () => {
  const { api, calls } = makeClient(() => ({ status: 200, text: "[]" }));
  await api.getReleaseByTag("b2");
  await api.listReleases({ perPage: 1, maxPages: 1 });
  for (const call of calls) {
    assert.equal(call.init?.method, "GET");
    assert.equal((call.init as { body?: unknown } | undefined)?.body, undefined, `GET ${call.url} must not carry a body`);
    assertNativeRequestAccepts(call);
  }
});

test("createApi rejects missing or control-character tokens", () => {
  assert.throws(() => common.createApi({ fetchImpl: async () => ({ status: 200, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) }), token: "", repository: common.REPOSITORY }), /GITHUB_TOKEN is required/);
  assert.throws(() => common.createApi({ fetchImpl: async () => ({ status: 200, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) }), token: "bad\r\ntoken", repository: common.REPOSITORY }), /control characters/);
});
