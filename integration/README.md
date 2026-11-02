# Es2API 集成层

这里放控制面与执行面的适配器、账号池/租赁生命周期、ModelTrace 任务和不依赖真实供应商的回归测试。启动与 API 约束见 [CONTRACT.md](./CONTRACT.md)。任何新增适配都要明确输入、输出、鉴权、超时、重试和生命周期语义。

## 接口速查

管理接口统一使用 `Authorization: Bearer <ES2API_MANAGEMENT_TOKEN>`；`GET /health` 为公开探针。账号导入的 `credential` 只接受 ChatGPT OAuth 凭据，响应只返回 token 存在性和指纹。

| 范围 | 主要接口 |
| --- | --- |
| 账号池 | `GET/POST /api/v1/admin/accounts`、`GET/PUT/DELETE /api/v1/admin/accounts/:id`、`POST .../:id/retry`、`POST .../:id/retry-delete`、`POST .../:id/sync` |
| 分组 | `GET/POST /api/v1/admin/groups`、`PUT/DELETE /api/v1/admin/groups/:id` |
| 调度租约 | `POST /api/v1/admin/pool/acquire`、`POST /api/v1/admin/pool/release`、`GET /api/v1/admin/pool/stats` |
| ModelTrace | `GET/PUT /api/v1/admin/modeltrace/config`、`GET/PUT .../bank`、`POST .../run`、`GET .../runs` 与 `GET .../runs/:id`、`POST .../runs/:id/cancel`、`GET/PUT /api/v1/admin/accounts/:id/modeltrace`、`POST .../accounts/:id/modeltrace/reset-action` |
| 用量触发 | `POST /api/v1/admin/usage/success`、`GET /api/v1/admin/modeltrace/summary` |

账号池的生命周期顺序固定为“创建空槽（此时选择固定出口）→ 导入凭据 → 启动 → 健康确认”；VM2 根据创建时出口计算槽位时区和 IP 派生身份。创建后 IP、指纹和时区不可修改；更换出口必须删除并重新导入。失败会保留账号和已知槽位，重试沿用账号 ID，绑定重建会递增 `provision_generation`。删除只有在 VM2 确认槽位不存在后才删除本地凭据。ModelTrace 在采样期间发现执行槽、凭据指纹、出口、策略或参考库发生漂移时，会保存结果但跳过账号动作。

## 在管理台导入 OAuth

进入“账号池 → 导入账号”，可选择粘贴 OAuth JSON，或使用“浏览器 OAuth 登录”。浏览器模式生成 OpenAI 授权链接后，由操作者登录并授权，再粘贴完整回调地址或授权码，点击“完成授权并导入”。OAuth 兑换复用 Sub2API 的 `/api/v1/admin/openai/generate-auth-url` 和 `/api/v1/admin/openai/exchange-code`，不会在旧账号管理中额外创建账号。所选 VM2 出口 ID 仅随账号池创建请求提交，不传给 OAuth 接口。

回调 state 必须匹配当前授权会话；重新生成链接会清除旧授权码。兑换成功后直接导入 integration 账号池；若导入暂时失败，同一弹窗可重试导入，无需再次兑换已消费的授权码。关闭、切换凭据模式或离开页面会清空 OAuth 临时状态，旧请求返回后不会继续导入。凭据不会写入浏览器持久存储或显示在错误提示中。

运行：

```text
npm test
node src/start.mjs
```

测试不会读取生产数据库、真实凭据或调用供应商。`start.mjs` 只在配置齐全时启动，未配置 VM2 推理 API Key 时仍可提供账号池管理，但手动/自动 ModelTrace 会记录为执行器未配置。

SQLite 迁移范围和上线前备份要求见 [MIGRATION_AUDIT.md](./MIGRATION_AUDIT.md)。

## ModelTrace 数字指纹

2026-11-02 隔离增量：每个会话按已认证用户 Key、分组、账号实例与创建代次固定槽位；response/item 引用均核对归属，绑定失效不静默换号。HTTP/SSE 与逐帧 WebSocket 共享 SQLite 哈希索引（24 小时、最多 200000 项）。新依赖 ws 8.22.1 由 package-lock.json 锁定，部署先执行 npm ci --ignore-scripts。旧响应 ID 未被索引，升级后需要开始新会话。完整规则见 CONTRACT.md 的账号池隔离章节。未执行测试或真实推理验收。

账号池现在可经 Sub2API「管理分组 → 开放用户调用」发布到原生 OpenAI 用户分组，公开调用使用原生用户 Key 和计费权限，私有 gateway 完成选槽/释放及 HTTP、SSE、WebSocket 转发。暂停/降权另通过 pull 控制通道同步 VM2。接线契约见 [CONTRACT.md](./CONTRACT.md#发布到原生用户调用入口)，运维命令见 [../deploy-local/README.md](../deploy-local/README.md)。2026-11-02 本轮依用户要求未运行测试或真实推理，不能以源码和构建代替生产验收。

模型智商控制台支持按次数、固定分钟、次数或时间、次数且时间、有调用才定时、概率抽检、空闲后首次调用 7 种自动触发方式，以及手动检测。10 个草稿预设覆盖每 5/10/30 分钟等常用设置，可自定义分钟和完成后的最短间隔。选择预设后保存才生效；未选择新策略的旧账号保持原行为。字段与冷却、去重语义见 [CONTRACT.md](./CONTRACT.md#用户调用后的自动检测)。

未导入自定义库时，服务自动读取内置 CPA / LM Fingerpoint Detector（固定 CPA `4f836764` 版本），包含 60 个候选模型和 36 道原始挑战。每次选择 3 道不同挑战，通过账号绑定的 VM2 槽发出 3 个独立 Responses 请求，不重试失败样本。算法、检测器数据、许可与 SHA-256 来源记录在 `resources/modeltrace/PROVENANCE.md`。此版本将 `gpt-6.1-sol` 映射到 `gpt-6-astra` 候选类，无法区分两者。结果是候选集内概率，不是模型身份或智力保证。

已有管理员文本库会继续使用文本相似度比较，并在页面标明方法。摘要与账号策略接口中的 `readiness` 会列出执行器、模型、采样数和执行槽的阻断；未就绪时不会发送采样。实时历史逐个保存样本哈希、长度与用量，原始回答不入检测记录。取消操作即使和最后一个响应同时返回，也不会执行账号动作。

真实验收脚本（不会导入账号，不会修改策略，不会自动重发）：

```powershell
node deploy-local/modeltrace-live.mjs --account=ACCOUNT_ID
node deploy-local/modeltrace-live.mjs --account=ACCOUNT_ID --execute-once
node deploy-local/modeltrace-live.mjs --account=ACCOUNT_ID --run=RUN_ID
```

脚本要求所选账号已经关闭自动检测、动作设为 observe、采样数为 3。第一次命令只预检；`--execute-once` 只提交一次。提交网络异常时先查历史，不要直接重跑；已知任务用 `--run` 观察即可。脱敏证据写入 `runtime/verification/modeltrace-live-*.json`。该脚本走 integration 原生管理 API，不能作为 Sub2API 界面合规门或浏览器验收的证据。
