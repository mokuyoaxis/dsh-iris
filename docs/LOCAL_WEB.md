# 本地 Core 工作台（0.3.2）

Iris 的独立 Web 工作台（`web serve`）基于[本地 API](LOCAL_API.md) 构建，无需启动 DSH，即可在浏览器中完成模型服务管理、媒体创作、作品管理、网络配置与 MCP 客户端授权。

> [!TIP]
> 首次从零搭建请直接阅读[从零启动工作台](CORE_QUICKSTART.md)。本文汇总工作台的界面功能、启动开关、权限隔离与开发验证方式，作为完整参考手册使用。

## 界面概览

工作台默认采用白色主体与六色 105° 鸢尾渐变点缀，支持明暗主题、紧凑密度、浏览器本地自定义背景以及响应式手机布局。

- **能力总览**（`/#overview`）：集中展示六类媒体能力（图片、视频、语音、音乐、转写、视觉）的入口状态、当前去重候选数与历史流程数，并将裁剪、像素比对、视频抽帧、HTML 截图与提示词优化入口收纳在折叠区中。
- **创作与流程**：支持文本生图、基于已有作品改图、ComfyUI API 图/模板工作流（含 LoRA 双权重、种子等声明参数）、语音合成、音频转写、文生视频，以及（v5 根下）看图问答、长图 OCR 与视觉定位任务编排。开启 `--inbox-dir` 时可直接从只读收件目录选取静态图片与（v3+ 根转写模式下）音频导入；视觉定位命中后会在画布与放大弹窗中按照片显示方向（EXIF 1–8）叠加定位框，并支持像素坐标微调与零计费本地一键裁剪接续；同时可浏览多模态摘要（`summarize/v0`）与视觉定位历史。高级参数与流程细节默认折叠；待执行的看图/OCR 任务会保持设置展开以便核对分块与预算。
- **作品库**：按“全部 / 已选择 / 未选择”以及图片、语音、转写、视频分类展示当前工作区的作品与关联 Run，支持服务器端分页、原字节下载与多图比较（并排 / 叠图 / 放大）。

- **模型服务与健康光谱**：将供应商配置、六类全局功能模型池与健康检测拆分管理。六色浅光谱直观区分未配置、待验证、近期成功、认证失败、429 冷却与额度耗尽；支持可选的轻量服务级保活（默认关闭，不跨重启保留）。
- **网络出口与媒体调度**（按需启用）：配合 `--network-config` 与 `--allow-network-management` 管理出口节点、出口池及供应商绑定并运行进程内网络 Doctor（[网络工作台](NETWORK_WORKBENCH.md)）；配合 `--scheduler-config` 可在工作台显示远端容量、冷却与本地 HTTP 队列等待原因（[有界媒体调度](MEDIA_SCHEDULING.md)）。
- **客户端与插件**：通过“客户端”页集中创建、导出和核对 MCP 连接；当通过 `--plugin-config` 装配插件时，工作台还可加载[组合插件页面/设置/预览器](PLUGINS.md#web-贡献和生命周期)或整套[替代 Panel](PANEL_EXTENSIONS.md)。

### 从视频抽帧并创建摘要（0.3.2）

开启本地写入后，打开已保存视频的流程，展开结果中的“抽帧”。选择帧数（1–20）、目标宽度和 JPEG 或 PNG。抽帧在 Core 宿主用 `ffmpeg` 和 `ffprobe` 本地完成，生成的帧可以按时间查看和下载。

在 v5 根中可勾选本次抽取的帧，再点击“用所选帧做摘要”。选择视觉模型后可附上问题或已有字幕，点击“保存摘要任务”。核对帧数和模型后可显式点击“开始摘要”，执行需要开启 Core 执行服务。保存、断线接回与刷新均只访问本地 Core。摘要使用所选视觉流程，字幕由用户提供，结果可下载为 UTF-8 文本。丢失保存响应时，工作台会按原 UUID 查回已保存的草稿。

### 零计费本地工具与只读作品血缘（0.3.2）

- **本地工具页（侧栏「本地工具」或总览折叠入口）**：在同源工作台内提供三项零模型计费的确定性工具（写入操作均需显式开启 `--allow-local-writes`，只读模式隐藏提交入口但仍可预览原图几何）：
  - **任意矩形裁剪**支持分页选择工作区的 PNG/JPEG/WebP 静态图片，也可以从血缘直接打开较早的作品。画布与放大弹窗按 EXIF 方向（1–8）投影选区框，按原图像素坐标裁剪并保存 PNG。预览失败时可重读已保存的图片，也可下载或带入改图、看图、OCR 和定位草稿。
  - **双图差异热力图**允许选择两张工作区图片、配置网格（1–64）与最差区域数（1–100），按两张图的原始像素方向生成灰度热力图 PNG 和差异占比。浏览器缩略图按 EXIF 显示，结果会标出实际参与对比的两张来源图片。像素差异只描述图片变化，不代表质量评分。
  - **HTML / SVG 沙箱截图（显式启用）**：仅当启动 `web serve` 同时指定 `--browser-executable <Chromium 绝对路径>` 与本地写入开关时开放；未启用时显示配置提示且不发起请求。渲染在无网络、无脚本的严格 CSP 无头沙箱中单并发执行，结果 PNG 可直接下载、查血缘或送入裁剪/创作草稿；退出登录会清空源码输入区。
- **只读来源与派生血缘**：在流程详情上方新增默认折叠的「来源与派生血缘」区块（展开时才发起只读 `GET`），基于已有 `Artifact.relations` 与 `FlowRun` 引用展示上游流程、上游来源作品、直接派生作品（如裁剪图、热力图、视频帧）与下游关联流程，支持逐跳检视单件作品血缘并点击直达上下游流程，不迁移或改写任何已有磁盘记录。

## 启动与登录

启动前需要一个已初始化的专用 Flow / 执行数据根（切勿将 DSH 的常规 `core-v0` 目录当作独立 Flow 根）：

```bash
npx dsh-iris flow list --data-root /absolute/path/to/flow-root
npx dsh-iris web serve --data-root /absolute/path/to/flow-root --port 4173
```

> 本地项目安装 `@mokuyoaxis/dsh-iris@0.3.2` 时，`dsh-iris` 不会自动加入全局 `PATH`，请使用 `npx dsh-iris ...`；若从已执行 `npm ci` 的源码仓库运行，请将 `npx dsh-iris` 替换为 `node bin/dsh-iris.js`。

服务默认仅监听 `127.0.0.1`（不指定 `--port` 时使用随机端口），请在浏览器中打开终端输出的完整地址。

- **访问口令登录（默认）**：首次使用打开终端输出的 `loginUrl` 设置访问口令，此后直接访问普通地址即可登录。勾选“记住此设备”可保持会话 30 天（不勾选则在当前标签页保留 12 小时），跨正常重启继续有效。退出登录会撤销当前浏览器会话并清除页面内的临时配置/凭据预览。
- **找回地址与重置口令**：运行期间可在另一终端执行以下命令，无需重启服务（`web password reset` 会撤销所有浏览器会话，但保留作品、任务与 MCP 授权）：

```bash
npx dsh-iris web login --data-root /absolute/path/to/flow-root
npx dsh-iris web password reset --data-root /absolute/path/to/flow-root
```

完整登录机制、私有 `--auth-store` 目录及 Token 兼容模式，请参阅[工作台登录](WORKBENCH_LOGIN.md)。

## 创作流程与安全行为

在工作台点击生成或执行时，Iris 严格遵守以下幂等与防重提规则：

1. **分步保真**：发起改图等创作时，依次完成素材保存、建立 Run 与单次执行，每一步均持有独立请求 Key，防止双击重复提交。
2. **明确轮询与本地停止**：已接收 `Operation` 期间页面最多执行 40 轮低频 `GET`；切换标签页或离开页面会自动暂停，点击“刷新”即可恢复读取。**“停止等待”仅中止本地等待与轮询，不会取消或退款已发往供应商的远端任务。**
3. **不自动重提**：若受理状态或交付结果未知，工作台会保留原 Run / Task 身份并提供“查看原任务”（每次最多观察一次）或重新交付入口，绝不自动发起第二次计费生成。
4. **原身份重连恢复**：浏览器在同源 `sessionStorage` 中有限缓存未确认动作的 Key，重新认证或刷新后可在“操作核对”中只读接回原记录，详见[请求恢复](WEB_RECOVERY.md)。

## 显式权限开关

`web serve` 默认处于**只读浏览模式**，需要写操作或管理能力时需在启动命令中显式开启对应开关：

| 启动参数 | 开启的能力 |
|---|---|
| `--allow-local-writes` | 允许本地图片/音频导入与创建 Run（不触发生成） |
| `--allow-execution` | 允许媒体生成与执行（隐含 `--allow-local-writes`，需执行根与 `--provider-config`） |
| `--allow-selection` | 允许工作台所有者在 Run 上保存图片选择与下载（详见[持久选择](LOCAL_SELECTION.md)） |
| `--allow-provider-management` | 允许编辑供应商、模型用途与功能池（需 `--provider-config`） |
| `--allow-network-management` | 允许管理网络节点/池与运行网络 Doctor（需 `--network-config`） |
| `--allow-connection-management` | 开启“客户端”连接管理中心（需根外 `--connection-store`） |
| `--allow-mcp` | 在同端口开放 `/mcp` Streamable HTTP 端点 |
| `--inbox-dir <dir>` | 显式开放单层只读收件目录供工作台与已授权 MCP 连接选用静态图片（PNG/JPEG/WebP）与 v3+ 根音频（WAV/MP3/OGG/FLAC，工作台转写模式可选用；单件 ≤20 MiB，不跟随符号链接） |
| `--outbox-dir <dir>` | 显式开放单层可写受控出件目录供获授权的 MCP `outbox` 连接原子落盘作品（需同时开启本地写入、目标文件系统支持同目录硬链接、绝不覆盖已有文件） |
| `--browser-executable <path>` | 为工作台「本地工具」HTML 截图与已授权 `html-render` 的 MCP 连接显式指定无头 Chromium 可执行文件（默认关闭，不自动搜索宿主浏览器） |

## 显式开启连接中心

如需在工作台内创建并管理 MCP 连接，请指定一个**位于数据根之外**的专用私有目录作为 `--connection-store`：

```bash
npx dsh-iris web serve --data-root /absolute/new-core \
  --port 3182 \
  --allow-connection-management --connection-store /absolute/new-connection-store \
  --allow-mcp
```

- **权限与生命周期**：管理目录（`0700`/`0600`）首次需为空目录，之后与 `rootId` 绑定并拥有独立的写者租约。若遇异常强杀留下陈旧租约，请先用 `doctor --data-root /absolute/new-connection-store/ownership --json` 检查，再按 stale PID 执行 `runtime recover`。
- **连接管理操作**：支持自由命名、选择媒体分组（随数据根版本开放）、勾选 `read/create/execute/stop` 与细粒度工具，以及一键导出标准客户端预设（见[MCP 首次接入](MCP.md#首次接入与客户端预设)）或导入自定义纯数据接入模板。
- **撤销与删除**：“撤销连接”会使旧凭据失效并保留记录；“删除连接”经确认后会将其移出列表并归档撤销记录（不删除已有作品或历史操作，重放旧 Key 也不会复活授权）。
- **连接专属 Skill**：展开“连接专属 Skill”可根据当前有效授权工具生成定制化的英文说明（附中文标题），下载后通过 `skills install --bundle` 安装，详见[Core Skills](CORE_SKILLS.md#连接专属-mcp-skill03-alpha)。

有关连接身份与浏览器凭据隔离的更多细节，请参阅[连接契约](CORE_CONNECTIONS.md#owner-连接中心)与[登录边界](WORKBENCH_LOGIN.md#凭据边界)。

## 会话与图片边界

- **首次设置与口令会话**：默认口令模式的首次设置票据仅通过 URL 片段传递，页面读取后立即从地址栏清除，并在完成设置前暂存于当前标签页 `sessionStorage`；设置成功后即刻失效。口令仅经严格同源请求提交，服务端以异步 `scrypt` 保存派生值并在根外 `--auth-store` 维护最多 32 个活跃浏览器会话，不返回本机 owner 控制令牌。
- **浏览器存储隔离**：勾选“记住此设备”将独立浏览器 Bearer 存入当前 `origin` 的 `localStorage`（最长 30 天），不勾选则仅保存在 `sessionStorage`（最长 12 小时）；口令、owner 控制令牌与 MCP 连接密钥均不进入浏览器存储。点击退出会经服务端撤销会话、清除本地存储与预览 Blob；遇到 `401` 仅清除失效登录态，保留 Core 数据与任务记录。
- **恢复与同源安全约束**：未确认创作动作的身份单独保存在有界 `sessionStorage`（绑定 `origin` 与稳定 `rootId`，最多 8 条且不含 Token、Prompt 或文件），刷新核对全程使用只读 GET。除访问首页外，工作台 API、媒体路由与下载均强制同源与 `Host`/`Origin` 校验，不开放 CORS，必须携带 Bearer；组合插件（[插件生命周期](PLUGINS.md#web-贡献和生命周期)）或替代 Panel 仅加载可信同源模块。
- **媒体格式与体积上限**：交互创建/上传接收不超过 20 MiB 的静态 PNG/JPEG/WebP 图片；只读浏览与作品读取支持 PNG/JPEG/WebP，单件上限 64 MiB（音频与纯文本产物遵循各自流程上限）。下载完成路径与最终状态以浏览器自身下载管理器为准。

## 验证与下一阶段

仓库提供一整套基于隔离数据根与受控响应的单元测试与 Chromium 端到端验证脚本（不读取日常配置，也不产生付费模型调用）：

```bash
node tests/local-web.mjs
node tests/workbench-auth.mjs
node tests/workbench-password-api.mjs
node tests/workbench-password-cli.mjs
node tests/provider-settings.mjs
node tests/core-connection-store.mjs
node scripts/verify-local-web-browser.mjs \
  --browser-executable /absolute/path/to/chromium \
  --output /absolute/path/to/evidence-dir
```

<details>
<summary>完整 API 测试与 Chromium 场景验证开关清单</summary>

**其余单元测试**：`tests/panel-extension.mjs`、`tests/plugin-panel.mjs`、`tests/local-selection-api.mjs`、`tests/local-creation-lookup.mjs`、`tests/web-recovery.mjs`、`tests/web-media-api.mjs`、`tests/local-gallery-api.mjs`、`tests/connection-management.mjs`、`tests/connection-delivery.mjs`、`tests/provider-workbench-api.mjs`、`tests/provider-monitor.mjs`。

**`scripts/verify-local-web-browser.mjs` 场景开关**（按需单独启用，可追加 `--no-sandbox`）：
- 基础 / 连接与选择：`--connection-management`、`--allow-selection`
- 流程与恢复：`--recovery`、`--creation`、`--mode-closure`
- 供应商与面板：`--panel-c3`、`--provider-workbench`、`--plugin-panel`、`--panel-feedback`
- 媒体与登录：`--overview`、`--image-generation`、`--comfyui`、`--video`、`--audio`、`--vision`、`--locate`、`--summarize`、`--local-tools`、`--password-login`、`--login`

</details>

更完整的底层接口与版本演进参考，详见 [Core 服务](CORE_SERVICE.md)、[本地创建](LOCAL_CREATION.md)、[ComfyUI 使用](IMAGE_GENERATION.md#comfyui-入口)、[音频流程](AUDIO_FLOWS.md)、[视频边界](VIDEO_FLOWS.md) 与 [ROADMAP](ROADMAP.md)。
