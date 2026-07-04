import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
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
    assert.match(noticeText, /Reviewer feedback was not sent to the primary model/);
    assert.match(noticeText, /Use \/review-continue to send this feedback/);
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

test("user steering during review is held until reviewer feedback is queued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-steer-during-review-"));
  const previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  const previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      mode: "single-decider",
      maxCorrectionCycles: 3,
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
          [
            "process.stdin.resume();",
            "process.stdin.on('end',()=>setTimeout(()=>process.stdout.write(JSON.stringify(",
            "{verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]}",
            ")),50));",
          ].join(""),
        ],
        timeoutMs: 5000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify() {},
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    const reviewPromise = trigger(hooks, "agent_end", { cwd: dir });
    const inputResults = await triggerResults(hooks, "input", { cwd: dir, text: "also keep the API name stable", source: "user" });
    await reviewPromise;

    assert.deepEqual(inputResults, [{ action: "handled" }]);
    assert.equal(followUps.length, 2);
    assert.match(followUps[0]?.message ?? "", /Review found blocking issues/);
    assert.match(followUps[0]?.message ?? "", /missing guard/);
    assert.equal(followUps[1]?.message, "also keep the API name stable");
    assert.deepEqual(followUps.map((item) => item.options), [{ deliverAs: "followUp" }, { deliverAs: "followUp" }]);
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

test("agent end skips reviewer when primary turn signal is already aborted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-aborted-before-review-"));
  const previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  const previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const markerPath = join(dir, "review-started.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      mode: "single-decider",
      maxCorrectionCycles: 3,
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
          [
            `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'started');`,
            "process.stdin.resume();",
            "let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            "const ok=input.includes('Initial user request:')",
            "&& input.includes('change index')",
            "&& input.includes('redirect to finish safely')",
            "&& input.includes('-before')",
            "&& input.includes('+after redirected');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'kept interrupted context',findings:[]}",
            ":{verdict:'needs_changes',summary:'lost interrupted context',findings:[{severity:'blocking',file:'session',line:null,issue:'missing aborted run context',recommendation:'preserve baseline and request history across abort'}]}));",
            "});",
          ].join(""),
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

    const controller = new AbortController();
    controller.abort();
    await trigger(hooks, "agent_end", { cwd: dir, signal: controller.signal });

    await assert.rejects(access(markerPath), /ENOENT/);
    assert.doesNotMatch(notices.join("\n"), /reviewing changes/);

    await trigger(hooks, "input", { cwd: dir, text: "redirect to finish safely", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after redirected\n", "utf8");
    await trigger(hooks, "agent_end", { cwd: dir });

    await access(markerPath);
    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /lost interrupted context/);
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

test("escape terminal input aborts an active reviewer process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-escape-review-"));
  const previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  const previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const markerPath = join(dir, "review-started.txt");
    const invocationPath = join(dir, "review-invocations.txt");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      mode: "single-decider",
      maxCorrectionCycles: 3,
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
          [
            "const fs=require('node:fs');",
            `const markerPath=${JSON.stringify(markerPath)};`,
            `const invocationPath=${JSON.stringify(invocationPath)};`,
            "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
            "fs.writeFileSync(invocationPath,String(count+1));",
            "fs.writeFileSync(markerPath,'started');",
            "if(count===0){setInterval(()=>{},1000);}",
            "else {",
            "process.stdin.resume();",
            "let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            "const ok=input.includes('Initial user request:')",
            "&& input.includes('change index')",
            "&& input.includes('redirect after cancelling review')",
            "&& input.includes('-before')",
            "&& input.includes('+after redirected');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'kept cancelled review context',findings:[]}",
            ":{verdict:'needs_changes',summary:'lost cancelled review context',findings:[{severity:'blocking',file:'session',line:null,issue:'missing cancelled review context',recommendation:'preserve baseline and request history across review cancellation'}]}));",
            "});",
            "}",
          ].join(""),
        ],
        timeoutMs: 300000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const terminalHandlers: Array<(input: unknown) => unknown> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      ui: {
        notify(message: string) {
          notices.push(message);
        },
        onTerminalInput(handler: (input: unknown) => unknown) {
          terminalHandlers.push(handler);
          return () => {
            const index = terminalHandlers.indexOf(handler);
            if (index >= 0) {
              terminalHandlers.splice(index, 1);
            }
          };
        },
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");

    const reviewPromise = trigger(hooks, "agent_end", { cwd: dir, ui: pi.ui });
    await waitForFile(markerPath);

    assert.equal(terminalHandlers.length, 1);
    assert.deepEqual(
      await triggerResults(hooks, "input", { cwd: dir, text: "do not continue with this", source: "user" }),
      [{ action: "handled" }],
    );
    assert.deepEqual(terminalHandlers[0]?.("\x1b"), { action: "handled", consume: true });
    await reviewPromise;

    assert.match(notices.join("\n"), /review gate: review cancelled/);
    assert.doesNotMatch(notices.join("\n"), /reviewer failed/);
    assert.equal(followUps.length, 0);
    assert.equal(terminalHandlers.length, 0);

    await trigger(hooks, "input", { cwd: dir, text: "redirect after cancelling review", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after redirected\n", "utf8");
    await trigger(hooks, "agent_end", { cwd: dir, ui: pi.ui });

    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /lost cancelled review context/);
    assert.equal(followUps.length, 0);
    assert.equal(terminalHandlers.length, 0);
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

async function triggerResults(hooks: Map<string, Array<(...args: unknown[]) => unknown>>, name: string, ...args: unknown[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const handler of hooks.get(name) ?? []) {
    results.push(await handler(...args));
  }
  return results.filter((result) => result !== undefined);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await access(path);
}
