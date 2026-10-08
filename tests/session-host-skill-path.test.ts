import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Pure cross-platform contract for the exact private OWN-source algorithm.
// This extracts only the named declaration, not SDK internals or a copied
// substitute. No filesystem publication, process, SDK or Windows proof.
const pathname = join(process.cwd(), "src", "session-host", "launch.ts");
const text = readFileSync(pathname, "utf8");
const source = ts.createSourceFile(pathname, text, ts.ScriptTarget.ES2022, true);
const declarations = source.statements.filter((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === "skillDirectoryComponents");
assert.equal(declarations.length, 1, "one exact source helper is selected");
const javascript = ts.transpileModule(declarations[0]!.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

for (const [label, api, agentDir] of [
  ["POSIX", posix, "/owned/agent"],
  ["Windows", win32, "C:\\owned\\agent"],
] as const) {
  test(`legacy skill component walk retains every ${label} ancestor`, () => {
    const destination = api.join(agentDir, "skills", "pi-review-gate-orchestrator", "references", "recovery.md");
    const actual = runInNewContext(`${javascript}\nskillDirectoryComponents(agentDir, destination);`, {
      dirname: api.dirname, relative: api.relative, join: api.join, sep: api.sep,
      agentDir, destination,
    }, { timeout: 1_000 }) as string[];
    assert.deepEqual(Array.from(actual), [
      agentDir,
      api.join(agentDir, "skills"),
      api.join(agentDir, "skills", "pi-review-gate-orchestrator"),
      api.join(agentDir, "skills", "pi-review-gate-orchestrator", "references"),
    ], "prevalidation and componentwise mkdir both visit the skills root and every intermediate directory");
  });
}
