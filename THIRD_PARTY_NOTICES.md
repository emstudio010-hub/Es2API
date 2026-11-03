# 来源、致谢与许可

Es2API 是衍生整合项目。公开源码不改变上游项目的权利、许可或商标归属。

| 组件 | 来源及固定版本 | 本项目用途 | 许可位置 |
| --- | --- | --- | --- |
| VM2API | [dofastted/vm2api](https://github.com/dofastted/vm2api)，`6f188e94e10ff6ce9239b4c39f964da4c98916d7` | 槽位、容器、固定出口、执行协议、辅助管理台 | `vm2api/LICENSE`；商用另需书面授权 |
| Sub2API | [Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api)，`37067e8e340e9440d173a92b4faa05e8ce58368f` | 用户、分组、Key、计费与管理台 | `sub2api/LICENSE`，LGPL-3.0 |
| CPA Codex Candy Eval | [haowang02/cpa-plugin-codex-candy-eval](https://github.com/haowang02/cpa-plugin-codex-candy-eval)，`4f8367642cc1e629c4ee15a975e5e0fc53c4ac16` | 固定检测器、候选模型与挑战数据 | `integration/resources/modeltrace/cpa-v2/` 原许可证 |
| LM Detector | [Ikaleio/lm-detector](https://github.com/Ikaleio/lm-detector)，`654c8334bb53951aaf04cbd61252d163649e1369` | ModelTrace 指纹算法来源 | 同目录原许可证与 `PROVENANCE.md` |
| Codex CLI | [openai/codex](https://github.com/openai/codex)，`0.155.1` | 可选真实 CLI 文本执行后端 | 安装 payload 的 `vm2api/share/codex-cli/linux-x64/LICENSE`，Apache-2.0 |
| bubblewrap | 同一 Codex 官方平台包附带；对应官方 tag 的 vendored source | CLI 的 Linux 沙箱 | payload 中的 `COPYING-bubblewrap`（LGPL-2.0）及 `source/bubblewrap/`、`SOURCE.json`；源码逐文件按固定 Git blob SHA 校验 |

VM2API 的 API kernel 可从源码构建；部分槽位程序与封装 CLI 为上游发布的预编译 payload，按 `vm2api/deploy/payload.json` 固定大小和 SHA256 下载。它们不因此变为 Es2API 原创或全部可从本仓库重建的组件，使用/再分发仍受各自许可约束。

Linux 包附带 Node.js；许可证随其运行时提供。Go、npm 与前端依赖保留其原许可证。原站点的法律文档和上游链接保留以便追溯，不表示本项目是上游官方发行。

本项目新增的原创集成和部署代码许可范围见根 `LICENSE`。若需要发布商业服务，应先确认所用上游代码、payload 与供应商账号使用条款均允许相应用途。
