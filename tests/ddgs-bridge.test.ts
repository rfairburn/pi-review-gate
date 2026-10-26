import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

// Execute the real packaged bridge with an in-memory DDGS stand-in. This is
// deterministic contract coverage, not an installed-DDGS or live-provider test.
const pythonAvailable = spawnSync("python3", ["-B", "-I", "-c", "import sys"], { stdio: "ignore" }).status === 0;
const options = { skip: pythonAvailable ? false : "python3 with isolated mode is required" };
const driver = `
import json, runpy, sys, types
scenario = json.loads(sys.argv[2])
calls = []
class DDGS:
    def __init__(self, timeout):
        calls.append({"timeout": timeout})
    def text(self, query, *, region, timelimit, max_results, backend):
        calls.append(dict(query=query, region=region, timelimit=timelimit,
                          max_results=max_results, backend=backend))
        if "error" in scenario:
            raise RuntimeError(scenario["error"])
        return scenario.get("rows", [])
module = types.ModuleType("ddgs")
module.DDGS = DDGS
sys.modules["ddgs"] = module
try:
    runpy.run_path(sys.argv[1], run_name="__main__")
finally:
    print(json.dumps(calls), file=sys.stderr)
`;

function runBridge(request: unknown, scenario: { rows?: unknown[]; error?: string } = {}) {
  const result = spawnSync("python3", [
    "-B", "-I", "-c", driver, resolve(__dirname, "../../scripts/ddgs-search.py"), JSON.stringify(scenario),
  ], { input: JSON.stringify(request), encoding: "utf8", timeout: 5_000 });
  assert.ifError(result.error);
  return { status: result.status, response: JSON.parse(result.stdout), calls: JSON.parse(result.stderr) };
}

test("DDGS bridge preserves options, timeout rounding, and filtered result schema", options, () => {
  const result = runBridge({
    query: "  dependency hygiene  ", maxResults: 100, timeoutMs: 1_001, region: "  uk-en  ", timelimit: "m",
  }, { rows: [
    { title: "One", href: "https://example.com/1", body: "Snippet", date: "2026-01-01", extra: "not exposed" },
    { title: "Two", href: "https://example.com/2", body: "", date: 42 },
    { title: "Three", href: "https://example.com/3", body: "Snippet", date: "" },
    { title: "Missing body", href: "https://example.com/4" },
    { title: 42, href: "https://example.com/5", body: "Snippet" },
    null,
  ] });
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, [
    { timeout: 2 },
    { query: "dependency hygiene", region: "uk-en", timelimit: "m", max_results: 100, backend: "auto" },
  ]);
  assert.deepEqual(result.response, { ok: true, results: [
    { title: "One", href: "https://example.com/1", body: "Snippet", date: "2026-01-01" },
    { title: "Two", href: "https://example.com/2", body: "" },
    { title: "Three", href: "https://example.com/3", body: "Snippet" },
  ] });
});

test("DDGS bridge retains defaults and timeout bounds", options, () => {
  for (const [timeoutMs, seconds] of [[1, 1], [1_000, 1], [3_600_000, 3_600]]) {
    const result = runBridge({ query: "query", maxResults: 1, timeoutMs });
    assert.equal(result.status, 0);
    assert.deepEqual(result.response, { ok: true, results: [] });
    assert.deepEqual(result.calls, [
      { timeout: seconds },
      { query: "query", region: "us-en", timelimit: null, max_results: 1, backend: "auto" },
    ]);
  }
});

test("DDGS bridge refuses invalid requests before calling the provider", options, () => {
  const valid = { query: "query", maxResults: 1, timeoutMs: 1 };
  const cases: Array<[unknown, string]> = [
    [[], "request must be a JSON object"],
    [{ ...valid, query: null }, "query is required"],
    [{ ...valid, query: " " }, "query must be a non-empty string"],
    ...[0, 101, true, 1.5].map((maxResults): [unknown, string] => [
      { ...valid, maxResults }, "maxResults must be an integer from 1 through 100",
    ]),
    ...[0, 3_600_001, true].map((timeoutMs): [unknown, string] => [
      { ...valid, timeoutMs }, "timeoutMs must be an integer from 1 through 3600000",
    ]),
    [{ ...valid, region: "" }, "region must be a non-empty string"],
    [{ ...valid, timelimit: "all" }, "timelimit must be d, w, m, or y"],
  ];
  for (const [request, error] of cases) {
    const result = runBridge(request);
    assert.equal(result.status, 1);
    assert.deepEqual(result.response, { ok: false, error });
    assert.deepEqual(result.calls, []);
  }
});

test("DDGS bridge retains provider-error JSON and nonzero exit status", options, () => {
  for (const [error, expected] of [["provider unavailable", "provider unavailable"], ["", "RuntimeError"]]) {
    const result = runBridge({ query: "query", maxResults: 1, timeoutMs: 1 }, { error });
    assert.equal(result.status, 1);
    assert.deepEqual(result.response, { ok: false, error: expected });
    assert.equal(result.calls.length, 2, "the provider was called before reporting its error");
  }
});
