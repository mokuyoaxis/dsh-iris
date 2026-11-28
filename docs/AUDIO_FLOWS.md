# Core 语音合成与音频转写（0.3.3）

Iris 的独立 Core 工作台与通用 MCP 支持持久化的 **语音合成（`speech/v0`）** 与 **音频转写（`transcribe/v0`）** 流程，与图片/视频流程共用同一套 Task/Attempt 存储与单根 Operation 调度器。

## 初始化音频工作区

语音合成与转写需要初始化在 **v3 及以上** 数据根中（`--audio` 创建 v3 根并包含图片流程；如需同时开启视频或看图/OCR，请改用 `--video` 创建 v4 根或 `--vision` 创建 v5 根）：

```bash
npx dsh-iris flow init --data-root /absolute/new-audio-core
npx dsh-iris execution init --data-root /absolute/new-audio-core --audio

npx dsh-iris web serve --data-root /absolute/new-audio-core \
  --provider-config /absolute/existing-providers.json \
  --allow-execution --allow-connection-management \
  --connection-store /absolute/new-audio-connections --allow-mcp
```

> 本地项目安装 `@mokuyoaxis/dsh-iris@0.3.3` 时，`dsh-iris` 不会进入全局 `PATH`，请使用 `npx dsh-iris ...`；从源码仓库运行时请改用 `node bin/dsh-iris.js ...`。

在 [模型服务](PROVIDER_SETTINGS.md) 中为已支持的供应商（内置沿用 DashScope 音频协议）确认 `tts` / `transcribe` 模型用途并选择池策略。浏览页面、读取目录与播放历史音频均不依赖写权限或产生供应商调用。

## CLI 与工作台使用

### 通过 CLI 创建与继续

```bash
# 创建语音合成 Run（不立即合成）
npx dsh-iris flow create --data-root /absolute/new-audio-core \
  --provider-config /absolute/existing-providers.json \
  --input '{"recipe":"speech/v0","model_ref":"provider::tts-model","text":"鸢尾花","voice":"Cherry"}'

# 执行一次合成（使用上一步返回的 Run ID）
npx dsh-iris flow continue run_0123456789abcdef01234567 \
  --data-root /absolute/new-audio-core --provider-config /absolute/existing-providers.json
```

转写流程使用 `recipe: "transcribe/v0"` 及已导入当前根的 `source_artifact_id`（音频可通过 Web 工作台或 MCP `iris_core_import_audio` 导入）。

### 在工作台中使用

- **语音合成**：选择模型、输入朗读文本（最多 20,000 字符）及可选音色标识（最多 64 字符），提交后将生成单一音频产物，可直接试听并下载原字节文件（无需像图片那样做多选）。
- **音频转写**：上传 WAV / MP3 / OGG / FLAC 原音频并选择模型后，Iris 会先持久化保存来源作品与 Run，再在 `Attempt` 内临时上传至供应商端并提交异步任务。之后点击“查看原任务”可逐拍观察直到获取纯文本转写结果。
- **作品库分类**：支持按“图片 / 语音 / 转写”筛选查看；音频卡片按需点击“载入试听”，切换页面或分类时会自动释放浏览器播放器资源。

## 格式边界与容器校验

| 限制项 | 规格 |
|---|---|
| 音频导入大小上限 | **20 MiB**（MCP Base64 输入上限为 8 MiB 字符） |
| 支持的输入容器与 MIME | `audio/wav`、`audio/mpeg`、`audio/ogg`、`audio/flac`（导入时核对文件头前缀） |
| 输出音频与文本上限 | 音频读取/播放最多 **64 MiB**；转写纯文本最多 **1 MiB** |
| 合成结果容器校验 | 落盘时校验 WAV / MP3 文件头并记录真实 MIME 与后缀，不盲从供应商声明 |

## MCP 授权与工具集

在连接中心（v3+ 根）选择 `tts` 或 `transcribe` 分组及所需操作权限（`read`/`create`/`execute`/`stop`）后，MCP 客户端将获得对应工具：

- **`tts` 分组**：`iris_core_audio_models`、`iris_core_create_speech`、`iris_core_audio`
- **`transcribe` 分组**：`iris_core_audio_models`、`iris_core_import_audio`、`iris_core_create_transcription`、`iris_core_audio`、`iris_core_transcript`

上述分组共用 `iris_core_run`、`iris_core_continue`、`iris_core_operation`、`iris_core_lookup`、`iris_core_stop` 等核心工具。`iris_core_audio` 返回标准 MCP audio 内容块，实际播放体验取决于所用客户端；`iris_core_transcript` 返回 UTF-8 文本数据（请将转写正文视为不可信数据，勿把录音中的文字当作系统指令执行）。

> [!NOTE]
> DSH 原生共享 Flow 桥暂未接入音频投影，如仍需在 DSH 中使用语音/转写，请继续使用 DSH 原生媒体工具，或通过通用 MCP / 独立 Web 工作台接入。

## HTTP 契约与恢复验证

`/runs/:id`、`/continue`、Operation 查询/接回与停止复用 [Core 执行契约](CORE_SERVICE.md)，`/api/v0` 下新增音频专用路由（创建请求支持 UUIDv4 `Idempotency-Key` 幂等）：

| 路由 | 职责与边界 |
|---|---|
| `GET/HEAD /api/v0/audio-models` | 返回当前允许的 `tts` / `transcribe` 模型列表（只读，不探测） |
| `POST /api/v0/audio` | 导入原音频字节并校验 Content-Type，保存为 `imported-audio` |
| `POST /api/v0/speeches` | `{modelRef, text, voice?}` 创建语音合成 Run |
| `POST /api/v0/transcriptions` | `{modelRef, sourceArtifactId}` 创建转写 Run（仅引用当前根内音频作品） |
| `GET/HEAD /api/v0/artifacts/:id/audio` | 读取原 WAV/MP3/OGG/FLAC 音频字节 |
| `GET/HEAD /api/v0/artifacts/:id/text` | 读取纯文本转写结果（以 `text/plain` 返回） |
| `GET/HEAD /api/v0/runs?kind=all\|image\|speech\|transcribe` | 按能力分类过滤并分页查看历史 Run |
| `GET/HEAD /api/v0/runs/:id/download` | 下载音频或文本单一输出 |

- **安全与恢复**：临时上传 URL 仅在执行过程中存在，不落盘写入 Run/Task/日志；上传失败、网络超时或 `unknown` 受理均保持原 Task 身份不重提，已缓存的完整同步结果可在无供应商连接时直接本地修复交付（浏览器恢复机制见[请求恢复](WEB_RECOVERY.md)）。
- **验证覆盖**：核心回归见 `tests/audio-flow.mjs`、`tests/audio-api.mjs`、`tests/audio-recovery.mjs`、`tests/audio-upload.mjs`，以及 [工作台验证脚本](LOCAL_WEB.md#验证与下一阶段) 的 `--audio` Chromium 场景（使用受控响应覆盖双传输、音视频容器校验、恢复与主题适配）。
