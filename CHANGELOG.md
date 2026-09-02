# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 阶段 0 收口与可靠性（M4 之后）

#### 变更

- **泡泡工作台交互收口**（`lib/client.js`）
  - 三个座位（设置页 / 进度条 / 悬浮泡泡）共享一份状态订阅（模块级 pub/sub），
    不再各自轮询 `/iris/api/state`；最后一个座位卸载后停止轮询。
  - 面板内部交互不再触发外层拖动或开关：只有点在泡泡按钮上才起拖，
    修复了「点关闭按钮被 onPointerUp 反向翻转重新打开」的 bug。
  - 运行中任务区分「状态」与「数值进度」：`progress` 为数值百分比（如 `50%`）
    才渲染进度条，`RUNNING` 等状态串不再被当作 CSS 宽度。
  - 泡泡拖动坐标持久化后，窗口 resize 时重新约束回可视区并同步持久化。

- **状态 API 不再泄露绝对路径**（`lib/api.js`）
  - `/iris/api/state` 移除 `iris.home` 字段；输出保持全标量、最小化字段。

- **媒体通道流式 + HTTP Range**（`lib/media.js`，`lib/index.js`）
  - `/iris/media/:taskId/:token/:name` 支持 `GET` / `HEAD` 与单段 `Range`
    （`bytes=start-end` / `bytes=start-` / `bytes=-suffix`），响应 `206 Partial
    Content` / `416`，并声明 `Accept-Ranges: bytes`。
  - 全量与部分读取均改用 `fs.createReadStream` 流式，避免大视频整体进入内存。
  - `serveMedia` 与 `parseRange` 迁入 `lib/media.js`（可离线测试）。

- **持久化损坏隔离 + 创建时 0600**（`lib/tasks.js`，`lib/config.js`）
  - `tasks.json` / `providers.json` 区分「文件不存在」（首次运行）与「存在但
    损坏」：损坏文件被重命名为 `*.corrupted-<时间戳>` 隔离，绝不静默覆盖证据，
    并输出诊断日志。
  - 落盘（含 `.tmp` 临时文件）从创建时即用 `0o600`，不再依赖进程 umask。

- **真实 lint 与许可/变更说明**
  - `npm run lint` 从占位脚本变为真实检查（`tests/lint.mjs`）：全量语法
    `node --check` + 5 项结构契约防回归（绝对路径 / Range / 损坏隔离 / 共享
    轮询 / 面板守卫 / resize）。
  - 新增 `LICENSE`（MIT）与 `CHANGELOG.md`。

#### 测试

- 新增 `tests/media.mjs`：Range 解析与流式服务（单段 / 后缀 / 越界 416 /
  HEAD / 无效 token 404 / 路径穿越拒绝）。
- 新增 `tests/damage.mjs`：tasks/config 损坏文件隔离、不静默覆盖、隔离文件保留。
- 新增 `tests/lint.mjs`：语法 + 结构防回归。
- 扩展 `tests/client.mjs`：共享轮询 / 面板守卫 / resize 重约束痕迹。

#### 修复

- **`iris_relook_attachment` 参数 schema 修复**（`lib/index.js`）：`question` 参数属性内写了 `required: true`（布尔值），违反 JSON Schema 规范——`required` 在属性层级必须是字符串数组（`["question"]`），不是布尔值。DSH 的 schema 校验器 `assertSupportedJsonSchema` 因此拒绝该 schema，报 `"parameters.properties.question.required is not supported"`。移除属性内的 `required: true`，顶层 `required: ['attachment_id', 'question']` 已正确覆盖必填约束。lint 新增对应守卫防回归。
