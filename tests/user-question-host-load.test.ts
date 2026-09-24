/**
 * Issue #182: production host-peer loading for the free-text answer editor.
 *
 * The question UI's loader must expose pi-tui's Editor class (and the module's
 * public setKeybindings) from a running Pi install, using the same two-step
 * strategy as src/settings/menu.ts: soft require first, then host-relative
 * resolution discovered from the process entry. These tests exercise that
 * production load path against fake Pi install trees (no injected host): a
 * module that exposes the editor surface, and one that does not (the loader
 * must still resolve the width helpers so only editing degrades).
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

type TuiVariant = "with-editor" | "without-editor";

interface FakePiInstall {
  base: string;
  entry: string;
}

/**
 * Fake pi-tui module source. Exposes the width helpers the loader always
 * captures, plus (for the with-editor variant) an Editor class and
 * setKeybindings that record their use on globalThis.
 */
function fakeTuiModuleSource(variant: TuiVariant): string {
  const editor =
    variant === "with-editor"
      ? [
          "export class Editor {",
          "  constructor(tui, theme) {",
          "    this.tui = tui;",
          "    this.theme = theme;",
          "    globalThis.__fakeAnswerEditorConstructions = (globalThis.__fakeAnswerEditorConstructions ?? 0) + 1;",
          "  }",
          "}",
          "export function setKeybindings(kb) { globalThis.__fakeAnswerEditorSetKeybindings = kb; }",
        ]
      : [];
  return [
    "globalThis.__fakeUserQuestionTuiEvals = (globalThis.__fakeUserQuestionTuiEvals ?? 0) + 1;",
    "export function matchesKey(data, keyId) { return data === '\\r' && keyId === 'enter'; }",
    "export function visibleWidth(text) { return text.length; }",
    ...editor,
  ].join("\n");
}

async function makeFakePiInstall(variant: TuiVariant): Promise<FakePiInstall> {
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
  for (const key of ["__fakeUserQuestionTuiEvals", "__fakeAnswerEditorConstructions", "__fakeAnswerEditorSetKeybindings"]) {
    delete (globalThis as Record<string, unknown>)[key];
  }
}

function fakeGlobal(key: string): unknown {
  return (globalThis as Record<string, unknown>)[key];
}

test("production load path: exposes the host Editor class and setKeybindings", async (t) => {
  const install = await makeFakePiInstall("with-editor");
  t.after(() => rm(install.base, { recursive: true, force: true }).catch(() => {}));
  clearSeams();
  clearFakeGlobals();
  setUserQuestionTuiHostEntryProvider(() => install.entry);

  const host = await loadQuestionTuiHost();
  assert.ok(host, "the host resolves from the running Pi entry");
  assert.equal(typeof host?.visibleWidth, "function", "width helpers still resolve");
  assert.equal(typeof host?.matchesKey, "function");
  assert.equal(typeof host?.Editor, "function", "the Editor class is exposed for the answer row");
  assert.equal(typeof host?.setKeybindings, "function", "the module's setKeybindings is exposed");

  // The exposed constructor is the module's own class.
  const identity = (text: string): string => text;
  const editor = new host!.Editor!(
    { terminal: { rows: 40 } },
    {
      borderColor: (s) => s,
      selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
    },
  );
  assert.equal(fakeGlobal("__fakeAnswerEditorConstructions"), 1);
  void editor;
});

test("production load path: a module without an Editor still resolves the width helpers", async (t) => {
  const install = await makeFakePiInstall("without-editor");
  t.after(() => rm(install.base, { recursive: true, force: true }).catch(() => {}));
  clearSeams();
  clearFakeGlobals();
  setUserQuestionTuiHostEntryProvider(() => install.entry);

  const host = await loadQuestionTuiHost();
  assert.ok(host, "the host still resolves for rendering and key matching");
  assert.equal(typeof host?.visibleWidth, "function");
  assert.equal(host?.Editor, undefined, "no Editor surface: the component keeps its fallback editor");
  assert.equal(host?.setKeybindings, undefined);
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
