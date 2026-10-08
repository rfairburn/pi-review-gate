'use strict';
/**
 * Test-only background-shell job for the native Main background-count
 * acceptance (tests/session-host-native-background-counts.test.ts).
 *
 * This is genuine bounded local service work, not a timer or a placeholder:
 * the process binds a bounded IPv4 loopback TCP listener on 127.0.0.1 with an
 * ephemeral port (no external network and no filesystem socket leaf) and
 * answers each client connection with one bounded JSON status line. It makes
 * no external network request, reads no credential, creates no persistent
 * files beyond its bounded readiness and listener-completion leaves, and touches nothing outside the
 * caller-provided confined service directory.
 *
 * Evidence retention: exclusively create ready.json on binding and closed.json
 * only after the original listener's successful close callback. Both are 0600
 * JSON records carrying bounded pid/port and generic status; never remove or
 * overwrite either. Closed-listener evidence is not a service kernel-exit/code
 * claim. Successful and failed lifecycle evidence is retained permanently;
 * graceful shutdown closes only the job's own original handles — the accepted
 * client connections and the listening socket.
 *
 * Environment contract (set by the test host and inherited by ShellStart):
 * - PRG_BG_COUNT_JOB_SERVICE_DIR  absolute confined service directory inside
 *                                 the test-owned scratch root (required, bounded).
 * The readiness leaf is "<serviceDir>/ready.json": created exactly once, mode
 * 0600, content {"pid":N,"port":M,"status":"ready"}, only after the listener
 * is bound, so the test host can observe readiness from a real filesystem
 * event instead of polling.
 *
 * Fail-closed pre-mutation checks: original role/catalog environment markers
 * (case-insensitively, including empty values) are refused before anything is
 * created; unsafe service-directory ancestors (symlinks or non-directories)
 * and a pre-existing readiness leaf are refused the same way. These are
 * point-in-time validations — no atomic containment claim is made against
 * later swaps. The process never mutates NODE_OPTIONS, provider settings, or
 * any other environment variable.
 *
 * Pure seams: module.exports.buildReadinessRecord / .parseReadinessRecord /
 * .validateAncestors / .validateServiceDir expose the exact record grammar and
 * path-safety contract so the test can exercise them without a runtime.
 * Requiring this file never starts the service; only direct execution does.
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const READINESS_LEAF_NAME = 'ready.json';
const COMPLETION_LEAF_NAME = 'closed.json';
const MAX_SERVICE_DIR_BYTES = 120;
const MAX_ACTIVE_CONNECTIONS = 4;
const MAX_SERVED = 64;
const READY_STATUS = 'ready';

function fail(message, code) {
	process.stderr.write(`background-count-job: ${message}\n`);
	process.exit(code);
}

/** Original role/catalog markers are refused by name before any mutation. */
function assertOriginalEnvironmentAdmissible(env) {
	for (const name of Object.keys(env)) {
		const upper = name.toUpperCase();
		if (upper === 'PI_REVIEW_GATE_RUNTIME_ROLE' || upper === 'PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG') {
			throw new Error(`background-count-job refuses a role/catalog marker: ${name}`);
		}
	}
}

/** Exact bounded readiness record grammar: numeric pid/port plus generic status. */
function buildReadinessRecord(pid, port) {
	return `${JSON.stringify({ pid, port, status: READY_STATUS })}\n`;
}

/**
 * Strict inverse of buildReadinessRecord: a plain object carrying exactly the
 * bounded numeric pid/port and the generic ready status. Anything else —
 * malformed JSON, exotic prototypes, extra or missing fields, unbounded
 * values — is rejected rather than guessed.
 */
function parseReadinessRecord(text, expectedStatus = READY_STATUS) {
	if (expectedStatus !== READY_STATUS && expectedStatus !== 'closed') throw new Error('invalid expected record status');
	if (typeof text !== 'string') throw new Error('the readiness record is not a string');
	let parsed;
	try {
		parsed = JSON.parse(text.trim());
	} catch {
		throw new Error('the readiness record is not bounded JSON');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('the readiness record is not a plain object');
	}
	if (Object.getPrototypeOf(parsed) !== Object.prototype) {
		throw new Error('the readiness record has an exotic prototype');
	}
	const keys = Object.keys(parsed).sort();
	if (keys.length !== 3 || keys[0] !== 'pid' || keys[1] !== 'port' || keys[2] !== 'status') {
		throw new Error('the readiness record does not carry exactly pid/port/status');
	}
	const { pid, port, status } = parsed;
	if (!Number.isSafeInteger(pid) || pid <= 0) {
		throw new Error('the readiness record pid is not a bounded positive integer');
	}
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new Error('the readiness record port is not a bounded TCP port');
	}
	if (status !== expectedStatus) {
		throw new Error('the readiness record status is not the generic ready marker');
	}
	return { pid, port, status };
}

/**
 * Point-in-time ancestor contract: every directory from `dirPath` up to the
 * root is a real nonsymlink directory. Validated at one instant only; it makes
 * no atomic containment claim against later swaps.
 */
function validateAncestors(dirPath) {
	if (typeof dirPath !== 'string' || !path.isAbsolute(dirPath)) {
		throw new Error('an absolute service directory path is required');
	}
	let current = dirPath;
	while (current !== path.dirname(current)) {
		let stats;
		try {
			stats = fs.lstatSync(current);
		} catch (error) {
			throw new Error(`service dir ancestor ${current} is not inspectable (${error && error.code ? error.code : 'unknown'})`);
		}
		if (!stats.isDirectory() || stats.isSymbolicLink()) {
			throw new Error(`refusing unsafe service dir ancestor ${current}`);
		}
		current = path.dirname(current);
	}
	return true;
}

/**
 * Point-in-time path-safety contract for the confined service directory:
 * absolute and bounded, every ancestor a real nonsymlink directory, and no
 * pre-existing readiness leaf to adopt or overwrite. Returns the exact leaf
 * path. This validates at one instant only; it makes no atomic containment
 * claim against later swaps.
 */
function validateServiceDir(serviceDir) {
	if (typeof serviceDir !== 'string' || !path.isAbsolute(serviceDir)) {
		throw new Error('an absolute PRG_BG_COUNT_JOB_SERVICE_DIR is required');
	}
	if (Buffer.byteLength(serviceDir, 'utf8') > MAX_SERVICE_DIR_BYTES) {
		throw new Error('the service directory path exceeds its bound');
	}
	if (/[\x00-\x1f\x7f]/u.test(serviceDir)) throw new Error('unsafe service directory text');
	validateAncestors(serviceDir);
	const leafPath = path.join(serviceDir, READINESS_LEAF_NAME);
	try {
		fs.lstatSync(leafPath);
		throw new Error(`refusing to adopt the pre-existing readiness leaf ${leafPath}`);
	} catch (error) {
		if (!(error && error.code === 'ENOENT')) throw error;
	}
	return leafPath;
}

function main() {
	assertOriginalEnvironmentAdmissible(process.env);
	const serviceDir = process.env.PRG_BG_COUNT_JOB_SERVICE_DIR;
	let readyPath;
	try {
		readyPath = validateServiceDir(serviceDir);
	} catch (error) {
		fail(String(error && error.message ? error.message : error), 3);
	}

	// A restrictive umask keeps the readiness leaf owner-only even though the
	// service directory is already 0700.
	try { process.umask(0o077); } catch { /* best effort; the service dir is 0700 */ }

	const admittedAncestors = [];
	for (let dir = serviceDir; ; dir = path.dirname(dir)) {
		admittedAncestors.push([dir, fs.lstatSync(dir, { bigint: true })]);
		if (dir === path.dirname(dir)) break;
	}
	function revalidateAncestors() {
		for (const [dir, before] of admittedAncestors) {
			const now = fs.lstatSync(dir, { bigint: true });
			if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== before.dev || now.ino !== before.ino) {
				throw new Error('service directory ancestor changed; retain uncertain outputs');
			}
		}
	}
	const completionPath = path.join(serviceDir, COMPLETION_LEAF_NAME);
	try {
		fs.lstatSync(completionPath);
		fail('pre-existing completion leaf refused', 3);
	} catch (error) {
		if (!(error && error.code === 'ENOENT')) throw error;
	}
	let boundPort;
	let served = 0;
	let stopped = false;
	const connections = new Set();

	// Graceful shutdown closes only this job's own original handles. The
	// readiness leaf and every other piece of evidence are retained.
	function shutdown() {
		if (stopped) return;
		stopped = true;
		for (const connection of connections) {
			try { connection.destroy(); } catch { /* this job's own accepted socket */ }
		}
		connections.clear();
		try {
			server.close((error) => {
				if (error || !Number.isSafeInteger(boundPort) || boundPort <= 0) fail('listener close was not confirmed', 6);
				try {
					revalidateAncestors();
					fs.writeFileSync(completionPath, `${JSON.stringify({ pid: process.pid, port: boundPort, status: 'closed' })}\n`, { flag: 'wx', mode: 0o600 });
					revalidateAncestors();
				} catch { fail('listener completion evidence unavailable', 6); }
				process.exit(0);
			});
		} catch {
			fail('listener close failed', 6);
		}
	}

	const server = net.createServer((connection) => {
		connection.on('error', () => { /* a client disconnect is not a job failure */ });
		if (stopped || served >= MAX_SERVED || connections.size >= MAX_ACTIVE_CONNECTIONS) {
			connection.destroy();
			return;
		}
		served += 1;
		connections.add(connection);
		connection.once('close', () => connections.delete(connection));
		const address = server.address();
		if (!address || typeof address.port !== 'number') {
			connection.destroy();
			return;
		}
		connection.end(`${JSON.stringify({ pid: process.pid, port: address.port, served })}\n`);
	});

	server.on('error', (error) => {
		fail(`listener failed (${error && error.code ? error.code : String(error)})`, 4);
	});

	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);

	server.listen(0, '127.0.0.1', () => {
		const address = server.address();
		if (!address || typeof address.port !== 'number') {
			fail('listener bound without a bounded numeric port', 5);
		}
		boundPort = address.port;
		try {
			revalidateAncestors();
			fs.writeFileSync(readyPath, buildReadinessRecord(process.pid, address.port), { flag: 'wx', mode: 0o600 });
			revalidateAncestors();
		} catch (error) {
			fail(`readiness leaf failed (${String(error)})`, 5);
		}
	});
}

if (require.main === module) {
	main();
}

module.exports = {
	readinessLeafName: READINESS_LEAF_NAME,
	completionLeafName: COMPLETION_LEAF_NAME,
	buildReadinessRecord,
	parseReadinessRecord,
	validateAncestors,
	validateServiceDir,
};
