import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { defineProviderAdapter } from '../../lib/provider-adapter.js';
import { createFakeLifecycleProvider } from './fake-lifecycle-provider.mjs';

export const FLOW_BINDING = 'sha256:' + 'a'.repeat(64);
export const FLOW_MODEL = 'flow-fixture::edit';
export const FLOW_SOURCE = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#ff0000' } }).png().toBuffer();
export const FLOW_RESULT = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#00ff00' } }).png().toBuffer();
export const flowEvents = root => path.join(path.dirname(root), path.basename(root) + '-events.jsonl');
export const readFlowEvents = root => fs.existsSync(flowEvents(root))
  ? fs.readFileSync(flowEvents(root), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];

export function imageFlowFixture(root, { mode = 'sync', beforeSubmit, afterSend, pendingPoll = false } = {}) {
  let polls = 0;
  const completed = { kind: 'completed', value: { kind: 'image' },
    artifacts: [{ kind: 'inline-base64', data: FLOW_RESULT.toString('base64'), mediaType: 'image/png' }] };
  function event(kind, context) { fs.appendFileSync(flowEvents(root), JSON.stringify({ kind, taskId: context.taskId }) + '\n'); }
  const fake = createFakeLifecycleProvider({ id: 'flow-fixture',
    submitSteps: [async (input, context) => {
      await beforeSubmit?.(input, context);
      event('submit', context);
      await afterSend?.(input, context);
      if (mode === 'async') return { kind: 'accepted', remoteTaskId: 'remote-flow' };
      if (mode === 'unknown') return { kind: 'acceptance_unknown', error: { category: 'network', stage: 'response', acceptance: 'unknown', message: 'fixture unknown' } };
      return completed;
    }],
    pollSteps: Array.from({ length: 4 }, () => (input, context) => {
      event('poll', context);
      return pendingPoll && !polls++ ? { kind: 'pending' } : { kind: 'succeeded', artifacts: completed.artifacts };
    }) });
  const adapter = defineProviderAdapter({ ...fake.adapter, protocol: 'openai-chat-images' });
  return { adapter, calls: fake.calls,
    resolveImageCandidates: ({ modelRef, signal }) => {
      signal.throwIfAborted();
      if (modelRef !== FLOW_MODEL) throw new Error('unexpected fixture model');
      return [{ adapter, model: FLOW_MODEL, providerBinding: FLOW_BINDING, selectionReason: 'explicit' }];
    },
    resolveTaskAdapter: task => {
      if (task.providerBinding !== FLOW_BINDING || task.modelRef !== FLOW_MODEL) throw new Error('fixture binding drift');
      return adapter;
    } };
}
