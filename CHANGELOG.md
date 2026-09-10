# 变更记录

本文件记录 dsh-iris 的用户可见变化。

## [Unreleased]

## [0.1.4] - 2026-09-10

### Added

- 冻结 Host Adapter v0 的命名端口、能力快照、缺能力错误和 Command × Host Port 矩阵，并加入零网络纯契约测试。
- 深化两项随包 Skill：增加显式用户/模型调用策略、DSH `/name` 示例、渐进参考资料和 10 条零费用行为契约。
- 增加 test-only Local Host fixture：在无 DSH、无网络下运行确定性图片动作、Task 查询与提醒确认，并固定缺 Host Port 和未迁移动作的错误边界。
- 增加 DSH Host Adapter：集中探测并映射工具、路由、附件、会话、Browser、文本/视觉模型、Skill 和客户端 Slot 九类能力，区分能力缺失与接口不兼容。
- 增加 Provider Adapter v0 完整生命周期与零网络 conformance runner；DashScope/OpenAI Images 的发现、提交、轮询、下载和错误映射统一声明，未验证的取消能力显式标为 unsupported。
- 增加零网络 Host Doctor 与工作台诊断卡：从安全能力快照、成功注册账本和受限浏览器握手检查 DSH 版本、插件、14 个工具、2 项 Skill、4 组路由、可选 Host 能力及 4 个 UI Slot；不调用 Browser、模型或 Provider。
- 增加 Provider × Model × Capability 持久健康证据与四色 UI：灰色未配置、蓝色待验证、绿色 7 天内成功、暗红色明确认证/权限失败；真实任务与显式实测共用证据，记录脱敏来源和时间且不做后台探测。
- 增加独立作品库 v0：新产物自动入库，升级时接回已有 `outputs/`，支持分页浏览、重新索引和独立删除；清任务历史后工作台与泡泡仍能访问作品。

### Changed

- 将公开路线图切换到 0.1.4：聚焦 Host/Provider 适配边界、Host Doctor、现有两项 Skill 的 Agent 易用性深化与最小作品库；不在本版扩充 Provider、完整 Artifact Manifest 或 standalone 范围。
- 将动作、工作台 API、提示词优化、视觉后端和注册生命周期改为消费 Host Port；非空原始 DSH `ctx` 不能再作为 Command 输入。HTML Browser 渲染同时补齐 `AbortSignal` 取消与清理边界。
- 将图片、视频、转写、TTS、模型发现、能力实测、任务恢复和重新交付的供应商生命周期调用收口到 Provider Adapter；canonical `unknown` 与 `canceled` 分别保持未知事实和远端确认取消，禁止退化为普通失败。
- 健康状态按当前 failover 候选保守汇总：任一近期成功即绿色，有待验证路径即蓝色，只有全部候选明确认证失败才为暗红；429、网络、5xx、内容安全、取消和未知受理不覆盖近期成功。汇总时间只取决定当前颜色的候选证据；模型或能力移除会裁掉旧绿灯，空成功说明不再误写为失败文案。
- 收紧手机端泡泡面板的真实视口宽高与四边约束，补充 `pointercancel` 位置持久化，并加入实际执行工作台、进度条和泡泡组件树的运行级回归测试。
- 分离任务历史与作品生命周期：清历史只移除任务事实和 Prompt；删除单件作品、清空作品库与删除孤儿文件分别确认。作品最小索引不保存 Provider、Model 或任务关系。
- 将 DSH 支持窗口从单一 `>=0.1.2-rc.1 <0.1.3-0` 扩展为同时声明已实测的 `0.1.5-rc.1`；Host Doctor、README、用户指南、公开路线图与市场声明同步，其余预览版继续保持不宣称兼容。

## [0.1.3] - 2026-09-08

### Added

- 新增公开的 Task/Attempt v2 语义契约，以及零网络纯函数真值表；冻结受理、自动 failover、观察、取消、产物交付、旧状态兼容和移动端用户状态的不可违反规则。

- 新增最小 Provider 提交契约、脱敏错误分类、写前持久化 Hook、零网络 Fake Provider 和旧任务纯规范化器；普通提交异常默认归为受理未知，只有明确 `not_accepted` 才能自动切换候选。

- 新增 Task v2 复制落盘与单调 revision 原语，并覆盖图片、视频、转写和 TTS：一次用户请求只创建一个 Task，每次候选在 HTTP 请求前写入 Attempt；视频和转写进一步区分上传与提交 stage。明确 4xx 拒绝才允许 failover，5xx、网络异常及缺失必要响应会以受理未知停止。

- 新增图片故障注入测试，覆盖 429 后异步/同步混合候选安全切换、500/网络失败/缺远端 ID 后零重复提交、API Key 不落任务文件、同步与异步生成成功后交付失败不重新生成、未知取消及提交中断恢复。

- 图片、视频、转写和 TTS Agent 工具开始读取 v2 事实轴：交付失败会明确表述为“生成成功但交付失败”，受理或结果未知会停止等待并要求人工确认。

- 新增 Task v2 运行时故障矩阵，覆盖盯守超时、连续轮询异常、远端明确失败、重启恢复、供应商缺失、交付中断、SSE 慢消费者和人工接管；全部使用本地 Fake/fixture，不发送计费请求。

- 新增无需安装或启动 DSH 的离线 `doctor()`、`dsh-iris doctor` CLI 与 `--json` 输出；检查运行时、依赖、私有存储、配置、模型、任务、临时文件和产物，使用稳定的 0/1/2 退出码。

- 新增公开架构、安全边界和故障注入矩阵文档。

### Changed

- 将 v0.1.3 聚焦为“防重复计费与事实可信”：离线 Doctor v0 与最薄 CLI 保留在本版，完整 Host Adapter、Provider conformance 和依赖 DSH 运行时的 Doctor 扩展顺延到 0.1.4。

- 工作台、泡泡和任务详情开始消费 v2 派生用户态：排队/运行仍属于活动任务，观察暂停、受理或结果未知、生成成功但交付失败进入独立“需要处理”分区；旧任务继续按原四态显示。

- 状态快照新增进程 epoch 与单调 revision，客户端拒绝迟到快照；SSE 对慢消费者只保留最新待发状态。

- 任务详情新增重新观察、重新交付与知情重试：前两者禁止新生成提交；知情重试必须确认可能重复计费，并用新旧 Task 关系保留审计线索。

- 待处理任务新增“标为已读/恢复提醒”；知情重试创建新任务后自动归档原提醒并展示关联，避免同一异常重复占用泡泡角标。只有明确的 Task v1 才显示“旧任务 · 只读”，热更新字段缺失不再误标新任务。

## [0.1.2] - 2026-09-06

### Changed

- 提示词优化器不再默认继承主会话的 High/Low thinking 档位；新增 `generation.reasoningEffort` 策略，默认在模型元数据明确支持时关闭推理，并在面板显示思考策略与输出预算，降低推理 token 挤占正文和意外增费的风险。

- 提示词优化器按 DSH `modelSelection.current` 投影读取当前会话模型，避免界面已有选择时仍误回退为“DSH 默认模型”。

- 对外展示名使用 “Iris Media for DSH”，npm 包名继续保留为 `@mokuyoaxis/dsh-iris`，安装文档始终使用完整 scoped 名称。

### Added

- 新增独立于 Iris 工作台的 DSH 对话框提示词优化器：输入区只保留无边框、无文字的 🫧 入口，进入带背景模糊和柔和光影的半透明玻璃悬浮窗；窄屏自动切换为安全区自适应、可内部滚动的底部面板。支持通用、图片、视频和首尾帧视频目标，默认使用当前会话模型，先预览后写回且绝不自动发送。

- 新增独立的 `prompt-optimizer.json` 配置：面板可导入/导出 JSON、固定其他 DSH provider/model、一键恢复 Iris 默认 Prompt，并可单独关闭对话入口；入口关闭后工作台、Agent 工具和任务后台继续运行。

- 插件启用时通过 DSH Skill registry 自动注册随包的 `iris-verify-ui` 与 `iris-compose-media`；用户无需克隆本仓库或把会话工作目录切到 Iris。

- README 首屏新增一张可追溯到供应商、模型与提示词的真实 Iris 生成图片。

- 新增 Android 16 真机截图画廊，记录通用提示词优化、图片 Prompt 优化、写回、任务成功和实际产物；公开副本统一移除 EXIF/XMP/IPTC 元数据。中英文 README 直接展示三张关键截图，根目录 `screenshots.json` 为插件市场声明四张精选素材。

- README 新增三张示意图：插件架构总览、生成任务生命周期与受理边界，以及「看图 → 重绘 → 自检」组合工作流示例（附 SVG 与可编辑 drawio 源文件）。

- 新增英文版 `README.en.md` 并在两份 README 顶部互设语言切换链接；npm 包清单纳入英文版。

- 新增 `scripts/gen-diagrams.mjs`：README 三张示意图由单一脚本再生成，每次运行同步产出 PNG、SVG 与可编辑 drawio 源文件。

### Fixed

- 泡泡快捷任务不再混入失败、取消或无产物的旧记录，只显示当前运行任务与最近成功产物；完整历史和错误仍保留在 Iris 工作台。

- 常用区与 Iris 工作台的功能状态灯改为挂载后直接读取共享供应商状态：启用的 API 且具备相应能力时常驻绿色，不再要求逐张点开卡片；当前执行报错后立即变暗。

- Cordis 运行时行 ID 改为唯一的 `mokuyoaxis-dsh-iris`，避免与另一款 `dsh-iris` 插件同装时按短 ID 相互覆盖；文档说明手动 profile 覆盖的迁移方式。

### Security

- 随包 Skill 直接从已安装的 Iris 包读取，不扫描额外项目或用户目录，也不改变默认 filesystem Skill provider 配置。

## [0.1.1] - 2026-09-05

### Changed

- 明确 ai-paint 是维护者未公开的本地前身而非用户依赖；插件默认启动不再读取其固定路径，仅在用户显式设置 `IRIS_IMPORT_WORKBENCH_CONFIG` 时由宿主本地一次性导入，已有供应商时跳过。
- `npm test` 使用 Node.js 调度器，移除 POSIX Shell 循环，保留逐文件进程隔离和失败即停。
- 对齐公开路线图与 `v0.1.0` 标签，区分当前 DSH 插件能力和未来宿主无关 Core/CLI/工作台。
- 工作台新增安全的媒体协议自动判断与显式选择；模型实测改为按能力触发，真实调用前确认，视频与转写不再提交空样本探针。
- 测试临时目录改用系统 API 并自动清理；`ffmpeg` 探测不再依赖 POSIX `which`。
- 增加 Linux/Windows × Node.js 20.10/22 CI 矩阵和发布前完整测试钩子。
- 新增标签驱动的 Release 工作流：推送 `vX.Y.Z` 标签即自动跑全量测试、校验标签与 package.json 版本一致、创建附 tarball 的 GitHub Release 并发布 npm（含 provenance；未配置 `NPM_TOKEN` 时仅跳过 npm 发布）。
- Node.js 最低版本调整为 20.10；20.9 无法解析当前图片依赖使用的 JSON import attributes。

### Fixed

- 修复 DSH 0.1.2+ Web 客户端按完整 npm 包名校验时，Iris 仍以旧短名注册而导致整个插件组合包加载失败的问题；同时将客户端依赖声明对齐新版的 Renderer/Session 服务。
- 旧配置为 `null` 或供应商凭据字段类型错误时，跳过无效内容而不使导入崩溃。
- 语法合法但根节点、供应商、模型、任务或分配结构错误的持久化文件现在会被隔离并安全重建，不再静默丢失后续更新。
- 大媒体下载改为流式原子落盘，避免把完整视频一次性载入内存，并清理失败的临时文件。
- Windows CI：Skill 测试先归一化 CRLF 再解析 frontmatter，并新增 `.gitattributes` 强制所有平台以 LF 检出（Windows runner 默认 `core.autocrlf=true` 曾致 `npm test` 失败）。
- Windows CI：`tests/pixels.mjs` 改用 `fileURLToPath` 解析模块路径；`URL.pathname` 在 Windows 上返回 `/D:/...`，拼出的非法临时目录路径使该测试进程直接崩溃。
- 上传接口竞态：写入流改为惰性创建、`.part` 清理等待 fd 关闭，空上传或提前失败的请求不再可能残留孤儿 `.part` 文件。

### Security

- DashScope 凭据在网络请求发出前绑定到阿里云官方 HTTPS 域名，阻止错误协议配置把 API Key 发给第三方端点。
- POSIX 上统一以 `0700` 目录和 `0600` 文件保存 Iris 配置、任务、上传及产物；启动时收紧既有 Iris 树且不跟随符号链接。
- `/iris/*` 默认只接受回环 Host；LAN/反向代理需显式配置 `IRIS_TRUSTED_HOSTS`，公开文档明确该列表不替代身份认证。

## [0.1.0] - 2026-09-04

### Added

- 增加文生图、文生视频、图生视频和 S2V 数字人视频能力。
- 增加文本转语音和独立的音频转写能力。
- 增加看图问答、附件重看、长图 OCR、目标定位、图片裁剪和像素差异分析。
- 增加视频抽帧和多模态视频摘要；缺少 `ffmpeg` 时只影响相关工具。
- 增加 Iris 工作台及悬浮泡泡入口，可管理供应商、能力分配、文件输入和任务历史。
- 增加浏览器上传与会话附件选择，支持在不同文件系统之间传递输入文件。
- 增加异步任务跟踪、重启恢复、状态事件推送和带授权令牌的音视频播放。
- 为图生视频和 S2V 动作补充回归测试。
- 增加仓库级 `iris-verify-ui` 与 `iris-compose-media` Skills：前者执行可重复的 UI 视觉验收，后者编排多步骤媒体工作流。
- 增加面向安装、供应商、模型池、能力分配和文件输入的 `user_guide.md`。

### Changed

- npm 发布包改用 `@mokuyoaxis/dsh-iris`，避开已被其他项目占用的无 scope 包名；运行时插件 ID 和工具名保持不变。
- 模型引用升级为 `providerId::modelId`，避免不同供应商下的同名模型发生碰撞。
- 图像、视频、语音、转写和视觉能力分别配置，不再复用含义不同的能力槽位。
- 工作台和 Agent 的视频生成统一使用同一套动作实现和参数校验。
- 生成类故障转移只发生在上传、提交或同步生成失败时；远端受理后不再自动重提。
- 供应商更新采用字段级合并，未提交的字段会保留原值。
- npm 包显式包含 README、用户指南、变更记录和 `docs/`，Node.js 版本要求调整为 `>=20.9.0`。

### Fixed

- 修复新版 Qwen Image、Wan 2.6/2.7 和 Z-Image 被错误发送到旧文生图端点的问题，并兼容新版图片结果结构。
- 纯图像编辑模型不再被自动分配给文生图能力。
- 修复文件转写使用错误模型与请求字段、未下载 `transcription_url` 结果的问题。
- 修复局部更新供应商配置时覆盖已有配置的问题。
- 修复旧任务附件在索引裁剪或重启后无法正确查找的问题。
- 修复上传中断遗留临时文件、过期上传未及时回收和文件权限不一致的问题。
- 修复取消信号未完整传递到上传、生成等待和后台轮询的问题。
- 修复 SSE 测试依赖固定等待时间而偶发失败的问题。
- 修复工作台与 Agent 视频参数和返回结果不一致的问题。

### Security

- HTML 截图页面改为不具备同源权限的沙箱环境，页面脚本无法访问 Iris 或宿主 API。
- 上传采用流式限额、临时 `.part` 文件和原子落盘，失败时会清理未完成文件。
- 修改状态的路由拒绝明确的跨站请求，媒体文件继续使用随机能力令牌访问。

[Unreleased]: https://github.com/mokuyoaxis/dsh-iris/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/mokuyoaxis/dsh-iris/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/mokuyoaxis/dsh-iris/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/mokuyoaxis/dsh-iris/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/mokuyoaxis/dsh-iris/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mokuyoaxis/dsh-iris/releases/tag/v0.1.0
