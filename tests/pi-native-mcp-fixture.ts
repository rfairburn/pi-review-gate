/**
 * Reusable hermetic native-runtime integration fixture for Pi 1.0.0 MCP
 * lifecycle tests (issue #224 and its consumers).
 *
 * It drives the REAL installed `pi` runtime (`pi --mode rpc`, the established
 * public CLI seam) with the built-in MCP extension against an anonymized,
 * disposable, trusted-project MCP server:
 *
 * - `tests/fixtures/pi-native-mcp-server.cjs`: dependency-free stdio MCP
 *   server (newline-delimited JSON-RPC, the framing Pi's MCP client speaks)
 *   exposing only anonymous, nonsecret `echo`/`counter` tools. It instruments
 *   every protocol event into an append-only JSONL log, serves a file-based
 *   control channel (tool-list rotation with `notifications/tools/list_changed`,
 *   server-side exit), and shares a counter file across reconnects so a call
 *   that never reached the server is provable ("counter unchanged, no
 *   tools/call event").
 * - `tests/fixtures/pi-native-mcp-probe.cjs`: in-session extension loaded via
 *   `--extension`: registers Pi's own testing provider (`fauxProvider` from
 *   `@earendil-works/pi-ai`) so agent-loop turns run with scripted tool calls
 *   entirely in-process (provider stream mocked; no provider APIs, credentials,
 *   or network), auto-selects that model on every session start, writes the
 *   live tool/command inventory via `/native-mcp-probe dump`, and — only when
 *   the fixture writes a deny file — simulates a gate denial through Pi's
 *   ordinary `tool_call` blocking seam (a fixture seam, not the review gate).
 *
 * Isolation (same conventions as the existing real-host tests):
 * - scratch (project, agent dir, sessions, fixture state) is created OUTSIDE
 *   the repository tree under `os.tmpdir()` and removed on dispose;
 * - the pi child runs with a synthetic HOME/PI_CODING_AGENT_DIR and an
 *   allowlisted environment with every `PI_REVIEW_GATE_*` variable and
 *   provider API key stripped;
 * - project trust is granted per-run with the documented `--approve` CLI
 *   override; no user settings, trust decisions, or config files are touched.
 *
 * Host conventions: the installed Pi resolves through the existing
 * `findInstalledAgentDirs` helper (PI_REVIEW_GATE_INSTALLED_AGENT pins it);
 * missing prerequisites skip, hard-failing under
 * `PI_REVIEW_GATE_REQUIRE_PI_HOST=1`; the fixture requires Pi 1.x (validated
 * against the installed 1.0.0) and the Node >= 22.19.0 floor pi 1.0 declares.
 *
 * Native MCP lifecycle surface (Pi 1.0.0 public seams):
 * - connect from a trusted project `mcp.json` on session start;
 * - model-issued tool calls through the real pipeline (faux `toolUse` step);
 * - `notifications/tools/list_changed` handling via generation-file rotation
 *   (gen 1 lists `echo`+`counter`; gen >= 2 lists `echo_second`+`counter`);
 * - `/mcp reconnect <server>` via the native extension-command seam;
 * - enable/disable via the native config seam: flipping `enabled` in the
 *   project `mcp.json` and starting a new session (Pi re-reads project config
 *   on every session start).
 *
 * Deliberately NOT covered (documented, not faked): the TUI-only parts of
 * `/mcp` (manager, enable/disable, exposure editing — RPC has no manager UI),
 * `pi.registerMcpServer`/`unregisterMcpServer` registration lifecycle, and
 * tool_search/codemode-script driven calls. The probe's deny file is a
 * fixture-owned seam for exercising denial instrumentation; the candidate
 * under test replaces it in lifecycle tests.
 *
 * Startup controls for actual gate roles (all optional; the default launch is
 * unchanged): `piArgs` appends consumer-owned pi CLI arguments unchanged for
 * explicit native restriction cases; `wrapperDefault` reproduces only the
 * wrapper's `PI_REVIEW_GATE_CODEMODE_DEFAULT=1` marker (no runtime role, no
 * user environment copied); `executorToolCatalog` launches the ACTUAL gate
 * executor role exactly like the production Pi executor adapter — the fixed
 * provided catalog through `PI_REVIEW_GATE_RUNTIME_ROLE` +
 * `PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG`, one native `--tools` allowlist of
 * the captured allowed capabilities + `tool_search`, and a fresh synthetic
 * settlement bootstrap created under the fixture scratch through the
 * production settlement helpers. All role values are synthetic and declared;
 * no inherited `PI_REVIEW_GATE_*` variable or provider key is ever copied,
 * and the settlement signing secret is never logged or probed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { assertNoPiToolPolicyArgs } from "../src/pi-tool-policy";
import {
  DEFERRED_TOOL_SEARCH_NAME,
  EXECUTOR_TOOL_CATALOG_ENV,
  createExecutorToolCatalog,
  createPiWorkerToolCatalog,
  type ExecutorToolCatalog,
} from "../src/execution/tool-catalog";
import {
  createPiSettlementBootstrap,
  piSettlementEnvironment,
  removePiSettlementReceipt,
  type PiSettlementBootstrap,
} from "../src/execution/pi-settlement-receipt";
import { skipOrFail } from "./bridge-fakes";
import { findInstalledAgentDirs } from "./menu-tui-fakes";

/** Installed Pi 1.x agent package name resolved by the shared discovery helper. */
const PI_AGENT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
/** Pi 1.0.0 declares engines.node >= 22.19.0; the fixture requires the same floor. */
const NODE_REQUIRED_MAJOR = 22;
const NODE_REQUIRED_MINOR = 19;
/** Default provider/model id the probe registers and auto-selects. */
export const FIXTURE_PROVIDER_ID = "prg-fixture";
export const FIXTURE_MODEL_ID = "driven";
/** Default synthetic trusted-project MCP server name (tool ids `mcp__<name>__<tool>`). */
export const DEFAULT_SERVER_NAME = "prg_native_mcp";

/** Shape of the parsed JSONL entries of both journals (loose by design). */
export type FixtureEvent = Record<string, unknown>;

/** Pi 1.0.0 MCP server exposures accepted in `.pi/mcp.json`. */
export type FixtureServerExposure = "codemode" | "deferred" | "direct" | "hidden";

/**
 * Pi 1.0.0 registers the tools of a `codemode` server with the pi tool
 * exposure `deferred` (public `toToolExposure` mapping: callable from
 * scripts and tool_search, listed in neither codemode description nor the
 * model's active declarations). Consumers assert on this value.
 */
export const REGISTERED_EXPOSURE_FOR_CODENAME_SERVER: FixtureServerExposure = "deferred";

/** The zero-model config the launcher writes on first launch (no reviewers, no workers, no auth). */
export const ZERO_MODEL_GATE_CONFIG = {
	enabled: true,
	review: { activeReviewers: [] },
	externalAgents: {},
	execution: { workerResources: {}, routes: { execute: [], research: [] } },
} as const;

/** One scripted provider response per model REQUEST (ordered by request in the turn). */
export interface FixtureTurnStep {
	/** Final text (stops the turn) when no toolCalls are given. */
	text?: string;
	/** Emits this assistant message with stopReason `toolUse`. */
	toolCalls?: Array<{ toolName: string; arguments?: Record<string, unknown> }>;
	/**
	 * Emits a model toolCall for the active `codemode` tool running this script
	 * — the native path for reaching `codemode`-exposed MCP tools (scripts call
	 * them through ctx.executeTool, where permission gates apply). Example:
	 * `return await tools.mcp__prg_native_mcp__echo({ message: "hi" })`.
	 */
	codemode?: string;
}

/** Denial simulation: the probe's standalone `tool_call` blocking seam. */
export interface FixtureDenialPolicy {
	tools: string[];
	reason?: string;
}

/** The live tool/command inventory the probe writes on `/native-mcp-probe dump`. */
export interface ProbeDump {
	requested?: string;
	activeTools?: string[];
	allTools?: Array<{
		name: string;
		exposure?: string;
		namespace?: string;
		annotations?: Record<string, unknown>;
		description?: string;
	}>;
	commands?: string[];
}

// ---------------------------------------------------------------------------
// Prerequisites (host resolution follows the existing real-host conventions)
// ---------------------------------------------------------------------------

export interface PiHostResolution {
	/** Package root of the resolved installed pi-coding-agent. */
	agentDir: string;
	/** Resolved `dist/bundle/cli.js` entry. */
	cliEntry: string;
	/** package.json version of the resolved install. */
	version: string;
}

export class FixturePrerequisiteError extends Error {}

/** Node floor check for the fixture host (pi 1.0 declares engines.node >= 22.19.0). */
export function nodeFloorSatisfied(): boolean {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(process.version);
	if (!match) return false;
	const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
	if (major !== NODE_REQUIRED_MAJOR) return major > NODE_REQUIRED_MAJOR;
	return minor > NODE_REQUIRED_MINOR || (minor === NODE_REQUIRED_MINOR && patch >= 0);
}

/**
 * Resolve the installed Pi 1.x for a native fixture run.
 * PI_REVIEW_GATE_INSTALLED_AGENT pins the install (sole candidate, existing
 * convention); otherwise the shared ambient discovery from
 * tests/menu-tui-fakes.ts applies. Throws FixturePrerequisiteError naming
 * every candidate's problem when nothing qualifies.
 */
export function resolvePiHost(minMajor = 1): PiHostResolution {
	const problems: string[] = [];
	for (const agentDir of findInstalledAgentDirs()) {
		const cliEntry = join(agentDir, "dist", "bundle", "cli.js");
		try {
			const version = (JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8")) as { version?: string }).version ?? "";
			const major = Number.parseInt(version.split(".")[0] ?? "", 10);
			if (!Number.isInteger(major) || major < minMajor) {
				problems.push(
					`${agentDir}: Pi ${version || "?"} does not satisfy the fixture's required 1.x runtime `
					+ "(native RPC/MCP surface of Pi 1.0.0+); point PI_REVIEW_GATE_INSTALLED_AGENT at a Pi 1.x install",
				);
				continue;
			}
		} catch (error) {
			problems.push(`${agentDir}: unreadable package.json (${String(error)})`);
			continue;
		}
		if (!existsSync(cliEntry)) {
			problems.push(`${agentDir}: dist/bundle/cli.js missing (incomplete install)`);
			continue;
		}
		return { agentDir, cliEntry, version: readPiVersion(agentDir) };
	}
	if (problems.length === 0) {
		problems.push(`no installed ${PI_AGENT_PACKAGE_NAME} found (PI_REVIEW_GATE_INSTALLED_AGENT or an ambient global install)`);
	}
	problems.sort();
	throw new FixturePrerequisiteError(problems.join("; "));
}

function readPiVersion(agentDir: string): string {
	try {
		return (JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8")) as { version?: string }).version ?? "";
	} catch {
		return "";
	}
}

export interface FixturePrerequisites {
	ok: boolean;
	problems: string[];
	host?: PiHostResolution;
	candidateEntry?: string;
}

/**
 * Prerequisite check for a fixture run: Node floor, installed Pi 1.x, and the
 * candidate extension entry when one is requested. Candidates resolve to
 * PI_REVIEW_GATE_CANDIDATE_ENTRY, then dist/src/index.js (existing
 * real-host convention); `candidateEntry: null` opts out.
 */
export function describeFixturePrerequisites(options: NativeMcpFixtureOptions = {}): FixturePrerequisites {
	const problems: string[] = [];
	if (!nodeFloorSatisfied()) {
		problems.push(
			`Node ${process.version} is below the fixture's ${NODE_REQUIRED_MAJOR}.${NODE_REQUIRED_MINOR} floor `
			+ "(declared by pi-coding-agent 1.0.0 engines)",
		);
	}
	let host: PiHostResolution | undefined;
	try {
		host = resolvePiHost();
	} catch (error) {
		problems.push(error instanceof Error ? error.message : String(error));
	}
	const candidateEntry = resolveCandidateEntryFor(options);
	if (candidateEntry !== undefined && !existsSync(candidateEntry)) {
		problems.push(`candidate extension entry not found: ${candidateEntry} (PI_REVIEW_GATE_CANDIDATE_ENTRY or dist/src/index.js)`);
	}
	return { ok: problems.length === 0, problems, host, ...(candidateEntry === undefined ? {} : { candidateEntry }) };
}

/**
 * Skip-or-fail gate over the full prerequisite set, matching the existing
 * real-host convention: skip on missing prerequisites, hard-fail under
 * `PI_REVIEW_GATE_REQUIRE_PI_HOST=1`. Pass the test context so after-hooks
 * can be validated by the caller (fixture dispose is its own responsibility).
 */
export function assertPrerequisitesOrFail(
	t: { skip(message?: string): void },
	options: NativeMcpFixtureOptions = {},
): void {
	const prerequisites = describeFixturePrerequisites(options);
	if (!prerequisites.ok) {
		skipOrFail(t, `native MCP fixture prerequisites unavailable: ${prerequisites.problems.join("; ")}`);
	}
}

/**
 * Resolve the candidate extension entry BEFORE spawning pi: the child runs in
 * the scratch project, so its `--extension` resolution can never see
 * caller-relative paths; explicit option and env values must be turned into
 * absolute paths here (the prerequisite check then validates the exact path
 * pi will receive). `candidateEntry: null` opts out.
 */
function resolveCandidateEntryFor(options: Pick<NativeMcpFixtureOptions, "candidateEntry">): string | undefined {
	if (options.candidateEntry === null) return undefined;
	if (options.candidateEntry !== undefined) return resolvePath(options.candidateEntry);
	const fromEnv = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY;
	if (fromEnv) return resolvePath(fromEnv);
	return resolvePath(process.cwd(), join("dist", "src", "index.js"));
}

/** Mirrors Pi's public `createMcpToolName` sanitization for fixture assertions. */
export function mcpToolName(serverName: string, toolName: string): string {
	return `mcp__${serverName}__${toolName}`.replace(/[^A-Za-z0-9_]/g, "_");
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/**
 * Create (but do not start) a fixture: checks the Node floor and resolves the
 * installed Pi host (throws FixturePrerequisiteError with the reasons).
 */
export function createNativeMcpFixture(options: NativeMcpFixtureOptions = {}): NativeMcpFixture {
	validateFixtureStartupControls(options);
	if (!nodeFloorSatisfied()) {
		throw new FixturePrerequisiteError(
			`Node ${process.version} is below the fixture's ${NODE_REQUIRED_MAJOR}.${NODE_REQUIRED_MINOR} floor (declared by pi-coding-agent 1.0.0 engines)`,
		);
	}
	return new NativeMcpFixture(resolvePiHost(), options);
}

/** Context string for the production tool-policy rejection of fixture-owned piArgs. */
const FIXTURE_TOOL_POLICY_ARG_CONTEXT = "Native MCP fixture piArgs";

/**
 * Normalize the executor catalog exactly like the production Pi adapter:
 * canonical validation folded into the shared Pi worker view (Subtasks*
 * controls dropped, initial subset enforced). A malformed provided catalog
 * throws here, never at spawn.
 */
function prepareExecutorToolCatalog(catalog: ExecutorToolCatalog): ExecutorToolCatalog {
	return createPiWorkerToolCatalog(createExecutorToolCatalog(catalog.allowedToolCatalog, catalog.initialActiveTools));
}

/**
 * The single native `--tools` allowlist the helper owns for executor-role
 * launches, byte-for-byte like the production adapter's childArgs: every
 * captured allowed capability plus `tool_search` (the sole control tool
 * outside the durable capability catalog), deduplicated, never auto-widened.
 */
function executorLaunchToolList(catalog: ExecutorToolCatalog): string[] {
	return [...new Set([...catalog.allowedToolCatalog, DEFERRED_TOOL_SEARCH_NAME])];
}

/**
 * Fail fast on contradictory startup controls: `wrapperDefault` and
 * `executorToolCatalog` are exclusive startup roles, and when the helper
 * owns the worker `--tools` allowlist (executor catalog) the consumer's
 * `piArgs` may not carry competing tool-policy flags.
 */
function validateFixtureStartupControls(options: NativeMcpFixtureOptions): void {
	if (options.wrapperDefault === true && options.executorToolCatalog !== undefined) {
		throw new Error(
			"Native MCP fixture options are contradictory: wrapperDefault (ordinary wrapper launch, no runtime role) "
			+ "and executorToolCatalog (actual executor-role launch) are mutually exclusive.",
		);
	}
	const catalog = options.executorToolCatalog;
	if (catalog !== undefined) {
		prepareExecutorToolCatalog(catalog);
		if (options.piArgs !== undefined) assertNoPiToolPolicyArgs(options.piArgs, FIXTURE_TOOL_POLICY_ARG_CONTEXT);
	}
}

export interface NativeMcpFixturePaths {
	scratch: string;
	project: string;
	piAgentDir: string;
	sessionsDir: string;
	mcpConfig: string;
	serverEntry: string;
	probeEntry: string;
	eventLog: string;
	controlFile: string;
	generationFile: string;
	counterFile: string;
	turnScript: string;
	denyFile: string;
	probeDump: string;
	probeJournal: string;
	rpcJournal: string;
	/** Under-scratch executor artifact dir (settlement bootstrap root; only used by executorToolCatalog options). */
	executorArtifactDir: string;
}

export interface NativeMcpFixtureOptions {
	/** Synthetic server name. Default `prg_native_mcp`. */
	serverName?: string;
	/** The `.pi/mcp.json` `exposure` for the fixture server. Default `codemode`. */
	serverExposure?: FixtureServerExposure;
	/**
	 * Written to `<scratch agent dir>/review-gate.json` for the candidate.
	 * Defaults to the zero-model enabled config; `null` skips the file.
	 */
	gateConfig?: object;
	/**
	 * Candidate extension entry loaded beside the probe (default
	 * PI_REVIEW_GATE_CANDIDATE_ENTRY or dist/src/index.js; `null` runs without
	 * a candidate).
	 */
	candidateEntry?: string | null;
	/**
	 * Additional `--extension` paths (consumer-owned). Relative paths resolve
	 * against the caller's cwd — the same resolution the fixture applies to the
	 * candidate entry — because the pi child always runs in the scratch project.
	 */
	additionalExtensions?: string[];
	/**
	 * Whether the probe auto-selects its scripted model on every session start
	 * (default true). `false` disables the auto-selection so the fixture's
	 * own `set_model` fallback performs selection — useful for consumers that
	 * restore a different model selection per session.
	 */
	autoModel?: boolean;
	/** Project trust handling. Default `approve` (the documented per-run override). */
	trustMode?: "approve" | "no-approve";
	/** Parent dir for the scratch tree. Default os.tmpdir() (outside the repo). */
	scratchParent?: string;
	/**
	 * Additional pi CLI arguments appended UNCHANGED after the fixture's own
	 * structural arguments (extensions first, these last). This is the seam for
	 * explicit native restriction cases — wrapper-style `--tools`,
	 * `--exclude-tools`, `--no-tools`, `--no-builtin-tools` flags are forwarded
	 * untouched exactly as the wrappers forward user arguments. When
	 * `executorToolCatalog` is provided the helper itself owns the single
	 * native `--tools` allowlist and contradictory tool-policy flags here are
	 * rejected (via the production `assertNoPiToolPolicyArgs`).
	 */
	piArgs?: string[];
	/**
	 * Wrapper-default marker: sets ONLY `PI_REVIEW_GATE_CODEMODE_DEFAULT="1"`
	 * in the otherwise hermetic child env, mirroring the wrapper's ordinary
	 * launches (the shell/cjs wrappers export exactly this value). No runtime
	 * role, no inherited user environment, no catalog. Mutually exclusive with
	 * `executorToolCatalog` (wrapper launch vs actual executor-role launch).
	 */
	wrapperDefault?: boolean;
	/** Start with an empty project mcpServers object instead of the default fixture server. Default false. */
	noMcpServers?: boolean;
	/**
	 * Written to `<scratch agent dir>/settings.json` before spawn, so a run can
	 * exercise real user-level Pi settings (for example toggling the builtin
	 * tool-search extension with `"extensions": ["-builtin:tool-search"]`).
	 */
	agentSettings?: object;
	/**
	 * Launch the ACTUAL gate executor role exactly like the production Pi
	 * executor adapter (`src/execution/adapters/pi-model.ts`): sets
	 * `PI_REVIEW_GATE_RUNTIME_ROLE="executor"` and
	 * `PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG` to this fixed catalog normalized
	 * through the same production helpers (createExecutorToolCatalog +
	 * createPiWorkerToolCatalog; never auto-widened; Subtasks* names dropped
	 * by the shared Pi worker normalization), emits ONE `--tools` allowlist of
	 * the captured allowed capabilities + `tool_search`, launches with a
	 * synthetic session id (`--session-id`), and creates a fresh AUTHENTIC
	 * synthetic settlement bootstrap under the fixture scratch via the production
	 * createPiSettlementBootstrap/piSettlementEnvironment (random identity +
	 * secret per child; the child captures and erases it exactly as in
	 * production). The signing secret is never logged and never exposed beyond
	 * the declared child environment.
	 */
	executorToolCatalog?: ExecutorToolCatalog;
	timeouts?: {
		/** Per-RPC-request deadline. Default 30_000. */
		requestMs?: number;
		/** Bounded MCP server connect wait. Default 30_000. */
		connectMs?: number;
		/** Bounded agent-turn settle wait. Default 120_000. */
		turnMs?: number;
		/** Bounded probe-dump wait. Default 10_000. */
		dumpMs?: number;
	};
}

interface RpcResponse {
	id: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: unknown;
}

export class NativeMcpFixture {
	readonly host: PiHostResolution;
	readonly serverName: string;

	/** Every parsed RPC message (responses + session events) the child emitted. */
	readonly sessionEvents: FixtureEvent[] = [];
	paths!: NativeMcpFixturePaths;

	/** The tool-list generation the fixture last rotated to (1 before any rotation). */
	currentListingGeneration = 1;

	private child: ChildProcess | undefined;
	private pending = new Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
	private nextRequestId = 1;
	private nextProbeDumpRequestId = 1;
	private stderrTail = "";
	private disposed = false;
	private childDied: string | undefined;
	private timeouts: Required<NonNullable<NativeMcpFixtureOptions["timeouts"]>>;
	/** Synthetic executor-role session id (executorToolCatalog options only). */
	private executorSessionId: string | undefined;
	/** Fresh parent-side settlement identity; the child captures and erases its env entries. */
	private executorSettlementBootstrap: PiSettlementBootstrap | undefined;

	constructor(host: PiHostResolution, options: NativeMcpFixtureOptions) {
		this.host = host;
		this.serverName = options.serverName ?? DEFAULT_SERVER_NAME;
		this.options = options;
		this.timeouts = {
			requestMs: options.timeouts?.requestMs ?? 30_000,
			connectMs: options.timeouts?.connectMs ?? 30_000,
			turnMs: options.timeouts?.turnMs ?? 120_000,
			dumpMs: options.timeouts?.dumpMs ?? 10_000,
		};
	}

	private options: NativeMcpFixtureOptions;

	/** The pi child's OS pid once spawned (undefined before start() or after a spawn failure). */
	get childPid(): number | undefined {
		return this.child?.pid;
	}

	/** Bounded tail of the pi child's stderr (load-time diagnostics surface). */
	stderrTailText(): string {
		return this.stderrTail;
	}

	// -- Lifecycle -----------------------------------------------------------

	/**
	 * Create the scratch project/agent dirs, spawn the real pi child, and wait
	 * for a live session with the scripted model (fresh `get_state` per wait
	 * iteration, never a cached read).
	 */
	async start(): Promise<void> {
		if (this.child && this.child.exitCode === null) {
			throw new Error("fixture already started (start() spawns exactly one pi child; use ensureScriptedModel() afterwards)");
		}
		await this.createScratch();
		await this.prepareExecutorSettlementBootstrap();
		this.spawnPiChild();
		await this.ensureScriptedModel();
	}

	/**
	 * Deterministic scripted-model availability, safe to call repeatedly (e.g.
	 * after `restartSession`s and after another extension selected a different
	 * model). Reads FRESH session state on every iteration (a cached state read
	 * cannot observe a `set_model` that just succeeded) and selects the fixture
	 * model whenever the provider or the model id differs.
	 */
	async ensureScriptedModel(): Promise<unknown> {
		const deadline = Date.now() + this.timeouts.requestMs;
		let lastFailure: Error | undefined;
		for (;;) {
			const model = await this.currentModel();
			if (model?.provider === FIXTURE_PROVIDER_ID && model.id === FIXTURE_MODEL_ID) return model;
			if (Date.now() >= deadline) {
				throw new Error(
					`fixture model ${FIXTURE_PROVIDER_ID}/${FIXTURE_MODEL_ID} never became selected`
					+ `${lastFailure ? `; last selection error: ${lastFailure.message}` : ""}`
					+ `${this.childDied ? ` (pi exited: ${this.childDied})` : ""}; stderr tail:\n${this.stderrTail}`,
				);
			}
			try {
				await this.rpc("set_model", { provider: FIXTURE_PROVIDER_ID, modelId: FIXTURE_MODEL_ID });
				lastFailure = undefined;
			} catch (error) {
				// A pending provider registration or a just-replaced session can
				// briefly reject selection; keep retrying until the deadline.
				lastFailure = error instanceof Error ? error : new Error(String(error));
			}
			await delay(100);
		}
	}

	/** Terminate the pi child (MCP servers die when its stdin closes), remove the scratch unless retained. */
	async dispose(options: { retainScratch?: boolean } = {}): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const child = this.child;
		if (child) {
			const dead = firstExit(child);
			try {
				child.kill("SIGTERM");
			} catch {
				// Already gone.
			}
			const exited = await Promise.race([dead.then(() => true), delay(10_000).then(() => false)]);
			if (!exited) {
				try {
					child.kill("SIGKILL");
				} catch {
					// Gone.
				}
				await firstExit(child);
			}
		}
		for (const pendingEntry of this.pending.values()) {
			clearTimeout(pendingEntry.timer);
			pendingEntry.reject(new Error("fixture disposed"));
		}
		this.pending.clear();
		if (!options.retainScratch) {
			await rm(this.paths.scratch, { recursive: true, force: true });
		}
	}

	// -- Native seams --------------------------------------------------------

	/**
	 * Raw RPC request over the native `pi --mode rpc` stdin protocol. Returns
	 * the response's `data` (or the full response when `body` is set).
	 * `success: false` responses reject; timeouts reject with stderr context.
	 */
	async rpc(type: string, fields: Record<string, unknown> = {}, options: { body?: boolean } = {}): Promise<unknown> {
		const child = this.child;
		if (!child || child.exitCode !== null) {
			throw new Error(`RPC ${type} failed: pi child is not running${this.childDied ? ` (${this.childDied})` : ""}\nstderr:\n${this.stderrTail}`);
		}
		const timeoutMs = this.timeouts.requestMs;
		const id = `prg-native-mcp-${this.nextRequestId++}`;
		const response = await new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`RPC ${type} timed out after ${timeoutMs}ms\nstderr:\n${this.stderrTail}`));
			}, timeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			try {
				child.stdin?.write(`${JSON.stringify({ id, type, ...fields })}\n`);
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(new Error(`RPC ${type} failed to write: ${String(error)}\nstderr:\n${this.stderrTail}`));
			}
		});
		return options.body ? response : response.data;
	}

	/**
	 * Send an ordinary user prompt through the scripted provider and wait until
	 * the resulting agent run settles (the documented `agent_settled` boundary).
	 * Extension commands have no agent run; use `runCommand` for those.
	 */
	async promptTurn(message: string, options: { turnMs?: number } = {}): Promise<void> {
		const deadline = options.turnMs ?? this.timeouts.turnMs;
		const startCount = this.sessionEvents.length;
		const response = await this.rpc("prompt", { message }, { body: true }) as RpcResponse;
		const disposition = (isRecord(response.data) ? response.data.disposition : undefined);
		if (disposition !== "started") {
			// Extension commands and rejections have no agent run to settle.
			throw new Error(`prompt ${JSON.stringify(message)} did not start a run (disposition: ${String(disposition)})`);
		}
		const settled = await this.waitForEvent(
			(event) => event.type === "agent_settled",
			deadline,
			startCount,
		);
		if (!settled) {
			throw new Error(
				`agent run never settled after prompt ${JSON.stringify(message)}`
				+ `${this.childDied ? ` (pi exited: ${this.childDied})` : ""}\nstderr:\n${this.stderrTail}`,
			);
		}
	}

	/**
	 * Send an extension-command prompt (executes immediately, no model run),
	 * e.g. `/mcp reconnect <server>` — the native MCP command seam.
	 */
	async runCommand(message: string): Promise<unknown> {
		return await this.rpc("prompt", { message });
	}

	/** Script the provider responses for the next agent turn (per model REQUEST, in order). */
	async setTurnScript(steps: FixtureTurnStep[]): Promise<void> {
		await writeFile(this.paths.turnScript, `${JSON.stringify({ steps }, null, "\t")}\n`, "utf8");
	}

	/** Write the probe's deny file (or `null` to remove it). */
	async setDenial(policy: FixtureDenialPolicy | null): Promise<void> {
		if (policy === null) {
			await rm(this.paths.denyFile, { force: true });
			return;
		}
		await writeFile(this.paths.denyFile, `${JSON.stringify(policy, null, "\t")}\n`, "utf8");
	}

	/** Run the probe command and return the inventory from this exact live request. */
	async probeDump(): Promise<ProbeDump> {
		const requestId = `dump-${this.nextProbeDumpRequestId++}`;
		await this.runCommand(`/native-mcp-probe ${requestId}`);
		const deadline = Date.now() + this.timeouts.dumpMs;
		for (;;) {
			try {
				const dump = JSON.parse(readFileSync(this.paths.probeDump, "utf8")) as ProbeDump;
				if (dump.requested === requestId) return dump;
			} catch {
				// Not written (yet).
			}
			if (Date.now() >= deadline) {
				throw new Error(`probe dump ${requestId} never appeared\nstderr:\n${this.stderrTail}`);
			}
			await delay(100);
		}
	}

	/**
	 * Rotate the advertised tool list to `generation` (>= 2 replaces `echo`
	 * with `echo_second` and sends `notifications/tools/list_changed`); the
	 * generation file is the authoritative listing state, so later reconnects
	 * and fresh server processes inherit it.
	 */
	async rotateToolList(generation: number): Promise<void> {
		if (!Number.isInteger(generation) || generation < 1) throw new Error(`invalid rotation generation: ${generation}`);
		await this.writeControlState(this.paths.generationFile, { generation });
		this.currentListingGeneration = generation;
	}

	/**
	 * Flip `enabled` for the fixture server in the trusted project `mcp.json`
	 * (the native config seam; Pi re-reads it on every session start).
	 */
	async setServerEnabled(enabled: boolean): Promise<void> {
		const config = JSON.parse(readFileSync(this.paths.mcpConfig, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };
		const entry = config.mcpServers[this.serverName];
		if (!entry) throw new Error(`fixture server entry missing from ${this.paths.mcpConfig}`);
		if (enabled) delete entry.enabled;
		else entry.enabled = false;
		writeFileSync(this.paths.mcpConfig, JSON.stringify(config, null, "\t") + "\n", "utf8");
	}

	/**
	 * Start a fresh native session: the built-in MCP extension re-reads the
	 * project config on session_start, so enable/disable takes effect; the
	 * probe re-selects its scripted model.
	 */
	async restartSession(): Promise<void> {
		await this.rpc("new_session");
	}

	// -- Server-side truth (outside the pi process) --------------------------

	/**
	 * Wait until the fixture server's JSONL log contains a matching event
	 * (`initialize` proves a connect on the server side; `tool_call` proves a
	 * call reached the server).
	 */
	async waitForServerLog(predicate: (event: FixtureEvent) => boolean, timeoutMs = this.timeouts.connectMs, since = 0): Promise<FixtureEvent | undefined> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const events = await this.readServerEvents();
			for (let index = since; index < events.length; index += 1) {
				if (predicate(events[index])) return events[index];
			}
			if (Date.now() >= deadline) return undefined;
			if (this.disposed || this.childDied) return undefined;
			await delay(50);
		}
	}

	/** All fixture-server instrumentation events parsed from the JSONL log. */
	async readServerEvents(): Promise<FixtureEvent[]> {
		try {
			const raw = await readFile(this.paths.eventLog, "utf8");
			return raw
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean)
				.map((line) => JSON.parse(line) as FixtureEvent)
				.filter(isRecord);
		} catch {
			return [];
		}
	}

	/** The shared attempt-counter value (0 when never incremented). */
	async readCounter(): Promise<number> {
		try {
			const parsed = Number.parseInt((await readFile(this.paths.counterFile, "utf8")).trim(), 10);
			return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
		} catch {
			return 0;
		}
	}

	private async waitForEvent(predicate: (event: FixtureEvent) => boolean, timeoutMs: number, since = 0): Promise<FixtureEvent | undefined> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			for (let index = since; index < this.sessionEvents.length; index += 1) {
				if (predicate(this.sessionEvents[index])) return this.sessionEvents[index];
			}
			if (Date.now() >= deadline) return undefined;
			if (this.disposed || this.childDied) return undefined;
			await delay(50);
		}
	}

	/** Fresh session state read (never a cached journal read): the RPC response's `model` when selected. */
	private async currentModel(): Promise<{ provider?: string; id?: string } | undefined> {
		const state = await this.rpc("get_state");
		return isRecord(state) && isRecord(state.model) ? state.model : undefined;
	}

	private async createScratch(): Promise<void> {
		const scratch = await mkdtemp(join(this.options.scratchParent ?? tmpdir(), "prg-native-mcp-"));
		const project = join(scratch, "workspace");
		const piAgentDir = join(scratch, "agent");
		const sessionsDir = join(scratch, "sessions");
		const controlDir = join(scratch, "fixture-state");
		const paths: NativeMcpFixturePaths = {
			scratch,
			project,
			piAgentDir,
			sessionsDir,
			mcpConfig: join(project, ".pi", "mcp.json"),
			serverEntry: resolveFixtureAsset("pi-native-mcp-server.cjs"),
			probeEntry: resolveFixtureAsset("pi-native-mcp-probe.cjs"),
			eventLog: join(controlDir, "event-log.jsonl"),
			controlFile: join(controlDir, "control.json"),
			generationFile: join(controlDir, "generation.json"),
			counterFile: join(controlDir, "counter.txt"),
			turnScript: join(controlDir, "turn-script.json"),
			denyFile: join(controlDir, "deny.json"),
			probeDump: join(controlDir, "probe-dump.json"),
			probeJournal: join(controlDir, "probe-journal.jsonl"),
			rpcJournal: join(scratch, "rpc-journal.jsonl"),
			executorArtifactDir: join(scratch, "executor-artifacts"),
		};
		for (const dir of [project, join(project, ".pi"), piAgentDir, sessionsDir, controlDir]) {
			await mkdir(dir, { recursive: true });
		}
		// The probe reads the state dir by env; the server gets only its own
		// files. Commands (control.json) and advertised-generation state
		// (generation.json) are separate so an exit command can never regress
		// a rotated catalog for later reconnects.
		writeFileSync(paths.controlFile, `${JSON.stringify({ command: "none" })}\n`, { mode: 0o600 });
		writeFileSync(paths.generationFile, `${JSON.stringify({ generation: 1 })}\n`, { mode: 0o600 });
		writeFileSync(paths.counterFile, "0\n", { mode: 0o600 });
		const mcpServers = this.options.noMcpServers
			? {}
			: { [this.serverName]: this.serverEntryConfig(paths, this.options.serverExposure ?? "codemode") };
		await writeFile(paths.mcpConfig, `${JSON.stringify({ mcpServers }, null, "\t")}\n`, "utf8");
		const gateConfig = this.options.gateConfig === null ? undefined : this.options.gateConfig ?? ZERO_MODEL_GATE_CONFIG;
		if (gateConfig !== undefined) {
			await writeFile(join(piAgentDir, "review-gate.json"), `${JSON.stringify(gateConfig, null, "\t")}\n`, "utf8");
		}
		if (this.options.agentSettings !== undefined) {
			await writeFile(join(piAgentDir, "settings.json"), `${JSON.stringify(this.options.agentSettings, null, "\t")}\n`, "utf8");
		}
		this.paths = paths;
	}

	private serverEntryConfig(paths: Pick<NativeMcpFixturePaths, "serverEntry" | "eventLog" | "controlFile" | "generationFile" | "counterFile">, exposure: FixtureServerExposure): Record<string, unknown> {
		const common = {
			command: process.execPath,
			args: [paths.serverEntry],
			description: "Anonymized fixture MCP server for review-gate lifecycle tests.",
			timeout: 30,
			env: {
				PRG_FIXTURE_EVENT_LOG: paths.eventLog,
				PRG_FIXTURE_CONTROL_FILE: paths.controlFile,
				PRG_FIXTURE_GENERATION_FILE: paths.generationFile,
				PRG_FIXTURE_COUNTER_FILE: paths.counterFile,
			},
		};
		return exposure === "codemode" ? common : { ...common, exposure };
	}

	/**
	 * Executor-role settlement identity, exactly like the parent adapter: a
	 * fresh random child identity + secret anchored to the synthetic session
	 * id, created through the production helper under the fixture scratch, and
	 * any impossible stale receipt at that (random) path removed first.
	 */
	private async prepareExecutorSettlementBootstrap(): Promise<void> {
		if (this.options.executorToolCatalog === undefined) return;
		const sessionId = randomUUID();
		await mkdir(this.paths.executorArtifactDir, { recursive: true });
		const bootstrap = createPiSettlementBootstrap(this.paths.executorArtifactDir, sessionId);
		await removePiSettlementReceipt(bootstrap);
		this.executorSessionId = sessionId;
		this.executorSettlementBootstrap = bootstrap;
	}

	/**
	 * The synchronized executor-role launch plan: the fixed normalized catalog,
	 * the synthetic session id, and the prepared settlement identity. Returns
	 * undefined for an ordinary launch; throws (fail closed) when an executor
	 * catalog was requested without its prepared settlement identity.
	 */
	private executorLaunchPlan(): { catalog: ExecutorToolCatalog; sessionId: string; settlement: PiSettlementBootstrap } | undefined {
		const catalogOption = this.options.executorToolCatalog;
		if (catalogOption === undefined) return undefined;
		if (!this.executorSessionId || !this.executorSettlementBootstrap) {
			throw new Error(
				"Executor-role launch requested but the settlement bootstrap was not prepared; start() prepares it before spawning.",
			);
		}
		return {
			catalog: prepareExecutorToolCatalog(catalogOption),
			sessionId: this.executorSessionId,
			settlement: this.executorSettlementBootstrap,
		};
	}

	private spawnPiChild(): void {
		const executorLaunch = this.executorLaunchPlan();
		const args = [
			this.host.cliEntry,
			"--mode", "rpc",
			"--session-dir", this.paths.sessionsDir,
			"--offline",
			"--no-context-files",
			"--no-skills",
			"--no-themes",
			"--no-prompt-templates",
			this.options.trustMode === "no-approve" ? "--no-approve" : "--approve",
		];
		const candidateEntry = resolveCandidateEntryFor(this.options);
		if (candidateEntry) args.push("--extension", candidateEntry);
		args.push("--extension", this.paths.probeEntry);
		for (const extra of this.options.additionalExtensions ?? []) {
			args.push("--extension", resolvePath(extra));
		}
		// Consumer-owned arguments go through unchanged (wrapper-style explicit
		// restriction flags; validated against a fixture-owned allowlist above).
		if (this.options.piArgs && this.options.piArgs.length > 0) args.push(...this.options.piArgs);
		// Executor-role launch shape, byte-for-byte like the production adapter's
		// childArgs: the synthetic session id is the settlement identity's
		// session anchor, and ONE --tools allowlist carries the captured allowed
		// capabilities plus tool_search (the catalog is authoritative; nothing
		// is auto-widened).
		if (executorLaunch) {
			args.push("--session-id", executorLaunch.sessionId);
			args.push("--tools", executorLaunchToolList(executorLaunch.catalog).join(","));
		}
		// Allowlisted hermetic environment: no inherited PI_REVIEW_GATE_*
		// variables (the candidate must run against the scratch agent dir, never
		// a live config) and no provider API keys (no provider call is possible;
		// the scripted provider is registered in-process). The ONLY
		// PI_REVIEW_GATE_* entries the child ever receives are the declared
		// synthetic startup controls requested via options: the wrapper marker
		// (wrapperDefault) or the executor runtime role + fixed tool catalog +
		// fresh settlement bootstrap (executorToolCatalog) — never arbitrary
		// inherited values.
		const childEnv: NodeJS.ProcessEnv = {};
		for (const key of ["PATH", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP"]) {
			if (process.env[key] !== undefined) childEnv[key] = process.env[key];
		}
		childEnv.HOME = this.paths.scratch;
		childEnv.USERPROFILE = this.paths.scratch;
		childEnv.PI_CODING_AGENT_DIR = this.paths.piAgentDir;
		childEnv.PRG_FIXTURE_AGENT_DIR = this.host.agentDir;
		childEnv.PRG_FIXTURE_STATE_DIR = dirname(this.paths.controlFile);
		if (this.options.autoModel === false) childEnv.PRG_FIXTURE_NO_AUTO_MODEL = "1";
		if (this.options.wrapperDefault === true) childEnv.PI_REVIEW_GATE_CODEMODE_DEFAULT = "1";
		if (executorLaunch) {
			// Role + fixed catalog exactly like the production executorEnv (hermetic
			// by construction: nothing inherited matches PI_REVIEW_GATE_DISABLED,
			// PI_EXTRA_EXTENSIONS, or the settlement/quiescence variable names, so
			// the adapter's deletions are unnecessary here), then the fresh
			// settlement bootstrap from the production environment helper.
			childEnv.PI_REVIEW_GATE_RUNTIME_ROLE = "executor";
			childEnv[EXECUTOR_TOOL_CATALOG_ENV] = JSON.stringify(executorLaunch.catalog);
			Object.assign(childEnv, piSettlementEnvironment(executorLaunch.settlement));
		}
		const child = spawn(process.execPath, args, {
			cwd: this.paths.project,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: childEnv,
		});
		this.child = child;
		// The settlement receipt records the actual child pid (production parity:
		// settlementBootstrap.pid = proc.pid); the childPid getter exposes exactly
		// this identity for receipt verification.
		if (this.executorSettlementBootstrap && child.pid !== undefined) {
			this.executorSettlementBootstrap.pid = child.pid;
		}
		let stdoutBuffer = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdoutBuffer += chunk;
			for (;;) {
				const newline = stdoutBuffer.indexOf("\n");
				if (newline < 0) break;
				const line = stdoutBuffer.slice(0, newline).trim();
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				this.handleRpcLine(line);
			}
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.stderrTail = `${this.stderrTail}${chunk}`.slice(-16_000);
		});
		child.on("error", (error) => {
			this.childDied = `spawn error: ${String(error)}`;
			this.rejectAllPending(this.childDied);
		});
		child.on("close", (code, signal) => {
			if (this.disposed) return;
			this.childDied = `exited with ${code === null ? `signal ${signal}` : `status ${code}`}`;
			this.rejectAllPending(this.childDied);
		});
	}

	// -- Internal ------------------------------------------------------------

	private writeControlState(target: string, value: Record<string, unknown>): void {
		const temporal = `${target}.tmp`;
		writeFileSync(temporal, `${JSON.stringify(value)}\n`, "utf8");
		renameSync(temporal, target);
	}

	private handleRpcLine(line: string): void {
		try {
			writeFileSync(this.paths.rpcJournal, `${line}\n`, { flag: "a", encoding: "utf8" });
		} catch {
			// Journaling must never break the driver.
		}
		let event: FixtureEvent;
		try {
			event = JSON.parse(line) as FixtureEvent;
		} catch {
			return;
		}
		this.sessionEvents.push(event);
		if (event.type === "response" && typeof event.id === "string") {
			const pendingEntry = this.pending.get(event.id);
			if (!pendingEntry) return;
			this.pending.delete(event.id);
			clearTimeout(pendingEntry.timer);
			if (event.success === true) pendingEntry.resolve(event as unknown as RpcResponse);
			else {
				pendingEntry.reject(new Error(`RPC ${String(event.command)} rejected: ${JSON.stringify(event.error ?? {})}`));
			}
		}
	}

	private rejectAllPending(reason: string): void {
		for (const pendingEntry of this.pending.values()) {
			clearTimeout(pendingEntry.timer);
			pendingEntry.reject(new Error(`RPC connection lost: ${reason}\nstderr:\n${this.stderrTail}`));
		}
		this.pending.clear();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

function firstExit(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		child.once("close", () => resolve());
	});
}

/** The repo-root-relative location of the fixture assets, valid from compiled test output. */
function resolveFixtureAsset(fileName: string): string {
	// dist-test/tests/pi-native-mcp-fixture.js -> repo root is two levels up;
	// src-side runs (repo root) are one level up.
	const compiledRoot = resolvePath(__dirname, "..", "..");
	const sourceRoot = resolvePath(__dirname, "..");
	for (const root of [compiledRoot, sourceRoot]) {
		const candidate = join(root, "tests", "fixtures", fileName);
		if (existsSync(candidate)) return candidate;
	}
	return join(sourceRoot, "tests", "fixtures", fileName);
}