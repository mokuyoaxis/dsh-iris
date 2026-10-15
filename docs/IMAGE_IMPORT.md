# 图片导入

版本要求：Iris0.2.4；npm0.2.3没有本页的导入命令和工具。发布状态见 [README](../README.md)。

把上传图片、会话图片或宿主本地图片保存为Iris作品，获得后续看图、改图、裁剪和导出可复用的作品ID。导入只在本地保存副本，不调用模型、不创建生成任务，原文件保持。

支持单张静态PNG、JPEG、WebP，最多20 MiB。格式和尺寸按真实内容识别，保留原始字节；不会按文件名转码，不支持动画、网络URL或`content://`路径。相册中的图片请通过浏览器上传。

## 工作台

1. 打开作品区，展开“导入图片”。
2. 用“上传文件”选择图片，也可选当前会话附件；宿主本地文件可通过“高级 · 宿主路径”输入。
3. 点击“保存到作品”。完成后显示图片，作品区刷新；导入作品标为“导入图片”。

单纯上传仍是临时输入副本，既有上传保留期为七天；“保存到作品”成功后，作品与上传副本独立保存，不随该保留期过期。上传或输入格式错误时，按错误提示修正后重新导入。

## Agent

使用实际已装载的 `iris_import_image`，二选一：

```json
{"image_path":"/absolute/path/source.png"}
```

```json
{"attachment_id":"current-session-image-id"}
```

附件只能来自当前会话或Iris已有的受支持图片引用，不能猜测其他会话附件ID。结果给出作品ID与图片链接。需要修改时，把返回ID交给 `iris_edit_image` 的 `source_artifact_id`；已经是Core图片的作品可直接使用，不必重复导入。

## CLI

无需DSH或供应商配置，使用明确的数据根和宿主可读绝对路径：

```bash
dsh-iris artifact import --data-root /absolute/path/iris-core \
  --input '{"image_path":"/absolute/path/source.png"}'
```

返回JSON中的 `artifact.id` 是稳定作品ID，`artifact.kind` 为 `imported-image`，并包含媒体类型、尺寸与内容哈希。原路径和文件名不写入作品记录。该命令使用既有Core单写者约束；同一数据根已有其他写者时按现有规则拒绝。

```bash
dsh-iris artifact export artifact_ID --data-root /absolute/path/iris-core \
  --output /absolute/path/export.png
```

导出保留原字节，输出路径不能覆盖已有文件。看图与改图另按对应功能分配调用模型，见 [视觉CLI](VISION_CLI.md)、[聊天改图](CLI_MANAGEMENT.md#artifact-聊天改图) 和 [功能模型分配](FUNCTION_MODEL_ASSIGNMENTS.md)。

本步只提供持久导入与已有操作衔接；原图/新版并排对比、版本选择和配乐关联仍是后续工作。
