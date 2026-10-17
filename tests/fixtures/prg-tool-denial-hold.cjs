'use strict';
/**
 * Test-owned long-running hold fixture for the shipped scoped tool-denial
 * sandbox (issue #434). It is NOT part of the shipped product surface: the
 * integration suite installs it beside the probe in the sandbox agent's
 * `extensions/` directory (so a review-gate executor child auto-discovers it)
 * AND loads the same file explicitly in the primary, so the hold tool is
 * genuinely part of the captured parent authorization a child inherits rather
 * than a child-only capability smuggled past admission.
 *
 * It registers exactly one safe synthetic tool, `PrgToolDenialHold`, whose only
 * effect is to wait (bounded) for a caller-created sentinel file and append one
 * JSONL observation line per phase. That keeps a REAL executor child alive
 * across a later production `/review-settings` Tools apply, so the suite can
 * prove the already-admitted child keeps its captured catalog while the
 * primary's changed executor denial reaches the NEXT admission. It sends no
 * notification, touches no live config/cache, and starts no process.
 *
 * It is deliberately role-aware: only inside the executor child does it point
 * `PRG_TOOL_DENIAL_STATE_DIR` at the test's child-specific turn script, so the
 * primary keeps its own main-state script. The primary therefore loads the same
 * fixture and exposes the same tool without also running the hold turn script.
 *
 * Environment (set by the integration suite through the staged sandbox env):
 * - `PRG_TOOL_DENIAL_HOLD_LOG`           JSONL path for hold phase observations.
 * - `PRG_TOOL_DENIAL_HOLD_SENTINEL`      file whose existence releases the hold.
 * - `PRG_TOOL_DENIAL_HOLD_TIMEOUT_MS`    optional bounded hold deadline.
 * - `PRG_TOOL_DENIAL_CHILD_STATE_DIR`    executor-only turn-script directory.
 */

const fs = require('node:fs');

const HOLD_TOOL_NAME = 'PrgToolDenialHold';
const DEFAULT_HOLD_TIMEOUT_MS = 180_000;

/** Append one JSONL observation; never throws into the host. */
function append(entry) {
	const target = process.env.PRG_TOOL_DENIAL_HOLD_LOG;
	if (!target) return;
	try {
		fs.appendFileSync(target, `${JSON.stringify({
			ts: Date.now(),
			role: process.env.PI_REVIEW_GATE_RUNTIME_ROLE ?? 'primary',
			pid: process.pid,
			...entry,
		})}\n`, 'utf8');
	} catch (error) {
		process.stderr.write(`prg-tool-denial-hold: log write failed: ${String(error)}\n`);
	}
}

module.exports = function (pi) {
	// Role-aware turn script: a real executor child reads the hold script, while
	// the primary keeps its own main-state script and never holds.
	if ((process.env.PI_REVIEW_GATE_RUNTIME_ROLE ?? 'primary') === 'executor') {
		const childStateDir = process.env.PRG_TOOL_DENIAL_CHILD_STATE_DIR;
		if (childStateDir) process.env.PRG_TOOL_DENIAL_STATE_DIR = childStateDir;
	}
	append({ event: 'hold_loaded' });

	pi.registerTool({
		name: HOLD_TOOL_NAME,
		label: 'PRG Tool-Denial Hold',
		description: 'Test-only synthetic hold: waits (bounded) for a sentinel file and records one local line; sends nothing and changes no state.',
		exposure: 'deferred',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {},
		},
		// Pi's tool contract is execute(toolCallId, params, signal, onUpdate, ctx).
		async execute(_toolCallId, _args, signal, _onUpdate, _ctx) {
			const sentinel = process.env.PRG_TOOL_DENIAL_HOLD_SENTINEL;
			const configured = Number(process.env.PRG_TOOL_DENIAL_HOLD_TIMEOUT_MS);
			const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_HOLD_TIMEOUT_MS;
			const started = Date.now();
			append({ event: 'hold_entered' });
			try {
				for (;;) {
					if (sentinel && fs.existsSync(sentinel)) break;
					if (signal?.aborted) throw new Error('hold aborted');
					if (Date.now() - started >= timeoutMs) throw new Error(`hold timed out after ${timeoutMs}ms`);
					await new Promise((resolve) => {
						const timer = setTimeout(resolve, 50);
						timer.unref?.();
					});
				}
			} catch (error) {
				append({ event: 'hold_failed', message: String(error) });
				throw error;
			}
			const waitedMs = Date.now() - started;
			append({ event: 'hold_released', waitedMs });
			return {
				content: [{ type: 'text', text: `${HOLD_TOOL_NAME} released after ${waitedMs}ms (no effect sent).` }],
				details: { tool: HOLD_TOOL_NAME, waitedMs },
			};
		},
	});
};

module.exports.default = module.exports;
