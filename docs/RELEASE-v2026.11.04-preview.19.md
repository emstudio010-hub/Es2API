# Es2API v2026.11.04-preview.19

本版补同机Linux控制进程的维护协调。

## 修改

- 同机Linux控制进程按真实projectRoot/槽ID共用flock，控制锁独占覆盖凭据、开机/重载、停止/删除和完整恢复流程；请求原子取得共享活动锁后才开始。锁文件保留在home外，不靠PID/TTL解锁，不为清理而删除锁文件。
- flock在短命子进程中作用于继承的fd3，Node保持同一open file description到finally；没有常驻锁子进程，内核随fd关闭释放。符号链接/硬链接/类型/inode异常、缺少工具或非Linux拒绝执行。
- Kernel刷新等待跨进程活动排空；显式关机确认Kernel/容器停止后再等CLI宿主finalizer释放，才落盘确认。恢复锁覆盖清理、启动、settle和诊断，内部嵌套控制操作借用有效作用域。
- 控制争用立即失败，不再只在单Node进程内排队；活动排空等待最多15秒，每次flock命令另有5秒期限。失败保留账号、凭据、IP和请求claim，不自动重放调用。

详见 [实例协调](SLOT_COORDINATION.md)。所有控制进程需同时升级并使用同一支持flock的本地文件系统。文件存在不是占用证明；锁释放不是供应商完成或CLI退出证明。原nonce退出回执、request claim、停机/交接标记仍保留。远端节点、直接Docker/socket和旧控制代码不纳入协调证明，不是分布式锁。

## 发行与边界

Linux附件 Es2API-linux-x64-20261104-r19.tar.gz 和 .sha256；UI、Go、Kernel、固定CLI二进制沿r18不重编译。现有账号仍Kernel，IP/设置不变。仅语法/模块/AST/bash/源码哈希/许可权限/只读健康核对，无测试、行为用例、真实刷新/导入迁移/账号生命周期/推理或Linux安装验收。

flock继承fd、多进程/崩溃、排空与超时、WSL文件系统行为未验收；不宣称真实CLI→API、取消/恢复或隔离已跑通。ModelTrace历史502仍未闭环，HTTPS暂缓。
