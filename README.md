<p align="center">
  <sub>简体中文 | <a href="README.en.md">English</a></sub>
</p>

<h1 align="center">
  <img src="docs/assets/logo/iris-wordmark.svg" width="320" alt="IRIS">
</h1>

<p align="center"><strong>给你的 Agent 一个多模态工作区。</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mokuyoaxis/dsh-iris"><img alt="npm version" src="https://img.shields.io/npm/v/%40mokuyoaxis%2Fdsh-iris.svg?style=flat-square"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 22.1.0 or newer" src="https://img.shields.io/badge/Node.js-%3E%3D22.1.0-339933.svg?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white"></a>
  <a href="https://github.com/mokuyoaxis/dsh-iris/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/mokuyoaxis/dsh-iris/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-1689FF.svg?style=flat-square"></a>
</p>

Iris 连接媒体服务、保存创作过程与作品，让 Agent 可以生成、修改、查看和继续使用媒体。它提供独立 CLI、DSH 原生插件，以及 0.3 的 Web 工作台与通用 MCP：供应商、任务和产物由 Core 管理，客户端按用户选择获得能力。

**本文面向 `0.3.0`，正式发行使用 npm `latest`。** 安装前核对准确版本是否已发行；发布准备期间使用源码或本地候选包，源码版本号不代表 npm 已经发布。0.3 汇总独立工作台、MCP、持久媒体与看图/OCR、网络出口、有界调度及显式插件。范围见[兼容约定](docs/BETA_SCOPE.md)与[发行说明](docs/releases/0.3.0.md)，从 0.2.7 或 beta 升级见[升级指南](docs/UPGRADING_0.3.md)。

0.3.0 还纳入 beta.3 后的 Agent 拒绝诊断、串行执行与只读恢复指引。OCR 重叠块尚未去重，完成状态不代表唯一全文；见[质量验证](docs/OCR_VALIDATION.md)。

| 你想做什么 | 使用入口 | 范围 |
|---|---|---|
| 在 DSH 对话中使用媒体工具与提示词优化 | [DSH 插件](#dsh-插件030) | 0.3.0，保留原生入口 |
| 在终端生成媒体、查任务、导出作品 | [独立 CLI](#独立-cli030) | 0.3.0，无需 DSH |
| 在独立页面配置模型、创作和管理作品 | [Core 工作台快速开始](docs/CORE_QUICKSTART.md) | 0.3.0 |
| 让其他 Agent 使用同一个媒体工作区 | [MCP 接入](docs/MCP.md) · [Agent 指导](docs/AGENT_CORE_QUICKSTART.md) | 0.3.0 |

## 工作台预览

白色界面与浅鸢尾点缀，支持明暗主题、本地背景、手机布局；常用操作直接呈现，高级参数和详情默认折叠。

![Core 创作页：真实流程、结果预览、选择与下载](docs/assets/screenshots/core-studio-preview.webp)

| 能力总览 | 功能模型池 |
|---|---|
| ![Core 总览：六类能力与实际入口](docs/assets/screenshots/core-overview-preview.webp) | ![Core 功能模型池：自动、手动与停用策略](docs/assets/screenshots/core-model-pools-preview.webp) |
| **能力光谱与连接检查** | **MCP 能力与操作权限** |
| ![六类功能的能力光谱与可选保活](docs/assets/screenshots/core-spectrum-preview.webp) | ![客户端按图片能力与操作范围授权](docs/assets/screenshots/core-connections-preview.webp) |

> 当前源码的真实界面，使用独立演示工作区和此前受控回放的作品；本轮重拍没有调用付费模型或 ComfyUI GPU。使用内置主题，未包含个人背景。窄屏、暗色及来源说明见[完整截图画廊](docs/screenshots.md)。

## Iris 能做什么

- **媒体与视觉**：图片生成/编辑、视频、音乐、语音、转写、看图、OCR，以及裁剪、差异分析、视频抽帧、HTML 截图等本地工具。各入口覆盖不同，见下表。
- **功能模型池**：六类功能可选自动、手动有序名单或停用。自动池只使用已确认用途且符合条件的模型；按稳定顺序优先选择，明确未受理时才安全切换，已有任务按原绑定恢复。
- **留住创作过程**：Core 保存任务、作品与固定流程；可检查原请求、取回结果、保存图片选择，再用于后续创作。受理未知不自动再生成。
- **Agent 自选能力**：MCP 连接按媒体、操作权限和工具选择；stdio 与 Streamable HTTP 共用 Core，支持通用入口及显式客户端模板。
- **可选插件**：Provider、新业务操作、页面、设置表单和作品预览可由插件贡献，Core 校验和装配，用户决定授权。随包多图对照板展示一次完整的持久业务。

开发者可从[独立插件模板](docs/PLUGIN_DEVELOPMENT.md)开始：业务/页面/PNG 预览模板复用公开 SDK；[万相 Provider 模板](templates/provider-starter/README.md)使用工厂上下文 v1，复用 Core 凭据、网络、调度及持久任务。插件身份、贡献版本和授权均独立管理；本版保留最小兼容面，完整 SDK 与内部模块继续演进。

旧数据根不自动迁移；视频需要 v4/v5 根，看图/OCR 需要新 v5 根，网络绑定也有独立版本门禁。平台测试、受控服务和真实账号验证分别说明，不据此承诺所有供应商、GPU 或客户端均已验收。

### 当前入口覆盖

| 能力 | DSH / 独立 CLI（0.3.0） | Core Web / MCP（0.3.0） |
|---|---|---|
| 图片生成、导入与编辑 | 可用 | 可用；新根支持文生图 |
| 语音合成、音频转写 | 可用 | v3/v4/v5 根可用 |
| 文生视频 | 可用 | [v4/v5 根可用](docs/VIDEO_FLOWS.md) |
| 单图看图、长图 OCR | 可用 | [新 v5 根](docs/VISION_FLOWS.md)；Web/MCP/CLI 保存后明确执行，可查看及下载结果；重叠块未去重 |
| 图生视频、S2V、音乐 | 可用，取决于服务与本地依赖 | 模型服务可配置；创作入口待接入 |
| ComfyUI 工作流与开放参数 | 可用；需配置受支持的工作流 | 已实现；真实 GPU 推理待验收 |
| 多图对照板插件 | 使用独立 Core 插件入口 | 显式启用后可用 |

“可用”表示有对应入口，仍需受支持的协议、模型和权限。目录列出、配置候选、连接可达和媒体实测是不同事实；语音及 ComfyUI 的开发验证包括受控服务，不据此承诺任意上游兼容。

## 快速开始

### Core 工作台（0.3.0）

以下安装命令用于已发行的准确版本；发布前使用源码或本地候选包。选择**新的私有位置**，现有工作区不自动迁移：

```bash
npm install @mokuyoaxis/dsh-iris@0.3.0

IRIS_PREVIEW="$HOME/.iris/preview"
mkdir -p "$IRIS_PREVIEW"
npx dsh-iris flow init --data-root "$IRIS_PREVIEW/core"
npx dsh-iris execution init --vision --data-root "$IRIS_PREVIEW/core"
npx dsh-iris config init --provider-config "$IRIS_PREVIEW/providers.json"

npx dsh-iris web serve \
  --data-root "$IRIS_PREVIEW/core" --auth-store "$IRIS_PREVIEW/auth" \
  --provider-config "$IRIS_PREVIEW/providers.json" \
  --allow-provider-management --allow-execution --allow-selection \
  --connection-store "$IRIS_PREVIEW/connections" \
  --allow-connection-management --allow-mcp --port 3182
```

在源码目录使用 `npm ci` 安装锁定依赖，并把 `npx dsh-iris` 换成 `node bin/dsh-iris.js`。正式发行更新 `latest`，预发布继续使用各自渠道；需要可复现配置时保留准确版本。

`--vision` 在新根启用 v5，包含图片、语音/转写、文生视频和看图/OCR 流程；它不选择模型、不调用服务，也不转换已有工作区。已有根继续按原能力使用。

首次打开输出的 **`loginUrl` 设置访问口令**，以后用普通地址。默认记住设备，刷新及正常重启后可继续；退出后输入原口令即可。手机无需读取 Termux 私有文件。

在“模型服务”添加连接、读取或手填模型并确认用途；在“功能模型池”选策略，再去“创作”生成作品。启动、配置和读取目录不生成媒体，点击生成才调用上游，可能计费。

在“客户端”新建连接、选择能力与权限，生成适合客户端的 MCP 配置后合并到其设置。**Core 保持运行**；stdio 启动桥接进程，HTTP 使用同一服务的 `/mcp`。模板不自动安装客户端或增加权限，导出的连接配置需保密。

完整的登录、恢复、参数解释和 Agent 示例见 [Core 快速开始](docs/CORE_QUICKSTART.md)。插件由[启动选择文件](docs/PLUGIN_STARTUP.md)另行启用；不扫描用户磁盘或自动安装代码。

### DSH 插件（0.3.0）

先核对 `dsh --version`、Node.js ≥22.1.0 与 PATH 中的 `pnpm`。Iris 0.3.0 沿用[兼容矩阵](docs/DSH_COMPATIBILITY.md)中的 12 个准确 DSH 版本；未列出的版本需另行核实。

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.3.0
dsh web
```

在“设置 → Iris 工作台”引用 DSH 已有 API Key 连接或添加服务，选择协议、确认模型用途与功能池。原生 DSH 模式使用宿主路由、附件和生命周期，不要求另起 Core Web 服务；提供 17 个 Agent 工具和对话框 🫧 提示词优化。

包升级不迁移数据根、不扩大宿主版本范围，也不自动新增模型用途或权限。需要保留旧环境时继续固定历史版本和对应数据根。

配置后的最小指令：

```text
使用 iris_draw_image：画一只坐在蓝色窗边的白猫。
用 Iris 生成一首复古摇滚配乐，保存为音频作品。
```

操作步骤见[用户指南](user_guide.md)，给安装 Agent 的提示见 [Agent 简要 Prompt](docs/AGENT_QUICKSTART.md)。升级后需正常重载插件后端并刷新客户端；不要让 Agent 擅自重启其他任务。

### 独立 CLI（0.3.0）

在自己的项目中安装，无需 DSH：

```bash
npm install @mokuyoaxis/dsh-iris@0.3.0
npx dsh-iris --help
```

显式指定 `--data-root` 与私有 `--provider-config` 完成媒体生成、任务检查和作品导出，见 [Headless CLI](docs/HEADLESS_CLI.md)。CLI 的 [`iris-core` Skill](docs/CORE_SKILLS.md)可显式安装到已确认的 Skills 目录；MCP 连接另有按授权生成的专属 Skill，两者用途不同。

安装和市场搜索请保留完整 scoped 包名 **`@mokuyoaxis/dsh-iris`**；无 scope 的 `dsh-iris` 是另一款插件。

## 配置与数据

- Iris 不默认扫描其他项目或客户端。DSH 可[引用宿主 API Key 连接](docs/DSH_PROVIDER_CONNECTIONS.md)，Core 工作台管理自己的媒体服务；聊天订阅/OAuth 不等于媒体 API 认证。
- beta.1 可选[环境凭据引用](docs/PROVIDER_CREDENTIALS.md)，只保存变量名、由 Core 进程解析值；原内联 Key 继续可用。
- 旧名单、缺失/空分配不会因升级静默启用。新增目录模型须确认用途；手动空池不回落到自动。详见[功能模型池](docs/FUNCTION_MODEL_POOLS.md)。
- 旧 ai-paint 配置可用 `IRIS_IMPORT_WORKBENCH_CONFIG` 显式指定来源，操作见[一次性导入](user_guide.md#从旧工作台显式导入)；它不修改来源或持续同步，也不迁移 Core 数据根。
- DSH 数据位于 `$DSH_HOME/iris/v1/`，媒体 Core 根为其中的 `core-v0`；独立 CLI/Web 使用明确选择的根。新工作台不会自动汇入其他根的作品。
- 同一数据根只有一个写者，实例内按队列执行；只读检查可共存。作品库不是备份，没有自动磁盘配额或 GC。删除、恢复与旧任务依赖需按对应命令明确操作。
- beta.1 可在 Core 服务显式启用[有界媒体调度](docs/MEDIA_SCHEDULING.md)：保持单写者，分别限制 HTTP 并发、发送速率和远端未结束任务；缺省仍串行，未知受理不重提。
- 密钥与认证文件保存在私有目录，POSIX 文件通常为 `0600`、目录为 `0700`；Windows 仍依赖账户与 ACL。公开配置/截图不应含认证链接或密钥。工作台口令、MCP 连接密钥和供应商 Key 分别管理。

Node.js ≥22 和可加载的 `sharp` 是基础要求。视频抽帧需 `ffmpeg`/`ffprobe`；HTML 截图需所选浏览器后端，DSH 宿主服务与独立 Chromium 的要求不同。Termux/PRoot 的数据应放在支持所需权限与 hard link 的私有 Linux 文件系统。

## 实际生成与 DSH 展示

<p align="center">
  <img src="docs/assets/examples/iris-flower-generated.webp" width="520" alt="Iris 实际生成的蓝紫色鸢尾花">
</p>

> 历史真实生成：从“鸢尾花”开始，Iris 使用 `deepseek-v4-flash`（thinking off）优化 Prompt，再由百炼 `qwen-image-3.0-pro` 生成 2048×2048 图片。不是本轮受控回放的上游实测。

<details>
<summary>Android 16 / Termux 中的 DSH 原生界面</summary>

| 对话提示词入口 | 优化后写回草稿 |
|---|---|
| ![DSH 提示词优化入口](docs/assets/screenshots/prompt-general-before.webp) | ![优化后写回输入框](docs/assets/screenshots/prompt-general-after.webp) |

![DSH 图片任务成功详情](docs/assets/screenshots/image-task-succeeded.webp)

这些是 Android 浏览器访问 Termux/PRoot Debian ARM64 中 DSH 的历史真机截图，使用宿主默认皮肤。[完整流程与来源](docs/screenshots.md)。

</details>

## 文档与开发

| 主题 | 文档 |
|---|---|
| 开始使用 | [Core 快速开始](docs/CORE_QUICKSTART.md) · [Agent Core 指导](docs/AGENT_CORE_QUICKSTART.md) · [DSH 用户指南](user_guide.md) · [CLI](docs/HEADLESS_CLI.md) |
| 工作台与接入 | [登录](docs/WORKBENCH_LOGIN.md) · [Web](docs/LOCAL_WEB.md) · [MCP](docs/MCP.md) · [Skills](docs/CORE_SKILLS.md) |
| 模型与流程 | [供应商/模型池/光谱](docs/PROVIDER_SETTINGS.md) · [图片与 ComfyUI](docs/IMAGE_GENERATION.md) · [语音/转写](docs/AUDIO_FLOWS.md) · [任务语义](docs/TASK_SEMANTICS.md) |
| 扩展 | [插件契约](docs/PLUGINS.md) · [启动选择](docs/PLUGIN_STARTUP.md) · [Panel](docs/PANEL_EXTENSIONS.md) · [多图对照板](docs/CONTACT_SHEET.md) |
| 版本与方向 | [0.3.0 发行说明](docs/releases/0.3.0.md) · [升级指南](docs/UPGRADING_0.3.md) · [0.2.7 历史发行](docs/releases/0.2.7.md) · [CHANGELOG](CHANGELOG.md) · [ROADMAP](docs/ROADMAP.md) · [架构](docs/ARCHITECTURE.md) |

DSH 随包保留 [`iris-use`](.dsh/skills/iris-use/SKILL.md)、[`iris-compose-media`](.dsh/skills/iris-compose-media/SKILL.md) 和 [`iris-verify-ui`](.dsh/skills/iris-verify-ui/SKILL.md)。独立 Core 与连接 Skill 不替换它们。

项目使用 ES Modules，无构建步骤。安装现有锁定依赖后运行 `npm test`；浏览器验证使用真实本地服务和受控上游。插件保留已定义的最小契约，完整 SDK 与内部配置不在冻结范围；暂无社区市场。已验证的特定 Agent 接入不等于任意客户端的附件呈现都已验收。

[MIT License](LICENSE)
