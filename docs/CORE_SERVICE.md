# Core 服务与 harness 接入（0.3 alpha）

0.3.0-alpha.1提供单根执行服务、连接授权/握手、正式 MCP stdio/Streamable HTTP、DSH 可选共享 Flow 连接与 [owner 持久选择 API](LOCAL_SELECTION.md)。**稳定 npm 0.2.7 不包含这些入口**；以下使用源码命令，安装alpha包后可将 `node bin/dsh-iris.js` 换为 `npx dsh-iris`。支持固定 `image-edit/v0`，显式新 v2 根另提供 [image-generate/v0 与 ComfyUI](IMAGE_GENERATION.md)，新 v3 根另提供 [speech/v0 与 transcribe/v0](AUDIO_FLOWS.md)，同时保留图片流程。[Web](LOCAL_WEB.md)按显式权限接入创作、观察、停止和选择，默认只读；服务器路径导出仍用 CLI，页面下载原字节。通用配置导出、用户能力/工具选择与功能覆盖见 [MCP 指南](MCP.md)。

## 显式启动

需要额外媒体协议时，可用重复的 `--provider-extension /absolute/entry.mjs` 在服务进程中显式加载可信扩展。注册实例随服务生命周期管理，启动本身不提交模型请求；harness 仍使用同一 Core 和原授权。见 [Provider 扩展](PROVIDER_EXTENSIONS.md)，不属于公开 npm 0.2.7。

先准备新的专用根与已有的显式 Provider 配置，不迁移 DSH 或 v0 历史根：

```bash
node bin/dsh-iris.js flow init --data-root /absolute/new-core
node bin/dsh-iris.js execution init --data-root /absolute/new-core
node bin/dsh-iris.js connection create --data-root /absolute/new-core \
  --directory /absolute/new-mcp-pair --origin http://127.0.0.1:3182 \
  --label my-client --scopes read,create,execute,stop --capabilities image-edit
node bin/dsh-iris.js api serve --data-root /absolute/new-core \
  --provider-config /absolute/providers.json --port 3182 \
  --token-file /absolute/new-owner-token.txt --allow-execution \
  --connections-file /absolute/new-mcp-pair/server-grants.json
```

`--allow-execution` 同时开启零生成上传/创建与有限执行；不传时保持既有默认只读行为。服务需要已初始化的 v1/v2/v3 执行根和有效的显式配置。配置静态校验、启动和连接握手不调用模型。每次明确继续至多调用一次 `flow.continue`：首次提交或检查/补交付原 Task，不持续轮询，不重提已有 Attempt。

第二个执行 Host 无法取得同根 runner 租约；同根可另开只读页面。接收后服务自行收尾，关页或断开 harness 不撤销已接收操作。writer 正忙时明确拒绝新接收，调用方保留原 Key 后显式重试，不能假定已排队。

也可使用 [连接中心](LOCAL_WEB.md#显式开启连接中心)在同一服务中提供页面、持久授权和 MCP。必须同时指定 `--allow-connection-management --connection-store`；需要执行时再显式添加 `--allow-execution --provider-config`，不会自动开启生成。默认 `web serve` 继续只读。连接管理目录单独持有租约，业务写入仍由这一个 Core runner 管理。

媒体 API 的创建、执行和选择开关不依赖连接管理；`--allow-selection` 只允许 owner 在同 writer 中核对 Run 版本后保存选择，不启动 runner 或调用 Provider。执行开关不隐式开放选择，也不扩张 MCP 工具集。

## 接收、查询与停止

仍使用回环 HTTP、Bearer、Host/Origin 校验；连接端还需身份/实例头与已协商权限，详见 [连接契约](CORE_CONNECTIONS.md)。以下路由仅在显式执行模式开放：

| 路由 | 输入 | 行为 |
|---|---|---|
| POST `/api/v0/runs/:id/continue` | `Idempotency-Key` UUIDv4，JSON `{expectedRevision}` | 完整 Operation 持久提交后返回 202；同 Key/输入返回 200 与原记录 |
| GET `/api/v0/operations/:id` | 原 ID | 读取持久投影，不联系 Provider |
| GET `/api/v0/operations?key=…` | 原 Key | 丢失响应后接回，不执行 |
| GET `/api/v0/runs/:id/operations` | `limit` 1–30、`cursor` | 有界原操作列表 |
| POST `/api/v0/operations/:id/cancel` | JSON `{}` | 先中止本地等待，待终态落盘后返回 200；重复原 ID 接回现有终态 |

停止不另消费一个请求 Key，也不返回尚未持久化的取消 202。响应丢失时查询原 Operation。`localStopped` 只证明本地操作已停止，`remoteCancellation: not_requested` 表示没有请求远端取消；保留 Task 受理、结果和已交付作品。Operation succeeded 表示该次有限调用返回，作品是否完成仍看 Run/Task。

queued/running 不因 GET 或 MCP 重连而执行。显式启动服务取得 runner 所有权和 writer 后，将遗留活动记录标记 interrupted，原 Key 仍接回它。用户确认后用新 Key、当前 Run revision 继续原流程；原 Task 有 Attempt 时只检查/交付原任务，受理未知不能自动再生成。

正常退出先本地中止并落盘，再释放租约。强杀后分别检查 runner 与业务 writer；需要回显实际 stale PID 才能恢复：

```bash
node bin/dsh-iris.js execution inspect --data-root /absolute/new-core
node bin/dsh-iris.js execution recover-lease --data-root /absolute/new-core --confirm-stale-pid 12345
```

若业务 writer 也遗留，先用 `doctor --data-root /absolute/new-core --json` 核对，再用 `runtime recover --data-root /absolute/new-core --confirm-stale-pid 实际PID` 显式恢复它；不自动清锁、删除记录或抢活跃进程。PID 活跃、未知或证据损坏均拒绝恢复。原子提交/强杀验证不等于断电、Windows ACL 或共享存储耐久保证。

## 正式 MCP

Core与桥分别管理生命周期：Core由用户明确启动，harness拥有stdio桥进程，HTTP网关复用同一Core。桥关闭先阻止新请求、取消本地网络等待并收尾初始化，不停止Core或撤销已受理Operation。SDK初始化、握手和关闭并发时保持终态；重复dispose共享结果，HTTP授权失效时释放原桥实例。检查命令与客户端预设见[MCP首次接入](MCP.md#首次接入与客户端预设)。

本地服务启动失败或关闭时，会依次尝试释放HTTP、MCP、runner、应用与连接/Provider资源；某一步失败仍继续释放其余资源，再聚合报告具体阶段。snapshot的cleanupFailed表示释放失败，不能当成完全成功；不自动清锁或再次启动服务。

Core 服务保持运行，在 harness 内配置下面的命令及参数：

```bash
node /absolute/iris/bin/dsh-iris.js mcp serve \
  --connection-file /absolute/new-mcp-pair/client.json \
  --scopes read,create,execute,stop
```

不指定 scopes 时只请求 `read`。这是随候选 npm 包分发的正式 stdio 入口：使用官方 `@modelcontextprotocol/server` SDK 处理协议与 schema，薄桥仅调用同一个已授权 Core 服务，不另起业务写者、不经 Bash 转调 CLI。stdout 只写 MCP 消息，连接凭据只在私有文件与 HTTP 头中出现。

原 image-edit 工具契约为 `iris_core_connection/models/runs/run/import_image/create_run/continue/operation/lookup/stop/image/connections`，完整授权为 12 项，只读为 8 项。image-generate 另提供 `iris_core_create_generation`；只选文生图完整为 11 项，两组同时选择为 13 项，旧授权不扩张。参数是真实 Run、revision、请求 UUID、模型、Prompt、图片字节与作品 ID；不会替换成固定提示词。图片读取返回原 MIME/Base64 字节，不生成缩略图冒充原图。inline 导入 Base64 最多 8 MiB 字符，Core 图片读取上限仍为 64 MiB。

MCP 调用取消或 EOF 只结束桥的本地请求；已经接收的 Operation 仍归 Core，重连按原 Key 查询。服务重启需显式 `iris_core_connection` 再握手；不会自动重试写调用。普通 EOF 断开连接，Core 离线时桥可关闭自身并记录远端断开未确认，不声称取消 Task。

采用官方 SDK 2.3.1 / Core 2.3.1（Apache-2.0）和 Zod 4.6.7（MIT），Node 22 的 Linux ARM64 路径已有本机验证。stdio/HTTP 的 2025-11-25 与 2026-07-28 已分别验收，另以独立已安装 Client SDK 2.0.0/2.2.0 复核，不把它外推为全部品牌客户端或实际 Agent 使用均验收。[SDK 官方资料](https://github.com/modelcontextprotocol/typescript-sdk)。

需要标准 HTTP MCP 时，在上面的 API 启动命令增加 `--allow-mcp`，使用 `origin/mcp` 和该连接的 Bearer 凭据；默认不开放。stdio/HTTP 共用能力/工具范围，HTTP 配置导出只写入新的私有文件，具体命令见 [通用 MCP](MCP.md)。

## DSH 可选服务连接

工作台可另显式增加 [供应商管理](PROVIDER_SETTINGS.md)与选择 [Panel](PANEL_EXTENSIONS.md)。这两者不扩大连接/MCP 权限：上游凭据留在 Core，普通 harness 不能读写供应商设置。

使用同一个 `connection create`，将 harness 改为 `dsh`、输出改为新的独立目录。Core 的 `server-grants.json` 支持 1–32 个授权项；多连接时由操作者明确合并各 grants 数组，保留 UUID/secret 与 0600，随后显式启动服务读取它。连接配置不自动热重载。

在你明确启动 DSH 时提供：

```bash
IRIS_CORE_CONNECTION_FILE=/absolute/dsh-pair/client.json \
IRIS_CORE_SCOPES=read,create,execute,stop <your-existing-DSH-start-command>
```

首版为**新增共享 Flow 工具的可选连接模式**：原 17 项媒体工具、三项 DSH Skills 和原生 UI 保持；另注册与 MCP 相同的授权 `iris_core_*` 工具。图片通过真实 DSH attachment 服务交付。默认不设置此文件时，不连接服务、不新增工具。Core Skills 的 [显式安装器](CORE_SKILLS.md)继续独立，MCP 握手不替代 Skill 发现。

此 DSH 原生共享桥仍限图片组；新 v3 语音/转写使用通用 MCP 或 Core Web。选择音频组会明确拒绝原生桥启动，避免注册尚无附件投影的工具；不影响原17项媒体工具的语音/转写。

传统媒体工具继续使用原根；共享 Flow 仅使用连接所绑定的 Core 根。Core 离线时共享工具明确失败，不切回本地另生成。此模式尚未把整个旧媒体栈、浏览器/视觉/会话服务或 DSH UI 迁成远程 RPC。Core 连接中心现阶段创建通用 MCP 档案；DSH 原生服务授权仍由上述静态文件管理，不自动修改 DSH 设置。
