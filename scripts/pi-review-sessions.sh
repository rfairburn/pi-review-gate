#!/usr/bin/env bash
set -euo pipefail

# One-command session host launcher. A supported Node on PATH is preferred;
# otherwise this entry point downloads the fixed official Node 22.19.0 archive
# for the native OS/architecture, verifies its source-pinned SHA-256 before
# listing or extracting it, and launches the shared CJS from a fresh exclusive
# extraction. Existing cache files are never probed, repaired, or executed.
# The Node archive is deliberately re-extracted on every fallback launch: a
# mutable previously extracted binary is never trusted as its own provenance.
#
# Capability isolation (fail closed): executor role contexts are rejected and
# the host bootstrap/restore authorization markers are cleared BEFORE any
# probe, download, or extractor child runs. The selected Node executes the
# shared CJS unchanged, with the original arguments and trusted environment.

# --- Capability isolation before any child process runs ---------------------
if [[ -n "${PI_REVIEW_GATE_RUNTIME_ROLE:-}" ]]; then
  echo "pi-review-sessions: unsupported role context (PI_REVIEW_GATE_RUNTIME_ROLE)." >&2
  exit 1
fi
if [[ -n "${PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG:-}" ]]; then
  echo "pi-review-sessions: unsupported role context (PI_REVIEW_GATE_EXECUTOR_TOOL_CATALOG)." >&2
  exit 1
fi
unset PI_REVIEW_GATE_SESSION_HOST_BOOTSTRAP PI_REVIEW_GATE_SESSION_HOST_NODE_OPTIONS_RESTORE

# Pure-bash script directory resolution: do not depend on an external dirname
# when the caller's PATH is minimal.
script_path="${BASH_SOURCE[0]}"
case "$script_path" in
  */*) SCRIPT_DIR="$(cd -- "${script_path%/*}" && pwd -P)";;
  *) SCRIPT_DIR="$(pwd -P)";;
esac
CJS_ENTRY="$SCRIPT_DIR/pi-review-sessions.cjs"

# Mirrors meetsNodeFloor in scripts/pi-review-sessions.cjs. Node's own
# --version must be one exact stable-format version; at the precise floor a
# prerelease is below the requirement, while newer major/minor releases follow
# the shared CJS floor semantics.
node_version_supported() {
  local version="$1" major minor patch prerelease
  if [[ ! "$version" =~ ^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(-([0-9A-Za-z.-]+))?(\+([0-9A-Za-z.-]+))?$ ]]; then
    return 1
  fi
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"
  prerelease="${BASH_REMATCH[5]:-}"
  if (( 10#$major > 22 )); then return 0; fi
  if (( 10#$major < 22 )); then return 1; fi
  if (( 10#$minor > 19 )); then return 0; fi
  if (( 10#$minor < 19 )); then return 1; fi
  if (( 10#$patch > 0 )); then return 0; fi
  [[ -z "$prerelease" ]]
}

# Capture only one exact stdout version line plus the child's actual exit
# status. Appending a sentinel prevents command substitution from silently
# normalizing extra trailing blank lines into a valid version string.
probe_node_version() {
  local executable="$1" result version suffix
  suffix=$'\n__PI_REVIEW_SESSIONS_NODE_STATUS_0__'
  if ! result="$("$executable" --version 2>/dev/null; probe_status=$?; printf '__PI_REVIEW_SESSIONS_NODE_STATUS_%s__' "$probe_status")"; then
    return 1
  fi
  case "$result" in
    *"$suffix") version="${result%"$suffix"}";;
    *) return 1;;
  esac
  node_version_supported "$version"
}

# Return the first PATH node's exact executable path, if any. A failed,
# malformed, or unsupported version is not executed as the launcher runtime.
NODE_BIN="$(type -P node 2>/dev/null || true)"
if [[ -n "$NODE_BIN" ]] && probe_node_version "$NODE_BIN"; then
  exec "$NODE_BIN" "$CJS_ENTRY" "$@"
fi
NODE_BIN=""

# Fixed source-pinned official Node distribution digests (Node.js v22.19.0,
# nodejs.org/dist/v22.19.0/SHASUMS256.txt). Never read a manifest or digest
# URL from disk, environment, or caller input.
NODE_VERSION_PIN="22.19.0"
HOST_OS="$(uname -s 2>/dev/null || true)"
HOST_ARCH="$(uname -m 2>/dev/null || true)"
case "$HOST_OS:$HOST_ARCH" in
  Darwin:x86_64|Darwin:amd64)
    NODE_PLATFORM="darwin-x64"
    NODE_ARCHIVE="node-v22.19.0-darwin-x64.tar.gz"
    NODE_SHA256="3cfed4795cd97277559763c5f56e711852d2cc2420bda1cea30c8aa9ac77ce0c"
    ;;
  Darwin:arm64|Darwin:aarch64)
    NODE_PLATFORM="darwin-arm64"
    NODE_ARCHIVE="node-v22.19.0-darwin-arm64.tar.gz"
    NODE_SHA256="c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d"
    ;;
  Linux:x86_64|Linux:amd64)
    NODE_PLATFORM="linux-x64"
    NODE_ARCHIVE="node-v22.19.0-linux-x64.tar.gz"
    NODE_SHA256="d36e56998220085782c0ca965f9d51b7726335aed2f5fc7321c6c0ad233aa96d"
    ;;
  Linux:arm64|Linux:aarch64)
    NODE_PLATFORM="linux-arm64"
    NODE_ARCHIVE="node-v22.19.0-linux-arm64.tar.gz"
    NODE_SHA256="d32817b937219b8f131a28546035183d79e7fd17a86e38ccb8772901a7cd9009"
    ;;
  *)
    echo "pi-review-sessions: no pinned Node.js 22.19.0 archive is available for this platform." >&2
    exit 1
    ;;
esac

# Resolve the same native Pi agent directory used by the shared CJS. Preserve
# ordinary relative-path and ~/ override semantics; never follow a symlink
# while creating or descending through the cache directory components.
if [[ -n "${PI_CODING_AGENT_DIR:-}" ]]; then
  case "$PI_CODING_AGENT_DIR" in
    "~") AGENT_DIR="${HOME:-}";;
    \~/*)
      if [[ -z "${HOME:-}" ]]; then
        echo "pi-review-sessions: cannot resolve the native Pi agent directory." >&2
        exit 1
      fi
      AGENT_DIR="${HOME}/${PI_CODING_AGENT_DIR#\~/}"
      ;;
    *) AGENT_DIR="$PI_CODING_AGENT_DIR";;
  esac
else
  if [[ -z "${HOME:-}" ]]; then
    echo "pi-review-sessions: cannot resolve the native Pi agent directory." >&2
    exit 1
  fi
  AGENT_DIR="$HOME/.pi/agent"
fi
if [[ -z "$AGENT_DIR" ]]; then
  echo "pi-review-sessions: cannot resolve the native Pi agent directory." >&2
  exit 1
fi

ensure_directory_path() {
  local requested="$1" absolute rest component current
  case "$requested" in
    /*) absolute="$requested";;
    *) absolute="$PWD/$requested";;
  esac
  current="/"
  rest="${absolute#/}"
  while [[ -n "$rest" ]]; do
    component="${rest%%/*}"
    if [[ "$rest" == */* ]]; then rest="${rest#*/}"; else rest=""; fi
    case "$component" in
      ""|.) continue;;
      ..)
        if [[ "$current" != "/" ]]; then current="${current%/*}"; [[ -n "$current" ]] || current="/"; fi
        ;;
      *)
        if [[ "$current" == "/" ]]; then current="/$component"; else current="$current/$component"; fi
        if [[ -L "$current" ]]; then return 1; fi
        if [[ -e "$current" ]]; then
          [[ -d "$current" ]] || return 1
        else
          # mkdir is deliberately non-recursive: collisions and non-directory
          # components fail closed without replacing any existing resource.
          mkdir -m 700 "$current" 2>/dev/null || return 1
          [[ -d "$current" && ! -L "$current" ]] || return 1
        fi
        ;;
    esac
  done
  NODE_CACHE_ROOT="$current"
}

if ! ensure_directory_path "$AGENT_DIR/.pi-review-gate/node"; then
  echo "pi-review-sessions: cannot safely prepare the isolated Node cache directory." >&2
  exit 1
fi

CURL_BIN="$(type -P curl 2>/dev/null || true)"
TAR_BIN="$(type -P tar 2>/dev/null || true)"
WC_BIN="$(type -P wc 2>/dev/null || true)"
READLINK_BIN="$(type -P readlink 2>/dev/null || true)"
STAT_BIN="$(type -P stat 2>/dev/null || true)"
if [[ -z "$CURL_BIN" || -z "$TAR_BIN" || -z "$WC_BIN" || -z "$READLINK_BIN" || -z "$STAT_BIN" ]]; then
  echo "pi-review-sessions: isolated Node bootstrap requires curl, tar, wc, readlink, and stat." >&2
  exit 1
fi

# Capture stable filesystem identities for the cache and exclusive work root.
# These checks detect collisions/replaced paths; they are not a same-user race
# sandbox. No cache-name-based cleanup or recursive deletion is attempted.
path_identity() {
  local path="$1" output
  [[ ! -L "$path" && ( -d "$path" || -f "$path" ) ]] || return 1
  if [[ "$HOST_OS" == "Darwin" ]]; then
    output="$("$STAT_BIN" -f '%d:%i' "$path" 2>/dev/null)" || return 1
  else
    output="$("$STAT_BIN" -c '%d:%i' "$path" 2>/dev/null)" || return 1
  fi
  [[ "$output" =~ ^[0-9]+:[0-9]+$ ]] || return 1
  printf '%s' "$output"
}

assert_path_identity() {
  local path="$1" expected="$2" current
  current="$(path_identity "$path")" || return 1
  [[ "$current" == "$expected" ]]
}

NODE_CACHE_ROOT_ID="$(path_identity "$NODE_CACHE_ROOT")" || {
  echo "pi-review-sessions: could not capture the isolated Node cache identity." >&2
  exit 1
}

# A random mktemp directory is the positively owned extraction/download root.
# It stays mode 0700 as a retained failure witness; the verified extracted
# runtime is kept for the lifetime of the launched CJS, and future launches
# always re-extract.
ORIGINAL_UMASK="$(umask)"
umask 077
if ! WORK_ROOT="$(mktemp -d "$NODE_CACHE_ROOT/bootstrap.XXXXXXXX" 2>/dev/null)"; then
  echo "pi-review-sessions: could not create an exclusive Node bootstrap workspace." >&2
  exit 1
fi
if [[ "${WORK_ROOT%/*}" != "$NODE_CACHE_ROOT" || "${WORK_ROOT##*/}" != bootstrap.* ]]; then
  echo "pi-review-sessions: mktemp returned a workspace outside the isolated Node cache." >&2
  exit 1
fi
WORK_ROOT_ID="$(path_identity "$WORK_ROOT")" || {
  echo "pi-review-sessions: could not capture the exclusive Node workspace identity." >&2
  exit 1
}
shopt -s nullglob dotglob
WORK_ROOT_ENTRIES=("$WORK_ROOT"/*)
shopt -u nullglob dotglob
if (( ${#WORK_ROOT_ENTRIES[@]} != 0 )); then
  echo "pi-review-sessions: exclusive Node workspace was not empty; existing contents were preserved." >&2
  exit 1
fi
ARCHIVE_PATH="$WORK_ROOT/$NODE_ARCHIVE"
LISTING_PATH="$WORK_ROOT/archive-members.txt"
EXTRACT_ROOT="$WORK_ROOT/extracted"

bootstrap_failure() {
  echo "pi-review-sessions: $1" >&2
  echo "pi-review-sessions: retained bootstrap witness: $WORK_ROOT" >&2
  exit 1
}

assert_workspace_identity() {
  assert_path_identity "$NODE_CACHE_ROOT" "$NODE_CACHE_ROOT_ID" || return 1
  assert_path_identity "$WORK_ROOT" "$WORK_ROOT_ID"
}

assert_archive_ownership() {
  assert_workspace_identity || return 1
  assert_path_identity "$ARCHIVE_PATH" "$ARCHIVE_ID"
}

assert_extraction_ownership() {
  assert_archive_ownership || return 1
  assert_path_identity "$EXTRACT_ROOT" "$EXTRACT_ROOT_ID"
}

assert_node_ownership() {
  assert_workspace_identity || return 1
  assert_path_identity "$EXTRACT_ROOT" "$EXTRACT_ROOT_ID" || return 1
  assert_path_identity "$NODE_BIN" "$NODE_BIN_ID"
}

# No redirects: the only permitted request is this fixed HTTPS artifact URL.
# curl's configuration file is disabled, the elapsed transfer deadline is
# finite, and both curl and a post-download size check enforce the byte cap.
NODE_URL="https://nodejs.org/dist/v22.19.0/$NODE_ARCHIVE"
assert_workspace_identity || bootstrap_failure "isolated Node workspace identity changed before download."
if ! HTTP_STATUS="$("$CURL_BIN" --disable --fail --silent --show-error --connect-timeout 15 --max-time 180 --max-filesize 268435456 --output "$ARCHIVE_PATH" --write-out '%{http_code}' "$NODE_URL" 2>/dev/null)"; then
  bootstrap_failure "official Node archive download failed or exceeded its deadline/size limit."
fi
if [[ "$HTTP_STATUS" != "200" || ! -f "$ARCHIVE_PATH" || -L "$ARCHIVE_PATH" ]]; then
  bootstrap_failure "official Node archive download returned an invalid response."
fi
ARCHIVE_ID="$(path_identity "$ARCHIVE_PATH")" || bootstrap_failure "could not capture the downloaded archive identity."
assert_workspace_identity || bootstrap_failure "isolated Node workspace identity changed during download."
ARCHIVE_BYTES_RAW="$(LC_ALL=C "$WC_BIN" -c < "$ARCHIVE_PATH" 2>/dev/null || true)"
if [[ ! "$ARCHIVE_BYTES_RAW" =~ ^[[:space:]]*([0-9]{1,12})[[:space:]]*$ ]]; then
  bootstrap_failure "official Node archive size could not be verified."
fi
ARCHIVE_BYTES="${BASH_REMATCH[1]}"
if (( ARCHIVE_BYTES > 268435456 )); then
  bootstrap_failure "official Node archive exceeded the size limit."
fi

# Hash the complete archive before any archive listing, extraction, or binary
# execution. Prefer the platform-native SHA-256 tools; never run Node to hash.
if ! assert_archive_ownership; then bootstrap_failure "downloaded archive identity changed before checksum verification."; fi
if SHA_TOOL="$(type -P shasum 2>/dev/null)"; then
  if ! SHA_OUTPUT="$("$SHA_TOOL" -a 256 "$ARCHIVE_PATH" 2>/dev/null)"; then
    bootstrap_failure "could not verify the official Node archive checksum."
  fi
  ACTUAL_SHA256="${SHA_OUTPUT%%[[:space:]]*}"
elif SHA_TOOL="$(type -P sha256sum 2>/dev/null)"; then
  if ! SHA_OUTPUT="$("$SHA_TOOL" "$ARCHIVE_PATH" 2>/dev/null)"; then
    bootstrap_failure "could not verify the official Node archive checksum."
  fi
  ACTUAL_SHA256="${SHA_OUTPUT%%[[:space:]]*}"
elif SHA_TOOL="$(type -P openssl 2>/dev/null)"; then
  if ! SHA_OUTPUT="$("$SHA_TOOL" dgst -sha256 "$ARCHIVE_PATH" 2>/dev/null)"; then
    bootstrap_failure "could not verify the official Node archive checksum."
  fi
  ACTUAL_SHA256="${SHA_OUTPUT##* }"
else
  bootstrap_failure "isolated Node bootstrap requires shasum, sha256sum, or openssl."
fi
if [[ ! "$ACTUAL_SHA256" =~ ^[0-9a-f]{64}$ || "$ACTUAL_SHA256" != "$NODE_SHA256" ]]; then
  bootstrap_failure "official Node archive checksum did not match its source-pinned digest."
fi
if ! assert_archive_ownership; then bootstrap_failure "verified archive identity changed after checksum verification."; fi

# Validate archive member names before extraction. The source-pinned archive is
# authoritative; this additional check rejects absolute paths and dot-dot
# components before a platform tar implementation can interpret them.
NODE_DIST_DIR="node-v${NODE_VERSION_PIN}-${NODE_PLATFORM}"
if ! assert_archive_ownership; then bootstrap_failure "verified archive identity changed before member validation."; fi
if ! TAR_OPTIONS='' GZIP='' "$TAR_BIN" -tzf "$ARCHIVE_PATH" > "$LISTING_PATH" 2>/dev/null; then
  bootstrap_failure "verified Node archive could not be listed safely."
fi
LISTING_BYTES_RAW="$(LC_ALL=C "$WC_BIN" -c < "$LISTING_PATH" 2>/dev/null || true)"
if [[ ! "$LISTING_BYTES_RAW" =~ ^[[:space:]]*([0-9]{1,12})[[:space:]]*$ ]]; then
  bootstrap_failure "verified Node archive member listing size could not be verified."
fi
LISTING_BYTES="${BASH_REMATCH[1]}"
if (( LISTING_BYTES > 16777216 )); then
  bootstrap_failure "verified Node archive has an oversized member listing."
fi
while IFS= read -r MEMBER || [[ -n "$MEMBER" ]]; do
  case "$MEMBER" in
    "$NODE_DIST_DIR"|"$NODE_DIST_DIR"/*) ;;
    *) bootstrap_failure "verified Node archive contains an unexpected path.";;
  esac
  case "$MEMBER" in
    *//* ) bootstrap_failure "verified Node archive contains an unsafe path.";;
  esac
  case "/$MEMBER/" in
    *"/../"*|*"/./"*|*\\*) bootstrap_failure "verified Node archive contains an unsafe path.";;
  esac
done < "$LISTING_PATH"
if ! assert_archive_ownership; then bootstrap_failure "verified archive identity changed before extraction."; fi

if ! mkdir -m 700 "$EXTRACT_ROOT" 2>/dev/null; then
  bootstrap_failure "could not create a fresh exclusive Node extraction directory."
fi
EXTRACT_ROOT_ID="$(path_identity "$EXTRACT_ROOT")" || bootstrap_failure "could not capture the fresh extraction identity."
if ! assert_extraction_ownership; then bootstrap_failure "Node extraction ownership changed before archive extraction."; fi
if ! TAR_OPTIONS='' GZIP='' "$TAR_BIN" --no-same-owner --no-same-permissions -xzf "$ARCHIVE_PATH" -C "$EXTRACT_ROOT" 2>/dev/null; then
  bootstrap_failure "verified Node archive extraction failed."
fi
NODE_DIST_ROOT="$EXTRACT_ROOT/$NODE_DIST_DIR"
NODE_BIN="$NODE_DIST_ROOT/bin/node"
NPM_ROOT="$NODE_DIST_ROOT/lib/node_modules/npm"
NPM_CLI="$NPM_ROOT/bin/npm-cli.js"
if [[ ! -d "$EXTRACT_ROOT" || -L "$EXTRACT_ROOT" || ! -d "$NODE_DIST_ROOT" || -L "$NODE_DIST_ROOT" || ! -d "$NODE_DIST_ROOT/bin" || -L "$NODE_DIST_ROOT/bin" || ! -d "$NODE_DIST_ROOT/lib" || -L "$NODE_DIST_ROOT/lib" || ! -d "$NODE_DIST_ROOT/lib/node_modules" || -L "$NODE_DIST_ROOT/lib/node_modules" || ! -d "$NPM_ROOT" || -L "$NPM_ROOT" || ! -d "$NPM_ROOT/bin" || -L "$NPM_ROOT/bin" || ! -f "$NODE_BIN" || -L "$NODE_BIN" || ! -x "$NODE_BIN" || ! -L "$NODE_DIST_ROOT/bin/npm" || ! -f "$NPM_CLI" || -L "$NPM_CLI" ]]; then
  bootstrap_failure "verified Node archive did not contain the expected regular Node and npm entries."
fi
if ! assert_extraction_ownership; then bootstrap_failure "extraction identity changed after archive extraction."; fi
NODE_BIN_ID="$(path_identity "$NODE_BIN")" || bootstrap_failure "could not capture the fresh Node executable identity."
NPM_LINK_TARGET="$("$READLINK_BIN" "$NODE_DIST_ROOT/bin/npm" 2>/dev/null)" || bootstrap_failure "verified Node npm entry could not be validated."
if [[ "$NPM_LINK_TARGET" != "../lib/node_modules/npm/bin/npm-cli.js" ]]; then
  bootstrap_failure "verified Node archive contained an unexpected npm link."
fi

# The first execution of this runtime is strictly after the source-pinned hash
# and fresh extraction have both succeeded. Validate the official floor before
# handing the original argument vector and environment to the shared CJS.
if ! assert_node_ownership; then bootstrap_failure "fresh Node executable identity changed before its version probe."; fi
if ! probe_node_version "$NODE_BIN"; then
  bootstrap_failure "verified Node executable did not report a supported version."
fi
if ! assert_node_ownership; then bootstrap_failure "fresh Node executable identity changed after its version probe."; fi
if [[ ${PATH+x} ]]; then
  export PATH="$NODE_DIST_ROOT/bin:$PATH"
else
  export PATH="$NODE_DIST_ROOT/bin"
fi
umask "$ORIGINAL_UMASK"
exec "$NODE_BIN" "$CJS_ENTRY" "$@"
