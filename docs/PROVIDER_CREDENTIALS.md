# 供应商环境凭据引用（当前源码）

此功能从 **0.3.0-beta.1** 提供，旧alpha.1和稳定0.2.7不会解析此引用；不要用旧版本编辑新增引用的配置。原有内联 `apiKey` 配置继续可用，不自动迁移。

## 配置来源

在 Core「模型服务」的供应商编辑页，凭据操作选择「引用环境变量」，填写名称，例如 `IRIS_MEDIA_KEY`。保存只写名称，可以在变量尚未就绪时先保存。页面区分未就绪、已就绪和值无效；保留时名称只读，修改来源需再次明确选择。取消/放弃草稿不修改原配置。

显式 Provider JSON 的对应字段为：

```json
{
  "providers": [{
    "id": "media",
    "name": "My media service",
    "baseUrl": "https://example.com/v1",
    "mediaProtocol": "openai-chat-images",
    "apiKeyEnv": "IRIS_MEDIA_KEY",
    "models": [{ "id": "your-image-model", "capabilities": ["image-gen"] }]
  }],
  "assignments": { "image-gen": ["media::your-image-model"] }
}
```

地址和模型仍需换成实际服务支持的值。变量名须符合 `[A-Za-z_][A-Za-z0-9_]{0,127}`；值须非空、最多8192字符且为可打印 ASCII 文本，使用时去掉首尾空格。变量未设置、空白或值无效均不发送请求。

同一供应商的 `apiKey`、`apiKeyEnv` 和 `dshProvider` 不得混存。Web「保留」保留现有来源，「填写/替换」换为内联 Key，「引用环境变量」换为引用，「清除」移除两种手动来源。CLI `providers set` 明确提供内联 Key 或环境引用时，会替换另一种手动来源。已有配置备份仍可能包含以前保存的内联密钥，不会因切换来源而自动清理。

beta.1修复将持久来源互斥统一用于配置读取、CLI 和 Web 保存：`dshProvider` 条目不能附加普通 `baseUrl`、`apiKey` 或 `apiKeyEnv`，空串或null也不作为隐式换源；`mediaBaseUrl`只能省略或留空，非空同样拒绝。DSH引用的实际端点与密钥均由宿主解析，工作台不提供媒体地址覆盖。若要改成手动连接，应新建供应商。非法混存拒绝保存，读取时报错并保留原文件，不因新的来源约束隔离或自动迁移配置。地址和密钥字段的null/非字符串编辑在写入前拒绝，保留原磁盘和内存状态。DSH合法的端点/密钥内存副本仍可使用，不属于持久配置。

DSH 的[宿主连接引用](DSH_PROVIDER_CONNECTIONS.md)继续走自己的宿主凭据端口，不会把 DSH 配置中的引用自动解释为 Core 环境变量。首片在 Core Web/CLI 提供配置入口，DSH 原工作台没有新增此编辑控件。

## 启动与轮换

变量必须提供给**启动 Core 的进程**。例如在 Bash/Termux 中，隐藏输入后导出，再执行原启动命令：

```bash
read -r -s -p 'Iris API key (typing hidden): ' IRIS_MEDIA_KEY
printf '\n'
export IRIS_MEDIA_KEY
node bin/dsh-iris.js web serve --data-root /absolute/core \
  --provider-config /absolute/providers.json --allow-provider-management
```

上面适用于已有专用根/配置；创建步骤见 [Core 快速开始](CORE_QUICKSTART.md)。也可由自己的服务启动器注入环境。Iris 不扫描或加载 `.env`，不执行凭据命令，也不修改 shell 启动文件。密钥输入不可见，不需要贴进聊天、页面或启动参数。

另一个终端中的 `export` 不会更新已经运行的 Core。轮换后，应让新启动的服务继承新值；正常停止后按原数据根、连接目录和端口重新启动。页面刷新只重新读取当前进程的状态，不会读取另一个 shell 的环境，也不会自动重启服务。

## 调用与恢复

- 未就绪的连接不进入新请求候选；显式选择它会报 `IRIS_PROVIDER_CREDENTIAL_UNAVAILABLE`。自动模型池继续按其他合格项和原有功能策略工作。
- 检查连接、目录及业务调用在缺少所需凭据时拒绝网络调用。模型目录仍可返回空候选，供应商配置仍可查看/编辑；`config check` 的格式有效不等于环境已就绪或上游认证成功。
- 每个 Adapter 捕获本次解析出的值，后续新操作使用当时的进程环境。已有 Task 仍核对准确供应商、端点、协议和插件依赖；Key/变量名不加入 Task 身份。
- 原 Task 缺少变量时不能借用另一供应商或自动重提。恢复原连接及有效值后，查询/下载原任务；已完整交付的本地结果可继续只读恢复。Key 是否被上游允许访问原任务，由上游账号权限决定。
- `auth:"none"` 不发送保留的 Key，也不要求引用变量就绪，适用于实际无需认证的端点。

## 权限与数据

只有已开启供应商管理的 owner 能查看/更改变量名。MCP 客户端没有环境或密钥读取工具，也不能访问供应商管理路由。普通模型目录仅展示业务可用性，不交付凭据来源。

Core 仅在调用内存中解析值，写配置与备份时不回填解析结果；切换前的内联配置备份仍按原样保留。Task/Operation 和 API 不保存或返回解析值，错误按本次实际调用的 Key 脱敏。现有可信 Provider 插件仍通过原 `apiKey` 参数获得本次运行副本，公共描述不含值。插件是可信代码，这不是 Node 代码沙箱。

摘要中的精确脱敏先于截断和格式化。上游模型ID中包含本次完整Key时，包括带前后缀和短测试Key重合，目录读取按协议错误拒绝整份响应，保留原配置和上一份完整缓存，不导入虚构替代ID。Core HTTP返回502和`IRIS_PROVIDER_DIRECTORY_CREDENTIALS`，CLI提供同一错误码；正常目录读取保持真实模型ID。无需认证的服务使用`auth:"none"`，不要借会与模型ID重合的短字符串充当测试密钥。

beta.1修复也覆盖ComfyUI静态工作流检查：Core CLI/HTTP及DSH工作台的已保存模板、草稿报告，嵌套数组/对象中的字符串值与属性名都先逐层精确脱敏，再编码为JSON。脱敏使用本次检查开始时捕获的凭据，环境随后轮换不改变本次匹配；`auth:"none"`未发送但保留的Key也参与匹配。检查仍只读取节点定义，不写配置或生成作品。

owner 保存契约沿用 v0，新增 `{ "action":"env", "name":"IRIS_MEDIA_KEY" }`。`keep/clear` 不接受额外字段，`replace` 只接收 `value`，`env` 只接收 `name`；修改继续受原 revision、锁、私有备份与原子写入保护。环境值变化本身不改变配置编辑 revision；状态与目录/可用性绑定会重新读取当前值。
