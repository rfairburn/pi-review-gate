#!/usr/bin/env node
"use strict";

/**
 * Synthetic interactive "native CLI" for the Android owner acceptance fixture.
 *
 * This program is the child the REAL production `InstanceManager` puts on a REAL
 * `node-pty` handle when the fixture's launch provider answers for the canonical
 * `claude` and `codex` backends. It is not a provider binary, it is not Pi, and
 * it runs with no Pi bootstrap, preload, status registration, startup payload,
 * title token, or input framing — exactly like a real hosted provider row.
 *
 * What it does, and nothing more:
 * - draws a small interactive pane so a real viewer has real frames to display;
 * - journals the RAW bytes it actually received on its own TTY stdin (length,
 *   SHA-256, and a bounded printable rendering of harmless nonce markers) to the
 *   one journal file the fixture owns. Raw TTY input carries no Pi framing and no
 *   source token, and none is invented here;
 * - emits a canonical OSC 52 TEXT copy request (`ESC ] 52 ; c ; <base64> BEL`)
 *   when the operator types the fixed trigger word, or when the fixture pokes the
 *   out-of-band control file. It never reads the OS clipboard and never spawns a
 *   clipboard helper;
 * - journals each emission so the fixture can separate "the child emitted OSC 52"
 *   from "the owner forwarded a copy frame to a viewer".
 *
 * It prints no secret: only the run nonce, its backend, and synthetic markers.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BACKENDS = new Set(["claude", "codex"]);
/** The typed trigger word that makes this pane ask for a text copy. */
const COPY_TRIGGER = "prgcopy";
/** Fixed OSC 52 request framing: canonical base64 payload between `;` and BEL. */
const OSC52_START = "\u001b]52;c;";
const BEL = "\u0007";
const MAX_ARG = 128;
const MAX_PRINTABLE = 96;

function fail(message) {
  process.stderr.write(`synthetic-native-cli: ${message}\n`);
  process.exit(64);
}

function readArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--") || typeof value !== "string" || value.length === 0 || value.length > MAX_ARG) {
      fail(`bad argument at ${i}`);
    }
    out[key.slice(2)] = value;
    i += 1;
  }
  if (!BACKENDS.has(out.backend)) fail("--backend must be claude or codex");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(out.nonce ?? "")) fail("--nonce must be a bounded token");
  for (const name of ["journal", "control"]) {
    const value = out[name];
    if (typeof value !== "string" || !path.isAbsolute(value)) fail(`--${name} must be an absolute path`);
  }
  return out;
}

const options = readArgs(process.argv.slice(2));
const journalPath = options.journal;
const controlPath = options.control;
const backend = options.backend;
const nonce = options.nonce;

let journalSeq = 0;

/** One append-only JSONL record. The journal file is owned by the fixture. */
function journal(event, fields) {
  journalSeq += 1;
  const record = {
    event,
    seq: journalSeq,
    pid: process.pid,
    ppid: process.ppid,
    backend,
    nonce,
    at: Date.now(),
    ...fields,
  };
  try {
    fs.appendFileSync(journalPath, `${JSON.stringify(record)}\n`);
  } catch {
    // A journal write failure must never turn into a fake success claim; the
    // fixture's report reads the file and reports the gap.
  }
}

function draw(lines) {
  // A deliberately small pane: a banner plus the recent transcript, so every
  // accepted input produces a real output change a viewer can display. The banner
  // carries the size this child's OWN terminal reports, so a repaint after a resize
  // is a real content change and not a redraw of identical cells.
  const out = [
    "\u001b[2J\u001b[H",
    `\u001b[1m synthetic native cli \u001b[0m backend=${backend} nonce=${nonce} pid=${process.pid}`
      + ` tty=${process.stdout.columns ?? "?"}x${process.stdout.rows ?? "?"}\r\n`,
    `ready ${nonce} ${backend}\r\n`,
  ];
  for (const line of lines) out.push(`${line}\r\n`);
  out.push(`prg:${backend}> `);
  process.stdout.write(out.join(""));
}

/** Bounded, escaped rendering of received bytes: harmless markers stay readable. */
function render(chunk) {
  let text = "";
  for (const byte of chunk) {
    if (byte === 0x0d) text += "\\r";
    else if (byte === 0x0a) text += "\\n";
    else if (byte === 0x7f) text += "\\x7f";
    else if (byte < 0x20) text += `\\x${byte.toString(16).padStart(2, "0")}`;
    else if (byte === 0x1b) text += "\\e";
    else text += String.fromCharCode(byte);
    if (text.length > MAX_PRINTABLE) {
      text = `${text.slice(0, MAX_PRINTABLE)}…`;
      break;
    }
  }
  return text;
}

function encodeCopy(text) {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  process.stdout.write(`${OSC52_START}${encoded}${BEL}`);
  journal("osc52-emitted", { text, encodedLength: encoded.length });
}

/** Rolling transcript kept short; only the tail is redrawn. */
const transcript = [];

function noteLine(text) {
  transcript.push(text);
  if (transcript.length > 12) transcript.shift();
  draw(transcript);
}

let rolling = "";
let copyCount = 0;

function handleStdin(chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
  const printable = render(buffer);
  journal("stdin-received", {
    bytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    printable,
  });
  rolling = `${rolling}${printable}`.slice(-3 * COPY_TRIGGER.length);
  if (rolling.includes(COPY_TRIGGER)) {
    rolling = "";
    copyCount += 1;
    encodeCopy(`PRGCOPY-${backend}-${nonce}-typed-${copyCount}`);
    noteLine(`copy requested (typed) #${copyCount}`);
  } else {
    noteLine(`input ${buffer.length}B ${printable}`);
  }
}

/**
 * The out-of-band control channel: the fixture rewrites one owned file. This is a
 * test-only trigger so a copy can be produced WITHOUT the viewer sending PTY
 * bytes that would retarget the frozen recipient.
 */
function readControl() {
  let text;
  try {
    text = fs.readFileSync(controlPath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed === "exit") {
      journal("control-exit", {});
      process.exit(0);
    }
    if (trimmed.startsWith("copy ")) {
      const token = trimmed.slice(5).trim();
      if (token.length > 0 && token !== seenControlToken) {
        seenControlToken = token;
        copyCount += 1;
        journal("control-copy", { token });
        encodeCopy(`PRGCOPY-${backend}-${nonce}-out-of-band-${copyCount}`);
        noteLine(`copy requested (out of band) #${copyCount}`);
      }
    }
  }
}

let seenControlToken = "";

/**
 * A real terminal resize is a real event: the owner applies its viewer's viewport to
 * the PTY, this child receives SIGWINCH, and `process.stdout.columns`/`rows` change.
 * A real interactive program repaints when that happens, so this one does: it journals
 * the size the child actually sees (never an invented one) and redraws the existing
 * banner and transcript through the same `draw` the input path already uses, which makes
 * the repaint real content on the child's own TTY. Whether the owner then republishes a
 * frame or a source is the owner's own observed behaviour, claimed separately. No timer,
 * no periodic repaint, no control-channel repaint, and no stdin, copy, or control effect.
 */
function handleResize() {
  journal("tty-resize", {
    cols: process.stdout.columns ?? null,
    rows: process.stdout.rows ?? null,
  });
  draw(transcript);
}

function main() {
  // Fail closed if the fixture's owned files are not already there: the fixture
  // creates them, and a missing path means this child is not this run's child.
  let controlStat;
  try {
    controlStat = fs.statSync(controlPath);
  } catch {
    fail("control file is missing; this launch is not owned by a fixture run");
  }
  if (!controlStat.isFile()) fail("control path is not a regular file");
  journal("launch", {
    argv: process.argv.slice(2).map((value) => (value.length > 40 ? `${value.slice(0, 40)}…` : value)),
    cwd: process.cwd(),
    cols: process.stdout.columns ?? null,
    rows: process.stdout.rows ?? null,
  });
  draw(transcript);

  // The PTY's own resize notification, as Node surfaces it on a TTY stdout. Without
  // this the pane would stay silent after a resize and the owner would hold its
  // spawn-time frame forever.
  if (process.stdout.isTTY) {
    process.stdout.on("resize", handleResize);
  } else {
    journal("tty-resize-unavailable", {});
  }

  if (typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(true);
    } catch {
      // Not a TTY: the manager always spawns this on a PTY, so this is a fixture
      // error the report will surface as "no stdin witness".
      journal("stdin-raw-unavailable", {});
    }
  }
  process.stdin.on("data", handleStdin);
  process.stdin.on("end", () => {
    journal("stdin-end", {});
    process.exit(0);
  });
  process.stdin.resume();

  try {
    fs.watch(path.dirname(controlPath), () => readControl());
  } catch {
    journal("control-watch-unavailable", {});
  }
  readControl();

  process.on("SIGTERM", () => {
    journal("signal", { signal: "SIGTERM" });
    process.exit(0);
  });
}

main();
