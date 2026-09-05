import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonObject, parseReviewResult, REVIEW_OUTPUT_JSON_SCHEMA } from "../src/schema";

test("structured-output schema requires every declared object property", () => {
  assertStrictObjectRequirements(REVIEW_OUTPUT_JSON_SCHEMA);
});

test("extractJsonObject extracts the first complete object with strings", () => {
  const raw = 'prefix {"verdict":"pass","summary":"ok { still string }","guidance":null,"findings":[],"error":null} suffix';
  assert.equal(extractJsonObject(raw), '{"verdict":"pass","summary":"ok { still string }","guidance":null,"findings":[],"error":null}');
});

test("parseReviewResult accepts clean JSON", () => {
  const result = parseReviewResult("reviewer", '{"verdict":"pass","summary":"ok","guidance":null,"findings":[],"error":null}');
  assert.equal(result.verdict, "pass");
  assert.equal(result.summary, "ok");
});

test("parseReviewResult preserves Markdown implementation guidance", () => {
  const result = parseReviewResult("reviewer", JSON.stringify({
    verdict: "needs_changes",
    summary: "Use the guarded branch.",
    guidance: "Apply this:\n\n```diff\n-old\n+new\n```",
    findings: [],
    error: null,
  }));

  assert.equal(result.guidance, "Apply this:\n\n```diff\n-old\n+new\n```");
});

test("parseReviewResult repairs literal newlines inside reviewer JSON strings", () => {
  const result = parseReviewResult(
    "reviewer",
    [
      "Review complete.",
      "```json",
      "{",
      '  "verdict": "needs_changes",',
      '  "summary": "One correction remains.",',
      '  "guidance": "Apply this:',
      "```diff",
      "-old",
      "+const mode = safe;",
      '```",',
      '  "findings": [{"severity":"blocking","file":"index.ts","line":1,"issue":"old remains","recommendation":"use new"}],',
      '  "error": null',
      "}",
      "```",
    ].join("\n"),
  );

  assert.equal(result.verdict, "needs_changes");
  assert.match(result.guidance ?? "", /```diff\n-old\n\+const mode = safe;\n```/);
  assert.equal(result.findings.length, 1);
});

test("parseReviewResult never accepts a pass that required JSON repair", () => {
  const result = parseReviewResult(
    "reviewer",
    '{"verdict":"pass","summary":"line one\nline two","guidance":null,"findings":[],"error":null}',
  );
  assert.equal(result.verdict, "error");
  assert.equal(result.error, "invalid_json");
});

test("parseReviewResult reports malformed review-shaped JSON as invalid JSON", () => {
  const result = parseReviewResult("reviewer", '{"verdict":"pass","summary":"unterminated,"guidance":null,"findings":[],"error":null}');
  assert.equal(result.verdict, "error");
  assert.equal(result.error, "invalid_json");
  assert.equal(result.summary, "Reviewer returned invalid JSON.");
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
        guidance: null,
        findings: [],
        error: null,
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
        guidance: null,
        findings: [],
        error: null,
      }),
      "",
      "```json",
      JSON.stringify({
        verdict: "pass",
        summary: "authoritative fenced result",
        guidance: null,
        findings: [],
        error: null,
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
        guidance: null,
        findings: [],
        error: null,
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
      guidance: null,
      findings: [
        {
          severity: "blocking",
          file: "src/a.ts",
          line: 12,
          issue: "bug",
          recommendation: "fix it",
        },
      ],
      error: null,
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
      guidance: null,
      findings: [
        {
          severity: "blocking",
          file: null,
          line: null,
          issue: "required command was not run",
          recommendation: "run npm test",
        },
      ],
      error: null,
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
      guidance: null,
      findings: [
        {
          severity: "blocking",
          file: null,
          line: null,
          issue: "The project instructions require `npm run lint`, `npm run format:check`, and a final `npm test` before considering code changes complete. The session evidence shows `npm test` was attempted only once via `npm test 2>&1 | tail -30` and timed out, then the agent ran focused tests only. There is no evidence that lint or format checks were run, and focused tests are explicitly not a substitute for the final full `npm test` run.",
          recommendation: "Run `npm run lint`, `npm run format:check`, and `npm test` successfully, or document the exact environmental reason if any required command cannot complete.",
        },
      ],
      error: null,
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

test("parseReviewResult fails closed on a truncated pass object", () => {
  const result = parseReviewResult(
    "reviewer",
    '{"verdict":"pass","summary":"ok","guidance":null,"findings":[],"error":null',
  );
  assert.equal(result.verdict, "error");
  assert.equal(result.error, "invalid_json");
});

test("parseReviewResult enforces required and supported top-level fields", () => {
  const missing = parseReviewResult("reviewer", '{"verdict":"pass","summary":"ok"}');
  assert.equal(missing.verdict, "error");
  assert.equal(missing.error, "schema_error");

  const extra = parseReviewResult(
    "reviewer",
    '{"verdict":"pass","summary":"ok","guidance":null,"findings":[],"error":null,"extra":true}',
  );
  assert.equal(extra.verdict, "error");
  assert.equal(extra.error, "schema_error");
});

test("parseReviewResult rejects gate-owned identity keys from model output", () => {
  // Reviewer output can never stamp its own identity: every gate-owned
  // identity key is outside the parse allowlist, so a model that emits one
  // fails closed as a schema error instead of rewriting attribution.
  for (const key of ["reviewerId", "displayLabel", "reviewerAdapter", "reviewerConfigFingerprint"]) {
    const result = parseReviewResult("one", JSON.stringify({
      verdict: "pass",
      summary: "ok",
      guidance: null,
      findings: [],
      error: null,
      [key]: "forged-identity",
    }));
    assert.equal(result.verdict, "error", key);
    assert.equal(result.error, "schema_error", key);
  }
});

test("parseReviewResult treats unsupported null properties as absent", () => {
  const topLevel = parseReviewResult(
    "reviewer",
    '{"verdict":"pass","summary":"ok","guidance":null,"guidance_note":null,"findings":[],"error":null}',
  );
  assert.equal(topLevel.verdict, "pass");
  assert.equal(topLevel.error, undefined);

  const finding = parseReviewResult("reviewer", JSON.stringify({
    verdict: "needs_changes",
    summary: "fix it",
    guidance: null,
    findings: [{
      severity: "blocking",
      file: "src/index.ts",
      line: 1,
      issue: "broken",
      recommendation: "repair it",
      guidance_note: null,
    }],
    error: null,
  }));
  assert.equal(finding.verdict, "needs_changes");
  assert.equal(finding.error, undefined);
  assert.equal(finding.findings.length, 1);

  const substantiveExtra = parseReviewResult(
    "reviewer",
    '{"verdict":"pass","summary":"ok","guidance":null,"guidance_note":"consider this","findings":[],"error":null}',
  );
  assert.equal(substantiveExtra.verdict, "error");
  assert.equal(substantiveExtra.error, "schema_error");
});

function assertStrictObjectRequirements(schema: unknown): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return;
  const value = schema as Record<string, unknown>;
  if (value.type === "object") {
    assert.equal(value.additionalProperties, false);
    assert.ok(typeof value.properties === "object" && value.properties !== null && !Array.isArray(value.properties));
    const properties = value.properties as Record<string, unknown>;
    assert.ok(Array.isArray(value.required));
    assert.deepEqual(new Set(value.required), new Set(Object.keys(properties)));
    for (const child of Object.values(properties)) assertStrictObjectRequirements(child);
  }
  if (value.type === "array") assertStrictObjectRequirements(value.items);
}
