# Es2API v2026.11.06-preview.23

## CLI固定出口的本地就绪检查

- CLI健康和每次请求准备均核对实际容器的账号标签、单一网络绑定、桥接策略与代理配置，拒绝不匹配或不可读取的状态。
- 核对出口进程的用户与执行文件、TCP/DNS TCP/UDP监听所属PID、NAT链完整顺序，以及托管输入与禁止直连转发规则。
- Docker/ss/iptables-save只读命令共享至多5秒预算，失败返回固定脱敏错误码。失败发生在OAuth刷新和CLI启动之前，不自动重绑IP、修复防火墙或回退直连。
- 明确返回local_configuration_only及upstream_reachability_verified=false：本地就绪不表示DNS/代理/TLS/上游权限或模型推理成功，也不证明宿主其他防火墙规则没有干扰。

## 已知真实调用结果

2026-11-04修复后授权的一次gpt-6-luna请求返回HTTP502/codex_cli_connection_failed，CLI退出1、原进程组已退出，无有效正文与usage，未重试。当前本地出口检查通过不等于已修复该上游连接失败。本版没有新增推理、主动出站探测或行为测试。

## 验证与交付范围

保留现有账号、凭据、出口及设置。仅语法/模块加载、只读健康和打包核对；沿用既有二进制及固定CLI0.155.1。本版不包含用户runtime或私密操作证据。完整CLI→API、caller/Key/计费、隔离/并发生命周期、自动IP分配、ModelTrace及Linux安装/生产验收仍未全部闭环，HTTPS暂缓。

Linux附件：Es2API-linux-x64-20261106-r23.tar.gz及.sha256。
