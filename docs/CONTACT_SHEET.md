# 多图对照板：真实插件业务（0.3.3）

`@mokuyoaxis/dsh-iris/contact-sheet` 是随 Iris 0.3.x 附带的内置业务插件示例：完全基于[公开插件 SDK](PLUGINS.md) 与 `sharp` 构建，可将当前 Core 工作区中已有的多张图片拼合为一张新的 PNG 对照板并保存为持久作品（离线运行，不依赖任何模型供应商）。

## 启用与启动

先在新的专用数据根完成执行初始化，并导入示例图片：

```bash
npx dsh-iris flow init --data-root /absolute/new-core
npx dsh-iris execution init --data-root /absolute/new-core

npx dsh-iris artifact import --data-root /absolute/new-core --input '{"image_path":"/absolute/first.png"}'
npx dsh-iris artifact import --data-root /absolute/new-core --input '{"image_path":"/absolute/second.png"}'
```

> 在本地项目中安装 `@mokuyoaxis/dsh-iris@0.3.3` 时，`dsh-iris` 不会自动加入全局 `PATH`，请使用 `npx dsh-iris ...`；从源码仓库运行时请改用 `node bin/dsh-iris.js ...`。

保存启动配置 `/absolute/startup.json`，随后检查并启动工作台（对照板无需媒体 `--allow-execution` 或供应商配置）：

```json
{
  "schemaVersion": 0,
  "entries": ["builtin:contact-sheet"],
  "operations": ["community.contact-sheet.create"],
  "panel": { "pages": ["community.contact-sheet.board"] }
}
```

```bash
npx dsh-iris plugins inspect --plugin-config /absolute/startup.json
npx dsh-iris web serve --data-root /absolute/new-core \
  --plugin-config /absolute/startup.json --port 3182 \
  --connection-store /absolute/private-connections --allow-connection-management --allow-mcp
```

首次打开 `loginUrl` 设置口令即可进入工作台（详情见[工作台登录](WORKBENCH_LOGIN.md)与[插件启动指南](PLUGIN_STARTUP.md)）。

## 在 Web 与 MCP 中使用

### Web 工作台

在左侧导航打开 **多图对照板**：
- 勾选当前工作区中的图片（每次 1–16 张，支持单张 ≤8 MiB、≤4000 万像素的 PNG/JPEG/WebP），设置列数（1–4）与单格边长（128 / 256 / 512 px）。
- 点击 **制作对照板** 会生成稳定请求 UUID 并持久化为 Core `Operation`；刷新页面可按原 UUID 接回结果，不会重复拼接。生成的 PNG 可直接预览下载，并在 **业务记录** 中随时找回。

### MCP 客户端

1. 在工作台 **客户端** 页面新建连接，勾选 **插件业务 → 多图对照板**，并按需勾选 `read` / `execute` / `stop`（仅使用对照板时可取消全部普通媒体组；完整授权下提供 8 个工具）。
2. 导出 stdio 或 HTTP 配置给客户端（保持 Core 运行）。
3. 调用 `iris_core_plugin_catalog` 获取精确 `dependency`、输入 Schema 与可用图片 ID，再以稳定 UUID 调用 `iris_core_plugin_call`：

```json
{
  "key": "<UUIDv4>",
  "operationId": "community.contact-sheet.create",
  "dependency": { "...": "来自 catalog 返回的精确依赖" },
  "input": { "artifactIds": ["artifact_..."], "columns": 2, "cellSize": 256 }
}
```

4. 通过 `iris_core_operation` 或 `iris_core_lookup` 查询回执，成功后用 `iris_core_image` 读取生成的 PNG 字节。

## 持久性与版本保护

- **幂等与防重放**：Core 在同一单写者队列中以 `plugin.execute` 保存完整输入、摘要、来源作品及精确插件版本；同 UUID 同输入重放返回原记录，更改输入或依赖会返回冲突。
- **中断与版本门禁**：服务重启会将未完成的任务标记为 `interrupted` 而不自动重做；若后续缺少插件或插件版本变更，历史记录与已入库 PNG 依然可读，但新执行会被拒绝，防止跨版本误恢复。
- **权限实时生效**：在连接中心缩权或撤销后，旧握手会立即失效（已入库作品不回滚）。如遇强杀遗留租约，请先确认进程已退出再使用公开 CLI 恢复。

更多契约细节请参阅 [插件契约](PLUGINS.md)、[Operation 规范](LOCAL_OPERATIONS.md)、[API 契约](LOCAL_API_CONTRACT.md) 与 [MCP 指南](MCP.md)。
