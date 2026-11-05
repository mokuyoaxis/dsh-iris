# 统一 Provider 插件最小契约（beta.1）

本页列出0.3.0-beta.1冻结的最小Provider边界；完整SDK另行演进。新模板见 [`templates/provider-starter`](../templates/provider-starter/README.md)。它独立实现万相 wan2.6 公开异步接口，不依赖 Core 私有 transport。**需要 `0.3.0-beta.1` 及工厂上下文v1能力标记；旧alpha.1不支持。**

| 边界 | 本片确定的约定 |
| --- | --- |
| 身份与版本 | Plugin v0 清单，插件及 Provider 贡献各有独立版本和完整 ID；兼容区间检查 Core 版本，模板另检查工厂能力标记 |
| 工厂 | 同步 `createAdapter(provider, context)`；旧只收一个参数的统一工厂可忽略新增参数；旧窄 Provider 扩展的第二参数保持原用法 |
| 连接副本 | 浅冻结的运行副本；Core 将显式 `apiKeyEnv` 解析成当次 `apiKey` 并移除引用字段，`auth:none` 不提供 Key；缺失引用在工厂/HTTP 前拒绝，不写回配置 |
| 上下文 v1 | 导出 `PROVIDER_FACTORY_CONTEXT_VERSION = 1`；只提供只读 `{contractVersion:1, network:{fetch}, modelId?}`。没有 registry、通用环境读取、存储、代理配置、dispatcher、run 或 dispose |
| 生命周期 | 六个操作各声明 supported 或有原因的 unsupported；submit/mapError 必须实现。mapError 同步；其余完整方法由 Core 登记和等待 |
| 网络所有权 | 工厂内不能请求；仅在已接纳的生命周期方法内借用 fetch，方法返回后拒绝迟到请求。插件等待正文、上传与后续页；Core 停止接纳、排空操作再释放资源，释放错误可定位且不重复执行清理 |
| 出口与调度 | 使用相同 Core 端口参与绑定、任务网络要求、HTTP/RPS 和冷却；显式网络要求缺失时拒绝，不借默认出口。默认继承现有网络环境，不改全局 fetch、dispatcher、环境或系统路由 |
| 提交与恢复 | accepted 必须有原 remoteTaskId；not_accepted、accepted、unknown 分开。Core 保存 Task/Attempt 的准确插件/贡献依赖；缺失或错版阻止继续，恢复准确版本才观察原任务，不重新 POST |
| 执行与存储 | Core 拥有 Flow/Task/Operation、幂等、单写者、权限、作品及交付记录；插件只写 Core 提供的待交付新文件，不自建队列或直接改 Core 元数据 |
| 注册与授权 | Provider 使用已存在的媒体流程与 MCP 工具；目录、安装或启用不自动授予连接权限，用户按功能选择和缩权 |

`network.fetch`接受Node原生`Request`、URL/字符串及`RequestInit`，包括原生`FormData`上传；显式代理的类型转换由Core传输边界处理。插件不需要导入Undici或替换全局构造器。上传文件后应等待响应正文完成，再结束生命周期方法。

公开类型由 `@mokuyoaxis/dsh-iris/plugins` 导出，包括 `ProviderFactoryContext`、`ProviderConnection`、生命周期请求/结果和 `ProviderContractError`。该异常与旧 `provider-extensions` 导出是同一个类。429 可附临时 `retryAfterMs` 提示供 Core 冷却；它不是新增 Task 持久字段。安全错误不能包含原始凭据、上游正文或签名下载地址。

模板保留具体协议的边界：目录从实际上游响应读取，确认前不填模型池；仅支持明确实现的 Wan 模型；对模糊提交不重试、不换模型/出口；本地停止不冒称远端取消。其配置通过公开 CLI 初始化新根，无自动数据迁移、自动安装、热加载或扫描宿主磁盘。

借出的端口是合作约定，可信插件仍能自行导入 Node 模块联网或读文件；这不是进程沙箱。历史窄扩展、DSH 借用服务和独立视觉路径的范围继续见[出站网络接入矩阵](PROVIDER_NETWORK.md)。没有将全部 Core 内部函数、任意插件设置存储或所有平台宣布为稳定 SDK。
