import { lstatSync, mkdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const IGNORED_BACKING_ROOTS = ["node_modules", "dist-test"];

/**
 * Ensure a retained fixture backing root under an ignored own-root subtree.
 *
 * Every backing path component is validated with lstat (never following
 * links) and a BigInt dev/ino receipt chain is re-verified around each
 * creation, so a symlinked or replaced ancestor fails closed instead of
 * redirecting fixture writes outside the owned tree. Pre-existing content is
 * retained; this helper never deletes anything.
 */
export function ensureIgnoredFixtureRoot(projectRoot: string, fixtureRelPath: string): string {
  const components = relative(projectRoot, join(projectRoot, ...fixtureRelPath.split("/"))).split(sep);
  if (!IGNORED_BACKING_ROOTS.includes(components[0]) ||
      components.some((component) => !component || component === ".." || component === ".")) {
    throw new Error("fixture backing path must remain inside an ignored own-root subtree");
  }
  const realDirectory = (target: string) => {
    const stats = lstatSync(target, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`refusing symlinked or non-directory fixture backing path: ${target}`);
    }
    return stats;
  };
  const receipts = [{ path: projectRoot, stats: realDirectory(projectRoot) }];
  const verify = () => {
    for (const receipt of receipts) {
      const now = realDirectory(receipt.path);
      if (now.dev !== receipt.stats.dev || now.ino !== receipt.stats.ino) {
        throw new Error(`fixture backing directory was replaced: ${receipt.path}`);
      }
    }
  };
  let cursor = projectRoot;
  for (const component of components) {
    verify();
    const next = join(cursor, component);
    let stats;
    try {
      stats = realDirectory(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      verify();
      mkdirSync(next);
      verify();
      stats = realDirectory(next);
    }
    receipts.push({ path: next, stats });
    verify();
    cursor = next;
  }
  verify();
  return cursor;
}
