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
 * A request without an available step ends with a stop text marker instead of
 * failing, so a mis-sequenced run is observable rather than fatal.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROVIDER_ID = 'prg-native-question';
const MODEL_ID = 'driven';
/** Fixed assistant-message timestamp for deterministic transcripts. */
const FIXED_TIMESTAMP = 1_750_000_000_000;
const STOP_TEXT = 'fixture-turn-script-exhausted';

function statePath(kind) {
	const dir = process.env.PRG_FIXTURE_STATE_DIR;
	if (!dir) return undefined;
	return path.join(dir, kind);
}

function journal(event, fields) {
	const target = statePath('provider-journal.jsonl');
	if (!target) return;
	try {
		fs.appendFileSync(target, `${JSON.stringify({ ts: Date.now(), event, ...fields })}\n`, 'utf8');
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
		journal('model_request', {
			requestIndex,
			stepsAvailable: readTurnScript().length,
			lastUserPreview: lastUserText(contextMessages).slice(0, 400),
		});
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
