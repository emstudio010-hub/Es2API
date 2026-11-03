# Es2API v2026.11.04-preview.3

本版修复CLI长开发者指令的启动参数限制及启动失败清理。

## 修复内容

- 开发者指令写入请求独立 `CODEX_HOME/config.toml`，保留 `developer_instructions` 角色；提示词继续走stdin。调用者指令不再进入进程参数，避免接口允许1MiB输入却触发Linux单参数约128KiB上限。
- 配置只包含一个受转义保护的字符串，权限0400，归属执行用户；不复制已有账号或宿主Codex配置。原工具、规则与网络限制继续保留。
- 合并后的提示词及指令按实际UTF-8字节计算上限，拒绝非法Unicode。
- 容器内启动系统错误且尚未产生CLI进程时，supervisor写入退出确认标记，避免无进程的失败请求留下阻止后续调用的残留。已启动进程仍需确认退出。

## 分发与边界

Linux附件为 `Es2API-linux-x64-20261104-r3.tar.gz` 及 `.sha256`。按[Linux说明](../deploy-linux/README.md)备份升级，保留账号、固定出口、数据库和加密密钥。

本版仅修改Node执行层及文档/打包版本，沿用r2前端和两平台Go产物，未重新编译这些二进制。已核对[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)及固定CLI源码，完成源码语法/模块加载和分发完整性检查。未运行测试套件、Linux部署、浏览器或真实供应商推理；长输入、OAuth与真实CLI→API、取消、用量及跨账号隔离仍未验收。ModelTrace历史502也未实测闭环。CLI详细范围见[能力与边界](CODEX_CLI_BACKEND.md)。
