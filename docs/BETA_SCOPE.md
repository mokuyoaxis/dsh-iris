# 0.3.3 范围与兼容约定

本文汇总 **Iris 0.3.3** 的功能范围、数据边界与兼容性约定（[0.3.3 发行说明](releases/0.3.3.md)）。历史发行细节见 [0.3.2 发行说明](releases/0.3.2.md)，升级与回滚条件见 [升级指南](UPGRADING_0.3.md)。

## 功能范围与边界

| 模块 | 0.3.3 纳入能力 | 明确的边界与限制 |
|---|---|---|
| **启动与登录** | 独立 `web serve` 入口、首次口令设置、记住设备、退出与会话恢复；保留 Token 兼容模式 | 仅监听明确配置的回环地址；不扫描或修改其他客户端配置 |
| **模型服务** | 供应商增删改与停用/恢复、环境变量凭据引用、目录同步与用途确认、六类功能池 | 仅调用显式确认用途的模型，无跨请求自动轮转；不读取 `.env` 或其他宿主密钥 |
| **网络出口** | 独立 HTTP/HTTPS 节点、固定/有序出口池、供应商绑定、网络管理页与 Doctor 探测 | 未绑定时继承进程环境；显式出口失效时不悄悄回退直连；暂不支持 SOCKS、TUN 控制或分流规则 |
| **创作与作品** | 图片生成与编辑、ComfyUI 声明参数、语音合成、音频转写、持久音乐生成（`music/v0`，含 `retried-from` 重试血缘）、三类固定视频流程（文生 `video-generate/v0` / 图生 `video-i2v/v0` / 数字人 `video-s2v/v0`，含首帧与音频预览、本地均匀抽帧与一键取尾帧及跨模式一键接续草稿）、图片选择（Web 与显式 MCP）、只读来源/派生血缘视图、作品库 `T2V`/`I2V`/`S2V` 徽标与客户端快速筛选、一键复制 ID、原件预览与下载 | 实际支持取决于所配服务与协议；`music/v0` 严格单次提交不做隐式 502 重试；血缘视图为严格只读（不含收藏/标签/归档）；写入 0.3.3 新配方后旧版 0.3.2 不能就地读取，回滚需用升级前备份 |
| **视觉、OCR、定位与摘要** | 单图看图、长图 OCR（默认保守跨块边界去重 `boundary-overlap/v0`）、`locate/v0` 视觉定位（含 Web EXIF 精确 SVG 叠框、坐标微调与零计费一键裁剪）与 `summarize/v0` 多模态帧摘要（含 Web 视频抽帧创建，需 v5 根） | 保留部分完成、原始分块与实际调用数；2026-11-23 已在正式 `0.3.1` 归档上完成冻结长图 4 次真实视觉 POST 复测（CER `12.93%` → `0%`），但不外推至所有复杂排版或歧义重复；`complete` 仍表示分块执行覆盖而非校对保证 |
| **本地工具、收件/出件与 HTML 截图** | Web 零计费「本地工具」面板（EXIF 任意裁剪、双图差异热力图、本地 `ffmpeg` 音视频合轨 `media mux` 双源血缘 MP4、显式 HTML 截图、宿主托管插件 Schema 自动表单）与 MCP `local-media`（含 `iris_core_mux_video_audio` 与 `mode: "last"` 尾帧）；显式 `--inbox-dir` 只读收件目录（MCP + Web，含一键导入跨模式草稿）、显式 `--outbox-dir` 受控出件目录（MCP `outbox` + Web 内联一键落盘与总览文件列表）、显式 `--browser-executable` 无头沙箱 `html-render` | 不接受客户端任意宿主路径，不自动探测宿主浏览器；视频抽帧与音视频合轨需 `ffmpeg`/`ffprobe`（合轨上限 32 MiB），HTML 截图依赖显式指定的 Chromium，受控出件部署目录须支持同目录硬链接 |
| **执行与恢复** | 单根单写者租约、持久 Run/Task/Attempt/Operation、有界媒体调度、原 UUID 恢复（含 `video-s2v` 双源恢复）、`run_operations` 分页、`waitMs` 有界只读等待与本地停止 | 默认串行执行；`unknown` 受理或交付失败绝不自动重提；本地停止不代表远端停费 |
| **MCP 连接** | stdio 与 Streamable HTTP、8 种客户端预设、按功能/工具/scope 授权、配置导出与自检 | 不自动安装或扫描客户端；不聚合第三方 MCP 服务；旧冻结 12 工具连接清单不自动扩权 |
| **插件与 Panel** | 5 类贡献（Provider 含 `supportsVideoMode`、多模态业务含 `artifactInputTypes`/`artifact.lineage`、页面、设置、预览器）、宿主托管自动表单、共享工作台上下文、支持整套 Panel 替换 | 插件属于受信任代码（非沙箱/市场）；页面挂载不自动授予业务执行或 MCP 权限 |
| **DSH 原生插件** | 兼容 25 个经实测的准确 DSH 版本（`0.1.2-rc.1` 至 `0.2.2-rc.5`，含当前 `latest`） | Iris 自身最低 Node ≥22.1.0，DSH 0.2.2 宿主以宿主 Node ≥24.9.0 要求为准；`0.2.3-alpha.*` 暂未纳入 |

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
- **数据根隔离**：旧数据根不会自动迁移；音频（v3）、视频（v4）、视觉/OCR/定位/摘要（v5）与网络绑定均带有独立版本门禁，请勿使用旧版 CLI 写入新格式根。0.3.0–0.3.2 既有根可直接沿用至 0.3.3（写入 0.3.3 新配方后如需回滚，须使用升级前备份）。
- **验证与质量范围**：
  - 0.3.1 接入的保守 OCR 跨块边界重叠去重（`boundary-overlap/v0`）已于 2026-11-23 在正式发布的 `0.3.1` 归档上完成冻结长图 4 次真实视觉 POST 复测（[OCR 验证记录](OCR_VALIDATION.md)，去重前原始拼接 CER `12.93%` → 最终保存正文 CER `0%`，3/3 接缝合并）；但该单样本结果不外推至任意多栏/手写或歧义文档，`complete` 仍代表分块执行覆盖而非全文校对。
  - `--outbox-dir` 原子不覆盖发布依赖目标文件系统支持同目录硬链接（本机已在 Linux F2FS 实测并通过跨平台 CI）。
  - 历史 Termux/PRoot 环境偶发 CLI 停顿问题仍在开放跟踪。
  - 原生 Windows/WSL 完整 DSH 宿主冒烟、真实 ComfyUI GPU 推理、以及所有第三方供应商/客户端的端到端认证未纳入本版承诺范围。
- **源码验收**：仓库内的 `npm test`、`npm run lint` 及 CI 打包验收（覆盖 Ubuntu/Windows 双 Node 22 矩阵、真实 tarball 消费、TypeScript `NodeNext` 校验与九组 Chromium 浏览器流程）用于开发与发布验证；正式用户安装 npm 包后无需运行这些开发脚本。
