/**
 * Main-level wiring tests for native provider hosting (issue #277 host-UI
 * slice): the host injects ONE native interactive launcher into the manager it
 * opened, offers that host's targets to the New form, and carries the operator's
 * explicit provider choice through the sidebar action into the owned create.
 *
 * Everything runs through the real controller with the synthetic Main harness:
 * no real provider CLI, no real review-gate configuration, no PTY, and no
 * network. The default harness offers no native target, which is also the
 * regression that keeps every existing Pi behaviour byte-identical.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { SidebarNativeCliTarget } from "../src/session-host/sidebar";
import {
  createHarness,
  nextTurn,
  plain,
  ready,
  type FakeManager,
} from "./helpers/session-host-main-harness";

const ENTER = "\r";
const DOWN = "\x1b[B";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

const TARGETS: readonly SidebarNativeCliTarget[] = [
  { id: "claude", backend: "claude", label: "Claude Code (default)" },
  { id: "codex", backend: "codex", label: "Codex CLI (default)" },
  { id: "external:review-box", backend: "codex", label: "review-box (Codex CLI)" },
];

interface LaunchCall {
  readonly backend: string;
  readonly workspace: string;
  readonly targetId?: string;
  readonly envKeys: string[];
}

/** A recording synthetic launcher: it never resolves a real executable. */
function recordingHosting(calls: LaunchCall[]) {
  return () => ({
    targets: TARGETS,
    launch: async (backend: "claude" | "codex", request: {
      workspace: string;
      env: NodeJS.ProcessEnv;
      targetId?: string;
    }) => {
      calls.push({
        backend,
        workspace: request.workspace,
        ...(request.targetId === undefined ? {} : { targetId: request.targetId }),
        envKeys: Object.keys(request.env),
      });
      return {
        file: `/synthetic/${backend}`,
        args: backend === "codex" ? ["--no-daemon"] : [],
        env: { ...request.env, PWD: request.workspace },
        cwd: request.workspace,
      };
    },
  });
}

/** Open the New form, choose the nth native provider choice, and submit. */
function submitNativeNew(harness: ReturnType<typeof createHarness>, workspace: string, cycles: number): void {
  harness.terminal.emitInput(ENTER); // the selected New session row
  harness.terminal.emitInput("\x15"); // replace any retained draft
  // The New form draws Host, then Provider, then Workspace: one Shift+Tab from
  // the workspace field lands on the Provider line drawn directly above it.
  harness.terminal.emitInput(SHIFT_TAB); // the form's Provider line
  for (let index = 0; index < cycles; index += 1) harness.terminal.emitInput(DOWN);
  harness.terminal.emitInput(TAB); // back to the workspace field
  harness.terminal.emitInput(workspace);
  harness.terminal.emitInput(ENTER);
}

test("a host with no native hosting injects no launcher and draws no Provider line", async () => {
  const harness = createHarness();
  const manager: FakeManager = await ready(harness);
  assert.equal(manager.options.nativeCliLaunch, undefined,
    "without native hosting the manager keeps its exact pre-native options");

  harness.terminal.emitInput(ENTER); // open the New form
  await nextTurn();
  const opened = plain(harness.writer.frames.at(-1)?.frame);
  assert.match(opened, /New session/);
  assert.doesNotMatch(opened, /Provider:/, "no offered target means no provider control");

  harness.terminal.emitInput("\x15");
  harness.terminal.emitInput("/plain/pi/workspace");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.deepEqual(manager.createOptions.at(-1), { workspace: "/plain/pi/workspace" },
    "the ordinary New submission is still the exact existing Pi create");
});

test("the host wires one native launcher into the manager and offers its targets in the New form", async () => {
  const calls: LaunchCall[] = [];
  const harness = createHarness({}, { nativeCliHosting: recordingHosting(calls) });
  const manager: FakeManager = await ready(harness);
  assert.equal(typeof manager.options.nativeCliLaunch, "function",
    "the manager the host opened receives exactly one native interactive launcher");

  harness.terminal.emitInput(ENTER); // open the New form
  await nextTurn();
  const opened = plain(harness.writer.frames.at(-1)?.frame);
  assert.match(opened, /Provider: \[ Pi \]/, "the form offers the provider choice, defaulting to Pi");
  assert.doesNotMatch(opened, /Claude Code/, "Pi stays the default; no target is preselected");

  // The wired callback is the host's own launcher: the backend, target id, and
  // workspace the manager forwards arrive unchanged, and the descriptor returns.
  const launch = manager.options.nativeCliLaunch!;
  const descriptor = await launch("codex", {
    workspace: "/srv/app",
    env: { PATH: "/synthetic/bin" },
    targetId: "external:review-box",
  });
  assert.deepEqual(calls.at(-1), {
    backend: "codex",
    workspace: "/srv/app",
    targetId: "external:review-box",
    envKeys: ["PATH"],
  });
  assert.deepEqual(descriptor.args, ["--no-daemon"]);
  assert.equal(descriptor.cwd, "/srv/app");
});

test("the New form's provider choice reaches the owned create as backend plus target", async () => {
  const calls: LaunchCall[] = [];
  const harness = createHarness({}, { nativeCliHosting: recordingHosting(calls) });
  const manager: FakeManager = await ready(harness);

  submitNativeNew(harness, "/native/claude/workspace", 1);
  await nextTurn();
  assert.deepEqual(manager.createOptions.at(-1), {
    workspace: "/native/claude/workspace",
    backend: "claude",
    nativeCliTarget: "claude",
  }, "the explicit provider choice is forwarded, never dropped or defaulted back to Pi");

  const nativeRow = manager.views.at(-1)!;
  assert.equal(nativeRow.backend, "claude");
  assert.equal(nativeRow.nativeSession, null, "a native row reports no Pi conversation identity");
  await nextTurn();
  const roster = plain(harness.writer.frames.at(-1)?.frame);
  assert.match(roster, /Claude/, "the roster card names the provider honestly");
  assert.match(roster, /agent unknown \| input unknown/, "and its telemetry stays unknown, never idle");
  assert.deepEqual(calls, [], "the synthetic manager owns the row; only the host's launcher can be called by a real create");
});

test("a configured target selection carries its exact id and a later New still defaults to Pi", async () => {
  const calls: LaunchCall[] = [];
  const harness = createHarness({}, { nativeCliHosting: recordingHosting(calls) });
  const manager: FakeManager = await ready(harness);

  submitNativeNew(harness, "/srv/box", 3); // Pi -> claude -> codex -> external:review-box
  await nextTurn();
  assert.deepEqual(manager.createOptions.at(-1), {
    workspace: "/srv/box",
    backend: "codex",
    nativeCliTarget: "external:review-box",
  });

  // Back to the roster and open New again: the provider resets to Pi.
  harness.terminal.emitInput("\x1b[1;3D"); // toggle the sidebar roster into focus
  await nextTurn();
  harness.terminal.emitInput(DOWN); // first row -> Saved conversations
  harness.terminal.emitInput(DOWN); // -> New session
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.match(plain(harness.writer.frames.at(-1)?.frame), /Provider: \[ Pi \]/,
    "a native choice is never remembered as the next form's default");

  harness.terminal.emitInput("\x15");
  harness.terminal.emitInput("/plain/second");
  harness.terminal.emitInput(ENTER);
  await nextTurn();
  assert.deepEqual(manager.createOptions.at(-1), { workspace: "/plain/second" },
    "the following create is the ordinary Pi create with no provider fields");
});
