'use strict';
/**
 * In-session observation and scripted-model driver for the native Pi MCP
 * lifecycle fixture (issue #224 work; see tests/pi-native-mcp-fixture.ts).
 *
 * This extension is a FIXTURE, not a review gate: it exists so a native
 * `pi --mode rpc` session can (a) register MCP-independent observable state
 * and (b) run real agent-loop turns with tool calls without any provider API,
 * credential, or network use. It is loaded via the public
 * `pi --extension <path>` seam next to the candidate extension under test.
 *
 * 1. Scripted model provider. The installed Pi's own testing provider
 *    (`fauxProvider` from `@earendil-works/pi-ai`) is registered as a complete
 *    Provider. Responses are scripted through a turn-script file the fixture
 *    driver rewrites between prompts:
 *
 *      {"steps": [{"codemode": "return await tools.mcp__...__echo({message:'hi'})"},
 *                  {"text": "..."},
 *                  {"toolCalls": [...]}]}
 *
 *    `codemode` steps are the native path for reaching codemode-exposed MCP
 *    tools (the codemode tool is the model-facing entry; its scripts call the
 *    MCP tools through ctx.executeTool, where permission gates apply).
 *
 *    The faux provider handles the streaming event protocol (deltas, usage,
 *    stop reasons) in-process; network is never touched. Responses are chosen
 *    per model REQUEST by the number of assistant messages after the latest
 *    user message in the transcript, so a multi-call turn ("call, observe
 *    tool result, call again") is scripted deterministically from the test
 *    host. A request without an available step ends the turn with a stop
 *    text marker instead of failing.
 *
 * 2. Denial simulation (explicitly NOT the real gate). When the fixture
 *    driver writes a deny file, this extension blocks matching `tool_call`
 *    events through Pi's ordinary blocking seam — the same public seam the
 *    review gate and permission extensions use — so the fixture's
 *    denied-call instrumentation (never-attempted server calls, unchanged
 *    counter, error tool result) can be validated before a candidate is
 *    connected. Consumers of the fixture replace this with their candidate.
 *
 * 3. Observation dump. `/native-mcp-probe dump` writes the live session's
 *    registered tool inventory (names, exposure, namespace, annotations,
 *    source) and slash-command list to a file, so a consumer can assert MCP
 *    tool registration, exposure, and withdrawn-tool hiding without guessing
 *    at runtime internals.
 *
 * Environment contract (set by tests/pi-native-mcp-fixture.ts):
 * - PRG_FIXTURE_AGENT_DIR     installed pi-coding-agent package root (for the faux provider import)
 * - PRG_FIXTURE_STATE_DIR     fixture scratch state dir (turn script, probe dump, request journal)
 * - PRG_FIXTURE_DENY_FILE     optional deny simulation control file
 * - PRG_FIXTURE_NO_AUTO_MODEL when set to "1", session_start does NOT auto-select the scripted
 *                             model; the fixture must then select it itself (used by the
 *                             fixture's fallback-model-selection proof and by consumers
 *                             restoring their own model selection)
 * The probe registers two selectable faux models: `driven` (the default the
 * fixture awaits) and `other` (for foreign-selection fallback tests).
 * Files are under the fixture's own scratch dir; nothing user-level is read
 * or written beyond what Pi itself reads through its own hermetic environment.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROVIDER_ID = 'prg-fixture';
const MODEL_ID = 'driven';
const PROBE_PROCESS_STATE_KEY = Symbol.for('prg-native-mcp-probe.lifecycle.v1');
const CODEMODE_DEFAULT_ENV = 'PI_REVIEW_GATE_CODEMODE_DEFAULT';

function probeProcessState() {
	const slot = globalThis;
	let state = slot[PROBE_PROCESS_STATE_KEY];
	if (!state || typeof state !== 'object' || !(state.sessionManagerIds instanceof WeakMap)) {
		state = { factoryCount: 0, nextSessionManagerId: 1, sessionManagerIds: new WeakMap() };
		slot[PROBE_PROCESS_STATE_KEY] = state;
	}
	return state;
}

function sessionManagerId(sessionManager) {
	if ((typeof sessionManager !== 'object' || sessionManager === null) && typeof sessionManager !== 'function') return null;
	const state = probeProcessState();
	let id = state.sessionManagerIds.get(sessionManager);
	if (id === undefined) {
		id = state.nextSessionManagerId++;
		state.sessionManagerIds.set(sessionManager, id);
	}
	return id;
}

const DEFAULT_STATE_DIR = () => {
	const fallback = process.env.PRG_FIXTURE_STATE_DIR;
	if (fallback) return fallback;
	process.stderr.write('prg-native-mcp-probe: PRG_FIXTURE_STATE_DIR is not set; probe features are disabled\n');
	return undefined;
};

const STOP_TEXT = 'fixture-turn-script-exhausted';
/** Monotonic component for generated faux toolCall ids (unique across the pi process lifetime). */
let fauxCallSequence = 0;

function statePath(kind) {
	const dir = DEFAULT_STATE_DIR();
	if (!dir) return undefined;
	return path.join(dir, kind);
}

function journalProbe(event, fields) {
	const target = statePath('probe-journal.jsonl');
	if (!target) return;
	try {
		fs.appendFileSync(target, `${JSON.stringify({ ts: Date.now(), event, ...fields })}\n`, 'utf8');
	} catch (error) {
		process.stderr.write(`prg-native-mcp-probe: journal write failed: ${String(error)}\n`);
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
	throw new Error(`prg-native-mcp-probe: faux provider unavailable (last error: ${String(lastError)})`);
}

module.exports = async function (pi) {
	const lifecycleState = probeProcessState();
	const factoryId = ++lifecycleState.factoryCount;
	journalProbe('probe_factory_loaded', {
		factoryId,
		wrapperMarkerPresent: process.env[CODEMODE_DEFAULT_ENV] !== undefined,
	});
	const agentDir = process.env.PRG_FIXTURE_AGENT_DIR;
	let faux;
	try {
		faux = await loadFauxModule(agentDir);
	} catch (error) {
		process.stderr.write(`${String(error)}\n`);
		journalProbe('faux-provider-unavailable', { error: String(error) });
		return;
	}

	// --- Scripted model: complete faux Provider, responses from the turn script ---
	const provider = faux.fauxProvider({
		provider: PROVIDER_ID,
		// A second selectable model under the same provider exists so consumers
		// (and the fixture's own fallback proof, which simulates another
		// extension selecting a different model after session_start) can rely
		// on the id-differ branch of ensureScriptedModel().
		models: [{
			id: MODEL_ID,
			name: 'PRG Fixture Driven Model',
			reasoning: false,
			input: ['text'],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 16_384,
		}, {
			id: 'other',
			name: 'PRG Fixture Other Model',
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
		if (step && typeof step.message === 'object') {
			return faux.fauxAssistantMessage(step.message.content ?? STOP_TEXT, {
				stopReason: step.message.stopReason ?? 'stop',
			});
		}
		if (typeof step?.codemode === 'string') {
			// The native codemode seam: the model issues a toolCall for the active
			// `codemode` tool; the script calls MCP tools through ctx.executeTool,
			// so permission gates see the nested call exactly as they would a
			// script-produced call.
			return faux.fauxAssistantMessage([
				...(typeof step.text === 'string' && step.text ? [faux.fauxText(step.text)] : []),
				faux.fauxToolCall('codemode', { code: step.codemode }, { id: `fixture:${provider.state.callCount}:${requestIndex}:0:${fauxCallSequence++}` }),
			], { stopReason: 'toolUse' });
		}
		if (Array.isArray(step?.toolCalls) && step.toolCalls.length > 0) {
			return faux.fauxAssistantMessage([
				...(typeof step.text === 'string' && step.text ? [faux.fauxText(step.text)] : []),
				...step.toolCalls.map((call, callIndex) => faux.fauxToolCall(call.toolName, call.arguments ?? {}, {
					id: `fixture:${provider.state.callCount}:${requestIndex}:${callIndex}:${fauxCallSequence++}`,
				})),
			], { stopReason: 'toolUse' });
		}
		if (typeof step?.text === 'string') {
			return faux.fauxAssistantMessage(step.text, { stopReason: 'stop' });
		}
		return faux.fauxAssistantMessage(STOP_TEXT, { stopReason: 'stop' });
	}

	// appendResponses queues a self-perpetuating factory: each stream call
	// consumes one queued step and re-queues the factory, so every REQUEST is
	// answered from the CURRENT turn script (sequenced by the transcript's
	// assistant count since the last user message). No cross-process state.
	function respondFromScript(context) {
		provider.appendResponses([respondFromScript]);
		const steps = readTurnScript();
		const index = stepsSinceLastUser(context.messages);
		journalProbe('model_request', {
			requestIndex: index,
			stepsAvailable: steps.length,
			lastUserPreview: (() => {
				for (let i = context.messages.length - 1; i >= 0; i -= 1) {
					if (context.messages[i].role === 'user') {
						return String(JSON.stringify(context.messages[i].content)).slice(0, 400);
					}
				}
				return null;
			})(),
			mcpToolResults: context.messages
				.filter((message) => message.role === 'toolResult' && typeof message.toolName === 'string' && message.toolName.startsWith('mcp__'))
				.map((message) => ({
					toolName: message.toolName,
					isError: message.isError === true,
					text: String(message.content?.map((block) => block.type === 'text' ? block.text : `[${block.type}]`).join('\n') ?? '').slice(0, 300),
				})),
		});
		return stepToMessage(steps[index], index);
	}

	provider.appendResponses([respondFromScript]);

	pi.registerProvider(provider.provider);

	// --- Auto-select the scripted model on every session start (public setModel seam) ---
	// Skipped when the fixture requests a no-auto-model runtime so the fixture's
	// set_model fallback path is exercised instead.
	pi.on('session_start', async (_event, ctx) => {
		journalProbe('probe_session_start', {
			factoryId,
			sessionManagerId: sessionManagerId(ctx?.sessionManager),
			wrapperMarkerPresent: process.env[CODEMODE_DEFAULT_ENV] !== undefined,
		});
		if (process.env.PRG_FIXTURE_NO_AUTO_MODEL === '1') {
			journalProbe('auto_model_skipped', {});
			return;
		}
		const model = ctx.modelRegistry.find(PROVIDER_ID, MODEL_ID);
		if (!model) {
			journalProbe('auto_model_missing', { provider: PROVIDER_ID, modelId: MODEL_ID });
			return;
		}
		const ok = await pi.setModel(model);
		journalProbe(ok ? 'auto_model_selected' : 'auto_model_rejected', { provider: PROVIDER_ID, modelId: MODEL_ID });
	});
	pi.on('session_shutdown', (_event, ctx) => {
		journalProbe('probe_session_shutdown', {
			factoryId,
			sessionManagerId: sessionManagerId(ctx?.sessionManager),
			wrapperMarkerPresent: process.env[CODEMODE_DEFAULT_ENV] !== undefined,
		});
	});

	// --- Denial simulation: ordinary tool_call blocking, driven by a control file ---
	pi.on('tool_call', async (event) => {
		const target = statePath('deny.json');
		if (!target || !fs.existsSync(target)) return undefined;
		try {
			const deny = JSON.parse(fs.readFileSync(target, 'utf8'));
			if (Array.isArray(deny.tools) && deny.tools.includes(event.toolName)) {
				return { block: true, reason: typeof deny.reason === 'string' ? deny.reason : 'blocked by fixture denial simulation' };
			}
		} catch {
			// Torn deny file: do not block.
		}
		return undefined;
	});

	// --- Inventory dump command (native extension-command seam) ---
	pi.registerCommand('native-mcp-probe', {
		description: 'Write the live session tool/command inventory for the native MCP fixture',
		handler: async (args, ctx) => {
			const target = statePath('probe-dump.json');
			if (!target) return;
			try {
				const allTools = pi.getAllTools().map((tool) => ({
					name: tool.name,
					exposure: tool.exposure,
					namespace: tool.namespace === undefined || tool.namespace === null ? undefined : tool.namespace.name,
					annotations: tool.annotations,
					description: typeof tool.description === 'string' ? tool.description.slice(0, 200) : tool.description,
				}));
				const dump = {
					ts: Date.now(),
					requested: args.trim(),
					activeTools: [...pi.getActiveTools()],
					allTools,
					commands: ctx.getCommands ? ctx.getCommands().map((command) => command.name) : pi.getCommands().map((command) => command.name),
				};
				const temporal = `${target}.tmp`;
				fs.writeFileSync(temporal, JSON.stringify(dump, null, 2), 'utf8');
				fs.renameSync(temporal, target);
				journalProbe('dump_written', { requested: args.trim() });
			} catch (error) {
				journalProbe('dump_failed', { error: String(error) });
			}
		},
	});
};

module.exports.default = module.exports;