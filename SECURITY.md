# 安全报告与敏感信息

公开 Issue 适合脱敏的功能错误，不适合 OAuth、密码、账号数据或可直接利用的漏洞细节。

如仓库显示 GitHub 的 **Report a vulnerability** 入口，请使用该私密入口。没有该入口时，先通过维护者 GitHub 资料中明确公开的联系方式询问私密报告渠道，不要把秘密放到 Issue 或 PR。

报告应包含受影响版本/提交、涉及入口、影响边界和使用临时数据的最小复现。截图、日志和导出文件请先移除 token、Cookie、代理认证、用户 Key、邮箱与真实提示词。

不要公开 `runtime/`、密钥文件、SQLite/PG/Redis 数据、备份、VM 槽 home/run 目录。公开分发不会迁入这些数据。若秘密已经泄漏，应撤销/轮换相应凭据；删除公开文件不等于撤回已泄漏的值。

Es2API 当前为预览版本，安全与隔离实施边界见 [KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md)。
