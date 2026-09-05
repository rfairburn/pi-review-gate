"use strict";

// Bounded staging build for a numbered prerelease.
//
// Everything happens inside a scratch staging tree derived from the exact
// validated source checkout: the live `dist` is never touched and no version
// bump is ever committed. The staged package.json/package-lock.json carry the
// dev version; production TypeScript output is compiled straight into the
// staging tree; the tarball is extracted and verified against an allowlist
// derived from package.json "files" before it may be published.

const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ReleaseError } = require("./common.cjs");

const PROVENANCE_SCHEMA = "pi-review-gate-release-provenance/1";
const SECRET_FILE_NAME_PATTERN = /(^|[/\\.])(\.env|\.env\..*|.*secret.*|.*credential.*|.*\.pem|.*id_rsa.*|.*\.pfx|.*\.p12)$/i;
const SECRET_CONTENT_PATTERN = /-----BEGIN (RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{20,}|gh_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[bap]-[A-Za-z0-9-]{10,}/;

function derivePackageJson(sourcePackageJson, version) {
  const parsed = JSON.parse(sourcePackageJson);
  if (typeof parsed.version !== "string" || parsed.version === "") {
    throw new ReleaseError("source package.json has no version");
  }
  parsed.version = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

// Rewrite only the root identity fields of the validated lockfile so the staged
// lock matches the dev version while dependency resolution stays identical.
function deriveLockfile(sourceLockRaw, name, version) {
  const parsed = JSON.parse(sourceLockRaw);
  if (parsed.name !== name || typeof parsed.packages?.[""] !== "object") {
    throw new ReleaseError("source package-lock.json does not match the expected layout");
  }
  parsed.version = version;
  parsed.packages[""].version = version;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function copyPackageInputs(projectRoot, stage) {
  const sourcePackageJson = fs.readFileSync(path.join(projectRoot, "package.json"), "utf8");
  const parsed = JSON.parse(sourcePackageJson);
  for (const entry of parsed.files ?? []) {
    if (entry === "dist/src") continue; // generated below from the exact source
    const source = path.join(projectRoot, entry);
    if (!fs.existsSync(source)) {
      throw new ReleaseError(`packaged input missing from source checkout: ${entry}`);
    }
    fs.cpSync(source, path.join(stage, entry), { recursive: true });
  }
  return sourcePackageJson;
}

// Compile production TypeScript output into the staging tree only; the
// checkout's dist directory is never created or modified.
function compileProductionOutput(projectRoot, stage) {
  execFileSync(
    process.execPath,
    [require.resolve("typescript/bin/tsc"), "-p", path.join(projectRoot, "tsconfig.json"), "--outDir", path.join(stage, "dist")],
    { cwd: projectRoot, stdio: "pipe" },
  );
}

function stagePackage({ projectRoot, stageRoot, version }) {
  const stage = path.join(stageRoot, "package");
  fs.mkdirSync(stage, { recursive: true });
  const sourcePackageJson = copyPackageInputs(projectRoot, stage);
  fs.writeFileSync(path.join(stage, "package.json"), derivePackageJson(sourcePackageJson, version));
  const lockSource = path.join(projectRoot, "package-lock.json");
  if (!fs.existsSync(lockSource)) {
    throw new ReleaseError("source checkout has no package-lock.json");
  }
  fs.writeFileSync(
    path.join(stage, "package-lock.json"),
    deriveLockfile(fs.readFileSync(lockSource, "utf8"), JSON.parse(sourcePackageJson).name, version),
  );
  compileProductionOutput(projectRoot, stage);
  return stage;
}

// Expand a package.json "files" entry into concrete files, mirroring what npm
// packs for directory entries.
function expandFilesGlob(projectRoot, entry) {
  const source = path.join(projectRoot, entry);
  if (!fs.existsSync(source)) return [];
  const stats = fs.statSync(source);
  if (stats.isFile()) return [entry];
  const out = [];
  const stack = [source];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const child of fs.readdirSync(current, { withFileTypes: true })) {
      const childPath = path.join(current, child.name);
      const rel = path.relative(projectRoot, childPath).split(path.sep).join("/");
      if (child.isDirectory()) stack.push(childPath);
      else if (child.isFile()) out.push(rel);
    }
  }
  return out.sort();
}

// Verify the packed tarball: exact allowlist derived from the staged
// package.json "files" globs, required install entry points, no secret-shaped
// file names, and no private key material in text payloads.
function verifyTarball({ tarballPath, extractDir }) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir, "--strip-components", "1"], { stdio: "pipe" });
  const entries = [];
  const stack = [extractDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const child of fs.readdirSync(current, { withFileTypes: true })) {
      const childPath = path.join(current, child.name);
      if (child.isDirectory()) stack.push(childPath);
      else if (child.isFile()) entries.push(path.relative(extractDir, childPath).split(path.sep).join("/"));
    }
  }
  entries.sort();
  const stage = path.join(path.dirname(extractDir), "package");
  const expected = new Set(["package.json"]);
  const filesGlobs = JSON.parse(fs.readFileSync(path.join(stage, "package.json"), "utf8")).files ?? [];
  for (const glob of filesGlobs) {
    for (const file of expandFilesGlob(stage, glob)) expected.add(file);
  }
  const problems = [];
  for (const entry of entries) {
    if (!expected.has(entry)) problems.push(`unexpected tarball entry: ${entry}`);
    if (SECRET_FILE_NAME_PATTERN.test(entry)) problems.push(`secret-shaped file name rejected: ${entry}`);
  }
  for (const required of [
    "dist/src/index.js",
    "dist/src/index.d.ts",
    "package.json",
    "README.md",
    "LICENSE",
    "scripts/pi-review-gate.sh",
    "skills/orchestrator/SKILL.md",
  ]) {
    if (!entries.includes(required)) problems.push(`required tarball entry missing: ${required}`);
  }
  for (const entry of entries) {
    const fullPath = path.join(extractDir, entry);
    const stats = fs.statSync(fullPath);
    if (stats.size > 512 * 1024) continue;
    const isText = /\.(md|json|cjs|js|mjs|ts|sh|py|txt)$/i.test(entry) || entry === "LICENSE" || entry === "NOTICE";
    if (!isText) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    if (SECRET_CONTENT_PATTERN.test(content)) problems.push(`secret-shaped content rejected in ${entry}`);
  }
  if (problems.length > 0) {
    throw new ReleaseError(`tarball verification failed:\n  - ${problems.join("\n  - ")}`);
  }
  return { entries };
}

// ---------------------------------------------------------------------------
// Install smoke verification of the actual generated artifact
// ---------------------------------------------------------------------------

// Honest scope: this is a targeted strip of the four GitHub publication-token
// variable names (GITHUB_TOKEN, GH_TOKEN, GH_ENTERPRISE_TOKEN, GITHUB_PAT)
// from every install-smoke child environment. The npm and docs-check children
// only need a public registry and the local filesystem, so they never need
// publication credentials. This is not a general sandbox: every other host
// environment variable passes through unchanged.
function installSmokeChildEnv(baseEnv) {
  const childEnv = {};
  for (const [key, value] of Object.entries(baseEnv ?? {})) {
    if (value === undefined) continue;
    if (/^(GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_PAT)$/i.test(key)) continue;
    childEnv[key] = value;
  }
  return childEnv;
}

const INSTALL_SMOKE_TIMEOUT_MS = 180_000;
const DOCS_CHECK_TIMEOUT_MS = 60_000;
const ENTRY_POINT_TIMEOUT_MS = 60_000;
const ENTRY_POINT_MAX_BUFFER = 1024 * 1024;

// Child-side half of the entry-point check: load the installed entry point and
// assert it exposes `activate`. Runs via `node -e <script> <entryPoint> <ack>`
// so the installed code's module init executes in a bounded, token-stripped
// child process — never via require() inside the credentialed publisher
// process. Diagnoses are written to stderr with a fixed prefix so the parent
// can map failures back to the two problem categories (load failure, missing
// activate). Success is not the exit code: only after both checks pass does
// the child write the per-run acknowledgment value it received on argv[2] to
// stdout. An entry point that calls process.exit(0) during module init
// terminates the child before that line, so the parent sees a clean exit with
// no acknowledgment and fails closed; the per-run random value also means an
// entry point cannot hardcode the marker from public sources to fake success.
const ENTRY_POINT_CHILD_SCRIPT = [
  '"use strict";',
  'let loaded;',
  'try {',
  '  loaded = require(process.argv[1]);',
  '} catch (error) {',
  '  process.stderr.write("entry-load-error: " + String((error && error.message) || error));',
  '  process.exit(1);',
  '}',
  'const exposesActivate = (typeof loaded === "function" || typeof loaded === "object") && loaded !== null && typeof loaded.activate === "function";',
  'if (!exposesActivate) {',
  '  process.stderr.write("entry-activate-missing: type " + typeof loaded);',
  '  process.exit(1);',
  '}',
  'process.stdout.write(process.argv[2] + "\\n");',
].join("\n");

// Install the ACTUAL generated tarball into a bounded scratch consumer and
// verify its identity before anything may be published: exact package name and
// version, a compiled entry point that loads in a bounded token-stripped child
// process and exposes `activate`, linked bin scripts, and shipped docs
// validated with the repository's own deterministic docs checker. The tarball
// is consumed as-is; nothing is rebuilt. Any problem throws a ReleaseError so
// publication fails closed before a draft can carry the artifact.
// `entryPointTimeoutMs` is a bounded test-only override for the entry-point
// child's finite timeout; production runs always use ENTRY_POINT_TIMEOUT_MS.
function verifyInstalledTarball({ tarballPath, scratchRoot, projectRoot, packageName, version, entryPointTimeoutMs }) {
  const effectiveEntryPointTimeoutMs = entryPointTimeoutMs ?? ENTRY_POINT_TIMEOUT_MS;
  const expectedTarballName = `${packageName}-${version}.tgz`;
  if (path.basename(tarballPath) !== expectedTarballName) {
    throw new ReleaseError(`install smoke expected ${expectedTarballName} but was asked to verify ${path.basename(tarballPath)}`);
  }
  const consumer = path.join(scratchRoot, "install-smoke");
  fs.rmSync(consumer, { recursive: true, force: true });
  fs.mkdirSync(consumer, { recursive: true });
  try {
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath],
      {
        cwd: consumer,
        env: { ...installSmokeChildEnv(process.env), npm_config_cache: path.join(scratchRoot, "npm-cache") },
        stdio: "pipe",
        timeout: INSTALL_SMOKE_TIMEOUT_MS,
      },
    );
    const problems = [];
    const installed = path.join(consumer, "node_modules", packageName);

    // Exact identity: the installed package must be the expected name/version.
    let installedPackageJson;
    try {
      installedPackageJson = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
    } catch {
      installedPackageJson = null;
    }
    if (!installedPackageJson) {
      problems.push(`installed package.json missing or unreadable under node_modules/${packageName}`);
    } else {
      if (installedPackageJson.name !== packageName) {
        problems.push(`installed package name ${JSON.stringify(installedPackageJson.name)} is not ${JSON.stringify(packageName)}`);
      }
      if (installedPackageJson.version !== version) {
        problems.push(`installed package version ${JSON.stringify(installedPackageJson.version)} is not ${JSON.stringify(version)}`);
      }
    }

    // Compiled entry point: present, loadable, exposes `activate` — verified in
    // a bounded child with the same token-stripped environment as the other
    // install-smoke children. The module init of the installed code must never
    // run inside this publisher process, which may carry publication tokens.
    // The child runs from the scratch consumer directory with a finite timeout
    // and execFileSync's bounded stdout/stderr capture, so a hanging or huge-
    // output load cannot stall or flood the smoke, and any child diagnostics
    // are truncated so error surfaces stay bounded. Success additionally
    // requires the child's per-run acknowledgment on stdout (emitted only
    // after its own activate assertion), so a clean process.exit(0) during
    // module init cannot masquerade as a verified load.
    const entryPoint = path.join(installed, "dist", "src", "index.js");
    if (!fs.statSync(entryPoint, { throwIfNoEntry: false })?.isFile()) {
      problems.push("compiled entry point dist/src/index.js missing from the installed package");
    } else {
      const entryPointAck = `entry-activate-ok:${crypto.randomBytes(8).toString("hex")}`;
      let childExitedCleanly = false;
      let childStdout = "";
      try {
        childStdout = String(execFileSync(process.execPath, ["-e", ENTRY_POINT_CHILD_SCRIPT, entryPoint, entryPointAck], {
          cwd: consumer,
          env: installSmokeChildEnv(process.env),
          stdio: "pipe",
          timeout: effectiveEntryPointTimeoutMs,
          maxBuffer: ENTRY_POINT_MAX_BUFFER,
        }));
        childExitedCleanly = true;
      } catch (error) {
        const childStderr = String(error.stderr ?? "").trim();
        const detail = (childStderr || String(error.message ?? error)).slice(0, 800);
        if (childStderr.startsWith("entry-activate-missing:")) {
          problems.push(`installed entry point does not expose activate() (${childStderr.slice("entry-activate-missing:".length).trim()})`);
        } else {
          problems.push(`installed entry point failed to load: ${detail.replace(/^entry-load-error:\s*/, "")}`);
        }
      }
      if (childExitedCleanly && !childStdout.includes(entryPointAck)) {
        problems.push("installed entry point exited without confirming activate(): the child emitted no success acknowledgment, so an early process.exit during load is not a pass");
      }
    }

    // Bin scripts shipped and linked.
    for (const bin of ["scripts/pi-review-gate.sh", "scripts/pi-review-web.sh"]) {
      if (!fs.statSync(path.join(installed, bin), { throwIfNoEntry: false })?.isFile()) {
        problems.push(`bin script missing from the installed package: ${bin}`);
      }
    }
    if (!fs.statSync(path.join(consumer, "node_modules", ".bin", "pi-review-gate"), { throwIfNoEntry: false })?.isFile()) {
      problems.push("npm did not link the pi-review-gate bin into node_modules/.bin");
    }

    // Shipped docs validated with the checkout's own deterministic checker
    // (same rules as the package smoke: links, anchors, reachability, JSON).
    // Same token-stripped environment as the npm child: the checker never needs
    // credentials, so the event's GITHUB_TOKEN must not leak into it either.
    const checkDocs = path.join(projectRoot, "scripts", "check-docs.cjs");
    if (!fs.existsSync(checkDocs)) {
      problems.push("docs checker missing from the source checkout: scripts/check-docs.cjs");
    } else {
      try {
        execFileSync(process.execPath, [checkDocs, installed], {
          env: installSmokeChildEnv(process.env),
          stdio: "pipe",
          timeout: DOCS_CHECK_TIMEOUT_MS,
        });
      } catch (error) {
        const detail = String(error.stderr ?? error.message ?? error).trim().slice(0, 800);
        problems.push(`installed docs failed validation: ${detail}`);
      }
    }

    if (problems.length > 0) {
      throw new ReleaseError(`install smoke verification failed:\n  - ${problems.join("\n  - ")}`);
    }
    return { installed, packageName, version };
  } finally {
    fs.rmSync(consumer, { recursive: true, force: true });
  }
}

function packStage({ stage, packDestination }) {
  const reported = execFileSync(
    "npm",
    ["pack", "--silent", "--ignore-scripts", "--pack-destination", packDestination],
    { cwd: stage, stdio: "pipe", encoding: "utf8" },
  ).trim().split(/\r?\n/).at(-1);
  if (!reported) throw new ReleaseError("npm pack did not report a tarball");
  return path.join(packDestination, reported);
}

function buildSha256Sums(lines) {
  return `${lines.map(({ sha256, filename }) => `${sha256}  ${filename}`).join("\n")}\n`;
}

function parseSha256Sums(text) {
  const map = new Map();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    if (!match) throw new ReleaseError(`malformed SHA256SUMS line: ${JSON.stringify(line)}`);
    map.set(match[2], match[1]);
  }
  return map;
}

// Deterministic provenance: stable SHAs only, no run timestamps, so reruns and
// retries produce byte-identical documents except for the per-build tarball
// digest, which is bound into SHA256SUMS.
function buildProvenance({ repository, target, baseline, n, tag, version, prNumber, prMergeCommitSha, tarballFilename, tarballSha256, tarballSize }) {
  return {
    schema: PROVENANCE_SCHEMA,
    package: { name: "pi-review-gate", version },
    release: { tag, prerelease: true },
    source: {
      repository,
      sha: target,
      baseline,
      firstParentDistance: n,
      pullRequest: { number: prNumber, mergeCommitSha: prMergeCommitSha },
    },
    artifacts: {
      [tarballFilename]: { sha256: tarballSha256, size: tarballSize },
    },
  };
}

module.exports = {
  PROVENANCE_SCHEMA,
  buildProvenance,
  buildSha256Sums,
  deriveLockfile,
  derivePackageJson,
  expandFilesGlob,
  installSmokeChildEnv,
  packStage,
  parseSha256Sums,
  stagePackage,
  verifyInstalledTarball,
  verifyTarball,
};
