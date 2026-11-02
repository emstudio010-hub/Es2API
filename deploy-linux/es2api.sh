#!/usr/bin/env bash
set -euo pipefail
TASK_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ "${1:-}" == run ]]; then
  umask 077
  mkdir -p "$TASK_ROOT/runtime"
  exec flock --nonblock "$TASK_ROOT/runtime/supervisor.lock" "$TASK_ROOT/node/bin/node" "$TASK_ROOT/deploy-linux/launcher.mjs" "$@"
fi
exec "$TASK_ROOT/node/bin/node" "$TASK_ROOT/deploy-linux/launcher.mjs" "${@:-help}"
