"use strict";

// Also loaded by the compiled TS suite. No SDK, real key generation, API calls,
// or filesystem writes: the signing boundary uses an in-memory filesystem.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
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
  return `package: name='${values.package}' versionCode='${values.code}' versionName='${values.name}'\nsdkVersion:'${values.min}'\ntargetSdkVersion:'${values.target}'\n${values.debug ? "application-debuggable" : ""}`;
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
