# 同步媒体结果的交付恢复

Iris 0.2.3 支持从缓存恢复完整同步媒体结果。本地交付失败后，可沿原任务重新交付；Task/Artifact 格式和公开 HTTP 路径保持，不需要迁移旧数据。

未发布的 [固定图片流程](IMAGE_FLOW.md)也将其绑定任务的成功 poll 结果先写入原交付缓存，再按预留 Artifact ID 交付；相应中断只接回原结果，不重新 submit。未绑定 Flow 的异步 Task 沿用原路径，本节其余内容描述 0.2.3 起的同步恢复边界。

## 使用行为

同步 Images、聊天生图、Responses、TTS 或音乐 返回完整结果后，本地写入失败仍记录 `accepted / succeeded / deliveryState=failed`。工作台“重新取回作品”和 CLI `task redeliver` 共用原 Task/Attempt 的恢复路径，不调用 submit、不创建新 Attempt。

- 完整字节已缓存：仅做本地验证和交付，不访问 Provider，也不要求原供应商配置仍存在。
- 完整响应只有 URL，或某些下载未完成：保留原来源，只下载缺少的产物；仍需原供应商/binding。它不 poll 或重新生成。
- 异步任务：保持原来的远端 ID、一次 re-poll 与下载路径。
- 缓存丢失、损坏、身份不匹配或字节校验失败：明确失败，不自动回退到下载或生成。成功后再次重新交付仍拒绝。

全部字节已缓存时可以运行：

```bash
dsh-iris task redeliver task_0123456789abcdef01234567 \
  --data-root /absolute/path/to/iris-data
```

需要访问原供应商取回 URL 时，另提供 `--provider-config /absolute/path/to/providers.json`。本地缓存恢复不增加第二次生成费用；网络下载仍受原服务权限、流量政策和 URL 有效期影响。

## 持久化与中断边界

`delivery-cache/v0/<task_id>/result.json` 是完整同步结果的提交证据，绑定原 Task、Attempt、Provider、模型及可选 binding，预留每件作品的稳定 Artifact ID。内联 base64 先解码为普通私有文件，结果文件最后原子发布；URL 仅保存于私有缓存。Task 只增加可选的 `deliveryCache: true`，不保存 URL 或媒体正文。

URL 下载只有正常完成、实际文件大小与 Adapter 返回值一致并通过媒体类型检查后，才提交包含 size/SHA-256 的 payload 引用。未提交文件不冒充完整缓存；已提交字节在每次恢复时重新校验。缓存已提交但 Task 完成事实尚未落盘时，显式 Task 恢复可从同一 Attempt 的缓存补回成功事实，然后将中断交付置为 failed，等待用户显式重新交付。

Artifact 写入采用缓存预留的 ID。已有完整对象、Manifest 或提交 Record 必须与恢复的内容和中性元数据一致；异常证据保留并拒绝覆盖。第一件作品成功而第二件失败、或作品全部提交而 Task ready 落盘失败时，恢复复用已提交作品，不创建重复 ID。reader、Doctor、查看任务和刷新作品均不触发恢复。

该机制不保证在收到响应与成功保存缓存之间断电/进程退出时仍能找回结果；磁盘写入失败也可能使完整结果无法缓存。缓存发布失败仍保持已生成的 succeeded/failed 事实，不据此自动重提。旧同步失败任务没有保留下来的结果时，不能追溯恢复。签名 URL 过期后也不能保证下载可继续。

## 隐私与生命周期

缓存目录/文件在 POSIX 上分别为 0700/0600。签名 URL、完整媒体和结果来源只在私有缓存中，HTTP DTO、Task JSON、Artifact Manifest、诊断及普通日志不包含这些值。缓存校验不跟随目录或文件符号链接。

完整与未提交缓存不因失败、取消、重启或交付成功而自动删除，因此会占用额外磁盘。缓存随显式 Task 隔离一起移入原可恢复事务，恢复时一并恢复；删除 Task 不连带删除作品。未完成交付的预留 Artifact ID 参与引用保护，既有清理不会接回或清掉它们。不引入后台 TTL、自动清理或新的永久删除入口。

相关契约：[Core Runtime](CORE_RUNTIME_CONTRACT.md)、[Headless CLI](HEADLESS_CLI.md)、[安全边界](SECURITY.md)。
