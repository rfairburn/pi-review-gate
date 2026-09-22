import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm, symlink, unlink, writeFile, mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { APPLY_PATCH_TOOL_NAME, applyPatchToolSchema, registerApplyPatchTool, renderApplyPatchCall, renderApplyPatchResult, renderExpandedApplyPatchResult } from "../src/apply-patch/tool";
import { collectEvidenceChanges, createEvidenceState, extractCandidatePaths, recordToolCallEvidence, recordToolResultEvidence, shouldRecordToolCallEvidence, shouldRecordToolResultEvidence } from "../src/evidence";
import { activate } from "../src/index";
import { ExecutionToolManager } from "../src/execution/tool";
import { normalizeConfig } from "../src/config";
import { createState } from "../src/state";
import { sourceMutationCoordinator } from "../src/execution/source-mutation-lease";

const executionToolNames = [
  "SubtasksStart", "SubtasksAdd", "SubtasksInspect", "SubtasksWatch", "SubtasksContinue",
  "SubtasksSteer", "SubtasksInterrupt", "SubtasksForceMerge", "SubtasksMarkClean",
];

let previousConfig: string | undefined;
let previousDisabled: string | undefined;

beforeEach(() => {
  previousConfig = process.env.PI_REVIEW_GATE_CONFIG;
  previousDisabled = process.env.PI_REVIEW_GATE_DISABLED;
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.PI_REVIEW_GATE_CONFIG;
  else process.env.PI_REVIEW_GATE_CONFIG = previousConfig;
  if (previousDisabled === undefined) delete process.env.PI_REVIEW_GATE_DISABLED;
  else process.env.PI_REVIEW_GATE_DISABLED = previousDisabled;
});

interface ToolHarness {
  tools: Array<Record<string, any>>;
  execute(params: unknown, options?: { cwd?: string; signal?: AbortSignal }): Promise<Record<string, any>>;
}

function harness(): ToolHarness {
  const tools: Array<Record<string, any>> = [];
  const pi = { registerTool(tool: Record<string, any>) { tools.push(tool); } };
  const registered = registerApplyPatchTool(pi);
  assert.ok(registered);
  const tool = tools.find((candidate) => candidate.name === APPLY_PATCH_TOOL_NAME);
  assert.ok(tool, "ApplyPatch was not registered");
  return {
    tools,
    execute: (params, options = {}) => tool.execute("test-call", params, options.signal, undefined, options.cwd ? { cwd: options.cwd } : undefined),
  };
}

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-review-apply-patch-"));
}

function updateEnvelope(path: string, diff: string, moveTo?: string): Record<string, unknown> {
  const lines = diff.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return { patch: envelope("*** Update File: " + path, ...(moveTo !== undefined ? ["*** Move to: " + moveTo] : []), ...lines) };
}

// ---------------------------------------------------------------------------
// Registration, schema, and visibility
// ---------------------------------------------------------------------------

test("ApplyPatch registers with a canonical-envelope-only strict schema and sequential execution", () => {
  const { tools } = harness();
  const tool = tools.find((candidate) => candidate.name === APPLY_PATCH_TOOL_NAME)!;
  assert.equal(tool.label, APPLY_PATCH_TOOL_NAME);
  assert.equal(tool.executionMode, "sequential");
  assert.ok(tool.description.includes("*** Begin Patch"));
  assert.ok(tool.description.includes("applied sequentially"));
  assert.ok(!tool.description.includes("rollback"), "the model-facing contract must not promise rollback");
  assert.ok(!tool.description.includes("confined"), "the model-facing contract must not promise workspace confinement");
  assert.ok(!tool.promptSnippet.includes("confined"), "the prompt snippet must not promise workspace confinement");
  for (const guideline of tool.promptGuidelines as string[]) {
    assert.ok(!guideline.includes("workspace-relative"), "guidelines must not claim paths are workspace-relative");
    assert.ok(!guideline.includes("confined"), "guidelines must not promise workspace confinement");
  }
  assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0);
  assert.ok(typeof tool.renderCall === "function");
  assert.ok(typeof tool.renderResult === "function");

  // The shipped schema exposes only the canonical envelope: one required
  // `patch` property, no legacy `operation` argument, and no oneOf branches.
  const schema = applyPatchToolSchema() as { additionalProperties: boolean; required?: string[]; properties: Record<string, any>; oneOf?: unknown };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["patch"]);
  assert.deepEqual(Object.keys(schema.properties), ["patch"]);
  assert.equal(schema.oneOf, undefined);
  const patch = schema.properties.patch as { type: string; description: string };
  assert.equal(patch.type, "string");
  assert.ok(patch.description.includes("*** Begin Patch"));
  assert.ok(patch.description.includes("applied sequentially"));
});

test("registerApplyPatchTool returns false when the host cannot register tools", () => {
  assert.equal(registerApplyPatchTool(undefined), false);
  assert.equal(registerApplyPatchTool({}), false);
});

test("ApplyPatch is registered for both the orchestrator and executor runtimes without config gating", async () => {
  const dir = await tempWorkspace();
  try {
    const configPath = join(dir, "review-gate.json");
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      maxCorrectionCycles: 1,
      maxPatchBytes: 200_000,
      maxFileBytes: 1_048_576,
      maxSnapshotBytes: 52_428_800,
      retainBundles: "never",
    }), "utf8");
    process.env.PI_REVIEW_GATE_CONFIG = configPath;
    delete process.env.PI_REVIEW_GATE_DISABLED;
    const previousRole = process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
    try {
      for (const role of [undefined, "executor"] as Array<string | undefined>) {
        if (role === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
        else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = role;
        const tools: Array<Record<string, any>> = [];
        const pi = {
          on() {},
          registerTool(tool: Record<string, any>) { tools.push(tool); },
          registerCommand() {},
          notify() {},
        };
        await activate(pi);
        const names = tools.map((tool) => tool.name);
        assert.ok(names.includes(APPLY_PATCH_TOOL_NAME), `ApplyPatch missing under role ${role ?? "orchestrator"}`);
        const patchTool = tools.find((tool) => tool.name === APPLY_PATCH_TOOL_NAME)!;
        assert.equal(patchTool.executionMode, "sequential");
      }
    } finally {
      if (previousRole === undefined) delete process.env.PI_REVIEW_GATE_RUNTIME_ROLE;
      else process.env.PI_REVIEW_GATE_RUNTIME_ROLE = previousRole;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("execute workers inherit ApplyPatch through the active-tool snapshot while research workers stay read-only", async () => {
  const tools: Array<Record<string, any>> = [];
  const pi: Record<string, any> = {
    registerTool(tool: Record<string, any>) { tools.push(tool); },
    registerCommand() {},
    setToolActive() {},
    getActiveTools: () => ["read", "bash", "ApplyPatch", ...executionToolNames],
  };
  const config = normalizeConfig({
    enabled: true,
    review: { activeReviewers: [] },
    externalAgents: {
      "fake": {
        adapter: "codex-cli",
        command: process.execPath,
        execution: {
          args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{},30000))"],
        }
      }
    },
    execution: {
workerResources: { "default": { selection: { source: "external", id: "fake" }, maxConcurrent: 1 } },
  routes: { execute: [{ resourceId: "default" }], research: [{ resourceId: "default" }] },
    },
    ui: { subtasksViewExpanded: false },
  });
  const manager = new ExecutionToolManager({
    pi,
    config,
    state: createState(),
    cwd: () => process.cwd(),
    notify: () => {},
  });
  manager.sync();
  const start = tools.find((tool) => tool.name === "SubtasksStart")!;
  const result = await start.execute("apply-patch-visibility", {
    kind: "research",
    tasks: [{
      title: "Read-only inspection",
      instructions: "Inspect and report",
      acceptanceCriteria: ["Report returned"],
    }],
  }, undefined, undefined, {});
  assert.equal(result.details.kind, "research");
  const researchTools = result.details.tasks[0].definition.executorToolCatalog?.allowedToolCatalog ?? [];
  assert.ok(researchTools.length > 0, "research tasks carry a canonical tool catalog");
  assert.ok(!researchTools.includes(APPLY_PATCH_TOOL_NAME), "research workers must not receive ApplyPatch");

  const executeResult = await start.execute("apply-patch-visibility-execute", {
    kind: "execute",
    tasks: [{
      title: "Bounded implementation",
      instructions: "Implement the change",
      acceptanceCriteria: ["Change implemented"],
    }],
  }, undefined, undefined, {});
  const executeTools = executeResult.details.tasks[0].definition.executorToolCatalog?.allowedToolCatalog ?? [];
  assert.ok(executeTools.length > 0, "execute tasks carry a canonical tool catalog");
  assert.ok(executeTools.includes(APPLY_PATCH_TOOL_NAME), "execute workers must inherit ApplyPatch");
  await manager.shutdown();
});

// ---------------------------------------------------------------------------
// Request validation: canonical envelope only
// ---------------------------------------------------------------------------

test("legacy structured operation requests are rejected before any filesystem mutation", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await writeFile(join(dir, "existing.txt"), "keep\n", "utf8");
    for (const params of [
      { operation: { type: "create_file", path: "created.txt", diff: "+x\n" } },
      { operation: { type: "update_file", path: "existing.txt", diff: "-keep\n+kept\n" } },
      { operation: { type: "delete_file", path: "existing.txt" } },
    ]) {
      await assert.rejects(
        execute(params, { cwd: dir }),
        /the legacy structured 'operation' argument is no longer supported/,
      );
    }
    // A request carrying both arguments is rejected as well.
    await assert.rejects(
      execute({ patch: envelope("*** Add File: created.txt", "+x"), operation: { type: "delete_file", path: "existing.txt" } }, { cwd: dir }),
      /exactly one argument/,
    );
    // Rejection happens before any mutation.
    assert.equal(await readFile(join(dir, "existing.txt"), "utf8"), "keep\n");
    await assert.rejects(lstat(join(dir, "created.txt")));
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("requests without the patch argument are rejected before any filesystem mutation", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await assert.rejects(execute({}, { cwd: dir }), /exactly one argument/);
    await assert.rejects(execute("not an object", { cwd: dir }), /object with a patch argument/);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

test("create_file commit refuses to overwrite a concurrently created target", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    // Simulate the check/commit race: a competing process creates the target
    // after staging but before the no-overwrite commit.
    const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
    const originalLink = fsp.link;
    fsp.link = async (temp: import("node:fs").PathLike, destination: import("node:fs").PathLike) => {
      await fsp.writeFile(destination, "competitor\n", "utf8");
      return originalLink(temp, destination);
    };
    try {
      await assert.rejects(
        execute({ patch: envelope("*** Add File: raced.txt", "+mine") }, { cwd: dir }),
        /already exists; create_file refuses to overwrite/,
      );
    } finally {
      fsp.link = originalLink;
    }
    assert.equal(await readFile(join(dir, "raced.txt"), "utf8"), "competitor\n", "competing bytes must not be overwritten");
    const files = await readdir(dir);
    assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "staged temporary files must be cleaned up");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("create_file writes new files and rejects create-over-existing, directories, and binary diffs", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    const created = await execute({ patch: envelope("*** Add File: src/new.txt", "+hello", "+world") }, { cwd: dir });
    assert.match(created.content[0].text, /Success\. Updated the following files:\nA src\/new\.txt/);
    // Codex newline semantics: every Add File line contributes the line plus
    // a newline.
    assert.equal(await readFile(join(dir, "src/new.txt"), "utf8"), "hello\nworld\n");
    assert.equal(created.details.operation, "create_file");
    assert.equal(created.details.mutated, true);

    // A bare '+' line contributes an empty line.
    const trailing = await execute({ patch: envelope("*** Add File: src/eol.txt", "+a", "+") }, { cwd: dir });
    assert.equal(await readFile(join(dir, "src/eol.txt"), "utf8"), "a\n\n");
    void trailing;

    await assert.rejects(
      execute({ patch: envelope("*** Add File: src/new.txt", "+again") }, { cwd: dir }),
      /already exists/,
    );
    await assert.rejects(
      execute({ patch: envelope("*** Add File: src", "+x") }, { cwd: dir }),
      /already exists and is a directory/,
    );
    await assert.rejects(
      execute({ patch: envelope("*** Add File: bin.bin", "+\u0000") }, { cwd: dir }),
      /binary content/,
    );
    // A non-plus line inside an Add File section is not a valid hunk header.
    await assert.rejects(
      execute({ patch: envelope("*** Add File: bad.txt", "no prefix") }, { cwd: dir }),
      /not a valid hunk header/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("update_file patches content and preserves mode, BOM, line endings, and trailing newlines", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    const target = join(dir, "notes.txt");
    await writeFile(target, "\uFEFFone\r\ntwo\r\n", "utf8");
    await chmod(target, 0o600);

    const result = await execute(updateEnvelope("notes.txt", "@@ one\n-two\n+TWO\n"), { cwd: dir });
    assert.match(result.content[0].text, /Success\. Updated the following files:\nM notes\.txt/);
    const updated = await readFile(target, "utf8");
    assert.equal(updated, "\uFEFFone\r\nTWO\r\n");
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
    assert.equal(result.details.changed, true);
    assert.ok(typeof result.details.finalDiff === "string" && result.details.finalDiff.includes("-two"));

    // No-change update is a successful no-op that does not replace the file.
    const beforeNoop = await lstat(target);
    const noop = await execute(updateEnvelope("notes.txt", " one\n TWO\n"), { cwd: dir });
    assert.equal(noop.details.changed, false);
    assert.equal(noop.details.mutated, false);
    assert.equal((await lstat(target)).ino, beforeNoop.ino);

    // Trailing newline state survives EOF appends.
    const noTrailing = join(dir, "tail.txt");
    await writeFile(noTrailing, "a\nb", "utf8");
    await execute(updateEnvelope("tail.txt", "@@\n+c\n*** End of File"), { cwd: dir });
    assert.equal(await readFile(noTrailing, "utf8"), "a\nb\nc");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("update_file preserves exact permission bits independent of the process umask", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    const target = join(dir, "perm.txt");
    await writeFile(target, "one\ntwo\n", "utf8");
    await chmod(target, 0o666);
    await execute(updateEnvelope("perm.txt", "-two\n+TWO\n"), { cwd: dir });
    assert.equal((await lstat(target)).mode & 0o777, 0o666);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("line counts include content lines that themselves start with -- or ++", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await writeFile(join(dir, "flags.txt"), "a\n-- off\n++ on\nb\n", "utf8");
    const result = await execute(updateEnvelope("flags.txt", "@@ a\n--- off\n-++ on\n+done\n"), { cwd: dir });
    assert.equal(await readFile(join(dir, "flags.txt"), "utf8"), "a\ndone\nb\n");
    assert.equal(result.details.addedLines, 1);
    assert.equal(result.details.removedLines, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("update_file failures are atomic and leave no temporary files", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    const target = join(dir, "code.py");
    const original = "one\ntwo\nthree\n";
    await writeFile(target, original, "utf8");

    await assert.rejects(execute(updateEnvelope("code.py", "@@ one\n-missing\n+replacement\n"), { cwd: dir }), /Invalid Context/);
    assert.equal(await readFile(target, "utf8"), original);
    const files = await readdir(dir);
    assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "temporary files must be cleaned up");
    assert.deepEqual(files.sort(), ["code.py"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("update_file reports binary and missing-target failures informatively", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await writeFile(join(dir, "blob.bin"), Buffer.from([0x00, 0xff, 0x0a]));
    await assert.rejects(execute(updateEnvelope("blob.bin", "-x\n+y\n"), { cwd: dir }), /binary or not valid UTF-8/);
    await assert.rejects(execute(updateEnvelope("missing.txt", "-x\n+y\n"), { cwd: dir }), /does not exist/);
    await mkdir(join(dir, "sub"), { recursive: true });
    await assert.rejects(execute(updateEnvelope("sub", "-x\n+y\n"), { cwd: dir }), /not a regular file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete_file removes files and rejects missing or non-regular targets", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await writeFile(join(dir, "gone.txt"), "bye\n", "utf8");
    const result = await execute({ patch: envelope("*** Delete File: gone.txt") }, { cwd: dir });
    assert.match(result.content[0].text, /Success\. Updated the following files:\nD gone\.txt/);
    await assert.rejects(lstat(join(dir, "gone.txt")));
    // Deletions of reasonably sized text files expose a bounded final diff.
    assert.ok(typeof result.details.finalDiff === "string");
    assert.match(result.details.finalDiff as string, /\+\+\+ \/dev\/null/);
    assert.match(result.details.finalDiff as string, /-bye/);
    assert.equal(result.details.removedLines, 1);
    await assert.rejects(execute({ patch: envelope("*** Delete File: gone.txt") }, { cwd: dir }), /does not exist/);
    await mkdir(join(dir, "folder"), { recursive: true });
    await assert.rejects(execute({ patch: envelope("*** Delete File: folder") }, { cwd: dir }), /not a regular file/);

    // Binary/non-UTF-8 files are rejected before mutation: ApplyPatch only
    // handles UTF-8 text files.
    await writeFile(join(dir, "blob.bin"), Buffer.from([0x00, 0xff, 0x0a]));
    await assert.rejects(
      execute({ patch: envelope("*** Delete File: blob.bin") }, { cwd: dir }),
      /binary or not valid UTF-8/,
    );
    assert.equal((await readFile(join(dir, "blob.bin"))).length, 3, "the binary file must remain");

    // Valid UTF-8 containing a NUL byte is also refused.
    await writeFile(join(dir, "nul.txt"), "a\u0000b\n", "utf8");
    await assert.rejects(
      execute({ patch: envelope("*** Delete File: nul.txt") }, { cwd: dir }),
      /refusing to delete binary content \(NUL byte\)/,
    );
    await assert.doesNotReject(lstat(join(dir, "nul.txt")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete_file aborts before unlinking when cancellation arrives during validation", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    const target = join(dir, "late-abort.txt");
    await writeFile(target, "keep\n", "utf8");
    const controller = new AbortController();
    // Cancellation arrives while the source is being read for validation.
    const fsp = require("node:fs/promises") as { readFile: (path: unknown, options?: unknown) => Promise<unknown> };
    const originalReadFile = fsp.readFile;
    fsp.readFile = async (path: unknown, options?: unknown) => {
      controller.abort(new Error("cancelled during validation"));
      return originalReadFile(path, options);
    };
    try {
      await assert.rejects(
        execute({ patch: envelope("*** Delete File: late-abort.txt") }, { cwd: dir, signal: controller.signal }),
        /cancel|abort/i,
      );
    } finally {
      fsp.readFile = originalReadFile;
    }
    assert.equal(await readFile(target, "utf8"), "keep\n", "the file must survive a cancellation during validation");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("update_file with moveTo patches and atomically renames within the workspace", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await writeFile(join(dir, "old.txt"), "one\ntwo\n", "utf8");
    const result = await execute(updateEnvelope("old.txt", "-one\n+FIRST\n", "nested/new.txt"), { cwd: dir });
    // Upstream reports a moved file under its source path as modified.
    assert.match(result.content[0].text, /Success\. Updated the following files:\nM old\.txt/);
    assert.equal(await readFile(join(dir, "nested/new.txt"), "utf8"), "FIRST\ntwo\n");
    await assert.rejects(lstat(join(dir, "old.txt")));
    assert.equal(result.details.moveTo, "nested/new.txt");
    // The final diff reflects the rename with both source and destination.
    assert.match(result.details.finalDiff as string, /rename from old\.txt/);
    assert.match(result.details.finalDiff as string, /rename to nested\/new\.txt/);

    await writeFile(join(dir, "a.txt"), "x\n", "utf8");
    await writeFile(join(dir, "b.txt"), "y\n", "utf8");
    await assert.rejects(execute(updateEnvelope("a.txt", "-x\n+X\n", "b.txt"), { cwd: dir }), /already exists/);
    await assert.rejects(execute(updateEnvelope("a.txt", "-x\n+X\n", "a.txt"), { cwd: dir }), /resolves to the same file/);
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "x\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("move destination preparation failure leaves the source file unchanged", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    const target = join(dir, "src.txt");
    const original = "one\ntwo\n";
    await writeFile(target, original, "utf8");
    // A regular file blocks the destination directory from being created.
    await writeFile(join(dir, "blocker"), "file\n", "utf8");

    // The destination cannot be prepared (an intermediate component is a
    // regular file); the rejection must happen before any mutation.
    await assert.rejects(
      execute(updateEnvelope("src.txt", "-one\n+FIRST\n", "blocker/dst.txt"), { cwd: dir }),
      (error: Error) => /intermediate path component is not a directory|moving to blocker\/dst\.txt failed/.test(error.message),
    );
    assert.equal(await readFile(target, "utf8"), original);
    await assert.rejects(lstat(join(dir, "blocker", "dst.txt")));
    const files = await readdir(dir);
    assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "temporary files must be cleaned up");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("move fails safely on filesystems without hard-link support", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await writeFile(join(dir, "src.txt"), "one\ntwo\n", "utf8");
    const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
    const originalLink = fsp.link;
    fsp.link = async () => {
      const error: NodeJS.ErrnoException = new Error("link unsupported (injected)");
      error.code = "ENOTSUP";
      throw error;
    };
    try {
      await assert.rejects(
        execute(updateEnvelope("src.txt", "-one\n+FIRST\n", "dst.txt"), { cwd: dir }),
        /moving to dst\.txt failed.*link unsupported/s,
      );
    } finally {
      fsp.link = originalLink;
    }
    // No rename fallback: the source must be preserved, no destination may
    // appear, and staged temporaries must be cleaned up.
    assert.equal(await readFile(join(dir, "src.txt"), "utf8"), "one\ntwo\n");
    await assert.rejects(lstat(join(dir, "dst.txt")));
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("create_file fails safely on filesystems without hard-link support", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
    const originalLink = fsp.link;
    fsp.link = async () => {
      const error: NodeJS.ErrnoException = new Error("link unsupported (injected)");
      error.code = "ENOTSUP";
      throw error;
    };
    try {
      await assert.rejects(
        execute({ patch: envelope("*** Add File: no-link.txt", "+x") }, { cwd: dir }),
        /link unsupported/,
      );
    } finally {
      fsp.link = originalLink;
    }
    await assert.rejects(lstat(join(dir, "no-link.txt")));
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("move commit failure leaves the source file unchanged and creates no destination", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    const target = join(dir, "src.txt");
    const original = "one\ntwo\n";
    await writeFile(target, original, "utf8");

    // Force the destination commit (link) to fail after staging succeeds.
    const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
    const originalLink = fsp.link;
    let linkAttempts = 0;
    fsp.link = async () => {
      linkAttempts += 1;
      const error: NodeJS.ErrnoException = new Error("link failed (injected)");
      error.code = "EEXIST";
      throw error;
    };
    try {
      await assert.rejects(
        execute(updateEnvelope("src.txt", "-one\n+FIRST\n", "dst.txt"), { cwd: dir }),
        /moving to dst\.txt failed and the source was left unchanged/,
      );
    } finally {
      fsp.link = originalLink;
    }
    assert.ok(linkAttempts > 0, "the destination commit was attempted");
    assert.equal(await readFile(target, "utf8"), original, "source bytes must be unchanged after a failed move commit");
    await assert.rejects(lstat(join(dir, "dst.txt")));
    const files = await readdir(dir);
    assert.deepEqual(files.filter((name) => name.endsWith(".tmp")), [], "staged temporary files must be cleaned up");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Path access parity with native edit/write
// ---------------------------------------------------------------------------

test("paths outside the workspace are supported with native edit/write parity", async () => {
  const dir = await tempWorkspace();
  const outside = await tempWorkspace();
  try {
    const { execute } = harness();

    // Create with a nested directory chain at an absolute outside path.
    const outsideFile = join(outside, "scratch", "created.txt");
    await execute({ patch: envelope("*** Add File: " + outsideFile, "+created") }, { cwd: dir });
    assert.equal(await readFile(outsideFile, "utf8"), "created\n");

    // Update an existing outside file via an absolute path.
    const existing = join(outside, "victim.txt");
    await writeFile(existing, "original\n", "utf8");
    await execute(updateEnvelope(existing, "-original\n+new\n"), { cwd: dir });
    assert.equal(await readFile(existing, "utf8"), "new\n");

    // Relative paths that traverse out of the cwd resolve like native edit.
    await mkdir(join(dir, "sub"), { recursive: true });
    await execute(updateEnvelope("../" + join("..", basename(outside), "victim.txt"), "-new\n+newer\n"), { cwd: join(dir, "sub") });
    assert.equal(await readFile(existing, "utf8"), "newer\n");

    // Move within the outside directory.
    const moved = join(outside, "moved.txt");
    const result = await execute(updateEnvelope(existing, "-newer\n+final\n", moved), { cwd: dir });
    assert.equal(await readFile(moved, "utf8"), "final\n");
    await assert.rejects(lstat(existing));
    assert.equal(result.details.moveTo, moved);

    // Delete the outside file.
    await execute({ patch: envelope("*** Delete File: " + moved) }, { cwd: dir });
    await assert.rejects(lstat(moved));

    // Absolute paths inside the workspace remain allowed.
    await execute({ patch: envelope("*** Add File: " + join(dir, "inside.txt"), "+ok") }, { cwd: dir });
    assert.equal(await readFile(join(dir, "inside.txt"), "utf8"), "ok\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("symlinked paths are followed like native edit write-through access", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions vary on Windows");
  const dir = await tempWorkspace();
  const outside = await tempWorkspace();
  try {
    const { execute } = harness();
    const target = join(outside, "target.txt");
    await writeFile(target, "outside\n", "utf8");
    await symlink(target, join(dir, "link.txt"));

    // Update through the symlink writes the target file and preserves the link
    // (native edit writeFile parity: write-through, no link replacement).
    await execute(updateEnvelope("link.txt", "-outside\n+inside\n"), { cwd: dir });
    assert.equal(await readFile(target, "utf8"), "inside\n");
    assert.equal((await lstat(join(dir, "link.txt"))).isSymbolicLink(), true, "the symlink must survive an update");

    // A symlinked directory component resolves the same way.
    await mkdir(join(outside, "docs"), { recursive: true });
    await writeFile(join(outside, "docs", "nested.txt"), "outside\n", "utf8");
    await symlink(join(outside, "docs"), join(dir, "docs-link"));
    await execute(updateEnvelope("docs-link/nested.txt", "-outside\n+inside\n"), { cwd: dir });
    assert.equal(await readFile(join(outside, "docs", "nested.txt"), "utf8"), "inside\n");

    // Delete through the symlink removes the link itself (rm semantics); the
    // target file remains, so no content deletion diff is fabricated.
    const deleteResult = await execute({ patch: envelope("*** Delete File: link.txt") }, { cwd: dir });
    await assert.rejects(lstat(join(dir, "link.txt")));
    assert.equal(await readFile(target, "utf8"), "inside\n", "the symlink target must survive a link deletion");
    assert.equal(deleteResult.details.finalDiff, undefined);
    assert.equal(deleteResult.details.removedLines, 0);
    assert.equal(deleteResult.details.bytes, 0);

    // create_file still refuses an existing path, including an existing symlink.
    await symlink(target, join(dir, "exists.txt"));
    await assert.rejects(
      execute({ patch: envelope("*** Add File: exists.txt", "+x") }, { cwd: dir }),
      /already exists/,
    );

    // A dangling symlink is reported truthfully as a missing target.
    await symlink(join(outside, "missing.txt"), join(dir, "dangling.txt"));
    await assert.rejects(execute(updateEnvelope("dangling.txt", "-x\n+y\n"), { cwd: dir }), /dangling symlink|does not exist/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("tilde paths expand to the home directory like native edit/write without touching the real home", async () => {
  const dir = await tempWorkspace();
  const fakeHome = await tempWorkspace();
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  try {
    // Synthetic home: point the platform's homedir() source at a fresh temp
    // directory so the production entry point never touches the real home.
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome; // win32's homedir source
    // Fail closed before any mutation if the override is not in effect.
    assert.equal(homedir(), fakeHome, "synthetic home must be in effect before any mutation");
    const { execute } = harness();

    // Add File with ~/... creates under the home directory, not a literal ~.
    await execute({ patch: envelope("*** Add File: ~/notes/hello.txt", "+hi") }, { cwd: dir });
    assert.equal(await readFile(join(fakeHome, "notes", "hello.txt"), "utf8"), "hi\n");
    await assert.rejects(lstat(join(dir, "~")), "no literal ~ directory may be created in the cwd");

    // Update and delete resolve ~/... against the same home.
    await execute(updateEnvelope("~/notes/hello.txt", "-hi\n+there\n"), { cwd: dir });
    assert.equal(await readFile(join(fakeHome, "notes", "hello.txt"), "utf8"), "there\n");
    await execute({ patch: envelope("*** Delete File: ~/notes/hello.txt") }, { cwd: dir });
    await assert.rejects(lstat(join(fakeHome, "notes", "hello.txt")));

    // `~user` is not a home prefix (native parity): it stays relative to the cwd.
    await execute({ patch: envelope("*** Add File: ~other/rel.txt", "+x") }, { cwd: dir });
    assert.equal(await readFile(join(dir, "~other", "rel.txt"), "utf8"), "x\n");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    await rm(dir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

test("a move through a symlinked source materializes the destination, removes the link, and keeps the target's old content", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions vary on Windows");
  const dir = await tempWorkspace();
  const outside = await tempWorkspace();
  try {
    const { execute } = harness();
    const target = join(outside, "target.txt");
    await writeFile(target, "one\ntwo\n", "utf8");
    await symlink(target, join(dir, "link.txt"));

    const result = await execute(updateEnvelope("link.txt", "-two\n+TWO\n", "moved.txt"), { cwd: dir });

    // The destination materializes the patched content...
    assert.equal(await readFile(join(dir, "moved.txt"), "utf8"), "one\nTWO\n");
    // ...the original link is removed...
    await assert.rejects(lstat(join(dir, "link.txt")));
    // ...and the target file retains its old content (a move does not write through).
    assert.equal(await readFile(target, "utf8"), "one\ntwo\n");

    // Truthful result and evidence: reported as a move of the source path with
    // the modified rename diff, pointing at the materialized destination.
    assert.equal(result.content[0].text, ["Success. Updated the following files:", "M link.txt"].join("\n"));
    assert.equal(result.details.moveTo, "moved.txt");
    assert.equal(result.details.absolutePath, join(dir, "moved.txt"));
    assert.match(result.details.finalDiff, /rename from link\.txt/);
    assert.match(result.details.finalDiff, /rename to moved\.txt/);
    assert.match(result.details.finalDiff, /-two/);
    assert.match(result.details.finalDiff, /\+TWO/);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a symlink replaced after validation is not removed by delete_file", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions vary on Windows");
  const dir = await tempWorkspace();
  const outside = await tempWorkspace();
  try {
    const { execute } = harness();
    const target = join(outside, "target.txt");
    await writeFile(target, "outside\n", "utf8");
    const link = join(dir, "link.txt");
    await symlink(target, link);

    // Deterministic replacement seam: once the source content has been read
    // (validation is complete), replace the named link with a regular file
    // before the deletion revalidates and unlinks. No timing involved. The
    // production engine reads through the realpath'd target, so match that.
    const realTarget = await realpath(target);
    const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
    const originalReadFile = fsp.readFile;
    fsp.readFile = (async (path: import("node:fs").PathLike) => {
      const result = await originalReadFile(path);
      if (String(path) === realTarget) {
        await unlink(link);
        await writeFile(link, "replacement\n", "utf8");
      }
      return result;
    }) as unknown as typeof fsp.readFile;
    try {
      await assert.rejects(
        execute({ patch: envelope("*** Delete File: link.txt") }, { cwd: dir }),
        /was replaced with a non-symlink after validation; refusing to remove the replacement/,
      );
    } finally {
      fsp.readFile = originalReadFile;
    }
    // The unvalidated replacement survives; the validated target is untouched.
    assert.equal((await lstat(link)).isSymbolicLink(), false);
    assert.equal(await readFile(link, "utf8"), "replacement\n");
    assert.equal(await readFile(target, "utf8"), "outside\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("a symlink replaced after validation is not removed by a moveTo source removal", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions vary on Windows");
  const dir = await tempWorkspace();
  const outside = await tempWorkspace();
  try {
    const { execute } = harness();
    const target = join(outside, "target.txt");
    await writeFile(target, "one\ntwo\n", "utf8");
    const other = join(outside, "other.txt");
    await writeFile(other, "other content\n", "utf8");
    const link = join(dir, "link.txt");
    await symlink(target, link);

    // Deterministic replacement seam: once the source content has been read
    // (validation is complete), replace the named link with a different
    // symlink before the move commits its destination and removes the source.
    // The production engine reads through the realpath'd target, so match that.
    const realTarget = await realpath(target);
    const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
    const originalReadFile = fsp.readFile;
    fsp.readFile = (async (path: import("node:fs").PathLike) => {
      const result = await originalReadFile(path);
      if (String(path) === realTarget) {
        await unlink(link);
        await symlink(other, link);
      }
      return result;
    }) as unknown as typeof fsp.readFile;
    try {
      await assert.rejects(
        execute(updateEnvelope("link.txt", "-two\n+TWO\n", "moved.txt"), { cwd: dir }),
        (error: Error) => {
          assert.match(error.message, /failed at operation 1 \(update_file link\.txt \(moveTo moved\.txt\)\)/);
          assert.match(error.message, /both files remain in place/);
          assert.match(error.message, /refusing to remove/);
          assert.match(error.message, /Uncertain effects of the failed operation: destination 'moved\.txt' was created; source 'link\.txt' was left in place/);
          return true;
        },
      );
    } finally {
      fsp.readFile = originalReadFile;
    }
    // The destination carries the patched content; the replacement link and
    // both files it could reach remain exactly as the external actor left them.
    assert.equal(await readFile(join(dir, "moved.txt"), "utf8"), "one\nTWO\n");
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(await realpath(link), await realpath(other));
    assert.equal(await readFile(other, "utf8"), "other content\n");
    assert.equal(await readFile(target, "utf8"), "one\ntwo\n", "the validated target must not be overwritten or removed");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sequential declaration, rendering, evidence, and abort behavior
// ---------------------------------------------------------------------------

test("ApplyPatch renders compact call and result summaries with supported theme colors and diff detail", () => {
  const supportedColors = new Set([
    "accent", "error", "muted", "success", "toolDiffAdded", "toolDiffContext", "toolDiffRemoved", "toolTitle",
  ]);
  const theme = {
    bold: (text: string) => `B(${text})`,
    fg: (color: string, text: string) => {
      assert.ok(supportedColors.has(color), `unsupported theme color: ${color}`);
      return `F(${color})[${text}]`;
    },
  };
  const call = renderApplyPatchCall(
    { patch: envelope("*** Update File: src/app.ts", "*** Move to: src/main.ts", "@@", "-a") },
    theme,
  ) as { render(width: number): string[] };
  const callLine = call.render(120).join("\n");
  assert.match(callLine, /ApplyPatch/);
  // The compact call header summarizes the envelope: operation count plus
  // the first file paths (move destinations are not part of that scan).
  assert.match(callLine, /1 file operation\(s\) · src\/app\.ts/);

  // Canonical collapsed card: bounded header plus per-file inventory, with
  // no raw summary block and no legacy bounded diff previews. Expansion (the
  // dedicated renderer tests cover the native-context arm) carries the full
  // retained diffs with diff coloring; this direct call has no native args,
  // so the retained requestedDiff fallback is exercised in the expanded arm.
  const rendered = renderApplyPatchResult({
    content: [{ type: "text", text: "ApplyPatch updated src/app.ts (+1 −1 lines)." }],
    details: { requestedDiff: "-one\n+uno\n two\n" },
    isError: false,
  }, {}, theme) as { render(width: number): string[] };
  const lines = rendered.render(160);
  assert.match(lines[0], /ApplyPatch · succeeded/);
  assert.match(lines.join("\n"), /updated src\/app\.ts/);
  assert.doesNotMatch(lines.join("\n"), /Final diff:|Requested diff:/);

  const expandedRendered = renderExpandedApplyPatchResult({
    content: [{ type: "text", text: "ApplyPatch updated src/app.ts (+1 −1 lines)." }],
    details: { requestedDiff: "-one\n+uno\n two\n" },
    isError: false,
  }, {}, theme) as { render(width: number): string[] };
  const expandedText = expandedRendered.render(200).join("\n");
  assert.match(expandedText, /Requested patch retained with the result/);
  assert.match(expandedText, /\[-one\]/);
  assert.match(expandedText, /\[\+uno\]/);
  assert.match(expandedText, /\[ two\]/);

  // Moves expand the complete final diff with rename from/to headers.
  const moveValue = {
    content: [{ type: "text", text: "ApplyPatch updated src/app.ts and moved it to src/main.ts (+1 −1 lines)." }],
    details: {
      requestedDiff: "-one\n+uno\n",
      finalDiff: [
        "diff --git a/src/app.ts b/src/main.ts",
        "rename from src/app.ts",
        "rename to src/main.ts",
        "--- a/src/app.ts",
        "+++ b/src/main.ts",
        "@@ -1 +1 @@",
        "-one",
        "+uno",
      ].join("\n"),
    },
    isError: false,
  };
  const moveLines = renderExpandedApplyPatchResult(moveValue, {}, theme).render(200).join("\n");
  assert.match(moveLines, /Final diff:/);
  assert.match(moveLines, /rename from src\/app\.ts/);
  assert.match(moveLines, /rename to src\/main\.ts/);

  // Deletions expand the final deletion diff; there is no requested patch to
  // fall back to, and the renderer says so instead of inventing one.
  const deleteValue = {
    content: [{ type: "text", text: "ApplyPatch deleted gone.txt." }],
    details: { finalDiff: "diff --git a/gone.txt b/gone.txt\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye" },
    isError: false,
  };
  const deleteLines = renderExpandedApplyPatchResult(deleteValue, {}, theme).render(200).join("\n");
  assert.match(deleteLines, /Final diff:/);
  assert.match(deleteLines, /toolDiffRemoved\)\[-bye\]/);
  assert.match(deleteLines, /Requested patch was not available in the native render context\./);

  // Expanded diffs are never line-capped: every line survives expansion.
  const longDiff = ["@@ -1 +1 @@", ...Array.from({ length: 30 }, (_, index) => `+line ${index}`)].join("\n");
  const longValue = {
    content: [{ type: "text", text: "ApplyPatch updated big.txt (+30 −0 lines)." }],
    details: { requestedDiff: longDiff, finalDiff: longDiff },
    isError: false,
  };
  const longExpanded = renderExpandedApplyPatchResult(longValue, {}, theme).render(200).join("\n");
  for (let index = 0; index < 30; index += 1) {
    assert.ok(longExpanded.includes(`+line ${index}`));
  }
  assert.doesNotMatch(longExpanded, /more diff line\(s\)/);

  const errorValue = { content: [{ type: "text", text: "ApplyPatch failed: boom" }], isError: true };
  const errorRendered = renderApplyPatchResult(errorValue, {}, theme) as { render(width: number): string[] };
  assert.match(errorRendered.render(120)[0], /ApplyPatch · failed/);
  assert.match(errorRendered.render(120).join("\n"), /error\)\[ApplyPatch failed: boom\]/);
});

test("ApplyPatch call evidence pre-captures envelope path and move destination mutation candidates", async () => {
  const dir = await tempWorkspace();
  try {
    await writeFile(join(dir, "existing.txt"), "before\n", "utf8");
    const state = createEvidenceState();
    const input = { patch: envelope("*** Update File: existing.txt", "*** Move to: renamed.txt", "-before", "+after") };
    const extracted = extractCandidatePaths("ApplyPatch", input);
    assert.deepEqual(extracted.paths.map((candidate) => candidate.path).sort(), ["existing.txt", "renamed.txt"]);
    assert.ok(extracted.paths.every((candidate) => candidate.source.startsWith("ApplyPatch:patch")));
    assert.ok(extracted.riskSignals.includes("apply_patch_mutation"));

    assert.equal(shouldRecordToolCallEvidence("ApplyPatch"), true);
    assert.equal(shouldRecordToolResultEvidence("ApplyPatch", false), true);

    await recordToolCallEvidence({
      state,
      cwd: dir,
      toolName: "ApplyPatch",
      toolInput: input,
      snapshotOptions: { maxFileBytes: 100_000, maxSnapshotBytes: 1_000_000 },
      exchangeSequence: 1,
    });
    const paths = [...state.candidates.values()].map((candidate) => candidate.path).sort();
    assert.deepEqual(paths, ["existing.txt", "renamed.txt"]);
    assert.equal(state.candidates.get(join(dir, "existing.txt"))?.baseline?.content, "before\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ApplyPatch evidence normalizes leading @ markers on envelope path and move destination", async () => {
  const dir = await tempWorkspace();
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "before\n", "utf8");
    const input = { patch: envelope("*** Update File: @src/a.ts", "*** Move to: @src/b.ts", "-before", "+after") };

    // The leading '@' convention marker is stripped exactly like the tool's
    // own path handling, so candidates point at the mutated files.
    const extracted = extractCandidatePaths("ApplyPatch", input);
    assert.deepEqual(extracted.paths.map((candidate) => candidate.path).sort(), ["src/a.ts", "src/b.ts"]);

    const state = createEvidenceState();
    await recordToolCallEvidence({
      state,
      cwd: dir,
      toolName: "ApplyPatch",
      toolInput: input,
      snapshotOptions: { maxFileBytes: 100_000, maxSnapshotBytes: 1_000_000 },
      exchangeSequence: 1,
    });
    assert.ok(state.candidates.get(join(dir, "src", "a.ts")), "normalized @path candidate missing");
    assert.equal(state.candidates.get(join(dir, "src", "a.ts"))?.baseline?.content, "before\n");
    assert.ok(state.candidates.has(join(dir, "src", "b.ts")), "normalized @moveTo candidate missing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ApplyPatch evidence resolves ~ envelope paths against the home directory", async () => {
  const dir = await tempWorkspace();
  const fakeHome = await tempWorkspace();
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  try {
    // Synthetic home (same pattern as the tilde resolution test): candidate
    // resolution must apply the tool's own home-expansion rule, so the
    // pre-capture points at the file ApplyPatch actually mutates.
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome; // win32's homedir source
    // Fail closed before any mutation if the override is not in effect.
    assert.equal(homedir(), fakeHome, "synthetic home must be in effect before any mutation");
    const state = createEvidenceState();
    await recordToolCallEvidence({
      state,
      cwd: dir,
      toolName: "ApplyPatch",
      toolInput: { patch: envelope("*** Add File: ~/notes/hello.txt", "+x") },
      snapshotOptions: { maxFileBytes: 100_000, maxSnapshotBytes: 1_000_000 },
      exchangeSequence: 1,
    });
    const candidate = state.candidates.get(join(fakeHome, "notes", "hello.txt"));
    assert.ok(candidate, "~/... candidate must resolve against the home directory");
    // The stored label keeps the envelope spelling; only the resolution expands.
    assert.equal(candidate?.path, "~/notes/hello.txt");
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    await rm(dir, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  }
});

for (const obstacle of ["conflict gate", "landing lease"] as const) {
  test(`ApplyPatch matches foreground edit without waiting for a ${obstacle}`, { timeout: 3_000 }, async (t) => {
    const dir = await tempWorkspace();
    const release = obstacle === "conflict gate"
      ? sourceMutationCoordinator.block(dir, "Resolve this foreground conflict first")
      : await sourceMutationCoordinator.acquire(dir);
    try {
      const target = join(dir, "conflict.txt");
      await writeFile(target, "unresolved\n");
      const { execute } = harness();
      await execute(updateEnvelope("conflict.txt", "-unresolved\n+resolved\n"), { cwd: dir, signal: t.signal });
      assert.equal(await readFile(target, "utf8"), "resolved\n");
      if (obstacle === "conflict gate") {
        assert.equal(sourceMutationCoordinator.blocked(dir).blocked, true, "foreground editing must not clear the automatic landing gate");
      }
      const cancelled = new AbortController();
      cancelled.abort(new Error("cancelled foreground patch"));
      await assert.rejects(execute(updateEnvelope("conflict.txt", "-resolved\n+wrong\n"), { cwd: dir, signal: cancelled.signal }), /cancel/i);
      assert.equal(await readFile(target, "utf8"), "resolved\n");
    } finally {
      release();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("ApplyPatch aborts before mutating when the signal is already aborted", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    const target = join(dir, "abort.txt");
    await writeFile(target, "original\n", "utf8");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      execute(updateEnvelope("abort.txt", "-original\n+new\n"), { cwd: dir, signal: controller.signal }),
      (error: Error) => /cancel|abort/i.test(error.message),
    );
    assert.equal(await readFile(target, "utf8"), "original\n");

    await assert.rejects(
      execute({ patch: envelope("*** Add File: never.txt", "+x") }, { cwd: dir, signal: controller.signal }),
      (error: Error) => /cancel|abort/i.test(error.message),
    );
    await assert.rejects(lstat(join(dir, "never.txt")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Canonical envelope: sequential application and partial-failure reporting
// ---------------------------------------------------------------------------

function envelope(...lines: string[]): string {
  return ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
}

test("a mixed multi-file envelope applies create/update/rename/delete in order", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await writeFile(join(dir, "keep.txt"), "one\ntwo\n", "utf8");
    await writeFile(join(dir, "old.txt"), "one\ntwo\n", "utf8");
    await writeFile(join(dir, "drop.txt"), "bye\n", "utf8");

    const patch = envelope(
      "*** Add File: src/new.txt",
      "+hello",
      "+world",
      "*** Update File: keep.txt",
      "@@ one",
      "-two",
      "+TWO",
      "*** Update File: old.txt",
      "*** Move to: moved/old.txt",
      "-one",
      "+FIRST",
      "*** Delete File: drop.txt",
    );
    const result = await execute({ patch }, { cwd: dir });
    // The model-facing success text follows the upstream Codex print_summary
    // format exactly (grouped A/M/D lines, patch path spelling).
    assert.equal(
      result.content[0].text,
      ["Success. Updated the following files:", "A src/new.txt", "M keep.txt", "M old.txt", "D drop.txt"].join("\n"),
    );

    // Codex newline semantics: every Add File line contributes line + "\n".
    assert.equal(await readFile(join(dir, "src/new.txt"), "utf8"), "hello\nworld\n");
    assert.equal(await readFile(join(dir, "keep.txt"), "utf8"), "one\nTWO\n");
    assert.equal(await readFile(join(dir, "moved/old.txt"), "utf8"), "FIRST\ntwo\n");
    await assert.rejects(lstat(join(dir, "old.txt")));
    await assert.rejects(lstat(join(dir, "drop.txt")));

    const operations = result.details.operations as Array<Record<string, any>>;
    assert.equal(operations.length, 4);
    assert.deepEqual(
      operations.map((op) => op.operation),
      ["create_file", "update_file", "update_file", "delete_file"],
    );
    assert.equal(operations[2]!.moveTo, "moved/old.txt");
    // The combined final diff carries the accumulated delta of every applied
    // operation.
    const finalDiff = result.details.finalDiff as string;
    assert.match(finalDiff, /diff --git a\/src\/new\.txt/);
    assert.match(finalDiff, /rename from old\.txt/);
    assert.match(finalDiff, /\+\+\+ \/dev\/null/);
    assert.equal(result.details.mutated, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failing later operation stops the request and preserves earlier successes (7-of-8 style)", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await writeFile(join(dir, "keep.txt"), "one\ntwo\n", "utf8");
    await writeFile(join(dir, "never.txt"), "keep-me\n", "utf8");
    await writeFile(join(dir, "drop.txt"), "bye\n", "utf8");
    // bad.txt exists but does not contain the line the hunk wants to remove,
    // so operation 5 fails with an anchor mismatch.
    await writeFile(join(dir, "bad.txt"), "unrelated\n", "utf8");

    const patch = envelope(
      "*** Add File: a1.txt",
      "+one",
      "*** Add File: a2.txt",
      "+two",
      "*** Update File: keep.txt",
      "@@ one",
      "-two",
      "+TWO",
      "*** Delete File: drop.txt",
      "*** Update File: bad.txt",
      "@@ unrelated",
      "-missing",
      "+replacement",
      "*** Add File: a6.txt",
      "+six",
      "*** Add File: a7.txt",
      "+seven",
      "*** Delete File: never.txt",
    );

    await assert.rejects(
      execute({ patch }, { cwd: dir }),
      (error: Error) => {
        assert.match(error.message, /failed at operation 5 \(update_file bad\.txt\)/);
        assert.match(error.message, /4 earlier operation\(s\) still applied/);
        assert.match(error.message, /Applied: created a1\.txt \(4 bytes\); created a2\.txt \(4 bytes\); updated keep\.txt \(\+1 −1 lines\); deleted drop\.txt/);
        assert.match(error.message, /Invalid Context/);
        assert.match(error.message, /Not attempted: create_file a6\.txt, create_file a7\.txt, delete_file never\.txt/);
        return true;
      },
    );

    // Earlier successes remain applied exactly as committed.
    assert.equal(await readFile(join(dir, "a1.txt"), "utf8"), "one\n");
    assert.equal(await readFile(join(dir, "a2.txt"), "utf8"), "two\n");
    assert.equal(await readFile(join(dir, "keep.txt"), "utf8"), "one\nTWO\n");
    await assert.rejects(lstat(join(dir, "drop.txt")));
    // The failed operation left its target unchanged; the not-attempted
    // operations left no trace.
    assert.equal(await readFile(join(dir, "bad.txt"), "utf8"), "unrelated\n");
    await assert.rejects(lstat(join(dir, "a6.txt")));
    await assert.rejects(lstat(join(dir, "a7.txt")));
    assert.equal(await readFile(join(dir, "never.txt"), "utf8"), "keep-me\n");
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sequential same-path operations apply in order like Codex (no duplicate rejection)", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await writeFile(join(dir, "seq.txt"), "one\ntwo\n", "utf8");

    // The second update targets the state left by the first: its anchor only
    // matches after the first hunk has been applied.
    const patch = envelope(
      "*** Update File: seq.txt",
      "@@ one",
      "-two",
      "+TWO",
      "*** Update File: seq.txt",
      "@@ one",
      "-TWO",
      "+THREE",
    );
    const result = await execute({ patch }, { cwd: dir });
    assert.equal(
      result.content[0].text,
      ["Success. Updated the following files:", "M seq.txt", "M seq.txt"].join("\n"),
    );
    assert.equal(await readFile(join(dir, "seq.txt"), "utf8"), "one\nTHREE\n");

    // Create-then-update of the same path is equally valid.
    const fresh = envelope(
      "*** Add File: fresh.txt",
      "+v1",
      "*** Update File: fresh.txt",
      "-v1",
      "+v2",
    );
    await execute({ patch: fresh }, { cwd: dir });
    assert.equal(await readFile(join(dir, "fresh.txt"), "utf8"), "v2\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a malformed envelope is rejected before any mutation", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await assert.rejects(
      execute({ patch: "*** Add File: a.txt\n+x" }, { cwd: dir }),
      /first line of the patch must be '\*\*\* Begin Patch'/,
    );
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a missing target in a later operation fails only that operation (no all-path preflight)", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    const patch = envelope(
      "*** Add File: first.txt",
      "+one",
      "*** Update File: missing.txt",
      "-x",
      "+y",
    );
    await assert.rejects(
      execute({ patch }, { cwd: dir }),
      (error: Error) => {
        assert.match(error.message, /failed at operation 2 \(update_file missing\.txt\)/);
        assert.match(error.message, /does not exist/);
        assert.match(error.message, /1 earlier operation\(s\) still applied/);
        return true;
      },
    );
    // The earlier success is preserved: a request-wide preflight would have
    // rejected the whole envelope for the missing later target.
    assert.equal(await readFile(join(dir, "first.txt"), "utf8"), "one\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed move exposes its uncertain effects instead of rolling back", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    const sourceAbsolute = join(dir, "src.txt");
    await writeFile(sourceAbsolute, "one\ntwo\n", "utf8");

    // Force the source removal to fail after the destination commit succeeds.
    const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
    const originalUnlink = fsp.unlink;
    fsp.unlink = async (path: import("node:fs").PathLike) => {
      if (String(path) === sourceAbsolute) {
        const error: NodeJS.ErrnoException = new Error("unlink failed (injected)");
        error.code = "EIO";
        throw error;
      }
      return originalUnlink(path);
    };
    try {
      await assert.rejects(
        execute({ patch: envelope("*** Update File: src.txt", "*** Move to: dst.txt", "-one", "+FIRST") }, { cwd: dir }),
        (error: Error) => {
          assert.match(error.message, /failed at operation 1 \(update_file src\.txt \(moveTo dst\.txt\)\)/);
          assert.match(error.message, /both files remain in place/);
          assert.match(error.message, /Uncertain effects of the failed operation: destination 'dst\.txt' was created; source 'src\.txt' was left in place/);
          return true;
        },
      );
    } finally {
      fsp.unlink = originalUnlink;
    }
    // Both files remain, truthfully reported.
    assert.equal(await readFile(sourceAbsolute, "utf8"), "one\ntwo\n");
    assert.equal(await readFile(join(dir, "dst.txt"), "utf8"), "FIRST\ntwo\n");
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancellation during a later operation's commit preserves earlier successes", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await writeFile(join(dir, "keep.txt"), "one\ntwo\n", "utf8");
    const controller = new AbortController();

    // Cancellation arrives while the second operation's replacement is being
    // committed (rename is the update commit step) and the commit fails.
    const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
    const originalRename = fsp.rename;
    fsp.rename = async () => {
      controller.abort(new Error("cancelled mid-commit"));
      const error: NodeJS.ErrnoException = new Error("cancelled mid-commit");
      error.code = "EIO";
      throw error;
    };
    try {
      await assert.rejects(
        execute({ patch: envelope("*** Add File: a1.txt", "+one", "*** Update File: keep.txt", "@@ one", "-two", "+TWO") }, { cwd: dir, signal: controller.signal }),
        (error: Error) => {
          assert.match(error.message, /failed at operation 2 \(update_file keep\.txt\)/);
          assert.match(error.message, /cancelled mid-commit/);
          assert.match(error.message, /1 earlier operation\(s\) still applied/);
          return true;
        },
      );
    } finally {
      fsp.rename = originalRename;
    }
    assert.equal(await readFile(join(dir, "a1.txt"), "utf8"), "one\n", "the earlier success stays applied");
    assert.equal(await readFile(join(dir, "keep.txt"), "utf8"), "one\ntwo\n", "the cancelled operation left its target unchanged");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an external edit landing during the staging window is not overwritten by an update", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    const sourceAbsolute = join(dir, "race.txt");
    await writeFile(sourceAbsolute, "one\ntwo\n", "utf8");

    // Simulate a concurrent external edit landing while the replacement is
    // being staged: after the temporary file is written (stageFile chmods it
    // for updates) but before the rename commits.
    const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
    const originalChmod = fsp.chmod;
    fsp.chmod = async (path: import("node:fs").PathLike, mode: import("node:fs").Mode) => {
      if (String(path).endsWith(".tmp")) {
        await writeFile(sourceAbsolute, "external edit\n", "utf8");
      }
      return originalChmod(path, mode);
    };
    try {
      await assert.rejects(
        execute(updateEnvelope("race.txt", "-two\n+TWO\n"), { cwd: dir }),
        /changed after validation; refusing to overwrite concurrent edits/,
      );
    } finally {
      fsp.chmod = originalChmod;
    }
    assert.equal(await readFile(sourceAbsolute, "utf8"), "external edit\n", "the external content must survive");
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a directory-cleanup failure is reported without discarding the partial-failure accounting", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();

    // Operation 2 creates a directory chain, then fails at the commit; the
    // subsequent empty-directory cleanup also fails (EACCES). The accumulated
    // applied / failed / not-attempted accounting must still be reported.
    const fsp = require("node:fs/promises") as typeof import("node:fs/promises");
    const originalLink = fsp.link;
    const originalRmdir = fsp.rmdir;
    let failingCommitAttempted = false;
    fsp.link = async (source: import("node:fs").PathLike, destination: import("node:fs").PathLike) => {
      if (String(destination).endsWith("fail.txt")) {
        failingCommitAttempted = true;
        const error: NodeJS.ErrnoException = new Error("link failed (injected)");
        error.code = "EACCES";
        throw error;
      }
      return originalLink(source, destination);
    };
    fsp.rmdir = async () => {
      const error: NodeJS.ErrnoException = new Error("rmdir failed (injected)");
      error.code = "EACCES";
      throw error;
    };
    try {
      await assert.rejects(
        execute({ patch: envelope("*** Add File: ok.txt", "+one", "*** Add File: sub/dir/fail.txt", "+x") }, { cwd: dir }),
        (error: Error) => {
          assert.match(error.message, /failed at operation 2 \(create_file sub\/dir\/fail\.txt\)/);
          assert.match(error.message, /1 earlier operation\(s\) still applied/);
          assert.match(error.message, /Applied: created ok\.txt \(4 bytes\)/);
          assert.match(error.message, /Uncertain effects of the failed operation:/);
          assert.match(error.message, /directory '.*sub\/dir' could not be removed: rmdir failed \(injected\)/);
          return true;
        },
      );
    } finally {
      fsp.link = originalLink;
      fsp.rmdir = originalRmdir;
    }
    assert.ok(failingCommitAttempted, "the failing commit was attempted");
    // The earlier success remains applied; the failed create left no file.
    assert.equal(await readFile(join(dir, "ok.txt"), "utf8"), "one\n");
    await assert.rejects(lstat(join(dir, "sub/dir/fail.txt")));
    // Cleanup failed: the created directories remain and were reported.
    assert.ok((await lstat(join(dir, "sub/dir"))).isDirectory());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a canonical Add File with NUL content is rejected before creating the target", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await assert.rejects(
      execute({ patch: envelope("*** Add File: bin.txt", "+a\u0000b") }, { cwd: dir }),
      /refusing to write binary content \(NUL byte\)/,
    );
    await assert.rejects(lstat(join(dir, "bin.txt")));
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a no-change update with moveTo still performs the rename truthfully", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await writeFile(join(dir, "old.txt"), "same\n", "utf8");
    // A context-only hunk (no anchor) matches the whole file without
    // changing it; the move still happens and is reported truthfully.
    const result = await execute(
      { patch: envelope("*** Update File: old.txt", "*** Move to: new.txt", " same") },
      { cwd: dir },
    );
    // Upstream reports a moved file under its source path as modified.
    assert.equal(result.content[0].text, ["Success. Updated the following files:", "M old.txt"].join("\n"));
    assert.equal(await readFile(join(dir, "new.txt"), "utf8"), "same\n");
    await assert.rejects(lstat(join(dir, "old.txt")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("review capture retains successful changed paths when a multi-file request partially fails", async () => {
  const dir = await tempWorkspace();
  try {
    await writeFile(join(dir, "keep.txt"), "one\ntwo\n", "utf8");
    const patch = envelope(
      "*** Add File: ok1.txt",
      "+one",
      "*** Update File: keep.txt",
      "@@ one",
      "-two",
      "+TWO",
      "*** Update File: missing.txt",
      "-x",
      "+y",
    );
    const state = createEvidenceState();
    const toolInput = { patch };
    await recordToolCallEvidence({
      state,
      cwd: dir,
      toolName: "ApplyPatch",
      toolInput,
      snapshotOptions: { maxFileBytes: 100_000, maxSnapshotBytes: 1_000_000 },
      exchangeSequence: 1,
    });

    // The call errors overall, but the successful changes must survive in the
    // review evidence.
    let thrown: Error | undefined;
    try {
      await harness().execute(toolInput, { cwd: dir });
    } catch (error) {
      thrown = error as Error;
    }
    assert.ok(thrown, "the partial failure must surface as an error");
    assert.match(thrown!.message, /failed at operation 3/);

    recordToolResultEvidence({
      state,
      toolName: "ApplyPatch",
      toolInput,
      result: { content: [{ type: "text", text: thrown!.message }], isError: true },
      isError: true,
      exchangeSequence: 1,
    });

    const changes = await collectEvidenceChanges(state, dir, { maxFileBytes: 100_000, maxSnapshotBytes: 1_000_000 }, 1);
    assert.deepEqual(
      changes.map((change) => change.path).sort(),
      ["keep.txt", "ok1.txt"],
      "successful changes are captured even though the tool call errored",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Attribution and package contents
// ---------------------------------------------------------------------------

test("ApplyPatch engine and package carry the required MIT attribution", async () => {
  const { readFile: read } = await import("node:fs/promises");
  // Compiled tests run from dist-test/tests, so two levels up is the project root.
  const projectRoot = join(__dirname, "..", "..");
  const engine = await read(join(projectRoot, "src", "apply-patch", "engine.ts"), "utf8");
  assert.match(engine, /openai-agents-js/);
  assert.match(engine, /Copyright \(c\) 2025 OpenAI/);
  assert.match(engine, /MIT License/);

  const license = await read(join(projectRoot, "LICENSES", "MIT-openai-agents-js.txt"), "utf8");
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2025 OpenAI/);
  assert.match(license, /engine\.ts/);

  const notice = await read(join(projectRoot, "NOTICE"), "utf8");
  assert.match(notice, /OpenAI Agents JS/);
  assert.match(notice, /LICENSES\/MIT-openai-agents-js\.txt/);

  const packageJson = JSON.parse(await read(join(projectRoot, "package.json"), "utf8"));
  assert.ok(packageJson.files.includes("LICENSES"));
  assert.ok(packageJson.files.includes("NOTICE"));
});