# Es2API v2026.11.04-preview.11

本版补非流式 Chat 协议和账号池网关长等待。

## 修改内容

- Kernel/CLI 共用非流式 Chat Completion 转换，保留文本、refusal、function/custom 工具调用、URL引用和真实用量；工具结束为tool_calls，明确的输出上限/过滤分别为length/content_filter。
- 不可表达的输出/引用、无效输出或未明确结束的响应返回脱敏结构化502，保留已知用量；转换失败不再先记录成功或触发ModelTrace成功计数。
- 私有执行转发使用固定Undici 8.12.3独立dispatcher，响应头/正文空闲预算显式15分钟，总预算仍15分钟、连接10秒；取消信号、背压和完成检查沿用，不修改全局fetch或增加推理重试。
- 停服排空后关闭dispatcher；Linux包含锁定依赖与MIT许可，打包时强制核对版本和许可证。

详见 [Codex CLI 后端](CODEX_CLI_BACKEND.md)。当前已有账号继续使用Kernel，账号、IP、密钥、数据库结构和指纹算法不变。

## 分发与验收

Linux附件为 `Es2API-linux-x64-20261104-r11.tar.gz` 和 `.sha256`，参照 [Linux说明](../deploy-linux/README.md) 备份后升级。沿用r10前端/Go/Kernel及CLI 0.155.1；新增依赖随包分发。

仅进行语法/模块加载、依赖/许可证、源码/包/哈希核对与只读健康清点，不运行测试或真实推理、刷新、导入、迁移、实例生命周期、Linux安装和浏览器验收。15分钟为集成网关预算，不保证其他代理和客户端都允许相同等待；队列/健康阶段的SSE保活没有新增。流式Chat转换仍走既有路径，未在本版重做。真实CLI→API、用量、长等待/取消/隔离及ModelTrace历史502仍未验收。
