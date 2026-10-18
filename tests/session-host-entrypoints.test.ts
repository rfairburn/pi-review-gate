import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
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
    `if [[ "\${FAKE_BOOTSTRAP_DISPATCH_CJS:-}" == 1 ]]; then exec "${process.execPath}" "$@"; fi`,
    `if [[ "\${FAKE_BOOTSTRAP_HOLD:-}" == 1 ]]; then exec "${process.execPath}" -e 'process.stdout.write("HOLDING\\n"); process.stdin.once("data", () => process.exit(0));'; fi`,
    `if [[ -n "\${FAKE_BOOTSTRAP_SIGNAL_CHILD:-}" ]]; then exec "${process.execPath}" "$FAKE_BOOTSTRAP_SIGNAL_CHILD" "$@"; fi`,
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
  writeExecutable(join(fixture.bin, "mount"), '#!/bin/bash\nif [[ -n "${FAKE_MOUNT_TABLE_FILE:-}" ]]; then while IFS= read -r line; do printf "%s\\n" "$line"; done < "$FAKE_MOUNT_TABLE_FILE"; elif [[ "${FAKE_UNAME_S:-Linux}" == Darwin ]]; then printf "%s\\n" "fixture on / (local)"; else printf "%s\\n" "fixture on / type fixture (rw)"; fi\n');
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
  // The canonical coordination record is published with an atomic hard link, and
  // its owner identity is one targeted `ps` query for a single pid.
  for (const tool of ["unlink", "rmdir", "mv", "ln", "ps"]) {
    const native = spawnSync("/bin/bash", ["-c", `type -P ${tool}`], { encoding: "utf8" }).stdout.trim();
    writeExecutable(join(fixture.bin, tool), `#!/bin/bash\nexec "${native}" "$@"\n`);
  }
  writeExecutable(join(fixture.bin, "wc"), "#!/bin/bash\nexec /usr/bin/wc \"$@\"\n");
  writeExecutable(join(fixture.bin, "readlink"), "#!/bin/bash\nexec /usr/bin/readlink \"$@\"\n");
  writeExecutable(join(fixture.bin, "stat"), [
    "#!/bin/bash",
    "# Synthetic concurrency: another producer may publish its own live lock while a",
    "# recovering producer is between malformed observation and reclamation.",
    "if [[ -n \"${FAKE_LOCK_PATH:-}\" && \"${2:-}\" == *%d:%i* ]]; then",
    "  last=''",
    "  for arg in \"$@\"; do last=\"$arg\"; done",
    "  if [[ \"$last\" == \"$FAKE_LOCK_PATH\" ]]; then",
    "    count=0",
    "    [[ -f \"${FAKE_LOCK_COUNTER:-}\" ]] && read -r count < \"${FAKE_LOCK_COUNTER:-}\"",
    "    count=$((count + 1))",
    "    printf '%s' \"$count\" > \"${FAKE_LOCK_COUNTER:-}\"",
    "    if (( count == ${FAKE_LOCK_SWAP_AT:-0} )) && [[ \"$FAKE_LOCK_PATH\" == \"${FAKE_COORDINATION_LOCK:-}\" ]]; then",
    "      # Replace the stale coordination record with a complete, valid live one.",
    "      /bin/rm -f \"$FAKE_LOCK_PATH\"",
    "      printf '%s\\n%s\\n' \"${FAKE_LOCK_OWNER:-}\" \"${FAKE_LOCK_IDENTITY:-}\" > \"$FAKE_LOCK_PATH\"",
    "    elif (( count == ${FAKE_LOCK_SWAP_AT:-0} )) && [[ -d \"$FAKE_LOCK_PATH\" && ! -L \"$FAKE_LOCK_PATH\" ]]; then",
    "      rmdir \"$FAKE_LOCK_PATH\"",
    "      printf '%s\\n' \"${FAKE_LOCK_OWNER:-}\" > \"$FAKE_LOCK_PATH\"",
    "    fi",
    "    if [[ -n \"${FAKE_OWNERSHIP_RECORD:-}\" && \"${FAKE_OWNERSHIP_AT:-}\" =~ ^[0-9]+$ ]] && (( count == FAKE_OWNERSHIP_AT )); then",
    "      /bin/mkdir -p \"${FAKE_OWNERSHIP_RECORD%/*}\"",
    "      printf '%s\\n' '{\"version\":1,\"hostId\":\"fixture-owner\"}' > \"$FAKE_OWNERSHIP_RECORD\"",
    "    fi",
    "  fi",
    "fi",
    "# A bounded barrier inside the real destructive pass: the producer holds the",
    "# per-agent coordination entry while a host acquisition is attempted.",
    "if [[ -n \"${FAKE_HOLD_TRIGGER:-}\" && \"${FAKE_HOLD_TRIGGER}\" != \"${FAKE_HOLD_DONE:-}\" && \"${2:-}\" == *%d:%i* ]]; then",
    "  last=''",
    "  for arg in \"$@\"; do last=\"$arg\"; done",
    "  if [[ \"$last\" == \"$FAKE_HOLD_TRIGGER\" ]]; then",
    "    printf '%s\\n' \"$FAKE_HOLD_TRIGGER\" > \"$FAKE_HOLD_DONE\"",
    "    hold_started=$SECONDS",
    "    while (( SECONDS - hold_started < 3 )); do /bin/sleep 0.05; done",
    "    if [[ -n \"${FAKE_OWNERSHIP_RECORD:-}\" && -e \"$FAKE_OWNERSHIP_RECORD\" ]]; then",
    "      printf 'ownership-during-hold:true\\n' >> \"$FAKE_HOLD_LOG\"",
    "    else",
    "      printf 'ownership-during-hold:false\\n' >> \"$FAKE_HOLD_LOG\"",
    "    fi",
    "    hold_deadline=$((SECONDS + 60))",
    "    while [[ ! -e \"${FAKE_HOLD_RELEASE:-/nonexistent}\" ]] && (( SECONDS < hold_deadline )); do /bin/sleep 0.05; done",
    "    printf 'hold-released\\n' >> \"$FAKE_HOLD_LOG\"",
    "  fi",
    "fi",
    "# The same synthetic producer publishes a host ownership record just before a",
    "# chosen generation identity is observed, so a host appears mid-cleanup.",
    "if [[ -n \"${FAKE_OWNERSHIP_TRIGGER:-}\" && -n \"${FAKE_OWNERSHIP_RECORD:-}\" && \"${2:-}\" == *%d:%i* ]]; then",
    "  last=''",
    "  for arg in \"$@\"; do last=\"$arg\"; done",
    "  if [[ \"$last\" == \"$FAKE_OWNERSHIP_TRIGGER\" ]]; then",
    "    /bin/mkdir -p \"${FAKE_OWNERSHIP_RECORD%/*}\"",
    "    printf '%s\\n' '{\"version\":1,\"hostId\":\"fixture-owner\"}' > \"$FAKE_OWNERSHIP_RECORD\"",
    "  fi",
    "fi",
    "if [[ \"$1\" == \"-f\" && \"${FAKE_STAT_NATIVE:-Linux}\" == Linux ]]; then format=\"$2\"; format=\"${format//%Lp/%a}\"; format=\"${format//%p/%f}\"; format=\"${format//%l/%h}\"; format=\"${format//%z/%s}\"; format=\"${format//%m/%Y}\"; format=\"${format//%c/%Z}\"; shift 2; exec /usr/bin/stat -c \"$format\" \"$@\"; fi",
    "if [[ \"$1\" == \"-c\" && \"${FAKE_STAT_NATIVE:-Linux}\" == Darwin ]]; then format=\"$2\"; format=\"${format//%a/%Lp}\"; format=\"${format//%f/%p}\"; format=\"${format//%h/%l}\"; format=\"${format//%s/%z}\"; format=\"${format//%Y/%m}\"; format=\"${format//%Z/%c}\"; shift 2; exec /usr/bin/stat -f \"$format\" \"$@\"; fi",
    "exec /usr/bin/stat \"$@\"",    "",
  ].join("\n"));
  writeExecutable(join(fixture.bin, "curl"), [
    ...commonHeader,
    "record_phase curl",
    "if [[ \"${FAKE_CURL_HOLD:-}\" == 1 ]]; then printf 'DOWNLOAD_READY\\n' >&3; IFS= read -r release || exit 1; fi",
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
    "if [[ \"${FAKE_SWAP_CACHE_PARENT:-}\" == 1 ]]; then gate=\"${archive%/node/*}\"; /bin/mv \"$gate\" \"$gate.displaced\"; /bin/ln -s \"$gate.displaced\" \"$gate\"; fi",
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
    "# Controlled representative payload: a real extraction produces thousands of",
    "# files and directories inside the generation, so post-extract cleanup acts on",
    "# populated fresh roots rather than empty placeholders.",
    "populate_files=${FAKE_TAR_FILES:-0}",
    "populate_dirs=${FAKE_TAR_DIRS:-0}",
    "if (( populate_dirs > 0 )); then",
    "  for (( i=0; i<populate_dirs; i++ )); do",
    "    /bin/mkdir -p \"$destination/$root/lib/payload/d$((i % 40))/e$i\"",
    "  done",
    "fi",
    "if (( populate_files > 0 )); then",
    "  for (( k=0; k<40; k++ )); do /bin/mkdir -p \"$destination/$root/lib/payload/f$k\"; done",
    "  for (( i=0; i<populate_files; i++ )); do printf 'artifact\\n' > \"$destination/$root/lib/payload/f$((i % 40))/file-$i.txt\"; done",
    "fi",
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

function entrypointEnv(fixture: EntrypointFixture, envOverrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const fixtureEnv = fixtureSetupEnv.get(fixture.root) ?? {};
  return {
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
  };
}
function runSh(fixture: EntrypointFixture, args: string[], envOverrides: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("/bin/bash", [shPath, ...args], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
    env: entrypointEnv(fixture, envOverrides),
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
// Node cache cleanup: actual POSIX producer fixtures, native Windows checks
// (Windows-only), then cross-platform source contracts. No native cleanup claim.
// #385 startup-first contract: these designated caches are disposable by
// location, so five or more legacy artifacts must never refuse a launch.
// ---------------------------------------------------------------------------

function nodeRoots(fixture: EntrypointFixture): string[] {
  const cache = join(fixture.agentDir, ".pi-review-gate", "node");
  return readdirSync(cache).filter((name) => name !== ".admission.lock").map((name) => join(cache, name));
}
function nodeCache(fixture: EntrypointFixture): string {
  return join(fixture.agentDir, ".pi-review-gate", "node");
}

/** Physical remaining entries (files, dirs, links) inside one disposable tree. */
function countTreeEntries(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      total += 1;
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(join(current, entry.name));
    }
  }
  return total;
}

/**
 * A controlled harness that sources the real POSIX producer functions
 * (`node_capture_fence`, `node_admit`, `node_remove`) with the host's own native
 * `stat`/`unlink`/`rmdir`/`rm`, so a runtime budget can be shortened without any
 * product knob. Nothing is downloaded or extracted here; the wrapper's own
 * end-to-end path is covered by the `.sh` tests.
 */
function runProducerHarness(f: EntrypointFixture, body: string, extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const script = join(f.root, `producer-harness-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`);
  writeFileSync(script, [
    "set -u",
    `HOST_OS="$(uname -s)"`,
    `STAT_BIN="$(command -v stat)"`,
    `NODE_UNLINK_BIN="$(command -v unlink)"`,
    `NODE_RMDIR_BIN="$(command -v rmdir)"`,
    `NODE_PS_BIN="$(command -v ps)"`,
    `NODE_DATE_BIN="$(command -v date)"`,
    `NODE_HARDLINK_BIN="$(command -v ln)"`,
    `NODE_RM_BIN="$(command -v rm)"`,
    `AGENT_DIR=${JSON.stringify(f.agentDir)}`,
    `NODE_CACHE_ROOT="\${AGENT_DIR}/.pi-review-gate/node"`,
    `path_identity() { local output; if [[ "$HOST_OS" == Darwin ]]; then output="$("$STAT_BIN" -f '%d:%i' "$1" 2>/dev/null)" || return 1; else output="$("$STAT_BIN" -c '%d:%i' "$1" 2>/dev/null)" || return 1; fi; printf '%s' "$output"; }`,
    `assert_path_identity() { local current; current="$(path_identity "$1")" || return 1; [[ "$current" == "$2" ]]; }`,
    `source ${JSON.stringify(resolve("scripts/node-generations.sh"))}`,
    "node_capture_fence || { echo 'fence failed' >&2; exit 3; }",
    body,
    "",
  ].join("\n"), "utf8");
  const result = spawnSync("/bin/bash", [script], {
    encoding: "utf8",
    timeout: 180_000,
    env: { HOME: f.home, PATH: process.env.PATH ?? "", ...extraEnv },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Populate one already-created generation with real files and directories. */
function fillNodeGeneration(root: string, files: number, directories: number): void {
  for (let bucket = 0; bucket < 40; bucket += 1) mkdirSync(join(root, `d${bucket}`), { recursive: true });
  for (let index = 0; index < directories; index += 1) mkdirSync(join(root, `d${index % 40}`, `e${index}`), { recursive: true });
  for (let index = 0; index < files; index += 1) {
    writeFileSync(join(root, `d${index % 40}`, `file-${index}.txt`), "representative extracted content");
  }
}

/**
 * A representative populated fallback-Node generation: thousands of real files,
 * a chain deeper than any former recursion quota, cleanup-specific `.terraform`
 * content, and an outside hardlink/symlink that must never be followed. The
 * native producers (not a substitute pruner) are what delete it.
 */
function seedPopulatedNodeGeneration(cache: string, name: string, outside: string): { root: string; entries: number } {
  const root = join(cache, name);
  let deepest = root;
  for (let depth = 0; depth < 70; depth += 1) {
    deepest = join(deepest, `d${depth}`);
    mkdirSync(deepest, { recursive: true });
  }
  writeFileSync(join(deepest, "deep.txt"), "deep");
  for (let bucket = 0; bucket < 25; bucket += 1) mkdirSync(join(root, `files-${bucket}`), { recursive: true });
  for (let index = 0; index < 2000; index += 1) {
    writeFileSync(join(root, `files-${index % 25}`, `f-${index}.txt`), "disposable by location");
  }
  mkdirSync(join(root, ".terraform"), { recursive: true });
  writeFileSync(join(root, ".terraform", "sentinel"), "cleanup-specific");
  linkSync(outside, join(root, "outside-hardlink"));
  symlinkSync(outside, join(root, "outside-symlink"));
  return { root, entries: countTreeEntries(root) };
}

for (const nativeOs of ["Linux", "Darwin"] as const) {
test(`.sh actual ${nativeOs} fallback producer starts past five legacy extractions and deletes path-owned descendants without following outside links`, { skip: isWindows }, (t) => {
  const f = makeEntrypointFixture(`.node-cap-roll-${nativeOs}-`);
  cleanupFixture(t, f);
  writeBootstrapTools(f, { os: nativeOs, digest: POSIX_PINS[nativeOs === "Linux" ? "linux-x64" : "darwin-x64"] });
  const env = { PI_CODING_AGENT_DIR: f.agentDir, FAKE_BOOTSTRAP_DISPATCH_CJS: "1" };
  const produced = new Set<string>();
  const sentinel = join(f.root, "outside-sentinel");
  writeFileSync(sentinel, "outside remains");
  for (let i = 0; i < 8; i++) {
    const result = runSh(f, ["--help"], env);
    assert.equal(result.status, 0, result.stderr);
    const roots = nodeRoots(f);
    assert.equal(roots.length, Math.min(i + 1, 5), "the cache stays at its five-generation target");
    for (const root of roots) {
      assert.equal(existsSync(join(root, ".node-lifetime")), false, "no lifetime receipt is written");
      assert.doesNotMatch(result.stderr, /capacity exhausted/);
      if (produced.has(root)) continue;
      produced.add(root);
      mkdirSync(join(root, "arbitrary-existing-failed", "nested"), { recursive: true });
      writeFileSync(join(root, "arbitrary-existing-failed", "nested", "unreceipted.txt"), "disposable by path");
      symlinkSync(sentinel, join(root, "outside-link"));
    }
  }
  assert.equal(produced.size, 8);
  assert.equal([...produced].filter((root) => !existsSync(root)).length, 3, "actual disposable extractions and arbitrary descendants were removed");
  assert.equal(readFileSync(sentinel, "utf8"), "outside remains");
  assert.equal(recordedPhases(f).filter((p) => p === "curl").length, 8, "no mutable Node reuse");
  f.markAssertionsPassed();
});
}

test(".sh deletes a large populated Node generation content-first and converges to five", { skip: isWindows, timeout: 120_000 }, (t) => {
  const f = makeEntrypointFixture(".node-large-generation-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const env = { PI_CODING_AGENT_DIR: f.agentDir, FAKE_BOOTSTRAP_DISPATCH_CJS: "1" };
  const cache = nodeCache(f);
  mkdirSync(cache, { recursive: true });
  const outside = join(f.root, "outside-sentinel");
  writeFileSync(outside, "outside remains");
  const big = seedPopulatedNodeGeneration(cache, "bootstrap.0-large", outside);
  assert.ok(big.entries > 2000, `the fixture is really populated: ${big.entries} entries`);
  // A marker naming a LIVE pid whose OS birth is clearly after the record was
  // written: exactly the pid-reuse residue an older producer can leave behind.
  const reused = join(cache, "bootstrap.1-reused");
  mkdirSync(reused, { recursive: true });
  writeFileSync(join(reused, "content.txt"), "reclaimable");
  const marker = join(reused, ".producer-active");
  writeFileSync(marker, `${process.pid}\n`, { mode: 0o600 });
  const longAgo = new Date(Date.now() - 3_600_000);
  utimesSync(marker, longAgo, longAgo);
  // Names that sort after the seeded excess so removal order stays deterministic
  // next to the random `bootstrap.<hex>` generation names this producer creates.
  for (const name of ["bootstrap.9-small-1", "bootstrap.9-small-2", "bootstrap.9-small-3"]) mkdirSync(join(cache, name));
  const results: string[] = [];
  for (let launch = 0; launch < 4; launch += 1) {
    const result = runSh(f, ["--help"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /capacity exhausted/);
    results.push(result.stderr);
    if (!existsSync(big.root) && !existsSync(reused)) break;
  }
  assert.equal(existsSync(reused), false, "a reused-pid marker never keeps its generation forever");
  assert.equal(existsSync(big.root), false, "the populated generation was actually deleted, not just counted");
  assert.equal(nodeRoots(f).length, 5, "the cache converges to its five-generation target");
  assert.equal(readFileSync(outside, "utf8"), "outside remains", "outside bytes are never deleted");
  assert.equal(lstatSync(outside).nlink, 1, "only the cache name of the hardlink was removed");
  assert.equal(recordedPhases(f).filter((phase) => phase === "curl").length, results.length,
    "every launch still reached the download: cleanup never refuses a launch");
  f.markAssertionsPassed();
});

/**
 * A representative ~10k-entry generation, driven through the REAL POSIX producer
 * functions with the host's own native tools. A budget that cannot finish the
 * generation must still delete real content (never a zero-progress no-op), repeated
 * short passes must keep advancing, and the default budget must finish it.
 */
test(".sh real producer makes bounded partial progress on a ~10k-entry generation, then finishes it", { skip: isWindows, timeout: 180_000 }, (t) => {
  const f = makeEntrypointFixture(".node-ten-thousand-");
  cleanupFixture(t, f);
  const cache = nodeCache(f);
  mkdirSync(cache, { recursive: true });
  const outside = join(f.root, "outside-sentinel");
  writeFileSync(outside, "outside remains");
  const large = join(cache, "bootstrap.0-large");
  mkdirSync(large, { recursive: true });
  fillNodeGeneration(large, 10_000, 400);
  linkSync(outside, join(large, "outside-hardlink"));
  symlinkSync(outside, join(large, "outside-symlink"));
  for (const name of ["bootstrap.8-a", "bootstrap.8-b", "bootstrap.8-c", "bootstrap.8-d"]) mkdirSync(join(cache, name));
  const before = countTreeEntries(large);
  assert.ok(before > 10_000, `the fixture holds a representative volume: ${before} entries`);
  // A one-second budget with one name per native remove call cannot finish this
  // generation; it must still delete real content and keep the root counted.
  const shortPass = (pass: number) => runProducerHarness(f, [
    "export NODE_CLEANUP_BATCH=1",
    "NODE_CLEANUP_BUDGET=1",
    `node_admit || exit 2`,
    "echo admit-ok",
  ].join("\n"), { HARNESS_PASS: String(pass) });
  const first = shortPass(1);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /admit-ok/);
  const afterFirst = existsSync(large) ? countTreeEntries(large) : 0;
  assert.ok(afterFirst < before, `the bounded pass deleted real content: ${before} -> ${afterFirst}`);
  assert.ok(existsSync(large), "a one-second budget stops part-way instead of claiming the generation");
  assert.equal(readFileSync(outside, "utf8"), "outside remains", "outside bytes survive the partial pass");
  const second = shortPass(2);
  assert.equal(second.status, 0, second.stderr);
  const afterSecond = existsSync(large) ? countTreeEntries(large) : 0;
  assert.ok(afterSecond < afterFirst, `the next short pass keeps advancing: ${afterFirst} -> ${afterSecond}`);
  // The normal default budget finishes the same generation.
  const finish = runProducerHarness(f, [
    "node_admit || exit 2",
    "echo admit-ok",
  ].join("\n"));
  assert.equal(finish.status, 0, finish.stderr);
  assert.equal(existsSync(large), false, "the default-budget pass finishes the ~10k generation");
  assert.equal(readFileSync(outside, "utf8"), "outside remains", "the outside sentinel is never followed");
  assert.equal(lstatSync(outside).nlink, 1, "only the cache name of the hardlink was removed");
  assert.ok(nodeRoots(f).length <= 5, `the cache converges: ${nodeRoots(f).length}`);
  f.markAssertionsPassed();
});

/**
 * Every fresh fallback generation is populated with thousands of real entries by
 * the controlled extraction, so the post-extract trim acts on populated roots and
 * convergence cannot come from deleting empty placeholders.
 */
test(".sh converges to five with thousands of extracted entries in every fresh generation", { skip: isWindows, timeout: 180_000 }, (t) => {
  const f = makeEntrypointFixture(".node-fresh-volume-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const env = { PI_CODING_AGENT_DIR: f.agentDir, FAKE_TAR_FILES: "2000", FAKE_TAR_DIRS: "200" };
  const outside = join(f.root, "outside-sentinel");
  writeFileSync(outside, "outside remains");
  const before = join(nodeCache(f), "bootstrap.9-before");
  const roots: string[] = [];
  for (let launch = 0; launch < 8; launch += 1) {
    const result = runSh(f, ["--help"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /capacity exhausted|unbound variable/);
    const current = nodeRoots(f);
    for (const root of current) if (!roots.includes(root)) roots.push(root);
    assert.ok(current.length <= 5, `post-fresh generation count stays at the target: ${current.length}`);
    const populated = current.filter((root) => existsSync(join(root, "extracted")) ? readdirSync(join(root, "extracted")).length > 0 : false);
    assert.ok(populated.length > 0, "the fresh generation really contains controlled extraction output");
    for (const root of populated) {
      assert.ok(countTreeEntries(root) > 2_000, `a populated fresh root holds thousands of entries: ${countTreeEntries(root)}`);
    }
  }
  assert.equal(nodeRoots(f).length, 5, "the cache converges to its five-generation target");
  assert.ok(roots.filter((root) => !existsSync(root)).length >= 3,
    "populated fresh generations were actually reclaimed, not just counted");
  assert.equal(readFileSync(outside, "utf8"), "outside remains");
  assert.ok(recordedPhases(f).filter((phase) => phase === "tar-extract").length === 8,
    "every launch performed its own fresh extraction (no mutable Node reuse)");
  void before;
  f.markAssertionsPassed();
});

/**
 * A real identity-query failure must abort the pass truthfully instead of
 * continuing to walk with an empty or short identity list (which previously left
 * unbound array values that crashed the launcher under `set -u`). The producer
 * still creates its generation, and a later healthy pass reclaims the residue.
 */
test(".sh identity-query failure aborts the pass without crashing and stays confined", { skip: isWindows, timeout: 120_000 }, (t) => {
  const f = makeEntrypointFixture(".node-identity-fault-");
  cleanupFixture(t, f);
  const cache = nodeCache(f);
  mkdirSync(cache, { recursive: true });
  const outside = join(f.root, "outside-sentinel");
  writeFileSync(outside, "outside remains");
  const faulted = join(cache, "bootstrap.0-faulted");
  mkdirSync(faulted, { recursive: true });
  fillNodeGeneration(faulted, 400, 40);
  // The fault hits the generation root's own first identity batch, which is the
  // exact window where continuing with an empty identity list used to crash.
  mkdirSync(join(faulted, "d0", "fault-inside"), { recursive: true });
  writeFileSync(join(faulted, "d0", "fault-inside", "kept.txt"), "kept");
  linkSync(outside, join(faulted, "outside-hardlink"));
  symlinkSync(outside, join(faulted, "outside-symlink"));
  for (const name of ["bootstrap.8-a", "bootstrap.8-b", "bootstrap.8-c", "bootstrap.8-d"]) mkdirSync(join(cache, name));
  const entriesBefore = countTreeEntries(faulted);
  // A real, targeted native identity-query failure for one subtree: the walker must
  // abort this pass (warn truthfully) instead of continuing with no identities.
  const faultStat = join(f.root, "fault-stat");
  writeFileSync(faultStat, [
    "#!/bin/bash",
    `for arg in \"$@\"; do case \"$arg\" in ${JSON.stringify(join(faulted, "d1"))}*) exit 1;; esac; done`,
    "exec /usr/bin/stat \"$@\"",
    "",
  ].join("\n"), "utf8");
  chmodSync(faultStat, 0o755);
  const faultedRun = runProducerHarness(f, [
    `STAT_BIN=${JSON.stringify(faultStat)}`,
    "node_admit || exit 2",
    "echo admit-ok",
  ].join("\n"));
  assert.equal(faultedRun.status, 0, faultedRun.stderr);
  assert.match(faultedRun.stdout, /admit-ok/, "the producer still settles its own generation");
  assert.match(faultedRun.stderr, /could not reclaim cache generation/,
    `the identity-query failure is reported as a reclamation failure: ${faultedRun.stderr}`);
  assert.doesNotMatch(faultedRun.stderr, /unbound variable|NODE_IDENTITIES|integer expression/u,
    "the abort never falls through with empty identity values");
  assert.equal(readFileSync(outside, "utf8"), "outside remains", "outside bytes are untouched by the failed pass");
  assert.equal(lstatSync(outside).nlink, 1, "the outside hardlink target keeps its only real name");
  const afterFault = existsSync(faulted) ? countTreeEntries(faulted) : 0;
  assert.ok(afterFault <= entriesBefore, "the aborted pass deleted nothing outside the faulted subtree");
  assert.ok(existsSync(join(faulted, "d0", "fault-inside", "kept.txt")),
    "the subtree whose identity query failed is left in place, not half-removed");
  // A healthy pass reclaims the same generation without any leftover crash state.
  let reclaimed = !existsSync(faulted);
  for (let pass = 0; pass < 4 && !reclaimed; pass += 1) {
    const healthy = runProducerHarness(f, ["node_admit || exit 2", "echo admit-ok"].join("\n"));
    assert.equal(healthy.status, 0, healthy.stderr);
    reclaimed = !existsSync(faulted);
  }
  assert.equal(reclaimed, true, "a later healthy pass reclaims the formerly faulted generation");
  assert.equal(readFileSync(outside, "utf8"), "outside remains");
  assert.ok(nodeRoots(f).length <= 5, `the cache converges: ${nodeRoots(f).length}`);
  f.markAssertionsPassed();
});

/**
 * An empty generation deletes nothing inside the walk, so its ROOT removal is the
 * progress boundary. With an already-exhausted deadline, every cleanup-only pass
 * must still remove exactly one excess root (the pass-scope allowance), must never
 * remove the preserved selected root, and must never create a generation.
 */
test(".sh cleanup-only pass removes one empty root per exhausted-budget call", { skip: isWindows, timeout: 120_000 }, (t) => {
  const f = makeEntrypointFixture(".node-empty-roots-");
  cleanupFixture(t, f);
  const cache = nodeCache(f);
  mkdirSync(cache, { recursive: true });
  const selected = join(cache, "bootstrap.0-selected");
  mkdirSync(selected, { recursive: true });
  const empties: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const root = join(cache, `bootstrap.5-empty-${index}`);
    mkdirSync(root, { recursive: true });
    empties.push(root);
  }
  const outside = join(f.root, "outside-sentinel");
  writeFileSync(outside, "outside remains");
  assert.equal(nodeRoots(f).length, 9);
  // Production functions with an already-exhausted deadline and a kept root.
  const cleanupPass = () => runProducerHarness(f, [
    "node_cleanup_running() { return 1; }",
    `NODE_KEEP_ROOT=${JSON.stringify(selected)}`,
    "node_cleanup_only || exit 2",
    "echo cleanup-ok",
  ].join("\n"));
  const removedPerPass: number[] = [];
  for (let pass = 0; pass < 8 && nodeRoots(f).length > 5; pass += 1) {
    const before = nodeRoots(f).length;
    const result = cleanupPass();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cleanup-ok/);
    const after = nodeRoots(f).length;
    assert.equal(after, before - 1,
      `pass ${pass + 1} removed exactly one empty root under an exhausted budget: ${before} -> ${after}`);
    assert.ok(existsSync(selected), "the preserved selected root is never a removal candidate");
    removedPerPass.push(before - after);
  }
  assert.deepEqual(removedPerPass, [1, 1, 1, 1], "each pass removed one root until five remained");
  assert.equal(nodeRoots(f).length, 5, "the cache reaches the five-generation target");
  assert.ok(existsSync(selected), "the selected root survives convergence");
  assert.equal(empties.filter((root) => existsSync(root)).length, 4, "four excess empty roots remain");
  assert.equal(readFileSync(outside, "utf8"), "outside remains", "outside bytes are untouched");
});

test(".sh high-fanout directory-only generation advances on every short pass", { skip: isWindows, timeout: 180_000 }, (t) => {
  const f = makeEntrypointFixture(".node-wide-fanout-");
  cleanupFixture(t, f);
  const cache = nodeCache(f);
  mkdirSync(cache, { recursive: true });
  const wide = join(cache, "bootstrap.0-wide");
  mkdirSync(wide, { recursive: true });
  for (let index = 0; index < 3_000; index += 1) mkdirSync(join(wide, `s-${String(index).padStart(4, "0")}`), { recursive: true });
  for (const name of ["bootstrap.8-a", "bootstrap.8-b", "bootstrap.8-c", "bootstrap.8-d"]) mkdirSync(join(cache, name));
  const before = countTreeEntries(wide);
  assert.ok(before >= 3_000, `the fixture really is high-fanout: ${before}`);
  const pass = () => runProducerHarness(f, [
    "export NODE_CLEANUP_BATCH=50",
    "NODE_CLEANUP_BUDGET=1",
    "node_admit || exit 2",
    "echo admit-ok",
  ].join("\n"));
  let previous = before;
  let advanced = 0;
  for (let attempt = 0; attempt < 2 && existsSync(wide); attempt += 1) {
    const result = pass();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /admit-ok/);
    const remaining = existsSync(wide) ? countTreeEntries(wide) : 0;
    assert.ok(remaining < previous,
      `pass ${attempt + 1} deleted real entries instead of only re-identifying them: ${previous} -> ${remaining}`);
    previous = remaining;
    advanced += 1;
  }
  assert.ok(advanced >= 2, "several bounded short passes ran");
  // The normal default budget finishes the same populated generation.
  const finish = runProducerHarness(f, ["node_admit || exit 2", "echo admit-ok"].join("\n"));
  assert.equal(finish.status, 0, finish.stderr);
  assert.equal(existsSync(wide), false, "the directory-only generation is eventually fully deleted");
  assert.ok(nodeRoots(f).length <= 5, `the cache converges: ${nodeRoots(f).length}`);
  f.markAssertionsPassed();
});

/**
 * Native cleanup deferred by contention must be retried once preparation settles:
 * the producer that ends last runs a joined cleanup-only pass, so the cache
 * converges without another fresh generation being created.
 */
test(".sh settlement retries cleanup deferred by contention without another launch", { skip: isWindows, timeout: 120_000 }, async (t) => {
  const f = makeEntrypointFixture(".node-settlement-retry-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const cache = nodeCache(f);
  mkdirSync(cache, { recursive: true });
  const legacy: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const root = join(cache, `bootstrap.0-legacy-${index}`);
    mkdirSync(join(root, "extracted"), { recursive: true });
    writeFileSync(join(root, "extracted", "artifact.txt"), "disposable");
    legacy.push(root);
  }
  const env = { PI_CODING_AGENT_DIR: f.agentDir, FAKE_BOOTSTRAP_DISPATCH_CJS: "1" };
  // Producer A holds the admission lock for its whole preparation.
  const holder = spawn("/bin/bash", [shPath, "--help"], {
    env: entrypointEnv(f, { ...env, FAKE_CURL_HOLD: "1" }),
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const closed = new Promise<number | null>((accept, reject) => { holder.once("error", reject); holder.once("close", accept); });
  t.after(async () => { if (!holder.stdin!.writableEnded) holder.stdin!.end("release\n"); await closed; });
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("no download witness")), 15_000);
    holder.stdio[3]!.on("data", (bytes: Buffer) => {
      if (bytes.toString().includes("DOWNLOAD_READY")) { clearTimeout(timer); accept(); }
    });
    holder.once("close", () => { clearTimeout(timer); reject(new Error("holder exited before its download witness")); });
  });
  const rootsWhileHeld = nodeRoots(f).length;
  // Producer B runs entirely inside A's critical section: it skips cleanup, and so
  // does its own settlement retry, because A still holds the admission entry.
  const competing = runSh(f, ["--help"], env);
  assert.equal(competing.status, 0, competing.stderr);
  assert.match(competing.stderr, /cleanup lock was busy|without reclaiming/);
  const afterCompeting = nodeRoots(f).map((root) => root.split("/").pop());
  assert.ok(afterCompeting.length > generations_LIMIT(),
    `contention left the cache over its target: ${afterCompeting.length} (${afterCompeting.join(",")})`);
  const launchesBefore = recordedPhases(f).filter((phase) => phase === "curl").length;
  holder.stdin!.end("release\n");
  assert.equal(await closed, 0);
  // A's settlement pass is the retry: no third launch happened, yet the cache
  // converges and the seeded generations were actually reclaimed.
  const launchesAfter = recordedPhases(f).filter((phase) => phase === "curl").length;
  assert.equal(launchesAfter, launchesBefore, "no additional fresh launch was needed");
  assert.equal(nodeRoots(f).length, generations_LIMIT(), `settlement retry converged the cache: ${nodeRoots(f).length}`);
  assert.ok(legacy.some((root) => !existsSync(root)), "the seeded generations were actually reclaimed");
  assert.ok(rootsWhileHeld > 0);
  f.markAssertionsPassed();
});

function generations_LIMIT(): number { return 5; }

test(".sh directory-heavy generations make real progress and converge to five", { skip: isWindows, timeout: 180_000 }, (t) => {
  const f = makeEntrypointFixture(".node-dir-heavy-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const env = { PI_CODING_AGENT_DIR: f.agentDir, FAKE_BOOTSTRAP_DISPATCH_CJS: "1" };
  const cache = nodeCache(f);
  mkdirSync(cache, { recursive: true });
  // A broad directory-only generation: a "collect candidates then delete" walker
  // could spend every pass here and delete nothing.
  const dirsOnly = join(cache, "bootstrap.0-dirs-only");
  for (let a = 0; a < 10; a += 1) {
    for (let b = 0; b < 10; b += 1) {
      for (let c = 0; c < 6; c += 1) mkdirSync(join(dirsOnly, `a${a}`, `b${b}`, `c${c}`), { recursive: true });
    }
  }
  // A directory-heavy generation: one real file in each of many directories.
  const heavy = join(cache, "bootstrap.1-heavy");
  for (let index = 0; index < 400; index += 1) {
    const dir = join(heavy, `d${index % 20}`, `e${index}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "artifact.txt"), "disposable by location");
  }
  for (const name of ["bootstrap.9-small-1", "bootstrap.9-small-2", "bootstrap.9-small-3"]) mkdirSync(join(cache, name));
  // Every fresh generation carries the same representative volume, so
  // convergence cannot come from deleting trivial placeholders.
  const populated: string[] = [];
  for (let launch = 0; launch < 9; launch += 1) {
    const before = new Set(nodeRoots(f));
    const result = runSh(f, ["--help"], env);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /capacity exhausted/);
    for (const root of nodeRoots(f)) {
      if (before.has(root) || populated.includes(root)) continue;
      // Thousands of entries in every fresh generation, so convergence cannot
      // come from deleting empty or trivial placeholders.
      fillNodeGeneration(root, 2_000, 300);
      populated.push(root);
    }
  }
  assert.equal(existsSync(dirsOnly), false, "the directory-only generation is fully deleted, not collected forever");
  assert.equal(existsSync(heavy), false, "the directory-heavy generation is fully deleted");
  assert.equal(nodeRoots(f).length, 5, "the cache converges to its five-generation target");
  assert.ok(populated.some((root) => !existsSync(root)), "a populated fresh generation was actually reclaimed");
  const surviving = nodeRoots(f).filter((root) => existsSync(join(root, "d0")));
  assert.ok(surviving.length >= 2, `fresh generations keep their real content: ${surviving.length}`);
  for (const root of surviving) {
    assert.ok(countTreeEntries(root) > 1_000, `a surviving fresh generation still holds thousands of entries: ${countTreeEntries(root)}`);
  }
  f.markAssertionsPassed();
});

test(".sh settled checksum failures remain bounded and reclaimable before the sixth download", { skip: isWindows }, (t) => {
  const f = makeEntrypointFixture(".node-cap-failure-");
  cleanupFixture(t, f);
  writeBootstrapTools(f, { digest: "0".repeat(64) });
  const produced = new Set<string>();
  for (let i = 0; i < 7; i++) {
    const result = runSh(f, ["--help"], { PI_CODING_AGENT_DIR: f.agentDir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /checksum did not match/);
    const roots = nodeRoots(f);
    assert.equal(roots.length, Math.min(i + 1, 5));
    for (const root of roots) produced.add(root);
  }
  assert.equal(produced.size, 7);
  assert.equal([...produced].filter((root) => !existsSync(root)).length, 2);
  assert.ok(!recordedPhases(f).includes("tar-list"));
  f.markAssertionsPassed();
});

test(".sh five existing artifacts never refuse the next launch and stale locks are reclaimed", { skip: isWindows }, (t) => {
  const f = makeEntrypointFixture(".node-cap-no-witness-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const env = { PI_CODING_AGENT_DIR: f.agentDir };
  for (let i = 0; i < 5; i++) assert.equal(runSh(f, ["--help"], env).status, 0);
  const before = nodeRoots(f);
  assert.equal(before.length, 5);
  // A dead owner's lock, and an empty one, are not permanent stop conditions.
  writeFileSync(join(nodeCache(f), ".admission.lock"), "999999999\n", { mode: 0o600 });
  const next = runSh(f, ["--help"], env);
  assert.equal(next.status, 0, next.stderr);
  assert.doesNotMatch(next.stderr, /capacity exhausted/);
  assert.equal(nodeRoots(f).length, 5);
  assert.ok(before.some((root) => !existsSync(root)), "an existing generation was actually reclaimed");
  writeFileSync(join(nodeCache(f), ".admission.lock"), "", { mode: 0o600 });
  assert.equal(runSh(f, ["--help"], env).status, 0);
  assert.ok(recordedPhases(f).filter((p) => p === "curl").length >= 7);
  f.markAssertionsPassed();
});

test(".sh reclaims directory, linked (including device and FIFO targets), oversized and unreadable admission locks instead of skipping pruning", { skip: isWindows }, (t) => {
  for (const shape of ["directory", "symlink", "device-symlink", "fifo-symlink", "oversized", "unreadable"] as const) {
    const f = makeEntrypointFixture(`.node-lock-${shape}-`);
    cleanupFixture(t, f);
    writeBootstrapTools(f);
    const env = { PI_CODING_AGENT_DIR: f.agentDir };
    for (let i = 0; i < 5; i++) assert.equal(runSh(f, ["--help"], env).status, 0);
    const before = nodeRoots(f);
    assert.equal(before.length, 5);
    const outside = join(f.root, "outside-lock-target");
    writeFileSync(outside, "outside lock target");
    const lock = join(nodeCache(f), ".admission.lock");
    if (shape === "directory") mkdirSync(lock);
    else if (shape === "symlink") symlinkSync(outside, lock);
    // A lock link to a device accepts a write-through and a FIFO target would
    // block an opening producer: both must be unlinked, never opened.
    else if (shape === "device-symlink") symlinkSync("/dev/null", lock);
    else if (shape === "fifo-symlink") {
      const fifo = join(f.root, "outside-fifo");
      const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
      assert.equal(made.status, 0, `mkfifo fixture: ${made.stderr}`);
      symlinkSync(fifo, lock);
    }
    // A parseable pid prefix does not make oversized metadata liveness evidence.
    else if (shape === "oversized") writeFileSync(lock, `999999999\n${"x".repeat(200)}`);
    else { writeFileSync(lock, ""); chmodSync(lock, 0o000); }
    const result = runSh(f, ["--help"], env);
    assert.equal(result.status, 0, `${shape}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /capacity exhausted/);
    assert.doesNotMatch(result.stderr, /cleanup lock was busy|lock artifact could not be removed/,
      `${shape}: removable malformed metadata is not reported as a permanent skip`);
    assert.equal(existsSync(lock), false, `${shape}: the malformed lock artifact itself is gone`);
    assert.equal(nodeRoots(f).length, 5, `${shape}: the cache actually pruned to the target`);
    assert.ok(before.some((root) => !existsSync(root)), `${shape}: an existing generation was actually reclaimed`);
    assert.equal(readFileSync(outside, "utf8"), "outside lock target", `${shape}: nothing outside the lock entry is touched`);
    f.markAssertionsPassed();
  }
});

test(".sh never deletes another producer's live lock that replaced malformed metadata", { skip: isWindows }, (t) => {
  const f = makeEntrypointFixture(".node-lock-replaced-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const env = { PI_CODING_AGENT_DIR: f.agentDir };
  for (let i = 0; i < 5; i++) assert.equal(runSh(f, ["--help"], env).status, 0);
  const before = nodeRoots(f);
  assert.equal(before.length, 5);
  const lock = join(nodeCache(f), ".admission.lock");
  mkdirSync(lock);
  const counter = join(f.root, "lock-identity-observations.txt");
  // The synthetic stat wrapper publishes another producer's valid live lock just
  // before the recovering producer would reclaim the artifact it observed.
  const result = runSh(f, ["--help"], {
    ...env,
    FAKE_LOCK_PATH: lock,
    FAKE_LOCK_COUNTER: counter,
    FAKE_LOCK_SWAP_AT: "4",
    FAKE_LOCK_OWNER: String(process.pid),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Number(readFileSync(counter, "utf8")) >= 4, "the replacement was published before reclamation");
  assert.equal(existsSync(lock), true, "the replacement live producer lock survives");
  assert.equal(readFileSync(lock, "utf8"), `${process.pid}\n`, "the replacement lock is byte-for-byte intact");
  assert.match(result.stderr, /cleanup lock was busy|without reclaiming/);
  assert.ok(before.every((root) => existsSync(root)), "no generation was pruned while a live producer owns the lock");
  assert.equal(nodeRoots(f).length, 6, "startup still creates the fresh generation");
  f.markAssertionsPassed();
});

test(".sh malformed, legacy, hardlinked and .terraform-bearing roots are reclaimed without escaping", { skip: isWindows }, (t) => {
  const f = makeEntrypointFixture(".node-cap-unsafe-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const cache = nodeCache(f);
  const names = ["bootstrap.malformed", "bootstrap.legacy", "bootstrap.excluded", "bootstrap.hardlink", "bootstrap.plain"];
  for (const name of names) mkdirSync(join(cache, name), { recursive: true });
  writeFileSync(join(cache, names[0]!, ".node-lifetime"), "malformed");
  writeFileSync(join(cache, names[1]!, ".node-lifetime"), "pi-review-gate-node-v1\n0:0\nbootstrap.legacy\ninactive\n");
  const sentinel = join(f.root, "outside");
  writeFileSync(sentinel, "hardlinked outside");
  linkSync(sentinel, join(cache, names[3]!, "hardlink"));
  mkdirSync(join(cache, names[2]!, ".terraform"));
  writeFileSync(join(cache, names[2]!, ".terraform", "sentinel"), "disposable cleanup content");
  const result = runSh(f, ["--help"], { PI_CODING_AGENT_DIR: f.agentDir });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /capacity exhausted/);
  assert.equal(readFileSync(sentinel, "utf8"), "hardlinked outside", "a hardlink only loses its generation-internal name");
  assert.equal(existsSync(join(cache, names[2]!)), false,
    "cleanup-specific traversal removes an initialized .terraform subtree inside a disposable generation");
  assert.ok(nodeRoots(f).length <= 5);
  f.markAssertionsPassed();
});

test(".sh reclaims five empty and five hidden-record legacy generations and starts", { skip: isWindows }, (t) => {
  for (const shape of ["empty", "hidden-record"] as const) {
    const f = makeEntrypointFixture(`.node-cap-${shape}-`);
    cleanupFixture(t, f);
    writeBootstrapTools(f);
    const cache = nodeCache(f);
    const roots: string[] = [];
    for (let i = 0; i < 5; i++) {
      const root = join(cache, `bootstrap.${shape}-${i}`);
      mkdirSync(root, { recursive: true });
      if (shape === "hidden-record") {
        writeFileSync(join(root, ".node-lifetime"), "pi-review-gate-node-v1\n0:0\nbootstrap.old\ninactive\n");
        writeFileSync(join(root, ".hidden-legacy"), "hidden legacy content");
      }
      roots.push(root);
    }
    const result = runSh(f, ["--help"], { PI_CODING_AGENT_DIR: f.agentDir });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /capacity exhausted/);
    assert.equal(nodeRoots(f).length, 5, `${shape}: exactly five generations remain`);
    assert.ok(roots.some((root) => !existsSync(root)), `${shape}: an actual legacy generation was removed`);
    f.markAssertionsPassed();
  }
});

test(".sh reclaims generations with hardlinked descendants and preserves outside bytes", { skip: isWindows }, (t) => {
  const f = makeEntrypointFixture(".node-hardlink-descendant-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const cache = nodeCache(f);
  mkdirSync(cache, { recursive: true });
  const outside = join(f.root, "outside-hardlink");
  writeFileSync(outside, "hardlinked outside bytes");
  const root = join(cache, "bootstrap.0-hardlink");
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "nested", "ordinary"), "disposable by location");
  linkSync(outside, join(root, "nested", "hardlink"));
  for (let i = 0; i < 5; i++) mkdirSync(join(cache, `bootstrap.1-free-${i}`), { recursive: true });
  const result = runSh(f, ["--help"], { PI_CODING_AGENT_DIR: f.agentDir });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /capacity exhausted/);
  assert.doesNotMatch(result.stderr, /could not|without reclaiming/,
    "a hardlinked descendant name is not a cleanup exclusion");
  assert.equal(existsSync(root), false, "the generation holding a hardlinked descendant was reclaimed");
  assert.equal(nodeRoots(f).length, 5, "the cache pruned to the target");
  assert.equal(readFileSync(outside, "utf8"), "hardlinked outside bytes", "outside bytes are untouched");
  assert.equal(lstatSync(outside).nlink, 1, "only the cache name was removed");
  f.markAssertionsPassed();
});

test(".sh skips a generation whose producer marker names a live process", { skip: isWindows }, (t) => {
  const f = makeEntrypointFixture(".node-cap-in-progress-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const cache = nodeCache(f);
  // Deterministic cleanup order: this name sorts before any random bootstrap
  // generation name, so the live-marker skip (not name order) is what protects it.
  const held = join(cache, "bootstrap.0-held");
  mkdirSync(held, { recursive: true });
  writeFileSync(join(held, ".producer-active"), `${process.pid}\n`);
  for (let i = 0; i < 4; i++) mkdirSync(join(cache, `bootstrap.1-free-${i}`), { recursive: true });
  const result = runSh(f, ["--help"], { PI_CODING_AGENT_DIR: f.agentDir });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(held), "a live producer's generation is preserved");
  assert.ok(nodeRoots(f).length <= 6, "startup proceeds without a capacity refusal");
  // A dead owner's marker is reclaimed normally.
  writeFileSync(join(held, ".producer-active"), "999999999\n");
  const next = runSh(f, ["--help"], { PI_CODING_AGENT_DIR: f.agentDir });
  assert.equal(next.status, 0, next.stderr);
  assert.equal(existsSync(held), false, "a stale marker no longer pins the generation");
  f.markAssertionsPassed();
});

test(".sh never touches an outside marker behind a direct-child cache link", { skip: isWindows }, (t) => {
  const f = makeEntrypointFixture(".node-outside-marker-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const cache = nodeCache(f);
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  mkdirSync(cache, { recursive: true });
  const outsideMarker = join(outside, ".producer-active");
  writeFileSync(outsideMarker, "999999999\n", { mode: 0o600 });
  const before = readFileSync(outsideMarker);
  symlinkSync(outside, join(cache, "bootstrap.0-link"));
  for (let i = 0; i < 4; i++) mkdirSync(join(cache, `bootstrap.1-free-${i}`), { recursive: true });
  const result = runSh(f, ["--help"], { PI_CODING_AGENT_DIR: f.agentDir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(outsideMarker).equals(before), true,
    "the outside marker is byte-identical after cleanup");
  assert.equal(existsSync(join(cache, "bootstrap.0-link")), false, "the cache link itself is unlinked, never traversed");
});

test(".sh reclaims generations with directory and linked marker shapes", { skip: isWindows }, (t) => {
  const f = makeEntrypointFixture(".node-malformed-marker-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const cache = nodeCache(f);
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "sentinel"), "outside stays");
  const shapes = ["bootstrap.0-dir-marker", "bootstrap.1-link-marker", "bootstrap.2-oversized", "bootstrap.3", "bootstrap.4", "bootstrap.5"];
  for (const name of shapes) mkdirSync(join(cache, name), { recursive: true });
  mkdirSync(join(cache, shapes[0]!, ".producer-active"));
  symlinkSync(outside, join(cache, shapes[1]!, ".producer-active"));
  writeFileSync(join(cache, shapes[2]!, ".producer-active"), "x".repeat(200));
  const result = runSh(f, ["--help"], { PI_CODING_AGENT_DIR: f.agentDir });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /capacity exhausted/);
  assert.equal(existsSync(join(cache, shapes[0]!)), false, "a directory-shaped marker does not pin its generation");
  assert.equal(existsSync(join(cache, shapes[1]!)), false, "a linked marker is unlinked with its generation");
  assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "outside stays");
  assert.ok(nodeRoots(f).length <= 5);
});

test(".sh skips cache cleanup while an existing session host owns the agent directory", { skip: isWindows }, (t) => {
  const f = makeEntrypointFixture(".node-cap-owned-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const cache = nodeCache(f);
  const roots: string[] = [];
  for (let i = 0; i < 5; i++) {
    const root = join(cache, `bootstrap.owner-${i}`);
    mkdirSync(root, { recursive: true });
    roots.push(root);
  }
  mkdirSync(join(f.agentDir, "session-host"), { recursive: true });
  writeFileSync(join(f.agentDir, "session-host", "host-ownership.json"), JSON.stringify({ version: 1, hostId: "seed" }));
  const result = runSh(f, ["--help"], { PI_CODING_AGENT_DIR: f.agentDir });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /capacity exhausted/);
  assert.match(result.stderr, /session host currently owns the agent directory/);
  for (const root of roots) assert.ok(existsSync(root), "a live host's generations are left alone");
  f.markAssertionsPassed();
});

// #385 coordination boundary: ownership acquisition and destructive cache
// reclamation take one canonical per-agent entry. These fixtures publish a host
// ownership record at a deterministic point in the real producer path (during a
// stale/malformed lock recovery, or mid-cleanup), never by timer luck.
function seedNodeLegacy(f: EntrypointFixture, prefixName: string, total: number): string[] {
  const cache = nodeCache(f);
  mkdirSync(cache, { recursive: true });
  const roots: string[] = [];
  for (let index = 0; index < total; index += 1) {
    const root = join(cache, `bootstrap.${prefixName}-${index}`);
    mkdirSync(root, { recursive: true });
    roots.push(root);
  }
  return roots;
}

test(".sh publishes no coordination record when the targeted identity query fails", { skip: isWindows || existsSync("/proc/self/stat") }, (t) => {
  // macOS-only: on Linux the identity comes from /proc and does not depend on ps.
  const f = makeEntrypointFixture(".node-identity-unavailable-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  // A `ps` that cannot report anything stands in for a failed targeted query.
  writeExecutable(join(f.bin, "ps"), "#!/bin/bash\nexit 1\n");
  const roots = seedNodeLegacy(f, "legacy", 5);
  const result = runSh(f, ["--help"], { PI_CODING_AGENT_DIR: f.agentDir });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /host ownership coordination was unavailable/u,
    "a failed identity query is reported honestly instead of publishing a weak record");
  assert.equal(existsSync(join(f.agentDir, "session-host", "host-coordination.lock")), false,
    "no pid-only coordination record is published");
  for (const root of roots) assert.ok(existsSync(root), "no reclamation ran without the mutex");
  assert.equal(nodeRoots(f).length, 6, "startup still created its own generation");
  f.markAssertionsPassed();
});

test(".sh stale recovery never reclaims a live replacement coordination record", { skip: isWindows, timeout: 120_000 }, (t) => {
  const f = makeEntrypointFixture(".node-coordination-replacement-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const roots = seedNodeLegacy(f, "legacy", 7);
  const stateDir = join(f.agentDir, "session-host");
  mkdirSync(stateDir, { recursive: true });
  const coordination = join(stateDir, "host-coordination.lock");
  // A stale record (dead pid) that recovery will judge stale.
  writeFileSync(coordination, "999999999\nlinux:stale-birth:1\n", { mode: 0o600 });
  // A valid live replacement: this process's pid and its real birth identity.
  const liveIdentity = (require(join(process.cwd(), "scripts", "managed-generations.cjs")) as {
    coordinationInternals: { ownerStartIdentity(pid: number): string };
  }).coordinationInternals.ownerStartIdentity(process.pid);
  assert.ok(liveIdentity.length > 0, "the replacement carries a real birth identity");
  const counter = join(f.root, "coordination-identity-observations.txt");
  const result = runSh(f, ["--help"], {
    PI_CODING_AGENT_DIR: f.agentDir,
    FAKE_LOCK_PATH: coordination,
    FAKE_COORDINATION_LOCK: coordination,
    FAKE_LOCK_COUNTER: counter,
    // Replacement at the identity-capture observation distinguishes
    // capture-before-verdict (the fix) from capture-after-verdict (the defect):
    // with the fix the stale identity is already held when the live record appears,
    // so reclamation is skipped; with the old order the recovering producer would
    // capture the replacement's identity and delete it.
    FAKE_LOCK_SWAP_AT: "1",
    FAKE_LOCK_OWNER: String(process.pid),
    FAKE_LOCK_IDENTITY: liveIdentity,
  });
  assert.equal(result.status, 0, result.stderr);
  // Artifact survival is the discriminating assertion: under the old ordering the
  // recovering producer captures the replacement's identity and deletes it.
  assert.equal(existsSync(coordination), true, "the live replacement record was not reclaimed");
  assert.equal(readFileSync(coordination, "utf8"), `${process.pid}\n${liveIdentity}\n`,
    "the live replacement record survives byte-for-byte");
  assert.match(result.stderr, /host ownership coordination was unavailable|currently owns/u,
    `reclamation was skipped for the live replacement: ${result.stderr}`);
  assert.ok(!result.stderr.includes("Node cache still holds"), "no reclamation ran beside the live holder");
  for (const root of roots) assert.ok(existsSync(root), "no generation was pruned beside the live replacement");
  assert.equal(nodeRoots(f).length, 8, "startup still created its own generation");
  f.markAssertionsPassed();
});

test(".sh skips pruning when a session host appears during stale-owner lock recovery", { skip: isWindows }, (t) => {
  const f = makeEntrypointFixture(".node-ownership-stale-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const roots = seedNodeLegacy(f, "legacy", 5);
  const lock = join(nodeCache(f), ".admission.lock");
  writeFileSync(lock, "999999999\n", { mode: 0o600 });
  const ownership = join(f.agentDir, "session-host", "host-ownership.json");
  const result = runSh(f, ["--help"], {
    PI_CODING_AGENT_DIR: f.agentDir,
    FAKE_LOCK_PATH: lock,
    FAKE_LOCK_COUNTER: join(f.root, "lock-observations.txt"),
    FAKE_OWNERSHIP_RECORD: ownership,
    FAKE_OWNERSHIP_AT: "1",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /a session host currently owns the agent directory/);
  assert.doesNotMatch(result.stderr, /capacity exhausted/);
  for (const root of roots) assert.ok(existsSync(root), "no generation was pruned after the ownership recheck");
  assert.equal(nodeRoots(f).length, 6, "the competing launch still created its own generation");
  assert.equal(existsSync(lock), false, "the stale lock artifact itself was still reclaimed");
  f.markAssertionsPassed();
});

test(".sh skips pruning when a session host appears during malformed-lock recovery", { skip: isWindows }, (t) => {
  const f = makeEntrypointFixture(".node-ownership-malformed-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const roots = seedNodeLegacy(f, "legacy", 5);
  const lock = join(nodeCache(f), ".admission.lock");
  mkdirSync(lock, { recursive: true });
  const ownership = join(f.agentDir, "session-host", "host-ownership.json");
  const result = runSh(f, ["--help"], {
    PI_CODING_AGENT_DIR: f.agentDir,
    FAKE_LOCK_PATH: lock,
    FAKE_LOCK_COUNTER: join(f.root, "lock-observations.txt"),
    FAKE_OWNERSHIP_RECORD: ownership,
    FAKE_OWNERSHIP_AT: "3",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /a session host currently owns the agent directory/);
  for (const root of roots) assert.ok(existsSync(root), "the recovery window did not cost a host generation");
  assert.equal(existsSync(lock), false, "the malformed artifact itself was still reclaimed");
  assert.equal(nodeRoots(f).length, 6, "the competing launch still created its own generation");
  f.markAssertionsPassed();
});

test(".sh destructive contention with a real host acquisition is serialized past the old bypass", { skip: isWindows, timeout: 120_000 }, async (t) => {
  const f = makeEntrypointFixture(".node-coordination-contention-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const cache = nodeCache(f);
  const roots = seedNodeLegacy(f, "legacy", 7);
  const outside = join(f.root, "outside-sentinel");
  writeFileSync(outside, "outside remains");
  // The host's own prepared artifact lives in a generation the pass keeps; its
  // presence is what this host verifies before claiming ownership.
  const selectedFile = join(roots[6]!, "nested", "legacy-output.txt");
  mkdirSync(join(roots[6]!, "nested"), { recursive: true });
  writeFileSync(selectedFile, "selected artifact");
  const holdLog = join(f.root, "hold.log");
  writeFileSync(holdLog, "");
  const holdMarker = join(f.root, "hold.marker");
  const holdRelease = join(f.root, "hold.release");
  const orderLog = join(f.root, "order.log");
  writeFileSync(orderLog, "");
  const rosterStorePath = join(process.cwd(), "dist-test", "src", "session-host", "roster-store.js");
  const hostScript = join(f.root, "host-acquire.cjs");
  writeFileSync(hostScript, [
    `const fs = require("node:fs");`,
    `const { openHostState } = require(${JSON.stringify(rosterStorePath)});`,
    `const append = (line) => fs.appendFileSync(process.argv[3], line + "\\n");`,
    `append("ACQUIRE-START");`,
    `const opened = openHostState({`,
    `  agentDir: process.argv[2],`,
    `  hostId: "wrapper-contention-host",`,
    `  verify: () => fs.existsSync(process.argv[4]),`,
    `});`,
    `append("OWNED:" + opened.status);`,
    `if (opened.status !== "opened") process.exit(2);`,
    `const deadline = Date.now() + 60000;`,
    `while (!fs.existsSync(process.argv[5]) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);`,
    `append("RELEASE:" + opened.state.release());`,
    ``,
  ].join("\n"), "utf8");
  const env = entrypointEnv(f, {
    PI_CODING_AGENT_DIR: f.agentDir,
    FAKE_HOLD_TRIGGER: roots[1]!,
    FAKE_HOLD_DONE: holdMarker,
    FAKE_HOLD_RELEASE: holdRelease,
    FAKE_HOLD_LOG: holdLog,
    FAKE_OWNERSHIP_RECORD: join(f.agentDir, "session-host", "host-ownership.json"),
  });
  const producer = spawn("/bin/bash", [shPath, "--help"], { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] });
  let producerStderr = "";
  producer.stderr!.setEncoding("utf8");
  producer.stderr!.on("data", (chunk: string) => { producerStderr += chunk; });
  const waitForFile = async (file: string): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(file)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${file}: ${producerStderr}`);
  };
  const waitForLine = async (file: string, needle: string): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (existsSync(file) && readFileSync(file, "utf8").includes(needle)) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${needle}`);
  };
  try {
    await waitForFile(holdMarker);
    const hostRelease = join(f.root, "host.release");
    const host = spawn(process.execPath, [hostScript, f.agentDir, orderLog, selectedFile, hostRelease], { stdio: ["ignore", "ignore", "inherit"] });
    try {
      await waitForLine(orderLog, "ACQUIRE-START");
      // The real .sh producer holds the coordination entry inside its destructive
      // pass, for longer than the previous short acquisition bypass.
      await waitForLine(holdLog, "ownership-during-hold:");
      assert.match(readFileSync(holdLog, "utf8"), /ownership-during-hold:false/,
        "ownership is not claimed while the native wrapper owns the destructive critical section");
      assert.equal(existsSync(join(f.agentDir, "session-host", "host-ownership.json")), false);
      writeFileSync(holdRelease, "release");
      await waitForLine(holdLog, "hold-released");
      await waitForLine(orderLog, "OWNED:opened");
      if (producer.exitCode === null) {
        await new Promise<void>((resolve) => producer.once("exit", () => resolve()));
      }
      assert.equal(producer.exitCode, 0, producerStderr);
      assert.ok(existsSync(selectedFile), "the host's selected artifact survives the contended destructive pass");
      await waitForLine(orderLog, "OWNED:opened");
      const ordered = readFileSync(orderLog, "utf8").trim().split("\n");
      assert.ok(ordered.indexOf("ACQUIRE-START") < ordered.indexOf("OWNED:opened"),
        "the host reached acquisition before ownership was granted");
      assert.equal(existsSync(join(f.agentDir, "session-host", "host-coordination.lock")), false,
        "the wrapper released the coordination entry when its critical section ended");
      // While this host owns the directory, a further producer pass never prunes.
      const before = nodeRoots(f).map((root) => {
        const stats = lstatSync(root);
        return { root, id: `${stats.dev}:${stats.ino}` };
      });
      const second = runSh(f, ["--help"], { PI_CODING_AGENT_DIR: f.agentDir });
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stderr, /a session host currently owns the agent directory/);
      assert.doesNotMatch(second.stderr, /capacity exhausted/);
      for (const entry of before) {
        const stats = lstatSync(entry.root);
        assert.equal(`${stats.dev}:${stats.ino}`, entry.id,
          `the owned generation ${entry.root} keeps its identity while a host owns the directory`);
      }
      assert.equal(readFileSync(outside, "utf8"), "outside remains", "outside sentinels stay intact");
      writeFileSync(hostRelease, "release");
      await waitForLine(orderLog, "RELEASE:");
      assert.match(readFileSync(orderLog, "utf8"), /RELEASE:true/, "the host releases only its own record");
      f.markAssertionsPassed();
    } finally {
      writeFileSync(hostRelease, "release");
      producer.kill("SIGKILL");
      host.kill("SIGKILL");
    }
  } finally {
    writeFileSync(holdRelease, "release");
  }
});

test(".sh stops reclamation at the boundary when a session host appears mid-cleanup", { skip: isWindows }, (t) => {
  const f = makeEntrypointFixture(".node-ownership-boundary-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const roots = seedNodeLegacy(f, "legacy", 7);
  const ownership = join(f.agentDir, "session-host", "host-ownership.json");
  const outside = join(f.root, "outside-sentinel");
  writeFileSync(outside, "outside remains");
  symlinkSync(outside, join(roots[0]!, "outside-link"));
  const result = runSh(f, ["--help"], {
    PI_CODING_AGENT_DIR: f.agentDir,
    FAKE_OWNERSHIP_RECORD: ownership,
    FAKE_OWNERSHIP_TRIGGER: roots[1]!,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /acquired the agent directory during cleanup/);
  assert.equal(existsSync(roots[0]!), false, "the generation already authorized was reclaimed without following its link");
  assert.equal(existsSync(roots[1]!), false, "the generation whose identity triggered ownership was reclaimed");
  for (const root of roots.slice(2)) assert.ok(existsSync(root), "the remaining generations survive the boundary stop");
  assert.equal(readFileSync(outside, "utf8"), "outside remains", "outside sentinels are untouched");
  assert.equal(nodeRoots(f).length, 6, "startup still created its own generation");
  assert.equal(existsSync(join(f.agentDir, "session-host", "host-coordination.lock")), false,
    "the coordination entry is released, never left as a startup gate");
  f.markAssertionsPassed();
});

for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
  test(`.sh forwards wrapper-PID-only ${signal} and waits for exact child exit`, { skip: isWindows, timeout: 30_000 }, async (t) => {
    const f = makeEntrypointFixture(".node-supervisor-signal-");
    cleanupFixture(t, f);
    writeBootstrapTools(f);
    const script = join(f.root, "signal-child.cjs");
    writeFileSync(script, [
      "const report = value => process.stdout.write(JSON.stringify(value) + '\\n');",
      "let received;",
      "for (const signal of ['SIGTERM','SIGHUP','SIGINT']) process.on(signal, () => { received = signal; report({state:'received', signal}); });",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', data => {",
      "  if (data.includes('ping')) report({state:'still-running'});",
      "  if (data.includes('finish')) { report({state:'finished'}); process.exit(23); }",
      "});",
      "report({state:'ready', pid:process.pid, args:process.argv.slice(2)});",
    ].join("\n"));
    const args = ["--", "signal argv π", 'quoted "argument"'];
    const wrapper = spawn("/bin/bash", [shPath, ...args], {
      env: entrypointEnv(f, { PI_CODING_AGENT_DIR: f.agentDir, FAKE_BOOTSTRAP_SIGNAL_CHILD: script }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = new Promise<number | null>((accept, reject) => { wrapper.once("error", reject); wrapper.once("close", accept); });
    const lines = createInterface({ input: wrapper.stdout });
    const rows = lines[Symbol.asyncIterator]();
    const readReport = async (): Promise<{ state: string; signal?: string; pid?: number; args?: string[] }> => {
      let deadline: NodeJS.Timeout | undefined;
      try {
        const row = await Promise.race([
          rows.next(),
          new Promise<never>((_accept, reject) => { deadline = setTimeout(() => reject(new Error("no child signal witness")), 10_000); }),
        ]);
        assert.equal(row.done, false, "child closed before the expected witness");
        return JSON.parse(row.value!);
      } finally { clearTimeout(deadline); }
    };
    t.after(async () => {
      if (!wrapper.stdin.writableEnded) wrapper.stdin.end("finish\n");
      await closed;
      lines.close();
    });
    const ready = await readReport();
    assert.equal(ready.state, "ready");
    assert.deepEqual(ready.args, [cjsPath, ...args]);
    assert.notEqual(ready.pid, wrapper.pid);
    const group = (pid: number) => spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    const wrapperGroup = group(wrapper.pid!);
    assert.ok(wrapperGroup);
    assert.equal(group(ready.pid!), wrapperGroup, "CJS retains the inherited terminal process group");
    assert.equal(wrapper.kill(signal), true, "signal only the wrapper PID, NEVER its process group");
    assert.deepEqual(await readReport(), { state: "received", signal });
    wrapper.stdin.write("ping\n");
    assert.equal((await readReport()).state, "still-running", "stdin remains inherited after the interrupted wait");
    assert.equal(wrapper.exitCode, null, "the wrapper must not exit while the child is still settling");
    assert.doesNotThrow(() => process.kill(wrapper.pid!, 0));
    wrapper.stdin.end("finish\n");
    assert.equal((await readReport()).state, "finished");
    assert.equal(await closed, 23, "return the child's eventual status, not the interrupted wait's signal status");
    assert.equal(wrapper.signalCode, null);
    assert.throws(() => process.kill(ready.pid!, 0), { code: "ESRCH" }, "the exact CJS process exited before the wrapper closed");
    f.markAssertionsPassed();
  });
}

test(".sh a replaced cache parent cannot hide behind matching descendant identities", { skip: isWindows }, (t) => {
  const f = makeEntrypointFixture(".node-cap-parent-replaced-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const sentinel = join(f.root, "outside-sentinel");
  writeFileSync(sentinel, "outside");
  const result = runSh(f, ["--help"], { PI_CODING_AGENT_DIR: f.agentDir, FAKE_SWAP_CACHE_PARENT: "1" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /workspace identity changed during download/);
  assert.ok(!recordedPhases(f).includes("shasum"));
  assert.equal(readFileSync(sentinel, "utf8"), "outside");
  const displaced = join(f.agentDir, ".pi-review-gate.displaced", "node");
  const root = join(displaced, readdirSync(displaced)[0]!);
  assert.ok(existsSync(root), "the displaced bootstrap witness is retained, not falsely reclaimed");
  f.markAssertionsPassed();
});

test(".sh concurrent download/extraction producers both start; a held lock only skips cleanup", { skip: isWindows, timeout: 60_000 }, async (t) => {
  const f = makeEntrypointFixture(".node-cap-concurrent-");
  cleanupFixture(t, f);
  writeBootstrapTools(f);
  const env = { PI_CODING_AGENT_DIR: f.agentDir };
  for (let i = 0; i < 4; i++) assert.equal(runSh(f, ["--help"], env).status, 0);
  const child = spawn("/bin/bash", [shPath, "--help"], {
    env: entrypointEnv(f, { ...env, FAKE_CURL_HOLD: "1" }),
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const closed = new Promise<number | null>((accept, reject) => { child.once("error", reject); child.once("close", accept); });
  t.after(async () => { if (!child.stdin!.writableEnded) child.stdin!.end("release\n"); await closed; });
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error("no download witness")), 15_000);
    child.stdio[3]!.on("data", (bytes: Buffer) => { if (bytes.toString().includes("DOWNLOAD_READY")) { clearTimeout(timer); accept(); } });
    child.once("close", () => { clearTimeout(timer); reject(new Error("producer exited before download witness")); });
  });
  assert.equal(nodeRoots(f).length, 5);
  const result = runSh(f, ["--help"], env);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /capacity exhausted/);
  assert.match(result.stderr, /cleanup lock was busy|without reclaiming/);
  assert.ok(nodeRoots(f).length <= 6, "concurrent creations may briefly exceed the target without refusing either launch");
  child.stdin!.end("release\n");
  assert.equal(await closed, 0);
  const converged = runSh(f, ["--help"], env);
  assert.equal(converged.status, 0, converged.stderr);
  assert.equal(nodeRoots(f).length, 5, "the next launch converges the cache back to five");
  f.markAssertionsPassed();
});

// ---------------------------------------------------------------------------
// Native Windows fixture source patching
//
// The native cases below substitute ONE real producer line so that a host
// ownership record, an inventory failure, or a coordination replacement appears
// at a deterministic point inside the unchanged producer path. An anchor names a
// whole producer line by its trimmed text: a fixture never encodes production
// indentation, exactly one line must match, and a stale or ambiguous anchor is a
// hard setup failure instead of a silently unpatched helper. All of this patching
// is pure, and the guard test below proves every anchor still matches the real
// source on every platform — the native-only cases cannot catch their own stale
// anchors before the Windows CI job runs them.
// ---------------------------------------------------------------------------

interface WindowsFixturePatch {
  /** What the substitution injects; used in failure messages. */
  readonly label: string;
  /** The whole producer line to substitute, written without leading indentation. */
  readonly anchor: string;
  /** Replacement lines, written without leading indentation. */
  readonly replacement: readonly string[];
}

function patchPowerShellLine(source: string, patch: WindowsFixturePatch): string {
  const anchor = patch.anchor.trim();
  assert.ok(anchor.length > 0, `${patch.label}: a fixture anchor is required`);
  assert.ok(patch.replacement.length > 0, `${patch.label}: a fixture replacement is required`);
  const lines = source.split("\n");
  const matched = lines.filter((line) => line.trim() === anchor).length;
  assert.equal(matched, 1,
    `${patch.label}: the fixture anchor matches exactly one producer line (found ${matched} for ${JSON.stringify(anchor)})`);
  const index = lines.findIndex((line) => line.trim() === anchor);
  // Reuse the producer's own indentation so the substitution stays inside the
  // real block and no fixture depends on (or drifts with) a specific column.
  const indent = /^[ \t]*/u.exec(lines[index]!)![0];
  lines.splice(index, 1, ...patch.replacement.map((line) => `${indent}${line}`));
  return lines.join("\n");
}

/** Apply fixture substitutions to the real producer source without writing files. */
function buildWindowsFixtureSource(source: string, patches: readonly WindowsFixturePatch[]): string {
  let patched = source;
  for (const patch of patches) patched = patchPowerShellLine(patched, patch);
  assert.notEqual(patched, source, "the fixture helper differs from the real producer");
  return patched;
}

function windowsFixtureHelperSource(patches: readonly WindowsFixturePatch[]): string {
  return buildWindowsFixtureSource(readFileSync(psPath, "utf8"), patches);
}

const PS_OWNERSHIP_PUBLISH = 'if (-not [IO.File]::Exists($env:FAKE_OWNERSHIP_RECORD)) { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($env:FAKE_OWNERSHIP_RECORD)) | Out-Null; [IO.File]::WriteAllText($env:FAKE_OWNERSHIP_RECORD, \'{"version":1,"hostId":"fixture-owner"}\') }';
const PS_OWNERSHIP_TRIGGER = 'if (-not [IO.File]::Exists($env:FAKE_OWNERSHIP_TRIGGER) -and $name -ceq $env:FAKE_OWNERSHIP_NAME) { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($env:FAKE_OWNERSHIP_TRIGGER)) | Out-Null; [IO.File]::WriteAllText($env:FAKE_OWNERSHIP_TRIGGER, \'{"version":1,"hostId":"fixture-owner"}\') }';

/** Network is the only substituted operation: no native case opens a connection. */
const PS_DOWNLOAD_STUB: WindowsFixturePatch = {
  label: "synthetic download failure",
  anchor: "Receive-OfficialArchive $url $archivePath",
  replacement: ["[IO.File]::AppendAllText($env:DOWNLOAD_WITNESS, 'download`n'); throw 'synthetic download failure'"],
};

/** The same substitution, releasing a live admission-lock holder on the way out. */
const PS_DOWNLOAD_STUB_RELEASING_HOLDER: WindowsFixturePatch = {
  label: "synthetic download failure releasing the admission-lock holder",
  anchor: PS_DOWNLOAD_STUB.anchor,
  replacement: ["[IO.File]::AppendAllText($env:DOWNLOAD_WITNESS, 'download`n'); Stop-Process -Id ([int]$env:FAKE_LOCK_HOLDER) -ErrorAction SilentlyContinue; throw 'synthetic download failure'"],
};

/** A real inventory failure raised from the producer's own inventory call. */
const PS_INVENTORY_FAILURE_STUB: WindowsFixturePatch = {
  label: "synthetic cache inventory failure",
  anchor: "$entries = @([IO.Directory]::EnumerateFileSystemEntries($Root))",
  replacement: ["throw 'synthetic inventory failure'"],
};

/** A host ownership record published while admission-lock recovery observes an
 *  unopenable lock entry. */
const PS_OWNERSHIP_RECORD_DURING_LOCK_RECOVERY: WindowsFixturePatch = {
  label: "host ownership record during admission-lock recovery",
  anchor: "$lockAttributes = Get-ExistingAttributes $lockPath",
  replacement: [PS_OWNERSHIP_PUBLISH, "$lockAttributes = Get-ExistingAttributes $lockPath"],
};

/** A live coordination replacement published exactly between the entry-identity
 *  capture and the owner read: the window the ordering fix closes. */
const PS_COORDINATION_REPLACEMENT: WindowsFixturePatch = {
  label: "live coordination replacement",
  anchor: "try { $current = Get-PathIdentity $path } catch { $current = $null }",
  replacement: [
    'if (-not $script:CoordReplaced -and $env:FAKE_COORDINATION_REPLACEMENT) { $script:CoordReplaced = $true; $replacement = [int]$env:FAKE_COORDINATION_REPLACEMENT; [IO.File]::Delete($path); [IO.File]::WriteAllText($path, [string]$replacement + "`n" + (Get-NodeOwnerIdentity $replacement) + "`n") }',
    "try { $current = Get-PathIdentity $path } catch { $current = $null }",
  ],
};

/** A host ownership record at the real per-candidate removal boundary of the
 *  cleanup loop: the first destructive step of one authorized candidate. */
const PS_OWNERSHIP_RECORD_AT_REMOVAL: WindowsFixturePatch = {
  label: "host ownership record at the candidate removal boundary",
  anchor: "if (Remove-NodeEntry $entry) {",
  replacement: [PS_OWNERSHIP_TRIGGER, "if (Remove-NodeEntry $entry) {"],
};

/** Every producer anchor the native Windows fixtures depend on. */
const WINDOWS_FIXTURE_PATCHES: readonly WindowsFixturePatch[] = [
  PS_DOWNLOAD_STUB,
  PS_DOWNLOAD_STUB_RELEASING_HOLDER,
  PS_INVENTORY_FAILURE_STUB,
  PS_OWNERSHIP_RECORD_DURING_LOCK_RECOVERY,
  PS_COORDINATION_REPLACEMENT,
  PS_OWNERSHIP_RECORD_AT_REMOVAL,
];

function writeWindowsFixtureHelper(f: EntrypointFixture, patches: readonly WindowsFixturePatch[]): { helper: string; downloads: string; powershell: string; env: NodeJS.ProcessEnv } {
  const downloads = join(f.root, "download-witness");
  const helper = join(f.root, "bootstrap.ps1");
  writeFileSync(helper, windowsFixtureHelperSource(patches), "utf8");
  const powershell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = { ...process.env, PATH: f.bin, PI_CODING_AGENT_DIR: f.agentDir, DOWNLOAD_WITNESS: downloads, TEMP: f.root, TMP: f.root };
  return { helper, downloads, powershell, env };
}

test("Windows fixture anchors still match the real producer source on every platform", () => {
  // Executed on macOS, Linux, and Windows alike: the native cases below are
  // Windows-only, so this is the only pre-CI proof that their substitutions still
  // land on real producer lines instead of drifting into an unpatched helper.
  const source = readFileSync(psPath, "utf8");
  const sourceLines = source.split("\n");
  for (const patch of WINDOWS_FIXTURE_PATCHES) {
    const patched = buildWindowsFixtureSource(source, [patch]);
    assert.equal(patched.split("\n").length, sourceLines.length + patch.replacement.length - 1,
      `${patch.label}: exactly one producer line is substituted`);
    const indent = /^[ \t]*/u.exec(sourceLines.find((line) => line.trim() === patch.anchor.trim())!)![0];
    for (const line of patch.replacement) {
      assert.ok(patched.includes(`${indent}${line}`),
        `${patch.label}: the substitution keeps the producer's own indentation`);
    }
  }
  // Negative controls, on the same pure helper: a boundary that no longer exists
  // (the pre-refactor removal statement) and one line that appears twice must both
  // fail the fixture setup instead of quietly patching nothing.
  assert.throws(
    () => buildWindowsFixtureSource(source, [{ label: "stale anchor", anchor: "if (Remove-NodeEntry $entry 0) { $count-- }", replacement: ["Write-Output 'unreachable'"] }]),
    /matches exactly one producer line \(found 0 /u,
    "a stale anchor fails the fixture setup");
  const duplicated = `${source}\n${PS_OWNERSHIP_RECORD_AT_REMOVAL.anchor}\n`;
  assert.throws(
    () => buildWindowsFixtureSource(duplicated, [PS_OWNERSHIP_RECORD_AT_REMOVAL]),
    /matches exactly one producer line \(found 2 /u,
    "an ambiguous anchor fails the fixture setup");
  // The candidate-removal anchor must stay a real destructive boundary: inside the
  // cleanup loop, after the ownership recheck that has to precede a removal.
  const boundary = buildWindowsFixtureSource(source, [PS_OWNERSHIP_RECORD_AT_REMOVAL]);
  const loopStart = boundary.indexOf("$candidateTarget = $Target");
  const ownershipRecheck = boundary.indexOf("Test-NodeHostOwnership $AgentDirectory", loopStart);
  const removal = boundary.indexOf(PS_OWNERSHIP_RECORD_AT_REMOVAL.anchor);
  const loopEnd = boundary.indexOf("$held = $count");
  assert.ok(loopStart >= 0 && ownershipRecheck > loopStart && removal > ownershipRecheck && loopEnd > removal,
    "the injected record sits at the real per-candidate removal boundary after the ownership recheck");
});

test("native Windows fallback bootstrap prunes legacy artifacts and never refuses a sixth", { skip: !isWindows, timeout: 60_000 }, (t) => {
  const f = makeEntrypointFixture(".node-cap-native-windows-");
  cleanupFixture(t, f);
  const helper = join(f.root, "bootstrap.ps1");
  const downloads = join(f.root, "download-witness");
  // Network is the only substituted operation. Native path/identity checks,
  // exclusive generation creation and bounded no-follow cleanup execute unchanged.
  writeFileSync(helper, windowsFixtureHelperSource([PS_DOWNLOAD_STUB]), "utf8");
  const powershell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = { ...process.env, PATH: f.bin, PI_CODING_AGENT_DIR: f.agentDir, DOWNLOAD_WITNESS: downloads, TEMP: f.root, TMP: f.root };
  for (let i = 0; i < 6; i++) {
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "--help"], {
      env: i === 0 ? { ...env, PI_CODING_AGENT_DIR: ".\\agent dir π" } : env,
      cwd: f.root, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(nodeRoots(f).length, Math.min(i + 1, 5), result.stderr);
    assert.equal(readFileSync(downloads, "utf8").split("download").length - 1, i + 1, "every launch reaches the download; capacity never refuses it");
    assert.doesNotMatch(result.stderr, /capacity exhausted/);
  }
  for (const root of nodeRoots(f)) {
    assert.deepEqual(readdirSync(root), ["extracted"], "no compiler scratch and no lifetime receipt; extraction stays inside the generation");
  }
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "sentinel"), "outside");
  symlinkSync(outside, join(nodeRoots(f)[0]!, "junction"), "junction");
  const aliasAgent = join(f.root, "alias-agent");
  mkdirSync(aliasAgent);
  symlinkSync(outside, join(aliasAgent, ".pi-review-gate"), "junction");
  const refused = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper], {
    env: { ...env, PI_CODING_AGENT_DIR: aliasAgent }, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(refused.status, 1);
  assert.deepEqual(readdirSync(outside), ["sentinel"]);
  assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "outside");
  assert.equal(readFileSync(downloads, "utf8").split("download").length - 1, 6);
  f.markAssertionsPassed();
});

test("native Windows cleanup failures warn and still create a fresh generation", { skip: !isWindows, timeout: 60_000 }, (t) => {
  const f = makeEntrypointFixture(".node-cleanup-native-windows-");
  cleanupFixture(t, f);
  const cache = join(f.agentDir, ".pi-review-gate", "node");
  mkdirSync(join(cache, ".admission.lock"), { recursive: true });
  for (let i = 0; i < 5; i++) mkdirSync(join(cache, `bootstrap.legacy-${i}`), { recursive: true });
  const downloads = join(f.root, "download-witness");
  const helper = join(f.root, "bootstrap.ps1");
  // Network and cache inventory are the only substituted operations; native
  // lock handling and generation creation run unchanged.
  writeFileSync(helper, windowsFixtureHelperSource([PS_DOWNLOAD_STUB, PS_INVENTORY_FAILURE_STUB]), "utf8");
  const powershell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = { ...process.env, PATH: f.bin, PI_CODING_AGENT_DIR: f.agentDir, DOWNLOAD_WITNESS: downloads, TEMP: f.root, TMP: f.root };
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "--help"], {
    env, cwd: f.root, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /cleanup lock was busy or unreadable|inventory was unavailable|cleanup could not complete/);
  assert.doesNotMatch(result.stderr, /capacity exhausted/);
  assert.equal(existsSync(join(cache, ".admission.lock")), false,
    "the malformed directory-shaped lock itself was reclaimed before the genuine inventory failure");
  assert.equal(readFileSync(downloads, "utf8").split("download").length - 1, 1,
    "startup reached the download despite the cleanup failures");
  assert.equal(nodeRoots(f).length, 6, "the legacy entries were preserved and a fresh generation was still created");
  f.markAssertionsPassed();
});

test("native Windows reclaims a directory-shaped cache lock and prunes to five", { skip: !isWindows, timeout: 60_000 }, (t) => {
  const f = makeEntrypointFixture(".node-lock-windows-");
  cleanupFixture(t, f);
  const cache = join(f.agentDir, ".pi-review-gate", "node");
  mkdirSync(join(cache, ".admission.lock"), { recursive: true });
  const legacy: string[] = [];
  for (let i = 0; i < 5; i++) {
    const root = join(cache, `bootstrap.legacy-${i}`);
    mkdirSync(root, { recursive: true });
    legacy.push(root);
  }
  const downloads = join(f.root, "download-witness");
  const helper = join(f.root, "bootstrap.ps1");
  // Network is the only substituted operation; native lock handling, inventory
  // and bounded no-follow cleanup execute unchanged.
  writeFileSync(helper, windowsFixtureHelperSource([PS_DOWNLOAD_STUB]), "utf8");
  const powershell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = { ...process.env, PATH: f.bin, PI_CODING_AGENT_DIR: f.agentDir, DOWNLOAD_WITNESS: downloads, TEMP: f.root, TMP: f.root };
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "--help"], {
    env, cwd: f.root, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stderr, /cleanup lock was busy|lock artifact could not be removed|capacity exhausted/,
    "removable malformed lock metadata is not reported as a permanent cleanup skip");
  assert.equal(existsSync(join(cache, ".admission.lock")), false, "the directory-shaped lock is gone");
  assert.equal(nodeRoots(f).length, 5, "exactly five generations remain: one legacy reclaimed, one fresh created");
  assert.ok(legacy.some((root) => !existsSync(root)), "an actual legacy generation was reclaimed");
  assert.equal(readFileSync(downloads, "utf8").split("download").length - 1, 1, "startup reached the download");
  f.markAssertionsPassed();
});

test("native Windows settlement retries cleanup deferred by contention", { skip: !isWindows, timeout: 120_000 }, (t) => {
  // Native Windows proof that contention-deferred reclamation is retried, joined,
  // when preparation settles. Unexecuted on POSIX hosts; run by the Windows CI job.
  const f = makeEntrypointFixture(".node-settlement-windows-");
  cleanupFixture(t, f);
  const cache = nodeCache(f);
  mkdirSync(cache, { recursive: true });
  const legacy: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const root = join(cache, `bootstrap.0-legacy-${index}`);
    mkdirSync(join(root, "extracted"), { recursive: true });
    writeFileSync(join(root, "extracted", "artifact.txt"), "disposable by location");
    legacy.push(root);
  }
  // A real live owner holds the admission entry for the whole preparation and is
  // killed exactly when the synthetic download is reached, so only the settlement
  // pass can reclaim the excess.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  writeFileSync(join(cache, ".admission.lock"), `${holder.pid}\r\n`, "utf8");
  try {
    const downloads = join(f.root, "download-witness");
    const helper = join(f.root, "bootstrap.ps1");
    writeFileSync(helper, windowsFixtureHelperSource([PS_DOWNLOAD_STUB_RELEASING_HOLDER]), "utf8");
    const powershell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const env = {
      ...process.env,
      PATH: f.bin,
      PI_CODING_AGENT_DIR: f.agentDir,
      DOWNLOAD_WITNESS: downloads,
      TEMP: f.root,
      TMP: f.root,
      FAKE_LOCK_HOLDER: String(holder.pid),
    };
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "--help"], {
      env, cwd: f.root, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr ?? "", /cleanup lock was busy or unreadable|without reclaiming/,
      "admission-time cleanup was deferred by the live holder");
    assert.equal(existsSync(join(cache, ".admission.lock")), false,
      "the settlement pass reclaimed the dead admission entry");
    assert.equal(nodeRoots(f).length, 5, `settlement retry converged the cache: ${nodeRoots(f).length}`);
    assert.ok(legacy.some((root) => !existsSync(root)), "seeded generations were reclaimed by the settlement pass");
    assert.equal(readFileSync(downloads, "utf8").split("download").length - 1, 1, "startup still reached the download");
  } finally {
    holder.kill("SIGKILL");
  }
  f.markAssertionsPassed();
});

test("native Windows deletes a populated Node generation and recovers a reused-pid marker", { skip: !isWindows, timeout: 120_000 }, (t) => {
  const f = makeEntrypointFixture(".node-large-generation-windows-");
  cleanupFixture(t, f);
  const cache = nodeCache(f);
  mkdirSync(cache, { recursive: true });
  const outside = join(f.root, "outside-sentinel");
  writeFileSync(outside, "outside remains");
  // Native Windows has no hardlinks in this fixture; the populated generation and
  // the reused-pid marker are the substance of this case.
  const big = join(cache, "bootstrap.0-large");
  mkdirSync(big, { recursive: true });
  // One representative ~10k-entry generation for the native Windows walker.
  fillNodeGeneration(big, 10_000, 400);
  mkdirSync(join(big, ".terraform"), { recursive: true });
  writeFileSync(join(big, ".terraform", "sentinel"), "cleanup-specific");
  assert.ok(countTreeEntries(big) > 10_000, `the fixture holds a representative volume: ${countTreeEntries(big)}`);
  const reused = join(cache, "bootstrap.1-reused");
  mkdirSync(reused, { recursive: true });
  writeFileSync(join(reused, "content.txt"), "reclaimable");
  const marker = join(reused, ".producer-active");
  writeFileSync(marker, `${process.pid}\r\n`, { mode: 0o600 });
  const longAgo = new Date(Date.now() - 3_600_000);
  utimesSync(marker, longAgo, longAgo);
  // The cache is already OVERFULL before this launch creates anything: six
  // removable generations, so a single admission pass must reclaim the two
  // front-of-order candidates (the populated generation and the reused-pid one)
  // and only then create its own. The excess names sort after both of them, in
  // the same deterministic name order the producer uses, and each one carries real
  // content so a removal is genuine. Rotation of the random `bootstrap-<guid>`
  // generations that are already within the limit is deliberately NOT expected:
  // production applies no age or size policy, so eviction order alone decides.
  for (const name of ["bootstrap.9-small-1", "bootstrap.9-small-2", "bootstrap.9-small-3", "bootstrap.9-small-4"]) {
    mkdirSync(join(cache, name, "extracted"), { recursive: true });
    writeFileSync(join(cache, name, "extracted", "artifact.txt"), "disposable by location");
  }
  const downloads = join(f.root, "download-witness");
  const helper = join(f.root, "bootstrap.ps1");
  writeFileSync(helper, windowsFixtureHelperSource([PS_DOWNLOAD_STUB]), "utf8");
  const powershell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = { ...process.env, PATH: f.bin, PI_CODING_AGENT_DIR: f.agentDir, DOWNLOAD_WITNESS: downloads, TEMP: f.root, TMP: f.root };
  let launches = 0;
  for (let launch = 0; launch < 4; launch += 1) {
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "--help"], {
      env, cwd: f.root, encoding: "utf8", timeout: 60_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr ?? "", /capacity exhausted/);
    launches += 1;
    if (!existsSync(big) && !existsSync(reused)) break;
  }
  assert.equal(launches, readFileSync(downloads, "utf8").split("download").length - 1,
    "every launch still reached the download: cleanup never refuses a launch");
  assert.equal(existsSync(reused), false, "a reused-pid marker never keeps its generation forever");
  assert.equal(existsSync(big), false, "the populated generation was actually deleted, not just counted");
  assert.equal(nodeRoots(f).length, 5, "the cache converges to its five-generation target");
  assert.equal(readdirSync(cache).filter((name) => name.startsWith("bootstrap-")).length, 1,
    "this launch still created its own fresh generation beside the four under-limit ones");
  assert.equal(readFileSync(outside, "utf8"), "outside remains", "outside bytes are never deleted");
  f.markAssertionsPassed();
});

test("native Windows deletes directory-heavy generations progressively and converges to five", { skip: !isWindows, timeout: 180_000 }, (t) => {
  const f = makeEntrypointFixture(".node-dir-heavy-windows-");
  cleanupFixture(t, f);
  const cache = nodeCache(f);
  mkdirSync(cache, { recursive: true });
  const dirsOnly = join(cache, "bootstrap.0-dirs-only");
  for (let a = 0; a < 8; a += 1) {
    for (let b = 0; b < 8; b += 1) {
      for (let c = 0; c < 6; c += 1) mkdirSync(join(dirsOnly, `a${a}`, `b${b}`, `c${c}`), { recursive: true });
    }
  }
  const heavy = join(cache, "bootstrap.1-heavy");
  for (let index = 0; index < 400; index += 1) {
    const dir = join(heavy, `d${index % 20}`, `e${index}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "artifact.txt"), "disposable by location");
  }
  // Overfull before creation exactly like the populated case: the pass has to
  // reclaim the directory-only and directory-heavy generations, then create its
  // own; later launches keep reclaiming populated fresh generations as they are
  // evicted in deterministic name order.
  for (const name of ["bootstrap.9-small-1", "bootstrap.9-small-2", "bootstrap.9-small-3", "bootstrap.9-small-4"]) {
    mkdirSync(join(cache, name, "extracted"), { recursive: true });
    writeFileSync(join(cache, name, "extracted", "artifact.txt"), "disposable by location");
  }
  const downloads = join(f.root, "download-witness");
  const helper = join(f.root, "bootstrap.ps1");
  writeFileSync(helper, windowsFixtureHelperSource([PS_DOWNLOAD_STUB]), "utf8");
  const powershell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = { ...process.env, PATH: f.bin, PI_CODING_AGENT_DIR: f.agentDir, DOWNLOAD_WITNESS: downloads, TEMP: f.root, TMP: f.root };
  const populated: string[] = [];
  for (let launch = 0; launch < 9; launch += 1) {
    const before = new Set(nodeRoots(f));
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "--help"], {
      env, cwd: f.root, encoding: "utf8", timeout: 120_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr ?? "", /capacity exhausted/);
    for (const root of nodeRoots(f)) {
      if (before.has(root) || populated.includes(root)) continue;
      // Thousands of entries in every fresh generation on native Windows too, so
      // convergence cannot come from deleting empty or trivial placeholders.
      fillNodeGeneration(root, 2_000, 300);
      populated.push(root);
    }
  }
  assert.equal(existsSync(dirsOnly), false, "the directory-only generation is fully deleted, not collected forever");
  assert.equal(existsSync(heavy), false, "the directory-heavy generation is fully deleted");
  assert.equal(nodeRoots(f).length, 5, "the cache converges to its five-generation target");
  assert.ok(populated.some((root) => !existsSync(root)), "a populated fresh generation was actually reclaimed");
  assert.ok(readFileSync(downloads, "utf8").split("download").length - 1 >= 5, "every launch still reached the download");
  f.markAssertionsPassed();
});

// #385 coordination boundary (native Windows): ownership acquisition and
// destructive cache reclamation take one canonical per-agent entry. These cases
// substitute one real producer line (see the patching helpers above) so a host
// ownership record appears at a deterministic point in the real producer path.
// The substitutions themselves are guarded by the all-platform anchor test above;
// the executable cases run only in the native Windows CI job
// (session-host-entrypoints.test.js), never on a POSIX runner.
test("native Windows skips pruning when a session host appears during admission-lock recovery", { skip: !isWindows, timeout: 60_000 }, (t) => {
  const f = makeEntrypointFixture(".node-ownership-windows-recovery-");
  cleanupFixture(t, f);
  const cache = nodeCache(f);
  mkdirSync(join(cache, ".admission.lock"), { recursive: true });
  const legacy: string[] = [];
  for (let i = 0; i < 5; i++) {
    const root = join(cache, `bootstrap.legacy-${i}`);
    mkdirSync(root, { recursive: true });
    legacy.push(root);
  }
  const ownership = join(f.agentDir, "session-host", "host-ownership.json");
  const { helper, downloads, powershell, env } = writeWindowsFixtureHelper(f, [PS_DOWNLOAD_STUB, PS_OWNERSHIP_RECORD_DURING_LOCK_RECOVERY]);
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "--help"], {
    env: { ...env, FAKE_OWNERSHIP_RECORD: ownership }, cwd: f.root, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /a session host currently owns the agent directory/);
  assert.doesNotMatch(result.stderr, /capacity exhausted/);
  for (const root of legacy) assert.ok(existsSync(root), "no generation was pruned after the ownership recheck");
  assert.equal(nodeRoots(f).length, 6, "the competing launch still created its own generation");
  assert.equal(existsSync(join(cache, ".admission.lock")), false, "the malformed lock artifact itself was still reclaimed");
  assert.equal(readFileSync(downloads, "utf8").split("download").length - 1, 1, "startup reached the download");
  f.markAssertionsPassed();
});

// #385 canonical mutex, native Windows: CJS/TypeScript records must carry a real
// `win32:<StartTime>` birth identity (never a pid-only record), and a live pid with
// a mismatched birth identity must not block startup. These run only in the native
// Windows CI job.
const CJS_GENERATIONS = resolve("scripts/managed-generations.cjs");
const ROSTER_STORE = resolve("dist-test/src/session-host/roster-store.js");

function runNode(script: string, args: string[], env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["-e", script, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("native Windows identity queries use a parameterized script block for one known pid", { skip: !isWindows, timeout: 60_000 }, (t) => {
  const cjs = readFileSync(CJS_GENERATIONS, "utf8");
  const host = readFileSync(resolve("src/session-host/roster-store.ts"), "utf8");
  for (const [label, source] of [["CJS", cjs], ["TypeScript host", host]] as const) {
    assert.match(source, /& \{ param\(\[int\]\$OwnerPid\)/u,
      `${label}: the query is invoked as a parameterized script block`);
    assert.match(source, /Get-Process -Id \$OwnerPid/u,
      `${label}: the query uses its script-block parameter, not -Command positional text`);
    assert.doesNotMatch(source, /\[int\]\$args\[0\]/u,
      `${label}: the appended pid is never interpreted as -Command text`);
  }
  // The current pid resolves through the real query and round-trips.
  const script = [
    `const generations = require(${JSON.stringify(CJS_GENERATIONS)});`,
    `process.stdout.write(JSON.stringify({`,
    `  own: generations.coordinationInternals.ownOwnerIdentity(),`,
    `  again: generations.coordinationInternals.ownerStartIdentity(process.pid),`,
    `}));`,
    ``,
  ].join("\n");
  const result = runNode(script, []);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim()) as { own: string; again: string };
  assert.match(parsed.own, /^win32:\d{4}-\d{2}-\d{2}T/u, "the current pid's identity resolves through the script block");
  assert.equal(parsed.again, parsed.own, "the same pid round-trips through the query");
  // A foreign live pid also resolves.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    const foreignScript = [
      `const generations = require(${JSON.stringify(CJS_GENERATIONS)});`,
      `process.stdout.write(generations.coordinationInternals.ownerStartIdentity(Number(process.argv[1])));`,
      ``,
    ].join("\n");
    const foreign = runNode(foreignScript, [String(holder.pid)]).stdout.trim();
    assert.match(foreign, /^win32:\d{4}-\d{2}-\d{2}T/u, `a foreign live pid resolves: ${JSON.stringify(foreign)}`);
  } finally {
    holder.kill("SIGKILL");
  }
});

test("native Windows stale recovery never reclaims a live replacement coordination record", { skip: !isWindows, timeout: 90_000 }, (t) => {
  const f = makeEntrypointFixture(".coord-replacement-windows-");
  cleanupFixture(t, f);
  const cache = nodeCache(f);
  const stateDir = join(f.agentDir, "session-host");
  mkdirSync(stateDir, { recursive: true });
  const entry = join(stateDir, "host-coordination.lock");
  // A stale record (dead pid) that recovery judges stale.
  writeFileSync(entry, "999999999\nwin32:1999-01-01T00:00:00.0000000Z\n", "utf8");
  const legacy: string[] = [];
  for (let i = 0; i < 5; i++) {
    const root = join(cache, `bootstrap.legacy-${i}`);
    mkdirSync(root, { recursive: true });
    legacy.push(root);
  }
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    // The replacement appears exactly between the entry-identity capture and the
    // owner read: the window the ordering fix closes.
    const { helper, downloads, powershell, env } = writeWindowsFixtureHelper(f, [PS_DOWNLOAD_STUB, PS_COORDINATION_REPLACEMENT]);
    const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "--help"], {
      env: { ...env, FAKE_COORDINATION_REPLACEMENT: String(holder.pid) }, cwd: f.root, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr, /capacity exhausted/u);
    const record = readFileSync(entry, "utf8").split(/\r?\n/u);
    assert.equal(record[0]!.trim(), String(holder.pid), "the live replacement record survives, unclaimed");
    assert.match((record[1] ?? "").trim(), /^win32:\d{4}-\d{2}-\d{2}T/u,
      "the replacement keeps its own birth identity");
    assert.match(result.stderr, /host ownership coordination was unavailable|currently owns/u,
      `reclamation was skipped for the live replacement: ${result.stderr}`);
    for (const root of legacy) assert.ok(existsSync(root), "no generation was pruned beside the live replacement");
    assert.equal(nodeRoots(f).length, 6, "startup still created its own generation");
    assert.equal(readFileSync(downloads, "utf8").split("download").length - 1, 1, "startup reached the download");
  } finally {
    holder.kill("SIGKILL");
  }
  f.markAssertionsPassed();
});

test("native Windows coordination records from the CJS producer carry a win32 birth identity", { skip: !isWindows, timeout: 60_000 }, (t) => {
  const f = makeEntrypointFixture(".coord-identity-cjs-windows-");
  cleanupFixture(t, f);
  mkdirSync(join(f.agentDir, "session-host"), { recursive: true });
  const script = [
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const generations = require(${JSON.stringify(CJS_GENERATIONS)});`,
    `const lease = generations.holdAgentDirectory(process.argv[1]);`,
    `if (!lease) { process.stdout.write("no-lease"); process.exit(2); }`,
    `const entry = path.join(process.argv[1], "session-host", generations.COORDINATION);`,
    `process.stdout.write(fs.readFileSync(entry, "utf8"));`,
    `lease.release();`,
    ``,
  ].join("\n");
  const result = runNode(script, [f.agentDir]);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split(/\r?\n/u);
  assert.match(result.stdout, /^[1-9][0-9]*\r?\n/u, "the record's first line is the owning pid");
  assert.match(lines[1] ?? "", /^win32:\d{4}-\d{2}-\d{2}T/u,
    `the CJS record carries a real win32 birth identity, never a bare pid: ${JSON.stringify(lines[1])}`);
  assert.equal(existsSync(join(f.agentDir, "session-host", "host-coordination.lock")), false, "the lease released its own record");
  f.markAssertionsPassed();
});

test("native Windows coordination records from the TypeScript host carry a win32 birth identity", { skip: !isWindows, timeout: 60_000 }, (t) => {
  const f = makeEntrypointFixture(".coord-identity-host-windows-");
  cleanupFixture(t, f);
  const stateDir = join(f.agentDir, "session-host");
  mkdirSync(stateDir, { recursive: true });
  const script = [
    `const fs = require("node:fs");`,
    `const path = require("node:path");`,
    `const store = require(${JSON.stringify(ROSTER_STORE)});`,
    `const published = store.publishHostCoordinationRecord(process.argv[1]);`,
    `const entry = path.join(process.argv[1], store.HOST_COORDINATION_FILENAME);`,
    `process.stdout.write(String(published) + "\\n" + (fs.existsSync(entry) ? fs.readFileSync(entry, "utf8") : ""));`,
    ``,
  ].join("\n");
  const result = runNode(script, [stateDir]);
  assert.equal(result.status, 0, result.stderr);
  const [publishedLine, pidLine, identityLine] = result.stdout.trim().split(/\r?\n/u);
  assert.equal(publishedLine!.trim(), "true", "the host publishes the coordination record");
  assert.match(pidLine ?? "", /^[1-9][0-9]*$/u, "the record's first line is the owning pid");
  assert.match(identityLine ?? "", /^win32:\d{4}-\d{2}-\d{2}T/u,
    `the TypeScript record carries a real win32 birth identity, never a bare pid: ${JSON.stringify(identityLine)}`);
  f.markAssertionsPassed();
});

test("native Windows reused-pid coordination metadata never blocks startup", { skip: !isWindows, timeout: 90_000 }, (t) => {
  const f = makeEntrypointFixture(".coord-reused-pid-windows-");
  cleanupFixture(t, f);
  const stateDir = join(f.agentDir, "session-host");
  mkdirSync(stateDir, { recursive: true });
  const entry = join(stateDir, "host-coordination.lock");
  // A live process whose record names a birth identity that is not its own is the
  // reused-pid case: it must be reclaimed promptly, not honored forever.
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    const script = [
      `const store = require(${JSON.stringify(ROSTER_STORE)});`,
      `const started = Date.now();`,
      `const opened = store.openHostState({ agentDir: process.argv[1], hostId: "reused-pid" });`,
      `process.stdout.write(JSON.stringify({ status: opened.status, elapsed: Date.now() - started }) + "\\n");`,
      `if (opened.status === "opened") opened.state.release();`,
      ``,
    ].join("\n");
    // Correct-birth control: the same live pid with its real identity is honored.
    const identityScript = [
      `const generations = require(${JSON.stringify(CJS_GENERATIONS)});`,
      `process.stdout.write(generations.coordinationInternals.ownerStartIdentity(Number(process.argv[1])));`,
      ``,
    ].join("\n");
    const identity = runNode(identityScript, [String(holder.pid)]).stdout.trim();
    assert.match(identity, /^win32:\d{4}-\d{2}-\d{2}T/u,
      `the CJS query yields the live pid's real birth identity: ${JSON.stringify(identity)}`);
    writeFileSync(entry, `${holder.pid}\nwin32:1999-01-01T00:00:00.0000000Z\n`, "utf8");
    const mismatched = runNode(script, [f.agentDir]);
    assert.equal(mismatched.status, 0, mismatched.stderr);
    const mismatchedResult = JSON.parse(mismatched.stdout.trim()) as { status: string; elapsed: number };
    assert.equal(mismatchedResult.status, "opened", "a reused pid with a wrong birth identity never gates ownership");
    assert.ok(mismatchedResult.elapsed < 10_000, `the stale record was reclaimed promptly (${mismatchedResult.elapsed}ms)`);
    assert.equal(existsSync(entry), false, "the stale record itself is gone");
    // The same live pid with its real birth identity is a current holder: the
    // producer admission then leaves the cache untouched instead of reclaiming,
    // while still creating its own generation. Real excess generations with real
    // bytes and entry counts make that proof non-vacuous: a skipped cleanup has
    // something real to leave alone.
    writeFileSync(entry, `${holder.pid}\n${identity}\n`, "utf8");
    const cache = nodeCache(f);
    mkdirSync(cache, { recursive: true });
    const survivors: Array<{ root: string; artifact: string; entries: number; bytes: string }> = [];
    for (let index = 0; index < 6; index += 1) {
      const root = join(cache, `bootstrap.0-survivor-${index}`);
      mkdirSync(join(root, "extracted"), { recursive: true });
      const artifact = join(root, "extracted", "artifact.txt");
      const bytes = `survivor generation ${index} payload`;
      writeFileSync(artifact, bytes, "utf8");
      survivors.push({ root, artifact, entries: countTreeEntries(root), bytes });
    }
    const admitScript = [
      `const fs = require("node:fs");`,
      `const path = require("node:path");`,
      `const generations = require(${JSON.stringify(CJS_GENERATIONS)});`,
      `const warnings = [];`,
      `const cache = path.join(process.argv[1], ".pi-review-gate", "node");`,
      `const stage = generations.admit(cache, () => ({ root: fs.mkdtempSync(path.join(cache, "bootstrap.")) }), { warn: (warning) => warnings.push(warning) });`,
      `const created = stage.root;`,
      `stage.generation.release();`,
      `process.stdout.write(JSON.stringify({ warnings, created }) + "\\n");`,
      ``,
    ].join("\n");
    const honored = runNode(admitScript, [f.agentDir]);
    assert.equal(honored.status, 0, honored.stderr);
    const honoredResult = JSON.parse(honored.stdout.trim()) as { warnings: string[]; created: string };
    assert.ok(honoredResult.warnings.some((warning) => warning.includes("host ownership coordination")),
      `the current holder is honored on Windows too: ${honoredResult.warnings.join(" | ")}`);
    for (const survivor of survivors) {
      assert.ok(existsSync(survivor.root), `a generation of the honored holder survives cleanup: ${survivor.root}`);
      assert.equal(readFileSync(survivor.artifact, "utf8"), survivor.bytes, "survivor bytes are untouched");
      assert.equal(countTreeEntries(survivor.root), survivor.entries, "no entry inside a survivor generation was deleted");
    }
    assert.equal(dirname(resolve(honoredResult.created)), resolve(cache),
      "the fresh generation is created inside the cache while cleanup stays away");
    assert.ok(existsSync(honoredResult.created), "startup still created its own generation");
    assert.equal(nodeRoots(f).length, 7, "six untouched generations plus this launch's own");
  } finally {
    holder.kill("SIGKILL");
  }
  f.markAssertionsPassed();
});

test("native Windows stops reclamation at the boundary when a session host appears mid-cleanup", { skip: !isWindows, timeout: 60_000 }, (t) => {
  const f = makeEntrypointFixture(".node-ownership-windows-boundary-");
  cleanupFixture(t, f);
  const cache = nodeCache(f);
  const legacy: string[] = [];
  for (let i = 0; i < 7; i++) {
    const root = join(cache, `bootstrap.legacy-${i}`);
    mkdirSync(root, { recursive: true });
    legacy.push(root);
  }
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "sentinel"), "outside");
  symlinkSync(outside, join(legacy[0]!, "junction"), "junction");
  const trigger = join(f.agentDir, "session-host", "host-ownership.json");
  const { helper, downloads, powershell, env } = writeWindowsFixtureHelper(f, [PS_DOWNLOAD_STUB, PS_OWNERSHIP_RECORD_AT_REMOVAL]);
  const result = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "--help"], {
    env: { ...env, FAKE_OWNERSHIP_TRIGGER: trigger, FAKE_OWNERSHIP_NAME: "bootstrap.legacy-1" }, cwd: f.root, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /acquired the agent directory during cleanup/);
  assert.equal(existsSync(legacy[0]!), false, "the generation already authorized was reclaimed without entering its junction");
  assert.equal(existsSync(legacy[1]!), false, "the generation whose identity triggered ownership was reclaimed");
  for (const root of legacy.slice(2)) assert.ok(existsSync(root), "the remaining generations survive the boundary stop");
  assert.deepEqual(readdirSync(outside), ["sentinel"], "nothing outside the cache is touched");
  assert.equal(readFileSync(downloads, "utf8").split("download").length - 1, 1, "startup reached the download");
  f.markAssertionsPassed();
});

test("native Windows fences outside junction markers, prunes malformed markers, and keeps live owners", { skip: !isWindows, timeout: 90_000 }, (t) => {
  const f = makeEntrypointFixture(".node-outside-marker-windows-");
  cleanupFixture(t, f);
  const cache = join(f.agentDir, ".pi-review-gate", "node");
  const outside = join(f.root, "outside");
  mkdirSync(outside);
  const outsideMarker = join(outside, ".producer-active");
  writeFileSync(outsideMarker, "999999999\n", { mode: 0o600 });
  const before = readFileSync(outsideMarker);
  const link = join(cache, "bootstrap.0-link");
  mkdirSync(cache, { recursive: true });
  symlinkSync(outside, link, "junction");
  const dirMarker = join(cache, "bootstrap.1-dir-marker");
  mkdirSync(join(dirMarker, ".producer-active"), { recursive: true });
  const liveOwner = join(cache, "bootstrap.2-live-owner");
  mkdirSync(liveOwner, { recursive: true });
  writeFileSync(join(liveOwner, ".producer-active"), `${process.pid}\n`);
  for (let i = 0; i < 6; i++) mkdirSync(join(cache, `bootstrap.3-filler-${i}`), { recursive: true });
  const downloads = join(f.root, "download-witness");
  const helper = join(f.root, "bootstrap.ps1");
  writeFileSync(helper, windowsFixtureHelperSource([PS_DOWNLOAD_STUB]), "utf8");
  const powershell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = { ...process.env, PATH: f.bin, PI_CODING_AGENT_DIR: f.agentDir, DOWNLOAD_WITNESS: downloads, TEMP: f.root, TMP: f.root };
  const run = () => spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "--help"], {
    env, cwd: f.root, encoding: "utf8", timeout: 20_000,
  });
  for (let attempt = 0; attempt < 8 && (existsSync(link) || existsSync(dirMarker)); attempt++) {
    const result = run();
    assert.equal(result.status, 1, result.stderr);
    assert.equal(readFileSync(outsideMarker).equals(before), true, "the outside marker is byte-identical after cleanup");
  }
  assert.equal(existsSync(link), false, "the junction itself is removed, never traversed");
  assert.equal(existsSync(dirMarker), false, "a directory-shaped marker does not pin its generation");
  assert.ok(existsSync(liveOwner), "a valid live-owner marker continues to protect its generation");
  assert.ok(nodeRoots(f).length <= 5, "the cache converged to the five-generation target");
  f.markAssertionsPassed();
});

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
  assert.match(helper, /^\s*Start-SessionCjs \$FallbackNodeExecutable \$FallbackNodeDirectory \$CjsArguments$/m);
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
