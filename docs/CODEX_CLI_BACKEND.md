# 真实 Codex CLI 执行后端（预览）

## 创建与使用

在「账号管理 → 导入 OAuth」选择 **Codex CLI（预览）**。每个账号仍对应一个工作区、固定独占代理资源和 Docker 执行槽。CLI 并发固定为 1；后端只允许创建时选择，历史账号继续使用原 Kernel，不自动迁移。缺少空闲代理或出口时区时停止创建，不回退直连。

源码安装工具：`node vm2api/scripts/install-codex-cli.mjs`。安装器从 npm 下载固定的 `@openai/codex@0.155.1-linux-x64` 平台包，核对固定 SHA-512，仅提取 x64 ELF 与 bwrap，许可证从对应官方 tag 下载并校验 SHA-256。不执行 npm 包脚本。安装目录为 `vm2api/share/codex-cli/linux-x64/`，不提交二进制到源码仓库；新 Linux 打包流程会附带它。运行时必须使用 Linux x64 Docker；节点和 KVM 暂不开放此后端。

## 调用能力

- 复用原来的账号分组发布、API Key、调用租约、计费与用量回传。
- HTTP Responses、Chat Completions 的纯文本请求，流式/非流式均经现有协议层适配。Anthropic Messages 与旧 Completions 暂不提供 CLI 适配。
- 每次调用运行真实 `codex exec --json --ephemeral`，位于本账号容器内，而非宿主机 Kernel。完整多轮文本作为显式 JSON 对话记录传入新的一轮 exec，不宣称与原生逐条角色消息完全等价。
- CLI JSONL 的 agent_message 完成后转成 Responses 文本事件，再适配客户端协议；这不是逐 token 直通，首条文本可能到消息完成后才出现。
- 只在 CLI 退出码为 0、收到 turn.completed、文本与真实 usage 齐全时标记完成。输入、缓存输入、输出用量取自 CLI，部分失败保留已有 usage，不伪造成功。
- CLI 后端关闭外层传输重试、同账号重试及账号切换；设置上游请求和流重试次数为 0。CLI 自身执行细节仍以固定版本行为为准，无法承诺供应商侧严格只执行一次。
- 不支持原生函数/自定义工具、图片、搜索/图片端点、音频、输出 token 上限、温度、结构化输出、service tier、priority/fast/ultrafast 或 response ID 续接，返回明确错误。Responses WebSocket 复用同一请求层及能力检查，不拥有独立 CLI 持久会话。Completions 的 prompt 格式也不支持。模型/推理强度最终须由该账号和 CLI 支持。

## 隔离与进程生命周期

固定版本工具目录只读挂入槽。每请求新建 CODEX_HOME、HOME 和空白工作目录，不复制宿主或账号已有的 Codex 配置/规则，read-only 沙箱，禁用 shell、浏览器、插件、apps、多代理、记忆等入口，关闭 MCP 配置与网页搜索。不继承宿主 Codex 认证。这里是 Docker 共享内核隔离，不是独立虚拟机或供应商客户端身份保证。

从 `2026.11.04-preview.3` 起，开发者指令写入本请求 `CODEX_HOME/config.toml` 的 `developer_instructions` 字符串，文件以0400创建、归属执行用户；不再把调用者指令放入进程参数。JSON/TOML共有转义加上DEL转义，防止换行、引号或表标题变成配置项；非法Unicode直接拒绝。CLI读取的是这份新建配置，故不再传会跳过它的 `--ignore-user-config`；规则仍显式禁用。配置随临时请求目录一起清理，未确认退出时与认证副本一起保留至恢复。

该变更保留developer指令角色，没有改用会替换基础系统指令的 `model_instructions_file`。输入上限按实际合并后的提示词及指令UTF-8字节计算，共1MiB；提示词走stdin，开发者指令走请求配置，不受Linux单个argv约128KiB的限制。供应商上下文限制和实际长输入能力仍需独立验收。

临时 auth.json 只含短期 access/id token 和账号 ID，不复制 refresh token。刷新由控制面通过该账号固定出口完成，单进程按账号串行，并在落盘前检查凭据未被其他操作替换；额度刷新及手动刷新复用该路径。不能用多个独立控制面进程同时管理同一份账号文件。正常退出清理临时目录；不记录 stderr、认证、原始上游错误或代理密码。

健康检查使用与调用准备相同的访问令牌期限判断；令牌期限未知或不足本次执行预算、且无刷新令牌时不显示就绪。支持凭据中的秒/毫秒/ISO期限及访问令牌的JWT期限，但这些本地字段不证明供应商当前接受该账号。刷新已开始后仍等待结果并保存成功轮转的令牌，避免客户端取消造成刷新令牌丢失。

默认总时限 5 分钟，JSONL 输出上限 4 MiB，输入文本/指令上限 1 MiB。容器内 Python supervisor 启动独立进程组；超时、取消文件或宿主心跳丢失会终止整组进程。停止/删除实例会取消 CLI；执行期间重新导入或清除凭据先发取消并返回忙碌，等待结束后重试。

认证准备消耗同一执行预算，CLI只获得剩余时间；预算耗尽不再启动推理。等待凭据串行锁可能延后返回，取消或超时后轮到该请求时会停止准备。已收到的真实用量在最终交付异常时仍保留到失败日志，失败不算自动检测的成功调用；缺失用量不估算。已完成请求清理失败只记录固定错误码，下次调用先尝试清理；无法清理则拒绝启动新请求。

宿主崩溃或 Docker 客户端退出不能证明容器进程已停止。没有 supervisor done 标记时保留临时目录并阻止新调用。可在账号池工作区选择「恢复实例」：暂停调度、取消在途检测/执行，确认对应容器完全停止后，仅清理该账号 `.es2api-requests/req-*`，再开机并检查健康。无法读取 Docker 状态或仍有宿主请求未释放时拒绝清理。恢复期间拒绝其他开机、重载和删除操作。

若容器内启动CLI时直接发生操作系统错误，supervisor确认尚未产生子进程后写入done并以126退出；该请求仍判失败，但可正常清理。已启动进程的退出确认规则不变。

## 实例操作

账号池工作区支持启动、停止和恢复。管理 API 为 `POST /api/v1/admin/accounts/:id/{start|stop|recover}`，返回 202 后异步完成，页面每 3 秒刷新处理中状态，避免长时间拉取镜像超出网关超时。操作前后均核对账号、后端、代次与固定出口；停止/恢复会取消在途请求，需界面确认。完成后仍暂停调度，由用户检查后在运行设置中启用；同步状态也保留手动暂停。

停止和删除要由 Docker 再次确认。删除未确认时保留账号记录、凭据和出口；容器删除成功才清理账号目录和释放出口，失败可重试。当前操作是单控制面进程串行锁，不支持多控制面共享同一状态目录。

## 协议转换补充（preview.8）

CLI 在选定账号之后使用独立的文本请求转换，不套用 Kernel 的参数裁剪、推理强度归一化或会话重建缓存键。入口和执行层仍校验原始参数及实际执行参数；支持的 minimal/low/medium/high/xhigh 原样传入，供应商最终支持范围取决于账号与模型。会话路由只用于账号选择，CLI 每次仍是新 exec；显式缓存键和 response ID 续接仍拒绝。

Chat SSE 的 failed/incomplete/cancelled/error 会回传错误及 DONE，不发送成功 stop；有真实用量则保留。Chat 流式和非流式的 completion_tokens_details.reasoning_tokens 仅在上游提供时出现，它是输出子集，不重复累计总量或费用。

## 失败、取消与用量收尾（preview.9）

取消或输出交付失败后，停止文本交付，但仍解析输出大小限制以内、已经产生的有效 turn.completed，用量保留到失败日志，不把失败变为成功。输入/输出用量必须齐全且有效；缓存/推理细分只在上游提供时出现。无法读到的用量不估算。

普通失败和异常共用一个终止事件通道；已经尝试发送 completed/failed 后不再发送矛盾的第二个终止事件。客户端已断开时仅取消和清理，终止帧交付异常不覆盖原失败。若非流式请求只在内存中缓冲了部分文本，失败后仍返回 JSON 错误状态，不返回空200。

容器监督器接收剩余毫秒预算，独立记录 timeout/cancelled/heartbeat_lost，控制面仅接受这三个固定值。空白、未知或不可读取的原因不判成功。超时映射504，取消映射499；已经开始的 SSE 通过错误事件报告，HTTP状态无法追改。退出码、完成事件、文本、usage与原有done退出确认规则仍保留。

## 账号池网关与流保活（preview.10）

HTTP/WS 账号池网关依据账号保存的 execution_backend 构造隔离请求。CLI 不注入 Kernel 专用 prompt_cache_key，仍通过调用者/分组/账号/代次作用域下的会话头隔离路由。调用者显式缓存键不被静默删掉，仍由 CLI 能力校验拒绝；Kernel 保留原缓存键构造。

CLI 健康检查通过、开始执行准备后，流式请求空闲10秒写一条 SSE 注释保活，真实事件重置空闲计时，终止事件/返回/异常会停止计时器。非流式不写保活；排队和健康检查阶段不由该计时器覆盖。CLI 文本仍按消息完成后发送，保活不是逐token输出。快于首条保活的失败仍可返回HTTP错误；保活已提交200后，失败通过结构化错误事件报告，不追改HTTP状态或宣称推理成功。

网关按完整JSON或SSE帧观察完成状态，同时维护原有响应/条目归属索引。跨UTF-8分块、多行data、CRLF、注释及DONE独立处理，单帧/JSON缓冲上限为10Mi个UTF-16码元；超限、无效UTF-8/JSON或截断不判成功。Responses需要实际completed状态和完整输出数组；Chat SSE需要预期的所有choices结束并收到DONE。已有Kernel JSON Responses封装仅用于识别完成状态，不在网关改写响应协议。

明确failed/incomplete/cancelled/error正常转发，租约记失败；只有HTTP成功、协议完成、未取消且下游finish后才记成功。finish只证明本机写出，不能证明远端客户端已读取。响应截断中止连接并保留失败，区分调用者断连和15分钟网关超时；都不自动重放推理。用量和ModelTrace仍走各自原通道，不把保活、部分文本或HTTP200计为完成。

## 非流式 Chat 与上游等待（preview.11）

Kernel和CLI共享非流式Responses→Chat Completion转换。文本、refusal、function工具的原始arguments和custom工具的原始input分别保留；custom按官方type=custom、custom.name/input表示，不伪装function。工具调用finish_reason为tool_calls；只有明确incomplete_details.reason=max_output_tokens/content_filter才映射length/content_filter。失败、未知终止状态或无效结构返回脱敏502，不补成功stop。转换失败保留已知用量，但不先绑定成功会话、报告成功尝试或计入ModelTrace成功。账号池网关不再接受Chat端点返回Responses封装来满足完成条件；协议不匹配记失败，不在网关静默改写。

URL引用转换并按拼接后的文本偏移修正；不能表达的文件引用、可见输出、非空logprobs等返回codex_chat_output_unsupported，建议使用Responses。reasoning项不进入assistant公开内容；不输出加密推理、伪造摘要或增加非标准reasoning字段。未提供created_at时使用转换时的本机Unix时间。当前只输出一个choice；流式Chat沿原路径，未在本版统一。

私有推理HTTP转发采用Undici 8.12.3和独立Agent，headersTimeout/bodyTimeout显式15分钟、connectTimeout为10秒，避免此处默认5分钟响应头等待早于总预算结束。总预算仍从网关读取请求体前开始计15分钟，包含读取、路由、上游和下游finish；断连/总超时继续取消同一请求，不自动重放。管理/模型目录仍用原fetch，进程全局dispatcher不改。服务排空后关闭私有Agent；Linux生产依赖和许可证随包提供并校验。

这不证明实际长等待通过，也不覆盖其他反向代理/客户端的超时；既有排队/健康阶段仍没有SSE保活。当前账号不迁移CLI，不进行新OAuth/真实调用。

格式依据：[官方Chat Completion响应字段](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

## 流式 Chat 与 WS 每轮租约（preview.12）

Chat SSE使用独立状态，不改变Anthropic/Responses组装共用的工具helper。每流生成稳定唯一id，created固定为本机开始时间；model在首个公开chunk前可由上游元数据确定，此后变更拒绝。正文、refusal、function参数分别累计；done/最终完整输出只补缺失后缀，前缀/类型/身份/输出次序冲突报错，不把拒绝/未知delta写成正文。单事件/累计可见文本及参数上限10Mi个UTF-16码元，最多4096输出项、8192内容块。

最终借助共享非流式适配检查完整输出，再核对已发送正文/refusal和工具参数。只有明确完成才stop/tool_calls；明确max_output_tokens/content_filter分别为length/content_filter，仍不记实际完整推理。早到DONE、缺终止EOF、失败或未知输出不能宣告成功。已知usage在转换失败后仍观察保留，错误帧脱敏，不增加推理重试。API账号非流式Chat也使用共享适配；两条Chat流路径均检查EOF。Kernel的Chat入口在执行前拒绝n不等于1，CLI原始参数允许n=1，仍不支持多choice。

当前官方Chat流工具delta只定义function，没有custom字段；custom输出、引用和其他不能表达的可见输出明确报codex_chat_stream_unsupported，建议使用非流式Chat或Responses，不将custom伪装function。推理进度/summary不暴露为非标准reasoning_content。CLI仍是文本exec，工具路径属于Kernel/API适配，不表示CLI已支持工具执行。Chat custom请求定义及历史工具结果的输入转换在preview.13补齐；API中间格式的custom限制见下节。

WS连接保持原账号绑定，但每次response.create在同一隔离事务中重新检查分组、调度容量、账号/槽位/代次/凭据incarnation及previous/item引用，独立申请租约。完成/失败终止帧及所有先前帧本机send回调完成后才释放当轮结果；空闲连接不持并发，下一轮不换账号、不重放。一个连接仅允许一个活动轮次，未完成就发下一轮会关闭并记失败。完成观察检查响应id一致和完整completed输出；HTTP升级或文本/usage不能独立证明成功。

WS逐轮15分钟预算，握手15秒、连接空闲15分钟。response.cancel和原生response.interrupt都只允许取消当前轮次，显式目标需归属本调用者并匹配当前response id；转为VM2实际支持的response.interrupt。取消确认写出或10秒到期后关闭当前连接，并记取消，不把确认当执行已退出。客户端断连/上游关闭/协议错误/背压/发送失败/停服均关闭本地上游并清理活动租约。send回调仅证明本机写出，不证明远端已读；容器取消和退出确认仍属于执行层的独立验收。

格式依据：[官方Chat流事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)、[官方Responses流事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)。这些源码改动未经过行为测试或真实账号验收。

## Chat输入历史与WS首次身份（preview.13）

共享codex-chat-input.mjs处理Chat→Responses输入。custom定义与tool_choice从Chat的custom嵌套结构转换为Responses平铺结构；text格式保留，grammar的syntax/definition提到format顶层。原样保留custom.input字符串，包括空串和换行，不解析JSON；function.arguments字符串不重新编码，定义保留strict。assistant的refusal生成独立内容项。parallel_tool_calls、service_tier不再在Chat输入转换时丢掉，Kernel继续使用原有tier规范化，CLI继续原始能力门。

历史按call id记录function/custom类型，tool结果必须引用此前调用，使用相应function_call_output/custom_tool_call_output。重复调用ID、重复结果、找不到调用、双重ID矛盾或无custom input均返回codex_chat_tool_history_invalid；定义/格式错误为codex_chat_tool_invalid。转换边界捕获并返回400，避免未命名空调用或call_unknown猜测。该输入适配并不在服务器执行客户工具。

API账号仍先转Anthropic中间格式；该格式未能保留Chat custom的原始输入，因此在调度/供应商请求前明确api_bridge_custom_tool_unsupported，不绕过现有请求拦截/身份/提示词策略。两条API桥接对n不等于1明确api_bridge_n_unsupported。规范function历史通过共享Chat→Responses转换，替换以前把tool结果当用户文本、漏掉assistant调用的映射；不宣称API custom已经实现。

WS每轮首次响应身份在现有隔离事务中claim，当前caller/group范围内的response索引已存在即拒绝，包括同一账号；同轮后续帧仍允许同一ID。新连接能识别24小时TTL内已记ID；同一连接另保存ID的SHA256摘要，最多4096个，满额即关闭并释放本轮失败结果，要求新连接。响应对象id与response_id矛盾或输出早于身份则关闭记失败；无ID错误/取消确认/keepalive不被当作成功响应。该检查不提供过期索引后的无限期重放识别，不证明容器隔离或执行退出。

依据 [官方Chat输入](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[官方Responses输入项](https://developers.openai.com/api/reference/resources/responses/subresources/input_items/methods/list)、[官方异步工具调用类型对应](https://developers.openai.com/api/docs/guides/async-tool-calling) 核对形状。没有运行行为测试或真实账号验收。

## 验收边界

本次不运行测试套件或真实推理。语法、类型、编译、二进制完整性、`--version` 与应用健康只证明安装及构建情况；不证明 OAuth 认证、容器沙箱兼容、取消行为、真实模型用量或跨账号隔离已经通过实测。当前已有账号/IP 保持原配置，不能把它的 Kernel 健康状态当成 CLI 验收。Linux 包和公开源码按发行版本分别提供，请核对对应 Release 的版本、附件和校验文件。

参考：[官方非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[官方 CLI 命令](https://learn.chatgpt.com/docs/developer-commands?surface=cli)、[官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。本实现核对固定0.155.1源码提交 `be2951ea34f0d295ed0becf97079f92fa5f6950e` 的exec CLI、配置loader及developer指令合并逻辑；当前官方文档不能代替该固定版本的实际调用验收。
