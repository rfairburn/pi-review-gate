import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DeferredToolManager } from "../src/deferred-tools";
import type { OperatingMode } from "../src/config";
import { measureToolSchemaBaseline } from "./tool-schema-baseline-helper";

interface RegisteredTool {
  name: string;
  description?: string;
  promptSnippet?: string;
  parameters?: unknown;
  execute?: (id: string, params: unknown) => Promise<Record<string, unknown>>;
}

function tool(name: string, description: string): RegisteredTool {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties: {
        request: { type: "string", description: `${name} request with representative schema text` },
      },
      required: ["request"],
      additionalProperties: false,
    },
  };
}

function hostFixture(options: { disabled?: string[]; omit?: string[] } = {}) {
  const definitions: RegisteredTool[] = [
    tool("read", "Read file contents."),
    tool("bash", "Execute a shell command."),
    tool("edit", "Make precise edits to a file."),
    tool("write", "Create or overwrite a file."),
    tool("ApplyPatch", "Apply a structured patch to one file."),
    tool("SubtasksStart", "Start bounded background implementation work."),
    tool("SubtasksAdd", "Add tasks to an existing background execution."),
    tool("SubtasksInspect", "Inspect background execution state."),
    tool("WebSearch", "Search the public web for current sources."),
    tool("disabled_private", "Search a private disabled service."),
  ].filter((definition) => !(options.omit ?? []).includes(definition.name));
  const disabled = new Set([...(options.omit ?? []), ...((options.disabled ?? ["disabled_private"]))]);
  let active = definitions.map((definition) => definition.name).filter((name) => !disabled.has(name));
  const setCalls: string[][] = [];
  const sessionIdentity = {};
  const pi = {
    registerTool(definition: RegisteredTool) {
      const existing = definitions.findIndex((candidate) => candidate.name === definition.name);
      if (existing >= 0) definitions.splice(existing, 1, definition);
      else definitions.push(definition);
      if (!active.includes(definition.name)) active.push(definition.name);
    },
    getActiveTools: () => [...active],
    getAllTools: () => [...definitions],
    setActiveTools(names: string[]) {
      active = [...names];
      setCalls.push([...names]);
    },
  };
  /** Register a tool the host lists in getAllTools but left launch-inactive. */
  const registerInactive = (definition: RegisteredTool) => {
    const existing = definitions.findIndex((candidate) => candidate.name === definition.name);
    if (existing >= 0) definitions.splice(existing, 1, definition);
    else definitions.push(definition);
  };
  return {
    pi,
    sessionIdentity,
    definitions,
    setCalls,
    registerInactive,
    active: () => [...active],
    search: () => {
      const registered = definitions.find((definition) => definition.name === "search_tools");
      assert.ok(registered?.execute);
      return registered.execute;
    },
  };
}

test("planning unloads activated write tools and hides them from discovery and inventory", async () => {
  const fixture = hostFixture();
  let mode: OperatingMode = "orchestrate";
  const manager = new DeferredToolManager(fixture.pi, () => mode);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  await fixture.search()("load-write", { query: "write" });
  assert.ok(fixture.active().includes("write"));
  const before = fixture.active();

  mode = "plan-research";
  manager.reapply();
  assert.deepEqual(fixture.active(), ["read", "search_tools"]);
  for (const name of ["write", "edit", "bash", "ApplyPatch", "SubtasksStart", "SubtasksAdd"]) {
    assert.ok(!manager.startupGuidance()?.includes(`"${name}"`));
    const result = await fixture.search()("try-removed", { query: name });
    assert.match(JSON.stringify(result), /No authorized tools matched/);
    assert.ok(!fixture.active().includes(name));
  }
  await fixture.search()("load-read-only", { query: "WebSearch" });
  assert.deepEqual(fixture.active(), ["read", "search_tools", "WebSearch"]);
  mode = "execute";
  manager.reapply();
  assert.deepEqual(fixture.active(), [...before, "WebSearch"]);
  assert.ok(!fixture.active().includes("disabled_private"));
});

test("planning filters full-active settings and repeated host reapplication", () => {
  const fixture = hostFixture();
  let mode: OperatingMode = "plan-research";
  const manager = new DeferredToolManager(fixture.pi, () => mode);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  assert.deepEqual(fixture.active(), ["read", "search_tools"]);
  manager.setDeferredEnabled(false);
  assert.deepEqual(fixture.active(), ["read", "SubtasksInspect", "WebSearch", "search_tools"]);
  fixture.pi.setActiveTools(["write"]);
  manager.reapply();
  assert.ok(!fixture.active().includes("write"));
  mode = "orchestrate";
  manager.reapply();
  assert.ok(fixture.active().includes("write"));
  assert.ok(!fixture.active().includes("disabled_private"));
});

test("first session request is shrunk to the authorized conservative set and loader", () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);

  assert.equal(manager.register(), true);
  const searchDefinition = fixture.definitions.find((definition) => definition.name === "search_tools")!;
  assert.match(searchDefinition.description ?? "", /query only exact tool names/);
  assert.match(searchDefinition.promptSnippet ?? "", /only exact tool names when known, without descriptive words/);
  assert.match(
    String((searchDefinition.parameters as { properties?: { query?: { description?: string } } }).properties?.query?.description),
    /Never mix known names with descriptive words/,
  );
  assert.ok(fixture.active().includes("WebSearch"), "registration alone does not shrink before session_start");
  assert.equal(manager.sessionStart(fixture.sessionIdentity), true);

  assert.deepEqual(fixture.active(), ["read", "bash", "edit", "ApplyPatch", "SubtasksStart", "search_tools"]);
  assert.deepEqual(manager.authorizedToolNames(), [
    "read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "WebSearch",
  ], "worker authorization remains the complete pre-shrink catalog");

  fixture.pi.registerTool(tool("post_capture", "Registered after the original authorization boundary."));
  const recreatedPi = {
    registerTool: fixture.pi.registerTool,
    getActiveTools: fixture.pi.getActiveTools,
    getAllTools: fixture.pi.getAllTools,
    setActiveTools: fixture.pi.setActiveTools,
  };
  const reloaded = new DeferredToolManager(recreatedPi);
  reloaded.register();
  reloaded.sessionStart(fixture.sessionIdentity);
  assert.deepEqual(fixture.active(), ["read", "bash", "edit", "ApplyPatch", "SubtasksStart", "search_tools"]);
  assert.equal(reloaded.authorizedToolNames()?.includes("post_capture"), false);
});

test("configured worker catalogs use the durable initial subset without narrowing authorization", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();

  assert.equal(manager.sessionStart(fixture.sessionIdentity, {
    allowedToolCatalog: ["read", "write", "WebSearch"],
    initialActiveTools: ["read"],
  }), true);
  assert.deepEqual(fixture.active(), ["read", "search_tools"]);
  assert.deepEqual(manager.authorizedToolNames(), ["read", "write", "WebSearch"]);
  const inventory = manager.startupGuidance() ?? "";
  for (const name of ["read", "write", "WebSearch", "search_tools"]) {
    assert.match(inventory, new RegExp(`"${name}"`));
  }
  assert.match(inventory, /exact name/);
  assert.match(inventory, /next turn/);
  assert.doesNotMatch(inventory, /Read file contents|Create or overwrite|Search the public web|parameters|properties/);

  const reloaded = new DeferredToolManager(fixture.pi);
  reloaded.register();
  assert.equal(
    reloaded.sessionStart(fixture.sessionIdentity, undefined, true),
    true,
    "same-session extension reload reuses the captured one-shot bootstrap",
  );
  assert.deepEqual(fixture.active(), ["read", "search_tools"]);

  const result = await fixture.search()("search", { query: "public web" });
  assert.deepEqual((result.details as { activated: string[] }).activated, ["WebSearch"]);
  assert.deepEqual(fixture.active(), ["read", "search_tools", "WebSearch"]);
});

test("role-filtered research inventory names every authorized tool without mutation tools or schemas", () => {
  const fixture = hostFixture();
  const browserNames = [
    "BrowserOpen", "BrowserNavigate", "BrowserSnapshot", "BrowserConsole", "BrowserNetwork", "BrowserInspect", "BrowserScreenshot",
    "BrowserScroll", "BrowserHover", "BrowserWait", "BrowserHistory", "BrowserTabs", "BrowserClose",
  ];
  for (const name of browserNames) fixture.pi.registerTool(tool(name, `Private schema description for ${name}.`));
  fixture.pi.registerTool(tool("BrowserClick", "Excluded interaction tool."));
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity, {
    allowedToolCatalog: ["read", "WebSearch", ...browserNames],
    initialActiveTools: ["read"],
  });

  const inventory = manager.startupGuidance() ?? "";
  for (const name of ["read", "WebSearch", ...browserNames, "search_tools"]) {
    assert.match(inventory, new RegExp(`"${name}"`));
  }
  assert.doesNotMatch(inventory, /"(?:bash|edit|write|ApplyPatch|BrowserClick)"/);
  assert.doesNotMatch(inventory, /Read file contents|Search the public web|Private schema description|Excluded interaction|parameters|properties/);
});

test("configured worker boundaries reject unavailable and unauthorized tools", async () => {
  const fixture = hostFixture({ disabled: ["WebSearch", "disabled_private"] });
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();

  assert.equal(manager.sessionStart(fixture.sessionIdentity, {
    allowedToolCatalog: ["read", "WebSearch"],
    initialActiveTools: ["read"],
  }), false, "a durable name absent from the native launch allowlist fails closed");
  assert.equal(manager.authorizedToolNames(), undefined);
  assert.equal(fixture.active().includes("search_tools"), false);

  const result = await fixture.search()("unauthorized", { query: "private disabled" });
  assert.equal(result.isError, true);
  assert.deepEqual(fixture.active(), ["read", "bash", "edit", "ApplyPatch", "SubtasksStart"]);
});

test("disabled deferred mode starts full-active and local toggles apply immediately", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity, undefined, false, false);

  const authorized = manager.authorizedToolNames()!;
  assert.deepEqual(fixture.active(), [...authorized, "search_tools"]);
  assert.doesNotMatch(manager.startupGuidance() ?? "", /inactive|next turn/);

  assert.equal(manager.setDeferredEnabled(true), true);
  assert.deepEqual(fixture.active(), ["read", "bash", "edit", "ApplyPatch", "SubtasksStart", "search_tools"]);
  assert.match(manager.startupGuidance() ?? "", /inactive.*exact name.*next turn/);

  await fixture.search()("load-web", { query: "WebSearch" });
  assert.ok(fixture.active().includes("WebSearch"));
  assert.equal(manager.setDeferredEnabled(true), true, "saving the unchanged setting succeeds");
  assert.ok(fixture.active().includes("WebSearch"), "saving unrelated settings does not unload activated tools");

  assert.equal(manager.setDeferredEnabled(false), true);
  assert.deepEqual(fixture.active(), [...authorized, "search_tools"]);
});

test("configured worker with deferred mode disabled starts every durable authorized tool", () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity, {
    allowedToolCatalog: ["read", "write", "WebSearch"],
    initialActiveTools: ["read", "write", "WebSearch"],
  }, true);

  assert.deepEqual(fixture.active(), ["read", "write", "WebSearch", "search_tools"]);
  assert.doesNotMatch(manager.startupGuidance() ?? "", /inactive|next turn/);
});

test("search deterministically and additively activates authorized matches only", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  const result = await fixture.search()("search", { query: "background" });

  assert.equal(result.isError, false);
  assert.deepEqual((result.details as { matched: string[] }).matched, [
    "SubtasksAdd", "SubtasksInspect", "SubtasksStart",
  ]);
  assert.deepEqual((result.details as { activated: string[] }).activated, ["SubtasksAdd", "SubtasksInspect"]);
  assert.deepEqual(fixture.active(), [
    "read", "bash", "edit", "ApplyPatch", "SubtasksStart", "search_tools", "SubtasksAdd", "SubtasksInspect",
  ]);
  assert.match(String((result.content as Array<{ text: string }>)[0]?.text), /did not perform the operation/);
});

test("search matches any query term so multiple exact or descriptive tool names activate together", async () => {
  for (const query of ["WebSearch WebFetch", "web search fetch browser weather"]) {
    const fixture = hostFixture();
    fixture.pi.registerTool(tool("WebFetch", "Fetch and extract a public web page."));
    const manager = new DeferredToolManager(fixture.pi);
    manager.register();
    manager.sessionStart(fixture.sessionIdentity);

    const result = await fixture.search()("multi-web", { query });
    const details = result.details as { matched: string[]; activated: string[] };
    assert.deepEqual(details.matched, ["WebFetch", "WebSearch"]);
    assert.deepEqual(details.activated, ["WebFetch", "WebSearch"]);
    assert.ok(fixture.active().includes("WebFetch"));
    assert.ok(fixture.active().includes("WebSearch"));
  }
});

test("queries with more than twelve unique terms remain valid and use every term", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  const noise = Array.from({ length: 13 }, (_unused, index) => `noise${index + 1}`);
  const result = await fixture.search()("many-terms", { query: [...noise, "overwrite"].join(" ") });

  assert.equal(result.isError, false);
  assert.deepEqual((result.details as { matched: string[] }).matched, ["write"]);
  assert.deepEqual((result.details as { activated: string[] }).activated, ["write"]);
  assert.ok(fixture.active().includes("write"));
});

test("large Unicode term sets cannot cross exact, split-name, and description tiers", async () => {
  const fixture = hostFixture();
  const unicodeTerms = Array.from({ length: 105 }, (_unused, index) => String.fromCodePoint(0x4e00 + index));
  fixture.pi.registerTool(tool("NeedleRunner", "Run the focused operation."));
  fixture.pi.registerTool(tool("DescriptionHeavy", unicodeTerms.join(" ")));
  fixture.pi.registerTool(tool("ExactFocus", "Load the exact candidate."));
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  const nameQuery = [...unicodeTerms, "needle"].join(" ");
  assert.ok(nameQuery.length <= 256);
  const nameResult = await fixture.search()("large-name-tier", { query: nameQuery });
  assert.deepEqual((nameResult.details as { matched: string[] }).matched, ["NeedleRunner"]);
  assert.deepEqual((nameResult.details as { activated: string[] }).activated, ["NeedleRunner"]);
  assert.equal(fixture.active().includes("DescriptionHeavy"), false);

  const exactQuery = [...unicodeTerms, "needle", "ExactFocus"].join(" ");
  assert.ok(exactQuery.length <= 256);
  const exactResult = await fixture.search()("large-exact-tier", { query: exactQuery });
  assert.deepEqual((exactResult.details as { matched: string[] }).matched, ["ExactFocus"]);
  assert.deepEqual((exactResult.details as { activated: string[] }).activated, ["ExactFocus"]);
  assert.equal(fixture.active().includes("DescriptionHeavy"), false);
});

test("every authorized tool in a strongest tier is activated and reported alphabetically", async () => {
  const fixture = hostFixture();
  const strongest = Array.from({ length: 10 }, (_unused, index) => `BatchTool${String(index).padStart(2, "0")}`);
  for (const name of [...strongest].reverse()) fixture.pi.registerTool(tool(name, "Run one grouped operation."));
  fixture.pi.registerTool(tool("DescriptionOnly", "Process a batch through a weaker description match."));
  fixture.pi.registerTool(tool("BatchPrivate", "Unauthorized matching tool."));

  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity, {
    allowedToolCatalog: ["read", ...[...strongest].reverse(), "DescriptionOnly"],
    initialActiveTools: ["read"],
  });

  const result = await fixture.search()("wide-tier", { query: "batch" });
  const details = result.details as { matched: string[]; activated: string[]; omitted: number };
  assert.equal(result.isError, false);
  assert.deepEqual(details.matched, strongest);
  assert.deepEqual(details.activated, strongest);
  assert.equal(details.omitted, 0);
  assert.deepEqual(fixture.active(), ["read", "search_tools", ...strongest]);
  const text = String((result.content as Array<{ text: string }>)[0]?.text);
  assert.equal(text.includes("BatchPrivate"), false, "unauthorized names are not disclosed");
  assert.equal(text.includes("DescriptionOnly"), false, "weaker matches are not reported or activated");
  assert.match(text, new RegExp(`Matched authorized tools: ${strongest.join(", ")}\\.`));
  assert.match(text, /next turn/);
});

test("exact tool names suppress weaker generic-word matches", async () => {
  for (const [query, expected] of [
    ["WebSearch web search tool", "WebSearch"],
    ["WebFetch fetch webpage content", "WebFetch"],
  ] as const) {
    const fixture = hostFixture();
    fixture.pi.registerTool(tool("WebFetch", "Fetch and extract public webpage content."));
    fixture.pi.registerTool(tool("BrowserExtract", "Use a browser to extract web content."));
    const manager = new DeferredToolManager(fixture.pi);
    manager.register();
    manager.sessionStart(fixture.sessionIdentity);

    const result = await fixture.search()("exact-web", { query });
    const details = result.details as { matched: string[]; activated: string[] };
    assert.deepEqual(details.matched, [expected]);
    assert.deepEqual(details.activated, [expected]);
  }
});

test("browser interaction tools are role-authorized, deferred, and discoverable by exact name", async () => {
  const fixture = hostFixture();
  for (const definition of [
    tool("BrowserOpen", "Open an isolated observational browser session."),
    tool("BrowserNavigate", "Navigate an isolated browser tab."),
    tool("BrowserSnapshot", "Read a bounded semantic browser snapshot."),
    tool("BrowserConsole", "Read bounded console diagnostics."),
    tool("BrowserNetwork", "Read bounded network diagnostics."),
    tool("BrowserInspect", "Inspect one fresh semantic ref."),
    tool("BrowserScreenshot", "Capture bounded visual browser evidence."),
    tool("BrowserScroll", "Perform bounded semantic scrolling."),
    tool("BrowserHover", "Hover a current semantic ref."),
    tool("BrowserClick", "Click a current semantic ref under policy."),
    tool("BrowserFill", "Replace a bounded editable value under policy."),
    tool("BrowserType", "Append bounded text under policy."),
    tool("BrowserSelect", "Select exact options under policy."),
    tool("BrowserPress", "Press one bounded key under policy."),
    tool("BrowserWait", "Wait for bounded observational conditions."),
    tool("BrowserHistory", "Inspect bounded session history."),
    tool("BrowserTabs", "Manage bounded owned browser tabs."),
    tool("BrowserClose", "Close a browser session deterministically."),
  ]) {
    fixture.pi.registerTool(definition);
  }
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  const browserNames = [
    "BrowserOpen", "BrowserNavigate", "BrowserSnapshot", "BrowserConsole", "BrowserNetwork", "BrowserInspect", "BrowserScreenshot",
    "BrowserScroll", "BrowserHover", "BrowserClick", "BrowserFill", "BrowserType", "BrowserSelect", "BrowserPress",
    "BrowserWait", "BrowserHistory", "BrowserTabs", "BrowserClose",
  ];
  for (const name of browserNames) {
    assert.ok(manager.authorizedToolNames()?.includes(name));
    assert.equal(fixture.active().includes(name), false, `${name} must not be initially active`);
    assert.match(manager.startupGuidance() ?? "", new RegExp(`"${name}"`));
  }
  assert.doesNotMatch(manager.startupGuidance() ?? "", /isolated observational|bounded semantic|visual browser evidence|parameters|properties/);
  const result = await fixture.search()("browser", { query: "BrowserSnapshot" });
  assert.deepEqual((result.details as { matched: string[] }).matched, ["BrowserSnapshot"]);
  assert.deepEqual((result.details as { activated: string[] }).activated, ["BrowserSnapshot"]);
  assert.ok(fixture.active().includes("BrowserSnapshot"));
  assert.equal(fixture.active().includes("BrowserOpen"), false);

  const screenshot = await fixture.search()("screenshot", { query: "BrowserScreenshot" });
  assert.deepEqual((screenshot.details as { matched: string[] }).matched, ["BrowserScreenshot"]);
  assert.deepEqual((screenshot.details as { activated: string[] }).activated, ["BrowserScreenshot"]);
  assert.ok(fixture.active().includes("BrowserScreenshot"));

  for (const name of ["BrowserConsole", "BrowserNetwork", "BrowserInspect", "BrowserScroll", "BrowserHover", "BrowserClick", "BrowserFill", "BrowserType", "BrowserSelect", "BrowserPress", "BrowserWait", "BrowserHistory", "BrowserTabs"]) {
    const loaded = await fixture.search()(`load-${name}`, { query: name });
    assert.deepEqual((loaded.details as { matched: string[] }).matched, [name]);
    assert.deepEqual((loaded.details as { activated: string[] }).activated, [name]);
    assert.ok(fixture.active().includes(name));
  }
});

test("invalid and unmatched searches do not change the active set", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  const before = fixture.active();

  const invalid = await fixture.search()("invalid", { query: "   " });
  assert.equal(invalid.isError, true);
  assert.deepEqual(fixture.active(), before);

  const unmatched = await fixture.search()("unmatched", { query: "nonexistent-capability-token" });
  assert.equal(unmatched.isError, false);
  assert.deepEqual((unmatched.details as { activated: string[] }).activated, []);
  assert.deepEqual(fixture.active(), before);
});

test("disabled and newly registered tools cannot widen the captured authorization boundary", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  fixture.pi.registerTool(tool("new_private", "Search newly registered private records."));
  assert.ok(fixture.active().includes("new_private"), "fixture models Pi activating a newly registered tool");

  const disabled = await fixture.search()("disabled", { query: "disabled private" });
  assert.deepEqual((disabled.details as { activated: string[] }).activated, []);
  assert.equal(fixture.active().includes("disabled_private"), false);
  assert.equal(fixture.active().includes("new_private"), false, "the next managed active-set write removes unauthorized widening");

  const newlyRegistered = await fixture.search()("new", { query: "newly registered private" });
  assert.deepEqual((newlyRegistered.details as { activated: string[] }).activated, []);
  assert.equal(fixture.active().includes("new_private"), false);
  assert.equal(manager.authorizedToolNames()?.includes("new_private"), false);
});

test("session restart and a recreated ExtensionAPI wrapper reuse the session authorization boundary", async () => {
  const fixture = hostFixture();
  const first = new DeferredToolManager(fixture.pi);
  first.register();
  first.sessionStart(fixture.sessionIdentity);
  await fixture.search()("load", { query: "public web" });
  assert.ok(fixture.active().includes("WebSearch"));

  first.sessionStart(fixture.sessionIdentity);
  const initial = ["read", "bash", "edit", "ApplyPatch", "SubtasksStart", "search_tools"];
  assert.deepEqual(fixture.active(), initial, "another session_start resets to the same initial set");

  fixture.pi.registerTool(tool("reload_private", "A tool registered only after the original authorization capture."));
  assert.ok(fixture.active().includes("reload_private"));
  const recreatedPi = {
    registerTool: fixture.pi.registerTool,
    getActiveTools: fixture.pi.getActiveTools,
    getAllTools: fixture.pi.getAllTools,
    setActiveTools: fixture.pi.setActiveTools,
  };
  assert.notEqual(recreatedPi, fixture.pi, "reload uses a distinct ExtensionAPI wrapper");
  const reloaded = new DeferredToolManager(recreatedPi);
  reloaded.register();
  reloaded.sessionStart(fixture.sessionIdentity);
  assert.deepEqual(fixture.active(), initial);
  const result = await fixture.search()("reload-load", { query: "public web" });
  assert.deepEqual((result.details as { activated: string[] }).activated, ["WebSearch"]);
  const unauthorized = await fixture.search()("reload-private", { query: "original authorization capture" });
  assert.deepEqual((unauthorized.details as { activated: string[] }).activated, []);
});

test("distinct session identities capture isolated authorization catalogs", async () => {
  const firstFixture = hostFixture();
  const secondFixture = hostFixture({ disabled: ["WebSearch"] });
  const first = new DeferredToolManager(firstFixture.pi);
  const second = new DeferredToolManager(secondFixture.pi);
  first.register();
  second.register();

  assert.equal(first.sessionStart(firstFixture.sessionIdentity), true);
  assert.equal(second.sessionStart(secondFixture.sessionIdentity), true);
  assert.equal(first.authorizedToolNames()?.includes("WebSearch"), true);
  assert.equal(first.authorizedToolNames()?.includes("disabled_private"), false);
  assert.equal(second.authorizedToolNames()?.includes("WebSearch"), false);
  assert.equal(second.authorizedToolNames()?.includes("disabled_private"), true);

  const secondPrivate = await secondFixture.search()("second-private", { query: "private disabled service" });
  assert.deepEqual((secondPrivate.details as { activated: string[] }).activated, ["disabled_private"]);
  const secondWeb = await secondFixture.search()("second-web", { query: "public web" });
  assert.deepEqual((secondWeb.details as { activated: string[] }).activated, []);

  const firstWeb = await firstFixture.search()("first-web", { query: "public web" });
  assert.deepEqual((firstWeb.details as { activated: string[] }).activated, ["WebSearch"]);
  const firstPrivate = await firstFixture.search()("first-private", { query: "private disabled service" });
  assert.deepEqual((firstPrivate.details as { activated: string[] }).activated, []);
});

test("configured worker activation is isolated between task sessions", async () => {
  const firstFixture = hostFixture();
  const secondFixture = hostFixture();
  const first = new DeferredToolManager(firstFixture.pi);
  const second = new DeferredToolManager(secondFixture.pi);
  first.register();
  second.register();
  first.sessionStart(firstFixture.sessionIdentity, {
    allowedToolCatalog: ["read", "write"],
    initialActiveTools: ["read"],
  });
  second.sessionStart(secondFixture.sessionIdentity, {
    allowedToolCatalog: ["read", "WebSearch"],
    initialActiveTools: ["read"],
  });

  const firstLoad = await firstFixture.search()("first", { query: "overwrite file" });
  assert.deepEqual((firstLoad.details as { activated: string[] }).activated, ["write"]);
  const secondCannotLoadFirst = await secondFixture.search()("second-write", { query: "overwrite file" });
  assert.deepEqual((secondCannotLoadFirst.details as { activated: string[] }).activated, []);
  const secondLoad = await secondFixture.search()("second-web", { query: "public web" });
  assert.deepEqual((secondLoad.details as { activated: string[] }).activated, ["WebSearch"]);
  assert.equal(firstFixture.active().includes("WebSearch"), false);
});

test("session startup fails closed without a stable identity", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();

  assert.equal(manager.sessionStart(undefined), false);
  assert.equal(manager.authorizedToolNames(), undefined);
  const restrictive = ["read", "bash", "edit", "ApplyPatch", "SubtasksStart"];
  assert.deepEqual(fixture.active(), restrictive);
  assert.deepEqual(fixture.setCalls, [restrictive]);

  fixture.pi.registerTool(tool("late_without_identity", "Registered after fail-closed startup."));
  assert.ok(fixture.active().includes("late_without_identity"));
  manager.reapply();
  assert.deepEqual(fixture.active(), restrictive, "request boundaries retain the fail-closed active set");

  const unavailable = await fixture.search()("unavailable", { query: "public web" });
  assert.equal(unavailable.isError, true);
  assert.match(String((unavailable.content as Array<{ text: string }>)[0]?.text), /unavailable until session startup completes/);
});

test("the first-request deferred schema is materially smaller than the authorized catalog", () => {
  const fixture = hostFixture();
  const before = measureToolSchemaBaseline(fixture.active(), fixture.definitions);
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  const after = measureToolSchemaBaseline(fixture.active(), fixture.definitions);

  assert.ok(after.activeToolCount < before.activeToolCount);
  assert.ok(
    after.serializedSchemaBytes < before.serializedSchemaBytes * 0.8,
    `expected material schema reduction (${before.serializedSchemaBytes} -> ${after.serializedSchemaBytes})`,
  );
});

test("launch-authorized native discovery is active from the first request in every operating mode (#71)", () => {
  // Discovery that is already active stays active too.
  const fixture = hostFixture();
  for (const name of ["grep", "find", "ls"]) {
    fixture.pi.registerTool(tool(name, `Native read-only discovery via ${name}.`));
  }
  let mode: OperatingMode = "execute";
  const manager = new DeferredToolManager(fixture.pi, () => mode);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  // Active from the first request, with no search_tools activation step.
  assert.ok(fixture.active().includes("grep"));
  assert.ok(fixture.active().includes("find"));
  assert.ok(fixture.active().includes("ls"));
  // The durable parent authorization keeps them for research inheritance.
  const authorized = manager.authorizedToolNames()!;
  for (const name of ["grep", "find", "ls"]) {
    assert.ok(authorized.includes(name), `${name} stays authorized for delegated research`);
  }
  assert.match(manager.startupGuidance() ?? "", /"grep"/);

  // Plan/research keeps read-only discovery while unloading write-capable tools.
  mode = "plan-research";
  manager.reapply();
  for (const name of ["grep", "find", "ls"]) assert.ok(fixture.active().includes(name));
  for (const name of ["bash", "edit", "write", "ApplyPatch", "SubtasksStart"]) {
    assert.ok(!fixture.active().includes(name), `${name} stays unloaded in plan-research`);
  }

  // Mode cycling never deactivates otherwise-authorized discovery.
  mode = "orchestrate";
  manager.reapply();
  for (const name of ["grep", "find", "ls"]) assert.ok(fixture.active().includes(name));
  mode = "execute";
  manager.reapply();
  for (const name of ["grep", "find", "ls"]) assert.ok(fixture.active().includes(name));
});

test("registered-but-inactive native discovery becomes active by default in every mode (#71)", async () => {
  // Pi's default startup and --no-builtin-tools both leave discovery registered
  // but inactive. Registry-authorized discovery is always on in this extension.
  const fixture = hostFixture({ disabled: ["grep", "find", "ls"] });
  for (const name of ["grep", "find", "ls"]) {
    fixture.registerInactive(tool(name, `Native read-only discovery via ${name}.`));
  }
  let mode: OperatingMode = "execute";
  const manager = new DeferredToolManager(fixture.pi, () => mode);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  for (const name of ["grep", "find", "ls"]) {
    assert.ok(fixture.active().includes(name), `${name} is active without discovery`);
    assert.equal(manager.authorizedToolNames()?.includes(name), true);
    assert.match(manager.startupGuidance() ?? "", new RegExp(`"${name}"`));
  }
  for (const next of ["orchestrate", "plan-research", "execute"] as const) {
    mode = next;
    manager.reapply();
    for (const name of ["grep", "find", "ls"]) assert.ok(fixture.active().includes(name));
  }
  assert.ok(!fixture.active().includes("disabled_private"), "other inactive tools are not promoted");
});

test("explicit registry removal keeps discovery tools inactive, unauthorized, and undiscoverable (#71)", async () => {
  // --tools/--exclude-tools/--no-tools remove names from the host registry;
  // the extension never re-authorizes an absent name.
  const fixture = hostFixture({ omit: ["grep", "find", "ls"] });
  let mode: OperatingMode = "plan-research";
  const manager = new DeferredToolManager(fixture.pi, () => mode);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  for (const name of ["grep", "find", "ls"]) {
    assert.ok(!fixture.active().includes(name), `${name} stays excluded`);
    assert.equal(manager.authorizedToolNames()?.includes(name), false);
    assert.doesNotMatch(manager.startupGuidance() ?? "", new RegExp(`"${name}"`));
  }
  const result = await fixture.search()( "excluded", { query: "grep" });
  assert.match(JSON.stringify(result), /No authorized tools matched/);

  // Mode cycling does not widen an explicit exclusion either.
  mode = "orchestrate";
  manager.reapply();
  for (const name of ["grep", "find", "ls"]) assert.ok(!fixture.active().includes(name));
});

test("configured worker catalogs activate authorized discovery from the first request (#71)", async () => {
  const fixture = hostFixture();
  for (const name of ["grep", "find", "ls"]) {
    fixture.pi.registerTool(tool(name, `Native read-only discovery via ${name}.`));
  }
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  assert.equal(manager.sessionStart(fixture.sessionIdentity, {
    allowedToolCatalog: ["read", "grep", "find", "ls", "WebSearch"],
    initialActiveTools: ["read", "grep", "find", "ls"],
  }, true), true);

  // The durable initial subset is active at startup; no search_tools call is
  // needed before the first discovery call.
  assert.deepEqual(fixture.active(), ["read", "grep", "find", "ls", "search_tools"]);
  assert.deepEqual(manager.authorizedToolNames(), ["read", "grep", "find", "ls", "WebSearch"]);
});

test("synthetic nested repository: discovery tools are active and callable without guessed paths (#71/#72)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-review-discovery-"));
  try {
    await mkdir(join(root, "stack", "modules", "vpc"), { recursive: true });
    await writeFile(join(root, "stack", "main.tf"), "module \"vpc\" {\n  source = \"./modules/vpc\"\n}\n");
    await writeFile(join(root, "stack", "modules", "vpc", "main.tf"), "resource \"aws_vpc\" \"main\" {\n  cidr_block = \"10.0.0.0/16\"\n}\n");
    await writeFile(join(root, "stack", "variables.tf"), "variable \"cidr\" {\n  default = \"10.0.0.0/16\"\n}\n");

    const fixture = hostFixture();
    // Synthetic stand-ins for Pi's native read/grep/find: production code
    // reuses the host's real implementations; the fixture proves the policy
    // leaves the native tools callable rather than merely prompt-listed.
    const walk = async (dir: string): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) files.push(...await walk(full));
        else files.push(full);
      }
      return files;
    };
    fixture.pi.registerTool({
      name: "read",
      description: "Read a file's contents.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      execute: async (_id: string, rawParams: unknown) => {
        const params = rawParams as { path: string };
        return {
          content: [{ type: "text", text: await readFile(params.path, "utf8") }],
          details: {},
        };
      },
    });
    fixture.pi.registerTool({
      name: "find",
      description: "Find files matching a pattern under a path.",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"], additionalProperties: false },
      execute: async () => ({
        content: [{ type: "text", text: (await walk(root)).filter((path) => path.endsWith(".tf")).sort().join("\n") }],
        details: {},
      }),
    });
    fixture.pi.registerTool({
      name: "grep",
      description: "Search file contents for a pattern.",
      parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"], additionalProperties: false },
      execute: async (_id: string, rawParams: unknown) => {
        const params = rawParams as { pattern: string };
        const matches: string[] = [];
        for (const path of (await walk(root)).filter((path) => path.endsWith(".tf")).sort()) {
          if ((await readFile(path, "utf8")).includes(params.pattern)) matches.push(path);
        }
        return { content: [{ type: "text", text: matches.join("\n") }], details: {} };
      },
    });

    const manager = new DeferredToolManager(fixture.pi);
    manager.register();
    manager.sessionStart(fixture.sessionIdentity);
    for (const name of ["read", "grep", "find"]) {
      assert.ok(fixture.active().includes(name), `${name} is callable from the first request`);
    }

    const byName = new Map(fixture.definitions.map((definition) => [definition.name, definition]));
    const found = await byName.get("find")!.execute!("find-1", { pattern: "**/*.tf" });
    assert.deepEqual(
      String((found.content as Array<{ text: string }>)[0].text).split("\n").sort(),
      [
        join(root, "stack", "main.tf"),
        join(root, "stack", "modules", "vpc", "main.tf"),
        join(root, "stack", "variables.tf"),
      ].sort(),
    );
    const grepped = await byName.get("grep")!.execute!("grep-1", { pattern: "aws_vpc" });
    const grepText = String((grepped.content as Array<{ text: string }>)[0].text);
    assert.ok(grepText.includes(join(root, "stack", "modules", "vpc", "main.tf")));
    const body = await byName.get("read")!.execute!("read-1", { path: join(root, "stack", "modules", "vpc", "main.tf") });
    assert.match(String((body.content as Array<{ text: string }>)[0].text), /resource "aws_vpc" "main"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
