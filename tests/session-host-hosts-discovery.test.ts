import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  MAX_PEER_DESTINATIONS,
  MAX_PEER_DESTINATION_ID_CHARS,
  MAX_PEER_DESTINATION_ID_UTF8_BYTES,
  isValidPeerDestinationId,
} from "../src/session-host/peer-destination-id";
import {
  DEFAULT_PEER_PREFERENCES,
  MAX_PEER_DESTINATIONS as STORE_MAX_PEER_DESTINATIONS,
  MAX_PEER_DESTINATION_ID_CHARS as STORE_MAX_PEER_DESTINATION_ID_CHARS,
  validatePeerPreferences,
} from "../src/session-host/network/peer-preferences-store";
import {
  MAX_SESSION_HOSTS_RESULT_PARTS,
  MAX_SESSION_SPAWN_HOST_BYTES,
  MAX_STATUS_FRAME_BYTES,
  SessionHostsResultAssembler,
  decodeFrame,
  encodeFrame,
  encodeSessionHostsResultFrames,
  isValidSessionSpawnHost,
  parseBootstrap,
  parseHostsRequest,
  parseHostsResult,
  parseSessionHostsSnapshot,
  parseSpawnRequest,
  type SessionHostHostsResult,
  type SessionHostsInspection,
  type SessionHostsSnapshot,
} from "../src/session-host/protocol";
import {
  SESSION_HOSTS_TOOL_NAME,
  parseSessionHostsInput,
  registerSessionHostsTool,
  sessionHostsToolSchema,
} from "../src/session-host/hosts-tool";
import {
  SESSION_SPAWN_DISCOVERY_GUIDANCE,
  parseSessionSpawnInput,
  registerSessionSpawnTool,
} from "../src/session-host/spawn-tool";
import type { SessionHostSpawnCapability } from "../src/session-host/spawn-capability";
import type { SessionSpawnOutcome } from "../src/session-host/protocol";

/** Ids the existing preferences store accepts, including padded, Unicode, and boundary-length values. */
const VALID_SAVED_IDS = [
  "laptop",
  " laptop",
  "laptop ",
  "  padded both  ",
  "Büro laptop (2) — 日本",
  "__proto__",
  "x".repeat(MAX_PEER_DESTINATION_ID_CHARS),
  "\u{1F680}".repeat(MAX_PEER_DESTINATION_ID_CHARS / 2),
  "\ud800".repeat(MAX_PEER_DESTINATION_ID_CHARS),
  "ࠀ".repeat(MAX_PEER_DESTINATION_ID_CHARS),
  "quote\"back\\slash",
];

const INVALID_SAVED_IDS: unknown[] = [
  "",
  "x".repeat(MAX_PEER_DESTINATION_ID_CHARS + 1),
  "\u{1F680}".repeat(MAX_PEER_DESTINATION_ID_CHARS / 2 + 1),
  "lap\ntop",
  "lap\ttop",
  "lap\u0000top",
  "lap\u007ftop",
  "lap\u0085top",
  "lap\u2028top",
  "lap\u2029top",
  42,
  null,
  undefined,
];

function storeAccepts(id: unknown): boolean {
  try {
    validatePeerPreferences({
      ...DEFAULT_PEER_PREFERENCES,
      destinations: [{ id, label: "Host", host: "127.0.0.1", port: 40_001, previouslyConnected: false, reconnectSuppressed: false }],
    });
    return true;
  } catch {
    return false;
  }
}

function identity(requestId = randomUUID()) {
  return { instanceId: randomUUID(), generation: randomUUID(), token: "a".repeat(64), requestId };
}

function decodePages(frames: readonly string[]): SessionHostHostsResult[] {
  return frames.map((frame) => {
    assert.ok(Buffer.byteLength(frame, "utf8") <= MAX_STATUS_FRAME_BYTES, "every page fits one existing IPC frame");
    const decoded = decodeFrame(frame);
    assert.ok(decoded && decoded.type === "hosts_result", "every page decodes through the shared wire decoder");
    return decoded as SessionHostHostsResult;
  });
}

function assemble(pages: readonly SessionHostHostsResult[], requestId: string) {
  const assembler = new SessionHostsResultAssembler(requestId);
  let step: ReturnType<SessionHostsResultAssembler["accept"]> = { status: "pending" };
  for (const page of pages) step = assembler.accept(page);
  return step;
}

function largeSnapshot(): SessionHostsSnapshot {
  const hosts = [];
  for (let index = 0; index < MAX_PEER_DESTINATIONS; index += 1) {
    // Worst-case JSON escaping (unpaired surrogates) for half, 3-byte UTF-8 for the rest; all unique and max length.
    const tag = String(index).padStart(2, "0");
    const id = index % 2 === 0
      ? `${tag}${"\udc00".repeat(MAX_PEER_DESTINATION_ID_CHARS - 2)}`
      : `${tag}${"日".repeat(MAX_PEER_DESTINATION_ID_CHARS - 3)} `;
    hosts.push({ id, kinds: ["pi", "claude", "codex"] as const });
  }
  return { ownKinds: ["pi", "claude", "codex"], hosts };
}

describe("saved paired-destination id contract", () => {
  it("shares the preferences store bounds and predicate exactly", () => {
    assert.equal(MAX_PEER_DESTINATIONS, STORE_MAX_PEER_DESTINATIONS);
    assert.equal(MAX_PEER_DESTINATION_ID_CHARS, STORE_MAX_PEER_DESTINATION_ID_CHARS);
    for (const id of [...VALID_SAVED_IDS, ...INVALID_SAVED_IDS]) {
      assert.equal(isValidPeerDestinationId(id), storeAccepts(id), `parity for ${JSON.stringify(id)}`);
    }
    for (const id of VALID_SAVED_IDS) assert.equal(isValidPeerDestinationId(id), true);
  });

  it("admits every existing saved id as an exact SessionSpawn host selector without trimming", () => {
    for (const id of VALID_SAVED_IDS) {
      assert.ok(Buffer.byteLength(id, "utf8") <= MAX_SESSION_SPAWN_HOST_BYTES, "the byte bound derives from the char bound");
      assert.equal(isValidSessionSpawnHost(id), true, `selector ${JSON.stringify(id)}`);
      const parsed = parseSessionSpawnInput({ workspace: "/existing", title: "Title", prompt: "Start.", host: id });
      assert.equal(parsed.host, id, "the raw id is preserved exactly");
      const frame = parseSpawnRequest({
        version: 1,
        type: "spawn_routed_request",
        instanceId: randomUUID(),
        generation: randomUUID(),
        token: "a".repeat(64),
        requestId: randomUUID(),
        workspace: "/existing",
        title: "Title",
        payload: { name: `p-${"0".repeat(32)}.json`, size: 2, sha256: "0".repeat(64) },
        host: id,
      });
      assert.equal(frame?.host, id);
    }
    assert.equal(MAX_SESSION_SPAWN_HOST_BYTES, MAX_PEER_DESTINATION_ID_UTF8_BYTES);
    for (const id of INVALID_SAVED_IDS) assert.equal(isValidSessionSpawnHost(id), false);
  });
});

describe("SessionHosts canonical snapshot and bootstrap marker", () => {
  it("validates closed shapes, unique ids, closed kinds, and the existing destination bound", () => {
    const snapshot = parseSessionHostsSnapshot({
      ownKinds: ["codex", "pi"],
      hosts: [{ id: " laptop", kinds: ["claude", "pi"] }, { id: "laptop", kinds: [] }],
    });
    assert.deepEqual(snapshot, {
      ownKinds: ["pi", "codex"],
      hosts: [{ id: " laptop", kinds: ["pi", "claude"] }, { id: "laptop", kinds: [] }],
    }, "kinds are canonicalized; padded and unpadded ids are distinct exact ids");
    const invalid: unknown[] = [
      undefined,
      [],
      { ownKinds: ["pi"] },
      { ownKinds: ["pi"], hosts: [], extra: true },
      { ownKinds: ["pi", "pi"], hosts: [] },
      { ownKinds: ["gemini"], hosts: [] },
      { ownKinds: "pi", hosts: [] },
      { ownKinds: [], hosts: [{ id: "a", kinds: ["pi"], label: "A" }] },
      { ownKinds: [], hosts: [{ id: "a" }] },
      { ownKinds: [], hosts: [{ id: "", kinds: [] }] },
      { ownKinds: [], hosts: [{ id: "a\nb", kinds: [] }] },
      { ownKinds: [], hosts: [{ id: "a", kinds: [] }, { id: "a", kinds: ["pi"] }] },
      { ownKinds: [], hosts: Array.from({ length: MAX_PEER_DESTINATIONS + 1 }, (_, index) => ({ id: `h${index}`, kinds: [] })) },
    ];
    for (const value of invalid) assert.equal(parseSessionHostsSnapshot(value), undefined, JSON.stringify(value));
  });

  it("admits the discovery bootstrap marker only as mode 1 together with routed spawn", () => {
    const base = {
      version: 1 as const,
      socketPath: `\\\\.\\pipe\\prg-st-${"a".repeat(32)}`,
      token: "a".repeat(64),
      instanceId: randomUUID(),
      generation: randomUUID(),
      payloadDir: "/tmp/prg-pl-payload",
    };
    assert.equal(parseBootstrap(base)?.sessionHosts, undefined);
    assert.equal(parseBootstrap({ ...base, spawnRouting: 1, sessionHosts: 1 })?.sessionHosts, 1);
    assert.equal(parseBootstrap({ ...base, sessionHosts: 1 }), undefined, "discovery without routing is refused");
    for (const sessionHosts of [0, 2, "1", true, null]) {
      assert.equal(parseBootstrap({ ...base, spawnRouting: 1, sessionHosts }), undefined, `marker ${JSON.stringify(sessionHosts)}`);
    }
  });

  it("strictly validates the read-only request frame", () => {
    const request = { version: 1, type: "hosts_request", ...identity() };
    assert.deepEqual(parseHostsRequest(request), request);
    assert.equal(decodeFrame(encodeFrame(request as never))?.type, "hosts_request");
    assert.equal(parseHostsRequest({ ...request, workspace: "/tmp" }), undefined, "no user data rides on discovery");
    assert.equal(parseHostsRequest({ ...request, token: "short" }), undefined);
  });
});

describe("SessionHosts bounded multi-frame transport", () => {
  it("sends the small common case as one frame and round-trips all three kinds", () => {
    const id = identity();
    const snapshot = { ownKinds: ["pi", "claude", "codex"], hosts: [{ id: "laptop", kinds: ["codex"] }] };
    const frames = encodeSessionHostsResultFrames(id, snapshot);
    assert.equal(frames.length, 1);
    const pages = decodePages(frames);
    assert.equal(pages[0]!.token, id.token, "every page is token-authenticated");
    assert.deepEqual(assemble(pages, id.requestId), { status: "complete", snapshot });
    const empty = encodeSessionHostsResultFrames(id, { ownKinds: [], hosts: [] });
    assert.deepEqual(assemble(decodePages(empty), id.requestId), { status: "complete", snapshot: { ownKinds: [], hosts: [] } });
  });

  it("splits 64 long opaque Unicode ids across bounded frames and reassembles them completely", () => {
    const id = identity();
    const snapshot = largeSnapshot();
    const frames = encodeSessionHostsResultFrames(id, snapshot);
    assert.ok(frames.length > 1, "a worst-case snapshot exceeds one 16 KiB frame");
    assert.ok(frames.length <= MAX_SESSION_HOSTS_RESULT_PARTS, "the transport-derived page bound holds");
    const pages = decodePages(frames);
    for (const [index, page] of pages.entries()) {
      assert.equal(page.part, index);
      assert.equal(page.parts, frames.length);
      assert.equal(Object.hasOwn(page, "ownKinds"), index === 0, "only page 0 carries ownKinds");
      assert.ok((page.hosts?.length ?? 0) > 0);
    }
    const step = assemble(pages, id.requestId);
    assert.equal(step.status, "complete");
    assert.deepEqual((step as { snapshot: SessionHostsSnapshot }).snapshot, snapshot, "no host was truncated or rewritten");
  });

  it("encodes an invalid snapshot as one unavailable page, never a partial listing", () => {
    const id = identity();
    for (const bad of [undefined, { ownKinds: ["pi"], hosts: [{ id: "a", kinds: ["x"] }] }, { ownKinds: [], hosts: [{ id: "", kinds: [] }] }]) {
      const pages = decodePages(encodeSessionHostsResultFrames(id, bad));
      assert.equal(pages.length, 1);
      assert.equal(pages[0]!.outcome, "unavailable");
      assert.equal(Object.hasOwn(pages[0]!, "hosts"), false);
      assert.deepEqual(assemble(pages, id.requestId), { status: "unavailable" });
    }
  });

  it("rejects malformed, reordered, duplicated, inconsistent, and incomplete page sequences", () => {
    const id = identity();
    const pages = decodePages(encodeSessionHostsResultFrames(id, largeSnapshot()));
    assert.ok(pages.length >= 2);
    const [first, second] = pages as [SessionHostHostsResult, SessionHostHostsResult];
    const invalid = (sequence: SessionHostHostsResult[], label: string) =>
      assert.deepEqual(assemble(sequence, id.requestId), { status: "invalid" }, label);
    invalid([second], "a later page first");
    invalid([first, first], "a duplicated page");
    invalid([first, { ...second, parts: second.parts + 1 }], "a changed part count");
    invalid([first, { ...second, ownKinds: ["pi"] }], "ownKinds on a later page");
    invalid([{ ...first, requestId: randomUUID() }], "a foreign request id");
    invalid([first, { ...first, part: 1, hosts: first.hosts, ownKinds: undefined } as never], "an id repeated across pages");
    invalid([first, { ...first, outcome: "unavailable", part: 0, parts: 1 } as never], "unavailable after a complete page");
    const { ownKinds: _omitted, ...missingOwn } = first;
    invalid([missingOwn as SessionHostHostsResult], "page 0 without ownKinds");
    assert.deepEqual(assemble(pages.slice(0, -1), id.requestId), { status: "pending" }, "an incomplete sequence is never complete");
    const finished = new SessionHostsResultAssembler(id.requestId);
    for (const page of pages) finished.accept(page);
    assert.deepEqual(finished.accept(pages[0]!), { status: "invalid" }, "nothing is accepted after completion");

    const wire = JSON.parse(encodeSessionHostsResultFrames(id, largeSnapshot())[0]!) as Record<string, unknown>;
    const malformed: Array<Record<string, unknown>> = [
      { ...wire, parts: MAX_SESSION_HOSTS_RESULT_PARTS + 1 },
      { ...wire, part: wire.parts },
      { ...wire, part: -1 },
      { ...wire, hosts: [] },
      { ...wire, ownKinds: ["codex", "pi"] },
      { ...wire, hosts: [{ id: "a", kinds: ["pi"], extra: 1 }] },
      { ...wire, prompt: "leak" },
      { ...wire, token: "b" },
      { ...wire, outcome: "partial" },
      { ...wire, outcome: "unavailable" },
    ];
    for (const value of malformed) assert.equal(parseHostsResult(value), undefined, JSON.stringify(Object.keys(value)));
  });
});

describe("SessionHosts tool registration and SessionSpawn guidance", () => {
  function capability(overrides: Partial<SessionHostSpawnCapability> = {}): SessionHostSpawnCapability {
    return {
      titleColumns: 32,
      routing: true,
      spawn: async (): Promise<SessionSpawnOutcome> => { throw new Error("discovery must never spawn"); },
      ...overrides,
    };
  }

  function register(cap: SessionHostSpawnCapability | undefined) {
    const tools = new Map<string, Record<string, unknown>>();
    const pi = { registerTool: (definition: Record<string, unknown>) => tools.set(definition.name as string, definition) };
    const hosts = registerSessionHostsTool(pi, cap);
    const spawn = registerSessionSpawnTool(pi, cap);
    return { tools, hosts, spawn };
  }

  it("is absent without an actual routed inspection capability, and SessionSpawn carries no discovery guidance", () => {
    const inspectHosts = async (): Promise<SessionHostsInspection> => ({ outcome: "unavailable", reason: "timeout" });
    for (const cap of [undefined, capability(), capability({ routing: false, inspectHosts })]) {
      const { tools, hosts } = register(cap);
      assert.equal(hosts, false);
      assert.equal(tools.has(SESSION_HOSTS_TOOL_NAME), false);
      const spawnTool = tools.get("SessionSpawn");
      if (spawnTool) assert.equal(JSON.stringify(spawnTool).includes("SessionHosts"), false, "no pointer to an unavailable tool");
    }
  });

  it("registers a static read-only schema and returns identical text, details, and structured content", async () => {
    const snapshot: SessionHostsSnapshot = {
      ownKinds: ["pi", "claude", "codex"],
      hosts: [{ id: " Büro laptop", kinds: ["pi", "codex"] }, { id: "desk", kinds: ["claude"] }],
    };
    const signals: Array<AbortSignal | undefined> = [];
    const spawnCalls: unknown[] = [];
    const cap = capability({
      spawn: async (input) => { spawnCalls.push(input); return "failed"; },
      inspectHosts: async (signal) => { signals.push(signal); return { outcome: "complete", snapshot }; },
    });
    const { tools, hosts } = register(cap);
    assert.equal(hosts, true);
    const tool = tools.get(SESSION_HOSTS_TOOL_NAME)!;
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false });
    assert.match(String(tool.description), /may refresh an existing owner's metadata subscription/);
    assert.doesNotMatch(String(tool.description), /changes nothing/);
    assert.deepEqual(tool.parameters, sessionHostsToolSchema());
    assert.deepEqual(tool.parameters, { type: "object", additionalProperties: false, properties: {} }, "no dynamic roster or enum");
    assert.equal(JSON.stringify(tool.parameters).includes("desk"), false);
    const outputSchema = tool.outputSchema as { required: string[]; properties: Record<string, unknown> };
    assert.deepEqual(outputSchema.required, ["ownKinds", "hosts"]);
    assert.equal(JSON.stringify(outputSchema).includes("desk"), false, "the output schema is static too");

    const controller = new AbortController();
    const execute = tool.execute as (id: string, params: unknown, signal?: AbortSignal) => Promise<Record<string, unknown>>;
    const result = await execute("call", {}, controller.signal);
    assert.deepEqual(result.structuredContent, snapshot);
    assert.deepEqual(result.details, snapshot);
    assert.match((result.content as Array<{ text: string }>)[0]!.text, /not a permission grant or launch receipt/);
    assert.ok((result.content as Array<{ text: string }>)[0]!.text.includes(JSON.stringify(snapshot)));
    assert.deepEqual(signals, [controller.signal]);
    assert.deepEqual(spawnCalls, [], "discovery never spawns");
    await assert.rejects(execute("call", { host: "desk" }), /takes no arguments/);
    assert.deepEqual(parseSessionHostsInput(undefined), {});

    const spawnTool = tools.get("SessionSpawn")!;
    const spawnText = JSON.stringify(spawnTool);
    assert.ok(spawnText.includes(SESSION_SPAWN_DISCOVERY_GUIDANCE), "static SessionHosts guidance appears with the capability");
    assert.equal(spawnText.includes("desk"), false, "SessionSpawn never embeds a host roster");
    assert.equal((spawnTool.parameters as { properties: { host: { maxLength: number } } }).properties.host.maxLength,
      MAX_PEER_DESTINATION_ID_CHARS);
  });

  it("reports unavailable inspection as an error that claims nothing about host absence", async () => {
    for (const reason of ["timeout", "disconnected", "cancelled", "protocol", "host-unavailable", "not-connected", "busy"] as const) {
      const { tools } = register(capability({ inspectHosts: async () => ({ outcome: "unavailable", reason }) }));
      const execute = tools.get(SESSION_HOSTS_TOOL_NAME)!.execute as (id: string, params: unknown) => Promise<unknown>;
      await assert.rejects(execute("call", {}), /unavailable: .*does not mean no paired hosts exist; no session was started, no trust or settings were changed, and no retry was made/);
    }
  });
});
