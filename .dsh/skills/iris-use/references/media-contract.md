# Iris 能力与产物衔接

三项Iris skills共用本说明。图片导入、统一功能分配及原生Qwen改图要求Iris0.2.4，0.2.3不含这些增量；发布状态见README。按实际已装载工具schema调用，工具可用性以工具列表和安装版本为准。不要为阅读本说明调用模型或读取供应商凭据。

## 工具、输入和输出

| 工具 | 主要输入 | 完成后的输出 |
|---|---|---|
| `iris_import_image` | image_path 或当前会话 attachment_id 二选一 | imported-image作品、稳定Core Artifact ID和图片链接；保留原字节及源文件，不调用模型 |
| `iris_draw_image` | prompt，可选 size、n、model | Task、Core 图片 Artifact、DSH 图片附件；可能附有图片自述 |
| `iris_edit_image` | source_artifact_id、修改 prompt | 新图片 Artifact 与附件，保留原图和来源关系 |
| `iris_look_at_image` | image_path 或 artifact_id 二选一 | 图片理解文字 |
| `iris_relook_attachment` | attachment_id | 会话图片理解文字 |
| `iris_long_ocr` | image_path、artifact_id、attachment_id 三选一 | 识别文字和 complete/partial/failed 状态；部分结果不能当作全文 |
| `iris_locate` | 同上，加 target | 原文件像素 bbox 或未找到；模型定位不是像素真值 |
| `iris_generate_video` | 文本、首帧或 S2V 首帧加 audio_path | 完成后视频 Artifact/播放链接；等待未完成则返回 Task |
| `iris_speak_text` | text、可选 voice、model | Core 音频 Artifact 与播放链接，当前 Core 分支不返回本地文件路径 |
| `iris_generate_music` | prompt、可选 model、timeout_ms、retry_502、retry_delay_ms | MP3/WAV Artifact 与播放链接；有限重试可创建关联的新 Task |
| `iris_transcribe_audio` | 宿主 audio_path；CLI/Action另支持audio_url | Core 转写任务、文本产物；不保证有逐词时间轴 |
| `iris_task_status` | 可选 task_id | 任务事实及完成后的 Artifact/播放链接；查询不代替重新观察或交付 |
| `iris_crop` | image_path 或 attachment_id，加裁剪区域 | Core 裁剪图片与 DSH 附件 |
| `iris_pixel_diff` | 两侧各自使用图片路径或会话附件 | 差异统计、Core 热力图和 DSH 附件 |
| `iris_html_screenshot` | 静态 HTML 字符串 | Core 截图和 DSH 图片附件 |
| `iris_video_frames` | video_path | Core frame_artifact_ids、时间戳和会话图片附件 |
| `iris_media_summarize` | video_path 或 frame_artifact_ids 二选一 | 摘要和带时间戳的联系表附件，可消费现有转写文字 |

不要用工具名之外的虚构入口，例如 Iris 当前没有 Agent 提示词优化工具或自动音视频混音工具。提示词预览属于工作台/HTTP功能；Agent 可以直接整理已授权的创作要求，不必为了每次生成追加优化调用。

## 功能与模型选择

生图、视频、TTS、Music、转写和视觉按当前功能允许范围选择。0.2.4/0.2.5仅使用明确有序名单；0.2.6另支持已确认用途的自动池及显式停用，旧缺失/空分配不自动启用。仅在用户指定时传模型参数，只调用该项；默认省略，保留完整候选链。DSH默认视觉须明确加入名单或开启自动池的宿主视觉选项，不能在指定模型失败后隐式回退。手动实测独立于生产范围，旧任务查询/补交付仍绑定原模型。改图复用图片功能池，接受 `openai-chat-images` 或 `dashscope` 原生 Qwen edit/max/plus、2.0/pro及日期快照；其他原生Qwen版本尚未接入。源图为一个Core静态PNG/JPEG/WebP，最多20 MiB；不提供蒙版或多张参考图输入。默认发送预算8 MiB，可按账号/模型调整；原生Qwen发送副本另限10 MiB，原作品保留。

Music 为独立 `music-gen` 功能，仅使用其当前允许范围。模型须配置 `musicProtocol: gemini-web-music`；它不改变账号图片默认协议。其他 Music Adapter 尚未实现。当前正式参数控制客户端超时与502重试；曲长、人声、歌词、语言等是描述意图。

通用候选仅在明确未受理时切换。Music 的HTTP502策略是按配置重新生成同一模型，不是换供应商：默认额外2次、间隔5000ms，每次新Task并记录retriedFrom，可能额外消耗额度。Agent 调用一次工具后消费其结果；工具失败不授权另一层自动重试。已有完整结果优先补交付，详见各 skill 链接的任务恢复说明。

## 保持输入身份

- Core Artifact ID 指向当前数据根中的持久作品；会话 attachment_id 属于宿主附件。二者不可互换。
- `/iris/api/core/artifact/.../media` 是播放/下载链接，不是宿主 `audio_path` 或 `video_path`。
- `content://`、浏览器本地路径与普通网络URL不能直接充当宿主文件路径。已经有可用Core作品时优先复用，确需文件输入时才导出。
- 保存每步实际返回的ID。图片编辑保留原作品并创建新版本；不要为继续操作重新生成源素材。

用户上传或宿主本地图片要保存为可续作作品时，用iris_import_image显式导入；当前支持最多20 MiB的静态PNG/JPEG/WebP。已有Core图片直接复用其ID，不反复导入。导入不创建生成Task，返回ID可交给iris_edit_image的source_artifact_id。上传副本的临时路径不是持久作品ID。

CLI使用同一导入命令：

```bash
dsh-iris artifact import --data-root /absolute/path/iris-core \
  --input '{"image_path":"/absolute/path/source.png"}'
```

## 需要文件时导出

导出消费已有作品，不调用生成模型。DSH工具没有通用Artifact导出入口，可用工作台下载，或在具备Shell与相同Core数据根时使用CLI。以下路径和ID必须替换为已确认的实际值；输出文件不能覆盖已有文件。

```bash
dsh-iris artifact export artifact_ID \
  --data-root /absolute/path/iris-core \
  --output /absolute/path/narration.wav
```

按实际Artifact媒体类型选择后缀，导出不会转换格式。TTS → S2V：取回已完成音频Artifact → 导出 → 确认宿主文件可读 → 将该路径传给 `audio_path`。不得从ID或播放链接拼出文件路径。

## Core图片的本地处理

Agent crop/diff 工具使用路径或会话附件；CLI 可直接消费Core图片ID，无需先导出。CLI与Agent的参数表不能混用：

```bash
dsh-iris run crop --data-root /absolute/path/iris-core \
  --input '{"artifact_id":"artifact_ID","left":10,"top":20,"width":200,"height":100}'

dsh-iris media diff --data-root /absolute/path/iris-core \
  --input '{"image_a_artifact_id":"artifact_A","image_b_artifact_id":"artifact_B"}'
```

## 视频与声音的区别

- 文生/图生视频使用prompt、首帧及模型支持的size/duration。首帧附件限Iris生成图片的附件；其他图片应使用宿主文件路径。
- S2V为数字人口播：首帧加清晰的人声WAV/MP3，文件小于15 MB、时长小于20秒，resolution为480P或720P。不传文生/图生专用size/duration。
- 音乐不是S2V口播音轨的通用替代输入。配乐可作为独立素材交付；最终混音/合成只有在相应工具可用且任务要求时执行。
- 视频摘要已有Core帧时使用frame_artifact_ids，不重复抽帧；已有转写用transcribe_text。此模式不传video_path、抽帧选项或transcribe:true。
- 从视频文件抽帧需ffmpeg/ffprobe；复用Core帧不需要。Agent的视频文件摘要可以转写音轨；仅需画面时明确transcribe:false。
