// Shared launcher-test fixtures for the post-#344 contract.
//
// The launchers no longer run `npm run build` in the checkout. A genuine
// development launch stages the application inputs and runs the locked install
// and the staged TypeScript compiler. These helpers provide a synthetic npm
// installation the shared resolver accepts exactly like a real one, and a
// synthetic compiler that produces the required compiled entries — so the real
// preparation path runs end to end without touching the network or a live dist.

import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

/** Compiled entries every prepared generation must contain. */
export const REQUIRED_COMPILED_ENTRIES: readonly string[][] = [
  ["dist", "src", "index.js"],
  ["dist", "src", "session-host", "main.js"],
  ["dist", "src", "web", "cli.js"],
];

export function writeRequiredOutputs(root: string): void {
  for (const entry of REQUIRED_COMPILED_ENTRIES) {
    const target = join(root, ...entry);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "module.exports = {};\n", "utf8");
  }
}

/**
 * A fake npm the shared resolver accepts: PATH's `npm` entry resolves into a
 * package whose manifest is npm's own JS CLI. The CLI records its arguments and,
 * for a `ci` install, stages a synthetic TypeScript compiler that writes the
 * required compiled entries into the staging root.
 */
export async function writeFakeNpm(
  binDir: string,
  options: { recordFile?: string; exitCodeEnv?: string; install?: (stageRoot: string) => void } = {},
): Promise<void> {
  const packageDir = join(binDir, "node_modules", "npm");
  const cliPath = join(packageDir, "bin", "npm-cli.js");
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    `${JSON.stringify({ name: "npm", version: "10.0.0", bin: { npm: "bin/npm-cli.js" } })}\n`,
    "utf8",
  );
  const record = options.recordFile === undefined ? null : JSON.stringify(options.recordFile);
  const compiler = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `for (const entry of ${JSON.stringify(REQUIRED_COMPILED_ENTRIES)}) {`,
    "  const target = path.join(process.cwd(), ...entry);",
    "  fs.mkdirSync(path.dirname(target), { recursive: true });",
    "  fs.writeFileSync(target, 'module.exports = {};\\n');",
    "}",
    "process.exit(0);",
  ].join("\n");
  writeFileSync(cliPath, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    record === null ? "" : `fs.writeFileSync(${record}, JSON.stringify(process.argv.slice(2)));`,
    `const exitCode = Number(process.env[${JSON.stringify(options.exitCodeEnv ?? "NPM_EXIT_CODE")}] ?? '0');`,
    "if (exitCode !== 0) process.exit(exitCode);",
    "if (process.argv[2] === 'ci') {",
    "  fs.mkdirSync('node_modules/typescript/bin', { recursive: true });",
    "  fs.writeFileSync('node_modules/typescript/package.json', JSON.stringify({ name: 'typescript', version: '5.7.2', bin: { tsc: 'bin/tsc' } }));",
    `  fs.writeFileSync('node_modules/typescript/bin/tsc', ${JSON.stringify(compiler)});`,
    "}",
    "process.exit(0);",
  ].filter((line) => line.length > 0).join("\n"), "utf8");
  if (process.platform !== "win32") {
    // The resolver validates PATH's `npm` by resolving it into the npm package.
    symlinkSync(join("node_modules", "npm", "bin", "npm-cli.js"), join(binDir, "npm"));
    chmodSync(join(binDir, "npm"), 0o755);
  }
}

/** The prepared extension a launcher reported, derived from the capture file. */
export function extensionFromArgs(rawArgs: string): { extension: string; forwarded: string[] } {
  const lines = rawArgs.split("\n").filter((line) => line.length > 0);
  if (lines[0] !== "--extension") throw new Error(`unexpected launcher arguments: ${rawArgs}`);
  return { extension: lines[1], forwarded: lines.slice(2) };
}

/** True when the path names a compiled extension entry. */
export function isCompiledExtension(path: string): boolean {
  return path.endsWith(`${sep}dist${sep}src${sep}index.js`) || path.endsWith("/dist/src/index.js");
}
