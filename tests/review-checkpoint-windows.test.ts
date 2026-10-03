import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  captureReviewCheckpoint, loadReviewCheckpoint, compareReviewCheckpoints,
  advanceRawReviewCheckpoint, releaseReviewCheckpoint,
} from "../src/review-checkpoint";

const fsp = createRequire(__filename)("node:fs/promises");
const fault = (code: string) => Object.assign(new Error(`injected ${code}`), { code });

interface Plan {
  platform?: NodeJS.Platform;
  directorySync?: string;
  directoryOpen?: string;
  fileSync?: string;
  failDirectoryAt?: number;
  windowsDeviceMismatch?: boolean;
  pathDeviceId?: number;
  statFault?: "dev" | "ino" | "mode" | "size" | "mtimeMs" | "ctimeMs";
  statFaultAt?: number;
  pathDeviceChanges?: boolean;
}

// Wrap the production fs/promises binding, not a replacement checkpoint
// implementation. Directory handles are simulated on every host; file I/O,
// publication, reload, and cleanup use real disposable filesystem fixtures.
async function injected(plan: Plan, run: (events: string[]) => Promise<void>): Promise<void> {
  const realOpen = fsp.open;
  const realLstat = fsp.lstat;
  let samplePathStats = 0;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const events: string[] = [];
  let directories = 0;
  Object.defineProperty(process, "platform", { ...platform, value: plan.platform ?? "win32" });
  fsp.lstat = async (...args: any[]) => {
    const stat = await realLstat(...args);
    if (!stat.isFile() || !plan.windowsDeviceMismatch) return stat;
    if (basename(String(args[0])) === "sample.txt") samplePathStats++;
    stat.dev = plan.pathDeviceChanges && samplePathStats === 3 ? 1 : (plan.pathDeviceId ?? 0);
    return stat;
  };
  fsp.open = async (path: string, flags: string | number, mode?: number) => {
    if ((await realLstat(path).catch(() => undefined))?.isDirectory()) {
      const index = ++directories;
      events.push(`dir-open:${basename(path)}`);
      if (plan.directoryOpen) throw fault(plan.directoryOpen);
      return {
        sync: async () => {
          events.push(`dir-sync:${basename(path)}`);
          if (plan.directorySync && (!plan.failDirectoryAt || index === plan.failDirectoryAt)) throw fault(plan.directorySync);
        },
        close: async () => { events.push(`dir-close:${basename(path)}`); },
      };
    }
    const handle = await realOpen(path, flags, mode);
    if (flags !== "wx") {
      let stats = 0;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "stat") return async () => {
            const stat = await target.stat();
            if (plan.windowsDeviceMismatch) stat.dev = 123;
            if (plan.statFault && ++stats === (plan.statFaultAt ?? 1)) stat[plan.statFault] += 1;
            return stat;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
    return {
      writeFile: async (...args: any[]) => { events.push("file-write"); return handle.writeFile(...args); },
      sync: async () => {
        events.push("file-sync");
        if (plan.fileSync) throw fault(plan.fileSync);
        return handle.sync();
      },
      close: async () => { events.push("file-close"); return handle.close(); },
    };
  };
  try { await run(events); }
  finally {
    fsp.open = realOpen;
    fsp.lstat = realLstat;
    Object.defineProperty(process, "platform", platform);
  }
}

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "prg-windows-raw-"));
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  try { await run(root); }
  finally {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    await rm(root, { recursive: true, force: true });
  }
}

for (const failDirectoryAt of [undefined, 4]) {
  test(`mocked Windows raw baseline tolerates directory sync EPERM (${failDirectoryAt ?? "all flushes"})`, async () => fixture(async (root) => {
    await writeFile(join(root, "sample.txt"), "baseline bytes");
    await injected({ directorySync: "EPERM", failDirectoryAt, windowsDeviceMismatch: true }, async (events) => {
      const before = await captureReviewCheckpoint(root, "before");
      assert.equal(before.status, "ok", JSON.stringify(before));
      if (before.status !== "ok" || before.value.kind !== "raw") throw new Error("expected raw baseline");
      assert.equal((await loadReviewCheckpoint(root, before.value)).status, "ok");
      assert.deepEqual(events.filter((e) => e.startsWith("dir-sync:")), [
        "dir-sync:checkpoints", "dir-sync:.pi-review-gate", `dir-sync:${basename(root)}`,
        `dir-sync:before-${before.value.owner}`,
      ]);
      assert.equal(events.filter((e) => e.startsWith("dir-close:")).length, 4);
      assert.deepEqual(events.filter((e) => e.startsWith("file-")), ["file-write", "file-sync", "file-close"]);
      await writeFile(join(root, "sample.txt"), "frozen changed bytes");
      const after = await captureReviewCheckpoint(root, "after");
      assert.equal(after.status, "ok", JSON.stringify(after));
      if (after.status !== "ok") throw new Error("expected after checkpoint");
      await writeFile(join(root, "sample.txt"), "later live bytes");
      const compared = await compareReviewCheckpoints(root, before.value, after.value);
      assert.equal(compared.status, "ok", JSON.stringify(compared));
      if (compared.status !== "ok") throw new Error("expected frozen comparison");
      assert.deepEqual(compared.value.changes.map((c) => [c.path, c.old?.bytes?.toString(), c.new?.bytes?.toString()]),
        [["sample.txt", "baseline bytes", "frozen changed bytes"]]);
      const advanced = await advanceRawReviewCheckpoint(root, before.value, ["sample.txt"], "advanced");
      assert.equal(advanced.status, "ok", JSON.stringify(advanced));
      if (advanced.status !== "ok") throw new Error("expected advanced checkpoint");
      assert.equal((await loadReviewCheckpoint(root, advanced.value)).status, "ok");
      for (const descriptor of [before.value, after.value, advanced.value])
        assert.equal((await releaseReviewCheckpoint(root, descriptor)).status, "ok");
    });
  }));
}

for (const [label, plan, code] of [
  ["directory open EPERM", { directoryOpen: "EPERM" }, "EPERM"],
  ["directory sync EIO", { directorySync: "EIO" }, "EIO"],
  ["final directory sync EIO", { directorySync: "EIO", failDirectoryAt: 4 }, "EIO"],
  ["file sync EPERM", { directorySync: "EPERM", fileSync: "EPERM" }, "EPERM"],
  ["non-Windows directory sync EPERM", { platform: "linux", directorySync: "EPERM" }, "EPERM"],
] as const) {
  test(`mocked raw baseline still fails closed on ${label}`, async () => fixture(async (root) => {
    await writeFile(join(root, "sample.txt"), "unchanged");
    await injected(plan, async (events) => {
      const result = await captureReviewCheckpoint(root, "failure");
      assert.equal(result.status, "failed", JSON.stringify(result));
      if (result.status !== "failed") throw new Error("expected failure");
      assert.equal(result.reason, "raw_checkpoint_failed");
      assert.match(result.detail, new RegExp(`injected ${code}`));
      assert.deepEqual(await readdir(join(root, ".pi-review-gate", "checkpoints")), [], "failed arm removes only its owned scratch");
      assert.equal(await fsp.readFile(join(root, "sample.txt"), "utf8"), "unchanged");
      assert.equal(events.filter((e) => e.startsWith("dir-close:")).length,
        events.filter((e) => e.startsWith("dir-open:")).length - (plan.directoryOpen ? 1 : 0));
      if (plan.fileSync) assert.ok(events.includes("file-close"), "failed file flush still closes the file");
    });
  }));
}

for (const statFault of ["ino", "mode", "size", "mtimeMs", "ctimeMs"] as const) {
  for (const statFaultAt of [1, 2]) {
    test(`mocked Windows raw capture rejects ${statFault} drift at handle stat ${statFaultAt}`, async () => fixture(async (root) => {
      await writeFile(join(root, "sample.txt"), "baseline");
      await injected({ directorySync: "EPERM", windowsDeviceMismatch: true, statFault, statFaultAt }, async () => {
        const captured = await captureReviewCheckpoint(root, "race");
        assert.equal(captured.status, "failed", JSON.stringify(captured));
        if (captured.status !== "failed") throw new Error("expected race failure");
        assert.match(captured.detail ?? "", /file raced: sample.txt/);
        assert.deepEqual(await readdir(join(root, ".pi-review-gate", "checkpoints")), []);
      });
    }));
    test(`mocked Windows raw reload rejects ${statFault} drift at handle stat ${statFaultAt}`, async () => fixture(async (root) => {
      await writeFile(join(root, "sample.txt"), "baseline");
      let descriptor;
      await injected({ directorySync: "EPERM", windowsDeviceMismatch: true }, async () => {
        const captured = await captureReviewCheckpoint(root, "reload");
        if (captured.status !== "ok") throw new Error(JSON.stringify(captured));
        descriptor = captured.value;
      });
      if (!descriptor) throw new Error("missing descriptor");
      await injected({ windowsDeviceMismatch: true, statFault, statFaultAt }, async () => {
        const loaded = await loadReviewCheckpoint(root, descriptor!);
        assert.equal(loaded.status, "failed", JSON.stringify(loaded));
        if (loaded.status !== "failed") throw new Error("expected record race failure");
        assert.match(loaded.detail ?? "", /record raced/);
      });
    }));
  }
}

for (const plan of [
  { windowsDeviceMismatch: true, pathDeviceId: 123, statFault: "dev" },
  { windowsDeviceMismatch: true, pathDeviceChanges: true },
  { windowsDeviceMismatch: true, platform: "linux" },
] satisfies Plan[]) {
  test(`raw device normalization remains narrow: ${JSON.stringify(plan)}`, async () => fixture(async (root) => {
    await writeFile(join(root, "sample.txt"), "baseline");
    await injected({ directorySync: plan.platform === "linux" ? undefined : "EPERM", ...plan }, async () => {
      const captured = await captureReviewCheckpoint(root, "device-race");
      assert.equal(captured.status, "failed", JSON.stringify(captured));
      if (captured.status !== "failed") throw new Error("expected device race failure");
      assert.match(captured.detail ?? "", /(?:file|entry) raced: sample.txt/);
    });
  }));
}

test("native Windows raw checkpoint captures, reloads, compares and advances exact frozen bytes", { skip: process.platform !== "win32" }, async () => fixture(async (root) => {
  await writeFile(join(root, "sample.txt"), Buffer.from([0, 255, 42]));
  const before = await captureReviewCheckpoint(root, "native-before");
  assert.equal(before.status, "ok", JSON.stringify(before));
  if (before.status !== "ok" || before.value.kind !== "raw") throw new Error("expected raw baseline");
  assert.equal((await loadReviewCheckpoint(root, before.value)).status, "ok");
  for (const invalidRoot of ["relative", "C:relative", "\\relative"]) {
    const result = await loadReviewCheckpoint(root, { ...before.value, root: invalidRoot });
    assert.equal(result.status, "failed", "noncanonical/relative roots must not load");
  }
  await writeFile(join(root, "sample.txt"), "after bytes");
  const after = await captureReviewCheckpoint(root, "native-after");
  assert.equal(after.status, "ok", JSON.stringify(after));
  if (after.status !== "ok") throw new Error("expected after checkpoint");
  await writeFile(join(root, "sample.txt"), "later live bytes");
  const compared = await compareReviewCheckpoints(root, before.value, after.value);
  assert.equal(compared.status, "ok", JSON.stringify(compared));
  if (compared.status !== "ok") throw new Error("expected comparison");
  assert.deepEqual(compared.value.changes.map((c) => c.path), ["sample.txt"]);
  assert.deepEqual(compared.value.changes[0]?.old?.bytes, Buffer.from([0, 255, 42]));
  assert.equal(compared.value.changes[0]?.new?.bytes?.toString(), "after bytes");
  const advanced = await advanceRawReviewCheckpoint(root, before.value, ["sample.txt"], "native-advanced");
  assert.equal(advanced.status, "ok", JSON.stringify(advanced));
  if (advanced.status !== "ok") throw new Error("expected advancement");
  const loaded = await loadReviewCheckpoint(root, advanced.value);
  assert.equal(loaded.status, "ok", JSON.stringify(loaded));
  if (loaded.status !== "ok" || loaded.value.kind !== "raw") throw new Error("expected raw reload");
  assert.equal(Buffer.from(loaded.value.entries[0]!.contentB64!, "base64").toString(), "later live bytes");
  assert.equal((await loadReviewCheckpoint(root, { ...before.value, digest: "0".repeat(64) })).status, "failed");
  for (const descriptor of [before.value, after.value, advanced.value])
    assert.equal((await releaseReviewCheckpoint(root, descriptor)).status, "ok");
}));
