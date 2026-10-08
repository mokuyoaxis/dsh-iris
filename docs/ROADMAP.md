# 路线图

Iris 正从 DSH 媒体插件演进为可独立运行、可接入不同 Agent 宿主的媒体生产核心。本文只列当前状态与后续方向；历史版本的具体改动见[变更记录](../CHANGELOG.md)，内部实现顺序不在公开路线图中展开。

## 当前状态

当前版本为 `0.2.0`，保留包名 `@mokuyoaxis/dsh-iris`，同时提供 DeepSeek Harness 插件和 Headless CLI。它提供：

- 图片、视频和语音生成，音频转写；
- 看图问答、OCR、目标定位、裁剪、像素比较、视频抽帧和摘要；
- 多供应商模型池与能力分配；
- 可恢复的异步任务、受理边界和人工接管；
- 独立作品库、Iris 工作台、🫧 提示词优化入口；
- 两项随包 Agent Skill；
- Host/Provider Adapter、离线 Doctor 和零网络一致性测试。

0.2.0 建立实例化 Core Runtime，打通无 DSH 的 crop、四种媒体生成提交、Task 观察与 Artifact 管理，并提供带内容哈希、关系边、可重建 Index 和孤儿恢复的 Artifact Manifest v0。crop 与图片、视频、语音、转写的新任务全部落到共享 Core Task/Attempt/Artifact：Host 负责有界观察、启动接管和 attachment/UI 投影；统一作品区与五类用户状态投影覆盖四种媒体工作，CLI、DSH API 和 UI 共用同一 Command Service 的人工控制面（重新观察、重新取回、取消、重试为新任务）。迁移过程中积累了真实 Provider canary 记录，详细范围与后续待验项以验收文档为准。s2v 数字人视频、视觉理解与提示词优化仍走原有链路；Core 公开 API 未冻结，详见 [Headless CLI](HEADLESS_CLI.md)、[FakeProvider 生命周期验收器](PROVIDER_RUNTIME_HARNESS.md)、[Artifact Manifest](ARTIFACT_MANIFEST.md)和 [DSH → Core 渐进迁移](DSH_CORE_MIGRATION.md)。

第二个真实 Host Adapter 实现并验收后，计划将现有 GitHub 仓库更名为 Iris，并新建 `@mokuyoaxis/iris` npm 包，复用发布工作流。当前 0.2.0 保留名称；旧包后续单独维护另行决定。CLI、测试 fixture 与媒体 Provider 不算第二个 Host Adapter。

已发布 Iris `0.1.4` 的历史 DSH 范围为 `>=0.1.2-rc.1 <0.1.3-0` 和 `0.1.5-rc.1`，旧宿主应固定安装 `@mokuyoaxis/dsh-iris@0.1.4`。Iris `0.2.0` 只声明支持准确的 DSH `0.2.0-rc.2`，已通过真实安装服务隔离验收；历史旧版验收不继承到当前版本。修正与实机待验项见 [rc.2 适配说明](DSH_RC2_ADAPTATION.md)。其他版本需先通过独立 Host canary 才会加入支持范围，具体安装与市场版本选择见 [README](../README.md#最快开始)。

## 下一步

当前开发工作树已完成提示词 M2：DSH 文本适配器、共享优化核心和按次规则/只组装/可编辑预览；**尚未发布**。v1 配置保持不变，CLI `prompt.optimize`、自持文本后端及规则持久化仍待后续切片。见 [提示词优化系统](PROMPT_OPTIMIZER.md)。

开发版视觉 M3 已接入单图 look/relook 和显式视觉实测：HTTP/DSH 正常终态检查、整体预算、取消停止切换与同图字节桥接已实现，**尚未发布**。单图范围与限制见 [单图视觉调用](VISION_MODEL.md)。

开发版 M4 已完成长图 OCR、定位、拼图摘要及图片生成后自述的共享端口迁移。整体预算覆盖准备和候选，取消/超时终止后续生成；OCR 明确部分结果，摘要一张拼图一次候选调用，可选转写读取 Core 文本 Artifact。尚未发布，详见 [长图 OCR](OCR_MODEL.md) 和 [复合视觉调用](COMPOSITE_VISION.md)。

M5 的独立视觉入口已实现 `vision look / locate / ocr / summarize`，支持严格显式选型、JSON/文本和文件输出；默认画面摘要，文件输入无需数据根，图片/帧 Artifact ID 输入使用显式 Core reader，主动转写使用 Core writer。尚未发布，详见 [视觉 CLI](VISION_CLI.md)。提示词优化后续由用户另行安排，本次未扩展其入口或配置。

开发版已按顺序补齐 S2V Core 迁移与 CLI、HTML 截图、模型/配置管理、异步任务等待、查询与批量操作、Core 可恢复删除和清理。仍沿用原包入口与配置结构，没有新增生产依赖、发布或扩展提示词系统。详见 [CLI 管理与补齐](CLI_MANAGEMENT.md)。

开发版摘要现可直接复用既有 Core 抽帧 Artifact，CLI 和 DSH 共用只读帧输入，保留原帧序号/时间戳，无需原视频或 ffmpeg。看图/定位/OCR 也已支持 Core 图片 Artifact ID，无需原文件或临时导出。接下来可补真实 DSH 对话附件、浏览器与异步重启/CLI 接管验收；提示词优化仍由用户另行安排。

### 后续 0.2.x

开发版已补工作台统一作品分页、基础过滤和 Core 图片卡看图/OCR，支持可取消的结果预览、复制和下载文本。详见 [工作台作品管理](WORKBENCH_ARTIFACTS.md)。批量选择、下载和可恢复删除属于下一轮。

- 收藏、标签、工作台搜索与批量管理（CLI 过滤、分页与显式批量导出已完成）；
- Artifact 关系边冻结 `retried-from` 类型，补全重试谱系（0.2.0 仅有 Task 级 `retriedFrom`）；
- Core 隔离内容的永久 purge 与工作台删除入口（开发版 CLI 已开放可恢复隔离/恢复，DSH 工作台现有删除、清空与孤儿清理仍只作用于 legacy `outputs/`）；
- 鸢尾花与泡泡视觉身份；
- Gemini、Fal 和后续 Replicate Provider；
- 将提示词优化收口为 Core Prompt Engine 与共享 `prompt.optimize` Command，由 CLI 和 DSH 入口共同消费；DSH 只负责草稿读取、预览和写回；
- 冻结中立 TextModel Port，把 Ollama、兼容文本端点及其他文本模型后端与媒体 Provider Catalog 分离，避免通用文本模型淹没 Iris 媒体模型界面；
- 接入 ComfyUI、本地 TTS 等本地媒体 Provider，并补齐 `auth: none`、`billing: none`、同步完成语义和本地/远程 UI 区分；
- 有可信价格来源后的成本与策略展示。

### 0.3 及以后

- `0.3`：Recipe、可恢复 Flow、显式启动的本地 API 和最小独立工作台；
- `0.4`：在有真实消费者后公开 Provider/Host SDK；
- `1.0`：冻结经过多宿主和升级验证的公共契约。

## 兼容性与限制

- Iris 0.2.0 的 Node.js 最低版本为 22.0.0；DSH 要求更高版本时以 DSH 为准。
- 图片处理依赖 `sharp`；视频文件抽帧依赖 `ffmpeg`、`ffprobe`，开发版摘要复用既有 Core 帧时无需这两个工具。
- DSH 仍处于快速演进期。单个 Host Port 可以降级，但 DSH 若改变插件加载协议，仍需更新 DSH Adapter。
- 模型发现只列出候选项；真实能力必须由用户显式验证。
- 原生 Windows/WSL 的完整 DSH 宿主冒烟仍待补充。
- Headless CLI 开发版的媒体、视觉、S2V、HTML、配置、查询、批量、有界等待与 Core 隔离/恢复见 [CLI 管理与补齐](CLI_MANAGEMENT.md)。需要存储时显式指定绝对数据根，观察不重新提交；DSH 工作台的破坏性动作仍只处理 legacy `outputs/`，永久 purge 留待 0.2.x。

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
