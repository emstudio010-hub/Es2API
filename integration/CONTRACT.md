# Es2API 控制面与执行面契约

## 独立账号池与自动 IP（2026-11-04）

新导入账号由服务端创建专属 per_slot 分组。未指定 proxy_id 时选择未占用的非直连代理；按出口取得时区，落盘前同步独占预留，禁止共享。没有资源/时区时返回 409，保留可重试账号记录，禁止导入凭据或启动。实际代理 ID 写回 binding，重试与重建不换出口。管理 API 新增 GET/POST /exit-resources，响应采用脱敏字段白名单。历史分组及账号不做自动迁移。详见 ../docs/ACCOUNT_WORKSPACES.md。

本目录是从两个干净上游仓库开始的可运行集成后端。它不复制 VM2 的管理前端；作为控制面窄 API，负责账号池/租赁账号、VM2 槽位生命周期和 ModelTrace 状态。

## 边界

- **Sub2API**：账号、凭据导入、分组、管理 Key、代理/IP 选择、并发/RPM、模型调度和用户协议入口。
- **VM2API**：OpenAI/Codex 执行槽位的 Docker/KVM 生命周期、固定出口、环境身份、容器健康、Responses WebSocket。
- **integration**：把一次账号变更映射为 VM2 槽位变更，并定义失败保留、重试、公开状态、ModelTrace 任务和透传字段。

## 账号导入闭环

### 重试与凭据交接（preview.5）

生命周期导入带 `if_missing=true` 与 `expected_binding`，执行面核对所属账号、代次、后端及独占出口；已有唯一 OAuth 记录时保留，不把最初导入的旧刷新令牌覆盖回去。损坏文件或身份冲突保留原文并拒绝导入。修改运行设置触发重建时，先取消 ModelTrace、冻结实例、确认容器及宿主 Kernel 退出，再经管理员内部凭据交接端点取得当前令牌。控制面以 CAS 条件事务加密保存最新凭据和回执后才删除旧槽；中断重试依赖保存的回执，不凭 404 推断凭据已经保存。详见 [凭据连续性](../docs/CREDENTIAL_CONTINUITY.md)。

### OAuth 记录与元数据（preview.4）

控制面和执行面共同使用 `vm2api/src/lib/oauth/credential-import.mjs` 的纯解析函数。运行 integration 时需要保留仓库中同级的 vm2api 源码目录；Linux 分发包已经包含该文件。

单次导入按文档顺序选取第一条含 access_token/refresh_token 的记录（API Key 仍拒绝），所有令牌必须在同一对象内。支持平铺、tokens/credentials 等嵌套、accounts 数组和 CPR documents 导出；多账号文件仍只导入一条，不执行批量导入。documents 中仅读取 OpenAI/Codex 文档。数组、账号集合和无关对象的元数据不传递到子账号，缺失令牌不会从其他账号补全。

只保留选中记录及其透明包装层的 `chatgpt_account_id`、`email`、`expires_at`；选中令牌对象中的 account_id/accountId，以及 auth.json 中 tokens 旁的该字段，作为供应商 ID 别名。credentials 包装层的管理 account_id 和任意 id 不能作为供应商 ID。字段有长度/格式限制；无效可选元数据忽略。绝对期限支持 Unix 秒、毫秒、带时区 ISO 文本（含 expired 别名），统一成秒；没有基准时间的 expires_in 不推算。嵌套深度最多64，遍历对象最多10000。

这些字段是导入提示，不代表已认证的供应商身份。元数据随凭据加密保存，不进入 publicCredentialStatus；凭据指纹仍只使用原有四个令牌字段，不改旧数据库指纹，不重写或迁移已有账号。相同账号刷新后的新令牌目前仍可能形成不同指纹，不能宣称已经实现供应商稳定身份去重。

1. 控制面验证并保存账号，生成稳定的 `account_id`。
2. `AccountLifecycle.provision()` 调用 VM2 `/api/panel/vms/create`，固定 `runtime_type=docker`、`platform=openai`、`kind=codex`，并以 `start=false` 创建空槽。
3. 创建成功后才调用 `/api/panel/vms/import` 导入 ChatGPT OAuth 凭据；不接受 OpenAI API Key 作为账号凭据。
4. 凭据导入成功后调用槽位 `/start`，再读取状态；只有 `running + ready` 才能回写“可调度”。
5. 导入或健康检查失败会保留已知 `vm_id` 和错误槽位，不自动删除、不丢失账号 ID；管理员可调用原账号的 `POST .../retry` 重试。这样可检查部分创建状态，也避免自动重复创建。
6. 删除账号先取消该账号正在运行的 ModelTrace，再调用 `DELETE /api/panel/vms/:id`；只有 VM2 删除确认后才删除本地凭据和账号映射。失败时保留 `deletion_pending=true`，可调用 `retry-delete`。

所有涉及外部槽位生命周期的写请求带稳定幂等键；槽位创建/导入键包含 `provision_generation`，删除键同时绑定 generation、账号 ID 和 VM ID，避免重建后复用旧槽位操作。当前 VM2 不实现创建请求的幂等键：有已记录 `vm_id` 的重试会核验并复用该槽，只有明确返回 404 才重新创建；不会重复 POST create 或接管不匹配的槽。账号导入另外支持调用方提供的 `Idempotency-Key`。凭据仅进入导入请求；状态、日志、前端摘要只能返回 token 存在性和 SHA-256 指纹，不能返回原文。

## 模式与出口

- `pool`：可指定多个共享分组，也可以明确不分组；调度仍由 Sub2API 决定。
- `lease`：执行槽按账号独立，分组策略标记为 `per_slot`；后续 UI 可把租赁用户映射到该槽。
- `ip_policy` 固定为 `fixed`。不在执行层轮换代理；代理/IP 的选择和释放由 Sub2API 控制面完成。
- 执行槽使用 `identity_policy=ip_derived` 与 `ip_selection=create_only`：固定出口必须在创建槽位时选择，VM2 根据该出口计算时区和身份锚；运行后不接受 IP/时区修改。

账号记录仅返回 `has_*` 和 SHA-256 指纹；凭据以 AES-256-GCM 存在 SQLite 中。数据库启动时会把上次进程中断的 `queued/running` ModelTrace 任务标成 `interrupted`，不会自动重放。

## 账号池 API

所有 `/api/v1/admin/*` 请求都要求 `Authorization: Bearer <ES2API_MANAGEMENT_TOKEN>`；`/health` 不需要认证。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET/POST | `/api/v1/admin/accounts` | 分页查询/导入账号；支持 `status`、`mode`、`group_id`、`search` |
| GET/PUT/DELETE | `/api/v1/admin/accounts/:id` | 查询、修改调度字段、删除账号 |
| POST | `/api/v1/admin/accounts/:id/retry` | 核验并复用已记录槽位，重试导入/启动；明确不存在时创建 |
| POST | `/api/v1/admin/accounts/:id/retry-delete` | 重试待删除账号 |
| POST | `/api/v1/admin/accounts/:id/sync` | 读取 VM2 槽位健康并刷新本地调度状态 |
| GET/POST | `/api/v1/admin/groups` | 查询/创建 OpenAI 分组 |
| PUT/DELETE | `/api/v1/admin/groups/:id` | 停用/改名或删除未使用分组 |

导入体至少包含 `credential`（原文、JSON 或嵌套 token），可选 `account_id`（生成的槽位 ID 可安全限制在 80 字符内）、`mode=pool|lease`、`group_ids`、创建时的 `proxy_id`、`locale`、`concurrency`、`priority`。`proxy_id` 是执行槽创建时的固定出口选择；`timezone` 不再作为执行槽身份输入。租赁模式必须且只能绑定一个 `per_slot` 分组；省略时自动创建 `lease-<account_id>` 分组。账号凭据指纹唯一，重复导入返回 409。

## ModelTrace API 与策略

| 方法 | 路径 | 作用 |
|---|---|---|
| GET/PUT | `/api/v1/admin/modeltrace/config` | 全局配置 |
| GET/PUT | `/api/v1/admin/modeltrace/bank` | 管理员安装参考挑战/模型响应库 |
| POST | `/api/v1/admin/modeltrace/run` | 对指定账号排队一次手动检测 |
| GET | `/api/v1/admin/modeltrace/runs`、`.../runs/:id` | 查询分页/单次记录 |
| POST | `.../runs/:id/cancel` | 仅取消当前仍对应该 run ID 的任务 |
| GET/PUT | `/api/v1/admin/accounts/:id/modeltrace` | 账号覆盖配置和状态 |
| POST | `/api/v1/admin/accounts/:id/modeltrace/reset-action` | 清除 pause/deprioritize 动作并恢复原调度值 |
| POST | `/api/v1/admin/usage/success` | 记录一次成功请求，触发请求阈值检测 |
| GET | `/api/v1/admin/modeltrace/summary` | 汇总当前配置、指纹库、运行状态和账号最近检测状态 |

## 调度租约与容量

账号池控制面提供两步式调度租约：`POST /api/v1/admin/pool/acquire` 使用调用方的稳定 `request_id` 选择一个健康、可调度且未达到并发上限的账号；相同 `request_id` 重复提交会返回原账号。请求结束后用 `POST /api/v1/admin/pool/release` 释放租约，并可带 `success`、`error_code`、`rate_limited_until`、`overload_until` 和临时不可调度字段。服务重启会把未释放租约标为 `interrupted` 并清除在途计数，避免把旧请求永久占席。

`GET /api/v1/admin/pool/stats` 返回总数、就绪数、可调度数、当前可用容量、忙碌数和冷却数。调度候选按 `priority`、并发占用比例、最近使用时间和账号 ID 稳定排序。组停用会记录原先可调度状态，重新启用时只恢复原本参与调度且仍然健康的账号。

创建后的执行槽 IP、IP 派生指纹和时区不可修改；尝试更新 `proxy_id` 或 `timezone` 返回 `slot_ip_immutable`。需要更换出口时，管理员必须删除账号并重新导入，在创建新槽时选择新的 `proxy_id`。分组归属是控制面调度字段，修改分组不重建执行槽；没有有效分组时不能开启调度。带在途请求时拒绝重建和删除，避免释放仍在执行的账号。

账号导入支持 `Idempotency-Key` 请求头。相同键只能对应同一请求内容，重试返回同一账号结果；不同请求复用同一键返回冲突。失败结果也会保存，避免客户端重试时创建第二个槽。

默认全局策略为指定模型 `gpt-6.1-sol`、每 10 次成功请求、每轮 3 个挑战、动作 `observe`。账号池账号默认启用自动检测，租赁账号默认关闭，租赁账号可在账号覆盖中显式 `{"enabled":true}`。`manual` 任务允许对关闭自动检测的账号执行一次检测。`most_used` 只从成功且上游模型与请求模型一致的记录中选择参考库已有模型。

默认使用固定版本的 CPA 数字指纹库，每轮采样 3 个独立挑战，返回候选集内的匹配概率，不是智力评分或模型身份保证。管理员导入的文本库仍使用归一化词/字符 n-gram 相似度；其参考库至少需要 3 个挑战、2 个模型，并且每个模型对每个挑战恰好一条响应。

## 用户调用后的自动检测

VM2 的 Responses JSON/SSE/WebSocket 完成处理会生成成功事件，包含服务端独立 UUID `event_id`、实际 `vm_id`、请求/上游模型和 `success:true`。integration 用实际执行槽查找账号，在同一 SQLite 事务内去重、累计成功数和记录最近调用时间。事件不包含提示词、回答、用户 Key 或 OAuth。未知执行槽忽略；同一事件 ID 内容冲突返回 409。

只有已验证完成的成功推理计数，失败、取消、流中断、预热和健康缓存不计数。仅可信 master 身份的内部检测标记能排除采样；普通 Key 伪造标记不能跳过计数。每个账号同时最多一轮检测，检测期间的成功调用合并，结束后重新累计；间隔策略从检测结束重新计时。关闭自动检测阻止后续任务，已有任务通过取消按钮停止。

`trigger` 支持以下方式；时间单位在 API 中为秒，在控制台中为分钟。

| 值 | 触发条件 |
|---|---|
| `requests` | 成功调用累计达到 `every_requests`，由成功事件触发 |
| `interval` | 每隔 `interval_seconds` 检测，即使期间没有用户调用 |
| `both` | 调用次数或间隔任一条件满足 |
| `requests_and_interval` | 次数和间隔同时满足；最后满足的条件触发 |
| `active_interval` | 间隔已到，且本周期至少有一次成功调用 |
| `probability` | 每条符合条件的独立成功事件以 `sampling_probability` 概率抽检 |
| `idle_return` | 首次成功调用，或与上次成功调用间隔至少 `idle_seconds` |
| `manual` | 仅管理员手动触发 |

新增字段默认值为 `sampling_probability=0.1`（0.01–1）、`idle_seconds=1800`（整数 60–604800）、`cooldown_seconds=0`（整数 0–604800）。所有自动方式都遵守完成后的冷却，完成包括成功、错误和取消；手动检测可跳过冷却，结束后重新计算。冷却期间保留成功计数，但纯次数策略需下一条成功事件才触发；概率与空闲恢复不会补抽或补测。重复通知、失败通知、在途检测和冷却期间均不进行随机抽取，10% 不保证每十次恰有一次检测。调度时钟不会触发概率或空闲恢复策略。

每轮完成按最新有效策略重新计算间隔，不追赶已错过的周期。保存策略重新开始次数/间隔周期，但保留最近完成时间与成功调用历史，不能通过保存绕过冷却。旧配置自动补充新字段，不改变原触发方式。`automation` 包含新参数、`cooldown_until`、`cooldown_remaining_seconds` 和 `idle_due_at`；`ready` 表示前置条件就绪，冷却状态单独展示。`next_due` 是间隔到期时间，AND/活跃策略仍须满足调用条件。

控制台提供 10 个草稿预设，以及 5/10/15/30/60 分钟和自定义输入；旧 90 秒显示为 1.5 分钟。选择预设不会自动保存或开启，也不会改模型、采样数和动作。账号快捷开启保留已有策略，只有 `manual` 转为 `requests`。

可信内部采样（master + `x-es2api-modeltrace: 1`）在 Node 网关只调用一次 Codex kernel：关闭同账号重试、换槽、transport 补发和 reasoning-history fallback，单请求选择 HTTP 避免 WebSocket 回退。失败立即保存本轮错误，不自动补齐剩余样本。普通用户请求沿用原有策略。测试覆盖 Node 网关到 kernel 的调用次数，不宣称检查了预编译 kernel 内部全部 HTTP 行为。

独立本地栈在 VM2 和 integration 配置 `ES2API_USAGE_MODE=pull`。事件持久保存在 VM2 SQLite outbox，Windows integration 每 2 秒通过现有面板管理员会话读取 `/api/panel/integration/usage-events`，完成事务去重后再 POST `/api/panel/integration/usage-events/ack`。确认响应丢失时可安全重拉；不会重试推理。此方向兼容 WSL NAT，无需开放新的管理端口或修改系统网络。integration 同时配置 `ES2API_USAGE_BRIDGE_ENABLED=true`。`usage_bridge.last_event_at`、`last_poll_at`、`last_error` 和账号 `automation` 提供运行诊断。

远程可直达部署也支持旧 push 模式：VM2 配置 `ES2API_USAGE_URL`（`/api/v1/admin/usage/success`）与 `ES2API_USAGE_TOKEN`。该模式内存队列最多 256 条，同一事件最多短时重发 3 次；进程退出或持续投递失败可能漏计。本地正式链路使用持久 pull 模式。

## 协议透传

`priority`、`fast`、`ultrafast` 同时支持请求头和 JSON 字段，适配层只保留原值，不改名、不降级。Responses HTTP 与 WebSocket 共用同一套槽位绑定和鉴权；WebSocket 帧由 VM2 原生 `/v1/responses` 处理。

## 当前验证范围

`integration/test/` 使用无供应商、无真实凭据的假 VM2 客户端验证生命周期、失败保留/重试、账号池与分组、加密持久化、ModelTrace 阈值/动作/取消/重启恢复和公开字段。真实 Docker、真实账号、固定公网出口、真实供应商调用和正式管理台接入仍需在部署环境单独验收。

## 启动配置

`node src/start.mjs` 要求：`ES2API_MANAGEMENT_TOKEN`（至少 32 字符）、`ES2API_DATA_KEY`（32 字节 base64url 或 64 位 hex）、`VM2API_BASE_URL`，以及 `VM2API_PANEL_TOKEN` 或用户名/密码。可选 `ES2API_DB_PATH`、`ES2API_BIND_HOST`、`ES2API_BIND_PORT`、`VM2API_API_KEY`（没有它时只能管理账号，不能执行真实 ModelTrace）。

ModelTrace 的 `VM2API_API_KEY` 必须等于目标 VM2 实例配置的 master `VM2API_API_KEY`（兼容别名 `KIN_API_KEY`），不能使用面板创建的普通托管 Key；只有 master Key 支持 `x-kin-vm` 固定槽位。用户名/密码会话遇到 401 时最多重新登录一次；403、网络失败和 token-only 配置不自动重放。

普通查询/登录超时 15 秒，生命周期请求默认 360 秒，可用 `VM2API_LIFECYCLE_TIMEOUT_MS` 配置 15000–900000 毫秒。首次拉取镜像可能超过 Go 管理代理的 110 秒：浏览器超时不代表操作停止，应刷新账号列表核实最终状态，不能重新导入同一账号。`/health` 仅证明本进程就绪，`vm2_configured` 仅表明推理 Key 已配置；VM2 连通需要独立调用其健康和管理接口验证。

## 发布到原生用户调用入口

完整管理员可调用 `POST /api/v1/admin/integration/groups/:id/publish`，传入已有 OpenAI 用户 `native_group_id` 和 `concurrency`（1–256），创建或更新一个原生 OpenAI APIKey 执行来源。`GET .../integration/publications` 查询脱敏映射，`DELETE .../groups/:id/publish` 停止新请求的原生调度。界面入口：账号池 → 管理分组 → 开放用户调用。发布不会迁移已有用户 Key，用户 Key 必须归属所选用户分组。

普通请求继续经过原生 Sub2API 的鉴权、分组/模型权限、余额/订阅限额、并发预留和用量计费。原生账号把 HTTP Responses、Chat Completions 或 Responses WebSocket 转发到 integration 私有 `/gateway/:group/v1/*`；该入口以 HMAC 派生的分组凭据鉴权，不使用完整管理令牌。gateway 在每个 HTTP 请求/WS 连接创建时取得真实账号池租约，按账号池规则选槽，以 master Key 固定 VM2 槽，并在结束、断流或断开时释放。客户端的任意固定槽与内部检测标记不会透传。WS 一条连接固定同一执行槽，最多占一个租约，断开才释放。Models 使用 VM2 本地目录，无推理采样。原生计费日志关联发布账号，具体执行槽用量由 VM2/integration 记录。

账号池 `pause/deprioritize` 在私有 gateway 每次选槽时立即生效。pull 控制通道还每 2 秒向 VM2 同步托管槽的暂停/降权规则，普通直连及固定槽请求也检查规则；已有在途请求继续完成。首次同步前，pull 部署拒绝普通 GPT 选槽；可信 master 内部 ModelTrace 仍可复检暂停账号。非托管 VM2 槽不应用账号池规则。撤回发布只阻止原生新调度，不撤销独立存在的 VM2 Key。

此接线完成源码与构建；依用户要求本轮未执行测试或真实用户计费/供应商验收，不能据此声称生产调用已验收。旧的原生直接转发账号仍沿用原先执行方式，不进入账号池自动检测。

## 账号池隔离边界（2026-11-02）

继续复用原版 VM2 的每槽容器、只挂载本槽 home/run、独立凭据/内核 socket 与固定出口。Docker 槽仍保留原版只读根目录、无额外 capability、no-new-privileges 和资源限制。此处描述的是与原版 VM2 多开一致的使用隔离，共享宿主内核；不描述成独立虚拟机或已通过安全验收。共用同一代理的槽仍可能共用出口网络，不保证每个账号具有不同公网 IP。创建后不改出口、时区和 IP 派生身份。

生命周期对 create 返回 ID、重试已有 ID、最终状态、sync 和 delete 均核对 canonical 槽 ID（es2-账号ID）；不匹配时拒绝导入、启动或删除。新建槽额外保存 integration_binding（所属账号、创建代次），查询时核对归属与代次；旧槽没有该字段时沿用 canonical ID 检查，不为补元数据重建真实容器。

Go 公开网关从已认证 API Key 的数据库 ID 派生私有 X-Es2api-Caller（HMAC），在账号头覆写之后设置，忽略客户端自报值。此头只发给发布的 integration 来源。HTTP、Chat Completions 和 WS 共用该调用者命名空间；原生 WS 连接池兼容键还包含调用者和会话，防止跨 Key 复用连接；新发布来源默认 passthrough 模式。

gateway_bindings 仅保存 Key/分组/会话/响应 ID 的哈希、账号/槽 ID、代次、账号实例指纹和到期时间。单个索引保留 24 小时，总量最多 200000，按分钟清理到期项；不保存提示词或响应正文。账号实例指纹包含创建时间与凭据指纹，删除后以同名重新导入不能接续旧实例。

带 session_id、conversation_id、thread-id、x-session-id 或 prompt_cache_key 的请求先找同一 Key/组内的会话绑定。previous_response_id 必须已在此命名空间见过，并且与会话属于同一槽/代次；不存在、跨 Key、重建、重导入或已迁出分组时失败关闭。绑定账号暂不可用/满并发时返回错误，不切换到其他账号。普通不带会话的首次请求仍由共享池选择；有 previous_response_id 时按响应归属选槽。出站 session/cache 标识进一步混入槽位、代次和账号实例，用户的同名会话不会直接传给供应商。

Responses JSON/SSE 只观察 response ID 进行归属登记，不更改回传正文。WebSocket 改用 ws 逐帧 JSON 桥接，在第一个 response.create 时选槽，一连接持一租约；后续 response.create 与 response.cancel 检查归属，禁止二进制和未知控制消息。上游握手/首帧等待 15 秒，空闲 15 分钟关闭；单帧 10MB、发送积压 8MB 上限，错误不自动重发推理。

旧请求产生的响应 ID 没有新隔离索引，升级后无法用这些 ID 继续；请发完整会话上下文并开始新会话。VM2 独立入口继续遵循其原生 Key/槽权限；以上新增调用者命名空间只覆盖 Sub2API 发布入口，完整管理员/master Key 仍有原本的跨槽管理能力。


## 同机控制进程协调（preview.19）

凭据、运行控制与完整恢复使用同一Linux flock控制作用域；Kernel/CLI宿主请求持共享活动锁，停止确认等待跨进程finalizer排空。争用失败保留原状态，不按PID/TTL清除claim或重放调用。所有控制进程需同时升级，锁文件不得删除。详见 [实例协调](../docs/SLOT_COORDINATION.md)。仅静态核对，未进行多进程、崩溃或真实账号行为验收。
