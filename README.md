# dsh-iris

给 DeepSeek Harness 装上**眼睛和双手**：多供应商媒体生成（DashScope 百炼原生协议 + OpenAI Images 兼容）、视觉理解，以及规划中的 🫧 常驻工作台。

前身是独立运行的 [ai-paint](../ai-paint) 工作台（配置中心 + 生成工作台）；dsh-iris 是同一套能力向 DSH 的**宿内移植**——工具即接口（Agent 用），泡泡工作台是人机共用的门面。

## 定位：三件套

| | 能力 | 状态 |
|---|---|---|
| ✋ 双手 | 图像生成 / 视频生成 / 语音合成 | M1–M2 已交付 |
| 👁 眼睛 | 视觉路由：显式工具（look/relook），自持 qwen-vl 为主、全局模型降级为辅 | M3 已交付 |
| 🫧 门面 | 常驻泡泡工作台（前身 public/ 前端的化身） | M4 已交付 |

## 架构原则

1. **宿内共生，不开后台**：纯宿内插件，无任何独立进程/端口。盯守定时器全部 `unref` 且随插件 Fiber 清理——DSH 停它就停，DSH 重启后自动接管未完成的远程任务。
2. **自持供应商栈**：凭据存 `$DSH_HOME/iris/v1/providers.json`（0600，接口层永不回明文）。首次运行从 ai-paint 工作台幂等导入。聊天模型设置里本来就没有 wan*/qwen-tts 这类媒体模型的位置——这是自持的正当性。
3. **与 vision-mix 平行互补**：vision-mix 是「隐式模型路由」（借全局聊天模型让文本 Agent 会看）；iris 是「显式工具 + 自持媒体栈」（画/摄/说 + 主动看图）。理念吸收、代码零耦合、命名空间天然隔离。

## 工具

| 工具 | 说明 |
|---|---|
| `iris_draw_image` | 文生图：DashScope wan* 异步（提交→盯守→转存 attachment）或 OpenAI Images 兼容同步；附视觉自述 |
| `iris_generate_video` | 三种模式：文生视频 / 图生视频（首帧 = iris 图片 attachment id 或本地绝对路径）/ **s2v 数字人**（wan2.2-s2v：首帧+语音 <20s，本地图音自动上传百炼临时存储 oss://）；长渲染自动转后台，`iris_task_status` 查询 |
| `iris_speak_text` | qwen-tts 同步合成，wav 落盘 |
| `iris_task_status` | 查询任务状态/进度/错误/产物路径（单条或最近列表） |
| `iris_look_at_image` | 👁 看图问答：本地图片 → 存附件 → qwen-vl 流式回答（自持栈为主，全局视觉模型降级为辅） |
| `iris_relook_attachment` | 对本会话已出现过的图片（上传/工具产物/iris 生成）换问题重看像素 |
| `iris_crop` | ✂️ 裁剪图片区域，返回 PNG 附件 |
| `iris_pixel_diff` | 📷 两图像素差异分析（diff ratio + 8×8 最差区域 + 热力图附件） |
| `iris_locate` | 📍 模型驱动定位目标，返回原像素 bbox（与 iris_crop 无缝接力） |
| `iris_html_screenshot` | 🖼️ 渲染 HTML 字符串为截图（依赖 dsh-builtin-browser 插件） |
| `iris_long_ocr` | 📄 长截图分块 OCR（视觉模型，默认 1200px 块 + 120px 重叠） |
| `iris_transcribe_audio` | 🎙️ 音频转写（qwen-audio-turbo，复用供应商栈） |
| `iris_video_frames` | 🎞️ 视频抽帧（ffmpeg 可选系统条件：时间均匀采样 N 帧，缩放后返回 DSH image attachments） |
| `iris_media_summarize` | 📝 多模态视频摘要（抽帧拼成带时间戳联系表 + 可选自动转写音轨 → 视觉模型摘要） |

产物统一落在 `$DSH_HOME/iris/v1/outputs/`；图片额外转存为 DSH 持久 attachment 进入对话。

## 媒体通道（对话流内点播）

DSH 附件服务只收图片，视频/音频走宿内授权路由：

```
GET /iris/media/:taskId/:token/:name
```

- 生成完成即自动登记，工具结果与 `iris_task_status` 都会给出可点击的播放链接
- **安全边界（O2，2026-09-03 修订为发布安全）**：宿主在 `/api` 上有权威信任栅栏，但 iris 的 `/iris/*` 裸 prefix 路由在其之外，故自带一道**对齐宿主、且绝不锁死合法用户**的守卫（`lib/guard.js`）——
  读接口（GET/HEAD/SSE）全放开（跨源读本就受 CORS 阻挡，媒体另有 token 能力凭证）；
  **仅 POST 挡跨站 CSRF**：`Sec-Fetch-Site: cross-site` 或 `Origin.host ≠ Host` 一律 403，挡住恶意网页驱动付费生成；
  同源浏览器（无论经回环 / LAN IP / 反代域名访问，Origin 总与 Host 同源）与无 Origin 的本机 CLI 一律放行——**任何部署拓扑都不误伤**。
  DNS 重绑定需 Host 白名单才能挡，但那正是锁死 LAN/反代用户的元凶；iris 开源、该攻击价值低，故不设 Host 白名单（明确取舍）。
  媒体通道另有：token 为 crypto 随机 128bit 能力凭证（只存任务记录）；文件定位只信任务记录、URL 文件名段不参与路径解析（防穿越）；未命中一律 404；仅 GET/HEAD
- **M4 泡泡工作台数据通道**：`GET /iris/api/state`（同源 JSON，兜底轮询 30s）+ **SSE 实时推送**
  `GET /iris/api/state/events`（EventSource，状态变化即推，延迟 ≤400ms，替代原 5s 轮询）；
  供应商状态只给 Key hint、历史面板按 running/recent 分组、产物给授权播放链接；接口只回标量，
  apiKey/文件绝对路径永不明文
- SSE 生命周期成本：一次连接 = 一个未完成 HTTP 响应 + 15s 心跳保持活跃；插件停用时 `closeAllSse()`
  关闭全部长连接，不留悬挂连接
- 反代/远程部署用 `DSH_WEB_BASE` 覆盖默认基址 `http://127.0.0.1:3080`
- 插件停用即撤路由；任务元数据裁剪（200 条）后旧链接自然失效

## 任务框架（继承 ai-paint，宿内化）

- 元数据：`$DSH_HOME/iris/v1/tasks.json`（只存元数据与 attachment 索引，最多 200 条）
- 服务端盯守：轮询容错（连续 5 次失败才判死）、单任务上限 20 分钟、间隔按能力区分（图像 2.5s / 视频 6s）
- 工具内等待有上限（图像 3 分钟 / 视频 8 分钟），超时自动转后台并告知 task id
- 取消信号传播：abort 即标记 canceled 并停盯
- DSH 重启恢复：百炼异步任务在服务端继续跑、结果 URL 存活 24h，启动时重新接管落袋

## 里程碑

- [x] **M1** 工具（画图/语音）+ 配置自持 + 工作台导入
- [x] **M2** 任务盯守框架（后台化/重启恢复/历史元数据）+ 视频生成
- [x] **M3** 眼睛：`iris_look_at_image` / `iris_relook_attachment`（visionStream 移植，qwen-vl 走自持栈；与 vision-mix 分工——它是隐式模型路由，我们是显式工具）
- [x] **M4** 🫧 泡泡工作台（settings.section 常驻工作台页 + conversation.input.dock 任务进度条 + shell.overlay 主界面悬浮泡泡——可拖动、未配置 API 时暗淡、配置就绪发亮、运行中带数字角标、点击展开工作台浮层；host 侧 /iris/api/state JSON 数据通道，Key 只出 hint）
- [x] **阶段 4 续** 泡泡瘦身 + 任务清理（浮层改「📋任务/⚡常用」双标签，常用卡片由用户在设置页勾选、默认干净；设置页历史按今天/昨天/更早分组 + 清空已完成/清理 N 天前/扫描并删除孤儿产物，删记录默认只删元数据产物留盘；后台历史上限 200→500）
- [x] **阶段 0** M4 收口与可靠性（泡泡交互收口/共享状态源/媒体 Range/持久化加固/真实 lint）
- [x] **阶段 1** Provider / Capability 基座（VisionBackend 抽象、严格能力选择、结构化错误分类）
- [x] **阶段 2** 确定性像素工具（iris_crop / iris_pixel_diff，基于 sharp）
- [x] **阶段 3** 模型驱动视觉工具（iris_locate / iris_html_screenshot / iris_long_ocr）
- [x] **阶段 4** 任务详情抽屉（/iris/api/task/:id + TaskDetailDrawer 组件）
- [x] **阶段 5** 前端操作面板（GUI 直连：11 工具可折叠操作卡片组 + POST /iris/api/actions/:name）
- [x] **阶段 6** 供应商模型池与能力调度（多 key 鸡尾酒：模型发现规则、能力分配、供应商管理 GUI）
- [x] **阶段 6 条目 4** 能力有序分配 UI（每能力一个 failover 列表：加入/↑↓排序/移出/恢复自动；qwen3-vl 强视觉模型入池——VERIFY 实证 grounding 零偏差）
- [x] **O2 授权边界** 请求守卫 `lib/guard.js`（Host 回环白名单斩 DNS 重绑定 + POST Origin/Sec-Fetch-Site 拒跨站 CSRF；本机 CLI 放行）
- [x] **可靠性两轮** 孤儿任务防线（submitGuard+接管兜底+progress 收尾）/ 网络超时分层 / 转写重启接管 / body 按字节限长 / 流与总线生命周期
- [x] **阶段 7.2** 音频转写（qwen-audio-turbo，复用供应商栈）
- [x] **阶段 7.1** 视频抽帧（ffmpeg 可选系统条件，`iris_video_frames` 工具 + GUI 卡片）
- [x] **阶段 7.3** 多模态上下文摘要（`iris_media_summarize`：联系表 + 自动转写 → 视觉摘要）
- Backlog：CosyVoice WebSocket 流式 TTS、批量队列并发、阶段 8 Skills 沉淀

## License

MIT
