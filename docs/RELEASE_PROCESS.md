# 发布与确认

从源码仓库运行发布工具。推送 `v<package.json version>` 标签触发 [Release工作流](https://github.com/mokuyoaxis/dsh-iris/blob/main/.github/workflows/release.yml)；本机准备候选和测试不会推送标签或调用真实发布。alpha/beta/rc分别使用同名npm渠道与GitHub prerelease，稳定版才更新latest。

## 两个任务

`release` 检查凭据、安装锁定依赖、执行完整测试并打包，绑定准确版本、Git提交、文件名、大小、SHA-256与npm SHA-512 integrity。它创建带归档及 `iris-release-package.json` 的GitHub草稿，先上传 `npm-upload-intent.json`，npm接受后保存 `npm-upload-accepted.json`，再公布Release。附件使用独立名称且不覆盖；草稿阶段完成回执，兼容公开发行不可变的仓库设置。

`verify-publication` 从上游任务输出取得同一清单，只读核对准确版本、integrity与dist-tag。总预算10分钟，间隔最多10秒，每次npm查询的fetch预算15秒且禁止内部重试，外部进程期限不超过剩余总预算。404、渠道延迟和暂时网络错误可以等待；认证失败、无效响应或版本/摘要不符立即失败。12分钟任务期限包含Node准备与报告上传，不扩大查询预算。

GitHub允许[重跑失败或指定任务](https://docs.github.com/en/actions/how-tos/manage-workflow-runs)。只有确认失败时，重跑该确认任务即可；它不重新安装依赖、执行测试、打包或上传。任务之间传递[输出](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/pass-job-outputs)，确认不需要npm发布凭据。

## 上传中断与重跑

- 注册表已有相同版本和integrity：沿原清单接回；有草稿时补接受证据并公布，不再次上传。
- 有相同清单的接受回执，但注册表暂不可见：不再次上传，继续只读确认。
- 只有上传意图，注册表也不可见：返回 `IRIS_RELEASE_SUBMISSION_UNKNOWN`，保留草稿和附件；稍后核对原版本。若后来出现匹配版本，重跑原发布任务可按注册表证据接回。持续不可见时须人工核对原上传结果，不自动抹掉意图或换包再传。
- 已有清单、回执或归档不符，或公开Release缺少必要记录：明确失败，保留原证据，不覆盖附件或npm版本。

`gh release upload --clobber` 会先删除原附件，见[官方命令说明](https://cli.github.com/manual/gh_release_upload)。本流程不用该选项，也不把查询失败一律解释为版本不存在。每次尝试另存工作流artifact，确认失败和上传结果分开报告。

## 验证边界

`tests/release-publication.mjs` 使用受控命令和虚拟时间覆盖延迟、超时、认证/网络失败、摘要不符、回执失败与受理未知。`tests/release-publication-cli.mjs` 在POSIX运行实际工作流Shell及prepare/publish/verify CLI，仅替换外部gh/npm命令与本地提交查询；Windows仍运行独立的元数据和发布状态测试。模拟不证明GitHub编排、真实OIDC、npm Token、注册表可见性或平台CI已成功。

候选还需同一源码的完整测试、实际npm归档消费者与公共类型、Chromium四组场景，以及最终提交的Ubuntu/Windows最低/当前Node22 CI。真实账号/GPU另列，不拿旧发行或受控服务结果代替。本页流程从0.3.0-beta.2使用，实际运行结果按对应发行记录核对，见[发行说明](releases/0.3.0-beta.2.md)。
