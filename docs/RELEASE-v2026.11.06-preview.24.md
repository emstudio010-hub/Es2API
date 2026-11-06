# Es2API v2026.11.06-preview.24

## 一账号一工作区：已签名供应商身份去重

- 为固定旧版 Codex public client 增加 codex-legacy-v1 适配器，使用 jose 6.2.15 与 OpenAI 固定公开 JWKS 验证签名、issuer、预期 audience/client、sub 和旧版已签名 workspace；不按邮箱或未验签 JWT 合并账号。
- 以用户与 workspace 的稳定组合哈希建 SQLite 部分唯一索引；导入验签在事务外，身份占位、账号/分组和幂等记录在原事务内提交，先占位再分配槽与 IP。
- 存量账号以凭据指纹 CAS 绑定身份。不能确认身份或发现历史重复时保留原记录、凭据和槽，拒绝新增工作区；不会自动合并或删除。
- 旧槽重建 checkpoint 在提交新凭据与删除旧槽前核对旧/新签名身份及原槽、代次、指纹，身份不符即停止重建。
- JWKS 只请求固定公开地址，不携带 token、用户或 workspace 参数，不跟随重定向；错误使用固定脱敏码。新依赖及其 MIT 许可随 Linux 包分发。

## 范围与当前部署

这是历史已签名身份绑定，不是新的登录、额度或模型权限验证。过期 token 可用于历史去重；refresh-only 与新动态 OSS client 格式暂不支持。固定 CLI 0.155.1 的旧流不套用新动态注册的 metadata 语义。详见 [身份说明](PROVIDER_IDENTITY.md)。

本机先完整备份，再为现有一个账号完成真实签名核对和身份占位；原凭据、槽、出口和设置未改。没有运行行为测试、OAuth 刷新或模型推理；二进制沿用既有产物。

验签不能证明不透明 refresh token 的账号归属；CLI/第三方 Kernel 自行刷新到 checkpoint 之间的完整身份锁定仍需补齐。并发导入、轮换、故障和删除重建均未行为验收。2026-11-04 授权的单次 gpt-6-luna 调用仍为 HTTP502/codex_cli_connection_failed，无有效正文与 usage，未重试。本版不能视作真实 CLI→API 已跑通。

完整 Go caller/Key/分组/计费、跨账号隔离、生命周期并发/崩溃、自动 IP 分配、ModelTrace 与 Linux 安装/生产验收仍未全部闭环，HTTPS 暂缓。发布内容不含用户 runtime、数据库或私密操作证据。

Linux 附件：Es2API-linux-x64-20261106-r24.tar.gz 及 .sha256。
