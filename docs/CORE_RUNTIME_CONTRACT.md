# Core Runtime v0 候选契约

本文定义 0.2.0 的 Core Runtime 候选接口。rc 阶段仍可能调整，当前 npm 包尚未把它作为公开 API 导出；现有 `config.js`、`tasks.js` 和 `artifacts.js` 也尚未迁移。

## 目标与范围

Core Runtime 由调用方显式创建、启动和释放。数据根、操作权限、取消和清理都属于实例；存储缓存与观察器接入后也必须遵守同一归属。Core 不推断 DSH profile，不读取 `ctx`，不启动浏览器或监听端口，也不在启动、Doctor 或能力枚举时触发供应商请求。

当前候选已包含 Runtime、首批 Command 和最小 Artifact v0。完整 Task/Attempt 接入、Artifact Manifest 与 DSH 消费迁移仍在后续范围内；这些工作复用现有实现，不建立平行的 Actions。

## 数据根和进程归属

- `dataRoot` 必须由 DSH Host Adapter、CLI 或测试宿主选择后，以绝对路径显式传给 Core。Core 不读取 `DSH_HOME`、`HOME` 或当前工作目录来猜测位置。
- 每个数据根只允许一个写者。写者必须在读取、初始化、规范化配置、接回旧作品、重建索引或启动任务观察器之前取得数据根租约，并持有到实例完成释放。
- 其他进程可以用 `reader` 打开同一数据根，但只能执行无副作用的检查。DSH 正在使用该数据根时，CLI 写操作返回 `IRIS_CORE_DATA_ROOT_BUSY`；用户可以停止现有写者，或显式选择另一数据根。
- 只读不是隐式写入：不得创建缺失文件、修改权限、隔离损坏文件、修复/迁移记录、接回 `outputs/`、更新健康时间或启动任务观察器。
- 写者冲突必须 fail-fast。不得自动夺取租约，不得仅凭 PID 不存在或超时就判断旧写者已经安全退出；显式恢复流程需在后续实现阶段单独设计和测试。
- 路径别名必须在取得租约前解析为同一物理数据根。不能只依赖字符串规范化或原子 `rename`：后者可以防止半写文件，不能阻止两个带缓存的进程互相覆盖。

初版租约优先使用 Node 标准库和本地文件系统能力，不新增生产依赖。Android 共享存储、网络文件系统和异常退出后的恢复只有拿到真实证据后才声明支持；实现不得假设 systemd 或常驻 daemon 存在。

## 访问模式和操作分类

| 模式 | `inspect` | `execute` | `recover` |
|---|---:|---:|---:|
| `reader` | 允许 | 拒绝 | 拒绝 |
| `writer` | 允许 | 允许 | 允许 |

`inspect` 只读取已有事实并返回中性的可序列化结果。`execute` 包含本地动作、远端提交和任何持久化变化。`recover` 包含显式迁移、索引重建、损坏隔离和租约恢复；它不是普通读取的自动副作用。

启动、释放、Doctor、Provider 列表与 capability 列表本身不触发供应商请求、不产生费用，也不偷偷恢复远端任务。真实验证和生成必须由用户显式执行，并继续遵守现有受理、重试、取消和预算规则。

## 生命周期

```text
created --start--> started --dispose--> disposing --finish-dispose--> disposed
    \----------------dispose---------->/
```

- 实例只能启动一次；已经释放的实例不能重启。
- `dispose` 可以重复调用，并返回同一个释放过程。
- 释放顺序固定为：停止接收新 Command；传播取消信号；等待或保守挂起在途操作；停止任务观察器和 Host 注册；刷写已承诺记录；最后释放数据根租约。
- 如果仍可能存在写入，或最终刷写失败，不能提前释放租约来伪造“已安全退出”。远端是否取消仍以供应商证据为准，本地释放不得猜测。
- Host 生命周期只能拥有它创建的 Core 实例和注册资源；不得让模块级缓存、timer 或 listener 泄漏到下一次插件重载。

## 错误与结果边界

候选稳定错误码：

- `IRIS_CORE_OPTIONS_INVALID`：选项或显式数据根无效；
- `IRIS_CORE_STATE_INVALID`：生命周期顺序无效；
- `IRIS_CORE_OPERATION_INVALID`：未知操作类型；
- `IRIS_CORE_READ_ONLY`：只读实例收到写操作；
- `IRIS_CORE_DATA_ROOT_BUSY`：该数据根已有写者；
- `IRIS_CORE_DATA_ROOT_NOT_FOUND`：reader 指定的数据根不存在，且不会自动创建；
- `IRIS_CORE_DATA_ROOT_UNAVAILABLE`：无法安全创建、访问或检查数据根；
- `IRIS_CORE_LEASE_INVALID`：租约证据异常或无法安全释放，保留现场等待显式处理；
- `IRIS_CORE_LEASE_NOT_FOUND`：显式恢复时没有租约；
- `IRIS_CORE_LEASE_CONFIRMATION_MISMATCH`：用户回显的 PID 与租约 owner 不一致；
- `IRIS_CORE_LEASE_OWNER_ALIVE` / `IRIS_CORE_LEASE_OWNER_UNVERIFIED`：owner 仍活跃或无法证明已退出；
- `IRIS_CORE_LEASE_RECOVERY_FAILED`：恢复或审计未安全完成，现场已保留。

错误、Doctor 证据和 Command 输出不得包含 API Key、授权头、私有签名 URL 或不必要的本机绝对路径。Core 的 Artifact 结果使用稳定 ID 和中性元数据；HTTP/media URL、DSH attachment 与会话展示均由 Host Adapter 投影。

## 当前接口与后续范围

当前候选实现包括：

- `normalizeCoreOptions()`：规范化显式数据根和 reader/writer 模式；
- `createCoreRuntime()`：管理写者租约、状态、`AbortSignal`、在途操作和 cleanup；
- `createCommandService()`：提供 `crop`、只读 `task.list/task.inspect`、显式单步 `task.observe`/`task.reobserve`（同一份实现，`reobserve` 是人工触发观察的对外命令名）、人工重新交付 `task.redeliver`（只开放 outcome=succeeded / deliveryState=failed，一次带 redelivery 标志的 re-poll + 下载，绝不 submit、绝不重新生成）、人工取消 `task.cancel`（只开放已受理未终态任务，只有 Provider 明确确认才写 canceled，不支持/无法确认保持真实状态）、人工重试为新任务 `task.retry`（只开放终态未成功交付任务；必须显式 confirm_billing 确认重复计费；新 Task 记录单向 retriedFrom 关系，候选链按宿主实况重新解析；Core 不持久化 Prompt，prompt 必须由调用方重新提供），以及 Artifact inspect/list/export/rebuild；Task reader 返回既有安全事实，不读取 Provider 配置，也不创建、修复或迁移记录；`observe/reobserve/redeliver/cancel` 只接受宿主注入的 Adapter resolver，`retry` 只接受宿主注入的候选链 resolver，Core 不读取配置路径；Task capability 现已覆盖 image、video、tts 与 transcribe——交付按 `provider-task-runner.js` 的 DELIVERY_PROFILES 冻结（video：`video/mp4` + `generated-video`；tts：`audio/mpeg`/`audio/wav` + `generated-audio`，同步 completed 同次调用内交付；transcribe：`text/plain` + `transcript`，正文物化为 UTF-8 Artifact），不共用不准确的图片交付语义；
- Artifact v0：保存受控文件与最小记录，可跨 CLI 进程检查和导出。

[Headless CLI](HEADLESS_CLI.md) 记录了当前开发接口。下一阶段将用 FakeProvider 验证远端任务生命周期，再扩展完整 Artifact Manifest、哈希、关系、重建与崩溃一致性。DSH 消费者在这些语义稳定后迁移。

## 非目标

- 当前接口尚未作为 package export 或第三方 SDK 发布。0.2.0 的 F 阶段已正式决定：**不新增 `./core` 公开 export**——Root 插件与 `bin/dsh-iris` CLI 承载全部对外能力，内部模块（core-runtime、core-tasks、command-service、provider-task-runner、core-artifact*、core-user-projection）保持私有，可在 minor 版本间调整；冻结为公开 export 的决策顺延到 M2（0.3.0）的 Recipe/Serve 边界定稿后再审。届时一旦公开即写兼容策略与 semver 边界；
- 不提供 standalone 服务、账号、多租户或额外监听端口；
- 不包含新 Provider、收藏、标签、搜索或 Flow/Recipe；
- 不把 0.1.4 的模块级存储包装成实例存储，也不允许 CLI 与 DSH 无租约并发写同一数据根。
