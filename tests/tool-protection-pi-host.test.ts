/**
 * Installed-host proof for the pre-execution auditor's in-process Pi route
 * (issue #536): the landed `runProtectionAuditor` must work with the live
 * `ctx.modelRegistry` an installed Pi extension actually receives, not only
 * with a structural mock.
 *
 * Isolation contract: the parent test process never imports or instantiates the
 * installed SDK. All installed-host execution happens in a child Node test run
 * whose environment is an explicit allowlist — no inherited `process.env`, no
 * `PATH`, and a fresh `HOME`/`USERPROFILE`/`XDG_*` tree created empty by the
 * parent before the SDK module graph is imported. Registering a provider makes
 * installed Pi refresh availability across its builtin providers, so ambient
 * auth resolution must see only sandbox roots and no credential variables; the
 * child also intercepts `node:fs` and `node:fs/promises` reads to prove that no
 * live credential path outside the sandbox is probed.
 *
 * What is proven in the isolated child, against the resolved installed
 * `@earendil-works/pi-coding-agent` 1.x SDK (optionally pinned by
 * `PI_REVIEW_GATE_INSTALLED_AGENT`, as in CI):
 *
 * 1. A real inline extension is loaded through the installed `DefaultResourceLoader`
 *    and `createAgentSession`; its `session_start` handler captures the installed
 *    extension context, whose `modelRegistry` is an instance of the installed
 *    `ModelRegistry` class.
 * 2. That live registry is accepted as the runner's
 *    `ProtectionAuditorPiModelRegistry` and the selected provider/model resolves
 *    through the real `find()`/`getAll()`; the unselected registered provider is
 *    never invoked.
 * 3. The host's own `ModelRegistry.streamSimple()` dispatch reaches the synthetic
 *    provider with exactly one runner-generated request: the route system
 *    instruction plus the generated decision prompt, zero tools
 *    (`getCurrentTools()` is empty), no session system prompt or transcript, and
 *    provider-neutral controls (`toolChoice: "none"`, `maxRetries: 0`, the
 *    selection's thinking level, the requested timeout, an unaborted signal) —
 *    one provider request per auditor invocation, no route fallback. The
 *    caller's fixed-instruction boundary splits that request into the unchanged
 *    code-owned instruction text in the system role and the exact variable
 *    suffix in one user message, with quoted governing instructions, evidence,
 *    and the proposed call never system-role. Every dispatch receives the same
 *    published SDK controls (`toolChoice: "none"`, `maxRetries: 0`,
 *    `transport: "sse"`, the selection's thinking level, the requested timeout,
 *    an unaborted signal), and a supplied auditor cache identity arrives as the
 *    SDK's provider-neutral `sessionId` option, never as model input. The request
 *    stays self-contained (#590).
 * 4. The scripted reason-bearing and reasonless decision payloads are returned
 *    verbatim by the runner and parse as the shared decision format; an
 *    already-aborted request launches no provider call.
 * 5. Optional auditor-session retention (#536) writes through the extension's own
 *    writer into the installed host's ordinary saved-session store (redirected
 *    into the sandbox), and the installed SDK's own listing, entry reader, and
 *    context builder read it back: one fresh session per invocation, the exact
 *    split request preserved (the unchanged fixed instruction text in the system
 *    entry, the variable suffix in the one user entry) together with the terminal
 *    message, host process I/O labelled as such
 *    with no invented provider data, no tools restored when viewed, and no
 *    credential or transport configuration stored. Those reads are proof-only;
 *    the product never opens, lists, or reuses an audit record.
 *
 * The synthetic provider is an inert scripted fixture: it makes no network
 * request, resolves a fixed inert key, and the auditor prompt is a sentinel
 * string, so no proposed dangerous call is ever executed. Runtime/model timing
 * and remote-provider behavior are NOT claimed.
 *
 * Prerequisites are optional: a missing or unsupported installed host skips with
 * its reason, and `PI_REVIEW_GATE_REQUIRE_PI_HOST=1` (the established required-host
 * gate) turns that same missing prerequisite into a hard failure — proven below
 * by running this file's own compiled host test in a subprocess with an
 * unavailable pinned agent, in both gate modes.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { DEFAULT_CONFIG } from "../src/config";
import { buildProtectionContext } from "../src/tool-protection/context";
import { parseProtectionDecision } from "../src/tool-protection/decision";
import {
  protectionAuditorCacheKey,
  runProtectionAuditor,
  type ProtectionAuditorPiModelRegistry,
  type ProtectionAuditorRequest,
} from "../src/tool-protection/runner";
import {
  openAuditorSessionRecord,
  TOOL_PROTECTION_EXTERNAL_CUSTOM_TYPE,
  TOOL_PROTECTION_RECORD_CUSTOM_TYPE,
  writeAuditorSessionRecord,
  type AuditorRecordIdentity,
} from "../src/tool-protection/session-record";
import { PROTECTION_AUDITOR_PROTOCOL } from "../src/tool-protection/runner";
import { skipOrFail } from "./bridge-fakes";
import { explicitInstalledAgentDir, findInstalledAgentDirs } from "./menu-tui-fakes";

/** Unique token for selecting only the parent host test in the gate subprocess. */
const HOST_TEST_TOKEN = "extension-context model registry";
/** The isolated child registers (and the parent selects) only this test name. */
const INNER_TEST_TOKEN = "isolated installed host executes the landed auditor";
/** The gate contract runs this file's compiled sibling. */
const COMPILED_HOST_TEST = "tool-protection-pi-host.test.js";
/** Set only for the isolated child run; never inherited from a parent process. */
const ISOLATED_HOST_MARKER = "PRG_TOOL_PROTECTION_HOST_CHILD";

const HOST_ENTRY_ENV = "PRG_TOOL_PROTECTION_HOST_ENTRY";
const AI_ENTRY_ENV = "PRG_TOOL_PROTECTION_AI_ENTRY";
const HOST_VERSION_ENV = "PRG_TOOL_PROTECTION_HOST_VERSION";
const SANDBOX_ENV = "PRG_TOOL_PROTECTION_HOST_SANDBOX";

const PROVIDER = "prg-synthetic-decision";
const OTHER_PROVIDER = "prg-synthetic-unselected";
const SELECTED_MODEL_ID = "decision-model";
const OTHER_MODEL_ID = "unselected-model";
const SYNTHETIC_API = "prg-synthetic-inert-api";
const INERT_API_KEY = "synthetic-inert-key";
const SESSION_SYSTEM_SENTINEL = "PRG-536-SESSION-ONLY-SYSTEM-SENTINEL";
const AUDITOR_PROMPT_SENTINEL =
  "PRG-536-GENERATED-AUDITOR-PROMPT-SENTINEL: decide this synthetic proposal; no tool is executed.";

/** Credential-bearing environment names that must never reach the isolated host. */
const CREDENTIAL_ENV_PATTERN =
  /(API_?KEY|ACCESS_?TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AWS_|AZURE_|GOOGLE_|GCLOUD|ANTHROPIC|OPENAI|GEMINI|COPILOT|HUGGING|HF_|NETRC)/i;

/** Live credential locations the isolated host must not probe outside its sandbox. */
const CREDENTIAL_PATH_PATTERN =
  /(?:^|[\\/])\.aws(?:[\\/]|$)|(?:^|[\\/])\.config[\\/]gcloud(?:[\\/]|$)|application_default_credentials|(?:^|[\\/])\.netrc$|(?:^|[\\/])\.ssh(?:[\\/]|$)|(?:^|[\\/])\.docker[\\/]config|(?:^|[\\/])auth\.json$|(?:^|[\\/])\.config[\\/]gh[\\/]hosts\.yml$/;

/** Ambient credential files that must be absent from every redirected root. */
const CREDENTIAL_FILE_PROBES = [
  join(".aws", "credentials"),
  join(".config", "gcloud", "application_default_credentials.json"),
  ".netrc",
  join(".ssh", "id_rsa"),
  join(".docker", "config.json"),
  join(".config", "gh", "hosts.yml"),
];

const ISOLATED_HOST_CHILD = process.env[ISOLATED_HOST_MARKER] === "1";

// ---------------------------------------------------------------------------
// Installed host discovery (parent: filesystem only, no SDK import)
// ---------------------------------------------------------------------------

interface InstalledHost {
  version: string;
  /** The installed SDK entry file (the package's own `main`). */
  entry: string;
  /** The installed `@earendil-works/pi-ai` entry file. */
  aiEntry: string;
}

interface InstalledSession {
  bindExtensions(bindings: Record<string, unknown>): Promise<void>;
  dispose(): void;
}

interface InstalledResourceLoader {
  reload(): Promise<void>;
  getExtensions(): { errors: Array<{ path: string; error: string }> };
}

interface InstalledExtensionContext {
  modelRegistry: unknown;
}

interface InstalledAgentModule {
  ModelRegistry: new (runtime: unknown) => unknown;
  ModelRuntime: { create(options: Record<string, unknown>): Promise<unknown> };
  DefaultResourceLoader: new (options: Record<string, unknown>) => InstalledResourceLoader;
  createAgentSession(options: Record<string, unknown>): Promise<{ session: InstalledSession }>;
  SettingsManager: { inMemory(settings?: Record<string, unknown>): unknown };
  SessionManager: { inMemory(): unknown };
}

/** The installed session instance surface the retention proof reads back. */
interface InstalledSessionInstance {
  getSessionFile(): string | undefined;
  getEntries(): Array<Record<string, unknown>>;
  buildSessionContext(): { messages: unknown[] };
}

/** The installed saved-session listing row. */
interface InstalledSessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
}

interface InstalledEventStream {
  push(event: unknown): void;
  end(result?: unknown): void;
}

interface InstalledAiModule {
  InMemoryCredentialStore: new () => unknown;
  createProvider(input: Record<string, unknown>): unknown;
  createAssistantMessageEventStream(): InstalledEventStream;
  getCurrentTools(messages: unknown): Array<{ name: string }>;
  getCurrentSystemPrompt(messages: unknown): string;
}

type InstalledHostLoad =
  | { ok: true; agent: InstalledAgentModule; ai: InstalledAiModule }
  | { ok: false; reason: string };

// tsc rewrites `await import(x)` in CommonJS output to require(x), which cannot
// load the installed package's ESM entry. Compile a native dynamic import the
// transpiler leaves untouched (the established technique in this repository).
const nativeDynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<Record<string, unknown>>;

function readPackageJson(dir: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve one peer package entry from the installed tree, covering both npm
 * layouts (hoisted next to the scoped agent package, or nested under it).
 */
function peerEntry(agentDir: string, packageName: string): string | undefined {
  const parts = packageName.split("/");
  const roots = [
    join(agentDir, "node_modules", ...parts),
    join(dirname(dirname(agentDir)), ...parts),
  ];
  for (const root of roots) {
    const pkg = readPackageJson(root);
    if (!pkg) continue;
    const main = typeof pkg.main === "string" && pkg.main.length > 0 ? pkg.main : "index.js";
    const entry = resolvePath(root, main);
    if (existsSync(entry)) return entry;
  }
  return undefined;
}

/** Resolve an installed Pi 1.x SDK with the peer package this test exercises. */
function resolveInstalledHost(): InstalledHost | undefined {
  const candidates = [
    explicitInstalledAgentDir(),
    ...findInstalledAgentDirs(),
  ].filter((dir): dir is string => dir !== undefined);
  for (const agentDir of [...new Set(candidates)]) {
    const pkg = readPackageJson(agentDir);
    if (!pkg) continue;
    const version = typeof pkg.version === "string" ? pkg.version : "";
    if (version.split(".")[0] !== "1") continue;
    const main = typeof pkg.main === "string" && pkg.main.length > 0 ? pkg.main : "dist/index.js";
    const entry = resolvePath(agentDir, main);
    if (!existsSync(entry)) continue;
    const aiEntry = peerEntry(agentDir, "@earendil-works/pi-ai");
    if (!aiEntry) continue;
    return { version, entry, aiEntry };
  }
  return undefined;
}

/** Import the installed SDK modules (isolated child only), or name the absent API. */
async function importInstalledHost(host: InstalledHost): Promise<InstalledHostLoad> {
  let agent: Record<string, unknown>;
  let ai: Record<string, unknown>;
  try {
    agent = await nativeDynamicImport(pathToFileURL(host.entry).href);
    ai = await nativeDynamicImport(pathToFileURL(host.aiEntry).href);
  } catch (error) {
    return { ok: false, reason: `installed Pi ${host.version} SDK entry could not be imported (${errorMessage(error)})` };
  }
  const requirements: Array<[boolean, string]> = [
    [typeof agent.ModelRegistry === "function", "ModelRegistry"],
    [typeof (agent.ModelRuntime as { create?: unknown } | undefined)?.create === "function", "ModelRuntime.create"],
    [typeof agent.createAgentSession === "function", "createAgentSession"],
    [typeof agent.DefaultResourceLoader === "function", "DefaultResourceLoader"],
    [typeof (agent.SettingsManager as { inMemory?: unknown } | undefined)?.inMemory === "function", "SettingsManager.inMemory"],
    [typeof (agent.SessionManager as { inMemory?: unknown } | undefined)?.inMemory === "function", "SessionManager.inMemory"],
    [typeof ai.InMemoryCredentialStore === "function", "@earendil-works/pi-ai InMemoryCredentialStore"],
    [typeof ai.createProvider === "function", "@earendil-works/pi-ai createProvider"],
    [typeof ai.createAssistantMessageEventStream === "function", "@earendil-works/pi-ai createAssistantMessageEventStream"],
    [typeof ai.getCurrentTools === "function", "@earendil-works/pi-ai getCurrentTools"],
    [typeof ai.getCurrentSystemPrompt === "function", "@earendil-works/pi-ai getCurrentSystemPrompt"],
  ];
  const absent = requirements.filter(([present]) => !present).map(([, name]) => name);
  if (absent.length > 0) {
    return { ok: false, reason: `installed Pi ${host.version} lacks the required SDK API: ${absent.join(", ")}` };
  }
  return {
    ok: true,
    agent: agent as unknown as InstalledAgentModule,
    ai: ai as unknown as InstalledAiModule,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Isolated environment and filesystem probe (child only)
// ---------------------------------------------------------------------------

interface FileSystemProbe {
  sandboxVariants: string[];
  /** Existence/stat/access probes (no file content is returned). */
  probes: string[];
  /** File content reads, the exposure that matters most. */
  reads: string[];
  selfTestPath: string;
}

let activeProbe: FileSystemProbe | undefined;

type RecordableFileSystem = {
  existsSync(path: string): boolean;
  readFileSync(path: string, options?: unknown): unknown;
  statSync(path: string): unknown;
};

type RecordableFileSystemPromises = {
  access(path: string, mode?: number): Promise<void>;
  readFile(path: string, options?: unknown): Promise<unknown>;
  stat(path: string): Promise<unknown>;
};

/** Record every filesystem path the installed SDK probes, without changing results. */
function installFileSystemProbe(sandboxRoot: string): FileSystemProbe {
  const nodeFs = require("node:fs") as unknown as RecordableFileSystem;
  const nodeFsPromises = require("node:fs/promises") as unknown as RecordableFileSystemPromises;
  const probes: string[] = [];
  const reads: string[] = [];
  const recordProbe = (path: unknown): void => {
    if (typeof path === "string") probes.push(path);
  };
  const recordRead = (path: unknown): void => {
    if (typeof path === "string") reads.push(path);
  };
  const originalExistsSync = nodeFs.existsSync;
  const originalReadFileSync = nodeFs.readFileSync;
  const originalStatSync = nodeFs.statSync;
  const originalAccess = nodeFsPromises.access;
  const originalReadFile = nodeFsPromises.readFile;
  const originalStat = nodeFsPromises.stat;
  nodeFs.existsSync = (path) => {
    recordProbe(path);
    return originalExistsSync(path);
  };
  nodeFs.readFileSync = (path, options) => {
    recordRead(path);
    return originalReadFileSync(path, options);
  };
  nodeFs.statSync = (path) => {
    recordProbe(path);
    return originalStatSync(path);
  };
  nodeFsPromises.access = async (path, mode) => {
    recordProbe(path);
    return originalAccess(path, mode);
  };
  nodeFsPromises.readFile = async (path, options) => {
    recordRead(path);
    return originalReadFile(path, options);
  };
  nodeFsPromises.stat = async (path) => {
    recordProbe(path);
    return originalStat(path);
  };
  // Updates ESM named-export bindings (the SDK imports `node:fs`/`node:fs/promises`
  // with static named imports) so the probe observes the real calls.
  (require("node:module") as { syncBuiltinESMExports(): void }).syncBuiltinESMExports();
  const resolved = resolvePath(sandboxRoot);
  return {
    sandboxVariants: [...new Set([resolved, realpathSync(resolved)])],
    probes,
    reads,
    selfTestPath: join(resolved, "fs-probe-self-test"),
  };
}

function isInsideSandbox(path: string, variants: readonly string[]): boolean {
  const resolved = resolvePath(path);
  return variants.some((variant) => resolved === variant || resolved.startsWith(variant + sep));
}

/**
 * Establish and prove the isolation contract before the installed SDK module
 * graph is imported: no inherited credential environment, no PATH, and all
 * ambient auth roots redirected to empty sandbox directories. Returns the
 * evidence line the parent asserts on.
 */
async function beginIsolatedHostProbe(sandboxRoot: string): Promise<string> {
  const sandbox = resolvePath(sandboxRoot);
  const sandboxReal = realpathSync(sandbox);
  const home = join(sandbox, "home");
  assert.equal(realpathSync(homedir()), realpathSync(home), "the installed SDK's home resolves inside the sandbox");
  const configRoots = ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"].map((name) => {
    const value = process.env[name];
    assert.ok(value, `${name} is redirected into the sandbox`);
    assert.ok(
      resolvePath(value) === sandbox || resolvePath(value).startsWith(sandbox + sep) ||
        realpathSync(value) === sandboxReal || realpathSync(value).startsWith(sandboxReal + sep),
      `${name} resolves inside the sandbox`,
    );
    return value;
  });
  assert.equal(process.env.PATH, undefined, "no PATH is inherited, so ambient credential commands cannot resolve");
  assert.equal(process.env.NODE_OPTIONS, undefined, "no NODE_OPTIONS preload is inherited");
  assert.deepEqual(
    Object.keys(process.env).filter((key) => CREDENTIAL_ENV_PATTERN.test(key)),
    [],
    "no credential-bearing environment variable reaches the isolated host",
  );
  // The redirected roots were created empty: the usual ambient credential files
  // cannot be read through them.
  for (const root of [home, ...configRoots]) {
    for (const probe of CREDENTIAL_FILE_PROBES) {
      assert.equal(existsSync(join(root, probe)), false, `live credential file ${probe} is absent under the sandbox root`);
    }
  }

  const probe = installFileSystemProbe(sandbox);
  activeProbe = probe;
  const probeSource = [
    'import { existsSync } from "node:fs";',
    'import { access, readFile } from "node:fs/promises";',
    "const state = { exists: existsSync(" + JSON.stringify(probe.selfTestPath) + ") };",
    "try { await access(" + JSON.stringify(probe.selfTestPath) + "); state.access = \"present\"; } catch { state.access = \"absent\"; }",
    "try { await readFile(" + JSON.stringify(probe.selfTestPath) + ", \"utf8\"); state.read = \"present\"; } catch { state.read = \"absent\"; }",
    "export { state };",
  ].join("\n");
  const selfTest = await nativeDynamicImport(`data:text/javascript,${encodeURIComponent(probeSource)}`);
  const state = selfTest.state as { exists?: unknown; access?: unknown; read?: unknown } | undefined;
  assert.equal(state?.exists, false);
  assert.equal(state?.access, "absent");
  assert.equal(state?.read, "absent");
  assert.ok(
    probe.probes.includes(probe.selfTestPath) && probe.reads.includes(probe.selfTestPath),
    "the fs probe observes ESM named imports of node:fs and node:fs/promises",
  );
  return `isolated-env credential-env-vars=0 sandbox-home=true redirected-roots=${configRoots.length} path-absent=true fs-probe-self-test=ok`;
}

/** The npm tree an installed entry belongs to (paths up to and including `node_modules`). */
function installedRuntimeRoot(entry: string): string {
  const marker = `${sep}node_modules${sep}`;
  const index = entry.lastIndexOf(marker);
  return index >= 0 ? entry.slice(0, index + `${sep}node_modules`.length) : dirname(entry);
}

/**
 * Assert the isolation contract held for the whole run: no live credential path
 * was probed, and the only filesystem reads outside the sandbox are the
 * installed SDK's own runtime tree or virtual `/proc`/`/dev` probes. Reports the
 * evidence line the parent asserts on.
 */
function finishIsolatedHostProbe(host: { entry: string; aiEntry: string }): string {
  const probe = activeProbe;
  assert.ok(probe, "the isolated fs probe was installed before the installed SDK was imported");
  const outsideOf = (paths: readonly string[]): string[] => paths.filter((path) => {
    const expanded = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
    return !isInsideSandbox(expanded, probe.sandboxVariants);
  });
  const outsideProbes = outsideOf(probe.probes);
  const outsideReads = outsideOf(probe.reads);
  const credentialProbes = [...new Set([...outsideProbes, ...outsideReads])].filter((path) => CREDENTIAL_PATH_PATTERN.test(path));
  assert.deepEqual(
    credentialProbes,
    [],
    `the installed host probed no live credential path outside the sandbox (observed: ${credentialProbes.join(", ")})`,
  );
  const runtimeRoots = [...new Set([installedRuntimeRoot(host.entry), installedRuntimeRoot(host.aiEntry)])];
  const unaccountedReads = outsideReads.filter((path) => {
    const resolved = resolvePath(path);
    if (/^(?:\/proc|\/dev)\//.test(resolved)) return false;
    return !runtimeRoots.some((root) => resolved === root || resolved.startsWith(root + sep));
  });
  assert.deepEqual(
    unaccountedReads,
    [],
    `outside-sandbox reads are limited to the installed runtime tree or virtual probes (unaccounted: ${unaccountedReads.slice(0, 10).join(", ")})`,
  );
  return `isolated-fs-probe outside-sandbox-reads=${outsideReads.length} outside-sandbox-probes=${outsideProbes.length} credential-path-probes=0 runtime-reads-only=true self-test=ok`;
}

// ---------------------------------------------------------------------------
// Synthetic no-network provider fixture (child only)
// ---------------------------------------------------------------------------

interface ScriptedProviderCall {
  model: { id: string; provider: string; api: string };
  context: { messages: Array<Record<string, unknown>> };
  options: Record<string, unknown> & { signal?: AbortSignal };
}

interface ScriptedProvider {
  provider: unknown;
  /** Exact model descriptor registered by the inline extension. */
  model: Record<string, unknown>;
  calls: ScriptedProviderCall[];
  enqueueDecision(payload: string): void;
}

function syntheticModel(provider: string, id: string): Record<string, unknown> {
  return {
    id,
    name: id,
    api: SYNTHETIC_API,
    provider,
    baseUrl: "http://127.0.0.1:9/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: true,
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

/**
 * Register an inert provider whose `streamSimple` records the exact request and
 * emits one genuine assistant event stream carrying the next scripted decision.
 * It never touches the network or stored credentials; its auth resolves a fixed
 * inert key. An unscripted extra request becomes an explicit error event so a
 * stray retry or fallback fails the audit instead of hanging.
 */
function scriptedProvider(ai: InstalledAiModule, providerId: string, modelId: string): ScriptedProvider {
  const model = syntheticModel(providerId, modelId);
  const calls: ScriptedProviderCall[] = [];
  const decisions: string[] = [];
  const respond = (
    requestModel: ScriptedProviderCall["model"],
    context: ScriptedProviderCall["context"],
    options: ScriptedProviderCall["options"],
  ): InstalledEventStream => {
    calls.push({ model: requestModel, context, options });
    const decision = decisions.shift();
    const message = {
      role: "assistant",
      content: [{ type: "text", text: decision ?? "" }],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: decision === undefined ? "error" : "stop",
      ...(decision === undefined
        ? { errorMessage: "unexpected extra auditor provider request: the fixture has no scripted decision" }
        : {}),
      timestamp: Date.now(),
    };
    const stream = ai.createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (decision === undefined) stream.push({ type: "error", reason: "error", error: message });
      else stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
  const provider = ai.createProvider({
    id: providerId,
    name: providerId,
    auth: {
      apiKey: {
        name: providerId,
        resolve: async () => ({ auth: { apiKey: INERT_API_KEY }, source: "synthetic test fixture" }),
      },
    },
    models: [model],
    // Both entry points share the fixture so either dispatch shape records one call.
    api: { stream: respond, streamSimple: respond },
  });
  return {
    provider,
    model,
    calls,
    enqueueDecision(payload: string): void {
      decisions.push(payload);
    },
  };
}

// ---------------------------------------------------------------------------
// Installed extension host: real loader, session, and extension context
// ---------------------------------------------------------------------------

interface InstalledExtensionHost {
  context: InstalledExtensionContext;
  session: InstalledSession;
  registry: ProtectionAuditorPiModelRegistry;
  selected: ScriptedProvider;
  unselected: ScriptedProvider;
}

/** Accept only the live installed registry shape the runner declares. */
function asAuditorRegistry(
  registry: unknown,
  registryClass: new (runtime: unknown) => unknown,
): ProtectionAuditorPiModelRegistry {
  assert.ok(registry instanceof registryClass, "the extension context exposes an instance of the installed ModelRegistry class");
  const candidate = registry as Partial<ProtectionAuditorPiModelRegistry>;
  assert.equal(typeof candidate.find, "function", "installed registry exposes find(provider, modelId)");
  assert.equal(typeof candidate.getAll, "function", "installed registry exposes getAll()");
  assert.equal(typeof candidate.streamSimple, "function", "installed registry exposes streamSimple(model, context, options)");
  return registry as ProtectionAuditorPiModelRegistry;
}

async function createInstalledExtensionHost(
  agent: InstalledAgentModule,
  ai: InstalledAiModule,
  workspace: string,
  agentDir: string,
): Promise<InstalledExtensionHost> {
  const settingsManager = agent.SettingsManager.inMemory();
  // The child already runs with in-memory credentials, a null model catalog, and
  // sandbox auth roots; no network model refresh is enabled here either.
  const runtime = await agent.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const selected = scriptedProvider(ai, PROVIDER, SELECTED_MODEL_ID);
  const unselected = scriptedProvider(ai, OTHER_PROVIDER, OTHER_MODEL_ID);
  let context: InstalledExtensionContext | undefined;
  const inlineExtension = (pi: Record<string, any>): void => {
    pi.registerProvider(selected.provider);
    pi.registerProvider(unselected.provider);
    pi.on("session_start", (_event: unknown, ctx: InstalledExtensionContext) => {
      context = ctx;
    });
  };
  const loader = new agent.DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    extensionFactories: [inlineExtension],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // A distinctive live session prompt: the auditor request must not include it.
    systemPrompt: SESSION_SYSTEM_SENTINEL,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "the inline synthetic-provider extension loads without diagnostics");
  const { session } = await agent.createAgentSession({
    cwd: workspace,
    agentDir,
    modelRuntime: runtime,
    model: selected.model,
    thinkingLevel: "high",
    noTools: "all",
    resourceLoader: loader,
    sessionManager: agent.SessionManager.inMemory(),
    settingsManager,
  });
  await session.bindExtensions({ mode: "print" });
  if (!context) throw new Error("the inline extension did not receive the installed session_start extension context");
  return {
    context,
    session,
    registry: asAuditorRegistry(context.modelRegistry, agent.ModelRegistry),
    selected,
    unselected,
  };
}

function auditorRequest(registry: ProtectionAuditorPiModelRegistry, cwd: string): ProtectionAuditorRequest {
  return {
    selection: { source: "pi", model: `${PROVIDER}/${SELECTED_MODEL_ID}`, thinkingLevel: "high" },
    config: DEFAULT_CONFIG,
    prompt: AUDITOR_PROMPT_SENTINEL,
    input: { proposal: { tool: "synthetic-inert-tool", args: { inert: true } } },
    cwd,
    timeoutMs: 10_000,
    modelRegistry: registry,
  };
}

// ---------------------------------------------------------------------------
// Parent: isolated installed-host subprocess
// ---------------------------------------------------------------------------

function compiledHostTestFile(): string | undefined {
  const sibling = join(__dirname, COMPILED_HOST_TEST);
  return existsSync(sibling) ? sibling : undefined;
}

/**
 * Explicit child environment: no inherited process.env, no PATH, and every
 * ambient auth home/config root pointing at a fresh sandbox directory. Only the
 * entries the child needs and the platform variables Node itself requires are set.
 */
function isolatedHostEnvironment(root: string, host: InstalledHost): NodeJS.ProcessEnv {
  const home = join(root, "home");
  const sandbox = join(root, "tmp");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    TMPDIR: sandbox,
    TMP: sandbox,
    TEMP: sandbox,
    LANG: "C",
    LC_ALL: "C",
    [ISOLATED_HOST_MARKER]: "1",
    [HOST_ENTRY_ENV]: host.entry,
    [AI_ENTRY_ENV]: host.aiEntry,
    [HOST_VERSION_ENV]: host.version,
    [SANDBOX_ENV]: root,
  };
  if (process.platform === "win32") {
    for (const name of ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
  }
  return env;
}

const HOST_TEST_NAME = `${HOST_TEST_TOKEN} runs the landed auditor against an isolated installed host`;

async function runInstalledHostSubprocess(t: TestContext): Promise<void> {
  const host = resolveInstalledHost();
  if (!host) {
    skipOrFail(
      t,
      "no installed Pi 1.x SDK with a resolvable @earendil-works/pi-ai peer (PI_REVIEW_GATE_INSTALLED_AGENT or ambient install)",
    );
    return;
  }
  const compiled = compiledHostTestFile();
  if (!compiled) {
    skipOrFail(t, "compiled installed-host test file is unavailable for the isolated-host subprocess");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "prg-tool-protection-pi-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Fresh, empty ambient auth roots, created before the child imports the SDK.
  for (const dir of ["home", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "tmp", "workspace", "agent"]) {
    await mkdir(join(root, dir), { recursive: true });
  }

  const child = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", "--test-name-pattern", INNER_TEST_TOKEN, compiled],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 180_000,
      env: isolatedHostEnvironment(root, host),
    },
  );
  const output = `${child.stdout}\n${child.stderr}`;
  assert.equal(child.error, undefined, `the isolated installed-host subprocess failed to start: ${String(child.error)}`);
  // Match a concrete TAP skip line, not the `# skipped N` summary line.
  const skipLine = /^ok \d+ - .*?# SKIP\s*(.*)$/m.exec(child.stdout);
  if (child.status === 0 && skipLine) {
    // The host exists on disk but lacks the required SDK API: keep the honest
    // skip (or the required-host failure) in the parent's own gate mode.
    const reason = skipLine[1]?.trim();
    skipOrFail(t, reason && reason.length > 0 ? reason : "the isolated installed host lacks the required SDK API");
    return;
  }
  assert.equal(child.status, 0, `the isolated installed-host run failed:\n${output}`);
  assert.match(child.stdout, /ok \d+ - isolated installed host executes the landed auditor/);
  assert.match(child.stdout, /# fail 0/);
  // Targeted isolation evidence emitted by the child before/after the SDK run.
  assert.match(child.stdout, /isolated-env credential-env-vars=0 sandbox-home=true redirected-roots=4 path-absent=true fs-probe-self-test=ok/);
  assert.match(child.stdout, /isolated-fs-probe outside-sandbox-reads=\d+ outside-sandbox-probes=\d+ credential-path-probes=0 runtime-reads-only=true self-test=ok/);
}

// ---------------------------------------------------------------------------
// Child: the only process that imports and executes the installed SDK
// ---------------------------------------------------------------------------

async function runIsolatedInstalledHost(t: TestContext): Promise<void> {
  const entry = process.env[HOST_ENTRY_ENV];
  const aiEntry = process.env[AI_ENTRY_ENV];
  const version = process.env[HOST_VERSION_ENV];
  const sandboxRoot = process.env[SANDBOX_ENV];
  if (!entry || !aiEntry || !version || !sandboxRoot) {
    throw new Error("the isolated installed-host test requires its parent-provided SDK entries and sandbox root");
  }

  // Isolation is established and proven before the installed SDK is imported.
  const environmentEvidence = await beginIsolatedHostProbe(sandboxRoot);
  const loaded = await importInstalledHost({ version, entry, aiEntry });
  if (!loaded.ok) {
    skipOrFail(t, loaded.reason);
    return;
  }

  const workspace = join(sandboxRoot, "workspace");
  const agentDir = join(sandboxRoot, "agent");
  await mkdir(workspace, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  let session: InstalledSession | undefined;
  t.after(() => {
    try {
      session?.dispose();
    } catch {
      // Cleanup must not mask an assertion failure.
    }
  });

  const harness = await createInstalledExtensionHost(loaded.agent, loaded.ai, workspace, agentDir);
  session = harness.session;

  // The live installed registry resolves the explicit provider/model selection
  // and also holds the unselected provider's model.
  assert.equal(harness.registry.find(PROVIDER, SELECTED_MODEL_ID)?.id, SELECTED_MODEL_ID);
  assert.ok(
    harness.registry.getAll().some((model) => model.provider === OTHER_PROVIDER && model.id === OTHER_MODEL_ID),
    "the unselected provider/model is registered in the same live registry",
  );

  // One reason-bearing decision: exactly one provider request, no route fallback.
  harness.selected.enqueueDecision('{"decision":"FAIL","reason":"synthetic reason"}');
  const decided = await runProtectionAuditor(auditorRequest(harness.registry, workspace));
  assert.equal(decided.error, undefined, "the installed in-process route returns no transport error");
  assert.equal(decided.output, '{"decision":"FAIL","reason":"synthetic reason"}', "the raw decision text is returned verbatim");
  assert.equal(decided.settlement, undefined, "an in-process call owns no child process, so no settlement is claimed");
  assert.deepEqual(parseProtectionDecision(decided.output ?? ""), { decision: "FAIL", reason: "synthetic reason" });

  assert.equal(harness.selected.calls.length, 1, "one auditor invocation issues exactly one provider request");
  assert.equal(harness.unselected.calls.length, 0, "the unselected provider is never invoked");
  const call = harness.selected.calls[0]!;
  assert.equal(call.model.provider, PROVIDER, "the selected provider is honored");
  assert.equal(call.model.id, SELECTED_MODEL_ID, "the selected model is honored");

  // Only the runner-generated context reaches the provider: one route system
  // instruction and the generated prompt, with no tools or session material.
  const messages = call.context.messages;
  assert.equal(messages.length, 2, "the request context is exactly one system message plus one user message");
  assert.equal(messages[0]!.role, "system");
  assert.match(loaded.ai.getCurrentSystemPrompt(messages), /isolated decision-only tool-protection auditor/);
  assert.deepEqual(loaded.ai.getCurrentTools(messages), [], "the provider observes zero tools");
  assert.ok(!messages.some((message) => message.role === "toolResult" || message.role === "assistant"),
    "no session transcript or tool result is included");
  assert.deepEqual(
    messages.filter((message) => message.role === "user").map((message) => message.content),
    [AUDITOR_PROMPT_SENTINEL],
    "the user message is exactly the generated decision prompt",
  );
  assert.ok(!JSON.stringify(messages).includes(SESSION_SYSTEM_SENTINEL),
    "the live session system prompt is not part of the auditor request");

  // Provider-neutral controls requested by the runner reach the live dispatch.
  assert.equal(call.options.toolChoice, "none", "the auditor request declares no tool choice");
  assert.equal(call.options.maxRetries, 0, "no provider-SDK client retries are requested");
  assert.equal(call.options.reasoning, "high", "the selection's thinking level is forwarded");
  assert.equal(call.options.timeoutMs, 10_000, "the auditor deadline is forwarded");
  assert.ok(call.options.signal instanceof AbortSignal, "a live abort signal is supplied");
  assert.equal(call.options.signal.aborted, false, "the signal is not aborted for a running decision");
  assert.equal(call.options.apiKey, INERT_API_KEY, "the host resolved only the synthetic provider's inert key");

  // A reasonless decision is accepted verbatim, still one request per audit.
  harness.selected.enqueueDecision('{"decision":"PASS"}');
  const reasonless = await runProtectionAuditor(auditorRequest(harness.registry, workspace));
  assert.equal(reasonless.error, undefined);
  assert.equal(reasonless.output, '{"decision":"PASS"}');
  assert.deepEqual(parseProtectionDecision(reasonless.output ?? ""), { decision: "PASS" });
  assert.equal(harness.selected.calls.length, 2, "the second auditor invocation issues exactly one additional request");
  assert.equal(harness.unselected.calls.length, 0);

  // A stable auditor cache identity (#590) reaches the live dispatch as the
  // SDK's provider-neutral session option, beside the same published controls
  // every other audit receives, and the audit still carries its own
  // self-contained context.
  harness.selected.enqueueDecision('{"decision":"PASS"}');
  const cacheKey = protectionAuditorCacheKey(
    "pi-tool-protection:acting-session:synthetic-acting-session",
    `${PROVIDER}/${SELECTED_MODEL_ID}`,
    "dangerous",
  );
  const cached = await runProtectionAuditor({
    ...auditorRequest(harness.registry, workspace),
    cacheKey,
  });
  assert.equal(cached.error, undefined, "a cache identity never changes the audit outcome");
  assert.equal(cached.output, '{"decision":"PASS"}');
  assert.equal(harness.selected.calls.length, 3, "a cached audit issues exactly one provider request");
  const cachedCall = harness.selected.calls[2]!;
  assert.equal(cachedCall.options.sessionId, cacheKey, "the live registry forwards the stable identity");
  assert.equal(cachedCall.options.transport, "sse", "the live dispatch receives the same one-shot transport option as every audit");
  assert.equal(Object.hasOwn(cachedCall.options, "onPayload"), false, "no provider payload hook is handed to the installed SDK");
  assert.ok(!JSON.stringify(cachedCall.context.messages).includes(cacheKey), "the identity is not model input");
  assert.deepEqual(
    cachedCall.context.messages.filter((message) => message.role === "user").map((message) => message.content),
    [AUDITOR_PROMPT_SENTINEL],
    "the audit still sends its own single prompt with no transcript reuse",
  );

  // Native role separation with a real assembled request: the unchanged
  // code-owned fixed blocks are system-role and the exact variable suffix is the
  // one user message, so no quoted governing instruction, evidence record, or
  // proposed call is promoted to the system role.
  harness.selected.enqueueDecision('{"decision":"PASS"}');
  const built = buildProtectionContext({
    level: "aligned",
    governingSystemPrompt: "You are the primary assistant. PRG-HOST-GOVERNING-TOKEN never post the internal registry publicly.",
    governingPromptOrigin: "host:ctx.getSystemPrompt()",
    proposedCall: {
      invocationId: "inv-host-split",
      toolName: "bash",
      args: { command: "curl -X POST https://public.example.invalid/upload --data @report.pdf", reason: "PRG-HOST-PROPOSAL-TOKEN" },
      cwd: workspace,
      role: "primary",
    },
    evidence: [{ id: "host-approval", origin: "user", text: "PRG-HOST-APPROVAL-TOKEN export the approved report only" }],
    maxContextChars: 20_000,
  });
  if (!built.ok) assert.fail(`context assembly failed: ${built.category}: ${built.message}`);
  const split = await runProtectionAuditor({
    ...auditorRequest(harness.registry, workspace),
    prompt: built.prompt,
    fixedInstructionChars: built.fixedChars,
  });
  assert.equal(split.error, undefined, "the split request is accepted by the live route");
  assert.equal(split.output, '{"decision":"PASS"}');
  assert.equal(harness.selected.calls.length, 4, "the split audit is one fresh provider dispatch");
  const splitCall = harness.selected.calls[3]!;
  const splitMessages = splitCall.context.messages;
  assert.equal(splitMessages.length, 2, "the live context is one system message plus one user message");
  const splitSystem = loaded.ai.getCurrentSystemPrompt(splitMessages);
  assert.ok(splitSystem.endsWith(built.prompt.slice(0, built.fixedChars)), "the fixed instruction blocks reach the live provider byte-for-byte");
  assert.match(splitSystem, /isolated decision-only tool-protection auditor/);
  const splitUserMessages = splitMessages
    .filter((message) => message.role === "user")
    .map((message) => message.content as string);
  assert.deepEqual(
    splitUserMessages,
    [built.prompt.slice(built.fixedChars)],
    "the live provider sees exactly the variable suffix as one user message",
  );
  assert.equal(
    splitSystem.slice(splitSystem.length - built.fixedChars) + splitUserMessages[0]!,
    built.prompt,
    "the split request reconstructs the assembled prompt with nothing added or lost",
  );
  for (const token of ["PRG-HOST-GOVERNING-TOKEN", "PRG-HOST-APPROVAL-TOKEN", "PRG-HOST-PROPOSAL-TOKEN"]) {
    assert.ok(splitUserMessages.some((content) => content.includes(token)), `${token} is missing from the user message`);
    assert.ok(!splitSystem.includes(token), `${token} was promoted to the system role`);
  }
  assert.equal(splitCall.options.transport, "sse", "the split audit receives the same published controls");
  assert.equal(splitCall.options.toolChoice, "none");
  assert.equal(splitCall.options.maxRetries, 0);

  // Cancellation before launch: no provider request is made.
  const controller = new AbortController();
  controller.abort();
  const aborted = await runProtectionAuditor({
    ...auditorRequest(harness.registry, workspace),
    signal: controller.signal,
  });
  assert.match(aborted.error ?? "", /aborted before launch/i);
  assert.equal(aborted.output, undefined);
  assert.equal(harness.selected.calls.length, 4, "an already-aborted audit launches no provider request");

  // Optional auditor-session retention (#536): the real installed session store.
  await assertInstalledAuditorSessionRetention(loaded.agent, loaded.ai, entry, workspace, agentDir);

  // Evidence for the parent: the isolation contract held for the whole run.
  console.log(environmentEvidence);
  console.log(finishIsolatedHostProbe({ entry, aiEntry }));
}

/**
 * Installed-host proof for optional auditor-session retention (issue #536).
 *
 * The record is written by the extension's own writer through the production
 * host-peer loader — only the Pi entry pointer is supplied, exactly as a live
 * extension supplies it — so the installed `SessionManager` really creates the
 * file. Afterwards the installed SDK's own saved-session listing, entry reader
 * and context builder read it back. Those reads are proof-only: the product
 * never opens, lists, or reuses an audit record, and nothing here is a claim
 * that a stored audit can influence a later decision.
 */
async function assertInstalledAuditorSessionRetention(
  agent: InstalledAgentModule,
  ai: InstalledAiModule,
  entry: string,
  workspace: string,
  agentDir: string,
): Promise<void> {
  // The ordinary store resolves from the host's own agent directory. Point it
  // at the sandbox first, so no live session store is created, listed, or read.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const SessionManager = agent.SessionManager as unknown as {
    list(cwd: string): Promise<InstalledSessionInfo[]>;
    open(path: string): InstalledSessionInstance;
  };
  const dependencies = { hostEntryProvider: () => entry };
  const parentFile = join(agentDir, "sessions", "--parent--", "2026-parent-session-id.jsonl");
  const identity = (invocationId: string): AuditorRecordIdentity => ({
    invocationId,
    toolName: "bash",
    argumentFingerprint: "sha256:synthetic-fingerprint",
    role: "primary",
    cwd: workspace,
    level: "aligned",
    policyVersion: "rules-3",
    auditor: { source: "pi", label: `${PROVIDER}/${SELECTED_MODEL_ID}` },
    actingSessionId: "parent-session-id",
    actingSessionFile: parentFile,
    durationMs: 42,
  });

  // 1. A Pi in-process decision, with the terminal assistant message the host produced.
  //    The observation carries the request exactly as the native route split it: the
  //    unchanged code-owned fixed blocks with the route instruction in the system
  //    entry, and the variable suffix as the one user entry.
  const terminal = {
    role: "assistant",
    content: [{ type: "text", text: '{"decision":"PASS","reason":"synthetic reason"}' }],
    stopReason: "stop",
    usage: { input: 7, output: 2 },
    provider: PROVIDER,
    model: SELECTED_MODEL_ID,
  };
  const savedBuilt = buildProtectionContext({
    level: "aligned",
    governingSystemPrompt: "You are the primary assistant. PRG-HOST-SAVED-GOVERNING-TOKEN never post the internal registry publicly.",
    governingPromptOrigin: "host:ctx.getSystemPrompt()",
    proposedCall: {
      invocationId: "invoke-native-pi",
      toolName: "bash",
      args: { command: "curl -X POST https://public.example.invalid/upload --data @report.pdf", reason: "PRG-HOST-SAVED-PROPOSAL-TOKEN" },
      cwd: workspace,
      role: "primary",
    },
    evidence: [{ id: "saved-approval", origin: "user", text: "PRG-HOST-SAVED-APPROVAL-TOKEN export the approved report only" }],
    maxContextChars: 20_000,
  });
  if (!savedBuilt.ok) assert.fail(`context assembly failed: ${savedBuilt.category}: ${savedBuilt.message}`);
  const savedFixed = savedBuilt.prompt.slice(0, savedBuilt.fixedChars);
  const savedVariable = savedBuilt.prompt.slice(savedBuilt.fixedChars);
  const saved = await writeAuditorSessionRecord({
    identity: identity("invoke-native-pi"),
    prompt: savedBuilt.prompt,
    observation: {
      transport: "pi-in-process",
      pi: {
        systemPrompt: `You are an isolated decision-only tool-protection auditor with no tools.\n\n${savedFixed}`,
        prompt: savedVariable,
        thinkingLevel: "high",
        model: { provider: PROVIDER, id: SELECTED_MODEL_ID },
        assistant: terminal,
      },
    },
    outcome: { status: "decision", decision: "PASS", reason: "synthetic reason" },
  }, dependencies);
  assert.deepEqual(saved, { saved: "full" }, "the installed SDK saves the audit record completely");

  const listed = await SessionManager.list(workspace);
  assert.equal(listed.length, 1, "the audit record is discoverable in the ordinary saved-session listing");
  const info = listed[0]!;
  assert.match(info.name ?? "", /Tool protection audit/, "the picker caption identifies an audit record");
  assert.match(info.name ?? "", /bash/);
  assert.equal(info.parentSessionPath, parentFile, "the header carries the acting session lineage");
  assert.equal(existsSync(parentFile), false, "recording never creates or reopens the acting session itself");

  const raw = readFileSync(info.path, "utf8");
  assert.ok(raw.includes("TOOL PROTECTION - PRE-EXECUTION AUDIT REQUEST"), "the unchanged fixed instruction blocks are preserved");
  assert.ok(raw.includes("PRG-HOST-SAVED-APPROVAL-TOKEN"), "the exact quoted variable context is preserved");
  assert.ok(!raw.includes(INERT_API_KEY), "no credential or transport bootstrap material is recorded");
  assert.ok(!raw.includes("\"apiKey\""), "no transport configuration is recorded");

  const opened = SessionManager.open(info.path);
  const entries = opened.getEntries();
  const messages = entries
    .filter((row) => row.type === "message")
    .map((row) => row.message as Record<string, unknown>);
  assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant"],
    "the record shows the system text actually sent, the one user message actually sent, and the reply");
  assert.equal((messages[0]!.content as string).endsWith(savedFixed), true,
    "the system entry is the route instruction followed by the unchanged fixed blocks");
  assert.equal(messages[1]!.content, savedVariable,
    "the user entry is byte-identical to the single user message that was sent");
  for (const token of ["PRG-HOST-SAVED-GOVERNING-TOKEN", "PRG-HOST-SAVED-APPROVAL-TOKEN", "PRG-HOST-SAVED-PROPOSAL-TOKEN"]) {
    assert.ok((messages[1]!.content as string).includes(token), `${token} is missing from the saved user entry`);
    assert.ok(!((messages[0]!.content as string).includes(token)), `${token} was promoted to a system entry`);
  }
  assert.deepEqual(messages[2], terminal, "the terminal assistant message is stored as the host produced it");
  assert.equal(entries.find((row) => row.type === "thinking_level_change")?.thinkingLevel, "high",
    "the effective reasoning request is recorded, because the assistant message does not carry it");
  const custom = entries.filter((row) => row.type === "custom");
  assert.equal(custom.length, 1, "exactly one outcome entry per audit record");
  assert.equal(custom[0]!.customType, TOOL_PROTECTION_RECORD_CUSTOM_TYPE);
  const data = custom[0]!.data as Record<string, unknown>;
  assert.equal(data.transport, "pi-in-process");
  assert.equal(data.status, "decision");
  assert.equal(data.decision, "PASS");
  assert.equal(data.suppliedReason, "synthetic reason");
  assert.equal(data.invocationId, "invoke-native-pi");
  assert.equal(data.actingSessionId, "parent-session-id");
  assert.equal(typeof data.decisionMeaning, "string", "the record states PASS is not a claim that the tool ran");

  // Viewing a record is inert: no tools, no model context from the outcome entry.
  const context = opened.buildSessionContext();
  assert.deepEqual(ai.getCurrentTools(context.messages), [], "viewing an audit record restores no tools");
  assert.ok(!JSON.stringify(context.messages).includes("input_schema"), "no tool definitions are recoverable");
  assert.ok(!JSON.stringify(context.messages).includes(TOOL_PROTECTION_RECORD_CUSTOM_TYPE),
    "an audit outcome entry never becomes model context");

  // 2. An external binary: host process I/O, labelled as such, with no invented provider data.
  const envelope = JSON.stringify({
    version: PROTECTION_AUDITOR_PROTOCOL,
    prompt: AUDITOR_PROMPT_SENTINEL,
    input: null,
    cwd: workspace,
  });
  const externalSaved = await writeAuditorSessionRecord({
    identity: identity("invoke-native-binary"),
    prompt: envelope,
    observation: {
      transport: "external-binary",
      external: {
        requestText: envelope,
        outputText: '{"decision":"FAIL","reason":"synthetic refusal"}',
        truncated: false,
        exitCode: 0,
        timedOut: false,
        aborted: false,
        deliveredToStdin: true,
        settlement: "confirmed",
      },
    },
    outcome: { status: "decision", decision: "FAIL", reason: "synthetic refusal" },
  }, dependencies);
  assert.deepEqual(externalSaved, { saved: "full" });

  const afterExternal = await SessionManager.list(workspace);
  assert.equal(afterExternal.length, 2, "each actual invocation is its own fresh saved session");
  const externalRecord = afterExternal.find((row) => row.id !== info.id)!;
  assert.notEqual(externalRecord.id, info.id, "the second audit never appends to the first record");
  const externalEntries = SessionManager.open(externalRecord.path).getEntries();
  const externalRaw = readFileSync(externalRecord.path, "utf8");
  assert.ok(externalRaw.includes("External auditor binary output"), "the captured stdout is labelled as program output");
  assert.ok(externalRaw.includes("host reported that this write flushed to the program's stdin pipe"),
    "confirmed delivery is stated as confirmed");
  assert.ok(externalRaw.includes("not an assistant message from a Pi provider"), "the record denies any invented provider role");
  assert.ok(!externalRaw.includes("\"provider\":"), "no provider is reported for an external binary");
  assert.ok(!externalRaw.includes("\"usage\":"), "no usage is reported for an external binary");
  assert.ok(!externalRaw.includes("\"stopReason\":"), "no stop reason is reported for an external binary");
  assert.equal(externalEntries.filter((row) => row.type === "custom_message").map((row) => row.customType)[0],
    TOOL_PROTECTION_EXTERNAL_CUSTOM_TYPE);
  assert.equal(SessionManager.open(externalRecord.path).getEntries().filter((row) => row.type === "custom").length, 1);

  // 3. A refusal before any transport: the generated request is kept and says it
  //    was never sent — and a refusal that quotes a configuration path does not
  //    persist that path in the request entry either.
  const refusedSaved = await writeAuditorSessionRecord({
    identity: identity("invoke-native-refused"),
    prompt: AUDITOR_PROMPT_SENTINEL,
    observation: { transport: "route-refused", refusal: "Pi auditor in-process launch failed: open /synthetic/NATIVE-SECRET-bootstrap.json" },
    outcome: { status: "transport-error", error: "Pi auditor in-process launch failed: open /synthetic/NATIVE-SECRET-bootstrap.json" },
  }, dependencies);
  assert.deepEqual(refusedSaved, { saved: "full" });
  const afterRefused = await SessionManager.list(workspace);
  assert.equal(afterRefused.length, 3, "one record per actual invocation, including a refusal");
  const refusedRecord = afterRefused.find((row) => row.id !== info.id && row.id !== externalRecord.id)!;
  const refusedRaw = readFileSync(refusedRecord.path, "utf8");
  assert.ok(refusedRaw.includes("never sent to any transport"), "a refusal is labelled as one");
  assert.ok(refusedRaw.includes(AUDITOR_PROMPT_SENTINEL), "the generated request is still preserved");
  assert.ok(!refusedRaw.includes("NATIVE-SECRET-bootstrap"), "a bootstrap path in refusal text never reaches the installed store");
  assert.ok(!refusedRaw.includes("/synthetic/"), "no configuration path reaches the installed store");
  assert.ok(refusedRaw.includes("<path>"), "the withheld token is disclosed");
  const refusedData = SessionManager.open(refusedRecord.path).getEntries()
    .find((row) => row.type === "custom")!.data as Record<string, unknown>;
  assert.equal(refusedData.refusal, "Pi auditor in-process launch failed: open <path> [paths withheld from saved records]");
  assert.equal(refusedData.decision, undefined, "a refusal records no verdict");

  // 4. A launch failure keeps only the honest category and code. Node quotes the
  //    configured executable in the user-facing diagnostic, so this proves the
  //    installed store never receives transport configuration.
  const launchSaved = await writeAuditorSessionRecord({
    identity: identity("invoke-native-launch"),
    prompt: AUDITOR_PROMPT_SENTINEL,
    observation: {
      transport: "route-refused",
      refusal: "Auditor launch failed: the configured auditor program could not be started (spawn ENOENT). Its command, arguments, and environment are not reported.",
      launchFailure: { syscall: "spawn", code: "ENOENT" },
    },
    outcome: { status: "transport-error", error: "Auditor launch failed: spawn /synthetic/NATIVE-SECRET-auditor-bin ENOENT" },
  }, dependencies);
  assert.deepEqual(launchSaved, { saved: "full" });

  // 5. Delivery the host never confirmed is labelled as unconfirmed. The split
  //    writer is used here so the outcome entry is written by the synchronous
  //    completion step, exactly as an admitted call does it.
  const undeliveredEnvelope = JSON.stringify({
    version: PROTECTION_AUDITOR_PROTOCOL,
    prompt: AUDITOR_PROMPT_SENTINEL,
    input: null,
    cwd: workspace,
  });
  const beforeIds = new Set((await SessionManager.list(workspace)).map((row) => row.id));
  const undeliveredOpen = await openAuditorSessionRecord({
    identity: identity("invoke-native-undelivered"),
    prompt: undeliveredEnvelope,
    observation: {
      transport: "external-binary",
      external: {
        requestText: undeliveredEnvelope,
        outputText: "",
        truncated: false,
        exitCode: null,
        timedOut: false,
        aborted: false,
        deliveredToStdin: false,
        stdinError: "write EPIPE",
        settlement: "unconfirmed",
      },
    },
  }, dependencies);
  const afterOpen = await SessionManager.list(workspace);
  assert.equal(afterOpen.length, 5, "the record file exists before its outcome is decided");
  const undeliveredRecord = afterOpen.find((row) => !beforeIds.has(row.id))!;
  assert.ok(undeliveredRecord, "the new record is discoverable before completion");
  assert.equal(SessionManager.open(undeliveredRecord.path).getEntries().filter((row) => row.type === "custom").length, 0,
    "no outcome entry exists before completion");
  assert.deepEqual(undeliveredOpen.complete({ status: "transport-error", error: "Auditor could not receive its request." }), { saved: "full" });

  const afterAll = await SessionManager.list(workspace);
  assert.equal(afterAll.length, 5, "five actual invocations, five independent saved sessions");
  const launchRecord = afterAll.find((row) => readFileSync(row.path, "utf8").includes("spawn ENOENT"));
  assert.ok(launchRecord, "the launch category and code are recorded");
  const launchRaw = readFileSync(launchRecord.path, "utf8");
  assert.ok(!launchRaw.includes("NATIVE-SECRET-auditor-bin"), "the configured executable never reaches the installed store");
  assert.ok(!launchRaw.includes("/synthetic/"), "no executable path reaches the installed store");
  const launchData = SessionManager.open(launchRecord.path).getEntries()
    .find((row) => row.type === "custom")!.data as Record<string, unknown>;
  assert.deepEqual(launchData.launchFailure, { syscall: "spawn", code: "ENOENT" });

  const undeliveredRaw = readFileSync(undeliveredRecord.path, "utf8");
  assert.ok(undeliveredRaw.includes("Delivery is NOT confirmed"), "an undelivered envelope is labelled as such");
  assert.ok(undeliveredRaw.includes("may have read none or only part"), "the record states what is unknown");
  assert.ok(!undeliveredRaw.includes("the exact JSON written"), "delivery is never overclaimed");

  // Each record stays independent: one outcome entry each, and no record was
  // read back into another.
  const ids = new Set(afterAll.map((row) => row.id));
  assert.equal(ids.size, 5);
  for (const row of afterAll) {
    assert.equal(SessionManager.open(row.path).getEntries().filter((entry2) => entry2.type === "custom").length, 1,
      `record ${row.id} holds exactly one audit outcome`);
  }
}

// ---------------------------------------------------------------------------
// Optional-versus-required host contract (no live host involved)
// ---------------------------------------------------------------------------

async function runRequiredHostGate(t: TestContext): Promise<void> {
  const compiled = compiledHostTestFile();
  if (!compiled) {
    skipOrFail(t, "compiled installed-host test file is unavailable for the required-host gate probe");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "prg-tool-protection-host-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A pinned but unavailable agent package is the sole discovery candidate, so
  // the subprocess deterministically observes a missing installed host without
  // touching any live installation.
  const missingAgent = join(root, "missing-agent");
  // Node marks test-file child processes with NODE_TEST_CONTEXT; the gate probe
  // is a fresh runner invocation, so that marker must not be inherited.
  const childEnv = (required: boolean): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_REVIEW_GATE_INSTALLED_AGENT: missingAgent,
      PI_REVIEW_GATE_REQUIRE_PI_HOST: required ? "1" : "0",
    };
    delete env.NODE_TEST_CONTEXT;
    return env;
  };
  const run = (required: boolean) => spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", "--test-name-pattern", HOST_TEST_TOKEN, compiled],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
      env: childEnv(required),
    },
  );

  const optional = run(false);
  assert.equal(optional.status, 0, `optional environment must keep an honest skip: ${optional.stdout}\n${optional.stderr}`);
  assert.match(optional.stdout, /# SKIP/i);
  assert.match(optional.stdout, /no installed Pi/i, "the skip states the missing prerequisite");
  assert.doesNotMatch(optional.stdout, /required Pi host unavailable/i);

  const required = run(true);
  assert.notEqual(required.status, 0, "the required-host gate must fail instead of skipping");
  assert.match(`${required.stdout}\n${required.stderr}`, /required Pi host unavailable/);
}

// Only the isolated child registers the installed-SDK test; only a normal run
// registers the subprocess orchestrator and the gate contract (no recursion).
if (ISOLATED_HOST_CHILD) {
  test(INNER_TEST_TOKEN, runIsolatedInstalledHost);
} else {
  test(HOST_TEST_NAME, runInstalledHostSubprocess);
  test("missing installed host skips honestly and the required-host gate fails hard", runRequiredHostGate);
}
