import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
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
 * A failing leg writes one owned diagnostic artifact (`failure.json` under this
 * invocation's own scratch root) with the leg name, each row's pre-copy
 * attestation, framing/receipt facts, and bounded child output; the leg and the
 * artifact path are appended to the thrown message so they are visible in the
 * test log. Nothing outside the owned scratch root is written.
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
/** The clipboard commands Pi 1.4.0 may spawn; all must be owned recorders. */
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

test("resumed saved-session copy is bound to its own conversation, keystroke, and pre-copy OS-write interception",
  { timeout: 120_000 }, async (t) => {
    if (process.platform === "win32") { t.skip("native Windows sidebar acceptance remains experimental"); return; }
    if (process.env.PI_REVIEW_GATE_RUNTIME_ROLE) { t.skip("native primary-host proof cannot run in a delegated role"); return; }
    const packageRoot = findInstalledAgentDirs().find((path) => {
      try { return JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version === "1.4.0"; } catch { return false; }
    });
    if (!packageRoot) { skipOrFail(t, "installed native Pi 1.4.0 is required"); return; }
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { bin: { pi: string } };
    const cli = realpathSync(join(packageRoot, manifest.bin.pi));
    assert.match(manifest.bin.pi, /dist\/bundle\/cli\.js$/, "exercise the actual package-declared bundled executable");
    const requireHere = createRequire(join(process.cwd(), "package.json"));
    const pty = requireHere("@lydell/node-pty") as { spawn(file: string, args: string[], options: Record<string, unknown>): InstancePty };

    const root = realpathSync(mkdtempSync("/tmp/prg-saved-copy-"));
    const candidate = compileAndStageCandidate(root); // inactive build; never live dist/
    const binDir = join(root, "bin");
    const attestRoot = join(root, "attest");
    const workDir = join(root, "work");
    for (const name of ["home", "tmp", "broker"]) mkdirSync(join(root, name), { mode: 0o700 });
    for (const dir of [binDir, attestRoot, workDir]) mkdirSync(dir, { mode: 0o700 });
    const agentDir = makeNativeAgentRoot(root, { deferredPiTools: false });
    const signal = new ChangeSignal();
    const helperLog = join(root, "helper.jsonl");
    const recorder = join(root, "clipboard-recorder.cjs");
    writeFileSync(recorder, `const fs=require('node:fs');const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>fs.appendFileSync(process.env.PRG_COPY_LOG,JSON.stringify(Buffer.concat(chunks).toString('utf8'))+'\\n'));`, { mode: 0o600, flag: "wx" });
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
    const preload = join(root, "block-native-clipboard.cjs");
    writeFileSync(preload, `'use strict';
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
`, { mode: 0o600, flag: "wx" });
    const decoy = Buffer.from("SAVEDCOPY466-DECOY").toString("base64");
    // Witness for the decoy attempt, written by the fixture's own shortcut callback
    // inside this child. Without it, "no copy receipt" could be satisfied by a
    // keystroke that never reached a handler at all; with it, the refusal asserted
    // below can only be a refusal of a write that was actually issued.
    const shortcutWitness = join(root, "shortcut-witness.json");
    interface ShortcutWitness { readonly pid?: number; readonly stage?: string; readonly failure?: string }
    const readShortcutWitness = (): ShortcutWitness | null => {
      if (!existsSync(shortcutWitness)) return null;
      try { return JSON.parse(readFileSync(shortcutWitness, "utf8")) as ShortcutWitness; }
      catch { return { stage: "unreadable" }; }
    };
    // The decoy is a native Pi extension SHORTCUT, not a command: Pi 1.4.0 calls a
    // registered shortcut handler synchronously from the editor's input handling
    // (`CustomEditor.handleInput` -> `onExtensionShortcut` -> `handler(ctx)`), which
    // is inside the framed stdin dispatch for this exact keystroke, so the raw OSC 52
    // write is issued inside a live `local` input context and the strict bridge can
    // only refuse it. A registered command handler is invoked outside that context,
    // where the bridge withholds clipboard authority and no receipt is produced.
    const fixture = join(root, "saved-copy-proof.cjs");
    writeFileSync(fixture, `const fs=require('node:fs');
const witness=${JSON.stringify(shortcutWitness)};
module.exports=pi=>{
pi.registerShortcut('f7',{description:'Raw OSC 52 decoy issued from the input-shortcut callback',handler:()=>{
fs.writeFileSync(witness,JSON.stringify({pid:process.pid,stage:'entered'}));
let failure;
try{process.stdout.write('\\x1b]52;c;${decoy}\\x07');}catch(error){failure=String(error&&error.message||error);}
fs.writeFileSync(witness,JSON.stringify(failure===undefined?{pid:process.pid,stage:'wrote'}:{pid:process.pid,stage:'threw',failure}));
}});
pi.registerCommand('proof-exit',{description:'Exit owned fixture',handler:async(_,ctx)=>ctx.shutdown()});
};`, { mode: 0o600, flag: "wx" });

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
      HOME: join(root, "home"), TMPDIR: join(root, "tmp"), PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1", PI_TELEMETRY: "0", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
      TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", DISPLAY: ":synthetic-recording-only",
      NODE_OPTIONS: `--require=${preload}`, PRG_COPY_LOG: helperLog,
      PRG_OWNED_BIN: binDir,
    };
    // Pi's own default copy-on-select is pinned off so no mouse gesture can copy
    // anything implicitly; the only copy gesture in this file is a keystroke.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ fullscreenCopyOnSelect: false }), { mode: 0o600 });
    const args = ["--offline", "--no-context-files", "--no-skills", "--no-themes", "--no-extensions", "--extension", fixture, "--tui-mode", "fullscreen"];

    const owned: Array<{ handle: InstancePty; exited: boolean; raw: string; exitCode?: number; pid: number }> = [];
    const spawn = (file: string, argv: string[], env: NodeJS.ProcessEnv, cwd: string): (typeof owned)[number] => {
      const handle = pty.spawn(file, argv, { name: "xterm-ghostty", cols: 80, rows: 30, cwd, env, encoding: "utf8" });
      const item: (typeof owned)[number] = { handle, exited: false, raw: "", pid: handle.pid };
      owned.push(item); // ownership before any callback or await
      handle.onExit((event) => { item.exited = true; item.exitCode = event.exitCode; signal.notify(); });
      handle.onData((data) => { item.raw += data; signal.notify(); });
      return item;
    };
    const text = (surface: TerminalSurface): string => surface.frame().lines.map(stripGeneratedSgr).join("\n");
    const helperRecords = (): string[] => existsSync(helperLog)
      ? readFileSync(helperLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string) : [];
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
    const broker = await createStatusBroker({ socketRoot: join(root, "broker") });
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
      const catalog = await listSavedSessions({ agentDir, piExecutable: cli, expectedPiVersion: "1.4.0" });
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
      assert.equal(readShortcutWitness(), null, "the shortcut witness starts absent, so it can only be this keystroke's");
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
      const artifact = join(root, "failure.json");
      const safeFacts = (item: Row): Record<string, unknown> => {
        try { return item.facts(); } catch (inner) { return { factsFailed: String(inner) }; }
      };
      let recorded = false;
      try {
        writeFileSync(artifact, JSON.stringify({
          leg, root, error: String(error), helpers: helperRecords(),
          frames: surfaces.map(text),
          // Leg-scoped facts per launched row: attestation, framing, receipts.
          rows: launched.map(safeFacts),
          // Every per-process record, so the native child's evidence and each
          // descendant's own record are both visible after a failure.
          attestations: attestationRecords(),
          outputs: owned.map((item) => ({ pid: item.pid, exited: item.exited, raw: item.raw.slice(-262144) })),
        }), { mode: 0o600, flag: "wx" });
        recorded = true;
      } catch { /* Preserve the original assertion and still settle owned children. */ }
      // The failing leg and the owned artifact path stay visible in the test log.
      if (error instanceof Error) {
        error.message = `${error.message} [leg: ${leg}]${recorded ? ` [owned diagnostic: ${artifact}]` : ""}`;
      }
      throw error;
    } finally {
      // One failed cleanup must not skip another owned child or hide the original
      // assertion. Every attempt retains its existing budget and owned handle.
      const cleanupErrors: unknown[] = [];
      for (const manager of managers) {
        try { await manager.shutdown({ graceMs: 2000, killMs: 2000 }); }
        catch (error) { cleanupErrors.push(error); }
      }
      for (const item of owned) {
        if (!item.exited) {
          try {
            item.handle.kill("SIGTERM");
            await signal.waitFor(() => item.exited, 5000, "owned fixture cleanup exit");
          } catch (error) { cleanupErrors.push(error); }
        }
      }
      for (const manager of managers) {
        try { await manager.dispose(); } catch (error) { cleanupErrors.push(error); }
      }
      for (const surface of surfaces) {
        try { surface.dispose(); } catch (error) { cleanupErrors.push(error); }
      }
      try { await broker.dispose(); } catch (error) { cleanupErrors.push(error); }
      // Retain invocation-owned synthetic evidence; never remove unconfirmed or
      // unknown files, and never scan or clean user sessions or unselected trees.
      try { assert.ok(owned.every((item) => item.exited)); }
      catch (error) { cleanupErrors.push(error); }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          failureCaptured ? [originalFailure, ...cleanupErrors] : cleanupErrors,
          `owned saved-copy fixture cleanup unconfirmed; evidence retained at ${root}`,
        );
      }
    }
  });
