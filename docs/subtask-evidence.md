# Subtask evidence

This page owns the executor-evidence interface for delegated subtasks: what the
`SubtasksInspect` evidence selector indexes, how entries are provenance-separated,
redacted, retained, and bounded, and how review cycles and authoritative context are
presented. Task lifecycle, worker kinds and modes, capture and landing, conflicts,
continuation, and notifications remain owned by
[Delegated execution](delegated-execution.md).

`SubtasksInspect` accepts an optional `evidence` selector that reads a task's bounded,
indexed executor evidence instead of the legacy activity window. The two interfaces are
mutually exclusive: combining `evidence` with `offset`/`lines` is a hard error, and
legacy activity behavior is unchanged when `evidence` is absent.

Evidence indexes only authorized per-task artifacts under the task's wave root: executor
session files (Pi) or per-turn raw streams (Claude/Codex/binary), final responses,
process results, the durable operation record, completed review cycles, and the latest
review report. Every source
that is missing, unreadable, unsupported, or truncated appears as an explicit
`unavailable` note; nothing is invented to fill a gap, and no caller-supplied path can
widen the read boundary (symlinks and path escapes are refused). For a Pi turn whose
session file is missing, that turn falls back explicitly to its own stdout stream and is
never double-counted from both.

Retained Claude and Codex streams are indexed with adapter-specific honesty. Claude
tool calls and results pair by the stream's real tool ids (a call without an observed
result stays `in_flight`), and entries carry the stream's own timestamps for display —
the SDK marks them display-only, so source ordering keeps its artifact basis. Modern
retained Codex app-server streams carry stable item ids: started/completed pairs link
by that observed identity, scoped to the source stream (one retained stream is one
app-server session) — the pairing decision stays with that stream's parser, so
snapshot-wide id matching never re-pairs these entries across ambiguous duplicates or
different sources; older id-less captures keep conservative positional pairing only
while unambiguous, a missing id never matches an observed one, and overlapping or
mismatched items stay unpaired rather than guessed. A call read for such an id reports
only a validated pair: a single unlinked entry stays honestly unpaired, and an id
shared by several unlinked entries is refused explicitly instead of guessing. Item types and command-result
fields are accepted in both observed serializations (camelCase and snake_case). When a
turn's process-result.json does not record its adapter (in-flight or incomplete turns),
a readable raw stream is indexed only when the durable operation record's canonical
per-turn evidence — the attempt that ran the turn and the assignment that served it —
establishes that turn's own adapter; the record's current adapter field describes only
its latest assignment, so an earlier turn is never relabeled with a later executor, and
a stream whose adapter cannot be established from durable evidence stays explicitly
unavailable. Disclosed indexing carries an explicit `adapter_from_operation_record`
note. An empty search over indexed evidence reports zero matches and remains distinct
from genuinely missing or unsupported sources.

Each entry carries a stable `entryId`, timestamp, kind, tool name, status, and
provenance. Provenance separates what an executor process observed
(`executor_observed`) from what a worker wrote in its final response (`worker_claim`,
which never implies verification) from reviewer verdicts (`reviewer_verdict`). Tool calls
and results are paired by real call ids; a call without an observed result stays
`in_flight`, which is never evidence of success. Private model reasoning (Pi thinking
blocks, Codex reasoning items) is excluded from every view, and all retained content is
redacted before search or display.

That redaction is the shared heuristic text pass applied once at snapshot assembly,
so find, previews, deep reads, continuations, and rendered views all serve the same
retained bytes: sensitive-key assignments, known token formats, JWTs, and PEM private
keys are replaced with a `[REDACTED]` marker. One narrow exception keeps the
representative GitHub Actions permission declaration readable: a bare, unquoted
`id-token: write` line directly under a less-indented `permissions:` mapping key in
multiline block YAML (including realistic sibling scopes such as `contents: read`)
is preserved because the value is a permission level, not a credential. Every other
`id-token` assignment still redacts — `id-token: read`, quoted or inline/flow
values, list items, and occurrences outside such a permissions mapping (including
one that merely follows an earlier permissions block in a later, unrelated
mapping), longer keys containing the run (`my-id-token`), and real credentials
such as provider tokens or JWTs — as does every other sensitive key. The heuristic
remains pattern-based, so residual limitations stay in both directions: harmless
text that merely looks like a sensitive assignment (for example `id-token: read`,
a list-form `id-token: [read]` value, a quoted permission declaration, or a longer
key that contains `token`) may still be redacted, and secrets in unrecognized
formats are not captured. Entry previews stay compact (whitespace-collapsed
and bounded); deep reads are distinct from previews and preserve the retained text's
own whitespace — newlines, indentation, tabs, and blank lines — so multiline YAML,
source code, diffs, and command output arrive readable, with continued chunks
reconstructing the retained content exactly and truncation/continuation explicit.

Completed review cycles are persisted as official records under the task's artifact
directory (`reviews/<waveId>/cycle-NNNN.json`, one per cycle, numbered to match the
immutable per-cycle review alias) at the moment each cycle completes — so a
`needs_changes` verdict and its findings (stable finding ids, severity and blocking
status, location, and recommendation, plus the reviewer's summary and guidance) are
inspectable through `find`, `filter: "review"`, and deep reads while a worker is actively
correcting, before any final task result exists. Each cycle also contributes lifecycle
entries: before settlement, no cycle is asserted to be definitively current — the
newest readable cycle is presented as the latest available review evidence with unknown
completeness (a later cycle's record could have failed to publish without leaving a
trace), and every earlier cycle is explicitly marked as superseded, so a historical
blocker is never presented as the current verdict while both remain searchable. When no completed review evidence exists at all (a review
in flight, or a disabled or unreviewed run), evidence reads report an explicit
`review_unavailable` note instead of a silent empty success; unreadable, malformed,
oversized, foreign-task, or symlinked cycle records are likewise refused with per-file
notes and never indexed. If a completed cycle's record fails to publish, the lifecycle
best-effort leaves an explicit marker (`cycle-NNNN.json.unpublished`) beside the missing
record carrying the official gate verdict, summary, and a bounded failure reason: that
cycle counts toward review completeness and its verdict stays visible through its
lifecycle entry, but its per-reviewer findings are not readable because no durable record
exists, and the marker itself is refused with an explicit note when it is malformed or
foreign. When a later unusable sibling — an unreadable or refused record, or a
publication-failure marker — exists before settlement, its lifecycle entry and the
context summary say the newest readable cycle cannot be confirmed (or name the
superseding unpublished cycle when the marker identifies one), rather than presenting a
possibly superseded verdict as the current one. If both writes fail under a shared fault
such as ENOSPC or directory permissions, no trace of the completed cycle exists at all,
and the same conservative qualification applies: the newest readable cycle is latest
available with unknown completeness until settlement. Once a final
result with a review report exists, it is reconciled with the durable cycles by review
identity: cycle persistence is best-effort, so when the latest cycle's record is missing
or unreadable (or left only as an explicit publication-failure marker) the report covers
a newer review than every usable durable cycle and is indexed — with
each earlier cycle marked superseded by the final report — so a later official pass is
never hidden behind an older persisted blocker. When the durable cycles already cover the
report's latest review, the report is not counted twice. Reads are bounded: per-entry and total byte budgets,
a bounded tail byte window per source (only the newest bytes of each stream are
scanned, so evidence appended beyond any fixed offset stays reachable; earlier bytes
and the boundary record are disclosed as `scan_budget`), a global rolling entry window
that retains the newest entries across all sources (`records_omitted` when older ones
overflow), and a shared raw retention budget across all sources that evicts the oldest
retained content first — releasing it immediately — so discovery memory stays bounded
no matter how many artifacts exist. Directory enumeration applies its bound during
iteration, before the whole directory is allocated. Every bound reports an explicit
`unavailable` note or `truncated` marker instead of cutting silently.

Navigation follows the same block model as the web tools. Each object below is a
complete `SubtasksInspect` argument value — the registered schema has no `action`
field, because each operation has its own exact-schema tool:

```jsonc
// Find a failure across all indexed evidence (case-insensitive, redacted view)
{ "executionId": "exec-…", "taskId": "task-…",
  "evidence": { "find": "E2E-FAILURE-MARKER" } }

// Page the index; nextIndex continues the range. Unfiltered reads also return a cursor.
{ "executionId": "exec-…", "taskId": "task-…",
  "evidence": { "index": 0, "limit": 20 } }

// A later turn: continue from the cursor to receive only newer evidence. Cursors are
// watermark-scoped per source and carry a chained digest of every covered record,
// salted with the opened file's generation (device/inode/birth time); they are rejected
// explicitly when a covered source is missing, atomically replaced — even with an
// identical covered prefix — or any covered record was rewritten. Appends to the same
// file preserve the generation and continue exactly once (no silent skip, duplicate,
// or stale continuation).
{ "executionId": "exec-…", "taskId": "task-…",
  "evidence": { "cursor": "ev1.…" } }

// Deep-read one large entry in bounded chunks; the chunk text preserves the
// retained content's own newlines, indentation, tabs, and blank lines (redaction
// and retention caps excepted), and continued chunks reconstruct it exactly.
{ "executionId": "exec-…", "taskId": "task-…",
  "evidence": { "entryId": "turn:0001/line:12", "chunkIndex": 0 } }

// Resolve one call and its paired result by real call id
{ "executionId": "exec-…", "taskId": "task-…",
  "evidence": { "callId": "toolu_…" } }
```

`filter` narrows a range to `tool_call`, `tool_result`, `command`, `lifecycle`,
`claim`, or `review` entries (filtered reads do not issue cursors). Evidence reads also
return the authoritative context: current task state, assignment history and current
selection, steering acknowledgements, changed files with honest landing status, and the
latest review verdicts. The artifact root is validated against the authorized wave root
before anything under it is read (a symlinked or moved artifacts directory is refused,
never followed), and the operation record informs that context only when it is a
regular file inside that verified directory, fits the bounded context size, belongs to
this task, and records an artifact directory that verifies as this task's; every other
case is reported as an explicit unavailable note rather than read unbounded or trusted.

The collapsed tool card summarizes each read at a glance. The call line names the task
and the effective mode using safe selectors only — `status` for a plain inspection, the
activity offset for legacy paging, `find "<query>"` with an optional `filter`, the
requested `entries start..end` window, the entry handle plus chunk for deep reads, the
call handle for pair resolution, or `cursor continuation` (opaque cursor tokens are never
displayed) — and query/selector text is redacted before display. The result line reports
the operation-specific outcome instead of scheduler boilerplate: the returned entry range
with its provenance mix and retention-truncated entries, match totals with list
truncation, call/result resolution (`returned`, an observed result with unresolved
pairing, or in flight with no result observed), deep-read chunk size and continuation,
or the newer-entry count for cursor reads — plus available continuations (`nextIndex`,
incremental cursor) and important unavailable notes such as missing tool evidence.
Retained content, entry previews, and private reasoning never appear in the collapsed
card; expanding the result with Pi's native expansion binding (ctrl+o by default) renders
the #59 expanded detail view — the same returned data, never a rerun or retrieval,
reorganized into provenance-separated sections (observed evidence, worker claims,
reviewer verdicts, and the authoritative durable context) with the snapshot's
"as of" freshness, unavailable ranges, truncated records, and every omitted range
disclosed — and re-collapsing restores the unchanged collapsed card. Evidence reads are
mode-specific and complete in the expanded view: the find query and every returned
match, the requested range and every returned entry, the full returned chunk with its
whitespace, and the actual call with its paired result or its not-yet-observed state.
Streaming, error, and cancelled results stay stable in both states: a still-streaming
result renders a bounded pending view even when expanded, and evidence selector
failures stay task-scoped in the expanded view.

Selector failures are scoped: with a valid, authorized `taskId`, a mistyped `entryId`, an
unknown `callId`, a malformed or expired `cursor`, or an out-of-range `index` returns one
concise task-scoped diagnostic with a bounded navigation hint (list entries with
`index`/`limit`, optionally `filter` or `find`, then deep-read by the exact `entryId` or
resolve a call by its real `callId`) — never the unrelated executions' inventory, IDs,
titles, artifact paths, or recovery history. The evidence snapshot is built once per
inspection, before any checkpoint-backfill recovery, and that validated read is returned
unchanged — so a selector can never fail only after a recovery write — while the
surrounding task inspection still reflects any backfilled state; a follow-up evidence read
picks up post-recovery changes. A correct selector still succeeds, an invalid read mutates
neither the task record nor the workspace, and an in-range index with a limit beyond the
remaining entries (or a filtered read with no matches) is a valid clamped/empty result,
not an error.

Prefer `SubtasksWatch` when you must wait for a state change (it returns immediately
and arms one deliberate future checkpoint while work remains active; it never waits
synchronously or rearms itself); use evidence-mode `SubtasksInspect` when you need to
understand *what happened* — locating a failure, checking whether a command result was
observed versus merely claimed, reading reviewer findings, or confirming unlanded
changes.
