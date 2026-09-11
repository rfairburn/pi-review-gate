import assert from "node:assert/strict";
import test from "node:test";
import { DeferredToolManager } from "../src/deferred-tools";
import { isExpandableResult } from "../src/tool-result-expansion";

const theme = {
  bold: (value: string) => value,
  fg: (_color: string, value: string) => value,
};

interface Definition {
  name: string;
  description: string;
  execute?: (id: string, params: unknown) => Promise<Record<string, unknown>>;
  renderResult?: (value: unknown, options: unknown, theme: unknown, context?: unknown) => unknown;
}

function render(tool: Definition, value: unknown, options: Record<string, unknown>, args: unknown, width = 200): string[] {
  assert.ok(tool.renderResult);
  const component = tool.renderResult(value, options, theme, { args });
  assert.ok(component && typeof (component as { render?: unknown }).render === "function");
  return (component as { render(width: number): string[] }).render(width);
}

test("registered search_tools card matches the canonical activated shape end to end", async () => {
  const fixture = fixtureWithSearch();
  const params = { query: "InactiveRunner" };
  fixture.manager.sessionStart(fixture.sessionIdentity);
  const result = await fixture.search("search-1", params);
  const tool = fixture.tool;

  assert.equal(isExpandableResult(tool.renderResult), true);
  const collapsedLines = render(tool, result, { expanded: false, isPartial: false }, params);
  const collapsed = collapsedLines.join("\n");
  const expandedLines = render(tool, result, { expanded: true, isPartial: false }, params);
  const expanded = expandedLines.join("\n");

  // Canonical collapsed card: quoted query plus the activation outcome; the
  // shared wrapper owns the single hint, so the family renderer emits none.
  assert.equal(collapsedLines[0], 'search_tools · "InactiveRunner" · activated InactiveRunner');
  assert.doesNotMatch(collapsed, /ctrl\+o/);

  // Canonical expanded card: query, matched, newly activated, omitted count,
  // next-turn availability and the no-operation boundary, in order.
  assert.equal(expandedLines[0], "search_tools");
  const queryAt = expanded.indexOf("Query: InactiveRunner");
  const matchedAt = expanded.indexOf("Matched authorized tools:");
  const activatedAt = expanded.indexOf("Newly activated:");
  const omittedAt = expanded.indexOf("Omitted matches: 0");
  const nextTurnAt = expanded.indexOf("The tool is available on the next turn.");
  const noOpAt = expanded.indexOf("No InactiveRunner operation was executed by this search.");
  assert.ok(queryAt >= 0 && matchedAt > queryAt && activatedAt > matchedAt && omittedAt > activatedAt
    && nextTurnAt > omittedAt && noOpAt > nextTurnAt, expanded);
  assert.ok(expandedLines.includes("  InactiveRunner"), expanded);
  assert.doesNotMatch(expanded, /executed the discovered tool|was executed by this executor/);

  assert.deepEqual((result.details as { matched: string[] }).matched, ["InactiveRunner"]);
  assert.deepEqual((result.details as { activated: string[] }).activated, ["InactiveRunner"]);
  assert.equal((result.details as { omitted: number }).omitted, 0);
  assert.deepEqual(fixture.active(), ["read", "search_tools", "InactiveRunner"]);
});

test("search_tools expansion distinguishes already-active, no-match and mixed activation truthfully", async () => {
  const already = fixtureWithSearch();
  already.manager.sessionStart(already.sessionIdentity, undefined, false, false);
  const alreadyParams = { query: "AlreadyRunner" };
  const alreadyResult = await already.search("already", alreadyParams);
  const alreadyCollapsed = render(already.tool, alreadyResult, { expanded: false, isPartial: false }, alreadyParams).join("\n");
  const alreadyExpandedLines = render(already.tool, alreadyResult, { expanded: true, isPartial: false }, alreadyParams);
  const alreadyExpanded = alreadyExpandedLines.join("\n");
  assert.equal(alreadyCollapsed, 'search_tools · "AlreadyRunner" · already active AlreadyRunner');
  assert.ok(alreadyExpandedLines.includes("Already active:"));
  assert.ok(alreadyExpandedLines.includes("  AlreadyRunner"));
  assert.match(alreadyExpanded, /Newly activated:\n  \(none\)/);
  assert.match(alreadyExpanded, /The matched tool was already active\./);
  assert.match(alreadyExpanded, /No AlreadyRunner operation was executed by this search\./);
  assert.doesNotMatch(alreadyExpanded, /available on the next turn/);
  assert.deepEqual((alreadyResult.details as { activated: string[] }).activated, []);
  assert.deepEqual((alreadyResult.details as { alreadyActive: string[] }).alreadyActive, ["AlreadyRunner"]);

  const missing = fixtureWithSearch();
  missing.manager.sessionStart(missing.sessionIdentity);
  const missingParams = { query: "does-not-exist" };
  const missingResult = await missing.search("missing", missingParams);
  const missingCollapsed = render(missing.tool, missingResult, { expanded: false, isPartial: false }, missingParams).join("\n");
  const missingExpanded = render(missing.tool, missingResult, { expanded: true, isPartial: false }, missingParams).join("\n");
  assert.equal(missingCollapsed, 'search_tools · "does-not-exist" · no matches');
  assert.match(missingExpanded, /Outcome: no authorized tools matched; no tools were activated\./);
  assert.match(missingExpanded, /Matched authorized tools:\n  \(none\)/);
  assert.doesNotMatch(missingExpanded, /Omitted matches/);
  assert.deepEqual((missingResult.details as { matched: string[] }).matched, []);

  // Mixed activation: activate one match first, then a broader query matches
  // it (already active) plus a second tool (newly activated).
  const mixed = fixtureWithSearch();
  mixed.manager.sessionStart(mixed.sessionIdentity);
  await mixed.search("mixed-1", { query: "InactiveRunner" });
  const mixedParams = { query: "runner" };
  const mixedResult = await mixed.search("mixed-2", mixedParams);
  const mixedCollapsedLines = render(mixed.tool, mixedResult, { expanded: false, isPartial: false }, mixedParams);
  const mixedExpandedLines = render(mixed.tool, mixedResult, { expanded: true, isPartial: false }, mixedParams);
  const mixedExpanded = mixedExpandedLines.join("\n");
  assert.equal(mixedCollapsedLines[0], 'search_tools · "runner" · activated AlreadyRunner');
  assert.match(mixedCollapsedLines.join("\n"), /Already active \(1\): InactiveRunner\./);
  assert.ok(mixedExpandedLines.includes("Newly activated:"));
  assert.ok(mixedExpandedLines.includes("Already active:"));
  assert.ok(mixedExpandedLines.includes("  AlreadyRunner"));
  assert.ok(mixedExpandedLines.includes("  InactiveRunner"));
  assert.match(mixedExpanded, /The tool is available on the next turn\./);
  assert.match(mixedExpanded, /No AlreadyRunner operation was executed by this search\./);
  assert.deepEqual((mixedResult.details as { activated: string[] }).activated, ["AlreadyRunner"]);
  assert.deepEqual((mixedResult.details as { alreadyActive: string[] }).alreadyActive, ["InactiveRunner"]);
});

test("search_tools surfaces the retained omitted-match count without changing model output", () => {
  const fixture = fixtureWithSearch();
  const value = {
    content: [{ type: "text", text: "Matched authorized tools: A.\nActivated: A." }],
    details: { matched: ["A"], activated: ["A"], omitted: 2, outcome: "activated" },
    isError: false,
  };
  const params = { query: "A" };
  const expandedLines = render(fixture.tool, value, { expanded: true, isPartial: false }, params);
  const expanded = expandedLines.join("\n");
  assert.ok(expandedLines.includes("Omitted matches: 2"), expanded);
  assert.ok(expandedLines.includes("The tool is available on the next turn."));
  assert.ok(expandedLines.includes("No A operation was executed by this search."));
});

test("unavailable and native-partial search results keep actual text without fabricated execution", async () => {
  const unavailable = fixtureWithSearch();
  const unavailableParams = { query: "Unavailable secret-shaped query" };
  const unavailableResult = await unavailable.search("unavailable", unavailableParams);
  const unavailableCollapsed = render(unavailable.tool, unavailableResult, { expanded: false, isPartial: false }, unavailableParams).join("\n");
  const unavailableExpanded = render(unavailable.tool, unavailableResult, { expanded: true, isPartial: false }, unavailableParams).join("\n");
  assert.equal(unavailableCollapsed, 'search_tools · "Unavailable secret-shaped query" · unavailable\nTool search is unavailable until session startup completes.');
  assert.match(unavailableExpanded, /Query: Unavailable secret-shaped query/);
  assert.match(unavailableExpanded, /Outcome: unavailable/);
  assert.match(unavailableExpanded, /session startup completes/);

  const partialValue = {
    content: [{ type: "text", text: "partial discovery output with a secret-shaped value" }],
    details: {},
    isError: false,
  };
  const partialParams = { query: "partial query" };
  const partialText = render(unavailable.tool, partialValue, { expanded: true, isPartial: true }, partialParams);
  assert.match(partialText.join("\n"), /partial result/);
  assert.match(partialText.join("\n"), /partial discovery output with a secret-shaped value/);
  assert.doesNotMatch(partialText.join("\n"), /Matched authorized tools/);
});

function fixtureWithSearch() {
  const definitions: Definition[] = [
    { name: "read", description: "Read file contents." },
    { name: "InactiveRunner", description: "Run an inactive fixture operation." },
    { name: "AlreadyRunner", description: "Run an already active fixture operation." },
  ];
  let active = definitions.map(({ name }) => name);
  let tool: Definition | undefined;
  const pi = {
    registerTool(definition: Definition) {
      tool = definition;
      definitions.push(definition);
      active.push(definition.name);
    },
    getActiveTools: () => [...active],
    getAllTools: () => [...definitions],
    setActiveTools(names: string[]) {
      active = [...names];
    },
  };
  const manager = new DeferredToolManager(pi);
  manager.register();
  assert.ok(tool?.execute);
  return {
    manager,
    tool,
    search: tool.execute,
    active: () => [...active],
    sessionIdentity: {},
  } as {
    manager: DeferredToolManager;
    tool: Definition;
    search: NonNullable<Definition["execute"]>;
    active: () => string[];
    sessionIdentity: object;
  };
}