import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createNativeClipboardReceiver, encodeNativeClipboardCapsule, isNativeClipboardOrigin, resolveNativeClipboardRuntime,
  type NativeClipboardEvent, type NativeClipboardRuntime,
} from "../src/session-host/native-clipboard";
import type { SessionHostBootstrap } from "../src/session-host/protocol";

const bootstrap: SessionHostBootstrap = {
  version: 1, instanceId: "11111111-1111-1111-1111-111111111111",
  generation: "22222222-2222-2222-2222-222222222222", token: "ab".repeat(32), socketPath: "/synthetic/broker.sock",
};
const copy = (text: string): NativeClipboardEvent => ({ kind: "copy", encoded: Buffer.from(text).toString("base64"),
  sessionId: "33333333-3333-3333-3333-333333333333", sessionEpoch: 3 });

test("native clipboard capsule preserves exact Unicode/multiline native encoding once", () => {
  const seen: NativeClipboardEvent[] = [];
  const receive = createNativeClipboardReceiver(bootstrap, (event) => seen.push(event));
  for (const [i, text] of ["ordinary text", "αβ café\n雪 e\u0301 🧪"].entries()) {
    const event = copy(text);
    const capsule = encodeNativeClipboardCapsule(bootstrap, i + 1, event);
    receive(capsule); receive(capsule);
    assert.deepEqual(seen.at(-1), event);
  }
  assert.equal(seen.length, 2);
});

test("native clipboard receiver refuses tampering, foreign identity/key/generation, raw controls and stale sequence", () => {
  const seen: NativeClipboardEvent[] = [];
  const receive = createNativeClipboardReceiver(bootstrap, (event) => seen.push(event));
  const event = copy("synthetic selected text");
  const capsule = encodeNativeClipboardCapsule(bootstrap, 2, event);
  for (const input of ["\x1b]52;c;QQ==\x07", capsule.slice(0, -1) + "X", "x".repeat(140001),
    encodeNativeClipboardCapsule({ ...bootstrap, token: "cd".repeat(32) }, 3, event),
    encodeNativeClipboardCapsule({ ...bootstrap, instanceId: "44444444-4444-4444-4444-444444444444" }, 3, event),
    encodeNativeClipboardCapsule({ ...bootstrap, generation: "55555555-5555-5555-5555-555555555555" }, 3, event)]) receive(input);
  assert.deepEqual(seen, []);
  receive(capsule);
  receive(encodeNativeClipboardCapsule(bootstrap, 1, event));
  assert.deepEqual(seen, [event]);
});

test("refused owner or throwing callback still consumes a native request; unavailable carries no clipboard content", () => {
  let calls = 0;
  const receive = createNativeClipboardReceiver(bootstrap, () => { calls += 1; throw new Error("owner no longer active"); });
  const event: NativeClipboardEvent = { kind: "unavailable", reason: "unsupported-runtime", sessionId: "native-session", sessionEpoch: 1 };
  const capsule = encodeNativeClipboardCapsule(bootstrap, 1, event);
  receive(capsule); receive(capsule);
  assert.equal(calls, 1);
  assert.ok(!capsule.includes("native-session"), "capsule is private transport, not printable UI");
});

test("native clipboard schema rejects queries, noncanonical/binary/oversized payloads and invalid tuples", () => {
  const event = copy("bounded");
  for (const encoded of ["?", "QQ=", "QR==", "QQ==;escape", "//8=", Buffer.alloc(75001).toString("base64"), ""]) {
    assert.throws(() => encodeNativeClipboardCapsule(bootstrap, 1, { ...event, kind: "copy", encoded }));
  }
  assert.throws(() => encodeNativeClipboardCapsule(bootstrap, 0, event));
  assert.throws(() => encodeNativeClipboardCapsule(bootstrap, 1, { ...event, sessionEpoch: 0 }));
});

test("clipboard provenance resolves only the actual bounded official CLI package and refuses unsafe boundaries", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prg-copy-runtime-")));
  const entryDir = join(root, "dist", "bundle");
  mkdirSync(entryDir, { recursive: true, mode: 0o700 });
  const cli = join(entryDir, "cli.js");
  writeFileSync(cli, "// synthetic identity fixture, never executed\n", { mode: 0o600, flag: "wx" });
  const manifest = { name: "@earendil-works/pi-coding-agent", version: "1.3.0", bin: { pi: "dist/bundle/cli.js" } };
  const file = join(root, "package.json");
  writeFileSync(file, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
  assert.equal(resolveNativeClipboardRuntime(cli)?.root, root);
  assert.equal(resolveNativeClipboardRuntime(cli)?.supported, true);
  writeFileSync(file, JSON.stringify({ ...manifest, version: "1.4.0" }));
  assert.equal(resolveNativeClipboardRuntime(cli)?.supported, false, "future runtime is not silently certified");
  writeFileSync(file, JSON.stringify(manifest));
  writeFileSync(join(root, "dist", "package.json"), "not JSON", { mode: 0o600, flag: "wx" });
  assert.equal(resolveNativeClipboardRuntime(cli), undefined, "invalid nearer boundary cannot be attributed to the outer package");
});

const runtime: NativeClipboardRuntime = { root: join(tmpdir(), "synthetic-native"), tuiRoot: join(tmpdir(), "synthetic-pi-tui"), supported: true };
const nativeFile = pathToFileURL(join(runtime.root, "dist", "bundle", "chunks", "native.js")).href;
const otherFile = pathToFileURL(join(tmpdir(), "synthetic-untrusted", "agent-output.js")).href;
const sites = [{ functionName: "emitOsc52", scriptName: nativeFile }, { functionName: "copyToClipboard", scriptName: nativeFile }];
const selectionStack = `Error\n    at emitOsc52 (${nativeFile}:10:20)\n    at copyToClipboard (${nativeFile}:10:50)\n    at async TuiAltScreen.copySelection (${nativeFile}:20:10)\n    at async TuiAltScreen.copyTextToClipboard (${nativeFile}:30:10)`;

test("native producer provenance accepts actual native selection and Main copy paths, not a gesture window", () => {
  assert.equal(isNativeClipboardOrigin(runtime, sites, selectionStack), true);
  assert.equal(isNativeClipboardOrigin(runtime, sites,
    `Error\n    at async InteractiveMode.handleCopyCommand (${nativeFile}:40:10)`), true);
  assert.equal(isNativeClipboardOrigin(runtime, sites,
    `Error\n    at async _InteractiveMode.handleCopyCommand (${nativeFile}:40:10)`), true,
    "actual bundled Pi 1.3.0 Main class alias is source-verified");
  const unbundled = selectionStack.replace(/TuiAltScreen.copyTextToClipboard \(.+?:30:10\)/,
    `TuiAltScreen.copyTextToClipboard (${pathToFileURL(join(runtime.tuiRoot!, "dist", "tui-alt-screen.js")).href}:30:10)`);
  assert.equal(isNativeClipboardOrigin(runtime, sites, unbundled), true);
  for (const stack of ["", "Error\n    at render (file:///synthetic/extension.js:1:1)",
    selectionStack.replaceAll(nativeFile, otherFile),
    selectionStack.replace("TuiAltScreen.copySelection", "Widget.render")]) {
    assert.equal(isNativeClipboardOrigin(runtime, sites, stack), false);
  }
  assert.equal(isNativeClipboardOrigin(runtime, [{ functionName: "render", scriptName: nativeFile }], selectionStack), false);
  assert.equal(isNativeClipboardOrigin(runtime, sites.map((site) => ({ ...site, scriptName: otherFile })), selectionStack), false);
  assert.equal(isNativeClipboardOrigin({ ...runtime, supported: false }, sites, selectionStack), false);
  assert.equal(isNativeClipboardOrigin(runtime, sites, "Error\n    at copyToClipboard (file:///synthetic/extension.js:1:1)"), false,
    "calling the native helper directly is not a native UI copy operation");
});
