# 通用 MCP 接入与能力选择（0.3.3）

通过 Iris 的通用 MCP 接口，任何支持 **stdio** 或 **Streamable HTTP** 的客户端都可以安全共用同一个 [Core 服务](CORE_SERVICE.md)。

> [!TIP]
> - 首次上手请先按 [Core 快速开始](CORE_QUICKSTART.md#connect-an-agent--连接客户端)完成初始化与首次连接。
> - 如果希望由 AI Agent 协助完成配置或了解调用纪律，请直接参考 [Agent Core 指导](AGENT_CORE_QUICKSTART.md)。

## 核心设计

Iris 的 MCP 层只负责协议适配与能力投递（基于官方 `@modelcontextprotocol/server` 2.3.1），所有任务队列、状态持久化与凭据均保留在唯一运行的 Core 服务中：

- **同一数据源，单一写者**：stdio 启动的是轻量级桥接进程，HTTP 复用同一服务上的 `/mcp` 端点；二者都不另建业务写者，也不会把请求转成 Shell 命令。
- **能力与权限显式授权**：工具清单与描述统一来自 [Core 能力目录](PLUGINS.md#core-能力目录与授权)。每条连接仅能看到用户勾选的媒体分组、操作权限（`read` / `create` / `execute` / `stop`）和工具子集的交集；新增插件或升级版本均不会暗中扩大旧连接的权限。
- **可恢复的执行回执**：在默认串行模式下，调用 `iris_core_continue` 返回 `queued` 或 `running` 后，可通过 `iris_core_operation`（支持可选 `waitMs` 0–10000 ms 有界只读等待，不阻塞 Core 读取槽位，也不触发重试）等待原 `Operation` 结束并检查 `iris_core_run` 的 Task 状态（其中 `errorSummary` 会提供诸如 `rate_limit / submit / 429` 的安全诊断摘要）。若遇到写者忙（`root_busy`）或响应丢失，应以原请求 UUID 调用 `iris_core_lookup` 核对，或按已知 `runId` 调用 `iris_core_run_operations` 分页查回该 Run 的历史 Operation，而不自动重发（详见 [接收、查询与停止](CORE_SERVICE.md#接收查询与停止)）。
- **只读筛选、恢复与工具注解边界**：`iris_core_runs` 支持在已授权分组内按 `kind` / `selection` 筛选；只读连接在 Core 保持执行服务开启的前提下，仍可查询历史 `Operation`、`run_operations` 与 `lookup` 原请求，无需额外授予 `execute` 权限；MCP 工具注解中仅 `execute` 范围（`iris_core_continue` / `iris_core_plugin_call`）标注 `openWorldHint: true`，本地只读、建单与停止等待均标注 `openWorldHint: false`。

## 首次接入与客户端预设

### 工作台连续接入（当前源码）

在独立 Web 工作台的**客户端**页面中，可以按“选择与授权 → 获取配置 → 核对接入”三步完成配置：

1. **选择与授权**：新建连接并勾选需要的媒体能力（或显式启用的插件业务）与操作权限。只读浏览历史只需保留 `read`。
2. **获取配置**：确认 **Agent 是否与 Core 运行在同一台机器**（即运行客户端的主机，而非打开网页的浏览器设备），然后选择对应的客户端预设或通用格式，将生成片段合并进客户端配置文件并妥善保管。
3. **核对接入**：点击“检查 Iris 端与接入记录”核对当前服务开关、有效工具范围与客户端自报握手信息。客户端名称/版本属于可选元数据，未收到声明不代表调用失败；在客户端试调一个已授权的只读工具后刷新页面即可看到最新状态。

### CLI 检查与预设

如果你已拥有导出的 `client.json`，可以先在本地自检，再按预设导出对应客户端格式：

```bash
node bin/dsh-iris.js mcp check --connection-file /absolute/pair/client.json
node bin/dsh-iris.js mcp presets
node bin/dsh-iris.js mcp config --connection-file /absolute/pair/client.json \
  --preset codex-stdio --output /absolute/new-iris-mcp.toml
```

`mcp check` 默认以 `read` 权限验证私有配置、Core 回环传输与握手状态（可加 `--scopes` / `--capabilities` / `--tools` 检查子集），不触发任何供应商调用。

内置的 8 个传输预设覆盖主流客户端格式（均支持 `-stdio` 与 `-http` 后缀）：

| 预设前缀 | 输出格式 | 官方参考 |
|---|---|---|
| `generic` | 标准 `mcpServers` JSON（或 `--format entry` 单条对象） | [MCP 本地接入](https://modelcontextprotocol.io/docs/develop/connect-local-servers) |
| `claude` | 带 `type: stdio/http` 的 `mcpServers` JSON（适用于 `.mcp.json`） | [Claude Code MCP](https://code.claude.com/docs/en/mcp) |
| `codex` | 原生 `[mcp_servers.iris]` TOML | [OpenAI Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) |
| `kimi` | 兼容 `mcp.json` 的 `mcpServers` JSON | [Kimi Code MCP](https://moonshotai.github.io/kimi-code/en/customization/mcp) |

> [!NOTE]
> 导出配置时请将生成条目合并进现有配置文件，避免直接覆盖其他已配置的 MCP 服务；包含 HTTP 凭据的配置应写入私有新文件并妥善保护。

## 创建明确的连接

除使用 [Core 连接中心](LOCAL_WEB.md#显式开启连接中心) 在网页中管理外，也可以通过 CLI 创建静态连接授权对：

```bash
# 1. 初始化专用执行根
node bin/dsh-iris.js flow init --data-root /absolute/new-core
node bin/dsh-iris.js execution init --vision --data-root /absolute/new-core

# 2. 创建连接对（默认 harness 为 generic；--harness dsh 保留给 DSH 原生桥）
node bin/dsh-iris.js connection create --data-root /absolute/new-core \
  --directory /absolute/new-mcp-pair --origin http://127.0.0.1:3182 \
  --label my-client --scopes read,create,execute,stop --capabilities image-edit

# 3. 启动 Core 服务并开启 /mcp
node bin/dsh-iris.js api serve --data-root /absolute/new-core \
  --provider-config /absolute/providers.json --port 3182 \
  --token-file /absolute/new-owner-token.txt --allow-execution \
  --connections-file /absolute/new-mcp-pair/server-grants.json --allow-mcp
```

完整权限与存储契约见[连接契约](CORE_CONNECTIONS.md)。

## 选择能力和工具

运行 `node bin/dsh-iris.js mcp capabilities` 可查看当前版本支持的所有分组与工具。可用媒体分组受数据根版本控制（`v5` 根包含此前全部已接入能力）：

- `image-edit`：图片导入、固定编辑流程、原图与结果读取。
- `image-generate`：独立文生图创建（含可选的 ComfyUI `workflowParameters` 标量参数）。
- `tts` / `transcribe` / `music`（需 v3+ 根）：[语音合成与音频转写](AUDIO_FLOWS.md)及[持久音乐生成](MUSIC.md)，支持音频块返回（`iris_core_audio`）、音乐候选查询（`iris_core_music_models`）、严格单次提交的音乐创建（`iris_core_create_music`，可选 `retriedFromRunId`）与纯文本转写结果读取。
- `video-generate` / `video-i2v` / `video-s2v`（需 v4+ 根）：[文生视频、图生视频与数字人视频](VIDEO_FLOWS.md)，三个独立授权分组分别开放 `iris_core_create_video`、`iris_core_create_video_i2v` 与 `iris_core_create_video_s2v`，共用 `iris_core_video_models`（支持 `mode` 过滤）并通过标准 MCP `resource_link` 与 `resources/read` 读取 MP4/WebM（≤32 MiB）。
- `vision` / `ocr`（需 v5 根）：[单图看图问答与长图分块 OCR](VISION_FLOWS.md)，保存问题/预算并在执行后读取文本与 JSON 报告（各限 1 MiB）。
- `vision-locate`（需 v5 根）：[单图视觉定位](VISION_FLOWS.md#视觉定位与多模态摘要)，针对已有静态图片 `artifactId` 与自然语言目标创建持久 `locate/v0` 流程，执行后通过 `iris_core_locate_result` 读取原图像素坐标（`x1, y1, x2, y2` 及 `left, top, width, height`），可直接衔接 `local-media` 的 `iris_core_crop` 裁剪验证。
- `media-summarize`（需 v5 根）：[多模态视频/帧摘要](VISION_FLOWS.md#视觉定位与多模态摘要)，将 1–20 张已授权的 `video-frame` 或静态图片 `artifactId` 自动拼成带时间戳标注的接触表，结合可选 `question` 与显式文本 `transcript` 创建持久 `summarize/v0` 流程（不隐式触发 ASR 计费），执行后通过 `iris_core_vision_text` 读取纯文本摘要。
- `local-media`（任意 Core 根可用，零外部计费）：基于已有 Core `artifactId` 执行本地确定性裁剪（`iris_core_crop`）、像素对比热力图（`iris_core_pixel_diff`）、视频抽帧/尾帧提取（`iris_core_video_frames`，支持 `mode: "uniform" | "last"`）与本地音视频合轨（`iris_core_mux_video_audio`，将 MP4/WebM 视频与音频/音乐合成为 ≤32 MiB 带音轨 MP4 并写入双 `derived-from` 血缘边；抽帧与合轨需宿主安装 `ffmpeg`/`ffprobe`），派生作品自动继承来源能力授权，不接受宿主任意路径。
- `inbox`（需启动 Core 时显式传入 `--inbox-dir <根外只读目录>`）：通过 `iris_core_inbox` 列出收件目录顶层符合格式的图片（≤20 MiB）与音频（v3+ 根，≤20 MiB），再用 `iris_core_import_inbox_file` 按文件名与稳定 UUID 直接入库为持久 Core Artifact，免除 LLM 参数传几 MB Base64；只读访问且拒绝子目录、隐藏文件、符号链接及与私有目录重叠的配置。
- `html-render`（需启动 Core 时显式传入 `--browser-executable <Chromium 绝对路径>`，可选 `--browser-no-sandbox`；任意 Core 根可用，零外部计费）：通过 `iris_core_render_html` 在无网络、无脚本的沙箱 CSP 环境下将自包含 HTML/SVG（≤1 MiB）渲染为持久 Core PNG Artifact，可用 `iris_core_image` 读回，或与 `local-media`（裁剪/像素 diff）、`vision`/`vision-locate` 串联进行视觉自检；默认关闭且绝不自动扫描宿主浏览器。
- `outbox`（0.3.2）将已授权读取的 Core Artifact 写入所有者配置的目录。见[受控作品出件](#受控作品出件032)。
- `none`：关闭媒体流程工具，仅保留连接状态查询。

**精细过滤**：通过 `--tools` 可进一步指定工具子集（`--tools none` 注册零工具）；通过 `--scopes` 组合 `read,create,execute,stop` 控制读写与执行权。服务端会在每次调用时校验连接授权，未授权的请求无法通过参数拼接绕过。

> [!TIP]
> 配合连接中心或 CLI 生成的**连接专属 Skill**，客户端 Agent 能更准确地了解当前授权下可用的工具与参数规范，详情见 [Core Skills](CORE_SKILLS.md)。

## stdio：填写启动命令

使用 `mcp config` 导出适用于当前环境的绝对启动命令，合并至客户端配置：

```bash
node bin/dsh-iris.js mcp config \
  --connection-file /absolute/new-mcp-pair/client.json \
  --scopes read,create,execute,stop --format mcpServers
```

对应客户端启动命令等价于：

```bash
node /absolute/iris/bin/dsh-iris.js mcp serve \
  --connection-file /absolute/new-mcp-pair/client.json \
  --scopes read,create,execute,stop
```

省略 `--scopes` 时默认以只读（`read`）启动。`stdout` 专用于传递 MCP 协议消息，遇到 EOF 或关闭信号时桥接进程会安全退出，不影响 Core 已受理的异步任务。

## HTTP：填写 URL 和认证

开启 `--allow-mcp` 后，服务在 `http://127.0.0.1:3182/mcp` 提供标准 Streamable HTTP 端点（同时兼容 2026-07-28 与 2025-11-25 无状态协议），使用标准 `Authorization: Bearer …` 鉴权。导出含密钥的客户端配置文件时须写入私有新文件：

```bash
node bin/dsh-iris.js mcp config \
  --connection-file /absolute/new-mcp-pair/client.json --transport http \
  --output /absolute/new-mcp-pair/mcp-http.json
```

**HTTP 并发预算**：同一 Core 实例上的 HTTP MCP 共享 4 条活动消息并发额度与 9 MiB 请求体上限（批量请求最多 4 条），超出额度会返回 `429` 与 `Retry-After: 1`（`IRIS_MCP_HTTP_BUSY`），客户端可稍后使用原 UUID 重试。媒体上游调用自身的并发与速率限制则由[有界媒体调度](MEDIA_SCHEDULING.md)独立管理。

标准协议规范参考 [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)。

## 可选插件业务

如果服务通过 `--plugin-config` 显式启用了[多图对照板](CONTACT_SHEET.md)等业务插件，且用户在连接页勾选了对应业务依赖并开放 `execute`：

- 客户端通过通用的 `iris_core_plugin_catalog` 获取已授权业务的输入 Schema、精确 `dependency` 与可用图片列表（声明了图片输入的业务可读取同根内 ≤8 MiB 的 PNG/JPEG/WebP 来源）。
- 执行时统一调用 `iris_core_plugin_call`（参数 `{ key, operationId, dependency, input }`），查询与恢复复用 `iris_core_operation` / `iris_core_lookup` / `iris_core_stop` / `iris_core_image`。
- 若插件缺失或版本不匹配，历史记录与产物仍可读取，但不会跨版本自动重做中断操作（详见 [插件启动](PLUGIN_STARTUP.md)）。

## 选择图片作品（0.3.2）

服务开启 `--allow-selection` 及本地写入后，可为连接显式勾选 `iris_core_select_run`。连接需要 `create` 权限及对应的 `image-edit` 或 `image-generate` 分组。使用 CLI 创建连接时，通过 `--tools` 显式加入该工具。

先调用 `iris_core_run` 读取当前 `revision` 和可选作品，再用 `{ runId, expectedRevision, choice }` 保存明确的选择。`choice` 为 `source`（原图）或 `output`（生成结果）。响应丢失或遇到 `409 IRIS_API_RUN_CHANGED` 时，先查回同一 Run 的修订与已选作品。选择本身只写入 Core 的选定态。

## 受控作品出件（0.3.2）

启动 `api serve` 或 `web serve` 时传入 `--outbox-dir <现有可写绝对目录>`，同时启用本地写入。连接需由所有者选中 `outbox` 分组、`create` scope 和 `iris_core_export_outbox` 工具，并且具备对该作品及其适用来源的读取授权。CLI 创建连接时用 `--tools` 明确列出出件工具及所需的读取工具。

调用 `iris_core_export_outbox` 时传入 `{ key, artifactId, name }`。可从 Run 先读取选定作品 ID，也可直接使用已保存的裁图、热力图、帧或截图 ID。`name` 是与作品媒体类型匹配的顶层文件名。回执包含文件名、作品 ID、媒体类型、字节数及 SHA-256。整个操作由 Core 本地完成。

断线后用同一个 UUID、作品 ID 和文件名接回原回执。`IRIS_OUTBOX_FILE_EXISTS` 表示已有同名项，须为新出件选新名字和 UUID。`IRIS_OUTBOX_UNCONFIRMED` 表示原落盘归属待核对，保留原 UUID 并请所有者在 Core 宿主核对文件。部署目录需支持同目录硬链接发布。具体错误码和进程中断接回见[出件路由](LOCAL_API_CONTRACT.md#受控出件032)。

## 功能覆盖矩阵

| 能力 | Headless CLI / Core | 当前 MCP |
|---|---|---|
| 静态图片导入、原图读取、固定改图 Flow | 支持 | `image-edit` 分组支持 |
| 独立文生图（含 ComfyUI 开放标量参数） | 支持 | `image-generate` 分组支持（v2+ 根） |
| 语音合成（TTS）与音频转写 | 支持 | `tts` / `transcribe` 分组支持（v3+ 根） |
| 文生视频 / 图生视频（i2v） / 数字人视频（s2v） | 支持 | `video-generate` / `video-i2v` / `video-s2v` 分组独立支持（v4+ 根） |
| 音乐生成（`music/v0`，含 `retriedFromRunId` 血缘） | 支持 | `music` 分组支持（v3+ 根） |
| 看图问答与长图 OCR | 支持 | `vision` / `ocr` 分组支持（v5 根） |
| 视觉定位与多模态视频/帧摘要 | 支持 | `vision-locate` / `media-summarize` 分组支持（v5 根） |
| 裁剪 / 像素 diff / 视频抽帧与尾帧 / 音视频合轨（基于 `artifactId`） | 支持 | `local-media` 分组支持（零外部计费） |
| 大文件只读收件目录安全入库（≤20 MiB，免 Base64） | 支持（`--inbox-dir`） | `inbox` 分组支持（`iris_core_inbox` / `iris_core_import_inbox_file`） |
| 图片作品选择 | 支持 | 显式开启并授权 `iris_core_select_run`（0.3.2） |
| 受控目录出件 | 支持（`--outbox-dir`） | 显式授权 `iris_core_export_outbox`（0.3.2） |
| 无头 HTML/SVG 截图（沙箱 CSP，零计费） | 支持 | `html-render` 分组支持（显式 `--browser-executable`） |

## 错误定位与验证范围

`mcp check`、`stdio` `stderr` 与工具错误均会返回安全错误码、阶段标识、处理建议及 `requestId`（`structuredContent.error` 中还会附带相关的 `key` / `runId` / `operationId`），不会泄露凭据或服务端内部路径：

| 阶段 | 排查方向 |
|---|---|
| `configuration` | 核对私有 `client.json` 路径（注意不要误填 `server-grants.json` 或 owner Token） |
| `transport` | 确认 Core 服务仍在运行且回环地址/端口匹配；请求超时后先用原 UUID 查询 |
| `handshake` / `authorization` | 检查连接权限、工具范围及服务启动开关是否匹配，调整后重新连接 |
| `input` / `tool` / `response` | 按 Schema 与当前 Run/Operation 修订版核对参数，避免重复提交 |

仓库针对 MCP 传输已通过受控 Provider 下的双传输（stdio/HTTP）、多协议版本（2025-11-25 / 2026-07-28）、官方 Client SDK 2.0.0/2.2.0、TOML/JSON 预设、权限边界及原 UUID 跨进程恢复测试；关于真实客户端与模型行为边界，请参阅 [Agent 验证边界](AGENT_CORE_QUICKSTART.md#verification-scope--验证边界) 与 [Run 详情契约](LOCAL_API_CONTRACT.md#4-flowview-与操作反馈)。
