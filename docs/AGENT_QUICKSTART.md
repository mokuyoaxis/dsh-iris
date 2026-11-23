# 给 AI Agent 的简要 Prompt

本页提供交给 AI Agent 的快速指引，帮助它正确安装并操作 **Iris 0.3.2** 的 **DSH 原生插件**或 **Headless CLI**。如果你要接入的是独立 **Core Web 工作台与 MCP**，请改用 [Agent Core 指导](AGENT_CORE_QUICKSTART.md) 与 [Core 快速开始](CORE_QUICKSTART.md)。

> [!NOTE]
> 安装前请确认目标版本已在 npm 发布；如果是从源码或本地归档测试，请直接指向源码或归档路径。从旧版升级请先阅读[升级指南](UPGRADING_0.3.md)。

## 中文

```text
请根据本仓库 README，帮我安装并使用 Iris（@mokuyoaxis/dsh-iris）。

1. 环境与版本检查
- 先核对 Node.js 版本（0.3.2 要求 >=22.1.0）以及目标 DSH profile，运行 dsh --version 确认宿主版本。
- 若 DSH 属于 docs/DSH_COMPATIBILITY.md 列出的 12 个支持版本，且 0.3.2 已发布，安装：
  dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.3.2
  （如使用其他 profile，替换命令中的 web；安装或搜索时务必使用完整 scoped 包名 @mokuyoaxis/dsh-iris）。
- 若 DSH 版本不在兼容矩阵中，先向我报告，不要自行升级宿主或绕过版本检查。
- 若不使用 DSH 而直接用 CLI，请按 docs/HEADLESS_CLI.md 执行，切勿在旧格式数据根上初始化新执行格式或混用新旧版本写入同一目录。

2. 配置与安全规范
- 先通过 --help 与 Doctor 检查安装状态和工具可用性。
- 可引用 DSH 已有 API Key 连接或手动添加服务，随后确认模型用途并选择启用自动池或手动名单（不要通过调用付费模型来探测配置）。
- 常用工具提示：导入图片用 iris_import_image，改图用 iris_edit_image，音乐用 iris_generate_music（需配置 Chat Completions 内嵌音频协议，见 docs/MUSIC.md）。
- 切勿输出明文 API Key；重启宿主前请先征求确认并说明影响。

3. 任务执行与汇报
- 查询、观察与重新取回均不等于重新生成；遇到已受理或状态未知的任务时，不要自行套重试循环（音乐的有限 502 重试已在内部处理）。
- 最后请汇报实际使用的 Iris / DSH 版本、安装来源以及真实验证结果。
```

## English

```text
Help me install and use Iris (@mokuyoaxis/dsh-iris) based on this repository's README.

1. Environment & Version Check
- Check Node.js (>=22.1.0 required for 0.3.2) and the target DSH profile via `dsh --version`.
- If the DSH version is one of the 12 supported versions in docs/DSH_COMPATIBILITY.md and 0.3.2 is published, install with:
  dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.3.2
  (Replace `web` with the target profile if needed, and always keep the full scoped name `@mokuyoaxis/dsh-iris`).
- If the DSH version is outside the matrix, report it first—do not upgrade the host or bypass version checks.
- For standalone CLI use without DSH, follow docs/HEADLESS_CLI.md and never mix legacy and new data-root formats.

2. Configuration & Safety
- Verify installation and tool availability using `--help` and Doctor first.
- Reference an existing DSH API-key connection or add a provider, then confirm model uses and choose an automatic or manual pool policy (do not probe paid models just to test configuration).
- Tool hints: use `iris_import_image` for imports, `iris_edit_image` for edits, and `iris_generate_music` with its inline-audio protocol for music (see docs/MUSIC.md).
- Never print API keys in output, and confirm with me before restarting the host.

3. Execution & Reporting
- Inspect, observe, and redeliver never generate again; do not add a retry loop when acceptance is confirmed or unknown (bounded 502 retries for music are handled internally).
- Report the Iris/DSH versions, installation source, and verified results when finished.
```
