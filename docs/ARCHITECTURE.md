# Iris 架构与边界

状态：v0.1.3 当前实现。本文描述已经存在的代码边界，不把 0.2+ 规划写成现成功能。

## 当前形态

Iris 目前以 DeepSeek Harness 插件运行。DSH 提供 Agent 工具注册、会话附件、浏览器和 Web UI 插槽；Iris 自己负责供应商配置、媒体动作、可信任务、产物落盘、媒体授权路由和工作台投影。

```text
DSH Host / Cordis
  ├─ Agent tools ───────────────┐
  ├─ Web slots / browser        │
  └─ attachment/session ports   │
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
                     outputs/ · uploads/
```

`lib/index.js` 是 DSH Host Adapter 的当前集中入口；`lib/client.js` 只消费同源 API 与 DSH UI Slot。`lib/api.js` 是工作台 HTTP 投影，不是真相来源。Task 的持久事实由 `lib/tasks.js` 管理。

## 已稳定的核心候选

| 模块 | 职责 | DSH 运行时依赖 |
|---|---|---:|
| `task-semantics.js` | Task v2 枚举、旧状态与用户状态派生、自洽校验 | 无 |
| `provider-contract.js` | 提交结果、受理边界、错误脱敏、候选调度 | 无 |
| `tasks.js` | Task/Attempt 持久化、观察、恢复与交付状态 | 无；数据根仍沿用 `DSH_HOME` |
| `doctor.js` | 零网络离线环境与数据诊断 | 无 |
| `actions.js` | GUI 与 Agent 共用动作 | 有宿主上下文参数，部分动作依赖 Browser/会话能力 |
| `index.js` | DSH 工具、路由、Skill 与生命周期注册 | 有 |
| `client.js` | DSH Web Slot、工作台、泡泡和提示词入口 | 有 |

0.1.3 不声称已有完整独立 Core 或 Local Host Adapter。完整 Command Service、Host Port 接口和非 DSH 运行入口属于后续版本；本版先保证任务语义与离线 Doctor 不依赖 DSH 包即可执行。

## Task、Attempt 与 Artifact

- 一个用户意图对应一个 Task；每个候选供应商调用对应一个稳定 Attempt。
- Attempt 必须在可能发送计费请求前落盘。只有明确 `not_accepted` 才允许自动 failover。
- 生成结果与本地交付是两类事实。生成成功后下载失败仍保持 `outcome=succeeded`。
- 当前 Artifact 仍由任务中的文件、媒体令牌和附件记录表示；正式 Artifact Manifest、内容哈希和谱系属于 0.2.0。
- 每次 v2 任务变更递增 Task `revision`；完整状态快照另带进程 `stateEpoch/stateRevision`，客户端拒绝同一 epoch 中迟到的旧快照。

详细状态机见 [Task/Attempt v2 语义契约](TASK_SEMANTICS.md)，故障证据见 [故障注入矩阵](FAULT_INJECTION.md)。

## Provider 边界

现有 DashScope 与 OpenAI Images 兼容分支仍位于 `adapters.js`，尚未宣称完整 Provider SDK。0.1.3 已冻结供应商提交所需的最小契约：复合模型身份、写前 Hook、四类提交结果、受理证据和安全错误。新增 Provider 不应绕过该契约直接在失败时切换候选。

完整接口与 conformance runner 延后到 0.1.4+，见 [Provider 提交契约 v0](PROVIDER_SUBMISSION_CONTRACT.md)。

## Host Port 清单

| 能力 | 当前来源 | 缺失时行为 |
|---|---|---|
| 工具注册与 Fiber 生命周期 | DSH `ctx.tools` / `ctx.effect` | 对应工具不注册；其余能力继续装载 |
| Web 路由 | DSH `webServer` 或 `httpServer` | 工作台 API、媒体链接和 HTML 渲染不可用 |
| UI Slot | DSH Web Client | 不影响 Host 侧任务与离线 Doctor |
| Browser | DSH browser service | 仅 HTML 截图不可用 |
| 会话附件与输入草稿 | DSH session/input ports | 退化为 Iris 自有产物或浏览器上传 |
| Skills registry | DSH skills service | 随包 Skill 不自动注册；核心动作仍可用 |

这些依赖目前由 `index.js` 的可选注入和守卫集中处理。0.1.4 将把它们转成正式 Host Adapter 接口并增加 Local Host fixture。

## 事件与 UI

任务和配置写入会触发节流 SSE 快照。每份快照都有进程 epoch 与单调序号；慢消费者进入背压后只保留最新快照，重连仍通过持久化全量状态收敛。工作台只展示稳定人类状态，内部事实轴保留在 API 详情中供诊断和人工动作判断。

## 非目标

- 不在 0.1.3 启动独立常驻服务或复制 DSH 聊天界面。
- 不迁移到 SQLite/JSONL，不破坏旧任务读取。
- 不新增 Gemini、Fal 或 Replicate 分支。
- 不把离线 Doctor 的成功等同于 DSH Host、浏览器或真实供应商已可用。
