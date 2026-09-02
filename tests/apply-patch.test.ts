import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readdir, readFile, rm, symlink, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { APPLY_PATCH_TOOL_NAME, applyPatchToolSchema, parseApplyPatchOperation, performApplyPatchOperation, registerApplyPatchTool, renderApplyPatchCall, renderApplyPatchResult } from "../src/apply-patch/tool";
import { extractCandidatePaths, recordToolCallEvidence, createEvidenceState, shouldRecordToolCallEvidence, shouldRecordToolResultEvidence } from "../src/evidence";
import { activate } from "../src/index";
import { ExecutionToolManager } from "../src/execution/tool";
import { normalizeConfig } from "../src/config";
import { createState } from "../src/state";

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

function updateOperation(path: string, diff: string, moveTo?: string): Record<string, unknown> {
  return { operation: { type: "update_file", path, diff, ...(moveTo ? { moveTo } : {}) } };
}

// ---------------------------------------------------------------------------
// Registration, schema, and visibility
// ---------------------------------------------------------------------------

test("ApplyPatch registers with a strict structured schema and sequential execution", () => {
  const { tools } = harness();
  const tool = tools.find((candidate) => candidate.name === APPLY_PATCH_TOOL_NAME)!;
  assert.equal(tool.label, APPLY_PATCH_TOOL_NAME);
  assert.equal(tool.executionMode, "sequential");
  assert.ok(tool.description.includes("create_file"));
  assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0);
  assert.ok(typeof tool.renderCall === "function");
  assert.ok(typeof tool.renderResult === "function");

  const schema = applyPatchToolSchema() as { additionalProperties: boolean; required: string[]; properties: Record<string, any> };
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["operation"]);
  // The operation argument is a discriminated oneOf with operation-specific
  // required and forbidden fields.
  const operation = schema.properties.operation as { description: string; oneOf: Array<Record<string, any>> };
  assert.ok(operation.description.length > 0);
  assert.deepEqual(
    operation.oneOf.map((branch) => branch.properties.type.enum[0]),
    ["create_file", "update_file", "delete_file"],
  );
  for (const branch of operation.oneOf) {
    assert.equal(branch.type, "object");
    assert.equal(branch.additionalProperties, false);
  }
  const [createBranch, updateBranch, deleteBranch] = operation.oneOf;
  assert.deepEqual([...createBranch.required].sort(), ["diff", "path", "type"]);
  assert.ok(!("moveTo" in createBranch.properties), "create_file must not expose moveTo");
  assert.deepEqual([...updateBranch.required].sort(), ["diff", "path", "type"]);
  assert.equal(updateBranch.properties.moveTo.type, "string");
  assert.deepEqual([...deleteBranch.required].sort(), ["path", "type"]);
  assert.ok(!("diff" in deleteBranch.properties), "delete_file must not expose diff");
  assert.ok(!("moveTo" in deleteBranch.properties), "delete_file must not expose moveTo");
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
    externalAgents: [{
      id: "fake",
      adapter: "codex-cli",
      command: process.execPath,
      execution: {
        args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>setTimeout(()=>{},30000))"],
      },
    }],
    execution: { activeExecutor: { source: "external", id: "fake" } },
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
  const researchTools = result.details.tasks[0].definition.executorAllowedTools;
  assert.ok(!researchTools.includes(APPLY_PATCH_TOOL_NAME), "research workers must not receive ApplyPatch");

  const executeResult = await start.execute("apply-patch-visibility-execute", {
    kind: "execute",
    tasks: [{
      title: "Bounded implementation",
      instructions: "Implement the change",
      acceptanceCriteria: ["Change implemented"],
    }],
  }, undefined, undefined, {});
  const executeTools = executeResult.details.tasks[0].definition.executorAllowedTools;
  assert.ok(executeTools.includes(APPLY_PATCH_TOOL_NAME), "execute workers must inherit ApplyPatch");
  await manager.shutdown();
});

// ---------------------------------------------------------------------------
// Operation parsing and validation
// ---------------------------------------------------------------------------

test("operation parsing enforces operation-specific required and forbidden fields", () => {
  assert.deepEqual(parseApplyPatchOperation({ operation: { type: "delete_file", path: "a.txt" } }), { type: "delete_file", path: "a.txt" });
  assert.deepEqual(
    parseApplyPatchOperation({ operation: { type: "update_file", path: "a.txt", diff: "-x" } }),
    { type: "update_file", path: "a.txt", diff: "-x" },
  );
  assert.deepEqual(
    parseApplyPatchOperation({ operation: { type: "update_file", path: "a.txt", diff: "-x", moveTo: "b.txt" } }),
    { type: "update_file", path: "a.txt", diff: "-x", moveTo: "b.txt" },
  );

  assert.throws(() => parseApplyPatchOperation({ operation: { type: "unknown", path: "a" } }), /operation\.type must be one of/);
  assert.throws(() => parseApplyPatchOperation({ operation: { type: "create_file", path: "a.txt" } }), /operation\.diff is required/);
  assert.throws(() => parseApplyPatchOperation({ operation: { type: "update_file", path: "a.txt", diff: "" } }), /operation\.diff is required/);
  assert.throws(() => parseApplyPatchOperation({ operation: { type: "delete_file", path: "a.txt", diff: "-x" } }), /operation\.diff is not valid/);
  assert.throws(() => parseApplyPatchOperation({ operation: { type: "create_file", path: "a.txt", diff: "+x", moveTo: "b.txt" } }), /moveTo is not valid/);
  assert.throws(() => parseApplyPatchOperation({ operation: { type: "update_file", path: "a.txt", diff: "-x", moveTo: "a.txt" } }), /moveTo must differ/);
  assert.throws(() => parseApplyPatchOperation({ operation: { type: "update_file", path: "a.txt", diff: "-x", extra: 1 } }), /extra is not valid/);
  assert.throws(() => parseApplyPatchOperation({ operation: { type: "update_file", path: "", diff: "-x" } }), /operation\.path is required/);
  assert.throws(() => parseApplyPatchOperation({ operation: { type: "update_file", path: "a.txt", diff: "-x" }, extra: true }), /exactly one argument/);
  assert.throws(() => parseApplyPatchOperation({}), /exactly one argument/);
});

test("operation parsing normalizes a single leading @ path marker", () => {
  assert.equal(parseApplyPatchOperation({ operation: { type: "delete_file", path: "@src/a.txt" } }).path, "src/a.txt");
  assert.throws(() => parseApplyPatchOperation({ operation: { type: "delete_file", path: "@" } }), /empty after removing the leading '@'/);
});

test("diff bodies containing V4A header lines are rejected before mutation", () => {
  // The engine treats file-level headers as section terminators, so a body
  // that still carries one would silently apply zero or partial chunks.
  assert.throws(
    () => parseApplyPatchOperation({ operation: { type: "create_file", path: "a.txt", diff: "*** Begin Patch\n+x" } }),
    /headerless/,
  );
  assert.throws(
    () => parseApplyPatchOperation({ operation: { type: "create_file", path: "a.txt", diff: "*** Add File: a.txt\n+x" } }),
    /headerless/,
  );
  assert.throws(
    () => parseApplyPatchOperation({ operation: { type: "update_file", path: "a.txt", diff: "*** Update File: a.txt\n@@\n-x" } }),
    /headerless/,
  );
  assert.throws(
    () => parseApplyPatchOperation({ operation: { type: "update_file", path: "a.txt", diff: "@@\n-x\n*** End Patch" } }),
    /headerless/,
  );
  // '*** End of File' is a valid EOF anchor, not a header.
  assert.deepEqual(
    parseApplyPatchOperation({ operation: { type: "update_file", path: "a.txt", diff: "@@\n+x\n*** End of File" } }),
    { type: "update_file", path: "a.txt", diff: "@@\n+x\n*** End of File" },
  );
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
        execute({ operation: { type: "create_file", path: "raced.txt", diff: "+mine\n" } }, { cwd: dir }),
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
    const created = await execute({ operation: { type: "create_file", path: "src/new.txt", diff: "+hello\n+world\n" } }, { cwd: dir });
    assert.match(created.content[0].text, /created src\/new\.txt/);
    // Upstream V4A create emits a trailing newline only for an explicit final '+' line.
    assert.equal(await readFile(join(dir, "src/new.txt"), "utf8"), "hello\nworld");
    assert.equal(created.details.operation, "create_file");
    assert.equal(created.details.mutated, true);

    const trailing = await execute({ operation: { type: "create_file", path: "src/eol.txt", diff: "+a\n+\n" } }, { cwd: dir });
    assert.equal(await readFile(join(dir, "src/eol.txt"), "utf8"), "a\n");
    void trailing;

    await assert.rejects(
      execute({ operation: { type: "create_file", path: "src/new.txt", diff: "+again\n" } }, { cwd: dir }),
      /already exists/,
    );
    await assert.rejects(
      execute({ operation: { type: "create_file", path: "src", diff: "+x\n" } }, { cwd: dir }),
      /already exists and is a directory/,
    );
    await assert.rejects(
      execute({ operation: { type: "create_file", path: "bin.bin", diff: "+\u0000\n" } }, { cwd: dir }),
      /binary content/,
    );
    await assert.rejects(
      execute({ operation: { type: "create_file", path: "bad.txt", diff: "no prefix\n" } }, { cwd: dir }),
      /Invalid Add File Line/,
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

    const result = await execute(updateOperation("notes.txt", "@@ one\n-two\n+TWO\n"), { cwd: dir });
    assert.match(result.content[0].text, /updated notes\.txt \(\+1 −1 lines\)/);
    const updated = await readFile(target, "utf8");
    assert.equal(updated, "\uFEFFone\r\nTWO\r\n");
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
    assert.equal(result.details.changed, true);
    assert.ok(typeof result.details.finalDiff === "string" && result.details.finalDiff.includes("-two"));

    // No-change update is a successful no-op that does not replace the file.
    const beforeNoop = await lstat(target);
    const noop = await execute(updateOperation("notes.txt", " one\r\n TWO\r\n"), { cwd: dir });
    assert.equal(noop.details.changed, false);
    assert.equal(noop.details.mutated, false);
    assert.equal((await lstat(target)).ino, beforeNoop.ino);

    // Trailing newline state survives EOF appends.
    const noTrailing = join(dir, "tail.txt");
    await writeFile(noTrailing, "a\nb", "utf8");
    await execute(updateOperation("tail.txt", "@@\n+c\n*** End of File"), { cwd: dir });
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
    await execute(updateOperation("perm.txt", "-two\n+TWO\n"), { cwd: dir });
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
    const result = await execute(updateOperation("flags.txt", "@@ a\n--- off\n-++ on\n+done\n"), { cwd: dir });
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

    await assert.rejects(execute(updateOperation("code.py", "@@ one\n-missing\n+replacement\n"), { cwd: dir }), /Invalid Context/);
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
    await assert.rejects(execute(updateOperation("blob.bin", "-x\n+y\n"), { cwd: dir }), /binary or not valid UTF-8/);
    await assert.rejects(execute(updateOperation("missing.txt", "-x\n+y\n"), { cwd: dir }), /does not exist/);
    await mkdir(join(dir, "sub"), { recursive: true });
    await assert.rejects(execute(updateOperation("sub", "-x\n+y\n"), { cwd: dir }), /not a regular file/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete_file removes files and rejects missing or non-regular targets", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    await writeFile(join(dir, "gone.txt"), "bye\n", "utf8");
    const result = await execute({ operation: { type: "delete_file", path: "gone.txt" } }, { cwd: dir });
    assert.match(result.content[0].text, /deleted gone\.txt/);
    await assert.rejects(lstat(join(dir, "gone.txt")));
    // Deletions of reasonably sized text files expose a bounded final diff.
    assert.ok(typeof result.details.finalDiff === "string");
    assert.match(result.details.finalDiff as string, /\+\+\+ \/dev\/null/);
    assert.match(result.details.finalDiff as string, /-bye/);
    assert.equal(result.details.removedLines, 1);
    await assert.rejects(execute({ operation: { type: "delete_file", path: "gone.txt" } }, { cwd: dir }), /does not exist/);
    await mkdir(join(dir, "folder"), { recursive: true });
    await assert.rejects(execute({ operation: { type: "delete_file", path: "folder" } }, { cwd: dir }), /not a regular file/);

    // Binary/non-UTF-8 files are rejected before mutation: ApplyPatch only
    // handles UTF-8 text files.
    await writeFile(join(dir, "blob.bin"), Buffer.from([0x00, 0xff, 0x0a]));
    await assert.rejects(
      execute({ operation: { type: "delete_file", path: "blob.bin" } }, { cwd: dir }),
      /binary or not valid UTF-8/,
    );
    assert.equal((await readFile(join(dir, "blob.bin"))).length, 3, "the binary file must remain");

    // Valid UTF-8 containing a NUL byte is also refused.
    await writeFile(join(dir, "nul.txt"), "a\u0000b\n", "utf8");
    await assert.rejects(
      execute({ operation: { type: "delete_file", path: "nul.txt" } }, { cwd: dir }),
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
        execute({ operation: { type: "delete_file", path: "late-abort.txt" } }, { cwd: dir, signal: controller.signal }),
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
    const result = await execute(updateOperation("old.txt", "-one\n+FIRST\n", "nested/new.txt"), { cwd: dir });
    assert.match(result.content[0].text, /moved it to nested\/new\.txt/);
    assert.equal(await readFile(join(dir, "nested/new.txt"), "utf8"), "FIRST\ntwo\n");
    await assert.rejects(lstat(join(dir, "old.txt")));
    assert.equal(result.details.moveTo, "nested/new.txt");
    // The final diff reflects the rename with both source and destination.
    assert.match(result.details.finalDiff as string, /rename from old\.txt/);
    assert.match(result.details.finalDiff as string, /rename to nested\/new\.txt/);

    await writeFile(join(dir, "a.txt"), "x\n", "utf8");
    await writeFile(join(dir, "b.txt"), "y\n", "utf8");
    await assert.rejects(execute(updateOperation("a.txt", "-x\n+X\n", "b.txt"), { cwd: dir }), /already exists/);
    await assert.rejects(execute(updateOperation("a.txt", "-x\n+X\n", "a.txt"), { cwd: dir }), /must differ/);
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
      execute(updateOperation("src.txt", "-one\n+FIRST\n", "blocker/dst.txt"), { cwd: dir }),
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
        execute(updateOperation("src.txt", "-one\n+FIRST\n", "dst.txt"), { cwd: dir }),
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
        execute({ operation: { type: "create_file", path: "no-link.txt", diff: "+x\n" } }, { cwd: dir }),
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
        execute(updateOperation("src.txt", "-one\n+FIRST\n", "dst.txt"), { cwd: dir }),
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
// Workspace confinement
// ---------------------------------------------------------------------------

test("paths escaping the workspace are rejected before mutation", async () => {
  const dir = await tempWorkspace();
  const outside = await tempWorkspace();
  try {
    const { execute } = harness();
    await writeFile(join(outside, "victim.txt"), "original\n", "utf8");

    for (const path of ["../victim.txt", "sub/../../victim.txt", outside, join(outside, "victim.txt"), ".", "/etc/hosts"]) {
      await assert.rejects(
        execute({ operation: { type: "create_file", path, diff: "+nope\n" } }, { cwd: dir }),
        (error: Error) => /outside the current workspace|workspace root/.test(error.message),
        `expected confinement rejection for ${path}`,
      );
    }
    await assert.rejects(
      execute(updateOperation("../victim.txt", "-original\n+new\n"), { cwd: dir }),
      /outside the current workspace/,
    );
    await mkdir(join(dir, "sub"), { recursive: true });
    await assert.rejects(
      execute(updateOperation("sub/../../victim.txt", "-original\n+new\n"), { cwd: dir }),
      /outside the current workspace/,
    );
    assert.equal(await readFile(join(outside, "victim.txt"), "utf8"), "original\n");

    // Absolute paths inside the workspace remain allowed.
    await execute({ operation: { type: "create_file", path: join(dir, "inside.txt"), diff: "+ok\n" } }, { cwd: dir });
    assert.equal(await readFile(join(dir, "inside.txt"), "utf8"), "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("symlink escapes and symlinked targets are rejected without following them", async () => {
  const dir = await tempWorkspace();
  const outside = await tempWorkspace();
  try {
    const { execute } = harness();
    await writeFile(join(outside, "target.txt"), "outside\n", "utf8");
    await symlink(join(outside, "target.txt"), join(dir, "link.txt"));

    await assert.rejects(execute(updateOperation("link.txt", "-outside\n+inside\n"), { cwd: dir }), /outside the current workspace|symlink/);
    await assert.rejects(execute({ operation: { type: "delete_file", path: "link.txt" } }, { cwd: dir }), /outside the current workspace|symlink/);
    await assert.rejects(
      execute({ operation: { type: "create_file", path: "link.txt", diff: "+x\n" } }, { cwd: dir }),
      /outside the current workspace|already exists/,
    );
    assert.equal(await readFile(join(outside, "target.txt"), "utf8"), "outside\n");

    // A symlinked directory that escapes the workspace is also confined.
    await mkdir(join(outside, "docs"), { recursive: true });
    await writeFile(join(outside, "docs", "nested.txt"), "outside\n", "utf8");
    await symlink(join(outside, "docs"), join(dir, "docs-link"));
    await assert.rejects(
      execute(updateOperation("docs-link/nested.txt", "-outside\n+inside\n"), { cwd: dir }),
      (error: Error) => /outside the current workspace|symlink|not a regular file/.test(error.message),
    );
    assert.equal(await readFile(join(outside, "docs", "nested.txt"), "utf8"), "outside\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Sequential declaration, rendering, evidence, and abort behavior
// ---------------------------------------------------------------------------

test("ApplyPatch renders compact call and result summaries with diff detail", () => {
  const theme = {
    bold: (text: string) => `B(${text})`,
    fg: (color: string, text: string) => `F(${color})[${text}]`,
  };
  const call = renderApplyPatchCall(
    { operation: { type: "update_file", path: "src/app.ts", moveTo: "src/main.ts", diff: "-a" } },
    theme,
  ) as { render(width: number): string[] };
  const callLine = call.render(120).join("\n");
  assert.match(callLine, /ApplyPatch/);
  assert.match(callLine, /update_file/);
  assert.match(callLine, /src\/app\.ts/);
  assert.match(callLine, /src\/main\.ts/);

  const rendered = renderApplyPatchResult({
    content: [{ type: "text", text: "ApplyPatch updated src/app.ts (+1 −1 lines)." }],
    details: { requestedDiff: "-one\n+uno\n two\n" },
    isError: false,
  }, {}, theme) as { render(width: number): string[] };
  const lines = rendered.render(160);
  assert.match(lines[0], /updated src\/app\.ts/);
  assert.match(lines.join("\n"), /Requested diff:/);
  assert.match(lines.join("\n"), /diffRemoved\)\[-one\]/);
  assert.match(lines.join("\n"), /diffAdded\)\[\+uno\]/);
  assert.match(lines.join("\n"), / two/);

  // Moves render the bounded final diff with rename from/to headers.
  const moveRendered = renderApplyPatchResult({
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
  }, {}, theme) as { render(width: number): string[] };
  const moveLines = moveRendered.render(200).join("\n");
  assert.match(moveLines, /Final diff:/);
  assert.match(moveLines, /rename from src\/app\.ts/);
  assert.match(moveLines, /rename to src\/main\.ts/);
  assert.match(moveLines, /Requested diff:/);

  // Deletions render the final deletion diff without a requested-diff block.
  const deleteRendered = renderApplyPatchResult({
    content: [{ type: "text", text: "ApplyPatch deleted gone.txt." }],
    details: { finalDiff: "diff --git a/gone.txt b/gone.txt\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye" },
    isError: false,
  }, {}, theme) as { render(width: number): string[] };
  const deleteLines = deleteRendered.render(200).join("\n");
  assert.match(deleteLines, /Final diff:/);
  assert.match(deleteLines, /diffRemoved\)\[-bye\]/);
  assert.doesNotMatch(deleteLines, /Requested diff:/);

  // Long diffs are bounded with a truncation note.
  const longDiff = ["@@ -1 +1 @@", ...Array.from({ length: 30 }, (_, index) => `+line ${index}`)].join("\n");
  const truncatedRendered = renderApplyPatchResult({
    content: [{ type: "text", text: "ApplyPatch updated big.txt (+30 −0 lines)." }],
    details: { requestedDiff: longDiff, finalDiff: longDiff },
    isError: false,
  }, {}, theme) as { render(width: number): string[] };
  assert.match(truncatedRendered.render(200).join("\n"), /more diff line\(s\)/);

  const errorRendered = renderApplyPatchResult({
    content: [{ type: "text", text: "ApplyPatch failed: boom" }],
    isError: true,
  }, {}, theme) as { render(width: number): string[] };
  assert.match(errorRendered.render(120)[0], /error\)\[ApplyPatch failed: boom\]/);
});

test("ApplyPatch call evidence pre-captures operation.path and operation.moveTo mutation candidates", async () => {
  const dir = await tempWorkspace();
  try {
    await writeFile(join(dir, "existing.txt"), "before\n", "utf8");
    const state = createEvidenceState();
    const input = {
      operation: { type: "update_file", path: "existing.txt", moveTo: "renamed.txt", diff: "-before\n+after\n" },
    };
    const extracted = extractCandidatePaths("ApplyPatch", input);
    assert.deepEqual(extracted.paths.map((candidate) => candidate.path).sort(), ["existing.txt", "renamed.txt"]);
    assert.ok(extracted.paths.every((candidate) => candidate.source.startsWith("ApplyPatch:operation.")));
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

test("ApplyPatch evidence normalizes leading @ markers on operation.path and operation.moveTo", async () => {
  const dir = await tempWorkspace();
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "before\n", "utf8");
    const input = {
      operation: { type: "update_file", path: "@src/a.ts", moveTo: "@src/b.ts", diff: "-before\n+after\n" },
    };

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

test("ApplyPatch aborts before mutating when the signal is already aborted", async () => {
  const dir = await tempWorkspace();
  try {
    const { execute } = harness();
    const target = join(dir, "abort.txt");
    await writeFile(target, "original\n", "utf8");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      execute(updateOperation("abort.txt", "-original\n+new\n"), { cwd: dir, signal: controller.signal }),
      (error: Error) => /cancel|abort/i.test(error.message),
    );
    assert.equal(await readFile(target, "utf8"), "original\n");

    await assert.rejects(
      execute({ operation: { type: "create_file", path: "never.txt", diff: "+x\n" } }, { cwd: dir, signal: controller.signal }),
      (error: Error) => /cancel|abort/i.test(error.message),
    );
    await assert.rejects(lstat(join(dir, "never.txt")));
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