# 从源码构建

## 推荐：Linux x86_64

源码目录是普通目录，不是 Git 子模块；克隆默认 `es2api` 分支即可：

```bash
git clone --branch es2api https://github.com/emstudio010-hub/Es2API.git
cd Es2API
bash deploy-linux/build.sh
```

准备 Node.js 24+、npm、Python 3（含 lzma）、curl、sha256sum、与各 Go 模块 `go.mod` 兼容的 Go 工具链。当前控制面声明 Go 1.27.3，不能直接照搬上游旧 Dockerfile 的 Go 版本。构建会访问 npm、Go 模块源、Node 发布站与 VM2API payload 发布源。

脚本执行前端类型编译/Vite、Go 主程序与 API kernel 编译、生产 npm 依赖安装、固定 payload 下载和哈希核对，再组装 `dist/Es2API-linux-x64-20261104-r12.tar.gz`。它不执行测试、不导入账号、不创建业务槽、不发供应商推理，也不自动安装系统服务。

重复打包时暂存目录和压缩包不会被直接覆盖，可使用新的输出路径：

```bash
ES2API_STAGE_FOLDER=release-next ES2API_DIST_FOLDER=dist/next bash deploy-linux/build.sh
```

此 Linux 构建脚本随公开预览提供，尚未在 Linux 完整执行验收。发布附件来自已完成的本地交叉编译与清单打包，不能将其等同于该脚本的运行证明。

## 构建链

1. `sub2api/frontend`：锁定 pnpm 依赖，`vue-tsc -b`，`vite build` 到 `sub2api/backend/internal/web/dist`。
2. `vm2api/web`：锁定 pnpm 依赖，`tsc -b && vite build`。
3. `sub2api/backend`：`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags embed,timetzdata ./cmd/server`。
4. `vm2api/api-kernel`：构建 Linux `kin-api-kernel`。
5. `integration`、`vm2api`：通过锁文件安装生产依赖，不携带开发环境 node_modules。
6. `vm2api/scripts/fetch-payload.mjs`：从固定 manifest 下载并验证上游预编译组件。
   `vm2api/scripts/install-codex-cli.mjs`：安装固定 CLI 0.155.1、bwrap 及对应源码许可证，分发时再次核对工具哈希。
7. `deploy-linux/package.py`：只复制所需源码、资源、公共组件、许可证和编译产物，生成 SHA256SUMS。

部分 payload 没有在本仓库提供对应源码，无法从这个仓库完全重建；来源与使用条件见 [第三方说明](../THIRD_PARTY_NOTICES.md)。

## Windows 本地开发

`deploy-local/` 是 Windows + WSL 开发运行工具，使用独立运行目录和数据库。它不是 Linux 生产安装脚本。使用前阅读 [本地说明](../deploy-local/README.md)，避免把运行目录、OAuth 或数据库加入 Git。

## 开发验证

各组件保留自身测试目录与脚本。运行测试需独立安排，避免真实账号或供应商调用混入；本次公开准备只进行文件、编译与打包核对，没有执行测试。历史记录中的通过数仅属于对应历史任务。
