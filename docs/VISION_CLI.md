# 独立视觉 CLI

状态：当前开发工作树已实现，**尚未发布**；已发布 npm 0.2.0 尚不包含以下命令。从当前源码运行 `node bin/dsh-iris.js ...`，或安装该工作树打包的 tarball 后运行 `dsh-iris ...`。需要 Node.js ≥ 22、已有依赖 Sharp；视频摘要还需要 PATH 中的 ffmpeg、ffprobe。

## 四个命令

所有命令必须显式提供私有配置文件和输入媒体的绝对路径。下面假设配置位于 `/absolute/path/providers.json`，图片和视频路径也需替换：

```bash
dsh-iris vision look \
  --provider-config /absolute/path/providers.json \
  --input '{"image_path":"/absolute/path/image.png","question":"画面中有什么？"}'

dsh-iris vision locate \
  --provider-config /absolute/path/providers.json \
  --model-ref 'aliyun::qwen3-vl-flash' \
  --input '{"image_path":"/absolute/path/image.png","target":"红色方块"}'

dsh-iris vision ocr \
  --provider-config /absolute/path/providers.json \
  --input '{"image_path":"/absolute/path/screenshot.png","chunk_height":1200,"overlap":120}' \
  --format text --output ./recognized.txt

dsh-iris vision summarize \
  --provider-config /absolute/path/providers.json \
  --input '{"video_path":"/absolute/path/clip.mp4","max_frames":8,"question":"总结视频内容"}' \
  --output ./summary.json --sheet-output ./contact-sheet.png
```

`look` 的 `question` 可省略，默认用中文描述画面。`locate` 要求非空 `target`，返回原图像素 `bbox` 或 `{found:false}`，同时提供原图尺寸。定位结果取决于模型判断。

`ocr` 默认块高 1200、重叠 120、最大图片维度 2048，可用 `chunk_height`、`overlap`、`max_dimension`、`max_invocations` 调整；沿用 [OCR](OCR_MODEL.md) 的限制，最多 32 块和 64 次生成。返回 `complete` / `partial` / `failed`、成功/失败/未处理块数、每块状态与 `fullText`，保留原段号；失败块正文不会混入识别全文。

`summarize` 默认均匀取 8 帧，`max_frames` 最多 20；`target_width` 默认 640，按源图比例缩放。每次视觉候选调用只发送一张带时间戳的 PNG 拼图，`--sheet-output` 保存的就是该图片。JSON 仅包含拼图尺寸、MIME 和 SHA-256，不包含图片 base64 或本机路径。

## 配置和模型选择

配置沿用 Iris Provider 文件，不执行配置迁移或模型发现。文件必须为普通文件，POSIX 权限限制为当前用户可读写（例如 `chmod 600 providers.json`）。可以直接只读使用已有 Iris 配置；不会推断 DSH_HOME、HOME 或当前目录。

最小结构如下，`apiKey` 由你在私有文件中设置，不放在命令参数中：

```json
{
  "providers": [{
    "id": "aliyun",
    "type": "openai",
    "enabled": true,
    "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "apiKey": "你的密钥",
    "models": [{"id": "qwen3-vl-flash", "capabilities": ["vision"]}]
  }],
  "assignments": {"vision": ["aliyun::qwen3-vl-flash"]}
}
```

省略 `--model-ref` 时按 `assignments.vision` 排序，再以配置模型池补齐。只有本地不可用、明确拒绝或正常空正文才允许下一候选；截断、未知终态、收到正文后的失败、取消和超时停止调用。显式 `--model-ref providerId::modelId` 严格只绑定该账号与模型，失败不会替换；新视觉命令不接受裸模型名。模型需启用并声明 `vision` 能力，未配置时直接失败。当前自持视觉端口支持 OpenAI-compatible Chat Completions SSE，不追加 DSH 宿主候选。

成功 JSON 携带实际 `modelRef`、`selectionReason`（`explicit` / `assignment` / `pool`）、模型身份、正常终态及可用的 usage。OCR 的实际选择保留在每个成功块上。配置凭据、端点和原始错误响应不会出现在诊断中；模型回答和 OCR 正文是用户内容。

## 输出、预算与退出码

默认 `--format json`，`--format text` 输出看图/摘要正文、定位 bbox JSON 或带完成状态的 OCR 文本。stdout 始终返回相同格式，`--output` 同时保存该结果。输出文件允许相对路径，父目录必须存在；已有文件不会覆盖。仅摘要支持 `--sheet-output`。两份文件逐个排他写入，不提供多文件事务；若第二份保存失败，第一份可能已经保存。

默认一次操作共用 120 秒，`--timeout-ms 1..120000` 可缩短。预算覆盖文件读取、图像准备、抽帧、可选转写等待与全部视觉候选。Sharp 原生操作和同步 ffprobe 无法强制中断，取消后不会继续消费结果生成；可取消的网络请求与 ffmpeg 会收到信号。每次视觉正文上限 6000 字、输入图片最多 20 MiB，沿用共享端口的正常终态检查。

退出码：成功为 `0`；模型、配置、输入错误或 OCR 部分完成/失败为 `1`；命令参数/输出路径错误为 `2`；SIGINT / SIGTERM 为 `130` / `143`。OCR 部分完成仍输出结构化结果，脚本应同时检查退出码与 `status`。

## 摘要中的音轨

默认只分析画面，不自动转写。已有转写可用 `transcribe_text` 显式提供，不产生任务：

```bash
dsh-iris vision summarize \
  --provider-config /absolute/path/providers.json \
  --input '{"video_path":"/absolute/path/clip.mp4","transcribe_text":"这里是已获得的转写文字"}'
```

主动上传并转写音轨需设置 `transcribe:true` 和显式数据根；视觉与转写模型分别选择：

```bash
dsh-iris vision summarize \
  --provider-config /absolute/path/providers.json \
  --data-root /absolute/path/iris-core \
  --model-ref 'aliyun::qwen3-vl-flash' \
  --input '{"video_path":"/absolute/path/clip.mp4","transcribe":true,"transcribe_model_ref":"aliyun::qwen-audio-3.0-asr-flash-filetrans"}'
```

配置需声明 `transcribe` 模型，并使用既有上传型转写协议（当前 DashScope）。省略 `transcribe_model_ref` 时沿用转写 assignment/模型池，显式指定时只使用该项；不能同时提供 `transcribe_text`。本次命令观察已受理的同一 Core Task，读取成功的文本 Artifact 后摘要；普通转写失败则返回画面摘要并将 `transcription.status` 标为 `failed`。无音轨标为 `no_audio`；取消/超时直接终止摘要，已经提交的转写任务保留事实，可按 [Headless CLI](HEADLESS_CLI.md) 的任务命令继续检查、观察或重新取回，不会自动重提。

纯视觉命令不要求数据根，不创建 Core Runtime、Task 或 Artifact；只在主动转写时持有数据根写者租约。独立提示词优化入口不属于本次交付。
