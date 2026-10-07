import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

/**
 * One-command session host entry points (issue 323): scripts/
 * pi-review-sessions.sh (POSIX) and scripts/pi-review-sessions.cmd (native
 * Windows). The .sh requires a supported Node (>= 22.19.0, stable floor)
 * already on PATH — automatic isolated Node fallback remains unfinished, so
 * no non-PATH Node binary is ever selected or executed — and dispatches to
 * the shared setup/runtime selection CJS; the .cmd checks the Node floor
 * with Node itself and delegates. All fixtures stay inside the worker root;
 * no real HOME, SDK, global npm root, or network access is used by committed
 * tests.
 */

const shPath = resolve("scripts/pi-review-sessions.sh");
const cmdPath = resolve("scripts/pi-review-sessions.cmd");
const cjsPath = resolve("scripts/pi-review-sessions.cjs");
const isWindows = process.platform === "win32";

interface EntrypointFixture {
  root: string;
  home: string;
  bin: string;
  agentDir: string;
  nodeLog: string;
}

function makeEntrypointFixture(prefix: string): EntrypointFixture {
  const root = mkdtempSync(join(process.cwd(), prefix));
  const fixture = {
    root,
    home: join(root, "home"),
    bin: join(root, "bin"),
    agentDir: join(root, "agent dir π"),
    nodeLog: join(root, "node-invocations.jsonl"),
  };
  mkdirSync(fixture.home, { recursive: true });
  mkdirSync(fixture.bin, { recursive: true });
  return fixture;
}

function cleanupFixture(t: TestContext, fixture: EntrypointFixture): void {
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
}

/**
 * A fake node for entry-point tests. POSIX: an executable that reports a
 * fixed version for --version, records every other dispatch argument one per
 * line, and appends one JSON env record to `<log>.env` on every invocation so
 * tests can assert what environment each child actually inherited.
 * Windows: a Node preload (loaded via NODE_OPTIONS --require) that intercepts
 * the real test-runtime node before any launcher setup runs — a batch-file
 * `node.cmd` fixture is not usable because the launcher invokes `node`
 * without CALL, and batch-to-batch control transfer would abandon the
 * launcher at its first probe. The preload exits with the floor-check status
 * for `-e` invocations (detected via execArgv) before writing anything, and
 * records dispatch argv otherwise; `--version` never loads preloads, so the
 * real runtime version is reported.
 */
function writeFakeNode(dir: string, version: string, log: string, options: { exitCode?: number; eExit?: number } = {}): string {
  const exitCode = options.exitCode ?? 0;
  if (isWindows) {
    const file = join(dir, "fake-node-preload.cjs");
    writeFileSync(file, [
      `if (process.execArgv.includes("-e")) process.exit(${options.eExit ?? 0});`,
      `require("node:fs").writeFileSync(process.env.FAKE_NODE_LOG, process.argv.slice(1).join("\\n") + "\\n");`,
      `process.exit(${exitCode});`,
      "",
    ].join("\n"), "utf8");
    return file;
  }
  const file = join(dir, "node");
  writeFileSync(file, [
    "#!/bin/bash",
    `printf '{"path":"%s","bootstrap":"%s","restore":"%s","nodeOptions":"%s"}\\n' "\${PATH:-}" "\${PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP:-}" "\${PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE:-}" "\${NODE_OPTIONS:-}" >> "${log}.env"`,
    `if [[ "\${1:-}" == "--version" ]]; then printf '%s\\n' "${version}"; exit 0; fi`,
    `for arg in "$@"; do printf '%s\\n' "$arg" >> "${log}"; done`,
    `exit ${exitCode}`,
    "",
  ].join("\n"), "utf8");
  chmodSync(file, 0o755);
  return file;
}

/** One recorded child env (probe or dispatch), in invocation order. */
function recordedEnvs(fixture: EntrypointFixture): Array<{ path: string; bootstrap: string; restore: string; nodeOptions: string }> {
  const envLog = `${fixture.nodeLog}.env`;
  assert.ok(existsSync(envLog), "the fake node must have been invoked");
  return readFileSync(envLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function runSh(fixture: EntrypointFixture, args: string[], envOverrides: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  // /bin/bash exists on macOS and Linux CI; the bounded PATH must not be
  // required to find the interpreter itself.
  const result = spawnSync("/bin/bash", [shPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: fixture.bin,
      HOME: fixture.home,
      FAKE_NODE_LOG: fixture.nodeLog,
      ...envOverrides,
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The single recorded dispatch argv (one argument per line on POSIX). */
function recordedDispatch(fixture: EntrypointFixture): string[] {
  assert.ok(existsSync(fixture.nodeLog), "the fake node must have been dispatched");
  return readFileSync(fixture.nodeLog, "utf8").trim().split("\n");
}

// ---------------------------------------------------------------------------
// POSIX entry point (scripts/pi-review-sessions.sh)
// ---------------------------------------------------------------------------

test(".sh rejects executor role contexts before any child process runs", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-role-");
  cleanupFixture(t, fixture);
  writeFakeNode(fixture.bin, "v24.18.1", fixture.nodeLog);

  for (const roleVar of ["PI_REVIEW_GATE_RUNTIME_ROLE", "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG"] as const) {
    const result = runSh(fixture, ["--help"], { [roleVar]: "executor" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsupported role context \(\w+\)/);
  }
  // No probe or dispatch child ran at all.
  assert.ok(!existsSync(fixture.nodeLog), "no node invocation in a role context");
  assert.ok(!existsSync(`${fixture.nodeLog}.env`), "no node env record in a role context");
});

test(".sh dispatches to the shared CJS with a supported PATH node and exact arguments", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-dispatch-");
  cleanupFixture(t, fixture);
  writeFakeNode(fixture.bin, "v24.18.1", fixture.nodeLog);

  // Host authorization markers and the user's own NODE_OPTIONS: the markers
  // must be cleared before any child runs; NODE_OPTIONS passes through.
  const result = runSh(fixture, ["--state-root", "./state dir", "--sidebar-key", "f8", "--", "--scheduler", "雪"], {
    PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "bootstrap-secret",
    PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE: "restore-secret",
    NODE_OPTIONS: "--no-warnings",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(recordedDispatch(fixture), [cjsPath, "--state-root", "./state dir", "--sidebar-key", "f8", "--", "--scheduler", "雪"]);
  for (const env of recordedEnvs(fixture)) {
    assert.equal(env.bootstrap, "", "host bootstrap marker is cleared before children");
    assert.equal(env.restore, "", "host restore marker is cleared before children");
    assert.equal(env.nodeOptions, "--no-warnings", "the user's NODE_OPTIONS passes through");
  }
});

test(".sh propagates the CJS exit status", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-exit-");
  cleanupFixture(t, fixture);
  writeFakeNode(fixture.bin, "v22.19.0", fixture.nodeLog, { exitCode: 42 });

  const result = runSh(fixture, ["--help"]);
  assert.equal(result.status, 42);
});

test(".sh requires a supported PATH node and never executes an unverified cached runtime", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-guard-");
  cleanupFixture(t, fixture);
  writeFakeNode(fixture.bin, "v22.18.9", fixture.nodeLog);
  // A manufactured cache: an arbitrary executable at the pinned path plus a
  // self-asserted provenance manifest. The guard must fail before this binary
  // is ever executed and leave the cache untouched.
  const nodeCacheDir = join(fixture.agentDir, ".pi-review-gate", "node", "v22.19.0");
  const cachedNodeDir = join(nodeCacheDir, "bin");
  mkdirSync(cachedNodeDir, { recursive: true });
  const cacheLog = join(fixture.root, "cached-node-invocations.jsonl");
  writeFakeNode(cachedNodeDir, "v22.19.0", cacheLog);
  writeFileSync(join(nodeCacheDir, ".provenance"), "pi-review-gate-node-provenance v1\nplatform=fabricated\n", "utf8");
  const sentinel = join(nodeCacheDir, "sentinel.txt");
  writeFileSync(sentinel, "preserve me\n", "utf8");

  const result = runSh(fixture, ["--help"], { PI_CODING_AGENT_DIR: fixture.agentDir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node\.js 22\.19\.0 or newer is required on PATH \(found v22\.18\.9\); automatic isolated Node fallback is not available in this phase\./);
  // The cached binary was never executed; the cache is preserved untouched.
  assert.ok(!existsSync(cacheLog), "the cached node must never be executed");
  assert.ok(!existsSync(`${cacheLog}.env`), "the cached node must never be executed (env record)");
  assert.equal(readFileSync(sentinel, "utf8"), "preserve me\n", "existing cache resources are preserved");
});

test(".sh fails closed when no node is on PATH", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-nonode-");
  cleanupFixture(t, fixture);
  // Empty bounded PATH: no node at all.

  const result = runSh(fixture, ["--help"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Node\.js 22\.19\.0 or newer is required on PATH; automatic isolated Node fallback is not available in this phase\./);
  assert.ok(!existsSync(fixture.nodeLog), "no dispatch without a supported node");
});

test(".sh honors a pre-release PATH node floor exactly like the CJS", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-prerelease-");
  cleanupFixture(t, fixture);
  // 22.19.0-rc.1 is below the stable floor: a pre-release build never counts
  // at the exact floor, and no fallback is attempted.
  writeFakeNode(fixture.bin, "v22.19.0-rc.1", fixture.nodeLog);

  const result = runSh(fixture, ["--help"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required on PATH \(found v22\.19\.0-rc\.1\); automatic isolated Node fallback is not available/);
});

// ---------------------------------------------------------------------------
// Native Windows entry point (scripts/pi-review-sessions.cmd)
// ---------------------------------------------------------------------------

test(".cmd entry point stays thin: Node floor check plus unconditional delegation", async () => {
  const source = readFileSync(cmdPath, "utf8");
  assert.ok(source.includes("\r\n"), "the batch file must keep CRLF line endings");
  // Capability isolation before the node -e probe child runs.
  assert.match(source, /if defined PI_REVIEW_GATE_RUNTIME_ROLE \(\s*\r?\n\s*echo pi-review-sessions: unsupported role context/,
    "executor role contexts must be rejected before any probe");
  assert.match(source, /set "PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP="/m, "the host bootstrap marker must be cleared before children");
  assert.match(source, /set "PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE="/m, "the host restore marker must be cleared before children");
  assert.match(source, /^where node >nul 2>nul$/m, "the .cmd must require Node on PATH");
  assert.match(source, /^node -e "const m=process\.versions\.node\.match/m, "the Node floor check must run with Node itself (no batch version arithmetic)");
  assert.match(source, /^node "%~dp0pi-review-sessions\.cjs" %\*$/m, "the .cmd must delegate unconditionally to the shared helper with raw argument passthrough");
  assert.match(source, /^exit \/b %ERRORLEVEL%$/m, "the .cmd must propagate the helper's exit status");
  assert.doesNotMatch(source, /call pi|goto /, "no batch-side verb dispatch or shell reparsing may remain");
});

if (isWindows) {
  test("native .cmd dispatches to the shared CJS with a supported node", async (t) => {
    const fixture = makeEntrypointFixture(".session-host-entry-cmd-dispatch-");
    cleanupFixture(t, fixture);
    const preload = writeFakeNode(fixture.bin, "v22.19.0", fixture.nodeLog);
    const result = spawnSync("cmd.exe", ["/d", "/c", `scripts\\pi-review-sessions.cmd --help`], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fixture.home,
        USERPROFILE: fixture.home,
        TEMP: fixture.root,
        TMP: fixture.root,
        // Executor role contexts are rejected by the entry point itself.
        PI_REVIEW_GATE_RUNTIME_ROLE: undefined,
        PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG: undefined,
        NODE_OPTIONS: `--require="${preload.replace(/\\/g, "/")}"`,
        FAKE_NODE_LOG: fixture.nodeLog,
      },
      windowsVerbatimArguments: true,
    });
    assert.equal(result.status, 0, result.stderr);
    const dispatch = readFileSync(fixture.nodeLog, "utf8").trim().split("\n");
    assert.deepEqual(dispatch, [cjsPath, "--help"]);
  });

  test("native .cmd rejects an unsupported node with a bounded diagnostic", async (t) => {
    const fixture = makeEntrypointFixture(".session-host-entry-cmd-oldnode-");
    cleanupFixture(t, fixture);
    const preload = writeFakeNode(fixture.bin, "v20.11.0", fixture.nodeLog, { eExit: 1 });
    const result = spawnSync("cmd.exe", ["/d", "/c", `scripts\\pi-review-sessions.cmd --help`], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: fixture.home,
        USERPROFILE: fixture.home,
        TEMP: fixture.root,
        TMP: fixture.root,
        // Executor role contexts are rejected by the entry point itself.
        PI_REVIEW_GATE_RUNTIME_ROLE: undefined,
        PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG: undefined,
        NODE_OPTIONS: `--require="${preload.replace(/\\/g, "/")}"`,
        FAKE_NODE_LOG: fixture.nodeLog,
      },
      windowsVerbatimArguments: true,
    });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /Node\.js 22\.19\.0 or newer is required/);
    assert.ok(!existsSync(fixture.nodeLog), "no dispatch for an unsupported node");
  });
}
