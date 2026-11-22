import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { TestContext } from "node:test";

/** Satisfy the settings validator's access-only Pi probe without a real Pi install. */
export function installSettingsPiPathFixture(t: TestContext): void {
  const dir = mkdtempSync(join(tmpdir(), "prg-settings-pi-path-"));
  const savedPath = process.env.PATH;
  t.after(() => {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });
  // Intentionally not a program. Save validates the file but never starts Pi.
  writeFileSync(join(dir, "pi"), "", { flag: "wx", mode: 0o700 });
  process.env.PATH = savedPath ? `${dir}${delimiter}${savedPath}` : dir;
}
