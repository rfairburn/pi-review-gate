'use strict';

/**
 * Deterministic run-as-binary worker for the native Main automatic-resume test.
 * It consumes the real controller prompt and an owned mode plan: hold mode
 * publishes readiness, waits for one test-owned release file through fs.watch
 * plus a bounded reread of that same durable file, and writes a fixture-only
 * change; executor-failure-held publishes readiness,
 * waits for a distinct release, then exits nonzero so the real controller's
 * stopped recovery-required record can be authenticated. The bounded timer is
 * a failure guard only; it never supplies work or status.
 */
const fs = require('node:fs');
const path = require('node:path');

const stateDir = process.env.PRG_FIXTURE_STATE_DIR;
const ownedRoot = process.env.PRG_FIXTURE_OWNED_ROOT;
const releasePath = stateDir && path.join(stateDir, 'worker-release.json');
const stoppedRecoverableReleasePath = stateDir && path.join(stateDir, 'stopped-recoverable-release.json');
const startedPath = stateDir && path.join(stateDir, 'worker-started.json');
const completedPath = stateDir && path.join(stateDir, 'worker-completed.json');
const stoppedRecoverableStartedPath = stateDir && path.join(stateDir, 'stopped-recoverable-started.json');
const executorFailurePath = stateDir && path.join(stateDir, 'executor-failure.json');
const workerModePath = stateDir && path.join(stateDir, 'worker-mode.json');
const requestedWorkerMode = process.env.PRG_FIXTURE_WORKER_MODE ?? 'fixture-plan';
const outputName = process.env.PRG_FIXTURE_OUTPUT_NAME ?? 'resume-task-proof.txt';
let workerMode = 'hold';

function assertOwnedPaths() {
	if (process.env.PI_REVIEW_EXECUTOR_PROTOCOL !== 'pi-review-executor-jsonl-v1'
		|| typeof process.env.PI_REVIEW_EXECUTOR_SESSION_ID !== 'string'
		|| process.env.PI_REVIEW_EXECUTOR_SESSION_ID.length === 0
		|| typeof process.env.PI_REVIEW_EXECUTOR_OPERATION !== 'string'
		|| (requestedWorkerMode !== 'fixture-plan' && requestedWorkerMode !== 'hold'
			&& requestedWorkerMode !== 'executor-failure' && requestedWorkerMode !== 'executor-failure-held')
		|| !/^[a-z0-9][a-z0-9._-]{0,80}\.txt$/u.test(outputName)
		|| !path.isAbsolute(stateDir ?? '') || !path.isAbsolute(ownedRoot ?? '')) {
		throw new Error('native resume fixture worker received an invalid owned launch contract');
	}
	const stateStats = fs.lstatSync(stateDir);
	if (!stateStats.isDirectory() || stateStats.isSymbolicLink()) {
		throw new Error('native resume fixture state directory is not a real directory');
	}
	if (requestedWorkerMode === 'fixture-plan') {
		const modeStats = fs.lstatSync(workerModePath);
		if (!modeStats.isFile() || modeStats.isSymbolicLink() || modeStats.size > 4096) {
			throw new Error('native resume fixture mode plan is not a bounded owned file');
		}
		const plan = JSON.parse(fs.readFileSync(workerModePath, 'utf8'));
		workerMode = plan && plan.mode;
	} else {
		workerMode = requestedWorkerMode;
	}
	if (workerMode !== 'hold' && workerMode !== 'executor-failure' && workerMode !== 'executor-failure-held') {
		throw new Error('native resume fixture mode plan was malformed');
	}
	const canonicalRoot = fs.realpathSync(ownedRoot);
	const canonicalCwd = fs.realpathSync(process.cwd());
	const relativeCwd = path.relative(canonicalRoot, canonicalCwd);
	if (relativeCwd === '..' || relativeCwd.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCwd)) {
		throw new Error('native resume fixture worker cwd escaped its owned scratch root');
	}
}

// The release file is a durable fact owned by the test process, and its only live
// trigger is an fs.watch notification that can be coalesced or never delivered.
// Observation therefore keeps the notification fast path and the single original
// absolute deadline, and adds a bounded reread of that same file plus one final
// reread at the deadline. Missing bytes stay pending, a malformed payload or any
// read/watcher error still fails closed, and no timer or notification can
// manufacture a release that the actual file does not contain.
const RELEASE_DEADLINE_MS = 240_000;
const RELEASE_RECHECK_INTERVAL_MS = 25;

function waitForRelease(targetReleasePath, options = {}) {
	// Fixture-only seam for unit coverage: the entrypoint below never passes
	// options. A non-positive `recheckIntervalMs` reproduces the pre-change
	// notification-only shape so the regression control can exercise the same
	// helper with the same predicate and deadline.
	const watch = options.watch ?? fs.watch;
	const recheckIntervalMs = options.recheckIntervalMs ?? RELEASE_RECHECK_INTERVAL_MS;
	return new Promise((resolve, reject) => {
		let settled = false;
		let watcher;
		let deadline;
		let recheck;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			if (deadline !== undefined) clearTimeout(deadline);
			if (recheck !== undefined) clearInterval(recheck);
			deadline = undefined;
			recheck = undefined;
			const ownedWatcher = watcher;
			watcher = undefined;
			try { ownedWatcher?.close(); } catch { /* owned fixture watcher */ }
			if (error) reject(error);
			else resolve();
		};
		const checkRelease = () => {
			if (settled) return;
			try {
				if (!fs.existsSync(targetReleasePath)) return;
				const release = JSON.parse(fs.readFileSync(targetReleasePath, 'utf8'));
				if (release !== null && typeof release === 'object' && release.release === true) finish();
				else finish(new Error('native resume fixture release record was malformed'));
			} catch (error) {
				finish(error instanceof Error ? error : new Error('native resume fixture release read failed'));
			}
		};
		// Scheduled once: no observation path resets, extends, or re-arms it.
		deadline = setTimeout(() => {
			deadline = undefined;
			if (recheckIntervalMs > 0) checkRelease();
			if (!settled) finish(new Error('native resume fixture release deadline expired'));
		}, RELEASE_DEADLINE_MS);
		if (recheckIntervalMs > 0) {
			recheck = setInterval(checkRelease, recheckIntervalMs);
		}
		try {
			watcher = watch(path.dirname(targetReleasePath), (_event, filename) => {
				if (filename === null || filename.toString() === path.basename(targetReleasePath)) checkRelease();
			});
			// A watcher failure is never a release and never worker success.
			watcher.on('error', (error) => finish(error instanceof Error
				? new Error(`native resume fixture release watcher failed: ${error.message}`)
				: new Error('native resume fixture release watcher failed')));
		} catch (error) {
			finish(error instanceof Error
				? new Error(`native resume fixture release watcher failed: ${error.message}`)
				: new Error('native resume fixture release watcher failed'));
			return;
		}
		// Check after the watcher is installed so an early test-side release is
		// neither missed nor converted into a sleep/poll loop.
		checkRelease();
	});
}

async function main() {
	assertOwnedPaths();
	let promptBytes = 0;
	process.stdin.on('data', (chunk) => { promptBytes += Buffer.byteLength(chunk); });
	process.stdin.on('end', async () => {
		try {
			if (promptBytes === 0) throw new Error('native resume fixture received no controller prompt');
			if (workerMode === 'executor-failure' || workerMode === 'executor-failure-held') {
				fs.writeFileSync(stoppedRecoverableStartedPath, '{"started":true}\n', { flag: 'wx', mode: 0o600 });
				if (workerMode === 'executor-failure-held') await waitForRelease(stoppedRecoverableReleasePath);
				fs.writeFileSync(executorFailurePath, '{"executorFailure":true}\n', { flag: 'wx', mode: 0o600 });
				process.exitCode = 1;
				return;
			}
			fs.writeFileSync(startedPath, '{"ready":true}\n', { flag: 'wx', mode: 0o600 });
			await waitForRelease(releasePath);
			const outputPath = path.join(process.cwd(), outputName);
			fs.writeFileSync(outputPath, 'controlled native resume task completed\n', { flag: 'wx', mode: 0o600 });
			const output = [
				JSON.stringify({ type: 'session', sessionId: process.env.PI_REVIEW_EXECUTOR_SESSION_ID }),
				JSON.stringify({ type: 'assistant', text: 'controlled native resume task completed' }),
			].join('\n') + '\n';
			await new Promise((resolve, reject) => {
				process.stdout.write(output, (error) => error ? reject(error) : resolve());
			});
			fs.writeFileSync(completedPath, '{"completed":true}\n', { flag: 'wx', mode: 0o600 });
		} catch (error) {
			process.stderr.write(`native resume fixture worker failed: ${error instanceof Error ? error.message : 'unknown failure'}\n`);
			process.exitCode = 1;
		}
	});
	process.stdin.resume();
}

if (require.main === module) {
	void main().catch((error) => {
		process.stderr.write(`native resume fixture worker failed: ${error instanceof Error ? error.message : 'unknown failure'}\n`);
		process.exitCode = 1;
	});
}

module.exports = { waitForRelease, RELEASE_DEADLINE_MS, RELEASE_RECHECK_INTERVAL_MS };
