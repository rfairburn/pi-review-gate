import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { ExecutionAssociationsSnapshot } from "../src/session-state";
import {
  MAX_NATIVE_MANAGED_ASSOCIATIONS_BYTES,
  NATIVE_MANAGED_ASSOCIATIONS_DIRNAME,
  isValidNativeManagedAssociationOwner,
  nativeManagedAssociationPath,
  readNativeManagedAssociations,
  writeNativeManagedAssociations,
  type NativeManagedAssociationOwner,
} from "../src/session-host/native-managed-association-store";

/**
 * Focused hermetic tests for the native-owned managed association store
 * (Refs #682). Every state root is a fresh disposable directory under an owned
 * scratch root outside the checkout; nothing touches a real Pi agent directory.
 */

const SCRATCH_PARENT = realpathSync(tmpdir());
const POSIX = process.platform !== "win32";

function makeStateRoot(t: { after(fn: () => void): void }): string {
  // A private, disposable fixture directly under the canonical temp directory.
  const root = mkdtempSync(join(SCRATCH_PARENT, "prg-native-managed-association-store-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateRoot = join(root, "session-host");
  mkdirSync(stateRoot, { mode: 0o700 });
  return stateRoot;
}

const WORKSPACE = POSIX ? "/work/project" : "C:\\work\\project";

function owner(overrides: Partial<NativeManagedAssociationOwner> = {}): NativeManagedAssociationOwner {
  return {
    slotId: "slot-1",
    backend: "claude",
    conversationId: "0f8fad5b-d9cb-469f-a165-70867728950e",
    workspace: WORKSPACE,
    ...overrides,
  };
}

function associations(tag = "a"): ExecutionAssociationsSnapshot {
  return {
    waveRoots: [`/waves/${tag}`, `/waves/${tag}`],
    bundles: [{ version: 1, operationId: `op-${tag}`, waveId: `wave-${tag}`, taskId: `task-${tag}`, waveRoot: `/waves/${tag}`, expectedRevision: 3 }],
    groupRoots: [`/groups/${tag}`],
    conflictGates: [{
      executionId: `exec-${tag}`, taskId: `task-${tag}`, sourceRoot: "/src", paths: ["a.ts"],
      activatedAt: "2026-01-01T00:00:00.000Z", manifestPath: "/m.json", reason: "conflict",
      sidecars: [{ path: "a.ts", sidecarPath: "/side/a.ts" }, { path: "b.ts" }],
    }],
  };
}

function expectedLoaded(tag = "a"): ExecutionAssociationsSnapshot {
  const value = associations(tag);
  return { ...value, waveRoots: [`/waves/${tag}`] };
}

function storeEntries(stateRoot: string): string[] {
  const dir = join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

async function seed(stateRoot: string, who = owner(), tag = "a"): Promise<string> {
  const result = await writeNativeManagedAssociations(stateRoot, who, associations(tag));
  assert.equal(result.status, "published");
  return nativeManagedAssociationPath(stateRoot, who);
}

test("absent store and absent owner file are truly absent and create nothing", async (t) => {
  const stateRoot = makeStateRoot(t);
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()), { status: "absent" });
  assert.equal(existsSync(join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME)), false);
  mkdirSync(join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME));
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()), { status: "absent" });
});

test("exact owner save and reopen round-trips a detached normalized snapshot with increasing revisions", async (t) => {
  const stateRoot = makeStateRoot(t);
  const first = await writeNativeManagedAssociations(stateRoot, owner(), associations("a"));
  assert.deepEqual(first, { status: "published", revision: 1 });
  const loaded = await readNativeManagedAssociations(stateRoot, owner());
  assert.deepEqual(loaded, { status: "loaded", revision: 1, associations: expectedLoaded("a") });

  // A fresh equal owner object (new identity, same values) reopens the same file.
  const second = await writeNativeManagedAssociations(stateRoot, { ...owner() }, associations("b"));
  assert.deepEqual(second, { status: "published", revision: 2 });
  const reopened = await readNativeManagedAssociations(stateRoot, owner());
  assert.deepEqual(reopened, { status: "loaded", revision: 2, associations: expectedLoaded("b") });

  // The loaded value is detached from any later mutation.
  if (reopened.status === "loaded") reopened.associations.waveRoots.push("/mutated");
  const again = await readNativeManagedAssociations(stateRoot, owner());
  assert.equal(again.status === "loaded" && again.associations.waveRoots.includes("/mutated"), false);

  // Only the owner document remains: no temp siblings.
  const path = nativeManagedAssociationPath(stateRoot, owner());
  assert.deepEqual(storeEntries(stateRoot), [path.slice(dirname(path).length + 1)]);
  if (POSIX) {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
  }
});

test("unknown input keys are dropped and the empty snapshot round-trips", async (t) => {
  const stateRoot = makeStateRoot(t);
  const extra = { ...associations("a"), injected: "x", bundles: [{ ...associations("a").bundles[0]!, extra: 1 }] } as unknown as ExecutionAssociationsSnapshot;
  assert.equal((await writeNativeManagedAssociations(stateRoot, owner(), extra)).status, "published");
  const text = readFileSync(nativeManagedAssociationPath(stateRoot, owner()), "utf8");
  assert.equal(text.includes("injected"), false);
  assert.equal(text.includes("\"extra\""), false);
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()),
    { status: "loaded", revision: 1, associations: expectedLoaded("a") });

  const other = owner({ slotId: "slot-empty" });
  assert.equal((await writeNativeManagedAssociations(stateRoot, other, { waveRoots: [], bundles: [] })).status, "published");
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, other),
    { status: "loaded", revision: 1, associations: { waveRoots: [], bundles: [] } });
});

test("a different conversation in the same slot never loads or replaces prior associations", async (t) => {
  const stateRoot = makeStateRoot(t);
  const original = owner();
  const originalPath = await seed(stateRoot, original, "a");
  const before = readFileSync(originalPath);

  const variants: NativeManagedAssociationOwner[] = [
    owner({ conversationId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" }),
    // Exact spelling is identity: a case variant is a different owner key.
    owner({ conversationId: original.conversationId.toUpperCase() }),
    owner({ backend: "codex" }),
    owner({ workspace: POSIX ? "/work/other" : "C:\\work\\other" }),
    owner({ slotId: "slot-2" }),
  ];
  for (const variant of variants) {
    assert.deepEqual(await readNativeManagedAssociations(stateRoot, variant), { status: "absent" }, JSON.stringify(variant));
    assert.notEqual(nativeManagedAssociationPath(stateRoot, variant), originalPath);
  }
  const next = variants[0]!;
  assert.deepEqual(await writeNativeManagedAssociations(stateRoot, next, associations("n")), { status: "published", revision: 1 });
  assert.deepEqual(readFileSync(originalPath), before);
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, original),
    { status: "loaded", revision: 1, associations: expectedLoaded("a") });
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, next),
    { status: "loaded", revision: 1, associations: expectedLoaded("n") });
});

test("a foreign owner's document at this owner's path is owner-mismatch, never adopted or overwritten", async (t) => {
  const stateRoot = makeStateRoot(t);
  const foreign = owner({ conversationId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" });
  const foreignPath = await seed(stateRoot, foreign, "f");
  const targetPath = nativeManagedAssociationPath(stateRoot, owner());
  writeFileSync(targetPath, readFileSync(foreignPath));
  const bytes = readFileSync(targetPath);

  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()), { status: "unavailable", reason: "owner-mismatch" });
  assert.deepEqual(await writeNativeManagedAssociations(stateRoot, owner(), associations("a")),
    { status: "refused", reason: "owner-mismatch" });
  assert.deepEqual(readFileSync(targetPath), bytes);
});

test("malformed, unsupported, tampered and oversized documents are unavailable and preserved", async (t) => {
  const stateRoot = makeStateRoot(t);
  const path = await seed(stateRoot, owner(), "a");
  const valid = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
  const cases: Array<[string, string | Buffer, string]> = [
    ["not json", "{not json", "malformed"],
    ["array", "[]", "malformed"],
    ["wrong format", JSON.stringify({ ...valid, format: "other" }), "malformed"],
    ["future version", JSON.stringify({ ...valid, version: 2 }), "unsupported-version"],
    ["extra top-level key", JSON.stringify({ ...valid, extra: true }), "malformed"],
    ["missing integrity", JSON.stringify({ ...valid, integritySha256: undefined }), "malformed"],
    ["bad revision", JSON.stringify({ ...valid, revision: 0 }), "malformed"],
    ["bad owner", JSON.stringify({ ...valid, owner: { ...valid.owner, conversationId: "latest" } }), "malformed"],
    ["bad bundle", JSON.stringify({ ...valid, associations: { ...valid.associations, bundles: [{ version: 2 }] } }), "malformed"],
    ["unknown association key", JSON.stringify({ ...valid, associations: { ...valid.associations, extra: [] } }), "malformed"],
    ["tampered associations", JSON.stringify({ ...valid, associations: { ...valid.associations, waveRoots: ["/evil"] } }), "integrity-mismatch"],
    ["tampered revision", JSON.stringify({ ...valid, revision: 99 }), "integrity-mismatch"],
    ["leading UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(valid))]), "malformed"],
    ["truncated publication", readFileSync(path, "utf8").slice(0, 40), "malformed"],
    ["invalid utf-8", Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), "malformed"],
    ["oversized", Buffer.alloc(MAX_NATIVE_MANAGED_ASSOCIATIONS_BYTES + 1, 0x20), "oversized"],
  ];
  for (const [label, body, reason] of cases) {
    writeFileSync(path, body);
    const bytes = readFileSync(path);
    assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()), { status: "unavailable", reason }, label);
    assert.deepEqual(await writeNativeManagedAssociations(stateRoot, owner(), associations("b")),
      { status: "refused", reason }, label);
    assert.deepEqual(readFileSync(path), bytes, label);
    assert.equal(storeEntries(stateRoot).length, 1, label);
  }
});

test("invalid owner keys are refused before any filesystem effect", async (t) => {
  const stateRoot = makeStateRoot(t);
  const invalid: unknown[] = [
    undefined,
    { ...owner(), extra: 1 },
    owner({ slotId: "" }),
    owner({ slotId: "a\nb" }),
    owner({ slotId: "x".repeat(129) }),
    owner({ backend: "pi" as never }),
    owner({ backend: "gemini" as never }),
    owner({ conversationId: "latest" }),
    owner({ conversationId: "{0f8fad5b-d9cb-469f-a165-70867728950e}" }),
    owner({ conversationId: " 0f8fad5b-d9cb-469f-a165-70867728950e" }),
    owner({ workspace: "relative/project" }),
    owner({ workspace: POSIX ? "/work/../work/project" : "C:\\work\\..\\work\\project" }),
    owner({ workspace: POSIX ? "/work/project/" : "C:\\work\\project\\" }),
    owner({ workspace: `${WORKSPACE}\u0000` }),
    owner({ workspace: "" }),
  ];
  for (const candidate of invalid) {
    assert.equal(isValidNativeManagedAssociationOwner(candidate), false, JSON.stringify(candidate));
    const who = candidate as NativeManagedAssociationOwner;
    assert.deepEqual(await readNativeManagedAssociations(stateRoot, who), { status: "unavailable", reason: "invalid-owner" });
    assert.deepEqual(await writeNativeManagedAssociations(stateRoot, who, associations()), { status: "refused", reason: "invalid-owner" });
  }
  assert.equal(isValidNativeManagedAssociationOwner(owner()), true);
  assert.equal(existsSync(join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME)), false);
});

test("untrusted state roots are refused and never created or followed", async (t) => {
  const stateRoot = makeStateRoot(t);
  const parent = dirname(stateRoot);
  const file = join(parent, "plain-file");
  writeFileSync(file, "x");
  const roots = [
    "",
    "relative/state",
    join(parent, "missing"),
    file,
    `${stateRoot}${POSIX ? "/" : "\\"}..${POSIX ? "/" : "\\"}session-host`,
  ];
  if (POSIX) {
    const link = join(parent, "linked-state");
    symlinkSync(stateRoot, link);
    roots.push(link);
  }
  for (const root of roots) {
    assert.deepEqual(await readNativeManagedAssociations(root, owner()), { status: "unavailable", reason: "invalid-state-root" }, root);
    assert.deepEqual(await writeNativeManagedAssociations(root, owner(), associations()), { status: "refused", reason: "invalid-state-root" }, root);
  }
  assert.equal(existsSync(join(parent, "missing")), false);
  assert.equal(existsSync(join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME)), false);
});

test("invalid or oversized association input is refused and writes nothing", async (t) => {
  const stateRoot = makeStateRoot(t);
  const bad: unknown[] = [
    undefined,
    { bundles: [] },
    { waveRoots: [1], bundles: [] },
    { waveRoots: [], bundles: [{ version: 1, operationId: "o", waveId: "w", taskId: "t", waveRoot: "/r", expectedRevision: 1.5 }] },
    { waveRoots: [], bundles: [], groupRoots: "x" },
    { waveRoots: [], bundles: [], conflictGates: [{ executionId: "e" }] },
    { waveRoots: [], bundles: [], conflictGate: { ...associations().conflictGates![0]!, sidecars: [{ path: "a", sidecarPath: 1 }] } },
  ];
  for (const value of bad) {
    assert.deepEqual(await writeNativeManagedAssociations(stateRoot, owner(), value as ExecutionAssociationsSnapshot),
      { status: "refused", reason: "invalid-associations" }, JSON.stringify(value));
  }
  const huge: ExecutionAssociationsSnapshot = {
    waveRoots: Array.from({ length: 200 }, (_, index) => `/waves/${index}/${"x".repeat(2000)}`),
    bundles: [],
  };
  assert.deepEqual(await writeNativeManagedAssociations(stateRoot, owner(), huge), { status: "refused", reason: "oversized" });
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()), { status: "absent" });
  assert.deepEqual(storeEntries(stateRoot), []);
});

test("unsafe entries at the owner path or store directory are refused without following them", async (t) => {
  const stateRoot = makeStateRoot(t);
  const path = nativeManagedAssociationPath(stateRoot, owner());

  // A directory in place of the owner file.
  mkdirSync(path, { recursive: true });
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()), { status: "unavailable", reason: "unsafe-path" });
  assert.deepEqual(await writeNativeManagedAssociations(stateRoot, owner(), associations()), { status: "refused", reason: "unsafe-path" });
  assert.equal(lstatSync(path).isDirectory(), true);
  rmSync(path, { recursive: true });

  if (!POSIX) return;
  // A symlink to an otherwise valid document of the same owner is never followed.
  const elsewhere = makeStateRoot(t);
  const real = await seed(elsewhere, owner(), "a");
  symlinkSync(real, path);
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()), { status: "unavailable", reason: "unsafe-path" });
  assert.deepEqual(await writeNativeManagedAssociations(stateRoot, owner(), associations("b")), { status: "refused", reason: "unsafe-path" });
  assert.equal(lstatSync(path).isSymbolicLink(), true);
  assert.deepEqual(await readNativeManagedAssociations(elsewhere, owner()),
    { status: "loaded", revision: 1, associations: expectedLoaded("a") });
  unlinkSync(path);

  // A FIFO is refused before any (blocking) open.
  const mkfifo = spawnSync("mkfifo", [path]);
  if (mkfifo.status === 0) {
    assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()), { status: "unavailable", reason: "unsafe-path" });
    assert.deepEqual(await writeNativeManagedAssociations(stateRoot, owner(), associations()), { status: "refused", reason: "unsafe-path" });
    unlinkSync(path);
  }

  // A symlinked store directory is refused, and the target is never written.
  const dir = join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME);
  rmSync(dir, { recursive: true });
  const target = join(dirname(stateRoot), "redirected");
  mkdirSync(target);
  symlinkSync(target, dir);
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()), { status: "unavailable", reason: "unsafe-path" });
  assert.deepEqual(await writeNativeManagedAssociations(stateRoot, owner(), associations()), { status: "refused", reason: "unsafe-path" });
  assert.deepEqual(readdirSync(target), []);
});

test("a failure before commit reports failed, removes only its own temp file, and keeps the prior document", async (t) => {
  const stateRoot = makeStateRoot(t);
  const path = await seed(stateRoot, owner(), "a");
  const bytes = readFileSync(path);
  const foreignTemp = `${path}.tmp.someone-else`;
  writeFileSync(foreignTemp, "other writer");
  let observedTemp = "";
  const result = await writeNativeManagedAssociations(stateRoot, owner(), associations("b"), {
    beforeCommit: (temporary) => {
      observedTemp = temporary;
      assert.equal(existsSync(temporary), true);
      throw new Error("simulated crash before commit");
    },
  });
  assert.deepEqual(result, { status: "failed", reason: "publication-failed" });
  assert.equal(existsSync(observedTemp), false);
  assert.equal(readFileSync(foreignTemp, "utf8"), "other writer");
  assert.deepEqual(readFileSync(path), bytes);
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()),
    { status: "loaded", revision: 1, associations: expectedLoaded("a") });

  // A failed first publication leaves the owner truly absent.
  const fresh = owner({ slotId: "slot-fresh" });
  const failed = await writeNativeManagedAssociations(stateRoot, fresh, associations("c"), {
    beforeCommit: () => { throw new Error("simulated"); },
  });
  assert.deepEqual(failed, { status: "failed", reason: "publication-failed" });
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, fresh), { status: "absent" });
  // The next ordinary save still succeeds from the intact prior state.
  assert.deepEqual(await writeNativeManagedAssociations(stateRoot, owner(), associations("d")), { status: "published", revision: 2 });
});

test("a target replaced between validation and commit is never overwritten", async (t) => {
  const stateRoot = makeStateRoot(t);
  const path = await seed(stateRoot, owner(), "a");

  // Replaced by another regular file (even a valid same-owner copy): new identity refuses.
  const replacement = readFileSync(path);
  let temp = "";
  const swapped = await writeNativeManagedAssociations(stateRoot, owner(), associations("b"), {
    beforeCommit: (temporary) => {
      temp = temporary;
      const staged = `${path}.swap`;
      writeFileSync(staged, replacement);
      renameSync(staged, path);
    },
  });
  assert.deepEqual(swapped, { status: "refused", reason: "unsafe-path" });
  assert.equal(existsSync(temp), false);
  assert.deepEqual(readFileSync(path), replacement);

  // Created where the owner was absent.
  const fresh = owner({ slotId: "slot-fresh" });
  const freshPath = nativeManagedAssociationPath(stateRoot, fresh);
  const created = await writeNativeManagedAssociations(stateRoot, fresh, associations("c"), {
    beforeCommit: () => writeFileSync(freshPath, "foreign"),
  });
  assert.deepEqual(created, { status: "refused", reason: "unsafe-path" });
  assert.equal(readFileSync(freshPath, "utf8"), "foreign");

  // Removed after validation: the validated document is gone, so nothing is resurrected over it.
  const removed = await writeNativeManagedAssociations(stateRoot, owner(), associations("d"), {
    beforeCommit: () => unlinkSync(path),
  });
  assert.deepEqual(removed, { status: "refused", reason: "unsafe-path" });
  assert.equal(existsSync(path), false);

  if (POSIX) {
    const other = owner({ slotId: "slot-link" });
    const otherPath = await seed(stateRoot, other, "e");
    const outside = join(dirname(stateRoot), "outside.json");
    writeFileSync(outside, "outside");
    const linked = await writeNativeManagedAssociations(stateRoot, other, associations("f"), {
      beforeCommit: () => { unlinkSync(otherPath); symlinkSync(outside, otherPath); },
    });
    assert.deepEqual(linked, { status: "refused", reason: "unsafe-path" });
    assert.equal(lstatSync(otherPath).isSymbolicLink(), true);
    assert.equal(readFileSync(outside, "utf8"), "outside");
  }
  assert.equal(storeEntries(stateRoot).some((entry) => entry.includes(".tmp.")), false);
});

test("a target rewritten in place before commit keeps its new bytes and refuses the save", async (t) => {
  const stateRoot = makeStateRoot(t);
  const path = await seed(stateRoot, owner(), "a");
  const foreignPath = await seed(stateRoot, owner({ slotId: "slot-foreign" }), "f");
  const rewrites: Array<[string, () => string | Buffer]> = [
    ["malformed", () => "garbage"],
    ["foreign owner document", () => readFileSync(foreignPath)],
    ["same length different bytes", () => readFileSync(path, "utf8").replace("/waves/a", "/waves/z")],
    ["prepended UTF-8 BOM", () => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(path)])],
  ];
  for (const [label, next] of rewrites) {
    const inode = statSync(path).ino;
    const replacement = next();
    const result = await writeNativeManagedAssociations(stateRoot, owner(), associations("b"), {
      // writeFileSync truncates and rewrites the same inode.
      beforeCommit: () => writeFileSync(path, replacement),
    });
    assert.deepEqual(result, { status: "refused", reason: "unsafe-path" }, label);
    assert.equal(statSync(path).ino, inode, label);
    assert.deepEqual(readFileSync(path), Buffer.from(replacement), label);
    // Restore a valid document for the next case.
    unlinkSync(path);
    await seed(stateRoot, owner(), "a");
  }
  assert.equal(storeEntries(stateRoot).some((entry) => entry.includes(".tmp.")), false);
});

test("a replaced or rewritten staging file is never published and a foreign staging entry is never removed", async (t) => {
  const stateRoot = makeStateRoot(t);
  const path = await seed(stateRoot, owner(), "a");
  const before = readFileSync(path);

  // Replaced by another file (new inode) at the staging name.
  let temp = "";
  const replaced = await writeNativeManagedAssociations(stateRoot, owner(), associations("b"), {
    beforeCommit: (temporary) => {
      temp = temporary;
      const impostor = `${temporary}.impostor`;
      writeFileSync(impostor, readFileSync(temporary));
      renameSync(impostor, temporary);
    },
  });
  assert.deepEqual(replaced, { status: "refused", reason: "unsafe-path" });
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(temp), true, "the foreign staging entry is left untouched");
  unlinkSync(temp);

  // Rewritten in place (same inode, this call's file) with unvalidated bytes.
  const rewritten = await writeNativeManagedAssociations(stateRoot, owner(), associations("c"), {
    beforeCommit: (temporary) => {
      temp = temporary;
      writeFileSync(temporary, readFileSync(temporary, "utf8").replace("/waves/c", "/waves/x"));
    },
  });
  assert.deepEqual(rewritten, { status: "refused", reason: "unsafe-path" });
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(temp), false, "this call's own staging file is removed");

  // Rewritten in place with the written bytes behind a UTF-8 BOM.
  const prefixed = await writeNativeManagedAssociations(stateRoot, owner(), associations("c"), {
    beforeCommit: (temporary) => {
      temp = temporary;
      writeFileSync(temporary, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(temporary)]));
    },
  });
  assert.deepEqual(prefixed, { status: "refused", reason: "unsafe-path" });
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(temp), false, "this call's own staging file is removed");

  // Removed before commit.
  const removed = await writeNativeManagedAssociations(stateRoot, owner(), associations("d"), {
    beforeCommit: (temporary) => unlinkSync(temporary),
  });
  assert.deepEqual(removed, { status: "refused", reason: "unsafe-path" });
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()),
    { status: "loaded", revision: 1, associations: expectedLoaded("a") });
  assert.equal(storeEntries(stateRoot).some((entry) => entry.includes(".tmp.")), false);
});

test("staging or target entries changed after the byte comparisons are never published or overwritten", async (t) => {
  const stateRoot = makeStateRoot(t);
  const path = await seed(stateRoot, owner(), "a");
  const before = readFileSync(path);

  // Staging replaced by another file after its bytes were checked.
  let temporary = "";
  const stagingSwap = await writeNativeManagedAssociations(stateRoot, owner(), associations("b"), {
    afterCommitReads: (staged) => {
      temporary = staged;
      writeFileSync(`${staged}.replacement`, "not a snapshot");
      renameSync(`${staged}.replacement`, staged);
    },
  });
  assert.deepEqual(stagingSwap, { status: "refused", reason: "unsafe-path" });
  assert.deepEqual(readFileSync(path), before);
  assert.equal(readFileSync(temporary, "utf8"), "not a snapshot", "the replacement is left untouched");
  unlinkSync(temporary);

  // Staging rewritten in place (same inode) after its bytes were checked.
  const stagingRewrite = await writeNativeManagedAssociations(stateRoot, owner(), associations("c"), {
    afterCommitReads: (staged) => { temporary = staged; writeFileSync(staged, "rewritten"); },
  });
  assert.deepEqual(stagingRewrite, { status: "refused", reason: "unsafe-path" });
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(temporary), false, "this call's own staging file is removed");

  // Target replaced by another file after its bytes were checked.
  const replacement = Buffer.from("foreign replacement");
  const targetSwap = await writeNativeManagedAssociations(stateRoot, owner(), associations("d"), {
    afterCommitReads: () => {
      writeFileSync(`${path}.swap`, replacement);
      renameSync(`${path}.swap`, path);
    },
  });
  assert.deepEqual(targetSwap, { status: "refused", reason: "unsafe-path" });
  assert.deepEqual(readFileSync(path), replacement);

  // Target rewritten in place (same inode, different size) after its bytes were checked.
  unlinkSync(path);
  const reseeded = await seed(stateRoot, owner(), "a");
  const inode = statSync(reseeded).ino;
  const targetRewrite = await writeNativeManagedAssociations(stateRoot, owner(), associations("e"), {
    afterCommitReads: () => writeFileSync(reseeded, "garbage"),
  });
  assert.deepEqual(targetRewrite, { status: "refused", reason: "unsafe-path" });
  assert.equal(statSync(reseeded).ino, inode);
  assert.equal(readFileSync(reseeded, "utf8"), "garbage");

  // Target created where it was validated absent.
  const fresh = owner({ slotId: "slot-fresh" });
  const freshPath = nativeManagedAssociationPath(stateRoot, fresh);
  const created = await writeNativeManagedAssociations(stateRoot, fresh, associations("f"), {
    afterCommitReads: () => writeFileSync(freshPath, "foreign"),
  });
  assert.deepEqual(created, { status: "refused", reason: "unsafe-path" });
  assert.equal(readFileSync(freshPath, "utf8"), "foreign");

  // Store directory replaced after the byte comparisons.
  const dir = join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME);
  unlinkSync(freshPath);
  unlinkSync(reseeded);
  const valid = await seed(stateRoot, owner(), "a");
  const validBytes = readFileSync(valid);
  const moved = join(stateRoot, "moved-late");
  const dirSwap = await writeNativeManagedAssociations(stateRoot, owner(), associations("g"), {
    afterCommitReads: () => { renameSync(dir, moved); mkdirSync(dir); },
  });
  assert.deepEqual(dirSwap, { status: "refused", reason: "unsafe-path" });
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(readFileSync(join(moved, valid.slice(dir.length + 1))), validBytes);
});

test("a store directory or state root replaced before staging never receives snapshot bytes", async (t) => {
  const stateRoot = makeStateRoot(t);
  const path = await seed(stateRoot, owner(), "a");
  const before = readFileSync(path);
  const dir = dirname(path);
  const fileName = path.slice(dir.length + 1);
  const moved = join(stateRoot, "moved-before-staging");
  const result = await writeNativeManagedAssociations(stateRoot, owner(), associations("b"), {
    beforeStaging: () => { renameSync(dir, moved); mkdirSync(dir); },
  });
  assert.deepEqual(result, { status: "refused", reason: "unsafe-path" });
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(readdirSync(moved), [fileName]);
  assert.deepEqual(readFileSync(join(moved, fileName)), before);
  rmSync(dir, { recursive: true });
  renameSync(moved, dir);

  const movedRoot = `${stateRoot}-moved-before-staging`;
  const rootSwap = await writeNativeManagedAssociations(stateRoot, owner(), associations("c"), {
    beforeStaging: () => { renameSync(stateRoot, movedRoot); mkdirSync(join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME), { recursive: true }); },
  });
  assert.deepEqual(rootSwap, { status: "refused", reason: "unsafe-path" });
  assert.deepEqual(readdirSync(join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME)), []);
  assert.deepEqual(readdirSync(join(movedRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME)), [fileName]);
  assert.deepEqual(readFileSync(join(movedRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME, fileName)), before);
});

test("the post-commit directory sync only touches the verified directory and never fails a committed save", async (t) => {
  const stateRoot = makeStateRoot(t);
  const dir = join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME);

  // Control: an undisturbed save reaches the verified directory sync (where the platform allows it).
  let synced: boolean | undefined;
  const control = await writeNativeManagedAssociations(stateRoot, owner(), associations("a"), {
    afterDirectorySync: (value) => { synced = value; },
  });
  assert.deepEqual(control, { status: "published", revision: 1 });
  assert.equal(typeof synced, "boolean");
  // Directory fsync is best-effort: probe the actual scratch filesystem and
  // require a positive sync only where it permits one.
  let canSyncDirectory = false;
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
      canSyncDirectory = true;
    } finally {
      closeSync(fd);
    }
  } catch {
    // This filesystem refuses directory open or fsync; the commit is still valid.
  }
  if (canSyncDirectory) assert.equal(synced, true);
  const path = nativeManagedAssociationPath(stateRoot, owner());
  const fileName = path.slice(dir.length + 1);

  // The directory is replaced by another real directory right after the rename.
  const moved = join(stateRoot, "moved-after-rename");
  synced = undefined;
  const swapped = await writeNativeManagedAssociations(stateRoot, owner(), associations("b"), {
    afterRename: () => { renameSync(dir, moved); mkdirSync(dir); },
    afterDirectorySync: (value) => { synced = value; },
  });
  assert.deepEqual(swapped, { status: "published", revision: 2 });
  assert.equal(synced, false, "the replacement directory is not synced");
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true });
  renameSync(moved, dir);
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()),
    { status: "loaded", revision: 2, associations: expectedLoaded("b") });

  // A hook failure after the rename cannot turn the committed save into a failure.
  const thrown = await writeNativeManagedAssociations(stateRoot, owner(), associations("c"), {
    afterRename: () => { throw new Error("simulated post-commit failure"); },
  });
  assert.deepEqual(thrown, { status: "published", revision: 3 });

  if (!POSIX) return;
  // The directory is replaced by a symlink to another directory: never followed for sync.
  const elsewhere = join(stateRoot, "elsewhere");
  mkdirSync(elsewhere);
  synced = undefined;
  const linked = await writeNativeManagedAssociations(stateRoot, owner(), associations("d"), {
    afterRename: () => { renameSync(dir, moved); symlinkSync(elsewhere, dir); },
    afterDirectorySync: (value) => { synced = value; },
  });
  assert.deepEqual(linked, { status: "published", revision: 4 });
  assert.equal(synced, false, "a symlinked replacement is not followed for sync");
  assert.deepEqual(readdirSync(elsewhere), []);
  assert.deepEqual(readdirSync(moved), [fileName]);
});

test("a replaced store directory before commit refuses without publishing or deleting anything", async (t) => {
  const stateRoot = makeStateRoot(t);
  const path = await seed(stateRoot, owner(), "a");
  const before = readFileSync(path);
  const dir = join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME);
  const moved = join(stateRoot, "moved-away");
  let tempName = "";
  const result = await writeNativeManagedAssociations(stateRoot, owner(), associations("b"), {
    beforeCommit: (temporary) => {
      tempName = temporary.slice(dir.length + 1);
      renameSync(dir, moved);
      mkdirSync(dir);
    },
  });
  assert.deepEqual(result, { status: "refused", reason: "unsafe-path" });
  assert.deepEqual(readdirSync(dir), [], "nothing is published into the replacement directory");
  // The original directory and its contents are untouched, including the
  // staging file, which can no longer be verified in its original location.
  assert.deepEqual(readFileSync(join(moved, path.slice(dir.length + 1))), before);
  assert.equal(existsSync(join(moved, tempName)), true);
});

test("a store directory or state root replaced during a read is unavailable, never absent or adopted", async (t) => {
  const stateRoot = makeStateRoot(t);
  const path = await seed(stateRoot, owner(), "a");
  const before = readFileSync(path);
  const dir = join(stateRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME);
  const fileName = path.slice(dir.length + 1);

  // Populated directory swapped for an empty real directory before the file lookup.
  const moved = join(stateRoot, "moved-away");
  const emptied = await readNativeManagedAssociations(stateRoot, owner(), {
    beforeFileLookup: () => { renameSync(dir, moved); mkdirSync(dir); },
  });
  assert.deepEqual(emptied, { status: "unavailable", reason: "changed-while-reading" });
  assert.deepEqual(readFileSync(join(moved, fileName)), before);
  rmSync(dir, { recursive: true });
  renameSync(moved, dir);

  // Swapped for a directory holding a valid same-owner document with other associations.
  const decoyRoot = makeStateRoot(t);
  const decoyPath = await seed(decoyRoot, owner(), "z");
  const decoyDir = dirname(decoyPath);
  const adopted = await readNativeManagedAssociations(stateRoot, owner(), {
    beforeFileLookup: () => { renameSync(dir, moved); renameSync(decoyDir, dir); },
  });
  assert.deepEqual(adopted, { status: "unavailable", reason: "changed-while-reading" });
  assert.deepEqual(readFileSync(join(moved, fileName)), before);
  rmSync(dir, { recursive: true });
  renameSync(moved, dir);

  // State root swapped after validation.
  const movedRoot = `${stateRoot}-moved`;
  const rootSwap = await readNativeManagedAssociations(stateRoot, owner(), {
    beforeFileLookup: () => { renameSync(stateRoot, movedRoot); mkdirSync(stateRoot); },
  });
  assert.deepEqual(rootSwap, { status: "unavailable", reason: "changed-while-reading" });
  assert.deepEqual(readFileSync(join(movedRoot, NATIVE_MANAGED_ASSOCIATIONS_DIRNAME, fileName)), before);
  rmSync(stateRoot, { recursive: true });
  renameSync(movedRoot, stateRoot);

  // A normal atomic replacement within the same directory still reads.
  assert.deepEqual(await writeNativeManagedAssociations(stateRoot, owner(), associations("b")), { status: "published", revision: 2 });
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()),
    { status: "loaded", revision: 2, associations: expectedLoaded("b") });
});

test("sparse and huge association inputs are refused and leave a valid snapshot intact", async (t) => {
  const stateRoot = makeStateRoot(t);
  const path = await seed(stateRoot, owner(), "a");
  const before = readFileSync(path);
  const valid = associations("b");
  const gate = valid.conflictGates![0]!;
  const sparseBundles: unknown[] = [valid.bundles[0]];
  sparseBundles.length = 3;
  const sparseRoots: string[] = ["/r"];
  sparseRoots[2] = "/s";
  const sparse: unknown[] = [
    { ...valid, bundles: sparseBundles },
    { ...valid, waveRoots: sparseRoots },
    { ...valid, groupRoots: sparseRoots },
    { ...valid, conflictGates: [gate, , gate] },
    { ...valid, conflictGates: [{ ...gate, paths: sparseRoots }] },
    { ...valid, conflictGates: [{ ...gate, sidecars: [gate.sidecars![0], , gate.sidecars![1]] }] },
  ];
  for (const value of sparse) {
    assert.deepEqual(await writeNativeManagedAssociations(stateRoot, owner(), value as ExecutionAssociationsSnapshot),
      { status: "refused", reason: "invalid-associations" });
  }
  // Huge lengths are refused by the size budget before any walk, clone, or serialization.
  const hugeSparse: unknown[] = [];
  hugeSparse.length = 2 ** 32 - 1;
  const hugeDense = new Array<string>(300_000).fill("");
  const huge: unknown[] = [
    { ...valid, waveRoots: hugeSparse },
    { ...valid, bundles: hugeSparse },
    { ...valid, waveRoots: hugeDense },
    { ...valid, conflictGates: [{ ...gate, paths: hugeSparse }] },
  ];
  for (const value of huge) {
    assert.deepEqual(await writeNativeManagedAssociations(stateRoot, owner(), value as ExecutionAssociationsSnapshot),
      { status: "refused", reason: "oversized" });
  }
  assert.deepEqual(readFileSync(path), before);
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()),
    { status: "loaded", revision: 1, associations: expectedLoaded("a") });
});

test("the saved snapshot is the one copied at call time", async (t) => {
  const stateRoot = makeStateRoot(t);
  const value = associations("a");
  const pending = writeNativeManagedAssociations(stateRoot, owner(), value);
  value.waveRoots.push("/late");
  value.bundles[0]!.taskId = "late";
  assert.deepEqual(await pending, { status: "published", revision: 1 });
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()),
    { status: "loaded", revision: 1, associations: expectedLoaded("a") });
});

test("a pending read or write keeps the exact owner supplied at call time", async (t) => {
  const stateRoot = makeStateRoot(t);
  const original = { ...owner() };
  const next = owner({ conversationId: "7c9e6679-7425-40de-944b-e07fc1f90ae7" });
  await seed(stateRoot, original, "a");
  await seed(stateRoot, next, "b");

  const pendingRead = readNativeManagedAssociations(stateRoot, original);
  original.conversationId = next.conversationId;
  assert.deepEqual(await pendingRead, { status: "loaded", revision: 1, associations: expectedLoaded("a") });

  const writer = { ...owner() };
  const pendingWrite = writeNativeManagedAssociations(stateRoot, writer, associations("c"));
  writer.conversationId = next.conversationId;
  assert.deepEqual(await pendingWrite, { status: "published", revision: 2 });
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()),
    { status: "loaded", revision: 2, associations: expectedLoaded("c") });
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, next),
    { status: "loaded", revision: 1, associations: expectedLoaded("b") });
});

test("concurrent saves for one owner are serialized in invocation order with monotonic revisions", async (t) => {
  const stateRoot = makeStateRoot(t);
  // Invocation order is the contract: each call joins the per-owner queue
  // synchronously, before any filesystem work.
  const results = await Promise.all(["a", "b", "c"].map((tag) =>
    writeNativeManagedAssociations(stateRoot, owner(), associations(tag))));
  assert.deepEqual(results, [
    { status: "published", revision: 1 },
    { status: "published", revision: 2 },
    { status: "published", revision: 3 },
  ]);
  assert.deepEqual(await readNativeManagedAssociations(stateRoot, owner()),
    { status: "loaded", revision: 3, associations: expectedLoaded("c") });
  assert.equal(storeEntries(stateRoot).length, 1);
});
