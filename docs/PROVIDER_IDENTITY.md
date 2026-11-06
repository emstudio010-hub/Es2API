# 供应商身份与一账号一工作区

## 当前支持的身份格式

账号池使用 `codex-legacy-v1` 适配器：仅接受现有固定 Codex public client，通过 OpenAI 固定 JWKS HTTPS 地址与 jose 6.2.15 验证 RS256 签名，核对 issuer、资源 audience、client_id、sub、时间字段和旧版已签名 workspace。提供 ID token 时，还核对其签名、client audience、sub 和已有 workspace 字段与 access token 一致。导入文档的账号 ID 提示若与已签名 workspace 不同则拒绝；邮箱不参与去重。

固定 CLI 0.155.1 的 [token_data.rs](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/login/src/token_data.rs) 将 chatgpt_account_id 定义为组织/workspace 标识。本适配器仅针对该旧版格式，不推断其他认证 metadata 的含义，也不应用于新动态 OSS 注册。

[OpenAI Docs 注册说明](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) 要求验证签名、issuer、预期 client audience、期限和登录 nonce，并指出 sub 与邮箱不是 workspace。新 OSS 流程应保留注册获得的 client ID；[其 token metadata 是 opaque](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)。本版不迁移该流程，不把输入 token 自带 audience 当成可信配置。

## 去重与保留数据

去重键是已验签 issuer、固定 client、sub、workspace 的组合哈希，不保存原始身份值到身份索引，不以 token 指纹代替稳定身份。相同用户在不同已签名 workspace 中保持独立；同一用户与 workspace 的新 token 不能创建第二个池。

新导入先在 SQLite 事务外验签，再为存量尚未占位的账号验签；存量绑定用凭据指纹 CAS。新账号、分组、身份唯一键和幂等记录在同一事务内提交，并在分配执行资源前占位。并发重复身份由数据库 UNIQUE 拒绝，不能靠更换本地账号 ID、代理或 token 绕过。请求 JSON 不能自填验签结果，进程内 proof 还绑定原 token 字节与 workspace 提示。

存量格式不全、密钥暂不可用或发现历史重复时，保留账号、凭据、槽与出口，不自动合并/删除；不能确认所有存量身份时停止新增工作区。仅 refresh token、缺少可验证 access token 或新的动态注册格式需要先补全对应凭据或适配，不能猜测身份。启动只迁移索引结构，不联网验签、不换 token。网络验签发生在明确导入/交接/维护操作中。

失败创建或删除未确认的账号继续占有身份；只有原槽删除确认且账号记录实际删除后才释放。重建交接在保存新凭据和删除旧槽前，验签旧凭据与 checkpoint，要求稳定身份相同，同时保留槽、代次、指纹 CAS。

## 这不是登录或权限验证

这是管理侧的历史已签名身份绑定，不是新的 OIDC 登录。已过期 access/ID token 可用于历史身份去重，但不被视为有效登录、活跃会话、额度或模型权限。文件导入没有待验证的登录 nonce；本模块不能替代浏览器登录的 state/nonce/PKCE 检查。

JWKS 请求只获取公开密钥：固定 URL，无 token/账号/workspace 参数，不跟随重定向，5秒超时、10分钟缓存与未知 kid 冷却刷新。错误仅返回固定码，不调用模型或刷新 OAuth。

## 验收边界与后续

当前专用账号做过只读真实签名核对，未改凭据或调用模型。语法/模块加载、迁移与健康检查不等于并发导入、轮换、混配或删除/重建验收；按用户要求没有运行测试。

签名核对绑定可见 access/ID token，不能证明不透明 refresh token 与它们同属一个账号。管理侧 checkpoint 核对原身份；宿主主动刷新增加 [加密日志、前后签名比较与本地恢复](REFRESH_RECOVERY.md)，先保存轮转响应再验签/提交，失败保留日志并阻止再次换票。第三方 Kernel 内部自行刷新到 checkpoint 之间的完整身份锁定仍需补齐。真实 CLI→API 连接失败与其他验收缺口仍独立存在。
