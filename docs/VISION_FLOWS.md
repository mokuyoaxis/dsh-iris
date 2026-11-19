# Core 看图问答与长图 OCR（0.3.0）

Iris 支持在独立 Core 工作台、Headless CLI 与通用 MCP 中创建并执行持久化的 **单图看图问答（`vision/v0`）** 与 **长图分块 OCR（`ocr/v0`）**，在执行后持久保留原图关联、识别文字与完整分块报告。

## 初始化视觉工作区

看图与 OCR 流程需要初始化在 **v5 数据根** 中（`--vision` 会建立 v5 根，并同时兼容图片、语音/转写与文生视频流程；已有旧根不会自动升级）：

```bash
npx dsh-iris flow init --data-root /absolute/new-vision-core
npx dsh-iris execution init --data-root /absolute/new-vision-core --vision

npx dsh-iris web serve --data-root /absolute/new-vision-core \
  --provider-config /absolute/existing-providers.json --allow-execution \
  --allow-connection-management --connection-store /absolute/new-vision-connections --allow-mcp
```

> 本地项目安装 `@mokuyoaxis/dsh-iris@0.3.0` 后请通过 `npx dsh-iris ...` 调用（全局 `PATH` 不含该命令）；从源码仓库运行请改用 `node bin/dsh-iris.js ...`。

- **模型与协议**：工作台从已确认 `vision` 用途及池策略的候选中选取明确的 `provider::model`（当前支持 OpenAI 兼容 Chat Completions 图片输入 SSE 协议，使用供应商的 `baseUrl` 而非生图专用的 `mediaBaseUrl`）。
- **模型不存在隔离**：当上游明确返回“模型不存在”的 HTTP 404 时，Core 会持久记录该模型在当前连接上的不可用状态，后续请求（包括同一轮 OCR 的后续分块）将停止继续请求该模型，同时保留已完成部分的结果与安全错误摘要（需核对模型 ID 并显式实测后才可恢复）。
- **输入图片要求**：须为当前根中已导入的静态 PNG/JPEG/WebP Artifact（≤20 MiB、≤4000 万像素；MCP `imageBase64` 上限为 8 MiB 字符，约 6 MiB 原字节）。

## 保存、执行与读取

在工作台、CLI 与 MCP 中，“保存任务”与“开始执行”是两个明确分离的步骤：

### MCP 典型工作流

在连接中心（v5 根）勾选 `vision` 或 `ocr` 及所需权限后，标准调用顺序如下：

1. `iris_core_vision_models`：只读获取已配置的视觉模型列表。
2. `iris_core_import_image`：使用稳定 UUID 导入静态图片，获取 `artifact_id`。
3. `iris_core_create_vision`（保存问题）或 `iris_core_create_ocr`（保存 `{chunkHeight, overlap, maxDimension, maxInvocations}` 并返回实际分块计划）——此时不产生模型调用。
4. 明确授权执行后，携带新的请求 UUID 与当前 Run `revision` 调用一次 `iris_core_continue`（默认串行模式下请等待本次 Operation 结束再提交下一项，遇到 `root_busy` 或断线时先以原 UUID `iris_core_lookup`）。
5. 完成后通过 `iris_core_vision_text` 读取纯文本输出（`text/plain`，≤1 MiB），或通过 `iris_core_ocr_result` 读取 OCR JSON 报告（`application/json`，≤1 MiB）。

> [!TIP]
> 在保持 Core `--allow-execution` 开启的前提下，仅拥有 `read` 权限的 MCP 连接也可通过 `iris_core_operation` / `iris_core_lookup` 与文本/报告读取工具查回历史结果。

### 工作台与 CLI 用法

- **Web 工作台**：在创作页选择“看图问答”或“图片文字识别”，上传图片并设置问题或分块参数，先点击“保存看图/OCR 任务”核对系统算出的实际分块计划与调用上限，确认后再点击“开始看图/开始识别”。结果支持纯文本查看与下载（将图片文字视为数据呈现，不按 HTML 渲染）。
- **Headless CLI**：在 v5 根通过 `flow create` 保存任务，再用 `flow continue` 执行：

```bash
npx dsh-iris flow create --data-root /absolute/new-vision-core \
  --provider-config /absolute/existing-providers.json \
  --input '{"recipe":"vision/v0","model_ref":"provider::vision-model","source_artifact_id":"artifact_实际ID","question":"描述图片"}'

npx dsh-iris flow continue <run_id> \
  --data-root /absolute/new-vision-core --provider-config /absolute/existing-providers.json
```

OCR 将 `recipe` 设为 `"ocr/v0"`，并可选传 `chunk_height`、`overlap`、`max_dimension`、`max_invocations`。

## OCR 完成度与停止

长图 OCR 共享单次整体预算：**总超时 120 秒、最多 32 块 / 32 次模型调用**（默认块高 1200、重叠 120、最大宽度 2048，按 EXIF 校正并缩放后的几何切分）：

- **`complete` vs `partial`**：所有分块获得完整响应记为 `complete`；若部分块失败、模型受阻或耗尽调用预算，已成功的分段正文与逐块坐标/错误报告仍会保存在原作品中（Run 标记为 `needs_attention`）。全部块均失败则不生成正文或报告作品。
- **取消与超时**：主动取消或整体超时会立刻停止后续分块调度，**不会**交付未完成的部分正文；服务重启后也不会自动续跑或重做整张图。局部取消同样不保证远端停费，需重新识别时请明确新建 Run。
- **跨块重叠尚未去重**：各块边界重叠区域的文字目前按块顺序直接拼接并标注段号与纵坐标，**未实现跨块去重**。因此 `complete` 仅代表所有计划分块均已完成执行，不代表去重后的唯一全文——复核关键文本时请结合分块纵坐标与原图判断（参见 [OCR 四场景验证记录](OCR_VALIDATION.md)）。

## 有限 HTTP 入口

以下接口挂载在 `/api/v0` 下，遵循工作台 Bearer、同源校验、根版本门禁与幂等规则：

| 路由 | 用途说明 |
|---|---|
| `GET/HEAD /api/v0/vision-models` | 只读列出已配置的视觉模型（`{modelRef, displayName}`） |
| `POST /api/v0/visions` | `{sourceArtifactId, modelRef, question}` 创建看图 Run |
| `POST /api/v0/ocrs` | `{sourceArtifactId, modelRef, chunkHeight?, overlap?, maxDimension?, maxInvocations?}` 创建 OCR Run |
| `GET/HEAD /api/v0/artifacts/:id/vision-text` | 读取本能力流程的纯文本输出（≤1 MiB） |
| `GET/HEAD /api/v0/artifacts/:id/ocr-report` | 读取 OCR 结构化 JSON 报告（≤1 MiB） |
| `GET /api/v0/runs?kind=vision\|ocr` | 按视觉或 OCR 分类分页查看历史 Run |

复用既有的 Run/Operation `continue`、`lookup`、`stop` 与下载接口（详见 [Core 执行契约](CORE_SERVICE.md#接收查询与停止)）。
