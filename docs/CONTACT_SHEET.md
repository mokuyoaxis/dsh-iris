# 多图对照板：真实插件业务（0.3 alpha）

0.3.0-alpha.1随附可选插件 `@mokuyoaxis/dsh-iris/contact-sheet`。**稳定 npm 0.2.7 无此入口。** 它将现有 Core 图片离线排成一个新 PNG Artifact，不调用模型或供应商。安装不会启用或授权插件：Node 业务、Web 页和 MCP 连接分别显式选择。

## 启用

用当前源码或候选包的 CLI 初始化新的专用根，**在导入作品前**完成执行初始化；不转换已有根：

```bash
dsh-iris flow init --data-root /absolute/new-core
dsh-iris execution init --data-root /absolute/new-core
dsh-iris artifact import --data-root /absolute/new-core --input '{"image_path":"/absolute/first.png"}'
dsh-iris artifact import --data-root /absolute/new-core --input '{"image_path":"/absolute/second.png"}'
```

保存 `/absolute/startup.json`，明确选择内置实现、业务和页面：

```json
{
  "schemaVersion": 0,
  "entries": ["builtin:contact-sheet"],
  "operations": ["community.contact-sheet.create"],
  "panel": { "pages": ["community.contact-sheet.board"] }
}
```

```bash
dsh-iris plugins inspect --plugin-config /absolute/startup.json
dsh-iris web serve --data-root /absolute/new-core \
  --plugin-config /absolute/startup.json --port 3182 \
  --connection-store /absolute/private-connections --allow-connection-management --allow-mcp
```

首次打开输出的 `loginUrl` 设置访问口令，之后使用普通地址；记住设备可跨正常重启，退出后输入原口令即可。见[工作台登录](WORKBENCH_LOGIN.md)。此入口保持媒体只读，插件业务复用同一持久 runner；无需 Provider 或媒体执行开关。正常停止后可原样重复命令，保留同一端口、认证目录和连接目录。选择格式和退出行为见[稳定启动](PLUGIN_STARTUP.md)。Node 宿主也可沿用[公开 SDK 装配](PLUGINS.md#web-贡献和生命周期)。

## Web 与 MCP

左侧“多图对照板”读取现有图片，按点击顺序排列。最多16张，每行1–4张，单张边长128–512 px，页面提供128/256/512选项。支持每张8 MiB内 PNG/JPEG/WebP，单图解码最多4000万像素；目录可加载更多。

来源图库按数据根共享，可使用其他业务的合格图片。连接只选择本业务时，也可预览这些来源；其他业务的调用、历史和停止仍不开放。需要隔离图片时使用不同数据根。实际制作只读取本次明确选入的来源。

“制作对照板”先保存稳定 UUID 和准确依赖，取得 Core Operation 后只查询该记录。刷新会按原 UUID 接回，不重复制作。结果展示实际 PNG 并支持下载；关闭浏览器后仍可在 Core“业务记录”找回。

1. 打开“客户端 → 新建连接”，命名；只需此业务时可关闭媒体功能。
2. 勾选“插件业务 → 多图对照板”，再允许“执行流程”；读取/本地停止分别受 `read/stop` 控制。默认没有插件选择，旧连接不扩权。
3. 生成 stdio 或 HTTP 配置，交给支持对应传输的 MCP 客户端。Core 保持运行；stdio 只启动代理。
4. 调用 `iris_core_plugin_catalog` 取得准确依赖、输入 Schema 和现有图片 ID，再以稳定 UUID 调用 `iris_core_plugin_call({key,operationId,dependency,input})`。`input` 为 `{artifactIds,columns,cellSize}`，使用实际目录值。
5. 用 `iris_core_operation` 查询回执；响应丢失时用**原 UUID**调用 `iris_core_lookup`。成功后通过 `iris_core_image` 读取 `result.artifactIds` 的实际图片。

只选此业务并允许 `read/execute/stop` 时共有8个工具：连接控制2个，通用目录/执行2个，原 Operation/lookup/stop/image 4个；收窄权限后再过滤。不为每个插件复制工具 Schema。声明和参数来自 Core；instructions 与 Skill 不授予权限。插件的执行权限不开放原本只读的媒体 runner。

## 持久性与恢复

- 同一单根 runner、FIFO、租约保存 `plugin.execute`，绑定准确版本、完整 JSON 输入、摘要和来源作品。原 UUID 不单独复制入记录，通过派生身份查回；同 UUID 同输入返回原记录，改输入或依赖会冲突。
- Core 在写作品前保存输出 ID。成功表示业务返回且已发出的 Core 命令完成；使用 Core 的输出引用，不依赖插件自报 ID。
- 重启将遗留 queued/running 标为 interrupted，**不自动重做**；已经入库的部分作品仍在原记录。恢复插件后重用原 UUID也只返回原记录，需要重新制作时由用户明确新建操作。
- 缺失或不同版本插件不妨碍读原记录/作品，新执行明确失败。连接保留准确旧依赖可读历史，不自动换版本。
- 缩权让旧握手失效，阻止后续 Core 命令；不回滚已入库作品。仅关闭 MCP 客户端不撤销已接收操作的执行授权。强制退出后仍须确认已退出 PID，再用现有公开 CLI 显式恢复租约。

这是可信本机插件契约，非代码沙箱。该业务只使用公开 SDK 和现有 Sharp，无需数据根/存储句柄；同进程可信代码本身仍有 Node 权限。已验证真实 PNG、官方 MCP 客户端的 stdio/HTTP 与两代协议、浏览器选择/执行/刷新、插件缺失、准确版本、缩权及两个实际 SIGKILL 窗口；尚未承诺所有 harness 的附件展示。

参见[插件契约](PLUGINS.md)、[Operation](LOCAL_OPERATIONS.md)、[API 契约](LOCAL_API_CONTRACT.md)和 [MCP](MCP.md)。
