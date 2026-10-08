import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { createSessionHostTextField, type SessionHostFieldSubmission, type SessionHostTextField } from "../src/session-host/field-editor";
import { ensureIgnoredFixtureRoot } from "./helpers/ignored-fixture-root";

// Actual pinned public provider + Editor; Windows skips are NOT Windows proof.
// Fixtures and all descendants are retained; no recursive teardown.
const isWindows = process.platform === "win32";
const SKIP = !isWindows ? "requires real Windows drive/UNC filesystem acceptance; POSIX skip is not proof" : false;
const projectRoot = join(dirname(__dirname), "..");
const observers = new WeakMap<SessionHostTextField, Set<() => void>>();

function fixtureDir(multipleAlpha = false): string {
  const root = ensureIgnoredFixtureRoot(projectRoot, "node_modules/.prg-win-ws-completion-fixture");
  const rootReceipt = lstatSync(root, { bigint: true });
  const dir = join(root, `ws-${randomBytes(8).toString("hex")}`);
  const check = (path: string, receipt: typeof rootReceipt): void => {
    const now = lstatSync(path, { bigint: true });
    assert.ok(now.isDirectory() && !now.isSymbolicLink());
    assert.equal(now.dev, receipt.dev);
    assert.equal(now.ino, receipt.ino);
  };
  check(root, rootReceipt);
  mkdirSync(dir); // exclusive, non-recursive; collision fails before descendants
  const dirReceipt = lstatSync(dir, { bigint: true });
  const realDir = realpathSync(dir);
  check(root, rootReceipt);
  check(dir, dirReceipt);
  check(realDir, dirReceipt);
  const add = (parent: string, receipt: typeof rootReceipt, name: string): string => {
    check(root, rootReceipt);
    check(dir, dirReceipt);
    check(parent, receipt);
    const child = join(parent, name);
    mkdirSync(child);
    check(parent, receipt);
    return child;
  };
  const alpha = add(realDir, dirReceipt, "alpha dir");
  add(alpha, lstatSync(alpha, { bigint: true }), "child dir");
  add(realDir, dirReceipt, "beta");
  add(realDir, dirReceipt, "~owned");
  if (multipleAlpha) add(realDir, dirReceipt, "alpha other");
  return realDir;
}

function makeField(base: string, submissions: SessionHostFieldSubmission[]): SessionHostTextField {
  const listeners = new Set<() => void>();
  const notify = (): void => { for (const listener of [...listeners]) listener(); };
  const field = createSessionHostTextField({
    kind: "path", workspaceBasePath: base,
    onChange: notify, onInvalidate: notify,
    onSubmit: (submission) => { submissions.push(submission); notify(); },
  });
  observers.set(field, listeners);
  return field;
}

function waitField(field: SessionHostTextField, predicate: () => boolean, description: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const listeners = observers.get(field)!;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      listeners.delete(check);
      if (error) reject(error); else resolve();
    };
    const check = (): void => {
      // Observe after the native callback has finished synchronizing the field.
      queueMicrotask(() => {
        if (settled) return;
        try { if (predicate()) finish(); } catch (error) { finish(error as Error); }
      });
    };
    const timer = setTimeout(() => finish(new Error(`${description}: deadline exceeded`)), 3_000);
    listeners.add(check);
    check();
  });
}

function typeText(field: SessionHostTextField, text: string): void {
  for (const ch of text) field.handleInput(ch);
}

async function accept(field: SessionHostTextField, expected: string): Promise<void> {
  const ready = waitField(field, () => field.getValue() === expected || field.isShowingAutocomplete(), "native completion is ready");
  field.handleInput("\t");
  await ready;
  if (field.getValue() !== expected) field.handleInput("\t");
  await waitField(field, () => field.getValue() === expected, "exact native directory insertion is accepted");
}

function submit(field: SessionHostTextField, submissions: SessionHostFieldSubmission[], expected: string): void {
  assert.equal(submissions.length, 0, "completion acceptance is distinct from submission");
  field.handleInput("\r");
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].source, "native-completion");
  assert.equal(submissions[0].value, expected);
}

async function suggestions(field: SessionHostTextField, prefix: string, labels: string[]): Promise<void> {
  const result = await field.autocompleteProvider!.getSuggestions([prefix], 0, prefix.length, {
    signal: new AbortController().signal, force: true,
  });
  assert.ok(result, "the real pinned public provider returns suggestions");
  assert.deepEqual(result.items.map((item) => item.label), labels);
}

for (const spelling of ["backslash", "forward-slash"] as const) {
  test(`real pinned provider scopes a ${spelling} drive-letter path to its intended directory`, { skip: SKIP }, async () => {
    const dir = fixtureDir();
    const submissions: SessionHostFieldSubmission[] = [];
    const field = makeField(join(projectRoot, "src"), submissions);
    try {
      const prefix = spelling === "backslash" ? join(dir, "alph") : join(dir, "alph").replace(/\\/g, "/");
      await suggestions(field, prefix, ["alpha dir/"]);
      typeText(field, prefix);
      const expected = join(dir, "alpha dir").replace(/\\/g, "/") + "/";
      await accept(field, expected);
      assert.ok(statSync(expected).isDirectory());
      assert.equal(field.getText(), `"${expected}"`);
      submit(field, submissions, expected);
    } finally { field.dispose(); }
  });
}

test("real pinned provider quotes a spaced drive directory and continues inside its closing quote", { skip: SKIP }, async () => {
  const dir = fixtureDir();
  const submissions: SessionHostFieldSubmission[] = [];
  const field = makeField(join(projectRoot, "src"), submissions);
  try {
    const prefix = join(dir, "alpha d");
    await suggestions(field, prefix, ["alpha dir/"]);
    typeText(field, prefix);
    const expected = join(dir, "alpha dir").replace(/\\/g, "/") + "/";
    await accept(field, expected);
    assert.equal(field.getText(), `"${expected}"`);
    assert.equal(field.getCursor().col, field.getText().length - 1);
    typeText(field, "child d");
    await suggestions(field, `"${expected}child d`, ["child dir/"]);
    const child = expected + "child dir/";
    await accept(field, child);
    assert.equal(field.getText(), `"${child}"`);
    assert.equal(field.getCursor().col, field.getText().length - 1);
    assert.ok(statSync(child).isDirectory());
    submit(field, submissions, child);
  } finally { field.dispose(); }
});

test("absolute Windows tilde basename stays scoped to its intended directory", { skip: SKIP }, async () => {
  const dir = fixtureDir();
  const submissions: SessionHostFieldSubmission[] = [];
  const field = makeField(join(projectRoot, "src"), submissions);
  try {
    const prefix = join(dir, "~");
    await suggestions(field, prefix, ["~owned/"]);
    typeText(field, prefix);
    const expected = join(dir, "~owned").replace(/\\/g, "/") + "/";
    await accept(field, expected);
    assert.ok(statSync(expected).isDirectory());
    submit(field, submissions, expected);
  } finally { field.dispose(); }
});

test("drive-relative C:foo is not routed as an absolute Windows path", { skip: SKIP }, async () => {
  const submissions: SessionHostFieldSubmission[] = [];
  const field = makeField(join(projectRoot, "src"), submissions);
  try {
    const result = await field.autocompleteProvider!.getSuggestions(["C:alpha"], 0, 7, {
      signal: new AbortController().signal, force: true,
    });
    assert.equal(result, null, "no match and no absolute-drive fallback");
    typeText(field, "C:alpha");
    assert.ok(!field.getValue().startsWith("C:\\") && !field.getValue().startsWith("C:/"));
  } finally { field.dispose(); }
});

for (const spelling of ["backslash", "forward-slash"] as const) {
  test(`real pinned provider accepts a spaced directory through an owned ${spelling} UNC alias`, { skip: SKIP }, async (t) => {
    const dir = fixtureDir(true);
    const drive = /^([A-Za-z]):\\(.*)$/.exec(dir);
    assert.ok(drive);
    const uncDir = `\\\\localhost\\${drive[1]}$\\${drive[2]}`;
    let available = false;
    try {
      const local = lstatSync(dir, { bigint: true });
      const alias = statSync(uncDir, { bigint: true });
      available = alias.isDirectory() && alias.dev === local.dev && alias.ino === local.ino;
    } catch { /* unavailable alias; never enumerate an administrative share root */ }
    if (!available) {
      assert.notEqual(process.env.PI_REVIEW_GATE_REQUIRE_WINDOWS_SESSION_HOST, "1",
        "opted-in UNC acceptance requires an accessible exact owned-fixture alias");
      t.skip("real exact owned UNC alias is unavailable; no UNC acceptance proof");
      return;
    }
    const submissions: SessionHostFieldSubmission[] = [];
    const field = makeField(join(projectRoot, "src"), submissions);
    try {
      // Two results require an actual menu selection; Tab cannot silently
      // auto-apply the only result before Enter's slash-command branch is tested.
      const prefix = (spelling === "backslash" ? uncDir : uncDir.replace(/\\/g, "/"))
        + (spelling === "backslash" ? "\\alpha" : "/alpha");
      await suggestions(field, prefix, ["alpha dir/", "alpha other/"]);
      typeText(field, prefix);
      const menu = waitField(field, () => field.isShowingAutocomplete(), "real UNC suggestion menu is visible");
      field.handleInput("\t");
      await menu;
      const expected = uncDir.replace(/\\/g, "/") + "/alpha dir/";
      field.handleInput("\r");
      await waitField(field, () => field.getValue() === expected, "Enter accepts the selected UNC directory");
      assert.equal(submissions.length, 0, "UNC folder acceptance must not fall through to submission");
      assert.equal(field.getText(), `"${expected}"`);
      assert.ok(statSync(expected).isDirectory());
      submit(field, submissions, expected);
    } finally { field.dispose(); }
  });
}

test("real pinned provider preserves double-leading-slash POSIX basename completion", { skip: isWindows }, async () => {
  const dir = fixtureDir();
  const submissions: SessionHostFieldSubmission[] = [];
  const field = makeField(join(projectRoot, "src"), submissions);
  try {
    const prefix = "/" + join(dir, "alpha d");
    // Quote the native query so the spaced basename remains one native token.
    await suggestions(field, `"${prefix}`, ["alpha dir/"]);
    typeText(field, `"${prefix}`);
    const expected = "/" + join(dir, "alpha dir") + "/";
    await accept(field, expected);
    assert.ok(statSync(expected).isDirectory());
    submit(field, submissions, expected);
  } finally { field.dispose(); }
});
