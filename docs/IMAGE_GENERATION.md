# Core 文生图与 ComfyUI（0.3 alpha）

当前源码支持固定 `image-generate/v0`：无需原图，使用明确的 `provider::model` 和提示词生成一张图片。它与改图共用 Run、Operation、Task、作品、原 Key 恢复和有限执行；生成结果无需像素比较，明确选择后可下载或用作下一次改图的原图。**npm 0.2.7 不包含本页的新流程、页面或 MCP 入口。**

## 新建支持文生图的工作区

在新的专用位置初始化 v2 执行根；不要转换现有数据根：

```bash
node bin/dsh-iris.js flow init --data-root /absolute/new-image-core
node bin/dsh-iris.js execution init --data-root /absolute/new-image-core --image-generation
node bin/dsh-iris.js web serve --data-root /absolute/new-image-core \
  --provider-config /absolute/private-providers.json \
  --token-file /absolute/new-owner-token \
  --allow-execution --allow-selection --allow-provider-management
```

v2 可同时保存文生图和改图。原 v0/v1 根继续支持原编辑行为，不自动升级、迁移或开启新功能；旧写者拒绝 v2。连接凭据与恢复身份仍绑定各自的 rootId。

在创作设置选择“生成图片”，明确选择模型、填写画面描述，再点击“开始生成”。创建和执行各使用独立 Key，双击合并；创建结果未知时先找回原 Run，不自动开始生成。修改已有输入需新建流程。

CLI 也可创建同一流程，创建本身不调用模型：

```bash
node bin/dsh-iris.js flow create --data-root /absolute/new-image-core \
  --provider-config /absolute/private-providers.json \
  --input '{"model_ref":"my-provider::my-model","prompt":"A violet iris in soft morning light","n":1}'
node bin/dsh-iris.js flow continue run_REPLACE_WITH_RETURNED_ID \
  --data-root /absolute/new-image-core --provider-config /absolute/private-providers.json
```

`run_REPLACE_WITH_RETURNED_ID` 须替换为创建实际返回的 Run ID。后续继续、选择和导出见 [图片流程](IMAGE_FLOW.md)。已有 Task 有 Attempt 时只处理原任务；受理未知不重新提交。异步任务每次“查看原任务”只观察一次；“停止等待”不等于远端取消或停止计费。

## ComfyUI 入口

需要你已运行的 ComfyUI HTTP 服务和一份能在该服务上执行的 API 工作流。Iris 不安装 ComfyUI、模型或自定义节点，不启动 GPU 服务；独立网页不嵌入节点编辑器。

1. 供应商页选择“ComfyUI · 已有服务”，填写 Iris Core 能访问的地址；本机通常是 `http://127.0.0.1:8188`。远程 Core 的这个地址指向 Core 所在机器。原生 ComfyUI 可选无需认证，受保护的反向代理可使用 API Key/Bearer；不提供 Comfy Cloud/OAuth 登录适配。
2. 在 ComfyUI 使用 **Export (API)** 导出。展开“ComfyUI 工作流”，导入 API 图或完整 Iris v0/v1 模板，最多 40 KiB、256 个节点；参数声明也计入模板大小。普通画布格式不能直接执行。
3. 填写稳定的工作流名称，明确正向提示词节点（替换其 `inputs.text`）、图片输出节点和可选尺寸节点（替换 `inputs.width/height`）。展开“开放参数”，勾选已有标量输入、命名并选择整数/小数类型；右侧设置区提供使用时的表单预览。完整 v1 模板保留原参数 ID、类型、范围、选项和顺序。
4. 已保存、启用的 ComfyUI 连接可做“只读检查”，不保存草稿、不创建 Task、不入队。点击“加入模型草稿”，同名替换需确认，再“保存设置”。连接地址或密钥尚有编辑时，先保存连接，再重新导入模板检查。
5. 创作页选择此工作流，填写提示词及开放参数。LoRA 槽位分别显示模型与 CLIP 权重，更多参数默认折叠；“检查参数并读取选项”取得当前服务的候选，超出 256 项时保留手填。检查不会替换当前参数；修改输入或切换工作流使旧检查结论失效。
6. “开始生成”才提交一次工作流，之后明确查看原任务并取回图片。没有绑定尺寸节点时使用模板尺寸，页面禁用尺寸覆盖。首次 v1 提交前后端重新检查实际参数；服务缺少节点/模型或执行失败时，请结合原 ComfyUI 任务检查。

“打开 ComfyUI”在浏览器新标签打开所填服务地址；它不为远程服务建立代理或转发。工作流可调用节点自己的外部服务，应只导入你了解的流程。原始图配置保存在私有 Provider 文件及其备份中，普通设置读取只显示摘要和绑定，不回显图正文；不要将账号凭据写入图节点。

参数表单按模板声明显示，不添加 LoRA 节点或安装模型；多个 LoRA 需要原图已有多个槽位。只读检查需 owner 与 `--allow-provider-management`，仅执行连接仍可填写已开放的参数并按原权限生成。生成点击时固定本次参数快照，新 v1 表单保存全部开放参数的取值；草稿不写入 sessionStorage，恢复表仍只保存请求身份。结果的“流程详情”显示 Run 中实际记录的参数 ID 与值，不用最新模板默认值补写历史；未记录的输入仍依赖原模板。真实 GPU 出图、节点级进度和推理预览尚未验收或接入。

运行时使用 `/prompt`、`/history/{prompt_id}`、`/queue` 和 `/view`。历史和队列都找不到的原任务标记未知，不重新排队。取图只接受原服务的图片接口，不读取 ComfyUI 机器上的任意文件路径。工作流摘要进入原 Task 连接绑定；更改工作流后旧任务不会悄悄改用新图恢复。首版不调用共享服务的全局 `/interrupt`。

协议依据：[官方路由](https://docs.comfy.org/development/comfyui-server/comms_routes)、[API 工作流示例](https://github.com/Comfy-Org/ComfyUI/blob/master/script_examples/basic_api_example.py)、[原任务与取图示例](https://github.com/Comfy-Org/ComfyUI/blob/master/script_examples/websockets_api_example.py)。Iris 仅接入 HTTP 协议，不随包分发 ComfyUI 或其运行依赖。

2026-10-26 已在线复核官网及官方源码提交 [`fe298e4`](https://github.com/Comfy-Org/ComfyUI/tree/fe298e4e20f1ff26d30e8639267bbd0b57811390)。以下是当前适配边界，源码核对与受控测试不代替真实 GPU 验收：

- [`POST /prompt`](https://github.com/Comfy-Org/ComfyUI/blob/fe298e4e20f1ff26d30e8639267bbd0b57811390/server.py#L1164) 会验证并入队，不是只读验证接口。Iris 的只读检查只 GET 节点定义；实际生成才提交一次，并以返回的任务 ID 查询历史/队列，取图沿用官方的文件名、子目录和类型参数。
- [LoRA 官方定义](https://github.com/Comfy-Org/ComfyUI/blob/fe298e4e20f1ff26d30e8639267bbd0b57811390/nodes.py#L714)分别提供模型与 CLIP 权重，多个 LoRA 依靠已有节点串联。候选来自服务端节点定义；Iris 不直接扫描模型目录。
- 官方当前支持[带任务 ID 的中断](https://github.com/Comfy-Org/ComfyUI/blob/fe298e4e20f1ff26d30e8639267bbd0b57811390/server.py#L1262)，但 Iris 首版尚未接入，仍不发送远端 `/interrupt`；停止等待不表示远端已取消。
- 官方[采样器种子](https://github.com/Comfy-Org/ComfyUI/blob/fe298e4e20f1ff26d30e8639267bbd0b57811390/nodes.py#L1606)支持 unsigned 64-bit；Iris 的整数输入限于 JavaScript 安全范围。API 图中直接填写的越界整数也会拒绝，请将种子调至 `0`–`9007199254740991` 后重新导出，避免静默舍入。
- Iris 提交整份图，只导入所选输出节点的一张图片；其他输出节点或图内外部服务仍可能执行。[SaveImage](https://github.com/Comfy-Org/ComfyUI/blob/fe298e4e20f1ff26d30e8639267bbd0b57811390/nodes.py#L1669)默认可把图与提示词写入 PNG 元数据，Iris 保留原字节，不自动移除这些元数据。

## DSH 工作台入口（0.3 alpha）

当前源码另在原 DSH 工作台中提供专用区域；**npm 0.2.7 尚不包含以下 ComfyUI 界面**。它使用 DSH 侧原配置和 Core Task，不要求另起独立 Core 服务或创建 v2 Flow 根，也不自动接管独立 Core 面板的配置。

1. “设置 → Iris 工作台 → + 添加供应商”，选择“ComfyUI · 已有服务”。默认地址为 `http://127.0.0.1:8188`，按 DSH 进程可访问的地址修改；可选无需认证或 Bearer。保存连接不探测服务、不生成图片。
2. 在该供应商中导入原始 **Export (API)** 图或完整 Iris v0/v1 模板。明确正向提示词、图片输出和可选尺寸节点；展开“公开参数”，勾选已有标量输入。LoRA 名称、模型权重、CLIP 权重可以分别公开；节点连接不可勾选。普通画布 JSON 不支持。
3. “只读检查”仅查询已保存服务的节点定义，不保存草稿、不创建 Task、不入队。修正问题后点击“保存工作流”；同名替换另行确认，原摘要不符时拒绝覆盖。保留原 JSON，后续修改模板需再次导入。
4. 可明确勾选“保存时将图片功能设为自动池”；首次空配置默认勾选，已有功能池保持原选择。未启用时，到“功能池与调用方式”纳入此工作流。
5. 展开“创作工具 → 画图”，选择具体工作流，再展开默认收起的“工作流参数”。“只读检查并读取选项”可取得服务当前公布的 LoRA、采样器等候选；超出 256 项时可手填名称。多个 LoRA 依赖原图已有节点，不会自动插入或安装模型。
6. 点击“生成图片”才创建生成 Task。请求前重新核对模板摘要；v1 模板还检查实际参数的节点定义。参数改变会清除旧检查结论，切换模型会清空本卡片的参数覆盖。提交结果未知时先查任务列表，不自动重试或改用另一模型。

地址与认证收在默认折叠的“连接设置”，外观跟随 DSH；进入 ComfyUI 区域有一次短暂鸢尾扫光，遵循减少动画设置。工作台和泡泡常用卡片复用同一画图控件。能力健康中的 ComfyUI 实测转到画图表单，实际生成保留受理/观察/作品事实；静态检查通过不表示真实 GPU 出图通过。

## ComfyUI 参数模板与只读检查（后端）

当前后端支持 `comfyWorkflow.version: 1`，在已有 `graph`、`promptNode`、`outputNode` 和可选 `sizeNode` 上增加明确的 `parameters`。原 v0 模板保持；Core 与 DSH 工作台均支持导入、声明及填写参数。没有开放参数时仍保存 v0 固定模板；v1 完整模板也可通过 CLI `providers add/set` 的 `models[].comfyWorkflow` 保存。

例如，已有图中的 `10` 是 LoRA 节点、`7` 是负面提示词节点、`3` 是采样器，可声明下列参数。此片段只是参数声明，须与原 API 图和输入输出绑定一起保存：

```json
{
  "parameters": [
    {"id":"lora","label":"LoRA","node":"10","input":"lora_name","type":"string"},
    {"id":"model_weight","node":"10","input":"strength_model","type":"number","min":-2,"max":2},
    {"id":"clip_weight","node":"10","input":"strength_clip","type":"number","min":-2,"max":2},
    {"id":"negative","node":"7","input":"text","type":"string"},
    {"id":"seed","node":"3","input":"seed","type":"integer","min":0},
    {"id":"steps","node":"3","input":"steps","type":"integer","min":1,"max":100}
  ]
}
```

最多开放 32 个已有标量输入，类型为 `string`、`integer`、`number`、`boolean`，可加数值 `min/max` 或有限 `choices`；默认值来自图，且必须符合声明。参数 ID 和目标不能重复，不能覆盖已绑定的正向提示词或尺寸，也不能替换节点连接。LoRA 模型权重和 CLIP 权重分别声明；多个 LoRA 可使用图中不同节点的不同槽位。整数限制在 JavaScript 安全整数范围，不支持完整 unsigned 64-bit seed。

先做一次只读检查，可提供准备使用的参数：

```bash
node bin/dsh-iris.js models workflow-check comfy::portrait \
  --provider-config /absolute/private-providers.json \
  --input '{"workflow_parameters":{"lora":"portrait.safetensors","model_weight":0.7,"clip_weight":0.4,"seed":42}}'
```

检查只 GET 官方 `/object_info/{node_class}`，每类查询一次，整体默认限时 15 秒。它报告缺失节点、必需输入、可判断的连接引用/类型、标量范围和枚举，包括节点公布的 checkpoint/LoRA 文件名。结果的 `ok` 仅表示这些静态条件满足；不执行节点、自定义校验或推理，不验证模型家族、显存与外部服务，不证明真实出图成功。参数的 `value` 是本次检查值；模型目录中的 `default` 仍是原模板默认值。候选参数选项最多返回 256 个，超出会标记截断；不扫描磁盘或安装模型。`ok:false` 的业务检查结果仍作为 JSON 正常返回，应读取 `ok/issues`。

v1 模板在每次首次提交前重新检查实际参数与尺寸，检查失败或检查网络中断属于未受理，不发送 `/prompt`；真正 POST 入队后的响应丢失仍保守记为受理未知。v0 固定模板沿用原提交行为，可主动运行上述只读检查。

用 CLI 创建带参数的持久流程：

```bash
node bin/dsh-iris.js flow create --data-root /absolute/new-image-core \
  --provider-config /absolute/private-providers.json \
  --input '{"model_ref":"comfy::portrait","prompt":"An iris portrait","n":1,"workflow_parameters":{"lora":"portrait.safetensors","model_weight":0.7,"clip_weight":0.4,"negative":"","seed":42}}'
```

HTTP `POST /api/v0/generations` 和 MCP `iris_core_create_generation` 使用可选 `workflowParameters` 对象；`iris_core_models` 返回已明确开放的参数描述。配置检查需 owner 与 `--allow-provider-management`，通过 `POST /api/v0/provider-management/workflow-check` 发送 `{expectedRevision,modelRef,workflowParameters?}`。未保存的模板可改用 `{expectedRevision,providerId,comfyWorkflow,workflowParameters?}`，仅访问已保存且启用的 ComfyUI 连接，不接受临时地址或凭据；两种选择不能混用。检查不写配置或创建 Task，配置在检查期间变化会拒绝旧结果。普通目录读取仍只列已配置工作流。

单次参数最多 24 KiB，参数化 CLI 输入最多 96 KiB；HTTP 正文仍最多 64 KiB。参数会排序并纳入创建 Key 和 Run 输入摘要；同 Key 不同值冲突，同值不同键顺序可重放。带参数 Run 使用记录版本 2，旧读取者拒绝；无参数 Run、原固定模板和摘要保持，已有根不迁移。这里保存的是请求参数和模板绑定摘要，不保存另一份完整图；原模板改变后仍按原规则拒绝将旧任务重新绑定到新模板，并清除该图片模型的过期实测标记。原 Task 的远端查询不重新检查节点目录或生成。

## MCP 能力选择

连接中心的图片组分别选择“生成图片”和“修改图片”；CLI 对应 `image-generate`、`image-edit`，可逗号组合。文生图新增 `iris_core_create_generation`，参数为原请求 UUID、明确模型、提示词、可选尺寸及明确开放的 ComfyUI `workflowParameters`；创建后通过共享的 `iris_core_continue` 明确执行。

只选择文生图时不注册导入/改图创建工具。原连接默认仍为 image-edit 和原 12 工具，不自动增加能力；两个功能都选且具备全部操作权限时共 13 工具。继续、Run/Operation 和已绑定作品读取都核对流程所属能力；这不是同一用户不同连接之间的租户隔离。配置与传输见 [通用 MCP](MCP.md)。

## 验证范围

定向验证覆盖根版本、稳定步骤/Task、重复 Key、未知受理不重提、原结果恢复、选择/下载、MCP stdio/HTTP 授权和真实 Chromium 操作。ComfyUI HTTP 服务响应为受控夹具，未进行真实 GPU/节点/模型出图验收；没有调用付费媒体。实际服务、反向代理与自定义节点仍需在你的部署上验证。
