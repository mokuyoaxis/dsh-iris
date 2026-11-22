# 0.3.1 范围与兼容约定

本文汇总 **Iris 0.3.1** 的功能范围、数据边界与兼容性约定。发布细节见[发行说明](releases/0.3.1.md)，升级步骤见[升级指南](UPGRADING_0.3.md)。

## 功能范围与边界

| 模块 | 0.3.1 纳入能力 | 明确的边界与限制 |
|---|---|---|
| **启动与登录** | 独立 `web serve` 入口、首次口令设置、记住设备、退出与会话恢复；保留 Token 兼容模式 | 仅监听明确配置的回环地址；不扫描或修改其他客户端配置 |
| **模型服务** | 供应商增删改与停用/恢复、环境变量凭据引用、目录同步与用途确认、六类功能池 | 仅调用显式确认用途的模型，无跨请求自动轮转；不读取 `.env` 或其他宿主密钥 |
| **网络出口** | 独立 HTTP/HTTPS 节点、固定/有序出口池、供应商绑定、网络管理页与 Doctor 探测 | 未绑定时继承进程环境；显式出口失效时不悄悄回退直连；暂不支持 SOCKS、TUN 控制或分流规则 |
| **创作与作品** | 图片生成与编辑、ComfyUI 声明参数、语音合成、音频转写、固定文生视频、原件预览与下载 | 实际支持取决于所配服务与协议；Core 音乐持久流程与远端视频编辑待后续接入 |
| **视觉、OCR、定位与摘要** | 单图看图、长图 OCR（默认保守跨块边界去重 `boundary-overlap/v0`）、`locate/v0` 视觉定位（含 Web EXIF 精确 SVG 叠框、坐标微调与零计费一键裁剪）与 `summarize/v0` 多模态帧摘要（需 v5 根） | 保留部分完成、原始分块与实际调用数；OCR 去重尚未用真实付费模型重测原 7 请求长图；`complete` 仍表示分块执行覆盖而非校对保证 |
| **本地检视、收件目录与 HTML 截图** | 零计费 `local-media`（裁剪/像素对比热力图/视频抽帧）、显式 `--inbox-dir` 只读收件目录安全入库（MCP + Web）、显式 `--browser-executable` 无头沙箱 `html-render` | 不接受客户端任意宿主路径，不自动探测宿主浏览器；视频抽帧需 `ffmpeg`/`ffprobe`，HTML 截图依赖显式指定的 Chromium |
| **执行与恢复** | 单根单写者租约、持久 Run/Task/Attempt/Operation、有界媒体调度、原 UUID 恢复、`run_operations` 分页、`waitMs` 有界只读等待与本地停止 | 默认串行执行；`unknown` 受理或交付失败绝不自动重提；本地停止不代表远端停费 |
| **MCP 连接** | stdio 与 Streamable HTTP、8 种客户端预设、按功能/工具/scope 授权、配置导出与自检 | 不自动安装或扫描客户端；不聚合第三方 MCP 服务；旧冻结 12 工具连接清单不自动扩权 |
| **插件与 Panel** | 5 类贡献（Provider、业务、页面、设置、预览器）、共享工作台上下文、支持整套 Panel 替换 | 插件属于受信任代码（非沙箱/市场）；页面挂载不自动授予业务执行或 MCP 权限 |

相关详细文档：[从零启动](CORE_QUICKSTART.md) · [模型服务](PROVIDER_SETTINGS.md) · [网络工作台](NETWORK_WORKBENCH.md) · [媒体调度](MEDIA_SCHEDULING.md) · [MCP 指南](MCP.md) · [插件开发](PLUGIN_DEVELOPMENT.md)。

## 最小插件兼容面

0.3.x 冻结了以下窄兼容面，供外部插件与 Provider 开发者稳定复用；完整内部模块仍在继续演进：

- **Plugin / Adapter 契约 v0**：稳定的插件与贡献 ID、独立语义化版本、Core 兼容范围校验、显式启用与授权，以及绑定在 Operation/Task 上的精确版本依赖。
- **Provider 工厂上下文 v1**：Core 负责解析凭据并提供借用的 `fetch`，管理完整请求的生命周期与资源释放；插件不自行持有队列、存储或网络资源，并通过能力标记声明支持范围（详见 [Provider 最小契约](PROVIDER_PLUGIN_CONTRACT.md)）。
- **受控宿主上下文**：持久业务通过有限的 Core 命令与 Operation 执行；浏览器端页面、设置与预览器通过公开的上下文接口挂载。请注意，Node 插件与 Shadow DOM 均用于结构隔离而非安全沙箱。
- **版本变更纪律**：修改可观察的输入/输出契约、权限边界或依赖语义时，须同步升级插件或贡献版本号，避免旧记录错配恢复。

开发者可参考[独立插件模板](PLUGIN_DEVELOPMENT.md)与[万相 Provider 模板](../templates/provider-starter/README.md)（完整边界见 [Provider 最小契约](PROVIDER_PLUGIN_CONTRACT.md)）。请始终从 `package.json` 声明的公开子路径导入，避免直接依赖 `lib/` 内部文件。

## 运行环境与已知限制

- **Node.js ≥22.1.0**：0.3.x 要求 Node.js 22.1.0 及以上版本（已隔离确认 22.0.0 在原生 `fetch` 取消正文时存在连接未关闭问题，会残留调度名额）。
- **数据根隔离**：旧数据根不会自动迁移；音频（v3）、视频（v4）、视觉/OCR/定位/摘要（v5）与网络绑定均带有独立版本门禁，请勿使用旧版 CLI 写入新格式根。0.3.0 既有根可直接沿用至 0.3.1。
- **验证与质量范围**：
  - 0.3.1 已接入保守的 OCR 跨块边界重叠去重（`boundary-overlap/v0`，受控单测与 Core 回归通过），但尚未用真实付费模型重测 [OCR 四场景验证](OCR_VALIDATION.md) 中的原 7 请求长图样本；`complete` 仍代表分块执行覆盖而非全文校对。
  - 历史 Termux/PRoot 环境偶发 CLI 停顿问题仍在开放跟踪。
  - 原生 Windows/WSL 完整 DSH 宿主冒烟、真实 ComfyUI GPU 推理、以及所有第三方供应商/客户端的端到端认证未纳入本版承诺范围。
- **源码验收**：仓库内的 `npm test`、`npm run lint` 及 CI 打包验收（覆盖 Ubuntu/Windows 双 Node 22 矩阵、真实 tarball 消费、TypeScript `NodeNext` 校验与六组 Chromium 浏览器流程）用于开发与发布验证；正式用户安装 npm 包后无需运行这些开发脚本。
