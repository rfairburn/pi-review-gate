"use strict";
/**
 * Controlled native-Pi stand-in for tests/session-host-persisted-defaults.test.ts
 * (issue #653). It is launched by the production InstanceManager through a
 * real PTY exactly where the native Pi CLI would run: the descriptor's argv
 * (`--extension <reporter.js> --extension <index.js> ...native args`), its
 * sanitized environment, its workspace cwd, and the production session-host
 * bootstrap preload staged through NODE_OPTIONS.
 *
 * What it does, and nothing more:
 *  - answers `--version` like an admissible Pi build;
 *  - at startup, calls the production compiled `loadConfig()` from the same
 *    compiled module tree as the gate extension named on its argv, with the
 *    same zero-argument call the extension's activation makes, and records the
 *    observation (resolved path plus a distinguishing setting);
 *  - keeps that startup result as its live in-memory snapshot and never
 *    reloads it;
 *  - on a test command naming its own instance, reports the live snapshot or
 *    sends one SessionSpawn request over the session-host broker socket with
 *    its own one-shot bootstrap token (consumed from the environment by the
 *    real preload), using the production frame encoder and payload stager.
 *
 * It never contacts a model, provider, or network service, and only reads or
 * writes inside the test-owned control directory named by its environment.
 */
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") {
  process.stdout.write("1.5.2\n");
  process.exit(0);
}

const CONTROL_ENV = "PRG_PERSISTED_DEFAULTS_CONTROL";
const controlDir = process.env[CONTROL_ENV];
if (!controlDir || !path.isAbsolute(controlDir)) process.exit(3);
const recordsDir = path.join(controlDir, "records");
const commandsDir = path.join(controlDir, "commands");

function writeRecord(name, value) {
  const target = path.join(recordsDir, name);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function extensionPath(basename) {
  for (let index = 0; index + 1 < argv.length; index += 1) {
    if (argv[index] === "--extension" && path.basename(argv[index + 1]) === basename) return argv[index + 1];
  }
  return undefined;
}

const gateExtension = extensionPath("index.js");
if (!gateExtension) process.exit(4);
const compiledSrc = path.dirname(gateExtension);
const { loadConfig } = require(path.join(compiledSrc, "config.js"));
const { encodeFrame, decodeFrame } = require(path.join(compiledSrc, "session-host", "protocol.js"));
const { stageSessionHostPayload } = require(path.join(compiledSrc, "session-host", "payload.js"));

// The real preload already consumed the one-shot bootstrap env into this
// process's sticky state before this script's main ran.
const sticky = globalThis[Symbol.for("pi-review-gate.session-host.state.v1")];
const bootstrap = sticky && typeof sticky === "object" ? sticky.bootstrap : undefined;
const instanceId = bootstrap && typeof bootstrap.instanceId === "string" ? bootstrap.instanceId : `pid-${process.pid}`;

// Exactly the extension activation's call: process.env and the real home.
const live = loadConfig();

function liveObservation() {
  return {
    loadedPath: live.path ?? null,
    marker: live.config && live.config.web ? live.config.web.fetch.userAgent : null,
    disabledReason: live.disabledReason ?? null,
  };
}

writeRecord(`${instanceId}.startup.json`, {
  pid: process.pid,
  instanceId,
  bootstrapPrimed: bootstrap !== undefined,
  bootstrapEnvRemaining: Object.prototype.hasOwnProperty.call(process.env, "PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP"),
  cwd: process.cwd(),
  args: argv,
  env: {
    PI_REVIEW_GATE_CONFIG: process.env.PI_REVIEW_GATE_CONFIG ?? null,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null,
    HOME: process.env.HOME ?? null,
    PI_REVIEW_GATE_RUNTIME_ROLE: process.env.PI_REVIEW_GATE_RUNTIME_ROLE ?? null,
  },
  ...liveObservation(),
});

// Like the real reporter's sticky sequence: status sequences only increase
// across reconnects, or the broker rejects the frame as stale.
let statusSequence = 0;

function sendSpawn(command) {
  return new Promise((resolve) => {
    if (!bootstrap || typeof bootstrap.payloadDir !== "string") {
      resolve("no-bootstrap");
      return;
    }
    const requestId = randomUUID();
    let settled = false;
    let buffer = "";
    const socket = net.connect(bootstrap.socketPath);
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish("timeout"), 30_000);
    socket.on("error", () => finish("socket-error"));
    socket.on("close", () => finish("closed"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = decodeFrame(buffer.slice(0, newline + 1));
        buffer = buffer.slice(newline + 1);
        if (message && message.type === "spawn_result" && message.requestId === requestId) finish(message.outcome);
      }
    });
    socket.on("connect", () => {
      const staged = stageSessionHostPayload(bootstrap.payloadDir, JSON.stringify(command.prompt));
      const base = { version: 1, instanceId: bootstrap.instanceId, generation: bootstrap.generation };
      socket.write(
        encodeFrame({ ...base, type: "hello", token: bootstrap.token })
        + encodeFrame({ ...base, type: "status", sequence: ++statusSequence, busy: false, pendingInput: false, inputSurface: true, activity: [] })
        + encodeFrame({
          ...base,
          type: "spawn_request",
          token: bootstrap.token,
          requestId,
          workspace: command.workspace,
          title: command.title,
          payload: staged.descriptor,
        }),
      );
    });
  });
}

let busy = false;
async function pollCommands() {
  if (busy) return;
  const file = path.join(commandsDir, `${instanceId}.json`);
  const taken = `${file}.${process.pid}.taken`;
  try {
    fs.renameSync(file, taken);
  } catch {
    return;
  }
  busy = true;
  try {
    const command = JSON.parse(fs.readFileSync(taken, "utf8"));
    fs.unlinkSync(taken);
    if (command.type === "report") {
      writeRecord(`${instanceId}.report-${command.seq}.json`, { pid: process.pid, ...liveObservation() });
    } else if (command.type === "spawn") {
      const outcome = await sendSpawn(command);
      writeRecord(`${instanceId}.spawn-${command.seq}.json`, { pid: process.pid, outcome, ...liveObservation() });
    }
  } finally {
    busy = false;
  }
}

// Stay alive like an interactive session until the host stops this child.
setInterval(() => { void pollCommands(); }, 40);
