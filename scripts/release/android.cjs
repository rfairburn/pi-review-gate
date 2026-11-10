"use strict";

// Dependency-free Android release boundary. Never execute artifact-supplied code.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { REPOSITORY, ReleaseError, assertReleaseEventContext, git, sha256Buffer } = require("./common.cjs");

const APPLICATION_ID = "io.github.rfairburn.pireviewgate";
const SCHEMA = "pi-review-gate-android-provenance/1";
const TOOLCHAIN = Object.freeze({ gradle: "9.6.1", agp: "9.3.1", kotlin: "2.4.21", jdk: "21.0.9+10", commandLineTools: "22.0", compileSdk: 37, buildTools: "37.0.0" });
function fail(message) { throw new ReleaseError(`Android release: ${message}`); }
function version(n) {
  if (!Number.isSafeInteger(n) || n < 1 || n > 2100000000) fail("N must be an integer in 1..2100000000");
  return { applicationId: APPLICATION_ID, versionCode: n, versionName: `0.1.0+${n}`, minSdk: 33, targetSdk: 37 };
}
function certificate(value) {
  if (typeof value !== "string") fail("ANDROID_SIGNING_CERT_SHA256 is required");
  const normalized = value.replace(/:/g, "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) fail("invalid public certificate SHA-256");
  return normalized;
}
function filename(n) { version(n); return `pi-review-gate-b${n}.apk`; }
function names(n) { return [filename(n), "ANDROID_SHA256SUMS", "android-provenance.json"]; }
function identity(eligibility) {
  const app = version(eligibility.n);
  if (eligibility.tag !== `b${eligibility.n}` || !/^[a-f0-9]{40}$/.test(eligibility.target)) fail("source/tag mismatch");
  return { repository: REPOSITORY, sha: eligibility.target, tag: eligibility.tag, n: eligibility.n, ...app };
}
function runTool(file, args, { env = process.env, allowFailure = false, input } = {}) {
  const result = spawnSync(file, args, { env, input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  // Do not propagate tool stderr, argv, or exceptions: signing argv includes the
  // secret alias and tool diagnostics may echo credentials or private paths.
  if (result.error || (result.status !== 0 && !allowFailure)) fail("tool execution failed");
  return { status: result.status, stdout: result.stdout ?? "" };
}
function tools(env) {
  if (!env.ANDROID_HOME) fail("ANDROID_HOME is required");
  const root = path.join(env.ANDROID_HOME, "build-tools", TOOLCHAIN.buildTools);
  return { apksigner: path.join(root, "apksigner"), zipalign: path.join(root, "zipalign"), aapt2: path.join(root, "aapt2") };
}
function inspectApk(apk, eligibility, { env = process.env, run = runTool, signed = true, cert } = {}) {
  const expected = version(eligibility.n);
  const tool = tools(env);
  const badging = run(tool.aapt2, ["dump", "badging", apk], { env }).stdout;
  const pkg = badging.match(/^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m);
  if (!pkg || pkg[1] !== expected.applicationId || pkg[2] !== String(expected.versionCode) || pkg[3] !== expected.versionName) fail("APK package/version mismatch");
  if (!badging.includes(`sdkVersion:'${expected.minSdk}'`) || !badging.includes(`targetSdkVersion:'${expected.targetSdk}'`)) fail("APK SDK mismatch");
  if (/application-debuggable/m.test(badging)) fail("debug APK refused");
  const verified = run(tool.apksigner, ["verify", "--verbose", "--print-certs", apk], { env, allowFailure: !signed });
  if (!signed) {
    if (verified.status === 0) fail("build input must be unsigned");
    return;
  }
  if (verified.status !== 0 || !/Verified using v3 scheme .*: true/.test(verified.stdout)) fail("APK requires a verified v3 signature");
  // With manifest minSdk 33, apksig may skip v2 when v3 verifies. Check v2
  // independently over its pre-v3 SDK range without changing the APK's SDKs.
  const v2Verified = run(tool.apksigner, ["verify", "--verbose", "--print-certs", "--min-sdk-version", "24", "--max-sdk-version", "27", apk], { env });
  if (v2Verified.status !== 0 || !/Verified using v2 scheme .*: true/.test(v2Verified.stdout)) fail("APK requires a verified v2 signature");
  for (const result of [verified, v2Verified]) {
    const digests = [...result.stdout.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9:]+)\s*$/gm)];
    if (digests.length !== 1 || certificate(digests[0][1]) !== certificate(cert)) fail("APK signing certificate mismatch");
  }
  run(tool.zipalign, ["-c", "-P", "16", "4", apk], { env });
}
function fileRecord(file) {
  const buffer = fs.readFileSync(file);
  return { sha256: sha256Buffer(buffer), size: buffer.length };
}
function same(actual, expected, description) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${description} mismatch`);
}
function runIdentity(env) {
  assertReleaseEventContext(env);
  if (!/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") || !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? "")) fail("invalid run identity");
  return { repository: REPOSITORY, event: "push", sha: env.GITHUB_SHA, id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT };
}
function validateMetadata(metadata, eligibility, env) {
  same(metadata.source, identity(eligibility), "unsigned source identity");
  same(metadata.run, runIdentity(env), "unsigned run identity");
  same(metadata.toolchain, TOOLCHAIN, "toolchain");
  if (!/^[a-f0-9]{64}$/.test(metadata.unsigned?.sha256 ?? "") || !Number.isSafeInteger(metadata.unsigned?.size) || metadata.unsigned.size < 1) fail("invalid unsigned input record");
}
function output(env, fields) {
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, Object.entries(fields).map(([k, v]) => `${k}=${v}\n`).join(""));
}
function prepareUnsigned({ apk, eligibility, directory, env = process.env, run = runTool }) {
  const source = identity(eligibility);
  const runId = runIdentity(env);
  if (git(["rev-parse", "HEAD"], { repoRoot: process.cwd() }) !== source.sha) fail("checkout HEAD mismatch");
  inspectApk(apk, eligibility, { env, run, signed: false });
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, "unsigned.apk");
  fs.copyFileSync(apk, destination);
  const metadata = { source, run: runId, unsigned: fileRecord(destination), toolchain: TOOLCHAIN };
  const metadataPath = path.join(directory, "unsigned.json");
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  output(env, { unsigned_sha256: metadata.unsigned.sha256, metadata_sha256: fileRecord(metadataPath).sha256 });
  return metadata;
}
function signUnsigned({ input, directory, eligibility, env = process.env, run = runTool }) {
  runIdentity(env);
  if (git(["rev-parse", "HEAD"], { repoRoot: process.cwd() }) !== eligibility.target) fail("checkout HEAD mismatch");
  const cert = certificate(env.ANDROID_SIGNING_CERT_SHA256);
  const encoded = env.ANDROID_SIGNING_KEYSTORE_BASE64;
  const password = env.ANDROID_SIGNING_PASSWORD;
  const alias = env.ANDROID_SIGNING_ALIAS;
  if (!encoded || !password || !alias) fail("all three Android signing secrets are required");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || Buffer.from(encoded, "base64").length === 0) fail("invalid base64 keystore");
  const unsigned = path.join(input, "unsigned.apk");
  const metadataFile = path.join(input, "unsigned.json");
  if (fileRecord(metadataFile).sha256 !== env.EXPECTED_METADATA_SHA256) fail("unsigned metadata artifact hash mismatch");
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  validateMetadata(metadata, eligibility, env);
  if (metadata.unsigned.sha256 !== env.EXPECTED_UNSIGNED_SHA256) fail("unsigned artifact hash mismatch");
  same(fileRecord(unsigned), metadata.unsigned, "unsigned APK digest/size");
  // All subprocesses before signing receive no signing credentials; only the
  // apksigner invocation receives the shared password through an environment key.
  const publicEnv = { ...env };
  delete publicEnv.ANDROID_SIGNING_KEYSTORE_BASE64;
  delete publicEnv.ANDROID_SIGNING_PASSWORD;
  delete publicEnv.ANDROID_SIGNING_ALIAS;
  inspectApk(unsigned, eligibility, { env: publicEnv, run, signed: false });
  if (!env.RUNNER_TEMP) fail("RUNNER_TEMP is required");
  const temporary = fs.mkdtempSync(path.join(env.RUNNER_TEMP, "android-sign-"));
  fs.chmodSync(temporary, 0o700);
  try {
    const key = path.join(temporary, "release.p12");
    fs.writeFileSync(key, Buffer.from(encoded, "base64"), { mode: 0o600 });
    const aligned = path.join(temporary, "aligned.apk");
    const signed = path.join(temporary, filename(eligibility.n));
    const tool = tools(publicEnv);
    run(tool.zipalign, ["-P", "16", "-f", "4", unsigned, aligned], { env: publicEnv });
    run(tool.apksigner, ["sign", "--ks", key, "--ks-type", "PKCS12", "--ks-key-alias", alias,
      "--ks-pass", "env:ANDROID_SIGNING_PASSWORD", "--key-pass", "env:ANDROID_SIGNING_PASSWORD",
      "--v1-signing-enabled", "false", "--v2-signing-enabled", "true", "--v3-signing-enabled", "true", "--v4-signing-enabled", "false",
      "--out", signed, aligned], { env: { ...publicEnv, ANDROID_SIGNING_PASSWORD: password } });
    inspectApk(signed, eligibility, { env: publicEnv, run, cert });
    const provenance = { schema: SCHEMA, source: identity(eligibility), unsigned: metadata.unsigned, signed: fileRecord(signed), certificateSha256: cert, toolchain: TOOLCHAIN };
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(signed, path.join(directory, filename(eligibility.n)));
    fs.writeFileSync(path.join(directory, "ANDROID_SHA256SUMS"), `${provenance.signed.sha256}  ${filename(eligibility.n)}\n`);
    fs.writeFileSync(path.join(directory, "android-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
    loadAssets({ directory, eligibility, env: publicEnv, run });
    output(env, { signed_sha256: provenance.signed.sha256, signed_metadata_sha256: fileRecord(path.join(directory, "android-provenance.json")).sha256 });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
function verifyAssets({ buffers, eligibility, scratch, env = process.env, run = runTool }) {
  const [apkName] = names(eligibility.n);
  for (const name of names(eligibility.n)) if (!Buffer.isBuffer(buffers[name])) fail(`missing asset ${name}`);
  const provenance = JSON.parse(buffers["android-provenance.json"].toString("utf8"));
  if (provenance.schema !== SCHEMA) fail("provenance schema mismatch");
  same(provenance.source, identity(eligibility), "signed source identity");
  same(provenance.toolchain, TOOLCHAIN, "signed toolchain");
  if (!/^[a-f0-9]{64}$/.test(provenance.unsigned?.sha256 ?? "") || !Number.isSafeInteger(provenance.unsigned?.size) || provenance.unsigned.size < 1) fail("invalid unsigned provenance");
  if (provenance.certificateSha256 !== certificate(env.ANDROID_SIGNING_CERT_SHA256)) fail("provenance certificate mismatch");
  const signed = { sha256: sha256Buffer(buffers[apkName]), size: buffers[apkName].length };
  same(provenance.signed, signed, "signed APK digest/size");
  if (buffers.ANDROID_SHA256SUMS.toString("utf8") !== `${signed.sha256}  ${apkName}\n`) fail("APK checksum mismatch");
  const temporary = fs.mkdtempSync(path.join(scratch, "android-verify-"));
  try {
    const apk = path.join(temporary, apkName);
    fs.writeFileSync(apk, buffers[apkName]);
    inspectApk(apk, eligibility, { env, run, cert: provenance.certificateSha256 });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return provenance;
}
function loadAssets({ directory, eligibility, env = process.env, run = runTool }) {
  if (!directory) fail("signed Android asset directory is required");
  const buffers = Object.fromEntries(names(eligibility.n).map((name) => [name, fs.readFileSync(path.join(directory, name))]));
  if (env.EXPECTED_SIGNED_SHA256 && sha256Buffer(buffers[filename(eligibility.n)]) !== env.EXPECTED_SIGNED_SHA256) fail("signed artifact hash mismatch");
  if (env.EXPECTED_SIGNED_METADATA_SHA256 && sha256Buffer(buffers["android-provenance.json"]) !== env.EXPECTED_SIGNED_METADATA_SHA256) fail("signed metadata artifact hash mismatch");
  verifyAssets({ buffers, eligibility, scratch: env.RUNNER_TEMP ?? directory, env, run });
  return names(eligibility.n).map((name) => ({ filename: name, buffer: buffers[name], sha256: sha256Buffer(buffers[name]), size: buffers[name].length }));
}
// Tool provisioning runs BEFORE the one secret-bearing step, never during it.
// Archive/checksum from the official Android command-line tools download page.
async function installSdk({ platform = false, env = process.env, fetchImpl = globalThis.fetch, run = runTool }) {
  if (!env.RUNNER_TEMP || !env.GITHUB_ENV) fail("runner tool provisioning context missing");
  const response = await fetchImpl("https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip");
  if (!response.ok) fail("SDK tools download failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256Buffer(bytes) !== "4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583") fail("SDK tools checksum mismatch");
  const zip = path.join(env.RUNNER_TEMP, "android-tools.zip");
  const home = path.join(env.RUNNER_TEMP, "android-sdk");
  const commands = path.join(home, "cmdline-tools");
  fs.writeFileSync(zip, bytes);
  fs.mkdirSync(commands, { recursive: true });
  run("unzip", ["-q", zip, "-d", commands], { env });
  fs.renameSync(path.join(commands, "cmdline-tools"), path.join(commands, "22.0"));
  const sdkmanager = path.join(commands, "22.0", "bin", "sdkmanager");
  const sdkEnv = { ...env, ANDROID_HOME: home, ANDROID_SDK_ROOT: home, ANDROID_USER_HOME: path.join(env.RUNNER_TEMP, "android-user") };
  run(sdkmanager, ["--licenses"], { env: sdkEnv, input: "y\n".repeat(100) });
  // sdkmanager package identifiers are the vendor's exact strings: the API 37
  // platform package is 'platforms;android-37.0', so the bare path is refused.
  run(sdkmanager, ["build-tools;37.0.0", ...(platform ? ["platforms;android-37.0"] : [])], { env: sdkEnv });
  fs.appendFileSync(env.GITHUB_ENV, `ANDROID_HOME=${home}\nANDROID_SDK_ROOT=${home}\nANDROID_USER_HOME=${sdkEnv.ANDROID_USER_HOME}\n`);
}
async function checkArtifact({ env = process.env, fetchImpl = globalThis.fetch }) {
  runIdentity(env);
  if (!/^[1-9][0-9]*$/.test(env.ARTIFACT_ID ?? "") || !/^[a-f0-9]{64}$/.test(env.ARTIFACT_DIGEST ?? "")) fail("invalid immutable artifact reference");
  const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${env.ARTIFACT_ID}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) fail("artifact lookup failed");
  const artifact = await response.json();
  if (String(artifact.id) !== env.ARTIFACT_ID || artifact.expired !== false || artifact.digest !== `sha256:${env.ARTIFACT_DIGEST}` || String(artifact.workflow_run?.id) !== env.GITHUB_RUN_ID || artifact.workflow_run?.head_sha !== env.GITHUB_SHA) fail("artifact source/run/digest mismatch");
}
module.exports = { installSdk, checkArtifact, APPLICATION_ID, SCHEMA, TOOLCHAIN, version, certificate, filename, names, identity, inspectApk, prepareUnsigned, signUnsigned, verifyAssets, loadAssets, runIdentity, validateMetadata };

if (require.main === module) {
  try {
    const [command, input, directory] = process.argv.slice(2);
    const n = Number(process.env.RELEASE_N);
    const eligibility = { n, target: process.env.GITHUB_SHA, tag: `b${n}` };
    if (command === "unsigned" && input && directory) prepareUnsigned({ apk: input, directory, eligibility });
    else if (command === "sign" && input && directory) signUnsigned({ input, directory, eligibility });
    else if (command === "sdk") {
      installSdk({ platform: input === "platform" }).catch(() => { process.stderr.write("Android SDK provisioning failed closed.\n"); process.exitCode = 1; });
    } else if (command === "check-artifact") {
      checkArtifact({}).catch(() => { process.stderr.write("Android artifact identity verification failed closed.\n"); process.exitCode = 1; });
    } else fail("expected unsigned|sign INPUT OUTPUT or check-artifact");
  } catch {
    // Never echo signing-tool exceptions or supplied secret values.
    process.stderr.write("Android release failed closed; check public configuration, input identity, and signing tool prerequisites.\n");
    process.exitCode = 1;
  }
}
