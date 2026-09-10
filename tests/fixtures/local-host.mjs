/**
 * v0.1.4 test-only Local Host consumer.
 *
 * It deliberately exposes only zero-network actions that already have no Host dependency.
 * Host-dependent and paid actions stay blocked until the Command/DSH Adapter migration.
 */
import { defineHostAdapter, requireHostPort } from '../../lib/host-contract.js';
import { runAction } from '../../lib/actions.js';

const SAFE_ACTIONS = new Set([
  'crop',
  'diff',
  'status',
  'task_ack_attention',
  'task_restore_attention',
  'task_manual_retry'
]);

const REQUIRED_PORTS = Object.freeze({
  html: Object.freeze(['browser']),
  relook: Object.freeze(['attachments', 'sessions']),
  attachments_list: Object.freeze(['sessions']),
  attachment_export: Object.freeze(['attachments', 'sessions'])
});


function abortedError() {
  const error = new Error('已取消');
  error.name = 'AbortError';
  return error;
}

export function createLocalHostFixture() {
  const adapter = defineHostAdapter({
    id: 'local-fixture',
    version: '0.1.4-test',
    ports: {},
    unavailable: {
      attachments: { kind: 'unavailable', reason: 'Local Host fixture 不读取宿主附件' },
      browser: { kind: 'unavailable', reason: 'Local Host fixture 不启动浏览器' },
      clientSlots: { kind: 'unavailable', reason: 'Local Host fixture 没有客户端 UI' },
      routes: { kind: 'unavailable', reason: 'Local Host fixture 不监听 HTTP' },
      sessions: { kind: 'unavailable', reason: 'Local Host fixture 没有宿主会话' },
      skills: { kind: 'unavailable', reason: 'Local Host fixture 不注册宿主 Skill' },
      textModel: { kind: 'unavailable', reason: 'Local Host fixture 不调用文本模型' },
      tools: { kind: 'unavailable', reason: 'Local Host fixture 不注册 Agent 工具' },
      visionModel: { kind: 'unavailable', reason: 'Local Host fixture 不调用宿主视觉模型' }
    }
  });

  return Object.freeze({
    adapter,
    async run(name, args = {}, { signal } = {}) {
      const action = String(name || '');
      for (const port of REQUIRED_PORTS[action] || []) requireHostPort(adapter, port, action);
      if (!SAFE_ACTIONS.has(action)) {
        const error = new Error(`Local Host fixture 尚未接入动作：${action}`);
        error.code = 'IRIS_LOCAL_FIXTURE_UNSUPPORTED';
        throw error;
      }
      if (signal?.aborted) throw abortedError();
      return runAction(adapter, action, args, { signal });
    }
  });
}
