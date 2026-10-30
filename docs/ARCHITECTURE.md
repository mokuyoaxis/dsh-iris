# Iris 架构与边界

状态：本文说明 **Iris 0.3.0-alpha.1** 的共享Core及Web、MCP与插件装配，并保留0.2.7入口图作历史对照。0.2.0建立实例化Core Runtime、Headless CLI及共享Task/Artifact事实；后续加入共享视觉、图片编辑、音乐和交付恢复。0.2.5恢复旧宿主支持，0.2.6增加连接引用、可选功能自动池和目录同步。准确版本及历史范围见 [兼容矩阵](DSH_COMPATIBILITY.md)。Node.js最低22.0.0；Core与插件契约仍为实验性。

## 当前形态

当前源码的 [Core 工作台](LOCAL_WEB.md)已连接真实持久执行、停止、作品选择和供应商管理；[通用 MCP](MCP.md)及[显式插件贡献](PLUGINS.md)复用同一服务与授权边界。图片生成/编辑、语音/转写和插件业务按用户所选范围启用。下方示意图表示 0.2.7 已发布入口，完整当前覆盖见 [README](../README.md#当前入口覆盖)。

0.3 alpha源码另提供独立 [Panel/主题](PANEL_EXTENSIONS.md)和 [C3 供应商设置](PROVIDER_SETTINGS.md)：页面可显式替换，配置管理复用应用层原子写入；默认媒体权限与 Core Task/Artifact 格式保持。它们不随已发布 0.2.7 提供，也不自动替换 DSH 内嵌 UI。

Iris仍以一个npm包交付。DSH插件负责原生Agent工具、附件、浏览器和内嵌UI；Headless CLI与独立Core服务（Web/MCP）在没有DSH/Cordis的进程中接收明确数据根和私有Provider配置。各入口共用Core Runtime、Provider Task Runner、Task/Artifact Store和本地Command，不能在同一根同时充当写者；MCP桥连接已有Core服务，不另建业务写者。

```text
DSH Host / Cordis                         Headless CLI
  ├─ Agent tools / Web UI                   ├─ explicit --data-root
  ├─ attachment / browser ports             └─ private provider config
  └─ bounded observation timers                       │
               │                                      │
     dsh-host-adapter.js                    bin/dsh-iris.js
               │                                      │
       dsh-core-adapter.js ────────────────┬───────────┘
                                           ▼
                                  Core Runtime v0
                           explicit root · reader/writer
                           lease · AbortSignal · disposal
                              ┌────────────┴────────────┐
                              ▼                         ▼
                    Command Service v0          Provider Task Runner
                    crop / diff / frames / html submit / observe /
                    inspect / control           cancel / delivery
                              └────────────┬────────────┘
                                           ▼
                         Core Task Store + Artifact Manifest
                         records · objects · SHA-256 · index
                                           │
                    DSH: $DSH_HOME/iris/v1/core-v0
                    CLI: explicit absolute data root
```

`lib/index.js` 是 DSH 插件装配入口，`lib/dsh-host-adapter.js` 是原始 DSH/Cordis 对象进入 Iris 的服务端边界；`lib/dsh-core-adapter.js` 负责 DSH 的 Core 实例装配、Provider 连接解析和 Host DTO 投影。`bin/dsh-iris.js` 不启动 DSH，也不推断 profile。`lib/api.js` 与 `lib/client.js` 是 Host 投影，不是真相来源。

0.2.7 增加 `lib/application-runtime.js`，首批 CLI 图片命令和固定改图流程通过它装配 Core；[DSH 实例](DSH_RUNTIME.md)也已接入同一队列机制。写队列、操作取消和关闭归属于应用实例；每次写操作独立取得、释放 Core 租约，DSH 的 Core 观察器由插件实例持有并等待卸载。[固定流程](IMAGE_FLOW.md)使用专用根中的版本化 Run、稳定 Task/比较作品身份及引用保护，私有输入保存提示词，Task 仅保存可选流程绑定。[本地 API](LOCAL_API.md)已提供默认只读与主动启用的 [本地创建](LOCAL_CREATION.md)，在 0.2.7 中，执行/取消和真实独立 Web 尚未提供，现已接入上文的0.3 alpha源码；通用 Recipe 仍待实现。详见 [应用运行时契约](CORE_RUNTIME_CONTRACT.md#应用运行时装配)。上图表示已发布入口的共同核心。

0.2.1的 S2V 使用 Core Task/Attempt，HTML 使用 `media.html` 与显式 Browser Port；视觉和提示词预览通过共享 Model Ports 执行。纯视觉不创建 Task/Artifact，摘要主动转写仍使用 Core 任务。聊天改图属于媒体生成链，按来源 Artifact ID 创建新 Task 和关联产物。

## 共享核心

| 模块 | 职责 | DSH 运行时依赖 |
|---|---|---:|
| `core-contract.js` / `core-runtime.js` / `core-writer-lease.js`（0.2.2） | 显式数据根、reader/writer 权限、单写者租约、取消与释放 | 无 |
| `application-runtime.js` | 实例写队列、操作输入快照与 Core 装配；首批由 CLI 消费 | 无 |
| `flow-store.js` / `image-flow.js` | 专用根、私有 Run 输入、固定步骤绑定、原任务恢复与用户选择 | 无 |
| `command-service.js` | 本地媒体命令、Task 控制面和 Artifact 查询/导出 | 无 |
| `generation-input.js` | CLI、DSH 与重试共用的生成参数校验和 Provider 字段转换 | 无 |
| `model-port-contract.js` / `model-invoker.js` | Text/Vision 内部契约、有限调用预算与取消 | 无 |
| `core-tasks.js` | Core Task/Attempt 持久事实、受理与交付状态 | 无 |
| `core-artifacts.js` / `core-artifact-store.js` | 对象、Manifest、SHA-256、关系边与可重建 Index | 无 |
| `provider-contract.js` / `provider-adapter.js` | canonical 结果、错误脱敏、受理边界与 Provider v0 操作 | 无 |
| `provider-adapters.js` | DashScope / Images / 聊天 / Responses 图片协议和可选输入准备 | 无 |
| `vision-image-input.js` / `image-edit-input.js` | 视觉发送副本与聊天改图来源预检；Core 原图保持不变 | 无 |
| `provider-task-runner.js` | 写前 Attempt、submit/poll/cancel/download 与 Profile 化交付 | 无 |
| `core-doctor.js` / `core-lease-recovery.js` | 只读完整性诊断与需显式确认的陈旧租约恢复 | 无 |
| `provider-catalog.js` | 显式 Provider 配置、能力候选和原 Task Adapter 恢复 | 无 |
| `dsh-core-adapter.js` | DSH 数据根、后台观察与 Core 到 Host 的投影 | 有；DSH 专属边界 |
| `dsh-host-adapter.js` / `index.js` | Host 能力映射、工具/路由/Skill 与生命周期装配 | 有 |
| `client.js` | DSH Web Slot、统一任务/作品区、泡泡和提示词入口 | 有 |

完整规则见 [Core Runtime v0](CORE_RUNTIME_CONTRACT.md)、[Artifact Manifest v0](ARTIFACT_MANIFEST.md)、[Provider Adapter v0](PROVIDER_ADAPTER_CONTRACT.md) 与 [DSH → Core 渐进迁移](DSH_CORE_MIGRATION.md)。这些仍是内部契约，不是第三方 SDK 兼容承诺。

面向 0.3 的0.3 alpha源码增加[Provider 扩展首版](PROVIDER_EXTENSIONS.md)：实例拥有协议描述、工厂、活动调用和异步释放；CLI/Core 服务显式传入注册实例，六类内置协议（含 ComfyUI）与外部协议共用候选/健康/恢复。实验性包入口仅开放媒体协议所需接口，尚未提供 DSH 外部模块加载设置、通用 Recipe 或完整 SDK。ComfyUI Task binding 另纳入模板摘要，见 [文生图与工作流入口](IMAGE_GENERATION.md)；原五类协议的 binding 与既有记录保持。

同属0.3 alpha源码的 [Core 插件贡献 v0](PLUGINS.md)统一五类贡献的身份、兼容与生命周期。新插件 Provider 的 Task/Attempt 在提交前记录准确依赖，旧绑定保持。默认 Panel 可显式组合页面/设置/预览，共享主题、认证客户端和会话；公开装配保持媒体只读，设置沿用 Core Provider 管理，整套替换仍可用。另由 `allowedOperations` 明确选择持久业务，复用同一单根 runner/FIFO/租约及有版本 `plugin.execute` 记录；Core绑定输入/来源、预留输出身份并管理实际作品存储。[多图对照板](CONTACT_SHEET.md)只引用公开 SDK 和现有 Sharp，已贯穿 Web、用户选择、通用 MCP 与原记录恢复。无稳定 SDK、市场或旧数据迁移。

Core能力目录派生MCP/DSH、Web选项/会话和Skill，投影五类贡献的真实边界。注册/发现不授权，旧工具名单不扩张。MCP用通用目录/执行工具投影连接明确保存的准确业务依赖，Core在接受和后续命令处检查有效权限；断开代理不停止Core。重启只记录interrupted，插件缺失或版本变化不重放，原作品/记录仍可读取。实例生命周期由装配者持有，先关服务再关注册器。

0.2.2 的 Core writer 在创建目录前发布完整 owner 意图，释放和显式恢复通过整体退役保留证据；普通启动不抢占。非图片 staging 复用文件复制接收与分块哈希，图片格式验证和 inline 解码仍可能使用完整 Buffer，不声称端到端流式传输。

## Task、Attempt 与 Artifact

- 一个用户意图对应一个 Core Task；每次候选供应商调用对应一个稳定 Attempt。Attempt 必须在可能发送计费请求前落盘。
- Core只有明确 `not_accepted` 才自动切换候选；`accepted` 或 `unknown` 后通用Runner停止重提。人工重试会创建新Task，要求重新提供输入并确认潜在费用。Music功能层另按本次配置对明确HTTP502进行有限重发，保留原Task的未知事实和新旧任务关系，详见 [音乐生成](MUSIC.md)。
- 生成结果与本地交付是两类事实。远端成功后下载失败仍保持 `outcome=succeeded / deliveryState=failed`，可显式重新交付而不重新生成。
- 新 Attempt 可选保存阶段时间戳与模型选择来源；旧记录缺少这些字段仍可读取。
- Artifact Manifest v0 保存内容哈希、媒体类型、中性元数据和关系边；不保存 Prompt、API Key、签名 URL、Provider 端点或宿主绝对路径。
- Core/CLI 已提供默认只读预览、明确选择与确认、文件隔离和恢复的删除/清理 Command，保护活跃 Task 和引用；索引更新只使用已提交记录，不升级或接回孤儿。DSH 作品区共用删除预览、隔离与事务恢复，永久 purge 未开放。Doctor 只报告，不自动修复。见 [CLI 管理与补齐](CLI_MANAGEMENT.md)。

0.1.4 的 `tasks.json`、`artifacts.json`、`outputs/` 与上传目录继续作为 legacy 数据存在；Core 使用隔离的 `core-v0`。已迁移的新图片、视频、S2V、TTS 与转写任务不双写 legacy，回退到 0.1.4 时也不删除或改写 Core 数据。

## Provider 边界

0.2.6 的六类功能可选择自动池、仅用所选模型或停用。自动池只从已确认用途的模型中按稳定顺序选择，不授权目录新条目，也没有跨请求轮转；旧名单和缺失/空分配不自动启用。DSH 默认视觉仍需明确加入允许范围，手动实测与旧任务恢复保持独立。连接引用由 DSH Adapter 在操作期间解析，Core 不接收宿主凭据引用。详见 [功能模型池](FUNCTION_MODEL_POOLS.md)与 [连接复用](DSH_PROVIDER_CONNECTIONS.md)。

0.2.4/0.2.5 的严格有序名单规则见 [功能模型分配](FUNCTION_MODEL_ASSIGNMENTS.md)。下方 0.2.2 描述保留当时能力声明变更的背景。

0.2.2按功能组织有序模型候选池，能力来自明确模型标签、旧能力字段绑定或供应商能力元数据。裸账号不物化默认模型，模型名称不授权进入候选链；明确空池与空标签保持权威。模型与供应商复合身份用于底层执行器，功能入口、分配排序及安全 failover 没有改为模型中心产品或默认轮转。旧 0.2.1 的能力推断行为不再用于裸账号或模型名称赋能。

Provider Adapter v0 固定 discovery、submit、poll、cancel、download 与 error mapping 六类生命周期操作；提交前的临时输入上传是可选准备能力，不自动成为 Core 事实。协议实现只接收显式凭据、模型和媒体端点，Core 保存复合模型身份与非敏感 binding，不保存端点原文。

0.2.2 的生图错误将 HTTP 前的尺寸拒绝明确记为未受理，网络异常保留实际请求/正文阶段及可用错误码，原生取消/超时保留原分类。错误诊断不改变受理门，网络超时或正文丢失仍不能触发自动重提。

Core Runner 不拥有后台 timer。Headless `task observe` 每次最多 poll 一次，`task wait` 仅在本次命令内有界观察；DSH 的有界自动观察属于 Host，插件释放时停止 timer 并中止在途观察，但不会把“停止本地观察”写成“远端已取消”。端点或协议 binding 漂移时恢复在联网前拒绝。

每个操作必须明确声明 supported 或 unsupported。当前 DashScope 与 OpenAI Images 媒体协议没有经过验证的远端取消实现，因此取消请求如实返回 not-supported，而不是伪造 canceled。完整受理与错误规则见 [Provider 提交契约 v0](PROVIDER_SUBMISSION_CONTRACT.md)。

## Text/Vision 共享边界

[Text/Vision Model Port v0](MODEL_PORT_CONTRACT.md) 的纯契约、调用控制与 test-only Fake Port 已发布于 0.2.0。它以 `describe()` 和单轮 `complete()` 统一文本/视觉输入、正常终态、预算、取消与安全错误；图片以字节和 MIME 进入共享层，模型选择、会话与附件桥接保留在入口/适配器。

0.2.1通过 `prompt-optimizer-core.js` → `model-invoker.js` → `dsh-text-model-adapter.js` 接入首个提示词消费者；`prompt-optimizer.js` 继续拥有 v1 配置、模型选择、reasoning 策略和 Host 投影。共享核心不读取 Host/配置/Store，不取得 writer，也不创建媒体 Task/Attempt/Artifact。规则与预览见 [提示词优化系统](PROMPT_OPTIMIZER.md)。

0.2.2 的一般提示词功能在这个共享消费者上增加 faithful / rewrite / suggestions 策略：忠实正文由原稿片段按原顺序拼回，建议独立返回并要求明确采纳。五用途和折叠预览属于 DSH UI，不自动进入生图模型池，也不新增自持文本目录、CLI 或公共 SDK。

单图视觉将 Agent/工作台 look/relook 和显式视觉实测接入 `vision-core.js` 与 HTTP/DSH Vision Port：共享 120 秒整体预算、完整终态与候选策略，图片桥接核验原图与实际附件，接受合法宿主规范化。DSH 附件保存属于宿主副作用，不是 Core Artifact；rc.2 保存不可取消的限制如实保留。见 [单图视觉调用](VISION_MODEL.md)。视觉 CLI 复用这些业务；可选 `visionInput` 在入口层控制发送副本。未新增公共 SDK export，自持文本目录和独立提示词入口另行安排。

OCR 切片通过 `ocr-model-routing.js` 在入口解引用前建立整体 operation，`ocr.js` 仅接收图片字节和模型端口，使用现有 Sharp 做有限分块；全部块复用 `completeVision`，没有每块重置计时或调用额度。普通块失败可以产生明确部分结果，取消/超时终止整次操作；不取得 Core writer 或写入 Task/Artifact。见 [长图 OCR](OCR_MODEL.md)。

定位、拼图摘要与生成后自述复用 `runVisionOperation`，`locate.js` / `summarize.js` 消费共享端口；入口处理附件、抽帧和可选 Core 转写，摘要读取已成功转写的文本 Artifact。纯视觉业务不写 Task/Artifact。legacy 视觉兼容实现保留，现有入口不再调用。见 [复合视觉调用](COMPOSITE_VISION.md)。

## Host Port 与 Headless 边界

| 能力 | DSH 来源 | 缺失或 Headless 时行为 |
|---|---|---|
| 工具注册与 Fiber 生命周期 | `ctx.tools` / `ctx.effect` | 不注册 DSH 工具；CLI/Core 不受影响 |
| Web 路由 | `webServer` 或 `httpServer` | 无工作台 API 和同源媒体路由；CLI 直接导出 Artifact |
| UI Slot | DSH Web Client | 不影响 Core Task、Artifact 与离线 Doctor |
| Browser | DSH browser service | CLI 可显式提供独立 Chromium Browser Port；未提供时 HTML 不可用 |
| 会话附件与输入草稿 | session/input ports | CLI 使用显式文件或 JSON 输入，不创建会话对象 |
| Skills registry | DSH skills service | 随包 Skill 不自动注册；CLI/Core 仍可用 |

Command、Core Store、Provider Runner 和 Headless CLI 不接收原始 `ctx`、会话对象或 Browser 对象。Host URL、attachment 与 UI 文案只在 DSH 投影层产生。

## 事件、UI 与媒体读取

DSH 工作台把 Core 与 legacy Task 合并到一个用户任务区，把 Core 与旧 `outputs/` 的图片、视频、音频和文本合并到一个作品区。普通投影只有五类用户状态；原始 Attempt 事实留在高级诊断。刷新、展开、关闭、读取作品和查询状态都不得触发 submit、poll 或隐式修复。

Core 媒体路由按随机 Artifact ID 读取并逐次验证 SHA-256；它没有独立 token。浏览器请求还受可信 Host、`Origin`/`Sec-Fetch-Site` 和 `Referrer-Policy: no-referrer` 约束。Artifact ID 是持有者标识，不等于多租户认证；Iris 与 DSH 仍处于同一本机信任域。

## 非目标与发布边界

- `0.2.1` 不启动独立常驻服务，也不复制 DSH 聊天界面。
- 不迁移到 SQLite/JSONL，不原地改写 0.1.4 数据，不自动接管不确定的写者租约。
- 0.2.1 未新增原生 Gemini、Fal、Replicate 或本地模型协议；注册表只是后续接入点。
- 不把离线测试、一次 canary 或 Headless 可运行等同于公开 Core API 已冻结。
- 发布检查覆盖版本元数据、实际包审计、仓库外安装与跨平台 CI；浏览器/移动端和真实异步重启范围单独记录，不由程序化检查推定通过。
