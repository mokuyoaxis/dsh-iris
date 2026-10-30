# Panel 与外观（0.3 alpha，实验性）

Core 的 API、CLI、MCP 不依赖页面。`web serve` 默认装配随包的 `iris.default-panel`，也可在启动时明确选择可信 Panel。它与 [Provider 扩展](PROVIDER_EXTENSIONS.md)使用不同契约。**npm 0.2.7 尚不包含这些入口**，契约版本为 `0`，尚未冻结为 SDK。

[Core 插件贡献 v0](PLUGINS.md#web-贡献和生命周期)支持默认 Panel 的页面、设置表单和作品预览组合。装配时按完整贡献 ID 明确选择，复用主题、当前登录与 Core API；安装不自动启用。设置默认折叠，预览按实际 MIME 选择，导航/退出释放挂载。可经实验性公开 `createCorePluginWorkbench` 装配已有根；此入口的媒体只读，供应商管理须另行开启。CLI 仍用下面的原独立清单替换整套 Panel，与组合选择互斥；本地主题不变。

## 默认外观

默认浅色、白色主体，鸢尾渐变只用于细线和小面积点缀：

```css
linear-gradient(105deg, #45317D, #6F69B8, #BB78AD, #E59B76, #ED9C91, #F0D09C)
```

右上角“外观”统一提供浅色、深色、跟随系统和舒适/紧凑布局，顶栏不再提供重复明暗按钮。点缀固定使用鸢尾，移除仅小幅改变按钮/选中色的紫罗兰、玫瑰、杏色选项。展开“自选背景”可使用本地 PNG/JPEG/WebP（最多 5 MiB），调整位置、遮罩和模糊。即时预览，图片比较区保持独立中性底色。

配色与布局保存在当前 origin 的 localStorage，背景 Blob 保存在 IndexedDB，不上传 Core、不进入作品库。不同浏览器、端口和设备不自动同步；清除站点数据可能清除此偏好，它不是图片备份。存储失败时提示，本次预览仍可使用。Token 和供应商密钥不进入这些存储。

“恢复默认配色与布局”只恢复显示参数；“移除背景”单独移除此浏览器的背景。展开“分享外观设置”可导入/导出以下受限 JSON，不包含图片或认证，不支持任意 CSS/脚本或远程背景 URL：

```json
{
  "contractVersion": 0,
  "theme": "light",
  "accent": "iris",
  "density": "comfortable",
  "position": "center",
  "overlay": 86,
  "blur": 0
}
```

`theme` 为 `light/dark/system`，新设置的 `accent` 固定为 `iris`，`density` 为 `comfortable/compact`，`position` 为 `center/top/bottom`。读取或导入旧 v0 的 `violet/rose/apricot` 时只把点缀归一为鸢尾，保留明暗、布局、背景参数；不会自动覆盖原文件。遮罩为整数 50–100，模糊为整数 0–20 像素。未知字段/版本拒绝导入，保留当前设置。这是默认 Panel 的主题格式，不表示替代 Panel 必须提供相同控件。

## 显式选择替代 Panel

自行审查并准备本地目录；Iris 不扫描、下载依赖或自动安装。目录中放置 `iris-panel.json`：

```json
{
  "contractVersion": 0,
  "id": "example.my-panel",
  "version": "1.0.0",
  "assets": {
    "/": "index.html",
    "/main.js": "main.js",
    "/theme.css": "theme.css"
  }
}
```

```bash
node bin/dsh-iris.js web serve --data-root /absolute/existing-flow-root \
  --token-file /absolute/new-owner-token \
  --panel /absolute/trusted-panel/iris-panel.json
```

资源从清单目录解析，启动时固定为有限快照：最多 128 项，单项 8 MiB、合计 16 MiB。必须声明 `/` HTML；目录逃逸、API/MCP 路由映射、符号链接逃出资源根均拒绝。未声明文件不公开，请求路径不拼接磁盘目录，不支持热更新。HTML 使用外部 `script src` / `link href` 引用资源，遵守现有同源 CSP；内联或远程脚本不开放。清单只应列公开页面资产，不能包含私有配置。

替代 Panel 通过同源 `/api/v0/session` 获取版本和能力，API 仍要求 Bearer、Host/Origin 与明确权限。会话 `panel` 只返回 id/version/contractVersion，不返回清单路径。不启用工作台时 API/MCP/CLI 仍可独立运行。

**可执行 Panel 必须可信**：页面代码能接触交给它的会话 Token，并调用 owner 已获授权的 API。清单是加载边界，不是代码沙箱；纯主题 JSON 没有这些执行能力。DSH 内嵌工作台仍由宿主装配，此处设置不会自动应用到 DSH。

默认 Panel 处理[访问口令](WORKBENCH_LOGIN.md)。替代 Panel 启用口令模式时，应读取 `GET /api/v0/workbench/auth`，首次设置立即清除 `#setup=…`，使用同源 `/setup`、`/password-login`、`/logout` 及独立浏览器 Bearer；记住设备、退出撤销及恢复遵循[接口与装配](WORKBENCH_LOGIN.md#接口与装配)。后端仅为默认 Panel 标注模式，不向替代页面注入凭据或登录代码。若替代 Panel 仍只支持旧接口，应显式用 `--token-file` / `--token-dir` 启动：清除 `#login=…` 后用同源 `POST /api/v0/workbench/login` 兑换浏览器 Bearer，或使用原 Token 入口。
