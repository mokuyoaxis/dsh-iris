# Core 供应商、模型池与健康检测（0.3 alpha）

此页描述0.3.0-alpha.1的配置界面，**稳定 npm 0.2.7 不包含该入口**。它管理 Iris 媒体供应商；harness 接入权限仍在连接中心管理，各家聊天模型登录与 OAuth 不由此页接管。

## 开启管理

使用已有私有配置和专用 Flow 根。需要新配置时，先明确初始化，不覆盖已有文件：

```bash
node bin/dsh-iris.js config init --provider-config /absolute/new-providers.json
node bin/dsh-iris.js web serve --data-root /absolute/existing-flow-root \
  --provider-config /absolute/new-providers.json --allow-provider-management
```

普通工作台使用访问口令：首次打开启动输出的 `loginUrl` 设置，之后用普通地址。完整空配置、执行根初始化和登录恢复见 [Core 快速开始](CORE_QUICKSTART.md)；显式 Token 模式保留兼容，不是必填参数。

管理是独立开关，只有 owner 可用；普通连接、MCP read/execute、连接管理、媒体执行或选择均不隐含此权限。可以只管理配置，不启用媒体写入；会话 `readOnly` 只描述媒体权限，`providerManagement` 单独描述管理权限。

保存供应商也意味着信任其网络端点和返回的媒体地址；现有下载可跟随上游重定向，没有按目标网段隔离。HTTP 保留用于本地网关与 ComfyUI，远程明文地址会暴露传输中的凭据或内容，应使用 HTTPS 或受控隧道。响应大小/超时限制不代替网络目标限制；普通 MCP 连接不能借供应商管理修改地址。

同时改图时，在已明确初始化的 v1/v2/v3 执行根另加 `--allow-execution --allow-selection`；文生图需 v2/v3 根，见 [文生图与 ComfyUI](IMAGE_GENERATION.md)。[语音合成与转写](AUDIO_FLOWS.md)需显式新 v3 根和执行开关，音频结果无需图片选择。沿用原配置 JSON 与 CLI；不迁移旧根，服务启动不自动创建配置。

## 配置流程

“模型服务”分为供应商、功能模型池、健康检测三个入口。供应商先显示名称、地址、模型数和配置状态的概览卡片，按六色鸢尾使用极浅点缀；“已配置”不代表实测通过。点击服务卡片或“添加服务”进入编辑，连接、模型与用途、ComfyUI工作流分组显示。顶部返回与底部取消使用同一草稿确认，未保存修改可保留或明确放弃；保存结果未确认时，先重新读取核对。隐藏分组中的必填连接字段无效时，会显示该分组并定位字段。

1. 从“模型服务”或创作区“管理模型”进入，选择卡片或“添加服务”。选预设/自定义，填写名称、Base URL 和认证；高级连接设置默认折叠。稳定 ID 自动生成，不作为日常重命名入口。
2. 现有 Key 只显示存在状态，不回显。明确选择保留、填写/替换或清除；服务实际不要求认证时可选“无需认证”，保留的旧 Key 不发送。
3. 可以先仅保存连接，再主动读取目录；目录只使用已保存连接。也可直接手填模型 ID。
4. 勾选图片/视频/语音/音乐/转写/视觉用途再保存。新勾选用途时，原本停用的对应功能会改为自动选择，摘要明确列出。已有自动/手动设置不因打开页面而改变。
5. 返回列表，进入“功能模型池”独立选择自动、手动排序或停用。手动勾选模型后可上移/下移，按显示顺序保存；取消可放弃未保存的池设置。自动和手动均沿用运行时的协议、连接、限流与模型可用性过滤，按顺序优先选择，不是跨请求轮询。手动空池不回落到自动。

目录结果暂存在页面，搜索/加入草稿不写配置、不批准用途。目录元数据与实际协议支持不同；标注用途后运行时仍验证协议、限流和可用性。模型级图片/音乐协议在折叠项中选择：图片可沿用供应商默认，音乐必须明确选择，空值不回落到供应商默认。`gemini-web-music` 的显示名称统一为“Chat Completions（内嵌音频）”，不限定供应商或模型名称，详见[音乐接口](MUSIC.md)。

当前 Core Web/MCP 支持图片生成/编辑及新 v3 根上的语音合成/转写；视频、音乐、视觉可在此页配置用途，但尚未进入这些新创作入口，继续使用已有 DSH/CLI 能力。配置用途、接口支持和创作入口覆盖是不同事实。

ComfyUI 预设提供已有服务地址和默认折叠的 API 图/Iris v0/v1 模板导入。每份工作流作为一个明确的图片模型，绑定正向提示词、输出和可选尺寸节点；可勾选已有标量、命名参数并预览表单。导入不执行，同名替换明确确认，加入草稿并保存后才能从创作页选择。目录检查只验证服务并列出已配置工作流，不把远端 checkpoint 自动当成可调用工作流。流程与限制见 [ComfyUI 入口](IMAGE_GENERATION.md#comfyui-入口)。

快速填写或直接切换媒体协议进入 ComfyUI 时，供应商编辑区显示 `ComfyUI Studio` 标识并播放一次鸢尾渐变扫光；编辑普通字段不会重复播放，离开模式会清除标识。减少动画设置下保留静态模式提示，不播放扫光。切换本身不保存配置或调用服务。

ComfyUI 切回“自定义兼容服务”会恢复本次编辑中先前的 API 地址、媒体地址、协议、认证和未提交密钥；没有此前 API 草稿时，显示空地址的通用 API 草稿，不沿用 ComfyUI 地址。切换前的连接字段仅暂存在当前页面内存，重新载入或退出后清除。显式选择 OpenAI/百炼预设会使用相应地址、协议与 API Key 认证，并清除旧媒体地址覆盖；供应商名称与模型列表仍由用户确认。已保存 ComfyUI 配置重新打开时，快速选项与实际协议一致。

Core 参数表单与 `POST /api/v0/provider-management/workflow-check` 已接通：owner 提交 `{expectedRevision,modelRef,workflowParameters?}`，或使用 `{expectedRevision,providerId,comfyWorkflow,workflowParameters?}` 检查未保存模板。草稿只能使用已保存、启用的 ComfyUI 连接，不接受临时地址或凭据；只查询节点定义，返回静态问题和可用选项，不写配置、不创建 Task、不入队。需同一供应商管理开关，仍受 Host/Origin、revision 与请求大小限制；静态通过不代表推理通过。DSH 的独立入口见 [DSH 工作台](IMAGE_GENERATION.md#dsh-工作台入口03-alpha)。详见 [参数模板与检查](IMAGE_GENERATION.md#comfyui-参数模板与只读检查后端)。

连接/模型保存与独立模型池保存均复用原锁、revision 摘要、0600 备份与原子写入。未改动供应商、模型与额外字段保留。原模型可清空用途，新模型可撤销添加。配置及备份仍含 Key，应保存在当前用户控制的私有位置。

设置 `revision` 是不透明的编辑版本：账号、凭据、模型、分配或其他配置变化仍冲突，单纯的健康时间与目录缓存更新不作编辑冲突。保存基于最新配置合并，并在锁内复核原文件字节，保留已有的健康证据；不能用该 revision 替代文件摘要或跳过写入锁。

编辑页“停用与删除”默认折叠。停用保留连接、模型与池设置，可原地恢复；删除先显示模型和当前工作区的任务/流程影响，再独立确认。当前根中未开始的流程、运行中任务、受理或结果未知、待交付或交付失败、取消待确认会阻止删除。成功交付及已失败/取消的历史保留，不删除作品或任务；同时移除该供应商的手工池引用，不把空手工池改成自动。只检查当前 Core 根，其他工作区和独立 DSH 消费者不扫描；本地删除也不吊销上游 Key，私有配置备份保留原凭据。

修改地址、认证或协议使相应旧验证失效，限流/额度保留原语义。旧 Task 仍绑定原端点和协议；变更地址、停用或清除认证可能阻止恢复，不改绑或自动新提交。

## 健康检测与保活

六色“能力光谱”分别显示六类能力的当前候选、近期成功和参与项；候选详情默认折叠，列出顺序、未进入池/协议不支持/模型不存在/冷却/额度受阻等原因与最近证据时间。读取和刷新仅汇总本地配置与持久证据，不请求供应商。

“检查连接”只读取已保存连接的模型目录；ComfyUI 使用原服务状态检查。结果单独记录时间，连接可达、目录列出、Key 存在或声明用途均不算媒体成功。可以显式开启每1/5/15分钟的轻量保活，默认关闭、首次等待所选间隔、不重叠请求。仅支持已有轻量读取的内置协议，外部扩展保留手动目录入口。设置与检查结果只在本次 Core 服务中保留；停用、删除、关键连接变化或服务关闭会停止，服务重启默认关闭。它不是持久监控或媒体可用性保证。

执行开启且存在相应入口时，候选模型可“准备功能验证”：图片打开指定模型的小样本草稿（旧图片根为改图），语音预填“你好”，转写仍需用户音频；ComfyUI 沿用实际工作流参数。打开草稿不提交，只有点击创作页原生成/转写按钮才进入 Core Run/Task/Operation，可能计费，不批量测试。视频、音乐、视觉仍明确显示已有 CLI/DSH 范围。也可用原 `models test` CLI 显式测试。

真实媒体的成功受理/同步完成沿用精确连接、模型、能力绑定，写入近期健康证据；这不额外证明最终下载或可播放。改变关键连接后旧证据失效，冷却和明确额度停用保持原规则；普通任务成功不能代替显式实测解除额度停用，见[健康状态](PROVIDER_HEALTH.md)。

保存中禁用重复提交。revision 冲突保留草稿，拒绝覆盖；回包丢失标记未知，不自动重试。选择“重新读取”并明确确认放弃草稿后，读取文件的实际结果。刷新、目录和保存不生成媒体。

## 管理 HTTP 契约 v0

固定操作启动时的配置路径，浏览器不能传路径、原文件或任意命令。请求沿用 Bearer、Host/Origin、无 CORS、no-store 和净化错误。POST 为 UTF-8 JSON，最多 64 KiB，同实例同时只处理一个管理变更/目录请求。

| 路由 | 语义 |
|---|---|
| GET/HEAD `/api/v0/provider-management/settings` | owner 非秘密投影：版本、revision、来源标识、协议描述、供应商、模型、全局功能池；Key 仅存在状态 |
| GET/HEAD `/api/v0/provider-management/diagnostics` | 当前候选/阻塞原因/有限历史证据及本次服务的连接检查状态；不发起检查 |
| POST `/api/v0/provider-management/save` | `{expectedRevision, provider, credential, assignments?}`，保存一次，返回新投影，不返回备份路径 |
| POST `/api/v0/provider-management/policies` | `{expectedRevision, assignments}`，独立保存明确修改的功能模型池 |
| POST `/api/v0/provider-management/enabled` | `{expectedRevision, providerId, enabled}`，停用或恢复 |
| POST `/api/v0/provider-management/impact` | `{expectedRevision, providerId}`，只读当前 Core 根的删除依赖及模型影响 |
| POST `/api/v0/provider-management/remove` | `{expectedRevision, providerId, confirm:true}`，同 Core 写队列重新核对依赖后删除配置，受保护依赖返回409 |
| POST `/api/v0/provider-management/check` | `{expectedRevision, providerId}`，一次轻量只读检查；失败返回 `ok:false` 与有限分类，不回显上游原文 |
| POST `/api/v0/provider-management/monitor` | `{expectedRevision, providerId, enabled, intervalSeconds:60\|300\|900}`，本次服务内的显式保活 |
| POST `/api/v0/provider-management/discover` | `{expectedRevision, providerId}`，返回最多 256 模型、`persisted:false` 与截断标记，不写配置 |
| POST `/api/v0/provider-management/workflow-check` | 明确模型或已保存连接上的模板草稿，返回静态检查及参数候选；不写配置或入队 |

`provider` 只接受 `id/name/baseUrl/mediaBaseUrl/mediaProtocol/enabled/auth/models`；单次最多 256 模型，每项接受 `id/capabilities/imageProtocol/musicProtocol` 及可选 `comfyWorkflow`。工作流支持 `{version:0,graph,promptNode,outputNode,sizeNode?}`，也支持增加明确 `parameters` 的 v1 模板；Core 导入控件可创建两者，完整 v1 的声明随设置保存。普通保存省略工作流时保留原图，读取只返回摘要和参数描述，不回显 `graph`。未提交的原模型保留。`credential` 为 `{action:"keep"}`、`{action:"clear"}` 或 `{action:"replace",value:"new-key"}`，拒绝额外秘密字段。`assignments` 只含本次修改的能力，值为原有 `{mode:"auto"|"manual"|"disabled",models:[...],hostVision?:boolean}`，不创建第二套格式。

未开启 405、连接越权 403、revision 冲突/锁占用 409、非法设置 400、正文过大 413。已加载的 [Provider 扩展](PROVIDER_EXTENSIONS.md)通过实例描述进入页面；页面不能安装或加载代码。环境凭据引用、DSH 来源桥（C3c）仍未实施。
