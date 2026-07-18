import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonObject, parseReviewResult } from "../src/schema";

test("extractJsonObject extracts the first complete object with strings", () => {
  const raw = 'prefix {"verdict":"pass","summary":"ok { still string }","findings":[]} suffix';
  assert.equal(extractJsonObject(raw), '{"verdict":"pass","summary":"ok { still string }","findings":[]}');
});

test("parseReviewResult accepts clean JSON", () => {
  const result = parseReviewResult("reviewer", '{"verdict":"pass","summary":"ok","findings":[]}');
  assert.equal(result.verdict, "pass");
  assert.equal(result.summary, "ok");
});

test("parseReviewResult accepts a fenced JSON review after prose containing braces", () => {
  const result = parseReviewResult(
    "reviewer",
    [
      "All blocking issues have been fixed:",
      "1. capturedPieces now uses `{{white: string[], black: string[]}}`.",
      "2. MoveResult now uses `{ok: false, reason}` and `{ok: true, ...}`.",
      "",
      "```json",
      JSON.stringify({
        verdict: "pass",
        summary: "All blocking issues were fixed.",
        findings: [],
      }),
      "```",
    ].join("\n"),
  );

  assert.equal(result.verdict, "pass");
  assert.equal(result.summary, "All blocking issues were fixed.");
});

test("parseReviewResult prefers a JSON fence over earlier balanced review-shaped prose", () => {
  const result = parseReviewResult(
    "reviewer",
    [
      "An earlier example was:",
      JSON.stringify({
        verdict: "needs_changes",
        summary: "stale example",
        findings: [],
      }),
      "",
      "```json",
      JSON.stringify({
        verdict: "pass",
        summary: "authoritative fenced result",
        findings: [],
      }),
      "```",
    ].join("\n"),
  );

  assert.equal(result.verdict, "pass");
  assert.equal(result.summary, "authoritative fenced result");
});

test("parseReviewResult scans later balanced objects for a schema-valid review", () => {
  const result = parseReviewResult(
    "reviewer",
    [
      "Runtime shape: {{white: string[], black: string[]}}",
      "Metadata example: {\"kind\":\"review\"}",
      JSON.stringify({
        verdict: "pass",
        summary: "later object accepted",
        findings: [],
      }),
    ].join("\n"),
  );

  assert.equal(result.verdict, "pass");
  assert.equal(result.summary, "later object accepted");
});

test("parseReviewResult treats blocking findings as needs_changes", () => {
  const result = parseReviewResult(
    "reviewer",
    JSON.stringify({
      verdict: "pass",
      summary: "has issue",
      findings: [
        {
          severity: "blocking",
          file: "src/a.ts",
          line: 12,
          issue: "bug",
          recommendation: "fix it",
        },
      ],
    }),
  );
  assert.equal(result.verdict, "needs_changes");
});

test("parseReviewResult normalizes null finding files to session", () => {
  const result = parseReviewResult(
    "reviewer",
    JSON.stringify({
      verdict: "needs_changes",
      summary: "missing command",
      findings: [
        {
          severity: "blocking",
          file: null,
          line: null,
          issue: "required command was not run",
          recommendation: "run npm test",
        },
      ],
    }),
  );

  assert.equal(result.verdict, "needs_changes");
  assert.equal(result.findings[0]?.file, "session");
  assert.equal(result.findings[0]?.line, null);
});

test("parseReviewResult accepts session-level missing acceptance verification findings", () => {
  const result = parseReviewResult(
    "reviewer",
    JSON.stringify({
      verdict: "needs_changes",
      summary: "The implementation appears to address the build_chess_mjs.js finding itself, and updating ../outsidefiles/review.md was explicitly requested. However, the submitted session does not include the required acceptance verification for code changes.",
      findings: [
        {
          severity: "blocking",
          file: null,
          line: null,
          issue: "The project instructions require `npm run lint`, `npm run format:check`, and a final `npm test` before considering code changes complete. The session evidence shows `npm test` was attempted only once via `npm test 2>&1 | tail -30` and timed out, then the agent ran focused tests only. There is no evidence that lint or format checks were run, and focused tests are explicitly not a substitute for the final full `npm test` run.",
          recommendation: "Run `npm run lint`, `npm run format:check`, and `npm test` successfully, or document the exact environmental reason if any required command cannot complete.",
        },
      ],
    }),
  );

  assert.equal(result.verdict, "needs_changes");
  assert.equal(result.error, undefined);
  assert.equal(result.findings[0]?.severity, "blocking");
  assert.equal(result.findings[0]?.file, "session");
  assert.match(result.findings[0]?.issue ?? "", /npm run lint/);
});

test("parseReviewResult rejects invalid output safely", () => {
  const result = parseReviewResult("reviewer", "not json");
  assert.equal(result.verdict, "error");
  assert.equal(result.error, "missing_json");
});
