import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ClaudeCliAdapter } from "../src/adapters/claude-cli";
import { CodexCliAdapter } from "../src/adapters/codex-cli";

test("CodexCliAdapter runs with read-only sandbox and review bundle access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-codex-adapter-"));
  try {
    const argvPath = join(dir, "argv.json");
    const commandPath = join(dir, "fake-codex.mjs");
    const reviewJson = JSON.stringify({ verdict: "pass", summary: "codex ok", findings: [] });
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
      "const args = process.argv.slice(2);",
      "const out = args[args.indexOf('--output-last-message') + 1];",
      `writeFileSync(out, ${JSON.stringify(reviewJson)});`,
      "process.stdin.resume();",
      "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:2}})+'\\n'));",
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new CodexCliAdapter({
      id: "codex",
      adapter: "codex-cli",
      command: commandPath,
      timeoutMs: 5000,
    });

    const result = await adapter.run({
      id: "codex",
      cwd: process.cwd(),
      prompt: "review",
      bundleDir: dir,
      timeoutMs: 5000,
    });

    const argv = JSON.parse(await readFile(argvPath, "utf8"));
    assert.equal(result.verdict, "pass");
    assert.deepEqual(argv.includes("--sandbox"), true);
    assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
    assert.deepEqual(argv.includes("--add-dir"), true);
    assert.equal(argv[argv.indexOf("--add-dir") + 1], dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ClaudeCliAdapter limits reviewers to read-only tools and review bundle access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-claude-adapter-"));
  try {
    const argvPath = join(dir, "argv.json");
    const commandPath = join(dir, "fake-claude.mjs");
    const reviewJson = JSON.stringify({ verdict: "pass", summary: "claude ok", findings: [] });
    await writeFile(commandPath, [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
      "process.stdin.resume();",
      `process.stdin.on('end',()=>process.stdout.write(JSON.stringify({type:'result',result:${JSON.stringify(reviewJson)},usage:{input_tokens:1,output_tokens:2}})));`,
    ].join("\n"), "utf8");
    await chmod(commandPath, 0o755);

    const adapter = new ClaudeCliAdapter({
      id: "claude",
      adapter: "claude-cli",
      command: commandPath,
      timeoutMs: 5000,
    });

    const result = await adapter.run({
      id: "claude",
      cwd: process.cwd(),
      prompt: "review",
      bundleDir: dir,
      timeoutMs: 5000,
    });

    const argv = JSON.parse(await readFile(argvPath, "utf8"));
    assert.equal(result.verdict, "pass");
    assert.deepEqual(argv.includes("--tools"), true);
    assert.equal(argv[argv.indexOf("--tools") + 1], "Read,Grep,Glob,LS");
    assert.deepEqual(argv.includes("--add-dir"), true);
    assert.equal(argv[argv.indexOf("--add-dir") + 1], dir);
    assert.deepEqual(argv.includes("--append-system-prompt"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
