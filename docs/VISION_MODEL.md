# 单图视觉调用

状态：开发工作树完成视觉 M3，**尚未发布**。npm 0.2.0 的视觉链路保留原行为；本文只说明新实现。

## 使用与变化

Agent 的 `iris_look_at_image` / `iris_relook_attachment`、工作台的看图/重看，以及用户显式确认的视觉实测，改为消费共享 VisionModel Port。入口和参数保持原样，不自动生成媒体任务或保存 Core 产物。

Iris 按已配置的视觉模型顺序选择自持后端，最后考虑 DSH 默认视觉模型。DSH 必须明确提供 Provider、模型及图片输入能力；默认文本模型、未知元数据和身份漂移在生成前拒绝。自持成功时不查询 DSH 元数据或为回退额外保存附件。

只有明确认证/权限拒绝、速率/额度拒绝、正常完成但正文为空，以及本地能力不可用，才允许进入下一个候选。已收到部分正文、截断、工具调用、内容阻断、网络/协议错误、取消或超时都会停止操作。正常空结果后的切换可能已经产生上一模型的费用。

SSE `[DONE]`、EOF 或已经出现文字不代表完成。自持 Chat Completions 必须提供正常的 `finish_reason: stop`；DSH 必须提供可验证的正常 `finish`。正文超限和 token 截断明确失败，不再截取前若干字返回成功。DSH 的 `block-end` 替换同一块的 delta，思考正文不进入回答。

## 预算与图片

| 限制 | 默认值 |
|---|---|
| 整体时间 | 120 秒，覆盖文件/附件读取、元数据、桥接及所有候选 |
| 输入文字 | 32 KiB UTF-8 |
| 图片 | 20 MiB，PNG/JPEG/WebP/GIF 字节；本地看图工具沿用 PNG/JPEG/WebP 格式限制 |
| 输出正文 | 6,000 个 UTF-16 code units，超限失败 |
| 生成次数 | 最多为本次有限候选表的长度，每个候选只调用一次；不可用候选不计生成次数 |
| 显式视觉实测 | 默认 15 秒，只调用指定的一个自持模型，不使用 DSH 回退 |

视觉能力探针使用 128×128 纯红 PNG。旧的 1×1 图片会被部分模型的最小尺寸检查拒绝，不能据此判断模型不支持视觉。

图片以字节与 MIME 进入共享层。自持后端将这些字节编码为 data URL；DSH rc.2 只接受附件引用，因此适配器保存相同字节、读回核对内容后再调用模型。原会话引用不会替代当前请求里的图片。

DSH 保存图片可能做归一化。如果保存后的 MIME 或字节发生变化，M3 在生成前返回 `IRIS_MODEL_INCOMPATIBLE`，不会悄悄让两个后端看不同的图片。需要这类图片时，可先通过宿主上传取得归一化附件，再执行重看；共享请求使用读回的同一份字节。

预先取消时不读取图片、不做桥接、不调用模型。在途取消/超时会向模型、读取及元数据传递 abort，并结束底层迭代。DSH rc.2 的 `saveImage()` 没有取消参数：本地等待仍有界，迟到保存可能留下宿主附件，之后不会启动生成。Host 附件属于宿主数据，不是 Core Artifact；不自动删除它们。取消也不证明远端执行或计费已停止。

## 开发与验证边界

`vision-core.js` 只消费显式请求与 Model Ports；`vision-model-routing.js` 拥有配置选型、文件解析和结果/健康投影；HTTP 与 DSH 适配器拥有协议和图片桥接。安全错误只包含稳定代码、调用事实和受控状态，不能包含 Prompt、图片、Key、端点或原始异常。

两类视觉协议复用 Model Port conformance；HTTP 额外检查 SSE 分帧、UTF-8、终态及正文上限，DSH 额外检查附件字节、元数据与迟到桥接。实际安装的 rc.2 Runtime/Attachments 另用离线模型源验收；包外验收使用无 DSH/Cordis 的安装副本。

2026-10-02 使用现有 DashScope `qwen3-vl-flash` 做了隔离实测：HTTP Port、DSH 原生 PiAiAdapter 与实际 Runtime、Agent 看图/重看、工作台看图/重看、截断拒绝和收到正文后的取消均通过。DSH 的通用 OpenAI 兼容路由在本次测试中需显式设置 `compat.maxTokensField: max_tokens`，才能让 DashScope 执行输出 token 上限；这是测试路由的宿主配置，没有修改个人 profile。

开发版 M4 的 [长图 OCR](OCR_MODEL.md)、[定位、拼图摘要与自述](COMPOSITE_VISION.md) 均已消费共享端口与整次预算；各自另验分块、bbox 解析、一张拼图一次生成及可选 Core 转写。legacy `vision.js` / Host `visionModel.analyze()` 兼容实现仍保留，现有业务入口不再调用。M3/M4 未增加 CLI 视觉命令、公开 SDK export、持久配置字段或生产依赖；复杂图像质量、Android 浏览器与远端平台 CI 仍需独立验证。

契约与迁移说明见 [Model Port](MODEL_PORT_CONTRACT.md) 和 [DSH → Core](DSH_CORE_MIGRATION.md)。
