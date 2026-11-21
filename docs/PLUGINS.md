# Core 插件贡献契约 v0（实验性）

`@mokuyoaxis/dsh-iris/plugins`（随附完整 TypeScript 类型声明）为第三方开发者提供可组合的扩展机制，支持在一个独立插件中贡献 **Provider 协议**、**持久业务操作**、**工作台页面**、**设置表单**与 **Artifact 预览器**。

> [!NOTE]
> 本文描述插件贡献的 [最小兼容面](BETA_SCOPE.md#最小插件兼容面)。想直接从可运行示例起步，请参考[独立插件开发与验收](PLUGIN_DEVELOPMENT.md)、[`templates/plugin-starter`](../templates/plugin-starter/README.md) 与 [`templates/provider-starter`](../templates/provider-starter/README.md)。

## 贡献类型与设计分工

| 贡献字段 | 能力说明 | 边界与说明 |
|---|---|---|
| `providers` | 接入自定义媒体 Provider，复用 Core 任务执行、目录与恢复 | 能力范围对应既定媒体协议类型，通过工厂上下文 v1 接收凭据与网络客户端 |
| `operations` | 声明输入 Schema、模式与有限 Core 命令，接入 `plugin.execute` | 支持 `createCorePluginHost` 本地调用，或经 Web / 通用 MCP 授权执行 |
| `pages` | 注册为工作台左侧导航页，共享主题、登录与受控 Core API | 显式在启动配置选入后挂载 |
| `settings` | 注册为默认折叠的设置模块 | 开启供应商管理后可读写 Core Provider 配置（无任意插件私有仓库） |
| `renderers` | 按精确 MIME 类型（如 `image/png`）注册作品预览器 | 只读获取原始 Artifact 字节 |

**分工原则**：插件负责实现业务或协议逻辑；Core 负责输入校验、单根写入队列、Operation 持久化、权限拦截与资源释放；客户端接入权由用户在工作台单独授予。

如需继续使用原有的独立 CLI 参数（`--provider-extension` 或 `--panel`），请参阅 [Provider 扩展](PROVIDER_EXTENSIONS.md) 与 [整套 Panel 替换](PANEL_EXTENSIONS.md)；新插件统一通过[启动选择配置](PLUGIN_STARTUP.md)或下方公开 SDK 装配。

## 最小业务插件示例

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
        id: 'count',
        version: '1.0.0',
        title: 'Count saved artifacts',
        mode: 'reader',
        commands: ['artifact.list'],
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false }
      }]
    }
  },
  activate({ onDispose }) {
    // 尽早注册清理回调，确保激活失败或服务关闭时也能有序释放资源
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

在 Node 宿主中加载并调用：

```js
import { loadCorePluginRegistry, createCorePluginHost } from '@mokuyoaxis/dsh-iris/plugins';

const registry = await loadCorePluginRegistry({ entries: ['/absolute/my-plugin/index.mjs'] });
const host = createCorePluginHost({
  dataRoot: '/absolute/existing-core',
  registry,
  allowedOperations: ['example.library.count']
});

try {
  const result = await host.call('example.library.count', {});
  console.log(result); // { dependency: ..., value: { count: ... } }
} finally {
  await host.dispose();
  await registry.dispose(); // 先关闭所有 Host/工作台，最后释放共享注册器
}
```

> [!IMPORTANT]
> `compatibility` 使用 SemVer 闭开区间（`min <= coreVersion < maxExclusive`），不支持 npm 的 `^`/`~`/`||` 语法。涵盖 0.3 预发布与 `0.3.0` 正式版的插件请声明 `min: '0.3.0-alpha.1', maxExclusive: '0.4.0'`。

## Core 能力目录与授权

所有内置工具、能力分组、权限 scope 与插件贡献均汇总在统一的能力目录中，确保 Web、MCP 与连接专属 Skill 使用同一份真相来源：

```js
import { createCoreCapabilityCatalog } from '@mokuyoaxis/dsh-iris/plugins';

const catalog = createCoreCapabilityCatalog({ registry });
const declared = catalog.snapshot({ audioEnabled: true, videoEnabled: true, visionEnabled: true });
const selected = catalog.selectOperations(['example.library.count']);
```

- `catalog.snapshot()` 返回只读的能力分组与贡献接入状态（`access` 反映是否被服务选入装配，不代表客户端已获授权或服务已实测）。
- `catalog.selectOperations()` 校验本次装配显式开启的业务 ID 列表；注册器已关闭或存在未知/重复 ID 时直接拒绝。

## 身份、版本与兼容规则

- **契约与命名**：当前 `contractVersion` 为 `0`；完整贡献 ID 格式为 `pluginId.localId`（最多 80 字符，允许小写字母、数字、点、连字符与下划线，`iris` / `iris.*` 及 Core 命令前缀保留）。重复 ID 会报错而非覆盖。
- **独立语义版本**：插件与每项贡献分别声明 SemVer 版本；同一版本应保持可观察契约与持久语义不变。
- **激活前校验**：清单格式、兼容区间与输入 Schema 在调用 `activate` 前校验（注意 `import()` 仍会执行模块顶层代码，请只加载受信任插件）。

## 业务操作

- **有限 Core 命令**：`commands` 可从 `artifact.inspect`、`artifact.read`（≤8 MiB PNG/JPEG/WebP）、`artifact.list`、`task.inspect`、`task.list` 及写者专用的 `artifact.import` 中按需声明；`reader` 模式禁止声明写命令。
- **来源输入绑定（`artifactInputs`）**：若业务需要读取图片，可在清单中声明顶层字符串或字符串数组字段（如 `['artifactIds']`）。连接被授予该业务后，可浏览同数据根内符合条件的图片，但仅能读取本次明确绑定传入的来源，不会授予其他业务的调用或历史权限。
- **封闭 JSON Schema**：支持 `type`、`title`、`description`、`properties`、`required`、`additionalProperties`（必须为 `false`）、`items`、`anyOf`、`enum`、`const`、数字上下界 / `multipleOf`、字符串长度 / `pattern` 与数组长度；不支持 `$ref`、默认值与隐式类型转换。
- **执行与持久差异**：`createCorePluginHost().call()` 为本地直接调用；而通过工作台或 CLI 开启 `allowedOperations` 后，调用进入单根持久 runner，记录 `plugin.execute` 与请求 UUID，支持中断查回（详见[多图对照板](CONTACT_SHEET.md)）。

## Provider 贡献

- **清单与工厂上下文 v1**：声明 `{id, version, title, capabilities, configuration?}`，并在 `activate` 中实现 `normalizeEndpoint` 与 `createAdapter(provider, context)`（`PROVIDER_FACTORY_CONTEXT_VERSION === 1`）。
- **Core 托管网络与凭据**：`context` 传入只读的 `{contractVersion: 1, network: {fetch}, modelId?}`，并已解析好当次凭据。插件仅在方法执行期间借用 `context.network.fetch`，无需自建队列、调度或存储索引（完整规范见 [Provider 最小契约](PROVIDER_PLUGIN_CONTRACT.md)与 [Provider Adapter 契约](PROVIDER_ADAPTER_CONTRACT.md)）。
- **精确依赖持久化**：新插件 Provider 提交任务前，Core 会将 `pluginDependency` 写入 Task/Attempt 与端点绑定中。若插件缺失或版本变化，Core 会拒绝观察或重提以免误匹配；恢复原精确版本后可继续原任务，历史记录与作品始终可读。

统一依赖对象格式如下：

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

## Web 贡献和生命周期

- **声明与资源固定**：`pages` / `settings` 声明 `{id, version, title, entry, styles?}`，`renderers` 另声明精确 `mediaTypes` 数组。入口须为插件目录内的本地 JS/MJS（样式为 CSS，单文件 ≤8 MiB，插件合计 ≤16 MiB），激活前即由加载器固定字节并打包隔离。
- **浏览器上下文 `mount(context)`**：模块导出 `mount(context)` 并可返回清理函数（或 Promise）。`context` 提供 `container`（Shadow DOM 隔离样式）、`signal`、`dependency`、`session`、`theme` 与受控 `api`（含 `runs`/`run`/`models`/`audioModels`/`videoModels`/`visionModels`/`artifact`，开启供应商管理时的设置模块额外拥有 `api.providers`，开启业务执行时额外拥有 `api.pluginOperations`）；渲染器另附 `artifact` 对象。
- **卸载清理**：切换页面、折叠组件或退出登录时，宿主会触发 `signal` 中止并执行清理函数；插件需自行释放 Blob URL、事件监听与定时器。

通过公开 SDK 装配带有 Web 贡献的独立工作台：

```js
import { loadCorePluginRegistry, createCorePluginWorkbench } from '@mokuyoaxis/dsh-iris/plugins';

const registry = await loadCorePluginRegistry({ entries: ['/absolute/my-plugin/index.mjs'] });
const web = createCorePluginWorkbench({
  dataRoot: '/absolute/existing-core',
  registry,
  workbenchAuth: { directory: '/absolute/private-auth' },
  panelContributions: {
    pages: ['example.library.browse'],
    settings: ['example.library.connection'],
    renderers: ['example.library.png']
  }
});

try {
  const started = await web.start();
  await new Promise(resolve => process.once('SIGINT', resolve));
} finally {
  await web.dispose();
  await registry.dispose();
}
```

> [!WARNING]
> 同进程 Node 插件拥有当前进程权限，同源 Web 模块拥有页面脚本权限。Shadow DOM、CSP 与有限 Core 命令用于规范接口边界而非安全沙箱，请只装配经过审查的可信插件。
