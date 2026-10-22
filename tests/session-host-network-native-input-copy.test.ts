import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createStatusBroker } from "../src/session-host/broker";
import { translateInput } from "../src/session-host/input";
import {
  DEFAULT_INSTANCE_COLS,
  DEFAULT_INSTANCE_ROWS,
  InstanceManager,
  type InstanceManagerOptions,
  type InstancePty,
} from "../src/session-host/instances";
import {
  createNativeClipboardReceiver,
  type NativeClipboardEvent,
  type NativeClipboardOriginEvent,
} from "../src/session-host/native-clipboard";
import {
  NATIVE_INPUT_RAW_FRAGMENT_BYTES,
  NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES,
  createNativeInputDecoder,
  type NativeInputFragment,
  type NativeInputOrigin,
} from "../src/session-host/native-input-origin";
import { createInMemoryDirectionalGrantStore, type PeerByteChannel } from "../src/session-host/network/index";
import { attachSessionContentViewer, type SessionContentViewer } from "../src/session-host/network/session-content-client";
import {
  createSessionContentHost,
  type SessionContentChannelBinding,
  type SessionContentHost,
  type SessionContentHostDiagnosticCode,
} from "../src/session-host/network/session-content-host";
import {
  DEFAULT_SESSION_CONTENT_BOUNDS,
  NATIVE_COPY_MAX_ENCODED_CHARS,
  NATIVE_TEXT_PASTE_MAX_BYTES,
  decodeSessionContentFrame,
  nativeIoSourceEquals,
  type NativeIoCompletedCopy,
  type NativeIoSource,
  type SessionContentCopyBeginFrame,
  type SessionContentCopyChunkFrame,
  type SessionContentCopyEndFrame,
  type SessionContentFrame,
  type SessionContentInputBeginFrame,
  type SessionContentInputChunkFrame,
  type SessionContentInputEndFrame,
  type SessionContentInputFrame,
  type SessionContentSnapshot,
} from "../src/session-host/network/session-content-protocol";
import { createLocalOwningHostService, type OwningHostManager } from "../src/session-host/owning-host-service";
import { NativeAgentRegistry } from "../src/session-host/profiles";
import type { SessionHostBootstrap } from "../src/session-host/protocol";
import { admitSavedSession, listSavedSessions, type SavedSessionAdmission } from "../src/session-host/saved-sessions";
import { stripGeneratedSgr, type TerminalSurface } from "../src/session-host/terminal-surface";
import { skipOrFail } from "./bridge-fakes";
import { ChangeSignal, compileAndStageCandidate, makeNativeAgentRoot } from "./helpers/session-host-native-main-harness";
import { findInstalledAgentDirs } from "./menu-tui-fakes";
import { deferred, newIdentity, startClient, startHost, withTimeout, type HostFixture } from "./session-host-network-helpers";

/**
 * Network native input and copy proof over the real TLS content lane.
 *
 * Proof level: SAME-HOST POSIX only. Everything below runs on one machine and
 * exercises, unmodified: the `/app` TLS listener and its WebSocket upgrade, the
 * pairing accept and the directional grant the content endpoint consults, both
 * in-memory TLS identities, ONE `createLocalOwningHostService` and its ONE
 * `InstanceManager` over a REAL owned PTY running the installed pinned Pi 1.3.0
 * bundled CLI, the manager's per-viewer input scope and viewer-only copy sink,
 * and BOTH content endpoints. The conversation is a deliberately resumed saved
 * session admitted through the real public catalog, so no model, provider, API
 * key, or network request is involved in any leg. This is NOT a real physical
 * clipboard, NOT Windows ConPTY, NOT a mobile client, NOT a genuine
 * cross-machine deployment, and NOT a full Main / user-operator acceptance.
 * The viewer's `authorizeInput` seam here is an INDEPENDENT simulated written
 * snapshot commit maintained by this test itself, never a physical Main,
 * terminal, or UI certificate; native Pi's own written receipts are covered
 * separately by their own tests.
 *
 * What this case adds beyond the existing focused tests:
 *
 * - `session-host-network-session-content-integration.test.ts` owns the real
 *   transport and endpoint boundaries with a synthetic in-memory PTY. Here the
 *   same real transport and endpoints carry a REAL child's native input and
 *   native copy payload.
 * - `session-host-native-clipboard-saved-copy-origin.test.ts` owns local
 *   keystroke copy lineage against the real CLI. Here the same real producer is
 *   caused by a keystroke that arrived from the network viewer, crossed viewer
 *   -> atomic owner assembly -> whole viewer bridge -> the real child's stdin
 *   and editor, and its copy travels back only to that initiating viewer.
 *
 * Before ANY copy gesture this file requires a positive per-child attestation
 * written by this fixture's own `--require` preload: the OS clipboard native
 * module is blocked in that exact child pid (the `dlopen` hook is observed
 * installed) and every clipboard command resolves to this fixture's owned
 * recorder first on that child's PATH. An installed hook only attests that the
 * interception is in place, so the same child must also OBSERVE the block: its
 * own fixture `session_start` handler imports the exact resolved public pinned
 * `@earendil-works/pi-tui` 1.3.0 module and calls exactly one documented
 * load-only public probe, `getNativeClipboard()`, which loads the addon but does
 * not open a display and does not touch a clipboard. The probe never calls
 * `getText`, `getImage`, `getFilePaths`, or `setText`. It writes this child's own
 * pid- and nonce-scoped witness reporting `backendUnavailable: true`, and the
 * preload's persisted attestation must then name the exact platform native
 * basename its hook refused. A real backend object, a missing module, export, or
 * witness, or an unrecorded block fails before the key is sent, with no fallback
 * and no synthetic success, so no physical OS clipboard write is attempted and
 * no claim is made about one. Recording is inherited by the helper, so each
 * descendant attests in its own pid-scoped record and can never overwrite the
 * native child's record. The probe uses this repository's pinned public TUI
 * alias, while the native producer runs in the separately pinned bundled CLI.
 * Isolation is proved by the same child's process-wide addon block, not shared
 * module identity. The native producer and helper code are not modified.
 *
 * The copy payload is deliberately the full native producer bound: 75,000 ASCII
 * assistant bytes encode to exactly 100,000 base64 characters (Pi 1.3.0's OSC 52
 * limit), so the copy has to cross whole instead of being trimmed to a transport
 * message. The wire pages that canonical base64 STRING as ASCII bytes: the
 * header declares 100,000 bytes and four chunks (32,768, 32,768, 32,768, 1,696).
 * Joining the decoded wire pages yields the producer's original base64 string;
 * decoding that string then yields the exact 75,000 assistant bytes. The text
 * payload and producer bound are unchanged.
 *
 * The input legs reuse the existing public registered `/input-proof` command (the
 * same shape the routing test owns): the command turns the text the REAL child
 * received into a SHA-256 marker, so the independent digest is over the native
 * command's expanded text, not over recorded PTY bytes and not over any exported
 * transcript. Input bodies are the viewer's already-normalized packets; the owner
 * translates exactly once and the viewer never double-wraps.
 */

/** Pi 1.3.0's documented default `app.message.copy` binding (Ctrl+X). */
const CTRL_X = "\x18";
/** Legacy F7 as Pi 1.3.0's own key table spells it. */
const F7 = "\x1b[18~";
/** The documented copy command, as one already-normalized keyboard packet. */
const COPY_COMMAND = "/copy\r";
/** The public registered command this fixture adds for an independent digest. */
const PROOF_PREFIX = "/input-proof ";
/** The clipboard commands Pi 1.3.0 may spawn; all must be owned recorders. */
const CLIPBOARD_COMMANDS = ["pbcopy", "xclip", "xsel", "wl-copy", "termux-clipboard-set"] as const;
const SAVED_SESSION_ID = "0672e0a1-4a1f-7c31-9b2a-1f4c9d0000c1";

/**
 * Exactly 75,000 ASCII bytes of curated assistant text: a 13-byte head marker,
 * filler, and a 13-byte tail marker. 75,000 bytes is divisible by three, so the
 * canonical base64 form is exactly 100,000 characters with no padding - the full
 * native producer bound, not a transport message size.
 */
const ASSISTANT_TEXT = (() => {
  const head = "NETCOPY750-A ";
  const tail = " NETCOPY750-Z";
  const pattern = "0123456789abcdefghijklmnopqrstuvwxyz";
  const fillerLength = 75_000 - head.length - tail.length;
  const filler = pattern.repeat(Math.ceil(fillerLength / pattern.length)).slice(0, fillerLength);
  return `${head}${filler}${tail}`;
})();
/** Canonical base64 of the seeded assistant text; the producer emits exactly this. */
const ASSISTANT_ENCODED = Buffer.from(ASSISTANT_TEXT, "utf8").toString("base64");

const UNICODE_TEXT = "αβ café 雪 — ünïcödé NETINPUT-A";
const UNICODE_BODY = `${PROOF_PREFIX}${UNICODE_TEXT}`;
/**
 * Exactly one MiB of decoded paste text body: the unchanged native paste cap.
 * The body is the command prefix plus an ASCII payload, so the digest marker can
 * never be satisfied by a truncated body, a re-wrapped body, or a partial page.
 */
const BIG_PAYLOAD = "N".repeat(NATIVE_TEXT_PASTE_MAX_BYTES - PROOF_PREFIX.length);
const BIG_BODY = `${PROOF_PREFIX}${BIG_PAYLOAD}`;
/** The two canonical native bracketed-paste markers around one text body. */
const PASTE_WRAPPER_BYTES = 12;

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

interface ShortcutWitness {
  readonly pid?: number;
  readonly stage?: string;
  readonly failure?: string;
}

/**
 * This child's own record of the public load-only backend probe. `probe` is the
 * one documented export the fixture calls, and `backendUnavailable` is the exact
 * fact the pre-copy fence requires; `failure` is present only when the probe
 * could not establish that fact, which fails the case closed.
 */
interface BackendProof {
  version: number;
  nonce: string;
  pid: number;
  moduleUrl: string;
  probe: string;
  exportType: string;
  backendUnavailable: boolean;
  failure?: string;
}

/**
 * Transparent tap over one authenticated content-lane channel. It records every
 * frame the endpoint actually handed to its own socket, which is the wire this
 * case asserts about, and changes nothing. It is used on both sides: the owner's
 * tap observes viewport and copy frames, and the viewer's tap observes the input
 * pages this viewer really sent.
 */
class RecordingChannel implements PeerByteChannel {
  readonly frames: SessionContentFrame[] = [];
  readonly messageBytes: number[] = [];
  readonly #inner: PeerByteChannel;

  constructor(inner: PeerByteChannel) {
    this.#inner = inner;
  }

  get peerKey(): PeerByteChannel["peerKey"] {
    return this.#inner.peerKey;
  }

  get lane(): PeerByteChannel["lane"] {
    return this.#inner.lane;
  }

  get label(): PeerByteChannel["label"] {
    return this.#inner.label;
  }

  get bufferedAmount(): number {
    return this.#inner.bufferedAmount;
  }

  get closed(): PeerByteChannel["closed"] {
    return this.#inner.closed;
  }

  send(bytes: Uint8Array): Promise<void> {
    const copy = Buffer.from(bytes);
    this.frames.push(decodeSessionContentFrame(copy));
    this.messageBytes.push(copy.length);
    return this.#inner.send(copy);
  }

  close(): Promise<void> {
    return this.#inner.close();
  }

  onMessage(handler: (bytes: Buffer) => void): () => void {
    return this.#inner.onMessage(handler);
  }
}

const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);

test("network viewer native input and copy stay bound to the pinned native child and only that viewer",
  { timeout: 120_000 }, async (t) => {
    if (process.platform === "win32") { t.skip("native Windows sidebar acceptance remains experimental"); return; }
    if (process.env.PI_REVIEW_GATE_RUNTIME_ROLE) { t.skip("native primary-host proof cannot run in a delegated role"); return; }
    const packageRoot = findInstalledAgentDirs().find((path) => {
      try { return JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version === "1.3.0"; } catch { return false; }
    });
    if (!packageRoot) { skipOrFail(t, "installed native Pi 1.3.0 is required"); return; }
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { bin: { pi: string } };
    const cli = realpathSync(join(packageRoot, manifest.bin.pi));
    assert.match(manifest.bin.pi, /dist\/bundle\/cli\.js$/, "exercise the actual package-declared bundled executable");
    const requireHere = createRequire(join(process.cwd(), "package.json"));
    const pty = requireHere("@lydell/node-pty") as { spawn(file: string, args: string[], options: Record<string, unknown>): InstancePty };

    // The pre-copy backend probe imports the EXACT public TUI alias this package
    // declares, resolved here before any owned child starts: the alias entry resolves
    // to its real package root, that package's name and pinned 1.3.0 version are
    // asserted positively, and the probe imports that same package's resolved public
    // entry, which exports the load-only `getNativeClipboard()`. No private subpath
    // is substituted. A resolution or version mismatch fails this case closed
    // instead of substituting a copied helper, a private producer, or a synthetic
    // "no backend" result.
    const tuiEntry = requireHere.resolve("pi-session-host-tui");
    const tuiPackageRoot = (() => {
      let cursor = dirname(tuiEntry);
      for (let depth = 0; depth < 8; depth += 1) {
        const manifestFile = join(cursor, "package.json");
        if (existsSync(manifestFile)) {
          const candidate = JSON.parse(readFileSync(manifestFile, "utf8")) as { name?: unknown };
          if (candidate.name === "@earendil-works/pi-tui") return cursor;
        }
        const parent = dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
      }
      return undefined;
    })();
    assert.ok(tuiPackageRoot,
      "the public pi-session-host-tui alias must resolve to one @earendil-works/pi-tui package");
    const tuiManifest = JSON.parse(readFileSync(join(tuiPackageRoot, "package.json"), "utf8")) as {
      name: string; version: string;
    };
    assert.equal(tuiManifest.name, "@earendil-works/pi-tui");
    assert.equal(tuiManifest.version, "1.3.0",
      "the public backend probe is pinned to the exact @earendil-works/pi-tui 1.3.0 this case exercises");
    const nativeTuiUrl = pathToFileURL(realpathSync(tuiEntry)).href;

    // The unchanged content/producer budgets this case must preserve. These are three
    // separate assertions because the resolved bounds object also carries identifier,
    // capability, and dimension ceilings that this case does not constrain here.
    assert.equal(DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes, 65_536,
      "the declared per-message bound is unchanged");
    assert.equal(DEFAULT_SESSION_CONTENT_BOUNDS.maxTransferBytes, 64 * 1024 * 1024,
      "the declared whole-transfer bound is unchanged");
    assert.equal(DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes, 32_768,
      "the declared raw chunk bound is unchanged");
    assert.equal(NATIVE_COPY_MAX_ENCODED_CHARS, 100_000, "the native copy producer bound is unchanged");
    assert.equal(NATIVE_TEXT_PASTE_MAX_BYTES, 1_048_576, "the native paste text-body cap is unchanged");
    assert.equal(NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES, NATIVE_TEXT_PASTE_MAX_BYTES + PASTE_WRAPPER_BYTES,
      "one viewer dispatch is the 1 MiB body plus exactly its two six-byte paste markers");
    assert.equal(Buffer.byteLength(ASSISTANT_TEXT, "utf8"), 75_000);
    assert.equal(ASSISTANT_ENCODED.length, NATIVE_COPY_MAX_ENCODED_CHARS);
    assert.equal(Buffer.byteLength(BIG_BODY, "utf8"), NATIVE_TEXT_PASTE_MAX_BYTES);

    const root = realpathSync(mkdtempSync("/tmp/prg-net-native-"));
    const candidate = compileAndStageCandidate(root); // inactive build; never live dist/
    const binDir = join(root, "bin");
    const attestRoot = join(root, "attest");
    const workDir = join(root, "work");
    for (const name of ["home", "tmp", "broker"]) mkdirSync(join(root, name), { mode: 0o700 });
    for (const dir of [binDir, attestRoot, workDir]) mkdirSync(dir, { mode: 0o700 });
    // The one launch nonce every owned attestation and witness in this case is scoped by.
    const nonce = "net-native";
    const agentDir = makeNativeAgentRoot(root, { deferredPiTools: false });
    const signal = new ChangeSignal();
    const helperLog = join(root, "helper.jsonl");
    const recorder = join(root, "clipboard-recorder.cjs");
    writeFileSync(recorder, `const fs=require('node:fs');const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>fs.appendFileSync(process.env.PRG_COPY_LOG,JSON.stringify(Buffer.concat(chunks).toString('utf8'))+'\\n'));`, { mode: 0o600, flag: "wx" });
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    // These are the ONLY clipboard commands reachable on the isolated PATH. The
    // native OS clipboard module is blocked in the child below, so no success path
    // can reach a physical clipboard, and nothing here reads one either.
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
    const decoy = Buffer.from("NETDECOY").toString("base64");
    // Witness for the decoy attempt, written by the fixture's own shortcut callback
    // inside this child. Without it, "no copy" could be satisfied by a keystroke that
    // never reached a handler at all; with it, the typed refusal asserted below can
    // only be a refusal of a write that was actually issued.
    const shortcutWitness = join(root, "shortcut-witness.json");
    const readShortcutWitness = (): ShortcutWitness | null => {
      if (!existsSync(shortcutWitness)) return null;
      try { return JSON.parse(readFileSync(shortcutWitness, "utf8")) as ShortcutWitness; }
      catch { return { stage: "unreadable" }; }
    };
    // The pre-copy public backend witness: this fixture's own `session_start`
    // handler writes one pid-scoped record of the load-only public probe, so the
    // fence can require that THIS child observed the absence of a native backend
    // before any copy gesture exists. The stem carries this launch's nonce.
    const backendProofStem = join(root, `${nonce}.native-backend-probe`);
    // The decoy is a native Pi extension SHORTCUT, not a command: Pi 1.3.0 calls a
    // registered shortcut handler synchronously from the editor's input handling, so
    // the raw OSC 52 write is issued inside the framed dispatch for this exact viewer
    // keystroke. The public `/input-proof` command digests the text the real child
    // actually received; `/proof-exit` ends the owned child.
    const fixture = join(root, "network-native-proof.cjs");
    writeFileSync(fixture, `const fs=require('node:fs');
const witness=${JSON.stringify(shortcutWitness)};
const backendProof=${JSON.stringify(backendProofStem)};
const backendModule=${JSON.stringify(nativeTuiUrl)};
const backendNonce=${JSON.stringify(nonce)};
module.exports=pi=>{
// The public no-write isolation probe. It imports the exact resolved public pinned
// TUI module and calls ONLY the documented load-only getNativeClipboard(), which
// loads the addon without opening a display. It never calls getText/getImage/
// getFilePaths/setText, so it performs no physical clipboard read or write; the
// blocked native addon is what isolates the child. A backend object, a missing
// export, or a throw is recorded, never retried, and fails the test closed.
pi.on('session_start',async()=>{
const record={version:1,nonce:backendNonce,pid:process.pid,moduleUrl:backendModule,probe:'getNativeClipboard',exportType:'missing',backendUnavailable:false};
try{
const loaded=await import(backendModule);
const probe=loaded.getNativeClipboard;
record.exportType=typeof probe;
if(typeof probe!=='function')throw new Error('the pinned public module exports no getNativeClipboard');
record.backendUnavailable=probe()==null;
}catch(error){record.failure=String(error&&error.message||error);}
try{const target=backendProof+'.'+process.pid+'.json';const staging=target+'.staging';fs.writeFileSync(staging,JSON.stringify(record),{mode:0o600});fs.renameSync(staging,target);}catch{/* a missing witness fails the test closed before any copy */}
});
pi.registerShortcut('f7',{description:'Raw OSC 52 decoy issued from the input-shortcut callback',handler:()=>{
fs.writeFileSync(witness,JSON.stringify({pid:process.pid,stage:'entered'}));
let failure;
try{process.stdout.write('\\x1b]52;c;${decoy}\\x07');}catch(error){failure=String(error&&error.message||error);}
fs.writeFileSync(witness,JSON.stringify(failure===undefined?{pid:process.pid,stage:'wrote'}:{pid:process.pid,stage:'threw',failure}));
}});
pi.registerCommand('input-proof',{description:'Digest the owned input bytes',handler:async(input)=>pi.sendMessage({customType:'input-proof',content:'INPUTNET:'+require('node:crypto').createHash('sha256').update(input,'utf8').digest('hex'),display:true})});
pi.registerCommand('proof-exit',{description:'Exit owned fixture',handler:async(_,ctx)=>ctx.shutdown()});
};`, { mode: 0o600, flag: "wx" });

    // One owned saved conversation in the current public session-file shape: the
    // assistant text already exists, so no model, provider, credential, or network
    // request happens in any leg. The header cwd is the exact owned workspace the
    // host later admits, and the host resumes with `--session <file>`.
    const workspace = realpathSync(workDir);
    const project = join(agentDir, "sessions", `--${workspace.replace(/[^a-zA-Z0-9]/g, "-")}--`);
    mkdirSync(project, { recursive: true, mode: 0o700 });
    const stamp = new Date(Date.UTC(2026, 0, 4, 5, 6, 7)).toISOString();
    const stampName = stamp.replaceAll(":", "-").replace(".", "-");
    const sessionFile = join(project, `${stampName}_${SAVED_SESSION_ID}.jsonl`);
    const entries: unknown[] = [
      { type: "session", version: 3, id: SAVED_SESSION_ID, cwd: workspace, timestamp: stamp },
      { type: "session_info", id: `${SAVED_SESSION_ID}-name`, parentId: null, name: "Owned network native proof", timestamp: stamp },
      { type: "message", id: `${SAVED_SESSION_ID}-user`, parentId: `${SAVED_SESSION_ID}-name`, timestamp: stamp,
        message: { role: "user", content: [{ type: "text", text: "synthetic saved prompt" }], timestamp: Date.parse(stamp) } },
      // A well-formed Pi 1.3.0 assistant message: the native copy path reads its last
      // text block and nothing here contacts a model, provider, or network.
      { type: "message", id: `${SAVED_SESSION_ID}-assistant`, parentId: `${SAVED_SESSION_ID}-user`, timestamp: stamp,
        message: {
          role: "assistant", api: "synthetic-api", provider: "synthetic-provider", model: "synthetic-model",
          stopReason: "stop", responseId: `${SAVED_SESSION_ID}-response`, thinkingLevel: "off",
          content: [{ type: "text", text: ASSISTANT_TEXT }], timestamp: Date.parse(stamp),
          usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } },
    ];
    writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600, flag: "wx" });

    const common: NodeJS.ProcessEnv = {
      PATH: [binDir, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      NODE_PATH: [join(process.cwd(), "node_modules"), dirname(dirname(packageRoot)), join(packageRoot, "node_modules")].join(delimiter),
      HOME: join(root, "home"), TMPDIR: join(root, "tmp"), PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1", PI_TELEMETRY: "0", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
      TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", DISPLAY: ":synthetic-recording-only",
      NODE_OPTIONS: `--require=${preload}`, PRG_COPY_LOG: helperLog, PRG_OWNED_BIN: binDir,
      PRG_CLIP_ATTEST: join(attestRoot, nonce), PRG_CLIP_ATTEST_NONCE: nonce,
    };
    // Pi's own default copy-on-select is pinned off so no mouse gesture can copy
    // anything implicitly; the only copy gestures are keystrokes and the command.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ fullscreenCopyOnSelect: false }), { mode: 0o600 });
    const args = ["--offline", "--no-context-files", "--no-skills", "--no-themes", "--no-extensions",
      "--extension", fixture, "--tui-mode", "fullscreen"];

    const owned: Array<{ handle: InstancePty; exited: boolean; raw: string; exitCode?: number; pid: number }> = [];
    const spawn = (file: string, argv: string[], env: NodeJS.ProcessEnv, cwd: string): (typeof owned)[number] => {
      const handle = pty.spawn(file, argv, {
        name: "xterm-ghostty", cols: DEFAULT_INSTANCE_COLS, rows: DEFAULT_INSTANCE_ROWS, cwd, env, encoding: "utf8",
      });
      const item: (typeof owned)[number] = { handle, exited: false, raw: "", pid: handle.pid };
      owned.push(item); // ownership before any callback or await
      handle.onExit((event) => { item.exited = true; item.exitCode = event.exitCode; signal.notify(); });
      handle.onData((data) => { item.raw += data; signal.notify(); });
      return item;
    };
    const text = (surface: TerminalSurface): string => surface.frame().lines.map(stripGeneratedSgr).join("\n");
    const frameText = (frame: SessionContentSnapshot["frame"]): string => frame.lines.map(stripGeneratedSgr).join("\n");
    const helperRecords = (): string[] => existsSync(helperLog)
      ? readFileSync(helperLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string) : [];
    const attestationRecords = (): Array<Attestation & { file: string }> => readdirSync(attestRoot)
      .filter((name) => name.startsWith(`${nonce}.`))
      .slice(0, 32)
      .map((name) => {
        try {
          return { ...JSON.parse(readFileSync(join(attestRoot, name), "utf8")) as Attestation, file: name };
        } catch {
          return { file: name, version: 0, nonce: "", pid: -1, armed: false, dlopenHook: false,
            resolved: {}, blocked: [], reason: ["unreadable-record"] };
        }
      });

    /** The exact facts one independently written test-side snapshot commit holds. */
    interface Commit {
      readonly source: NativeIoSource;
      readonly textDigest: string;
      readonly lines: number;
    }
    // The viewer's dynamic authorization seam, kept independent of the endpoint's
    // own snapshot: this test writes the viewport it observed into its own commit and
    // only then allows input. It is a simulated written-snapshot proof and NOT a
    // physical Main, terminal, or UI certificate.
    let commit: Commit | null = null;

    const surfaces: TerminalSurface[] = [];
    const managers: InstanceManager[] = [];
    const children: Array<{ item: (typeof owned)[number]; bootstrap: SessionHostBootstrap; writes: string[] }> = [];
    let leg = "fixture setup";
    let failureCaptured = false;
    let originalFailure: unknown;
    let statusBroker: Awaited<ReturnType<typeof createStatusBroker>> | undefined;
    let hostFixture: HostFixture | undefined;
    let host: SessionContentHost | undefined;
    let viewer: SessionContentViewer | undefined;
    let attachment: { wire: RecordingChannel; binding: SessionContentChannelBinding } | undefined;
    let shortcutWatcher: FSWatcher | undefined;
    let row: string | undefined;
    const copies: NativeIoCompletedCopy[] = [];
    const ownerDelivered: NativeClipboardEvent[] = [];
    const ownerDiagnostics: SessionContentHostDiagnosticCode[] = [];
    const viewerDiagnostics: string[] = [];

    try {
      // ONE owned watcher for the whole case, armed before the owned child starts so
      // neither of this child's own in-process witness writes can be missed: the
      // pre-copy public backend-probe record and, later, the F7 shortcut witness. The
      // F7 leg reuses this watcher instead of opening a second one.
      shortcutWatcher = watch(root, () => signal.notify());
      leg = "owned broker, manager, and real TLS host";
      statusBroker = await createStatusBroker({ socketRoot: join(root, "broker") });
      // One manager over the pinned CLI with the closed, explicitly opted-in framing
      // mode. The product default stays false; only this owned launch opts in, so each
      // copy receipt carries an explicit input origin and logical dispatch id.
      let managerChange: InstanceManagerOptions["onChange"];
      const liveManager = new InstanceManager({
        packageRoot: candidate.root, piExecutable: cli, statusRegistrar: statusBroker,
        profileRegistry: new NativeAgentRegistry({ env: common }), nativeSetup: true, nativeInputOriginFraming: true,
        env: common, args, cols: DEFAULT_INSTANCE_COLS, rows: DEFAULT_INSTANCE_ROWS,
        onChange: (instanceId) => { managerChange?.(instanceId); signal.notify(); },
        onNativeClipboard: (_id, event) => { ownerDelivered.push(event); signal.notify(); },
        ptyFactory: (descriptor) => {
          const frame = descriptor.env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP;
          if (frame === undefined) throw new Error("the opted-in launch must carry its one-shot bootstrap");
          const bootstrap = JSON.parse(frame) as SessionHostBootstrap;
          const item = spawn(descriptor.file, descriptor.args, descriptor.env, descriptor.cwd);
          const writes: string[] = [];
          children.push({ item, bootstrap, writes });
          const handle = item.handle;
          // A recording view of the SAME owned handle: the host's writes are the wire
          // under test and nothing else about the child changes.
          return {
            get pid(): number { return handle.pid; },
            get cols(): number { return handle.cols; },
            get rows(): number { return handle.rows; },
            onData: (listener) => handle.onData(listener),
            onExit: (listener) => handle.onExit(listener),
            on: (event, listener) => handle.on?.(event, listener),
            removeListener: (event, listener) => handle.removeListener?.(event, listener),
            write: (data) => {
              writes.push(typeof data === "string" ? data : data.toString("latin1"));
              signal.notify(); // test-side observation of the host's own write
              handle.write(data);
            },
            resize: (columns, rows) => handle.resize(columns, rows),
            kill: (sig) => handle.kill(sig),
            pause: () => handle.pause(),
            resume: () => handle.resume(),
          };
        },
      });
      managers.push(liveManager); // ownership before the first await
      const service = createLocalOwningHostService({
        createManager: (managerOptions) => {
          managerChange = managerOptions.onChange;
          return liveManager as unknown as OwningHostManager;
        },
        teardownRequested: () => false,
      });
      service.openManager({
        packageRoot: candidate.root, piExecutable: cli, statusRegistrar: statusBroker,
      } as InstanceManagerOptions);
      const inventory = service.readInventorySnapshot();
      assert.ok(inventory, "the real owning-host service must observe its own manager run");
      const hostRunId = inventory.hostRunId;

      // The ONLY authorization policy the content endpoint is given is the exact
      // directional grant the TLS pairing commit records.
      const grants = createInMemoryDirectionalGrantStore();
      const attached = deferred<{ wire: RecordingChannel; binding: SessionContentChannelBinding }>();
      const contentHost = createSessionContentHost({
        source: service,
        authorizePeer: (peerKey) => grants.get(peerKey.keyId) !== undefined,
        nativeIo: true,
        onDiagnostic: (event) => { ownerDiagnostics.push(event.code); },
      });
      host = contentHost;
      const identity = await newIdentity("owner-host");
      hostFixture = await startHost(t, {
        identity,
        grants,
        onPairingRequest: (request) => { request.approve(); },
        onAppChannel: () => { throw new Error("this case never opens the legacy metadata lane"); },
        onContentChannel: (channel) => {
          const wire = new RecordingChannel(channel);
          const binding = contentHost.attach(wire);
          attachment = { wire, binding };
          attached.resolve({ wire, binding });
        },
      });

      leg = "public saved-session catalog and admission";
      const catalog = await listSavedSessions({ agentDir, piExecutable: cli, expectedPiVersion: "1.3.0" });
      assert.equal(catalog.issueCount, 0, "the owned saved conversation catalog is clean");
      const catalogRow = catalog.rows.find((entry) => entry.file === sessionFile);
      assert.ok(catalogRow, "the owned saved conversation is listed through the public SDK");
      const admitted = admitSavedSession(catalog, catalogRow);
      if (admitted.status !== "admitted") throw new Error(`the owned saved conversation was refused: ${admitted.reason}`);
      const admission: SavedSessionAdmission = admitted.admission;
      assert.equal(admission.sessionId, SAVED_SESSION_ID, "the receipt carries the conversation's own id");
      assert.equal(admission.workspace, workspace, "the admitted workspace is the conversation's own recorded cwd");

      leg = "resume the admitted conversation in the owned native child";
      const rowId = await liveManager.create({ workspace: admission.workspace, savedSession: admission });
      row = rowId;
      const pane = liveManager.surface(rowId);
      assert.ok(pane, "the admitted row has a real terminal surface");
      surfaces.push(pane);
      assert.equal(children.length, 1, "exactly one owned native child exists for this row");
      const child = children[0]!;
      assert.equal(child.bootstrap.inputOriginFraming, 1, "the closed mode reached the actual one-shot bootstrap");
      const attestationFile = (): string => join(attestRoot, `${nonce}.${child.item.pid}.json`);
      // The child's own witnessed result of the load-only public backend probe. This is
      // this test's owned pid- and nonce-scoped record, not a substitute for the
      // preload's separate interception record.
      const backendProofFile = join(root, `${nonce}.native-backend-probe.${child.item.pid}.json`);
      const readBackendProof = (): BackendProof | null => {
        if (!existsSync(backendProofFile)) return null;
        try { return JSON.parse(readFileSync(backendProofFile, "utf8")) as BackendProof; }
        catch { return null; }
      };

      const startupQueries = ["\x1b[?u", "\x1b[>0q", "\x1b[6n", "\x1b]10;?"];
      // Readiness is emitted before the CLI starts; a separate PTY chunk may carry
      // its first query. Observe both within the same original readiness deadline
      // before comparing their positions, rather than treating READY as query proof.
      await signal.waitFor(() => child.item.raw.includes("\x1b]777;prg-native-input-ready-v1;")
        && startupQueries.some((probe) => child.item.raw.includes(probe)), 20_000,
        "the strict decoder authenticated and the native child emitted its startup query");
      const readyAt = child.item.raw.indexOf("\x1b]777;prg-native-input-ready-v1;");
      const firstQuery = Math.min(...startupQueries.map((probe) => {
        const at = child.item.raw.indexOf(probe);
        return at < 0 ? Number.POSITIVE_INFINITY : at;
      }));
      assert.ok(Number.isFinite(firstQuery), "the actual native child emitted a startup query");
      assert.ok(readyAt < firstQuery, "readiness precedes this child's own startup queries, so a reply can never be typed unframed");
      assert.equal(child.item.raw.split("\x1b]777;prg-native-input-ready-v1;").length - 1, 1,
        "exactly one readiness statement, so no second bridge exists");

      await signal.waitFor(() => {
        const view = liveManager.list().find((candidateRow) => candidateRow.id === rowId);
        const native = view?.nativeSession;
        // The resumed conversation itself is proven by the live native tuple below and by
        // the byte-exact copy payload; a rendered tail marker is deliberately not a
        // readiness dependency, because it is not the evidence this case rests on.
        return text(pane).includes("─".repeat(20)) && native?.sessionId === admission.sessionId
          && native.epoch >= 1;
      }, 20_000, "the opted-in native editor resumed the admitted conversation");
      const resumed = liveManager.list().find((view) => view.id === rowId)!.nativeSession!;
      assert.equal(resumed.sessionId, admission.sessionId,
        "the live native conversation is the deliberately resumed one, not a process-boot session");
      assert.ok(resumed.epoch >= 1, "the resumed conversation carries a real native epoch");
      // Every host byte this row typed travelled as an authenticated framed dispatch.
      await signal.waitFor(() => child.writes.length > 0, 20_000, "the host wrote the child's own protocol replies");
      assert.ok(child.writes.every((frame) => frame.startsWith("prg-ni-v1;")), "no host byte ever reached this child unframed");

      leg = "real TLS pairing and content subscription";
      const viewerIdentity = await newIdentity("viewer-native");
      const clientFixture = startClient(t, viewerIdentity);
      const paired = await clientFixture.client.pair({
        port: hostFixture.port,
        approveServerKey: () => "accept",
      });
      assert.equal(paired.ok, true, "the viewer's TLS pairing is accepted");
      const channel = await clientFixture.client.connectApp({
        port: hostFixture.port,
        lane: "content",
        approveServerKey: () => { throw new Error("the server key is already remembered"); },
      });
      const attachedContent = await withTimeout(attached.promise, 5_000,
        "the owner never attached a content binding for the admitted channel");
      assert.equal(channel.lane, "content");
      assert.equal(attachedContent.wire.peerKey.keyId, viewerIdentity.key.keyId,
        "the owner's only identity for this channel is the TLS-verified viewer key");
      assert.equal(channel.peerKey.keyId, hostFixture.identity.key.keyId,
        "the viewer's server identity is the exact key its TLS handshake verified");
      attachment = attachedContent;
      const wire = attachedContent.wire;
      // The viewer side of the same channel: this is where the pages this viewer
      // actually sent are observed, unchanged and independent of the owner.
      const viewerWire = new RecordingChannel(channel);

      // Every published viewport is written into this test's own commit before any
      // input is admitted; the endpoint's snapshot is never used as its own authority.
      const sourceOf = (snapshot: SessionContentSnapshot): NativeIoSource | undefined =>
        snapshot.meta.inputSource === undefined || snapshot.meta.inputSource === null
          ? undefined : snapshot.meta.inputSource;
      const liveViewer = attachSessionContentViewer({
        channel: viewerWire,
        hostRunId,
        sessionId: rowId,
        cols: DEFAULT_INSTANCE_COLS,
        rows: DEFAULT_INSTANCE_ROWS,
        onSnapshot: (snapshot) => {
          if (snapshot === undefined) { commit = null; signal.notify(); return; }
          const source = sourceOf(snapshot);
          commit = source === undefined ? null : {
            source,
            textDigest: digest(frameText(snapshot.frame)),
            lines: snapshot.frame.lines.length,
          };
          signal.notify();
        },
        onDiagnostic: (event) => { viewerDiagnostics.push(event.code); signal.notify(); },
        nativeIo: {
          authorizeInput: (expected) => commit !== null && nativeIoSourceEquals(expected, commit.source),
          onCopy: (copy) => { copies.push(copy); signal.notify(); },
        },
      });
      viewer = liveViewer;
      await withTimeout(liveViewer.ready, 5_000, "the viewer never received its exact subscribed acknowledgement");

      leg = "known native tuple, run, row, geometry, and viewer commitment before any gesture";
      await signal.waitFor(() => {
        if (commit === null) return false;
        const current = commit.source;
        return current.hostRunId === hostRunId
          && current.sessionId === rowId
          && current.nativeSession.sessionId === admission.sessionId
          && current.nativeSession.epoch === resumed.epoch;
      }, 20_000, "the owner stated a source for this exact run, row, and resumed native tuple");
      // The commit is written by a publish callback. Read it through a typed accessor so
      // the outer flow never narrows the callback-only assignment to its `null`
      // initializer; the returned value is what gets narrowed and asserted here.
      const readCommit = (): Commit | null => commit;
      const committed = readCommit();
      assert.ok(committed, "no written snapshot commit exists before the first gesture");
      const source: NativeIoSource = committed.source;
      assert.equal(committed.textDigest.length === 16 && committed.lines > 0, true,
        "this test's own written commit holds the viewport it observed, not an empty record");
      assert.match(source.sourceToken, /^nvs1\.[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.[0-9a-f]{32}$/,
        "the owner's source carries a bounded viewer scope commitment, not a peer-chosen value");
      assert.equal(Number.isSafeInteger(source.viewerRevision) && source.viewerRevision > 0, true,
        "the source states this viewer's positive revision");
      assert.deepEqual(source.geometry, service.readSessionGeometry(rowId),
        "the source states the manager's own canonical geometry");
      assert.deepEqual(source.nativeSession, { sessionId: resumed.sessionId, epoch: resumed.epoch });
      const snapshotBefore = liveViewer.readSnapshot();
      assert.ok(snapshotBefore, "the viewer holds a current viewport");
      assert.deepEqual(snapshotBefore.meta.nativeSession, { sessionId: resumed.sessionId, epoch: resumed.epoch });
      assert.equal(snapshotBefore.meta.hostRunId, hostRunId);
      assert.equal(snapshotBefore.meta.sessionId, rowId);
      const beforeSource = sourceOf(snapshotBefore);
      assert.ok(beforeSource);
      assert.equal(nativeIoSourceEquals(beforeSource, source), true,
        "the committed source is the exact source of the written snapshot");
      assert.equal(wire.frames.some((frame) => frame.type === "content_begin"), true,
        "the owner published a complete viewport over the real socket");
      assert.ok(wire.messageBytes.every((bytes) => bytes <= DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes),
        "no owner message exceeded the declared per-frame bound");
      assert.equal(ownerDiagnostics.includes("hello_accepted"), true);
      assert.equal(ownerDiagnostics.includes("subscribed"), true);
      // Exactly ONE viewing surface exists for the row, and it is this endpoint's own:
      // every later copy can only be routed to the viewer that is recorded here.
      const rowViewers = service.readSessionViewers(rowId);
      assert.equal(rowViewers.length, 1, "the row has exactly one viewing surface, the network viewer's");
      assert.equal(attachedContent.binding.viewerId, rowViewers[0]!.viewerId,
        "the content binding owns that one registered viewer and no other");
      assert.equal(attachedContent.binding.subscribed, true);

      // Pre-copy safety fence. Two independent per-child facts are required: the owned
      // preload's positive attestation that the OS clipboard backend is intercepted in
      // THIS pid and that every clipboard command resolves to the owned recorder on
      // THIS child's PATH, and this child's own observation of the block - its public
      // load-only probe reported no native backend while the preload's persisted record
      // names the exact platform module the hook refused. Nothing may be copied without
      // all of it, and no part has a fallback or a synthetic success.
      await signal.waitFor(() => readBackendProof() !== null, 20_000,
        "the owned child's public session_start handler reported its no-write backend probe");
      const backendProof = readBackendProof()!;
      assert.equal(backendProof.version, 1, "the backend proof is this fixture's own record shape");
      assert.equal(backendProof.pid, child.item.pid, "the backend proof belongs to this exact child pid");
      assert.equal(backendProof.nonce, nonce, "the backend proof belongs to this launch");
      assert.equal(backendProof.moduleUrl, nativeTuiUrl,
        "the proof imported the exact resolved public 1.3.0 TUI module this case pinned before startup");
      assert.equal(backendProof.probe, "getNativeClipboard", "the proof called only the documented load-only probe");
      assert.equal(backendProof.exportType, "function", "the pinned public module exported the load-only probe");
      assert.equal(backendProof.backendUnavailable, true,
        `the public load-only probe must report no native backend in this child: ${backendProof.failure ?? "a backend object was returned"}`);
      assert.ok(existsSync(attestationFile()),
        `the owned preload must attest interception in this child's own record ${attestationFile()}`);
      const attestation = JSON.parse(readFileSync(attestationFile(), "utf8")) as Attestation;
      assert.equal(attestation.nonce, nonce, "the attestation belongs to this launch");
      assert.equal(attestation.pid, child.item.pid, "the attestation belongs to this exact child pid");
      assert.equal(attestation.dlopenHook, true, "the OS clipboard native module must be blocked in this child");
      assert.equal(attestation.armed, true, `clipboard interception is not armed: ${attestation.reason.join(",")}`);
      for (const command of CLIPBOARD_COMMANDS) {
        assert.equal(attestation.resolved[command], join(binDir, command),
          `${command} must resolve to the owned recorder first on this child's PATH, never a system clipboard`);
      }
      // DISPLAY is set for this launch, so the pinned TUI's own platform selection asks
      // for the X11 variant explicitly. The record is read AFTER the probe, because the
      // preload persists the refusal as it happens; an unobserved block is a failure.
      const expectedNativeModule = process.platform === "darwin" ? "darwin-platform.node"
        : process.platform === "linux" ? "linux-platform-x11.node" : undefined;
      assert.ok(expectedNativeModule, "this case pins the exact platform native clipboard basename");
      assert.equal(attestation.blocked.includes(expectedNativeModule), true,
        `the observed block must name the exact platform native backend ${expectedNativeModule}: ${attestation.blocked.join(",")}`);

      /* ------------------------------------------------------------------ *
       * Independent observation of the child's own PTY dispatch stream.
       * ------------------------------------------------------------------ */
      let decodedThrough = 0;
      const fragments: NativeInputFragment[] = [];
      interface DispatchEntry {
        readonly origin: NativeInputOrigin;
        readonly chunks: Buffer[];
        bytes: number;
        ended: boolean;
      }
      const dispatches = new Map<number, DispatchEntry>();
      const decoder = createNativeInputDecoder(child.bootstrap);
      /** Decode every not-yet-decoded host write into this registration's fragments. */
      const drain = (): void => {
        while (decodedThrough < child.writes.length) {
          const fed = decoder.feed(child.writes[decodedThrough]!);
          assert.equal(fed.ok, true, `every host write authenticates against this registration: ${fed.ok ? "" : fed.code}`);
          decodedThrough += 1;
          for (const fragment of fed.fragments) {
            fragments.push(fragment);
            const entry: DispatchEntry = dispatches.get(fragment.dispatchId) ?? {
              origin: fragment.origin, chunks: [], bytes: 0, ended: false,
            };
            entry.chunks.push(fragment.payload);
            entry.bytes += fragment.payload.length;
            entry.ended = fragment.end;
            dispatches.set(fragment.dispatchId, entry);
          }
        }
      };
      /** Completed viewer dispatches whose assembled payload is exactly `wanted`. */
      const viewerDispatchesOf = (wanted: Buffer): number[] => {
        drain();
        const ids: number[] = [];
        for (const [dispatchId, entry] of dispatches) {
          if (entry.origin.kind !== "viewer" || !entry.ended || entry.bytes !== wanted.length) continue;
          if (Buffer.concat(entry.chunks).equals(wanted)) ids.push(dispatchId);
        }
        return ids;
      };
      /**
       * Wait for the host's own authenticated write of this exact viewer payload.
       * `unique` is asserted only where one logical input really is the only one with
       * these bytes (the submit key is legitimately used twice). `excludeDispatchId`
       * drops an already-observed dispatch from both the readiness predicate and the
       * returned matches, because `submitted` acknowledges local transport writes only -
       * never a later owner write - so a repeated payload must not re-match the earlier
       * one.
       */
      const waitForViewerDispatch = async (payload: string, unique: boolean, label: string, excludeDispatchId?: number): Promise<number> => {
        const wanted = Buffer.from(payload, "utf8");
        const matchingIds = (): number[] => viewerDispatchesOf(wanted)
          .filter((id) => id !== excludeDispatchId);
        await signal.waitFor(() => matchingIds().length > 0, 20_000, label);
        const ids = matchingIds();
        if (unique) assert.equal(ids.length, 1, "one logical input is exactly one dispatch, never a replay");
        return ids.at(-1)!;
      };
      /** Independently re-authenticated v2 capsules from this child's own output. */
      const capsuleReceipts = (): NativeClipboardOriginEvent[] => {
        const seen: NativeClipboardOriginEvent[] = [];
        const receive = createNativeClipboardReceiver(child.bootstrap, () => undefined, (receipt) => { seen.push(receipt); });
        for (const match of child.item.raw.matchAll(/\x1b\]777;([^\x07]*)\x07/g)) receive(match[1]!);
        return seen;
      };
      const currentModes = (): SessionContentSnapshot["meta"]["inputModes"] => {
        const snapshot = liveViewer.readSnapshot();
        assert.ok(snapshot, "the viewer still holds its current viewport");
        return snapshot.meta.inputModes;
      };
      /** The committed source and modes, proven current against the live owner facts. */
      const gestureSource = (): { source: NativeIoSource; modes: SessionContentSnapshot["meta"]["inputModes"] } => {
        const committed = readCommit();
        assert.ok(committed, "a written snapshot commit exists for the current viewport");
        const live = liveViewer.readNativeInputSource();
        assert.ok(live, "the endpoint still states its own current source");
        assert.equal(nativeIoSourceEquals(live, committed.source), true,
          "the committed source and the endpoint's current source agree before the gesture");
        assert.equal(live.hostRunId, hostRunId);
        assert.deepEqual(live.nativeSession, { sessionId: resumed.sessionId, epoch: resumed.epoch });
        assert.deepEqual(live.geometry, service.readSessionGeometry(rowId));
        return { source: committed.source, modes: currentModes() };
      };

      /* ------------------------------------------------------------------ *
       * Copy 1: the documented Ctrl+X key, arriving from the network viewer.
       * ------------------------------------------------------------------ */
      leg = "network viewer Ctrl+X native copy";
      assert.equal(child.item.raw.includes("\x1b]52;c;"), false, "nothing is copied before the first copy gesture");
      assert.equal(helperRecords().length, 0);
      const beforeCtrlX = gestureSource();
      const ctrlX = await liveViewer.sendInput({
        source: beforeCtrlX.source, inputModes: beforeCtrlX.modes, kind: "keyboard", text: CTRL_X,
      });
      assert.equal(ctrlX.status, "submitted", "the viewer's Ctrl+X dispatch reached the transport");
      const ctrlXDispatch = await waitForViewerDispatch(CTRL_X, true, "the host wrote the viewer's Ctrl+X dispatch");
      const ctrlXStart = fragments.find((fragment) => fragment.dispatchId === ctrlXDispatch && fragment.start);
      assert.deepEqual(ctrlXStart?.expectedNativeTuple, { sessionId: admission.sessionId, epoch: resumed.epoch },
        "the dispatch carries the child-side conversation fence for this exact resumed tuple");
      assert.equal(dispatches.get(ctrlXDispatch)!.origin.kind, "viewer",
        "the copy key travelled as explicit viewer input, never as local input");
      await signal.waitFor(() => copies.some((copy) => copy.event.kind === "copy"), 20_000,
        "the resumed conversation's last-assistant copy routes back to the initiating viewer");
      const firstCopy = copies.find((copy) => copy.event.kind === "copy")!;
      assert.equal(helperRecords().length, 1, "the unchanged native helper ran exactly once");
      assert.equal(helperRecords()[0], ASSISTANT_TEXT, "the bytes handed to the recording helper are the seeded assistant text exactly");
      assert.equal(nativeIoSourceEquals(firstCopy.source, source), true,
        "the copy is bound to the exact source this viewer committed before the gesture");
      assert.equal(firstCopy.dispatchId, ctrlXDispatch, "the copy is caused by the recorded Ctrl+X viewer dispatch");
      if (firstCopy.event.kind !== "copy") throw new Error("the documented copy key must yield a copy event");
      assert.equal(firstCopy.event.encoded, ASSISTANT_ENCODED, "the authenticated payload is the full 100000-character native bound");
      assert.equal(Buffer.from(firstCopy.event.encoded, "base64").toString("utf8"), ASSISTANT_TEXT,
        "the payload is the resumed conversation's assistant text byte-exactly");
      assert.equal(Buffer.from(firstCopy.event.encoded, "base64").length, 75_000);
      assert.equal(firstCopy.event.sessionId, admission.sessionId, "the copy names the resumed conversation id");
      assert.equal(firstCopy.event.sessionEpoch, resumed.epoch, "the copy names the resumed conversation epoch");
      assert.equal(ownerDelivered.filter((event) => event.kind === "copy").length, 0,
        "a viewer-origin copy never reaches the owner-local clipboard route");

      const firstReceipts = capsuleReceipts();
      assert.equal(firstReceipts.length, 1, "one independently authenticated capsule, and readiness consumed no copy sequence");
      assert.equal(firstReceipts[0]!.origin.kind, "viewer", "the capsule states a viewer origin, not a local one");
      assert.equal(firstReceipts[0]!.origin.kind === "viewer" ? firstReceipts[0]!.origin.token : undefined,
        source.sourceToken, "the capsule names exactly this viewer's committed source token");
      assert.equal(firstReceipts[0]!.dispatchId, ctrlXDispatch, "the capsule names the initiating input dispatch");
      assert.equal(firstReceipts[0]!.event.kind, "copy");
      assert.equal(firstReceipts[0]!.event.kind === "copy" ? firstReceipts[0]!.event.encoded : undefined, ASSISTANT_ENCODED);

      /* ------------------------------------------------------------------ *
       * Copy 2: the documented /copy command over the same lane.
       * ------------------------------------------------------------------ */
      leg = "network viewer documented /copy command";
      const beforeCopy = gestureSource();
      const copyCommand = await liveViewer.sendInput({
        source: beforeCopy.source, inputModes: beforeCopy.modes, kind: "keyboard", text: COPY_COMMAND,
      });
      assert.equal(copyCommand.status, "submitted");
      const copyDispatch = await waitForViewerDispatch(COPY_COMMAND, true, "the host wrote the viewer's /copy dispatch");
      assert.notEqual(copyDispatch, ctrlXDispatch, "the command is its own dispatch, not the earlier keystroke");
      await signal.waitFor(() => copies.filter((copy) => copy.event.kind === "copy").length === 2, 20_000,
        "the documented command routes exactly one more copy to the initiating viewer");
      const secondCopy = copies.filter((copy) => copy.event.kind === "copy")[1]!;
      assert.equal(secondCopy.dispatchId, copyDispatch, "/copy is caused by its own dispatch");
      assert.equal(nativeIoSourceEquals(secondCopy.source, source), true);
      assert.equal(helperRecords().length, 2, "the second documented trigger uses the helper once");
      assert.equal(helperRecords()[1], ASSISTANT_TEXT);
      assert.equal(capsuleReceipts().length, 2);

      /* ------------------------------------------------------------------ *
       * Copy wire shape: the full encoded bound crosses whole, as pages.
       * ------------------------------------------------------------------ */
      const copyUnits = (): Array<{
        begin: SessionContentCopyBeginFrame;
        chunks: SessionContentCopyChunkFrame[];
        end: SessionContentCopyEndFrame;
      }> => {
        const order: string[] = [];
        const byId = new Map<string, {
          begin?: SessionContentCopyBeginFrame;
          chunks: SessionContentCopyChunkFrame[];
          end?: SessionContentCopyEndFrame;
        }>();
        for (const frame of wire.frames) {
          if (frame.type !== "copy_begin" && frame.type !== "copy_chunk" && frame.type !== "copy_end") continue;
          let entry = byId.get(frame.copyId);
          if (entry === undefined) {
            order.push(frame.copyId);
            entry = { chunks: [] };
            byId.set(frame.copyId, entry);
          }
          if (frame.type === "copy_begin") entry.begin = frame;
          else if (frame.type === "copy_chunk") entry.chunks.push(frame);
          else entry.end = frame;
        }
        return order.map((id) => {
          const entry = byId.get(id)!;
          assert.ok(entry.begin, "a copy unit began");
          assert.ok(entry.end, "a copy unit ended");
          return { begin: entry.begin!, chunks: entry.chunks, end: entry.end! };
        });
      };
      const joinedCopyText = (unit: { chunks: SessionContentCopyChunkFrame[] }): string =>
        Buffer.concat(unit.chunks.map((chunk) => Buffer.from(chunk.data, "base64"))).toString("ascii");
      leg = "copy wire pages preserve the whole canonical base64 payload";
      const units = copyUnits();
      assert.equal(units.length, 2, "one whole copy emission per native copy, and nothing else claimed a copy id");
      for (const unit of units) {
        assert.equal(unit.begin.source.sessionId, rowId);
        assert.equal(unit.begin.source.nativeSession.sessionId, admission.sessionId);
        assert.equal(unit.begin.source.nativeSession.epoch, resumed.epoch);
        assert.equal(nativeIoSourceEquals(unit.begin.source, source), true,
          "the wire header names the exact source this viewer committed");
        assert.equal(unit.begin.byteLength, ASSISTANT_ENCODED.length,
          "the declared byte length is the producer's canonical base64 string as ASCII bytes");
        assert.ok(unit.begin.byteLength > DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes,
          "the copy cannot have been shrunk into one message");
        assert.equal(unit.begin.chunkCount, unit.chunks.length, "every declared page arrived exactly once");
        assert.equal(unit.begin.chunkCount, 4,
          "100,000 ASCII base64 bytes cross as four raw wire chunks");
        assert.deepEqual(unit.chunks.map((chunk) => Buffer.from(chunk.data, "base64").length),
          [32_768, 32_768, 32_768, 1_696],
          "raw wire chunks preserve the unchanged bound and exact remainder");
        assert.deepEqual(unit.chunks.map((chunk) => chunk.index), unit.chunks.map((_chunk, index) => index),
          "copy pages arrive in declared order");
        assert.equal(unit.chunks.every((chunk) => chunk.data.length > 0), true,
          "no declared page is an empty placeholder");
        assert.equal(joinedCopyText(unit), ASSISTANT_ENCODED,
          "the joined ASCII pages are the producer's exact original canonical base64");
        assert.equal(Buffer.from(joinedCopyText(unit), "base64").length, 75_000,
          "the reconstructed payload is exactly the seeded 75,000 assistant bytes");
        assert.equal(unit.end.sequence, unit.begin.sequence, "the end repeats its own begin sequence");
        assert.equal(unit.chunks.every((chunk) => chunk.copyId === unit.begin.copyId), true,
          "every page belongs to this copy id and no other");
      }
      assert.deepEqual(units.map((unit) => unit.begin.dispatchId), [ctrlXDispatch, copyDispatch],
        "each copy header is caused by its own initiating viewer dispatch");
      assert.deepEqual(units.map((unit) => unit.begin.sequence), [1, 2],
        "one binding-lifetime emission order, minted by the owner endpoint");
      assert.ok(wire.messageBytes.every((bytes) => bytes <= DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes),
        "every copy page stayed inside the declared per-message bound");

      /* ------------------------------------------------------------------ *
       * Input: Unicode paste, then the exact 1 MiB body, through the real child.
       * ------------------------------------------------------------------ */
      leg = "network viewer Unicode paste into the real native editor";
      const beforeUnicode = gestureSource();
      assert.equal(beforeUnicode.modes.bracketedPaste, true, "the pinned native child asks for bracketed paste");
      const unicode = await liveViewer.sendInput({
        source: beforeUnicode.source, inputModes: beforeUnicode.modes, kind: "paste", text: UNICODE_BODY,
      });
      assert.equal(unicode.status, "submitted");
      const unicodeWrapped = `\x1b[200~${UNICODE_BODY}\x1b[201~`;
      const unicodeDispatch = await waitForViewerDispatch(unicodeWrapped, true,
        "the host wrote the whole Unicode viewer dispatch");
      assert.equal(dispatches.get(unicodeDispatch)!.origin.kind, "viewer");
      const inlineInputs = viewerWire.frames.filter((frame): frame is SessionContentInputFrame => frame.type === "input");
      const unicodeFrame = inlineInputs.at(-1)!;
      assert.equal(unicodeFrame.kind, "paste");
      assert.equal(Buffer.from(unicodeFrame.data, "base64").toString("utf8"), UNICODE_BODY,
        "the viewer's paste body is the text body alone, never a double-wrapped packet");
      assert.equal(nativeIoSourceEquals(unicodeFrame.source, beforeUnicode.source), true);
      const unicodeEnter = await liveViewer.sendInput({
        source: beforeUnicode.source, inputModes: beforeUnicode.modes, kind: "keyboard", text: "\r",
      });
      assert.equal(unicodeEnter.status, "submitted");
      const unicodeEnterDispatch = await waitForViewerDispatch("\r", false, "the host wrote the Unicode submit key");
      assert.notEqual(unicodeEnterDispatch, unicodeDispatch, "the submit key is its own dispatch");
      const unicodeMarker = `INPUTNET:${createHash("sha256").update(UNICODE_TEXT, "utf8").digest("hex")}`;
      await signal.waitFor(() => text(pane).replace(/\s/g, "").includes(unicodeMarker), 20_000,
        "the real registered command digested the complete Unicode payload it received");

      leg = "network viewer exactly 1 MiB decoded paste body into the real native editor";
      const beforeBig = gestureSource();
      const big = await liveViewer.sendInput({
        source: beforeBig.source, inputModes: beforeBig.modes, kind: "paste", text: BIG_BODY,
      });
      assert.equal(big.status, "submitted", "every page of the 1 MiB body reached the transport");
      const bigWrapped = `\x1b[200~${BIG_BODY}\x1b[201~`;
      assert.equal(Buffer.byteLength(bigWrapped, "utf8"), NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES,
        "the wrapped 1 MiB body is exactly the unchanged whole-viewer-dispatch bound");
      const bigDispatch = await waitForViewerDispatch(bigWrapped, true,
        "the host wrote the whole 1 MiB viewer dispatch");
      const bigParts = fragments.filter((fragment) => fragment.dispatchId === bigDispatch);
      assert.deepEqual(bigParts[0]?.expectedNativeTuple, { sessionId: admission.sessionId, epoch: resumed.epoch },
        "the whole-body dispatch carries the same child-side conversation fence");
      assert.equal(bigParts[0]!.start, true, "the first fragment opens the dispatch");
      assert.equal(bigParts.at(-1)!.end, true, "the last fragment closes it");
      assert.deepEqual(bigParts.map((part) => part.part), bigParts.map((_part, index) => index),
        "fragments of one dispatch stay contiguous and ordered");
      assert.equal(bigParts.length, Math.ceil(NATIVE_INPUT_VIEWER_MAX_PAYLOAD_BYTES / NATIVE_INPUT_RAW_FRAGMENT_BYTES),
        "the whole dispatch crossed at the unchanged technical fragment bound");
      // The viewer's paged wire unit: one begin, ordered pages, one end, no truncation.
      const inputBegin = viewerWire.frames.filter((frame): frame is SessionContentInputBeginFrame =>
        frame.type === "input_begin").at(-1)!;
      const inputEnd = viewerWire.frames.filter((frame): frame is SessionContentInputEndFrame =>
        frame.type === "input_end").at(-1)!;
      const inputChunks = viewerWire.frames.filter((frame): frame is SessionContentInputChunkFrame =>
        frame.type === "input_chunk" && frame.inputId === inputBegin.inputId);
      assert.equal(inputBegin.kind, "paste");
      assert.equal(inputBegin.byteLength, NATIVE_TEXT_PASTE_MAX_BYTES,
        "the declared text-body length is exactly one MiB, never the wrapped or encoded length");
      assert.equal(inputBegin.chunkCount, inputChunks.length);
      assert.equal(inputChunks.length,
        Math.ceil(NATIVE_TEXT_PASTE_MAX_BYTES / DEFAULT_SESSION_CONTENT_BOUNDS.maxChunkPayloadBytes),
        "the paged unit is the builder's own ceiling at the unchanged chunk bound");
      assert.deepEqual(inputChunks.map((chunk) => chunk.index), inputChunks.map((_chunk, index) => index));
      assert.equal(Buffer.concat(inputChunks.map((chunk) => Buffer.from(chunk.data, "base64"))).toString("utf8"), BIG_BODY,
        "the joined pages are the exact 1 MiB text body the viewer submitted");
      assert.equal(inputBegin.source.sourceToken, beforeBig.source.sourceToken);
      assert.equal(inputEnd.inputId, inputBegin.inputId);
      assert.ok(wire.messageBytes.every((bytes) => bytes <= DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes),
        "no owner message exceeded the declared per-message bound after the input legs");
      assert.ok(viewerWire.messageBytes.every((bytes) => bytes <= DEFAULT_SESSION_CONTENT_BOUNDS.maxFrameBytes),
        "every viewer message stayed inside the declared per-message bound");
      const bigEnter = await liveViewer.sendInput({
        source: beforeBig.source, inputModes: beforeBig.modes, kind: "keyboard", text: "\r",
      });
      assert.equal(bigEnter.status, "submitted");
      const bigEnterDispatch = await waitForViewerDispatch("\r", false, "the host wrote the 1 MiB submit key", unicodeEnterDispatch);
      assert.notEqual(bigEnterDispatch, bigDispatch);
      assert.notEqual(bigEnterDispatch, unicodeEnterDispatch);
      const bigMarker = `INPUTNET:${createHash("sha256").update(BIG_PAYLOAD, "utf8").digest("hex")}`;
      await signal.waitFor(() => text(pane).replace(/\s/g, "").includes(bigMarker), 20_000,
        "the real child received and digested the complete 1 MiB text body, byte-exactly");
      assert.equal(liveManager.list().find((view) => view.id === rowId)!.lifecycle, "alive",
        "the resumed row survived the whole-body input");
      const afterBig = liveViewer.readNativeInputSource();
      assert.ok(afterBig);
      assert.equal(nativeIoSourceEquals(afterBig, source), true,
        "the input legs never changed the source this viewer committed");

      /* ------------------------------------------------------------------ *
       * The F7 raw-output decoy: a synchronous public shortcut write grants nothing.
       * ------------------------------------------------------------------ */
      leg = "network viewer F7 raw OSC 52 decoy from a native input-shortcut callback";
      assert.equal(readShortcutWitness(), null, "the shortcut witness starts absent, so it can only be this gesture's");
      const helperBeforeDecoy = helperRecords().length;
      const copiesBeforeDecoy = copies.length;
      const beforeDecoy = gestureSource();
      // Owned, event-driven observation of the witness file BEFORE the gesture: the
      // shortcut callback is this child's own in-process write, and an owned filesystem
      // watcher's notification is the only readiness trigger this file uses. No polling
      // or timer surrogate is involved; the existing bounded wait still owns the
      // deadline and the witness is re-read by its predicate. The case's ONE owned
      // watcher was armed before the child started and is reused here, never replaced.
      assert.ok(shortcutWatcher, "the owned root watcher is already armed for this child's witness write");
      const f7Expected = translateInput(F7, beforeDecoy.modes, {
        column: 0, row: 0,
        cols: beforeDecoy.source.geometry.cols, rows: beforeDecoy.source.geometry.rows,
      });
      assert.equal(typeof f7Expected, "string", "the owner's translator knows this F7 packet for the child's current modes");
      const decoyResult = await liveViewer.sendInput({
        source: beforeDecoy.source, inputModes: beforeDecoy.modes, kind: "keyboard", text: F7,
      });
      assert.equal(decoyResult.status, "submitted");
      const decoyDispatch = await waitForViewerDispatch(f7Expected as string, true,
        "the host wrote the decoy keystroke as its own viewer dispatch");
      assert.equal(dispatches.get(decoyDispatch)!.origin.kind, "viewer");
      await signal.waitFor(() => {
        const stage = readShortcutWitness()?.stage;
        return stage === "wrote" || stage === "threw";
      }, 20_000, "this child's own input-shortcut callback reported its write attempt");
      const witness = readShortcutWitness();
      assert.equal(witness?.pid, child.item.pid, "the decoy callback ran in this child's own pid");
      assert.equal(witness?.stage, "wrote", `the raw OSC 52 write was issued inside the shortcut callback: ${witness?.failure ?? ""}`);
      await signal.waitFor(() => copies.length > copiesBeforeDecoy, 20_000,
        "the owner observed the raw write and refuses it as unverified provenance");
      const refusal = copies.at(-1)!;
      assert.equal(refusal.event.kind, "unavailable", "a raw OSC 52 write is never a clipboard success");
      assert.equal(refusal.event.kind === "unavailable" ? refusal.event.reason : undefined, "unverified-native-origin");
      assert.equal(refusal.dispatchId, decoyDispatch, "the refusal is attributed to the decoy's own viewer dispatch");
      assert.equal(nativeIoSourceEquals(refusal.source, source), true);
      assert.equal(refusal.event.sessionId, admission.sessionId);
      assert.equal(refusal.event.sessionEpoch, resumed.epoch);
      assert.equal(helperRecords().length, helperBeforeDecoy, "a refused decoy never reaches the clipboard helper");
      assert.deepEqual(copies.filter((copy) => copy.event.kind === "copy").map((copy) => copy.event.kind), ["copy", "copy"],
        "the refused decoy added no copied payload");
      assert.equal(copies.some((copy) => copy.event.kind === "copy" && copy.event.encoded === decoy), false,
        "the decoy payload never becomes a copy");
      assert.equal(child.item.raw.includes(decoy), false, "the refused payload never leaves the child, capsule or raw stream");
      assert.equal(child.item.raw.includes("\x1b]52;c;"), false, "no raw clipboard relay leaves the opted-in child");
      assert.equal(text(pane).includes(decoy), false, "the refused payload never becomes screen text");
      const thirdReceipts = capsuleReceipts();
      assert.equal(thirdReceipts.length, 3, "the refusal is its own authenticated capsule");
      assert.equal(thirdReceipts[2]!.event.kind, "unavailable");
      assert.equal(thirdReceipts[2]!.dispatchId, decoyDispatch);
      assert.equal(thirdReceipts[2]!.origin.kind === "viewer" ? thirdReceipts[2]!.origin.token : undefined,
        source.sourceToken);
      assert.equal(wire.frames.filter((frame) => frame.type === "copy").length, 1,
        "an unavailable copy is carried as the fixed reason with the same authenticated tuple");
      assert.equal(ownerDelivered.length, 0, "no viewer-origin event ever took the owner-local clipboard route");

      /* ------------------------------------------------------------------ *
       * Final binding and interception audits, before the owned child exits.
       * ------------------------------------------------------------------ */
      leg = "binding and interception audit";
      assert.equal(text(pane).includes("prg-native-"), false, "capsules and readiness never become screen text");
      assert.equal(text(pane).includes(child.bootstrap.token), false, "the registration token never reaches the frame");
      assert.equal(child.item.raw.includes(child.bootstrap.token), false, "the token never returns in the child's output");
      assert.equal(child.item.raw.includes("prg-native-copy-v1;"), false, "a strict row never emits or accepts a v1 capsule");
      assert.equal(child.item.raw.includes("prg-native-copy-v2;"), true, "the copies used the strict v2 stream");
      for (const code of ["input_refused", "input_uncertain", "input_incomplete", "copy_dropped",
        "send_failed", "protocol_violation", "authorization_refused"] as const) {
        assert.equal(ownerDiagnostics.includes(code), false, `the owner never recorded ${code} for an admitted gesture`);
      }
      assert.equal(viewerDiagnostics.includes("content_rejected"), false);
      assert.equal(viewerDiagnostics.includes("channel_closed"), false);
      assert.equal(contentHost.activeSubscriptionCount, 1);
      assert.equal(contentHost.activeBindingCount, 1);
      // The child's OWN pid-scoped record survives every helper descendant and is
      // still armed; the helper inherited the blocking preload and attested itself.
      const afterCopies = JSON.parse(readFileSync(attestationFile(), "utf8")) as Attestation;
      assert.equal(afterCopies.pid, child.item.pid, "helper runs never replaced this child's attestation record");
      assert.equal(afterCopies.armed, true, "interception stayed armed for this child through every gesture");
      assert.equal(afterCopies.dlopenHook, true);
      assert.ok(attestationRecords().some((record) => record.pid !== child.item.pid && record.armed && record.dlopenHook
        && CLIPBOARD_COMMANDS.every((command) => record.resolved[command] === join(binDir, command))),
        "the owned clipboard recorder inherited the blocking preload and attested its own interception record");
      if (process.platform === "darwin") {
        // On macOS the native addon is the FIRST clipboard writer, so a real copy must
        // show that this child's blocked-dlopen hook actually fired.
        assert.ok(afterCopies.blocked.some((name) => /^darwin-platform\.node$/.test(name)),
          "the native OS clipboard module load was actually intercepted in this child");
      }
      const finalReceipts = capsuleReceipts();
      assert.equal(finalReceipts.every((receipt) => receipt.event.sessionId === admission.sessionId
        && receipt.event.sessionEpoch === resumed.epoch), true,
        "every authenticated capsule stayed bound to the resumed conversation tuple");
      assert.equal(finalReceipts.every((receipt) => receipt.origin.kind === "viewer"), true,
        "no copy ever took the owner-local route on this framed row");

      // Owned exit through the network lane, then the binding is retired.
      leg = "owned exit through the viewer lane";
      const exitModes = currentModes();
      const exit = await liveViewer.sendInput({
        source, inputModes: exitModes, kind: "keyboard", text: "/proof-exit\r",
      });
      assert.equal(exit.status, "submitted");
      await waitForViewerDispatch("/proof-exit\r", true, "the host wrote the owned exit command");
      await signal.waitFor(() => child.item.exited, 20_000, "the owned child exits on the fixture command");
      assert.equal(child.item.exitCode, 0, "the owned child exited cleanly");
      leg = "owned cleanup";
      await withTimeout(liveViewer.stop(), 10_000, "the viewer never finished its bounded retirement");
      await withTimeout(attachedContent.binding.closed, 10_000, "the owner binding never confirmed its retirement");
      await contentHost.stopAll();
      const stopped = await liveManager.shutdown({ graceMs: 8000, killMs: 2000 });
      assert.deepEqual(stopped.remainingIds, []);
      assert.deepEqual(stopped.forcedIds, []);
      // Audit the complete write ledger after both child exit and manager retirement,
      // including non-user replies that arrived after the last awaited gesture.
      drain();
      assert.equal(child.writes.filter((frame) => !frame.startsWith("prg-ni-v1;")).length, 0,
        "no host byte reached this child unframed at any point in the case");
      // Deliberately no assertion about a physical terminal or OS clipboard.
    } catch (error) {
      failureCaptured = true;
      originalFailure = error;
      const artifact = join(root, "failure.json");
      const childPid = children[0]?.item.pid ?? -1;
      const safeFacts = (): Record<string, unknown> => {
        try {
          return {
            row,
            child: children.map((entry) => ({
              pid: entry.item.pid, exited: entry.item.exited,
              exitCode: entry.item.exitCode === undefined ? null : entry.item.exitCode,
              rawChars: entry.item.raw.length, rawSha256: digest(entry.item.raw),
              hostWrites: entry.writes.length,
              unframedWrites: entry.writes.filter((frame) => !frame.startsWith("prg-ni-v1;")).length,
            })),
            attestation: existsSync(join(attestRoot, `${nonce}.${childPid}.json`))
              ? JSON.parse(readFileSync(join(attestRoot, `${nonce}.${childPid}.json`), "utf8")) as Attestation
              : null,
            shortcutWitness: readShortcutWitness(),
            helpers: helperRecords().length,
            copies: copies.map((copy) => ({
              kind: copy.event.kind,
              dispatchId: copy.dispatchId,
              encodedChars: copy.event.kind === "copy" ? copy.event.encoded.length : 0,
            })),
            ownerDelivered: ownerDelivered.map((event) => event.kind),
            ownerDiagnostics,
            viewerDiagnostics,
            wireTypes: attachment === undefined ? null
              : attachment.wire.frames.reduce<Record<string, number>>((counts, frame) => {
                counts[frame.type] = (counts[frame.type] ?? 0) + 1;
                return counts;
              }, {}),
          };
        } catch (inner) {
          return { factsFailed: String(inner) };
        }
      };
      let recorded = false;
      try {
        writeFileSync(artifact, JSON.stringify({
          leg, root, error: String(error), facts: safeFacts(),
          surfaces: surfaces.map((surface) => {
            try { return text(surface); } catch { return "<frame unavailable>"; }
          }),
        }), { mode: 0o600, flag: "wx" });
        recorded = true;
      } catch { /* Preserve the original assertion and still settle owned children. */ }
      if (error instanceof Error) {
        error.message = `${error.message} [leg: ${leg}]${recorded ? ` [owned diagnostic: ${artifact}]` : ""}`;
      }
      throw error;
    } finally {
      // One failed cleanup must not skip another owned resource or hide the original
      // assertion. Every attempt retains its existing budget and owned handle.
      const cleanupErrors: unknown[] = [];
      const attempt = async (run: () => Promise<void> | void): Promise<void> => {
        try { await run(); } catch (error) { cleanupErrors.push(error); }
      };
      if (viewer !== undefined) await attempt(() => viewer!.stop());
      const boundAttachment = attachment;
      if (boundAttachment !== undefined) await attempt(() => boundAttachment.binding.stop());
      if (host !== undefined) await attempt(() => host!.stopAll());
      if (hostFixture !== undefined) await attempt(() => hostFixture!.host.close());
      for (const instance of managers) {
        await attempt(async () => { await instance.shutdown({ graceMs: 2000, killMs: 2000 }); });
      }
      for (const item of owned) {
        if (!item.exited) {
          await attempt(async () => {
            item.handle.kill("SIGTERM");
            await signal.waitFor(() => item.exited, 5000, "owned fixture cleanup exit");
          });
        }
      }
      for (const instance of managers) await attempt(async () => { await instance.dispose(); });
      for (const surface of surfaces) await attempt(() => surface.dispose());
      if (shortcutWatcher !== undefined) await attempt(() => { shortcutWatcher!.close(); });
      if (statusBroker !== undefined) await attempt(async () => { await statusBroker!.dispose(); });
      // Retain invocation-owned synthetic evidence whenever the case failed OR any
      // teardown attempt was unconfirmed; remove only a fully settled successful run,
      // and never touch anything outside this root.
      if (!failureCaptured && cleanupErrors.length === 0) {
        await attempt(() => { rmSync(root, { recursive: true, force: true }); });
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          failureCaptured ? [originalFailure, ...cleanupErrors] : cleanupErrors,
          `owned network native fixture cleanup unconfirmed; evidence retained at ${root}`,
        );
      }
    }
  });
