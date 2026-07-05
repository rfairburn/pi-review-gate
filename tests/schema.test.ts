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

test("parseReviewResult rejects invalid output safely", () => {
  const result = parseReviewResult("reviewer", "not json");
  assert.equal(result.verdict, "error");
  assert.equal(result.error, "missing_json");
});
