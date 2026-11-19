# Headless CLI（0.3.0）

`dsh-iris` CLI 支持在完全脱离 DSH 宿主的环境下运行，通过显式传入 `--data-root`（物理数据根绝对路径）与私有 `--provider-config`，完成本地媒体处理、多模态生成、视觉分析、任务恢复与数据维护。

> [!NOTE]
> 如需在终端配合 Agent 使用图片工作流，可安装随包提供的 [`iris-core` Skill](CORE_SKILLS.md)。若需开启 Web 工作台与 MCP，请参阅 [Core 快速开始](CORE_QUICKSTART.md)。

## 安装与入口

```bash
npm install @mokuyoaxis/dsh-iris@0.3.0
npx dsh-iris --help
```

项目内安装 `@mokuyoaxis/dsh-iris@0.3.0` 时，`dsh-iris` 不会自动加入全局 `PATH`，因此以下示例统一使用 `npx dsh-iris ...`；从已执行 `npm ci` 的源码仓库直接运行时，将 `npx dsh-iris` 替换为 `node bin/dsh-iris.js`。要求 **Node.js ≥22.1.0**（若从旧版升级，请先阅读 [升级指南](UPGRADING_0.3.md)）。

## 配置查询、网络与离线诊断

```bash
# 查看脱敏后的供应商与六类能力候选链（不创建数据根，也不访问供应商）
npx dsh-iris providers list --provider-config /absolute/path/to/providers.json
npx dsh-iris capabilities list --provider-config /absolute/path/to/providers.json

# 只读盘点指定 Core 数据根（不执行写入探针，也不自动修复或释放租约）
npx dsh-iris doctor --data-root /absolute/path/to/iris-data --json
```

- **凭据与协议扩展**：供应商配置文件支持内联 `apiKey`、环境变量引用 `apiKeyEnv`（[环境凭据引用](PROVIDER_CREDENTIALS.md)）与模型级协议覆写；也可通过 `--provider-extension` 加载外部协议扩展。
- **网络出口管理**：通过 `network init/show/check`、`network nodes|pools` 与 `network catalog|bindings` 管理独立的私有网络出口配置，并在生成或查询命令中显式传入 `--network-config`（详见 [出口节点与池](NETWORK_RESOURCES.md) 与 [供应商出口绑定](NETWORK_ROUTING.md)）。
- **调度与服务**：`api serve` / `web serve` 可配合 `--scheduler-config` 开启[有界媒体调度](MEDIA_SCHEDULING.md)或 `--allow-network-management` 管理出口资源（见 [网络工作台](NETWORK_WORKBENCH.md)）。

> [!TIP]
> `doctor --json` 退出码：`0` 正常、`1` 有警告、`2` 有硬错误。省略 `--data-root` 时检查当前 DSH profile 及其 `core-v0`。

## 本地媒体工具（无模型调用）

裁剪、像素差异分析与视频抽帧仅在本地使用 `sharp` 与系统 `ffmpeg`/`ffprobe`，不读取供应商配置或发起网络请求：

```bash
# 裁剪并保存为 Core Artifact
npx dsh-iris run crop \
  --data-root /absolute/path/to/iris-data \
  --input '{"image_path":"/absolute/path/input.png","left":10,"top":20,"width":640,"height":480}'

# 像素差异分析（输出比率、最差区域与 pixel-diff 热力图；支持 path 或 Artifact ID）
npx dsh-iris media diff \
  --data-root /absolute/path/to/iris-data \
  --input '{"image_a_path":"/absolute/path/a.png","image_b_path":"/absolute/path/b.png","grid":8,"top_regions":3}'

# 视频抽帧（最多 20 帧，支持 jpeg/png；支持 video_path 或 artifact_id）
npx dsh-iris media frames \
  --data-root /absolute/path/to/iris-data \
  --input '{"video_path":"/absolute/path/clip.mp4","max_frames":8,"target_width":640,"format":"jpeg","quality":85}'
```

本地输入文件路径绝不会写入 Artifact Manifest 或命令返回结果；S2V、HTML 截图（`media html`）、批量检查与配置维护命令详见 [CLI 管理参考](CLI_MANAGEMENT.md)。

## 多模态生成与视觉分析

所有生成命令均需显式传入 `--data-root` 与私有 `--provider-config`（POSIX 文件权限须对 group/other 不可读写）：

| 命令 | 核心输入参数 | 执行与产物特征 |
|---|---|---|
| `run image` | `{prompt, size?, n?, model_ref?, source_artifact_id?, workflow_parameters?}` | 同步或异步提交；支持 `source_artifact_id` 改图与 [模型级图片协议](CLI_MANAGEMENT.md#模型级图片协议) |
| `run video` | `{prompt, size?, duration?, img_data_url?, first_frame_path?, model_ref?}` | 支持 t2v/i2v（以及 S2V，见[CLI 管理](CLI_MANAGEMENT.md)），产物为 `video/mp4` |
| `run tts` | `{text, voice?, model_ref?}` | 同步完成型，交付 `audio/mpeg` / `audio/wav` 到 `generated-audio` |
| `run transcribe` | `{audio_url \| audio_path, model_ref?}` | 上传型异步；`audio_path` 在取得写权与原 Attempt 后临时上传，签名 URL 不落盘，产出 `text/plain` |
| `run music` | `{prompt, model_ref?, retry_502?}` | 支持 `music-gen` 协议；遇 HTTP 502 默认最多额外重试 2 次（可能产生额外费用，可设 `retry_502: 0` 关闭），见[音乐生成](MUSIC.md) |
| `vision <look\|locate\|ocr\|summarize>` | 文本/图片路径或 Core `artifact_id` | 纯文件分析无需数据根；引用 Core 产物或主动音轨转写需 `--data-root`，见[独立视觉 CLI](VISION_CLI.md) |

```bash
# 图片生成示例（省略 model_ref 时按当前能力池顺序选取）
npx dsh-iris run image \
  --data-root /absolute/path/to/iris-core-data \
  --provider-config /absolute/path/to/providers.json \
  --input '{"prompt":"一朵雨后的鸢尾花","model_ref":"provider-id::model-id","size":"1024*1024","n":1}'
```

- **防重提与健康跳过**：每次请求从候选列表首项开始，只有明确 `not_accepted` 时才切换下一候选；短时 429 冷却与额度耗尽记录会自动跳过受阻模型（详见[Provider 健康状态](PROVIDER_HEALTH.md)）。
- **固定流程 CLI**：通过 `flow init` / `flow create` / `flow continue` / `flow select` / `flow export`（以及 `execution init`）可在独立根中管理固定可恢复流程与本地 API 服务（详见 [固定图片流程](IMAGE_FLOW.md)、[本地 API](LOCAL_API.md) 与 [Core 服务](CORE_SERVICE.md)）。

## 检查 Task 与 Artifact

查询命令以只读方式（`reader`）打开数据根，绝不修改数据或向供应商发起请求：

```bash
# 列出或检查 Task 事实（不含 Prompt、API Key、端点或数据根路径）
npx dsh-iris task list --data-root /absolute/path/to/iris-data
npx dsh-iris task inspect task_0123456789abcdef01234567 --data-root /absolute/path/to/iris-data
```

新建 Attempt 可选记录 `stageTimestamps`（7 个单调阶段时间戳）与 `selectionReason`（`explicit` / `assignment` / `pool`），供事后只读追溯。

### 控制与恢复已有 Task

| 命令 | 行为与安全边界 |
|---|---|
| `task observe <id>` | 对异步任务最多执行**一次** `poll`，若已成功则直接下载产物（`task wait` 提供单次命令内的有界轮询）；校验端点与协议 SHA-256 binding，漂移时在联网前拒绝 |
| `task redeliver <id>` | 针对生成成功但交付失败（`deliveryState=failed`）的任务重新取回产物；若有完整同步结果缓存可省略 `--provider-config`（见[同步交付恢复](SYNC_DELIVERY_RECOVERY.md)），绝不重新生成 |
| `task cancel <id>` | 向供应商发起取消请求；仅在远端明确确认时记为 `canceled`，绝不伪造已取消 |
| `task retry <id> --confirm-billing --input '...'` | 针对终态未成功任务创建**全新 Task**（建立 `retriedFrom` 关联）；因 Core 不保存 Prompt，须重新提供 `--input` 并显式确认 `--confirm-billing`；视频重试需额外在 `--input` 中指明 `"video_mode": "t2v"\|"i2v"\|"s2v"` |

```bash
# Artifact 管理与导出（export 默认不覆盖已有文件）
npx dsh-iris artifact import --data-root /absolute/path/to/iris-data --input '{"image_path":"/absolute/path/source.png"}'
npx dsh-iris artifact list --data-root /absolute/path/to/iris-data
npx dsh-iris artifact inspect artifact_0123456789abcdef01234567 --data-root /absolute/path/to/iris-data
npx dsh-iris artifact export artifact_0123456789abcdef01234567 --data-root /absolute/path/to/iris-data --output /absolute/path/out.png
npx dsh-iris artifact rebuild --data-root /absolute/path/to/iris-data
```

DSH 工作台与 Headless CLI 共用 Core 的可恢复隔离和恢复入口：通过 `core delete / cleanup / transactions / restore` 执行带引用保护与事务隔离的清理。legacy `outputs/` 的删除仍永久生效，两种行为须按作品来源区分（见 [CLI 管理](CLI_MANAGEMENT.md) 与 [工作台作品管理](WORKBENCH_ARTIFACTS.md)）。

## 异常退出后的写者租约

正常发送 `SIGINT`/`SIGTERM`（或 Windows 终端 `Ctrl+C`）时，CLI 会等待收尾并安全释放单写者租约。如果进程因 `SIGKILL`、OOM 或断电意外中止，后续写操作会提示 `IRIS_CORE_DATA_ROOT_BUSY`。

遇到繁忙时**切勿手动删除租约目录**，请按以下步骤确认并恢复：

1. 运行只读检查查看租约所有者信息：
   ```bash
   npx dsh-iris doctor --data-root /absolute/path/to/iris-data --json
   ```
2. 仅当报告确认 `ownerStatus` 为 `missing` 且确认本机或跨主机已无进程仍在写入时，显式回显该 `PID` 执行恢复（恢复过程会留存完整退役审计目录，详见 [Core Runtime 契约](CORE_RUNTIME_CONTRACT.md)）：
   ```bash
   npx dsh-iris runtime recover --data-root /absolute/path/to/iris-data --confirm-stale-pid 12345
   ```

## 包外打包验证

源码仓库提供独立包外回归脚本 `scripts/verify-headless-package.mjs`（支持 `--offline`），会在仓库外临时目录打包并安装 `.tgz`，使用离线 fixture 完整校验 CLI 帮助、本地图像工具及四类媒体闭环。
