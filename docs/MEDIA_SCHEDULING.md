# 有界媒体调度（0.3.0-beta.1）

本页功能从 `0.3.0-beta.1` 提供，旧alpha.1不包含。默认仍使用串行写入队列；在 `api serve` 或 `web serve` 的现有启动命令增加 `--scheduler-config /absolute/private/scheduling.json`，才启用本片调度。它不启动第二个写者，不扫描配置，不迁移已有数据，不修改全局代理或系统路由。

## 启动策略

新建仅当前用户可读写的普通 JSON 文件（POSIX 建议 `0600`），例如：

```json
{
  "schemaVersion": 1,
  "httpConcurrency": 4,
  "requestsPerSecond": 2,
  "remoteLimit": 8,
  "queueLimit": 32,
  "queueTimeoutMs": 30000,
  "providers": [
    {
      "providerId": "my-provider",
      "httpConcurrency": 2,
      "remoteLimit": 4,
      "models": [
        { "modelId": "my-image-model", "requestsPerSecond": 1, "remoteLimit": 2 }
      ]
    }
  ]
}
```

全局字段除了 `schemaVersion` 均可省略，默认值如上；供应商、模型层只限制填写的项目，与上层同时生效。名称必须与当前 Provider ID、原始模型 ID 准确匹配，不按显示名或客户端品牌匹配。没有填写供应商条目时，全局限制仍生效。配置在启动时读取一次，当前没有编辑 UI 或热更新。

`httpConcurrency` 为 1–4；`requestsPerSecond`、`remoteLimit` 为 1–1000；`queueLimit` 为 8–128；`queueTimeoutMs` 为 1–300000 毫秒。全局 HTTP 并发首片最多 4，这不是厂商容量声明。未知字段、其他版本、重复身份、缺失文件或过宽文件权限会明确拒绝，不静默退回无调度模式。

## 三种限制的区别

| 限制 | 统计边界 | 释放条件 |
| --- | --- | --- |
| HTTP 在途 | Core 实际交给传输 dispatcher 的请求，包含提交、查询、上传、下载和重定向的每一跳 | 正文传输结束、取消或传输失败；收到响应头尚不释放 |
| RPS | 实际调用 dispatcher 的滚动一秒窗口，全局与准确供应商/模型同时检查 | 时间窗口经过；不预订未来时间后同时突发派发 |
| 远端未结束数 | 同根 Task 已受理、受理未知或已有未收敛提交意图，且未确认成功/失败/取消 | 原 Task 确认远端终结；本地停止、关闭页面或 Operation 结束不释放 |

RPS 是应用派发口的限制，不证明网络或上游服务收到报文的精确时刻。出口连接预检、TCP/CONNECT 连接和其他进程的流量不计入业务 HTTP 次数。已有路线记录证明 Core 在请求前保存了选择，可能在排队或取消前已经写入，因此不能把 Task 的路线 `requestCount` 当成调度器的实际派发计数。

远端额度只拦截新的提交；原任务查询、取消和下载仍可执行。调度前从严格校验的现有 Task 事实计算额度，重启不会忘记未知任务。历史读取目前仍有线性成本，没有宣称支持无限历史规模。

beta.1中，损坏Task导致远端数量无法确定时，owner session仍可读取，调度摘要返回`remoteOutstanding:null`及`remoteError`错误码，不把未知数量显示为0。新提交继续严格检查原记录，不通过跳过坏Task放宽名额；相关等待者收到同一可定位错误，纯观测失败不升级为无关写者释放失败。修复原记录后可重新读取，不自动删除、隔离或改写Task。

## 排队、取消与恢复

Core 在网络等待期间让出短写入执行权，恢复后串行保存结果。每项工作有独立取消信号，同 Task 生命周期、同 Run 和创建 Key 保持互斥。未知插件业务写回调继续独占，不因增加媒体并发就自动获得并行执行保证。

已知模型短时冷却时，新生成在创建提交意图前等候；额度/预算耗尽仍需明确实测解除。HTTP `429` 的 `Retry-After` 约束后续请求，不自动重试失败的 POST。未派发的 HTTP 取消/排队超时保持明确未受理；一旦派发后结果不明，仍按原受理未知边界处理，不切换出口或模型重放。

等待有明确期限和有界内存队列；队列满或等待超时返回可定位错误。Flow 已固定的 Task 身份可能已有零 Attempt 的占位，但不会为了等名额创建大量失败提交。当前最多保留 8 个未结束的持久 Operation；启用调度时最多 7 个新提交，保留一个位置供已有任务的继续、查询和交付。停止本地 Operation 不需要另占此位置。

未开始的 HTTP/写入队列直接返回 `IRIS_SCHEDULER_QUEUE_FULL` 或 `IRIS_SCHEDULER_QUEUE_TIMEOUT`。已接收的 Operation 保留既有 `execution_failed` 持久类别，具体调度错误码在 Core 进程日志中关联原 Operation ID；没有为此迁移 Operation 格式。临时等待阶段不会跨重启保留。

本地写入 admission 失败只结束对应 Operation，不中止其他媒体或关闭执行服务；尚未开始时的失败记录没有 `startedAt`，也不会创建生成 Attempt。已接收 Operation 的短终态写入在原写者下排空，不受新工作队列满员/等候期限拒绝；同一 Operation 的并发停止共享该写入。真实持久化、清理或所有权故障仍停止执行并保留租约，不能因等候超时强制释放仍有活动工作的根。

Operation字段与schema版本未改变，当前源码补全了无`startedAt`的`execution_failed`终态组合。旧候选的严格校验会拒读这一组合，回退须使用匹配版本及完整备份；回退至旧alpha.1前须核对读取能力。旧记录没有自动重写。

派发时若发现另一写者占用，原 Operation 可继续保留 queued，等待用原 Key 显式接回或停止，不自动抢锁/轮询。内部 `idle()` 的一次 drain 返回不保证所有 queued 记录已终结；调用方应查看原 Operation 状态。

服务启动将遗留 `queued/running` 标为 `interrupted`，不自动恢复发送。响应丢失先按原 Key 查询；需要继续时用新 Key 与当前 Run revision，保留原 Task/Attempt/连接及插件依赖。未知受理不能通过重启或换调度配置重新生成。强杀后的租约仍需按[执行服务说明](CORE_SERVICE.md)确认实际 stale PID 后恢复。

工作台显示“等待远端任务名额”“等待模型冷却”“等待发送窗口”或“等待网络名额”。授权后的原 Operation 查询附带临时 `scheduling.phase`；该字段不写入持久记录。owner 的 `/api/v0/session` 另有本实例 HTTP/队列/远端数摘要；普通 MCP 不获得策略文件或管理权限。

## 范围与验证

该策略用于 Core 服务所装配的媒体能力、共用网络客户端的目录与供应商检测。通过同一服务接入的 Web、MCP、DSH 服务桥受同一实例约束。单次 CLI、DSH 独立原生路径、宿主借用服务及自行绕过客户端联网的可信插件，不因此获得调度承诺。没有增加后台轮询或自动恢复队列。

从源码仓库运行受控本地 HTTP 和独立根用例：`tests/media-scheduler.mjs`、`tests/application-scheduling.mjs`、`tests/scheduling-policy.mjs`、`tests/scheduling-limits.mjs`、`tests/scheduling-api.mjs`、`tests/scheduling-proxy.mjs`、`tests/scheduling-recovery.mjs`；`tests/operation-runner-scheduling-failures.mjs`另覆盖排队失败隔离、终态排空和持久失败保留租约。`scripts/verify-local-web-browser.mjs --scheduling` 验证真实工作台队列提示与停止，`scripts/verify-scheduling-package.mjs` 检查实际候选 CLI/stdio MCP。这些开发脚本不随npm包分发。包验证复用已有依赖，不代表一次干净安装或真实 Agent 交付。这些验证不等于真实供应商压力、真实 Clash/TUN、ComfyUI GPU 或全部平台验收。旧百炼实验的 HTTP 峰值不能代替本片应用入口的容量证明。
