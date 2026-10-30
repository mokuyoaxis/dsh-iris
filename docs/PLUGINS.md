# Core 插件贡献 v0（0.3 alpha，实验性）

0.3.0-alpha.1 提供实验性 `@mokuyoaxis/dsh-iris/plugins` 入口及类型声明。**稳定 npm 0.2.7 没有这个入口**；示例用于alpha包或当前源码，尚未承诺稳定 SDK。兼容检查读取实际包版本，alpha标识也参与SemVer先后比较。

## 贡献与装配

一个插件可组合以下贡献；它们由同一实例激活和释放。

| 清单字段 | 当前已有行为 | 后续装配 |
|---|---|---|
| `providers` | 桥接已有 Provider 注册器，复用媒体任务执行、目录与恢复 | 沿用显式 Provider 配置，仍只有既定五种媒体任务能力 |
| `operations` | 声明输入、模式与 Core 命令；本地 Host 调用或明确选入持久 `plugin.execute`，经 Web/通用 MCP 使用 | 尚无 CLI 业务执行命令或插件安装向导 |
| `pages` | 显式选入默认工作台导航，共享主题、登录与受控 Core API；业务需服务主动开启 | 无自动安装或发现 |
| `settings` | 默认折叠的设置模块；管理开启时复用 Core Provider 读写 | 暂无任意插件私有设置存储 |
| `renderers` | 按实际媒体类型列出可选预览，读取原始 Artifact | 新媒体类型仍受 Core 实际交付接口限制 |

插件实现业务；Core 管权限、执行队列及存储；Web/MCP 再交付能力，Skill 解释使用方式。注册不会创建 MCP 授权、修改 harness、调用模型或把任意代码暴露为 API。`activate` 与模块顶层仍是可信代码，应只初始化自己的资源，不提交媒体任务。

[原 Provider 扩展](PROVIDER_EXTENSIONS.md)和[整套 Panel 替换](PANEL_EXTENSIONS.md)继续可用，入口格式分别保留。CLI 的 `--provider-extension` 接收原 Provider 工厂，`--panel` 接收整套资源清单；不要把新插件清单直接传给这两个参数。CLI 可用[显式插件启动配置](PLUGIN_STARTUP.md)装配，Node 宿主也可使用下方公开接口。

## 最小业务插件

```js
import { definePlugin } from '@mokuyoaxis/dsh-iris/plugins';

export default definePlugin({
  manifest: {
    contractVersion: 0,
    id: 'example.library',
    version: '1.0.0',
    compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' },
    contributions: {
      operations: [{
        id: 'count', version: '1.0.0', title: 'Count saved artifacts',
        mode: 'reader', commands: ['artifact.list'],
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
      }]
    }
  },
  activate({ onDispose }) {
    // Register cleanup before awaited initialization, so failed activation also releases it.
    onDispose(async () => { /* release resources owned by this instance */ });
    return {
      operations: {
        async count(_input, { core }) {
          const result = await core.execute('artifact.list', {});
          return { count: result.total };
        }
      }
    };
  }
});
```

`min` 从首次提供此SDK的0.3.0-alpha.1开始，稳定0.2.7不支持插件入口。Core兼容区间使用闭/开边界，npm peer范围另按npm SemVer规则处理；面向本alpha的插件可明确声明 `>=0.3.0-alpha.1 <0.4.0`，不能假定仅有稳定版下界的范围会接受预发布。

宿主显式加载已安装且可信的 JS/MJS 入口；示例使用已经存在的 Core 数据根，只读调用不会创建它：

```js
import { loadCorePluginRegistry, createCorePluginHost } from '@mokuyoaxis/dsh-iris/plugins';

const registry = await loadCorePluginRegistry({ entries: ['/absolute/my-plugin/index.mjs'] });
const host = createCorePluginHost({
  dataRoot: '/absolute/existing-core', registry,
  allowedOperations: ['example.library.count']
});
try {
  const result = await host.call('example.library.count', {});
  console.log(result); // { dependency: ..., value: { count: ... } }
} finally {
  await host.dispose();
  await registry.dispose();
}
```

`createCorePluginRegistry({plugins:[definition]})` 用于已有模块的显式装配；默认 Core 版本来自实际包。`coreVersion` 仅供具体宿主装配或兼容测试显式传入，不应用虚构版本绕过兼容检查。Host 关闭不释放共享 registry；先关闭全部使用者，再释放 registry。

## Core 能力目录与授权

内置工具的名称、输入、功能归属、操作权限和逐工具使用说明集中在 Core 声明中。MCP/DSH 工具定义、连接校验、Web 连接选项、会话操作投影和连接专属 Skill 从它派生。工作流配方、图标和人工解释仍可单独编写；它们不能增加可调用能力。历史授权仍保存准确工具名单，旧文件的固定兼容集合保持，不因新增工具或安装插件自动扩张。

公开目录只读取已校验注册器，既不扫描模块，也不调用业务：

```js
import { createCoreCapabilityCatalog } from '@mokuyoaxis/dsh-iris/plugins';

const catalog = createCoreCapabilityCatalog({ registry });
const declared = catalog.snapshot({ audioEnabled: true });
// groups/tools/scopeOptions/media：Core 内置连接选项。
// plugins/contributions：已加载插件和五类贡献的身份、版本、准确依赖及接入状态。
const selected = catalog.selectOperations(['example.library.count']);
// 仅校验装配者明确提供的本地选择；不调用、不持久授权、不开放 Web/MCP。
```

`audioEnabled` 仅决定目录显示哪些内置分组，不能开启工作区或绕过真实根版本检查。目录快照深度只读；省略 `registry` 时仅列内置选项和空插件贡献。`selectOperations()` 默认空，未知或重复业务拒绝；注册器关闭后贡献标为 unavailable，不能继续选择。程序化 Host 也通过此目录校验 `allowedOperations`，真实调用继续检查原贡献依赖、输入和 Core 队列权限。

贡献的 `access` 是装配边界，**不是用户已经授权或服务已实测**：Provider 的 `via-media-flow` 仍需模型配置和流程授权。业务默认尚未暴露；服务明确选择 `allowedOperations` 后，Web/MCP 状态才成为 `via-operation/requires-selection`，连接还需选择准确依赖。Web 贡献默认 descriptor-only / not-mounted；选入后为 available-in-panel，不表示已加载或实测。发现接口不提供脚本路径；选中模块的固定 URL 只在 owner 工作台会话中交付。

源码服务装配器可显式给 `createLocalReadApi` 传入同一 `pluginRegistry`、`panelContributions` 和 `allowedOperations`；若另传 `providerRegistry`，须是该实例的 `registry.providers`。先关闭全部服务与 Host 再释放共享注册器。owner 能力/连接管理目录读取同一投影，连接凭据只能读自身业务选择。包外可用下方公开入口，或 `api/web serve --plugin-config`；CLI 持有并按服务 → 注册器顺序释放资源。

## 身份、版本与兼容

- `contractVersion` 当前为 `0`。插件 `id/version`、各贡献 `id/version` 与 Iris 包版本分别管理。
- ID 使用有界小写字母、数字、点、连字符或下划线，贡献的公开 ID 为 `pluginId.localId`，合并后最多 80 字符。`iris`/`iris.*` 及现有 Core 命令根名称保留；同插件与同类贡献的完整 ID 不能重复，后加载不能覆盖，包括不同插件/局部 ID 拼接成同一完整 ID 的情况。
- 插件及贡献版本为 SemVer；同一版本应保持相同实现和持久语义。版本声明不是代码完整性校验或安全签名。
- `compatibility` 为 `min <= coreVersion < maxExclusive`。使用 SemVer 优先级，构建元数据不影响比较，区间内预发布版本按同一顺序比较；不支持 npm 的 `^`、`~`、`||` 或通配范围。
- 全部清单、兼容与业务输入 Schema 在任何 `activate` 前检查。动态 `import` 已执行模块顶层，兼容门禁不隔离模块求值。
- 清单是可序列化数据。模块缓存可复用，实例资源须在 `activate` 内建立；实现映射必须与声明一一对应。

## 业务操作

`mode` 为 `reader/writer`，`commands` 是此贡献要调用的 Core 命令子集。Host 的 `allowedOperations` 默认空，捕获后单次调用不能扩大。命名空间与声明都不代替用户授权。

允许 `artifact.inspect/read/list`、`task.inspect/list` 和写者使用的 `artifact.import`。`artifact.read({artifact_id})` 返回8 MiB内 PNG/JPEG/WebP 元数据与 `imageBase64`；`artifact.import({image_bytes})` 仅接图片字节。持久业务用可选 `artifactInputs` 声明来源 ID 的顶层字符串/字符串数组字段，只能读取已绑定来源。未声明命令拒绝，读业务不能写。删除、任意路径、shell、远端提交/观察不在子集中；复用 Core FIFO/租约与已落盘读取。

连接选入带图片输入的业务后，目录和预览共享同一根内符合上述格式/大小的图片，包括其他业务产物；来源共享不授予其他业务的执行、历史或停止权限。没有图片输入声明的业务不因此获得图库读取。此规则不隔离同进程原生插件代码；需要作品隔离时使用独立数据根，安装只信任的插件。

输入为封闭根对象的 JSON Schema：支持 `type/title/description/properties/required/additionalProperties/items/anyOf/enum/const`、数字上下界及 `multipleOf`、字符串长度及 `pattern`、数组长度。类型为 object/array/string/integer/number/boolean/null；未知关键字、`$ref`、默认值与隐式转换不接受，受现有 Zod 编译器约束，无法编译会在激活前拒绝。

调用只获得 `{signal, dependency, core:{execute}}`，没有宿主 ctx、Token、数据根或直接存储句柄。Core 命令顺序执行；即使业务忘记 await，Core 也等待所有已发出的命令并报告失败，不提前释放租约。业务输入为独立冻结的 JSON，返回值也必须为 JSON；图片等字节经 Core 导入并返回 Artifact ID。业务自己抛出的意外错误保留给装配者定位。

`host.call` 仍是直接本地调用，没有自动幂等或请求 Key。持久调用由公开工作台的 `allowedOperations` 主动开启，经同一 runner 保存 `plugin.execute`，再由 Web 或通用 MCP 调用；不能混称两条路径。真实随包业务、装配和恢复语义见[多图对照板](CONTACT_SHEET.md)。

## Provider 贡献

清单项为 `{id,version,title,capabilities,configuration?}`。能力与配置字段沿用原 Provider 约束。`activate` 返回同名 `providers` 映射，每项实现 `normalizeEndpoint/createAdapter`，可选 `supportsModel/supportsImageEdit`；具体调用继续遵守 [Provider Adapter](PROVIDER_ADAPTER_CONTRACT.md)。

协议 ID 由 Core 设为完整贡献 ID。Adapter 的配置身份仍为用户的 Provider ID；Core 覆盖并验证协议/依赖元数据，插件不能通过描述更改配置身份。`registry.providers` 是已有注册器形状，可显式传给使用 `providerRegistry` 的服务；该方式只接入 Provider 部分，不挂载页面或新增工具。Provider 下载沿用 Core 分配的暂存目标，不自行管理作品索引。

## 持久依赖与恢复

统一依赖格式：

```json
{
  "contractVersion": 0,
  "pluginId": "example.media",
  "pluginVersion": "1.0.0",
  "kind": "providers",
  "contributionId": "example.media.images",
  "contributionVersion": "1.0.0"
}
```

`registry.dependency(kind,fullId)` 返回冻结描述，`assertDependency` 核对序列化后原身份。新插件 Provider 在远端提交前，由 Core 将 `pluginDependency` 保存到 Task/Attempt，并把同一依赖加入 Provider binding。配置解析和较低层 Task Runner 都核对依赖；插件/贡献版本改变或缺失时，不观察、不重选、不重新生成。恢复准确版本后，仅明确操作才继续原远端任务。

历史任务及已保存作品在缺少插件时仍可读取。旧 Provider 绑定不加字段、不猜测插件版本、不迁移；旧 Task schema/语义版本保持，可选元数据仅写入新插件产生的 Attempt。Task 与其当前 Attempt 的依赖不一致视为记录损坏。首片不提供兼容恢复别名、自动迁移或热替换，升级失败不会转成重新提交；已有明确计费重试仍按原规则创建新 Task，不冒充原任务恢复。

## Web 贡献和生命周期

页面和设置表单声明 `{id,version,title,entry,styles?}`；作品渲染器再声明非空 `mediaTypes`，使用 `image/png` 等准确值，不接受通配符。入口为插件目录内 JS/MJS，样式为 CSS；不接受 URL、绝对路径、查询、父目录或符号链接逃逸。加载器在激活前固定资源字节，单文件最多 8 MiB，每插件合计最多 16 MiB；浏览器只获得明确选中贡献的入口与样式，不开放插件目录或 Node 入口。入口应打包为独立模块，样式不能依赖未声明文件；不扫描 import 图或自动发布同目录资源。

模块导出 `mount(context)`，可返回清理函数或其 Promise。上下文含 `container/signal/dependency/session/theme/api`，渲染器另有 `artifact:{id,mediaType,label?}`。三处使用同一冻结的会话快照，不提供 Token 字段；`theme.current()/subscribe()` 读取实际明暗和密度，CSS 继承鸢尾及工作台变量。挂载容器位于 Shadow DOM，避免样式意外覆盖工作台。

`api` 复用认证客户端，提供 `runs/run/models/audioModels/artifact`，不接任意 URL/路径。只有设置模块且开启 owner 供应商管理才有 `api.providers.read()/save()`，沿用 revision/凭据动作。持久业务开启时另有 `api.pluginOperations.catalog/history/execute/inspect/lookup/stop`；execute 需要稳定 `key` 和准确 `operationId/dependency/input`，返回持久回执。Core 逐请求核对权限；未知结果查原 UUID，不自动重做。没有任意配置存储或通用命令转发。

挂载器在会话选中 Web 贡献或开启持久业务时加载；旧服务两者均无时不请求新增资源。导航页按需加载；设置默认折叠；预览需展开并选择匹配 MIME 的渲染器，原生预览仍可用。切页、收起或退出会中止信号、撤销对应 API、移除容器/主题监听并清理；迟到挂载仍会释放。插件负责自己的 Blob URL/监听/定时器和未保存草稿。错误显示贡献 ID、阶段及可用关联 ID；重新打开可显式重试，不自动换插件。

包外消费者可以装配已有 Core 根：

```js
import { loadCorePluginRegistry, createCorePluginWorkbench } from '@mokuyoaxis/dsh-iris/plugins';

const registry = await loadCorePluginRegistry({ entries: ['/absolute/my-plugin/index.mjs'] });
const web = createCorePluginWorkbench({
  dataRoot: '/absolute/existing-core', registry,
  workbenchAuth: { directory: '/absolute/private-auth' },
  panelContributions: {
    pages: ['example.library.browse'],
    settings: ['example.library.connection'],
    renderers: ['example.library.png']
  }
  // Optional: allowProviderManagement: true, providerConfigPath: '/absolute/providers.json'
});
try {
  const started = await web.start();
  // First start: open started.loginUrl privately to set a password. Later: use the ordinary origin.
  await new Promise(resolve => process.once('SIGINT', resolve));
} finally {
  await web.dispose();
  await registry.dispose();
}
```

此例的三个 ID 需要实际声明，上方最小业务插件没有这些模块。构造不启动服务、不建根或扫盘；显式 `start()` 仅绑定 loopback，嵌入程序负责 dispose。`workbenchAuth` 显式开启[访问口令](WORKBENCH_LOGIN.md)，省略时保持旧 SDK 的一次性链接模式；认证目录须在 Core 根外且私有。默认媒体只读，供应商编辑另行开启。可选 `allowedOperations` 明确业务完整 ID，要求现有专用执行根；省略不装配业务 runner，`[]` 仅接管/读取历史而不接收新业务。`connectionStore` 指定根外私有目录并开启 owner 管理，`allowMcp` 主动开启 HTTP MCP。整套 Panel 替换仍可用 CLI `--panel` 或 `panelManifestPath`，与组合选择互斥。

`activate({coreVersion,plugin,onDispose})` 为每个实例调用一次。初始化资源后及时注册 onDispose，全部关闭时拒绝新业务及 Provider 调用，等待已预约/在途调用，然后逆序释放资源。初始化失败也释放已注册资源；多项清理错误聚合报告，重复 dispose 返回同一结果。Web mount/清理属于浏览器生命周期，不在 Node activate 内执行。

同进程插件有 Node 进程权限，同源 Web 模块有页面脚本权限，可访问浏览器存储和同源接口。窄 API、Shadow DOM、CSP 及不传 Token 字段不能隔离恶意代码，只加载已审查可信模块。安装器/市场、非可信代码隔离、任意副作用的恢复策略与稳定 SDK 冻结仍未完成。
