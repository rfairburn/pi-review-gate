#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

// Traversal-time exclusion for staged copies: never descend into initialized
// Terraform directories (they can be hundreds of GB), at any depth. The
// selected entry list below stays narrow; this filter only prunes .terraform.
function stageFilter(source) {
  return path.basename(source) !== ".terraform";
}

/**
 * Retain an owned package-smoke scratch tree. Root origin and identity do not
 * establish creation ownership for its descendants, and the smoke has no
 * complete per-entry BigInt identity receipts. Therefore cleanup must not
 * enumerate, inspect, or remove any descendant (including symlinks and
 * .terraform directories). The returned array keeps the existing export shape
 * and contains the retained root path.
 *
 * Guards: the root must exist, be a real directory (not a symlink). This
 * bounded lstat is admission only; it grants no authority over descendants.
 */
function removeOwnedScratch(root) {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`owned scratch root must not be a symlink: ${root}`);
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`owned scratch root is not a directory: ${root}`);
  }
  return [root];
}

/** Flat production module inventory of the session host source directory. */
function sessionHostSourceModules(sourceDir) {
  assert.ok(
    fs.statSync(sourceDir, { throwIfNoEntry: false })?.isDirectory(),
    `missing session host source directory: ${sourceDir}`,
  );
  return fs.readdirSync(sourceDir)
    .filter((entry) => entry.endsWith(".ts") && fs.statSync(path.join(sourceDir, entry)).isFile())
    .sort();
}

// Semantic (not exact-prose) markers the side-effect-free --help must name.
const SESSION_HOST_HELP_MARKERS = [
  ["alpha scope", /alpha/i],
  ["macOS/Linux platforms", /macos\/linux/i],
  ["Node >=22.19.0 floor", /node\s*>=\s*22\.19\.0/i],
  ["Pi >=1.0.4 floor", /pi\s*>=\s*1\.0\.4/i],
  ["positive Node CLI entry guidance", /positively identified node cli entry/i],
  ["empty picker with explicit workspace selection", /empty[\s\S]{0,80}picker/i],
  ["startup working directory not auto-selected", /not selected as a workspace/i],
  ["alt+left sidebar toggle", /alt\+left/i],
];

// Fresh-consumer runtime pins (mirror the package.json dependency pins).
const SESSION_HOST_RUNTIME_PINS = {
  "pi-session-host-tui": { name: "@earendil-works/pi-tui", version: "1.0.4" },
  "@xterm/headless": { version: "6.0.0" },
  "@xterm/addon-unicode11": { version: "0.9.0" },
};

/**
 * Validate the optional session-host surface of an installed pi-review-gate
 * package: exact bin metadata, executable consumer shim, side-effect-free
 * --help semantics, derived compiled-module shipment, fresh-consumer runtime
 * pins, canonical peer isolation, and the runtime probe report (lazy PTY,
 * headless render). Pure over the given paths and seams — no scratch, no
 * build, no install, no CLI of its own. The real smoke feeds it a live
 * --help run and a fresh-consumer subprocess probe; focused tests feed
 * synthetic MOCK/SYNTHETIC fixtures and reports.
 */
function validateSessionHostPackage(options) {
  const { installedRoot, consumerNodeModules, sourceModulesDir, runHelp, runRuntimeProbe } = options;
  assert.ok(
    installedRoot && consumerNodeModules && sourceModulesDir && typeof runHelp === "function" && typeof runRuntimeProbe === "function",
    "validateSessionHostPackage requires installedRoot, consumerNodeModules, sourceModulesDir, runHelp, and runRuntimeProbe",
  );

  // Exact bin metadata: the settled optional session-host entry.
  const manifest = JSON.parse(fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  assert.equal(
    manifest.bin && manifest.bin["pi-review-sessions"],
    "scripts/pi-review-sessions.cjs",
    "installed bin metadata for pi-review-sessions must point exactly at scripts/pi-review-sessions.cjs",
  );

  // The installed target is a Node script, and the consumer's .bin shim is
  // executable (same POSIX runner scope as the existing smoke; no Windows
  // host support or scaffold).
  const binTarget = path.join(installedRoot, "scripts", "pi-review-sessions.cjs");
  assert.ok(fs.statSync(binTarget).isFile(), "missing installed bin target: scripts/pi-review-sessions.cjs");
  assert.match(
    fs.readFileSync(binTarget, "utf8").split(/\r?\n/, 1)[0],
    /^#!.*node/,
    "bin target must carry a Node shebang: scripts/pi-review-sessions.cjs",
  );
  const binShim = path.join(consumerNodeModules, ".bin", "pi-review-sessions");
  fs.accessSync(binShim, fs.constants.X_OK);

  // Side-effect-free --help with semantic (not exact-prose) assertions. The
  // launcher answers help before any TTY/DDGS/build/native-binding work, so
  // this never launches a host or touches the user's home.
  const help = runHelp(binShim);
  assert.equal(help.status, 0, `session host --help must exit 0, got ${help.status}`);
  for (const [label, pattern] of SESSION_HOST_HELP_MARKERS) {
    assert.ok(pattern.test(help.stdout), `session host --help is missing its ${label} guidance`);
  }

  // Derived compiled inventory: every actual flat src/session-host/*.ts
  // production module ships its compiled .js and .d.ts (a later Main/input
  // lands automatically). No source TS or private development docs are
  // assumed to ship.
  for (const module of sessionHostSourceModules(sourceModulesDir)) {
    const base = module.slice(0, -".ts".length);
    for (const ext of [".js", ".d.ts"]) {
      assert.ok(
        fs.statSync(path.join(installedRoot, "dist", "src", "session-host", base + ext), { throwIfNoEntry: false })?.isFile(),
        `missing compiled session host module: dist/src/session-host/${base}${ext}`,
      );
    }
  }

  // Fixed mandatory Main shipment: the settled bin cannot run without the
  // compiled Main, so this check is independent of the source inventory and
  // must hold even if src/session-host/main.ts is absent or deleted.
  for (const ext of [".js", ".d.ts"]) {
    assert.ok(
      fs.statSync(path.join(installedRoot, "dist", "src", "session-host", "main" + ext), { throwIfNoEntry: false })?.isFile(),
      `missing compiled session host Main: dist/src/session-host/main${ext}`,
    );
  }

  // Fresh consumer dependency root: the runtime-required alias and pinned
  // xterm packages are present at their pins, and the canonical
  // @earendil-works/pi-tui must NOT be hoisted into this consumer root
  // (which would shadow the native peer) merely because the alias was added.
  // Checked at this consumer's dependency root only; unrelated global
  // installations are out of scope.
  for (const [name, pin] of Object.entries(SESSION_HOST_RUNTIME_PINS)) {
    const metaPath = path.join(consumerNodeModules, name, "package.json");
    assert.ok(fs.statSync(metaPath, { throwIfNoEntry: false })?.isFile(), `missing fresh-consumer runtime dependency: ${name}`);
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    if (pin.name) assert.equal(meta.name, pin.name, `${name} must be the aliased ${pin.name} package`);
    assert.equal(meta.version, pin.version, `${name} must be pinned at ${pin.version}`);
  }
  assert.ok(
    !fs.existsSync(path.join(consumerNodeModules, "@earendil-works", "pi-tui")),
    "canonical @earendil-works/pi-tui must not be hoisted into the fresh consumer dependency root",
  );

  // Runtime probe report: loads from the fresh consumer (never a
  // checkout/host fallback), lazy optional PTY, and one small headless
  // render. The real smoke produces this in a bounded child process; focused
  // tests inject a synthetic MOCK/SYNTHETIC report.
  const report = runRuntimeProbe();
  assert.ok(!report.error, `session host runtime probe failed: ${report.error}`);
  // Realpath both sides so a symlinked scratch/tmp root cannot defeat the
  // fresh-consumer containment check.
  const consumerRoot = fs.realpathSync(consumerNodeModules);
  for (const [name, pin] of Object.entries(SESSION_HOST_RUNTIME_PINS)) {
    const load = report.loads && report.loads[name];
    assert.ok(
      load && typeof load.resolved === "string" && load.loaded === true,
      `runtime probe did not load ${name} from the fresh consumer`,
    );
    assert.ok(
      path.isAbsolute(load.resolved) && fs.realpathSync(load.resolved).startsWith(consumerRoot + path.sep),
      `${name} must resolve inside the fresh consumer, got: ${load.resolved}`,
    );
    if (pin.name) assert.equal(load.name, pin.name, `${name} must load as the aliased ${pin.name} package`);
    assert.equal(load.version, pin.version, `${name} must load at pinned version ${pin.version}`);
  }
  assert.equal(
    report.eagerNodePty,
    false,
    "loading the session host runtime must not eagerly load @lydell/node-pty",
  );
  assert.equal(report.managerExportsInstanceManager, true, "compiled session host manager must export InstanceManager");
  // Mandatory Main import semantics: present, side-effect-free (no eager
  // PTY), and exposing a callable runSessionHost — never invoked here.
  assert.equal(
    report.mainPresent,
    true,
    "runtime probe did not find compiled session host Main: dist/src/session-host/main.js",
  );
  assert.equal(report.mainImported, true, "compiled session host Main must import side-effect-free");
  assert.equal(report.mainExportsRunSessionHost, true, "compiled session host Main must export runSessionHost");
  assert.equal(report.render.ok, true, `headless surface render probe failed: ${JSON.stringify(report.render)}`);
  assert.equal(report.ok, true, "session host runtime probe reported failure");
}

// Fresh-consumer runtime probe (real package smoke only): loads the installed
// package's own modules from the consumer's dependency root in a bounded
// child Node process, guards against eager @lydell/node-pty loading, and runs
// one small headless render with async flush/dispose. It never launches a
// session or PTY, opens no TUI/rawmode/sockets, does profile or crypto work,
// and writes nothing. The real PTY module stays optional and lazy; its native
// binding is intentionally not required here.
const SESSION_HOST_RUNTIME_PROBE = `
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { createRequire } = require("node:module");

const installedRoot = process.argv[1];
const report = { ok: false };

function packageMetaFrom(entry) {
  let dir = path.dirname(entry);
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, "package.json");
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {};
}

(async () => {
  try {
    const req = createRequire(path.join(installedRoot, "package.json"));

    // Rejects forbidden loads before they reach the native loader, so a
    // stray @lydell/node-pty require can never load its native addon here.
    // The attempt is latched BEFORE the throw and re-rejected after work()
    // returns, so an imported module that swallows the guard's exception
    // (try/catch around a require) cannot hide the eager attempt.
    const guardEagerNodePty = (work) => {
      let forbidden = null;
      const originalLoad = Module._load;
      Module._load = function (request) {
        if (typeof request === "string" && request.includes("node-pty")) {
          forbidden = request;
          throw new Error("forbidden eager @lydell/node-pty load: " + request);
        }
        return originalLoad.apply(this, arguments);
      };
      try {
        work();
      } finally {
        Module._load = originalLoad;
      }
      if (forbidden !== null) {
        throw new Error("forbidden eager @lydell/node-pty load: " + forbidden);
      }
    };

    // Actually load each runtime-required dependency from the installed
    // package context (not merely resolve it): a broken entry or broken
    // transitive dependency must fail the probe. No TUI is constructed and
    // no session is launched.
    const loads = {};
    for (const name of ["pi-session-host-tui", "@xterm/headless", "@xterm/addon-unicode11"]) {
      const resolved = req.resolve(name);
      const meta = packageMetaFrom(resolved);
      guardEagerNodePty(() => {
        req(name);
      });
      loads[name] = { resolved, name: meta.name, version: meta.version, loaded: true };
    }
    report.loads = loads;

    let managerExportsInstanceManager = false;
    guardEagerNodePty(() => {
      const manager = req(path.join(installedRoot, "dist", "src", "session-host", "instances.js"));
      managerExportsInstanceManager = typeof manager.InstanceManager === "function";
    });
    report.eagerNodePty = false;
    report.managerExportsInstanceManager = managerExportsInstanceManager;

    // Mandatory compiled Main: import side-effect-free and never invoke
    // runSessionHost. An absent or unsafe Main fails the probe — the settled
    // bin cannot run without it.
    const mainEntry = path.join(installedRoot, "dist", "src", "session-host", "main.js");
    report.mainPresent = fs.existsSync(mainEntry);
    if (report.mainPresent) {
      let mainExportsRunSessionHost = false;
      guardEagerNodePty(() => {
        const main = req(mainEntry);
        mainExportsRunSessionHost = typeof main.runSessionHost === "function";
      });
      report.mainImported = true;
      report.mainExportsRunSessionHost = mainExportsRunSessionHost;
    }

    // Small real headless surface/parser/Unicode11 render with async
    // flush/dispose: CJK and emoji measure width 2 under the Unicode11 addon.
    const { TerminalSurface } = req(path.join(installedRoot, "dist", "src", "session-host", "terminal-surface.js"));
    const surface = new TerminalSurface(20, 2);
    surface.write("中文😀");
    await surface.flush();
    const frame = surface.frame();
    surface.dispose();
    const sgr = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
    const line0 = frame.lines[0].replace(sgr, "");
    report.render = {
      ok: line0.startsWith("中文😀") && frame.cursor.column === 6,
      line0: line0.slice(0, 40),
      cursorColumn: frame.cursor.column,
    };

    report.ok = !report.eagerNodePty
      && report.managerExportsInstanceManager
      && report.mainPresent
      && report.mainImported
      && report.mainExportsRunSessionHost
      && report.render.ok;
  } catch (error) {
    report.error = String((error && error.message) || error).slice(0, 300);
  }
  process.stdout.write(JSON.stringify(report));
})();
`;

function runSessionHostRuntimeProbe(consumer, installed) {
  const output = execFileSync(process.execPath, ["-e", SESSION_HOST_RUNTIME_PROBE, installed], {
    cwd: consumer,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output);
}

/**
 * Bounded side-effect-free --help run of an installed session-host bin.
 * Executes the bin directly so its actual POSIX shebang entry point is what
 * runs (a broken interpreter path fails here, as it would for a user).
 */
function runSessionHostHelp(binPath) {
  const stdout = execFileSync(binPath, ["--help"], {
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: 0, stdout };
}

function runPackageSmoke(scratch) {
  const cache = path.join(scratch, "npm-cache");
  // Stage the packaged inputs in scratch so the smoke never depends on (or
  // touches) the checkout's ignored live dist. CI runs test:fast before
  // test:package, which produces only dist-test; there is no production dist to
  // pack, so we compile fresh output into the staging tree below.
  const stage = path.join(scratch, "package");
  fs.mkdirSync(stage);
  for (const entry of [
    "package.json",
    "README.md",
    // Root governance docs that ship in the npm package (source-only files such as
    // AGENTS.md and .github/ are deliberately not staged or shipped).
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "LICENSE",
    "NOTICE",
    "LICENSES",
    "scripts",
    "skills",
    "examples",
    "docs",
  ]) {
    fs.cpSync(path.join(projectRoot, entry), path.join(stage, entry), { recursive: true, filter: stageFilter });
  }

  // Build production output only into the staging tree. The --outDir override
  // keeps the checkout's dist absent or untouched; source is read from the
  // project (rootDir in tsconfig.json) and written to stage/dist.
  execFileSync(
    process.execPath,
    [
      require.resolve("typescript/bin/tsc"),
      "-p",
      path.join(projectRoot, "tsconfig.json"),
      "--outDir",
      path.join(stage, "dist"),
    ],
    { cwd: projectRoot, stdio: "pipe" },
  );

  // --ignore-scripts disables the prepack lifecycle script so packing cannot
  // clean or rebuild the live dist; the staged production output is already present.
  const packedName = execFileSync(
    "npm",
    ["pack", "--silent", "--ignore-scripts", "--pack-destination", scratch],
    {
      cwd: stage,
      env: { ...process.env, npm_config_cache: cache },
      encoding: "utf8",
    },
  ).trim().split(/\r?\n/).at(-1);
  assert.ok(packedName, "npm pack did not report a tarball");
  const tarball = path.join(scratch, packedName);
  const consumer = path.join(scratch, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(path.join(consumer, "package.json"), '{"private":true}\n');
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: consumer,
    env: { ...process.env, npm_config_cache: cache },
    stdio: "pipe",
  });
  const installed = path.join(consumer, "node_modules", "pi-review-gate");
  for (const required of [
    "dist/src/index.js",
    "scripts/pi-review-gate.sh",
    // Native Windows entry point and its Node helper (issue 108): shipped so
    // the .cmd launcher works from an npm installation without Bash/WSL,
    // including the in-helper DDGS provisioning (ensure-ddgs parity).
    "scripts/pi-review-gate.cmd",
    "scripts/pi-review-gate-launcher.cjs",
    "scripts/ensure-ddgs.sh",
    "scripts/ddgs-search.py",
    "scripts/orchestrator-system-prompt.md",
    "scripts/execution-system-prompt.md",
    "scripts/planning-system-prompt.md",
    "scripts/check-docs.cjs",
    "skills/pi-review-gate-orchestrator/SKILL.md",
    "skills/pi-review-gate-orchestrator/references/recovery.md",
    "skills/pi-review-gate-execution/SKILL.md",
    "skills/pi-review-gate-research/SKILL.md",
    "scripts/fake-reviewer.cjs",
    "LICENSES/Apache-2.0.txt",
    "NOTICE",
    // Root governance docs (required to ship in the npm package so README links
    // resolve in the installed layout).
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CHANGELOG.md",
  ]) {
    assert.ok(fs.statSync(path.join(installed, required)).isFile(), `missing packed file: ${required}`);
  }
  // Derived flat-page coverage (no per-file hardcoded list): every flat docs/*.md page
  // and every standalone examples/*.json configuration in the source tree must exist in
  // the packed install with identical file bytes, so later docs edits, newly added
  // pages, and canonical example configs are validated automatically when the shipped
  // tree moves or grows. Subdirectories (docs/assets) are not byte-diffed here; the
  // docs checker validates the installed markdown layout.
  const assertShippedByteIdentical = (sourceDir, shippedPrefix, ext) => {
    assert.ok(
      fs.statSync(sourceDir, { throwIfNoEntry: false })?.isDirectory(),
      `expected source directory to ship is missing: ${shippedPrefix}/`,
    );
    for (const entry of fs.readdirSync(sourceDir).sort()) {
      if (!entry.endsWith(ext)) continue;
      const sourceFile = path.join(sourceDir, entry);
      if (!fs.statSync(sourceFile).isFile()) continue;
      const shippedFile = path.join(installed, shippedPrefix, entry);
      assert.ok(
        fs.statSync(shippedFile, { throwIfNoEntry: false })?.isFile(),
        `missing packed file: ${shippedPrefix}/${entry}`,
      );
      assert.ok(
        fs.readFileSync(shippedFile).equals(fs.readFileSync(sourceFile)),
        `packed file differs byte-wise from source: ${shippedPrefix}/${entry}`,
      );
    }
  };
  // Flat docs pages (docs/*.md only; subdirectories such as assets ship unchanged).
  assertShippedByteIdentical(path.join(projectRoot, "docs"), "docs", ".md");
  // Standalone example configs (examples/*.json only).
  assertShippedByteIdentical(path.join(projectRoot, "examples"), "examples", ".json");
  // Validate the installed package layout with the same deterministic docs rules
  // (links, anchors, reachability, fenced JSON, referenced paths) used in-repo.
  execFileSync(
    process.execPath,
    [path.join(projectRoot, "scripts", "check-docs.cjs"), installed],
    { stdio: "pipe" },
  );
  // Source-only governance must not leak into the installed package.
  assert.ok(
    !fs.existsSync(path.join(installed, ".github")),
    "source-only .github directory must not ship in the package",
  );
  fs.accessSync(path.join(consumer, "node_modules", ".bin", "pi-review-gate"), fs.constants.X_OK);
  fs.accessSync(path.join(consumer, "node_modules", ".bin", "pi-review-gate-cmd"), fs.constants.X_OK);
  // Optional session host (#323): exact bin metadata, executable consumer
  // shim, side-effect-free --help, derived compiled-module shipment, and
  // fresh-consumer runtime loads with a lazy optional PTY. No normal host
  // launch, DDGS provisioning, or user-home writes happen in this smoke.
  validateSessionHostPackage({
    installedRoot: installed,
    consumerNodeModules: path.join(consumer, "node_modules"),
    sourceModulesDir: path.join(projectRoot, "src", "session-host"),
    runHelp: (binPath) => runSessionHostHelp(binPath),
    runRuntimeProbe: () => runSessionHostRuntimeProbe(consumer, installed),
  });
  process.stdout.write(`package smoke passed: ${packedName}\n`);
}

if (require.main === module) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-package-smoke-"));
  try {
    runPackageSmoke(scratch);
  } finally {
    const retained = removeOwnedScratch(scratch);
    if (retained.length > 0) {
      process.stderr.write(
        `package smoke: retained scratch tree because complete per-entry BigInt creation-ownership receipts are unavailable; descendants were not enumerated or removed: ${retained.join(", ")}\n`,
      );
    }
  }
}

module.exports = {
  validateSessionHostPackage,
  sessionHostSourceModules,
  runSessionHostHelp,
  removeOwnedScratch,
  // Exposed for focused synthetic subprocess regressions of the probe itself;
  // a string constant with no import-time side effects.
  SESSION_HOST_RUNTIME_PROBE,
};
