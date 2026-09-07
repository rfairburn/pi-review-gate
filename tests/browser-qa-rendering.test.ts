import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import * as net from "node:net";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { normalizeConfig } from "../src/config";
import { InteractiveBrowserManager } from "../src/web/interactive-browser";

for (const kind of ["dedicated", "shared"] as const) {
  test(`real ${kind} worker cannot dial a private DNS destination`, { timeout: 15000 }, async () => {
    let port = 0, privateResolutions = 0, forbiddenDials = 0;
    const origin = createServer((request, response) => {
      if (request.url === "/worker.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        const fetch = `fetch('http://private.test:${port}/forbidden').catch(()=>{});`;
        response.end(kind === "dedicated" ? fetch : `onconnect=()=>{${fetch}}`);
      } else {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(`<main>Worker containment</main><script>new ${kind === "dedicated" ? "Worker" : "SharedWorker"}('/worker.js')</script>`);
      }
    });
    await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
    port = (origin.address() as net.AddressInfo).port;
    const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
      resolveHostname: async hostname => {
        if (hostname === "private.test") { privateResolutions++; return ["127.0.0.1"]; }
        return ["93.184.216.34"];
      },
      brokerDial: validated => {
        if (validated.hostname === "private.test") forbiddenDials++;
        return net.connect({ host: "127.0.0.1", port });
      },
    });
    try {
      await manager.open(`http://qa.test:${port}/`).catch(error => {
        assert.equal(error.category, "non_public_address_denied");
      });
      const deadline = Date.now() + 5000;
      while (!privateResolutions || manager.activeSessionCount()) {
        assert.ok(Date.now() < deadline, "worker refusal must reach fail-closed session cleanup");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.equal(forbiddenDials, 0);
    } finally {
      await manager.shutdown(); origin.closeAllConnections();
      await new Promise<void>(resolve => origin.close(() => resolve()));
    }
  });
}

// Decode only the lossless 8-bit RGB/RGBA screenshot format used by Chromium.
// This checks rendered pixels, rather than treating a PNG signature as layout.
function pixel(png: Buffer, x: number, y: number): number[] {
  const width = png.readUInt32BE(16);
  assert.equal(png[24], 8);
  const channels = png[25] === 2 ? 3 : png[25] === 6 ? 4 : 0;
  assert.ok(channels);
  assert.equal(png[28], 0);
  const chunks: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString("ascii", at + 4, at + 8) === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  let previous: Buffer = Buffer.alloc(stride);
  for (let row = 0; row <= y; row++) {
    const at = row * (stride + 1), filter = raw[at]!;
    const current = Buffer.from(raw.subarray(at + 1, at + 1 + stride));
    for (let col = 0; col < stride; col++) {
      const a = col >= channels ? current[col - channels]! : 0;
      const b = previous[col]!, c = col >= channels ? previous[col - channels]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2)
        : filter === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : NaN;
      assert.ok(Number.isFinite(predictor));
      current[col] = (current[col]! + predictor) & 255;
    }
    previous = current;
  }
  return [...previous.subarray(x * channels, x * channels + 3)];
}

function wav(): Buffer {
  const dataBytes = 1600;
  const b = Buffer.alloc(44 + dataBytes);
  b.write("RIFF"); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(dataBytes, 40);
  return b;
}

test("real QA renders network pixels/font/media, workers, SSE beyond 32MiB, and approved search", { timeout: 60000 }, async () => {
  let port = 0, submissions = 0, streamed = 0;
  const seen = new Set<string>();
  const streams = new Set<ServerResponse>();
  const origin = createServer((request, response) => {
    const path = new URL(request.url!, "http://fixture.test").pathname;
    seen.add(path);
    if (path === "/image.svg") {
      response.writeHead(200, { "content-type": "image/svg+xml" });
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#00ff00"/></svg>'); return;
    }
    if (path === "/font.ttf") {
      response.writeHead(200, { "content-type": "font/ttf" });
      response.end(readFileSync(require.resolve("pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf"))); return;
    }
    if (path === "/sound.wav") {
      response.writeHead(200, { "content-type": "audio/wav", "content-length": wav().length }); response.end(wav()); return;
    }
    if (path === "/worker.js" || path === "/shared.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      const work = `fetch('http://worker.test:${port}/worker-data').then(r=>r.text()).then(t=>TARGET.postMessage(t));`;
      response.end(path === "/worker.js" ? work.replace("TARGET", "self") : `onconnect=e=>{${work.replace("TARGET", "e.ports[0]")}}`); return;
    }
    if (path === "/worker-data") {
      response.writeHead(200, { "access-control-allow-origin": "*" }); response.end("ready"); return;
    }
    if (path === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      streams.add(response); response.on("close", () => streams.delete(response));
      const chunk = `:${"x".repeat(32765)}\n\n`;
      let remaining = 1100;
      const pump = () => {
        while (remaining-- > 0 && !response.destroyed) {
          streamed += Buffer.byteLength(chunk);
          if (!response.write(chunk)) { response.once("drain", pump); return; }
        }
        if (!response.destroyed) response.write("data: ready\n\n");
      };
      pump(); return;
    }
    if (path === "/search") {
      submissions++;
      assert.equal(new URL(request.url!, "http://fixture.test").searchParams.get("q"), "synthetic query");
      response.writeHead(200, { "content-type": "text/html" }); response.end("<main>Search completed with matching results</main>"); return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><title>QA rendering</title>
      <style>body{margin:0}main{padding-top:80px}img{position:absolute;top:0;left:0}</style>
      <img alt="QA green square" width="64" height="64" src="/image.svg">
      <main><p id="font">font pending</p><p id="media">media pending</p><p id="worker">worker pending</p>
      <p id="shared">shared pending</p><p id="sse">sse pending</p>
      <audio id="audio" preload="auto" src="/sound.wav"></audio>
      <form action="/search"><label>Search query<input name="q"></label><button>Search</button></form></main>
      <script>
      const mark=(id,text)=>document.getElementById(id).textContent=text;
      new FontFace('QA','url(/font.ttf)').load().then(font=>{document.fonts.add(font);document.querySelector('main').style.fontFamily='QA';mark('font','font ready')});
      const audio=document.getElementById('audio');audio.onloadeddata=()=>mark('media','media ready');
      new Worker('/worker.js').onmessage=e=>mark('worker','worker '+e.data);
      const shared=new SharedWorker('/shared.js');shared.port.onmessage=e=>mark('shared','shared '+e.data);shared.port.start();
      const sse=new EventSource('/events');sse.onmessage=e=>mark('sse','sse '+e.data);
      </script>`);
  });
  await new Promise<void>(resolve => origin.listen(0, "127.0.0.1", resolve));
  port = (origin.address() as net.AddressInfo).port;
  const dials = new Set<string>();
  const manager = new InteractiveBrowserManager(normalizeConfig({}).web!.fetch, {
    resolveHostname: async () => ["93.184.216.34"],
    brokerDial: validated => { dials.add(validated.hostname); return net.connect({ host: "127.0.0.1", port }); },
  });
  try {
    const opened = await manager.open(`http://qa.test:${port}/`);
    let snapshot = await manager.snapshot(opened.session, opened.tab, 4000);
    const deadline = Date.now() + 10000;
    while (!["font ready", "media ready", "worker ready", "shared ready", "sse ready"].every(text => snapshot.snapshot.includes(text))) {
      assert.ok(Date.now() < deadline, snapshot.snapshot);
      await new Promise(resolve => setTimeout(resolve, 50));
      snapshot = await manager.snapshot(opened.session, opened.tab, 4000);
    }
    assert.ok(streamed > 32 * 1024 * 1024);
    assert.ok(dials.has("worker.test"), "dedicated/shared worker fetch uses broker validation");
    for (const path of ["/image.svg", "/font.ttf", "/sound.wav", "/worker.js", "/shared.js", "/events"]) assert.ok(seen.has(path), path);
    const screenshot = await manager.screenshot(opened.session, opened.tab, "viewport", undefined);
    assert.deepEqual(pixel(screenshot.image, 32, 32), [0, 255, 0], "network image is visibly painted, not omitted");
    const input = snapshot.snapshot.match(/textbox "Search query" \[ref=([^\]]+)\]/)?.[1];
    let submit = snapshot.snapshot.match(/button "Search" \[ref=([^\]]+)\]/)?.[1];
    assert.ok(input); assert.ok(submit);
    let approvals = 0;
    const approve = async () => { approvals++; return true; };
    await manager.fill(opened.session, opened.tab, input, "synthetic query", approve);
    snapshot = await manager.snapshot(opened.session, opened.tab, 4000);
    submit = snapshot.snapshot.match(/button "Search" \[ref=([^\]]+)\]/)?.[1];
    assert.ok(submit);
    await assert.rejects(manager.click(opened.session, opened.tab, submit), /confirmation/);
    assert.equal(submissions, 0);
    await manager.click(opened.session, opened.tab, submit, approve);
    assert.ok(approvals >= 1);
    assert.equal(submissions, 1);
    assert.match((await manager.snapshot(opened.session, opened.tab, 4000)).snapshot, /Search completed with matching results/);
    await manager.close(opened.session);
    assert.equal(manager.activeSessionCount(), 0);
  } finally {
    await manager.shutdown();
    for (const response of streams) response.destroy();
    origin.closeAllConnections();
    await new Promise<void>(resolve => origin.close(() => resolve()));
  }
});
