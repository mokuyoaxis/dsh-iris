# Wan Provider starter / 万相供应商模板

这是一个可独立复制运行的 Provider 插件模板，仅通过 `@mokuyoaxis/dsh-iris/plugins` 与包元数据（定位 CLI）接入 Iris，实现阿里云百炼 **Wan 2.6 异步文生图协议**，完全复用 Core 的凭据解析、网络出口路由、有界调度、Task 持久化与原任务恢复能力。

本模板依赖 **Iris `0.3.0`**（或 `0.3.0-beta.1+`）提供的 **Provider 工厂上下文 v1**（`PROVIDER_FACTORY_CONTEXT_VERSION === 1`）。

## Copy and check

将整个目录复制到 Iris 仓库之外的新路径，安装指定版本的 Core 后即可运行协议冒烟测试与完整闭环自检（全程使用本地回环模拟服务，无外部账号或付费调用）：

```bash
npm install --save-exact @mokuyoaxis/dsh-iris@0.3.0
node scripts/protocol-smoke.mjs
npm test
```

> [!NOTE]
> `private: true` 用于防止误发布示例包。发布自己的 Provider 插件前，请更新包名、插件/贡献 ID 与版本号，仔细核对兼容声明与打包清单后再移除该标记。

## Configure a new workspace

准备你的百炼地域 API 根地址（不要在末尾附加 `/api/v1` 或 `/compatible-mode/v1`），并通过环境变量导出 API Key（只将**变量名**传给初始化脚本）：

```bash
npm run setup -- \
  --directory /absolute/path/to/new-private-wan-workspace \
  --endpoint https://YOUR-WORKSPACE-API-ROOT \
  --credential-env YOUR_WAN_KEY_VARIABLE
```

`setup` 会在指定的**全新私有目录**中写入配置文件并初始化支持文生图的 Core 数据根，同时打印完整的 `web serve` 启动命令：

1. 启动服务并打开 `loginUrl` 设置工作台访问口令。
2. 在 **模型服务** 中查看注册进来的自定义协议，拉取或核对模型目录、显式确认模型用途并启用功能模型池策略。
3. 在 **客户端** 中按需勾选 **图片生成（image-generate）** 及所需权限，即可通过工作台或 MCP 发起文生图并支持重启后的原任务恢复。

## Supported protocol and limits

- **身份与版本**：插件 `example.wan-image` (`0.1.0`)、贡献 `example.wan-image.images` (`0.1.0`)，遵循 Plugin/Adapter 契约 v0 与工厂上下文 v1（二次开发时请一并更换 ID）。
- **模型目录**：请求 `GET /api/v1/models?capabilities=IG&page_no=…&page_size=100`（上限 1,000 行），仅暴露实际返回的 `wan2.6-t2i`。
- **异步生图与轮询**：通过 `POST /api/v1/services/aigc/image-generation/generation`（携带 `X-DashScope-Async: enable`、`messages` 文本、`n` 与可选 `width*height`）提交；缺少任务 ID 或响应异常时记为 **unknown acceptance**，绝不自动重提。轮询仅请求原 `/api/v1/tasks/{task_id}`。
- **安全下载与边界**：API 请求拒绝重定向，签名 CDN 下载通过 Core 借出的网络端口跟随重定向且不附带 API `Authorization` 头；下载 PNG 上限 8 MiB（JSON 上限 1 MiB），错误记录自动脱敏。
- **生命周期归属**：适配器不自建定时器、队列或网络池，所有请求统一使用 Core 传入的 `context.network.fetch` 并在对应方法内 `await` 完成。

上述协议行为基于 2026-11-03 核对的官方[万相文生图 API v2](https://help.aliyun.com/zh/model-studio/text-to-image-v2-api-reference)与[模型列表 API](https://help.aliyun.com/zh/model-studio/list-models) 实现；正式上线前请结合自己的真实账号与地域环境完成实测。
