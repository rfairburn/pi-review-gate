import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CODEMODE_TOOL_NAME, DeferredToolManager } from "../src/deferred-tools";
import { DEFERRED_TOOL_SEARCH_NAME, createExecutorToolCatalog } from "../src/execution/tool-catalog";
import { GIT_READ_TOOL_NAME } from "../src/git-read/tool";
import type { OperatingMode } from "../src/config";
import { measureToolSchemaBaseline } from "./tool-schema-baseline-helper";

interface RegisteredTool {
  name: string;
  description?: string;
  promptSnippet?: string;
  exposure?: string;
  parameters?: unknown;
  execute?: (id: string, params: unknown) => Promise<Record<string, unknown>>;
  renderResult?: (value: unknown, options: unknown, theme: unknown, context?: unknown) => unknown;
}

function tool(name: string, description: string, extra: { exposure?: string } = {}): RegisteredTool {
  return {
    name,
    description,
    ...(extra.exposure ? { exposure: extra.exposure } : {}),
    parameters: {
      type: "object",
      properties: {
        request: { type: "string", description: `${name} request with representative schema text` },
      },
      required: ["request"],
      additionalProperties: false,
    },
  } as RegisteredTool;
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
  /** Model a registry-side disappearance (server withdrawal/unregistration). */
  const removeFromRegistry = (name: string) => {
    const index = definitions.findIndex((candidate) => candidate.name === name);
    if (index >= 0) definitions.splice(index, 1);
  };
  return {
    pi,
    sessionIdentity,
    definitions,
    setCalls,
    registerInactive,
    removeFromRegistry,
    active: () => [...active],
    search: () => {
      const registered = definitions.find((definition) => definition.name === "search_tools");
      assert.ok(registered?.execute);
      return registered.execute;
    },
  };
}

test("write starts active only when authorized and not in planning (#45)", () => {
  for (const mode of ["execute", "orchestrate", "plan-research"] as const) {
    for (const excluded of [false, true]) {
      const fixture = hostFixture({ disabled: excluded ? ["write"] : [] });
      const manager = new DeferredToolManager(fixture.pi, () => mode);
      manager.register();
      manager.sessionStart(fixture.sessionIdentity);
      assert.equal(fixture.active().includes("write"), !excluded && mode !== "plan-research");
    }
  }
});

test("a captured worker catalog does not gain initial write activation on restore (#45)", () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  const catalog = { allowedToolCatalog: ["read", "write"], initialActiveTools: ["read"] };
  manager.sessionStart(fixture.sessionIdentity, catalog, true);
  assert.deepEqual(fixture.active(), ["read", "search_tools"]);
  assert.deepEqual(catalog.initialActiveTools, ["read"]);
});

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

  assert.deepEqual(fixture.active(), ["read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart", "search_tools"]);
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
  assert.deepEqual(fixture.active(), ["read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart", "search_tools"]);
  // #224: a Pi-permitted tool registered after capture joins the authority at
  // the next reconciliation (registry diff) but never the declared set until
  // search_tools loads it.
  assert.ok(reloaded.authorizedToolNames()?.includes("post_capture"), "top-level reconcile adopts late registrations");
  assert.ok(!fixture.active().includes("post_capture"), "host auto-activation is not promoted to declaration");
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
  // Stable discovery set: authorized catalog minus baseline-loaded role tools
  // ("read" and search_tools itself). Baseline omission keeps the inventory
  // byte-stable while deferred tools activate.
  const inventory = manager.startupGuidance() ?? "";
  assert.match(inventory, /"write" \(Create or overwrite a file\)/);
  assert.match(inventory, /"WebSearch" \(Search the public web for current sources\)/);
  assert.doesNotMatch(inventory, /"read"|"search_tools"/);
  assert.match(inventory, /exact name/);
  assert.match(inventory, /next turn/);
  assert.doesNotMatch(inventory, /parameters|properties|Supports images/);

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

test("a retained dynamic host boundary cannot become a configured worker ceiling", () => {
  const fixture = hostFixture();
  const hostManager = new DeferredToolManager(fixture.pi);
  hostManager.register();
  assert.equal(hostManager.sessionStart(fixture.sessionIdentity), true);
  const hostCatalog = createExecutorToolCatalog(
    hostManager.authorizedToolNames()!,
    ["read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart"],
  );

  const workerReload = new DeferredToolManager(fixture.pi);
  workerReload.register();
  assert.equal(
    workerReload.sessionStart(fixture.sessionIdentity, hostCatalog, true),
    false,
    "dynamic host authority cannot be reinterpreted as a frozen worker ceiling",
  );
  assert.equal(workerReload.authorizedToolNames(), undefined);
});

test("role-filtered research inventory lists only deferred discovery names without mutation tools or schemas", () => {
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
  // "read" is baseline-loaded for this role and search_tools is baseline:
  // neither may appear; every deferred discovery tool does.
  assert.doesNotMatch(inventory, /"read"|"search_tools"/);
  for (const name of ["WebSearch", ...browserNames]) {
    assert.match(inventory, new RegExp(`"${name}" \\(`));
  }
  assert.doesNotMatch(inventory, /"(?:bash|edit|write|ApplyPatch|BrowserClick)"/);
  // Compact purposes come from canonical catalog metadata only, bounded, and
  // never include excluded tools, schema text, or second copies of the list.
  for (const [, purpose] of inventory.matchAll(/"[^"]+" \(([^)]*)\)/g)) {
    assert.ok(purpose.length <= 60, `purpose too long (${purpose.length})`);
  }
  assert.doesNotMatch(inventory, /Excluded interaction|parameters|properties/);
  for (const name of browserNames) {
    assert.equal([...inventory.matchAll(new RegExp(`"${name}"`, "g"))].length, 1, `${name} is listed exactly once`);
  }
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
  assert.deepEqual(fixture.active(), ["read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart"]);
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
  assert.deepEqual(fixture.active(), ["read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart", "search_tools"]);
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
    "read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart", "search_tools", "SubtasksAdd", "SubtasksInspect",
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
  assert.deepEqual((result.details as { activated: string[] }).activated, [], "write was already active");
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
    tool("BrowserUpload", "Upload explicitly chosen host files into a file input under policy."),
    tool("BrowserDownloadSave", "Save retained pending downloads to explicitly chosen destinations under policy."),
    tool("BrowserClipboard", "Read or replace bounded browser clipboard text under policy."),
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
    "BrowserUpload", "BrowserDownloadSave", "BrowserClipboard",
    "BrowserWait", "BrowserHistory", "BrowserTabs", "BrowserClose",
  ];
  for (const name of browserNames) {
    assert.ok(manager.authorizedToolNames()?.includes(name));
    assert.equal(fixture.active().includes(name), false, `${name} must not be initially active`);
    assert.match(manager.startupGuidance() ?? "", new RegExp(`"${name}" \\(`));
  }
  // Compact purposes from canonical metadata are expected; schemas are not.
  assert.doesNotMatch(manager.startupGuidance() ?? "", /parameters|properties/);
  const result = await fixture.search()("browser", { query: "BrowserSnapshot" });
  assert.deepEqual((result.details as { matched: string[] }).matched, ["BrowserSnapshot"]);
  assert.deepEqual((result.details as { activated: string[] }).activated, ["BrowserSnapshot"]);
  assert.ok(fixture.active().includes("BrowserSnapshot"));
  assert.equal(fixture.active().includes("BrowserOpen"), false);

  const screenshot = await fixture.search()("screenshot", { query: "BrowserScreenshot" });
  assert.deepEqual((screenshot.details as { matched: string[] }).matched, ["BrowserScreenshot"]);
  assert.deepEqual((screenshot.details as { activated: string[] }).activated, ["BrowserScreenshot"]);
  assert.ok(fixture.active().includes("BrowserScreenshot"));

  for (const name of ["BrowserConsole", "BrowserNetwork", "BrowserInspect", "BrowserScroll", "BrowserHover", "BrowserClick", "BrowserFill", "BrowserType", "BrowserSelect", "BrowserPress", "BrowserUpload", "BrowserDownloadSave", "BrowserClipboard", "BrowserWait", "BrowserHistory", "BrowserTabs"]) {
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

test("late top-level registrations join authority while disabled names stay excluded (#224)", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  fixture.pi.registerTool(tool("new_private", "Search newly registered private records."));
  assert.ok(fixture.active().includes("new_private"), "fixture models Pi activating a newly registered tool");
  // The reconciled desired set strips the unmanaged activation on the next write.
  manager.reapply();
  assert.equal(fixture.active().includes("new_private"), false, "host auto-activation is not promoted to declaration");
  assert.ok(manager.authorizedToolNames()?.includes("new_private"), "top-level registry adoption authorizes late registrations");
  const newlyRegistered = await fixture.search()("new", { query: "newly registered private" });
  assert.deepEqual((newlyRegistered.details as { activated: string[] }).activated, ["new_private"]);
  assert.ok(fixture.active().includes("new_private"), "search loading is the required activation step");
  assert.ok(manager.toolCallAllowed("new_private"), "declared adopted tool is callable");

  // A name the registry knew at capture but never authorized stays excluded:
  // capture-time exclusions are not "new registrations" and never adopt.
  const disabled = await fixture.search()("disabled", { query: "disabled private" });
  assert.deepEqual((disabled.details as { activated: string[] }).activated, []);
  assert.equal(fixture.active().includes("disabled_private"), false);
  assert.equal(manager.authorizedToolNames()?.includes("disabled_private"), false);
  assert.equal(manager.toolCallAllowed("disabled_private"), false);
});

test("session restart and a recreated ExtensionAPI wrapper reuse the session authorization boundary", async () => {
  const fixture = hostFixture();
  const first = new DeferredToolManager(fixture.pi);
  first.register();
  first.sessionStart(fixture.sessionIdentity);
  await fixture.search()("load", { query: "public web" });
  assert.ok(fixture.active().includes("WebSearch"));

  first.sessionStart(fixture.sessionIdentity);
  const initial = ["read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart", "search_tools"];
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
  // #224: a registration between incarnations joins authority at the reload
  // reconciliation and is loadable by search afterwards.
  const reloadPrivate = await fixture.search()("reload-private", { query: "original authorization capture" });
  assert.deepEqual((reloadPrivate.details as { activated: string[] }).activated, ["reload_private"]);
  assert.ok(reloaded.authorizedToolNames()?.includes("reload_private"));
  assert.ok(fixture.active().includes("reload_private"));
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
  const restrictive = ["read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart"];
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

test("the first-request deferred schema remains smaller with write initially active", () => {
  const fixture = hostFixture();
  const before = measureToolSchemaBaseline(fixture.active(), fixture.definitions);
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  const after = measureToolSchemaBaseline(fixture.active(), fixture.definitions);

  assert.ok(fixture.active().includes("write"));
  assert.ok(!fixture.active().includes("WebSearch"));
  assert.ok(after.activeToolCount < before.activeToolCount);
  assert.ok(
    after.serializedSchemaBytes < before.serializedSchemaBytes,
    `expected schema reduction (${before.serializedSchemaBytes} -> ${after.serializedSchemaBytes})`,
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
  // Baseline-loaded discovery is deliberately omitted from the startup
  // inventory (stable discovery set), while staying authorized and active.
  assert.doesNotMatch(manager.startupGuidance() ?? "", /"grep"|"find"|"ls"/);

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
    // Active-by-default discovery is baseline: absent from the inventory.
    assert.doesNotMatch(manager.startupGuidance() ?? "", new RegExp(`"${name}"`));
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

test("search_tools description tracks the stable discovery set across mode and permission changes only", async () => {
  const fixture = hostFixture();
  fixture.pi.registerTool(tool("grep", "Search file contents for a pattern."));
  let registerCalls = 0;
  const originalRegister = fixture.pi.registerTool.bind(fixture.pi);
  fixture.pi.registerTool = (definition: RegisteredTool) => {
    if (definition.name === "search_tools") registerCalls++;
    return originalRegister(definition);
  };
  let mode: OperatingMode = "orchestrate";
  const manager = new DeferredToolManager(fixture.pi, () => mode);
  manager.register();

  // Before a boundary is captured the description lists no names.
  const preStart = searchDescription(fixture);
  assert.doesNotMatch(preStart, /Authorized tool names:/);
  assert.equal(registerCalls, 1, "initial registration only");

  assert.equal(manager.sessionStart(fixture.sessionIdentity), true);
  const writeMode = searchDescription(fixture);
  assert.match(writeMode, /Activate authorized tools\. If names are known, query only exact tool names/);
  // Discovery set = authorized minus baseline-loaded (read/bash/edit/write/
  // ApplyPatch/SubtasksStart) minus search_tools itself.
  assert.match(writeMode, /Authorized tool names: SubtasksAdd, SubtasksInspect, WebSearch./);
  assert.doesNotMatch(writeMode, /read, bash|search_tools\./);
  assert.equal(registerCalls, 2, "exactly one refresh after boundary capture");
  // Names only: no per-name purposes or schema text in the description.
  assert.doesNotMatch(writeMode, /Execute a shell command|Read file contents|parameters|properties/);

  // Activation must not change the description or startup guidance (byte-equal
  // stability; no needless prompt-cache invalidation) and only one refresh
  // happens despite the no-change reapply.
  const guidanceBefore = manager.startupGuidance() ?? "";
  await fixture.search()("activate", { query: "public web" });
  assert.ok(fixture.active().includes("WebSearch"), "activation happened");
  assert.equal(searchDescription(fixture), writeMode, "description is byte-identical after activation");
  assert.equal(manager.startupGuidance(), guidanceBefore, "startup guidance is byte-identical after activation");
  assert.equal(registerCalls, 2);

  // The activated deferred tool REMAINS listed in both surfaces.
  assert.match(searchDescription(fixture), /WebSearch/);
  assert.match(manager.startupGuidance() ?? "", /"WebSearch" \(/);

  // An exact-name search of an already-active tool reports already-active —
  // activation state, never new permission or an inventory change.
  const already = await fixture.search()("already", { query: "WebSearch" });
  assert.equal((already.details as { outcome: string }).outcome, "already-active");
  assert.equal(searchDescription(fixture), writeMode);

  // A no-change reapply does not re-register.
  manager.reapply();
  assert.equal(registerCalls, 2);

  // Plan/research drops write-capable and execution-control names live.
  mode = "plan-research";
  manager.reapply();
  const researchMode = searchDescription(fixture);
  assert.match(researchMode, /Authorized tool names: SubtasksInspect, WebSearch./);
  assert.doesNotMatch(researchMode, /bash|edit|write|ApplyPatch|SubtasksStart|SubtasksAdd/);
  assert.doesNotMatch(researchMode, /disabled_private/);
  // The research guidance rebuilt from the switched permission boundary;
  // baseline-loaded grep stays excluded from the discovery inventory too.
  assert.match(manager.startupGuidance() ?? "", /"SubtasksInspect" \(/);
  assert.doesNotMatch(manager.startupGuidance() ?? "", /"write"|"bash"|"grep"|"read"/);

  // Switching back restores the write-mode baseline byte-for-byte.
  mode = "orchestrate";
  manager.reapply();
  assert.equal(searchDescription(fixture), writeMode);
  assert.equal(manager.startupGuidance(), guidanceBefore);

  // Late registrations join the live discovery set (#224): the description
  // lists them after reconciliation (a real boundary change), and the
  // activation state never alters the set in between.
  fixture.pi.registerTool(tool("late_private", "Registered after capture."));
  manager.reapply();
  assert.match(searchDescription(fixture), /late_private/, "reconcile adopts late registrations into the live discovery set");

  // Startup guidance keeps exactly one list: deferred discovery names with
  // compact purposes, never the description's comma-delimited raw list.
  const guidance = manager.startupGuidance() ?? "";
  assert.match(guidance, /"SubtasksAdd" \(/);
  assert.doesNotMatch(guidance, /Authorized tool names:/);
  assert.doesNotMatch(guidance, /"search_tools"|"read"|"bash"/);
});

test("deferred-disabled sessions render no redundant inventory and the description lists no names", () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity, undefined, false, false);

  // Everything authorized is baseline-loaded; logically no inventory remains.
  assert.equal(manager.startupGuidance(), undefined);
  assert.doesNotMatch(searchDescription(fixture), /Authorized tool names:/);
  // The promptSnippet must not promise a system-prompt inventory that is not
  // injected; the exact-name rule is preserved either way.
  const offSnippet = searchSnippet(fixture);
  assert.match(offSnippet, /No system-prompt inventory is provided/);
  assert.doesNotMatch(offSnippet, /Authorized names are listed in the system prompt/);
  assert.match(offSnippet, /Search only exact tool names when known/);

  // Re-enabling deferred mode is a legitimate boundary change: the stable
  // discovery set reappears without any activation event, and the snippet
  // restores the inventory claim with the exact-name rule intact.
  assert.equal(manager.setDeferredEnabled(true), true);
  assert.match(searchDescription(fixture), /Authorized tool names: SubtasksAdd, SubtasksInspect, WebSearch\./);
  assert.match(manager.startupGuidance() ?? "", /"SubtasksAdd" \(/);
  const onSnippet = searchSnippet(fixture);
  assert.match(onSnippet, /Authorized names are listed in the system prompt/);
  assert.doesNotMatch(onSnippet, /No system-prompt inventory/);
  assert.match(onSnippet, /only exact tool names when known, without descriptive words/);

  assert.equal(manager.setDeferredEnabled(false), true);
  assert.equal(manager.startupGuidance(), undefined);
  assert.doesNotMatch(searchDescription(fixture), /Authorized tool names:/);
  assert.equal(searchSnippet(fixture), offSnippet);
});

// --- #73 GitRead role visibility (top-level mode pin and durable worker catalogs)

const GIT_READ_DESCRIPTION = "Structured read-only Git history research on the current repository.";

function gitReadSearchFixture() {
  const fixture = hostFixture();
  fixture.pi.registerTool(tool(GIT_READ_TOOL_NAME, GIT_READ_DESCRIPTION));
  return fixture;
}

test("GitRead is active from the first plan/research request and never a deferred target (#73)", async () => {
  const fixture = gitReadSearchFixture();
  const manager = new DeferredToolManager(fixture.pi, () => "plan-research");
  assert.equal(manager.register(), true);
  assert.equal(manager.sessionStart({}), true);

  // Active immediately even though deferred tools are enabled: the mode pin,
  // not search activation, owns it.
  assert.deepEqual(fixture.active(), ["read", "search_tools", GIT_READ_TOOL_NAME]);

  // Never disclosed as a deferred discovery target in either surface.
  assert.doesNotMatch(manager.startupGuidance() ?? "", /GitRead/);
  assert.doesNotMatch(searchDescription(fixture), /GitRead/);
  assert.doesNotMatch(searchSnippet(fixture), /GitRead/);

  // Exact and capability searches find it only as already active.
  const exact = await fixture.search()("id", { query: GIT_READ_TOOL_NAME });
  assert.equal(exact.isError, false);
  assert.deepEqual((exact.details as { activated: string[] }).activated, []);
  assert.match(JSON.stringify(exact), /already active/);
  const capability = await fixture.search()("id", { query: "git history" });
  assert.equal(capability.isError, false);
  assert.deepEqual((capability.details as { activated: string[] }).activated, []);
  assert.match(JSON.stringify(capability), /already active/);
});

test("GitRead is absent from the active set, inventory, and search outside plan/research (#73)", async () => {
  const fixture = gitReadSearchFixture();
  const manager = new DeferredToolManager(fixture.pi, () => "execute");
  assert.equal(manager.register(), true);
  assert.equal(manager.sessionStart({}), true);

  assert.deepEqual(
    fixture.active(),
    ["read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart", "search_tools"],
  );
  assert.doesNotMatch(manager.startupGuidance() ?? "", /GitRead/);
  assert.doesNotMatch(searchDescription(fixture), /GitRead/);

  // Neither exact names nor capability terms may match or activate it.
  const exact = await fixture.search()("id", { query: GIT_READ_TOOL_NAME });
  assert.deepEqual((exact.details as { activated: string[] }).activated, []);
  assert.match(JSON.stringify(exact), /No authorized tools matched/);
  const capability = await fixture.search()("id", { query: "git history" });
  assert.deepEqual((capability.details as { activated: string[] }).activated, []);

  // A stale host-side activation is stripped on the next reassertion.
  fixture.pi.setActiveTools([...fixture.active(), GIT_READ_TOOL_NAME]);
  manager.reapply();
  assert.equal(fixture.active().includes(GIT_READ_TOOL_NAME), false);
});

test("GitRead visibility reasserts across plan/research and execute mode switches (#73)", async () => {
  const fixture = gitReadSearchFixture();
  let mode: OperatingMode = "plan-research";
  const manager = new DeferredToolManager(fixture.pi, () => mode);
  assert.equal(manager.register(), true);
  assert.equal(manager.sessionStart({}), true);
  assert.ok(fixture.active().includes(GIT_READ_TOOL_NAME));
  const planDescription = searchDescription(fixture);

  mode = "execute";
  manager.reapply();
  assert.equal(fixture.active().includes(GIT_READ_TOOL_NAME), false, "switching to execute removes it");
  const executeDescription = searchDescription(fixture);
  assert.doesNotMatch(executeDescription, /GitRead/);
  assert.doesNotMatch(manager.startupGuidance() ?? "", /GitRead/);

  mode = "plan-research";
  manager.reapply();
  assert.ok(fixture.active().includes(GIT_READ_TOOL_NAME), "switching back restores it");
  assert.equal(
    searchDescription(fixture),
    planDescription,
    "search description round-trips byte-for-byte",
  );
});

test("GitRead follows the operating mode with deferred tools off (#73)", async () => {
  const fixture = gitReadSearchFixture();
  let mode: OperatingMode = "execute";
  const manager = new DeferredToolManager(fixture.pi, () => mode);
  assert.equal(manager.register(), true);
  assert.equal(manager.sessionStart({}, undefined, false, false), true);
  // Full authorized set active outside plan/research — but the mode ceiling
  // still strips GitRead from the full-active desired set.
  assert.deepEqual(
    fixture.active(),
    ["read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart", "SubtasksAdd",
      "SubtasksInspect", "WebSearch", "search_tools"],
  );

  mode = "plan-research";
  manager.reapply();
  // The planning ceiling keeps only read-only names, and the mode pin adds
  // GitRead back in.
  assert.deepEqual(
    fixture.active(),
    ["read", "SubtasksInspect", "WebSearch", GIT_READ_TOOL_NAME, "search_tools"],
  );
});

test("a durable research catalog keeps GitRead active from the first request under the default role (#73)", async () => {
  const fixture = gitReadSearchFixture();
  // Conservative initial subset: read + GitRead are active up front; the rest
  // of the allowed ceiling stays deferred-discoverable.
  const catalog = createExecutorToolCatalog(
    ["read", "bash", "edit", "write", "ApplyPatch", GIT_READ_TOOL_NAME],
    ["read", GIT_READ_TOOL_NAME],
  );
  // The worker's default role is orchestrate, never plan/research; the durable
  // catalog alone must keep GitRead visible.
  const manager = new DeferredToolManager(fixture.pi);
  assert.equal(manager.register(), true);
  assert.equal(manager.sessionStart({}, catalog), true);

  assert.deepEqual(fixture.active(), ["read", GIT_READ_TOOL_NAME, "search_tools"]);
  // The deferred discovery set is the allowed ceiling minus the baseline;
  // GitRead is never listed as a discovery target.
  const guidance = manager.startupGuidance() ?? "";
  for (const name of ["ApplyPatch", "bash", "edit", "write"]) {
    assert.match(guidance, new RegExp(`\\"${name}\\"`));
  }
  assert.doesNotMatch(guidance, /GitRead/);
  assert.doesNotMatch(searchDescription(fixture), /GitRead/);
  const exact = await fixture.search()("id", { query: GIT_READ_TOOL_NAME });
  assert.equal(exact.isError, false);
  assert.deepEqual((exact.details as { activated: string[] }).activated, []);
  assert.match(JSON.stringify(exact), /already active/);

  manager.reapply();
  assert.ok(fixture.active().includes(GIT_READ_TOOL_NAME), "the default role never hides it");
});

test("an execute-kind durable catalog removes a registered GitRead from the worker active set (#73)", async () => {
  const fixture = gitReadSearchFixture();
  const catalog = createExecutorToolCatalog(
    ["read", "bash", "edit", "write", "ApplyPatch"],
    ["read", "bash", "edit", "write", "ApplyPatch"],
  );
  const manager = new DeferredToolManager(fixture.pi);
  assert.equal(manager.register(), true);
  assert.equal(manager.sessionStart({}, catalog), true);

  assert.deepEqual(
    fixture.active(),
    ["read", "bash", "edit", "write", "ApplyPatch", "search_tools"],
    "stripped at session_start despite registration",
  );
  assert.doesNotMatch(manager.startupGuidance() ?? "", /GitRead/);
  assert.doesNotMatch(searchDescription(fixture), /GitRead/);
  const exact = await fixture.search()("id", { query: GIT_READ_TOOL_NAME });
  assert.deepEqual((exact.details as { activated: string[] }).activated, []);
});

test("a worker catalog admitting GitRead only in the allowed ceiling fails closed (#73)", async () => {
  // The visibility rule keys on the initial subset, so a contradictory shape
  // (allowed without initial) is rejected at capture instead of making an
  // authorized tool silently unusable.
  const fixture = gitReadSearchFixture();
  const catalog = createExecutorToolCatalog(
    ["read", "bash", GIT_READ_TOOL_NAME],
    ["read"],
  );
  const manager = new DeferredToolManager(fixture.pi);
  assert.equal(manager.register(), true);
  assert.equal(manager.sessionStart({}, catalog), false, "contradictory catalog is rejected fail-closed");
  assert.equal(fixture.active().includes(GIT_READ_TOOL_NAME), false);
});

test("an explicit Pi launch allowlist excluding GitRead stays authoritative (#73)", async () => {
  // No GitRead registration at all models --tools/--exclude-tools removal.
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi, () => "plan-research");
  assert.equal(manager.register(), true);
  assert.equal(manager.sessionStart({}), true);

  assert.equal(fixture.active().includes(GIT_READ_TOOL_NAME), false);
  assert.doesNotMatch(searchDescription(fixture), /GitRead/);
  const exact = await fixture.search()("id", { query: GIT_READ_TOOL_NAME });
  assert.deepEqual((exact.details as { activated: string[] }).activated, []);
});

// --- #224 live catalog reconciliation, exposure-aware search, wrapper codemode default

test("registry removal reconciles live without restart and reappearance is re-adopted (#224)", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  await fixture.search()("load", { query: "public web" });
  assert.ok(fixture.active().includes("WebSearch"));

  // Registry-side removal (server shutdown/unregistration): authority,
  // discovery, and the declared set all reconcile on the next boundary.
  fixture.removeFromRegistry("WebSearch");
  manager.reapply();
  assert.equal(fixture.active().includes("WebSearch"), false, "no stale successful activation survives removal");
  assert.equal(manager.authorizedToolNames()?.includes("WebSearch"), false);
  const gone = await fixture.search()("gone", { query: "public web" });
  assert.deepEqual((gone.details as { activated: string[] }).activated, []);
  assert.equal(manager.toolCallAllowed("WebSearch"), false, "removed names cannot claim activation");
  assert.equal(guidanceListsName(manager, "WebSearch"), false);

  // The same name reappearing in the registry is a re-permitted registration:
  // re-adopted into authority (inactive until search loads it).
  fixture.pi.registerTool(tool("WebSearch", "Search the public web for current sources."));
  assert.ok(manager.authorizedToolNames()?.includes("WebSearch"), "reappearance is re-adopted into authority");
  const back = await fixture.search()("back", { query: "public web" });
  assert.deepEqual((back.details as { activated: string[] }).activated, ["WebSearch"]);
  assert.ok(manager.toolCallAllowed("WebSearch"));
});

test("hidden withdrawal and exposure restoration reconcile live (#224)", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  await fixture.search()("load", { query: "public web" });
  assert.ok(fixture.active().includes("WebSearch"));

  // Withdrawal via re-registration with hidden exposure flips the live entry
  // (names persist in the Pi registry; no unregistration event exists).
  fixture.pi.registerTool(tool("WebSearch", "Search the public web for current sources.", { exposure: "hidden" }));
  manager.reapply();
  assert.equal(fixture.active().includes("WebSearch"), false, "withdrawal strips a previous activation");
  assert.equal(manager.authorizedToolNames()?.includes("WebSearch"), false);
  assert.equal(guidanceListsName(manager, "WebSearch"), false);
  assert.doesNotMatch(searchDescription(fixture), /WebSearch/);
  const withdrawnSearch = await fixture.search()("withdrawn", { query: "public web" });
  assert.deepEqual((withdrawnSearch.details as { activated: string[] }).activated, []);
  assert.equal(manager.toolCallAllowed("WebSearch"), false);
  assert.equal(manager.toolCallAllowed("WebSearch", true), false, "hidden is never script-callable");

  // Restoration replaces the registration with direct exposure again: the
  // withdrawn name is re-adopted and needs search loading once more.
  fixture.pi.registerTool(tool("WebSearch", "Search the public web for current sources."));
  assert.ok(manager.authorizedToolNames()?.includes("WebSearch"), "restored exposure is re-adopted");
  const restored = await fixture.search()("restore", { query: "public web" });
  assert.deepEqual((restored.details as { activated: string[] }).activated, ["WebSearch"]);
  assert.ok(fixture.active().includes("WebSearch"));
  assert.ok(manager.toolCallAllowed("WebSearch"));
});

test("configured worker ceilings never admit late registrations outside the catalog (#224)", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  assert.equal(manager.sessionStart(fixture.sessionIdentity, {
    allowedToolCatalog: ["read", "WebSearch"],
    initialActiveTools: ["read"],
  }), true);

  fixture.pi.registerTool(tool("late_worker_private", "Search a late private registry."));
  assert.ok(fixture.active().includes("late_worker_private"), "fixture models host auto-activation");
  manager.reapply();
  assert.equal(fixture.active().includes("late_worker_private"), false, "the frozen ceiling strips out-of-catalog registrations");
  assert.equal(manager.authorizedToolNames()?.includes("late_worker_private"), false, "the worker ceiling never expands");
  const denied = await fixture.search()("late", { query: "late private registry" });
  assert.deepEqual((denied.details as { activated: string[] }).activated, []);
  assert.equal(manager.toolCallAllowed("late_worker_private"), false);
  assert.equal(manager.toolCallAllowed("late_worker_private", true), false);
  assert.equal(guidanceListsName(manager, "late_worker_private"), false);
});

test("initially unavailable ceiling-only names are retained and become live when registered (#224)", async () => {
  // A durable ceiling names an MCP tool whose server has not connected at
  // capture: retained inside the immutable ceiling, invisible until the
  // registry provides it, then usable within the ceiling without re-capture.
  const fixture = hostFixture({ omit: ["WebSearch"] });
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  assert.equal(manager.sessionStart(fixture.sessionIdentity, {
    allowedToolCatalog: ["read", "WebSearch"],
    initialActiveTools: ["read"],
  }), true, "registry-absent ceiling-only names do not reject the legitimate catalog");
  assert.deepEqual(manager.authorizedToolNames(), ["read", "WebSearch"], "the ceiling retains the unavailable name");
  assert.equal(fixture.active().includes("WebSearch"), false);
  assert.equal(manager.toolCallAllowed("WebSearch"), false, "an unavailable tool is not callable");
  assert.equal(manager.toolCallAllowed("WebSearch", true), false);
  const early = await fixture.search()("early", { query: "public web" });
  assert.match(JSON.stringify(early), /No authorized tools matched/);

  fixture.pi.registerTool(tool("WebSearch", "Search the public web for current sources."));
  const live = await fixture.search()("late-mcp", { query: "public web" });
  assert.deepEqual((live.details as { activated: string[] }).activated, ["WebSearch"]);
  assert.ok(fixture.active().includes("WebSearch"));
  assert.ok(manager.toolCallAllowed("WebSearch"), "a live ceiling name is usable within the intersection");
  assert.deepEqual(manager.authorizedToolNames(), ["read", "WebSearch"], "the ceiling stays immutable on reconciliation");
});

test("an initial-active unavailable name still fails closed (broken bootstrap) (#224)", async () => {
  const fixture = hostFixture({ omit: ["WebSearch"] });
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  assert.equal(manager.sessionStart(fixture.sessionIdentity, {
    allowedToolCatalog: ["read", "WebSearch"],
    initialActiveTools: ["read", "WebSearch"],
  }), false, "the startup-active contract cannot be synthesized from a missing registry entry");
  assert.equal(manager.authorizedToolNames(), undefined);
  assert.equal(fixture.active().includes("WebSearch"), false);
});

test("full-off worker retains pending native MCP slots but not ordinary startup failures (#224)", async () => {
  const pendingMcp = "mcp__async__echo";
  const hiddenMcp = "mcp__async__counter";
  const missingResources = "list_mcp_resources";
  const hiddenResourceTemplates = "list_mcp_resource_templates";
  const missingResourceRead = "read_mcp_resource";
  const nativeSlots = [pendingMcp, hiddenMcp, missingResources, hiddenResourceTemplates, missingResourceRead];
  const fixture = hostFixture({ omit: [pendingMcp, missingResources, missingResourceRead] });
  fixture.registerInactive(tool(hiddenMcp, "An MCP counter hidden at worker startup.", { exposure: "hidden" }));
  fixture.registerInactive(tool(hiddenResourceTemplates, "Native resource templates hidden at startup.", { exposure: "hidden" }));
  fixture.pi.registerTool(tool(CODEMODE_TOOL_NAME, "Run scripts that call session tools.", { exposure: "model-only" }));

  const allowedToolCatalog = ["read", "write", CODEMODE_TOOL_NAME, ...nativeSlots];
  const catalog = { allowedToolCatalog, initialActiveTools: [...allowedToolCatalog] };
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  assert.equal(manager.sessionStart(fixture.sessionIdentity, catalog, true), true,
    "the original full OFF catalog tolerates native slots absent or hidden during asynchronous MCP registration");
  assert.ok(fixture.active().includes("read"));
  assert.ok(fixture.active().includes("write"));
  assert.ok(fixture.active().includes(CODEMODE_TOOL_NAME), "ordinary authorized model-only controls retain full-OFF activation");
  assert.ok(fixture.active().includes("search_tools"), "the mandatory loader remains active");
  for (const name of nativeSlots) {
    assert.ok(manager.authorizedToolNames()?.includes(name), `${name} remains inside the frozen catalog`);
    assert.equal(fixture.active().includes(name), false, `${name} is not synthesized from initial membership`);
    assert.equal(manager.toolCallAllowed(name), false, `${name} is unavailable until native metadata appears`);
    assert.equal(manager.toolCallAllowed(name, true), false);
    const search = await fixture.search()(`pending-${name}`, { query: name });
    assert.deepEqual((search.details as { matched: string[] }).matched, [], `${name} is not searchable while absent or hidden`);
  }

  fixture.registerInactive(tool(pendingMcp, "An asynchronously registered native echo.", { exposure: "deferred" }));
  fixture.registerInactive(tool(hiddenMcp, "The hidden MCP counter Pi later exposes.", { exposure: "codemode" }));
  fixture.registerInactive(tool(missingResources, "List native MCP resources."));
  fixture.registerInactive(tool(hiddenResourceTemplates, "List native MCP resource templates."));
  fixture.registerInactive(tool(missingResourceRead, "Read a native MCP resource."));
  manager.reapply();

  for (const name of [pendingMcp, hiddenMcp]) {
    assert.ok(manager.authorizedToolNames()?.includes(name), `${name} is still authorized by the unchanged ceiling`);
    assert.equal(fixture.active().includes(name), false, `${name} is not directly promoted on registration or restoration`);
    assert.equal(manager.toolCallAllowed(name), false);
    assert.equal(manager.toolCallAllowed(name, true), true, `${name} is callable through its native exposure`);
  }
  const nativeSearch = await fixture.search()("restored-native-slots", { query: `${pendingMcp} ${hiddenMcp}` });
  assert.deepEqual((nativeSearch.details as { nativeAvailable: string[] }).nativeAvailable, [hiddenMcp, pendingMcp]);
  assert.deepEqual((nativeSearch.details as { activated: string[] }).activated, []);

  for (const name of [missingResources, hiddenResourceTemplates, missingResourceRead]) {
    assert.ok(fixture.active().includes(name), `${name} becomes normally available inside the full OFF catalog`);
    assert.equal(manager.toolCallAllowed(name), true);
  }

  fixture.pi.setActiveTools([...fixture.active(), pendingMcp]);
  manager.reapply();
  assert.ok(fixture.active().includes(pendingMcp), "a genuine Pi selection becomes directly usable within the frozen ceiling");
  assert.equal(manager.toolCallAllowed(pendingMcp), true);

  const missingOrdinaryFixture = hostFixture({ omit: ["WebSearch"] });
  const missingOrdinaryManager = new DeferredToolManager(missingOrdinaryFixture.pi);
  missingOrdinaryManager.register();
  assert.equal(missingOrdinaryManager.sessionStart(missingOrdinaryFixture.sessionIdentity, {
    allowedToolCatalog: ["read", "WebSearch"],
    initialActiveTools: ["read", "WebSearch"],
  }, true), false, "the native slot exception does not weaken ordinary missing-tool validation");

  const hiddenOrdinaryFixture = hostFixture();
  hiddenOrdinaryFixture.registerInactive(tool("WebSearch", "A normal tool hidden by Pi.", { exposure: "hidden" }));
  const hiddenOrdinaryManager = new DeferredToolManager(hiddenOrdinaryFixture.pi);
  hiddenOrdinaryManager.register();
  assert.equal(hiddenOrdinaryManager.sessionStart(hiddenOrdinaryFixture.sessionIdentity, {
    allowedToolCatalog: ["read", "WebSearch"],
    initialActiveTools: ["read", "WebSearch"],
  }, true), false, "the native slot exception does not weaken ordinary hidden-tool validation");
});

test("search explains native codemode/deferred exposure without activating them (#224)", async () => {
  const fixture = hostFixture();
  fixture.registerInactive(tool("mcp__docs__search", "Search remote docs entries.", { exposure: "codemode" }));
  fixture.registerInactive(tool("DeferredRunner", "Run a deferred deferred-capable operation.", { exposure: "deferred" }));
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  // Registry-present native-callable tools are authorized without activation
  // and listed in the deferred discovery surface.
  assert.ok(manager.authorizedToolNames()?.includes("mcp__docs__search"));
  assert.ok(manager.authorizedToolNames()?.includes("DeferredRunner"));
  assert.equal(fixture.active().includes("mcp__docs__search"), false);
  assert.ok(guidanceListsName(manager, "mcp__docs__search"));
  assert.ok(guidanceListsName(manager, "DeferredRunner"));

  const native = await fixture.search()("native", { query: "mcp__docs__search DeferredRunner" });
  const details = native.details as { matched: string[]; activated: string[]; alreadyActive: string[]; nativeAvailable: string[]; outcome: string };
  assert.equal(native.isError, false);
  assert.deepEqual(details.matched, ["DeferredRunner", "mcp__docs__search"]);
  assert.deepEqual(details.activated, []);
  assert.deepEqual(details.alreadyActive, []);
  assert.deepEqual(details.nativeAvailable, ["DeferredRunner", "mcp__docs__search"]);
  assert.equal(details.outcome, "native-available");
  const text = String((native.content as Array<{ text: string }>)[0]?.text);
  assert.doesNotMatch(text, /Activated:/, "native exposure is never activated by the loader");
  assert.match(text, /callable from codemode scripts while it is inactive/);
  assert.match(text, /native tool_search can find, load, and declare it/);
  assert.equal(fixture.active().includes("mcp__docs__search"), false, "no direct declaration promotion");

  // Native availability is callable nested while inactive, never direct.
  assert.equal(manager.toolCallAllowed("mcp__docs__search"), false);
  assert.ok(manager.toolCallAllowed("mcp__docs__search", true), "codemode exposure stays script-callable while inactive");
  assert.equal(manager.toolCallAllowed("DeferredRunner"), false);
  assert.ok(manager.toolCallAllowed("DeferredRunner", true));

  // Mixed query: the direct match activates, the native match is explained.
  const mixed = await fixture.search()("mixed", { query: "WebSearch mcp__docs__search" });
  const mixedDetails = mixed.details as { activated: string[]; nativeAvailable: string[] };
  assert.deepEqual(mixedDetails.activated, ["WebSearch"]);
  assert.deepEqual(mixedDetails.nativeAvailable, ["mcp__docs__search"]);
  assert.equal(fixture.active().includes("WebSearch"), true);
  assert.equal(fixture.active().includes("mcp__docs__search"), false);

  // The renderer keeps the native outcome truthful in both arms.
  const card = fixture.definitions.find((definition) => definition.name === DEFERRED_TOOL_SEARCH_NAME)!;
  const renderCard = (expanded: boolean) => renderSearchCards(card!, native, expanded);
  assert.equal(renderCard(false), 'search_tools \u00b7 "mcp__docs__search DeferredRunner" \u00b7 native available DeferredRunner, mcp__docs__search');
  const expanded = renderCard(true);
  assert.ok(expanded.includes("Native availability (not activated by this search):"));
  assert.ok(expanded.includes("Native exposure left as registered"));
  assert.ok(expanded.includes("No discovered tool operation was executed by this search."));
});

test("deferred-off does not promote native exposures into the full direct declaration (#224)", async () => {
  const fixture = hostFixture();
  fixture.registerInactive(tool("mcp__docs__search", "Search remote docs entries.", { exposure: "codemode" }));
  fixture.registerInactive(tool("DeferredRunner", "Run a native deferred operation.", { exposure: "deferred" }));
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity, undefined, false, false);
  assert.ok(fixture.active().includes("WebSearch"), "ordinary permitted tools remain fully active");
  assert.equal(fixture.active().includes("mcp__docs__search"), false);
  assert.equal(fixture.active().includes("DeferredRunner"), false);
  assert.ok(manager.toolCallAllowed("mcp__docs__search", true));
  assert.ok(manager.toolCallAllowed("DeferredRunner", true));

  const result = await fixture.search()("native-full-set", {
    query: "mcp__docs__search DeferredRunner",
  });
  const details = result.details as {
    activated: string[];
    alreadyActive: string[];
    nativeAvailable: string[];
  };
  assert.deepEqual(details.activated, []);
  assert.deepEqual(details.alreadyActive, []);
  assert.deepEqual(details.nativeAvailable, ["DeferredRunner", "mcp__docs__search"]);
  assert.match(String((result.content as Array<{ text: string }>)[0]?.text), /No direct declaration changed/);
  manager.reapply();
  assert.equal(fixture.active().includes("mcp__docs__search"), false, "reapply does not turn native reachability into a declaration");
  assert.equal(fixture.active().includes("DeferredRunner"), false);
});

test("native tool_search declarations survive manager reapply only inside live authority (#224)", () => {
  const fixture = hostFixture();
  fixture.registerInactive(tool("mcp__docs__search", "Search remote docs entries.", { exposure: "codemode" }));
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  assert.equal(fixture.active().includes("mcp__docs__search"), false);

  // Model Pi's native tool_search declaring this already-authorized native
  // exposure. The manager must preserve that selection without adopting other
  // unmanaged tools or treating the native tool as a search_tools activation.
  fixture.pi.setActiveTools([...fixture.active(), "mcp__docs__search"]);
  assert.ok(manager.toolCallAllowed("mcp__docs__search"));
  manager.reapply();
  assert.ok(fixture.active().includes("mcp__docs__search"));
  assert.ok(manager.toolCallAllowed("mcp__docs__search"));

  fixture.removeFromRegistry("mcp__docs__search");
  manager.reapply();
  assert.equal(fixture.active().includes("mcp__docs__search"), false, "withdrawal removes the native declaration");
  assert.equal(manager.toolCallAllowed("mcp__docs__search"), false);
});

test("native declarations respect worker startup subsets and deferred resets (#224)", () => {
  for (const exposure of ["codemode", "deferred"]) {
    const fixture = hostFixture();
    const name = "mcp__docs__search";
    fixture.registerInactive(tool(name, "Search remote docs.", { exposure }));
    const manager = new DeferredToolManager(fixture.pi);
    manager.register();
    assert.equal(manager.sessionStart(fixture.sessionIdentity, {
      allowedToolCatalog: ["read", name],
      initialActiveTools: ["read"],
    }, true), true);
    assert.deepEqual(fixture.active(), ["read", "search_tools"]);
    assert.equal(manager.toolCallAllowed(name), false);
    assert.equal(manager.toolCallAllowed(name, true), true);

    fixture.pi.setActiveTools([...fixture.active(), name]);
    manager.reapply();
    assert.equal(manager.toolCallAllowed(name), true);

    assert.equal(manager.setDeferredEnabled(false), true);
    assert.ok(fixture.active().includes(name), "Pi's existing native declaration survives deferred-off");
    assert.equal(manager.setDeferredEnabled(true), true);
    assert.deepEqual(fixture.active(), ["read", "search_tools", name], "the native declaration survives a deferred-mode transition");
    assert.equal(manager.toolCallAllowed(name), true, "Pi's declared native tool remains directly available");
    assert.equal(manager.toolCallAllowed(name, true), true);
  }
});

test("deferred-off keeps native callees undeclared across toggles and late registrations (#224)", async () => {
  const fixture = hostFixture();
  const nativeCode = "mcp__docs__search";
  const nativeDeferred = "mcp__docs__load";
  const hidden = "mcp__private__hidden";
  fixture.registerInactive(tool(nativeCode, "Search remote docs entries.", { exposure: "codemode" }));
  fixture.registerInactive(tool(nativeDeferred, "Load a deferred remote document.", { exposure: "deferred" }));
  fixture.registerInactive(tool(hidden, "A hidden remote entry.", { exposure: "hidden" }));
  fixture.registerInactive(tool(CODEMODE_TOOL_NAME, "Run scripts that call session tools.", { exposure: "model-only" }));

  const manager = new DeferredToolManager(fixture.pi, () => "orchestrate", true);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity, undefined, false, false);
  assert.ok(fixture.active().includes("write"), "ordinary permitted tools use the normal full-active loadout");
  assert.ok(fixture.active().includes("WebSearch"));
  assert.ok(fixture.active().includes(CODEMODE_TOOL_NAME), "root codemode is an ordinary model-only tool in deferred-off mode");
  for (const name of [nativeCode, nativeDeferred, hidden]) assert.equal(fixture.active().includes(name), false);
  assert.equal(manager.toolCallAllowed(nativeCode), false);
  assert.equal(manager.toolCallAllowed(nativeDeferred), false);
  assert.ok(manager.toolCallAllowed(nativeCode, true), "native codemode exposure remains callable from scripts");
  assert.ok(manager.toolCallAllowed(nativeDeferred, true));
  assert.equal(manager.toolCallAllowed(hidden, true), false);

  const nativeSearch = await fixture.search()("search-native-off", { query: nativeCode });
  assert.deepEqual((nativeSearch.details as { matched: string[]; nativeAvailable: string[] }).matched, [nativeCode]);
  assert.deepEqual((nativeSearch.details as { nativeAvailable: string[] }).nativeAvailable, [nativeCode]);
  assert.equal(fixture.active().includes(nativeCode), false, "search_tools discovery does not declare a native callee");

  fixture.registerInactive(tool("mcp__late__search", "A late native search tool.", { exposure: "deferred" }));
  manager.reapply();
  manager.reapply();
  assert.ok(manager.authorizedToolNames()?.includes("mcp__late__search"));
  assert.equal(fixture.active().includes("mcp__late__search"), false, "late native registration stays undeclared");
  assert.ok(manager.toolCallAllowed("mcp__late__search", true));

  const hiddenSearch = await fixture.search()("search-hidden", { query: hidden });
  const disabledSearch = await fixture.search()("search-disabled", { query: "disabled_private" });
  assert.deepEqual((hiddenSearch.details as { matched: string[] }).matched, []);
  assert.deepEqual((disabledSearch.details as { matched: string[] }).matched, []);
  assert.equal(manager.authorizedToolNames()?.includes(hidden), false);
  assert.equal(manager.authorizedToolNames()?.includes("disabled_private"), false);

  assert.equal(manager.setDeferredEnabled(true), true);
  assert.equal(fixture.active().includes(CODEMODE_TOOL_NAME), false, "deferred-on still requires search before using root codemode");
  for (const name of [nativeCode, nativeDeferred, "mcp__late__search"]) assert.equal(fixture.active().includes(name), false);
  const codeLoad = await fixture.search()("load-root-codemode", { query: CODEMODE_TOOL_NAME });
  assert.deepEqual((codeLoad.details as { activated: string[] }).activated, [CODEMODE_TOOL_NAME]);
  assert.ok(fixture.active().includes(CODEMODE_TOOL_NAME));
  assert.equal(manager.setDeferredEnabled(false), true);
  assert.ok(fixture.active().includes(CODEMODE_TOOL_NAME), "deferred-off restores ordinary model-only codemode");
  for (const name of [nativeCode, nativeDeferred, "mcp__late__search"]) assert.equal(fixture.active().includes(name), false);
});

test("native Pi declarations survive managed writes and reload only within a frozen worker ceiling (#224)", () => {
  const fixture = hostFixture();
  const allowedNative = "mcp__docs__search";
  const outsideNative = "mcp__private__search";
  fixture.registerInactive(tool(allowedNative, "Search remote docs entries.", { exposure: "deferred" }));
  fixture.registerInactive(tool(outsideNative, "Search outside the worker ceiling.", { exposure: "codemode" }));

  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  const catalog = {
    allowedToolCatalog: ["read", allowedNative],
    initialActiveTools: ["read"],
  };
  assert.equal(manager.sessionStart(fixture.sessionIdentity, catalog, true, false), true,
    "native deferred callees may remain undeclared inside the immutable ceiling");
  assert.deepEqual(fixture.active(), ["read", "search_tools"]);
  assert.equal(manager.toolCallAllowed(allowedNative), false);
  assert.ok(manager.toolCallAllowed(allowedNative, true));
  assert.equal(manager.toolCallAllowed(outsideNative, true), false);

  // Simulate a native tool_search declaration. The manager must carry it
  // across reapplication and extension reload, but never adopt the out-of-
  // ceiling native name.
  fixture.pi.setActiveTools([...fixture.active(), allowedNative, outsideNative]);
  manager.reapply();
  assert.ok(fixture.active().includes(allowedNative));
  assert.equal(fixture.active().includes(outsideNative), false);

  const reloaded = new DeferredToolManager(fixture.pi);
  reloaded.register();
  assert.equal(reloaded.sessionStart(fixture.sessionIdentity, catalog, true, false), true);
  assert.ok(fixture.active().includes(allowedNative), "the selected native declaration survives same-session reload");
  assert.equal(fixture.active().includes(outsideNative), false, "the native CLI/worker ceiling remains authoritative");
  assert.deepEqual(reloaded.authorizedToolNames(), ["read", allowedNative]);

  fixture.pi.setActiveTools(fixture.active().filter((name) => name !== allowedNative));
  reloaded.reapply();
  assert.equal(fixture.active().includes(allowedNative), false, "a native deselection is not resurrected by reapply");
  assert.equal(reloaded.toolCallAllowed(allowedNative), false);
});

test("late native selections and restored pending declarations are observed outside managed loadouts (#224)", () => {
  const lateFixture = hostFixture();
  const lateNative = "mcp__late__deferred";
  const lateManager = new DeferredToolManager(lateFixture.pi);
  lateManager.register();
  assert.equal(lateManager.sessionStart(lateFixture.sessionIdentity, undefined, false, false), true);

  lateFixture.registerInactive(tool(lateNative, "A newly registered native MCP tool.", { exposure: "deferred" }));
  lateManager.reapply();
  assert.equal(lateFixture.active().includes(lateNative), false, "late inactive registration is not auto-promoted");
  lateFixture.pi.setActiveTools([...lateFixture.active(), lateNative]);
  lateManager.reapply();
  assert.equal(lateFixture.active().includes(lateNative), true, "an explicit native selection after registration survives reapply");
  assert.equal(lateManager.toolCallAllowed(lateNative), true);

  const restoredFixture = hostFixture();
  const pendingNative = "mcp__restored__pending";
  // Pi can retain this declaration as pending while the MCP server is absent.
  restoredFixture.pi.setActiveTools([...restoredFixture.active(), pendingNative]);
  const restoredManager = new DeferredToolManager(restoredFixture.pi);
  restoredManager.register();
  assert.equal(restoredManager.sessionStart(restoredFixture.sessionIdentity, undefined, false, false), true);
  assert.equal(restoredFixture.active().includes(pendingNative), false, "unavailable pending names stay out of managed live tools");

  restoredFixture.registerInactive(tool(pendingNative, "A restored native MCP tool.", { exposure: "codemode" }));
  // The native host resolves its saved pending declaration when MCP registers.
  restoredFixture.pi.setActiveTools([...restoredFixture.active(), pendingNative]);
  restoredManager.reapply();
  assert.equal(restoredFixture.active().includes(pendingNative), true, "a restored pending native declaration is not mistaken for registration noise");
  assert.equal(restoredManager.toolCallAllowed(pendingNative), true);
});

test("native tool_search stays Pi-selected and gains only late dynamic or in-ceiling authority (#224)", async () => {
  const nativeSearch = "tool_search";
  const fixture = hostFixture();
  fixture.registerInactive(tool(nativeSearch, "Pi's native MCP tool loader.", { exposure: "model-only" }));
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  assert.equal(manager.sessionStart(fixture.sessionIdentity, undefined, false, false), true, "top-level session captures successfully");
  assert.equal(manager.authorizedToolNames()?.includes(nativeSearch), false, "inactive ordinary model-only names stay excluded at capture");
  assert.equal(fixture.active().includes(nativeSearch), false, "deferred-off does not promote Pi's inactive native loader");

  fixture.pi.setActiveTools([...fixture.active(), nativeSearch]);
  manager.reapply();
  assert.equal(manager.authorizedToolNames()?.includes(nativeSearch), true, "a live native host selection grants only this selected builtin");
  assert.equal(fixture.active().includes(nativeSearch), true, "managed reapply preserves Pi's late native selection");
  assert.equal(manager.toolCallAllowed(nativeSearch), true, "the newly selected helper is callable within dynamic host authority");
  const selectedSearch = await fixture.search()("find-native-helper", { query: nativeSearch });
  assert.deepEqual((selectedSearch.details as { alreadyActive: string[] }).alreadyActive, [nativeSearch]);

  fixture.pi.setActiveTools(fixture.active().filter((name) => name !== nativeSearch));
  manager.reapply();
  assert.equal(fixture.active().includes(nativeSearch), false, "Pi's explicit native deselection is preserved");
  assert.equal(manager.toolCallAllowed(nativeSearch), false, "Pi's native deselection makes the builtin non-callable");

  const workerFixture = hostFixture();
  workerFixture.registerInactive(tool(nativeSearch, "Pi's native MCP tool loader.", { exposure: "model-only" }));
  const workerManager = new DeferredToolManager(workerFixture.pi);
  workerManager.register();
  const ceiling = { allowedToolCatalog: ["read", nativeSearch], initialActiveTools: ["read"] };
  assert.equal(workerManager.sessionStart(workerFixture.sessionIdentity, ceiling, true, false), true, "worker startup accepts its fixed helper ceiling");
  assert.equal(workerFixture.active().includes(nativeSearch), false, "deferred-off never widens a worker's initial subset automatically");
  const workerSearch = await workerFixture.search()("load-native-helper", { query: nativeSearch });
  assert.deepEqual((workerSearch.details as { activated: string[] }).activated, [nativeSearch]);
  assert.equal(workerFixture.active().includes(nativeSearch), true);
  workerFixture.pi.setActiveTools(workerFixture.active().filter((name) => name !== nativeSearch));
  workerManager.reapply();
  assert.equal(workerFixture.active().includes(nativeSearch), false, "native deselection survives gate loading");
  assert.equal(workerManager.toolCallAllowed(nativeSearch), false);
  workerFixture.pi.setActiveTools([...workerFixture.active(), nativeSearch]);
  workerManager.reapply();
  assert.equal(workerFixture.active().includes(nativeSearch), true, "a native selection inside the immutable worker ceiling is retained");
  assert.equal(workerManager.toolCallAllowed(nativeSearch), true, "a selected helper is callable inside the frozen worker ceiling");

  const restrictedFixture = hostFixture();
  restrictedFixture.registerInactive(tool(nativeSearch, "Pi's native MCP tool loader.", { exposure: "model-only" }));
  const restrictedManager = new DeferredToolManager(restrictedFixture.pi);
  restrictedManager.register();
  const restrictedCeiling = { allowedToolCatalog: ["read"], initialActiveTools: ["read"] };
  assert.equal(restrictedManager.sessionStart(restrictedFixture.sessionIdentity, restrictedCeiling, true, false), true, "restricted worker startup accepts its narrow ceiling");
  restrictedFixture.pi.setActiveTools([...restrictedFixture.active(), nativeSearch]);
  restrictedManager.reapply();
  assert.equal(restrictedFixture.active().includes(nativeSearch), false, "a native choice cannot widen a frozen worker ceiling");
  assert.equal(restrictedManager.authorizedToolNames()?.includes(nativeSearch), false);
  assert.equal(restrictedManager.toolCallAllowed(nativeSearch), false);
});

test("native Pi reselection survives a deselection observed by toolCallAllowed (#224)", () => {
  const fixture = hostFixture();
  const nativeCallee = "mcp__docs__reselect_after_query";
  fixture.registerInactive(tool(nativeCallee, "A Pi-native MCP callee.", { exposure: "deferred" }));
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  fixture.pi.setActiveTools([...fixture.active(), nativeCallee]);
  manager.reapply();
  assert.ok(fixture.active().includes(nativeCallee), "Pi's initial native selection is retained");
  assert.equal(manager.toolCallAllowed(nativeCallee), true);

  fixture.pi.setActiveTools(fixture.active().filter((name) => name !== nativeCallee));
  assert.equal(manager.toolCallAllowed(nativeCallee), false, "the call query observes and respects Pi's deselection");

  fixture.pi.setActiveTools([...fixture.active(), nativeCallee]);
  manager.reapply();
  assert.ok(fixture.active().includes(nativeCallee), "Pi's later selection is observed independently of the prior managed write");
  assert.equal(manager.toolCallAllowed(nativeCallee), true, "the reselection remains directly callable");
});

test("native reselection survives registry-only withdrawal reconciliation (#224)", () => {
  for (const frozen of [false, true]) {
    const fixture = hostFixture();
    const nativeCallee = "mcp__docs__restored_selection";
    fixture.registerInactive(tool(nativeCallee, "Native callee.", { exposure: "deferred" }));
    const manager = new DeferredToolManager(fixture.pi);
    manager.register();
    const catalog = frozen
      ? { allowedToolCatalog: ["read", nativeCallee], initialActiveTools: ["read"] }
      : undefined;
    assert.equal(manager.sessionStart(fixture.sessionIdentity, catalog, frozen, false), true);

    fixture.pi.setActiveTools([...fixture.active(), nativeCallee]);
    manager.reapply();
    assert.ok(fixture.active().includes(nativeCallee));

    fixture.registerInactive(tool(nativeCallee, "Withdrawn callee.", { exposure: "hidden" }));
    fixture.pi.setActiveTools(fixture.active().filter((name) => name !== nativeCallee));
    const writes = fixture.setCalls.length;
    manager.authorizedToolNames();
    assert.equal(manager.toolCallAllowed(nativeCallee, true), false);
    assert.equal(fixture.setCalls.length, writes, "withdrawal was observed without a managed write");

    fixture.registerInactive(tool(nativeCallee, "Restored callee.", { exposure: "deferred" }));
    assert.equal(fixture.active().includes(nativeCallee), false, "restoration alone does not declare it");
    fixture.pi.setActiveTools([...fixture.active(), nativeCallee]);
    manager.reapply();
    assert.ok(fixture.active().includes(nativeCallee), "Pi's new selection survives reconciliation");
    assert.equal(manager.toolCallAllowed(nativeCallee), true);
  }
});

test("dynamic host adopts a canonical native MCP name on hidden-to-visible exposure (#224)", async () => {
  const fixture = hostFixture();
  const hiddenNative = "mcp__restricted__hidden_then_deferred";
  fixture.registerInactive(tool(hiddenNative, "A native tool hidden by Pi at capture.", { exposure: "hidden" }));
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  assert.equal(manager.authorizedToolNames()?.includes(hiddenNative), false);
  assert.equal(manager.toolCallAllowed(hiddenNative, true), false);
  const beforeExposure = await fixture.search()("hidden-native", { query: hiddenNative });
  assert.deepEqual((beforeExposure.details as { matched: string[] }).matched, []);

  // Model Pi explicitly changing this canonical MCP tool from hidden to a
  // permitted native exposure without selecting it as a direct model tool.
  fixture.registerInactive(tool(hiddenNative, "Pi now permits this native tool.", { exposure: "deferred" }));
  manager.reapply();
  assert.ok(manager.authorizedToolNames()?.includes(hiddenNative), "the visible native exposure is a dynamic permission transition");
  assert.equal(fixture.active().includes(hiddenNative), false, "exposure permission does not synthesize a direct declaration");
  assert.equal(manager.toolCallAllowed(hiddenNative), false);
  assert.equal(manager.toolCallAllowed(hiddenNative, true), true, "the restored native exposure is callable from the permitted nested channel");
  const afterExposure = await fixture.search()("visible-native", { query: hiddenNative });
  assert.deepEqual((afterExposure.details as { nativeAvailable: string[] }).nativeAvailable, [hiddenNative]);
  assert.deepEqual((afterExposure.details as { activated: string[] }).activated, []);
});

test("first recovered registry snapshot can establish a hidden native MCP transition marker (#224)", () => {
  const fixture = hostFixture();
  const hiddenNative = "mcp__restricted__hidden_after_outage";
  fixture.registerInactive(tool(hiddenNative, "Native tool hidden in the first readable snapshot.", { exposure: "hidden" }));
  const healthyGetAllTools = fixture.pi.getAllTools;
  fixture.pi.getAllTools = () => { throw new Error("registry unavailable during capture"); };
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  assert.equal(manager.sessionStart(fixture.sessionIdentity), true, "an unreadable registry retains the dynamic boundary fail-closed");
  assert.equal(manager.authorizedToolNames()?.includes(hiddenNative), false);

  fixture.pi.getAllTools = healthyGetAllTools;
  manager.reapply();
  assert.equal(manager.authorizedToolNames()?.includes(hiddenNative), false, "the first readable hidden snapshot only establishes the baseline");
  fixture.registerInactive(tool(hiddenNative, "Pi now permits the native tool.", { exposure: "deferred" }));
  manager.reapply();
  assert.ok(manager.authorizedToolNames()?.includes(hiddenNative), "the subsequent explicit visible exposure is adopted");
  assert.equal(fixture.active().includes(hiddenNative), false, "transition authorization does not select a direct declaration");
  assert.equal(manager.toolCallAllowed(hiddenNative, true), true);
});

test("wrapper codemode default authorizes discoverable codemode without activation (#224)", async () => {
  const fixture = hostFixture();
  fixture.registerInactive(tool(CODEMODE_TOOL_NAME, "Run JavaScript scripts that call the session's tools.", { exposure: "model-only" }));
  const manager = new DeferredToolManager(fixture.pi, () => "orchestrate", true);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  // Discovery only: never in the conservative initial/base active set.
  assert.equal(fixture.active().includes(CODEMODE_TOOL_NAME), false, "search_tools is required before use");
  assert.ok(fixture.active().includes("write"), "the conservative base is unchanged");
  assert.ok(manager.authorizedToolNames()?.includes(CODEMODE_TOOL_NAME), "the wrapper default authorizes registry-permitted codemode");
  assert.ok(guidanceListsName(manager, CODEMODE_TOOL_NAME));
  assert.match(searchDescription(fixture), /Authorized tool names: SubtasksAdd, SubtasksInspect, WebSearch, codemode\./);
  assert.equal(manager.toolCallAllowed(CODEMODE_TOOL_NAME), false, "undeclared codemode is not callable");

  const load = await fixture.search()("codemode-load", { query: CODEMODE_TOOL_NAME });
  assert.deepEqual((load.details as { activated: string[] }).activated, [CODEMODE_TOOL_NAME], "search is the required activation step");
  assert.ok(fixture.active().includes(CODEMODE_TOOL_NAME));
  assert.ok(manager.toolCallAllowed(CODEMODE_TOOL_NAME), "declared codemode is callable in write modes");

  // The search-activated declaration persists across managed writes.
  manager.reapply();
  assert.ok(fixture.active().includes(CODEMODE_TOOL_NAME));
});

test("late codemode registration needs the captured wrapper default (#224)", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi, () => "orchestrate");
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  fixture.pi.registerTool(tool(CODEMODE_TOOL_NAME, "Run JavaScript scripts.", { exposure: "model-only" }));
  manager.reapply();
  assert.equal(manager.authorizedToolNames()?.includes(CODEMODE_TOOL_NAME), false);
  assert.equal(fixture.active().includes(CODEMODE_TOOL_NAME), false, "host auto-activation does not bypass wrapper intent");
  assert.equal(manager.toolCallAllowed(CODEMODE_TOOL_NAME), false);
  const search = await fixture.search()("late-codemode", { query: CODEMODE_TOOL_NAME });
  assert.deepEqual((search.details as { matched: string[] }).matched, []);
});

test("an already-active codemode stays captured as usual regardless of the wrapper flag (#224)", async () => {
  const fixture = hostFixture();
  fixture.pi.registerTool(tool(CODEMODE_TOOL_NAME, "Run JavaScript scripts that call the session's tools.", { exposure: "model-only" }));
  const manager = new DeferredToolManager(fixture.pi, () => "orchestrate", true);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  // Authoritative capture: a launch-active codemode is authorized like any
  // other launch-active tool, and the conservative base strips its declaration
  // exactly like every other non-baseline tool — deferred-on sessions load it
  // through search_tools first, wrapper flag or not.
  assert.ok(manager.authorizedToolNames()?.includes(CODEMODE_TOOL_NAME), "launch-active codemode is captured as usual");
  assert.equal(fixture.active().includes(CODEMODE_TOOL_NAME), false, "the conservative base applies to codemode like every other tool");
  assert.equal(manager.toolCallAllowed(CODEMODE_TOOL_NAME), false, "search_tools is required before use");

  const loaded = await fixture.search()("load", { query: CODEMODE_TOOL_NAME });
  assert.deepEqual((loaded.details as { activated: string[] }).activated, [CODEMODE_TOOL_NAME]);
  assert.ok(fixture.active().includes(CODEMODE_TOOL_NAME));
  assert.ok(manager.toolCallAllowed(CODEMODE_TOOL_NAME));
  assert.equal(manager.toolCallAllowed(CODEMODE_TOOL_NAME, true), false, "model-only codemode is never script-callable");
  const second = await fixture.search()("second", { query: CODEMODE_TOOL_NAME });
  assert.deepEqual((second.details as { activated: string[] }).activated, []);
  assert.deepEqual((second.details as { alreadyActive: string[] }).alreadyActive, [CODEMODE_TOOL_NAME]);
});

test("manual-session codemode authority recovers after withdrawal with deferred tools on or off (#224)", async () => {
  const deferredFixture = hostFixture();
  const codemode = tool(CODEMODE_TOOL_NAME, "Run JavaScript scripts.", { exposure: "model-only" });
  deferredFixture.pi.registerTool(codemode);
  const deferredManager = new DeferredToolManager(deferredFixture.pi, () => "orchestrate", false);
  deferredManager.register();
  deferredManager.sessionStart(deferredFixture.sessionIdentity, undefined, false, true);
  assert.ok(deferredManager.authorizedToolNames()?.includes(CODEMODE_TOOL_NAME), "launch-active codemode is captured without wrapper default");
  assert.equal(deferredFixture.active().includes(CODEMODE_TOOL_NAME), false, "deferred-on startup requires search loading");

  deferredFixture.removeFromRegistry(CODEMODE_TOOL_NAME);
  deferredManager.reapply();
  assert.equal(deferredManager.authorizedToolNames()?.includes(CODEMODE_TOOL_NAME), false);
  deferredFixture.pi.registerTool(codemode);
  deferredManager.reapply();
  assert.ok(deferredManager.authorizedToolNames()?.includes(CODEMODE_TOOL_NAME), "withdrawn launch authority is re-adopted");
  assert.equal(deferredFixture.active().includes(CODEMODE_TOOL_NAME), false, "withdrawn deferred selections require loading again");
  const loaded = await deferredFixture.search()("manual-codemode", { query: CODEMODE_TOOL_NAME });
  assert.deepEqual((loaded.details as { activated: string[] }).activated, [CODEMODE_TOOL_NAME]);
  assert.ok(deferredManager.toolCallAllowed(CODEMODE_TOOL_NAME));

  const fullFixture = hostFixture();
  fullFixture.pi.registerTool(codemode);
  const fullManager = new DeferredToolManager(fullFixture.pi, () => "orchestrate", false);
  fullManager.register();
  fullManager.sessionStart(fullFixture.sessionIdentity, undefined, false, false);
  assert.ok(fullFixture.active().includes(CODEMODE_TOOL_NAME));
  const healthyGetAllTools = fullFixture.pi.getAllTools;
  fullFixture.pi.getAllTools = () => [];
  fullManager.reapply();
  assert.equal(fullManager.authorizedToolNames()?.includes(CODEMODE_TOOL_NAME), false);
  fullFixture.pi.getAllTools = healthyGetAllTools;
  fullManager.reapply();
  assert.ok(fullManager.authorizedToolNames()?.includes(CODEMODE_TOOL_NAME), "empty-read recovery restores captured codemode authority");
  assert.ok(fullFixture.active().includes(CODEMODE_TOOL_NAME), "deferred-off restores the ordinary full authorized set");
  assert.ok(fullManager.toolCallAllowed(CODEMODE_TOOL_NAME));
});

test("the captured wrapper default intent survives reload and later codemode registration (#224)", async () => {
  // Capture with the wrapper default while codemode is not in the launch
  // registry; a constructor false on reload must never erase the intent.
  const fixture = hostFixture();
  const first = new DeferredToolManager(fixture.pi, () => "orchestrate", true);
  first.register();
  first.sessionStart(fixture.sessionIdentity);
  assert.equal(first.authorizedToolNames()?.includes(CODEMODE_TOOL_NAME), false, "nothing to authorize while the registry lacks it");

  fixture.registerInactive(tool(CODEMODE_TOOL_NAME, "Run JavaScript scripts that call the session's tools.", { exposure: "model-only" }));
  const reloaded = new DeferredToolManager(fixture.pi, () => "orchestrate");
  reloaded.register();
  reloaded.sessionStart(fixture.sessionIdentity);
  assert.ok(reloaded.authorizedToolNames()?.includes(CODEMODE_TOOL_NAME), "the retained wrapper intent authorizes the later registration");
  assert.equal(fixture.active().includes(CODEMODE_TOOL_NAME), false, "discovery only, never default activation");
  const load = await fixture.search()("late-load", { query: CODEMODE_TOOL_NAME });
  assert.deepEqual((load.details as { activated: string[] }).activated, [CODEMODE_TOOL_NAME]);
  assert.ok(reloaded.toolCallAllowed(CODEMODE_TOOL_NAME));
});

test("an explicit codemode registry restriction defeats the wrapper default (#224)", async () => {
  // --tools/--no-tools removed the name from the registry: the manager never
  // re-registers a builtin or forces an absent name into authority.
  const fixture = hostFixture({ omit: [CODEMODE_TOOL_NAME] });
  const manager = new DeferredToolManager(fixture.pi, () => "orchestrate", true);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  assert.equal(manager.authorizedToolNames()?.includes(CODEMODE_TOOL_NAME), false);
  assert.equal(fixture.active().includes(CODEMODE_TOOL_NAME), false);
  assert.equal(manager.toolCallAllowed(CODEMODE_TOOL_NAME), false);
  const search = await fixture.search()("restricted", { query: CODEMODE_TOOL_NAME });
  assert.deepEqual((search.details as { activated: string[] }).activated, []);
  assert.equal(guidanceListsName(manager, CODEMODE_TOOL_NAME), false);
  assert.doesNotMatch(searchDescription(fixture), /codemode/);
});

test("deferred-off capture runs full-active over the authorized set with no codemode exception (#224)", () => {
  const fixture = hostFixture();
  fixture.registerInactive(tool(CODEMODE_TOOL_NAME, "Run JavaScript scripts that call the session's tools.", { exposure: "model-only" }));
  const manager = new DeferredToolManager(fixture.pi, () => "orchestrate", true);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity, undefined, false, false);

  assert.deepEqual(fixture.active(), [
    "read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "WebSearch",
    CODEMODE_TOOL_NAME, DEFERRED_TOOL_SEARCH_NAME,
  ], "the authorized full set is active normally, including codemode");
  assert.ok(manager.toolCallAllowed(CODEMODE_TOOL_NAME));

  manager.reapply();
  assert.ok(fixture.active().includes(CODEMODE_TOOL_NAME), "reapply keeps the full-active set");
});

test("toolCallAllowed gates declared direct calls, nested native exposure, and unknown names (#224)", async () => {
  const fixture = hostFixture();
  fixture.registerInactive(tool("mcp__docs__search", "Search remote docs entries.", { exposure: "codemode" }));
  fixture.registerInactive(tool("NestedRunner", "Run a nested deferred operation.", { exposure: "deferred" }));
  fixture.registerInactive(tool("hidden_tool", "A hidden private tool.", { exposure: "hidden" }));
  fixture.pi.registerTool(tool("InteractiveOnly", "Ask an interactive question.", { exposure: "model-only" }));
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  // Baseline-declared direct tools, direct and nested.
  assert.ok(manager.toolCallAllowed("read"));
  assert.ok(manager.toolCallAllowed("read", true), "active direct tools stay script-callable");
  // Authorized but never declared: fail closed until search loads them.
  assert.equal(manager.toolCallAllowed("WebSearch"), false);
  assert.equal(manager.toolCallAllowed("WebSearch", true), false, "inactive direct tools are not natively script-callable");
  const load = await fixture.search()("load-web", { query: "WebSearch" });
  assert.deepEqual((load.details as { activated: string[] }).activated, ["WebSearch"]);
  assert.ok(manager.toolCallAllowed("WebSearch"));
  assert.ok(manager.toolCallAllowed("WebSearch", true));

  // Native codemode/deferred exposure: nested-callable while inactive, never
  // declared by the loader. A launch-active model-only tool is authorized like
  // any other launch-active tool and is declared only after search loading.
  assert.equal(manager.toolCallAllowed("InteractiveOnly"), false, "undeclared model-only tool fails closed until loaded");
  const loadOnly = await fixture.search()("load-only", { query: "InteractiveOnly" });
  assert.deepEqual((loadOnly.details as { activated: string[] }).activated, ["InteractiveOnly"]);
  assert.ok(manager.toolCallAllowed("InteractiveOnly"), "declared model-only tool is model-callable");
  assert.equal(manager.toolCallAllowed("InteractiveOnly", true), false, "model-only tools are never script-callable");
  assert.ok(manager.toolCallAllowed("mcp__docs__search", true));
  assert.ok(manager.toolCallAllowed("NestedRunner", true));
  assert.equal(manager.toolCallAllowed("mcp__docs__search"), false);
  assert.equal(manager.toolCallAllowed("NestedRunner"), false);

  // Unknown, hidden, blank, and capture-disabled names are never permitted.
  assert.equal(manager.toolCallAllowed("absent_unknown_tool"), false);
  assert.equal(manager.toolCallAllowed("hidden_tool"), false);
  assert.equal(manager.toolCallAllowed("hidden_tool", true), false);
  assert.equal(manager.toolCallAllowed(""), false);
  assert.equal(manager.toolCallAllowed("disabled_private"), false);
  assert.ok(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), "the loader is callable after a successful startup");
  assert.ok(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME, true), "the loader is script-callable after startup");
});

test("search_tools and tool calls fail closed before startup completes (#224)", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  assert.equal(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), false, "no startup captured yet");
  assert.equal(manager.toolCallAllowed("read"), false);

  assert.equal(manager.sessionStart(undefined), false, "fail-closed startup");
  assert.equal(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), false, "a failed startup leaves the loader blocked");
  assert.ok(manager.toolCallAllowed("read"), "the conservative retained set stays allowed");
  assert.ok(manager.toolCallAllowed("read", true));
  assert.ok(manager.toolCallAllowed("bash", true));
  assert.equal(manager.toolCallAllowed("WebSearch"), false, "non-conservative names are not trusted");
  assert.equal(manager.toolCallAllowed("new_private"), false);
  const search = await fixture.search()("unavailable", { query: "public web" });
  assert.equal(search.isError, true, "search remains unavailable on the failed capture");
});

test("plan-research disables codemode in catalog and callable gates (#224)", async () => {
  const fixture = hostFixture();
  fixture.registerInactive(tool(CODEMODE_TOOL_NAME, "Run JavaScript scripts that call the session's tools.", { exposure: "model-only" }));
  fixture.registerInactive(tool("mcp__docs__search", "Search remote docs entries.", { exposure: "codemode" }));
  let mode: OperatingMode = "orchestrate";
  const manager = new DeferredToolManager(fixture.pi, () => mode, true);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  const load = await fixture.search()("load-codemode", { query: CODEMODE_TOOL_NAME });
  assert.deepEqual((load.details as { activated: string[] }).activated, [CODEMODE_TOOL_NAME]);
  assert.ok(manager.toolCallAllowed(CODEMODE_TOOL_NAME));

  mode = "plan-research";
  manager.reapply();
  assert.equal(fixture.active().includes(CODEMODE_TOOL_NAME), false, "researchers have codemode disabled, not a restricted transport");
  assert.equal(manager.toolCallAllowed(CODEMODE_TOOL_NAME), false);
  assert.equal(manager.toolCallAllowed(CODEMODE_TOOL_NAME, true), false, "no researcher transport exception");
  assert.equal(guidanceListsName(manager, CODEMODE_TOOL_NAME), false);
  assert.doesNotMatch(searchDescription(fixture), /codemode/);
  const researchSearch = await fixture.search()("research-codemode", { query: CODEMODE_TOOL_NAME });
  assert.deepEqual((researchSearch.details as { matched: string[] }).matched, [], "codemode is excluded from the research catalog");

  // The read-only allow policy still governs nested callees; unknown MCP
  // tools are not presumed read-only; inactive direct tools are not callable.
  assert.ok(manager.toolCallAllowed("read", true), "read-only research callees stay permitted");
  assert.equal(manager.toolCallAllowed("bash", true), false, "write-capable names stay out of the read-only policy");
  assert.equal(manager.toolCallAllowed("mcp__docs__search"), false);
  assert.equal(manager.toolCallAllowed("mcp__docs__search", true), false, "unknown MCP tools are not presumed read-only");
  assert.equal(manager.toolCallAllowed("WebSearch", true), false, "inactive direct tools are not natively script-callable in research either");

  mode = "orchestrate";
  manager.reapply();
  assert.ok(fixture.active().includes(CODEMODE_TOOL_NAME), "search-activated codemode restores on the mode switch back");
  assert.ok(manager.toolCallAllowed(CODEMODE_TOOL_NAME));
});

test("a successful empty registry read makes every tool unavailable live (#224/review-0001)", async () => {
  // A successful read is authoritative: an empty registry collapses live
  // availability for both discovery and calls. Retained records stay
  // recoverable, so a healthy registry read re-adopts the authority.
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  await fixture.search()("load", { query: "public web" });
  assert.ok(fixture.active().includes("WebSearch"));
  assert.ok(manager.toolCallAllowed("WebSearch"));

  const healthyGetAllTools = fixture.pi.getAllTools;
  fixture.pi.getAllTools = () => [];
  const emptyRead = await fixture.search()("empty", { query: "public web" });
  assert.match(String((emptyRead.content as Array<{ text: string }>)[0]?.text), /No authorized tools matched/);
  assert.deepEqual(fixture.setCalls.at(-1), [], "no name — including the loader — is written while the live registry is empty");
  assert.deepEqual(fixture.active(), [], "the managed write collapses to nothing");
  assert.equal(manager.toolCallAllowed("WebSearch"), false, "an empty live registry denies even retained authority");
  assert.equal(manager.toolCallAllowed("read"), false, "all live calls are denied while the registry is empty");
  assert.equal(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), false, "the loader itself loses its registry entry");
  assert.equal(manager.startupGuidance(), undefined, "no inventory from a collapsed registry");
  assert.deepEqual(manager.authorizedToolNames(), [], "live authority collapses with the registry");

  // Recovery: a healthy read re-adopts the recorded withdrawals and the
  // baseline resumes; the pruned activation still requires search loading.
  fixture.pi.getAllTools = healthyGetAllTools;
  manager.reapply();
  assert.deepEqual(fixture.active(), ["read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart", "search_tools"], "the baseline resumes on re-enable");
  assert.equal(manager.toolCallAllowed("WebSearch"), false, "the pruned activation does not silently return");
  const recovered = await fixture.search()("recover", { query: "public web" });
  assert.deepEqual((recovered.details as { activated: string[] }).activated, ["WebSearch"]);
  assert.ok(manager.toolCallAllowed("WebSearch"));
});

test("an unreadable registry denies live discovery and calls while retaining the boundary (#224/review-0001)", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  await fixture.search()("load", { query: "public web" });
  assert.ok(fixture.active().includes("WebSearch"));
  const retained = manager.authorizedToolNames();
  assert.ok(retained?.includes("WebSearch"));

  const healthyGetAllTools = fixture.pi.getAllTools;
  fixture.pi.getAllTools = () => {
    throw new Error("registry read failed");
  };
  assert.deepEqual(manager.authorizedToolNames(), [], "unreadable dynamic authority is not returned to live consumers");
  assert.equal(manager.toolCallAllowed("WebSearch"), false, "live calls are denied");
  assert.equal(manager.toolCallAllowed("read"), false);
  assert.equal(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), false, "the loader is not callable while the registry is unreadable");
  assert.equal(manager.startupGuidance(), undefined, "no discovery inventory is disclosed");
  const deniedSearch = await fixture.search()("denied", { query: "public web" });
  assert.equal(deniedSearch.isError, true, "live discovery is denied");
  assert.match(String((deniedSearch.content as Array<{ text: string }>)[0]?.text), /unavailable/);
  assert.deepEqual(
    fixture.active(),
    ["read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart", "search_tools", "WebSearch"],
    "the retained active set is neither widened nor thrashed while no write runs",
  );

  // The unreadable state produces no managed write: retained authority is
  // preserved separately from the write, and reapply writes nothing.
  manager.reapply();
  assert.deepEqual(fixture.setCalls.at(-1), [], "an unreadable registry write is empty");
  assert.deepEqual(fixture.active(), []);

  // Recovery: an authoritative read restores normal live behavior.
  fixture.pi.getAllTools = healthyGetAllTools;
  manager.reapply();
  assert.deepEqual(
    fixture.setCalls.at(-1),
    ["read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart", "search_tools", "WebSearch"],
    "the authoritative read restores the whole retained loadout",
  );
  assert.ok(manager.toolCallAllowed("WebSearch"), "recovery restores live permission");
  assert.ok(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME));
  assert.equal(manager.startupGuidance()?.includes("WebSearch"), true);
});

test("capture-time exclusions stay excluded across reconnect and empty-registry recovery (#224)", async () => {
  const fixture = hostFixture();
  fixture.registerInactive(tool("hidden_at_capture", "A restricted hidden tool.", { exposure: "hidden" }));
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  assert.equal(manager.authorizedToolNames()?.includes("disabled_private"), false);
  assert.equal(manager.authorizedToolNames()?.includes("hidden_at_capture"), false);

  // Reconnecting an entry that was already present but disabled at capture is
  // not a newly authorized host registration. A capture-time hidden exposure
  // is likewise not a deferred withdrawal that grants on later visibility.
  fixture.removeFromRegistry("disabled_private");
  manager.reapply();
  fixture.pi.registerTool(tool("disabled_private", "Search a private disabled service."));
  fixture.pi.registerTool(tool("hidden_at_capture", "A restricted hidden tool."));
  manager.reapply();
  assert.equal(fixture.active().includes("disabled_private"), false);
  assert.equal(fixture.active().includes("hidden_at_capture"), false);
  assert.equal(manager.authorizedToolNames()?.includes("disabled_private"), false);
  assert.equal(manager.authorizedToolNames()?.includes("hidden_at_capture"), false);
  assert.equal(manager.toolCallAllowed("disabled_private"), false);
  assert.equal(manager.toolCallAllowed("hidden_at_capture"), false);
  const excluded = await fixture.search()("excluded", { query: "private disabled" });
  assert.deepEqual((excluded.details as { matched: string[] }).matched, []);

  // An authoritative empty read withdraws live entries, but recovery restores
  // only prior authority/default intent; it cannot forget launch exclusions.
  const healthyGetAllTools = fixture.pi.getAllTools;
  fixture.pi.getAllTools = () => [];
  manager.reapply();
  fixture.pi.getAllTools = healthyGetAllTools;
  manager.reapply();
  assert.equal(manager.authorizedToolNames()?.includes("disabled_private"), false);
  assert.equal(manager.authorizedToolNames()?.includes("hidden_at_capture"), false);
  assert.equal(manager.toolCallAllowed("disabled_private"), false);
  assert.equal(manager.toolCallAllowed("hidden_at_capture"), false);
});

test("first registry recovery establishes a baseline instead of adopting unknown stale names (#224)", () => {
  const fixture = hostFixture();
  const healthyGetAllTools = fixture.pi.getAllTools;
  fixture.pi.getAllTools = () => {
    throw new Error("registry unavailable during startup");
  };
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  assert.equal(manager.sessionStart(fixture.sessionIdentity), true);
  assert.deepEqual(manager.authorizedToolNames(), [], "an unreadable registry exposes no live dynamic catalog");
  assert.equal(manager.toolCallAllowed("read"), false);

  // Names observed only after recovery cannot be distinguished from entries
  // that were already restricted during the outage, so the first healthy read
  // establishes a non-adopting baseline. Later registrations are dynamic.
  fixture.registerInactive(tool("registered_during_outage", "A name first observed during recovery."));
  fixture.pi.getAllTools = healthyGetAllTools;
  manager.reapply();
  assert.ok(manager.toolCallAllowed("read"), "captured launch authority recovers");
  assert.equal(manager.authorizedToolNames()?.includes("registered_during_outage"), false);

  fixture.pi.registerTool(tool("registered_after_recovery", "A newly permitted registration after recovery."));
  manager.reapply();
  assert.ok(manager.authorizedToolNames()?.includes("registered_after_recovery"));
  assert.equal(fixture.active().includes("registered_after_recovery"), false, "late authority stays deferred until search loads it");
});

test("an empty launch set legitimately captures an empty boundary (#224)", async () => {
  const fixture = hostFixture();
  const emptyPi = {
    registerTool: (definition: RegisteredTool) => fixture.pi.registerTool(definition),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
  };
  const failingManager = new DeferredToolManager(emptyPi);
  failingManager.register();
  assert.equal(failingManager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), false, "no capture, no loader permission");
  assert.equal(failingManager.sessionStart({}), true, "an empty launch set legitimately captures an empty boundary");
  assert.deepEqual(failingManager.authorizedToolNames(), []);
  assert.equal(fixture.active().includes("search_tools"), true);
});

test("configured worker withdrawal prunes loaded selections and restoration requires loading (#224/review-0002)", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  assert.equal(manager.sessionStart(fixture.sessionIdentity, {
    allowedToolCatalog: ["read", "WebSearch"],
    initialActiveTools: ["read"],
  }), true);
  const loaded = await fixture.search()("load", { query: "public web" });
  assert.deepEqual((loaded.details as { activated: string[] }).activated, ["WebSearch"]);
  assert.ok(fixture.active().includes("WebSearch"));

  // Registry-side withdrawal of a loaded worker selection: the frozen ceiling
  // stays, but the managed write excludes the withdrawn name and calls are
  // denied; the search outcome degrades with the registry.
  fixture.removeFromRegistry("WebSearch");
  manager.reapply();
  assert.equal(fixture.active().includes("WebSearch"), false);
  assert.deepEqual(fixture.setCalls.at(-1), ["read", "search_tools"], "the managed write intersects live availability");
  assert.equal(manager.toolCallAllowed("WebSearch"), false, "a withdrawn selection cannot claim activation");
  const gone = await fixture.search()("gone", { query: "public web" });
  assert.match(JSON.stringify(gone), /No authorized tools matched/);

  // Hidden withdrawal behaves identically.
  fixture.pi.registerTool(tool("WebSearch", "Search the public web for current sources.", { exposure: "hidden" }));
  manager.reapply();
  assert.equal(fixture.active().includes("WebSearch"), false);
  assert.deepEqual(fixture.setCalls.at(-1), ["read", "search_tools"]);
  assert.equal(manager.toolCallAllowed("WebSearch"), false);

  // Restoration inside the resumed immutable ceiling: the previously loaded
  // selection is not silently reactivated — search must load it again.
  fixture.pi.registerTool(tool("WebSearch", "Search the public web for current sources."));
  assert.equal(manager.toolCallAllowed("WebSearch"), false, "not declared until loaded again");
  const restored = await fixture.search()("restore", { query: "public web" });
  assert.deepEqual((restored.details as { activated: string[] }).activated, ["WebSearch"], "restoration requires loading");
  assert.ok(fixture.active().includes("WebSearch"));
  assert.ok(manager.toolCallAllowed("WebSearch"));
  assert.deepEqual(manager.authorizedToolNames(), ["read", "WebSearch"], "the worker ceiling never changed");
});

test("a withdrawn baseline tool resumes its normal baseline on permitted re-enable (#224/review-0002)", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  assert.ok(fixture.active().includes("bash"));

  fixture.removeFromRegistry("bash");
  manager.reapply();
  assert.equal(fixture.active().includes("bash"), false, "withdrawal prunes the baseline activation too");
  assert.deepEqual(fixture.setCalls.at(-1), ["read", "edit", "write", "ApplyPatch", "SubtasksStart", "search_tools"]);
  assert.equal(manager.toolCallAllowed("bash"), false);

  fixture.pi.registerTool(tool("bash", "Execute a shell command."));
  manager.reapply();
  assert.ok(fixture.active().includes("bash"), "permitted re-enable resumes the normal baseline");
  assert.ok(fixture.setCalls.at(-1)?.includes("bash"), "the resumed baseline is written");
  assert.ok(manager.toolCallAllowed("bash"));
});

test("search_tools is callable only while currently registered, selected, and exposure-legal (#224/review-0003)", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  const loader = fixture.definitions.find((definition) => definition.name === DEFERRED_TOOL_SEARCH_NAME)!;
  assert.ok(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME));
  assert.ok(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME, true), "a direct-exposure loader stays script-callable while declared");

  // Registry-side removal of the loader.
  fixture.removeFromRegistry(DEFERRED_TOOL_SEARCH_NAME);
  assert.equal(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), false, "an absent loader is not callable");
  assert.equal(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME, true), false);

  // Hidden replacement.
  fixture.pi.registerTool({ name: DEFERRED_TOOL_SEARCH_NAME, description: "Activate authorized tools.", exposure: "hidden", parameters: {} });
  assert.equal(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), false, "a hidden replacement is not callable");
  fixture.pi.registerTool(tool("late_after_hidden_loader", "A late registration changes the discovery description."));
  manager.reapply();
  assert.equal(
    fixture.definitions.find((definition) => definition.name === DEFERRED_TOOL_SEARCH_NAME)?.exposure,
    "hidden",
    "description refresh must not replace a hidden loader registration",
  );
  assert.equal(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), false);

  // Deselection: while the manager's own selection still contains the loader,
  // the gate answers from the declared selection and the next write reasserts.
  fixture.pi.registerTool(loader);
  fixture.pi.setActiveTools(fixture.active().filter((name) => name !== DEFERRED_TOOL_SEARCH_NAME));
  assert.equal(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), false, "a deselected loader is not callable");
  manager.reapply();
  assert.ok(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), "the managed selection reasserts the loader");

  // A model-only replacement keeps the loader model-callable while declared
  // but never script-callable.
  fixture.pi.registerTool({ ...loader, exposure: "model-only" });
  assert.ok(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), "a declared model-only loader is model-callable");
  assert.equal(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME, true), false, "a model-only loader is never script-callable");

  // Native-callable replacement exposures do not waive the selected
  // requirement for the loader itself: replace its exposure, deselect it, and
  // both call modes are denied until the manager reasserts the selection.
  fixture.pi.registerTool({ ...loader, exposure: "codemode" });
  fixture.pi.registerTool({ ...loader, exposure: "deferred" });
  fixture.pi.setActiveTools(fixture.active().filter((name) => name !== DEFERRED_TOOL_SEARCH_NAME));
  assert.equal(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), false, "a deselected loader is not callable");
  assert.equal(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME, true), false, "codemode and deferred replacements do not bypass the selected check");
  manager.reapply();
  assert.ok(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), "the managed selection reasserts the loader again");
  assert.ok(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME, true), "a selected loader is callable in both modes");
});

test("failed startup applies the read-only mode policy to the retained set (#224/review-0004)", async () => {
  const fixture = hostFixture();
  let mode: OperatingMode = "plan-research";
  const manager = new DeferredToolManager(fixture.pi, () => mode);
  manager.register();
  assert.equal(manager.sessionStart(undefined), false, "fail-closed startup");

  // The conservative fallback write applies the plan/research ceiling even
  // though no boundary was captured: write-capable tools never go live.
  assert.deepEqual(fixture.setCalls.at(-1), ["read"], "only permitted read-only baseline tools are written");
  assert.deepEqual(fixture.active(), ["read"]);
  assert.ok(manager.toolCallAllowed("read"));
  assert.ok(manager.toolCallAllowed("read", true));
  for (const name of ["bash", "edit", "write", "ApplyPatch", "SubtasksStart"]) {
    assert.equal(manager.toolCallAllowed(name), false, `${name} direct call is rejected in read-only mode`);
    assert.equal(manager.toolCallAllowed(name, true), false, `${name} nested call is rejected in read-only mode`);
    assert.equal(fixture.active().includes(name), false);
  }
  assert.equal(manager.toolCallAllowed(DEFERRED_TOOL_SEARCH_NAME), false, "a failed startup leaves the loader blocked");

  // Switching back to a write-capable mode resumes the retained set.
  mode = "orchestrate";
  manager.reapply();
  assert.ok(fixture.active().includes("bash"), "the retained conservative set resumes in a write mode");
});

test("failed-startup writes intersect live availability (#224/review-0002)", async () => {
  const fixture = hostFixture();
  const manager = new DeferredToolManager(fixture.pi);
  manager.register();
  assert.equal(manager.sessionStart(undefined), false, "fail-closed startup");
  const conservative = ["read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart"];
  assert.deepEqual(fixture.setCalls.at(-1), conservative, "the conservative retained set is written while the registry is healthy");
  assert.ok(manager.toolCallAllowed("bash", true));

  // A baseline tool removed from the registry drops out of the next write.
  fixture.removeFromRegistry("bash");
  manager.reapply();
  assert.deepEqual(fixture.setCalls.at(-1), ["read", "edit", "write", "ApplyPatch", "SubtasksStart"], "the removed name no longer enters the managed write");
  assert.equal(manager.toolCallAllowed("bash"), false, "a removed baseline name is not callable");

  // A hidden-replaced baseline tool is equally unavailable to the write.
  fixture.pi.registerTool(tool("edit", "Make precise edits to a file.", { exposure: "hidden" }));
  manager.reapply();
  assert.deepEqual(fixture.setCalls.at(-1), ["read", "write", "ApplyPatch", "SubtasksStart"], "a hidden baseline name is unavailable to the write");

  // Removing every remaining conservative name produces no write at all.
  for (const name of ["read", "write", "ApplyPatch", "SubtasksStart"]) {
    fixture.removeFromRegistry(name);
  }
  manager.reapply();
  assert.deepEqual(fixture.setCalls.at(-1), [], "no unavailable name is written");

  // Recovery restores the full conservative write from the retained set.
  for (const name of ["read", "bash", "edit", "write", "ApplyPatch", "SubtasksStart"]) {
    fixture.pi.registerTool(tool(name, `${name} tool restored description.`));
  }
  manager.reapply();
  assert.deepEqual(fixture.setCalls.at(-1), conservative, "recovery restores the conservative write");
  assert.ok(manager.toolCallAllowed("bash", true));
});

test("a malformed worker bootstrap fails closed under the read-only mode policy (#224/review-0004)", async () => {
  const fixture = hostFixture({ disabled: ["WebSearch"] });
  let mode: OperatingMode = "plan-research";
  const manager = new DeferredToolManager(fixture.pi, () => mode);
  manager.register();
  // The durable catalog is broken: WebSearch is launch-inactive while the
  // startup-active contract promises it, so the entire capture fails closed.
  assert.equal(manager.sessionStart(fixture.sessionIdentity, {
    allowedToolCatalog: ["read", "WebSearch"],
    initialActiveTools: ["read", "WebSearch"],
  }), false, "a broken bootstrap fails closed regardless of mode");
  assert.equal(manager.authorizedToolNames(), undefined);

  // The mode policy still governs the retained conservative fallback.
  assert.deepEqual(fixture.setCalls.at(-1), ["read"]);
  assert.ok(manager.toolCallAllowed("read"));
  assert.equal(manager.toolCallAllowed("bash"), false);
  assert.equal(manager.toolCallAllowed("bash", true), false, "plan/research rejects nested write-capable callees after failed startup");
  assert.equal(fixture.active().includes("write"), false);
});

test("plan-research has all MCP tools off by default, across exposures and late registration (#224)", async () => {
  const fixture = hostFixture();
  fixture.registerInactive(tool("mcp__docs__search", "Search remote docs entries.", { exposure: "codemode" }));
  fixture.registerInactive(tool("mcp__docs__load", "Load a deferred remote doc.", { exposure: "deferred" }));
  fixture.pi.registerTool(tool("mcp__direct__read", "Read a direct remote resource.", { exposure: "direct" }));
  let mode: OperatingMode = "orchestrate";
  const manager = new DeferredToolManager(fixture.pi, () => mode);
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);

  // Registered MCP tools are authorized/usable within their exposure rules in
  // write modes (script-callable nested; an undeclared direct tool is
  // search-first like any tool).
  assert.ok(manager.toolCallAllowed("mcp__docs__search", true), "codemode-exposure MCP stays script-callable in write modes");
  assert.ok(manager.toolCallAllowed("mcp__docs__load", true));
  assert.equal(manager.toolCallAllowed("mcp__direct__read"), false);
  const preSearch = await fixture.search()("pre", { query: "mcp__direct__read" });
  assert.deepEqual((preSearch.details as { activated: string[] }).activated, ["mcp__direct__read"]);
  assert.ok(manager.toolCallAllowed("mcp__direct__read"), "declared direct MCP tool is callable in write modes");

  mode = "plan-research";
  manager.reapply();
  // All MCP tools are off in research by default: absent from the declared
  // set, the inventory, the search catalog, and both callable gates — no
  // exposure class, native deferral, or annotation re-admits them.
  for (const name of ["mcp__docs__search", "mcp__docs__load", "mcp__direct__read"]) {
    assert.equal(fixture.active().includes(name), false, `${name} is not declared in research`);
    assert.equal(manager.toolCallAllowed(name), false, `${name} direct call is rejected in research`);
    assert.equal(manager.toolCallAllowed(name, true), false, `${name} nested call is rejected in research`);
    assert.equal(guidanceListsName(manager, name), false, `${name} is absent from the research inventory`);
    const search = await fixture.search()("mcp-off", { query: name });
    assert.deepEqual((search.details as { matched: string[] }).matched, [], `${name} is absent from the research catalog`);
  }

  // Late registration and reconnect stay off in research.
  fixture.registerInactive(tool("mcp__late__tool", "A late registered entry.", { exposure: "codemode" }));
  manager.reapply();
  assert.equal(fixture.active().includes("mcp__late__tool"), false);
  assert.equal(manager.toolCallAllowed("mcp__late__tool", true), false);
  assert.equal(guidanceListsName(manager, "mcp__late__tool"), false);
  fixture.removeFromRegistry("mcp__docs__search");
  fixture.registerInactive(tool("mcp__docs__search", "Search remote docs entries.", { exposure: "codemode" }));
  manager.reapply();
  assert.equal(manager.toolCallAllowed("mcp__docs__search", true), false, "a reconnect does not re-admit MCP tools in research");
  assert.equal(fixture.active().includes("mcp__docs__search"), false);

  // Leaving research restores each tool's ordinary rules.
  mode = "orchestrate";
  manager.reapply();
  assert.ok(manager.toolCallAllowed("mcp__docs__search", true), "codemode-exposure MCP is script-callable again");
  assert.ok(manager.toolCallAllowed("mcp__docs__load", true));
  assert.ok(manager.toolCallAllowed("mcp__direct__read"), "the search-declared direct MCP tool restores");
  assert.equal(fixture.active().includes("mcp__docs__search"), false, "codemode exposure is still never promoted to declaration");
});

function searchDescription(fixture: ReturnType<typeof hostFixture>): string {
  const registered = fixture.definitions.find((definition) => definition.name === "search_tools");
  assert.ok(registered);
  return registered.description ?? "";
}

function searchSnippet(fixture: ReturnType<typeof hostFixture>): string {
  const registered = fixture.definitions.find((definition) => definition.name === "search_tools");
  assert.ok(registered);
  return registered.promptSnippet ?? "";
}

/** Whether the startup inventory currently lists a tool name with its purpose. */
function guidanceListsName(manager: DeferredToolManager, name: string): boolean {
  return (manager.startupGuidance() ?? "").includes(`"${name}" (`);
}

/** Render a search_tools card through the registered renderer with a fixed test theme. */
function renderSearchCards(
  card: RegisteredTool,
  value: unknown,
  expanded: boolean,
): string {
  assert.ok(card.renderResult);
  const theme = { bold: (part: string) => part, fg: (_color: string, part: string) => part };
  const component = card.renderResult(value, { expanded, isPartial: false }, theme, {
    args: { query: "mcp__docs__search DeferredRunner" },
  }) as { render(width: number): string[] };
  assert.ok(typeof component.render === "function");
  return component.render(200).join("\n");
}
