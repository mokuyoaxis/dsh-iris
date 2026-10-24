# 本地 Core 工作台（面向 0.3，未发布）

源码中的 `web serve` 默认提供图片流程只读浏览，也可显式开启连接中心。连接当前会话后，可查看持久历史、原图、结果及已选作品下载；连接中心用于给 MCP 客户端分配能力和导出配置。它使用 [本地 API](LOCAL_API.md) 与 [固定图片流程](IMAGE_FLOW.md)，无需启动 DSH。

**已发布的 npm 0.2.7 不包含此入口。** 以下命令针对包含本页实现的 Git 源码树，不能直接照搬到 0.2.7。原 [交互 Demo](WEB_PROTOTYPE.md) 继续保留，两者是不同入口。

当前界面使用米白/墨绿配色与圆角面板，提供深色模式和桌面/窄屏布局。“作品”页以历史列表配合原图/结果对照，“连接”页管理客户端授权、配置与 Skill；模型摘要、流程详情、工具细选、模板导入和 Skill 默认折叠。这里的“已选择”来自 Core 已保存记录，页面尚不能提交新的选择。

## 启动与连接

需要 Node.js ≥22、项目现有依赖，以及已经初始化的专用 Flow 数据根。先确认图片流程是否已有记录；不要把 DSH 的普通 Core 根当作 Flow 根。

```bash
node bin/dsh-iris.js flow list --data-root /absolute/path/to/flow-root
node bin/dsh-iris.js web serve --data-root /absolute/path/to/flow-root --token-file /absolute/path/to/new-session-token
```

命令输出 JSON，包括 `origin` 与 `tokenFile`。在本机浏览器打开 `origin`，选择该 Token 文件，或展开“粘贴 Token”连接。Token 文件必须是数据根之外的新绝对路径；不会覆盖已有文件。服务退出后 Token 失效，再次启动需指定新的文件。

若没有 Flow 根，可先在新的专用位置执行 `flow init`；初始化是显式写操作，不由工作台自动进行。导入、创建、生成和选择的命令见 [图片流程](IMAGE_FLOW.md)。读取已有作品不需要 Provider 配置；若需显示配置中的模型候选，显式添加 `--provider-config /absolute/path/to/providers.json`。候选存在不代表实测成功，页面不会探测模型。

默认随机端口，可用 `--port 4173` 指定。只监听 `127.0.0.1`，使用输出的完整地址，不能以 `localhost` 或代理 Host 替换。不会自动打开浏览器、启动 DSH 或重载其他进程。Ctrl+C 关闭。

## 可用功能

- 从历史查看真实持久 Run、原图与已保存结果；刷新读取最新本地记录。
- 查看修改要求、状态和选择。详情及模型列表默认折叠，技术标识放在展开内容中。
- 下载已选择作品，保留原始图片字节与格式。未选择时不可下载，选择仍通过 CLI 完成。
- 切换历史、断开或重连。地址中的 Run 片段帮助重新定位，刷新后仍需重新连接会话。

默认模式全部业务请求为 GET，没有上传、生成、选择或停止按钮。刷新不会查询外部任务、生成或修复数据。进行中任务显示的是最后保存到本地的进展，通过 CLI 明确查看原任务。

## 显式开启连接中心

需要已主动初始化的 v1 Flow 根；新根的准备见 [Core 服务](CORE_SERVICE.md)。不要转换已有 v0 根。指定专用根外管理目录（父目录须存在）和新会话文件：

```bash
node bin/dsh-iris.js web serve --data-root /absolute/new-core \
  --token-file /absolute/new-owner-token.txt --port 3182 \
  --allow-connection-management --connection-store /absolute/new-connection-store \
  --allow-mcp
```

目录为 0700、档案为 0600；首次只接受空目录，之后按 rootId 识别。管理目录与 Core 数据根相互独立，不改静态 grants 或客户端日常配置。目录自身只允许一个管理写者，复用现有租约。异常退出遗留租约时，先检查 `doctor --data-root /absolute/new-connection-store/ownership --json`，再按实际 stale PID 使用 `runtime recover`，不自动清锁。

连接页面支持自由命名、创建、编辑、撤销和 stdio/HTTP 配置导出。媒体分组目前只有图片编辑可选，其余五类标为未接入；工具细选默认折叠，操作权限与功能分开。默认只读服务只能分配 read；若要让 harness 导入、创建和执行，可在**同一个命令**显式增加 `--allow-execution --provider-config /absolute/providers.json`。执行服务会建立 runner 租约，页面仍只提供媒体浏览与连接管理，接收/计费动作由获授权客户端明确发起。单独 `web serve --allow-local-writes` 仍拒绝。

创建不代表客户端已经加载。安装配置后，实际 MCP 客户端自报名称/版本会标记为“客户端声明”，桥版本独立记录；实例记录不保证进程持续在线。没有声明时显示未知，不扫盘推测安装状态。一个产品可按工作区创建多个连接。

stdio 配置引用本机私有客户端文件；HTTP 配置含连接密钥，只有点击生成配置时返回，复制/下载后应私下保管。隐藏配置、离开连接页或断开会清除预览；下载后也清空文本。普通列表不含凭据。编辑授权会立即影响后续调用；扩大名单后，stdio 客户端需重新启动以注册新增工具，缩小或撤销后旧进程不能绕过 Core 校验。已接收 Operation 保留，不等同于远端取消或停止计费。详见 [连接契约](CORE_CONNECTIONS.md)与 [MCP](MCP.md)。

重复使用导出的配置时保持相同端口；服务改用其他端口后，需要重新导出并更新客户端。连接身份与撤销状态仍保留，旧配置不会自动寻找新端口。

“接入模板”支持导入有界 JSON，不依赖品牌名单。展开“导入模板”可下载示例；只填写 `schemaVersion:0`、标题、`transport:stdio/http`、`format:mcpServers/entry` 和可选 HTTPS 文档地址。导入会保存到管理目录，重启仍可选；相同内容不会重复创建。模板只选择传输与格式，不增加权限、不提供任意启动命令或代填凭据。未知客户端可手动映射单条 entry；当前不导出专属 TOML 等其他格式。

展开“连接专属 Skill”，按**已保存且当前有效**的工具生成英文说明（附中文标题），可预览并下载交付 JSON。说明与配置分开，下载不表示安装；按页面命令显式指定 Skills 目录，再在客户端确认发现。权限变化后重新生成/安装，现有本地修改受到保护。见 [安装与边界](CORE_SKILLS.md#连接专属-mcp-skill未发布)。

## 会话与图片边界

Token 仅保存在当前标签页内存中，不进入 URL、浏览器持久存储或启动输出。断开清空视图并释放图片 Blob，刷新后重新连接。重启使旧会话失效，业务 Run 身份保持。

静态资源使用固定白名单，登录页不包含私有数据；API、图片和下载仍要求 Bearer，保留 Host/Origin 与无 CORS 的约束。不提供任意目录、Provider 原配置或私有路径。图片只支持 PNG、JPEG、WebP，上限沿用只读 API 的 64 MiB。

下载成功只说明请求已交给浏览器，实际位置与完成状态以浏览器下载记录为准。像素差异描述变化程度，不是质量评分。

## 验证与下一阶段

源码验证使用隔离根与受控 Provider，不读取日常配置或进行付费生成：

```bash
node tests/local-web.mjs
node tests/core-connection-store.mjs
node tests/connection-management.mjs
node tests/connection-delivery.mjs
node scripts/verify-local-web-browser.mjs --browser-executable /absolute/path/to/chromium --output /absolute/path/to/new-evidence-directory
```

需要已有 Chromium，不下载或安装；加 `--connection-management` 验证真实管理交互。仅在受控测试确有需要时追加 `--no-sandbox`。桌面 Chromium 模拟手机宽度不等于 Android 真机触控验收。

源码另有 [Operation 存储与版本门禁](LOCAL_OPERATIONS.md)和 [有限执行服务](CORE_SERVICE.md)，通过显式模式装配 runner、接收/停止与 harness 桥；本页面的媒体操作仍只读。连接中心可导入纯数据模板、交付 Skill，安装由 CLI 显式执行，不控制 Agent 会话。下一阶段接入持久选择与真实创作闭环；完整模型配置页、文生图、叠图比较与最终演示素材按 [路线图](ROADMAP.md)推进。
