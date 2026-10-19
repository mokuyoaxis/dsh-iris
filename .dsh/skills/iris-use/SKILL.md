---
name: iris-use
description: "Use dsh-iris for a single media operation or an existing task: image import/creation/editing, vision/OCR, video, speech, music, and artifact delivery. 用于 Iris 图片导入、单步媒体操作、音乐生成、作品取回与任务状态查询；多步骤创作选 iris-compose-media，界面对照验收选 iris-verify-ui。"
---

# 使用 Iris 媒体能力

把用户要求交给对应的 Iris 功能，使用当前功能允许的模型，并交付实际产物。单独生成一首音乐、修改一张图片、识别文字或查询已有任务都适用本 skill。

## 选择入口

| 用户目标 | Iris 工具 |
|---|---|
| 保存上传图片或本地图片，供后续改图和导出 | `iris_import_image`，输入 image_path 或 attachment_id |
| 生成图片 | `iris_draw_image` |
| 修改已有 Core 图片 | `iris_edit_image`，输入 `source_artifact_id` |
| 理解图片 | `iris_look_at_image`；会话附件用 `iris_relook_attachment` |
| 识别图片文字、定位对象 | `iris_long_ocr`、`iris_locate` |
| 生成视频 | `iris_generate_video` |
| 合成说话声音、转写音频 | `iris_speak_text`、`iris_transcribe_audio` |
| 生成歌曲或配乐 | `iris_generate_music` |
| 裁剪、图片比较、静态 HTML 截图、视频抽帧 | `iris_crop`、`iris_pixel_diff`、`iris_html_screenshot`、`iris_video_frames` |
| 理解视频或已有帧 | `iris_media_summarize` |
| 查询已有任务 | `iris_task_status` |

多步骤作品与素材组合由 `iris-compose-media` 指导；界面还原、截图对照和视觉验收由 `iris-verify-ui` 指导。一次操作无需追加另一项 skill。

## 按当前能力执行

- 当前工具列表是可调用入口的依据；skill 可见不代表插件已经装载新工具。工具缺失、服务端/客户端不一致或模型未配置时，说明具体缺口。必要时查看 Iris 工作台的宿主诊断与能力分配，不以生成请求探测配置。
- 模型名称、供应商名称和模型目录不能证明能力。仅在用户明确指定时传 `providerId::modelId`，其余省略模型参数，按当前功能策略选择；不要默认填首个候选。Music 必须在当前功能允许范围内，并绑定音乐协议。
- 参数与输入输出的详细区别见[共享能力和产物说明](references/media-contract.md)。仅阅读当前操作相关部分。
- 请求歌曲或配乐时调用 Music；TTS 用于说话声音。音乐未配置或调用失败时报告原因，不擅自用 NumPy、节拍合成或 TTS 替代。用户明确要求程序化合成时按该要求处理。
- 音乐生成的时长、歌词、演唱语言和风格当前由 prompt 表达；不把它们当作保证生效的结构化控制。

## 交付与继续已有工作

交付实际返回的图片附件、Artifact ID、播放链接或文本，并保留 Task ID。Core ID、会话附件 ID、HTTP 播放链接和宿主文件路径是不同输入，按下一步需要使用或导出，不推测存储路径。

已有任务的失败、恢复、取消或重试，按需阅读[任务恢复说明](../iris-compose-media/references/task-v2-recovery.md)。Music 工具内部的有限502重试由参数控制；Agent 不在外层再包重试循环。

用户只请求生成时无需额外调用检查工具。确需复核时按原要求检查；音乐风格与听感由试听判断，不由音频格式或转写结果代替。未完成或未交付的任务如实报告，已有产物继续保留。
