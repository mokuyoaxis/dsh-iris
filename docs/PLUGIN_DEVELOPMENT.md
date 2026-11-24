# 独立插件开发与验收

Iris 提供了两套可独立拷贝运行的起手模板，帮助你快速构建并验证自己的插件：

- **业务 / 页面 / 预览器模板**：[`templates/plugin-starter`](../templates/plugin-starter/README.md) —— 展示如何通过公开 SDK 注册持久业务操作、Web 页面与 PNG 预览器（复用公开对照板实现）。
- **Provider 协议模板**：[`templates/provider-starter`](../templates/provider-starter/README.md) —— 展示如何基于工厂上下文 v1 实现万相 `wan2.6` 异步生图协议，接入环境变量凭据、Core 网络/调度与原任务恢复。

> [!NOTE]
> 两套模板均随 Iris `0.3.0`（及 `0.3.0-beta.1+`）分发；更早的 `alpha.1` 不包含模板与 Provider 工厂上下文 v1。

## 快速开始

将对应模板目录拷贝到 Iris 仓库之外的新路径，按模板内的 README 安装指定版本的 `@mokuyoaxis/dsh-iris`，然后运行自带测试与初始化脚本：

```bash
npm test
npm run setup -- --directory /absolute/path/to/new-demo
```

初始化脚本会使用公开 CLI 创建全新的私有演示目录（业务模板还会导入两张纯色示例 PNG，不依赖任何供应商账号），生成包含绝对路径的 `plugins.json` 启动配置，并打印可直接运行的 `web serve` 命令。你可以先用 `plugins inspect --plugin-config ...` 检查装配摘要与诊断信息（包含 Provider 能力、多模态业务及自动表单兼容摘要），再启动工作台。

## 三层显式控制模型

在 Iris 中，“加载代码”、“启用贡献”和“向客户端授权”是三个彼此独立的步骤：

| 层次 | 配置位置 | 作用说明 |
|---|---|---|
| `entries` | 启动配置 `plugins.json` | 导入并激活可信插件模块，校验 ID、版本与 Core 兼容区间 |
| `operations` / `panel` | 启动配置 / 启动参数 | 决定服务端挂载哪些 Web 页面、预览器，以及开放哪些可执行业务 |
| 连接授权 | Web 连接中心 / 授权文件 | 决定具体某个 MCP 连接可以读取、执行或停止哪些精确版本的业务 |

例如在业务模板中，只有当你在工作台连接页勾选 `example.starter-board.create` 并授予 `read` / `execute` 后，MCP 客户端才能通过 `iris_core_plugin_catalog` 看到精确依赖与输入 Schema，并调用 `iris_core_plugin_call` 执行（无需开启普通媒体生成权限）。

## 公开边界与生命周期规范

- **仅依赖公开导出**：插件代码只需导入 `@mokuyoaxis/dsh-iris/plugins`、`@mokuyoaxis/dsh-iris/contact-sheet` 以及包根 `package.json`（用于定位 CLI），不要直接引用 `lib/` 内部模块，也无需自建执行队列、存储或 MCP 服务。
- **持久执行与多模态来源校验**：带作品输入的业务通过 `artifactInputs` 声明来源字段，并可按需声明 `artifactInputTypes`（支持 `image`/`audio`/`video`/`text`/`json`）、`artifactOutputKinds` 与 `ui` 提示；未声明 `artifactInputTypes` 的旧插件默认仅限 ≤8 MiB 静态图片。Core 负责校验输入、权限与持久保存 `Operation` 和输出产物。不编写前端 `pages` 代码的业务也可直接通过工作台「本地工具 → 扩展业务」的宿主自动表单运行；自定义前端页面则可通过 `context.api`（含 `artifacts` / `artifactLineage` / `musicModels` 等）与 `context.host`（`openRun` / `openArtifactLineage` / `sendToStudio` / `sendToLocalTool`）深度集成。
- **版本语义纪律**：一旦业务的输入/输出或执行语义发生实质变更，请同步提升插件与贡献的版本号。Core 会在每条 `Operation` 中绑定精确版本；缺失或版本不匹配时，历史记录与产物依然可读，但中断操作不会被跨版本自动重做。
- **资源清理**：在 `activate` 中通过 `context.onDispose` 注册后端资源释放逻辑，并保证在停止所有 Core 服务/宿主之后再释放共享的 `registry`。
- **信任模型**：插件与页面模块属于受信任的本地代码（Shadow DOM 仅用于样式隔离）。如需了解 Provider 扩展的凭据与网络边界，请参阅 [Provider 最小契约](PROVIDER_PLUGIN_CONTRACT.md)、[插件契约 v0](PLUGINS.md) 与 [启动选择指南](PLUGIN_STARTUP.md)。

## 打包与包外验收

发布或分发自己的插件前，建议在独立环境中完成真实打包验证：

1. 运行 `npm pack --dry-run --ignore-scripts --json`，确认打包清单只包含插件代码、页面/CSS 资源与文档，不含演示数据根、密钥或私有文件。
2. 打出 `.tgz` 归档并在全新临时目录安装运行模板自带的自检脚本。

模板内置的自检流程会完整验证：加载未启用、未授权连接的权限拒绝、授权后的真实 PNG 产出、同 UUID 幂等与冲突拦截、同端口重启后的原记录恢复、版本变更拦截、插件缺失以及权限缩减边界。
