# Kimi Code 接入试验

这是源码树中的可选试验，用实际 Kimi Code 运行时验证 Iris 的工具调用、图片回传及持久任务身份。`probe.mjs` 的**模型决策和图片服务都是本地固定夹具**；`live.mjs` 是单独、显式开启的真实调用入口。两者分别记录证据，均不计为第二个生产 Host 完成。

## 运行

需要项目现有依赖、Node.js 和已安装的 Kimi Code；本机验证版本为 Kimi Code 2.3.0 / Node 22.23.4 / Linux ARM64 PRoot。脚本不会安装软件、修改日常 Kimi/DSH 配置或要求个人凭据。

```bash
node experiments/kimi-code/probe.mjs
```

默认在临时目录创建全新的私有试验根，也可以指定一个尚不存在的绝对目录：

```bash
node experiments/kimi-code/probe.mjs --output /absolute/private/new-kimi-trial
```

Kimi 不在 PATH 时用 `--kimi /absolute/path/to/kimi`。每次使用新输出目录；日志及试验数据保留供核查，不覆盖、复用或清理旧证据。受测 Kimi 进程必须自然退出，超时门限为 120 秒；MCP 单次工具门限为 45 秒，Kimi 模型循环最多 8 步、每步只尝试一次。这些设置不修改项目 `npm test` 的门限。

## 验证内容

```text
实际 Kimi Code
  → 三个固定 stdio MCP 夹具工具
    → 现有 Iris CLI
      → 真实 Flow / Task / Artifact 存储
        → 本地固定图片服务
  ← 图片原字节、持久 ID 和状态
```

- `read_source` 返回红色测试图。
- `start` 通过原 CLI 初始化专用根、导入图片、创建并继续固定改图流程、选择并导出结果；本地服务固定返回绿色图。
- `resume` 再次读取同一流程与原任务，验证没有第二次提交。
- 核对原图/结果图确实进入 Kimi 发给本地模型端点的后续请求，SHA-256 与原字节相同。
- 故意尝试额外 Bash、范围外图片读取，以及给固定工具附加路径参数，核对它们被实际拒绝、没有对应执行或图片泄漏。

成功结果写入 `report.json`；逐请求记录在 `fixture-requests.json`，Kimi 原始输出和进程退出结果分别保留。`realModelValidated`、`realImageGenerationValidated` 和 `secondHostAccepted` 保持 `false`，不会因夹具成功自动升级。

## 当前边界

试验使用独立 `KIMI_CODE_HOME`、空 Skills 目录、自定义 Agent 和明确的工具允许列表；不传入个人模型凭据、Hooks 或插件配置。实际可执行工具仅三个固定 MCP 工具，参数均为空对象，服务端也检查工具名和参数。不开放任意文件路径、Shell 命令或模型选择。这是工具边界验证，不是操作系统沙箱。

Kimi Code 2.3.0 的早期 Bash/ReadMediaFile 试验未按配置的拒绝规则拦住两个测试动作，原因尚未确定。因此当前入口不依赖那套规则；已通过的限制来自 Agent 工具允许列表和固定 MCP 参数校验。正式适配前应独立复核该版本权限装配与文档的一致性。

stdio 对端只是本次测试夹具，未实现正式 MCP 服务的完整取消、进度、版本兼容与错误契约。它不提供用户安装入口，不加入 npm 发布包，也不改变已有 Core 或本地 HTTP API。生产接入应另行确定范围，并使用成熟 MCP 实现。

夹具成功结论不包含真实模型规划、生成、会话重启恢复、取消与正式第二 Host。

## 显式真实调用

`live.mjs` 用于本机已授权的两条连接试验，可能产生真实模型与图片费用，不会随默认入口或测试套件运行。它依赖本机已有配置：`local/kimi-k3`、引用文件 OAuth 的 Kimi 默认模型，以及 Iris 的 `iris_x4ssb6::gemini-image`。这些是本机试验选择，不是产品预置模型或自动发现策略。

```bash
node experiments/kimi-code/live.mjs --live --auth local --output /absolute/private/new-local-trial
node experiments/kimi-code/live.mjs --live --auth oauth --output /absolute/private/new-oauth-trial
```

两轮用户提示词均固定为“画一个二次元美少女”，`n=1`，不优化或改写提示词。保留现有模型能力与思考配置；没有视觉声明不等于已证明模型不支持视觉。`--help` 不触发真实调用。

- 自定义 Agent 只开放 `generate_once`、`inspect_task`、`read_result` 三个固定 MCP 工具，无路径、Shell 或模型参数；底层仍调用原 Iris CLI/Core。
- 每个新试验目录最多提交一次图片请求。提交意图先落盘；不确定受理、失败或中断均不自动重提。读取已有 Task/Artifact 不产生第二次提交。
- 本地模型密钥通过私有进程管道读取并以环境变量传给 Kimi，不写入试验配置；图片密钥只留在父进程代理内存，临时媒体目录使用无效占位密钥。代理只接受一次指定模型和原提示词的 Responses 请求。
- OAuth 由 Kimi 原生逻辑使用现有 credentials 目录和自动续期；试验 Home 仅符号链接该凭据目录，因此正常续期可能更新日常 OAuth 缓存，不复制或回写 token。日常 Kimi/DSH 配置及 Iris 作品根不更改。
- 会话、Skills、Core、日志与图片分别隔离，保留失败现场。Kimi 最多运行 240 秒，每步一次尝试、最多八步；MCP 195 秒，CLI 180 秒，媒体代理 150 秒。进程超时与图片 Task 成功分别记录。

输出包含所选模型、原始 Kimi 事件、工具调用、网络提交计数、Task/Artifact/图片 SHA-256 和退出状态。`realImageGenerationValidated` 只表示已有成功 Task 及可解码图片，不能代替模型视觉读回或第二 Host 验收。模型权限、登录、生成、交付与最终答复应分别判断；CLI exit 0 本身不作为生成成功证据。

该脚本同样只是 test-only MCP 对端，无正式安装或生产服务承诺，不加入 npm 发布包。
