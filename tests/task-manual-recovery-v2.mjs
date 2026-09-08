import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-task-manual-recovery-v2');
const assert = (condition, message, extra) => {
  if (!condition) {
    console.error('FAIL:', message, extra === undefined ? '' : JSON.stringify(extra));
    process.exit(1);
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tasks = await import('../lib/tasks.js');
const config = await import('../lib/config.js');
const models = await import('../lib/models.js');
const { runAction, listActions } = await import('../lib/actions.js');

const provider = config.upsert({ name: 'Manual Provider', enabled: true,
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'test-secret',
  mediaProtocol: 'dashscope', imageModel: 'wan2.2-t2i-flash', videoModel: 'wan2.2-t2v-flash',
  models: [
    { id: 'wan2.2-t2i-flash', capabilities: ['image-gen'] },
    { id: 'wan2.2-t2v-flash', capabilities: ['video-gen'] }
  ]
});
const imageRef = models.modelRef(provider.id, 'wan2.2-t2i-flash');

function makeAttempt(task, acceptance, remoteTaskId) {
  const attempt = tasks.beginAttempt(task.id, {
    providerId: provider.id, providerName: 'Manual Provider', model: imageRef, protocol: 'dashscope'
  });
  tasks.recordAttemptResult(task.id, {
    ...attempt,
    acceptance,
    resultKind: acceptance === 'accepted' ? 'accepted' : 'acceptance_unknown',
    ...(remoteTaskId ? { remoteTaskId } : {}),
    ...(acceptance === 'unknown' ? { error: { acceptance: 'unknown', safeMessage: 'response lost' } } : {})
  });
}

for (const name of ['task_reobserve', 'task_redeliver', 'task_ack_attention', 'task_restore_attention', 'task_manual_retry']) {
  assert(listActions().includes(name), '动作注册表缺少 ' + name);
}

const originalFetch = globalThis.fetch;
let fetchCalls = [];
globalThis.fetch = async (url, options = {}) => {
  fetchCalls.push({ url: String(url), method: options.method || 'GET' });
  return new Response(JSON.stringify({ output: { task_id: 'remote-manual-retry' } }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
};

try {
  const unknown = tasks.createV2({ cap: 'image', prompt: 'manual retry image', size: '1024*1024', count: 1 });
  makeAttempt(unknown, 'unknown');
  let confirmationError = '';
  try { await runAction({}, 'task_manual_retry', { task_id: unknown.id }); } catch (error) { confirmationError = error.message; }
  assert(/明确确认.*重复/.test(confirmationError) && fetchCalls.length === 0, '未确认时必须零网络、零新任务', confirmationError);

  const retried = await runAction({}, 'task_manual_retry', {
    task_id: unknown.id, confirm_duplicate_charge: true
  });
  tasks.stopWatchAll();
  const retryTask = tasks.get(retried.taskId);
  const linked = tasks.get(unknown.id);
  assert(fetchCalls.length === 1 && retryTask.retryOf === unknown.id, '知情重试只提交一次并记录来源', { fetchCalls, retryTask });
  assert(linked.manualRetries.some((item) => item.taskId === retryTask.id), '原任务记录新任务反向关系', linked.manualRetries);
  const retryDisposition = tasks.attentionDisposition(linked);
  assert(retryDisposition.status === 'acknowledged' && retryDisposition.reason === 'retried'
    && retryDisposition.relatedTaskId === retryTask.id, '知情重试原子归档原提醒并保留关联', retryDisposition);
  const callsAfterRetry = fetchCalls.length;
  let duplicateRetryError = '';
  try {
    await runAction({}, 'task_manual_retry', { task_id: unknown.id, confirm_duplicate_charge: true });
  } catch (error) { duplicateRetryError = error.message; }
  assert(/已经处理.*恢复提醒/.test(duplicateRetryError) && fetchCalls.length === callsAfterRetry,
    '已归档提醒不得重复创建重试任务', { duplicateRetryError, fetchCalls });

  const notice = tasks.createV2({ cap: 'image', prompt: 'acknowledge only' });
  makeAttempt(notice, 'unknown');
  const callsBeforeAck = fetchCalls.length;
  await runAction({}, 'task_ack_attention', { task_id: notice.id });
  assert(tasks.attentionDisposition(tasks.get(notice.id)).status === 'acknowledged'
    && fetchCalls.length === callsBeforeAck, '标为已读只写工作流元数据且零网络', tasks.get(notice.id));
  await runAction({}, 'task_restore_attention', { task_id: notice.id });
  assert(tasks.attentionDisposition(tasks.get(notice.id)).status === 'open'
    && fetchCalls.length === callsBeforeAck, '恢复提醒不改事实且零网络', tasks.get(notice.id));

  const earlyLinked = tasks.createV2({ cap: 'image', prompt: 'early 0.1.3 link',
    manualRetries: [{ taskId: 't_existing_retry', createdAt: '2026-09-08T00:00:00.000Z' }] });
  const inferred = tasks.attentionDisposition(earlyLinked);
  assert(inferred.status === 'acknowledged' && inferred.reason === 'retried' && inferred.inferred,
    '兼容早期只有 manualRetries 的 0.1.3 记录', inferred);

  const paused = tasks.createV2({ cap: 'image', prompt: 'reobserve' });
  makeAttempt(paused, 'accepted', 'remote-reobserve');
  tasks.activateWatch(paused.id);
  tasks.cancel(paused.id, 'local watcher stopped');
  const callsBeforeReobserve = fetchCalls.length;
  await runAction({}, 'task_reobserve', { task_id: paused.id });
  assert(fetchCalls.length === callsBeforeReobserve, '重新观察不得提交或立即生成', fetchCalls);
  assert(tasks.get(paused.id).watchState === 'active', '重新观察只重开 watcher', tasks.get(paused.id));
  tasks.stopWatchAll();

  const delivery = tasks.createV2({ cap: 'image', prompt: 'redeliver' });
  makeAttempt(delivery, 'accepted', 'remote-delivery');
  tasks.watch(tasks.get(delivery.id), {
    key: () => 'test-secret', intervalMs: 10,
    poll: async () => ({ done: true, ok: true, urls: ['https://result.invalid/failed.png'] }),
    onSuccess: async () => { throw new Error('local write failed'); }
  });
  await sleep(650);
  assert(tasks.get(delivery.id).outcome === 'succeeded' && tasks.get(delivery.id).deliveryState === 'failed',
    '建立生成成功但交付失败 fixture', tasks.get(delivery.id));

  fetchCalls = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    fetchCalls.push({ url: href, method: 'GET' });
    if (href.includes('/tasks/remote-delivery')) {
      return new Response(JSON.stringify({ output: {
        task_status: 'SUCCEEDED', results: [{ url: 'https://result.invalid/recovered.png' }]
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href === 'https://result.invalid/recovered.png') {
      return new Response(Buffer.from('fake-png-bytes'), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    throw new Error('unexpected URL ' + href);
  };
  const delivered = await runAction({}, 'task_redeliver', { task_id: delivery.id });
  const deliveredTask = tasks.get(delivery.id);
  assert(delivered.ok && fetchCalls.length === 2, '重新交付只查询和下载，不提交生成', fetchCalls);
  assert(deliveredTask.outcome === 'succeeded' && deliveredTask.deliveryState === 'ready'
    && deliveredTask.files.length === 1, '重新交付收口为 ready', deliveredTask);

  const unsupported = tasks.createV2({ cap: 'tts', prompt: 'cannot reconstruct safely' });
  const unsupportedAttempt = tasks.beginAttempt(unsupported.id, {
    providerId: provider.id, providerName: 'Manual Provider',
    model: models.modelRef(provider.id, 'qwen-tts-latest'), protocol: 'dashscope'
  });
  tasks.recordAttemptResult(unsupported.id, {
    ...unsupportedAttempt, acceptance: 'unknown', resultKind: 'acceptance_unknown'
  });
  let unsupportedError = '';
  try {
    await runAction({}, 'task_manual_retry', { task_id: unsupported.id, confirm_duplicate_charge: true });
  } catch (error) { unsupportedError = error.message; }
  assert(/无法无损重建/.test(unsupportedError), '无法还原输入的能力拒绝伪重试', unsupportedError);
} finally {
  tasks.stopWatchAll();
  globalThis.fetch = originalFetch;
}

console.log('ALL OK —— Task v2 重新观察、重新交付、提醒已读/恢复与知情人工重试边界通过');
