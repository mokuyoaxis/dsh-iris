<p align="center">
  <img src="docs/assets/iris-wordmark.svg" width="520" alt="IRIS 彩色字标">
</p>

<h1 align="center">dsh-iris</h1>

<p align="center"><strong>DeepSeek Harness 的多供应商媒体与视觉工具箱</strong></p>

<p align="center">
  <a href="#deepseek-harness-适配"><img alt="DeepSeek Harness compatible" src="https://img.shields.io/badge/DeepSeek%20Harness-compatible-4D6BFE.svg?style=flat-square"></a>
  <a href="CHANGELOG.md"><img alt="Version 0.1.0" src="https://img.shields.io/badge/version-0.1.0-7C5CFC.svg?style=flat-square"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 20.9 or newer" src="https://img.shields.io/badge/Node.js-%3E%3D20.9-339933.svg?style=flat-square&amp;logo=nodedotjs&amp;logoColor=white"></a>
  <a href="#开发与验证"><img alt="npm test" src="https://img.shields.io/badge/tests-npm%20test-2EA44F.svg?style=flat-square"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-1689FF.svg?style=flat-square"></a>
</p>

dsh-iris 为 Agent 和 Iris 工作台提供图像、视频、语音与视觉理解能力。它可以连接 DashScope 百炼及 OpenAI Images 兼容服务；完整配置和任务管理集中在 Iris 工作台，右下角的 Iris 泡泡提供快捷入口。

项目目前处于早期版本，接口和配置格式仍可能随版本迭代调整。

## 最快开始

已经安装 DeepSeek Harness 且 `pnpm` 在 PATH 中时，把 Iris 加入 Web profile：

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris
dsh web
```

从当前源码目录试用时，把第一条命令中的 `@mokuyoaxis/dsh-iris` 换成 `.`。插件会在下一次 DSH 启动时装载，Web UI 默认位于 `http://127.0.0.1:3080`。

首次启动后，打开“设置 → Iris 工作台 → + 添加供应商”，填入 DashScope Base URL 和 API Key，再点“发现模型”。单供应商可以先使用自动能力分配。完整步骤、OpenAI Images 兼容配置和故障转移说明见[用户指南](user_guide.md)。

配置完成后，最小指令可以是：

```text
使用 iris_draw_image：画一只坐在蓝色窗边的白猫。
总结我刚上传的这张图片。
用 Iris 总结 /absolute/path/demo.mp4，再把摘要合成为语音。
```

DSH 的 profile 与插件命令由[官方安装说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)定义。生成图片、视频或语音可能产生供应商费用。

## 功能概览

- 图像生成、文生视频、图生视频和 S2V 数字人视频
- 文本转语音与音频转写
- 看图问答、长图 OCR、目标定位、裁剪和像素差异分析
- 视频抽帧与多模态内容摘要
- 异步任务跟踪、重启恢复和带授权令牌的媒体播放
- 多供应商模型池，以及按 `供应商 + 模型` 分配能力
- 浏览器上传、会话附件和宿主路径三种文件来源

## 使用前准备

- 满足所用 DeepSeek Harness 版本要求的 Node.js；dsh-iris 自身最低为 20.9
- 一个可用的 DeepSeek Harness 环境，以及 PATH 中的 `pnpm`
- 至少一个受支持的媒体或视觉服务供应商
- 使用视频抽帧和视频摘要时，需要系统提供 `ffmpeg` 与 `ffprobe`

安装插件后，在 Iris 工作台中添加供应商并为所需能力分配模型。供应商密钥只保存在宿主侧，界面和接口不会返回完整密钥。

## DeepSeek Harness 适配

dsh-iris 按 DeepSeek Harness 插件形态提供服务端与 Web 客户端入口：服务端注册 14 个 Agent 工具，并复用宿主的工具、路由和生命周期服务；客户端通过 DSH 模块加载器接入设置页、会话输入区和全局悬浮层。插件不会启动独立服务或额外监听端口。

当前自动化测试覆盖插件装载、工具注册、客户端槽位和路由行为。由于项目尚未声明 DSH 的最低或最高版本，兼容徽章表示项目已按当前 DSH 插件接口实现，并不代表官方认证或对所有历史版本的承诺。

## 工具

### 生成、语音与任务

| 工具 | 用途 |
|---|---|
| `iris_draw_image` | 根据提示词生成图片 |
| `iris_generate_video` | 生成文生视频、图生视频或 S2V 数字人视频 |
| `iris_speak_text` | 将文本合成为语音 |
| `iris_transcribe_audio` | 将音频转写为文本 |
| `iris_task_status` | 查询单个任务或最近任务的状态和产物 |

### 视觉与图像处理

| 工具 | 用途 |
|---|---|
| `iris_look_at_image` | 对图片提问并获得视觉模型回答 |
| `iris_relook_attachment` | 使用新问题重新查看会话中的图片附件 |
| `iris_long_ocr` | 分块识别长截图或长图文字 |
| `iris_locate` | 定位图片中的目标并返回像素坐标 |
| `iris_crop` | 按像素区域裁剪图片 |
| `iris_pixel_diff` | 比较两张图片并生成差异统计和热力图 |
| `iris_html_screenshot` | 在受限环境中将 HTML 字符串渲染为截图 |

### 视频处理

| 工具 | 用途 |
|---|---|
| `iris_video_frames` | 从视频中均匀抽取画面帧 |
| `iris_media_summarize` | 结合画面帧和可选音频转写生成视频摘要 |

## 文件输入

Iris 支持三种文件来源，推荐顺序如下：

1. **浏览器上传**：适合本地文件和跨环境访问，单文件上限为 64 MB。
2. **会话附件**：适合复用当前会话中已经上传或生成的媒体。
3. **宿主路径**：适合宿主可以直接读取的大文件。这里填写的是宿主进程看到的路径，不一定等同于浏览器所在系统的路径。

上传内容保存在 `$DSH_HOME/iris/v1/uploads/`，默认保留 7 天。不同系统下的路径选择建议见[文件访问与跨环境](docs/file-access-across-environments.md)。

## 模型分配与故障转移

能力分配使用 `providerId::modelId` 作为模型身份。同名模型如果来自不同供应商或不同账号，会被视为两个独立选项。

生成类能力可以配置多个候选模型。Iris 只会在上传、提交或同步生成阶段失败时尝试下一个候选项；远端服务一旦受理任务，就不会自动重新提交，以免产生重复任务或重复计费。已经受理的异步任务由任务系统继续跟踪。

转写是独立的 `transcribe` 能力，不会占用 TTS 或视觉能力的模型配置。

## 数据与任务

运行数据默认位于 `$DSH_HOME/iris/v1/`：

| 位置 | 内容 |
|---|---|
| `providers.json` | 供应商和能力分配，文件权限为 0600 |
| `tasks.json` | 任务元数据和附件索引，最多保留 500 条 |
| `outputs/` | 生成和处理后的媒体文件 |
| `uploads/` | 浏览器上传的临时输入副本 |

异步任务会在后台轮询。插件重启后，可以继续接管仍在远端执行的任务。取消信号会传递到本地等待与轮询流程；是否能取消远端计算，取决于供应商接口。

音频和视频通过带随机令牌的 Iris 媒体链接访问。图片会尽量转存为 DSH 持久附件，方便在会话中继续使用。

## 安全说明

- 供应商密钥不会通过状态接口返回。
- 修改状态的 HTTP 请求会检查跨站来源，降低第三方页面触发付费操作的风险。
- HTML 截图在不具备同源权限的沙箱页面中渲染，脚本和外部网络默认不可用。
- 媒体链接使用随机能力令牌，文件路径只从任务记录解析。
- Iris 不提供独立账号体系，多用户隔离和访问控制由 DeepSeek Harness 部署负责。

## 已知限制

- `sharp` 包含原生组件；主要支持 glibc Linux、Windows 和 macOS。裸 Termux 等非标准运行环境可能需要额外处理。
- 视频抽帧和视频摘要依赖系统安装的 `ffmpeg` 与 `ffprobe`。
- HTML 截图不加载远程脚本、字体或图片；需要的资源应先内联。
- WSL、容器和远程部署中，浏览器路径通常不能直接交给宿主读取，请优先上传文件。
- 供应商返回的模型清单只是候选集合，模型是否真正支持某项能力仍以实际调用为准。

## Agent Skills

源码和 npm 包附带两个仓库级预览 Skill：

| Skill | 适用场景 |
|---|---|
| [`iris-verify-ui`](.dsh/skills/iris-verify-ui/SKILL.md) | 组合截图、语义检查、元素定位、裁剪和像素比较，完成有证据的 UI 验收 |
| [`iris-compose-media`](.dsh/skills/iris-compose-media/SKILL.md) | 组合两个以上 Iris 工具，完成看图后绘图、图片转视频、视频总结配旁白或 S2V 等媒体工作流 |

当 DSH 会话以本仓库为项目目录且启用了文件系统 Skill 服务时，可以直接发现它们。当前版本尚未在插件启用时自动向其他项目注册这些 Skill；14 个 Iris 工具不受影响。

## 开发与验证

在项目目录运行：

    npm test

测试覆盖配置合并、模型身份、任务生命周期、生成动作、HTTP/SSE 路由、客户端交互和安全边界。项目采用 ES Modules，不需要构建步骤。

## 文档

- [用户指南](user_guide.md)
- [变更记录](CHANGELOG.md)
- [路线图](docs/ROADMAP.md)
- [文件访问与跨环境](docs/file-access-across-environments.md)

## License

[MIT](LICENSE)
