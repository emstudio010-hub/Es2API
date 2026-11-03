# Es2API v2026.11.04-preview.10

本版修补账号池网关到 CLI 的请求适配、长等待保活和完成判断。

## 修改内容

- 账号池网关按账号后端构造请求：CLI 不再被注入不支持的 prompt_cache_key；HTTP/WS 共用，显式调用者字段仍留给能力校验。
- CLI 流式执行阶段每10秒发送 SSE 注释保活；非流式不写保活，快速失败保留HTTP状态，保活后失败发错误事件，不把保活记成文本/用量或完成。
- 网关增加有界 UTF-8/JSON/SSE 完成观察，支持跨分块/多行data与保活；Responses需实际completed，Chat SSE需所有选择终止及DONE，200/部分文本/用量不能独立证明成功。
- HTTP响应写出finish后才释放成功租约；明确失败帧正常转发并记失败，缺失完成或格式/UTF-8/帧截断不判成功，客户端断连与网关超时分别记录。

详见 [Codex CLI 后端](CODEX_CLI_BACKEND.md)。不改变现有账号、密钥、固定出口和后端，不新增推理自动重试。

## 分发与验收

Linux 附件为 `Es2API-linux-x64-20261104-r10.tar.gz` 和 `.sha256`，参照 [Linux 说明](../deploy-linux/README.md) 备份后升级。沿用 r9 前端/Go/Kernel 和固定 CLI。

仅 Node 语法/模块加载、Python AST、源码/包核对与只读健康清点；不运行测试或真实账号推理、刷新、导入、实例生命周期、Linux 安装及浏览器验收。真实 CLI→API、保活/断连/完成观察、跨账号隔离、长输入和 ModelTrace 历史502仍未验收。
