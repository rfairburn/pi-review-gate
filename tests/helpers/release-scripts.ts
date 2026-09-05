import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

// The release builder ships as plain CommonJS scripts (scripts/release/*.cjs);
// load them through createRequire so tests exercise the exact files the
// workflow runs. Module resolution walks up from this compiled test file to the
// repository root, which works both from tests/ and from dist-test/tests/.
function findProjectRoot(): string {
  let dir = __dirname;
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "scripts", "release"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error("release scripts project root not found");
    }
    dir = parent;
  }
}

const requireFromRoot = createRequire(__filename);

export interface ReleaseCommon {
  BASELINE_SHA: string;
  BASE_VERSION: string;
  ReleaseError: new (message: string) => Error;
  REPOSITORY: string;
  TAG_PREFIX: string;
  MAIN_REF: string;
  assertReleaseEventContext(env: Record<string, string | undefined>): { target: string; repository: string; ref: string };
  createApi(options: { fetchImpl: FetchLike; token?: string; repository: string }): ReleaseApi;
  git(args: string[], options: { repoRoot: string }): string;
  isHexSha(value: unknown): boolean;
  sha256Buffer(buffer: Buffer | string): string;
}

// Detailed pull request record (GET /pulls/{number}): carries the
// authoritative `merged` boolean. List-shaped association items from
// GET /commits/{sha}/pulls do NOT carry it.
export interface PullRequestFixture {
  number: number;
  state: string;
  merged?: boolean;
  merge_commit_sha?: string | null;
  base?: { ref?: string; repo?: { full_name?: string } | null };
}

export interface ReleaseApi {
  getTag(ref: string): Promise<Record<string, unknown> | null>;
  createTagRef(ref: string, sha: string): Promise<ApiResult>;
  // Published releases only; unpublished drafts 404 on this endpoint.
  getReleaseByTag(tag: string): Promise<Record<string, unknown> | null>;
  // Authenticated listing that includes drafts; bounded pagination.
  listReleases(options?: { perPage?: number; maxPages?: number }): Promise<Array<Record<string, unknown>>>;
  createRelease(body: Record<string, unknown>): Promise<ApiResult>;
  updateRelease(releaseId: number, body: Record<string, unknown>): Promise<ApiResult>;
  getRelease(releaseId: number): Promise<Record<string, unknown> | null>;
  getCommitPullRequests(sha: string, options?: { perPage?: number; maxPages?: number }): Promise<PullRequestFixture[]>;
  // Detailed record; 404 resolves to null.
  getPullRequest(number: number): Promise<PullRequestFixture | null>;
  uploadAsset(uploadUrl: string, name: string, buffer: Buffer): Promise<Record<string, unknown>>;
  downloadAsset(assetId: number): Promise<{ buffer: Buffer; status: number }>;
  deleteAsset(assetId: number, name: string): Promise<void>;
}

export interface ApiResult {
  status: number;
  json?: Record<string, unknown> | null;
  text: string;
}

export interface NumberingModule {
  firstParentDistance(options: { repoRoot: string; target: string; baseline?: string }): { n: number; target: string; baseline: string };
  resolveMainRef(repoRoot: string): { ref: string; sha: string };
  assertTargetOnMainFirstParent(options: { repoRoot: string; target: string }): { mainRef: string; mainSha: string };
}

export interface Eligibility {
  n: number;
  target: string;
  baseline: string;
  tag: string;
  version: string;
  prNumber: number;
  prMergeCommitSha: string;
  associatedPullRequests: number[];
}

export interface EligibilityModule {
  isEligiblePullRequest(pr: PullRequestFixture | null, target: string): boolean;
  resolveEligibility(options: {
    env: Record<string, string | undefined>;
    fetchImpl: FetchLike;
    repoRoot?: string;
    gitDir?: string;
    baseline?: string;
  }): Promise<Eligibility>;
  summarizeGITHUBOutput(eligibility: Eligibility): string;
}

export interface PublishSummary {
  outcome: string;
  tag: string;
  version: string;
  target: string;
  releaseUrl?: string;
  tarballSha256: string;
  tarballEntries: number;
  mode?: string;
  tagCreated?: boolean;
  assets?: { uploaded: string[]; kept: string[]; replaced: string[] };
}

export interface PublishModule {
  identityMarker(eligibility: Eligibility): string;
  ensureTag(options: { api: ReleaseApi; tag: string; target: string }): Promise<{ created: boolean; sha: string }>;
  expectedAssetNames(tarballFilename: string): string[];
  parseProvenanceFromBody(body: string): Record<string, unknown> | null;
  publishRelease(options: {
    env: Record<string, string | undefined>;
    fetchImpl: FetchLike;
    projectRoot: string;
    scratchRoot?: string;
    baseline?: string;
    buildArtifacts?(options: { eligibility: Eligibility; projectRoot: string; scratch: string }): Promise<{
      assets: Array<{ filename: string; buffer: Buffer; sha256: string; size: number }>;
      provenance: Record<string, unknown>;
      tarballFilename: string;
      tarballEntryCount: number;
    }>;
  }): Promise<PublishSummary>;
  releaseBody(eligibility: Eligibility, provenance?: Record<string, unknown>): string;
  findReleaseByTag(options: { api: ReleaseApi; tag: string }): Promise<Record<string, unknown> | null>;
  resolveOrCreateDraftRelease(options: {
    api: ReleaseApi;
    eligibility: Eligibility;
    provenance: Record<string, unknown>;
  }): Promise<{ release: Record<string, unknown>; mode: string }>;
  syncDraftAssets(options: { api: ReleaseApi; release: Record<string, unknown>; assets: Array<{
    filename: string;
    buffer: Buffer;
    sha256: string;
    size: number;
  }> }): Promise<{
    uploaded: string[];
    kept: string[];
    replaced: string[];
  }>;
  verifyPublishedRelease(options: { api: ReleaseApi; release: Record<string, unknown>; eligibility: Eligibility }): Promise<{ verified: boolean; tarballSha256: string }>;
  buildReleaseArtifacts(options: { eligibility: Eligibility; projectRoot: string; scratch: string }): Promise<{
    assets: Array<{ filename: string; buffer: Buffer; sha256: string; size: number }>;
    provenance: Record<string, unknown>;
    tarballFilename: string;
    tarballEntryCount: number;
  }>;
}

export interface PackagingModule {
  PROVENANCE_SCHEMA: string;
  buildProvenance(options: Record<string, unknown>): Record<string, unknown>;
  buildSha256Sums(lines: Array<{ sha256: string; filename: string }>): string;
  deriveLockfile(sourceLockRaw: string, name: string, version: string): string;
  derivePackageJson(sourcePackageJson: string, version: string): string;
  expandFilesGlob(projectRoot: string, entry: string): string[];
  installSmokeChildEnv(baseEnv: Record<string, string | undefined>): Record<string, string>;
  packStage(options: { stage: string; packDestination: string }): string;
  parseSha256Sums(text: string): Map<string, string>;
  stagePackage(options: { projectRoot: string; stageRoot: string; version: string }): string;
  verifyInstalledTarball(options: {
    tarballPath: string;
    scratchRoot: string;
    projectRoot: string;
    packageName: string;
    version: string;
  }): { installed: string; packageName: string; version: string };
  verifyTarball(options: { tarballPath: string; extractDir: string }): { entries: string[] };
}

export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string | undefined;
}) => Promise<{ status: number; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> }>;

export function loadReleaseModule<T>(name: string): T {
  const root = findProjectRoot();
  const resolved = path.join(root, "scripts", "release", name);
  if (!fs.existsSync(resolved)) {
    throw new Error(`release script not found: ${resolved}`);
  }
  return requireFromRoot(resolved) as T;
}

export function projectRoot(): string {
  return findProjectRoot();
}
