# Provider Adapter v0 生命周期契约

状态：**v0.1.4 内部契约已实现。** 这是 Iris Core 候选模块与供应商协议实现之间的稳定边界，不是面向第三方承诺兼容性的公开 SDK。当前 DashScope 与 OpenAI Images 兼容实现已经通过同一套零网络 conformance runner。

## 目标与依赖方向

```text
Action / Task watcher / recovery / model discovery
                       │ canonical operation/result
                       ▼
              provider-adapter.js
                       │
              provider-adapters.js
                       │ injected transport
                       ▼
                 adapters.js
```

- Action、Task 恢复、重新交付、模型发现和能力实测不得直接调用供应商生命周期 HTTP 方法。
- Provider Adapter 不创建或修改 Iris Task，不读取 DSH `ctx`，也不承担工作台展示。
- `adapters.js` 保留为协议级 HTTP transport；凭据和 `baseUrl` 仅由具体 Adapter 的操作闭包捕获。
- Adapter 快照只包含稳定身份、协议、能力与 supported/unsupported 事实，不包含 API Key、Authorization、私有 URL、配置对象或 live transport。

## 描述结构

`defineProviderAdapter()` 只接受以下顶层字段：

```js
{
  contractVersion: 0,
  id: 'stable-provider-id',
  protocol: 'dashscope',
  capabilities: ['image', 'video', 'tts', 'transcribe'],
  operations: { discover, submit, poll, download, mapError },
  unsupported: { cancel: '经过验证的原因' }
}
```

六个操作必须**恰好**出现在 `operations` 或 `unsupported` 之一。方法缺失不能被解释为临时故障；调用显式不支持的方法会得到稳定的 `IRIS_PROVIDER_OPERATION_UNSUPPORTED`。v0 要求所有 Adapter 实现 `submit` 与 `mapError`，其余操作可根据协议事实显式声明不支持。

## 生命周期操作

| 操作 | 输入职责 | canonical 结果 |
|---|---|---|
| `discover` | 可选 signal/timeout | `{ models: [{ id, capabilities? }] }`，去空并按 ID 去重 |
| `submit` | capability、model、规范化 input、signal | `completed / accepted / not_accepted / acceptance_unknown` |
| `poll` | capability、remoteTaskId、signal | `pending / succeeded / failed / canceled / unknown` |
| `cancel` | remoteTaskId、signal | `canceled / not_supported / unknown` |
| `download` | remote-url artifact、目标路径、signal | `{ bytes }` |
| `mapError` | 原始错误与 stage/acceptance 上下文 | 可持久化的脱敏错误记录 |

`accepted` 不是独立网络操作，而是异步 `submit` 的受理结果。它必须携带非空远端任务 ID；同步成功使用 `completed`。四态提交和自动 failover 规则继续以 [Provider 提交契约 v0](PROVIDER_SUBMISSION_CONTRACT.md) 为准。

## poll、cancel 与交付事实

`poll` 的终态不能互相折叠：

- `failed` 需要供应商明确的失败证据；
- `canceled` 需要远端确认，Task 才能写入 `cancelState=remote_confirmed`；
- `unknown` 只停止当前盯守并保留 `acceptance=accepted`，不得伪造失败或重提；
- `succeeded` 可以携带 remote-url artifacts 或文本 value，生成成功先于本地下载事实落盘。

`download` 只交付已经确认成功的远端产物。下载失败只能改变交付状态，不能触发生成重提。OpenAI Images 当前同步返回图片，所以 `poll` 与 `cancel` 显式 unsupported；DashScope 当前没有经过验证的远端取消接口，因此 `cancel` 同样显式 unsupported，而不是伪装取消成功。

上传临时输入仍属于提交前准备阶段，不是 v0 六操作之一。上传失败必须记录为 `stage=upload / acceptance=not_accepted`；只有随后真正调用 `submit` 才跨越可能计费的受理边界。未来如出现第二种上传协议，再以真实调用方证据决定是否扩展契约。

## 错误与取消传播

所有操作接收可选 `AbortSignal`。底层发现、轮询、下载和提交 transport 必须把外部 signal 与自己的超时合并。错误映射只保留受控字段：

- stage、category、acceptance、retryable；
- 可选安全的 HTTP status/provider code；
- 已移除密钥、认证头、绝对路径和签名查询的 `safeMessage`。

`submit` 抛错由统一调用器转换成保守四态；`cancel` 抛错转换为 `unknown`；`discover/poll/download` 抛出脱敏的 `ProviderContractError`，由各自调用方应用重试和事实规则。

## 当前内置实现

| 协议 | discover | submit | poll | cancel | download | mapError |
|---|---:|---:|---:|---:|---:|---:|
| DashScope | 支持 | 图片/视频/TTS/转写 | 图片/视频/转写 | 显式不支持 | 支持 | 支持 |
| OpenAI Images 兼容 | 支持 | 同步图片 | 显式不支持 | 显式不支持 | 支持 | 支持 |

本表只描述协议生命周期，不扩大 0.1.4 的供应商范围。Gemini、Fal 与 Replicate 仍在 0.2.x 路线中。

## conformance runner

零网络 runner 位于 `tests/fixtures/provider-conformance.mjs`，并由 `tests/provider-adapters-conformance.mjs` 对内置实现执行。它验证：

1. 快照可序列化且不含凭据；
2. 六个操作全部被 supported/unsupported 记账；
3. 每个 supported 操作都有 fixture 场景；
4. unsupported 调用返回稳定错误；
5. mapError 会清除 synthetic secret 与本地路径；
6. 提交四态、轮询五态、下载字节数和协议特定能力符合契约。

runner 本身不访问网络；具体 Adapter 构造时注入 fake transport。新增 Provider 前，必须先通过同一 runner，再进行用户明确授权的真实供应商短验。0.1.4 不发布 Provider SDK，也不把测试 runner 当成第三方兼容性承诺。
