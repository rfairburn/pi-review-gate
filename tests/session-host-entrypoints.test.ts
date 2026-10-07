import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

/**
 * One-command session-host entry points (issue 323): scripts/
 * pi-review-sessions.sh (POSIX) and scripts/pi-review-sessions.cmd (native
 * Windows). They retain a supported PATH Node, or bootstrap only the fixed
 * source-pinned official Node 22.19.0 platform archive after verifying its
 * digest. Tests use synthetic downloader, hasher, and archive-tool fixtures;
 * they never fetch, extract, or execute the real official Node distribution.
 * Windows host-runtime tests are intentionally owned by the parent phase.
 */

const shPath = resolve("scripts/pi-review-sessions.sh");
const cmdPath = resolve("scripts/pi-review-sessions.cmd");
const psPath = resolve("scripts/pi-review-sessions-node.ps1");
const cjsPath = resolve("scripts/pi-review-sessions.cjs");
const isWindows = process.platform === "win32";

const POSIX_PINS: Record<string, string> = {
  "darwin-arm64": "c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d",
  "darwin-x64": "3cfed4795cd97277559763c5f56e711852d2cc2420bda1cea30c8aa9ac77ce0c",
  "linux-arm64": "d32817b937219b8f131a28546035183d79e7fd17a86e38ccb8772901a7cd9009",
  "linux-x64": "d36e56998220085782c0ca965f9d51b7726335aed2f5fc7321c6c0ad233aa96d",
};

interface EntrypointFixture {
  root: string;
  rootIdentity: string;
  markAssertionsPassed: () => void;
  home: string;
  bin: string;
  agentDir: string;
  nodeLog: string;
  phaseLog: string;
  commonScript: string;
  curlLog: string;
}

function makeEntrypointFixture(prefix: string): EntrypointFixture {
  const fixtureParent = join(process.cwd(), "node_modules", ".worker-private", "session-host-fixtures");
  mkdirSync(fixtureParent, { recursive: true });
  const root = mkdtempSync(join(fixtureParent, prefix));
  const rootStat = lstatSync(root);
  const fixture: EntrypointFixture = {
    root,
    rootIdentity: `${rootStat.dev}:${rootStat.ino}`,
    markAssertionsPassed: () => {},
    home: join(root, "home π"),
    bin: join(root, "bin tools"),
    agentDir: join(root, "agent dir π"),
    nodeLog: join(root, "node-invocations.txt"),
    phaseLog: join(root, "bootstrap-phases.tsv"),
    commonScript: join(root, "mock-common.sh"),
    curlLog: join(root, "curl-url.txt"),
  };
  mkdirSync(fixture.home, { recursive: true });
  mkdirSync(fixture.bin, { recursive: true });
  writeFileSync(fixture.commonScript, [
    "record_phase() {",
    "  printf '%s\\t%s\\t%s\\t%s\\n' \"$1\" \"${PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP:-}\" \"${PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE:-}\" \"${NODE_OPTIONS:-}\" >> \"$FAKE_BOOTSTRAP_PHASE_LOG\"",
    "}",
    "",
  ].join("\n"), "utf8");
  return fixture;
}

function removeFixtureTree(path: string): boolean {
  let containsTerraform = false;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === ".terraform") {
      containsTerraform = true;
      continue;
    }
    const childPath = join(path, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (removeFixtureTree(childPath)) containsTerraform = true;
    } else {
      unlinkSync(childPath);
    }
  }
  if (!containsTerraform) rmdirSync(path);
  return containsTerraform;
}

function removeFixtureIfOwned(fixture: EntrypointFixture, assertionsPassed: boolean): boolean {
  if (!assertionsPassed || !existsSync(fixture.root)) return false;
  const fixtureStat = lstatSync(fixture.root);
  if (!fixtureStat.isDirectory() || fixtureStat.isSymbolicLink()) return false;
  if (`${fixtureStat.dev}:${fixtureStat.ino}` !== fixture.rootIdentity) return false;
  removeFixtureTree(fixture.root);
  return true;
}

function cleanupFixture(t: TestContext, fixture: EntrypointFixture): void {
  let assertionsPassed = false;
  fixture.markAssertionsPassed = () => { assertionsPassed = true; };
  t.after(() => { removeFixtureIfOwned(fixture, assertionsPassed); });
}

test("synthetic fixture cleanup retains failed assertions and replaced roots", async (t) => {
  const fixture = makeEntrypointFixture(".session-host-fixture-cleanup-");
  cleanupFixture(t, fixture);
  assert.equal(removeFixtureIfOwned(fixture, false), false, "failed assertions retain the fixture witness");
  assert.ok(existsSync(fixture.root));

  const displacedRoot = `${fixture.root}.original`;
  renameSync(fixture.root, displacedRoot);
  mkdirSync(fixture.root);
  const replacementStat = lstatSync(fixture.root);
  const replacement: EntrypointFixture = {
    ...fixture,
    rootIdentity: `${replacementStat.dev}:${replacementStat.ino}`,
  };
  assert.equal(removeFixtureIfOwned(fixture, true), false, "a root whose identity changed is preserved");
  assert.ok(existsSync(fixture.root));
  assert.equal(removeFixtureIfOwned(replacement, true), true, "a matching replacement identity can be cleaned explicitly");
  assert.equal(existsSync(fixture.root), false);

  const displaced: EntrypointFixture = { ...fixture, root: displacedRoot };
  assert.equal(removeFixtureIfOwned(displaced, true), true, "the original directory remains independently identifiable");
  assert.equal(existsSync(displacedRoot), false);
  fixture.markAssertionsPassed();
});

function writeExecutable(file: string, source: string): void {
  writeFileSync(file, source, "utf8");
  chmodSync(file, 0o755);
}

/** A fake PATH Node used only to test the non-bootstrap preference path. */
function writeFakeNode(dir: string, version: string, log: string, options: { exitCode?: number } = {}): string {
  const exitCode = options.exitCode ?? 0;
  if (isWindows) {
    const file = join(dir, "fake-node-preload.cjs");
    writeFileSync(file, [
      `if (process.argv.includes(${JSON.stringify("--version")})) process.exit(0);`,
      `require("node:fs").writeFileSync(process.env.FAKE_NODE_LOG, process.argv.slice(1).join("\\n") + "\\n");`,
      `process.exit(${exitCode});`,
      "",
    ].join("\n"), "utf8");
    return file;
  }
  const file = join(dir, "node");
  writeExecutable(file, [
    "#!/bin/bash",
    "if [[ -n \"${FAKE_BOOTSTRAP_COMMON:-}\" && -f \"${FAKE_BOOTSTRAP_COMMON:-}\" ]]; then . \"$FAKE_BOOTSTRAP_COMMON\"; fi",
    `printf '%s\\t%s\\t%s\\t%s\\n' "\${PATH:-}" "\${PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP:-}" "\${PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE:-}" "\${NODE_OPTIONS:-}" >> "${log}.env"`,
    `if [[ "\${1:-}" == "--version" ]]; then printf '%s\\n' "${version}"; if declare -F record_phase >/dev/null; then record_phase path-node-version; fi; exit 0; fi`,
    `for arg in "$@"; do printf '%s\\n' "$arg" >> "${log}"; done`,
    `if declare -F record_phase >/dev/null; then record_phase path-node-dispatch; fi`,
    `exit ${exitCode}`,
    "",
  ].join("\n").replaceAll("\u0001", "\"${PATH:-}\"").replaceAll("\u0002", "\"${PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP:-}\"").replaceAll("\u0003", "\"${PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE:-}\"").replaceAll("\u0004", "\"${NODE_OPTIONS:-}\""));
  return file;
}

function writeBootstrapNode(fixture: EntrypointFixture, exitCode = 0): string {
  const file = join(fixture.root, "synthetic-node");
  writeExecutable(file, [
    "#!/bin/bash",
    ". \"$FAKE_BOOTSTRAP_COMMON\"",
    "if [[ \"${1:-}\" == \"--version\" ]]; then record_phase fallback-node-version; printf '%s\\n' 'v22.19.0'; exit 0; fi",
    "record_phase dispatch",
    "for arg in \"$@\"; do printf '%s\\n' \"$arg\" >> \"$FAKE_NODE_LOG\"; done",
    "printf '%s\\t%s\\t%s\\t%s\\t%s\\n' \"$PATH\" \"$PWD\" \"${NODE_OPTIONS:-}\" \"${PI_CODING_AGENT_DIR:-}\" \"$(umask)\" >> \"$FAKE_FALLBACK_ENV_LOG\"",
    `exit ${exitCode}`,
    "",
  ].join("\n"));
  return file;
}

function writeBootstrapTools(
  fixture: EntrypointFixture,
  options: { os?: string; arch?: string; digest?: string; httpStatus?: string; curlExit?: number; exitCode?: number; tarListing?: string[] } = {},
): void {
  const os = options.os ?? "Linux";
  const arch = options.arch ?? "x86_64";
  const digest = options.digest ?? POSIX_PINS["linux-x64"];
  const rootName = `node-v22.19.0-${os === "Darwin" ? `darwin-${arch === "arm64" || arch === "aarch64" ? "arm64" : "x64"}` : `linux-${arch === "arm64" || arch === "aarch64" ? "arm64" : "x64"}`}`;
  const listing = options.tarListing ?? [
    `${rootName}/`,
    `${rootName}/bin/`,
    `${rootName}/bin/node`,
    `${rootName}/bin/npm`,
    `${rootName}/lib/`,
    `${rootName}/lib/node_modules/`,
    `${rootName}/lib/node_modules/npm/`,
    `${rootName}/lib/node_modules/npm/bin/`,
    `${rootName}/lib/node_modules/npm/bin/npm-cli.js`,
  ];
  const commonHeader = ["#!/bin/bash", ". \"$FAKE_BOOTSTRAP_COMMON\""];

  writeExecutable(join(fixture.bin, "uname"), [
    ...commonHeader,
    "record_phase uname",
    "if [[ \"$1\" == \"-s\" ]]; then printf '%s\\n' \"${FAKE_UNAME_S:-Linux}\"; else printf '%s\\n' \"${FAKE_UNAME_M:-x86_64}\"; fi",
    "",
  ].join("\n"));
  writeExecutable(join(fixture.bin, "mkdir"), "#!/bin/bash\nexec /bin/mkdir \"$@\"\n");
  writeExecutable(join(fixture.bin, "mktemp"), [
    "#!/bin/bash",
    "[[ \"$1\" == \"-d\" ]] || exit 2",
    "template=\"$2\"",
    "prefix=\"${template%XXXXXXXX}\"",
    "candidate=\"${prefix}$$-$RANDOM\"",
    "/bin/mkdir -m 700 \"$candidate\" 2>/dev/null || exit 1",
    "printf '%s\\n' \"$candidate\"",
    "",
  ].join("\n"));
  writeExecutable(join(fixture.bin, "wc"), "#!/bin/bash\nexec /usr/bin/wc \"$@\"\n");
  writeExecutable(join(fixture.bin, "readlink"), "#!/bin/bash\nexec /usr/bin/readlink \"$@\"\n");
  writeExecutable(join(fixture.bin, "stat"), [
    "#!/bin/bash",
    "if [[ \"$1\" == \"-f\" && \"${FAKE_STAT_NATIVE:-Linux}\" == Linux ]]; then exec /usr/bin/stat -c \"$2\" \"$3\"; fi",
    "if [[ \"$1\" == \"-c\" && \"${FAKE_STAT_NATIVE:-Linux}\" == Darwin ]]; then exec /usr/bin/stat -f \"$2\" \"$3\"; fi",
    "exec /usr/bin/stat \"$@\"",
    "",
  ].join("\n"));
  writeExecutable(join(fixture.bin, "curl"), [
    ...commonHeader,
    "record_phase curl",
    "archive= url= writeout=",
    "while (($#)); do",
    "  case \"$1\" in",
    "    --output|--write-out) key=\"$1\"; value=\"$2\"; shift 2; if [[ \"$key\" == \"--output\" ]]; then archive=\"$value\"; else writeout=\"$value\"; fi;;",
    "    https://*) url=\"$1\"; shift;;",
    "    *) shift;;",
    "  esac",
    "done",
    "printf '%s\\n' \"$url\" > \"$FAKE_CURL_LOG\"",
    "printf '%s\\n' 'synthetic archive fixture' > \"$archive\"",
    "printf '%s' \"${FAKE_HTTP_STATUS:-200}\"",
    "exit \"${FAKE_CURL_EXIT:-0}\"",
    "",
  ].join("\n"));
  writeExecutable(join(fixture.bin, "shasum"), [
    ...commonHeader,
    "record_phase shasum",
    "printf '%s  synthetic-archive\\n' \"${FAKE_BOOTSTRAP_DIGEST}\"",
    "",
  ].join("\n"));
  const quotedListing = listing.map((entry) => `printf '%s\\n' '${entry}'`).join("\n");
  writeExecutable(join(fixture.bin, "tar"), [
    ...commonHeader,
    "if [[ \"$1\" == \"-tzf\" ]]; then",
    "  record_phase tar-list",
    quotedListing,
    "  exit 0",
    "fi",
    "record_phase tar-extract",
    "destination= archive=",
    "while (($#)); do",
    "  if [[ \"$1\" == \"-C\" ]]; then destination=\"$2\"; shift 2; else archive=\"$1\"; shift; fi",
    "done",
    `root=\"${rootName}\"`,
    "/bin/mkdir -p -m 700 \"$destination/$root/bin\" \"$destination/$root/lib/node_modules/npm/bin\"",
    "/bin/cp \"$FAKE_BOOTSTRAP_NODE\" \"$destination/$root/bin/node\"",
    "printf '%s\\n' '#!/bin/sh' > \"$destination/$root/lib/node_modules/npm/bin/npm-cli.js\"",
    "/bin/ln -s ../lib/node_modules/npm/bin/npm-cli.js \"$destination/$root/bin/npm\"",
    "",
  ].join("\n"));

  // The values below are test-process fixture controls, never launcher inputs.
  fixtureSetupEnv.set(fixture.root, {
    FAKE_UNAME_S: os,
    FAKE_UNAME_M: arch,
    FAKE_BOOTSTRAP_DIGEST: digest,
    FAKE_HTTP_STATUS: options.httpStatus ?? "200",
    FAKE_CURL_EXIT: String(options.curlExit ?? 0),
    FAKE_BOOTSTRAP_NODE: writeBootstrapNode(fixture, options.exitCode ?? 0),
  });
}

const fixtureSetupEnv = new Map<string, NodeJS.ProcessEnv>();

function runSh(fixture: EntrypointFixture, args: string[], envOverrides: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const fixtureEnv = fixtureSetupEnv.get(fixture.root) ?? {};
  const result = spawnSync("/bin/bash", [shPath, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: fixture.bin,
      HOME: fixture.home,
      FAKE_NODE_LOG: fixture.nodeLog,
      FAKE_FALLBACK_ENV_LOG: join(fixture.root, "fallback-env.tsv"),
      FAKE_BOOTSTRAP_PHASE_LOG: fixture.phaseLog,
      FAKE_BOOTSTRAP_COMMON: fixture.commonScript,
      FAKE_CURL_LOG: fixture.curlLog,
      FAKE_STAT_NATIVE: process.platform === "darwin" ? "Darwin" : "Linux",
      ...fixtureEnv,
      ...envOverrides,
    },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function recordedDispatch(fixture: EntrypointFixture): string[] {
  assert.ok(existsSync(fixture.nodeLog), "the fake node must have been dispatched");
  return readFileSync(fixture.nodeLog, "utf8").trimEnd().split("\n");
}

function recordedPhases(fixture: EntrypointFixture): string[] {
  if (!existsSync(fixture.phaseLog)) return [];
  return readFileSync(fixture.phaseLog, "utf8").trimEnd().split("\n").map((line) => line.split("\t")[0]!);
}

function recordedPhaseEnvs(fixture: EntrypointFixture): Array<{ phase: string; bootstrap: string; restore: string; nodeOptions: string }> {
  if (!existsSync(fixture.phaseLog)) return [];
  return readFileSync(fixture.phaseLog, "utf8").trimEnd().split("\n").map((line) => {
    const [phase, bootstrap, restore, nodeOptions] = line.split("\t");
    return { phase: phase!, bootstrap: bootstrap!, restore: restore!, nodeOptions: nodeOptions! };
  });
}

function expectedArchiveFor(platform: string): string {
  return `https://nodejs.org/dist/v22.19.0/node-v22.19.0-${platform}.tar.gz`;
}

// ---------------------------------------------------------------------------
// POSIX entry point (scripts/pi-review-sessions.sh)
// ---------------------------------------------------------------------------

test(".sh rejects executor role contexts before any probe, download, or extractor child", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-role-");
  cleanupFixture(t, fixture);
  writeBootstrapTools(fixture);
  writeFakeNode(fixture.bin, "v24.18.1", fixture.nodeLog);

  for (const roleVar of ["PI_REVIEW_GATE_RUNTIME_ROLE", "PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG"] as const) {
    const result = runSh(fixture, ["--help"], { [roleVar]: "executor" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unsupported role context \(\w+\)/);
  }
  assert.deepEqual(recordedPhases(fixture), []);
  assert.ok(!existsSync(fixture.nodeLog), "no node invocation in a role context");
  assert.ok(!existsSync(fixture.curlLog), "no network request in a role context");
  fixture.markAssertionsPassed();
});

test(".sh retains supported PATH Node, exact argv, trusted NODE_OPTIONS, and CJS exit status", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-dispatch-");
  cleanupFixture(t, fixture);
  writeFakeNode(fixture.bin, "v22.19.0", fixture.nodeLog, { exitCode: 42 });

  const args = ["--state-root", "./state dir π", "--sidebar-key", "f8", "--", "--scheduler", "雪"];
  const result = runSh(fixture, args, {
    PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "bootstrap-secret",
    PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE: "restore-secret",
    NODE_OPTIONS: "--no-warnings --require=provider-fixture.cjs",
  });
  assert.equal(result.status, 42, result.stderr);
  assert.deepEqual(recordedDispatch(fixture), [cjsPath, ...args]);
  const envRecords = readFileSync(`${fixture.nodeLog}.env`, "utf8").trimEnd().split("\n").map((line) => line.split("\t"));
  assert.equal(envRecords.length, 2, "one version probe and one dispatch");
  for (const [, bootstrap, restore, nodeOptions] of envRecords) {
    assert.equal(bootstrap, "", "host bootstrap marker is cleared before child processes");
    assert.equal(restore, "", "host restore marker is cleared before child processes");
    assert.equal(nodeOptions, "--no-warnings --require=provider-fixture.cjs", "trusted NODE_OPTIONS pass through unchanged");
  }
  assert.deepEqual(recordedPhases(fixture), ["path-node-version", "path-node-dispatch"]);
  fixture.markAssertionsPassed();
});

test(".sh automatically bootstraps a missing PATH Node from the fixed pinned archive", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-fallback-");
  cleanupFixture(t, fixture);
  writeBootstrapTools(fixture, { exitCode: 37 });

  const args = ["--state-root", "./state dir π", "--sidebar-key", "f8", "--", "--scheduler", "100% exact", 'quoted "value"', "雪"];
  const nodeOptions = '--trace-warnings --require="provider π.cjs"';
  const agentOverride = "~/agent dir π";
  const effectiveAgentDirectory = join(fixture.home, "agent dir π");
  const result = runSh(fixture, args, {
    PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP: "bootstrap-secret",
    PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE: "restore-secret",
    NODE_OPTIONS: nodeOptions,
    PI_CODING_AGENT_DIR: agentOverride,
  });
  assert.equal(result.status, 37, result.stderr);
  assert.deepEqual(recordedDispatch(fixture), [cjsPath, ...args]);
  assert.equal(readFileSync(fixture.curlLog, "utf8").trim(), expectedArchiveFor("linux-x64"));
  assert.deepEqual(recordedPhases(fixture), ["uname", "uname", "curl", "shasum", "tar-list", "tar-extract", "fallback-node-version", "dispatch"]);
  for (const env of recordedPhaseEnvs(fixture)) {
    assert.equal(env.bootstrap, "", `${env.phase} saw no bootstrap marker`);
    assert.equal(env.restore, "", `${env.phase} saw no restore marker`);
    assert.equal(env.nodeOptions, nodeOptions, `${env.phase} inherited trusted NODE_OPTIONS unchanged`);
  }
  const fallbackEnv = readFileSync(join(fixture.root, "fallback-env.tsv"), "utf8").trimEnd().split("\t");
  const nodeCacheRoot = join(effectiveAgentDirectory, ".pi-review-gate", "node");
  const workRoot = readdirSync(nodeCacheRoot).find((entry) => entry.startsWith("bootstrap."));
  assert.ok(workRoot);
  const selectedNodeDirectory = join(nodeCacheRoot, workRoot, "extracted", "node-v22.19.0-linux-x64", "bin");
  assert.equal(fallbackEnv[0], `${selectedNodeDirectory}:${fixture.bin}`, "selected distribution bin is prepended and the original PATH retained");
  assert.equal(fallbackEnv[1], process.cwd(), "working directory is preserved");
  assert.equal(fallbackEnv[2], nodeOptions, "NODE_OPTIONS is preserved for actual dispatch");
  assert.equal(fallbackEnv[3], agentOverride, "native agent-directory override is preserved unchanged");
  assert.equal(fallbackEnv[4], process.umask().toString(8).padStart(4, "0"), "the caller's original umask is restored for the CJS");

  const workRoots = readdirSync(nodeCacheRoot).filter((name) => name.startsWith("bootstrap."));
  assert.equal(workRoots.length, 1);
  assert.equal(statSync(join(nodeCacheRoot, workRoots[0]!)).mode & 0o777, 0o700, "fresh POSIX witness is mode 0700");
  assert.ok(lstatSync(join(nodeCacheRoot, workRoots[0]!, "extracted", "node-v22.19.0-linux-x64", "bin", "node")).isFile());
  fixture.markAssertionsPassed();
});

test(".sh treats a prerelease at the exact minimum as unsupported and uses the stable pinned fallback", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-prerelease-");
  cleanupFixture(t, fixture);
  writeBootstrapTools(fixture);
  writeFakeNode(fixture.bin, "v22.19.0-rc.1", fixture.nodeLog);

  const result = runSh(fixture, ["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(recordedDispatch(fixture), [cjsPath, "--help"]);
  assert.deepEqual(recordedPhases(fixture), ["path-node-version", "uname", "uname", "curl", "shasum", "tar-list", "tar-extract", "fallback-node-version", "dispatch"]);
  fixture.markAssertionsPassed();
});

test(".sh falls back from an old PATH Node without executing or modifying an unknown cached runtime", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-old-cache-");
  cleanupFixture(t, fixture);
  writeBootstrapTools(fixture);
  writeFakeNode(fixture.bin, "v22.18.9", fixture.nodeLog);

  const nodeCacheDir = join(fixture.agentDir, ".pi-review-gate", "node", "v22.19.0");
  const cachedNodeDir = join(nodeCacheDir, "bin");
  mkdirSync(cachedNodeDir, { recursive: true });
  const cacheLog = join(fixture.root, "cached-node-invocations.txt");
  writeFakeNode(cachedNodeDir, "v22.19.0", cacheLog);
  writeFileSync(join(nodeCacheDir, ".provenance"), "self-asserted, untrusted cache metadata\n", "utf8");
  const sentinel = join(nodeCacheDir, "sentinel.txt");
  writeFileSync(sentinel, "preserve me\n", "utf8");

  const result = runSh(fixture, ["--help"], { PI_CODING_AGENT_DIR: fixture.agentDir });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(recordedDispatch(fixture), [cjsPath, "--help"]);
  assert.ok(!existsSync(cacheLog), "the self-asserted cached node is never executed");
  assert.ok(!existsSync(`${cacheLog}.env`), "no cached-node probe or env record");
  assert.equal(readFileSync(sentinel, "utf8"), "preserve me\n", "unknown existing cache files stay unchanged");
  assert.equal(readFileSync(join(nodeCacheDir, ".provenance"), "utf8"), "self-asserted, untrusted cache metadata\n");
  assert.deepEqual(recordedPhases(fixture), ["path-node-version", "uname", "uname", "curl", "shasum", "tar-list", "tar-extract", "fallback-node-version", "dispatch"]);
  fixture.markAssertionsPassed();
});

test(".sh selects each supported POSIX official artifact and its source-pinned digest", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const platforms = [
    { os: "Darwin", arch: "arm64", name: "darwin-arm64" },
    { os: "Darwin", arch: "x86_64", name: "darwin-x64" },
    { os: "Linux", arch: "aarch64", name: "linux-arm64" },
    { os: "Linux", arch: "x86_64", name: "linux-x64" },
  ];
  for (const platform of platforms) {
    const fixture = makeEntrypointFixture(`.session-host-entry-sh-pin-${platform.name}-`);
    cleanupFixture(t, fixture);
    writeBootstrapTools(fixture, { os: platform.os, arch: platform.arch, digest: POSIX_PINS[platform.name] });
    const result = runSh(fixture, ["--help"]);
    assert.equal(result.status, 0, `${platform.name}: ${result.stderr}`);
    assert.equal(readFileSync(fixture.curlLog, "utf8").trim(), expectedArchiveFor(platform.name));
    assert.deepEqual(recordedPhases(fixture), ["uname", "uname", "curl", "shasum", "tar-list", "tar-extract", "fallback-node-version", "dispatch"]);
    fixture.markAssertionsPassed();
  }
});

test(".sh rejects a checksum mismatch before tar listing, extraction, or runtime execution and retains a 0700 witness", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-checksum-");
  cleanupFixture(t, fixture);
  writeBootstrapTools(fixture, { digest: "0".repeat(64) });

  const result = runSh(fixture, ["--help"], { PI_CODING_AGENT_DIR: fixture.agentDir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /checksum did not match its source-pinned digest/);
  assert.deepEqual(recordedPhases(fixture), ["uname", "uname", "curl", "shasum"], "archive tools and node never run after a hash mismatch");
  const nodeCacheRoot = join(fixture.agentDir, ".pi-review-gate", "node");
  const workRoot = readdirSync(nodeCacheRoot).find((name) => name.startsWith("bootstrap."));
  assert.ok(workRoot);
  assert.equal(statSync(join(nodeCacheRoot, workRoot)).mode & 0o777, 0o700);
  assert.ok(existsSync(join(nodeCacheRoot, workRoot, "node-v22.19.0-linux-x64.tar.gz")), "failed archive remains as evidence");
  fixture.markAssertionsPassed();
});

test(".sh rejects traversal names from a checksum-pinned archive before extraction", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-traversal-");
  cleanupFixture(t, fixture);
  writeBootstrapTools(fixture, { tarListing: ["node-v22.19.0-linux-x64/", "node-v22.19.0-linux-x64/../../escaped"] });

  const result = runSh(fixture, ["--help"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /archive contains an unsafe path/);
  assert.deepEqual(recordedPhases(fixture), ["uname", "uname", "curl", "shasum", "tar-list"]);
  assert.ok(!existsSync(join(fixture.root, "escaped")), "traversal does not create anything outside the extraction root");
  fixture.markAssertionsPassed();
});

test(".sh rejects a symlinked cache parent without following it or starting a download", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-symlink-");
  cleanupFixture(t, fixture);
  writeBootstrapTools(fixture);
  const outsideCache = join(fixture.root, "symlink-target");
  mkdirSync(outsideCache, { recursive: true });
  const agentDotPi = join(fixture.agentDir, ".pi-review-gate");
  mkdirSync(fixture.agentDir, { recursive: true });
  symlinkSync(outsideCache, agentDotPi, "dir");
  writeFileSync(join(outsideCache, "sentinel.txt"), "untouched\n", "utf8");

  const result = runSh(fixture, ["--help"], { PI_CODING_AGENT_DIR: fixture.agentDir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot safely prepare the isolated Node cache directory/);
  assert.deepEqual(recordedPhases(fixture), ["uname", "uname"]);
  assert.equal(readFileSync(join(outsideCache, "sentinel.txt"), "utf8"), "untouched\n");
  fixture.markAssertionsPassed();
});

test(".sh reports unsupported fallback architectures without a network request", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-unsupported-");
  cleanupFixture(t, fixture);
  writeBootstrapTools(fixture, { os: "FreeBSD", arch: "riscv64" });

  const result = runSh(fixture, ["--help"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no pinned Node\.js 22\.19\.0 archive is available for this platform/);
  assert.deepEqual(recordedPhases(fixture), ["uname", "uname"]);
  fixture.markAssertionsPassed();
});

test(".sh requires HTTP 200 and retains a failed-download witness without archive probing", { skip: isWindows ? "POSIX entry point" : false }, async (t) => {
  const fixture = makeEntrypointFixture(".session-host-entry-sh-http-");
  cleanupFixture(t, fixture);
  writeBootstrapTools(fixture, { httpStatus: "302" });

  const result = runSh(fixture, ["--help"], { PI_CODING_AGENT_DIR: fixture.agentDir });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /download returned an invalid response/);
  assert.deepEqual(recordedPhases(fixture), ["uname", "uname", "curl"]);
  const nodeCacheRoot = join(fixture.agentDir, ".pi-review-gate", "node");
  const workRoot = readdirSync(nodeCacheRoot).find((name) => name.startsWith("bootstrap."));
  assert.ok(workRoot);
  assert.equal(statSync(join(nodeCacheRoot, workRoot)).mode & 0o777, 0o700);
  fixture.markAssertionsPassed();
});

// ---------------------------------------------------------------------------
// Native Windows entry point source contract. Native runtime behavior is
// deliberately reserved for parent-owned tests on a Windows host.
// ---------------------------------------------------------------------------

test(".cmd delegates arguments to the PowerShell Node bootstrap after fail-closed capability isolation", async () => {
  const source = readFileSync(cmdPath, "utf8");
  assert.ok(source.includes("\r\n"), "the batch file must keep CRLF line endings");
  assert.match(source, /if defined PI_REVIEW_GATE_RUNTIME_ROLE \(\s*\r?\n\s*echo pi-review-sessions: unsupported role context/);
  assert.match(source, /if defined PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG \(/);
  assert.match(source, /set "PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP="/m);
  assert.match(source, /set "PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE="/m);
  assert.match(source, /DisableDelayedExpansion/);
  assert.match(source, /WindowsPowerShell\\v1\.0\\powershell\.exe/);
  assert.match(source, /-File "%~dp0pi-review-sessions-node\.ps1" %\*/);
  assert.match(source, /^exit \/b %ERRORLEVEL%$/m);
  assert.doesNotMatch(source, /node -e|where node|call pi|goto /);

  const helper = readFileSync(psPath, "utf8");
  assert.match(helper, /if \(-not \[string\]::IsNullOrEmpty\(\$env:PI_REVIEW_GATE_RUNTIME_ROLE\)\)/);
  assert.match(helper, /\$env:PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP = \$null/);
  assert.match(helper, /Get-Command -Name 'node\.exe'/);
  assert.match(helper, /https:\/\/nodejs\.org\/dist\/v22\.19\.0\/' \+ \$NodeArchive/);
  assert.match(helper, /AllowAutoRedirect = \$false/);
  assert.match(helper, /CreateNew/);
  assert.match(helper, /Get-Sha256 \$archivePath[\s\S]*?if \(\$actualSha256 -cne \$NodeSha256\)[\s\S]*?Expand-VerifiedZip/);
  assert.match(helper, /^  \$FallbackNodeExecutable = \$nodeExe$/m);
  assert.match(helper, /^Start-SessionCjs \$FallbackNodeExecutable \$FallbackNodeDirectory \$CjsArguments$/m);
  assert.doesNotMatch(helper, /https?:\/\/(?!nodejs\.org)/);
});

test("Windows PowerShell bootstrap preserves literal directory, ZIP layout, and argv contracts", async () => {
  const helper = readFileSync(psPath, "utf8");
  assert.match(helper, /function New-LiteralDirectory\(\[string\]\$Path\)[\s\S]*?New-Item -ItemType Directory -Path \$Path -ErrorAction Stop/);
  assert.doesNotMatch(helper, /WildcardPattern\]::Escape/);
  assert.doesNotMatch(helper, /^\s*New-Item[^\r\n]*-LiteralPath/m);
  assert.doesNotMatch(helper, /New-Item[^\r\n]*-Force/);
  assert.match(helper, /function New-ExclusiveDirectory\([\s\S]*?New-Item fails for an existing path[\s\S]*?New-LiteralDirectory \$Path/);

  assert.match(helper, /\$nodeExe = Join-Path \$nodeRoot 'node\.exe'/);
  assert.match(helper, /\$npmCommand = Join-Path \$nodeRoot 'npm\.cmd'/);
  assert.match(helper, /\$npmRoot = Join-Path \$nodeRoot 'node_modules\\npm'/);
  assert.match(helper, /\$npmCli = Join-Path \$npmRoot 'bin\\npm-cli\.js'/);
  assert.doesNotMatch(helper, /Assert-OrdinaryDirectory \(Join-Path \$nodeRoot 'bin'\)/);

  assert.match(helper, /function ConvertTo-WindowsNativeArgument[\s\S]*?2 \* \$backslashes \+ 1[\s\S]*?2 \* \$backslashes/);
  assert.match(helper, /\$nativeArguments = @\(\$CjsEntry\) \+ @\(\$Arguments\)/);
  assert.match(helper, /\$startInfo\.Arguments = \[string\]::Join\(' ', \[string\[\]\]\$encodedArguments\)/);
  assert.match(helper, /\$startInfo\.UseShellExecute = \$false/);
  assert.match(helper, /\$startInfo\.WorkingDirectory = \[Environment\]::CurrentDirectory/);
  assert.match(helper, /\$startInfo\.RedirectStandardInput = \$false[\s\S]*?\$startInfo\.RedirectStandardOutput = \$false[\s\S]*?\$startInfo\.RedirectStandardError = \$false/);
  assert.match(helper, /\$process\.WaitForExit\(\)[\s\S]*?\$status = \$process\.ExitCode/);
  assert.doesNotMatch(helper, /& \$Executable \$CjsEntry @Arguments|Start-Process/);
});

test("bootstrap source pins every official platform artifact and bounds download/extraction", async () => {
  const posix = readFileSync(shPath, "utf8");
  const windows = readFileSync(psPath, "utf8");
  for (const digest of Object.values(POSIX_PINS)) {
    assert.ok(posix.includes(digest), `POSIX source includes fixed pin ${digest}`);
  }
  const windowsArtifacts = [
    ["node-v22.19.0-win-arm64.zip", "e4a7336010d58ff35b53d9dd5869095c56089c70913cf22508cf8183593e56b2"],
    ["node-v22.19.0-win-x64.zip", "ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86"],
    ["node-v22.19.0-win-x86.zip", "708b8a297a19e9ac433e32ac0fc496755757c5e00bd5a0683917e73cae5fe8ea"],
  ];
  for (const [artifact, digest] of windowsArtifacts) {
    assert.ok(windows.includes(artifact), `Windows source selects ${artifact}`);
    assert.ok(windows.includes(digest), `Windows source includes fixed pin ${digest}`);
  }
  assert.match(posix, /--max-time 180/);
  assert.match(posix, /--max-filesize 268435456/);
  assert.match(posix, /--no-same-owner --no-same-permissions/);
  assert.match(windows, /180000/);
  assert.match(windows, /268435456/);
  assert.match(windows, /1073741824/);
  assert.doesNotMatch(posix, /PI_REVIEW_GATE_.*(?:FORCE|SKIP|UNVERIFIED)/);
  assert.doesNotMatch(windows, /PI_REVIEW_GATE_.*(?:FORCE|SKIP|UNVERIFIED)/);
});
