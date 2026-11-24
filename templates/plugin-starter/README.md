# Iris Plugin Starter · 独立插件模板

这是一个可离线运行的独立图片对照板插件模板：从 Core 作品库选取已有图片，拼合成新的 PNG 对照板并支持服务重启后按原 Operation 恢复，同时可按需授权给 MCP 客户端调用。不依赖任何模型供应商账号、GPU 或额外运行时依赖。

本模板拥有独立的包名、插件 ID、版本号、工作台页面与 PNG 预览器，底层拼图逻辑直接委托给 Iris 公开的 `@mokuyoaxis/dsh-iris/contact-sheet`（`0.1.0`）导出。

## Start · 开始使用

运行要求 **Node.js ≥22.1.0** 与 **Iris `0.3.0`**（或 `0.3.0-beta.1+` 兼容版本）。

将 `templates/plugin-starter` 复制到 Iris 仓库之外的新目录（如果基于已安装的 npm 包，则复制 `node_modules/@mokuyoaxis/dsh-iris/templates/plugin-starter`），然后安装 Core 并运行初始化：

```bash
cd /absolute/my-iris-plugin
npm install --save-dev --save-exact @mokuyoaxis/dsh-iris@0.3.0
npm test
npm run setup -- --directory /absolute/new-private-demo
```

`setup` 会在指定的**全新私有目录**中初始化执行根、导入两张纯色示例 PNG，并生成包含绝对路径的 `plugins.json` 及可直接复制运行的启动命令：

```bash
npm exec -- dsh-iris plugins inspect --plugin-config /absolute/new-private-demo/plugins.json
npm exec -- dsh-iris web serve --data-root /absolute/new-private-demo/core \
  --plugin-config /absolute/new-private-demo/plugins.json --port 3182 \
  --connection-store /absolute/new-private-demo/connections \
  --allow-connection-management --allow-mcp
```

打开输出的 `loginUrl` 设置工作台口令，进入左侧 **灵感对照板** 选择图片并点击 **制作对照板** 即可体验（插件业务与媒体 `--allow-execution` 独立控制，无需启用供应商）。

## MCP · 用户明确选择

在工作台 **客户端** 页面新建连接时，可按需取消普通媒体分组，仅勾选 `example.starter-board.create` 并授予 `read` + `execute`（可选 `stop`），导出配置给你的客户端使用。

连接成功后，先调用 `iris_core_plugin_catalog` 获取精确的 `dependency` 与可用图片 ID，再生成一次性的请求 UUID 调用 `iris_core_plugin_call`：

```json
{
  "artifactIds": ["artifact_<24 lowercase hex characters>"],
  "columns": 2,
  "cellSize": 256
}
```

- 参数范围：1–16 张图片（按传入顺序排列）、1–4 列、单格边长 128–512 px。
- 响应丢失或中断时请使用原 UUID 调用 `iris_core_lookup`；通过 `iris_core_operation` 查询状态，通过 `iris_core_image` 读取生成的 PNG 字节。

## Develop · 修改与生命周期

| File | Responsibility |
|---|---|
| `index.mjs` | 插件清单、兼容范围、声明的核心命令、版本与激活入口 |
| `web/board.mjs` | 复用工作台会话/API/主题、提交并按原 UUID 查回、清理监听与 Blob URL |
| `web/png.mjs` | 读取原 PNG 字节渲染预览并在卸载时释放 Object URL |
| `scripts/setup.mjs` | 调用公开 CLI 初始化演示工作区 |
| `scripts/smoke.mjs` | 使用临时隔离环境端到端验证 Core 与 MCP 流程 |

- **自定义身份**：二次开发前请替换包名、插件 ID（同步更新 `scripts/setup.mjs` 与测试断言），确保页面中引用自己的插件标识。所有浏览器 JS/CSS 资源须声明在清单中并保持自包含。
- **Core 托管契约**：本业务仅声明 `artifact.read` 与 `artifact.import`，并以 `artifactInputs: ['artifactIds']` 绑定来源图片；Core 负责参数校验、来源授权检查与持久化恢复。如果扩展中使用了后台连接或句柄，请在 `activate` 中通过 `context.onDispose()` 注册清理，并响应 `AbortSignal`。
- **多模态与零前端自动表单（0.3.3+）**：若自定义业务需要处理音频、视频、纯文本或 JSON 作品，可在清单中声明 `artifactInputTypes`（如 `{ audioId: ['audio'] }`）、`artifactOutputKinds` 与 `ui: { category, summary }`，并可声明只读命令 `artifact.lineage`。即使插件不编写任何前端 `pages` 代码，只要在工作台启用了该业务，宿主也会在 **本地工具 → 扩展业务** 中根据 `inputSchema` 自动渲染 CSP 安全的原生表单；自定义页面也可通过 `context.host`（`openRun` / `openArtifactLineage` / `sendToStudio` / `sendToLocalTool`）与 `api.artifacts` / `api.artifactLineage` / `api.musicModels` 与宿主无缝联动。
- **版本升级原则**：修改业务语义时同步升级插件/贡献版本；本模板显式锁定 `contact-sheet` `0.1.0` 以防无意跨版本变更。中断的 Operation 会保留为 `interrupted`，不会跨重启或跨版本自动重做。
- **信任边界**：插件 Node 模块与同源浏览器页面均属于受信任代码（Shadow DOM 用于样式隔离，并非安全沙箱）。

## Acceptance · 自检范围

`npm test` 会在独立临时目录中自动完成以下闭环验证（不修改日常配置，也不调用付费模型）：真实 PNG 生成、未授权拒绝、同 UUID 幂等与冲突拦截、同端口重启恢复、依赖版本变更校验、插件缺失保护以及权限缩减拦截。

对外发布自己的插件包前，建议移除 `private: true`，先用 `npm pack --ignore-scripts --dry-run --json` 审查打包内容，再在仓库外真实安装 `.tgz` 归档进行验证。完整 SDK 与启动规范见 [插件契约](https://github.com/mokuyoaxis/dsh-iris/blob/main/docs/PLUGINS.md) 与 [启动选择](https://github.com/mokuyoaxis/dsh-iris/blob/main/docs/PLUGIN_STARTUP.md)。
