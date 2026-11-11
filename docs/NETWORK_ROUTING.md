# 供应商出口绑定（beta.1）

0.3.0-beta.1提供供应商绑定、HTTP/HTTPS代理、运行时与持久记录门禁，使用项目依赖 `undici@7.30.1`。**0.3.0-alpha.1 / 0.2.7 尚不包含这些增量。** 受控回环代理已验证路由、认证、失败边界和原任务跨进程恢复；这不代表所有真实供应商或系统代理均已认证。资源基础见[节点与池](NETWORK_RESOURCES.md)。

## 单独启用，保留原配置

v1网络资源和原供应商文件继续可用。为绑定明确新建v2，或另存复制；复制产生新configId、保留节点/池并清空绑定，原文件不改：

```bash
node bin/dsh-iris.js network routing init --network-config /absolute/private/network-v2.json

# 与上面二选一：从v1/v2另存为新身份，不覆盖源或目标已有文件。
node bin/dsh-iris.js network routing copy \
  --network-config /absolute/private/network-v2.json \
  --input '{"source":"/absolute/private/network-v1.json"}'

node bin/dsh-iris.js network catalog create \
  --network-config /absolute/private/network-v2.json \
  --provider-config /absolute/private/providers.json \
  --output /absolute/private/providers-routed.json
```

新供应商文件外层为 `{schemaVersion:1,networkRequirement,catalog}`，原供应商内容保存在catalog，目录有独立catalogId并引用network configId。旧程序看不到其要求的根部providers数组，因而拒绝使用；新版配置编辑、目录及健康写入保留包装。输出只报告身份，不显示Key。

之后使用现有节点/池编辑命令配置新v2文件。v2另保存bindings，池被绑定时禁止删除；停用保留引用。创建资源或包装本身不发网络。离线资源查看只报告配置与 `runtimeStatus:not_observed`，不声称另一Core进程的实时活动状态。

## 绑定具体供应商连接

先 `network show` 取得最新revision；绑定使用明确的包装目录，CLI核对供应商确实存在，自动填入该目录身份：

```bash
node bin/dsh-iris.js network bindings set \
  --network-config /absolute/private/network-v2.json \
  --provider-config /absolute/private/providers-routed.json \
  --input '{"expectedRevision":"<revision>","providerId":"my-provider","poolId":"my-pool"}'

node bin/dsh-iris.js network bindings list \
  --network-config /absolute/private/network-v2.json
```

模型池继续决定调用哪个服务，具体供应商连接绑定允许的出口池。不按模型品牌推断地区，不改变原媒体端点/协议摘要。新请求解析当前配置；修改网络策略后，原Task仍使用原Provider/模型/端点和远端ID。

解除绑定需新revision与confirm:true。可带原包装文件，也可按bindings list给出的catalogId解除遗留引用，无须扫描或恢复已移走的文件：

```bash
node bin/dsh-iris.js network bindings remove \
  --network-config /absolute/private/network-v2.json \
  --input '{"expectedRevision":"<latest-revision>","catalogId":"<catalog-uuid>","providerId":"my-provider","confirm":true}'
```

明确解除后恢复继承环境；池空、停用、失效或配置身份不匹配则明确失败，不代替用户解除。绑定仍存在时删除供应商也会拒绝，先解除引用再删除。

## 运行时与安全边界

媒体、目录/连接检查及Core服务需显式收到同一network-config。旧供应商文件不会因为多传此参数而自动获得绑定：

```bash
node bin/dsh-iris.js run image \
  --data-root /absolute/core \
  --provider-config /absolute/private/providers-routed.json \
  --network-config /absolute/private/network-v2.json \
  --input '{"prompt":"an iris flower","model_ref":"my-provider::my-model"}'

node bin/dsh-iris.js web serve \
  --data-root /absolute/execution-root \
  --provider-config /absolute/private/providers-routed.json \
  --network-config /absolute/private/network-v2.json \
  --allow-execution --allow-provider-management
```

内部实现使用实例级HTTP(S)代理客户端；未绑定继承当前fetch，明确direct使用独立dispatcher。保留宿主已配置的全局dispatcher、fetch和环境变量，不调整Clash、VPN/TUN或代理策略；不能承诺绕过系统TUN。代理认证只交给CONNECT，供应商Key不交给产物CDN。测试TLS信任只用于测试实例，产品不提供自动关闭证书校验的选项。

有序主备只在独立连接/CONNECT预检阶段选择候选。一次生成及其输入准备/模型切换共享最多16次前置连接检查，同一失败路线不会随换模型反复检查。选中后才派发业务请求；POST发出后断线、超时或正文失败仍可能已受理，不透明换出口重放。已受理任务查询/下载可以在明确允许的当前策略下恢复，永不借此新生成。

一个完整操作的多跳请求保持选定客户端，包括输入上传策略/对象存储及结果交付；客户端关闭等待完整操作结束。独立视觉入口尚未装配，包装目录上的视觉调用会明确拒绝，避免静默直连；原视觉配置仍可使用。DSH借用宿主模型/浏览器的出站继续由宿主管理。可信插件须消费提供的网络端口，同进程代码不受网络沙箱强制约束。

beta.1中，后续解析读取到新的网络配置修订时，会移出旧修订的客户端缓存并停止它们接收新操作；当前同一供应商/调度模型身份复用一份客户端。配置未变、其引用的代理凭据值轮换时，下一次解析也会替换该身份的旧客户端。已进入完整操作的响应正文及后续请求继续使用原快照和选定路线，结束后关闭原连接池，不中途重绑或重放。保留旧客户端引用的内部调用者需重新解析，旧引用的新`run`返回`IRIS_PROVIDER_NETWORK_CLOSED`。这一回收由后续解析触发，不增加文件监听或轮询。

实例关闭同时等待当前客户端和已移出缓存、仍在排空的客户端；退役清理失败在最终关闭时报告，不自动重复清理。仅继承环境的调度客户端与宿主全局dispatcher保持原生命周期，路由配置轮换不关闭宿主连接池。

借用的fetch支持Node原生`Request`与`FormData`。明确direct/代理在传输边界转换到实例客户端的类型，保留multipart字段顺序、文件字节及可计算长度，不更换全局构造器；Request的覆盖参数、正文消费、重定向和取消沿用fetch语义。

普通MCP不获得代理凭据或管理工具；它调用已运行Core的现有授权业务。资源Web管理与网络Doctor见[网络工作台](NETWORK_WORKBENCH.md)，需要独立owner开关。

## 持久任务与兼容

新网络Task从首次写入即为semanticsVersion3，Flow/创建意图首次保存networkRequirement并纳入新流程摘要。要求仅含configId/catalogId，不将节点、池版本或密码混进业务providerBinding。旧reader会在记录/版本校验处拒绝受影响记录；此机制不禁止旧writer对同根无关Artifact的任何写入。

已有Task2/无要求Run继续按原配置读写；使用包装目录恢复时不会隐式升级。新Task3也不能用旧目录或另一身份配置悄悄解除要求。显式迁移旧任务尚未提供，不从当前配置补造旧出口事实。

`task inspect` 可读networkRequirement和networkRoutes。路线事实在派发前由Core操作上下文持久化：configId、generation、配置摘要、catalogId、Provider、池/节点或inherit/direct、阶段与Attempt；外部传入网络管理器时也使用同一存储端口。`phase:dispatch_started`只表示客户端开始派发，不证明供应商受理或真实公网IP。`requestCount`聚合同一安全身份的顶层fetch调用，不包含CONNECT与请求实现内部重定向的全部线次数；不同事实最多128项，超出停止并保留历史，不丢旧证据。缺少持久化端口或存储失败也停止派发。

## 验证范围

以下测试和`scripts/`开发验收命令从源码仓库根运行，不随npm包分发；安装用户使用上方CLI/API入口。

已验证本地配置/绑定、CLI/API继承路径、新记录门禁及注入transport下的主备/失败/并发隔离。实际旧代码拒绝新Task/Flow/创建意图和包装文件，原Task2仍可读取。

`scripts/verify-network-proxy.mjs` 使用真实HTTP/HTTPS CONNECT代理，覆盖认证隔离、环境/宿主dispatcher并存、重定向、TLS拒绝、收到POST后断线、取消与完整正文排空。`scripts/verify-network-task-proxy.mjs` 验证Core原任务跨Node进程/允许出口恢复，以及真实CLI/API的代理生成与交付；受理未知时备用模型/出口均不重提。全部目标为受控回环服务，未调用计费媒体。

轮换回归另见`tests/network-client-retirement.mjs`和`tests/network-client-rotation.mjs`：覆盖空闲历史连接池及时关闭、配置修订/代理凭据变化、旧正文与多跳保留、取消、关闭期间等待退役操作，以及释放失败保留。测试计数不代表长期RSS/文件描述符峰值或全部真实代理已认证。

未发布维护版增加`tests/network-client-invalidation.mjs`：网络文件格式、权限或读取失败，以及文件版本降级/身份替换时，后续显式路由解析先停止旧路由客户端接纳新操作，已接纳的正文和后续请求继续按原快照排空；原错误照常返回，不修写配置。修正文件后重新解析得到新客户端。仅调用方身份不匹配而文件未变化时不清扫合法缓存；多个目录仍可共用同一网络文件，单独替换供应商目录不等于其他目录已失效，详见[生命周期边界](PROVIDER_NETWORK.md)。

beta.1已另提供[出口Web管理与Core网络Doctor](NETWORK_WORKBENCH.md)，需独立管理开关；只读配置和主动GET分开。尚未验证用户真实Clash、系统TUN、住宅IP或全部供应商；标准平台按发行提交CI记录，不以此前百炼图片压测代替。SOCKS5和公开网络SDK继续后续。
