# Core 执行服务与宿主接入（0.3.1）

Iris 的 Core 执行服务提供单物理数据根上的队列调度、Operation 持久化、MCP 协议网关（stdio / Streamable HTTP）以及可选的 DSH 宿主共享连接桥。

按初始化的数据根版本，同一套服务依次承载：固定改图（v1+）、[文生图与 ComfyUI](IMAGE_GENERATION.md)（v2+）、[语音合成与音频转写](AUDIO_FLOWS.md)（v3+）、[固定文生视频](VIDEO_FLOWS.md)（v4+）以及[看图问答、长图 OCR、视觉定位与多模态摘要](VISION_FLOWS.md)（v5）。配合独立开关，还可开放 [Web 工作台](LOCAL_WEB.md)与[所有者持久选择](LOCAL_SELECTION.md)。

## 显式启动

先准备专用数据根与私有供应商配置，再按需启用执行、连接授权或 MCP 服务：

```bash
npx dsh-iris flow init --data-root /absolute/new-core
npx dsh-iris execution init --vision --data-root /absolute/new-core

npx dsh-iris connection create --data-root /absolute/new-core \
  --directory /absolute/new-mcp-pair --origin http://127.0.0.1:3182 \
  --label my-client --scopes read,create,execute,stop --capabilities image-edit

npx dsh-iris api serve --data-root /absolute/new-core \
  --provider-config /absolute/providers.json --port 3182 \
  --token-file /absolute/new-owner-token.txt --allow-execution \
  --connections-file /absolute/new-mcp-pair/server-grants.json --allow-mcp
```

> 在本地项目安装 `@mokuyoaxis/dsh-iris@0.3.1` 时，`dsh-iris` 不会自动加入全局 `PATH`，请使用 `npx dsh-iris ...`；若从已执行 `npm ci` 的源码仓库运行，请将 `npx dsh-iris` 替换为 `node bin/dsh-iris.js`。

- **权限开关分离**：`--allow-execution` 开启创建与有限执行；`--allow-selection` 单独允许所有者保存图片选择；连接管理可使用动态的 `--allow-connection-management --connection-store <dir>`（见[连接中心](LOCAL_WEB.md#显式开启连接中心)）；需要额外媒体协议或有界并发时，可分别追加 `--provider-extension`（[Provider 扩展](PROVIDER_EXTENSIONS.md)）或 `--scheduler-config`（[有界媒体调度](MEDIA_SCHEDULING.md)）。
- **单根单写者与串行语义**：同一物理数据根只允许一个执行写者（只读工作台可共存）。每次 `flow.continue` 至多执行一轮有限调用（首次提交或观察/补交付原 Task；OCR 按分块计划执行，见[调用预算](VISION_FLOWS.md#ocr-完成度与停止)）。在默认串行模式下，前一个 Operation 返回 `queued`/`running` 后应先等待其结束，再提交下一项。
- **繁忙与拒绝处理**：若收到 `409 / IRIS_API_ROOT_BUSY`，保留原请求 UUID 与输入，待活跃操作结束后先按原 UUID 查询确认；`404 / IRIS_OPERATION_NOT_FOUND` 表示当前 Core 未查到对应记录，断线或超时后仍需核实而非直接新建任务；`403 / IRIS_CONNECTION_CAPABILITY_DENIED` 则应核对授权与服务开关。

## 接收、查询与停止

以下控制路由位于 `/api/v0` 下，需开启执行服务（`--allow-execution` 或显式选定的插件执行服务），并遵循回环、`Host`/`Origin` 与连接[权限校验](CORE_CONNECTIONS.md)：

| 路由 | 输入 | 行为 |
|---|---|---|
| `POST /api/v0/runs/:id/continue` | `Idempotency-Key` UUIDv4，`{expectedRevision}` | 持久落盘 Operation 后返回 `202`；同 Key 同输入返回 `200` 与原记录 |
| `GET /api/v0/operations/:id` | 原 Operation ID | 只读查询持久状态，不访问供应商 |
| `GET /api/v0/operations?key=…` | 原请求 UUID | 丢失回包后按原 Key 查回 Operation |
| `GET /api/v0/runs/:id/operations` | `limit` (1–30)、`cursor` | 分页查询该 Run 下的 Operation 列表（需 `--allow-execution`） |
| `POST /api/v0/operations/:id/cancel` | `{}` | 中止本地等待并在终态落盘后返回 `200` |

> [!IMPORTANT]
> **只读连接与执行服务的区别**：连接侧仅需 `read` 权限即可调用 Operation 详情与 `lookup` 接口，但服务端仍必须开启对应的媒体或插件执行服务以暴露这些读取路由；关闭执行服务后，客户端的 `read` 权限本身不会打开路由。

- **本地停止边界**：`cancel` 返回的 `localStopped: true` 与 `remoteCancellation: not_requested` 表明仅中止了本地等待，未向供应商发起远端取消；已有 Task 受理与产物事实继续保留。`Operation` 的 `succeeded` 表示有限调用已返回，媒体本身是否完成以 Run / Task 记录为准。
- **重启与租约恢复**：服务正常重启时会将遗留的 `queued`/`running` Operation 标记为 `interrupted`（可用原 Key 查回，需用户确认后发起新请求继续）。若服务遭遇强杀留下租约，先用只读检查确认失效 PID，再显式恢复：

```bash
npx dsh-iris execution inspect --data-root /absolute/new-core
npx dsh-iris execution recover-lease --data-root /absolute/new-core --confirm-stale-pid 12345
# 若业务 writer 租约也遗留，先用 doctor 核对 PID，再执行：
npx dsh-iris runtime recover --data-root /absolute/new-core --confirm-stale-pid <PID>
```

## 正式 MCP 接入

Core 服务保持运行，客户端按导出的配置连接即可（stdio 桥接或 `/mcp` HTTP 网关均复用同一 Core 实例，桥进程退出不会停止 Core 或取消已受理的 Operation）：

```bash
# 源码仓库入口（项目内安装也可使用 npx dsh-iris mcp serve ...）
node /absolute/iris/bin/dsh-iris.js mcp serve \
  --connection-file /absolute/new-mcp-pair/client.json \
  --scopes read,create,execute,stop
```

Iris MCP 基于官方 `@modelcontextprotocol/server` 2.3.1 与 Zod 4.6.7 构建，同时兼容 `2025-11-25` 与 `2026-07-28` 协议规范。HTTP MCP 共享实例级 4 条活动消息并发预算（与媒体[调度器](MEDIA_SCHEDULING.md)相互独立），具体预设、工具分组与配置导出见[通用 MCP 指南](MCP.md)。

服务关闭或启动失败时，会依次有序释放 HTTP、MCP、Runner、应用运行时与网络/插件资源；若释放环节出现异常，`snapshot().cleanupFailed` 会如实反映该状态。

## DSH 可选共享连接桥

如果你同时使用 DSH，且希望在保留原生 17 项媒体工具与 3 项 DSH Skill 的同时，把某一个独立 Core 数据根的授权工具也挂载进 DSH，可以使用 `--harness dsh` 生成连接对，并在启动 DSH 时注入环境变量：

```bash
IRIS_CORE_CONNECTION_FILE=/absolute/dsh-pair/client.json \
IRIS_CORE_SCOPES=read,create,execute,stop <your-dsh-start-command>
```

- Core 侧的 `server-grants.json` 支持 1–32 个授权条目，修改后需重启 Core 服务生效。
- 当前 DSH 原生共享桥支持图片流程（`image-edit` / `image-generate`），图片结果直接通过 DSH attachment 服务投递；若连接配置中包含尚未适配附件投影的音频或视频组，共享桥启动时会明确拒绝（不会注册失效工具，也不影响 DSH 原生工具）。如需跨工作区使用音频、视频或视觉流程，请通过[通用 MCP](MCP.md) 或独立 [Core Web 工作台](LOCAL_WEB.md) 接入。
