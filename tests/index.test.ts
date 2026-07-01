import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activate } from "../src/index";

test("cap notice includes reviewer requested changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-cap-"));
  const previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  const previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      mode: "single-decider",
      maxCorrectionCycles: 0,
      reviewWhen: "changed-files",
      maxPatchBytes: 200000,
      maxFileBytes: 1048576,
      maxSnapshotBytes: 52428800,
      retainBundles: "never",
      decider: {
        id: "fake",
        adapter: "generic-cli",
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]})))",
        ],
        timeoutMs: 5000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(hooks, "agent_end", { cwd: dir });

    const noticeText = notices.join("\n\n");
    assert.match(noticeText, /automatic correction cap reached/);
    assert.match(noticeText, /Review found blocking issues/);
    assert.match(noticeText, /missing guard/);
    assert.match(noticeText, /add the guard/);
  } finally {
    if (previousConfig === undefined) {
      delete process.env.PI_REVIEW_GATE_CONFIG;
    } else {
      process.env.PI_REVIEW_GATE_CONFIG = previousConfig;
    }
    if (previousDisabled === undefined) {
      delete process.env.PI_REVIEW_GATE_DISABLED;
    } else {
      process.env.PI_REVIEW_GATE_DISABLED = previousDisabled;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

async function trigger(hooks: Map<string, Array<(...args: unknown[]) => unknown>>, name: string, ...args: unknown[]): Promise<void> {
  for (const handler of hooks.get(name) ?? []) {
    await handler(...args);
  }
}
