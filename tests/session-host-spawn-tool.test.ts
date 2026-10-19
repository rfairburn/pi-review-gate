import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getSessionHostSpawnCapability, publishSessionHostSpawnCapability, revokeSessionHostSpawnCapability, SESSION_HOST_SPAWN_CAPABILITY_KEY } from "../src/session-host/spawn-capability";
import {
  SESSION_SPAWN_TOOL_NAME,
  parseSessionSpawnInput,
  registerSessionSpawnTool,
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

  it("rejects extra, empty, unsafe, and over-bound workspace/title arguments without invoking a host", () => {
    const valid = { workspace: "/existing", title: "Title", prompt: "Start." };
    assert.deepEqual(parseSessionSpawnInput(valid), valid);
    assert.throws(() => parseSessionSpawnInput({ ...valid, other: "field" }), /exactly workspace, title, and prompt/);
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
