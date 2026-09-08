# Iris Task/Attempt v2 语义契约

状态：**v0.1.3 已实现。** Task v2 已覆盖图片、视频、转写与 TTS，包括同步/异步、上传/提交、混合协议候选、工作台稳定用户态、状态流防倒退、重新观察、重新交付、提醒已读/恢复和知情人工重试。正式 Artifact Manifest、完整 Provider/Host Adapter 和宿主扩展诊断仍属于后续版本。

## 1. 为什么需要 v2

媒体生成可能在供应商侧产生费用。网络断开并不能证明请求没有被受理，轮询失败也不能证明远端任务失败，下载失败更不能抹掉已经成功的生成结果。Iris 必须分别记录“有没有提交”“供应商是否受理”“远端结果是什么”“是否仍在观察”“产物是否已取回”和“取消是否得到确认”。

本契约使用以下规范词：**必须**表示不可违反的安全或事实约束；**应该**表示除非有记录充分的理由，否则需要遵守；**可以**表示可选行为。

## 2. 核心对象

- **Task**：一次用户意图。无论尝试过多少供应商，一个用户请求只能创建一个 Task。
- **Attempt**：Task 针对一个 `providerId::modelId` 的一次提交尝试。Attempt 必须在可能发送计费请求前持久化。
- **受理证据**：远端任务 ID、同步成功响应，或供应商明确声明已受理的其他稳定标识。
- **观察**：对已受理远端任务进行轮询或恢复接管，不等同于再次提交。
- **交付**：把远端结果下载、校验并原子保存为 Iris 本地产物。

Task 与 Attempt 使用稳定 ID。Attempt 的 `model` 与 Task 的权威 `modelRef` 必须保存复合身份 `providerId::modelId`；迁移期 Task 仍可额外保留裸 `model` 供 v0.1.2 UI 读取，但新逻辑不得以该兼容字段判断模型身份。

## 3. 正交状态

Task v2 至少包含以下事实轴；字段值采用可序列化的 snake_case 英文枚举：

| 字段 | 值 | 含义 |
|---|---|---|
| `phase` | `queued` · `submitting` · `accepted` · `running` · `terminal` | Iris 当前是否还会自动推进该任务 |
| `acceptance` | `none` · `not_accepted` · `accepted` · `unknown` | 当前/最终 Attempt 的远端受理事实 |
| `watchState` | `idle` · `active` · `suspended` · `exhausted` | Iris 是否仍在观察远端任务 |
| `outcome` | `none` · `succeeded` · `failed` · `canceled` · `unknown` | 远端生成或确定性本地动作的结果 |
| `deliveryState` | `none` · `pending` · `downloading` · `ready` · `failed` | 成功结果是否已经可靠落成本地产物 |
| `cancelState` | `none` · `requested` · `remote_confirmed` · `local_confirmed` · `unknown` | 取消请求及其确认边界 |

`status` 仅为旧消费者保留，不再是真相来源。新代码必须读取上述字段。

### 3.1 旧 `status` 的保守派生

| v2 事实 | 旧 `status` |
|---|---|
| `outcome=succeeded` 且 `deliveryState=ready` | `succeeded` |
| `outcome=failed` | `failed` |
| `outcome=canceled` 且取消已由远端或确定性本地动作确认 | `canceled` |
| 其余，包括受理未知、观察耗尽和交付失败 | `running` |

四态旧字段无法无损表达“需要人工处理”。派生时宁可保持非终态，也不得伪造失败、成功或取消。现代 UI 必须使用 v2 事实轴。

## 4. 受理与自动 failover

自动 failover 的许可只由受理事实决定：

| `acceptance` | 允许自动切换 Provider | 说明 |
|---|---:|---|
| `none` | 否 | 尚未形成最终分类，必须先收敛为明确状态 |
| `not_accepted` | 是 | 已确认计费/生成请求没有被供应商受理 |
| `accepted` | 否 | 已有受理证据，再次提交可能重复计费 |
| `unknown` | 否 | 请求可能已经被受理，必须保守停止 |

以下信息都**不能**单独授权自动 failover：`retryable=true`、HTTP 429/500、超时、连接重置、JSON 解析失败、轮询失败、下载失败、本地持久化失败或事件发布失败。

### 4.1 分类规则

- 本地参数校验失败、请求发送前明确中止，或供应商明确拒绝且确认未创建任务：`not_accepted`。
- 收到远端任务 ID、同步成功响应或等价证据：`accepted`。
- 请求可能已经离开本机，但响应在获得受理证据前丢失：`unknown`。
- 无法证明“未受理”时，必须选择 `unknown`，不得为了可用性猜测 `not_accepted`。

如果供应商支持幂等键，Attempt 应记录并复用该键；幂等能力可以帮助查询或安全恢复，但在未经合约证明前，不能把“发了幂等键”等同于“可以随意重试”。

最小 Provider 返回结构、写前/写后 Hook 和错误字段详见[Provider 提交契约 v0](PROVIDER_SUBMISSION_CONTRACT.md)。

## 5. Attempt 写前记录

每次 Attempt 必须在可能发送生成请求前至少保存：

```json
{
  "id": "attempt_...",
  "ordinal": 1,
  "providerId": "provider-a",
  "model": "provider-a::model-a",
  "acceptance": "none",
  "stage": "preparing",
  "idempotencyKey": "optional-provider-key",
  "startedAt": "2026-09-06T00:00:00.000Z"
}
```

上传临时输入与提交生成任务必须是不同 stage。上传成功并不等于生成请求已受理；但上传、提交和响应解析的错误证据都必须保留为脱敏分类，而不是一段不可机读的字符串。

## 6. 远端结果与产物交付

- 远端返回成功后立即记录 `outcome=succeeded`，然后进入 `deliveryState=pending/downloading`。
- 下载、校验或本地落盘失败时，保持 `outcome=succeeded`，写入 `deliveryState=failed`。
- 交付失败只允许重新下载/落盘，不允许重新生成。
- 只有本地产物完成原子落盘并可读后，才写 `deliveryState=ready`。
- 供应商明确返回生成失败时才写 `outcome=failed`。

## 7. 观察、超时与恢复

- 单次或连续轮询失败只改变观察事实；不得据此写 `outcome=failed`。
- 达到本地盯守上限时写 `watchState=exhausted`，结果通常为 `outcome=unknown`。
- 插件关闭或进程退出导致观察停止时，应保留可恢复信息；重启只能恢复观察，不能重新提交已受理或受理未知的 Attempt。
- `accepted` 的异步 Attempt 若供应商配置暂不可用，应进入 `watchState=suspended` 并给出修复建议，不能伪造远端失败。
- `unknown` 且没有远端任务 ID 时，只能等待供应商查询能力、幂等查询或用户知情决策。

## 8. 取消

- 用户请求取消时先写 `cancelState=requested`。
- 供应商明确确认取消后，写 `cancelState=remote_confirmed` 与 `outcome=canceled`。
- 纯本地、尚未产生远端副作用的动作确定停止后，可以写 `cancelState=local_confirmed` 与 `outcome=canceled`。
- 仅停止本地轮询不等于远端取消。
- 取消请求超时、断网、供应商不支持取消或结果无法确认时，写 `cancelState=unknown`；`outcome` 也不得伪造为 `canceled`。

## 9. 错误与隐私

结构化错误至少应区分 stage、category、HTTP 状态、供应商错误码、受理状态和可安全展示的信息。任务、Attempt、事件与日志不得保存 API Key、Authorization 头、完整请求体、私有绝对路径或带临时签名的结果 URL。

错误是否“可重试”与是否“允许自动重新提交”是两个不同问题。前者描述技术性质，后者只能由 `acceptance=not_accepted` 授权。

## 10. 事件与 UI

- 每次 Task v2 持久化变更得到单调递增的 Task `revision`。完整状态快照另带进程 `stateEpoch/stateRevision`；客户端拒绝同一 epoch 内迟到的旧快照，SSE 重连后以持久化全量快照收敛。
- SSE 慢消费者进入背压时只保留最新待发快照，避免旧状态排队造成内存增长或视觉倒退。
- UI 应把事实映射成“排队中、运行中、观察暂停、需要确认、结果待取回、已完成、明确失败、已取消”等人类状态，不应在手机界面直接堆叠所有内部字段。
- `acceptance=unknown`、`cancelState=unknown` 和 `deliveryState=failed` 必须提供明确的人工接管入口；任何可能再次计费的操作都需要单独确认。
- 提醒处置与任务事实正交：标为已读只把任务移出主动提醒队列，恢复提醒只重新开放该队列；两者都不得修改受理、观察、结果、交付或取消事实。
- 知情重试创建并关联新 Task 后，原提醒自动记录为“已通过重试处理”。原任务保留原始未知事实和审计记录，但不继续产生重复角标；用户可从历史详情恢复提醒。

## 11. 兼容与迁移

- v0.1.x 只允许向现有 JSON 记录增加字段，不执行破坏性批量迁移，不顺带引入 SQLite/JSONL。
- 旧记录缺少 v2 字段时，由纯兼容规范化器生成内存视图：既有成功记录保留成功证据；转存失败映射为远端成功但交付失败；轮询失败、无远端 ID 的运行记录和旧取消记录映射到 `unknown`，不能猜测失败、未受理或远端已取消。
- 读取旧任务不应立即重写整个文件；只有真实更新发生时才按原子写规则保存扩展后的记录。
- 在 v2 UI 和消费者完成迁移前继续输出派生 `status`。

## 12. 必须通过的故障证据

故障注入至少覆盖：请求发送前失败、提交响应丢失、获得远端 ID 后本地落盘失败、轮询 429/500/超时、远端成功后下载失败、取消响应丢失，以及 `submitting/accepted/running` 阶段的进程退出与恢复。

每个场景必须同时断言最终事实字段和供应商提交调用次数。对于 `accepted` 或 `unknown`，自动重复提交次数必须为 **0**。

## 13. 本版非目标

- 不在语义冻结阶段重写全部任务存储或 UI。
- 不新增 Gemini、Fal、Replicate 等供应商分支。
- v0.1.3 包含零网络、可独立运行的离线 Doctor v0 与最薄 CLI；依赖 DSH `ctx` 的宿主扩展诊断、完整 Host Adapter 和 Artifact Manifest 不属于本版。
- 不用更多自动重试换取表面成功率。
