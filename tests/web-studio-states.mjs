import assert from 'node:assert/strict';
import { presentReadOnlyFlow, presentFlow } from '../lib/web/flow-view.js';

const base = { contractVersion: 0, recipe: 'image-edit/v0', source: { artifactId: 'source' }, selection: null };
for (const status of ['not_started', 'running', 'needs_attention', 'delivery_failed', 'needs_comparison', 'awaiting_selection', 'selected']) {
  const value = { ...base, status, task: { acceptance: 'unknown' } };
  assert.deepEqual(presentFlow(value, []), presentReadOnlyFlow(value), 'default read-only wording retains its actual limitations');
  const execution = presentFlow(value, ['runs.continue', 'runs.select']); assert(execution.title && execution.message);
  if (status === 'not_started') { assert.match(execution.message, /明确开始/); assert.match(execution.message, /费用/); }
  if (status === 'running') { assert.match(execution.message, /一次/); assert.match(execution.message, /刷新只读/); }
  if (status === 'needs_attention') assert.match(execution.message, /可能已经计费/);
  if (status === 'delivery_failed') assert.match(execution.message, /不新建生成/);
  if (status === 'needs_comparison') assert.match(execution.message, /不产生生成请求/);
  if (status === 'awaiting_selection') assert.match(presentFlow(value, ['runs.select']).message, /选择/);
}
assert.throws(() => presentFlow({ ...base, status: 'future' }, ['runs.continue']), /不支持/);
assert.throws(() => presentFlow({ ...base, contractVersion: 1, status: 'not_started' }, []), /不支持/);
console.log('PASS studio state wording: read-only and independent capabilities, explicit first execution, original observation, unknown billing, delivery and local comparison boundaries');
