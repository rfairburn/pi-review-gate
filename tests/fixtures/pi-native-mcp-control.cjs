'use strict';

/**
 * Public-API controls for pi-native-tools-lifecycle.test.ts.
 *
 * The registration path intentionally calls only ExtensionAPI methods
 * (`registerMcpServer`, `unregisterMcpServer`, and `registerTool`). All state and effects stay in the native fixture's
 * synthetic scratch directory.
 */

const fs = require('node:fs');
const path = require('node:path');

const SERVER_NAME = 'prg_late_native';
const MODEL_ONLY_TOOL = 'prg_native_model_only';
const STATE_DIR = process.env.PRG_FIXTURE_STATE_DIR;
const EVENT_LOG = STATE_DIR ? path.join(STATE_DIR, 'public-control-events.jsonl') : undefined;
const MODEL_ONLY_EFFECTS = STATE_DIR ? path.join(STATE_DIR, 'model-only-effects.jsonl') : undefined;
const SERVER_ENTRY = path.join(__dirname, 'pi-native-mcp-server.cjs');

function record(event) {
	if (!EVENT_LOG) return;
	try {
		fs.appendFileSync(EVENT_LOG, `${JSON.stringify({ ts: Date.now(), ...event })}\n`, 'utf8');
	} catch (error) {
		process.stderr.write(`pi-native-mcp-control: event log failed: ${String(error)}\n`);
	}
}

function serverConfig() {
	return {
		command: process.execPath,
		args: [SERVER_ENTRY],
		enabled: true,
		timeout: 30,
		description: 'Synthetic late-registered MCP server for native lifecycle tests.',
		exposure: 'codemode',
		env: {
			PRG_FIXTURE_EVENT_LOG: path.join(STATE_DIR, 'event-log.jsonl'),
			PRG_FIXTURE_CONTROL_FILE: path.join(STATE_DIR, 'control.json'),
			PRG_FIXTURE_GENERATION_FILE: path.join(STATE_DIR, 'generation.json'),
			PRG_FIXTURE_COUNTER_FILE: path.join(STATE_DIR, 'counter.txt'),
		},
	};
}

async function registerServer(pi) {
	if (typeof pi.registerMcpServer !== 'function') {
		throw new Error('the native ExtensionAPI does not expose registerMcpServer');
	}
	const config = serverConfig();
	// Select the public call form from the method's declared argument count;
	// never inspect or replace Pi's private MCP registry/config manager.
	if (pi.registerMcpServer.length >= 2) {
		await pi.registerMcpServer(SERVER_NAME, config);
		return 'name-config';
	}
	await pi.registerMcpServer({ name: SERVER_NAME, ...config });
	return 'config-object';
}

async function unregisterServer(pi) {
	if (typeof pi.unregisterMcpServer !== 'function') {
		throw new Error('the native ExtensionAPI does not expose unregisterMcpServer');
	}
	await pi.unregisterMcpServer(SERVER_NAME);
}

function registerModelOnlyTool(pi) {
	if (typeof pi.registerTool !== 'function') throw new Error('the native ExtensionAPI does not expose registerTool');
	pi.registerTool({
		name: MODEL_ONLY_TOOL,
		label: 'Synthetic model-only effect probe',
		description: 'Records a synthetic side effect if this model-only tool executes.',
		exposure: 'model-only',
		parameters: {
			type: 'object',
			properties: {},
			additionalProperties: false,
		},
		execute: async (toolCallId, input) => {
			if (MODEL_ONLY_EFFECTS) {
				fs.appendFileSync(MODEL_ONLY_EFFECTS, `${JSON.stringify({ toolCallId, input })}\n`, 'utf8');
			}
			return { content: [{ type: 'text', text: 'synthetic model-only effect recorded' }] };
		},
	});
}

module.exports = async function piNativeMcpControl(pi) {
	if (!STATE_DIR) throw new Error('PRG_FIXTURE_STATE_DIR is not set');
	pi.registerCommand('native-mcp-control', {
		description: 'Control the synthetic native MCP lifecycle fixture through public Pi APIs',
		handler: async (args) => {
			const action = args.trim();
			try {
				let result;
				if (action === 'register') result = { registrationForm: await registerServer(pi) };
				else if (action === 'register-model-only') {
					registerModelOnlyTool(pi);
					result = { tool: MODEL_ONLY_TOOL };
				} else if (action === 'unregister') {
					await unregisterServer(pi);
					result = {};
				} else throw new Error(`unsupported fixture action: ${action}`);
				record({ action, server: SERVER_NAME, ok: true, ...result });
			} catch (error) {
				record({ action, server: SERVER_NAME, ok: false, error: String(error) });
				throw error;
			}
		},
	});
};

module.exports.default = module.exports;
