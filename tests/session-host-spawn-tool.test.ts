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
    const parameters = tool.parameters as { properties: Record<string, { description: string }> };
    assert.match(parameters.properties.title!.description, /32 terminal columns.*optimal\/soft target, not a maximum/);
    assert.match(parameters.properties.title!.description, /Pi 1\.1\.0 trims it.*No host-side width-based clipping or shortening/);

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

  it("rejects extra, empty, unsafe, and over-bound model arguments without invoking a host", () => {
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
