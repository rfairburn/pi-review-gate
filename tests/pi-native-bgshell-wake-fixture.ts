/**
 * Real-host fixture for the background-shell exit-wake regression (issue
 * #281). Spawns an actual `pi --mode rpc` session with the candidate
 * pi-review-gate extension plus a scripted-model probe
 * (tests/fixtures/pi-native-bgshell-probe.cjs), in a hermetic scratch tree —
 * same conventions as tests/pi-native-mcp-fixture.ts:
 *
 * - installed Pi 1.x resolved through `resolvePiHost` (PI_REVIEW_GATE_INSTALLED_AGENT
 *   pins it); missing prerequisites skip, hard-failing under
 *   PI_REVIEW_GATE_REQUIRE_PI_HOST=1;
 * - synthetic HOME / PI_CODING_AGENT_DIR; no inherited PI_REVIEW_GATE_*
 *   variables and no provider API keys (the scripted provider is registered
 *   in-process by the probe);
 * - a git-initialized scratch project so the gate's checkpoint baseline has a
 *   repository to arm against;
 * - the candidate's zero-model gate config with `execution.deferredPiTools`
 *   disabled, so the background Shell* tools are launch-active exactly like
 *   the production sessions in which issue #281 was observed (with deferred
 *   tools on, ShellStart is only reachable through tool_search and never
 *   directly callable — a different surface than the reported failure).
 *
 * The probe journals every model request's transcript tail to scratch, so a
 * consumer can prove what the OWNING SESSION'S model actually saw — including
 * custom wake messages — without any polling tool call.
 */

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  nodeFloorSatisfied,
  resolvePiHost,
  type PiHostResolution,
} from "./pi-native-mcp-fixture";

export const BG_SHELL_WAKE_PROVIDER_ID = "prg-fixture";
export const BG_SHELL_WAKE_MODEL_ID = "driven";

const PROBE_ENTRY_CANDIDATES = [
  resolvePath(__dirname, "fixtures", "pi-native-bgshell-probe.cjs"),
  resolvePath(process.cwd(), "tests", "fixtures", "pi-native-bgshell-probe.cjs"),
];

export interface BgShellWakeFixturePaths {
	scratch: string;
	project: string;
	agentDir: string;
	sessionsDir: string;
	stateDir: string;
	turnScript: string;
	probeJournal: string;
}

export interface BgShellWakeFixtureOptions {
	/**
	 * Candidate extension entry loaded beside the probe (default
	 * PI_REVIEW_GATE_CANDIDATE_ENTRY or dist/src/index.js — the existing
	 * real-host convention).
	 */
	candidateEntry?: string | null;
	/**
	 * Written to `<scratch agent dir>/review-gate.json`. Defaults to the
	 * zero-model enabled config with deferred tools disabled (see module
	 * docs); `null` skips the file.
	 */
	gateConfig?: object | null;
	/** Parent dir for the scratch tree. Default os.tmpdir() (outside the repo). */
	scratchParent?: string;
	timeouts?: {
		/** Per-RPC-request and startup wait budget. Default 30 s. */
		requestMs?: number;
	};
}

export const BG_SHELL_WAKE_GATE_CONFIG = {
	enabled: true,
	review: { activeReviewers: [] },
	externalAgents: {},
	execution: { deferredPiTools: false, workerResources: {}, routes: { execute: [], research: [] } },
} as const;

export class BgShellWakeFixtureError extends Error {}

function resolveCandidateEntry(options: Pick<BgShellWakeFixtureOptions, "candidateEntry">): string | undefined {
	if (options.candidateEntry === null) return undefined;
	if (options.candidateEntry !== undefined) return resolvePath(options.candidateEntry);
	const fromEnv = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY;
	if (fromEnv) return resolvePath(fromEnv);
	return resolvePath(process.cwd(), join("dist", "src", "index.js"));
}

function probeEntry(): string {
	const found = PROBE_ENTRY_CANDIDATES.find((candidate) => existsSync(candidate));
	if (!found) throw new BgShellWakeFixtureError(`probe entry not found: ${PROBE_ENTRY_CANDIDATES.join(" or ")}`);
	return found;
}

interface JournalEntry extends Record<string, unknown> {
	ts: number;
	event: string;
	requestIndex?: number;
	transcriptTail?: Array<{ role: string; customType?: string; preview?: string }>;
	preview?: string;
	customType?: string;
}

/**
 * Create (but do not start) the fixture. Throws BgShellWakeFixtureError with
 * every prerequisite problem when the host or candidate is unavailable.
 */
export function createBgShellWakeFixture(options: BgShellWakeFixtureOptions = {}): BgShellWakeFixture {
	if (!nodeFloorSatisfied()) {
		throw new BgShellWakeFixtureError(
			`Node ${process.version} is below the fixture's Node floor (declared by pi-coding-agent 1.0.0 engines)`,
		);
	}
	const host = resolvePiHost();
	const candidateEntry = resolveCandidateEntry(options);
	if (candidateEntry !== undefined && !existsSync(candidateEntry)) {
		throw new BgShellWakeFixtureError(`candidate extension entry not found: ${candidateEntry}`);
	}
	return new BgShellWakeFixture(host, options, candidateEntry);
}

export class BgShellWakeFixture {
	readonly paths: BgShellWakeFixturePaths;

	private child: ChildProcess | undefined;
	private disposed = false;
	private stdoutBuffer = "";
	private stderrTail = "";
	private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
	private nextRequestId = 1;

	constructor(
		private host: PiHostResolution,
		private options: BgShellWakeFixtureOptions,
		private candidateEntry?: string,
	) {
		const scratch = join(options.scratchParent ?? tmpdir(), `prg-bgshell-wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		this.paths = {
			scratch,
			project: join(scratch, "project"),
			agentDir: join(scratch, "agent"),
			sessionsDir: join(scratch, "sessions"),
			stateDir: join(scratch, "state"),
			turnScript: join(scratch, "state", "turn-script.json"),
			probeJournal: join(scratch, "state", "probe-journal.jsonl"),
		};
	}

	private get requestTimeoutMs(): number {
		return this.options.timeouts?.requestMs ?? 30_000;
	}

	/** Create the scratch tree (hermetic git repo + gate config) and spawn pi.
	 *  Startup failures leave no child or scratch behind: callers register
	 *  dispose via t.after before calling start. */
	async start(initialSteps: Array<Record<string, unknown>>): Promise<void> {
		if (this.child && this.child.exitCode === null) {
			throw new BgShellWakeFixtureError("fixture already started");
		}
		const { project, agentDir, sessionsDir, stateDir } = this.paths;
		for (const dir of [project, join(project, ".pi"), agentDir, sessionsDir, stateDir]) {
			await mkdir(dir, { recursive: true });
		}
		// The gate arms runs against a git checkpoint baseline; give it a repo.
		await this.prepareProjectRepo();

		const gateConfig = this.options.gateConfig === null ? undefined : this.options.gateConfig ?? BG_SHELL_WAKE_GATE_CONFIG;
		if (gateConfig !== undefined) {
			await writeFile(join(agentDir, "review-gate.json"), `${JSON.stringify(gateConfig, null, "\t")}\n`, "utf8");
		}
		this.setTurnScriptSync(initialSteps);

		const args = [
			this.host.cliEntry,
			"--mode", "rpc",
			"--session-dir", this.paths.sessionsDir,
			"--offline",
			"--no-context-files",
			"--no-skills",
			"--no-themes",
			"--no-prompt-templates",
			"--approve",
		];
		if (this.candidateEntry) args.push("--extension", this.candidateEntry);
		args.push("--extension", probeEntry());

		// Hermetic environment: no inherited PI_REVIEW_GATE_* variables (the
		// candidate must run against the scratch agent dir, never a live
		// config) and no provider API keys. The only fixture variables are the
		// declared synthetic state locations.
		const env: NodeJS.ProcessEnv = {};
		for (const key of ["PATH", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP"]) {
			if (process.env[key] !== undefined) env[key] = process.env[key];
		}
		env.HOME = this.paths.scratch;
		env.USERPROFILE = this.paths.scratch;
		env.PI_CODING_AGENT_DIR = this.paths.agentDir;
		env.PRG_FIXTURE_AGENT_DIR = this.host.agentDir;
		env.PRG_FIXTURE_STATE_DIR = this.paths.stateDir;

		const child = spawn(process.execPath, args, {
			cwd: this.paths.project,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});
		this.child = child;
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.stderrTail = `${this.stderrTail}${chunk}`.slice(-12_000);
		});
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			this.stdoutBuffer += chunk;
			for (;;) {
				const newline = this.stdoutBuffer.indexOf("\n");
				if (newline < 0) break;
				const line = this.stdoutBuffer.slice(0, newline).trim();
				this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
				if (!line) continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					continue; // non-JSON noise
				}
				const response = parsed as { id?: string; success?: boolean; error?: string; data?: unknown };
				if (typeof response.id !== "string") continue;
				const entry = this.pending.get(response.id);
				if (!entry) continue;
				this.pending.delete(response.id);
				clearTimeout(entry.timer);
				if (response.success === false) {
					entry.reject(new Error(`RPC rejected: ${response.error ?? "unknown error"}\nstderr:\n${this.stderrTail}`));
				} else {
					entry.resolve(response.data);
				}
			}
		});

		// Wait for the probe to select the scripted model before the caller may
		// prompt.
		const deadline = Date.now() + this.requestTimeoutMs;
		for (;;) {
			if (this.journal().some((entry) => entry.event === "auto_model_selected")) return;
			if (child.exitCode !== null) {
				throw new BgShellWakeFixtureError(
					`pi child exited early (${child.exitCode}) before model selection; stderr:\n${this.stderrTail}`,
				);
			}
			if (Date.now() >= deadline) {
				throw new BgShellWakeFixtureError(
					`scripted model was never selected within ${this.requestTimeoutMs} ms; journal:\n${JSON.stringify(this.journal())}\nstderr:\n${this.stderrTail}`,
				);
			}
			await delay(100);
		}
	}

	/** Rewrite the probe's turn script (one step per model request). */
	async setTurnScript(steps: Array<Record<string, unknown>>): Promise<void> {
		await writeFile(this.paths.turnScript, JSON.stringify({ steps }, null, "\t"), "utf8");
	}

	private setTurnScriptSync(steps: Array<Record<string, unknown>>): void {
		writeFileSync(this.paths.turnScript, `${JSON.stringify({ steps }, null, "\t")}\n`, "utf8");
	}

	/** Raw RPC request over the native `pi --mode rpc` stdin protocol. */
	async rpc(type: string, fields: Record<string, unknown> = {}): Promise<unknown> {
		const child = this.child;
		if (!child || child.exitCode !== null) {
			throw new BgShellWakeFixtureError(`RPC ${type} failed: pi child is not running\nstderr:\n${this.stderrTail}`);
		}
		const id = `prg-bgshell-wake-${this.nextRequestId++}`;
		return await new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new BgShellWakeFixtureError(`RPC ${type} timed out after ${this.requestTimeoutMs} ms\nstderr:\n${this.stderrTail}`));
			}, this.requestTimeoutMs);
			timer.unref?.();
			this.pending.set(id, { resolve, reject, timer });
			try {
				child.stdin?.write(`${JSON.stringify({ id, type, ...fields })}\n`);
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(new BgShellWakeFixtureError(`RPC ${type} failed to write: ${String(error)}\nstderr:\n${this.stderrTail}`));
			}
		});
	}

	/** Send an ordinary user prompt; resolves with the response `data`. */
	async prompt(message: string): Promise<unknown> {
		return await this.rpc("prompt", { message });
	}

	/** Abort the active agent run through the native RPC seam. */
	async abort(): Promise<unknown> {
		return await this.rpc("abort");
	}

	/**
	 * Synthetic project repository, hermetic by construction (same pattern as
	 * fixtureGitEnvironment in tests/pi-native-tools-lifecycle.test.ts):
	 * allowlisted subprocess environment that never passes through the caller's
	 * GIT_* overrides (GIT_DIR, GIT_WORK_TREE, indexes, object dirs, tracing,
	 * or config), an empty scratch global config with system config disabled,
	 * explicit empty hooks/template dirs so no user hook or template runs, and
	 * signing explicitly off. The commit cannot touch any caller-selected
	 * repository or identity.
	 */
	private async prepareProjectRepo(): Promise<void> {
		const { project, scratch } = this.paths;
		const hooksPath = join(scratch, "git-hooks");
		const templatePath = join(scratch, "git-template");
		const globalConfig = join(scratch, "empty-gitconfig");
		const xdgConfig = join(scratch, "xdg-config");
		await Promise.all([
			mkdir(hooksPath, { recursive: true }),
			mkdir(templatePath, { recursive: true }),
			mkdir(xdgConfig, { recursive: true }),
			writeFile(globalConfig, "", "utf8"),
		]);
		const env: NodeJS.ProcessEnv = {};
		for (const name of ["PATH", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"]) {
			if (process.env[name] !== undefined) env[name] = process.env[name];
		}
		Object.assign(env, {
			HOME: scratch,
			USERPROFILE: scratch,
			XDG_CONFIG_HOME: xdgConfig,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: globalConfig,
		});
		const git = (args: string[]): void => {
			execFileSync("git", args, { cwd: project, env, stdio: "ignore", timeout: 10_000 });
		};
		git(["-c", `core.hooksPath=${hooksPath}`, "init", "--quiet", `--template=${templatePath}`]);
		await writeFile(join(project, "README.md"), "# prg bg-shell wake fixture project\n", "utf8");
		git(["-c", `core.hooksPath=${hooksPath}`, "add", "README.md"]);
		git([
			"-c", "commit.gpgsign=false",
			"-c", `core.hooksPath=${hooksPath}`,
			"-c", "user.name=PRG BG-Shell Fixture",
			"-c", "user.email=prg-bgshell-fixture@example.invalid",
			"commit", "--no-gpg-sign", "--quiet", "-m", "initial",
		]);
	}

	/** Poll until `fn()` is true or the deadline passes. */
	async waitFor(fn: () => boolean, timeoutMs = 30_000, intervalMs = 150): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (fn()) return true;
			await delay(intervalMs);
		}
		return fn();
	}

	/** The probe's JSONL journal (run/message boundaries, model requests). */
	journal(): JournalEntry[] {
		if (!existsSync(this.paths.probeJournal)) return [];
		return readFileSync(this.paths.probeJournal, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line) as JournalEntry;
				} catch {
					return null;
				}
			})
			.filter((entry): entry is JournalEntry => entry !== null);
	}

	/** All journalled model requests, in order. */
	modelRequests(): JournalEntry[] {
		return this.journal().filter((entry) => entry.event === "model_request");
	}

	/**
	 * True when a model request's transcript tail carries the background-shell
	 * completion display — i.e. the OWNING SESSION'S model saw the exit wake
	 * without any polling tool call. `afterTs` bounds it to requests made after
	 * the job had exited.
	 */
	wakeSeenInRequest(entry: JournalEntry, afterTs?: number): boolean {
		if (afterTs !== undefined && entry.ts < afterTs) return false;
		const tail = entry.transcriptTail ?? [];
		return tail.some((message) =>
			message.role !== "toolResult"
			&& /background job/.test(message.preview ?? "")
			&& /—\s*exited \d+/.test(message.preview ?? ""));
	}

	/**
	 * True when the session transcript on disk contains the persisted custom
	 * wake message (customType `pi-review-bg-shell`) for a completed job.
	 */
	async wakePersistedInSession(): Promise<boolean> {
		const files = await readdir(this.paths.sessionsDir);
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const text = await readFile(join(this.paths.sessionsDir, file), "utf8");
			if (text.includes("pi-review-bg-shell") && /exited \d+/.test(text)) return true;
		}
		return false;
	}

	get stderr(): string {
		return this.stderrTail;
	}

	/** Terminate the pi child, close its stdio, and remove the scratch tree
	 *  unless retained. Idempotent; safe to register via t.after before start.
	 *  Startup failures (after spawn) must not leak a live child or open stdio
	 *  that would keep the test process alive. */
	async dispose(options: { retainScratch?: boolean } = {}): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		const child = this.child;
		if (child && child.exitCode === null) {
			try {
				child.kill("SIGTERM");
			} catch {
				// Already gone.
			}
			const exited = await Promise.race([
				new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
				delay(10_000).then(() => false),
			]);
			if (!exited) {
				try {
					child.kill("SIGKILL");
				} catch {
					// Gone.
				}
				await new Promise<void>((resolve) => child.once("exit", () => resolve()));
			}
		}
		// Close stdio handles even if the child is already gone: open pipes can
		// otherwise keep the test process alive after a failure.
		for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
			try {
				stream?.destroy();
			} catch {
				// Already closed.
			}
		}
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new BgShellWakeFixtureError("fixture disposed"));
		}
		this.pending.clear();
		if (!options.retainScratch) {
			await rm(this.paths.scratch, { recursive: true, force: true });
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Convenience for tests: the dirname of this fixture (for asset paths). */
export const BG_SHELL_WAKE_FIXTURE_DIR = dirname(__filename);
