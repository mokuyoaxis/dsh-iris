# Iris Provider 提交契约 v0

状态：**v0.1.3 最小内部契约，已覆盖现有生成能力。** 图片、视频、转写与 TTS 均执行本契约；完整 discovery、poll、cancel、download conformance 留到 v0.1.4。

## 提交结果

Provider `submit()` 必须返回以下四种结构之一：

```js
{ kind: 'completed', value }
{ kind: 'accepted', remoteTaskId }
{ kind: 'not_accepted', error }
{ kind: 'acceptance_unknown', error }
```

- `completed`：同步请求已成功完成，是明确受理证据。
- `accepted`：异步请求已受理，必须包含非空 `remoteTaskId`。
- `not_accepted`：有证据确认生成请求未被受理，是唯一允许自动切换候选的结果。
- `acceptance_unknown`：请求可能已到达供应商，但没有拿到受理证据；必须停止自动提交。

适配器抛出的普通异常默认转换为 `acceptance_unknown`。只有显式携带 `acceptance: 'not_accepted'` 的结构化错误才允许 failover；`retryable`、429、500、timeout 或 network 等分类不能单独授权重新提交。

## 写前与写后 Hook

候选调度必须接收 `beforeAttempt`：

1. 生成 Attempt 的 ordinal、Provider 与复合模型身份；
2. 调用 `beforeAttempt` 原子持久化，并返回稳定、非空的 Attempt ID；Hook 不得覆盖候选身份；
3. 只有 Hook 成功后才能调用 Provider；
4. Provider 返回后用 `afterResult` 保存受理事实。

`beforeAttempt` 失败时供应商调用次数必须为 0。`afterResult` 失败时，无论供应商结果为何，都必须停止候选调度；若已经受理，受理事实不能因为本地落盘失败而被降级。

## 安全错误记录

可持久化错误只包含：

```json
{
  "stage": "submit",
  "category": "network",
  "acceptance": "unknown",
  "retryable": true,
  "httpStatus": 503,
  "providerCode": "optional-safe-code",
  "safeMessage": "redacted message"
}
```

错误 stage 固定为 `validate/prepare/upload/submit/response/poll/cancel/download/persist/emit`；category 固定为 `invalid_request/authentication/quota/rate_limit/network/timeout/aborted/provider/protocol/local_io/unknown`。

错误记录不得包含 `cause`、stack、请求体、响应正文、API Key、Authorization、POSIX/Windows 私有绝对路径或签名 URL。调用方可以在当前进程中保留原始异常用于调试，但不得把它当作 Task/Attempt JSON 或事件载荷。

## 当前接入边界

`lib/provider-contract.js`、Task v2 复制落盘原语和零网络 Fake Provider 已冻结本契约。完整图片能力现在都会在请求前写入 Attempt：DashScope 旧异步返回远端 ID 后进入观察；DashScope 新同步与 OpenAI Images 的成功响应记为 `completed/accepted`，随后独立推进本地产物交付。异步与同步候选可以在同一个 Task 中安全切换。

429 等可证明未创建任务的明确 4xx 拒绝可进入下一候选；408、409、425、499、5xx、网络异常、超时和成功响应缺少必要结果一律停止并记录 `acceptance=unknown`。同步生成已经成功后，下载或落盘失败记录为 `outcome=succeeded / deliveryState=failed`，不会重新生成。

视频、转写与 TTS 也已使用相同边界：视频和转写分别持久化 `prepare/upload/submit` stage，上传失败只表示生成请求未受理；TTS 同步成功则先记 `completed/accepted` 再交付音频。工作台已经消费稳定的人类状态，并提供重新观察、重新交付、提醒已读/恢复和需确认费用的知情重试；v0.1.4 再完成 discovery、poll、cancel、download 等完整 Provider conformance。
