/**
 * Portable regressions for the Windows console-attachment probe fixture
 * (Refs #494). A fake synchronous spawn is used; no PowerShell, ConPTY, or
 * Windows host runs here, so a passing run is not Windows host proof.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";

interface SpawnCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
}
interface ProbeModule {
  readonly PRODUCTION_OWNER_QUERY: string;
  readonly PRODUCTION_OWNER_QUERY_PIECES: readonly string[];
  readonly PROBE_CHILD_CAP_MS: number;
  readonly PROBE_VARIANT_IDS: readonly string[];
  runConsoleProbe(options: Record<string, unknown>): { v: number; context: string; capMs: number; records: Record<string, unknown>[] };
  isConsoleProbeResult(value: unknown): boolean;
  formatConsoleProbe(value: unknown): string;
}

const probe = createRequire(join(process.cwd(), "package.json"))(
  join(process.cwd(), "tests", "fixtures", "session-host-windows-console-probe.cjs"),
) as ProbeModule;

const ENVS = { harness: { PATH: "harness-path" }, profile: { PATH: "harness-path", PSModulePath: "profile" } };

function runWith(reply: (call: SpawnCall) => Record<string, unknown>, isAlive: (pid: number) => boolean = () => false) {
  const calls: SpawnCall[] = [];
  let clock = 0;
  const result = probe.runConsoleProbe({
    context: "direct",
    powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    node: "C:\\node\\node.exe",
    envs: ENVS,
    pid: 4242,
    now: () => (clock += 5),
    isAlive,
    spawnSync: (file: string, args: string[], options: Record<string, unknown>) => {
      const call = { file, args, options };
      calls.push(call);
      return reply(call);
    },
  });
  return { result, calls };
}

function okReply(call: SpawnCall): Record<string, unknown> {
  const stdout = call.args.includes("--version") ? "v24.11.0\n"
    : call.args.includes("$PSVersionTable.PSVersion.ToString()") ? "5.1.26100.1\r\n"
      : "win32:2026-10-24T05:20:14.0000000Z";
  return { pid: 100 + call.args.length, status: 0, signal: null, stdout };
}

test("the probe runs the exact fixed matrix in order with the production deadline and stdio shape", () => {
  const { result, calls } = runWith(okReply);
  assert.equal(calls.length, probe.PROBE_VARIANT_IDS.length);
  assert.equal(probe.PROBE_CHILD_CAP_MS, 10_000, "the production synchronous Windows owner-query cap, never raised");
  assert.deepEqual(result.records.map((record) => record.id), probe.PROBE_VARIANT_IDS);
  for (const call of calls) {
    assert.equal(call.options.timeout, 10_000);
    assert.deepEqual(call.options.stdio, ["ignore", "pipe", "ignore"]);
    assert.equal(call.options.encoding, "utf8");
  }
  const byId = new Map(probe.PROBE_VARIANT_IDS.map((id, index) => [id, calls[index]!]));
  // Console attachment axis: only the documented public options differ.
  assert.equal(byId.get("ps-cmdlet/hidden/harness")!.options.windowsHide, true);
  assert.equal(Object.hasOwn(byId.get("ps-cmdlet/hidden/harness")!.options, "detached"), false);
  assert.equal(byId.get("ps-cmdlet/shared/harness")!.options.windowsHide, false);
  assert.equal(Object.hasOwn(byId.get("ps-cmdlet/shared/harness")!.options, "detached"), false);
  assert.equal(byId.get("ps-cmdlet/detached/harness")!.options.windowsHide, true);
  assert.equal(byId.get("ps-cmdlet/detached/harness")!.options.detached, true);
  // Environment axis: exact caller-supplied objects, never process.env.
  assert.equal(byId.get("ps-cmdlet/hidden/harness")!.options.env, ENVS.harness);
  assert.equal(byId.get("ps-cmdlet/hidden/profile")!.options.env, ENVS.profile);
  // Command axis: the production cmdlet query for the given pid as a fixed argv entry.
  const cmdlet = byId.get("ps-cmdlet/hidden/harness")!;
  assert.deepEqual(cmdlet.args, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    probe.PRODUCTION_OWNER_QUERY, "4242"]);
  const dotnet = byId.get("ps-dotnet/hidden/harness")!;
  assert.match(dotnet.args[6]!, /\[System\.Diagnostics\.Process\]::GetProcessById\(\$OwnerPid\)/);
  assert.doesNotMatch(dotnet.args[6]!, /Get-Process/);
  assert.deepEqual(byId.get("node-version/hidden/harness")!.args, ["--version"]);
  assert.equal(byId.get("node-version/hidden/harness")!.file, "C:\\node\\node.exe");
  assert.ok(result.records.every((record) => record.outcome === "ok" && record.childGone === true));
  assert.equal(probe.isConsoleProbeResult(result), true);
});

test("the probe's production query is byte-identical to both production Windows owner queries", () => {
  assert.equal(probe.PRODUCTION_OWNER_QUERY, probe.PRODUCTION_OWNER_QUERY_PIECES.join(""));
  for (const source of ["src/session-host/roster-store.ts", "scripts/managed-generations.cjs"]) {
    const text = readFileSync(join(process.cwd(), source), "utf8");
    for (const piece of probe.PRODUCTION_OWNER_QUERY_PIECES) {
      assert.ok(text.includes(JSON.stringify(piece)) || text.includes(`'${piece}'`) || text.includes(`"${piece}"`),
        `${source} still concatenates the same literal piece`);
    }
  }
});

test("the probe classifies timeouts, failures, and retained children with fixed vocabulary only", () => {
  const { result } = runWith((call) => {
    if (call.args.includes("4242") && call.options.windowsHide === true && call.options.detached === undefined
      && call.options.env === ENVS.harness && call.args[6]!.includes("Get-Process")) {
      return { pid: 7, status: null, signal: "SIGTERM", stdout: "", error: Object.assign(new Error("spawnSync C:\\secret ETIMEDOUT"), { code: "ETIMEDOUT" }) };
    }
    if (call.options.windowsHide === false) return { pid: 8, status: 3, signal: null, stdout: "noise C:\\path" };
    if (call.options.detached === true) return { pid: 9, status: 0, signal: null, stdout: "unexpected C:\\path" };
    if (call.options.env === ENVS.profile) return { status: null, signal: null, stdout: "", error: Object.assign(new Error("x"), { code: "EWEIRD" }) };
    return okReply(call);
  }, (pid) => pid === 8);
  const outcome = (id: string) => result.records.find((record) => record.id === id)!;
  assert.equal(outcome("ps-cmdlet/hidden/harness").outcome, "timeout");
  assert.equal(outcome("ps-cmdlet/hidden/harness").code, "ETIMEDOUT");
  assert.equal(outcome("ps-cmdlet/hidden/harness").signal, "SIGTERM");
  assert.equal(outcome("ps-cmdlet/shared/harness").outcome, "exit-nonzero");
  assert.equal(outcome("ps-cmdlet/shared/harness").childGone, false, "a still-live pid is reported, never hidden");
  assert.equal(outcome("ps-cmdlet/detached/harness").outcome, "output-mismatch");
  assert.equal(outcome("ps-cmdlet/hidden/profile").outcome, "spawn-error");
  assert.equal(outcome("ps-cmdlet/hidden/profile").code, "other");
  assert.equal(outcome("ps-cmdlet/hidden/profile").childGone, null);
  assert.equal(probe.isConsoleProbeResult(result), true);
  const line = probe.formatConsoleProbe(result);
  assert.match(line, /^console-probe direct: /);
  assert.match(line, /ps-cmdlet\/hidden\/harness=timeout\(5ms signal=SIGTERM code=ETIMEDOUT\)/);
  assert.match(line, /ps-cmdlet\/shared\/harness=exit-nonzero\(5ms status=3 childGone=false\)/);
  for (const leaked of ["secret", "C:\\", "noise", "unexpected", "4242", "harness-path"]) {
    assert.equal(JSON.stringify(result).includes(leaked), false, `no raw ${leaked} in the result`);
    assert.equal(line.includes(leaked), false, `no raw ${leaked} in the summary`);
  }
});

test("a thrown spawn is a bounded spawn-error and the matrix still completes", () => {
  const { result, calls } = runWith((call) => {
    if (call.options.windowsHide === false) throw new Error("boom C:\\secret");
    return okReply(call);
  });
  assert.equal(calls.length, probe.PROBE_VARIANT_IDS.length);
  const shared = result.records.find((record) => record.id === "ps-cmdlet/shared/harness")!;
  assert.deepEqual({ outcome: shared.outcome, code: shared.code, status: shared.status, childGone: shared.childGone },
    { outcome: "spawn-error", code: "other", status: null, childGone: null });
});

test("the strict result validator rejects altered, partial, reordered, and extended results", () => {
  const { result } = runWith(okReply);
  const clone = () => JSON.parse(JSON.stringify(result)) as { [key: string]: unknown; records: Record<string, unknown>[] };
  assert.equal(probe.isConsoleProbeResult(clone()), true);
  const extra = clone();
  extra.raw = "x";
  assert.equal(probe.isConsoleProbeResult(extra), false);
  const partial = clone();
  partial.records.pop();
  assert.equal(probe.isConsoleProbeResult(partial), false);
  const reordered = clone();
  reordered.records.reverse();
  assert.equal(probe.isConsoleProbeResult(reordered), false);
  const extended = clone();
  extended.records[0]!.stdout = "v1";
  assert.equal(probe.isConsoleProbeResult(extended), false);
  const badOutcome = clone();
  badOutcome.records[1]!.outcome = "fixed";
  assert.equal(probe.isConsoleProbeResult(badOutcome), false);
  const badContext = clone();
  badContext.context = "elsewhere";
  assert.equal(probe.isConsoleProbeResult(badContext), false);
  const raisedCap = clone();
  raisedCap.capMs = 20_000;
  assert.equal(probe.isConsoleProbeResult(raisedCap), false);
  assert.equal(probe.isConsoleProbeResult(null), false);
  assert.equal(probe.formatConsoleProbe(extra), "console-probe: invalid result");
});
