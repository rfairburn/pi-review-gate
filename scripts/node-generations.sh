#!/usr/bin/env bash
# Sourced only by the fallback producer, after native stat selection. No Node,
# reusable runtime, census, or second inventory is needed for admission.
# The cache's direct child entries ARE the inventory. These trees exist only
# under the designated `.pi-review-gate/node` cache, so their contents are
# disposable by location: there are no lifetime receipts, no mount census, and
# no capacity refusal. Cleanup is best effort — a busy live lock, an
# unremovable malformed lock artifact, an unsafe entry, or a real filesystem
# failure is reported and the fresh generation is still created, because cache
# capacity must never stop an application start. A stale or malformed NON-LIVE
# lock artifact (directory, link, oversized or unreadable) is reclaimed first,
# confined to that exact cache metadata entry, so it never becomes a permanent
# cleanup skip.
# Active sessions are guarded by the session host's own ownership record, not
# by these cache entries. Because a starting host creates that record while a
# producer may already be authorized to reclaim, ownership acquisition and this
# script's destructive reclamation both take ONE canonical per-agent
# coordination entry (session-host/host-coordination.lock). Reclamation releases
# it as soon as the fresh generation exists, rechecks the ownership record after
# any wait/stale recovery and at every destructive boundary, and skips
# reclamation entirely when that boundary is unavailable. The entry is a lock,
# not a registry: a stale or malformed one is reclaimed like a stale admission
# lock and can never become a startup gate.
NODE_LOCK="$NODE_CACHE_ROOT/.admission.lock"
NODE_OWNERSHIP_RECORD="${AGENT_DIR:-}/session-host/host-ownership.json"
NODE_COORDINATION_DIR="${AGENT_DIR:-}/session-host"
NODE_COORDINATION_LOCK="$NODE_COORDINATION_DIR/host-coordination.lock"
NODE_LOCK_ID=''
NODE_COORDINATION_ID=''
NODE_LIMIT=5
NODE_LOCK_ATTEMPTS=40
# One cleanup pass (inventory plus every removal it attempts) shares this elapsed
# budget, so a deep or large generation cannot reset the clock per generation.
NODE_CLEANUP_BUDGET=120
NODE_CLEANUP_STARTED=$SECONDS
NODE_CLEANUP_STOPPED=0
# Bounded owner record: `<pid>` plus an optional targeted birth identity.
NODE_OWNER_BYTES=192
# A reused pid's birth is only "after" a record when clearly later than it.
NODE_OWNER_BIRTH_MARGIN=2
# Leaves per native bulk-unlink call, and how often the ancestor fence is
# rechecked while walking directories of one disposable generation.
NODE_CLEANUP_BATCH=256
NODE_CLEANUP_FENCE_EVERY=32
NODE_CLEANUP_DIRS=0
# The generation this launch selected/created, preserved by the settlement pass.
NODE_KEEP_ROOT=''
# Deletions performed by the current pass (pass-scope progress allowance).
NODE_CLEANUP_PROGRESS=0
# Empty sibling directories awaiting one batched identity-checked removal.
NODE_PENDING_DIRS=()
NODE_PENDING_IDS=()
NODE_IDENTITIES=()
NODE_OWNER_PID=''
NODE_OWNER_IDENTITY=''
NODE_FENCE_PATHS=()
NODE_FENCE_IDS=()

node_single_file() {
  local links
  [[ -f "$1" && ! -L "$1" ]] || return 1
  if [[ "$HOST_OS" == Darwin ]]; then links="$("$STAT_BIN" -f '%l' "$1")"; else links="$("$STAT_BIN" -c '%h' "$1")"; fi
  [[ "$links" == 1 ]]
}
node_capture_fence() {
  local rest="${NODE_CACHE_ROOT#/}" current='' part id
  NODE_FENCE_PATHS=(/)
  NODE_FENCE_IDS=("$(path_identity /)")
  while [[ -n "$rest" ]]; do
    part="${rest%%/*}"
    if [[ "$rest" == */* ]]; then rest="${rest#*/}"; else rest=''; fi
    current="$current/$part"
    id="$(path_identity "$current")" || return 1
    NODE_FENCE_PATHS+=("$current")
    NODE_FENCE_IDS+=("$id")
  done
}
node_check_fence() {
  local file output
  for file in "${NODE_FENCE_PATHS[@]}"; do [[ -d "$file" && ! -L "$file" ]] || return 1; done
  # One native stat call for the chain, rather than one process per ancestor
  # per archive entry. Both BSD and GNU stat emit exactly one identity per path.
  if [[ "$HOST_OS" == Darwin ]]; then
    output="$("$STAT_BIN" -f '%d:%i' "${NODE_FENCE_PATHS[@]}" 2>/dev/null)" || return 1
  else
    output="$("$STAT_BIN" -c '%d:%i' "${NODE_FENCE_PATHS[@]}" 2>/dev/null)" || return 1
  fi
  [[ "$output" == "$(printf '%s\n' "${NODE_FENCE_IDS[@]}")" ]]
}

# One short exclusive admission lock coordinates cleanup and generation
# creation. A lock whose recorded owner is gone (or whose record is empty or
# malformed) is reclaimed instead of becoming a permanent stop condition; a
# live owner is left alone, and this producer then skips cleanup and continues.
# A stale/malformed NON-LIVE metadata shape (directory, link, oversized or
# unreadable) is likewise removed confined to this exact lock path: this
# producer only ever creates a fresh single-linked regular lock file, so such a
# shape is never a live producer's evidence. Reclamation is conditional on the
# exact entry that was observed still being present, so another producer's
# replacement live lock is never deleted. A real removal failure warns and
# startup still continues.
node_lock_shape_is_record() {
  node_single_file "$1" || return 1
  local size
  if [[ "$HOST_OS" == Darwin ]]; then size="$("$STAT_BIN" -f '%z' "$1" 2>/dev/null)"; else size="$("$STAT_BIN" -c '%s' "$1" 2>/dev/null)"; fi
  [[ "$size" =~ ^[0-9]+$ ]] && (( size <= NODE_OWNER_BYTES ))
}
# One per-cache owner record: `<pid>` plus, for current producers, the owner's
# targeted birth identity. A record written by an older producer is pid-only and
# stays readable. Sets NODE_OWNER_PID / NODE_OWNER_IDENTITY.
node_owner_read() {
  local file="$1" size='' pid='' identity=''
  node_single_file "$file" || return 1
  if [[ "$HOST_OS" == Darwin ]]; then size="$("$STAT_BIN" -f '%z' "$file" 2>/dev/null)"; else size="$("$STAT_BIN" -c '%s' "$file" 2>/dev/null)"; fi
  [[ "$size" =~ ^[0-9]+$ ]] && (( size > 0 && size <= NODE_OWNER_BYTES )) || return 1
  { IFS= read -r pid; IFS= read -r identity; } 2>/dev/null < "$file" || true
  [[ "$pid" =~ ^[1-9][0-9]{0,9}$ ]] || return 1
  NODE_OWNER_PID="$pid"
  NODE_OWNER_IDENTITY="${identity:-}"
}
# Targeted single-pid OS owner birth time in whole epoch seconds. It exists only
# to tell a legacy pid-only record written by its actual owner from one left
# behind by a pid an unrelated process has since reused (exactly one pid, never a
# census). An empty result simply means the record is honored conservatively.
node_owner_birth_epoch() {
  local pid="$1" line='' rest='' boot='' etime='' now='' days=0 a='' b='' c='' part='' fields=()
  [[ "$pid" =~ ^[1-9][0-9]{0,9}$ ]] || return 1
  if [[ -r "/proc/$pid/stat" && -r /proc/stat ]]; then
    IFS= read -r line < "/proc/$pid/stat" 2>/dev/null || return 1
    rest="${line##*\)}"
    # /proc/<pid>/stat is whitespace-separated after `comm`; starttime is the
    # 20th token there, so ordinary word splitting is intended.
    # shellcheck disable=SC2206
    fields=($rest)
    [[ ${#fields[@]} -ge 20 && "${fields[19]}" =~ ^[0-9]{1,20}$ ]] || return 1
    while IFS= read -r line; do
      case "$line" in
        btime\ *) boot="${line#btime }"; break;;
      esac
    done < /proc/stat
    [[ "$boot" =~ ^[0-9]{1,12}$ ]] || return 1
    # USER_HZ is 100 on Linux by ABI definition, so ticks convert exactly.
    printf '%s' "$(( boot + fields[19] / 100 ))"
    return 0
  fi
  [[ -n "${NODE_PS_BIN:-}" && -n "${NODE_DATE_BIN:-}" ]] || return 1
  etime="$("$NODE_PS_BIN" -p "$pid" -o etime= 2>/dev/null)" || return 1
  etime="${etime//[[:space:]]/}"
  [[ -n "$etime" ]] || return 1
  case "$etime" in
    *-*)
      days="${etime%%-*}"
      etime="${etime#*-}"
      [[ "$days" =~ ^[0-9]{1,6}$ ]] || return 1
      ;;
  esac
  IFS=: read -r a b c <<< "$etime"
  if [[ -z "$c" ]]; then
    if [[ -n "$b" ]]; then c="$b"; b="$a"; a=0
    else return 1
    fi
  fi
  for part in "$a" "$b" "$c"; do [[ "$part" =~ ^[0-9]{1,6}$ ]] || return 1; done
  now="$(TZ=UTC0 "$NODE_DATE_BIN" +%s 2>/dev/null)" || return 1
  [[ "$now" =~ ^[0-9]{1,12}$ ]] || return 1
  printf '%s' "$(( now - days * 86400 - 10#$a * 3600 - 10#$b * 60 - 10#$c ))"
}
# True only while a record's owner is genuinely current: a record carrying its
# owner's birth identity is honored only while that exact identity still holds,
# and a legacy pid-only record is honored while the live pid's OS birth is not
# clearly AFTER the record's own mtime (a later birth means the number was
# reused, while an earlier birth is legitimate in-flight work).
node_owner_current() {
  local file="$1" pid="$NODE_OWNER_PID" identity="$NODE_OWNER_IDENTITY" observed='' birth='' mtime=''
  kill -0 "$pid" 2>/dev/null || return 1
  if [[ -n "$identity" ]]; then
    observed="$(node_owner_identity "$pid")"
    # A temporarily unavailable birth query is not a proven mismatch: the pid is
    # alive, so this may still be an in-flight producer and is honored.
    [[ -n "$observed" ]] || return 0
    [[ "$observed" == "$identity" ]]
    return
  fi
  birth="$(node_owner_birth_epoch "$pid")" || return 0
  [[ "$birth" =~ ^[0-9]{1,14}$ ]] || return 0
  if [[ "$HOST_OS" == Darwin ]]; then mtime="$("$STAT_BIN" -f '%m' "$file" 2>/dev/null)"; else mtime="$("$STAT_BIN" -c '%Y' "$file" 2>/dev/null)"; fi
  [[ "$mtime" =~ ^[0-9]{1,14}$ ]] || return 0
  (( birth <= mtime + NODE_OWNER_BIRTH_MARGIN ))
}
# No-follow identity of the exact lock entry (links included by design: GNU and
# BSD stat default to lstat semantics without -L). Used only to confirm that the
# artifact being reclaimed is the one that was observed.
node_lock_entry_identity() {
  local path="$NODE_LOCK" output
  [[ -e "$path" || -L "$path" ]] || return 1
  if [[ "$HOST_OS" == Darwin ]]; then
    output="$("$STAT_BIN" -f '%d:%i' "$path" 2>/dev/null)" || return 1
  else
    output="$("$STAT_BIN" -c '%d:%i' "$path" 2>/dev/null)" || return 1
  fi
  [[ "$output" =~ ^[0-9]+:[1-9][0-9]*$ ]] || return 1
  printf '%s' "$output"
}
# Reclaim only the lock artifact identified by the caller. Anything else that now
# occupies the path, and any record whose owner is genuinely current, is left in
# place and acquisition restarts; only a real filesystem failure returns 1.
node_lock_reclaim() {
  local expected="$1" current=''
  [[ -n "$expected" ]] || return 1
  node_check_fence || return 1
  current="$(node_lock_entry_identity)" || return 1
  [[ "$current" == "$expected" ]] || return 0
  if [[ -L "$NODE_LOCK" ]]; then
    # Unlink the malformed link itself; its target is never read or modified.
    "$NODE_UNLINK_BIN" "$NODE_LOCK" 2>/dev/null
    return
  fi
  if [[ -d "$NODE_LOCK" ]]; then
    node_remove "$NODE_LOCK" "$current"
    return
  fi
  if node_owner_read "$NODE_LOCK" && node_owner_current "$NODE_LOCK"; then return 0; fi
  "$NODE_UNLINK_BIN" "$NODE_LOCK" 2>/dev/null
}
node_lock() {
  local attempt=0 malformed=0 owner='' id='' observed=''
  node_check_fence || return 1
  owner="$(node_owner_identity "$$")"
  while (( attempt < NODE_LOCK_ATTEMPTS )); do
    attempt=$((attempt + 1))
    # noclobber alone can open an existing non-regular target, including through
    # a symlink (/dev/null would accept the write, a FIFO target would block).
    # Every existing entry, including a dangling link, goes through no-follow
    # inspection and guarded reclamation instead of being opened for writing.
    # The record is written already complete: this producer's pid plus its
    # targeted birth identity, so liveness never depends on a pid number alone.
    if [[ ! -e "$NODE_LOCK" && ! -L "$NODE_LOCK" ]] &&
      (set -o noclobber; printf '%s\n%s\n' "$$" "$owner" > "$NODE_LOCK") 2>/dev/null; then
      NODE_LOCK_ID="$(path_identity "$NODE_LOCK")" || return 1
      node_check_fence && assert_path_identity "$NODE_LOCK" "$NODE_LOCK_ID"
      return
    fi
    if [[ ! -e "$NODE_LOCK" && ! -L "$NODE_LOCK" ]]; then
      # Another producer settled between attempts; retry creating the lock.
      malformed=0
      observed=''
      continue
    fi
    if node_owner_read "$NODE_LOCK"; then
      # A valid record is never a malformed observation.
      malformed=0
      observed=''
      if node_owner_current "$NODE_LOCK"; then
        # A live owner is waited for; if it never settles this launch skips
        # cleanup and continues. A pid-reused record is never a live owner.
        sleep 0.05 2>/dev/null || sleep 1
        continue
      fi
      id="$(node_lock_entry_identity)" || id=''
      if [[ -n "$id" ]]; then
        node_lock_reclaim "$id" || { NODE_LOCK_REPORT=lock-artifact; return 1; }
      fi
      continue
    fi
    # Empty/invalid record or a non-live metadata shape (directory, link,
    # oversized, unreadable): either a mid-publication lock or a dead owner's
    # residue. Re-observe the SAME entry identity, then reclaim it confined to
    # this lock path so it never becomes a permanent skip.
    id="$(node_lock_entry_identity)" || id=''
    if [[ -z "$id" ]]; then
      # An entry that cannot be identified is never reclaimed blind.
      sleep 0.05 2>/dev/null || sleep 1
      continue
    fi
    if [[ "$id" != "$observed" ]]; then
      malformed=0
      observed="$id"
    fi
    malformed=$((malformed + 1))
    if (( malformed < 3 )); then
      sleep 0.05 2>/dev/null || sleep 1
      continue
    fi
    malformed=0
    node_lock_reclaim "$observed" || { NODE_LOCK_REPORT=lock-artifact; return 1; }
    observed=''
  done
  return 1
}
node_unlock() {
  # A generation is only "in progress" while this producer lives: clearing the
  # owner marker here is what lets a later cleanup reclaim it.
  if [[ -n "${WORK_ROOT:-}" ]]; then
    "$NODE_UNLINK_BIN" "$WORK_ROOT/.producer-active" 2>/dev/null || true
  fi
  node_coordination_release || true
  node_release_admission_lock || true
  # Settlement retry: reclamation that contention deferred while this producer
  # was preparing is retried once here, joined, instead of being abandoned until
  # another fresh generation happens to run. This launch's own generation is
  # preserved, and cleanup still runs under the canonical entry and admission lock.
  NODE_KEEP_ROOT="${WORK_ROOT:-}"
  node_cleanup_only || true
}

# ---------------------------------------------------------------------------
# Per-agent host-ownership coordination
# ---------------------------------------------------------------------------
# The session host creates its exclusive ownership record while a producer may
# already be authorized to reclaim. Both take this one canonical per-agent
# coordination entry, so destructive reclamation and ownership acquisition are
# mutually exclusive in both directions. It is a mutex, not a registry, and it
# uses the same protocol as the CJS, TypeScript, and PowerShell paths: the record
# (`<pid>` plus a targeted single-pid start identity) is written COMPLETE to a
# private candidate and then published with an atomic no-overwrite hard link, so a
# reader never sees a half-written entry and a paused publisher only loses the
# link race. Stale, dead, or reused-pid metadata is reclaimed; a current holder
# is honored.
node_host_owns_agent_directory() {
  [[ -n "${AGENT_DIR:-}" ]] || return 1
  [[ -e "$NODE_OWNERSHIP_RECORD" || -L "$NODE_OWNERSHIP_RECORD" ]]
}
node_check_coordination_dir() {
  [[ -n "${AGENT_DIR:-}" && -d "$NODE_COORDINATION_DIR" && ! -L "$NODE_COORDINATION_DIR" ]]
}
# The private host state directory may be created empty for the coordination
# entry; a linked or non-directory state path is never written through, and
# cleanup is then simply skipped.
node_coordination_ready() {
  [[ -n "${AGENT_DIR:-}" && -d "$AGENT_DIR" ]] || return 1
  if [[ -e "$NODE_COORDINATION_DIR" || -L "$NODE_COORDINATION_DIR" ]]; then
    node_check_coordination_dir
    return
  fi
  mkdir -m 700 "$NODE_COORDINATION_DIR" 2>/dev/null || true
  node_check_coordination_dir
}
# Targeted single-pid process-start token (never a census). Empty when ps is
# unavailable, in which case the pid rule alone applies.
# One exact per-platform token, matching the CJS, TypeScript host, and PowerShell
# writers byte for byte: `linux:<boot identity>:<starttime ticks>` from this single
# pid's /proc/<pid>/stat (no procps needed), or `darwin:<ps lstart token>` from one
# targeted ps query. `ps lstart` renders in the caller's timezone and locale and
# carries no zone of its own, so that one query is pinned to UTC and the C locale:
# otherwise the same live process would look like a different owner after a
# timezone/DST change, and its birth would be misparsed on non-UTC hosts. Exactly
# one pid, never a census. An empty result means the identity genuinely cannot be
# established: no record is published, and a record without a birth identity is
# never honored.
node_owner_identity() {
  local pid="$1" boot='' output='' line='' rest='' fields=() words=()
  [[ "$pid" =~ ^[1-9][0-9]{0,9}$ ]] || return 0
  if [[ -r "/proc/$pid/stat" ]]; then
    IFS= read -r line < "/proc/$pid/stat" 2>/dev/null || true
    rest="${line##*\)}"
    # /proc/<pid>/stat is whitespace-separated after `comm`; starttime is the 20th
    # token there (field 22 overall), so ordinary word splitting is intended.
    # shellcheck disable=SC2206
    fields=($rest)
    if [[ ${#fields[@]} -ge 20 ]] && [[ "${fields[19]}" =~ ^[0-9]{1,20}$ ]]; then
      if [[ -r /proc/sys/kernel/random/boot_id ]]; then
        IFS= read -r boot < /proc/sys/kernel/random/boot_id 2>/dev/null || boot=''
        [[ "$boot" =~ ^[0-9a-f-]{8,64}$ ]] || boot=''
      fi
      if [[ -z "$boot" && -r /proc/stat ]]; then
        while IFS= read -r line; do
          case "$line" in
            btime\ *) boot="btime-${line#btime }"; break;;
          esac
        done < /proc/stat
        [[ "$boot" =~ ^btime-[0-9]{1,12}$ ]] || boot=''
      fi
      if [[ -n "$boot" ]]; then
        printf '%s' "linux:$boot:${fields[19]}"
        return 0
      fi
    fi
  fi
  [[ -n "${NODE_PS_BIN:-}" ]] || return 0
  output="$(TZ=UTC0 LC_ALL=C LANG=C "$NODE_PS_BIN" -p "$pid" -o lstart= 2>/dev/null)" || return 0
  read -r -a words <<< "$output" 2>/dev/null || true
  [[ ${#words[@]} -gt 0 ]] || return 0
  printf '%s' "darwin:${words[*]}"
}
node_coordination_entry_identity() {
  local output
  [[ -e "$NODE_COORDINATION_LOCK" || -L "$NODE_COORDINATION_LOCK" ]] || return 1
  if [[ "$HOST_OS" == Darwin ]]; then
    output="$("$STAT_BIN" -f '%d:%i' "$NODE_COORDINATION_LOCK" 2>/dev/null)" || return 1
  else
    output="$("$STAT_BIN" -c '%d:%i' "$NODE_COORDINATION_LOCK" 2>/dev/null)" || return 1
  fi
  [[ "$output" =~ ^[0-9]+:[1-9][0-9]*$ ]] || return 1
  printf '%s' "$output"
}
# Read the record: pid on the first line, owner identity on the rest. Returns 1
# for a missing/non-record shape (the caller then observes and reclaims).
node_coordination_read() {
  local size pid='' identity=''
  [[ -f "$NODE_COORDINATION_LOCK" && ! -L "$NODE_COORDINATION_LOCK" ]] || return 1
  if [[ "$HOST_OS" == Darwin ]]; then
    size="$("$STAT_BIN" -f '%z' "$NODE_COORDINATION_LOCK" 2>/dev/null)" || return 1
  else
    size="$("$STAT_BIN" -c '%s' "$NODE_COORDINATION_LOCK" 2>/dev/null)" || return 1
  fi
  [[ "$size" =~ ^[0-9]+$ ]] && (( size > 0 && size <= 192 )) || return 1
  # A published record is transiently nlink 2 while its candidate name exists.
  local links
  if [[ "$HOST_OS" == Darwin ]]; then links="$("$STAT_BIN" -f '%l' "$NODE_COORDINATION_LOCK" 2>/dev/null)"; else links="$("$STAT_BIN" -c '%h' "$NODE_COORDINATION_LOCK" 2>/dev/null)"; fi
  [[ "$links" == 1 || "$links" == 2 ]] || return 1
  # Two bounded builtin reads (no external helper): the published record is
  # exactly `<pid>` then `<owner identity>`, both newline-terminated.
  { IFS= read -r pid; IFS= read -r identity; } 2>/dev/null < "$NODE_COORDINATION_LOCK" || true
  [[ "$pid" =~ ^[1-9][0-9]{0,9}$ ]] || return 1
  NODE_COORDINATION_RECORD_PID="$pid"
  NODE_COORDINATION_RECORD_IDENTITY="$identity"
  return 0
}
# True only while the record's pid is alive AND still reports its start identity.
node_coordination_owner_current() {
  local pid="$NODE_COORDINATION_RECORD_PID" identity="$NODE_COORDINATION_RECORD_IDENTITY" observed
  kill -0 "$pid" 2>/dev/null || return 1
  # A record without a birth identity is never honored on any platform: pid-only
  # metadata could otherwise be pinned forever behind an unrelated live process.
  [[ -n "$identity" ]] || return 1
  observed="$(node_owner_identity "$pid")"
  # A temporarily unavailable birth query is not a proven mismatch: the pid is
  # alive, so this may still be a live destructive holder and is honored (the
  # wait stays bounded for a producer, and the ownership claim waits for the
  # holder rather than stealing its mutex mid-deletion).
  [[ -n "$observed" ]] || return 0
  [[ "$observed" == "$identity" ]]
}
node_coordination_reclaim() {
  local expected="$1" current=''
  [[ -n "$expected" ]] || return 1
  node_check_coordination_dir || return 1
  current="$(node_coordination_entry_identity)" || return 1
  [[ "$current" == "$expected" ]] || return 0
  if [[ -L "$NODE_COORDINATION_LOCK" ]]; then
    "$NODE_UNLINK_BIN" "$NODE_COORDINATION_LOCK" 2>/dev/null
    return
  fi
  if [[ -d "$NODE_COORDINATION_LOCK" ]]; then
    node_remove "$NODE_COORDINATION_LOCK" "$current"
    return
  fi
  "$NODE_UNLINK_BIN" "$NODE_COORDINATION_LOCK" 2>/dev/null
}
# Publish this producer's already-complete record. `ln` is atomic and fails when
# the entry exists, so an existing holder's record is never overwritten.
node_coordination_publish() {
  local owner=''
  owner="$(node_owner_identity "$$")"
  # No weak pid-only record is ever published: without a birth identity, or
  # without the atomic link tool, coordination is reported unavailable instead.
  [[ -n "$owner" && -n "${NODE_HARDLINK_BIN:-}" ]] || return 1
  local candidate="$NODE_COORDINATION_DIR/host-coordination.lock.$$.$RANDOM$RANDOM"
  (set -o noclobber; printf '%s\n%s\n' "$$" "$owner" > "$candidate") 2>/dev/null || return 1
  if "$NODE_HARDLINK_BIN" "$candidate" "$NODE_COORDINATION_LOCK" 2>/dev/null; then
    "$NODE_UNLINK_BIN" "$candidate" 2>/dev/null || true
    return 0
  fi
  "$NODE_UNLINK_BIN" "$candidate" 2>/dev/null || true
  return 1
}
node_coordination() {
  local attempt=0 malformed=0 id='' observed='' unremovable_attempts=0
  node_check_coordination_dir || return 1
  while (( attempt < NODE_LOCK_ATTEMPTS )); do
    attempt=$((attempt + 1))
    if [[ ! -e "$NODE_COORDINATION_LOCK" && ! -L "$NODE_COORDINATION_LOCK" ]] && node_coordination_publish; then
      NODE_COORDINATION_ID="$(node_coordination_entry_identity)" || return 1
      node_check_coordination_dir || return 1
      assert_path_identity "$NODE_COORDINATION_LOCK" "$NODE_COORDINATION_ID"
      return
    fi
    if [[ ! -e "$NODE_COORDINATION_LOCK" && ! -L "$NODE_COORDINATION_LOCK" ]]; then
      malformed=0
      observed=''
      continue
    fi
    # Capture the exact entry identity BEFORE reading/checking its owner: another
    # contender may replace stale metadata with its own live record in between, and
    # reclamation must stay bound to the entry that was actually judged stale.
    id="$(node_coordination_entry_identity)" || id=''
    if [[ -z "$id" ]]; then
      sleep 0.05 2>/dev/null || sleep 1
      continue
    fi
    if node_coordination_read && node_coordination_owner_current; then
      # A current holder: wait, and skip reclamation for this launch.
      malformed=0
      observed=''
      sleep 0.05 2>/dev/null || sleep 1
      continue
    fi
    if node_coordination_read; then
      malformed=0
      observed=''
    else
      if [[ "$id" != "$observed" ]]; then
        malformed=0
        observed="$id"
      fi
      malformed=$((malformed + 1))
      if (( malformed < 3 )); then
        sleep 0.05 2>/dev/null || sleep 1
        continue
      fi
      malformed=0
      observed=''
    fi
    if ! node_coordination_reclaim "$id"; then
      unremovable_attempts=$((unremovable_attempts + 1))
      (( unremovable_attempts < NODE_LOCK_ATTEMPTS )) || return 1
    fi
    observed=''
  done
  return 1
}
node_coordination_release() {
  local held="$NODE_COORDINATION_ID"
  NODE_COORDINATION_ID=''
  [[ -n "$held" ]] || return 0
  node_check_coordination_dir || return 0
  assert_path_identity "$NODE_COORDINATION_LOCK" "$held" || return 0
  node_coordination_read || return 0
  [[ "$NODE_COORDINATION_RECORD_PID" == "$$" ]] || return 0
  [[ "$NODE_COORDINATION_RECORD_IDENTITY" == "$(node_owner_identity "$$")" ]] || return 0
  "$NODE_UNLINK_BIN" "$NODE_COORDINATION_LOCK" 2>/dev/null || return 0
  return 0
}

# True (0) while a live producer owns this generation's owner marker. A marker
# whose owner is gone, reused, or that stays empty/malformed is reclaimed.
node_generation_active() {
  local marker="$1/.producer-active" attempt
  # Fence the generation root: a direct-child link is not a generation and its
  # outside target must never be inspected or modified.
  [[ -d "$1" && ! -L "$1" ]] || return 1
  [[ -e "$marker" || -L "$marker" ]] || return 1
  # A directory/linked/oversized marker is not liveness evidence; confined
  # no-follow removal handles it.
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  for attempt in 1 2 3; do
    if node_owner_read "$marker"; then
      node_owner_current "$marker" && return 0
      "$NODE_UNLINK_BIN" "$marker" 2>/dev/null || true
      return 1
    fi
    sleep 0.05 2>/dev/null || sleep 1
  done
  "$NODE_UNLINK_BIN" "$marker" 2>/dev/null || true
  return 1
}

# Append the direct children of one directory to NODE_CHILDREN with the caller's
# glob options preserved. Cleanup-specific: hidden legacy records and initialized
# .terraform subtrees inside a selected disposable generation are ordinary
# removable content.
node_list_children() {
  local file="$1" restore_nullglob restore_dotglob
  shopt -q nullglob; restore_nullglob=$?
  shopt -q dotglob; restore_dotglob=$?
  shopt -s nullglob dotglob
  NODE_CHILDREN=("$file"/*)
  (( restore_nullglob == 0 )) || shopt -u nullglob
  (( restore_dotglob == 0 )) || shopt -u dotglob
}

# True while this cleanup pass may still delete something. The pass-level budget
# grants exactly one initial allowance: until the pass has deleted real content it
# may run its next bounded unit, and after that every unit is deadline checked. A
# pass can therefore never end as a zero-progress no-op, and it cannot keep
# deleting past its budget once it has started.
node_cleanup_running() {
  (( NODE_CLEANUP_BUDGET > 0 )) || return 0
  (( SECONDS - NODE_CLEANUP_STARTED < NODE_CLEANUP_BUDGET ))
}

node_cleanup_allows_work() {
  (( NODE_CLEANUP_PROGRESS > 0 )) || return 0
  node_cleanup_running
}

# Unlink a batch of ordinary or special leaf names with one native call when the
# platform's remove tool is available, and fall back to one no-follow `unlink` per
# name otherwise. Batching is what keeps a file-heavy generation ahead of the
# runtime budget; a hardlinked name only loses this cache-name link.
node_unlink_batch() {
  local count=$# start=0 name
  local -a names=("$@") chunk=()
  (( count > 0 )) || return 0
  if [[ -n "${NODE_RM_BIN:-}" ]]; then
    while (( start < count )); do
      if ! node_cleanup_allows_work; then NODE_CLEANUP_STOPPED=1; return 1; fi
      chunk=("${names[@]:start:NODE_CLEANUP_BATCH}")
      (( ${#chunk[@]} > 0 )) || break
      "$NODE_RM_BIN" -f -- "${chunk[@]}" || return 1
      NODE_CLEANUP_PROGRESS=$((NODE_CLEANUP_PROGRESS + ${#chunk[@]}))
      start=$((start + ${#chunk[@]}))
    done
    return 0
  fi
  for name in "${names[@]}"; do
    if ! node_cleanup_allows_work; then NODE_CLEANUP_STOPPED=1; return 1; fi
    "$NODE_UNLINK_BIN" "$name" || return 1
    NODE_CLEANUP_PROGRESS=$((NODE_CLEANUP_PROGRESS + 1))
  done
}

# Bounded incremental deletion of one designated generation's content, in
# immediate postorder: leaf names are unlinked as they are visited and every
# directory is removed as soon as its own subtree is empty. Sibling directories are
# processed in bounded batches whose identities are captured for that batch only,
# so no pass can spend its whole budget classifying or identifying directories
# before deleting anything. There is no whole-tree preflight, no entry-count or
# depth quota, and never a deletion of an ancestor of the selected generation.
# Arbitrary creators' ordinary descendants — including hardlinked names and
# initialized .terraform subtrees inside the selected disposable generation — are
# disposable BY PATH, not by file creation receipts or link counts. Links are
# unlinked themselves and never entered, and ordinary or special leaves (FIFO,
# socket, device) are unlinked without being opened.
#
# Batching keeps a directory-heavy generation ahead of the budget: completed
# sibling directories accumulate into one native `rmdir` call whose identities are
# verified first with one native `stat` call, and leaf names accumulate into one
# native remove call.
node_flush_dirs() {
  local force="${1:-}" count=${#NODE_PENDING_DIRS[@]} output='' line='' i=0
  local -a observed=() keep=()
  (( count > 0 )) || return 0
  if [[ "$force" != force ]] && ! node_cleanup_running; then
    # The budget expired with completed empty directories still pending: remove
    # them best-effort so this pass cannot end with zero deletion progress.
    NODE_CLEANUP_STOPPED=1
    node_flush_dirs force || true
    return 1
  fi
  # One native stat call for the whole batch; nothing is removed unless its exact
  # directory identity is unchanged.
  if [[ "$HOST_OS" == Darwin ]]; then
    output="$("$STAT_BIN" -f '%d:%i' "${NODE_PENDING_DIRS[@]}" 2>/dev/null)" || output=''
  else
    output="$("$STAT_BIN" -c '%d:%i' "${NODE_PENDING_DIRS[@]}" 2>/dev/null)" || output=''
  fi
  while IFS= read -r line; do observed+=("$line"); done <<< "$output"
  if (( ${#observed[@]} == count )); then
    for (( i=0; i<count; i++ )); do
      [[ "${observed[i]}" == "${NODE_PENDING_IDS[i]}" ]] && keep+=("${NODE_PENDING_DIRS[i]}")
    done
  fi
  NODE_PENDING_DIRS=()
  NODE_PENDING_IDS=()
  (( ${#keep[@]} > 0 )) || return 1
  "$NODE_RMDIR_BIN" "${keep[@]}" || return 1
  NODE_CLEANUP_PROGRESS=$((NODE_CLEANUP_PROGRESS + ${#keep[@]}))
}

node_queue_dir() {
  local dir="$1" id="$2"
  NODE_PENDING_DIRS+=("$dir")
  NODE_PENDING_IDS+=("$id")
  # Flush when the batch is full, and as soon as the raw budget has expired: the
  # already-empty directories must be removed before this pass stops, so a
  # directory-only generation always makes real progress.
  if (( ${#NODE_PENDING_DIRS[@]} >= NODE_CLEANUP_BATCH )) || ! node_cleanup_running; then
    node_flush_dirs
  fi
}

# Capture the identities of a batch of directories with native stat calls, at
# most NODE_CLEANUP_BATCH paths per call so a high-fanout directory with long
# path prefixes can never exceed the platform argv limit. Sets the NODE_IDENTITIES
# global (one identity per input path, same order) and returns nonzero on any real
# query failure, so the caller must abort the pass instead of walking an empty or
# short identity list.
node_batch_identities() {
  local count=$# start=0 chunk=() output='' line
  local -a paths=("$@") lines=()
  # Never leave a previous directory's identities behind for a caller that might
  # ignore the failure: an empty list is the only safe state on error.
  NODE_IDENTITIES=()
  (( count > 0 )) || return 1
  while (( start < count )); do
    if ! node_cleanup_allows_work; then NODE_CLEANUP_STOPPED=1; return 1; fi
    chunk=("${paths[@]:start:NODE_CLEANUP_BATCH}")
    (( ${#chunk[@]} > 0 )) || break
    if [[ "$HOST_OS" == Darwin ]]; then
      output="$("$STAT_BIN" -f '%d:%i' "${chunk[@]}" 2>/dev/null)" || return 1
    else
      output="$("$STAT_BIN" -c '%d:%i' "${chunk[@]}" 2>/dev/null)" || return 1
    fi
    local -a chunkLines=()
    while IFS= read -r line; do chunkLines+=("$line"); done <<< "$output"
    (( ${#chunkLines[@]} == ${#chunk[@]} )) || return 1
    lines+=("${chunkLines[@]}")
    start=$((start + ${#chunk[@]}))
  done
  (( ${#lines[@]} == count )) || return 1
  NODE_IDENTITIES=("${lines[@]}")
}

# Stop this pass truthfully after making whatever removal progress is already
# available: pending empty directories are removed best-effort, then failure is
# reported so the caller does not count the generation as reclaimed.
node_remove_abort() {
  node_flush_dirs force || true
  return 1
}

node_remove_dir() {
  local dir="$1" child='' id='' index=0 start=0
  local -a NODE_CHILDREN=() leaves=() subdirs=() ids=() chunk=()
  NODE_CLEANUP_DIRS=$((NODE_CLEANUP_DIRS + 1))
  if (( NODE_CLEANUP_DIRS % NODE_CLEANUP_FENCE_EVERY == 1 )); then
    # The cache ancestor fence is rechecked periodically rather than once per
    # descendant, and every directory removal below is identity-checked.
    node_check_fence || return 1
  fi
  if ! node_cleanup_allows_work; then
    node_flush_dirs force || true
    NODE_CLEANUP_STOPPED=1
    return 1
  fi
  node_list_children "$dir"
  if (( ${#NODE_CHILDREN[@]} > 0 )); then
    for child in "${NODE_CHILDREN[@]}"; do
      if [[ -L "$child" ]]; then
        leaves+=("$child")
      elif [[ -d "$child" ]]; then
        subdirs+=("$child")
      else
        leaves+=("$child")
      fi
    done
  fi
  if (( ${#leaves[@]} > 0 )); then
    node_unlink_batch "${leaves[@]}" || { node_remove_abort; return 1; }
  fi
  if (( ${#subdirs[@]} > 0 )); then
    # Bounded sibling batches: identify one batch, delete through its subtrees, then
    # move to the next. The budget can therefore never be consumed by identifying
    # every sibling before the first one is removed.
    while (( start < ${#subdirs[@]} )); do
      if ! node_cleanup_allows_work; then
        node_flush_dirs force || true
        NODE_CLEANUP_STOPPED=1
        return 1
      fi
      chunk=("${subdirs[@]:start:NODE_CLEANUP_BATCH}")
      (( ${#chunk[@]} > 0 )) || break
      node_batch_identities "${chunk[@]}" || { node_remove_abort; return 1; }
      ids=("${NODE_IDENTITIES[@]}")
      index=0
      for child in "${chunk[@]}"; do
        if ! node_cleanup_allows_work; then
          node_flush_dirs force || true
          NODE_CLEANUP_STOPPED=1
          return 1
        fi
        id="${ids[index]}"
        index=$((index + 1))
        node_remove_dir "$child" || { node_remove_abort; return 1; }
        # The child's own content is gone; its empty directory is removed with the
        # next batch (or immediately when the batch is full or the budget is spent).
        node_queue_dir "$child" "$id" || { node_remove_abort; return 1; }
      done
      start=$((start + ${#chunk[@]}))
    done
  fi
}

node_remove() {
  local root="$1" expected="$2"
  assert_path_identity "$root" "$expected" || return 1
  if [[ -L "$root" ]]; then
    # Unlink the link itself; its target is never visited.
    "$NODE_UNLINK_BIN" "$root" || return 1
    NODE_CLEANUP_PROGRESS=$((NODE_CLEANUP_PROGRESS + 1))
    return 0
  fi
  NODE_PENDING_DIRS=()
  NODE_PENDING_IDS=()
  node_remove_dir "$root" || return 1
  # The root's directory is only removed once its whole subtree is gone. This is
  # also a progress boundary: an empty generation deletes nothing inside
  # node_remove_dir, so it uses the same pass-scope allowance instead of the raw
  # deadline. Otherwise a pass whose budget expired during inventory or identity
  # checks would refuse the root removal forever with zero physical progress;
  # once anything has been deleted the deadline applies again.
  if ! node_cleanup_allows_work; then
    node_flush_dirs force || true
    NODE_CLEANUP_STOPPED=1
    return 1
  fi
  node_flush_dirs force || return 1
  assert_path_identity "$root" "$expected" || return 1
  "$NODE_RMDIR_BIN" "$root" || return 1
  NODE_CLEANUP_PROGRESS=$((NODE_CLEANUP_PROGRESS + 1))
}

# Reclaim excess generations until at most <leave> remain, never touching
# <keep_path>, and report the product target <report_target>. One elapsed budget
# bounds the whole pass, progress is tracked at pass scope (so the initial
# allowance is granted once, not per generation), and capacity never refuses
# anything: every failure warns and the caller continues.
node_reclaim_excess() {
  local leave="$1" keep_path="${2:-}" report_target="${3:-$1}" entries=() candidates=() entry id count=0 reclaimed=0
  # ONE elapsed budget for the whole pass (inventory plus every removal it
  # attempts), not a fresh deadline per generation.
  NODE_CLEANUP_STARTED=$SECONDS
  NODE_CLEANUP_STOPPED=0
  NODE_CLEANUP_PROGRESS=0
  NODE_CLEANUP_DIRS=0
  NODE_PENDING_DIRS=()
  NODE_PENDING_IDS=()
  shopt -s nullglob dotglob
  entries=("$NODE_CACHE_ROOT"/*)
  shopt -u nullglob dotglob
  # Bash 3.2 treats an empty array expansion as unbound under set -u.
  if (( ${#entries[@]} > 0 )); then
    for entry in "${entries[@]}"; do
      [[ "$entry" != "$NODE_LOCK" ]] || continue
      [[ -z "$keep_path" || "$entry" != "$keep_path" ]] || continue
      [[ -L "$entry" || -d "$entry" ]] || continue
      candidates+=("$entry")
    done
  fi
  count=${#candidates[@]}
  if (( count > leave )); then
    for entry in "${candidates[@]}"; do
      (( count > leave )) || break
      # Stop before starting another candidate once this pass has deleted
      # something and reached its budget: each empty directory or link would
      # otherwise be processed past the budget while the mutex is held.
      if (( NODE_CLEANUP_PROGRESS > 0 )) && ! node_cleanup_running; then
        NODE_CLEANUP_STOPPED=1
        break
      fi
      # Rechecked at every destructive boundary: even when the per-agent
      # boundary could not be taken, a host's ownership record stops further
      # removal instead of being raced by cleanup.
      if node_host_owns_agent_directory; then
        echo 'pi-review-sessions: a session host acquired the agent directory during cleanup; leaving the remaining Node cache generations untouched.' >&2
        break
      fi
      node_generation_active "$entry" && continue
      if [[ -L "$entry" ]]; then
        if "$NODE_UNLINK_BIN" "$entry" 2>/dev/null; then
          count=$((count - 1))
          reclaimed=$((reclaimed + 1))
          NODE_CLEANUP_PROGRESS=$((NODE_CLEANUP_PROGRESS + 1))
        else
          echo "pi-review-sessions: could not remove Node cache entry ${entry##*/}; it remains and startup continues." >&2
        fi
        continue
      fi
      id="$(path_identity "$entry" 2>/dev/null)" || continue
      if node_remove "$entry" "$id"; then
        count=$((count - 1))
        reclaimed=$((reclaimed + 1))
      elif (( NODE_CLEANUP_STOPPED == 1 )); then
        # Real content was already removed; the next launch continues from
        # what remains instead of starting a no-op preflight again.
        NODE_CLEANUP_STOPPED=0
        echo "pi-review-sessions: Node cache cleanup stopped at its runtime budget after reclaiming ${reclaimed} generations; ${count} remain and the next launch reclaims more. Continuing startup." >&2
        break
      else
        # A real filesystem/identity-query failure is reported honestly; the
        # generation stays counted and startup continues.
        echo "pi-review-sessions: could not reclaim cache generation ${entry##*/}; it remains and startup continues." >&2
      fi
    done
  fi
  local held=$count
  if [[ -n "$keep_path" ]]; then held=$((count + 1)); fi
  if (( held > report_target )); then
    echo "pi-review-sessions: Node cache still holds ${held} generations (target ${report_target}); continuing startup." >&2
  fi
  return 0
}

# Release this producer's admission lock entry, and only while that exact entry
# is still the one it published.
node_release_admission_lock() {
  if [[ -n "$NODE_LOCK_ID" ]] && node_check_fence && assert_path_identity "$NODE_LOCK" "$NODE_LOCK_ID"; then
    "$NODE_UNLINK_BIN" "$NODE_LOCK" || return 1
    NODE_LOCK_ID=''
  fi
  return 0
}

# Producer-owned cleanup-only pass: reclaim excess generations toward the per-type
# target without creating anything, under the same canonical per-agent
# coordination entry and the same admission lock, preserving the generation this
# launch selected or just created. Used at preparation settlement so reclamation
# that contention deferred while this producer was preparing is retried once
# (joined, never backgrounded) instead of waiting for another fresh generation.
node_cleanup_only() {
  if ! node_check_fence; then
    return 1
  fi
  if ! node_coordination_ready || ! node_coordination; then
    echo 'pi-review-sessions: host ownership coordination was unavailable; leaving Node cache generations untouched.' >&2
    return 0
  fi
  if node_host_owns_agent_directory; then
    echo 'pi-review-sessions: a session host currently owns the agent directory; leaving Node cache generations untouched.' >&2
    node_coordination_release
    return 0
  fi
  if ! node_lock; then
    if [[ "${NODE_LOCK_REPORT:-}" == lock-artifact ]]; then
      echo 'pi-review-sessions: Node cache cleanup lock artifact could not be removed; continuing without reclaiming older generations.' >&2
    else
      echo 'pi-review-sessions: Node cache cleanup lock was busy or unreadable; continuing without reclaiming older generations.' >&2
    fi
    node_coordination_release
    return 0
  fi
  if node_host_owns_agent_directory; then
    echo 'pi-review-sessions: a session host currently owns the agent directory; leaving Node cache generations untouched.' >&2
  else
    node_reclaim_excess $((NODE_LIMIT - 1)) "${NODE_KEEP_ROOT:-}" "$NODE_LIMIT"
  fi
  node_coordination_release
  node_release_admission_lock || true
  return 0
}

# Reclaim excess generations down to the per-type target, then create this
# launch's fresh generation. Capacity never refuses creation: cleanup problems
# are reported as bounded warnings and the launch continues.
node_admit() {
  # The canonical per-agent coordination entry is taken FIRST and released once
  # this producer's fresh generation exists. Host ownership acquisition takes the
  # same entry, so cleanup and acquiring ownership cannot interleave.
  if ! node_coordination_ready || ! node_coordination; then
    # No per-agent boundary: destructive reclamation is skipped rather than
    # racing an ownership acquisition it cannot exclude. Startup continues.
    echo 'pi-review-sessions: host ownership coordination was unavailable; leaving Node cache generations untouched.' >&2
  elif node_host_owns_agent_directory; then
    # An existing session host owns this agent directory; its cache generations
    # are left alone. Startup still proceeds and cleanup never refuses it.
    echo 'pi-review-sessions: a session host currently owns the agent directory; leaving Node cache generations untouched.' >&2
  elif node_lock; then
    if node_host_owns_agent_directory; then
      # Rechecked after the admission wait/stale-lock recovery: a host may have
      # acquired ownership while this producer waited.
      echo 'pi-review-sessions: a session host currently owns the agent directory; leaving Node cache generations untouched.' >&2
    else
      # Trim to four so creating this launch's ONE new generation lands at or
      # below the per-type target of five whenever that is possible.
      node_reclaim_excess $((NODE_LIMIT - 1)) '' "$NODE_LIMIT"
    fi
    # Keep the admission lock until this producer exits (released by the
    # caller's EXIT trap). Another concurrent producer then skips cleanup
    # instead of deleting a generation that is still being extracted.
  elif node_host_owns_agent_directory; then
    # Rechecked whichever way the admission attempt ended: a host that became the
    # owner while this producer waited is the reason cleanup stays away.
    echo 'pi-review-sessions: a session host currently owns the agent directory; leaving Node cache generations untouched.' >&2
  else
    if [[ "${NODE_LOCK_REPORT:-}" == lock-artifact ]]; then
      echo 'pi-review-sessions: Node cache cleanup lock artifact could not be removed; continuing without reclaiming older generations.' >&2
    else
      echo 'pi-review-sessions: Node cache cleanup lock was busy or unreadable; continuing without reclaiming older generations.' >&2
    fi
  fi
  if ! node_check_fence; then
    node_coordination_release
    return 1
  fi
  WORK_ROOT="$(mktemp -d "$NODE_CACHE_ROOT/bootstrap.XXXXXXXX" 2>/dev/null)" || { node_coordination_release; return 1; }
  [[ "${WORK_ROOT%/*}" == "$NODE_CACHE_ROOT" && "${WORK_ROOT##*/}" == bootstrap.* ]] || { node_coordination_release; return 1; }
  # Consumed by the sourcing wrapper's workspace/archive ownership checks.
  # shellcheck disable=SC2034
  WORK_ROOT_ID="$(path_identity "$WORK_ROOT")" || { node_coordination_release; return 1; }
  local created=()
  # mktemp must be exclusive and empty (nullglob avoids literal patterns).
  shopt -s nullglob dotglob
  created=("$WORK_ROOT"/*)
  shopt -u nullglob dotglob
  (( ${#created[@]} == 0 )) || { node_coordination_release; return 1; }
  # A live owner marker keeps concurrent producers from pruning this generation
  # while its Node archive is still downloading/extracting. The record carries
  # this producer's pid and targeted birth identity so a reused pid can never
  # pin the generation. The EXIT trap clears it when this producer settles.
  (set -o noclobber; printf '%s\n%s\n' "$$" "$(node_owner_identity "$$")" > "$WORK_ROOT/.producer-active") 2>/dev/null || { node_coordination_release; return 1; }
  node_coordination_release
}
