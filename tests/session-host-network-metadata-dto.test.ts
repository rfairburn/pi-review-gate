/**
 * Pure contract tests for the remote roster metadata row (#478).
 *
 * Fake owner rows are typed as the real `NativeInstanceView`, and wire values
 * are real JSON-shaped values (never a mocked transport). There is no network,
 * socket, process, filesystem, config, clipboard, or startup activation here.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { NativeInstanceView } from "../src/session-host/instances";
import {
  MAX_REMOTE_ACTIVITY_LINE_CHARS,
  MAX_REMOTE_ERROR_BYTES,
  MAX_REMOTE_ERROR_CHARS,
  MAX_REMOTE_LABEL_CHARS,
  MAX_REMOTE_NATIVE_NAME_CHARS,
  MAX_REMOTE_WORKSPACE_BYTES,
  REMOTE_ERROR_FALLBACK_TEXT,
  RemoteSessionMetadataError,
  parseRemoteSessionMetadata,
  toRemoteSessionMetadata,
  type RemoteSessionMetadataErrorCode,
} from "../src/session-host/network/roster-metadata";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const BASIC_CREDENTIAL = "dXNlcjpwYXNzd29yZA==";
const PRIVATE_KEY_BODY = "MIIEprivateKeyMaterialThatMustNotEscape";

function ownerView(overrides: Partial<NativeInstanceView> = {}): NativeInstanceView {
  return {
    id: "row-1",
    label: "Remote row",
    workspace: "/Users/casey/src/pi",
    agentDir: "/Users/casey/.pi/agent",
    lifecycle: "alive",
    busy: false,
    pendingInput: false,
    inputSurface: true,
    nativeSession: { sessionId: "native-session-1", epoch: 3, name: "Remote row" },
    hasLiveProcess: true,
    activity: ["Running tests"],
    backgroundTasks: 0,
    backgroundShells: 0,
    activeTasks: 0,
    activeShells: 0,
    ...overrides,
  };
}

function captureRowError(run: () => unknown): RemoteSessionMetadataError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof RemoteSessionMetadataError, "expected a fixed-code row error");
    return error;
  }
  assert.fail("expected a RemoteSessionMetadataError");
}

function assertRowError(run: () => unknown, code: RemoteSessionMetadataErrorCode, leaked?: string): void {
  const error = captureRowError(run);
  assert.equal(error.code, code);
  assert.equal(
    error.message,
    code === "ROSTER_ROW_INVALID"
      ? "remote session metadata row is invalid"
      : "remote session metadata row exceeds a bounded field limit",
  );
  if (leaked !== undefined) assert.equal(error.message.includes(leaked), false);
}

function jsonRoundTrip(row: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

test("projects exact local-equivalent sidebar fields, including distinct ownership and intent counts", () => {
  const view = ownerView({
    backgroundTasks: 5,
    backgroundShells: 4,
    activeTasks: 2,
    activeShells: 1,
    nativeSession: {
      sessionId: "native-session-1",
      epoch: 8,
      name: "Remote row",
      persistence: "saved",
      currentFile: "/Users/casey/.pi/agent/sessions/private/current.jsonl",
    },
  });
  const row = toRemoteSessionMetadata(view);
  assert.deepEqual(row, {
    id: "row-1",
    label: "Remote row",
    workspace: "/Users/casey/src/pi",
    lifecycle: "alive",
    hasLiveProcess: true,
    busy: false,
    pendingInput: false,
    inputSurface: true,
    activity: ["Running tests"],
    nativeSession: {
      sessionId: "native-session-1",
      epoch: 8,
      name: "Remote row",
      persistence: "saved",
    },
    backgroundTasks: 5,
    backgroundShells: 4,
    activeTasks: 2,
    activeShells: 1,
  });
  assert.deepEqual(Object.keys(row).sort(), [
    "activeShells",
    "activeTasks",
    "activity",
    "backgroundShells",
    "backgroundTasks",
    "busy",
    "hasLiveProcess",
    "id",
    "inputSurface",
    "label",
    "lifecycle",
    "nativeSession",
    "pendingInput",
    "workspace",
  ]);
  assert.equal("agentDir" in row, false);
  assert.equal("lastNativeSession" in row, false);
  assert.equal("currentFile" in (row.nativeSession ?? {}), false);
  assert.equal("error" in row, false);
  assert.equal("exitCode" in row, false);
});

test("copies activity and native identity instead of retaining owner references", () => {
  const activity = ["Editing parser.ts"];
  const nativeSession = { sessionId: "native-session-1", epoch: 2, name: "Remote row" };
  const row = toRemoteSessionMetadata(ownerView({ activity, nativeSession }));
  activity.push("mutated owner observation");
  nativeSession.name = "mutated owner title";
  assert.deepEqual(row.activity, ["Editing parser.ts"]);
  assert.equal(row.nativeSession?.name, "Remote row");
});

test("preserves canonical native titles longer than the legacy explicit-label bound", () => {
  const title = "T".repeat(81);
  const row = toRemoteSessionMetadata(ownerView({
    label: title,
    nativeSession: { sessionId: "native-session-1", epoch: 1, name: title },
  }));
  assert.equal(row.label, title);
  assert.equal(row.nativeSession?.name, title);
  assert.deepEqual(parseRemoteSessionMetadata(jsonRoundTrip(row)), row);

  const canonical = "C".repeat(MAX_REMOTE_NATIVE_NAME_CHARS);
  const maximum = toRemoteSessionMetadata(ownerView({
    label: canonical,
    nativeSession: { sessionId: "native-session-1", epoch: 2, name: canonical },
  }));
  assert.equal(maximum.label, canonical);
  assert.deepEqual(parseRemoteSessionMetadata(jsonRoundTrip(maximum)), maximum);
});

test("keeps unknown observations unknown instead of zero, false, or idle", () => {
  const row = toRemoteSessionMetadata(ownerView({
    busy: null,
    pendingInput: null,
    nativeSession: null,
    activity: [],
    backgroundTasks: undefined,
    backgroundShells: undefined,
    activeTasks: undefined,
    activeShells: undefined,
  }));
  assert.equal(row.busy, null);
  assert.equal(row.pendingInput, null);
  assert.equal(row.nativeSession, null);
  assert.deepEqual(row.activity, []);
  assert.equal(row.backgroundTasks, null);
  assert.equal(row.backgroundShells, null);
  assert.equal(row.activeTasks, null);
  assert.equal(row.activeShells, null);
  assert.equal("exitCode" in row, false);
  assert.equal("error" in row, false);
});

test("decodes a minimal wire row without inventing observations", () => {
  const decoded = parseRemoteSessionMetadata({
    id: "row-2",
    label: "Only known fields",
    workspace: "C:\\work\\pi",
    lifecycle: "exited",
    hasLiveProcess: false,
    inputSurface: false,
  });
  assert.ok(decoded);
  assert.equal(decoded.busy, null);
  assert.equal(decoded.pendingInput, null);
  assert.equal(decoded.nativeSession, null);
  assert.deepEqual(decoded.activity, []);
  assert.equal(decoded.backgroundTasks, null);
  assert.equal(decoded.backgroundShells, null);
  assert.equal(decoded.activeTasks, null);
  assert.equal(decoded.activeShells, null);
  assert.equal("exitCode" in decoded, false);
  assert.equal("error" in decoded, false);
});

test("preserves a known zero exit code and keeps a missing exit code absent", () => {
  const exited = toRemoteSessionMetadata(ownerView({ lifecycle: "exited", hasLiveProcess: false, exitCode: 0 }));
  assert.equal(exited.exitCode, 0);
  const decoded = parseRemoteSessionMetadata({ ...jsonRoundTrip(exited), exitCode: 0 });
  assert.equal(decoded?.exitCode, 0);
  const unknown = parseRemoteSessionMetadata({ ...jsonRoundTrip(exited), exitCode: null });
  assert.ok(unknown);
  assert.equal("exitCode" in unknown, false);
});

test("preserves literal owner-side workspace paths from other operating systems without resolution", () => {
  const workspaces = [
    "C:\\Users\\Casey\\Source\\pi",
    "D:/work/pi-review-gate",
    "/home/casey/My Project/../pi",
    "\\\\server\\share\\pi",
  ];
  for (const workspace of workspaces) {
    const row = toRemoteSessionMetadata(ownerView({ workspace }));
    assert.equal(row.workspace, workspace);
    assert.equal(parseRemoteSessionMetadata(jsonRoundTrip(row))?.workspace, workspace);
  }
});

test("keeps workspace exact even when it contains display-unsafe characters", () => {
  const workspace = "/home/casey/odd\tname\nand\u001b[31msegment";
  const row = toRemoteSessionMetadata(ownerView({ workspace }));
  assert.equal(row.workspace, workspace);
  assert.equal(parseRemoteSessionMetadata(jsonRoundTrip(row))?.workspace, workspace);
});

test("keeps canonical native identity and never carries the private current file", () => {
  const row = toRemoteSessionMetadata(ownerView({
    nativeSession: {
      sessionId: "native-session-9",
      epoch: 12,
      name: "Canonical title",
      persistence: "unsaved",
      currentFile: "/Users/casey/.pi/agent/sessions/private/current.jsonl",
    },
  }));
  assert.deepEqual(row.nativeSession, {
    sessionId: "native-session-9",
    epoch: 12,
    name: "Canonical title",
    persistence: "unsaved",
  });
  const wire = jsonRoundTrip(row);
  assert.equal(parseRemoteSessionMetadata(wire) !== null, true);
  const nestedPrivate = jsonRoundTrip(row) as unknown as { nativeSession: Record<string, unknown> };
  nestedPrivate.nativeSession.currentFile = "/private/current.jsonl";
  assert.equal(parseRemoteSessionMetadata(nestedPrivate), null);
});

test("preserves ownership and activity-intent counts independently", () => {
  const decoded = parseRemoteSessionMetadata({
    id: "row-3",
    label: "Counts",
    workspace: "/srv/pi",
    lifecycle: "alive",
    hasLiveProcess: true,
    inputSurface: true,
    backgroundTasks: 0,
    backgroundShells: 1,
    activeTasks: 7,
    activeShells: 0,
  });
  assert.ok(decoded);
  assert.equal(decoded.backgroundTasks, 0);
  assert.equal(decoded.backgroundShells, 1);
  assert.equal(decoded.activeTasks, 7);
  assert.equal(decoded.activeShells, 0);
  assert.notEqual(decoded.activeTasks, decoded.backgroundTasks);
});

test("decoder rejects extra private, account, and case-alias fields", () => {
  const valid = jsonRoundTrip(toRemoteSessionMetadata(ownerView()));
  const extras: ReadonlyArray<Record<string, unknown>> = [
    { agentDir: "/Users/casey/.pi/agent" },
    { token: SECRET },
    { env: { OPENAI_API_KEY: "sk-provider-secret-value" } },
    { account: { email: "casey@example.test" } },
    { prompt: "private prompt body" },
    { currentFile: "/private/current.jsonl" },
    { ID: valid.id },
    { background_tasks: 3 },
    { ["__proto__"]: { polluted: true } },
  ];
  for (const extra of extras) {
    assert.equal(parseRemoteSessionMetadata({ ...valid, ...extra }), null);
  }
  assert.deepEqual(parseRemoteSessionMetadata(valid), toRemoteSessionMetadata(ownerView()));
  assert.notEqual(parseRemoteSessionMetadata(valid), null);
});

test("projection never copies private extra owner fields into the row", () => {
  const view = {
    ...ownerView(),
    token: SECRET,
    env: { OPENAI_API_KEY: "sk-provider-secret-value" },
    prompt: "private prompt body",
    question: "private question body",
    transcript: "private transcript",
    outputBytes: "private output",
  } as unknown as NativeInstanceView;
  const row = toRemoteSessionMetadata(view);
  const serialized = JSON.stringify(row);
  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes("sk-provider-secret-value"), false);
  assert.equal(serialized.includes("private prompt body"), false);
  assert.equal(serialized.includes("private transcript"), false);
  assert.equal(serialized.includes("/Users/casey/.pi/agent"), false);
  assert.equal("token" in row, false);
  assert.equal("env" in row, false);
  assert.equal("prompt" in row, false);
});

test("projection never treats inherited optional properties as observations", () => {
  const requiredOnly = {
    id: "row-inherited",
    label: "Inherited row",
    workspace: "/srv/pi",
    lifecycle: "alive" as const,
    hasLiveProcess: true,
    inputSurface: false,
  };
  const view = Object.assign(Object.create({
    busy: false,
    pendingInput: false,
    backgroundTasks: 0,
    backgroundShells: 0,
    activeTasks: 0,
    activeShells: 0,
    activity: ["inherited activity"],
    nativeSession: { sessionId: "native-session-inherited", epoch: 1, name: "Inherited row" },
  }), requiredOnly) as unknown as NativeInstanceView;
  const row = toRemoteSessionMetadata(view);
  assert.equal(row.busy, null);
  assert.equal(row.pendingInput, null);
  assert.deepEqual(row.activity, []);
  assert.equal(row.nativeSession, null);
  assert.equal(row.backgroundTasks, null);
  assert.equal(row.backgroundShells, null);
  assert.equal(row.activeTasks, null);
  assert.equal(row.activeShells, null);
});

test("redacts recognizable error credentials and strips terminal controls", () => {
  // Header-consuming recognizers (Authorization/Cookie) must be exercised on
  // independent diagnostics; on one line the first header would swallow the
  // rest and make the later assertions vacuous.
  const cases: ReadonlyArray<{ errorText: string; secrets: readonly string[] }> = [
    { errorText: `Launch failed: token=${SECRET} \u001b[31mretry\u001b[0m`, secrets: [SECRET] },
    { errorText: `Authorization: Basic ${BASIC_CREDENTIAL}`, secrets: [BASIC_CREDENTIAL] },
    { errorText: "Cookie: sid=abc123; theme=dark", secrets: ["sid=abc123", "theme=dark"] },
    { errorText: "https://casey:hunter2@example.test/repo", secrets: ["hunter2"] },
    { errorText: "api_key=sk-abcdefghijklmnop", secrets: ["sk-abcdefghijklmnop"] },
  ];
  for (const { errorText, secrets } of cases) {
    const row = toRemoteSessionMetadata(ownerView({ lifecycle: "error", hasLiveProcess: false, error: errorText }));
    const error = row.error ?? "";
    for (const secret of secrets) assert.equal(error.includes(secret), false, `error text leaked ${secret}`);
    assert.equal(error.includes("\u001b"), false);
    assert.equal(error.includes("\u0007"), false);
    assert.equal(error.includes("[REDACTED]"), true);
    const serialized = JSON.stringify(row);
    for (const secret of secrets) assert.equal(serialized.includes(secret), false, `serialized row leaked ${secret}`);
    assert.equal(serialized.includes("\\u001b"), false);
  }
  const launch = toRemoteSessionMetadata(ownerView({
    lifecycle: "error",
    hasLiveProcess: false,
    error: `Launch failed: token=${SECRET} \u001b[31mretry\u001b[0m`,
  }));
  assert.match(launch.error ?? "", /Launch failed/);
  assert.match(launch.error ?? "", /retry/);
});

test("redacts complete parameterized Authorization values through both exports", () => {
  const diagnostics = [
    'Authentication failed: Authorization: Digest username="casey", nonce="challenge", response="6629fae49393a05397450978507c4ef1"',
    "Authentication failed: Authorization: AWS4-HMAC-SHA256 Credential=example/20260601/region/service/aws4_request, SignedHeaders=host, Signature=0123456789abcdef",
  ];
  for (const errorText of diagnostics) {
    const projected = toRemoteSessionMetadata(ownerView({ error: errorText }));
    const decoded = parseRemoteSessionMetadata({
      ...jsonRoundTrip(toRemoteSessionMetadata(ownerView())),
      error: errorText,
    });
    assert.equal(projected.error, "Authentication failed: Authorization: [REDACTED]");
    assert.equal(decoded?.error, "Authentication failed: Authorization: [REDACTED]");
    const serialized = JSON.stringify([projected, decoded]);
    for (const leaked of ["6629fae49393a05397450978507c4ef1", "0123456789abcdef", "response=", "Signature="]) {
      assert.equal(serialized.includes(leaked), false);
    }
  }
});

test("control stripping cannot unmask a credential split inside the pattern", () => {
  const splitCases = [
    `password=hu\u0000nter2`,
    `token=abc\u001b[31mdefghijklmnopqrstuvwxyz`,
    `password=hu\u001b]0;injected title\u0007nter2`,
  ];
  for (const errorText of splitCases) {
    const row = toRemoteSessionMetadata(ownerView({ lifecycle: "error", hasLiveProcess: false, error: errorText }));
    const serialized = JSON.stringify(row);
    assert.equal(serialized.includes("hunter2"), false);
    assert.equal(serialized.includes("abcdefghijklmnopqrstuvwxyz"), false);
    assert.equal(serialized.includes("injected title"), false);
    assert.equal(serialized.includes("\\u001b"), false);
    assert.equal(serialized.includes("\\u0000"), false);
    assert.match(row.error ?? "", /\[REDACTED\]/);
  }
});

test("tab-bearing diagnostics fail closed instead of exposing credential fragments", () => {
  const cases = [
    "password=hun\tter2",
    "pass\tword=hunter2",
    `token=abc\t${SECRET.slice(4)}`,
  ];
  for (const errorText of cases) {
    const row = toRemoteSessionMetadata(ownerView({ lifecycle: "error", hasLiveProcess: false, error: errorText }));
    assert.equal(row.error, REMOTE_ERROR_FALLBACK_TEXT);
    const decoded = parseRemoteSessionMetadata({
      ...jsonRoundTrip(toRemoteSessionMetadata(ownerView())),
      error: errorText,
    });
    assert.equal(decoded?.error, REMOTE_ERROR_FALLBACK_TEXT);
    const serialized = JSON.stringify([row, decoded]);
    for (const leaked of ["hun", "ter2", "hunter2", SECRET]) {
      assert.equal(serialized.includes(leaked), false, `tab fallback leaked ${leaked}`);
    }
  }
});

test("control-split private-key headers fail closed through both exports", () => {
  const splitHeader = "-----BEGIN RSA PRI\u0000VATE KEY-----";
  const cases = [
    `failed ${splitHeader}`,
    `failed ${splitHeader}\\n${PRIVATE_KEY_BODY}`,
    `failed ${splitHeader}\\n${PRIVATE_KEY_BODY}\\n-----END RSA PRIVATE KEY-----`,
    "failed -----BEGIN OPENSSH PRIVATE KEY-----",
  ];
  for (const errorText of cases) {
    const row = toRemoteSessionMetadata(ownerView({ lifecycle: "error", hasLiveProcess: false, error: errorText }));
    assert.equal(row.error, REMOTE_ERROR_FALLBACK_TEXT);
    const decoded = parseRemoteSessionMetadata({
      ...jsonRoundTrip(toRemoteSessionMetadata(ownerView())),
      error: errorText,
    });
    assert.equal(decoded?.error, REMOTE_ERROR_FALLBACK_TEXT);
    const serialized = JSON.stringify([row, decoded]);
    assert.equal(serialized.includes(PRIVATE_KEY_BODY), false);
    assert.equal(serialized.includes("VATE KEY"), false);
    assert.equal(serialized.includes("OPENSSH"), false);
  }
});

test("unsafe diagnostics fall back to the fixed generic safe message", () => {
  const cases = [
    "failed\n    at Object.<anonymous> (/Users/casey/private/stack.js:1:1)",
    "failed \u001b]0;unterminated control string",
    "failed \u001b[31",
    `failed -----BEGIN RSA PRIVATE KEY-----\n${PRIVATE_KEY_BODY}`,
    `${"x".repeat(5000)} token=${SECRET}`,
  ];
  for (const errorText of cases) {
    const row = toRemoteSessionMetadata(ownerView({ lifecycle: "error", hasLiveProcess: false, error: errorText }));
    assert.equal(row.error, REMOTE_ERROR_FALLBACK_TEXT);
    const serialized = JSON.stringify(row);
    for (const leaked of [PRIVATE_KEY_BODY, SECRET, "private/stack", "unterminated", "x".repeat(64)]) {
      assert.equal(serialized.includes(leaked), false, `fallback leaked ${leaked}`);
    }
  }
});

test("ambiguous credential assignments fail closed through both exports", () => {
  const diagnostics = [
    'Launch failed: password="hunter2',
    "Launch failed: password='hunter2",
    `Launch failed: password="hun'ter2"`,
    `Launch failed: token="abc\u0000def`,
    String.raw`Launch failed: password=\"hunter2\"`,
    "Launch failed: password=prefix'private-tail-7395'",
    'Launch failed: DB_PASSWORD="hunter2',
    "Launch failed: password=prefix}private-tail-7395",
    "Launch failed: password=prefix]private-tail-7395",
    "Launch failed: password=prefix,private-tail-7395",
  ];
  for (const errorText of diagnostics) {
    const projected = toRemoteSessionMetadata(ownerView({ error: errorText }));
    const decoded = parseRemoteSessionMetadata({
      ...jsonRoundTrip(toRemoteSessionMetadata(ownerView())),
      error: errorText,
    });
    assert.equal(projected.error, REMOTE_ERROR_FALLBACK_TEXT);
    assert.equal(decoded?.error, REMOTE_ERROR_FALLBACK_TEXT);
    const serialized = JSON.stringify([projected, decoded]);
    for (const leaked of ["hunter2", "hun'ter2", "abcdef", "private-tail-7395"]) {
      assert.equal(serialized.includes(leaked), false);
    }
  }
});

test("short scheme-prefixed credentials are redacted through both exports", () => {
  for (const credential of ["Basic dTpw", "Bearer abc"]) {
    const errorText = `Authentication failed using ${credential}`;
    const projected = toRemoteSessionMetadata(ownerView({ error: errorText }));
    const decoded = parseRemoteSessionMetadata({
      ...jsonRoundTrip(toRemoteSessionMetadata(ownerView())),
      error: errorText,
    });
    assert.equal(projected.error, "Authentication failed using [REDACTED]");
    assert.equal(decoded?.error, projected.error);
    assert.equal(JSON.stringify([projected, decoded]).includes(credential), false);
  }
});

test("safe ordinary error text remains useful and bounded", () => {
  const ordinary = "Workspace directory is no longer available";
  assert.equal(
    toRemoteSessionMetadata(ownerView({ lifecycle: "error", hasLiveProcess: false, error: ordinary })).error,
    ordinary,
  );
  assert.equal(
    parseRemoteSessionMetadata({ ...jsonRoundTrip(toRemoteSessionMetadata(ownerView())), error: ordinary })?.error,
    ordinary,
  );

  // A diagnostic consisting only of a credential keeps a useful redaction
  // marker; it is bounded and leaks nothing.
  const secretOnly = toRemoteSessionMetadata(ownerView({ error: `token=${SECRET}` }));
  assert.equal(secretOnly.error, "token=[REDACTED]");

  const long = toRemoteSessionMetadata(ownerView({ error: "E".repeat(1000) }));
  assert.equal(long.error, "E".repeat(MAX_REMOTE_ERROR_CHARS));
  assert.ok((long.error ?? "").length <= MAX_REMOTE_ERROR_CHARS);
  assert.ok(Buffer.byteLength(long.error ?? "", "utf8") <= MAX_REMOTE_ERROR_BYTES);

  const emoji = toRemoteSessionMetadata(ownerView({ error: "🔥".repeat(500) }));
  assert.ok(Array.from(emoji.error ?? "").length <= MAX_REMOTE_ERROR_CHARS);
  assert.ok(Buffer.byteLength(emoji.error ?? "", "utf8") <= MAX_REMOTE_ERROR_BYTES);
  assert.equal(Buffer.from(emoji.error ?? "", "utf8").toString("utf8"), emoji.error);
});

test("boundary truncation happens after redaction and never emits a partial marker", () => {
  const prefix = "x".repeat(MAX_REMOTE_ERROR_CHARS - 10);
  const sliced = toRemoteSessionMetadata(ownerView({ error: `${prefix} token=${SECRET}` }));
  assert.ok((sliced.error ?? "").length <= MAX_REMOTE_ERROR_CHARS);
  assert.equal((sliced.error ?? "").includes(SECRET), false);
  assert.equal((sliced.error ?? "").includes("[REDA"), false);
  assert.equal((sliced.error ?? "").includes("[REDACTED"), false);

  const prefixFitting = "y".repeat(MAX_REMOTE_ERROR_CHARS - 20);
  const fitting = toRemoteSessionMetadata(ownerView({ error: `${prefixFitting} token=${SECRET}` }));
  assert.equal((fitting.error ?? "").includes("token=[REDACTED]"), true);
  assert.equal((fitting.error ?? "").includes(SECRET), false);
});

test("rejects unrepresentable owner rows with fixed sanitized errors", () => {
  const oversizedWorkspace = "Z".repeat(MAX_REMOTE_WORKSPACE_BYTES + 1);
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({ workspace: oversizedWorkspace })),
    "ROSTER_ROW_TOO_LARGE",
    "ZZZZZZZZ",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({ label: "L".repeat(MAX_REMOTE_LABEL_CHARS + 1) })),
    "ROSTER_ROW_TOO_LARGE",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({
      nativeSession: { sessionId: "s".repeat(257), epoch: 1, name: "Name" },
    })),
    "ROSTER_ROW_TOO_LARGE",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({
      nativeSession: {
        sessionId: "native-session-1",
        epoch: 1,
        name: "N".repeat(MAX_REMOTE_NATIVE_NAME_CHARS + 1),
      },
    })),
    "ROSTER_ROW_TOO_LARGE",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({ activity: ["a", "b", "c"] })),
    "ROSTER_ROW_TOO_LARGE",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({ activity: ["A".repeat(MAX_REMOTE_ACTIVITY_LINE_CHARS + 1)] })),
    "ROSTER_ROW_TOO_LARGE",
  );

  assertRowError(
    () => toRemoteSessionMetadata(ownerView({ lifecycle: "running" as NativeInstanceView["lifecycle"] })),
    "ROSTER_ROW_INVALID",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({ backgroundTasks: -1 })),
    "ROSTER_ROW_INVALID",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({ activeShells: 1.5 })),
    "ROSTER_ROW_INVALID",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({ busy: "yes" as unknown as boolean })),
    "ROSTER_ROW_INVALID",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({ inputSurface: 1 as unknown as boolean })),
    "ROSTER_ROW_INVALID",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({ hasLiveProcess: null as unknown as boolean })),
    "ROSTER_ROW_INVALID",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({ exitCode: Number.NaN })),
    "ROSTER_ROW_INVALID",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({
      nativeSession: { sessionId: "../escape", epoch: 1, name: "Name" },
    })),
    "ROSTER_ROW_INVALID",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({
      nativeSession: { sessionId: "native-session-1", epoch: 0, name: "Name" },
    })),
    "ROSTER_ROW_INVALID",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({
      nativeSession: {
        sessionId: "native-session-1",
        epoch: 1,
        name: "Name",
        persistence: "archived" as unknown as "saved",
      },
    })),
    "ROSTER_ROW_INVALID",
  );
  assertRowError(
    () => toRemoteSessionMetadata(ownerView({ error: { message: "raw stack detail" } as unknown as string })),
    "ROSTER_ROW_INVALID",
    "raw stack detail",
  );
});

test("decoder returns null for malformed, oversized, private, and hostile wire values", () => {
  const valid = jsonRoundTrip(toRemoteSessionMetadata(ownerView()));
  for (const invalid of [null, undefined, [], "row", 7, true, new Date(0)]) {
    assert.equal(parseRemoteSessionMetadata(invalid), null);
  }
  assert.equal(parseRemoteSessionMetadata({ ...valid, workspace: "" }), null);
  assert.equal(parseRemoteSessionMetadata({ ...valid, workspace: "Z".repeat(MAX_REMOTE_WORKSPACE_BYTES + 1) }), null);
  assert.equal(parseRemoteSessionMetadata({ ...valid, label: "L".repeat(MAX_REMOTE_LABEL_CHARS + 1) }), null);
  assert.equal(parseRemoteSessionMetadata({ ...valid, lifecycle: "running" }), null);
  assert.equal(parseRemoteSessionMetadata({ ...valid, busy: "yes" }), null);
  assert.equal(parseRemoteSessionMetadata({ ...valid, inputSurface: 1 }), null);
  assert.equal(parseRemoteSessionMetadata({ ...valid, backgroundTasks: -1 }), null);
  assert.equal(parseRemoteSessionMetadata({ ...valid, activeTasks: 1.5 }), null);
  assert.equal(parseRemoteSessionMetadata({ ...valid, activity: ["a", "b", "c"] }), null);
  assert.equal(parseRemoteSessionMetadata({ ...valid, exitCode: Number.NaN }), null);
  assert.equal(parseRemoteSessionMetadata({ ...valid, nativeSession: { sessionId: "s/1", epoch: 1, name: "N" } }), null);
  assert.equal(parseRemoteSessionMetadata({ ...valid, error: 42 }), null);
  assert.equal(parseRemoteSessionMetadata({ ...valid, extra: "private" }), null);

  const hostileGetter = { ...valid };
  Object.defineProperty(hostileGetter, "id", {
    enumerable: true,
    get() {
      throw new Error("raw secret diagnostic");
    },
  });
  assert.equal(parseRemoteSessionMetadata(hostileGetter), null);
  const hostileProxy = new Proxy({}, {
    ownKeys() {
      throw new Error("raw secret diagnostic");
    },
  });
  assert.equal(parseRemoteSessionMetadata(hostileProxy), null);
});

test("decoder rejects inherited observations, inherited identity, and prototype rows", () => {
  const valid = jsonRoundTrip(toRemoteSessionMetadata(ownerView()));
  const requiredOnly = {
    id: valid.id,
    label: valid.label,
    workspace: valid.workspace,
    lifecycle: valid.lifecycle,
    hasLiveProcess: valid.hasLiveProcess,
    inputSurface: valid.inputSurface,
  };

  const inheritedObservations = Object.create({
    busy: false,
    pendingInput: false,
    backgroundTasks: 0,
    backgroundShells: 0,
    activeTasks: 0,
    activeShells: 0,
    activity: ["inherited activity"],
  });
  Object.assign(inheritedObservations, requiredOnly);
  assert.equal(parseRemoteSessionMetadata(inheritedObservations), null);

  const inheritedNative = Object.create({
    epoch: 2,
    name: "Inherited title",
  });
  Object.assign(inheritedNative, { sessionId: "native-session-inherited" });
  assert.equal(parseRemoteSessionMetadata({ ...requiredOnly, nativeSession: inheritedNative }), null);

  const nullPrototype = Object.assign(Object.create(null), valid);
  assert.deepEqual(parseRemoteSessionMetadata(nullPrototype), valid);

  const nullPrototypeNative = Object.assign(Object.create(null), {
    sessionId: "native-session-1",
    epoch: 3,
    name: "Remote row",
  });
  assert.deepEqual(
    parseRemoteSessionMetadata({ ...requiredOnly, nativeSession: nullPrototypeNative }),
    {
      ...requiredOnly,
      busy: null,
      pendingInput: null,
      activity: [],
      nativeSession: { sessionId: "native-session-1", epoch: 3, name: "Remote row" },
      backgroundTasks: null,
      backgroundShells: null,
      activeTasks: null,
      activeShells: null,
    },
  );
});

test("round-trips a fully populated row through JSON without losing approved facts", () => {
  const row = toRemoteSessionMetadata(ownerView({
    exitCode: 130,
    error: "Workspace directory is no longer available",
    nativeSession: {
      sessionId: "native-session-1",
      epoch: 4,
      name: "Remote row",
      persistence: "unknown",
    },
  }));
  const decoded = parseRemoteSessionMetadata(jsonRoundTrip(row));
  assert.deepEqual(decoded, row);
});
