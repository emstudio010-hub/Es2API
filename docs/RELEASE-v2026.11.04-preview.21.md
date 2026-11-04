# Es2API v2026.11.04-preview.21

修复 CLI 模型元数据警告被误当成工具执行、立即取消请求的问题，并补充脱敏失败原因。

- 固定CLI0.155.1把非致命警告表示为item.completed/error。适配器只忽略与本次模型严格匹配的已观察metadata fallback文案；其他错误条目、真正error/turn.failed、未知工具继续失败。
- model rerouted通知以codex_cli_model_rerouted停止请求，不按原请求模型冒充成功，不主动切换模型。
- CLI错误事件及最多8192字符的临时stderr按固定规则归类：启动配置、app-server初始化、空间不足、OAuth拒绝、额度/频率、模型不可用、TLS、代理认证、连接失败。仅返回固定错误码/中文提示，不保存或回显原始诊断/路径/URL/凭据/上游正文。分类是诊断线索，不是精确根因证明。
- 只有实际失败才采用stderr分类；警告不能单独推翻完整成功，也不能代替正文、usage、exit0及退出回执。已有取消/超时、输出上限、模型及重试策略保留。

## 依据与边界

OpenAI Docs说明exec --json输出结构化JSONL；固定rust-v0.155.1的exec_events.rs将ErrorItem定义为非致命条目，event_processor_with_jsonl_output.rs的collect_warning返回Running。上轮无凭据、关闭loopback端点的CLI输出已经观察到具体metadata警告，本轮依据此证据修复，不运行新测试或额外供应商推理。

历史专用gpt-6-luna调用仍为HTTP502/exit1、无有效正文或usage；修复后的真实成功尚未验收。完整caller/计费、生命周期/取消恢复、Kernel跨进程bootstrap唯一性、跨账号隔离、Linux安装与生产验收仍缺，HTTPS暂缓。

Linux附件Es2API-linux-x64-20261104-r21.tar.gz及.sha256；不包含用户数据和私密runtime。UI/Go/Kernel/固定CLI二进制沿r20。
