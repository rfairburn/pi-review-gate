/**
 * Issue #281 regression: a primary-session ShellStart with wake_on.exit
 * promises "You will be notified automatically; do not poll", but for
 * immediate and short-lived jobs the owning session received no completion
 * notification before a manual ShellLog/ShellList even though the retained
 * job state was complete.
 *
 * Exercised failure boundary (Pi 1.x, real extension API): an exit wake sent
 * while a run is active is queued as a Pi follow-up. The agent loop may settle
 * without draining that queue after an abort, leaving the exit wake retained
 * while the session is idle; pi.sendMessage (void on the real API) gives the
 * gate no delivery result, so it observes injection instead (message_start
 * with customType "pi-review-bg-shell", details.id = job id, and
 * details.kind === "exit" — only the exit completion acknowledges its own
 * outstanding marker). Because Pi retains the aborted run's queued follow-up,
 * the gate must NOT re-submit the completion — that would inject one copy
 * immediately and drain the original again when recovery ends naturally.
 * Instead, at agent_settled a still-unobserved exit wake triggers one bounded
 * hidden control message (customType "pi-review-bg-shell-resume", display:false)
 * that resumes Pi's queue drainage. This regression establishes the aborted-run
 * path; it does not establish that this was the cause of the original report.
 *
 * These tests drive a REAL `pi --mode rpc` session with the compiled gate
 * extension (same real-host tier as the native MCP lifecycle tests) and a
 * scripted faux model. The turn scripts contain NO polling tool call — only
 * ShellStart, one foreground bash, and stop text — so the only way the owning
 * session's model can see the completion is through the exit wake itself:
 *
 * - the probe journals every model request's transcript tail; a request whose
 *   tail carries the `background job … — exited N` display proves the wake
 *   reached the owning session's model context;
 * - the session transcript on disk must contain the persisted custom
 *   `pi-review-bg-shell` message, so the notification is part of the session,
 *   not an ephemeral side channel.
 *
 * The abort scenario verifies recovery of this queued-follow-up path and
 * asserts exactly ONE completion injection after the recovery turn settles.
 * The two non-aborted scenarios cover ordinary delivery paths (immediate exit
 * and short-lived exit). Neither scenario establishes the original report's
 * cause.
 *
 * Skips when no installed Pi 1.x host or compiled candidate is available
 * (hard-fails under PI_REVIEW_GATE_REQUIRE_PI_HOST=1), matching the existing
 * real-host convention.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import {
  createBgShellWakeFixture,
  type BgShellWakeFixture,
} from "./pi-native-bgshell-wake-fixture";
import { skipOrFail } from "./bridge-fakes";

const WAKE_WAIT_MS = 45_000;

function candidateEntry(): string | null {
	const fromEnv = process.env.PI_REVIEW_GATE_CANDIDATE_ENTRY;
	if (fromEnv) return resolvePath(fromEnv);
	return existsSync(resolvePath(process.cwd(), join("dist", "src", "index.js")))
		? resolvePath(process.cwd(), join("dist", "src", "index.js"))
		: null;
}

/** Verify the real-host prerequisites. Returns false only when the test was
 *  skipped — callers must return immediately and never construct the fixture
 *  after a skip (t.skip does not stop an async test body). Under
 *  PI_REVIEW_GATE_REQUIRE_PI_HOST=1 a missing prerequisite throws via
 *  skipOrFail instead, so this returns true exactly when the run may proceed.
 */
function checkPrerequisites(t: { skip(message?: string): void }): boolean {
	if (!candidateEntry()) {
		skipOrFail(t, "no compiled candidate extension (build with npm run build) and no PI_REVIEW_GATE_CANDIDATE_ENTRY");
		return false;
	}
	try {
		createBgShellWakeFixture({ candidateEntry: null });
	} catch (error) {
		skipOrFail(t, error instanceof Error ? error.message : String(error));
		return false;
	}
	return true;
}

/**
 * Run one wake scenario: the model starts a short-lived job with wake_on.exit
 * as its first tool call, then ends the turn with stop text — no polling.
 * Resolves when the owning session's model request carries the exit wake.
 *
 * The immediate job may exit before or after the first run's natural drain
 * point: either way Pi injects the queued wake (in-run continuation or idle
 * deferred run) and a wake-carrying model request appears. Delivery is
 * asserted directly — such a request can only exist if the wake was injected
 * into the transcript, so no polling is involved. The turn script is rewritten
 * to harmless text as soon as delivery is observed, which also terminates any
 * in-run drain cascade (a continuation consuming the stale ShellStart step
 * would otherwise start more short-lived jobs).
 */
async function runWakeScenario(
	fixture: BgShellWakeFixture,
	command: string,
	label: string,
): Promise<void> {
	const steps = [
		{
			toolCalls: [{
				toolName: "ShellStart",
				arguments: { command, label, wake_on: { exit: true } },
			}],
		},
		// The turn ends here; the script contains no ShellLog/ShellList.
		{ text: `waiting-for-${label}` },
	];
	await fixture.start(steps);
	const response = (await fixture.prompt("start the probe")) as { disposition?: string };
	assert.equal(response?.disposition, "started", `prompt did not start a run: ${JSON.stringify(response)}`);

	await assertWakeDelivered(fixture, label);
	// Delivery proven; make any further wake-driven runs harmless text.
	await fixture.setTurnScript([{ text: `ack-wake-${label}` }]);
}

/** Assert the exit wake reached the owning session's model and was persisted. */
async function assertWakeDelivered(fixture: BgShellWakeFixture, label: string): Promise<void> {
	// The wake's own text ("— exited N") can only exist after the job
	// exited, so a model request carrying it IS the completion notification
	// arriving in the owning session — no polling involved.
	const delivered = await fixture.waitFor(
		() => fixture.modelRequests().some((request) => fixture.wakeSeenInRequest(request)),
		WAKE_WAIT_MS,
	);
	const requestDump = fixture.modelRequests().map((request) => ({
		index: request.requestIndex,
		tail: (request.transcriptTail ?? []).map((message) => {
			const type = message.customType ? `:${message.customType}` : "";
			return `${message.role}${type}:${String(message.preview ?? "").slice(0, 80)}`;
		}),
	}));
	assert.equal(
		delivered,
		true,
		`exit wake never reached the owning session's model for "${label}" (no polling in script); `
			+ `requests:\n${JSON.stringify(requestDump, null, "\t")}\nstderr:\n${fixture.stderr}`,
	);

	// The notification is part of the session: persisted as the custom
	// pi-review-bg-shell message, not an ephemeral side channel.
	assert.equal(
		await fixture.wakePersistedInSession(),
		true,
		"custom pi-review-bg-shell wake message missing from the session transcript",
	);
}

/**
 * A targeted regression path: a short-lived job exits while a run is active
 * (its exit wake is queued as a Pi follow-up), then that run is aborted. The
 * test verifies that settlement recovery resumes drainage of the retained
 * completion, which is injected exactly once. No ShellLog/ShellList anywhere
 * in the script; this does not establish the original report's cause.
 */
async function runAbortedRunScenario(fixture: BgShellWakeFixture): Promise<void> {
	const label = "probe-abort";
	const steps = [
		{
			toolCalls: [{
				toolName: "ShellStart",
				arguments: { command: "sleep 0.5 && echo probe-abort-done", label, wake_on: { exit: true } },
			}],
		},
		// A slow foreground call keeps the run active past the job's exit so
		// the exit wake is QUEUED (not delivered) before the abort.
		{ toolCalls: [{ toolName: "bash", arguments: { command: "sleep 6" } }] },
		{ text: `post-abort-${label}` },
	];
	await fixture.start(steps);
	const response = (await fixture.prompt("start the probe")) as { disposition?: string };
	assert.equal(response?.disposition, "started", `prompt did not start a run: ${JSON.stringify(response)}`);

	// Wait until the ShellStart result has landed and the 0.5 s job has exited:
	// at that point the exit wake is queued inside the active run.
	const shellStartDone = await fixture.waitFor(
		() => {
			const entry = fixture.journal().find(
				(e) => e.event === "message_end" && /Started "probe-abort"/.test(String(e.preview ?? "")),
			);
			return !!entry && Date.now() - (entry?.ts as number) > 1_500;
		},
		WAKE_WAIT_MS,
	);
	assert.equal(shellStartDone, true, `ShellStart result never observed; journal:\n${JSON.stringify(fixture.journal())}`);

	// Abort the active run. From here on the script cannot produce any model
	// activity of its own: if a wake-carrying request appears, it came through
	// the exit-wake delivery path (the settlement recovery trigger).
	//
	// The abort is issued fire-and-forget on purpose: Pi's RPC abort awaits
	// session idle, and with the fix the settlement recovery trigger starts
	// exactly the run that makes the session busy again — awaiting the response
	// would stall the test until its own delivery completes (and, against a
	// stale turn script, cascade). The abort flag is set as soon as Pi
	// processes the command; the delayed response resolves harmlessly against
	// the fixture's id-matched pending map.
	// Any run started by the recovery trigger must be harmless text, not another
	// job. Rewrite before aborting: the active run is mid-tool-call and cannot
	// make a further model request until aborted, so this lands deterministically
	// before the recovery run's first request — no drain cascade can consume
	// the stale ShellStart step.
	await fixture.setTurnScript([{ text: `ack-wake-${label}` }]);
	const abortedAt = Date.now();
	void fixture.abort().catch(() => undefined);

	const delivered = await fixture.waitFor(
		() => fixture.modelRequests().some((request) => request.ts > abortedAt && fixture.wakeSeenInRequest(request)),
		WAKE_WAIT_MS,
	);
	const journal = fixture.journal();
	const starts = journal.filter((e) => e.event === "agent_start").length;
	const settled = journal.filter((e) => e.event === "agent_settled").length;
	assert.equal(
		delivered,
		true,
		`exit wake was not delivered after the queued run settled: no wake-carrying model request `
			+ `after abort, no polling in script; agent_start=${starts} agent_settled=${settled}; `
			+ `requests:\n${JSON.stringify(fixture.modelRequests().map((request) => ({
				index: request.requestIndex,
				tail: (request.transcriptTail ?? []).map((message) => `${message.role}:${String(message.preview ?? "").slice(0, 80)}`),
			})), null, "\t")}\nstderr:\n${fixture.stderr}`,
	);

	assert.equal(
		await fixture.wakePersistedInSession(),
		true,
		"custom pi-review-bg-shell wake message missing from the session transcript after aborted-run recovery",
	);

	// The recovery turn must complete, and the completion must have been
	// injected EXACTLY ONCE: Pi retains the aborted run's queued follow-up,
	// so the recovery trigger resumes that drainage rather than re-submitting
	// a second copy. Stopping at the first wake-carrying request would miss a
	// duplicate injected when the recovery turn drains the original.
	assert.equal(
		await fixture.waitFor(
			() => fixture.journal().filter((entry) => entry.event === "agent_settled").length >= 2,
			WAKE_WAIT_MS,
		),
		true,
		"recovery run never settled",
	);
	assert.equal(
		fixture.journal().filter((entry) =>
			entry.event === "message_end"
			&& entry.customType === "pi-review-bg-shell"
			&& /—\s*exited 0/.test(String(entry.preview ?? ""))
		).length,
		1,
		"exit completion was injected more than once",
	);
}

/**
 * Cancel the one recovery turn while it is still busy, before Pi drains the
 * retained exit follow-up. The marker is consumed before the control send, so
 * settlement of this canceled turn must not start a third run for that exit.
 */
async function runCanceledRecoveryScenario(fixture: BgShellWakeFixture): Promise<void> {
	const label = "probe-recovery-abort";
	const initialSteps = [
		{
			toolCalls: [{
				toolName: "ShellStart",
				arguments: { command: "sleep 0.5 && echo probe-recovery-abort-done", label, wake_on: { exit: true } },
			}],
		},
		{ toolCalls: [{ toolName: "bash", arguments: { command: "sleep 6" } }] },
		{ text: `post-abort-${label}` },
	];
	await fixture.start(initialSteps);
	const response = (await fixture.prompt("start the probe")) as { disposition?: string };
	assert.equal(response?.disposition, "started", `prompt did not start a run: ${JSON.stringify(response)}`);

	const shellStartDone = await fixture.waitFor(
		() => {
			const entry = fixture.journal().find(
				(e) => e.event === "message_end" && /Started "probe-recovery-abort"/.test(String(e.preview ?? "")),
			);
			return !!entry && Date.now() - (entry?.ts as number) > 1_500;
		},
		WAKE_WAIT_MS,
	);
	assert.equal(shellStartDone, true, `ShellStart result never observed; journal:\n${JSON.stringify(fixture.journal())}`);

	// The initial run has produced tool-call messages, but the retained
	// transcript can make the recovery request index vary. Fill possible
	// indices with long-running tool calls so recovery cannot stop naturally
	// and drain the exit before we abort it.
	await fixture.setTurnScript(Array.from({ length: 32 }, () => ({
		toolCalls: [{ toolName: "bash", arguments: { command: "sleep 30" } }],
	})));
	const firstAbortAt = Date.now();
	void fixture.abort().catch(() => undefined);

	const recoveryBlocked = await fixture.waitFor(
		() => fixture.journal().some((entry) =>
			entry.ts > firstAbortAt
			&& entry.event === "message_end"
			&& entry.role === "assistant"
			&& String(entry.preview ?? "").includes("toolCall:bash")),
		WAKE_WAIT_MS,
	);
	assert.equal(
		recoveryBlocked,
		true,
		`the bounded recovery turn did not reach its blocking tool call before it was canceled; `
			+ `requests=${JSON.stringify(fixture.modelRequests().map((request) => ({
				index: request.requestIndex,
				tail: request.transcriptTail,
			})), null, "\t")}; `
			+ `starts=${fixture.journal().filter((entry) => entry.event === "agent_start").length} `
			+ `settled=${fixture.journal().filter((entry) => entry.event === "agent_settled").length}; `
			+ `stderr=${fixture.stderr}`,
	);

	const beforeRecoveryAbort = fixture.journal();
	assert.equal(beforeRecoveryAbort.filter((entry) => entry.event === "agent_start").length, 2,
		"expected the initial run and exactly one recovery run before canceling recovery");
	assert.equal(beforeRecoveryAbort.filter((entry) =>
		entry.event === "message_end"
		&& entry.customType === "pi-review-bg-shell"
		&& /—\s*exited 0/.test(String(entry.preview ?? ""))).length, 0,
		"the exit follow-up drained before the recovery turn was aborted");
	// Let the host dispatch the blocking tool call before canceling the run.
	await new Promise<void>((resolve) => setTimeout(resolve, 500));

	void fixture.abort().catch(() => undefined);
	const recoverySettled = await fixture.waitFor(
		() => fixture.journal().filter((entry) => entry.event === "agent_settled").length >= 2,
		WAKE_WAIT_MS,
	);
	assert.equal(recoverySettled, true, "the canceled recovery turn did not settle");

	// Give any erroneously queued self-restart a chance to become observable.
	const restarted = await fixture.waitFor(
		() => fixture.journal().filter((entry) => entry.event === "agent_start").length >= 3,
		2_500,
	);
	const finalJournal = fixture.journal();
	assert.equal(restarted, false, "canceling recovery automatically started another run for the same exit");
	assert.equal(finalJournal.filter((entry) => entry.event === "agent_start").length, 2,
		"unexpected additional agent run after canceling the one recovery attempt");
	assert.equal(finalJournal.filter((entry) =>
		entry.event === "message_end"
		&& entry.customType === "pi-review-bg-shell"
		&& /—\s*exited 0/.test(String(entry.preview ?? ""))).length, 0,
		"the retained exit was drained despite aborting recovery before drainage");
}

test("aborted run recovers its queued exit wake (#281)", { timeout: 180_000 }, async (t) => {
	if (!checkPrerequisites(t)) return;
	const fixture = createBgShellWakeFixture({ candidateEntry: candidateEntry() });
	// Dispose no matter how startup or the scenario fails: a startup failure
	// after spawn must not leak the child, its stdio, or the scratch tree.
	t.after(() => fixture.dispose());
	await runAbortedRunScenario(fixture);
});

test("canceling recovery does not restart the same exit delivery (#281)", { timeout: 180_000 }, async (t) => {
	if (!checkPrerequisites(t)) return;
	const fixture = createBgShellWakeFixture({ candidateEntry: candidateEntry() });
	t.after(() => fixture.dispose());
	await runCanceledRecoveryScenario(fixture);
});

test("immediate job exit wakes the owning session without polling (#281)", { timeout: 180_000 }, async (t) => {
	if (!checkPrerequisites(t)) return;
	const fixture = createBgShellWakeFixture({ candidateEntry: candidateEntry() });
	t.after(() => fixture.dispose());
	await runWakeScenario(fixture, "echo probe-immediate-done", "probe-immediate");
});

test("short-lived job exit wakes the owning session without polling (#281)", { timeout: 180_000 }, async (t) => {
	if (!checkPrerequisites(t)) return;
	const fixture = createBgShellWakeFixture({ candidateEntry: candidateEntry() });
	t.after(() => fixture.dispose());
	await runWakeScenario(fixture, "sleep 3 && echo probe-short-done", "probe-short");
});
