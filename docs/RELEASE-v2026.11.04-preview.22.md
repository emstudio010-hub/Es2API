# Es2API v2026.11.04-preview.22

补齐同机 Kernel 配置、启动和回收的跨进程所有权，保护账号凭据与正在执行的请求。

- 新增 bootstrap flock：异步等待锁后序列化完整配置写入与启动，两个业务调用方均等待配置完成；令牌、installation ID、配置、请求体上限 stamp 使用完整临时文件、fsync 后原子 rename，读取错误拒绝继续。
- kin-api-kernel 新增 codex-owner 原生启动模式，接收宿主已取得的生命周期 flock fd3。锁从 Node 到原生 owner，再到 Kernel 交接；Node 在子进程 exec 前后退出也不能凭空让下一控制进程获得启动权。
- owner 在等待 Kernel 退出期间持锁；固定创建它的 OS 线程，使用 Linux Pdeathsig，owner 意外退出时直接 Kernel 收到 SIGKILL。所有停止与接管仍需精确进程扫描和 owner 锁可取得，不能用 socket 健康失败代替退出证明。
- 请求体上限变更或旧 stamp 缺失时，先释放本次共享活动，再取控制锁、排空全局 Kernel 请求，确认已配置进程与 owner 退出后重启；不再使用本进程 inFlight 推断全局空闲。已有请求内检查遇到变更会拒绝，不升级自己持有的共享锁。
- unhealthy 的残留 Kernel/owner 保留 socket，拒绝第二次启动；spawn/error/exit 独立处理，tracked child 按真实 root 与槽 ID 记录，并在确认退出后释放本地记录。诊断“空闲”同时核对进程与 owner 锁。
- 旧版清除凭据入口先排空 Kernel/CLI、确认原生 owner 与 Kernel 退出，再删除凭据；清空后不立即启动空账号。账号池管理的凭据仍从账号管理维护。

## 验证与边界

本版仅做语法/模块加载、Go Linux 编译、归档与只读服务健康核对，不运行测试或新增推理。多进程并发/崩溃/信号/文件系统语义、真实刷新与停止恢复尚未行为验收；不能据此宣称多个主动推理控制进程已通过验收。

真实 gpt-6-luna 的历史结果仍为502/exit1、没有有效正文或 usage。修复后单次新调用授权仍待答复。CLI→API成功、完整caller/分组/计费、跨账号隔离、自动并发分IP、ModelTrace历史第三样本失败与Linux安装/生产验收均未闭环；HTTPS按用户要求暂缓。

Linux附件 Es2API-linux-x64-20261104-r22.tar.gz 和 .sha256；仅 kin-api-kernel 编译更新，官方 Kernel/CLI payload、UI与用户数据不重建或迁移，包不包含私密 runtime。所有主动控制进程和 API kernel 二进制必须同时升级。
