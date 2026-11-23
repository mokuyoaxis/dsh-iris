# 工作台访问口令（0.3.2）

独立 Core Web 工作台（`web serve`）默认采用**单工作区访问口令**登录，无需配置账号、邮箱或手动拷贝 Token 文件。

## 首次设置与日常登录

使用已初始化的专用数据根启动工作台：

```bash
npx dsh-iris web serve --data-root /absolute/iris/core --port 3182
```

> 本地项目安装 `@mokuyoaxis/dsh-iris@0.3.2` 后不会自动写入全局 `PATH`，请通过 `npx dsh-iris ...` 执行 CLI；从已执行 `npm ci` 的源码仓库运行时，请将 `npx dsh-iris` 替换为 `node bin/dsh-iris.js`。

1. **首次设置**：在浏览器打开终端输出的一次性 `loginUrl`，设置 `8–128` 个字符的访问口令（设置成功后该链接立即失效；若尚未完成设置时重启服务，会重新生成新的设置链接）。
2. **日常访问**：设置完成后直接收藏并使用普通地址（例如 `http://127.0.0.1:3182`）。默认勾选“记住此设备”可保持登录 30 天，刷新或正常重启服务后无需重新登录；不勾选则仅保留在当前标签页（服务端会话最长 12 小时）。
3. **退出登录**：点击页顶“退出”会经服务端撤销当前浏览器会话并清除本地登录态与临时配置预览（不影响正在运行的后端任务）。再次访问时输入原口令即可进入。

> [!TIP]
> 保持固定的 `--data-root`、`--auth-store`（如已指定）与 `--port`，可避免浏览器的站点会话存储和已导出的 MCP 配置失效。

## 找回地址与重置口令

在另一个终端中执行以下命令即可查回地址或重置口令，**运行中的服务无需重启**：

```bash
# 查看当前登录地址（已设置时返回普通地址，未设置时返回设置入口）
npx dsh-iris web login --data-root /absolute/iris/core

# 重置访问口令并撤销所有活跃浏览器会话（保留作品、任务与 MCP 授权）
npx dsh-iris web password reset --data-root /absolute/iris/core
```

认证状态默认保存在 `$IRIS_HOME/web-auth/<物理数据根 SHA-256>`（`$IRIS_HOME` 默认 `~/.iris`），也可通过 `--auth-store /absolute/private-auth` 显式指定位于 Core 数据根之外的私有目录（POSIX 权限 `0700`/`0600`）。

认证目录同样持有独立的写者租约。若遇进程强杀遗留租约，请先核对进程状态，再对 `<认证目录>/ownership` 使用 `doctor` 与 `runtime recover` 恢复，切勿手动删锁。

## 凭据边界

- **口令保护**：口令仅在严格同源请求中传输，服务端使用异步 `scrypt` 与独立随机盐保存派生值，不落盘明文，并限制错误尝试速率。
- **存储隔离**：“记住此设备”将独立的浏览器会话 Bearer 保存在当前 `origin` 的 `localStorage`（不记住时使用 `sessionStorage`），不存储口令、owner 控制令牌或 MCP 连接密钥。服务端最多保留 32 个活跃浏览器会话。
- **权限分离**：工作台会话只控制网页登录态，不能调用本地口令重置接口（仅本机 CLI 通过私有认证目录可用），也不替代 MCP 客户端的独立授权。

## 旧 Token 模式

在 `web serve` 中显式传入 `--token-file` 或 `--token-dir`（与 `--auth-store` 互斥）时，可沿用一次性链接与备用 Token 登录模式（`api serve` 仍使用该模式）；服务重启后需通过 `web login --origin <实际地址> --token-file <当前文件>` 获取新链接。

## 接口与装配

默认工作台与替代 Panel 均通过下列 `/api/v0/workbench` 接口识别当前认证模式（`password` 或兼容 `token`）并装配登录状态。所有接口强制校验 `Host`/`Origin` 与同源策略（不开放 CORS，POST 请求体上限 1024 字节）：

| 路径 | 方法与输入 | 作用说明 |
|---|---|---|
| `/auth` | `GET`/`HEAD` | 返回当前认证配置与公开状态（`mode: 'password'`、`configured`、`rememberDays` 等，不含哈希与路径） |
| `/setup` | `POST {ticket, password, remember}` | 验证首次设置票据并初始化口令，返回浏览器会话 |
| `/password-login` | `POST {password, remember}` | 验证口令并返回浏览器会话 |
| `/logout` | `POST {}` | 撤销当前浏览器 Bearer 会话 |
| `/setup-link` | `POST {}` | 仅限本机 owner 控制令牌，未设置口令时获取 `setupUrl` |
| `/password-reset` | `POST {}` | 仅限本机 owner 控制令牌，撤销全部浏览器会话并返回新的 `setupUrl` |
