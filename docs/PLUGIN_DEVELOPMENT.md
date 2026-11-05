# 独立插件开发与验收（0.3 beta）

当前源码提供两类可复制的独立项目。下面的 [`templates/plugin-starter`](../templates/plugin-starter/README.md)包含独立业务身份、Web 页面和 PNG 作品预览器，复用公开对照板实现；另有 [`templates/provider-starter`](../templates/provider-starter/README.md)，独立实现万相 wan2.6 异步协议并贯穿环境凭据、Core 网络/调度与原任务恢复。

**npm `0.3.0-beta.1` 包含这两个模板目录**。业务/页面模板沿用公开SDK；Provider模板使用beta.1的工厂上下文v1，并检查公开能力标记。旧alpha.1不包含模板，也不支持新的Provider工厂上下文。

## 从真实业务开始

复制模板到仓库之外的新目录，按模板 README 安装明确版本的 Core，然后运行 `npm test` 与新目录初始化。两张示例图为纯色 PNG，无个人素材，无供应商账号或模型调用。初始化脚本只创建新私有目录并通过公开 CLI 初始化；若目录已存在则拒绝，失败现场保留，不改已有根或迁移配置。

生成的启动选择文件使用插件入口的绝对路径。可先执行 `plugins inspect --plugin-config ...`，再按打印的参数启动 `web serve`。端口、数据根、连接目录和准确插件版本由使用者明确选择；不扫描用户磁盘或 harness，不自动重启服务。

## 三层选择

| 层次 | 决定什么 | 不代表什么 |
|---|---|---|
| `entries` | 导入并激活可信插件，校验身份、版本与兼容范围 | 不自动启用业务，也不创建客户端授权 |
| `operations` / `panel` | 服务可执行哪些业务，挂载哪些页面/预览器 | 页面挂载不授予任意 MCP 连接权限 |
| 连接的业务选择与 scopes | 哪个连接可读取、执行、停止哪些准确依赖 | 安装完成不表示客户端已连接或业务实测成功 |

用户在连接页选择 `example.starter-board.create` 并授予 `read`/`execute` 后，才向该连接提供业务调用。调用参数和精确 `dependency` 从实际 `iris_core_plugin_catalog` 获取。图片、视频等媒体组可以全部不选；这里执行的是独立图片业务，而非媒体生成流程。

## 公开边界与生命周期

模板只导入 `@mokuyoaxis/dsh-iris/plugins`、`@mokuyoaxis/dsh-iris/contact-sheet` 和公开 `package.json`（定位 CLI bin）。不引用 `lib/` 实现路径。它没有额外运行时依赖，也没有复制 Core 的执行队列、存储、认证或 MCP 服务。

业务使用公开 Core 命令读取来源、导入结果；来源字段显式声明为 `artifactIds`。Core 校验输入、来源资格和当前授权，持久保存 Operation/输出及准确插件依赖。页面使用共享 API、会话与主题，先保存 UUID 再提交，刷新只查原 UUID；卸载取消请求、清理监听/计时器/图片 URL。预览器读原始 PNG，不生成替代图片。

当前模板复用公开 `contact-sheet` 0.1.0，并明确检查该业务版本。它展示独立插件包的消费和装配，并非另一个原创绘图算法。改变业务语义应审查并提升独立插件/贡献版本；改变依赖实现不能沿用旧版本伪装兼容。Core 实例停止后才能释放共享 registry；新增真实后端资源时在 `activate` 内用 `context.onDispose` 注册清理。

插件是可信代码；有限 Core 命令、借用的 fetch 和 Shadow DOM 都不是任意 Node/浏览器代码的安全沙箱。两类模板都没有增加自动安装、热加载或通用私有设置存储。Provider 最小面、凭据与网络所有权见[审查清单](PROVIDER_PLUGIN_CONTRACT.md)；完整 SDK 冻结与发布仍另定，见 [SDK 契约](PLUGINS.md)与[启动选择](PLUGIN_STARTUP.md)。

## 包外验收

先检查 `npm pack --dry-run --ignore-scripts --json`，再打出真实插件包并在新项目中安装/解包测试。确认 Node 只通过安装的 Core 公开入口解析，页面和 CSS 资源确实进入插件包，且包中没有数据根、令牌、个人背景或仓库私有资料。

模板自检覆盖加载但未启用、连接未选业务、明确授权后的实际 PNG、相同 UUID 的幂等/不同输入冲突、同端口重启后的原连接与结果、版本变化、插件缺失与缩权。证据保留在新建临时目录，服务在 finally 中关闭。真实浏览器和包外制品另行验证，不能用静态 DOM 或协议夹具代替真实业务证据。

重启后保留原 Operation 和已提交的图片；未完成操作显示中断，不自动重做。缺少插件或版本不匹配时，新执行应拒绝，原历史与合格图片仍可按授权读取。业务执行的持久性不由前端或 MCP 客户端缓存提供。
