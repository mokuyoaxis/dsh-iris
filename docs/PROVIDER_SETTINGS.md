# Core 模型服务、功能池与健康光谱（0.3.1）

在独立 Core 工作台的 **模型服务** 中，你可以管理媒体供应商连接、环境变量凭据引用、模型用途、ComfyUI 工作流、六类全局功能模型池以及能力健康光谱。

> [!NOTE]
> 本页描述工作台的供应商管理能力（由服务启动开关显式授予工作台所有者）。MCP 客户端连接授权在“客户端”页单独管理，不接触上游密钥或供应商设置。

## 开启供应商管理

使用已初始化的 Flow / 执行根和私有供应商配置启动 `web serve`（若尚未初始化配置，先运行 `config init`）：

```bash
npx dsh-iris config init --provider-config /absolute/new-providers.json
npx dsh-iris web serve --data-root /absolute/existing-flow-root \
  --provider-config /absolute/new-providers.json \
  --allow-provider-management
```

> 若通过本地项目安装 `@mokuyoaxis/dsh-iris@0.3.1`，请保留示例中的 `npx dsh-iris`（命令不自动进入全局 `PATH`）；从源码仓库运行时改用 `node bin/dsh-iris.js`。

- **权限独立**：`--allow-provider-management` 仅对工作台所有者开放模型服务配置，不隐含媒体执行（`--allow-execution`）、图片选择（`--allow-selection`）或 MCP 连接管理权限。
- **网络与安全**：保存供应商即表示信任该端点及返回的媒体下载链接；远端地址建议使用 HTTPS，HTTP 仅建议用于本地网关或 ComfyUI。另可结合 [网络出口页](NETWORK_WORKBENCH.md) 为指定供应商绑定代理节点或有序出口池。
- **各媒体入口的根版本**：改图与对照板需 v1+ 执行根；文生图需 v2+ 根（[文生图与 ComfyUI](IMAGE_GENERATION.md)）；TTS/转写需 v3+ 根（[音频流程](AUDIO_FLOWS.md)）；文生视频需 v4+ 根（[视频流程](VIDEO_FLOWS.md)）；看图、OCR、视觉定位与多模态摘要需 v5 根（[视觉流程](VISION_FLOWS.md)）。

## 配置流程

“模型服务”由 **供应商**、**功能模型池** 和 **健康检测** 三部分组成：

1. **添加或选择服务**：点击卡片或“添加服务”，选择预设（OpenAI / 百炼 / ComfyUI）或自定义服务，填写名称、Base URL 与认证方式（高级连接设置默认折叠）。
2. **配置凭据**：已有 Key 仅显示就绪状态而不回显明文；编辑时可选择保留、替换、清除、切换为“无需认证”（`auth: none`），或使用 [环境变量凭据引用](PROVIDER_CREDENTIALS.md)（只保存 `apiKeyEnv` 变量名，在 Core 进程内存中解析）。
3. **同步或填写模型**：保存连接后可点击同步读取上游目录，或手动添加准确模型 ID（目录结果暂存在草稿中，确认保存后才写入配置）。
4. **确认模型用途**：勾选模型支持的 `image` / `video` / `tts` / `music` / `transcribe` / `vision` 用途后保存。若对应功能原本处于停用状态，首次勾选新用途时会自动将其切换为自动池（保存摘要会明确列出变更）。如需为个别模型覆写协议，可在折叠项中设置 `imageProtocol` 或 `musicProtocol`（`gemini-web-music` 在界面显示为 **Chat Completions（内嵌音频）**，详见[音乐生成](MUSIC.md)）。
5. **调整功能模型池**：在“功能模型池”中为六类功能分别选择 **自动池**、**手动有序名单**（支持上下排序）或 **停用**。自动池与手动池均按顺序优先选择可用候选（非跨请求轮转），手动空池不会回退为自动池。

### ComfyUI 与工作流模板

选择 ComfyUI 预设时，可导入 API 格式图或 Iris 参数模板（v0/v1），绑定正向提示词、输出节点与可选尺寸节点，并勾选开放标量参数（如 LoRA 双权重、种子）生成创作表单预览。

- 切换回“自定义兼容服务”时会保留本次编辑中的 API 草稿，重新加载或退出后清除。
- 通过工作台或 `POST /api/v0/provider-management/workflow-check` 可对已保存的 ComfyUI 连接做**只读节点与参数检查**（不入队或生成图片，详见 [ComfyUI 入口](IMAGE_GENERATION.md#comfyui-入口) 与 [参数模板与检查](IMAGE_GENERATION.md#comfyui-参数模板与只读检查后端)）。

### 停用、删除与并发保护

- **停用**：保留连接、模型与池配置，可随时原地恢复。
- **删除**：先展示影响预览并检查当前数据根中是否存在未完成或待确认的任务/流程依赖；存在受保护依赖时会阻止删除，历史已完成记录与作品仍保留，同时安全清理手选池引用。
- **版本并发校验（CAS）**：编辑与保存携带 `revision` 校验与原子写锁，遇到并发修改时会保留当前草稿并提示重新核对；更改端点、认证或协议会使旧成功验证失效（历史 Task 仍保留原绑定信息）。

## 健康检测与保活

- **六色能力光谱**：集中呈现六类能力的当前候选排序、近期成功记录以及受阻原因（未入池、协议不支持、模型不存在、429 冷却或额度耗尽）。刷新光谱只读取本地配置与持久健康证据（规则见[健康状态](PROVIDER_HEALTH.md)）。
- **连接检查与可选保活**：“检查连接”以只读方式读取已保存服务的目录或 ComfyUI 状态；你也可以在本次运行期间开启 `1/5/15` 分钟的轻量保活（默认关闭，不跨重启保留）。
- **单模型功能验证**：“准备功能验证”会在创作页为你预填选定模型的最小草稿（图片为小样本、语音为“你好”等），只有在你明确点击生成按钮时才会发起可能计费的模型请求（也可使用 CLI `models test`）。

## 管理 HTTP 契约 v0

所有接口均位于 `/api/v0/provider-management`，受 Bearer、`Host`/`Origin`、无 CORS、单变更锁及 64 KiB JSON 上限保护：

| 路由 | 用途说明 |
|---|---|
| `GET/HEAD /settings` | 返回所有者非秘密配置投影（含协议描述、供应商、模型、功能池与凭据状态，不含密钥明文） |
| `GET/HEAD /diagnostics` | 返回当前候选、阻塞原因、近期健康证据与本次服务的检查状态（只读） |
| `POST /save` | `{expectedRevision, provider, credential, assignments?}` 原子保存供应商与可选池变更 |
| `POST /policies` | `{expectedRevision, assignments}` 独立保存六类功能模型池策略 |
| `POST /enabled` | `{expectedRevision, providerId, enabled}` 停用或恢复指定供应商 |
| `POST /impact` | `{expectedRevision, providerId}` 只读预览删除该供应商的影响与受阻依赖 |
| `POST /remove` | `{expectedRevision, providerId, confirm: true}` 在核对无活跃依赖后删除配置 |
| `POST /check` | `{expectedRevision, providerId}` 发起一次轻量只读连接检查 |
| `POST /monitor` | `{expectedRevision, providerId, enabled, intervalSeconds: 60\|300\|900}` 控制本次服务内保活 |
| `POST /discover` | `{expectedRevision, providerId}` 同步读取最多 256 个目录模型（`persisted: false`，不自动写入） |
| `POST /workflow-check` | 对指定模型或模板草稿执行只读 ComfyUI 节点与参数静态检查 |

`credential` 动作支持 `{action: "keep"}`、`{action: "clear"}`、`{action: "replace", value}` 与 `{action: "env", name}`。若环境凭据未就绪，显式检查将返回 `409`（`IRIS_PROVIDER_CREDENTIAL_UNAVAILABLE`）；已加载的外部协议扩展则自动通过 [Provider 扩展](PROVIDER_EXTENSIONS.md) 投影到页面中。
