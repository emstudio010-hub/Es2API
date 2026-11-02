# 额外的 Google OAuth 客户端配置

公开版去除了上游内置 Google OAuth 客户端 ID 和 secret。这些变更影响原生 Antigravity / Gemini CLI 授权入口，不修改 ChatGPT OAuth 账号池。

部署者应使用自己有权使用的 Google OAuth 客户端，并确认应用、授权范围、重定向 URI 和供应商服务允许相应用法。本仓库不提供共享客户端，也不把示例占位符作为可用凭据。

| 路径 | 配置 |
| --- | --- |
| Antigravity | `ANTIGRAVITY_OAUTH_CLIENT_ID`、`ANTIGRAVITY_OAUTH_CLIENT_SECRET` |
| Gemini CLI 环境回退 | `GEMINI_CLI_OAUTH_CLIENT_ID`、`GEMINI_CLI_OAUTH_CLIENT_SECRET` |
| Gemini 自定义客户端 | 原控制面的 Gemini OAuth `client_id` / `client_secret` 配置，两项同时提供 |

环境变量应在服务启动前配置，修改后重启。不要把值提交到 Git 或 Issue。systemd 部署可使用受限权限的本机环境文件配合服务 drop-in：

```ini
[Service]
EnvironmentFile=/etc/es2api/oauth.env
```

由管理员在服务器创建该文件，权限设置为仅 root 可读；设置变量后执行 `systemctl daemon-reload` 与 `systemctl restart es2api`。Linux 启动器会把这些变量传给控制面。

未配置完整客户端时，授权入口返回缺少配置的错误。源码中的单元测试只使用显式 dummy 值；本次发布没有执行测试，也没有验收这两种 Google OAuth 真实授权链。
