"use strict";

// Shared constants and helpers for the bounded numbered prerelease builder.
//
// Identity is pinned to exactly one repository, one immutable baseline commit,
// and one release convention (tag `b<N>`, package `0.1.0-dev.<N>`) where `N` is
// the pure first-parent distance from the baseline to the released commit.

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");

const REPOSITORY = "rfairburn/pi-review-gate";
const BASELINE_SHA = "f7c174f1c12c81447bce2ab1aa39fb5faf4331ec";
// Policy-adoption anchor for per-build changelog attribution and release
// notes: the main commit at the moment per-build attribution was adopted
// (b4, `0.1.0-dev.4`, the last build published in the legacy body format). The
// boundary is this immutable source SHA — not a scan of section presence, so
// the very first adopted build cannot be reclassified as legacy by omitting
// its own notes, and not mutable "latest release" state. Every strict
// first-parent descendant of this commit published by a producer carrying this
// policy requires exact per-build notes; this commit and its ancestors keep
// read-only legacy verification (a producer always runs from the pushed
// commit's own source, so earlier builds verify with their own code).
const POLICY_ADOPTION_ANCHOR = "bba091c2058fa05eab44e76a59b1b16845c2671c";
const BASE_VERSION = "0.1.0";
const TAG_PREFIX = "b";
const MAIN_REF = "refs/heads/main";
const HEX40 = /^[0-9a-f]{40}$/;
const API_VERSION = "2022-11-28";

// Fail-closed error type: every eligibility, integrity, or identity violation
// is reported through this class so callers can distinguish rejection from bugs.
class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseError";
  }
}

// The reusable workflow is only ever published from the original push event on
// the scoped repository's main branch. Reusable workflow_call runs inherit the
// caller's original event context (GitHub docs: `github.event`, `github.sha`,
// and the derived env vars come from the triggering event), so re-validating
// the env here independently enforces push/main/repo and pins the target SHA.
function assertReleaseEventContext(env) {
  const problems = [];
  if (env.GITHUB_EVENT_NAME !== "push") {
    problems.push(`GITHUB_EVENT_NAME must be "push", got ${JSON.stringify(env.GITHUB_EVENT_NAME ?? null)}`);
  }
  if (env.GITHUB_REF !== MAIN_REF) {
    problems.push(`GITHUB_REF must be "${MAIN_REF}", got ${JSON.stringify(env.GITHUB_REF ?? null)}`);
  }
  if (env.GITHUB_REF_TYPE !== "branch") {
    problems.push(`GITHUB_REF_TYPE must be "branch", got ${JSON.stringify(env.GITHUB_REF_TYPE ?? null)}`);
  }
  if (env.GITHUB_REPOSITORY !== REPOSITORY) {
    problems.push(`GITHUB_REPOSITORY must be "${REPOSITORY}", got ${JSON.stringify(env.GITHUB_REPOSITORY ?? null)}`);
  }
  if (!HEX40.test(env.GITHUB_SHA ?? "")) {
    problems.push(`GITHUB_SHA must be a 40-hex commit SHA, got ${JSON.stringify(env.GITHUB_SHA ?? null)}`);
  }
  if (problems.length > 0) {
    throw new ReleaseError(`release event context rejected: ${problems.join("; ")}`);
  }
  return { target: env.GITHUB_SHA, repository: REPOSITORY, ref: MAIN_REF };
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isHexSha(value) {
  return typeof value === "string" && HEX40.test(value);
}

// All git access goes through argv arrays with execFileSync: no shell, no
// interpolation of untrusted values into a command string.
function git(args, options = {}) {
  return execFileSync("git", ["-C", options.repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function describeApiError(response, bodyText) {
  return `status ${response.status}${bodyText ? ` body ${JSON.stringify(bodyText.slice(0, 400))}` : ""}`;
}

// ---------------------------------------------------------------------------
// Transport attribution for the release API client
//
// A publication that died at the network reported only
// `release failed closed: fetch failed`: Node reports every failed fetch with
// that one message and the publisher CLI printed the rejection's message, so
// which API call died, whether it died sending the request or reading the
// response body, and the underlying code were all discarded. These helpers
// attribute a rejection at the two fetch boundaries of this client so the CLI
// can add one bounded diagnostics line.
//
// Invariants:
//  - The original rejection is always rethrown unchanged: same object identity,
//    prototype, message, and stack. Attribution is stored only in this module
//    (the WeakMap below for object rejections, or the single primitive slot) and
//    never on the error, so frozen and non-extensible errors are attributed
//    without being modified, and a failure inside attribution can never replace
//    the original failure.
//  - A rejection that is not an object — a bare secret-bearing string, for
//    example — is attributed too, so the CLI can never echo it: it gets the same
//    closed operation and boundary labels with the static `unclassified`
//    transport.
//  - The line is built only from static literals: a closed operation label, a
//    closed boundary label, and error `name`/`code` values matching the closed
//    allowlists below exactly. Messages, stacks, URLs, query values, headers,
//    bodies, hostnames, addresses, paths, environment, argv, and raw objects
//    are never echoed; anything unmatched becomes the static `unclassified`.
//  - Every property read is guarded and traversal is bounded (visited set, node
//    cap, aggregate-child cap, label cap), so circular, throwing, or proxied
//    error trees terminate with a short line.
//  - Reporting-only: no retry, timeout, gate, or publication-policy behavior
//    lives here.
const RELEASE_TRANSPORT_OPERATIONS = Object.freeze({
  getCommitPullRequests: "get-commit-pull-requests",
  getPullRequest: "get-pull-request",
  getTag: "get-tag",
  createTagRef: "create-tag-ref",
  getReleaseByTag: "get-release-by-tag",
  listReleases: "list-releases",
  createRelease: "create-release-draft",
  getRelease: "get-release",
  updateRelease: "update-release",
  // The draft identity write and the final publication write are the same API
  // method, so their call sites label them apart: that distinction is the
  // attribution this client could not previously make at all.
  updateDraftIdentity: "update-draft-identity",
  publishRelease: "publish-release",
  uploadAsset: "upload-asset",
  downloadAsset: "download-asset",
  deleteAsset: "delete-asset",
});
const RELEASE_TRANSPORT_BOUNDARIES = Object.freeze({
  request: "request",
  responseBody: "response-body",
});
const TRANSPORT_UNCLASSIFIED = "unclassified";
const TRANSPORT_DIAGNOSTICS_PREFIX = "release diagnostics: ";
// Closed allowlists of the underlying failure identities. Only these exact
// literals can ever be emitted; every other name or code contributes nothing
// and a chain with no match reports the static `unclassified`.
const TRANSPORT_ERROR_NAMES = Object.freeze([
  "TypeError", "SocketError", "ConnectTimeoutError", "HeadersTimeoutError",
  "BodyTimeoutError", "AbortError", "TimeoutError", "AggregateError",
]);
const TRANSPORT_ERROR_CODES = Object.freeze([
  // Socket and DNS level failures.
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "ENETRESET", "EADDRNOTAVAIL",
  // Process resource exhaustion while opening a socket.
  "EMFILE", "ENFILE",
  // Undici (Node fetch) own error codes.
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_DESTROYED", "UND_ERR_ABORTED",
  // TLS trust and handshake failures.
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT", "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID", "CERT_UNTRUSTED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_PROTOCOL_ERROR", "WRONG_VERSION_NUMBER",
]);
// Hard bounds on the traversal of an attacker-shaped cause tree.
const MAX_TRANSPORT_NODES = 8;
const MAX_TRANSPORT_AGGREGATE_CHILDREN = 3;
const MAX_TRANSPORT_LABELS = 3;
// The single canonical metadata store: keyed by the rejected value itself, so
// nothing is ever written onto a caller's error and no second copy exists.
// Object/function rejections use the WeakMap; a primitive rejection value cannot
// key one, so it uses the one-slot `primitiveTransportAttribution` below. Each
// rejection lives in exactly one of the two, never both.
const transportAttributions = new WeakMap();
let primitiveTransportAttribution;
const TRANSPORT_OPERATION_LABELS = new Set(Object.values(RELEASE_TRANSPORT_OPERATIONS));
const TRANSPORT_BOUNDARY_LABELS = new Set(Object.values(RELEASE_TRANSPORT_BOUNDARIES));

// Reads one property defensively: a hostile getter or a revoked Proxy yields no
// value instead of throwing out of the classifier.
function readTransportField(target, key) {
  try {
    return target[key];
  } catch {
    return undefined;
  }
}

function transportLabelOf(node) {
  const code = readTransportField(node, "code");
  if (typeof code === "string" && TRANSPORT_ERROR_CODES.includes(code)) return code;
  const name = readTransportField(node, "name");
  if (typeof name === "string" && TRANSPORT_ERROR_NAMES.includes(name)) return name;
  return undefined;
}

// Next nodes to walk: the `cause` of every node, plus bounded members of
// `errors` for an AggregateError. Index reads are individually guarded because
// a hostile array can throw on `length`, on an index, or on both.
function transportChildrenOf(node) {
  const children = [];
  if (readTransportField(node, "name") === "AggregateError") {
    const errors = readTransportField(node, "errors");
    let isArray = false;
    try {
      isArray = Array.isArray(errors);
    } catch {
      isArray = false;
    }
    if (isArray) {
      for (let index = 0; index < MAX_TRANSPORT_AGGREGATE_CHILDREN; index += 1) {
        const child = readTransportField(errors, index);
        if (child === undefined) break;
        children.push(child);
      }
    }
  }
  const cause = readTransportField(node, "cause");
  if (cause !== undefined) children.push(cause);
  return children;
}

function transportChain(error) {
  const labels = [];
  const visited = new Set();
  const pending = [error];
  while (pending.length > 0 && labels.length < MAX_TRANSPORT_LABELS && visited.size < MAX_TRANSPORT_NODES) {
    const node = pending.shift();
    if (!node || (typeof node !== "object" && typeof node !== "function")) continue;
    if (visited.has(node)) continue;
    visited.add(node);
    const label = transportLabelOf(node);
    if (label && !labels.includes(label)) labels.push(label);
    for (const child of transportChildrenOf(node)) pending.push(child);
  }
  return labels;
}

// Records which operation and boundary a rejection came from. Called only from
// the catch of a fetch boundary; the caller always rethrows the original value.
// An object or function rejection is keyed by identity in the WeakMap. A
// primitive rejection (a thrown string, number, bigint, symbol, null, boolean,
// or undefined) has no identity a WeakMap can key and can never be annotated, so
// the single most recent primitive transport rejection is kept in one bounded
// invocation-scoped slot. Every rejection is recorded in exactly one place: the
// slot never duplicates a WeakMap entry, and only the slot's own value ever
// matches it. The stored value is never emitted — it is compared by Object.is.
function attributeTransport(operation, boundary, error) {
  const attribution = Object.freeze({
    operation: TRANSPORT_OPERATION_LABELS.has(operation) ? operation : TRANSPORT_UNCLASSIFIED,
    boundary: TRANSPORT_BOUNDARY_LABELS.has(boundary) ? boundary : TRANSPORT_UNCLASSIFIED,
  });
  if (error && (typeof error === "object" || typeof error === "function")) {
    transportAttributions.set(error, attribution);
    return;
  }
  primitiveTransportAttribution = Object.freeze({ value: error, ...attribution });
}

// Runs one fetch boundary, attributing a rejection before rethrowing it whole.
async function observeTransport(operation, boundary, run) {
  try {
    return await run();
  } catch (error) {
    try {
      attributeTransport(operation, boundary, error);
    } catch {
      // Attribution is best effort and must never replace the real failure.
    }
    throw error;
  }
}

// The one diagnostics line for an attributed failure, or null when this error
// never crossed a fetch boundary. Every field is a closed literal; the line is
// short, single-line, and carries no `::` workflow-command prefix.
function describeReleaseTransport(error) {
  let attribution;
  try {
    if (error && (typeof error === "object" || typeof error === "function")) {
      attribution = transportAttributions.get(error);
    } else if (primitiveTransportAttribution && Object.is(primitiveTransportAttribution.value, error)) {
      attribution = primitiveTransportAttribution;
    }
  } catch {
    return null;
  }
  if (!attribution) return null;
  let transport = TRANSPORT_UNCLASSIFIED;
  try {
    const labels = transportChain(error);
    if (labels.length > 0) transport = labels.join("<");
  } catch {
    transport = TRANSPORT_UNCLASSIFIED;
  }
  return `${TRANSPORT_DIAGNOSTICS_PREFIX}op=${attribution.operation} boundary=${attribution.boundary} transport=${transport}`;
}

// Minimal GitHub REST client. `fetchImpl` is injectable for deterministic
// local tests; in CI it is the global fetch. Tokens are only ever sent as
// request headers and are never logged.
//
// Request payload handling and response decoding are kept strictly separate:
// a body is attached only to POST/PATCH/PUT calls that carry an explicit
// payload, and GET requests never set `init.body` at all (Node's native fetch
// rejects a GET with any body). Binary responses (asset download) are read via
// arrayBuffer; JSON responses via text.
function createApi({ fetchImpl, token, repository }) {
  if (!token) throw new ReleaseError("GITHUB_TOKEN is required for release API calls");
  if (!/^[^\r\n]+$/.test(token)) throw new ReleaseError("GITHUB_TOKEN contains control characters");
  const root = `https://api.github.com/repos/${repository}`;
  function authHeaders(extra) {
    return {
      "X-GitHub-Api-Version": API_VERSION,
      Authorization: `Bearer ${token}`,
      "User-Agent": "pi-review-gate-release",
      ...extra,
    };
  }

  // JSON request/response for the repository REST endpoints. `body` is only
  // ever provided for POST/PATCH calls; GET/DELETE carry no body. `operation` is
  // always a source literal from RELEASE_TRANSPORT_OPERATIONS.
  async function jsonRequest(operation, method, path, body) {
    const url = `${root}${path}`;
    const headers = authHeaders({ Accept: "application/vnd.github+json" });
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const init = { method, headers };
    if (payload !== undefined) init.body = payload;
    const response = await observeTransport(operation, RELEASE_TRANSPORT_BOUNDARIES.request, () => fetchImpl(url, init));
    const text = await observeTransport(operation, RELEASE_TRANSPORT_BOUNDARIES.responseBody, () => response.text());
    let json;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: response.status, json, text };
  }

  // Binary request/response for asset upload and download. `payload` is a
  // Buffer carried only on POST; GETs never carry a body. The response bytes
  // are read raw (asset downloads redirect to blob storage and return the
  // file bytes; uploads return JSON, which is parsed best-effort).
  async function binaryRequest(operation, method, url, { headers, payload } = {}) {
    if ((method === "GET" || method === "HEAD") && payload !== undefined) {
      throw new ReleaseError(`binary ${method} requests must not carry a body`);
    }
    const init = { method, headers: authHeaders(headers ?? {}) };
    if (payload !== undefined) init.body = payload;
    const response = await observeTransport(operation, RELEASE_TRANSPORT_BOUNDARIES.request, () => fetchImpl(url, init));
    const bytes = Buffer.from(await observeTransport(operation, RELEASE_TRANSPORT_BOUNDARIES.responseBody, () => response.arrayBuffer()));
    const text = bytes.toString("utf8");
    let json;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    return { status: response.status, json, text, bytes };
  }

  function assertOk(result, action) {
    if (result.status < 200 || result.status >= 300) {
      throw new ReleaseError(`GitHub API ${action} failed: ${describeApiError(result, result.text)}`);
    }
    return result;
  }

  // GitHub documents the release upload_url as
  // ".../assets?name={name}&label={label}"; template-style ".../assets{?name,label}"
  // is also handled. The resulting URL carries exactly one name parameter and
  // never sends a placeholder value (the unused label param is dropped).
  function assetUploadUrl(uploadUrl, name) {
    if (uploadUrl.includes("{name}")) {
      const url = new URL(uploadUrl);
      url.searchParams.set("name", name);
      url.searchParams.delete("label");
      return url.toString();
    }
    const base = uploadUrl.split("{")[0];
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}name=${encodeURIComponent(name)}`;
  }

  return {
    async getTag(ref) {
      // GET /git/ref/{ref} expects the ref WITHOUT the refs/ prefix
      // (e.g. tags/b1); the create-ref JSON body keeps the full refs/tags form.
      const bareRef = ref.startsWith("refs/") ? ref.slice("refs/".length) : ref;
      const result = await jsonRequest(RELEASE_TRANSPORT_OPERATIONS.getTag, "GET", `/git/ref/${encodeURIComponent(bareRef)}`);
      return result.status === 200 ? result.json : null;
    },
    async createTagRef(ref, sha) {
      return jsonRequest(RELEASE_TRANSPORT_OPERATIONS.createTagRef, "POST", "/git/refs", { ref, sha });
    },
    // GET /releases/tags/{tag} returns only PUBLISHED releases; unpublished
    // drafts are 404 here and must be located via listReleases instead.
    async getReleaseByTag(tag) {
      const result = await jsonRequest(RELEASE_TRANSPORT_OPERATIONS.getReleaseByTag, "GET", `/releases/tags/${encodeURIComponent(tag)}`);
      if (result.status === 404) return null;
      if (result.status !== 200) {
        throw new ReleaseError(`GitHub API get release by tag failed: ${describeApiError(result, result.text)}`);
      }
      return result.json;
    },
    // Authenticated release listing, which (unlike the tag endpoint) includes
    // draft releases. Bounded pagination: at most maxPages pages of perPage.
    // A short (partial) page proves the listing is complete. Exhausting the
    // cap with a still-full final page means the listing may be truncated, so
    // it cannot certify the absence of any release (for example an orphaned
    // owned draft); the walk then fails closed with a bounded, body-free
    // error instead of returning a partial result or issuing more requests.
    async listReleases({ perPage = 100, maxPages = 5 } = {}) {
      const releases = [];
      let complete = false;
      for (let page = 1; page <= maxPages; page += 1) {
        const result = await jsonRequest(RELEASE_TRANSPORT_OPERATIONS.listReleases, "GET", `/releases?per_page=${perPage}&page=${page}`);
        if (result.status !== 200) {
          throw new ReleaseError(`GitHub API list releases failed: ${describeApiError(result, result.text)}`);
        }
        if (!Array.isArray(result.json)) {
          throw new ReleaseError("GitHub API list releases returned a malformed body");
        }
        releases.push(...result.json);
        if (result.json.length < perPage) {
          complete = true;
          break;
        }
      }
      if (!complete) {
        throw new ReleaseError(
          `GitHub API list releases reached the bounded pagination cap of ${maxPages} pages of ${perPage} with a full final page; the listing may be truncated and cannot certify the absence of a release; failing closed (request count stays bounded)`,
        );
      }
      return releases;
    },
    async createRelease(body) {
      return jsonRequest(RELEASE_TRANSPORT_OPERATIONS.createRelease, "POST", "/releases", body);
    },
    // `operation` distinguishes the two draft PATCHes (identity write versus the
    // publication write). It is only ever a RELEASE_TRANSPORT_OPERATIONS label;
    // anything else reports the static `unclassified` operation.
    async updateRelease(releaseId, body, operation) {
      return jsonRequest(operation ?? RELEASE_TRANSPORT_OPERATIONS.updateRelease, "PATCH", `/releases/${releaseId}`, body);
    },
    async getRelease(releaseId) {
      const result = await jsonRequest(RELEASE_TRANSPORT_OPERATIONS.getRelease, "GET", `/releases/${releaseId}`);
      return result.status === 200 ? result.json : null;
    },
    // List-shaped association items for a commit (simplified PR objects; they
    // do not carry the detailed `merged` boolean). Bounded pagination.
    async getCommitPullRequests(sha, { perPage = 100, maxPages = 3 } = {}) {
      const all = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const result = await jsonRequest(
          RELEASE_TRANSPORT_OPERATIONS.getCommitPullRequests,
          "GET",
          `/commits/${encodeURIComponent(sha)}/pulls?per_page=${perPage}&page=${page}`,
        );
        if (result.status !== 200) {
          throw new ReleaseError(`GitHub API list commit pull requests failed: ${describeApiError(result, result.text)}`);
        }
        if (!Array.isArray(result.json)) {
          throw new ReleaseError("GitHub API commit pull request association is malformed");
        }
        all.push(...result.json);
        if (result.json.length < perPage) break;
      }
      return all;
    },
    // Detailed pull request record: carries the authoritative `merged`
    // boolean, merge_commit_sha, and base identity. 404 resolves to null.
    async getPullRequest(number) {
      const result = await jsonRequest(RELEASE_TRANSPORT_OPERATIONS.getPullRequest, "GET", `/pulls/${number}`);
      if (result.status === 404) return null;
      if (result.status !== 200) {
        throw new ReleaseError(`GitHub API fetch pull request #${number} failed: ${describeApiError(result, result.text)}`);
      }
      return result.json;
    },
    async uploadAsset(uploadUrl, name, buffer) {
      const url = assetUploadUrl(uploadUrl, name);
      const result = await binaryRequest(RELEASE_TRANSPORT_OPERATIONS.uploadAsset, "POST", url, {
        headers: { Accept: "application/vnd.github+json", "Content-Type": "application/octet-stream" },
        payload: buffer,
      });
      return assertOk(result, `upload asset ${name}`).json;
    },
    async downloadAsset(assetId) {
      // Binary GET: no body at all; the 302 to blob storage is followed by
      // fetch and the final response carries the raw asset bytes.
      const result = await binaryRequest(RELEASE_TRANSPORT_OPERATIONS.downloadAsset, "GET", `${root}/releases/assets/${assetId}`, {
        headers: { Accept: "application/octet-stream" },
      });
      return { buffer: result.bytes, status: result.status };
    },
    async deleteAsset(assetId, name) {
      const result = await jsonRequest(RELEASE_TRANSPORT_OPERATIONS.deleteAsset, "DELETE", `/releases/assets/${assetId}`);
      if (result.status !== 204) {
        throw new ReleaseError(`GitHub API delete asset ${name} failed: ${describeApiError(result, result.text)}`);
      }
    },
  };
}

module.exports = {
  API_VERSION,
  BASELINE_SHA,
  BASE_VERSION,
  POLICY_ADOPTION_ANCHOR,
  HEX40,
  MAIN_REF,
  RELEASE_TRANSPORT_BOUNDARIES,
  RELEASE_TRANSPORT_OPERATIONS,
  ReleaseError,
  REPOSITORY,
  TAG_PREFIX,
  assertReleaseEventContext,
  createApi,
  describeReleaseTransport,
  git,
  isHexSha,
  sha256Buffer,
};
