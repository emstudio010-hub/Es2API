# Codex 实例的控制与请求协调

## Linux 同机控制进程（preview.19）

`vm2api/src/lib/vm/codex-slot-coordination.mjs` 为同一真实 projectRoot、同一槽 ID 建立三把 Linux `flock`：

| 文件 | 持有期间 | 用途 |
|---|---|---|
| `.codex-coordination/<id>.control.lock` | 凭据读写/刷新/交接，开机/重载、停止/删除和完整恢复流程 | 独占控制；请求只在取得活动锁时短暂共享持有 |
| `.codex-coordination/<id>.kernel.lock` | Kernel 启动检查或一次宿主请求 | 请求共享；维护等待独占后读取或写入凭据 |
| `.codex-coordination/<id>.cli.lock` | CLI 准备、执行及宿主 finalizer | 请求共享；停机后等待独占，再确认停机并允许清理 |

锁目录在账号 home 之外，不挂载到容器。文件可以一直存在，存在不表示正在占用。禁止在账号删除、home 清理或备份恢复时删除/替换正在使用的锁文件；那会产生两个不同 inode，破坏互斥。无需按 PID、文件时间或 TTL 自动解锁。

模块打开文件，将同一 open file description 作为 fd 3 传给短命 `flock --nonblock` 子进程；子进程成功退出后，Node 保持原 fd 到操作 finally。锁随最后一个 fd 关闭而释放，宿主进程崩溃也会由内核回收。没有长期锁守护子进程，不把锁文件中的 PID 当作退出证明。目录拒绝符号链接，锁文件以 O_NOFOLLOW 打开并检查普通文件、单硬链接及 inode 一致性。

## 操作顺序

1. 控制操作先取得 control 独占锁；取得前不修改停机、凭据或恢复状态。冲突立即返回可重试错误，原来的进程内凭据排队改为冲突失败；不自动重放供应商调用。
2. 新请求在共享 control 保护下取得对应活动共享锁，再释放 control。控制方一旦取得独占 control，其他进程的新请求不能通过此入口开始。
3. 凭据刷新等待 Kernel 活动锁释放，确认已配置 Kernel 退出后才交换令牌。不会为刷新而停止已有请求。开机/重载先等待 Kernel 和 CLI 活动释放，再操作容器；readiness 在控制锁内、活动独占锁释放之后执行。CLI 请求只使用不含轮换 refresh token 的副本，既有 request claim 继续防止同账号重入。
4. 显式停止/删除先持久化停机意图并停止 Kernel/容器，再等待 Kernel 与 CLI 宿主活动锁释放；跨进程 finalizer 未释放时，不写 confirmed=true，不允许恢复清理继续。容器删除不等于 home 立即删除，账号和出口仍按原流程保留。
5. 恢复流程从停止之前到清理、重新开机、settle 和诊断结束均持有 control；内部 stop/start/凭据调用通过 AsyncLocalStorage 借用同一控制作用域，避免重新锁定自己。作用域结束后遗留异步任务不能继续借用已释放的锁。

活动排空最多等待 15 秒，每次锁命令本身最多 5 秒；不能将其视为严格的端到端操作总预算。超时保留原状态和请求占用，管理员重试原操作。锁工具缺失、非 Linux、文件不可读或类型不符时拒绝操作，不降级为无锁执行。所有并发控制进程必须同时升级并使用同一支持 flock 的本地文件系统。

## 不由该锁证明的事情

- 锁只协调采用本模块的同机宿主代码。直接 Docker/Kernel socket、旧版控制进程、容器自行刷新、远端节点及其他宿主文件系统不在此证明范围；不是分布式锁。
- Kernel 的请求内自动启动、tracked-child 表与 recycle 判定仍有进程内状态；本版活动锁阻止控制维护与请求重叠，并没有实现跨控制进程唯一 Kernel supervisor。不要据此部署多个主动推理控制进程，后续仍需补 bootstrap/recycle 的唯一所有权。
- control 独占不会凭空取消在途请求。CLI 控制进程退出、活动锁释放和 request claim 删除仍不能替代容器退出及原请求 nonce 退出回执。
- 崩溃留下的 CLI claim/请求目录仍需原版显式停止确认与恢复清理，不因控制锁已释放而自动删除。Kernel 请求结束也不是供应商排空证明。
- 锁文件和内核锁不改变账号 ID、代次、IP、时区、凭据指纹或数据库 schema。旧账号不迁移到 CLI，不借用现有独占出口。

本版仅做源码语法、模块加载、打包及只读健康核对。多进程互斥/崩溃回收、排空超时、文件系统/WSL 语义、真实刷新、停止/恢复、CLI 推理与隔离均未行为验收，不能宣称已经跑通。Linux 主机仍需安装 util-linux 的 `flock`，发行包不增加 npm 原生依赖。
