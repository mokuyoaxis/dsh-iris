# 路线图

Iris 正从 DSH 媒体插件演进为可独立运行、可接入不同 Agent 宿主的媒体生产核心。本文列当前状态与后续方向；版本变化见 [变更记录](../CHANGELOG.md)。

## 当前状态

当前版本为 **Iris 0.2.1**。包名保持 `@mokuyoaxis/dsh-iris`，同时提供 DSH 插件与无 DSH 的 Headless CLI。功能范围见 [0.2.1 发布说明](releases/0.2.1.md)。

0.2.1 的更新重点是 **完成 OpenAI 兼容图片与视觉工作流**：生成图片 → Core Artifact → 按 ID 看图/OCR → 聊天改图 → 新 Artifact，CLI 与 DSH 工作台共用同一链路。本版已实现以下能力：

- 图片生成按模型选择 DashScope、OpenAI Images、聊天生图或 Responses 协议，PNG/JPEG/WebP 按真实字节交付；
- Artifact ID 看图、OCR、定位，以及“来源 Artifact → 聊天改图 → 新 Artifact”的关系与引用保护；
- 共享视觉预算、长图分块、取消与完整终态检查；账号/模型输入预算只处理发送副本，定位坐标映射回原图；
- 图片、视频、S2V、语音、转写与本地处理的 Core 任务链，独立视觉 CLI、HTML 截图及完整配置/查询/维护命令；
- 工作台统一 Core/旧版全媒体分页过滤，跨页选择、ZIP 下载、详情及 Core 可恢复隔离/恢复；
- 短时 429 琥珀冷却、明确额度或预算耗尽红色停用，以及既有提示词泡泡的按次规则和可编辑预览。

CLI 与 DSH 共用 Task、Attempt、Artifact 和 Command Service；Host 负责会话、附件、浏览器与 UI。纯视觉和提示词预览消费共享 Model Ports，不自动创建媒体 Task/Artifact。受理未知不会自动重提，同一数据根只允许一个 writer。Core 与 Model Port 内部接口尚未冻结为公共 SDK，详见 [Core 迁移](DSH_CORE_MIGRATION.md)、[CLI](HEADLESS_CLI.md) 和 [Artifact Manifest](ARTIFACT_MANIFEST.md)。

Node.js 最低版本保持 22.0.0，DSH 插件只声明支持准确的 `0.2.0-rc.2`。旧 DSH `>=0.1.2-rc.1 <0.1.3-0` 或 `0.1.5-rc.1` 继续固定安装 Iris `0.1.4`；其他宿主版本需独立验收。第二个真实 Host Adapter 完成并验收后再安排仓库与 npm 包更名，CLI、测试 fixture 与媒体 Provider 不算第二个 Host Adapter。

## 近期优先：真实使用验收

0.2.1 的发布检查覆盖完整测试、lint、实际 tarball、敏感信息、仓库外安装与跨平台 CI。服务层与包安装验收之外，近期优先补齐真实浏览器/移动端及异步重启使用证据。

工作台两轮功能已实现；第三轮仍需补浏览器/移动端的筛选、分页、跨页选择、识别、改图、下载及回收区使用验收，以及真实异步任务重启后的 CLI 接管。已有真实图片生成、按 ID 看图和聊天改图链路验证，完整会话与重启范围继续以 [验证说明](DSH_CORE_MIGRATION.md#验证证据与限制) 为准。提示词优化系统的后续设计单独安排，不扩入本次发布。

DSH 工作台与 Headless CLI 均复用 Core 的引用保护、可恢复隔离和恢复命令；legacy `outputs/` 的永久删除仍由旧工作台处理。两种删除语义与已实现的作品管理见 [工作台作品管理](WORKBENCH_ARTIFACTS.md)。

## 后续功能方向

### 后续 0.2.x

- 适配其他协议，包括原生 Gemini、Fal 和后续 Replicate；网关兼容接口与原生协议接入分别验证；
- Music 音乐生成：接入音乐生成模型，复用 Core 任务、Artifact 和作品管理；具体协议、模型与入口后续确定，不纳入 0.2.1；
- 收藏、标签与工作台搜索（CLI 及工作台过滤、分页、显式选择/批量下载已完成）；
- Artifact 关系边冻结 `retried-from` 类型，补全重试谱系（0.2.0 仅有 Task 级 `retriedFrom`）；
- Core 隔离内容的永久 purge（0.2.1 已开放可恢复隔离/恢复，legacy 永久删除保持原行为）；
- 鸢尾花与泡泡视觉身份；
- 有可用接口与实际需求后，补 Images 编辑、mask、多参考图或连续编辑；
- 将提示词优化收口为 Core Prompt Engine 与共享 `prompt.optimize` Command，由 CLI 和 DSH 入口共同消费；DSH 只负责草稿读取、预览和写回；
- 冻结中立 TextModel Port，把 Ollama、兼容文本端点及其他文本模型后端与媒体 Provider Catalog 分离，避免通用文本模型淹没 Iris 媒体模型界面；
- 接入 ComfyUI、本地 TTS 等本地媒体 Provider，并补齐 `auth: none`、`billing: none`、同步完成语义和本地/远程 UI 区分；
- 有可信价格来源后的成本与策略展示。

### 0.3 及以后

- `0.3`：Recipe、可恢复 Flow、显式启动的本地 API 和最小独立工作台；
- `0.4`：在有真实消费者后公开 Provider/Host SDK；
- `1.0`：冻结经过多宿主和升级验证的公共契约。

## 兼容性与限制

- Iris 0.2.x 的 Node.js 最低版本为 22.0.0；DSH 要求更高版本时以 DSH 为准。
- 图片处理依赖 `sharp`；视频文件抽帧依赖 `ffmpeg`、`ffprobe`，摘要复用既有 Core 帧时无需这两个工具。独立 HTML 截图需要显式提供 Chromium。
- DSH 仍处于快速演进期。单个 Host Port 可以降级，但 DSH 若改变插件加载协议，仍需更新 DSH Adapter。
- 模型发现只列出候选项；真实能力必须由用户显式验证。
- 原生 Windows/WSL 的完整 DSH 宿主冒烟仍待补充。
- Headless CLI 的媒体、视觉、S2V、HTML、配置、查询、批量、有界等待与 Core 隔离/恢复见 [CLI 管理](CLI_MANAGEMENT.md)。需要存储时显式指定绝对数据根，观察和等待不重新提交；Core 永久 purge 尚未开放。
- Responses 只支持同步单图；聊天改图只支持一张静态来源图片，输出尺寸与编辑精度由模型决定。

## 质量要求

- 已受理或受理未知的远端任务不得自动重提。
- 同一数据根不得出现两个写者；reader 不产生隐式写入。
- Core/CLI 在 DSH/Cordis 不可解析时仍能装载和运行本地动作。
- Task、Attempt 和 Artifact 不保存凭据、私有 URL 或不必要的宿主绝对路径。
- 每项新增行为需有失败路径测试；发布前执行打包、敏感信息和仓库外安装检查。

## 暂不计划

- 在插件中建设账号、多租户、计费或公网 SaaS；
- 由 DSH 插件隐式启动 daemon 或额外监听端口；
- 自动探测全部模型并产生不可见费用；
- 为没有真实调用方的 Provider 或 Host 预建空适配器；
- 在 Core 稳定前拆分多个 npm 包或重写技术栈。
