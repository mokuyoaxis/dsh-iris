---
name: iris-compose-media
description: "Complete multi-step Iris creative requests and coordinated media assets: image revisions, image-to-video, video summaries with narration, talking videos, and optional music. 用于看图后绘图、图片修改与版本检查、视频总结配旁白、图片视频素材与可选配乐等创作流程。单步媒体操作用 iris-use，界面还原与验收用 iris-verify-ui。"
---

# 用 Iris 完成媒体创作

围绕用户要交付的作品组织必要步骤，复用已有素材，保留可以继续修改的版本。本 skill 适用于多步骤创作或多个配套产物；一次生成、改图、识别或查询由 `iris-use` 指导，界面还原与验收由 `iris-verify-ui` 指导。

## 确定本次作品

从用户要求确定已有素材、最终产物和关键完成条件。仅在缺失信息会实质改变作品时询问，其余采用合理假设继续。

不要因工具存在而追加分析、转写、检查或配乐。已有明确修改指令和Core原图时，可以直接编辑；不必先描述整张图。用户要求检查或修正时，按其要求复核与继续修改，保留每个有效版本。

调用参数、模型能力和素材身份按[共享能力和产物说明](../iris-use/references/media-contract.md)。当前工具与配置决定实际可用路线，目录中的模型名不能证明功能可用。

## 选择创作流程

按需要阅读[创作流程参考](references/workflows.md)的对应部分：

- 图片创作与版本修改：文字或参考素材 → `iris_draw_image` / `iris_edit_image` → 按要求看图或OCR → 交付选定版本。
- 图片视频素材：生成或复用首帧 → `iris_generate_video`；有源图时优先保留并复用。
- 视频内容与旁白：`iris_media_summarize` → 整理旁白稿 → `iris_speak_text`。
- 数字人口播：首帧 + 已完成的人声音频文件 → `iris_generate_video` 的S2V入口。
- 信息再创作：`iris_long_ocr` / `iris_transcribe_audio` → 核对可用文字 → 用户要求的新素材。
- 配套音乐：仅在用户要求或选择含配乐的流程时加入 `iris_generate_music`，和图片/视频分别保存与交付。

视频分析优先复用已有 `frame_artifact_ids` 或 `transcribe_text`，无需再调用 `iris_video_frames` 或转写同一素材。依赖步骤顺序执行；独立素材可以在宿主工具允许时并行，不据此承诺供应商限额或更高成功率。

## 完成素材衔接

每步保留实际返回的Task、Artifact和附件ID。下一步需要Core ID时直接复用；需要宿主文件时先明确导出。TTS与Music当前返回Core音频及播放链接，不能把链接作为 `audio_path`。

完成一个步骤后再启动依赖它的生成。排队、运行中或交付失败都不代表文件已经存在。已有完整作品的补交付、人工重试和Music内置502重试的区别，按需阅读[任务恢复说明](references/task-v2-recovery.md)。

## 按目标检查与交付

检查创作要求中的具体内容：图片的主体、文字和构图；视频的动作与片段用途；旁白的内容与声音。音乐风格与听感由试听判断。像素差异用于可比图片的测量，不是通用创作品质分数。

音乐为默认不执行的可选步骤。可选音乐失败时保留其他完成素材并报告缺失；用户明确要求带配乐成品时，缺少音乐意味着该要求尚未完成。当前Iris没有自动混音/合成工具，分别交付素材不能表述为已经完成配乐成片。

按本次授权的产物、修改范围和预算执行，不固定所有流程的Task数量。不要为一次失败再添加外层重试；用户取消时停止后续生成。报告已完成作品及可用链接/ID、部分结果、关键假设和未完成条件；进一步生成的费用与受理事实以任务记录为准。
