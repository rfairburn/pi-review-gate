import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";

const requireCjs = createRequire(join(process.cwd(), "tests", "node-bootstrap-lifetime.test.ts"));
const protocol = requireCjs("../scripts/node-bootstrap-lifetime.cjs");
const launcher = requireCjs("../scripts/pi-review-sessions.cjs").__test;
const posix = { skip: process.platform === "win32" };
function fixture() {
  const parent = join(process.cwd(), "node_modules", ".worker-private", "node-lifetime");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "fixture-"));
  const cache = join(root, ".pi-review-gate", "node");
  const generation = join(cache, "bootstrap.synthetic-1234");
  mkdirSync(generation, { recursive: true });
  const s = lstatSync(generation, { bigint: true });
  const text = `pi-review-gate-node-v1\n${s.dev}:${s.ino}\nbootstrap.synthetic-1234\nprotected\n`;
  const record = join(generation, ".node-lifetime");
  writeFileSync(record, text, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { PI_REVIEW_GATE_NODE_GENERATION: generation, PI_REVIEW_GATE_NODE_HOLDER: "bootstrap.synthetic-1234", NODE_OPTIONS: "--no-warnings" };
  return { root, cache, generation, text, record, env };
}

test("Node bootstrap uses one canonical native record, consumes context, and publishes only still-protected quiescence", posix, () => {
  const f = fixture();
  const publish = protocol.consume(f.env);
  assert.deepEqual(f.env, { NODE_OPTIONS: "--no-warnings" });
  assert.equal(readFileSync(f.record, "utf8"), f.text);
  assert.equal(publish(), true);
  assert.equal(readFileSync(f.record, "utf8"), f.text.replace("protected\n", "quiescent\n"));
  assert.equal(publish(), false, "a second or stale publication cannot overwrite logical state");
});

test("Node bootstrap publication refuses root/parent aliases, replaced records, and admission collisions", posix, () => {
  for (const mode of ["parent-alias", "root-replaced", "malformed", "lock"] as const) {
    const f = fixture();
    const publish = protocol.consume(f.env);
    let record = f.record;
    if (mode === "parent-alias") {
      const old = join(f.root, "original");
      renameSync(join(f.root, ".pi-review-gate"), old);
      symlinkSync(old, join(f.root, ".pi-review-gate"));
      record = join(old, "node", "bootstrap.synthetic-1234", ".node-lifetime");
    } else if (mode === "root-replaced") {
      renameSync(f.generation, `${f.generation}.old`);
      mkdirSync(f.generation);
      writeFileSync(f.record, f.text, { mode: 0o600 });
    } else if (mode === "malformed") {
      writeFileSync(f.record, "uncertain", { mode: 0o600 });
    } else {
      const outside = join(f.root, "sentinel");
      writeFileSync(outside, "outside");
      symlinkSync(outside, join(f.cache, ".admission.lock"));
    }
    const before = readFileSync(record, "utf8");
    assert.equal(publish(), false, mode);
    assert.equal(readFileSync(record, "utf8"), before, mode);
  }
});

test("launcher Node quiescence requires positive native and every relevant setup settlement, never numeric zero", posix, async () => {
  for (const mode of ["complete", "numeric", "ddgs-uncertain", "ddgs-throw", "pi-throw", "build-uncertain", "build-failed-settled"] as const) {
    const f = fixture();
    const packageRoot = join(f.root, "package");
    mkdirSync(join(packageRoot, "src", "session-host"), { recursive: true });
    writeFileSync(join(packageRoot, "src", "session-host", "main.ts"), "synthetic");
    const publish = protocol.consume(f.env);
    let handoffs = 0;
    const status = await launcher.runSessionHostLauncher([], {
      getEnv: () => f.env, processEnv: {}, packageRoot, cwd: process.cwd(),
      platform: process.platform, nodeVersion: process.versions.node, stdinIsTTY: true, stdoutIsTTY: true,
      build: () => mode === "build-failed-settled"
        ? { status: 1, lifetimeSettled: true }
        : { status: 0, lifetimeSettled: mode !== "build-uncertain" },
      isRegularFile: () => true,
      resolvePiRuntime: () => {
        if (mode === "pi-throw") throw new Error("unconfirmed probe");
        return { file: resolve(f.root, "pi.js"), version: "1.3.0", source: "explicit", lifetimeSettled: true };
      },
      ensureDdgs: () => {
        if (mode === "ddgs-throw") throw new Error("unknown helper");
        return mode === "ddgs-uncertain" ? { ok: false, cleanupUnconfirmed: true } : { ok: true, python: resolve(f.root, "python") };
      },
      refreshShippedSkills: () => ({ ok: true }), writeOut: () => {}, writeError: () => {},
      loadMain: () => ({ runSessionHost: (options: { onCacheConsumersSettled(): void; env: NodeJS.ProcessEnv }) => {
        assert.equal(options.env.PI_REVIEW_GATE_NODE_GENERATION, undefined);
        assert.equal(options.env.PI_REVIEW_GATE_NODE_HOLDER, undefined);
        if (mode !== "numeric") options.onCacheConsumersSettled();
        return 0;
      } }),
      onNodeConsumersQuiescent: () => { handoffs++; assert.equal(publish(), true); },
    });
    const settled = mode === "complete" || mode === "build-failed-settled";
    assert.equal(handoffs, settled ? 1 : 0, mode);
    assert.equal(readFileSync(f.record, "utf8"), settled ? f.text.replace("protected\n", "quiescent\n") : f.text, mode);
    assert.equal(status, ["ddgs-uncertain", "ddgs-throw", "pi-throw", "build-failed-settled"].includes(mode) ? 1 : 0);
  }
});
