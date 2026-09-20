# Artifact Manifest v0

Artifact Manifest v0 是 0.2.0-rc.1 的内部候选格式，尚未作为公开 package API 冻结。它不替换 0.1.4 的 `outputs/` 与 `artifacts.json`；后续 Host 迁移只能显式、逐件复制旧作品，失败时保留原文件。

## 存储与提交顺序

```text
artifact-store/v0/
├── objects/<artifact-id>.<ext>
├── manifests/<artifact-id>.json
├── records/<artifact-id>.json
└── index.json
```

写入顺序固定为 `object → manifest → record → index`：

- object 是受控媒体内容；
- manifest 保存 SHA-256、媒体类型、大小、中性元数据和关系边；
- record 是最小提交标记。只有 record、manifest 与 object 一致的 Artifact 才属于已提交事实；
- index 只是分页查询缓存。它可以损坏或丢失，不影响按稳定 ID 检查已提交 Artifact。

Index 更新失败不会撤销已经提交的 Artifact，避免调用方因本地缓存错误重新生成或重复付费。显式 `artifact rebuild` 会从提交记录和旁车 Manifest 重建 Index。

## 内容完整性

Manifest 使用小写十六进制 SHA-256，并同时记录字节数。`inspect`、`export`、`list` 和重建都会核验对象；即使文件大小不变，内容被替换也返回 `IRIS_ARTIFACT_DIGEST_MISMATCH`。

哈希通过固定大小分块读取，不把完整视频再次载入内存。Manifest、错误和 CLI 结果不保存输入路径、旧作品文件名、DSH URL 或供应商下载 URL。

## 关系边

关系方向固定为“当前 Artifact 指向既有 Artifact”。v0 支持：

- `derived-from`
- `preview-of`
- `frame-of`
- `transcript-of`
- `audio-for`

创建时目标必须已经存在且通过完整性检查，重复边会被拒绝。目标后续丢失时，来源 Artifact 仍保持可用；重建报告 `danglingRelations`，不会级联删除或猜测修复关系。

## 重建与孤儿

`rebuildCoreArtifactIndex()` 属于 writer 的显式 `recover` 操作，reader 不会偷偷修复：

- 早期 Core v0 单文件记录：计算真实哈希，生成 Manifest，并将 record 升级为提交标记；
- object + manifest、缺 record：验证后补写提交标记；
- 只有命名和媒体扩展合法的 object：计算哈希，以 `kind=recovered`、`metadata.recovered=true` 补全；
- manifest 缺 object、哈希不匹配、结构损坏或未知文件：不进入 Index、不自动删除，只计入 `invalid` 或 `unresolved`。

原子写入过程中遗留的临时文件也属于 unresolved 现场。自动清理和数据删除需要单独的用户授权，不属于 rebuild。

`adoptCoreArtifactFile()` 用于后续渐进接回 0.1.4 作品：来源必须是明确的普通文件，Core 复制内容并计算哈希，既不移动来源，也不在 Manifest 中保存来源路径。批量扫描和旧 ID 映射留给 DSH 消费迁移阶段。

## 当前限制

- Manifest 和 record 格式仍是内部候选，版本发布前可能调整；
- 当前没有删除、去重、垃圾回收或关系编辑 API；
- 进程崩溃窗口已通过 fixture 验证；突然断电后的持久性仍取决于宿主文件系统，v0 不宣称跨文件系统事务或 `fsync` 级保证；
- Android 共享存储、网络文件系统和原生 Windows 的恢复行为仍需各自的真实验证。
