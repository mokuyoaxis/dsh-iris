# 本地持久选择（面向 0.3，未发布）

源码的 `api serve` 和 `web serve` 可显式开放选择接口，将已完成图片流程的原图或生成结果保存为当前作品。**npm 0.2.7 尚不包含此接口**；[真实工作台](LOCAL_WEB.md)已接入原图/结果选择，服务确认后才显示已选状态，冲突或回包丢失时读取当前事实。

## 显式开启

在已有专用 Flow 根上启动；不初始化或转换原根，不需要 Provider 配置，也不要求连接管理、创建或执行模式：

```bash
node bin/dsh-iris.js web serve --data-root /absolute/path/to/flow-root \
  --token-file /absolute/path/to/new-owner-token --allow-selection
```

也可换用 `api serve`。默认不开启；`--allow-local-writes`、`--allow-execution` 和 `--allow-connection-management` 均不会隐式开启选择。创建和执行模式仍各自要求已初始化的请求区或 v1 执行根，见 [本地创建](LOCAL_CREATION.md)与 [Core 服务](CORE_SERVICE.md)。

Token 文件须为根外新文件，权限沿用本地 API 约定。只有本次服务的 owner Token 能调用选择；连接凭据即使拥有全部 MCP 权限也不能调用，不新增 MCP scope 或工具。Bearer、精确 Host、同源 Origin 和禁止跨站请求的检查保持，见 [访问边界](LOCAL_API.md#身份与访问)。

## 请求与版本门禁

先通过 `GET /api/v0/runs/:id` 读取最新 `revision` 与原图/结果的 Artifact ID，再由用户明确选择：

```http
POST /api/v0/runs/:id/selection
Authorization: Bearer <owner-token-from-private-file>
Content-Type: application/json

{"artifactId":"artifact_<24 lowercase hex>","expectedRevision":7}
```

正文只接受这两个字段；`expectedRevision` 必须是正安全整数，JSON 上限 8 KiB。原图或结果须属于该 Run，且流程已完成比较。路径、URL、比较图和其他 Run 的作品均不能作为选择目标。

版本核对和选择写入在同一个 Application writer 中完成，复用原子 Run 提交，不新建请求区、Operation 或选择收据，也不改 Run 格式。成功返回 `200` 和当前 FlowView：

- 选择改变时，Run 的 `revision` 增加一次。
- 当前版本重复选择同一作品时，不重写记录、不增加版本。
- 版本已过期时返回 `409 IRIS_API_RUN_CHANGED`，即使目标恰好与当前选择相同也拒绝，避免旧操作覆盖后来的决定。
- 本实例有活动或排队写入、runner 操作，或其他写者占根时，返回 `409 IRIS_API_ROOT_BUSY`；不承诺排队。

本接口不提供持久 `Idempotency-Key` 接回。响应丢失后先 GET 当前 Run 核对真实选择；若要改变，使用当前版本再次明确提交，不自动重试旧请求。请求在开始写入前断开会取消未开始项；已经提交的选择保留，不能因客户端未收到响应而回滚。

## 结果与错误

选择不调用 Provider，不创建/观察 Task，不触发生成或下载。之后的 `GET /api/v0/runs/:id/download` 返回已选图片原字节；浏览器保存完成仍以下载记录为准。

| 状态 | 含义 |
|---|---|
| 400 / 413 | 字段、类型、版本或请求格式无效 / 正文超限 |
| 401 / 403 | 身份无效 / 访问边界不符或调用方不是 owner |
| 404 | 合法 Run ID 不存在 |
| 405 | 未显式开启选择，或方法不支持 |
| 409 `IRIS_API_RUN_CHANGED` | Run 版本已改变，先读取再决定 |
| 409 `IRIS_API_RUN_NOT_READY` | 比较尚未完成 |
| 409 `IRIS_API_SELECTION_INVALID` | 作品不属于该 Run 可选的原图或结果 |
| 409 `IRIS_API_ROOT_BUSY` | 写者或执行器忙 |
| 500 | 意外写入错误；不报告成功，响应只提供净化错误与关联 ID |

CLI 的 `flow select` 保持原有用法；内部应用调用另支持可选 `expected_revision`。页面按钮、创建身份查询与刷新恢复属于后续切片，不因本接口完成而自动具备。
