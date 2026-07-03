import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GenericCliAdapter } from "../src/adapters/generic-cli";

test("GenericCliAdapter sends prompt through stdin and parses stdout JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-cli-"));
  try {
    const adapter = new GenericCliAdapter({
      id: "fake",
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume();let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'pass',summary:s.includes('PATCH')?'ok':'missing',findings:[]})))",
      ],
      timeoutMs: 5000,
    });

    const result = await adapter.run({
      id: "fake",
      cwd: process.cwd(),
      prompt: "PATCH",
      bundleDir: dir,
      timeoutMs: 5000,
    });

    assert.equal(result.verdict, "pass");
    assert.equal(result.summary, "ok");
    assert.match(await readFile(join(dir, "raw-output.txt"), "utf8"), /"verdict":"pass"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GenericCliAdapter aborts a running reviewer process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-cli-abort-"));
  try {
    const controller = new AbortController();
    const adapter = new GenericCliAdapter({
      id: "fake",
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume();setInterval(()=>{},1000)",
      ],
      timeoutMs: 10000,
    });

    const promise = adapter.run({
      id: "fake",
      cwd: process.cwd(),
      prompt: "PATCH",
      bundleDir: dir,
      timeoutMs: 10000,
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 25).unref();
    const result = await promise;

    assert.equal(result.verdict, "error");
    assert.equal(result.error, "aborted");
    assert.equal(result.summary, "Reviewer was aborted.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
