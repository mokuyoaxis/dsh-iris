# 文生视频 · 持久流程与资源交付

这是 **0.3.0-beta.1 新增功能**。使用准确beta版本或npm `beta`通道；旧alpha.1没有下面的 `--video`、视频 Web 表单与 MCP 分组。原有 CLI / DSH 视频入口继续可用。

协议按实际模型选择。`wan2.2-t2v-plus`等旧系列应对照官方[万相2.1–2.6文生视频接口](https://help.aliyun.com/zh/model-studio/legacy-wan-text-to-video-api-reference)；官方当前主视频页已转向wan2.7新协议，不能仅凭同品牌模型套用其字段或声称已有实现覆盖。

## 新建专用工作区

以下路径必须是新的空 Flow 根：

```bash
node bin/dsh-iris.js flow init --data-root /absolute/new-video-core
node bin/dsh-iris.js execution init --video --data-root /absolute/new-video-core
node bin/dsh-iris.js web serve --data-root /absolute/new-video-core \
  --provider-config /absolute/private/providers.json --allow-execution \
  --auth-store /absolute/private/video-auth \
  --connection-store /absolute/private/video-connections \
  --allow-connection-management --allow-mcp
```

`--video` 显式建立 `creation-requests/v4`，同时包含原图片、语音与转写流程。不能与 `--audio` 或 `--image-generation` 混用；已有 v0–v3 根不升级、迁移或降级。旧版本在请求区门禁拒绝 v4；不要让旧版本 CLI 写入此根。

初始化、读取目录、创建连接与保存视频意图均不生成。只有明确的首次继续调用模型，可能产生费用。模型池仍来自真实配置和既有用途规则；此固定流程要求用户选择一个实际 `modelRef`，不会跨请求轮询或悄悄切换模型。

beta.1修复统一检查明确的t2v/i2v/s2v/r2v模型家族：文生与图生候选不互选，固定文生视频Flow拒绝已知i2v/s2v/r2v模型。CLI/DSH和显式视频重试使用相同规则。没有这些家族标记的兼容模型ID延续原有t2v/i2v路径，实际支持仍由协议和上游决定；本片不新增模型元数据格式或迁移目录。

独立 CLI `flow create/continue` 已补齐视频候选装配（beta.1修复），无需启动 Web：

```bash
node bin/dsh-iris.js flow create --data-root /absolute/new-video-core \
  --provider-config /absolute/private/providers.json \
  --input '{"recipe":"video-generate/v0","model_ref":"provider::t2v-model","prompt":"鸢尾花随风轻摆","duration":5}'
node bin/dsh-iris.js flow continue run_0123456789abcdef01234567 \
  --data-root /absolute/new-video-core --provider-config /absolute/private/providers.json
```

Run ID 使用创建命令的实际返回值。首次继续仅提交一次；异步未结束时再次明确继续只观察原 Task，不重提。该固定流程仍仅文生视频；独立 `task retry` 的模式和媒体输入规则见[CLI 重试](HEADLESS_CLI.md#检查-task-与-artifact)，不会因此扩展本流程范围。

## 输入、任务和交付边界

- 固定配方为 `video-generate/v0`：明确 `modelRef`、`prompt`，可选 `size` 和数值型 `duration`（1–60 秒）。Prompt 最多20,000字符、尺寸最多64字符；具体参数支持由实际模型决定，目录不等于实测。
- 首片仅文生视频；不接受首帧、音频、S2V、任意供应商 JSON、本机路径或外部结果 URL。原 CLI / DSH 的图生视频和 S2V 入口不受影响。
- 创建预留唯一 Run/Task，并持久保存创建 UUID 和输入摘要；不立即提交。继续保存独立 Operation UUID，一次有限调用只提交或观察原 Task，受理未知不重新提交。
- 服务重启、刷新、历史读取不自动生成或查询供应商。异步任务需明确点击“查看原任务”再观察一次；停止等待只终止本地操作，不代表远端取消、退款或未计费。
- 原 Task 已成功但落盘失败时接回原交付；已有完整缓存可在无 Provider 的重启后修复。保留原 Run/Task/Operation/Artifact 身份。
- 视频为单一结果，无图片选择步骤。交付和读取限 MP4/WebM、最多 **32 MiB**；API 验证保存记录、大小及 SHA-256。没有完整编码探测、Range 或边下边播，客户端收到完整 Blob 后播放；真实模型的编码兼容性仍需验收。
- 类型或大小不符时保留原 Task 与已有交付证据，明确报错，不重新生成。工作台不输出供应商签名 URL、密钥或服务器存储路径。

beta.1修复会先检查 Manifest、媒体类型及实际普通文件大小，再读取固定流程的结果。超出32 MiB时保留已成功的原 Task/Artifact；重启后再次继续仍明确拒绝，不整读该文件或重新生成。这个上限属于固定 Flow/Core Web/MCP 视频读取入口；通用 Provider Task 的视频下载上限仍为1 GiB。DSH同源作品媒体GET按流发送、HEAD不分配完整文件缓冲，两者在发送前保留分块SHA-256校验；没有新增Range或编码探测。

Web 的 **创作 → 生成视频** 使用实际候选，参数默认折叠；结果提供原视频播放器和下载。**作品 → 视频** 点击“载入视频”才读取，不自动播放；离页、换分类和退出释放媒体。撤销执行权限的只读服务仍可按读取授权播放已有结果。浏览器恢复表只存身份，不存 Prompt 或凭据；丢失创建回包后接回原意图，不自动首次提交。

## HTTP 与 MCP

HTTP 路径均以 `/api/v0` 开头，沿用 Bearer、Host/Origin、连接功能和具体工具授权：

| 入口 | 含义 |
|---|---|
| GET/HEAD `/video-models` | 真实池内文生视频候选；不探测，无密钥/端点 |
| POST `/videos` | JSON 意图，稳定 UUIDv4 `Idempotency-Key`；同 Key 同输入重放，不同输入409 |
| GET/HEAD `/artifacts/:id/video` | 授权后的原 MP4/WebM |
| GET/HEAD `/runs/:id/download` | 单一结果原字节及匹配扩展名 |
| Run / Operation 的既有入口 | 创建查询、有限继续、原操作查询和本地停止 |

JSON 正文最多64 KiB。v0–v3 根不开放此媒体组，旧连接和默认 image-edit 不自动扩权。MCP 由用户明确选择 `video-generate`，再分别选择 read/create/execute/stop 和需要的具体工具：

| 工具 | 行为 |
|---|---|
| `iris_core_video_models` | 读取实际候选 |
| `iris_core_create_video` | 保存意图，尚不生成 |
| `iris_core_video` | 校验并引用已保存的原视频，不调用模型 |

继续、查询和停止复用原工具，并按原 Run 媒体组校验。MCP 无原生 video 内容块，视频工具返回标准 `resource_link`，URI 为 `iris://video/ARTIFACT_ID`。客户端通过标准 `resources/read` 获取 Base64 BlobResourceContents；每次读取重新检查 Core 当前授权。仅选择视频读取工具才注册资源模板，缩权或撤销后旧进程也无法继续读取。连接专属 Skill 由实际工具生成视频指导。

客户端可能只显示引用，不提供播放器；拿到引用不等于看过视频。DSH 原生共享桥暂不投影视频资源，选择视频组时明确拒绝启动；使用通用 MCP、Core Web，或原 DSH 视频工具。

## 验证范围

以下测试和`scripts/`开发验收命令从源码仓库根运行，不随npm包分发。定向用例：`tests/video-flow.mjs`、`tests/video-api.mjs`、`tests/video-recovery.mjs`。真实 Chromium 场景：

```bash
node scripts/verify-local-web-browser.mjs \
  --browser-executable /absolute/path/to/chromium \
  --output /absolute/new-video-evidence --video
```

覆盖实际小视频解码/播放、原字节下载、重启接回、丢失创建回包、停止、只读、窄屏和暗色；标准 SDK 的 HTTP/stdio 2025/2026 路径验证资源与权限。这些回归使用受控 Provider。

另于2026-11-01完成百炼北京 `wan2.2-t2v-plus` 的真实单例：832×480、5秒H.264/MP4，1次生成提交、2次原任务查询；隔离服务重启接回同一Task、正式MCP资源读取、真实Chromium播放/下载与SHA一致均通过。未修改日常连接或查询实际账单。该结果仅覆盖这个模型、参数和当时环境，**不代表所有上游、账号、编码或客户端播放器均已实测**。
