# 独立本地 API 契约（0.3 / I4）

0.2.7 已实现 **I4A 默认只读**与 **I4B 显式本地创建**：显式本机监听、Bearer/Host/Origin、受控流程/媒体，以及主动启用的上传/创建与持久身份接回，见 [只读 API](LOCAL_API.md)和 [本地创建](LOCAL_CREATION.md)。未发布源码另实现 [有限执行服务](CORE_SERVICE.md)、[连接握手](CORE_CONNECTIONS.md)与 [owner 持久选择](LOCAL_SELECTION.md)。本契约尚未冻结为公开 SDK，只有上述 I4A/I4B 入口随 npm 0.2.7 分发。

已发布固定流程通过 [CLI](IMAGE_FLOW.md)执行，未发布源码另有上方 Core 服务；[独立 Web Demo](WEB_PROTOTYPE.md)只消费内存演示，保留到 0.3.0 阶段统一润色。Demo 尚未接入只读 API，也不作为完整服务或写操作已实现的依据。

未发布源码另有 [Core 工作台](LOCAL_WEB.md)，通过显式 `web serve` 同源提供固定静态资源并读取上述 API；登录页不包含私有数据，API/图片仍要求 Bearer。默认只读，创建、执行和选择 API 分别显式开启，不要求连接管理；页面媒体操作仍只读。npm 0.2.7 尚不含，不改变下方已发布 I4A/I4B 的能力边界。

源码另实现 [Operation 存储与版本门禁](LOCAL_OPERATIONS.md)，只在新专用根主动初始化；显式 `api serve --allow-execution` 装配 runner、持久接收/查询与本地停止，默认服务与页面媒体操作仍只读。v1 根复用零生成创建，写者拒绝损坏记录；具体执行与握手以服务指南为准。

## 1. 实例与启动

一个服务实例显式绑定一个已初始化的专用 Flow 根和一个 Application Runtime。Provider 配置来源可显式提供，省略时仍可查看已有流程/图片，启用本地写入后也可上传；模型列表返回未配置，不能创建新 Run。由用户主动启动，固定仅监听 `127.0.0.1`；首次不支持远程监听、代理转发或自动扫描 DSH 配置。CLI 的 `flow init` 仍负责初始化新根，浏览器不能指定根路径、初始化旧根或变更 Provider 配置。

API 使用 `/api/v0` 前缀，后续静态页面须与 API 同源。只有 HTTP 适配器负责验证外部输入、生成受控 DTO 和管理请求；不得把 `application.execute(name, input)`、现有 DSH `serveApi` 或 CLI 参数作为通用 HTTP 转发口。模型来自显式配置中允许改图的候选，Flow 继续绑定单一明确模型与 `n=1`。

I4B 的上传与 Run 创建均不生成，完成本地提交后返回 201，同 Key 接回返回 200。`api init` 先在空的已初始化 Flow 根建立请求区，`api serve --allow-local-writes` 才开放这两个 POST，不自动转换已有创作根。默认启动仍只读。

## 2. 身份与浏览器边界

- 每次启动产生 32 字节随机会话 Token，CLI 通过必填 `--token-file` 写入新的根外私有文件（POSIX 0600），不打印 Token。服务鉴权使用 Token 摘要和等时比较；调用进程读取私有文件，以 `Authorization: Bearer …` 发送，不进入 URL、命令行参数、Run、日志或错误文本。未来浏览器只在标签页内存保留 Token；页面重新连接不开始生成。首版文件交付替代最初的终端显示提案，支持自动化且避免管道日志收集 Token。
- **所有 API，包括模型列表、状态与媒体，都验证身份**；Token 比较使用等时比较。首版不使用 Cookie，也不建立“同源就已认证”的假设。退出页面丢弃客户端 Token；停机使该进程 Token 失效。
- `Host` 必须精确匹配实际监听 authority。带 `Origin` 的请求仅允许该页面精确 origin；`Origin: null`、外站 origin 和不匹配 Host 拒绝，不采信 `Forwarded` 或 `X-Forwarded-*`。无 Origin 的本机 CLI 请求仍须通过 Host 与 Token 检查。不同 origin 的 OPTIONS 不开放 CORS。
- 当前 API 响应使用限制性 CSP。未来页面的脚本/样式只从本站加载，无内联脚本、第三方资源、对象、框架嵌入或表单提交；用户内容用文本节点展示，媒体通过带认证的 fetch 获取 Blob 后展示/下载，不将 Token 放入 `<img>` URL。
- JSON、状态、媒体和错误响应使用 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`；API 不重定向到 Provider URL。首切片仅为意外服务错误记录净化调用帧与关联 ID。若增加访问日志，只记录方法、固定路由类型、状态、随机关联 ID 与耗时，不记录 Authorization、正文、查询参数或绝对路径。

Bearer、Host/Origin 与 CSP 是不同边界，不能相互替代。静态预览器没有凭据或 Core 权限，它的验证不等于这里的认证验收。

## 3. 有限路由

下列 GET/HEAD 已有实现，Operation 路由需未发布的显式执行模式；I4B 只含 images/runs 两个 POST，执行模式另含 continue/cancel，selection 需独立 `--allow-selection` 且仅限 owner。JSON 响应含 `contractVersion: 0`；列表最多 30 项，摘要不含 Prompt；创建 JSON 上限 64 KiB，执行/选择/连接 JSON 上限 8 KiB。未知/重复查询参数和带正文的只读请求拒绝。

| 方法与路径 | 输入 | 语义 |
|---|---|---|
| `GET /session` | 无 | 返回实例标识、契约版本、允许的操作与输入上限；不返回根路径、Key 或端点 |
| `GET /models` | 无 | 返回当前可选的 `modelRef`、显示名和是否支持改图；不会探测 Provider、同步目录或修改用途 |
| `POST /images`（I4B） | 原始 PNG/JPEG/WebP 字节、匹配的 Content-Type、Idempotency-Key | 本地提交后返回 201 和 Artifact 引用，同 Key 接回返回 200；不接受文件路径、URL、目录或 SVG |
| `GET /runs` | `cursor`、`limit`，limit 1–30 | 已有流程摘要，不含 Prompt；只读，不观察远端 |
| `POST /runs`（I4B） | `{sourceArtifactId, modelRef, prompt, size?}`、Idempotency-Key | 固定 `image-edit/v0` / `n=1`，只保存输入与身份，零生成请求；本地提交后 201，同 Key 接回 200 |
| `GET /runs/:id` | 无 | 返回下述 FlowView；只读，不创建 Task、补交付或继续步骤 |
| `POST /runs/:id/continue`（未发布执行模式） | `{expectedRevision}`、Idempotency-Key | 持久接收后 202，同 Key 200；一次首次提交/观察/补交付/比较，不重提已有 Attempt |
| `POST /runs/:id/selection`（未发布选择模式） | `{artifactId, expectedRevision}` | 仅 owner；同 writer 核对版本并保存原图/结果选择，返回 200；过期版本 409，不触发生成或下载 |
| `GET /artifacts/:id/content` | 无 | 按已验证 Artifact ID 和清单读取该根内媒体字节，不接受 path/URL 参数；不写文件 |
| `GET /runs/:id/download` | 无 | 返回已选择图片的原字节及受控附件名；未选择则冲突，不接受服务器输出路径 |
| `GET /operations/:id`（未发布执行模式） | 无 | 查询持久状态，不能借此继续操作；原 Key 查询和 Run 列表见服务指南 |
| `POST /operations/:id/cancel`（未发布执行模式） | 空 JSON | 原 ID 幂等停止本地排队/等待，终态落盘后 200；不代表远端已取消或已退款 |

上传累积读取限制使用现有 `MAX_IMPORT_IMAGE_BYTES = 20 MiB`，不能只相信 Content-Length；最终交给 `readImportImage({imageBytes}, signal)` 检查实际格式和静态图片要求。连接关闭、超量与解析失败不留下临时可服务文件，不把 filename 当服务器路径。并发上传上限 1，超过返回忙；用户显式重试复用原 Key。

上传复用现有图片验证与 Artifact 预留 ID 提交；请求与作品在同一次 writer 内保存。当前图片读取/下载仍限 64 MiB，类型 PNG/JPEG/WebP，先检查清单大小再校验内容哈希，最多两个活动读取。大型媒体磁盘流式、Range 和音视频仍待后续。下载不调用服务器本地 `flow.export(output_path)`；浏览器是否保存成功不属于持久 Run 事实。

## 4. FlowView 与操作反馈

浏览器只消费白名单投影，不直接接收磁盘 Run、完整 Task、Attempt、Provider 错误对象或配置。完整详情是用户创作数据，需要认证；摘要不包含 Prompt。

```text
FlowView {
  contractVersion: 0,
  id, recipe: "image-edit/v0", revision, createdAt, updatedAt,
  status: not_started | running | needs_attention | delivery_failed |
          needs_comparison | awaiting_selection | selected,
  input: { prompt, modelRef, size? },
  source: { artifactId },
  output: { artifactId } | null,
  comparison: { artifactId } | null,
  selection: { artifactId } | null,
  task: { id, acceptance, outcome, deliveryState, attemptCount } | null,
  metrics: { ratio, diffPixels, totalPixels, width, height } | null
}
```

ID 继续使用当前 `run_` / `task_` / `artifact_` 加 24 位小写十六进制。DTO 不带绝对路径、端点、绑定摘要、远端任务 ID 或任意媒体 URL。媒体信息如格式/尺寸应由独立受控投影提供，不信任用户文件名。`metrics` 仅来自实际已提交比较作品；像素差异不是质量评分。

| `status` | 首要操作与文案边界 |
|---|---|
| `not_started` | “开始生成”；可能产生费用，输入已经固定 |
| `running` | “查看原任务”；每次显式操作至多观察一次，页面不自行调用 continue |
| `needs_attention` | 显示受理未知/失败/取消等事实；无自动重提。需要新生成时明确新建 Run |
| `delivery_failed` | “恢复结果”；生成已经成功，恢复原缓存/远端结果，不新生成 |
| `needs_comparison` | “完成比较”；执行本地步骤，不新生成 |
| `awaiting_selection` | 选择原图或新版；下载仍禁用 |
| `selected` | 可下载；不能据此声称文件已经保存到用户设备 |

I4B 的上传与创建同步完成本地提交，以 201/200 返回 Artifact/FlowView 和 `idempotentReplay`，不返回持久排队的 202，也不开放 Operation 查询或取消。相同 Key 保证原业务身份与效果；已有 Run 的返回状态可以随真实进度变化，不承诺重放完全相同的响应字节。

未发布执行模式在原子接收后返回 `202 {contractVersion:0, operation, idempotentReplay:false}`；重放返回 200，状态为 `queued | running | succeeded | failed | canceled | interrupted`。GET 不驱动 Provider；每次显式继续至多一次观察。单根最多 8 条 queued/running，同 Run 最多一条；writer 忙时拒绝新接收，不声称已排队。停止直接中止控制器，随后在同 writer 下落盘并返回 200；不伪造远端 Task canceled。此模式不随 I4B 或只读 Web 自动开启。

## 5. 上传与持久创建幂等（I4B）

I2 保证相同 Run 使用原 Task；I4B 另保证同 Key 创建请求接回原 Artifact/Run。前端禁用按钮、内存 Map 和“成功后才写 Key → Run 映射”不能代替持久意图。

新空专用根使用 `creation-requests/v0/root.json` 和 `requests/req_<64 hex>.json`，没有数据库或已有创作根迁移；现有 Task/Artifact/Run 格式保持。具体约定为：

1. 客户端每次明确动作使用一个不带引号的小写 UUIDv4 `Idempotency-Key`。请求区保存稳定 rootId；命名空间按 rootId、操作种类和 Key 计算 SHA256，**不使用随重启变化的服务 instanceId、Token、端口或本机路径**。原始 Key 不持久保存或记录。
2. 输入摘要来自规范化内容：图片的真实字节摘要、大小与 Content-Type；Run 的来源 ID、模型引用、规范化 Prompt/size、固定 recipe/n。对象键序不影响摘要，不额外改写正文。同 Key 不同内容 409；已发布意图不因模型池或端点变化另选身份。
3. 同一个 operation-owned Core writer 内，先校验新输入并**排他发布 prepared 意图与全部预留身份**，再提交 Artifact/Run，最后原子更新 succeeded。不能通过两个独立 writer 或“先创建后补 Key 映射”实现。创建 Run 需内部受控的预留 Run/Task/比较作品 ID，浏览器不能指定它们。
4. 已存在的 Run 按原始输入、来源/binding、创建时间和预留身份核对；允许后续 revision、输出或选择已经推进，返回当前事实，绝不覆盖回初始状态。图片复用现有 Artifact 重入提交及内容校验；未完成上传不另存原件，需客户端同 Key 重新提供相同字节。
5. 意图发布前的验证失败、busy 或排队取消不消费 Key；发布后的断线不撤销已经接受的本地提交。启动、GET 和刷新不自动修复/重放；显式同 Key POST 才核对或补完。存储损坏或身份冲突保留现场，不能回退成随机新建；不永久缓存通用 500 并把原对象藏起来。
6. prepared 引用保护包括预留上传对象、Flow 来源/Task/比较身份；succeeded 保留请求身份和原结果 ID，但不额外禁止显式删除未使用的上传，真实 Run/Task 引用仍保护。成功目标不可用时，同 Key 返回 `409 IRIS_API_RESULT_UNAVAILABLE`，不复活作品或重建 Run。损坏/未知请求阻止误清理，不能当作空引用；首版没有请求删除、TTL 或自动 GC，权限沿用私有约定。
7. 新版 writer 和维护入口必须识别请求格式，未知/半初始化请求区拒绝写入。已发布旧程序没有这些新检查，不能靠一个标记保证其拒绝该根；此专用根只支持已验收的 request-aware writer，回退使用完整副本，不删除请求区伪装降级。已提交 Flow/图片仍可只读查看。
8. 复用现有原子发布和重入能力，验证范围限进程异常退出/SIGKILL；不据此承诺断电、操作系统崩溃或共享存储下的跨文件事务。请求区本身不触发 Provider 目录刷新、探测、生成或任务观察。

未发布 continue/Operation 使用独立 runner 与持久身份，显式启动只记录遗留中断，**不能自动重放 continue**。I4B 创建证据与执行验收分开；Web 的连接管理写入见 [连接契约](CORE_CONNECTIONS.md)。选择复用 Run 原子提交：当前版本的同目标选择不重写，旧版本即使目标相同也冲突；没有持久 Key/选择收据，响应丢失先 GET 核对，见 [持久选择](LOCAL_SELECTION.md)。页面创作按钮与创建恢复仍待接入。

## 6. 错误与验收

统一错误外形为 `{contractVersion:0, error:{code, message, requestId}}`，不附堆栈、配置或 Provider 原始响应。网络错误只返回已脱敏的有限分类；取消/断线不把未知改写为失败未计费。

| HTTP | 类别 |
|---|---|
| 400 / 413 / 415 | 输入无效、正文过大、图片格式不支持 |
| 401 / 403 | 身份无效、Host/Origin 不可信 |
| 404 | 合法 ID 在该实例不存在 |
| 409 | Key 输入冲突、原任务状态冲突、根被占用、同一 Run 操作活跃、尚未选择 |
| 429 | 有界队列/上传已满，显式重试可复用原 Key |
| 503 | 正在关闭；不再接收新写操作 |
| 500 | 无法分类的内部错误，保留服务端关联证据并停止相应操作，不静默回退 |

I4 必须实际验证：错误 Token/Host/Origin、媒体绕过、超量流式上传/损坏图片/路径参数、双击/不同 Key 并发、同 Key 响应丢失/重启、未知受理不重提、只读重连、取消时序、停机与租约释放。之后才让 [Web 原型](WEB_PROTOTYPE.md)换成真实传输并验收无 DSH 的端到端路径。本稿和静态预览不等于第二个生产 Host 已完成。
