# Sub2API 前端接入 Integration

现有 Sub2API 前端通过同源 `/api/v1/admin/integration/*` 访问独立账号池服务。Go 后端复用原有管理员鉴权、用户限流、审计和合规中间件；未登录返回 401，非管理员返回 403。浏览器使用原有管理员 JWT，不能持有 Integration 管理密钥。

## 后端配置

仅在运行 Sub2API Go 服务的环境中设置：

```dotenv
ES2API_INTEGRATION_URL=http://127.0.0.1:8082
ES2API_MANAGEMENT_TOKEN=<与 integration 服务一致的管理密钥>
```

URL 必须是纯 HTTP(S) origin（不带用户名、密码、路径、查询或片段）；容器部署应改为受控内部服务地址。修改配置后重启 Go 服务。缺少或无效配置返回 `503 integration_not_configured`，错误信息列出所需变量名，不含变量值。

不要设置 `VITE_ES2API_MANAGEMENT_TOKEN`，不要在 Vite 中给公网无鉴权请求注入管理密钥。开发时 Vite 仅把原有 `/api` 请求转发到有正常管理员鉴权的 Go 后端；Integration 监听私有网络。

## API 契约

代理删除路径中的 `/integration`，例如 `GET /api/v1/admin/integration/accounts` 对应 `GET /api/v1/admin/accounts`。查询字符串、请求 JSON 和 `Idempotency-Key` 保持原样。响应为 Integration 原生包络：

```json
{"ok":true,"data":{}}
```

```json
{"ok":false,"error":{"code":"error_code","message":"可读错误"}}
```

前端应单独解包该格式；不能假设它是 Sub2API 的 `code/message/data` 格式。原有客户端若已经自动取出 `.data`，仍需兼容这一行为，并读取 `error.message` 展示错误。

允许的管理路由（以下相对 `/api/v1/admin/integration`）：

| 方法 | 路径 |
| --- | --- |
| GET / POST | `/accounts` |
| GET / PUT / DELETE | `/accounts/:id` |
| POST | `/accounts/:id/retry`、`/accounts/:id/retry-delete`、`/accounts/:id/sync` |
| GET / POST | `/groups` |
| PUT / DELETE | `/groups/:id` |
| GET | `/pool/stats` |
| GET / PUT | `/modeltrace/config`、`/modeltrace/bank` |
| GET | `/modeltrace/summary`、`/modeltrace/runs`、`/modeltrace/runs/:id` |
| POST | `/modeltrace/run`、`/modeltrace/runs/:id/cancel` |
| GET / PUT | `/accounts/:id/modeltrace` |
| POST | `/accounts/:id/modeltrace/reset-action` |

调度 acquire/release、usage/success、health 以及其他路径不对浏览器开放。资源 ID 不接受路径分隔符、百分号、控制字符、查询/片段分隔符或 `.`/`..`。现有受限管理员密钥仍按原规则默认拒绝未获授权的路由。

## 错误与边界

- 普通上游状态码和 JSON（例如 201、202、400、404、409、422、429、500）原样保留。
- 上游 401/403 转成 `502 integration_auth_failed`，提示检查服务端管理密钥，避免错误地注销当前管理员；本地管理员鉴权 401/403 保持原有行为。
- 连接失败返回 `502 integration_unavailable`；超时返回 `504 integration_timeout`。代理总超时 110 秒，前端生命周期操作超时应略长（例如 120 秒）。
- 代理不主动发起应用层重试。账号导入重试应重用相同 `Idempotency-Key`，避免因浏览器超时重复创建。
- 请求体上限 10 MiB；响应上限 16 MiB；Idempotency-Key 上限 256 字节。
- 不跟随上游重定向，3xx 转成 `502 integration_redirect_blocked`。浏览器 Cookie、Authorization、x-api-key 不转发给 Integration，只有服务端专用管理 Bearer token。账号导入请求体整体从操作审计中省略，防止 `auth_json` 字符串内嵌凭证泄漏。
- 仅保留响应的 X-Request-ID 和 Retry-After；不透传 Set-Cookie、Location、CORS 等头，所有代理响应 `Cache-Control: no-store`。

以上测试使用本地 HTTP fixture 和合成身份；不代表真实 VM2、Docker 或供应商调用已经验收。

## 前端开发与本地演示

前端目录为 `../sub2api/frontend`，依赖使用现有锁文件与 pnpm 10：

```powershell
npx --yes pnpm@10.34.8 install --frozen-lockfile
npx --yes pnpm@10.34.8 run build
```

本机全局 pnpm 11 不再读取 `package.json` 的 `pnpm.overrides`，不能直接用它重新安装本项目；不要为通过安装而重写锁文件。

功能入口是 `/admin/account-pool` 和 `/admin/modeltrace`。账号池导入只在表单内存保留 OAuth；关闭、成功或卸载时清空。导入结果不确定时应先刷新账号列表，再在同一账号上重试槽位操作。ModelTrace 手动检测使用已保存策略，未保存草稿不会参与；文本相似度结果只是候选证据。

`test/frontend-preview.mjs` 是可选的本地 UI 夹具：只绑定 `127.0.0.1:18082`，使用内存 SQLite、假 VM2 生命周期与假采样器，不读取配置密钥和生产数据库，也不会请求供应商。它并不验证 Go 的真实登录和代理部署；后者由独立 Go 契约测试覆盖。

在本目录运行 `node test/frontend-preview.mjs`，再在前端目录运行：

```powershell
$env:VITE_DEV_PROXY_TARGET='http://127.0.0.1:18082'
.\node_modules\.bin\vite.cmd --host 127.0.0.1 --port 3001 --strictPort
```

浏览器打开 `http://127.0.0.1:3001/login`，夹具账号为 `preview@example.test`、夹具密码为 `preview-only`。仅在此内存演示中使用这些合成值；检查结束后对两个命令按 Ctrl+C。页面数据重启即重置。
