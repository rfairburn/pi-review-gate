import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { createStatusBroker } from "../src/session-host/broker";
import { hostOwnershipPath } from "../src/session-host/roster-store";
import { InstanceManager, type InstancePty } from "../src/session-host/instances";
import { NativeAgentRegistry } from "../src/session-host/profiles";
import { createNativeClipboardReceiver, type NativeClipboardEvent } from "../src/session-host/native-clipboard";
import { TerminalSurface, stripGeneratedSgr } from "../src/session-host/terminal-surface";
import type { SessionHostBootstrap } from "../src/session-host/protocol";
import { ChangeSignal, compileAndStageCandidate, makeNativeAgentRoot } from "./helpers/session-host-native-main-harness";
import { findInstalledAgentDirs } from "./menu-tui-fakes";
import { skipOrFail } from "./bridge-fakes";

/** Real bundled CLI/PTY proof. No physical clipboard is read or written. */
test("real bundled native and hosted clipboard producers preserve selected payload and reject raw output", { timeout: 180_000 }, async (t) => {
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
  for (const name of ["pbcopy", "xclip", "xsel", "wl-copy", "termux-clipboard-set"]) {
    writeFileSync(join(root, "bin", name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(recorder)}\n`, { mode: 0o700, flag: "wx" });
  }
  const preload = join(root, "block-native-clipboard.cjs");
  writeFileSync(preload, `const dlopen=process.dlopen;process.dlopen=function(mod,file,...args){if(/(?:darwin|win32|linux)-platform(?:-x11)?\\.node$/.test(file))throw Error('owned fixture blocks OS clipboard');return dlopen.call(this,mod,file,...args)};`, { mode: 0o600, flag: "wx" });
  const fixture = join(root, "clipboard-proof.cjs");
  const decoy = Buffer.from("UNSOLICITED-466").toString("base64");
  writeFileSync(fixture, `module.exports=pi=>{
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
  };
  const args = ["--offline", "--no-context-files", "--no-skills", "--no-themes", "--no-extensions", "--extension", fixture, "--tui-mode", "fullscreen"];
  const owned: Array<{ handle: InstancePty; exited: boolean; raw: string; exitCode?: number; bootstrap?: SessionHostBootstrap }> = [];
  const spawn = (file: string, argv: string[], env: NodeJS.ProcessEnv, cwd: string, cols = 80, rows = 30): (typeof owned)[number] => {
    const handle = pty.spawn(file, argv, { name: "xterm-ghostty", cols, rows, cwd, env, encoding: "utf8" });
    const item: (typeof owned)[number] = { handle, exited: false, raw: "", ...(env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP
      ? { bootstrap: JSON.parse(env.PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP) as SessionHostBootstrap } : {}) };
    owned.push(item); // ownership before callbacks/awaits
    handle.onExit((event) => { item.exited = true; item.exitCode = event.exitCode; signal.notify(); });
    handle.onData((data) => { item.raw += data; signal.notify(); });
    return item;
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
  const surfaces: TerminalSurface[] = [];
  try {
    const direct = spawn(cli, args, common, join(root, "work"));
    const directSurface = new TerminalSurface(80, 30, { onReply: (data) => direct.handle.write(data), onChange: () => signal.notify() });
    surfaces.push(directSurface);
    direct.handle.onData((data) => directSurface.write(data));
    await signal.waitFor(() => text(directSurface).includes("─".repeat(20)), 20_000, "native editor");
    direct.handle.write("/copy-proof\r");
    await signal.waitFor(() => text(directSurface).includes("CLIP466-B"), 20_000, "native synthetic text");
    select(directSurface, (data) => direct.handle.write(data));
    await signal.waitFor(() => copies(direct).length === 1, 20_000, "standalone native clipboard request");
    assert.equal(helperRecords().length, 1);
    const expected = copies(direct)[0]!;
    assert.equal(Buffer.from(expected, "base64").toString("utf8"), "CLIP466-A αβ café\n CLIP466-B 雪 end");
    direct.handle.write("/proof-exit\r");
    await signal.waitFor(() => direct.exited, 20_000, "standalone owned exit");

    broker = await createStatusBroker({ socketRoot: join(root, "broker") });
    const delivered: NativeClipboardEvent[] = [];
    let hosted: (typeof owned)[number] | undefined;
    manager = new InstanceManager({ packageRoot: candidate.root, piExecutable: cli, statusRegistrar: broker,
      profileRegistry: new NativeAgentRegistry({ env: common }), nativeSetup: true, env: common, args, cols: 80, rows: 30,
      onChange: () => signal.notify(), onNativeClipboard: (_id, event) => { delivered.push(event); signal.notify(); },
      ptyFactory: (descriptor) => { hosted = spawn(descriptor.file, descriptor.args, descriptor.env, descriptor.cwd); return hosted.handle; },
    });
    const id = await manager.create({ workspace: join(root, "work") });
    const surface = manager.surface(id)!;
    const write = (data: string): void => manager!.write(id, data);
    await signal.waitFor(() => text(surface).includes("─".repeat(20)), 20_000, "hosted editor");
    write("/copy-proof\r");
    await signal.waitFor(() => text(surface).includes("CLIP466-B"), 20_000, "hosted synthetic text");
    select(surface, write);
    await signal.waitFor(() => delivered.some((event) => event.kind === "copy"), 20_000, "production parser/manager native request");
    assert.deepEqual(copies(hosted!), [expected]);
    assert.equal(helperRecords().length, 2, "one unchanged local helper call per native copy");
    assert.equal(hosted!.raw.includes("\x1b]52;c;"), false, "no raw clipboard passthrough in hosted output");
    assert.equal(text(surface).includes(expected), false, "no capsule or encoded content rendered");

    const refusals = (): number => events(hosted!).filter((event) => event.kind === "unavailable").length
      + hosted!.raw.split(`\x1b]52;c;${decoy}\x07`).length - 1;
    write("/copy-decoy\r");
    await signal.waitFor(() => refusals() > 0, 20_000, "raw decoy actually emitted and refused");
    await surface.flush();
    assert.deepEqual(copies(hosted!), [expected], "a user-input timing window grants nothing to arbitrary output");
    assert.ok(!text(surface).includes(decoy), "refused raw output is not printable screen text");
    const beforeRender = refusals();
    write("/copy-render-decoy\r");
    await signal.waitFor(() => refusals() > beforeRender, 20_000, "render-path decoy actually emitted and refused");
    // Select again with the decoy widget live: source provenance, not first/last
    // write ordering, must preserve the genuine native producer exactly once.
    await surface.flush();
    select(surface, write);
    await signal.waitFor(() => copies(hosted!).length === 2, 20_000, "genuine native request survives in-scope render decoys");
    assert.deepEqual(copies(hosted!), [expected, expected]);
    assert.equal(helperRecords().length, 3);
    const shutdown = await manager.shutdown({ graceMs: 8000, killMs: 2000 });
    assert.deepEqual(shutdown.remainingIds, []);
    assert.deepEqual(shutdown.forcedIds, []);
    await signal.waitFor(() => hosted!.exited, 5000, "hosted owned exit");
    await manager.dispose();
    manager = undefined;

    // Native settings/keybinding are read by each fresh owned child. No setting
    // is mirrored or changed by the bridge, and no real agent root is touched.
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ fullscreenCopyOnSelect: false }), { mode: 0o600 });
    writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify({ "app.message.copy": "f6" }), { mode: 0o600 });
    for (const remote of [true, false]) {
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
      const input = (data: string): void => manager!.write(row, data);
      await signal.waitFor(() => text(pane).includes("─".repeat(20)), 20_000, "fresh native editor");
      input("/copy-proof\r");
      await signal.waitFor(() => text(pane).includes("CLIP466-B"), 20_000, "fresh native selection text");
      const before = helperRecords().length;
      select(pane, input);
      await signal.waitForQuiet(() => helperRecords().length > before || copies(child!).length > 0, 200,
        "copy-on-select off leaves the clipboard untouched on release");
      input("\x1b[17~"); // live-remapped app.message.copy, not a hardcoded Ctrl+X
      await signal.waitFor(() => helperRecords().length === before + 1, 20_000, "configured native copy uses the original helper once");
      if (remote) {
        await signal.waitFor(() => received.some((event) => event.kind === "copy"), 20_000, "configured key routes native SSH copy");
        assert.deepEqual(copies(child!), [expected]);
        const epoch = manager.list().find((view) => view.id === row)!.nativeSession!.epoch;
        input("/reload\r");
        await signal.waitFor(() => (manager!.list().find((view) => view.id === row)?.nativeSession?.epoch ?? 0) > epoch,
          20_000, "reload advances the authoritative native epoch");
        input("/copy-proof\r");
        await signal.waitFor(() => text(pane).includes("copy-proof-2") && text(pane).includes("CLIP466-B"), 20_000, "fresh reloaded native selection frame");
        await pane.flush();
        select(pane, input);
        input("\x1b[17~");
        await signal.waitFor(() => copies(child!).length === 2, 20_000, "one process-owned bridge survives extension reload");
        assert.deepEqual(copies(child!), [expected, expected]);
        assert.equal(helperRecords().length, before + 2);
      } else {
        await signal.waitForQuiet(() => received.length > 0 || /\x1b\](?:52;c;|777;)/.test(child!.raw), 200,
          "ordinary local helper-only copy produces no terminal request");
      }
      assert.equal(helperRecords().at(-1), Buffer.from(expected, "base64").toString("utf8"));
      const stopped = await manager.shutdown({ graceMs: 8000, killMs: 2000 });
      assert.deepEqual(stopped.remainingIds, []);
      assert.deepEqual(stopped.forcedIds, []);
      await signal.waitFor(() => child!.exited, 5000, "fresh owned child exit");
      await manager.dispose();
      manager = undefined;
    }
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
    writeFileSync(runner, `require(${JSON.stringify(join(candidate.root, "dist", "src", "session-host", "main.js"))}).runSessionHost({packageRoot:${JSON.stringify(candidate.root)},piExecutable:${JSON.stringify(cli)},stateRoot:${JSON.stringify(join(root, "broker"))},toggleKey:'f8',args:JSON.parse(process.env.PRG_COPY_MAIN_ARGS),env:process.env}).then(code=>{process.exitCode=code},()=>{process.exitCode=1});`, { mode: 0o600, flag: "wx" });
    let popupChild: (typeof owned)[number] | undefined;
    const popupPane = new TerminalSurface(120, 40, { onReply: (data) => popupChild?.handle.write(data), onChange: () => signal.notify() });
    surfaces.push(popupPane);
    popupPane.write("PRG-COPY-RESTORE");
    popupChild = spawn(process.execPath, [runner], { ...popupEnv, PRG_COPY_MAIN_ARGS: JSON.stringify(popupArgs) }, join(root, "work"), 120, 40);
    popupChild.handle.onData((data) => popupPane.write(data));
    const popupInput = (data: string): void => popupChild!.handle.write(data);
    await signal.waitFor(() => text(popupPane).includes("New session"), 20_000, "real host welcome");
    popupInput("\r");
    await signal.waitFor(() => text(popupPane).includes("Workspace"), 20_000, "real host New form");
    popupInput(`\x1b[200~${join(root, "work")}\x1b[201~`);
    popupInput("\r");
    await signal.waitFor(() => text(popupPane).includes("prg-native-question") || text(popupPane).includes("driven"), 30_000, "real native Main");
    popupInput("populate synthetic clipboard proof\r");
    await signal.waitFor(() => text(popupPane).includes("ASSISTANT466-B 雪 end") && text(popupPane).includes("Pending input"), 30_000,
      "actual registered question and notice tools finish the synthetic turn");
    // No mouse selection has yet existed in this fresh child: exercise the
    // native Main fallback without assuming ordinary typing clears selection.
    popupInput("\x1b[17~");
    await signal.waitFor(() => copies(popupChild!).length === 1, 20_000, "native Main application-copy fallback preserved");
    assert.equal(Buffer.from(copies(popupChild!)[0]!, "base64").toString("utf8"), "ASSISTANT466-A αβ café\nASSISTANT466-B 雪 end");
    // The faux-provider turn already drew the assistant rows in this fresh Main
    // conversation, so select those visible rows directly. Registering another
    // slash command here would exercise native autocomplete and a second model
    // turn instead of the Main copy route under test.
    select(popupPane, popupInput, "ASSISTANT466-A", "ASSISTANT466-B");
    popupInput("\x1b[17~");
    await signal.waitFor(() => copies(popupChild!).length === 2, 20_000,
      "actual Main ProcessTerminal emits exactly one clipboard request per copy gesture");
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
    await signal.waitFor(() => text(popupPane).includes("open question/notice"), 20_000, "shared pending list actually drawn and focused");
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
      await signal.waitFor(() => region() !== undefined, 20_000, "visible framed question or notice body");
      await popupPane.flush();
      const visible = region()!;
      shown.add(visible.pair[0]);
      const before = helperRecords().length;
      popupInput("\x1b[17~");
      await signal.waitForQuiet(() => helperRecords().length > before || copies(popupChild!).length > index + popupBaseline, 200,
        "popup entry rejects inherited hidden-conversation selection");
      select(popupPane, popupInput, visible.pair[0], visible.pair[1], visible.top, visible.bottom);
      popupInput("\x1b[17~");
      await signal.waitFor(() => copies(popupChild!).length === index + popupBaseline + 1, 20_000, "real visible-popup copy reaches outer terminal");
      const payload = Buffer.from(copies(popupChild!)[index + popupBaseline]!, "base64").toString("utf8");
      assert.ok(payload.includes(`${visible.pair[0]} αβ café`) && payload.includes(`${visible.pair[1]} 雪 end`));
      assert.ok(!payload.includes("CLIP466") && !payload.includes("ASSISTANT466"), "never copy hidden conversation rows");
      assert.equal(helperRecords().length, before + 1);
      assert.equal(payload, helperRecords().at(-1), "exact native producer payload reaches the real outer route unchanged");
      if (index === 0) {
        popupInput("\x1b");
        await signal.waitFor(() => text(popupPane).includes("open question/notice") && region() === undefined, 20_000, "back to drawn pending list");
        // Re-enter the shared popup so its existing entry fence applies. Do
        // not invent a new selection-reset policy for in-popup view changes.
        popupInput("\x1b");
        await signal.waitFor(() => !text(popupPane).includes("open question/notice") && region() === undefined, 20_000, "shared popup closed");
        popupInput("\x1b[1;7A");
        await signal.waitFor(() => text(popupPane).includes("open question/notice"), 20_000, "fresh shared popup entry");
        popupInput("\x1b[B"); popupInput("\r");
      }
    }
    assert.equal(shown.size, 2, "both foreground question and notice surfaces exercised");
    popupInput("\x1b[19~"); // host F8: focus roster, not a native copy gesture
    popupInput("q");
    await signal.waitFor(() => text(popupPane).includes("Quit host?"), 20_000, "real host Quit confirmation");
    popupInput("y");
    await signal.waitFor(() => popupChild!.exited && text(popupPane).includes("PRG-COPY-RESTORE")
      && popupPane.inputModes().mouseTracking === "none", 20_000, "original real host exits and restores its terminal after owned children settle");
    await popupPane.flush();
    assert.ok(!existsSync(hostOwnershipPath(agentDir)), "production ownership release requires child-exit settlement");
    assert.match(text(popupPane), /PRG-COPY-RESTORE/, "original outer terminal screen restored");
    assert.equal(popupPane.inputModes().mouseTracking, "none");
    assert.ok(owned.every((item) => item.exitCode === 0));
    // Deliberately no assertion about a physical terminal or OS clipboard.
  } catch (error) {
    try {
      writeFileSync(join(root, "failure.json"), JSON.stringify({ error: String(error), helpers: helperRecords(),
        frames: surfaces.map(text), outputs: owned.map((item) => ({ exited: item.exited, raw: item.raw.slice(-262144) })) }),
      { mode: 0o600, flag: "wx" });
    } catch { /* Preserve the original assertion and still settle owned children. */ }
    throw error;
  } finally {
    if (manager) await manager.shutdown({ graceMs: 2000, killMs: 2000 });
    for (const item of owned) {
      if (!item.exited) {
        item.handle.kill("SIGTERM");
        await signal.waitFor(() => item.exited, 5000, "owned fixture cleanup exit");
      }
    }
    if (manager) await manager.dispose();
    if (broker) await broker.dispose();
    for (const surface of surfaces) surface.dispose();
    // Retain invocation-owned synthetic evidence; never remove unconfirmed or
    // unknown files, and never scan/clean user sessions or unselected trees.
    assert.ok(owned.every((item) => item.exited));
  }
});
