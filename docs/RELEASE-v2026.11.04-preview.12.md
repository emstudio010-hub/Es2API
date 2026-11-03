# Es2API v2026.11.04-preview.12

本版补流式Chat语义、WS每轮并发与结果记账。

## 修改内容

- 流式Chat改用独立有界状态，正文/refusal/function参数分别传递并与最终输出核对，稳定唯一id/created/model；缺少终止、前缀冲突或未知可见输出不能成功，保留已知用量。
- 明确completed才正常stop/tool_calls，已知截断映射length/content_filter；custom流式按当前官方Chat schema明确报不支持，保留非流式Chat/Responses路径，不伪装function，不输出非标准reasoning_content。
- Kernel和API账号的Chat流在EOF收尾，API账号非流式也用共享Chat适配；Kernel入口明确拒绝n不等于1，CLI允许显式n=1，原始/执行参数能力校验仍保留。
- WebSocket按每个response.create申请租约，终止帧及其之前消息的本机send回调成功后才释放结果，空闲连接不占并发；每轮重入分组/账号/代次/指纹及引用隔离门，固定原账号，不故障切换。
- WS每轮15分钟预算；response.cancel/interrupt校验当前目标并转换为VM2的interrupt。确认帧写出或10秒到期关闭连接并记取消，不将确认当执行退出或成功；关闭、超时、协议/写出失败均清理活动租约。

详见 [Codex CLI后端](CODEX_CLI_BACKEND.md)。现有账号/IP/密钥/指纹算法不改写，已有账号继续使用Kernel；数据库结构不变，没有新增推理重试。

## 分发与验收

Linux附件 `Es2API-linux-x64-20261104-r12.tar.gz` 和 `.sha256`，参照 [Linux说明](../deploy-linux/README.md) 备份后升级。沿用r11前端/Go/Kernel、固定CLI0.155.1及Undici8.12.3。

仅语法/模块加载、源码/包/许可证/哈希和只读健康清点；不运行测试、真实推理/刷新/导入/迁移/实例生命周期、Linux安装或浏览器验收。本机send回调不证明远端已读，关闭上游连接不证明容器执行已退出。CLI仍为文本exec，不新增CLI工具执行。真实CLI→API/usage/取消/隔离、长输入与ModelTrace历史502尚未验收；HTTPS暂缓。
