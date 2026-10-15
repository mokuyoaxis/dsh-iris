# DSH 版本兼容

Iris与DSH的版本号独立。安装前运行 `dsh --version`，并核对要安装的Iris版本；发布状态见 [README](../README.md)。

| Iris版本 | 支持的DSH版本 |
|---|---|
| 0.2.4 | `0.2.0-rc.2` 或 `0.2.1-alpha.4` |
| 0.2.0–0.2.3 | `0.2.0-rc.2` |
| 0.1.4 | `>=0.1.2-rc.1 <0.1.3-0` 或 `0.1.5-rc.1` |

0.2.4的范围是两项准确版本，不包含其他alpha、其他rc或未来版本。扩大插件支持不要求现有rc.2用户升级宿主。Iris Core与独立CLI要求Node.js ≥ 22.0.0；DSH插件还须满足所用DSH自身更高的运行要求。

## 安装与升级

在上表支持的宿主中固定安装所需Iris版本，以下为0.2.4命令；发布前请使用已发布的版本：

```bash
dsh plugin --profile web add @mokuyoaxis/dsh-iris@0.2.4
```

使用其他profile时替换 `web`。更新后检查服务端装载、刷新Web客户端，并查看Iris工作台的 [宿主诊断](HOST_DOCTOR.md)。alpha.3及之后的DSH改善了插件更新与热加载，但仍以实际装载结果为准。

0.2.4另统一了六类功能的明确模型名单。已有分配保持；以前依赖自动模型池的功能需要在升级后明确分配，见 [升级说明](FUNCTION_MODEL_ASSIGNMENTS.md)。

## 兼容声明如何生效

0.2.4的 `package.json` 顶层 `engines.dsh` 与五项可选客户端peer统一为 `0.2.0-rc.2 || 0.2.1-alpha.4`；现有嵌套 `dsh.engines.dsh` 保持同值。Doctor按相同版本集合诊断。Iris不把DSH客户端包安装为生产依赖。

rc.2的加载器检查DSH相关peer；alpha.4优先读取顶层 `engines.dsh`，未声明时再检查peer。只改嵌套字段不能扩大新加载器的支持范围。另外，npm默认的预览版匹配与DSH的匹配选项有差别，`^0.2.0-rc.2` 不能代替这里明确并列的两版范围。

## 验证范围

宿主验收使用各版官方发布的Cordis、LLM、ToolRuntime、附件、Skill、WebServer和SlotRegistry，覆盖模型路由、错误终态、视觉/OCR/定位/摘要、工具交付、作品管理及四个Iris界面插槽。模型事件由本地fixture提供，禁止外部模型请求。

维护者可在本机已有目标SDK时运行：

```bash
node scripts/verify-dsh-host.mjs --dsh-root /absolute/path/to/@deepseek-ai/dsh
```

脚本在独立临时目录使用隔离DSH_HOME，不操作日常profile。Node客户端夹具另需同版本的官方 `@deepseek-ai/dsh-client-ui-slots` SDK；实际Web前端已内嵌此模块。脚本不会自动下载依赖或升级宿主。

React/DOM和会话数据部分使用fixture，因此这项验收不代替完整浏览器操作、草稿写回、真机触摸或插件热更新验收。TLS和带前缀反代也不由loopback HTTP检查推定通过。早期rc.2适配的历史原因见 [rc.2适配记录](DSH_RC2_ADAPTATION.md)。
