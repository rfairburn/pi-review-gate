import assert from "node:assert/strict";
import test from "node:test";
import type { OperatingMode } from "../src/config";
import { DeferredToolManager } from "../src/deferred-tools";
import {
  isNativePowerShellBuiltinEntry,
  probeNativePowerShellHostSupport,
} from "../src/native-powershell-support";

/**
 * #421/#94: historical shell parity with native PowerShell host support.
 *
 * Pi 1.3 registers its builtin `powershell` on every platform but can only
 * run it on Windows with `pwsh.exe` or `powershell.exe` available. Wherever
 * the host genuinely supports it, the builtin is treated exactly like `bash`
 * (both baseline, both in a new worker's initial subset); where it does not,
 * the builtin is withheld from top-level authority. Only Pi's own builtin —
 * identified by the public `getAllTools()` `sourceInfo` provenance — is
 * gated: extension/SDK tools that share the name are never filtered by name.
 *
 * Host support is injected here (simulated boundaries); the real probe runs
 * natively in the platform-conditional cases at the bottom, which the
 * Windows shell CI job executes on native Windows. This file deliberately
 * starts no process, worktree, or subtask so it stays safe to run there; the
 * new-worker catalog cases live in shell-tool-parity.test.ts.
 */

interface RegisteredTool {
  name: string;
  description: string;
  exposure?: string;
  sourceInfo?: Record<string, unknown>;
}

const builtin = (name: string): Record<string, unknown> => ({
  path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level",
});

function nativeTool(name: string): RegisteredTool {
  return { name, description: `${name} tool.`, sourceInfo: builtin(name) };
}

const extensionPowerShell: RegisteredTool = {
  name: "powershell",
  description: "Extension-provided PowerShell tool.",
  sourceInfo: { path: "/synthetic/extensions/remote-shell.ts", source: "local", scope: "project", origin: "top-level" },
};

const sdkPowerShell: RegisteredTool = {
  name: "powershell",
  description: "SDK custom PowerShell tool.",
  sourceInfo: { path: "<sdk:powershell>", source: "sdk", scope: "temporary", origin: "top-level" },
};

const BASE = ["read", "grep", "find", "ls", "edit", "write", "ApplyPatch", "SubtasksStart", "WebSearch"];

/** Fake Pi host: `registry` is what getAllTools reports; `active` the restored/declared set. */
function host(registry: RegisteredTool[], active: string[] = registry.map((tool) => tool.name)) {
  const definitions = [...registry];
  let current = [...active];
  const pi = {
    registerTool(definition: RegisteredTool) {
      const index = definitions.findIndex((candidate) => candidate.name === definition.name);
      if (index >= 0) definitions.splice(index, 1, definition);
      else definitions.push(definition);
      if (!current.includes(definition.name)) current.push(definition.name);
    },
    getActiveTools: () => [...current],
    getAllTools: () => [...definitions],
    setActiveTools(names: string[]) { current = [...names]; },
  };
  const search = async (query: string): Promise<Record<string, any>> => {
    const loader = definitions.find((tool) => tool.name === "tool_search") as
      | { execute?: (id: string, params: unknown) => Promise<Record<string, any>> }
      | undefined;
    assert.ok(loader?.execute, "tool_search must be registered");
    return loader.execute("native-powershell", { query });
  };
  return { pi, sessionIdentity: {}, active: () => [...current], definitions, search };
}

function countingProbe(answer: boolean | (() => boolean)) {
  const state = { calls: 0 };
  const probe = () => {
    state.calls += 1;
    return typeof answer === "function" ? answer() : answer;
  };
  return { probe, state };
}

function topLevel(registry: RegisteredTool[], supported: boolean | (() => boolean), mode: () => OperatingMode = () => "execute") {
  const fixture = host(registry);
  const counter = countingProbe(supported);
  const manager = new DeferredToolManager(fixture.pi, mode, () => true, counter.probe);
  manager.register();
  assert.equal(manager.sessionStart(fixture.sessionIdentity), true);
  return { fixture, manager, probe: counter.state };
}

test("provenance identifies only Pi's own powershell builtin", () => {
  assert.equal(isNativePowerShellBuiltinEntry(nativeTool("powershell")), true);
  assert.equal(isNativePowerShellBuiltinEntry(nativeTool("bash")), false, "only the powershell builtin is subject to the host gate");
  assert.equal(isNativePowerShellBuiltinEntry(extensionPowerShell), false);
  assert.equal(isNativePowerShellBuiltinEntry(sdkPowerShell), false);
  assert.equal(isNativePowerShellBuiltinEntry({ name: "powershell", description: "" }), false, "undisclosed provenance is not provably native");
  assert.equal(isNativePowerShellBuiltinEntry({ name: "powershell", sourceInfo: { source: "builtin", path: "builtin:bash" } }), false);
  assert.equal(isNativePowerShellBuiltinEntry({ name: "powershell", sourceInfo: { source: "local", path: "builtin:powershell" } }), false);
  assert.equal(isNativePowerShellBuiltinEntry(null), false);
});

test("the host probe follows Pi's contract: Windows only, pwsh.exe then powershell.exe", () => {
  const lookups: string[] = [];
  const finder = (found: Record<string, string>) => (executable: string) => {
    lookups.push(executable);
    return found[executable] ?? null;
  };
  for (const platform of ["darwin", "linux", "freebsd"] as NodeJS.Platform[]) {
    assert.equal(probeNativePowerShellHostSupport(platform, finder({ "pwsh.exe": "C:\\pwsh.exe" })), false);
  }
  assert.deepEqual(lookups, [], "non-Windows hosts never spawn a lookup");
  assert.equal(probeNativePowerShellHostSupport("win32", finder({ "pwsh.exe": "C:\\pwsh.exe" })), true);
  assert.deepEqual(lookups.splice(0), ["pwsh.exe"]);
  assert.equal(probeNativePowerShellHostSupport("win32", finder({ "powershell.exe": "C:\\powershell.exe" })), true);
  assert.deepEqual(lookups.splice(0), ["pwsh.exe", "powershell.exe"]);
  assert.equal(probeNativePowerShellHostSupport("win32", finder({})), false, "no interpreter on PATH is unavailable");
  assert.equal(probeNativePowerShellHostSupport("win32", () => { throw new Error("where failed"); }), false);
});

test("supported native host: bash-only, powershell-only, and both keep historical baseline parity", () => {
  const both = topLevel([...BASE.map(nativeTool), nativeTool("bash"), nativeTool("powershell")], true);
  assert.ok(both.fixture.active().includes("bash"));
  assert.ok(both.fixture.active().includes("powershell"), "a supported powershell beside bash is baseline (no Bash-first selection)");
  assert.ok(both.manager.authorizedToolNames()?.includes("powershell"));
  assert.ok(both.manager.toolCallAllowed("powershell"));

  const only = topLevel([...BASE.map(nativeTool), nativeTool("powershell")], true);
  assert.ok(only.fixture.active().includes("powershell"));
  assert.equal(only.fixture.active().includes("bash"), false);

  // Bash-only registry: no probe at all, no synthesized powershell.
  const bashOnly = topLevel([...BASE.map(nativeTool), nativeTool("bash")], () => { throw new Error("must not probe"); });
  assert.equal(bashOnly.probe.calls, 0, "no native builtin registered, no host probe");
  assert.ok(bashOnly.fixture.active().includes("bash"));
  assert.equal(bashOnly.manager.authorizedToolNames()?.includes("powershell"), false);
});

test("unsupported or unavailable native powershell is withheld everywhere while bash and the rest stay intact", async () => {
  const both = topLevel([...BASE.map(nativeTool), nativeTool("bash"), nativeTool("powershell")], false);
  assert.deepEqual(both.fixture.active(), ["read", "grep", "find", "ls", "bash", "edit", "write", "ApplyPatch", "SubtasksStart", "tool_search"]);
  assert.equal(both.manager.authorizedToolNames()?.includes("powershell"), false);
  assert.equal(both.manager.isToolDiscoveryEligible("powershell"), false);
  assert.equal(both.manager.toolCallAllowed("powershell"), false);
  assert.doesNotMatch(both.manager.startupGuidance() ?? "", /"powershell"/);
  assert.ok(both.manager.isToolDiscoveryEligible("WebSearch"), "unrelated candidates are unaffected");
  const searched = await both.fixture.search("powershell");
  assert.deepEqual(searched.details.matched, [], "a withheld builtin is not matchable");
  assert.equal(both.fixture.active().includes("powershell"), false);

  // A restored transcript that declared the builtin grants nothing either.
  const restored = host([...BASE.map(nativeTool), nativeTool("bash"), nativeTool("powershell")], ["read", "powershell"]);
  const restoredManager = new DeferredToolManager(restored.pi, () => "execute", () => true, () => false);
  restoredManager.register();
  restoredManager.sessionStart(restored.sessionIdentity);
  assert.equal(restored.active().includes("powershell"), false);

  // Powershell-only registry on an unsupported host: no shell is invented.
  const only = topLevel([...BASE.map(nativeTool), nativeTool("powershell")], false);
  assert.equal(only.fixture.active().includes("powershell"), false);
  assert.equal(only.fixture.active().includes("bash"), false);

  // A throwing probe counts as unsupported.
  const throwing = topLevel([...BASE.map(nativeTool), nativeTool("bash"), nativeTool("powershell")], () => { throw new Error("probe failed"); });
  assert.equal(throwing.manager.authorizedToolNames()?.includes("powershell"), false);
});

test("extension, SDK, and undisclosed-provenance tools named powershell are never filtered by name", () => {
  for (const [label, entry] of [
    ["extension", extensionPowerShell],
    ["sdk", sdkPowerShell],
    ["undisclosed provenance", { name: "powershell", description: "powershell tool." }],
  ] as const) {
    const fixture = topLevel([...BASE.map(nativeTool), nativeTool("bash"), entry], () => { throw new Error(`${label} must not probe`); });
    assert.equal(fixture.probe.calls, 0, `${label}: no native builtin, no probe`);
    assert.ok(fixture.manager.authorizedToolNames()?.includes("powershell"), `${label}: stays authorized`);
    assert.ok(fixture.fixture.active().includes("powershell"), `${label}: keeps shell parity with bash`);
  }
});

test("the host probe runs at most once per refresh: session start and real mode transitions, never per reconcile", async () => {
  let mode: OperatingMode = "execute";
  let supported = true;
  const fixture = topLevel([...BASE.map(nativeTool), nativeTool("bash"), nativeTool("powershell")], () => supported, () => mode);
  assert.equal(fixture.probe.calls, 1);
  for (let index = 0; index < 5; index += 1) {
    fixture.manager.reapply();
    fixture.manager.authorizedToolNames();
    fixture.manager.isToolDiscoveryEligible("powershell");
    fixture.manager.startupGuidance();
    fixture.manager.toolCallAllowed("powershell");
  }
  await fixture.fixture.search("WebSearch");
  assert.equal(fixture.probe.calls, 1, "reconciliations reuse the cached answer");

  // Availability changes are adopted only at a refresh seam.
  supported = false;
  fixture.manager.reapply();
  assert.ok(fixture.fixture.active().includes("powershell"), "no refresh seam yet");
  mode = "plan-research";
  fixture.manager.refreshNativeHostSupport();
  fixture.manager.reapply();
  assert.equal(fixture.probe.calls, 2);
  mode = "execute";
  fixture.manager.refreshNativeHostSupport();
  fixture.manager.reapply();
  assert.equal(fixture.probe.calls, 3);
  assert.equal(fixture.fixture.active().includes("powershell"), false, "the refreshed answer withholds the builtin");
  assert.equal(fixture.manager.authorizedToolNames()?.includes("powershell"), false);

  // A new session start re-probes.
  supported = true;
  fixture.manager.sessionStart({});
  assert.equal(fixture.probe.calls, 4);
  assert.ok(fixture.fixture.active().includes("powershell"));
});

test("Plan/research round trip removes both shells and restores both on a supported host", async () => {
  let mode: OperatingMode = "orchestrate";
  const fixture = topLevel([...BASE.map(nativeTool), nativeTool("bash"), nativeTool("powershell")], true, () => mode);
  assert.ok(fixture.fixture.active().includes("bash") && fixture.fixture.active().includes("powershell"));

  mode = "plan-research";
  fixture.manager.refreshNativeHostSupport();
  fixture.manager.reapply();
  for (const name of ["bash", "powershell"]) {
    assert.equal(fixture.fixture.active().includes(name), false, `${name} is removed in plan/research`);
    assert.equal(fixture.manager.isToolDiscoveryEligible(name), false);
    assert.deepEqual((await fixture.fixture.search(name)).details.matched, [], `${name} is unmatchable in research`);
  }

  mode = "execute";
  fixture.manager.refreshNativeHostSupport();
  fixture.manager.reapply();
  assert.ok(fixture.fixture.active().includes("bash"));
  assert.ok(fixture.fixture.active().includes("powershell"), "leaving research rebuilds both shells from the live registry");
});

test("explicit native exclusions stay authoritative even on a supported host", () => {
  // `--exclude-tools powershell` removes the builtin from Pi's registry.
  const excluded = topLevel([...BASE.map(nativeTool), nativeTool("bash")], true);
  assert.equal(excluded.manager.authorizedToolNames()?.includes("powershell"), false);
  assert.equal(excluded.fixture.active().includes("powershell"), false);
  // `--exclude-tools bash` on a supported host leaves powershell as the only shell.
  const noBash = topLevel([...BASE.map(nativeTool), nativeTool("powershell")], true);
  assert.equal(noBash.manager.authorizedToolNames()?.includes("bash"), false);
  assert.ok(noBash.fixture.active().includes("powershell"));
});

test("existing worker ceilings stay immutable: a frozen catalog naming powershell never consults the host gate", () => {
  const fixture = host([nativeTool("read"), nativeTool("bash"), nativeTool("powershell")], ["read", "bash", "powershell", "tool_search"]);
  const counter = countingProbe(false);
  const manager = new DeferredToolManager(fixture.pi, () => "execute", () => true, counter.probe);
  manager.register();
  assert.equal(manager.sessionStart(fixture.sessionIdentity, {
    allowedToolCatalog: ["read", "bash", "powershell"],
    initialActiveTools: ["read", "bash", "powershell"],
  }, true), true);
  assert.equal(counter.state.calls, 0, "frozen ceilings are not re-derived from host support");
  assert.deepEqual(manager.authorizedToolNames(), ["read", "bash", "powershell"]);
  assert.deepEqual(fixture.active(), ["read", "bash", "powershell", "tool_search"]);
});

// --- Real host probe (native on whichever platform runs the suite) -----------

test("the real host probe reports Pi's native PowerShell boundary for this platform", { skip: process.platform === "win32" }, () => {
  // Non-Windows: Pi's getPowerShellConfig throws outside win32, so the
  // builtin is unsupported regardless of any pwsh installation.
  assert.equal(probeNativePowerShellHostSupport(), false);
  const fixture = host([...BASE.map(nativeTool), nativeTool("bash"), nativeTool("powershell")]);
  const manager = new DeferredToolManager(fixture.pi, () => "execute");
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  assert.equal(manager.authorizedToolNames()?.includes("powershell"), false);
  assert.ok(fixture.active().includes("bash"));
});

test("native Windows PowerShell host support keeps both-shell parity with the default probe", { skip: process.platform !== "win32" }, () => {
  // Windows ships Windows PowerShell (powershell.exe) on PATH; GitHub's
  // windows runners also carry pwsh.exe. The default probe must find one.
  assert.equal(probeNativePowerShellHostSupport(), true);
  const fixture = host([...BASE.map(nativeTool), nativeTool("bash"), nativeTool("powershell")]);
  const manager = new DeferredToolManager(fixture.pi, () => "execute");
  manager.register();
  manager.sessionStart(fixture.sessionIdentity);
  assert.ok(fixture.active().includes("bash"));
  assert.ok(fixture.active().includes("powershell"));
  assert.ok(manager.authorizedToolNames()?.includes("powershell"));
});
