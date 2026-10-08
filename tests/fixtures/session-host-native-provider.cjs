'use strict';
/**
 * Test-only scripted provider for the native question UI/lifecycle proof
 * (session-host native question phase; see tests/session-host-native-question.test.ts).
 *
 * This extension is a FIXTURE, not a review gate: it registers Pi's exported
 * `fauxProvider` (from `@earendil-works/pi-ai`) as a complete Provider through
 * the public `pi.registerProvider(provider)` seam so an interactive TUI session
 * can run REAL agent-loop turns with a scripted `AskUserQuestion` tool call —
 * zero external AI/provider requests, no credentials, no network. It is loaded
 * via the public `--extension` seam next to the candidate extension under test;
 * production provider/settings behavior is untouched (the fixture only adds its
 * own test-namespaced provider and model).
 *
 * Determinism: fixed provider/model ids, fixed tool-call ids, a fixed message
 * timestamp, and `tokenSize: { min: 4, max: 4 }` so the faux stream's chunking
 * is stable. Responses are scripted through a turn-script file consumed in
 * order by model-request ordinal (the faux provider's own callCount), so a
 * multi-turn conversation (question run, answer run) is deterministic from the
 * test host without cross-process state.
 *
 * Environment contract (set by tests/session-host-native-question.test.ts):
 * - PRG_FIXTURE_AGENT_DIR   installed pi-coding-agent package root (pi-ai import)
 * - PRG_FIXTURE_STATE_DIR   fixture scratch state dir (turn script, journal)
 *
 * Turn script (`<stateDir>/turn-script.json`): `{"steps": [...]}` where each
 * step is one of:
 * - `{"toolCalls": [{"toolName": "...", "arguments": {...}}]}` — assistant
 *   message with those tool calls (stopReason "toolUse");
 * - `{"text": "..."}` — plain text (stopReason "stop");
 * - `{"echoLastUser": "prefix"}` — text = prefix + the last user message's
 *   text (stopReason "stop"); proves a UI-delivered answer reached the model
 *   context as an ordinary user message.
 * - `{"stopStartedShell": true}` — opt-in step for the background-count
 *   acceptance: it requires exactly ONE successful result whose explicit
 *   `toolName` identity is `ShellStart` AND whose explicit success metadata is
 *   `isError === false` (absent or ambiguous error/success metadata never
 *   becomes a success) in the model's own context, takes that exact returned
 *   public handle and pid (separate results are never collapsed by id, and
 *   unavailable/partial/ambiguous fails loudly), and emits a ShellStop tool
 *   call for that exact id. It journals only the bounded handle and numeric
 *   pid, never a prompt, transcript, argument, or preview.
 * A request without an available step ends with a stop text marker instead of
 * failing, so a mis-sequenced run is observable rather than fatal.
 *
 * Opt-in generic status journaling: when PRG_FIXTURE_JOURNAL_SHELL_STATUS=1,
 * the request journal carries ONLY bounded metadata (no `lastUserPreview` at
 * all) and every request additionally journals the bounded job rows of any
 * ShellList result already in context (id + closed status set only, no
 * label/command/output). The default (unset) behavior of every existing
 * consumer, including its request preview, is unchanged.
 *
 * Pure test seams: `module.exports.startedShellResults` / `.shellResultHandle`
 * / `.selectStopHandle` expose the same selection used by the step so
 * tests/session-host-native-background-counts.test.ts can prove the negative
 * cases (repeated ids, missing/wrong tool identity, absent success metadata,
 * partial results) and the named unavailable/ambiguous failure contract
 * without a runtime. They perform no IO and change no step behavior.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROVIDER_ID = 'prg-native-question';
const MODEL_ID = 'driven';
/** Fixed assistant-message timestamp for deterministic transcripts. */
const FIXED_TIMESTAMP = 1_750_000_000_000;
const STOP_TEXT = 'fixture-turn-script-exhausted';
/** Exact bounded public job id, never a guessed ordinal or file scan. */
const HANDLE_PATTERN = /^job\d{1,12}$/;
/** The closed set of ShellList job statuses the background shell can report. */
const SHELL_STATUS_PATTERN = /^(?:running|done|failed\(-?\d+\)|unverifiable)$/;

function boundedHandle(value) {
	return typeof value === 'string' && HANDLE_PATTERN.test(value) ? value : undefined;
}

function boundedShellStatus(value) {
	return typeof value === 'string' && SHELL_STATUS_PATTERN.test(value) ? value : undefined;
}

function boundedPid(value) {
	return Number.isSafeInteger(value) && value > 0 && value <= 2 ** 32 ? value : undefined;
}

function resultText(message) {
	const content = message && message.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
			.map((block) => block.text)
			.join('\n');
	}
	return '';
}

/**
 * Extract one exact handle from one successful ShellStart toolResult. The
 * result must carry the explicit `ShellStart` tool identity; the structured
 * `details` snapshot is preferred and the exact documented result text is the
 * only fallback source. Both a bounded job id and a bounded numeric pid are
 * required, so a partial or malformed result is never an accepted handle.
 */
function shellResultHandle(message) {
	if (!message || message.role !== 'toolResult') return undefined;
	if (message.toolName !== 'ShellStart') return undefined; // explicit tool identity
	// Explicit success metadata only: absent or ambiguous error/success state
	// never silently becomes a successful result.
	if (message.isError !== false) return undefined;
	const details = message.details && typeof message.details === 'object' ? message.details : undefined;
	let id;
	let pid;
	if (details && details.event === 'started') {
		id = boundedHandle(details.id);
		pid = boundedPid(details.pid);
	}
	if (!id) {
		const match = /(?:^|\n)Started "[^\n]*" as (job\d{1,12}) \(pid (\d{1,12})\)/.exec(resultText(message));
		if (match) {
			id = boundedHandle(match[1]);
			pid = boundedPid(Number(match[2]));
		}
	}
	return id === undefined || pid === undefined ? undefined : { id, pid };
}

/**
 * Every successful ShellStart result visible in the model's own context, in
 * order and WITHOUT collapsing separate results that happen to share an id:
 * job ids can repeat after an extension reload, so two results are two
 * results. A caller that needs one handle requires exactly one entry; zero or
 * more than one is unavailable/ambiguous and never a handle.
 */
function startedShellResults(messages) {
	const results = [];
	if (!Array.isArray(messages)) return results;
	for (const message of messages) {
		const handle = shellResultHandle(message);
		if (handle) results.push(handle);
	}
	return results;
}

/**
 * Pure stop-selection contract: exactly one identified successful ShellStart
 * result is a usable handle; zero or many are named failures (unavailable /
 * ambiguous), never a guess and never a silent success.
 */
function selectStopHandle(messages) {
	const results = startedShellResults(messages);
	if (results.length === 0) return { error: 'unavailable' };
	if (results.length > 1) return { error: 'ambiguous' };
	return { handle: results[0] };
}

/**
 * Bounded id/status rows of successful ShellList results already in context.
 * Only explicit `isError === false` results are admitted; a failed result or
 * one with absent/ambiguous success metadata contributes no rows, so a
 * matching done row can never satisfy settlement from an unsuccessful or
 * ambiguous ShellList. Conflicting provenance (the same job id reported with
 * different statuses across admitted results) fails closed: that id is
 * excluded rather than guessed.
 */
function shellListStatuses(messages) {
	const jobs = new Map();
	const conflicted = new Set();
	if (!Array.isArray(messages)) return [];
	for (const message of messages) {
		if (!message || message.role !== 'toolResult') continue;
		if (message.toolName !== 'ShellList') continue;
		if (message.isError !== false) continue; // explicit success metadata only
		const rows = [];
		const details = message.details && typeof message.details === 'object' ? message.details : undefined;
		if (details && Array.isArray(details.jobs)) {
			for (const job of details.jobs) {
				const id = job && boundedHandle(job.id);
				const status = job && boundedShellStatus(job.status);
				if (id && status) rows.push({ id, status });
			}
		} else {
			for (const line of resultText(message).split('\n')) {
				const match = /^(job\d{1,12})\s{2}(running|done|failed\(-?\d+\)|unverifiable)\b/.exec(line.trim());
				if (match) rows.push({ id: match[1], status: match[2] });
			}
		}
		for (const row of rows) {
			const existing = jobs.get(row.id);
			if (existing !== undefined && existing !== row.status) conflicted.add(row.id);
			jobs.set(row.id, row.status);
		}
	}
	return [...jobs.entries()]
		.filter(([id]) => !conflicted.has(id))
		.slice(0, 8)
		.map(([id, status]) => ({ id, status }));
}

function statePath(kind) {
	const dir = process.env.PRG_FIXTURE_STATE_DIR;
	if (!dir) return undefined;
	return path.join(dir, kind);
}

let metadataJournalIdentity;
function journal(event, fields) {
	const target = statePath('provider-journal.jsonl');
	if (!target) return;
	const line = `${JSON.stringify({ ts: Date.now(), event, ...fields })}\n`;
	if (process.env.PRG_FIXTURE_JOURNAL_SHELL_STATUS === '1') {
		// Opt-in only: bounded append to the original pre-created metadata leaf.
		// No creation, replacement, truncation or default-fixture behavior change.
		const before = fs.lstatSync(target, { bigint: true });
		if (!before.isFile() || before.isSymbolicLink() || Buffer.byteLength(line) > 4096
			|| before.size + BigInt(Buffer.byteLength(line)) > 256n * 1024n) throw new Error('metadata journal bounds refused');
		if (metadataJournalIdentity && (metadataJournalIdentity.dev !== before.dev || metadataJournalIdentity.ino !== before.ino)) throw new Error('metadata journal identity changed');
		const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		try {
			const opened = fs.fstatSync(fd, { bigint: true });
			if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('metadata journal descriptor changed');
			metadataJournalIdentity = { dev: opened.dev, ino: opened.ino };
			fs.writeFileSync(fd, line);
			const after = fs.lstatSync(target, { bigint: true });
			if (after.dev !== opened.dev || after.ino !== opened.ino || after.size > 256n * 1024n) throw new Error('metadata journal changed; retain output');
		} finally { fs.closeSync(fd); }
		return;
	}
	try {
		fs.appendFileSync(target, line, 'utf8');
	} catch (error) {
		process.stderr.write(`session-host-native-provider: journal write failed: ${String(error)}\n`);
	}
}

/** Load the faux provider helpers from the exact installed agent package (no ambient fallback). */
async function loadFauxModule(agentDir) {
	const candidates = [
		path.join(agentDir ?? '', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js'),
		path.join(agentDir ?? '', '..', 'pi-ai', 'dist', 'index.js'),
	].filter((candidate) => candidate.length > 1);
	let lastError;
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			try {
				try {
					return require(candidate);
				} catch (requireError) {
					// pi-ai is ESM-only without require conditions; require(esm)
					// is supported on the fixture's Node floor (>=22.19), but
					// fall through to dynamic import when it is not.
					return await import(candidate);
				}
			} catch (error) {
				lastError = error;
			}
		}
	}
	throw new Error(`session-host-native-provider: faux provider unavailable (last error: ${String(lastError)})`);
}

module.exports = async function (pi) {
	const agentDir = process.env.PRG_FIXTURE_AGENT_DIR;
	let faux;
	try {
		faux = await loadFauxModule(agentDir);
	} catch (error) {
		process.stderr.write(`${String(error)}\n`);
		journal('faux-provider-unavailable', { error: String(error) });
		return;
	}

	// --- Scripted model: complete faux Provider, responses from the turn script ---
	const provider = faux.fauxProvider({
		provider: PROVIDER_ID,
		tokenSize: { min: 4, max: 4 }, // deterministic chunking (no random token sizes)
		models: [{
			id: MODEL_ID,
			name: 'PRG Native Question Fixture Model',
			reasoning: false,
			input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 16_384,
		}],
	});

	function readTurnScript() {
		const target = statePath('turn-script.json');
		if (!target) return [];
		try {
			const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
			if (Array.isArray(parsed?.steps)) return parsed.steps;
		} catch {
			// Missing or torn file: fall through to the stop fallback.
		}
		return [];
	}

	function lastUserText(messages) {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message.role !== 'user') continue;
			if (typeof message.content === 'string') return message.content;
			if (Array.isArray(message.content)) {
				return message.content
					.filter((block) => block && block.type === 'text' && typeof block.text === 'string')
					.map((block) => block.text)
					.join('\n');
			}
			return '';
		}
		return '';
	}

	let contextMessages = [];

	function stepToMessage(step, requestIndex) {
		if (step?.stopStartedShell === true) {
			const selection = selectStopHandle(contextMessages);
			if (selection.error !== undefined) {
				throw new Error(
					`session-host-native-provider: stopStartedShell has no exact successful ShellStart result (${selection.error})`,
				);
			}
			const handle = selection.handle;
			journal('shell_handle_selected', { requestIndex, handle: handle.id, pid: handle.pid });
			return faux.fauxAssistantMessage([
				faux.fauxToolCall('ShellStop', { id: handle.id }, { id: `fixture:nq:${requestIndex}:stop` }),
			], { stopReason: 'toolUse', timestamp: FIXED_TIMESTAMP });
		}
		if (Array.isArray(step?.toolCalls) && step.toolCalls.length > 0) {
			return faux.fauxAssistantMessage([
				...(typeof step.text === 'string' && step.text ? [faux.fauxText(step.text)] : []),
				...step.toolCalls.map((call, callIndex) => faux.fauxToolCall(call.toolName, call.arguments ?? {}, {
					// Fixed ids: stable across runs for transcript assertions.
					id: `fixture:nq:${requestIndex}:${callIndex}`,
				})),
			], { stopReason: 'toolUse', timestamp: FIXED_TIMESTAMP });
		}
		if (typeof step?.echoLastUser === 'string') {
			return faux.fauxAssistantMessage(`${step.echoLastUser}${lastUserText(contextMessages)}`, {
				stopReason: 'stop',
				timestamp: FIXED_TIMESTAMP,
			});
		}
		if (typeof step?.text === 'string') {
			return faux.fauxAssistantMessage(step.text, { stopReason: 'stop', timestamp: FIXED_TIMESTAMP });
		}
		return faux.fauxAssistantMessage(STOP_TEXT, { stopReason: 'stop', timestamp: FIXED_TIMESTAMP });
	}

	// appendResponses queues a self-perpetuating factory: each stream call
	// consumes one queued step and re-queues the factory, so every REQUEST is
	// answered from the CURRENT turn script, sequenced by request ordinal.
	function respondFromScript(context) {
		provider.appendResponses([respondFromScript]);
		contextMessages = context?.messages ?? [];
		const requestIndex = provider.state.callCount - 1; // callCount was incremented for this request
		const metadataOnly = process.env.PRG_FIXTURE_JOURNAL_SHELL_STATUS === '1';
		// Opted-in background-count mode journals bounded metadata ONLY: the
		// request preview is omitted entirely, so no prompt/user text is ever
		// written. Every other consumer keeps its existing request preview.
		journal('model_request', {
			requestIndex,
			stepsAvailable: readTurnScript().length,
			...(metadataOnly ? {} : { lastUserPreview: lastUserText(contextMessages).slice(0, 400) }),
		});
		if (metadataOnly) {
			const shellStatuses = shellListStatuses(contextMessages);
			if (shellStatuses.length > 0) {
				journal('shell_list_status', { requestIndex, jobs: shellStatuses });
			}
		}
		return stepToMessage(readTurnScript()[requestIndex], requestIndex);
	}

	provider.appendResponses([respondFromScript]);
	pi.registerProvider(provider.provider);
	journal('provider_registered', { provider: PROVIDER_ID, model: MODEL_ID });

	// --- Auto-select the scripted model on every session start (public setModel seam) ---
	pi.on('session_start', async (_event, ctx) => {
		if (process.env.PRG_FIXTURE_NO_AUTO_MODEL === '1') {
			journal('auto_model_skipped', {});
			return;
		}
		const model = ctx?.modelRegistry?.find?.(PROVIDER_ID, MODEL_ID);
		if (!model) {
			journal('auto_model_missing', { provider: PROVIDER_ID, modelId: MODEL_ID });
			return;
		}
		const ok = await pi.setModel(model);
		journal(ok ? 'auto_model_selected' : 'auto_model_rejected', { provider: PROVIDER_ID, modelId: MODEL_ID });
	});
	pi.on('session_shutdown', () => {
		journal('provider_session_shutdown', {});
	});
};

// Pure selection seam for the source-authored negative coverage in
// tests/session-host-native-background-counts.test.ts. These perform no IO and
// change no step behavior; the extension factory above is still the default
// export Pi invokes.
module.exports.startedShellResults = startedShellResults;
module.exports.shellResultHandle = shellResultHandle;
module.exports.selectStopHandle = selectStopHandle;
module.exports.shellListStatuses = shellListStatuses;
