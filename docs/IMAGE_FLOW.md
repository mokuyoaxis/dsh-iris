# 固定图片流程（0.2.7）

未发布源码可通过 [Core 执行服务](CORE_SERVICE.md)、正式 MCP 和 DSH 可选共享 Flow 连接消费同一固定流程，另有显式启用的 [owner 持久选择 API](LOCAL_SELECTION.md)。本文保留已发布 0.2.7 的 CLI 使用方式；真实 Web 页面的创作与选择按钮尚未接入。

0.2.7 提供 `image-edit/v0`：导入原图 → 指定模型改图 → 本地像素比较 → 选择原图或新版 → 导出。真实执行入口是独立 CLI 和内部应用运行时，尚未接入 DSH 工作台或真实独立 Web；[Web Demo](WEB_PROTOTYPE.md)仅说明面向 0.3.0 的交互方向。本流程从 npm 0.2.7 起随包分发。

0.2.7 另提供 [默认只读 API](LOCAL_API.md)查看已有流程与图片；新空专用根可主动启用 [本地上传与创建](LOCAL_CREATION.md)。这些 HTTP 入口不执行/继续流程，也不把 CLI 的导出路径暴露给浏览器。

## 初始化与创建

先选择一个新的、空的专用 Core 数据根。`flow init` 不迁移现有 DSH/CLI 数据根；初始化后才向它导入图片。已有有效流程根上再次执行 init 不改变声明。

```bash
dsh-iris flow init --data-root /absolute/path/flow-core
dsh-iris artifact import --data-root /absolute/path/flow-core --input '{"image_path":"/absolute/path/source.png"}'
```

使用返回的 Artifact ID 编写输入文件，例如：

```json
{
  "source_artifact_id": "artifact_<返回的24位十六进制ID>",
  "model_ref": "providerId::modelId",
  "prompt": "将背景改成绿色，保留主体",
  "n": 1
}
```

替换示例中的 ID 与模型，保存为 `/absolute/path/edit.json`，再创建流程：

```bash
dsh-iris flow create --data-root /absolute/path/flow-core --provider-config /absolute/path/providers.json --input-file /absolute/path/edit.json
dsh-iris flow list --data-root /absolute/path/flow-core
```

create 只验证原图、模型允许范围与改图协议，保存输入和预留身份，**不提交生成请求**。首版要求明确模型、单张结果 `n=1`，可选 `size`；支持现有聊天图片和原生 Qwen 改图协议。Provider 配置仍按 [功能池](FUNCTION_MODEL_POOLS.md)和 [CLI 配置](HEADLESS_CLI.md)处理。

## 执行、选择与导出

将下方引号内的占位 ID 替换为 create 返回的 Run ID。首次 continue 可能调用指定模型并产生费用：

```bash
dsh-iris flow continue 'run_<24hex>' --data-root /absolute/path/flow-core --provider-config /absolute/path/providers.json
dsh-iris flow inspect 'run_<24hex>' --data-root /absolute/path/flow-core
dsh-iris flow select 'run_<24hex>' --data-root /absolute/path/flow-core --input '{"artifact_id":"artifact_<原图或新版ID>"}'
dsh-iris flow export 'run_<24hex>' --data-root /absolute/path/flow-core --output /absolute/path/selected.png
```

continue 对同一 Run 复用预留 Task；已有 Attempt 后不重新 submit，也不按新模型池顺序改绑。已受理任务每次至多观察一次，生成成功但交付中断时恢复原缓存或原远端任务。完成结果不需要 Provider 配置即可继续、查看、选择和导出。连接端点/协议漂移、输入摘要不符或作品缺失会拒绝相应操作；API Key 轮换遵守原 Task 配置规则。

| `status` | 含义 |
|---|---|
| `not_started` | 尚未提交；再次 continue 可执行首次生成 |
| `running` | 原任务仍在执行，后续 continue 仅观察原任务 |
| `needs_attention` | 未知受理、失败、取消或缺少可靠完成事实；不会自动重提 |
| `delivery_failed` | 生成已成功，本地交付尚未完成 |
| `needs_comparison` | 原 Task 已交付，流程的本地比较尚未完成 |
| `awaiting_selection` | 改图和比较完成，等待明确选择 |
| `selected` | 已选择原图或新版，尚不代表已导出 |

像素比较只描述差异，不证明修改符合创作要求。选择仅接受本流程的原图或新版；重复选择相同作品不改记录。导出路径只用于当次调用，不写入 Run，不自动恢复外部路径写入，也不覆盖现有文件。需要重新生成时应明确新建 Run，原 Run 不自动采用 `task retry` 创建的新任务。

## 持久化与恢复

流程根使用 `flow-store/v0/root.json` 声明，Run 保存在 `flow-store/v0/runs/`。它保存版本、源图 SHA256、创作输入、模型/连接绑定摘要、预留 Task/比较作品 ID、交付引用和选择。**提示词是私有 Run 输入**，`flow inspect` 会返回它，list 只返回摘要；Task 继续不保存提示词、Key、端点或宿主路径。POSIX 下目录/文件沿用 0700/0600；Windows 文件 mode 不等于 ACL。

Task 仍使用 schemaVersion 0 / semanticsVersion 2，新增可选 `flowBinding` 记录 Run、步骤和输入摘要。旧 Task 无需改写。步骤意图先落盘，Task 排他建立后再记录检查点，Attempt 必须先于 Provider 调用。已有 Attempt 但没有可靠响应时，即使 `acceptance=none`，也不能推断请求尚未发送。完整缓存可以接回原结果；缺少证据时保留未知。

比较图使用预留 ID、时间和内容证据重入；不会因 Run 完成标记未写入就另建随机比较作品。进程异常留下的写者租约仍按 [显式恢复流程](HEADLESS_CLI.md#异常退出后的写者租约)处理，不抢锁或手动删除租约。

Run 引用的原图、结果、比较作品和 Task 均进入现有删除/清理保护；Run 或绑定损坏时管理操作停止。首版不提供 Run 删除、自动 GC 或完整通用 Recipe 编辑器。流程根**不能与旧版 writer 混用或降级写入**：旧版能读 Task 不代表其清理器认识 Run 引用；回退使用原有数据根或只读导出。

当前恢复证据来自隔离根中的进程强杀、受控 Provider 与本地 HTTP。它不保证真实 Provider 的通用 exactly-once、断电持久性、网络/Android 共享文件系统支持或所有平台的实际运行；基础目录应放在支持现有 writer 租约的私有文件系统中。
