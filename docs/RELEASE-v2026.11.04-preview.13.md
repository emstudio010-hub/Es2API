# Es2API v2026.11.04-preview.13

本版继续补协议输入和跨轮隔离边界。

## 修改内容

- Kernel Chat补齐custom工具定义/指定与allowed_tools选择：Chat嵌套结构转为Responses平铺结构，grammar由嵌套转为平铺，保留原始input、format和function strict。
- 历史assistant工具调用按call id记录类型，tool结果生成对应function_call_output/custom_tool_call_output；未知、重复、矛盾ID及缺失custom input明确拒绝，不丢弃或猜成function。保留assistant refusal、parallel_tool_calls和service_tier。
- API账号在调度/供应商调用前拒绝多choice；其Anthropic中间格式无法保留custom原文，因此明确api_bridge_custom_tool_unsupported。API Responses桥接改用共享历史转换，保留规范function调用和结果，异常历史在上游调用前报错。
- WS每轮首次response id先在事务中独占登记，拒绝当前caller/group范围内24小时索引里已知响应；同一连接另保留最多4096个ID摘要，不复用旧ID，满额关闭连接。双重ID矛盾、无身份的输出帧报协议错。

详见 [Codex CLI后端](CODEX_CLI_BACKEND.md)。旧账号仍使用Kernel，未迁移CLI；账号、独占IP、凭据和设置不改写。无新推理重试，无数据库结构变更。

## Linux与验收

附件 `Es2API-linux-x64-20261104-r13.tar.gz` 和 `.sha256`，参照 [Linux说明](../deploy-linux/README.md) 备份后升级。沿用r12前端、Go、Kernel和CLI0.155.1/Undici8.12.3。

只做语法/模块加载、文件/源码/许可/哈希核对及只读健康清点，不运行测试、真实推理/刷新/导入/迁移/实例生命周期、浏览器或Linux安装验收。CLI仍为文本exec，不因Kernel支持custom就具备CLI工具执行能力。API账号custom仍属明确不支持；流式Chat custom沿r12明确报错，非流式Chat/原生Responses支持的输出范围沿用。WS取消确认不证明容器退出，索引过期后跨连接不提供无限期重放识别。真实CLI→API、usage/取消/隔离、ModelTrace历史第三样本502与长期生产尚未闭环，HTTPS暂缓。
