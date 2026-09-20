# 路线图

Iris 正从 DSH 媒体插件演进为可独立运行、可接入不同 Agent 宿主的媒体生产核心。本文只列当前状态与后续方向；历史版本的具体改动见[变更记录](../CHANGELOG.md)，内部实现顺序不在公开路线图中展开。

## 当前状态

当前稳定版本为 `0.1.4`，以 `@mokuyoaxis/dsh-iris` 安装到 DeepSeek Harness。它提供：

- 图片、视频和语音生成，音频转写；
- 看图问答、OCR、目标定位、裁剪、像素比较、视频抽帧和摘要；
- 多供应商模型池与能力分配；
- 可恢复的异步任务、受理边界和人工接管；
- 独立作品库、Iris 工作台、🫧 提示词优化入口；
- 两项随包 Agent Skill；
- Host/Provider Adapter、离线 Doctor 和零网络一致性测试。

稳定版仍以 DSH 为主要入口。开发分支已经建立实例化 Core Runtime，打通无 DSH 的 crop、四种媒体生成提交、Task 观察与 Artifact 管理，并完成带内容哈希、关系边、可重建 Index 和孤儿恢复的 Artifact Manifest v0。crop 与图片、视频、语音、转写的新任务全部落到共享 Core Task/Attempt/Artifact：Host 只负责有界观察、启动接管和 attachment/UI 投影；统一作品区与五类用户状态投影覆盖四种媒体工作，CLI、DSH API 和 UI 共用同一 Command Service 的人工控制面（重新观察、重新取回、取消、重试为新任务）。四种媒体各有真实 Provider canary 证据。s2v 数字人视频、视觉理解与提示词优化仍走稳定链路；Core 公开 API 未冻结，这些接口尚未随稳定版发布，详见 [Headless CLI](HEADLESS_CLI.md)、[FakeProvider 生命周期验收器](PROVIDER_RUNTIME_HARNESS.md)、[Artifact Manifest](ARTIFACT_MANIFEST.md)和 [DSH → Core 渐进迁移](DSH_CORE_MIGRATION.md)。

当前源码是 `0.2.0-rc.1` 的开发检查点，不改变 npm 或 DSH 市场中的 `0.1.4` 稳定版本。检查点可用于源码审阅和 CI，不代表已经发布、冻结公共接口或完成全部平台验收。

已验证的 DSH 范围为 `>=0.1.2-rc.1 <0.1.3-0` 和 `0.1.5-rc.1`。其他预览版只有通过 Host canary 后才会加入支持范围。

## 下一步

### 0.2.0：Core、CLI 与 Artifact

`0.2.0-rc.1` 用于验证功能独立，不包含 standalone Web 服务。主要工作是：

1. 让 Core 显式管理数据根、单写者租约、生命周期和取消；
2. 让 CLI 与 DSH 共用 Command、Task、Attempt 和 Artifact 语义；
3. 用 FakeProvider 覆盖提交、受理、轮询、交付、重启和取消；
4. 完成 Artifact Manifest、内容哈希、关系边、索引重建和崩溃一致性；
5. 通过无 DSH 安装、跨平台测试和真实 DSH canary。

正式版只在 rc 升级、回退和双入口验证通过后发布。无用户反馈不会替代这些门槛。

### 后续 0.2.x

- 收藏、标签、搜索、筛选和批量导出；
- Artifact 关系边冻结 `retried-from` 类型，补全重试谱系（0.2.0 仅有 Task 级 `retriedFrom`）；
- Core Task/Artifact 删除、清理与孤儿 purge（0.2.0 的 Headless CLI 和 DSH 工作台都保持 Core 只读；工作台现有删除、清空与孤儿清理只作用于 legacy `outputs/`）；
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

- Node.js 最低版本为 20.10；DSH 要求更高版本时以 DSH 为准。
- 图片处理依赖 `sharp`；视频抽帧和摘要依赖 `ffmpeg`、`ffprobe`。
- DSH 仍处于快速演进期。单个 Host Port 可以降级，但 DSH 若改变插件加载协议，仍需更新 DSH Adapter。
- 模型发现只列出候选项；真实能力必须由用户显式验证。
- 原生 Windows/WSL 的完整 DSH 宿主冒烟仍待补充。
- Headless CLI 当前开放 crop、图片/视频/语音/转写提交、Task 查询/单步观察与 Artifact 检查/导出；必须显式指定绝对数据根，且不会自动循环观察。0.2.0 的 Headless CLI 与 DSH 工作台都不提供 Core Task/Artifact 删除或清理能力；工作台现有破坏性动作只处理 legacy `outputs/`。Core 删除能力计划在 0.2.x 开放。

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
