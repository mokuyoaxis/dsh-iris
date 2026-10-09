# 单图视觉调用

状态：**Iris 0.2.1**。本文说明共享单图视觉调用。

## 使用与变化

Agent 的 `iris_look_at_image` / `iris_relook_attachment`、工作台的看图/重看，以及用户显式确认的视觉实测，改为消费共享 VisionModel Port。不自动生成媒体任务或保存 Core 产物。

`iris_look_at_image` 与看图动作现可用 `artifact_id` 代替 `image_path`，直接读取当前 DSH profile 的 Core 图片，二者必须二选一。图片的 MIME、原字节和内容哈希由共享读取器核对，不要求原文件或临时导出、不写入 Core；生成图片、HTML 截图、裁剪、视频帧均可使用。自持模型成功时无需为 Core 输入另存 DSH 附件；DSH 候选仍通过既有附件桥接。工具文字保留 Core ID，动作 JSON 带 `artifactId`。工作台原表单继续输入文件路径，动作 API 可直接传 ID。独立 CLI 的同一用法见 [视觉 CLI](VISION_CLI.md)。

Iris 按已配置的视觉模型顺序选择自持后端，最后考虑 DSH 默认视觉模型。DSH 必须明确提供 Provider、模型及图片输入能力；默认文本模型、未知元数据和身份漂移在生成前拒绝。自持成功时不查询 DSH 元数据或为回退额外保存附件。

只有明确认证/权限拒绝、速率/额度拒绝、正常完成但正文为空，以及本地能力不可用，才允许进入下一个候选。已收到部分正文、截断、工具调用、内容阻断、网络/协议错误、取消或超时都会停止操作。正常空结果后的切换可能已经产生上一模型的费用。

SSE `[DONE]`、EOF 或已经出现文字不代表完成。自持 Chat Completions 必须提供正常的 `finish_reason: stop`；DSH 必须提供可验证的正常 `finish`。正文超限和 token 截断明确失败，不再截取前若干字返回成功。DSH 的 `block-end` 替换同一块的 delta，思考正文不进入回答。

## 预算与图片

| 限制 | 默认值 |
|---|---|
| 整体时间 | 120 秒，覆盖文件/Artifact/附件读取、元数据、桥接及所有候选 |
| 输入文字 | 32 KiB UTF-8 |
| 原图片读取 | 20 MiB，PNG/JPEG/WebP/GIF 字节；本地看图工具沿用 PNG/JPEG/WebP 格式限制 |
| 自持看图、定位与 OCR 每块发送副本 | 默认 8 MiB，可按账号/模型覆盖；最长边限制可选 |
| 输出正文 | 6,000 个 UTF-16 code units，超限失败 |
| 生成次数 | 最多为本次有限候选表的长度，每个候选只调用一次；不可用候选不计生成次数 |
| 显式视觉实测 | 默认 15 秒，只调用指定的一个自持模型，不使用 DSH 回退 |

视觉能力探针使用 128×128 纯红 PNG。旧的 1×1 图片会被部分模型的最小尺寸检查拒绝，不能据此判断模型不支持视觉。

图片以字节与 MIME 进入共享层，Core 读取先核验原图哈希。看图、重看和生成后自述会在发送前按实际账号 × 模型准备副本：小图原字节透传，超预算 PNG/JPEG/WebP 从原图等比缩小，保留 MIME 并应用 EXIF 方向，不写入 Core、不替换原图。动画图片需要缩放时明确拒绝，避免静默只取第一帧。原图下载与工作台展示继续使用原 Artifact。

Provider 和 `models[]` 均可选 `visionInput: {maxBytes, maxDimension}`；正整数分别表示编码图片字节上限和最长边像素。优先级为模型逐字段覆盖账号，再继承默认 8 MiB。`null` 恢复继承，不迁移旧配置，也不自动探测供应商上限。8 MiB 是客户端默认发送预算，不表示所有模型都接受该大小。CLI 和工作台设置见 [配置管理](CLI_MANAGEMENT.md#看图输入预算)。

DSH rc.2 会压缩宿主附件。看图、OCR 和定位允许这种宿主规范化，并检查引用哈希、实际 MIME、字节数及原始/归一化尺寸；随后仍使用同次 `saveImage()` 返回的引用。损坏或不匹配的引用会在模型调用前拒绝。OCR 在切片后应用预算，记录真正输入的尺寸；定位明确约定模型坐标域，处理缩放和 EXIF 方向后返回原图像素。详见 [OCR](OCR_MODEL.md) 和 [定位](COMPOSITE_VISION.md)。默认宿主候选应用客户端 8 MiB 预算，宿主自身仍可能进一步缩小图片。

大小拒绝使用 `IRIS_MODEL_IMAGE_TOO_LARGE`；已知上限时显示实际字节数及上限。上游明确的 400 图片大小消息仅提取数值，不展示原始供应商正文；其他 400 是输入拒绝，429 仍按限流/额度分类。一次调用不会因大小拒绝自动压缩重发或切换模型。

预先取消时不读取图片、不做桥接、不调用模型。在途取消/超时会向模型、读取及元数据传递 abort，并结束底层迭代。DSH rc.2 的 `saveImage()` 没有取消参数：本地等待仍有界，迟到保存可能留下宿主附件，之后不会启动生成。Host 附件属于宿主数据，不是 Core Artifact；不自动删除它们。取消也不证明远端执行或计费已停止。

## 开发与验证边界

`vision-core.js` 只消费显式请求与 Model Ports；`vision-model-routing.js` 拥有配置选型、文件解析和结果/健康投影；HTTP 与 DSH 适配器拥有协议和图片桥接。安全错误只包含稳定代码、调用事实和受控状态，不能包含 Prompt、图片、Key、端点或原始异常。

两类视觉协议复用 Model Port conformance；HTTP 额外检查 SSE 分帧、UTF-8、终态及正文上限，DSH 额外检查附件字节、元数据与迟到桥接。实际安装的 rc.2 Runtime/Attachments 另用离线模型源验收；包外验收使用无 DSH/Cordis 的安装副本。

2026-10-02 使用现有 DashScope `qwen3-vl-flash` 做了隔离实测：HTTP Port、DSH 原生 PiAiAdapter 与实际 Runtime、Agent 看图/重看、工作台看图/重看、截断拒绝和收到正文后的取消均通过。DSH 的通用 OpenAI 兼容路由在本次测试中需显式设置 `compat.maxTokensField: max_tokens`，才能让 DashScope 执行输出 token 上限；这是测试路由的宿主配置，没有修改个人 profile。

[长图 OCR](OCR_MODEL.md)、[定位、拼图摘要与自述](COMPOSITE_VISION.md) 均已消费共享端口与整次预算；各自另验分块、bbox 解析、一张拼图一次生成及可选 Core 转写。legacy `vision.js` / Host `visionModel.analyze()` 兼容实现仍保留，现有业务入口不再调用。Model Port 的迁移切片本身不新增公开 SDK export 或生产依赖；0.2.1 提供 [视觉 CLI](VISION_CLI.md) 和可选 `visionInput`。复杂图像质量与 Android 浏览器仍需独立验证。

契约与迁移说明见 [Model Port](MODEL_PORT_CONTRACT.md) 和 [DSH → Core](DSH_CORE_MIGRATION.md)。
