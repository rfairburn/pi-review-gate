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
# by these cache entries.
NODE_LOCK="$NODE_CACHE_ROOT/.admission.lock"
NODE_OWNERSHIP_RECORD="${AGENT_DIR:-}/session-host/host-ownership.json"
NODE_LOCK_ID=''
NODE_LIMIT=5
NODE_LOCK_ATTEMPTS=40
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
  [[ "$size" =~ ^[0-9]+$ ]] && (( size <= 64 ))
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
# occupies the path, and any record that names a live owner, is left in place and
# acquisition restarts; only a real filesystem failure returns 1.
node_lock_reclaim() {
  local expected="$1" current='' text=''
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
  if node_lock_shape_is_record "$NODE_LOCK"; then
    { IFS= read -r -n 32 text < "$NODE_LOCK"; } 2>/dev/null || true
    if [[ "$text" =~ ^([0-9]{1,10})$ ]] && kill -0 "${BASH_REMATCH[1]}" 2>/dev/null; then return 0; fi
  fi
  "$NODE_UNLINK_BIN" "$NODE_LOCK" 2>/dev/null
}
node_lock() {
  local attempt=0 malformed=0 owner='' pid='' id='' observed='' record=1
  node_check_fence || return 1
  while (( attempt < NODE_LOCK_ATTEMPTS )); do
    attempt=$((attempt + 1))
    # noclobber alone can open an existing non-regular target, including through
    # a symlink (/dev/null would accept the write, a FIFO target would block).
    # Every existing entry, including a dangling link, goes through no-follow
    # inspection and guarded reclamation instead of being opened for writing.
    if [[ ! -e "$NODE_LOCK" && ! -L "$NODE_LOCK" ]] &&
      (set -o noclobber; printf '%s\n' "$$" > "$NODE_LOCK") 2>/dev/null; then
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
    record=0
    if [[ ! -L "$NODE_LOCK" ]] && node_lock_shape_is_record "$NODE_LOCK"; then record=1; fi
    owner=''
    if (( record == 1 )); then
      { IFS= read -r -n 32 owner < "$NODE_LOCK"; } 2>/dev/null || true
    fi
    if (( record == 1 )) && [[ "$owner" =~ ^([0-9]{1,10})$ ]]; then
      # A valid record is never a malformed observation.
      malformed=0
      observed=''
      pid="${BASH_REMATCH[1]}"
      if kill -0 "$pid" 2>/dev/null; then
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
  if [[ -n "$NODE_LOCK_ID" ]] && node_check_fence && assert_path_identity "$NODE_LOCK" "$NODE_LOCK_ID"; then
    "$NODE_UNLINK_BIN" "$NODE_LOCK" || return 1
    NODE_LOCK_ID=''
  fi
}

# True (0) while a live producer owns this generation's owner marker. A marker
# whose pid is gone, or that stays empty/malformed, is reclaimed.
node_generation_active() {
  local marker="$1/.producer-active" owner='' attempt
  # Fence the generation root: a direct-child link is not a generation and its
  # outside target must never be inspected or modified.
  [[ -d "$1" && ! -L "$1" ]] || return 1
  [[ -e "$marker" || -L "$marker" ]] || return 1
  # A directory/linked/oversized marker is not liveness evidence; confined
  # no-follow removal handles it.
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  for attempt in 1 2 3; do
    owner=''
    { IFS= read -r -n 32 owner < "$marker"; } 2>/dev/null || true
    if [[ "$owner" =~ ^([0-9]{1,10})$ ]]; then
      kill -0 "${BASH_REMATCH[1]}" 2>/dev/null && return 0
      "$NODE_UNLINK_BIN" "$marker" 2>/dev/null || true
      return 1
    fi
    sleep 0.05 2>/dev/null || sleep 1
  done
  "$NODE_UNLINK_BIN" "$marker" 2>/dev/null || true
  return 1
}

# List recursive cleanup children with the caller's glob options preserved.
# Cleanup-specific: hidden legacy records and initialized .terraform subtrees
# inside a selected disposable generation are ordinary removable content.
node_list_children() {
  local file="$1" restore_nullglob restore_dotglob
  shopt -q nullglob; restore_nullglob=$?
  shopt -q dotglob; restore_dotglob=$?
  shopt -s nullglob dotglob
  NODE_CHILDREN=("$file"/*)
  (( restore_nullglob == 0 )) || shopt -u nullglob
  (( restore_dotglob == 0 )) || shopt -u dotglob
}

# Bounded preflight then no-follow postorder. No recursive rm or find, and no
# deletion of an ancestor of the selected generation. Arbitrary creators'
# ordinary descendants — including hardlinked names and initialized .terraform
# subtrees inside the selected disposable generation — are disposable BY PATH,
# not by file creation receipts or link counts.
node_visit() {
  local file="$1" depth="$2" parentIndex="${3:--1}" child id index="${#NODE_REMOVE_PATHS[@]}"
  node_check_fence && assert_path_identity "$NODE_REMOVE_ROOT" "$NODE_REMOVE_ID" || return 1
  (( depth <= 64 && ${#NODE_REMOVE_PATHS[@]} < 100000 && SECONDS - NODE_REMOVE_STARTED <= 120 )) || return 1
  NODE_REMOVE_PATHS+=("$file")
  NODE_REMOVE_PARENTS+=("$parentIndex")
  if [[ -L "$file" ]]; then
    # Links themselves may be unlinked; their target is never read or visited.
    NODE_REMOVE_DIR_IDS+=('')
  elif [[ -d "$file" ]]; then
    id="$(path_identity "$file")" || return 1
    NODE_REMOVE_DIR_IDS+=("$id")
    local NODE_CHILDREN=()
    node_list_children "$file"
    if (( ${#NODE_CHILDREN[@]} > 0 )); then
      for child in "${NODE_CHILDREN[@]}"; do
        node_visit "$child" "$((depth+1))" "$index" || return 1
      done
    fi
  elif [[ -f "$file" && ! -L "$file" ]]; then
    NODE_REMOVE_DIR_IDS+=('')
  else return 1
  fi
}
node_remove() {
  local NODE_REMOVE_ROOT="$1" NODE_REMOVE_ID="$2" NODE_REMOVE_STARTED=$SECONDS i j
  local NODE_REMOVE_PATHS=() NODE_REMOVE_DIR_IDS=() NODE_REMOVE_PARENTS=()
  assert_path_identity "$1" "$2" || return 1
  node_visit "$1" 0 || return 1
  for ((i=${#NODE_REMOVE_PATHS[@]}-1; i>0; i--)); do
    node_check_fence && assert_path_identity "$1" "$2" || return 1
    (( SECONDS - NODE_REMOVE_STARTED <= 120 )) || return 1
    j="${NODE_REMOVE_PARENTS[i]}"
    while (( j >= 0 )); do
      [[ -z "${NODE_REMOVE_DIR_IDS[j]}" ]] || assert_path_identity "${NODE_REMOVE_PATHS[j]}" "${NODE_REMOVE_DIR_IDS[j]}" || return 1
      j="${NODE_REMOVE_PARENTS[j]}"
    done
    if [[ -n "${NODE_REMOVE_DIR_IDS[i]}" ]]; then
      assert_path_identity "${NODE_REMOVE_PATHS[i]}" "${NODE_REMOVE_DIR_IDS[i]}" || return 1
      "$NODE_RMDIR_BIN" "${NODE_REMOVE_PATHS[i]}" || return 1
    elif [[ -L "${NODE_REMOVE_PATHS[i]}" ]]; then
      # Unlink the link itself; its target is never visited.
      "$NODE_UNLINK_BIN" "${NODE_REMOVE_PATHS[i]}" || return 1
    else
      # An ordinary leaf name is unlinked without following anything. A
      # hardlink only loses this cache name; outside bytes and links stay.
      [[ -f "${NODE_REMOVE_PATHS[i]}" && ! -L "${NODE_REMOVE_PATHS[i]}" ]] || return 1
      "$NODE_UNLINK_BIN" "${NODE_REMOVE_PATHS[i]}" || return 1
    fi
  done
  node_check_fence && assert_path_identity "$1" "$2" || return 1
  "$NODE_RMDIR_BIN" "$1"
}

# Reclaim excess generations down to the per-type target, then create this
# launch's fresh generation. Capacity never refuses creation: cleanup problems
# are reported as bounded warnings and the launch continues.
node_admit() {
  local entries=() candidates=() entry id count=0
  if [[ -n "${AGENT_DIR:-}" && -e "$NODE_OWNERSHIP_RECORD" ]]; then
    # An existing session host owns this agent directory; its cache generations
    # are left alone. Startup still proceeds and cleanup never refuses it.
    echo 'pi-review-sessions: a session host currently owns the agent directory; leaving Node cache generations untouched.' >&2
  elif node_lock; then
    shopt -s nullglob dotglob
    entries=("$NODE_CACHE_ROOT"/*)
    shopt -u nullglob dotglob
    # Bash 3.2 treats an empty array expansion as unbound under set -u.
    if (( ${#entries[@]} > 0 )); then
      for entry in "${entries[@]}"; do
        [[ "$entry" != "$NODE_LOCK" ]] || continue
        [[ -L "$entry" || -d "$entry" ]] || continue
        candidates+=("$entry")
      done
    fi
    count=${#candidates[@]}
    if (( count > 100000 )); then
      echo 'pi-review-sessions: Node cache inventory exceeded its bound; continuing without reclamation.' >&2
    else
      if (( ${#candidates[@]} > 0 )); then
        for entry in "${candidates[@]}"; do
          (( count >= NODE_LIMIT )) || break
          [[ "${entry##*/}" != .terraform ]] || continue
          node_generation_active "$entry" && continue
          if [[ -L "$entry" ]]; then
            if "$NODE_UNLINK_BIN" "$entry" 2>/dev/null; then count=$((count - 1)); fi
            continue
          fi
          id="$(path_identity "$entry" 2>/dev/null)" || continue
          if node_remove "$entry" "$id"; then count=$((count - 1)); fi
        done
      fi
      if (( count >= NODE_LIMIT )); then
        echo "pi-review-sessions: Node cache still holds ${count} generations (target ${NODE_LIMIT}); continuing startup." >&2
      fi
    fi
    # Keep the admission lock until this producer exits (released by the
    # caller's EXIT trap). Another concurrent producer then skips cleanup
    # instead of deleting a generation that is still being extracted.
  else
    if [[ "${NODE_LOCK_REPORT:-}" == lock-artifact ]]; then
      echo 'pi-review-sessions: Node cache cleanup lock artifact could not be removed; continuing without reclaiming older generations.' >&2
    else
      echo 'pi-review-sessions: Node cache cleanup lock was busy or unreadable; continuing without reclaiming older generations.' >&2
    fi
  fi
  node_check_fence || return 1
  WORK_ROOT="$(mktemp -d "$NODE_CACHE_ROOT/bootstrap.XXXXXXXX" 2>/dev/null)" || return 1
  [[ "${WORK_ROOT%/*}" == "$NODE_CACHE_ROOT" && "${WORK_ROOT##*/}" == bootstrap.* ]] || return 1
  # Consumed by the sourcing wrapper's workspace/archive ownership checks.
  # shellcheck disable=SC2034
  WORK_ROOT_ID="$(path_identity "$WORK_ROOT")" || return 1
  local created=()
  # mktemp must be exclusive and empty (nullglob avoids literal patterns).
  shopt -s nullglob dotglob
  created=("$WORK_ROOT"/*)
  shopt -u nullglob dotglob
  (( ${#created[@]} == 0 )) || return 1
  # A live owner marker keeps concurrent producers from pruning this generation
  # while its Node archive is still downloading/extracting. The EXIT trap clears
  # it when this producer settles.
  (set -o noclobber; printf '%s\n' "$$" > "$WORK_ROOT/.producer-active") 2>/dev/null || return 1
}
