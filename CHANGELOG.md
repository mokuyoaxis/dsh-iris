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

### 阶段 4（SSE 共享轮询测量）—— 状态变化即推，替代 5s 轮询

> 原计划「先测量共享状态源成本，再决定 SSE」——共享状态源（一个 pub/sub 供三个座位）已
> 在阶段 0 落地；测量结论：SSE 可行，延迟 ≤400ms（vs 原 5s）、空闲时零网络流量、生命周期
> 成本可控。本阶段实现 SSE 推送并保留 30s 兜底轮询。

#### 新增

- **`lib/tasks.js`** + **`lib/config.js`**：`onChange` / `emitChange` 状态变化总线
  - `persist()` 落盘即触发 `emitChange()`（任何任务 create/update/成功/失败 或供应商
    upsert/remove/assignment 均自动通知），无监听者时零开销
- **`lib/api.js`** SSE 推送枢纽：
  - `GET /iris/api/state/events` SSE 端点：连接即推当前状态，tick → 400ms 节流广播。心跳
    `: ping` 每 15s（unref，无连接时自动停止）。`closeAllSse()` 插件停用/路由卸载时全关
  - `sseClientCount()` 暴露活跃连接数（测试用）
  - 生命周期纪律：`res.on('close')` 移除连接；0 连接 → 停心跳；`closeAllSse()` 清理所有定时器与连接
- **`lib/index.js`**：`mountIrisRoutes` 的 effect 清理中调用 `closeAllSse()`
- **`lib/client.js`**：5s 轮询 → **EventSource + 30s 兜底轮询**
  - 三个座位的 `useIrisState` 改为：首次挂载时建立 `EventSource('/iris/api/state/events')`，
    `onmessage` 直接 `apply(data)` 广播给所有 listeners；保留 `setInterval(load, 30000)` 作为
    SSE 断线/漏推时的兜底最终一致。最后座位卸载时 `close()` EventSource 并清除定时器

#### 生命周期成本评估

| 维度 | 成本 | 控制措施 |
|---|---|---|
| 连接数 | 每标签页 = 浏览器共享 1 个 SSE 连接；多标签页每标签 +1 | `closeAllSse()` 在插件停用全关 |
| 心跳 | 15s 一次 `: ping` 注释行（无连接时自动停止，不拖住进程） | unref 定时器，不阻止退出 |
| 推送节流 | 400ms 窗口合并，盯守高频 update（2.5–6s） → 最多 ~2.5 次/秒 | 单次推送 = 1 次 `buildState()` 读盘 |
| 内存 | 每连接一个未完成 HTTP 响应对象（~KB 级） | 连接数上限 = 浏览器标签数，可控 |
| 网络 | 空闲时零流量；状态变化时单次推送，比 5s 轮询减少 ~85% 请求 | — |

#### 测试

- `tests/api.mjs` 增 SSE 7 项断言（初始推送、任务变更推送、连接计数、closeAll 清理、
  重连、供应商变更推送）—— 真实 HTTP 服务器 + 事件流验证
- lint 增 SSE 守卫（`serveSse`/`closeAllSse`/EventSource/`onmessage`/`close()`/30s 兜底）
- 全量 18 组测试通过

### 可靠性修复：孤儿任务防线（提交段守卫 + 启动兜底 + progress 收尾）

> 实况检验（2026-09-03）发现：`t_mtl94bqgiyc4`（transcribe）卡 running 1 小时+，
> 无 remoteTaskId、无 updatedAt。根因：`tasks.create()` 落盘后、`watch()` 启动前的
> 上传/提交调用抛错时没有标 failed——记录成为孤儿（无盯守者，`resumePending` 又因
> 缺 remoteTaskId 跳过，永远占着「运行中」角标）。工具侧 image/video/tts 早有
> try/catch 纪律，但转写两处与 GUI 动作侧四个动作全部裸奔。

#### 变更

- **`lib/tasks.js`** 框架层三件套：
  - 新增 `submitGuard(task, fn)`：提交段抛错 → 任务标 `failed`（带「提交失败：原因」）
    并原样重抛；成功则透传返回值、不误伤 running 状态。
  - `resumePending()` 孤儿兜底：`running` 且无 `remoteTaskId` 的残留记录启动时直接标
    failed（「提交未完成」）——覆盖「进程死在 create 与提交完成之间」这种守卫也救不了的
    场景，保证最终一致。
  - 盯守成功收尾时 `progress: '100%'`：轮询期写入的 `RUNNING` 等文本不再残留到
    succeeded 记录上（实况：`t_mtkuyu57von4` succeeded 却 progress=running）。
- **`lib/index.js`**：`iris_transcribe_audio` 与 `iris_media_summarize` 转写子步骤的
  upload+submit 段套 `submitGuard`。
- **`lib/actions.js`**：GUI 动作侧 image（dashscope 与 openai-images 两分支）/ video /
  tts / transcribe 四个 create 站点全部套 `submitGuard`（动作侧比工具侧更裸——四个动作
  全有泄漏路径）。

#### 测试

- `tests/smoke.mjs` 新增场景 10–12：submitGuard 抛错标 failed+原样重抛+成功透传、
  resumePending 孤儿清理、成功任务 progress 收尾 100%（复用场景 1 记录断言）
- `tests/lint.mjs` 新增结构守卫：`submitGuard` 导出、孤儿清理分支、progress 收尾、
  actions.js 每个 create 站点必须有守卫、index.js 守卫数量下限
- 全量 18 组测试通过

#### 线上数据清理

- `t_mtl94bqgiyc4` 手工标 failed（修复时清理）；`t_mtkuyu57von4` progress 修为 100%。
  注意：运行中的旧代码进程内存缓存仍持有孤儿记录，若下次重启前发生落盘会短暂回退，
  新代码的 `resumePending` 兜底会在下次装载时再次清理——最终一致。

### 健康检查第二轮：网络超时、恢复接管、限长与流生命周期

> 承接孤儿任务修复的同类排查（「错误路径状态泄漏 / 副作用不可逆」模式），
> 全库扫出四个同类隐患，一并修复。

#### 修复

- **转写任务重启接管丢文本**（`lib/index.js` `pollDeps`）：恢复接管的轮询器此前对
  所有能力统一用 `pollTask`（找 urls）——转写任务结果在 `transcription_text` 而非
  urls，重启接管的转写任务会「成功」但文本静默丢失。`pollDeps` 新增 transcribe 分支
  （`pollTranscriptionTask` + onSuccess 存 `transcribeText`），并导出供测试。
- **网络调用全量加超时**（`lib/adapters.js`）：11 处 fetch 此前无一带超时——挂死的
  TCP 连接会永久冻住盯守 tick（`MAX_WATCH_MS` 只在 tick 顶部检查，await 挂起走不到），
  提交类调用则吊死工具。新增分层档位常量（提交 30s / 轮询 15s / 上传 60s / 下载 120s /
  同步生成 180s / 视觉流 120s），各函数带 `timeoutMs` 参数便于测试注入；
  `visionStream` 用 `AbortSignal.any` 组合外部取消信号与超时（不吞取消）。
  超时抛 TimeoutError 汇入既有错误路径（轮询进 errStreak 容忍、提交进 submitGuard 标 failed）。
- **downloadTo 原子落盘**（`lib/adapters.js`）：先写 `.tmp` 再 rename——下载失败/超时
  不再在 outputs/ 留半截产物。
- **POST body 限长失效**（`lib/api.js`）：旧实现 `body.length < 1e6` 数的是**块数**不是
  字节数（1MB 上限实际是 100 万块 ≈ 数十 GB）。改为按字节累计，超限回 413 并丢弃已收块。
- **sendJson/sendText 双保险**（`lib/api.js`/`lib/media.js`）：`writableEnded || destroyed`
  守卫，防 end 后二次写抛错。
- **SSE 总线订阅可逆**（`lib/api.js`）：`closeAllSse()` 现在退订 tasks/config 变化总线
  （旧代码只关连接不退订，插件停用后每次落盘仍空转一个 400ms 节流定时器）；重连时
  `bindChangeBus` 重新订阅——现有 SSE 重连+推送测试实证生命周期正确。
- **媒体流断开即释放**（`lib/media.js`）：两个流式分支（206/200）加
  `res.on('close') → stream.destroy()`——客户端中途断开不再让读流空转到 EOF 占 fd。

#### 测试

- 新增 `tests/adapters-timeout.mjs` 6 组：挂起服务器实证生成/视觉流超时生效、
  外部取消即时传播、半截下载不留文件（原子性）、成功路径无 .tmp 残留、档位常量导出
- `tests/mount.mjs` 增场景 ⑤：pollDeps transcribe 分支形状 + onSuccess 存转写文本 +
  image/video 间隔不回归
- `tests/actions.mjs` 增 ④b/④c：多块 1.5MB body → 413（旧实现会放行）、限内多块正常放行
- `tests/lint.mjs` 增守卫：fetch/signal 数量比对、pollDeps transcribe 分支、
  MAX_BODY_BYTES 按字节限长、sendJson/sendText 守卫、closeAllSse 退订总线、
  媒体流双分支断开毁流
- 全量 19 组测试通过

#### 排查过、确认无需改

- `awaitTerminal` 取消竞态：abort 后 watch 已启动也能被首轮循环捕获并 cancel ✅
- 路由重复挂载：`mediaRouteMounted` 幂等 + dispose 复位 ✅
- 媒体链接随任务裁剪失效：token 存任务记录内（非独立内存表），无泄漏 ✅
- client.js EventSource/兜底轮询：最后座位卸载时 close + clearInterval ✅
- render.js / media-probe.js 临时目录：均有 try/finally 清理 ✅

### 阶段 6 条目 4：能力有序分配 UI（failover 列表）

> 主线最后一个 ◐。原状：`assignments[cap]` 只认单模型、`pickAllFor` 完全无视分配按池序——
> 多 key 场景无法表达「这个能力先试 A 再试 B」。GUI 也只有 ActionCard 里的单值下拉。

#### 变更

- **`lib/config.js`**：`assignments[cap]` 升级为有序数组（向后兼容旧单字符串）；
  新增 `assignmentOrder(cap)`（归一化）与 `setAssignmentOrder(cap, ids)`（校验每个
  模型在池且具备该能力、去重、空数组=清除）；`pickFor` 取分配序首位可用；
  `pickAllFor` 分配序优先 + 池序补齐去重——failover 顺序真正生效。
- **`lib/actions.js`**：`assignments_get` 返回归一化 `order`；`assignments_set` 接受
  `model_ids` 数组（空数组清除），保留 `model_id` 单值兼容路径。
- **`lib/client.js`**：WorkbenchPanel 新增「能力分配（failover 顺序）」区——
  `CapabilityAssigner` 组件：四能力行（🎨🎬🔊），每行有序 chips（序号 + ↑↓ 移序 + ✕ 移出）、
  「+ 加入 failover」下拉（池内未加入者）、「恢复自动」清除；保存后一律重载（失败显示
  实际落盘序，不骗 UI）。ActionCard 单值下拉改读 `order` 首项。
- **`lib/models.js`**：VERIFY 2026-09-03 实证收编——`qwen3-vl-*` 命名规则 +
  `qwen3-vl-235b-a22b-thinking` 入裸 DashScope 已知池（locate grounding 零偏差的强模型
  现在可直接在能力分配 UI 里选给 👁）。

#### 测试

- `tests/actions.mjs` ⑩ 八项：有序设置/归一化 get/pickFor 取首位/pickAllFor 分配序/
  非法能力拒绝/空数组清除回退/单字符串兼容/重复去重
- `tests/models.mjs` qwen3-vl 规则与入池断言；`tests/client.mjs` ⑤ CapabilityAssigner 结构
- lint 守卫：assignmentOrder/setAssignmentOrder 导出、pickFor/pickAllFor 顺序逻辑、
  model_ids 数组、order 归一化、qwen3-vl 收编

### O2 授权边界：/iris/* 请求守卫（Host 白名单 + 跨站拒绝）

> 调研结论（2026-09-03，读宿主 dsh-host-webserver 源码）：宿主路由分发**无任何鉴权**，
> 安全模型 = 「绑定 127.0.0.1，loopback 即信任」。同源不等于授权——实机取证两条攻击面：
> ① 恶意 Host 头（DNS 重绑定形态）可完整读取 /iris/api/state（key hint/提示词/历史）；
> ② 跨站 Origin POST /iris/api/actions/* 被直接执行（恶意网页可驱动真实付费生成）。

#### 新增

- **`lib/guard.js`** 纯函数裁决 + `guarded()` 包装器：
  - 所有方法：Host 主机名 ∈ {127.0.0.1, localhost, ::1} ∪ `DSH_WEB_BASE` 声明主机
    ——DNS 重绑定时 Host 是攻击者域名，此关直接斩断（含 IPv6 带括号带端口解析）
  - POST：`Sec-Fetch-Site` 存在时只放行 same-origin/none（same-site 也拒——回环上
    不同端口页面的跨端口发起被覆盖）；`Origin` 存在时主机必须在白名单
  - 无 Origin 的非浏览器客户端（本机 curl/CLI）在 Host 关约束下放行——本机进程本就在
    信任域内，这是宿主 loopback 模型的既有语义
  - 未授权统一 403 人话 JSON，不进业务 handler；已死连接静默跳过
- **`lib/index.js`**：三条 /iris 前缀路由（media/api/render）注册时全部包 `guarded()`

#### 边界说明

- 本机任意进程仍可直连（宿主 loopback 信任模型未被本守卫改变，也无力改变——那需要
  宿主级会话鉴权）；本守卫消灭的是**浏览器可达性**（远程网页经 CSRF 或重绑定）。
- 反代/远程部署：`DSH_WEB_BASE` 同时是媒体链接基址与 Host 白名单来源，一处声明两用。

#### 测试

- 新增 `tests/guard.mjs` 4 组 19 断言：Host 白名单/重绑定拒绝/IPv6/CSRF 三态/
  DSH_WEB_BASE 扩白与还原/guarded 包装器（403 不进 handler、透传、死连接防御）
- lint 守卫：三条路由必须包 guarded、guard.js 关键要素存在
- 全量 20 组测试通过

### 阶段 4 续：任务压缩/清理 + 泡泡瘦身（信息架构升级）

> 用户反馈两点：① 最近任务太长、需要压缩与清理；② 泡泡浮层把整张工作台硬塞进去、内容太多。
> 二者同源——泡泡 = 完整 WorkbenchPanel。本轮把"一眼 + 顺手"还给泡泡，把"完整浏览 + 管理 + 清理"
> 归位到设置页。产物文件删除语义：删记录默认只删元数据（媒体链接随 token 消失而失效，文件留盘）。

#### 数据层（`lib/tasks.js`）

- `MAX_TASKS` 200 → **500**（后台保存更多历史供浏览）。
- 新增清理原语：`remove(id)`（仅终态，running 拒绝并提示先取消）、`prune(pred)`（批量删终态，
  **强制跳过 running**——批量清理永不误删运行中任务）、`all()`（全量不截断，供清理/孤儿扫描）。

#### 动作层（`lib/actions.js` + `lib/api.js`）

- 四个清理动作：`tasks_delete`（单条）、`tasks_clear`（scope=completed/older_than/all，
  older_than 带 days）、`tasks_orphans`（只读报告无任务引用的产物 + 占用）、
  `tasks_purge_orphans`（删孤儿文件，不可逆）。
- `buildState` 新增 `recentTotal`（终态总数，不受 recent 截断）；recent 截断 30 → 100。

#### 客户端（`lib/client.js`）

- **卡片注册表 `CARD_DEFS`**：14 张操作卡片定义收敛为单一数组，`ActionGroups`（设置全量）、
  泡泡「常用」子集、`BubbleCardPicker`（勾选器）三处共用——消灭重复。
- **泡泡瘦身**：浮层从"整张工作台"改为 `BubblePanel` 两标签——
  「📋 任务」（运行中 + 最近 6 条 `taskRowMini` 单行摘要 + "共 N 条·完整历史见设置页"提示）
  +「⚡ 常用」（仅渲染用户勾选的卡片，空则提示去设置页勾选）。角标/明暗/拖动/进度条不动。
- **常用卡片可配置**：设置页 `BubbleCardPicker` 多项勾选 → 存 localStorage `iris-bubble-cards`
  （`useBubbleCards` 跨座位响应 + `storage` 事件跨标签页同步）；勾选即出现在悬浮窗，泡泡默认干净。
- **设置页历史浏览器**：`HistoryBrowser` 按 今天/昨天/更早 分组折叠（组头计数 + ▼/▶）；
  `CleanupBar` 提供 清空已完成 / 清理 7 天前 / 扫描孤儿产物 / 删除孤儿产物，破坏性操作 `window.confirm` 二次确认。

#### 测试

- `tests/smoke.mjs` 场景 13：remove 删终态/拒 running、prune 按标记精准删且跳过 running、all 全量
- `tests/actions.mjs` ⑪ 六项：孤儿扫描只报无引用、删单条、拒删 running、清空留 running、purge 删文件、非法 scope 拒绝 + 动作清单
- `tests/api.mjs` recentTotal 计数；`tests/client.mjs` ⑥ 注册表/标签/历史分组/勾选器/localStorage key/二次确认
- lint 守卫：MAX_TASKS 500、remove/prune/all 导出、prune 跳过 running、四清理动作、recentTotal、CARD_DEFS 注册表、BubblePanel + localStorage
- 全量 20 组测试通过

### 模型池成熟化 P1+P2：分配唯一入口 + 真实模型发现

> 用户三连问：① 为什么两套配能力的 UI？② 百炼池远不止写死的 6 个？③ 用户自定义模型名 + 逐模型测试在哪？
> 调研 dsh-vision-router（见 RESEARCH §1）定调：**名字规则只初筛，实测才是权威**；探针证实 `GET /models`
> 免费可用（真实账号返回 249 模型）。据此分四期，本轮 P1+P2。

#### P1 修 ①（分配唯一入口，消除互相覆盖）

- 旧状：`CapabilityAssigner`（有序）与每张带 capability 的 ActionCard「模型分配」下拉（单值）**同时写
  `assignments[cap]`**——`vision` 被 5 张卡 + Assigner 共 6 个入口写，互相覆盖；且卡片 `loadModels`
  会把 `vals.model` 自动填成池首项，**GUI 每次运行显式传 model 绕过分配**。
- `lib/client.js`：删除 ActionCard 的模型下拉与 `assignModel`；改只读提示「模型：X · 改分配→能力分配」；
  `loadModels` 不再自动填 `vals.model`（留空=用分配解析结果）。`assignments[cap]` 唯一写入口 = CapabilityAssigner。
- `tests/client.mjs` ⑦ 锁死：不得再有 `model_id:` 单值写、不得残留 `assignModel`、只读提示存在。

#### P2 发现（替换写死池，优雅降级）

- `lib/adapters.js`：新增 `listModels({key,baseUrl,timeoutMs})` → `GET {baseUrl}/models`（OpenAI 标准，
  DashScope compatible-mode 实测支持），解析 `{data:[{id}]}` 去重；带超时档位。
- `lib/models.js`：`MODEL_CAP_RULES` 按真实命名族扩写——`wan*-t2v/s2v/i2v/video`→video、
  `wan*-t2i/wan*image/qwen-image/z-image`→image、`qwen?-vl`→vision、`qwen?-tts/cosyvoice`→tts；
  视频规则先于图像避免 `wan*video` 被图像吞。写死 `DASHSCOPE_KNOWN` 降为**未发现时的兜底**。
- `lib/actions.js`：新增 `providers_discover {id}`——拉全量→按规则过滤媒体模型→写入显式池（带能力标注）；
  拉不到则保留现有池并报人话（降级）。
- `lib/client.js`：ProviderManager 卡片加「发现模型」按钮。

#### 端到端实证（真实百炼账号）

- `GET /models` → 249 模型；`capabilitiesOfModel` 过滤 → **47 媒体模型**（image-gen 19 / tts 17 / vision 11），
  对比旧写死池 6 个。video 该账号未列（数据现实，兜底池 + 手动添加可补）。

#### 测试

- `tests/models.mjs` ①b：15 条真实命名族断言（wan2.7-image/qwen-image/qwen3-tts/cosyvoice/qwen-vl-max/paraformer…）
- `tests/adapters-timeout.mjs` ⑦：listModels 本地服务器解析+去重
- lint 守卫：listModels 存在、providers_discover 注册、扩规则覆盖真实族、发现按钮存在
- 全量 20 组测试通过

### 模型池成熟化 P3+P4：分类权威（verified + 逐模型实测 + 手动管理）

> 学 vision-router 的核心——**名字规则只初筛，实测才是权威**；同时补上用户要的
> "自定义模型名 + 测试单个模型"（此前动作层有、UI 缺，且只有 vision 能测）。

#### P3 数据 + 动作（`lib/config.js` / `lib/actions.js` / `lib/models.js`）

- config：模型条目新增 `verified`（按能力存 `{ok, at, note}`）与 `source`（manual/auto）；
  `setProviderModels` 覆盖池时**保留同名模型的 verified**（重新发现不丢实测结果）；
  新增 `addProviderModel` / `removeProviderModel` / `setModelCapabilities` / `setModelVerified`。
- models：`providerModels` 透传 verified/source 到池条目。
- actions：`providers_add_model`（能力缺省按规则推断）/ `providers_remove_model` /
  `providers_set_model_caps`（纠正误判）/ `providers_test_model`（逐能力实测存 verified）；
  `probeModel` 按能力探针——vision 红图、tts "你好"合成、image 最小生成轮询到终态、
  video 仅提交受理（渲染太慢太贵）；`providers_list` 透出 verified/source。
- **成本纪律**：探针一律用户逐模型手动触发，发现时绝不自动跑（自动跑=偷偷花钱）。

#### P4 模型池 UI（`lib/client.js`）

- `ModelPool` 组件替换旧只读 chips：每模型一行 `id · 能力verified标记(图✓/音?/…) · [测] [✕]`，
  `manual` 来源带标签；底部"手动添加模型名"输入 + `+ 添加`；卡片操作区保留"发现模型"。
- verified 徽章：`✓` 实测通过（绿）/ `✗` 未通过（红）/ `?` 未测（灰），title 显示实测详情。
- 逐模型"测"按钮串行测该模型所有已声明能力，结果落 verified 并刷新。

#### 测试

- `tests/actions.mjs` ⑫ 六项：手动添加按规则推能力+source=manual、纠正能力、verified 落池透出、
  覆盖池保留同名 verified、移除、空 model_id 拒绝 + 四动作注册
- `tests/client.mjs` ⑧：ModelPool/逐模型测试/移除/手动添加/发现/verified 标记结构断言
- lint 守卫：config 四函数、probeModel、四动作注册、ModelPool UI 要素
- 全量 20 组测试通过

### 守卫修正：发布安全优先（对齐宿主信任栅栏，去除锁死风险）

> 用户追问"守卫一开始的作用"，回头查实宿主鉴权姿态（读 `dsh-client-connection`）：
> 宿主**有一套权威信任栅栏** `isTrustedApiRequest`（Host ∈ 回环∪`trustedHosts` +
> `Sec-Fetch-Site≠cross-site` + `Origin.host===Host`），**但只挂在 `/api` 前缀**。
> iris 的 `/iris/*` 是裸 prefix 路由，在栅栏之外——所以 iris 确需自备一道。
> 但原守卫把 Host 白名单**写死成只有回环、无 trustedHosts 逃生口**，正是会锁死
> LAN/反代发布用户的劣质复刻。用户裁定：发布安全优先，反代/重绑定无所谓（iris 开源）。

#### 变更（`lib/guard.js` 重写）

- **删除 Host 白名单**（回环∪DSH_WEB_BASE 那套）——它是唯一会拦合法发布用户的东西，
  其独有收益（挡 DNS 重绑定）价值低且用户明确不追。
- **读接口（GET/HEAD/SSE）全放开**：跨源读本就受 CORS 阻挡（无 ACAO 读不到响应），
  媒体另有 token 能力凭证。
- **仅 POST 保留 CSRF 栅栏**（唯一真实高价值威胁：恶意网页驱动付费生成）：
  `Sec-Fetch-Site === cross-site` 拒；有 `Origin` 且 `Origin.host ≠ Host`（host:port 精确比对，
  与宿主同语义）拒；同源浏览器与无 Origin 的 CLI 放行。
- 净效果：**任何拓扑（回环/LAN IP/反代域名）都不误伤同源用户**，只挡跨站 POST。

#### 测试

- `tests/guard.mjs` 重写为发布安全语义 5 组：读全放开、**同源 POST 在回环/LAN/反代域名
  均放行**（旧白名单会锁死的证明）、跨站/跨源/非法 Origin/跨端口拒绝、Host 大小写归一、
  端口敏感、guarded 包装器
- lint 守卫更新：不再要求 DSH_WEB_BASE/Host 白名单，改校验"非 POST 放行 + POST 挡 cross-site"
- 全量 20 组测试通过
