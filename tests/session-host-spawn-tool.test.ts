import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getSessionHostSpawnCapability, publishSessionHostSpawnCapability, revokeSessionHostSpawnCapability, SESSION_HOST_SPAWN_CAPABILITY_KEY } from "../src/session-host/spawn-capability";
import {
  SESSION_SPAWN_TOOL_NAME,
  parseSessionSpawnInput,
  registerSessionSpawnTool,
  sessionSpawnResult,
  sessionSpawnToolSchema,
} from "../src/session-host/spawn-tool";
import type { SessionSpawnInput, SessionSpawnOutcome } from "../src/session-host/protocol";

function cleanCapability(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[SESSION_HOST_SPAWN_CAPABILITY_KEY];
}

describe("SessionSpawn tool registration and contract", () => {
  it("is absent without the reporter's process-local capability", () => {
    cleanCapability();
    const registrations: Record<string, unknown>[] = [];
    const pi = { registerTool: (definition: Record<string, unknown>) => registrations.push(definition) };

    assert.equal(getSessionHostSpawnCapability(), undefined);
    assert.equal(registerSessionSpawnTool(pi, getSessionHostSpawnCapability()), false);
    assert.deepEqual(registrations, []);
  });

  it("registers the exact required fields and forwards them unchanged through the capability", async () => {
    cleanCapability();
    const calls: Array<{ input: SessionSpawnInput; signal?: AbortSignal }> = [];
    const capability = {
      titleColumns: 32,
      async spawn(input: SessionSpawnInput, signal?: AbortSignal): Promise<SessionSpawnOutcome> {
        calls.push({ input, ...(signal ? { signal } : {}) });
        return "started";
      },
    };
    publishSessionHostSpawnCapability(capability);
    assert.equal(getSessionHostSpawnCapability(), capability);

    const registrations: Record<string, unknown>[] = [];
    const pi = { registerTool: (definition: Record<string, unknown>) => registrations.push(definition) };
    assert.equal(registerSessionSpawnTool(pi, getSessionHostSpawnCapability()), true);
    assert.equal(registrations.length, 1);
    const tool = registrations[0]!;
    assert.equal(tool.name, SESSION_SPAWN_TOOL_NAME);
    assert.equal(tool.executionMode, "sequential");
    assert.deepEqual(sessionSpawnToolSchema(32).required, ["workspace", "title", "prompt"]);
    assert.equal(sessionSpawnToolSchema(32).additionalProperties, false);
    const parameters = tool.parameters as { properties: Record<string, { description: string; maxLength?: number }> };
    assert.match(parameters.properties.title!.description, /32 terminal columns.*optimal\/soft target, not a maximum/);
    assert.match(parameters.properties.title!.description, /Pi 1\.1\.0 trims it.*No host-side width-based clipping or shortening/);
    assert.equal(parameters.properties.prompt!.maxLength, undefined, "the advertised prompt schema has no fixed length ceiling");
    assert.equal(parameters.properties.workspace!.maxLength !== undefined, true, "workspace keeps its independent transport bound");
    assert.equal(parameters.properties.title!.maxLength !== undefined, true, "title keeps its independent transport bound");

    const input = {
      workspace: "/existing workspace",
      title: "Title longer than the normal sidebar width ".repeat(7),
      prompt: "--session is ordinary prompt content\nKeep the trailing newline.\n",
    };
    const signal = new AbortController().signal;
    const result = await (tool.execute as (id: string, params: unknown, signal?: AbortSignal) => Promise<Record<string, unknown>>)(
      "call-id", input, signal,
    );
    assert.deepEqual(calls, [{ input, signal }]);
    assert.equal(result.details && (result.details as { outcome?: string }).outcome, "started");
    assert.equal(JSON.stringify(result).includes(input.prompt), false, "tool result never echoes prompt text");
    assert.match((result.content as Array<{ text: string }>)[0]!.text, /confirms launch only/);

    revokeSessionHostSpawnCapability(capability);
    assert.equal(getSessionHostSpawnCapability(), undefined);
  });

  it("describes launch facts without claiming current liveness or an invented uncertainty cause", () => {
    const textOf = (outcome: SessionSpawnOutcome) => (sessionSpawnResult(outcome).content as Array<{ text: string }>)[0]!.text;
    const started = textOf("started");
    assert.match(started, /process launched.*confirms launch only.*may not yet have been processed/);
    assert.doesNotMatch(started, /is running/);
    const unknown = textOf("unknown");
    assert.match(unknown, /could not confirm the child launch outcome.*may exist or may already have exited/);
    assert.match(unknown, /No automatic retry was made/);
    assert.doesNotMatch(unknown, /because the request timed out/);
    for (const outcome of ["started", "failed", "unknown"] as const) {
      assert.deepEqual(sessionSpawnResult(outcome).details, { outcome });
    }
  });

  it("rejects extra, empty, unsafe, and over-bound workspace/title arguments without invoking a host", () => {
    const valid = { workspace: "/existing", title: "Title", prompt: "Start." };
    assert.deepEqual(parseSessionSpawnInput(valid), valid);
    assert.throws(() => parseSessionSpawnInput({ ...valid, other: "field" }), /exactly workspace, title, and prompt, plus optional host and kind/);
    assert.throws(() => parseSessionSpawnInput({ workspace: "/existing", title: "Title", kind: "pi" }), /exactly workspace/);
    assert.throws(() => parseSessionSpawnInput({ ...valid, workspace: "" }), /workspace/);
    assert.throws(() => parseSessionSpawnInput({ ...valid, workspace: "/tmp/\0bad" }), /workspace/);
    assert.throws(() => parseSessionSpawnInput({ ...valid, title: "  " }), /title/);
    assert.throws(() => parseSessionSpawnInput({ ...valid, title: "bad\ntitle" }), /title/);
    assert.throws(() => parseSessionSpawnInput({ ...valid, prompt: "" }), /prompt/);
    assert.throws(() => parseSessionSpawnInput({ ...valid, prompt: "bad\0prompt" }), /prompt/);
  });

  it("accepts and preserves an exact prompt far beyond the former 8 KiB ceiling", () => {
    const structured = [
      "BEGIN exact long prompt",
      "ASCII line with quotes \"double\" and 'single'.",
      "Multibyte: 日本語 — café — 🚀",
      "Flag-looking: --session /tmp/not-a-session @literal.md /prompt-template literal",
      "MIDDLE".repeat(1_500),
      "Surrogate pair kept exactly: \u{1F642}",
      "Trailing newline remains data.\n",
      "END exact long prompt",
    ].join("\n");
    assert.ok(Buffer.byteLength(structured, "utf8") > 8192);
    assert.deepEqual(parseSessionSpawnInput({ workspace: "/existing", title: "Long exact prompt", prompt: structured }), {
      workspace: "/existing",
      title: "Long exact prompt",
      prompt: structured,
    });
  });

  it("keeps the legacy three-argument call as an own-host Pi request with no defaulted selectors", () => {
    const legacy = parseSessionSpawnInput({ workspace: "/existing", title: "Title", prompt: "Start." });
    assert.deepEqual(Object.keys(legacy).sort(), ["prompt", "title", "workspace"],
      "omitted host/kind stay absent: never filled from a selected or viewed host");
  });

  it("parses optional host and kind exactly and strictly", () => {
    const valid = { workspace: "/existing", title: "Title", prompt: "Start." };
    const host = "Büro laptop (2) — 日本";
    assert.deepEqual(parseSessionSpawnInput({ ...valid, host, kind: "codex" }), { ...valid, host, kind: "codex" });
    assert.deepEqual(parseSessionSpawnInput({ ...valid, kind: "pi" }), { ...valid, kind: "pi" },
      "an explicit kind is retained, not collapsed into the legacy form");
    assert.deepEqual(parseSessionSpawnInput({ ...valid, host }), { ...valid, host });
    for (const kind of ["Pi", "gemini", "", null, 1]) {
      assert.throws(() => parseSessionSpawnInput({ ...valid, kind }), /kind must be one of pi, claude, codex/);
    }
    for (const badHost of ["", "lap\ntop", "lap\u0000top", "lap\u2028top", "h".repeat(129), undefined, null, 7]) {
      assert.throws(() => parseSessionSpawnInput({ ...valid, host: badHost }), /host must be an exact paired host id/);
    }
    // Existing saved paired-destination ids are opaque and exact: padding is part of the id.
    for (const savedId of [" laptop", "laptop ", "h".repeat(128)]) {
      assert.equal(parseSessionSpawnInput({ ...valid, host: savedId }).host, savedId);
    }
  });

  it("refuses host/kind without routed-spawn support and never invokes the host capability", async () => {
    cleanCapability();
    let calls = 0;
    const capability = {
      titleColumns: 32,
      async spawn(): Promise<SessionSpawnOutcome> { calls += 1; return "started"; },
    };
    const registrations: Record<string, unknown>[] = [];
    assert.equal(registerSessionSpawnTool({ registerTool: (d: Record<string, unknown>) => registrations.push(d) }, capability), true);
    const tool = registrations[0]!;
    const parameters = tool.parameters as { properties: Record<string, unknown> };
    assert.deepEqual(Object.keys(parameters.properties).sort(), ["prompt", "title", "workspace"],
      "an unsupported session does not advertise routing selectors");
    const execute = tool.execute as (id: string, params: unknown) => Promise<Record<string, unknown>>;
    for (const selectors of [{ kind: "pi" }, { kind: "claude" }, { host: "laptop" }, { host: "laptop", kind: "codex" }]) {
      await assert.rejects(
        execute("call", { workspace: "/existing", title: "Title", prompt: "Start.", ...selectors }),
        /routing is not available in this session, so nothing was started/,
      );
    }
    assert.equal(calls, 0, "no selector is dropped to launch a local Pi child instead");
    const legacy = await execute("call", { workspace: "/existing", title: "Title", prompt: "Start." });
    assert.equal((legacy.details as { outcome: string }).outcome, "started", "the legacy call is unchanged");
    assert.equal(calls, 1);
  });

  it("advertises and forwards exact selectors only with routed-spawn support", async () => {
    const calls: SessionSpawnInput[] = [];
    const capability = {
      titleColumns: 40,
      routing: true,
      async spawn(input: SessionSpawnInput): Promise<SessionSpawnOutcome> { calls.push(input); return "unknown"; },
    };
    const registrations: Record<string, unknown>[] = [];
    assert.equal(registerSessionSpawnTool({ registerTool: (d: Record<string, unknown>) => registrations.push(d) }, capability), true);
    const tool = registrations[0]!;
    const schema = tool.parameters as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { enum?: string[]; description: string; maxLength?: number }>;
    };
    assert.deepEqual(schema.required, ["workspace", "title", "prompt"], "selectors stay optional");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.kind!.enum, ["pi", "claude", "codex"]);
    assert.equal(schema.properties.host!.maxLength, 128, "the saved paired-destination id bound");
    assert.equal(JSON.stringify(tool).includes("SessionHosts"), false, "no discovery pointer without the inspection capability");
    assert.match(schema.properties.host!.description, /never means the host currently selected or viewed/);
    assert.match(schema.properties.kind!.description, /Omit it for pi.*never falls back/);
    // Routed wording is kind-general: no claim that every child uses Pi's
    // native title API or receives the prompt verbatim as its first message.
    assert.doesNotMatch(schema.properties.title!.description, /Pi's native session-name API/);
    assert.match(schema.properties.title!.description, /child kind's normal session-title handling/);
    assert.match(schema.properties.title!.description, /optimal\/soft target, not a maximum/);
    assert.match(schema.properties.prompt!.description, /stored losslessly in a host-owned file, with a short startup instruction asking the provider to read it/);
    assert.match(schema.properties.prompt!.description, /not necessarily the verbatim prompt/);
    assert.match(JSON.stringify(tool.promptGuidelines), /success confirms launch only, not that the prompt was read or completed/);
    assert.match(String(tool.description), /a Pi child on this session's own host unless/);
    // Legacy Pi-only wording stays exactly compatible.
    const legacySchema = sessionSpawnToolSchema(40) as { properties: Record<string, { description: string }> };
    assert.match(legacySchema.properties.title!.description, /Pi's native session-name API.*Pi 1\.1\.0 trims it/);
    assert.match(legacySchema.properties.prompt!.description, /^Exact initial user prompt sent to the new child\./);
    assert.deepEqual(sessionSpawnToolSchema(40), sessionSpawnToolSchema(40, { routing: false }));
    assert.equal(Object.hasOwn((sessionSpawnToolSchema(40).properties as object), "kind"), false);

    const prompt = ["--host other", "日本語 🚀", "line\n"].join("\n").repeat(30_000);
    assert.ok(Buffer.byteLength(prompt, "utf8") > 128 * 1024);
    const execute = tool.execute as (id: string, params: unknown) => Promise<Record<string, unknown>>;
    const routed = { workspace: "/existing", title: "Title", prompt, host: "laptop", kind: "claude" };
    const result = await execute("call", routed);
    assert.deepEqual(calls, [routed]);
    assert.equal((result.details as { outcome: string }).outcome, "unknown");
    assert.match((result.content as Array<{ text: string }>)[0]!.text, /No automatic retry was made/);
    await execute("call", { workspace: "/existing", title: "Title", prompt: "Start." });
    assert.deepEqual(Object.keys(calls[1]!).sort(), ["prompt", "title", "workspace"],
      "a routing-capable session still forwards the legacy call without defaulted selectors");
  });

  it("a replaced reporter capability cannot be revoked by a stale incarnation", () => {
    cleanCapability();
    const oldCapability = { titleColumns: 32, spawn: async () => "unknown" as const };
    const newCapability = { titleColumns: 44, spawn: async () => "started" as const };
    publishSessionHostSpawnCapability(oldCapability);
    publishSessionHostSpawnCapability(newCapability);
    revokeSessionHostSpawnCapability(oldCapability);
    assert.equal(getSessionHostSpawnCapability(), newCapability);
    cleanCapability();
  });
});
