# Iris Core Skill · 宿主无关的图片工作流

0.2.7 新增 [`iris-core`](../skills/iris-core/SKILL.md)，指导 Agent 使用现有独立 CLI 导入、生成、编辑图片，查询原任务并取回作品。正文使用英文、标题附中文；参数与任务恢复按需阅读配套参考。它不需要运行 DSH，也不依赖某个个人账号、模型或目录。

本 Skill 从 npm 0.2.7 起随包分发。CLI 命令本身已有实现；安装了 CLI 不代表宿主已经发现 Skill，加载了 Skill 也不代表媒体模型已经配置。

## 显式安装、检查与卸载

0.2.7 的安装器随 npm 包中的 CLI 和 `lib/` 一起分发，从当前执行的包定位 Skill，不依赖仓库 cwd、全局 node_modules 固定位置或临时软链。没有 npm `postinstall`，安装 npm 包本身不会写其他 harness 的目录。

```bash
dsh-iris skills install --target kimi --dry-run
dsh-iris skills install --target kimi
dsh-iris skills status --target kimi
```

`--target kimi` 使用 `$KIMI_CODE_HOME/skills`，未设置时使用 `~/.kimi-code/skills`。自定义目录可单独使用，也可覆盖 Kimi 默认位置；它指向包含 Skill 子目录的扫描根，不是 `iris-core/` 本身：

```bash
dsh-iris skills install --directory /absolute/path/project/.agents/skills
dsh-iris skills status --directory /absolute/path/project/.agents/skills
```

安装器复制整个 `iris-core/`，不自动修改模型、MCP、宿主设置或 DSH Skill registry。其他 harness 需要由用户明确提供其支持的扫描目录；目录布局正确仍需在该宿主复核发现与调用。`--dry-run` 仅预览，不创建目标、控制目录或锁；`status` 始终只读。

安装目录中的 `.iris-install.json` 记录包名、版本、文件摘要及目录清单。重复安装当前副本不写入；显式再次安装可更新内容完整且未经本地修改的旧副本，即使包版本相同也会比较内容。已有目录无有效记录、存在额外/缺失/改动文件或目录、包含软链时保留现场并报告冲突，不提供强制覆盖。

升级前将原目录完整移到扫描根之外的同级 `.iris-skill-installs/<目录摘要>/backup-*/iris-core`，再排他创建新目录。复制失败时保留旧备份及新目录现场；不自动覆盖恢复，也不接管无完整记录的半成品。控制目录的锁异常同样保留，需人工核对，不自动清理。

卸载也只处理归属有效、内容未改动的副本，移动到上述备份区并返回 `backupPath`，不永久删除，不清理备份：

```bash
dsh-iris skills uninstall --target kimi --dry-run
dsh-iris skills uninstall --target kimi
```

`status` 为 `current` 时 exit 0，`not_installed`、`update_available`、`modified` 或 `unmanaged` 为 exit 1；参数错误为 exit 2。输出的 `discovery: not_checked` 明确表示没有启动宿主检查其技能列表。安装完整性、宿主实际发现、Agent 按 Skill 完成创作分别验收；安装/状态/卸载不调用模型或媒体供应商。

## 文件与装载

`skills/iris-core/` 是独立目录，包含 `SKILL.md`、两份 `references/` 和可选的 `agents/openai.yaml` 界面元数据。参考链接均位于该目录内，分发时保留整个目录。

使用支持 Agent Skills 的宿主时，将完整目录放到该宿主已确认的 Skill 搜索位置；已有同名目录先检查，不覆盖。仓库与 npm 包中的 `skills/` 也可作为显式搜索根。例如，在已安装 Kimi Code 的环境中独立验证：

```bash
kimi --skills-dir /absolute/path/to/iris/skills
```

这会为本次启动指定 Skill 目录；不自动修改日常配置。搜索优先级、同名覆盖和调用方式以当前宿主版本为准。Kimi 的目录形式与参考资源说明见[官方文档](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html)，通用目录约定见 [Agent Skills 规范](https://agentskills.io/specification)。

宿主读取 Skill 后仍需可执行的 `dsh-iris`，或已确认源码根中的 `node bin/dsh-iris.js`。向 Agent 提供本次明确的 Core 数据根；生成/编辑另提供私有 Provider 配置路径。先使用 `--help` 与只读配置摘要核对入口，具体命令见 [CLI 参考](../skills/iris-core/references/cli.md)。不要把密钥写进提示词或复制进 Skill。

## 当前边界

- 首版覆盖图片及其任务，支持单步操作和图片续作；视频、语音和界面验收不在首版范围内。
- DSH 原有三项 Skill、工具、附件与工作台流程保持，不把新 Skill 自动注册为第四项 DSH Skill；DSH 使用方式见 [README](../README.md#agent-skills)。
- 本版新增独立的 Core 指导，不迁移或改写旧 DSH Skill。后续若合并公共参考，应先证明 DSH 流程和资源解析保持。
- Core Artifact ID 属于指定根，宿主附件、路径与 URL 不可互换；交付时由实际宿主呈现导出文件。
- 正式 MCP 仍待实现。当前 Skill 的可执行说明只有 CLI，不能用它声称 MCP 已安装或第二生产 Host 已完成。
- 面向 Core 的独立工作台继续按既有路线推进；本 Skill 不描述尚不存在的 UI 操作。Skill 指导 Agent，业务受理、写者租约与重试约束继续由执行层负责。

验收区分 Skill 文件/引用可读取、CLI 示例可执行、实际 Agent 是否按指导完成任务。离线供应商夹具只验证命令和状态处理，不证明真实模型的规划、生图质量或计费表现。
