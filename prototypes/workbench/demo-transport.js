import { projectFlowFacts } from './view-model.js';

export const DEMO_MODELS = Object.freeze([
  { modelRef: 'demo::image-edit', label: '图像编辑 · 演示连接' },
  { modelRef: 'demo::image-edit-alternate', label: '图像编辑 B · 演示连接' }
]);
const SCENARIOS = new Set(['success', 'running', 'unknown', 'delivery_failed', 'needs_comparison']);

function pause(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, ms);
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(signal.reason); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

// Deliberately in-memory fixtures. No fetch, Provider calls or browser storage.
export function createDemoTransport({ delayMs = 850 } = {}) {
  let serial = 0;
  const id = prefix => prefix + '_' + (++serial).toString(16).padStart(24, '0');
  const records = new Map(), active = new Set();
  const counts = { creates: 0, submissions: 0, continuations: 0, selections: 0 };
  function record(runId) {
    const entry = records.get(runId);
    if (!entry) throw new Error('演示流程不存在');
    return entry;
  }
  const inspect = runId => projectFlowFacts(record(runId).facts);
  function touch(facts) { facts.run.revision++; facts.run.updatedAt = new Date().toISOString(); }

  function create(input, { scenario = 'success' } = {}) {
    if (!SCENARIOS.has(scenario) || !DEMO_MODELS.some(item => item.modelRef === input.modelRef) || !input.prompt.trim()) {
      throw new TypeError('请选择演示模型并填写修改要求');
    }
    const now = new Date().toISOString();
    const run = { id: id('run'), recipe: 'image-edit/v0', revision: 1, createdAt: now, updatedAt: now,
      input: { prompt: input.prompt.trim(), model_ref: input.modelRef, n: 1 }, source: { artifactId: input.sourceArtifactId },
      edit: { taskId: id('task'), claimed: false }, compare: { artifactId: id('artifact') } };
    records.set(run.id, { scenario, facts: { contractVersion: 0, run, task: null, status: 'not_started' } });
    counts.creates++;
    return inspect(run.id);
  }

  async function continueRun(runId, { signal } = {}) {
    signal?.throwIfAborted();
    const { facts, scenario } = record(runId);
    if (active.has(runId)) throw new Error('本流程已有演示操作进行中');
    if (!['not_started', 'running', 'delivery_failed', 'needs_comparison'].includes(facts.status)) {
      throw new Error('当前状态不能继续，也不会自动重提');
    }
    const first = !facts.task;
    active.add(runId); counts.continuations++;
    if (first) {
      counts.submissions++;
      facts.run.edit.claimed = true;
      facts.task = { id: facts.run.edit.taskId, acceptance: 'accepted', outcome: 'none', deliveryState: 'none', attempts: [{}] };
      facts.status = 'running'; touch(facts);
    }
    try {
      await pause(delayMs, signal);
      if (first && scenario === 'unknown') {
        Object.assign(facts.task, { acceptance: 'unknown', outcome: 'unknown' }); facts.status = 'needs_attention';
      } else if (first && scenario === 'running') {
        facts.status = 'running';
      } else if (first && scenario === 'delivery_failed') {
        Object.assign(facts.task, { outcome: 'succeeded', deliveryState: 'failed' }); facts.status = 'delivery_failed';
      } else {
        Object.assign(facts.task, { outcome: 'succeeded', deliveryState: 'ready' });
        facts.run.output ||= { artifactId: id('artifact') };
        if (first && scenario === 'needs_comparison') facts.status = 'needs_comparison';
        else { facts.run.comparison = { artifactId: facts.run.compare.artifactId }; facts.status = 'awaiting_selection'; }
      }
      touch(facts);
      return inspect(runId);
    } finally { active.delete(runId); }
  }

  function select(runId, artifactId) {
    const { facts } = record(runId);
    if (!facts.run.comparison || ![facts.run.source.artifactId, facts.run.output.artifactId].includes(artifactId)) {
      throw new Error('只能选择比较完成的原图或结果');
    }
    if (facts.run.selection?.artifactId !== artifactId) {
      facts.run.selection = { artifactId }; facts.status = 'selected'; counts.selections++; touch(facts);
    }
    return inspect(runId);
  }

  return Object.freeze({ create, inspect, continueRun, select,
    list: () => [...records.values()].map(({ facts }) => ({ id: facts.run.id, modelRef: facts.run.input.model_ref })),
    stats: () => ({ ...counts }) });
}
