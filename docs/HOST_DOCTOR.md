# Host Doctor

Host Doctor 是 Iris 在运行中的 DSH 实例内提供的兼容性诊断。它与 `dsh-iris doctor` 共用 schema、检查状态和 0/1/2 严重度，但观察范围不同：

| 模式 | 入口 | 观察范围 |
|---|---|---|
| `offline` | `dsh-iris doctor [--json]` | Node、依赖、私有存储、配置、Task 与产物；不要求 DSH |
| `host` | 已认证 DSH 中的 `GET /iris/api/doctor` | DSH 版本和 Host Port、插件装载、14 个工具、2 项 Skill、4 组路由、Browser/附件/模型能力、客户端版本与 4 个 UI Slot |

两种模式都默认零网络、零计费。Host Doctor 不调用任何 Host Port，不打开 Browser，不读取附件或会话，不调用文本/视觉模型，也不向 Provider 发送请求。它只读取：

1. DSH Host Adapter 的可序列化能力快照；
2. Iris 服务端本进程内记录的成功注册事实；
3. DSH Web 客户端在 Slot 回调实际执行后发送的受限同源握手。

## 使用

在 Iris 工作台的“宿主诊断”卡片中可以直接查看、刷新并展开全部检查。需要原始 JSON 时，先通过 DSH 输出的认证 URL 打开 Web 页面，再在同一实例访问：

```text
/iris/api/doctor
```

这是工作台路由下的 JSON 端点，继承 Iris 路由的 Host/认证边界。HTTP 200 表示诊断成功生成，不代表所有检查健康；应读取响应中的 `exitCode`：

- `0`：当前可观察项全部健康；
- `1`：存在可降级警告，例如页面尚未打开、可选 Browser 缺失；
- `2`：存在硬错误，例如工具/路由缺失、DSH 超出已验证范围、客户端和服务端版本不一致。

如果刚安装、热更新或强制刷新，先等 Web 页面完成装载，再刷新诊断。未收到客户端握手时，Host Doctor 只报告警告，不会把“服务端已装载”冒充成“UI 已装载”。

## 运行时证据

服务端只登记成功完成的注册：

- 插件身份与 npm 版本；
- 14 个 Iris Agent 工具名；
- `iris-verify-ui`、`iris-compose-media`；
- `/iris/media`、`/iris/api`、`/iris/api/actions`、`/iris/render` 四组逻辑路由。

客户端通过 `POST /iris/api/host-client` 回报插件 ID、静态客户端版本、协议版本和已执行的 Slot 名单。接口拒绝额外字段、未知 Slot、错误插件身份、空版本和无效协议号；同一前端版本的并发报告只做 Slot 单调并集，避免乱序请求把完整证据覆盖成部分证据。报告只保存在内存，不参与认证、任务执行或能力授权，也不接收 API Key、草稿、会话、附件或 Provider 数据。

## 能力与降级

Host Adapter 将每项端口标记为 `available`、`unavailable` 或 `incompatible`，并给出同一份人类可读原因。工具注册与 Web 路由是 DSH 插件形态的硬要求；Skill、Browser、附件、会话以及宿主文本/视觉模型可按功能降级。

客户端握手是当前浏览器实例的最后报告。关闭页面后报告不会立刻证明页面仍存活，因此它是装载兼容性证据，不是在线心跳。Host Doctor 也不替代真实 Provider 探针；任何可能计费的测试仍必须由用户显式触发。
