# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 阶段 0 收口与可靠性（M4 之后）

#### 变更

- **泡泡工作台交互收口**（`lib/client.js`）
  - 三个座位（设置页 / 进度条 / 悬浮泡泡）共享一份状态订阅（模块级 pub/sub），
    不再各自轮询 `/iris/api/state`；最后一个座位卸载后停止轮询。
  - 面板内部交互不再触发外层拖动或开关：只有点在泡泡按钮上才起拖，
    修复了「点关闭按钮被 onPointerUp 反向翻转重新打开」的 bug。
  - 运行中任务区分「状态」与「数值进度」：`progress` 为数值百分比（如 `50%`）
    才渲染进度条，`RUNNING` 等状态串不再被当作 CSS 宽度。
  - 泡泡拖动坐标持久化后，窗口 resize 时重新约束回可视区并同步持久化。

- **状态 API 不再泄露绝对路径**（`lib/api.js`）
  - `/iris/api/state` 移除 `iris.home` 字段；输出保持全标量、最小化字段。

- **媒体通道流式 + HTTP Range**（`lib/media.js`，`lib/index.js`）
  - `/iris/media/:taskId/:token/:name` 支持 `GET` / `HEAD` 与单段 `Range`
    （`bytes=start-end` / `bytes=start-` / `bytes=-suffix`），响应 `206 Partial
    Content` / `416`，并声明 `Accept-Ranges: bytes`。
  - 全量与部分读取均改用 `fs.createReadStream` 流式，避免大视频整体进入内存。
  - `serveMedia` 与 `parseRange` 迁入 `lib/media.js`（可离线测试）。

- **持久化损坏隔离 + 创建时 0600**（`lib/tasks.js`，`lib/config.js`）
  - `tasks.json` / `providers.json` 区分「文件不存在」（首次运行）与「存在但
    损坏」：损坏文件被重命名为 `*.corrupted-<时间戳>` 隔离，绝不静默覆盖证据，
    并输出诊断日志。
  - 落盘（含 `.tmp` 临时文件）从创建时即用 `0o600`，不再依赖进程 umask。

- **真实 lint 与许可/变更说明**
  - `npm run lint` 从占位脚本变为真实检查（`tests/lint.mjs`）：全量语法
    `node --check` + 5 项结构契约防回归（绝对路径 / Range / 损坏隔离 / 共享
    轮询 / 面板守卫 / resize）。
  - 新增 `LICENSE`（MIT）与 `CHANGELOG.md`。

#### 测试

- 新增 `tests/media.mjs`：Range 解析与流式服务（单段 / 后缀 / 越界 416 /
  HEAD / 无效 token 404 / 路径穿越拒绝）。
- 新增 `tests/damage.mjs`：tasks/config 损坏文件隔离、不静默覆盖、隔离文件保留。
- 新增 `tests/lint.mjs`：语法 + 结构防回归。
- 扩展 `tests/client.mjs`：共享轮询 / 面板守卫 / resize 重约束痕迹。

#### 修复

- **`iris_relook_attachment` 参数 schema 修复**（`lib/index.js`）：`question` 参数属性内写了 `required: true`（布尔值），违反 JSON Schema 规范——`required` 在属性层级必须是字符串数组（`["question"]`），不是布尔值。DSH 的 schema 校验器 `assertSupportedJsonSchema` 因此拒绝该 schema，报 `"parameters.properties.question.required is not supported"`。移除属性内的 `required: true`，顶层 `required: ['attachment_id', 'question']` 已正确覆盖必填约束。lint 新增对应守卫防回归。

### 阶段 1：Provider / Capability 基座

#### 新增

- **`lib/capability.js`**：Provider 能力系统
  - 能力常量：`image-gen` / `video-gen` / `tts` / `vision`
  - 严格选择：不具备某能力的 Provider 不再被兜底选中（`pickFor` 无匹配返回 null）
  - 有序 failover：`providersWith` 按声明顺序返回、`tryOrdered` 依次尝试并累计失败现场
  - 旧配置迁移 `capabilitiesOf`：显式声明权威 → 按模型字段推断 → DashScope 裸账号兜底全能力
- **`lib/vision.js`**：VisionBackend 抽象（对齐 RESEARCH 4.1b）
  - `SelfStackVisionBackend`：自持栈（OpenAI 兼容 /chat/completions，qwen-vl）
  - `GlobalLlmVisionBackend`：DSH 全局视觉模型（ctx.llm.stream()）
  - `buildVisionBackends` 按序组装、`askWithBackends` 依次降级并保留每个后端失败现场

#### 变更

- **`lib/adapters.js`**：`ProviderError` 结构化错误（category: auth / rate_limit / quota /
  invalid_parameter / server / network / unknown，保留 status + rootCause）；`visionStream`
  fetch 网络失败归类 network
- **`lib/config.js`**：`pickFor` 改为严格能力选择；新增 `pickAllFor` / `capabilitiesOf`
- **`lib/index.js`**：工具按能力常量选择 Provider；`askVision` 改走 `lib/vision.js` 后端链
  （返回结构兼容，`via`/`model` 不变）
- **`lib/api.js`**：`providerPublic` 暴露迁移后的能力列表 + `capabilityInferred` 标记

#### 测试

- 新增 `tests/capability.mjs`：常量/迁移/严格选择/有序 failover
- 新增 `tests/vision-backend.mjs`：后端顺序、429 降级、401 鉴权、取消、双失败、
  空串继续降级、网络错误分类
- `tests/vision.mjs` 夹具如实声明 vision 能力（对齐严格选择语义）

### 阶段 2：确定性像素工具

#### 新增

- **`lib/pixels.js`**：基于 sharp 的像素后端
  - `cropImage`：裁剪区域（left/top/width/height），区域必须为正且不越界，
    输出 PNG + 实际尺寸
  - `pixelDiff`：尺寸不一致以较小者强制归一化（fit=fill）、上限 1024 防爆内存、
    alpha 通道不参与差异计算、RGB 通道差阈值判差异，输出 diff ratio + 8×8 最差
    区域 + 灰度热力图 PNG
  - `PixelError` 结构化边界错误
- **新工具 `iris_crop` / `iris_pixel_diff`**（`lib/index.js`）
  - 输入支持本地绝对路径或本会话 attachment_id（复用 `resolveImageInput`）
  - 输出保存为 DSH 持久 attachment，返回 attachment id + 尺寸 / diff 摘要

#### 依赖

- 新增生产依赖 **sharp 0.35.4**（Apache-2.0，用户已确认）。本机 aarch64 proot
  Debian 实证可用；裸 Termux(bionic/musl) 无预编译为已知局限（lovell/sharp#4324）。

#### 测试

- 新增 `tests/pixels.mjs`：crop 越界/尺寸/diff ratio/局部差异/尺寸归一化/alpha
  忽略/大图缩放/热力图
- `tests/mount.mjs` 扩展为 8 工具注册断言；lint 新增阶段 2 结构守卫

### 阶段 3A：模型驱动定位

#### 新增

- **`lib/locate.js`**：`locateObject` 定位后端
  - 复用阶段 1 VisionBackend 链（`askWithBackends`）识图
  - 提示词强制模型只回严格 JSON bbox；`extractBboxJson` 提取第一个平衡 JSON
  - 契约校验：字段必须是数字、x1<x2 且 y1<y2、轻微越界 clamp 到图片边界、
    完全越界报错、`found:false` 明确返回
  - 返回**原像素 bbox**（对齐 RESEARCH 4.2a，与 `iris_crop` 无缝接力）
- **新工具 `iris_locate`**（`lib/index.js`）：输入支持本地路径或 attachment_id，
  返回 bbox + 可直接执行的 iris_crop 指令
- `lib/pixels.js` 新增 `imageDimensions` helper

#### 测试

- 新增 `tests/locate.mjs`：JSON 提取/有效 bbox/found=false/越界钳制/完全越界/
  字段非法/非数字/SSE 后端集成
- `tests/mount.mjs` 扩展为 9 工具断言；lint 新增阶段 3A 守卫

> 注：iris_locate 需重新加载插件（toggle iris 或重启）后才会注册进宿主。

### 阶段 3C：HTML 截图

#### 新增

- **`lib/render.js`**：HTML 渲染抽象 + BrowserHtmlRenderer 实现
  - `HtmlRenderer` 抽象接口：`render({ html, width?, height?, fullPage? }) → { png }`
  - `BrowserHtmlRenderer`：基于 `ctx.get('browser')` 运行时软耦合（不 import dsh-builtin-browser 包；
    不存在时工具报人话错误，其余工具不受影响）+ 宿主 `/iris/render/` 静态路由（同源 HTTP 服务渲染
    目录，避免 file:// CORS 限制，复用宿主 webServer 无独立端口）
  - 每次调用独立随机子目录，HTML 写入 → 浏览器打开 URL → 截图 → 关闭标签 → 清理目录
  - `width`/`height` 为 advisory 容器 min 尺寸折中（`ctx.browser.screenshot` 无视口控制 API）
  - `serveRender` 静态文件 handler（路径穿越防御，仅 GET/HEAD）
- **新工具 `iris_html_screenshot`**（`lib/index.js`）：输入 HTML 字符串→输出 PNG 附件
  - 已知缺点（用户要求标注）：可见窗口闪烁/waitMs 折中/无 viewport 控制/依赖 dsh-builtin-browser
  - 详见 `PLAN.md` 3C 条目的 5 条缺点标注

#### 测试

- 新增 `tests/render.mjs`：`/iris/render` 静态路由（200/穿越/404/405）+ 渲染器（调用序列/目录清理/
  错误处理）共 6 组
- `tests/mount.mjs` 扩展为 10 工具断言；lint 新增阶段 3C 守卫

#### 注意

> 所有新工具（iris_crop, iris_pixel_diff, iris_locate, iris_html_screenshot, iris_long_ocr）需重新加载插件
> 后才会注册进宿主。已知缺点见 PLAN.md 3C 条目。

### 阶段 3B：长截图 OCR

#### 新增

- **`lib/ocr.js`**：`longOcr` 分块 OCR 后端
  - sharp 分块：默认 1200px 高 + 120px 重叠（避免切断文本行），宽度超 2048 等比缩放
  - 逐块复用阶段 1 VisionBackend 链（`askWithBackends`）识图，按 y 序拼接全文
  - 单块失败只标记 `error`，不影响其他块
  - 调研结论（RESEARCH.md §7）：tesseract.js 中文准确率不达标，未引入
- **新工具 `iris_long_ocr`**（`lib/index.js`）：输入路径或 attachment_id，返回全文 + 块数

#### 测试

- 新增 `tests/ocr.mjs`：单块/多块重叠/y 步进/失败隔离/无后端报错/宽图缩放 6 组
- `tests/mount.mjs` 扩展为 11 工具断言；lint 新增阶段 3B 守卫

### 阶段 4：任务详情抽屉

#### 新增

- **`/iris/api/task/:id` 详情端点**（`lib/api.js`）：返回完整任务详情（含完整
  prompt/error/remoteTaskId/attachments），按需拉取
- **`TaskDetailDrawer` 组件**（`lib/client.js`）：点击工作台任务卡片行展开详情
  - 展示：完整提示词、错误信息、元数据（ID/能力/状态/模型/供应商/模式/远端任务/
    发起时间/完成时间/耗时）、产物文件、媒体播放链接、附件列表
  - 点击已选中的任务收起；媒体链接点击不触发展开/收起（stopPropagation）
  - 选中状态高亮（`selected` CSS 类 + brand 色边框）

#### 测试

- `tests/api.mjs` 新增 `/iris/api/task/:id` 端点 6 项断言（404/405/基础字段/
  完整字段/媒体链接/无明文 key）
- `tests/client.mjs` 通过（形态不变）；lint 新增阶段 4 守卫

### 阶段 6（前两步）：模型发现规则 + 能力调度改从全局模型池选

#### 新增

- **`lib/models.js`**：模型发现规则
  - `capabilitiesOfModel`：模型名→能力标签静态映射（wan→image-gen/video-gen、qwen-vl→vision、
    qwen-tts→tts、gpt-image/dall-e→image-gen、gemini→vision），零 API 调用
  - `providerModels`：一个 provider 的模型池——显式 `models` 数组 / 旧四字段（imageModel 等）
    迁移 / 裸 DashScope 已知模型兜底（wan2.2-t2i-flash/wan2.2-t2v-flash/wan2.2-s2v-flash/
    qwen-vl-plus/qwen-tts-latest）
  - `modelPool`：全局池合并所有 provider 的模型
  - `pickModel`：从池按能力挑选

#### 变更

- **`lib/config.js`**：`pickFor`/`pickAllFor` 改从全局模型池选模型（`models.modelPool`），
  返回 provider 副本并把对应模型字段设为选中模型——**向后兼容**（调用方读 `provider.imageModel`
  等不变）；`capabilitiesOf` 改为该 provider 模型池覆盖的能力集合（合并各模型标签）

#### 测试

- 新增 `tests/models.mjs`（5 组：能力推断/显式 models/旧字段迁移/裸 DashScope/全局池挑选）
- `tests/vision.mjs` 夹具补 `visionModel`（模型池需要模型名，仅声明能力不够）
- lint 新增阶段 6 守卫；全量 16 组测试通过

### 阶段 6（条目 3-5）：供应商管理 GUI + 模型池 + 能力测试

#### 新增（host）

- `config.js`：`allProviders` / `removeProvider` / `setProviderModels`；**修复 upsert bug**——
  `provider.id` 显式 `undefined` 会覆盖生成 id（拆解 id 再合并）
- `actions.js`：`providers_list`（含模型池 + apiKey hint）/ `providers_upsert`（转发
  imageModel 等四字段 + models）/ `providers_remove` / `providers_set_models` /
  `providers_test_vision`（红色测试图实测，复用 `testVisionCapability`）

#### 新增（client）

- **`ProviderManager` 组件**（`lib/client.js`）：供应商列表（名称/启用态/能力/模型池 chips/
  管理按钮）替换 WorkbenchPanel 只读列表
  - 「+ 添加供应商」表单（名称/baseUrl/apiKey）
  - 展开卡片：启停 / 测试视觉 / 删除 / 模型池展示（带能力标签）
  - `providers_test_vision` 调用后显示实测结果

#### 测试

- `tests/actions.mjs` 增 providers 6 项断言（列出/upsert/模型池覆盖/test_vision 跳过/删除/动作清单）
- 全量 16 组测试通过

> 注：阶段 6 条目 4（per-capability 分配 UI）未做（◐）；当前多模型通过 `pickAllFor` failover 顺序支持。

### 阶段 7.2：音频转写（qwen-audio-turbo）

#### 新增

- **`lib/adapters.js`**：`submitTranscription`（异步任务提交，复用 `uploadTempFile` 上传到
  oss:// 临时存储）+ `pollTranscriptionTask`（从 results 提取 `transcription_text`/`text`）
- **动作 `transcribe`**（`lib/actions.js`）：audio_path 校验 → 上传 → 提交 → 复用盯守框架
- **工具 `iris_transcribe_audio`**（`lib/index.js`）：转写音频 → 返回全文
- **GUI 卡片「🎙️ 音频转写」**（`lib/client.js`）

#### 要点

- **零新依赖**：复用 TTS 供应商栈（百炼 key）
- 复用现有任务盯守框架（异步提交 → 轮询 → 落 text 字段）

#### 测试

- `tests/actions.mjs` 增 transcribe 3 项入参校验（缺路径/相对路径/文件不存在）
- `tests/mount.mjs` 增工具断言；lint 增阶段 7.2 守卫
- 全量 16 组测试通过

### 阶段 7.1：视频抽帧（ffmpeg 可选系统条件）

> 环境更新：本机已装静态 ffmpeg 7.0.2（johnvansickle），RESEARCH §9.1「ffmpeg 未安装」
> 结论过期；抽帧路径可实机验证。

#### 新增

- **`lib/media-probe.js`**：视频分析后端（零 npm 依赖，纯系统 ffmpeg/ffprobe）
  - `ffmpegAvailable`：`which ffmpeg/ffprobe` 启动探测（缺失时抽帧工具报人话错误，其余功能不受影响）
  - `probeVideo`：ffprobe 读时长/尺寸/编码（`-show_entries format:stream` + JSON 解析）
  - `normalizeFramesOptions`：参数校验 + clamp（maxFrames 1–20、targetWidth 16–4096、
    quality 1–100、format 仅 jpeg/png）
  - `scaledDimensions`：目标宽 = min(targetWidth, 源宽)，高按比例取偶数（不放大）
  - `extractFrames`：fps 滤镜时间均匀采样（fps = n/duration 分数形式，短视频也能取整 N 帧）、
    异步 spawn（不阻塞宿主事件循环）+ AbortSignal 取消、JPEG -q:v 质量、PNG 无损、
    返回帧 buffer + atSec 时间戳（i*duration/n）+ 实际缩放尺寸，临时目录用完即删
- **工具 `iris_video_frames`**（`lib/index.js`）：本地视频 → N 帧 → 每帧转存 DSH image
  attachment 并返回 image blocks（对话流内直接可见，可 relook/裁剪接力）
- **动作 `video_frames`**（`lib/actions.js`）：GUI 直连抽帧，返回帧摘要 + 首帧 base64 预览
- **GUI 卡片「🎞️ 视频抽帧」**（`lib/client.js`）

#### 要点

- **零 npm 依赖**：ffmpeg/ffprobe 是可选系统可执行文件，不是 peerDependency；缺失时
  工具/动作在执行时报清晰人话错误，不影响 iris 其余工具
- 帧数/分辨率/字节数三重限制对齐 RESEARCH §9.2（20 帧上限、4096 宽上限、JPEG 质量 85
  默认 → 单帧几十 KB）

#### 测试

- 新增 `tests/media-probe.mjs`：9 组断言（参数校验/clamp、缩放偶数取整、probeVideo、
  帧数 = 请求数、JPEG/PNG 魔数、atSec 递增、短视频整帧、取消信号、文件不存在/非视频
  错误路径、临时目录清理）；无 ffmpeg 环境自动降级为错误路径断言
- `tests/mount.mjs` 增 `iris_video_frames` 工具断言（13 工具）
- `tests/client.mjs` 增 `video_frames` 卡片断言（13 卡片）
- `tests/actions.mjs` 增 video_frames 3 项入参校验 + 动作清单断言
- lint 增阶段 7.1 守卫（media-probe 导出契约 + MAX_FRAMES=20 + 工具/动作注册）

### 阶段 7.3：多模态上下文摘要（视频 → 联系表 + 转写 → 视觉摘要）

> 阶段 7 收尾：7.1 视频抽帧 + 7.2 音频转写 → 组合成「一张图看全片 + 一段话听全声」的压缩摘要。

#### 新增

- **`lib/media-probe.js` 扩展**：
  - `probeVideo` 增加 `hasAudio` / `audioCodec`（探测视频是否含音轨，7.3 决定是否转写）
  - `extractAudioTrack`：ffmpeg 提取音轨为 mp3（libmp3lame，静态版内置），返回临时
    文件 + 目录（调用方 finally 清理），AbortSignal 取消
- **`lib/summarize.js`**：多模态摘要后端（纯 sharp + 视觉链，可离线测试）
  - `buildContactSheet`：把 N 帧缩略图按时间序拼成网格 + 每帧盖时间戳标签的 PNG 联系表
    （一次视觉调用看全片——VisionBackend 单图契约下的上下文压缩）
  - `buildSummaryPrompt`：画面指令 + （可选）转写文本嵌入（截断 6000 字）
  - `summarizeMedia`：联系表 dataUrl + ref → `askWithBackends` 降级链 → 摘要文本
- **工具 `iris_media_summarize`**（`lib/index.js`）：
  - 视频 → 抽帧（≤12）→ 联系表 → attachment；有音轨且 `transcribe !== false` 时自动
    extractAudioTrack → 上传 → 提交转写 → 复用盯守框架等待（≤120s，超时转后台并在结果
    注明「本次摘要未含语音」）→ 视觉模型摘要
  - 返回：摘要文本 + 联系表 image attachment
- **动作 `media_summarize`**（`lib/actions.js`）：GUI 同步快速版（不自动转写，可粘贴已有
  transcribe_text），返回摘要 + 联系表预览
- **GUI 卡片「📝 视频摘要」**（`lib/client.js`）

#### 要点

- **上下文压缩语义**：不把 N 帧逐张喂模型（N 次调用/费用），而是拼成带时间戳的单张联系表
  + 转写文本一段话——把 5 分钟视频压成一次视觉调用的输入
- **降级纪律**：无音轨跳过转写；有音轨但无 TTS 供应商/转写失败/超时 → 仅画面摘要并在结果
  注明，绝不因音频环节失败而丢掉画面摘要

#### 测试

- 新增 `tests/summarize.mjs`：6 组断言（contact sheet 网格尺寸/行数列数/空帧报错、
  提示词组装含转写、stub 后端返回、双后端 failover、无后端报错）
- `tests/mount.mjs` 增 `iris_media_summarize` 工具断言（14 工具）
- `tests/client.mjs` 增 `media_summarize` 卡片断言（14 卡片）
- `tests/actions.mjs` 增 media_summarize 3 项入参校验 + 动作清单断言
- lint 增阶段 7.3 守卫（summarize 导出契约 + 工具/动作注册）
- 全量 18 组测试通过
