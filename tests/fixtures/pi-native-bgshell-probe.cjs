'use strict';
/**
 * In-session observation and scripted-model driver for the background-shell
 * exit-wake fixture (issue #281; see tests/pi-native-bgshell-wake-fixture.ts).
 *
 * This extension is a FIXTURE, not a review gate: it exists so a native
 * `pi --mode rpc` session can run real agent-loop turns with tool calls
 * without any provider API, credential, or network use, while journaling what
 * the model actually saw. It is loaded via the public `pi --extension <path>`
 * seam next to the candidate extension under test. Modeled on
 * tests/fixtures/pi-native-mcp-probe.cjs (same fauxProvider seam), reduced to
 * what the exit-wake regression needs:
 *
 * - one selectable scripted model (prg-fixture/driven);
 * - responses consumed from a turn-script file the fixture rewrites between
 *   runs. One step per model REQUEST, indexed by the number of assistant
 *   messages after the latest user message in the transcript — so a
 *   multi-call turn is scripted deterministically from the test host. A
 *   request without an available step ends the turn with a stop text marker
 *   instead of failing;
 * - a JSONL journal of run/message boundaries and, per model request, the tail
 *   of the transcript — so a consumer can prove what the owning session's
 *   model actually saw (including custom wake messages) WITHOUT any polling
 *   tool call.
 *
 * Environment contract (set by tests/pi-native-bgshell-wake-fixture.ts):
 * - PRG_FIXTURE_AGENT_DIR  installed pi-coding-agent package root (for the
 *                          faux provider import)
 * - PRG_FIXTURE_STATE_DIR  fixture scratch state dir (turn script, journal)
 * Files live under the fixture's own scratch dir; nothing user-level is read
 * or written beyond what Pi itself reads through its own hermetic environment.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROVIDER_ID = 'prg-fixture';
const MODEL_ID = 'driven';
const STOP_TEXT = 'prg-bgshell-turn-script-exhausted';
let callSequence = 0;

function statePath(kind) {
	const dir = process.env.PRG_FIXTURE_STATE_DIR;
	if (!dir) return undefined;
	return path.join(dir, kind);
}

function journal(event, fields) {
	const target = statePath('probe-journal.jsonl');
	if (!target) return;
	try {
		fs.appendFileSync(target, `${JSON.stringify({ ts: Date.now(), event, ...fields })}\n`, 'utf8');
	} catch (error) {
		process.stderr.write(`prg-bgshell-probe: journal write failed: ${String(error)}\n`);
	}
}

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
					return await import(candidate);
				}
			} catch (error) {
				lastError = error;
			}
		}
	}
	throw new Error(`prg-bgshell-probe: faux provider unavailable (last error: ${String(lastError)})`);
}

function previewMessage(message) {
	if (!message || typeof message !== 'object') return String(message);
	const out = { role: message.role };
	if (typeof message.customType === 'string') out.customType = message.customType;
	let text = '';
	if (typeof message.content === 'string') text = message.content;
	else if (Array.isArray(message.content)) {
		text = message.content.map((block) => {
			if (!block || typeof block !== 'object') return '';
			if (block.type === 'text') return String(block.text ?? '');
			if (block.type === 'toolCall') return `toolCall:${block.name}`;
			return `[${block.type}]`;
		}).join(' | ');
	}
	out.preview = text.slice(0, 400);
	return out;
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

	const provider = faux.fauxProvider({
		provider: PROVIDER_ID,
		models: [{
			id: MODEL_ID,
			name: 'PRG BG-Shell Driven Model',
			reasoning: false,
			input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 16_384,
		}],
	});

	function stepsSinceLastUser(messages) {
		let count = 0;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message.role === 'user') break;
			if (message.role === 'assistant') count += 1;
		}
		return count;
	}

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

	function stepToMessage(step, requestIndex) {
		if (Array.isArray(step?.toolCalls) && step.toolCalls.length > 0) {
			return faux.fauxAssistantMessage([
				...(typeof step.text === 'string' && step.text ? [faux.fauxText(step.text)] : []),
				...step.toolCalls.map((call, callIndex) => faux.fauxToolCall(call.toolName, call.arguments ?? {}, {
					id: `prg-bgshell:${provider.state.callCount}:${requestIndex}:${callIndex}:${callSequence++}`,
				})),
			], { stopReason: 'toolUse' });
		}
		if (typeof step?.text === 'string') {
			return faux.fauxAssistantMessage(step.text, { stopReason: 'stop' });
		}
		return faux.fauxAssistantMessage(STOP_TEXT, { stopReason: 'stop' });
	}

	function respondFromScript(context) {
		// The faux provider consumes queued responses; re-queue ourselves so
		// every subsequent model request in the session is scripted too.
		provider.appendResponses([respondFromScript]);
		const steps = readTurnScript();
		const index = stepsSinceLastUser(context.messages);
		journal('model_request', {
			requestIndex: index,
			stepsAvailable: steps.length,
			transcriptTail: context.messages.slice(-4).map(previewMessage),
		});
		return stepToMessage(steps[index], index);
	}

	provider.appendResponses([respondFromScript]);
	pi.registerProvider(provider.provider);

	pi.on('session_start', async (_event, ctx) => {
		journal('probe_session_start', {});
		const model = ctx.modelRegistry.find(PROVIDER_ID, MODEL_ID);
		if (!model) {
			journal('auto_model_missing', { provider: PROVIDER_ID, modelId: MODEL_ID });
			return;
		}
		const ok = await pi.setModel(model);
		journal(ok ? 'auto_model_selected' : 'auto_model_rejected', {});
	});

	for (const name of ['agent_start', 'agent_end', 'agent_settled']) {
		pi.on(name, () => journal(name, {}));
	}
	for (const name of ['message_start', 'message_end']) {
		pi.on(name, (event) => {
			const message = event?.message;
			journal(name, {
				role: message?.role,
				customType: message?.customType,
				preview: previewMessage(message)?.preview,
			});
		});
	}
};
