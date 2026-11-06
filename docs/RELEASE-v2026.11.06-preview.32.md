# Es2API v2026.11.06-preview.32

## Codex 最近执行摘要

- 为每个托管 CLI 槽保存最近一次已进入准备流程的阶段、固定诊断分类、字节/事件计数、usage存在性和退出确认摘要。
- 不保存原始stderr、正文、凭据、代理地址、argv、路径或nonce；按完整槽快照绑定账号/代次/容器与实际固定出口，旧身份记录不展示。
- VM2槽状态的可空cli_execution接通integration白名单；没有新执行就保持null，不伪造过去失败的根因。
- DNS和连接超时增加固定分类；后来的通用错误不覆盖具体信号。Docker客户端根本未生成宿主进程时释放未使用占用，实际已启动执行仍依赖nonce回执。

详见 [CLI后端与摘要](CODEX_CLI_BACKEND.md)。摘要是本机观察，不是完整根因、供应商认证或独立进程证明，不改变重试、出口、模型、调度或计费策略。

## 验收边界

本版仅源码审查、语法/模块加载、只读状态/健康与归档核对；没有模拟摘要、CLI执行、故障注入、测试套件或新增模型调用。现有槽位cli_execution预期为null，不能据此宣称新记录分支或退出分支已通过行为验收。历史Luna调用仍HTTP502/codex_cli_connection_failed，无有效正文/usage；真实CLI→API尚未跑通。

主程序、UI、Codex CLI和Kernel沿用r30，更新可独立加载的Node源码及文档。现有自动SOCKS健康监控保留，服务启动/定时器可能正常探测；没有手动触发专用DNS/TLS诊断。prepared未知结果处置、第三方Kernel内部刷新、完整跨进程生命周期/caller计费及Linux安装/UI/生产验收仍待完成；HTTPS暂缓。

Linux包：Es2API-linux-x64-20261106-r32.tar.gz 及 .sha256，不含用户runtime、数据库或私密日志。
