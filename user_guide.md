# dsh-iris 用户指南

本指南说明如何安装、配置和使用 dsh-iris。项目仍处于早期版本；升级前请先阅读 [CHANGELOG](CHANGELOG.md)。

## 安装

你需要一个可用的 DeepSeek Harness、PATH 中的 `pnpm`，以及至少一个媒体或视觉服务供应商。dsh-iris 自身要求 Node.js 20.9 或更高版本；如果所用 DSH 版本要求更高，以 DSH 为准。

从 npm 安装到 Web profile：

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris
dsh web
```

从源码目录试用：

```bash
dsh plugin --profile web add .
dsh web
```

浏览器默认打开 `http://127.0.0.1:3080`。插件安装后只会在下一次 DSH 启动时装载；如果 DSH 已经运行，请先停止再启动。

可以在启动前检查组合配置：

```bash
dsh --profile web --dump-config
```

输出中应出现 `dsh-iris` 配置层。DSH 的插件命令和 profile 机制见[官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)。

## 最快配置：DashScope

打开“设置 → Iris 工作台”，然后：

1. 点击“+ 添加供应商”。
2. 名称可填“阿里云百炼”。
3. Base URL 填 `https://dashscope.aliyuncs.com/compatible-mode/v1`。
4. 填入 DashScope API Key，点击“保存”。
5. 展开刚添加的供应商，点击“发现模型”。

如果只有一个供应商，可以先保留“能力分配”为自动。Iris 会从模型池中为画图、视频、语音、转写和视觉能力选择第一个匹配模型。需要固定模型或设置故障转移顺序时，再到“能力分配（failover 顺序）”中调整。

保存供应商和修改能力分配都会立即生效，不需要重启 DSH。

## 供应商与协议

Iris 当前支持两类调用路径：

| 路径 | 可用能力 | 说明 |
|---|---|---|
| DashScope 百炼 | 图片、视频、TTS、转写、视觉 | 默认媒体协议，覆盖最完整 |
| OpenAI 兼容 | Images 图片生成、Chat Completions 视觉 | 具体模型和能力取决于兼容服务 |

工作台新增供应商时，媒体协议默认是 `dashscope`。接入 OpenAI Images 兼容服务时，需要在高级配置中把该供应商的 `mediaProtocol` 设为 `openai-images`；否则图片生成会按 DashScope 协议提交。

同一个 OpenAI 兼容 Base URL 只有在实际提供相应接口时才能承担对应能力：图片生成需要 Images 接口，视觉理解需要支持图片输入的 Chat Completions 接口。通用 OpenAI 兼容端点目前不能替代 Iris 的 DashScope 视频、TTS 或转写协议。

## 模型池

“发现模型”会读取供应商的 `GET /models`，再按模型名识别媒体能力。发现失败时，原模型池不会被清空。

模型池中的能力名称如下：

| 能力 | 配置值 | 典型工具 |
|---|---|---|
| 图片生成 | `image-gen` | `iris_draw_image` |
| 视频生成 | `video-gen` | `iris_generate_video` |
| 语音合成 | `tts` | `iris_speak_text` |
| 音频转写 | `transcribe` | `iris_transcribe_audio` |
| 视觉理解 | `vision` | `iris_look_at_image`、OCR、定位、视频摘要 |

没有 `/models` 接口时，可以在供应商的模型池中手动添加模型名。Iris 能识别常见的 wan、qwen-vl、qwen-tts、qwen-audio ASR Filetrans、Fun-ASR、paraformer、gpt-image、dall-e 和 Gemini 命名；无法识别的模型需要在高级配置中显式填写 `capabilities`。

模型旁的“测”会发起真实供应商请求，不是本地校验：

- 视觉测试会发送一张最小测试图；
- 图片和 TTS 测试会生成真实产物；
- 视频测试只确认远端受理，不等待成片，但仍可能产生任务和费用；
- 转写不使用空样本测试，应通过“音频转写”操作用真实音频验证。

模型不必经过“测”才能使用。这个标记只记录人工触发的实测结果。

## 能力分配和故障转移

每项能力都可以设置一个有序的“供应商 + 模型”列表。界面显示的是模型名和供应商，配置中保存为 `providerId::modelId` 复合引用，因此不同供应商的同名模型不会冲突。

- 未手工分配时，按模型池顺序自动选择。
- 手工列表中的模型优先，并按列表顺序尝试。
- 模型池中其余具备该能力的模型仍会作为后续候选。
- 点击“恢复自动”会清除手工顺序。

生成类故障转移只覆盖上传、提交和同步生成阶段。远端一旦受理异步任务，Iris 就会继续跟踪这个任务，不会因轮询或下载失败自动重提，以免重复生成和计费。

## 高级配置文件

一般应使用 Iris 工作台。只有在配置工作台尚未覆盖的协议或模型能力时，才需要直接编辑：

```text
$DSH_HOME/iris/v1/providers.json
```

没有设置 `DSH_HOME` 时，默认位置是 `~/.dsh/iris/v1/providers.json`。

直接编辑前先停止 DSH；Iris 会缓存已经加载的配置，运行时改文件不会可靠地刷新内存状态。示例：

```json
{
  "version": 1,
  "providers": [
    {
      "id": "iris_primary",
      "name": "Primary media provider",
      "type": "openai",
      "baseUrl": "https://api.example.com/v1",
      "apiKey": "YOUR_API_KEY",
      "enabled": true,
      "mediaProtocol": "openai-images",
      "models": [
        { "id": "gpt-image-1", "capabilities": ["image-gen"] },
        { "id": "vision-model", "capabilities": ["vision"] }
      ]
    }
  ],
  "assignments": {
    "image-gen": ["iris_primary::gpt-image-1"],
    "vision": ["iris_primary::vision-model"]
  }
}
```

`assignments` 可以省略；省略后使用模型池顺序。包含特殊字符的 provider 或模型引用会经过 URL 编码，复杂引用建议在工作台中生成，不要手写。

API Key 以明文保存在宿主侧的 `providers.json` 中，文件权限为 0600。状态接口和界面只返回掩码，不会显示完整 Key。不要把这个文件提交到版本库或发给他人。

## 文件输入

Iris 工作台中的文件字段提供三种方式：

1. “上传文件”：推荐方式，适合浏览器和 DSH 不在同一文件系统的情况。
2. “会话附件”：复用当前会话或 Iris 已生成的图片。
3. “高级·宿主路径”：填写 DSH 进程能够读取的绝对路径。

浏览器上传单文件上限为 64 MB，默认保留 7 天。视频和音频操作最终都需要一个宿主可读路径；浏览器自己的路径、`content://` URI 和远程电脑上的路径不能直接使用。跨系统细节见[文件访问与跨环境](docs/file-access-across-environments.md)。

## 最小指令

配置完成后，可以直接在会话中说：

```text
使用 iris_draw_image：画一只坐在蓝色窗边的白猫。
```

```text
总结我刚上传的这张图片。
```

```text
用 Iris 总结 /absolute/path/demo.mp4，再把摘要合成为语音。
```

直接写工具名最明确；自然语言也可以，由 Agent 判断需要调用哪个 Iris 工具。视频、图片和语音生成可能产生供应商费用。

仓库还附带 `iris-verify-ui` 和 `iris-compose-media` 两个项目级 Skill。它们目前只会在会话工作区能够发现本仓库 `.dsh/skills/` 时加载，安装 npm 插件不会把它们自动注册到其他项目。

## 任务和产物

Iris 会在会话输入区显示运行中任务，并在 Iris 工作台保留最近任务。长时间生成转入后台后，可以让 Agent 调用 `iris_task_status`，或在工作台中打开任务详情。

默认数据目录：

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/iris/v1/outputs/` | 图片、音频和视频产物 |
| `$DSH_HOME/iris/v1/uploads/` | 浏览器上传的临时输入 |
| `$DSH_HOME/iris/v1/tasks.json` | 任务状态与附件索引 |
| `$DSH_HOME/iris/v1/providers.json` | 供应商、模型池和能力分配 |

音视频播放链接带随机令牌。反向代理或自定义 Web 地址下，可设置 `DSH_WEB_BASE`，例如 `https://dsh.example.com`，让 Iris 返回正确的媒体链接。

## 可选依赖

视频抽帧和视频摘要依赖 PATH 中的 `ffmpeg` 与 `ffprobe`。缺少它们只会禁用这两项能力，不影响生成、看图、OCR 或语音工具。

HTML 截图依赖 DSH 提供 `dsh-builtin-browser`。截图页在离线沙箱中运行，不加载远程脚本、字体或图片；需要的资源应内联到 HTML。

## 更新和卸载

更新 npm 版本：

```bash
dsh plugin --profile web update @mokuyoaxis/dsh-iris
```

更新后重启 DSH。卸载插件：

```bash
dsh plugin --profile web remove @mokuyoaxis/dsh-iris
```

卸载不会自动删除 `$DSH_HOME/iris/v1/` 中的配置和产物。

## 常见问题

- **设置中没有 Iris 工作台**：确认插件已加入 Web profile，并在安装后重启 DSH；可用 `dsh plugin --profile web list` 和 `--dump-config` 检查。
- **没有可用模型**：先确认供应商已启用且 Key 有效，再运行“发现模型”；不支持 `/models` 时手动添加。
- **OpenAI 兼容图片请求走错协议**：确认该供应商的 `mediaProtocol` 是 `openai-images`。
- **看图可用但 Iris 模型池显示为空**：Agent 视觉工具可以回退到 DSH 全局视觉模型；需要在工作台操作时仍建议配置 Iris 的 `vision` 模型。
- **视频摘要提示 ffmpeg 不可用**：安装系统级 `ffmpeg` 和 `ffprobe`，并确保 DSH 进程的 PATH 能找到它们。
- **本地文件不存在**：这里的“本地”指 DSH 宿主，不一定是浏览器所在设备；优先用“上传文件”。
- **视频任务长时间运行**：不要重复提交。用 `iris_task_status` 或工作台任务详情查询原任务。
