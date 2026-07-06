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

test("automatic correction turns preserve original baseline and accumulated evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-auto-correction-evidence-"));
  const previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  const previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
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
            `const invocationPath=${JSON.stringify(invocationPath)};`,
            "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
            "fs.writeFileSync(invocationPath,String(count+1));",
            "process.stdin.resume();",
            "let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            "if(count===0){",
            "process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]}));",
            "return;",
            "}",
            "const ok=input.includes('original-tool-evidence')",
            "&& input.includes('fix-tool-evidence')",
            "&& input.includes('first assistant summary')",
            "&& input.includes('second assistant summary')",
            "&& input.includes('-before')",
            "&& input.includes('+fixed');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'kept accumulated evidence',findings:[]}",
            ":{verdict:'needs_changes',summary:'lost accumulated evidence',findings:[{severity:'blocking',file:'session',line:null,issue:'review prompt lost original baseline or evidence across automatic correction',recommendation:'preserve original baseline and accumulated evidence across automatic correction turns'}]}));",
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
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo original-tool-evidence" } });
    await writeFile(join(dir, "index.ts"), "broken\n", "utf8");
    await trigger(hooks, "agent_end", {
      cwd: dir,
      messages: [{ role: "assistant", content: "first assistant summary" }],
    });

    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /missing guard/);

    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo fix-tool-evidence" } });
    await writeFile(join(dir, "index.ts"), "fixed\n", "utf8");
    await trigger(hooks, "agent_end", {
      cwd: dir,
      messages: [{ role: "assistant", content: "second assistant summary" }],
    });

    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /lost accumulated evidence/);
    assert.equal(followUps.length, 1);
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

test("/review-continue after cap preserves original baseline and accumulated evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-capped-continue-evidence-"));
  const previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  const previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationPath = join(dir, "review-invocations.txt");
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
          [
            "const fs=require('node:fs');",
            `const invocationPath=${JSON.stringify(invocationPath)};`,
            "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
            "fs.writeFileSync(invocationPath,String(count+1));",
            "process.stdin.resume();",
            "let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            "if(count===0){",
            "process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]}));",
            "return;",
            "}",
            "const ok=input.includes('capped-original-evidence')",
            "&& input.includes('continued-fix-evidence')",
            "&& input.includes('first capped summary')",
            "&& input.includes('continued summary')",
            "&& input.includes('-before')",
            "&& input.includes('+fixed after continue');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'kept capped continuation evidence',findings:[]}",
            ":{verdict:'needs_changes',summary:'lost capped continuation evidence',findings:[{severity:'blocking',file:'session',line:null,issue:'review prompt lost evidence after correction cap and review-continue',recommendation:'preserve evidence across capped continuation'}]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 5000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo capped-original-evidence" } });
    await writeFile(join(dir, "index.ts"), "broken\n", "utf8");
    await trigger(hooks, "agent_end", {
      cwd: dir,
      messages: [{ role: "assistant", content: "first capped summary" }],
    });

    assert.match(notices.join("\n"), /automatic correction cap reached/);
    assert.equal(followUps.length, 0);

    await commands.get("review-continue")?.("", { notify(message: string) { notices.push(message); } });

    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /missing guard/);

    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo continued-fix-evidence" } });
    await writeFile(join(dir, "index.ts"), "fixed after continue\n", "utf8");
    await trigger(hooks, "agent_end", {
      cwd: dir,
      messages: [{ role: "assistant", content: "continued summary" }],
    });

    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /lost capped continuation evidence/);
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

test("normal user input after cap starts a fresh review run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-capped-fresh-input-"));
  const previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  const previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const invocationPath = join(dir, "review-invocations.txt");
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
          [
            "const fs=require('node:fs');",
            `const invocationPath=${JSON.stringify(invocationPath)};`,
            "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
            "fs.writeFileSync(invocationPath,String(count+1));",
            "process.stdin.resume();",
            "let input='';",
            "process.stdin.on('data',chunk=>input+=chunk);",
            "process.stdin.on('end',()=>{",
            "if(count===0){",
            "process.stdout.write(JSON.stringify({verdict:'needs_changes',summary:'fix required',findings:[{severity:'blocking',file:'index.ts',line:1,issue:'missing guard',recommendation:'add the guard'}]}));",
            "return;",
            "}",
            "const ok=input.includes('fresh-task-evidence')",
            "&& input.includes('-broken')",
            "&& input.includes('+fresh change')",
            "&& !input.includes('old-capped-evidence')",
            "&& !input.includes('first capped summary')",
            "&& !input.includes('-before');",
            "process.stdout.write(JSON.stringify(ok",
            "?{verdict:'pass',summary:'fresh run did not inherit capped evidence',findings:[]}",
            ":{verdict:'needs_changes',summary:'fresh run inherited capped evidence',findings:[{severity:'blocking',file:'session',line:null,issue:'normal prompt after cap reused old evidence or baseline',recommendation:'start a fresh run on normal input after correction cap'}]}));",
            "});",
          ].join(""),
        ],
        timeoutMs: 5000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
    const notices: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
        commands.set(name, options.handler);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage() {},
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "change index", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo old-capped-evidence" } });
    await writeFile(join(dir, "index.ts"), "broken\n", "utf8");
    await trigger(hooks, "agent_end", {
      cwd: dir,
      messages: [{ role: "assistant", content: "first capped summary" }],
    });

    assert.match(notices.join("\n"), /automatic correction cap reached/);

    await trigger(hooks, "input", { cwd: dir, text: "start a different task", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "tool_call", { cwd: dir, toolName: "bash", input: { command: "echo fresh-task-evidence" } });
    await writeFile(join(dir, "index.ts"), "fresh change\n", "utf8");
    await trigger(hooks, "agent_end", {
      cwd: dir,
      messages: [{ role: "assistant", content: "fresh task summary" }],
    });

    assert.match(notices.join("\n"), /review gate: passed/);
    assert.doesNotMatch(notices.join("\n"), /fresh run inherited capped evidence/);
    assert.equal(commands.has("review-continue"), true);
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

test("repeated no-progress reviewer feedback stops automatic correction loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-gate-no-progress-loop-"));
  const invocationPath = join(tmpdir(), `pi-review-gate-no-progress-${process.pid}-${Date.now()}.txt`);
  const previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  const previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;

  try {
    await writeFile(join(dir, "index.ts"), "before\n", "utf8");
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      mode: "single-decider",
      maxCorrectionCycles: 30,
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
            `const invocationPath=${JSON.stringify(invocationPath)};`,
            "const count=fs.existsSync(invocationPath)?Number(fs.readFileSync(invocationPath,'utf8')):0;",
            "fs.writeFileSync(invocationPath,String(count+1));",
            "process.stdin.resume();",
            "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({",
            "verdict:'needs_changes',summary:'sentinel flag',findings:[{",
            "severity:'blocking',file:'session',line:null,",
            "issue:count===0?'The user explicitly instructed review-gate to flag this rather than report pass. No file content change is needed.':'The user explicitly instructed review-gate to flag this request instead of reporting passed. No implementation change is required.',",
            "recommendation:count===0?'Keep this as the requested review-gate sentinel flag.':'Keep this as the requested sentinel flag.'",
            "}]})));",
          ].join(""),
        ],
        timeoutMs: 5000,
      },
    }), "utf8");

    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;

    const hooks = new Map<string, Array<(...args: unknown[]) => unknown>>();
    const notices: string[] = [];
    const followUps: Array<{ message: string; options: unknown }> = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
      notify(message: string) {
        notices.push(message);
      },
      sendUserMessage(message: string, options: unknown) {
        followUps.push({ message, options });
      },
    };

    await activate(pi);
    await trigger(hooks, "input", { cwd: dir, text: "write hello world and flag review-gate", source: "user" });
    await trigger(hooks, "before_agent_start", { cwd: dir });
    await writeFile(join(dir, "index.ts"), "after\n", "utf8");
    await trigger(hooks, "agent_end", {
      cwd: dir,
      messages: [{ role: "assistant", content: "wrote the file and flagged review-gate" }],
    });

    assert.equal(followUps.length, 1);
    assert.match(followUps[0]?.message ?? "", /sentinel flag/);

    await trigger(hooks, "before_agent_start", { cwd: dir });
    await trigger(hooks, "agent_end", {
      cwd: dir,
      messages: [{ role: "assistant", content: "no implementation change is required" }],
    });

    assert.equal(followUps.length, 1);
    assert.match(notices.join("\n"), /repeated changes requested with no new correction evidence/);
    assert.match(notices.join("\n"), /Stopping automatic correction to avoid a loop/);
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
    await rm(invocationPath, { force: true });
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
