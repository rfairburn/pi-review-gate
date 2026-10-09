import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	__test as instanceTestSeam,
	InstanceManager,
	type InstancePty,
	type InstanceSpawnDescriptor,
	type InstanceStatusRegistration,
	type InstanceStatusUpdate,
	type StatusRegistrar,
} from "../src/session-host/instances";
import { SESSION_HOST_BOOTSTRAP_ENV } from "../src/session-host/launch";
import { ProfileRegistry } from "../src/session-host/profiles";
import type { StatusShutdownResult } from "../src/session-host/broker";

// Synthetic manager-only coverage: inert launch files, fixture-local helper
// stubs, fake status controls, and fake PTYs. No native PTY addon or Pi runtime.
const PRIVATE_ROOT = join(process.cwd(), "node_modules", ".worker-private-manager-shutdown");
const SYNTHETIC_STARTUP_OPTIONS_HELPER = '"use strict";\nmodule.exports = { assertSessionHostStartupOptions(args, env) { if (!Array.isArray(args) || args.length !== 0) throw new Error("synthetic launch accepts no argv"); if (env?.PI_CODING_AGENT_SESSION_DIR) throw new Error("synthetic launch rejects redirected session storage"); } };\n';
const SYNTHETIC_LAUNCHER_HELPER = '"use strict";\nmodule.exports = { renameIntoPlaceWithContentionRetry(rename) { rename(); return { published: true, attempts: 1 }; } };\n';

interface RegistrarEntry {
	readonly instanceId: string;
	readonly handlers: { onStatus(update: InstanceStatusUpdate): void; onDisconnect(): void };
	readonly bootstrap: InstanceStatusRegistration["bootstrap"];
	pty?: FakePty;
	latestNativeSession: InstanceStatusUpdate["nativeSession"];
	shutdownCalls: number;
	released: boolean;
}

type ShutdownHandler = (entry: RegistrarEntry) => Promise<StatusShutdownResult>;

class FakeRegistrar implements StatusRegistrar {
	readonly entries: RegistrarEntry[] = [];
	shutdownHandler?: ShutdownHandler;
	omitShutdown = false;

	register(instanceId: string, handlers: RegistrarEntry["handlers"]): InstanceStatusRegistration {
		const entry: RegistrarEntry = {
			instanceId,
			handlers,
			bootstrap: {
				version: 1,
				socketPath: `/synthetic/${instanceId}.sock`,
				token: `synthetic-token-${instanceId}`,
				instanceId,
				generation: `synthetic-generation-${instanceId}`,
			},
			latestNativeSession: null,
			shutdownCalls: 0,
			released: false,
		};
		this.entries.push(entry);
		const registration: InstanceStatusRegistration = {
			bootstrap: entry.bootstrap,
			release: () => { entry.released = true; },
		};
		if (!this.omitShutdown) {
			registration.shutdown = () => {
				entry.shutdownCalls += 1;
				return this.shutdownHandler?.(entry)
					?? Promise.resolve({ requestId: "synthetic-unavailable", status: "unavailable" });
			};
		}
		return registration;
	}

	emitStatus(entry: RegistrarEntry, update: InstanceStatusUpdate): void {
		if (entry.released) return;
		if (Object.prototype.hasOwnProperty.call(update, "nativeSession")) {
			entry.latestNativeSession = update.nativeSession;
		}
		entry.handlers.onStatus(update);
	}

	emitDisconnect(entry: RegistrarEntry): void {
		if (!entry.released) entry.handlers.onDisconnect();
	}

	emitAfterRelease(entry: RegistrarEntry, update: InstanceStatusUpdate): void {
		entry.handlers.onStatus(update);
	}

	entryFor(id: string): RegistrarEntry {
		const entry = this.entries.find((candidate) => candidate.instanceId === id);
		assert.ok(entry, `missing registration for ${id}`);
		return entry;
	}
}

class FakePty implements InstancePty {
	static #nextPid = 50_000;
	readonly pid = ++FakePty.#nextPid;
	readonly cols: number;
	readonly rows: number;
	readonly killSignals: (string | undefined)[] = [];
	readonly killArgumentCounts: number[] = [];
	readonly killTimestamps: number[] = [];
	readonly #dataListeners: ((data: string) => void)[] = [];
	readonly #exitListeners: ((event: { exitCode: number; signal?: number }) => void)[] = [];
	readonly #errorListeners: ((error: Error) => void)[] = [];
	exited = false;
	exitsOnSignal: "SIGTERM" | "SIGKILL" | "none" = "none";
	resizeError?: Error;
	killError?: Error;

	constructor(readonly descriptor: InstanceSpawnDescriptor) {
		this.cols = descriptor.cols;
		this.rows = descriptor.rows;
	}

	onData(listener: (data: string) => void): { dispose(): void } {
		this.#dataListeners.push(listener);
		return { dispose: () => this.#remove(this.#dataListeners, listener) };
	}

	onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
		this.#exitListeners.push(listener);
		return { dispose: () => this.#remove(this.#exitListeners, listener) };
	}

	on(eventName: "error", listener: (error: Error) => void): void {
		assert.equal(eventName, "error");
		this.#errorListeners.push(listener);
	}

	removeListener(eventName: "error", listener: (error: Error) => void): void {
		assert.equal(eventName, "error");
		this.#remove(this.#errorListeners, listener);
	}

	write(_data: string | Buffer): void {}
	resize(_columns: number, _rows: number): void {
		if (this.resizeError) throw this.resizeError;
	}
	pause(): void {}
	resume(): void {}

	kill(signal?: string): void {
		this.killTimestamps.push(Date.now());
		this.killSignals.push(signal);
		this.killArgumentCounts.push(arguments.length);
		if (this.killError) throw this.killError;
		if (signal && !this.exited && this.exitsOnSignal === signal) this.emitExit(0, signal === "SIGKILL" ? 9 : 15);
	}

	emitExit(exitCode: number, signal?: number): void {
		if (this.exited) return;
		this.exited = true;
		for (const listener of [...this.#exitListeners]) listener({ exitCode, signal });
	}

	#remove<T>(list: T[], value: T): void {
		const index = list.indexOf(value);
		if (index >= 0) list.splice(index, 1);
	}
}

interface Harness {
	readonly root: string;
	readonly rootIdentity: { dev: number; ino: number };
	readonly workspace: string;
	readonly workspace2: string;
	readonly registrar: FakeRegistrar;
	readonly profileRegistry: ProfileRegistry;
	readonly spawned: FakePty[];
	readonly manager: InstanceManager;
}

function makeHarness(label: string): Harness {
	const modulesStat = lstatSync(join(process.cwd(), "node_modules"));
	assert.ok(modulesStat.isDirectory() && !modulesStat.isSymbolicLink(), "node_modules must be a real local directory");
	try {
		const privateStat = lstatSync(PRIVATE_ROOT);
		assert.ok(privateStat.isDirectory() && !privateStat.isSymbolicLink(), "the private fixture root must be a real directory");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		mkdirSync(PRIVATE_ROOT, { mode: 0o700 });
	}
	const privateScripts = join(PRIVATE_ROOT, "scripts");
	try {
		const scriptsStat = lstatSync(privateScripts);
		assert.ok(scriptsStat.isDirectory() && !scriptsStat.isSymbolicLink(), "private scripts fixture must be a real directory");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		mkdirSync(privateScripts, { mode: 0o700 });
	}
	writeFileSync(join(privateScripts, "session-host-startup-options.cjs"), SYNTHETIC_STARTUP_OPTIONS_HELPER, "utf8");
	writeFileSync(join(privateScripts, "pi-review-gate-launcher.cjs"), SYNTHETIC_LAUNCHER_HELPER, "utf8");
	const root = realpathSync(mkdtempSync(join(PRIVATE_ROOT, `${label}-`)));
	const rootStat = lstatSync(root);
	const rootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
	const packageRoot = join(root, "package");
	mkdirSync(join(packageRoot, "dist", "src", "session-host"), { recursive: true });
	mkdirSync(join(packageRoot, "scripts"), { recursive: true });
	writeFileSync(join(packageRoot, "dist", "src", "index.js"), "// inert synthetic fixture\n", "utf8");
	writeFileSync(join(packageRoot, "dist", "src", "session-host", "reporter.js"), "// inert synthetic fixture\n", "utf8");
	writeFileSync(join(packageRoot, "dist", "src", "session-host", "bootstrap-preload.js"), "// inert synthetic fixture\n", "utf8");
	for (const [skill, files] of [
		["pi-review-gate-orchestrator", ["SKILL.md", "references/recovery.md"]],
		["pi-review-gate-execution", ["SKILL.md"]],
		["pi-review-gate-research", ["SKILL.md"]],
	] as const) {
		for (const file of files) {
			const path = join(packageRoot, "skills", skill, ...file.split("/"));
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, `${skill}/${file}\n`, "utf8");
		}
	}
	const piExecutable = join(root, "bin", "inert-pi");
	mkdirSync(join(root, "bin"), { recursive: true });
	writeFileSync(piExecutable, "#!/usr/bin/env node\n// inert synthetic fixture\n", "utf8");
	chmodSync(piExecutable, 0o700);
	const workspace = join(root, "workspace-one");
	const workspace2 = join(root, "workspace-two");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(workspace2, { recursive: true });
	const registrar = new FakeRegistrar();
	const stateRoot = join(root, "state");
	mkdirSync(stateRoot, { recursive: true });
	const profileRegistry = new ProfileRegistry({ stateRoot });
	const spawned: FakePty[] = [];
	const env = { ...process.env };
	delete env.PI_REVIEW_GATE_RUNTIME_ROLE;
	delete env.PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG;
	delete env.PI_CODING_AGENT_SESSION_DIR;
	const manager = new InstanceManager({
		packageRoot,
		piExecutable,
		statusRegistrar: registrar,
		nativeSetup: false,
		profileRegistry,
		args: [],
		env,
		ptyFactory: (descriptor) => {
			const pty = new FakePty(descriptor);
			spawned.push(pty);
			const entry = registrar.entries.at(-1);
			assert.ok(entry, "registration precedes PTY spawn");
			assert.ok(descriptor.env[SESSION_HOST_BOOTSTRAP_ENV]);
			entry.pty = pty;
			return pty;
		},
	});
	return { root, rootIdentity, workspace, workspace2, registrar, profileRegistry, spawned, manager };
}

function removeSuccessfulHarness(harness: Harness): void {
	const current = lstatSync(harness.root);
	if (current.isDirectory() && current.dev === harness.rootIdentity.dev && current.ino === harness.rootIdentity.ino) {
		removeOwnedFixtureTree(harness.root);
	}
}

/** Remove only this test-created tree, pruning `.terraform` before descent and never following symlinks. */
function removeOwnedFixtureTree(path: string): void {
	const current = lstatSync(path);
	if (current.isDirectory() && !current.isSymbolicLink()) {
		for (const name of readdirSync(path)) {
			if (name === ".terraform") continue;
			removeOwnedFixtureTree(join(path, name));
		}
		try {
			rmdirSync(path);
		} catch {
			// Retain a directory if an excluded or otherwise unknown entry remains.
		}
		return;
	}
	unlinkSync(path);
}

function row(manager: InstanceManager, id: string) {
	const result = manager.list().find((item) => item.id === id);
	assert.ok(result, `missing manager row ${id}`);
	return result;
}

function status(sessionId = "native-session-one", epoch = 1): InstanceStatusUpdate {
	return {
		busy: true,
		pendingInput: false,
		inputSurface: true,
		activity: ["synthetic activity"],
		nativeSession: { sessionId, epoch, name: `Session ${epoch}` },
	};
}

function requested(requestId = "synthetic-request"): StatusShutdownResult {
	return { requestId, status: "requested" };
}

test("authenticated public shutdown acknowledgement is forwarded but synchronous PTY exit remains the truth", async () => {
	const harness = makeHarness("public-exit");
	let success = false;
	try {
		harness.registrar.shutdownHandler = async (entry) => {
			assert.deepEqual(entry.latestNativeSession, status().nativeSession, "the request uses the active registration's observed session");
			entry.pty?.emitExit(12, 15);
			return requested();
		};
		const id = await harness.manager.create({ workspace: harness.workspace });
		const entry = harness.registrar.entryFor(id);
		harness.registrar.emitStatus(entry, status());
		const result = await harness.manager.shutdown({ graceMs: 500, killMs: 100 });
		assert.deepEqual(result, { forcedIds: [], remainingIds: [] });
		assert.equal(entry.shutdownCalls, 1, "the owned registration's asynchronous control is forwarded once");
		assert.deepEqual(harness.spawned[0]?.killSignals, [], "public graceful exit needs no PTY signal");
		assert.equal(row(harness.manager, id).lifecycle, "exited");
		assert.equal(row(harness.manager, id).exitCode, 12);
		assert.equal(entry.released, true, "only the actual PTY exit releases the registration");
		await harness.manager.dispose();
		assert.equal(harness.manager.hasLiveProcesses(), false);
		success = true;
	} finally {
		if (success) removeSuccessfulHarness(harness);
	}
});

test("requested acknowledgement without owned exit escalates truthfully and retains registration until exit", async () => {
	const harness = makeHarness("ack-without-exit");
	let success = false;
	try {
		harness.registrar.shutdownHandler = async () => requested();
		const id = await harness.manager.create({ workspace: harness.workspace });
		const entry = harness.registrar.entryFor(id);
		harness.registrar.emitStatus(entry, status());
		const result = await harness.manager.shutdown({ graceMs: 25, killMs: 10 });
		assert.deepEqual(result, { forcedIds: [id], remainingIds: [id] });
		assert.deepEqual(
			harness.spawned[0]?.killSignals,
			process.platform === "win32" ? [undefined] : ["SIGKILL"],
			"a request acknowledgement suppresses graceful signals but not forced escalation",
		);
		assert.equal(row(harness.manager, id).lifecycle, "alive");
		assert.equal(row(harness.manager, id).hasLiveProcess, true);
		assert.equal(entry.released, false, "acknowledgement never releases the live owner's registration");
		assert.throws(
			() => harness.profileRegistry.prepare({ workspace: harness.workspace, profile: row(harness.manager, id).agentDir }),
			/already has an active admission/,
		);
		harness.spawned[0]?.emitExit(0, 9);
		assert.equal(entry.released, true, "a later actual exit releases the owner");
		await harness.manager.dispose();
		assert.equal(harness.manager.hasLiveProcesses(), false);
		success = true;
	} finally {
		if (success) removeSuccessfulHarness(harness);
	}
});

test("error lifecycle rows keep live ownership until their public shutdown request is followed by actual exit", async () => {
	const harness = makeHarness("error-live-stop");
	let success = false;
	let acknowledge: ((value: StatusShutdownResult) => void) | undefined;
	try {
		harness.registrar.shutdownHandler = () => new Promise<StatusShutdownResult>((resolve) => { acknowledge = resolve; });
		const id = await harness.manager.create({ workspace: harness.workspace });
		const entry = harness.registrar.entryFor(id);
		harness.registrar.emitStatus(entry, status());
		const pty = harness.spawned[0];
		assert.ok(pty);
		pty.resizeError = new Error("synthetic resize failure");
		harness.manager.resize(100, 32);
		assert.equal(row(harness.manager, id).lifecycle, "error");
		assert.equal(row(harness.manager, id).hasLiveProcess, true, "an error badge does not erase the owned live handle");
		assert.equal(entry.shutdownCalls, 1, "the error stop uses its owned authenticated registration");
		assert.equal(entry.released, false);
		assert.deepEqual(pty.killSignals, []);
		assert.ok(acknowledge);
		acknowledge(requested("error-row-ack"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(row(harness.manager, id).lifecycle, "error", "accepted request is not an exit state");
		assert.equal(row(harness.manager, id).hasLiveProcess, true);
		assert.equal(entry.released, false);
		pty.emitExit(31, 15);
		assert.equal(row(harness.manager, id).lifecycle, "error", "the operation error remains visible after real exit");
		assert.equal(row(harness.manager, id).hasLiveProcess, false);
		assert.equal(row(harness.manager, id).exitCode, 31);
		assert.equal(entry.released, true, "actual exit releases the registration");
		assert.deepEqual(await harness.manager.shutdown({ graceMs: 10, killMs: 10 }), { forcedIds: [], remainingIds: [] });
		await harness.manager.dispose();
		success = true;
	} finally {
		if (success) removeSuccessfulHarness(harness);
	}
});

test("POSIX shutdown-control absence, failures, and hangs use only the bounded owned SIGTERM/SIGKILL fallback", { skip: process.platform === "win32" ? "POSIX signal policy is not faked on Windows" : false }, async () => {
	instanceTestSeam.setShutdownPlatform("linux");
	try {
		for (const mode of ["absent", "unavailable", "throw", "reject", "invalid", "hang"] as const) {
			const harness = makeHarness(`fallback-${mode}`);
			let success = false;
			let lateResolve: ((value: StatusShutdownResult) => void) | undefined;
			try {
				harness.registrar.omitShutdown = mode === "absent";
				harness.registrar.shutdownHandler = () => {
					switch (mode) {
						case "absent":
							return Promise.resolve({ requestId: "unused", status: "unavailable" });
						case "unavailable":
							return Promise.resolve({ requestId: "unavailable", status: "unavailable" });
						case "throw":
							throw new Error("synthetic sync adapter failure");
						case "reject":
							return Promise.reject(new Error("synthetic async adapter failure"));
						case "invalid":
							return Promise.resolve({ status: "requested" } as StatusShutdownResult);
						case "hang":
							return new Promise<StatusShutdownResult>((resolve) => { lateResolve = resolve; });
						default:
							throw new Error("unexpected synthetic control scenario");
					}
				};
				const id = await harness.manager.create({ workspace: harness.workspace });
				const entry = harness.registrar.entryFor(id);
				const graceMs = mode === "hang" ? 300 : 25;
				const startedAt = Date.now();
				const result = await harness.manager.shutdown({ graceMs, killMs: 10 });
				assert.ok(Date.now() - startedAt < 1000, "a never-settling request cannot extend the bounded ladder");
				assert.deepEqual(result, { forcedIds: [id], remainingIds: [id] });
				assert.deepEqual(harness.spawned[0]?.killSignals, ["SIGTERM", "SIGKILL"]);
				if (mode === "hang") {
					const [sigtermAt, sigkillAt] = harness.spawned[0]?.killTimestamps ?? [];
					assert.ok(sigtermAt !== undefined && sigkillAt !== undefined);
					assert.ok(sigkillAt - sigtermAt >= 50, "POSIX fallback receives useful time before SIGKILL within the one grace window");
				}
				assert.equal(entry.shutdownCalls, mode === "absent" ? 0 : 1);
				assert.equal(row(harness.manager, id).lifecycle, "alive");
				assert.equal(entry.released, false, "failed controls do not release a still-live owner");
				if (mode === "hang") {
					assert.ok(lateResolve, "the request remains pending past the stop deadline");
					lateResolve(requested("late-ack"));
					await Promise.resolve();
					await new Promise<void>((resolve) => setImmediate(resolve));
					assert.equal(row(harness.manager, id).lifecycle, "alive", "a late acknowledgement cannot become an exit");
					assert.equal(entry.released, false);
				}
				harness.spawned[0]?.emitExit(0, 9);
				await harness.manager.dispose();
				assert.equal(harness.manager.hasLiveProcesses(), false);
				success = true;
			} finally {
				if (success) removeSuccessfulHarness(harness);
			}
		}
	} finally {
		instanceTestSeam.setShutdownPlatform(undefined);
	}
});

test("injected Windows stop policy never treats PTY SIGTERM as graceful", async () => {
	instanceTestSeam.setShutdownPlatform("win32");
	let harness: Harness | undefined;
	let success = false;
	try {
		harness = makeHarness("windows-policy");
		harness.registrar.shutdownHandler = async () => ({ requestId: "unavailable", status: "unavailable" });
		const id = await harness.manager.create({ workspace: harness.workspace });
		const entry = harness.registrar.entryFor(id);
		const pty = harness.spawned[0];
		assert.ok(pty);
		pty.killError = new Error("synthetic unsupported-signal failure");
		const result = await harness.manager.shutdown({ graceMs: 20, killMs: 10 });
		assert.deepEqual(result, { forcedIds: [id], remainingIds: [id] });
		assert.deepEqual(pty.killSignals, [undefined], "Windows force uses no unsupported signal argument");
		assert.deepEqual(pty.killArgumentCounts, [0], "the exact owned handle receives kill() with no arguments");
		assert.equal(row(harness.manager, id).lifecycle, "alive");
		assert.equal(entry.released, false);
		pty.emitExit(0, 9);
		await harness.manager.dispose();
		assert.equal(harness.manager.hasLiveProcesses(), false);
		success = true;
	} finally {
		instanceTestSeam.setShutdownPlatform(undefined);
		if (success && harness) removeSuccessfulHarness(harness);
	}
});

test("disconnect, reloaded metadata, real exit, and a late shutdown acknowledgement preserve lifecycle fences", async () => {
	const harness = makeHarness("reload-and-late-ack");
	let success = false;
	let acknowledge: ((value: StatusShutdownResult) => void) | undefined;
	let requestStarted!: () => void;
	const started = new Promise<void>((resolve) => { requestStarted = resolve; });
	try {
		harness.registrar.shutdownHandler = () => new Promise<StatusShutdownResult>((resolve) => {
			acknowledge = resolve;
			requestStarted();
		});
		const id = await harness.manager.create({ workspace: harness.workspace });
		const entry = harness.registrar.entryFor(id);
		harness.registrar.emitStatus(entry, status("conversation-one", 1));
		const stopping = harness.manager.shutdown({ graceMs: 500, killMs: 10 });
		await started;
		assert.deepEqual(entry.latestNativeSession, status("conversation-one", 1).nativeSession);
		harness.registrar.emitDisconnect(entry);
		assert.equal(row(harness.manager, id).lifecycle, "alive", "reporter disconnect is not PTY exit");
		assert.equal(row(harness.manager, id).hasLiveProcess, true);
		assert.equal(row(harness.manager, id).busy, null);
		assert.equal(entry.released, false);
		harness.registrar.emitStatus(entry, status("conversation-two", 2));
		assert.deepEqual(row(harness.manager, id).nativeSession, status("conversation-two", 2).nativeSession, "a reloaded reporter's newer tuple is observed");
		harness.spawned[0]?.emitExit(23, 15);
		const result = await stopping;
		assert.deepEqual(result, { forcedIds: [], remainingIds: [] });
		assert.equal(row(harness.manager, id).lifecycle, "exited");
		assert.equal(row(harness.manager, id).exitCode, 23);
		assert.deepEqual(harness.spawned[0]?.killSignals, []);
		assert.equal(entry.released, true);
		assert.ok(acknowledge);
		acknowledge(requested("late-after-exit"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(row(harness.manager, id).lifecycle, "exited", "late public completion cannot revise actual PTY truth");
		assert.equal(row(harness.manager, id).exitCode, 23);
		harness.registrar.emitAfterRelease(entry, status("conversation-three", 3));
		assert.deepEqual(row(harness.manager, id).nativeSession, status("conversation-two", 2).nativeSession, "stale metadata after registration release is ignored");
		await harness.manager.dispose();
		success = true;
	} finally {
		if (success) removeSuccessfulHarness(harness);
	}
});

test("concurrent shutdown, create rejection, and dispose share the same public control without premature release", async () => {
	const harness = makeHarness("concurrent-stop-dispose");
	let success = false;
	let acknowledge: ((value: StatusShutdownResult) => void) | undefined;
	let requestStarted!: () => void;
	const started = new Promise<void>((resolve) => { requestStarted = resolve; });
	try {
		harness.registrar.shutdownHandler = () => new Promise<StatusShutdownResult>((resolve) => {
			acknowledge = resolve;
			requestStarted();
		});
		const profile = join(harness.root, "explicit-profile");
		mkdirSync(profile, { recursive: true });
		writeFileSync(join(profile, "review-gate.json"), '{"enabled":true}\n', "utf8");
		const id = await harness.manager.create({ workspace: harness.workspace, profile });
		const entry = harness.registrar.entryFor(id);
		harness.registrar.emitStatus(entry, status());
		const stopping = harness.manager.shutdown({ graceMs: 500, killMs: 100 });
		await started;
		const concurrentStop = harness.manager.shutdown({ graceMs: 1, killMs: 1 });
		const disposing = harness.manager.dispose();
		await assert.rejects(() => harness.manager.create({ workspace: harness.workspace2 }), /shut down/);
		assert.equal(entry.shutdownCalls, 1, "concurrent stop paths share the owned status control");
		assert.equal(entry.released, false, "request acknowledgement is not a release event");
		assert.deepEqual(harness.spawned[0]?.killSignals, []);
		assert.throws(() => harness.profileRegistry.prepare({ workspace: harness.workspace, profile }), /already has an active admission/);
		assert.ok(acknowledge);
		acknowledge(requested("concurrent-ack"));
		assert.equal(entry.released, false, "accepted request still cannot release an admission");
		harness.spawned[0]?.emitExit(0);
		const [first, second] = await Promise.all([stopping, concurrentStop]);
		assert.deepEqual(first, { forcedIds: [], remainingIds: [] });
		assert.deepEqual(second, first);
		await disposing;
		assert.equal(entry.released, true);
		assert.deepEqual(harness.spawned[0]?.killSignals, []);
		const readmitted = harness.profileRegistry.prepare({ workspace: harness.workspace, profile });
		readmitted.release();
		assert.equal(harness.manager.hasLiveProcesses(), false);
		success = true;
	} finally {
		if (success) removeSuccessfulHarness(harness);
	}
});

test("dispose retains a live owner's registration and terminal surface until its later PTY exit", async () => {
	const harness = makeHarness("dispose-live-retention");
	let success = false;
	try {
		harness.registrar.shutdownHandler = async () => requested("dispose-live-ack");
		const id = await harness.manager.create({ workspace: harness.workspace });
		const entry = harness.registrar.entryFor(id);
		const pty = harness.spawned[0];
		assert.ok(pty);
		const profile = row(harness.manager, id).agentDir;
		const surface = harness.manager.surface(id);
		assert.ok(surface);
		assert.ok(surface.frame());

		const result = await harness.manager.shutdown({ graceMs: 20, killMs: 10 });
		assert.deepEqual(result, { forcedIds: [id], remainingIds: [id] });
		assert.equal(entry.released, false, "an unresolved owned child keeps its status registration after shutdown");
		assert.throws(
			() => harness.profileRegistry.prepare({ workspace: harness.workspace, profile }),
			/already has an active admission/,
		);

		await harness.manager.dispose();
		assert.equal(entry.released, false, "dispose defers release until confirmed PTY exit");
		assert.equal(harness.manager.hasLiveProcesses(), true);
		assert.equal(harness.manager.surface(id), undefined, "the disposed manager hides its API while retaining the surface internally");
		assert.doesNotThrow(() => surface.frame(), "the retained surface is not torn down with the manager");

		pty.emitExit(29, 9);
		assert.equal(entry.released, true, "the later owned exit completes registration cleanup");
		assert.equal(harness.manager.hasLiveProcesses(), false);
		assert.equal(row(harness.manager, id).lifecycle, "exited");
		assert.throws(() => surface.frame(), /disposed/, "late exit completes deferred surface cleanup");
		const readmitted = harness.profileRegistry.prepare({ workspace: harness.workspace, profile });
		readmitted.release();
		await harness.manager.dispose();
		success = true;
	} finally {
		if (success) removeSuccessfulHarness(harness);
	}
});
