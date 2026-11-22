# Iris Core Skill · 宿主无关的图片工作流

Iris 为脱离 DSH 运行的终端与 MCP 场景提供两类宿主无关的 Agent Skills：

1. **[`iris-core`](../skills/iris-core/SKILL.md)**：随 npm 包分发，指导 Agent 通过独立 CLI 完成图片导入、API 生图/改图、ComfyUI 工作流生成、任务恢复与产物导出（正文为英文，附中文标题）。
2. **连接专属 MCP Skill**：由 Core 工作台连接中心根据每条 MCP 连接的**实际有效授权工具**动态生成，指导客户端 Agent 在授权范围内调用 MCP 工具。

> [!NOTE]
> - DSH 原生插件自带的三项 Skill（`iris-use`、`iris-compose-media`、`iris-verify-ui`）继续服务于 DSH 宿主环境，与本页介绍的独立 Skills 互不替代。
> - **命令运行方式**：在本地项目安装 `@mokuyoaxis/dsh-iris@0.3.1` 后，请使用 `npx dsh-iris ...` 运行 CLI；在已执行 `npm ci` 的源码仓库中，请将 `dsh-iris` 替换为 `node bin/dsh-iris.js`。

## 显式安装、检查与卸载

安装 `@mokuyoaxis/dsh-iris` 不会通过 `postinstall` 自动写入任何客户端目录。安装器直接从当前运行的包定位 `skills/iris-core/`，你可以通过 `skills` 子命令显式安装、检查或卸载（写操作均支持 `--dry-run` 只读预览）：

```bash
# 安装到 Kimi Code 默认目录（$KIMI_CODE_HOME/skills 或 ~/.kimi-code/skills）
npx dsh-iris skills install --target kimi --dry-run
npx dsh-iris skills install --target kimi
npx dsh-iris skills status --target kimi

# 安装到自定义宿主或项目的 Skills 扫描根目录（注意：指向包含各 Skill 子目录的父目录）
npx dsh-iris skills install --directory /absolute/path/project/.agents/skills
npx dsh-iris skills status --directory /absolute/path/project/.agents/skills
```

### 安全归属校验与可恢复备份

- **安装记录与冲突保护**：安装器会在目标 `iris-core/` 下写入 `.iris-install.json` 记录包名、版本与文件摘要。重复安装相同内容不会产生写入；若检测到目标目录无有效归属记录、存在用户手工修改或额外/缺失文件、或包含符号链接，安装器会拒绝覆盖并保留现场。
- **非破坏性升级与卸载**：当升级一个未经本地修改的旧版本副本，或执行 `skills uninstall` 时，安装器会将原目录完整移入扫描根之外的同级备份区 `.iris-skill-installs/<目录摘要>/backup-*/iris-core`（并在卸载时返回 `backupPath`），不会永久删除文件：

```bash
npx dsh-iris skills uninstall --target kimi --dry-run
npx dsh-iris skills uninstall --target kimi
```

- **退出码与发现状态**：`skills status` 在状态为 `current` 时退出码为 `0`；在 `not_installed`、`update_available`、`modified` 或 `unmanaged` 时退出码为 `1`；参数错误退出码为 `2`。输出中的 `discovery: "not_checked"` 表明 CLI 仅核对了磁盘文件完整性，实际宿主是否已加载该 Skill 仍需在目标客户端中确认。

## 目录结构与装载方式

`skills/iris-core/` 是一个自包含目录，包含以下文件：
- [SKILL.md](../skills/iris-core/SKILL.md)：核心图片工作流主指南
- [references/cli.md](../skills/iris-core/references/cli.md)：Headless CLI 命令、参数与输入规范
- [references/tasks.md](../skills/iris-core/references/tasks.md)：Task 状态检查、等待、重新交付与防重提恢复说明
- [references/comfyui.md](../skills/iris-core/references/comfyui.md)：ComfyUI 工作流选择、开放参数、LoRA 双权重与接力改图参考
- `agents/openai.yaml`：可选界面元数据

除使用 `skills install` 复制外，支持 [Agent Skills 规范](https://agentskills.io/specification) 的宿主也可直接指向包内的 `skills/` 目录（例如在 Kimi Code 中临时加载验证，详见 [Kimi 官方文档](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html)）：

```bash
kimi --skills-dir /absolute/path/to/iris/skills
```

宿主加载 `iris-core` 后，底层仍需调用 `dsh-iris`（或 `node bin/dsh-iris.js`）可执行入口。在对话中请向 Agent 提供本次使用的 `--data-root` 与私有 `--provider-config` 路径，切勿将 API Key 直接写入提示词或 Skill 文件中。

## ComfyUI 参考与 API 搭配

`iris-core` 内置了对 ComfyUI 工作流及“ComfyUI + 普通 API”接力工作流的指导（详见 [ComfyUI 参考](../skills/iris-core/references/comfyui.md)）：

- **先集中确认需求，再执行**：对于 ComfyUI 生图请求，Agent 会先通过只读目录查看实际配置的工作流、参数 ID、类型、范围及当前可用的 LoRA 选项，并一次性向用户确认缺失的工作流或参数偏好，绝不凭模型家族名称猜测节点图或参数名。
- **跨后端接力（ComfyUI 出图 → API 改图）**：支持第一阶段通过 ComfyUI 生成作品落入当前 Core 数据根，第二阶段将该作品的 `artifact_id` 交给同一数据根下支持改图的普通 API 模型精修（第二阶段不携带 ComfyUI 专属参数，恢复第二阶段任务时完整保留第一阶段原图；反向“API 出图 → ComfyUI 图生图”尚未接入）。

## 连接专属 MCP Skill（0.3 alpha）

在独立 Web 工作台的[连接中心](LOCAL_WEB.md#显式开启连接中心)创建并保存一条 MCP 连接后，展开 **连接专属 Skill** 即可根据该连接**当前实际生效的授权工具**生成定制说明，并下载为 `iris-skill.json`（≤16 KiB 纯 JSON 数据文件），随后通过 `--bundle` 安装：

```bash
npx dsh-iris skills install \
  --bundle /absolute/downloads/iris-skill.json \
  --directory /absolute/project/.agents/skills --dry-run

npx dsh-iris skills install \
  --bundle /absolute/downloads/iris-skill.json \
  --directory /absolute/project/.agents/skills

npx dsh-iris skills status \
  --bundle /absolute/downloads/iris-skill.json \
  --directory /absolute/project/.agents/skills
```

- **独立命名与安全边界**：`--bundle` 同样支持 `uninstall` 与 `--target kimi`，由包内代码在目标目录下生成 `iris-mcp-<connectionId>/SKILL.md`（不执行任何外部脚本，也不会覆盖 `iris-core` 或其他连接的 Skill）。数据包仅含连接/数据根标识与工具说明，**不包含任何认证 Token、供应商密钥或私有路径**。
- **按实际授权裁剪内容**：生成的说明仅描述该连接已获授权的媒体分组（如 `image-edit`、`image-generate`/ComfyUI、`tts`/`transcribe`、`video-generate`、`vision`/`ocr` 或插件业务）与允许的 scope（如只读连接仅生成只读查询说明；未开放目录或执行工具时会明确说明边界，不会诱导 Agent 越权绕行 CLI）。
- **权限变更同步**：在工作台调整连接的媒体分组或工具权限后，重新下载 JSON 并再次执行 `skills install --bundle ...` 即可将旧副本归档并更新为最新说明。
