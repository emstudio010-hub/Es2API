# Es2API Linux x86_64 分发包

## 环境

- 推荐 Ubuntu 24.04 / Debian 12 或更新的 x86_64 Linux，glibc 2.28+；不支持 Alpine/musl、ARM64。
- Docker Engine 与 Compose v2，需允许当前用户管理 Docker。使用 systemd 自启时以 root 运行。
- 主机需有 `bash`、`flock`（util-linux）、`tar`、`iptables`、`iproute2`、`python3`、CA 证书。Node.js 24 已内置，不需要 npm、Go 或前端编译环境。
- 执行槽默认使用 Docker 模式；KVM 需要额外的硬件与系统准备，不作为本包默认运行方式。
- 首次启动要联网拉取 PostgreSQL、Redis 和执行槽所需镜像；本包不是离线 Docker 镜像包。

## 启动

解压到独立目录，例如 `/opt/es2api`（systemd 安装路径不支持空格/中文）。不要覆盖正在运行的目录。

```bash
tar -xzf Es2API-linux-x64-20261104-r18.tar.gz
cd Es2API-linux-x64-20261104-r18
sudo ./es2api.sh init
sudo ./es2api.sh run
```

默认入口 `http://127.0.0.1:18083`。远程可通过 SSH 转发访问：

```bash
ssh -L 18083:127.0.0.1:18083 user@server
```

管理员：`admin@es2api.local`。在服务器上读取 `runtime/linux-secrets.json` 中的 `admin.password` 登录；此文件包括数据库密码、加密主密钥，仅本机保管，不要发送给他人。账号池和 ModelTrace 在管理员菜单内。合规承诺仍由所有者在正常界面处理。

如需直接对外提供 HTTP，先停止应用，修改 `runtime/linux-config.json`：`serverHost` 改为 `0.0.0.0`，`frontendUrl` 改为实际访问地址，再启动并配置防火墙。HTTPS/域名未配置。18084、18787、15433、16380 仅绑定回环地址，禁止映射到公网。

## 自启、停止与日志

```bash
sudo ./install-service.sh
sudo systemctl status es2api
sudo systemctl stop es2api
sudo systemctl start es2api
sudo journalctl -u es2api -f
sudo ./es2api.sh status
```

服务监督三个应用；其中任何一个退出，停止本组应用并由 systemd 有限重启。前台运行可用 Ctrl+C 或另一个终端 `sudo ./es2api.sh stop`。停止应用保留数据库容器；应用停止后执行 `sudo ./es2api.sh db-stop` 才会停本项目 PostgreSQL/Redis。日志位于 `runtime/logs`。

## 数据与升级

本包不含任何导入账号、OAuth 凭据、代理密码、用户 Key、数据库或本机备份；首次启动创建全新环境。不要把 Windows `runtime/local-secrets.json` 直接改名用于此包，也不要只迁移数据库而丢失对应加密密钥。

Compose 项目固定为 `es2api-linux`，命名卷由 Compose 管理，一台主机默认仅运行一套；不要将 `docker compose down -v` 用作停止命令。数据库端口固定 15433/16380。备份必须同时包含：停止后的整个 `runtime/`、PostgreSQL 导出和 Redis 数据；备份含秘密，离机前加密。

升级前停止 systemd 并完成数据库/密钥备份，将新包解压到新目录，迁入完整 `runtime/`，并更新 systemd 路径。`runtime/vm2/bin`、`share`、`docker` 是本包首次初始化复制的公共组件；升级时应用停止后，应与新包 `payload/` 同步这些公共目录。`data`、`vms`、`routing.json` 和密钥不可覆盖。保留旧包及备份作为回滚材料；涉及数据库迁移时仅替换二进制不保证可回滚。

## 构建边界

本版附带 Codex CLI 0.155.1 与 bwrap，工具目录和对应源码许可证位于 `vm2api/share/codex-cli/linux-x64/`。新账号导入时可选择 CLI 后端；仅支持文本 Responses/Chat，单账号并发为 1，已有账号保留 Kernel。实例页支持异步启动、停止、恢复，操作后保持暂停调度。能力与验收边界见 `docs/CODEX_CLI_BACKEND.md`。

本包已完成前端/Go 编译、分发文件与固定组件哈希核对。按所有者要求没有运行测试、Linux 部署验收、浏览器验收或真实供应商推理。历史 ModelTrace 第三样本 502 尚未闭环；新隔离机制的并发/跨账号/SSE/WS 仍未实测。Docker 容器共享宿主内核，共用代理时可能共用公网 IP；不代表独立虚拟机。不可据本包称正式生产验收完成。

## 品牌、源码与许可

产品显示名称为 **Es2API**，黑金 E 图标位于 `assets/brand/`。保留原有协议字段、兼容格式、模块名与上游归属。`source/` 附本版本对应源码；重新构建需按各上游项目准备依赖。`licenses/` 保留 Sub2API、VM2API 及其 Web UI 原许可证，Node 许可证随运行时提供，第三方依赖声明保留在各依赖目录。VM2API 原许可包含商业授权要求，具体以原许可证为准。
