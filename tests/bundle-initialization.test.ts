import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { createReviewBundle, createReviewerQuestionBundle, removeTransientWindowBundle, type ReviewBundleInput } from "../src/bundle";
import type { ReviewExchangeContext } from "../src/state";

const mutableFs = createRequire(__filename)("node:fs") as typeof fs;
const mutableFsp = createRequire(__filename)("node:fs/promises") as typeof fsp;
const real = { ...fs, ...fsp, mkdirSync: fs.mkdirSync, mkdtempSync: fs.mkdtempSync, rmSync: fs.rmSync, writeFileSync: fs.writeFileSync, lstatSync: fs.lstatSync, renameSync: fs.renameSync };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within(promise: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([promise, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error("initialization fixture did not reach its expected barrier")), 10_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Builtin fault injection is scoped to one awaited invocation, with no child processes. */
async function fixture(run: (context: {
  parent: string;
  neighbor: string;
  roots: string[];
  warnings: unknown[][];
  input: ReviewBundleInput;
  patch: (module: object, name: string, replacement: unknown) => void;
}) => Promise<void>) {
  const parent = await fsp.mkdtemp(join(tmpdir(), "bundle-init-test-"));
  const neighbor = join(parent, "neighbor");
  const restores: Array<() => void> = [];
  const roots: string[] = [];
  const warnings: unknown[][] = [];
  const patch = (module: object, name: string, replacement: unknown) => {
    const record = module as Record<string, unknown>;
    const original = record[name];
    record[name] = replacement;
    restores.push(() => { record[name] = original; });
  };
  try {
    await fsp.mkdir(neighbor);
    await fsp.writeFile(join(neighbor, "sentinel"), "untouched");
    patch(mutableFs, "mkdtempSync", (prefix: string) => {
      const path = real.mkdtempSync(join(parent, basename(prefix)));
      roots.push(path);
      return path;
    });
    patch(console, "warn", (...args: unknown[]) => { warnings.push(args); });
    await run({ parent, neighbor, roots, warnings, patch, input: { cwd: parent, request: "request", submittedChanges: [], patch: "patch" } });
    assert.equal(await fsp.readFile(join(neighbor, "sentinel"), "utf8"), "untouched");
  } finally {
    for (const restore of restores.reverse()) restore();
    // All entries below this exclusive fixture parent are created by this test, including
    // deliberately substituted roots and preserved quarantine evidence. No prefix sweeping.
    await real.rm(parent, { recursive: true, force: true });
  }
}

function exchange(): ReviewExchangeContext {
  return { sequence: 1, startedAt: "test", endedAt: "test", workspaceChanges: [], sideEffectChanges: [], workspacePatch: "", sideEffectPatch: "", evidenceEvents: [], assistantSummaries: [], userRequests: [] };
}

for (const question of [false, true]) {
  test(`failed ${question ? "question" : "review"} invocation mkdir removes only its newly owned root`, async () => {
    await fixture(async ({ input, patch, roots, warnings }) => {
      const failure = new Error("invocation mkdir failed");
      patch(mutableFsp, "mkdir", async () => { throw failure; });
      await assert.rejects(question ? createReviewerQuestionBundle({ ...input, question: "why?" }) : createReviewBundle(input), (error) => error === failure);
      assert.equal(roots.length, 2, "bundle plus private cleanup directory");
      for (const root of roots) assert.equal(fs.existsSync(root), false);
      assert.equal(warnings.length, 0);
    });
  });
}

test("failure drains late artifact, current and exchange writes before removing the root", async () => {
  await fixture(async ({ input, patch, roots, warnings }) => {
    const gate = deferred();
    const allNestedStarted = deferred();
    const started = new Set<string>();
    let settled = 0;
    const failure = new Error("initial write failed");
    patch(mutableFsp, "mkdir", async (path: string, ...args: unknown[]) => {
      const kind = path.includes(join("artifacts", "submitted")) ? "artifact"
        : path.endsWith("current") ? "current" : path.includes(join("exchanges", "0001")) ? "exchange" : undefined;
      if (kind) {
        started.add(kind);
        if (started.size === 3) allNestedStarted.resolve();
        await gate.promise;
      }
      return (real.mkdir as Function)(path, ...args);
    });
    patch(mutableFsp, "writeFile", async (path: string, ...args: unknown[]) => {
      if (path.endsWith(join("reviews", "0001", "request.md"))) throw failure;
      await (real.writeFile as Function)(path, ...args);
      if (path.includes(join("artifacts", "submitted")) || path.includes(join("current", "")) || path.includes(join("exchanges", "0001"))) settled++;
    });
    const run = createReviewBundle({ ...input, exchanges: [exchange()], submittedChanges: [{ path: "late/file", status: "modified", binary: false, oversized: false, oldContent: "before", newContent: "after" }] });
    let finished = false;
    const observed = run.then(() => { finished = true; }, (error) => { finished = true; assert.equal(error, failure); });
    try {
      await within(allNestedStarted.promise);
      assert.equal(finished, false);
      assert.ok(fs.existsSync(roots[0]!));
      assert.equal(roots.length, 1, "cleanup cannot start while nested writes are outstanding");
    } finally {
      gate.resolve();
      await observed;
    }
    assert.ok(settled > 3);
    for (const root of roots) assert.equal(fs.existsSync(root), false);
    assert.equal(warnings.length, 0);
  });
});

test("a rejected nested artifact helper still drains its later sibling writes", async () => {
  await fixture(async ({ input, patch, roots }) => {
    const gate = deferred();
    const started = deferred();
    const failure = new Error("artifact failed");
    patch(mutableFsp, "writeFile", async (path: string, ...args: unknown[]) => {
      if (path.includes(join("submitted", "before"))) throw failure;
      if (path.includes(join("submitted", "after"))) { started.resolve(); await gate.promise; }
      return (real.writeFile as Function)(path, ...args);
    });
    let finished = false;
    const observed = createReviewBundle({ ...input, submittedChanges: [{ path: "late/file", status: "modified", binary: false, oversized: false, oldContent: "before", newContent: "after" }] })
      .then(() => assert.fail("expected failure"), (error) => { finished = true; assert.equal(error, failure); });
    try {
      await within(started.promise);
      assert.equal(finished, false);
      assert.equal(roots.length, 1);
    } finally { gate.resolve(); await observed; }
    for (const root of roots) assert.equal(fs.existsSync(root), false);
  });
});

test("synchronous nested artifact setup failure drains writes started before its array was returned", async () => {
  await fixture(async ({ input, patch, roots }) => {
    const gate = deferred();
    const setupFailed = deferred();
    const failure = new Error("nested content getter failed");
    let lateWriteCompleted = false;
    patch(mutableFsp, "mkdir", async (path: string, ...args: unknown[]) => {
      if (path.includes(join("submitted", "before"))) await gate.promise;
      return (real.mkdir as Function)(path, ...args);
    });
    patch(mutableFsp, "writeFile", async (path: string, ...args: unknown[]) => {
      await (real.writeFile as Function)(path, ...args);
      if (path.includes(join("submitted", "before"))) lateWriteCompleted = true;
    });
    const change = {
      path: "late/file", status: "modified" as const, binary: false, oversized: false,
      oldContent: "before",
      get newContent(): string { setupFailed.resolve(); throw failure; },
    };
    const observed = assert.rejects(createReviewBundle({ ...input, submittedChanges: [change] }), (error) => error === failure);
    try {
      await within(setupFailed.promise);
      assert.equal(lateWriteCompleted, false);
      assert.equal(roots.length, 1);
    } finally { gate.resolve(); await observed; }
    assert.equal(lateWriteCompleted, true);
    for (const root of roots) assert.equal(fs.existsSync(root), false);
  });
});

test("synchronous metadata serialization failure drains writes already started", async () => {
  await fixture(async ({ input, patch, roots }) => {
    const gate = deferred();
    const failure = new Error("toJSON failed");
    let writes = 0;
    patch(mutableFsp, "writeFile", async (path: string, ...args: unknown[]) => {
      await gate.promise;
      await (real.writeFile as Function)(path, ...args);
      writes++;
    });
    const setupFailed = deferred();
    const metadata = { toJSON() { setupFailed.resolve(); throw failure; } };
    let finished = false;
    const observed = createReviewBundle({ ...input, metadata }).then(() => assert.fail("expected failure"), (error) => { finished = true; assert.equal(error, failure); });
    try {
      // Allocation and invocation mkdir have completed once the metadata serializer is called.
      await within(setupFailed.promise);
      assert.equal(finished, false);
    } finally { gate.resolve(); await observed; }
    assert.equal(writes, 4);
    for (const root of roots) assert.equal(fs.existsSync(root), false);
  });
});

test("synchronously throwing write setup preserves that error and drains earlier writes", async () => {
  await fixture(async ({ input, patch, roots }) => {
    const gate = deferred();
    const started = deferred();
    const failure = new Error("synchronous write setup");
    let completed = false;
    patch(mutableFsp, "writeFile", (path: string, ...args: unknown[]) => {
      if (path.endsWith("changed-files.json")) { started.resolve(); throw failure; }
      return gate.promise.then(async () => { await (real.writeFile as Function)(path, ...args); completed = true; });
    });
    const observed = assert.rejects(createReviewBundle(input), (error) => error === failure);
    try { await within(started.promise); assert.equal(completed, false); assert.equal(roots.length, 1); }
    finally { gate.resolve(); await observed; }
    assert.equal(completed, true);
    for (const root of roots) assert.equal(fs.existsSync(root), false);
  });
});

for (const substitution of ["directory", "symlink", "identity-unknown", "capture-unknown", "handle-unknown"] as const) {
  test(`${substitution}: cleanup refuses unsafe ownership without masking initialization failure`, async () => {
    await fixture(async ({ input, patch, roots, parent, neighbor, warnings }) => {
      const failure = new Error("initialization failed");
      let savedRoot: string | undefined;
      let failLookup = substitution === "capture-unknown";
      patch(mutableFs, "lstatSync", (path: string, options: unknown) => {
        if (path === roots[0] && failLookup) throw new Error("identity lookup denied");
        return (real.lstatSync as Function)(path, options);
      });
      if (substitution === "handle-unknown") patch(mutableFs, "openSync", () => { throw new Error("directory handles unsupported"); });
      patch(mutableFsp, "mkdir", async () => {
        if (substitution === "directory" || substitution === "symlink") {
          savedRoot = join(parent, "original-root");
          real.renameSync(roots[0]!, savedRoot);
          if (substitution === "directory") {
            real.mkdirSync(roots[0]!);
            real.writeFileSync(join(roots[0]!, "foreign"), "preserve");
          } else fs.symlinkSync(neighbor, roots[0]!, "dir");
        }
        if (substitution === "identity-unknown") failLookup = true;
        throw failure;
      });
      await assert.rejects(createReviewBundle(input), (error) => error === failure);
      assert.equal(roots.length, 1, "refusal must precede allocating cleanup resources");
      assert.ok(warnings.length > 0);
      assert.ok(fs.existsSync(roots[0]!));
      if (savedRoot) assert.ok(fs.existsSync(savedRoot));
      if (substitution === "directory") assert.equal(await fsp.readFile(join(roots[0]!, "foreign"), "utf8"), "preserve");
      if (substitution === "symlink") assert.ok(fs.lstatSync(roots[0]!).isSymbolicLink());
    });
  });
}

test("zero inode is uncertain ownership, never deletion authority", async () => {
  await fixture(async ({ input, patch, roots, warnings }) => {
    patch(mutableFs, "lstatSync", (path: string, options: unknown) => {
      const stats = (real.lstatSync as Function)(path, options);
      if (path === roots[0]) stats.ino = 0n;
      return stats;
    });
    const failure = new Error("initialization failed");
    patch(mutableFsp, "mkdir", async () => { throw failure; });
    await assert.rejects(createReviewBundle(input), (error) => error === failure);
    assert.ok(fs.existsSync(roots[0]!));
    assert.equal(roots.length, 1);
    assert.ok(warnings.length);
  });
});

for (const substitution of ["directory", "symlink"] as const) {
  test(`${substitution} substitution at the rename boundary is preserved in quarantine, never deleted`, async () => {
    await fixture(async ({ input, patch, roots, parent, neighbor, warnings }) => {
      const failure = new Error("initialization failed");
      patch(mutableFsp, "mkdir", async () => { throw failure; });
      let relocated: string | undefined;
      patch(mutableFs, "renameSync", (from: string, to: string) => {
        real.renameSync(from, join(parent, "original-root"));
        if (substitution === "directory") {
          real.mkdirSync(from);
          real.writeFileSync(join(from, "foreign"), "preserve");
        } else fs.symlinkSync(neighbor, from, "dir");
        relocated = to;
        real.renameSync(from, to);
      });
      await assert.rejects(createReviewBundle(input), (error) => error === failure);
      if (substitution === "directory") assert.equal(await fsp.readFile(join(relocated!, "foreign"), "utf8"), "preserve");
      else assert.ok(fs.lstatSync(relocated!).isSymbolicLink());
      assert.ok(fs.existsSync(join(parent, "original-root")));
      assert.ok(fs.existsSync(roots[1]!));
      assert.ok(warnings.some((warning) => JSON.stringify(warning).includes(relocated!)));
    });
  });
}

for (const fault of ["rename", "remove", "absence-proof", "quarantine-identity", "moved-identity"] as const) {
  test(`${fault} cleanup failure is observable and preserves the original error`, async () => {
    await fixture(async ({ input, patch, roots, warnings }) => {
      const failure = Object.freeze(new Error("original initialization failure"));
      patch(mutableFsp, "mkdir", async () => { throw failure; });
      if (fault === "rename") patch(mutableFs, "renameSync", () => { throw new Error("rename denied"); });
      if (fault === "remove") patch(mutableFs, "rmSync", () => { throw new Error("cleanup denied"); });
      if (fault === "absence-proof") patch(mutableFs, "rmSync", () => {});
      if (fault === "quarantine-identity") patch(mutableFs, "lstatSync", (path: string, options: unknown) => {
        if (path === roots[1]) throw new Error("quarantine identity unavailable");
        return (real.lstatSync as Function)(path, options);
      });
      if (fault === "moved-identity") patch(mutableFs, "lstatSync", (path: string, options: unknown) => {
        if (path === join(roots[1] ?? "", "bundle")) throw new Error("moved root identity unavailable");
        return (real.lstatSync as Function)(path, options);
      });
      await assert.rejects(createReviewBundle(input), (error) => error === failure);
      assert.ok(warnings.length);
      const retained = fault === "remove" || fault === "absence-proof" || fault === "moved-identity" ? join(roots[1]!, "bundle") : roots[0]!;
      assert.ok(fs.existsSync(retained));
      assert.match(String(warnings[0]?.[0]), /unconfirmed/);
    });
  });
}

test("caller-owned root never enters failure cleanup", async () => {
  await fixture(async ({ input, patch, roots, neighbor, warnings }) => {
    const failure = new Error("caller initialization failed");
    patch(mutableFsp, "writeFile", async () => { throw failure; });
    await assert.rejects(createReviewBundle({ ...input, dir: neighbor }), (error) => error === failure);
    assert.ok(fs.existsSync(neighbor));
    assert.equal(roots.length, 0);
    assert.equal(warnings.length, 0);
  });
});

test("successful review/question initialization and transient retention are unchanged", async () => {
  await fixture(async ({ input, roots, warnings }) => {
    const review = await createReviewBundle(input);
    const question = await createReviewerQuestionBundle({ ...input, dir: review.dir, reviewSequence: 2, question: "why?" });
    assert.equal(question.dir, review.dir);
    assert.equal(await fsp.readFile(join(question.invocationDir, "question.md"), "utf8"), "why?");
    assert.equal(roots.length, 1);
    const window = { bundleDir: review.dir, retainBundleAfterClose: true };
    await removeTransientWindowBundle(window);
    assert.equal(window.bundleDir, review.dir);
    assert.ok(fs.existsSync(review.dir));
    window.retainBundleAfterClose = false;
    await removeTransientWindowBundle(window);
    assert.equal(window.bundleDir, undefined);
    assert.equal(fs.existsSync(review.dir), false);
    assert.equal(warnings.length, 0);
  });
});
