# Operation 存储与版本门禁（面向 0.3，未发布）

持久 Operation 记录一次明确继续 Run 的意图、原身份和状态。源码另提供主动开启的 [Core 执行服务](CORE_SERVICE.md)：单根 runner、真实 Adapter、HTTP 202/原 Key 接回和有限本地停止；默认 API 与真实 Web 页面仍只读。现有 [CLI 图片流程](IMAGE_FLOW.md)保持。

Operation 表示一次有限调用，Run 表示创作流程，Task/Attempt 表示外部受理与结果。Operation 成功并不等于图片完成；running 是最后保存的本地状态，不证明处理器仍在线。存储 CLI 初始化/查询不执行模型；执行服务启动只标记遗留中断，查询和原 Key 重放不重新生成或观察 Provider。

## 显式初始化与查询

以下命令针对未发布源码；已公开 npm 0.2.7 没有此入口。需要 Node.js ≥22 和项目现有依赖：

```bash
node bin/dsh-iris.js flow init --data-root /absolute/path/to/new-flow-root
node bin/dsh-iris.js execution init --data-root /absolute/path/to/new-flow-root
node bin/dsh-iris.js operation list --data-root /absolute/path/to/new-flow-root
node bin/dsh-iris.js operation inspect op_REPLACE_WITH_64_HEX --data-root /absolute/path/to/new-flow-root
```

`execution init` 只接受新的空 Flow 根，建立 `creation-requests/v1/`，包括请求记录、Operation、根声明和预留的空 runner 目录。输出 `executionEnabled: false`。重复初始化同版本根接回原声明，不改写业务和请求记录，但仍通过 writer 检查；不会把现有 v0 请求根升级，也不会降级 v1。缺失的 Flow 根、已有作品/流程的普通根和部分初始化均明确拒绝，不自动清理。

没有 CLI 接收/执行 Operation 的命令。接收和状态转换暂为内部应用运行时的有限接口，不作为公开 SDK；终端只开放列表与单项查询。列表支持 `--run-id`、`--limit 1..30`、`--cursor`，输出不含 owner、输入摘要或私有路径。

## 身份与状态

- 身份按根 UUID 与小写 UUIDv4 Key 派生为 `op_<64 hex>`，不依赖 Token、端口或进程。原 Key 与 Prompt 不复制到 Operation 记录。
- 同 Key、同 Run/revision 接回原记录，包含已结束或取消记录；变更输入复用 Key 拒绝。同 Run 最多一条 queued/running，单根活动上限 8；被拒绝的请求不落盘。
- 接收写入单条完整记录，不双写索引。状态转换按 Operation revision 检查，允许排队、开始及成功/失败/取消/中断的有限转换，结束记录不重新排队。
- 存储原语只修改 Operation 文件；真实继续与 Abort 由显式 runner 持有 writer 调用。停止不发远端取消，不改写远端 Task 的已知结果。
- 单纯查询保留原状态；显式启动执行服务取得所有权后将遗留 queued/running 标记 interrupted，但不执行它们。调用方必须明确核对原 Run/Task。未知受理不因存储重放而重新生成。

记录绑定 Run 的私有输入摘要、预留 Task 和来源/比较作品 ID。完成时保存已有 Run revision 与结果引用，不复制 Provider 配置、完整异常或媒体。错误只记录有限类别。所有记录的引用暂继续保留，归档/释放策略另列，不自动 GC 或清除请求身份。

## 版本与维护

原 `creation-requests/v0` 行为与记录格式保持。v1 中的本地图片上传/Run 创建复用现有零生成逻辑与持久 Key；[只读工作台](LOCAL_WEB.md)仍然只读。

新版写者启动时检查请求容器、Operation 结构和原 Run/Task 绑定。未知版本、损坏记录、混合容器、符号链接或未知 runner 内容会阻止写入并保留现场。新根也由已发布 0.2.7 的真实 CLI 验证拒写；更早版本和任意外部程序不在此保证内，不应把实验根交给它们维护。

删除与清理盘点识别 Operation 的 Task/Artifact 引用，结束记录也继续保护引用；请求/Operation 文件及临时证据不在清理白名单内。旧隔离内容恢复仍遵守当前写者门禁和不覆盖规则。

私有目录/文件创建时采用 0700/0600；Windows 的 mode 不替代 ACL。原子提交和进程强杀验证不等于断电耐久，也不等于 Android 共享存储已经验证。当前无个人数据迁移或公开发行。
