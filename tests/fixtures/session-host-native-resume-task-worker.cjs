'use strict';

/**
 * Deterministic run-as-binary worker for the native Main automatic-resume test.
 * It consumes the real controller prompt and an owned mode plan: hold mode
 * publishes readiness, waits for one test-owned release file through fs.watch,
 * and writes a fixture-only change; executor-failure-held publishes readiness,
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

function waitForRelease(targetReleasePath) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let watcher;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			try { watcher?.close(); } catch { /* owned fixture watcher */ }
			if (error) reject(error);
			else resolve();
		};
		const checkRelease = () => {
			try {
				if (!fs.existsSync(targetReleasePath)) return;
				const release = JSON.parse(fs.readFileSync(targetReleasePath, 'utf8'));
				if (release.release === true) finish();
				else finish(new Error('native resume fixture release record was malformed'));
			} catch (error) {
				finish(error);
			}
		};
		const deadline = setTimeout(() => finish(new Error('native resume fixture release deadline expired')), 240_000);
		watcher = fs.watch(stateDir, (_event, filename) => {
			if (filename === null || filename.toString() === path.basename(targetReleasePath)) checkRelease();
		});
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

void main().catch((error) => {
	process.stderr.write(`native resume fixture worker failed: ${error instanceof Error ? error.message : 'unknown failure'}\n`);
	process.exitCode = 1;
});
