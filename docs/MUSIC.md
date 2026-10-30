# 音乐生成

Iris 0.2.3 提供独立音乐生成能力。配置音乐模型后，可以通过 DSH 对话、工作台或 CLI 生成 MP3/WAV，试听、下载并导出同一作品。音乐与文本转语音分别配置，组合创作时按需加入配乐。

## 支持的接口

选择 **Chat Completions（内嵌音频）**：服务接收 OpenAI 风格的 `/chat/completions` 请求，并在 `choices[].message.content` 文本中返回 MP3/WAV 的 `data:audio/...;base64,...` 链接。

接口支持取决于请求和返回格式，不取决于供应商名称或模型 ID。仅声明“OpenAI 兼容”的服务不一定支持这种音频输出；纯文字、远程音频 URL 或其他音频字段不能通过当前接口交付。Google 原生音乐 API 需要独立适配，目前不在支持范围内。

## 工作台配置

1. 添加音乐服务的供应商，填写实际 Base URL 和 API Key；Base URL 应包含服务要求的 API 前缀，例如 `/v1`。
2. 发现或手动添加实际模型，为它设置“音乐”功能标签。
3. 在模型的“音乐协议”中选择“Chat Completions（内嵌音频）”。
4. 在“功能池与调用方式”启用音乐自动池，或选择“仅用所选模型”并将它加入名单。0.2.3–0.2.5 只能使用手选名单。

音乐遵守当前功能允许范围；没有合格候选时提示配置缺失。0.2.6 自动池仍要求确认用途并明确音乐协议，停用不能由临时指定绕过。发现模型、添加标签或修改协议不会提交生成请求。音乐协议独立于账号和模型的图片协议，详见 [功能模型池](FUNCTION_MODEL_POOLS.md)。

配置文件中的 `musicProtocol` 使用现有标识 `gemini-web-music`，以兼容已有配置；这个标识不要求供应商或模型必须命名为 Gemini。

Core 供应商页与 DSH 统一显示“Chat Completions（内嵌音频）”。模型音乐协议必须明确选择，“未指定”不会沿用供应商默认；选择协议本身也不表示该模型已经实测通过。Core 新工作台目前可配置音乐用途，音乐创作入口仍使用下方 DSH/CLI。

## 通过 DSH 或工作台生成

在 DSH 中可以直接描述需求：

```text
用 Iris 生成一首复古摇滚配乐，电吉他和鼓为主，期望约30秒，无人声。
```

也可以明确选择 `/iris-use` 或工具 `iris_generate_music`。工作台的音乐卡片提供描述输入、模型选择、生成、试听与下载。结果保存为 Core 音频作品，可继续查询或导出。

曲长、人声、歌词、语言和节拍通过描述表达，由实际模型决定；当前没有保证精确控制这些属性的独立参数。输入或响应格式不符时会明确失败。

## CLI 配置与生成

下面的 `music-provider::music-model` 是示例，请替换为实际供应商 ID 和模型 ID。配置路径与数据根均使用绝对路径。

```bash
dsh-iris models add music-provider::music-model \
  --provider-config /absolute/path/providers.json \
  --input '{"capabilities":["music-gen"],"musicProtocol":"gemini-web-music"}'

dsh-iris assignments set \
  --provider-config /absolute/path/providers.json \
  --input '{"capability":"music-gen","model_refs":["music-provider::music-model"]}'

dsh-iris run music \
  --data-root /absolute/path/iris-data \
  --provider-config /absolute/path/providers.json \
  --input '{"prompt":"轻快钢琴配乐，期望约30秒，无人声","retry_502":2,"retry_delay_ms":5000,"timeout_ms":300000}'
```

已有模型可用 `models caps` 设置功能标签，并用 `models music-protocol` 设置 `musicProtocol`。这些命令只修改指定配置并保留私有备份，不请求生成。

生成输入为 `prompt`，可选 `model_ref` 指定名单中的模型。成功退出码为 0，最终失败为 1；JSON 输出包含最终 Task、Artifact ID、本次 Task ID 列表与重试次数。后续进程可用 `artifact inspect` 和 `artifact export` 导出同一作品，见 [Headless CLI](HEADLESS_CLI.md)。

## 超时、重试与失败恢复

| 参数 | 默认值 | 含义 |
|---|---:|---|
| `timeout_ms` | 300000 | 单次请求上限，范围 1–3600000 毫秒；不是音乐时长 |
| `retry_502` | 2 | HTTP 502 后额外生成次数，范围 0–5；0 关闭，默认最多提交3次 |
| `retry_delay_ms` | 5000 | 502 后等待时间，范围 0–60000 毫秒 |

仅收到 HTTP 502 时按本次参数重试，同一失败模型重新生成，不自动切换来源。每次重发创建关联的新 Task；上游可能已经生成音乐，因此重试可能消耗额外额度。超时、其他 HTTP 状态、文字响应和交付失败不触发这项重试。供应商配额以其实际政策为准。

完整音频已缓存但本地交付失败时，使用工作台“重新取回作品”或 `task redeliver` 恢复，不重新生成。手动 `task retry` 是一次新的知情生成，需要重新提供描述；不要在 Agent 外层再增加重试循环。

取消会停止本地等待和后续重试，无法据此确认上游生成已经撤销。逐模型 `models test --capability music-gen` 会跳过音乐测试；需要验证服务时，明确提交所需作品。

## 接口与产物

- 模型能力标签为 `music-gen`，Core Task 能力为 `music`，产物类型为 `generated-audio`。
- DSH 工具和工作台使用 `POST /iris/api/actions/music`；工具/Action 的模型字段是 `model`，CLI 使用 `model_ref`。
- 当前只交付 MP3/WAV，按响应媒体类型保存，不转换格式。音频作品可复用作品库筛选、播放和导出。

交付失败的详细恢复步骤见 [同步交付恢复](SYNC_DELIVERY_RECOVERY.md)。
