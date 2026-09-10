# Iris 架构与边界

状态：v0.1.3 已发布实现；v0.1.4 已冻结 Host Adapter v0 契约，提供 test-only Local Host consumer，完成 DSH Adapter 消费者迁移与真实 DSH 隔离 canary，并实现 Provider Adapter v0 完整生命周期与 Host Doctor。

## 当前形态

Iris 目前以 DeepSeek Harness 插件运行。DSH 提供 Agent 工具注册、会话附件、浏览器和 Web UI 插槽；Iris 自己负责供应商配置、媒体动作、可信任务、产物落盘、媒体授权路由和工作台投影。

```text
DSH Host / Cordis
  ├─ Agent tools ───────────────┐
  ├─ Web slots / browser        │
  └─ attachment/session ports   │
                                ▼
                    dsh-host-adapter.js
                    （能力探测 / DTO / 生命周期）
                                │ Host Adapter v0
                                ▼
                         actions.runAction
                         ├─ provider adapters
                         ├─ Task / Attempt v2
                         ├─ media delivery
                         └─ vision / local media tools
                                │
                                ▼
                     $DSH_HOME/iris/v1
                     providers.json · tasks.json
                     artifacts.json · outputs/ · uploads/
```

`lib/index.js` 是 DSH 插件入口，`lib/dsh-host-adapter.js` 是服务端 DSH/Cordis 对象进入 Iris 的唯一映射边界；`lib/client.js` 内部用最小 client slot adapter 隔离 DSH UI Slot。`lib/api.js` 是工作台 HTTP 投影，不是真相来源。Task 的持久事实由 `lib/tasks.js` 管理。

## 已稳定的核心候选

| 模块 | 职责 | DSH 运行时依赖 |
|---|---|---:|
| `task-semantics.js` | Task v2 枚举、旧状态与用户状态派生、自洽校验 | 无 |
| `provider-contract.js` | 提交结果、受理边界、错误脱敏、候选调度 | 无 |
| `provider-adapter.js` | Provider v0 生命周期、canonical 结果与统一调用边界 | 无 |
| `provider-adapters.js` | DashScope / OpenAI Images 协议到 v0 的映射 | 无 |
| `tasks.js` | Task/Attempt 持久化、观察、恢复与交付状态 | 无；数据根仍沿用 `DSH_HOME` |
| `artifacts.js` | 作品库 v0 的最小索引、分页、重建、删除与独立媒体授权 | 无；数据根仍沿用 `DSH_HOME` |
| `doctor.js` | 共用诊断结果模型；离线检查环境/数据，Host 模式检查安全能力快照与注册证据 | 无 |
| `host-runtime.js` | 服务端成功注册账本与受限浏览器握手；不保存 live object | 无 |
| `actions.js` | GUI 与 Agent 共用动作 | 只接收 Host Adapter；部分动作声明 Browser/会话端口 |
| `dsh-host-adapter.js` | DSH capability detection、DTO 与生命周期映射 | 有；唯一服务端 DSH 运行时映射边界 |
| `index.js` | DSH 工具、路由、Skill 与生命周期注册 | 有 |
| `client.js` | DSH Web Slot、工作台、泡泡和提示词入口 | 有 |

0.1.3 没有完整独立 Core 或 Local Host Adapter。0.1.4 先冻结并验证最小 Host Port、Local Host fixture 和 DSH capability detection；完整 Command Service 与非 DSH Provider 执行入口仍属于 0.2.0。

## Task、Attempt 与 Artifact

- 一个用户意图对应一个 Task；每个候选供应商调用对应一个稳定 Attempt。
- Attempt 必须在可能发送计费请求前落盘。只有明确 `not_accepted` 才允许自动 failover。
- 生成结果与本地交付是两类事实。生成成功后下载失败仍保持 `outcome=succeeded`。
- 0.1.4 增加独立作品库 v0：`artifacts.json` 只保存文件、类型、大小、时间和随机令牌，因此清任务历史后仍可浏览作品；它不保存 Prompt、Provider、Model 或任务关系。
- 正式 Artifact Manifest、内容哈希、谱系、收藏、标签和搜索仍属于 0.2.0+；作品库 v0 不是该公共契约。
- 每次 v2 任务变更递增 Task `revision`；完整状态快照另带进程 `stateEpoch/stateRevision`，客户端拒绝同一 epoch 中迟到的旧快照。

详细状态机见 [Task/Attempt v2 语义契约](TASK_SEMANTICS.md)，故障证据见 [故障注入矩阵](FAULT_INJECTION.md)。

## Provider 边界

0.1.4 已实现内部 Provider Adapter v0：`provider-adapter.js` 固定 discovery、submit、poll、cancel、download 与 error mapping 六类操作和 canonical 结果；`provider-adapters.js` 将 DashScope 与 OpenAI Images 映射到契约；`adapters.js` 只保留注入式低层 HTTP transport。动作、恢复、重新交付、模型发现与能力探测不再直接绕过该生命周期边界。

每个操作必须明确声明 supported 或 unsupported。DashScope 的远端 cancel 尚无经过验证的实现，OpenAI Images 的同步路径没有 poll/cancel，它们均以能力事实公开，而不是在运行时以“方法不存在”失败。完整规则见 [Provider Adapter v0 生命周期契约](PROVIDER_ADAPTER_CONTRACT.md)，四态受理规则见 [Provider 提交契约 v0](PROVIDER_SUBMISSION_CONTRACT.md)。

Provider 健康事实位于配置层，以 Provider × Model × Capability 为键保存最近成功、决定性认证失败和临时观察。动作层只在真实 Provider 生命周期结果或显式探针后写入；API 投影按当前 failover 候选汇总，客户端只渲染快照，不自行猜测可用性。成功与明确认证失败的有效窗口均为 7 天；429、网络、5xx、内容安全、取消和 unknown 不会推翻窗口内成功。详见 [Provider 与能力健康状态](PROVIDER_HEALTH.md)。

## Host Port 清单

| 能力 | 当前来源 | 缺失时行为 |
|---|---|---|
| 工具注册与 Fiber 生命周期 | DSH `ctx.tools` / `ctx.effect` | 对应工具不注册；其余能力继续装载 |
| Web 路由 | DSH `webServer` 或 `httpServer` | 工作台 API、媒体链接和 HTML 渲染不可用 |
| UI Slot | DSH Web Client | 不影响 Host 侧任务与离线 Doctor |
| Browser | DSH browser service | 仅 HTML 截图不可用 |
| 会话附件与输入草稿 | DSH session/input ports | 退化为 Iris 自有产物或浏览器上传 |
| Skills registry | DSH skills service | 随包 Skill 不自动注册；核心动作仍可用 |

这些依赖由 `dsh-host-adapter.js` 映射为命名端口，`index.js` 只负责 DSH 插件装配和生命周期入口；客户端 Slot 探测留在 client bundle 的最小 adapter 内。Command、API、提示词优化和视觉后端不接收原始 `ctx`。test-only Local Host fixture 使用同一契约验证无 DSH 降级，但不等同于独立宿主。

## 事件与 UI

Host Doctor 通过已认证的 `/iris/api/doctor` 返回能力和装载证据；客户端只在 Slot 回调实际执行后向 `/iris/api/host-client` 回报插件版本、协议号和 Slot 名称。诊断不调用端口、Browser、模型或 Provider，详见 [Host Doctor](HOST_DOCTOR.md)。

任务、配置和作品索引写入会触发节流 SSE 快照。每份快照都有进程 epoch 与单调序号；慢消费者进入背压后只保留最新快照，重连仍通过持久化全量状态收敛。工作台只展示稳定人类状态，内部事实轴保留在 API 详情中供诊断和人工动作判断。

## 非目标

- 不在 0.1.4 启动独立常驻服务或复制 DSH 聊天界面。
- 不迁移到 SQLite/JSONL，不破坏旧任务读取。
- 0.1.4 不新增 Gemini、Fal 或 Replicate 分支；Provider conformance 完成后仍保持版本范围。
- 不把离线 Doctor 的成功等同于 DSH Host、浏览器或真实供应商已可用。
