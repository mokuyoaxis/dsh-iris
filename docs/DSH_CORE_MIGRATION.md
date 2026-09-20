# DSH → Core 渐进迁移

本文描述 0.2.0 候选工作树，不代表已发布版本。迁移逐条切换消费者，不原地改写 0.1.4 数据；未迁移能力继续使用稳定版实现。

## 已切换的执行链：crop 与新图片任务

- `iris_crop` 和工作台 crop 共用 Command Service 与 Artifact Manifest。attachment 输入先成为 `host-input` Artifact，裁剪结果用 `derived-from` 保存关系；工具名、参数和附件输出不变。
- 新图片任务的同步、异步与混合候选均使用同一 Core Task/Attempt/Artifact。每个候选先落盘 Attempt，只有明确 `not_accepted` 才允许切换；收到远端 ID 或受理未知后停止候选提交。
- 新 Attempt 可选记录七个单调 `stageTimestamps` 边界，区分排队、提交、远端执行、下载和本地 Artifact 处理；旧记录缺失该字段仍合法，未发生的阶段不补写。
- Provider 只收到原始模型 ID；Core 保存 `providerId::modelId` 和非敏感端点 binding，不保存 Prompt、凭据、下载 URL 或 DSH 会话。
- DSH 边界选择 `$DSH_HOME/iris/v1/core-v0`，与旧 `tasks.json`、`artifacts.json`、`outputs/` 隔离。旧任务仍由旧观察器读取和接管；新图片不双写旧存储。

`iris_draw_image` 等待同一 Core Task，ready 后通过命名 Attachment Port 返回图片。等待超时只返回稳定 Task ID，后台观察继续；停止工具等待不等于远端取消。宿主投影失败不会撤销 Core 中已经成功交付的产物。

## 异步观察与重启接管

Core runner 不拥有 timer，单次 observe 最多执行一次 poll，绝不 resubmit。DSH Host 在此之上提供有界调度：

- 每次观察重新读取 Task，并按原 Provider、模型和 binding 恢复 Adapter；端点/协议漂移、停用、缺凭据或模型不可用时不发送请求。API Key 可以轮换。
- 每次 submit/observe 使用独立、短生命周期 writer Runtime；同进程操作排队，跨进程 writer 冲突仍 fail-fast。等待下次节拍不占用 writer 租约。
- 强杀残留租约先由 `doctor --data-root ... --json` 只读确认；仅 owner PID 为 `missing`、用户确认无跨主机写者并用 `--confirm-stale-pid` 回显该 PID 时，`dsh-iris runtime recover` 才接管、写私有审计并释放。活跃/未知/损坏证据全部拒绝，DSH 不自动恢复。
- 默认间隔 2.5 秒，本轮最多观察 20 分钟；连续 5 次观察错误停止自动等待，保留远端受理与未知事实，不伪造远端失败。
- 启动扫描全部 Task 页，保守恢复 submitting、active、取消响应和交付中断窗口；仅接管仍有远端受理证据、且在自动窗口内的图片。旧无 binding Task 不猜测恢复配置。
- timer 使用 unref，随插件 Fiber 清理；在途观察收到取消信号，旧回调不能清掉同一 Task 的新观察器。停止本地观察不宣称已取消远端任务。

Headless CLI 使用同一控制面，但不自动循环：`task observe` 每次显式调用只 poll 一次，Provider 配置路径由 CLI 边界提供。

DSH 工作台现也开放同一份显式单步观察（D1 reobserve）：`POST /iris/api/core/task/:id/reobserve` 经 Command Service 命令 `task.reobserve`（与 `task.observe` 同实现），adapter/binding 恢复与 Host 观察节拍共用同一 resolver。用户任务区的 Core 投影行在服务端的行 DTO 标记 `observable`（已受理、有远端 ID、结果未定论、非终态）时显示「重新观察」按钮，点击后单次调用、禁用期间防重复，完成后复用刷新节拍重拉快照；高级诊断卡对符合同一受理事实门的任务提供同一动作。每次调用至多一次 poll，绝不 submit；终态、未受理、无远端 ID 或 binding 漂移的任务在网络与写入前被拒绝并返回稳定错误码。

人工控制面第二项 redeliver（D2）也已开放：`POST /iris/api/core/task/:id/redeliver` 与 CLI `task redeliver` 经 Command Service 命令 `task.redeliver`，只对 outcome=succeeded / deliveryState=failed 的 Task 开放——一次带 redelivery 标志的 re-poll 拿远端产物清单 → 下载 → 新 Artifact，绝不 submit、绝不重新生成、不新建 Attempt。行 DTO 在五类状态中的 `delivery_failed` 上标记 `redeliverable`，工作台相应投影行与高级诊断卡显示「重新取回作品」；成功即 ready 且门反转（再次调用被拒），下载失败回落 failed 可再次显式执行。

人工控制面第三项 cancel（D3）同样开放：`POST /iris/api/core/task/:id/cancel` 与 CLI `task cancel` 经 Command Service 命令 `task.cancel`，只对已受理、有远端 ID、未终态且未请求过取消的 Task 开放。结果只有三种，且**绝不伪造已取消**：① 供应商明确确认 → outcome=canceled、cancelState=remote_confirmed；② 供应商不支持远端取消（当前 DashScope 与 OpenAI Images 媒体协议均不提供经过验证的取消实现）→ 取消未发生，回落到可继续观察的真实状态（outcome 不变）；③ 超时或网络失败 → cancelState=unknown、保持非终态，可显式 reobserve 收敛。竞态下远端先沉淀的成功事实不得被取消覆盖；已请求过取消但未确认的任务拒绝再次取消。工作台按钮「取消任务」需要二次确认，五类用户状态保持不变，三种结果态在高级诊断的「取消状态」字段如实区分（已确认 / 已请求未确认 / 无请求）。

人工控制面最后一项 retry as new task（D4）也已开放，控制面四个动作全部收口：`POST /iris/api/core/task/:id/retry` 与 CLI `task retry` 经 Command Service 命令 `task.retry`。这是唯一产生新的真实计费的动作，三层都强制显式确认——CLI `--confirm-billing`、API 请求体 `confirmBilling:true`、UI 含重复计费警示的确认弹窗，缺一不进且在网络与创建之前拒绝。只对终态且未成功交付的 Task 开放（succeeded+ready 拒绝）。新 Task 有全新 id/attempts/binding，候选链按当前 assignments/池实况重新解析（旧 binding 可能正是失败原因），`model_ref`/`modelRef` 可显式指定；记录单向 `retriedFrom` 关系指向旧 Task，旧 Task 事实零变化，高级诊断以「重试来源」展示该关系。**Core 记录不持久化 Prompt**，生成指令必须由调用方重新提供（CLI `--input` / API `prompt` / 工作台弹窗重新输入），绝不从旧任务"恢复"——这是隐私设计，不是缺陷。同一请求网络重放的幂等键未实现：每次显式确认即一个新任务，属预期语义。

## 作品与只读诊断

工作台只有一个作品库：Core 图片与旧 outputs 作品一起显示，原始输入 Artifact 不进入作品视图。Core 媒体路由 `/iris/api/core/artifact/<artifact_id>/media` 没有独立 token：它按随机 96-bit Artifact ID 读取，每次验证 SHA-256，并由默认回环/显式 trusted Host 与浏览器 `Origin`/`Sec-Fetch-Site` 守卫拒绝明确跨站请求。Artifact ID 持有者在可达受信 Host 时即可读取；Host allowlist 不等于身份认证。Host URL 不写回 Core。

默认收起的“高级诊断 → Core 任务事实”展示同一批作品背后的 Task/Attempt，可展开、复制 ID 和打开图片，不是第二个作品库。`iris_task_status` 可查询同一 Core ID；CLI 指定同一 profile 数据根时可以 inspect/export，反向也成立。重复读取和附件投影不触发生成或修改 Core 事实。

工作台与泡泡的普通任务区现已消费同一快照的 `userTasks` 安全投影：Core 任务与旧版任务合并进同一个运行中/需要处理/历史分区，对外只呈现五类用户状态——`running`、`observation_paused`、`attention`、`delivery_failed`、`succeeded`。观察暂停的文案明确说明远端可能仍在运行，与“已明确失败”严格区分。卡片显示稳定 Task ID、模型、更新时间和关联作品链接；供应商身份、binding、错误原文与路径不进入普通任务区。投影是纯只读：刷新、展开、关闭与历史清理不会 poll、submit、删除或修复 Core 事实；完成提示在会话内只出现一次，刷新页面后从事实快照重新计算，不持久化提醒偏好。单条任务记录损坏或媒体文件丢失只触发局部降级（跳过该条、作品卡片显示占位），快照与其余条目照常可用。Core 的人工恢复四个动作 reobserve/redeliver/cancel/retry 已全部开放（见上节，CLI/API/UI 同一 Command Service）；需要处理条目在投影行或高级诊断中有对应动作入口，旧任务继续由 legacy 记录处理。

## 注意力处置（0.2.x 补丁）

Core 任务的提醒处置属于 **Host 偏好**（计划铁律：提醒已读/处置不修改远端事实字段）。偏好存 `$DSH_HOME/iris/v1/core-attention.json`（0600、tmp+rename 原子写、损坏降级为无偏好、只存 Task ID 与时间戳），**绝不写入 Core 数据根**；「移除」也只是本机隐藏，任务与产物记录完整保留，高级诊断标注"已隐藏"并可「恢复显示」，CLI 与 reader 照常可查。

工作台 attention 行（失败/取回失败/受理未知）提供「不再提醒」（受理后移出需要处理，历史区仍可见并可「恢复提醒」）与「移除」（本机隐藏，任务区/泡泡全部过滤）。泡泡计数与列表跟随过滤；泡泡亮度仍只由 Provider 健康决定。高级诊断（tasks.recent 全量记录）不受偏好影响，并新增「处置状态」展示 acknowledged/hidden/suppressed 三种口径。

已确认取消的任务仍保留 Core 事实投影 `outcome=canceled → userState=attention` 与原语义校验，但 DSH 安全投影额外标记 `historical:true`：工作台与泡泡将其放入历史，不计「需要处理」或角标，不显示注意力处置按钮。失败、受理未知、结果未知和交付失败仍照常进入 attention。

此外由事实派生的**自动静默**：若任务 X 处于 attention 且存在 `retriedFrom = X` 的后继任务已成功交付，X 自动静默（客户端连同手动处置一起过滤）；后继后续失败则静默撤销。该派生每次快照重算，不缓存、不落偏好——这正是 D 阶段 D4 关系字段的用户侧收益，也是计划 §4.D.5（提醒已读/处置属于 Host 偏好，不修改远端事实字段）的落地。

## 视频迁移（E 阶段第一项）

t2v/i2v 视频已迁到 Core，与图片共用 Task/Attempt 事实轴但**不共用图片状态机**：交付走冻结的视频 Profile（`lib/provider-task-runner.js` 的 `DELIVERY_PROFILES.video`：媒体白名单 `video/mp4`、Artifact kind `generated-video`、metadata 带 `capability`），观察用视频长轮询档（默认 6s/拍），受理、取消（当前真实协议不支持远端取消，not_supported 如实回落）、redeliver/retry 与 CLI/API/UI 控制面全部对视频生效。Agent 工具与工作台视频动作经 `submitCoreVideo` 落到 Core，**零 legacy 双写**（不再写 `tasks.json`/`outputs/`；旧视频任务继续 legacy 只读兼容）。同源媒体路由按 ID 播放 mp4；视频作品在任务区行内给出链接，不进入图片画廊网格。s2v 数字人（受理边界前需上传首帧与音频到临时存储）暂留 legacy 链路，后续单独迁移。真实 Provider 视频 canary 待验收。

## 语音合成迁移（E 阶段第二项）

TTS 是同步完成型，与视频的长轮询不同：一次 submit 内 completed，同一次调用直接交付为 Core Artifact（`DELIVERY_PROFILES.tts`：媒体白名单 `audio/mpeg`/`audio/wav`、kind `generated-audio`；remote-url 走下载，inline base64 直接物化）。Agent 工具 `iris_speak_text`、工作台语音动作与 CLI `run tts` 全部落到 Core，**零 legacy 双写**；同步完成即终态，observe/redeliver/cancel 对终态语音任务全部稳定拒绝，终态失败可用 retry 显式重试为新任务（输入为 `{text, voice?}`，候选链按实况解析）。语义差如实记录：legacy 是"单 Task 多 Attempt、每次尝试独立交付到 outputs/"，Core 是"单 Task 多 Attempt、一次 Artifact 交付"；候选链共用一个 voice（Core providerInput 静态）。同源媒体路由按 ID 播放音频。真实 Provider 语音 canary 待验收。

## 转写迁移（E 阶段第三项）

转写是上传型异步，Profile 独立：音频在 Host/CLI 边界上传到首选候选 Provider 的临时存储（`oss://` 签名地址只进 providerInput，**绝不落 Core 记录**），经受理边界提交后走 Core 长轮询（默认 2.5s/拍），远端成功后正文物化为 `text/plain` 的 `transcript` Artifact（adapter 在 poll 成功时把正文转为 inline-base64，不依赖签名 URL 生命周期）。CLI `run transcribe` 支持 `audio_url`（公网/oss:// 直达）或 `audio_path`（本地文件经同一上传通道）；Agent 工具与工作台转写动作切 Core，完成时结果直接附转写正文。**零 legacy 双写**，旧转写任务继续 legacy 只读兼容。取消沿用 not_supported 如实语义；retry 输入为 `audio_url`（Core 不持久化音频地址，必须由调用方重新提供）。已知边界：临时音频 URL 属于首选候选的账号，failover 到不同账号时该候选会如实失败。真实 Provider 转写 canary 待验收。

## 本地媒体原语

Core Command Service 已纳入两项确定性、零 Provider 的本地能力：`media.diff` 用 Sharp 生成指标与 `pixel-diff` 热力图 Artifact；`media.frames` 用本机 ffmpeg/ffprobe 返回视频元数据并生成 `video-frame` Artifact。两者均可读取宿主绝对路径；读取既有 Core Artifact 时分别写入 `derived-from` 或 `frame-of` 关系，Manifest 不保存宿主或临时路径。Headless CLI 的 `media diff` / `media frames` 直接消费同一 Command Service，不读取 Provider 配置、不发起网络请求。

依赖视觉模型或 Host Browser 的 `locate`、长图 OCR、媒体摘要和 HTML 渲染不进入这条本地命令链；它们留到中立 Text/Vision Port 冻结后再迁移，避免把网络模型或浏览器对象塞进 Core。

## 尚未迁移或开放

- s2v 数字人视频的 Core Command/Task 消费；
- 依赖 Text/Vision Model Port 或 Host Browser 的 locate、长图 OCR、媒体摘要与 HTML 渲染；
- 旧任务、旧作品 ID 与 Core ID 的显式映射；
- Core Task/Artifact 删除、清理、孤儿 purge 与完整作品分页（提醒处置和人工控制面 reobserve/redeliver/cancel/retry 已开放）；
- 真实 DSH 对话 attachment、浏览器进度/作品区和异步重启 canary。

旧作品重新索引、删除、清空和孤儿清理仍只操作 legacy `outputs/`；Core Task/Artifact 在 DSH 工作台和 Headless CLI 中都保持只读。Doctor 会报告 Core 孤立对象、未提交 Manifest 与未解析条目，但不会删除或修复它们。Core 删除与清理能力计划在 0.2.x 开放；不要手动移动或删除 `core-v0` 中的 object、Manifest、record 或租约文件。

## 验证证据与限制

- 完整离线回归为 96 个测试文件，lint 覆盖 151 个 JS/MJS 文件。同步、多产物、混合 failover、受理未知、交付失败、跨进程观察、零 legacy 双写、用户侧只读投影（五类真值表、零写入、局部降级、窄屏断言）与 D1 reobserve、D2 redeliver、D3 cancel、D4 retry（Command 门真值表零网络零写入、幂等矩阵、redelivery 标志、取消三分支如实语义与竞态防护、计费确认三层门、retriedFrom 关系与 prompt 零持久化、失败回落显式收敛、API 状态码/脱敏、CLI↔API 同一 Task 事实连续性、客户端投影门）均有 fixture；E 阶段视频、语音、转写迁移各有独立 conformance（视频长轮询多拍/mp4 Profile、语音同步双产物形态/音频 Profile、转写上传通道/文本物化 Profile）与 CLI/DSH 端到端 fixture。
- 2026-09-19 最新完整门禁为 113 个测试文件、lint 173 个 JS/MJS 文件；新增证据包括 T-09 七阶段时间戳与旧记录兼容，以及 T-12 本地 diff/抽帧 CLI、Artifact 关系和路径脱敏。上一条 96/151 为早期迁移阶段的历史计数。
- DSH 异步工具 fixture 实际执行注册后的工具，贯通 submit → poll → download → Core Artifact → attachment；另验证 active 崩溃接管、唯一 Attempt、端点漂移零 poll/零 Task 写入。
- Headless CLI 与真实 DSH action 已用百炼同步模型完成图片生成，Manifest、同源媒体和 CLI 导出 hash 一致。这些证据不包含真实异步 Provider 或会话附件。
- 最近一次真实对话验收在进入 Iris 前被 DSH 主模型的 429 限流阻断，未新增 Core Task/Artifact，也未调用媒体 Provider。未改动用户全局模型设置。
- 早期候选 tarball 已在仓库外、无 DSH 包的临时项目安装并完成 crop/inspect；后续新增代码仍需最终候选重新打包审计。Windows CI 和安卓浏览器目视未以离线测试替代。

## 接下来与候选门禁

Core 任务到工作台进度/提醒的只读安全投影已完成（五类状态、合并任务区、会话内一次性完成提示、损坏/缺媒体局部降级），人工控制面四个动作已全部开放（reobserve/redeliver/cancel/retry，CLI/API/UI 同一 Command Service，retry 三层强制计费确认）。接下来补真实会话附件、浏览器与异步重启证据，验证停止 DSH 后 CLI 仍可 inspect/observe/export。之后才按 0.2.0 计划推进旧 ID 映射与视频 → TTS/转写迁移。

发布前还需重新审计 tarball、无 DSH 安装闭包、Linux/Windows CI、0.1.4 数据不改写和实际 DSH 版本矩阵。未验证的宿主版本与 Provider 路径不得写成已支持；提交、推送和发布需另行授权。
