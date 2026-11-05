# Core 网络出口与检测（beta.1）

0.3.0-beta.1的“网络出口”页管理节点、出口池与供应商绑定，并提供实际 Core 进程内的网络 Doctor。**已发布的0.3.0-alpha.1 / 0.2.7尚不包含这些增量。** HTTP/HTTPS代理运行时见[供应商出口绑定](NETWORK_ROUTING.md)，独立资源格式见[节点与池](NETWORK_RESOURCES.md)。

## 开启页面

在已有Flow根启动，显式指定私有网络文件与管理开关；无需同时开启媒体执行或供应商编辑：

```bash
node bin/dsh-iris.js web serve \
  --data-root /absolute/existing-flow-root \
  --provider-config /absolute/private/providers-routed.json \
  --network-config /absolute/private/network-v2.json \
  --allow-network-management
```

按原工作台口令登录。需要编辑供应商时另加 `--allow-provider-management`；需要创作时仍使用原执行/选择开关。`session.networkManagement`独立于描述媒体权限的`readOnly`。API模式也接受该开关，普通连接、MCP的read/execute或连接管理不隐含网络管理权。

网络文件不存在时，页面显示“初始化出口配置”，点击才排他创建v2。已经存在的文件不覆盖。旧v1资源和旧供应商目录不会自动迁移：节点/池仍可独立配置，绑定入口显示另存启用指引。按[绑定文档](NETWORK_ROUTING.md)在新目标创建v2和供应商包装，再正常停止并用明确的新文件启动Core；页面不会切换当前运行配置或调度重启。旧Task2继续用原配置恢复，不借新包装自动升级。

## 节点、池与连接

- **节点**：填写已有HTTP/HTTPS代理的主机、端口和可选认证变量名。只保存引用，由Core进程解析用户名/密码，不填写裸公网IP作为代理。停用保留池引用，被引用时拒绝删除。
- **出口池**：固定或有序主备，明确添加候选、上移/下移、移除；直连需要主动添加。固定池最多一个候选，空池可保存草稿。绑定空池、停用池或无可用候选的池后会阻止请求，不恢复继承。
- **供应商出口**：当前包装目录中的连接可选择池，或明确保存“继承环境”解除绑定。修改只影响后续操作的路由，不更换原任务的Provider、模型、端点或远端ID。其他目录/遗留绑定按保存身份折叠展示，可确认解除，不扫描其他文件。

顶部返回和底部取消共用草稿确认。保存沿用N1/N2的修订检查、私有备份、引用保护和原子写入；外部修改时保留草稿并拒绝覆盖。保存结果不明时先重新读取，不自动重发。保存节点、池、绑定或刷新列表均不发起外部请求。

模型服务卡片及功能模型池显示**配置出口**；这是当前候选的配置摘要，不是某任务已经经过该出口的证明。流程详情另显示原Task最近记录的派发路线与时间；旧任务没有记录时显示“未记录”，不会从当前池推算历史。修改配置也不会改写历史路线。

## 静态检查

“检测”首先只读本地事实：当前Core的平台/Node、代理环境变量是否存在、Node代理开关是否被请求，以及配置、有效候选和凭据就绪状态。不输出环境变量值、认证URL、Provider Key或上游响应正文。

变量存在不等于fetch已采用它。Node22.21起可在启动时用 `--use-env-proxy` 或 `NODE_USE_ENV_PROXY=1` 请求环境代理；宿主还可能提供自己的fetch/dispatcher，因此页面分别显示开关请求与实际路径未知，不把二者等同。[Node官方说明](https://github.com/nodejs/node/blob/v22.23.4/doc/api/cli.md#--use-env-proxy)

Clash与Iris池并存不是自动冲突；显式池控制Iris客户端，系统TUN是否再次接管仍是未知。Core在VPS时，检测针对VPS进程，不代表手机或电脑上的代理配置。格式、版本或权限错误不会触发修复；Doctor仍保留进程事实和可定位的错误码，资源编辑需先修正指定文件。

## 主动GET与IP观察

选定供应商和目标后，点击“开始检测”才联网：

1. **已保存的服务地址**：无Provider Key的GET。401/403/404说明已收到目标响应，不据此断定Key错误或媒体能力不可用；这不是模型实测。
2. **IP观察**：明确的HTTP(S) JSON目标，响应须含有效的`ip`字符串。页面提供ipify地址作为可编辑起点，点击前不会联系它；实际返回值只代表该目标此刻报告的IP，不推断地区、公网性质或所有任务的出口。
3. **自定义GET**：明确填写不含认证信息或片段的HTTP(S) URL；不读取任意环境值、附加Provider认证或跟随重定向。

每次检测总超时8秒、响应最多16 KiB、应用层最多一次GET调用；CONNECT/连接预检另受原出口策略和预算约束。响应正文不展示，结果只包含HTTP状态、耗时、是否已派发/收到响应、有限IP和本次路线。池配置失效会在业务GET前失败，不继承或直连；收到响应后的失败不透明换出口重发。

检测可取消；离开页面或退出会中止等待，迟到结果不覆盖新页面。更换测试目标会清除上一项展示。检测不写供应商健康、配置、Task或作品，不安装代理、修改Clash、系统路由、环境或全局dispatcher。可信同进程插件自行联网、网关到供应商的后一段、真实TUN/住宅出口不由这些结果证明。

## owner API

所有接口都要求原owner认证和独立管理开关，并沿用Host/Origin、有限正文与生命周期保护。普通MCP没有这些工具。

| 接口 | 行为 |
| --- | --- |
| `GET/HEAD /api/v0/network-management/settings` | 当前资源、目录绑定资格与连接配置路线；缺失文件不创建 |
| `GET/HEAD /api/v0/network-management/doctor` | 当前Core进程静态事实，`networkTested:false` |
| `POST .../init` | `{}`，排他初始化v2 |
| `POST .../nodes/add\|set\|remove`、`.../pools/add\|set\|remove` | 原资源命令字段和`expectedRevision`；remove需`confirm:true` |
| `POST .../bindings/set` | `{expectedRevision,expectedProviderRevision,providerId,poolId}`，只允许当前匹配目录 |
| `POST .../bindings/remove` | `{expectedRevision,catalogId,providerId,confirm:true}`，支持明确遗留身份 |
| `POST .../probe` | `{expectedRevision,expectedProviderRevision,providerId,target:"provider"\|"custom"\|"ip",url?}`；非provider目标须有url |

资源变更返回安全投影，不返回私有备份路径或原配置。只管理本次启动明确指定的文件；HTTP请求不能选择另一配置路径。网络和供应商管理在本服务内避免交错写入；外部写入仍由文件修订门禁处理。
