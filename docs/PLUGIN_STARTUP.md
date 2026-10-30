# Core 启动与插件启用（0.3 alpha）

仅需媒体创作或首次连接 Agent 时，可先走 [Core 快速开始](CORE_QUICKSTART.md)；本页说明如何额外启用可信插件，不必先编写 Node 启动脚本。

使用0.3.0-alpha.1或当前源码；**稳定 npm 0.2.7 没有这些插件启动参数。** 本地安装可在下文 `dsh-iris` 前加 `npx`，源码树可替换为 `node bin/dsh-iris.js`。

沿用 `web serve` / `api serve` 启动一个明确数据根的 Core 服务。插件配置只决定加载与启用，不安装插件、不创建 MCP 授权。stdio MCP 启动的是连接此服务的桥接进程，HTTP MCP 使用同一服务的 `/mcp`；两者都需要 Core 继续运行。

## 准备一次，重复启动

选择已经存在的父目录，如 `/absolute/iris`。下面使用新的专用数据根；必须在导入作品前完成执行初始化，不迁移已有根：

```bash
dsh-iris flow init --data-root /absolute/iris/core
dsh-iris execution init --data-root /absolute/iris/core
```

将下面内容保存为 `/absolute/iris/startup.json`，它只启用随包[多图对照板](CONTACT_SHEET.md)：

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

列出随包入口并检查明确选择：

```bash
dsh-iris plugins list
dsh-iris plugins inspect --plugin-config /absolute/iris/startup.json
```

`inspect` 输出实际插件 ID、版本、兼容范围、贡献和启用选择；不启动 Core、不建立执行租约或连接授权。它会导入并激活**可信 Node 代码**，随后释放资源；不是代码沙箱，也不验证供应商、模型或 GPU。

启动工作台、连接管理与 HTTP MCP：

```bash
dsh-iris web serve --data-root /absolute/iris/core \
  --plugin-config /absolute/iris/startup.json \
  --port 3182 \
  --connection-store /absolute/iris/connections \
  --allow-connection-management --allow-mcp
```

首次打开输出的 `loginUrl` 设置访问口令，之后使用普通地址；“记住此设备”可跨刷新与正常重启，退出后输入原口令即可。见[工作台登录](WORKBENCH_LOGIN.md)。对照板使用已有 Core 图片；可在第一次启动前用 `artifact import` 导入，见[完整业务用法](CONTACT_SHEET.md)。它无需 Provider 配置或 `--allow-execution`；后者控制媒体流程，插件业务执行独立选择。

正常 Ctrl+C 退出后，可以原样重复启动命令。保持同一数据根、固定端口、连接目录和所需准确插件版本，已经导出的 MCP 连接继续有效。不要同时启动两个管理同一根的执行服务；冲突会报忙，不抢锁。强制退出后的租约恢复仍须先核对进程，再按 [Core 服务](CORE_SERVICE.md)的明确命令处理。

## 选择文件

| 字段 | 含义 |
|---|---|
| `schemaVersion` | 必须为 `0`；不自动迁移 |
| `entries` | 必填数组；已知内置引用或明确的本地 `.js` / `.mjs` 绝对路径；空数组不加载插件 |
| `operations` | 可选完整业务 ID 数组；省略不启动插件业务 runner，`[]` 接管历史但不开放新业务，明确 ID 才启用 |
| `panel.pages` / `settings` / `renderers` | 可选、互不重复的完整贡献 ID 列表；省略的类别不挂载 |

配置必须是最多 64 KiB 的普通 JSON 文件。不接受相对路径、包名、网络 URL、重复的实际入口或未知字段。外部插件由用户单独安装后，提供明确入口；CLI 不扫描磁盘、不查询市场、不自动执行安装。

加载会校验插件版本、Core 兼容范围、贡献和资源；未知业务/页面或缺失资源导致启动失败，不静默忽略。错误包含 `code`、`stage`、`file`，配置边界错误可附 `field`。兼容范围不是签名或隔离保证，仅加载可信插件。

`panel` 仅用于默认 `web serve`，与 `--panel` 整套 Panel 替换互斥。`api serve` 可使用同一启动机制，但其选择文件必须省略 `panel`。既有 `--provider-extension` 继续加载旧 Provider 工厂，与 `--plugin-config` 互斥；新插件的 Provider 从同一注册器装配，不能把新清单当成旧工厂。

## 登录与重启

普通 `web serve` 不需要 Token 参数。认证目录由 Iris 管理，可显式 `--auth-store /absolute/private-auth`；启动、取地址与重置时保持一致。用 `web login --data-root /absolute/iris/core` 取地址，`web password reset --data-root /absolute/iris/core` 重置口令并撤销全部浏览器会话。重置不修改作品或 MCP 授权；手机浏览器无需读取 Termux 私有文件。

固定 `--port` 可保留浏览器站点存储和已导出的 MCP 配置。CLI 保持前台运行，不自动注册后台服务、系统自启或更改客户端配置。认证存储单独取得写者租约，强杀后也需明确核对恢复。

### 旧 Token 模式与 API 服务

`api serve` 仍要求 `--token-dir` 与 `--token-file` 二选一；`web serve` 显式提供这两个参数时选择旧登录模式，与 `--auth-store` 互斥。目录位于 Core 数据根之外，父目录须存在；不存在的末级目录按 POSIX 0700 创建，已有目录须私有且不能是符号链接，不自动调整权限。每次成功启动创建新的 `session-<UUID>.token`，文件为 0600，并在输出中返回实际 `tokenFile`。

旧会话文件保留且内容不覆盖，旧 owner/浏览器登录在服务停止后失效；新启动打开新的 `loginUrl`。已经保存的 MCP 连接使用独立凭据，不依赖 owner Token 的轮换。目录不自动清理旧文件。

链接过期时，使用**本次启动**输出的 `origin` / `tokenFile` 获取新链接，无需重启：

```bash
dsh-iris web login --origin http://127.0.0.1:3182 \
  --token-file /absolute/iris/sessions/session-本次UUID.token
```

原 `--token-file` 行为保持：必须给新的根外文件路径，已有文件会拒绝覆盖。两种登录模式默认端口均为随机端口，需要稳定地址时主动指定固定 `--port`。

## 启用与授权分别进行

1. `entries` 装载可信实现，贡献进入实际目录。
2. `operations` 开放服务业务，`panel` 选择界面入口；不授予任何连接权限。
3. 在工作台“客户端”创建连接，选择准确插件业务与 `read/execute/stop` 中需要的操作权限，再导出 stdio 或 HTTP 配置；配置导入目标 harness 后才会连接。

媒体生图、改图、语音等仍使用原 `--allow-execution --provider-config ...` 及功能选择；上传/创建、持久选择、供应商管理各有独立开关。启用插件业务不连带开启这些媒体写权限。

启动失败或退出时，CLI 先关闭服务、任务 runner 和租约，再释放插件；插件清理异常会报告，但仍尝试其余清理。启动后的配置与模块不会热加载，需要明确停止、核对后重启。业务仍按原 UUID 和准确版本恢复记录，不自动重做；插件缺失或停用时可用 `entries:[]` / `operations:[]` 启动历史读取，原作品继续保留。

程序化装配仍可使用公开 [插件 SDK](PLUGINS.md)，适合已有 Node 宿主；CLI 启动不需要手写启动脚本。
