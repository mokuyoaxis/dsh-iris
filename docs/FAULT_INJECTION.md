# v0.1.3 故障注入矩阵

状态：本矩阵全部使用本地 fixture、Fake Provider、Mock Fetch 或临时目录，不发送真实供应商请求。

| 场景 | 预期事实 | 自动重复提交 | 证据 |
|---|---|---:|---|
| 请求前/上传前失败 | `not_accepted`；可以尝试下一候选 | 仅下一候选一次 | `provider-contract.mjs`、`generation-actions.mjs` |
| 上传成功、提交响应 500/丢失 | `acceptance=unknown` | 0 | `transcribe-task-acceptance-unknown.mjs`、`video-task-acceptance-unknown.mjs` |
| 图片 500、断网或缺远端 ID | `acceptance/outcome=unknown` | 0 | `image-task-acceptance-unknown.mjs` |
| 已受理后结果落盘失败 | 保留已受理结果并返回本地 persist 错误 | 0 | `provider-contract.mjs` |
| 已受理后轮询 429/500/超时 | `watchState=exhausted`、`outcome=unknown` | 0 | `task-runtime-faults-v2.mjs` |
| 供应商明确返回任务失败 | `outcome=failed` | 0 | `task-runtime-faults-v2.mjs` |
| 已成功但下载/本地写入失败 | `outcome=succeeded`、`deliveryState=failed` | 0 | `task-store-v2.mjs`、`image-task-mixed-v2.mjs` |
| 进程在 submitting 阶段退出 | 无受理证据时转为 unknown，禁止恢复提交 | 0 | `task-store-v2.mjs` |
| 进程在 accepted/running 阶段退出 | 只恢复观察；供应商缺失则 suspended | 0 | `task-runtime-faults-v2.mjs` |
| 已成功、交付中途退出 | 保留 succeeded，交付标 failed | 0 | `task-runtime-faults-v2.mjs` |
| 取消时无法确认远端结果 | `cancelState/outcome=unknown` | 0 | `task-store-v2.mjs`、`task-manual-recovery-v2.mjs` |
| tasks/config 截断或结构损坏 | 隔离原文件并保留证据 | 0 | `damage.mjs`、`doctor.mjs` |
| SSE 断开、重连、迟到快照、慢消费者 | 全量快照收敛；旧序号被拒绝；背压只保留最新 | 0 | `api.mjs`、`client.mjs` |
| 上传中断、过期文件与 `.part` 残留 | 临时文件清理；不影响正式产物 | 0 | `api.mjs` |
| 旧任务附件超出最近索引 | 从完整任务历史解析，不依赖最近 50 条 | 0 | `generation-actions.mjs` |
| 人工重新观察/重新交付 | 只轮询或下载，不提交 | 0 | `task-manual-recovery-v2.mjs` |
| 标为已读/恢复提醒 | 只写本地提醒审计元数据，不改变任务事实 | 0 | `task-manual-recovery-v2.mjs` |
| 用户知情人工重试 | 独立确认、建立新 Task 关系并归档原提醒 | 明确授权后 1 | `task-manual-recovery-v2.mjs` |

矩阵的硬性规则是：只要已有 `accepted` 或 `unknown` 事实，任何自动路径的生成提交次数增量必须为 **0**。人工重试不属于自动恢复；它必须由用户逐次确认，并在数据中保留新旧 Task 的关系。
