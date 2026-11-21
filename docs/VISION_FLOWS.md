# Core 视觉流程：看图问答、OCR、视觉定位与多模态摘要（0.3.0）

Iris 支持在独立 Core 工作台、Headless CLI 与通用 MCP 中创建并执行持久化的 **单图看图问答（`vision/v0`）**、**长图分块 OCR（`ocr/v0`）**、**单图视觉定位（`locate/v0`）** 与 **多模态视频/帧摘要（`summarize/v0`）**，在执行后持久保留来源关联、结构化结果与纯文本摘要。

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
- **跨块重叠边界去重**：相邻成功分块存在物理像素重叠时，Iris 默认按保守边界策略（`boundary-overlap/v0`）比对前块尾与后块头的唯一、无歧义匹配行（以及未换行连续段落的长边界子串），仅合并确认无歧义的重叠重复；遇到重复行或周期性边界歧义时保守保留原文。原始逐块文字与纵坐标仍完整保留在 OCR JSON 报告的 `chunks` 中，合并明细记于 `deduplication`，便于复核。`complete` 代表所有计划分块均已完成执行（历史验证基线见 [OCR 四场景验证记录](OCR_VALIDATION.md)）。

## 视觉定位与多模态摘要

在 v5 数据根中，除 `vision/v0` 与 `ocr/v0` 外，还支持以下两个持久化视觉流程（同样严格遵循“先创建任务、再显式执行”的计费纪律）：

- **视觉定位（`locate/v0`，MCP `vision-locate` 分组）**：通过 `iris_core_create_locate`（HTTP `POST /api/v0/locates`）传入 `{sourceArtifactId, modelRef, target}` 保存定位任务；显式调用 `iris_core_continue` 执行后，模型在 EXIF 校正后的原图上返回归一化边界框，Core 自动校验并换算为原图像素坐标 `{contractVersion: 0, target, width, height, found, bbox?: {x1, y1, x2, y2, left, top, width, height}}` 持久化保存为 `application/json` Artifact。读取时调用 `iris_core_locate_result`（或查看 `iris_core_run` 的 `locate` 字段），`left/top/width/height` 可直接作为 `iris_core_crop` 的裁剪参数。
- **多模态视频/帧摘要（`summarize/v0`，MCP `media-summarize` 分组）**：通过 `iris_core_create_summarize`（HTTP `POST /api/v0/summaries`）传入 `{frameArtifactIds, modelRef, question?, transcript?}`（1–20 张已授权的 `video-frame` 或静态 PNG/JPEG/WebP Artifact ID，全部经过逐项来源能力授权校验与引用删除保护）。显式执行时，Core 将帧按时间戳（若全部为 `video-frame`）或传入顺序自动拼接为单张带时间戳标注的接触表提交给视觉模型（附带显式传入的 `transcript` 文本，不隐式触发 ASR 计费），执行后通过 `iris_core_vision_text` 读取纯文本摘要。

## 有限 HTTP 入口

以下接口挂载在 `/api/v0` 下，遵循工作台 Bearer、同源校验、根版本门禁与幂等规则：

| 路由 | 用途说明 |
|---|---|
| `GET/HEAD /api/v0/vision-models` | 只读列出已配置的视觉模型（`{modelRef, displayName}`） |
| `POST /api/v0/visions` | `{sourceArtifactId, modelRef, question}` 创建看图 Run |
| `POST /api/v0/ocrs` | `{sourceArtifactId, modelRef, chunkHeight?, overlap?, maxDimension?, maxInvocations?}` 创建 OCR Run |
| `POST /api/v0/locates` | `{sourceArtifactId, modelRef, target}` 创建视觉定位 Run（`locate/v0`） |
| `POST /api/v0/summaries` | `{frameArtifactIds, modelRef, question?, transcript?}` 创建多模态视频/帧摘要 Run（`summarize/v0`） |
| `GET/HEAD /api/v0/artifacts/:id/vision-text` | 读取看图、OCR 与摘要流程的纯文本输出（≤1 MiB） |
| `GET/HEAD /api/v0/artifacts/:id/ocr-report` | 读取 OCR 结构化 JSON 报告（≤1 MiB） |
| `GET/HEAD /api/v0/artifacts/:id/locate-result` | 读取视觉定位结构化像素坐标 JSON（≤1 MiB） |
| `GET /api/v0/runs?kind=vision\|ocr\|locate\|summarize` | 按视觉子流程分类分页查看历史 Run |

复用既有的 Run/Operation `continue`、`lookup`、`stop` 与下载接口（详见 [Core 执行契约](CORE_SERVICE.md#接收查询与停止)）。
