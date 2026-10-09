# dsh-iris 用户指南

本指南说明如何安装、配置和使用 Iris 0.2.1。升级范围见 [CHANGELOG](CHANGELOG.md) 和 [发布说明](docs/releases/0.2.1.md)。

## 安装

先运行 `dsh --version`。Iris `0.2.1` 仅声明支持 DSH `0.2.0-rc.2`；旧 DSH `>=0.1.2-rc.1 <0.1.3-0` 或 `0.1.5-rc.1` 使用固定版本 Iris `0.1.4`。验证边界见[适配说明](docs/DSH_RC2_ADAPTATION.md)。还需要 PATH 中的 `pnpm`，以及至少一个媒体或视觉服务供应商。Iris 0.2.1 要求 Node.js 22.0.0 或更高版本，旧 npm 0.1.4 的历史要求为 20.10.0；如果所用 DSH 版本要求更高，以 DSH 为准。Iris 0.1.1 及后续 0.1.x 不兼容 DSH 0.1.0/0.1.1 的旧客户端 Runtime。

在上述旧 DSH 范围内，从 npm 安装固定稳定版到 Web profile：

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.1.4
dsh web
```

npm 上无 scope 的 `dsh-iris` 是另一款插件；安装或更新 Iris Media 时必须使用完整 scoped 包名。

只下载旧稳定包可运行 `npm pack @mokuyoaxis/dsh-iris@0.1.4`，安装为普通 npm 依赖可运行 `npm install @mokuyoaxis/dsh-iris@0.1.4`；后者不会自动加入 DSH profile。固定版本仍可在 latest 更新后安装，0.1.4 不包含新的 Core 媒体 CLI。DSH rc.2 使用 0.2.1。

在 DSH `0.2.0-rc.2` 上，从 npm 安装：

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.2.1
dsh web
```

浏览器默认打开 `http://127.0.0.1:3080`。插件安装后只会在下一次 DSH 启动时装载；如果 DSH 已经运行，请先停止再启动。启动输出包含一次性认证参数时，必须完整打开该 URL，不能只输入裸地址。

### 独立 CLI

无需 DSH，在自己的项目安装 `npm install @mokuyoaxis/dsh-iris@0.2.1`，通过 `npx dsh-iris --help` 查看入口。详见 [Headless CLI](docs/HEADLESS_CLI.md) 和 [视觉 CLI](docs/VISION_CLI.md)。

其他 DSH 版本，包括 `0.2.0` 正式版与其他 rc，须另行验收。让 Agent 协助安装时，可使用[简要 Prompt](docs/AGENT_QUICKSTART.md)。

通过 dsh-market 安装时也要核对显示的 Iris 版本、完整 scoped 包名和 DSH 支持范围。市场可能缓存 npm 信息；旧宿主仍按固定 `@0.1.4` 命令安装，不直接跟随 latest。

可以在启动前检查组合配置：

```bash
dsh --profile web --dump-config
```

输出中应出现 `@mokuyoaxis/dsh-iris` 配置层和唯一行 ID `mokuyoaxis-dsh-iris`。DSH 的插件命令和 profile 机制见[官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。

## 最快配置：DashScope

打开“设置 → Iris 工作台”，然后：

1. 点击“+ 添加供应商”。
2. 名称可填“阿里云百炼”。
3. Base URL 填 `https://dashscope.aliyuncs.com/compatible-mode/v1`；如果账号使用百炼业务空间专属域名，再把“媒体 Base URL”填为同地域的 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`（地域按账号实际情况替换）。
4. 填入与模型、Endpoint 同地域的 DashScope API Key，点击“保存”。
5. 展开刚添加的供应商，点击“发现模型”。

如果只有一个供应商，可以先保留“能力分配”为自动。Iris 会从模型池中为画图、视频、语音、转写和视觉能力选择第一个匹配模型。需要固定模型或设置故障转移顺序时，再到“能力分配（failover 顺序）”中调整。

保存供应商和修改能力分配都会立即生效，不需要重启 DSH。

## 供应商与协议

Iris 当前支持两类调用路径：

| 路径 | 可用能力 | 说明 |
|---|---|---|
| DashScope 百炼 | 图片、视频、TTS、转写、视觉 | 覆盖最完整；媒体请求只允许阿里云官方 HTTPS 域名 |
| OpenAI 兼容 | Images/聊天/Responses 图片生成、聊天带图编辑、Chat Completions 视觉 | 具体模型和能力取决于兼容服务 |

工作台会按实际媒体端点安全推断协议：设置了“媒体 Base URL”时以它为准，否则沿用 Base URL。阿里云官方 DashScope、地域和 Workspace HTTPS 域名可使用 `dashscope`，其他地址使用 `openai-images`，也可以在供应商卡片中明确选择。即使配置被误标为 `dashscope`，Iris 也会在 fetch 前拒绝向非官方地址发送 DashScope API Key。分离端点后，普通 Base URL 可继续服务视觉/对话，媒体 Base URL 专门服务图片、视频、TTS、转写和媒体模型发现；留空即保持旧行为。

0.2.1支持每个生图模型独立设置 `imageProtocol`，省略或 `auto` 继承账号默认。例如网关的 `gemini-image` 如果通过聊天接口返回图片，可显式设置 `image-gen` 能力和 `openai-chat-images` 协议；已验证 Responses 生图的模型可选择 `openai-responses-images`（当前同步单图）。同账号的其他模型仍可使用 `openai-images` 或 `dashscope`。仅有模型名称的目录不会自动证明生图能力。产物保留真实 PNG/JPEG/WebP 字节和后缀，保存为 Core Artifact 后可按 ID 看图/OCR，详见 [配置与使用示例](docs/CLI_MANAGEMENT.md#模型级图片协议)。

同一个 OpenAI 兼容 Base URL 只有在实际提供相应接口时才能承担对应能力：图片生成按模型配置选择 Images、聊天或 Responses 接口，聊天改图需模型支持带图生成，视觉理解需要支持图片输入的 Chat Completions 接口。通用 OpenAI 兼容端点目前不能替代 Iris 的 DashScope 视频、TTS 或转写协议。

自动选择的未知端点会在供应商管理区显示“协议为推断值，请确认”，仍按 OpenAI Images 兼容格式请求。显式选择协议后清除标记；不支持的显式协议会在请求前报错，配置值仍保留。视觉类型 `type` 与媒体协议独立，未支持的视觉类型不会被转换为 OpenAI。

## 模型池

“发现模型”对普通 OpenAI 兼容服务读取 `GET /models`；对阿里云官方端点读取并分页拉完 `GET /api/v1/models`。官方 `IG/VG/ASR/TTS/VU` 能力元数据优先，缺少元数据时才按模型名兜底。用户手工纠正的能力标签优先级最高，后续重新发现不会覆盖。发现失败时，原模型池不会被清空。

模型发现采用合并更新：保留手工模型、手工能力标注及本次目录未返回的旧模型，只追加或更新发现项。删除模型仍需用户显式操作。运行时仅使用已配置模型；某项能力缺少模型时会提示配置，不再猜测厂商默认值。旧裸账号的兼容目录会在配置写入时转成可编辑的模型条目，显式空模型池不会触发该迁移。

模型池中的能力名称如下：

| 能力 | 配置值 | 典型工具 |
|---|---|---|
| 图片生成 | `image-gen` | `iris_draw_image` |
| Artifact 原图编辑（聊天生图） | `image-gen` | `iris_edit_image` |
| 视频生成 | `video-gen` | `iris_generate_video` |
| 语音合成 | `tts` | `iris_speak_text` |
| 音频转写 | `transcribe` | `iris_transcribe_audio` |
| 视觉理解 | `vision` | `iris_look_at_image`、OCR、定位、视频摘要 |

没有 `/models` 接口时，可以在供应商的模型池中手动添加模型名。Iris 能识别常见的 wan、qwen-vl、qwen-tts、qwen-audio ASR Filetrans、Fun-ASR、paraformer、gpt-image、dall-e 和 Gemini 命名；无法识别的模型需要在高级配置中显式填写 `capabilities`。

点击模型旁单项能力标记会进行验证。视觉、图片和 TTS 会先显示确认框，再发起真实供应商请求，不是本地校验：

- 视觉测试会发送一张最小测试图；
- 图片和 TTS 测试会生成真实产物；
- 视频不会自动提交探针，因为“只确认受理”也可能创建计费任务；正常使用可通过“视频生成”验证，耗尽后的恢复须用 CLI `models test --capability video-gen --input` 明确提供真实素材。
- 转写不使用空样本探针；耗尽后的恢复须用 CLI `models test --capability transcribe --input` 明确提供真实音频。

模型不必经过“测”才能使用；正常的真实任务成功也会形成健康证据。模型池按钮只测试被点击的“供应商 × 模型 × 能力”，不会顺带验证同名模型或其他能力。

### 健康颜色与时间

工作台顶部、功能卡片、模型池和主泡泡共享同一份持久健康快照：

| 颜色 | 状态 | 如何得到 |
|---|---|---|
| 灰色 | 未配置 | 没有可用的当前候选；默认 bearer 认证缺 Key 时会回到灰色，`auth:'none'` 不要求 Key |
| 蓝色 | 已配置，待验证 | 配置可用于路由，但尚无 7 天内成功证据，或旧成功已经过期 |
| 绿色 | 近期验证成功 | 显式实测或真实任务在 7 天内成功 |
| 暗红色 | 认证失败 | 最近出现明确 401、403 或认证/权限错误 |
| 琥珀色 | 429 冷却中 | 临时跳过模型，显示恢复候选资格的时间；优先遵从 `Retry-After`，默认 60 秒 |
| 红色 | 额度/预算耗尽已停用 | 明确免费额度或预算耗尽，手动实测成功后恢复 |

绿色旁显示最近成功时间，受阻模型显示原因和时间。短时限流与明确耗尽按账号 × 模型持久记录，重启后继续跳过；冷却到期只恢复候选资格，不发起请求、不自动变绿。实测按钮保持可用，可提前检测；只有明确的实测成功才解除持续停用，失败、发现、改变分配或旧任务成功都不能解除。修改 Key/端点会使旧验证证据失效，但不会清除耗尽停用。网络、5xx、内容安全、取消和受理未知不覆盖近期成功。此冷却/耗尽规则已纳入 0.2.1。

有多条 failover 路径时，可用候选近期成功则汇总为绿色，其次为待验证的蓝色；全部仅冷却时为琥珀色，全部受阻且含决定性失败时显示调用受阻。没有路径则为灰色。完整契约见 [Provider 与能力健康状态](docs/PROVIDER_HEALTH.md)。

## 能力分配和故障转移

每项能力都可以设置一个有序的“供应商 + 模型”列表。界面显示的是模型名和供应商，配置中保存为 `providerId::modelId` 复合引用，因此不同供应商的同名模型不会冲突。

- 未手工分配时，每个新请求都从模型池第一个匹配项开始；这不是 round-robin。
- 手工列表中的模型优先，并按列表顺序尝试。
- 模型池中其余具备该能力的模型仍会作为后续候选。
- 点击“恢复自动”会清除手工顺序。

生成类故障转移只覆盖上传、提交和同步生成阶段。远端一旦受理异步任务，Iris 就会继续跟踪这个任务，不会因轮询或下载失败自动重提，以免重复生成和计费。

## 从旧工作台显式导入

`ai-paint` 是 Iris 维护者本机未公开的前身项目，不是公开依赖。普通用户不需要、也不应该为了使用 Iris 去下载、安装或自行创建 ai-paint 目录；直接在 Iris 工作台添加供应商即可。

旧版读取路径同时承担了本机迁移和密钥保护作用：由运行 DSH 的宿主进程直接读取维护者已有的本地配置，可以避免为了迁移把 API Key 重新粘贴到 Agent 会话、命令行参数或文档中。它不是一个配置服务，也不意味着 Iris 运行时应该长期依赖另一个项目。

从 0.1.1 起，Iris 独立保存供应商、密钥、模型池和能力分配，位置为 `$DSH_HOME/iris/v1/providers.json`（未设置 `DSH_HOME` 时使用用户目录下的 `.dsh`）。修改 Iris 配置不会影响 ai-paint，反之亦然。

默认启动不会扫描 ai-paint 或其他项目。推荐通过工作台手动添加供应商；需要迁移旧 ai-paint 配置时，先停止目标 DSH 实例并备份其 Iris 配置，再显式指定来源文件的绝对路径。Bash 示例：

```bash
IRIS_IMPORT_WORKBENCH_CONFIG="/absolute/path/ai-paint/data/config.json" dsh web
```

其他 Shell 请使用其环境变量设置方式。`IRIS_IMPORT_WORKBENCH_CONFIG` 的值只是来源配置文件的路径，不包含 API Key；该变量属于运行 DSH 的进程，目标仍由该进程的 `DSH_HOME` 决定。导入仅在 Iris 没有供应商时执行，复制供应商基本信息和凭据，不修改来源文件、不合并覆盖已有供应商，也不迁移模型池或能力分配。之后应在工作台检查协议并重新分配模型，后续启动不再设置此变量。

变量未设置时不进行导入；相对路径会被拒绝。文件不可读、JSON 无效或没有有效供应商时会给出提示，不输出密钥。导入后的密钥写入 Iris 自己的配置文件，权限设为仅当前用户可读写；工作台和接口只返回密钥提示，不返回完整值。该操作不发送模型请求。

## 工作台作品管理

作品库统一展示 Core 与旧版的图片、视频、音频和文本，默认每页 24 个，可按媒体类型、来源和产物类型筛选。刷新或关闭识别结果保留当前页码与筛选。

Core 图片卡可直接点击“看图”或“OCR”；结果可以复制、下载为文本或取消。原始 PNG 可直接识别，不需要复制附件路径或转换 JPG。OCR 会明确显示部分完成，详细用法见 [工作台作品管理](docs/WORKBENCH_ARTIFACTS.md)。这些入口属于 0.2.1，更新本地插件后需重新加载 DSH 后端与客户端。

作品详情和跨页选择支持批量管理：可复制选中 ID，或把 Core/旧版作品合为一个 ZIP 下载（最多 200 项、128 MiB）。Core 删除先展示预览，明确确认后移入可恢复回收区；任务/产物引用会阻止删除，关联的已结束任务记录需逐项明确勾选。“Core 回收区”可恢复同一隔离事务，遇到原位置冲突不会覆盖文件；旧版作品仍保留原有永久删除语义。

### 按 Artifact ID 改图

Core 静态 PNG/JPEG/WebP 图片卡可点击“改图”，填写修改指令，再选择聊天生图模型。点击“生成修改版”才调用模型，修改版保存为关联原图的新作品，原图保留；可继续看图、OCR、下载或编辑。

Agent 可调用 `iris_edit_image`，提供 `source_artifact_id`、`prompt` 与可选 `model_ref`。CLI 使用 `run image` 的同名字段，详见 [Artifact 聊天改图](docs/CLI_MANAGEMENT.md#artifact-聊天改图)。仅支持 `openai-chat-images` 的带图生成，不提供 mask、多参考图或连续编辑历史。

## 高级配置文件

一般应使用 Iris 工作台。只有在配置工作台尚未覆盖的协议或模型能力时，才需要直接编辑：

```text
$DSH_HOME/iris/v1/providers.json
```

没有设置 `DSH_HOME` 时，默认位置是 `~/.dsh/iris/v1/providers.json`。

直接编辑前先停止 DSH；Iris 会缓存已经加载的配置，运行时改文件不会可靠地刷新内存状态。示例：

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

`mediaBaseUrl` 可以省略或留空，此时媒体调用沿用 `baseUrl`。`assignments` 可以省略；省略后使用模型池顺序。包含特殊字符的 provider 或模型引用会经过 URL 编码，复杂引用建议在工作台中生成，不要手写。

可为明确不需要认证的本地端点设置 `"auth": "none"` 并省略 `apiKey`；缺省或 `"auth": "bearer"` 仍要求 Key，保持旧配置行为。无认证模式不会发送 Authorization 头，已有的旧 Key 也不会被带入该模式的媒体请求。工作台尚无专门的无认证开关，需要按上述停机原则编辑私有配置；不要对需要认证的公网端点使用 `auth:none`。

API Key 以明文保存在宿主侧的 `providers.json` 中。POSIX 上 Iris 目录为 `0700`、文件为 `0600`，0.1.1 首次启动会收紧既有 Iris 树但不修改内容或跟随符号链接；Windows 的 mode 不能替代 ACL。状态接口和界面只返回掩码，不会显示完整 Key。不要把这个文件提交到版本库或发给他人。

## 文件输入

Iris 工作台中的文件字段提供三种方式：

1. “上传文件”：推荐方式，适合浏览器和 DSH 不在同一文件系统的情况。
2. “会话附件”：复用当前会话或 Iris 已生成的图片。
3. “高级·宿主路径”：填写 DSH 进程能够读取的绝对路径。

浏览器上传单文件上限为 64 MB，默认保留 7 天。视频和音频操作最终都需要一个宿主可读路径；浏览器自己的路径、`content://` URI 和远程电脑上的路径不能直接使用。跨系统细节见[文件访问与跨环境](docs/file-access-across-environments.md)。

看图、定位和 OCR 还可直接使用 Core 图片 `artifact_id`；视频摘要可复用 `frame_artifact_ids`。Core ID 与会话附件 ID 不混用，原 PNG 无需先转换为 JPG。Artifact 输入只读核验 MIME 与哈希，不要求原文件或临时导出。

视觉操作共用完整终态、取消和整体预算。账号/模型的输入预算只处理发送副本，默认 8 MiB；Core 原图与下载保持不变。长图 OCR 最多 32 块、64 次生成、120 秒，明确标记部分完成和缩小时的细字风险；定位将模型的 0–1000 归一化坐标映射回原图像素。配置与示例见 [输入预算](docs/CLI_MANAGEMENT.md#看图输入预算)、[OCR](docs/OCR_MODEL.md) 和 [定位/摘要](docs/COMPOSITE_VISION.md)。

## 最小指令

配置完成后，可以直接在会话中说：

```text
使用 iris_draw_image：画一只坐在蓝色窗边的白猫。
```

```text
总结我刚上传的这张图片。
```

```text
用 Iris 总结 /absolute/path/demo.mp4，再把摘要合成为语音。
```

直接写工具名最明确；自然语言也可以，由 Agent 判断需要调用哪个 Iris 工具。视频、图片和语音生成可能产生供应商费用。

从 0.1.2 起，插件会在 DSH Skill registry 可用时自动注册 `iris-verify-ui` 和 `iris-compose-media`，不要求会话工作区位于本仓库，也不需要用户复制 `.dsh/skills/`。项目目录中存在同名 Skill 时，DSH 仍优先使用项目版本；宿主未提供 Skill registry 时不影响 Iris 工具（0.2.1共 15 个）。

用户想稳定指定方法时，可直接用 DSH 的 `/name` 形式：

```text
/iris-compose-media 分析我上传的产品照，生成同构图海报，再检查是否符合要求

/iris-verify-ui 对比当前截图和参考图，定位偏差并给出有证据的结论
```

也可以继续用自然语言让 Agent 自动发现。单步绘图、OCR、转写等无需强行唤起组合 Skill，直接说需求或指定对应 Iris 工具即可。Skill 只规划工具链，不会绕过 Iris 的任务、费用确认和安全边界。

## 对话框提示词优化

0.2.1增加“智能优化 / 只组装”、本次规则、可编辑结果和改动对照，详见 [提示词优化与规则组装](docs/PROMPT_OPTIMIZER.md)。规则按次传入，不修改现有 v1 配置；后续独立提示词优化系统另行安排。

安装并启用 Iris 后，DSH 对话输入区会出现一个没有边框、底色和文字的“🫧”入口。点击后打开半透明玻璃悬浮窗；桌面端靠近输入区，手机窄屏自动变为底部面板，并适配浏览器安全区、可用高度和内部滚动。它独立于 Iris 工作台，可用于普通问答、写作、编程以及图片/视频生成提示词。[查看 Android 16 真机完整流程](docs/screenshots.md)。

使用流程：

1. 在对话框写入草稿，点击“🫧”。
2. 选择“通用对话、图片生成、视频生成、首尾帧视频”之一。
3. 点击“生成预览”。此时会调用模型，可能产生费用。
4. 检查结果后选择“写回输入框、复制、再优化”或“恢复原文”。Iris 不会自动发送消息。

默认路由是当前会话模型；当前会话没有选择时使用 DSH 默认模型。面板中的“JSON 配置”可以导出当前配置、导入修改后的 JSON，或恢复 Iris 内置默认值。配置单独保存在 `$DSH_HOME/iris/v1/prompt-optimizer.json`，不包含供应商 API Key，也不与 `providers.json` 混合。

导出文件格式：

```json
{
  "version": 1,
  "enabled": true,
  "systemPrompt": "你自己的优化器系统提示词",
  "targets": {
    "general": "通用任务的补充要求",
    "image": "图片提示词的补充要求",
    "video": "视频提示词的补充要求",
    "s2v": "首尾帧视频的补充要求"
  },
  "route": {
    "mode": "session"
  },
  "generation": {
    "temperature": 0.3,
    "reasoningEffort": "off-if-supported",
    "maxOutputTokens": 1200,
    "timeoutMs": 45000
  }
}
```

如需固定使用另一供应商模型，把路由改为：

```json
{
  "route": {
    "mode": "fixed",
    "provider": "DSH 中注册的 provider id",
    "model": "该 provider 下的 model id"
  }
}
```

`generation.reasoningEffort` 默认是 `off-if-supported`：Iris 查询 DSH 的模型元数据，只在模型明确提供 `off`（或等价关闭档位）时关闭 thinking；不支持时回退供应商默认值。它也可设为 `provider-default`（忽略会话档位）、`inherit`（显式继承会话 High/Low）或当前模型声明的具体 effort ID。thinking token 可能与正文共用 `maxOutputTokens`，因此不建议先盲目提高上限；优先关闭 thinking，或用 `fixed` 路由选择轻量非思考模型，确有长输出需求时再调高，当前允许 64–4096。Iris 不会自动重试，避免重复计费。

导入允许局部配置，缺少的字段会补成 Iris 默认值，未知字段不会落盘。面板导出的则是完整配置。Prompt 最大 32 KiB，结果最大 16000 字符；请求无工具权限，且不会附带会话历史、附件、工作区文件或 API Key。当前版本不会改写含 `@` 或 `/` 结构化引用的草稿，以免写回时破坏引用节点。面板可单独关闭这个对话入口；关闭后 Iris 工作台、Agent 工具和任务后台仍然运行，可在“设置 → Iris 工作台 → 对话框提示词优化”重新启用。开发中若只热更新了客户端而服务端尚未重载，关闭请求可能返回 `method not allowed`；重启 DSH 并刷新浏览器即可让新接口生效，正式安装或升级后也应重启宿主。

## 任务和产物

Iris 会在会话输入区显示运行中任务，并在 Iris 工作台保留最近任务。长时间生成转入后台后，可以让 Agent 调用 `iris_task_status`，或在工作台中打开任务详情。

Task v2 将“供应商是否受理、观察是否继续、远端结果和本地交付”分开记录。观察暂停、受理/结果未知，以及生成成功但交付失败会进入“需要处理”：

- **重新观察**：只恢复已有远端任务的轮询，绝不提交新的生成请求。
- **重新交付**：只重新查询并下载已经成功的远端产物；同步结果没有远端任务 ID 时会拒绝伪恢复。
- **知情重试**：新建一次可能收费的生成任务，必须独立确认，并在新旧 Task 间记录关联。创建新任务后，原提醒自动归档为“已通过重试处理”，不会继续占用泡泡角标。当前只为能无损还原输入的文生图和文生视频提供按钮；文件输入和可能被截断的文本应从原始输入重新发起。
- **标为已读 / 恢复提醒**：用户可以隐藏已经理解但暂不处理的提醒，并从历史详情重新打开。已读只影响提醒队列，不会把受理未知伪造成成功、失败或未受理。

旧版任务会明确显示“旧任务 · 只读”。只有服务端明确返回 `schemaVersion=1` 才使用该标签；客户端与服务端热更新暂时不同步时，不会把字段缺失的新任务误判为旧任务。

### 清除历史与作品库

工作台中的作品库独立于任务历史。新落盘媒体会自动入库；首次升级会接回已有 `outputs/`，也可以随时点击“找回本地作品”重新扫描。清空已完成任务或清理旧任务只删除任务状态、Prompt、错误与重试记录，作品仍可在工作台和泡泡打开。

旧版作品删除或清空会永久删除实际媒体文件，需独立确认；相关旧任务记录保留，但媒体链接失效。“删除孤儿产物”只处理 legacy `outputs/`。Core 作品使用预览和可恢复回收区，引用保护会阻止单独删除；关联已结束任务需逐项明确选择，恢复不覆盖冲突。详见 [旧版作品库](docs/ARTIFACT_LIBRARY.md) 与 [Core 作品管理](docs/WORKBENCH_ARTIFACTS.md)。收藏、标签和搜索仍为后续功能。

默认数据目录：

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/iris/v1/outputs/` | 图片、音频和视频产物 |
| `$DSH_HOME/iris/v1/uploads/` | 浏览器上传的临时输入 |
| `$DSH_HOME/iris/v1/tasks.json` | 任务状态与附件索引 |
| `$DSH_HOME/iris/v1/artifacts.json` | 作品库最小索引与随机访问令牌，不含 Prompt 和任务关系 |
| `$DSH_HOME/iris/v1/providers.json` | 供应商、模型池和能力分配 |
| `$DSH_HOME/iris/v1/prompt-optimizer.json` | 提示词优化器的用户 JSON 配置 |

音视频播放链接带随机令牌。默认只接受回环 Host。反向代理或 LAN 访问时，需要同时显式信任外部 Host，并按需设置媒体链接基址，例如：

```bash
IRIS_TRUSTED_HOSTS="dsh.example.com" DSH_WEB_BASE="https://dsh.example.com" dsh web
```

列表用逗号分隔，可填写 `host` 或精确的 `host:port`；反向代理应保留正确的 Host。`IRIS_TRUSTED_HOSTS` 只防止意外 Host 暴露，不验证用户身份。只要服务位于公网或不可信网络，就必须由反向代理或 DSH 部署层提供 HTTPS 和认证，不能把随机媒体令牌当作登录机制。

## 离线 Doctor

运行以下命令不会启动 DSH，也不会发送任何供应商请求：

```bash
npx @mokuyoaxis/dsh-iris doctor
npx @mokuyoaxis/dsh-iris doctor --json
```

已安装包也可以直接运行 `dsh-iris doctor`。退出码为 `0`（正常）、`1`（警告）和 `2`（硬错误）。Doctor 会执行一个随后立即删除的本地写入探针，并检查配置、任务、能力分配、临时文件和产物引用；输出不含完整 API Key。离线模式无法检查 DSH 工具/客户端是否已经装载，也不会用付费请求验证 Provider。

**0.2.0** 另提供 `doctor --data-root <绝对路径> --json`：只读盘点指定 Core 数据根的 Task、Artifact、Index 和租约，不执行上述写入探针，也不自动修复。`providers list` 与 `capabilities list` 可用 `--provider-config <私有配置绝对路径>` 只读查看脱敏供应商摘要和按配置排序的候选链；它们不代表远端能力已实测。异常退出留下租约时，先用显式 Doctor 查看 owner，再按 [Headless CLI 的恢复步骤](docs/HEADLESS_CLI.md#异常退出后的写者租约)人工确认并运行 `runtime recover`，不要手动删除租约。安装 npm 0.2.1 后使用 `dsh-iris` 命令；临时运行可用 `npx --package @mokuyoaxis/dsh-iris@0.2.1 dsh-iris ...`。旧版 0.1.4 不包含这些 Core 命令。

## Host Doctor

DSH 运行后，打开“设置 → Iris 工作台 → 宿主诊断”。卡片会自动检查当前 DSH 版本、Iris 服务端和客户端版本、工具注册（0.2.1为 15 个）、两项随包 Skill、四组 Web 路由、四个 UI Slot，以及 Browser、附件、会话和宿主模型端口；点击“刷新”可重新读取，展开项可查看全部结果。需要原始 JSON 时，可在已经完成 DSH Web 认证的同一浏览器访问 `/iris/api/doctor`。

Host Doctor 不打开 Browser、不读取附件或会话、不调用模型，也不请求供应商。报告中的 `exitCode` 是诊断严重度，不是 HTTP 状态：`0` 全部健康，`1` 有可降级警告，`2` 有硬错误。未安装 HTML Browser 时出现一条 Browser 警告是预期降级；如果提示尚未收到客户端握手，刷新 DSH 页面后再点“刷新”。若显示 `not found`，通常是前端已更新而 DSH 后端仍运行旧插件代码，应重启 DSH 后再刷新页面。

Host Doctor 显示通过，只代表“插件与宿主接口已正确装载”，不代表 API Key 或某个模型可调用。供应商侧应看能力健康颜色与恢复条件，并在模型池中显式实测或完成一项真实任务。完整字段和安全边界见 [Host Doctor](docs/HOST_DOCTOR.md)，两类检查的区别见 [Provider 与能力健康状态](docs/PROVIDER_HEALTH.md)。

## 可选依赖

0.2.1 提供 [独立视觉 CLI](docs/VISION_CLI.md)：`vision look / locate / ocr / summarize`。必须显式指定私有 Provider 配置；可指定 `--model-ref providerId::modelId` 严格选型、保存 JSON/文本或摘要拼图。默认只分析画面；文件输入不要求数据根，使用 `artifact_id` 或 `frame_artifact_ids` 时需显式数据根并只读 Core，主动音轨转写使用 Core writer。

视频文件抽帧依赖 PATH 中的 `ffmpeg` 与 `ffprobe`。缺少它们无法从视频文件生成新帧；摘要可复用既有 Core 帧 ID，不需要这两个工具。生成、看图、OCR 或语音工具不受影响。

DSH HTML 截图依赖宿主的 `dsh-builtin-browser`；独立 CLI 显式提供 Chromium 可执行文件，见 [HTML 截图](docs/CLI_MANAGEMENT.md#html-截图)。截图页在离线沙箱中运行，不加载远程脚本、字体或图片；需要的资源应内联到 HTML。

## 更新和卸载

更新 npm 版本：

```bash
dsh plugin --profile web update @mokuyoaxis/dsh-iris
```

从 0.1.1 升级到 0.1.2 时，插件自带 bundle 会自动使用新的唯一行 ID。如果你曾在个人 `cordis.patch.yml` 中手动覆盖 `id: dsh-iris`，需要把该覆盖改成 `id: mokuyoaxis-dsh-iris`，否则 DSH 会报告旧行未匹配。

更新后重启 DSH。卸载插件：

```bash
dsh plugin --profile web remove @mokuyoaxis/dsh-iris
```

卸载不会自动删除 `$DSH_HOME/iris/v1/` 中的配置和产物。

## 常见问题

- **对话框没有“🫧”入口**：确认 Iris 客户端已加载且当前存在会话；再到“设置 → Iris 工作台 → 对话框提示词优化”检查是否被单独关闭。
- **提示词优化提示没有模型**：先在当前会话选择主模型，或在 JSON 中配置 `route.mode: "fixed"`。
- **设置中没有 Iris 工作台**：确认插件已加入 Web profile，并在安装后重启 DSH；可用 `dsh plugin --profile web list` 和 `--dump-config` 检查。
- **没有可用模型**：先确认供应商已启用且 Key 有效，再运行“发现模型”；不支持 `/models` 时手动添加。
- **OpenAI 兼容图片请求走错协议**：核对模型的有效图片协议；`/images/generations` 使用 `openai-images`，网关聊天图片扩展使用 `openai-chat-images`，同步 `/responses` 生图使用 `openai-responses-images`。可在生图模型行或 CLI `models protocol` 设置模型级覆盖，不需要改变同账号其他模型的接口。
- **反向代理访问返回 `untrusted host`**：把浏览器实际使用的域名或 `host:port` 加入 `IRIS_TRUSTED_HOSTS`，保留 Host，并确认代理层已经启用认证。
- **看图可用但 Iris 模型池显示为空**：Agent 视觉工具可以回退到 DSH 全局视觉模型；需要在工作台操作时仍建议配置 Iris 的 `vision` 模型。
- **视频摘要提示 ffmpeg 不可用**：安装系统级 `ffmpeg` 和 `ffprobe`，并确保 DSH 进程的 PATH 能找到它们。
- **本地文件不存在**：这里的“本地”指 DSH 宿主，不一定是浏览器所在设备；优先用“上传文件”。
- **视频任务长时间运行**：不要重复提交。用 `iris_task_status` 或工作台任务详情查询原任务。
