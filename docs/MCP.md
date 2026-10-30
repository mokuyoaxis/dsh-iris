# 通用 MCP 接入与能力选择（0.3 alpha）

新用户先看[从零启动与页面接入](CORE_QUICKSTART.md#connect-an-agent--连接客户端)；交给安装/使用 Agent 的可复制说明见 [Agent Core 指导](AGENT_CORE_QUICKSTART.md)。本页详述传输、模板与授权契约。

同一套 Iris MCP 工具可通过 stdio 或 Streamable HTTP 接入支持对应传输和协议的客户端。无需为每个产品编写 Adapter，客户端名称也不用于授予能力。**本页入口从0.3.0-alpha.1提供，稳定 npm 0.2.7 不包含**；安装准确alpha版本或使用当前源码，契约仍为实验性。

业务数据、Operation、执行队列和 Provider 均归同一个 [Core 服务](CORE_SERVICE.md)。MCP 负责协议和工具交付，使用官方 SDK 2.3.1；不启动第二个业务写者，也不把调用转成 Shell 命令。当前媒体范围为固定 `image-edit/v0`、[文生图 `image-generate/v0`](IMAGE_GENERATION.md)，以及新 v3 根上的 [speech/v0 和 transcribe/v0](AUDIO_FLOWS.md)。文生图需要 v2/v3 根，音频需要显式 `execution init --audio` 新根，原根不迁移。

工具输入、功能归属、权限和指导来自同一 [Core 能力目录](PLUGINS.md#core-能力目录与授权)。MCP 导出服务、功能选择、scope、已保存 tools 的交集；Skill 从同源声明解释工具。安装/发现插件不授权；页面/渲染器也不默认挂载。显式开启的插件业务现已接入持久 Operation，经用户保存的准确 `pluginOperations` 依赖选择调用，旧连接不扩权。

选择带图片输入的业务后，目录与图片工具可读取同一数据根内共享的 PNG/JPEG/WebP 来源（≤8 MiB），包括其他业务的图片；其他业务的调用和历史仍不开放。没有图片输入的业务不隐含图库权限，实际处理器只读取本次绑定的来源；完整边界见[连接授权](CORE_CONNECTIONS.md#身份与授权)。

## 可选真实插件业务

先按[稳定启动](PLUGIN_STARTUP.md)启动 Core，并在 `--plugin-config` 明确装载与启用业务。普通工作台使用[访问口令](WORKBENCH_LOGIN.md)，浏览器登录与 MCP 连接密钥独立。使用固定端口与原连接目录可复用已导出的 MCP 配置；旧 Token 模式的 owner 会话轮换也不轮换连接密钥。不要将 `mcp serve` 当作 Core 启动命令。

[多图对照板](CONTACT_SHEET.md)通过公开插件 SDK、现有 Sharp 和 Core 作品存储处理真实图片。服务装配者选择业务，用户在 Web 连接页选择准确依赖并允许执行，客户端再通过通用 `iris_core_plugin_catalog` 获取业务输入 Schema、可用性和来源图片，调用 `iris_core_plugin_call`。执行工具固定为 `{key,operationId,dependency,input}`；不为每个插件复制工具名单，也不提供 shell 或任意 Core 命令入口。

回执、原 UUID 接回、停止和图片继续使用 `iris_core_operation/lookup/stop/image`。插件业务 succeeded 表示处理器返回且 Core 命令完成；媒体流程的 succeeded 仍仅描述一次有限继续。缺失/不同版本插件阻止新执行，原记录和作品不依赖插件实现；重启保留 interrupted，不自动重做。缩权让旧握手失效，下一次 Core 命令继续核对持久授权；已入库作品不回滚。

仅选此业务并允许 read/execute/stop 时有8个工具，权限缩减后进一步过滤。未选择业务的连接不获新增工具；media只读服务也不会因插件 execute 而开放 continue。官方客户端已验证 stdio/HTTP、2025-11-25/2026-07-28协议、原 UUID/图片恢复及负向授权边界；这不代表所有 harness 已完成附件展示实测。

文生图创建可带 `workflowParameters`，仅使用所选 ComfyUI 模板明确开放的参数 ID 和标量值。先通过 `iris_core_models` 读取描述；参数随 Run 保存并纳入原请求 Key，不能传任意图补丁。节点/模型的只读检查属于 owner 配置接口，未新增 MCP 管理工具或扩张已有连接权限；Core 工作台已接通导入预览、参数表单和结果参数查看，DSH 的独立工作台入口见 [DSH ComfyUI](IMAGE_GENERATION.md#dsh-工作台入口03-alpha)。

## 首次接入与客户端预设

Core由用户明确启动并保持运行；stdio桥由客户端启动和关闭，HTTP客户端连接已开启的 `/mcp`。桥退出只结束自己的连接，不停止Core或已受理的媒体操作。连接页记录最近使用与握手事实，不把它称为客户端持续在线。

客户端名称/版本上报属于可选元数据，失败或延迟不阻塞已授权工具，也不替换业务回执。握手、持久授权和每次 Core 命令的权限核对继续生效；元数据上报不授予权限。

已有明确的 client.json 后，可先检查再导出：

```bash
node bin/dsh-iris.js mcp check --connection-file /absolute/pair/client.json
node bin/dsh-iris.js mcp presets
node bin/dsh-iris.js mcp config --connection-file /absolute/pair/client.json \
  --preset codex-stdio --output /absolute/new-iris-mcp.toml
```

`check`默认只请求read，检查私有配置、Core回环传输、原身份握手和实际工具选择，随后断开临时实例；返回JSON，失败退出码为1。可用 `--scopes/--capabilities/--tools` 明确检查实际要用的子集，不修改原授权。它不调用供应商，也不证明模型、客户端加载或 `/mcp` 协议链路已实测；后者仍需在客户端确认。Core未运行时返回transport阶段与建议，不自动创建根或启动另一份服务。

内置8个预设由用户选择，不检测安装、不读取或合并日常客户端配置：

| 前缀 | 格式与使用方式 | 官方依据 |
|---|---|---|
| generic | 通用mcpServers JSON，也可手动选择entry | [MCP本地接入](https://modelcontextprotocol.io/docs/develop/connect-local-servers) |
| claude | 带type=stdio/http的mcpServers JSON，合并到明确选择的.mcp.json | [Claude Code MCP](https://code.claude.com/docs/en/mcp) |
| codex | 原生 `[mcp_servers.iris]` TOML，command/args或url/http_headers | [OpenAI官方配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) |
| kimi | command/args或url/headers的mcpServers JSON，合并到明确选择的mcp.json | [Kimi Code MCP](https://moonshotai.github.io/kimi-code/en/customization/mcp) |

每个前缀分别使用 `-stdio`、`-http`，如claude-http。预设只选择传输、格式和说明，不增加媒体功能、scope或工具；不能与手动 `--transport/--format` 混用。其他客户端继续使用通用入口或数据模板。合并时保留已有文件与其他条目，不把本次片段直接覆盖成完整日常配置。

手动格式支持mcpServers、entry、claude-json、codex-toml。TOML导出为实际文本及.toml文件；JSON继续为对象及.json文件。HTTP预设仍需服务显式开启HTTP MCP；CLI含密钥导出仍只写新的原连接私有目录文件，拒绝stdout与覆盖。工作台复制/下载是用户明确操作，含密钥内容仅交给获授权客户端。

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

功能分组与操作权限分开。当前可选媒体分组为 `image-edit`、`image-generate`、`tts`、`transcribe`，根版本进一步限制实际可用分组；查看工具总目录：

```bash
node bin/dsh-iris.js mcp capabilities
```

- `--capabilities image-edit`：图片导入、流程、模型查询、单次继续、原操作查询、本地停止和原图读取。
- `--capabilities image-generate`：独立文生图创建、流程/模型查询、单次继续、原操作查询、本地停止和结果读取；可用 `image-edit,image-generate` 同时选择。原默认仍仅 image-edit。
- `--capabilities tts`：实际语音候选、文字/可选音色创建、原音频内容及共享 Run/Operation 工具；仅在 v3 根开启。
- `--capabilities transcribe`：实际转写候选、原音频导入/来源ID创建、音频与文字读取及共享 Run/Operation 工具；仅在 v3 根开启。可用 `tts,transcribe` 同时选择。
- `--capabilities none`：关闭媒体流程工具，保留两项连接管理工具。
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
| 单次继续、原 Key 接回、本地停止 | 已有 | 图片/音频分组支持，按原 Run 能力检查 |
| 明确选择作品、导出到本机路径 | 已有 | 尚未接入，继续使用 CLI |
| 独立文生图 | 已有 | image-generate 分组支持；新 v2/v3 执行根，明确模型与单张输出 |
| TTS、原音频读取 | 已有 | tts 分组，新 v3 根，标准 audio 内容块，实际播放器取决于客户端 |
| 音频导入、转写与文字读取 | 已有 | transcribe 分组，新 v3 根，持久来源与原任务恢复 |
| 视频/S2V、Music | 已有 | 尚未接入 |
| 视觉、OCR、定位、摘要 | 已有 | 尚未接入 |
| 裁剪、像素差异、抽帧、HTML 截图 | 已有 | 尚未接入 |
| 全媒体任务/作品管理及可恢复维护 | 已有 | 仅有固定流程所需的有限读取，其余尚未接入 |

增加媒体能力时，先接入已有 Core 的受理、原身份恢复和产物交付，再作为新分组让用户明确选择，不添加 `all` 自动扩展已有连接。

## 错误定位

`mcp check` 的error、stdio启动失败的stderr和工具错误包含安全错误码、阶段与处理建议；Core已返回关联ID时保留requestId。工具错误的 `structuredContent.error` 另保留已校验的原key/runId/operationId，不复制私有异常、Provider正文、凭据或任意路径。

| 阶段 | 处理方式 |
|---|---|
| configuration | 核对明确选择的私有client.json；server-grants.json和owner Token不是客户端文件 |
| transport | 核对已启动Core的回环地址与端口；超时后保留原Key，先查询原操作 |
| handshake / authorization | 核对原根、连接身份、已保存选择与服务开关，再由所有者明确导出或调整 |
| input / tool / response | 按当前Schema与原Run/Operation检查；Run版本变化先读取当前修订，不自动重提 |

stdio stdout保持MCP协议专用。EOF、明确关闭或启动取消会关闭桥与本地网络等待；关闭与初始化竞态不会重新打开客户端。远端实例断开有confirmed/unconfirmed结果，不把本地停止当作供应商取消或退款。

## 验证范围

新增接入预设已进行独立TOML解析、八类配置的真实stdio/HTTP协议工具交付、CLI检查及隔离浏览器复制/下载验证；未实际启动Claude Code、Codex、Kimi Code原生会话，不把格式验证称为所有客户端版本已验收。

早期图片切片验证 stdio/HTTP × 2025-11-25/2026-07-28，每个组合实际调用全部 12 个工具；另以两份独立已安装的官方 Client SDK 2.0.0/2.2.0 重跑四个组合。覆盖真实 Core 持久记录、原图字节、原 Key 跨进程/传输接回、能力/权限交叉、断开、本地停止和重启。Provider 响应为离线夹具，没有付费模型调用。

另有文生图 stdio/HTTP 定向验收，覆盖新增创建工具、原 Key 和共享工具的功能授权；原 image-edit 仍为 12 工具，只选文生图为 11 工具，两者完整选择为 13 工具。新组不自动扩张旧文件或授权。

音频另以受控 Provider 验证 HTTP 2025/2026、真实 stdio 2026 进程、标准 audio 内容块、UTF-8转写、分组/媒体入口隔离、连接 Skill、原Key和重启恢复。没有调用真实付费服务，不代表所有 harness 都支持音频播放；输入与大小边界见[音频流程](AUDIO_FLOWS.md)。

这些结果不代表每个品牌客户端或 Agent 的自主使用都已验收。DSH 的可选原生桥与三项 Skills 保持；Skill 发现/安装仍按 [Core Skills](CORE_SKILLS.md)单独处理。真实 Web 按显式开关提供连接管理与媒体操作，默认只读。

连接中心还支持[纯数据模板和连接专属 Skill](LOCAL_WEB.md#显式开启连接中心)：模板只选择现有传输与 JSON 格式，Skill 按当前有效工具生成，下载后用 `skills install --bundle` 显式安装。配置、工具权限和使用说明各自独立；Skill 不提供身份凭据，不自动注册 MCP 或扩展连接权限。这些入口均为0.3 alpha源码能力。

文生图连接的 Skill 对 ComfyUI 先确认缺少的工作流、LoRA 与参数要求，再使用实际目录中的 `modelRef` 和 `comfyWorkflow.parameters`。目录工具、执行工具或改图工具未开放时，说明会相应限定调用和搭配，不提供越权的替代路径。当前可将 ComfyUI 输出作为同根作品交给支持改图的 API，反向图片输入尚未接入；详见 [ComfyUI Skill 参考](../skills/iris-core/references/comfyui.md)。
