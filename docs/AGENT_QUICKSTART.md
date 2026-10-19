# 给 AI Agent 的简要 Prompt

把下面一段交给负责安装或使用 Iris 的 Agent。版本与发布状态以当前 [README](../README.md) 为准；Iris 和 DSH 的版本号独立。

下列 npm 示例对应 Iris 0.2.6，准确范围见 [兼容矩阵](DSH_COMPATIBILITY.md)。执行安装命令前确认所选发行包的实际版本、工具和功能策略。

## 中文

```text
请根据本仓库 README，帮我安装并使用 Iris（@mokuyoaxis/dsh-iris）。
先确认运行环境、目标 DSH profile，并用 dsh --version 核对宿主；Iris 0.2.x 要求 Node.js >=22.0.0（旧 npm 0.1.4 的历史要求为 >=20.10.0）：
- DSH在docs/DSH_COMPATIBILITY.md列出的12个准确版本中：固定安装 dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.2.6；只下载用 npm pack @mokuyoaxis/dsh-iris@0.2.6。
- 未列入所选Iris版本兼容矩阵的DSH：先报告没有支持声明，不自行升级宿主或跳过版本检查。
没有DSH、希望用CLI时，按docs/HEADLESS_CLI.md使用npm0.2.6；npm0.1.4不含当前Core媒体CLI。
先用--help和Doctor核对实际版本与命令。可引用DSH已有API Key连接，再确认模型用途并主动启用自动池，或保留手选名单；旧空配置不自动启用。DSH默认视觉须明确加入或启用。目录新增模型仍需确认用途；不以实测请求探测配置。图片导入用iris_import_image，改图用iris_edit_image；音乐用iris_generate_music并配置Chat Completions（内嵌音频）协议，见docs/MUSIC.md。
从dsh-market安装也要核对实际包名、版本和兼容范围；缓存的旧版安装信息仍按其历史矩阵判断。
若使用其他 profile，把示例中的 web 换成已确认的目标。保留完整 scoped 包名，不把 dsh-iris 当作同一 npm 包。
安装后检查 Doctor 和工具可达性，再执行我指定的媒体任务；不要输出 API Key，重启宿主前说明影响。
查询、观察和重新取回不等于重新生成；任务已受理或受理未知时，不自行重新提交。音乐入口内部执行本次配置的有限502重试，不再由Agent包外层循环；配乐仅按用户要求加入流程。
最后报告所用 Iris/DSH 版本、安装来源和实际验证结果。
```

## English

```text
Help me install and use Iris (@mokuyoaxis/dsh-iris) according to this repository's README.
Check the environment, target DSH profile, and dsh --version first; Iris 0.2.x requires Node.js >=22.0.0 (the published npm 0.1.4 historically requires >=20.10.0):
- For one of the twelve exact DSH versions in docs/DSH_COMPATIBILITY.md, pin dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.2.6; download only with npm pack @mokuyoaxis/dsh-iris@0.2.6.
- DSH versions outside the selected Iris version's matrix: report the missing support claim; do not upgrade the host or bypass its version checks automatically.
For CLI use without DSH, follow docs/HEADLESS_CLI.md using npm0.2.6; npm0.1.4 lacks the current Core media CLI.
Check --help, Doctor and the actual installed version. Reference a DSH API-key connection when available, confirm model uses, and explicitly enable automatic pools or retain selected-only lists. Existing empty configurations stay inactive. Host vision and new directory models require explicit authorization. Do not probe paid models to check configuration. Use iris_import_image for import, iris_edit_image for editing, and iris_generate_music with its configured inline-audio protocol for music.
For dsh-market, check the actual package name, version, and compatibility range too. Cached older releases retain their historical compatibility matrices.
Replace web with the confirmed profile when needed. Keep the scoped package name; unscoped dsh-iris is a different npm package.
Check Doctor and tool availability after installation, then carry out my requested media task. Do not expose API keys; explain the impact before restarting the host.
Inspect, observe, and redeliver do not generate again. Do not add an agent retry loop after accepted or unknown acceptance; music handles its configured bounded 502 retries internally. Add music to workflows only when requested.
Report the Iris/DSH versions, installation source, and actual validation results.
```
