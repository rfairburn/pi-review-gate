import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Public SDK loader for the native saved-session catalog (issue 323).
 *
 * The read-only saved-conversation catalog needs the Pi package's PUBLIC SDK
 * surface (`SessionManager.listAll` with the explicit flat-directory overload
 * and the `SessionInfo` row type). This module resolves that surface from the
 * OWN official `@earendil-works/pi-coding-agent` package that contains the
 * resolved native Pi CLI:
 *
 * - Bounded ancestor walk (MAX_SDK_ANCESTOR_STEPS) from the CLI file to the
 *   nearest `package.json` — a package boundary. Only a boundary named
 *   exactly `@earendil-works/pi-coding-agent` may own the CLI; an unrelated
 *   boundary or reaching the bound without one is an honest unavailability.
 *   No guessed home releases, no unrelated PATH packages, no private SDK
 *   locations.
 * - The package metadata must agree: a stable declared version at or above
 *   MIN_SUPPORTED_PI_VERSION (never "unknown", malformed, or a prerelease),
 *   an official `pi` CLI bin declared and contained in the package as a
 *   regular readable file, and — when the caller admits a Pi version — exact
 *   agreement with it. All of this is checked BEFORE any cached entry can be
 *   returned.
 * - The public entry comes only from that package's own metadata: the
 *   `exports["."]` target (require/import/default conditions) or `main`,
 *   resolved to a contained regular readable Node file inside the package.
 *   Private SDK internals (`core/session-manager.js`, keybindings, …) are
 *   never imported; only the package's declared public entry is loaded with
 *   the supported Node loader (`require` of the canonical entry, which the
 *   supported Node runtime resolves for both CommonJS and ESM entries).
 * - The loaded module must export a `SessionManager` runtime with a static
 *   `listAll` function; anything else is an honest "unavailable" diagnostic.
 *
 * The loader refuses to run inside executor/research/runtime-role or
 * settlement contexts: the catalog is a top-level native-host capability, and
 * a delegated worker's environment must never drive SDK loading (the frozen
 * permission ceilings are preserved — the role markers are rejected, never
 * stripped to prove the SDK loads). No `HOME` or `process.env` mutation ever
 * happens here: the catalog always lists EXPLICIT session directories, so the
 * SDK's default-directory resolution is never relied upon.
 */

/** The official Pi package name (the only accepted SDK provider). */
export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** Environment markers whose presence forbids SDK loading (rejected, never stripped). */
const FORBIDDEN_SDK_ENV_MARKERS: readonly string[] = [
  "PI_REVIEW_GATE_RUNTIME_ROLE",
  "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG",
];

/** Settlement/quiescence authorization marker prefixes that forbid SDK loading. */
const FORBIDDEN_SDK_ENV_PREFIXES: readonly string[] = [
  "PI_REVIEW_GATE_SETTLEMENT_",
  "PI_REVIEW_GATE_QUIESCENCE_",
];

/** Upper bound for one package.json read during the bounded ancestor walk. */
export const MAX_SDK_PACKAGE_JSON_BYTES = 256 * 1024;

/** Fixed bound on the ancestor walk from the CLI to its owning package boundary. */
export const MAX_SDK_ANCESTOR_STEPS = 32;

/** Lowest stable Pi version whose public SDK this catalog supports. */
export const MIN_SUPPORTED_PI_VERSION = "1.0.4";

/** Minimal structural view of a public SDK session row (SessionInfo). */
export interface NativeSessionSdkInfo {
  /** Absolute path of the saved conversation JSONL file. */
  path: string;
  /** Session ID recorded in the file header. */
  id: string;
  /** Working directory recorded in the file header. */
  cwd: string;
  /** Persisted session name, when present. */
  name?: string;
  /** First user message text, when present (caption fallback only). */
  firstMessage?: string;
  created?: Date;
  modified?: Date;
}

/**
 * Minimal structural view of the public SDK SessionManager runtime: only the
 * explicit flat-directory `listAll` overload is used. The no-arg overload
 * (project-directory scan that follows symlinks) and the cwd-filtering
 * `list` are deliberately NOT part of this interface.
 */
export interface NativeSessionSdkManager {
  listAll(
    sessionDir: string,
    onProgress?: (progress: Readonly<Record<string, unknown>>) => void,
    signal?: AbortSignal,
  ): Promise<NativeSessionSdkInfo[]>;
}

/** A resolved public SDK view bound to one official Pi package. */
export interface NativeSessionSdk {
  /** The public SDK SessionManager runtime. */
  SessionManager: NativeSessionSdkManager;
  /** Absolute path of the loaded public SDK entry file. */
  entry: string;
  /** Absolute path of the owning official Pi package directory. */
  packageDir: string;
  /** The owning package's declared stable version. */
  version: string;
}

/** Optional caller context for public SDK resolution. */
export interface ResolveNativeSessionSdkOptions {
  /**
   * The caller's admitted Pi version: when provided, the owning package's
   * declared version must agree with it exactly; anything else is an honest
   * unavailability. No CLI execution or probe happens here.
   */
  expectedPiVersion?: string;
}

interface SdkPackageManifest {
  name?: unknown;
  version?: unknown;
  main?: unknown;
  exports?: unknown;
  bin?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** True when `path` lexically escapes `root`. */
function escapesRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel.startsWith("..") || isAbsolute(rel);
}

/**
 * Bounded, descriptor-based, parse-checked read of one ancestor package.json.
 * The manifest is opened non-blocking with O_NOFOLLOW and sized via fstat
 * BEFORE any read, so a symlinked foreign manifest or an unbounded file is
 * never trusted. The outcomes are deliberately distinct: `absent` means the
 * walk may continue to the next ancestor; `invalid` means an EXISTING
 * package boundary is not trustworthy (malformed, oversized, unreadable,
 * symlinked, special, or replaced between inspection and open) and the walk
 * must STOP there — it never crosses an invalid boundary to attribute the
 * CLI to an outer package.
 */
type SdkManifestRead =
  | { status: "absent" }
  | { status: "valid"; manifest: SdkPackageManifest }
  | { status: "invalid"; reason: string };

function readSdkPackageManifest(dir: string): SdkManifestRead {
  const candidate = join(dir, "package.json");
  let preStats;
  try {
    preStats = lstatSync(candidate, { bigint: true });
  } catch (error) {
    // Only ENOENT establishes an ABSENT manifest. Permission or I/O failures
    // mean an existing boundary that cannot be inspected: the walk must stop
    // there, never cross it toward an outer package.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent" };
    return { status: "invalid", reason: "package.json could not be inspected" };
  }
  // A symlinked or special package.json is an EXISTING invalid boundary.
  if (preStats.isSymbolicLink() || !preStats.isFile()) {
    return { status: "invalid", reason: "package.json is not a regular file" };
  }
  let fd: number;
  try {
    fd = openSync(candidate, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return { status: "invalid", reason: "package.json could not be opened" };
  }
  try {
    try {
      const stats = fstatSync(fd, { bigint: true });
      // Descriptor identity: the opened file must be the same regular file
      // that was inspected; a replacement between lstat and open is an
      // invalid boundary.
      if (stats.dev !== preStats.dev || stats.ino !== preStats.ino) {
        return { status: "invalid", reason: "package.json identity changed between inspection and open" };
      }
      if (!stats.isFile() || stats.size <= 0 || stats.size > MAX_SDK_PACKAGE_JSON_BYTES) {
        return { status: "invalid", reason: "package.json is not a bounded regular file" };
      }
      const buffer = Buffer.alloc(Number(stats.size));
      let offset = 0;
      while (offset < buffer.length) {
        const bytesRead = readSync(fd, buffer, offset, buffer.length - offset, offset);
        if (bytesRead <= 0) break; // shrank underneath us: the bounded partial read fails parsing
        offset += bytesRead;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
      } catch {
        return { status: "invalid", reason: "package.json is malformed" };
      }
      if (!isPlainObject(parsed)) return { status: "invalid", reason: "package.json is malformed" };
      return { status: "valid", manifest: parsed as SdkPackageManifest };
    } catch {
      // Any descriptor failure (fstat/read I/O) is a bounded invalid boundary,
      // never an unbounded escape toward the caller.
      return { status: "invalid", reason: "package.json could not be read" };
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      // A close failure must not mask the bounded manifest read result.
    }
  }
}

type OwnPackageSearch =
  | { status: "found"; packageDir: string; manifest: SdkPackageManifest }
  | { status: "unrelated-boundary" }
  | { status: "invalid-boundary"; reason: string }
  | { status: "bound-reached" };

/**
 * Resolve the official Pi package directory containing the CLI: a bounded
 * ancestor walk (at most MAX_SDK_ANCESTOR_STEPS) from the CLI's own directory
 * to the nearest `package.json` — a package boundary. Only a boundary named
 * exactly `@earendil-works/pi-coding-agent` may own the CLI; an unrelated
 * boundary means the CLI is not inside its own official package (the walk
 * never continues into unrelated PATH or private SDK locations), and reaching
 * the bound without any boundary is an honest unavailability. The walk never
 * descends anywhere (ancestors only).
 */
function findOwnPiPackage(piExecutable: string): OwnPackageSearch {
  let dir = dirname(resolve(piExecutable));
  for (let step = 0; step < MAX_SDK_ANCESTOR_STEPS; step += 1) {
    const read = readSdkPackageManifest(dir);
    if (read.status === "valid") {
      return read.manifest.name === PI_PACKAGE_NAME
        ? { status: "found", packageDir: dir, manifest: read.manifest }
        : { status: "unrelated-boundary" };
    }
    if (read.status === "invalid") {
      // An EXISTING but untrustworthy boundary stops the walk: the CLI is
      // never attributed to an outer package across it.
      return { status: "invalid-boundary", reason: read.reason };
    }
    const parent = dirname(dir);
    if (parent === dir) return { status: "bound-reached" }; // filesystem root reached within the bound
    dir = parent;
  }
  return { status: "bound-reached" };
}

/**
 * Parse a stable (non-prerelease, non-build-suffixed) semver triple. Malformed
 * numeric components are rejected: leading zeros ("01") and values that are
 * not finite safe integers (arbitrarily large components).
 */
function parseStablePiVersion(version: unknown): readonly [number, number, number] | undefined {
  if (typeof version !== "string") return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  // The match must consume the ENTIRE string: JavaScript's $ also matches
  // before a final line terminator, so "1.0.4\n" would otherwise pass.
  if (!match || match[0] !== version) return undefined;
  const parts: number[] = [];
  for (const raw of [match[1], match[2], match[3]]) {
    if (raw.length > 1 && raw.startsWith("0")) return undefined; // leading zeros are malformed semver
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) return undefined;
    parts.push(value);
  }
  return [parts[0], parts[1], parts[2]] as const;
}

const MIN_SUPPORTED_PI_VERSION_PARTS = parseStablePiVersion(MIN_SUPPORTED_PI_VERSION);

/** True only for stable declared versions at or above MIN_SUPPORTED_PI_VERSION. */
function isSupportedStablePiVersion(version: unknown): boolean {
  const parsed = parseStablePiVersion(version);
  if (parsed === undefined || MIN_SUPPORTED_PI_VERSION_PARTS === undefined) return false;
  for (let i = 0; i < 3; i += 1) {
    if (parsed[i] !== MIN_SUPPORTED_PI_VERSION_PARTS[i]) {
      return parsed[i] > MIN_SUPPORTED_PI_VERSION_PARTS[i];
    }
  }
  return true;
}

/** Extract a contained relative entry target from `exports["."]` or `main` metadata. */
function resolvePublicEntryTarget(manifest: SdkPackageManifest): string | undefined {
  const exportsField = manifest.exports;
  if (exportsField !== undefined) {
    // Node semantics: a present exports field takes precedence over main. A
    // malformed or unsupported exports map is an honest unavailability, never
    // a fallback to private internals.
    if (!isPlainObject(exportsField)) return undefined;
    const rootExport = exportsField["."];
    if (typeof rootExport === "string") {
      return rootExport.startsWith("./") ? rootExport : undefined;
    }
    if (isPlainObject(rootExport)) {
      const target = rootExport.require ?? rootExport.import ?? rootExport.default;
      return typeof target === "string" && target.startsWith("./") ? target : undefined;
    }
    return undefined;
  }
  if (typeof manifest.main === "string" && manifest.main.length > 0) {
    if (manifest.main.startsWith("./")) return manifest.main;
    if (!manifest.main.startsWith(".") && !manifest.main.startsWith("/") && !/^[A-Za-z]:/.test(manifest.main)) {
      // A bare `main` (e.g. "index.js") is still package-relative per Node semantics.
      return `./${manifest.main}`;
    }
  }
  return undefined;
}

/** Extract the official `pi` CLI bin target from package metadata, when declared. */
function resolveDeclaredCliBinTarget(manifest: SdkPackageManifest): string | undefined {
  const bin = manifest.bin;
  const declared = typeof bin === "string" ? bin : isPlainObject(bin) ? bin["pi"] : undefined;
  if (typeof declared !== "string" || declared.length === 0) return undefined;
  if (declared.startsWith("./")) return declared;
  if (!declared.startsWith(".") && !declared.startsWith("/") && !/^[A-Za-z]:/.test(declared)) {
    // A bare bin path (e.g. "dist/bundle/cli.js") is package-relative per npm semantics.
    return `./${declared}`;
  }
  return undefined;
}

/** A cached SDK view bound to the exact metadata that admitted it. */
interface SdkCacheEntry {
  sdk: NativeSessionSdk;
  version: string;
  packageDirReal: string;
}

const sdkCache = new Map<string, SdkCacheEntry>();

/**
 * Resolve and load the public SDK entry of the official Pi package that owns
 * the given (already resolved) native Pi CLI file. Synchronous: the canonical
 * entry is loaded with `require` exactly once per entry path (the supported
 * Node runtime resolves CommonJS and ESM public entries alike).
 *
 * Fails closed with bounded diagnostics (package name/entry kind only, never
 * environment or file content) when: the runtime context is forbidden, the
 * official package is not the CLI's own package boundary (or no boundary
 * exists within the walk bound), the declared version is not a supported
 * stable Pi version (or disagrees with the caller-admitted one), the official
 * CLI bin metadata is missing or escapes the package, the public entry
 * metadata is missing or points outside the package, the entry is not a
 * readable regular file, or the loaded module lacks the
 * `SessionManager.listAll` runtime. A missing public SDK is an honest
 * unavailability, never a stub.
 */
export function resolveNativeSessionSdk(
  piExecutable: string,
  options: ResolveNativeSessionSdkOptions = {},
): NativeSessionSdk {
  for (const marker of FORBIDDEN_SDK_ENV_MARKERS) {
    if (process.env[marker] !== undefined) {
      throw new Error(
        `pi-review-gate: the native session SDK cannot be loaded while ${marker} is set; saved-session cataloging is a top-level native-host capability`,
      );
    }
  }
  for (const prefix of FORBIDDEN_SDK_ENV_PREFIXES) {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith(prefix) && process.env[key] !== undefined) {
        throw new Error(
          `pi-review-gate: the native session SDK cannot be loaded in a settlement context (${prefix}* is set); saved-session cataloging is a top-level native-host capability`,
        );
      }
    }
  }

  if (!isAbsolute(piExecutable)) {
    throw new Error("pi-review-gate: the native pi executable must be an absolute path for SDK resolution");
  }
  let cliStats;
  try {
    cliStats = lstatSync(piExecutable);
  } catch {
    throw new Error(`pi-review-gate: the native pi executable is missing for SDK resolution: ${piExecutable}`);
  }
  if (!cliStats.isFile()) {
    throw new Error(`pi-review-gate: the native pi executable is not a regular file for SDK resolution: ${piExecutable}`);
  }

  const owned = findOwnPiPackage(piExecutable);
  if (owned.status === "unrelated-boundary") {
    throw new Error(
      `pi-review-gate: the native pi executable is not inside its own ${PI_PACKAGE_NAME} package (the nearest package boundary is unrelated); the public session SDK is unavailable`,
    );
  }
  if (owned.status === "invalid-boundary") {
    throw new Error(
      `pi-review-gate: an invalid package boundary was found while locating the ${PI_PACKAGE_NAME} package (${owned.reason}); the public session SDK is unavailable`,
    );
  }
  if (owned.status === "bound-reached") {
    throw new Error(
      `pi-review-gate: no package boundary was found within ${MAX_SDK_ANCESTOR_STEPS} ancestors of the native pi executable; the public session SDK is unavailable`,
    );
  }
  const { packageDir, manifest } = owned;

  // Metadata agreement, checked BEFORE any cached entry can be returned: a
  // stable declared version at or above the supported floor (never "unknown"
  // or a prerelease), and exact agreement with the caller-admitted Pi version
  // when one is provided.
  if (!isSupportedStablePiVersion(manifest.version)) {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} package does not declare a supported stable version (>= ${MIN_SUPPORTED_PI_VERSION}); the public session SDK is unavailable`,
    );
  }
  const version = manifest.version as string;
  if (options.expectedPiVersion !== undefined && version !== options.expectedPiVersion) {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} package version does not agree with the caller-admitted Pi version; the public session SDK is unavailable`,
    );
  }

  // Same-package containment: the CLI must live inside the resolved package.
  if (escapesRoot(packageDir, piExecutable)) {
    throw new Error(
      `pi-review-gate: the native pi executable is not contained in its own ${PI_PACKAGE_NAME} package; the public session SDK is unavailable`,
    );
  }

  // Canonical containment: an intermediate directory (e.g. dist/) may be a
  // symlink OUTSIDE the owning package even though the lexical path and the
  // final lstat look contained. Resolve the real paths and require the CLI to
  // stay inside the canonical package directory before anything is loaded.
  let packageDirReal;
  try {
    packageDirReal = realpathSync(packageDir);
  } catch {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} package directory is missing; the public session SDK is unavailable`,
    );
  }
  let cliReal;
  try {
    cliReal = realpathSync(piExecutable);
  } catch {
    throw new Error(`pi-review-gate: the native pi executable is missing for SDK resolution: ${piExecutable}`);
  }
  if (escapesRoot(packageDirReal, cliReal)) {
    throw new Error(
      `pi-review-gate: the native pi executable is not contained in its own ${PI_PACKAGE_NAME} package; the public session SDK is unavailable`,
    );
  }

  // The official CLI bin must be declared and contained in the package as a
  // regular readable file (metadata agreement for the official provider).
  const binTarget = resolveDeclaredCliBinTarget(manifest);
  if (!binTarget) {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} package declares no official pi CLI bin; the public session SDK is unavailable`,
    );
  }
  const declaredBin = resolve(packageDir, binTarget);
  if (escapesRoot(packageDir, declaredBin)) {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} package CLI bin escapes the package directory; refusing to use it`,
    );
  }
  let declaredBinReal;
  try {
    declaredBinReal = realpathSync(declaredBin);
  } catch {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} package CLI bin is missing; the public session SDK is unavailable`,
    );
  }
  if (escapesRoot(packageDirReal, declaredBinReal)) {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} package CLI bin escapes the package directory; refusing to use it`,
    );
  }
  let binStats;
  try {
    binStats = lstatSync(declaredBinReal);
  } catch {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} package CLI bin is missing; the public session SDK is unavailable`,
    );
  }
  if (binStats.isSymbolicLink() || !binStats.isFile()) {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} package CLI bin is not a regular file; the public session SDK is unavailable`,
    );
  }
  try {
    accessSync(declaredBinReal, fsConstants.R_OK);
  } catch {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} package CLI bin is not readable; the public session SDK is unavailable`,
    );
  }

  // The given CLI must BE the declared official bin or the specific official
  // unbundled entry (dist/cli.js) — never an additional wrapper script that
  // merely sits inside the package.
  let cliIsOfficial = cliReal === declaredBinReal;
  if (!cliIsOfficial) {
    const unbundledEntry = resolve(packageDir, "dist", "cli.js");
    if (!escapesRoot(packageDir, unbundledEntry)) {
      let unbundledReal: string | undefined;
      try {
        unbundledReal = realpathSync(unbundledEntry);
      } catch {
        unbundledReal = undefined;
      }
      if (unbundledReal !== undefined && !escapesRoot(packageDirReal, unbundledReal) && cliReal === unbundledReal) {
        let unbundledStats;
        try {
          unbundledStats = lstatSync(unbundledReal);
        } catch {
          unbundledStats = undefined;
        }
        if (unbundledStats !== undefined && !unbundledStats.isSymbolicLink() && unbundledStats.isFile()) {
          cliIsOfficial = true;
        }
      }
    }
  }
  if (!cliIsOfficial) {
    throw new Error(
      `pi-review-gate: the native pi executable is not the official CLI of its ${PI_PACKAGE_NAME} package (the declared bin or dist/cli.js); the public session SDK is unavailable`,
    );
  }
  try {
    accessSync(cliReal, fsConstants.R_OK);
  } catch {
    throw new Error(
      `pi-review-gate: the native pi executable is not readable; the public session SDK is unavailable`,
    );
  }

  const entryTarget = resolvePublicEntryTarget(manifest);
  if (!entryTarget) {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} package declares no usable public SDK entry (exports["."] or main); the public session SDK is unavailable`,
    );
  }
  const entry = resolve(packageDir, entryTarget);
  if (escapesRoot(packageDir, entry)) {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} public SDK entry escapes the package directory; refusing to load it`,
    );
  }
  // Canonical containment for the entry as well: an intermediate entry
  // directory (e.g. dist/) may be a symlink OUTSIDE the owning package even
  // though the lexical path and the final lstat look contained.
  let entryReal;
  try {
    entryReal = realpathSync(entry);
  } catch {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} public SDK entry is missing; the public session SDK is unavailable`,
    );
  }
  if (escapesRoot(packageDirReal, entryReal)) {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} public SDK entry escapes the package directory; refusing to load it`,
    );
  }
  let entryStats;
  try {
    entryStats = lstatSync(entryReal);
  } catch {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} public SDK entry is missing; the public session SDK is unavailable`,
    );
  }
  if (!entryStats.isFile()) {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} public SDK entry is not a regular file; the public session SDK is unavailable`,
    );
  }
  try {
    accessSync(entryReal, fsConstants.R_OK);
  } catch {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} public SDK entry is not readable; the public session SDK is unavailable`,
    );
  }

  // All metadata/identity/version gating is done: only now may a cached
  // entry be returned — and only when the cached view still agrees with the
  // CURRENT validated metadata. require() would not reload an already-loaded
  // module, so a package whose version or identity changed since the first
  // load must fail closed instead of returning a stale SDK view.
  const cached = sdkCache.get(entryReal);
  if (cached) {
    if (cached.version !== version || cached.packageDirReal !== packageDirReal) {
      throw new Error(
        `pi-review-gate: the loaded public SDK no longer matches the current ${PI_PACKAGE_NAME} package metadata; the public session SDK is unavailable`,
      );
    }
    return cached.sdk;
  }

  let module: unknown;
  try {
    // Load exactly the canonical path that was validated above. The supported
    // Node runtime resolves both CommonJS and ESM public entries here.
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    module = require(entryReal);
  } catch {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} public SDK entry failed to load; the public session SDK is unavailable`,
    );
  }
  if (module === null || typeof module !== "object") {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} public SDK entry did not load a module; the public session SDK is unavailable`,
    );
  }
  const manager = (module as { SessionManager?: unknown }).SessionManager;
  // A class is a function: accept any non-null object OR function that carries
  // a callable static listAll.
  if (manager === null || (typeof manager !== "object" && typeof manager !== "function")) {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} public SDK entry does not export a SessionManager runtime; the public session SDK is unavailable`,
    );
  }
  if (typeof (manager as { listAll?: unknown }).listAll !== "function") {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} public SDK SessionManager lacks a static listAll; the public session SDK is unavailable`,
    );
  }

  const sdk: NativeSessionSdk = {
    SessionManager: manager as NativeSessionSdkManager,
    entry: entryReal,
    packageDir,
    version,
  };
  sdkCache.set(entryReal, { sdk, version, packageDirReal });
  return sdk;
}
