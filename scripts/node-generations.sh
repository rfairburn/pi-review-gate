#!/usr/bin/env bash
# Sourced only by the fallback producer, after native stat selection. No Node,
# reusable runtime, census, or second inventory is needed for admission.
# The cache's direct child entries ARE the inventory. These trees exist only
# under the designated `.pi-review-gate/node` cache, so their contents are
# disposable by location: there are no lifetime receipts, no mount census, and
# no capacity refusal. Cleanup is best effort — a busy/stale lock, an unsafe
# entry, or a real filesystem failure is reported and the fresh generation is
# still created, because cache capacity must never stop an application start.
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
node_lock() {
  local attempt=0 malformed=0 owner='' pid=''
  node_check_fence || return 1
  while (( attempt < NODE_LOCK_ATTEMPTS )); do
    if (set -o noclobber; printf '%s\n' "$$" > "$NODE_LOCK") 2>/dev/null; then
      NODE_LOCK_ID="$(path_identity "$NODE_LOCK")" || return 1
      node_check_fence && assert_path_identity "$NODE_LOCK" "$NODE_LOCK_ID"
      return
    fi
    if [[ -L "$NODE_LOCK" || ! -e "$NODE_LOCK" ]] || ! node_single_file "$NODE_LOCK"; then
      # A replaced, linked, or unreadable lock is not ours to remove.
      return 1
    fi
    owner=''
    { IFS= read -r -n 32 owner < "$NODE_LOCK"; } 2>/dev/null || true
    if [[ "$owner" =~ ^([0-9]{1,10})$ ]]; then
      malformed=0
      pid="${BASH_REMATCH[1]}"
      if kill -0 "$pid" 2>/dev/null; then
        attempt=$((attempt + 1))
        sleep 0.05 2>/dev/null || sleep 1
        continue
      fi
    else
      # A just-created lock can be observed before its pid is written. Only a
      # record that stays empty/malformed across several observations is a dead
      # owner's residue, never a permanent stop condition either way.
      malformed=$((malformed + 1))
      if (( malformed < 3 )); then
        attempt=$((attempt + 1))
        sleep 0.05 2>/dev/null || sleep 1
        continue
      fi
      malformed=0
    fi
    "$NODE_UNLINK_BIN" "$NODE_LOCK" 2>/dev/null || return 1
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

# Bounded preflight then no-follow postorder. No recursive rm, find, or deletion
# of an ancestor containing an excluded .terraform directory. Arbitrary creators'
# ordinary descendants are disposable BY PATH, not by file creation receipts.
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
  elif node_single_file "$file"; then
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
      node_single_file "${NODE_REMOVE_PATHS[i]}" || return 1
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
    echo 'pi-review-sessions: Node cache cleanup lock was busy or unreadable; continuing without reclaiming older generations.' >&2
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
