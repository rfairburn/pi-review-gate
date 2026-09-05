import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { loadReleaseModule, projectRoot } from "./helpers/release-scripts";
import type { Eligibility, PackagingModule, PublishModule, PublishSummary } from "./helpers/release-scripts";

const common = loadReleaseModule<{
  REPOSITORY: string;
  sha256Buffer(buffer: Buffer): string;
  createApi(options: { fetchImpl: unknown; token: string; repository: string }): unknown;
}>("common.cjs");
const packaging = loadReleaseModule<PackagingModule>("packaging.cjs");
const publish = loadReleaseModule<PublishModule & {
  tarballFilenameFor(version: string): string;
}>("publish.cjs");

const TARGET = "c".repeat(40);
const TOKEN = "test-token";
const API_BASE = `https://api.github.com/repos/rfairburn/pi-review-gate`;
const UPLOADS_BASE = `https://uploads.github.com/repos/rfairburn/pi-review-gate`;

function baseEnv(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_TYPE: "branch",
    GITHUB_REPOSITORY: "rfairburn/pi-review-gate",
    GITHUB_SHA: TARGET,
    GITHUB_TOKEN: TOKEN,
    ...overrides,
  };
}

interface SyntheticRepo {
  root: string;
  baseline: string;
  mergeCommit: string;
}

function makeRepo(): SyntheticRepo {
  const root = mkdtempSync(join(tmpdir(), "release-publish-"));
  git(root, "init", "--initial-branch=main");
  git(root, "config", "user.email", "release-test@example.com");
  git(root, "config", "user.name", "release-test");
  const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const commit = (message: string, parents: string[] = []): string => {
    const args = ["commit-tree", tree, "-m", message];
    for (const parent of parents) args.push("-p", parent);
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  };
  const baseline = commit("baseline");
  const c1 = commit("one", [baseline]);
  git(root, "update-ref", "refs/heads/main", c1);
  const side = commit("side", [c1]);
  const mergeCommit = commit("merge PR #1", [c1, side]);
  git(root, "update-ref", "refs/heads/main", mergeCommit);
  return { root, baseline, mergeCommit };
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

// --- Contract-faithful pull request fixtures ---------------------------------
// GET /commits/{sha}/pulls returns LIST-SHAPED items (merged_at, no `merged`
// boolean); eligibility confirms each candidate via detailed GET /pulls/{n}.

function listItem(number: number): Record<string, unknown> {
  return {
    id: number * 1000,
    number,
    state: "closed",
    merged_at: "2026-01-02T00:00:00Z",
    html_url: `${API_BASE}/pulls/${number}`,
  };
}

function detailPr(number: number, mergeCommitSha: string): Record<string, unknown> {
  return {
    id: number * 1000,
    number,
    state: "closed",
    merged: true,
    merged_at: "2026-01-02T00:00:00Z",
    merge_commit_sha: mergeCommitSha,
    base: { ref: "main", sha: mergeCommitSha, repo: { full_name: "rfairburn/pi-review-gate" } },
  };
}

// --- Stateful in-memory GitHub API mock --------------------------------------

interface MockAsset {
  id: number;
  name: string;
  size: number;
  content: Buffer;
}

interface MockRelease {
  id: number;
  tag_name: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  make_latest: string;
  assets: MockAsset[];
  html_url: string;
  upload_url: string;
}

interface RecordedRequest {
  method: string;
  url: string;
  body?: string;
}

class MockGithub {
  tags = new Map<string, string>();
  releases = new Map<number, MockRelease>();
  pullRequests: unknown[] = [];
  details: Record<number, unknown> = {};
  requests: RecordedRequest[] = [];
  private nextReleaseId = 1;
  private nextAssetContentId = 1;
  assetContents = new Map<number, Buffer>();
  // A seeded tag invisible to GET /git/ref until a POST /git/refs happens
  // (models a concurrent creator committing just after our read).
  delayedTagRef: string | undefined;
  private tagPostSeen = false;
  // A seeded release invisible to all reads until a POST /releases happens.
  delayedReleaseId: number | undefined;
  private createPostSeen = false;
  // The next POST /releases conflicts even though no release exists yet.
  conflictWithoutRelease = false;

  getApi() {
    return common.createApi({ fetchImpl: this.fetch.bind(this), token: TOKEN, repository: common.REPOSITORY });
  }

  async fetch(url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
  }): Promise<{ status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }> {
    const method = init?.method ?? "GET";
    this.requests.push({ method, url, body: typeof init?.body === "string" ? init.body : undefined });
    const parsed = new URL(url);
    const body = init?.body;
    const bodyJson = (): Record<string, unknown> => JSON.parse(String(body ?? "{}"));

    if (parsed.origin === "https://uploads.github.com") {
      const name = parsed.searchParams.get("name");
      const releaseId = Number(parsed.pathname.match(/releases\/(\d+)\/assets/)?.[1]);
      const content = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ""));
      const asset: MockAsset = {
        id: this.nextAssetContentId++,
        name: name ?? "unnamed",
        size: content.length,
        content,
      };
      this.assetContents.set(asset.id, content);
      this.releases.get(releaseId)?.assets.push(asset);
      return this.respond(201, { id: asset.id, name: asset.name, size: asset.size });
    }

    const repoPath = `/repos/${common.REPOSITORY}`;
    const path = parsed.pathname.startsWith(repoPath) ? parsed.pathname.slice(repoPath.length) : parsed.pathname;
    let match: RegExpMatchArray | null;

    if (path === "/git/refs" && method === "POST") {
      const { ref, sha } = bodyJson() as { ref: string; sha: string };
      this.tagPostSeen = true;
      if (this.tags.has(ref)) {
        return this.respond(422, { message: "Reference already exists" });
      }
      this.tags.set(ref, sha);
      return this.respond(201, { ref, object: { sha, type: "commit" } });
    }
    if ((match = path.match(/^\/git\/ref\/(.+)$/)) && method === "GET") {
      // The client sends the bare ref (tags/bN); normalize to the stored form.
      const bare = decodeURIComponent(match[1]);
      const ref = bare.startsWith("refs/") ? bare : `refs/${bare}`;
      if (!this.tagPostSeen && ref === this.delayedTagRef) return this.respond(404, null);
      const sha = this.tags.get(ref);
      if (sha === undefined) return this.respond(404, null);
      return this.respond(200, { ref, object: { sha, type: "commit" } });
    }
    if (path === "/releases" && method === "POST") {
      const input = bodyJson();
      this.createPostSeen = true;
      const existing = [...this.releases.values()].find((release) => release.tag_name === input.tag_name);
      if (existing || this.conflictWithoutRelease) {
        if (this.conflictWithoutRelease) this.conflictWithoutRelease = false;
        return this.respond(422, { message: "already_exists" });
      }
      const id = this.nextReleaseId++;
      const release: MockRelease = {
        id,
        tag_name: String(input.tag_name),
        name: String(input.name ?? ""),
        body: String(input.body ?? ""),
        draft: Boolean(input.draft),
        prerelease: Boolean(input.prerelease),
        make_latest: String(input.make_latest ?? "true"),
        assets: [],
        html_url: `https://github.com/${common.REPOSITORY}/releases/tag/${input.tag_name}`,
        // Documented upload_url form.
        upload_url: `${UPLOADS_BASE}/releases/${id}/assets?name={name}&label={label}`,
      };
      this.releases.set(release.id, release);
      return this.respond(201, this.releaseJson(release));
    }
    if ((match = path.match(/^\/releases\/tags\/(.+)$/)) && method === "GET") {
      const tag = decodeURIComponent(match[1]);
      const release = [...this.releases.values()].find((candidate) => candidate.tag_name === tag);
      if (release && !this.createPostSeen && release.id === this.delayedReleaseId) {
        return this.respond(404, { message: "Not Found" });
      }
      // Real API behavior: the tag endpoint returns only PUBLISHED releases;
      // drafts 404 here and are visible only in the authenticated listing.
      if (!release || release.draft) return this.respond(404, { message: "Not Found" });
      return this.respond(200, this.releaseJson(release));
    }
    if (path === "/releases" && method === "GET") {
      // Authenticated listing including drafts, with standard pagination.
      const perPage = Number(parsed.searchParams.get("per_page") ?? "30");
      const page = Number(parsed.searchParams.get("page") ?? "1");
      let all = [...this.releases.values()];
      if (!this.createPostSeen && this.delayedReleaseId !== undefined) {
        all = all.filter((release) => release.id !== this.delayedReleaseId);
      }
      const start = (page - 1) * perPage;
      return this.respond(200, all.slice(start, start + perPage).map((release) => this.releaseJson(release)));
    }
    if ((match = path.match(/^\/releases\/(\d+)$/))) {
      const id = Number(match[1]);
      const release = this.releases.get(id);
      if (!release) return this.respond(404, { message: "Not Found" });
      if (method === "GET") return this.respond(200, this.releaseJson(release));
      if (method === "PATCH") {
        const patch = bodyJson();
        if (patch.draft !== undefined) release.draft = Boolean(patch.draft);
        if (patch.prerelease !== undefined) release.prerelease = Boolean(patch.prerelease);
        if (patch.make_latest !== undefined) release.make_latest = String(patch.make_latest);
        if (patch.body !== undefined) release.body = String(patch.body);
        return this.respond(200, this.releaseJson(release));
      }
    }
    if ((match = path.match(/^\/releases\/assets\/(\d+)$/))) {
      const id = Number(match[1]);
      for (const release of this.releases.values()) {
        const asset = release.assets.find((candidate) => candidate.id === id);
        if (asset) {
          if (method === "DELETE") {
            release.assets = release.assets.filter((candidate) => candidate.id !== id);
            return { status: 204, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
          }
          return {
            status: 200,
            text: async () => this.assetContents.get(id)?.toString("binary") ?? "",
            arrayBuffer: async () => {
              const content = this.assetContents.get(id);
              if (!content) return new ArrayBuffer(0);
              return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
            },
          };
        }
      }
      return this.respond(404, { message: "Not Found" });
    }
    if (/^\/commits\/[0-9a-f]{40}\/pulls$/.test(path)) {
      return this.respond(200, this.pullRequests);
    }
    if ((match = path.match(/^\/pulls\/(\d+)$/))) {
      const detail = this.details[Number(match[1])];
      if (detail === undefined) return this.respond(404, { message: "Not Found" });
      return this.respond(200, detail);
    }
    return this.respond(404, { message: `unrouted: ${method} ${path}` });
  }

  private releaseJson(release: MockRelease) {
    return {
      id: release.id,
      tag_name: release.tag_name,
      name: release.name,
      body: release.body,
      draft: release.draft,
      prerelease: release.prerelease,
      html_url: release.html_url,
      upload_url: release.upload_url,
      assets: release.assets.map((asset) => ({ id: asset.id, name: asset.name, size: asset.size })),
    };
  }

  private respond(status: number, body: unknown) {
    const encoded = Buffer.from(JSON.stringify(body), "utf8");
    return {
      status,
      text: async () => encoded.toString("utf8"),
      arrayBuffer: async () => encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer,
    };
  }

  releaseByTag(tag: string): MockRelease | undefined {
    return [...this.releases.values()].find((release) => release.tag_name === tag);
  }

  assetContent(releaseTag: string, name: string): Buffer | undefined {
    const asset = this.releaseByTag(releaseTag)?.assets.find((candidate) => candidate.name === name);
    return asset ? this.assetContents.get(asset.id) : undefined;
  }

  countRequests(predicate: (request: RecordedRequest) => boolean): number {
    return this.requests.filter(predicate).length;
  }
}

// --- Fake artifact build (keeps orchestration tests off the real tsc) --------

function eligibilityFor(repo: SyntheticRepo): Eligibility {
  return {
    n: 2,
    target: repo.mergeCommit,
    baseline: repo.baseline,
    tag: "b2",
    version: "0.1.0-dev.2",
    prNumber: 7,
    prMergeCommitSha: repo.mergeCommit,
    associatedPullRequests: [7],
  };
}

function fakeBuildArtifacts(eligibility: Eligibility) {
  const tarballFilename = publish.tarballFilenameFor(eligibility.version);
  const tarball = Buffer.from(`tarball bytes for ${eligibility.target} ${eligibility.version}`);
  const tarballSha = common.sha256Buffer(tarball);
  const provenance = packaging.buildProvenance({
    repository: common.REPOSITORY,
    target: eligibility.target,
    baseline: eligibility.baseline,
    n: eligibility.n,
    tag: eligibility.tag,
    version: eligibility.version,
    prNumber: eligibility.prNumber,
    prMergeCommitSha: eligibility.prMergeCommitSha,
    tarballFilename,
    tarballSha256: tarballSha,
    tarballSize: tarball.length,
  });
  const sums = `${tarballSha}  ${tarballFilename}\n`;
  const provenanceBuffer = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`);
  return {
    assets: [
      { filename: tarballFilename, buffer: tarball, sha256: tarballSha, size: tarball.length },
      { filename: "SHA256SUMS", buffer: Buffer.from(sums), sha256: common.sha256Buffer(Buffer.from(sums)), size: sums.length },
      {
        filename: "provenance.json",
        buffer: provenanceBuffer,
        sha256: common.sha256Buffer(provenanceBuffer),
        size: provenanceBuffer.length,
      },
    ],
    provenance,
    tarballFilename,
    tarballEntryCount: 42,
  };
}

function seedOwnedDraft(github: MockGithub, repo: SyntheticRepo, releaseId: number) {
  github.tags.set("refs/tags/b2", repo.mergeCommit);
  github.releases.set(releaseId, {
    id: releaseId,
    tag_name: "b2",
    name: "b2",
    body: publish.releaseBody(eligibilityFor(repo), undefined),
    draft: true,
    prerelease: true,
    make_latest: "false",
    assets: [],
    html_url: "https://example.com/draft",
    upload_url: `${UPLOADS_BASE}/releases/${releaseId}/assets?name={name}&label={label}`,
  });
}

function publishWith(repo: SyntheticRepo, github: MockGithub, overrides: {
  env?: Record<string, string>;
  eligible?: boolean;
  buildRecorder?: { built: boolean };
  buildArtifacts?: (options: { eligibility: Eligibility }) => Promise<ReturnType<typeof fakeBuildArtifacts>>;
} = {}): Promise<PublishSummary> {
  const eligible = overrides.eligible ?? true;
  // List-shaped association + detailed record, as the real endpoints return.
  github.pullRequests = eligible ? [listItem(7)] : [];
  github.details = eligible ? { 7: detailPr(7, repo.mergeCommit) } : {};
  return publish.publishRelease({
    env: overrides.env ?? baseEnv({ GITHUB_SHA: repo.mergeCommit }),
    fetchImpl: github.fetch.bind(github),
    projectRoot: repo.root,
    baseline: repo.baseline,
    scratchRoot: mkdtempSync(join(tmpdir(), "release-publish-scratch-")),
    buildArtifacts: overrides.buildArtifacts ?? ((options: { eligibility: Eligibility }) => {
      if (overrides.buildRecorder) overrides.buildRecorder.built = true;
      return Promise.resolve(fakeBuildArtifacts(options.eligibility));
    }),
  });
}

// Seed a fully consistent PUBLISHED release (tag + body + all three verified
// assets). With `corrupt`, the published tarball bytes no longer match the
// published SHA256SUMS/provenance.
function seedPublishedRelease(github: MockGithub, repo: SyntheticRepo, releaseId: number, corrupt = false) {
  const eligibility = eligibilityFor(repo);
  const build = fakeBuildArtifacts(eligibility);
  github.tags.set("refs/tags/b2", repo.mergeCommit);
  const assets = build.assets.map((asset, index) => {
    const id = releaseId * 10 + index;
    const content = corrupt && asset.filename.endsWith(".tgz") ? Buffer.from("corrupted published bytes") : asset.buffer;
    github.assetContents.set(id, content);
    return { id, name: asset.filename, size: content.length, content };
  });
  github.releases.set(releaseId, {
    id: releaseId,
    tag_name: "b2",
    name: `b2 (pi-review-gate ${eligibility.version})`,
    body: publish.releaseBody(eligibility, build.provenance),
    draft: false,
    prerelease: true,
    make_latest: "false",
    assets,
    html_url: "https://example.com/published",
    upload_url: `${UPLOADS_BASE}/releases/${releaseId}/assets?name={name}&label={label}`,
  });
}

test("fresh publish: draft created, all assets uploaded and verified, then published", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    const summary = await publishWith(repo, github);
    assert.equal(summary.outcome, "published");
    assert.equal(summary.tag, "b2");
    assert.equal(summary.version, "0.1.0-dev.2");
    assert.equal(summary.target, repo.mergeCommit);
    assert.equal(summary.mode, "created-draft");
    assert.equal(summary.tagCreated, true);
    assert.deepEqual(summary.assets?.uploaded.sort(), ["SHA256SUMS", "pi-review-gate-0.1.0-dev.2.tgz", "provenance.json"]);
    assert.deepEqual(summary.assets?.replaced, []);
    // Tag pinned to the exact SHA.
    assert.equal(github.tags.get("refs/tags/b2"), repo.mergeCommit);
    // Final release flags.
    const release = github.releaseByTag("b2");
    assert.ok(release);
    assert.equal(release.draft, false);
    assert.equal(release.prerelease, true);
    assert.equal(release.make_latest, "false");
    assert.match(release.body, new RegExp(publish.identityMarker(eligibilityFor(repo)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // All three assets present and internally consistent.
    const tarballContent = github.assetContent("b2", "pi-review-gate-0.1.0-dev.2.tgz");
    assert.ok(tarballContent);
    const sums = github.assetContent("b2", "SHA256SUMS")?.toString("utf8");
    assert.equal(sums, `${common.sha256Buffer(tarballContent)}  pi-review-gate-0.1.0-dev.2.tgz\n`);
    const provenanceContent = JSON.parse(github.assetContent("b2", "provenance.json")?.toString("utf8") ?? "null");
    assert.equal(provenanceContent.source.sha, repo.mergeCommit);
    assert.equal(provenanceContent.source.firstParentDistance, 2);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("retry of a published release verifies only and never rewrites", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  const buildRecorder = { built: false };
  try {
    await publishWith(repo, github);
    const requestsAfterFirstRun = github.requests.length;
    const summary = await publishWith(repo, github, { buildRecorder });
    assert.equal(summary.outcome, "already-published");
    assert.equal(buildRecorder.built, false,
      "the published verify-only path must never rebuild artifacts or run the install smoke");
    const extra = github.requests.slice(requestsAfterFirstRun);
    const writes = extra.filter((request) => request.method !== "GET");
    assert.deepEqual(writes.map((request) => `${request.method} ${request.url}`), [], "no writes may happen for a published release");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("later main advances never change the built SHA: the pinned event SHA is published", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    // Detach HEAD at the exact target (as the workflow checkout would) before
    // advancing main: publication must key on the event SHA, not on main.
    git(repo.root, "checkout", "--detach", repo.mergeCommit);
    // Advance the local main beyond the target before publishing.
    const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const newer = execFileSync(
      "git",
      ["-C", repo.root, "commit-tree", tree, "-m", "later", "-p", repo.mergeCommit],
      { encoding: "utf8" },
    ).trim();
    git(repo.root, "update-ref", "refs/heads/main", newer);
    const summary = await publishWith(repo, github);
    assert.equal(summary.outcome, "published");
    assert.equal(github.tags.get("refs/tags/b2"), repo.mergeCommit);
    assert.notEqual(github.tags.get("refs/tags/b2"), newer);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("incomplete owned draft resumes via bounded release listing without creating another draft", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    // Seed an interrupted owned draft. The mock models the real API: the tag
    // endpoint 404s for drafts, so discovery must come from the listing.
    seedOwnedDraft(github, repo, 91);
    const summary = await publishWith(repo, github);
    assert.equal(summary.outcome, "published");
    assert.equal(summary.mode, "resume-draft");
    assert.deepEqual(summary.assets?.uploaded.sort(), ["SHA256SUMS", "pi-review-gate-0.1.0-dev.2.tgz", "provenance.json"]);
    // The draft was located through the authenticated listing...
    assert.ok(
      github.requests.some((request) => request.method === "GET" && new URL(request.url).pathname === "/repos/rfairburn/pi-review-gate/releases"),
      "draft discovery must use the release listing",
    );
    // ...and no second draft was created.
    assert.equal(github.releases.size, 1);
    const release = github.releaseByTag("b2");
    assert.equal(release?.draft, false);
    assert.equal(release?.assets.length, 3);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("mismatched owned-draft asset is narrowly replaced; byte-identical assets are kept", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    const eligibility = eligibilityFor(repo);
    seedOwnedDraft(github, repo, 92);
    const release: MockRelease & { id: number } = github.releases.get(92) as MockRelease & { id: number };
    // Seed one wrong tarball and one identical SHA256SUMS as pre-existing assets.
    const wrongTarball = Buffer.from("stale bytes");
    const staleAsset = { id: 500, name: "pi-review-gate-0.1.0-dev.2.tgz", size: wrongTarball.length, content: wrongTarball };
    const build = fakeBuildArtifacts(eligibility);
    const correctSums = build.assets.find((asset) => asset.filename === "SHA256SUMS");
    const keptAsset = { id: 501, name: "SHA256SUMS", size: correctSums?.size ?? 0, content: correctSums?.buffer ?? Buffer.alloc(0) };
    release.assets.push(staleAsset, keptAsset);
    github.assetContents.set(500, wrongTarball);
    github.assetContents.set(501, keptAsset.content);
    const summary = await publishWith(repo, github);
    assert.equal(summary.outcome, "published");
    assert.deepEqual(summary.assets?.replaced, ["pi-review-gate-0.1.0-dev.2.tgz"]);
    assert.deepEqual(summary.assets?.kept, ["SHA256SUMS"]);
    assert.deepEqual(summary.assets?.uploaded, ["provenance.json"]);
    const publishedTarball = github.assetContent("b2", "pi-review-gate-0.1.0-dev.2.tgz");
    assert.equal(common.sha256Buffer(publishedTarball ?? Buffer.alloc(0)), build.assets[0]?.sha256);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("unowned draft fails closed without modification", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    github.tags.set("refs/tags/b2", repo.mergeCommit);
    const releaseId = 93;
    github.releases.set(releaseId, {
      id: releaseId,
      tag_name: "b2",
      name: "b2",
      body: "some other builder's draft",
      draft: true,
      prerelease: true,
      make_latest: "false",
      assets: [],
      html_url: "https://example.com/draft",
      upload_url: `${UPLOADS_BASE}/releases/${releaseId}/assets?name={name}&label={label}`,
    });
    const before = JSON.stringify(github.releaseByTag("b2"));
    await assert.rejects(publishWith(repo, github), /not owned by this builder/);
    assert.equal(JSON.stringify(github.releaseByTag("b2")), before);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("published asset checksum mismatch fails closed", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    await publishWith(repo, github);
    // Tamper with the published tarball bytes.
    const release = github.releaseByTag("b2");
    const asset = release?.assets.find((candidate) => candidate.name.endsWith(".tgz"));
    if (asset) github.assetContents.set(asset.id, Buffer.from("tampered"));
    await assert.rejects(publishWith(repo, github), /published tarball digest does not match published SHA256SUMS/);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("published provenance identity mismatch fails closed", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    await publishWith(repo, github);
    const release = github.releaseByTag("b2");
    const asset = release?.assets.find((candidate) => candidate.name === "provenance.json");
    if (asset) {
      const forged = JSON.parse(github.assetContents.get(asset.id)?.toString("utf8") ?? "{}") as Record<string, unknown>;
      (forged.source as Record<string, unknown>).sha = "d".repeat(40);
      github.assetContents.set(asset.id, Buffer.from(JSON.stringify(forged)));
    }
    await assert.rejects(publishWith(repo, github), /published provenance identity verification failed/);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("tag pointing at a different SHA fails closed and never retargets", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    github.tags.set("refs/tags/b2", "e".repeat(40));
    await assert.rejects(publishWith(repo, github), /refusing to retarget/);
    assert.equal(github.tags.get("refs/tags/b2"), "e".repeat(40));
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("annotated tag objects fail closed", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    github.tags.set("refs/tags/b2", repo.mergeCommit);
    // Simulate an annotated tag by rewriting every successful tag read to
    // report a tag object type.
    const originalFetch = github.fetch.bind(github);
    github.fetch = async (url, init) => {
      const response = await originalFetch(url, init);
      const path = new URL(url).pathname;
      if (path.endsWith("/git/ref/tags%2Fb2")) {
        const body = (JSON.parse(await response.text()) ?? {}) as { object?: { sha?: string; type?: string } };
        if (body.object) body.object.type = "tag";
        return {
          ...response,
          text: async () => JSON.stringify(body),
        };
      }
      return response;
    };
    await assert.rejects(publishWith(repo, github), /annotated tag object/);
    // The tag must remain untouched.
    assert.equal(github.tags.get("refs/tags/b2"), repo.mergeCommit);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("duplicate-creation races re-read identity and resume instead of blind-retrying", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    // A concurrent creator's draft exists but is invisible to our reads until
    // our POST /releases lands (then the API reports the conflict). The
    // re-read must find and resume that exact draft, not create a second one.
    seedOwnedDraft(github, repo, 95);
    github.delayedReleaseId = 95;
    const summary = await publishWith(repo, github);
    assert.equal(summary.outcome, "published");
    assert.equal(summary.mode, "resume-draft");
    assert.equal(github.releases.size, 1, "no second draft may be created");
    assert.equal(github.countRequests((request) => request.method === "POST" && new URL(request.url).pathname === "/repos/rfairburn/pi-review-gate/releases"), 1);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a creation race that rereads a published release verifies only and never mutates", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    // A concurrent run's PUBLISHED release exists but is invisible to our
    // initial discovery; our POST /releases conflicts, and the reread finds
    // the published release. Recovery must verify only: no artifact build,
    // no PATCH, no upload, no delete.
    seedPublishedRelease(github, repo, 97);
    github.delayedReleaseId = 97;
    const recorder = { built: false };
    const summary = await publishWith(repo, github, { buildRecorder: recorder });
    assert.equal(summary.outcome, "already-published");
    assert.equal(summary.mode, "published");
    assert.equal(recorder.built, false, "no artifact build may happen for a published release");
    // Verification actually validated the published bytes.
    const expectedSha = common.sha256Buffer(fakeBuildArtifacts(eligibilityFor(repo)).assets[0].buffer);
    assert.equal(summary.tarballSha256, expectedSha);
    // Only reads may follow the creation conflict.
    const conflictIndex = github.requests.findIndex(
      (request) => request.method === "POST" && new URL(request.url).pathname === "/repos/rfairburn/pi-review-gate/releases",
    );
    assert.ok(conflictIndex >= 0, "the creation conflict must have occurred");
    const afterConflict = github.requests.slice(conflictIndex + 1);
    assert.ok(
      afterConflict.every((request) => request.method === "GET"),
      `only reads may follow the conflict: ${JSON.stringify(afterConflict.map((request) => request.method))}`,
    );
    assert.equal(github.countRequests((request) => new URL(request.url).origin === "https://uploads.github.com"), 0, "no asset uploads");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a creation race rereading a corrupted published release fails closed without mutations", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    seedPublishedRelease(github, repo, 98, true);
    github.delayedReleaseId = 98;
    const before = JSON.stringify({
      body: github.releaseByTag("b2")?.body,
      assetIds: github.releaseByTag("b2")?.assets.map((asset) => asset.id),
      tag: github.tags.get("refs/tags/b2"),
    });
    await assert.rejects(publishWith(repo, github), /published tarball digest does not match published SHA256SUMS/);
    const after = JSON.stringify({
      body: github.releaseByTag("b2")?.body,
      assetIds: github.releaseByTag("b2")?.assets.map((asset) => asset.id),
      tag: github.tags.get("refs/tags/b2"),
    });
    assert.equal(after, before, "the published release must remain untouched");
    assert.equal(github.releases.size, 1);
    // The only write is the conflicted creation itself; nothing else.
    const writes = github.requests.filter((request) => request.method !== "GET");
    assert.deepEqual(
      writes.map((request) => `${request.method} ${new URL(request.url).pathname}`),
      ["POST /repos/rfairburn/pi-review-gate/releases"],
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a creation conflict with no readable release fails closed without blind retry", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    github.tags.set("refs/tags/b2", repo.mergeCommit);
    github.conflictWithoutRelease = true;
    await assert.rejects(publishWith(repo, github), /conflicted but no release is readable after re-read/);
    assert.equal(github.releases.size, 0);
    assert.equal(
      github.countRequests((request) => request.method === "POST" && new URL(request.url).pathname === "/repos/rfairburn/pi-review-gate/releases"),
      1,
      "a conflicted creation must never be blindly retried",
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("tag reads use the bare ref URL and tag creation uses the refs/-prefixed body", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    await publishWith(repo, github);
    // Exact REST URL for the existing-tag read: GET /git/ref/{ref} takes the
    // ref WITHOUT the refs/ prefix.
    assert.ok(
      github.requests.some((request) => request.method === "GET" && request.url === `${API_BASE}/git/ref/tags%2Fb2`),
      `expected exact tag read URL, got: ${JSON.stringify(github.requests.filter((request) => request.url.includes("/git/ref")) )}`,
    );
    // The create-ref JSON body keeps the full refs/tags form.
    const create = github.requests.find(
      (request) => request.method === "POST" && new URL(request.url).pathname === "/repos/rfairburn/pi-review-gate/git/refs",
    );
    assert.ok(create?.body, "create-ref request must carry a JSON body");
    const parsed = JSON.parse(create?.body ?? "{}") as { ref?: string; sha?: string };
    assert.equal(parsed.ref, "refs/tags/b2");
    assert.equal(parsed.sha, repo.mergeCommit);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("a 422 tag-creation race re-reads and verifies the existing tag", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    // The tag exists but is invisible to our first read (concurrent creator);
    // the POST conflicts with 422 and the re-read must verify the exact SHA.
    seedOwnedDraft(github, repo, 96);
    github.delayedTagRef = "refs/tags/b2";
    const summary = await publishWith(repo, github);
    assert.equal(summary.outcome, "published");
    assert.equal(summary.tagCreated, false, "a raced tag must be treated as pre-existing");
    assert.equal(github.tags.get("refs/tags/b2"), repo.mergeCommit);
    assert.equal(
      github.countRequests((request) => request.method === "POST" && new URL(request.url).pathname === "/repos/rfairburn/pi-review-gate/git/refs"),
      1,
    );
    assert.ok(
      github.countRequests((request) => request.method === "GET" && request.url === `${API_BASE}/git/ref/tags%2Fb2`) >= 2,
      "the raced tag must be re-read after the conflict",
    );
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("manual dispatch and fork contexts are refused before any API write", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    await assert.rejects(
      publishWith(repo, github, { env: baseEnv({ GITHUB_SHA: repo.mergeCommit, GITHUB_EVENT_NAME: "workflow_dispatch" }) }),
      /GITHUB_EVENT_NAME/,
    );
    await assert.rejects(
      publishWith(repo, github, { env: baseEnv({ GITHUB_SHA: repo.mergeCommit, GITHUB_REPOSITORY: "fork/pi-review-gate" }) }),
      /GITHUB_REPOSITORY/,
    );
    assert.equal(github.countRequests((request) => request.method !== "GET"), 0);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

test("direct pushes (no merged PR) are refused before any tag or release write", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    await assert.rejects(publishWith(repo, github, { eligible: false }), /no pull request is associated/);
    assert.equal(github.tags.size, 0);
    assert.equal(github.releases.size, 0);
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});

// --- Production artifact build: install-identity gate ------------------------
// The real buildReleaseArtifacts must smoke-install the ACTUAL generated
// tarball before any publishable asset exists, and a failing smoke must stop
// the build (and therefore any publication). The helper's success path on a
// real artifact is covered end to end in release-package.test.ts.

const REAL_ROOT = projectRoot();

function buildEligibility(version: string): Eligibility {
  return {
    n: 1,
    target: TARGET,
    baseline: "a".repeat(40),
    tag: "b1",
    version,
    prNumber: 1,
    prMergeCommitSha: TARGET,
    associatedPullRequests: [1],
  };
}

function stubInstallSmoke(
  implementation: (options: Record<string, unknown>) => { installed: string; packageName: string; version: string },
): typeof packaging.verifyInstalledTarball {
  const original = packaging.verifyInstalledTarball;
  packaging.verifyInstalledTarball = implementation as typeof packaging.verifyInstalledTarball;
  return original;
}

test("the production artifact build smoke-verifies the exact tarball before returning publishable assets", { timeout: 300_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-build-smoke-"));
  const eligibility = buildEligibility("0.1.0-dev.1");
  const calls: Array<Record<string, unknown>> = [];
  const original = stubInstallSmoke((options) => {
    calls.push(options);
    return { installed: "", packageName: String(options.packageName), version: String(options.version) };
  });
  try {
    const build = await publish.buildReleaseArtifacts({ eligibility, projectRoot: REAL_ROOT, scratch });
    assert.equal(calls.length, 1, "the install smoke must run exactly once per artifact build");
    assert.equal(calls[0].packageName, "pi-review-gate");
    assert.equal(calls[0].version, eligibility.version);
    assert.equal(calls[0].scratchRoot, scratch);
    assert.equal(calls[0].projectRoot, REAL_ROOT);
    const tarballPath = String(calls[0].tarballPath);
    assert.equal(basename(tarballPath), publish.tarballFilenameFor(eligibility.version));
    assert.ok(statSync(tarballPath).isFile(), "the smoke must be pointed at the actual generated tarball");
    assert.equal(build.tarballFilename, publish.tarballFilenameFor(eligibility.version));
    assert.ok(build.tarballEntryCount > 0);
    assert.ok(build.assets.some((asset) => asset.filename === build.tarballFilename));
  } finally {
    packaging.verifyInstalledTarball = original;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a failing install smoke prevents the artifact build from returning publishable assets", { timeout: 300_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "release-build-smoke-fail-"));
  const original = stubInstallSmoke(() => {
    throw new Error("install smoke verification failed: simulated gate failure");
  });
  try {
    await assert.rejects(
      publish.buildReleaseArtifacts({ eligibility: buildEligibility("0.1.0-dev.1"), projectRoot: REAL_ROOT, scratch }),
      /install smoke verification failed/,
    );
  } finally {
    packaging.verifyInstalledTarball = original;
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("a failing artifact build never publishes: the owned draft stays resumable", async () => {
  const repo = makeRepo();
  const github = new MockGithub();
  try {
    await assert.rejects(
      publishWith(repo, github, {
        buildArtifacts: async () => {
          throw new Error("install smoke verification failed: simulated gate failure");
        },
      }),
      /install smoke verification failed/,
    );
    const release = github.releaseByTag("b2");
    assert.ok(release, "the owned draft created before the build remains");
    assert.equal(release.draft, true, "the release must stay a resumable draft, never published");
    assert.equal(
      github.countRequests((request) => request.method === "PATCH" && (request.body ?? "").includes('"draft":false')),
      0,
      "no publication PATCH may happen after a failed artifact build",
    );
    assert.equal(github.assetContents.size, 0, "no assets may be uploaded for a failed build");
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
});
