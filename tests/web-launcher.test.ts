import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

interface FixtureOptions {
  source: boolean;
  packagedCli: boolean;
  ddgs: "create-repair" | "valid" | "fail";
  nodeStatus?: number;
  buildStatus?: number;
}

interface WebFixture {
  root: string;
  wrapper: string;
  capture: string;
  venv: string;
  env: NodeJS.ProcessEnv;
}

interface Invocation {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  spawnError?: Error;
}

const POSIX_ONLY = process.platform === "win32" ? "The production web launcher is a POSIX shell wrapper." : false;
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Own one isolated fixture root and register cleanup before any setup can fail.
 * The actual production wrappers are copied byte-for-byte into this root; only
 * their external commands are replaced with bounded recording stubs.
 */
async function withWebFixture<T>(options: FixtureOptions, run: (fixture: WebFixture) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pi-review-web-launcher-"));
  try {
    const scripts = join(root, "scripts");
    const bin = join(root, "bin");
    const capture = join(root, "capture");
    const home = join(root, "home");
    const venv = join(root, "ddgs-venv");
    await mkdir(scripts, { recursive: true });
    await mkdir(bin, { recursive: true });
    await mkdir(capture, { recursive: true });
    await mkdir(home, { recursive: true });

    const wrapper = join(scripts, "pi-review-web.sh");
    await writeFile(wrapper, await readFile(resolve("scripts/pi-review-web.sh")));
    await writeFile(join(scripts, "ensure-ddgs.sh"), await readFile(resolve("scripts/ensure-ddgs.sh")));
    await chmod(wrapper, 0o755);
    await chmod(join(scripts, "ensure-ddgs.sh"), 0o755);

    if (options.source) {
      await mkdir(join(root, "src", "web"), { recursive: true });
      await writeFile(join(root, "src", "web", "cli.ts"), "// source-presence fixture\n");
    }
    if (options.packagedCli) {
      await mkdir(join(root, "dist", "src", "web"), { recursive: true });
      await writeFile(join(root, "dist", "src", "web", "cli.js"), "// packaged-cli fixture\n");
    }

    const ddgsPython = join(capture, "ddgs-python");
    await writeFile(ddgsPython, [
      "#!/bin/bash",
      "{ printf '%s\\t' \"$@\"; printf '\\n'; } >> \"$CAPTURE_DIR/python-calls\"",
      'if [[ "$1" == "-I" && "$2" == "-c" ]]; then',
      '  count="$(cat "$CAPTURE_DIR/validation-count" 2>/dev/null || printf \'0\')"',
      '  count=$((count + 1))',
      '  printf \'%s\\n\' "$count" > "$CAPTURE_DIR/validation-count"',
      '  case "${DDGS_VALIDATION_MODE:-repair}" in',
      '    valid) exit 0 ;;',
      '    fail) exit 1 ;;',
      '    repair) [[ "$count" -gt 1 ]] && exit 0; exit 1 ;;',
      '    *) exit 92 ;;',
      "  esac",
      "fi",
      'if [[ "$1" == "-I" && "$2" == "-m" && "$3" == "pip" ]]; then exit 0; fi',
      "exit 93",
      "",
    ].join("\n"), "utf8");
    await chmod(ddgsPython, 0o755);

    const python3 = join(bin, "python3");
    await writeFile(python3, [
      "#!/bin/bash",
      "{ printf '%s\\t' \"$@\"; printf '\\n'; } >> \"$CAPTURE_DIR/python3-calls\"",
      'if [[ "$1" == "-I" && "$2" == "-m" && "$3" == "venv" && -n "$4" ]]; then',
      '  mkdir -p "$4/bin"',
      '  cp "$CAPTURE_DIR/ddgs-python" "$4/bin/python"',
      '  chmod 755 "$4/bin/python"',
      "  exit 0",
      "fi",
      "exit 94",
      "",
    ].join("\n"), "utf8");
    await chmod(python3, 0o755);
    if (options.ddgs !== "create-repair") {
      await mkdir(join(venv, "bin"), { recursive: true });
      await writeFile(join(venv, "bin", "python"), await readFile(ddgsPython));
      await chmod(join(venv, "bin", "python"), 0o755);
    }

    const npm = join(bin, "npm");
    await writeFile(npm, [
      "#!/bin/bash",
      "printf '%s\\0' \"$@\" > \"$CAPTURE_DIR/npm-args\"",
      '[[ "$1" == "--prefix" && "$3" == "run" && "$4" == "build" ]] || exit 95',
      '[[ "${BUILD_STATUS:-0}" == "0" ]] || exit "$BUILD_STATUS"',
      'mkdir -p "$2/dist/src/web"',
      "printf '%s\\n' '// built-cli fixture' > \"$2/dist/src/web/cli.js\"",
      "",
    ].join("\n"), "utf8");
    await chmod(npm, 0o755);

    const node = join(bin, "node");
    await writeFile(node, [
      `#!${process.execPath}`,
      '"use strict";',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const args = process.argv.slice(2);',
      'fs.writeFileSync(path.join(process.env.CAPTURE_DIR, "node.json"), JSON.stringify({',
      '  args,',
      '  cliExists: fs.existsSync(args[0]),',
      '  ddgsPython: process.env.PI_REVIEW_GATE_DDGS_PYTHON,',
      '}));',
      'process.exit(Number(process.env.NODE_STATUS || 0));',
      "",
    ].join("\n"), "utf8");
    await chmod(node, 0o755);

    const fixture: WebFixture = {
      root,
      wrapper,
      capture,
      venv,
      env: {
        HOME: home,
        TMPDIR: root,
        XDG_CACHE_HOME: join(root, "cache"),
        PATH: `${bin}${delimiter}/usr/bin:/bin`,
        CAPTURE_DIR: capture,
        PI_REVIEW_GATE_DDGS_VENV: venv,
        // Prove that ensure-ddgs replaces, rather than leaks, an inherited value.
        PI_REVIEW_GATE_DDGS_PYTHON: "/inherited/incorrect/python",
        DDGS_VALIDATION_MODE: options.ddgs === "create-repair" ? "repair" : options.ddgs,
        BUILD_STATUS: String(options.buildStatus ?? 0),
        NODE_STATUS: String(options.nodeStatus ?? 0),
      },
    };
    return await run(fixture);
  } finally {
    // runBounded resolves only after the child emits close; fixture cleanup is
    // therefore never allowed to race a live wrapper or inherited output pipe.
    await rm(root, { recursive: true, force: true });
  }
}

/** Run one wrapper with an elapsed deadline and wait for its close event. */
function runBounded(command: string, args: string[], options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<Invocation> {
  return new Promise((resolveInvocation) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError: Error | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const signalTree = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The child may have exited between the timeout and the signal.
      }
    };
    const stop = (): void => {
      signalTree("SIGTERM");
      killTimer = setTimeout(() => signalTree("SIGKILL"), 500);
      killTimer.unref();
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? 10_000);
    deadline.unref();

    const collect = (stream: NodeJS.ReadableStream, target: "stdout" | "stderr"): void => {
      stream.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (target === "stdout") stdout = Buffer.concat([stdout, buffer]);
        else stderr = Buffer.concat([stderr, buffer]);
        if (stdout.length + stderr.length > MAX_OUTPUT_BYTES && !outputLimitExceeded) {
          outputLimitExceeded = true;
          stop();
        }
      });
    };
    if (child.stdout) collect(child.stdout, "stdout");
    if (child.stderr) collect(child.stderr, "stderr");
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      resolveInvocation({
        status,
        signal,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        outputLimitExceeded,
        ...(spawnError ? { spawnError } : {}),
      });
    });
  });
}

function assertSettled(result: Invocation): void {
  assert.equal(result.timedOut, false, "wrapper invocation must finish before its deadline");
  assert.equal(result.outputLimitExceeded, false, "wrapper output must remain bounded");
  assert.equal(result.spawnError, undefined, result.spawnError?.message);
}

async function capturedNode(fixture: WebFixture): Promise<{ args: string[]; cliExists: boolean; ddgsPython: string }> {
  return JSON.parse(await readFile(join(fixture.capture, "node.json"), "utf8")) as {
    args: string[];
    cliExists: boolean;
    ddgsPython: string;
  };
}

async function nulArgs(file: string): Promise<string[]> {
  const body = await readFile(file, "utf8");
  const values = body.split("\0");
  if (values.at(-1) === "") values.pop();
  return values;
}

async function assertDdgsRepairContract(fixture: WebFixture): Promise<void> {
  const calls = (await readFile(join(fixture.capture, "python-calls"), "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
  assert.ok(calls.length >= 4, `expected isolated DDGS validation/install calls, got ${JSON.stringify(calls)}`);
  assert.ok(calls.every((args) => args[0] === "-I"), "every venv Python invocation must use isolated -I mode");
  const validations = calls.filter((args) => args[1] === "-c");
  assert.ok(validations.length >= 2, "the installed dependency must be validated before and after repair");
  assert.ok(validations.every((args) => args[2]?.includes('metadata.version("ddgs")')));
  assert.ok(validations.every((args) => args[3] === "9.16.0"), "validation must check the pinned DDGS version");
  const install = calls.find((args) => args[1] === "-m" && args[2] === "pip" && args[3] === "install");
  assert.ok(install, "a failed initial validation must invoke pip install");
  assert.ok(install?.includes("ddgs==9.16.0"), "repair must install the pinned DDGS version");
  assert.ok(calls.some((args) => args[1] === "-m" && args[2] === "pip" && args[3] === "check"));
}

test("actual source web wrapper creates and repairs DDGS, builds, and forwards exact arguments/status", { skip: POSIX_ONLY }, async () => {
  const userArgs = ["--query", "two words", "", "literal;$HOME *", "'quoted\"\\", "--", "-leading", "line\nbreak"];
  await withWebFixture({ source: true, packagedCli: false, ddgs: "create-repair", nodeStatus: 29 }, async (fixture) => {
    const result = await runBounded(fixture.wrapper, userArgs, { cwd: fixture.root, env: fixture.env });
    assertSettled(result);
    assert.equal(result.status, 29, "the web CLI exit status must be preserved");
    assert.equal(result.signal, null);
    assert.deepEqual(await nulArgs(join(fixture.capture, "npm-args")), ["--prefix", fixture.root, "run", "build"]);
    const cli = await capturedNode(fixture);
    assert.deepEqual(cli.args, [join(fixture.root, "dist", "src", "web", "cli.js"), ...userArgs]);
    assert.equal(cli.cliExists, true, "the build must provide the CLI path passed to Node");
    assert.equal(cli.ddgsPython, join(fixture.venv, "bin", "python"), "DDGS Python path must be exported from the actual helper");
    const creationCalls = (await readFile(join(fixture.capture, "python3-calls"), "utf8")).trim().split("\t");
    assert.deepEqual(creationCalls, ["-I", "-m", "venv", fixture.venv], "missing venv must be created by isolated python3");
    await assertDdgsRepairContract(fixture);
  });
});

test("actual source web wrapper stops at build failure and preserves npm status", { skip: POSIX_ONLY }, async () => {
  await withWebFixture({ source: true, packagedCli: false, ddgs: "valid", buildStatus: 47 }, async (fixture) => {
    const result = await runBounded(fixture.wrapper, ["--flag", "value"], { cwd: fixture.root, env: fixture.env });
    assertSettled(result);
    assert.equal(result.status, 47, "a failed build status must be returned unchanged");
    assert.deepEqual(await nulArgs(join(fixture.capture, "npm-args")), ["--prefix", fixture.root, "run", "build"]);
    await assert.rejects(readFile(join(fixture.capture, "node.json")), { code: "ENOENT" }, "Node must not run after build failure");
  });
});

test("actual packaged web wrapper skips the source build and preserves CLI arguments/status", { skip: POSIX_ONLY }, async () => {
  const userArgs = ["--search", "a value with spaces", "", "semi;colon", "--", "-x"];
  await withWebFixture({ source: false, packagedCli: true, ddgs: "valid", nodeStatus: 23 }, async (fixture) => {
    const result = await runBounded(fixture.wrapper, userArgs, { cwd: fixture.root, env: fixture.env });
    assertSettled(result);
    assert.equal(result.status, 23, "a packaged CLI status must be returned unchanged");
    const cli = await capturedNode(fixture);
    assert.deepEqual(cli.args, [join(fixture.root, "dist", "src", "web", "cli.js"), ...userArgs]);
    assert.equal(cli.cliExists, true, "the packaged CLI must be the Node entry path");
    assert.equal(cli.ddgsPython, join(fixture.venv, "bin", "python"));
    await assert.rejects(readFile(join(fixture.capture, "npm-args")), { code: "ENOENT" }, "packaged launches must not build");
    const calls = (await readFile(join(fixture.capture, "python-calls"), "utf8")).split("\n").filter(Boolean);
    assert.ok(calls.length > 0 && calls.every((call) => call.startsWith("-I\t")), "DDGS validation must stay isolated");
  });
});

test("actual packaged web wrapper fails closed when the compiled CLI is missing", { skip: POSIX_ONLY }, async () => {
  await withWebFixture({ source: false, packagedCli: false, ddgs: "valid" }, async (fixture) => {
    const result = await runBounded(fixture.wrapper, ["--should-not-run"], { cwd: fixture.root, env: fixture.env });
    assertSettled(result);
    assert.equal(result.status, 2);
    assert.ok(
      result.stderr.includes(`pi-review-web: packaged CLI is missing: ${join(fixture.root, "dist", "src", "web", "cli.js")}`),
      `missing packaged CLI diagnostic: ${result.stderr}`,
    );
    await assert.rejects(readFile(join(fixture.capture, "node.json")), { code: "ENOENT" });
    await assert.rejects(readFile(join(fixture.capture, "npm-args")), { code: "ENOENT" });
  });
});

test("actual web wrapper cannot hide failed DDGS validation behind a successful install", { skip: POSIX_ONLY }, async () => {
  await withWebFixture({ source: true, packagedCli: true, ddgs: "fail" }, async (fixture) => {
    const result = await runBounded(fixture.wrapper, ["--must-not-run"], { cwd: fixture.root, env: fixture.env });
    assertSettled(result);
    assert.equal(result.status, 1, "the helper's final validation failure must stop the wrapper");
    assert.match(result.stderr, /DDGS 9\.16\.0 is unavailable or has inconsistent dependencies/);
    assert.ok((await readFile(join(fixture.capture, "python-calls"), "utf8")).includes("install"), "the controlled repair install succeeds");
    await assert.rejects(readFile(join(fixture.capture, "npm-args")), { code: "ENOENT" }, "build must not follow provisioning failure");
    await assert.rejects(readFile(join(fixture.capture, "node.json")), { code: "ENOENT" }, "Node must not follow provisioning failure");
  });
});
