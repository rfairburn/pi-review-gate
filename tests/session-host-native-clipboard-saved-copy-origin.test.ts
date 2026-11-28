import assert from "node:assert/strict";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, type BigIntStats } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { retainedFixtureBase } from "./helpers/scratch-fixture-base";
import { createStatusBroker } from "../src/session-host/broker";
import { InstanceManager, type InstancePty } from "../src/session-host/instances";
import { NativeAgentRegistry } from "../src/session-host/profiles";
import {
  admitSavedSession,
  listSavedSessions,
  type SavedSessionAdmission,
} from "../src/session-host/saved-sessions";
import {
  createNativeClipboardReceiver,
  type NativeClipboardEvent,
  type NativeClipboardOriginEvent,
} from "../src/session-host/native-clipboard";
import {
  createNativeInputDecoder,
  type NativeInputFragment,
  type NativeInputOrigin,
} from "../src/session-host/native-input-origin";
import { TerminalSurface, stripGeneratedSgr } from "../src/session-host/terminal-surface";
import type { SessionHostBootstrap } from "../src/session-host/protocol";
import { ChangeSignal, compileAndStageCandidate, makeNativeAgentRoot } from "./helpers/session-host-native-main-harness";
import { nodeOptionsRequire } from "./helpers/native-node-options-require";
import { findInstalledAgentDirs } from "./menu-tui-fakes";
import { skipOrFail } from "./bridge-fakes";

/**
 * Real bundled CLI/PTY proof for one narrow question: does a copy of the LAST
 * ASSISTANT message of a deliberately resumed saved conversation travel as an
 * authenticated copy of THAT conversation, caused by the exact keystroke that
 * asked for it — and can anything else claim that provenance?
 *
 * Scope is deliberately narrow and does not repeat
 * `session-host-native-clipboard-routing.test.ts` (readiness/query ordering
 * across startup, framing across geometry/reload, Unicode and >32 KiB paste
 * byte-exactness, SSH/helper-only controls, and native Main). Here:
 *
 * - Two owned saved conversations are seeded in the current public
 *   session/SDK shape under an owned agent root and admitted through the real
 *   read-only catalog (`listSavedSessions` + `admitSavedSession`), then resumed
 *   by the host's own `savedSession` admission receipt. No model, provider,
 *   credential, or network request happens in a copy child: the assistant text
 *   already exists in the resumed conversation.
 * - Every child runs in the closed, explicitly opted-in framing mode
 *   (`nativeInputOriginFraming: true` on this owned manager only; the product
 *   default stays false), so each copy receipt carries an explicit input origin
 *   and logical dispatch id.
 * - Before ANY copy key is pressed, this file requires a positive per-child
 *   attestation written by this fixture's own `--require` preload: the OS
 *   clipboard native module is blocked in THAT child pid, and every clipboard
 *   command resolves to the owned recorder first on that child's PATH. A missing
 *   or negative attestation fails before the key is sent, so no physical OS
 *   clipboard write is ever attempted, and no claim is made about one.
 * - Attestation records are per process (`<nonce>.<pid>.json`). The preload is
 *   inherited by the recording clipboard command this child spawns, so each pid
 *   attests for itself and the native child's own record is never overwritten;
 *   after the helper has run this file re-reads that child's record and requires
 *   an armed recorder record alongside it. Interception stays inherited — only
 *   the records are isolated.
 *
 * The explicit origin and logical dispatch id exist only on the receiver's v2
 * receipt (`NativeClipboardOriginEvent.dispatchId`, decoded from the capsule
 * body's `input`), never on the v1 event the manager forwards to
 * `onNativeClipboard`. So the keystroke binding is observed by re-authenticating
 * this child's own capsules with this registration, while the production
 * callback is checked separately for delivering exactly the same events.
 *
 * A failing leg emits bounded diagnostic facts before teardown. Full synthetic
 * frames/attestations remain inspectable in `failure.json` if evidence is
 * explicitly preserved or teardown cannot safely remove the fixture.
 *
 * Negatives stay distinct: host protocol replies are `none` origin and can never
 * be a copy receipt; a raw OSC 52 decoy written synchronously by this fixture's
 * own `pi.registerShortcut("f7")` handler — Pi's public extension-shortcut API,
 * whose handler Pi calls from inside the editor's input handling, so the write
 * really happens inside the F7 key's live `local` dispatch — is refused as
 * unverified provenance while the next genuine copy still works. That handler
 * also writes an owned witness file around the write, so the refusal is proven to
 * be the refusal of an attempted write and never a keystroke that did nothing.
 * This leg requires that child-side refusal, never a silently dropped write. An
 * extension *command* cannot stand in for the shortcut: Pi invokes registered
 * command handlers outside the keystroke's own input context, where the strict
 * bridge grants no clipboard authority and the write yields no receipt at all, so
 * a command-based decoy would prove nothing. The same key on a user-only
 * conversation produces Pi's own "nothing to copy" feedback with zero capsules and
 * zero helper invocations.
 *
 * macOS/Linux only (Windows ConPTY is explicitly unclaimed), headless PTY only:
 * no physical terminal, no real outer-terminal OSC 52 permission claim, and no
 * Pi source, runtime, or version change.
 */

/** Pi 1.4.0's documented default `app.message.copy` binding (Ctrl+X). */
const CTRL_X = "\x18";
/**
 * Legacy F7 as Pi 1.4.0's own key table spells it (`pi-tui` `LEGACY_KEY_SEQUENCES.f7`,
 * `matchesKey(data, "f7")`). This is the key the fixture's public
 * `pi.registerShortcut("f7")` decoy binds, so the keystroke below is an ordinary
 * local keystroke through the same framed seam as every other input here.
 */
const F7 = "\x1b[18~";
/** The clipboard commands the audited Pi runtimes may spawn; all must be owned recorders. */
const CLIPBOARD_COMMANDS = ["pbcopy", "xclip", "xsel", "wl-copy", "termux-clipboard-set"] as const;
const ASSISTANT_TEXT = "SAVEDCOPY466-A αβ café 雪\nSAVEDCOPY466-B ünïcödé end";
const ASSISTED_ID = "0672e0a1-4a1f-7c31-9b2a-1f4c9d000001";
const USER_ONLY_ID = "0672e0a1-4a1f-7c31-9b2a-1f4c9d000002";

interface Attestation {
  version: number;
  nonce: string;
  pid: number;
  armed: boolean;
  dlopenHook: boolean;
  resolved: Record<string, string | null>;
  blocked: string[];
  reason: string[];
}

/** Inspect-only decode of this child's own v2 capsules (the receiver verifies them). */
interface CapsuleBody {
  version: number;
  sequence: number;
  event: { kind: string; encoded?: string; sessionId: string; sessionEpoch: number; reason?: string };
  input?: { origin: { kind: string }; dispatchId: number };
}

/**
 * The closed set of native Pi releases this proof runs against, matching the runtimes the
 * production provenance adapter audits, including the audited Pi 1.6.1 release. The SDK
 * identity check below always states the discovered installation's own version, so an
 * unlisted release is never admitted.
 *
 * Pi 1.7.0 was audited against 1.6.1 from its own published tarball before being listed:
 * `dist/utils/clipboard.js`, `clipboard-command.js` and `wsl.js` are byte-identical (the
 * `emitOsc52` → `copyToClipboard` pair, the 100,000-character encoded OSC 52 bound and the
 * clipboard-command set therefore unchanged), `dist/tui-alt-screen.js` is byte-identical in
 * the matching `@earendil-works/pi-tui@1.7.0` peer (the `TuiAltScreen.copySelection` /
 * `copyTextToClipboard` frames unchanged), the bundle chunk keeps the
 * `_InteractiveMode.handleCopyCommand` alias, `dist/core/keybindings.js` is byte-identical
 * (`app.message.copy` unchanged), and the public SDK entry (`exports["."]` → `dist/index.js`,
 * `main` unchanged) still exports the `SessionManager` runtime this proof reads.
 */
const AUDITED_PI_VERSIONS = ["1.3.0", "1.4.0", "1.5.0", "1.5.1", "1.5.2", "1.6.0", "1.6.1", "1.7.0"] as const;

/** The PTY writers are already settled; no more clipboard helpers can start. */
async function settleClipboardHelpers(path: string, receipt: BigIntStats, minimumClosed: number): Promise<void> {
  const current = lstatSync(path, { bigint: true });
  assert.ok(current.isFile() && current.dev === receipt.dev && current.ino === receipt.ino && current.size <= 16_384n,
    "the owned clipboard helper lifecycle journal is unchanged and bounded");
  const records = new Map<string, { pid?: number; spawned?: boolean; closed?: boolean }>();
  for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
    const { id, event, pid } = JSON.parse(line) as { id: string; event: string; pid?: number };
    assert.match(id, /^\d+:\d+$/);
    const record = records.get(id);
    if (event === "starting") {
      assert.equal(record, undefined);
      records.set(id, {});
    } else if (event === "spawned") {
      assert.ok(record && !record.spawned);
      assert.ok(pid === undefined || (Number.isSafeInteger(pid) && pid > 0), "clipboard helper PID is valid");
      Object.assign(record, { pid, spawned: true });
    } else {
      assert.ok(event === "closed" && record?.spawned && !record.closed);
      record.closed = true;
    }
  }
  assert.ok([...records.values()].filter((record) => record.closed && record.pid).length >= minimumClosed,
    "every successful clipboard recording was observed through a helper close event");
  const pending = [...records.values()].filter((record) => !record.closed);
  const deadline = Date.now() + 5000;
  for (const { pid } of pending) {
    assert.ok(pid && Number.isSafeInteger(pid) && pid > 0, "a starting clipboard helper has no confirmed process identity");
    // An interrupted Pi may not have dispatched its close listener before it
    // exited. Once its owned PTY is gone, EOF lets the recorder finish. Observe
    // absence only; never signal a numeric PID that might have been reused.
    for (;;) {
      try { process.kill(pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw error;
      }
      assert.ok(Date.now() < deadline, `clipboard helper ${pid} has no confirmed exit`);
      await delay(25);
    }
  }
}

function createSavedCopyScratch(t: { after(hook: () => void): void; diagnostic(line: string): void }, base = retainedFixtureBase()) {
  // Allocate beside the wrapper to keep the broker's Unix-socket path short.
  const baseReceipt = lstatSync(base, { bigint: true });
  const root = mkdtempSync(join(base, "prg-sc-"));
  const directories = new Map<string, BigIntStats>();
  const files = new Map<string, BigIntStats>();
  let receipt: BigIntStats | undefined;
  let writersSettled = true; // setup before the broker is synchronous
  const verifyRoot = () => {
    const parent = lstatSync(base, { bigint: true });
    assert.ok(parent.isDirectory() && parent.dev === baseReceipt.dev && parent.ino === baseReceipt.ino
      && realpathSync(base) === base, "saved-copy temporary parent changed identity or canonical path");
    const current = lstatSync(root, { bigint: true });
    assert.ok(receipt?.isDirectory() && current.isDirectory()
      && current.dev === receipt.dev && current.ino === receipt.ino && realpathSync(root) === root
      && (current.mode & 0o077n) === 0n,
    "saved-copy scratch root changed identity, canonical path, or privacy");
  };
  t.after(() => {
    try {
      assert.ok(writersSettled, "saved-copy writers did not confirm settlement");
      verifyRoot();
      for (const [name, expected] of files) {
        const current = lstatSync(join(root, name), { bigint: true, throwIfNoEntry: false });
        assert.ok(current?.isFile() && current.dev === expected.dev && current.ino === expected.ino,
          `missing or changed owned file in private saved-copy scratch: ${name}`);
      }
      for (const [name, expected] of directories) {
        const path = join(root, name);
        const current = lstatSync(path, { bigint: true, throwIfNoEntry: false });
        assert.ok(current?.isDirectory() && current.dev === expected.dev && current.ino === expected.ino,
          `missing or changed owned directory in private saved-copy scratch: ${name}`);
        // Do not override the broker's own fail-closed transport cleanup.
        if (name === "broker") assert.deepEqual(readdirSync(path), [], "broker left an unresolved transport entry");
      }
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        assert.ok((entry.isDirectory() && directories.has(entry.name)) || (entry.isFile() && files.has(entry.name)),
          `unowned or changed entry in private saved-copy scratch: ${JSON.stringify(entry.name)}`);
      }
      if (process.env.PI_TEST_SCRATCH_PRESERVE === "1") {
        t.diagnostic(`preserved owned saved-copy fixture: ${root}`);
      } else {
        rmSync(root, { recursive: true, force: false });
        assert.equal(lstatSync(root, { throwIfNoEntry: false }), undefined);
      }
    } catch (error) {
      const message = `saved-copy cleanup refused or failed; retained evidence at ${root}: ${String(error).slice(0, 1024)}`;
      // node:test can render only the original failure when after() fails too.
      t.diagnostic(message);
      throw new Error(message, { cause: error });
    }
  });
  receipt = lstatSync(root, { bigint: true });
  verifyRoot();
  return {
    root, verifyRoot,
    setWritersSettled(settled: boolean) { writersSettled = settled; },
    file(name: string, contents = ""): string {
      assert.equal(name, basename(name));
      verifyRoot();
      const path = join(root, name);
      const fd = openSync(path, "wx", 0o600);
      try {
        // A failed write can still leave the regular file we just created.
        // Record its identity from the exclusive descriptor before writing.
        files.set(name, fstatSync(fd, { bigint: true }));
        writeFileSync(fd, contents);
      } finally {
        closeSync(fd);
      }
      return path;
    },
    mkdir(name: string): string {
      assert.equal(name, basename(name));
      verifyRoot();
      const path = join(root, name);
      mkdirSync(path, { mode: 0o700 });
      const created = lstatSync(path, { bigint: true });
      assert.ok(created.isDirectory(), `saved-copy setup path is not a real directory: ${path}`);
      directories.set(name, created);
      return path;
    },
  };
}

test("saved-copy partial setup refuses occupied directories and files before broker startup", {
  skip: process.platform === "win32" ? "saved-copy scratch ownership uses POSIX permissions" : false,
}, () => {
  const base = mkdtempSync(join(retainedFixtureBase(), "prg-sc-control-"));
  const owned = lstatSync(base, { bigint: true });
  try {
    for (const [name, kind] of [["broker", "directory"], ["work", "directory"], ["helper-lifecycle.jsonl", "file"]] as const) {
      const hooks: Array<() => unknown> = [];
      const diagnostics: string[] = [];
      const scratch = createSavedCopyScratch({
        after(hook) { hooks.push(hook); },
        diagnostic(line) { diagnostics.push(line); },
      }, base);
      const occupied = join(scratch.root, name);
      if (kind === "directory") mkdirSync(occupied, { mode: 0o700 });
      const sentinel = kind === "directory" ? join(occupied, "sentinel.txt") : occupied;
      writeFileSync(sentinel, "unowned by the fixture", { flag: "wx" });
      assert.throws(() => kind === "directory" ? scratch.mkdir(name) : scratch.file(name, "must not overwrite"), { code: "EEXIST" });
      assert.equal(hooks.length, 1, "teardown was registered before the setup error");
      assert.throws(hooks[0]!, /saved-copy cleanup refused or failed/);
      assert.ok(diagnostics.some((line) => line.includes(`unowned or changed entry in private saved-copy scratch: "${name}"`)));
      assert.equal(readFileSync(sentinel, "utf8"), "unowned by the fixture");
    }
  } finally {
    const current = lstatSync(base, { bigint: true });
    assert.ok(current.isDirectory() && current.dev === owned.dev && current.ino === owned.ino && realpathSync(base) === base);
    // The control owns both the setup dirs and the synthetic foreign entries.
    rmSync(base, { recursive: true, force: false });
  }
});

test("resumed saved-session copy is bound to its own conversation, keystroke, and pre-copy OS-write interception",
  { timeout: 120_000 }, async (t) => {
    if (process.platform === "win32") { t.skip("native Windows sidebar acceptance remains experimental"); return; }
    if (process.env.PI_REVIEW_GATE_RUNTIME_ROLE) { t.skip("native primary-host proof cannot run in a delegated role"); return; }
    const packageRoot = findInstalledAgentDirs().find((path) => {
      try { return AUDITED_PI_VERSIONS.includes(JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version); } catch { return false; }
    });
    if (!packageRoot) { skipOrFail(t, `installed native Pi ${AUDITED_PI_VERSIONS.join("/")} is required`); return; }
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { bin: { pi: string }; version: string };
    const cli = realpathSync(join(packageRoot, manifest.bin.pi));
    assert.match(manifest.bin.pi, /dist\/bundle\/cli\.js$/, "exercise the actual package-declared bundled executable");
    const requireHere = createRequire(join(process.cwd(), "package.json"));
    const pty = requireHere("@lydell/node-pty") as { spawn(file: string, args: string[], options: Record<string, unknown>): InstancePty };

    const scratch = createSavedCopyScratch(t);
    const { root, verifyRoot } = scratch;
    const homeDir = scratch.mkdir("home");
    const tmpDir = scratch.mkdir("tmp");
    const brokerRoot = scratch.mkdir("broker");
    const binDir = scratch.mkdir("bin");
    const attestRoot = scratch.mkdir("attest");
    const workDir = scratch.mkdir("work");
    // The compiler and agent helpers write inside a namespace we established
    // exclusively, even if either helper fails before returning a result.
    const runtimeRoot = scratch.mkdir("runtime");
    const candidate = compileAndStageCandidate(runtimeRoot); // inactive build; never live dist/
    const agentDir = makeNativeAgentRoot(runtimeRoot, { deferredPiTools: false });
    const signal = new ChangeSignal();
    const helperLog = scratch.file("helper.jsonl");
    const helperLifecycle = scratch.file("helper-lifecycle.jsonl");
    const helperLifecycleReceipt = lstatSync(helperLifecycle, { bigint: true });
    const recorder = scratch.file("clipboard-recorder.cjs", `const fs=require('node:fs');const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>fs.appendFileSync(process.env.PRG_COPY_LOG,JSON.stringify(Buffer.concat(chunks).toString('utf8'))+'\\n'));`);
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    // These are the ONLY clipboard commands reachable on the isolated PATH. The
    // native OS clipboard module is blocked in the child below, so no success
    // path can reach a physical clipboard, and nothing here reads one either.
    for (const name of CLIPBOARD_COMMANDS) {
      writeFileSync(join(binDir, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(recorder)}\n`, { mode: 0o700, flag: "wx" });
    }
    // Owned preload: blocks the OS clipboard native module through process.dlopen
    // and records a positive per-process attestation of that interception plus the
    // child's own PATH resolution of every clipboard command. It carries no
    // bootstrap secret; `PRG_CLIP_ATTEST` is a path stem and each process appends
    // its own pid, because the preload is inherited by this child's descendants.
    const preload = scratch.file("block-native-clipboard.cjs", `'use strict';
const fs=require('node:fs'),path=require('node:path');
const NATIVE=/(?:darwin|win32|linux)-platform(?:-x11)?\\.node$/;
const markerStem=process.env.PRG_CLIP_ATTEST||'';
const ownedBin=process.env.PRG_OWNED_BIN||'';
const nonce=process.env.PRG_CLIP_ATTEST_NONCE||'';
// One record per process. Descendants (the owned clipboard recorder included)
// inherit NODE_OPTIONS and therefore this preload, so each pid attests for
// itself and nothing can overwrite the native child's own interception record.
const markerPath=markerStem?markerStem+'.'+process.pid+'.json':'';
const COMMANDS=['pbcopy','xclip','xsel','wl-copy','termux-clipboard-set'];
const blocked=[];const reason=[];const resolved={};let armed=false;let hookInstalled=false;
function firstExecutable(name){
  for(const dir of (process.env.PATH||'').split(path.delimiter)){
    if(!dir)continue;
    const candidate=path.join(dir,name);
    try{const st=fs.lstatSync(candidate);if(!st.isFile())continue;fs.accessSync(candidate,fs.constants.X_OK);return candidate;}catch{continue;}
  }
  return null;
}
function write(){
  if(!markerPath)return;
  try{fs.writeFileSync(markerPath,JSON.stringify({version:1,nonce,pid:process.pid,armed,dlopenHook:hookInstalled,resolved,blocked,reason}));}catch{/* no attestation means the test refuses to copy */}
}
if(!ownedBin){armed=false;reason.push('missing-owned-bin');}
else{
  armed=true;
  for(const command of COMMANDS){
    const where=firstExecutable(command);
    resolved[command]=where;
    if(where!==path.join(ownedBin,command)){armed=false;reason.push('unresolved:'+command);}
  }
}
const dlopen=process.dlopen;
process.dlopen=function(mod,file,...rest){
  const target=String(file);
  if(NATIVE.test(target)){
    if(blocked.length<8)blocked.push(path.basename(target));
    write();
    throw new Error('owned fixture blocks the OS clipboard native module');
  }
  return dlopen.call(this,mod,target,...rest);
};
hookInstalled=process.dlopen!==dlopen;
write();
// Pi can detach clipboard commands. An outer PTY exit alone does not settle
// them. Observe the actual ChildProcess without changing argv, I/O or signals.
if(armed){
  const cp=require('node:child_process');const spawn=cp.spawn;let serial=0;
  const lifecycle=(value)=>fs.appendFileSync(process.env.PRG_COPY_LIFECYCLE,JSON.stringify(value)+'\\n');
  cp.spawn=function(command,...args){
    if(!COMMANDS.includes(command)&&!Object.values(resolved).includes(command))return spawn.call(this,command,...args);
    const id=process.pid+':'+(++serial);
    lifecycle({id,event:'starting'});
    const child=spawn.call(this,command,...args);
    lifecycle({id,event:'spawned',pid:child.pid});
    child.once('close',()=>lifecycle({id,event:'closed'}));
    return child;
  };
  require('node:module').syncBuiltinESMExports();
}
`);
    const decoy = Buffer.from("SAVEDCOPY466-DECOY").toString("base64");
    // Witness for the decoy attempt, written by the fixture's own shortcut callback
    // inside this child. Without it, "no copy receipt" could be satisfied by a
    // keystroke that never reached a handler at all; with it, the refusal asserted
    // below can only be a refusal of a write that was actually issued.
    const shortcutWitness = scratch.file("shortcut-witness.json");
    interface ShortcutWitness { readonly pid?: number; readonly stage?: string; readonly failure?: string }
    const readShortcutWitness = (): ShortcutWitness | null => {
      try {
        const contents = readFileSync(shortcutWitness, "utf8");
        if (contents.length === 0) return null;
        return (JSON.parse(contents) as ShortcutWitness | null) ?? { stage: "unreadable" };
      }
      catch { return { stage: "unreadable" }; }
    };
    // The decoy is a native Pi extension SHORTCUT, not a command: Pi 1.4.0 calls a
    // registered shortcut handler synchronously from the editor's input handling
    // (`CustomEditor.handleInput` -> `onExtensionShortcut` -> `handler(ctx)`), which
    // is inside the framed stdin dispatch for this exact keystroke, so the raw OSC 52
    // write is issued inside a live `local` input context and the strict bridge can
    // only refuse it. A registered command handler is invoked outside that context,
    // where the bridge withholds clipboard authority and no receipt is produced.
    const fixture = scratch.file("saved-copy-proof.cjs", `const fs=require('node:fs');
const witness=${JSON.stringify(shortcutWitness)};
module.exports=pi=>{
pi.registerShortcut('f7',{description:'Raw OSC 52 decoy issued from the input-shortcut callback',handler:()=>{
fs.writeFileSync(witness,JSON.stringify({pid:process.pid,stage:'entered'}));
let failure;
try{process.stdout.write('\\x1b]52;c;${decoy}\\x07');}catch(error){failure=String(error&&error.message||error);}
fs.writeFileSync(witness,JSON.stringify(failure===undefined?{pid:process.pid,stage:'wrote'}:{pid:process.pid,stage:'threw',failure}));
}});
pi.registerCommand('proof-exit',{description:'Exit owned fixture',handler:async(_,ctx)=>ctx.shutdown()});
};`);

    // Two owned saved conversations in the current public session-file shape.
    // The project directory uses Pi's own default encoding so this stays an
    // ordinary native saved conversation, and the header cwd is the exact owned
    // workspace the host later admits (the host resumes with `--session <file>`,
    // so the admitted file path itself is what the child opens).
    const workspace = realpathSync(workDir);
    const project = join(agentDir, "sessions", `--${workspace.replace(/[^a-zA-Z0-9]/g, "-")}--`);
    mkdirSync(project, { recursive: true, mode: 0o700 });
    const stamp = new Date(Date.UTC(2026, 0, 3, 4, 5, 6)).toISOString();
    const stampName = stamp.replaceAll(":", "-").replace(".", "-");
    const writeSession = (id: string, name: string, withAssistant: boolean): string => {
      const path = join(project, `${stampName}_${id}.jsonl`);
      const entries: unknown[] = [
        { type: "session", version: 3, id, cwd: workspace, timestamp: stamp },
        { type: "session_info", id: `${id}-name`, parentId: null, name, timestamp: stamp },
        { type: "message", id: `${id}-user`, parentId: `${id}-name`, timestamp: stamp,
          message: { role: "user", content: [{ type: "text", text: "synthetic saved prompt" }], timestamp: Date.parse(stamp) } },
      ];
      if (withAssistant) {
        // A well-formed Pi 1.4.0 assistant message: the copy path reads its last
        // text block, and nothing here contacts a model, provider, or network.
        entries.push({ type: "message", id: `${id}-assistant`, parentId: `${id}-user`, timestamp: stamp,
          message: {
            role: "assistant", api: "synthetic-api", provider: "synthetic-provider", model: "synthetic-model",
            stopReason: "stop", responseId: `${id}-response`, thinkingLevel: "off",
            content: [{ type: "text", text: ASSISTANT_TEXT }], timestamp: Date.parse(stamp),
            usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 3,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          } });
      }
      writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600, flag: "wx" });
      return path;
    };
    const assistedFile = writeSession(ASSISTED_ID, "Owned saved copy proof", true);
    const userOnlyFile = writeSession(USER_ONLY_ID, "Owned user-only control", false);

    const common: NodeJS.ProcessEnv = {
      PATH: [binDir, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      NODE_PATH: [join(process.cwd(), "node_modules"), dirname(dirname(packageRoot)), join(packageRoot, "node_modules")].join(delimiter),
      HOME: homeDir, TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1", PI_TELEMETRY: "0", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
      TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", DISPLAY: ":synthetic-recording-only",
      NODE_OPTIONS: nodeOptionsRequire(preload), PRG_COPY_LOG: helperLog,
      PRG_OWNED_BIN: binDir, PRG_COPY_LIFECYCLE: helperLifecycle,
    };
    // Pi's own default copy-on-select is pinned off so no mouse gesture can copy
    // anything implicitly; the only copy gesture in this file is a keystroke.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ fullscreenCopyOnSelect: false }), { mode: 0o600 });
    const args = ["--offline", "--no-context-files", "--no-skills", "--no-themes", "--no-extensions", "--extension", fixture, "--tui-mode", "fullscreen"];

    const owned: Array<{
      handle: InstancePty; exited: boolean; raw: string; exitCode?: number; pid: number;
      subscriptions: Array<{ dispose(): void }>;
    }> = [];
    let spawnUnconfirmed = false;
    const spawn = (file: string, argv: string[], env: NodeJS.ProcessEnv, cwd: string): (typeof owned)[number] => {
      let handle: InstancePty;
      try {
        handle = pty.spawn(file, argv, { name: "xterm-ghostty", cols: 80, rows: 30, cwd, env, encoding: "utf8" });
      } catch (error) {
        // node-pty can throw after forking but before returning the handle.
        spawnUnconfirmed = true;
        throw error;
      }
      const item: (typeof owned)[number] = { handle, exited: false, raw: "", pid: handle.pid, subscriptions: [] };
      owned.push(item); // ownership before any callback or await
      item.subscriptions.push(handle.onExit((event) => { item.exited = true; item.exitCode = event.exitCode; signal.notify(); }));
      item.subscriptions.push(handle.onData((data) => { item.raw += data; signal.notify(); }));
      return item;
    };
    const text = (surface: TerminalSurface): string => surface.frame().lines.map(stripGeneratedSgr).join("\n");
    const helperRecords = (): string[] => readFileSync(helperLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string);
    const capsuleBodies = (raw: string): CapsuleBody[] => [...raw.matchAll(/\x1b\]777;prg-native-copy-v2;([A-Za-z0-9+/]+={0,2});[0-9a-f]{64}\x07/g)]
      .map((match) => JSON.parse(Buffer.from(match[1]!, "base64").toString("utf8")) as CapsuleBody);
    // Every per-process attestation record in the owned scratch root: one per
    // pid, so the native child's evidence survives every helper descendant.
    const attestationRecords = (): Array<Attestation & { file: string }> => readdirSync(attestRoot)
      .filter((name) => name.startsWith("user-only.") || name.startsWith("saved-copy."))
      .slice(0, 32)
      .map((name) => {
        try {
          return { ...JSON.parse(readFileSync(join(attestRoot, name), "utf8")) as Attestation, file: name };
        } catch {
          return { file: name, version: 0, nonce: "", pid: -1, armed: false, dlopenHook: false,
            resolved: {}, blocked: [], reason: ["unreadable-record"] };
        }
      });

    // One explicitly framed row with its own attestation nonce, recording view of
    // the host's own PTY writes, and an independent decoder over them.
    interface Row {
      readonly manager: InstanceManager;
      readonly id: string;
      readonly pane: TerminalSurface;
      readonly child: (typeof owned)[number];
      readonly bootstrap: SessionHostBootstrap;
      readonly writes: string[];
      readonly delivered: NativeClipboardEvent[];
      readonly input: (data: string) => void;
      /** The local dispatch id whose assembled payload is exactly `payload`. */
      readonly dispatchOf: (payload: string) => number;
      /** Every decoded dispatch id with its explicit origin. */
      readonly origins: () => Map<number, NativeInputOrigin>;
      /** Receipts authenticated against this registration from this child's output. */
      readonly receipt: () => NativeClipboardOriginEvent[];
      /** This row's OWN child attestation record (pid-scoped, never a descendant's). */
      readonly attestationFile: () => string;
      /** Bounded, leg-scoped facts for the owned failure artifact (no capsule secrets). */
      readonly facts: () => Record<string, unknown>;
    }
    const surfaces: TerminalSurface[] = [];
    const managers: InstanceManager[] = [];
    const launched: Row[] = [];
    // Which leg was in flight when a failure happened; written into the owned
    // diagnostic artifact and appended to the thrown message so the path and the
    // leg are visible in the test log itself.
    let leg = "fixture setup";
    let failureCaptured = false;
    let originalFailure: unknown;
    scratch.setWritersSettled(false);
    const broker = await createStatusBroker({ socketRoot: brokerRoot }).catch((error: unknown) => {
      // The broker completes its startup rollback before rejecting; after()
      // will also verify it left no unresolved filesystem occupant.
      scratch.setWritersSettled(true);
      throw error;
    });
    const launchRow = async (nonce: string, admission: SavedSessionAdmission): Promise<Row> => {
      const env: NodeJS.ProcessEnv = { ...common, PRG_CLIP_ATTEST: join(attestRoot, nonce), PRG_CLIP_ATTEST_NONCE: nonce };
      const writes: string[] = [];
      const delivered: NativeClipboardEvent[] = [];
      let child: (typeof owned)[number] | undefined;
      let bootstrap: SessionHostBootstrap | undefined;
      const manager = new InstanceManager({
        packageRoot: candidate.root, piExecutable: cli, statusRegistrar: broker,
        profileRegistry: new NativeAgentRegistry({ env }), nativeSetup: true, nativeInputOriginFraming: true,
        env, args, cols: 80, rows: 30,
        onChange: () => signal.notify(),
        onNativeClipboard: (_id, event) => { delivered.push(event); signal.notify(); },
        ptyFactory: (descriptor) => {
          const frame = descriptor.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP;
          if (frame !== undefined) {
            try { bootstrap = JSON.parse(frame) as SessionHostBootstrap; } catch { bootstrap = undefined; }
          }
          child = spawn(descriptor.file, descriptor.args, descriptor.env, descriptor.cwd);
          const handle = child.handle;
          // A recording view of the SAME owned handle: the host's writes are the
          // wire under test and nothing else about the child changes.
          return {
            get pid(): number { return handle.pid; },
            get cols(): number { return handle.cols; },
            get rows(): number { return handle.rows; },
            onData: (listener) => handle.onData(listener),
            onExit: (listener) => handle.onExit(listener),
            on: (event, listener) => handle.on?.(event, listener),
            removeListener: (event, listener) => handle.removeListener?.(event, listener),
            write: (data) => { writes.push(typeof data === "string" ? data : data.toString("latin1")); handle.write(data); },
            resize: (columns, rows) => handle.resize(columns, rows),
            kill: (sig) => handle.kill(sig),
            pause: () => handle.pause(),
            resume: () => handle.resume(),
          };
        },
      });
      managers.push(manager); // ownership before the first await
      const id = await manager.create({ workspace: admission.workspace, savedSession: admission });
      const pane = manager.surface(id)!;
      surfaces.push(pane);
      if (child === undefined || bootstrap === undefined) {
        throw new Error("the opted-in row must own both its child and its one-shot bootstrap");
      }
      const framedChild = child;
      const framedBootstrap = bootstrap;
      assert.equal(framedBootstrap.inputOriginFraming, 1, "the closed mode reached the actual one-shot bootstrap");
      // An independent decoder over the host's own writes for this registration.
      // One logical dispatch is one host write here, so a dispatch's fragments stay
      // contiguous and an interleaved protocol reply can never merge into it.
      const frames: NativeInputFragment[] = [];
      const decoder = createNativeInputDecoder(framedBootstrap);
      const attestationFile = (): string => join(attestRoot, `${nonce}.${framedChild.pid}.json`);
      // Receipts are re-authenticated here from this child's own capsules with
      // this registration; the v2 origin and dispatch id exist only on the
      // receipt, never on the v1 event handed to `onNativeClipboard`.
      const receipts = (): NativeClipboardOriginEvent[] => {
        const seen: NativeClipboardOriginEvent[] = [];
        const receive = createNativeClipboardReceiver(framedBootstrap, () => undefined, (receipt) => { seen.push(receipt); });
        for (const match of framedChild.raw.matchAll(/\x1b\]777;([^\x07]*)\x07/g)) receive(match[1]!);
        return seen;
      };
      let through = 0;
      const assembled = (): Map<number, { origin: NativeInputOrigin; payload: string }> => {
        for (; through < writes.length; through += 1) {
          const fed = decoder.feed(writes[through]!);
          assert.equal(fed.ok, true, `every host write authenticates against this registration: ${fed.ok ? "" : fed.code}`);
          frames.push(...fed.fragments);
        }
        const byId = new Map<number, { origin: NativeInputOrigin; parts: Buffer[] }>();
        for (const fragment of frames) {
          const entry = byId.get(fragment.dispatchId) ?? { origin: fragment.origin, parts: [] };
          entry.parts.push(fragment.payload);
          byId.set(fragment.dispatchId, entry);
        }
        return new Map([...byId].map(([dispatchId, entry]): [number, { origin: NativeInputOrigin; payload: string }] =>
          [dispatchId, { origin: entry.origin, payload: Buffer.concat(entry.parts).toString("utf8") }]));
      };
      const row: Row = {
        manager, id, pane, child: framedChild, bootstrap: framedBootstrap, writes, delivered,
        attestationFile,
        input: (data) => manager.write(id, data),
        dispatchOf: (payload) => {
          const matches = [...assembled()].filter(([, entry]) => entry.origin.kind === "local" && entry.payload === payload);
          assert.ok(matches.length > 0, "the recorded keystroke travelled as its own local dispatch");
          return matches.at(-1)![0];
        },
        origins: () => new Map([...assembled()].map(([dispatchId, entry]): [number, NativeInputOrigin] => [dispatchId, entry.origin])),
        receipt: receipts,
        facts: () => ({
          nonce, instanceId: id, pid: framedChild.pid, hostWrites: writes.length,
          unframedWrites: writes.filter((frame) => !frame.startsWith("prg-ni-v2;")).length,
          // Whether this child's own shortcut callback ran and issued its write: the
          // fact that separates "refused" from "never attempted" on an N2 failure.
          shortcutWitness: readShortcutWitness(),
          attestation: existsSync(attestationFile()) ? JSON.parse(readFileSync(attestationFile(), "utf8")) as Attestation : null,
          dispatches: [...assembled()].slice(0, 64).map(([dispatchId, entry]) =>
            ({ dispatchId, origin: entry.origin.kind, payload: entry.payload.slice(0, 64) })),
          receipts: receipts().slice(0, 16).map((receipt) =>
            ({ kind: receipt.event.kind, origin: receipt.origin.kind, dispatchId: receipt.dispatchId,
              sessionId: receipt.event.sessionId, sessionEpoch: receipt.event.sessionEpoch,
              ...("reason" in receipt.event ? { reason: receipt.event.reason } : {}) })),
          delivered: delivered.map((event) => event.kind),
          helperCalls: helperRecords().length,
          nativeSession: manager.list().find((view) => view.id === id)?.nativeSession ?? null,
        }),
      };

      await signal.waitFor(() => framedChild.raw.includes("\x1b]777;prg-native-input-ready-v1;"), 20_000,
        "the strict child authenticated its decoder installation");
      await signal.waitFor(() => {
        const native = manager.list().find((view) => view.id === id)?.nativeSession;
        return text(pane).includes("─".repeat(20)) && native?.sessionId === admission.sessionId
          && native.epoch >= 1;
      }, 20_000, "opted-in native editor and admitted conversation tuple");
      const readyAt = framedChild.raw.indexOf("\x1b]777;prg-native-input-ready-v1;");
      const firstQuery = Math.min(...["\x1b[?u", "\x1b[>0q", "\x1b[6n", "\x1b]10;?"].map((probe) => {
        const at = framedChild.raw.indexOf(probe);
        return at < 0 ? Number.POSITIVE_INFINITY : at;
      }));
      assert.ok(Number.isFinite(firstQuery), "the actual native child emitted a startup query");
      assert.ok(readyAt < firstQuery, "readiness precedes this child's own startup queries, so a reply can never be typed unframed");
      assert.ok(writes.every((frame) => frame.startsWith("prg-ni-v2;")), "no host byte ever reached this child unframed");

      // Pre-copy safety fence: positive per-child attestation that the OS clipboard
      // backend is intercepted in THIS pid and every clipboard command resolves to
      // the owned recorder on THIS child's PATH. Nothing may be copied without it.
      const ownRecords = attestationRecords().filter((record) => record.nonce === nonce);
      assert.ok(existsSync(attestationFile()),
        `the owned preload must attest interception in this child's own record ${attestationFile()}; ` +
        `records for this launch: ${ownRecords.map((record) => `${record.file}:pid=${record.pid}`).join(",") || "none"}`);
      const attestation = JSON.parse(readFileSync(attestationFile(), "utf8")) as Attestation;
      assert.equal(attestation.nonce, nonce, "the attestation belongs to this launch");
      assert.equal(attestation.pid, framedChild.pid, "the attestation belongs to this exact child pid");
      assert.equal(attestation.dlopenHook, true, "the OS clipboard native module must be blocked in this child");
      assert.equal(attestation.armed, true, `clipboard interception is not armed: ${attestation.reason.join(",")}`);
      for (const command of CLIPBOARD_COMMANDS) {
        assert.equal(attestation.resolved[command], join(binDir, command),
          `${command} must resolve to the owned recorder first on this child's PATH, never a system clipboard`);
      }
      return row;
    };

    try {
      leg = "owned catalog and admission";
      const catalog = await listSavedSessions({ agentDir, piExecutable: cli, expectedPiVersion: manifest.version });
      assert.equal(catalog.issueCount, 0, "the owned saved conversations catalog is clean");
      const admit = (file: string, id: string): SavedSessionAdmission => {
        const row = catalog.rows.find((entry) => entry.file === file);
        assert.ok(row, "the owned saved conversation is listed through the public SDK");
        const result = admitSavedSession(catalog, row);
        if (result.status !== "admitted") throw new Error(`the owned saved conversation was refused: ${result.reason}`);
        assert.equal(result.admission.sessionId, id, "the receipt carries the conversation's own id");
        assert.equal(result.admission.sessionId, row.id);
        assert.equal(result.admission.workspace, workspace, "the admitted workspace is the conversation's own recorded cwd");
        return result.admission;
      };
      const assisted = admit(assistedFile, ASSISTED_ID);
      const userOnly = admit(userOnlyFile, USER_ONLY_ID);

      // N1: the same documented key on a conversation with no assistant message.
      leg = "N1 user-only saved conversation";
      const guard = await launchRow("user-only", userOnly);
      launched.push(guard);
      const guardHelperBefore = helperRecords().length;
      guard.input(CTRL_X);
      await signal.waitFor(() => guard.child.raw.includes("No agent messages to copy yet."), 20_000,
        "native reports there is nothing to copy, with no assistant message in the resumed conversation");
      await signal.waitForQuiet(() => guard.delivered.length > 0 || helperRecords().length > guardHelperBefore, 300,
        "the same key with no assistant text produces no capsule and no helper invocation");
      assert.equal(guard.child.raw.includes("\x1b]777;prg-native-copy"), false,
        "a conversation with no assistant message emits no copy capsule at all");
      const guardStop = await guard.manager.shutdown({ graceMs: 8000, killMs: 2000 });
      assert.deepEqual(guardStop.remainingIds, []);
      assert.deepEqual(guardStop.forcedIds, []);
      await signal.waitFor(() => guard.child.exited, 5000, "user-only owned child exit");

      // The copy row: resume the conversation that already holds the assistant text.
      leg = "resume the saved conversation";
      const row = await launchRow("saved-copy", assisted);
      launched.push(row);
      assert.equal(row.child.raw.includes("\x1b]52;c;"), false, "nothing is copied before the first copy key");
      await signal.waitFor(() => text(row.pane).includes("SAVEDCOPY466-A") && text(row.pane).includes("SAVEDCOPY466-B"),
        20_000, "the resumed saved conversation renders its own seeded assistant text");
      const resumed = row.manager.list().find((view) => view.id === row.id)!.nativeSession!;
      assert.equal(resumed.sessionId, assisted.sessionId,
        "the live native conversation is the deliberately resumed one, not a process-boot session");
      assert.ok(resumed.epoch >= 1, "the resumed conversation carries a real native epoch");

      // Trigger 1: Pi's documented default copy key with no active selection.
      leg = "copy key Ctrl+X on the resumed conversation";
      const helperBefore = helperRecords().length;
      row.input(CTRL_X);
      const ctrlXDispatch = row.dispatchOf(CTRL_X);
      // Pi's own confirmation for the copy-key path is a transient composite; the
      // child's raw output stream keeps the evidence without racing the flash.
      await signal.waitFor(() => row.child.raw.includes("Copied!"), 20_000, "native confirms the copy-key gesture");
      await signal.waitFor(() => row.delivered.some((event) => event.kind === "copy"), 20_000,
        "the resumed conversation's last-assistant copy routes through the host");
      assert.equal(helperRecords().length, helperBefore + 1, "the unchanged native helper ran exactly once");
      assert.equal(helperRecords().at(-1), ASSISTANT_TEXT,
        "the bytes handed to the recording helper are the seeded assistant text exactly");
      const first = row.receipt();
      assert.equal(first.length, 1, "one copy receipt, and readiness consumed no copy sequence");
      assert.equal(first[0]!.origin.kind, "local", "the copy is explicitly attributed to local user input");
      assert.equal(first[0]!.dispatchId, ctrlXDispatch,
        "the copy is caused by the recorded Ctrl+X dispatch, even though native awaits the helper first");
      const firstEvent = first[0]!.event;
      if (firstEvent.kind !== "copy") throw new Error(`the documented copy key must yield a copy receipt, got ${firstEvent.kind}`);
      assert.equal(Buffer.from(firstEvent.encoded, "base64").toString("utf8"), ASSISTANT_TEXT,
        "the authenticated payload is the resumed conversation's assistant text byte-exactly");
      assert.equal(first[0]!.event.sessionId, assisted.sessionId, "the receipt names the resumed conversation id");
      assert.equal(first[0]!.event.sessionEpoch, resumed.epoch, "the receipt names the resumed conversation epoch");

      // Trigger 2: the documented `/copy` command, a different producer entry point.
      leg = "documented /copy command";
      const statusHelperBefore = helperRecords().length;
      row.input("/copy\r");
      const copyDispatch = row.dispatchOf("/copy\r");
      await signal.waitFor(() => row.child.raw.includes("Copied last agent message to clipboard"), 20_000,
        "native reports the documented /copy command copied the last assistant message");
      await signal.waitFor(() => row.delivered.filter((event) => event.kind === "copy").length === 2, 20_000,
        "the documented command routes exactly one more copy");
      assert.equal(helperRecords().length, statusHelperBefore + 1, "the second documented trigger uses the helper once");
      const second = row.receipt()[1]!;
      assert.equal(second.dispatchId, copyDispatch, "/copy is caused by its own dispatch, not the earlier keystroke");
      assert.equal(second.origin.kind, "local");
      assert.ok(second.event.kind === "copy" && Buffer.from(second.event.encoded, "base64").toString("utf8") === ASSISTANT_TEXT);

      // N2: a raw OSC 52 write issued synchronously inside a live local dispatch —
      // the fixture's own extension shortcut, run by Pi from the F7 keystroke's
      // input handling — grants nothing.
      leg = "N2 raw OSC 52 decoy from a native input-shortcut callback";
      const decoyHelperBefore = helperRecords().length;
      assert.equal(readShortcutWitness(), null, "the shortcut witness is empty before this keystroke");
      row.input(F7);
      const decoyDispatch = row.dispatchOf(F7);
      try {
        await signal.waitFor(() => row.delivered.some((event) => event.kind === "unavailable"), 20_000,
          "the decoy is observed and refused as unverified provenance");
      } catch (error) {
        // Same failure, same budget, one extra fact: whether this child's own shortcut
        // callback ran at all distinguishes "write issued and dropped outside an input
        // context" from "the keystroke never reached a handler".
        const witnessAtFailure = readShortcutWitness();
        if (error instanceof Error) {
          error.message = `${error.message} [shortcut witness: ${witnessAtFailure === null
            ? "absent — the F7 callback never ran" : JSON.stringify(witnessAtFailure)}]`;
        }
        throw error;
      }
      // The witness is a durable file the callback itself writes around the write.
      // It is re-checked independently of notifications, and it is required: it proves
      // the callback executed in this child and that the raw OSC 52 write was issued,
      // so the refusal below cannot be a keystroke that silently did nothing.
      await signal.waitForRecheck(() => {
        const stage = readShortcutWitness()?.stage;
        return stage === "wrote" || stage === "threw";
      }, 10_000, "this child's own input-shortcut callback reported its write attempt");
      const witness = readShortcutWitness();
      assert.equal(witness?.pid, row.child.pid, "the decoy callback ran in this child's own pid");
      assert.equal(witness?.stage, "wrote", `the raw OSC 52 write was issued inside the shortcut callback: ${witness?.failure ?? ""}`);
      const refused = row.receipt().find((receipt) => receipt.event.kind === "unavailable");
      assert.ok(refused, "the refusal travels as its own authenticated receipt");
      assert.equal(refused.event.kind === "unavailable" ? refused.event.reason : undefined, "unverified-native-origin");
      assert.equal(refused.dispatchId, decoyDispatch, "the refusal is attributed to the decoy's own dispatch");
      assert.equal(refused.origin.kind, "local", "a live local dispatch explains the write without authorizing it");
      assert.equal(row.receipt().filter((receipt) => receipt.event.kind === "copy").length, 2,
        "a user-input timing window grants nothing to arbitrary output");
      assert.equal(helperRecords().length, decoyHelperBefore, "a refused decoy never reaches the clipboard helper");
      assert.equal(row.child.raw.includes(decoy), false, "the refused payload never leaves the child, capsule or raw stream");
      leg = "genuine copy after the refused decoy";
      row.input(CTRL_X);
      const retryDispatch = row.dispatchOf(CTRL_X);
      assert.notEqual(retryDispatch, ctrlXDispatch, "the retry is its own dispatch, not the earlier keystroke");
      await signal.waitFor(() => row.delivered.filter((event) => event.kind === "copy").length === 3, 20_000,
        "the genuine producer still copies after a refused decoy in the same dispatch stream");
      const third = row.receipt().filter((receipt) => receipt.event.kind === "copy").at(-1)!;
      assert.equal(third.dispatchId, retryDispatch, "the surviving copy is attributed to its own keystroke");
      assert.equal(helperRecords().length, decoyHelperBefore + 1);

      // N3: host protocol replies are `none` origin and can never be a copy.
      leg = "N3 none-origin protocol-reply and capsule audit";
      const origins = row.origins();
      const replyDispatches = [...origins].filter(([, origin]) => origin.kind === "none").map(([id]) => id);
      assert.ok(replyDispatches.length > 0, "the host's own terminal replies travelled as framed none-origin dispatches");
      const receipts = row.receipt();
      assert.equal(receipts.length, 4, "three copies and one refusal, nothing else claimed this registration");
      assert.ok(receipts.every((receipt) => receipt.origin.kind === "local"), "no receipt ever carries the none origin");
      assert.equal(receipts.some((receipt) => replyDispatches.includes(receipt.dispatchId)), false,
        "no copy receipt references a protocol-reply dispatch");
      assert.deepEqual(row.delivered.map((event) => [event.kind, event.sessionId, event.sessionEpoch]),
        receipts.map((receipt) => [receipt.event.kind, receipt.event.sessionId, receipt.event.sessionEpoch]),
        "the production route delivered exactly the receipts this registration authenticated");
      assert.ok(receipts.every((receipt) => receipt.event.sessionId === assisted.sessionId
        && receipt.event.sessionEpoch === resumed.epoch),
        "every event stayed bound to the resumed conversation tuple");
      const bodies = capsuleBodies(row.child.raw);
      assert.deepEqual(bodies.map((body) => body.sequence), [1, 2, 3, 4],
        "one process-owned bridge, one monotonic sequence, and readiness consumed no copy sequence");
      assert.ok(bodies.every((body) => body.version === 2), "a strict row emits v2 capsules only");
      assert.equal(row.child.raw.includes("prg-native-copy-v1;"), false, "a strict row never emits or accepts a v1 capsule");
      assert.equal(row.child.raw.includes("\x1b]52;c;"), false, "no raw clipboard relay leaves the opted-in child");
      assert.equal(/prg-ni-v[12]/.test(text(row.pane)) || text(row.pane).includes("prg-native-"), false,
        "framing and capsules never become screen text");
      assert.equal(text(row.pane).includes(row.bootstrap.token), false, "the registration token never reaches the frame");
      // After the helper actually ran, this child's OWN pid-scoped record must
      // still carry its own pid and interception evidence: every clipboard
      // recorder inherits the preload and attests in its own file, so it can
      // never replace the native child's record.
      const afterCopies = JSON.parse(readFileSync(row.attestationFile(), "utf8")) as Attestation;
      assert.equal(afterCopies.pid, row.child.pid, "helper runs never replaced this child's attestation record");
      assert.equal(afterCopies.armed, true, "interception stayed armed for this child through the copies");
      const descendantRecords = attestationRecords().filter((record) => record.nonce === "saved-copy" && record.pid !== row.child.pid);
      assert.ok(descendantRecords.some((record) => record.armed && record.dlopenHook
        && CLIPBOARD_COMMANDS.every((command) => record.resolved[command] === join(binDir, command))),
        "the owned clipboard recorder inherited the blocking preload and attested its own interception record");
      if (process.platform === "darwin") {
        // On macOS the native addon is the FIRST clipboard writer, so a real copy
        // must show that this child's blocked-dlopen hook actually fired.
        assert.ok(afterCopies.blocked.some((name) => /^darwin-platform\.node$/.test(name)),
          "the native OS clipboard module load was actually intercepted in this child");
      }
      row.input("/proof-exit\r");
      leg = "owned copy child exit";
      await signal.waitFor(() => row.child.exited, 20_000, "owned copy child exits on the fixture command");
      assert.equal(row.child.exitCode, 0, "the owned child exited cleanly");
      // Deliberately no assertion about a physical terminal or OS clipboard.
    } catch (error) {
      failureCaptured = true;
      originalFailure = error;
      const safeFacts = (item: Row): Record<string, unknown> => {
        try { return item.facts(); } catch (inner) { return { factsFailed: String(inner) }; }
      };
      const facts = launched.map(safeFacts);
      t.diagnostic(`saved-copy failure [leg: ${leg}]; row evidence: ${JSON.stringify(facts).slice(0, 8192)}`);
      try {
        scratch.file("failure.json", JSON.stringify({
          leg, root, error: String(error), helpers: helperRecords(),
          frames: surfaces.map(text),
          // Leg-scoped facts per launched row: attestation, framing, receipts.
          rows: facts,
          // Every per-process record, so the native child's evidence and each
          // descendant's own record are both visible after a failure.
          attestations: attestationRecords(),
          outputs: owned.map((item) => ({ pid: item.pid, exited: item.exited, raw: item.raw.slice(-262144) })),
        }));
      } catch (diagnosticError) {
        t.diagnostic(`could not write saved-copy failure artifact: ${String(diagnosticError)}`);
      }
      if (error instanceof Error) {
        error.message = `${error.message} [leg: ${leg}]`;
      }
      throw error;
    } finally {
      // One failed cleanup must not skip another owned child or hide the original
      // assertion. Every attempt retains its existing budget and owned handle.
      const cleanupErrors: unknown[] = [];
      for (const manager of managers) {
        try {
          const outcome = await manager.shutdown({ graceMs: 2000, killMs: 2000 });
          assert.deepEqual(outcome.remainingIds, [], "saved-copy manager has no unsettled rows");
        } catch (error) { cleanupErrors.push(error); }
      }
      for (const item of owned) {
        if (!item.exited) {
          try {
            item.handle.kill("SIGTERM");
            await signal.waitFor(() => item.exited, 5000, "owned fixture cleanup exit");
          } catch (error) { cleanupErrors.push(error); }
        }
        if (item.exited) {
          for (const subscription of item.subscriptions) {
            try { subscription.dispose(); } catch (error) { cleanupErrors.push(error); }
          }
        }
      }
      for (const manager of managers) {
        try { await manager.dispose(); } catch (error) { cleanupErrors.push(error); }
      }
      for (const surface of surfaces) {
        try { surface.dispose(); } catch (error) { cleanupErrors.push(error); }
      }
      try { await broker.dispose(); } catch (error) { cleanupErrors.push(error); }
      try {
        assert.equal(spawnUnconfirmed, false, "no copy PTY spawn lost its ownership handle");
        assert.ok(owned.every((item) => item.exited), "every original copy PTY reports exit");
        verifyRoot();
        await settleClipboardHelpers(helperLifecycle, helperLifecycleReceipt, failureCaptured ? 0 : helperRecords().length);
      }
      catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          failureCaptured ? [originalFailure, ...cleanupErrors] : cleanupErrors,
          `owned saved-copy fixture cleanup unconfirmed; evidence retained at ${root}`,
        );
      }
      scratch.setWritersSettled(true);
    }
  });
