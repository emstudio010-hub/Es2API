#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo '请使用 sudo 安装系统服务。' >&2; exit 1; }
TASK_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
[[ "$TASK_ROOT" =~ ^/[A-Za-z0-9_./-]+$ ]] || { echo '安装目录仅支持英文、数字、点、下划线和横线。' >&2; exit 1; }
[[ ! -e /etc/systemd/system/es2api.service ]] || { echo 'es2api.service 已存在，请先检查现有服务；本脚本不覆盖。' >&2; exit 1; }
"$TASK_ROOT/es2api.sh" init
cat > /etc/systemd/system/es2api.service <<EOF
[Unit]
Description=Es2API API Console and Isolated Account Pool
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=$TASK_ROOT
ExecStart=$TASK_ROOT/es2api.sh run
Restart=on-failure
RestartSec=10
TimeoutStopSec=45
KillMode=control-group
UMask=0077
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now es2api.service
echo 'Es2API 服务已安装；日志：journalctl -u es2api.service -f'
