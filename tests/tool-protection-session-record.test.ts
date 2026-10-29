/**
 * Issue #536: what an optional saved auditor session is allowed to claim.
 *
 * These tests drive the production writer through an injected host session
 * manager, so they prove the record's own honesty rules without a Pi install:
 * transport configuration never enters a record (including a Node launch error,
 * which quotes the configured executable), retained host status never quotes a
 * path, the external envelope is described as delivered only when the host said
 * so, and the outcome entry is written by the synchronous completion step so an
 * abandoned record simply has no outcome instead of an invented one.
 *
 * Native interoperability with the installed Pi `SessionManager` is proven
 * separately in tests/tool-protection-pi-host.test.ts and is not claimed here.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  openAuditorSessionRecord,
  writeAuditorSessionRecord,
  TOOL_PROTECTION_EXTERNAL_CUSTOM_TYPE,
  TOOL_PROTECTION_RECORD_CUSTOM_TYPE,
  type AuditorRecordDraft,
  type AuditorRecordOpenDraft,
  type HostAuditorSessionManager,
} from "../src/tool-protection/session-record";
import type { ProtectionAuditorObservation } from "../src/tool-protection/runner";

/** One appended entry, as the fake manager saw it. */
interface FakeEntry {
  kind: string;
  payload: unknown;
}

interface FakeManager {
  manager: HostAuditorSessionManager;
  entries: FakeEntry[];
  /** Session file the fake reports, when it has one. */
  file?: string;
}

function fakeManager(options: { failOn?: string; file?: string } = {}): FakeManager {
  const entries: FakeEntry[] = [];
  const record: FakeManager = { manager: undefined as unknown as HostAuditorSessionManager, entries, ...(options.file ? { file: options.file } : {}) };
  const push = (kind: string, payload: unknown): void => {
    if (options.failOn === kind) throw new Error(`synthetic: cannot write ${kind}`);
    entries.push({ kind, payload });
  };
  record.manager = {
    appendSessionInfo: (name: string) => { push("sessionInfo", name); return null; },
    appendThinkingLevelChange: (level: string) => { push("thinkingLevel", level); return null; },
    appendMessage: (message: unknown) => { push("message", message); return null; },
    appendCustomMessageEntry: (customType: string, content: string, display: boolean, details?: unknown) => {
      push("customMessage", { customType, content, display, details });
      return null;
    },
    appendCustomEntry: (customType: string, data?: unknown) => { push("custom", { customType, data }); return null; },
    getSessionFile: () => record.file,
  };
  return record;
}

function writer(manager: FakeManager) {
  return { loadSessionManager: async () => ({ create: () => manager.manager }) };
}

function baseDraft(overrides: Partial<AuditorRecordDraft> = {}): AuditorRecordDraft {
  return {
    identity: {
      invocationId: "call-1",
      toolName: "bash",
      argumentFingerprint: "sha256:abc",
      role: "primary",
      cwd: "/work",
      level: "dangerous",
      auditor: { source: "external", label: "classifier" },
      durationMs: 12,
    },
    prompt: "GOVERNING synthetic prompt\n\nexact proposal: bash echo hi",
    outcome: { status: "decision", decision: "PASS", reason: "synthetic read is authorized" },
    ...overrides,
  };
}

function externalObservation(overrides: Partial<NonNullable<ProtectionAuditorObservation["external"]>> = {}): ProtectionAuditorObservation {
  return {
    transport: "external-binary",
    external: {
      requestText: "{\"version\":\"pi-reviewer-json-v1\",\"prompt\":\"p\"}",
      outputText: "",
      truncated: false,
      exitCode: 0,
      timedOut: false,
      aborted: false,
      deliveredToStdin: true,
      ...overrides,
    },
  };
}

test("a launch-failure record states the category and code and never the configured command", async () => {
  const manager = fakeManager();
  const draft = baseDraft({
    observation: {
      transport: "route-refused",
      refusal: "Auditor launch failed: the configured auditor program could not be started (spawn ENOENT). Its command, arguments, and environment are not reported.",
      launchFailure: { syscall: "spawn", code: "ENOENT" },
    },
    // The verbatim user-facing diagnostic Node produces, path included.
    outcome: { status: "transport-error", error: "Auditor launch failed: spawn /synthetic/SECRET-auditor-bin ENOENT" },
  });
  const saved = await writeAuditorSessionRecord(draft, writer(manager));
  assert.equal(saved.saved, "full");

  const serialized = JSON.stringify(manager.entries);
  assert.ok(!serialized.includes("SECRET-auditor-bin"), `the configured command was retained: ${serialized}`);
  assert.ok(!serialized.includes("/synthetic/"), `an executable path was retained: ${serialized}`);

  const outcome = (manager.entries.find((entry) => entry.kind === "custom")!.payload as { data: Record<string, unknown> }).data;
  assert.deepEqual(outcome.launchFailure, { syscall: "spawn", code: "ENOENT" });
  assert.equal(outcome.transport, "route-refused");
  assert.equal(outcome.status, "transport-error");
  assert.match(String(outcome.hostError), /spawn ENOENT/, "the honest category and code are still reported");
  assert.match(String(outcome.refusal), /could not be started/, "the retained refusal explains itself");
  assert.match(String(outcome.decisionMeaning ?? ""), /^$/, "a non-decision carries no verdict framing");
  assert.equal("decision" in outcome, false, "no verdict is invented for a launch failure");
});

test("retained host status withholds path-shaped tokens instead of quoting configuration", async () => {
  const manager = fakeManager();
  await writeAuditorSessionRecord(baseDraft({
    observation: { transport: "pi-in-process", pi: { systemPrompt: "route", prompt: "p", thinkingLevel: "off", model: { provider: "synthetic", id: "model" } } },
    outcome: { status: "transport-error", error: "provider error while reading /Users/robert/SECRET-bootstrap.json for openai/model-1" },
  }), writer(manager));
  const serialized = JSON.stringify(manager.entries);
  assert.ok(!serialized.includes("SECRET-bootstrap"), `a configuration path was retained: ${serialized}`);
  const outcome = (manager.entries.find((entry) => entry.kind === "custom")!.payload as { data: Record<string, unknown> }).data;
  assert.match(String(outcome.hostError), /<path>/);
  assert.match(String(outcome.hostError), /\[paths withheld from saved records\]/, "the withholding is disclosed, not silent");
  assert.match(String(outcome.hostError), /openai\/model-1/, "an ordinary model identifier is not shredded");
});

test("the external envelope is described as delivered only when the host reported delivery", async () => {
  const confirmed = fakeManager();
  await writeAuditorSessionRecord(baseDraft({
    observation: externalObservation({ outputText: "{\"decision\":\"PASS\",\"reason\":\"ok\"}" }),
  }), writer(confirmed));
  const confirmedRequest = String((confirmed.entries.find((entry) => entry.kind === "message")!.payload as { content: string }).content);
  assert.match(confirmedRequest, /host reported that this write flushed to the program's stdin pipe/);
  assert.ok(!confirmedRequest.includes("NOT confirmed"));

  const epipe = fakeManager();
  await writeAuditorSessionRecord(baseDraft({
    observation: externalObservation({ deliveredToStdin: false, stdinError: "write EPIPE", exitCode: null, outputText: "" }),
    outcome: { status: "transport-error", error: "Auditor could not receive its request." },
  }), writer(epipe));
  const epipeRequest = String((epipe.entries.find((entry) => entry.kind === "message")!.payload as { content: string }).content);
  assert.match(epipeRequest, /Delivery is NOT confirmed/);
  assert.match(epipeRequest, /write EPIPE/);
  assert.match(epipeRequest, /may have read none or only part/);
  assert.ok(!/the exact JSON written/.test(epipeRequest), "an undelivered envelope is never described as written");
  const epipeOutput = (epipe.entries.find((entry) => entry.kind === "customMessage")!.payload as { details: Record<string, unknown> }).details;
  assert.equal(epipeOutput.stdinDelivered, false);
  assert.equal(epipeOutput.stdinError, "write EPIPE");

  const cancelled = fakeManager();
  await writeAuditorSessionRecord(baseDraft({
    observation: externalObservation({ deliveredToStdin: false, aborted: true, exitCode: null, outputText: "" }),
    outcome: { status: "cancelled", error: "Auditor was aborted." },
  }), writer(cancelled));
  const cancelledRequest = String((cancelled.entries.find((entry) => entry.kind === "message")!.payload as { content: string }).content);
  assert.match(cancelledRequest, /Delivery is NOT confirmed: the run was cancelled before the write completed/);
});

test("the outcome entry is written by completion, and an abandoned record has none", async () => {
  const manager = fakeManager();
  const openDraft: AuditorRecordOpenDraft = baseDraft();
  const opened = await openAuditorSessionRecord(openDraft, writer(manager));
  assert.equal(manager.entries.some((entry) => entry.kind === "custom"), false,
    "no outcome exists before the caller has decided it");
  assert.ok(manager.entries.length > 0, "the request entries are already written");

  const saved = opened.complete({ status: "invalidated", error: "the proposed call changed while the record was being written" });
  assert.equal(saved.saved, "full");
  const outcome = (manager.entries[manager.entries.length - 1]!.payload as { data: Record<string, unknown> }).data;
  assert.equal(manager.entries[manager.entries.length - 1]!.kind, "custom", "the outcome entry is last");
  assert.equal(outcome.status, "invalidated");
  assert.equal("decision" in outcome, false, "a blocked call never saves a pass");
});

test("a write failure is reported honestly as partial or none", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-review-record-"));
  try {
    const file = join(dir, "exists.jsonl");
    await writeFile(file, "", "utf8");

    const partial = fakeManager({ failOn: "custom", file });
    const partialSaved = await writeAuditorSessionRecord(baseDraft(), writer(partial));
    assert.equal(partialSaved.saved, "partial");
    assert.match(partialSaved.warning ?? "", /only partially saved/);
    assert.match(partialSaved.warning ?? "", /gate decision is unchanged/);

    const missing = fakeManager({ failOn: "message" });
    const missingSaved = await writeAuditorSessionRecord(baseDraft(), writer(missing));
    assert.equal(missingSaved.saved, "none", "a file that was never created is not a partial record");
    assert.match(missingSaved.warning ?? "", /could not be saved/);

    const unavailable = await writeAuditorSessionRecord(baseDraft(), { loadSessionManager: async () => undefined });
    assert.equal(unavailable.saved, "none");
    assert.match(unavailable.detail ?? "", /session SDK is unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a refusal record keeps the generated request and says it was never sent", async () => {
  const manager = fakeManager();
  await writeAuditorSessionRecord(baseDraft({
    observation: { transport: "route-refused", refusal: "Auditor external agent not found: classifier" },
    outcome: { status: "transport-error", error: "Auditor external agent not found: classifier" },
  }), writer(manager));
  const request = String((manager.entries.find((entry) => entry.kind === "message")!.payload as { content: string }).content);
  assert.match(request, /never sent to any transport/);
  assert.match(request, /No auditor reply exists for it/);
  assert.match(request, /exact proposal: bash echo hi/, "the generated request itself is preserved");
  assert.equal(manager.entries.some((entry) => entry.kind === "customMessage"), false, "no binary output entry exists for a refusal");
  assert.equal(TOOL_PROTECTION_EXTERNAL_CUSTOM_TYPE, "pi-review-gate.tool-protection.output");
  assert.equal(TOOL_PROTECTION_RECORD_CUSTOM_TYPE, "pi-review-gate.tool-protection");
});

test("a refusal naming a configuration path is withheld in the saved request entry too", async () => {
  // A Pi registry or synchronous dispatch exception can quote the bootstrap file.
  // Filtering only the outcome entry would leave that path in the user entry, so
  // the whole serialized record is checked, and the generated prompt itself must
  // still be stored byte-for-byte.
  const manager = fakeManager();
  const bootstrap = "Pi auditor in-process launch failed: open /synthetic/SECRET-bootstrap.json";
  await writeAuditorSessionRecord(baseDraft({
    observation: { transport: "route-refused", refusal: bootstrap },
    outcome: { status: "transport-error", error: bootstrap },
  }), writer(manager));

  const serialized = JSON.stringify(manager.entries);
  assert.ok(!serialized.includes("SECRET-bootstrap"), `the bootstrap file was retained: ${serialized}`);
  assert.ok(!serialized.includes("/synthetic/"), `a configuration path was retained: ${serialized}`);

  const request = String((manager.entries.find((entry) => entry.kind === "message")!.payload as { content: string }).content);
  assert.match(request, /<path>/);
  assert.match(request, /\[paths withheld from saved records\]/, "the withholding is disclosed, not silent");
  assert.match(request, /never sent to any transport/);
  assert.match(request, /exact proposal: bash echo hi/, "the generated request itself is preserved unchanged");
});
