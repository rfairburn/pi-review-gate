// Web CLI wrapper (scripts/pi-review-web.sh): post-#344 contract.
//
// The wrapper no longer builds anything itself and no longer sources the DDGS
// setup script. It asks the ONE shared preparation authority whether the
// prepared application is current, gets an isolated prepared root plus the ready
// DDGS interpreter, and runs that root's compiled CLI. These tests drive the real
// production wrapper against a synthetic package tree and the real preparation
// code; only the external installer/compiler is a recording stand-in.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";

interface FixtureOptions {
  source: boolean;
  packagedCli: boolean;
  ddgs: "valid" | "fail";
  nodeStatus?: number;
  installStatus?: number;
}

interface WebFixture {
  root: string;
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
 * The production wrapper, the shared preparation authority, the compiled-engine
 * module, and the shipped skills are copied byte-for-byte into the fixture; only
 * the external installer/compiler and the launched Node CLI are recording stubs.
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
    for (const name of ["prepare-application.cjs", "application-build.cjs", "managed-generations.cjs"]) {
      await writeFile(join(scripts, name), await readFile(resolve("scripts", name)));
    }
    await chmod(wrapper, 0o755);
    await cp(resolve("skills"), join(root, "skills"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ name: "pi-review-gate", version: "0.1.0" })}\n`,
      "utf8",
    );
    await writeFile(join(root, "package-lock.json"), "{}\n", "utf8");
    await writeFile(join(root, "tsconfig.json"), "{}\n", "utf8");

    if (options.source) {
      await mkdir(join(root, "src", "web"), { recursive: true });
      await writeFile(join(root, "src", "index.ts"), "// source-presence fixture\n");
      await writeFile(join(root, "src", "web", "cli.ts"), "// source-presence fixture\n");
    }
    if (options.packagedCli) {
      for (const entry of ["dist/src/web/cli.js", "dist/src/index.js", "dist/src/session-host/main.js"]) {
        const file = join(root, ...entry.split("/"));
        await mkdir(join(file, ".."), { recursive: true });
        await writeFile(file, "// packaged-cli fixture\n");
      }
    }

    const ddgsPython = join(capture, "ddgs-python");
    await writeFile(ddgsPython, [
      "#!/bin/bash",
      'if [[ "$1" == "-I" && "$2" == "-c" ]]; then',
      '  [[ "${DDGS_VALIDATION_MODE:-valid}" == "valid" ]] && exit 0',
      "  exit 1",
      "fi",
      'if [[ "$1" == "-I" && "$2" == "-m" && "$3" == "pip" ]]; then exit 0; fi',
      "exit 93",
      "",
    ].join("\n"), "utf8");
    await chmod(ddgsPython, 0o755);
    await mkdir(join(venv, "bin"), { recursive: true });
    await writeFile(join(venv, "bin", "python"), await readFile(ddgsPython));
    await chmod(join(venv, "bin", "python"), 0o755);

    // A recording npm the shared resolver accepts: PATH's npm entry resolves
    // into an npm package whose manifest is the public JS CLI. A `ci` install
    // stages a synthetic TypeScript compiler that writes the required entries.
    const npmPackage = join(bin, "node_modules", "npm");
    await mkdir(join(npmPackage, "bin"), { recursive: true });
    await writeFile(
      join(npmPackage, "package.json"),
      `${JSON.stringify({ name: "npm", version: "10.0.0", bin: { npm: "bin/npm-cli.js" } })}\n`,
      "utf8",
    );
    const compiler = [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "for (const entry of [['dist','src','index.js'],['dist','src','session-host','main.js'],['dist','src','web','cli.js']]) {",
      "  const target = path.join(process.cwd(), '..'.repeat(0), ...entry);",
      "  fs.mkdirSync(path.dirname(target), { recursive: true });",
      "  fs.writeFileSync(target, '// built-cli fixture\\n');",
      "}",
      "process.exit(0);",
    ].join("\n");
    await writeFile(join(npmPackage, "bin", "npm-cli.js"), [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(join(capture, "npm-args"))}, JSON.stringify(process.argv.slice(2)));`,
      `const status = Number(process.env.INSTALL_STATUS ?? '0');`,
      "if (status !== 0) process.exit(status);",
      "if (process.argv[2] === 'ci') {",
      "  fs.mkdirSync('node_modules/typescript/bin', { recursive: true });",
      "  fs.writeFileSync('node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version: '5.7.2', bin: { tsc: 'bin/tsc' } }));",
      `  fs.writeFileSync('node_modules/typescript/bin/tsc', ${JSON.stringify(compiler)});`,
      "}",
      "process.exit(0);",
    ].join("\n"), "utf8");
    await symlink(join("node_modules", "npm", "bin", "npm-cli.js"), join(bin, "npm"));
    await chmod(join(bin, "npm"), 0o755);

    // Real preparation uses the real Node; only the final CLI launch is a
    // recording stub whose exit status the wrapper must propagate.
    const node = join(bin, "node");
    await writeFile(node, [
      `#!${process.execPath}`,
      '"use strict";',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const args = process.argv.slice(2);',
      'if (args[0] && args[0].endsWith("prepare-application.cjs")) {',
      '  const { spawnSync } = require("node:child_process");',
      `  const result = spawnSync(${JSON.stringify(process.execPath)}, [args[0], ...args.slice(1)], { cwd: process.cwd(), env: process.env, stdio: "inherit" });`,
      '  process.exit(result.status ?? 1);',
      "}",
      'fs.writeFileSync(path.join(process.env.CAPTURE_DIR, "node.json"), JSON.stringify({',
      '  args,',
      '  cliExists: fs.existsSync(args[0]),',
      '  ddgsPython: process.env.PI_REVIEW_GATE_DDGS_PYTHON,',
      "}));",
      'process.exit(Number(process.env.NODE_STATUS || 0));',
      "",
    ].join("\n"), "utf8");
    await chmod(node, 0o755);

    const fixture: WebFixture = {
      root,
      capture,
      venv,
      env: {
        HOME: home,
        TMPDIR: root,
        XDG_CACHE_HOME: join(root, "cache"),
        PATH: `${bin}${delimiter}/usr/bin:/bin`,
        CAPTURE_DIR: capture,
        PI_REVIEW_GATE_DDGS_VENV: venv,
        // Prove the wrapper's own export replaces an inherited value.
        PI_REVIEW_GATE_DDGS_PYTHON: "/inherited/incorrect/python",
        DDGS_VALIDATION_MODE: options.ddgs,
        INSTALL_STATUS: String(options.installStatus ?? 0),
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
    let settled = false;
    const finish = (result: Invocation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveInvocation(result);
    };
    const timer = setTimeout(() => {
      if (process.platform === "win32" || child.pid === undefined) child.kill();
      else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      finish({ status: null, signal: null, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut: true, outputLimitExceeded: false });
    }, options.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish({ status: null, signal: null, stdout: "", stderr: "", timedOut: false, outputLimitExceeded: true });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]);
      if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish({ status: null, signal: null, stdout: "", stderr: "", timedOut: false, outputLimitExceeded: true });
      }
    });
    child.once("error", (error) => {
      finish({ status: null, signal: null, stdout: "", stderr: "", timedOut: false, outputLimitExceeded: false, spawnError: error });
    });
    child.once("close", (status, signal) => {
      finish({ status, signal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut: false, outputLimitExceeded: false });
    });
  });
}

function runWrapper(fixture: WebFixture, args: string[] = ["--query", "example"]) {
  return runBounded("/bin/bash", [join(fixture.root, "scripts", "pi-review-web.sh"), ...args], {
    cwd: fixture.root,
    env: fixture.env,
  });
}

async function capturedNode(fixture: WebFixture): Promise<{ args: string[]; cliExists: boolean; ddgsPython: string } | null> {
  try {
    return JSON.parse(await readFile(join(fixture.capture, "node.json"), "utf8"));
  } catch {
    return null;
  }
}

test("actual source web wrapper prepares once, then reuses without npm or Python work", { skip: POSIX_ONLY }, async () => {
  await withWebFixture({ source: true, packagedCli: false, ddgs: "valid", nodeStatus: 29 }, async (fixture) => {
    const first = await runWrapper(fixture);
    assert.equal(first.status, 29, `the CLI's own status must propagate: ${first.stderr}`);
    const installed = JSON.parse(await readFile(join(fixture.capture, "npm-args"), "utf8")) as string[];
    assert.equal(installed[0], "ci", "the only install is the locked ci install");
    const cli = await capturedNode(fixture);
    assert.ok(cli);
    assert.equal(cli.cliExists, true, "the prepared CLI path passed to Node exists");
    assert.match(cli.args[0], /dist[\\/]src[\\/]web[\\/]cli\.js$/);
    assert.equal(cli.ddgsPython, join(fixture.venv, "bin", "python"), "DDGS Python path must be the ready interpreter");
    assert.deepEqual(cli.args.slice(1), ["--query", "example"]);

    // Warm: the same prepared root, no install, and the CLI still runs.
    await rm(join(fixture.capture, "npm-args"), { force: true });
    const second = await runWrapper(fixture);
    assert.equal(second.status, 29);
    assert.equal(await readFile(join(fixture.capture, "npm-args"), "utf8").then(() => true, () => false), false,
      "a current start performs no install");
    const warmCli = await capturedNode(fixture);
    assert.equal(warmCli?.args[0], cli.args[0], "the same prepared root is reused");
  });
});

test("a failed preparation stops the web wrapper and preserves the installer status", { skip: POSIX_ONLY }, async () => {
  await withWebFixture({ source: true, packagedCli: false, ddgs: "valid", installStatus: 47 }, async (fixture) => {
    const result = await runWrapper(fixture);
    assert.equal(result.status, 47, `a failed install status must be returned unchanged: ${result.stderr}`);
    assert.equal(await capturedNode(fixture), null, "the CLI must not run after a failed preparation");
    assert.doesNotMatch(result.stdout, /pi-review-web/u, "no launch diagnostics precede a failed preparation");
  });
});

test("actual packaged web wrapper skips preparation work and preserves CLI arguments/status", { skip: POSIX_ONLY }, async () => {
  await withWebFixture({ source: false, packagedCli: true, ddgs: "valid", nodeStatus: 23 }, async (fixture) => {
    const first = await runWrapper(fixture);
    assert.equal(first.status, 23);
    const cli = await capturedNode(fixture);
    assert.ok(cli);
    assert.equal(cli.cliExists, true);
    assert.equal(cli.ddgsPython, join(fixture.venv, "bin", "python"));
    assert.deepEqual(cli.args.slice(1), ["--query", "example"]);
    assert.equal(await readFile(join(fixture.capture, "npm-args"), "utf8").then(() => true, () => false), false,
      "packaged launches must not install or compile");

    const second = await runWrapper(fixture);
    assert.equal(second.status, 23, "a packaged package with its exact version stays current");
  });
});

test("a missing packaged CLI fails closed before the CLI runs", { skip: POSIX_ONLY }, async () => {
  await withWebFixture({ source: false, packagedCli: false, ddgs: "valid" }, async (fixture) => {
    const result = await runWrapper(fixture);
    assert.equal(result.status, 2, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /packaged extension output is missing/u);
    assert.equal(await capturedNode(fixture), null);
    assert.equal(await readFile(join(fixture.capture, "npm-args"), "utf8").then(() => true, () => false), false);
  });
});

test("a failing DDGS environment stops the wrapper before the CLI runs", { skip: POSIX_ONLY }, async () => {
  await withWebFixture({ source: false, packagedCli: true, ddgs: "fail" }, async (fixture) => {
    const result = await runWrapper(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DDGS setup failed/u);
    assert.equal(await capturedNode(fixture), null);
  });
});
