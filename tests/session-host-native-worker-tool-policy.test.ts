import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  composeNativeWorkerToolCeiling,
  NativeWorkerToolCeilingRefusedError,
  resolveNativeWorkerLaunchRestrictions,
  resolveNativeWorkerToolCeiling,
  type NativeWorkerToolCeiling,
  type NativeWorkerToolCeilingRefusalCode,
  type NativeWorkerToolPolicyDependencies,
  type NativeWorkerToolPolicyInput,
} from "../src/session-host/native-worker-tool-policy";
import { loadNativeWorkerToolCandidates, shippedReviewGateToolNames } from "../src/session-host/review-settings-catalog";
import { CODEMODE_TOOL_NAME, DEFERRED_TOOL_SEARCH_NAME } from "../src/tool-inventory";
import { EXECUTION_TOOL_ACTIONS, EXECUTION_TOOL_NAMES } from "../src/execution/tool-names";
import { WEB_TOOL_NAMES } from "../src/web/tool-names";
import { BACKGROUND_SHELL_TOOL_NAMES } from "../src/background-shell/tool-names";
import { SESSION_SPAWN_TOOL_NAME } from "../src/session-host/spawn-tool";
import { SESSION_HOSTS_TOOL_NAME } from "../src/session-host/hosts-tool";
import { YOU_SHOULD_KNOW_TOOL_NAME } from "../src/user-question/notice-tool";
import { USER_QUESTION_TOOL_NAME } from "../src/user-question/tool";
import { APPLY_PATCH_TOOL_NAME } from "../src/apply-patch/tool";
import { GIT_READ_TOOL_NAME } from "../src/git-read/tool";
import {
  createExecutorToolCatalog,
  createPiWorkerToolCatalog,
  defaultExecutorInitialActiveTools,
} from "../src/execution/tool-catalog";
import { DEFAULT_CONFIG } from "../src/config";
import { assertNoPiToolPolicyArgs, piToolPolicyFlagKind } from "../src/pi-tool-policy";
import { findInstalledAgentDirs } from "./menu-tui-fakes";
import { skipOrFail } from "./bridge-fakes";

const PI_EXECUTABLE = "/opt/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const PI_VERSION = "1.7.0";
const CWD = "/work/tree";

const HOST_ONLY = [SESSION_SPAWN_TOOL_NAME, SESSION_HOSTS_TOOL_NAME, ...EXECUTION_TOOL_ACTIONS.map((action) => EXECUTION_TOOL_NAMES[action])];
const WEB = Object.values(WEB_TOOL_NAMES) as string[];

/** Value-taking tool-policy flags of the fake parser (exact tokens only, like Pi). */
const FAKE_VALUE_FLAGS: Record<string, "tools" | "excludeTools"> = { "--tools": "tools", "-t": "tools", "--exclude-tools": "excludeTools", "-xt": "excludeTools" };

/**
 * A structural fake of the SDK parser with the documented field shapes: the
 * exact flag token consumes the next token; `--model` consumes its value;
 * Pi's literal `--` ends options; `=`-attached spellings are unknown flags.
 */
function fakeParseArgs(args: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = { messages: [], diagnostics: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--") break;
    const field = FAKE_VALUE_FLAGS[token];
    if (field && index + 1 < args.length) {
      result[field] = args[index + 1]!.split(",").map((name) => name.trim()).filter(Boolean);
      index += 1;
    } else if (token === "--model" && index + 1 < args.length) {
      result.model = args[index + 1];
      index += 1;
    } else if (token === "--no-tools" || token === "-nt") {
      result.noTools = true;
    } else if ((token === "--extension" || token === "-e") && index + 1 < args.length) {
      result.extensions = [...((result.extensions as string[] | undefined) ?? []), args[index + 1]!];
      index += 1;
    } else if (token === "--no-extensions" || token === "-ne") {
      result.noExtensions = true;
    } else if (token === "--no-builtin-tools" || token === "-nbt") {
      result.noBuiltinTools = true;
    }
  }
  return result;
}

interface FakeSdkLog {
  loads: unknown[][];
  parsed: string[][];
}

function fakeSdk(log: FakeSdkLog, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    parseArgs(args: string[]) {
      log.parsed.push(args);
      return fakeParseArgs(args);
    },
    createReadToolDefinition: () => ({ name: "read", description: "Read files." }),
    createBashToolDefinition: () => ({ name: "bash", description: "Execute a command." }),
    createGrepToolDefinition: () => ({ name: "grep", description: "Search." }),
    ...overrides,
  };
}

function newLog(): FakeSdkLog {
  return { loads: [], parsed: [] };
}

function input(overrides: Partial<NativeWorkerToolPolicyInput> = {}): NativeWorkerToolPolicyInput {
  return { piExecutable: PI_EXECUTABLE, piVersion: PI_VERSION, cwd: CWD, launchArgs: [], settings: DEFAULT_CONFIG, nativeCodemodeAvailable: true, ...overrides };
}

function resolveWith(
  overrides: Partial<NativeWorkerToolPolicyInput> = {},
  sdkOverrides: Record<string, unknown> = {},
  dependencies: Omit<NativeWorkerToolPolicyDependencies, "loadSdk"> = {},
  log: FakeSdkLog = newLog(),
): NativeWorkerToolCeiling {
  return resolveNativeWorkerToolCeiling(input(overrides), {
    loadSdk: (...args: unknown[]) => { log.loads.push(args); return fakeSdk(log, sdkOverrides); },
    nativePowerShellSupported: () => false,
    ...dependencies,
  });
}

function assertRefused(run: () => unknown, code: NativeWorkerToolCeilingRefusalCode, pattern?: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof NativeWorkerToolCeilingRefusedError, `expected a refusal, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

const reasonOf = (ceiling: NativeWorkerToolCeiling, name: string) => ceiling.withheld.find((entry) => entry.name === name)?.reason;

test("an offline codemode candidate and an explicit host selection do not prove worker availability", () => {
  for (const nativeCodemodeAvailable of [undefined, false, "true" as unknown as boolean]) {
    for (const launchArgs of [[], ["-ne", "-e", "builtin:codemode"], ["--tools", `codemode,read,${DEFERRED_TOOL_SEARCH_NAME}`]]) {
      const ceiling = resolveWith({ launchArgs, nativeCodemodeAvailable });
      assert.equal(reasonOf(ceiling, CODEMODE_TOOL_NAME), "native-codemode-unavailable", launchArgs.join(" "));
      const catalog = createPiWorkerToolCatalog(createExecutorToolCatalog(ceiling.parentCeiling));
      assert.ok(!catalog.allowedToolCatalog.includes(CODEMODE_TOOL_NAME));
      assert.ok(!catalog.initialActiveTools.includes(CODEMODE_TOOL_NAME), "deferral-off full-active never promises it");
    }
  }
  // The owner fact never overrides a host CLI restriction.
  assert.equal(reasonOf(resolveWith({ launchArgs: ["-xt", CODEMODE_TOOL_NAME], nativeCodemodeAvailable: true }), CODEMODE_TOOL_NAME), "launch-restriction");
  assert.equal(reasonOf(resolveWith({ launchArgs: ["-ne"], nativeCodemodeAvailable: true }), CODEMODE_TOOL_NAME), "launch-restriction");
  // The pure composer defaults to withholding.
  const candidates = loadNativeWorkerToolCandidates({ piExecutable: PI_EXECUTABLE, cwd: CWD, expectedPiVersion: PI_VERSION }, { loadSdk: () => fakeSdk(newLog()) });
  const composed = composeNativeWorkerToolCeiling(candidates, resolveNativeWorkerLaunchRestrictions(fakeSdk(newLog()), []), DEFAULT_CONFIG, () => false);
  assert.equal(reasonOf(composed, CODEMODE_TOOL_NAME), "native-codemode-unavailable");
});

test("unrestricted host: SDK builtins, codemode, and shipped registrations are eligible; loader and host-only names are not", () => {
  const log = newLog();
  const ceiling = resolveWith({}, {}, {}, log);
  assert.deepEqual(log.loads, [[PI_EXECUTABLE, PI_VERSION]], "one validated SDK load bound to the admitted version");
  assert.deepEqual(log.parsed, [], "no launch arguments: the parser is not needed");

  const expected = [
    "bash", "grep", "read", CODEMODE_TOOL_NAME,
    ...Object.values(BACKGROUND_SHELL_TOOL_NAMES), ...WEB,
    APPLY_PATCH_TOOL_NAME, GIT_READ_TOOL_NAME,
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(ceiling.parentCeiling, expected);
  assert.equal(reasonOf(ceiling, DEFERRED_TOOL_SEARCH_NAME), "reserved-discovery-loader");
  for (const name of HOST_ONLY) assert.equal(reasonOf(ceiling, name), "host-only", name);
  for (const name of [USER_QUESTION_TOOL_NAME, YOU_SHOULD_KNOW_TOOL_NAME]) {
    assert.equal(reasonOf(ceiling, name), "worker-unregistered", `${name} has no registrar in the Pi executor role`);
  }
  assert.deepEqual(ceiling.launchRestrictions, { excluded: [], noTools: false, codemodeWithheld: false, noBuiltinToolsIgnored: false });

  // Partition: every offline candidate is either eligible or withheld once; nothing else appears.
  const candidates = loadNativeWorkerToolCandidates({ piExecutable: PI_EXECUTABLE, cwd: CWD, expectedPiVersion: PI_VERSION }, { loadSdk: () => fakeSdk(newLog()) });
  assert.deepEqual(
    [...ceiling.parentCeiling, ...ceiling.withheld.map((entry) => entry.name)].sort(),
    candidates.map((candidate) => candidate.name).sort(),
  );
  assert.ok(Object.isFrozen(ceiling) && Object.isFrozen(ceiling.parentCeiling) && Object.isFrozen(ceiling.withheld));
  assert.deepEqual(resolveWith(), ceiling, "deterministic for the same facts");
});

test("the ceiling feeds the existing canonical catalog seams without tool_search or host-only names", () => {
  const { parentCeiling } = resolveWith();
  const durable = createExecutorToolCatalog(parentCeiling, defaultExecutorInitialActiveTools(parentCeiling));
  const worker = createPiWorkerToolCatalog(durable);
  assert.ok(!worker.allowedToolCatalog.includes(DEFERRED_TOOL_SEARCH_NAME), "the child refuses a durable catalog carrying the loader");
  for (const name of HOST_ONLY) assert.ok(!durable.allowedToolCatalog.includes(name), name);
  assert.deepEqual(worker.initialActiveTools, ["read", "grep", GIT_READ_TOOL_NAME, "bash", "ApplyPatch"],
    "the canonical owner still decides the initial-active subset (kind/deny applied later by withParentTools)");
  // Deferral off: the canonical full-active contract promises every ceiling
  // name at startup, so a name the Pi worker never registers must not be there.
  const fullActive = createPiWorkerToolCatalog(createExecutorToolCatalog(parentCeiling));
  for (const name of [USER_QUESTION_TOOL_NAME, YOU_SHOULD_KNOW_TOOL_NAME, DEFERRED_TOOL_SEARCH_NAME, ...HOST_ONLY]) {
    assert.ok(!fullActive.allowedToolCatalog.includes(name) && !fullActive.initialActiveTools.includes(name), name);
  }
});

test("--tools/-t: SDK-confirmed allowlist intersects; unknown names add nothing; the loader must be named", () => {
  for (const flag of ["--tools", "-t"]) {
    const ceiling = resolveWith({ launchArgs: [flag, `read,bash, ${DEFERRED_TOOL_SEARCH_NAME},mcp__srv__echo,Ghost,${SESSION_SPAWN_TOOL_NAME}`] });
    assert.deepEqual(ceiling.parentCeiling, ["bash", "read"], flag);
    assert.equal(reasonOf(ceiling, "grep"), "launch-restriction");
    assert.equal(reasonOf(ceiling, SESSION_SPAWN_TOOL_NAME), "host-only", "an allowlist never admits a host-only capability");
    assert.equal(reasonOf(ceiling, DEFERRED_TOOL_SEARCH_NAME), "reserved-discovery-loader");
    assert.ok(!ceiling.parentCeiling.includes("mcp__srv__echo") && !ceiling.parentCeiling.includes("Ghost"));
    assert.deepEqual(ceiling.launchRestrictions.allowlist, ["Ghost", SESSION_SPAWN_TOOL_NAME, "bash", "mcp__srv__echo", "read", DEFERRED_TOOL_SEARCH_NAME]);

    assertRefused(() => resolveWith({ launchArgs: [flag, "read,bash"] }), "discovery-loader-withheld", /tool_search/);
  }
});

test("--exclude-tools/-xt removes names; excluding the loader is refused; --no-tools/-nt is refused", () => {
  for (const flag of ["--exclude-tools", "-xt"]) {
    const ceiling = resolveWith({ launchArgs: [flag, "bash,WebFetch,NotACandidate"] });
    assert.equal(reasonOf(ceiling, "bash"), "launch-restriction");
    assert.equal(reasonOf(ceiling, "WebFetch"), "launch-restriction");
    assert.ok(ceiling.parentCeiling.includes("read") && !ceiling.parentCeiling.includes("bash"));
    assertRefused(() => resolveWith({ launchArgs: [flag, DEFERRED_TOOL_SEARCH_NAME] }), "discovery-loader-withheld");
  }
  for (const flag of ["--no-tools", "-nt"]) {
    assertRefused(() => resolveWith({ launchArgs: [flag] }), "discovery-loader-withheld");
    assertRefused(() => resolveWith({ launchArgs: [flag, "--tools", `read,${DEFERRED_TOOL_SEARCH_NAME}`] }), "discovery-loader-withheld",
      /restrictive launch mode is unsupported/);
  }
  // Combined restrictions compose (allowlist then exclusion).
  const combined = resolveWith({ launchArgs: ["--tools", `read,bash,grep,${DEFERRED_TOOL_SEARCH_NAME}`, "-xt", "bash"] });
  assert.deepEqual(combined.parentCeiling, ["grep", "read"]);
});

test("--no-builtin-tools/-nbt only sets initial activity: acknowledged with no ceiling effect", () => {
  const unrestricted = resolveWith().parentCeiling;
  for (const flag of ["--no-builtin-tools", "-nbt"]) {
    const ceiling = resolveWith({ launchArgs: [flag] });
    assert.deepEqual(ceiling.parentCeiling, unrestricted, flag);
    assert.equal(ceiling.launchRestrictions.noBuiltinToolsIgnored, true);
  }
  // A parser that encodes it as noTools:"builtin" is read the same way.
  const encoded = resolveWith({ launchArgs: ["-nbt"] }, { parseArgs: () => ({ noTools: "builtin" }) });
  assert.deepEqual(encoded.parentCeiling, unrestricted);
});

test("restriction tokens the SDK parser did not confirm refuse instead of widening", () => {
  // Parser drift: an SDK that silently ignores --exclude-tools must not widen the ceiling.
  const dropsExclusions = { parseArgs: (args: string[]) => { const parsed = fakeParseArgs(args); delete parsed.excludeTools; return parsed; } };
  assertRefused(() => resolveWith({ launchArgs: ["--exclude-tools", "bash"] }, dropsExclusions), "launch-restriction-unconfirmed", /--exclude-tools/);
  assertRefused(() => resolveWith({ launchArgs: ["-nt"] }, { parseArgs: () => ({}) }), "launch-restriction-unconfirmed", /--no-tools/);
  assertRefused(() => resolveWith({ launchArgs: ["-nbt"] }, { parseArgs: () => ({}) }), "launch-restriction-unconfirmed", /--no-builtin-tools/);
  // Attached or repeated spellings (aliases count together): one parsed field
  // cannot confirm which occurrences Pi actually parsed.
  for (const launchArgs of [
    ["--exclude-tools", "read", "--exclude-tools=bash"],
    ["--exclude-tools", "read", "-xt", "grep"],
    ["-t", `read,${DEFERRED_TOOL_SEARCH_NAME}`, "--tools", `bash,${DEFERRED_TOOL_SEARCH_NAME}`],
    ["--exclude-tools", "read", "--model", "-xt"],
    ["-nt", "--no-tools"],
    ["-ne", "-ne"],
    ["--no-builtin-tools=1"],
  ]) {
    assertRefused(() => resolveWith({ launchArgs }), "launch-restriction-unconfirmed", /attached or repeated/);
  }
  // `=`-attached spellings are unknown extension flags to Pi: ambiguous, refused.
  assertRefused(() => resolveWith({ launchArgs: ["--tools=read"] }), "launch-restriction-unconfirmed", /--tools/);
  assertRefused(() => resolveWith({ launchArgs: ["--exclude-tools=bash"] }), "launch-restriction-unconfirmed");
  // A flag word consumed as another option's value, or a dangling flag, is never glossed.
  assertRefused(() => resolveWith({ launchArgs: ["--model", "--tools"] }), "launch-restriction-unconfirmed");
  assertRefused(() => resolveWith({ launchArgs: ["--tools"] }), "launch-restriction-unconfirmed");
  // Malformed parsed fields.
  for (const parsed of [{ tools: "read" }, { tools: ["read", 7] }, { excludeTools: {} }, { noTools: "some" }, { noBuiltinTools: "yes" }]) {
    assertRefused(() => resolveWith({ launchArgs: ["--offline"] }, { parseArgs: () => parsed }), "launch-restriction-unconfirmed", undefined);
  }
});

test("unparsable host arguments refuse without echoing their contents", () => {
  const secret = "SENTINEL_ARG_SECRET";
  assertRefused(() => resolveWith({ launchArgs: ["--offline"] }, { parseArgs: undefined }), "launch-args-unparsable", /does not export parseArgs/);
  assert.throws(
    () => resolveWith({ launchArgs: ["--api-key", secret] }, { parseArgs: () => { throw new Error(`bad ${secret}`); } }),
    (error: unknown) => error instanceof NativeWorkerToolCeilingRefusedError && error.code === "launch-args-unparsable" && !error.message.includes(secret),
  );
  assertRefused(() => resolveWith({ launchArgs: ["--offline"] }, { parseArgs: () => "nope" }), "launch-args-unparsable");
  assertRefused(() => resolveWith({ launchArgs: ["--offline"] }, { parseArgs: () => ({ diagnostics: [{ type: "error", message: "x" }] }) }), "launch-args-unparsable");
  assertRefused(() => resolveWith({ launchArgs: ["--offline"] }, { parseArgs: () => ({ diagnostics: "x" }) }), "launch-args-unparsable");
  // Warnings (e.g. an unknown allowlisted name) are tolerated: they can only narrow.
  const warned = resolveWith({ launchArgs: ["--offline"] }, { parseArgs: () => ({ diagnostics: [{ type: "warning", message: "w" }] }) });
  assert.ok(warned.parentCeiling.includes("read"));
});

test("trusted inputs are required: missing version, bad args, and unresolvable SDK refuse before any ceiling", () => {
  for (const piVersion of ["", " 1.6.0", undefined as unknown as string]) {
    const log = newLog();
    assertRefused(() => resolveWith({ piVersion }, {}, {}, log), "invalid-input", /version/);
    assert.deepEqual(log.loads, [], "no SDK load without the admitted version");
  }
  assertRefused(() => resolveWith({ launchArgs: ["--tools", 3 as unknown as string] }), "invalid-input");
  assertRefused(() => resolveWith({ launchArgs: undefined as unknown as string[] }), "invalid-input");
  assertRefused(() => resolveWith({ settings: undefined as unknown as NativeWorkerToolPolicyInput["settings"] }), "invalid-input");
  assertRefused(() => resolveWith({ piExecutable: "pi" }), "candidates-unavailable", /absolute path/);
  assertRefused(() => resolveWith({ cwd: "relative" }), "candidates-unavailable", /absolute path/);
  assertRefused(
    () => resolveNativeWorkerToolCeiling(input(), { loadSdk: () => { throw new Error("version 1.5.0 does not match"); } }),
    "candidates-unavailable",
    /does not match/,
  );
  assertRefused(
    () => resolveWith({}, { createReadToolDefinition: undefined, createBashToolDefinition: undefined, createGrepToolDefinition: undefined }),
    "candidates-unavailable",
    /no native builtin tool definitions/,
  );
});

test("request-time settings gates: web.enabled withholds; notice settings, deny lists, and hidden names never widen", () => {
  const webOff = resolveWith({ settings: { ...DEFAULT_CONFIG, web: { ...DEFAULT_CONFIG.web!, enabled: false } } });
  for (const name of WEB) assert.equal(reasonOf(webOff, name), "feature-disabled", name);
  assert.ok(webOff.parentCeiling.includes(APPLY_PATCH_TOOL_NAME));
  // The notice setting cannot make a non-transferable registration eligible, on or off.
  for (const enabled of [true, false]) {
    const notices = resolveWith({ settings: { ...DEFAULT_CONFIG, youShouldKnow: { enabled, completionGuidance: true } } as NativeWorkerToolPolicyInput["settings"] });
    assert.equal(reasonOf(notices, YOU_SHOULD_KNOW_TOOL_NAME), "worker-unregistered");
    assert.equal(reasonOf(notices, USER_QUESTION_TOOL_NAME), "worker-unregistered");
  }
  // Absent sections follow the registrar's default (web on).
  const defaults = resolveWith({ settings: {} });
  assert.deepEqual(defaults.parentCeiling, resolveWith().parentCeiling);

  // Deny lists are owned elsewhere: top-level deny never narrows the genuine
  // parent authority, and deny-only names (non-candidates) are never added.
  const withDeny = resolveWith({
    settings: { ...DEFAULT_CONFIG, tools: { topLevelDeny: ["read", "mcp__srv__hidden"], executorDeny: ["Ghost"] } } as NativeWorkerToolPolicyInput["settings"],
  });
  assert.deepEqual(withDeny.parentCeiling, resolveWith().parentCeiling);
  for (const name of ["mcp__srv__hidden", "Ghost"]) {
    assert.ok(!withDeny.parentCeiling.includes(name) && reasonOf(withDeny, name) === undefined, name);
  }
});

test("platform gate: Pi's native powershell builtin needs host support; the probe runs only when needed", () => {
  const withPowerShell = { createPowershellToolDefinition: () => ({ name: "powershell", description: "Run PowerShell." }) };
  const unsupported = resolveWith({}, withPowerShell, { nativePowerShellSupported: () => false });
  assert.equal(reasonOf(unsupported, "powershell"), "platform-unsupported");
  const supported = resolveWith({}, withPowerShell, { nativePowerShellSupported: () => true });
  assert.ok(supported.parentCeiling.includes("powershell"));
  const throwing = resolveWith({}, withPowerShell, { nativePowerShellSupported: () => { throw new Error("where failed"); } });
  assert.equal(reasonOf(throwing, "powershell"), "platform-unsupported", "a probe failure withholds, never widens");
  let probes = 0;
  resolveWith({}, {}, { nativePowerShellSupported: () => { probes += 1; return true; } });
  assert.equal(probes, 0, "no powershell candidate: no probe");
  resolveWith({ launchArgs: ["-xt", "powershell"] }, withPowerShell, { nativePowerShellSupported: () => { probes += 1; return true; } });
  assert.equal(probes, 0, "a host-excluded powershell needs no probe");
});

test("no restriction combination widens the unrestricted ceiling", () => {
  const unrestricted = new Set(resolveWith().parentCeiling);
  const loader = DEFERRED_TOOL_SEARCH_NAME;
  const combos: string[][] = [
    ["--tools", `read,${loader}`],
    ["-t", `read,bash,grep,codemode,WebFetch,${loader}`, "--exclude-tools", "codemode"],
    ["--exclude-tools", "read,grep"],
    ["-nbt", "--tools", `bash,${loader}`],
    ["--model", "x", "--tools", `${loader},ShellStart`],
    ["--exclude-tools", "", "--tools", `${loader},read,${SESSION_HOSTS_TOOL_NAME}`],
  ];
  for (const launchArgs of combos) {
    const ceiling = resolveWith({ launchArgs });
    for (const name of ceiling.parentCeiling) assert.ok(unrestricted.has(name), `${launchArgs.join(" ")} widened with ${name}`);
  }
});

test("pure composition and restriction resolution are usable separately by the owner binding", () => {
  const candidates = loadNativeWorkerToolCandidates({ piExecutable: PI_EXECUTABLE, cwd: CWD, expectedPiVersion: PI_VERSION }, { loadSdk: () => fakeSdk(newLog()) });
  const restrictions = resolveNativeWorkerLaunchRestrictions(fakeSdk(newLog()), ["-t", `read,${DEFERRED_TOOL_SEARCH_NAME}`]);
  assert.deepEqual(restrictions, { allowlist: ["read", DEFERRED_TOOL_SEARCH_NAME], excluded: [], noTools: false, codemodeWithheld: false, noBuiltinToolsIgnored: false });
  assert.deepEqual(composeNativeWorkerToolCeiling(candidates, restrictions, DEFAULT_CONFIG, () => false).parentCeiling, ["read"]);
  // Every shipped registration is classified (eligible, gated, or withheld) — none is silently dropped.
  const full = composeNativeWorkerToolCeiling(candidates, resolveNativeWorkerLaunchRestrictions(fakeSdk(newLog()), []), DEFAULT_CONFIG, () => false);
  for (const name of shippedReviewGateToolNames()) {
    assert.ok(full.parentCeiling.includes(name) || reasonOf(full, name) !== undefined, name);
  }
});

test("wildcard and +/- modifier policy entries refuse; exclusions match case-insensitively", () => {
  const loader = DEFERRED_TOOL_SEARCH_NAME;
  for (const launchArgs of [
    ["--exclude-tools", "b*"],
    ["-xt", "tool_*"],
    ["-xt", "?ash"],
    ["--exclude-tools", "[bt]ash"],
    ["--tools", `read,${loader},+bash`],
    ["-t", `read,${loader},-bash`],
    ["--tools", `read,${loader},mcp__srv__*`],
    ["--tools", `read,${loader},Web{Fetch,Search}`],
    ["--tools", `${loader},re.d`],
  ]) {
    assertRefused(() => resolveWith({ launchArgs }), "launch-restriction-unconfirmed", /not a plain tool name/);
  }
  const secret = "SENTINEL*";
  assert.throws(() => resolveWith({ launchArgs: ["-xt", secret] }), (error: unknown) => error instanceof Error && !error.message.includes(secret));
  // Case-folded exclusions only ever narrow; the allowlist stays exact.
  const folded = resolveWith({ launchArgs: ["--exclude-tools", "BASH,applypatch"] });
  assert.equal(reasonOf(folded, "bash"), "launch-restriction");
  assert.equal(reasonOf(folded, APPLY_PATCH_TOOL_NAME), "launch-restriction");
  assertRefused(() => resolveWith({ launchArgs: ["-xt", "Tool_Search"] }), "discovery-loader-withheld");
  assert.deepEqual(resolveWith({ launchArgs: ["-t", `READ,bash,${loader}`] }).parentCeiling, ["bash"]);
  assertRefused(() => resolveWith({ launchArgs: ["-t", "read,TOOL_SEARCH"] }), "discovery-loader-withheld");
});

test("--no-extensions/-ne withholds native codemode unless builtin:codemode is explicitly selected", () => {
  for (const flag of ["--no-extensions", "-ne"]) {
    const ceiling = resolveWith({ launchArgs: [flag] });
    assert.equal(reasonOf(ceiling, CODEMODE_TOOL_NAME), "launch-restriction", flag);
    assert.equal(ceiling.launchRestrictions.codemodeWithheld, true);
    assert.ok(ceiling.parentCeiling.includes(APPLY_PATCH_TOOL_NAME) && ceiling.parentCeiling.includes("read"),
      "review-gate's explicitly loaded registrations and core builtins stay");
    const selected = resolveWith({ launchArgs: [flag, "-e", "builtin:codemode"] });
    assert.ok(selected.parentCeiling.includes(CODEMODE_TOOL_NAME), `${flag} with the explicit builtin selection`);
    const other = resolveWith({ launchArgs: [flag, "--extension", "/opt/ext/index.js"] });
    assert.equal(reasonOf(other, CODEMODE_TOOL_NAME), "launch-restriction");
  }
  // An explicit selection without --no-extensions changes nothing.
  assert.ok(resolveWith({ launchArgs: ["-e", "/opt/ext/index.js"] }).parentCeiling.includes(CODEMODE_TOOL_NAME));
  // Unconfirmed or malformed extension facts refuse.
  assertRefused(() => resolveWith({ launchArgs: ["-ne"] }, { parseArgs: () => ({}) }), "launch-restriction-unconfirmed", /--no-extensions/);
  assertRefused(() => resolveWith({ launchArgs: ["--no-extensions=1"] }), "launch-restriction-unconfirmed");
  assertRefused(() => resolveWith({ launchArgs: ["--offline"] }, { parseArgs: () => ({ noExtensions: "yes" }) }), "launch-restriction-unconfirmed");
  assertRefused(() => resolveWith({ launchArgs: ["--offline"] }, { parseArgs: () => ({ noExtensions: true, extensions: "builtin:codemode" }) }), "launch-restriction-unconfirmed");
});

test("shared tool-policy flag table: aliases map to one kind and the executor guard is unchanged", () => {
  assert.deepEqual(
    ["--tools", "-t", "--exclude-tools=x", "-xt", "--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--toolsx", "--model", "read"].map(piToolPolicyFlagKind),
    ["allowlist", "allowlist", "exclude", "exclude", "noTools", "noTools", "noBuiltinTools", "noBuiltinTools", undefined, undefined, undefined],
  );
  assert.throws(() => assertNoPiToolPolicyArgs(["--model", "m", "-xt", "bash"], "Pi executor arguments"), /Pi executor arguments must not set -xt;/);
  assert.throws(() => assertNoPiToolPolicyArgs(["--tools=read"], "ctx"), /must not set --tools=read;/);
  assert.doesNotThrow(() => assertNoPiToolPolicyArgs(["--model", "m", "--offline"], "ctx"));
});

/** The installed official Pi package matching the pinned UI runtime version. */
function installedPi(t: TestContext): { packageDir: string; cli: string } | undefined {
  for (const packageDir of findInstalledAgentDirs()) {
    try {
      const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version?: string; bin?: Record<string, string> };
      const bin = manifest.bin?.pi;
      if (manifest.version === PI_VERSION && typeof bin === "string" && existsSync(join(packageDir, bin))) {
        return { packageDir, cli: join(packageDir, bin) };
      }
    } catch {
      // try the next install
    }
  }
  skipOrFail(t, `no installed Pi ${PI_VERSION} for the native worker tool ceiling`);
  return undefined;
}

test("installed Pi SDK: real parseArgs confirms the supported restriction semantics; nothing is started or written", (t) => {
  const pi = installedPi(t);
  if (!pi) return;
  const workspace = mkdtempSync(join(tmpdir(), "native-worker-ceiling-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const resolve = (launchArgs: string[]) => resolveNativeWorkerToolCeiling(
    { piExecutable: pi.cli, piVersion: PI_VERSION, cwd: workspace, launchArgs, settings: DEFAULT_CONFIG, nativeCodemodeAvailable: true },
    { nativePowerShellSupported: () => false },
  );

  const unrestricted = resolve([]);
  for (const builtin of ["read", "bash", "edit", "write", "grep", "find", "ls", CODEMODE_TOOL_NAME]) {
    assert.ok(unrestricted.parentCeiling.includes(builtin), builtin);
  }
  assert.equal(reasonOf(unrestricted, DEFERRED_TOOL_SEARCH_NAME), "reserved-discovery-loader");
  assert.ok(!unrestricted.parentCeiling.includes("powershell"), "the native powershell builtin is platform-gated");

  for (const flag of ["--tools", "-t"]) {
    assert.deepEqual(resolve([flag, `read,bash,${DEFERRED_TOOL_SEARCH_NAME}`]).parentCeiling, ["bash", "read"], flag);
    assert.throws(() => resolve([flag, "read,bash"]), (error: unknown) => error instanceof NativeWorkerToolCeilingRefusedError && error.code === "discovery-loader-withheld");
  }
  for (const flag of ["--exclude-tools", "-xt"]) {
    const excluded = resolve([flag, "bash,edit"]);
    assert.equal(reasonOf(excluded, "bash"), "launch-restriction", flag);
    assert.equal(reasonOf(excluded, "edit"), "launch-restriction", flag);
    assert.ok(excluded.parentCeiling.includes("read"));
  }
  for (const flag of ["--no-tools", "-nt"]) {
    assert.throws(() => resolve([flag]), (error: unknown) => error instanceof NativeWorkerToolCeilingRefusedError && error.code === "discovery-loader-withheld", flag);
  }
  for (const flag of ["--no-builtin-tools", "-nbt"]) {
    assert.deepEqual(resolve([flag]).parentCeiling, unrestricted.parentCeiling, flag);
  }
  // Pi matches policy lists with wildcards and +/- modifiers: never compared literally.
  for (const launchArgs of [["--exclude-tools", "b*"], ["-xt", "tool_*"], ["--tools", `read,${DEFERRED_TOOL_SEARCH_NAME},+bash`], ["-t", `read,${DEFERRED_TOOL_SEARCH_NAME},-bash`]]) {
    assert.throws(
      () => resolve(launchArgs),
      (error: unknown) => error instanceof NativeWorkerToolCeilingRefusedError
        && (error.code === "launch-restriction-unconfirmed" || error.code === "launch-args-unparsable"),
      launchArgs.join(" "),
    );
  }
  assert.equal(reasonOf(resolve(["--exclude-tools", "BASH"]), "bash"), "launch-restriction");
  // --no-extensions disables Pi's builtin extension set, the source of native codemode.
  for (const flag of ["--no-extensions", "-ne"]) {
    const ceiling = resolve([flag]);
    assert.equal(reasonOf(ceiling, CODEMODE_TOOL_NAME), "launch-restriction", flag);
    assert.ok(ceiling.parentCeiling.includes("read") && ceiling.parentCeiling.includes(APPLY_PATCH_TOOL_NAME));
    assert.ok(resolve([flag, "--extension", "builtin:codemode"]).parentCeiling.includes(CODEMODE_TOOL_NAME), `${flag} with builtin:codemode`);
  }
  for (const name of [USER_QUESTION_TOOL_NAME, YOU_SHOULD_KNOW_TOOL_NAME]) assert.equal(reasonOf(unrestricted, name), "worker-unregistered");
  // Pi's literal `--` ends options: a later restriction word is message data,
  // but the conservative token guard still refuses rather than guess.
  assert.throws(() => resolve(["--", "--no-tools"]), NativeWorkerToolCeilingRefusedError);
  assert.throws(() => resolve(["--tools=read"]), NativeWorkerToolCeilingRefusedError);
  for (const args of [
    ["--exclude-tools", "read", "--exclude-tools=bash"],
    ["--exclude-tools", "read", "--model", "-xt"],
    ["--exclude-tools", "read", "-xt", "bash"],
    ["--no-builtin-tools=1"],
  ]) {
    assert.throws(
      () => resolve(args),
      (error: unknown) => error instanceof NativeWorkerToolCeilingRefusedError && error.code === "launch-restriction-unconfirmed",
      args.join(" "),
    );
  }
  assert.deepEqual(readdirSync(workspace), [], "nothing is created in the workspace");
});
