#!/usr/bin/env bash
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/little-coder-review.sh" double-deepseek-v4-flash "$@"
