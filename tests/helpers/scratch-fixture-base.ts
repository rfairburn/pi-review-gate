import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

/**
 * Bases for disposable test fixtures, validated against the checkout the
 * compiled tests belong to rather than the caller's working directory.
 *
 * `disposableFixtureBase` is the disposable root the test-scratch runner owns.
 * `retainedFixtureBase` is the sibling location for strict fixtures whose own
 * teardown deliberately retains evidence or withholds removal until settlement;
 * under a test-scratch invocation it must stay outside that invocation root.
 */
export function disposableFixtureBase(): string {
  return externalFixtureBase(process.env.PI_TEST_SCRATCH_ROOT ?? tmpdir());
}

export function retainedFixtureBase(candidate?: string): string {
  const root = process.env.PI_TEST_SCRATCH_ROOT;
  const base = externalFixtureBase(candidate ?? (root ? dirname(root) : tmpdir()));
  if (root && contains(realpathSync(root), base)) {
    throw new Error(`retained fixture base must stay outside the invocation root: ${base}`);
  }
  return base;
}

function contains(parent: string, candidate: string): boolean {
  // Device/inode identity: a case-insensitive filesystem may spell the checkout
  // with different capitalization, while case-sensitive volumes keep distinct
  // differently cased directories distinct.
  const boundary = statSync(parent, { bigint: true });
  for (let current = candidate; ; current = dirname(current)) {
    const entry = statSync(current, { bigint: true });
    if (entry.dev === boundary.dev && entry.ino === boundary.ino) return true;
    if (dirname(current) === current) return false;
  }
}

function externalFixtureBase(candidate: string): string {
  // Compiled tests live in dist-test/tests/helpers; the repository root is
  // three levels up. Source execution is never used for these checks.
  const checkout = realpathSync(resolve(__dirname, "../../.."));
  if (!isAbsolute(candidate)) {
    throw new Error(`fixture base must be absolute: ${candidate}`);
  }
  const base = realpathSync(candidate);
  if (!statSync(base).isDirectory()) {
    throw new Error(`fixture base is not a directory: ${base}`);
  }
  if (contains(checkout, base)) {
    throw new Error(`fixture base must stay outside the checkout: ${base}`);
  }
  return base;
}
