# Provider 扩展首版（面向 0.3，未发布）

源码支持实例级媒体协议注册及显式加载可信扩展。**公开 npm 0.2.7 尚不包含此入口**；下列命令用于当前源码或由其生成的候选包。`@mokuyoaxis/dsh-iris/provider-extensions` 是实验性 v0 窄入口，不是完整 Core SDK，也未承诺长期兼容。

六类内置协议（含 [ComfyUI API 工作流](IMAGE_GENERATION.md)）和外部协议消费同样的描述及 Adapter 契约；独立 CLI/API 使用自己的注册实例。当前 DSH 嵌入入口没有新增外部模块加载设置，原有工具、Skills 和存储规则保持。

## 显式使用

扩展通过已安装包的 JS/MJS 入口绝对路径指定，可重复添加：

```bash
node bin/dsh-iris.js providers protocols \
  --provider-extension /absolute/node_modules/my-iris-extension/index.mjs

node bin/dsh-iris.js run image \
  --data-root /absolute/new-core --provider-config /absolute/private/providers.json \
  --provider-extension /absolute/node_modules/my-iris-extension/index.mjs \
  --input '{"prompt":"a landscape","model_ref":"my-provider::my-model"}'

node bin/dsh-iris.js web serve \
  --data-root /absolute/initialized-v1-core --provider-config /absolute/private/providers.json \
  --token-file /absolute/private/new-owner.token --allow-execution \
  --provider-extension /absolute/node_modules/my-iris-extension/index.mjs
```

`providers protocols` 返回扩展身份/版本、协议、能力和配置字段描述；不包含具体连接值或密钥，不构造 Adapter 或调用模型。**导入的模块及工厂本身仍是可执行代码**，由用户选择可信来源。服务按明确路径加载，不扫描目录、安装包或自动更新扩展。

扩展注册不授予模型用途或 MCP 权限。用户仍需在显式 Provider 文件中填写连接和模型、确认功能分配。既有协议的新供应商通常只需配置，无需额外代码。服务模式下，harness 通过已有授权调用这个 Core，不需获得上游媒体 Key，也不需各自加载同一媒体插件。

## 模块契约

默认导出一个工厂，每次创建注册实例会重新调用；工厂可异步返回以下对象。Node 会缓存模块，模块顶层应保持无实例状态，资源由工厂实例持有。

```js
export default function createExtension() {
  return {
    contractVersion: 0,
    id: 'my-media-extension',
    version: '1.0.0',
    protocols: [/* below */],
    async dispose() { /* release resources owned by this instance */ }
  };
}
```

协议描述字段：

| 字段 | 语义 |
|---|---|
| `id`, `label` | 稳定协议标识与显示名称；实例内唯一，重复不覆盖 |
| `capabilities` | `image-gen`、`video-gen`、`tts`、`music-gen`、`transcribe` 的非空子集 |
| `normalizeEndpoint(baseUrl)` | 同一端点的稳定表示，参与既有 binding 哈希；公共 `normalizeMediaEndpoint` 提供普通 HTTP(S) 规范化 |
| `createAdapter(provider, options)` | 同步返回 [Provider Adapter v0](PROVIDER_ADAPTER_CONTRACT.md)，具体网络操作在其生命周期方法中执行；ID 必须匹配连接，协议/能力必须匹配描述 |
| `supportsImageEdit(modelId)` | 可选；当前模型支持带原图编辑时返回 `true`，默认不支持 |
| `supportsModel({provider,modelId,capability,checkEndpoint})` | 可选的具体限制；能力集合仍是前提，不扩张用户分配 |
| `configuration` | 可选字段数组；首版只描述现有 `baseUrl`、`mediaBaseUrl`、`apiKey`，类型分别为 `url`、`url`、`secret`；可含 `required`、`advanced` 布尔值 |

工厂负责声明和按需初始化能力；一次注册不应提交媒体任务。描述只提供已有配置字段的信息，没有新增自定义持久字段、凭据 helper 或 UI 脚本。扩展实现版本与 Iris 包版本、契约版本及 Task 格式版本分别管理；首版验证契约必须为 0，扩展版本使用明确的三段版本字符串。

窄包入口导出 `defineProviderAdapter`、`ProviderContractError`、`normalizeMediaEndpoint`、两个契约版本常量，以及异步 `createProviderRegistry({extensions:[factory]})` / `loadProviderRegistry([absoluteEntry])`。程序化服务可显式传入 `providerRegistry`；提供者拥有其生命周期，服务只释放自己创建的默认注册实例。

## 调用、恢复与释放

扩展 Adapter 经同一候选选择、能力判断、健康/限流、输入校验和 Core Task Runner；图片和音乐的模型级协议覆盖也使用当前注册实例。目录发现与实际模型实测仍需明确操作。常规自动池只按已确认用途选择，不因安装插件新增授权。

注册实例关闭后拒绝新操作，等待当前 Provider 调用结束，再逆序串行执行扩展释放。重复关闭共享同一个释放过程，失败明确报告。应用应先停止请求/runner 和等待 Core 操作，再释放注册实例。首版更新通过受控服务重启生效，不提供在途热替换。

原五类协议的 Task binding 保持原协议和端点的哈希输入；新增 ComfyUI 使用独立的 v2 binding，另纳入模板摘要，不转换旧记录。协议 ID、端点规范化规则及工作流摘要是恢复约定；升级扩展应继续识别原远端任务。缺少扩展、模型协议无效或端点/模板改变时，恢复明确失败，不选择新 Provider 或重新生成；历史 Task/Run/作品仍可只读查看。恢复原配置后，明确观察/继续仍使用原 Task。

Core 会对错误与健康证据中的连接 Key 再做精确脱敏，`auth:none` 不把保留的旧 Key 交给扩展工厂；扩展仍有责任输出正确的受理状态与错误映射。同进程插件拥有 Node 进程的系统权限，窄接口和声明不是系统沙箱。只加载可信代码；不受信任代码隔离不在此版范围内。

## 验证范围

源树的 `tests/provider-extensions.mjs` 覆盖实例隔离、协议描述、旧哈希、冲突/版本、在途释放与失败。`scripts/verify-provider-extensions-package.mjs` 将候选包解到仓库外，复制独立测试插件包，只经上述公开入口接入真实 CLI/API/Core；受控 HTTP Provider 验证原 Task 恢复、原图编辑、Key 接回和图片字节。

验证脚本明确复用已有依赖，不代表重新安装全部依赖或真实供应商付费验收；测试插件和验收脚本不进入 npm 包。未发布源码另有 [C3 管理 API/页面](PROVIDER_SETTINGS.md)和独立 [Panel/主题](PANEL_EXTENSIONS.md)；外部凭据桥、任意 Recipe/工具注册与完整插件市场仍是后续工作。
