/**
 * One exclusive private (0700) native-fixture root beneath the configured OS
 * temporary directory — never a hard-coded filesystem root (#721). Returns
 * undefined when the configured root is missing, is not a real directory, or
 * cannot hold the root; only a just-created empty root is ever removed. Each
 * caller keeps its own broker socket-path budget check.
 */
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createNativeTempRoot(prefix: string): string | undefined {
  let root: string | undefined;
  try {
    const parent = realpathSync(tmpdir());
    if (!lstatSync(parent).isDirectory()) return undefined;
    root = mkdtempSync(join(parent, prefix));
    chmodSync(root, 0o700);
    return root;
  } catch {
    if (root) {
      try { rmdirSync(root); } catch { /* no owned root remains to remove */ }
    }
    return undefined;
  }
}
