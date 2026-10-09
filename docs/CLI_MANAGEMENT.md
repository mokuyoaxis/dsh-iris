# CLI 配置与任务管理

本文面向 Iris 0.2.1，沿用 `dsh-iris` 入口，无需启动 DSH，未新增生产依赖。安装 `npm install @mokuyoaxis/dsh-iris@0.2.1` 后运行 `npx dsh-iris ...`；也可从源码或本地 tarball 使用同一入口。视觉命令见 [视觉 CLI](VISION_CLI.md)，基础媒体链路见 [Headless CLI](HEADLESS_CLI.md)。

所有需要 JSON 的命令均支持 `--input '<json>'`、`--input-file /path/input.json` 或 `--input -`（stdin），只能选择一种，输入最多 2 MiB。私有配置必须是普通文件、绝对路径，POSIX 权限为 `0600`。真实请求只由显式执行生成、发现、实测或观察命令触发。

## S2V 数字人视频

```bash
dsh-iris run video --data-root /path/core --provider-config /path/providers.json \
  --input '{"model_ref":"aliyun::wan2.2-s2v","first_frame_path":"/path/portrait.jpg","audio_path":"/path/speech.wav","resolution":"480P"}'
```

`first_frame_path` 与 `audio_path` 为绝对普通文件路径。提供音频时只选择 S2V 模型；显式选择普通视频模型会被拒绝，不能静默丢弃音频。S2V 的 prompt 可省略，resolution 支持 `480P`/`720P`，不接受 size/duration。普通图生视频也支持 `first_frame_path`，不能与 `img_data_url` 同时提供。

DSH/CLI 共用 Core Runner：每个候选先写 Attempt，再以该候选的账号上传首帧和音频；只有明确未受理才可切换，受理未知停止。取消上传不提交生成、不转下一候选。图片/音频路径、上传地址和凭据不会写入 Task。后续 `task observe/wait` 使用原 Task/Provider/binding，不再上传或提交；最终得到 `generated-video` Artifact。DSH 的本会话附件首帧仍支持，宿主把附件字节转换为可读文件。

## HTML 截图

```bash
dsh-iris media html --data-root /path/core --input-file /path/html-input.json \
  --browser-executable /path/chromium --output /path/screenshot.png
```

输入为 `{"html":"<h1>Hello</h1>","width":1280,"height":720,"full_page":true}`。视口宽高为 1–4096 的整数，默认 1280×720；默认整页截图，最多 4000 万像素、单边 16384。也可以用 `IRIS_BROWSER_EXECUTABLE` 提供可执行文件绝对路径，不自动寻找 DSH 的浏览器或配置。

独立 Chromium 通过 CDP pipe 通信、使用临时 profile 与临时回环 HTML 服务；操作结束或取消时关闭进程与临时目录。只接收 HTML 字符串，CSP 与原 DSH 渲染边界一致：允许内联样式、data/blob 图片、data 字体，禁止脚本、网络资源、表单和子页面。无任意 URL 截图入口。默认保留 Chromium 沙箱；确需在 root/PRoot 环境运行时，可显式传 `--browser-no-sandbox true`。默认整体超时 30 秒。

截图先保存为 `html-screenshot` Core Artifact，`--output` 可同时导出 PNG，不覆盖已有文件。DSH 的工具与工作台 action 复用同一 Command 保存 Artifact，浏览器仍由 Host Port 提供。

## 账号、模型与配置

| 命令 | 行为 |
| --- | --- |
| `config init/show/check` | 创建空私有配置（不覆盖）、脱敏查看、检查重复账号和失效分配 |
| `providers list` | 原有脱敏账号列表 |
| `providers add/set --input-file ...` | 添加/局部更新账号；JSON 是 provider 对象，必须包含 id |
| `providers remove <id>` | 移除指定账号，剪去失效分配 |
| `models list` | 模型复合引用、能力和实测事实 |
| `models add <ref> [--input ...]` | 添加模型；可给 capabilities，省略则按现有名称规则推断 |
| `models caps <ref> --input ...` | 手动能力标签（允许空数组） |
| `models protocol <ref> --input ...` | 单模型图片协议；`auto` 恢复账号默认 |
| `models vision-input <ref> --input ...` | 模型视觉输入预算；`null` 恢复账号继承 |
| `models remove <ref>` | 移除模型，剪去失效分配 |
| `models discover <provider-id>` | 请求发现，仅预览，不修改配置 |
| `models discover <provider-id> --apply true` | 合并发现结果，保留手工能力标签和已有实测记录 |
| `models test <ref> --capability vision` | 一次红图视觉实测，严格绑定该模型，记录 verified |
| `models test <ref> --capability image-gen/tts --data-root ...` | 实际生成测试，结果保存为 Core Task/Artifact，图片最多等待 60 秒 |
| `models test <ref> --capability video-gen/transcribe --data-root ... --input ...` | 使用真实素材单独实测，输入格式同 `run video/transcribe`，最多等待 60 秒；成功才恢复停用模型 |
| `assignments list/set/clear` | 查询路由候选、保存有序复合引用或清除指定能力分配 |

上述命令均需 `--provider-config /path/providers.json`。`<ref>` 必须是 `providerId::modelId`；媒体 run 的既有输入规则不变。`models test` 本身是显式真实请求，可能消耗额度，只调用指定模型，成功后解除该模型的冷却或耗尽停用。视频/转写未提供 `--input` 时返回 `skipped:true`，不请求供应商、不记录成功。`models list` 对受阻模型显示 `rateLimited`，短时限流另有 `retryAt`，明确耗尽另有 `reason`。

```bash
dsh-iris providers add --provider-config /path/providers.json --input-file /path/private-provider.json
dsh-iris models caps 'aliyun::qwen3-vl-flash' --provider-config /path/providers.json \
  --input '{"capabilities":["vision"]}'
dsh-iris assignments set --provider-config /path/providers.json \
  --input '{"capability":"vision","model_refs":["aliyun::qwen3-vl-flash"]}'
```

配置在明确写命令或真实请求首次确认冷却/耗尽时更新；只读查询和冷却到期不写配置、不请求模型。未知字段保留，每次写入先创建唯一的 `0600` 私有备份，再原子替换。备份包含原始凭据，按私有配置保管。并发修改检测失败则拒绝覆盖；不会自动迁移 DSH 配置或轮换备份。发现不会自动实测。脱敏输出不展示 API key、端点或原始错误正文。

### 看图输入预算

账号 `visionInput` 和 `models[].visionInput` 配置视觉发送副本的大小与最长边，用于看图、OCR 每块输入、定位及聊天改图。`maxBytes` 是图片编码字节上限，`maxDimension` 是最长边像素，均为正整数；模型逐字段覆盖账号，未设置时默认 8 MiB、不限制最长边。该默认值是客户端预算，不是上游能力声明。无需修改配置版本或迁移旧数据。

```bash
dsh-iris providers set --provider-config /path/providers.json \
  --input '{"id":"gateway","visionInput":{"maxBytes":12582912}}'
dsh-iris models vision-input 'gateway::vision-model' --provider-config /path/providers.json \
  --input '{"visionInput":{"maxDimension":2048}}'
dsh-iris models vision-input 'gateway::vision-model' --provider-config /path/providers.json \
  --input '{"visionInput":null}'
```

示例中的 12 MiB 仅演示已知上游限制，其他账号应按实际服务设置。`models list/config show` 返回模型的 `visionInputEffective`；模型发现保留已有覆盖。工作台账号详情、视觉模型行与聊天生图模型行提供 MiB、最长边和恢复继承。保存配置不调用模型、不改验证成功状态、不解除额度停用。

小图透传，超限 PNG/JPEG/WebP 等比缩小，保持真实格式和方向；Core 原图、尺寸和哈希不变，不创建预览 Artifact。读取原图片的本地上限仍为 20 MiB。OCR 先切片，再按实际候选预算处理每块，结果记录实际输入并提示缩小时的细字风险；定位显式转正图片，约定模型使用 0–1000 坐标，返回原图像素 bbox。DSH 使用核验后的实际附件尺寸。摘要拼图仍按原业务处理，动画需要缩放时拒绝。大小拒绝显示实际字节数与已知上限，400 不记为 429 冷却，不自动重发。

### 模型级图片协议

模型对象可选 `imageProtocol` 字段。支持 `dashscope`、`openai-images`、`openai-chat-images` 和 `openai-responses-images`；省略或使用 `auto` 时继承账号的 `mediaProtocol`。这个覆盖仅用于生图，不改变同模型的视觉能力或账号的视频、语音、转写路由。媒体端点仍使用账号的 `mediaBaseUrl`，留空沿用 `baseUrl`；DashScope 仍只允许阿里云官方 HTTPS 地址。

```bash
dsh-iris models protocol 'account::image-model' --provider-config /path/providers.json \
  --input '{"imageProtocol":"openai-images"}'
dsh-iris models protocol 'account::image-model' --provider-config /path/providers.json \
  --input '{"imageProtocol":"auto"}'
```

`models add` 的输入也可同时提供 `capabilities` 和 `imageProtocol`。`models list/config show` 展示模型覆盖值及有效 `imageRouting`；DSH 设置中的生图模型行可直接选择图片协议。发现和能力编辑保留协议覆盖，不扫描生图端点、不自动实测。改变有效协议使该模型的生图验证失效，保留其他能力、其他模型与已有额度停用；异步观察/取回仍核对原模型的提交协议，协议改变时在请求前停止。

`openai-chat-images` 是兼容网关的非流式 `POST /chat/completions` 生图扩展，读取消息正文中的图片 Markdown/data URL、`image_url` 内容块或 `message.images`；它不是 OpenAI 官方通用生图响应。普通文字或链接不会作为图片成功，纯文字 200 保留结果未知，停止自动切换接口或模型。只调用显式配置的接口，不扫描后缀。

例如已在目录中的 `gemini-image` 可显式设置生图能力及聊天协议，随后直接生成并按返回的 Artifact ID 看图：

```bash
dsh-iris models caps 'gateway::gemini-image' --provider-config /path/providers.json \
  --input '{"capabilities":["image-gen"]}'
dsh-iris models protocol 'gateway::gemini-image' --provider-config /path/providers.json \
  --input '{"imageProtocol":"openai-chat-images"}'
dsh-iris run image --data-root /path/core --provider-config /path/providers.json \
  --input '{"prompt":"画一只蓝色机器人","model_ref":"gateway::gemini-image"}'
dsh-iris vision look --data-root /path/core --provider-config /path/providers.json \
  --model-ref 'gateway::gemini-3.8-flash' --input '{"artifact_id":"artifact_ID"}'
```

聊天生图不发送 Images 的 `size` 参数；显式传入会在请求前报错，尺寸可在提示词中描述。`n>1` 使用聊天协议的候选数量参数，是否支持及实际图片数量由网关决定；默认单次请求一张。手动实测使用无尺寸参数的同一适配器。

`openai-responses-images` 调用非流式 `POST /responses`，提交 `image_generation` 工具并指定 `action:generate` 和工具选择；`store:false`、`background:false`。模型引用指定 Responses 主模型，图片工具模型使用服务端默认，需选择支持图片工具的主模型。官方完成态 `image_generation_call.result` 为图片 base64；网关完成态消息中的 `output_text` 图片 Markdown/data URL 也可读取，这种消息不能证明执行了官方工具。参考 [官方图片工具说明](https://developers.openai.com/api/docs/guides/tools-image-generation)。

```bash
dsh-iris models protocol 'gateway::gemini-image' --provider-config /path/providers.json \
  --input '{"imageProtocol":"openai-responses-images"}'
dsh-iris run image --data-root /path/core --provider-config /path/providers.json \
  --input '{"prompt":"画一只蓝色机器人","model_ref":"gateway::gemini-image"}'
```

此切片只支持同步生图、`n=1`，多图数量在请求前拒绝；可选 `size` 传给图片工具（例如 `1024x1024`，尺寸支持由服务端决定），默认与手动实测不指定尺寸。纯文字、无图、非法 base64 或未完成结果均停止并保留未知，不自动改接口或重提。目前不接后台轮询、多轮编辑、源图上传或 `/images/edits`。

四种生图适配器共用 Core 交付，按实际图片字节识别 PNG/JPEG/WebP；MIME、`.png`/`.jpg`/`.webp` 后缀与 SHA-256 匹配，保留原字节，不因 data URL 标注、HTTP 头或 URL 后缀而转码。图片格式不受支持或取回失败只标记交付失败，保留远端成功事实，不自动重新生成。

## Artifact 聊天改图

为 `run image` 提供 `source_artifact_id`，将当前 Core 中的原图与修改指令一起发送给支持带图编辑的 `openai-chat-images` 模型：

```bash
dsh-iris run image --data-root /path/core --provider-config /path/providers.json \
  --input '{"source_artifact_id":"artifact_ID","prompt":"把蓝色发饰改成白色，保留人物、服装和构图","model_ref":"gateway::gemini-image"}'
```

来源必须是同一数据根中的有效 Artifact ID（`artifact_` 后 24 位十六进制），最多 20 MiB 的静态 PNG/JPEG/WebP；创建 Task 前核验哈希、MIME 和真实格式。不需要导出原图，不支持 GIF/动画或蒙版。省略 `model_ref` 时沿用生图候选顺序，只保留聊天生图协议；显式指定其他协议会在 HTTP 前拒绝，不误发普通文生图。模型是否实际支持编辑由上游决定。

原图只读，发送副本复用默认 8 MiB 与账号/模型 `visionInput`，按每个实际候选分别处理。新 Task 保存 `sourceArtifactId`，新 Artifact 保存 `derived-from` 来源关系；输出原字节及 MIME 保留。返回的新 Artifact ID 可继续 `vision look/ocr`、导出或编辑。

未知受理、纯文字响应和交付失败不会自动重提或切换端点。知情 `task retry --confirm-billing true` 必须在新的 `--input` 中重新提供 `prompt` 和 `source_artifact_id`，模型覆盖使用外层 `--model-ref`。Core 删除预览会识别原图被编辑任务与新作品引用的情况。DSH 对应工具为 `iris_edit_image`，动作是 `image_edit`，工作台图片卡提供“改图”。

## 等待与查询

```bash
dsh-iris task wait task_ID --data-root /path/core --provider-config /path/providers.json \
  --timeout-ms 120000 --poll-interval-ms 2500
dsh-iris task list --data-root /path/core --capability video --status succeeded --limit 20 --offset 0
dsh-iris artifact list --data-root /path/core --kind generated-video --media-type video/mp4 --limit 20
```

`task wait` 只观察原 Task，不重新提交或自动 redeliver/retry。默认 120 秒、2.5 秒间隔，超时上限 20 分钟；超时中断在途 poll/下载，保留远端受理事实，可再次 wait。已结束的任务仅只读检查，不需要 Provider 配置或网络。退出码：ready 为 0，未成功交付为 1，超时为 3，SIGINT/SIGTERM 为 130/143。

分页默认 limit=50，上限 200，offset 非负。Task 支持 status/capability/provider-id/model-ref/outcome/delivery-state；Artifact 支持 kind/media-type/task-id。先过滤再分页，total 是过滤后的匹配总数。列表只读，不触发观察或重建。

```bash
dsh-iris task inspect-many --data-root /path/core --input '{"task_ids":["task_ID"]}'
dsh-iris artifact inspect-many --data-root /path/core --input-file /path/artifact-selection.json
dsh-iris artifact export-many --data-root /path/core --input-file /path/artifact-selection.json --output /path/export-directory
```

Artifact 批量输入为 `{"artifact_ids":["artifact_ID", "artifact_OTHER"]}`，最多 200 个唯一 ID。批量查询逐项报告事实或错误；批量导出要求已有绝对输出目录，文件名由 ID 和媒体扩展名生成。所有 ID、媒体哈希及目标存在性先预检，失败则零导出；后续 I/O 错误逐项报告已导出与失败结果，退出码 1。不会覆盖已有文件，不隐式选择全部作品。

## Core 删除、清理与恢复

```bash
# 默认只读预览；引用未同时选入时返回阻挡原因。
dsh-iris core delete --data-root /path/core --input-file /path/deletion-selection.json
# 输入为 {"task_ids":[...],"artifact_ids":[...]}，执行需明确标志。
dsh-iris core delete --data-root /path/core --input-file /path/deletion-selection.json --confirm-delete
dsh-iris core transactions --data-root /path/core
dsh-iris core restore delete_ID --data-root /path/core

dsh-iris core cleanup --data-root /path/core
# 使用预览中的相对 paths 明确选取，不支持 glob。
dsh-iris core cleanup --data-root /path/core --input-file /path/cleanup-selection.json --confirm-delete
```

仅允许确定终态 Task；活跃任务和受理/结果未知任务保留。Task 的 Artifact 引用、Artifact 关系、Artifact 的 taskId、后继任务 retriedFrom 都会阻止单独删除，需同时选入相应记录。不自动级联删除。

删除先写事务清单，再把指定 Core 文件移到同一数据根的 `maintenance/v0/quarantine/delete_ID/`，更新已提交 Artifact 的派生索引，不接回孤儿、不升级早期记录。中途失败尽力补偿，保留事务 ID；崩溃后 `core transactions/restore` 可按写前清单恢复。恢复核对哈希、大小和原位置，不覆盖冲突文件。

清理预览只列出默认一小时以上、原进程已退出的已知下载 `.part`，及没有 record/Manifest/Task/关系引用的已知孤立对象；`older_than_ms` 最小一分钟。执行必须提供当前仍符合条件的具体 paths。符号链接、未知文件、未提交 Manifest、legacy `outputs/` 和外部路径不会清理。Doctor 仍只读报告，无自动删除或修复。

**隔离保留字节，暂不提供永久 purge，因此不会立即释放这部分磁盘空间。** DSH 工作台也已接上同一删除预览、隔离与事务恢复，见 [工作台作品管理](WORKBENCH_ARTIFACTS.md)；旧版永久删除/清空语义保持原样。收藏/标签、搜索及永久 purge 另行安排。
