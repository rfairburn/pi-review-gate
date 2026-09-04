import assert from "node:assert/strict";
import test from "node:test";
import { DeferredToolManager } from "../src/deferred-tools";
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

function hostFixture(options: { disabled?: string[] } = {}) {
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
  ];
  const disabled = new Set(options.disabled ?? ["disabled_private"]);
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
  return {
    pi,
    sessionIdentity,
    definitions,
    setCalls,
    active: () => [...active],
    search: () => {
      const registered = definitions.find((definition) => definition.name === "search_tools");
      assert.ok(registered?.execute);
      return registered.execute;
    },
  };
}

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
    "BrowserOpen", "BrowserNavigate", "BrowserSnapshot", "BrowserScreenshot",
    "BrowserScroll", "BrowserWait", "BrowserHistory", "BrowserTabs", "BrowserClose",
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

test("observational browser tools are authorized, deferred, and discoverable by exact name", async () => {
  const fixture = hostFixture();
  for (const definition of [
    tool("BrowserOpen", "Open an isolated observational browser session."),
    tool("BrowserNavigate", "Navigate an isolated browser tab."),
    tool("BrowserSnapshot", "Read a bounded semantic browser snapshot."),
    tool("BrowserScreenshot", "Capture bounded visual browser evidence."),
    tool("BrowserScroll", "Perform bounded semantic scrolling."),
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
    "BrowserOpen", "BrowserNavigate", "BrowserSnapshot", "BrowserScreenshot",
    "BrowserScroll", "BrowserWait", "BrowserHistory", "BrowserTabs", "BrowserClose",
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

  for (const name of ["BrowserScroll", "BrowserWait", "BrowserHistory", "BrowserTabs"]) {
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
