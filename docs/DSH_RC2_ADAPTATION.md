# DSH 0.2.0-rc.2 适配

本适配属于当前未发布开发工作树。Iris 包版本仍为 `0.1.4`，已发布的 npm 0.1.4 包不包含这些后续修正。兼容声明仅增加准确版本 `0.2.0-rc.2`，不推定其他 0.2 预览版或正式版兼容。

## 宿主边界的修正

| 边界 | 问题与修正 |
|---|---|
| 加载器与诊断 | rc.2 加载器检查 `peerDependencies`，原五项客户端范围会被拒绝。客户端 peers、DSH engines、锁文件和 Host Doctor 均加入准确 rc.2 范围，无需版本豁免。 |
| 会话附件 | 扫描引用时曾丢弃 `bytes/width/height`，真实 `readImage()` 因完整性不匹配拒绝读取。适配器保留这些已知事实及 `originalDimensions` 的独立副本，不猜测缺失值，不复制额外 Host 字段。 |
| 宿主视觉 | rc.2 的 `llm.stream()` 需要明确 Provider/模型路由。默认选择仅在精确模型元数据确认接受 `image` 时成为视觉候选；文本模型、未知能力和身份漂移在生成前拒绝，错误事件以及 `finish.reason.kind` 的 `error/aborted` 不再被当作空回答或部分成功。 |
| 客户端会话 | rc.2 列表没有旧 `current` 字段。适配器使用唯一的 `retainedBy.mainView` 持有者，通知时回读 `getSnapshot()`，卸载时释放订阅；保留旧接口，有歧义或无选择时不取任意列表项。 |

修改位于 DSH Host Adapter、客户端边界、Host Doctor 与兼容元数据。Core Runtime、Command、Provider、Task/Artifact 存储和 CLI 实现不因该宿主升级修改；不迁移用户配置或已有数据。

## 验证方式与证据范围

常规 `npm test` 包含 rc.2 附件/视觉边界、客户端真实附件请求和 Doctor 的准确版本判定，保留旧宿主回归。

若本机已安装 DSH rc.2，可在仓库运行以下手动验收，无需为 Iris 添加 DSH/React 生产依赖：

```bash
node scripts/verify-dsh-host.mjs --dsh-root /absolute/path/to/@deepseek-ai/dsh
```

脚本在仓库外创建新临时数据根，载入实际安装的 Cordis、加载器兼容检查、附件、工具、Skill、LLM、默认模型、WebServer 与客户端 SlotRegistry。模型使用本地 Fake Adapter，正常流遵循安装包的 `index` 和对象终态格式，并验证真实 Runtime 将异常转换为失败终态；禁止外部请求。会话日志和列表是显式 fixture，宿主进程入口是已核实 DSH bin 的模拟。实际 WebServer 只绑定临时 loopback 端口，退出时卸载所有 Fiber。临时目录与 `report.json` 保留供复核。

它检查 14 个工具、2 项 Skill、Doctor 路由、DSH → Core diff → DSH 附件，以及四个客户端座位的注册和卸载。SlotRegistry 使用安装包中的真实代码，React/DOM 为 stub，因此不证明完整 Web profile 装载、实际组件渲染、点击和草稿写回。另用 `scripts/verify-headless-package.mjs --offline` 验证当前 tarball 在无 DSH/Cordis 安装树中执行 CLI 和 Artifact 导出。

## 当前限制

真实用户 profile 若禁用 Iris，路由不存在属于预期状态，不据此判定适配失败。启用后仍需实机验证工作台、会话附件选择、提示词预览/写回和媒体展示。验证脚本不自动启用、安装、重载或重启用户插件，也不运行付费探针。

这次修正保留现有 `textModel.stream()` / `visionModel.analyze()` 消费链；没有将真实适配器或业务接入 [Model Port M1](MODEL_PORT_CONTRACT.md)。视觉完整终态、统一输出预算、候选控制和 OCR 取消的进一步收口仍按该契约的后续阶段验收，不能把 rc.2 桥接测试当作迁移完成证据。
