# 本地 Core 工作台（面向 0.3，未发布）

源码中的 `web serve` 提供独立的创作、作品、连接和供应商页面，使用 [本地 API](LOCAL_API.md) 与固定图片流程，无需启动 DSH。默认只读；显式开启执行和选择后，可改图、比较、保存选择并下载。新的 v2 执行根另提供[文生图与 ComfyUI](IMAGE_GENERATION.md)。连接中心分配 MCP 能力；[供应商设置](PROVIDER_SETTINGS.md)管理媒体连接与模型用途，两者单独开启。

**已发布的 npm 0.2.7 不包含此入口。** 以下命令针对包含本页实现的 Git 源码树，不能直接照搬到 0.2.7。原 [交互 Demo](WEB_PROTOTYPE.md) 继续保留，两者是不同入口。

界面沿用 Demo 的侧栏、大画布和右侧设置区，默认白色主体，六色 105 度鸢尾渐变作点缀。“外观”提供主题、密度与浏览器本地背景，图片比较区保持中性。高级参数、模型说明、流程详情与连接工具默认折叠。新草稿展开设置，固定输入的 Run 在手机上收起设置；并排、叠图和放大只改变查看方式。默认 Panel 可用显式资源清单替换，见 [Panel 与外观](PANEL_EXTENSIONS.md)。

## 启动与连接

需要 Node.js ≥22、项目现有依赖，以及已经初始化的专用 Flow 数据根。先确认图片流程是否已有记录；不要把 DSH 的普通 Core 根当作 Flow 根。

```bash
node bin/dsh-iris.js flow list --data-root /absolute/path/to/flow-root
node bin/dsh-iris.js web serve --data-root /absolute/path/to/flow-root --token-file /absolute/path/to/new-session-token
```

命令输出 JSON，包括 `origin` 与 `tokenFile`。在本机浏览器打开 `origin`，选择该 Token 文件，或展开“粘贴 Token”连接。Token 文件必须是数据根之外的新绝对路径；不会覆盖已有文件。服务退出后 Token 失效，再次启动需指定新的文件。

若没有 Flow 根，可先在新的专用位置执行 `flow init`；初始化是显式写操作，不由工作台自动进行。导入、创建、生成和选择的命令见 [图片流程](IMAGE_FLOW.md)。读取已有作品不需要 Provider 配置；若需显示配置中的模型候选，显式添加 `--provider-config /absolute/path/to/providers.json`。候选存在不代表实测成功；打开页面不探测模型，管理开启后可主动读取目录。

默认随机端口，可用 `--port 4173` 指定。只监听 `127.0.0.1`，使用输出的完整地址，不能以 `localhost` 或代理 Host 替换。不会自动打开浏览器、启动 DSH 或重载其他进程。Ctrl+C 关闭。

## 可用功能

- 从历史查看真实持久 Run、原图与已保存结果；刷新读取最新本地记录。
- 查看修改要求、状态和选择。详情及模型列表默认折叠，技术标识放在展开内容中。
- 在权限开启时改图、保存原图/结果选择；服务确认后才显示已选状态和启用下载。下载保留原始图片字节与格式。
- 切换历史、断开或重连。地址中的 Run 片段帮助重新定位，刷新后仍需重新连接会话。
- 对已有待核对动作，重新认证后按原创建 Key、Operation 或 Run 只读接回；“操作核对”默认折叠，可重新核对和查看流程。恢复表只含有限身份，详见 [请求恢复](WEB_RECOVERY.md)。
- 作品页按全部、已选择或未选择进行服务器端筛选；计数和分页来自同一批真实记录，封面优先已选作品。只加载可见卡片预览，离开作品页释放预览 Blob。

默认模式的媒体请求全部为 GET，创作与选择控件禁用并解释当前权限。刷新不查询外部任务、生成或修复数据；连接与供应商管理各有独立开关。

## 开始一次真实改图

完整创作需要新的专用 v1 根、明确的图片模型配置和独立选择开关：

```bash
node bin/dsh-iris.js flow init --data-root /absolute/new-core
node bin/dsh-iris.js execution init --data-root /absolute/new-core
node bin/dsh-iris.js web serve --data-root /absolute/new-core \
  --token-file /absolute/new-owner-token \
  --allow-execution --allow-selection --provider-config /absolute/providers.json
```

不要在已有 v0 创作根执行迁移；旧根仍可只读浏览或显式保存选择。Provider 配置格式见 [本地创建](LOCAL_CREATION.md)，配置候选不代表已实测。首次连接为空草稿，不预填演示作品或模型。

选择/拖入不超过 20 MiB 的静态 PNG/JPEG/WebP，明确选择模型、填写要求，可展开填写模型支持的输出尺寸。点击“开始改图”后依次保存素材、建立 Run、执行一次改图；三个步骤各保留自己的 Key，双击合并，任一结果未确认或用户已离开时停止后续提交。Run 输入固定，修改要求需新建流程；“用已选作品新建”只建立本地草稿，不生成。

切换流程时暂停执行、选择和复用，确认读到目标流程后再启用。读取失败时保持暂停，可重新读取或明确新建流程，不沿用上一流程的操作对象。

已接收 Operation 期间最多低频 GET 40轮；隐藏标签页、离开创作或读取出错即暂停，可点击“刷新”明确接回。Operation 结束后再读取 Run；它结束不代表图片一定完成。异步任务需明确点击“查看原任务”，每次仅观察一次；受理未知保留原任务，不提供自动重提。保存失败的原结果和本地比较使用对应明确按钮接回。

“停止等待”只停止原 Operation 的本地等待，不代表供应商取消、退款或未计费。选择采用当前 Run revision，冲突或回包丢失后读取当前选择，不自动覆盖。选择确认后可下载，实际保存位置和完成状态以浏览器下载记录为准。

## 显式媒体权限

`web serve` 与 `api serve` 使用相同的独立开关，不要求先开启连接管理：`--allow-local-writes` 开放零生成上传/创建；`--allow-execution` 同时开放创建与有限执行，需 v1/v2 执行根及显式 Provider。`--allow-selection` 只开放 owner 持久选择，可直接用于已有 Flow 根，无需 Provider、创建请求区或执行器。

```bash
node bin/dsh-iris.js web serve --data-root /absolute/path/to/flow-root \
  --token-file /absolute/path/to/new-owner-token --allow-selection
```

开关不会自动补齐其他权限。会话的 `readOnly`、`workbenchMediaReadOnly` 和 `operations` 反映当前调用方的媒体 API 权限，页面据此启用控件。仅选择模式无需 Provider；完整改图需执行，单独本地创建模式仍可通过 API 上传/建 Run。owner 选择权限不授予连接客户端。版本冲突与输入限制见 [持久选择](LOCAL_SELECTION.md)。

## 显式开启连接中心

需要已主动初始化的 v1/v2 执行根；新根的准备见 [Core 服务](CORE_SERVICE.md)。不要转换已有 v0 根。指定专用根外管理目录（父目录须存在）和新会话文件：

```bash
node bin/dsh-iris.js web serve --data-root /absolute/new-core \
  --token-file /absolute/new-owner-token.txt --port 3182 \
  --allow-connection-management --connection-store /absolute/new-connection-store \
  --allow-mcp
```

目录为 0700、档案为 0600；首次只接受空目录，之后按 rootId 识别。管理目录与 Core 数据根相互独立，不改静态 grants 或客户端日常配置。目录自身只允许一个管理写者，复用现有租约。异常退出遗留租约时，先检查 `doctor --data-root /absolute/new-connection-store/ownership --json`，再按实际 stale PID 使用 `runtime recover`，不自动清锁。

连接页面支持自由命名、创建、编辑、撤销和 stdio/HTTP 配置导出。图片生成与编辑分别选择，其余五类标为未接入；工具细选默认折叠，操作权限与功能分开。默认只读服务只能分配 read；若要让 harness 导入、创建和执行，可在**同一个命令**显式增加 `--allow-execution --provider-config /absolute/providers.json`。执行服务会建立 runner 租约，接收/计费动作由用户或获授权客户端明确发起。连接管理不扩大媒体权限，owner 选择权限也不授予 harness。

创建不代表客户端已经加载。安装配置后，实际 MCP 客户端自报名称/版本会标记为“客户端声明”，桥版本独立记录；实例记录不保证进程持续在线。没有声明时显示未知，不扫盘推测安装状态。一个产品可按工作区创建多个连接。

stdio 配置引用本机私有客户端文件；HTTP 配置含连接密钥，只有点击生成配置时返回，复制/下载后应私下保管。隐藏配置、离开连接页或断开会清除预览；下载后也清空文本。普通列表不含凭据。编辑授权会立即影响后续调用；扩大名单后，stdio 客户端需重新启动以注册新增工具，缩小或撤销后旧进程不能绕过 Core 校验。已接收 Operation 保留，不等同于远端取消或停止计费。详见 [连接契约](CORE_CONNECTIONS.md)与 [MCP](MCP.md)。

重复使用导出的配置时保持相同端口；服务改用其他端口后，需要重新导出并更新客户端。连接身份与撤销状态仍保留，旧配置不会自动寻找新端口。

“接入模板”支持导入有界 JSON，不依赖品牌名单。展开“导入模板”可下载示例；只填写 `schemaVersion:0`、标题、`transport:stdio/http`、`format:mcpServers/entry` 和可选 HTTPS 文档地址。导入会保存到管理目录，重启仍可选；相同内容不会重复创建。模板只选择传输与格式，不增加权限、不提供任意启动命令或代填凭据。未知客户端可手动映射单条 entry；当前不导出专属 TOML 等其他格式。

展开“连接专属 Skill”，按**已保存且当前有效**的工具生成英文说明（附中文标题），可预览并下载交付 JSON。说明与配置分开，下载不表示安装；按页面命令显式指定 Skills 目录，再在客户端确认发现。权限变化后重新生成/安装，现有本地修改受到保护。见 [安装与边界](CORE_SKILLS.md#连接专属-mcp-skill未发布)。

## 显式开启供应商设置

在启动命令中增加 `--provider-config /absolute/existing-private-providers.json --allow-provider-management`。owner 可从“供应商”或“管理模型”配置媒体连接、主动读取目录或手填模型、确认用途后一次保存。Key 不回显，冲突保留草稿。见 [C3 使用与管理契约](PROVIDER_SETTINGS.md)。此开关不隐含创建、执行、选择或 MCP 权限。

## 会话与图片边界

Token 仅保存在当前标签页内存中，不进入 URL、浏览器持久存储或启动输出。断开清空视图并释放图片 Blob，刷新后重新连接。重启使旧会话失效，业务 Run 身份保持。

未确认动作的身份单独保存在有界 sessionStorage，绑定 origin 和稳定 rootId，不含 Token、Prompt 或文件。换根只丢弃旧客户端标识，存储不可用时提示内存模式；重连恢复仅 GET。未知创建核对成功后可打开原 Run，不自动首次执行；未完成请求需明确提供原输入后按原 Key 接回。

静态资源使用默认固定白名单或明确指定的可信 Panel 清单，登录页不含私有数据；API、图片和下载仍要求 Bearer，保留 Host/Origin 与无 CORS 的约束。不提供任意目录、Provider 原配置或私有路径。供应商编辑投影仅在管理开启后对 owner 提供，含端点、不含 Key。图片只支持 PNG、JPEG、WebP，上限沿用只读 API 的 64 MiB。

下载成功只说明请求已交给浏览器，实际位置与完成状态以浏览器下载记录为准。像素差异描述变化程度，不是质量评分。

## 验证与下一阶段

源码验证使用隔离根与受控 Provider，不读取日常配置或进行付费生成：

```bash
node tests/local-web.mjs
node tests/panel-extension.mjs
node tests/provider-settings.mjs
node tests/local-selection-api.mjs
node tests/local-creation-lookup.mjs
node tests/web-recovery.mjs
node tests/web-media-api.mjs
node tests/local-gallery-api.mjs
node tests/core-connection-store.mjs
node tests/connection-management.mjs
node tests/connection-delivery.mjs
node scripts/verify-local-web-browser.mjs --browser-executable /absolute/path/to/chromium --output /absolute/path/to/new-evidence-directory
```

需要已有 Chromium，不下载或安装；加 `--connection-management` 验证真实管理交互，`--allow-selection` 开启选择模式但不自行点击写入。`--recovery` 用独立测试动作验证恢复；`--creation` 在隔离根经生产页面实际点击创作、选择、下载、异步观察、停止、版本冲突和回包丢失，仅 Provider 为受控夹具。`--mode-closure` 单独验证未确认执行在权限降级与恢复后保留原身份、只读核对及明确接回，不与其他场景开关组合。仅在受控测试确有需要时追加 `--no-sandbox`。桌面模拟手机宽度、200% 等效布局宽度不等于 Android 真机或浏览器原生缩放验收。

`--panel-c3` 单独验证外观持久化、配置/冲突/回包丢失、窄屏及配置后受控真实改图，不与其他场景开关组合，不调用付费媒体。

`--image-generation` 单独验证新 v2 根的文生图、恢复与选择下载、能力选择及 ComfyUI 导入/HTTP 队列链路；ComfyUI 为受控响应，不能替代实际 GPU 出图。

源码已把 [有限执行](CORE_SERVICE.md)、[持久选择](LOCAL_SELECTION.md)、[原身份恢复](WEB_RECOVERY.md)、文生图及供应商设置接到真实页面，并补充本机受控验证。标准平台、真实设备和发布前完整验收仍待完成，历史完整门禁停滞继续单独调查；其他媒体和最终演示素材按 [路线图](ROADMAP.md)推进。本页实现未发布，也不等于生产环境或真实付费验收完成。
