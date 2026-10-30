# 工作台访问口令（0.3 alpha）

普通 `web serve` 使用一个访问口令，不要求账号、邮箱或读取 Token 文件。**稳定 npm 0.2.7 没有 `web serve`；下文针对0.3.0-alpha.1。** 源码树可把 `dsh-iris` 替换为 `node bin/dsh-iris.js`。

## 首次设置与日常使用

使用已有的专用 Flow 根；不要转换已有业务数据：

```bash
dsh-iris web serve --data-root /absolute/iris/core --port 3182
```

首次打开输出的 `loginUrl`，在网页中设置 8–128 个字符的访问口令。没有 10 分钟倒计时；设置成功后该设置入口失效。设置尚未完成时，服务重启会生成新的设置入口。初次链接允许设置访问口令，应私下保管。

之后收藏普通地址，例如 `http://127.0.0.1:3182`。默认勾选“记住此设备”30天，刷新、新标签页和服务正常重启后继续使用；不勾选时仅当前标签页保存，服务端会话最长12小时。保持相同数据根、认证目录和端口。浏览器清除站点数据、隐私模式或禁止存储时，可能需要重新输入口令；页面会说明存储限制。

默认 Panel 在首屏绘制前读取已保存的明暗主题；恢复登录期间显示同色的简洁过渡页，验证成功直接进入工作区，不先展示登录卡片。没有可用登录或验证失败时再显示表单与说明；入口资源加载失败提供重新加载。背景图继续在浏览器内异步读取，不上传到 Core。

“退出”经服务确认后撤销当前浏览器会话并清除本机保存的登录。退出后在同一地址输入原口令即可，无需找文件或向 Agent 取新链接。若退出请求尚未确认，页面保留状态并提示重试。已经接收的业务操作不因退出而取消。

## 忘记地址或口令

只需记住启动时的 Core 数据根，不需要查找凭据文件。在另一个本机终端执行：

```bash
dsh-iris web login --data-root /absolute/iris/core
dsh-iris web password reset --data-root /absolute/iris/core
```

`web login` 在已设置时返回普通登录地址；尚未设置时返回当前设置入口，不绕过已设置口令。`web password reset` 撤销全部工作台会话并返回新的设置入口；服务运行时无需重启，不修改作品、任务、供应商配置或 MCP 连接密钥/授权。服务正常停止后也可重置，下一次启动再打开输出的设置入口。不要把口令写在命令参数或聊天里。

认证目录默认是 `$IRIS_HOME/web-auth/<物理数据根的SHA-256>`，`IRIS_HOME` 默认 `~/.iris`。用户不需要打开该目录。可在启动、取地址及重置命令中一致指定 `--auth-store /absolute/private-auth`。它必须与 Core 根相互独立，使用私有真实目录，POSIX目录0700、文件0600；Android共享存储通常不适合保存此目录。

认证状态有独立写者租约。异常强杀后先核对原进程，再对 `<认证目录>/ownership` 使用现有 `doctor` 和明确的 `runtime recover` 流程；不会自动清锁或抢占实例。Core 执行根与连接目录的租约仍按各自契约处理。损坏、未知版本或属于其他根的认证状态明确报错，不自动覆盖。

## 凭据边界

口令只在同源登录请求中发送，服务端使用内置异步 scrypt、独立随机盐保存派生值，不保存明文。每次登录生成独立浏览器凭据，服务端只保存摘要和期限，最多32个有效会话。口令错误受有限速控制。

“记住此设备”将浏览器凭据保存在当前 origin 的 localStorage，普通模式使用 sessionStorage；不保存口令、owner 控制令牌或 MCP 密钥。继续使用 Bearer 而非共享本机端口的 Cookie，保留精确 Host/Origin、无 CORS 和现有 CSP。可信同源插件仍有页面脚本权限，只加载经过审查的模块；这不是不可信代码沙箱。

owner 控制记录仅在私有认证目录供本机 CLI 使用，浏览器会话和 MCP 连接均不能调用口令重置接口。MCP 使用连接中心导出的独立授权，浏览器登录不代替 MCP 配置。服务仍只绑定 `127.0.0.1`，没有新增公网监听、远程账户、SSO 或自动服务管理。

## 旧 Token 模式

显式提供 `--token-file` 或 `--token-dir` 时，`web serve` 保留旧的一次性链接和备用 Token 登录，服务重启后需新链接；与 `--auth-store` 互斥。`api serve` 继续要求 Token 参数，不默认开放口令登录。旧模式仍可使用 `web login --origin <实际地址> --token-file <本次文件>`。新默认方式不迁移或删除这些旧文件。

## 接口与装配

以下路径均位于 `/api/v0/workbench` 下，不接受查询参数；POST仅接受最多1024字节的 JSON。所有入口保留 Host/Origin 检查，不开放 CORS。

| 路径 | 方法与输入 | 身份与输出 |
|---|---|---|
| `/auth` | GET/HEAD，无正文 | 有限公开状态：`contractVersion:0, mode:'password', configured, authId, rememberDays, minPasswordLength, maxPasswordLength`；不返回私有路径或哈希 |
| `/setup` | POST `{ticket,password,remember}` | 严格同源，验证首次设置票据；返回独立会话 |
| `/password-login` | POST `{password,remember}` | 严格同源，验证访问口令；返回独立会话 |
| `/logout` | POST `{}` | 严格同源及当前浏览器 Bearer，幂等撤销；返回 `signedOut:true` |
| `/setup-link` | POST `{}` | 仅本机 owner 控制令牌；尚未设置时返回 `setupUrl` |
| `/password-reset` | POST `{}` | 仅本机 owner 控制令牌；重置后返回 `setupUrl` |

会话响应为 `{contractVersion:0, authId, accessToken, expiresAt, remember}`；`accessToken` 是浏览器会话，不能用于 MCP 或口令重置。未知字段、跨源请求、错误口令、过期会话或版本冲突明确返回对应错误，不自动降级到其他认证方式。正常退出只撤销提供的会话；已撤销会话可重复退出，便于丢失响应后重试。

Node 宿主用公开 `createCorePluginWorkbench` 时，显式传入 `workbenchAuth: { directory: '/absolute/private-auth' }` 才启用口令模式；未传时保持旧 SDK 行为。生命周期、媒体写权限和插件选择见[工作台](LOCAL_WEB.md)与[稳定启动](PLUGIN_STARTUP.md)。
