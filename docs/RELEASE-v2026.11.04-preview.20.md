# Es2API v2026.11.04-preview.20

修复真实 Codex CLI 的两个本地启动障碍。

- CLI 0.155.1 禁止重定义内置 openai provider。使用唯一的 es2api_codex provider，固定 ChatGPT Codex Responses 地址及 OAuth 认证；请求和流重试均为0，额外禁用 unbounded_connection_retries。
- 健康检查除固定版本外，用与执行相同的参数运行 features list；仅解析启动配置，不创建推理。
- 请求配置、短期认证副本、HOME 和工作目录放入本账号容器 /tmp 的0700临时目录，避免 Windows 挂载目录上的 app-server 初始化权限错误。挂载目录只保留控制/心跳/退出回执。进程组排空后删除临时目录，再写回执；清理失败不写成功退出确认。/tmp 继续使用原32MiB noexec/nosuid tmpfs，不放宽容器权限。

## 实际验证边界

用户授权删除旧账号后，已备份并删除旧账号和槽，新 OAuth 独占绑定释放的出口，新 Codex CLI 工作区就绪。发起的 gpt-6-luna API 调用返回502/codex_cli_incomplete、CLI exit1，没有正文或有效用量；没有自动重试。初次启动配置失败另有独立记录。不能声称真实 CLI→API 已跑通，也不能据此判断账号能否使用该模型。

无凭据、供应商地址强制指向关闭的127.0.0.1端口的离线诊断，复现挂载目录EPERM，修复后能启动到连接阶段、写退出回执、清空临时运行目录；没有额外供应商推理。未跑常规测试、完整调用者/计费入口、跨账号隔离、取消恢复、Linux安装或浏览器验收。HTTPS暂缓。

Linux附件 Es2API-linux-x64-20261104-r20.tar.gz 和 .sha256。不含用户数据、OAuth、代理凭据、runtime或备份；UI/Go/Kernel/固定CLI二进制沿r19。
