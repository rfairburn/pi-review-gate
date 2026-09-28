/**
 * Immediate interactive-startup peer prewarm (issue #213).
 *
 * The first /review-settings after a Pi startup used to pause for several
 * seconds: the retained menu and the native textbox editor load the running
 * Pi agent package on demand, and its cold evaluation blocks the main thread.
 * This module removes that user-visible pause by starting the same load
 * immediately when an interactive TUI session starts — no timer, no visible
 * UI, and never awaited from the hook (src/index.ts):
 *
 * - Import-first host-relative path: the peer is resolved from the running
 *   Pi install (process entry → nearest package.json named the agent
 *   package, import-only exports through its own main field — see
 *   {@link resolveHostPeerFile}) and loaded with a native dynamic import()
 *   of the resolved file. No bare-name require is tried first, so a bundled
 *   repo copy or any other resolvable duplicate can never be warmed instead
 *   of the host's own module; no installed path is hard-coded.
 * - One module identity: Node's ESM cache is keyed by file URL, and both
 *   consumers' later on-demand loads (require(esm) on Node >= 22.12 and
 *   native import() elsewhere — src/host-peer-loader.ts) resolve to that
 *   same record. An early open racing an in-flight prewarm hits
 *   ERR_REQUIRE_ESM_RACE_CONDITION in require() and falls back to the
 *   native import, which joins the in-flight evaluation: coalesced, never
 *   duplicated.
 * - Fail-closed and invisible: any resolution or load failure resolves to
 *   undefined with no notification and no state change; the existing
 *   on-demand loader retries its own full path when the menu or editor
 *   actually needs the module and degrades exactly as before. The prewarm
 *   is memoized per process (one attempt), so a failed or completed
 *   prewarm can never re-evaluate or race a second import.
 * - Non-TUI modes (RPC, print) never prewarm: the caller gates on the
 *   session's interactive TUI mode.
 */

import { pathToFileURL } from "node:url";
import { resolveHostPeerFile } from "./host-peer-loader";

/** The running host agent package (the same peer name both consumers load). */
const PI_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

// tsc rewrites `await import(x)` in CommonJS output to require(x), which
// would evaluate the ESM bundle synchronously on the main thread at hook
// time instead of as a native async load. Compile a native dynamic import
// the transpiler leaves untouched (same technique as ./host-peer-loader).
const nativeDynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

/** The one in-flight/completed prewarm per process; never rejects. */
let prewarmPromise: Promise<Record<string, unknown> | undefined> | undefined;
let hostEntryProvider: (() => string | undefined) | undefined;

/**
 * Test seam: replace (or clear) discovery of the running Pi entry file. The
 * replacement still goes through the same realpath/package.json validation.
 * Replacing the provider also clears any memoized prewarm so tests can point
 * it at a different fake install.
 */
export function setPeerPrewarmEntryProvider(provider: (() => string | undefined) | undefined): void {
  hostEntryProvider = provider;
  prewarmPromise = undefined;
}

/**
 * Starts (or joins) the immediate native import of the running Pi agent
 * peer. Fire-and-forget by contract: callers must not await this from an
 * event hook. The returned promise is memoized per process and never
 * rejects — a resolution or load failure resolves to undefined and leaves
 * the on-demand loader's behavior untouched.
 */
export function prewarmPiAgentPeer(): Promise<Record<string, unknown> | undefined> {
  prewarmPromise ??= runPrewarm();
  return prewarmPromise;
}

async function runPrewarm(): Promise<Record<string, unknown> | undefined> {
  try {
    const file = resolveHostPeerFile(PI_AGENT_PACKAGE_NAME, {
      entryProvider: hostEntryProvider,
      packageMainFallback: true,
    });
    if (!file) return undefined;
    const mod = await nativeDynamicImport(pathToFileURL(file).href);
    return isRecord(mod) ? mod : undefined;
  } catch {
    // Outside Pi, an unresolvable peer, or a load failure: nothing to warm.
    // The on-demand loader retries its own full path when the menu or editor
    // actually needs the module (fail-closed semantics unchanged).
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
