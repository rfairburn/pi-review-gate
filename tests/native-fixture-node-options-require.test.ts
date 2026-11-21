/**
 * Focused subprocess check for the owned native-fixture NODE_OPTIONS preload clause
 * (tests/helpers/node-options-require.ts), used by the native clipboard routing,
 * saved-copy origin, and network native input/copy fixtures.
 *
 * Each case runs real Node processes from a short, privately owned temporary root
 * whose name contains a space, with a controlled environment that inherits nothing
 * from the test process. The evidence is what actually happens on disk: the owned
 * preload records its own pid and filename in the direct child and again in the
 * recorder descendant that the child spawns through an owned shim by absolute path
 * (the same shim shape the fixtures use), and the recorder writes its log at the inherited path
 * under that root. The unquoted clause the fixtures used before is run as a control
 * and must fail under the same root, so the case cannot pass vacuously.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nodeOptionsRequire } from "./helpers/node-options-require";

const BOUND_MS = 30_000;
const POSIX = process.platform !== "win32";

interface PreloadRecord { pid: number; ppid: number; preload: string; role: string }

function ownedSpaceRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prg n o-")));
  if (POSIX) assert.equal(statSync(root).mode & 0o777, 0o700, "owned root must be private");
  assert.ok(root.includes(" "), "owned root must contain a space");
  return root;
}

/**
 * Writes the owned preload, recorder, owned shim, and child into `dir` and runs the
 * child with exactly the given NODE_OPTIONS value.
 */
function runOwnedChild(root: string, dir: string, nodeOptions: string) {
  const binDir = join(dir, "bin");
  const records = join(dir, "records");
  for (const owned of [dir, binDir, records, join(dir, "home"), join(dir, "tmp")]) mkdirSync(owned, { mode: 0o700 });
  const preload = join(dir, "owned-preload.cjs");
  writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path');
fs.writeFileSync(path.join(process.env.PRG_PRELOAD_RECORDS,process.pid+'.json'),JSON.stringify({pid:process.pid,ppid:process.ppid,preload:__filename,role:process.env.PRG_ROLE||'child'}),{mode:0o600,flag:'wx'});
`, { mode: 0o600, flag: "wx" });
  const recorder = join(dir, "clipboard-recorder.cjs");
  writeFileSync(recorder, `const fs=require('node:fs');const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>fs.appendFileSync(process.env.PRG_COPY_LOG,JSON.stringify(Buffer.concat(chunks).toString('utf8'))+'\\n'));`, { mode: 0o600, flag: "wx" });
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  // The owned shim is launched by absolute path and PATH names no host directory, so
  // a shim that cannot execute (for example on a noexec mount) fails the case closed
  // instead of falling through to a host clipboard command.
  const shim = join(binDir, "xclip");
  if (POSIX) writeFileSync(shim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(recorder)}\n`, { mode: 0o700, flag: "wx" });
  const child = join(dir, "owned-child.cjs");
  writeFileSync(child, `const {spawnSync}=require('node:child_process');
const [file,args]=${POSIX ? `[${JSON.stringify(shim)},[]]` : `[process.execPath,[${JSON.stringify(recorder)}]]`};
const result=spawnSync(file,args,{input:'owned copy bytes',env:{...process.env,PRG_ROLE:'recorder'},timeout:${BOUND_MS}});
process.exitCode=result.status===0?0:3;
`, { mode: 0o600, flag: "wx" });
  const helperLog = join(dir, "helper.jsonl");
  const env: NodeJS.ProcessEnv = {
    PATH: binDir,
    HOME: join(dir, "home"), TMPDIR: join(dir, "tmp"), LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    NODE_OPTIONS: nodeOptions, PRG_PRELOAD_RECORDS: records, PRG_COPY_LOG: helperLog,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  assert.ok(preload.startsWith(`${root}`) && preload.includes(" "));
  const result = spawnSync(process.execPath, [child], { env, cwd: dir, encoding: "utf8", timeout: BOUND_MS });
  const recordList: PreloadRecord[] = readdirSync(records).map((name) => JSON.parse(readFileSync(join(records, name), "utf8")));
  return { result, preload, helperLog, records: recordList };
}

test("owned fixture preload clause survives a space-containing temporary root in the child and its recorder descendant", () => {
  const root = ownedSpaceRoot();
  try {
    // Control: the clause the fixtures used before splits on the space and Node refuses
    // to start, so no preload, child, or recorder ever runs.
    const unquoted = join(root, "unquoted");
    const control = runOwnedChild(root, unquoted, `--require=${join(unquoted, "owned-preload.cjs")}`);
    assert.notEqual(control.result.status, 0, "the unquoted clause must not survive a space-containing root");
    assert.deepEqual(control.records, []);
    assert.equal(existsSync(control.helperLog), false);

    // The shared clause: the exact preload loads in the child and in the recorder the
    // child spawns through the owned shim, and the recorder logs at the inherited path.
    const quotedDir = join(root, "quoted");
    const preloadPath = join(quotedDir, "owned-preload.cjs");
    const run = runOwnedChild(root, quotedDir, nodeOptionsRequire(preloadPath));
    assert.equal(run.result.status, 0, `owned child failed: ${run.result.stderr}`);
    assert.equal(run.records.length, 2, JSON.stringify(run.records));
    const childRecord = run.records.find((record) => record.role === "child");
    const recorderRecord = run.records.find((record) => record.role === "recorder");
    assert.ok(childRecord && recorderRecord, JSON.stringify(run.records));
    assert.equal(childRecord.preload, run.preload);
    assert.equal(recorderRecord.preload, run.preload);
    assert.equal(childRecord.pid, run.result.pid);
    if (POSIX) assert.equal(recorderRecord.ppid, childRecord.pid, "the shim execs the recorder in place of a direct child");
    assert.equal(readFileSync(run.helperLog, "utf8"), `${JSON.stringify("owned copy bytes")}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("owned fixture preload clause escapes quotes and backslashes for Node's parser and refuses control characters", { skip: !POSIX && "Windows paths cannot contain double quotes" }, () => {
  const root = ownedSpaceRoot();
  try {
    const dir = join(root, `q"b\\ s`);
    const run = runOwnedChild(root, dir, nodeOptionsRequire(join(dir, "owned-preload.cjs")));
    assert.equal(run.result.status, 0, `owned child failed: ${run.result.stderr}`);
    assert.deepEqual(run.records.map((record) => record.preload), [run.preload, run.preload]);
    assert.equal(readFileSync(run.helperLog, "utf8"), `${JSON.stringify("owned copy bytes")}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.throws(() => nodeOptionsRequire("/owned\nroot/preload.cjs"), /control characters/);
});
