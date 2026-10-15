# DSH 0.2.0-rc.2 适配

本文保留Iris0.2.0/0.2.1适配rc.2时的背景与验证记录。当前0.2.4兼容rc.2及alpha.4，声明规则、使用步骤和验证边界见 [DSH版本兼容](DSH_COMPATIBILITY.md)。以下准确rc.2限制属于当时发行范围。

本适配随 Iris `0.2.0` 发布；npm 0.1.4 包不包含这些后续修正。Iris 0.2.0 要求 Node.js `>=22.0.0`，DSH engines、五项客户端 peers 与 Host Doctor 仅放行准确版本 `0.2.0-rc.2`，不再沿用旧版支持窗口，也不推定其他 0.2 预览版或正式版兼容。

旧 DSH `>=0.1.2-rc.1 <0.1.3-0` 或 `0.1.5-rc.1` 按历史验证范围使用稳定包 `@mokuyoaxis/dsh-iris@0.1.4`。安装与 npm tarball 下载方式见 [README](../README.md#最快开始)。保留的旧桥接与 fixture 测试不构成 Iris 0.2.0 的旧宿主支持承诺。

Iris 0.2.1 沿用相同 Node/DSH 要求，新增 Artifact 改图工具后共注册 15 个工具；最新服务隔离检查为 31 项。宿主适配与业务功能分别验收，浏览器限制见下文。

## 宿主边界的修正

| 边界 | 问题与修正 |
|---|---|
| 加载器与诊断 | rc.2加载器检查peerDependencies，原旧版客户端范围会被拒绝。当时客户端peers、DSH engines、锁文件和Doctor收敛到准确rc.2，无需版本豁免；0.2.4按两版范围同步。 |
| 会话附件 | 扫描引用时曾丢弃 `bytes/width/height`，真实 `readImage()` 因完整性不匹配拒绝读取。适配器保留这些已知事实及 `originalDimensions` 的独立副本，不猜测缺失值，不复制额外 Host 字段。 |
| 宿主视觉 | rc.2 的 `llm.stream()` 需要明确 Provider/模型路由。默认选择仅在精确模型元数据确认接受 `image` 时成为视觉候选；文本模型、未知能力和身份漂移在生成前拒绝，错误事件以及 `finish.reason.kind` 的 `error/aborted` 不再被当作空回答或部分成功。 |
| 客户端会话 | rc.2 列表没有旧 `current` 字段。适配器使用唯一的 `retainedBy.mainView` 持有者，通知时回读 `getSnapshot()`，卸载时释放订阅；保留旧接口，有歧义或无选择时不取任意列表项。 |

修改位于 DSH Host Adapter、客户端边界、Host Doctor 与兼容元数据。Core Runtime、Command、Provider、Task/Artifact 存储和 CLI 实现不因该宿主升级修改；不迁移用户配置或已有数据。

## 验证方式与证据范围

常规 `npm test` 包含 rc.2 附件/视觉边界、客户端真实附件请求和 Doctor 的准确版本判定；Doctor 对旧 DSH 返回不在当前支持范围，并提示固定 Iris 0.1.4。旧接口 fixture 回归保留，但不作为旧宿主实际验收。

若本机已安装 DSH rc.2，可在仓库运行以下手动验收，无需为 Iris 添加 DSH/React 生产依赖：

```bash
node scripts/verify-dsh-host.mjs --dsh-root /absolute/path/to/@deepseek-ai/dsh
```

脚本在仓库外创建新临时数据根，载入实际安装的 Cordis、加载器兼容检查、附件、工具、Skill、LLM、默认模型、WebServer 与客户端 SlotRegistry。模型使用本地 Fake Adapter，正常流遵循安装包的 `index` 和对象终态格式，并验证真实 Runtime 将异常转换为失败终态；禁止外部请求。会话日志和列表是显式 fixture，宿主进程入口是已核实 DSH bin 的模拟。实际 WebServer 只绑定临时 loopback 端口，退出时卸载所有 Fiber。临时目录与 `report.json` 保留供复核。

当时脚本检查15工具、2项Skill、Doctor路由、Core diff与附件，以及四个客户端座位。0.2.4检查17工具/3项Skill及两版宿主。SlotRegistry使用实际安装包代码，React/DOM为stub，不证明完整Web profile、实际渲染、点击和草稿写回。另用 `scripts/verify-headless-package.mjs --offline` 验证无DSH/Cordis安装树中的CLI和作品导出。

## 当前限制

真实用户 profile 若禁用 Iris，路由不存在属于预期状态，不据此判定适配失败。启用后仍需实机验证工作台、会话附件选择、提示词预览/写回和媒体展示。验证脚本不自动启用、安装、重载或重启用户插件，也不运行付费探针。

已发布 0.2.0 的 rc.2 修正保留原 `textModel.stream()` / `visionModel.analyze()` 消费链，没有将真实消费者接入 Model Port。0.2.1 已完成提示词 M2、单图视觉 M3、复合视觉 M4 和独立视觉 CLI，见 [Model Port](MODEL_PORT_CONTRACT.md)、[单图视觉调用](VISION_MODEL.md)、[OCR](OCR_MODEL.md) 和 [定位/摘要/自述](COMPOSITE_VISION.md)。安装 rc.2 离线检查覆盖真实 Runtime/Attachments/ToolRuntime/WebServer；2026-10-05 另由真正 `dsh` CLI 加载隔离 profile，原生模型定位、摘要、自述与流式取消七项检查通过。各业务分别验收，不能仅由 rc.2 桥接测试推断完成。
