# Recovery

This page owns crash recovery for landing manifests, session-scoped restart recovery,
executor retry and failover, and what shutdown preserves or removes. Conflict resolution
steps for the live gate live in
[Delegated execution](delegated-execution.md#conflicts-and-gates).

## Session-scoped restart recovery

The extension does not globally scan the filesystem for arbitrary landing manifests at
startup. Review and execution associations restore only when the same Pi conversation
and session file are resumed from the matching cwd. Review and execution recovery state
is scoped to the exact Pi conversation. The normal restart flow — launching into a
temporary/default session and then running `/resume <session>` — loads the selected
conversation in a fresh extension runtime and restores only that conversation's
integrity-checked sidecar state. The temporary startup session is shut down and cannot
leak its review window or execution associations into the resumed session.

Restored state includes review baselines/evidence, pending model deliveries, execution
groups, operation bundles, task definitions, activity, commands, incidents, checkpoints,
and conflict gates. A live or uncertain owner blocks another writer; a confirmed-dead
writer can be reconciled into a freshly reverified checkpoint before an explicit
continuation. A stopped task with a durable bundle is then queued for continuation, and
that continuation reconciles verified in-progress or recovery-required landing manifests
before allowing further source mutation.

Queued inputs from a review interrupted by restart are not reordered automatically: use
`/review-now` to finish the review and release them, or `/review-clear` to cancel them
(see [Review workflow](review-workflow.md#commands)).

Manifests outside that exact restored association remain explicit recovery operations
through `recoverLandingManifest()`. A different conversation, session file, or cwd never
silently adopts them.

## Crash recovery for landing manifests

When a wave landing is in progress, a recovery manifest is written atomically under
`<waveRoot>/landing/manifest-<txId>.json` before any filesystem mutations. If the
process dies mid-landing, the manifest remains in `in_progress` or `recovery_required`
state with backup artifacts preserved.

### Manifest location

Recovery manifests live in the wave root directory:

```text
<waveRoot>/landing/manifest-<uuid>.json
```

The wave root is the parent of the private bare Git repository created during capture.
Each manifest is scoped to a single transaction via a unique UUID.

### Recovery API

The `recoverLandingManifest(manifestPath)` function in `src/execution/wave-landing.ts`
recovers a crashed landing transaction:

```typescript
import { recoverLandingManifest } from "../src/execution/wave-landing";

const result = await recoverLandingManifest("/path/to/manifest.json");

// result.status is one of:
//   "recovered"       — all paths restored, manifest marked rolled_back
//   "manual_required" — concurrent modifications detected, artifacts preserved
//   "rejected"        — manifest invalid (wrong version, path escape, identity mismatch)
//   "terminal"        — manifest already completed or rolled_back; stale artifacts cleaned
```

### Recovery behavior

- **Source root identity**: Recovery verifies the source root's dev+ino matches the
  manifest. If the directory was replaced or moved, recovery is rejected.
- **Path confinement**: All destination, temp, and backup paths must reside within the
  source root. Path-escaping manifests are rejected.
- **Concurrent modifications**: If a destination was modified after the transaction
  installed it, recovery preserves both the newer destination and the original backup,
  marking the manifest `recovery_required`.
- **Idempotency**: Running recovery twice on the same manifest is safe. The first call
  restores paths and marks the manifest `rolled_back`; the second call cleans stale
  temps.
- **No Git mutation**: Recovery never invokes Git staging, reset, or apply commands. It
  only manipulates filesystem artifacts.
- **Artifact preservation on manual_required**: When recovery detects a concurrent
  modification and returns `manual_required`, ALL artifacts (temps, backups,
  destinations, directories) are preserved for diagnosis. No cleanup occurs until the
  user resolves the conflict.
- **Created directories caveat**: Post-crash recovery never removes
  `manifest.createdDirs` entries because the manifest is untrusted and there is no
  durable proof an empty directory was transaction-created. Harmless empty directories
  may remain after recovery. Live in-process rollback (during `executeWaveLanding`)
  continues removing its trusted in-memory `createdDirs`.

### Manual recovery steps

When recovery returns `manual_required`:

1. Inspect the manifest to identify which paths have conflicts.
2. Compare the current destination with the backup (original content).
3. Decide whether to keep the concurrent modification or restore the original.
4. Remove backup artifacts (`.pi-backup-*` suffix) once resolved.
5. Remove temp artifacts (`.pi-landing-tmp-*` prefix) if any remain.

## Executor retry, failover, and compaction

Executor failures are checkpointed to a protected recovery ref before bounded retry
(configured by the retry policy, see
[Configuration](configuration.md#delegated-execution-fields)). If same-executor recovery
is exhausted, a verified checkpoint may be handed to the next lower-priority pool entry.
That adapter starts a new native session in the same isolated worktree, so different
providers and CLI harnesses can take over without pretending to share conversation
state. Durable diagnostics include the complete executor assignment history.

Compaction is a lifecycle transition: an interrupted Pi session is reopened by exact
UUID, explicitly compacted through Pi RPC, and only then prompted to continue.

Non-landed results include the worktree, session, attempts, incidents, changed paths,
verified checkpoint, hashed artifact inventory, current bundle, and safe next actions
(see [Delegated execution](delegated-execution.md#steering-continuation-and-failure-handling)).
A restarted task warns when its prior runtime configuration differs.

## What shutdown preserves and removes

The page cache is force-removed on session/application shutdown. Shutdown also removes
settled subtask wave roots, completed execution manifests, and review bundles. Only
genuinely unlanded recovery checkpoints are preserved for exact-session restart. Clean
worktrees are removed after completion; dirty or conflicted worktrees are preserved for
diagnosis ([Delegated execution](delegated-execution.md#landing-and-source-preservation)).