# Provider Adapter v0 生命周期契约

状态：**Iris 0.2.1；沿用 v0 生命周期内部契约。** 0.1.4 建立六操作契约，0.2.0 增加可选输入准备能力，0.2.1 增加聊天/Responses 生图及模型级协议覆盖。 这是 Iris Core 模块与供应商协议实现之间的内部边界，尚未冻结为第三方公开 SDK。DashScope 与 OpenAI Images 兼容实现通过同一套零网络 conformance runner；聊天/Responses 图片协议另有提交、交付与 CLI 回归。

## 目标与依赖方向

```text
Action / Task watcher / recovery / model discovery
                       │ canonical operation/result
                       ▼
              provider-adapter.js
                       │
              provider-adapters.js
                       │ injected transport
                       ▼
                 adapters.js
```

- Action、Task 恢复、重新交付、模型发现和能力实测不得直接调用供应商生命周期 HTTP 方法。
- Provider Adapter 不创建或修改 Iris Task，不读取 DSH `ctx`，也不承担工作台展示。
- `adapters.js` 保留为协议级 HTTP transport；凭据和实际媒体端点仅由具体 Adapter 的操作闭包捕获。配置可用 `mediaBaseUrl` 分离媒体与普通/视觉端点，空值沿用 `baseUrl`。
- Adapter 快照只包含稳定身份、协议、能力与 supported/unsupported 事实，不包含 API Key、Authorization、私有 URL、配置对象或 live transport。

## 描述结构

协议工厂由内部注册表选择；0.2.0 基线提供 `dashscope` 和 `openai-images`，0.2.1 另有 `openai-chat-images` 与 `openai-responses-images`，不提供公开注册 API。生图模型可通过可选 `imageProtocol` 覆盖账号默认；选择、实测与 Task binding 共用有效协议，详见 [模型级图片协议](CLI_MANAGEMENT.md#模型级图片协议)。未知的显式 `mediaProtocol` 保留原值，调用时以 `IRIS_PROVIDER_PROTOCOL_UNSUPPORTED` 在联网前拒绝；错误只包含合法协议标识，不回显端点或凭据。

未配置协议或选择 `auto` 时，官方端点可识别为对应协议；其他端点继续使用 OpenAI Images 兼容路径，并标记 `protocolInferred:true`。该标记表示尚待用户确认兼容性，不代表已经验证成功。显式选择协议会清除标记；旧记录中已保存的明确协议不追溯猜测其来源。CLI 与 DSH 共用选择逻辑，Task binding 绑定最终实际协议与端点。

视觉理解的 `type` 使用独立注册表，目前只有 `openai` 实现。导入保留显式类型；未支持类型在该后端调用前返回 `IRIS_VISION_PROTOCOL_UNSUPPORTED`，不会被静默改写为另一种协议。错误保留在后端链的 `errors` 中，既有宿主视觉降级仍可继续。`auth:'none'` 不发送认证头，缺省认证方式仍为 `bearer`。

`defineProviderAdapter()` 只接受以下顶层字段：

```js
{
  contractVersion: 0,
  id: 'stable-provider-id',
  protocol: 'dashscope',
  capabilities: ['image', 'video', 'tts', 'transcribe'],
  operations: { discover, submit, poll, download, mapError },
  unsupported: { cancel: '经过验证的原因' },
  // 可选扩展：prepareInput 或 unsupportedPreparation，二者不能同时声明
  prepareInput: async ({ model, filePath, signal, timeoutMs }) => ({ url: '临时地址' })
}
```

六个操作必须**恰好**出现在 `operations` 或 `unsupported` 之一。方法缺失不能被解释为临时故障；调用显式不支持的方法会得到稳定的 `IRIS_PROVIDER_OPERATION_UNSUPPORTED`。v0 要求所有 Adapter 实现 `submit` 与 `mapError`，其余操作可根据协议事实显式声明不支持。

`prepareInput` 不属于这六个生命周期操作。未提供该扩展的旧 Adapter 仍有效，能力快照中的 `inputPreparation` 会标为 unsupported；具体协议也可以用 `unsupportedPreparation` 给出受控原因。快照不包含凭据、端点或临时地址。

## 生命周期操作

| 操作 | 输入职责 | canonical 结果 |
|---|---|---|
| `discover` | 可选 signal/timeout | `{ models: [{ id, capabilities? }] }`，去空并按 ID 去重 |
| `submit` | capability、model、规范化 input、signal | `completed / accepted / not_accepted / acceptance_unknown` |
| `poll` | capability、remoteTaskId、signal | `pending / succeeded / failed / canceled / unknown` |
| `cancel` | remoteTaskId、signal | `canceled / not_supported / unknown` |
| `download` | 可物化 artifact、目标路径、signal | `{ bytes }` |
| `mapError` | 原始错误与 stage/acceptance 上下文 | 可持久化的脱敏错误记录 |

Core Attempt 持久化 `providerId::modelId` 复合身份，具体 Provider Adapter 的 `submit.model` 只接收供应商原始模型 ID；复合引用不得穿透到 HTTP。

`accepted` 不是独立网络操作，而是异步 `submit` 的受理结果。它必须携带非空远端任务 ID；同步成功使用 `completed`，并提供 canonical `artifacts`。迁移期仍保留可直接读取但不随 JSON 序列化的旧 `value`，供 0.1.4 调用方使用。四态提交和自动 failover 规则继续以 [Provider 提交契约 v0](PROVIDER_SUBMISSION_CONTRACT.md) 为准。

## poll、cancel 与交付事实

`poll` 的终态不能互相折叠：

- `failed` 需要供应商明确的失败证据；
- `canceled` 需要远端确认，Task 才能写入 `cancelState=remote_confirmed`；
- `unknown` 只停止当前盯守并保留 `acceptance=accepted`，不得伪造失败或重提；
- `succeeded` 和图片 `completed` 使用同一可物化描述：`remote-url` 或 `inline-base64`；文本任务仍可使用 text value。生成成功先于本地物化事实落盘。

`download` 物化已经确认成功的产物：`remote-url` 执行下载，`inline-base64` 直接写入私有 staging。inline 正文只作为 non-enumerable 的短生命周期字段传给 Runner，不进入 JSON、Task 或 Manifest。生图产物按真实字节校验 PNG/JPEG/WebP，保留字节、MIME、后缀和哈希。物化失败只能改变交付状态，不能触发生成重提。OpenAI Images、聊天生图与当前 Responses 生图切片均同步返回图片，所以 `poll` 与 `cancel` 显式 unsupported；Responses 纯文字、缺图或未完成结果保留受理未知，不扫描其他接口。DashScope 当前没有经过验证的远端取消接口，因此 `cancel` 同样显式 unsupported，而不是伪装取消成功。

聊天改图仍使用 `capability:image`：Runner 从当前 Core 校验并读取来源 Artifact，短生命周期 `input.image:{bytes,mediaType}` 与 `prompt` 交给聊天适配器。适配器按实际模型 `visionInput` 准备副本，HTTP 用户消息使用 `text` 与 `image_url` data URL。普通 Images/Responses 不接受此输入，编辑候选链预先过滤协议。Task 仅保存可选 `sourceArtifactId`，用于未知/失败任务的来源保护和交付时写入新 Artifact 的 `derived-from`；旧记录无需迁移，重试仍重新提供输入。来源或编辑输入预算失败发生在 HTTP 之前。

## 可选输入准备与上传边界

Host 和 CLI 通过 `prepareProviderInput(adapter, { model, filePath, signal?, timeoutMs? })` 调用可选准备能力，不能自行绕过 Adapter 上传。DashScope 的 Adapter 闭包持有实际凭据与媒体端点并实现临时上传；OpenAI Images 明确不支持。未实现时在网络调用前抛 `IRIS_PROVIDER_INPUT_PREPARATION_UNSUPPORTED`。返回的 `{url}` 只供紧随其后的提交读取，属性不参与 JSON 序列化，不能进入 Task、日志或能力快照。

上传错误经 Adapter 映射与脱敏，固定为 `stage=upload / acceptance=not_accepted`；这组字段属于返回调用方的安全错误分类，**不等于已持久化的 Core Attempt stage**。上传属于 Host/CLI 输入准备，只有随后真正调用 `submit` 才跨越可能计费的受理边界。S2V 已迁入 Core：先持久化 Attempt，再按实际候选账号上传首帧和音频，上传失败可写入该 Attempt，且不调用生成 submit；Core 转写的 `audio_path` 在创建 Task 前上传，失败会直接返回且不创建 Core Task，也不会调用 submit。这是 D-12 当前采用的路径 B；若未来要求把准备失败纳入 Core 事实，须另行评审路径 A，不能由错误字段反推已经落盘。

## 错误与取消传播

所有操作接收可选 `AbortSignal`。底层发现、轮询、下载和提交 transport 必须把外部 signal 与自己的超时合并。错误映射只保留受控字段：

- stage、category、acceptance、retryable；
- 可选安全的 HTTP status/provider code；
- 已移除密钥、认证头、绝对路径和签名查询的 `safeMessage`。

`submit` 抛错由统一调用器转换成保守四态；`cancel` 抛错转换为 `unknown`；`discover/poll/download` 抛出脱敏的 `ProviderContractError`，由各自调用方应用重试和事实规则。

## 当前内置实现

| 协议 | discover | submit | poll | cancel | download | mapError |
|---|---:|---:|---:|---:|---:|---:|
| DashScope | 支持（`/api/v1/models` 分页与能力元数据） | 图片/视频/TTS/转写 | 图片/视频/转写 | 显式不支持 | 支持 | 支持 |
| OpenAI Images 兼容 | 支持 | 同步图片 | 显式不支持 | 显式不支持 | 支持 | 支持 |

本表只描述协议生命周期，不扩大 0.1.4 的供应商范围。Gemini、Fal 与 Replicate 仍在 0.2.x 路线中。

## conformance runner

### 协议 Transport 接口

`provider-adapters.js` 的构造器接受可选 `transport`，默认使用 `adapters.js`。它是内部协议实现与测试 fixture 的注入边界，不是 Core API。除独立下载方法外，网络方法接收 `key`、`baseUrl`、可选 `signal`/`timeoutMs`；只有适用方法接收 `model` 或 `remoteTaskId`。

| 方法 | 额外输入 | 返回值 |
|---|---|---|
| `listModels` | 无 | 模型条目数组，保留能力元数据 |
| `dashscopeImageMode` | 原始模型名（位置参数） | `legacy-async` 或 `multimodal-sync`，本地判断 |
| `submitImage` | `prompt/size/n` | 远端任务 ID |
| `generateImageMultimodal` | `prompt/size/n` | 图片 URL 数组 |
| `openAiGenerateImage` | `prompt/size/n` | URL 或 base64 图片条目数组 |
| `submitVideo` | `prompt/imgDataUrl/size/duration/audioUrl/resolution` | 远端任务 ID |
| `submitTranscription` | `audioUrl` | 远端任务 ID |
| `synthesizeTts` | `text/voice` | `{audioUrl}` 或 `{audioB64}` |
| `pollTask/pollTranscriptionTask` | `remoteTaskId` | 协议结果，由 Adapter 归一化为 canonical poll 结果 |
| `uploadTempFile` | `model/filePath` | 临时输入 URL；仅由支持该扩展的协议 Adapter 调用 |
| `downloadTo` | URL、目标路径、选项（位置参数） | 写入字节数 |

transport 抛出的原始错误必须经 Adapter 的错误映射；提交异常不能直接授权重提。`uploadTempFile` 经过 `prepareProviderInput` 归一化错误，但仍不属于六个 canonical 操作。

### 验证方式

零网络 runner 位于 `tests/fixtures/provider-conformance.mjs`，并由 `tests/provider-adapters-conformance.mjs` 对内置实现执行。它验证：

1. 快照可序列化且不含凭据；
2. 六个操作全部被 supported/unsupported 记账；
3. 每个 supported 操作都有 fixture 场景；
4. unsupported 调用返回稳定错误；
5. mapError 会清除 synthetic secret 与本地路径；
6. 提交四态、轮询五态、URL/inline 物化字节数和协议特定能力符合契约；
7. 同步多图片进入同一 Core Task，坏同步响应保持受理未知并停止 failover。

runner 本身不访问网络；具体 Adapter 构造时注入 fake transport。新增 Provider 前，必须先通过同一 runner，再进行用户明确授权的真实供应商短验。0.1.4 不发布 Provider SDK，也不把测试 runner 当成第三方兼容性承诺。

可选准备能力另由 `tests/provider-input-preparation.mjs` 和调用方的转写/s2v 测试覆盖：包括未支持协议零网络拒绝、临时 URL 不序列化、上传错误脱敏及上传前后受理边界。
