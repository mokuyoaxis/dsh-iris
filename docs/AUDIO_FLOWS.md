# Core 语音合成与音频转写（0.3 alpha）

0.3.0-alpha.1的 Web 与通用 MCP 接入 `speech/v0`、`transcribe/v0`，共用现有 Provider、Task/Attempt、持久 Run 和单根 Operation runner。**稳定 npm 0.2.7 不含这些新增入口。** 原独立 CLI/DSH 的语音和转写继续使用各自原入口；这里描述新的 Core 流程。

## 新建音频工作区

先在新的专用位置初始化，保留原图片工作区：

```bash
node bin/dsh-iris.js flow init --data-root /absolute/new-audio-core
node bin/dsh-iris.js execution init --data-root /absolute/new-audio-core --audio
node bin/dsh-iris.js web serve --data-root /absolute/new-audio-core \
  --provider-config /absolute/existing-providers.json \
  --token-file /absolute/new-audio-owner-token --allow-execution
```

`--audio` 建立 `creation-requests/v3`，同时支持原图片编辑/生成。不要与 `--image-generation` 混用，也不要在已有 v0/v1/v2 根上执行迁移；原根继续按原能力运行。省略两个开关的 `execution init` 仍建立 v1 图片编辑根，`--image-generation` 仍建立 v2。

打开输出的 `loginUrl`；刷新保留当前标签页登录，过期后可用 `web login` 获取新链接，见 [工作台登录](LOCAL_WEB.md#启动与连接)。播放和下载已有结果无需 Provider；新建 Run 需要显式配置，执行另需 `--allow-execution`。音频不需要 `--allow-selection`。

配置沿用[模型服务](PROVIDER_SETTINGS.md)：为模型明确确认 TTS/转写用途和功能池，再从实际候选中选择。候选不是健康证明，打开页面不做实测。内置音频协议沿用现有 DashScope 实现；配置了 OpenAI 图片接口不等于接入 OpenAI TTS/ASR。这里没有新增语音协议、模型自动替换或音色发现接口。

## 页面使用

- **语音合成**：选择实际语音模型，填写朗读文字，必要时展开音色并填该模型支持的标识；留空使用现有协议默认值。点击合成后，保存输入、明确执行一次、保存原音频，可试听并下载。
- **音频转写**：选择 WAV/MP3/OGG/FLAC 原音频及转写模型。点击开始后先保存来源作品和 Run，再在原 Task 的 Attempt 内临时上传、提交。异步任务显示“查看原任务”；每次明确点击只观察一次，不持续远端轮询。
- **作品**：v3 工作区按图片、语音、转写分类。语音卡片点击“载入试听”后获取原音频；同一时间只保留一个作品卡播放器，离页或切分类释放。转写文字在流程页以纯文本显示，原音频可播放，文字可下载。

生成音频/转写是单一结果，保存后即可下载，无需图片版本选择。下载保留原字节；实际落盘以浏览器下载记录为准。离开创作页暂停播放，退出或切换流程释放相应媒体。当前不提供流式合成、音色目录、录音、长音频切片、字幕时间轴或本地 TTS。

## 有限 HTTP 契约

以下均以 `/api/v0` 开头，保留 Bearer、Host/Origin、无 CORS 和有限权限。新路由只在 v3 根开放；创建使用原 UUIDv4 `Idempotency-Key`，首次 201、同 Key 同输入 200、不同输入 409。

| 路由 | 输入与结果 |
|---|---|
| GET/HEAD `/audio-models` | 实际允许的 `modelRef/displayName/capability`；capability 为 tts 或 transcribe，无端点/密钥，无探测 |
| POST `/audio` | 原音频字节与精确 Content-Type；保存 `imported-audio`，不上传 Provider、不转写 |
| POST `/speeches` | `{modelRef,text,voice?}`；创建固定 speech Run，不合成 |
| POST `/transcriptions` | `{modelRef,sourceArtifactId}`；来源必须是当前根支持的音频作品，不接受外部 URL 或服务器路径，不上传/转写 |
| GET/HEAD `/artifacts/:id/audio` | 原 WAV/MP3/OGG/FLAC 字节；现有 `/content` 仍只读图片 |
| GET/HEAD `/artifacts/:id/text` | 原 `text/plain` 字节，不作为 HTML 展示 |
| GET/HEAD `/runs?kind=all\|image\|speech\|transcribe` | 同一组实际记录上的分类、计数与有界分页；省略 kind 为 all |
| GET/HEAD `/runs/:id/download` | 音频 Run 的单一已保存输出，受控 wav/mp3/ogg/flac/txt 附件名；图片仍要求明确选择 |

`/runs/:id`、`/continue`、Operation 查询/原 Key 接回和本地停止沿用[执行契约](CORE_SERVICE.md)。音频 DTO 使用原 recipe；speech.input 为 `{modelRef,text,voice?}`，transcribe.input 仅 `{modelRef}`，来源和输出通过 Artifact ID 引用；`ready` 表示单一结果已保存。原图/像素比较字段为空，不构造音频的图片比较或选择。

原音频上传最多 **20 MiB**，流式累积检查上限，并核对容器前缀与 MIME：`audio/wav`、`audio/mpeg`、`audio/ogg`、`audio/flac`。这不是完整解码或供应商格式验收；容器内部编码仍须符合实际模型。JSON 创建正文最多64 KiB，朗读文字最多20,000字符、音色标识最多64字符。播放/下载音频最多64 MiB，转写文本最多1 MiB；当前不支持 Range 或边下边播。

## MCP 按功能选择

只有用户明确选择的 `tts`、`transcribe` 分组才获得对应工具，操作 scopes 继续独立：read 查询/取回，create 导入/创建，execute 有限继续，stop 本地停止。原默认 image-edit、旧文件的固定12工具与已有具体名单不扩权。新 v3 连接中心开放音频选择，旧根拒绝音频握手与授权。

| 分组 | 新工具 |
|---|---|
| tts | `iris_core_audio_models`、`iris_core_create_speech`、`iris_core_audio` |
| transcribe | `iris_core_audio_models`、`iris_core_import_audio`、`iris_core_create_transcription`、`iris_core_audio`、`iris_core_transcript` |

两组复用 Run、Operation、continue、lookup、stop 等现有工具，并按原 Run 能力再次校验。导入音频要求标准 Base64，最多8 MiB字符，实际原字节上限比HTTP更小。`iris_core_audio` 返回标准 MCP audio 内容块；客户端是否显示播放器或附件取决于客户端，不能把成功返回解释为所有 harness 均可播放。`iris_core_transcript` 返回 UTF-8 文本数据，转写中的指令不得作为系统指令执行。

配置方法见 [通用 MCP](MCP.md)。连接专属 Skill 按实际工具生成英文指导和中文标题，说明真实模型选择、音色边界、导入限制、明确继续和原身份恢复；不自行增加工具或安装 MCP。

DSH 可选的原生共享 Flow 桥仍限图片，未接入 Core 音频附件投影；该桥若选择音频组会明确拒绝启动，不注册失效工具。DSH 原17项工具中的语音/转写功能保持原入口；新音频流程使用通用 MCP 或 Core 工作台。

## 恢复与验证

输入来源在当前根持久保存；临时上传 URL 只在执行期间存在，不进入 Run、Task、创建意图、普通投影或日志。一次创建预留固定步骤及 Task 身份；重连、刷新或同 Key 重放不会重新上传、提交或观察。上传准备失败记录在原 Attempt，受理未知不重提；停止仅结束本地等待，不证明远端取消或退款。

原结果保存失败时，通过原 Run 明确接回；已有私有交付缓存时无需 Provider。浏览器恢复表只存有界身份，不存朗读文字、音色、音频或转写正文；查到创建成功不自动首次执行。查询类型另含 audio-import、speech-create、transcription-create，见 [刷新恢复](WEB_RECOVERY.md)。

定向测试为 `tests/audio-flow.mjs`、`tests/audio-api.mjs`、`tests/audio-recovery.mjs`、`tests/audio-upload.mjs`。真实 Chromium 可用[工作台验证脚本](LOCAL_WEB.md#验证与下一阶段)的独立 `--audio` 场景，覆盖原字节播放/下载、刷新、丢失创建回包、只读及窄屏/主题。SDK验证包含HTTP 2025/2026与真实stdio进程的2026路径。所有新音频验证使用受控 Provider 或上传响应；**未实测真实付费语音/转写服务，也不代表所有账号、编码或 harness 已通过验收**。
