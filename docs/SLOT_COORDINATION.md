# Codex 实例的控制与请求协调

## Linux 同机控制进程（preview.19）

`vm2api/src/lib/vm/codex-slot-coordination.mjs` 为同一真实 projectRoot、同一槽 ID 建立三类基础 Linux `flock`：

| 文件 | 持有期间 | 用途 |
|---|---|---|
| `.codex-coordination/<id>.control.lock` | 凭据读写/刷新/交接，开机/重载、停止/删除和完整恢复流程 | 独占控制；请求只在取得活动锁时短暂共享持有 |
| `.codex-coordination/<id>.kernel.lock` | Kernel 启动检查或一次宿主请求 | 请求共享；维护等待独占后读取或写入凭据 |
| `.codex-coordination/<id>.cli.lock` | CLI 准备、执行及宿主 finalizer | 请求共享；停机后等待独占，再确认停机并允许清理 |

锁目录在账号 home 之外，不挂载到容器。文件可以一直存在，存在不表示正在占用。禁止在账号删除、home 清理或备份恢复时删除/替换正在使用的锁文件；那会产生两个不同 inode，破坏互斥。无需按 PID、文件时间或 TTL 自动解锁。

模块打开文件，将同一 open file description 作为 fd 3 传给短命 `flock --nonblock` 子进程；子进程成功退出后，Node 保持原 fd 到操作 finally。锁随最后一个 fd 关闭而释放，宿主进程崩溃也会由内核回收。三类基础锁没有额外守护进程；preview.22另有下文的原生Kernel owner。不把锁文件中的 PID 当作退出证明。目录拒绝符号链接，锁文件以 O_NOFOLLOW 打开并检查普通文件、单硬链接及 inode 一致性。

## 操作顺序

1. 控制操作先取得 control 独占锁；取得前不修改停机、凭据或恢复状态。冲突立即返回可重试错误，原来的进程内凭据排队改为冲突失败；不自动重放供应商调用。
2. 新请求在共享 control 保护下取得对应活动共享锁，再释放 control。控制方一旦取得独占 control，其他进程的新请求不能通过此入口开始。
3. 凭据刷新等待 Kernel 活动锁释放，确认已配置 Kernel 退出后才交换令牌。不会为刷新而停止已有请求。开机/重载先等待 Kernel 和 CLI 活动释放，再操作容器；readiness 在控制锁内、活动独占锁释放之后执行。CLI 请求只使用不含轮换 refresh token 的副本，既有 request claim 继续防止同账号重入。
4. 显式停止/删除先持久化停机意图并停止 Kernel/容器，再等待 Kernel 与 CLI 宿主活动锁释放；跨进程 finalizer 未释放时，不写 confirmed=true，不允许恢复清理继续。容器删除不等于 home 立即删除，账号和出口仍按原流程保留。
5. 恢复流程从停止之前到清理、重新开机、settle 和诊断结束均持有 control；内部 stop/start/凭据调用通过 AsyncLocalStorage 借用同一控制作用域，避免重新锁定自己。作用域结束后遗留异步任务不能继续借用已释放的锁。

活动排空最多等待 15 秒，每次锁命令本身最多 5 秒；不能将其视为严格的端到端操作总预算。超时保留原状态和请求占用，管理员重试原操作。锁工具缺失、非 Linux、文件不可读或类型不符时拒绝操作，不降级为无锁执行。所有并发控制进程必须同时升级并使用同一支持 flock 的本地文件系统。

## 不由该锁证明的事情

- 锁只协调采用本模块的同机宿主代码。直接 Docker/Kernel socket、旧版控制进程、容器自行刷新、远端节点及其他宿主文件系统不在此证明范围；不是分布式锁。
- preview.22 在源码中增加 Kernel bootstrap 与生命周期所有权，见下文。该代码尚无多进程并发或崩溃行为验收；不要把静态/编译结果当成多个主动推理控制进程的部署保证。
- control 独占不会凭空取消在途请求。CLI 控制进程退出、活动锁释放和 request claim 删除仍不能替代容器退出及原请求 nonce 退出回执。
- 崩溃留下的 CLI claim/请求目录仍需原版显式停止确认与恢复清理，不因控制锁已释放而自动删除。Kernel 请求结束也不是供应商排空证明。
- 锁文件和内核锁不改变账号 ID、代次、IP、时区、凭据指纹或数据库 schema。旧账号不迁移到 CLI，不借用现有独占出口。

本版仅做源码语法、模块加载、打包及只读健康核对。多进程互斥/崩溃回收、排空超时、文件系统/WSL 语义、真实刷新、停止/恢复、CLI 推理与隔离均未行为验收，不能宣称已经跑通。Linux 主机仍需安装 util-linux 的 `flock`，发行包不增加 npm 原生依赖。


## Kernel 配置、启动与生命周期（preview.22）

同一真实 projectRoot/槽新增两把永久 inode 锁：kernel-bootstrap.lock 序列化完整配置写入、启动、停止进程扫描；kernel-owner.lock 独占持有整个原生 owner/Kernel 生命周期。配置写入入口先取共享 control，再异步等待 bootstrap，取得后同步写完整文件；请求已经持有活动锁时只取 bootstrap，避免维护持 control 等待读者时发生反向等待。bootstrap冲突最多异步等待15秒，锁命令本身另有5秒预算；控制入场冲突或锁错误拒绝操作，不自动重放模型调用。配置和启动业务调用方均await此入口，等待锁不会阻塞同一Node进程中尚待健康结果的启动者。

配置/令牌/installation ID/上限 stamp 写入先使用0600临时文件、fsync 后原子 rename，不把部分JSON暴露给其他进程。读取已有令牌失败时只容许ENOENT代表缺失，不因权限错误生成新令牌。配置写入和ensure可在不同调用中发生，但两者使用同一 bootstrap，启动只读取完整配置。

Node 在精确扫描无遗留进程后取得 owner flock，再删除旧 socket并启动 kin-api-kernel codex-owner，将同一 open file description作为fd3传给子进程。Node finally只关闭自己的副本；即使它在子进程exec之前崩溃，子进程的fd仍覆盖此空隙。原生owner验证fd与命名锁文件为同一个普通单硬链接文件、属于当前uid且可独占持锁，然后启动指定Kernel，等待它退出。命令行只含二进制/配置/锁路径，不含令牌或代理密码。

原生owner在固定OS线程上创建Kernel，设置Linux Pdeathsig=SIGKILL并保持该线程到Wait结束。owner正常收到SIGTERM/SIGINT会转发给Kernel并等它退出；owner被强制终止时直接子Kernel收到死亡信号。额外fd同时传给Kernel，不假设第三方二进制会一直保留该fd；owner本身持锁且死亡信号约束直接子进程。此机制针对宿主原生Kernel，不是容器CLI退出回执，也不是整个系统的进程树沙箱。

启动前健康失败时，已有本地child、精确uid/executable/config argv扫描、owner锁中任一显示仍占用，则保留socket并拒绝再次启动。停止扫描同时识别原生owner与Kernel，按pid/startticks/uid/executable/完整参数复核后发信号；扫描结束还必须实际取得owner锁，排除尚未exec的子进程。无法确定身份或锁仍占用则失败并保留凭据。

上限stamp缺失/变更时，普通ensure先释放自己的活动共享锁，再持control独占、等待其他进程全部Kernel活动释放，停止并确认原Kernel退出，最后启动新实例；不依赖本进程请求计数。已经持有请求lease的内部ensure仅拒绝需要回收的请求，不自锁升级。配置改动与维护不会自动取消在途推理；活动锁释放也不是供应商端完全停止的证明。

tracked child使用真实root/槽ID，不跨工程误停同名槽；旧清除凭据入口通过同一control/Kernel排空与CLI排空后才删文件。多个控制进程必须同时升级源码与kin-api-kernel二进制；旧程序、直接socket调用、远端节点/不同文件系统不遵守这些锁。

本版未运行多进程或崩溃测试，也未运行真实模型。Go编译、源码检查、健康200仅证明可构建/可加载/服务可读，不能证明fd继承、Pdeathsig、WSL文件锁、刷新/回收等行为已通过验收。
