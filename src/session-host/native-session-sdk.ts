import { accessSync, constants as fsConstants, lstatSync, readFileSync, realpathSync } from "node:fs";
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
 * - Bounded ancestor walk from the CLI file to the nearest `package.json`
 *   whose `name` is exactly `@earendil-works/pi-coding-agent`. No guessed
 *   home releases, no unrelated PATH packages, no private SDK locations.
 * - The public entry comes only from that package's own metadata: the
 *   `exports["."]` target (require/import/default conditions) or `main`,
 *   resolved to a contained regular readable Node file inside the package.
 *   Private SDK internals (`core/session-manager.js`, keybindings, …) are
 *   never imported; only the package's declared public entry is loaded.
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
  /** The owning package's declared version. */
  version: string;
}

interface SdkPackageManifest {
  name?: unknown;
  version?: unknown;
  main?: unknown;
  exports?: unknown;
}

/** Bounded, parse-checked read of one ancestor package.json (undefined when absent). */
function readSdkPackageManifest(dir: string): SdkPackageManifest | undefined {
  const candidate = join(dir, "package.json");
  let stats;
  try {
    stats = lstatSync(candidate);
  } catch {
    return undefined;
  }
  if (!stats.isFile()) return undefined; // a symlinked or special package.json is never trusted
  if (stats.size > MAX_SDK_PACKAGE_JSON_BYTES) return undefined;
  let text: string;
  try {
    text = readFileSync(candidate, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as SdkPackageManifest;
}

/**
 * Resolve the official Pi package directory containing the CLI: a bounded
 * ancestor walk from the CLI's own directory, stopping at the nearest
 * `package.json` named exactly `@earendil-works/pi-coding-agent`. The CLI
 * file must remain contained in the resolved package (same-package
 * containment); unrelated packages are skipped, and the walk never descends
 * anywhere (ancestors only).
 */
function findOwnPiPackage(piExecutable: string): { packageDir: string; manifest: SdkPackageManifest } | undefined {
  let dir = dirname(resolve(piExecutable));
  for (;;) {
    const manifest = readSdkPackageManifest(dir);
    if (manifest && manifest.name === PI_PACKAGE_NAME) {
      return { packageDir: dir, manifest };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined; // filesystem root reached without the official package
    dir = parent;
  }
}

/** Extract a contained relative entry target from `exports["."]` or `main` metadata. */
function resolvePublicEntryTarget(manifest: SdkPackageManifest): string | undefined {
  const exportsField = manifest.exports;
  if (exportsField !== undefined) {
    let rootExport: unknown = exportsField;
    if (typeof exportsField === "object" && !Array.isArray(exportsField)) {
      rootExport = (exportsField as Record<string, unknown>)["."];
    }
    let target: unknown = rootExport;
    if (typeof rootExport === "object" && rootExport !== null && !Array.isArray(rootExport)) {
      const conditions = rootExport as Record<string, unknown>;
      target = conditions.require ?? conditions.import ?? conditions.default;
    }
    if (typeof target === "string" && target.startsWith("./")) return target;
    return undefined; // an exports map without a usable "." string target is unavailable
  }
  if (typeof manifest.main === "string" && manifest.main.startsWith("./")) return manifest.main;
  if (typeof manifest.main === "string" && !manifest.main.startsWith(".")) {
    // A bare `main` (e.g. "index.js") is still package-relative per Node semantics.
    return `./${manifest.main}`;
  }
  return undefined;
}

const sdkCache = new Map<string, NativeSessionSdk>();

/**
 * Resolve and load the public SDK entry of the official Pi package that owns
 * the given (already resolved) native Pi CLI file. Synchronous: the entry is
 * a CommonJS module loaded with `require` exactly once per entry path.
 *
 * Fails closed with bounded diagnostics (package name/entry kind only, never
 * environment or file content) when: the runtime context is forbidden, the
 * official package is not an ancestor of the CLI, the public entry metadata
 * is missing or points outside the package, the entry is not a readable
 * regular file, or the loaded module lacks the `SessionManager.listAll`
 * runtime. A missing public SDK is an honest unavailability, never a stub.
 */
export function resolveNativeSessionSdk(piExecutable: string): NativeSessionSdk {
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
  if (!owned) {
    throw new Error(
      `pi-review-gate: no official ${PI_PACKAGE_NAME} package was found above the native pi executable; the public session SDK is unavailable`,
    );
  }
  const { packageDir, manifest } = owned;

  // Same-package containment: the CLI must live inside the resolved package.
  const relativeCli = relative(packageDir, piExecutable);
  if (relativeCli.startsWith("..") || isAbsolute(relativeCli)) {
    throw new Error(
      `pi-review-gate: the native pi executable is not contained in its own ${PI_PACKAGE_NAME} package; the public session SDK is unavailable`,
    );
  }

  const entryTarget = resolvePublicEntryTarget(manifest);
  if (!entryTarget) {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} package declares no usable public SDK entry (exports["."] or main); the public session SDK is unavailable`,
    );
  }
  const entry = resolve(packageDir, entryTarget);
  if (relative(packageDir, entry).startsWith("..") || isAbsolute(relative(packageDir, entry))) {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} public SDK entry escapes the package directory; refusing to load it`,
    );
  }
  // Canonical containment: an intermediate entry directory (e.g. dist/) may be
  // a symlink OUTSIDE the owning package even though the lexical path and the
  // final lstat look contained. Resolve the real path and require it stay
  // inside the canonical package directory before anything is loaded.
  const packageDirReal = realpathSync(packageDir);
  let entryReal;
  try {
    entryReal = realpathSync(entry);
  } catch {
    throw new Error(
      `pi-review-gate: the official ${PI_PACKAGE_NAME} public SDK entry is missing; the public session SDK is unavailable`,
    );
  }
  if (relative(packageDirReal, entryReal).startsWith("..") || isAbsolute(relative(packageDirReal, entryReal))) {
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

  const cached = sdkCache.get(entryReal);
  if (cached) return cached;

  // Load exactly the canonical path that was validated above.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const module: unknown = require(entryReal);
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

  const version = typeof manifest.version === "string" ? manifest.version : "unknown";
  const sdk: NativeSessionSdk = {
    SessionManager: manager as NativeSessionSdkManager,
    entry: entryReal,
    packageDir,
    version,
  };
  sdkCache.set(entryReal, sdk);
  return sdk;
}
