# 工作台请求核对与刷新恢复（面向 0.3，未发布）

本页描述源码中的 W1b 恢复及 W1c 页面接入。npm 0.2.7 不含这些新增接口与浏览器客户端；[真实工作台](LOCAL_WEB.md)已接入明确创作、选择和本地停止，“操作核对”默认折叠，自动恢复始终只读。

## 按原请求读取

owner 的 `GET /api/v0/session` 提供 `rootId`：使用现有创建请求区的稳定 UUID，服务重启、Token 轮换不改变它；没有请求区时为 `null`，读取不会初始化数据。`instanceId` 继续表示本次服务。连接客户端不获得此字段或新查询权限，MCP 工具和 scope 保持。

有现成请求区时，owner 的 `operations` 包含 `creation.lookup`，默认只读服务也可调用：

```text
GET /api/v0/creation-requests?kind=image-import&key=<original-lowercase-UUIDv4>
GET /api/v0/creation-requests?kind=flow-create&key=<original-lowercase-UUIDv4>

{contractVersion:0, kind, state:"prepared"|"succeeded", result}
```

`result` 为 `{artifactId}`、`{runId}` 或 `null`。查询会核对原意图与已有结果；prepared 尚无目标时返回 null，已有目标核验通过后才返回引用。它不补写完成回执、不重建目标、不观察 Task 或调用 Provider。已推进或选择的 Run 不退回初始状态。没有原请求为 404；原结果不可用或证据损坏为 409，并保留原记录。

查询仍要求 Bearer、可信 Host/Origin，不接受其他 kind、路径或重复参数。不返回原始 Key、Prompt、供应商绑定或磁盘记录。Key 是动作身份，不能替代认证。

## 浏览器动作协调

内部客户端提供命名的上传、创建、继续、停止与选择方法，没有任意媒体 POST/Command 执行入口。上传、创建、continue 各自使用一个 Key；同一活动动作的重复调用共享同一次请求，输入不同则明确繁忙。请求失败不自动重试。

结果未知时先读取原 Key/Operation/Run。显式重试保留原 Key；上传需重新提供原图片字节，创建需原输入。服务器继续核对输入摘要，不用新 Key 绕过冲突。查到创建成功只恢复已有 Run，不自动首次执行；读 Operation 也不调用 continue。

选择没有持久 Key：回包丢失后读取 Run，展示“当前选择”，不声称能证明这次请求完成。陈旧 revision 不能覆盖新选择。停止复用原 Operation ID，只停止本地等待，不代表远端取消或退款。

读取总并发仍为二；轻量 JSON 优先于排队中的媒体，不能抢占已开始的读取。写请求和停止直接发送，不进入图片读取队列。会话断开会取消客户端等待，服务已接收的事实仍保留。

## 标签页恢复表

使用 `sessionStorage` 的单个 `iris.workbench.recovery.v0` 键，最多八条待核对动作。只存 origin、稳定 rootId、动作类型与标识、原 Key、已知 Artifact/Run/Operation ID 和预期 revision；不存 Token、Prompt、图片或供应商配置，不使用 localStorage。

上传/创建确认后移除记录；活动 Operation 保留到读到终态。prepared、404、冲突、网络错误或当前服务未开放查询时，保留待核对身份，不自动生成。表满先核对或明确处理已有动作，不悄悄丢弃未知请求。存储不可用时退为内存并提示刷新恢复受限；损坏表保留，暂停新动作，不把损坏当空表。

刷新后先重新认证，再核对 session/rootId 和原请求，全程 GET。换到不同 origin/根时只丢弃旧浏览器标识，Core 数据保持；迟到响应不能写回新根的表。无请求区时只有内存记录，不能承诺刷新定位未知上传/创建。

面板支持只读的“重新核对”和“查看流程”。prepared/未找到的上传、创建或继续可明确“准备按原 Key 接回”，重新提供原图片/模型/要求/参数后再次确认；接回创建不会自动首次执行。损坏或无法继续处理的本地标识，可在说明影响并二次确认后清除；只移除浏览器核对标识，不删 Core、不停止原任务。关闭标签页后不保证保留 sessionStorage；恢复表也不是作品或请求记录的备份。

## 验证

`tests/local-creation-lookup.mjs`、`tests/web-recovery.mjs`、`tests/web-media-api.mjs`覆盖只读查询、原 Key、回包丢失、重启、换根、版本冲突、存储异常及有限动作。真实 Chromium 验证可在[工作台验证命令](LOCAL_WEB.md#验证与下一阶段)后增加 `--recovery`：使用独立根和受控 Provider，由测试明确提交本地写入，再检查生产页面只读恢复。它不进行真实付费生成，也不替代 Android 真机验收。
