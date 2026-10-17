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

test("registered tool_search card matches the canonical activated shape end to end", async () => {
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
  assert.equal(collapsedLines[0], 'tool_search · "InactiveRunner" · activated InactiveRunner');
  assert.doesNotMatch(collapsed, /ctrl\+o/);

  // Canonical expanded card: query, matched, newly activated, omitted count,
  // next-turn availability and the no-operation boundary, in order.
  assert.equal(expandedLines[0], "tool_search");
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
  assert.deepEqual(fixture.active(), ["read", "tool_search", "InactiveRunner"]);
});

test("tool_search expansion distinguishes already-active, no-match and mixed activation truthfully", async () => {
  const already = fixtureWithSearch();
  already.manager.sessionStart(already.sessionIdentity, undefined, false, false);
  const alreadyParams = { query: "AlreadyRunner" };
  const alreadyResult = await already.search("already", alreadyParams);
  const alreadyCollapsed = render(already.tool, alreadyResult, { expanded: false, isPartial: false }, alreadyParams).join("\n");
  const alreadyExpandedLines = render(already.tool, alreadyResult, { expanded: true, isPartial: false }, alreadyParams);
  const alreadyExpanded = alreadyExpandedLines.join("\n");
  assert.equal(alreadyCollapsed, 'tool_search · "AlreadyRunner" · already active AlreadyRunner');
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
  assert.equal(missingCollapsed, 'tool_search · "does-not-exist" · no matches');
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
  assert.equal(mixedCollapsedLines[0], 'tool_search · "runner" · activated AlreadyRunner');
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

test("tool_search surfaces the retained omitted-match count without changing model output", () => {
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
  assert.equal(unavailableCollapsed, 'tool_search · "Unavailable secret-shaped query" · unavailable\nTool search is unavailable until session startup completes.');
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

function fixtureWithSearch(options: { denied?: (name: string) => boolean } = {}) {
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
  const manager = new DeferredToolManager(pi, undefined, undefined, undefined, options.denied ?? (() => false));
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
test("#434 a role-denied exact-name search renders as denied by settings, never as a bare no-match", async () => {
  const fixture = fixtureWithSearch({ denied: (name) => name === "InactiveRunner" });
  fixture.manager.sessionStart(fixture.sessionIdentity);
  const params = { query: "InactiveRunner" };
  const result = await fixture.search("denied", params);
  assert.equal(result.isError, true);
  assert.deepEqual((result.details as { denied: string[] }).denied, ["InactiveRunner"]);
  assert.deepEqual((result.details as { outcome: string }).outcome, "denied");
  assert.deepEqual(fixture.active(), ["read", "tool_search"], "a denied search activates nothing");

  const collapsed = render(fixture.tool, result, { expanded: false, isPartial: false }, params).join("\n");
  assert.equal(collapsed.split("\n")[0], 'tool_search · "InactiveRunner" · denied by settings');
  assert.match(collapsed, /Denied for the primary agent by review-gate settings/);
  const expanded = render(fixture.tool, result, { expanded: true, isPartial: false }, params).join("\n");
  assert.match(expanded, /Outcome: denied by settings/);
  assert.match(expanded, /Denied for the primary agent by review-gate settings/);
  assert.doesNotMatch(expanded, /no authorized tools matched/i);
});

test("#421 a host-declined match renders as not activated, never as activated or already active", () => {
  const fixture = fixtureWithSearch();
  const params = { query: "mcp__docs__direct" };
  const refusedOnly = {
    content: [{ type: "text", text: "Matched authorized tools: mcp__docs__direct.\nNot activated: mcp__docs__direct." }],
    details: { matched: ["mcp__docs__direct"], activated: [], alreadyActive: [], refused: ["mcp__docs__direct"], omitted: 0, outcome: "refused" },
    isError: true,
  };
  const collapsed = render(fixture.tool, refusedOnly, { expanded: false, isPartial: false }, params).join("\n");
  assert.match(collapsed, /refused/);
  assert.doesNotMatch(collapsed, /already active|activated mcp__docs__direct/);

  // A refusal beside a usable result: the declined name is listed on its own.
  const mixed = {
    content: [{ type: "text", text: "Matched authorized tools: WebSearch, mcp__docs__direct." }],
    details: { matched: ["WebSearch", "mcp__docs__direct"], activated: ["WebSearch"], alreadyActive: [], refused: ["mcp__docs__direct"], omitted: 0, outcome: "activated" },
    isError: false,
  };
  const mixedCollapsed = render(fixture.tool, mixed, { expanded: false, isPartial: false }, params);
  assert.equal(mixedCollapsed[0], 'tool_search · "mcp__docs__direct" · activated WebSearch');
  assert.ok(mixedCollapsed.includes("Not activated by Pi (1): mcp__docs__direct."), mixedCollapsed.join("\n"));
  const mixedExpanded = render(fixture.tool, mixed, { expanded: true, isPartial: false }, params);
  const declinedAt = mixedExpanded.indexOf("Not activated (declined by Pi's tool policy):");
  assert.ok(declinedAt >= 0 && mixedExpanded[declinedAt + 1] === "  mcp__docs__direct", mixedExpanded.join("\n"));
  assert.ok(!mixedExpanded.includes("Already active:"), "the declined name is never relabeled already active");
  assert.ok(mixedExpanded.includes("The declined tool is unavailable in this session."));

  // Details with a refused list but no alreadyActive array (legacy fallback)
  // still never relabel the declined match as already active.
  const legacy = {
    content: [{ type: "text", text: "Matched authorized tools: mcp__docs__direct." }],
    details: { matched: ["mcp__docs__direct"], activated: [], refused: ["mcp__docs__direct"], outcome: "refused" },
    isError: false,
  };
  const legacyCollapsed = render(fixture.tool, legacy, { expanded: false, isPartial: false }, params).join("\n");
  assert.match(legacyCollapsed, /not activated mcp__docs__direct/);
  assert.doesNotMatch(legacyCollapsed, /already active/);
});
