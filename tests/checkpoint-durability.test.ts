import assert from "node:assert/strict";
import type { PathLike, Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { syncLooseGitObject } from "../src/checkpoint/durability";

const fsPromises = require("node:fs/promises") as typeof import("node:fs/promises");
type FakeStat = {
  dev: number;
  ino: number;
  size: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

function fakeStat(dev: number, ino = 17, size = 23, file = true): FakeStat {
  return { dev, ino, size, isFile: () => file, isSymbolicLink: () => false };
}

/** Run the real durability validation against mocked path/open stats and platform. */
async function withMockedLooseObject(
  platform: NodeJS.Platform,
  pathStat: FakeStat,
  openedStat: FakeStat,
): Promise<boolean> {
  const oid = "a".repeat(40);
  const objectsDir = join("mock-root", "objects");
  const objectPath = join(objectsDir, oid.slice(0, 2), oid.slice(2));
  const lstatDescriptor = Object.getOwnPropertyDescriptor(fsPromises, "lstat")!;
  const openDescriptor = Object.getOwnPropertyDescriptor(fsPromises, "open")!;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

  const fileHandle = {
    stat: async () => openedStat as unknown as Stats,
    sync: async () => undefined,
    close: async () => undefined,
  } as unknown as FileHandle;
  const directoryHandle = {
    sync: async () => undefined,
    close: async () => undefined,
  } as unknown as FileHandle;

  try {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
    Object.defineProperty(fsPromises, "lstat", {
      ...lstatDescriptor,
      value: async (path: PathLike) => {
        assert.equal(String(path), objectPath);
        return pathStat as unknown as Stats;
      },
    });
    Object.defineProperty(fsPromises, "open", {
      ...openDescriptor,
      value: async (path: PathLike) => String(path) === objectPath ? fileHandle : directoryHandle,
    });
    return await syncLooseGitObject(objectsDir, oid, true);
  } finally {
    Object.defineProperty(fsPromises, "lstat", lstatDescriptor);
    Object.defineProperty(fsPromises, "open", openDescriptor);
    Object.defineProperty(process, "platform", platformDescriptor);
  }
}

test("syncLooseGitObject accepts Windows lstat dev=0 against the opened volume identity", async () => {
  assert.equal(await withMockedLooseObject("win32", fakeStat(0), fakeStat(42)), true);
});

test("syncLooseGitObject rejects Windows device and other identity drift", async () => {
  const driftCases: Array<[string, FakeStat, FakeStat]> = [
    ["nonzero device", fakeStat(5), fakeStat(6)],
    ["inode", fakeStat(5, 17), fakeStat(5, 18)],
    ["size", fakeStat(5, 17, 23), fakeStat(5, 17, 24)],
    ["file type", fakeStat(5), fakeStat(5, 17, 23, false)],
  ];

  for (const [field, pathStat, openedStat] of driftCases) {
    await assert.rejects(
      withMockedLooseObject("win32", pathStat, openedStat),
      /Git loose object changed while syncing its durability/,
      `${field} drift must fail closed`,
    );
  }
});

test("syncLooseGitObject keeps non-Windows device comparison strict", async () => {
  await assert.rejects(
    withMockedLooseObject("linux", fakeStat(0), fakeStat(42)),
    /Git loose object changed while syncing its durability/,
  );
});
