# 给 AI Agent 的简要 Prompt

把下面一段交给负责安装或使用 Iris 的 Agent。版本与发布状态以当前 [README](../README.md) 为准；Iris 和 DSH 的版本号独立。

## 中文

```text
请根据本仓库 README，帮我安装并使用 Iris（@mokuyoaxis/dsh-iris）。
先确认运行环境、目标 DSH profile，并用 dsh --version 核对宿主；当前 0.2 候选要求 Node.js >=22.0.0（旧 npm 0.1.4 的历史要求为 >=20.10.0）：
- DSH 0.2.0-rc.2：选择 README 指定的 Iris 0.2 候选；尚未发布到 npm 时，从已安装依赖的候选源码目录运行 dsh plugin --profile web add .。
- DSH >=0.1.2-rc.1 <0.1.3-0 或 0.1.5-rc.1：固定安装 dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.1.4；只下载用 npm pack @mokuyoaxis/dsh-iris@0.1.4。
- 其他 DSH 版本：先报告没有支持声明，不自行升级宿主或跳过版本检查。
没有 DSH、希望用 CLI 时，按 docs/HEADLESS_CLI.md 选择当前候选；npm 0.1.4 不含新的 Core 媒体 CLI。
若使用其他 profile，把示例中的 web 换成已确认的目标。保留完整 scoped 包名，不把 dsh-iris 当作同一 npm 包。
安装后检查 Doctor 和工具可达性，再执行我指定的媒体任务；不要输出 API Key，重启宿主前说明影响。
查询、观察和重新取回不等于重新生成；任务已受理或受理未知时，不自动重新提交。
最后报告所用 Iris/DSH 版本、安装来源和实际验证结果。
```

## English

```text
Help me install and use Iris (@mokuyoaxis/dsh-iris) according to this repository's README.
Check the environment, target DSH profile, and dsh --version first; the current 0.2 candidate requires Node.js >=22.0.0 (the published npm 0.1.4 historically requires >=20.10.0):
- DSH 0.2.0-rc.2: use the Iris 0.2 candidate named in README; before npm publication, run dsh plugin --profile web add . from its checkout with dependencies installed.
- DSH >=0.1.2-rc.1 <0.1.3-0 or 0.1.5-rc.1: pin dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.1.4; download only with npm pack @mokuyoaxis/dsh-iris@0.1.4.
- Other DSH versions: report the missing support claim; do not upgrade the host or bypass its version checks automatically.
For CLI use without DSH, follow docs/HEADLESS_CLI.md for the current candidate; npm 0.1.4 does not include the new Core media CLI.
Replace web with the confirmed profile when needed. Keep the scoped package name; unscoped dsh-iris is a different npm package.
Check Doctor and tool availability after installation, then carry out my requested media task. Do not expose API keys; explain the impact before restarting the host.
Inspect, observe, and redeliver do not create a new generation. Never resubmit automatically after accepted or unknown acceptance.
Report the Iris/DSH versions, installation source, and actual validation results.
```
