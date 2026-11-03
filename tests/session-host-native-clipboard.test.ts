import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  createNativeClipboardReceiver, encodeNativeClipboardCapsule, encodeNativeClipboardOriginCapsule,
  isNativeClipboardOrigin, resolveNativeClipboardRuntime,
  type NativeClipboardEvent, type NativeClipboardOriginEvent, type NativeClipboardRuntime,
} from "../src/session-host/native-clipboard";
import type { SessionHostBootstrap } from "../src/session-host/protocol";
import { findInstalledAgentDirs } from "./menu-tui-fakes";
import { skipOrFail } from "./bridge-fakes";

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

test("clipboard provenance resolves only the exact audited CLI and peer TUI versions", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prg-copy-runtime-")));
  const entryDir = join(root, "dist", "bundle");
  mkdirSync(entryDir, { recursive: true, mode: 0o700 });
  const cli = join(entryDir, "cli.js");
  writeFileSync(cli, "// synthetic identity fixture, never executed\n", { mode: 0o600, flag: "wx" });
  const manifest = { name: "@earendil-works/pi-coding-agent", version: "1.3.0", bin: { pi: "dist/bundle/cli.js" } };
  const file = join(root, "package.json");
  writeFileSync(file, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });

  const peerRoot = join(root, "node_modules", "@earendil-works", "pi-tui");
  const peerDist = join(peerRoot, "dist");
  mkdirSync(peerDist, { recursive: true, mode: 0o700 });
  writeFileSync(join(peerDist, "tui-alt-screen.js"), "// synthetic peer identity fixture\n", { mode: 0o600, flag: "wx" });
  const peerManifest = join(peerRoot, "package.json");
  const writePeerManifest = (version: string): void => writeFileSync(peerManifest,
    JSON.stringify({ name: "@earendil-works/pi-tui", version, main: "dist/tui-alt-screen.js" }));

  for (const version of ["1.3.0", "1.4.0", "1.5.0"]) {
    writeFileSync(file, JSON.stringify({ ...manifest, version }));
    writePeerManifest(version);
    const runtime = resolveNativeClipboardRuntime(cli);
    assert.equal(runtime?.root, root);
    assert.equal(runtime?.supported, true, `exact audited Pi ${version} is supported`);
    assert.equal(runtime?.tuiRoot, peerRoot, `exact audited pi-tui ${version} source is recognized`);
  }
  for (const version of ["1.4.1", "1.5.1", "1.6.0", "2.0.0"]) {
    writeFileSync(file, JSON.stringify({ ...manifest, version }));
    assert.equal(resolveNativeClipboardRuntime(cli)?.supported, false, `Pi ${version} is not silently certified`);
  }

  writeFileSync(file, JSON.stringify({ ...manifest, version: "1.4.0" }));
  writePeerManifest("1.4.1");
  const unsupportedPeer = resolveNativeClipboardRuntime(cli);
  assert.equal(unsupportedPeer?.supported, true, "an unknown peer does not invalidate the exact supported Pi package");
  assert.equal(unsupportedPeer?.tuiRoot, undefined, "an unknown peer source is not added to native-source provenance");

  writeFileSync(file, JSON.stringify({ ...manifest, version: "1.3.0" }));
  writePeerManifest("1.3.0");
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
    "actual bundled Pi 1.3.0, 1.4.0, and 1.5.0 Main class alias is source-verified");
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

type OriginInputArg = Parameters<typeof encodeNativeClipboardOriginCapsule>[3];

test("v1 capsules stay byte-identical while v2 carries an explicit origin under its own domain", () => {
  const event = copy("selected text");
  const body = JSON.stringify({
    version: 1, instanceId: bootstrap.instanceId, generation: bootstrap.generation, sequence: 1, event,
  });
  const encoded = Buffer.from(body, "utf8").toString("base64");
  const mac = createHmac("sha256", Buffer.from(bootstrap.token, "hex"))
    .update("pi-review-gate/native-copy/v1\0").update(encoded).digest("hex");
  assert.equal(encodeNativeClipboardCapsule(bootstrap, 1, event), `prg-native-copy-v1;${encoded};${mac}`,
    "the shared encoder still produces the exact v1 wire bytes");

  const input = { origin: { kind: "viewer" as const, token: "opaque-viewer-1" }, dispatchId: 7 };
  const capsule = encodeNativeClipboardOriginCapsule(bootstrap, 1, event, input);
  assert.ok(capsule.startsWith("prg-native-copy-v2;"));
  const bodyStart = "prg-native-copy-v2;".length;
  const bodyEnd = capsule.indexOf(";", bodyStart);
  const bodyBase64 = capsule.slice(bodyStart, bodyEnd);
  assert.deepEqual(JSON.parse(Buffer.from(bodyBase64, "base64").toString("utf8")), {
    version: 2,
    instanceId: bootstrap.instanceId,
    generation: bootstrap.generation,
    sequence: 1,
    event,
    input: { origin: { kind: "viewer", token: "opaque-viewer-1" }, dispatchId: 7 },
  });
  const v2Mac = createHmac("sha256", Buffer.from(bootstrap.token, "hex"))
    .update("pi-review-gate/native-copy/v2\0").update(bodyBase64).digest("hex");
  assert.equal(capsule.slice(bodyEnd + 1), v2Mac, "v2 uses its own HMAC domain over the same body encoding");
});

test("v1 and v2 capsules never cross-accept and share one monotonic receiver sequence", () => {
  const event = copy("shared sequence");
  const v1 = encodeNativeClipboardCapsule(bootstrap, 1, event);
  const v2 = encodeNativeClipboardOriginCapsule(bootstrap, 2, event,
    { origin: { kind: "local" }, dispatchId: 1 });
  const v1Events: NativeClipboardEvent[] = [];
  const v2Events: NativeClipboardOriginEvent[] = [];
  const receive = createNativeClipboardReceiver(bootstrap, (seen) => v1Events.push(seen), (seen) => v2Events.push(seen));

  receive(v2.replace("prg-native-copy-v2;", "prg-native-copy-v1;"));
  receive(v1.replace("prg-native-copy-v1;", "prg-native-copy-v2;"));
  receive(v2.slice(0, -1) + (v2.endsWith("0") ? "1" : "0"));
  assert.deepEqual([v1Events.length, v2Events.length], [0, 0], "prefix/domain swaps and tampering never verify");

  receive(v1);
  receive(v1);
  assert.equal(v1Events.length, 1, "the v1 replay guard is unchanged");
  assert.deepEqual(Object.keys(v1Events[0]!).sort(), ["encoded", "kind", "sessionEpoch", "sessionId"],
    "v1 events gain no version-2 field, not even an undefined one");

  receive(v2);
  assert.equal(v2Events.length, 1);
  assert.deepEqual(v2Events[0]!.event, event);
  assert.deepEqual(v2Events[0]!.origin, { kind: "local" });
  assert.equal(v2Events[0]!.dispatchId, 1);

  receive(v2);
  receive(v1);
  assert.deepEqual([v1Events.length, v2Events.length], [1, 1], "a v2 request cannot be replayed as v1 or itself");
  receive(encodeNativeClipboardCapsule(bootstrap, 3, event));
  assert.equal(v1Events.length, 2);
  receive(encodeNativeClipboardOriginCapsule(bootstrap, 4, event,
    { origin: { kind: "viewer", token: "viewer-opaque" }, dispatchId: 2 }));
  assert.equal(v2Events.length, 2);
});

test("a v2 capsule with no host consumer is authenticated, sequence-consuming and never downgraded", () => {
  const event = copy("host is still v1 only");
  const seen: NativeClipboardEvent[] = [];
  const receive = createNativeClipboardReceiver(bootstrap, (capsuleEvent) => seen.push(capsuleEvent));
  const v2 = encodeNativeClipboardOriginCapsule(bootstrap, 2, event,
    { origin: { kind: "viewer", token: "viewer-opaque" }, dispatchId: 3 });
  receive(v2);
  receive(encodeNativeClipboardCapsule(bootstrap, 2, event));
  receive(encodeNativeClipboardCapsule(bootstrap, 1, event));
  assert.deepEqual(seen, [], "an origin-bearing request is never delivered to the v1 callback");
  receive(encodeNativeClipboardCapsule(bootstrap, 3, event));
  assert.deepEqual(seen, [event]);
});

test("v2 refuses none origins, malformed metadata and out-of-range dispatch ids at the encoder", () => {
  const event = copy("bounded");
  const encode = (input: unknown): string =>
    encodeNativeClipboardOriginCapsule(bootstrap, 1, event, input as OriginInputArg);
  for (const input of [
    { origin: { kind: "none" }, dispatchId: 1 },
    { origin: { token: "opaque" }, dispatchId: 1 },
    { origin: "local", dispatchId: 1 },
    { origin: { kind: "viewer" }, dispatchId: 1 },
    { origin: { kind: "viewer", token: "" }, dispatchId: 1 },
    { origin: { kind: "viewer", token: `${"v".repeat(128)}\n` }, dispatchId: 1 },
    { origin: { kind: "local", token: "unexpected" }, dispatchId: 1 },
    { origin: { kind: "local" }, dispatchId: 0 },
    { origin: { kind: "local" }, dispatchId: -1 },
    { origin: { kind: "local" }, dispatchId: 1.5 },
    { origin: { kind: "local" }, dispatchId: "1" },
    { origin: { kind: "local" }, dispatchId: 1, extra: true },
    { dispatchId: 1 },
    null,
  ]) {
    assert.throws(() => encode(input), `origin input ${JSON.stringify(input)} must be refused`);
  }
  assert.throws(() => encodeNativeClipboardOriginCapsule(bootstrap, 0, event,
    { origin: { kind: "local" }, dispatchId: 1 }));
});

test("v2 receipts deliver immutable origin metadata and a viewer refusal never looks local", () => {
  const event = copy("viewer copy");
  const v1Events: NativeClipboardEvent[] = [];
  const receipts: NativeClipboardOriginEvent[] = [];
  const receive = createNativeClipboardReceiver(bootstrap, (seen) => v1Events.push(seen), (seen) => receipts.push(seen));
  receive(encodeNativeClipboardOriginCapsule(bootstrap, 1, event,
    { origin: { kind: "viewer", token: "opaque-viewer-2" }, dispatchId: 5 }));
  assert.equal(v1Events.length, 0, "a v2 capsule is never downgraded into the v1 callback");
  const [receipt] = receipts;
  assert.ok(receipt);
  assert.deepEqual({ ...receipt.event }, event);
  assert.deepEqual(Object.keys(receipt).sort(), ["dispatchId", "event", "origin"]);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.event), true);
  assert.equal(Object.isFrozen(receipt.origin), true);
  assert.equal(Reflect.set(receipt.origin as object, "kind", "local"), false, "the receipt origin is read-only");
  assert.equal(Reflect.set(receipt.event as object, "encoded", Buffer.from("x").toString("base64")), false,
    "the receipt event is read-only");
  assert.equal(receipt.origin.kind, "viewer");

  receive(encodeNativeClipboardOriginCapsule(bootstrap, 2, {
    kind: "unavailable", reason: "unverified-native-origin", sessionId: "native-session", sessionEpoch: 2,
  }, { origin: { kind: "viewer", token: "opaque-viewer-2" }, dispatchId: 6 }));
  assert.equal(receipts[1]!.event.kind, "unavailable");
  assert.equal(receipts[1]!.origin.kind, "viewer", "a viewer refusal keeps its origin instead of reading as local");
  assert.equal(receipts[1]!.dispatchId, 6);

  let calls = 0;
  const throwing = createNativeClipboardReceiver(bootstrap, () => assert.fail(), () => {
    calls += 1;
    throw new Error("owner no longer active");
  });
  const capsule = encodeNativeClipboardOriginCapsule(bootstrap, 3, event,
    { origin: { kind: "local" }, dispatchId: 7 });
  throwing(capsule);
  throwing(capsule);
  assert.equal(calls, 1, "a refusing owner consumes the request and no error escapes");
});

test("v2 bounds stay inside the unchanged capsule and native payload limits", () => {
  const event = copy("a".repeat(75_000)); // The exact native OSC 52 payload limit.
  const capsule = encodeNativeClipboardOriginCapsule(bootstrap, 1, event, {
    origin: { kind: "viewer", token: "v".repeat(128) }, dispatchId: Number.MAX_SAFE_INTEGER,
  });
  assert.ok(capsule.length <= 140_000, "the v2 envelope does not widen the capsule budget");
  const receipts: NativeClipboardOriginEvent[] = [];
  createNativeClipboardReceiver(bootstrap, () => assert.fail(), (receipt) => receipts.push(receipt))(capsule);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0]!.origin, { kind: "viewer", token: "v".repeat(128) });
  assert.equal(receipts[0]!.dispatchId, Number.MAX_SAFE_INTEGER);
  assert.throws(() => encodeNativeClipboardOriginCapsule(bootstrap, 1, copy("a".repeat(75_001)),
    { origin: { kind: "local" }, dispatchId: 1 }), "the native payload bound is unchanged");
  let calls = 0;
  const receive = createNativeClipboardReceiver(bootstrap, () => { calls += 1; }, () => { calls += 1; });
  receive("x".repeat(140_001));
  assert.equal(calls, 0, "an oversized capsule is still refused before parsing");
  receive(capsule);
  assert.equal(calls, 1);
});

interface ReadyOverrides {
  readonly version?: unknown;
  readonly kind?: unknown;
  readonly instanceId?: unknown;
  readonly generation?: unknown;
  readonly extra?: Record<string, unknown>;
  readonly domain?: string;
  readonly key?: string;
  readonly prefix?: string;
}
/** Independently re-derive the readiness wire format the child bridge emits. */
function readyCapsule(overrides: ReadyOverrides = {}): string {
  const body: Record<string, unknown> = {
    version: overrides.version === undefined ? 1 : overrides.version,
    kind: overrides.kind === undefined ? "input-framing-ready" : overrides.kind,
    instanceId: overrides.instanceId === undefined ? bootstrap.instanceId : overrides.instanceId,
    generation: overrides.generation === undefined ? bootstrap.generation : overrides.generation,
    ...overrides.extra,
  };
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64");
  const mac = createHmac("sha256", Buffer.from(overrides.key ?? bootstrap.token, "hex"))
    .update(overrides.domain ?? "pi-review-gate/native-input-ready/v1\0").update(encoded).digest("hex");
  return `${overrides.prefix ?? "prg-native-input-ready-v1;"}${encoded};${mac}`;
}
const readyBodyOf = (capsule: string): string => capsule.split(";")[1];

test("input-framing readiness verifies once, never reaches copy callbacks and keeps copy sequence 1", () => {
  const event = copy("after readiness");
  const ready = readyCapsule();
  assert.ok(ready.length <= 1024, "readiness stays inside its own bound");
  assert.equal(ready.includes(bootstrap.token), false, "readiness never carries the token");
  const parsed = JSON.parse(Buffer.from(readyBodyOf(ready), "base64").toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(parsed, {
    version: 1, kind: "input-framing-ready",
    instanceId: bootstrap.instanceId, generation: bootstrap.generation,
  });
  assert.equal(Object.hasOwn(parsed, "token"), false);

  const copies: NativeClipboardEvent[] = [];
  const origins: NativeClipboardOriginEvent[] = [];
  let readyCalls = 0;
  const receive = createNativeClipboardReceiver(bootstrap, (seen) => copies.push(seen),
    (seen) => origins.push(seen), () => { readyCalls += 1; });
  receive(ready);
  receive(ready);
  assert.equal(readyCalls, 1, "readiness is consumed at most once per registration");
  assert.deepEqual([copies.length, origins.length], [0, 0], "readiness is never a copy event");

  receive(encodeNativeClipboardCapsule(bootstrap, 1, event));
  assert.deepEqual(copies, [event], "readiness is separate: the first copy is still sequence 1");
  receive(encodeNativeClipboardOriginCapsule(bootstrap, 2, event,
    { origin: { kind: "local" }, dispatchId: 1 }));
  assert.equal(origins.length, 1);
  receive(ready);
  assert.equal(readyCalls, 1, "a late readiness replay is quiet");
});

test("readiness refuses foreign key/identity, cross-domain/prefix, schema drift and oversized statements", () => {
  let readyCalls = 0;
  let copyCalls = 0;
  const receive = createNativeClipboardReceiver(bootstrap, () => { copyCalls += 1; },
    () => { copyCalls += 1; }, () => { readyCalls += 1; });
  const valid = readyCapsule();
  const validBody = readyBodyOf(valid);
  const validMac = valid.split(";")[2];
  const copyCapsule = encodeNativeClipboardCapsule(bootstrap, 1, copy("x"));
  const copyBody = readyBodyOf(copyCapsule);
  const copyMac = copyCapsule.split(";")[2];
  const refusals = [
    readyCapsule({ key: "cd".repeat(32) }),
    readyCapsule({ instanceId: "44444444-4444-4444-4444-444444444444" }),
    readyCapsule({ generation: "55555555-5555-5555-5555-555555555555" }),
    readyCapsule({ domain: "pi-review-gate/native-copy/v1\0" }),
    readyCapsule({ domain: "pi-review-gate/native-copy/v2\0" }),
    readyCapsule({ version: 2 }),
    readyCapsule({ kind: "copy" }),
    readyCapsule({ extra: { token: "leak" } }),
    readyCapsule({ extra: { sequence: 1, event: copy("x") } }),
    readyCapsule({ prefix: "prg-native-copy-v1;" }),
    readyCapsule({ prefix: "prg-native-copy-v2;" }),
    readyCapsule({ extra: { pad: "y".repeat(1_100) } }),
    `prg-native-input-ready-v1;${validBody}X;${validMac}`,
    `prg-native-input-ready-v1;${validBody};${validMac.slice(0, -1)}`,
    `prg-native-input-ready-v1;${copyBody};${copyMac}`,
    copyCapsule.replace("prg-native-copy-v1;", "prg-native-input-ready-v1;"),
  ];
  for (const capsule of refusals) receive(capsule);
  assert.deepEqual([copyCalls, readyCalls], [0, 0], "every refusal is quiet and consumes nothing");
  receive(valid);
  assert.equal(readyCalls, 1);
  assert.equal(copyCalls, 0);
});

test("a refusing readiness consumer still consumes the statement exactly once", () => {
  const ready = readyCapsule();
  let calls = 0;
  const receive = createNativeClipboardReceiver(bootstrap, () => { calls += 100; },
    () => { calls += 100; }, () => {
      calls += 1;
      throw new Error("host refused readiness");
    });
  receive(ready);
  receive(ready);
  assert.equal(calls, 1, "readiness is consumed before its callback runs, even when it throws");
});

/**
 * Native-process proof against the ACTUAL shipped copy producer of an installed audited
 * runtime — not the named-frame stand-in in
 * tests/fixtures/session-host-native-clipboard-origin-bridge.cjs.
 *
 * The producer that runs here is the installation's own `dist/utils/clipboard.js` (plus
 * its two relative imports), copied byte-for-byte out of that installation into scratch;
 * nothing inside the installation is ever written. Only the one named caller frame the
 * provenance gate also requires (`_InteractiveMode.handleCopyCommand`) comes from this
 * test's driver, so what is exercised is the runtime's real `emitOsc52` →
 * `copyToClipboard` pair, with its real encoded payload, inside this package's
 * production child bridge. The full native UI, host routing, and saved-copy lanes stay
 * in their own native tests.
 *
 * Isolation, so no physical clipboard is reachable: the child's own `process.dlopen`
 * hook refuses the runtime's OS-clipboard native module, and the child's PATH contains
 * no clipboard command at all, so the runtime's remaining copy route is its own OSC 52
 * write, which the bridge intercepts and replaces. `PI_CLIPBOARD_OSC52=1` is that
 * runtime's documented "also send the copy to the terminal" switch, so the route is
 * taken deterministically. No credential, network access, or user state is used.
 */
const PRODUCER_TEXT = "PRG-NATIVE-PRODUCER-466 αβ café 雪 \u{1f9ea}";
const PRODUCER_TUPLE = { sessionId: "33333333-3333-3333-3333-333333333333", sessionEpoch: 7 };
const PRODUCER_MODULES = ["clipboard.js", "clipboard-command.js", "wsl.js"] as const;

/** Blocks the runtime's OS-clipboard native module inside the producer child. */
const PRODUCER_PRELOAD = `"use strict";
const dlopen = process.dlopen;
process.dlopen = function (mod, file, ...args) {
  if (/(?:darwin|win32|linux)-platform(?:-x11)?\\.node$/.test(String(file))) throw Error("owned fixture blocks the OS clipboard module");
  return dlopen.call(this, mod, file, ...args);
};
`;

/**
 * The driver: this package's production bridge installed over the child's real stdio, the
 * installed runtime's own copied `copyToClipboard`, and the one named frame the gate also
 * requires. The copy runs INSIDE a real stdin `data` dispatch, which is how the bridge
 * binds a copy to the current native conversation; the parent supplies that one input line.
 * It reports only fixed facts plus the runtime's own failure message.
 */
const PRODUCER_DRIVER = `import { createRequire } from "node:module";
import { copyToClipboard } from "./utils/clipboard.js";
const bridge = createRequire(import.meta.url)(process.env.PRG_BRIDGE_MODULE);
const bootstrap = JSON.parse(process.env.PRG_BOOTSTRAP);
const report = { installed: false, errors: [], dispatched: false };
report.installed = bridge.installNativeClipboardBridge(bootstrap);
bridge.updateNativeClipboardSession(JSON.parse(process.env.PRG_TUPLE));
class _InteractiveMode {
  async handleCopyCommand() {
    await copyToClipboard(process.env.PRG_PRODUCER_TEXT);
  }
}
const dispatched = new Promise((resolve) => {
  process.stdin.once("data", () => {
    report.dispatched = true;
    void new _InteractiveMode().handleCopyCommand()
      .catch((error) => report.errors.push(String(error && error.message || error)))
      .then(resolve);
  });
});
process.stdin.resume();
await dispatched;
process.stdout.write("PRG_PRODUCER_REPORT " + JSON.stringify(report) + "\\n");
`;

interface ProducerRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly report: { installed: boolean; dispatched: boolean; errors: string[] };
  readonly events: NativeClipboardEvent[];
  readonly capsules: number;
}

test("the shipped audited runtime's own copy producer passes the provenance gate natively",
  { timeout: 120_000 }, (t) => {
    if (process.platform === "win32") { t.skip("native Windows clipboard provenance stays experimental"); return; }
    const auditedVersions = ["1.3.0", "1.4.0", "1.5.0"];
    const installed = findInstalledAgentDirs().find((path) => {
      try { return auditedVersions.includes(JSON.parse(readFileSync(join(path, "package.json"), "utf8")).version); } catch { return false; }
    });
    if (!installed) { skipOrFail(t, `installed native Pi ${auditedVersions.join("/")} is required`); return; }
    const installedVersion = (JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { version: string }).version;
    // The runtime's own pi-tui peer, resolved from that installation and reached through a
    // link in scratch; the installation itself is never written.
    const tuiEntry = createRequire(join(installed, "package.json")).resolve("@earendil-works/pi-tui");
    let tuiPackage = dirname(tuiEntry);
    while (!existsSync(join(tuiPackage, "package.json"))) {
      const parent = dirname(tuiPackage);
      assert.notEqual(parent, tuiPackage, "the peer entry has its own package manifest");
      tuiPackage = parent;
    }
    const roots: string[] = [];
    t.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

    const run = (manifestVersion: string): ProducerRun => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "prg-copy-producer-")));
      roots.push(root);
      mkdirSync(join(root, "dist", "utils"), { recursive: true, mode: 0o700 });
      mkdirSync(join(root, "node_modules", "@earendil-works"), { recursive: true, mode: 0o700 });
      mkdirSync(join(root, "empty-bin"), { mode: 0o700 });
      symlinkSync(tuiPackage, join(root, "node_modules", "@earendil-works", "pi-tui"));
      for (const file of PRODUCER_MODULES) {
        cpSync(join(installed, "dist", "utils", file), join(root, "dist", "utils", file));
        // The producer under test must be the shipped bytes, not a transcription.
        assert.equal(readFileSync(join(root, "dist", "utils", file), "utf8"),
          readFileSync(join(installed, "dist", "utils", file), "utf8"), `${file} is copied unchanged`);
      }
      writeFileSync(join(root, "package.json"), JSON.stringify({
        name: "@earendil-works/pi-coding-agent", type: "module", version: manifestVersion,
        bin: { pi: "dist/producer-driver.mjs" },
      }), { mode: 0o600, flag: "wx" });
      writeFileSync(join(root, "dist", "producer-driver.mjs"), PRODUCER_DRIVER, { mode: 0o600, flag: "wx" });
      writeFileSync(join(root, "block-os-clipboard.cjs"), PRODUCER_PRELOAD, { mode: 0o600, flag: "wx" });
      const driver = join(root, "dist", "producer-driver.mjs");
      const identity = resolveNativeClipboardRuntime(driver);
      assert.ok(identity, "the bridge resolves this scratch runtime by its own manifest");
      assert.equal(identity.supported, manifestVersion === installedVersion,
        `only the audited version is certified (manifest ${manifestVersion})`);
      assert.ok(identity.tuiRoot !== undefined, "the runtime's own pi-tui peer source is recognized");
      const result = spawnSync(process.execPath, ["--require", join(root, "block-os-clipboard.cjs"), driver], {
        cwd: root, encoding: "utf8", timeout: 60_000, input: "PRG-INPUT-466\n",
        // An explicit allowlist: the child never inherits this worker's environment.
        env: {
          PATH: join(root, "empty-bin"), HOME: root, TMPDIR: root, TERM: "xterm-256color",
          PI_CLIPBOARD_OSC52: "1",
          PRG_BRIDGE_MODULE: join(__dirname, "..", "src", "session-host", "native-clipboard.js"),
          PRG_BOOTSTRAP: JSON.stringify(bootstrap), PRG_TUPLE: JSON.stringify(PRODUCER_TUPLE),
          PRG_PRODUCER_TEXT: PRODUCER_TEXT,
        },
      });
      const stdout = result.stdout ?? "";
      const match = /PRG_PRODUCER_REPORT (\{[^\n]*\})/.exec(stdout);
      assert.ok(match !== null, `the producer child reported its run (status ${result.status}): ${stdout} ${result.stderr}`);
      const events: NativeClipboardEvent[] = [];
      const capsules = [...stdout.matchAll(/\x1b\]777;(prg-native-copy-v[12];[^\x07]*)/g)].map((found) => found[1]!);
      const receive = createNativeClipboardReceiver(bootstrap, (event) => events.push(event));
      for (const capsule of capsules) receive(capsule);
      return { status: result.status, stdout, stderr: result.stderr ?? "", report: JSON.parse(match[1]!) as ProducerRun["report"], events, capsules: capsules.length };
    };

    // The scratch identity resolves exactly as the audit sees it, and only the child's
    // provenance decides the event.
    const audited = run(installedVersion);
    assert.equal(audited.status, 0, `the producer child exits cleanly: ${audited.stderr}`);
    assert.deepEqual(audited.report.errors, [], "the runtime's own copy path completed: " + audited.report.errors.join("; "));
    assert.equal(audited.report.installed, true, "the production bridge installed over this child's stdio");
    assert.equal(audited.report.dispatched, true, "the copy ran inside a real input dispatch");
    assert.equal(audited.capsules, 1, "exactly one authenticated copy request reached the host side");
    assert.equal(audited.events.length, 1, "and it verified against this registration's key and identity");
    assert.deepEqual(audited.events[0], { kind: "copy", encoded: Buffer.from(PRODUCER_TEXT, "utf8").toString("base64"),
      sessionId: PRODUCER_TUPLE.sessionId, sessionEpoch: PRODUCER_TUPLE.sessionEpoch },
      `the shipped Pi ${installedVersion} producer's own stack is proven, with its exact payload`);
    assert.equal(audited.stdout.includes("\x1b]52;"), false, "the native OSC 52 write never reaches the terminal raw");

    const unaudited = run("9.9.9");
    assert.equal(unaudited.status, 0, `the same shipped code runs under an unlisted version: ${unaudited.stderr}`);
    assert.deepEqual(unaudited.report.errors, [], "the runtime's copy path still completes");
    assert.equal(unaudited.report.installed, true, "the bridge installs for a resolvable runtime of any version");
    assert.equal(unaudited.report.dispatched, true, "the copy ran inside a real input dispatch");
    assert.equal(unaudited.capsules, 1, "the refusal is still one authenticated request, not silence");
    assert.equal(unaudited.events.length, 1);
    assert.deepEqual(unaudited.events[0], { kind: "unavailable", reason: "unsupported-runtime",
      sessionId: PRODUCER_TUPLE.sessionId, sessionEpoch: PRODUCER_TUPLE.sessionEpoch },
      "an unlisted version of the same shipped code fails closed instead of being certified");
    assert.equal(unaudited.stdout.includes("\x1b]52;"), false, "a refused copy still never relays raw OSC 52");
  });
