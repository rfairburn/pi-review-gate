import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

/** Run the compiled files' actual fixture hooks, not a second cleanup algorithm.
 * Renderer tests run separately; only the manager is inert here so setup faults
 * and overlapping invocations are deterministic and cannot launch workers. */
async function invocation(file: "collapsed" | "expanded", temporaryRoot: string, fault?: "write" | "restore" | "shutdown") {
  const filename = join(__dirname, `subtask-result-${file}.test.js`);
  const nativeRequire = createRequire(filename);
  const before: Array<() => Promise<void>> = [];
  const after: Array<() => Promise<void>> = [];
  const roots: string[] = [];
  let shutdowns = 0;
  class Manager {
    constructor(private input: { pi: { registerTool(tool: unknown): void } }) {}
    controller = { restore: async () => {
      if (fault === "restore") throw new Error("injected restore failure");
    } };
    sync() { this.input.pi.registerTool({ name: "SubtasksInspect", execute: async () => ({}) }); }
    async shutdown() {
      shutdowns += 1;
      if (fault === "shutdown") throw new Error("injected shutdown failure");
    }
  }
  runInNewContext(await fs.readFile(filename, "utf8"), {
    exports: {}, process,
    require: (id: string) => {
      if (id === "node:test") return {
        before: (hook: () => Promise<void>) => before.push(hook),
        after: (hook: () => Promise<void>) => after.push(hook),
        test: () => {},
      };
      if (id === "node:os") return { tmpdir: () => temporaryRoot };
      if (id === "node:fs/promises") return {
        ...fs,
        mkdtemp: async (prefix: string) => {
          const root = await fs.mkdtemp(prefix);
          roots.push(root);
          return root;
        },
        writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
          if (fault === "write") throw new Error("injected write failure");
          return fs.writeFile(...args);
        },
      };
      if (id === "../src/execution/tool") return { ExecutionToolManager: Manager };
      return nativeRequire(id);
    },
  }, { filename });
  return {
    roots,
    shutdowns: () => shutdowns,
    setup: async () => { for (const hook of before) await hook(); },
    teardown: async () => { for (const hook of after) await hook(); },
  };
}

for (const file of ["collapsed", "expanded"] as const) {
  test(`${file} fixture invocations do not delete another invocation's files`, async (t) => {
    const temporaryRoot = await fs.mkdtemp(join(tmpdir(), "render-fixture-ownership-"));
    t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
    // A foreign legacy-prefix fixture, created only inside this test-owned tree.
    const foreign = join(temporaryRoot, `subtask-${file}-`);
    await fs.mkdir(foreign);
    await fs.writeFile(join(foreign, "owner"), "another invocation");
    const first = await invocation(file, temporaryRoot);
    const second = await invocation(file, temporaryRoot);
    try {
      try {
        await first.setup();
        await second.setup();
        assert.ok(first.roots.every((root) => !second.roots.includes(root)));
      } finally {
        await first.teardown();
      }
      for (const root of first.roots) await assert.rejects(fs.stat(root), { code: "ENOENT" });
      for (const root of second.roots) assert.ok((await fs.stat(root)).isDirectory());
      assert.equal(await fs.readFile(join(foreign, "owner"), "utf8"), "another invocation");
    } finally {
      await second.teardown();
    }
    assert.deepEqual(await fs.readdir(temporaryRoot), [`subtask-${file}-`]);
  });
}

for (const fault of ["write", "restore", "shutdown"] as const) {
  test(`expanded fixture removes its actual root after ${fault} failure`, async (t) => {
    const temporaryRoot = await fs.mkdtemp(join(tmpdir(), "render-fixture-failure-"));
    t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
    const fixture = await invocation("expanded", temporaryRoot, fault);
    if (fault === "shutdown") await fixture.setup();
    else await assert.rejects(fixture.setup(), new RegExp(`injected ${fault} failure`));
    assert.equal(fixture.roots.length, 1, "the real setup must allocate its fixture");
    assert.ok((await fs.stat(fixture.roots[0])).isDirectory());
    if (fault === "shutdown") await assert.rejects(fixture.teardown(), /injected shutdown failure/);
    else await fixture.teardown();
    assert.equal(fixture.shutdowns(), fault === "write" ? 0 : 1);
    await assert.rejects(fs.stat(fixture.roots[0]), { code: "ENOENT" });
    assert.deepEqual(await fs.readdir(temporaryRoot), []);
  });
}
