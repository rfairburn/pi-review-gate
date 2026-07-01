import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkspaceSnapshot } from "../src/capture";
import { registerCommands } from "../src/commands";
import type { ReviewGateConfig } from "../src/config";
import { createState, rememberUserRequest } from "../src/state";

test("/review-now requested changes reset the automatic correction budget", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-review-now-"));
  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const state = createState();
    rememberUserRequest(state, "change index");
    state.correctionCycles = 2;
    state.baseline = await createWorkspaceSnapshot(dir, {
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
    });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const followUps: string[] = [];
    const notices: string[] = [];
    const pi = {
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      sendUserMessage(message: string) {
        followUps.push(message);
      },
    };
    const ctx = {
      notify(message: string) {
        notices.push(message);
      },
    };

    registerCommands({
      pi,
      cwd: () => dir,
      config: reviewConfig(),
      state,
    });

    await commands.get("review-now")?.("", ctx);

    assert.equal(state.correctionCycles, 0);
    assert.equal(followUps.length, 1);
    assert.match(followUps[0] ?? "", /missing test/);
    assert.match(notices.join("\n"), /review gate: changes requested/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function reviewConfig(): ReviewGateConfig {
  return {
    enabled: true,
    mode: "single-decider",
    maxCorrectionCycles: 3,
    reviewWhen: "changed-files",
    maxPatchBytes: 200_000,
    maxFileBytes: 1_048_576,
    maxSnapshotBytes: 52_428_800,
    retainBundles: "never",
    decider: {
      id: "fake",
      adapter: "generic-cli",
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:null,issue:'missing test',recommendation:'add coverage'}]})))",
      ],
      timeoutMs: 5000,
    },
  };
}
