# 只读本地 API（0.2.7 / I4A）

未发布源码另有 [Core 有限执行与 harness 服务](CORE_SERVICE.md)，需独立显式开启。本文其余内容说明已发布 0.2.7 的默认只读与零生成创建范围；执行实现及连接协议以上述指南为准，真实 Web 可显式管理连接，媒体操作仍只读。

0.2.7 增加显式启动的本地 HTTP 入口，默认只提供 GET/HEAD，用来验证无 DSH 环境下的流程查询与图片访问。另有主动启用的 [本地上传与创建](LOCAL_CREATION.md)；继续、选择和取消等执行接口尚未开放。安装包不会自动启动本服务。

现有 [Web Demo](WEB_PROTOTYPE.md)继续保留为面向 0.3.0 的交互说明，尚未连接这个 API；界面和交互细节到 0.3.0 阶段统一润色。[完整 API 契约](LOCAL_API_CONTRACT.md)分别说明已发布、未发布实现与选择 API 草案。

## 显式启动与停止

准备一个已经由 `flow init` 初始化的专用根，操作见 [固定图片流程](IMAGE_FLOW.md)。只读服务不会创建缺失的根或转换旧根。

```bash
dsh-iris api serve --data-root /absolute/path/flow-core --token-file /absolute/private/iris-session-001.token
```

`token-file` 必须是**新文件的绝对路径**，已有父目录须可写，且该文件位于 Core 根之外。启动时生成新的随机 Token，写入此文件；POSIX 文件权限为 0600。终端只打印服务地址、文件路径和只读说明，不打印 Token；URL 与接口响应也不带 Token。请使用支持私有文件权限的本地目录；Windows 的 mode 不等于 ACL，权限依赖系统账户控制。

服务固定监听 `127.0.0.1`，默认随机端口；可用 `--port 4174` 指定端口，占用时报错。打印的 JSON 中 `origin` 是本次服务地址。`--provider-config /absolute/path/providers.json` 可选：提供时，模型列表只读解析该显式文件，不发现/同步模型、不调用 Provider、不返回 Key 或端点；省略时仍可离线查看流程和已保存图片，模型列表返回 `configured: false`。

Ctrl+C 关闭监听和连接，等待读取释放；POSIX 下也支持 SIGTERM。Windows 的进程终止信号行为不同，其优雅停机尚未实际验证。停机后本次 Token 失效；重启使用新的 Token 文件名。旧 Token 文件保留，不覆盖或自动清理，不作为下次启动凭据。启动和关闭均不持有 Core writer，不重启 DSH。

## 身份与访问

每个接口都要求 `Authorization: Bearer <Token>`。Token 从私有文件读取，保持在调用进程内存中，不放进 URL、命令行参数、聊天或共享日志。下面仅把文件路径交给 Node，示例响应不包含 Token；替换实际端口与文件路径后执行：

```bash
node --input-type=module - http://127.0.0.1:4174 /absolute/private/iris-session-001.token <<'JS'
import fs from 'node:fs';
const [origin, tokenFile] = process.argv.slice(2);
const token = fs.readFileSync(tokenFile, 'utf8').trim();
const response = await fetch(new URL('/api/v0/session', origin), {
  headers: { Authorization: 'Bearer ' + token }
});
console.log(response.status, await response.json());
JS
```

Host 必须精确匹配启动地址；带 Origin 时须等于该 origin，跨源、`null` 来源和跨站请求拒绝，不采信转发头，不开放 CORS。所有响应禁止缓存并使用 nosniff；未认证时返回 401，不读取流程或模型配置。Token 文件或浏览器已有 DSH 登录状态不能代替本 API 的 Bearer 请求头。

## 当前接口

以下路径都以 `/api/v0` 开头，支持 GET 和 HEAD；HEAD 完成同样的鉴权与校验，响应无正文。

| 路径 | 结果 |
|---|---|
| `/session` | 实例标识、只读能力和限额，无根路径或 Token |
| `/models` | 当前图片候选的模型引用、显示名、`supportsImageEdit`；只是配置事实，不是实测可用性 |
| `/runs?limit=20&cursor=…` | 最多 30 项摘要，不含 Prompt；`nextCursor` 是下一页使用的最后 Run ID，末页为 null |
| `/runs/:id` | 白名单 FlowView，含用户创作输入和原 Task 的有限事实；未知状态保持，不自动恢复 |
| `/artifacts/:id/content` | 已提交图片的原字节，按 ID 读取该根中的作品，不接受本地路径或外部 URL |
| `/runs/:id/download` | 已选择作品的原字节与固定附件名；尚未选择返回 409，不写服务器输出路径 |

图片访问仅提供 PNG、JPEG、WebP，单份最多 64 MiB；当前使用有界、已核验内容哈希的字节快照。大型媒体的磁盘流式、Range 和音视频访问留到后续，不作为本切片能力。最多两个活动读取，繁忙返回 429。列表使用现有 Flow 存储逐项盘点，页数限制只约束响应数量，尚未建立大型目录索引。

默认只读模式下，非 GET/HEAD 方法返回 405；不支持的路径返回 404，未知/重复查询参数或格式错误的 ID 返回 400。损坏/不一致的记录返回 409，不修复原文件；错误只包含固定代码、说明和关联 ID，不透传堆栈、配置、私有路径或 Provider 错误原文。

详情和图片属于私有创作数据，均需鉴权。列表、查看、HEAD、刷新与下载不会调用 `flow.continue`，不会补交付或重新生成；下载请求成功也不证明浏览器已保存文件。CLI 的本地 `flow export` 仍是单独的显式写操作。

## 后续范围

默认入口保持 I4A 的只读行为。0.2.7 的 [I4B](LOCAL_CREATION.md)另提供新空根请求区与 `--allow-local-writes`：上传和 Run 创建使用持久 Key/预留身份，本地提交后 201、重放 200；不执行生成。有限执行/取消和真实 Web 联调留到后续，不改 Flow/Task/Artifact 格式、不迁移原数据根或冻结公共 SDK。
