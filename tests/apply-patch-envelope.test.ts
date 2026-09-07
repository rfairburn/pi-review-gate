import assert from "node:assert/strict";
import test from "node:test";
import { extractEnvelopeCandidatePaths, parseApplyPatchEnvelope } from "../src/apply-patch/envelope";

function envelope(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

test("a mixed multi-file envelope parses into ordered file operations", () => {
  const ops = parseApplyPatchEnvelope(
    envelope(
      "*** Add File: src/new.txt",
      "+hello",
      "+world",
      "*** Update File: keep.txt",
      "*** Move to: moved/keep.txt",
      "@@ one",
      " one",
      "-two",
      "+TWO",
      "*** Delete File: drop.txt",
    ),
  );
  assert.deepEqual(ops, [
    { type: "create_file", path: "src/new.txt", createContent: "hello\nworld\n" },
    { type: "update_file", path: "keep.txt", moveTo: "moved/keep.txt", diff: "@@ one\n one\n-two\n+TWO" },
    { type: "delete_file", path: "drop.txt" },
  ]);
});

test("Add File lines each contribute line + newline (Codex newline semantics)", () => {
  const single = parseApplyPatchEnvelope(envelope("*** Add File: a.txt", "+x"));
  assert.equal(single[0]!.createContent, "x\n");

  // A bare '+' line contributes an empty line; the file always ends with a
  // newline regardless of whether the patch text has a trailing newline.
  const withBlank = parseApplyPatchEnvelope(envelope("*** Add File: b.txt", "+a", "+"));
  assert.equal(withBlank[0]!.createContent, "a\n\n");

  const trailing = parseApplyPatchEnvelope(envelope("*** Add File: c.txt", "+a\n+world"));
  assert.equal(trailing[0]!.createContent, "a\nworld\n");
});

test("the first update chunk may omit its @@ marker and hunks keep bare empty context lines", () => {
  const ops = parseApplyPatchEnvelope(
    envelope(
      "*** Update File: a.txt",
      "-one",
      "+ONE",
      "@@ two",
      "",
      " three",
    ),
  );
  assert.equal(ops[0]!.type, "update_file");
  assert.equal(ops[0]!.diff, "-one\n+ONE\n@@ two\n\n three");
});

test("the End of File marker is preserved in the diff body as an EOF anchor", () => {
  const ops = parseApplyPatchEnvelope(
    envelope("*** Update File: a.txt", "@@", "+tail", "*** End of File"),
  );
  assert.equal(ops[0]!.diff, "@@\n+tail\n*** End of File");
});

test("a shell-style heredoc wrapper is unwrapped before parsing (lenient mode)", () => {
  const wrapped = "<<EOF\n" + envelope("*** Add File: a.txt", "+x") + "\nEOF";
  const ops = parseApplyPatchEnvelope(wrapped);
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.path, "a.txt");
});

test("Environment ID lines are rejected: this tool patches the local workspace only", () => {
  assert.throws(
    () => parseApplyPatchEnvelope(envelope("*** Environment ID: remote-1", "*** Add File: a.txt", "+x")),
    /environment_id is not supported/,
  );
});

test("boundary markers are enforced with Codex-style diagnostics", () => {
  assert.throws(() => parseApplyPatchEnvelope("*** Add File: a.txt\n+x"), /first line of the patch must be '\*\*\* Begin Patch'/);
  assert.throws(
    () => parseApplyPatchEnvelope("*** Begin Patch\n*** Add File: a.txt\n+x"),
    /last line of the patch must be '\*\*\* End Patch'/,
  );
  // A single-line patch is missing its last line, not its first.
  assert.throws(() => parseApplyPatchEnvelope("*** Begin Patch"), /last line of the patch must be/);
  assert.throws(() => parseApplyPatchEnvelope(""), /patch is required/);
});

test("update hunks without change lines are rejected with informative errors", () => {
  // Header immediately followed by another header: empty hunk.
  assert.throws(
    () => parseApplyPatchEnvelope(envelope("*** Update File: a.txt", "*** Delete File: b.txt")),
    /Update file hunk for path 'a\.txt' is empty/,
  );
  // A chunk marker with no lines at End Patch.
  assert.throws(
    () => parseApplyPatchEnvelope(envelope("*** Update File: a.txt", "@@")),
    /Update hunk does not contain any lines/,
  );
  // A line that is neither context, addition, removal, nor a header.
  assert.throws(
    () => parseApplyPatchEnvelope(envelope("*** Update File: a.txt", "nope")),
    /Every line should start with ' ' \(context line\), '\+' \(added line\), or '-' \(removed line\)/,
  );
});

test("Move to must precede the change lines of its hunk", () => {
  assert.throws(
    () => parseApplyPatchEnvelope(envelope("*** Update File: a.txt", "-x", "*** Move to: b.txt")),
    /Expected update hunk to start with a @@ context marker|Every line should start with ' '|Unexpected line found in update hunk/,
  );
});

test("paths normalize a single leading @ convention marker", () => {
  const ops = parseApplyPatchEnvelope(envelope("*** Delete File: @src/a.txt"));
  assert.equal(ops[0]!.path, "src/a.txt");
  // A header without the required ": <path>" is not a valid hunk header at
  // all (Codex requires the space), while a marker-only path is rejected by
  // normalization.
  assert.throws(() => parseApplyPatchEnvelope(envelope("*** Add File:", "+x")), /not a valid hunk header/);
  assert.throws(() => parseApplyPatchEnvelope(envelope("*** Add File: @", "+x")), /requires a non-empty path/);
});

test("extractEnvelopeCandidatePaths reports every target including move destinations", () => {
  const candidates = extractEnvelopeCandidatePaths(
    envelope(
      "*** Add File: src/new.txt",
      "+hello",
      "*** Update File: keep.txt",
      "*** Move to: moved/keep.txt",
      "@@ one",
      "-two",
      "+TWO",
      "*** Delete File: drop.txt",
    ),
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.path),
    ["src/new.txt", "keep.txt", "moved/keep.txt", "drop.txt"],
  );
});

test("extractEnvelopeCandidatePaths falls back to a header scan for malformed envelopes", () => {
  // Missing End Patch: the full parser rejects, but the evidence scanner must
  // still pre-capture the intended targets.
  const candidates = extractEnvelopeCandidatePaths(
    "*** Begin Patch\n*** Add File: src/new.txt\n+x\n*** Update File: keep.txt\n@@ one\n-two\n+TWO",
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.path),
    ["src/new.txt", "keep.txt"],
  );
});
