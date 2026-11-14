# Core 看图与 OCR（0.3.0-beta.3）

0.3.0-beta.3 新增 `vision/v0` 单图问答和 `ocr/v0` 长图识别。Core 保存原图、模型、问题或分块预算，明确执行后保留任务身份、文字和 OCR 报告。**0.3.0-beta.2 不含这些入口**；新能力使用独立新根，旧根不迁移。

## 新建专用工作区

安装 beta.3 后使用 `npx dsh-iris`；下例从已执行 `npm ci` 的源码目录运行。在新的绝对路径初始化，原有 v0–v4 根继续按原能力使用：

```bash
node bin/dsh-iris.js flow init --data-root /absolute/new-vision-core
node bin/dsh-iris.js execution init --data-root /absolute/new-vision-core --vision
node bin/dsh-iris.js web serve --data-root /absolute/new-vision-core \
  --provider-config /absolute/existing-providers.json --allow-execution \
  --allow-connection-management --connection-store /absolute/new-vision-connections --allow-mcp
```

`--vision` 建立独立 v5 请求根，同时支持既有图片、音频和文生视频流程。初始化开关互斥，不能在旧根上转换或升级。服务端按根版本和保存的明确授权共同开放功能。

从 owner 已配置的视觉用途/功能池中选择准确 `provider::model`；当前支持 OpenAI 兼容 Chat Completions 图片输入 SSE 协议。使用该供应商的 `baseUrl`、凭据来源、视觉输入限制和 Core 网络出口，不借用 DSH 默认模型，也不使用图片生成专用 `mediaBaseUrl`。没有候选、配置失效或显式出口池不可用时明确报错，不自动改模型或直连。

上游明确返回“模型不存在”的404时，Core保存该连接与模型的不可用证据，后续请求拒绝选用；OCR即使已有部分成功，也记录该证据，同轮后续分块不再请求此模型，已成功正文和准确分块报告保留。普通路径404及其他状态不据此阻断模型。先核对可用模型ID与接口，再显式实测恢复；本地配置可选不代表远端当前可用。HTTP/MCP错误摘要明确提示所选模型不可用，历史视觉Task读回也可获得这一固定说明，不改写原记录。

图片须为当前根中的静态 PNG/JPEG/WebP Artifact，最多20 MiB、4000万像素。MCP `imageBase64` 最多8×1024²个 Base64 **字符**，约6 MiB原字节；HTTP/本地导入原字节上限20 MiB。没有任意路径、URL、附件ID输入。已绑定其他能力流程的来源图仍需要相应读取授权；可另行导入用户提供的原图。

## 保存、执行与读取

连接中心分别选择 `vision` 或 `ocr`，按需要允许 read/create/execute/stop。旧连接、旧默认能力和具体工具名单不会随升级增加权限；连接专属 Skill 使用同一 Core 工具说明。

1. `iris_core_vision_models` 只读配置候选；目录存在不是健康测试。
2. `iris_core_import_image` 用稳定 UUID 导入原图，不调用模型。
3. `iris_core_create_vision` 保存 `{key,sourceArtifactId,modelRef,question}`；`iris_core_create_ocr` 保存来源、模型及可选 `{chunkHeight,overlap,maxDimension,maxInvocations}`，返回分块计划。创建不推理。
4. 明确授权后，用另一稳定 UUID、原 Run ID 和当前 revision 调用 `iris_core_continue` 一次。Task/Attempt 先于 HTTP 请求落盘。首次执行可能计费。
5. 用 `iris_core_run/operation/lookup` 查原身份；读取、刷新、重连、重启均不提交新请求。文本由 `iris_core_vision_text` 读取，OCR报告由 `iris_core_ocr_result` 读取；使用 Run 返回的 output/report Artifact ID。

每个 Run 固定一个模型；单图至多一次 POST，OCR按实际分块请求分别计数，不把一次 Operation 当作一次模型调用。SSE 正文结束或取消前，Core 保持网络生命周期及 HTTP 调度名额。明确 HTTP 拒绝与不确定受理分别保存；缺少正常终态、断线或调用中取消不能冒充成功。

文本保存为 `text/plain`，OCR另有 `application/json` 报告，各限1 MiB。作品保留来源关系；原图字节不改。交付失败从原私有结果缓存恢复，沿用 Task 和预留 Artifact ID，无需再次调用模型。看图与OCR不执行图片差异比较或版本选择。

Web支持连接能力选择、看图/OCR建单、原任务执行、状态、纯文本查看和下载。v5工作区在创作页选择“看图问答”或“图片文字识别”，上传原图并选择已确认的视觉模型；看图填写问题，OCR可调整每块高度、重叠、最大宽度和最多调用次数。

首次点击“保存看图任务”或“保存OCR任务”只保存素材和Run，不调用模型；输入随后固定，OCR显示实际分块数及调用上限。核对后再点击“开始看图”或“开始识别”执行。手机上待执行视觉任务保持设置区展开以便核对计划，完成后可收起查看结果。从MCP或CLI保存的Run也可在页面明确继续。旧根隐藏这些创建方式，只读服务不能创建或执行；有创建权限但未开启执行的服务可先保存任务。

回包丢失时按原Key读取保存结果，不自动重提；本标签页恢复日志仅保存身份，不保存图片字节、问题或分块参数。图片文字作为数据显示，不解释为HTML或执行其中的指令。

CLI 也可在 v5 根保存明确输入：

```bash
node bin/dsh-iris.js flow create --data-root /absolute/new-vision-core \
  --provider-config /absolute/existing-providers.json \
  --input '{"recipe":"vision/v0","model_ref":"provider::vision-model","source_artifact_id":"artifact_实际ID","question":"描述图片"}'
```

使用实际返回的 Run ID 执行既有 `flow continue`，只读 `flow inspect` 或显式 `flow export`。OCR输入改用 `recipe:"ocr/v0"` 和可选 snake_case 设置 `chunk_height/overlap/max_dimension/max_invocations`。

## OCR 完成度与停止

整体预算120秒，最多32块/32次模型调用，默认块高1200、重叠120、最大宽度2048；EXIF方向及缩小后的几何用于分块。创建时保存计划与调用上限。Core出口预检的候选预算与OCR模型调用预算分别计算。

- `complete`：所有段获得完整结果；`partial`：至少一段成功，仍有失败或跳过段。正文保留段号与纵坐标，报告含每段状态、安全错误类别、实际调用数与输入缩小事实。
- 预算耗尽的剩余段标记 skipped；单段失败不重排后续段号，不自动重试未知受理的原段。部分结果保存在原作品中，Run 为 `needs_attention`；Task/Operation 调用成功不等于全文完整。
- 全部段失败时保留失败 Task 和创建计划，不交付成功文本/报告；全部明确拒绝仍是 `not_accepted`，不能为生成报告而伪造已受理。失败原因通过安全 Task 摘要读取。
- 取消/超时停止后续调度，沿用原 OCR 语义，不交付此前的部分正文。保留原 Task/Operation；进程重启不续块或重做整张图。
- 本地停止不保证 Sharp 已停止、远端取消、退费或停止计费；需要重新识别时，另行明确授权创建新 Run。

## 有限 HTTP 入口

均在 `/api/v0` 下，沿用 Bearer、Host/Origin、根版本、scope及精确工具校验：

| 入口 | 行为 |
| --- | --- |
| GET/HEAD `/vision-models` | 只读 `{modelRef,displayName}`，无凭据或端点 |
| POST `/visions` | `{sourceArtifactId,modelRef,question}`，UUIDv4 Idempotency-Key，201/同Key200 |
| POST `/ocrs` | `{sourceArtifactId,modelRef,chunkHeight?,overlap?,maxDimension?,maxInvocations?}`，相同幂等规则 |
| GET/HEAD `/artifacts/:id/vision-text` | 本能力流程的原 UTF-8 文字，最多1 MiB |
| GET/HEAD `/artifacts/:id/ocr-report` | 原 JSON 报告，最多1 MiB；不允许读取其他JSON作品 |
| GET `/runs?kind=vision` 或 `kind=ocr` | 按选择能力过滤的只读历史；image分类排除这些文字流程 |

复用原 Run/Operation/continue/lookup/stop/download；FlowView 新增 question或OCR设置、plan、report引用与ocr完成度摘要。旧转写 `/text` 不读取视觉作品，新文字入口不读取转写作品。协议回归、受控模型结果、真实模型识别质量和实际客户端展示是不同证据；测试通过不保证任意供应商或图片的识别准确率。
