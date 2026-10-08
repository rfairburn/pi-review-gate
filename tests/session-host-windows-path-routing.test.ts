/**
 * Synthetic pure-routing contract for complete Windows absolute workspace
 * paths in the shared native field editor. These tests exercise only the
 * platform-independent parsing decision (drive-letter and UNC detection,
 * intended-directory/basename split, and drive-relative rejection) — no real
 * provider, no filesystem, no terminal. The real pinned-provider regression
 * and the opted-in Windows Main acceptance live in their own focused files.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseWindowsAbsolutePath } from "../src/session-host/field-editor";

test("drive-letter backslash paths split into intended directory and basename", () => {
  assert.deepEqual(parseWindowsAbsolutePath("C:\\foo\\bar"), { dirPart: "C:\\foo\\", query: "bar" });
  assert.deepEqual(parseWindowsAbsolutePath("D:\\a\\b\\c"), { dirPart: "D:\\a\\b\\", query: "c" });
  assert.deepEqual(parseWindowsAbsolutePath("Z:\\owned project\\sub"), { dirPart: "Z:\\owned project\\", query: "sub" });
});

test("drive-letter forward-slash paths split identically", () => {
  assert.deepEqual(parseWindowsAbsolutePath("C:/foo/bar"), { dirPart: "C:/foo/", query: "bar" });
  assert.deepEqual(parseWindowsAbsolutePath("D:/a/b/c"), { dirPart: "D:/a/b/", query: "c" });
});

test("drive roots and trailing separators yield an empty basename query", () => {
  assert.deepEqual(parseWindowsAbsolutePath("C:\\"), { dirPart: "C:\\", query: "" });
  assert.deepEqual(parseWindowsAbsolutePath("C:/"), { dirPart: "C:/", query: "" });
  assert.deepEqual(parseWindowsAbsolutePath("C:\\foo\\"), { dirPart: "C:\\foo\\", query: "" });
});

test("complete UNC paths (backslash and forward-slash) split at the last separator", () => {
  assert.deepEqual(parseWindowsAbsolutePath("\\\\server\\share\\folder"), { dirPart: "\\\\server\\share\\", query: "folder" });
  assert.deepEqual(parseWindowsAbsolutePath("//server/share/folder"), { dirPart: "//server/share/", query: "folder" });
  assert.deepEqual(parseWindowsAbsolutePath("\\\\server\\share\\"), { dirPart: "\\\\server\\share\\", query: "" });
});

test("drive-relative and non-Windows-absolute paths are not treated as absolute", () => {
  assert.equal(parseWindowsAbsolutePath("C:foo"), undefined, "C:foo is drive-relative, never absolute");
  assert.equal(parseWindowsAbsolutePath("C:foo\\bar"), undefined);
  assert.equal(parseWindowsAbsolutePath("relative/path"), undefined);
  assert.equal(parseWindowsAbsolutePath("/posix/absolute"), undefined, "POSIX absolute paths keep their own routing");
  assert.equal(parseWindowsAbsolutePath("~\\home"), undefined);
  assert.equal(parseWindowsAbsolutePath("C:"), undefined);
  assert.equal(parseWindowsAbsolutePath(""), undefined);
});

test("incomplete UNC forms without a share separator are not absolute", () => {
  assert.equal(parseWindowsAbsolutePath("\\\\server"), undefined, "a bare server name is not a complete UNC path");
  assert.equal(parseWindowsAbsolutePath("//server"), undefined);
  assert.equal(parseWindowsAbsolutePath("\\\\server\\"), undefined, "trailing separator without share is incomplete");
  assert.equal(parseWindowsAbsolutePath("//server/"), undefined);
  assert.equal(parseWindowsAbsolutePath("\\\\\\share\\folder"), undefined, "three leading separators are not a valid UNC prefix");
});

test("bare UNC share roots scope to the share directory with an empty query", () => {
  assert.deepEqual(parseWindowsAbsolutePath("\\\\server\\share"), { dirPart: "\\\\server\\share\\", query: "" });
  assert.deepEqual(parseWindowsAbsolutePath("//server/share"), { dirPart: "//server/share/", query: "" });
});

test("leading whitespace is ignored before the drive or UNC prefix", () => {
  assert.deepEqual(parseWindowsAbsolutePath("  C:\\foo\\bar"), { dirPart: "C:\\foo\\", query: "bar" });
  assert.deepEqual(parseWindowsAbsolutePath(" \\\\server\\share"), { dirPart: "\\\\server\\share\\", query: "" });
});

test("open native quote context preserves spaced drive and UNC basename queries", () => {
  assert.deepEqual(parseWindowsAbsolutePath('"C:\\owned project\\alpha d'), {
    dirPart: "C:\\owned project\\", query: "alpha d",
  });
  assert.deepEqual(parseWindowsAbsolutePath('"//server/share/owned project/child d'), {
    dirPart: "//server/share/owned project/", query: "child d",
  });
});

test("closed manually typed quote pairs are not stripped by Windows routing", () => {
  assert.equal(parseWindowsAbsolutePath('"C:\\owned project\\alpha"'), undefined);
  assert.equal(parseWindowsAbsolutePath('"//server/share/alpha"'), undefined);
});

test("Windows tilde basenames remain relative queries inside the intended absolute directory", () => {
  assert.deepEqual(parseWindowsAbsolutePath("C:\\owned\\~"), { dirPart: "C:\\owned\\", query: "~" });
  assert.deepEqual(parseWindowsAbsolutePath("//server/share/owned/~"), { dirPart: "//server/share/owned/", query: "~" });
});
