# 出口节点与池（beta.1）

0.3.0-beta.1支持独立保存和管理出口节点、出口池；供应商绑定与Doctor使用下方独立入口。**0.3.0-alpha.1 / 0.2.7 尚不包含下列命令。** 本片只管理资源，所有结果的 `routingActive` 均为 `false`；创建节点或池不会改变 Provider、Clash、进程代理或系统路由，也不会进行网络探测。

本页描述v1资源。另有beta.1的[v2绑定与运行时](NETWORK_ROUTING.md)，已完成受控HTTP/HTTPS代理与原任务恢复验证；v2离线投影报告配置和 `runtimeStatus:not_observed`，不拿离线命令判断服务是否正在路由。

使用本机 Core 所在环境中的绝对私有文件路径，不推断 DSH 配置或扫描代理。命令不需要 Core 数据根，不创建会话、任务或作品；owner 身份来自当前系统用户对指定私有文件的访问能力。普通 MCP 连接没有网络管理工具。

## 创建与读取

以下示例用于仓库源码；安装beta.1后，可将 `node bin/dsh-iris.js` 换成 `dsh-iris`：

```bash
node bin/dsh-iris.js network init --network-config /absolute/private/network.json
node bin/dsh-iris.js network show --network-config /absolute/private/network.json
node bin/dsh-iris.js network check --network-config /absolute/private/network.json
node bin/dsh-iris.js network nodes list --network-config /absolute/private/network.json
node bin/dsh-iris.js network pools list --network-config /absolute/private/network.json
```

`init` 排他创建，已有文件不会覆盖。`show` 和 `list` 返回资源及引用情况；`check` 校验本地配置，返回 `valid:true`、`networkTested:false`，不证明代理可用。未找到文件时明确失败，不自动初始化。

结果中的 `revision` 是当前原文件字节的 SHA256，不是版本号。编辑时复制最近一次结果中的值作为 `expectedRevision`；成功改动返回新的修订。即使手动编辑文件时忘了增加内部计数，旧草稿也不能覆盖该编辑。

## 节点与认证来源

```bash
node bin/dsh-iris.js network nodes add \
  --network-config /absolute/private/network.json \
  --input '{"expectedRevision":"<revision>","node":{"id":"local-clash","label":"本机 Clash","protocol":"http","host":"127.0.0.1","port":7890}}'
```

这里的端口仅为格式示例，请填写自己实际开放的代理端口。Clash mixed-port 可作为 HTTP 代理配置；本片不验证该端口，也不会调用 Clash 切组接口。

节点字段：

| 字段 | 约定 |
| --- | --- |
| `id` | 稳定身份，1–64字符，以字母/数字开头，后续可含点、短横线、下划线；编辑通过该ID选择资源 |
| `label` | 可选单行名称，最多120字符；省略时使用ID |
| `enabled` | 可选布尔值，默认 `true`；停用保留池引用 |
| `protocol` | `http` 或 `https`，表示连接代理服务器的协议；这里只验证配置形状 |
| `host`, `port` | 分开的主机和1–65535整数端口，支持域名、IPv4、IPv6；禁止完整URL、用户名密码、路径、查询和片段 |
| `auth` | 可选 `{ "usernameEnv":"IRIS_PROXY_USER", "passwordEnv":"IRIS_PROXY_PASSWORD" }`，两项成对；不接受内联认证值 |

认证变量必须来自执行命令的进程；后续服务运行时需由实际 Core 进程提供。本片不加载 `.env`，不读取其他程序的凭据。`credentialStatus` 为 `none` / `missing` / `invalid` / `ready`；`ready` 仅说明明确引用的值符合基本格式，未验证服务器认证。读取环境值只用于状态与展示脱敏，不自动写入文件或备份。资源ID、变量名和修订是管理身份，不应拿它们保存秘密；名称与展示host另作脱敏。

局部编辑只改变提供的字段；省略认证保留原引用，`auth:null` 显式清除：

```bash
node bin/dsh-iris.js network nodes set \
  --network-config /absolute/private/network.json \
  --input '{"expectedRevision":"<latest-revision>","node":{"id":"local-clash","enabled":false}}'
```

## 固定与有序池

```bash
node bin/dsh-iris.js network pools add \
  --network-config /absolute/private/network.json \
  --input '{"expectedRevision":"<latest-revision>","pool":{"id":"preferred-route","mode":"fixed","candidates":[{"kind":"node","nodeId":"local-clash"}]}}'

node bin/dsh-iris.js network pools set \
  --network-config /absolute/private/network.json \
  --input '{"expectedRevision":"<latest-revision>","pool":{"id":"preferred-route","mode":"ordered","candidates":[{"kind":"node","nodeId":"local-clash"},{"kind":"direct"}]}}'
```

`fixed` 最多1个候选，`ordered` 最多16个，原样保留用户顺序。每个候选为节点引用或显式 `direct`，禁止重复或不存在的引用，不自动补直连。上述第二个例子明确允许后续策略使用直连，请只在需要时添加；本片尚不执行候选切换。

可保存 `candidates:[]` 的空池草稿；状态为 `empty`，不代表继承环境。其他状态为 `disabled`、`unavailable`、`configured`；`configured` 仅表示至少一个候选在当前配置下可选，不代表网络实测成功。显式绑定到空池、失效池时会明确失败，不偷偷直连。

停用节点不移除引用；任何池（包括停用的池）仍引用该节点时禁止删除。先明确编辑候选或删除池，再删除节点：

```bash
node bin/dsh-iris.js network pools remove \
  --network-config /absolute/private/network.json \
  --input '{"expectedRevision":"<latest-revision>","id":"preferred-route","confirm":true}'

node bin/dsh-iris.js network nodes remove \
  --network-config /absolute/private/network.json \
  --input '{"expectedRevision":"<new-latest-revision>","id":"local-clash","confirm":true}'
```

所有编辑支持 `--input-file /absolute/private/edit.json` 或 `--input -` 从标准输入读取。错误只报告固定原因，不回显认证URL或原始JSON。

## 文件、修订与错误

独立文件为 `schemaVersion:1`、初始化生成的 `configId`、单调 `generation` 和 `nodes` / `pools`；节点和池各最多256项，文件最多1 MiB。支持的格式仍属于预发布设计，未知版本或字段拒绝读取/写入，不回退、降级或自动迁移。误将 `--network-config` 指向原供应商文件也会拒绝，不修改它。

文件必须为普通非符号链接文件，POSIX 下仅当前用户可读写；新文件和备份使用0600。Windows 的 mode 不等同于 ACL，应将文件放在自己的私有目录。

每次实际修改在短事务锁内重新校验格式与字节修订，先保留同目录的 `.backup-*` 私有原件，再原子替换；成功才增加 `generation`。无变化不写入、不增加修订或备份。没有自动备份轮换或清理；原子替换不等于断电级 `fsync` 保证。

| 错误码 | 含义及处理 |
| --- | --- |
| `IRIS_NETWORK_CONFIG_VERSION` | 当前程序不能解释该版本，换用兼容版本，保留原文件 |
| `IRIS_NETWORK_CONFIG_INVALID` | 字段、引用、地址或文件结构不符合约定 |
| `IRIS_NETWORK_CONFIG_CHANGED` | 草稿过期或读取后被改动，重新读取并核对 |
| `IRIS_NETWORK_CONFIG_BUSY` | 文件已有 `.lock`，可能在写或有中断现场；先核查写入进程，不自动抢锁 |
| `IRIS_NETWORK_CONFIG_IN_USE` | 节点仍被池引用，先显式修改依赖 |
| `IRIS_NETWORK_CONFIG_EXISTS` / `IRIS_NETWORK_CONFIG_NOT_FOUND` | 初始化/添加不能覆盖，编辑/删除不能隐式创建 |
| `IRIS_NETWORK_CONFIG_PERMISSIONS` / `IRIS_NETWORK_CONFIG_IO` | 权限过宽或文件操作失败；后者保留受控系统错误码，检查权限、空间和文件状态 |

锁保护遵守本协议的写者，并在锁内检测已有外部修改；不承诺阻止绕过锁且恰好在最终校验后写入的任意外部程序。强制终止可能留锁，本片保留现场，不自动删除。

v1资源管理不会修改Core根或旧Provider存储格式，也不执行路由。[N2](NETWORK_ROUTING.md)另通过显式新文件提供供应商绑定和实际代理，保留v1；[N3工作台](NETWORK_WORKBENCH.md)在独立owner开关下管理相同资源，并提供Core进程内静态/主动检测。运行时复用[实例级网络端口](PROVIDER_NETWORK.md)。
