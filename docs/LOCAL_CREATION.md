# 本地上传与流程创建（0.2.7 / I4B）

未发布源码另支持 [Operation 执行根](LOCAL_OPERATIONS.md)与 [Core 有限执行服务](CORE_SERVICE.md)，需在新空 Flow 根显式 `execution init`，执行另主动开启；上传/创建仍不生成。下文说明已发布 0.2.7 的 v0 初始化流程，各种根不自动转换。

新的 `execution init --image-generation` 使用 v2 容器；owner 可通过 POST `/api/v0/generations` 保存 `{modelRef,prompt,size?,workflowParameters?}`，使用独立的 `generation-create` 原 Key 查询与重放，不接受来源图片。`workflowParameters` 仅用于明确开放槽位的 ComfyUI 模板，并纳入原 Key 和 Run 输入摘要；旧 `/runs` 不接受该字段。旧 `/runs` 创建仍必须提供来源，不能借旧编辑工具调用新能力。见 [独立文生图](IMAGE_GENERATION.md)。

0.2.7 在 [只读本地 API](LOCAL_API.md)之上，增加显式启用的图片上传和固定 Run 创建。两者都只提交本地数据，不生成、不观察任务、不调用 Provider。实际生成仍使用 [Flow CLI](IMAGE_FLOW.md)；执行/取消 API 与真实 Web 接入留到后续。本功能从 npm 0.2.7 起随包分发。

## 初始化与启用

为这一功能选择新的专用根，先初始化 Flow，再初始化请求区：

```bash
dsh-iris flow init --data-root /absolute/path/new-flow-core
dsh-iris api init --data-root /absolute/path/new-flow-core
dsh-iris api serve --data-root /absolute/path/new-flow-core --token-file /absolute/private/session-001.token --provider-config /absolute/private/providers.json --allow-local-writes
```

`api init` 只接受空的已初始化 Flow 根，不转换已有创作数据。重复初始化返回原 rootId；半初始化、未知版本或损坏请求区报错并保留现场。省略 `--allow-local-writes` 时仍只读；没有 Provider 配置也可上传或读取已有结果，创建新 Run 需要显式的可改图模型配置。

服务仍固定监听 `127.0.0.1`，默认随机端口；Token 文件与身份、Host/Origin、停止方法沿用 [只读入口](LOCAL_API.md)。Token 和请求 Key 是两件事：每次启动换 Token，同一次创建在网络不确定时保留原 Key。不要通过 URL、命令行参数或共享日志传 Token。

## 两个本地写接口

每次明确的新动作产生一个不带引号的小写 UUIDv4 `Idempotency-Key`，发送单个请求头。该 Key 不代替 Bearer 鉴权。

| 路径 | 输入 | 返回 |
|---|---|---|
| `POST /api/v0/images` | 原始静态 PNG/JPEG/WebP 字节，匹配的 Content-Type，最多 20 MiB | `{contractVersion:0,idempotentReplay,artifact:{artifactId,mediaType,size,width,height}}` |
| `POST /api/v0/runs` | UTF-8 JSON `{sourceArtifactId,modelRef,prompt,size?}`，最多 64 KiB | `{contractVersion:0,idempotentReplay,flow:<FlowView>}` |

首次创建在本地提交完成后返回 201；同 Key、同规范化输入接回原身份，返回 200 和 `idempotentReplay: true`。同 Key 不同输入返回 409；新的 Key 表示另一明确创建，不做全局按内容去重。Run 固定 `image-edit/v0`、单一明确模型和 `n=1`，创建不建立实际 Task。模型配置只读解析，不刷新目录或实测能力。

上传不接受路径、URL、文件名、SVG、动画或压缩正文；真实格式必须匹配 Content-Type。累计读取限额不只依赖 Content-Length，同时最多一个上传、最多九个本地创建请求；繁忙返回 429，同物理根有其他 writer 时返回 409，显式重试保留原 Key。

超限返回 `413 IRIS_API_INPUT_TOO_LARGE`，不创建作品或消费 Key。对尚未结束的上传，先发送完整错误响应，再丢弃剩余正文并关闭连接；不继续缓存正文，连接仍受现有请求/空闲超时和服务停止约束。客户端收到拒绝后应停止上传。

已发布 0.2.7 与仅开启 `--allow-local-writes` 时没有 continue、selection、Operation 查询或取消接口。GET、HEAD、页面刷新和启动不自动执行或补完创建；现有 Demo 仍使用演示传输，尚未连接这个 API。

## 重试、删除与中断

未发布源码增加 owner-only 的原 Key 只读查询和 session 稳定 rootId，v0/v1 请求区均可读取；prepared 不自动补完，默认只读服务也不创建请求区。浏览器刷新先重新认证、GET 核对，详见 [工作台请求恢复](WEB_RECOVERY.md)。此查询不在已发布 npm 0.2.7 中。

请求意图、预留身份、业务提交和完成状态共用同一次 Core writer。跨进程重启、端口变化或 Token 轮换后，同 Key 仍绑定原数据根和原输入；已有 Run 后续执行或选择过，重放返回其当前 FlowView，不回退进度。已有意图不因当前 Provider 配置变化另选模型/端点，未来执行仍遵守原 Flow binding。

意图发布前的输入错误、busy、排队取消或断线不消费 Key；发布后断线不撤销本地提交。未完成上传需要重新提供相同字节；显式同 Key POST 才核对或补完，没有自动后台重放。关闭服务会停止接收和等待，并保留未完成证据。

未完成请求引用的来源与预留对象受删除/清理保护。成功上传如果没有其他 Run/Task 引用，仍可通过现有明确动作隔离或删除；之后同 Key 返回 `409 IRIS_API_RESULT_UNAVAILABLE`，不复活作品或新建替代身份。请求记录首版不自动过期、删除或 GC。

## 数据与版本边界

新私有请求区为 `creation-requests/v0`；现有 Run、Task、Artifact 格式保持，未迁移 DSH 日常数据。未知/损坏请求区使新版 writer 和维护操作报错，reader 仍可只读查看已有有效 Flow/图片。

此专用根只支持认识请求格式且通过验收的 writer。旧 binary 没有新检查，不能靠一个新目录保证它拒写；不要用旧版本对该根执行写入。需要回退时使用改动前完整副本，不删除请求区伪装降级。半初始化现场不自动修复，优先另建新空根。

验证范围为进程异常退出与 SIGKILL 下的身份接回；现有文件原语没有显式 fsync，不承诺断电、操作系统崩溃或 Android 共享存储上的跨文件事务。Windows/macOS 与真机使用范围须独立验证。
