/**
 * Synthetic, isolated child-process harness for the native clipboard bridge's
 * inert opt-in stdin-origin framing mode.
 *
 * Evidence scope (mock, not a native CLI): the "native CLI" is a minimal fake
 * package rooted in a throwaway directory under the caller's cwd whose
 * dist/cli.js exposes only the named call frames the bridge's provenance gate
 * observes (emitOsc52 -> copyToClipboard -> TuiAltScreen.copySelection /
 * copyTextToClipboard). This proves the owned bridge's framing, ALS dispatch
 * context, and capsule behavior inside a plain Node child. It is not the
 * installed Pi source, not a real native PTY, not a Windows/SSH child, and it
 * never reads or writes any physical clipboard.
 *
 * The scenario JSON is executed verbatim; the report JSON records delivered
 * stdin payloads, captured stdout writes, copy invocations, and feed return
 * values. Only fixed strings and exact bytes are reported; no token, header, or
 * raw frame text is added beyond what the scenario itself supplied.
 *
 * `nativeParser: true` additionally feeds every delivered stdin payload into the
 * ACTUAL pinned public `StdinBuffer` from `pi-session-host-tui` (the real
 * `@earendil-works/pi-tui@1.4.0` parser native Pi's terminal uses), recording the
 * `data` sequences and `paste` bodies that parser emits. It is the real parser,
 * not a reimplementation and not a patched native class, and it is loaded only
 * for scenarios that ask for it so every other scenario is unchanged.
 */
"use strict";

const { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const NATIVE_CLI_SOURCE = [
  '"use strict";',
  "// Synthetic stand-in for Pi 1.3.0's native copy producer: identical frame names only.",
  "function emitOsc52(encoded) {",
  "  return process.stdout.write('\\u001b]52;c;' + encoded + '\\u0007');",
  "}",
  "function copyToClipboard(encoded) {",
  "  return emitOsc52(encoded);",
  "}",
  "class TuiAltScreen {",
  "  copyTextToClipboard(encoded) {",
  "    return this.copySelection(encoded);",
  "  }",
  "  copySelection(encoded) {",
  "    return copyToClipboard(encoded);",
  "  }",
  "}",
  "exports.copy = function copyText(text) {",
  "  return new TuiAltScreen().copyTextToClipboard(Buffer.from(text, 'utf8').toString('base64'));",
  "};",
  "",
].join("\n");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeFakeRuntime() {
  const root = realpathSync(mkdtempSync(join(process.cwd(), ".prg-native-origin-bridge-")));
  mkdirSync(join(root, "dist"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "dist", "cli.js"), NATIVE_CLI_SOURCE, { mode: 0o600 });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "@earendil-works/pi-coding-agent",
    version: "1.3.0",
    bin: { pi: "dist/cli.js" },
  }), { mode: 0o600 });
  return { root, cli: join(root, "dist", "cli.js") };
}

async function main() {
  const scenarioPath = process.argv[2];
  const reportPath = process.argv[3];
  const bridgeModulePath = process.env.PRG_TEST_BRIDGE_MODULE;
  if (!scenarioPath || !reportPath || !bridgeModulePath) {
    throw new Error("usage: fixture <scenario.json> <report.json> (PRG_TEST_BRIDGE_MODULE required)");
  }
  const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
  const report = {
    installed: null,
    reinstall: null,
    payloads: [],
    writes: [],
    copies: [],
    feeds: [],
    callbackCompletions: [],
    plainReturns: [],
    parserData: [],
    parserPaste: [],
    errors: [],
  };
  let parser;
  let runtime;
  try {
    runtime = makeFakeRuntime();
    // Point the bridge's existing package/provenance gate at the fake CLI.
    process.argv[1] = runtime.cli;
    const bridge = require(bridgeModulePath);
    const native = require(runtime.cli);

    // Capture everything the process writes, before the bridge wraps the stream.
    // The capture is a stream-shaped writer: it records the exact chunk, whether a
    // completion callback was supplied, and the receiver; it invokes the callback
    // and returns a scenario-selected boolean, so suppression and forwarding can be
    // checked for real Node write semantics rather than "no write happened".
    const writerReturns = scenario.writerReturns !== false;
    process.stdout.write = function capture(chunk, ...rest) {
      const callback = rest.length > 0 && typeof rest[rest.length - 1] === "function"
        ? rest[rest.length - 1] : undefined;
      report.writes.push({
        text: typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1"),
        callbackProvided: callback !== undefined,
        receiverIsStdout: this === process.stdout,
      });
      if (callback !== undefined) callback();
      return writerReturns;
    };

    const options = scenario.options;
    report.installed = options === "omitted"
      ? bridge.installNativeClipboardBridge(scenario.bootstrap)
      : bridge.installNativeClipboardBridge(scenario.bootstrap, options === null ? undefined : options);
    // One bridge per process: a reload (same options) shares the existing state.
    report.reinstall = options === "omitted"
      ? bridge.installNativeClipboardBridge(scenario.bootstrap)
      : bridge.installNativeClipboardBridge(scenario.bootstrap, options === null ? undefined : options);

    let pendingArm;
    if (scenario.nativeParser === true) {
      // The real pinned public parser native Pi 1.4.0 consumes stdin with. The
      // bridge's emitted chunks are fed as text, exactly as the native terminal
      // wrapper feeds them after its own stdin decode.
      const { StdinBuffer } = require("pi-session-host-tui");
      parser = new StdinBuffer({ timeout: 20, escapeTimeout: 20 });
      parser.on("data", (sequence) => { report.parserData.push(String(sequence)); });
      parser.on("paste", (body) => { report.parserPaste.push(String(body)); });
    }
    process.stdin.on("data", function onData(chunk, ...rest) {
      if (Buffer.isBuffer(chunk)) {
        report.payloads.push({
          kind: "buffer",
          hex: chunk.toString("hex"),
          marker: chunk.__prgScenarioMarker === true,
          argCount: rest.length,
          thisIsStdin: this === process.stdin,
        });
      } else {
        report.payloads.push({
          kind: "string",
          text: String(chunk),
          marker: false,
          argCount: rest.length,
          thisIsStdin: this === process.stdin,
        });
      }
      if (parser !== undefined) {
        parser.process(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      }
      const arm = pendingArm;
      pendingArm = undefined;
      if (arm === undefined) return;
      const run = () => {
        const entry = { text: arm.text, deferred: arm.defer, callback: arm.callback === true, value: true };
        if (arm.callback === true) {
          const completion = () => { report.callbackCompletions.push(arm.text); };
          if (arm.plain === true) entry.value = process.stdout.write(arm.text, completion);
          else entry.value = process.stdout.write(`\u001b]52;c;${Buffer.from(arm.text, "utf8").toString("base64")}\u0007`, completion);
        } else {
          entry.value = native.copy(arm.text);
        }
        report.copies.push(entry);
      };
      if (arm.defer) setTimeout(run, arm.delay || 0);
      else run();
    });
    // The harness feeds stdin explicitly; never read the real descriptor.
    process.stdin.pause();

    for (const step of scenario.steps || []) {
      switch (step.op) {
        case "armStartup":
          // The reporter's one-shot startup arming, through the installed bridge.
          bridge.armNativeClipboardStartup();
          break;
        case "session":
          bridge.updateNativeClipboardSession(step.tuple);
          break;
        case "feed": {
          const chunk = Buffer.from(step.hex, "hex");
          if (step.marker) chunk.__prgScenarioMarker = true;
          report.feeds.push(process.stdin.emit("data", chunk));
          break;
        }
        case "feedText":
          report.feeds.push(process.stdin.emit("data", step.text));
          break;
        case "stringMode":
          process.stdin.setEncoding("utf8");
          break;
        case "armCopy":
          pendingArm = {
            text: step.text,
            defer: step.defer === true,
            delay: step.delay,
            callback: step.callback === true,
            plain: step.plain === true,
          };
          break;
        case "write":
          process.stdout.write(step.text);
          break;
        case "writeCallback":
          report.plainReturns.push(process.stdout.write(step.text,
            () => { report.callbackCompletions.push(step.text); }));
          break;
        case "wait":
          await delay(step.ms || 10);
          break;
        case "end":
          process.stdin.emit("end");
          break;
        default:
          throw new Error(`unknown scenario op: ${String(step.op)}`);
      }
    }
    // Let any deferred native copy continue to run after the last step.
    await delay(20);
  } catch (error) {
    report.errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    if (parser !== undefined && typeof parser.destroy === "function") {
      try { parser.destroy(); } catch { /* The report is already complete. */ }
    }
    if (runtime) rmSync(runtime.root, { recursive: true, force: true });
    writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600 });
  }
}

main().then(() => {
  process.exit(0);
}, (error) => {
  // A failing report publication must still be visible to the caller.
  try {
    writeFileSync(process.argv[3], JSON.stringify({ errors: [String(error)] }), { mode: 0o600 });
  } catch {
    // Nothing else can be reported.
  }
  process.exit(1);
});
