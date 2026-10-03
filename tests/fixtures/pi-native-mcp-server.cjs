'use strict';
/**
 * Anonymized synthetic MCP stdio server for native Pi MCP lifecycle fixture
 * tests (issue #224 work; see tests/pi-native-mcp-fixture.ts).
 *
 * Design goals (all without any secret, credential, or real project data):
 * - Speak the plain newline-delimited JSON-RPC stdio framing Pi's MCP client
 *   (@earendil-works/pi-mcp StdioTransport) actually uses, so the native MCP
 *   extension connects to a real inproc-protocol server process.
 * - Expose only anonymous, nonsecret tools (`echo`, `counter`) with static
 *   descriptions and MCP annotations, so permission/gate behavior can be
 *   exercised without touching provider APIs or user data.
 * - Emit append-only JSONL instrumentation for every protocol event so a
 *   consumer can prove: initialize (per connection), tools/list, tools/call
 *   success, never-attempted calls (denials), list_changed notifications, and
 *   shutdown — across multiple server processes (reconnects spawn new ones).
 * - Support a file-based control channel for the fixture driver: rotate the
 *   advertised tool list (sends `notifications/tools/list_changed`, which Pi
 *   must answer with a refreshed tools/list) and exit on demand (server-side
 *   disconnect, after which Pi's next call reconnects).
 *
 * Tool availability follows a generation read from the control file:
 *   generation 1: [echo, counter]
 *   generation >= 2: [echo_second, counter]
 * so a rotation both ADDS `echo_second` and WITHDRAWS `echo`, exercising
 * tool-list replacement end to end. The counter file is shared between server
 * processes, so denied calls are provable as "counter did not advance and no
 * tools/call event was logged".
 *
 * Environment contract (all paths under the fixture's own scratch dir):
 * - PRG_FIXTURE_EVENT_LOG    JSONL event log (required)
 * - PRG_FIXTURE_CONTROL_FILE command control JSON file (required)
 * - PRG_FIXTURE_GENERATION_FILE advertised tool-list generation JSON (required)
 * - PRG_FIXTURE_COUNTER_FILE counter state file (required)
 * Exits when stdin closes (per the MCP stdio shutdown convention) — except
 * after stdin already closed, where the fallback below applies.
 */

const fs = require('node:fs');
const path = require('node:path');

// Protocol versions this server accepts, mirroring the client's supported list.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_NAME = 'prg-native-mcp-fixture-server';
const SERVER_VERSION = '1.0.0';
const SERVER_INSTRUCTIONS =
	'Anonymized fixture MCP server for pi-review-gate native lifecycle tests. '
	+ 'It only echoes fixture text and counts fixture-local attempts; it holds no project data.';

const EVENT_LOG = process.env.PRG_FIXTURE_EVENT_LOG;
const CONTROL_FILE = process.env.PRG_FIXTURE_CONTROL_FILE;
const GENERATION_FILE = process.env.PRG_FIXTURE_GENERATION_FILE;
const COUNTER_FILE = process.env.PRG_FIXTURE_COUNTER_FILE;

function fail(message) {
	// Never write to stdout (it is protocol traffic); stderr is where Pi
	// collects a failing server's tail.
	process.stderr.write(`${SERVER_NAME}: ${message}\n`);
	process.exit(2);
}

for (const [label, value] of [
	['PRG_FIXTURE_EVENT_LOG', EVENT_LOG],
	['PRG_FIXTURE_CONTROL_FILE', CONTROL_FILE],
	['PRG_FIXTURE_GENERATION_FILE', GENERATION_FILE],
	['PRG_FIXTURE_COUNTER_FILE', COUNTER_FILE],
]) {
	if (!value) fail(`missing required environment variable ${label}`);
}

/** Instrumentation is append-only, best-effort; it must never break the protocol. */
function log(event, fields) {
	try {
		fs.appendFileSync(
			EVENT_LOG,
			`${JSON.stringify({ ts: Date.now(), pid: process.pid, event, ...fields })}\n`,
			'utf8',
		);
	} catch (error) {
		process.stderr.write(`${SERVER_NAME}: instrumentation write failed: ${String(error)}\n`);
	}
}

// ---------------------------------------------------------------------------
// Tool catalog (generation-dependent anonymous tools)
// ---------------------------------------------------------------------------

function toolList(generation) {
	const echoName = generation >= 2 ? 'echo_second' : 'echo';
	return [
		{
			name: echoName,
			description: `Anonymous fixture echo tool (tools-list generation ${generation}). `
				+ 'Returns the fixture text it received. Holds no project data and sends nothing anywhere.',
			inputSchema: {
				type: 'object',
				properties: { message: { type: 'string', description: 'Fixture text to echo back.' } },
				required: ['message'],
				additionalProperties: false,
			},
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		{
			name: 'counter',
			description: `Anonymous fixture attempt counter (tools-list generation ${generation}). `
				+ 'Increments a fixture-local counter file and returns the new count. Touches only the fixture scratch dir.',
			inputSchema: {
				type: 'object',
				properties: { label: { type: 'string', description: 'Optional fixture label recorded with the attempt.' } },
				required: [],
				additionalProperties: false,
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
	];
}

function toolNames(generation) {
	return toolList(generation).map((tool) => tool.name);
}

/**
 * Current generation. The generation file owns it (commands and rotation state
 * are separate so exit-server never regresses a rotation); startup re-reads it
 * so reconnects inherit the rotated catalog.
 */
function currentGeneration() {
	try {
		const state = JSON.parse(fs.readFileSync(GENERATION_FILE, 'utf8'));
		if (Number.isInteger(state.generation) && state.generation >= 1) return state.generation;
	} catch {
		// No generation file yet: stay at generation 1.
	}
	return 1;
}

function handleToolCall(tool, args, requestId) {
	if (tool === 'counter') {
		const next = bumpCounter();
		log('tool_result', { id: requestId, tool, count: next });
		return {
			content: [{ type: 'text', text: `counter:${next}` }],
			structuredContent: { tool, count: next },
		};
	}
	// echo / echo_second: the message is caller-provided fixture text only.
	const message = typeof args.message === 'string' ? args.message : '';
	log('tool_result', { id: requestId, tool, messageChars: message.length });
	return {
		content: [{ type: 'text', text: `echo:${message}` }],
		structuredContent: { tool, message },
	};
}

/**
 * Increment the shared counter file with a read-verify-retry loop so brief
 * overlap between a dying and a reconnecting server process cannot lose or
 * double an increment (the value is shared across reconnects by design).
 */
function bumpCounter() {
	for (let attempt = 0; attempt < 10; attempt += 1) {
		let before = 0;
		try {
			const parsed = Number.parseInt(fs.readFileSync(COUNTER_FILE, 'utf8').trim(), 10);
			if (Number.isInteger(parsed) && parsed >= 0) before = parsed;
		} catch {
			// No counter yet.
		}
		const after = before + 1;
		const temporal = `${COUNTER_FILE}.${process.pid}.tmp`;
		try {
			fs.writeFileSync(temporal, `${after}\n`, { encoding: 'utf8', mode: 0o600 });
			fs.renameSync(temporal, COUNTER_FILE);
		} catch (error) {
			log('counter_write_failed', { error: String(error) });
			return 0;
		}
		// Only return if we still own the value we wrote (another server
		// process may have replaced it in between).
		try {
			if (fs.readFileSync(COUNTER_FILE, 'utf8').trim() === String(after)) return after;
		} catch (error) {
			log('counter_read_failed', { error: String(error) });
			return 0;
		}
	}
	return 0;
}

// ---------------------------------------------------------------------------
// JSON-RPC protocol loop
// ---------------------------------------------------------------------------

let advertisedGeneration = currentGeneration();

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function replyResult(id, result) {
	send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
	send({ jsonrpc: '2.0', id, error: { code, message, data: { server: SERVER_NAME } } });
}

function rotateTo(generation) {
	if (advertisedGeneration === generation) return;
	advertisedGeneration = generation;
	log('list_changed', { generation });
	send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
}

fs.watchFile(CONTROL_FILE, { interval: 100 }, () => {
	try {
		const control = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
		if (control.command === 'exit-server') {
			log('control_exit');
			fs.unwatchFile(CONTROL_FILE);
			process.exit(0);
		}
	} catch {
		// Torn or partial control content: wait for the next complete write.
	}
});

// Rotation is generation-state driven: applying it is idempotent, so a
// reconnecting process re-reads the current generation at initialize.
fs.watchFile(GENERATION_FILE, { interval: 100 }, () => {
	try {
		const state = JSON.parse(fs.readFileSync(GENERATION_FILE, 'utf8'));
		if (Number.isInteger(state.generation) && state.generation >= 1) rotateTo(state.generation);
	} catch {
		// Torn generation content: wait for the next complete write.
	}
});

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
	buffer += chunk;
	for (;;) {
		const newline = buffer.indexOf('\n');
		if (newline < 0) break;
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		if (!line) continue;
		let message;
		try {
			message = JSON.parse(line);
		} catch (error) {
			log('malformed_input', { error: String(error) });
			continue;
		}
		handleMessage(message);
	}
});
process.stdin.on('end', () => {
	log('shutdown', { reason: 'stdin-closed' });
	process.exit(0);
});

// Lifetime: the server lives exactly as long as its stdin stays open and the
// control channel does not command an exit. No wall-clock self-termination —
// a lifecycle test's idle connection older than any timeout must keep serving
// (Pi closes stdin per the MCP stdio shutdown convention, so nothing can hang).

function handleMessage(message) {
	// Notifications carry no id and must not be answered.
	if (message.jsonrpc !== '2.0') {
		if (message.id !== undefined) replyError(message.id, -32600, `Unsupported JSON-RPC envelope: ${JSON.stringify(message.jsonrpc)}`);
		return;
	}
	if (message.method === undefined) {
		// A response to something we never sent: instrument, ignore.
		log('unexpected_response', { id: message.id });
		return;
	}
	switch (message.method) {
		case 'initialize': {
			const requested = message.params?.protocolVersion;
			const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-06-18';
			log('initialize', {
				clientName: message.params?.clientInfo?.name,
				protocolVersion,
				capabilities: message.params?.capabilities,
			});
			// Advertise the rotated catalog immediately when the control file
			// was written between processes.
			advertisedGeneration = currentGeneration();
			replyResult(message.id, {
				protocolVersion,
				capabilities: { tools: { listChanged: true } },
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
				instructions: SERVER_INSTRUCTIONS,
			});
			return;
		}
		case 'notifications/initialized':
			log('initialized');
			return;
		case 'notifications/cancelled':
			log('cancelled', { id: message.params?.requestId });
			return;
		case 'ping':
			log('ping');
			replyResult(message.id, {});
			return;
		case 'tools/list': {
			const tools = toolList(advertisedGeneration);
			log('tools_list', { id: message.id, generation: advertisedGeneration, tools: toolNames(advertisedGeneration) });
			replyResult(message.id, { tools });
			return;
		}
		case 'tools/call': {
			const tool = typeof message.params?.name === 'string' ? message.params.name : '';
			const args = message.params?.arguments ?? {};
			log('tool_call', { id: message.id, generation: advertisedGeneration, tool, arguments: args });
			if (!toolNames(advertisedGeneration).includes(tool)) {
				// Unknown for this generation (a withdrawn tool must never execute).
				log('tool_call_unknown', { id: message.id, tool });
				replyError(message.id, -32602, `Unknown tool for generation ${advertisedGeneration}: ${tool}`);
				return;
			}
			try {
				replyResult(message.id, handleToolCall(tool, args, message.id));
			} catch (error) {
				log('tool_result_failed', { id: message.id, tool, error: String(error) });
				replyResult(message.id, {
					content: [{ type: 'text', text: `fixture tool failed: ${String(error)}` }],
					isError: true,
				});
			}
			return;
		}
		default:
			log('unknown_method', { method: message.method });
			if (message.id !== undefined) {
				replyError(message.id, -32601, `Method not implemented by ${SERVER_NAME}: ${message.method}`);
			}
	}
}

log('server_start', {
	argv: process.argv.slice(2),
	eventLog: path.basename(EVENT_LOG),
	generation: advertisedGeneration,
});