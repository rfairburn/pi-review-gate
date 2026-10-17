#!/usr/bin/env bash
# Sourced only by the fallback producer, after native stat selection. No Node,
# reusable runtime, census, or second inventory is needed for admission.
# The directory entries are the inventory; .node-lifetime is the sole lifetime.
NODE_RECORD='.node-lifetime'
NODE_LOCK="$NODE_CACHE_ROOT/.admission.lock"
NODE_LOCK_ID=''
NODE_FENCE_PATHS=()
NODE_FENCE_IDS=()

node_snapshot() {
  local output
  if [[ "$HOST_OS" == Darwin ]]; then
    output="$("$STAT_BIN" -f '%d:%i:%p:%l:%z:%m:%c' "$1" 2>/dev/null)" || return 1
  else
    output="$("$STAT_BIN" -c '%d:%i:%f:%h:%s:%Y:%Z' "$1" 2>/dev/null)" || return 1
  fi
  [[ "$output" =~ ^[0-9]+:[1-9][0-9]*:[0-9a-fA-F]+:[0-9]+:[0-9]+:-?[0-9]+:-?[0-9]+$ ]] || return 1
  printf '%s' "$output"
}
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
node_lock() {
  node_check_fence || return 1
  (set -o noclobber; : > "$NODE_LOCK") 2>/dev/null || return 1
  NODE_LOCK_ID="$(path_identity "$NODE_LOCK")" || return 1
  node_check_fence && assert_path_identity "$NODE_LOCK" "$NODE_LOCK_ID"
}
node_unlock() {
  if [[ -n "$NODE_LOCK_ID" ]] && node_check_fence && assert_path_identity "$NODE_LOCK" "$NODE_LOCK_ID"; then
    "$NODE_UNLINK_BIN" "$NODE_LOCK" || return 1
    NODE_LOCK_ID=''
  fi
}
node_read_lifetime() {
  local root="$1" expected="$2" file="$1/$NODE_RECORD" before line
  local lines=()
  node_check_fence && assert_path_identity "$root" "$expected" && node_single_file "$file" || return 1
  before="$(node_snapshot "$file")" || return 1
  # read has a fixed per-line bound; no FIFO/device/link is ever opened.
  local permissions
  if [[ "$HOST_OS" == Darwin ]]; then permissions="$("$STAT_BIN" -f '%Lp' "$file")"; else permissions="$("$STAT_BIN" -c '%a' "$file")"; fi
  [[ "$permissions" == 600 ]] || return 1
  while IFS= read -r -n 1025 line || [[ -n "$line" ]]; do
    (( ${#line} <= 1024 && ${#lines[@]} < 4 )) || return 1
    lines+=("$line")
  done < "$file"
  [[ ${#lines[@]} == 4 && "${lines[0]}" == pi-review-gate-node-v1 && "${lines[1]}" == "$expected" && "${lines[2]}" =~ ^bootstrap[.-][a-zA-Z0-9.-]+$ && "${lines[3]}" =~ ^(protected|quiescent|inactive)$ ]] || return 1
  [[ "${lines[2]}" == "${root##*/}" ]] || return 1
  local tail="${before#*:*:*:*:}" canonical
  printf -v canonical 'pi-review-gate-node-v1\n%s\n%s\n%s\n' "$expected" "${lines[2]}" "${lines[3]}"
  [[ "${tail%%:*}" == "${#canonical}" && "$(node_snapshot "$file")" == "$before" ]] || return 1
  NODE_LIFETIME_TOKEN="${lines[2]}"
  NODE_LIFETIME_STATE="${lines[3]}"
  NODE_LIFETIME_SNAPSHOT="$before"
}
node_write_lifetime() {
  local root="$1" expected="$2" token="$3" state="$4" previous="${5:-}" temporary="$1/.node-lifetime-next"
  node_check_fence && assert_path_identity "$root" "$expected" || return 1
  (set -o noclobber; printf 'pi-review-gate-node-v1\n%s\n%s\n%s\n' "$expected" "$token" "$state" > "$temporary") || return 1
  node_check_fence && assert_path_identity "$root" "$expected" || return 1
  if [[ -n "$previous" ]]; then
    [[ "$(node_snapshot "$root/$NODE_RECORD")" == "$previous" ]] || return 1
  else
    [[ ! -e "$root/$NODE_RECORD" && ! -L "$root/$NODE_RECORD" ]] || return 1
  fi
  "$NODE_MOVE_BIN" -f "$temporary" "$root/$NODE_RECORD"
}
node_set_state() {
  local from="$1" to="$2"
  node_lock || return 1
  if node_read_lifetime "$WORK_ROOT" "$WORK_ROOT_ID" && [[ "$NODE_LIFETIME_TOKEN" == "${WORK_ROOT##*/}" && "$NODE_LIFETIME_STATE" == "$from" ]]; then
    node_write_lifetime "$WORK_ROOT" "$WORK_ROOT_ID" "${WORK_ROOT##*/}" "$to" "$NODE_LIFETIME_SNAPSHOT"
  else
    node_unlock
    return 1
  fi
  node_unlock
}

# Native mount tables are metadata, not filesystem traversal. Same-device bind
# mounts cannot be recognized from st_dev alone. Unsupported/ambiguous listings
# or any mount-table change during cleanup refuse rather than cross a mount.
node_mount_inventory() {
  local line rest mounted
  [[ -n "$NODE_MOUNT_BIN" ]] || return 1
  NODE_NATIVE_MOUNTS="$(LC_ALL=C "$NODE_MOUNT_BIN" 2>/dev/null)" || return 1
  (( ${#NODE_NATIVE_MOUNTS} > 0 && ${#NODE_NATIVE_MOUNTS} <= 4194304 )) || return 1
  while IFS= read -r line; do
    [[ "$line" == *' on '* ]] || return 1
    rest="${line#* on }"
    [[ "$rest" != *' on '* ]] || return 1
    if [[ "$HOST_OS" == Darwin ]]; then
      [[ "$rest" == *' ('*')' ]] || return 1
      mounted="${rest% \(*}"
      [[ "$mounted" != *' ('* ]] || return 1
    else
      [[ "$rest" == *' type '* ]] || return 1
      mounted="${rest%% type *}"
      [[ "${rest#* type }" != *' type '* ]] || return 1
    fi
    mounted="${mounted//\\040/ }"
    mounted="${mounted//\\011/$'\t'}"
    mounted="${mounted//\\012/$'\n'}"
    mounted="${mounted//\\134/\\}"
    [[ "$mounted" == /* ]] || return 1
    [[ "$mounted" != "$NODE_REMOVE_ROOT" && "$mounted" != "$NODE_REMOVE_ROOT/"* ]] || return 1
  done <<< "$NODE_NATIVE_MOUNTS"
}
node_check_mounts() {
  [[ "$(LC_ALL=C "$NODE_MOUNT_BIN" 2>/dev/null)" == "$NODE_NATIVE_MOUNTS" ]]
}

# Bounded preflight then no-follow postorder. No recursive rm, find, or deletion
# of an ancestor containing an excluded .terraform directory. Arbitrary creators'
# ordinary descendants are disposable BY PATH, not by file creation receipts.
node_visit() {
  local file="$1" depth="$2" parentIndex="${3:--1}" child id snapshot index="${#NODE_REMOVE_PATHS[@]}"
  node_check_fence && assert_path_identity "$NODE_REMOVE_ROOT" "$NODE_REMOVE_ID" || return 1
  (( depth <= 64 && ${#NODE_REMOVE_PATHS[@]} < 100000 && SECONDS - NODE_REMOVE_STARTED <= 180 )) || return 1
  snapshot="$(node_snapshot "$file")" || return 1
  [[ "${snapshot%%:*}" == "${NODE_REMOVE_ID%%:*}" ]] || return 1
  NODE_REMOVE_PATHS+=("$file")
  NODE_REMOVE_SNAPSHOTS+=("$snapshot")
  NODE_REMOVE_PARENTS+=("$parentIndex")
  if [[ -L "$file" ]]; then
    # Links themselves may be unlinked; their target is never read or visited.
    local tail="${snapshot#*:*:*:}"
    [[ "${tail%%:*}" == 1 ]] || return 1
    NODE_REMOVE_DIR_IDS+=('')
  elif [[ -d "$file" ]]; then
    id="$(path_identity "$file")" || return 1
    NODE_REMOVE_DIR_IDS+=("$id")
    local children=("$file"/*)
    for child in "${children[@]}"; do
      [[ "${child##*/}" != .terraform ]] || return 1
      node_visit "$child" "$((depth+1))" "$index" || return 1
    done
  elif node_single_file "$file"; then
    NODE_REMOVE_DIR_IDS+=('')
  else return 1
  fi
}
node_remove() {
  local NODE_REMOVE_ROOT="$1" NODE_REMOVE_ID="$2" NODE_REMOVE_STARTED=$SECONDS NODE_NATIVE_MOUNTS='' i j
  local NODE_REMOVE_PATHS=() NODE_REMOVE_SNAPSHOTS=() NODE_REMOVE_DIR_IDS=() NODE_REMOVE_PARENTS=()
  node_read_lifetime "$1" "$2" && [[ "$NODE_LIFETIME_STATE" == inactive ]] || return 1
  node_mount_inventory || return 1
  node_visit "$1" 0 || return 1
  for ((i=0; i<${#NODE_REMOVE_PATHS[@]}; i++)); do
    [[ "$(node_snapshot "${NODE_REMOVE_PATHS[i]}")" == "${NODE_REMOVE_SNAPSHOTS[i]}" ]] || return 1
  done
  # The canonical record is last, so failed partial cleanup remains counted.
  for ((i=${#NODE_REMOVE_PATHS[@]}-1; i>0; i--)); do
    [[ "${NODE_REMOVE_PATHS[i]}" != "$1/$NODE_RECORD" ]] || continue
    node_check_fence && node_check_mounts && assert_path_identity "$1" "$2" || return 1
    (( SECONDS - NODE_REMOVE_STARTED <= 360 )) || return 1
    j="${NODE_REMOVE_PARENTS[i]}"
    while (( j >= 0 )); do
      assert_path_identity "${NODE_REMOVE_PATHS[j]}" "${NODE_REMOVE_DIR_IDS[j]}" || return 1
      j="${NODE_REMOVE_PARENTS[j]}"
    done
    if [[ -n "${NODE_REMOVE_DIR_IDS[i]}" ]]; then
      assert_path_identity "${NODE_REMOVE_PATHS[i]}" "${NODE_REMOVE_DIR_IDS[i]}" || return 1
      "$NODE_RMDIR_BIN" "${NODE_REMOVE_PATHS[i]}" || return 1
    else
      [[ "$(node_snapshot "${NODE_REMOVE_PATHS[i]}")" == "${NODE_REMOVE_SNAPSHOTS[i]}" ]] || return 1
      "$NODE_UNLINK_BIN" "${NODE_REMOVE_PATHS[i]}" || return 1
    fi
  done
  node_check_fence && node_check_mounts && assert_path_identity "$1" "$2" || return 1
  node_read_lifetime "$1" "$2" && [[ "$NODE_LIFETIME_STATE" == inactive ]] || return 1
  "$NODE_UNLINK_BIN" "$1/$NODE_RECORD" && "$NODE_RMDIR_BIN" "$1"
}
node_admit() {
  local entries=() entry id count
  node_lock || { echo 'pi-review-sessions: Node generation admission busy or uncertain.' >&2; return 1; }
  shopt -s nullglob dotglob
  entries=("$NODE_CACHE_ROOT"/*)
  count=0
  for entry in "${entries[@]}"; do [[ "$entry" == "$NODE_LOCK" ]] || ((count+=1)); done
  (( count <= 100000 )) || return 1
  for entry in "${entries[@]}"; do
    (( count >= 5 )) || break
    [[ "$entry" != "$NODE_LOCK" && "${entry##*/}" != .terraform && -d "$entry" && ! -L "$entry" ]] || continue
    id="$(path_identity "$entry")" || continue
    if node_remove "$entry" "$id"; then count=$((count-1)); fi
  done
  shopt -u nullglob dotglob
  if (( count >= 5 )); then
    echo 'pi-review-sessions: Node generation capacity exhausted: maximum 5; active, uncertain or unsafe artifacts retained.' >&2
    node_unlock
    return 1
  fi
  node_check_fence || return 1
  WORK_ROOT="$(mktemp -d "$NODE_CACHE_ROOT/bootstrap.XXXXXXXX" 2>/dev/null)" || return 1
  [[ "${WORK_ROOT%/*}" == "$NODE_CACHE_ROOT" && "${WORK_ROOT##*/}" == bootstrap.* ]] || return 1
  WORK_ROOT_ID="$(path_identity "$WORK_ROOT")" || return 1
  local created=()
  # mktemp must be exclusive and empty (nullglob avoids literal patterns).
  shopt -s nullglob dotglob
  created=("$WORK_ROOT"/*)
  shopt -u nullglob dotglob
  (( ${#created[@]} == 0 )) || return 1
  node_write_lifetime "$WORK_ROOT" "$WORK_ROOT_ID" "${WORK_ROOT##*/}" protected || return 1
  node_unlock
}
