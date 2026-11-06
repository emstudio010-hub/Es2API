# Es2API v2026.11.06-preview.30

## 换票结果分级与恢复准入

- 宿主加密日志状态只读映射为none/prepared/received/incomplete/unreadable；integration对旧版或缺失状态使用unknown。摘要只返回固定状态与候选恢复布尔值，不返回令牌、日志正文或密钥。
- 工作区区分“已保存完整响应”和“结果未知/不完整/不可读”，只有完整响应候选显示“校验并恢复凭据”。后者保留记录、暂停调度，并显示各自处理说明。
- integration先拒绝缓存中明确不可恢复的记录，执行前重新读取VM2；VM2在停止Kernel前再次拒绝prepared或不完整响应，直接调用API也不能绕过。完整响应仍须原身份、签名、凭据CAS和槽/出口快照校验，不能把候选当作已恢复。
- 更新中英文提示与[凭据恢复说明](REFRESH_RECOVERY.md)。状态读取不请求JWKS、换票或模型。

## 范围

未知结果的新OAuth替换/凭据处置入口仍待实现；没有清日志、强行解锁、复用旧RT或自动重新导入。第三方预编译Kernel内部刷新仍不受宿主日志保护。

本版仅语法/模块仅加载、Vue类型检查、前端及Windows/Linux编译、只读清点/健康与归档发布核对；按用户要求没有测试、UI渲染或故障/并发验收，也没有真实刷新/恢复、JWKS获取、出站探测或新增推理。真实gpt-6-luna最近仍HTTP502/codex_cli_connection_failed，无有效正文/usage；真实CLI→API、完整隔离/生命周期/caller计费与Linux生产验收未完成。HTTPS暂缓。

Linux包：Es2API-linux-x64-20261106-r30.tar.gz及.sha256。不包含用户runtime、数据库或私密日志。
