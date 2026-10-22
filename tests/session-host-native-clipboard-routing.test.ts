import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, watch, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createStatusBroker } from "../src/session-host/broker";
import { hostOwnershipPath } from "../src/session-host/roster-store";
import { InstanceManager, type InstancePty } from "../src/session-host/instances";
import { NativeAgentRegistry } from "../src/session-host/profiles";
import {
  createNativeClipboardReceiver,
  type NativeClipboardEvent,
  type NativeClipboardOriginEvent,
} from "../src/session-host/native-clipboard";
import {
  createNativeInputDecoder,
  type NativeInputFragment,
} from "../src/session-host/native-input-origin";
import { TerminalSurface, stripGeneratedSgr } from "../src/session-host/terminal-surface";
import type { SessionHostBootstrap } from "../src/session-host/protocol";
import { ChangeSignal, compileAndStageCandidate, makeNativeAgentRoot } from "./helpers/session-host-native-main-harness";
import { findInstalledAgentDirs } from "./menu-tui-fakes";
import { skipOrFail } from "./bridge-fakes";

/**
 * Bounded, pure diagnostic formatting for this file's failure-evidence path.
 *
 * These helpers live at module scope so the exclusion guarantees they exist for
 * - no clipboard capsule, base64 payload, private string sequence, environment,
 * or known bootstrap-token fragment ever reaches CI stderr - are asserted
 * directly by a pure test in this same file, without a native run, a new
 * framework, or an extra file.
 */
const SUMMARY_CHAR_LIMIT = 8 * 1024;
const SUMMARY_LINE_LIMIT = 240;
const SUMMARY_TAIL_LINES = 24;
const REDACTED = "<redacted>";
const ENCODED = "<encoded>";
/**
 * Shortest known-token fragment that is always withheld. Registration tokens
 * are 64 random hex characters, so any run of this many characters inside a
 * token is secret material; shorter remnants cannot identify a credential and
 * redacting them would erase unrelated screen text.
 */
const MIN_TOKEN_FRAGMENT = 6;

/** Replace whole private string sequences (and truncated partials) and long encoded runs. */
function stripPrivateSequences(value: string): string {
  return value
    // OSC strings - 52;c; clipboard payloads, 777 private capsules, and any
    // unterminated partial - are consumed through BEL, ST, or end of input.
    .replace(/(?:\x1b\]|\u009d)[\s\S]*?(?:\x07|\x1b\\|\u009c|$)/g, "<osc>")
    // The same for DCS/APC/PM strings, which have no bounded length inside the
    // retained window and must never become printable text when unterminated.
    .replace(/(?:\x1b[P^_]|[\u0090\u009e\u009f])[\s\S]*?(?:\x1b\\|\u009c|\x07|$)/g, "<string>")
    // A long encoded run is never evidence: encoded clipboard payloads, base64
    // blobs, and opaque token blobs are replaced instead of retained.
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, ENCODED)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

/**
 * Withhold every fragment of a known token that is long enough to be secret
 * material, wherever it appears and whatever padding or punctuation surrounds
 * it. Fixed-width windows catch a fragment that starts mid-token; extending
 * while the run is still a substring of the token redacts the whole maximal
 * fragment instead of only a prefix or a suffix.
 */
function redactKnownTokenFragments(value: string, tokens: readonly string[]): string {
  let out = value;
  for (const token of tokens) {
    if (token.length < MIN_TOKEN_FRAGMENT) continue;
    const windows = new Set<string>();
    for (let index = 0; index + MIN_TOKEN_FRAGMENT <= token.length; index += 1) {
      windows.add(token.slice(index, index + MIN_TOKEN_FRAGMENT));
    }
    let scrubbed = "";
    let position = 0;
    while (position < out.length) {
      const window = out.slice(position, position + MIN_TOKEN_FRAGMENT);
      if (window.length === MIN_TOKEN_FRAGMENT && windows.has(window)) {
        let end = position + MIN_TOKEN_FRAGMENT;
        while (end < out.length && token.includes(out.slice(position, end + 1))) end += 1;
        scrubbed += REDACTED;
        position = end;
        continue;
      }
      scrubbed += out[position];
      position += 1;
    }
    out = scrubbed;
  }
  return out;
}

/** Sanitize one diagnostic string against every known registration token. */
function sanitize(value: string, tokens: readonly string[]): string {
  return redactKnownTokenFragments(stripPrivateSequences(value), tokens);
}

/** Bound one diagnostic value, keeping an explicit truncation marker. */
function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[+${value.length - limit} chars]`;
}

/**
 * Sanitize and hard-bound retained diagnostic text. Sanitization runs first so a
 * replacement (a six-character fragment becomes `<redacted>`) cannot push the
 * retained text past its bound; cutting the sanitized value cannot restore any
 * removed private data.
 */
function boundDiagnosticText(value: string, tokens: readonly string[], limit: number): string {
  const safe = sanitize(value, tokens);
  if (safe.length <= limit) return safe;
  const marker = `\n…[truncated at ${limit} chars]`;
  return `${safe.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

test("diagnostic formatter withholds private sequences and every substantial token fragment", () => {
  const token = "0123456789abcdef".repeat(4); // 64 hex characters: the registration token shape
  const tokens = [token];
  const fragments = [
    token, // full token
    token.slice(0, 24), // prefix fragment followed by punctuation
    token.slice(-20), // wrapped suffix fragment
    token.slice(12, 30), // fragment that starts mid-token
  ];
  for (const fragment of fragments) {
    const output = sanitize(`before ${fragment} after`, tokens);
    assert.equal(output.includes(fragment), false, "the known-token fragment is withheld");
    assert.equal(output.startsWith("before "), true, "ordinary leading text is preserved");
    assert.equal(output.endsWith(" after"), true, "ordinary trailing text is preserved");
    for (let index = 0; index + MIN_TOKEN_FRAGMENT <= token.length; index += 1) {
      assert.equal(output.includes(token.slice(index, index + MIN_TOKEN_FRAGMENT)), false,
        "no substantial part of the registration token survives");
    }
  }
  // Padding and punctuation around a fragment neither stop the redaction nor
  // erase the surrounding text.
  assert.equal(sanitize(`[${token.slice(0, 12)}]\ttail`, tokens), `[${REDACTED}]\ttail`);

  // OSC 52 base64 clipboard payloads, 777 private capsules, and unterminated
  // partials of either never survive as printable text.
  const payload = Buffer.from("SYNTHETIC-CLIPBOARD-PAYLOAD-EXAMPLE-0123456789").toString("base64");
  assert.ok(payload.length >= 40, "the payload exercises the encoded-run rule");
  assert.equal(sanitize(`a\x1b]52;c;${payload}\x07b`, []), "a<osc>b");
  assert.equal(sanitize("a\x1b]777;prg-native-copy-v1;secret\x07b", []), "a<osc>b");
  assert.equal(sanitize("a\x1b]52;c;QUJD", []), "a<osc>");
  assert.equal(sanitize("a\u009d52;c;QUJD\u009cb", []), "a<osc>b");
  assert.equal(sanitize("a\u0090private\u009cb", []), "a<string>b");
  assert.equal(sanitize("a\u009bb", []), "ab", "C1 controls never reach the outer log terminal");
  assert.equal(sanitize("a\x1bPprivate", []), "a<string>");
  assert.equal(sanitize("a\x1b^private", []), "a<string>");
  assert.equal(sanitize("a\x1b_private\x07b", []), "a<string>b");
  assert.equal(sanitize(payload, []), ENCODED);
  // No escape or other control byte can survive the formatter, terminated or not.
  const combined = sanitize(`a\x1b]52;c;${payload}\x07b\x1bPprivate\x1b`, tokens);
  assert.equal(combined.includes("\x1b"), false, "no ESC survives sanitization");
  assert.equal(/[\x00-\x08\x0b-\x1f\x7f]/.test(combined), false, "no control byte survives sanitization");

  // The bound is hard even though sanitization expands text: the fragment below
  // is replaced before the cut, so the retained text can never grow past it.
  const straddling = `${"y ".repeat(180)}${token.slice(0, 30)}${"z ".repeat(50)}`;
  const bounded = boundDiagnosticText(straddling, tokens, 400);
  assert.ok(bounded.length <= 400, "retained text never exceeds its bound");
  assert.equal(bounded.includes("[truncated at 400 chars]"), true, "the truncation is explicit");
  assert.equal(bounded.includes(token.slice(0, MIN_TOKEN_FRAGMENT)), false,
    "the withheld fragment cannot reappear at the truncation boundary");
  assert.equal(bounded.includes("y ".repeat(20)), true, "ordinary text before the cut is preserved");
  assert.equal(boundDiagnosticText("short", tokens, 400), "short", "text inside the bound is unchanged");

  // Redaction can expand six characters into a ten-character placeholder. The
  // bound applies to the sanitized text, so expansion can never exceed it.
  const expanding = `${"012345"} `.repeat(2000);
  for (const limit of [400, SUMMARY_CHAR_LIMIT]) {
    const output = boundDiagnosticText(expanding, tokens, limit);
    assert.ok(output.length <= limit, "redaction expansion respects the hard bound");
    assert.equal(output.includes(token.slice(0, MIN_TOKEN_FRAGMENT)), false,
      "no fragment survives expansion and truncation");
    assert.ok(output.endsWith(`[truncated at ${limit} chars]`), "the bound stays explicit");
  }
});

const CLIPBOARD_COMMANDS = ["pbcopy", "xclip", "xsel", "wl-copy", "termux-clipboard-set"] as const;
type Witness = Record<string, unknown>;
interface CopyFixtureIdentity {
  readonly nonce: string;
  readonly moduleUrl: string;
  readonly bin: string;
  /** Main's outer PTY owns one native child; ordinary legs own the producer directly. */
  readonly producer: { readonly pid: number } | { readonly parentPid: number };
}
function witness(value: unknown): Witness | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Witness : undefined;
}

/** Positive public startup AND observed isolation, never an editor-border heuristic. */
function copyFixtureReady(identity: CopyFixtureIdentity, startupValue: unknown, isolationValue: unknown): boolean {
  const startup = witness(startupValue);
  const isolation = witness(isolationValue);
  if (!startup || !isolation || startup.version !== 1 || isolation.version !== 1) return false;
  if (startup.nonce !== identity.nonce || isolation.nonce !== identity.nonce) return false;
  if (!Number.isSafeInteger(startup.pid) || (startup.pid as number) <= 0 || isolation.pid !== startup.pid) return false;
  if ("pid" in identity.producer ? startup.pid !== identity.producer.pid : startup.parentPid !== identity.producer.parentPid) return false;
  if (startup.event !== "session_start" || startup.moduleUrl !== identity.moduleUrl
    || startup.probe !== "getNativeClipboard" || startup.exportType !== "function"
    || startup.backendUnavailable !== true || startup.failure !== undefined) return false;
  if (isolation.armed !== true || isolation.dlopenHook !== true) return false;
  const resolved = witness(isolation.resolved);
  if (!resolved || !CLIPBOARD_COMMANDS.every((command) => resolved[command] === join(identity.bin, command))) return false;
  return Array.isArray(isolation.blocked) && isolation.blocked.some((name: unknown) => typeof name === "string"
    && /^(?:darwin|win32|linux)-platform(?:-x11)?\.node$/.test(name));
}

test("clipboard fixture readiness requires this producer's public startup and observed pre-copy isolation", () => {
  const identity: CopyFixtureIdentity = { nonce: "fresh-launch", moduleUrl: "file:///owned/public-tui/index.js", bin: "/owned/bin", producer: { pid: 101 } };
  const startup = { version: 1, nonce: identity.nonce, pid: 101, parentPid: 99, event: "session_start",
    moduleUrl: identity.moduleUrl, probe: "getNativeClipboard", exportType: "function", backendUnavailable: true };
  const isolation = { version: 1, nonce: identity.nonce, pid: 101, armed: true, dlopenHook: true,
    resolved: Object.fromEntries(CLIPBOARD_COMMANDS.map((command) => [command, join(identity.bin, command)])),
    blocked: ["darwin-platform.node"] };
  assert.equal(copyFixtureReady(identity, startup, isolation), true);
  assert.equal(copyFixtureReady({ ...identity, producer: { parentPid: 99 } }, startup, isolation), true,
    "the outer Main's exact native child has its own PID and the owned outer parent");
  assert.equal(copyFixtureReady(identity, undefined, isolation), false,
    "an editor border and an installed hook are not public startup evidence");
  assert.equal(copyFixtureReady(identity, startup, undefined), false, "public startup alone grants no copy safety");
  for (const changed of [{ nonce: "older-launch" }, { pid: 102 }, { event: "loaded" }, { moduleUrl: "file:///other/index.js" },
    { exportType: "missing" }, { backendUnavailable: false }, { failure: "probe failed" }]) {
    assert.equal(copyFixtureReady(identity, { ...startup, ...changed }, isolation), false, "foreign or failed public startup is refused");
  }
  assert.equal(copyFixtureReady({ ...identity, producer: { parentPid: 98 } }, startup, isolation), false);
  for (const changed of [{ nonce: "older-launch" }, { pid: 102 }, { armed: false }, { dlopenHook: false },
    { blocked: [] }, { blocked: ["unrelated.node"] }, { resolved: {} },
    { resolved: { ...isolation.resolved, pbcopy: "/usr/bin/pbcopy" } }]) {
    assert.equal(copyFixtureReady(identity, startup, { ...isolation, ...changed }), false,
      "an unobserved native block or non-owned helper path refuses before any copy");
  }
});

/**
 * Real bundled CLI/PTY proof. No physical clipboard is read or written.
 *
 * The last leg additionally runs one explicitly opted-in (`nativeInputOriginFraming:
 * true`) LOCAL hosted child, so the parent's native run exercises the real preload
 * readiness/startup-query ordering, the strict child bridge, and the host's framed
 * write seam end to end. Recording helpers prevent physical clipboard writes;
 * this does not certify a real terminal's clipboard permission or delivery.
 */
test("real bundled native and hosted clipboard producers preserve selected payload and reject raw output", { timeout: 240_000 }, async (t) => {
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
  // The same public pinned entry used by the network-native acceptance fixture;
  // no private native subpath or substituted backend is a readiness witness.
  const tuiEntry = realpathSync(requireHere.resolve("pi-session-host-tui"));
  let tuiRoot = dirname(tuiEntry);
  while (!existsSync(join(tuiRoot, "package.json"))) {
    const parent = dirname(tuiRoot);
    assert.notEqual(parent, tuiRoot, "the public TUI entry has its own package manifest");
    tuiRoot = parent;
  }
  const tuiManifest = JSON.parse(readFileSync(join(tuiRoot, "package.json"), "utf8")) as { name: string; version: string };
  assert.equal(tuiManifest.name, "@earendil-works/pi-tui");
  assert.equal(tuiManifest.version, "1.3.0");
  const nativeTuiUrl = pathToFileURL(tuiEntry).href;
  const pty = requireHere("@lydell/node-pty") as { spawn(file: string, args: string[], options: Record<string, unknown>): InstancePty };
  const root = realpathSync(mkdtempSync("/tmp/prg-copy-"));
  const candidate = compileAndStageCandidate(root); // inactive build; never live dist/
  for (const name of ["bin", "home", "tmp", "work", "broker", "provider"]) mkdirSync(join(root, name), { mode: 0o700 });
  const agentDir = makeNativeAgentRoot(root, { deferredPiTools: false });
  const signal = new ChangeSignal();
  const helperLog = join(root, "helper.jsonl");
  const recorder = join(root, "clipboard-recorder.cjs");
  writeFileSync(recorder, `const fs=require('node:fs');const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>fs.appendFileSync(process.env.PRG_COPY_LOG,JSON.stringify(Buffer.concat(chunks).toString('utf8'))+'\\n'));`, { mode: 0o600, flag: "wx" });
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  // These are the ONLY clipboard commands on the isolated PATH. Native modules
  // are blocked below, so no success path can reach the user's OS clipboard.
  for (const name of CLIPBOARD_COMMANDS) {
    writeFileSync(join(root, "bin", name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(recorder)}\n`, { mode: 0o700, flag: "wx" });
  }
  const isolationStem = join(root, "clipboard-isolation");
  const startupStem = join(root, "public-startup");
  const preload = join(root, "block-native-clipboard.cjs");
  writeFileSync(preload, `const fs=require('node:fs'),path=require('node:path');
const commands=${JSON.stringify(CLIPBOARD_COMMANDS)};
const record={version:1,nonce:process.env.PRG_COPY_NONCE,pid:process.pid,armed:true,dlopenHook:false,resolved:{},blocked:[]};
function publish(){
 // Re-prove the child's CURRENT helper PATH when the public probe actually
 // reaches the interception, not only when this preload was installed. Once
 // any check fails, this launch stays disarmed; publication never repairs it.
 for(const name of commands){
  let found=null;
  for(const dir of (process.env.PATH||'').split(path.delimiter)){
   if(!dir)continue;const file=path.join(dir,name);
   try{if(!fs.lstatSync(file).isFile())continue;fs.accessSync(file,fs.constants.X_OK);found=file;break;}catch{}
  }
  record.resolved[name]=found;
  if(found!==path.join(process.env.PRG_COPY_BIN||'',name))record.armed=false;
 }
 try{const target=process.env.PRG_COPY_ISOLATION+'.'+process.pid+'.json';const temp=target+'.staging';fs.writeFileSync(temp,JSON.stringify(record),{mode:0o600});fs.renameSync(temp,target);}catch{/* missing receipt refuses every copy */}
}
const dlopen=process.dlopen;
process.dlopen=function(mod,file,...args){
 if(/(?:darwin|win32|linux)-platform(?:-x11)?\\.node$/.test(String(file))){
  if(record.blocked.length<8)record.blocked.push(path.basename(String(file)));publish();
  throw Error('owned fixture blocks OS clipboard');
 }
 return dlopen.call(this,mod,file,...args);
};
record.dlopenHook=process.dlopen!==dlopen;publish();`, { mode: 0o600, flag: "wx" });
  const fixture = join(root, "clipboard-proof.cjs");
  const decoy = Buffer.from("UNSOLICITED-466").toString("base64");
  writeFileSync(fixture, `const fs=require('node:fs');
module.exports=pi=>{
// In pinned Pi 1.3.0 the real submit handler is installed before the public
// session_start event. An editor border can be drawn earlier with startup-only
// submission feedback. Probe only the documented LOAD-only backend accessor:
// never getText/getImage/getFilePaths/setText or any physical clipboard action.
pi.on('session_start',async()=>{
 const record={version:1,nonce:process.env.PRG_COPY_NONCE,pid:process.pid,parentPid:process.ppid,event:'session_start',moduleUrl:${JSON.stringify(nativeTuiUrl)},probe:'getNativeClipboard',exportType:'missing',backendUnavailable:false};
 try{
  const api=await import(record.moduleUrl);record.exportType=typeof api.getNativeClipboard;
  if(record.exportType!=='function')throw Error('public clipboard accessor missing');
  record.backendUnavailable=api.getNativeClipboard()==null;
 }catch(error){record.failure=String(error&&error.message||error);}
 try{const target=process.env.PRG_COPY_STARTUP+'.'+record.nonce+'.json';const temp=target+'.staging';fs.writeFileSync(temp,JSON.stringify(record),{mode:0o600});fs.renameSync(temp,target);}catch{/* a missing receipt fails closed */}
});
pi.registerCommand('input-proof',{description:'Verify owned input bytes',handler:async(input)=>pi.sendMessage({customType:'input-proof',content:'INPUT466:'+require('node:crypto').createHash('sha256').update(input,'utf8').digest('hex'),display:true})});
pi.registerCommand('copy-proof',{description:'Synthetic visible text',handler:async()=>pi.sendMessage({customType:'copy-proof-'+(globalThis[Symbol.for('prg.copy-proof.counter')]=(globalThis[Symbol.for('prg.copy-proof.counter')]||0)+1),content:'CLIP466-A αβ café\\nCLIP466-B 雪 end',display:true})});
pi.registerCommand('copy-decoy',{description:'Synthetic raw-output refusal',handler:async()=>process.stdout.write('\\x1b]52;c;${decoy}\\x07')});
pi.registerCommand('copy-render-decoy',{description:'Synthetic render-output refusal',handler:async(_,ctx)=>ctx.ui.setWidget('copy-decoy',()=>({render:()=>{process.stdout.write('\\x1b]52;c;${decoy}\\x07');return[]},invalidate(){}}))});
pi.registerCommand('proof-exit',{description:'Exit owned fixture',handler:async(_,ctx)=>ctx.shutdown()});
};`, { mode: 0o600, flag: "wx" });
  const common: NodeJS.ProcessEnv = {
    PATH: [join(root, "bin"), dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    NODE_PATH: [join(process.cwd(), "node_modules"), dirname(dirname(packageRoot)), join(packageRoot, "node_modules")].join(delimiter),
    HOME: join(root, "home"), TMPDIR: join(root, "tmp"), PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1", PI_TELEMETRY: "0", LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", DISPLAY: ":synthetic-recording-only",
    SSH_CONNECTION: "synthetic-client 1234 synthetic-host 22", NODE_OPTIONS: `--require=${preload}`, PRG_COPY_LOG: helperLog,
    PRG_COPY_ISOLATION: isolationStem, PRG_COPY_STARTUP: startupStem, PRG_COPY_BIN: join(root, "bin"),
  };
  const args = ["--offline", "--no-context-files", "--no-skills", "--no-themes", "--no-extensions", "--extension", fixture, "--tui-mode", "fullscreen"];
  const owned: Array<{ handle: InstancePty; nonce: string; ownsNativeChild: boolean; exited: boolean; raw: string; exitCode?: number; bootstrap?: SessionHostBootstrap }> = [];
  let proofWatchError: Error | undefined;
  let proofWatcher: ReturnType<typeof watch> | undefined;
  const spawn = (file: string, argv: string[], env: NodeJS.ProcessEnv, cwd: string, cols = 80, rows = 30, ownsNativeChild = false): (typeof owned)[number] => {
    const nonce = randomUUID(); // fresh even if a later owned launch reuses an OS PID
    const handle = pty.spawn(file, argv, { name: "xterm-ghostty", cols, rows, cwd, env: { ...env, PRG_COPY_NONCE: nonce }, encoding: "utf8" });
    const item: (typeof owned)[number] = { handle, nonce, ownsNativeChild, exited: false, raw: "", ...(env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP
      ? { bootstrap: JSON.parse(env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP) as SessionHostBootstrap } : {}) };
    owned.push(item); // ownership before callbacks/awaits
    handle.onExit((event) => { item.exited = true; item.exitCode = event.exitCode; signal.notify(); });
    handle.onData((data) => { item.raw += data; signal.notify(); });
    return item;
  };
  const readWitness = (file: string): unknown => {
    if (!existsSync(file)) return undefined;
    try { return JSON.parse(readFileSync(file, "utf8")) as unknown; } catch { return undefined; }
  };
  const readyForCopy = (item: (typeof owned)[number]): boolean => {
    if (proofWatchError) throw new Error("owned clipboard fixture receipt watcher failed", { cause: proofWatchError });
    if (item.exited) return false;
    const startup = readWitness(`${startupStem}.${item.nonce}.json`);
    const pid = witness(startup)?.pid;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return false;
    return copyFixtureReady({ nonce: item.nonce, moduleUrl: nativeTuiUrl, bin: join(root, "bin"),
      producer: item.ownsNativeChild ? { parentPid: item.handle.pid } : { pid: item.handle.pid } },
    startup, readWitness(`${isolationStem}.${pid as number}.json`));
  };
  const requireCopyIsolation = (surface: TerminalSurface): void => {
    const owner = paneOwners.get(surface);
    assert.ok(owner && readyForCopy(owner), "this exact producer observed public startup and owned clipboard interception before the copy gesture");
  };
  const copyKey = (surface: TerminalSurface, write: (data: string) => void, data: string): void => {
    if (data === "\x1b[17~") requireCopyIsolation(surface);
    write(data);
  };
  const text = (surface: TerminalSurface): string => surface.frame().lines.map(stripGeneratedSgr).join("\n");
  const helperRecords = (): string[] => existsSync(helperLog) ? readFileSync(helperLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string) : [];
  const events = (item: (typeof owned)[number]): NativeClipboardEvent[] => {
    const result: NativeClipboardEvent[] = [];
    const receive = createNativeClipboardReceiver(item.bootstrap!, (event) => result.push(event));
    for (const match of item.raw.matchAll(/\x1b\]777;([^\x07]*)\x07/g)) receive(match[1]!);
    return result;
  };
  const copies = (item: (typeof owned)[number]): string[] => item.bootstrap
    ? events(item).flatMap((event) => event.kind === "copy" ? [event.encoded] : [])
    : [...item.raw.matchAll(/\x1b\]52;c;([^\x07]*)\x07/g)].map((match) => match[1]!);
  const select = (surface: TerminalSurface, write: (data: string) => void,
    first = "CLIP466-A", last = "CLIP466-B", top = -1, bottom = Number.MAX_SAFE_INTEGER): void => {
    requireCopyIsolation(surface); // copy-on-select can copy on this gesture's release
    const lines = surface.frame().lines.map(stripGeneratedSgr);
    const y1 = lines.findIndex((line, row) => row > top && row < bottom && line.includes(first));
    const y2 = lines.findIndex((line, row) => row > top && row < bottom && line.includes(last));
    assert.ok(y1 >= 0 && y2 > y1);
    const x1 = lines[y1]!.indexOf(first);
    const x2 = lines[y2]!.indexOf(last) + `${last} 雪 end`.length;
    write(`\x1b[<0;${x1 + 1};${y1 + 1}M`);
    write(`\x1b[<32;${x2 + 1};${y2 + 1}M`);
    write(`\x1b[<0;${x2 + 1};${y2 + 1}m`);
  };
  let manager: InstanceManager | undefined;
  let broker: Awaited<ReturnType<typeof createStatusBroker>> | undefined;
  let framedManager: InstanceManager | undefined;
  const surfaces: TerminalSurface[] = [];
  // ---------------------------------------------------------------------------
  // Bounded pre-cleanup failure evidence.
  //
  // The existing failure dump is written under a bare `mkdtempSync` root that CI
  // neither prints nor uploads, and it only covered the standalone/Main panes.
  // Both gaps are observation-only: nothing below changes a launch, an input, an
  // ordering step, a wait budget, or an assertion, and the unchanged cleanup
  // `finally` still runs afterwards. CI retains the printed summary on stderr,
  // hard-bounded to 8192 characters by the pure formatter above, which strips private
  // string sequences and withholds every substantial fragment of a known
  // registration token. A fault inside this diagnostics path is contained so it
  // can never replace the original tester error.
  // ---------------------------------------------------------------------------
  type Owned = (typeof owned)[number];
  let activeLeg = "setup";
  let activeStage = "setup";
  let activePane: TerminalSurface | undefined;
  const paneLabels = new Map<TerminalSurface, string>();
  const paneOwners = new Map<TerminalSurface, Owned>();
  const trackPane = (label: string, surface: TerminalSurface, owner?: Owned): void => {
    surfaces.push(surface);
    paneLabels.set(surface, label);
    if (owner) paneOwners.set(surface, owner);
  };
  // Tag the active leg/stage on every wait label and on the failure summary, so
  // the two `remote` loop iterations and the repeated stage names stay distinct.
  // A call without a pane clears the previous leg's pane, so the summary never
  // attributes one leg's screen to another leg's failure.
  const at = (legName: string, stageName: string, pane?: TerminalSurface): string => {
    activeLeg = legName;
    activeStage = stageName;
    activePane = pane;
    return `${legName}: ${stageName}`;
  };
  const knownTokens = (): string[] => owned.flatMap((item) => (item.bootstrap ? [item.bootstrap.token] : []));
  const digestOf = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
  const safeFrame = (surface: TerminalSurface): string => {
    try { return text(surface); } catch { return "<frame unavailable: surface already disposed>"; }
  };
  const marker = (raw: string, needle: string): string => {
    const count = raw.split(needle).length - 1;
    return count === 0 ? "0" : `${count}@${raw.indexOf(needle)}`;
  };
  const buildFailureSummary = (error: unknown): string => {
    const tokens = knownTokens();
    const lines: string[] = [
      `leg=${activeLeg} stage=${activeStage}`,
      `error=${JSON.stringify(clip(sanitize(String(error), tokens), 400))}`,
    ];
    try {
      const views = [manager, framedManager].flatMap((instance) => (instance ? instance.list() : []));
      lines.push(`rows=${views.length}`);
      for (const view of views) {
        lines.push(`  row=${view.id} lifecycle=${view.lifecycle} liveProcess=${view.hasLiveProcess}`
          + ` exitCode=${view.exitCode === undefined ? "none" : view.exitCode}`
          + ` error=${view.error === undefined ? "none" : JSON.stringify(clip(sanitize(view.error, tokens), 160))}`);
      }
    } catch (rowError) {
      lines.push(`rows=<unavailable: ${clip(sanitize(String(rowError), tokens), 160)}>`);
    }
    try {
      lines.push(`ownedChildren=${owned.length}`);
      owned.forEach((item, index) => {
        lines.push(`  child[${index}] pid=${item.handle.pid} exited=${item.exited}`
          + ` exitCode=${item.exitCode === undefined ? "none" : item.exitCode}`
          + ` rawChars=${item.raw.length} rawSha256=${digestOf(item.raw)}`
          + ` bootstrap=${item.bootstrap ? "present" : "none"}`);
      });
    } catch (childError) {
      lines.push(`ownedChildren=<unavailable: ${clip(sanitize(String(childError), tokens), 160)}>`);
    }
    try {
      const records = helperRecords();
      lines.push(`helperRecords=${records.length} lens=[${records.map((record) => record.length).join(",")}]`
        + ` sha256=[${records.map((record) => digestOf(record)).join(",")}]`);
    } catch (helperError) {
      lines.push(`helperRecords=<unavailable: ${clip(sanitize(String(helperError), tokens), 160)}>`);
    }
    // Recorders are reported as counts, lengths and digests only: never the
    // recorded payload, an encoded clipboard capsule, or the decoded bytes.
    owned.forEach((item, index) => {
      try {
        const recorded = copies(item);
        lines.push(`clipboardRequests child[${index}]=${recorded.length}`
          + ` lens=[${recorded.map((value) => value.length).join(",")}]`
          + ` sha256=[${recorded.map((value) => digestOf(value)).join(",")}]`);
      } catch (copyError) {
        lines.push(`clipboardRequests child[${index}]=<unavailable: ${clip(sanitize(String(copyError), tokens), 160)}>`);
      }
    });
    try {
      if (!activePane) {
        lines.push("activePane=none");
      } else {
        const owner = paneOwners.get(activePane);
        lines.push(`activePane=${paneLabels.get(activePane) ?? "unlabelled"}`
          + ` ownerPid=${owner ? owner.handle.pid : "none"}`
          + ` ownerExited=${owner ? owner.exited : "none"}`);
        const visible = safeFrame(activePane).split("\n");
        lines.push(`visibleTail=${Math.min(SUMMARY_TAIL_LINES, visible.length)}/${visible.length} lines`);
        const markerRows = (needle: string): string => {
          const rows = visible.flatMap((line, row) => (line.includes(needle) ? [row] : []));
          return rows.length === 0 ? "0" : `${rows.length}@${rows[0]}`;
        };
        lines.push(`visibleMarkers editorEcho=${markerRows("/copy-proof")} displayMessage=${markerRows("copy-proof-")}`
          + ` clipA=${markerRows("CLIP466-A")} clipB=${markerRows("CLIP466-B")}`
          + ` unknownCommand=${markerRows("Unknown command")} noApiKey=${markerRows("No API key")}`);
        for (const line of visible.slice(-SUMMARY_TAIL_LINES)) {
          lines.push(`  | ${clip(sanitize(line, tokens), SUMMARY_LINE_LIMIT)}`);
        }
      }
    } catch (paneError) {
      lines.push(`activePane=<unavailable: ${clip(sanitize(String(paneError), tokens), 160)}>`);
    }
    // Positions in the owned child's raw stream are the safest remaining signal:
    // they answer "was the input echoed", "did the fixture command run" and "did
    // the pane ever hold the marker" without retaining any raw byte.
    try {
      const target = (activePane ? paneOwners.get(activePane) : undefined) ?? owned.at(-1);
      if (!target) {
        lines.push("probeIndices=none");
      } else {
        const raw = target.raw;
        lines.push(`probeIndices child[${owned.indexOf(target)}]`
          + ` startupQueries="${marker(raw, "\x1b[?u")}/${marker(raw, "\x1b[>0q")}`
          + `/${marker(raw, "\x1b[6n")}/${marker(raw, "\x1b]10;?")}"`
          + ` editorEcho=${marker(raw, "/copy-proof")} displayMessage=${marker(raw, "copy-proof-")}`
          + ` clipA=${marker(raw, "CLIP466-A")} clipB=${marker(raw, "CLIP466-B")}`
          + ` unknownCommand=${marker(raw, "Unknown command")} noApiKey=${marker(raw, "No API key")}`
          + ` osc52Output=${marker(raw, "\x1b]52;c;")} capsule777=${marker(raw, "\x1b]777;")}`);
      }
    } catch (probeError) {
      lines.push(`probeIndices=<unavailable: ${clip(sanitize(String(probeError), tokens), 160)}>`);
    }
    return boundDiagnosticText(lines.join("\n"), tokens, SUMMARY_CHAR_LIMIT);
  };
  // The manager disposes each exited row's own surface, and the teardown below
  // still disposes every retained pane. That double teardown stays safe by
  // construction: `TerminalSurface.dispose()` begins with `if (this.disposed)
  // return;` (src/session-host/terminal-surface.ts). Verified behaviourally here,
  // so a future non-idempotent dispose cannot silently break retained evidence.
  const disposeProbe = new TerminalSurface(4, 2);
  disposeProbe.dispose();
  disposeProbe.dispose();
  try {
    proofWatcher = watch(root, { persistent: false }, () => signal.notify());
    proofWatcher.on("error", (error) => { proofWatchError = error; signal.notify(); });
    at("standalone", "spawn");
    const direct = spawn(cli, args, common, join(root, "work"));
    const directSurface = new TerminalSurface(80, 30, { onReply: (data) => direct.handle.write(data), onChange: () => signal.notify() });
    trackPane("standalone", directSurface, direct);
    direct.handle.onData((data) => directSurface.write(data));
    await signal.waitForRecheck(() => text(directSurface).includes("─".repeat(20)) && readyForCopy(direct), 20_000,
      at("standalone", "native editor with public startup and observed copy isolation", directSurface));
    direct.handle.write("/copy-proof\r");
    await signal.waitFor(() => text(directSurface).includes("CLIP466-B"), 20_000, at("standalone", "native synthetic text", directSurface));
    select(directSurface, (data) => direct.handle.write(data));
    await signal.waitFor(() => copies(direct).length === 1, 20_000, at("standalone", "native clipboard request", directSurface));
    assert.equal(helperRecords().length, 1);
    const expected = copies(direct)[0]!;
    assert.equal(Buffer.from(expected, "base64").toString("utf8"), "CLIP466-A αβ café\n CLIP466-B 雪 end");
    direct.handle.write("/proof-exit\r");
    await signal.waitFor(() => direct.exited, 20_000, at("standalone", "owned exit", directSurface));

    broker = await createStatusBroker({ socketRoot: join(root, "broker") });
    at("hosted", "spawn");
    const delivered: NativeClipboardEvent[] = [];
    let hosted: (typeof owned)[number] | undefined;
    manager = new InstanceManager({ packageRoot: candidate.root, piExecutable: cli, statusRegistrar: broker,
      profileRegistry: new NativeAgentRegistry({ env: common }), nativeSetup: true, env: common, args, cols: 80, rows: 30,
      onChange: () => signal.notify(), onNativeClipboard: (_id, event) => { delivered.push(event); signal.notify(); },
      ptyFactory: (descriptor) => { hosted = spawn(descriptor.file, descriptor.args, descriptor.env, descriptor.cwd); return hosted.handle; },
    });
    const id = await manager.create({ workspace: join(root, "work") });
    const surface = manager.surface(id)!;
    trackPane("hosted", surface, hosted);
    const write = (data: string): void => copyKey(surface, (packet) => manager!.write(id, packet), data);
    await signal.waitForRecheck(() => text(surface).includes("─".repeat(20)) && readyForCopy(hosted!), 20_000,
      at("hosted", "editor with public startup and observed copy isolation", surface));
    write("/copy-proof\r");
    await signal.waitFor(() => text(surface).includes("CLIP466-B"), 20_000, at("hosted", "synthetic text", surface));
    select(surface, write);
    await signal.waitFor(() => delivered.some((event) => event.kind === "copy"), 20_000, at("hosted", "production parser/manager native request", surface));
    assert.deepEqual(copies(hosted!), [expected]);
    assert.equal(helperRecords().length, 2, "one unchanged local helper call per native copy");
    assert.equal(hosted!.raw.includes("\x1b]52;c;"), false, "no raw clipboard passthrough in hosted output");
    assert.equal(text(surface).includes(expected), false, "no capsule or encoded content rendered");

    const refusals = (): number => events(hosted!).filter((event) => event.kind === "unavailable").length
      + hosted!.raw.split(`\x1b]52;c;${decoy}\x07`).length - 1;
    write("/copy-decoy\r");
    await signal.waitFor(() => refusals() > 0, 20_000, at("hosted", "raw decoy actually emitted and refused", surface));
    await surface.flush();
    assert.deepEqual(copies(hosted!), [expected], "a user-input timing window grants nothing to arbitrary output");
    assert.ok(!text(surface).includes(decoy), "refused raw output is not printable screen text");
    const beforeRender = refusals();
    write("/copy-render-decoy\r");
    await signal.waitFor(() => refusals() > beforeRender, 20_000, at("hosted", "render-path decoy actually emitted and refused", surface));
    // Select again with the decoy widget live: source provenance, not first/last
    // write ordering, must preserve the genuine native producer exactly once.
    await surface.flush();
    select(surface, write);
    await signal.waitFor(() => copies(hosted!).length === 2, 20_000, at("hosted", "genuine native request survives in-scope render decoys", surface));
    assert.deepEqual(copies(hosted!), [expected, expected]);
    assert.equal(helperRecords().length, 3);
    const shutdown = await manager.shutdown({ graceMs: 8000, killMs: 2000 });
    assert.deepEqual(shutdown.remainingIds, []);
    assert.deepEqual(shutdown.forcedIds, []);
    await signal.waitFor(() => hosted!.exited, 5000, at("hosted", "owned exit", surface));
    await manager.dispose();
    manager = undefined;

    // Native settings/keybinding are read by each fresh owned child. No setting
    // is mirrored or changed by the bridge, and no real agent root is touched.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ fullscreenCopyOnSelect: false }), { mode: 0o600 });
    writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.message.copy": "f6" }), { mode: 0o600 });
    for (const remote of [true, false]) {
      const leg = `fresh-native(remote=${remote})`;
      at(leg, "spawn");
      const env = { ...common };
      if (!remote) delete env.SSH_CONNECTION;
      let child: (typeof owned)[number] | undefined;
      const received: NativeClipboardEvent[] = [];
      manager = new InstanceManager({ packageRoot: candidate.root, piExecutable: cli, statusRegistrar: broker,
        profileRegistry: new NativeAgentRegistry({ env }), nativeSetup: true, env, args, cols: 80, rows: 30,
        onChange: () => signal.notify(), onNativeClipboard: (_id, event) => { received.push(event); signal.notify(); },
        ptyFactory: (descriptor) => { child = spawn(descriptor.file, descriptor.args, descriptor.env, descriptor.cwd); return child.handle; },
      });
      const row = await manager.create({ workspace: join(root, "work") });
      const pane = manager.surface(row)!;
      trackPane(leg, pane, child);
      const input = (data: string): void => copyKey(pane, (packet) => manager!.write(row, packet), data);
      await signal.waitForRecheck(() => text(pane).includes("─".repeat(20)) && readyForCopy(child!), 20_000,
        at(leg, "fresh native editor with public startup and observed copy isolation", pane));
      input("/copy-proof\r");
      // The original CLIP466-B condition keeps its unchanged 20 000 ms budget, no
      // retry, and no added readiness heuristic (the preceding wait now requires
      // the positive public startup/isolation receipt). Observing an owned child exit or
      // an error row INSIDE that same wait turns a would-be full-timeout into an
      // early, distinct failure carrying the liveness facts instead of burning
      // the budget on a silent row.
      await signal.waitFor(() => text(pane).includes("CLIP466-B") || child!.exited
        || manager!.list().find((view) => view.id === row)?.lifecycle === "error",
        20_000, at(leg, "fresh native selection text", pane));
      const selectionRow = manager!.list().find((view) => view.id === row);
      assert.ok(text(pane).includes("CLIP466-B"), `${leg}: fresh native selection text was not observed within the unchanged 20000 ms budget`
        + ` (childExited=${child!.exited} childExitCode=${child!.exitCode === undefined ? "none" : child!.exitCode}`
        + ` row=${selectionRow?.lifecycle ?? "unknown"}`
        + `${selectionRow?.error ? ` rowError=${JSON.stringify(clip(sanitize(selectionRow.error, knownTokens()), 160))}` : ""})`);
      const before = helperRecords().length;
      select(pane, input);
      await signal.waitForQuiet(() => helperRecords().length > before || copies(child!).length > 0, 200,
        at(leg, "copy-on-select off leaves the clipboard untouched on release", pane));
      input("\x1b[17~"); // live-remapped app.message.copy, not a hardcoded Ctrl+X
      await signal.waitFor(() => helperRecords().length === before + 1, 20_000, at(leg, "configured native copy uses the original helper once", pane));
      if (remote) {
        await signal.waitFor(() => received.some((event) => event.kind === "copy"), 20_000, at(leg, "configured key routes native SSH copy", pane));
        assert.deepEqual(copies(child!), [expected]);
        const epoch = manager.list().find((view) => view.id === row)!.nativeSession!.epoch;
        input("/reload\r");
        await signal.waitFor(() => (manager!.list().find((view) => view.id === row)?.nativeSession?.epoch ?? 0) > epoch,
          20_000, at(leg, "reload advances the authoritative native epoch", pane));
        input("/copy-proof\r");
        await signal.waitFor(() => text(pane).includes("copy-proof-2") && text(pane).includes("CLIP466-B"), 20_000, at(leg, "fresh reloaded native selection frame", pane));
        await pane.flush();
        select(pane, input);
        input("\x1b[17~");
        await signal.waitFor(() => copies(child!).length === 2, 20_000, at(leg, "one process-owned bridge survives extension reload", pane));
        assert.deepEqual(copies(child!), [expected, expected]);
        assert.equal(helperRecords().length, before + 2);
      } else {
        await signal.waitForQuiet(() => received.length > 0 || /\x1b\](?:52;c;|777;)/.test(child!.raw), 200,
          at(leg, "ordinary local helper-only copy produces no terminal request", pane));
      }
      assert.equal(helperRecords().at(-1), Buffer.from(expected, "base64").toString("utf8"));
      const stopped = await manager.shutdown({ graceMs: 8000, killMs: 2000 });
      assert.deepEqual(stopped.remainingIds, []);
      assert.deepEqual(stopped.forcedIds, []);
      await signal.waitFor(() => child!.exited, 5000, at(leg, "fresh owned child exit", pane));
      await manager.dispose();
      manager = undefined;
    }
    // -------------------------------------------------------------------------
    // Opt-in native input framing: one explicitly opted-in LOCAL hosted child
    // (no SSH, no viewer/remote input anywhere in this phase). Real bundled CLI,
    // real PTY, real broker, real manager, real preload, and real strict child
    // bridge. This proves: the child authenticates its decoder installation
    // BEFORE its own startup queries; the supported static capture flag reaches
    // only this launch; EVERY host write on both existing sources travels as an
    // authenticated framed dispatch of this registration (user input `local`,
    // protocol replies never `local`); Unicode and a paste larger than the
    // 32 KiB fragment bound survive byte-exactly as one logical dispatch; a
    // geometry change and an extension reload keep the same per-registration
    // framing with a monotonic sequence; native copies still reach the unchanged
    // host route and the unchanged local helper exactly once, with only explicit
    // `local` receipts; and nothing framing-related, no token, and no raw
    // clipboard relay ever reaches the screen or the child's output stream. The
    // earlier legs stay as the untouched legacy controls. No physical clipboard,
    // real terminal emulator, or Windows ConPTY claim is made.
    // -------------------------------------------------------------------------
    const framedEnv: NodeJS.ProcessEnv = { ...common };
    at("framed", "spawn");
    delete framedEnv.SSH_CONNECTION; // local-only leg: no remote origin is implied
    const framedWrites: string[] = [];
    const framedReceived: NativeClipboardEvent[] = [];
    let framedChild: (typeof owned)[number] | undefined;
    let framedSpawnEnv: NodeJS.ProcessEnv | undefined;
    framedManager = new InstanceManager({ packageRoot: candidate.root, piExecutable: cli, statusRegistrar: broker,
      profileRegistry: new NativeAgentRegistry({ env: framedEnv }), nativeSetup: true, nativeInputOriginFraming: true,
      env: framedEnv, args, cols: 80, rows: 30,
      onChange: () => signal.notify(), onNativeClipboard: (_id, event) => { framedReceived.push(event); signal.notify(); },
      ptyFactory: (descriptor) => {
        framedSpawnEnv = descriptor.env;
        framedChild = spawn(descriptor.file, descriptor.args, descriptor.env, descriptor.cwd);
        const handle = framedChild.handle;
        // A recording view of the SAME owned handle: the host's own PTY writes are
        // the wire under test, and nothing else about the child changes.
        return {
          get pid(): number { return handle.pid; },
          get cols(): number { return handle.cols; },
          get rows(): number { return handle.rows; },
          onData: (listener) => handle.onData(listener),
          onExit: (listener) => handle.onExit(listener),
          on: (event, listener) => handle.on?.(event, listener),
          removeListener: (event, listener) => handle.removeListener?.(event, listener),
          write: (data) => { framedWrites.push(typeof data === "string" ? data : data.toString("latin1")); handle.write(data); },
          resize: (columns, rows) => handle.resize(columns, rows),
          kill: (sig) => handle.kill(sig),
          pause: () => handle.pause(),
          resume: () => handle.resume(),
        };
      },
    });
    const framedId = await framedManager.create({ workspace: join(root, "work") });
    const framedPane = framedManager.surface(framedId)!;
    trackPane("framed", framedPane, framedChild);
    const framedInput = (data: string): void => copyKey(framedPane, (packet) => framedManager!.write(framedId, packet), data);
    assert.ok(framedChild && framedChild.bootstrap, "the opted-in row owns its child and bootstrap");
    const framedBootstrap = framedChild.bootstrap;
    assert.equal(framedChild.bootstrap.inputOriginFraming, 1, "the closed mode reached the actual one-shot bootstrap");
    assert.equal(framedSpawnEnv?.PI_CLIPBOARD_OSC52, "1", "only this opted-in launch gained the static capture flag");
    await signal.waitForRecheck(() => text(framedPane).includes("─".repeat(20)) && readyForCopy(framedChild!), 20_000,
      at("framed", "opted-in native editor with public startup and observed copy isolation", framedPane));
    await signal.waitFor(() => framedChild!.raw.includes("\x1b]777;prg-native-input-ready-v1;"), 20_000,
      at("framed", "the strict child authenticated its decoder installation", framedPane));
    const readyAt = framedChild.raw.indexOf("\x1b]777;prg-native-input-ready-v1;");
    const firstStartupQuery = Math.min(...["\x1b[?u", "\x1b[>0q", "\x1b[6n", "\x1b]10;?"].map((probe) => {
      const at = framedChild!.raw.indexOf(probe);
      return at < 0 ? Number.POSITIVE_INFINITY : at;
    }));
    assert.ok(readyAt < firstStartupQuery,
      "readiness precedes the child's own startup queries, so no protocol reply can be typed unframed");
    let framedVerifiedReady = 0;
    const verifyReady = createNativeClipboardReceiver(framedBootstrap, () => undefined, undefined,
      () => { framedVerifiedReady += 1; });
    for (const match of framedChild.raw.matchAll(/\x1b\]777;([^\x07]*)\x07/g)) verifyReady(match[1]!);
    assert.equal(framedVerifiedReady, 1, "exactly one readiness statement verifies against this registration");

    // Every host write is a framed dispatch of THIS registration, decoded here by
    // an independent decoder built from the same bootstrap.
    const framedDecoder = createNativeInputDecoder(framedBootstrap);
    let decodedThrough = 0;
    const allFrames: NativeInputFragment[] = [];
    const drainFrames = (): NativeInputFragment[] => {
      const fragments: NativeInputFragment[] = [];
      for (; decodedThrough < framedWrites.length; decodedThrough += 1) {
        const fed = framedDecoder.feed(framedWrites[decodedThrough]!);
        assert.equal(fed.ok, true, `every host write authenticates against this registration: ${fed.ok ? "" : fed.code}`);
        fragments.push(...fed.fragments);
      }
      allFrames.push(...fragments);
      return fragments;
    };
    const dispatchPayload = (fragments: readonly NativeInputFragment[], dispatchId: number): string =>
      Buffer.concat(fragments.filter((f) => f.dispatchId === dispatchId).map((f) => f.payload)).toString("utf8");
    assert.ok(framedWrites.every((frame) => frame.startsWith("prg-ni-v1;")),
      "no host byte ever reached this child unframed");

    // Ordinary input, then the unchanged native copy route and helper.
    framedInput("/copy-proof\r");
    await signal.waitFor(() => text(framedPane).includes("CLIP466-B"), 20_000, at("framed", "opted-in synthetic text", framedPane));
    const proofFrames = drainFrames();
    const proofDispatch = proofFrames.at(-1)!;
    assert.deepEqual(proofDispatch.origin, { kind: "local" }, "local user input is classified local");
    assert.equal(dispatchPayload(proofFrames, proofDispatch.dispatchId), "/copy-proof\r",
      "the typed payload travels byte-exactly inside the frame");
    const framedHelperBefore = helperRecords().length;
    await framedPane.flush();
    select(framedPane, framedInput);
    framedInput("\x1b[17~"); // the configured native copy key, unchanged from the legacy control
    await signal.waitFor(() => framedReceived.some((event) => event.kind === "copy"), 20_000,
      at("framed", "a strict row still routes its native copy through the existing host route", framedPane));
    assert.equal(helperRecords().length, framedHelperBefore + 1, "the unchanged native helper ran exactly once");
    assert.equal(helperRecords().at(-1), Buffer.from(expected, "base64").toString("utf8"),
      "the local payload handed to the helper is unchanged");

    // An extension reload keeps the same per-registration framing: the sequence
    // continues and copies still route, with no second bridge and no reset.
    const framedEpoch = framedManager.list().find((view) => view.id === framedId)!.nativeSession!.epoch;
    framedInput("/reload\r");
    await signal.waitFor(() => (framedManager!.list().find((view) => view.id === framedId)?.nativeSession?.epoch ?? 0) > framedEpoch,
      20_000, at("framed", "reload advanced the authoritative native epoch", framedPane));
    framedInput("/copy-proof\r");
    await signal.waitFor(() => text(framedPane).includes("copy-proof-2") && text(framedPane).includes("CLIP466-B"),
      20_000, at("framed", "fresh reloaded native selection frame", framedPane));
    await framedPane.flush();
    select(framedPane, framedInput);
    framedInput("\x1b[17~");
    await signal.waitFor(() => framedReceived.filter((event) => event.kind === "copy").length === 2, 20_000,
      at("framed", "one process-owned bridge and encoder survive extension reload", framedPane));
    const afterReload = drainFrames();
    assert.ok(afterReload.length > 0, "the reloaded row kept framing input");
    assert.ok(Math.min(...afterReload.map((f) => f.dispatchId)) > proofDispatch.dispatchId,
      "the per-registration dispatch id kept increasing across the reload and never restarted");
    const seenDispatches = allFrames.map((f) => f.dispatchId).filter((id, index, ids) => ids.indexOf(id) === index);
    assert.deepEqual(seenDispatches, [...seenDispatches].sort((a, b) => a - b),
      "dispatch ids only ever increase for one registration");
    assert.equal(helperRecords().length, framedHelperBefore + 2, "the reloaded child still uses the helper once per copy");

    // Unicode input and a paste above the fragment bound stay byte-exact. The
    // host-side fragment checks prove what the host PUT on the wire; the fixture's
    // public `/input-proof` command digests what the REAL child RECEIVED, so PTY
    // truncation, a poisoned child decoder, or discarded paste bytes cannot pass
    // this case. No producer hook, no Pi change: only the fixture's own command.
    const unicodeText = "αβ café 雪 — ünïcödé";
    const unicode = `\x1b[200~/input-proof ${unicodeText}\x1b[201~`;
    framedInput(unicode);
    await signal.waitFor(() => text(framedPane).includes("ünïcödé"), 20_000, at("framed", "the opted-in child received Unicode input", framedPane));
    const unicodeFrames = drainFrames();
    const unicodeDispatch = unicodeFrames.at(-1)!;
    assert.deepEqual(unicodeDispatch.origin, { kind: "local" });
    assert.equal(dispatchPayload(unicodeFrames, unicodeDispatch.dispatchId), unicode,
      "multibyte input is preserved exactly, never re-encoded or split into text");
    framedInput("\r");
    const unicodeMarker = `INPUT466:${createHash("sha256").update(unicodeText, "utf8").digest("hex")}`;
    await signal.waitFor(() => text(framedPane).replace(/\s/g, "").includes(unicodeMarker), 20_000,
      at("framed", "the native command received the complete Unicode payload and cleared the editor", framedPane));

    // Geometry stays the manager's own, and the seam keeps framing afterwards.
    assert.ok(framedManager.resizeInstance(framedId, 100, 32), "the opted-in row accepted a geometry change");
    await signal.waitFor(() => framedPane.frame().cols === 100 && framedPane.frame().rows === 32, 20_000,
      at("framed", "the opted-in surface reflowed to the admitted geometry", framedPane));
    const bigText = "雪".repeat(30_000);
    const big = `\x1b[200~/input-proof ${bigText}\x1b[201~`; // ~90 KiB, above the 32 KiB fragment bound
    framedInput(big);
    const bigFrames = drainFrames();
    const bigDispatch = bigFrames.at(-1)!;
    const bigParts = bigFrames.filter((f) => f.dispatchId === bigDispatch.dispatchId);
    assert.ok(bigParts.length > 2, "a paste above the fragment bound travels as ordered fragments");
    assert.equal(bigParts[0]!.start, true, "the first fragment opens the dispatch");
    assert.equal(bigParts.at(-1)!.end, true, "the last fragment closes it");
    assert.deepEqual(bigParts.map((f) => f.part), bigParts.map((_f, index) => index), "fragments stay in order");
    assert.equal(dispatchPayload(bigFrames, bigDispatch.dispatchId), big,
      "the whole paste survives byte-exactly as one logical dispatch");
    framedInput("\r");
    const bigMarker = `INPUT466:${createHash("sha256").update(bigText, "utf8").digest("hex")}`;
    await signal.waitFor(() => text(framedPane).replace(/\s/g, "").includes(bigMarker), 20_000,
      at("framed", "the real child received the complete large paste byte-exactly", framedPane));
    assert.equal(framedManager.list().find((view) => view.id === framedId)!.lifecycle, "alive",
      "the opted-in row survived framing a large paste");
    assert.ok(framedWrites.every((frame) => frame.startsWith("prg-ni-v1;")),
      "still no unframed host byte after geometry, reload, and paste");

    // Strict mode emits origin-bearing v2 receipts only, and every delivered copy
    // says explicitly that it came from local input.
    const framedReceipts: NativeClipboardOriginEvent[] = [];
    const receiveFramed = createNativeClipboardReceiver(framedBootstrap, () => undefined,
      (receipt) => { framedReceipts.push(receipt); });
    for (const match of framedChild.raw.matchAll(/\x1b\]777;([^\x07]*)\x07/g)) receiveFramed(match[1]!);
    assert.equal(framedReceipts.length, 2, "both native copies arrived as v2 receipts");
    assert.ok(framedReceipts.every((receipt) => receipt.origin.kind === "local"),
      "every framed copy receipt is explicitly local");
    assert.ok(framedChild.raw.includes("prg-native-copy-v2;"), "the opted-in child used the v2 stream");
    assert.ok(!framedChild.raw.includes("prg-native-copy-v1;"), "a strict row never emits or accepts a v1 capsule");
    assert.ok(!framedChild.raw.includes("\x1b]52;c;"), "no raw clipboard relay leaves the opted-in child");
    assert.ok(!text(framedPane).includes("prg-ni-v1") && !text(framedPane).includes("prg-native-"),
      "framing and readiness never become screen text");
    assert.ok(!text(framedPane).includes(framedBootstrap.token), "the registration token never reaches the frame");
    assert.ok(!framedChild.raw.includes(framedBootstrap.token), "the token never returns in the child's output");
    // Legacy controls stay exactly as the earlier legs left them.
    assert.ok(hosted!.raw.includes("prg-native-copy-v1;"), "the legacy hosted control child still used v1");
    assert.ok(!hosted!.raw.includes("prg-native-input-ready-v1;"), "the legacy control never claimed framing readiness");

    const framedStop = await framedManager.shutdown({ graceMs: 8000, killMs: 2000 });
    assert.deepEqual(framedStop.remainingIds, []);
    assert.deepEqual(framedStop.forcedIds, []);
    await signal.waitFor(() => framedChild!.exited, 5000, at("framed", "opted-in owned exit", framedPane));
    await framedManager.dispose();
    framedManager = undefined;
    // Genuine registered question/notice tools through Pi's faux provider:
    // native agent-loop turns, no credentials or external model requests.
    writeFileSync(join(root, "provider", "turn-script.json"), JSON.stringify({ steps: [
      { toolCalls: [
        { toolName: "YouShouldKnow", arguments: { title: "Clipboard proof notice", body: "VISIBLE466-A αβ café\n\nVISIBLE466-B 雪 end" } },
        { toolName: "AskUserQuestion", arguments: { question: "VISIBLE466-Q αβ café\n\nVISIBLE466-R 雪 end", choices: ["Safe fixture choice"] } },
      ] }, { text: "ASSISTANT466-A αβ café\nASSISTANT466-B 雪 end" },
    ] }), { mode: 0o600, flag: "wx" });
    const popupEnv = { ...common, PRG_FIXTURE_AGENT_DIR: packageRoot, PRG_FIXTURE_STATE_DIR: join(root, "provider") };
    const popupArgs = [...args, "--extension", join(process.cwd(), "tests", "fixtures", "session-host-native-provider.cjs"),
      "--provider", "prg-native-question", "--model", "driven"];
    // The final leg runs the real public Main API in an OWNED outer PTY.
    // Native input -> child -> authenticated parser -> actual Main display/focus
    // guard -> ProcessTerminal output is exercised end to end, not a mock sink.
    const runner = join(root, "real-main.cjs");
    at("popup", "spawn");
    writeFileSync(runner, `require(${JSON.stringify(join(candidate.root, "dist", "src", "session-host", "main.js"))}).runSessionHost({packageRoot:${JSON.stringify(candidate.root)},piExecutable:${JSON.stringify(cli)},stateRoot:${JSON.stringify(join(root, "broker"))},toggleKey:'f8',args:JSON.parse(process.env.PRG_COPY_MAIN_ARGS),env:process.env}).then(code=>{process.exitCode=code},()=>{process.exitCode=1});`, { mode: 0o600, flag: "wx" });
    let popupChild: (typeof owned)[number] | undefined;
    const popupPane = new TerminalSurface(120, 40, { onReply: (data) => popupChild?.handle.write(data), onChange: () => signal.notify() });
    trackPane("popup", popupPane);
    popupPane.write("PRG-COPY-RESTORE");
    popupChild = spawn(process.execPath, [runner], { ...popupEnv, PRG_COPY_MAIN_ARGS: JSON.stringify(popupArgs) }, join(root, "work"), 120, 40, true);
    paneOwners.set(popupPane, popupChild);
    popupChild.handle.onData((data) => popupPane.write(data));
    const popupInput = (data: string): void => copyKey(popupPane, (packet) => popupChild!.handle.write(packet), data);
    await signal.waitFor(() => text(popupPane).includes("New session"), 20_000, at("popup", "real host welcome", popupPane));
    popupInput("\r");
    await signal.waitFor(() => text(popupPane).includes("Workspace"), 20_000, at("popup", "real host New form", popupPane));
    popupInput(`\x1b[200~${join(root, "work")}\x1b[201~`);
    popupInput("\r");
    await signal.waitForRecheck(() => (text(popupPane).includes("prg-native-question") || text(popupPane).includes("driven"))
      && readyForCopy(popupChild!), 30_000, at("popup", "real native Main with exact native-child startup/isolation", popupPane));
    popupInput("populate synthetic clipboard proof\r");
    await signal.waitFor(() => text(popupPane).includes("ASSISTANT466-B 雪 end") && text(popupPane).includes("Pending input"), 30_000,
      at("popup", "actual registered question and notice tools finish the synthetic turn", popupPane));
    // No mouse selection has yet existed in this fresh child: exercise the
    // native Main fallback without assuming ordinary typing clears selection.
    popupInput("\x1b[17~");
    await signal.waitFor(() => copies(popupChild!).length === 1, 20_000, at("popup", "native Main application-copy fallback preserved", popupPane));
    assert.equal(Buffer.from(copies(popupChild!)[0]!, "base64").toString("utf8"), "ASSISTANT466-A αβ café\nASSISTANT466-B 雪 end");
    // The faux-provider turn already drew the assistant rows in this fresh Main
    // conversation, so select those visible rows directly. Registering another
    // slash command here would exercise native autocomplete and a second model
    // turn instead of the Main copy route under test.
    select(popupPane, popupInput, "ASSISTANT466-A", "ASSISTANT466-B");
    popupInput("\x1b[17~");
    await signal.waitFor(() => copies(popupChild!).length === 2, 20_000,
      at("popup", "actual Main ProcessTerminal emits exactly one clipboard request per copy gesture", popupPane));
    const mainSelected = Buffer.from(copies(popupChild!)[1]!, "base64").toString("utf8");
    // Native selection slices the rendered rows, so the assistant body's own
    // one-column output padding stays on the continuation row.
    assert.equal(mainSelected, "ASSISTANT466-A αβ café\n ASSISTANT466-B 雪 end",
      "the real host forwards the native selection payload with native line padding unchanged");
    assert.equal(helperRecords().at(-1), mainSelected,
      "the unchanged native helper recorded the exact bytes the real outer route forwarded");
    assert.ok(!popupChild!.raw.includes("\x1b]777;"), "private capsules never escape the host");
    const popupBaseline = 2;
    // Leave this live conversation selection in place for the popup-entry fence.
    popupInput("\x1b[1;7A");
    await signal.waitFor(() => text(popupPane).includes("open question/notice"), 20_000, at("popup", "shared pending list actually drawn and focused", popupPane));
    popupInput("\r");
    const pairs = [["VISIBLE466-A", "VISIBLE466-B"], ["VISIBLE466-Q", "VISIBLE466-R"]] as const;
    const region = (): { top: number; bottom: number; pair: (typeof pairs)[number] } | undefined => {
      const lines = popupPane.frame().lines.map(stripGeneratedSgr);
      const rule = "─".repeat(87); // actual native pane: 120 - sidebar32 - divider1
      for (let top = 1; top < lines.length; top += 1) {
        if (lines[top]!.slice(33) !== rule) continue;
        const bottom = lines.findIndex((line, row) => row > top && line.slice(33) === rule);
        if (bottom <= top) continue;
        const body = lines.slice(top + 1, bottom).join("\n");
        const pair = pairs.find(([first, last]) => body.includes(first) && body.includes(last));
        const detailView = body.includes("Safe fixture choice") || (body.includes("More details") && body.includes("Close"));
        if (pair && detailView) return { top, bottom, pair };
      }
      return undefined;
    };
    const shown = new Set<string>();
    for (let index = 0; index < 2; index += 1) {
      await signal.waitFor(() => region() !== undefined, 20_000, at("popup", "visible framed question or notice body", popupPane));
      await popupPane.flush();
      const visible = region()!;
      shown.add(visible.pair[0]);
      const before = helperRecords().length;
      popupInput("\x1b[17~");
      await signal.waitForQuiet(() => helperRecords().length > before || copies(popupChild!).length > index + popupBaseline, 200,
        at("popup", "popup entry rejects inherited hidden-conversation selection", popupPane));
      select(popupPane, popupInput, visible.pair[0], visible.pair[1], visible.top, visible.bottom);
      popupInput("\x1b[17~");
      await signal.waitFor(() => copies(popupChild!).length === index + popupBaseline + 1, 20_000, at("popup", "real visible-popup copy reaches outer terminal", popupPane));
      const payload = Buffer.from(copies(popupChild!)[index + popupBaseline]!, "base64").toString("utf8");
      assert.ok(payload.includes(`${visible.pair[0]} αβ café`) && payload.includes(`${visible.pair[1]} 雪 end`));
      assert.ok(!payload.includes("CLIP466") && !payload.includes("ASSISTANT466"), "never copy hidden conversation rows");
      assert.equal(helperRecords().length, before + 1);
      assert.equal(payload, helperRecords().at(-1), "exact native producer payload reaches the real outer route unchanged");
      if (index === 0) {
        popupInput("\x1b");
        await signal.waitFor(() => text(popupPane).includes("open question/notice") && region() === undefined, 20_000, at("popup", "back to drawn pending list", popupPane));
        // Re-enter the shared popup so its existing entry fence applies. Do
        // not invent a new selection-reset policy for in-popup view changes.
        popupInput("\x1b");
        await signal.waitFor(() => !text(popupPane).includes("open question/notice") && region() === undefined, 20_000, at("popup", "shared popup closed", popupPane));
        popupInput("\x1b[1;7A");
        await signal.waitFor(() => text(popupPane).includes("open question/notice"), 20_000, at("popup", "fresh shared popup entry", popupPane));
        popupInput("\x1b[B"); popupInput("\r");
      }
    }
    assert.equal(shown.size, 2, "both foreground question and notice surfaces exercised");
    popupInput("\x1b[19~"); // host F8: focus roster, not a native copy gesture
    popupInput("q");
    await signal.waitFor(() => text(popupPane).includes("Quit host?"), 20_000, at("popup", "real host Quit confirmation", popupPane));
    popupInput("y");
    await signal.waitFor(() => popupChild!.exited && text(popupPane).includes("PRG-COPY-RESTORE")
      && popupPane.inputModes().mouseTracking === "none", 20_000, at("popup", "original real host exits and restores its terminal after owned children settle", popupPane));
    await popupPane.flush();
    assert.ok(!existsSync(hostOwnershipPath(agentDir)), "production ownership release requires child-exit settlement");
    assert.match(text(popupPane), /PRG-COPY-RESTORE/, "original outer terminal screen restored");
    assert.equal(popupPane.inputModes().mouseTracking, "none");
    assert.ok(owned.every((item) => item.exitCode === 0));
    // Deliberately no assertion about a physical terminal or OS clipboard.
  } catch (error) {
    const artifact = join(root, "failure.json");
    try {
      writeFileSync(artifact, JSON.stringify({ error: String(error), helpers: helperRecords(),
        frames: surfaces.map(safeFrame), outputs: owned.map((item) => ({ exited: item.exited, raw: item.raw.slice(-262144) })) }),
      { mode: 0o600, flag: "wx" });
    } catch { /* Preserve the original assertion and still settle owned children. */ }
    // The artifact root is ephemeral and nothing collects it, so the bounded
    // summary is what CI actually retains. Each fault here is contained: the
    // original tester error is rethrown below and cleanup still runs.
    try {
      const summary = buildFailureSummary(error);
      process.stderr.write(`[native-clipboard-routing failure evidence] artifact=${artifact}\n${summary}\n`);
    } catch {
      try { process.stderr.write(`[native-clipboard-routing failure evidence] artifact=${artifact} (summary unavailable)\n`); } catch { /* never mask */ }
    }
    throw error;
  } finally {
    proofWatcher?.close();
    if (manager) await manager.shutdown({ graceMs: 2000, killMs: 2000 });
    for (const item of owned) {
      if (!item.exited) {
        item.handle.kill("SIGTERM");
        await signal.waitFor(() => item.exited, 5000, at("teardown", "owned fixture cleanup exit"));
      }
    }
    if (manager) await manager.dispose();
    if (framedManager) await framedManager.shutdown({ graceMs: 2000, killMs: 2000 });
    if (framedManager) await framedManager.dispose();
    if (broker) await broker.dispose();
    for (const surface of surfaces) surface.dispose();
    // Retain invocation-owned synthetic evidence; never remove unconfirmed or
    // unknown files, and never scan/clean user sessions or unselected trees.
    assert.ok(owned.every((item) => item.exited));
  }
});
