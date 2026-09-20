# Iris 架构与边界

状态：`0.1.4` 是 npm 与 DSH 市场的当前稳定版本；当前源码分支是 `0.2.0-rc.1` 开发检查点，不是发布。该检查点已经建立可在无 DSH 进程中运行的实例化 Core Runtime、Headless CLI、共享 Provider 生命周期、Core Task/Attempt 与 Artifact Manifest，并让 DSH 逐项消费同一套事实；发布门禁和稳定 Core API 仍未冻结。

## 当前形态

Iris 仍以一个 npm 包交付，但已有两个执行入口：DSH 插件负责 Agent 工具、会话附件、浏览器、Web UI 和后台观察；Headless CLI 在没有 DSH/Cordis 的进程中显式接收数据根与私有 Provider 配置。两者共用 Core Runtime、Provider Task Runner、Task/Artifact Store 和本地 Command，不能在同一数据根上同时充当写者。

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
                    crop / diff / frames        submit / observe /
                    inspect / control           cancel / delivery
                              └────────────┬────────────┘
                                           ▼
                         Core Task Store + Artifact Manifest
                         records · objects · SHA-256 · index
                                           │
                    DSH: $DSH_HOME/iris/v1/core-v0
                    CLI: explicit absolute data root
```

`lib/index.js` 是 DSH 插件装配入口，`lib/dsh-host-adapter.js` 是原始 DSH/Cordis 对象进入 Iris 的服务端边界；`lib/dsh-core-adapter.js` 只负责选择 DSH profile 的 Core 数据根、恢复 Provider 配置和投影 Host DTO。`bin/dsh-iris.js` 不启动 DSH，也不推断 profile。`lib/api.js` 与 `lib/client.js` 是 Host 投影，不是真相来源。

未迁移能力仍走 0.1.4 legacy 链。当前主要包括 s2v 数字人视频、视觉理解、长图 OCR、媒体摘要、HTML 渲染和提示词优化；它们不会被伪装成 Core 能力。

## 0.2.0-rc.1 候选核心

| 模块 | 职责 | DSH 运行时依赖 |
|---|---|---:|
| `core-contract.js` / `core-runtime.js` | 显式数据根、reader/writer 权限、单写者租约、取消与释放 | 无 |
| `command-service.js` | 本地媒体命令、Task 控制面和 Artifact 查询/导出 | 无 |
| `core-tasks.js` | Core Task/Attempt 持久事实、受理与交付状态 | 无 |
| `core-artifacts.js` / `core-artifact-store.js` | 对象、Manifest、SHA-256、关系边与可重建 Index | 无 |
| `provider-contract.js` / `provider-adapter.js` | canonical 结果、错误脱敏、受理边界与 Provider v0 操作 | 无 |
| `provider-adapters.js` | DashScope / OpenAI Images 协议实现和可选输入准备 | 无 |
| `provider-task-runner.js` | 写前 Attempt、submit/poll/cancel/download 与 Profile 化交付 | 无 |
| `core-doctor.js` / `core-lease-recovery.js` | 只读完整性诊断与需显式确认的陈旧租约恢复 | 无 |
| `provider-catalog.js` | 显式 Provider 配置、能力候选和原 Task Adapter 恢复 | 无 |
| `dsh-core-adapter.js` | DSH 数据根、后台观察与 Core 到 Host 的投影 | 有；DSH 专属边界 |
| `dsh-host-adapter.js` / `index.js` | Host 能力映射、工具/路由/Skill 与生命周期装配 | 有 |
| `client.js` | DSH Web Slot、统一任务/作品区、泡泡和提示词入口 | 有 |

完整规则见 [Core Runtime v0](CORE_RUNTIME_CONTRACT.md)、[Artifact Manifest v0](ARTIFACT_MANIFEST.md)、[Provider Adapter v0](PROVIDER_ADAPTER_CONTRACT.md) 与 [DSH → Core 渐进迁移](DSH_CORE_MIGRATION.md)。这些是 rc 候选内部契约，不是第三方 SDK 兼容承诺。

## Task、Attempt 与 Artifact

- 一个用户意图对应一个 Core Task；每次候选供应商调用对应一个稳定 Attempt。Attempt 必须在可能发送计费请求前落盘。
- 只有明确 `not_accepted` 才允许自动切换候选；`accepted` 或 `unknown` 后禁止自动重提。重试会创建新 Task，并要求用户再次提供未持久化的输入和明确确认潜在费用。
- 生成结果与本地交付是两类事实。远端成功后下载失败仍保持 `outcome=succeeded / deliveryState=failed`，可显式重新交付而不重新生成。
- 新 Attempt 可选保存阶段时间戳与模型选择来源；旧记录缺少这些字段仍可读取。
- Artifact Manifest v0 保存内容哈希、媒体类型、中性元数据和关系边；不保存 Prompt、API Key、签名 URL、Provider 端点或宿主绝对路径。
- Core Task/Artifact 的删除与清理能力在 0.2.0 中保持封闭：DSH 与 CLI 都不提供 delete、clear 或 orphan purge。Doctor 只报告，不自动修复。

0.1.4 的 `tasks.json`、`artifacts.json`、`outputs/` 与上传目录继续作为 legacy 数据存在；Core 使用隔离的 `core-v0`。已迁移的新图片、视频、TTS 与转写任务不双写 legacy，回退到 0.1.4 时也不删除或改写 Core 数据。

## Provider 边界

Provider Adapter v0 固定 discovery、submit、poll、cancel、download 与 error mapping 六类生命周期操作；提交前的临时输入上传是可选准备能力，不自动成为 Core 事实。协议实现只接收显式凭据、模型和媒体端点，Core 保存复合模型身份与非敏感 binding，不保存端点原文。

Core Runner 不拥有后台 timer。Headless `task observe` 每次最多 poll 一次；DSH 的有界自动观察属于 Host，插件释放时停止 timer 并中止在途观察，但不会把“停止本地观察”写成“远端已取消”。端点或协议 binding 漂移时恢复在联网前拒绝。

每个操作必须明确声明 supported 或 unsupported。当前 DashScope 与 OpenAI Images 媒体协议没有经过验证的远端取消实现，因此取消请求如实返回 not-supported，而不是伪造 canceled。完整受理与错误规则见 [Provider 提交契约 v0](PROVIDER_SUBMISSION_CONTRACT.md)。

## Host Port 与 Headless 边界

| 能力 | DSH 来源 | 缺失或 Headless 时行为 |
|---|---|---|
| 工具注册与 Fiber 生命周期 | `ctx.tools` / `ctx.effect` | 不注册 DSH 工具；CLI/Core 不受影响 |
| Web 路由 | `webServer` 或 `httpServer` | 无工作台 API 和同源媒体路由；CLI 直接导出 Artifact |
| UI Slot | DSH Web Client | 不影响 Core Task、Artifact 与离线 Doctor |
| Browser | DSH browser service | HTML 渲染不可用；本地媒体命令不受影响 |
| 会话附件与输入草稿 | session/input ports | CLI 使用显式文件或 JSON 输入，不创建会话对象 |
| Skills registry | DSH skills service | 随包 Skill 不自动注册；CLI/Core 仍可用 |

Command、Core Store、Provider Runner 和 Headless CLI 不接收原始 `ctx`、会话对象或 Browser 对象。Host URL、attachment 与 UI 文案只在 DSH 投影层产生。

## 事件、UI 与媒体读取

DSH 工作台把 Core 与 legacy Task 合并到一个用户任务区，把 Core 图片与旧 `outputs/` 合并到一个作品区。普通投影只有五类用户状态；原始 Attempt 事实留在高级诊断。刷新、展开、关闭、读取作品和查询状态都不得触发 submit、poll 或隐式修复。

Core 媒体路由按随机 Artifact ID 读取并逐次验证 SHA-256；它没有独立 token。浏览器请求还受可信 Host、`Origin`/`Sec-Fetch-Site` 和 `Referrer-Policy: no-referrer` 约束。Artifact ID 是持有者标识，不等于多租户认证；Iris 与 DSH 仍处于同一本机信任域。

## 非目标与发布边界

- `0.2.0-rc.1` 不启动独立常驻服务，也不复制 DSH 聊天界面。
- 不迁移到 SQLite/JSONL，不原地改写 0.1.4 数据，不自动接管不确定的写者租约。
- 不在本候选新增 Gemini、Fal、Replicate 或本地模型协议；注册表只是后续接入点。
- 不把离线测试、一次 canary 或 Headless 可运行等同于公开 Core API 已冻结。
- rc.1 仍须通过最终包审计、仓库外安装、跨平台 CI、Android 目视、回退和机器可读验证摘要后才能发布。
