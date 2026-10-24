# 通用 MCP 接入与能力选择（面向 0.3，未发布）

同一套 Iris MCP 工具可通过 stdio 或 Streamable HTTP 接入支持对应传输和协议的客户端。无需为每个产品编写 Adapter，客户端名称也不用于授予能力。**公开 npm 0.2.7 不包含本页入口**，以下使用当前源码或已经验证的安装副本。

业务数据、Operation、执行队列和 Provider 均归同一个 [Core 服务](CORE_SERVICE.md)。MCP 负责协议和工具交付，使用官方 SDK 2.3.1；不启动第二个业务写者，也不把调用转成 Shell 命令。当前实际媒体范围为固定 `image-edit/v0`，功能覆盖见下表。

## 创建明确的连接

也可使用 [Core 连接中心](LOCAL_WEB.md#显式开启连接中心)创建、编辑和撤销，再从页面导出配置。此模式显式指定私有管理目录；名称自由填写，不依赖内置品牌名单。下面保留原静态文件配置方式，两者可共存。

先初始化新的专用根，保留现有 DSH/旧请求根：

```bash
node bin/dsh-iris.js flow init --data-root /absolute/new-core
node bin/dsh-iris.js execution init --data-root /absolute/new-core
node bin/dsh-iris.js connection create --data-root /absolute/new-core \
  --directory /absolute/new-mcp-pair --origin http://127.0.0.1:3182 \
  --label my-client --scopes read,create,execute,stop --capabilities image-edit
```

MCP 默认 `generic`，不必填写 Kimi、Claude 或其他产品名。`--label` 是用户可辨认的连接名称；原 `--harness kimi` 仍可用，`--harness dsh` 留给 DSH 原生服务桥。连接与权限见 [连接契约](CORE_CONNECTIONS.md)。

```bash
node bin/dsh-iris.js api serve --data-root /absolute/new-core \
  --provider-config /absolute/providers.json --port 3182 \
  --token-file /absolute/new-owner-token.txt --allow-execution \
  --connections-file /absolute/new-mcp-pair/server-grants.json --allow-mcp
```

`--allow-mcp` 才开放标准 `/mcp`，与现有 Core 共用端口。默认关闭；不传 `--allow-execution` 时仍按服务已开启的权限提供有限工具。创建连接、导出配置、初始化和工具发现不调用模型。

## 选择能力和工具

功能分组与操作权限分开。当前可选媒体分组为 `image-edit`；查看实际分组和工具：

```bash
node bin/dsh-iris.js mcp capabilities
```

- `--capabilities image-edit`：图片导入、流程、模型查询、单次继续、原操作查询、本地停止和原图读取。
- `--capabilities none`：关闭图片流程工具，保留两项连接管理工具。
- `--tools iris_core_models,iris_core_image`：在分组范围内进一步选择具体工具；`--tools none` 注册零工具。明确工具名单不会暗中补齐连接工具。
- `--scopes read`：只读；`create` 允许上传/建 Run，`execute` 允许明确继续，`stop` 允许本地停止。必须包含 read；首次继续可能产生模型费用。

这些选项可用于 `connection create`。服务端按连接授权检查实际 API 路由，猜工具名或绕过 MCP 也不能调用未选择的功能。stdio 客户端还可进一步缩小本次 `mcp serve` 的范围；HTTP 以该连接在服务端的明确授权为准，需要不同范围时创建各自的连接。

新连接将能力和具体工具列表写入私有授权。后续版本增加新工具不会扩大已有列表。旧文件缺少这两个字段时按原有图片流程和固定 12 工具解释，读取不改文件；未知分组、未知工具和未接入的媒体功能明确拒绝。

## stdio：填写启动命令

导出当前 Node 与实际包入口的绝对路径，复制到接受 `mcpServers` 格式的客户端：

```bash
node bin/dsh-iris.js mcp config \
  --connection-file /absolute/new-mcp-pair/client.json \
  --scopes read,create,execute,stop --format mcpServers
```

也可 `--format entry` 仅输出 command/args。配置不包含认证值，命令从指定私有文件读取它。不同客户端的配置文件格式可能不同；按该客户端要求填写同一组 command/args。导出器不修改或扫描客户端配置。

其启动命令为：

```bash
node /absolute/iris/bin/dsh-iris.js mcp serve \
  --connection-file /absolute/new-mcp-pair/client.json \
  --scopes read,create,execute,stop
```

省略 scopes 时请求只读。stdout 只传 MCP 消息；正常 EOF 关闭桥。桥退出或请求取消不撤销 Core 已接收的 Operation，重连用原 Key 查询。

## HTTP：填写 URL 和认证

服务启动后 MCP 地址为 `http://127.0.0.1:3182/mcp`，使用标准 `Authorization: Bearer …`；客户端无需实现 Iris 内部身份头或业务握手。每个连接使用自己的凭据和能力范围。

导出包含认证的配置须明确写入原连接私有目录的新文件：

```bash
node bin/dsh-iris.js mcp config \
  --connection-file /absolute/new-mcp-pair/client.json --transport http \
  --output /absolute/new-mcp-pair/mcp-http.json
```

stdout 只返回输出位置等元数据；文件以 0600 排他创建，不覆盖已有内容。按客户端自己的格式复制 URL/headers；此文件包含凭据，应与 client.json 一样私有保管。HTTP 的 scopes/分组/工具在授权文件中选择，导出时不通过客户端自报字段扩大或改变它们。

HTTP 使用官方 `createMcpHandler`，提供 2026-07-28 请求元数据模式及 2025-11-25 的无状态兼容路径；旧协议 GET/DELETE 的可选会话操作返回 405。Host/Origin 和 Bearer 在 SDK 前校验，仅回环监听。静态文件仍仅启动时读取；连接中心的显式 owner 操作可即时变更授权。该入口没有公网发布、OAuth 登录或自动端口发现。

当前每项 HTTP 授权在 Core 中对应一个逻辑桥实例。共享同一凭据的多个程序不被猜测为不同产品或真实在线进程；需要分别查看/授权时使用独立连接。该数据空间仍是同一用户共享作品，不是连接之间的数据租户隔离。

实际客户端的标准名称/版本以“客户端声明”显示，桥版本另外记录，不作为认证依据。新增工具权限后，stdio 需要重新启动加载工具表；收回权限或撤销后，旧进程也无法绕过 Core。连接中心仅在明确导出时返回 HTTP 密钥；CLI 的 HTTP 导出继续要求新建私有文件，不打印认证值。

标准传输依据 [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)；SDK 装配见 [HTTP serving](https://ts.sdk.modelcontextprotocol.io/v2/serving/http.html)。

## 功能覆盖

以下 Core 列表示已有代码入口，具体运行仍需有效配置、模型或相应本地组件；不表示所有部署/账号均已实测。

| 功能 | Core/CLI | 当前 MCP |
|---|---|---|
| 静态图片导入、原图读取 | 已有 | image-edit 分组支持 |
| 固定图片编辑 Flow、Run/原 Task 查询、比较图引用 | 已有 | image-edit 分组支持 |
| 单次继续、原 Key 接回、本地停止 | 已有 | image-edit 分组支持 |
| 明确选择作品、导出到本机路径 | 已有 | 尚未接入，继续使用 CLI |
| 独立文生图 | 已有 | 尚未接入 |
| 视频/S2V、TTS、Music、转写 | 已有 | 尚未接入 |
| 视觉、OCR、定位、摘要 | 已有 | 尚未接入 |
| 裁剪、像素差异、抽帧、HTML 截图 | 已有 | 尚未接入 |
| 全媒体任务/作品管理及可恢复维护 | 已有 | 仅有固定流程所需的有限读取，其余尚未接入 |

增加媒体能力时，先接入已有 Core 的受理、原身份恢复和产物交付，再作为新分组让用户明确选择，不添加 `all` 自动扩展已有连接。

## 验证范围

本轮验证 stdio/HTTP × 2025-11-25/2026-07-28，每个组合实际调用全部 12 个工具；另以两份独立已安装的官方 Client SDK 2.0.0/2.2.0 重跑四个组合。覆盖真实 Core 持久记录、原图字节、原 Key 跨进程/传输接回、能力/权限交叉、断开、本地停止和重启。Provider 响应为离线夹具，没有付费模型调用。

这些结果不代表每个品牌客户端或 Agent 的自主使用都已验收。DSH 的可选原生桥与三项 Skills 保持；Skill 发现/安装仍按 [Core Skills](CORE_SKILLS.md)单独处理。真实 Web 可显式管理连接，媒体操作仍只读。

连接中心还支持[纯数据模板和连接专属 Skill](LOCAL_WEB.md#显式开启连接中心)：模板只选择现有传输与 JSON 格式，Skill 按当前有效工具生成，下载后用 `skills install --bundle` 显式安装。配置、工具权限和使用说明各自独立；Skill 不提供身份凭据，不自动注册 MCP 或扩展连接权限。这些入口均为未发布源码能力。
