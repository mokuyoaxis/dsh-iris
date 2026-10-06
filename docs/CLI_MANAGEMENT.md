# 开发版 CLI 能力补齐

以下能力已在工作树实现，尚未发布。沿用 `dsh-iris` 入口，不启动 DSH，不修改包名、版本或生产依赖。视觉命令见 [视觉 CLI](VISION_CLI.md)，基础媒体链路见 [Headless CLI](HEADLESS_CLI.md)。提示词优化后续由用户另行安排。

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
| `models remove <ref>` | 移除模型，剪去失效分配 |
| `models discover <provider-id>` | 请求发现，仅预览，不修改配置 |
| `models discover <provider-id> --apply true` | 合并发现结果，保留手工能力标签和已有实测记录 |
| `models test <ref> --capability vision` | 一次红图视觉实测，严格绑定该模型，记录 verified |
| `models test <ref> --capability image-gen/tts --data-root ...` | 实际生成测试，结果保存为 Core Task/Artifact，图片最多等待 60 秒 |
| `assignments list/set/clear` | 查询路由候选、保存有序复合引用或清除指定能力分配 |

上述命令均需 `--provider-config /path/providers.json`。`<ref>` 必须是 `providerId::modelId`；媒体 run 的既有输入规则不变。`models test` 本身是显式真实请求，可能消耗额度。视频/转写探针不猜测试素材，返回 `skipped:true` 并指引用 `run video/transcribe` 验证，不记录成功。

```bash
dsh-iris providers add --provider-config /path/providers.json --input-file /path/private-provider.json
dsh-iris models caps 'aliyun::qwen3-vl-flash' --provider-config /path/providers.json \
  --input '{"capabilities":["vision"]}'
dsh-iris assignments set --provider-config /path/providers.json \
  --input '{"capability":"vision","model_refs":["aliyun::qwen3-vl-flash"]}'
```

配置只在明确写命令中更新；未知字段保留，每次写入先创建唯一的 `0600` 私有备份，再原子替换。备份包含原始凭据，按私有配置保管。并发修改检测失败则拒绝覆盖；不会自动迁移 DSH 配置或轮换备份。发现不会自动实测。脱敏输出不展示 API key、端点或原始错误正文。

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

**隔离保留字节，暂不提供永久 purge，因此不会立即释放这部分磁盘空间。** DSH 工作台的删除与清空仍只处理 legacy 作品，本次新增入口仅在 Headless CLI。下一步 0.2.x 的收藏/标签、工作台分页及永久 purge 另行安排。
