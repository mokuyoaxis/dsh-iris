# 本地 Core 工作台（0.3 alpha）

第一次使用可从[空配置快速开始](CORE_QUICKSTART.md)依次完成启动、口令登录、供应商/模型池、首件作品与 MCP 连接。本文保留各独立开关与已有工作区的详细参考。

源码中的 `web serve` 提供独立的总览、创作、作品、连接和供应商页面，使用 [本地 API](LOCAL_API.md) 与固定流程，无需启动 DSH。默认只读；显式开启执行和选择后，可改图、比较、保存选择并下载。新的 v2 执行根另提供[文生图与 ComfyUI](IMAGE_GENERATION.md)，v3 音频根另提供[语音合成和音频转写](AUDIO_FLOWS.md)、播放及文字下载。连接中心分配 MCP 能力；[供应商设置](PROVIDER_SETTINGS.md)管理媒体连接与模型用途，两者单独开启。

**本页入口从0.3.0-alpha.1提供，稳定 npm 0.2.7 不包含。** 以下命令使用源码树；安装alpha包后将 `node bin/dsh-iris.js` 换为 `npx dsh-iris`，不能照搬到0.2.7。原 [交互 Demo](WEB_PROTOTYPE.md) 继续保留，两者是不同入口。

界面沿用 Demo 的侧栏、大画布和右侧设置区，默认白色主体，六色 105 度鸢尾渐变作点缀。“外观”提供主题、密度与浏览器本地背景，图片比较区保持中性。高级参数、模型说明、流程详情与连接工具默认折叠。新草稿展开设置，固定输入的 Run 在手机上收起设置；并排、叠图和放大只改变查看方式。默认 Panel 可用显式资源清单替换，见 [Panel 与外观](PANEL_EXTENSIONS.md)。

管理入口显示为“客户端”和“模型服务”：首屏为真实连接/服务概览，点击卡片或新建后进入独立编辑面板。两类编辑页均有顶部返回与底部取消，未保存时可保留或明确放弃。模型服务另分供应商、功能模型池和健康检测，减少编辑页内重复设置；全局池独立保存，支持手动上移/下移。接入帮助和未接入能力默认折叠，手机管理页收起最近流程导航以保留内容空间。明暗统一在“外观”选择，点缀固定鸢尾。

健康检测以六色浅光谱区分候选、近期成功与受阻原因，详情默认折叠。连接检查只读目录或 ComfyUI 服务状态；可选轻量保活默认关闭，仅本次 Core 服务有效，服务重启不续开。媒体验证先准备指定模型的真实创作草稿，用户点击原生成按钮后才调用，可能计费。供应商可停用/恢复，删除须影响预览与确认，并保护当前工作区的未完成/可恢复依赖。详见[模型服务](PROVIDER_SETTINGS.md)。

ComfyUI 供应商支持 API 图/v0/v1 模板导入、开放参数及表单预览。创作时按明确模板显示 LoRA 双权重、种子和其他控件，LoRA/更多参数默认折叠，检查更新保留用户已展开的区块；结果详情显示原 Run 的参数快照。节点检查需要单独开启供应商管理，执行权限不会自动获得管理能力；见 [ComfyUI 使用](IMAGE_GENERATION.md#comfyui-入口)。

## 能力总览

侧栏“总览”或 Iris 标志进入六类能力卡片：图片、视频、语音、音乐、转写、视觉。也可在已有工作台地址后添加 `/#overview` 直接定位，登录与刷新沿用现有标签页会话；普通入口与 Run 深链接继续保留原创作行为。

上方显示当前服务是否允许创作、图片/音频目录中的模型候选去重数，以及当前工作区的实际流程数。卡片分别呈现入口覆盖、已保存用途/功能池、当前候选和历史实测；标注用途与过去成功不等于现在可调用。实测记录只有在 owner 供应商管理已开启且读取成功时可见，其他会话标明“未提供记录”。读取失败显示未知，不当作零配置或成功；刷新不会读取远端模型目录或发起实测。

图片、语音、转写卡片仅在当前根、执行权限与实际候选满足时启用对应创作按钮，点击只打开真实草稿，不提交任务。语音与转写需要 v3 根；视频、音乐、视觉注明已有 CLI/DSH 入口及 Core Web/MCP 待接入范围。配置按钮只跳转已开启的模型服务页，不自动启用功能或改变授权。

“更多 Core 工具”默认折叠，列出裁剪/差异、视频抽帧、HTML 截图与提示词优化的实际入口和依赖。各卡片的详细说明与最近实测时间也默认折叠，保留白色主体及浅鸢尾六色点缀。刷新总览不会覆盖供应商编辑草稿；明确保存供应商设置后，总览与当前候选随之更新。

作品页仍按本工作区的 Run 及关联产物展示，不自动导入其他数据根或旧 DSH 资产。总览没有新增 API、权限、后台探测或数据格式。

## 启动与连接

需要 Node.js ≥22、项目现有依赖，以及已经初始化的专用 Flow 数据根。先确认图片流程是否已有记录；不要把 DSH 的普通 Core 根当作 Flow 根。

```bash
node bin/dsh-iris.js flow list --data-root /absolute/path/to/flow-root
node bin/dsh-iris.js web serve --data-root /absolute/path/to/flow-root --port 4173
```

首次打开输出的 **`loginUrl` 设置访问口令**，之后直接打开普通地址。默认“记住此设备”30天，刷新、新标签页与正常重启继续使用；退出后输入同一口令即可。无需读取 Termux 私有文件或粘贴 Token，也没有反复获取短时登录链接的步骤。

“退出登录”固定在页顶，滚动较长编辑页仍可操作；退出清除当前页面的连接配置导出、供应商草稿及健康详情，并沿用原会话撤销规则。退出不会删除作品、供应商配置或 MCP 授权，也不代表停止已经受理的媒体任务；服务级保活在服务关闭或显式关闭时停止。

忘记地址或口令时，在本机用同一数据根操作，**无需重启运行中的服务**：

```bash
node bin/dsh-iris.js web login --data-root /absolute/path/to/flow-root
node bin/dsh-iris.js web password reset --data-root /absolute/path/to/flow-root
```

重置会撤销全部工作台会话，返回新设置入口，保留作品、任务和 MCP 授权。初次设置入口没有10分钟倒计时，设置成功失效；尚未设置时重启会生成新入口。认证文件由 Iris 在私有目录管理，可显式 `--auth-store`。完整说明与旧 Token 模式见[工作台登录](WORKBENCH_LOGIN.md)。

若没有 Flow 根，可先在新的专用位置执行 `flow init`；初始化是显式写操作，不由工作台自动进行。导入、创建、生成和选择的命令见 [图片流程](IMAGE_FLOW.md)。读取已有作品不需要 Provider 配置；若需显示配置中的模型候选，显式添加 `--provider-config /absolute/path/to/providers.json`。候选存在不代表实测成功；打开页面不探测模型，管理开启后可主动读取目录。

默认随机端口，可用 `--port 4173` 指定。只监听 `127.0.0.1`，使用输出的完整地址，不能以 `localhost` 或代理 Host 替换。不会自动打开浏览器、启动 DSH 或重载其他进程。Ctrl+C 关闭。

保持相同数据根、认证目录、固定端口和连接目录，可保留设备登录与已经导出的 MCP 配置。显式 Token 参数保留兼容，不是普通工作台的必填项。插件加载、业务/页面选择与完整命令见[稳定启动](PLUGIN_STARTUP.md)；不是后台守护或自动恢复租约。

## 可用功能

- 从历史查看真实持久 Run、原图与已保存结果；刷新读取最新本地记录。
- 查看修改要求、状态和选择。详情及模型列表默认折叠，技术标识放在展开内容中。
- 在权限开启时改图、保存原图/结果选择；服务确认后才显示已选状态和启用下载。下载保留原始图片字节与格式。
- 切换历史、退出或重连。地址中的 Run 片段帮助重新定位，刷新后自动验证当前标签页保存的会话。
- 对已有待核对动作，重新认证后按原创建 Key、Operation 或 Run 只读接回；“操作核对”默认折叠，可重新核对和查看流程。恢复表只含有限身份，详见 [请求恢复](WEB_RECOVERY.md)。
- 作品页按全部、已选择或未选择进行服务器端筛选；计数和分页来自同一批真实记录，封面优先已选作品。只加载可见卡片预览，离开作品页释放预览 Blob。
- v3 工作区增加语音合成和音频转写；音频直接播放/下载，转写按纯文本显示和下载。作品页按图片、语音、转写分类；音频卡片明确载入后试听，不自动加载整页音频。原图片根保持原入口。

默认模式的媒体请求全部为 GET，创作与选择控件禁用并解释当前权限。刷新不查询外部任务、生成或修复数据；连接与供应商管理各有独立开关。

## 开始一次真实改图

完整创作需要新的专用 v1 根、明确的图片模型配置和独立选择开关：

```bash
node bin/dsh-iris.js flow init --data-root /absolute/new-core
node bin/dsh-iris.js execution init --data-root /absolute/new-core
node bin/dsh-iris.js web serve --data-root /absolute/new-core \
  --allow-execution --allow-selection --provider-config /absolute/providers.json
```

不要在已有 v0 创作根执行迁移；旧根仍可只读浏览或显式保存选择。Provider 配置格式见 [本地创建](LOCAL_CREATION.md)，配置候选不代表已实测。首次连接为空草稿，不预填演示作品或模型。

选择/拖入不超过 20 MiB 的静态 PNG/JPEG/WebP，明确选择模型、填写要求，可展开填写模型支持的输出尺寸。点击“开始改图”后依次保存素材、建立 Run、执行一次改图；三个步骤各保留自己的 Key，双击合并，任一结果未确认或用户已离开时停止后续提交。Run 输入固定，修改要求需新建流程；“用已选作品新建”只建立本地草稿，不生成。

切换流程时暂停执行、选择和复用，确认读到目标流程后再启用。读取失败时保持暂停，可重新读取或明确新建流程，不沿用上一流程的操作对象。

已接收 Operation 期间最多低频 GET 40轮；隐藏标签页、离开创作或读取出错即暂停，可点击“刷新”明确接回。Operation 结束后再读取 Run；它结束不代表图片一定完成。异步任务需明确点击“查看原任务”，每次仅观察一次；受理未知保留原任务，不提供自动重提。保存失败的原结果和本地比较使用对应明确按钮接回。

“停止等待”只停止原 Operation 的本地等待，不代表供应商取消、退款或未计费。选择采用当前 Run revision，冲突或回包丢失后读取当前选择，不自动覆盖。选择确认后可下载，实际保存位置和完成状态以浏览器下载记录为准。

## 显式媒体权限

`web serve` 与 `api serve` 使用相同的独立开关，不要求先开启连接管理：`--allow-local-writes` 开放零生成上传/创建；`--allow-execution` 同时开放创建与有限执行，需 v1/v2/v3 执行根及显式 Provider。`--allow-selection` 只开放 owner 图片持久选择，可直接用于已有 Flow 根，无需 Provider、创建请求区或执行器；音频单一结果无需选择。

```bash
node bin/dsh-iris.js web serve --data-root /absolute/path/to/flow-root \
  --allow-selection
```

开关不会自动补齐其他权限。会话的 `readOnly`、`workbenchMediaReadOnly` 和 `operations` 反映当前调用方的媒体 API 权限，页面据此启用控件。仅选择模式无需 Provider；完整改图需执行，单独本地创建模式仍可通过 API 上传/建 Run。owner 选择权限不授予连接客户端。版本冲突与输入限制见 [持久选择](LOCAL_SELECTION.md)。

## 显式开启连接中心

需要已主动初始化的 v1/v2/v3 执行根；新根的准备见 [Core 服务](CORE_SERVICE.md)和[音频流程](AUDIO_FLOWS.md)。不要转换已有根。指定专用根外管理目录（父目录须存在）：

```bash
node bin/dsh-iris.js web serve --data-root /absolute/new-core \
  --port 3182 \
  --allow-connection-management --connection-store /absolute/new-connection-store \
  --allow-mcp
```

目录为 0700、档案为 0600；首次只接受空目录，之后按 rootId 识别。管理目录与 Core 数据根相互独立，不改静态 grants 或客户端日常配置。目录自身只允许一个管理写者，复用现有租约。异常退出遗留租约时，先检查 `doctor --data-root /absolute/new-connection-store/ownership --json`，再按实际 stale PID 使用 `runtime recover`，不自动清锁。

连接页面支持自由命名、创建、编辑、撤销、删除和 stdio/HTTP 配置导出。图片生成与编辑分别选择；v3 根另开放语音和转写，视频、音乐、视觉标为未接入。工具细选默认折叠，操作权限与功能分开。默认只读服务只能分配 read；若要让 harness 导入、创建和执行，可在**同一个命令**显式增加 `--allow-execution --provider-config /absolute/providers.json`。执行服务会建立 runner 租约，接收/计费动作由用户或获授权客户端明确发起。连接管理不扩大媒体权限，owner 选择权限也不授予 harness。

“新建连接”会进入编辑面板，提示、定位并聚焦名称，准备未保存草稿；填写后点击“创建连接”才保存记录，随后进入接入配置。默认改图草稿只包含所选功能对应的工具，不夹带生图工具。UUID、桥版本等位于“详情与管理”；切换分组或返回列表会清除凭据/Skill预览，不自动导出。

创建不代表客户端已经加载。安装配置后，实际 MCP 客户端自报名称/版本会标记为“客户端声明”，桥版本独立记录；实例记录不保证进程持续在线。没有声明时显示未知，不扫盘推测安装状态。一个产品可按工作区创建多个连接。

页面按“创建连接 → 生成配置 → 客户端启用”说明接入。stdio 由客户端按导出的 command/args 启动本机桥接进程；HTTP 使用已开启的 `/mcp` 地址及连接专属密钥，页面显示本服务的实际 HTTP 开关。两种方式都需要 Iris 服务继续运行。按所选客户端合并JSON或TOML，也可手动映射字段；只接受单条配置时选择entry。界面登录Token不用作MCP密钥。默认read只能浏览，要绘图需同时选择图片功能、create与execute，且服务已开启执行。

“撤销连接”使旧配置失效但保留列表记录；“删除连接”经独立确认后使旧配置失效并移出列表，已撤销记录也能删除。两者都不删除作品、任务或已接收的操作，不取消远端生成，也不修改客户端配置。删除保留私有撤销档案和归档检查点，尚无界面恢复或永久清除入口；重放旧创建 Key 不会复活授权，详见 [存储与失败语义](CORE_CONNECTIONS.md#owner-连接中心)。

stdio 配置引用本机私有客户端文件；HTTP 配置含连接密钥，只有点击生成配置时返回，复制/下载后应私下保管。隐藏配置、离开连接页或断开会清除预览；下载后也清空文本。普通列表不含凭据。编辑授权会立即影响后续调用；扩大名单后，stdio 客户端需重新启动以注册新增工具，缩小或撤销后旧进程不能绕过 Core 校验。已接收 Operation 保留，不等同于远端取消或停止计费。详见 [连接契约](CORE_CONNECTIONS.md)与 [MCP](MCP.md)。

重复使用导出的配置时保持相同端口；服务改用其他端口后，需要重新导出并更新客户端。连接身份与撤销状态仍保留，旧配置不会自动寻找新端口。

“接入模板”提供通用、Claude Code、Codex和Kimi Code两种传输的8个显式预设；不检测安装、不扫描或改写用户文件。Codex预览/复制/下载原生TOML，其余按所选JSON结构交付，HTTP未开启时对应预设禁用。保留手动入口与单条entry。来源及步骤见[MCP首次接入](MCP.md#首次接入与客户端预设)。

展开“导入模板”也可下载示例并导入有界JSON：schemaVersion:0、标题、transport:stdio/http、format:mcpServers/entry/claude-json/codex-toml及可选HTTPS文档地址。导入保存到管理目录，相同内容不重复创建；旧文件与摘要不迁移。模板只选择传输与格式，不增加权限、不提供任意命令或代填凭据；内置预设不占自定义配额。

展开“连接专属 Skill”，按**已保存且当前有效**的工具生成英文说明（附中文标题），可预览并下载交付 JSON。说明与配置分开，下载不表示安装；按页面命令显式指定 Skills 目录，再在客户端确认发现。权限变化后重新生成/安装，现有本地修改受到保护。见 [安装与边界](CORE_SKILLS.md#连接专属-mcp-skill03-alpha)。

## 可选插件业务

通过 `--plugin-config` 或公开 SDK 显式装配的[多图对照板](CONTACT_SHEET.md)已有实际制作页：选择现有作品与布局，经 Core 持久 Operation 排成新 PNG，刷新按原 UUID 接回；“业务记录”由 Core 内建，缺少插件仍可查记录和预览原图。客户端页默认不选择插件业务，用户勾选准确版本并允许执行后，导出的标准 MCP 配置才开放通用业务工具。此入口不改变媒体只读开关；启用选择和生命周期见[稳定启动](PLUGIN_STARTUP.md)。

## 显式开启供应商设置

在启动命令中增加 `--provider-config /absolute/existing-private-providers.json --allow-provider-management`。owner 可从“模型服务”或“管理模型”配置媒体连接、主动读取目录或手填模型、确认用途后一次保存。Key 不回显，冲突保留草稿。见 [C3 使用与管理契约](PROVIDER_SETTINGS.md)。此开关不隐含创建、执行、选择或 MCP 权限。

## 会话与图片边界

默认口令模式的首次设置票据放在 URL 片段中，页面读取后清除 URL 片段，并暂存在当前标签页的 sessionStorage 以支持刷新后继续设置；设置成功后清除且票据失效。登录/设置只接受严格同源的有限 JSON，返回独立浏览器 Bearer，不返回私有 owner 控制令牌。口令使用异步 scrypt 保存派生值，浏览器会话摘要与期限由根外私有认证存储持久保存，最多32个有效会话；正常重启保留，不自动挤掉其他登录。

记住设备时，独立浏览器凭据保存在当前 origin 的 localStorage；未勾选则仅标签页 sessionStorage，期限分别30天/12小时。口令、owner 控制令牌和 MCP 密钥不进入浏览器存储。刷新和页面返回先只读验证；退出经服务确认后撤销会话、清除保存的登录和视图，释放图片 Blob。401 清除旧浏览器登录，业务 Run 身份保持；登录不生成媒体，存储不可用明确提示。旧 Token 模式继续使用原标签页会话与一次性链接，详见[登录边界](WORKBENCH_LOGIN.md#凭据边界)。

未确认动作的身份单独保存在有界 sessionStorage，绑定 origin 和稳定 rootId，不含 Token、Prompt 或文件。换根只丢弃旧客户端标识，存储不可用时提示内存模式；重连恢复仅 GET。未知创建核对成功后可打开原 Run，不自动首次执行；未完成请求需明确提供原输入后按原 Key 接回。

静态资源使用默认固定白名单、明确选中插件的固定 JS/CSS，或替代 Panel 清单，登录页不含私有数据。[组合插件挂载](PLUGINS.md#web-贡献和生命周期)共享当前主题、登录与 API；页面进入导航，设置默认折叠，作品区可选择匹配实际 MIME 的扩展预览，原生查看保持可用。只有可信同源模块适用，样式隔离不等于权限沙箱。

允许从其他页面顶层导航到公开首页；外站 fetch、iframe、资源与业务 API 不获得此例外。登录流程以外的 API、图片和下载仍要求 Bearer，保留 Host/Origin 与无 CORS 的约束。不提供任意目录、Provider 原配置或私有路径。供应商编辑投影仅在管理开启后对 owner 提供，含端点、不含 Key。图片只支持 PNG、JPEG、WebP，上限沿用只读 API 的 64 MiB。

下载成功只说明请求已交给浏览器，实际位置与完成状态以浏览器下载记录为准。像素差异描述变化程度，不是质量评分。

## 验证与下一阶段

源码验证使用隔离根与受控 Provider，不读取日常配置或进行付费生成：

```bash
node tests/local-web.mjs
node tests/workbench-auth.mjs
node tests/workbench-password-api.mjs
node tests/workbench-password-cli.mjs
node tests/panel-extension.mjs
node tests/plugin-panel.mjs
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

`--provider-workbench` 单独验证三类模型服务入口、独立模型池保存、连接检查/保活、验证草稿与一次真实 Core 夹具改图，以及供应商停用/恢复/删除、两类编辑取消、长页退出和390像素/桌面/明暗布局。配置与服务均隔离，无真实付费调用；API 与生命周期边界另运行 `node tests/provider-workbench-api.mjs` 和 `node tests/provider-monitor.mjs`。

`--plugin-panel` 单独装配独立测试插件，验证页面、默认折叠的设置表单、实际作品字节预览，以及共享会话/主题、只读权限、切页/退出/迟到清理和按阶段定位错误。使用隔离数据与配置，不加载个人背景或调用真实媒体服务；桌面 Chromium 的窄屏模拟不代替手机实机验收。安装插件本身不启用这些模块，实际接入见 [插件装配](PLUGINS.md#web-贡献和生命周期)。

`--image-generation` 单独验证新 v2 根的文生图、恢复与选择下载、能力选择及 ComfyUI 导入/HTTP 队列链路；ComfyUI 为受控响应，不能替代实际 GPU 出图。

`--comfyui` 单独验证 Core v1 模板导入/命名/预览、只读检查与失效、LoRA 候选及参数快照、原任务观察和历史参数查看，包含窄屏/主题/减少动画。使用同一验证脚本的 `--browser-executable`、`--output` 及适用的 `--no-sandbox` 参数；此项同样使用受控服务，不执行真实 GPU 推理。

`--panel-feedback` 单独验证默认新建连接的保存/导出、MCP 接入说明、手机定位、删除确认/取消/撤销后删除、供应商 ComfyUI 切换动画与自定义 API 草稿恢复，以及标签页刷新登录、退出、重启失效、坏缓存和禁用存储。使用隔离配置，不写日常预览数据；刷新与登录恢复只读，不提交媒体。

`--password-login` 单独验证默认口令登录：首次设置、重复口令校验、刷新/新页/正常重启、退出撤销/原口令再入、禁用存储/坏缓存、重置及设置/退出回包丢失；覆盖手机宽度/桌面/深色，不提交媒体或读取个人背景。

`--login` 验证旧 Token 模式：从其他页面点击一次性链接、片段清除、同标签页刷新、用过的链接提示、备用 Token、同页新链接、重启失效与新链接接回、取消迟到兑换、禁用存储和坏片段；不提交媒体或管理写入。与其他场景开关分开使用。

`--audio` 单独验证新 v3 根上的 TTS、音频导入/转写、原 Task 明确观察、音频实际解码/播放、WAV与UTF-8下载、刷新零重提、创建回包丢失、作品分类、只读以及桌面/窄屏/主题。Provider 使用受控响应，不等同于真实付费服务验收；边界与对应定向测试见[音频流程](AUDIO_FLOWS.md)。

`--overview` 单独验证六类能力、旧根/音频根与只读边界、四种草稿跳转、历史实测、未知/失败状态、刷新保留供应商草稿、明确保存后的同步和手机/明暗布局。使用隔离配置与受控执行端口，检查浏览/刷新与草稿跳转不写 Core、不调用供应商；不与其他场景开关组合。

源码已把 [有限执行](CORE_SERVICE.md)、[持久选择](LOCAL_SELECTION.md)、[原身份恢复](WEB_RECOVERY.md)、文生图及供应商设置接到真实页面，并补充本机受控验证。标准平台、真实设备和发布前完整验收仍待完成，历史完整门禁停滞继续单独调查；其他媒体和最终演示素材按 [路线图](ROADMAP.md)推进。本页实现未发布，也不等于生产环境或真实付费验收完成。
