# Core 启动与插件启用（0.3.2）

通过 `--plugin-config` 启动参数，你可以使用纯 JSON 配置文件显式装载受信任插件、启用持久业务操作并挂载工作台页面，无需手写 Node 启动脚本。

> [!NOTE]
> - 仅使用内置媒体功能时，请直接参考 [Core 快速开始](CORE_QUICKSTART.md)。
> - 若要开发和打包自己的独立插件，请参考 [独立插件开发](PLUGIN_DEVELOPMENT.md) 与 [插件契约 v0](PLUGINS.md)。
> - **命令运行方式**：若通过 `npm install @mokuyoaxis/dsh-iris@0.3.2` 安装在本地项目中，命令不会自动进入全局 `PATH`，请在下方 `dsh-iris` 命令前加上 `npx`（即 `npx dsh-iris ...`）；若在已执行 `npm ci` 的源码仓库中运行，请将 `dsh-iris` 替换为 `node bin/dsh-iris.js`。

## 准备配置并启动

选择一个已存在的父目录（例如 `/absolute/iris`），在全新的专用数据根中依次完成 Flow 与执行初始化（必须在导入作品前完成初始化，旧数据根不会自动迁移）：

```bash
npx dsh-iris flow init --data-root /absolute/iris/core
npx dsh-iris execution init --data-root /absolute/iris/core
```

将以下内容保存为 `/absolute/iris/startup.json`（示例仅启用随包自带的[多图对照板](CONTACT_SHEET.md)）：

```json
{
  "schemaVersion": 0,
  "entries": ["builtin:contact-sheet"],
  "operations": ["community.contact-sheet.create"],
  "panel": {
    "pages": ["community.contact-sheet.board"]
  }
}
```

先列出随包内置入口并用 `plugins inspect` 检查配置：

```bash
npx dsh-iris plugins list
npx dsh-iris plugins inspect --plugin-config /absolute/iris/startup.json
```

`inspect` 会实际导入并激活所配置的**可信 Node 插件代码**，输出插件 ID、版本、Core 兼容区间、贡献清单与启用选择，随后立即释放资源；它不会启动 Core 服务、不会占用数据根租约，也不会创建 MCP 连接授权。

确认无误后，启动工作台、连接管理中心与 HTTP MCP：

```bash
npx dsh-iris web serve --data-root /absolute/iris/core \
  --plugin-config /absolute/iris/startup.json \
  --port 3182 \
  --connection-store /absolute/iris/connections \
  --allow-connection-management --allow-mcp
```

首次启动请打开终端输出的 `loginUrl` 设置访问口令，此后直接访问普通地址即可（详见[工作台登录](WORKBENCH_LOGIN.md)）。多图对照板处理的是当前 Core 根中已有的图片，可在启动前用 `artifact import` 导入（见[多图对照板用法](CONTACT_SHEET.md)），无需配置模型供应商或开启媒体 `--allow-execution`。

正常按下 `Ctrl+C` 停止服务后，可原样重复上述启动命令。只要保持相同的数据根、固定端口、认证目录、连接目录及所需的插件版本，已记住的浏览器登录态与已导出的 MCP 配置均继续有效。请勿对同一数据根同时启动两个执行服务（会返回繁忙错误而不会抢锁）；若进程被强杀遗留租约，请先核对进程状态，再按 [Core 服务](CORE_SERVICE.md)中的恢复命令显式释放。

## 查看插件状态（当前源码）

登录工作台后，点击左侧导航的 **插件** 页（只读诊断视图），可以集中核对：

- **加载与兼容信息**：插件卡片展示准确插件 ID、版本号与 Core 兼容范围，展开后可查看其声明的 Provider 协议、业务操作（Operation）、页面（Page）、设置（Settings）与预览器（Renderer）贡献。
- **服务启用状态**：分别展示某项业务是否已被当前服务启用（`operations`）、页面是否已选入当前工作台（`panel`）——加载代码本身不等于已启用或已授权。
- **客户端授权与握手对照**：清晰区分“插件版本不匹配”、“服务未启用该业务”、“连接缺少 `execute` 权限”、“未勾选 `iris_core_plugin_call` 工具”与“连接已撤销”。即使旧授权关联的插件在本次启动中未加载，原有依赖记录与原因也会如实保留，不会静默改绑到新版本或抹除记录。

点击页面上的“管理客户端授权”可直接跳转到连接中心。该页面不提供在线编辑启动文件、安装插件或热重载代码的功能；如需调整插件配置，请在正常停止服务后修改 JSON 文件并重启。若服务在启动阶段即告失败，请在终端查看输出的 `code`、`stage`、`file` 与 `field` 诊断信息。

## 启动选择文件格式（`plugins.json`）

启动配置文件必须是 ≤64 KiB 的普通 JSON 文件，拒绝未知字段：

| 字段 | 规则与含义 |
|---|---|
| `schemaVersion` | 必须为 `0` |
| `entries` | 必填数组：可填写内置标识（如 `"builtin:contact-sheet"`）或本地 `.js` / `.mjs` 文件的**绝对路径**（空数组表示不加载任何插件；拒绝相对路径、包名、远程 URL 或重复入口） |
| `operations` | 可选的完整业务 ID 数组：省略时不启动插件业务 runner；`[]` 仅接管/读取历史记录而不接受新业务调用；填入明确 ID 后开放对应业务执行 |
| `panel.pages` / `settings` / `renderers` | 可选、互不重复的完整贡献 ID 列表；省略的类别不挂载 |

- **严格校验**：启动时会在激活前校验插件版本、Core 兼容区间、贡献声明与静态资源文件；一旦引用了未知的业务/页面 ID 或资源缺失，启动将直接失败并指明具体阶段与字段，不会静默忽略。
- **参数互斥**：`panel` 组合挂载仅适用于默认 `web serve`（与整套替换界面的 `--panel` 参数互斥，`api serve` 的启动配置文件中不得包含 `panel`）。同时，`--plugin-config` 与旧版 `--provider-extension` 互斥，新版 Provider 插件应统一放入 `entries` 中由同一注册器装配。

## 登录与重启

默认情况下，`web serve` 使用访问口令模式，认证状态由 Iris 在根外私有目录管理（也可显式指定 `--auth-store /absolute/private-auth`，并在启动、`web login --data-root` 与 `web password reset --data-root` 时保持一致）。重置口令会撤销全部浏览器会话，但不会修改作品或 MCP 授权。

### 旧 Token 模式与 API 服务

`api serve` 仍要求传入 `--token-dir` 或 `--token-file`（二选一）；如果在 `web serve` 中显式提供了这两个参数，也会切换回旧版一次性链接 / Token 登录模式（此时不能与 `--auth-store` 混用）：

- **`--token-dir`（支持原命令重复启动）**：目录须位于 Core 数据根之外（父目录须存在，新建末级目录权限为 POSIX `0700`，拒绝符号链接）。每次成功启动都会在目录内排他创建新的 `session-<UUID>.token`（`0600`）并在终端输出其路径 `tokenFile`；旧文件保留以备审计，服务停止后旧会话即失效。
- **`--token-file`**：每次启动必须指向一个**尚不存在**的根外绝对路径，拒绝覆盖已有文件。
- **刷新登录链接**：在旧 Token 模式下，若一次性 `loginUrl` 已过期（10 分钟有效期），可在不重启服务的前提下使用当次启动的 `origin` 与 `tokenFile` 获取新链接：

```bash
npx dsh-iris web login --origin http://127.0.0.1:3182 \
  --token-file /absolute/iris/sessions/session-本次UUID.token
```

## 启用与授权分别进行

插件从加载到可被外部 Agent 调用，经过三道相互独立的关卡：

1. **`entries` 装载代码**：导入可信实现并将其贡献注册到能力目录。
2. **`operations` / `panel` 服务启用**：在当前 Core 服务上开启特定业务的持久化执行或挂载工作台页面（此时任何 MCP 连接仍默认无权调用，且启用插件业务不会连带开启媒体生图 `--allow-execution` 或供应商管理权限）。
3. **客户端连接显式授权**：在工作台 **客户端** 页面新建或编辑连接，勾选目标插件业务精确版本以及 `read` / `execute` / `stop` 权限，再导出 stdio 或 HTTP 配置交给客户端。

当服务关闭或启动失败时，CLI 会严格按照 **“HTTP 服务 / 任务 Runner → 写者租约 → 插件注册器”** 的顺序逆序清理资源。对于既有 Node 宿主，也可以直接使用公开的 [插件 SDK](PLUGINS.md) 进行程序化装配。
