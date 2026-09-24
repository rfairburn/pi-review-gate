/**
 * Shared host peer-module loader (issue #185).
 *
 * One internal utility for loading the running Pi's own packages (pi-tui and
 * friends) as host-provided peers — never hard dependencies. Both consumers
 * (src/settings/menu.ts, issue #140, and src/user-question/pi-tui-host.ts,
 * issue #95/#182) previously carried byte-equivalent copies of this
 * two-step strategy; it now lives here once:
 *
 * 1. Soft `require` of the package name — inside a jiti-transformed Pi
 *    extension the loader aliases both names to the running host's modules
 *    (verified in pi 0.85.1, dist/core/extensions/loader.js); a local
 *    node_modules copy works too.
 * 2. Host-relative resolution for compiled entries: since pi 0.86 (jiti 2.7,
 *    Node >= 24) a pre-compiled CommonJS entry is loaded by native import and
 *    its `require()` calls bypass the jiti aliases, so step 1 throws
 *    MODULE_NOT_FOUND. The loader then locates the running Pi install from
 *    `process.argv[1]` (realpath, nearest package.json named
 *    @earendil-works/pi-coding-agent), resolves the peer with
 *    `createRequire(piEntry).resolve()` and loads it with `require()` (CJS,
 *    or ESM via require(esm) on Node >= 22.12) falling back to a native
 *    dynamic `import()` for ESM on Node 20. With
 *    {@link HostPeerLoadOptions.packageMainFallback}, a package that only
 *    exposes ESM "import" exports (the agent package) is resolved through its
 *    own package.json `main` field when it is the running host itself.
 *    Both load paths hit Node's module cache, so repeated loads share one
 *    instance inside the extension process.
 *
 * Each consumer keeps its own public test seams: the fake-host override and
 * the Pi-entry-provider slot live in the consumer modules (so test overrides
 * stay independent), and this loader receives the entry provider through
 * {@link HostPeerLoadOptions.entryProvider}. No installed path is hard-coded;
 * anything that cannot be resolved (outside Pi, unit tests, SEA/binary
 * hosts) yields undefined and the caller degrades.
 */

import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Package names of the running host (current plus legacy scope). */
const PI_AGENT_PACKAGE_NAMES = new Set(["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"]);
/** How far up from the host entry to look for its package.json. */
const MAX_HOST_ROOT_DEPTH = 16;

// tsc rewrites `await import(x)` in CommonJS output to require(x), which
// cannot load ESM on Node 20 and would defeat the explicit file resolution
// done here. Compile a native dynamic import the transpiler leaves untouched
// (same technique as ./execution/adapters/claude-cli).
const nativeDynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

export interface HostPeerLoadOptions {
  /**
   * Discovery of the running Pi entry file; each consumer passes its own
   * seam slot (undefined → `process.argv[1]`, the documented default).
   */
  entryProvider?: (() => string | undefined) | undefined;
  /**
   * When CJS resolution fails and the running host's own package.json names
   * the requested package, resolve the entry through that package.json's
   * `main` field (the agent package exposes import-only exports). Falls back
   * to "index.js" when `main` is absent.
   */
  packageMainFallback?: boolean;
}

/** The running Pi install: package root plus the resolved entry file. */
interface RunningPiRoot {
  /** Directory containing the host's own package.json. */
  root: string;
  /** Realpath of the process entry (the pi CLI script). */
  entry: string;
}

/**
 * Loads one host peer module. Never a hard dependency: any failure yields
 * undefined and the caller degrades.
 */
export async function loadHostPeerModule(
  name: string,
  options: HostPeerLoadOptions = {},
): Promise<Record<string, unknown> | undefined> {
  try {
    const mod = require(name) as unknown;
    if (isRecord(mod)) return mod;
  } catch {
    // MODULE_NOT_FOUND for compiled CJS entries under pi >= 0.86: the native
    // import bypasses the jiti aliases. Try host-relative resolution.
  }
  const piRoot = findRunningPiRoot(options.entryProvider);
  if (!piRoot) return undefined;
  const entry = resolvePeerEntry(piRoot, name, options.packageMainFallback === true);
  if (!entry) return undefined;
  return loadPeerFile(entry);
}

/**
 * Locates the running Pi install from the process entry. `process.argv[1]`
 * is the public, documented pointer to the launched script; a bin symlink
 * (npm global, nvm, homebrew) is resolved with realpath before walking up
 * for the nearest package.json, which must name the pi agent package.
 * Returns undefined when the process was not started from a Pi install
 * (unit tests, other hosts, SEA/binary entries without a discoverable root).
 */
function findRunningPiRoot(entryProvider: (() => string | undefined) | undefined): RunningPiRoot | undefined {
  const candidate = (entryProvider ?? defaultHostEntry)();
  if (!candidate) return undefined;
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    return undefined;
  }
  let dir = dirname(real);
  for (let depth = 0; depth < MAX_HOST_ROOT_DEPTH; depth += 1) {
    const pkg = readPackageJson(dir);
    if (pkg && typeof pkg.name === "string" && PI_AGENT_PACKAGE_NAMES.has(pkg.name)) {
      return { root: dir, entry: real };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function defaultHostEntry(): string | undefined {
  const candidate = process.argv[1];
  if (!candidate || typeof candidate !== "string") return undefined;
  return isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate);
}

/**
 * Resolves one peer package to a loadable file from the running host's tree
 * using Node's own resolution (createRequire rooted at the host entry).
 * With `mainFieldFallback`, a package that only exposes ESM "import" exports
 * is resolved through its own package.json main field when it is the running
 * host itself.
 */
function resolvePeerEntry(piRoot: RunningPiRoot, name: string, mainFieldFallback: boolean): string | undefined {
  try {
    return createRequire(piRoot.entry).resolve(name);
  } catch {
    // Not resolvable under CJS conditions; fall through to the main field.
  }
  if (!mainFieldFallback) return undefined;
  const pkg = readPackageJson(piRoot.root);
  if (!pkg || pkg.name !== name) return undefined;
  const main = typeof pkg.main === "string" && pkg.main.length > 0 ? pkg.main : "index.js";
  return resolve(piRoot.root, main);
}

/**
 * Loads a resolved peer file. `require()` covers CJS and, on Node >= 22.12,
 * ESM via require(esm); older Node throws ERR_REQUIRE_ESM, in which case a
 * native dynamic import loads the ESM module. Both hit Node's module cache,
 * so repeated loads share one instance inside the extension process.
 */
async function loadPeerFile(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const mod = require(filePath) as unknown;
    if (isRecord(mod)) return mod;
  } catch {
    // ERR_REQUIRE_ESM on Node < 22.12 (or any load failure): use import().
  }
  try {
    const mod = await nativeDynamicImport(pathToFileURL(filePath).href);
    return isRecord(mod) ? mod : undefined;
  } catch {
    return undefined;
  }
}

function readPackageJson(dir: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
