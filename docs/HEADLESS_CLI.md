# Headless CLI（0.2.0）

Iris 0.2.0 提供无 DSH 的本地裁剪、图片 diff、视频抽帧，以及 Provider 媒体任务闭环。结果保存为 Core Artifact，并可在后续进程中检查或导出。Core 内部接口与 Artifact v0 尚未冻结为跨版本公共 SDK。

需要 Node.js ≥ 22.0.0。在自己的项目安装 `npm install @mokuyoaxis/dsh-iris@0.2.0` 后，通过 `npx dsh-iris ...` 使用命令；也可临时运行 `npx --package @mokuyoaxis/dsh-iris@0.2.0 dsh-iris --help`。下文的 `dsh-iris` 指该版本提供的可执行入口，不需要安装 DSH。

## 配置查询与离线诊断

```bash
dsh-iris providers list --provider-config /absolute/path/to/providers.json
dsh-iris capabilities list --provider-config /absolute/path/to/providers.json
dsh-iris doctor --data-root /absolute/path/to/iris-data --json
```

前两项只读取显式提供的私有配置文件，不创建 Core Runtime 或数据根，也不请求 Provider。`providers list` 输出供应商身份、启用/配置状态、认证方式、媒体协议及其推断标记、配置能力与模型数；不输出 API Key 或端点。`capabilities list` 按五种配置能力列出 `providerId::modelId` 候选链，沿用 DSH 的“手工分配优先、模型池顺序补齐”规则；空链标为 `gap: no_configured_model`。这些只是配置事实，不证明远端模型或协议可调用。

显式 `doctor --data-root` 是只读 Core 盘点：检查 Task/Artifact 结构、Index 一致性、孤立/未解析条目和写者租约；不创建缺失的根、不执行写入探针、不重建索引，也不释放租约。活跃写者可能使盘点在读取期间变化。省略 `--data-root` 时仍检查 DSH profile，保留原有写入探针，并纳入该 profile 的 `core-v0`。两种模式都返回 legacy/Core 计数对照，显式模式只统计指定根同层的 legacy 文件。退出码为 `0` 正常、`1` 警告、`2` 硬错误；诊断不会调用 Provider。

## 异常退出后的写者租约

SIGINT/SIGTERM 可被 CLI 捕获并释放运行中的租约；SIGKILL、OOM 或断电可能留下租约。后续写操作返回 `IRIS_CORE_DATA_ROOT_BUSY` 时，先用 `doctor --data-root <absolute-path> --json` 只读查看 `core-writer-lease`。仅当报告中的 owner PID 为 `missing`，并且你已确认没有跨主机或其他仍在写入的进程，才可显式回显该 PID：

```bash
dsh-iris runtime recover --data-root /absolute/path/to/iris-data --confirm-stale-pid 12345
```

此命令会再次核对租约证据和 PID，写入私有恢复审计记录后释放陈旧租约；活跃、无法确认、损坏或 PID 不匹配时拒绝。它不是 Doctor 的自动副作用，也不会修复 Task/Artifact。不要手动删除 `.iris-runtime-writer-v0` 或把“PID 不存在”单独当作安全证明。

## 裁剪并保存 Artifact

```bash
dsh-iris run crop \
  --data-root /absolute/path/to/iris-data \
  --input '{"image_path":"/absolute/path/input.png","left":10,"top":20,"width":640,"height":480}'
```

输出为 JSON，其中包含 `artifact.id`、媒体类型、字节数、创建时间与裁剪尺寸。结果不会返回输入文件或数据根的绝对路径。

## 本地图片差异与视频抽帧

两项命令只使用本机文件、Core Artifact、Sharp 与可选系统 ffmpeg；不读取 Provider 配置，不发起网络请求：

```bash
dsh-iris media diff \
  --data-root /absolute/path/to/iris-data \
  --input '{"image_a_path":"/absolute/path/a.png","image_b_path":"/absolute/path/b.png","grid":8,"top_regions":3}'

dsh-iris media frames \
  --data-root /absolute/path/to/iris-data \
  --input '{"video_path":"/absolute/path/clip.mp4","max_frames":8,"target_width":640,"format":"jpeg","quality":85}'
```

`media.diff` 返回差异比例、像素计数、最差区域和 `pixel-diff` 热力图 Artifact。A/B 两侧也可分别用 `image_a_artifact_id` / `image_b_artifact_id` 读取已有图片 Artifact；此时热力图写入 `derived-from` 关系。

`media.frames` 返回视频元数据和一组 `video-frame` Artifact；输入也可用 `artifact_id` 指向已有视频 Artifact，此时每帧写入 `frame-of` 关系。帧数最多 20，格式仅支持 `jpeg` 或 `png`；系统没有 ffmpeg/ffprobe 或视频无效时命令稳定失败，不影响其他 CLI 能力。Manifest 和命令结果都不保存宿主输入路径。

## Provider 图片生成

CLI 必须同时收到显式 Core 数据根和私有供应商配置文件，不推断 DSH、HOME 或 cwd：

```bash
dsh-iris run image \
  --data-root /absolute/path/to/iris-core-data \
  --provider-config /absolute/path/to/providers.json \
  --input '{"prompt":"一朵雨后的鸢尾花","model_ref":"provider-id::model-id","size":"1024*1024","n":1}'
```

`model_ref` 可省略；省略时采用“手工 assignment 顺序优先、模型池顺序补齐”的安全 failover。每个请求从首项开始，只有明确 `not_accepted` 才进入下一项。配置文件须为普通文件，POSIX 权限不得开放给 group/other；API Key、端点、Prompt 和下载 URL都不会写入 Task 输出。

模型必须存在于配置的 `models` 或旧模型字段中，且具备所请求的能力；缺失时返回配置错误，不注入厂商默认模型。显式 `models:[]` 表示没有可用模型。`model_ref` 也接受裸模型名，同名跨供应商时按配置中的供应商顺序取首项；需要精确绑定账号时使用 `providerId::modelId`。显式指定只选择该模型，不扩展 failover 候选。

旧裸 DashScope 账号的已知目录仅在 DSH 配置加载或保存时一次性写入 `models`，随后可见、可编辑；CLI 只读配置，不执行该迁移。独立 CLI 配置须自行声明模型。

同步图片会在一次命令内完成 Task → Attempt → Provider Adapter → download → Artifact。异步图片模型先持久化受理事实与远端 Task ID；之后由用户显式执行单步观察，不建立后台 timer。

视频（t2v/i2v）同样走 Core：

```bash
dsh-iris run video \
  --data-root /absolute/path/to/iris-data \
  --provider-config /absolute/path/to/providers.json \
  --input '{"prompt":"海浪拍岸","size":"1280*720","duration":5}'
```

输入冻结为 `{prompt, size?, duration?, img_data_url?, model_ref?}`：`img_data_url` 是首帧的 `data:image/` data URL（i2v）；s2v 数字人上传流程不在 headless 面开放。视频交付走独立 Profile：远端成功后下载为 `video/mp4`，Artifact kind 为 `generated-video`。受理后由显式 `task observe` 逐拍推进（DashScope 视频通常需要数拍）。

语音合成是同步完成型，一次命令内完成 Task → Attempt → 交付：

```bash
dsh-iris run tts \
  --data-root /absolute/path/to/iris-data \
  --provider-config /absolute/path/to/providers.json \
  --input '{"text":"要合成的文本","voice":"Cherry"}'
```

输入冻结为 `{text, voice?, model_ref?}`；产物走语音 Profile：`audio/mpeg`/`audio/wav` 白名单，Artifact kind 为 `generated-audio`（远端 URL 下载物化，inline base64 直接落盘）。同步完成即终态，`task observe/redeliver/cancel` 对终态语音任务一律拒绝，终态失败可用 `task retry` 显式重试为新任务。

转写是上传型异步：

```bash
dsh-iris run transcribe \
  --data-root /absolute/path/to/iris-data \
  --provider-config /absolute/path/to/providers.json \
  --input '{"audio_url":"https://example.com/public.wav"}'
# 或本地文件（经首选候选 Provider 的临时存储上传）：
dsh-iris run transcribe \
  --data-root /absolute/path/to/iris-data \
  --provider-config /absolute/path/to/providers.json \
  --input '{"audio_path":"/absolute/path/to/voice.wav"}'
```

输入冻结为 `{audio_url | audio_path, model_ref?}`（二选一）：`audio_url` 必须是 `https://` 或 `oss://`；`audio_path` 在命令内先上传为临时 `oss://` 地址再提交——**签名/临时 URL 绝不写入 Core 记录**。受理后由显式 `task observe` 逐拍推进；远端成功后正文物化为 `text/plain` 的 `transcript` Artifact（`artifact inspect/export` 可直接读取/导出文本）。终态失败可用 `task retry --input '{"audio_url":"..."}' --confirm-billing` 显式重试为新任务。

## 检查 Task 与 Artifact

Task 查询是纯 reader，不需要 Provider 配置，也不会触发 submit、poll、恢复或下载：

```bash
dsh-iris task list --data-root /absolute/path/to/iris-data

dsh-iris task inspect task_0123456789abcdef01234567 \
  --data-root /absolute/path/to/iris-data
```

输出只包含已经持久化的安全 Task/Attempt 事实；不返回 Prompt、API Key、下载 URL 或数据根路径。

新建 Attempt 可选保存 `stageTimestamps`：排队、开始提交、提交响应、远端终态、开始下载、下载校验完成和本地 Artifact 处理完成七个边界。字段按发生顺序单调不减；旧记录缺失该字段仍可读取。重新交付会从新的下载开始边界重新计时，不伪造尚未跨过的阶段。

新建 Attempt 还可选保存 `selectionReason`：`explicit` 表示调用方显式提供 `model_ref`，`assignment` 表示候选来自提交当时的能力分配，`pool` 表示由配置模型池按顺序补齐。它与 Attempt 一起在 Provider submit 前落盘；`task inspect` 只展示持久事实，不会用当前可能已变化的 assignment 事后猜测。旧记录没有该字段时保持缺失，不伪造默认值；第几次 failover 仍看 `ordinal`。

已受理的异步图片 Task 可以显式推进一次：

```bash
dsh-iris task observe task_0123456789abcdef01234567 \
  --data-root /absolute/path/to/iris-data \
  --provider-config /absolute/path/to/providers.json
```

每次命令最多执行一次 Provider `poll`；若远端已成功，则在同一次命令中下载并写入 Core Artifact。它不会调用 `submit`、不会采用当前 assignment/failover，也不会自动循环。CLI 只按 Task 中保存的 `providerId::modelId` 恢复原 Adapter：API Key 可以轮换；Provider 被停用、模型被移除或失去图片能力时会在网络请求前失败。

新 Task 还保存提交协议与实际媒体端点的 SHA-256 binding，不保存端点本身。端点或协议改变时，`observe` 会拒绝把旧远端 Task ID 发送给新端点。此前没有 binding 的异步 Task 保持可读，但不会被猜测性恢复；可继续使用创建它的旧入口处理。

同一份"显式单步观察、绝不重新提交"也已在 DSH 侧开放：工作台 API 提供 `POST /iris/api/core/task/:id/reobserve`，用户任务区的 Core 投影行和高级诊断卡提供「重新观察」按钮。三者经同一个 Command Service 命令（对外命令名 `task.reobserve`，实现与 `task.observe` 相同），共用原 Provider/binding 校验；每次调用至多一次 poll，对终态、未受理、无远端 ID 或 binding 漂移的任务在网络前拒绝。

已成功但本地产物取回失败（deliveryState=failed）的 Task 可以显式重新取回，绝不重新生成：

```bash
dsh-iris task redeliver task_0123456789abcdef01234567 \
  --data-root /absolute/path/to/iris-data \
  --provider-config /absolute/path/to/providers.json
```

每次命令至多一次带 redelivery 语义标志的 `poll`（拿远端产物清单）接一轮下载，写入新的 Core Artifact；不调用 `submit`、不新建 Attempt、不产生第二次生成费用。非 failed、无远端 ID 或 binding 漂移时在调用前拒绝；成功后再次调用被同样拒绝，失败回落 failed 后可再次显式执行。DSH 侧同构开放：`POST /iris/api/core/task/:id/redeliver` 与工作台「重新取回作品」按钮（delivery_failed 投影行的唯一动作）。

已受理且尚未终态的 Task 可以显式请求远端取消：

```bash
dsh-iris task cancel task_0123456789abcdef01234567 \
  --data-root /absolute/path/to/iris-data \
  --provider-config /absolute/path/to/providers.json
```

**只有供应商明确确认才把 outcome 写成 `canceled`**；供应商不支持远端取消（当前 DashScope 与 OpenAI Images 媒体协议均不提供经过验证的取消实现）时，取消未发生，任务保持真实状态并可继续显式观察；超时或网络失败记 `cancelState=unknown` 且保持非终态，可用 `task observe` 显式收敛。任何分支都绝不伪造"已取消"。已请求过取消但远端未确认的任务拒绝再次取消；竞态下远端先沉淀的成功事实不得被取消覆盖。DSH 侧同构开放：`POST /iris/api/core/task/:id/cancel` 与工作台需二次确认的「取消任务」按钮。

终态且未成功交付的 Task 可以重试为**新任务**。这是控制面唯一产生新的真实计费的动作，必须显式确认：

```bash
dsh-iris task retry task_0123456789abcdef01234567 \
  --data-root /absolute/path/to/iris-data \
  --provider-config /absolute/path/to/providers.json \
  --input '{"prompt":"重新输入的生成指令"}' \
  --confirm-billing \
  [--model-ref providerId::modelId]
```

缺 `--confirm-billing` 时在网络与创建之前拒绝。候选链按当前 assignments/池实况重新解析（不绑定旧 Provider/binding——旧配置可能正是失败原因），`--model-ref` 可显式指定。新 Task 有全新 id、attempts 与提交时实况 binding，并记录单向 `retriedFrom` 指向旧 Task；旧 Task 零变化。**Core 记录不持久化 Prompt**，所以生成指令必须由 `--input` 重新提供，绝不从旧任务恢复。DSH 侧同构开放：`POST /iris/api/core/task/:id/retry`（请求体必须 `confirmBilling:true`）与工作台「重试为新任务」按钮（重新输入指令 + 重复计费确认弹窗）。

重试输入按旧 Task 的能力校验：图片为 `{prompt, size?, n?}`，视频为 `{prompt, size?, duration?, img_data_url?}`，TTS 为 `{text, voice?}`，转写为 `{audio_url}`。视频首帧和转写地址会转换为 Provider 所需字段；原任务中的媒体输入不会自动恢复。转写 retry 要求重新提供 HTTPS/OSS 地址，本地 `audio_path` 上传仍通过正常提交入口处理；模型覆盖使用外层 `--model-ref`，不放在 retry 的 `--input` 中。

CLI、DSH 正常生成与 retry 共用输入规范：Prompt/文本修剪后为 1–20000 字符，图片 `n` 为 1–4 的整数（缺省 1），视频时长为 1–60 的数字，规范化后的显式 size/voice 为 1–64 字符。转写地址修剪后最多 20000 字符。数字字符串会转为数字；非法生成参数在提交前拒绝，不创建新的计费 Task。CLI 和 retry 还会拒绝未知输入字段；DSH 保留自己的宿主参数，由入口提取生成参数，工作台清空可选文本框仍使用默认值。

```bash
dsh-iris artifact inspect artifact_0123456789abcdef01234567 \
  --data-root /absolute/path/to/iris-data

dsh-iris artifact list --data-root /absolute/path/to/iris-data

dsh-iris artifact export artifact_0123456789abcdef01234567 \
  --data-root /absolute/path/to/iris-data \
  --output /absolute/path/cropped.png

dsh-iris artifact rebuild --data-root /absolute/path/to/iris-data
```

`task` 与 `artifact` 的 `inspect/list` 以 reader 打开数据根，不创建或修复文件。`run`、`export` 使用 writer；`rebuild` 是显式 recover 操作。同一数据根已有写者时返回 `IRIS_CORE_DATA_ROOT_BUSY`。导出默认不覆盖已有文件。

## 当前边界

- Core 的 `run`、`media`、`task`、`artifact` 和 `runtime recover` 操作必须显式提供绝对 `--data-root`，避免误写日常 profile；配置查询只要求 `--provider-config`，Doctor 省略数据根时按上述默认范围检查。
- 该路径只使用 Node.js、`sharp` 和 Iris Core，不加载 DSH/Cordis，也不启动服务；只有显式 `run image`、`run video`、`run tts`、`run transcribe`、`task observe`、`task redeliver`、`task cancel` 和 `task retry` 会访问供应商。
- Artifact Manifest v0 已包含 SHA-256、关系边、可重建 Index 和进程崩溃窗口恢复；格式与限制见 [Artifact Manifest v0](ARTIFACT_MANIFEST.md)。
- 当前开放 `crop`、同步/异步图片提交、视频 t2v/i2v 提交、语音同步合成（`run tts`）、音频转写（`run transcribe`）、图片/视频/转写单步观察（CLI `task observe` 与工作台「重新观察」共用）、失败产物重新取回（CLI `task redeliver` 与工作台「重新取回作品」共用）、人工取消（CLI `task cancel` 与工作台「取消任务」共用，只有供应商明确确认才记为已取消）、重试为新任务（CLI `task retry` 与工作台「重试为新任务」共用，必须显式确认计费且重新提供 prompt/文本/音频地址）、Task 只读查询与 Artifact 管理；自动观察、其他媒体能力和其余 Command 会按相同事实语义逐项迁入。
- CLI 暂不提供 Core Task/Artifact 删除能力（`task`/`artifact` 的 `inspect/list` 均为纯 reader）；DSH 工作台的删除、清空与孤儿清理也只处理 legacy `outputs/`，Core 作品同样只读。不要手动删除 `core-v0` 中的记录、Manifest 或对象；Core 删除与清理能力计划在 0.2.x 开放。

## 源码仓库的包外验收

在源码仓库运行以下开发验收命令，需要 Node/npm 与本机 ffmpeg/ffprobe：

```bash
node scripts/verify-headless-package.mjs
# npm 缓存完整时也可让依赖安装离线执行：
node scripts/verify-headless-package.mjs --offline
```

脚本在仓库外的独立临时目录打包、安装 tarball，通过 npm 安装的 `dsh-iris` 入口验证 help、crop、diff、抽帧以及图片、视频、TTS、转写的 Task/Artifact 闭环。安装树不含 DSH/Cordis，不链接仓库依赖；Provider 请求全部由复制到包外的 fixture 接管，本地 Sharp/ffmpeg 则实际处理媒体。报告检查每次 observe 只有一次 poll、无重提，Artifact 导出字节与 Manifest SHA-256 一致，reader 和导出保持 Core 零写入且不请求 Provider。

每次运行保留独立目录内的 tarball、安装日志、fixture 数据、导出产物和 `report.json`，终端输出验收目录和报告位置。该脚本属于源码开发工具，不随 npm 包发布；没有真实 Provider、DSH 重启或其他平台的验收结果时，不据此声明那些路径已通过。
