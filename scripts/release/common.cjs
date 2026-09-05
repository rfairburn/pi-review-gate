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
  // ever provided for POST/PATCH calls; GET/DELETE carry no body.
  async function jsonRequest(method, path, body) {
    const url = `${root}${path}`;
    const headers = authHeaders({ Accept: "application/vnd.github+json" });
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const init = { method, headers };
    if (payload !== undefined) init.body = payload;
    const response = await fetchImpl(url, init);
    const text = await response.text();
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
  async function binaryRequest(method, url, { headers, payload } = {}) {
    if ((method === "GET" || method === "HEAD") && payload !== undefined) {
      throw new ReleaseError(`binary ${method} requests must not carry a body`);
    }
    const init = { method, headers: authHeaders(headers ?? {}) };
    if (payload !== undefined) init.body = payload;
    const response = await fetchImpl(url, init);
    const bytes = Buffer.from(await response.arrayBuffer());
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
      const result = await jsonRequest("GET", `/git/ref/${encodeURIComponent(bareRef)}`);
      return result.status === 200 ? result.json : null;
    },
    async createTagRef(ref, sha) {
      return jsonRequest("POST", "/git/refs", { ref, sha });
    },
    // GET /releases/tags/{tag} returns only PUBLISHED releases; unpublished
    // drafts are 404 here and must be located via listReleases instead.
    async getReleaseByTag(tag) {
      const result = await jsonRequest("GET", `/releases/tags/${encodeURIComponent(tag)}`);
      return result.status === 200 ? result.json : null;
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
        const result = await jsonRequest("GET", `/releases?per_page=${perPage}&page=${page}`);
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
      return jsonRequest("POST", "/releases", body);
    },
    async updateRelease(releaseId, body) {
      return jsonRequest("PATCH", `/releases/${releaseId}`, body);
    },
    async getRelease(releaseId) {
      const result = await jsonRequest("GET", `/releases/${releaseId}`);
      return result.status === 200 ? result.json : null;
    },
    // List-shaped association items for a commit (simplified PR objects; they
    // do not carry the detailed `merged` boolean). Bounded pagination.
    async getCommitPullRequests(sha, { perPage = 100, maxPages = 3 } = {}) {
      const all = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const result = await jsonRequest(
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
      const result = await jsonRequest("GET", `/pulls/${number}`);
      if (result.status === 404) return null;
      if (result.status !== 200) {
        throw new ReleaseError(`GitHub API fetch pull request #${number} failed: ${describeApiError(result, result.text)}`);
      }
      return result.json;
    },
    async uploadAsset(uploadUrl, name, buffer) {
      const url = assetUploadUrl(uploadUrl, name);
      const result = await binaryRequest("POST", url, {
        headers: { Accept: "application/vnd.github+json", "Content-Type": "application/octet-stream" },
        payload: buffer,
      });
      return assertOk(result, `upload asset ${name}`).json;
    },
    async downloadAsset(assetId) {
      // Binary GET: no body at all; the 302 to blob storage is followed by
      // fetch and the final response carries the raw asset bytes.
      const result = await binaryRequest("GET", `${root}/releases/assets/${assetId}`, {
        headers: { Accept: "application/octet-stream" },
      });
      return { buffer: result.bytes, status: result.status };
    },
    async deleteAsset(assetId, name) {
      const result = await jsonRequest("DELETE", `/releases/assets/${assetId}`);
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
  HEX40,
  MAIN_REF,
  ReleaseError,
  REPOSITORY,
  TAG_PREFIX,
  assertReleaseEventContext,
  createApi,
  git,
  isHexSha,
  sha256Buffer,
};
