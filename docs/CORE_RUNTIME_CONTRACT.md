# Core Runtime v0 内部契约

本文定义 Iris 0.2.x 沿用的 Core Runtime 内部接口，初版在 0.2.0 实现。内部接口在后续版本仍可能调整，npm 包不把它作为公开 API 导出；现有 `config.js`、`tasks.js` 和 `artifacts.js` 也尚未迁移。

## 目标与范围

Core Runtime 由调用方显式创建、启动和释放。数据根、操作权限、取消和清理都属于实例；存储缓存与观察器接入后也必须遵守同一归属。Core 不推断 DSH profile，不读取 `ctx`，不启动浏览器或监听端口，也不在启动、Doctor 或能力枚举时触发供应商请求。

0.2.0 包含 Runtime、Task/Attempt、Artifact Manifest、本地与媒体 Command，以及 DSH 对已迁移媒体任务的同源消费。0.2.1 已迁移 S2V 与 HTML，单图视觉、OCR、定位、摘要及提示词预览通过共享 Model Ports 执行；纯视觉不自动创建 Task/Artifact。legacy 存储和兼容入口保留，公开 Core API 仍未冻结。

## 数据根和进程归属

- `dataRoot` 必须由 DSH Host Adapter、CLI 或测试宿主选择后，以绝对路径显式传给 Core。Core 不读取 `DSH_HOME`、`HOME` 或当前工作目录来猜测位置。
- 每个数据根只允许一个写者。写者必须在读取、初始化、规范化配置、接回旧作品、重建索引或启动任务观察器之前取得数据根租约，并持有到实例完成释放。
- 其他进程可以用 `reader` 打开同一数据根，但只能执行无副作用的检查。DSH 正在使用该数据根时，CLI 写操作返回 `IRIS_CORE_DATA_ROOT_BUSY`；用户可以停止现有写者，或显式选择另一数据根。
- 只读不是隐式写入：不得创建缺失文件、修改权限、隔离损坏文件、修复/迁移记录、接回 `outputs/`、更新健康时间或启动任务观察器。
- 写者冲突必须 fail-fast，普通 Runtime **不得自动夺取**租约。0.2.0 提供独立的 `runtime recover` 显式流程：先由只读 Doctor 报告 owner，再要求用户回显陈旧 PID，并在接管时复核证据、写私有审计；活跃、未知或损坏状态拒绝。PID 不存在本身仍不是跨主机安全证明。
- 路径别名必须在取得租约前解析为同一物理数据根。不能只依赖字符串规范化或原子 `rename`：后者可以防止半写文件，不能阻止两个带缓存的进程互相覆盖。

初版租约优先使用 Node 标准库和本地文件系统能力，不新增生产依赖。Android 共享存储、网络文件系统和异常退出后的恢复只有拿到真实证据后才声明支持；实现不得假设 systemd 或常驻 daemon 存在。

0.2.2在原 v0 租约目录旁增加 `.iris-runtime-writer-v0.owner.json` 意图证据：完整私有 owner 先准备，再通过排他 hard link 原子发布，随后创建目录并链接 `owner.json`。新写者同时尊重目录和意图；创建中断仍保留完整 PID。文件系统不支持 hard link 时安全失败，不回退到可能半写的锁。Task、Artifact、配置格式和 CLI 参数不变，既有完整 v0 目录仍可诊断与显式恢复。

正常释放先整体 rename 非空目录为本实例 UUID 的退役目录，最后撤下意图；不会先在占位目录里删除 owner。退役目录本身不占有固定租约，但若撤下意图前中断，剩余意图仍阻止普通 writer，需要在 owner 已退出且证据完整时显式恢复。意图撤下后的清理只涉及本实例退役证据，清理失败不阻止新 writer；遗留退役目录不会在下次启动时自动删除。

恢复使用数据根中按前驱 UUID 排他发布的完整记录，保留原 owner，不替换或删除旧恢复步骤。Doctor 的 `phase` 可为 `owned`、`pending`、`recovering`；恢复再次中断时回显最新报告中的 PID，并复核链中每个 PID 均为 missing。并发恢复与旧观察被新 writer 接替均拒绝，不向新租约目录写入陈旧 claim。无 PID 的旧空目录、仅剩 `.owner.stale-*` 而缺少恢复 owner 的旧现场、未知文件、损坏或符号链接证据仍拒绝并保留。

私有审计先记录退役授权和完整恢复链，再整体移走租约到审计记录指定的 `evidenceDirectory`。审计 JSON 的存在本身不证明最终解除成功：命令成功结果和退役目录是相应完成证据。异常退出的准备文件、退役目录与根中的未归档恢复记录保留，普通启动不清理。当前证据来自本机私有文件系统的进程 SIGKILL 与 I/O 故障注入，不承诺断电持久性或 Android 共享/网络文件系统支持；混用旧版本 writer 不纳入这些新增保证。

## 访问模式和操作分类

| 模式 | `inspect` | `execute` | `recover` |
|---|---:|---:|---:|
| `reader` | 允许 | 拒绝 | 拒绝 |
| `writer` | 允许 | 允许 | 允许 |

`inspect` 只读取已有事实并返回中性的可序列化结果。`execute` 包含本地动作、远端提交和任何持久化变化。`recover` 包含显式迁移、索引重建、损坏隔离和租约恢复；它不是普通读取的自动副作用。

上表是 Core 操作的权限分类。CLI 的 `runtime recover` 是租约外的独立、需人工确认的接管入口；它不能先取得被陈旧 owner 占用的普通 writer 租约，也不能由 reader 或 Doctor 隐式触发。

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

当前稳定错误码：

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

## 应用运行时装配（未发布）

[application-runtime.js](../lib/application-runtime.js)是 0.3 的内部基础，复用上述 Core，不新增公开 export。实例显式接收数据根，以及可选的图片候选和既有任务 Adapter 解析函数；构造、状态查询和空闲期间不创建目录、持有租约或调用 Provider。首批 CLI 图片生成、图片导入、差异分析、作品查询/导出和单项 Task 查询已接入；其他 CLI 命令和 DSH 装配仍沿用原入口。

- 同一应用实例的写操作按 FIFO 执行；每次写操作独立创建、释放 Core writer，普通失败原样返回，后续项继续。实例之间不共享队列或取消状态，跨进程写冲突仍返回 busy。
- reader 独立于写队列，只读取已提交事实；它不调用配置解析函数或 Provider，不创建缺失数据根。并发写入时，多次读取不构成整个工作区的一致快照。
- 排队输入保存为本次操作的快照。开始前取消跳过该项，不解析候选、不创建 Task；执行中取消传播到本次 Core。已经保存的结果按真实事实返回，未知受理不重新生成，本地中止不等于远端已取消。
- `dispose()` 拒绝新操作和未开始项、中止活动操作，并等待业务回调和 Core 释放；重复调用返回同一个过程。租约释放失败时保留错误和现场，停止后续执行，不能报告关闭成功。

首批执行面包括图片生成/改图、`artifact.import/inspect/list/export`、`media.diff`、`task.inspect/list`，以及显式 `task.observe/reobserve/redeliver/cancel`。观察每次至多一次 poll，没有后台轮询定时器；补交付复用原 Task/交付缓存，远端取消只有确认后才算成功。需要 Provider 时由入口注入解析函数，并按原 Task 的供应商、模型和 binding 核对；完整本地交付缓存不解析 Provider。

应用运行时另装配 `flow.init/create/inspect/list/continue/select/export`，首版只提供 [固定改图流程](IMAGE_FLOW.md)。显式新根保存私有 Run 输入、预留 Task/比较 Artifact 身份和引用；Task 增加可选 `flowBinding`，旧记录不批量改写。已有 Attempt 后继续操作只核对原事实、观察或补交付，不重新 submit；完整异步 Flow 结果也先缓存，再按原 Artifact ID 交付。原图和流程作品/Task 同步纳入删除保护。通用 Recipe、独立 API 和 DSH 的模块级队列/观察器迁移仍待完成。

## 当前接口与后续范围

0.2.3 增加同步完成结果的私有交付缓存：`task.redeliver` 可从原结果恢复，无需虚构远端 ID；完整字节离线交付，缺失字节只取回原 URL，不 submit。完整缓存可补回提交完成事实的中断，预留 Artifact ID 支持逐件重入；缓存与任务隔离/恢复一起管理。详见 [同步交付恢复](SYNC_DELIVERY_RECOVERY.md)。

当前实现包括：

- `normalizeCoreOptions()`：规范化显式数据根和 reader/writer 模式；
- `createCoreRuntime()`：管理写者租约、状态、`AbortSignal`、在途操作和 cleanup；
- `createCommandService()`：提供 `crop`、只读 `task.list/task.inspect`、显式单步 `task.observe`/`task.reobserve`（同一份实现，`reobserve` 是人工触发观察的对外命令名）、人工重新交付 `task.redeliver`（只开放 outcome=succeeded / deliveryState=failed，已有缓存使用原结果，未缓存的异步任务使用一次带 redelivery 标志的 re-poll + 下载，绝不 submit、绝不重新生成）、人工取消 `task.cancel`（只开放已受理未终态任务，只有 Provider 明确确认才写 canceled，不支持/无法确认保持真实状态）、人工重试为新任务 `task.retry`（只开放终态未成功交付任务；必须显式 confirm_billing 确认重复计费；新 Task 记录单向 retriedFrom 关系，候选链按宿主实况重新解析；Task 不持久化 Prompt，prompt 必须由调用方重新提供），以及 Artifact inspect/list/export/rebuild；Task reader 返回既有安全事实，不读取 Provider 配置，也不创建、修复或迁移记录；需联网的 `observe/reobserve/redeliver/cancel` 只接受宿主注入的 Adapter resolver；完整本地缓存的 redeliver 不解析 Provider，`retry` 只接受宿主注入的候选链 resolver，Core 不读取配置路径；Task capability覆盖image、video、tts、transcribe与music——交付按 `provider-task-runner.js` 的 DELIVERY_PROFILES 冻结（video：`video/mp4` + `generated-video`；tts/music：`audio/mpeg`/`audio/wav` + `generated-audio`，同步 completed 同次调用内交付；transcribe：`text/plain` + `transcript`，正文物化为 UTF-8 Artifact），不共用不准确的图片交付语义；
- 0.2.1 补齐 `media.diff/frames/html`、S2V 按候选上传、查询/批量管理与 Core 隔离/恢复；视觉和维护入口见 [CLI 管理](CLI_MANAGEMENT.md) 与 [视觉 CLI](VISION_CLI.md)。
- Artifact Manifest v0：保存受控对象、SHA-256、关系边和可重建 Index，可跨 CLI 进程检查、导出和显式重建；Doctor 只报告孤立/未解析条目，不自动删除或修复。

[Headless CLI](HEADLESS_CLI.md) 记录了当前接口，包括只读配置查询、Core Doctor 与陈旧租约显式恢复。FakeProvider 与各媒体 Profile 的离线生命周期测试已经存在；真实 Provider、Android 目视、跨平台 CI 和发布门禁仍须分别举证。legacy 数据与未迁移存储保持独立，不冒充 Core 事实。

## 非目标

- 当前接口尚未作为 package export 或第三方 SDK 发布。0.2.0 的 F 阶段已决定**不新增 `./core` 公开 export**：Root 插件与 `bin/dsh-iris` CLI 承载对外能力，内部模块保持私有，可在后续版本调整。按 [现行路线图](ROADMAP.md#03-及以后)，公开 Provider/Host SDK 在 0.4 有真实消费者后再评估；0.3 的 Recipe/API 实现不自动构成公开 SDK 或兼容承诺。
- 不提供 standalone 服务、账号、多租户或额外监听端口；
- 不预建缺少实际需求的 Provider 协议；收藏、标签、搜索与通用 Flow/Recipe 留待后续；
- 不把 0.1.4 的模块级存储包装成实例存储，也不允许 CLI 与 DSH 无租约并发写同一数据根。
