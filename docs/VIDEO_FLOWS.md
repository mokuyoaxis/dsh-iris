# Core 文生视频（0.3.2）

Iris 支持在独立 Core 工作台、Headless CLI 与通用 MCP 中保存并执行持久化的 **文生视频（`video-generate/v0`）** 流程。

> [!NOTE]
> 请按所用模型选择匹配的协议：例如百炼 `wan2.2-t2v-plus` 等系列对应官方[万相 2.1–2.6 文生视频接口](https://help.aliyun.com/zh/model-studio/legacy-wan-text-to-video-api-reference)，请勿直接套用 `wan2.7` 等新版协议的字段假定。图生视频（i2v）与 S2V 请继续使用原有的 CLI / DSH 工具入口。

## 初始化视频工作区

文生视频需要初始化在 **v4 及以上** 数据根中（`--video` 创建 `creation-requests/v4`，保留此前全部图片与音频流程；如需同时使用看图/OCR，请使用 `--vision` 初始化 v5 根）：

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

Iris 会按已知的 `t2v`/`i2v`/`s2v`/`r2v` 输入家族区分模型，固定文生视频流程会主动拒绝已知非 `t2v` 模型（未标注家族的兼容 ID 仍沿用既有候选路径）。

## CLI 与工作台使用

### CLI 创建与继续

```bash
# 1. 保存文生视频意图（不触发提交）
npx dsh-iris flow create --data-root /absolute/new-video-core \
  --provider-config /absolute/private/providers.json \
  --input '{"recipe":"video-generate/v0","model_ref":"provider::t2v-model","prompt":"鸢尾花随风轻摆","duration":5}'

# 2. 明确继续一次（异步任务未结束时再次调用只执行一次观察，不会重提）
npx dsh-iris flow continue run_0123456789abcdef01234567 \
  --data-root /absolute/new-video-core --provider-config /absolute/private/providers.json
```

### 输入与交付边界

- **输入规范**：固定配方接受明确 `modelRef`、`prompt`（最多 20,000 字符），可选 `size`（最多 64 字符）与数值型 `duration`（1–60 秒）；具体参数支持以所选上游模型为准。
- **单次执行与恢复**：每次“继续”对应唯一 `Operation`（首次提交或单步观察原 Task）。在工作台点击“停止等待”仅中止本地操作，不代表供应商远端取消或退款。交付失败且已有完整缓存时，可在重启后接回原交付而无需重新生成。
- **格式与大小上限**：固定流程、Core Web 与 MCP 视频读取支持 **MP4 / WebM**，上限 **32 MiB**（读取前先校验 Manifest、类型与文件大小；通用 Provider Task 下载上限仍为 1 GiB，DSH 媒体 GET 保持流式发送与分块 SHA-256 校验）。若结果超出 32 MiB 限制，原 Task 与产物仍保留，不会误删或自动重生成。
- **工作台体验**：**创作 → 生成视频** 默认折叠高级参数，结果区内置原视频播放与下载；**作品 → 视频** 仅在点击“载入视频”后才读取视频流，离开页面或退出时自动释放媒体资源。

## HTTP 与 MCP 接入

`/api/v0` 下开放以下视频专用路由（复用 [Core 执行契约](CORE_SERVICE.md) 的 Run/Operation 接口与 `Idempotency-Key` 幂等规则，JSON 请求体上限 64 KiB）：

| 路由 | 用途说明 |
|---|---|
| `GET/HEAD /api/v0/video-models` | 列出当前池内允许的文生视频候选（只读） |
| `POST /api/v0/videos` | 保存文生视频 Run（201 创建 / 同 Key 同输入 200 / 冲突 409） |
| `GET/HEAD /api/v0/artifacts/:id/video` | 读取已授权的 MP4/WebM 视频字节 |
| `GET/HEAD /api/v0/runs/:id/download` | 下载单一结果原字节 |

在 v4+ 根的连接中心选择 `video-generate` 分组后，MCP 客户端会额外获得：
- `iris_core_video_models`（只读候选）
- `iris_core_create_video`（保存意图）
- `iris_core_video`（读取视频资源引用）

由于 MCP 规范目前没有原生视频内容块，`iris_core_video` 会返回标准 `resource_link`（URI 为 `iris://video/ARTIFACT_ID`），客户端通过标准的 `resources/read` 获取 `BlobResourceContents`。每次读取均会重新校验当前连接权限（撤销或缩权后立即生效）；由于客户端对视频播放器的支持各异，拿到资源引用不代表客户端已实际播放。

> [!NOTE]
> DSH 原生共享 Flow 桥暂未支持视频附件投影，在 DSH 端请继续使用原生 `iris_generate_video` 工具，或使用通用 MCP 与独立 Web 工作台。

## 验证范围

- **自动化回归**：`tests/video-flow.mjs`、`tests/video-api.mjs`、`tests/video-recovery.mjs`（覆盖双传输 MCP 资源读取与权限缩减），以及 [工作台浏览器验证](LOCAL_WEB.md#验证与下一阶段) 中的 `--video` 场景。
- **实机验证记录**：于 `2026-11-01` 在百炼北京 `wan2.2-t2v-plus`（832×480、5 秒 H.264/MP4）完成过单账号真实端到端验证，包含服务重启后原 Task 接回、正式 MCP 资源读取、Chromium 播放下载与 SHA-256 校验通过（真实兼容性仍取决于具体上游模型、账号与客户端播放器）。
