# DSH 版本兼容

Iris与DSH的版本号独立。安装前运行 `dsh --version`，并核对要安装的Iris版本；发布状态见 [README](../README.md)。

## Iris 0.2.5

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

扩大插件支持不要求现有用户升级DSH。当前Iris Core、CLI和插件要求Node.js ≥ 22.0.0；DSH若要求更高，以宿主为准。保留旧DSH时也需要满足这个Node要求。

## 安装与升级

在上述12个准确版本的宿主中固定安装0.2.5：

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.2.5
```

使用其他profile时替换 `web`。更新后检查服务端装载、刷新Web客户端，并查看Iris工作台的 [宿主诊断](HOST_DOCTOR.md)。alpha.3及之后的DSH改善了插件更新与热加载，但仍以实际装载结果为准。

0.2.4起统一六类功能的明确模型名单。已有分配保持；以前依赖自动模型池的功能需要在升级后明确分配，见 [升级说明](FUNCTION_MODEL_ASSIGNMENTS.md)。本次宿主适配不迁移旧作品、任务或个人配置；从Iris0.1.4整体升级的旧数据流程仍需单独验收。

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
