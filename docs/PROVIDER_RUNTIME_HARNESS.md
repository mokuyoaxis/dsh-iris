# FakeProvider 生命周期验收器

FakeProvider harness 是 Core 的零网络生命周期验收器，不是可配置的正式供应商，也不会出现在用户模型列表中。它以脚本化 fixture 驱动真实 Provider Adapter v0、Core Runtime、Task/Attempt v0 和 Artifact v0，验证远端任务边界而不产生 API 请求或费用。

## 覆盖链路

```text
Task → 写前 Attempt → submit → accepted → poll
                                      ├─ pending → 重启 → poll
                                      ├─ succeeded → download → Artifact
                                      ├─ failed / unknown / canceled
                                      └─ cancel → confirmed / unknown
```

- `submit` 前必须先持久化稳定 Attempt ID；写前失败时 Provider 调用次数为零。
- 只有明确 `not_accepted` 才能进入下一候选；`accepted` 或 `acceptance_unknown` 后禁止自动重提。
- 已落盘 `remoteTaskId` 的任务可由新 Runtime 恢复观察；停在 `submitting` 且没有受理结果的记录只能恢复为 `unknown`。
- Provider 成功与本地交付是两个事实。下载失败保留 `outcome=succeeded`、`deliveryState=failed`；重新交付只执行 `poll/download`。
- 只有 Provider 明确返回 `canceled` 才记录 `remote_confirmed`；不支持或结果未知均保持 `outcome=unknown`。
- 取消响应落盘前中断会恢复为未知；待交付或下载中断保留远端成功并标记交付失败，不自动重新生成。
- 下载 URL 只在单次调用内存中传递，不写入 Task。成功文件进入 Core Artifact，Host URL、DSH attachment 和会话展示不属于 Core 事实。

## 当前限制

每次 `observe` 只轮询一次，不拥有后台 timer；同一 Runtime 内同一 Task 的并发操作以 `IRIS_PROVIDER_TASK_BUSY` 拒绝。交付只验收一个 `image/png` 产物；重新交付需有持久化的远端任务 ID。Task v0 尚未迁移 0.1.4 的任务文件，也未形成公开 package export。多产物、内容哈希、关系边、索引重建和孤儿回收由 Artifact Manifest 阶段完成。

运行单项验收：

```bash
node tests/provider-task-runner.mjs
```

完整回归仍使用 `npm test` 和 `npm run lint`。
