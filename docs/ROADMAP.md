# 路线图

Iris 的定位是本地优先、Agent 可控的多模态创作工作区：让用户和 Agent 能够从描述或已有素材出发，安全地完成生成、编辑、视觉分析、版本比较与产物交付。历史版本演进明细见 [变更记录](../CHANGELOG.md)。

## 当前状态

当前版本为 **Iris 0.3.3**（发布说明见 [0.3.3 发行说明](releases/0.3.3.md)、[0.3.2 历史发行](releases/0.3.2.md)、[0.3.1 历史发行](releases/0.3.1.md) 与 [0.3.0 历史发行](releases/0.3.0.md)，范围定义见 [支持范围](BETA_SCOPE.md)，升级指引见 [升级指南](UPGRADING_0.3.md)，历史版本对照保留于 [0.2.7 发行说明](releases/0.2.7.md)）。它以单个 npm 包 `@mokuyoaxis/dsh-iris` 同时提供 **独立 Core Web 工作台**、**通用 MCP（stdio / Streamable HTTP）**、**Headless CLI** 与 **DSH 原生插件**：

- **全链路媒体与视觉能力**：覆盖图片生成、持久图片导入与 Artifact 改图（含模型级图片协议与 DashScope 原生 Qwen 改图）、ComfyUI 工作流与开放标量参数、视频（t2v/i2v/S2V 及工作台本地抽帧）、TTS 语音合成、音频转写、音乐生成，以及看图问答、长图 OCR（含已完成真机复测的保守跨块边界去重 `boundary-overlap/v0`）、目标定位（含工作台 EXIF 精确 SVG 叠框与零计费一键裁剪）与视频多模态摘要（含工作台抽帧创建）。
- **模型池、凭据与网络/调度治理**：六类功能支持自动池、手动有序名单或停用（宿主默认视觉与新发现目录模型均需显式确认）；支持 DSH 连接引用与环境变量凭据引用（`apiKeyEnv`）、HTTP(S) 代理节点/有序出口池/供应商绑定、进程内网络 Doctor、有界并发调度及六色能力健康光谱。
- **持久执行与恢复诊断**：单物理数据根单写者租约，持久记录 Run、Task、Attempt、Operation 与 Artifact 关系，并在工作台提供只读来源/派生血缘视图；支持同步结果缓存的交付恢复与可恢复回收区隔离。0.3.x 持续完善了 Core 拒绝请求时的 Agent 安全诊断、默认串行执行指引、只读连接查回历史 Operation（含 `run_operations` 分页与 `waitMs` 有界等待）以及未知受理防重提保护。
- **Agent Skills 与提示词优化**：随包提供 DSH 三项 Skill（`iris-use`、`iris-compose-media`、`iris-verify-ui`）、CLI 独立 `iris-core` Skill 与按连接权限生成的 MCP 专属 Skill；DSH 输入区提供支持忠实整理、改写表达与独立建议的 `🫧` 提示词优化器。

## 近期优先：插件契约与真实接入

0.3 体系围绕独立工作台、通用 MCP 与显式插件契约持续演进：

- **最小插件契约与多模态生态就绪**：0.3 线提供 [Core 插件贡献契约 v0](PLUGINS.md)、Provider 工厂上下文 v1（含 `supportsVideoMode` / `modelParameters` 与多模态 `ProviderMediaInput`）、统一能力目录、多模态业务输入/产出（`artifactInputTypes` / `artifactOutputKinds` / `artifact.lineage`）、宿主托管 Schema 自动表单（零前端代码即可在「本地工具 → 扩展业务」运行）以及工作台组合挂载（页面、设置、预览器及 `context.host` 导航联动）。内置[多图对照板](CONTACT_SHEET.md)及两套独立起手模板已打通持久 Operation、原 UUID 恢复、Web 选择、MCP 调用与包外归档消费。当前冻结[最小兼容面](BETA_SCOPE.md#最小插件兼容面)，完整 SDK 与分发体验将根据实际插件开发者反馈继续演进。
- **工作台与通用 MCP 覆盖深化**：[Core 工作台](LOCAL_WEB.md)与[通用 MCP](MCP.md) 已在 v1–v5 执行根上打通改图、文生图/ComfyUI、TTS/转写、[持久音乐生成](MUSIC.md)（`music/v0` 及 `retried-from` 重试血缘）、[三类视频流程](VIDEO_FLOWS.md)（文生/图生/数字人视频、首帧与音频预览、本地抽帧/一键取尾帧及跨模式接续草稿）、[视觉流程](VISION_FLOWS.md)（看图问答、长图 OCR 及保守去重 `boundary-overlap/v0`、视觉定位 `vision-locate`、多模态摘要 `media-summarize`）、零计费本地工具（工作台独立面板含 EXIF 裁剪、双图热力图、本地 `ffmpeg` 音视频合轨、HTML 沙箱截图与宿主插件自动表单；MCP `local-media` 含 `iris_core_mux_video_audio` / `html-render`）、只读作品/流程血缘视图与一键复制 ID、作品库快速筛选、只读收件目录（`--inbox-dir` / `inbox`）、显式 MCP 作品选择（`iris_core_select_run`）以及受控出件目录（`--outbox-dir` / `outbox`、Web 内联落盘与总览出件列表），并配套 8 种主流客户端预设、连接配置自检与连接专属 Skill。
- **下一阶段评估重点**：
  - **真实硬件、宿主与作品整理**：分开补充真实 ComfyUI GPU 推理、原生 Windows/WSL 完整 DSH 宿主装载与更多外部 MCP 客户端端到端证据，并按需求评估收藏、标签与可恢复归档。

## 后续功能方向

### 后续演进计划

- **创作体验进阶**：在现有零计费本地工具面板与视觉定位/摘要基础上，待更多上游接口成熟后探索多版本选择、局部重绘（mask）、多参考图与连续多轮编辑。
- **更多协议与音视频衔接**：按实际需求评估原生 Gemini、Fal、Replicate 等协议适配，并在现有视频抽帧/尾帧、数字人与本地音视频合轨基础上继续丰富多步骤创作编排（详见 [视频流程](VIDEO_FLOWS.md) 与 [音乐生成](MUSIC.md)）。
- **作品库组织与维护**：在现有分页、快速筛选与批量 ZIP 导出基础上，增加收藏、标签与跨页搜索能力；在现有可恢复隔离/恢复基础上开放经确认的永久 `purge` 清理（见 [CLI 管理](CLI_MANAGEMENT.md) 与 [工作台作品管理](WORKBENCH_ARTIFACTS.md)）。
- **提示词与文本模型端口解耦**：在既有纯核心提示词优化实现上补充共享 `prompt.optimize` Command 与 CLI 入口；进一步冻结中立的 TextModel Port，使通用文本模型（如 Ollama 或兼容文本端点）与媒体 Provider 目录解耦。
- **成本提示与配额管理**：在有可靠价格数据源的前提下提供成本与策略参考，并探索可选的磁盘空间占用提示与目录新模型显式跟随策略。

### 0.3 及以后

- `0.3`：巩固可恢复 Flow、本地 API、独立 Core 工作台、通用 MCP（含本地检视/收件/无头截图/视觉定位闭环）、网络/调度治理与实验性插件贡献，持续打磨首次接入与公开插件模板的实际消费体验；
- `0.4`：结合真实第三方插件与宿主消费者的反馈完善公开 SDK，按实际验证范围扩展宿主与协议兼容承诺；
- `1.0`：冻结经过多宿主、多协议与跨版本升级充分验证的公共契约。

## 兼容性与限制

- **Node.js 与基础依赖**：Iris 0.3.x 要求 **Node.js ≥22.1.0**（0.2.x 历史版本最低为 22.0.0；DSH 宿主要求更高版本时以宿主为准）。图片处理依赖 `sharp`；视频文件抽帧依赖 `ffmpeg` 与 `ffprobe`（复用已有 Core 帧做摘要时无需这两个工具）；独立 CLI 与 MCP `html-render` HTML 截图需显式指定 Chromium 可执行文件。
- **DSH 宿主兼容矩阵**：DSH 原生插件在 0.3.3 中扩展至 [兼容矩阵](DSH_COMPATIBILITY.md) 列出的 **25 个准确版本**（覆盖 `0.1.2-rc.1` 至 `0.2.2-rc.5`，含当前 `latest`），宿主差异收敛在 Adapter 与客户端桥接层；`0.2.3-alpha.*` 留待完整宿主认证验收后再评估。
- **已知范围限制**：
  - DSH 工作台与 Headless CLI 共用 Core 的可恢复隔离和恢复入口，legacy `outputs/` 的删除仍永久生效；操作时须区分作品来源（见 [CLI 管理](CLI_MANAGEMENT.md) 与 [工作台作品管理](WORKBENCH_ARTIFACTS.md)）；
  - 模型目录发现仅列出候选项，真实可用性需由用户确认用途并显式验证；
  - OpenAI `Responses` 生图目前仅支持同步单图，聊天改图仅支持单张静态来源图片；
  - 长图 OCR 的 `complete` 状态表示计划分块全部执行完成；`boundary-overlap/v0` 默认启用保守跨块边界重叠去重，已于 2026-11-23 在正式 `0.3.1` 归档上完成冻结重叠长图 4 次真实视觉 POST 复测（CER `12.93%` → `0%`，3/3 接缝合并），遇周期性/重复行歧义时仍保守保留原文且各块原始输出完整留在 OCR JSON 报告中（单样本结果不外推至任意复杂排版或自然重复文档）；
  - 原生 Windows/WSL 的完整 DSH 宿主冒烟、真实 ComfyUI GPU 推理以及 Termux/PRoot 下的历史偶发 CLI 停顿问题仍在持续跟踪。

## 质量要求

- **防重提底线**：Core 仅在供应商明确返回 `not_accepted` 时切换候选；Music 的 HTTP 502 重发默认最多额外重试两次（可能产生额外费用；`retry_502: 0` 可关闭）并保留独立 Task 事实。
- **单写者与只读纯粹性**：同一物理数据根不得同时出现两个写者；所有 `reader` 查询与页面刷新绝不产生隐式写入或供应商请求。
- **宿主解耦与隐私保护**：Core 与 Headless CLI 在无 DSH/Cordis 的环境中可独立装载运行；Task、Attempt 与 Artifact 持久记录绝不保存 API Key、私有签名 URL 或宿主绝对路径。
- **测试与发布门禁**：每项新增行为均需配套失败路径与中断恢复测试；发布前必须通过全量测试、打包白名单审计、仓库外安装消费及跨平台 CI 矩阵验证。

## 暂不计划

- 在插件或本地工作台中建设多租户账号、计费系统或公网 SaaS 服务；
- 由 DSH 插件隐式启动后台常驻 daemon 或打开未声明的监听端口；
- 在未经用户确认的情况下自动发起付费模型探测；
- 为没有真实调用需求或验证条件的 Provider 或 Host 预建空适配器；
- 在 Core 公共契约完全稳定前拆分为多个零散 npm 包或重写技术栈。
