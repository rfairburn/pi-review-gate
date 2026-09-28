/**
 * Issue #213: immediate interactive-startup peer prewarm — session hook wiring.
 *
 * Unit mechanics (immediate start, race coalescing, cache identity, fallback
 * failures) live in tests/peer-prewarm.test.ts; this file pins the host-side
 * contract through the real extension entrypoint:
 *
 * - an interactive TUI session_start starts the agent-peer prewarm
 *   immediately — before any other hook work settles, with no timer and
 *   without awaiting the import in the hook;
 * - non-TUI sessions (no mode, RPC) never start it;
 * - a later session_start (e.g. /new) after a completed prewarm never
 *   re-evaluates the peer.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activate } from "../src/index";
import { prewarmPiAgentPeer, setPeerPrewarmEntryProvider } from "../src/peer-prewarm";
import { createSessionRuntime, trigger } from "./entrypoint-harness";

interface FakePiInstall {
  base: string;
  entry: string;
}

/** Fake agent entry source; mirrors the import-only exports of installed pi. */
function fakeAgentModuleSource(gated: boolean): string {
  const lines = [
    "globalThis.__fakeAgentPrewarmEvals = (globalThis.__fakeAgentPrewarmEvals ?? 0) + 1;",
    "globalThis.__fakeAgentPrewarmEvalStarted = true;",
  ];
  if (gated) {
    lines.push("await new Promise((resolve) => { globalThis.__fakeAgentPrewarmRelease = resolve; });");
  }
  lines.push('export const prewarmMarker = "agent-peer";');
  return lines.join("\n");
}

async function makeFakePiInstall(gated: boolean): Promise<FakePiInstall> {
  const base = await mkdtemp(join(tmpdir(), "pi-review-prewarm-entry-"));
  const root = join(base, "@earendil-works", "pi-coding-agent");
  await mkdir(join(root, "dist", "bundle"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.0.0-fake",
      type: "module",
      main: "./dist/index.js",
      exports: { ".": { import: "./dist/index.js" } },
    }),
  );
  await writeFile(join(root, "dist", "index.js"), fakeAgentModuleSource(gated));
  const entry = join(root, "dist", "bundle", "cli.js");
  await writeFile(entry, "// fake pi entry\n");
  return { base, entry };
}

function clearFakeGlobals(): void {
  for (const key of [
    "__fakeAgentPrewarmEvals",
    "__fakeAgentPrewarmEvalStarted",
    "__fakeAgentPrewarmRelease",
  ]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

function fakeGlobal(key: string): unknown {
  return (globalThis as Record<string, unknown>)[key];
}

async function makeTuiRuntime(dir: string) {
  const rt = createSessionRuntime("prewarm-session", join(dir, "session.jsonl"), dir);
  Object.assign(rt.ctx, { mode: "tui" });
  return rt;
}

test("interactive TUI session_start starts the agent peer prewarm immediately", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-prewarm-cwd-"));
  const install = await makeFakePiInstall(true);
  t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(install.base, { recursive: true, force: true })]).catch(() => {}));
  setPeerPrewarmEntryProvider(() => install.entry);
  clearFakeGlobals();

  const rt = await makeTuiRuntime(dir);
  await activate(rt.pi);

  // Start the hook WITHOUT awaiting it: the prewarm must already be under way
  // while the rest of session setup is still running (no timer, no await).
  const started = trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);
  for (let turns = 0; turns < 200 && fakeGlobal("__fakeAgentPrewarmEvalStarted") !== true; turns += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(fakeGlobal("__fakeAgentPrewarmEvalStarted"), true, "prewarm import started immediately on session_start");

  (fakeGlobal("__fakeAgentPrewarmRelease") as () => void)();
  await started;
  const mod = await prewarmPiAgentPeer();
  assert.equal(mod?.prewarmMarker, "agent-peer");
  assert.equal(fakeGlobal("__fakeAgentPrewarmEvals"), 1);
  // Invisible: the hook emits its ordinary notices and nothing about the prewarm.
  assert.ok(rt.notices.some((notice) => notice.includes("review gate: loaded")));
  for (const notice of rt.notices) {
    assert.ok(!/prewarm|peer/i.test(notice), `no visible prewarm UI: ${notice}`);
  }
});

test("non-TUI session_start never starts the prewarm", async (t) => {
  for (const mode of [undefined, "rpc"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "pi-review-prewarm-cwd-"));
    const install = await makeFakePiInstall(true);
    t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(install.base, { recursive: true, force: true })]).catch(() => {}));
    setPeerPrewarmEntryProvider(() => install.entry);
    clearFakeGlobals();

    const rt = createSessionRuntime("prewarm-session", join(dir, "session.jsonl"), dir);
    if (mode !== undefined) Object.assign(rt.ctx, { mode });
    await activate(rt.pi);
    await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);

    // Settle well past any plausible immediate start; a gated module that had
    // been started would have set the eval-start marker by now.
    for (let turns = 0; turns < 100; turns += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(fakeGlobal("__fakeAgentPrewarmEvalStarted"), undefined, `mode ${String(mode)} must not prewarm`);
  }
});

test("a later session_start after a completed prewarm never re-evaluates the peer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-prewarm-cwd-"));
  const install = await makeFakePiInstall(false);
  t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(install.base, { recursive: true, force: true })]).catch(() => {}));
  setPeerPrewarmEntryProvider(() => install.entry);
  clearFakeGlobals();

  const rt = await makeTuiRuntime(dir);
  await activate(rt.pi);
  await trigger(rt.hooks, "session_start", { type: "session_start", reason: "startup" }, rt.ctx);
  await prewarmPiAgentPeer();
  assert.equal(fakeGlobal("__fakeAgentPrewarmEvals"), 1);

  // /new and friends re-fire session_start in the same process.
  await trigger(rt.hooks, "session_start", { type: "session_start", reason: "new" }, rt.ctx);
  const mod = await prewarmPiAgentPeer();
  assert.equal(mod?.prewarmMarker, "agent-peer");
  assert.equal(fakeGlobal("__fakeAgentPrewarmEvals"), 1, "the completed prewarm is memoized per process");
});
