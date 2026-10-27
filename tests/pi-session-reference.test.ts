/**
 * Issue #533: canonical native Pi session references.
 *
 * Spawned Pi sessions live in Pi's own standard store. The gate keeps exactly
 * one canonical `{ id, file, cwd }` reference per session under the owner's
 * artifact directory, resumes only from the verified absolute path, and indexes
 * the referenced native history in place. These cases pin that contract without
 * touching a real provider, the shared store, or any user configuration.
 */
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PI_SESSION_REFERENCE_DIRNAME,
  canonicalPiSessionReference,
  iteratePiSessionReferenceDirectory,
  iteratePiSessionReferences,
  piSessionReferencePath,
  readPiSessionReference,
  readPiSessionReferenceAt,
  resolveVerifiedPiSessionFile,
  verifyPiSessionReference,
  writePiSessionReference,
  writePiSessionReferenceAt,
} from "../src/pi-session-reference";
import reporterDefault, { PI_SESSION_REFERENCE_ENV } from "../src/pi-session-reference-reporter";
import { buildSubtaskEvidence, type SubtaskEvidenceBundle } from "../src/execution/subtask-evidence";
import { EVIDENCE_MAX_ENUMERATED_ENTRIES, EVIDENCE_MAX_SOURCES } from "../src/execution/evidence/types";

let root: string;
/** A workspace path with a symlinked prefix (`/var` → `/private/var` on macOS). */
let workspace: string;
let nativeStore: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-session-reference-"));
  workspace = join(root, "worktree");
  await mkdir(workspace, { recursive: true });
  nativeStore = join(root, "native-store");
  await mkdir(nativeStore, { recursive: true });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

/** Writes a minimal native session transcript whose header carries id + cwd. */
async function nativeSession(input: {
  id?: string;
  cwd: string;
  name?: string;
  dir?: string;
  entries?: unknown[];
}): Promise<string> {
  const dir = input.dir ?? nativeStore;
  await mkdir(dir, { recursive: true });
  const file = join(dir, input.name ?? `${input.id ?? SESSION_ID}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: input.id ?? SESSION_ID, timestamp: "2025-06-01T10:00:00.000Z", cwd: input.cwd },
    ...(input.entries ?? [
      {
        type: "message", id: "m-user-1", parentId: null, timestamp: "2025-06-01T10:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
      },
      {
        type: "message", id: "m-asst-1", parentId: "m-user-1", timestamp: "2025-06-01T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { note: "NATIVE-HISTORY-MARKER" } }],
        },
      },
      {
        type: "message", id: "m-res-1", parentId: "m-asst-1", timestamp: "2025-06-01T10:00:03.000Z",
        message: {
          role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false, details: {}, usage: null,
          timestamp: "2025-06-01T10:00:03.000Z",
          content: [{ type: "text", text: "NATIVE-HISTORY-MARKER done" }],
        },
      },
    ]),
  ];
  await writeFile(file, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return file;
}

async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of generator) out.push(value);
  return out;
}

// ---------------------------------------------------------------------------
// Canonicalization: authoritative child identity → absolute reference
// ---------------------------------------------------------------------------

test("canonicalization resolves a relative native session file against the CHILD cwd, never the gate cwd", () => {
  const relativeTo = workspace;
  const canonical = canonicalPiSessionReference({
    id: SESSION_ID,
    file: join("sessions", `${SESSION_ID}.jsonl`),
    cwd: relativeTo,
    relativeTo,
  });
  assert.equal(canonical.ok, true);
  if (!canonical.ok) return;
  assert.equal(canonical.value.file, join(relativeTo, "sessions", `${SESSION_ID}.jsonl`));
  assert.ok(canonical.value.file.startsWith("/"), "a recorded file path is always absolute");
  assert.notEqual(canonical.value.file, join(process.cwd(), "sessions", `${SESSION_ID}.jsonl`));
});

test("canonicalization normalizes absolute paths and refuses unusable identities", () => {
  const messy = canonicalPiSessionReference({
    id: SESSION_ID,
    file: join(root, ".", "native-store", `${SESSION_ID}.jsonl`),
    cwd: `${workspace}/`,
  });
  assert.equal(messy.ok, true);
  if (!messy.ok) return;
  assert.equal(messy.value.file, join(root, "native-store", `${SESSION_ID}.jsonl`));
  assert.equal(messy.value.cwd, workspace);

  // A relative file resolves against the recorded ABSOLUTE session cwd — the
  // child's own location, never the gate process cwd.
  const relativeAgainstRecordedCwd = canonicalPiSessionReference({ id: SESSION_ID, file: "sessions/x.jsonl", cwd: workspace });
  assert.equal(relativeAgainstRecordedCwd.ok, true);
  if (!relativeAgainstRecordedCwd.ok) return;
  assert.equal(relativeAgainstRecordedCwd.value.file, join(workspace, "sessions", "x.jsonl"));

  // A relative session cwd with no anchor cannot be resolved safely.
  const relativeCwd = canonicalPiSessionReference({ id: SESSION_ID, file: "sessions/x.jsonl", cwd: "relative-worktree" });
  assert.equal(relativeCwd.ok, false);
  const noId = canonicalPiSessionReference({ id: "", file: join(workspace, "x.jsonl"), cwd: workspace });
  assert.equal(noId.ok, false);
  const traversingId = canonicalPiSessionReference({ id: "../escape", file: join(workspace, "x.jsonl"), cwd: workspace });
  assert.equal(traversingId.ok, false);
  const controlCharPath = canonicalPiSessionReference({ id: SESSION_ID, file: `/tmp/a\u0000b.jsonl`, cwd: workspace });
  assert.equal(controlCharPath.ok, false);
});

// ---------------------------------------------------------------------------
// Writing: one canonical reference, never a repaired or repointed association
// ---------------------------------------------------------------------------

test("one reference per session is idempotent and never repoints an existing association", async () => {
  const artifactDir = join(root, "artifact-write");
  const file = await nativeSession({ cwd: workspace });
  const reference = { id: SESSION_ID, file, cwd: workspace };

  const first = await writePiSessionReference(artifactDir, reference);
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.value.created, true);
  assert.equal(first.ok && first.value.path, piSessionReferencePath(artifactDir, SESSION_ID));

  const again = await writePiSessionReference(artifactDir, reference);
  assert.equal(again.ok, true);
  assert.equal(again.ok && again.value.created, false, "the identical identity is idempotent");

  // A duplicate native id pointing at a different transcript is the exact hazard
  // this guard exists for: preserved and reported, never silently rewritten.
  const other = await nativeSession({ cwd: workspace, name: "second.jsonl" });
  const conflict = await writePiSessionReference(artifactDir, { id: SESSION_ID, file: other, cwd: workspace });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.ok ? "" : conflict.reason, "conflict");
  assert.deepEqual(await readPiSessionReference(artifactDir, SESSION_ID), reference, "the original reference survives the conflict");

  // A foreign/malformed record is preserved untouched rather than repaired.
  const foreignPath = piSessionReferencePath(artifactDir, "ffffffff-1111-2222-3333-444444444444");
  const foreignBytes = '{"id":"ffffffff-1111-2222-3333-444444444444","file":"relative/something.jsonl","cwd":"/somewhere"}\n';
  await writeFile(foreignPath, foreignBytes, "utf8");
  const refusedWrite = await writePiSessionReferenceAt(foreignPath, {
    id: "ffffffff-1111-2222-3333-444444444444",
    file: join(nativeStore, "ok.jsonl"),
    cwd: workspace,
  });
  assert.equal(refusedWrite.ok, false);
  assert.equal(refusedWrite.ok ? "" : refusedWrite.reason, "conflict");
  assert.equal(await readFile(foreignPath, "utf8"), foreignBytes, "a malformed association is never overwritten");
});

test("stored records must already be canonical: a relative stored path is refused, not re-resolved", async () => {
  const path = join(root, "artifact-stored", PI_SESSION_REFERENCE_DIRNAME, `${SESSION_ID}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ id: SESSION_ID, file: "sessions/x.jsonl", cwd: "worktree" }), "utf8");
  assert.equal(await readPiSessionReferenceAt(path), undefined, "a relative stored record is not a usable reference");
});

// ---------------------------------------------------------------------------
// Enumeration: exactly this owner's references, nothing else
// ---------------------------------------------------------------------------

test("enumeration reads only this owner's pi-sessions directory and reports every unusable entry", async () => {
  const artifactDir = join(root, "artifact-list");
  const referencesDir = join(artifactDir, PI_SESSION_REFERENCE_DIRNAME);
  const file = await nativeSession({ cwd: workspace });
  await writePiSessionReference(artifactDir, { id: SESSION_ID, file, cwd: workspace });
  await writeFile(join(referencesDir, "not-a-reference.txt"), "ignored\n", "utf8");
  await writeFile(join(referencesDir, "malformed.json"), "{not json\n", "utf8");
  await writeFile(join(referencesDir, "99999999-9999-9999-9999-999999999999.json"), JSON.stringify({
    id: "88888888-8888-8888-8888-888888888888", file, cwd: workspace,
  }), "utf8");
  // A sibling artifact's references are NOT this owner's and must not appear.
  await mkdir(join(root, "artifact-list-sibling", PI_SESSION_REFERENCE_DIRNAME), { recursive: true });
  await writeFile(join(root, "artifact-list-sibling", PI_SESSION_REFERENCE_DIRNAME, "sibling.json"), "{}\n", "utf8");

  const entries = await collect(iteratePiSessionReferenceDirectory(referencesDir));
  assert.deepEqual(entries.map((entry) => entry.name).sort(), [
    "99999999-9999-9999-9999-999999999999.json",
    `${SESSION_ID}.json`,
    "malformed.json",
  ], "only .json entries are reported, and unusable ones are named rather than skipped silently");
  const usable = entries.find((entry) => entry.reference);
  assert.deepEqual(usable?.reference, { id: SESSION_ID, file, cwd: workspace });
  const mismatched = entries.find((entry) => entry.name.startsWith("99999999"));
  assert.match(mismatched?.detail ?? "", /does not match its file name/);
  assert.match(entries.find((entry) => entry.name === "malformed.json")?.detail ?? "", /canonical/);

  // A missing reference directory simply yields nothing (no error, no scan).
  assert.deepEqual(await collect(iteratePiSessionReferenceDirectory(join(root, "does-not-exist"))), []);
});

test("enumeration stops when the consumer stops and never walks outside the reference directory", async () => {
  const artifactDir = join(root, "artifact-partial");
  const referencesDir = join(artifactDir, PI_SESSION_REFERENCE_DIRNAME);
  await mkdir(referencesDir, { recursive: true });
  for (let index = 0; index < 5; index += 1) {
    const id = `${index}${"0".repeat(31 - String(index).length)}`;
    await writeFile(join(referencesDir, `${id}.json`), JSON.stringify({ id, file: join(nativeStore, `${id}.jsonl`), cwd: workspace }), "utf8");
  }
  const generator = iteratePiSessionReferenceDirectory(referencesDir);
  let seen = 0;
  for await (const entry of generator) {
    seen += 1;
    if (seen === 2) break;
  }
  await generator.return(undefined);
  assert.equal(seen, 2, "the consumer decides how far enumeration goes; nothing is silently truncated");
});

// ---------------------------------------------------------------------------
// Verification and exact-path resolution
// ---------------------------------------------------------------------------

test("verification requires a regular-file native header proving this id AND this workspace", async () => {
  const artifactDir = join(root, "artifact-verify");
  const file = await nativeSession({ cwd: workspace, name: "verify.jsonl" });

  assert.equal(verifyPiSessionReference({ id: SESSION_ID, file, cwd: workspace }).ok, true);
  const wrongId = verifyPiSessionReference({ id: "ffffffff-0000-0000-0000-000000000000", file, cwd: workspace });
  assert.equal(wrongId.ok, false);
  assert.equal(wrongId.ok ? "" : wrongId.reason, "id-mismatch");
  const wrongCwd = verifyPiSessionReference({ id: SESSION_ID, file, cwd: join(root, "elsewhere") });
  assert.equal(wrongCwd.ok, false);
  assert.equal(wrongCwd.ok ? "" : wrongCwd.reason, "cwd-mismatch");

  const missing = verifyPiSessionReference({ id: SESSION_ID, file: join(nativeStore, "absent.jsonl"), cwd: workspace });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok ? "" : missing.reason, "file-missing");

  const symlinked = join(nativeStore, "symlinked.jsonl");
  await symlink(file, symlinked);
  const refused = verifyPiSessionReference({ id: SESSION_ID, file: symlinked, cwd: workspace });
  assert.equal(refused.ok, false, "a symlinked session file is never treated as the session history");
});

test("continuation resolves the exact verified absolute path and refuses every other shape", async () => {
  const artifactDir = join(root, "artifact-resolve");
  const file = await nativeSession({ cwd: workspace, name: "resolve.jsonl" });
  await writePiSessionReference(artifactDir, { id: SESSION_ID, file, cwd: workspace });

  const resolved = await resolveVerifiedPiSessionFile({ ownerArtifactDir: artifactDir, sessionId: SESSION_ID, cwd: workspace });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.reference.file, file);
  assert.ok(resolved.ok && resolved.reference.file.startsWith("/"));

  // Same id, different workspace: Pi would answer `--session-id` with an empty
  // same-id session, so this must be a refusal, not a resume.
  const relocated = await resolveVerifiedPiSessionFile({ ownerArtifactDir: artifactDir, sessionId: SESSION_ID, cwd: join(root, "new-worktree") });
  assert.equal(relocated.ok, false);
  assert.match(relocated.ok ? "" : relocated.message, /workspace/);

  const unknown = await resolveVerifiedPiSessionFile({ ownerArtifactDir: artifactDir, sessionId: "ffffffff-1234-5678-9abc-def012345678", cwd: workspace });
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok ? "" : unknown.message, /No canonical native session reference/);

  // The reference is the only thing that locates the history: deleting the
  // transcript leaves an explicit refusal (no re-resolution, no store search).
  const movedId = "cccccccc-1111-2222-3333-444444444444";
  const movedAway = await nativeSession({ id: movedId, cwd: workspace, name: "gone.jsonl" });
  await writePiSessionReference(artifactDir, { id: movedId, file: movedAway, cwd: workspace });
  const stillResolves = await resolveVerifiedPiSessionFile({ ownerArtifactDir: artifactDir, sessionId: movedId, cwd: workspace });
  assert.equal(stillResolves.ok, true);
  await rm(movedAway, { force: true });
  const afterDeletion = await resolveVerifiedPiSessionFile({ ownerArtifactDir: artifactDir, sessionId: movedId, cwd: workspace });
  assert.equal(afterDeletion.ok, false);
});

// ---------------------------------------------------------------------------
// The gate-owned reporter extension
// ---------------------------------------------------------------------------

test("the reporter extension is inert without its run-private target and otherwise records the reported identity", async () => {
  const artifactDir = join(root, "artifact-reporter");
  const target = piSessionReferencePath(artifactDir, SESSION_ID);
  // The transcript lives under the session cwd so Pi's relative report is real.
  const storeUnderCwd = join(workspace, ".pi-native-store");
  const file = await nativeSession({ cwd: workspace, name: "reported.jsonl", dir: storeUnderCwd });
  const handlers: Array<(event: unknown, ctx: unknown) => void | Promise<void>> = [];
  const api = { on: (_event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) => { handlers.push(handler); } };

  const savedEnv = process.env[PI_SESSION_REFERENCE_ENV];
  delete process.env[PI_SESSION_REFERENCE_ENV];
  reporterDefault(api);
  assert.equal(handlers.length, 0, "without the parent's exact target path the extension registers nothing");

  process.env[PI_SESSION_REFERENCE_ENV] = target;
  reporterDefault(api);
  assert.equal(handlers.length, 1, "with the target path the extension observes session_start");
  // Pi reports a RELATIVE session file when the effective sessionDir is relative.
  const relativeFile = file.slice(`${workspace}/`.length);
  assert.ok(relativeFile.length > 0 && !relativeFile.startsWith("/"));
  const sessionManager = {
    getSessionId: () => SESSION_ID,
    getSessionFile: () => relativeFile,
    getCwd: () => workspace,
  };
  await handlers[0]!({}, { sessionManager });
  assert.deepEqual(await readPiSessionReference(artifactDir, SESSION_ID), { id: SESSION_ID, file, cwd: workspace });

  // A session manager reporting nothing leaves the reference unwritten; the
  // parent then reports "no canonical reference" instead of guessing a path.
  const otherTarget = piSessionReferencePath(artifactDir, "eeeeeeee-1111-2222-3333-444444444444");
  process.env[PI_SESSION_REFERENCE_ENV] = otherTarget;
  const silent: Array<(event: unknown, ctx: unknown) => void | Promise<void>> = [];
  reporterDefault({ on: (_event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) => { silent.push(handler); } });
  const stderr: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    await silent[0]!({}, { sessionManager: { getSessionId: () => SESSION_ID, getSessionFile: () => undefined, getCwd: () => workspace } });
  } finally {
    process.stderr.write = originalWrite;
    if (savedEnv === undefined) delete process.env[PI_SESSION_REFERENCE_ENV];
    else process.env[PI_SESSION_REFERENCE_ENV] = savedEnv;
  }
  assert.match(stderr.join(""), /no persistent session identity/);
  assert.equal(await readPiSessionReferenceAt(otherTarget), undefined);
});

// ---------------------------------------------------------------------------
// Evidence: canonical referenced history is indexed in place, once
// ---------------------------------------------------------------------------

async function buildEvidence(name: string, taskId = "task-1"): Promise<{ bundle: SubtaskEvidenceBundle; artifactDir: string }> {
  const waveRoot = join(root, name);
  const artifactDir = join(waveRoot, "artifacts", taskId);
  await mkdir(join(artifactDir, "executor", "0001"), { recursive: true });
  return { bundle: await buildSubtaskEvidence({ taskId, waveRoot, artifactDir }), artifactDir };
}

function piTurnProcessResult(sessionId: string): string {
  return JSON.stringify({ adapter: "pi-model", sessionId, exitCode: 0, finalTextCaptured: true });
}

test("canonical referenced native history is indexed in place with its own source identity", async () => {
  const nativeFile = await nativeSession({ cwd: workspace, name: "2025-06-01T10-00-00_referenced.jsonl" });
  const { artifactDir } = await buildEvidence("evidence-referenced");
  await writePiSessionReference(artifactDir, { id: SESSION_ID, file: nativeFile, cwd: workspace });
  await writeFile(join(artifactDir, "executor", "0001", "process-result.json"), piTurnProcessResult(SESSION_ID), "utf8");
  // The turn's stdout capture exists but must NOT be indexed alongside the
  // session: one turn, one authoritative history, no double counting.
  await writeFile(join(artifactDir, "executor", "0001", "raw-stream.txt"), "STDOUT-ONLY-MARKER partial capture\n", "utf8");

  const rebuilt = await buildSubtaskEvidence({
    taskId: "task-1",
    waveRoot: join(root, "evidence-referenced"),
    artifactDir,
  });
  const sessionSource = rebuilt.snapshot.sources.find((source) => source.stream === "session");
  assert.ok(sessionSource, `the referenced native session must be indexed, got: ${rebuilt.snapshot.sources.map((source) => source.sourceId).join(", ")}`);
  assert.equal(sessionSource.sourceId, "session:2025-06-01T10-00-00_referenced.jsonl");
  assert.equal(sessionSource.file, `${PI_SESSION_REFERENCE_DIRNAME}/${SESSION_ID}.json`);
  const text = [...rebuilt.snapshot.contentByEntryId.values()].join("\n");
  assert.match(text, /NATIVE-HISTORY-MARKER/);
  assert.ok(!text.includes("STDOUT-ONLY-MARKER"), "the session file is the single source of truth for a pi turn");
  assert.ok(!rebuilt.snapshot.unavailable.some((note) => note.source === "turn:0001" && note.reason === "missing_stream"),
    "a turn covered by its canonical session must not report a stdout fallback");
});

for (const id of [SESSION_ID, "native_id_with_underscores"]) {
  test(`a referenced session ${id} is never double counted with an artifact-local copy`, async () => {
    const nativeFile = await nativeSession({ id, cwd: workspace, name: `2025-06-01T10-00-00_${id}.jsonl` });
    const evidenceName = `evidence-dedup-${id}`;
    const { artifactDir } = await buildEvidence(evidenceName);
    await mkdir(join(artifactDir, "executor-sessions"), { recursive: true });
    await writeFile(join(artifactDir, "executor-sessions", `2025-06-01T10-00-00_${id}.jsonl`), await readFile(nativeFile, "utf8"), "utf8");
    await writePiSessionReference(artifactDir, { id, file: nativeFile, cwd: workspace });
    await writeFile(join(artifactDir, "executor", "0001", "process-result.json"), piTurnProcessResult(id), "utf8");

    const rebuilt = await buildSubtaskEvidence({
      taskId: "task-1",
      waveRoot: join(root, evidenceName),
      artifactDir,
    });
    const sessionSources = rebuilt.snapshot.sources.filter((source) => source.stream === "session");
    assert.equal(sessionSources.length, 1, `one session, one source: ${sessionSources.map((source) => source.sourceId).join(", ")}`);
    assert.equal(sessionSources[0].file, `${PI_SESSION_REFERENCE_DIRNAME}/${id}.json`, "the canonical referenced history is the indexed one");
  });
}

test("an unusable reference is disclosed explicitly and never silently downgrades the turn", async () => {
  const missingFile = join(nativeStore, "2025-06-01T10-00-00_missing.jsonl");
  const { artifactDir } = await buildEvidence("evidence-unusable");
  await writePiSessionReference(artifactDir, { id: SESSION_ID, file: missingFile, cwd: workspace });
  await writeFile(join(artifactDir, "executor", "0001", "process-result.json"), piTurnProcessResult(SESSION_ID), "utf8");
  await writeFile(join(artifactDir, "executor", "0001", "raw-stream.txt"), "assistant said something partial\n", "utf8");

  const rebuilt = await buildSubtaskEvidence({
    taskId: "task-1",
    waveRoot: join(root, "evidence-unusable"),
    artifactDir,
  });
  const referenceNote = rebuilt.snapshot.unavailable.find((note) => note.source === `${PI_SESSION_REFERENCE_DIRNAME}/${SESSION_ID}.json`);
  assert.ok(referenceNote, `the unusable reference must be reported: ${rebuilt.snapshot.unavailable.map((note) => note.source).join(", ")}`);
  assert.equal(referenceNote.reason, "reference_unverified");
  const turnNote = rebuilt.snapshot.unavailable.find((note) => note.source === "turn:0001");
  assert.match(turnNote?.detail ?? "", /canonically referenced but unusable/);
  assert.match(turnNote?.detail ?? "", /not the complete executor history/);
});

test("a malformed reference entry is reported, not guessed, and leaves other sources intact", async () => {
  const goodFile = await nativeSession({ cwd: workspace, name: "2025-06-01T10-00-00_good.jsonl" });
  const { artifactDir } = await buildEvidence("evidence-malformed-ref");
  await mkdir(join(artifactDir, PI_SESSION_REFERENCE_DIRNAME), { recursive: true });
  await writeFile(join(artifactDir, PI_SESSION_REFERENCE_DIRNAME, "broken.json"), "{not json\n", "utf8");
  await writePiSessionReference(artifactDir, { id: SESSION_ID, file: goodFile, cwd: workspace });

  const rebuilt = await buildSubtaskEvidence({
    taskId: "task-1",
    waveRoot: join(root, "evidence-malformed-ref"),
    artifactDir,
  });
  assert.ok(rebuilt.snapshot.unavailable.some((note) => note.source === `${PI_SESSION_REFERENCE_DIRNAME}/broken.json`
    && note.reason === "reference_unverified"));
  assert.ok(rebuilt.snapshot.sources.some((source) => source.sourceId === "session:2025-06-01T10-00-00_good.jsonl"));
});

test("references are read only from the owner's own artifact directory", async () => {
  const foreignRoot = join(root, "evidence-foreign-owner");
  const foreignArtifact = join(foreignRoot, "artifacts", "task-1");
  await mkdir(join(foreignArtifact, "executor", "0001"), { recursive: true });
  // A reference directory belonging to a DIFFERENT artifact sits alongside, not
  // inside, this artifact root: it must contribute nothing.
  const sibling = join(foreignRoot, "artifacts", "task-other", PI_SESSION_REFERENCE_DIRNAME);
  await mkdir(sibling, { recursive: true });
  const file = await nativeSession({ cwd: workspace, name: "2025-06-01T10-00-00_sibling.jsonl" });
  await writeFile(join(sibling, `${SESSION_ID}.json`), JSON.stringify({ id: SESSION_ID, file, cwd: workspace }), "utf8");

  const rebuilt = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: foreignRoot, artifactDir: foreignArtifact });
  assert.equal(rebuilt.snapshot.sources.find((source) => source.stream === "session"), undefined);
  // The real owner does index it, proving the location itself is readable.
  await writePiSessionReference(foreignArtifact, { id: SESSION_ID, file, cwd: workspace });
  const owned = await buildSubtaskEvidence({ taskId: "task-1", waveRoot: foreignRoot, artifactDir: foreignArtifact });
  assert.ok(owned.snapshot.sources.some((source) => source.sourceId === "session:2025-06-01T10-00-00_sibling.jsonl"));
});

// ---------------------------------------------------------------------------
// Ownership: the reference directory itself is the ownership proof
// ---------------------------------------------------------------------------

// A symlinked `pi-sessions/` directory would otherwise hand another artifact's
// perfectly well-formed references to this owner — native header verification
// cannot detect that substitution, so containment is enforced instead.
test("a symlinked pi-sessions directory yields no other artifact's references", { skip: process.platform === "win32" }, async () => {
  const base = join(root, "ownership-symlink");
  const owner = join(base, "artifacts", "task-owner");
  const sibling = join(base, "artifacts", "task-sibling");
  await mkdir(owner, { recursive: true });
  await mkdir(join(sibling, PI_SESSION_REFERENCE_DIRNAME), { recursive: true });
  const file = await nativeSession({ cwd: workspace, name: "2025-06-01T10-00-00_borrowed.jsonl" });
  await writePiSessionReference(sibling, { id: SESSION_ID, file, cwd: workspace });
  await symlink(join(sibling, PI_SESSION_REFERENCE_DIRNAME), join(owner, PI_SESSION_REFERENCE_DIRNAME), "dir");

  const entries = await collect(iteratePiSessionReferences(owner));
  assert.equal(entries.filter((entry) => entry.reference).length, 0,
    `a borrowed directory must yield no usable reference: ${entries.map((entry) => entry.name).join(", ")}`);
  assert.equal(entries.length, 1, "the ownership failure is reported, never skipped silently");
  assert.match(entries[0].detail ?? "", /symlink/);

  assert.equal(await readPiSessionReference(owner, SESSION_ID), undefined);
  const resolution = await resolveVerifiedPiSessionFile({ ownerArtifactDir: owner, sessionId: SESSION_ID, cwd: workspace });
  assert.equal(resolution.ok, false);
  if (!resolution.ok) assert.match(resolution.message, /symlink/);

  // Nothing is written through the link either, so the sibling keeps its own
  // records and gains nothing owned by another task.
  const written = await writePiSessionReference(owner, { id: "another-session-id", file, cwd: workspace });
  assert.equal(written.ok, false);
  if (!written.ok) assert.match(written.message, /symlink/);
  assert.deepEqual((await readdir(join(sibling, PI_SESSION_REFERENCE_DIRNAME))).sort(), [`${SESSION_ID}.json`]);
  assert.ok(await readPiSessionReference(sibling, SESSION_ID), "the real owner still reads its own reference");
});

// ---------------------------------------------------------------------------
// Evidence bounds: reference discovery is bounded like every other discovery
// ---------------------------------------------------------------------------

test("reference discovery stops at the source limit with one overflow disclosure", async () => {
  const { artifactDir } = await buildEvidence("evidence-reference-source-budget");
  const refs = join(artifactDir, PI_SESSION_REFERENCE_DIRNAME);
  await mkdir(refs, { recursive: true });
  const total = EVIDENCE_MAX_SOURCES + 6;
  for (let index = 0; index < total; index += 1) {
    const id = `sessio${index}0000000000000000000000000000`;
    const file = await nativeSession({
      id,
      cwd: workspace,
      name: `2025-06-01T10-00-00_overflow-${index}.jsonl`,
    });
    await writeFile(join(refs, `${id}.json`), JSON.stringify({ id, file, cwd: workspace }), "utf8");
  }

  const rebuilt = await buildSubtaskEvidence({
    taskId: "task-1",
    waveRoot: join(root, "evidence-reference-source-budget"),
    artifactDir,
  });
  const sessionSources = rebuilt.snapshot.sources.filter((source) => source.stream === "session");
  assert.ok(sessionSources.length > 0, "references before the limit are still indexed");
  assert.ok(sessionSources.length <= EVIDENCE_MAX_SOURCES, `no more than the source limit is indexed, got ${sessionSources.length}`);
  const overflows = rebuilt.snapshot.unavailable.filter((note) => note.reason === "source_budget"
    && (note.source ?? "").startsWith(`${PI_SESSION_REFERENCE_DIRNAME}/`));
  assert.equal(overflows.length, 1, `one overflow disclosure, got ${overflows.length}`);
  assert.match(overflows[0].detail, /Source limit/);
});

test("malformed reference entries consume the enumeration budget and stop with one disclosure", async () => {
  const { artifactDir } = await buildEvidence("evidence-reference-enum-budget");
  const refs = join(artifactDir, PI_SESSION_REFERENCE_DIRNAME);
  await mkdir(refs, { recursive: true });
  const total = EVIDENCE_MAX_ENUMERATED_ENTRIES + 8;
  for (let index = 0; index < total; index += 1) {
    await writeFile(join(refs, `broken-${String(index).padStart(5, "0")}.json`), "{not json\n", "utf8");
  }

  const rebuilt = await buildSubtaskEvidence({
    taskId: "task-1",
    waveRoot: join(root, "evidence-reference-enum-budget"),
    artifactDir,
  });
  const reported = rebuilt.snapshot.unavailable.filter((note) => (note.source ?? "").startsWith(`${PI_SESSION_REFERENCE_DIRNAME}/broken-`));
  assert.ok(reported.length > 0, "malformed references before the bound are still disclosed");
  assert.ok(reported.length < total, `the walk must stop instead of inspecting all ${total} entries, got ${reported.length}`);
  assert.ok(reported.length <= EVIDENCE_MAX_ENUMERATED_ENTRIES);
  const overflows = rebuilt.snapshot.unavailable.filter((note) => note.reason === "source_budget"
    && note.source === `${PI_SESSION_REFERENCE_DIRNAME}/`);
  assert.equal(overflows.length, 1, "overflow is disclosed once, not per remaining entry");
  assert.match(overflows[0].detail, /enumeration budget/);
});

// Names that are not references at all must still be charged to the budget —
// otherwise a directory of irrelevant files is walked without bound.
test("non-reference names consume the evidence enumeration budget with one disclosure", async () => {
  const { artifactDir } = await buildEvidence("evidence-reference-nonjson-budget");
  const refs = join(artifactDir, PI_SESSION_REFERENCE_DIRNAME);
  await mkdir(refs, { recursive: true });
  const total = EVIDENCE_MAX_ENUMERATED_ENTRIES + 8;
  for (let index = 0; index < total; index += 1) {
    await writeFile(join(refs, `notes-${String(index).padStart(5, "0")}.txt`), "not a reference\n", "utf8");
  }

  const rebuilt = await buildSubtaskEvidence({
    taskId: "task-1",
    waveRoot: join(root, "evidence-reference-nonjson-budget"),
    artifactDir,
  });
  const overflows = rebuilt.snapshot.unavailable.filter((note) => note.reason === "source_budget"
    && note.source === `${PI_SESSION_REFERENCE_DIRNAME}/`);
  assert.equal(overflows.length, 1, "exactly one enumeration-budget disclosure");
  assert.match(overflows[0].detail, /enumeration budget/);
  assert.equal(
    rebuilt.snapshot.unavailable.filter((note) => (note.source ?? "").startsWith(`${PI_SESSION_REFERENCE_DIRNAME}/notes-`)).length,
    0,
    "irrelevant names produce no per-entry diagnostics",
  );
});

// The predicate is the consumer's bound; the cleanup-facing iterator is not.
test("the enumeration predicate stops before irrelevant names while cleanup enumeration stays uncapped", async () => {
  const artifactDir = join(root, "artifact-predicate");
  const referencesDir = join(artifactDir, PI_SESSION_REFERENCE_DIRNAME);
  await mkdir(referencesDir, { recursive: true });
  for (let index = 0; index < 6; index += 1) {
    await writeFile(join(referencesDir, `notes-${index}.txt`), "not a reference\n", "utf8");
  }
  let inspected = 0;
  const bounded = await collect(iteratePiSessionReferenceDirectory(referencesDir, () => {
    if (inspected >= 2) return false;
    inspected += 1;
    return true;
  }));
  assert.deepEqual(bounded, []);
  assert.equal(inspected, 2, "traversal ends at the bound instead of skipping names one by one");
  assert.deepEqual(await collect(iteratePiSessionReferences(artifactDir)), [],
    "the owner-facing cleanup iterator takes no bound and reads nothing it cannot use");
});
