import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-task-runtime-faults-v2');

const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tasks = await import('../lib/tasks.js');
const { modelRef } = await import('../lib/models.js');
const ref = modelRef('p_fault', 'model-v2');

function acceptedTask(prompt, remoteTaskId) {
  const task = tasks.createV2({ cap: 'image', prompt });
  const attempt = tasks.beginAttempt(task.id, {
    providerId: 'p_fault', providerName: 'Fault Provider', model: ref, protocol: 'fake'
  });
  tasks.recordAttemptResult(task.id, {
    ...attempt, acceptance: 'accepted', resultKind: 'accepted', remoteTaskId
  });
  return tasks.get(task.id);
}

// 盯守超时只说明结果未知，不能改写为生成失败。
const timedOut = acceptedTask('watch timeout', 'remote-timeout');
tasks.watch(timedOut, {
  key: () => 'secret', maxWatchMs: 1, intervalMs: 10,
  poll: async () => ({ done: false, ok: true, status: 'RUNNING' }),
  onSuccess: async () => []
});
await sleep(650);
const timedOutResult = tasks.get(timedOut.id);
assert(timedOutResult.acceptance === 'accepted' && timedOutResult.outcome === 'unknown'
  && timedOutResult.watchState === 'exhausted', '轮询超时保持已受理并派生未知结果', timedOutResult);

// 连续轮询异常同样不能触发重提；持久化错误不得泄露本地绝对路径。
const pollingFailed = acceptedTask('poll errors', 'remote-errors');
let pollCalls = 0;
tasks.watch(pollingFailed, {
  key: () => 'secret', intervalMs: 10,
  poll: async () => {
    pollCalls++;
    const error = new Error('read /private/iris/token failed');
    error.status = pollCalls % 2 ? 429 : 500;
    throw error;
  },
  onSuccess: async () => []
});
await sleep(750);
const pollingFailedResult = tasks.get(pollingFailed.id);
assert(pollCalls === 5 && pollingFailedResult.outcome === 'unknown'
  && pollingFailedResult.watchState === 'exhausted', '连续五次轮询错误后暂停观察且结果未知', pollingFailedResult);
assert(!JSON.stringify(pollingFailedResult).includes('/private/iris/token'), '轮询错误已移除绝对路径');

// 供应商明确返回任务失败，才能把生成结果记为 failed。
const remoteFailed = acceptedTask('remote failure', 'remote-failed');
tasks.watch(remoteFailed, {
  key: () => 'secret', intervalMs: 10,
  poll: async () => ({ done: true, ok: false, message: 'CONTENT_FILTERED' }),
  onSuccess: async () => []
});
await sleep(650);
const remoteFailedResult = tasks.get(remoteFailed.id);
assert(remoteFailedResult.outcome === 'failed' && remoteFailedResult.status === 'failed'
  && remoteFailedResult.watchState === 'idle', '远端明确失败形成稳定失败终态', remoteFailedResult);

// canonical Provider poll 的 unknown/canceled 必须映射成不同事实，不能退化为普通 failed。
const remoteUnknown = acceptedTask('remote unknown', 'remote-unknown');
tasks.watch(remoteUnknown, {
  intervalMs: 10,
  poll: async () => ({ kind: 'unknown', message: 'provider state unavailable' }),
  onSuccess: async () => []
});
const remoteCanceled = acceptedTask('remote canceled', 'remote-canceled');
tasks.watch(remoteCanceled, {
  intervalMs: 10,
  poll: async () => ({ kind: 'canceled', message: 'provider confirmed cancel' }),
  onSuccess: async () => []
});
await sleep(650);
const remoteUnknownResult = tasks.get(remoteUnknown.id);
const remoteCanceledResult = tasks.get(remoteCanceled.id);
assert(remoteUnknownResult.outcome === 'unknown' && remoteUnknownResult.watchState === 'exhausted'
  && remoteUnknownResult.acceptance === 'accepted', 'canonical unknown 保留受理事实并停止盯守', remoteUnknownResult);
assert(remoteCanceledResult.outcome === 'canceled' && remoteCanceledResult.cancelState === 'remote_confirmed'
  && remoteCanceledResult.watchState === 'idle', 'canonical canceled 只在远端确认后成为取消终态', remoteCanceledResult);

// 重启后：可用供应商恢复盯守；缺失供应商只暂停，不声称失败。
const resumable = acceptedTask('resume accepted task', 'remote-resume');
const runningResume = acceptedTask('resume running task', 'remote-running');
tasks.activateWatch(runningResume.id);
const providerMissing = acceptedTask('provider missing', 'remote-missing');
tasks.resetCache();
const resumed = tasks.resumePending((task) => task.id === providerMissing.id ? null : ({
  key: () => 'secret', intervalMs: 10,
  poll: async () => ({ done: true, ok: true, urls: ['https://result.invalid/resumed.png'] }),
  onSuccess: async () => ['resumed.png']
}));
assert(resumed.includes(resumable.id) && resumed.includes(runningResume.id)
  && !resumed.includes(providerMissing.id), '重启接管 accepted/running 且跳过依赖缺失任务', resumed);
const missingResult = tasks.get(providerMissing.id);
assert(missingResult.outcome === 'none' && missingResult.watchState === 'suspended'
  && missingResult.status === 'running', '供应商缺失保持远端结果未变并暂停观察', missingResult);
await sleep(650);
const resumedResult = tasks.get(resumable.id);
const runningResult = tasks.get(runningResume.id);
assert(resumedResult.outcome === 'succeeded' && resumedResult.deliveryState === 'ready'
  && resumedResult.files[0] === 'resumed.png', 'accepted 阶段重启后完成观察与交付', resumedResult);
assert(runningResult.outcome === 'succeeded' && runningResult.deliveryState === 'ready',
  'running 阶段重启后完成观察与交付', runningResult);

// 同步结果已经成功、但交付在进程退出前未完成：重启只能标交付失败。
const interrupted = tasks.createV2({ cap: 'tts', prompt: 'delivery interrupted' });
const interruptedAttempt = tasks.beginAttempt(interrupted.id, {
  providerId: 'p_fault', providerName: 'Fault Provider', model: ref, protocol: 'fake'
});
tasks.recordAttemptResult(interrupted.id, {
  ...interruptedAttempt, acceptance: 'accepted', resultKind: 'completed'
});
tasks.resetCache();
tasks.resumePending(() => null);
const interruptedResult = tasks.get(interrupted.id);
assert(interruptedResult.outcome === 'succeeded' && interruptedResult.deliveryState === 'failed'
  && interruptedResult.status === 'running', '交付中断不覆盖已确认的生成成功事实', interruptedResult);

tasks.stopWatchAll();
console.log('ALL OK —— Task v2 轮询耗尽、远端失败、重启恢复与交付中断故障矩阵通过');
