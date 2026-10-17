'use strict';
/**
 * Deterministic, credential-free probe extension for the scoped tool-denial
 * manual sandbox (issue #434). This is a FIXTURE, not a review-gate feature: it
 * exists so a human can run a real Pi session — and a real review-gate Pi
 * executor child — with no provider API key and no network, then observe how
 * the candidate's `tools.topLevelDeny` / `tools.executorDeny` lists act on a
 * synthetic third-party tool.
 *
 * What it does:
 * 1. Registers a synthetic `SyntheticNotify` tool with `deferred` exposure, so
 *    it is an authorized discovery candidate that is not initially active. Its
 *    only effect is appending one JSONL line to `PRG_TOOL_DENIAL_LOG`. It sends
 *    no notification and touches nothing else. It stays reachable by a direct
 *    model call, by `tool_search` activation, and by a codemode script's
 *    `ctx.executeTool`, so all deny paths can be exercised.
 * 2. When the installed Pi package resolves, registers a scripted faux provider
 *    (`prg-tool-denial/driven`) and auto-selects it at session start, so a
 *    model request is answered with no credential or network.
 * 3. Answers the first assistant turn after each user message from the user's
 *    own text: a message mentioning dispatch/executor/subtask scripts a
 *    `SubtasksStart` execute task (which reaches a NEW real executor child); a
 *    message mentioning codemode/script/nested scripts a `codemode` call; any
 *    other message calls `SyntheticNotify` directly. Later turns stop with a
 *    short text. `PRG_TOOL_DENIAL_STATE_DIR/turn-script.json` overrides this
 *    with the native fixture `{ "steps": [...] }` shape when present.
 *
 * Environment (set by the sandbox stager):
 * - `PRG_TOOL_DENIAL_LOG`              JSONL path for every SyntheticNotify call.
 * - `PRG_TOOL_DENIAL_STATE_DIR`       optional turn-script directory.
 * - `PRG_TOOL_DENIAL_INSTALLED_AGENT` installed `pi-coding-agent` package root
 *                                    (used to resolve `@earendil-works/pi-ai`).
 * - `PRG_TOOL_DENIAL_NO_MODEL=1`      do not register/select the faux provider;
 *                                    the launch command supplies a real model.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROVIDER_ID = 'prg-tool-denial';
const MODEL_ID = 'driven';
const TOOL_NAME = 'SyntheticNotify';

/** Append one JSONL observation; never throws into the host. */
function appendLog(entry) {
	const target = process.env.PRG_TOOL_DENIAL_LOG;
	if (!target) return;
	try {
		fs.appendFileSync(target, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`, 'utf8');
	} catch (error) {
		process.stderr.write(`prg-tool-denial-probe: log write failed: ${String(error)}\n`);
	}
}

/** Resolve the installed Pi's `pi-ai` package (its public faux provider) or throw. */
async function loadFauxModule(installedAgentRoot) {
	const candidates = [
		path.join(installedAgentRoot ?? '', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js'),
		path.join(installedAgentRoot ?? '', '..', 'pi-ai', 'dist', 'index.js'),
	].filter((candidate) => candidate.length > 1);
	let lastError;
	for (const candidate of candidates) {
		if (!fs.existsSync(candidate)) continue;
		try {
			try {
				return require(candidate);
			} catch {
				// pi-ai is ESM-only without require conditions; Node >= 22.19 can
				// require ESM, but fall through to dynamic import when it cannot.
				return await import(candidate);
			}
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`pi-ai faux provider unavailable (last error: ${String(lastError)})`);
}

/** Flatten the newest user message's text content. */
function lastUserText(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== 'user') continue;
		if (typeof message.content === 'string') return message.content;
		if (Array.isArray(message.content)) {
			return message.content.map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join(' ');
		}
		return '';
	}
	return '';
}

/** Assistant turns since the newest user message, the request's script index. */
function assistantTurnsSinceUser(messages) {
	let count = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === 'user') break;
		if (messages[index].role === 'assistant') count += 1;
	}
	return count;
}

module.exports = async function (pi) {
	// 1. Synthetic third-party tool. No notification, no network: one log line.
	pi.registerTool({
		name: TOOL_NAME,
		label: 'Synthetic Notify',
		description: 'Synthetic third-party notification stand-in for scoped tool-denial testing; records one local line and sends nothing.',
		exposure: 'deferred',
		parameters: {
			type: 'object',
			additionalProperties: false,
			required: ['message'],
			properties: {
				message: { type: 'string', description: 'Probe message recorded in the local JSONL log.' },
			},
		},
		// Pi's tool contract is execute(toolCallId, params, signal, onUpdate, ctx): the
		// session context is the FIFTH argument. Taking it from the third position
		// silently leaves `ctx.cwd` undefined in the JSONL observation.
		async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
			const message = typeof args?.message === 'string' ? args.message : '';
			const cwd = typeof ctx?.cwd === 'string' ? ctx.cwd : undefined;
			appendLog({
				event: 'tool_call',
				tool: TOOL_NAME,
				caller: process.env.PI_REVIEW_GATE_RUNTIME_ROLE ?? 'primary',
				message,
				cwd,
			});
			return {
				content: [{ type: 'text', text: `${TOOL_NAME} recorded one local probe line (no notification sent).` }],
				// `details` is a required member of Pi's AgentToolResult.
				details: { tool: TOOL_NAME, message, cwd },
			};
		},
	});
	appendLog({ event: 'probe_loaded', role: process.env.PI_REVIEW_GATE_RUNTIME_ROLE ?? 'primary', pid: process.pid });

	// A read-only observation command: write the live inventory and active set.
	pi.registerCommand('tool-denial-dump', {
		description: 'Write the live Pi tool inventory and active set for the tool-denial sandbox',
		handler: async (_args, ctx) => {
			const dir = process.env.PRG_TOOL_DENIAL_STATE_DIR;
			if (!dir) return;
			try {
				const dump = {
					ts: Date.now(),
					role: process.env.PI_REVIEW_GATE_RUNTIME_ROLE ?? 'primary',
					activeTools: [...pi.getActiveTools()],
					allTools: pi.getAllTools().map((tool) => ({
						name: tool.name,
						exposure: tool.exposure,
						sourceInfo: tool.sourceInfo && typeof tool.sourceInfo === 'object'
							? { path: tool.sourceInfo.path, source: tool.sourceInfo.source }
							: undefined,
					})),
					commands: (ctx?.getCommands ? ctx.getCommands() : pi.getCommands()).map((command) => command.name),
				};
				fs.writeFileSync(path.join(dir, `dump-${process.pid}.json`), JSON.stringify(dump, null, 2), 'utf8');
			} catch (error) {
				process.stderr.write(`prg-tool-denial-probe: dump failed: ${String(error)}\n`);
			}
		},
	});

	// 2. Scripted faux provider (credential-free model turns). Optional: a
	//    real-model sandbox sets PRG_TOOL_DENIAL_NO_MODEL=1 and supplies --model.
	if (process.env.PRG_TOOL_DENIAL_NO_MODEL === '1') return;

	let faux;
	try {
		faux = await loadFauxModule(process.env.PRG_TOOL_DENIAL_INSTALLED_AGENT);
	} catch (error) {
		process.stderr.write(`prg-tool-denial-probe: ${String(error)}; falling back to the ambient model selection\n`);
		return;
	}

	const provider = faux.fauxProvider({
		provider: PROVIDER_ID,
		models: [{
			id: MODEL_ID,
			name: 'PRG Tool-Denial Fixture Model',
			reasoning: false,
			input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 16_384,
		}],
	});

	/** The native fixture turn-script shape, when a state dir supplies one. */
	function readTurnScript() {
		const dir = process.env.PRG_TOOL_DENIAL_STATE_DIR;
		if (!dir) return [];
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'turn-script.json'), 'utf8'));
			if (Array.isArray(parsed?.steps)) return parsed.steps;
		} catch {
			// Missing or torn file: use the built-in default.
		}
		return [];
	}

	function scriptedMessage(step, index) {
		if (step && typeof step.message === 'object') {
			return faux.fauxAssistantMessage(step.message.content ?? 'done', {
				stopReason: step.message.stopReason ?? 'stop',
			});
		}
		if (typeof step?.codemode === 'string') {
			return faux.fauxAssistantMessage(
				faux.fauxToolCall('codemode', { code: step.codemode }, { id: `prg-tool-denial:codemode:${index}` }),
				{ stopReason: 'toolUse' },
			);
		}
		if (Array.isArray(step?.toolCalls) && step.toolCalls.length > 0) {
			return faux.fauxAssistantMessage(
				step.toolCalls.map((call, callIndex) => faux.fauxToolCall(call.toolName, call.arguments ?? {}, {
					id: `prg-tool-denial:${index}:${callIndex}`,
				})),
				{ stopReason: 'toolUse' },
			);
		}
		if (typeof step?.text === 'string') {
			return faux.fauxAssistantMessage(step.text, { stopReason: 'stop' });
		}
		return undefined;
	}

	/** Default deterministic response keyed off the runtime role and newest user message. */
	function defaultMessage(context, index) {
		const role = process.env.PI_REVIEW_GATE_RUNTIME_ROLE ?? 'primary';
		if (role === 'executor') {
			// Inside a real executor child the scripted model just exercises the
			// probe tool through the worker's own discovery path.
			if (index === 0) {
				return faux.fauxAssistantMessage(
					faux.fauxToolCall('tool_search', { query: TOOL_NAME }, { id: `prg-tool-denial:executor-search:${index}` }),
					{ stopReason: 'toolUse' },
				);
			}
			if (index === 1) {
				return faux.fauxAssistantMessage(
					faux.fauxToolCall(TOOL_NAME, { message: 'executor-probe' }, { id: `prg-tool-denial:executor:${index}` }),
					{ stopReason: 'toolUse' },
				);
			}
			return faux.fauxAssistantMessage('Executor probe complete.', { stopReason: 'stop' });
		}
		const text = lastUserText(context.messages);
		const wantsDispatch = /\b(dispatch|executor|subtask|worker)\b/i.test(text);
		const wantsCodemode = /\b(codemode|script|nested)\b/i.test(text);
		if (index === 0) {
			// The probe tool is a deferred discovery candidate: activate it first,
			// exactly as a real session would, then call it on the next request.
			if (wantsDispatch) {
				return faux.fauxAssistantMessage(
					faux.fauxToolCall('SubtasksStart', {
						kind: 'execute',
						tasks: [{
							title: 'tool-denial executor probe',
							instructions: 'Call SyntheticNotify once with message "executor-probe". If it is unavailable or denied, reply DENIED with the reason and stop.',
							acceptanceCriteria: ['The synthetic probe tool was called, or the refusal reason is reported.'],
						}],
					}, { id: `prg-tool-denial:dispatch:${index}` }),
					{ stopReason: 'toolUse' },
				);
			}
			return faux.fauxAssistantMessage(
				faux.fauxToolCall('tool_search', { query: wantsCodemode ? 'codemode' : TOOL_NAME }, { id: `prg-tool-denial:search:${index}` }),
				{ stopReason: 'toolUse' },
			);
		}
		if (index === 1) {
			if (wantsDispatch) {
				return faux.fauxAssistantMessage('Dispatched the executor probe task; see the executor session and the JSONL log.', { stopReason: 'stop' });
			}
			if (wantsCodemode) {
				return faux.fauxAssistantMessage(
					faux.fauxToolCall('codemode', {
						code: `return await tools.SyntheticNotify({ message: "nested-probe" });`,
					}, { id: `prg-tool-denial:codemode:${index}` }),
					{ stopReason: 'toolUse' },
				);
			}
			return faux.fauxAssistantMessage(
				faux.fauxToolCall(TOOL_NAME, { message: 'direct-probe' }, { id: `prg-tool-denial:direct:${index}` }),
				{ stopReason: 'toolUse' },
			);
		}
		return faux.fauxAssistantMessage(
			'SyntheticNotify probe turn complete; inspect the JSONL log for exactly which calls executed.',
			{ stopReason: 'stop' },
		);
	}

	// Each stream call consumes one step and re-queues the factory, so every
	// request is answered from the CURRENT turn script with no cross-process state.
	function respond(context) {
		provider.appendResponses([respond]);
		const index = assistantTurnsSinceUser(context.messages);
		const scripted = readTurnScript();
		if (scripted.length > 0) {
			const message = scriptedMessage(scripted[Math.min(index, scripted.length - 1)], index);
			if (message) return message;
		}
		return defaultMessage(context, index);
	}

	provider.appendResponses([respond]);
	try {
		pi.registerProvider(provider.provider);
	} catch (error) {
		process.stderr.write(`prg-tool-denial-probe: provider registration failed: ${String(error)}\n`);
		return;
	}

	pi.on('session_start', async (_event, ctx) => {
		appendLog({ event: 'session_start', role: process.env.PI_REVIEW_GATE_RUNTIME_ROLE ?? 'primary', pid: process.pid });
		if (process.env.PRG_TOOL_DENIAL_NO_AUTO_MODEL === '1') return;
		const model = ctx?.modelRegistry?.find?.(PROVIDER_ID, MODEL_ID);
		if (!model) return;
		await pi.setModel(model);
	});
};

module.exports.default = module.exports;
