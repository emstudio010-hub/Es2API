# Es2API v2026.11.02-preview

Es2API 首次公开预览：基于 VM2API 的执行面，整合 Sub2API 控制面与独立账号池/ModelTrace 服务。默认开发分支为 `es2api`，上游 `main` 保留用于来源追溯。

## 本分支新增

- 共享/租赁账号池、OAuth 导入、分组、租约、并发与生命周期状态。
- 创建时固定出口与 IP 派生环境，规范槽ID、账号归属和创建代次检查。
- 账号池发布到原生 OpenAI 用户分组，复用原生用户 Key、余额、权限和计费。
- 按用户 Key/组/槽/实例隔离会话、响应/输出项引用；HTTP、SSE 与逐帧 Responses WebSocket 网关。
- ModelTrace 固定参考库、自定义文本库、readiness、后台任务、历史、取消和动作防漂移。
- 七种自动触发策略与手动检测、分钟预设、冷却、观察/降权/暂停。
- 鎏金明暗主题、隔离详情、统一 Es2API 名称与黑金 E 图标。
- Linux x86_64 分发、内置 Node 24、启动/停止与 systemd 自启工具。
- 移除上游内置 Google OAuth 客户端凭据；额外的 Antigravity/Gemini CLI 授权需要部署者配置，ChatGPT 账号池流程不变。

## Linux 下载

下载 `Es2API-linux-x64-20261102.tar.gz` 与 `.sha256`，适用于 x86_64 glibc Linux，推荐 Ubuntu 24.04 / Debian 12。需 Docker Engine、Compose v2 和说明中的主机工具。首次启动需联网拉容器镜像。

```bash
sha256sum -c Es2API-linux-x64-20261102.tar.gz.sha256
tar -xzf Es2API-linux-x64-20261102.tar.gz
cd Es2API-linux-x64-20261102
sudo ./es2api.sh init
sudo ./es2api.sh run
```

默认入口 `http://127.0.0.1:18083`；初始管理员 `admin@es2api.local`，随机密码在本机 `runtime/linux-secrets.json` 的 `admin.password`。附件不含既有账号、代理、密钥或数据库。

此公开附件补齐了内置 ModelTrace 参考资源、集成层对应源码和许可文档，请使用本 Release 附件，而不是之前私下打包的旧文件。主程序与账号配置不因此自动改变。

## 预览边界

本次仅完成编译、打包及文件/哈希检查，没有执行测试、Linux 部署、浏览器、隔离/并发或真实供应商验收。历史 ModelTrace 第三样本 502 仍未闭环。检测概率不是 IQ 或模型身份保证。Docker 模式共享宿主内核，共用代理可能共用公网 IP。HTTPS 与域名未配置。

## 许可与上游

这不是整个项目的 MIT 重新授权。VM2API 原许可限制商业用途，商用仍需原权利人书面授权；Sub2API 代码保留 LGPL-3.0；各第三方组件保留原许可。请阅读根 LICENSE、THIRD_PARTY_NOTICES.md 和各目录许可证。

感谢 VM2API、Sub2API、CPA Codex Candy Eval、LM Detector 与所有依赖项目。
