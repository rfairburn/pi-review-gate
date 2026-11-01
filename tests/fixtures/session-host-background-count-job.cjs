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
 * caller-provided confined service directory plus the caller-established
 * private preparation directory (a sibling of the final record directory, never
 * inside it).
 *
 * Evidence retention: publish ready.json only once the listener really binds
 * and closed.json only after the original listener's successful close
 * callback. Both are 0600 JSON records carrying bounded pid/port and generic
 * status; never remove or overwrite either. Each record is published atomically
 * and exclusively: its complete bytes land on a private preparation leaf
 * outside the final record directory first, that leaf is revalidated through
 * its own pathname (saved identity, type, permissions, size, and bytes)
 * immediately before the commit, and the final pathname only then appears,
 * through one synchronous exclusive hard link, so a reader never sees a
 * created-but-unwritten leaf and a replaced or truncated preparation never
 * exposes a final record. The only file this job may remove is its own
 * preparation leaf, and only while its recorded identity still proves that
 * ownership; an uncertain preparation leaf is retained. A preparation leaf is
 * never copied, renamed over, or adopted. Closed-listener evidence is not a
 * service kernel-exit/code claim. Successful and failed lifecycle evidence is
 * retained permanently; graceful shutdown closes only the job's own original
 * handles — the accepted client connections and the listening socket.
 *
 * Environment contract (set by the test host and inherited by ShellStart):
 * - PRG_BG_COUNT_JOB_SERVICE_DIR  absolute confined service directory inside
 *                                 the test-owned scratch root (required, bounded).
 * - PRG_BG_COUNT_JOB_PREP_DIR     absolute private preparation directory, also
 *                                 under the test-owned scratch root and already
 *                                 established by the caller; it must stay
 *                                 outside the service directory (required).
 * The readiness leaf is "<serviceDir>/ready.json": created exactly once, mode
 * 0600, content {"pid":N,"port":M,"status":"ready"}, only after the listener
 * is bound, so the test host can observe readiness from a real filesystem
 * event instead of polling. Preparation leaves exist only in the private
 * preparation directory and never inside the final record directory.
 *
 * Fail-closed pre-mutation checks: original role/catalog environment markers
 * (case-insensitively, including empty values) are refused before anything is
 * created; unsafe service-directory or preparation-directory ancestors
 * (symlinks or non-directories), a preparation directory inside the final
 * record directory, and a pre-existing readiness leaf are refused the same
 * way. The publisher also snapshots both admitted directory chains and compares
 * their dev/ino identities immediately before committing a record, so a
 * replacement directory at an admitted pathname never receives one. These are
 * point-in-time validations — no atomic containment claim is made against
 * later swaps. The process never mutates NODE_OPTIONS, provider settings, or
 * any other environment variable.
 *
 * Pure seams: module.exports.buildReadinessRecord / .parseReadinessRecord /
 * .validateAncestors / .validateServiceDir / .validatePrepDir /
 * .publishRecordExclusive expose the exact record grammar, the path-safety and
 * private-preparation contract, and the atomic exclusive publication itself, so
 * the test can exercise the actual producer without a runtime. Requiring this
 * file never starts the service; only direct execution does.
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const READINESS_LEAF_NAME = 'ready.json';
const COMPLETION_LEAF_NAME = 'closed.json';
const MAX_SERVICE_DIR_BYTES = 120;
const MAX_RECORD_BYTES = 4_096;
const MAX_ACTIVE_CONNECTIONS = 4;
const MAX_SERVED = 64;
const READY_STATUS = 'ready';
let prepSequence = 0;

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
 * True when `child` is `parent` itself or sits inside it. Only an exact `..`
 * pathname is parent traversal, and only a `..`-led path followed by a separator
 * escapes: a child basename that merely starts with `..` (`..preparation`) is an
 * ordinary name inside `parent`, so containment is decided on path structure and
 * never on a name shape.
 */
function isWithin(parent, child) {
	const rel = path.relative(parent, child);
	if (rel === '') return true;
	if (path.isAbsolute(rel)) return false;
	return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * Point-in-time contract for the publisher's private preparation directory:
 * absolute and bounded, every ancestor a real nonsymlink directory, and
 * strictly outside the final record directory, so no intermediate preparation
 * name can ever appear there. The directory itself must already exist: the
 * caller establishes it, and this job never creates a directory inside the
 * confined service directory. Point-in-time only — no atomic containment claim
 * against later swaps.
 */
function validatePrepDir(prepDir, serviceDir) {
	if (typeof prepDir !== 'string' || !path.isAbsolute(prepDir)) {
		throw new Error('an absolute PRG_BG_COUNT_JOB_PREP_DIR is required');
	}
	if (Buffer.byteLength(prepDir, 'utf8') > MAX_SERVICE_DIR_BYTES) {
		throw new Error('the preparation directory path exceeds its bound');
	}
	if (/[\x00-\x1f\x7f]/u.test(prepDir)) throw new Error('unsafe preparation directory text');
	if (typeof serviceDir !== 'string' || !path.isAbsolute(serviceDir)) {
		throw new Error('an absolute service directory is required');
	}
	if (isWithin(serviceDir, prepDir)) {
		throw new Error('the preparation directory must stay outside the confined service directory');
	}
	validateAncestors(prepDir);
	return prepDir;
}

/**
 * Remove one preparation leaf only while its recorded dev/ino identity still
 * proves this publisher created it and it is still a regular nonsymlink file.
 * Any mismatch or error retains the leaf — unknown data is never deleted — and
 * reports why without throwing.
 */
function discardOwnPrepLeaf(prepPath, prepared) {
	try {
		const now = fs.lstatSync(prepPath, { bigint: true });
		if (!now.isFile() || now.isSymbolicLink() || now.dev !== prepared.dev || now.ino !== prepared.ino) {
			return { removed: false, reason: 'preparation identity changed; retain uncertain outputs' };
		}
		fs.unlinkSync(prepPath);
		return { removed: true };
	} catch (error) {
		return { removed: false, reason: `preparation cleanup unavailable (${error && error.code ? error.code : 'unknown'})` };
	}
}

/**
 * Pre-commit revalidation of the preparation leaf through its own pathname,
 * immediately before the exclusive link: the pathname must still identify the
 * saved regular nonsymlink inode with its owner-only mode and complete size,
 * and a descriptor opened through that pathname must still identify that inode
 * and return exactly the published bytes. A replaced pathname, symlink,
 * truncation, mode loosening, or content rewrite is refused BEFORE the final
 * pathname can appear, so no foreign or incomplete record is ever exposed.
 * Point-in-time only — no atomic claim against a swap after this check; the
 * post-commit identity check stays as defense in depth.
 */
function revalidatePrepLeaf(prepPath, prepared, recordBytes) {
	const now = fs.lstatSync(prepPath, { bigint: true });
	if (!now.isFile() || now.isSymbolicLink()) {
		throw new Error('the preparation leaf pathname no longer identifies a regular nonsymlink file; retain uncertain outputs');
	}
	if (now.dev !== prepared.dev || now.ino !== prepared.ino) {
		throw new Error('the preparation leaf pathname no longer identifies the prepared inode; retain uncertain outputs');
	}
	if (Number(now.mode & 0o777n) !== 0o600) throw new Error('the preparation leaf is no longer owner-only');
	if (now.size !== prepared.size) throw new Error('the preparation leaf no longer carries the complete record');
	let fd = -1;
	try {
		fd = fs.openSync(prepPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const opened = fs.fstatSync(fd, { bigint: true });
		if (!opened.isFile() || opened.isSymbolicLink() || opened.dev !== prepared.dev || opened.ino !== prepared.ino) {
			throw new Error('the preparation descriptor no longer identifies the prepared inode; retain uncertain outputs');
		}
		if (Number(opened.mode & 0o777n) !== 0o600) throw new Error('the preparation descriptor is no longer owner-only');
		if (opened.size !== prepared.size) throw new Error('the preparation descriptor does not carry the complete record');
		const back = Buffer.alloc(Number(opened.size));
		let read = 0;
		while (read < back.length) {
			const n = fs.readSync(fd, back, read, back.length - read, read);
			if (n === 0) throw new Error('the preparation leaf did not read back the complete record');
			read += n;
		}
		if (!back.equals(recordBytes)) throw new Error('the preparation leaf bytes are not the published record');
	} finally {
		if (fd >= 0) fs.closeSync(fd);
	}
	return true;
}

/**
 * Atomic exclusive local publication of one complete lifecycle record.
 *
 * The record's full bytes are written, flushed, read back, and identity-checked
 * on a private preparation leaf inside `prepDir` (outside the final record
 * directory). Only then does the final pathname appear, created by one
 * synchronous exclusive hard link to that prepared inode: the pathname and the
 * complete bounded record become visible together, so a reader never observes a
 * created-but-unwritten leaf. There is no copy, rename-over, or other fallback;
 * if the link fails, nothing is published.
 *
 * No-overwrite semantics hold twice over: an existing final pathname (regular
 * file, symlink, or dangling symlink) is refused before any preparation, and a
 * pathname created in between still fails the exclusive link with EEXIST.
 *
 * The preparation leaf is removed only while its recorded dev/ino identity
 * still proves this publisher owns it; an uncertain preparation leaf is
 * retained rather than deleting unknown data. Both admitted directory chains are
 * snapshotted at admission and their dev/ino identities are compared
 * immediately before the link, and the preparation leaf is revalidated through
 * its own pathname (saved identity, type, permissions, size, and bytes): a
 * replaced or truncated preparation, or a replacement real directory at an
 * admitted pathname, is refused before any final record can appear. Cleanup
 * failure never unwinds an already-committed record: the record stands and the
 * returned descriptor reports the retained preparation leaf.
 *
 * `afterPrepare` is a deterministic test seam that runs while only the
 * preparation leaf exists; the live service never passes one. It runs inside the
 * same pre-commit error-handling region as the revalidation, so a seam that
 * throws leaves the final pathname absent, gives back only the preparation leaf
 * this publisher still positively owns (any unknown data it substituted at that
 * pathname is retained), and propagates the seam's own error unchanged.
 */
function publishRecordExclusive(options) {
	const { serviceDir, prepDir, leafName, text, afterPrepare } = options || {};
	if (leafName !== READINESS_LEAF_NAME && leafName !== COMPLETION_LEAF_NAME) {
		throw new Error('an admitted lifecycle leaf name is required');
	}
	if (typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) {
		throw new Error('a bounded lifecycle record is required');
	}
	validateAncestors(serviceDir);
	validatePrepDir(prepDir, serviceDir);
	// Snapshot the admitted identities of both directory chains at publisher
	// admission. The comparison immediately before the link is what refuses a
	// replacement real directory at an admitted pathname; it stays a point-in-time
	// identity check, not an atomic containment claim.
	const publicationAncestors = [];
	for (const root of [serviceDir, prepDir]) {
		for (let dir = root; ; dir = path.dirname(dir)) {
			publicationAncestors.push([dir, fs.lstatSync(dir, { bigint: true })]);
			if (dir === path.dirname(dir)) break;
		}
	}
	const leafPath = path.join(serviceDir, leafName);
	try {
		fs.lstatSync(leafPath);
		throw new Error(`refusing to adopt the pre-existing lifecycle leaf ${leafPath}`);
	} catch (error) {
		if (!(error && error.code === 'ENOENT')) throw error;
	}

	prepSequence += 1;
	const prepPath = path.join(prepDir, `${leafName}.prep-${process.pid}-${prepSequence}`);
	const recordBytes = Buffer.from(text, 'utf8');
	let prepared;
	let fd = -1;
	try {
		try {
			// O_EXCL proves this publisher created the preparation leaf, so the
			// identity observed on its own descriptor is the ownership proof used
			// for cleanup — even when the write itself fails.
			fd = fs.openSync(prepPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
			const opened = fs.fstatSync(fd, { bigint: true });
			if (!opened.isFile() || opened.isSymbolicLink()) throw new Error('the preparation leaf is not a regular nonsymlink file');
			if (Number(opened.mode & 0o777n) !== 0o600) throw new Error('the preparation leaf is not owner-only');
			prepared = { dev: opened.dev, ino: opened.ino, size: 0n };
			if (fs.writeSync(fd, recordBytes) !== recordBytes.length) {
				throw new Error('the preparation leaf did not accept the complete record');
			}
			fs.fsyncSync(fd);
			const back = Buffer.alloc(recordBytes.length);
			let read = 0;
			while (read < back.length) {
				const n = fs.readSync(fd, back, read, back.length - read, read);
				if (n === 0) throw new Error('the preparation leaf did not read back the complete record');
				read += n;
			}
			if (!back.equals(recordBytes)) throw new Error('the preparation leaf bytes are not the published record');
			const stats = fs.fstatSync(fd, { bigint: true });
			if (stats.dev !== prepared.dev || stats.ino !== prepared.ino) {
				throw new Error('the preparation leaf changed identity while being written');
			}
			if (stats.size !== BigInt(recordBytes.length)) throw new Error('the preparation leaf does not carry the complete record');
			prepared.size = stats.size;
		} finally {
			if (fd >= 0) fs.closeSync(fd);
		}
	} catch (error) {
		// Nothing was published: give back only a preparation leaf this publisher
		// still positively owns, then fail closed.
		if (prepared) discardOwnPrepLeaf(prepPath, prepared);
		throw error;
	}

	// Revalidate immediately before the commit: the admitted ancestors as real
	// nonsymlink directories, then those ancestors' saved dev/ino identities, then
	// the preparation pathname's saved identity, type, permissions, size, and
	// bytes. A mismatch refuses publication before the final pathname can appear,
	// so publication never lands in a replacement directory, and data this
	// publisher no longer owns is retained by the identity-guarded cleanup below.
	try {
		// Only the private preparation leaf exists at this instant; the final
		// pathname is still absent. The seam stays inside this error-handling
		// region so a thrown seam is cleaned by the same identity-guarded
		// cleanup below instead of leaving its own definitely owned leaf behind.
		if (typeof afterPrepare === 'function') afterPrepare({ prepPath, leafPath });
		validateAncestors(serviceDir);
		validatePrepDir(prepDir, serviceDir);
		for (const [dir, before] of publicationAncestors) {
			const now = fs.lstatSync(dir, { bigint: true });
			if (!now.isDirectory() || now.isSymbolicLink()
				|| now.dev !== before.dev || now.ino !== before.ino) {
				throw new Error('publication directory ancestor changed; retain uncertain outputs');
			}
		}
		revalidatePrepLeaf(prepPath, prepared, recordBytes);
	} catch (error) {
		discardOwnPrepLeaf(prepPath, prepared);
		throw error;
	}

	try {
		try {
			fs.linkSync(prepPath, leafPath);
		} catch (error) {
			if (error && error.code === 'EEXIST') {
				throw new Error(`the lifecycle leaf pathname already exists; no overwrite performed (${leafPath})`);
			}
			throw error;
		}
		const committed = fs.lstatSync(leafPath, { bigint: true });
		if (!committed.isFile() || committed.isSymbolicLink()) throw new Error('the published lifecycle leaf is not a regular nonsymlink file');
		// Defense in depth behind the pre-commit revalidation: an unexpected
		// committed inode is a hard failure, and the unexpected leaf is retained
		// for inspection rather than deleting bytes of unknown provenance.
		if (committed.dev !== prepared.dev || committed.ino !== prepared.ino) {
			throw new Error('the published lifecycle leaf is not the prepared inode');
		}
		if (Number(committed.mode & 0o777n) !== 0o600) throw new Error('the published lifecycle leaf is not owner-only');
		if (committed.size !== BigInt(recordBytes.length)) throw new Error('the published lifecycle leaf is not the complete record');
	} catch (error) {
		// Nothing was committed: give back only a preparation leaf this publisher
		// still positively owns, then fail closed.
		discardOwnPrepLeaf(prepPath, prepared);
		throw error;
	}

	// The record is committed. Preparation cleanup is best-effort and never
	// reverses or disguises that commit.
	const prep = discardOwnPrepLeaf(prepPath, prepared);
	return {
		path: leafPath,
		prepPath,
		dev: prepared.dev,
		ino: prepared.ino,
		size: prepared.size,
		prepRemoved: prep.removed,
		prepRetainedReason: prep.reason,
	};
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
	const prepDir = process.env.PRG_BG_COUNT_JOB_PREP_DIR;
	try {
		// Pre-mutation refusal: confined service directory (including a
		// pre-existing readiness leaf) and the private preparation directory,
		// which must already exist and stay outside the record directory.
		validateServiceDir(serviceDir);
		validatePrepDir(prepDir, serviceDir);
	} catch (error) {
		fail(String(error && error.message ? error.message : error), 3);
	}

	// A restrictive umask keeps the readiness leaf owner-only even though the
	// service directory is already 0700.
	try { process.umask(0o077); } catch { /* best effort; the service dir is 0700 */ }

	const admittedAncestors = [];
	for (const root of [serviceDir, prepDir]) {
		for (let dir = root; ; dir = path.dirname(dir)) {
			admittedAncestors.push([dir, fs.lstatSync(dir, { bigint: true })]);
			if (dir === path.dirname(dir)) break;
		}
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
					publishRecordExclusive({
						serviceDir,
						prepDir,
						leafName: COMPLETION_LEAF_NAME,
						text: `${JSON.stringify({ pid: process.pid, port: boundPort, status: 'closed' })}\n`,
					});
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
			// Readiness becomes visible only as a complete record: the bytes land
			// on the private preparation leaf outside the record directory and the
			// ready.json pathname then appears through one exclusive hard link.
			publishRecordExclusive({
				serviceDir,
				prepDir,
				leafName: READINESS_LEAF_NAME,
				text: buildReadinessRecord(process.pid, address.port),
			});
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
	validatePrepDir,
	publishRecordExclusive,
};
