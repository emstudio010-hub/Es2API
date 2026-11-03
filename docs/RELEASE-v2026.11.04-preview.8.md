# Es2API v2026.11.04-preview.8

本版修补 Codex CLI 请求转换和 Chat 用量、失败事件回传。

## 修改内容

- CLI 使用独立参数转换，绕开 Kernel 的字段裁剪和推理强度归一化；保留 minimal 等已允许值，原始请求与实际执行请求仍各自校验。
- 会话 rebuild 模式不再向临时 CLI 请求注入 prompt_cache_key，避免通过入口校验后在执行层被拒绝。调用者显式缓存键仍返回不支持。
- Chat 流式/非流式保留上游实际提供的 reasoning_tokens；未提供时不填零，不重复加到总量或计费输出。
- Chat SSE 收到 failed/incomplete/cancelled/error 时发送错误及 DONE，保留已有真实用量，不伪造 stop 成功。

详见 [Codex CLI 后端](CODEX_CLI_BACKEND.md)。Kernel 原有参数转换不变；历史账号没有迁移或重建。

## 分发与验收

Linux 附件为 `Es2API-linux-x64-20261104-r8.tar.gz` 和 `.sha256`，参照 [Linux 说明](../deploy-linux/README.md) 备份后升级。沿用 r7 前端/Go/Kernel 和固定 CLI。

仅语法、模块加载、源码/包核对与只读健康清点；不运行测试或真实账号推理、刷新、导入、实例生命周期操作、Linux 安装及浏览器验收。真实 CLI→API、取消/超时、隔离、长输入与 ModelTrace 历史 502 尚未验收。
