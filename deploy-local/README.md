# 独立本地运行

这里启动 `Es2API-Rebuild` 的真实控制面，不接管旧 8081，不读取旧账号或旧数据库。Sub2API 与 integration 在 Windows 原生运行；VM2 在 WSL Ubuntu 中运行真实 Node 服务和 Linux API kernel。Docker Compose 仅管理独立 PostgreSQL、Redis。初始账号池为空，脚本不导入 OAuth、不发推理请求、不代替用户接受产品合规条款。

前置条件：Windows Node.js 24+、Docker Desktop Linux 引擎、WSL Ubuntu（Node.js 22+），并已安装 VM2 依赖。主程序需先带前端构建成 `runtime/bin/es2api.exe`（Go `-tags embed`）；VM2 的 `api-kernel` 需构建 Linux 可执行文件至 `runtime/vm2/bin/kin-api-kernel`。VM2 不是 mock；没有 Linux 内核时启动会失败。

在仓库根目录执行：

```powershell
node .\deploy-local\local.mjs init
node .\deploy-local\local.mjs start
node .\deploy-local\local.mjs status
node .\deploy-local\local.mjs stop
```

重新构建前先 Stop，再执行 `powershell -NoProfile -File .\deploy-local\build-local.ps1`。此脚本构建前端、Windows Go 嵌入版本以及 Linux VM2 API kernel；`-SkipFrontend` 只适合前端产物已确认最新时。

构建还会按 `vm2api/deploy/payload.json` 下载或复用并校验 15 个槽位运行文件，保存在 `runtime/vm2`，并准备 Docker 镜像构建的后备上下文。WSL 启动器显式使用这些目录中的执行内核、worker 和 SOCKS 出口程序。Start 会先做文件完整性检查；只存在 API kernel 但缺少槽位 payload 时不会继续启动。

启动后可执行 `node .\deploy-local\verify-local.mjs` 验证真实 HTTP 登录、权限、控制面与临时测试分组。退出码 0 表示已执行检查通过，1 表示故障，2 表示明确的验收阻断（例如仍待使用者处理的合规提示）。证据在 `runtime/verification/latest.json`；验证脚本不接受条款、不导入凭据、不创建 VM 槽位、不发推理请求，临时策略与分组在结束时恢复。

也可使用 `powershell -NoProfile -File .\deploy-local\Local.ps1 -Action Start`（支持 Init / Start / Stop / Status）。Init 只创建独立目录、私密配置和关闭主动探测的初始路由；再次执行不会轮换密码或覆盖已有路由。Start 检查端口、进程归属和依赖，启动后检查三个服务的 `/health`。不自动下载构建依赖，不自动构建应用。

| 服务 | 本地地址 | 数据 |
| --- | --- | --- |
| Sub2API 管理台 | http://127.0.0.1:18083 | `runtime/sub2api` + 独立 PostgreSQL |
| integration | http://127.0.0.1:18084 | `runtime/integration/es2api.sqlite` |
| VM2 控制面 | http://127.0.0.1:18787 | `runtime/vm2` |
| PostgreSQL | 127.0.0.1:15433 | Docker volume `es2api-rebuild-local-postgres-data` |
| Redis | 127.0.0.1:16380 | Docker volume `es2api-rebuild-local-redis-data` |

Compose project 固定为 `es2api-rebuild-local`。默认镜像是 `docker.1ms.run/library/postgres:18-alpine` 与 `docker.1ms.run/library/redis:8-alpine`；可在 Start 前设置 `ES2API_POSTGRES_IMAGE` / `ES2API_REDIS_IMAGE` 覆盖。WSL 发行版可用 `ES2API_WSL_DISTRO` 指定，默认 Ubuntu；Windows 访问 WSL 回环依赖 WSL 的 localhost forwarding，健康检查能发现未转发的情况。

管理员是 `admin@es2api.local`。密码只保存在 `runtime/local-secrets.json` 的 `admin.password`，脚本不会显示。该文件包含数据库密码、JWT/TOTP 密钥、integration 管理/数据密钥以及 VM2 管理密码/API key/数据库密钥，均以系统随机源生成。ACL 仅允许当前 Windows 用户、SYSTEM 和 Administrators。运行数据目录也采用此 ACL。不要把私密文件、运行数据库、日志或 Go 自动生成的 `runtime/sub2api/config.yaml` 提交或上传。

进程状态保存在 `runtime/local-processes.json`，日志在 `runtime/logs`。VM2 WSL 的进程归属记录在 `runtime/vm2/wsl-processes.json`，不记录 API kernel 命令中的内部 token。Linux socket/token 置于当前 WSL 用户独占的 `/tmp/es2api-rebuild-<uid>-<workspace hash>`（0700），避免 DrvFs 不支持 Unix socket；其他持久化、会话、抓包与路由都在 `runtime/vm2`。该目录不复制任何旧 VM 或凭据。

Codex 槽的 socket 由 `KIN_CODEX_SOCKET_DIR` 指向上述 Linux 临时目录的 `codex/`，按槽位运行目录和 ID 的哈希命名，保持在 Unix socket 长度限制内。凭据和配置仍保存在原持久化目录。不要把长 Windows 工作区路径直接用作 Codex socket 路径。

Stop 只停止已记录且 PID、创建时间、可执行文件和命令行归属核对一致的进程；WSL 还核对 boot ID、UID、启动 tick。它只停止本 Compose project 的容器，保留 volume、数据库、日志、密钥。不会递归删除任何目录，也不会操作原 8081。若启动失败，日志与已启动进程仍保留供诊断，先 Stop 后再 Start。

初始 VM2 routing 关闭健康推理、用量探测、凭据刷新、内核 watchdog 与通知；不设置 `KIN_CRS_MOCK`。真实空库无需供应商凭据即可验证管理台、鉴权与控制面。VM2 上游内置公共模型价格目录更新仍可能访问 models.dev；没有账号槽位时供应商目录同步跳过。实际账号导入、VM 槽位创建、固定出口和供应商推理仍需要单独验收。

Sub2API 新管理员首次登录仍会遇到真实合规提示；请由使用者在原 UI 审阅处理，启动脚本和验证脚本不会接受条款。不要把健康检查或空池 API 成功当成完整供应商验收。
## 用户调用自动检测

本地启动器为 VM2 与 integration 启用持久成功事件拉取，并复用原有管理员认证。Windows 每 2 秒从 VM2 拉取和确认事件，避免 WSL NAT 反向回调不可达；控制台显示最近成功通知。`/admin/modeltrace` 现为“模型智商控制台”：可设置自动策略、查看成功调用进度、最近回传、后台检测与历史结果。默认每 10 次成功调用采样 3 次，动作 `observe`；租赁账号需显式开启。每轮概率是指纹归因概率，不是 IQ。

自动策略可选：按次数、固定分钟、次数或时间、次数且时间、有调用才定时、概率抽检、空闲后首次调用。策略编辑提供 10 个预设，时间可选 5/10/15/30/60 分钟或自定义，并可设置每轮完成后的冷却。预设只修改草稿，保存后生效。固定分钟策略即使没有用户调用也会检测；希望有流量才检测时选择“有调用才定时”。概率抽检按每次成功调用独立抽取，冷却期间不会抽取或补测。旧账号不会因升级自动切换策略。

`node deploy-local/modeltrace-auto-live.mjs --account=ID` 只预检；加 `--execute-once` 会备份数据库，以限定单槽的临时用户 Key 发起一次普通真实请求，再观察自动产生的 3 样本检测。成功后该账号保留每 10 次成功调用自动检测，失败恢复原策略，不自动重发推理。该验收针对 VM2 用户入口，不能替代 Sub2API 原生公共网关调度验收。

## 发布账号池供用户调用

完整管理员在「账号池 → 管理分组 → 开放用户调用」选择账号池分组、已有的 OpenAI 用户分组和并发上限。发布会创建或更新一个原生执行来源；用户 Key 需绑定所选用户分组，之后从 Sub2API 的 `/v1/responses`、`/v1/chat/completions` 或 Responses WebSocket 调用。原生鉴权、模型权限、余额/订阅限额、并发和计费继续生效。计费关联发布来源，具体槽位见 VM2/integration 记录。没有自动迁移或替用户选择分组。

撤回发布停止该来源的新调度，已有请求继续完成；独立 VM2 Key 不会被撤销。账号池暂停/降权对下一次池选择生效，并通过每 2 秒的控制同步约束 VM2 普通选槽；在途请求不强制中断。管理令牌轮换后需重新发布，使私有上游派生凭据同步更新。

HTTPS/域名按用户要求暂缓，当前入口仍为上述本机 HTTP 地址。本轮仅编译打包与启动恢复，没有运行测试、浏览器验收或真实推理。历史自动检测第三样本 502 尚未查明原因；新增内核分类诊断只记录错误类别，不记录原始 stderr、凭据或请求正文。

## 守护、备份和恢复

账号池隔离升级：发布入口按已认证用户 Key、分组、槽位代次和账号实例绑定会话与 previous_response_id，绑定失效直接报错，不自动换号。升级前的响应 ID 无新归属索引，需要开始新会话。每账号继续使用原版 VM2 的独立槽位/凭据目录/固定出口；共用代理不代表拥有不同公网 IP，Docker 也仍共享宿主内核。实现边界见 integration/CONTRACT.md。账号池行内可展开隔离详情；未知容器或时区显示待确认，可手动同步状态，不自动重建容器。

管理台采用暖白/石墨黑配香槟金的鎏金主题，保留明暗切换、原生操作、状态颜色与中英文。设计令牌见 sub2api/DESIGN.md。本轮按用户要求不做测试、浏览器渲染验收或真实推理。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy-local\Service.ps1 -Action Install
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy-local\Service.ps1 -Action Status
node .\deploy-local\operations.mjs backup
```

守护任务 `Es2API-Rebuild-Guard` 随当前用户登录启动，隐藏运行，每 20 秒观察三个服务的健康状态，连续失败 3 次后尝试恢复，恢复失败后等待 5 分钟。健康期间每 24 小时备份；备份或恢复失败写本机 Application 错误事件和私密 `runtime/logs/operations.log`。这不是无人登录时的系统服务。计划任务和手动守护均限制单实例。

备份保存在 `runtime/backups/<UTC时间>/`，包含 PostgreSQL dump、两份 SQLite 快照、配置、密钥和槽位文件，并记录 SHA256 清单；包含敏感凭据，不能提交或外传。在线跨库备份不是全局一致事务，恢复流程本轮未演练。

恢复命令会关闭守护、暂停应用并保留数据库容器，在校验清单后先备份现状再恢复；数据库密码不同会拒绝。旧槽文件和 SQLite sidecar 保留，不删除原数据：

```powershell
node .\deploy-local\operations.mjs restore 'C:\Users\Administrator\Desktop\Es2API-Rebuild\runtime\backups\<UTC时间>'
node .\deploy-local\local.mjs start
```

只回滚 Go 程序可用 `node deploy-local/operations.mjs rollback-binary <runtime/bin/es2api.exe.previous-时间>`，自动保留当前程序后启动。此操作不回滚数据库或 Node 源码。恢复/回滚后守护保持关闭；需要时用 `Service.ps1 -Action Start` 再开启。维护停机前用 `Service.ps1 -Action Stop`，否则守护会尝试恢复。`local.mjs pause` 仅停应用，`stop` 同时停本项目数据库容器，均保留 volume。

Start 遇到已确认的 Docker `sailor-ingest.sock` 临时目录故障时，仅在 backend 不运行时保留重命名对应运行目录并等待引擎，不删除 VHDX、volume 或项目数据库。

