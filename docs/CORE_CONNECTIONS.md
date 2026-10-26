# Core 连接与能力握手 v0（未发布）

该契约服务于 [Core 执行服务与 harness 桥](CORE_SERVICE.md)，不是公开 JavaScript SDK。连接配置均为显式根外私有 JSON，不扫描宿主账号、配置或进程。

通用 MCP 的 stdio/HTTP、配置导出与功能覆盖见 [MCP 指南](MCP.md)。MCP 新连接默认 generic；无需为不同产品注册身份种类。

## 身份与授权

| 字段 | 含义 |
|---|---|
| adapterId | 适配实现，如 `iris.mcp`、`iris.dsh-service` |
| harnessKind | 获授权的产品类别：`kimi`、`dsh` 或 `generic`；不是认证依据 |
| rootId | v1 数据空间 UUID，授权与客户端均绑定它，不使用本机路径作跨端身份 |
| connectionId | 一项明确授权的 profile/工作区连接 UUID |
| runtimeInstanceId | 本次客户端实例 UUID；同一连接最多保留 8 项实例事实 |
| Operation ownerInstanceId | Core 执行进程归属，与调用者身份分开 |

`connection create` 只创建新私有目录及 `server-grants.json`、`client.json`。服务文件为 `{schemaVersion:0,grants:[...]}`；每项包含 rootId、connectionId、adapterId、harnessKind、label、accessToken、scopes，以及明确 capabilities/tools。客户端包含 schemaVersion、origin、rootId 和相同身份/凭据及所选 capabilities/tools；服务端授权仍由 grants 决定，修改客户端文件不能扩大范围。origin 固定为 `http://127.0.0.1:port`，不允许凭据、路径、跳转或远端域名。

capabilities 为当前支持的功能分组列表（image-edit、image-generate），空列表只保留控制工具；tools 可进一步选择具体工具，空列表为零工具。两者与操作 scopes 分开。新授权持久写入具体名单，不因版本新增工具自动扩张。旧文件省略两项时仅解释为固定的旧图片编辑流程/12 工具，不迁移文件；显式 null、未知和重复项拒绝。

文件为 0600，目录为 0700；读取拒绝符号链接、非普通文件、过大文件及 POSIX 过宽文件权限。Windows mode 不能替代 ACL。凭据不出现在 URL、普通 DTO 或诊断中。运行时认证表仅保留比较用摘要，私有持久档案保留连接密钥；scope 为有限的 `read/create/execute/stop`，必须含 read。静态 grants 只在显式启动时读取，修改静态授权后须重启；下面的管理目录支持显式 owner 即时更改，不自动修改日常 harness 配置。

这是同一用户明确共享的数据空间，read 可读根内流程，execute/stop 可作用于该空间的流程/操作；它不是按连接划分的数据租户隔离。需要分隔作品时使用不同数据空间与授权。

## 握手与调用

连接请求带 `Authorization: Bearer …`、`Iris-Connection-Id` 和 `Iris-Runtime-Id`；仍执行原 Host/Origin 门禁。服务 owner 的短期 Token 与持久连接凭据分开。

POST `/api/v0/connections/:connectionId/handshake` 接受以下必填字段；还可提供 requestedCapabilities/requestedTools 明确缩小功能/工具范围：

```json
{
  "contractVersion": 0,
  "adapterId": "iris.mcp",
  "harnessKind": "kimi",
  "runtimeInstanceId": "00000000-0000-4000-8000-000000000001",
  "harnessVersion": "declared bridge or harness version",
  "requestedScopes": ["read"]
}
```

身份必须匹配授权；协议不支持或请求了未授权/服务未开启的能力时拒绝，不静默扩大或回落。响应包含契约版本、rootId、连接身份、实例、协商 scopes 和 `remoteHostPorts: []`。连接客户端检查数据空间与实例一致；只按协商权限注册工具。浏览器、视觉、附件和会话控制不因一次握手就被视为反向可调用。

响应 instance 另含 capabilities/tools，Core 在每条对应业务 API 上同时检查工具范围；session.operations 也按此过滤。HTTP `/mcp` 使用标准 Bearer 即可，内部身份与实例头由服务桥负责；只接受 iris.mcp 授权，owner 临时 Token 和原生 DSH 授权不替代它。每项 HTTP 授权持有一个逻辑桥实例；客户端品牌不是认证依据。

`GET /api/v0/session` 只列该调用者可用操作。`GET /api/v0/adapters` 列出随 Iris 提供的适配描述；不代表目标 harness 已安装。`GET /api/v0/connections` 对 owner 列全部授权，对连接只列自身；不返回 secret。

实例事实包括最后握手/请求时间、声明版本、协商 scopes、`verification: handshake` 与 `liveness: not_probed`。connected 只表示本次服务中的逻辑会话已握手且未明确断开，**不证明进程在线或模型已实测**。当前不做进程扫描或心跳探测。服务重启后须重新握手，GET 不自动接入或写业务数据。

POST `/api/v0/connections/:id/disconnect`：连接端提交 `{}`，断开自身实例；owner 提交 `{runtimeInstanceId}` 可明确断开指定旧实例。断开只撤销本次会话，不取消持久 Operation、不删除作品、不重启 harness。新实例接入可替换最早已断开的内存记录；全部 8 项仍有效时拒绝新增，由 owner 明确处理。实例事实只在服务内存保留；管理档案单独保存最近客户端声明，不作为完整历史审计日志。

## Owner 连接中心

`api/web serve --allow-connection-management --connection-store /absolute/private-directory` 显式开启；页面操作见 [本地工作台](LOCAL_WEB.md#显式开启连接中心)。同一服务可合并只读静态 grants 和可管理档案，活动授权总计最多 32 项。默认不开启，不扫描品牌、进程或文件系统寻找 harness。

管理目录含 `store.json`（schemaVersion/rootId）、`profiles/<connectionId>.json`（单档案权威记录）、`clients/<content-sha256>.json`（不可变导出副本）、`templates/<content-sha256>.json`（纯数据模板）和 `ownership/`（复用 Core 租约）。目录与业务根不可相互包含，现有非空未知目录或异根/异版本均拒绝，不迁移。档案含标签、明确授权、revision、创建/更新/撤销时间、创建输入摘要与最近客户端声明；原子单记录提交后同步变更认证表。崩溃留下未知文件时保留并拒绝启动，不自动删除或猜测修复。

以下路径均以 `/api/v0/connection-management` 开头，只接受本次服务的 owner Token。连接凭据即使有 execute 也无权管理：

| 路由 | 输入 / 行为 |
|---|---|
| GET/HEAD `/catalog` | 本服务可授予的 scopes、媒体/功能/工具目录及模板示例；未接入项明确列空 |
| GET/HEAD `/templates` | 已导入的纯数据模板及内容摘要身份，无凭据 |
| POST `/templates` | `{schemaVersion:0,title,transport,format,documentationUrl?}`；相同内容幂等，首次 201、重放 200 |
| GET/HEAD `/connections` | 管理/静态档案及当前实例，无凭据；撤销档案仍保留 |
| POST `/connections` | `{key,label,scopes,capabilities,tools?}`；key 为 UUIDv4，成为 connectionId。首次 201，同 Key/输入 200，不新造密钥；不同输入 409 |
| POST `/connections/:id/update` | `{expectedRevision,label,scopes,capabilities,tools?}`，CAS 更新；只允许服务已开启的权限 |
| POST `/connections/:id/revoke` | `{expectedRevision}`，持久撤销并阻止后续认证；重放不复活或重提 Operation |
| POST `/connections/:id/export` | `{transport:stdio/http,format:mcpServers/entry}` 或 `{templateId}`，两者不可混用；HTTP 含密钥，要求服务已开启 MCP |
| POST `/connections/:id/skill` | `{}`，按已保存授权与当前服务权限交集返回公开 Skill 交付 JSON 和 Markdown 预览；撤销或零工具拒绝 |

正文上限 8 KiB，未知字段拒绝。创建/编辑/导出不调用 Provider；授权变化清除旧握手，HTTP 工厂按新名单重建，stdio 旧进程的实际 API 调用仍受 Core 新授权检查。标签修改保留实例。已接收操作不会因撤销而伪造 canceled 或退款。导出文件按内容身份排他创建，旧副本或外部修改不被覆盖；外部修改档案也明确拒绝覆盖，需停服核对。

模板只允许标题（最多 80 字符）、`stdio/http`、`mcpServers/entry` 和无认证信息的 HTTPS 文档地址。内容寻址、最多 64 项，同一管理租约保护；重启校验内容与文件名，不覆盖漂移文件。新内容产生新模板，不编辑或自动删除旧模板；手动选择始终可用。模板不接受命令、环境变量、端点、权限、密钥或外部脚本，不扫描/启动客户端，也不自动打开文档。

Skill 交付文件为 `schemaVersion:0,kind:iris-mcp-skill` 的公开快照，含 rootId、connectionId、revision、label、scopes、capabilities 和当前有效 tools；不含密钥或本机私有路径。它是安装器的有限数据输入，不接受外部 Markdown/文件树。包内渲染器生成 `iris-mcp-<connectionId>/SKILL.md`，英文正文附中文标题，只指导实际开放的工具，不回落到 CLI 绕过授权。配置导出与 Skill 均考虑当前服务权限；服务改成只读后不会继续导出 execute scopes。快照不会自动更新或撤销文件，实际权限仍由 Core 每次检查。安装与保护规则见 [连接专属 Skill](CORE_SKILLS.md#连接专属-mcp-skill未发布)。

MCP 桥从官方 SDK 获取客户端 name/version/title，经有界投影，通过 POST `/api/v0/connections/:id/client-info` 记录 `{clientInfo,transport}`。握手响应的 `connectionFeatures:['client-info']` 协商此可选扩展；旧服务缺少该能力时桥不提交声明。元数据必须属于已握手实例，来源标记 `client-declared`，不授予 scopes 或改变 adapterId。首次、身份变化及至少一分钟间隔的后续请求记录最近声明；没有声明保持 null。共享 HTTP 凭据依然只代表一个逻辑桥，不推断真实进程数。

## 故障语义

- Token/连接不匹配返回 401，未授权能力返回 403，未握手/版本冲突返回 409，实例容量返回 429。
- Core 客户端不自动重试写请求、不转投其他端口/本地运行时；响应丢失先查原 Key。
- 连接失效不改变原 Operation 的业务身份和计费事实。停止是单独的显式本地动作，远端取消未接入此协议。
- 断开确认失败时，本地桥仍可释放自身资源，并报告 `remoteDisconnect: unconfirmed`；不把网络失败解释为远端会话/Task 已停止。

本轮契约覆盖有限 HTTP/stdio 接入，尚无任意插件加载、远程端口代理、账户登录代理、自动 harness 安装或整个 Agent 会话控制。
