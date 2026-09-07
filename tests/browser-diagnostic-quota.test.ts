import assert from "node:assert/strict";
import test from "node:test";
import { BrowserDiagnosticQuota, DiagnosticRing } from "../src/web/interactive-browser";

type Event = { sequence: number; text: string };

test("diagnostic quota counts sanitized UTF-8 bytes across tab-isolated rings", () => {
  const bytes = Buffer.byteLength(JSON.stringify({ text: "😀".repeat(20), sequence: 1 }));
  const quota = new BrowserDiagnosticQuota(256, bytes * 2);
  const first = new DiagnosticRing<Event>(256, quota);
  const second = new DiagnosticRing<Event>(256, quota);
  first.push({ text: "😀".repeat(20) });
  second.push({ text: "😀".repeat(20) });
  first.push({ text: "😀".repeat(20) });
  assert.deepEqual(first.read(0, 256).events.map(event => event.sequence), [2]);
  assert.equal(first.read(0, 256).dropped, 1);
  assert.equal(second.read(0, 256).events.length, 1);
  second.clear();
  first.push({ text: "😀".repeat(20) });
  assert.equal(first.read(0, 256).events.length, 2);
  assert.equal(second.read(0, 256).events.length, 0);
});

test("shared count retention stays bounded during sustained capture and clear releases quota", () => {
  const quota = new BrowserDiagnosticQuota();
  const rings = Array.from({ length: 4 }, () => new DiagnosticRing<Event>(256, quota));
  for (let i = 0; i < 10000; i++) rings[i % 4]!.push({ text: `event ${i}` });
  const reads = rings.map(ring => ring.read(0, 256));
  assert.equal(reads.reduce((sum, read) => sum + read.events.length, 0), 256);
  assert.equal(reads.reduce((sum, read) => sum + read.totalDropped, 0), 9744);
  for (const ring of rings) ring.clear();
  for (let i = 0; i < 256; i++) rings[0]!.push({ text: "new" });
  assert.equal(rings[0]!.read(0, 256).totalDropped, 0);
});

test("a single oversize capture is dropped with a truthful advancing cursor", () => {
  const ring = new DiagnosticRing<Event>(256);
  ring.push({ text: "😀".repeat(300000) });
  const read = ring.read(0, 256);
  assert.equal(read.events.length, 0);
  assert.equal(read.next, 1);
  assert.equal(read.dropped, 1);
});
