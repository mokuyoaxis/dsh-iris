# Host Adapter v0 契约

状态：**v0.1.4 内部契约与渐进迁移已完成，并通过真实 DSH 隔离 canary。** 本文固定真实消费者所需的最小边界；不宣称已经提供独立 Core、公开 Host SDK 或完整 Local Host。

## 目标

Host Adapter 只负责把一个宿主的工具、路由、客户端、附件、会话、浏览器和模型能力映射为 Iris 端口。Command 接收 Iris 输入、`AbortSignal` 和所声明的 Host Port，**不得接收原始 `ctx`**。Task、Provider、文件持久化和成本语义不属于宿主。

契约版本固定为 `0`。它在 0.1.x 内仍是内部接口；只有经过 DSH 与 Local Host 两个真实消费者验证后，才考虑成为公开 SDK。

## 端口清单

| Host Port | 当前 DSH 来源 | 最小职责 | 缺失时 |
|---|---|---|---|
| `tools` | `ctx.tools` / `ctx.effect` | 注册 Agent 工具并随插件生命周期释放 | Agent 工具不可用；核心动作不应因此失效 |
| `routes` | `webServer` / `httpServer` | 挂载 API、媒体与渲染路由并可逆卸载 | 工作台 HTTP 与媒体链接不可用 |
| `clientSlots` | Web Client `ctx.slots` | 注册设置、输入区、dock 与 overlay 座位 | 服务端任务和 CLI 不受影响 |
| `skills` | `ctx.skills` | 注册随包 Skill，声明用户/模型调用策略 | 工具仍可直接调用；Doctor 给出降级原因 |
| `attachments` | `ctx.get('attachments')` | 保存/读取图片字节，返回 Iris 自有引用 DTO | DSH 图片投影或会话图片读取不可用 |
| `sessions` | `ctx.get('sessionQuery')` / Client sessions | 列出当前会话的受支持附件和最小模型选择信息 | 只使用 Iris 自有产物或显式上传 |
| `browser` | `ctx.get('browser')` | 将受限 HTML 渲染为图片；不向 Command 暴露 DSH page/session 对象 | HTML 截图不可用 |
| `textModel` | DSH LLM/default-model 服务 | 执行无工具的文本生成并解析当前/默认模型 | 对话框提示词优化不可用 |
| `visionModel` | DSH 全局视觉模型 | 作为 Iris 自持视觉 Provider 之外的可选后端 | 有自持视觉配置时降级；否则视觉动作失败 |

`ports` 只包含真实可调用的方法对象。缺失或版本不兼容的能力进入 `unavailable`，并提供 `kind` 与人类可读 `reason`；Doctor 与运行错误必须消费同一份事实。

## Command × Host Port 矩阵

| Command/入口 | 必需端口 | 可选端口 | 说明 |
|---|---|---|---|
| `image` | 无 | `visionModel` | 生成与 Task 不依赖宿主；成功后的简短视觉描述可以降级 |
| `video`、`tts`、`transcribe` | 无 | 无 | Provider、Task 与产物落盘属于 Iris Core 候选 |
| `look`、`locate`、`ocr` | 无 | `visionModel` | 优先使用 Iris Provider；没有任何视觉后端才失败 |
| `crop`、`diff`、`video_frames` | 无 | 无 | 确定性本地动作 |
| `media_summarize` | 无 | `visionModel` | 帧提取是本地动作，理解阶段允许宿主视觉降级 |
| `html` | `browser` | 无 | Command 只调用语义级 `renderHtml` |
| `relook` | 条件必需 `attachments` + `sessions` | 无 | Iris 自有附件可直接解析；会话附件必须走宿主端口 |
| `attachments_list`、`attachment_export` | 条件必需 `attachments` + `sessions` | 无 | Iris 自有产物不依赖宿主；会话来源不得读取宿主私有文件 |
| Task 查询、观察、交付、提醒和知情重试 | 无 | 无 | 事实、费用确认和新旧 Task 关系归 Iris 所有 |
| Provider/模型/能力配置 | 无 | `visionModel` | 普通发现与配置不依赖宿主；视觉实测可选宿主后端且必须显式触发 |
| Prompt Optimize | `textModel` | `sessions` | 客户端可显式传模型；否则从宿主获取当前/默认选择 |
| DSH 工具结果投影 | `tools` | `attachments` | 注册与结果转为 DSH attachment 属于 DSH Adapter，不进入 Command |
| Workbench/API/媒体路由 | `routes` | `clientSlots` | HTTP/UI 只是投影，不是真相来源 |
| 随包 Skill | `skills` | 无 | Skill 不得绕过 Command、Task 或费用边界 |

## 不可违反规则

1. Core 候选、Command、Task 和 Provider 模块不得导入 DSH/Cordis 运行时，也不得通过任意字段重新取得原始 `ctx`。
2. Host Adapter 只能映射宿主能力；不得复制业务校验、Provider 路由、Task 状态机、failover 或产物持久化。
3. 宿主会话 ID 只能作为来源上下文，不能成为 Iris Task、Attempt 或未来 Artifact 的主键。
4. Command 输入和结果只能包含 JSON、字节、稳定引用与受控错误；不得持久化 page、session、service 等 live Host 对象。
5. 能力探测必须显式、可序列化且零计费。缺能力返回稳定分类和可执行说明，不得用异常吞噬后继续猜测私有 API。
6. 调用方的 `AbortSignal` 必须传播到 Host 操作；断开、取消和超时不得被 Adapter 转换为自动重试。
7. 工具、路由、Skill 与 UI 注册必须可逆，并随对应宿主生命周期释放。
8. 可选端口只能执行文档规定的降级；必需端口缺失必须立即失败，不得伪造成功结果。
9. Host capability check、Doctor 和 Local Host fixture **不得自动产生新的远端媒体提交**，也不得把读取供应商密钥作为诊断输出。
10. DSH 版本差异只能存在于 DSH Adapter/capability detection 和兼容 fixture；不得扩散到 Task、Provider 或通用 Command。

## 错误与能力快照

`lib/host-contract.js` 提供：

- `defineHostAdapter()`：验证并冻结适配器描述，拒绝未知端口和原始 `ctx` 字段；
- `requireHostPort()`：缺失时抛出 `HostCapabilityError`；
- `IRIS_HOST_CAPABILITY_UNAVAILABLE`：宿主未提供能力；
- `IRIS_HOST_CAPABILITY_INCOMPATIBLE`：宿主存在相关服务但版本/形状不兼容；
- `hostCapabilitySnapshot()`：只输出宿主身份、版本和每项能力状态，不输出 live object。

`lib/host-runtime.js` 另记 Iris 自身成功完成的工具、Skill 和路由注册，以及客户端版本/Slot 握手；它不保存 `ctx`、service、会话、附件或密钥。

## DSH 装载与版本变化

Iris 继续作为普通 DSH/Cordis 插件装载：`cordis.patch.yml` 只把 npm 包入口 `lib/index.js` 挂入宿主。该入口可以依赖 Core，但 Core Runtime 必须能在 DSH/Cordis 完全不可解析时独立装载。拆 Core 不会要求用户在 DSH 外另起守护进程，也不会取消工作台、Agent 工具或 🫧 入口。

兼容规则：

1. DSH 原始 `ctx` 只允许存在于 `lib/index.js`、`lib/dsh-host-adapter.js` 和客户端 Slot 边界；任务、Provider、Artifact 与 Command 不感知其形状。
2. 工具、Skill、路由、附件、Browser、模型和客户端 Slot 分别探测、分别注册、分别诊断。单个端口失败只能降级对应体验，不能改变 Core Task/Artifact 事实。
3. 不把所有功能押在单个便利 RPC 或私有服务上。当前 Iris Web 数据通路使用宿主公开的 prefix route + 普通 `fetch`，不调用 `connection.rpc.handle()`；这只是当前适配实现，不是永久绑定承诺。
4. DSH Doctor 必须区分 loader、服务端端口、路由、工具/Skill 账本、客户端 bundle 与 Slot 握手；“Core 可运行但 DSH 投影失败”必须成为可识别结果。
5. 兼容范围只按真实版本/commit canary 声明，不使用宽泛 semver 猜测未来预览版。上游破坏时先修改 DSH Adapter 与 fixture，不迁移或重写 Core 数据。
6. 若 DSH 原生吸收某项同类功能，不自动删除 Iris 能力。只有公开契约在语义、安全和生命周期上等价并有版本化测试时，Adapter 才可选择委托；否则继续使用 Iris Core 实现。

## 当前覆盖

- `lib/index.js` 负责 DSH 插件入口、生命周期和工具注册；
- `lib/dsh-host-adapter.js` 映射九类命名端口；
- Local Host fixture 覆盖 crop/diff、Task 查询与提醒操作，并验证缺失能力的错误；
- Host Doctor 对服务端注册账本、客户端版本和 Slot 握手分别给出结果；
- DSH `0.1.2-rc.1` 与 `0.1.5-rc.1` 已有宿主验证记录。

Local Host 不模拟 Browser、会话或附件。测试需要这些能力时必须显式注入，缺失行为也属于契约。

## 范围

- Host Adapter v0 仍是内部接口，不是第三方 SDK；
- DSH 插件不启动 standalone 服务，也不复制聊天界面；
- Artifact Manifest、Recipe/Flow 和新 Provider 不属于本契约。
