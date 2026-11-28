# DSH 版本兼容

Iris与DSH的版本号独立。安装前运行 `dsh --version`，并核对要安装的Iris版本；发布状态见 [README](../README.md)。

## Iris 0.3.3

0.3.3 在既有 12 个准确版本基础上，通过官方发布 SDK 实测新增 **13 个准确 DSH 版本**（`0.2.1-alpha.5`、`0.2.1-rc.1`–`rc.5`、`0.2.2-alpha.2`–`alpha.3`、`0.2.2-rc.1`–`rc.5`，含当前 `@deepseek-ai/dsh@latest` 的 `0.2.2-rc.5`），将受支持的准确宿主版本扩充至 **25 个**；Iris 自身最低 Node.js 要求仍为 **22.1.0**（DSH `0.2.2-*` 宿主包自身声明 `node >= 24.9.0`，运行时以宿主 Node 要求为准）。

| DSH 版本线 | 已验证的准确版本 | 备注 |
|---|---|---|
| 0.1.2 | `0.1.2-rc.1` | 0.2.5 起纳入 |
| 0.1.5 | `0.1.5-rc.1`、`0.1.5-rc.2`、`0.1.5-rc.3` | 0.2.5 起纳入 |
| 0.1.7 | `0.1.7-rc.1`、`0.1.7-rc.2` | 0.2.5 起纳入 |
| 0.2.0 | `0.2.0-rc.1`、`0.2.0-rc.2` | 0.2.5 起纳入；0.3.3 已复测本机 `0.2.0-rc.2`（35/35） |
| 0.2.1 | `0.2.1-alpha.1`–`alpha.5`、`0.2.1-rc.1`–`rc.5` | 0.3.3 新增 `alpha.5` 与 `rc.1`–`rc.5`（各 35/35，Cordis 4.0.5） |
| 0.2.2 | `0.2.2-alpha.2`、`0.2.2-alpha.3`、`0.2.2-rc.1`–`rc.5` | 0.3.3 新增全部 7 版（各 35/35，Cordis 4.0.6-alpha.2 / 4.1.0，DSH 宿主自身声明 Node `>=24.9.0`） |

**明确未纳入的版本**：
- `0.1.0` / `0.1.1` 及未列出的 `alpha` / `rc` / 正式版继续不纳入；
- `0.2.3-alpha.1`（官方 `@deepseek-ai/cordis-plugin-loader` 启动导出不匹配 `EntryValidationError`）与 `0.2.3-alpha.2`（`@deepseek-ai/dsh-host-webserver` 引入默认 fail-closed 的 `WebRoute.auth = 'required'` Peer 认证模型且要求 Node `^24.22.3 || >=26.13.1`，需待完整宿主 Web 认证与无头 `/iris/render` 实机验收后评估）**暂不纳入 0.3.3 兼容声明**。

发布准备期间使用源码或本地候选包，不把版本号当作已发行证据。从 0.3.0 / 0.3.1 / 0.3.2 升级无需迁移数据根（注意写入 0.3.3 新流程后回滚须用升级前备份），详见 [升级指南](UPGRADING_0.3.md)。

## Iris 0.3.2

0.3.2 沿用与 0.3.0 / 0.3.1 相同的 12 个准确 DSH 版本声明与最低 Node.js **22.1.0** 要求，不改变 DSH 插件工具集或宿主兼容范围；新增的 MCP 作品选择（`iris_core_select_run`）、受控出件目录（`--outbox-dir` / `outbox`）、Web 视频抽帧摘要创建、零计费「本地工具」面板与只读作品/流程血缘视图均位于独立 Core/Web/MCP 路径且按显式开关与授权生效。正式版本已发行后可固定安装：

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.3.2
```

发布准备期间使用源码或本地候选包，不把版本号当作已发行证据。从 0.3.0 / 0.3.1 升级无需迁移数据根，详见[0.3.2 发行说明](releases/0.3.2.md)与[升级指南](UPGRADING_0.3.md)。

## Iris 0.3.1

0.3.1 沿用与 0.3.0 相同的 12 个准确 DSH 版本声明与最低 Node.js **22.1.0** 要求，不改变 DSH 插件工具集或宿主兼容范围；新增的 Web 视觉定位框叠加与交互裁剪、保守 OCR 边界去重以及 MCP `vision-locate` / `media-summarize` / `local-media` / `inbox` / `html-render` 能力组均位于独立 Core/Web/MCP 路径且按显式授权生效。正式版本已发行后可固定安装：

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.3.1
```

发布准备期间使用源码或本地候选包，不把版本号当作已发行证据。从 0.3.0 升级无需迁移数据根，详见[0.3.1 发行说明](releases/0.3.1.md)与[升级指南](UPGRADING_0.3.md)。

## Iris 0.3.0

0.3.0沿用下方12个准确DSH版本声明，最低Node.js为 **22.1.0**。新增Core工作台/MCP、网络、调度和视觉持久流程不扩大宿主支持范围；独立Core无需安装DSH。正式版本已发行后可固定安装：

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.3.0
```

发布准备期间使用源码或本地候选包，不把版本号当作已发行证据。升级步骤见[0.3升级指南](UPGRADING_0.3.md)。历史SDK/受控宿主验收与实际完整宿主装载分别记录；0.3.0并不宣称重新认证了全部宿主组合。下方各预发布和0.2.x章节保留其历史时点。

## Iris 0.3.0-beta.1

beta.1沿用下方12个准确DSH宿主版本，新增出口、调度、凭据与Core文生视频等功能不扩大宿主声明。独立Core Web/MCP无需安装DSH；两类入口覆盖见[发行说明](releases/0.3.0-beta.1.md)。安装beta时明确指定：

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.3.0-beta.1
```

beta.1要求Node.js ≥22.1.0，包声明、Doctor与最低CI使用同一版本。下方alpha及0.2.x说明保留各自历史范围，不代表beta重新完成了全部宿主组合的真实装载验证。

## Iris 0.3.0-alpha.1

本次alpha沿用下方12个准确宿主版本声明，独立Core Web/MCP不要求安装DSH。需要DSH新增的ComfyUI入口时明确安装预发布：

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.3.0-alpha.1
```

alpha.1发布时稳定通道为0.2.7。沿用声明不代表本次alpha重新实测了所有宿主组合；宿主/客户端SDK与实际装载结果仍须分别核对。

## Iris 0.2.7

0.2.7 沿用 0.2.5/0.2.6 的以下 12 个准确版本声明。截图修复与实例装配不扩大宿主支持范围。连接引用另需供应商目录、脱敏设置及凭据公开服务；缺少接口时使用手动供应商。首次配置与升级规则见 [功能模型池](FUNCTION_MODEL_POOLS.md)。

## 0.2.5 建立的兼容范围

0.2.5恢复旧宿主支持，并覆盖以下12个准确版本。旧宿主使用同一套 Iris Core、Music、图片导入和原生 Qwen 改图功能，无需维护旧版功能分支。

| DSH 版本线 | 已验证的准确版本 |
|---|---|
| 0.1.2 | `0.1.2-rc.1` |
| 0.1.5 | `0.1.5-rc.1`、`0.1.5-rc.2`、`0.1.5-rc.3` |
| 0.1.7 | `0.1.7-rc.1`、`0.1.7-rc.2` |
| 0.2.0 | `0.2.0-rc.1`、`0.2.0-rc.2` |
| 0.2.1 | `0.2.1-alpha.1`、`0.2.1-alpha.2`、`0.2.1-alpha.3`、`0.2.1-alpha.4` |

0.1.0/0.1.1及未列出的alpha、rc和正式版本未纳入本轮声明。

## 历史版本

| Iris版本 | 支持的DSH版本 |
|---|---|
| 0.2.4 | `0.2.0-rc.2` 或 `0.2.1-alpha.4` |
| 0.2.0–0.2.3 | `0.2.0-rc.2` |
| 0.1.4 | `>=0.1.2-rc.1 <0.1.3-0` 或 `0.1.5-rc.1` |

0.2.4的历史范围保持两项准确版本。0.2.5按实际接口能力选择桥接，不再按“0.2”版本号启用默认视觉路由；已验证的旧宿主也能精确绑定默认模型、确认图片输入能力并正确处理失败终态。

扩大插件支持不要求现有用户升级DSH。Iris 0.2.x及alpha.1的Core、CLI和插件要求Node.js ≥ 22.0.0；DSH若要求更高，以宿主为准。保留旧DSH时也需要满足这个Node要求。

## 安装与升级

在已验证的准确版本宿主中（`0.3.3` 覆盖上方 **25 个**准确版本，正式发行前请使用源码或本地候选归档；`0.3.2` 覆盖原 12 个准确版本且已在 npm 发行），历史环境也可以继续固定 `0.3.1`、`0.3.0` 或 `0.2.7` 及对应数据根：

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.3.2
```

使用其他profile时替换 `web`。更新后检查服务端装载、刷新Web客户端，并查看Iris工作台的 [宿主诊断](HOST_DOCTOR.md)。alpha.3及之后的DSH改善了插件更新与热加载，但仍以实际装载结果为准。

0.2.4/0.2.5 统一六类功能的明确模型名单；0.2.6 可主动启用自动池，旧名单和空配置不自动改变，见 [功能池及升级说明](FUNCTION_MODEL_POOLS.md)。从 Iris 0.1.4 整体升级的旧数据流程仍需单独验收。

## 兼容声明如何生效

0.2.5的 `package.json` 顶层 `engines.dsh`、嵌套 `dsh.engines.dsh` 与五项可选客户端peer列出12个准确版本；Doctor按同一集合诊断。各版本的客户端SDK分别验收；也覆盖现有根包0.1.5-rc.1/关键组件0.1.5-rc.2的混合安装。宿主版本与SDK版本需要分别核对，不能只根据根包字符串推定。Iris不把DSH客户端包安装为生产依赖。

rc.2的加载器检查DSH相关peer；alpha.4优先读取顶层 `engines.dsh`，未声明时再检查peer。只改嵌套字段不能扩大新加载器的支持范围。另外，npm默认的预览版匹配与DSH的匹配选项有差别，`^0.2.0-rc.2` 不能代替按已验收准确版本逐项并列的范围。

## 验证范围

宿主验收使用各版官方发布的Cordis、LLM、ToolRuntime、附件、Skill、WebServer和SlotRegistry，覆盖模型路由、错误终态、视觉/OCR/定位/摘要、工具交付、作品管理及四个Iris界面插槽。Music和原生Qwen改图通过实际工具调度，使用离线响应核对持久产物、图片附件及原图关系。模型事件由本地fixture提供，禁止外部模型请求；音频夹具只验证字节交付，不代表试听质量。

旧Loader没有现代兼容检查helper时，脚本改用其原生Profile/Boot装载；较新Loader检查最终manifest。临时SDK安装只用于验收配套服务，不等于启动了完整DSH应用。

维护者可在本机已有目标SDK时运行：

```bash
node scripts/verify-dsh-host.mjs --dsh-root /absolute/path/to/@deepseek-ai/dsh
```

脚本在独立临时目录使用隔离DSH_HOME，不操作日常profile。Node客户端夹具另需与目标renderer同版本的官方 `@deepseek-ai/dsh-client-ui-slots` SDK；实际Web前端已内嵌此模块。若宿主安装树未提供独立包，可在仓库外准备官方SDK后显式指定：

```bash
node scripts/verify-dsh-host.mjs --dsh-root /absolute/path/to/@deepseek-ai/dsh --client-sdk-root /absolute/path/to/sdk-fixture
```

脚本不会自动下载依赖或升级宿主。仅准备SDK且未安装DSH的原生模块时，旧Loader的Node接口检查可使用 `node --expose-internals`；常规DSH安装使用宿主自带的模块。

React/DOM和会话数据部分使用fixture，因此这项验收不代替完整浏览器操作、草稿写回、真机触摸或插件热更新验收。TLS和带前缀反代也不由loopback HTTP检查推定通过。早期rc.2适配的历史原因见 [rc.2适配记录](DSH_RC2_ADAPTATION.md)。
