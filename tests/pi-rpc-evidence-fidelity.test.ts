import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BackgroundProcessReadiness } from "../src/background-process-readiness";
import {
  buildEvidenceBundle,
  captureObservedToolPathAfterStates,
  createEvidenceState,
  recordObservedToolEventEvidence,
  type EvidenceState,
} from "../src/evidence";
import { PiRpc } from "../src/execution/adapters/pi-model";

const snapshotOptions = { maxFileBytes: 4096, maxSnapshotBytes: 16_384 };

// The child sends exactly one planned byte segment per input line. The parent
// acknowledges only after receiving all of that segment, so the next write
// cannot coalesce across a planned UTF-8/JSONL boundary. No sleeps, provider,
// installed Pi, inherited credentials, or live agent home are involved.
const childScript = `
const fs = require('node:fs');
const readline = require('node:readline');
const fixture = JSON.parse(process.argv[1]);
for (const file of fixture.files) fs.writeFileSync(file.path, file.content, 'utf8');
const input = readline.createInterface({ input: process.stdin });
let index = 0;
input.on('line', () => {
  const segment = fixture.segments[index++];
  if (segment === undefined) {
    process.stdout.end();
    process.stderr.end();
    input.close();
    process.stdin.destroy();
    return;
  }
  process.stdout.write(Buffer.from(segment, 'base64'));
});
`;

async function withFixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-rpc-fidelity-"));
  try {
    await run(root);
  } finally {
    // This invocation allocated root, including partial setup; never sweep
    // other temporary paths. replay() settles its one owned child first.
    await rm(root, { recursive: true, force: true });
  }
}

async function replay(input: {
  root: string;
  workspace: string;
  state: EvidenceState;
  segments: Buffer[];
  files?: Array<{ path: string; content: string }>;
}): Promise<{ rpc: PiRpc; response: Record<string, unknown> | Error; jsonl: string[] }> {
  const home = join(input.root, "synthetic-home");
  await mkdir(home);
  const proc = spawn(process.execPath, ["-e", childScript, JSON.stringify({
    segments: input.segments.map((segment) => segment.toString("base64")),
    files: input.files ?? [],
  })], {
    cwd: input.workspace,
    env: { HOME: home, USERPROFILE: home, TMPDIR: input.root, TEMP: input.root, TMP: input.root },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Register ownership cleanup before adapter/setup code can throw. An error
  // event is not close evidence; do not delete the fixture until actual close.
  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
  proc.on("error", () => undefined);
  let expired = false;
  const deadline = setTimeout(() => {
    expired = true;
    proc.kill("SIGKILL");
  }, 5_000);
  try {
    const jsonl: string[] = [];
    const rpc = new PiRpc(proc, new BackgroundProcessReadiness(), (line) => jsonl.push(line), undefined,
      (event) => recordObservedToolEventEvidence({
        state: input.state,
        cwd: input.workspace,
        selectedRoot: input.workspace,
        adapter: "pi-model",
        ...event,
      }));
    let segmentIndex = 0;
    let received = 0;
    let framingFailure: Error | undefined;
    proc.stdout.on("data", (chunk: Buffer) => {
      received += chunk.length;
      const expected = input.segments[segmentIndex];
      if (!expected || received > expected.length) {
        framingFailure = new Error("fixture crossed a planned byte boundary without acknowledgement");
        proc.kill();
      } else if (received === expected.length) {
        segmentIndex += 1;
        received = 0;
        proc.stdin.write("\n");
      }
    });
    const response = rpc.request("fixture", {}).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
    assert.deepEqual(await rpc.closed(), { code: 0, signal: null });
    assert.equal(expired, false, "the owned child must close before the fixture deadline");
    assert.equal(framingFailure, undefined);
    assert.equal(segmentIndex, input.segments.length, "every planned byte segment was delivered");
    assert.equal(rpc.failure, undefined);
    return { rpc, response: await response, jsonl };
  } finally {
    clearTimeout(deadline);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await closed;
  }
}

function splitRecords(records: string[], symbol: string, split: number): Buffer[] {
  const segments: Buffer[] = [];
  for (const record of records) {
    const bytes = Buffer.from(record);
    const symbolStart = bytes.indexOf(Buffer.from(symbol));
    if (symbolStart >= 0) {
      const boundary = symbolStart + split;
      segments.push(bytes.subarray(0, boundary), bytes.subarray(boundary));
    } else {
      // Also split an ordinary ASCII record in the middle of its JSON syntax.
      segments.push(bytes.subarray(0, 7), bytes.subarray(7));
    }
    // LF is always its own segment: a completed JSON object alone must wait
    // for the delimiter rather than being parsed at a chunk boundary.
    segments.push(Buffer.from("\n"));
  }
  return segments;
}

for (const symbol of ["é", "漢", "🦊"]) {
  for (let split = 1; split < Buffer.byteLength(symbol); split += 1) {
    for (const isError of [false, true]) {
      test(`PiRpc retains FILE ${symbol} split after byte ${split} in ${isError ? "failed" : "successful"} tool evidence`, async () => {
        await withFixture(async (root) => {
          const workspace = join(root, "workspace");
          await mkdir(workspace);
          const path = join(root, `FILE-${symbol}.txt`);
          const content = `actual ${symbol} effect bytes\nsecond line\n`;
          const report = join(workspace, "unrelated-report.txt");
          const unrelated = "unrelated writer report, not a tool target\n";
          const resultText = isError ? `partial write to ${path}; later step failed` : `wrote ${path}`;
          const records = [
            JSON.stringify({ type: "tool_execution_start", toolName: "write", toolCallId: "write-1", args: { path, content } }),
            // End inputs are explicitly on the wire; this test does not invent
            // end-input correlation (which is outside this correction's scope).
            JSON.stringify({ type: "tool_execution_end", toolName: "write", toolCallId: "write-1", args: { path, content }, result: { content: [{ type: "text", text: resultText }] }, isError }),
            JSON.stringify({ type: "response", id: "review-gate-1", success: true }),
          ];
          const state = createEvidenceState();
          const { rpc, response, jsonl } = await replay({
            root, workspace, state,
            segments: splitRecords(records, symbol, split),
            files: [{ path, content }, { path: report, content: unrelated }],
          });
          assert.ok(!(response instanceof Error));
          // Check real disk bytes before asking production evidence to capture
          // the after-state, including the partial effect of a failed result.
          const actual = await readFile(path);
          assert.deepEqual(actual, Buffer.from(content));
          assert.equal(await readFile(report, "utf8"), unrelated);
          await captureObservedToolPathAfterStates(state, workspace, snapshotOptions);
          assert.deepEqual([...state.candidates.keys()], [path], "only the exact observed path is a candidate, never the unrelated same-workspace report");
          const candidate = state.candidates.get(path)!;
          assert.equal(candidate.absolutePath, path);
          assert.equal(candidate.afterSnapshot?.exists, true);
          assert.equal(candidate.afterSnapshot?.content, content);
          assert.equal(candidate.afterSnapshot?.sha256, createHash("sha256").update(actual).digest("hex"));
          assert.equal(candidate.prestateUnverified, true);
          assert.equal(candidate.baseline, undefined, "stream delivery cannot verify a pre-state");
          assert.equal(state.events.length, 2);
          assert.deepEqual(state.events.map((event) => event.candidatePaths), [[path], [path]]);
          assert.equal(state.events[1]?.isError, isError);
          assert.equal(state.events[1]?.detail, resultText);
          const bundle = buildEvidenceBundle(state, [], undefined, { selectedCwd: workspace, workspaceRoot: workspace });
          assert.equal(bundle.candidates.length, 1);
          assert.equal(bundle.candidates[0]?.absolutePath, path);
          assert.equal(bundle.candidates[0]?.afterSnapshot?.content, content);
          assert.equal(bundle.candidates[0]?.baseline, "unverified");
          assert.equal(bundle.requiresReview, true);
          assert.equal(bundle.toolObservationsTruncated, false);
          assert.deepEqual(bundle.changedCandidatePaths, [], "external observations are not fabricated workspace diffs");
          assert.ok(bundle.markdown.includes(path));
          assert.ok(bundle.markdown.includes(content));
          assert.ok(!bundle.markdown.includes(report));
          assert.ok(!bundle.markdown.includes(unrelated));
          if (isError) assert.match(bundle.markdown, /ERROR.*partial write/);
          assert.deepEqual(jsonl, records.map((record) => `${record}\n`));
          const output = rpc.output(0, false, false);
          assert.equal(output.stdout, `${records.join("\n")}\n`);
          assert.equal(output.stdoutBytes, Buffer.byteLength(output.stdout));
          assert.equal(output.stdoutTruncated, false);
        });
      });
    }
  }
}

test("PiRpc preserves split UTF-8 RPC error text without converting the refusal to success", async () => {
  await withFixture(async (root) => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const error = "cannot write FILE-é-漢-🦊.txt";
    const record = JSON.stringify({ type: "response", id: "review-gate-1", success: false, error });
    const bytes = Buffer.from(`${record}\n`);
    // One-byte segments split every multibyte sequence and all record syntax.
    const { response, rpc } = await replay({ root, workspace, state: createEvidenceState(), segments: Array.from(bytes, (byte) => Buffer.from([byte])) });
    assert.ok(response instanceof Error);
    assert.equal(response.message, error);
    assert.equal(rpc.output(0, false, false).stdout, `${record}\n`);
  });
});

test("PiRpc flushes pending bytes on abnormal close without clearing the pipe-failure latch", async () => {
  // No OS resources: model the error/destroy case where stdout never emits end.
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), { writable: true, write: () => true });
  const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr, exitCode: null, signalCode: null });
  const jsonl: string[] = [];
  const rpc = new PiRpc(proc as unknown as ChildProcess, new BackgroundProcessReadiness(), (line) => jsonl.push(line));
  const response = rpc.request("fixture", {});
  const refused = assert.rejects(response, /read EIO/);
  const tail = Buffer.concat([Buffer.from('{"type":"response","text":"'), Buffer.from([0xe6, 0xbc])]);
  stdout.emit("data", tail);
  stdout.emit("error", new Error("read EIO"));
  proc.emit("close", 0, null);
  await refused;
  assert.deepEqual(await rpc.closed(), { code: 0, signal: null });
  assert.equal(rpc.failure?.message, "read EIO", "zero exit must not mask a broken output pipe");
  assert.equal(rpc.output(0, false, false).stdout, tail.toString("utf8"));
  assert.deepEqual(jsonl, [], "flushing pending UTF-8 does not terminate an incomplete JSONL record");
  await assert.rejects(rpc.request("get_state", {}), /exited before protocol completion|transport failed/);
});

for (const tail of [
  Buffer.from(JSON.stringify({ type: "response", id: "review-gate-1", success: true })),
  Buffer.concat([Buffer.from('{"type":"response","id":"review-gate-1","success":true,"text":"'), Buffer.from([0xf0, 0x9f])]),
]) {
  test(`PiRpc retains EOF bytes but does not accept ${tail.at(-1) === 0x7d ? "undelimited JSON" : "incomplete UTF-8/JSON"} as a response`, async () => {
    await withFixture(async (root) => {
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const state = createEvidenceState();
      const { rpc, response, jsonl } = await replay({ root, workspace, state, segments: [tail] });
      assert.ok(response instanceof Error);
      assert.match(response.message, /exited before protocol completion/);
      assert.equal(rpc.output(0, false, false).stdout, tail.toString("utf8"));
      assert.equal(rpc.settledGeneration, 0);
      await assert.rejects(rpc.waitForSettled(0), /exited before protocol completion/);
      assert.deepEqual(jsonl, []);
      assert.equal(state.events.length, 0);
      assert.equal(state.candidates.size, 0);
    });
  });
}
