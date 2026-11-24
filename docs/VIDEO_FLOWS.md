# Core 视频流程（t2v / i2v / s2v）

Iris 支持在独立 Core 工作台、Headless CLI 与通用 MCP 中保存并执行持久化的三类视频流程：
- **文生视频（`video-generate/v0`）**：纯文本描述驱动；
- **图生视频（`video-i2v/v0`）**：以已有静态图片 Artifact 作为首帧，支持可选文字描述、`size`、`resolution` 与 `duration`；
- **数字人视频 / 语音驱动视频（`video-s2v/v0`）**：以已有静态肖像图片 Artifact 与已有音频 Artifact 作为双输入（无文字 Prompt），支持可选 `resolution`。

> [!NOTE]
> 请按所用模型选择匹配的协议与模式：例如百炼 `wan2.2-t2v-plus` 对应文生视频，`wan2.6-i2v` 对应图生视频，`wan2.2-s2v` 对应数字人视频。自定义 Provider 插件可通过 `supportsVideoMode(modelId, mode)` 精确声明其支持的 `t2v` / `i2v` / `s2v` 模式。

## 初始化视频工作区

三类视频流程均复用既有 **v4 及以上** 数据根（无需升级新根版本；`--video` 创建 `creation-requests/v4`，`--vision` 初始化 v5 根）：

```bash
npx dsh-iris flow init --data-root /absolute/new-video-core
npx dsh-iris execution init --video --data-root /absolute/new-video-core

npx dsh-iris web serve --data-root /absolute/new-video-core \
  --provider-config /absolute/private/providers.json --allow-execution \
  --auth-store /absolute/private/video-auth \
  --connection-store /absolute/private/video-connections \
  --allow-connection-management --allow-mcp
```

> 本地项目安装 `@mokuyoaxis/dsh-iris@0.3.2` 时，`dsh-iris` 不会自动写入全局 `PATH`，请使用 `npx dsh-iris ...`；若在源码仓库中运行，请改用 `node bin/dsh-iris.js ...`。

Iris 会按模型协议的 `supportsVideoMode` 声明与已知的 `t2v`/`i2v`/`s2v`/`r2v` 家族规则区分候选，每类固定视频流程只接受明确支持对应模式的模型，拒绝跨模式误配。

## CLI 与工作台使用

### CLI 创建与继续

```bash
# 1. 保存文生视频 / 图生视频 / 数字人视频意图（不触发提交）
npx dsh-iris flow create --data-root /absolute/new-video-core \
  --provider-config /absolute/private/providers.json \
  --input '{"recipe":"video-generate/v0","model_ref":"provider::t2v-model","prompt":"鸢尾花随风轻摆","duration":5}'

npx dsh-iris flow create --data-root /absolute/new-video-core \
  --provider-config /absolute/private/providers.json \
  --input '{"recipe":"video-i2v/v0","source_artifact_id":"artifact_0123456789abcdef01234567","model_ref":"provider::i2v-model","prompt":"镜头缓慢推近","resolution":"720P","duration":5}'

npx dsh-iris flow create --data-root /absolute/new-video-core \
  --provider-config /absolute/private/providers.json \
  --input '{"recipe":"video-s2v/v0","source_artifact_id":"artifact_0123456789abcdef01234567","audio_artifact_id":"artifact_fedcba9876543210fedcba98","model_ref":"provider::s2v-model","resolution":"720P"}'

# 2. 明确继续一次（异步任务未结束时再次调用只执行一次观察，不会重提）
npx dsh-iris flow continue run_0123456789abcdef01234567 \
  --data-root /absolute/new-video-core --provider-config /absolute/private/providers.json
```

### 输入与交付边界

- **输入规范**：
  - `video-generate/v0`：明确 `modelRef`、`prompt`（最多 16,000 字符），可选 `size`（≤64 字符）与 `duration`（1–60 秒）。
  - `video-i2v/v0`：已有静态图片 `sourceArtifactId`、明确 `modelRef`，可选 `prompt`（≤16,000 字符）、`size`、`resolution`（≤32 字符）与 `duration`（1–60 秒）。
  - `video-s2v/v0`：已有静态图片 `sourceArtifactId`、已有音频 `audioArtifactId`、明确 `modelRef`，可选 `resolution`（≤32 字符）；绝不接受 `prompt`。执行阶段按需在内存中通过适配器 `prepareInput` 上传媒体或直接向插件适配器透传受控字节，绝不提前上传。
- **单次执行与恢复**：每次“继续”对应唯一 `Operation`（首次提交或单步观察原 Task）。在工作台点击“停止等待”仅中止本地操作，不代表供应商远端取消或退款。交付失败且已有完整缓存时，可在重启后接回原交付而无需重新生成；`video-s2v/v0` 产出的视频 Artifact 自动记录指向首帧图片与驱动音频的双 `derived-from` 血缘边。
- **格式与大小上限**：固定流程、Core Web 与 MCP 视频读取支持 **MP4 / WebM**，上限 **32 MiB**（读取前先校验 Manifest、类型与文件大小；通用 Provider Task 下载上限仍为 1 GiB，DSH 媒体 GET 保持流式发送与分块 SHA-256 校验）。若结果超出 32 MiB 限制，原 Task 与产物仍保留，不会误删或自动重生成。
- **工作台体验**：**创作**页提供“生成视频 / 图生视频 / 数字人视频”三入口并按 `videoModes` 分别筛选候选，支持从本地工具裁剪图/HTML 截图/视觉定位裁剪图一键送入“图生视频”；**作品 → 视频** 仅在点击“载入视频”后才读取视频流，离开页面或退出时自动释放媒体资源。

## HTTP 与 MCP 接入

`/api/v0` 下开放以下视频专用路由（复用 [Core 执行契约](CORE_SERVICE.md) 的 Run/Operation 接口与 `Idempotency-Key` 幂等规则，JSON 请求体上限 64 KiB）：

| 路由 | 用途说明 |
|---|---|
| `GET/HEAD /api/v0/video-models` | 列出视频候选及其 `videoModes`（支持可选 `?mode=t2v\|i2v\|s2v` 过滤，只读） |
| `POST /api/v0/videos` | 保存文生视频 Run（`video-generate/v0`） |
| `POST /api/v0/videos/i2v` | 保存图生视频 Run（`video-i2v/v0`） |
| `POST /api/v0/videos/s2v` | 保存数字人视频 Run（`video-s2v/v0`） |
| `GET/HEAD /api/v0/artifacts/:id/video` | 读取已授权的 MP4/WebM 视频字节 |
| `GET/HEAD /api/v0/runs/:id/download` | 下载单一结果原字节 |

在 v4+ 根的连接中心，视频按模式拆分为三个独立授权分组（已有连接绝不静默扩权）：
- `video-generate`：`iris_core_video_models`、`iris_core_create_video`、`iris_core_video`
- `video-i2v`：`iris_core_video_models`、`iris_core_import_image`、`iris_core_create_video_i2v`、`iris_core_video`
- `video-s2v`：`iris_core_video_models`、`iris_core_import_image`、`iris_core_import_audio`、`iris_core_create_video_s2v`、`iris_core_video`

由于 MCP 规范目前没有原生视频内容块，`iris_core_video` 会返回标准 `resource_link`（URI 为 `iris://video/ARTIFACT_ID`），客户端通过标准的 `resources/read` 获取 `BlobResourceContents`。每次读取均会重新校验当前连接权限（撤销或缩权后立即生效）；由于客户端对视频播放器的支持各异，拿到资源引用不代表客户端已实际播放。

> [!NOTE]
> DSH 原生共享 Flow 桥暂未支持视频附件投影，在 DSH 端请继续使用原生 `iris_generate_video` 工具，或使用通用 MCP 与独立 Web 工作台。

## 验证范围

- **自动化回归**：`tests/video-flow.mjs`、`tests/video-api.mjs`、`tests/video-recovery.mjs`（覆盖双传输 MCP 资源读取与权限缩减），以及 [工作台浏览器验证](LOCAL_WEB.md#验证与下一阶段) 中的 `--video` 场景。
- **实机验证记录**：于 `2026-11-01` 在百炼北京 `wan2.2-t2v-plus`（832×480、5 秒 H.264/MP4）完成过单账号真实端到端验证，包含服务重启后原 Task 接回、正式 MCP 资源读取、Chromium 播放下载与 SHA-256 校验通过（真实兼容性仍取决于具体上游模型、账号与客户端播放器）。
