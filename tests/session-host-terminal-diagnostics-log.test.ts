/**
 * #428: private, bounded, rotated terminal diagnostics persistence.
 *
 * Hermetic: every agent directory is a disposable scratch directory under the
 * ignored node_modules cache, never a real user agent directory. Rotation uses
 * injected small limits; the production limits (3 files x 5 MiB) are asserted
 * as constants.
 */

import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
	TERMINAL_DIAGNOSTICS_FILENAME,
	TERMINAL_DIAGNOSTICS_MAX_FILE_BYTES,
	TERMINAL_DIAGNOSTICS_RETAINED_FILES,
	TERMINAL_DIAGNOSTICS_SCHEMA,
	TerminalDiagnosticsLog,
	collectTerminalDiagnosticsIdentity,
	type TerminalDiagnosticsLogOptions,
} from "../src/session-host/terminal-diagnostics-log";
import type {
	TerminalDiagnosticRecord,
	TerminalDiagnosticsLogFailure,
	TerminalDiagnosticsLogStatus,
} from "../src/session-host/terminal-diagnostics";
import { TerminalSurface } from "../src/session-host/terminal-surface";

const SCRATCH = join(process.cwd(), "node_modules", ".cache", "session-host-terminal-diagnostics-tests");
const POSIX = process.platform !== "win32";

function agentDir(): string {
	mkdirSync(SCRATCH, { recursive: true });
	return mkdtempSync(join(SCRATCH, "agent-"));
}

function record(overrides: Partial<TerminalDiagnosticRecord> = {}): TerminalDiagnosticRecord {
	return {
		time: "2026-01-01T00:00:00.000Z",
		level: "error",
		category: "parser-error",
		messageId: "parser-error",
		suppressedBefore: 0,
		parser: {
			state: 4, stateName: "CSI_PARAM", code: 0x2026, position: 3,
			intermediates: "", paramCount: 1, params: [3], paramsTruncated: false,
		},
		originatingStack: "not-applicable-parser-state-report",
		...overrides,
	};
}

function statuses(): {
	readonly seen: { status: TerminalDiagnosticsLogStatus; failure?: TerminalDiagnosticsLogFailure }[];
	readonly onStatus: NonNullable<TerminalDiagnosticsLogOptions["onStatus"]>;
} {
	const seen: { status: TerminalDiagnosticsLogStatus; failure?: TerminalDiagnosticsLogFailure }[] = [];
	return { seen, onStatus: (status, failure) => seen.push({ status, failure }) };
}

function lines(path: string): Record<string, unknown>[] {
	return readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("production retention constants are exactly three 5 MiB files", () => {
	assert.equal(TERMINAL_DIAGNOSTICS_FILENAME, "terminal-diagnostics.jsonl");
	assert.equal(TERMINAL_DIAGNOSTICS_MAX_FILE_BYTES, 5 * 1024 * 1024);
	assert.equal(TERMINAL_DIAGNOSTICS_RETAINED_FILES, 3);
});

test("nothing is created until a diagnostic is recorded; then a private structured log settles", async () => {
	const dir = agentDir();
	try {
		const quiet = new TerminalDiagnosticsLog({ agentDir: dir });
		assert.deepEqual(await quiet.close(), { settled: true, flushed: true, status: "ok" });
		assert.equal(existsSync(join(dir, "session-host")), false, "a quiet run creates nothing");

		const log = new TerminalDiagnosticsLog({
			agentDir: dir,
			identity: collectTerminalDiagnosticsIdentity({ packageRoot: process.cwd(), piVersion: "1.4.0" }),
		});
		log.appendDiagnostic("instance-1", record());
		log.noteSuppressed(4);
		const closed = await log.close();
		assert.deepEqual(closed, { settled: true, flushed: true, status: "ok" });
		assert.strictEqual(await log.close(), await log.close(), "close is idempotent");
		const path = TerminalDiagnosticsLog.pathFor(dir);
		assert.equal(path, join(dir, "session-host", "terminal-diagnostics.jsonl"));
		if (POSIX) assert.equal(lstatSync(path).mode & 0o777, 0o600);
		const entries = lines(path);
		assert.deepEqual(entries.map((entry) => entry.kind), ["host-run", "diagnostic", "host-run-end"]);
		for (const entry of entries) {
			assert.equal(entry.schema, TERMINAL_DIAGNOSTICS_SCHEMA);
			assert.equal(entry.run, entries[0]!.run);
		}
		const identity = entries[0]!.identity as Record<string, string>;
		assert.equal(identity.packageName, "pi-review-gate");
		assert.equal(identity.piVersion, "1.4.0");
		assert.equal(identity.xtermHeadless, "6.0.0");
		assert.equal(identity.xtermAddonUnicode11, "0.9.0");
		assert.equal(identity.piTui, "1.4.0");
		assert.equal(identity.node, process.versions.node);
		assert.equal(entries[1]!.instance, "instance-1");
		assert.equal(entries[1]!.seq, 1);
		assert.deepEqual((entries[1]!.parser as { params: number[] }).params, [3]);
		assert.deepEqual(entries[2]!.totals, { records: 1, suppressed: 4, dropped: 0 });
		assert.ok(!JSON.stringify(entries).includes(process.env.HOME ?? "\u0000never"), "no environment values");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a real surface's malformed child output persists structure, never child text", async () => {
	const dir = agentDir();
	const log = new TerminalDiagnosticsLog({ agentDir: dir });
	const surface = new TerminalSurface(40, 4, {
		onDiagnostic: (event) => {
			for (const item of event.records) log.appendDiagnostic("row", item);
			log.noteSuppressed(event.suppressed);
		},
	});
	try {
		surface.write("api_key=sk-SECRET-VALUE \x1b[3… conversation text");
		await surface.flush();
	} finally {
		surface.dispose();
	}
	assert.equal((await log.close()).settled, true);
	try {
		const raw = readFileSync(TerminalDiagnosticsLog.pathFor(dir), "utf8");
		assert.ok(!raw.includes("SECRET") && !raw.includes("conversation") && !raw.includes("…"));
		assert.ok(!raw.includes("\\u001b"), "no escape bytes retained");
		const diagnostic = lines(TerminalDiagnosticsLog.pathFor(dir)).find((entry) => entry.kind === "diagnostic")!;
		assert.equal(diagnostic.messageId, "parser-error");
		assert.equal((diagnostic.stack as { kind: string }).kind, "logger-call-site");
		assert.equal(diagnostic.originatingStack, "not-applicable-parser-state-report");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rotation keeps exactly active + .1 + .2, each within the bound, oldest removed", async () => {
	const dir = agentDir();
	try {
		const maxFileBytes = 2048;
		const identity = collectTerminalDiagnosticsIdentity({ packageRoot: process.cwd(), piVersion: "1.4.0" });
		const log = new TerminalDiagnosticsLog({ agentDir: dir, maxFileBytes, maxLineBytes: 1024, identity });
		for (let index = 0; index < 60; index += 1) log.appendDiagnostic(`row-${index}`, record());
		assert.equal((await log.close()).settled, true);
		const stateDir = join(dir, "session-host");
		const names = readdirSync(stateDir).filter((name) => name.startsWith("terminal-diagnostics")).sort();
		assert.deepEqual(names, [
			"terminal-diagnostics.jsonl",
			"terminal-diagnostics.jsonl.1",
			"terminal-diagnostics.jsonl.2",
		]);
		const seqs: number[] = [];
		for (const name of [names[2]!, names[1]!, names[0]!]) {
			const path = join(stateDir, name);
			assert.ok(lstatSync(path).size <= maxFileBytes, `${name} within bound`);
			if (POSIX) assert.equal(lstatSync(path).mode & 0o777, 0o600);
			const entries = lines(path);
			assert.equal(entries[0]!.schema, TERMINAL_DIAGNOSTICS_SCHEMA, "every file starts with the marker");
			// Identities survive rotation: every retained file opens with this
			// run's identity record, so retained diagnostics stay attributable.
			assert.equal(entries[0]!.kind, "host-run", `${name} starts with the run identity`);
			assert.deepEqual(entries[0]!.identity, identity);
			assert.ok((entries[0]!.segment as number) > 3, `${name} comes from beyond the third rotation`);
			for (const entry of entries) {
				assert.equal(entry.run, entries[0]!.run, "every retained record belongs to an identified run");
				if (typeof entry.seq === "number") seqs.push(entry.seq);
			}
		}
		assert.ok(seqs[0]! > 1, "the oldest records were rotated away");
		assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "files are ordered oldest (.2) to newest");
		assert.equal(seqs.at(-1), 60);

		// A later run appends to the recognized active file and keeps rotating.
		const next = new TerminalDiagnosticsLog({ agentDir: dir, maxFileBytes, maxLineBytes: 1024 });
		for (let index = 0; index < 30; index += 1) next.appendDiagnostic("later", record());
		assert.deepEqual(await next.close(), { settled: true, flushed: true, status: "ok" });
		assert.equal(readdirSync(stateDir).filter((name) => name.startsWith("terminal-diagnostics")).length, 3);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// In these refusal cases the record is appended and close() is requested in the
// same turn, so the refusal is first observed while closing: the close reports
// `flushed: false` because accepted records were not persisted and the host
// can no longer show the warning at that point.
test("an unknown file in a rotation slot is never removed or moved; persistence fails visibly", async () => {
	const dir = agentDir();
	try {
		const stateDir = join(dir, "session-host");
		mkdirSync(stateDir, { mode: 0o700 });
		writeFileSync(join(stateDir, "terminal-diagnostics.jsonl.2"), "user notes, not ours\n", { mode: 0o600 });
		const seen = statuses();
		const log = new TerminalDiagnosticsLog({ agentDir: dir, maxFileBytes: 1024, maxLineBytes: 1024, onStatus: seen.onStatus });
		for (let index = 0; index < 20; index += 1) log.appendDiagnostic("row", record());
		const closed = await log.close();
		assert.deepEqual(closed, { settled: true, flushed: false, status: "failed", failure: "unrecognized-log-file" });
		assert.deepEqual(seen.seen, [{ status: "failed", failure: "unrecognized-log-file" }]);
		assert.equal(readFileSync(join(stateDir, "terminal-diagnostics.jsonl.2"), "utf8"), "user notes, not ours\n");
		assert.equal(existsSync(join(stateDir, "terminal-diagnostics.jsonl.1")), false, "nothing was moved");
		assert.ok(lines(join(stateDir, "terminal-diagnostics.jsonl")).length > 0, "the active file is kept, not truncated");
		log.appendDiagnostic("row", record());
		assert.equal(log.status, "failed", "a failed log stays disabled for the run");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("unsafe or unrecognized active paths are refused and left untouched", { skip: !POSIX }, async () => {
	const cases: { readonly name: string; setup(stateDir: string, outside: string): void; readonly failure: TerminalDiagnosticsLogFailure }[] = [
		{
			name: "symlink",
			setup: (stateDir, outside) => symlinkSync(outside, join(stateDir, TERMINAL_DIAGNOSTICS_FILENAME)),
			failure: "unsafe-log-path",
		},
		{
			name: "directory",
			setup: (stateDir) => mkdirSync(join(stateDir, TERMINAL_DIAGNOSTICS_FILENAME)),
			failure: "unsafe-log-path",
		},
		{
			name: "foreign content",
			setup: (stateDir) => writeFileSync(join(stateDir, TERMINAL_DIAGNOSTICS_FILENAME), "{\"other\":true}\n", { mode: 0o600 }),
			failure: "unrecognized-log-file",
		},
	];
	for (const item of cases) {
		const dir = agentDir();
		try {
			const stateDir = join(dir, "session-host");
			mkdirSync(stateDir, { mode: 0o700 });
			const outside = join(dir, "outside-target.txt");
			writeFileSync(outside, "keep me\n");
			item.setup(stateDir, outside);
			const log = new TerminalDiagnosticsLog({ agentDir: dir });
			log.appendDiagnostic("row", record());
			const closed = await log.close();
			assert.deepEqual(closed, { settled: true, flushed: false, status: "failed", failure: item.failure }, item.name);
			assert.equal(readFileSync(outside, "utf8"), "keep me\n", `${item.name}: target untouched`);
			if (item.name === "foreign content") {
				assert.equal(readFileSync(join(stateDir, TERMINAL_DIAGNOSTICS_FILENAME), "utf8"), "{\"other\":true}\n");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

test("a group-writable or unwritable state directory fails visibly without writing", { skip: !POSIX || process.getuid?.() === 0 }, async () => {
	const dir = agentDir();
	try {
		const stateDir = join(dir, "session-host");
		mkdirSync(stateDir, { mode: 0o700 });
		chmodSync(stateDir, 0o770);
		const shared = new TerminalDiagnosticsLog({ agentDir: dir });
		shared.appendDiagnostic("row", record());
		assert.deepEqual(await shared.close(), { settled: true, flushed: false, status: "failed", failure: "unsafe-state-dir" });
		assert.deepEqual(readdirSync(stateDir), []);

		chmodSync(stateDir, 0o500);
		const readOnly = new TerminalDiagnosticsLog({ agentDir: dir });
		readOnly.appendDiagnostic("row", record());
		assert.deepEqual(await readOnly.close(), { settled: true, flushed: false, status: "failed", failure: "open-failed" });
		chmodSync(stateDir, 0o700);
		assert.deepEqual(readdirSync(stateDir), []);

		const missing = new TerminalDiagnosticsLog({ agentDir: join(dir, "does-not-exist") });
		missing.appendDiagnostic("row", record());
		assert.deepEqual(await missing.close(), { settled: true, flushed: false, status: "failed", failure: "unsafe-state-dir" });
	} finally {
		try { chmodSync(join(dir, "session-host"), 0o700); } catch { /* cleanup only */ }
		rmSync(dir, { recursive: true, force: true });
	}
});

test("queue overflow is bounded and recorded as a dropped count", async () => {
	const dir = agentDir();
	try {
		const log = new TerminalDiagnosticsLog({ agentDir: dir, maxQueuedLines: 4 });
		for (let index = 0; index < 50; index += 1) log.appendDiagnostic("row", record());
		assert.equal((await log.close()).settled, true);
		const entries = lines(TerminalDiagnosticsLog.pathFor(dir));
		const diagnostics = entries.filter((entry) => entry.kind === "diagnostic").length;
		const dropped = entries.filter((entry) => entry.kind === "dropped")
			.reduce((sum, entry) => sum + (entry.count as number), 0);
		const end = entries.find((entry) => entry.kind === "host-run-end")!;
		assert.ok(diagnostics < 50);
		assert.equal(diagnostics + dropped, 50, "every enqueue is either written or counted");
		assert.equal((end.totals as { records: number }).records, 50);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("oversized records are replaced by a bounded omission line", async () => {
	const dir = agentDir();
	try {
		const log = new TerminalDiagnosticsLog({ agentDir: dir, maxLineBytes: 300 });
		log.appendDiagnostic("row", record({
			stack: { kind: "logger-call-site", frames: Array.from({ length: 12 }, () => "at x".padEnd(200, "x")), truncated: false },
		}));
		assert.equal((await log.close()).settled, true);
		const entries = lines(TerminalDiagnosticsLog.pathFor(dir));
		const omitted = entries.find((entry) => entry.kind === "diagnostic-omitted")!;
		assert.deepEqual([omitted.reason, omitted.messageId], ["record-too-large", "parser-error"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a rejected final data sync is a persistence failure: reported payload-free, descriptor still closed", async () => {
	const dir = agentDir();
	try {
		const seen: unknown[][] = [];
		let synced: { fd: number } | undefined;
		const log = new TerminalDiagnosticsLog({
			agentDir: dir,
			onStatus: (...args) => { seen.push(args); },
			syncFile: async (handle) => {
				synced = handle;
				throw new Error("EIO: delayed write failure at /secret/path");
			},
		});
		log.appendDiagnostic("row", record());
		const closed = await log.close();
		assert.deepEqual(closed, { settled: true, flushed: false, status: "failed", failure: "sync-failed" });
		assert.deepEqual(seen, [["failed", "sync-failed"]], "only the fixed status and reason are reported");
		assert.ok(synced !== undefined, "the final sync was attempted");
		assert.equal(synced!.fd, -1, "the descriptor was closed despite the sync failure");
		assert.equal(log.status, "failed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a quiet or already-failed log has nothing left to flush", async () => {
	const dir = agentDir();
	try {
		let syncs = 0;
		const quiet = new TerminalDiagnosticsLog({ agentDir: dir, syncFile: async () => { syncs += 1; } });
		assert.deepEqual(await quiet.close(), { settled: true, flushed: true, status: "ok" });
		assert.equal(syncs, 0, "nothing opened, nothing synced");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a rejected sync before rotation stops before any path changes and closes the descriptor", async () => {
	const dir = agentDir();
	try {
		const seen: unknown[][] = [];
		const synced: { fd: number }[] = [];
		const log = new TerminalDiagnosticsLog({
			agentDir: dir,
			maxFileBytes: 1024,
			maxLineBytes: 512,
			onStatus: (...args) => { seen.push(args); },
			syncFile: async (handle) => {
				synced.push(handle);
				throw new Error("EIO: delayed write failure at /secret/path");
			},
		});
		for (let index = 0; index < 12; index += 1) log.appendDiagnostic(`row-${index}`, record());
		const closed = await log.close();
		assert.deepEqual(closed, { settled: true, flushed: false, status: "failed", failure: "sync-failed" });
		assert.deepEqual(seen, [["failed", "sync-failed"]], "only the fixed status and reason are reported");
		assert.equal(synced.length, 1, "the outgoing file was synchronized before rotation");
		assert.equal(synced[0]!.fd, -1, "the outgoing descriptor was closed despite the sync failure");
		const stateDir = join(dir, "session-host");
		assert.equal(existsSync(join(stateDir, "terminal-diagnostics.jsonl.1")), false, "no rotation path was mutated");
		assert.ok(lines(join(stateDir, "terminal-diagnostics.jsonl")).length > 0, "the written active file is kept");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("every rotated descriptor and the final descriptor are synchronized before closing", async () => {
	const dir = agentDir();
	try {
		const synced: { fd: number }[] = [];
		const log = new TerminalDiagnosticsLog({
			agentDir: dir,
			maxFileBytes: 1024,
			maxLineBytes: 512,
			syncFile: async (handle) => {
				synced.push(handle);
				await handle.datasync();
			},
		});
		for (let index = 0; index < 20; index += 1) log.appendDiagnostic(`row-${index}`, record());
		assert.deepEqual(await log.close(), { settled: true, flushed: true, status: "ok" });
		const segments = readdirSync(join(dir, "session-host"))
			.filter((name) => name.startsWith("terminal-diagnostics"))
			.flatMap((name) => lines(join(dir, "session-host", name)))
			.filter((entry) => entry.kind === "host-run")
			.map((entry) => entry.segment as number);
		const lastSegment = Math.max(...segments);
		assert.ok(lastSegment > 3, "the run rotated more than three times");
		assert.equal(synced.length, lastSegment, "one sync per file this run wrote (rotations + final)");
		assert.ok(synced.every((handle) => handle.fd === -1), "every synchronized descriptor was closed");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

function snapshot(stateDir: string): Record<string, { bytes: string; mode: number; ino: number }> {
	const result: Record<string, { bytes: string; mode: number; ino: number }> = {};
	for (const name of readdirSync(stateDir).filter((entry) => entry.startsWith("terminal-diagnostics")).sort()) {
		const path = join(stateDir, name);
		const stats = lstatSync(path);
		result[name] = { bytes: readFileSync(path, "utf8"), mode: stats.mode & 0o777, ino: stats.ino };
	}
	return result;
}

test("a recognized log made group/other accessible is refused before append or rotation and left unchanged", { skip: !POSIX }, async () => {
	const dir = agentDir();
	try {
		const maxFileBytes = 1024;
		const stateDir = join(dir, "session-host");
		const active = join(stateDir, TERMINAL_DIAGNOSTICS_FILENAME);
		const seed = new TerminalDiagnosticsLog({ agentDir: dir, maxFileBytes, maxLineBytes: 512 });
		for (let index = 0; index < 20; index += 1) seed.appendDiagnostic("seed", record());
		assert.deepEqual(await seed.close(), { settled: true, flushed: true, status: "ok" });
		assert.deepEqual(Object.keys(snapshot(stateDir)), [
			"terminal-diagnostics.jsonl",
			"terminal-diagnostics.jsonl.1",
			"terminal-diagnostics.jsonl.2",
		]);

		for (const name of ["terminal-diagnostics.jsonl", "terminal-diagnostics.jsonl.1", "terminal-diagnostics.jsonl.2"]) {
			chmodSync(join(stateDir, name), 0o644);
			const before = snapshot(stateDir);
			const seen = statuses();
			const log = new TerminalDiagnosticsLog({ agentDir: dir, maxFileBytes, maxLineBytes: 512, onStatus: seen.onStatus });
			// The active file case is refused at open; the slot cases need a rotation.
			const appends = name === "terminal-diagnostics.jsonl" ? 1 : 20;
			for (let index = 0; index < appends; index += 1) log.appendDiagnostic("row", record());
			assert.deepEqual(await log.close(), { settled: true, flushed: false, status: "failed", failure: "unsafe-log-path" }, name);
			assert.deepEqual(seen.seen, [{ status: "failed", failure: "unsafe-log-path" }], `${name}: payload-free failure`);
			const after = snapshot(stateDir);
			assert.deepEqual(Object.keys(after), Object.keys(before), `${name}: no path added, moved, or removed`);
			assert.deepEqual(after[name], before[name], `${name}: refused file keeps its bytes, mode, and identity`);
			assert.equal(after[name]!.mode, 0o644, `${name}: its mode was not changed`);
			if (name === "terminal-diagnostics.jsonl") {
				assert.deepEqual(after, before, "nothing was appended to or rotated from the accessible active file");
			} else {
				// The private 0600 active file may receive this run's records, but it
				// is never moved while a slot is refused.
				assert.equal(after["terminal-diagnostics.jsonl"]!.ino, before["terminal-diagnostics.jsonl"]!.ino);
				for (const other of Object.keys(before).filter((key) => key !== name && key !== "terminal-diagnostics.jsonl")) {
					assert.deepEqual(after[other], before[other], `${name}: ${other} untouched`);
				}
			}
			chmodSync(join(stateDir, name), 0o600);
		}

		// Regular private logs keep appending and rotating.
		const activeIno = lstatSync(active).ino;
		const next = new TerminalDiagnosticsLog({ agentDir: dir, maxFileBytes, maxLineBytes: 512 });
		for (let index = 0; index < 20; index += 1) next.appendDiagnostic("later", record());
		assert.deepEqual(await next.close(), { settled: true, flushed: true, status: "ok" });
		const final = snapshot(stateDir);
		assert.equal(Object.keys(final).length, 3);
		assert.notEqual(final["terminal-diagnostics.jsonl"]!.ino, activeIno, "the run rotated");
		for (const entry of Object.values(final)) assert.equal(entry.mode, 0o600);
		assert.ok(lines(active).some((entry) => entry.instance === "later"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a pre-existing empty active file is not ownership evidence: refused and left untouched", async () => {
	const dir = agentDir();
	try {
		const stateDir = join(dir, "session-host");
		mkdirSync(stateDir, { mode: 0o700 });
		const active = join(stateDir, TERMINAL_DIAGNOSTICS_FILENAME);
		writeFileSync(active, "", { mode: 0o600 });
		const before = lstatSync(active);
		const seen = statuses();
		const log = new TerminalDiagnosticsLog({ agentDir: dir, onStatus: seen.onStatus });
		log.appendDiagnostic("row", record());
		assert.deepEqual(await log.close(), { settled: true, flushed: false, status: "failed", failure: "unrecognized-log-file" });
		assert.deepEqual(seen.seen, [{ status: "failed", failure: "unrecognized-log-file" }]);
		const after = lstatSync(active);
		assert.equal(after.size, 0, "the empty file was not written");
		assert.equal(after.ino, before.ino);
		assert.equal(after.mode, before.mode);
		assert.deepEqual(readdirSync(stateDir), [TERMINAL_DIAGNOSTICS_FILENAME], "no rotation slot was created");

		// A file this run creates exclusively is written normally.
		rmSync(active);
		const fresh = new TerminalDiagnosticsLog({ agentDir: dir });
		fresh.appendDiagnostic("row", record());
		assert.deepEqual(await fresh.close(), { settled: true, flushed: true, status: "ok" });
		assert.deepEqual(lines(active).map((entry) => entry.kind), ["host-run", "diagnostic", "host-run-end"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an accepted append is only queued: an ok status is no persistence acknowledgement", async () => {
	const dir = agentDir();
	try {
		const fresh = new TerminalDiagnosticsLog({ agentDir: dir });
		fresh.appendDiagnostic("row", record());
		assert.equal(fresh.status, "ok");
		assert.equal(existsSync(TerminalDiagnosticsLog.pathFor(dir)), false, "nothing is written when append returns");
		assert.equal((await fresh.close()).flushed, true);
		rmSync(join(dir, "session-host"), { recursive: true, force: true });

		const stateDir = join(dir, "session-host");
		mkdirSync(stateDir, { mode: 0o700 });
		writeFileSync(join(stateDir, TERMINAL_DIAGNOSTICS_FILENAME), "not ours\n", { mode: 0o600 });
		const log = new TerminalDiagnosticsLog({ agentDir: dir });
		log.appendDiagnostic("row", record());
		assert.equal(log.status, "ok", "status is still ok while the write is pending");
		assert.deepEqual(await log.close(), { settled: true, flushed: false, status: "failed", failure: "unrecognized-log-file" });
		assert.equal(readFileSync(join(stateDir, TERMINAL_DIAGNOSTICS_FILENAME), "utf8"), "not ours\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
