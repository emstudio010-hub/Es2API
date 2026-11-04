# Es2API v2026.11.04-preview.16

本版补API端点工具管线和API/OAuth路由边界。

## 修改内容

- API类别密钥调用GPT模型进入API端点调度，不再提前进入OAuth/Codex账号池；原平台/分组/租户和密钥限流门仍执行。
- Chat及Responses工具输入经明确的内部类型进入现有before_upstream、协议拦截、身份及提示词链，保留custom原始字符串、grammar/text格式、选择、function原始arguments和工具结果；输出只从策略处理后的内容构建，不另传原始请求。
- OpenAI端点恢复对应Responses工具类型；Anthropic端点明确拒绝custom，function原文须可解析成对象。API Responses对旧响应引用、加密reasoning、未知输入/宿主工具等不能表达的内容明确报错，Chat未知音频/文件等不静默丢弃。
- 已生成的非流式Chat/Responses结果直接按该协议返回，修正外层再次当Anthropic转换导致内容/工具丢失；保留客户端用量隐藏处理，规范function strict不丢失。
- SSE逐块使用UTF8解码器，避免网络块边界损坏工具原文；完成状态须有类型与状态一致的终止帧，截断不算完整推理，Chat正常终止不重复写[DONE]。

详见 [Codex CLI后端及协议](CODEX_CLI_BACKEND.md)。这属于API端点适配，不为容器CLI新增工具执行能力；容器CLI仍为文本exec，现有账号继续Kernel，未迁移或重分配IP。

## 发行与验收

Linux附件 Es2API-linux-x64-20261104-r16.tar.gz 和 .sha256。前端、Go、Kernel及固定CLI二进制沿r15，未重编译。只做语法、模块加载、脚本AST/bash、源码/依赖/许可/哈希及只读健康清点。按用户要求不运行测试、行为用例、真实推理/刷新/导入迁移、实例生命周期、浏览器或Linux安装验收。

当前官方Chat流工具delta只定义function，因此custom输出继续明确报不支持，使用非流式Chat或Responses；不把custom伪装为function。API工具输入/路由/拦截与输出修正尚未用真实端点验收，不据源码宣布端到端成功。真实CLI→API/用量、退出/取消/恢复、隔离、ModelTrace历史502与Linux安装仍未闭环，HTTPS暂缓。
