"use strict";

// Also loaded by the compiled TS suite. No SDK, real key generation, API calls, or
// Gradle: the signing boundary uses an in-memory filesystem, and the CLI annotation
// cases use only a fresh private temporary directory outside the repository with mock
// shell tools that are never a real Android SDK.
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const android = require("../scripts/release/android.cjs");
const common = require("../scripts/release/common.cjs");
const { sha256Buffer } = common;
const eligibilityModule = require("../scripts/release/eligibility.cjs");
const publisher = require("../scripts/release/publish.cjs");
const packaging = require("../scripts/release/packaging.cjs");
const target = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const eligibility = { n: 257, tag: "b257", target };
const cert = "a".repeat(64);
const env = {
  GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REF_TYPE: "branch",
  GITHUB_REPOSITORY: "rfairburn/pi-review-gate", GITHUB_SHA: target,
  GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: "2", ANDROID_HOME: "/mock-sdk",
  ANDROID_SIGNING_CERT_SHA256: cert, RUNNER_TEMP: path.join(process.cwd(), "memory-only"),
};
function badge(overrides = {}) {
  const values = { package: "io.github.rfairburn.pireviewgate", code: 257, name: "0.1.0+257", min: 33, target: 37, ...overrides };
  return `package: name='${values.package}' versionCode='${values.code}' versionName='${values.name}'\nminSdkVersion:'${values.min}'\ntargetSdkVersion:'${values.target}'\n${values.debug ? "application-debuggable" : ""}`;
}
function signature(digest = cert, v2 = true, v3 = true) {
  return `Verified using v2 scheme (APK Signature Scheme v2): ${v2}\nVerified using v3 scheme (APK Signature Scheme v3): ${v3}\nSigner #1 certificate SHA-256 digest: ${digest}\n`;
}
function metadata() {
  const unsigned = Buffer.from("unsigned APK fixture; not a real APK/key");
  return { source: android.identity(eligibility), run: android.runIdentity(env), unsigned: { sha256: sha256Buffer(unsigned), size: unsigned.length }, toolchain: android.TOOLCHAIN };
}
function memorySigner(t, options = {}) {
  const files = new Map();
  let directoryId = 0;
  const removed = [];
  const calls = [];
  const input = path.join(env.RUNNER_TEMP, "input");
  const directory = path.join(env.RUNNER_TEMP, "public");
  const meta = metadata();
  files.set(path.join(input, "unsigned.apk"), Buffer.from("unsigned APK fixture; not a real APK/key"));
  files.set(path.join(input, "unsigned.json"), Buffer.from(JSON.stringify(meta)));
  t.mock.method(fs, "readFileSync", (file, encoding) => {
    assert.ok(files.has(file), `unexpected in-memory read ${file}`);
    return encoding ? files.get(file).toString(encoding) : files.get(file);
  });
  t.mock.method(fs, "writeFileSync", (file, bytes) => { files.set(file, Buffer.from(bytes)); });
  t.mock.method(fs, "copyFileSync", (from, to) => { assert.ok(files.has(from)); files.set(to, files.get(from)); });
  t.mock.method(fs, "mkdirSync", () => undefined);
  t.mock.method(fs, "mkdtempSync", (prefix) => `${prefix}${++directoryId}`);
  t.mock.method(fs, "chmodSync", (file, mode) => { assert.equal(mode, 0o700); });
  t.mock.method(fs, "rmSync", (directory) => {
    removed.push(directory);
    for (const file of files.keys()) if (file.startsWith(`${directory}${path.sep}`)) files.delete(file);
  });
  function run(file, args, settings) {
    calls.push({ file, args, env: settings.env });
    if (file.endsWith("aapt2")) return { status: 0, stdout: badge(options.badge) };
    if (args[0] === "verify") {
      const v2Only = args.includes("--min-sdk-version");
      return { status: args.at(-1).endsWith("unsigned.apk") ? 1 : 0, stdout: signature(options.cert, v2Only, !v2Only) };
    }
    if (args[0] === "sign") {
      if (options.toolFailure) throw new Error("mock tool failure");
      files.set(args[args.indexOf("--out") + 1], Buffer.from("signed APK fixture"));
    } else if (!args.includes("-c")) files.set(args.at(-1), Buffer.from("aligned APK fixture"));
    return { status: 0, stdout: "" };
  }
  const signingEnv = { ...env, EXPECTED_UNSIGNED_SHA256: meta.unsigned.sha256, EXPECTED_METADATA_SHA256: sha256Buffer(files.get(path.join(input, "unsigned.json"))),
    ANDROID_SIGNING_KEYSTORE_BASE64: Buffer.from("opaque mock PKCS12 bytes; no real key").toString("base64"),
    ANDROID_SIGNING_PASSWORD: "mock-password", ANDROID_SIGNING_ALIAS: "mock-alias" };
  return { files, input, directory, calls, removed, signingEnv, run };
}

test("Android authoritative N and fixed identity retain debug-independent release bounds", () => {
  assert.deepEqual(android.version(1), { applicationId: "io.github.rfairburn.pireviewgate", versionCode: 1, versionName: "0.1.0+1", minSdk: 33, targetSdk: 37 });
  assert.equal(android.version(2100000000).versionName, "0.1.0+2100000000");
  for (const bad of [0, -1, 1.5, 2100000001, NaN, undefined, "257"]) assert.throws(() => android.version(bad));
  assert.equal(android.filename(257), "pi-review-gate-b257.apk");
  assert.equal(android.certificate("AA:".repeat(31) + "AA"), cert);
  for (const bad of [undefined, "", "a".repeat(63), "z".repeat(64)]) assert.throws(() => android.certificate(bad));
  assert.throws(() => android.identity({ ...eligibility, tag: "b258" }), /source\/tag/);
});

test("Gradle release properties fail closed on CI without changing ordinary debug identity", () => {
  const gradle = fs.readFileSync(path.join(process.cwd(), "android/app/build.gradle.kts"), "utf8");
  assert.match(gradle, /providers.gradleProperty\("releaseNumber"\).orNull/);
  assert.match(gradle, /number in 1\.\.2100000000L/);
  assert.match(gradle, /System.getenv\("CI"\) == "true"/);
  assert.match(gradle, /require\(releaseNumber != null\)/);
  assert.match(gradle, /versionCode = releaseNumber \?: 1/);
  assert.match(gradle, /versionName = releaseNumber\?\.let \{ "0\.1\.0\+\$it" \} \?: "0\.1\.0"/);
  assert.doesNotMatch(gradle, /applicationIdSuffix|signingConfig|keystore/);
  assert.equal(android.TOOLCHAIN.jdk, "21.0.9+10");
  assert.equal(android.TOOLCHAIN.buildTools, "37.0.0");
});

// actions/setup-java compares a requested version carrying build metadata with
// semver.compareBuild, so the canonical `21.0.9+10` label is never satisfied by the
// vendor's `21.0.9+10.0.LTS` release. The workflow must therefore name the full
// vendor selector while provenance keeps recording the canonical label.
test("every release-job JDK selection names the full Temurin vendor selector for the pinned build", () => {
  const workflow = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "release.yml"), "utf8");
  const selectors = [...workflow.matchAll(/^\s*java-version: (\S+)$/gm)].map((match) => match[1].replace(/'/g, ""));
  assert.ok(selectors.length > 0, "the release workflow must provision the pinned JDK");
  for (const selector of selectors) {
    assert.equal(selector, "21.0.9+10.0.LTS", "no floating major, latest, or short-label JDK selection is allowed");
    assert.equal(selector.replace(/\.0\.LTS$/, ""), android.TOOLCHAIN.jdk,
      "the vendor selector and the canonical toolchain label must name the same JDK 21.0.9 build 10");
  }
});

const SDK_ARCHIVE_URL = "https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip";
const SDK_ARCHIVE_SHA256 = "4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583";

// Pure mock seam: no SDK download, install, or vendor call. It proves only which
// package identifiers the provisioning helper requests and that the pinned archive
// checksum gate still runs before any sdkmanager invocation.
test("SDK provisioning requests the exact 37.0 platform package only when platform is requested", async (t) => {
  const archive = Buffer.from("mock command-line tools archive bytes; never downloaded");
  const realSha256 = sha256Buffer;
  t.mock.method(common, "sha256Buffer", (buffer) => (Buffer.compare(buffer, archive) === 0 ? SDK_ARCHIVE_SHA256 : realSha256(buffer)));
  // android.cjs destructures sha256Buffer at require time, so reload it over the mocked module.
  const androidPath = require.resolve("../scripts/release/android.cjs");
  const previous = require.cache[androidPath];
  delete require.cache[androidPath];
  t.after(() => { require.cache[androidPath] = previous; });
  const provision = require(androidPath);
  t.mock.method(fs, "writeFileSync", () => undefined);
  t.mock.method(fs, "mkdirSync", () => undefined);
  t.mock.method(fs, "renameSync", () => undefined);
  const envFile = [];
  t.mock.method(fs, "appendFileSync", (file, text) => { envFile.push({ file, text }); });
  const provisioningEnv = { ...env, GITHUB_ENV: path.join(env.RUNNER_TEMP, "mock-github-env") };
  const arrayBuffer = () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength);
  for (const platform of [true, false]) {
    const calls = [];
    const urls = [];
    const run = (file, args, settings) => { calls.push({ file, args, env: settings.env, input: settings.input }); return { status: 0, stdout: "" }; };
    await provision.installSdk({ platform, env: provisioningEnv, fetchImpl: async (url) => { urls.push(url); return { ok: true, arrayBuffer }; }, run });
    assert.deepEqual(urls, [SDK_ARCHIVE_URL], "the checksum-pinned official command-line tools archive stays pinned");
    const sdkmanager = calls.filter((call) => call.file.endsWith("sdkmanager"));
    assert.deepEqual(sdkmanager.map((call) => call.args), [["--licenses"], ["build-tools;37.0.0", ...(platform ? ["platforms;android-37.0"] : [])]],
      "only the pinned build tools and, when asked, the exact published API 37.0 platform package are requested");
    assert.equal(sdkmanager[0].input, "y\n".repeat(100));
    assert.equal(calls[0].file, "unzip");
    for (const call of sdkmanager.slice(1)) {
      assert.equal(call.env.ANDROID_HOME, path.join(env.RUNNER_TEMP, "android-sdk"));
      assert.ok(call.env.ANDROID_SDK_ROOT && call.env.ANDROID_USER_HOME, "provisioning keeps the isolated SDK roots");
    }
    assert.match(envFile.at(-1).text, /ANDROID_HOME=/);
    assert.match(envFile.at(-1).text, /ANDROID_SDK_ROOT=/);
    assert.match(envFile.at(-1).text, /ANDROID_USER_HOME=/);
  }
  // The numeric API level, build tools version, and every gate stay pinned.
  assert.equal(android.TOOLCHAIN.compileSdk, 37);
  assert.equal(android.TOOLCHAIN.buildTools, "37.0.0");
  assert.equal(android.version(257).targetSdk, 37);
  assert.equal(android.version(257).minSdk, 33);
  const never = () => { throw new Error("no tool may run after a failed provisioning gate"); };
  await assert.rejects(android.installSdk({ platform: true, env: provisioningEnv, fetchImpl: async () => ({ ok: false, arrayBuffer }), run: never }), /download failed/);
  await assert.rejects(android.installSdk({ platform: true, env: provisioningEnv, fetchImpl: async () => ({ ok: true, arrayBuffer }), run: never }), /checksum mismatch/);
  for (const missing of ["RUNNER_TEMP", "GITHUB_ENV"]) {
    await assert.rejects(android.installSdk({ platform: true, env: { ...provisioningEnv, [missing]: "" }, fetchImpl: async () => { throw new Error("must not fetch"); }, run: never }), /provisioning context missing/);
  }
});

test("APK verification refuses wrong package/version/SDK, debug, unsigned and wrong certificate", () => {
  const run = (changes = {}, sig = signature()) => (file) => ({ status: 0, stdout: file.endsWith("aapt2") ? badge(changes) : sig });
  android.inspectApk("fixture.apk", eligibility, { env, cert, run: run() });
  for (const change of [{ package: "other" }, { code: 1 }, { name: "0.1.0" }, { min: 32 }, { target: 36 }, { debug: true }]) {
    assert.throws(() => android.inspectApk("fixture.apk", eligibility, { env, cert, run: run(change) }));
  }
  for (const sig of ["", signature("b".repeat(64)), signature().replace("v3): true", "v3): false"), signature() + `Signer #2 certificate SHA-256 digest: ${cert}\n`]) {
    assert.throws(() => android.inspectApk("fixture.apk", eligibility, { env, cert, run: run({}, sig) }));
  }
  assert.throws(() => android.inspectApk("fixture.apk", eligibility, { env, signed: false, run: run() }), /must be unsigned/);
});

test("aapt2 badging SDK fields retain exact bounds for unsigned and signed APKs", () => {
  // Pinned aapt2 emits minSdkVersion; sdkVersion is the legacy aapt label.
  // Both are successful tool output, so mocked success must use the real format.
  for (const signed of [false, true]) {
    const inspect = (badging) => android.inspectApk("fixture.apk", eligibility, {
      env, cert, signed,
      run: (file, args) => {
        if (file.endsWith("aapt2")) {
          assert.deepEqual(args, ["dump", "badging", "fixture.apk"]);
          return { status: 0, stdout: badging };
        }
        return { status: signed ? 0 : 1, stdout: signature() };
      },
    });
    assert.doesNotThrow(() => inspect(badge()));
    for (const badging of [
      badge({ min: 32 }), badge({ target: 36 }),
      badge().replace("minSdkVersion:'33'", ""),
      badge().replace("minSdkVersion:'33'", "sdkVersion:'33'"),
    ]) assert.throws(() => inspect(badging), /APK SDK mismatch/);
  }
});

test("minSdk 33 APK verifies v3 normally and v2 independently over SDK 24–27", () => {
  const calls = [];
  const run = (file, args) => {
    calls.push(args);
    if (file.endsWith("aapt2")) return { status: 0, stdout: badge() };
    if (args[0] === "verify") return { status: 0, stdout: args.includes("--min-sdk-version") ? signature(cert, true, false) : signature(cert, false, true) };
    return { status: 0, stdout: "" };
  };
  android.inspectApk("fixture.apk", eligibility, { env, cert, run });
  assert.deepEqual(calls.filter((args) => args[0] === "verify"), [
    ["verify", "--verbose", "--print-certs", "fixture.apk"],
    ["verify", "--verbose", "--print-certs", "--min-sdk-version", "24", "--max-sdk-version", "27", "fixture.apk"],
  ]);
  // The manifest still must declare minimum SDK 33 (checked by aapt2).
  assert.equal(android.version(257).minSdk, 33);
  for (const failed of ["normal", "v2"]) {
    for (const failure of ["status", "scheme", "certificate"]) {
      const failingRun = (file, args) => {
        const result = run(file, args);
        if (args[0] !== "verify" || args.includes("--min-sdk-version") !== (failed === "v2")) return result;
        if (failure === "status") return { ...result, status: 1 };
        if (failure === "scheme") return { status: 0, stdout: signature(cert, false, false) };
        return { status: 0, stdout: signature("b".repeat(64)) };
      };
      assert.throws(() => android.inspectApk("fixture.apk", eligibility, { env, cert, run: failingRun }), /signature|certificate/);
    }
  }
});

for (const lookupStatus of [403, 500, 404]) {
  test(`inspect discovery never rebuilds a published release after tag lookup ${lookupStatus}`, async (t) => {
    const root = process.cwd();
    const n = Number(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8").match(/^## \[0\.1\.0-dev\.(\d+)\]/m)[1]);
    const eligible = { n, target, tag: `b${n}`, version: `0.1.0-dev.${n}`, baseline: "b".repeat(40), prNumber: 7, prMergeCommitSha: target };
    t.mock.method(common, "git", () => target);
    t.mock.method(eligibilityModule, "resolveEligibility", async () => eligible);
    // Capture these two mocked read-only boundaries in a fresh publisher module.
    const modulePath = require.resolve("../scripts/release/publish.cjs");
    const previous = require.cache[modulePath];
    delete require.cache[modulePath];
    t.after(() => { require.cache[modulePath] = previous; });
    const inspectPublisher = require(modulePath);
    const requests = [];
    let builds = 0;
    const fetchImpl = async (url, init) => {
      requests.push({ url, method: init.method });
      assert.equal(init.method, "GET", "inspect must never write");
      const apiPath = new URL(url).pathname;
      if (apiPath.endsWith(`/releases/tags/${eligible.tag}`)) return new Response(JSON.stringify({ message: "mock lookup result" }), { status: lookupStatus });
      if (apiPath.endsWith("/releases")) return new Response(JSON.stringify([{ id: 42, tag_name: eligible.tag, draft: false }]), { status: 200 });
      if (apiPath.includes("/git/ref/")) return new Response(JSON.stringify({ object: { type: "commit", sha: target } }), { status: 200 });
      throw new Error(`unexpected inspect request ${apiPath}`);
    };
    const plan = inspectPublisher.publishRelease({ env: { ...env, GITHUB_TOKEN: "mock-token" }, fetchImpl, projectRoot: root, inspectOnly: true, buildArtifacts: async () => { builds++; throw new Error("must not build"); } });
    if (lookupStatus === 404) {
      assert.equal((await plan).outcome, "verify-published", "published listing fallback must never select build-draft");
      assert.ok(requests.some((request) => new URL(request.url).pathname.endsWith("/releases")));
    } else {
      await assert.rejects(plan, new RegExp(`get release by tag failed: status ${lookupStatus}`));
      assert.equal(requests.length, 1, "non-404 failures must stop discovery, not fall through to absence");
    }
    assert.equal(builds, 0);
    assert.ok(requests.every((request) => request.method === "GET"));
  });
}

test("unsigned metadata binds source, same run attempt, digest shape and exact toolchain", () => {
  android.validateMetadata(metadata(), eligibility, env);
  for (const change of [
    { source: { ...metadata().source, sha: "b".repeat(40) } },
    { source: { ...metadata().source, versionCode: 1 } },
    { run: { ...metadata().run, repository: "other/repo" } },
    { run: { ...metadata().run, id: "999" } },
    { run: { ...metadata().run, attempt: "1" } },
    { unsigned: { sha256: "wrong", size: 1 } },
    { toolchain: { ...android.TOOLCHAIN, jdk: "17" } },
  ]) assert.throws(() => android.validateMetadata({ ...metadata(), ...change }, eligibility, env));
  for (const change of [{ GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_REF: "refs/heads/other" }, { GITHUB_REPOSITORY: "fork/repo" }]) assert.throws(() => android.runIdentity({ ...env, ...change }));
});

test("immutable artifact lookup pins repository, ID, run, source and digest without writes", async () => {
  const context = { ...env, GITHUB_TOKEN: "mock-token", ARTIFACT_ID: "91", ARTIFACT_DIGEST: "b".repeat(64) };
  const artifact = { id: 91, expired: false, digest: `sha256:${context.ARTIFACT_DIGEST}`, workflow_run: { id: 1234, head_sha: target } };
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(url, "https://api.github.com/repos/rfairburn/pi-review-gate/actions/artifacts/91");
    assert.equal(init.method, undefined);
    return { ok: true, json: async () => artifact };
  };
  await android.checkArtifact({ env: context, fetchImpl });
  for (const change of [{ id: 92 }, { expired: true }, { digest: "bad" }, { workflow_run: { id: 1235, head_sha: target } }, { workflow_run: { id: 1234, head_sha: "b".repeat(40) } }]) {
    await assert.rejects(android.checkArtifact({ env: context, fetchImpl: async () => ({ ok: true, json: async () => ({ ...artifact, ...change }) }) }));
  }
  assert.equal(calls, 1);
});

test("mock signer aligns before v2/v3 signing, disables v4, uses password environment, cleans key, and emits only public assets", (t) => {
  const m = memorySigner(t);
  android.signUnsigned({ input: m.input, directory: m.directory, eligibility, env: m.signingEnv, run: m.run });
  const sign = m.calls.find((call) => call.args[0] === "sign");
  assert.ok(sign);
  assert.ok(m.calls.findIndex((call) => call.args.includes("-f")) < m.calls.indexOf(sign));
  assert.ok(sign.args.includes("env:ANDROID_SIGNING_PASSWORD"));
  assert.ok(!sign.args.includes(m.signingEnv.ANDROID_SIGNING_PASSWORD));
  assert.equal(sign.args[sign.args.indexOf("--v4-signing-enabled") + 1], "false");
  assert.equal(sign.env.ANDROID_SIGNING_KEYSTORE_BASE64, undefined);
  for (const call of m.calls.filter((call) => call !== sign)) {
    assert.equal(call.env.ANDROID_SIGNING_PASSWORD, undefined);
    assert.equal(call.env.ANDROID_SIGNING_ALIAS, undefined);
  }
  assert.ok(m.removed.some((directory) => directory.includes("android-sign-")));
  assert.ok(![...m.files.keys()].some((file) => file.endsWith(".p12")));
  assert.deepEqual([...m.files.keys()].filter((file) => file.startsWith(m.directory)).map((file) => path.basename(file)).sort(), android.names(257).sort());
  const provenance = JSON.parse(m.files.get(path.join(m.directory, "android-provenance.json")));
  assert.equal(provenance.certificateSha256, cert);
  assert.ok(!JSON.stringify(provenance).includes("mock-alias"));
  const buffers = Object.fromEntries(android.names(257).map((name) => [name, m.files.get(path.join(m.directory, name))]));
  android.verifyAssets({ buffers, eligibility, scratch: env.RUNNER_TEMP, env, run: m.run });
  assert.throws(() => android.verifyAssets({ buffers: { ...buffers, "pi-review-gate-b257.apk": Buffer.from("tampered") }, eligibility, scratch: env.RUNNER_TEMP, env, run: m.run }), /digest\/size/);
});

test("publisher verifies six actual downloads including signature; Node-only is accepted only in explicit legacy verify mode", async (t) => {
  const m = memorySigner(t);
  android.signUnsigned({ input: m.input, directory: m.directory, eligibility, env: m.signingEnv, run: m.run });
  const eligible = { ...eligibility, baseline: "b".repeat(40), version: "0.1.0-dev.257", prNumber: 7, prMergeCommitSha: target };
  const tarball = Buffer.from("original Node artifact bytes");
  const tarballFilename = "pi-review-gate-0.1.0-dev.257.tgz";
  const provenance = packaging.buildProvenance({ repository: env.GITHUB_REPOSITORY, target, baseline: eligible.baseline, n: 257, tag: eligible.tag, version: eligible.version, prNumber: 7, prMergeCommitSha: target, tarballFilename, tarballSha256: sha256Buffer(tarball), tarballSize: tarball.length });
  const buffers = { [tarballFilename]: tarball, SHA256SUMS: Buffer.from(`${sha256Buffer(tarball)}  ${tarballFilename}\n`), "provenance.json": Buffer.from(JSON.stringify(provenance)) };
  for (const name of android.names(257)) buffers[name] = m.files.get(path.join(m.directory, name));
  const assets = Object.entries(buffers).map(([name, buffer], index) => ({ name, id: index + 1, size: buffer.length }));
  const notes = "<details>\n<summary>Changes in b257</summary>\nTest notes.\n</details>";
  const release = { draft: false, prerelease: true, tag_name: eligible.tag, body: publisher.releaseBody(eligible, provenance, notes), assets };
  const downloaded = [];
  const api = { downloadAsset: async (id) => { const asset = assets.find((asset) => asset.id === id); downloaded.push(asset.name); return { buffer: buffers[asset.name], status: 200 }; } };
  const options = { api, release, eligibility: eligible, tarballFilename, expectedNotesBlock: notes, env, scratch: env.RUNNER_TEMP, androidRun: m.run };
  await publisher.verifyPublishedRelease(options);
  assert.deepEqual(downloaded.sort(), publisher.expectedAssetNames(tarballFilename, 257).sort());
  assert.deepEqual(publisher.parseProvenanceFromBody(release.body), provenance, "authoritative body fence remains original Node provenance only");
  const nodeOnly = { ...release, assets: assets.filter((asset) => !android.names(257).includes(asset.name)) };
  await assert.rejects(publisher.verifyPublishedRelease({ ...options, release: nodeOnly }), /published asset missing/);
  await publisher.verifyPublishedRelease({ ...options, release: nodeOnly, legacyVerifyOnly: true });
  await assert.rejects(publisher.verifyPublishedRelease({ ...options, androidRun: () => { throw new Error("signature tool failed"); } }), /signature tool failed/);
  await assert.rejects(publisher.verifyPublishedRelease({ ...options, release: { ...release, assets: [...assets, assets[0]] } }), /duplicate asset/);
  await assert.rejects(publisher.verifyPublishedRelease({ ...options, release: { ...release, body: publisher.releaseBody(eligible, { ...provenance, different: true }, notes) } }), /differs from the published provenance/);
  // The same contract is enforced while still a draft, not only after publication.
  await publisher.verifyPublishedRelease({ ...options, release: { ...release, draft: true }, draft: true });
});

for (const secret of ["ANDROID_SIGNING_KEYSTORE_BASE64", "ANDROID_SIGNING_PASSWORD", "ANDROID_SIGNING_ALIAS"]) {
  test(`missing ${secret} blocks signing`, (t) => {
    const m = memorySigner(t);
    assert.throws(() => android.signUnsigned({ input: m.input, directory: m.directory, eligibility, env: { ...m.signingEnv, [secret]: "" }, run: m.run }), /signing secrets/);
    assert.equal(m.calls.length, 0);
  });
}
for (const options of [{ toolFailure: true }, { cert: "b".repeat(64) }]) {
  test(`signing failure cleans key without public output: ${JSON.stringify(options)}`, (t) => {
    const m = memorySigner(t, options);
    assert.throws(() => android.signUnsigned({ input: m.input, directory: m.directory, eligibility, env: m.signingEnv, run: m.run }));
    assert.ok(m.removed.some((directory) => directory.includes("android-sign-")));
    assert.ok(![...m.files.keys()].some((file) => file.endsWith(".p12") || file.startsWith(m.directory)));
  });
}
for (const change of [{ ANDROID_SIGNING_KEYSTORE_BASE64: "not-base64!" }, { ANDROID_SIGNING_CERT_SHA256: "bad" }, { EXPECTED_UNSIGNED_SHA256: "b".repeat(64) }, { EXPECTED_METADATA_SHA256: "b".repeat(64) }]) {
  test(`invalid configuration/input blocks signing: ${Object.keys(change)[0]}`, (t) => {
    const m = memorySigner(t);
    assert.throws(() => android.signUnsigned({ input: m.input, directory: m.directory, eligibility, env: { ...m.signingEnv, ...change }, run: m.run }));
    assert.ok(!m.calls.some((call) => call.args[0] === "sign"));
  });
}

// ---------------------------------------------------------------------------
// Closed-list public signer failure annotations. These cases prove only that a CLI sign
// failure publishes one static code from a fixed allowlist. They never sign, never read
// a private key, and never claim that every tool or credential cause is diagnosable.
// ---------------------------------------------------------------------------

const ANNOTATION_PREFIX = "::error::pi-review-gate Android signing failed: ";
const HOSTILE_ACCESSOR_MESSAGE = "HOSTILE accessor message mock-password /private/release.p12";
const ANNOTATION_LINE = /^::error::pi-review-gate Android signing failed: [A-Z][A-Z0-9_]*$/;
const CLI_SCRIPT = path.join(process.cwd(), "scripts", "release", "android.cjs");
const CLI_GENERIC_ERROR = "Android release failed closed; check public configuration, input identity, and signing tool prerequisites.";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Hostile values planted in the environment: if any of them ever reached the CLI's
// public output, an annotation could be forged or a value disclosed.
const HOSTILE = {
  ANDROID_SIGNING_PASSWORD: "mock\r\npassword%40::error::forged",
  ANDROID_SIGNING_ALIAS: "mock-alias\r\n::error::forged-alias%0A",
  ANDROID_SIGNING_KEYSTORE_BASE64: Buffer.from("mock PKCS12 bytes; no real key").toString("base64"),
};
const HOSTILE_VALUES = [HOSTILE.ANDROID_SIGNING_PASSWORD, HOSTILE.ANDROID_SIGNING_ALIAS, HOSTILE.ANDROID_SIGNING_KEYSTORE_BASE64, "forged", "warning"];

test("signer annotation codes are a closed static allowlist with a safe unknown fallback", () => {
  const codes = android.SIGN_FAILURE_CODES;
  assert.ok(Object.isFrozen(codes), "the allowlist must not be mutable at runtime");
  assert.equal(new Set(codes).size, codes.length, "annotation codes must be unique");
  assert.ok(codes.includes("SIGN_UNEXPECTED"), "a static generic code must exist");
  for (const code of codes) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/, "codes stay printable and free of workflow-command syntax");
    assert.ok(!code.includes(":") && !/[%\r\n]/.test(code));
  }
  assert.equal(android.signFailureCode(new Error("boom")), "SIGN_UNEXPECTED");
  assert.equal(android.signFailureCode(undefined), "SIGN_UNEXPECTED");
  assert.equal(android.signFailureCode(null), "SIGN_UNEXPECTED");
  assert.equal(android.signFailureCode("TOOL_ZIPALIGN"), "SIGN_UNEXPECTED", "a bare string is never treated as a code");
  for (const code of codes) {
    assert.equal(android.signFailureCode(Object.freeze(Object.assign(new Error("x"), { signFailureCode: code }))), code);
  }
  // Only exact allowlist members resolve; anything else, including annotation syntax,
  // near-misses, and non-strings, falls back to the static generic code.
  for (const injected of ["::error::injected", "SIGN_UNEXPECTED\r\n::warning::x", "tool_zipalign", "SIGN_UNEXPECTED ", "", 42, true, {}, [], null, undefined]) {
    const hostile = Object.assign(new Error("hostile message with % and \r\n and mock-password"), { signFailureCode: injected });
    assert.equal(android.signFailureCode(hostile), "SIGN_UNEXPECTED");
  }
});

function rewriteMetadata(m, change) {
  const bytes = Buffer.from(JSON.stringify({ ...metadata(), ...change }));
  m.files.set(path.join(m.input, "unsigned.json"), bytes);
  m.signingEnv.EXPECTED_METADATA_SHA256 = sha256Buffer(bytes);
}
const passThroughVerify = (m, selector, stdout) => (file, args, settings) => {
  const result = m.run(file, args, settings);
  if (args[0] !== "verify" || !selector(args)) return result;
  return { status: 0, stdout };
};
const isUnsignedInput = (args) => args.at(-1).endsWith("unsigned.apk");
const isSignedVerify = (args) => !args.includes("--min-sdk-version") && !isUnsignedInput(args);
const isV2Verify = (args) => args.includes("--min-sdk-version");

const SIGNER_FAILURE_CASES = [
  { code: "CONFIG_EVENT_CONTEXT", message: /GITHUB_EVENT_NAME/, prepare: (m) => { m.signingEnv.GITHUB_EVENT_NAME = "pull_request"; } },
  { code: "CONFIG_RUN_IDENTITY", message: /invalid run identity/, prepare: (m) => { m.signingEnv.GITHUB_RUN_ATTEMPT = "0"; } },
  { code: "CONFIG_CHECKOUT_MISMATCH", message: /checkout HEAD mismatch/, eligibility: { n: 257, tag: "b257", target: "b".repeat(40) } },
  { code: "CONFIG_PUBLIC_CERT", message: /invalid public certificate/, prepare: (m) => { m.signingEnv.ANDROID_SIGNING_CERT_SHA256 = "not-a-fingerprint"; } },
  { code: "CONFIG_SECRETS_MISSING", message: /signing secrets/, prepare: (m) => { m.signingEnv.ANDROID_SIGNING_ALIAS = ""; } },
  { code: "CONFIG_KEYSTORE_BASE64", message: /invalid base64 keystore/, prepare: (m) => { m.signingEnv.ANDROID_SIGNING_KEYSTORE_BASE64 = "not-base64!"; } },
  { code: "CONFIG_KEYSTORE_BASE64", message: /invalid base64 keystore/, prepare: (m) => { m.signingEnv.ANDROID_SIGNING_KEYSTORE_BASE64 = `${HOSTILE.ANDROID_SIGNING_KEYSTORE_BASE64}A`; } },
  { code: "INPUT_METADATA_HASH", message: /unsigned metadata artifact hash mismatch/, prepare: (m) => { m.signingEnv.EXPECTED_METADATA_SHA256 = "b".repeat(64); } },
  { code: "INPUT_METADATA_READ", message: /./, prepare: (m) => { const bytes = Buffer.from("{ not json"); m.files.set(path.join(m.input, "unsigned.json"), bytes); m.signingEnv.EXPECTED_METADATA_SHA256 = sha256Buffer(bytes); } },
  { code: "INPUT_SOURCE_IDENTITY", message: /unsigned source identity mismatch/, prepare: (m) => rewriteMetadata(m, { source: { ...metadata().source, sha: "b".repeat(40) } }) },
  { code: "INPUT_RUN_IDENTITY", message: /unsigned run identity mismatch/, prepare: (m) => rewriteMetadata(m, { run: { ...metadata().run, attempt: "1" } }) },
  { code: "INPUT_TOOLCHAIN", message: /toolchain mismatch/, prepare: (m) => rewriteMetadata(m, { toolchain: { ...android.TOOLCHAIN, buildTools: "36.0.0" } }) },
  { code: "INPUT_UNSIGNED_RECORD", message: /invalid unsigned input record/, prepare: (m) => rewriteMetadata(m, { unsigned: { sha256: "z".repeat(64), size: 5 } }) },
  { code: "INPUT_UNSIGNED_HASH", message: /unsigned artifact hash mismatch/, prepare: (m) => { m.signingEnv.EXPECTED_UNSIGNED_SHA256 = "b".repeat(64); } },
  { code: "INPUT_UNSIGNED_APK_DIGEST", message: /unsigned APK digest\/size mismatch/, prepare: (m) => { m.files.set(path.join(m.input, "unsigned.apk"), Buffer.from("tampered unsigned APK fixture")); } },
  { code: "APK_VERSION_MISMATCH", message: /APK package\/version mismatch/, options: { badge: { code: 1 } } },
  { code: "APK_SDK_MISMATCH", message: /APK SDK mismatch/, options: { badge: { min: 32 } } },
  { code: "APK_DEBUG_REFUSED", message: /debug APK refused/, options: { badge: { debug: true } } },
  { code: "APK_NOT_UNSIGNED", message: /build input must be unsigned/, run: (m) => passThroughVerify(m, isUnsignedInput, "") },
  { code: "APK_V3_UNVERIFIED", message: /requires a verified v3 signature/, run: (m) => passThroughVerify(m, isSignedVerify, signature(cert, true, false)) },
  { code: "APK_V2_UNVERIFIED", message: /requires a verified v2 signature/, run: (m) => passThroughVerify(m, isV2Verify, signature(cert, false, true)) },
  { code: "APK_CERT_MISMATCH", message: /APK signing certificate mismatch/, options: { cert: "b".repeat(64) } },
  { code: "CONFIG_RUNNER_TEMP", message: /RUNNER_TEMP is required/, prepare: (m) => { m.signingEnv.RUNNER_TEMP = ""; } },
  // An uncoded foreign failure inside the unsigned-input stage still resolves to that
  // stage's static code, and its original message is preserved unchanged.
  { code: "INPUT_UNSIGNED_APK", message: /mock aapt2 host failure/, run: (m) => (file, args, settings) => { if (file.endsWith("aapt2")) throw new Error("mock aapt2 host failure"); return m.run(file, args, settings); } },
];

for (const testCase of SIGNER_FAILURE_CASES) {
  test(`signer gate failure resolves to the static ${testCase.code} code without leaking input`, (t) => {
    const m = memorySigner(t, testCase.options ?? {});
    testCase.prepare?.(m);
    let error;
    try {
      android.signUnsigned({ input: m.input, directory: m.directory, eligibility: testCase.eligibility ?? eligibility, env: m.signingEnv, run: testCase.run ? testCase.run(m) : m.run });
    } catch (thrown) {
      error = thrown;
    }
    assert.ok(error, "the existing gate must still fail closed");
    assert.ok(android.SIGN_FAILURE_CODES.includes(android.signFailureCode(error)));
    assert.equal(android.signFailureCode(error), testCase.code);
    assert.match(error.message, testCase.message, "the existing redacted human error text is preserved");
    for (const secret of [m.signingEnv.ANDROID_SIGNING_PASSWORD, m.signingEnv.ANDROID_SIGNING_ALIAS, m.signingEnv.ANDROID_SIGNING_KEYSTORE_BASE64]) {
      if (secret) assert.ok(!error.message.includes(secret), "no secret material enters the error text");
    }
  });
}

test("an error object that refuses annotation still fails closed and resolves to the generic code", (t) => {
  const m = memorySigner(t);
  const hostile = new Error("mock tool failure with % and \r\n");
  Object.defineProperty(hostile, "signFailureCode", {
    configurable: true,
    get: () => "::error::forged\r\n::warning::leak",
    set: () => { throw new Error("annotation refused"); },
  });
  const run = (file, args, settings) => { if (args[0] === "sign") throw hostile; return m.run(file, args, settings); };
  let error;
  try {
    android.signUnsigned({ input: m.input, directory: m.directory, eligibility, env: m.signingEnv, run });
  } catch (thrown) {
    error = thrown;
  }
  assert.equal(error, hostile, "the original error still propagates unchanged");
  assert.equal(android.signFailureCode(error), "SIGN_UNEXPECTED");
  assert.ok(m.removed.some((directory) => directory.includes("android-sign-")), "the temporary key directory is still cleaned up");
});

// A hostile thrown value can throw while its internal code property is being read. Neither
// classification nor stage annotation may propagate that accessor exception: it would
// replace the original failure and escape the redaction boundary into Node's crash output.
function throwingCodeGetter() {
  const error = new Error("original failure");
  Object.defineProperty(error, "signFailureCode", { configurable: true, get: () => { throw new Error(HOSTILE_ACCESSOR_MESSAGE); } });
  return error;
}
const HOSTILE_ACCESSES = [
  ["throwing getter", throwingCodeGetter, "SIGN_UNEXPECTED"],
  // A revoked Proxy throws from every internal method, including the code read and write.
  ["revoked proxy", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  }, "SIGN_UNEXPECTED"],
  // Every read throws, so an attached stage code can never be observed.
  ["throwing proxy trap", () => new Proxy({}, { get: () => { throw new Error(HOSTILE_ACCESSOR_MESSAGE); } }), "SIGN_UNEXPECTED"],
];

for (const [name, makeHostile] of HOSTILE_ACCESSES) {
  test(`code classification returns the static fallback for a ${name}`, () => {
    assert.equal(android.signFailureCode(makeHostile()), "SIGN_UNEXPECTED");
  });
}

function hostileThrower(m, hostile, site) {
  return (file, args, settings) => {
    if (site === "sign" && args[0] === "sign") throw hostile;
    // Thrown inside the signed-verification stage, so the stage annotation path runs.
    if (site === "verify" && file.endsWith("aapt2") && !args.at(-1).endsWith("unsigned.apk")) throw hostile;
    return m.run(file, args, settings);
  };
}

for (const [name, makeHostile, expectedCode] of HOSTILE_ACCESSES) {
  for (const site of ["sign", "verify"]) {
    test(`a ${name} thrown during ${site} cannot replace the signer failure or escape code classification`, (t) => {
      const hostile = makeHostile();
      const m = memorySigner(t);
      let error;
      try {
        android.signUnsigned({ input: m.input, directory: m.directory, eligibility, env: m.signingEnv, run: hostileThrower(m, hostile, site) });
      } catch (thrown) {
        error = thrown;
      }
      assert.equal(error, hostile, "the original failure is never replaced by an accessor error");
      const code = android.signFailureCode(error);
      assert.ok(android.SIGN_FAILURE_CODES.includes(code), "classification always stays inside the closed allowlist");
      assert.equal(code, expectedCode);
      assert.ok(m.removed.some((directory) => directory.includes("android-sign-")), "the temporary key directory is still cleaned up");
      assert.ok(![...m.files.keys()].some((file) => file.endsWith(".p12") || file.startsWith(m.directory)), "no key or public asset survives");
    });
  }
}

for (const code of ["APK_V3_UNVERIFIED", "APK_V2_UNVERIFIED", "APK_CERT_MISMATCH"]) {
  // One in-memory filesystem per test context: mocking the same fs method repeatedly
  // inside a single test would leak an implementation into later tests.
  test(`post-key stage failure ${code} still cleans the key and writes no public asset`, (t) => {
    const testCase = SIGNER_FAILURE_CASES.find((item) => item.code === code);
    const m = memorySigner(t, testCase.options ?? {});
    testCase.prepare?.(m);
    assert.throws(() => android.signUnsigned({ input: m.input, directory: m.directory, eligibility, env: m.signingEnv, run: testCase.run ? testCase.run(m) : m.run }));
    assert.ok(m.removed.some((directory) => directory.includes("android-sign-")), `${code} still cleans the key`);
    assert.ok(![...m.files.keys()].some((file) => file.endsWith(".p12") || file.startsWith(m.directory)));
  });
}

const ORDINARY_CALLER_FIELDS = [
  "PI_CLIPBOARD_OSC52", "PI_CODING_AGENT", "PI_CODING_AGENT_DIR", "PI_IMAGE_PROTOCOL",
  "PI_REVIEW_GATE_DDGS_PYTHON", "PI_REVIEW_GATE_RETAIN_BUNDLES", "AI_AGENT", "PI_MODEL",
  "PI_PROVIDER", "PI_REASONING_LEVEL", "PI_SESSION_ID", "PI_SESSION_FILE",
];
function cliEnvironment(overrides = {}) {
  assert.ok(!ORDINARY_CALLER_FIELDS.some((key) => Object.hasOwn(overrides, key)), "fixture overrides must not change caller fields");
  return {
    ...Object.fromEntries(ORDINARY_CALLER_FIELDS.filter((key) => Object.hasOwn(process.env, key)).map((key) => [key, process.env[key]])),
    PATH: process.env.PATH,
    GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REF_TYPE: "branch",
    GITHUB_REPOSITORY: "rfairburn/pi-review-gate", GITHUB_SHA: target,
    GITHUB_RUN_ID: "1234", GITHUB_RUN_ATTEMPT: "2", RELEASE_N: "257",
    ANDROID_HOME: "/mock-sdk", RUNNER_TEMP: path.join(process.cwd(), "memory-only"),
    ANDROID_SIGNING_CERT_SHA256: cert,
    ...overrides,
  };
}
test("CLI fixtures preserve ordinary caller fields by value and absence", () => {
  const inherited = cliEnvironment();
  for (const key of ORDINARY_CALLER_FIELDS) {
    assert.ok(Object.hasOwn(inherited, key) === Object.hasOwn(process.env, key), key);
    assert.ok(inherited[key] === process.env[key], key);
    assert.throws(() => cliEnvironment({ [key]: "fixture replacement" }), /must not change caller fields/);
  }
});
function runReleaseCli(args, overrides = {}) {
  return spawnSync(process.execPath, [CLI_SCRIPT, ...args], { encoding: "utf8", cwd: process.cwd(), env: cliEnvironment(overrides) });
}
const cliOutput = (result) => `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const listFiles = (directory) => (fs.existsSync(directory) ? fs.readdirSync(directory) : []);
const cliAnnotations = (result) => cliOutput(result).split(/\r?\n/).filter((line) => line.startsWith("::"));
function assertCliAnnotation(result, code) {
  assert.deepEqual(cliAnnotations(result), [`${ANNOTATION_PREFIX}${code}`], "exactly one closed-list annotation and no other workflow command");
  assert.match(result.stderr ?? "", new RegExp(`^${escapeRegExp(ANNOTATION_PREFIX + code)}$`, "m"));
  assert.match(result.stderr ?? "", new RegExp(`^${escapeRegExp(CLI_GENERIC_ERROR)}$`, "m"), "the generic redacted human error text is preserved");
  assert.equal(result.status, 1, "the CLI still fails closed");
  for (const value of HOSTILE_VALUES) {
    if (value) assert.ok(!cliOutput(result).includes(value), "no planted secret, alias, base64, or forged command reaches the output");
  }
}

test("CLI sign configuration gates publish exactly one closed-list annotation each", () => {
  const cases = [
    { code: "CONFIG_PUBLIC_CERT", overrides: { ...HOSTILE, ANDROID_SIGNING_CERT_SHA256: "not-a-fingerprint" } },
    { code: "CONFIG_SECRETS_MISSING", overrides: { ...HOSTILE, ANDROID_SIGNING_ALIAS: "" } },
    { code: "CONFIG_KEYSTORE_BASE64", overrides: { ...HOSTILE, ANDROID_SIGNING_KEYSTORE_BASE64: "not-base64!" } },
    { code: "INPUT_METADATA_HASH", overrides: { ...HOSTILE, EXPECTED_METADATA_SHA256: "b".repeat(64) } },
  ];
  for (const testCase of cases) {
    assertCliAnnotation(runReleaseCli(["sign", path.join(env.RUNNER_TEMP, "absent-input"), path.join(env.RUNNER_TEMP, "absent-output")], testCase.overrides), testCase.code);
  }
});

// Mock shell tools stand in for the pinned build-tools binaries: they always print output
// that must never reach the CLI, and they fail or succeed on mock-only switches. Nothing
// here is a real SDK, keystore, or APK.
const FAKE_TOOL_SCRIPT = `#!/bin/sh
tool=$(basename "$0")
echo "MOCK-$tool-STDOUT $ANDROID_SIGNING_PASSWORD $ANDROID_SIGNING_ALIAS $ANDROID_SIGNING_KEYSTORE_BASE64"
echo "MOCK-$tool-STDERR $ANDROID_SIGNING_PASSWORD" >&2
last=""
previous=""
for argument in "$@"; do previous="$last"; last="$argument"; done
if [ "$tool" = "aapt2" ]; then
  if [ "$FAKE_AAPT2_FAIL" = "1" ]; then exit 3; fi
  printf "package: name='io.github.rfairburn.pireviewgate' versionCode='257' versionName='0.1.0+257'\\nminSdkVersion:'33'\\ntargetSdkVersion:'37'\\n"
  exit 0
fi
if [ "$tool" = "zipalign" ]; then
  if [ "$FAKE_ZIPALIGN_FAIL" = "1" ]; then exit 4; fi
  if [ "$1" = "-c" ]; then exit 0; fi
  cp "$previous" "$last"
  exit $?
fi
if [ "$1" = "sign" ]; then
  if [ "$FAKE_APKSIGNER_SIGN_FAIL" = "1" ]; then exit 5; fi
  out=""
  seen=""
  for argument in "$@"; do if [ "$seen" = "--out" ]; then out="$argument"; fi; seen="$argument"; done
  cp "$last" "$out"
  exit $?
fi
case "$last" in
  *unsigned.apk) exit 1 ;;
esac
printf "Verified using v2 scheme (APK Signature Scheme v2): true\\nVerified using v3 scheme (APK Signature Scheme v3): true\\nSigner #1 certificate SHA-256 digest: %s\\n" "$FAKE_CERT"
exit 0
`;

function fakeSigningWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-review-gate-android-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "sdk", "build-tools", android.TOOLCHAIN.buildTools);
  fs.mkdirSync(bin, { recursive: true });
  for (const tool of ["aapt2", "zipalign", "apksigner"]) fs.writeFileSync(path.join(bin, tool), FAKE_TOOL_SCRIPT, { mode: 0o755 });
  const input = path.join(root, "unsigned");
  fs.mkdirSync(input, { recursive: true });
  const apk = Buffer.from("mock unsigned APK bytes; never a real APK");
  fs.writeFileSync(path.join(input, "unsigned.apk"), apk);
  const metadataBytes = Buffer.from(JSON.stringify({
    source: android.identity(eligibility), run: android.runIdentity(env),
    unsigned: { sha256: sha256Buffer(apk), size: apk.length }, toolchain: android.TOOLCHAIN,
  }));
  fs.writeFileSync(path.join(input, "unsigned.json"), metadataBytes);
  assert.ok(fs.existsSync(path.join(input, "unsigned.json")), "the mock CLI fixture must be a real file outside the repository");
  return {
    root, input, out: path.join(root, "signed"),
    env: {
      ...HOSTILE,
      ANDROID_HOME: path.join(root, "sdk"),
      RUNNER_TEMP: root,
      EXPECTED_UNSIGNED_SHA256: sha256Buffer(apk),
      EXPECTED_METADATA_SHA256: sha256Buffer(metadataBytes),
      FAKE_CERT: cert,
    },
  };
}

test("CLI tool-stage failures publish their static stage code and never echo tool output", (t) => {
  for (const [code, switchName] of [["TOOL_AAPT2", "FAKE_AAPT2_FAIL"], ["TOOL_ZIPALIGN", "FAKE_ZIPALIGN_FAIL"], ["TOOL_APKSIGNER_SIGN", "FAKE_APKSIGNER_SIGN_FAIL"]]) {
    const workspace = fakeSigningWorkspace(t);
    const result = runReleaseCli(["sign", workspace.input, workspace.out], { ...workspace.env, [switchName]: "1" });
    assertCliAnnotation(result, code);
    assert.ok(!cliOutput(result).includes("MOCK-"), "mock tool stdout/stderr stays inside the captured pipe");
    assert.deepEqual(listFiles(workspace.out).filter((name) => name.startsWith("android-sign-")), [], "no temporary signing directory survives");
    assert.ok(!listFiles(workspace.root).some((name) => name.startsWith("android-sign-")), "the temporary key directory is removed");
  }
});

test("CLI sign success publishes no annotation and still produces exactly the three public assets", (t) => {
  const workspace = fakeSigningWorkspace(t);
  const result = runReleaseCli(["sign", workspace.input, workspace.out], workspace.env);
  assert.equal(result.status, 0, `${result.stderr}`);
  assert.deepEqual(cliAnnotations(result), []);
  assert.equal(result.stderr, "");
  assert.deepEqual(listFiles(workspace.out).sort(), android.names(257).sort());
  assert.ok(!listFiles(workspace.root).some((name) => name.startsWith("android-sign-")));
  const provenance = JSON.parse(fs.readFileSync(path.join(workspace.out, "android-provenance.json"), "utf8"));
  assert.equal(provenance.certificateSha256, cert);
  assert.ok(!JSON.stringify(provenance).includes("mock-alias"));
});

test("non-sign CLI modes keep their existing redaction and publish no annotation", () => {
  const unsigned = runReleaseCli(["unsigned", "absent.apk", path.join(env.RUNNER_TEMP, "absent-output")], { ...HOSTILE });
  assert.equal(unsigned.status, 1);
  assert.deepEqual(cliAnnotations(unsigned), []);
  assert.match(unsigned.stderr, new RegExp(`^${escapeRegExp(CLI_GENERIC_ERROR)}$`, "m"));
  const sdk = runReleaseCli(["sdk"], { ...HOSTILE });
  assert.equal(sdk.status, 1);
  assert.deepEqual(cliAnnotations(sdk), []);
  assert.match(sdk.stderr, /^Android SDK provisioning failed closed\.$/m);
  const artifact = runReleaseCli(["check-artifact"], { ...HOSTILE });
  assert.equal(artifact.status, 1);
  assert.deepEqual(cliAnnotations(artifact), []);
  assert.match(artifact.stderr, /^Android artifact identity verification failed closed\.$/m);
  const usage = runReleaseCli(["sign"], { ...HOSTILE });
  assert.equal(usage.status, 1);
  assert.deepEqual(cliAnnotations(usage), [], "a missing-argument usage error is not reported as a signer failure");
  assert.match(usage.stderr, new RegExp(`^${escapeRegExp(CLI_GENERIC_ERROR)}$`, "m"));
});
