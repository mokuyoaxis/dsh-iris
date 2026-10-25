# Core 供应商与模型设置（未发布 / C3）

此页描述当前源码树的真实配置界面，**npm 0.2.7 尚不包含该入口**。它管理 Iris 媒体供应商；harness 接入权限仍在连接中心管理，各家聊天模型登录与 OAuth 不由此页接管。

## 开启管理

使用已有私有配置和专用 Flow 根。需要新配置时，先明确初始化，不覆盖已有文件：

```bash
node bin/dsh-iris.js config init --provider-config /absolute/new-providers.json
node bin/dsh-iris.js web serve --data-root /absolute/existing-flow-root \
  --token-file /absolute/new-owner-token \
  --provider-config /absolute/new-providers.json --allow-provider-management
```

管理是独立开关，只有 owner 可用；普通连接、MCP read/execute、连接管理、媒体执行或选择均不隐含此权限。可以只管理配置，不启用媒体写入；会话 `readOnly` 只描述媒体权限，`providerManagement` 单独描述管理权限。

同时创作时，在已明确初始化的 **v1 执行根**另加 `--allow-execution --allow-selection`，步骤见 [工作台](LOCAL_WEB.md)。沿用原配置 JSON 与 CLI；不迁移旧根，服务启动不自动创建配置。

## 配置流程

1. 从“供应商”或创作区“管理模型”进入。选预设/自定义，填写名称、Base URL 和认证；高级连接设置默认折叠。稳定 ID 自动生成，不作为日常重命名入口。
2. 现有 Key 只显示存在状态，不回显。明确选择保留、填写/替换或清除；本地服务可选无需认证，保留的旧 Key 不发送。
3. 可以先仅保存连接，再主动读取目录；目录只使用已保存连接。也可直接手填模型 ID。
4. 勾选图片/视频/语音/音乐/转写/视觉用途再保存。新勾选用途时，原本停用的对应功能会改为自动选择，摘要明确列出；可展开“功能模型池”改为停用或手动，手动按勾选顺序保存。已有自动/手动设置不因打开页面而改变。

目录结果暂存在页面，搜索/加入草稿不写配置、不批准用途。目录元数据与实际协议支持不同；标注用途后运行时仍验证协议、限流和可用性。模型级图片/音乐协议在折叠项中选择。当前 Web 只提供图片编辑，保存其他用途不表示已进入 MCP/Web 创作。

一次保存连接、模型用途和明确修改的功能池，复用原锁、revision 摘要、0600 备份与原子写入。未改动供应商、模型与额外字段保留，不提供硬删除。原模型可清空用途，新模型可撤销添加，供应商可停用。配置及备份仍含 Key，应保存在当前用户控制的私有位置。

修改地址、认证或协议使相应旧验证失效，限流/额度保留原语义。旧 Task 仍绑定原端点和协议；变更地址、停用或清除认证可能阻止恢复，不改绑或自动新提交。

Key 存在、声明用途或目录成功均不表示实测通过。页面显示已有实测及不可用记录；实际付费测试首版继续用原 `models test` CLI 明确执行，没有批量付费测试按钮。

保存中禁用重复提交。revision 冲突保留草稿，拒绝覆盖；回包丢失标记未知，不自动重试。选择“重新读取”并明确确认放弃草稿后，读取文件的实际结果。刷新、目录和保存不生成媒体。

## 管理 HTTP 契约 v0

固定操作启动时的配置路径，浏览器不能传路径、原文件或任意命令。请求沿用 Bearer、Host/Origin、无 CORS、no-store 和净化错误。POST 为 UTF-8 JSON，最多 64 KiB，同实例同时只处理一个管理变更/目录请求。

| 路由 | 语义 |
|---|---|
| GET/HEAD `/api/v0/provider-management/settings` | owner 非秘密投影：版本、revision、来源标识、协议描述、供应商、模型、全局功能池；Key 仅存在状态 |
| POST `/api/v0/provider-management/save` | `{expectedRevision, provider, credential, assignments?}`，保存一次，返回新投影，不返回备份路径 |
| POST `/api/v0/provider-management/discover` | `{expectedRevision, providerId}`，返回最多 256 模型、`persisted:false` 与截断标记，不写配置 |

`provider` 只接受 `id/name/baseUrl/mediaBaseUrl/mediaProtocol/enabled/auth/models`；单次最多 256 模型，每项只接受 `id/capabilities/imageProtocol/musicProtocol`。未提交的原模型保留。`credential` 为 `{action:"keep"}`、`{action:"clear"}` 或 `{action:"replace",value:"new-key"}`，拒绝额外秘密字段。`assignments` 只含本次修改的能力，值为原有 `{mode:"auto"|"manual"|"disabled",models:[...],hostVision?:boolean}`，不创建第二套格式。

未开启 405、连接越权 403、revision 冲突/锁占用 409、非法设置 400、正文过大 413。已加载的 [Provider 扩展](PROVIDER_EXTENSIONS.md)通过实例描述进入页面；页面不能安装或加载代码。环境凭据引用、DSH 来源桥（C3c）仍未实施。
