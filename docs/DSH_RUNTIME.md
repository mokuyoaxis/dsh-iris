# DSH 实例运行时（0.2.7）

0.3 alpha源码另可显式连接 [Core 服务](CORE_SERVICE.md)，添加共享 Flow 工具并复用原生附件；本文继续说明 0.2.7 的嵌入式媒体装配。可选连接不把整个旧媒体栈迁成远程调用，不改变下述历史数据根。

面向 0.3 的内部装配已将 DSH 的 Core 写队列、Provider 连接解析引用和 Core 任务观察器归入插件实例。工具名、工作台路由、模型选择与计费规则保持；数据仍位于 `$DSH_HOME/iris/v1/core-v0`，不迁移既有 Task、Artifact、Run 或配置。

## 调用与归属

```text
apply(ctx) → createDshRuntime({ dataRoot, getHost })
                  ├─ 工具、Action、工作台显式接收同一实例
                  ├─ 有界 Core 任务观察器与启动接管
                  └─ Application Runtime → 操作级 Core → Command / Provider runner
```

[DSH Host Adapter](../lib/dsh-host-adapter.js)继续把公开宿主服务映射为附件、浏览器、文本/视觉模型、连接和路由端口；工具调用时重新获取可能晚到的可选服务。[DSH 实例](../lib/dsh-core-adapter.js)负责这些端口与 Core 的组合，直接在进程内调用；不经本地 HTTP API，也不靠模块级“当前实例”路由业务命令。`apply` 通过内部 `irisRuntime` 服务持有实例，注册的回调捕获各自所属实例。路由部分注册失败时立即回滚已注册项。

同一实例的 Core 写操作共用 [Application Runtime](CORE_RUNTIME_CONTRACT.md#应用运行时装配) 的 FIFO，每项独立取得和释放 writer。reader 独立运行，只读取已提交事实；多个读取不构成整个根的一致快照。不同根可并行，同一物理根的竞争写者返回 busy，空闲插件不一直占锁。

复合操作沿用既有 Command、Provider runner、Music 和维护逻辑，通过内部 `run(reader|writer, callback)` 在同一个操作范围执行；该入口不作为 package export、HTTP 转发或第三方 SDK。业务输入在进入队列前复制，Adapter、Browser 和连接解析函数则作为明确的运行端口保留，不尝试序列化。

## 观察、取消与卸载

Core 自动观察仍由 DSH 实例提供有界定时节拍，每次至多执行一次观察。配置连接在每拍重新解析，按原 Task 的供应商、模型与端点 binding 核对；密钥轮换可生效，端点或协议漂移会停止观察，不向新端点发送旧任务 ID，也不重新提交。

启动接管是实例持有的后台操作，慢连接解析不阻塞插件完成装载。卸载同步拒绝新操作，停止定时器、传播取消，等待接管、轮询、已装配的工具/动作、工作台管理和附件投影完成，并等待 Core 释放。重复 `dispose()` 返回同一个过程；忽略取消的外部端口仍须返回后才能完成卸载。旧实例不能在连接解析返回后重新注册观察器，也不能停止新实例的观察器。

排队取消不创建 Task；执行中取消保留已受理或未知的真实事实，不自动请求远端取消。附件展示失败或晚返回不会撤销已提交的 Core 成功结果。普通错误不阻塞后续队列；租约释放失败会停止实例，保留错误与现场，不报告关闭成功、不自动抢锁。

legacy watcher 与 SSE 仍共享原有模块资源；原生装配只用“最近注册实例”标记阻止旧实例迟到释放时停止新资源，不以此宣称完整多 profile 隔离。可选 Core 服务桥启动失败会撤销已注册工具并断开握手；桥按当前所选插件业务注册工具，音频能力仍明确不支持。

## 当前边界与验证入口

本轮实例化的是 DSH 的 Core 装配及上述操作。legacy `config.js`、`tasks.js`、`artifacts.js`、上传与 SSE 存储/资源仍保留原机制，不承诺同进程多个 profile 的完整隔离；其他 CLI 入口也未全部统一。固定 Flow 尚未接入 DSH 工作台；未发布的 Operation、执行/停止与真实独立 Web 见 [Core 工作台](LOCAL_WEB.md)。DSH 新增的 [ComfyUI 专区](IMAGE_GENERATION.md#dsh-工作台入口03-alpha)继续使用原 Task 装配，不要求迁移 Flow 根。公开 SDK、包名、认证与数据格式均未因此改变。

- `npm test`：保留既有媒体与工作台断言，增加实例队列、关闭/租约失败及观察器竞态测试。
- `node --expose-internals scripts/verify-dsh-host.mjs --dsh-root <绝对路径>`：隔离宿主服务验收包含异步卸载与重新装载；部分 SDK 需要额外指定 `--client-sdk-root`。
- `node scripts/verify-headless-package.mjs --offline`：使用已有缓存检查仓库外、无 DSH 的 CLI 安装闭包。

这些隔离检查不替代日常完整 DSH、真实付费 Provider、Android 浏览器交互或 Windows/macOS 验收。当前版本与后续范围见 [路线图](ROADMAP.md)。
