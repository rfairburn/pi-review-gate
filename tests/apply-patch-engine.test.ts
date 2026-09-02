// Ported, representative subset of the official OpenAI Agents JS applyDiff
// V4A compatibility tests.
//
// Source: https://github.com/openai/openai-agents-js
//         packages/agents-core/test/utils/applyDiff.test.ts
// Copyright (c) 2025 OpenAI, MIT License (see LICENSES/MIT-openai-agents-js.txt).
// The full engine is adapted in src/apply-patch/engine.ts; these cases lock the
// parser behavior pi-review-gate depends on (first-match anchors, whitespace
// fuzz, EOF handling, trailing-newline preservation, create mode).
import assert from "node:assert/strict";
import test from "node:test";
import { applyDiff } from "../src/apply-patch/engine";

test("applies added lines to empty input via V4A floating hunk", () => {
  const diff = ["@@", "+hello", "+world"].join("\n");
  assert.equal(applyDiff("", diff), "hello\nworld\n");
});

test("applies plus-prefixed content for create mode", () => {
  const diff = ["+hello", "+world", "+"].join("\n");
  assert.equal(applyDiff("", diff, "create"), "hello\nworld\n");
});

test("rejects create diff without + prefixes", () => {
  const diff = ["line1", "line2"].join("\n");
  assert.throws(() => applyDiff("", diff, "create"));
});

test("applies floating hunk without marker or line numbers", () => {
  const input = ["- Milk", "- Bread", "- Eggs", "- Apples", "- Coffee"].join("\n");
  const diff = [
    "@@",
    " - Milk",
    " - Bread",
    " - Eggs",
    "-- Apples",
    "-- Coffee",
    "+- [x] Apples",
    "+- [x] Coffee",
  ].join("\n");
  assert.equal(
    applyDiff(input, diff),
    ["- Milk", "- Bread", "- Eggs", "- [x] Apples", "- [x] Coffee"].join("\n"),
  );
});

test("applies V4A replacements with context", () => {
  const input = ["line1", "line2", "line3"].join("\n") + "\n";
  const diff = ["@@ line1", "-line2", "+updated", " line3"].join("\n");
  assert.equal(applyDiff(input, diff), ["line1", "updated", "line3"].join("\n") + "\n");
});

test("applies V4A deletions", () => {
  const input = ["keep", "remove me", "stay"].join("\n") + "\n";
  const diff = ["@@ keep", "-remove me", " stay"].join("\n");
  assert.equal(applyDiff(input, diff), ["keep", "stay"].join("\n") + "\n");
});

test("appends EOF hunks without changing the trailing newline state", () => {
  const diff = ["@@", "+c", "*** End of File"].join("\n");
  assert.equal(applyDiff("a\nb\n", diff), "a\nb\nc\n");
  assert.equal(applyDiff("a\nb", diff), "a\nb\nc");
});

test("matches EOF context at the final occurrence across multiple hunks", () => {
  const input = "start\nx\nfoo\ny\nfoo\n";
  const diff = [
    "@@",
    "-start",
    "+updated",
    "@@",
    " foo",
    "+added",
    "*** End of File",
  ].join("\n");
  assert.equal(applyDiff(input, diff), "updated\nx\nfoo\ny\nfoo\nadded\n");
});

test("preserves an intentional blank line before an EOF append", () => {
  const input = "a\n\n";
  const diff = ["@@", "+b", "*** End of File"].join("\n");
  assert.equal(applyDiff(input, diff), "a\n\nb\n");
});

test("applies V4A context marker diffs (class method rename)", () => {
  const input = [
    "class Foo:",
    "    def baz(self):",
    '        return f"foo {randint()}"',
    "",
    "def main():",
    "    foo = Foo()",
    "    print(foo.baz())",
  ].join("\n") + "\n";
  const diff = [
    "@@ class Foo:",
    "-    def baz(self):",
    "+    def rand(self):",
    '        return f"foo {randint()}"',
    "@@ def main():",
    "     foo = Foo()",
    "-    print(foo.baz())",
    "+    print(foo.rand())",
  ].join("\n");
  assert.equal(
    applyDiff(input, diff),
    [
      "class Foo:",
      "    def rand(self):",
      '        return f"foo {randint()}"',
      "",
      "def main():",
      "    foo = Foo()",
      "    print(foo.rand())",
    ].join("\n") + "\n",
  );
});

test("applies stacked anchors in sequence", () => {
  const input = [
    "class BaseClass",
    "    def search():",
    "        pass",
    "",
    "class Subclass",
    "    def search():",
    "        pass",
  ].join("\n") + "\n";
  const diff = [
    "@@ class BaseClass",
    "@@     def search():",
    "-        pass",
    "+        raise NotImplementedError()",
    "@@ class Subclass",
    "@@     def search():",
    "-        pass",
    "+        raise NotImplementedError()",
  ].join("\n");
  assert.equal(
    applyDiff(input, diff),
    [
      "class BaseClass",
      "    def search():",
      "        raise NotImplementedError()",
      "",
      "class Subclass",
      "    def search():",
      "        raise NotImplementedError()",
    ].join("\n") + "\n",
  );
});

test("uses each stacked anchor to narrow the target", () => {
  const input = [
    "class First",
    "    def target():",
    "        return 0",
    "",
    "class Second",
    "    def helper():",
    "        pass",
    "",
    "    def target():",
    "        pass",
  ].join("\n") + "\n";
  const diff = [
    "@@ class Second",
    "@@     def target():",
    "-        pass",
    "+        return 1",
  ].join("\n");
  assert.equal(
    applyDiff(input, diff),
    [
      "class First",
      "    def target():",
      "        return 0",
      "",
      "class Second",
      "    def helper():",
      "        pass",
      "",
      "    def target():",
      "        return 1",
    ].join("\n") + "\n",
  );
});

test("rejects partially matched stacked anchors", () => {
  const input = [
    "class Target",
    "    def helper():",
    "        pass",
    "",
    "    def desired():",
    "        return 1",
  ].join("\n") + "\n";
  const diff = [
    "@@ class Target",
    "@@     def missing():",
    "-        pass",
    "+        return 99",
  ].join("\n");
  assert.throws(() => applyDiff(input, diff), /Invalid Anchor/);
});

test("rejects a missing anchor followed by a bare marker", () => {
  const input = "a\nb\n";
  const diff = ["@@ missing", "@@", "-b", "+B"].join("\n");
  assert.throws(() => applyDiff(input, diff), /Invalid Anchor/);
});

test("accepts a trailing bare anchor in a stack", () => {
  const input = "class Only\n    def run():\n        pass\n";
  const diff = ["@@ class Only", "@@", "-        pass", "+        return 1"].join("\n");
  assert.equal(applyDiff(input, diff), "class Only\n    def run():\n        return 1\n");
});

test("treats line-number markers as context anchors", () => {
  const input = "one\ntwo\n";
  const diff = ["@@ -1,2 +1,2 @@", " one", "-two", "+2"].join("\n");
  assert.equal(applyDiff(input, diff), "one\n2\n");
});

test("throws on context mismatch", () => {
  const input = "one\ntwo\n";
  const diff = ["@@ -1,2 +1,2 @@", " x", "-two", "+2"].join("\n");
  assert.throws(() => applyDiff(input, diff), /Invalid Context/);
});

test("matches context with trailing-whitespace fuzz on the file side", () => {
  const input = ["env: dev  ", "debug: false", "log_level: info"].join("\n");
  const diff = [" env: dev", "-debug: false", "+debug: true", " log_level: info"].join("\n");
  assert.equal(
    applyDiff(input, diff),
    ["env: dev  ", "debug: true", "log_level: info"].join("\n"),
  );
});

test("preserves the first match instead of imposing unique-anchor matching", () => {
  const input = "alpha\nbeta\nalpha\n";
  const diff = ["-alpha", "+first"].join("\n");
  assert.equal(applyDiff(input, diff), "first\nbeta\nalpha\n");
});

test("Example 3: config.yml toggle debug flag with context", () => {
  const input = ["env: dev", "debug: false", "log_level: info"].join("\n");
  const diff = [" env: dev", "-debug: false", "+debug: true", " log_level: info"].join("\n");
  assert.equal(applyDiff(input, diff, "default"), ["env: dev", "debug: true", "log_level: info"].join("\n"));
});

test("Example 4: pure insertion between context lines", () => {
  const input = ["import os", "", "def main():", '    print("Running app")'].join("\n");
  const diff = [" import os", "+import sys", "", " def main():", '     print("Running app")'].join("\n");
  assert.equal(
    applyDiff(input, diff, "default"),
    ["import os", "import sys", "", "def main():", '    print("Running app")'].join("\n"),
  );
});

test("Example 12: create file with blank line", () => {
  const diff = ["+MIT License", "+", "+Copyright (c) 2025"].join("\n");
  assert.equal(applyDiff("", diff, "create"), ["MIT License", "", "Copyright (c) 2025"].join("\n"));
});

test("Example 14: move keeps content unchanged; delete body is a no-op", () => {
  const input = "Legacy content";
  assert.equal(applyDiff(input, [" Legacy content"].join("\n"), "default"), "Legacy content");
  assert.equal(applyDiff(input, "", "default"), input);
});

test("Example 20: two separate hunks in one file using @@", () => {
  const input = [
    "function add(a, b) {",
    "  return a + b;",
    "}",
    "",
    "function greet(name) {",
    '  return "Hello " + name;',
    "}",
  ].join("\n");
  const diff = [
    "@@",
    "-function add(a, b) {",
    "-  return a + b;",
    "-}",
    "+function add(a, b) {",
    "+  return a + b; // simple add",
    "+}",
    " ",
    " function greet(name) {",
    '-  return "Hello " + name;',
    "-}",
    "+  return `Hello ${name}!`;",
    "+}",
  ].join("\n");
  assert.equal(
    applyDiff(input, diff, "default"),
    [
      "function add(a, b) {",
      "  return a + b; // simple add",
      "}",
      "",
      "function greet(name) {",
      "  return `Hello ${name}!`;",
      "}",
    ].join("\n"),
  );
});