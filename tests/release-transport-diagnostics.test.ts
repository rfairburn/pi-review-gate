import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { loadReleaseModule, projectRoot } from "./helpers/release-scripts";
import type { ReleaseApi } from "./helpers/release-scripts";

// Contract tests for publisher transport attribution: which API operation and
// which fetch boundary a rejection came from, and what the publisher CLI may
// print about it. The risk these guard: a failed publication previously said
// only `fetch failed`, and any richer reporting risks leaking a URL, a signed
// redirect, a token, or an arbitrary hostile error tree into public logs.

const common = loadReleaseModule<{
  REPOSITORY: string;
  RELEASE_TRANSPORT_OPERATIONS: Record<string, string>;
  RELEASE_TRANSPORT_BOUNDARIES: { request: string; responseBody: string };
  describeReleaseTransport(error: unknown): string | null;
  createApi(options: { fetchImpl: unknown; token: string; repository: string }): ReleaseApi;
}>("common.cjs");

const TOKEN = "test-token";
// Sentinels planted everywhere a diagnostic could leak. None may ever appear.
const SECRET_TOKEN = "ghp_SENTINEL_plaintext_token_0123456789";
const SECRET_URL = "https://objects.githubusercontent.com/private/asset.zip?token=SENTINEL-signed-redirect";
const SECRET_HOST = "secret-host.internal";
const SECRET_PATH = "/home/private/runner/_work/secret";
const FORGED_COMMAND = "::error::release succeeded";
const BASE64_BLOB = "U2VudGluZWxCbG9iTUxNSU5MRVhBSFZBS0pDRk5PSlBVUVZSWFpDSEtMTU5PUFVRVZSWFo=";
const SENTINELS = [SECRET_TOKEN, SECRET_URL, SECRET_HOST, SECRET_PATH, FORGED_COMMAND, BASE64_BLOB, "malformed cause message", "10.0.0.8"];

// The exact public shape of the single added line: closed literals only, on one
// line, with at most three allowlisted transport labels and no `::` prefix.
const DIAGNOSTICS_RE = /^release diagnostics: op=[a-z][a-z0-9-]* boundary=(?:request|response-body) transport=[A-Za-z][A-Za-z0-9_]*(?:<[A-Za-z][A-Za-z0-9_]*){0,2}$/;

function assertSecretFree(text: string, context: string) {
  for (const sentinel of SENTINELS) {
    assert.ok(!text.includes(sentinel), `${context} must not contain a planted secret (${sentinel.slice(0, 12)}...)`);
  }
}

function assertBoundedDiagnostics(diagnostics: string | null, context: string): string {
  assert.ok(typeof diagnostics === "string", `${context}: an attributed failure yields one line`);
  const line = diagnostics as string;
  assert.match(line, DIAGNOSTICS_RE, context);
  assert.ok(line.length <= 200, `${context}: line stays bounded (${line.length})`);
  assert.ok(!line.includes("\n") && !line.includes("\r"), `${context}: one line only`);
  assert.ok(!line.startsWith("::"), `${context}: never a workflow command`);
  assertSecretFree(line, context);
  return line;
}

type Boundary = "request" | "response-body";

// A client whose injected fetch fails at one boundary with `rejection`.
function rejectingClient(rejection: unknown, boundary: Boundary) {
  const fetchImpl = async () => {
    if (boundary === "request") throw rejection;
    return {
      status: 200,
      text: async () => {
        throw rejection;
      },
      arrayBuffer: async () => {
        throw rejection;
      },
    };
  };
  return common.createApi({ fetchImpl, token: TOKEN, repository: common.REPOSITORY });
}

async function capture(
  rejection: unknown,
  call: (api: ReleaseApi) => Promise<unknown>,
  boundary: Boundary = "request",
): Promise<{ rejection: unknown; diagnostics: string | null }> {
  try {
    await call(rejectingClient(rejection, boundary));
  } catch (error) {
    return { rejection: error, diagnostics: common.describeReleaseTransport(error) };
  }
  throw new Error("expected the injected fetch boundary to reject");
}

function withCause(error: Error, cause: unknown): Error {
  return new (error.constructor as new (message: string, options?: { cause?: unknown }) => Error)(error.message, { cause });
}

// --- Operation and boundary attribution -------------------------------------

test("every API method attributes its own static operation label at the request boundary", async () => {
  const ops = common.RELEASE_TRANSPORT_OPERATIONS;
  const cases: Array<[string, (api: ReleaseApi) => Promise<unknown>]> = [
    [ops.getCommitPullRequests, (api) => api.getCommitPullRequests("a".repeat(40))],
    [ops.getPullRequest, (api) => api.getPullRequest(7)],
    [ops.getTag, (api) => api.getTag("refs/tags/b2")],
    [ops.createTagRef, (api) => api.createTagRef("refs/tags/b2", "a".repeat(40))],
    [ops.getReleaseByTag, (api) => api.getReleaseByTag("b2")],
    [ops.listReleases, (api) => api.listReleases()],
    [ops.createRelease, (api) => api.createRelease({ tag_name: "b2" })],
    [ops.getRelease, (api) => api.getRelease(1)],
    [ops.updateRelease, (api) => api.updateRelease(1, { draft: true })],
    [ops.uploadAsset, (api) => api.uploadAsset("https://uploads.github.com/repos/x/releases/1/assets", "asset.tgz", Buffer.from("bytes"))],
    [ops.downloadAsset, (api) => api.downloadAsset(1)],
    [ops.deleteAsset, (api) => api.deleteAsset(1, "asset.tgz")],
  ];
  assert.equal(cases.length, Object.keys(ops).length - 2, "one case per method plus the two call-site labels");
  for (const [label, call] of cases) {
    const rejection = new TypeError("fetch failed");
    const { rejection: caught, diagnostics } = await capture(rejection, call);
    assert.equal(caught, rejection, `${label}: the original rejection is rethrown unchanged`);
    assert.equal(diagnostics, `release diagnostics: op=${label} boundary=request transport=TypeError`);
  }
});

test("the draft identity write and the publication PATCH carry distinct operation labels", async () => {
  const ops = common.RELEASE_TRANSPORT_OPERATIONS;
  assert.equal(ops.updateDraftIdentity, "update-draft-identity");
  assert.equal(ops.publishRelease, "publish-release");
  assert.notEqual(ops.updateDraftIdentity, ops.publishRelease);
  assert.notEqual(ops.updateDraftIdentity, ops.updateRelease);
  // The two boundaries are the only ones this client can report.
  assert.deepEqual(common.RELEASE_TRANSPORT_BOUNDARIES, { request: "request", responseBody: "response-body" });

  for (const [operation, expected] of [
    [ops.updateDraftIdentity, "update-draft-identity"],
    [ops.publishRelease, "publish-release"],
    [undefined, "update-release"],
  ] as Array<[string | undefined, string]>) {
    const { diagnostics } = await capture(new TypeError("fetch failed"), (api) => api.updateRelease(1, { draft: operation === ops.publishRelease }, operation));
    assert.equal(diagnostics, `release diagnostics: op=${expected} boundary=request transport=TypeError`);
  }

  // A caller-supplied label is never echoed: only closed literals are emitted.
  const forged = await capture(new TypeError("fetch failed"), (api) => api.updateRelease(1, { draft: true }, `forged ${SECRET_URL}`));
  assert.equal(forged.diagnostics, `release diagnostics: op=unclassified boundary=request transport=TypeError`);
});

test("JSON and binary response-body failures are attributed at the response-body boundary", async () => {
  const rejection = withCause(new Error("terminated"), { code: "UND_ERR_SOCKET", message: SECRET_URL });
  const json = await capture(rejection, (api) => api.getRelease(1), "response-body");
  assert.equal(json.rejection, rejection, "the body-read rejection reaches the caller unchanged");
  assert.equal(json.diagnostics, "release diagnostics: op=get-release boundary=response-body transport=UND_ERR_SOCKET");

  const binary = await capture(rejection, (api) => api.downloadAsset(1), "response-body");
  assert.equal(binary.rejection, rejection);
  assert.equal(binary.diagnostics, "release diagnostics: op=download-asset boundary=response-body transport=UND_ERR_SOCKET");

  const upload = await capture(rejection, (api) => api.uploadAsset("https://uploads.github.com/x", "a.tgz", Buffer.from("bytes")), "response-body");
  assert.equal(upload.diagnostics, "release diagnostics: op=upload-asset boundary=response-body transport=UND_ERR_SOCKET");
});

// --- Failure semantics are preserved ---------------------------------------

test("attribution never changes the rejection: identity, prototype, message, stack, and frozen errors", async () => {
  const cases: Array<[string, Error]> = [
    ["plain", new TypeError("fetch failed")],
    ["frozen", Object.freeze(new TypeError("fetch failed"))],
    ["non-extensible", Object.preventExtensions(new TypeError("fetch failed"))],
    ["sealed", Object.seal(new TypeError("fetch failed"))],
  ];
  for (const [label, original] of cases) {
    const stackBefore = original.stack;
    const { rejection: caught, diagnostics } = await capture(original, (api) => api.getTag("refs/tags/b2"));
    assert.equal(caught, original, `${label}: same object identity`);
    assert.equal(Object.getPrototypeOf(caught), TypeError.prototype, `${label}: prototype preserved`);
    assert.equal((caught as Error).message, "fetch failed", `${label}: message preserved`);
    assert.equal((caught as Error).stack, stackBefore, `${label}: stack preserved`);
    assert.equal(Object.isFrozen(caught), Object.isFrozen(original), `${label}: frozen state preserved`);
    assert.equal(Object.isExtensible(caught), Object.isExtensible(original), `${label}: extensibility preserved`);
    assertBoundedDiagnostics(diagnostics, `${label}: still attributed`);
  }

  // A frozen error whose every interesting property is a throwing getter.
  const hostile = new TypeError("fetch failed");
  for (const key of ["code", "cause", "name", "errors"]) {
    Object.defineProperty(hostile, key, {
      configurable: false,
      enumerable: false,
      get(): never {
        throw new Error(`hostile ${key} getter ${SECRET_TOKEN}`);
      },
    });
  }
  const frozenHostile = Object.freeze(hostile);
  const hostileResult = await capture(frozenHostile, (api) => api.getRelease(1));
  assert.equal(hostileResult.rejection, frozenHostile);
  assertBoundedDiagnostics(hostileResult.diagnostics, "frozen error with throwing getters");
});

test("primitive transport rejections are attributed too, and never echoed", async () => {
  const secretString = `fetch failed ${SECRET_URL} ${SECRET_TOKEN}\n${FORGED_COMMAND}`;
  for (const boundary of ["request", "response-body"] as Boundary[]) {
    const { rejection, diagnostics } = await capture(secretString, (api) => api.getRelease(1), boundary);
    assert.equal(rejection, secretString, "the thrown primitive reaches the caller unchanged");
    assert.equal(
      diagnostics,
      `release diagnostics: op=get-release boundary=${boundary} transport=unclassified`,
      "a primitive carries no classifiable name or code, and its text is never echoed",
    );
    assertBoundedDiagnostics(diagnostics, `primitive string at ${boundary}`);
  }

  for (const value of [42, 42n, null, undefined, false, NaN]) {
    const { rejection, diagnostics } = await capture(value, (api) => api.getTag("refs/tags/b2"));
    assert.equal(rejection, value, "the thrown value is untouched");
    assert.equal(diagnostics, "release diagnostics: op=get-tag boundary=request transport=unclassified");
  }

  // Symbols match only by identity.
  const symbol = Symbol(`fetch failed ${SECRET_TOKEN}`);
  const symbolResult = await capture(symbol, (api) => api.downloadAsset(1));
  assert.equal(symbolResult.rejection, symbol);
  assert.equal(symbolResult.diagnostics, "release diagnostics: op=download-asset boundary=request transport=unclassified");
  assert.equal(common.describeReleaseTransport(Symbol(`fetch failed ${SECRET_TOKEN}`)), null, "a different symbol is not the recorded rejection");
});

test("object and primitive rejections keep exactly one canonical attribution each", async () => {
  // An object rejection is keyed by identity and is not disturbed by a later
  // primitive rejection at another boundary.
  const objectRejection = new TypeError("fetch failed");
  const first = await capture(objectRejection, (api) => api.getTag("refs/tags/b1"));
  assert.equal(first.diagnostics, "release diagnostics: op=get-tag boundary=request transport=TypeError");
  await capture(`a primitive rejection ${SECRET_TOKEN}`, (api) => api.getPullRequest(1));
  assert.equal(
    common.describeReleaseTransport(objectRejection),
    "release diagnostics: op=get-tag boundary=request transport=TypeError",
    "the object keeps its own record: nothing is duplicated or overwritten",
  );

  // The primitive slot holds one record, so only the most recent primitive
  // rejection is attributed. The publisher never catches a transport rejection
  // (no retry or swallow path exists), so at most one can ever propagate; a
  // superseded value deliberately falls back to no attribution rather than being
  // described by a stale operation.
  const earlier = await capture(`earlier ${SECRET_TOKEN}`, (api) => api.getTag("refs/tags/b1"));
  assert.equal(earlier.diagnostics, "release diagnostics: op=get-tag boundary=request transport=unclassified");
  const later = await capture(`later ${SECRET_URL}`, (api) => api.getPullRequest(1));
  assert.equal(later.diagnostics, "release diagnostics: op=get-pull-request boundary=request transport=unclassified");
  assert.equal(common.describeReleaseTransport(earlier.rejection), null, "one primitive record only");
});

// --- Closed-list classification --------------------------------------------

test("transport classification uses only closed names and codes, and reports unknown as unclassified", async () => {
  const cases: Array<[string, unknown, string]> = [
    ["ECONNRESET", withCause(new TypeError("fetch failed"), { code: "ECONNRESET", message: `read ${SECRET_URL}` }), "TypeError<ECONNRESET"],
    ["ECONNREFUSED", withCause(new TypeError("fetch failed"), { code: "ECONNREFUSED" }), "TypeError<ECONNREFUSED"],
    ["ENOTFOUND", withCause(new TypeError("fetch failed"), { code: "ENOTFOUND", hostname: SECRET_HOST }), "TypeError<ENOTFOUND"],
    ["undici connect timeout", withCause(new TypeError("fetch failed"), { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" }), "TypeError<UND_ERR_CONNECT_TIMEOUT"],
    ["undici socket", withCause(new TypeError("fetch failed"), { name: "SocketError", code: "UND_ERR_SOCKET" }), "TypeError<UND_ERR_SOCKET"],
    ["self-signed TLS", withCause(new TypeError("fetch failed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }), "TypeError<DEPTH_ZERO_SELF_SIGNED_CERT"],
    ["body timeout name only", withCause(new TypeError("fetch failed"), { name: "BodyTimeoutError" }), "TypeError<BodyTimeoutError"],
    ["AbortError", withCause(new TypeError("fetch failed"), { name: "AbortError" }), "TypeError<AbortError"],
    ["file descriptor exhaustion", withCause(new TypeError("fetch failed"), { code: "EMFILE", syscall: "socket" }), "TypeError<EMFILE"],
    ["unclassified cause", withCause(new TypeError("fetch failed"), new Error("malformed cause message")), "TypeError"],
    ["numeric code is ignored", withCause(new TypeError("fetch failed"), { name: "TimeoutError", code: 23 }), "TypeError<TimeoutError"],
    ["forged code is ignored", withCause(new TypeError("fetch failed"), { code: SECRET_TOKEN }), "TypeError"],
    ["forged workflow command code is ignored", withCause(new TypeError("fetch failed"), { code: FORGED_COMMAND }), "TypeError"],
    ["nothing classifiable", new Error("malformed cause message"), "unclassified"],
    ["aggregate children", Object.assign(new AggregateError([
      withCause(new Error("a"), { code: "ECONNRESET" }),
      withCause(new Error("b"), { code: "ECONNREFUSED" }),
    ], "all failed"), { name: "AggregateError" }), "AggregateError<ECONNRESET<ECONNREFUSED"],
  ];
  for (const [label, rejection, transport] of cases) {
    const { diagnostics } = await capture(rejection, (api) => api.getPullRequest(1));
    assert.equal(diagnostics, `release diagnostics: op=get-pull-request boundary=request transport=${transport}`, label);
  }
});

// --- Adversarial error trees -----------------------------------------------

function hostileTrees(): Array<[string, unknown]> {
  const circularA: Record<string, unknown> = { name: "TypeError", message: `fetch failed ${SECRET_TOKEN}` };
  const circularB: Record<string, unknown> = { name: "SocketError", cause: { code: "ECONNRESET", address: "10.0.0.8" } };
  circularA.cause = circularB;
  circularB.cause = circularA;

  const throwing: Record<string, unknown> = { name: "TypeError" };
  for (const key of ["cause", "code", "errors", "message", "stack"]) {
    Object.defineProperty(throwing, key, {
      get(): never {
        throw new Error(`getter ${SECRET_TOKEN}`);
      },
    });
  }

  const revoked = Proxy.revocable({ code: "ECONNRESET" }, {});
  revoked.revoke();

  let deep: unknown = { name: "Error", code: SECRET_TOKEN };
  for (let depth = 0; depth < 40; depth += 1) deep = { name: "TypeError", cause: deep };

  const aggregate: Record<string, unknown> = {
    name: "AggregateError",
    errors: [
      { name: "Error", message: BASE64_BLOB, code: "ECONNRESET" },
      { name: "Error", message: SECRET_URL },
      { name: "Error", code: "EPIPE" },
      { name: "Error", code: "ENETUNREACH" },
      { name: "Error", message: SECRET_PATH },
    ],
  };

  const getterArray: Record<string, unknown> = { name: "AggregateError" };
  Object.defineProperty(getterArray, "errors", {
    get(): never {
      throw new TypeError(`errors getter ${SECRET_URL}`);
    },
  });

  return [
    ["circular cause chain", circularA],
    ["throwing getters", throwing],
    ["revoked proxy", revoked.proxy],
    ["40-deep cause chain", deep],
    ["aggregate with secret children", aggregate],
    ["aggregate with throwing errors getter", getterArray],
    ["secret-laden TypeError", withCause(
      new TypeError(`fetch failed ${SECRET_URL}`),
      {
        name: "Error",
        message: `connect ECONNRESET ${SECRET_HOST} ${SECRET_PATH}`,
        stack: `stack ${SECRET_TOKEN}`,
        code: FORGED_COMMAND,
        hostname: SECRET_HOST,
        address: "10.0.0.8",
        port: 65535,
        syscall: "connect",
        errno: -4077,
        errors: [{ code: BASE64_BLOB }],
      },
    )],
  ];
}

test("hostile error trees terminate with one bounded, secret-free line", async () => {
  for (const [label, rejection] of hostileTrees()) {
    for (const boundary of ["request", "response-body"] as Boundary[]) {
      const { rejection: caught, diagnostics } = await capture(rejection, (api) => api.downloadAsset(1), boundary);
      assert.equal(caught, rejection, `${label}: traversal never replaces the failure`);
      const line = assertBoundedDiagnostics(diagnostics, `${label} at ${boundary}`);
      assert.match(line, /boundary=/, label);
    }
  }
});

// --- Publisher CLI reporting ------------------------------------------------

// These regressions run the real producer CLI against a scratch synthetic
// repository the fixture owns: the run's working directory, main ref,
// first-parent chain, and numbering baseline are all fixture state. Nothing
// reads the source checkout's refs or history, so the same assertions hold on a
// shallow, detached, or branchless checkout, and the only writes are the
// fixture's own throwaway commits. The first fetch is still rejected by the
// injected preload, so nothing reaches the network.

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "release-test",
  GIT_AUTHOR_EMAIL: "release-test@example.com",
  GIT_COMMITTER_NAME: "release-test",
  GIT_COMMITTER_EMAIL: "release-test@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

// The well-known empty tree: eligibility depends only on commit topology.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function gitIn(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { env: GIT_ENV, encoding: "utf8" }).trim();
}

interface CliRepo {
  root: string;
  baseline: string;
  target: string;
}

// `baseline` -> one -> target (a real merge commit with a side parent), with
// refs/heads/main at the tip: the target is a strict first-parent descendant of
// the fixture baseline and lies on main's first-parent history, so the
// producer's local ancestry gates pass and the run reaches its first API call.
// `cliPreload` below supplies this baseline to the producer in place of the
// pinned production commit.
function makeCliRepo(): CliRepo {
  const root = mkdtempSync(join(tmpdir(), "release-transport-cli-repo-"));
  gitIn(root, "init", "--initial-branch=main");
  const commit = (message: string, parents: string[] = []): string => {
    const args = ["commit-tree", EMPTY_TREE, "-m", message];
    for (const parent of parents) args.push("-p", parent);
    return gitIn(root, ...args);
  };
  const baseline = commit("baseline");
  const first = commit("one", [baseline]);
  const side = commit("side", [first]);
  const target = commit("merge PR #1", [first, side]);
  gitIn(root, "update-ref", "refs/heads/main", target);
  return { root, baseline, target };
}

function withCliRepo<T>(run: (repo: CliRepo) => T): T {
  const repo = makeCliRepo();
  try {
    return run(repo);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}

function cliEnvironment(target: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_TYPE: "branch",
    GITHUB_REPOSITORY: common.REPOSITORY,
    GITHUB_SHA: target,
    GITHUB_TOKEN: SECRET_TOKEN,
    PI_REVIEW_GATE_ENV_SENTINEL: SECRET_PATH,
  };
}

const PUBLISH_CLI = join(projectRoot(), "scripts", "release", "publish.cjs");

function runPublishCli(repo: CliRepo, preload: string | null, target: string) {
  const args = preload ? ["--import", pathToFileURL(preload).href, PUBLISH_CLI] : [PUBLISH_CLI];
  return spawnSync(process.execPath, args, { encoding: "utf8", cwd: repo.root, env: cliEnvironment(target) });
}

// Test-only numbering seam, loaded before the producer: the producer pins its
// baseline to one immutable production commit that no synthetic repository can
// contain, so the preload requires the producer's own common.cjs through the
// same module cache the CLI will use and replaces that single constant with the
// fixture baseline. The real eligibility and numbering code then runs unchanged
// against the fixture repository, and no production file is touched.
function cliPreload(repo: CliRepo, fetchStub: string): string {
  const commonModule = join(projectRoot(), "scripts", "release", "common.cjs");
  return [
    `import { createRequire } from "node:module";`,
    `const requireFromPreload = createRequire(import.meta.url);`,
    `requireFromPreload(${JSON.stringify(commonModule)}).BASELINE_SHA = ${JSON.stringify(repo.baseline)};`,
    fetchStub,
  ].join("\n");
}

// Runs the real publisher CLI with `fetchStub` installed as a preload that
// fails the first fetch boundary, against the fixture repository's own main tip
// so the run reaches eligibility and its first API call: nothing is written and
// nothing reaches the network, because the injected fetch rejects.
function runCliWithFetch(fetchStub: string): { result: ReturnType<typeof runPublishCli>; reported: string[]; combined: string } {
  return withCliRepo((repo) => {
    const directory = mkdtempSync(join(tmpdir(), "release-transport-cli-"));
    try {
      const preload = join(directory, "rejecting-fetch.mjs");
      writeFileSync(preload, cliPreload(repo, fetchStub));
      const result = runPublishCli(repo, preload, repo.target);
      const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      const reported = (result.stderr ?? "")
        .split(/\r?\n/)
        .filter((line) => line.startsWith("release failed closed:") || line.startsWith("release diagnostics:"));
      return { result, reported, combined };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

function assertCliTransportFailure(reported: string[], diagnostics: string, context: string) {
  assert.deepEqual(reported, ["release failed closed: fetch failed", diagnostics], `${context}: the static headline and exactly one diagnostics line, got ${JSON.stringify(reported)}`);
  assertBoundedDiagnostics(reported[1], `${context} diagnostics line`);
}

test("the publisher CLI prints the static headline plus one diagnostics line and no secret", () => {
  const { result, reported, combined } = runCliWithFetch([
    "const url = process.env.PI_REVIEW_GATE_ENV_SENTINEL;",
    "globalThis.fetch = async () => {",
    "  const cause = new Error(`connect ECONNRESET secret-host.internal ${url} signed ${SECRET_PLACEHOLDER}`);",
    "  cause.code = 'ECONNRESET';",
    "  cause.hostname = 'secret-host.internal';",
    "  cause.address = '10.0.0.8';",
    "  cause.port = 65535;",
    "  cause.syscall = 'connect';",
    "  cause.errors = [{ code: 'FORGED', message: TOKEN_PLACEHOLDER }];",
    "  throw new TypeError(`fetch failed ::error::release succeeded ${url}`, { cause });",
    "};",
  ].join("\n")
    .replace("SECRET_PLACEHOLDER", JSON.stringify(SECRET_URL))
    .replace("TOKEN_PLACEHOLDER", JSON.stringify(SECRET_TOKEN)));

  assert.equal(result.status, 1, "the publisher still fails closed");
  assert.equal(result.stdout, "", "the CLI writes nothing on stdout when it fails");
  assertCliTransportFailure(
    reported,
    "release diagnostics: op=get-commit-pull-requests boundary=request transport=TypeError<ECONNRESET",
    "object rejection",
  );
  assert.ok(!combined.includes("::"), "no workflow command can be forged from CLI output");
  assertSecretFree(combined, "CLI output");
  assert.ok(!combined.includes("secret-host.internal") && !combined.includes("10.0.0.8"), "no host or address detail");
});

// A fetch that rejects with a bare string is not an Error, so the CLI fallback
// would print it verbatim: the secret and an embedded workflow command must both
// stay out of the output, and the failure must still carry attribution.
test("the publisher CLI never echoes a secret-bearing string rejection", () => {
  const hostile = `fetch failed ${SECRET_URL} ${SECRET_TOKEN}\n${FORGED_COMMAND}\n${SECRET_PATH}`;
  const { result, reported, combined } = runCliWithFetch(
    `globalThis.fetch = async () => { throw ${JSON.stringify(hostile)}; };\n`,
  );

  assert.equal(result.status, 1, "the publisher still fails closed");
  assert.equal(result.stdout, "", "the CLI writes nothing on stdout when it fails");
  assertCliTransportFailure(
    reported,
    "release diagnostics: op=get-commit-pull-requests boundary=request transport=unclassified",
    "primitive string rejection at the request boundary",
  );
  assert.ok(!combined.includes("::"), `no forged workflow command survives, got ${JSON.stringify(combined)}`);
  assertSecretFree(combined, "CLI output");
});

test("the publisher CLI never echoes a secret-bearing string thrown while reading a response body", () => {
  const hostile = `terminated ${SECRET_URL}\n${FORGED_COMMAND} ${SECRET_TOKEN}`;
  const { result, reported, combined } = runCliWithFetch([
    `const thrown = ${JSON.stringify(hostile)};`,
    "globalThis.fetch = async () => ({",
    "  status: 200,",
    "  text: async () => { throw thrown; },",
    "  arrayBuffer: async () => { throw thrown; },",
    "});",
  ].join("\n"));

  assert.equal(result.status, 1, "the publisher still fails closed");
  assert.equal(result.stdout, "", "the CLI writes nothing on stdout when it fails");
  assertCliTransportFailure(
    reported,
    "release diagnostics: op=get-commit-pull-requests boundary=response-body transport=unclassified",
    "primitive string rejection at the response-body boundary",
  );
  assert.ok(!combined.includes("::"), `no forged workflow command survives, got ${JSON.stringify(combined)}`);
  assertSecretFree(combined, "CLI output");
});

test("an unattributed failure keeps the existing single-line reporting", () => {
  withCliRepo((repo) => {
    // A target the fixture repository does not contain: it fails the local
    // numbering gate before any fetch happens, so it is not a transport failure
    // and no diagnostics line is added.
    const missing = "f".repeat(40);
    const result = runPublishCli(repo, null, missing);
    assert.equal(result.status, 1, "the publisher still fails closed");
    const lines = (result.stderr ?? "").split(/\r?\n/).filter((line) => line.length > 0);
    const reported = lines.filter((line) => line.startsWith("release failed closed:"));
    assert.equal(reported.length, 1, `unchanged single-line reporting, got: ${JSON.stringify(lines)}`);
    assert.match(reported[0], /^release failed closed: /);
    assert.ok(!lines.some((line) => line.includes("release diagnostics")), "no diagnostics line without a fetch boundary");
    assertSecretFree(lines.join("\n"), "CLI output");
  });
});
