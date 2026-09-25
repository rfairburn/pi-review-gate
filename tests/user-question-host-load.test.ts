/**
 * Issue #182: production host-peer loading for the pending-question UI.
 *
 * The question UI's loader must expose pi-tui's width-safe text helpers, raw
 * key matching, and the module-global KeybindingsManager from a running Pi
 * install, using the same two-step strategy as src/settings/menu.ts: soft
 * require first, then host-relative resolution discovered from the process
 * entry. These tests exercise that production load path against fake Pi
 * install trees (no injected host): a module that exposes the full surface,
 * and one that does not (the loader must still resolve whatever it can).
 *
 * The free-text answer row no longer consumes a standalone Editor from this
 * loader: it embeds the host-wired native editor acquired through the shared
 * bridge (src/native-editor-bridge.ts), which loads its own seams. When those
 * seams are unavailable the row renders an unavailable line instead of a
 * non-parity fallback, so the loader deliberately no longer exposes an
 * Editor class or setKeybindings.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadQuestionTuiHost,
  setUserQuestionTuiHost,
  setUserQuestionTuiHostEntryProvider,
} from "../src/user-question/pi-tui-host";

type Variant = "full" | "width-only";

interface FakePiInstall {
  base: string;
  entry: string;
}

/**
 * Fake pi-tui module source. The full variant exposes the width helpers, raw
 * key matching, and a getKeybindings that returns a recording manager; the
 * width-only variant exposes just the width helpers (the loader must still
 * resolve it).
 */
function fakeTuiModuleSource(variant: Variant): string {
  const extras =
    variant === "full"
      ? [
          "export function matchesKey(data, keyId) { return data === '\\r' && keyId === 'enter'; }",
          "const manager = { matches: (data, keybinding) => { globalThis.__fakeQuestionTuiMatchesCalls = (globalThis.__fakeQuestionTuiMatchesCalls ?? 0) + 1; return true; } };",
          "export function getKeybindings() { return manager; }",
        ]
      : [];
  return [
    "globalThis.__fakeUserQuestionTuiEvals = (globalThis.__fakeUserQuestionTuiEvals ?? 0) + 1;",
    "export function visibleWidth(text) { return text.length; }",
    "export function truncateToWidth(text, width, ellipsis) { return text.length > width ? text.slice(0, Math.max(0, width - (ellipsis?.length ?? 0))) + (ellipsis ?? '') : text; }",
    "export function wrapTextWithAnsi(text, width) { return [text]; }",
    ...extras,
  ].join("\n");
}

async function makeFakePiInstall(variant: Variant): Promise<FakePiInstall> {
  const base = await mkdtemp(join(tmpdir(), "pi-review-question-host-"));
  const root = join(base, "@earendil-works", "pi-coding-agent");
  const tuiDir = join(root, "node_modules", "@earendil-works", "pi-tui");
  await mkdir(join(root, "dist", "bundle"), { recursive: true });
  await mkdir(join(tuiDir, "dist"), { recursive: true });
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
  await writeFile(join(root, "dist", "index.js"), "// fake agent entry\n");
  await writeFile(join(root, "dist", "bundle", "cli.js"), "// fake pi entry\n");
  await writeFile(
    join(tuiDir, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-tui", version: "0.0.0-fake", type: "module", main: "dist/index.js" }),
  );
  await writeFile(join(tuiDir, "dist", "index.js"), fakeTuiModuleSource(variant));
  return { base, entry: join(root, "dist", "bundle", "cli.js") };
}

function clearSeams(): void {
  setUserQuestionTuiHost(undefined);
  setUserQuestionTuiHostEntryProvider(undefined);
}

function clearFakeGlobals(): void {
  for (const key of ["__fakeUserQuestionTuiEvals", "__fakeQuestionTuiMatchesCalls"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

function fakeGlobal(key: string): unknown {
  return (globalThis as Record<string, unknown>)[key];
}

test("production load path: exposes the width helpers, key matching, and the live keybindings manager", async (t) => {
  const install = await makeFakePiInstall("full");
  t.after(() => rm(install.base, { recursive: true, force: true }).catch(() => {}));
  clearSeams();
  clearFakeGlobals();
  setUserQuestionTuiHostEntryProvider(() => install.entry);

  const host = await loadQuestionTuiHost();
  assert.ok(host, "the host resolves from the running Pi entry");
  assert.equal(typeof host?.visibleWidth, "function", "width helpers still resolve");
  assert.equal(host!.visibleWidth!("abcd"), 4);
  assert.equal(typeof host?.truncateToWidth, "function");
  assert.equal(host!.truncateToWidth!("abcdef", 3, "…"), "ab…");
  assert.deepEqual(host!.wrapTextWithAnsi!("one two", 80), ["one two"]);
  assert.equal(typeof host?.matchesKey, "function");
  assert.equal(host!.matchesKey!("\r", "enter"), true);
  assert.equal(host!.matchesKey!("\x1b", "enter"), false);
  assert.equal(typeof host?.getKeybindings, "function", "the module-global keybindings manager is exposed");

  const manager = host!.getKeybindings!();
  assert.ok(manager, "a manager is returned");
  assert.equal(typeof manager?.matches, "function");
  manager!.matches!("\r", "tui.input.submit");
  assert.equal(fakeGlobal("__fakeQuestionTuiMatchesCalls"), 1, "the exposed manager is the module's own");

  // The loader no longer exposes a standalone editor surface for the
  // free-text row (that path now goes through the shared bridge).
  const hostRecord = host as unknown as Record<string, unknown>;
  assert.equal(hostRecord["Editor"], undefined, "no Editor class is exposed");
  assert.equal(hostRecord["setKeybindings"], undefined, "no setKeybindings is exposed");
});

test("production load path: a module without the key surface still resolves the width helpers", async (t) => {
  const install = await makeFakePiInstall("width-only");
  t.after(() => rm(install.base, { recursive: true, force: true }).catch(() => {}));
  clearSeams();
  clearFakeGlobals();
  setUserQuestionTuiHostEntryProvider(() => install.entry);

  const host = await loadQuestionTuiHost();
  assert.ok(host, "the host still resolves for rendering");
  assert.equal(typeof host?.visibleWidth, "function");
  assert.equal(host?.matchesKey, undefined, "no key matching: the component falls back to its naive matcher");
  assert.equal(host?.getKeybindings, undefined, "no manager: input is driven by the injected live manager only");
});

test("an injected host override short-circuits discovery", async () => {
  clearSeams();
  clearFakeGlobals();
  const injected = { visibleWidth: (text: string) => text.length };
  setUserQuestionTuiHost(injected);
  try {
    const host = await loadQuestionTuiHost();
    assert.equal(host, injected, "the override is returned as-is");
  } finally {
    clearSeams();
  }
});
