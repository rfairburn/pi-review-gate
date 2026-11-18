"use strict";

// Owned loopback HTTP fixture for the release publisher transport regressions.
//
// `server` mode (spawned with an IPC channel): an HTTP/1.1 keep-alive API
// listener on 127.0.0.1 that forwards every request over IPC to the parent
// test, which owns all routing, plus a separate control listener. Shutdown is
// graceful and initiated by a `shutdown` message (or by the channel closing if
// the parent disappears, or by the overall guard): pending responses are
// destroyed, both listeners close, and only then does this process disconnect
// its IPC channel itself — a child-initiated disconnect is what lets the
// parent positively observe both `exit` and `close`. The process then exits
// naturally with code 0.
//
// `control` mode (run synchronously by the parent, so the parent's event loop
// is blocked while it runs): asks the control listener to report its counters
// or to close every idle API connection, and exits 0 only after the server
// acknowledged that each closed socket emitted `close`.
//
// Output is limited to integer counters; no request content, header, URL,
// address, port, path, environment, or raw error is ever written.

const http = require("node:http");

const SERVER_GUARD_MS = 90_000;
const SERVER_HARD_EXIT_MS = 5_000;
const CONTROL_GUARD_MS = 15_000;
const STAT_FIELDS = ["connections", "requests", "patches", "closedIdle", "open"];

function pickStats(source) {
  const stats = {};
  for (const field of STAT_FIELDS) {
    const value = source?.[field];
    stats[field] = Number.isSafeInteger(value) && value >= 0 ? value : -1;
  }
  return stats;
}

function runServer() {
  const counts = { connections: 0, requests: 0, patches: 0, closedIdle: 0 };
  const entries = new Set();
  const pending = new Map();
  let nextRequestId = 1;
  let shuttingDown = false;
  let guard;
  const stats = () => pickStats({ ...counts, open: entries.size });

  const api = http.createServer({ keepAliveTimeout: SERVER_GUARD_MS }, (req, res) => {
    const entry = req.socket.releaseLoopbackEntry;
    entry.busy = true;
    counts.requests += 1;
    if (req.method === "PATCH") counts.patches += 1;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const id = nextRequestId++;
      pending.set(id, { req, res, entry });
      process.send({
        type: "request",
        id,
        method: req.method,
        path: req.url,
        contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "",
        body: Buffer.concat(chunks).toString("base64"),
      });
    });
    res.on("close", () => {
      entry.busy = false;
    });
  });
  api.on("connection", (socket) => {
    counts.connections += 1;
    const entry = { socket, busy: false };
    socket.releaseLoopbackEntry = entry;
    entries.add(entry);
    socket.on("close", () => entries.delete(entry));
    socket.on("error", () => {});
  });

  function closeIdle() {
    const idle = [...entries].filter((entry) => !entry.busy);
    return Promise.all(idle.map((entry) => new Promise((resolve) => {
      entry.socket.once("close", resolve);
      entry.socket.destroy();
    }))).then(() => {
      counts.closedIdle += idle.length;
      return idle.length;
    });
  }

  const control = http.createServer((req, res) => {
    req.resume();
    req.on("end", async () => {
      let closed = 0;
      if (req.method === "POST" && req.url === "/close-idle") closed = await closeIdle();
      const text = JSON.stringify({ ...stats(), closed });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(text), connection: "close" });
      res.end(text);
    });
  });

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(guard);
    // Last resort only if graceful closure itself wedges; unref'd so it never
    // keeps a cleanly closing process alive.
    setTimeout(() => process.exit(3), SERVER_HARD_EXIT_MS).unref();
    for (const { res } of pending.values()) res.destroy();
    pending.clear();
    api.closeAllConnections();
    control.closeAllConnections();
    let listening = 2;
    const closed = () => {
      listening -= 1;
      if (listening === 0 && process.connected) process.disconnect();
    };
    api.close(closed);
    control.close(closed);
  }
  guard = setTimeout(shutdown, SERVER_GUARD_MS);

  process.on("message", (message) => {
    if (message?.type === "shutdown") {
      shutdown();
      return;
    }
    if (message?.type !== "response") return;
    const record = pending.get(message.id);
    if (!record || shuttingDown) return;
    pending.delete(message.id);
    if (message.destroy === true) {
      // A genuine in-flight close: the request was received, then the
      // connection dies before any response byte is written.
      record.req.socket.destroy();
      return;
    }
    const body = Buffer.from(typeof message.body === "string" ? message.body : "", "base64");
    const headers = {};
    if (message.status !== 204 && message.status !== 304) {
      headers["content-type"] = message.contentType || "application/json";
      headers["content-length"] = body.length;
    }
    record.res.writeHead(message.status, headers);
    record.res.end(message.status === 204 || message.status === 304 ? undefined : body);
  });

  process.on("disconnect", shutdown);

  api.listen(0, "127.0.0.1", () => {
    if (shuttingDown) {
      api.close();
      return;
    }
    control.listen(0, "127.0.0.1", () => {
      if (shuttingDown) {
        control.close();
        return;
      }
      if (process.connected) process.send({ type: "ready", api: api.address().port, control: control.address().port });
    });
  });
}

function runControl(port, action) {
  setTimeout(() => process.exit(3), CONTROL_GUARD_MS);
  const method = action === "close-idle" ? "POST" : "GET";
  const path = action === "close-idle" ? "/close-idle" : "/stats";
  const req = http.request({ host: "127.0.0.1", port, path, method, agent: false }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        process.exit(5);
      }
      if (res.statusCode !== 200) process.exit(6);
      const closed = Number.isSafeInteger(parsed?.closed) && parsed.closed >= 0 ? parsed.closed : -1;
      process.stdout.write(`${JSON.stringify({ ...pickStats(parsed), closed })}\n`);
      process.exit(0);
    });
  });
  req.on("error", () => process.exit(4));
  req.end();
}

const mode = process.argv[2];
if (mode === "server" && typeof process.send === "function") {
  runServer();
} else if (mode === "control" && /^[0-9]{1,5}$/.test(process.argv[3] ?? "") && ["stats", "close-idle"].includes(process.argv[4])) {
  runControl(Number(process.argv[3]), process.argv[4]);
} else {
  process.exit(2);
}
