# SQLite 迁移审查

审查对象：`src/store.mjs` 与 `test/store-migration.test.mjs`。

## 已覆盖

- 启动时使用 `CREATE TABLE IF NOT EXISTS` 补齐分组、账号、ModelTrace、用量、调度租约和幂等记录表。
- 对旧 `pool_accounts` 自动增加 `binding_json`、`provision_generation`、分组暂停恢复、槽位绑定过期、在途请求、冷却时间和健康检查时间字段。
- 旧进程留下的 active 调度租约会转为 `interrupted` 并清除账号在途计数。
- `queued/running` 的 ModelTrace 记录会转为 `interrupted`，只写入公开错误码，不会自动重放可能已经到达执行面的检测。
- 旧的 `modeltrace_bank` 只有时间戳时仍可读取；下次安装参考库会写入基于内容的稳定 revision，避免仅因写入时间变化而误判漂移。

## 不能自动推断的部分

- 旧凭据密文必须使用同一 `ES2API_DATA_KEY` 才能解密；密钥缺失或变更时不会尝试恢复凭据。
- 未列入当前 schema 的自定义表、外部 VM2 容器、代理分配和供应商状态不属于 SQLite 迁移范围。
- 迁移不会自动创建或删除 VM2 槽位，也不会重放历史 ModelTrace 或真实供应商请求。

## 运行前要求

生产迁移前应先备份 SQLite 文件及其 WAL/SHM 文件，并在隔离副本上执行启动与回归。当前回归使用内存库和临时 SQLite，未读取生产数据库。

## 当前证据

`npm test`：50/50 通过，其中包含旧 schema 打开、字段补齐、活动租约恢复和 in-flight ModelTrace 恢复场景。该证据不等同于真实 Docker、VM2、固定出口或供应商验收。
