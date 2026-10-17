'use strict';
/**
 * Test-owned child-side observation fixture for the shipped scoped tool-denial
 * sandbox (issue #434). It is NOT part of the shipped product surface: the
 * integration suite copies it into the sandbox agent's `extensions/`
 * directory, where ONLY a review-gate executor child auto-discovers it (the
 * primary is launched with `--no-extensions` plus explicit `-e` paths).
 *
 * It registers no tools and changes no policy. It only appends one JSONL line
 * per Pi extension event into `PRG_TOOL_DENIAL_OBSERVER_LOG`, so the test can
 * observe, from inside the real child process, that a tool was actually
 * ATTEMPTED, what its result was, and that the child reached a settled
 * boundary — instead of inferring denial from the absence of a success log.
 */

const fs = require('node:fs');

function append(entry) {
	const target = process.env.PRG_TOOL_DENIAL_OBSERVER_LOG;
	if (!target) return;
	try {
		fs.appendFileSync(target, `${JSON.stringify({
			ts: Date.now(),
			role: process.env.PI_REVIEW_GATE_RUNTIME_ROLE ?? 'primary',
			pid: process.pid,
			...entry,
		})}\n`, 'utf8');
	} catch (error) {
		process.stderr.write(`prg-tool-denial-observer: log write failed: ${String(error)}\n`);
	}
}

/** Flatten a Pi tool result's model-visible text, bounded. */
function resultText(result) {
	try {
		if (result && Array.isArray(result.content)) {
			return result.content
				.map((block) => (block && typeof block.text === 'string' ? block.text : ''))
				.join('\n')
				.slice(0, 4_000);
		}
	} catch {
		// Fall through.
	}
	return undefined;
}

module.exports = function (pi) {
	append({ event: 'observer_loaded' });
	pi.on('session_start', () => append({ event: 'session_start' }));
	pi.on('tool_call', (event) => append({
		event: 'tool_call',
		toolName: typeof event?.toolName === 'string' ? event.toolName : undefined,
	}));
	pi.on('tool_execution_start', (event) => append({
		event: 'tool_start',
		toolName: typeof event?.toolName === 'string' ? event.toolName : undefined,
		toolCallId: typeof event?.toolCallId === 'string' ? event.toolCallId : undefined,
		parentToolCallId: typeof event?.parentToolCallId === 'string' ? event.parentToolCallId : undefined,
	}));
	pi.on('tool_execution_end', (event) => append({
		event: 'tool_end',
		toolName: typeof event?.toolName === 'string' ? event.toolName : undefined,
		toolCallId: typeof event?.toolCallId === 'string' ? event.toolCallId : undefined,
		isError: event?.isError === true,
		resultText: resultText(event?.result),
	}));
	pi.on('agent_settled', () => append({ event: 'settled' }));
	pi.on('session_shutdown', () => append({ event: 'shutdown' }));
};

module.exports.default = module.exports;
