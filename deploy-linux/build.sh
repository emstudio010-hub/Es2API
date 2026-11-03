#!/usr/bin/env bash
# Build on Linux. Compilation only: does not run tests or supplier requests.
set -euo pipefail
TASK_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$TASK_ROOT"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo '需要 Linux x86_64。' >&2; exit 1; }
for tool in node npm go python3 curl sha256sum; do command -v "$tool" >/dev/null || { echo "缺少构建依赖：$tool" >&2; exit 1; }; done
node --input-type=module -e 'if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node.js 24+ required")'
STAGE_FOLDER="${ES2API_STAGE_FOLDER:-${ES2API_RELEASE_NAME:-Es2API-linux-x64-20261104-r11}}"
[[ ! -e "build-cache/$STAGE_FOLDER" ]] || { echo "分发暂存目录已存在：$STAGE_FOLDER" >&2; exit 1; }
mkdir -p build-cache/linux build-cache/deps/integration build-cache/deps/vm2api build-cache/payload
(
  cd sub2api/frontend
  npm exec --yes --package=pnpm@10.34.8 -- pnpm install --frozen-lockfile
  npm exec --yes --package=pnpm@10.34.8 -- pnpm exec vue-tsc -b
  npm exec --yes --package=pnpm@10.34.8 -- pnpm exec vite build
)
(
  cd vm2api/web
  npm exec --yes --package=pnpm@10.34.8 -- pnpm install --frozen-lockfile
  npm exec --yes --package=pnpm@10.34.8 -- pnpm run build
)
(
  cd sub2api/backend
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOMAXPROCS=2 go build -p 2 -tags embed,timetzdata -trimpath '-ldflags=-s -w -X main.BuildType=source' -o ../../build-cache/linux/es2api ./cmd/server
)
(
  cd vm2api/api-kernel
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOMAXPROCS=2 go build -p 2 -buildvcs=false -trimpath '-ldflags=-s -w' -o ../../build-cache/linux/kin-api-kernel ./cmd/kin-api-kernel
)
for project in integration vm2api; do
  cp "$project/package.json" "$project/package-lock.json" "build-cache/deps/$project/"
  npm ci --prefix "build-cache/deps/$project" --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund
done
node vm2api/scripts/fetch-payload.mjs --dest "$TASK_ROOT/build-cache/payload"
node vm2api/scripts/install-codex-cli.mjs
curl --fail --location https://nodejs.org/dist/v24.22.2/SHASUMS256.txt -o build-cache/node-v24.22.2-SHASUMS256.txt
curl --fail --location https://nodejs.org/dist/v24.22.2/node-v24.22.2-linux-x64.tar.xz -o build-cache/node-v24.22.2-linux-x64.tar.xz
(
  cd build-cache
  awk '$2 == "node-v24.22.2-linux-x64.tar.xz" { print }' node-v24.22.2-SHASUMS256.txt > node-linux.sha256
  [[ -s node-linux.sha256 ]] || { echo 'Node 校验项缺失。' >&2; exit 1; }
  sha256sum -c node-linux.sha256
)
python3 deploy-linux/package.py stage
python3 deploy-linux/package.py archive
