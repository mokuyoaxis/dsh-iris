# dsh-iris 用户指南

本指南面向 **Iris 0.3.3** 的 **DSH 原生插件**与 **独立 CLI** 入口。若你使用独立 Core Web 工作台与通用 MCP，请转至[Core 快速开始](docs/CORE_QUICKSTART.md)。发布说明与版本升级请参阅 [README](README.md)、[0.3 升级指南](docs/UPGRADING_0.3.md)、[0.3.3 发行说明](docs/releases/0.3.3.md) 与 [CHANGELOG](CHANGELOG.md)。

## 安装

安装前请确认环境满足 **Node.js ≥22.1.0**（DSH 宿主要求更高版本时以宿主为准）、PATH 中可用 `pnpm`，且 `dsh --version` 属于[兼容矩阵](docs/DSH_COMPATIBILITY.md)中列出的 **25 个**受支持 DSH 版本（`0.1.2-rc.1` 至 `0.2.2-rc.5`）。

将固定版本加入 DSH 的 Web profile 并启动（发布前验证请使用源码或本地归档）：

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.3.3
dsh web
```

> [!IMPORTANT]
> 安装或市场搜索时请认准完整包名 **`@mokuyoaxis/dsh-iris`**（无 scope 的 `dsh-iris` 是另一款插件）。若只下载本地归档可运行 `npm pack @mokuyoaxis/dsh-iris@0.3.3`。

- 浏览器默认打开 `http://127.0.0.1:3080`；若启动日志输出了一次性认证参数，请使用完整 URL 打开。
- 插件会在下一次启动 DSH 时装载（运行前可通过 `dsh --profile web --dump-config` 确认包含 `@mokuyoaxis/dsh-iris` 与唯一 ID `mokuyoaxis-dsh-iris`，profile 机制见 [DSH 官方文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)）。
- 如果让 AI Agent 协助安装与配置，可直接参考 [Agent 简要 Prompt](docs/AGENT_QUICKSTART.md)。

### 独立 CLI

无需 DSH，直接在自己的项目中安装使用：

```bash
npm install @mokuyoaxis/dsh-iris@0.3.3
npx dsh-iris --help
```

详细命令请参阅 [Headless CLI](docs/HEADLESS_CLI.md) 与 [独立视觉 CLI](docs/VISION_CLI.md)。

## 最快配置：DashScope

在 DSH 中打开 **设置 → Iris 工作台**，按以下几步即可完成首次配置：

1. 点击 **+ 添加供应商**（若 DSH 已配好同一服务的 API Key，可直接选用并[引用 DSH 连接](docs/DSH_PROVIDER_CONNECTIONS.md)）。
2. 名称填写“阿里云百炼”，Base URL 填写 `https://dashscope.aliyuncs.com/compatible-mode/v1`；如果使用百炼业务空间专属域名，将“媒体 Base URL”填写为同地域的 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`（地域按账号实际情况替换）。
3. 填入同地域的 DashScope API Key 并保存。
4. 展开供应商卡片中的 **模型目录** 并点击 **同步目录**（也可手动添加已知模型 ID）。目录会自动缓存 10 分钟，并在当前连接返回“模型不存在”时隔离不可用条目。
5. 点击 **设置功能**，勾选确认支持的用途；首次配置可同时勾选 **同时启用所选功能的自动池** 并保存。

配置保存后立即生效，无需重启 DSH。

## ComfyUI 工作台

在 **+ 添加供应商** 中选择 **ComfyUI · 已有服务**，填写服务地址与可选认证后，即可导入 API 格式工作流或 Iris 参数模板，映射提示词与输出节点并开放 LoRA 双权重、种子等标量参数。Iris 不会自行安装 ComfyUI 或猜测图结构；完整操作见 [DSH ComfyUI 入口](docs/IMAGE_GENERATION.md#dsh-工作台入口03-alpha)。

## 供应商与协议

Iris 支持两类主流媒体调用路径：

| 路径 | 支持能力 | 说明 |
|---|---|---|
| **DashScope（百炼）** | 图片、视频、TTS、转写、视觉 | 能力覆盖完整；媒体请求仅发送至阿里云官方 HTTPS 域名 |
| **OpenAI 兼容** | Images / 聊天 / Responses 生图、聊天改图、视觉理解 | 具体支持取决于兼容端点的实际接口 |

工作台会根据实际媒体端点（优先使用“媒体 Base URL”，留空则沿用 Base URL）安全判断协议；若系统自动推断了未知端点，界面会提示“协议为推断值，请确认”，你可以在供应商卡片中随时显式指定。需要区分同一账号下不同模型的生图接口时，可为单个模型设置 `imageProtocol`（如 `openai-chat-images` 或 `openai-responses-images`，省略或 `auto` 则继承账号默认，见[模型级图片协议](docs/CLI_MANAGEMENT.md#模型级图片协议)）。

## 模型池

点击 **同步目录** 时，OpenAI 兼容服务会读取 `GET /models`，阿里云官方端点会分页拉取 `GET /api/v1/models`，并将新的模型合并到当前列表（不会覆盖你手动维护的模型和空标签）。模型须经**确认用途**后才会进入对应能力池；如果服务端没有 `/models` 接口，可手动输入模型 ID 并标注用途。

模型池支持以下六类能力标识：

| 能力 | 配置值 | 典型 Agent 工具 |
|---|---|---|
| 图片生成 / Artifact 改图 | `image-gen` | `iris_draw_image`、`iris_edit_image` |
| 视频生成 | `video-gen` | `iris_generate_video` |
| 语音合成 | `tts` | `iris_speak_text` |
| 音频转写 | `transcribe` | `iris_transcribe_audio` |
| 视觉理解 | `vision` | `iris_look_at_image`、OCR、定位、视频摘要 |

> [!NOTE]
> 点击模型旁的能力标签可以进行**单模型实测**：视觉会发送最小测试图，图片和 TTS 会生成真实测试产物（可能计费，弹窗确认后执行）。视频与转写不会自动提交空样本探针，需要恢复耗尽状态时可使用 CLI `models test --capability video-gen|transcribe --input ...` 提供真实素材。

### 健康颜色与时间

工作台顶部、功能卡片、模型池与悬浮泡泡共享同一份健康状态视图（完整规则见 [Provider 健康状态](docs/PROVIDER_HEALTH.md)）：

| 颜色 | 状态 | 说明 |
|---|---|---|
| 灰色 | 未配置 | 当前没有可用候选（或 bearer 模式缺少 Key） |
| 蓝色 | 已配置，待验证 | 路由就绪，但最近 7 天内无成功记录 |
| 绿色 | 近期验证成功 | 最近 7 天内通过实测或真实任务成功调用 |
| 暗红色 | 认证失败 | 近期出现 401/403 等鉴权或权限错误 |
| 琥珀色 | 429 冷却中 | 暂时跳过，优先按 `Retry-After`（默认 60 秒）恢复候选资格 |
| 红色 | 额度耗尽已停用 | 明确触发额度/预算耗尽，需手动实测成功后恢复 |

## 能力分配和故障转移

你可以为每项能力配置**自动池**、**手动有序名单**或**停用**（详见 [功能模型池](docs/FUNCTION_MODEL_POOLS.md) 与 [分配说明](docs/FUNCTION_MODEL_ASSIGNMENTS.md)）：

- 界面显示模型与供应商名称，底层以 `providerId::modelId` 复合引用保存，避免不同供应商下的同名模型冲突。
- 每次请求按顺序从首项尝试；仅当供应商在上传、提交或同步生成阶段明确未受理时，才会切换到下一个候选。异步任务一旦被远端受理，Iris 会持续跟踪该任务，绝不因轮询或下载失败自动重提。
- “清空分配”会停止新调用，但已有任务和作品不受影响；DSH 主模型需在视觉策略中显式加入或启用才会参与视觉任务。

## 音乐生成

配置音乐服务时，添加对应模型并确认 **音乐** 用途，将协议设为 **Chat Completions（内嵌音频）**（要求响应正文中返回 MP3/WAV data URL），再启用自动池或加入手动名单即可。

默认情况下，音乐生成在遇到明确 HTTP 502 时会自动额外重试最多两次（即最多共提交三次，**可能产生额外费用**；可用 `retry_502: 0` 关闭）。完整参数与 CLI 用法见 [音乐生成](docs/MUSIC.md)。

## 从旧工作台显式导入

Iris 将供应商配置、密钥与分配独立保存在 `$DSH_HOME/iris/v1/providers.json`（未设置 `DSH_HOME` 时默认位于 `~/.dsh/iris/v1/providers.json`），与旧版 `ai-paint` 完全隔离。

若需要从旧版 `ai-paint` 迁移基础供应商信息与密钥，请先停止目标 DSH 实例、备份已有配置，再在启动命令中通过 `IRIS_IMPORT_WORKBENCH_CONFIG` 传入旧配置文件的绝对路径（仅在 Iris 尚无供应商时执行一次）：

```bash
IRIS_IMPORT_WORKBENCH_CONFIG="/absolute/path/ai-paint/data/config.json" dsh web
```

`IRIS_IMPORT_WORKBENCH_CONFIG` 的值只是来源配置文件的路径，不包含 API Key；导入过程只复制基础供应商信息与凭据，不修改原文件、不合并已有供应商，也不会迁移模型池或分配名单。导入完成后请在工作台核对协议与模型分配，并在后续启动时移除该环境变量。

## 导入已有图片

在作品区展开 **导入图片**，通过本地上传、会话附件或宿主路径导入最多 20 MiB 的静态 PNG/JPEG/WebP。导入会原样保留字节副本与原文件，不消耗模型额度，完成后可直接用于看图、OCR、改图或下载（Agent 工具为 `iris_import_image`，CLI 为 `artifact import`，详见[图片导入](docs/IMAGE_IMPORT.md)）。

## 高级配置文件

绝大多数配置均可直接在工作台完成。若需直接编辑 `$DSH_HOME/iris/v1/providers.json`，请先停止 DSH，修改后再重启：

```json
{
  "version": 1,
  "providers": [
    {
      "id": "iris_primary",
      "name": "Primary media provider",
      "type": "openai",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "YOUR_API_KEY",
      "enabled": true,
      "mediaProtocol": "openai-images",
      "models": [
        { "id": "gpt-image-1", "capabilities": ["image-gen"] },
        { "id": "vision-model", "capabilities": ["vision"] }
      ]
    }
  ],
  "assignments": {
    "image-gen": ["iris_primary::gpt-image-1"],
    "vision": ["iris_primary::vision-model"]
  }
}
```

- 省略 `mediaBaseUrl` 时沿用 `baseUrl`；对于明确无需认证的本地端点，可设置 `"auth": "none"` 并省略 `apiKey`（切勿对需要认证的公网端点使用无认证模式）。
- 含有特殊字符的 `providerId::modelId` 建议通过工作台生成；明文密钥以私有文件权限保存（POSIX 上目录 `0700`、文件 `0600`），请勿将此文件提交到代码仓库。

## 文件输入

工作台中的文件输入支持三种来源：

1. **上传文件**（推荐）：适合浏览器与 DSH 进程不在同一台设备或文件系统的场景，单文件上限 **64 MB**（默认保留 7 天）。
2. **会话附件**：直接复用当前对话或 Iris 已生成的图片。
3. **高级 · 宿主路径**：填写 DSH 宿主进程可读的绝对路径（跨环境细节见[跨环境文件访问](docs/file-access-across-environments.md)）。

Core 图片可直接使用 `artifact_id` 发起看图、定位、OCR 与改图，视频摘要可复用 `frame_artifact_ids`，无需转为 JPG。视觉模型默认使用 8 MiB 发送副本（原图不变）；长图 OCR 限制最多 32 块、64 次生成、120 秒总预算（详见 [输入预算](docs/CLI_MANAGEMENT.md#看图输入预算)、[OCR](docs/OCR_MODEL.md) 与 [定位/摘要](docs/COMPOSITE_VISION.md)）。

## 最小指令

配置完成后，可以直接在 DSH 对话中使用自然语言或工具名发起任务：

```text
使用 iris_draw_image：画一只坐在蓝色窗边的白猫。
总结我刚上传的这张图片。
用 Iris 总结 /absolute/path/demo.mp4，再把摘要合成为语音。
```

插件随包自动注册三项常用 Skill，你也可以直接以 `/name` 显式调用（三者共用[媒体契约说明](.dsh/skills/iris-use/references/media-contract.md)）：

```text
/iris-use 用已经分配的音乐模型生成一首摇滚配乐
/iris-compose-media 分析我上传的产品照，生成同构图海报，再检查是否符合要求
/iris-verify-ui 对比当前截图和参考图，定位偏差并给出有证据的结论
```

## 对话框提示词优化

启用插件后，DSH 输入框旁会出现半透明的 **🫧** 按钮，点击即可打开悬浮提示词优化面板（支持桌面悬浮窗与移动端底部面板，详情见[提示词优化与规则组装](docs/PROMPT_OPTIMIZER.md)与[真机截图](docs/screenshots.md)）：

1. 输入草稿并点击 **🫧**，选择目标场景（通用、画图、改图、视频、数字人）。
2. 选择处理方式：**忠实整理**（保留原文句序仅做分段整理，不调用模型）、**改写表达**（按规则润色，调用模型）或**只组装**（拼接模板前后缀）。
3. 检查对比预览，按需展开“可选补充与待确认”获取创意建议，确认后点击写回输入框或复制。

配置单独保存在 `$DSH_HOME/iris/v1/prompt-optimizer.json`，支持导出/导入局部或完整配置：

```json
{
  "version": 1,
  "enabled": true,
  "systemPrompt": "你自己的优化器系统提示词",
  "targets": {
    "general": "通用任务的补充要求",
    "image": "图片提示词的补充要求",
    "image-edit": "明确修改范围并保持原图其余特征",
    "video": "视频提示词的补充要求",
    "s2v": "首帧加音频数字人视频的补充要求"
  },
  "route": { "mode": "session" },
  "generation": {
    "temperature": 0.3,
    "reasoningEffort": "off-if-supported",
    "maxOutputTokens": 1200,
    "timeoutMs": 45000
  }
}
```

如需固定模型，可将 `route` 设为 `{"mode": "fixed", "provider": "<provider_id>", "model": "<model_id>"}`。`reasoningEffort` 默认为 `off-if-supported`（当模型支持关闭 thinking 时优先关闭，以免思考 token 占用 `maxOutputTokens`）。单次 Prompt 上限 32 KiB，输出上限 16000 字符，请求不携带工具权限、会话历史或 API Key，且默认跳过含 `@`/`/` 结构化引用的草稿。

## 任务和产物

运行中的任务会显示在输入区上方；长时间异步任务（如视频或转写）转入后台后，Agent 可通过 `iris_task_status` 查询，或直接在工作台查看详情。

当任务出现观察暂停、受理未知或交付失败时，工作台会将其归入“需要处理”，并提供精准恢复动作（底层诊断规则见[错误与取消传播](docs/PROVIDER_ADAPTER_CONTRACT.md#错误与取消传播)）：

- **重新观察**：仅对已有远端任务再查询一次，绝不重发生成。
- **重新交付**：仅重新下载已成功生成的远端产物。
- **知情重试**：显式确认计费后创建新任务并建立 `retriedFrom` 关联（文生图/视频支持快捷入口，文件类输入需从原始输入重新发起）。
- **标为已读 / 恢复提醒**：隐藏或恢复提醒角标，不改变任务本身的真实状态。

### 作品管理与数据目录

- **作品库与回收机制**：Core 作品支持直接点击看图、OCR、按 Artifact ID 改图（见[Artifact 改图](docs/CLI_MANAGEMENT.md#artifact-聊天改图)）、跨页勾选与批量 ZIP 打包下载（最多 200 项、128 MiB）。Core 删除默认先进入可恢复回收区并受引用保护，而旧版 `outputs/` 删除仍为永久生效（详见 [Core 作品管理](docs/WORKBENCH_ARTIFACTS.md) 与 [旧版作品库](docs/ARTIFACT_LIBRARY.md)）。
- **反向代理访问**：媒体链接带随机访问令牌，默认仅允许回环 Host；若需经反向代理或局域网访问，请在代理层配置 HTTPS 与身份认证后，显式设置信任列表：

```bash
IRIS_TRUSTED_HOSTS="dsh.example.com" DSH_WEB_BASE="https://dsh.example.com" dsh web
```

默认数据目录结构如下：

| 路径 | 用途 |
|---|---|
| `$DSH_HOME/iris/v1/outputs/` | 图片、音频和视频产物 |
| `$DSH_HOME/iris/v1/uploads/` | 浏览器上传临时文件 |
| `$DSH_HOME/iris/v1/tasks.json` | 任务状态与附件索引 |
| `$DSH_HOME/iris/v1/artifacts.json` | 作品库索引与访问令牌 |
| `$DSH_HOME/iris/v1/providers.json` | 供应商、模型池与能力分配 |
| `$DSH_HOME/iris/v1/prompt-optimizer.json` | 提示词优化器配置 |

## 诊断工具（Offline Doctor & Host Doctor）

- **离线 Doctor**（不启动 DSH、不联网调用模型）：

```bash
npx @mokuyoaxis/dsh-iris doctor --json
# 只读盘点指定 Core 数据根（不执行写入探针，也不自动修复）：
npx @mokuyoaxis/dsh-iris doctor --data-root /absolute/path --json
```

退出码含义：`0` 正常、`1` 有警告、`2` 有硬错误。若因进程强杀遗留写者租约，请先用 `doctor` 确认失效 PID，再按[写者租约恢复步骤](docs/HEADLESS_CLI.md#异常退出后的写者租约)执行 `runtime recover`。

- **Host Doctor**：在 DSH 中打开 **设置 → Iris 工作台 → 宿主诊断**（对应同源 `/iris/api/doctor`），可一键核对宿主/插件版本、17 个工具与 3 项 Skill、路由及 UI Slot 装载情况，并支持主动触发一次本地浏览器**截图自检**（详见 [Host Doctor](docs/HOST_DOCTOR.md)）。若尚未安装浏览器服务，出现 1 条 Browser 警告属于正常降级；如果接口返回 `not found`，通常需要重启 DSH 后端以加载最新插件代码。

## 可选依赖

- **视觉 CLI**：`vision look / locate / ocr / summarize` 支持独立 CLI 调用（使用 `artifact_id` 或 `frame_artifact_ids` 时需显式提供 `--data-root`）。
- **视频抽帧**：依赖系统 PATH 中的 `ffmpeg` 与 `ffprobe`；仅使用已有 `frame_artifact_ids` 做摘要时不依赖它们。
- **HTML 截图**：DSH 内需宿主提供 `browser` 服务（如 `dsh-builtin-browser`），独立 CLI 需显式指定 Chromium 路径（见 [HTML 截图](docs/CLI_MANAGEMENT.md#html-截图)）。截图页面在离线沙箱中渲染，需将依赖的资源内联进 HTML。

## 更新和卸载

```bash
# 更新插件（更新后请重启 DSH）
dsh plugin --profile web update @mokuyoaxis/dsh-iris

# 卸载插件（会保留 $DSH_HOME/iris/v1/ 中的个人配置与作品）
dsh plugin --profile web remove @mokuyoaxis/dsh-iris
```

> [!NOTE]
> 从 `0.1.1` 升级时，若曾在个人 `cordis.patch.yml` 中手动覆盖过 `id: dsh-iris`，需将其更新为 `id: mokuyoaxis-dsh-iris`。

## 常见问题

- **对话框没有“🫧”入口**：确认 Iris 客户端已加载且当前存在会话，再到“设置 → Iris 工作台 → 对话框提示词优化”检查是否被关闭。
- **提示词优化提示没有模型**：先在当前会话选择主模型，或在配置文件中改用 `route.mode: "fixed"`。
- **设置中没有 Iris 工作台**：确认插件已加入目标 Web profile 并重启了 DSH（可用 `dsh plugin --profile web list` 与 `--dump-config` 检查）。
- **没有可用模型**：确认供应商已启用且 Key 有效，运行“同步目录”后通过“设置功能”勾选用途；无 `/models` 接口时请手动添加模型并标注用途。
- **OpenAI 兼容图片请求走错协议**：检查模型级的 `imageProtocol`（`/images/generations` 用 `openai-images`，聊天带图接口用 `openai-chat-images`，同步 `/responses` 用 `openai-responses-images`）。
- **反向代理访问返回 `untrusted host`**：将实际访问域名或 `host:port` 加入 `IRIS_TRUSTED_HOSTS`，确保反代透传 `Host` 并配置好访问认证。
- **模型池为空时使用宿主看图**：在视觉手选名单中加入“DSH 当前默认模型”，或在自动池中显式启用宿主视觉（须宿主模型支持图片输入）。
- **视频摘要提示 `ffmpeg` 不可用**：安装 `ffmpeg` 和 `ffprobe`，并确保它们在 DSH 进程的 `PATH` 中。
- **本地文件不存在**：工作台中的“宿主路径”指 DSH 运行所在的机器，而非浏览器本地设备；跨设备场景请优先使用“上传文件”。
- **视频任务长时间运行**：请勿重复提交；使用 `iris_task_status` 或工作台任务详情查询原任务进度。
