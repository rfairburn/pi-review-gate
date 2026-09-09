import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { normalizeConfig, normalizeModeCycleShortcut } from "../src/config";
import { findOccupiedHostBindings, setHostKeybindingLoader } from "../src/host-keybindings";
import { registerModeCycleShortcut } from "../src/mode-cycle";
import { nextOperatingMode } from "../src/operating-mode";
import { activate } from "../src/index";

let previousConfig: string | undefined;
let previousDisabled: string | undefined;
let previousRole: string | undefined;

beforeEach(() => {
  previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
  previousRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  setHostKeybindingLoader(undefined);
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.PI_REVIEW_GATE_CONFIG;
  else process.env.PI_REVIEW_GATE_CONFIG = previousConfig;
  if (previousDisabled === undefined) delete process.env.PI_REVIEW_GATE_DISABLED;
  else process.env.PI_REVIEW_GATE_DISABLED = previousDisabled;
  if (previousRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
  else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previousRole;
  setHostKeybindingLoader(undefined);
});

interface CapturedShortcut {
  key: string;
  description?: string;
  handler: (ctx: unknown) => Promise<void> | void;
}

interface Harness {
  hooks: Map<string, Array<(...args: unknown[]) => unknown>>;
  notices: string[];
  shortcuts: Map<string, CapturedShortcut>;
  reviewSettings: () => ((args: string, ctx: unknown) => Promise<void>) | undefined;
  pi: Record<string, unknown>;
}

function createHarness(): Harness {
  const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const notices: string[] = [];
  const shortcuts = new Map<string, CapturedShortcut>();
  let reviewSettings: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      hooks.set(name, [...(hooks.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      if (name === "review-settings") reviewSettings = options.handler;
    },
    registerShortcut(key: string, options: { description?: string; handler: (ctx: unknown) => Promise<void> | void }) {
      shortcuts.set(key, { key, description: options.description, handler: options.handler as CapturedShortcut["handler"] });
    },
    appendEntry() {},
    notify(message: string) { notices.push(message); },
    sendUserMessage() {},
  };
  return { hooks, notices, shortcuts, reviewSettings: () => reviewSettings, pi };
}

function shortcutTarget(notices: string[], status: { value: string }, selectors: string[] = []) {
  return {
    ui: {
      notify: (message: string) => { notices.push(message); },
      setStatus: (key: string, value: string | undefined) => { if (key === "review-gate-mode") status.value = value ?? ""; },
      select: async (title: string) => { selectors.push(title); return undefined; },
    },
  };
}

async function triggerResults(hooks: Map<string, Array<(...args: unknown[]) => unknown>>, name: string, ...args: unknown[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of hooks.get(name) ?? []) {
    results.push(await handler(...args));
  }
  return results.filter((result) => result !== undefined);
}

test("cycling changes only the live mode, preserving unrelated in-memory and disk settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-mode-only-"));
  try {
    const configPath = join(dir, "config.json");
    const config = normalizeConfig({ operatingMode: "execute", maxCorrectionCycles: 1 });
    await writeFile(configPath, JSON.stringify({ operatingMode: "execute", maxCorrectionCycles: 8 }));
    let handler: CapturedShortcut["handler"] | undefined;
    registerModeCycleShortcut({
      pi: { registerShortcut: (_key: string, options: CapturedShortcut) => { handler = options.handler; } },
      config, configPath,
      applyModeTransition: async () => {},
    });
    assert.ok(handler);
    await handler({});
    assert.equal(config.operatingMode, "orchestrate");
    assert.equal(config.maxCorrectionCycles, 1, "unrelated disk edits must not silently become live");
    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(persisted.operatingMode, "orchestrate");
    assert.equal(persisted.maxCorrectionCycles, 8, "unrelated disk edits must not be overwritten");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nextOperatingMode advances the canonical order and wraps", () => {
  assert.equal(nextOperatingMode("execute"), "orchestrate");
  assert.equal(nextOperatingMode("orchestrate"), "plan-research");
  assert.equal(nextOperatingMode("plan-research"), "execute");
});

test("normalizeModeCycleShortcut canonicalizes valid bindings and rejects invalid ones", () => {
  assert.equal(normalizeModeCycleShortcut("ALT+M"), "alt+m");
  assert.equal(normalizeModeCycleShortcut("ctrl + shift + r"), "ctrl+shift+r");
  assert.equal(normalizeModeCycleShortcut("shift+return"), "shift+enter");
  assert.equal(normalizeModeCycleShortcut("alt+pageup"), "alt+pageUp");
  assert.equal(normalizeModeCycleShortcut("ctrl+f12"), "ctrl+f12");
  assert.equal(normalizeModeCycleShortcut("alt+,"), "alt+,");
  assert.equal(normalizeModeCycleShortcut("m"), "m");
  assert.equal(normalizeModeCycleShortcut("f6"), "f6");
  assert.throws(() => normalizeModeCycleShortcut("alt+"), /must be a key/);
  assert.throws(() => normalizeModeCycleShortcut("alt+m+n"), /modifiers/);
  assert.throws(() => normalizeModeCycleShortcut("alt+m+ctrl"), /modifiers/);
  assert.throws(() => normalizeModeCycleShortcut("hyper+m"), /modifiers/);
  assert.throws(() => normalizeModeCycleShortcut("alt+volume"), /key must be/);
  assert.throws(() => normalizeModeCycleShortcut("alt+constructor"), /key must be/);
  assert.throws(() => normalizeModeCycleShortcut("alt+__proto__"), /key must be/);
  assert.throws(() => normalizeModeCycleShortcut(42), /must be a string/);
  // Omitted fields keep the documented default; invalid explicit values fail strictly.
  assert.equal(normalizeModeCycleShortcut(undefined), "alt+m");
  assert.equal(normalizeConfig({}).modeCycleShortcut, "alt+m");
  assert.equal(normalizeConfig({ modeCycleShortcut: "ctrl+shift+r" }).modeCycleShortcut, "ctrl+shift+r");
});

test("findOccupiedHostBindings reports named host bindings and unresolved hosts", () => {
  setHostKeybindingLoader(() => ({ "app.thinking.cycle": "shift+tab", "app.model.cycleForward": ["ctrl+p", "alt+p"] }));
  assert.deepEqual(findOccupiedHostBindings("alt+p"), { resolved: true, bindings: ["app.model.cycleForward"] });
  assert.deepEqual(findOccupiedHostBindings("SHIFT+TAB"), { resolved: true, bindings: ["app.thinking.cycle"] });
  assert.deepEqual(findOccupiedHostBindings("alt+m"), { resolved: true, bindings: [] });
  setHostKeybindingLoader(() => undefined);
  assert.deepEqual(findOccupiedHostBindings("shift+tab"), { resolved: false, bindings: [] });
});

test("startup names an occupied host binding and does not register or override it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-mode-cycle-occupied-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ enabled: true, operatingMode: "execute", modeCycleShortcut: "ctrl+o" }));
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    setHostKeybindingLoader(() => ({ "app.tools.expand": "ctrl+o" }));
    const harness = createHarness();
    await activate(harness.pi);
    assert.match(harness.notices.join("\n"), /mode cycle hotkey 'ctrl\+o' is also used by built-in Pi binding\(s\) \(app\.tools\.expand\)/);
    assert.ok(!harness.shortcuts.has("ctrl+o"), "a known occupied host key must not be registered or overridden");
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).operatingMode, "execute");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("occupancy comparison is chord-identity based: reordered equivalent modifiers collide", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-mode-cycle-chord-"));
  const configPath = join(dir, "config.json");
  try {
    // The config stores the modifier order as written; the host reports the
    // same physical chord in a different order. They must still collide.
    await writeFile(configPath, JSON.stringify({ enabled: true, operatingMode: "execute", modeCycleShortcut: "shift+ctrl+r" }));
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    setHostKeybindingLoader(() => ({ "app.commandPalette": "ctrl+shift+r" }));
    const harness = createHarness();
    await activate(harness.pi);
    assert.match(harness.notices.join("\n"), /mode cycle hotkey 'shift\+ctrl\+r' is also used by built-in Pi binding\(s\) \(app\.commandPalette\)/);
    assert.ok(!harness.shortcuts.has("shift+ctrl+r"), "an equivalent reordered chord must not be registered");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("overlapping presses serialize complete cycle operations: two presses advance twice, three wrap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-mode-cycle-race-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ enabled: true, operatingMode: "execute" }));
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const harness = createHarness();
    await activate(harness.pi);
    const shortcut = harness.shortcuts.get("alt+m");
    assert.ok(shortcut, "the default alt+m binding is registered");

    const notices = harness.notices;
    const status = { value: "" };
    const ctx = shortcutTarget(notices, status);

    // Two presses before either finishes: both advances must land.
    const first = shortcut.handler(ctx);
    const second = shortcut.handler(ctx);
    await Promise.all([first, second]);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).operatingMode, "plan-research");
    assert.match(notices.join("\n"), /operating mode is now Plan\/research/);

    // A third press wraps plan-research → execute, with status agreeing.
    await shortcut.handler(ctx);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).operatingMode, "execute");
    assert.equal(status.value, "operating mode: Prefer execution");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mode cycling is registered with the configured binding and advances the canonical persisted mode with wrap, status, and no menu", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-mode-cycle-wrap-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ enabled: true, operatingMode: "execute" }));
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const harness = createHarness();
    await activate(harness.pi);
    const shortcut = harness.shortcuts.get("alt+m");
    assert.ok(shortcut, "the default alt+m binding is registered");
    assert.match(shortcut.description ?? "", /Cycle the review gate operating mode directly/);

    const notices = harness.notices;
    const status = { value: "" };
    const selectorCalls: string[] = [];
    const press = async () => {
      await shortcut.handler(shortcutTarget(notices, status, selectorCalls));
    };
    for (const [label, mode] of [
      ["Prefer orchestration", "orchestrate"],
      ["Plan/research", "plan-research"],
      ["Prefer execution", "execute"],
    ] as const) {
      await press();
      assert.equal(status.value, `operating mode: ${label}`);
      assert.match(notices.join("\n"), new RegExp(`operating mode is now ${label}`));
      assert.equal(JSON.parse(await readFile(configPath, "utf8")).operatingMode, mode);
    }
    assert.deepEqual(selectorCalls, [], "cycling must never open a selector or popup");

    // Prompt replacement is the same shared path: the next normal run gets
    // only the current mode's segment plus the base prompt.
    const executePrompt = await triggerResults(harness.hooks, "before_agent_start", { cwd: dir, systemPrompt: "base instructions." });
    const systemPrompt = executePrompt.map((result) => (result as { systemPrompt?: string }).systemPrompt ?? "").join("\n");
    assert.match(systemPrompt, /# Execution posture/, "the last cycle left execute active");
    assert.ok(!systemPrompt.includes("# Orchestrator role"));

    await press();
    const restoredPrompt = await triggerResults(harness.hooks, "before_agent_start", { cwd: dir, systemPrompt: "base instructions." });
    const restored = restoredPrompt.map((result) => (result as { systemPrompt?: string }).systemPrompt ?? "").join("\n");
    assert.match(restored, /# Orchestrator role/);
    assert.ok(!restored.includes("# Execution posture"));
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).operatingMode, "orchestrate");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the hotkey fails closed when persistence is impossible or no config file is loaded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-mode-cycle-fail-closed-"));
  try {
    const config = normalizeConfig({ operatingMode: "execute" });
    let transitions = 0;
    const notices: string[] = [];
    const press = async (shortcut: CapturedShortcut) => {
      await shortcut.handler(shortcutTarget(notices, { value: "" }));
    };

    // No persistent config file: registered, but the cycle is refused and the
    // canonical mode stays unchanged, mirroring /review-settings behavior.
    const handlers: CapturedShortcut[] = [];
    registerModeCycleShortcut({
      pi: { registerShortcut: (key: string, options: { description?: string; handler: CapturedShortcut["handler"] }) => {
        handlers.push({ key, description: options.description, handler: options.handler });
      } },
      config,
      applyModeTransition: async () => { transitions += 1; },
    });
    await press(handlers[handlers.length - 1]!);
    assert.match(notices.at(-1) ?? "", /no persistent review-gate config file is loaded; operating mode not changed/);
    assert.equal(transitions, 0);
    assert.equal(config.operatingMode, "execute");

    // Persistence failure (a directory is not a readable JSON document):
    // the mode is not switched and the shared transition does not run.
    registerModeCycleShortcut({
      pi: { registerShortcut: (key: string, options: { description?: string; handler: CapturedShortcut["handler"] }) => {
        handlers.push({ key, description: options.description, handler: options.handler });
      } },
      config,
      configPath: dir,
      applyModeTransition: async () => { transitions += 1; },
    });
    await press(handlers[handlers.length - 1]!);
    assert.match(notices.at(-1) ?? "", /could not be persisted; mode unchanged/);
    assert.equal(transitions, 0);
    assert.equal(config.operatingMode, "execute");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("/review-settings edits the mode cycle hotkey: current binding visible, cancel keeps it, invalid input is rejected, occupied keys are rejected by name, and changed keys note /reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-mode-cycle-settings-"));
  const configPath = join(dir, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ enabled: true, operatingMode: "orchestrate" }));
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const harness = createHarness();
    await activate(harness.pi);
    const settings = harness.reviewSettings();
    assert.ok(settings);

    let rootVisits = 0;
    const inputs: string[] = [];
    let enteredValue: string | undefined;
    const notices = harness.notices;
    const ui = {
      select: async (title: string, choices: string[]) => {
        if (title === "Review settings") {
          rootVisits += 1;
          if (rootVisits % 2 === 1) {
            const row = choices.find((choice) => choice.startsWith("Mode cycle hotkey"));
            assert.ok(row, "the settings menu exposes the current hotkey row");
            return row;
          }
          return "Save changes";
        }
        throw new Error(`Unexpected menu: ${title}`);
      },
      input: async (title: string, current: string) => {
        inputs.push(`${title}|${current}`);
        const value = enteredValue;
        enteredValue = undefined;
        return value;
      },
      notify: (message: string, type?: string) => { notices.push(`[${type ?? "info"}] ${message}`); },
      setStatus: () => {},
    };

    // Cancel keeps the current binding.
    enteredValue = undefined;
    await settings("", { cwd: dir, ui });
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).modeCycleShortcut, "alt+m");
    assert.ok(!notices.join("\n").includes("takes effect after /reload"));

    // Invalid input is rejected and re-prompted; a valid replacement is
    // persisted and notes the reload requirement.
    rootVisits = 0;
    enteredValue = "alt+";
    await settings("", { cwd: dir, ui: { ...ui, input: async (title: string, current: string) => {
      inputs.push(`${title}|${current}`);
      const value = enteredValue;
      enteredValue = undefined;
      return value === "alt+" ? value : "ctrl+shift+r";
    } } });
    assert.match(notices.join("\n"), /\[error\] modeCycleShortcut must be a key/);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).modeCycleShortcut, "ctrl+shift+r");
    assert.match(notices.join("\n"), /Mode cycle hotkey takes effect after \/reload\./);

    // An occupied host binding is rejected by name and the current binding
    // is kept; the user is re-prompted rather than allowed to steal the key.
    // A reordered but equivalent chord (shift+ctrl+r vs ctrl+shift+r) collides
    // the same way.
    setHostKeybindingLoader(() => ({ "app.commandPalette": "ctrl+shift+r" }));
    rootVisits = 0;
    enteredValue = "shift+ctrl+r";
    await settings("", { cwd: dir, ui });
    assert.match(notices.join("\n"), /\[error\] 'shift\+ctrl\+r' is also used by built-in Pi binding\(s\) \(app\.commandPalette\)/);
    assert.equal(JSON.parse(await readFile(configPath, "utf8")).modeCycleShortcut, "ctrl+shift+r");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
