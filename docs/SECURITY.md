# Iris 安全边界与信任模型

本文说明 **Iris 0.3.1** 在信任模型、凭据隔离、计费防重提、媒体鉴权、Web/本地 API 以及插件扩展上的安全边界。发布状态与入口概览见 [README](../README.md)。

Iris 的核心安全目标是**防止凭据泄露、路径越权、跨站请求伪造，以及因网络异常或模糊状态导致的重复计费**。需要注意的是，Iris 与 DSH 属于本机单用户信任域内的工作区软件，不构成多租户安全边界，也不提供针对不受信任代码的安全沙箱。

## 信任模型

- **同机单用户信任域**：DSH 宿主、Iris 插件进程、独立 `web serve` / `api serve` 进程，以及 `$DSH_HOME` 和 Core 数据根均运行在同一操作系统用户下。
- **回环优先与同源校验**：
  - 独立 Core Web 工作台、Local API 与 HTTP MCP 固定仅监听 `127.0.0.1`，并强制校验 `Host`、`Origin` 与 `Sec-Fetch-Site`，不开放 CORS。
  - DSH 宿主工作台通过同源路由访问数据，默认仅接受回环 `Host`；显式设置 `IRIS_TRUSTED_HOSTS` 仅扩展 `Host` 白名单校验，**不是身份认证**。若通过局域网、反向代理或隧道暴露服务，必须由部署层额外部署 TLS（HTTPS）与访问认证。
- **可信本地插件与扩展**：通过 `--plugin-config`、`--provider-extension`、`--panel` 或公开 SDK 加载的插件属于受信任的本机代码。同进程 Node 模块拥有当前进程权限，同源 Web 模块拥有页面脚本权限（Shadow DOM 与 CSP 仅用于样式与静态资源边界隔离），请仅加载经过审查的可信代码。

## 凭据与配置隔离

### 供应商凭据管理

- **私有文件权限**：DSH 模式下供应商凭据保存在 `$DSH_HOME/iris/v1/providers.json`，独立 Core 模式保存在显式指定的私有 `--provider-config` 中。POSIX 系统上 Iris 创建的目录为 `0700`、文件为 `0600`（启动时会在不跟随符号链接的前提下收紧既有目录树权限）；Windows 下文件 mode 不能替代 ACL，依赖当前系统账户与目录权限。
- **三种凭据来源互斥**：
  1. **内联 Key（`apiKey`）**：保存在私有配置文件中，状态 API、工作台界面、SSE 与 Doctor 仅返回存在性或掩码提示，绝不回显明文。
  2. **环境变量引用（`apiKeyEnv`）**：配置文件仅保存环境变量名称（如 `IRIS_MEDIA_KEY`），由 Core/CLI 进程在调用时于内存中解析实际值，避免密钥进入配置文件或备份（详见 [供应商环境凭据引用](PROVIDER_CREDENTIALS.md)）。
  3. **DSH 宿主连接引用**：仅保存宿主连接标识，不在 Iris 配置中落盘密钥或通用 Base URL；仅在执行操作期间通过公开接口获取内存副本，且只发送到宿主提供的端点（详见 [DSH 连接复用](DSH_PROVIDER_CONNECTIONS.md)）。
- **全链路错误与目录脱敏**：Provider 错误映射在截断前会精确剥离当次请求已知的 API Key、Bearer Token、常见厂商密钥前缀、签名 URL 查询参数、调用栈与宿主私有绝对路径。若上游模型目录接口异常回显了认证密钥，Iris 会整份拒绝导入并报错（`IRIS_PROVIDER_DIRECTORY_CREDENTIALS`），防止密钥混入模型 ID。

### 三类访问凭据分离

工作台访问口令、MCP 连接凭据与供应商 API Key 分别存储、独立校验：
- **工作台访问口令**：保存在 Core 数据根之外的私有认证目录，使用异步 `scrypt` 与独立随机盐存储派生值；登录成功后仅向浏览器发放独立的会话 Bearer，不向浏览器存储写入明文口令、owner 控制令牌或 MCP 密钥（详见 [工作台访问口令](WORKBENCH_LOGIN.md)）。
- **MCP 连接凭据**：每条客户端连接拥有独立的连接 ID 与随机密钥，保存在根外私有连接目录中，支持按连接单独缩减权限、撤销或删除，不影响其他连接或工作台登录（详见 [连接契约](CORE_CONNECTIONS.md)）。

### 创作记录与健康元数据

- Core Task、Attempt 与 Artifact Manifest 仅保存内容 SHA-256、媒体类型、中性元数据与派生关系边，**不保存 Prompt、API Key、供应商端点原文或签名下载 URL**。
- 固定流程（Flow）的创作 Prompt 仅保存在专用数据根的私有 Run 输入区中，不进入公共 Task/Artifact DTO；备份 Flow 数据根时应按私人创作数据妥善保护。
- 健康快照与模型目录缓存保存在私有供应商配置中，仅记录模型、能力、时间戳、安全错误类别与连接摘要；当关键凭据、端点或协议变更时，旧成功证据会自动失效。

## 受理门与计费安全

为避免因网络抖动或状态不明造成重复扣费，Iris 在所有生成入口强制执行“写前落盘”与“受理边界”规则：

- **写前 Attempt 落盘**：任何可能产生计费的网络请求发出前，必须先将 `Attempt` 持久化到磁盘。
- **严格的自动故障转移（Failover）条件**：只有当供应商明确返回 `not_accepted`（如提交前校验拒绝、无歧义的客户端 4xx 拒绝，或发送业务请求前的代理连接预检失败）时，才允许自动切换到候选池中的下一个模型或备选出口。
- **未知状态停止重提**：一旦请求已发出但遇到 HTTP 500/502/503、网络超时、连接重置、响应正文中断或缺失远端任务 ID，受理状态即记为 `unknown`（或已 `accepted`），通用 Runner **立即停止自动重提**。Music 入口对明确的 HTTP 502 例外执行有限次新任务重发（`retry_502` **默认最多额外重试两次**，即未显式配置时最多共提交三次，**可能产生额外费用**；可设为 `0` 关闭，允许范围 `0–5`），同时保留原任务的未知事实（详见 [音乐生成](MUSIC.md)）。
- **观察、重新交付与知情重试分离**：
  - **重新观察（`task observe` / `reobserve`）**：仅对已受理的远端任务执行单次 `poll`，绝不调用 `submit`。
  - **重新交付（`task redeliver`）**：仅消费已成功生成的远端结果或本地 `delivery-cache/v0/` 私有同步缓存（见 [同步交付恢复](SYNC_DELIVERY_RECOVERY.md)），绝不重新生成。
  - **知情重试（`task retry`）**：唯一会创建新计费 Task 的控制面动作，强制要求显式确认（`--confirm-billing` / `confirmBilling: true`）并重新传入生成指令，同时通过单向 `retriedFrom` 记录重试谱系。
  - **真实取消语义**：在供应商未提供或未明确确认远端取消前，请求取消或点击“停止等待”仅中止本地等待（或记为 `cancelState=unknown` / `not_supported`），绝不伪造“远端已取消”或暗示已停止计费。

## 文件、上传与三类媒体鉴权边界

### 上传、路径与可恢复隔离

- **原子上传与大小控制**：浏览器上传采用大小限制、随机文件名、`.part` 临时文件与完成后的原子改名，中断时自动清理，过期文件按 TTL 回收。
- **路径隔离**：正常状态 API 与作品列表绝不暴露数据根路径。DSH 宿主内部上传接口与显式 `attachment_export` 按设计返回本机路径供宿主消费；而独立 Core Local API / MCP 的媒体导入与读取仅接受原始字节（或 Base64）与 Artifact ID，拒绝任何服务器本地路径或外部 URL。
- **符号链接防御**：私有目录权限收紧逻辑不跟随符号链接；`doctor` 会将作为符号链接的数据根直接判定为硬错误。
- **安全删除与隔离区**：Core 删除操作默认仅返回只读预览并检查活跃任务与 Flow 引用保护；显式确认后将文件移入可恢复的隔离事务区（`core.restore` 可校验哈希并还原，遇冲突不覆盖）。`delivery-cache/v0/` 可能包含签名 URL 或原始媒体字节，仅随任务隔离/恢复，不通过公共 API 暴露，切勿上传至公开 Issue。

### 区分 DSH 媒体路由与独立 Core API 媒体鉴权

Iris 中存在三套不同入口的媒体读取路由，其鉴权机制有本质区别：

| 媒体路由入口 | 路径形态 | 鉴权与访问控制机制 |
|---|---|---|
| **DSH Legacy 媒体路由** | `/iris/media/:taskId/:token/:name` | 依赖 URL 中的随机 **128-bit 能力令牌** + DSH 路由 `Host`/`Origin` 守卫。令牌应视为临时访问凭据，切勿公开分享。 |
| **DSH Core 媒体路由** | `/iris/api/core/artifact/<artifact_id>/media` | **没有独立 token**。以随机 **96-bit Artifact ID** 作为不可猜测的持有者标识，叠加默认回环 / `IRIS_TRUSTED_HOSTS` 校验、浏览器 `Origin`/`Sec-Fetch-Site` 跨站拒绝、`Cross-Origin-Resource-Policy: same-origin`、`Referrer-Policy: no-referrer` 与每次读取的 SHA-256 校验。**在可访问该受信任 DSH Host 的前提下，持有 Artifact ID 的客户端即可读取对应媒体。** |
| **独立 Core Local API / Web / MCP 媒体路由** | `/api/v0/artifacts/:id/...`、`/api/v0/runs/:id/download` 等 | **仅凭 Artifact ID 无法读取**。除仅绑定 `127.0.0.1` 与严格 `Host`/`Origin` 校验外，所有请求均须通过 `authorize(request)` 与 `requireArtifactCapability()`（见 `lib/local-api.js`）：<br>1. 必须提供有效的 `Authorization: Bearer <token>`（工作台登录会话、owner Token 或带连接身份头的 MCP 连接密钥）；<br>2. 若调用方为外部连接（非 owner），还必须同时具备 `read` 权限，且该 Artifact 所属的媒体流程分组（如 `image-edit`、`image-generate`、`tts`、`transcribe`、`video-generate`、`vision`、`ocr`）或插件业务已在连接中明确授权；连接撤销或缩权后立即拒绝访问。 |

## Web、渲染与 Skill 安装器

- **渲染隔离**：HTML 截图（`/iris/render` 与 `media.html`）在严格的离线 CSP 沙箱（`sandbox; default-src 'none'`）中执行，无法执行同源脚本或加载外部网络资源。
- **SSE 背压与清理**：DSH 状态推送（`/iris/api/state/events`）使用同源连接、节流与背压合并，客户端断开或插件卸载时立即退订事件总线并销毁流。
- **显式 Skill 安装器**：`dsh-iris skills install/uninstall` 仅在显式调用时修改目标目录，`status` 与 `--dry-run` 始终只读。安装器通过 `.iris-install.json` 校验文件归属与摘要，遇到用户本地修改、未知文件或符号链接时拒绝覆盖；升级与卸载会将原目录移至扫描根外的同级备份目录，不执行破坏性删除（详见 [Core Skills](CORE_SKILLS.md)）。

## 图像处理依赖与离线 Doctor

- **图像库安全基线**：Iris 要求 `sharp >= 0.35.5`（锁文件同步预编译依赖，以包含针对 [librsvg 高危漏洞 GHSA-wq5f-xc86-pv6w](https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w) 的修复）。公开图片导入仅接受静态 PNG/JPEG/WebP；若在部署环境中自行替换为系统级 `libvips`/`librsvg`，请单独核对系统库版本。
- **离线 Doctor**：`dsh-iris doctor` 不启动 DSH、不发起供应商请求、也不输出任何密钥。默认 DSH 模式会在数据目录执行一次即删的写入探针；显式 `--data-root <abs>` 模式则以纯只读方式校验 Core Task、Artifact、Index 与租约状态（不会自动释放租约或修复文件）。

## 报告安全问题

提交安全报告或求助 Issue 前，请务必移除 API Key、`Authorization` 请求头、完整的 `providers.json`、MCP 客户端导出文件、私有目录路径、媒体能力令牌以及包含签名的临时下载 URL。建议提供 Iris 与 Node.js 版本、操作系统平台、脱敏后的 `doctor --json` 输出、最小复现步骤以及是否涉及真实计费请求。
