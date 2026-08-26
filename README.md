# dsh-iris

给 DeepSeek Harness 装上**眼睛和双手**：多供应商媒体生成（DashScope 百炼原生协议 + OpenAI Images 兼容）、视觉理解，以及规划中的 🫧 常驻工作台。

前身是独立运行的 [ai-paint](../ai-paint) 工作台（配置中心 + 生成工作台）；dsh-iris 是同一套能力向 DSH 的**宿内移植**——工具即接口（Agent 用），泡泡工作台是人机共用的门面。

## 定位：三件套

| | 能力 | 状态 |
|---|---|---|
| ✋ 双手 | 图像生成 / 视频生成 / 语音合成 | M1–M2 已交付 |
| 👁 眼睛 | 视觉路由：显式工具（look/relook），自持 qwen-vl 为主、全局模型降级为辅 | M3 已交付 |
| 🫧 门面 | 常驻泡泡工作台（前身 public/ 前端的化身） | M4 规划中 |

## 架构原则

1. **宿内共生，不开后台**：纯宿内插件，无任何独立进程/端口。盯守定时器全部 `unref` 且随插件 Fiber 清理——DSH 停它就停，DSH 重启后自动接管未完成的远程任务。
2. **自持供应商栈**：凭据存 `$DSH_HOME/iris/v1/providers.json`（0600，接口层永不回明文）。首次运行从 ai-paint 工作台幂等导入。聊天模型设置里本来就没有 wan*/qwen-tts 这类媒体模型的位置——这是自持的正当性。
3. **与 vision-mix 平行互补**：vision-mix 是「隐式模型路由」（借全局聊天模型让文本 Agent 会看）；iris 是「显式工具 + 自持媒体栈」（画/摄/说 + 主动看图）。理念吸收、代码零耦合、命名空间天然隔离。

## 工具

| 工具 | 说明 |
|---|---|
| `iris_draw_image` | 文生图：DashScope wan* 异步（提交→盯守→转存 attachment）或 OpenAI Images 兼容同步；附视觉自述 |
| `iris_generate_video` | 三种模式：文生视频 / 图生视频（首帧 = iris 图片 attachment id 或本地绝对路径）/ **s2v 数字人**（wan2.2-s2v：首帧+语音 <20s，本地图音自动上传百炼临时存储 oss://）；长渲染自动转后台，`iris_task_status` 查询 |
| `iris_speak_text` | qwen-tts 同步合成，wav 落盘 |
| `iris_task_status` | 查询任务状态/进度/错误/产物路径（单条或最近列表） |
| `iris_look_at_image` | 👁 看图问答：本地图片 → 存附件 → qwen-vl 流式回答（自持栈为主，全局视觉模型降级为辅） |
| `iris_relook_attachment` | 对本会话已出现过的图片（上传/工具产物/iris 生成）换问题重看像素 |

产物统一落在 `$DSH_HOME/iris/v1/outputs/`；图片额外转存为 DSH 持久 attachment 进入对话。

## 媒体通道（对话流内点播）

DSH 附件服务只收图片，视频/音频走宿内授权路由：

```
GET /iris/media/:taskId/:token/:name
```

- 生成完成即自动登记，工具结果与 `iris_task_status` 都会给出可点击的播放链接
- **安全边界**：token 为 crypto 随机 128bit 能力凭证（只存任务记录）；文件定位只信任务记录、URL 文件名段不参与路径解析（防穿越）；未命中一律 404；仅 GET/HEAD
- 反代/远程部署用 `DSH_WEB_BASE` 覆盖默认基址 `http://127.0.0.1:3080`
- 插件停用即撤路由；任务元数据裁剪（200 条）后旧链接自然失效

## 任务框架（继承 ai-paint，宿内化）

- 元数据：`$DSH_HOME/iris/v1/tasks.json`（只存元数据与 attachment 索引，最多 200 条）
- 服务端盯守：轮询容错（连续 5 次失败才判死）、单任务上限 20 分钟、间隔按能力区分（图像 2.5s / 视频 6s）
- 工具内等待有上限（图像 3 分钟 / 视频 8 分钟），超时自动转后台并告知 task id
- 取消信号传播：abort 即标记 canceled 并停盯
- DSH 重启恢复：百炼异步任务在服务端继续跑、结果 URL 存活 24h，启动时重新接管落袋

## 里程碑

- [x] **M1** 工具（画图/语音）+ 配置自持 + 工作台导入
- [x] **M2** 任务盯守框架（后台化/重启恢复/历史元数据）+ 视频生成
- [x] **M3** 眼睛：`iris_look_at_image` / `iris_relook_attachment`（visionStream 移植，qwen-vl 走自持栈；与 vision-mix 分工——它是隐式模型路由，我们是显式工具）
- [ ] **M4** 🫧 泡泡工作台（settings.section slot + 历史面板 + 进度显示）
- Backlog：CosyVoice WebSocket 流式 TTS、批量队列并发、视频多帧参考/音效（承自 ai-paint 三期 Roadmap）

## License

MIT
