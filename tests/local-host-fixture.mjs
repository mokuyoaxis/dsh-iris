/** Local Host fixture: no DSH, no listener, no model/provider request. */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { HostCapabilityError, hostCapabilitySnapshot } from '../lib/host-contract.js';
import { useTempDshHome } from './test-env.js';
import { createLocalHostFixture } from './fixtures/local-host.mjs';

useTempDshHome('iris-local-host');
const tasks = await import('../lib/tasks.js');
const fixture = createLocalHostFixture();
const assert = (condition, message, extra) => {
  if (!condition) throw new Error(message + (extra === undefined ? '' : `: ${JSON.stringify(extra)}`));
};

const snapshot = hostCapabilitySnapshot(fixture.adapter);
assert(Object.values(snapshot.capabilities).every((item) => item.status === 'unavailable'),
  '无端口 fixture 必须诚实报告全部能力缺失', snapshot);

const image = path.join(process.env.DSH_HOME, 'fixture.png');
await sharp({ create: { width: 4, height: 4, channels: 4, background: '#7755dd' } }).png().toFile(image);
const cropped = await fixture.run('crop', { image_path: image, left: 1, top: 1, width: 2, height: 2 });
assert(cropped.ok && cropped.imageDataUrl.startsWith('data:image/png;base64,'), 'fixture 应运行本地 crop');
const diff = await fixture.run('diff', { image_a_path: image, image_b_path: image });
assert(diff.ok && diff.text.includes('0.00%'), 'fixture 应运行确定性 pixel diff', diff.text);

const task = tasks.createV2({ cap: 'image', prompt: 'local fixture task' });
const attempt = tasks.beginAttempt(task.id, {
  providerId: 'fixture-provider', providerName: 'Fixture Provider',
  model: 'fixture-provider::fixture-model', protocol: 'fixture'
});
tasks.recordAttemptResult(task.id, {
  ...attempt, acceptance: 'unknown', resultKind: 'acceptance_unknown',
  error: { stage: 'submit', category: 'network', acceptance: 'unknown', safeMessage: 'fixture response lost' }
});
const status = await fixture.run('status', { task_id: task.id });
assert(status.ok && status.text.includes(task.id), 'fixture 应查询现有 Task');
await fixture.run('task_ack_attention', { task_id: task.id });
assert(tasks.attentionDisposition(tasks.get(task.id)).status === 'acknowledged', 'fixture 应运行已读确认');
await fixture.run('task_restore_attention', { task_id: task.id });
assert(tasks.attentionDisposition(tasks.get(task.id)).status === 'open', 'fixture 应恢复提醒且不改任务事实');

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; throw new Error('fixture 禁止网络'); };
try {
  let confirmationError;
  try { await fixture.run('task_manual_retry', { task_id: task.id }); } catch (error) { confirmationError = error; }
  assert(/明确确认.*重复/.test(confirmationError?.message || '') && fetchCalls === 0,
    '未确认人工重试必须在网络前失败', confirmationError?.message);
} finally {
  globalThis.fetch = originalFetch;
}

for (const [action, capability] of [['html', 'browser'], ['attachment_export', 'attachments']]) {
  let error;
  try { await fixture.run(action, {}); } catch (caught) { error = caught; }
  assert(error instanceof HostCapabilityError && error.capability === capability,
    `${action} 缺 Host Port 时必须稳定失败`, { name: error?.name, code: error?.code });
}

let unsupported;
try { await fixture.run('image', { prompt: 'must not submit' }); } catch (error) { unsupported = error; }
assert(unsupported?.code === 'IRIS_LOCAL_FIXTURE_UNSUPPORTED' && fetchCalls === 0,
  'fixture 不得伪装已迁移付费生成动作');

const controller = new AbortController();
controller.abort();
let aborted;
try { await fixture.run('status', {}, { signal: controller.signal }); } catch (error) { aborted = error; }
assert(aborted?.name === 'AbortError', 'fixture 必须在动作前尊重 AbortSignal');

const source = fs.readFileSync(new URL('./fixtures/local-host.mjs', import.meta.url), 'utf8');
assert(!/@deepseek-ai\/|from ['"](?:cordis|dsh)/.test(source), 'Local Host fixture 不得导入 DSH/Cordis');

console.log('ALL OK —— Local Host fixture 运行 crop/diff、Task 查询/确认，缺能力与未迁移动作可预测且零网络');
